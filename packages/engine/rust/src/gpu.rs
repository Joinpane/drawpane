//! The GPU backend: vello_gpu on wgpu's WebGPU backend (`browser`) or WebGL2 backend (`webgl`).
//!
//! - The frame is drawn into an RGBA8 texture of the engine's own (`main`), then copied to the
//!   canvas's surface by one full-screen pass. Tests and the GPU bench read `main` back through
//!   a buffer (`copy_texture_to_buffer`), never through the canvas: a WebGPU canvas copied into a
//!   2D canvas can come back empty on headless drivers.
//! - On WebGL2, wgpu's GL backend translates WGSL to GLSL ES 3.0 through naga, shares one device
//!   between Vello and Drawpane's passes, asks for WebGL2 downlevel limits with the adapter's
//!   texture and buffer sizes, and drives buffer-map / work-done callbacks through a non-blocking
//!   yielding poll loop (a blocking poll would spin the page's thread).
//! - Images are textures, one per level, uploaded once. Glyph masks are rasterised by vello_cpu
//!   (`masks.rs`, the same coverage as the CPU backend) and kept on the CPU; each tile lays its
//!   runs' masks into one image a run and uploads them into the atlas texture, packed in rows
//!   from its top left, a write a row (the next tile packs from the top left again: its uploads
//!   run after the tiles before have drawn).
//! - Everything the engine allocates on the GPU (images, the atlas, the frame and its depth
//!   buffer, read-back buffers) is counted against `Limits::gpu_bytes`, and at most two
//!   read-backs are in flight.
//! - A frame the canvas can't take (its surface lost, or a validation error getting its texture)
//!   is a failure, after one reconfiguration: the caller keeps or draws a picture another way,
//!   never a blank canvas.
//! - Errors never panic: wgpu's uncaptured errors, WebGPU device loss, and WebGL2 context loss
//!   are recorded and turned into `ErrorCode::Gpu` and `ErrorCode::DeviceLost` on the next call,
//!   so the editor recovers or falls back.
//! - Glass samples a backdrop plane that excludes prior glass draws.

use crate::blur::{self, BlurSpec, EdgeMode, validate_view_sigma};
use crate::engine::{DragFrame, TiledOptions};
use crate::error::{EngineError, ErrorCode, Result};
use crate::exec::{
    self, Backend, Draw, DrawStats, Frame, GlyphMask, HwBlend, IRect, ImageView, Isolation, Open, Pass, PostStep,
    ReducedBlurLimits, ReducedPost, ShadowCast, Split, impl_draw, resolve_inradius,
};
use crate::glass::{self, GlassMaskSlot};
use crate::gpu_readers::{
    BlurHaloSample, CoarseAnalytic, CompositeTarget, GlassResolve, GpuReaders, HaloClampEdge, HaloClampEdges,
    NativeRim, PlainTex, ProgressiveHaloSample,
};
use crate::halo::{self, ViewportHaloPlan};
use crate::images::{self, Level};
use crate::masks::{self, MaskCache, MaskKey};
use crate::progressive_blur;
use crate::record::{BackgroundBlurOp, GlassOp, ProgressiveBlurOp};
use crate::shadow::{
    CanonicalShadow, ShadowMaskCache, compute_view_mask_rect, compute_view_mask_rect_bounds, reduced_dirty_rect_i64,
    scaled_shadow_sigma,
};
use crate::store::Store;
use crate::tiles::{Composite, Last, Scaled, TILE, TileCache, TileKey};
use std::cell::Cell;
use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::pin::Pin;
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use vello_common::TextureId;
use vello_common::color::{AlphaColor, Srgb};
use vello_common::geometry::RectU16;
use vello_common::kurbo::{Affine, BezPath, PathEl, Rect, Shape};
use vello_common::paint::{Image, ImageSource, TextureRegion, Tint, TintMode};
use vello_common::peniko::{Extend, Fill, ImageQuality, ImageSampler};
use vello_gpu::{
    ClearSettings, RenderError, RenderOptions, RenderSize, RenderTarget, RenderTargetConfig, Renderer, Resources,
    Scene, TargetInit, TextureBindings,
};
use wasm_bindgen::JsCast;
use wasm_bindgen::prelude::wasm_bindgen;

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_name = setTimeout)]
    fn set_timeout(callback: &js_sys::Function, ms: i32) -> i32;
    #[wasm_bindgen(js_name = clearTimeout)]
    fn clear_timeout(id: i32);
}

/// Timeout for the startup capability probe before refusing the adapter (allows cold shader JIT on slow drivers).
const PROBE_TIMEOUT_MS: i32 = 6_000;
/// Timeout for runtime GPU waits (`read_back` and `finished`).
const WAIT_TIMEOUT_MS: i32 = 12_000;
/// Maximum concurrent `gpuFinished` waits per device.
const MAX_FINISHED_WAITERS: u32 = 8;

/// An armed JS timeout that clears itself on drop so completed or cancelled waits leak no timers.
struct Timeout {
    id: i32,
    _cb: wasm_bindgen::closure::Closure<dyn FnMut()>,
}

impl Timeout {
    fn after(ms: i32) -> (Self, futures_channel::oneshot::Receiver<()>) {
        let (tx, rx) = futures_channel::oneshot::channel();
        let mut tx = Some(tx);
        let cb = wasm_bindgen::closure::Closure::<dyn FnMut()>::new(move || {
            if let Some(tx) = tx.take() {
                let _ = tx.send(());
            }
        });
        let id = set_timeout(cb.as_ref().unchecked_ref(), ms);
        (Self { id, _cb: cb }, rx)
    }
}

impl Drop for Timeout {
    fn drop(&mut self) {
        clear_timeout(self.id);
    }
}

/// The web's display handle, which wgpu's GL backend asks for.
#[cfg(feature = "webgl")]
#[derive(Debug)]
struct WebDisplay;

#[cfg(feature = "webgl")]
impl wgpu::rwh::HasDisplayHandle for WebDisplay {
    fn display_handle(&self) -> std::result::Result<wgpu::rwh::DisplayHandle<'_>, wgpu::rwh::HandleError> {
        Ok(wgpu::rwh::DisplayHandle::web())
    }
}

/// Listens for `webglcontextlost` on the canvas backing a WebGL2 surface so context loss is
/// reported as `ErrorCode::DeviceLost` immediately (and removes the listener on drop).
#[cfg(feature = "webgl")]
struct ContextLossGuard {
    target: web_sys::EventTarget,
    callback: wasm_bindgen::closure::Closure<dyn FnMut(web_sys::Event)>,
}

#[cfg(feature = "webgl")]
impl ContextLossGuard {
    fn attach(target: web_sys::EventTarget, health: Arc<Health>) -> Self {
        let callback = wasm_bindgen::closure::Closure::<dyn FnMut(web_sys::Event)>::new(move |e: web_sys::Event| {
            e.prevent_default();
            health.mark_lost("webglcontextlost".to_string());
        });
        let _ = target.add_event_listener_with_callback("webglcontextlost", callback.as_ref().unchecked_ref());
        Self { target, callback }
    }
}

#[cfg(feature = "webgl")]
impl Drop for ContextLossGuard {
    fn drop(&mut self) {
        let _ = self
            .target
            .remove_event_listener_with_callback("webglcontextlost", self.callback.as_ref().unchecked_ref());
    }
}

const IS_WEBGL: bool = cfg!(feature = "webgl");

fn is_software_adapter(info: &wgpu::AdapterInfo) -> bool {
    if matches!(info.device_type, wgpu::DeviceType::Cpu) {
        return true;
    }
    let words = format!("{} {} {}", info.name, info.driver, info.driver_info).to_lowercase();
    [
        "swiftshader",
        "llvmpipe",
        "lavapipe",
        "softpipe",
        "software",
        "basic render",
        "mesa offscreen",
        "subzero",
    ]
    .iter()
    .any(|s| words.contains(s))
}

fn json_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                use std::fmt::Write;
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn format_details(
    info: &wgpu::AdapterInfo,
    limits: &wgpu::Limits,
    features: wgpu::Features,
    backend: &str,
    fallback: bool,
    timestamp_query: bool,
) -> String {
    let features_list = format!("{features:?}");
    format!(
        "{{\"backend\":{},\"wgpuBackend\":{},\"name\":{},\"vendor\":{},\"device\":{},\"deviceType\":{},\"driver\":{},\"driverInfo\":{},\"fallback\":{},\"timestampQuery\":{},\"features\":{},\"limits\":{{\"maxTextureDimension1D\":{},\"maxTextureDimension2D\":{},\"maxTextureDimension3D\":{},\"maxTextureArrayLayers\":{},\"maxBindGroups\":{},\"maxSampledTexturesPerShaderStage\":{},\"maxSamplersPerShaderStage\":{},\"maxUniformBuffersPerShaderStage\":{},\"maxUniformBufferBindingSize\":{},\"maxBufferSize\":{},\"maxColorAttachments\":{},\"maxInterStageShaderVariables\":{}}}}}",
        json_escape(backend),
        json_escape(&format!("{:?}", info.backend)),
        json_escape(&info.name),
        info.vendor,
        info.device,
        json_escape(&format!("{:?}", info.device_type)),
        json_escape(&info.driver),
        json_escape(&info.driver_info),
        fallback,
        timestamp_query,
        json_escape(&features_list),
        limits.max_texture_dimension_1d,
        limits.max_texture_dimension_2d,
        limits.max_texture_dimension_3d,
        limits.max_texture_array_layers,
        limits.max_bind_groups,
        limits.max_sampled_textures_per_shader_stage,
        limits.max_samplers_per_shader_stage,
        limits.max_uniform_buffers_per_shader_stage,
        limits.max_uniform_buffer_binding_size,
        limits.max_buffer_size,
        limits.max_color_attachments,
        limits.max_inter_stage_shader_variables,
    )
}

impl_draw!(Scene, hw_blend: |scene: &mut Scene, mode: HwBlend| {
    let hw_mode = match mode {
        HwBlend::Normal => vello_gpu::HwBlendMode::Normal,
        HwBlend::Multiply => vello_gpu::HwBlendMode::Multiply,
        HwBlend::Screen => vello_gpu::HwBlendMode::Screen,
        HwBlend::LinearDodge => vello_gpu::HwBlendMode::LinearDodge,
        HwBlend::LinearBurn => vello_gpu::HwBlendMode::LinearBurn,
    };
    scene.set_hw_blend(hw_mode);
});

const FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;
const ATLAS_SIDE: u32 = 2048;
/// The atlas's bytes: what a GPU keeps of glyph masks by default (on the CPU).
pub const ATLAS_BYTES: usize = (ATLAS_SIDE * ATLAS_SIDE * 4) as usize;
const ATLAS_ID: TextureId = TextureId(1 << 48);
const CHECKER_ID: TextureId = TextureId((1 << 48) + 1);
const TEMP_TEX_BASE: u64 = 1 << 49;
/// Byte cap on transient offscreen textures referenced by the active GPU scene before an
/// automatic flush recycles them into the pool.
const GPU_TEMP_FLUSH_BYTES: usize = 16 << 20;
/// Soft cap on pooled offscreen/temp GPU textures kept warm between frames.
const GPU_POOL_KEEP_BYTES: usize = 32 << 20;

/// GPU passes (Vello renders and isolation scopes) a frame may start while the camera moves.
/// The main-thread budget can't bound GPU work (a 4 ms walk can queue tens of passes of blend
/// scopes and glass); Figma caps a frame at about 255 framebuffer binds, about 55 of ours.
const MOVING_PASSES: u32 = 48;

/// Idle slices (between frames, at rest) the GPU may still be working on when the next starts:
/// enough that the CPU and GPU overlap, few enough that the next input waits on little.
const IDLE_IN_FLIGHT: u64 = 2;
/// Tiles of a frame no slot can hold (`Plan::direct`) drawn, rough, in one moving frame.
const DIRECT_MOVING_TILES: usize = 2;
/// The slice a composite-only call at rest spends on a frame no slot can hold (`DirectSlices`):
/// the editor's own budget at rest.
const DIRECT_SLICE_MS: f64 = 8.0;
/// A sliced frame's slice budget doubles while its view rests (8, 16, then 32 ms), never past
/// this: a longer call would hold the first input at rest.
const DIRECT_SLICE_MAX_MS: f64 = 32.0;

/// An exact frame no slot can hold (`Plan::direct`), drawn at rest over several frames: the
/// tiles drawn so far, all in the frame shown (`frame`), which each next frame lays beneath
/// itself unchanged before it draws more. One view, size, background and halo. What changed
/// since the last slice (`TileCache::changed_on`), and where an image got another resolution
/// (`TileCache::sharpened_on`), drops the tiles under it, to be drawn again.
struct DirectSlices {
    view: [u64; 6],
    size: (u32, u32),
    bg: [u32; 4],
    halo: i32,
    /// The frame (`frames` index) holding them.
    frame: usize,
    done: Vec<TileKey>,
    /// Those of `done` drawn inexact (a provisional record in reach, say): the frame is exact
    /// once every tile is in and none is here. Each leaves when it's dropped or drawn exact.
    inexact: HashSet<TileKey>,
    /// Tiles drawn once and dropped since (an edit, an image level), the longest dropped first:
    /// one drawn and dropped again goes to the back, so a stream of edits near the middle never
    /// starves the rest. They take turns with tiles never drawn.
    redraw: Vec<TileKey>,
    /// The next slice starts with a tile of `redraw` (else one never drawn).
    redraw_first: bool,
    /// The slowest tile this series has drawn (milliseconds): whether what's left of it fits in
    /// what's left of a slice.
    slowest_ms: f64,
    /// Slices since the view came to rest here or last changed: each doubles the last one's
    /// budget, up to `DIRECT_SLICE_MAX_MS`.
    resting: u32,
}

/// How far `key`'s tile lies from the middle of a frame of `size` whose tile grid starts at
/// `origin` (frame pixels).
fn from_middle(key: &TileKey, origin: (i64, i64), size: (u32, u32)) -> f64 {
    let t = f64::from(TILE);
    let x = f64::from(key.i) * t + origin.0 as f64 + t / 2.0 - f64::from(size.0) / 2.0;
    let y = f64::from(key.j) * t + origin.1 as f64 + t / 2.0 - f64::from(size.1) / 2.0;
    x.hypot(y)
}

/// `jobs`, nearest the frame's middle first.
fn nearest_middle(jobs: &mut [crate::tiles::Job], origin: (i64, i64), size: (u32, u32)) {
    let (cx, cy) = (f64::from(size.0) / 2.0, f64::from(size.1) / 2.0);
    let t = f64::from(TILE);
    let away = |j: &crate::tiles::Job| {
        let x = f64::from(j.key.i) * t + origin.0 as f64 + t / 2.0 - cx;
        let y = f64::from(j.key.j) * t + origin.1 as f64 + t / 2.0 - cy;
        x.hypot(y)
    };
    jobs.sort_by(|a, b| away(a).total_cmp(&away(b)));
}
/// How long the camera stays still before the time between frames draws the overview's refined
/// tiles again (`TileCache::refine_overview`): they still stand in, and a big one's GPU work
/// submitted just before a gesture would hold that gesture's first frames.
const OVERVIEW_REFINE_QUIET_MS: f64 = 1000.0;
/// How long a view stays still before a pass refused beside tile pages drops them (keeping the
/// overview) and retries once in budgeted slices (`PendingStage::Retry`).
const RETRY_QUIET_MS: f64 = 200.0;
/// GPU passes one slice of a refined overview tile submits before its walk pauses: no single
/// submission is long.
const OVERVIEW_REFINE_PASSES: u32 = MOVING_PASSES;

/// Budget for the GPU canonical shadow mask cache (strictly enforced LRU).
const GPU_SHADOW_CACHE_BYTES: usize = 16 << 20;
/// Side length of the single persistent tile-local clip-mask atlas texture (RGBA8, no depth).
const CLIP_ATLAS_SIDE: u32 = 1024;

const BLIT: &str = r"
@group(0) @binding(0) var frame: texture_2d<f32>;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
  let p = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4<f32>(p * 2.0 - 1.0, 0.0, 1.0);
}
@fragment fn fs(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
  return textureLoad(frame, vec2<i32>(p.xy), 0);
}
";

/// What wgpu reports out of band: uncaptured errors, device loss, and wait cancellation.
#[derive(Default)]
pub struct Health {
    errors: Mutex<Vec<(ErrorCode, String)>>,
    lost: AtomicBool,
    lost_reason: Mutex<String>,
    cancelled: AtomicBool,
    waiters: Mutex<Vec<futures_channel::oneshot::Sender<()>>>,
    finished_waiters: AtomicU32,
    #[cfg(feature = "webgl")]
    poll_waiters: AtomicU32,
    #[cfg(feature = "webgl")]
    poll_running: AtomicBool,
    #[cfg(feature = "webgl")]
    poll_error: Mutex<Option<String>>,
    #[cfg(feature = "webgl")]
    poll_wake: Mutex<Option<futures_channel::oneshot::Sender<()>>>,
}

impl Health {
    fn wake_waiters(&self) {
        if let Ok(mut list) = self.waiters.lock() {
            for tx in std::mem::take(&mut *list) {
                let _ = tx.send(());
            }
        }
        #[cfg(feature = "webgl")]
        self.wake_poll();
    }

    #[cfg(feature = "webgl")]
    fn wake_poll(&self) {
        if let Ok(mut wake) = self.poll_wake.lock()
            && let Some(tx) = wake.take()
        {
            let _ = tx.send(());
        }
    }

    #[cfg(feature = "webgl")]
    fn watch_poll_wake(&self) -> futures_channel::oneshot::Receiver<()> {
        let (tx, rx) = futures_channel::oneshot::channel();
        if let Ok(mut wake) = self.poll_wake.lock() {
            if self.is_stopped() || self.poll_waiters.load(Ordering::SeqCst) == 0 {
                let _ = tx.send(());
            } else {
                *wake = Some(tx);
            }
        }
        rx
    }

    fn record_error(&self, code: ErrorCode, message: String) {
        if let Ok(mut list) = self.errors.lock()
            && list.len() < 16
        {
            list.push((code, message));
        }
    }

    fn mark_lost(&self, reason: String) {
        self.lost.store(true, Ordering::SeqCst);
        if let Ok(mut r) = self.lost_reason.lock() {
            *r = reason;
        }
        self.wake_waiters();
    }

    fn mark_lost_if_empty(&self, reason: &str) {
        self.lost.store(true, Ordering::SeqCst);
        if let Ok(mut r) = self.lost_reason.lock()
            && r.is_empty()
        {
            *r = reason.to_string();
        }
        self.wake_waiters();
    }

    #[cfg(feature = "webgl")]
    fn fail_poll(&self, message: String) {
        if let Ok(mut pe) = self.poll_error.lock() {
            *pe = Some(message);
        }
        self.wake_waiters();
    }

    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        self.wake_waiters();
    }

    fn is_stopped(&self) -> bool {
        if self.lost.load(Ordering::SeqCst) || self.cancelled.load(Ordering::SeqCst) {
            return true;
        }
        #[cfg(feature = "webgl")]
        if let Ok(pe) = self.poll_error.lock()
            && pe.is_some()
        {
            return true;
        }
        false
    }

    pub(crate) fn stop_error(&self) -> Option<EngineError> {
        if self.lost.load(Ordering::SeqCst) {
            let reason = self.lost_reason.lock().map(|r| r.clone()).unwrap_or_default();
            return Some(EngineError::new(
                ErrorCode::DeviceLost,
                format!("the GPU device was lost ({reason})"),
            ));
        }
        if self.cancelled.load(Ordering::SeqCst) {
            return Some(EngineError::new(ErrorCode::State, "GPU wait cancelled"));
        }
        #[cfg(feature = "webgl")]
        if let Ok(pe) = self.poll_error.lock()
            && let Some(msg) = pe.as_ref()
        {
            return Some(EngineError::new(ErrorCode::Gpu, msg.clone()));
        }
        None
    }

    fn cancelled_or_callback_error(&self) -> EngineError {
        self.stop_error()
            .unwrap_or_else(|| EngineError::new(ErrorCode::Gpu, "GPU callback cancelled"))
    }

    fn watch_stop(&self) -> futures_channel::oneshot::Receiver<()> {
        let (tx, rx) = futures_channel::oneshot::channel();
        if let Ok(mut list) = self.waiters.lock() {
            list.retain(|s| !s.is_canceled());
            if self.is_stopped() {
                let _ = tx.send(());
            } else {
                list.push(tx);
            }
        }
        rx
    }
}

struct Main {
    texture: wgpu::Texture,
    view: wgpu::TextureView,
    tex_view_id: u64,
    #[cfg(feature = "compute")]
    view_id: u64,
    present_group: Option<wgpu::BindGroup>,
    composite_group: Option<wgpu::BindGroup>,
    width: u32,
    height: u32,
}

/// The run atlas: one texture, holding the run images of the tile being drawn, packed in rows.
struct Atlas {
    texture: wgpu::Texture,
    /// Where the next image goes: x and y, and the current row's height.
    at: (u32, u32, u32),
    /// Images placed and not uploaded yet: x, y, width, height, pixels (`flush_masks`).
    pending: Vec<(u32, u32, u32, u32, Vec<u8>)>,
}

impl Atlas {
    /// Room for a `w` × `h` image in this tile's rows, if there's any left.
    fn place(&mut self, w: u32, h: u32) -> Option<(u32, u32)> {
        let (mut x, mut y, mut row) = self.at;
        if w > ATLAS_SIDE || h > ATLAS_SIDE {
            return None;
        }
        if x + w > ATLAS_SIDE {
            (x, y, row) = (0, y + row, 0);
        }
        if y + h > ATLAS_SIDE {
            return None;
        }
        self.at = (x + w, y, row.max(h));
        Some((x, y))
    }
}

/// Read-backs in flight at once, at most.
const READBACKS: u32 = 2;

/// Frame textures kept: the one shown (the last frame, a stand-in under what isn't drawn yet)
/// and the one being made.
const FRAMES: usize = 2;

/// Default tile page side when no pages are allocated yet; `fit_tiles` upgrades to 4096 when
/// device limits and tile budget allow (64 tiles of 512x512 per atlas page).
const DEFAULT_PAGE: u32 = 2048;
/// Kept free under the budget for what a frame allocates on the way (read-backs, images).
const HEADROOM: usize = 32 << 20;
/// SwiftShader can exhaust its frame deadline before it exhausts the texture
/// budget. Bound the extra viewport work on a software adapter.
const SOFTWARE_PADDED_PIXELS: usize = 2 << 20;

fn vello_error(error: RenderError) -> EngineError {
    match error {
        RenderError::IntermediateTexture(_) | RenderError::ResourceTextureTooLarge { .. } => {
            EngineError::limit(error.to_string())
        }
        _ => EngineError::new(ErrorCode::Gpu, error.to_string()),
    }
}

/// The compositor: textured quads (a stand-in scaled: the last frame, another level's tiles),
/// bilinear, each sampled inside its own source rectangle so neighbours in a page never bleed
/// in. Frames and tiles are premultiplied, so filtering is exact.
const QUADS: &str = r"
struct U { size: vec4<f32> };
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<uniform> u: U;
struct V {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) @interpolate(flat, either) lim: vec4<f32>,
};
@vertex fn vs(@builtin(vertex_index) i: u32, @location(0) dst: vec4<f32>, @location(1) uvr: vec4<f32>, @location(2) lim: vec4<f32>) -> V {
  let c = vec2<f32>(f32(i & 1u), f32((i >> 1u) & 1u));
  let p = mix(dst.xy, dst.zw, c);
  var o: V;
  let size = max(u.size.xy, vec2<f32>(1.0));
  o.pos = vec4<f32>(p.x / size.x * 2.0 - 1.0, 1.0 - p.y / size.y * 2.0, 0.0, 1.0);
  o.uv = mix(uvr.xy, uvr.zw, c);
  o.lim = lim;
  return o;
}
@fragment fn fs(v: V) -> @location(0) vec4<f32> {
  return textureSampleLevel(src, samp, clamp(v.uv, v.lim.xy, v.lim.zw), 0.0);
}
";

/// A page of tiles.
/// An image level part uploaded (`Gpu::put_image_bitmap_rows`): its texture, its height, the
/// next row to upload, and the bitmap its rows come from (rows from another are refused).
struct PendingImage {
    tex: wgpu::Texture,
    height: u32,
    next: u32,
    #[cfg(target_arch = "wasm32")]
    source: web_sys::ImageBitmap,
}

/// The image levels being uploaded in strips, by image id and width: a few at a time (the
/// editor uploads one level at once), so a list, which keeps the module smaller than a map.
#[derive(Default)]
struct PendingImages(Vec<((u32, u32), PendingImage)>);

impl PendingImages {
    fn at(&self, key: &(u32, u32)) -> Option<usize> {
        self.0.iter().position(|(k, _)| k == key)
    }
    fn get(&self, key: &(u32, u32)) -> Option<&PendingImage> {
        self.at(key).map(|i| &self.0[i].1)
    }
    fn get_mut(&mut self, key: &(u32, u32)) -> Option<&mut PendingImage> {
        self.at(key).map(|i| &mut self.0[i].1)
    }
    fn insert(&mut self, key: (u32, u32), image: PendingImage) {
        match self.at(&key) {
            Some(i) => self.0[i].1 = image,
            None => self.0.push((key, image)),
        }
    }
    fn remove(&mut self, key: &(u32, u32)) -> Option<PendingImage> {
        self.at(key).map(|i| self.0.swap_remove(i).1)
    }
    fn keys(&self) -> impl Iterator<Item = &(u32, u32)> {
        self.0.iter().map(|(k, _)| k)
    }
}

struct Page {
    texture: wgpu::Texture,
    view: wgpu::TextureView,
    composite_group: Option<wgpu::BindGroup>,
}

/// The overview's tiles (`tiles::OVERVIEW_SLOT` on), in one texture of their own, `grid` tiles
/// across and down: apart from the pages, so a cache cut to fit memory keeps them.
struct OverviewPage {
    page: Page,
    grid: (u32, u32),
    bytes: usize,
}

/// `slot_place`'s page for an overview tile (`OverviewPage`).
const OVERVIEW_PAGE: usize = usize::MAX;

struct Compositor {
    bgl: wgpu::BindGroupLayout,
    pipeline: wgpu::RenderPipeline,
    /// The same quads laid over what's there (premultiplied source over): a drag's selection
    /// and the part above it.
    over: wgpu::RenderPipeline,
    sampler: wgpu::Sampler,
    uniforms: wgpu::Buffer,
    uniform_size: (u32, u32),
    instances: wgpu::Buffer,
    capacity: usize,
}

impl Compositor {
    fn create_bind_group(&self, device: &wgpu::Device, view: &wgpu::TextureView, label: &str) -> wgpu::BindGroup {
        device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some(label),
            layout: &self.bgl,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Sampler(&self.sampler),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: self.uniforms.as_entire_binding(),
                },
            ],
        })
    }

    #[inline(never)]
    fn set_size(&mut self, queue: &wgpu::Queue, size: (u32, u32)) {
        if self.uniform_size != size {
            let mut ub = [0u8; 16];
            ub[0..4].copy_from_slice(&(size.0 as f32).to_le_bytes());
            ub[4..8].copy_from_slice(&(size.1 as f32).to_le_bytes());
            queue.write_buffer(&self.uniforms, 0, &ub);
            self.uniform_size = size;
        }
    }

    #[inline(never)]
    fn push_quad(bytes: &mut Vec<u8>, q: &[f32; 12]) {
        for &v in q {
            bytes.extend_from_slice(&v.to_le_bytes());
        }
    }

    #[inline(never)]
    fn upload_quads(&mut self, device: &wgpu::Device, queue: &wgpu::Queue, count: usize, bytes: &[u8]) {
        if count > self.capacity {
            let capacity = count.next_power_of_two();
            self.instances.destroy();
            self.instances = device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("composite quads"),
                size: (capacity * 48) as u64,
                usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            });
            self.capacity = capacity;
        }
        if !bytes.is_empty() {
            queue.write_buffer(&self.instances, 0, bytes);
        }
    }

    #[inline(never)]
    fn write_quads(&mut self, device: &wgpu::Device, queue: &wgpu::Queue, quads: &[[f32; 12]]) {
        let mut bytes = Vec::with_capacity(quads.len() * 48);
        for q in quads {
            Self::push_quad(&mut bytes, q);
        }
        self.upload_quads(device, queue, quads.len(), &bytes);
    }
}

/// Where a tile is drawn: a slot in a page, the frame (a frame drawn direct), or only the
/// scratch tile (a drag's selection, laid over the frame next).
#[derive(Clone, Copy)]
enum TileTarget {
    Slot(u32),
    Scratch,
    ScratchOnly,
}

struct DiamondPipeline {
    pipeline: wgpu::RenderPipeline,
    uniforms: wgpu::Buffer,
    group: wgpu::BindGroup,
}

/// Milliseconds now, for the frame's breakdown.
pub(crate) fn now() -> f64 {
    web_sys::window().and_then(|w| w.performance()).map_or(0.0, |p| p.now())
}

/// A read-back begun: the buffer the frame is copied into, its width, height and row stride, and
/// the in-flight count it holds a place in.
pub type ReadBack = (wgpu::Buffer, u32, u32, u32, InFlight);

/// Read-backs in flight: how many, and their bytes.
#[derive(Default)]
pub struct Flights {
    count: Cell<u32>,
    bytes: Cell<usize>,
}

/// Cached GPU texture holding a canonical blurred shadow mask (reused across identical UI shapes
/// and tile frames without extra submits).
struct GpuCachedShadow {
    tid: TextureId,
    tex: wgpu::Texture,
    bytes: usize,
}

/// Pooled offscreen RGBA8 target (with Vello depth buffer) for isolated
/// layers and multi-pass effects.
struct GpuTarget {
    tex: wgpu::Texture,
    view: wgpu::TextureView,
    view_id: u64,
    depth: wgpu::TextureView,
    width: u32,
    height: u32,
    origin: (i32, i32),
    active_size: (u16, u16),
    bytes: usize,
    needs_clear: bool,
    /// True iff every pixel of this target is guaranteed to have alpha == 1.0 (copied full-area
    /// from an opaque parent and never modified by destructive root compositing).
    opaque: bool,
}

/// A bounded isolated source, with a second plane when the channels can differ.
struct GpuIsolation {
    main: GpuTarget,
    backdrop: Option<GpuTarget>,
    isolation: Isolation,
    clip_to_parent: bool,
    previous_targets: (bool, bool),
}

impl GpuIsolation {
    fn plane(&self, backdrop: bool) -> &GpuTarget {
        if backdrop {
            self.backdrop.as_ref().unwrap_or(&self.main)
        } else {
            &self.main
        }
    }

    fn plane_mut(&mut self, backdrop: bool) -> &mut GpuTarget {
        if backdrop {
            self.backdrop.as_mut().unwrap_or(&mut self.main)
        } else {
            &mut self.main
        }
    }
}

/// Pooled transient RGBA8 texture (with bound `TextureId`) holding one blurred shadow mask until
/// the active scene flushes.
struct GpuTempTex {
    tid: TextureId,
    tex: wgpu::Texture,
    view: wgpu::TextureView,
    width: u32,
    height: u32,
    bytes: usize,
}

/// Reusable scratch RGBA8 + depth target for rasterising shadow cast/hole masks.
struct GpuMaskScratch {
    tex: wgpu::Texture,
    view: wgpu::TextureView,
    view_id: u64,
    depth: wgpu::TextureView,
    width: u32,
    height: u32,
    bytes: usize,
}

/// Reusable scratch RGBA8 texture for inner-shadow blur output before alpha inversion.
struct GpuBlurScratch {
    tex: wgpu::Texture,
    view: wgpu::TextureView,
    view_id: u64,
    width: u32,
    height: u32,
    bytes: usize,
}

/// Identifies one non-scissor clip step in an active clip chain.
/// Equal keys guarantee identical path geometry, fill rule, and target-local transform.
#[derive(Clone, Copy, PartialEq, Eq)]
struct ClipStepKey {
    node_id: u32,
    path_idx: u32,
    even_odd: bool,
    transform: [u64; 6],
}

/// One cached clip-chain mask packed inside `Gpu::clip_atlas` for the active draw (`clip_cache_draw_id`).
struct CachedClipMask {
    key_hash: u64,
    key: Vec<ClipStepKey>,
    bounds: IRect,
    target_size: (u16, u16),
    /// Target-space origin `(bounds.x0 - slot_x, bounds.y0 - slot_y)` for `textureLoad`.
    origin: (i32, i32),
}

/// Ready-to-bind clip mask texture view and its target-local `(x0, y0)` origin.
struct ClipMaskBinding {
    view: wgpu::TextureView,
    view_id: u64,
    origin: (i32, i32),
}

/// Result of analyzing the active `Open::Clip` stack for one clipped draw.
struct ClipAnalysis<'a> {
    any_clip: bool,
    clipped_rect: IRect,
    mask_clips: Vec<(&'a BezPath, Affine, bool)>,
    cache_key: Option<(u64, Vec<ClipStepKey>)>,
    mask_bounds: IRect,
    target_size: (u16, u16),
}

/// The scratch target and its depth buffer (`TILE + 2 * halo` square for tiles, or `w x h` whole).
struct ScratchTile {
    texture: wgpu::Texture,
    view: wgpu::TextureView,
    view_id: u64,
    depth: wgpu::TextureView,
    width: u32,
    height: u32,
}

struct MotionPrefix {
    texture: wgpu::Texture,
    view: Affine,
    background: [u32; 4],
    serial: u64,
    cut: usize,
}

/// Optional WebGPU GPU-side frame timing via `TIMESTAMP_QUERY`.
struct GpuTimestampQuery {
    query_set: wgpu::QuerySet,
    resolve_buf: wgpu::Buffer,
    dummy_tex: wgpu::Texture,
    dummy_view: wgpu::TextureView,
    period_ns: f64,
    enabled: bool,
    has_sample: bool,
}

/// State for the active `draw_tile` or `render_whole` pass while `exec::draw_split` walks the scene.
struct ActiveDraw {
    /// Monotonic id identifying this tile/frame draw for the tile-local clip-mask cache.
    draw_id: u64,
    /// A whole frame writes straight to its destination; tiles use scratch color.
    frame_dst: Option<usize>,
    /// The part of a padded viewport that is actually presented.
    display_area: Option<IRect>,
    /// Optional displayed tile area `[h, h + TILE)` for culling apron-only root glass lenses.
    glass_display_area: Option<IRect>,
    /// Minimum left/top edge padding (tile apron or whole-frame pad) around displayed pixels.
    grid_pad: (i32, i32),
    /// World `Level` and frame-pixel origin of `level.grid()` for this draw, when uniform-scaled.
    draw_level: Option<crate::tiles::Level>,
    draw_grid_origin: Option<(i64, i64)>,
    width: u32,
    height: u32,
    background: [f32; 4],
    detail: bool,
    needs_clear: bool,
    backdrop_live: bool,
    has_context: bool,
    write_main: bool,
    write_backdrop: bool,
    main_opaque: bool,
    backdrop_opaque: bool,
    scene_dirty: bool,
    glass_masks: HashMap<(u32, usize), GlassMaskSlot>,
    before: Option<wgpu::CommandEncoder>,
    flush_ms: f64,
    prepare_masks_ms: f64,
    vello_render_ms: f64,
    reader_ms: f64,
    shadow_ms: f64,
    submit_ms: f64,
    draws: u32,
    vello_renders: u32,
    glass_ops: u32,
    glass_batched: u32,
    bg_blur_ops: u32,
    shadow_ops: u32,
    shadow_hits: u32,
}

impl ActiveDraw {
    #[allow(clippy::too_many_arguments)]
    fn new(
        draw_id: u64,
        frame_dst: Option<usize>,
        display_area: Option<IRect>,
        glass_display_area: Option<IRect>,
        grid_pad: (i32, i32),
        view: Affine,
        width: u32,
        height: u32,
        background: [f32; 4],
        detail: bool,
    ) -> Self {
        let (draw_level, draw_grid_origin) =
            crate::tiles::Level::of(view).map_or((None, None), |(level, origin)| (Some(level), Some(origin)));
        Self {
            draw_id,
            frame_dst,
            display_area,
            glass_display_area,
            grid_pad,
            draw_level,
            draw_grid_origin,
            width,
            height,
            background,
            detail,
            needs_clear: true,
            backdrop_live: false,
            has_context: false,
            write_main: true,
            write_backdrop: false,
            main_opaque: background[3] >= 1.0,
            backdrop_opaque: background[3] >= 1.0,
            scene_dirty: false,
            glass_masks: HashMap::new(),
            before: None,
            flush_ms: 0.0,
            prepare_masks_ms: 0.0,
            vello_render_ms: 0.0,
            reader_ms: 0.0,
            shadow_ms: 0.0,
            submit_ms: 0.0,
            draws: 0,
            vello_renders: 0,
            glass_ops: 0,
            glass_batched: 0,
            bg_blur_ops: 0,
            shadow_ops: 0,
            shadow_hits: 0,
        }
    }

    fn record_into(&self, stats: &mut DrawStats, total_ms: f64) {
        stats.prepare_masks_ms += self.prepare_masks_ms;
        stats.vello_render_ms += self.vello_render_ms;
        stats.reader_ms += self.reader_ms;
        stats.shadow_ms += self.shadow_ms;
        stats.submit_ms += self.submit_ms;
        stats.draws += self.draws;
        stats.vello_renders += self.vello_renders;
        stats.glass_ops += self.glass_ops;
        stats.glass_batched += self.glass_batched;
        stats.bg_blur_ops += self.bg_blur_ops;
        stats.shadow_ops += self.shadow_ops;
        stats.shadow_hits += self.shadow_hits;
        let render_ms = self.prepare_masks_ms + self.vello_render_ms + self.reader_ms + self.shadow_ms + self.flush_ms;
        stats.render_ms += render_ms;
        stats.encode_ms += (total_ms - render_ms - self.submit_ms).max(0.0);
    }

    /// Flushes this slice's counters into `stats` and zeroes them so a resumed `PendingTile`
    /// never double-counts earlier slices.
    fn record_and_reset_slice(&mut self, stats: &mut DrawStats, total_ms: f64) {
        self.record_into(stats, total_ms);
        self.flush_ms = 0.0;
        self.prepare_masks_ms = 0.0;
        self.vello_render_ms = 0.0;
        self.reader_ms = 0.0;
        self.shadow_ms = 0.0;
        self.submit_ms = 0.0;
        self.draws = 0;
        self.vello_renders = 0;
        self.glass_ops = 0;
        self.glass_batched = 0;
        self.bg_blur_ops = 0;
        self.shadow_ops = 0;
        self.shadow_hits = 0;
    }
}

/// In-progress tile paused cooperatively mid-walk to honor the per-frame CPU budget.
/// Its partially rendered main pixels live in `self.scratches[active_scratch]` and (when
/// `active.backdrop_live`) its backdrop plane lives in `self.readers.backdrop_frame`.
struct PendingTile {
    key: TileKey,
    view: Affine,
    detail: bool,
    rough: bool,
    coarse_readers: bool,
    halo: i32,
    tile_halo: i32,
    side: u32,
    background: [f32; 4],
    inputs: DrawInputs,
    paused: PausedWalk,
    verbs: usize,
}

/// A walk paused at a deadline, a tile's (`PendingTile`) or a whole pass's (`WholePass`): until
/// it resumes (`Gpu::resume_walk`) or is dropped (`Gpu::drop_walk`) it owns its scratch slot, its
/// target (`ActiveDraw`, with the backdrop plane its readers read), the backdrop generation, and
/// the glass mask atlas its lenses' masks sit in (`trim_pools` keeps that while one is held).
struct PausedWalk {
    active: ActiveDraw,
    scratch: usize,
    backdrop_gen: u64,
    backdrop_blur_written: Option<IRect>,
    /// Where the walk resumes; None for a pass set up but not walked yet.
    checkpoint: Option<exec::WalkCheckpoint>,
}

/// What a draw spread over slices was asked to draw with beyond its view and size: it resumes,
/// and what it drew is shown, only while these still hold (`Gpu::inputs`).
#[derive(Clone, Copy, PartialEq)]
struct DrawInputs {
    generation: u64,
    bg_bits: [u32; 4],
    limits: crate::limits::Limits,
}

enum TileStep {
    Complete,
    Paused,
    NoSlot,
}

/// A whole pass (`Gpu::draw_whole_pass`) set up and possibly paused part way: its target, walk
/// and counts, kept between budgeted slices (`Gpu::walk_whole_pass`).
struct WholePass {
    whole: Frame,
    size: (u32, u32),
    view: Affine,
    bg_bits: [u32; 4],
    dst: usize,
    padded: Option<((u32, u32), (u32, u32))>,
    samples: Option<IRect>,
    capturing: bool,
    moving: bool,
    t0: f64,
    submits0: u32,
    stats: DrawStats,
    verbs: usize,
    split: Split,
    coarse_readers: bool,
    paused: Option<PausedWalk>,
    /// The whole walk's counts once complete.
    total: Option<DrawStats>,
}

enum WholeStart {
    /// The frame shown is already this one.
    Unchanged(DrawStats),
    Pass(Box<WholePass>),
}

/// A reduced reader-halo frame in progress (`Gpu::render_reader_halo`): its stages run one after
/// another, each a whole pass, and with a deadline they pause and resume over slices.
struct HaloRun {
    frame: Frame,
    background: [f32; 4],
    generation: u64,
    moving: bool,
    far_capture_bounds: IRect,
    stage: HaloStage,
    /// The stage's pass, begun and paused.
    pass: Option<Box<WholePass>>,
    /// The render divisor of the tier being drawn, and of the far tier once it's done.
    tier_divisor: i32,
    far_render_div: i32,
    replay: DrawStats,
    t0: f64,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum HaloStage {
    Far,
    Mid,
    Final,
}

/// A whole frame drawn over budgeted slices for a view at rest (`Gpu::render_whole_sliced`): its
/// native pass, or the reduced reader-halo frame's stages, and the view it's for.
struct PendingWhole {
    stage: PendingStage,
    /// The view's halo plan, if any: what the halo stage draws, and what a native pass that hits
    /// a memory limit falls back to.
    plan: Option<ViewportHaloPlan>,
    frame: Frame,
    background: [f32; 4],
    view_bits: [u64; 6],
    inputs: DrawInputs,
    /// 1 once a pass hit a memory limit (or stepped down from native) beside held tile pages:
    /// after its stand-in frame shows and the view stays still for `RETRY_QUIET_MS`, tile pages
    /// are dropped (keeping the overview) and the view retries once (2).
    retry: u8,
}

impl PendingWhole {
    /// Whether a stage's walk is paused, holding its scratch and glass masks.
    fn paused(&self) -> bool {
        match &self.stage {
            PendingStage::Start | PendingStage::CoarseStart(_) | PendingStage::Retry => false,
            PendingStage::Native(pass) | PendingStage::CoarseWhole(_, pass) => pass.paused.is_some(),
            PendingStage::Halo(run) => run.pass.as_ref().is_some_and(|p| p.paused.is_some()),
        }
    }
}

enum PendingStage {
    /// Not set up yet (or dropped to start again): holds nothing.
    Start,
    Native(Box<WholePass>),
    Halo(Box<HaloRun>),
    /// Staged memory-limit fallback at divisor `div` (1, 2 or 4): yields if the failed stage used
    /// the slice up before starting `CoarseWhole`.
    CoarseStart(u32),
    /// Unpadded coarse-reader whole pass at divisor `div` (1 = device resolution, 2/4 = scaled)
    /// when the full halo exceeds GPU memory.
    CoarseWhole(u32, Box<WholePass>),
    /// Waits for the view to be still, then drops tile pages (keeping the overview) and starts again.
    Retry,
}

type CoarseTile = (u32, u32, u32, u32);

/// The whole frame a `PendingWhole` finished, shown now: what a present-only frame of the same
/// view shows again (`Gpu::present_sliced_frame`).
#[derive(Clone, Copy, PartialEq)]
struct SlicedFrame {
    view_bits: [u64; 6],
    size: (u32, u32),
    inputs: DrawInputs,
    exact: bool,
    plan: u32,
}

/// The glass-free prefix or blurred patch captured at a reader's paint position in a halo pass.
struct HaloPatch {
    texture: wgpu::Texture,
    view: wgpu::TextureView,
    view_id: u64,
    origin: (i32, i32),
    size: (u32, u32),
    divisor: i32,
    halo_offset: (i32, i32),
    frame_size: (i32, i32),
    within: Option<glass::ClipWithin>,
}

/// One device-aligned edge strip captured before a reduced halo tier for fractional `EdgeMode::Clamp`.
struct HaloClampStrip {
    patch: HaloPatch,
    /// Straddling replay-frame texel index (before subtracting `draw.origin`).
    straddle_frame: i32,
    clamp_weight: f32,
    samples_per_texel: u32,
    long_start_dev: i32,
    strip_divisor: i32,
}

struct HaloClampStripSet {
    left: Option<HaloClampStrip>,
    right: Option<HaloClampStrip>,
    top: Option<HaloClampStrip>,
    bottom: Option<HaloClampStrip>,
}

impl HaloClampStripSet {
    fn is_empty(&self) -> bool {
        self.left.is_none() && self.right.is_none() && self.top.is_none() && self.bottom.is_none()
    }

    fn into_patches(self) -> impl Iterator<Item = HaloPatch> {
        [self.left, self.right, self.top, self.bottom]
            .into_iter()
            .flatten()
            .map(|s| s.patch)
    }
}

struct HaloStripCapture {
    reader_key: (u32, usize),
    size: (u32, u32),
    captured: Option<HaloPatch>,
}

struct ProgressiveHaloPatch {
    patch: HaloPatch,
    bounds: IRect,
    cell_size: (u32, u32),
    first: usize,
    end: usize,
    cols: u32,
}

impl ProgressiveHaloPatch {
    #[allow(clippy::too_many_arguments)]
    fn copy_stop(
        &self,
        encoder: &mut wgpu::CommandEncoder,
        atlas: &wgpu::Texture,
        stop: usize,
        atlas_slot: usize,
        tile: IRect,
        origin: (i32, i32),
        atlas_cols: u32,
    ) {
        let global = tile.translate(origin.0, origin.1);
        let overlap = global.intersect(self.bounds);
        if stop < self.first || stop >= self.end || overlap.is_empty() {
            return;
        }
        let input = (
            (atlas_slot as u32 % atlas_cols) * (tile.x1 - tile.x0) as u32 + (overlap.x0 - global.x0) as u32,
            (atlas_slot as u32 / atlas_cols) * (tile.y1 - tile.y0) as u32 + (overlap.y0 - global.y0) as u32,
        );
        let cell = (stop - self.first) as u32;
        let output = (
            (cell % self.cols) * self.cell_size.0 + (overlap.x0 - self.bounds.x0) as u32,
            (cell / self.cols) * self.cell_size.1 + (overlap.y0 - self.bounds.y0) as u32,
        );
        copy_rect(
            encoder,
            atlas,
            &self.patch.texture,
            input,
            output,
            ((overlap.x1 - overlap.x0) as u32, (overlap.y1 - overlap.y0) as u32),
        );
    }
}

const FAR_HALO_SCRATCH_SLOT: usize = 2;
const MID_HALO_SCRATCH_SLOT: usize = 3;
const EDGE_STRIP_SCRATCH_SLOT: usize = 4;
const SOFTWARE_FILTER_PIXELS: usize = 512 * 1024;
const HARDWARE_HALO_RENDER_MAX_SIDE: u32 = 4096;
const HARDWARE_HALO_RENDER_MAX_PIXELS: usize = 12_000_000;
const SOFTWARE_HALO_RENDER_MAX_SIDE: u32 = 2048;
const SOFTWARE_HALO_RENDER_MAX_PIXELS: usize = 4_200_000;
const HARDWARE_HALO_STEADY_FAR_PIXELS: usize = 4_200_000;
const HARDWARE_HALO_STEADY_MID_PIXELS: usize = 2_200_000;
const SOFTWARE_HALO_STEADY_PIXELS: usize = 1_650_000;
const WIDE_BLUR_MAX_SIDE_HW: u32 = 3072;
const WIDE_BLUR_MAX_PIXELS_HW: usize = 4_200_000;
const WIDE_BLUR_MAX_SIDE_SW: u32 = 2560;
const WIDE_BLUR_MAX_PIXELS_SW: usize = 3_500_000;

/// World-grid `d = 2` wide uniform background-blur cache shared across 512 px tiles at one
/// `Level`, so large-radius blurs stay tiled (`plan == 0`, `exact == true`) instead of falling
/// into reader-halo whole frames.
struct WideBlurCache {
    level: crate::tiles::Level,
    cap_grid: IRect,
    cover_grid: IRect,
    vis_tiles_grid: IRect,
    inputs: DrawInputs,
    targets: Vec<(u32, usize)>,
    apron_glass_safe: bool,
    residual_readers: Vec<(IRect, i32)>,
    blurred: HaloMap<HaloPatch>,
}

impl WideBlurCache {
    fn covers(&self, plan: &halo::WideBlurPlan, inputs: DrawInputs) -> bool {
        self.inputs == inputs
            && self.level == plan.level
            && self.cover_grid.contains_rect(plan.cover_grid)
            && plan.targets.iter().all(|k| self.targets.contains(k))
    }

    fn halo_for_tile(&self, tile_x: i32, tile_y: i32, cap: i32) -> i32 {
        let t = i64::from(TILE);
        let x0 = i64::from(tile_x) * t;
        let y0 = i64::from(tile_y) * t;
        let (Ok(x0), Ok(y0), Ok(x1), Ok(y1)) = (
            i32::try_from(x0),
            i32::try_from(y0),
            i32::try_from(x0 + t),
            i32::try_from(y0 + t),
        ) else {
            return cap;
        };
        let tile_rect = IRect { x0, y0, x1, y1 };
        if !self.vis_tiles_grid.contains_rect(tile_rect) {
            return cap;
        }
        let mut max_h = 0i32;
        for &(aff_grid, reach) in &self.residual_readers {
            if !aff_grid.intersect(tile_rect).is_empty() {
                max_h = max_h.max(reach);
            }
        }
        if max_h > 0 { (max_h + (max_h & 1)).min(cap) } else { 0 }
    }
}

struct WideBlurBuild {
    plan: halo::WideBlurPlan,
    inputs: DrawInputs,
    background: [f32; 4],
    pass: Option<Box<WholePass>>,
}

enum WideBlurState {
    Building(Box<WideBlurBuild>),
    Ready(Box<WideBlurCache>),
}

#[derive(Clone, Copy)]
struct HaloTierCapture {
    render_divisor: i32,
    offset: (i32, i32),
    frame_size: (i32, i32),
    visible: IRect,
    prog_min_sigma: f32,
    prog_max_sigma: f32,
    unif_min_sigma: f32,
    unif_max_sigma: f32,
    is_far: bool,
}

struct HaloMap<V>(Vec<((u32, usize), V)>);

impl<V> Default for HaloMap<V> {
    fn default() -> Self {
        Self(Vec::new())
    }
}

impl<V> HaloMap<V> {
    fn new() -> Self {
        Self(Vec::new())
    }

    fn get(&self, key: &(u32, usize)) -> Option<&V> {
        self.0.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }

    fn contains_key(&self, key: &(u32, usize)) -> bool {
        self.0.iter().any(|(k, _)| k == key)
    }

    fn insert(&mut self, key: (u32, usize), val: V) -> Option<V> {
        if let Some((_, existing)) = self.0.iter_mut().find(|(k, _)| *k == key) {
            Some(std::mem::replace(existing, val))
        } else {
            self.0.push((key, val));
            None
        }
    }

    fn into_vec(self) -> Vec<((u32, usize), V)> {
        self.0
    }
}

/// A coarse post scope's blurred picture kept by the far tier (case L3), with its backdrop plane
/// when the scope has one.
struct PostScopePatch {
    main: HaloPatch,
    backdrop: Option<HaloPatch>,
}

struct ReaderHalo {
    capture: Option<HaloTierCapture>,
    strip_capture: Option<HaloStripCapture>,
    /// True during a world-grid `d = 2` wide-blur cache build (`WideBlurState::Building`).
    wide_capture: bool,
    wide_targets: Vec<(u32, usize)>,
    wide_last: Option<(u32, usize)>,
    wide_done: bool,
    native_prog_cutover: f32,
    native_unif_cutover: f32,
    downstream_readers: Vec<(u32, usize)>,
    downstream_mid_readers: Vec<(u32, usize)>,
    /// Layer-blur scopes the far tier blurs and keeps (case L3), and how deep the walk is inside
    /// one: glass there draws straight into the scope's reduced picture.
    coarse_post_scopes: Vec<u32>,
    inside_coarse_post_scope: usize,
    post_scopes: HaloMap<PostScopePatch>,
    prefixes: HaloMap<HaloPatch>,
    blurred: HaloMap<HaloPatch>,
    progressive_mid: HaloMap<ProgressiveHaloPatch>,
    progressive_far: HaloMap<ProgressiveHaloPatch>,
    clamp_strips: HaloMap<HaloClampStripSet>,
}

impl ReaderHalo {
    fn map_rect_to_grid(rect: IRect, origin: (i32, i32), divisor: i32, offset: (i32, i32)) -> IRect {
        let floor = |p: i32| p.div_euclid(divisor);
        let ceil = |p: i32| -floor(-p);
        IRect {
            x0: floor(rect.x0 - origin.0) + offset.0,
            y0: floor(rect.y0 - origin.1) + offset.1,
            x1: ceil(rect.x1 - origin.0) + offset.0,
            y1: ceil(rect.y1 - origin.1) + offset.1,
        }
    }

    fn capturing(&self) -> bool {
        self.capture.is_some() || self.strip_capture.is_some()
    }

    fn progressive(&self, is_far: bool) -> &HaloMap<ProgressiveHaloPatch> {
        if is_far {
            &self.progressive_far
        } else {
            &self.progressive_mid
        }
    }

    fn progressive_mut(&mut self, is_far: bool) -> &mut HaloMap<ProgressiveHaloPatch> {
        if is_far {
            &mut self.progressive_far
        } else {
            &mut self.progressive_mid
        }
    }
}
struct BlurReaderPlane {
    texture: wgpu::Texture,
    view: wgpu::TextureView,
    view_id: u64,
}

struct ReaderSource {
    plane: BlurReaderPlane,
    bounds: IRect,
}

struct BlurReaderDraw {
    frame_size: (i32, i32),
    origin: (i32, i32),
    dirty: IRect,
    source: ReaderSource,
    interiors: Vec<usize>,
    source_is_frame: bool,
    source_written: bool,
    grid_pad: (i32, i32),
    draw_grid_origin: Option<(i64, i64)>,
    targets: [Option<BlurReaderPlane>; 2],
}

impl BlurReaderDraw {
    fn dirty_size(&self) -> (u32, u32) {
        (
            (self.dirty.x1 - self.dirty.x0) as u32,
            (self.dirty.y1 - self.dirty.y0) as u32,
        )
    }

    fn frame_dirty_origin(&self) -> (i32, i32) {
        (self.origin.0 + self.dirty.x0, self.origin.1 + self.dirty.y0)
    }

    fn bounds_and_edge(&self, within: Option<glass::ClipWithin>, sigma: f32, view_bg: bool) -> (IRect, EdgeMode) {
        let (lvl, _) = if view_bg {
            blur::choose_level_view_bg(sigma)
        } else {
            blur::choose_level_view(sigma)
        };
        let align = blur::level_step(lvl);
        let (mut cb, edge) = progressive_blur::blur_bounds_and_edge_align(
            within,
            self.frame_size,
            (-self.source.bounds.x0, -self.source.bounds.y0),
            (self.source.bounds.size().0 as i32, self.source.bounds.size().1 as i32),
            align,
        );
        // Anchor `cb.x0/y0` modulo `align` so tiled and whole frames share the same pyramid phase
        // across seams and pan offsets:
        // - Unclipped blurs anchor to `Level::grid()` (for both frame and isolation-scope sources).
        // - Unfilled clipped blurs (`w.fill.is_none()`) preserve the true `w.x0.floor()` /
        //   `w.y0.floor()` phase even when a tile or padded view crops past the clip's left/top
        //   edge (`raw < 0`), where `blur_bounds_and_edge_align` clamps to `0` for unpadded crops.
        if align > 1 {
            let reach = if view_bg {
                blur::blur_reach_view_bg(sigma)
            } else {
                blur::blur_reach_view(sigma)
            }
            .ceil() as i32;
            let src_dirty = self.source_rect(self.dirty);
            let pad_x = self.grid_pad.0 >= align || src_dirty.x0 >= reach + align;
            let pad_y = self.grid_pad.1 >= align || src_dirty.y0 >= reach + align;
            match within {
                None => {
                    if let Some((nx, ny)) = self.draw_grid_origin {
                        if pad_x || (!self.source_is_frame && self.source.bounds.x0 > 0) {
                            cb.x0 = ((nx - i64::from(self.source.bounds.x0)).rem_euclid(i64::from(align)) as i32)
                                .min(cb.x1);
                        }
                        if pad_y || (!self.source_is_frame && self.source.bounds.y0 > 0) {
                            cb.y0 = ((ny - i64::from(self.source.bounds.y0)).rem_euclid(i64::from(align)) as i32)
                                .min(cb.y1);
                        }
                    }
                }
                Some(w) if w.fill.is_none() => {
                    if w.x0.is_finite() {
                        let raw_x = w.x0.floor() as i64 - i64::from(self.source.bounds.x0);
                        if raw_x < 0 && pad_x {
                            cb.x0 = (raw_x.rem_euclid(i64::from(align)) as i32).min(cb.x1);
                        }
                    }
                    if w.y0.is_finite() {
                        let raw_y = w.y0.floor() as i64 - i64::from(self.source.bounds.y0);
                        if raw_y < 0 && pad_y {
                            cb.y0 = (raw_y.rem_euclid(i64::from(align)) as i32).min(cb.y1);
                        }
                    }
                }
                Some(_) => {}
            }
        }
        (cb, edge)
    }

    fn source_rect(&self, target_rect: IRect) -> IRect {
        target_rect.translate(
            self.origin.0 - self.source.bounds.x0,
            self.origin.1 - self.source.bounds.y0,
        )
    }

    fn halo_clip_bounds(
        &self,
        tier: Option<HaloTierCapture>,
        within: Option<glass::ClipWithin>,
        sigma: f32,
        view_bg: bool,
    ) -> halo::HaloClipBounds {
        if tier.is_some_and(|t| t.render_divisor > 1) {
            halo::reduced_blur_bounds_and_edge(
                within,
                self.frame_size,
                (-self.source.bounds.x0, -self.source.bounds.y0),
                (self.source.bounds.size().0 as i32, self.source.bounds.size().1 as i32),
                sigma,
            )
        } else {
            let (clamp_bounds, edge) = self.bounds_and_edge(within, sigma, view_bg);
            halo::HaloClipBounds {
                clamp_bounds,
                edge,
                subtexel_border: None,
                subtexel_clamp: None,
            }
        }
    }
}

#[cfg(feature = "compute")]
pub type ComputeCheck = std::pin::Pin<Box<dyn std::future::Future<Output = ()>>>;

#[cfg(feature = "compute")]
type ComputeResult = Rc<std::cell::RefCell<Option<Result<Option<crate::vello_compute::FrameDiagnostic>>>>>;

#[cfg(feature = "compute")]
struct PendingCompute {
    result: ComputeResult,
    generation: u64,
    dst: usize,
    last: Last,
    background: [u32; 4],
    stats: crate::vello_compute::ComputeFrameStats,
}

/// A gated compute frame that was presented (`present_compute`), whose check decides whether it
/// was exact, or grows the buffers when a stage overflowed. Every one is settled
/// (`finish_gate`); none is dropped unchecked, since its check may carry growth or a GPU error.
#[cfg(feature = "compute")]
struct PendingGate {
    result: ComputeResult,
    generation: u64,
    last: Last,
    background: [u32; 4],
    /// Still what the canvas shows: no frame was drawn or presented after it.
    on_screen: bool,
    /// The compute page it was drawn from (`compute_epoch`): growth from an older page is moot.
    epoch: u64,
    /// Buffer growths before it was drawn (`gate_growths`): an overflow drawn before the latest
    /// growth was expected, so only one drawn after it counts toward the session fallback.
    growths: u64,
}

/// Gated frames whose checks may be in flight. Past it, `present_compute` draws nothing
/// (`GatePresent::Busy`) until one lands: checks are never dropped.
#[cfg(feature = "compute")]
const GATES_IN_FLIGHT: usize = 8;

/// Gated frames in a row that overflowed after the buffers last grew before compute turns off
/// for the session, as for six draws of one staged frame.
#[cfg(feature = "compute")]
const GATE_OVERFLOWS_MAX: u32 = 6;

/// What `present_compute` did.
#[cfg(feature = "compute")]
pub enum GatePresent {
    /// Drawn and presented; its check decides whether it was exact (`finish_gate`).
    Presented(DrawStats, ComputeCheck),
    /// Nothing drawn: there is no frame of this size on screen to keep (stage one instead), or
    /// compute doesn't draw this view.
    Stage,
    /// Nothing drawn: `GATES_IN_FLIGHT` checks are in flight. Try again once one lands.
    Busy,
}

/// What a gated frame's check found (`finish_gate`).
#[cfg(feature = "compute")]
pub enum GateFinish {
    /// Every stage fit: the frame on screen is exact.
    Verified,
    /// The frame on screen overflowed: the gate kept older pixels there and the buffers grew;
    /// draw again.
    Redraw,
    /// Compute is off for the session (`compute_reason`).
    Fallback,
    /// Nothing gated to settle, or its check hasn't landed.
    Pending,
}

#[cfg(feature = "compute")]
pub enum ComputeFinish {
    /// Checked and presented.
    Frame(DrawStats),
    /// A buffer overflowed and grew: stage the same frame again.
    Retry,
    /// Compute is off for this session (`compute_reason` says why): draw with vello_gpu.
    Fallback,
    /// Nothing checked to show for this generation (an edit landed, or it was cancelled):
    /// stage again.
    Stale,
}

/// What made the GPU's Vello renders and scene flushes, counted from the device's start (for
/// profiling: `Engine::gpuCounters`). `renders` by purpose: scene flush, glass mask batch, blur
/// reader clip, backdrop blur, scope composite clip, reader clip, reader glass, shadow cache,
/// shadow, reduced shadow, other. `flushes` by cause (`Gpu::flush_why`): unknown, motion prefix,
/// halo strip, whole frame, direct tile end, pause, slot tile end, blur reader, backdrop snapshot,
/// target change, glass, isolation push, post effects, isolation pop, shadow memory.
#[derive(Clone, Copy, Default)]
pub struct GpuCounters {
    pub renders: [u32; 11],
    pub flushes: [u32; 15],
    /// Offscreen isolation scopes pushed (blend modes, post effects, faded groups with passes).
    pub scopes: u32,
    pub shadow_misses: u32,
    pub shadow_hits: u32,
    /// Tile walks paused to keep a slice within its budget.
    pub pauses: u32,
    /// Tiles nothing stood in for, started in frames while the camera moved.
    pub motion_must: u32,
    /// Frames while the camera moved that started no tile work: the GPU was behind.
    pub motion_backoff: u32,
    /// Overview tiles drawn.
    pub overview: u32,
}

pub struct Gpu {
    /// Held for the device's lifetime: on the web, dropping the instance loses the device.
    _instance: wgpu::Instance,
    /// Off-screen WebGL2 context surface when `surface` is None (read-back-only mode): wgpu's GL
    /// backend keeps its WebGL2 context alive through its surface.
    #[cfg(feature = "webgl")]
    _gl_surface: Option<wgpu::Surface<'static>>,
    /// Removes the `webglcontextlost` listener when dropped.
    #[cfg(feature = "webgl")]
    _context_loss: Option<ContextLossGuard>,
    pub device: wgpu::Device,
    pub queue: wgpu::Queue,
    surface: Option<(wgpu::Surface<'static>, wgpu::SurfaceConfiguration)>,
    renderer: Renderer,
    resources: Resources,
    cpu_resources: vello_cpu::Resources,
    bindings: TextureBindings,
    scene: Scene,
    mask_scene: Scene,
    readers: GpuReaders,
    reader_halo: Option<ReaderHalo>,
    wide_blur: Option<WideBlurState>,
    active: Option<ActiveDraw>,
    /// Hard wall-clock deadline (`now()` ms) checked cooperatively during budgeted tile walks.
    deadline_ms: Option<f64>,
    /// GPU passes (Vello renders and isolation scopes) a moving frame may start
    /// (`MOVING_PASSES`): past it, `deadline_reached` pauses the walk as a deadline does.
    pass_budget: Option<u32>,
    /// GPU passes started so far, and where the frame with a pass budget began counting.
    passes: u32,
    passes_at: u32,
    /// Frames (and idle slices) whose GPU work was submitted, the last of them the GPU finished
    /// (`queue.on_submitted_work_done`), and when the last was submitted: back-pressure.
    /// Submissions not known done (`gpu_done`, the highest sequence the GPU reported done).
    gpu_sent: crate::pacing::InFlight,
    gpu_done: Arc<AtomicU64>,
    /// Moving frames that started no tile work while some was wanted.
    motion_starved: crate::pacing::Starvation,
    /// The walk drawing now draws a rough stand-in (an overview tile, `exec::Backend::rough`).
    rough: bool,
    /// An exact frame no slot can hold, part drawn at rest (`DirectSlices`).
    direct_slices: Option<DirectSlices>,
    /// When the camera last moved or changed (`note_input`), and the view and size it changed to.
    last_input_ms: f64,
    input_view: Option<([u64; 6], (u32, u32))>,
    overview_page: Option<OverviewPage>,
    /// Tile cooperatively paused mid-walk so no single frame stalls past its CPU budget.
    pending_tile: Option<PendingTile>,
    pending_whole: Option<PendingWhole>,
    sliced_frame: Option<SlicedFrame>,
    /// True while a freshly opened page is still completing its coarse opening ladder tiles.
    opening_pending: bool,
    backdrop_gen: u64,
    /// Union of root backdrop regions written by exact background blurs since the last
    /// `bump_backdrop_gen`. Disjoint sibling blurs reuse the cached blur pyramid safely.
    backdrop_blur_written: Option<IRect>,
    /// Frame textures: the one shown (`cur`) and the one being made.
    frames: Vec<Main>,
    #[cfg(feature = "compute")]
    next_frame_view_id: u64,
    cur: Option<usize>,
    surface_bytes: usize,
    /// The board textures (decision 0040, phase 2): which tiles are held, where, and how fresh.
    pub tiles: TileCache,
    pages: Vec<Page>,
    /// Tile atlas page side in physical pixels (4096 when limits & tile budget allow, else 2048/1024/512).
    page_side: u32,
    /// Scratch targets and their depth buffers: slot 0 caches the plain `TILE x TILE` target for
    /// non-reader and coarse tiles, slot 1 caches the haloed (`TILE + 2 * halo`) or whole-frame target,
    /// slots 2 and 3 cache the far and mid reader-halo replay targets separately to avoid thrashing,
    /// and slot 4 holds transient fractional clip edge strips (destroyed right after the frame).
    scratches: [Option<ScratchTile>; 5],
    halo_reader_planes: [[Option<PlainTex>; 3]; 2],
    halo_prefix_pool: Vec<HaloPatch>,
    active_scratch: usize,
    motion_prefix: Option<MotionPrefix>,
    compositor: Option<Compositor>,
    diamond: Option<DiamondPipeline>,
    /// The frame shown: what it was drawn for, so the next may stand on it.
    last: Option<Last>,
    last_scale: Option<f64>,
    /// The engine's generation and background the frame shown was made at, and whether it's exact.
    shown: Option<(u64, [u32; 4], bool)>,
    /// The requested reader bounds of the last whole draw, if it fit.
    whole_samples: Option<Option<IRect>>,
    whole_reader_halo: bool,
    /// The frame a limited moving frame presented (`present_motion_standin`), while `cur` keeps
    /// the sharp frame it was warped from: what a read-back shows until a frame replaces it on
    /// screen (`pacing::Screen`).
    screen: crate::pacing::Screen,
    /// Milliseconds a tile has lately taken to draw (a running average).
    tile_ms: f64,
    /// Running EWMA of `submit_ms / work_ms` for tile slices so backends with synchronous submit
    /// flush costs (such as WebGL2 across Chrome, Safari, and Firefox) reserve headroom inside
    /// each frame's time budget.
    submit_ratio: f64,
    blit: Option<wgpu::RenderPipeline>,
    images: HashMap<u32, Vec<(TextureId, wgpu::Texture, u32, u32)>>,
    /// Image levels being uploaded in row strips (`put_image_bitmap_rows`), by image and width:
    /// counted in the budget, resident once their last rows are in.
    pending_images: PendingImages,
    /// Per-draw temporary textures (e.g. diamond gradients), released right after submit.
    temp_textures: Vec<(TextureId, wgpu::Texture)>,
    temp_bytes: usize,
    image_bytes: usize,
    atlas: Atlas,
    pub masks: MaskCache<Arc<vello_cpu::Pixmap>>,
    mask_side: u32,
    /// Rasterises glyph masks (on the CPU, as the CPU backend does: the same coverage).
    raster: masks::Rasterizer,
    /// Reusable reference Gaussian blur pass and shareable GPU blur pyramids.
    pub blur: crate::blur::gpu::GpuBlur,
    /// Shadow helper shader pass (inner-shadow alpha inversion and reduced-mask upsampling).
    shadow: crate::shadow::gpu::GpuShadow,
    /// Strictly budgeted LRU cache of canonical blurred shadow masks.
    shadow_cache: ShadowMaskCache<GpuCachedShadow>,
    /// Evicted cached shadow textures waiting for the active scene to flush before destruction.
    retired_shadows: Vec<GpuCachedShadow>,
    /// Blend shader pass (all 17 non-normal blend modes and `BLEND_LERP`).
    blend: crate::blend::gpu::GpuBlend,
    /// Noise grain shader pass and bounded GPU grain tile cache.
    noise: crate::noise::gpu::GpuNoise,
    /// Texture displacement shader pass.
    texture: crate::texture::gpu::GpuTexture,
    /// Active offscreen isolation stack (top is the current render target).
    offscreen_stack: Vec<GpuIsolation>,
    /// Warm reusable offscreen targets.
    offscreen_pool: Vec<GpuTarget>,
    /// Offscreen targets referenced by the active encoder until submission.
    offscreen_in_use: Vec<GpuTarget>,
    /// Warm reusable transient shadow textures.
    temp_pool: Vec<GpuTempTex>,
    /// Transient shadow textures referenced by `self.scene` until the next flush.
    temp_in_use: Vec<GpuTempTex>,
    /// Scratch rasterisation target for shadow and blend clip masks.
    scratch_mask: Option<GpuMaskScratch>,
    /// Scratch blur output texture for inner-shadow inversion.
    scratch_blur: Option<GpuBlurScratch>,
    /// Scratch backdrop copy texture for blend compositing.
    scratch_backdrop: Option<GpuBlurScratch>,
    /// Persistent single-FBO shelf-packed RGBA8 atlas for tile-local cached clip-chain masks.
    clip_atlas: Option<GpuBlurScratch>,
    clip_atlas_at: (u32, u32, u32),
    clip_atlas_cleared: bool,
    /// Entries currently packed in `clip_atlas` for the active draw (`clip_cache_draw_id`).
    clip_mask_cache: Vec<CachedClipMask>,
    clip_cache_draw_id: u64,
    next_draw_id: u64,
    /// Clip-chain hashes already observed in the current draw (2-hit admission).
    clip_seen_hashes: [u64; 32],
    clip_seen_len: u8,
    /// Replaced scratch textures still referenced by an unsubmitted encoder, destroyed after submit.
    retired_textures: Vec<(wgpu::Texture, usize)>,
    next_temp_id: u64,
    /// Total GPU bytes held by offscreen/temp pools and shadow scratch textures.
    pool_bytes: usize,
    /// Bytes of temporary shadow textures referenced by the current scene.
    in_use_bytes: usize,
    pub health: Arc<Health>,
    pub adapter: String,
    pub backend: &'static str,
    pub details: String,
    pub fallback_adapter: bool,
    /// Command buffers submitted, for the report.
    pub submits: u32,
    /// What made Vello renders and scene flushes (profiling).
    pub counters: GpuCounters,
    /// The cause of the next scene flush, for `counters` (set just before it).
    flush_why: u8,
    /// GPU memory allocated (`Limits::gpu_bytes`), and the budget.
    bytes: usize,
    pub budget: usize,
    /// Exact byte shortfall recorded by the last `reserve` memory-limit refusal.
    last_limit_shortfall: Cell<usize>,
    /// Actual device limits validated before allocating textures or read-back buffers.
    max_texture_2d: u32,
    max_buffer_size: u64,
    /// Read-backs in flight.
    readbacks: Rc<Flights>,
    /// Optional WebGPU GPU timestamp query state for frame-level GPU timing.
    timestamps: Option<GpuTimestampQuery>,
    /// Whether fixed-function hardware blending in Vello's strip pass is enabled.
    hw_blend_enabled: bool,
    /// Whether tile-local clip-chain mask caching and integer AA-rect scissor folding are enabled.
    clip_fast_path_enabled: bool,
    /// Whether the WebGPU device has hardware timestamp queries enabled.
    #[cfg(feature = "compute")]
    timestamp_query: bool,
    /// P0 Vello 0.12 GPU compute path for ordinary paint (WebGPU Core only, behind flag).
    #[cfg(feature = "compute")]
    compute: Option<crate::vello_compute::VelloCompute>,
    #[cfg(feature = "compute")]
    pub compute_ordinary: bool,
    #[cfg(feature = "compute")]
    pub last_compute_used: bool,
    #[cfg(feature = "compute")]
    pending_compute: Option<PendingCompute>,
    #[cfg(feature = "compute")]
    pending_gates: std::collections::VecDeque<PendingGate>,
    /// Counts compute pages: a fresh page, a reset or a change of buffer policy starts a new one.
    #[cfg(feature = "compute")]
    compute_epoch: u64,
    /// Buffer growths that gated checks caused, and gated overflows in a row after the latest.
    #[cfg(feature = "compute")]
    gate_growths: u64,
    #[cfg(feature = "compute")]
    gate_overflows: u32,
    /// The frame in `frames[cur]` was drawn for the page loaded now: a fresh list or a cleared
    /// view cache leaves `cur` pointing at another page's pixels, which a gated frame must not
    /// keep (`present_compute` stages instead).
    #[cfg(feature = "compute")]
    cur_page: bool,
    #[cfg(feature = "compute")]
    pub compute_reason: Option<String>,
    #[cfg(feature = "compute")]
    pub ordinary_revision: Option<(u32, bool)>,
    #[cfg(feature = "compute")]
    compute_tight: bool,
}

impl Drop for Gpu {
    fn drop(&mut self) {
        self.health.cancel();
        if let Some(ts) = self.timestamps.take() {
            ts.resolve_buf.destroy();
            ts.dummy_tex.destroy();
        }
        #[cfg(feature = "compute")]
        {
            self.compute.take();
        }
        for m in self.frames.drain(..) {
            m.texture.destroy();
        }
        for p in self.pages.drain(..) {
            p.texture.destroy();
        }
        for (tex, _) in self.retired_textures.drain(..) {
            tex.destroy();
        }
        self.clip_mask_cache.clear();
        if let Some(a) = self.clip_atlas.take() {
            a.tex.destroy();
        }
        for scratch in self.scratches.iter_mut().filter_map(Option::take) {
            scratch.texture.destroy();
        }
        for set in &mut self.halo_reader_planes {
            for plane in set.iter_mut().filter_map(Option::take) {
                plane.texture.destroy();
            }
        }
        if let Some(WideBlurState::Ready(cache)) = self.wide_blur.take() {
            for (_, p) in cache.blurred.into_vec() {
                p.texture.destroy();
            }
        }
        if let Some(halo) = self.reader_halo.take() {
            for (_, p) in halo.prefixes.into_vec() {
                p.texture.destroy();
            }
            for (_, p) in halo.blurred.into_vec() {
                p.texture.destroy();
            }
            for (_, p) in halo.progressive_mid.into_vec() {
                p.patch.texture.destroy();
            }
            for (_, p) in halo.progressive_far.into_vec() {
                p.patch.texture.destroy();
            }
            for (_, s) in halo.clamp_strips.into_vec() {
                for p in s.into_patches() {
                    p.texture.destroy();
                }
            }
            for (_, ps) in halo.post_scopes.into_vec() {
                ps.main.texture.destroy();
                if let Some(b) = ps.backdrop {
                    b.texture.destroy();
                }
            }
        }
        for p in self.halo_prefix_pool.drain(..) {
            p.texture.destroy();
        }
        self.readers.evict_frame_scratch();
        self.readers.flush_retired();
        self.blur.clear();
        if let Some(c) = self.compositor.take() {
            c.uniforms.destroy();
            c.instances.destroy();
        }
        if let Some(d) = self.diamond.take() {
            d.uniforms.destroy();
        }
        self.release_temp_textures();
        for (_, levels) in self.images.drain() {
            for (_, tex, _, _) in levels {
                tex.destroy();
            }
        }
        self.atlas.texture.destroy();
        self.device.destroy();
    }
}

#[inline]
fn f64_canonical_bits(v: f64) -> u64 {
    if v == 0.0 { 0.0f64.to_bits() } else { v.to_bits() }
}

fn hash_clip_chain(key: &[ClipStepKey]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    let mix = |h: &mut u64, v: u64| {
        *h ^= v;
        *h = h.wrapping_mul(0x0000_0100_0000_01b3);
    };
    mix(&mut h, key.len() as u64);
    for step in key {
        mix(&mut h, (u64::from(step.node_id) << 32) | u64::from(step.path_idx));
        mix(&mut h, u64::from(step.even_odd));
        for c in step.transform {
            mix(&mut h, c);
        }
    }
    h
}

struct ClipAtlasSlot {
    x: u32,
    y: u32,
    next_at: (u32, u32, u32),
}

fn alloc_clip_slot(at: (u32, u32, u32), side: u32, w: u32, h: u32) -> Option<ClipAtlasSlot> {
    let aw = w.next_multiple_of(4);
    let ah = h.next_multiple_of(4);
    if aw > side || ah > side {
        return None;
    }
    let (mut x, mut y, mut row) = at;
    if x + aw > side {
        x = 0;
        y += row;
        row = 0;
    }
    if y + ah > side {
        return None;
    }
    Some(ClipAtlasSlot {
        x,
        y,
        next_at: (x + aw, y, row.max(ah)),
    })
}

fn align4_rect(r: IRect, target: IRect) -> IRect {
    IRect {
        x0: (r.x0.div_euclid(4) * 4).max(target.x0),
        y0: (r.y0.div_euclid(4) * 4).max(target.y0),
        x1: ((r.x1 + 3).div_euclid(4) * 4).min(target.x1),
        y1: ((r.y1 + 3).div_euclid(4) * 4).min(target.y1),
    }
}

/// Rasterizes `clips` in target-space coordinates (`scene` sized to `target_size`) bounded by
/// `bounds`. Keeping clip geometry unshifted and translating only via `RenderOptions::offset`
/// makes cached atlas masks, uncached scratch masks, and `self.scene` clips flatten and
/// anti-alias curved or rotated edges identically regardless of caching history.
fn raster_clip_list(scene: &mut Scene, clips: &[(&BezPath, Affine, bool)], bounds: IRect) {
    for &(path, transform, even_odd) in clips {
        scene.set_transform(transform);
        scene.set_fill_rule(if even_odd { Fill::EvenOdd } else { Fill::NonZero });
        scene.push_clip_path(path);
    }
    scene.set_transform(Affine::IDENTITY);
    scene.set_fill_rule(Fill::NonZero);
    scene.set_paint(vello_common::color::palette::css::WHITE);
    scene.fill_rect(&Rect::new(
        f64::from(bounds.x0),
        f64::from(bounds.y0),
        f64::from(bounds.x1),
        f64::from(bounds.y1),
    ));
    for _ in 0..clips.len() {
        scene.pop_clip();
    }
}

fn analyze_open_clips_inner(
    open: &[Open],
    rect: IRect,
    target_rect: IRect,
    skip_context: bool,
    allow_scissor_shrink: bool,
    fast_path: bool,
    max_tex: u32,
) -> ClipAnalysis<'_> {
    let target_size = (
        target_rect.x1.max(0).min(i32::from(u16::MAX)) as u16,
        target_rect.y1.max(0).min(i32::from(u16::MAX)) as u16,
    );
    if !fast_path {
        let mut any_clip = false;
        let mut clips = Vec::new();
        for o in open {
            if let Open::Clip {
                transform,
                path,
                even_odd,
                active_on_scene: true,
                context_only,
                ..
            } = o
                && (!skip_context || !*context_only)
            {
                any_clip = true;
                clips.push((path, *transform, *even_odd));
            }
        }
        let needs_mask = clips
            .iter()
            .any(|&(path, transform, even_odd)| !crate::geometry::path_covers_rect(path, transform, even_odd, rect));
        return ClipAnalysis {
            any_clip,
            clipped_rect: rect,
            mask_clips: if needs_mask { clips } else { Vec::new() },
            cache_key: None,
            mask_bounds: align4_rect(rect, target_rect),
            target_size,
        };
    }

    let mut any_clip = false;
    let mut clipped_rect = rect;
    let mut chain_bbox = target_rect;
    let mut non_aa = Vec::new();
    for o in open {
        let Open::Clip {
            transform,
            path,
            even_odd,
            active_on_scene: true,
            context_only,
            source,
            ..
        } = o
        else {
            continue;
        };
        if skip_context && *context_only {
            continue;
        }
        any_clip = true;
        if allow_scissor_shrink && let Some(aa_rect) = crate::geometry::path_as_integer_aa_rect(path, *transform) {
            clipped_rect = clipped_rect.intersect(aa_rect);
            if clipped_rect.is_empty() {
                return ClipAnalysis {
                    any_clip,
                    clipped_rect,
                    mask_clips: Vec::new(),
                    cache_key: None,
                    mask_bounds: clipped_rect,
                    target_size,
                };
            }
            continue;
        }
        let bbox = transform.transform_rect_bbox(path.bounding_box());
        let step_rect = if bbox.x0.is_finite() && bbox.y0.is_finite() && bbox.x1.is_finite() && bbox.y1.is_finite() {
            IRect::around(bbox.inflate(1.0, 1.0))
        } else {
            target_rect
        };
        chain_bbox = chain_bbox.intersect(step_rect);
        non_aa.push((path, *transform, *even_odd, *source));
    }

    if allow_scissor_shrink {
        clipped_rect = clipped_rect.intersect(chain_bbox);
        if clipped_rect.is_empty() {
            return ClipAnalysis {
                any_clip,
                clipped_rect,
                mask_clips: Vec::new(),
                cache_key: None,
                mask_bounds: clipped_rect,
                target_size,
            };
        }
    }

    let needs_mask = non_aa.iter().any(|&(path, transform, even_odd, _)| {
        !crate::geometry::path_covers_rect(path, transform, even_odd, clipped_rect)
    });
    if !needs_mask {
        return ClipAnalysis {
            any_clip,
            clipped_rect,
            mask_clips: Vec::new(),
            cache_key: None,
            mask_bounds: clipped_rect,
            target_size,
        };
    }

    let aligned_chain = align4_rect(chain_bbox, target_rect);
    let chain_w = (aligned_chain.x1 - aligned_chain.x0).max(0) as u32;
    let chain_h = (aligned_chain.y1 - aligned_chain.y0).max(0) as u32;
    let max_side = CLIP_ATLAS_SIDE.min(max_tex);
    let all_sourced = non_aa.iter().all(|c| c.3.is_some());
    let can_cache = all_sourced
        && chain_w > 0
        && chain_h > 0
        && chain_w.next_multiple_of(4) <= max_side
        && chain_h.next_multiple_of(4) <= max_side
        && aligned_chain.contains_rect(clipped_rect);

    let (cache_key, mask_bounds) = if can_cache {
        let key: Vec<ClipStepKey> = non_aa
            .iter()
            .map(|&(_, tf, even_odd, source)| {
                let (node_id, path_idx) = source.expect("checked sourced");
                ClipStepKey {
                    node_id,
                    path_idx,
                    even_odd,
                    transform: tf.as_coeffs().map(f64_canonical_bits),
                }
            })
            .collect();
        let hash = hash_clip_chain(&key);
        (Some((hash, key)), aligned_chain)
    } else {
        (None, align4_rect(clipped_rect, target_rect))
    };

    let mask_clips = non_aa.into_iter().map(|(p, tf, eo, _)| (p, tf, eo)).collect();
    ClipAnalysis {
        any_clip,
        clipped_rect,
        mask_clips,
        cache_key,
        mask_bounds,
        target_size,
    }
}

fn copy_rect(
    encoder: &mut wgpu::CommandEncoder,
    src: &wgpu::Texture,
    dst: &wgpu::Texture,
    src_origin: (u32, u32),
    dst_origin: (u32, u32),
    size: (u32, u32),
) {
    let info = |texture, (x, y)| wgpu::TexelCopyTextureInfo {
        texture,
        mip_level: 0,
        origin: wgpu::Origin3d { x, y, z: 0 },
        aspect: wgpu::TextureAspect::All,
    };
    encoder.copy_texture_to_texture(
        info(src, src_origin),
        info(dst, dst_origin),
        wgpu::Extent3d {
            width: size.0,
            height: size.1,
            depth_or_array_layers: 1,
        },
    );
}

fn texture(device: &wgpu::Device, w: u32, h: u32, usage: wgpu::TextureUsages, label: &str) -> wgpu::Texture {
    device.create_texture(&wgpu::TextureDescriptor {
        label: Some(label),
        size: wgpu::Extent3d {
            width: w.max(1),
            height: h.max(1),
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: FORMAT,
        usage,
        view_formats: &[],
    })
}

fn write(queue: &wgpu::Queue, tex: &wgpu::Texture, x: u32, y: u32, w: u32, h: u32, data: &[u8]) {
    queue.write_texture(
        wgpu::TexelCopyTextureInfo {
            texture: tex,
            mip_level: 0,
            origin: wgpu::Origin3d { x, y, z: 0 },
            aspect: wgpu::TextureAspect::All,
        },
        data,
        wgpu::TexelCopyBufferLayout {
            offset: 0,
            bytes_per_row: Some(w * 4),
            rows_per_image: Some(h),
        },
        wgpu::Extent3d {
            width: w,
            height: h,
            depth_or_array_layers: 1,
        },
    );
}

/// What `create` was asked to draw into.
pub enum Target {
    Canvas(web_sys::HtmlCanvasElement),
    Offscreen(web_sys::OffscreenCanvas),
    /// No canvas: frames are only read back (tests, the GPU bench).
    None,
}

#[cfg(feature = "webgl")]
fn offscreen_gl_surface(instance: &wgpu::Instance) -> Result<(wgpu::Surface<'static>, web_sys::EventTarget)> {
    if let Ok(off) = web_sys::OffscreenCanvas::new(1, 1) {
        let target: web_sys::EventTarget = off.clone().into();
        if let Ok(s) = instance.create_surface(wgpu::SurfaceTarget::OffscreenCanvas(off)) {
            return Ok((s, target));
        }
    }
    let canvas = web_sys::window()
        .and_then(|w| w.document())
        .and_then(|d| d.create_element("canvas").ok())
        .and_then(|e| e.dyn_into::<web_sys::HtmlCanvasElement>().ok())
        .ok_or_else(|| EngineError::new(ErrorCode::NoAdapter, "no canvas available for WebGL2"))?;
    canvas.set_width(1);
    canvas.set_height(1);
    let target: web_sys::EventTarget = canvas.clone().into();
    let s = instance
        .create_surface(wgpu::SurfaceTarget::Canvas(canvas))
        .map_err(|e| EngineError::new(ErrorCode::NoAdapter, format!("no WebGL2 surface: {e}")))?;
    Ok((s, target))
}

impl Gpu {
    /// A GPU device (WebGPU or WebGL2, per feature) and, given a canvas, a surface on it.
    /// In compatibility mode (WebGPU) the caller has made `navigator.gpu.requestAdapter` ask for
    /// a compatibility adapter; WebGL2 asks for downlevel WebGL2 limits with the adapter's
    /// texture and buffer sizes. Runs a capability probe (pipelines + small render readback)
    /// before succeeding so broken drivers are refused up front.
    pub async fn create(target: Target, mask_bytes: usize, mask_side: u32) -> Result<Self> {
        let backend_name: &'static str = if IS_WEBGL { "webgl2" } else { "webgpu" };
        #[cfg(feature = "webgl")]
        let instance = {
            let mut desc = wgpu::InstanceDescriptor::new_with_display_handle(Box::new(WebDisplay));
            desc.backends = wgpu::Backends::GL;
            wgpu::Instance::new(desc)
        };
        #[cfg(not(feature = "webgl"))]
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
            display: None,
            backends: wgpu::Backends::BROWSER_WEBGPU,
            flags: wgpu::InstanceFlags::default(),
            memory_budget_thresholds: wgpu::MemoryBudgetThresholds::default(),
            backend_options: wgpu::BackendOptions::default(),
        });

        let presents = !matches!(target, Target::None);
        #[cfg(feature = "webgl")]
        let (surface, event_target) = match target {
            Target::Canvas(c) => {
                let et: web_sys::EventTarget = c.clone().into();
                let s = instance
                    .create_surface(wgpu::SurfaceTarget::Canvas(c))
                    .map_err(|e| EngineError::new(ErrorCode::NoAdapter, format!("no WebGL2 surface: {e}")))?;
                (Some(s), Some(et))
            }
            Target::Offscreen(c) => {
                let et: web_sys::EventTarget = c.clone().into();
                let s = instance
                    .create_surface(wgpu::SurfaceTarget::OffscreenCanvas(c))
                    .map_err(|e| EngineError::new(ErrorCode::NoAdapter, format!("no WebGL2 surface: {e}")))?;
                (Some(s), Some(et))
            }
            Target::None => {
                let (s, et) = offscreen_gl_surface(&instance)?;
                (Some(s), Some(et))
            }
        };
        #[cfg(not(feature = "webgl"))]
        let surface = match target {
            Target::Canvas(c) => Some(instance.create_surface(wgpu::SurfaceTarget::Canvas(c))),
            Target::Offscreen(c) => Some(instance.create_surface(wgpu::SurfaceTarget::OffscreenCanvas(c))),
            Target::None => None,
        }
        .transpose()
        .map_err(|e| EngineError::new(ErrorCode::NoAdapter, format!("no WebGPU surface: {e}")))?;

        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                force_fallback_adapter: false,
                compatible_surface: surface.as_ref(),
                ..Default::default()
            })
            .await
            .map_err(|e| EngineError::new(ErrorCode::NoAdapter, format!("no {backend_name} adapter: {e}")))?;
        let info = adapter.get_info();
        let adapter_limits = adapter.limits();
        let adapter_features = adapter.features();
        let required_limits = if IS_WEBGL {
            let dl = wgpu::Limits::downlevel_webgl2_defaults();
            wgpu::Limits {
                max_texture_dimension_1d: adapter_limits.max_texture_dimension_1d,
                max_texture_dimension_2d: adapter_limits.max_texture_dimension_2d,
                max_texture_dimension_3d: adapter_limits.max_texture_dimension_3d.min(dl.max_texture_dimension_3d),
                max_texture_array_layers: adapter_limits.max_texture_array_layers.min(dl.max_texture_array_layers),
                max_buffer_size: adapter_limits.max_buffer_size,
                max_uniform_buffers_per_shader_stage: dl
                    .max_uniform_buffers_per_shader_stage
                    .min(adapter_limits.max_uniform_buffers_per_shader_stage),
                max_uniform_buffer_binding_size: dl
                    .max_uniform_buffer_binding_size
                    .min(adapter_limits.max_uniform_buffer_binding_size),
                max_inter_stage_shader_variables: dl
                    .max_inter_stage_shader_variables
                    .min(adapter_limits.max_inter_stage_shader_variables),
                max_color_attachments: dl.max_color_attachments.min(adapter_limits.max_color_attachments),
                ..dl
            }
        } else {
            adapter_limits.clone()
        };
        let want_timestamps = !IS_WEBGL && adapter_features.contains(wgpu::Features::TIMESTAMP_QUERY);
        let (device, queue) = if want_timestamps {
            match adapter
                .request_device(&wgpu::DeviceDescriptor {
                    label: Some("drawpane engine"),
                    required_features: wgpu::Features::TIMESTAMP_QUERY,
                    required_limits: required_limits.clone(),
                    ..Default::default()
                })
                .await
            {
                Ok(pair) => pair,
                Err(_) => adapter
                    .request_device(&wgpu::DeviceDescriptor {
                        label: Some("drawpane engine"),
                        required_features: wgpu::Features::empty(),
                        required_limits,
                        ..Default::default()
                    })
                    .await
                    .map_err(|e| EngineError::new(ErrorCode::NoAdapter, format!("no {backend_name} device: {e}")))?,
            }
        } else {
            adapter
                .request_device(&wgpu::DeviceDescriptor {
                    label: Some("drawpane engine"),
                    required_features: wgpu::Features::empty(),
                    required_limits,
                    ..Default::default()
                })
                .await
                .map_err(|e| EngineError::new(ErrorCode::NoAdapter, format!("no {backend_name} device: {e}")))?
        };
        let timestamps = if !IS_WEBGL && device.features().contains(wgpu::Features::TIMESTAMP_QUERY) {
            let query_set = device.create_query_set(&wgpu::QuerySetDescriptor {
                label: Some("frame timestamps"),
                ty: wgpu::QueryType::Timestamp,
                count: 2,
            });
            let resolve_buf = device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("frame timestamps resolve"),
                size: 16,
                usage: wgpu::BufferUsages::QUERY_RESOLVE | wgpu::BufferUsages::COPY_SRC,
                mapped_at_creation: false,
            });
            let dummy_tex = texture(
                &device,
                1,
                1,
                wgpu::TextureUsages::RENDER_ATTACHMENT,
                "frame timestamps target",
            );
            let dummy_view = dummy_tex.create_view(&Default::default());
            let period_ns = f64::from(queue.get_timestamp_period());
            Some(GpuTimestampQuery {
                query_set,
                resolve_buf,
                dummy_tex,
                dummy_view,
                period_ns: if period_ns.is_finite() && period_ns > 0.0 {
                    period_ns
                } else {
                    1.0
                },
                enabled: false,
                has_sample: false,
            })
        } else {
            None
        };
        let timestamp_query = device.features().contains(wgpu::Features::TIMESTAMP_QUERY);
        let device_limits = device.limits();
        if device_limits.max_texture_dimension_2d < ATLAS_SIDE {
            return Err(EngineError::new(
                ErrorCode::NoAdapter,
                format!(
                    "GPU maxTextureDimension2D {} is below required glyph atlas size {ATLAS_SIDE}",
                    device_limits.max_texture_dimension_2d
                ),
            ));
        }
        let health = Arc::new(Health::default());
        {
            let h = health.clone();
            device.on_uncaptured_error(Arc::new(move |e: wgpu::Error| {
                let code = if matches!(e, wgpu::Error::OutOfMemory { .. }) {
                    ErrorCode::Limit
                } else {
                    ErrorCode::Gpu
                };
                h.record_error(code, e.to_string());
            }));
            let h = health.clone();
            device.set_device_lost_callback(move |reason, message| {
                h.mark_lost(format!("{reason:?}: {message}"));
            });
        }
        #[cfg(feature = "webgl")]
        let context_loss = event_target.map(|et| ContextLossGuard::attach(et, health.clone()));

        let (present_surface, _kept_gl_surface) = if presents {
            let s = match surface {
                Some(s) => {
                    let caps = s.get_capabilities(&adapter);
                    let format = caps
                        .formats
                        .iter()
                        .copied()
                        .find(|f| matches!(f, wgpu::TextureFormat::Bgra8Unorm | wgpu::TextureFormat::Rgba8Unorm))
                        .or_else(|| caps.formats.first().copied())
                        .ok_or_else(|| EngineError::new(ErrorCode::NoAdapter, "the canvas offers no format"))?;
                    let alpha = if caps.alpha_modes.contains(&wgpu::CompositeAlphaMode::Opaque) {
                        wgpu::CompositeAlphaMode::Opaque
                    } else {
                        caps.alpha_modes
                            .first()
                            .copied()
                            .unwrap_or(wgpu::CompositeAlphaMode::Auto)
                    };
                    let config = wgpu::SurfaceConfiguration {
                        usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
                        format,
                        width: 1,
                        height: 1,
                        present_mode: wgpu::PresentMode::Fifo,
                        desired_maximum_frame_latency: 2,
                        alpha_mode: alpha,
                        color_space: wgpu::SurfaceColorSpace::default(),
                        view_formats: vec![],
                    };
                    Some((s, config))
                }
                None => None,
            };
            (s, None)
        } else {
            (None, surface)
        };
        let surface = present_surface;
        // Everything made from here to the end is checked at once: an adapter that can't make
        // Vello's pipelines (WebGPU's compatibility mode can't: they interpolate `flat, first`)
        // or runs out of memory doing it is refused now, with the reason, not mid-frame.
        let oom = device.push_error_scope(wgpu::ErrorFilter::OutOfMemory);
        let validation = device.push_error_scope(wgpu::ErrorFilter::Validation);
        let (renderer, resources) = Renderer::new(
            &device,
            &queue,
            &RenderTargetConfig {
                format: FORMAT,
                width: 1,
                height: 1,
            },
        );
        let blit = surface.as_ref().map(|(_, config)| {
            let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("present"),
                source: wgpu::ShaderSource::Wgsl(BLIT.into()),
            });
            device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some("present"),
                layout: None,
                vertex: wgpu::VertexState {
                    module: &module,
                    entry_point: Some("vs"),
                    compilation_options: Default::default(),
                    buffers: &[],
                },
                primitive: wgpu::PrimitiveState::default(),
                depth_stencil: None,
                multisample: wgpu::MultisampleState::default(),
                fragment: Some(wgpu::FragmentState {
                    module: &module,
                    entry_point: Some("fs"),
                    compilation_options: Default::default(),
                    targets: &[Some(wgpu::ColorTargetState {
                        format: config.format,
                        blend: None,
                        write_mask: wgpu::ColorWrites::ALL,
                    })],
                }),
                multiview_mask: None,
                cache: None,
            })
        });
        let atlas_tex = texture(
            &device,
            ATLAS_SIDE,
            ATLAS_SIDE,
            wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            "glyph atlas",
        );
        let checker = texture(
            &device,
            16,
            16,
            wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            "loading checker",
        );
        write(&queue, &checker, 0, 0, 16, 16, &crate::cpu::checker_pixels());
        let mut bindings = TextureBindings::new();
        bindings.insert(ATLAS_ID, atlas_tex.create_view(&Default::default()));
        bindings.insert(CHECKER_ID, checker.create_view(&Default::default()));
        let fallback_adapter = is_software_adapter(&info);
        let details = format_details(
            &info,
            &adapter_limits,
            adapter_features,
            backend_name,
            fallback_adapter,
            timestamp_query,
        );
        let blur_fmt = crate::blur::gpu::preferred_intermediate_format(&adapter);
        let blur = crate::blur::gpu::GpuBlur::new(&device, blur_fmt, 32 << 20);
        let shadow = crate::shadow::gpu::GpuShadow::new(&device);
        let blend = crate::blend::gpu::GpuBlend::new(&device);
        let noise = crate::noise::gpu::GpuNoise::new(&device);
        let texture = crate::texture::gpu::GpuTexture::new(&device);
        let readers = GpuReaders::new(&adapter, &device, &queue);
        let mut gpu = Self {
            adapter: format!(
                "{} ({:?}, {:?}){}",
                info.name,
                info.device_type,
                info.backend,
                if info.driver.is_empty() {
                    String::new()
                } else {
                    format!(" {}", info.driver)
                }
            ),
            backend: backend_name,
            details,
            fallback_adapter,
            _instance: instance,
            #[cfg(feature = "webgl")]
            _gl_surface: _kept_gl_surface,
            #[cfg(feature = "webgl")]
            _context_loss: context_loss,
            device,
            queue,
            surface,
            renderer,
            resources,
            cpu_resources: vello_cpu::Resources::new(),
            bindings,
            scene: Scene::new(1, 1),
            mask_scene: Scene::new(1, 1),
            readers,
            reader_halo: None,
            wide_blur: None,
            active: None,
            deadline_ms: None,
            pass_budget: None,
            passes: 0,
            passes_at: 0,
            gpu_sent: crate::pacing::InFlight::default(),
            gpu_done: Arc::new(AtomicU64::new(0)),
            motion_starved: crate::pacing::Starvation::default(),
            rough: false,
            direct_slices: None,
            last_input_ms: 0.0,
            input_view: None,
            overview_page: None,
            pending_tile: None,
            pending_whole: None,
            sliced_frame: None,
            opening_pending: false,
            backdrop_gen: 0,
            backdrop_blur_written: None,
            frames: Vec::new(),
            #[cfg(feature = "compute")]
            next_frame_view_id: 1,
            cur: None,
            surface_bytes: 0,
            tiles: TileCache::new(TILE, 0),
            pages: Vec::new(),
            page_side: DEFAULT_PAGE.min(device_limits.max_texture_dimension_2d),
            scratches: [None, None, None, None, None],
            halo_reader_planes: [[None, None, None], [None, None, None]],
            halo_prefix_pool: Vec::new(),
            active_scratch: 0,
            motion_prefix: None,
            compositor: None,
            diamond: None,
            last: None,
            last_scale: None,
            shown: None,
            whole_samples: None,
            whole_reader_halo: false,
            screen: crate::pacing::Screen::default(),
            tile_ms: 0.0,
            submit_ratio: if IS_WEBGL { 1.0 } else { 0.0 },
            blit,
            images: HashMap::new(),
            pending_images: PendingImages::default(),
            temp_textures: Vec::new(),
            temp_bytes: 0,
            image_bytes: 0,
            atlas: Atlas {
                texture: atlas_tex,
                at: (0, 0, 0),
                pending: Vec::new(),
            },
            masks: MaskCache::new(mask_bytes),
            mask_side,
            raster: masks::Rasterizer::default(),
            blur,
            shadow,
            shadow_cache: ShadowMaskCache::new(GPU_SHADOW_CACHE_BYTES),
            retired_shadows: Vec::new(),
            blend,
            noise,
            texture,
            offscreen_stack: Vec::new(),
            offscreen_pool: Vec::new(),
            offscreen_in_use: Vec::new(),
            temp_pool: Vec::new(),
            temp_in_use: Vec::new(),
            scratch_mask: None,
            scratch_blur: None,
            scratch_backdrop: None,
            clip_atlas: None,
            clip_atlas_at: (0, 0, 0),
            clip_atlas_cleared: false,
            clip_mask_cache: Vec::new(),
            clip_cache_draw_id: 0,
            next_draw_id: 0,
            clip_seen_hashes: [0; 32],
            clip_seen_len: 0,
            retired_textures: Vec::new(),
            next_temp_id: TEMP_TEX_BASE,
            pool_bytes: 0,
            in_use_bytes: 0,
            health,
            submits: 0,
            counters: GpuCounters::default(),
            flush_why: 0,
            bytes: (ATLAS_SIDE * ATLAS_SIDE * 4 + 16 * 16 * 4) as usize,
            budget: crate::limits::Limits::default().gpu_bytes,
            last_limit_shortfall: Cell::new(0),
            max_texture_2d: device_limits.max_texture_dimension_2d,
            max_buffer_size: device_limits.max_buffer_size,
            readbacks: Rc::new(Flights::default()),
            timestamps,
            hw_blend_enabled: true,
            clip_fast_path_enabled: true,
            #[cfg(feature = "compute")]
            timestamp_query,
            #[cfg(feature = "compute")]
            compute: None,
            #[cfg(feature = "compute")]
            compute_ordinary: false,
            #[cfg(feature = "compute")]
            last_compute_used: false,
            #[cfg(feature = "compute")]
            pending_compute: None,
            #[cfg(feature = "compute")]
            pending_gates: std::collections::VecDeque::new(),
            #[cfg(feature = "compute")]
            compute_epoch: 0,
            #[cfg(feature = "compute")]
            gate_growths: 0,
            #[cfg(feature = "compute")]
            gate_overflows: 0,
            #[cfg(feature = "compute")]
            cur_page: false,
            #[cfg(feature = "compute")]
            compute_reason: None,
            #[cfg(feature = "compute")]
            ordinary_revision: None,
            #[cfg(feature = "compute")]
            compute_tight: false,
        };
        gpu.ensure_compositor();
        gpu.ensure_diamond();
        let refused = validation.pop().await;
        let refused = refused.or(oom.pop().await);
        if let Some(e) = refused {
            return Err(EngineError::new(
                ErrorCode::NoAdapter,
                format!(
                    "the engine's GPU pipelines can't be made on this adapter ({}): {e}",
                    gpu.adapter
                ),
            ));
        }
        gpu.probe().await?;
        Ok(gpu)
    }

    /// Capability probe (decision 0040, "Fallbacks"): renders a small known scene through Vello
    /// and reads back a pixel so a broken or black driver is refused before the editor adopts it.
    async fn probe(&mut self) -> Result<()> {
        let probe_tex = texture(
            &self.device,
            4,
            4,
            wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            "capability probe",
        );
        let probe_view = probe_tex.create_view(&Default::default());
        let probe_depth = self
            .renderer
            .create_depth_texture_view(&RenderSize { width: 4, height: 4 });
        self.scene.reset_and_resize(4, 4);
        self.scene.set_transform(Affine::IDENTITY);
        self.scene
            .set_paint(vello_common::color::AlphaColor::<vello_common::color::Srgb>::new([
                1.0, 0.0, 0.0, 1.0,
            ]));
        self.scene.fill_rect(&Rect::new(0.0, 0.0, 4.0, 4.0));
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("probe") });
        let mut options = RenderOptions::default();
        options.target_init = TargetInit::Clear(ClearSettings::Viewport {
            color: vello_common::color::AlphaColor::new([0.0, 0.0, 0.0, 0.0]),
        });
        let render_res = self.renderer.render(
            &self.scene,
            &mut self.resources,
            &mut encoder,
            RenderTarget {
                view: &probe_view,
                depth_view: Some(&probe_depth),
            },
            &self.bindings,
            options,
        );
        self.scene.reset();
        if let Err(e) = render_res {
            probe_tex.destroy();
            return Err(EngineError::new(
                ErrorCode::NoAdapter,
                format!("GPU probe render failed on {}: {e:?}", self.adapter),
            ));
        }
        let row = 256u32;
        let buffer = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("probe readback"),
            size: u64::from(row) * 4,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        encoder.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo {
                texture: &probe_tex,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyBufferInfo {
                buffer: &buffer,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(row),
                    rows_per_image: None,
                },
            },
            wgpu::Extent3d {
                width: 4,
                height: 4,
                depth_or_array_layers: 1,
            },
        );
        self.queue.submit([encoder.finish()]);
        let flight = InFlight::new(Rc::new(Flights::default()), row as usize * 4);
        let px = read_back_with_timeout(
            self.device.clone(),
            self.health.clone(),
            buffer,
            4,
            4,
            row,
            flight,
            PROBE_TIMEOUT_MS,
        )
        .await;
        probe_tex.destroy();
        let px = px.map_err(|e| {
            let code = if e.code == ErrorCode::Timeout {
                ErrorCode::Timeout
            } else {
                ErrorCode::NoAdapter
            };
            EngineError::new(
                code,
                format!("GPU probe readback failed on {}: {}", self.adapter, e.message),
            )
        })?;
        self.check()
            .map_err(|e| EngineError::new(ErrorCode::NoAdapter, e.message))?;
        let i = (2 * 4 + 2) * 4;
        let pixel = [px[i], px[i + 1], px[i + 2], px[i + 3]];
        let expected = [255u8, 0, 0, 255];
        let ok = pixel.iter().zip(expected.iter()).all(|(a, b)| a.abs_diff(*b) <= 2);
        if !ok {
            return Err(EngineError::new(
                ErrorCode::NoAdapter,
                format!(
                    "GPU probe produced wrong pixels on {}: got {pixel:?}, expected {expected:?}",
                    self.adapter
                ),
            ));
        }
        Ok(())
    }

    /// Destroys the GPU device (for testing recovery and fallback).
    pub fn destroy(&self) {
        self.device.destroy();
        self.health.mark_lost_if_empty("Destroyed: device destroyed");
    }

    /// Validates a 2D texture dimension against the active device limit before allocating.
    pub fn check_texture_size(&self, width: u32, height: u32, what: &str) -> Result<()> {
        if width > self.max_texture_2d || height > self.max_texture_2d {
            return Err(EngineError::limit(format!(
                "{what} {width} x {height} px exceeds this GPU's maxTextureDimension2D ({})",
                self.max_texture_2d
            )));
        }
        Ok(())
    }

    pub fn image_limits(&self) -> (u32, usize) {
        (
            self.max_texture_2d,
            (self.max_buffer_size / 2).min((self.budget / 2) as u64) as usize,
        )
    }

    /// GPU memory the engine has allocated.
    pub fn bytes(&self) -> usize {
        #[cfg(feature = "compute")]
        let compute_bytes = self.compute.as_ref().map_or(0, |c| c.gpu_bytes());
        #[cfg(not(feature = "compute"))]
        let compute_bytes = 0;
        self.bytes
            + self.readers.bytes()
            + self.blend.bytes()
            + self
                .halo_reader_planes
                .iter()
                .flatten()
                .flatten()
                .map(PlainTex::bytes)
                .sum::<usize>()
            + self.blur.bytes()
            + self.pool_bytes
            + self.shadow_cache.bytes()
            + self.noise.gpu_bytes()
            + compute_bytes
    }

    /// Refuses an allocation of `bytes` (beside `freed`, about to go) past the budget.
    #[inline(never)]
    fn reserve(&self, bytes: usize, freed: usize, what: &str) -> Result<()> {
        // Read-back buffers in flight count against the budget.
        let held = self.bytes() + self.readbacks.bytes.get();
        let after = held.saturating_sub(freed).saturating_add(bytes);
        if after > self.budget {
            self.last_limit_shortfall.set(after - self.budget);
            return Err(EngineError::limit(format!(
                "{what} would take the engine's GPU memory to {} MiB; the most is {} MiB",
                after >> 20,
                self.budget >> 20
            )));
        }
        Ok(())
    }

    /// Like `reserve`, freeing warm unused pool textures first if tight on budget.
    fn reserve_or_trim(&mut self, bytes: usize, freed: usize, what: &str) -> Result<()> {
        if self.reserve(bytes, freed, what).is_err() {
            self.trim_pools(0);
            self.reserve(bytes, freed, what)?;
        }
        Ok(())
    }

    fn alloc_temp_id(&mut self) -> TextureId {
        let id = TextureId(self.next_temp_id);
        self.next_temp_id += 1;
        id
    }

    /// Releases unused pooled textures until `pool_bytes <= keep_bytes`.
    #[inline(never)]
    fn trim_pools(&mut self, keep_bytes: usize) {
        if keep_bytes == 0 {
            if !self.reader_halo.as_ref().is_some_and(ReaderHalo::capturing) {
                for set in &mut self.halo_reader_planes {
                    for plane in set.iter_mut().filter_map(Option::take) {
                        self.readers.retire(plane.texture);
                    }
                }
                if let Some(t) = self.readers.halo_border_src.take() {
                    self.readers.retire(t.texture);
                }
                for slot in [FAR_HALO_SCRATCH_SLOT, MID_HALO_SCRATCH_SLOT, EDGE_STRIP_SCRATCH_SLOT] {
                    if (self.active.is_none() || self.active_scratch != slot)
                        && let Some(old) = self.scratches[slot].take()
                    {
                        self.bytes -= Self::frame_bytes(old.width, old.height) * 2;
                        old.texture.destroy();
                    }
                }
            }
            if self.active.is_none() {
                for s in self.shadow_cache.clear() {
                    self.bindings.remove(s.tid);
                    s.tex.destroy();
                }
                self.blur.clear();
                self.noise.clear();
                // A paused walk's lenses and clip masks still read their caches there.
                if !self.walk_paused() {
                    self.readers.drop_glass_mask_atlas();
                    self.clear_clip_mask_cache();
                }
                self.readers.flush_retired();
            }
        }
        while self.pool_bytes > keep_bytes {
            if let Some(t) = self.temp_pool.pop() {
                self.bindings.remove(t.tid);
                self.pool_bytes = self.pool_bytes.saturating_sub(t.bytes);
                t.tex.destroy();
            } else if let Some(t) = self.offscreen_pool.pop() {
                self.pool_bytes = self.pool_bytes.saturating_sub(t.bytes);
                t.tex.destroy();
            } else if let Some(prefix) = self.halo_prefix_pool.pop() {
                self.pool_bytes -= Self::frame_bytes(prefix.texture.width(), prefix.texture.height());
                prefix.texture.destroy();
            } else if self.active.is_some() {
                // Keep scratch and clip-atlas reservations valid while allocating the rest of a pass.
                break;
            } else if !self.walk_paused()
                && let Some(a) = self.clip_atlas.take()
            {
                self.clip_mask_cache.clear();
                self.clip_atlas_at = (0, 0, 0);
                self.clip_atlas_cleared = false;
                self.clip_seen_len = 0;
                self.pool_bytes = self.pool_bytes.saturating_sub(a.bytes);
                a.tex.destroy();
            } else if let Some(s) = self.scratch_backdrop.take() {
                self.pool_bytes = self.pool_bytes.saturating_sub(s.bytes);
                s.tex.destroy();
            } else if let Some(s) = self.scratch_blur.take() {
                self.pool_bytes = self.pool_bytes.saturating_sub(s.bytes);
                s.tex.destroy();
            } else if let Some(s) = self.scratch_mask.take() {
                self.pool_bytes = self.pool_bytes.saturating_sub(s.bytes);
                s.tex.destroy();
            } else {
                break;
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn begin_active(
        &mut self,
        frame_dst: Option<usize>,
        display_area: Option<IRect>,
        glass_display_area: Option<IRect>,
        grid_pad: (i32, i32),
        view: Affine,
        width: u32,
        height: u32,
        background: [f32; 4],
        detail: bool,
    ) {
        self.clear_clip_mask_cache();
        self.next_draw_id = self.next_draw_id.wrapping_add(1);
        if self.next_draw_id == 0 {
            self.next_draw_id = 1;
        }
        self.clip_cache_draw_id = self.next_draw_id;
        self.active = Some(ActiveDraw::new(
            self.next_draw_id,
            frame_dst,
            display_area,
            glass_display_area,
            grid_pad,
            view,
            width,
            height,
            background,
            detail,
        ));
    }

    fn bump_backdrop_gen(&mut self) {
        self.backdrop_gen += 1;
        self.backdrop_blur_written = None;
    }

    fn flush_backdrop_blur_written(&mut self) {
        if self.backdrop_blur_written.is_some() {
            self.bump_backdrop_gen();
        }
    }

    fn clear_clip_mask_cache(&mut self) {
        self.clip_mask_cache.clear();
        self.clip_atlas_at = (0, 0, 0);
        self.clip_atlas_cleared = false;
        self.clip_seen_len = 0;
    }

    fn record_clip_seen(&mut self, hash: u64) -> bool {
        let n = usize::from(self.clip_seen_len);
        if self.clip_seen_hashes[..n].contains(&hash) {
            return true;
        }
        if n < self.clip_seen_hashes.len() {
            self.clip_seen_hashes[n] = hash;
            self.clip_seen_len += 1;
        } else {
            self.clip_seen_hashes[(hash as usize) & 31] = hash;
        }
        false
    }

    /// Lazily allocates the single persistent RGBA8 clip-mask atlas without stealing GPU
    /// headroom or triggering pool trimming. Returns `false` if the budget is tight so
    /// callers silently fall back to `scratch_mask`.
    fn ensure_clip_atlas(&mut self) -> bool {
        if self.clip_atlas.is_some() {
            return true;
        }
        let side = CLIP_ATLAS_SIDE.min(self.max_texture_2d).min(u32::from(u16::MAX));
        if side < 4 {
            return false;
        }
        let bytes = side as usize * side as usize * 4;
        if self
            .reserve(bytes.saturating_add(HEADROOM), 0, "a clip mask atlas")
            .is_err()
        {
            return false;
        }
        let tex = texture(
            &self.device,
            side,
            side,
            wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
            "clip mask atlas",
        );
        let view = tex.create_view(&Default::default());
        self.pool_bytes += bytes;
        self.clip_atlas = Some(GpuBlurScratch {
            tex,
            view,
            view_id: crate::blend::gpu::next_view_id(),
            width: side,
            height: side,
            bytes,
        });
        self.clip_atlas_at = (0, 0, 0);
        self.clip_atlas_cleared = false;
        true
    }

    fn analyze_open_clips<'a>(
        &self,
        open: &'a [Open],
        rect: IRect,
        target_rect: IRect,
        skip_context: bool,
        allow_scissor_shrink: bool,
    ) -> ClipAnalysis<'a> {
        let max_tex = self.max_texture_2d.min(u32::from(u16::MAX));
        analyze_open_clips_inner(
            open,
            rect,
            target_rect,
            skip_context,
            allow_scissor_shrink,
            self.clip_fast_path_enabled,
            max_tex,
        )
    }

    fn prepare_clip_mask(&mut self, analysis: &ClipAnalysis<'_>, label: &str) -> Result<Option<ClipMaskBinding>> {
        if analysis.mask_clips.is_empty() {
            return Ok(None);
        }
        let draw_id = self.active.as_ref().expect("active draw").draw_id;
        if self.clip_cache_draw_id != draw_id {
            self.clear_clip_mask_cache();
            self.clip_cache_draw_id = draw_id;
        }
        if let Some((hash, ref key)) = analysis.cache_key
            && let Some(atlas) = self.clip_atlas.as_ref()
            && let Some(entry) = self.clip_mask_cache.iter().find(|e| {
                e.key_hash == hash
                    && e.target_size == analysis.target_size
                    && e.key.as_slice() == key.as_slice()
                    && e.bounds.contains_rect(analysis.clipped_rect)
            })
        {
            return Ok(Some(ClipMaskBinding {
                view: atlas.view.clone(),
                view_id: atlas.view_id,
                origin: entry.origin,
            }));
        }

        let bounds = analysis.mask_bounds;
        let w = (bounds.x1 - bounds.x0).max(0) as u32;
        let h = (bounds.y1 - bounds.y0).max(0) as u32;
        if w == 0 || h == 0 || analysis.target_size.0 == 0 || analysis.target_size.1 == 0 {
            return Ok(None);
        }

        if let Some((hash, ref key)) = analysis.cache_key {
            let (moving, recording) = self
                .active
                .as_ref()
                .map_or((false, false), |a| (a.detail, a.before.is_some()));
            let clipped = analysis.clipped_rect;
            let use_area =
                ((clipped.x1 - clipped.x0).max(0) as usize).saturating_mul((clipped.y1 - clipped.y0).max(0) as usize);
            let chain_area = (w as usize).saturating_mul(h as usize);
            let oversized_first = chain_area > 128 * 128 && chain_area > use_area.saturating_mul(8);
            // Avoid rasterizing a large chain bbox for a single small use or a transient moving
            // frame: require a second sight first, and skip huge ratios on moving coarse tiles.
            let admit_by_hits = if moving {
                !oversized_first && self.record_clip_seen(hash)
            } else if oversized_first {
                self.record_clip_seen(hash)
            } else {
                true
            };
            if admit_by_hits && self.ensure_clip_atlas() {
                let side = self.clip_atlas.as_ref().expect("clip atlas").width;
                let mut slot = alloc_clip_slot(self.clip_atlas_at, side, w, h);
                if slot.is_none() && !recording {
                    self.clip_mask_cache.clear();
                    self.clip_atlas_at = (0, 0, 0);
                    self.clip_atlas_cleared = false;
                    slot = alloc_clip_slot(self.clip_atlas_at, side, w, h);
                }
                if let Some(ClipAtlasSlot {
                    x: slot_x,
                    y: slot_y,
                    next_at,
                }) = slot
                {
                    let (atlas_view, atlas_view_id) = {
                        let atlas = self.clip_atlas.as_ref().expect("clip atlas");
                        (atlas.view.clone(), atlas.view_id)
                    };
                    let mut atlas_opts = RenderOptions::default();
                    atlas_opts.target_init = if self.clip_atlas_cleared {
                        TargetInit::SrcOver
                    } else {
                        TargetInit::Clear(ClearSettings::Viewport {
                            color: AlphaColor::TRANSPARENT,
                        })
                    };
                    // Rasterize in target-space coordinates and shift strips into the 4px-aligned
                    // atlas slot with RenderOptions::offset so cached and uncached masks match bit-for-bit.
                    atlas_opts.offset = (slot_x as i32 - bounds.x0, slot_y as i32 - bounds.y0);
                    self.mask_scene
                        .reset_and_resize(analysis.target_size.0, analysis.target_size.1);
                    raster_clip_list(&mut self.mask_scene, &analysis.mask_clips, bounds);
                    let t_vr = now();
                    let vr_sub0 = self.active.as_ref().map_or(0.0, |a| a.submit_ms);
                    // Single white fill_rect has no overlapping opaque geometry, so depth is
                    // unnecessary: this saves 4 MiB, eliminates depth clears, and uses one strip draw.
                    let res = self.vello_render(true, &atlas_view, None, atlas_opts, label);
                    if let Some(a) = self.active.as_mut() {
                        a.vello_render_ms += (now() - t_vr - (a.submit_ms - vr_sub0)).max(0.0);
                    }
                    self.mask_scene.reset();
                    res?;
                    self.clip_atlas_at = next_at;
                    self.clip_atlas_cleared = true;
                    let origin = (bounds.x0 - slot_x as i32, bounds.y0 - slot_y as i32);
                    self.clip_mask_cache.push(CachedClipMask {
                        key_hash: hash,
                        key: key.clone(),
                        bounds,
                        target_size: analysis.target_size,
                        origin,
                    });
                    return Ok(Some(ClipMaskBinding {
                        view: atlas_view,
                        view_id: atlas_view_id,
                        origin,
                    }));
                }
            }
        }

        // Uncached fallback (non-cacheable clip, 1st sight while moving, atlas full while
        // recording, oversized bounds, or fast path disabled). Rasterize only the caller's tight rect
        // in target-space coordinates shifted via RenderOptions::offset so pixels are history-independent.
        let fb = if analysis.cache_key.is_some() {
            align4_rect(analysis.clipped_rect, bounds)
        } else {
            bounds
        };
        let fw = (fb.x1 - fb.x0).max(0) as u32;
        let fh = (fb.y1 - fb.y0).max(0) as u32;
        if fw == 0 || fh == 0 {
            return Ok(None);
        }
        let mut options = RenderOptions::default();
        options.target_init = TargetInit::Clear(ClearSettings::Viewport {
            color: AlphaColor::TRANSPARENT,
        });
        options.offset = (-fb.x0, -fb.y0);
        self.ensure_scratch_mask(fw, fh)?;
        self.mask_scene
            .reset_and_resize(analysis.target_size.0, analysis.target_size.1);
        raster_clip_list(&mut self.mask_scene, &analysis.mask_clips, fb);
        let (mask_view, mask_view_id, mask_depth) = {
            let mask = self.scratch_mask.as_ref().expect("clip mask scratch");
            (mask.view.clone(), mask.view_id, mask.depth.clone())
        };
        let t_vr = now();
        let vr_sub0 = self.active.as_ref().map_or(0.0, |a| a.submit_ms);
        let res = self.vello_render(true, &mask_view, Some(&mask_depth), options, label);
        if let Some(a) = self.active.as_mut() {
            a.vello_render_ms += (now() - t_vr - (a.submit_ms - vr_sub0)).max(0.0);
        }
        self.mask_scene.reset();
        res?;
        Ok(Some(ClipMaskBinding {
            view: mask_view,
            view_id: mask_view_id,
            origin: (fb.x0, fb.y0),
        }))
    }

    fn acquire_offscreen(&mut self, w: u32, h: u32, origin: (i32, i32)) -> Result<GpuTarget> {
        let max_tex = self.max_texture_2d.min(u32::from(u16::MAX));
        if w > max_tex || h > max_tex {
            return Err(EngineError::limit("offscreen target exceeds GPU texture limit"));
        }
        let need_w = w.max(1).next_multiple_of(64).min(max_tex);
        let need_h = h.max(1).next_multiple_of(64).min(max_tex);
        let max_area = (need_w as usize * need_h as usize * 4).max(65_536);
        if let Some((idx, _)) = self
            .offscreen_pool
            .iter()
            .enumerate()
            .filter(|(_, t)| t.width >= w && t.height >= h && (t.width as usize * t.height as usize) <= max_area)
            .min_by_key(|(_, t)| t.width as usize * t.height as usize)
        {
            let mut t = self.offscreen_pool.swap_remove(idx);
            t.origin = origin;
            t.active_size = (w as u16, h as u16);
            t.needs_clear = false;
            t.opaque = false;
            return Ok(t);
        }
        let bytes = need_w as usize * need_h as usize * 8; // RGBA8 + depth
        self.reserve_or_trim(bytes, 0, "an offscreen target")?;
        let tex = texture(
            &self.device,
            need_w,
            need_h,
            wgpu::TextureUsages::RENDER_ATTACHMENT
                | wgpu::TextureUsages::TEXTURE_BINDING
                | wgpu::TextureUsages::COPY_SRC
                | wgpu::TextureUsages::COPY_DST,
            "offscreen target",
        );
        let view = tex.create_view(&Default::default());
        let depth = self.renderer.create_depth_texture_view(&RenderSize {
            width: need_w as u16,
            height: need_h as u16,
        });
        self.pool_bytes += bytes;
        Ok(GpuTarget {
            tex,
            view,
            view_id: crate::blend::gpu::next_view_id(),
            depth,
            width: need_w,
            height: need_h,
            origin,
            active_size: (w as u16, h as u16),
            bytes,
            needs_clear: false,
            opaque: false,
        })
    }

    fn acquire_temp(&mut self, w: u32, h: u32) -> Result<GpuTempTex> {
        let max_tex = self.device.limits().max_texture_dimension_2d;
        if w > max_tex || h > max_tex {
            return Err(EngineError::limit("shadow texture exceeds GPU texture limit"));
        }
        let need_w = w.max(1).next_multiple_of(64).min(max_tex);
        let need_h = h.max(1).next_multiple_of(64).min(max_tex);
        let max_area = (need_w as usize * need_h as usize * 4).max(65_536);
        if let Some((idx, _)) = self
            .temp_pool
            .iter()
            .enumerate()
            .filter(|(_, t)| t.width >= w && t.height >= h && (t.width as usize * t.height as usize) <= max_area)
            .min_by_key(|(_, t)| t.width as usize * t.height as usize)
        {
            return Ok(self.temp_pool.swap_remove(idx));
        }
        let bytes = need_w as usize * need_h as usize * 4;
        self.reserve_or_trim(bytes, 0, "a shadow texture")?;
        let tex = texture(
            &self.device,
            need_w,
            need_h,
            wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
            "shadow temp",
        );
        let view = tex.create_view(&Default::default());
        let bind_view = tex.create_view(&Default::default());
        let tid = self.alloc_temp_id();
        self.bindings.insert(tid, bind_view);
        self.pool_bytes += bytes;
        Ok(GpuTempTex {
            tid,
            tex,
            view,
            width: need_w,
            height: need_h,
            bytes,
        })
    }

    fn ensure_scratch_mask(&mut self, w: u32, h: u32) -> Result<()> {
        let max_tex = self.device.limits().max_texture_dimension_2d;
        if w > max_tex || h > max_tex {
            return Err(EngineError::limit("shadow mask exceeds GPU texture limit"));
        }
        let need_w = w.max(1).next_multiple_of(64).min(max_tex);
        let need_h = h.max(1).next_multiple_of(64).min(max_tex);
        let max_area = (need_w as usize * need_h as usize * 4).max(65_536);
        let reuse = self.scratch_mask.as_ref().is_some_and(|s| {
            s.width >= w
                && s.height >= h
                && ((s.width as usize * s.height as usize) <= max_area
                    || (self.active.is_some() && s.bytes <= (4 << 20)))
        });
        if reuse {
            return Ok(());
        }
        let recording = self.active.as_ref().is_some_and(|a| a.before.is_some());
        let freed = if recording {
            0
        } else {
            self.scratch_mask.as_ref().map_or(0, |s| s.bytes)
        };
        let bytes = need_w as usize * need_h as usize * 8;
        self.reserve_or_trim(bytes, freed, "a shadow mask")?;
        if let Some(old) = self.scratch_mask.take() {
            if recording {
                self.retired_textures.push((old.tex, old.bytes));
            } else {
                self.pool_bytes = self.pool_bytes.saturating_sub(old.bytes);
                old.tex.destroy();
            }
        }
        let tex = texture(
            &self.device,
            need_w,
            need_h,
            wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
            "shadow mask",
        );
        let view = tex.create_view(&Default::default());
        let depth = self.renderer.create_depth_texture_view(&RenderSize {
            width: need_w as u16,
            height: need_h as u16,
        });
        self.pool_bytes += bytes;
        self.scratch_mask = Some(GpuMaskScratch {
            tex,
            view,
            view_id: crate::blend::gpu::next_view_id(),
            depth,
            width: need_w,
            height: need_h,
            bytes,
        });
        Ok(())
    }

    fn ensure_scratch_blur(&mut self, w: u32, h: u32) -> Result<()> {
        let max_tex = self.device.limits().max_texture_dimension_2d;
        if w > max_tex || h > max_tex {
            return Err(EngineError::limit("shadow blur scratch exceeds GPU texture limit"));
        }
        let need_w = w.max(1).next_multiple_of(64).min(max_tex);
        let need_h = h.max(1).next_multiple_of(64).min(max_tex);
        let max_area = (need_w as usize * need_h as usize * 4).max(65_536);
        let reuse = self
            .scratch_blur
            .as_ref()
            .is_some_and(|s| s.width >= w && s.height >= h && (s.width as usize * s.height as usize) <= max_area);
        if reuse {
            return Ok(());
        }
        let recording = self.active.as_ref().is_some_and(|a| a.before.is_some());
        let freed = if recording {
            0
        } else {
            self.scratch_blur.as_ref().map_or(0, |s| s.bytes)
        };
        let bytes = need_w as usize * need_h as usize * 4;
        self.reserve_or_trim(bytes, freed, "a shadow blur buffer")?;
        if let Some(old) = self.scratch_blur.take() {
            if recording {
                self.retired_textures.push((old.tex, old.bytes));
            } else {
                self.pool_bytes = self.pool_bytes.saturating_sub(old.bytes);
                old.tex.destroy();
            }
        }
        let tex = texture(
            &self.device,
            need_w,
            need_h,
            wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
            "shadow blur scratch",
        );
        let view = tex.create_view(&Default::default());
        self.pool_bytes += bytes;
        self.scratch_blur = Some(GpuBlurScratch {
            tex,
            view,
            view_id: crate::blend::gpu::next_view_id(),
            width: need_w,
            height: need_h,
            bytes,
        });
        Ok(())
    }

    fn ensure_scratch_backdrop(&mut self, w: u32, h: u32) -> Result<()> {
        let max_tex = self.device.limits().max_texture_dimension_2d;
        if w > max_tex || h > max_tex {
            return Err(EngineError::limit("blend backdrop exceeds GPU texture limit"));
        }
        let need_w = w.max(1).next_multiple_of(64).min(max_tex);
        let need_h = h.max(1).next_multiple_of(64).min(max_tex);
        let max_area = (need_w as usize * need_h as usize * 4).max(65_536);
        let reuse = self.scratch_backdrop.as_ref().is_some_and(|s| {
            s.width >= w
                && s.height >= h
                && ((s.width as usize * s.height as usize) <= max_area
                    || (self.active.is_some() && s.bytes <= (4 << 20)))
        });
        if reuse {
            return Ok(());
        }
        let recording = self.active.as_ref().is_some_and(|a| a.before.is_some());
        let freed = if recording {
            0
        } else {
            self.scratch_backdrop.as_ref().map_or(0, |s| s.bytes)
        };
        let bytes = need_w as usize * need_h as usize * 4;
        self.reserve_or_trim(bytes, freed, "a blend backdrop buffer")?;
        if let Some(old) = self.scratch_backdrop.take() {
            if recording {
                self.retired_textures.push((old.tex, old.bytes));
            } else {
                self.pool_bytes = self.pool_bytes.saturating_sub(old.bytes);
                old.tex.destroy();
            }
        }
        let tex = texture(
            &self.device,
            need_w,
            need_h,
            wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            "blend backdrop scratch",
        );
        let view = tex.create_view(&Default::default());
        self.pool_bytes += bytes;
        self.scratch_backdrop = Some(GpuBlurScratch {
            tex,
            view,
            view_id: crate::blend::gpu::next_view_id(),
            width: need_w,
            height: need_h,
            bytes,
        });
        Ok(())
    }

    /// The device's health: an error recorded since the last call, or its loss.
    pub fn check(&self) -> Result<()> {
        #[cfg(feature = "webgl")]
        {
            if let Err(e) = self.device.poll(wgpu::PollType::Poll) {
                self.health.fail_poll(format!("GPU poll failed: {e}"));
            }
        }
        if self.health.lost.load(Ordering::SeqCst) {
            let reason = self.health.lost_reason.lock().map(|r| r.clone()).unwrap_or_default();
            return Err(EngineError::new(
                ErrorCode::DeviceLost,
                format!("the GPU device was lost ({reason})"),
            ));
        }
        #[cfg(feature = "webgl")]
        if let Ok(mut pe) = self.health.poll_error.lock()
            && let Some(msg) = pe.take()
        {
            return Err(EngineError::new(ErrorCode::Gpu, msg));
        }
        if let Ok(mut list) = self.health.errors.lock()
            && !list.is_empty()
        {
            let code = if list.iter().any(|(code, _)| *code == ErrorCode::Limit) {
                ErrorCode::Limit
            } else {
                ErrorCode::Gpu
            };
            let all = list
                .drain(..)
                .map(|(_, message)| message)
                .collect::<Vec<_>>()
                .join("; ");
            return Err(EngineError::new(code, all));
        }
        Ok(())
    }

    pub fn put_image(&mut self, id: u32, levels: &[Level], budget: usize) -> Result<()> {
        for l in levels {
            self.check_texture_size(l.width, l.height, "an image")?;
        }
        let bytes = images::bytes(levels);
        let freed: usize = self
            .images
            .get(&id)
            .map_or(0, |l| l.iter().map(|(_, _, w, h)| (*w * *h * 4) as usize).sum());
        if self.image_bytes - freed + bytes > budget {
            return Err(EngineError::limit("images over their budget"));
        }
        self.reserve(bytes, freed, "an image")?;
        self.drop_image(id);
        let mut out = Vec::new();
        for (i, l) in levels.iter().enumerate() {
            let tex = texture(
                &self.device,
                l.width,
                l.height,
                wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
                "image",
            );
            write(&self.queue, &tex, 0, 0, l.width, l.height, &l.pixels);
            let tid = TextureId((u64::from(id) << 8) | i as u64);
            self.bindings.insert(tid, tex.create_view(&Default::default()));
            out.push((tid, tex, l.width, l.height));
        }
        self.images.insert(id, out);
        self.image_bytes += bytes;
        self.bytes += bytes;
        Ok(())
    }

    #[cfg(target_arch = "wasm32")]
    pub fn put_image_bitmap(&mut self, id: u32, bitmap: &web_sys::ImageBitmap, budget: usize) -> Result<()> {
        let (width, height) = (bitmap.width(), bitmap.height());
        self.check_texture_size(width, height, "an image")?;
        let bytes = width as usize * height as usize * 4;
        let freed = self
            .images
            .get(&id)
            .and_then(|levels| levels.iter().find(|(_, _, w, _)| *w == width))
            .map_or(0, |(_, _, w, h)| (*w * *h * 4) as usize);
        if self.image_bytes - freed + bytes > budget {
            return Err(EngineError::limit("images over their budget"));
        }
        self.reserve_or_trim(bytes, freed, "an image")?;
        self.drop_image_level(id, width);
        let tex = texture(
            &self.device,
            width,
            height,
            wgpu::TextureUsages::TEXTURE_BINDING
                | wgpu::TextureUsages::COPY_DST
                | wgpu::TextureUsages::RENDER_ATTACHMENT,
            "resident image",
        );
        // The WebGPU queue copies the bitmap directly. wgpu's WebGL queue uses
        // the ImageBitmap overload of texSubImage2D on its own context.
        let webgl = self.backend == "webgl2";
        self.queue.copy_external_image_to_texture(
            &wgpu::CopyExternalImageSourceInfo {
                source: wgpu::ExternalImageSource::ImageBitmap(bitmap.clone()),
                origin: wgpu::Origin2d::ZERO,
                flip_y: false,
            },
            wgpu::CopyExternalImageDestInfo {
                texture: &tex,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
                color_space: wgpu::PredefinedColorSpace::Srgb,
                // WebGL uses the bitmap's own premultiplication and rejects converting it.
                premultiplied_alpha: !webgl,
            },
            wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
        );
        if webgl {
            // wgpu records bitmap copies until the next submit. Execute this one
            // before the caller closes its source bitmap.
            self.queue.submit([]);
        }
        let tid = TextureId((1 << 50) | (u64::from(id) << 16) | u64::from(width));
        self.bindings.insert(tid, tex.create_view(&Default::default()));
        let levels = self.images.entry(id).or_default();
        let at = levels.partition_point(|(_, _, w, _)| *w > width);
        levels.insert(at, (tid, tex, width, height));
        self.image_bytes += bytes;
        self.bytes += bytes;
        Ok(())
    }

    /// Uploads rows `y..y + rows` of `bitmap`, an image level, so a large one spreads over
    /// frames: the first rows (`y` 0) make its texture, within `budget`, and rows must follow in
    /// order. Once its last rows are in, the level is resident (true), in place of one of its
    /// width; until then it's drawn with the levels there were, that one included, so both count
    /// against the budget meanwhile.
    #[cfg(target_arch = "wasm32")]
    pub fn put_image_bitmap_rows(
        &mut self,
        id: u32,
        bitmap: &web_sys::ImageBitmap,
        y: u32,
        rows: u32,
        budget: usize,
    ) -> Result<bool> {
        let (width, height) = (bitmap.width(), bitmap.height());
        let pending = self.pending_images.get(&(id, width));
        let start = crate::images::strip_step(pending.map(|p| (&p.source, p.height, p.next)), bitmap, height, y, rows)?;
        if start {
            self.drop_pending_image(id, width);
            self.check_texture_size(width, height, "an image")?;
            let bytes = width as usize * height as usize * 4;
            if self.image_bytes + bytes > budget {
                return Err(EngineError::limit("images over their budget"));
            }
            self.reserve_or_trim(bytes, 0, "an image")?;
            let tex = texture(
                &self.device,
                width,
                height,
                wgpu::TextureUsages::TEXTURE_BINDING
                    | wgpu::TextureUsages::COPY_DST
                    | wgpu::TextureUsages::RENDER_ATTACHMENT,
                "resident image",
            );
            self.image_bytes += bytes;
            self.bytes += bytes;
            self.pending_images.insert(
                (id, width),
                PendingImage {
                    tex,
                    height,
                    next: 0,
                    source: bitmap.clone(),
                },
            );
        }
        let Some(pending) = self.pending_images.get_mut(&(id, width)) else {
            return Err(EngineError::new(
                ErrorCode::State,
                "image rows before the level's first",
            ));
        };
        let webgl = self.backend == "webgl2";
        self.queue.copy_external_image_to_texture(
            &wgpu::CopyExternalImageSourceInfo {
                source: wgpu::ExternalImageSource::ImageBitmap(bitmap.clone()),
                origin: wgpu::Origin2d { x: 0, y },
                flip_y: false,
            },
            wgpu::CopyExternalImageDestInfo {
                texture: &pending.tex,
                mip_level: 0,
                origin: wgpu::Origin3d { x: 0, y, z: 0 },
                aspect: wgpu::TextureAspect::All,
                color_space: wgpu::PredefinedColorSpace::Srgb,
                premultiplied_alpha: !webgl,
            },
            wgpu::Extent3d {
                width,
                height: rows,
                depth_or_array_layers: 1,
            },
        );
        if webgl {
            // Executed before the caller closes its source bitmap (see `put_image_bitmap`).
            self.queue.submit([]);
        }
        pending.next += rows;
        if pending.next < height {
            return Ok(false);
        }
        let Some(done) = self.pending_images.remove(&(id, width)) else {
            return Ok(false);
        };
        // The level it replaces goes now, never before: what's drawn never has less.
        self.drop_image_level(id, width);
        let tid = TextureId((1 << 50) | (u64::from(id) << 16) | u64::from(width));
        self.bindings.insert(tid, done.tex.create_view(&Default::default()));
        let levels = self.images.entry(id).or_default();
        let at = levels.partition_point(|(_, _, w, _)| *w > width);
        levels.insert(at, (tid, done.tex, width, height));
        Ok(true)
    }

    /// The images with a level being uploaded in strips.
    pub fn uploading(&self) -> Vec<u32> {
        self.pending_images.keys().map(|&(id, _)| id).collect()
    }

    /// Drops a level being uploaded in strips, with its budget (the level it would replace
    /// stays).
    pub fn drop_pending_image(&mut self, id: u32, width: u32) {
        if let Some(p) = self.pending_images.remove(&(id, width)) {
            let bytes = width as usize * p.height as usize * 4;
            self.image_bytes -= bytes;
            self.bytes -= bytes;
            p.tex.destroy();
        }
    }

    pub fn image_sizes(&self, id: u32) -> Vec<(u32, u32)> {
        self.images
            .get(&id)
            .into_iter()
            .flatten()
            .map(|level| (level.2, level.3))
            .collect()
    }

    pub fn drop_image_level(&mut self, id: u32, width: u32) {
        self.drop_pending_image(id, width);
        if let Some(levels) = self.images.get_mut(&id) {
            if let Some(at) = levels.iter().position(|(_, _, w, _)| *w == width) {
                let (tid, tex, w, h) = levels.remove(at);
                self.bindings.remove(tid);
                let bytes = (w * h * 4) as usize;
                self.image_bytes -= bytes;
                self.bytes -= bytes;
                tex.destroy();
            }
            if levels.is_empty() {
                self.images.remove(&id);
            }
        }
    }

    pub fn drop_image(&mut self, id: u32) {
        let pending: Vec<u32> = self
            .pending_images
            .keys()
            .filter(|(i, _)| *i == id)
            .map(|(_, w)| *w)
            .collect();
        for width in pending {
            self.drop_pending_image(id, width);
        }
        if let Some(levels) = self.images.remove(&id) {
            for (tid, tex, w, h) in levels {
                self.bindings.remove(tid);
                self.image_bytes -= (w * h * 4) as usize;
                self.bytes -= (w * h * 4) as usize;
                tex.destroy();
            }
        }
    }

    fn next_frame(&self) -> usize {
        self.cur.map_or(0, |cur| (cur + 1) % FRAMES)
    }

    fn frame_bytes(width: u32, height: u32) -> usize {
        width as usize * height as usize * 4
    }

    #[inline(never)]
    fn check_frame(&self, dst: usize, width: u32, height: u32, work: usize, freed: usize) -> Result<()> {
        self.check_texture_size(width, height, "a frame")?;
        let bytes = Self::frame_bytes(width, height);
        let previous = self.frames.get(dst).map_or(0, |m| Self::frame_bytes(m.width, m.height));
        let surface = if self.surface.is_some() {
            (2 * bytes).saturating_sub(self.surface_bytes)
        } else {
            0
        };
        self.reserve(
            bytes.saturating_add(surface).saturating_add(work),
            previous.saturating_add(freed),
            "a frame and its working textures",
        )
    }

    /// Resize only the back buffer. The last frame and canvas are committed by finish_frame.
    fn ensure_frame(&mut self, dst: usize, width: u32, height: u32) -> Result<()> {
        if self
            .frames
            .get(dst)
            .is_some_and(|m| m.width == width && m.height == height)
        {
            return Ok(());
        }
        if self.check_frame(dst, width, height, 0, 0).is_err() {
            if self.pool_bytes > 0 && self.check_frame(dst, width, height, 0, self.pool_bytes).is_ok() {
                self.trim_pools(0);
            }
            self.check_frame(dst, width, height, 0, 0)?;
        }
        if let Some(old) = self.frames.get(dst) {
            old.texture.destroy();
        }
        #[cfg(feature = "compute")]
        let usage = wgpu::TextureUsages::RENDER_ATTACHMENT
            | wgpu::TextureUsages::TEXTURE_BINDING
            | wgpu::TextureUsages::STORAGE_BINDING
            | wgpu::TextureUsages::COPY_SRC
            | wgpu::TextureUsages::COPY_DST;
        #[cfg(not(feature = "compute"))]
        let usage = wgpu::TextureUsages::RENDER_ATTACHMENT
            | wgpu::TextureUsages::TEXTURE_BINDING
            | wgpu::TextureUsages::COPY_SRC
            | wgpu::TextureUsages::COPY_DST;
        let tex = texture(&self.device, width, height, usage, "frame");
        let view = tex.create_view(&Default::default());
        #[cfg(feature = "compute")]
        let view_id = {
            let id = self.next_frame_view_id;
            self.next_frame_view_id = id.wrapping_add(1);
            id
        };
        let present_group = self.blit.as_ref().map(|blit| {
            self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("present"),
                layout: &blit.get_bind_group_layout(0),
                entries: &[wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&view),
                }],
            })
        });
        let composite_group = self
            .compositor
            .as_ref()
            .map(|c| c.create_bind_group(&self.device, &view, "composite frame"));
        let frame = Main {
            view,
            tex_view_id: crate::blend::gpu::next_view_id(),
            #[cfg(feature = "compute")]
            view_id,
            texture: tex,
            present_group,
            composite_group,
            width,
            height,
        };
        self.bytes += Self::frame_bytes(width, height);
        if dst < self.frames.len() {
            let old = std::mem::replace(&mut self.frames[dst], frame);
            self.bytes -= Self::frame_bytes(old.width, old.height);
        } else {
            self.frames.push(frame);
        }
        Ok(())
    }

    fn configure_surface(&mut self, frame: usize) -> Result<()> {
        let target = &self.frames[frame];
        let (width, height) = (target.width, target.height);
        let Some((_, config)) = self.surface.as_ref() else {
            return Ok(());
        };
        if (config.width, config.height) == (width, height) && self.surface_bytes != 0 {
            return Ok(());
        }
        let bytes = 2 * Self::frame_bytes(width, height);
        self.reserve(bytes, self.surface_bytes, "the presentation surface")?;
        let (surface, config) = self.surface.as_mut().expect("surface");
        config.width = width;
        config.height = height;
        surface.configure(&self.device, config);
        self.bytes = self.bytes - self.surface_bytes + bytes;
        self.surface_bytes = bytes;
        Ok(())
    }

    /// The frame shown now (presented or read back).
    fn current(&self) -> Result<&Main> {
        self.cur
            .and_then(|cur| self.frames.get(cur))
            .ok_or_else(|| EngineError::new(ErrorCode::State, "nothing drawn on the GPU yet"))
    }

    /// The canvas's texture for this frame, reconfiguring once if the canvas changed under it.
    /// A failure is the frame's: `Lost` and `Validation` say the canvas can't present; `Timeout`
    /// and `Occluded` that it can't now (None: nothing presented, nothing wrong).
    fn acquire(&mut self) -> Result<Option<wgpu::SurfaceTexture>> {
        let Some((surface, config)) = self.surface.as_ref() else {
            return Ok(None);
        };
        let mut out = surface.get_current_texture();
        if matches!(out, wgpu::CurrentSurfaceTexture::Outdated) {
            surface.configure(&self.device, config);
            out = surface.get_current_texture();
        }
        match out {
            wgpu::CurrentSurfaceTexture::Success(t) => Ok(Some(t)),
            wgpu::CurrentSurfaceTexture::Suboptimal(t) => {
                // Presented as it is; configured afresh for the next frame.
                surface.configure(&self.device, config);
                Ok(Some(t))
            }
            wgpu::CurrentSurfaceTexture::Timeout | wgpu::CurrentSurfaceTexture::Occluded => Ok(None),
            other => Err(EngineError::new(
                ErrorCode::Gpu,
                format!(
                    "the canvas couldn't take a frame ({})",
                    match other {
                        wgpu::CurrentSurfaceTexture::Outdated => "its surface stayed outdated",
                        wgpu::CurrentSurfaceTexture::Lost => "its surface was lost",
                        _ => "a validation error",
                    }
                ),
            )),
        }
    }

    /// Discards any cooperatively paused mid-tile walk and releases its temporary reader state.
    fn abort_pending_tile(&mut self) {
        if self.pending_tile.take().is_some() {
            self.drop_walk();
        }
    }

    /// The inputs a draw spread over slices checks before each slice (`DrawInputs`).
    fn inputs(store: &Store, generation: u64, background: [f32; 4]) -> DrawInputs {
        DrawInputs {
            generation,
            bg_bits: background.map(f32::to_bits),
            limits: store.limits,
        }
    }

    /// Whether a walk is paused: a tile's, a whole frame's, or a wide-blur capture's, holding its
    /// scratch, target and glass mask atlas until it resumes.
    fn walk_paused(&self) -> bool {
        self.pending_tile.is_some()
            || self.pending_whole.as_ref().is_some_and(PendingWhole::paused)
            || matches!(
                self.wide_blur.as_ref(),
                Some(WideBlurState::Building(b)) if b.pass.as_ref().is_some_and(|p| p.paused.is_some())
            )
    }

    /// Pauses the active walk at `checkpoint`: flushes and submits what it drew, and takes its
    /// target along (`PausedWalk`), so a later slice resumes it where it stopped.
    fn pause_walk(
        &mut self,
        checkpoint: Option<exec::WalkCheckpoint>,
        stats: &mut DrawStats,
        t0: f64,
    ) -> Result<PausedWalk> {
        let sub0 = stats.submit_ms;
        self.flush_why = 5;
        if let Err(e) = self.flush_scene_gpu(true) {
            self.discard_draw();
            self.readers.drop_glass_mask_atlas();
            return Err(e);
        }
        self.submit_active_encoder();
        let mut active = self.active.take().expect("active draw");
        self.recycle_scene_textures();
        self.scene.reset();
        let slice_total = now() - t0;
        active.record_and_reset_slice(stats, slice_total);
        // A slice's submit counts against the next slices' walk budget.
        self.update_submit_ratio(slice_total, stats.submit_ms - sub0);
        self.counters.pauses = self.counters.pauses.wrapping_add(1);
        Ok(PausedWalk {
            active,
            scratch: self.active_scratch,
            backdrop_gen: self.backdrop_gen,
            backdrop_blur_written: self.backdrop_blur_written,
            checkpoint,
        })
    }

    /// Gives a paused walk its target back for another slice (a `size` scene); answers where it
    /// resumes.
    fn resume_walk(&mut self, paused: PausedWalk, size: (u16, u16)) -> Option<exec::WalkCheckpoint> {
        self.active_scratch = paused.scratch;
        self.backdrop_gen = paused.backdrop_gen;
        self.backdrop_blur_written = paused.backdrop_blur_written;
        self.active = Some(paused.active);
        self.masks.begin_frame();
        self.readers.begin_frame();
        self.atlas.at = (0, 0, 0);
        self.scene.reset_and_resize(size.0, size.1);
        paused.checkpoint
    }

    /// Drops what a paused walk held (its target went with it): its glass masks, clip masks and scene.
    fn drop_walk(&mut self) {
        self.clear_clip_mask_cache();
        self.readers.drop_glass_mask_atlas();
        self.readers.flush_retired();
        self.scene.reset();
    }

    /// Notes that GPU work was submitted for a frame or an idle slice: the GPU says when it has
    /// finished it (`gpu_behind`).
    fn note_submitted(&mut self) {
        let seq = self.gpu_sent.submitted(now());
        let done = self.gpu_done.clone();
        self.queue.on_submitted_work_done(move || {
            done.fetch_max(seq, Ordering::SeqCst);
        });
    }

    /// Whether the GPU still has more than `in_flight` of the last frames' (or idle slices')
    /// work to finish: new tile work would only queue behind it, and input behind that. On
    /// WebGL2 `check` polls first.
    /// Back-pressure gives up when the oldest submission not known done is `pacing::GIVE_UP_MS`
    /// old: newer submissions (a stand-in presented each frame) never renew it, so silence from
    /// the GPU can't hold tile work back for a whole gesture.
    fn gpu_behind(&mut self, in_flight: u64) -> bool {
        let done = self.gpu_done.load(Ordering::SeqCst);
        self.gpu_sent.behind(done, in_flight, now())
    }

    /// Counts GPU passes an op runs beside its Vello renders (kernel passes), toward the
    /// moving pass cap (`MOVING_PASSES`).
    fn note_passes(&mut self, n: u32) {
        self.passes = self.passes.wrapping_add(n);
    }

    /// The page's shown content (page units), for the overview.
    fn page_bounds(store: &Store) -> Option<Rect> {
        store.bounds(crate::store::ROOT)
    }

    /// Forgets the frame shown as a stand-in (after a fresh list: it shows a page that's gone).
    pub fn forget_last(&mut self) {
        self.abort_pending_tile();
        self.abort_pending_whole();
        self.abort_wide_blur();
        self.opening_pending = false;
        self.last = None;
        self.last_scale = None;
        self.shown = None;
        self.direct_slices = None;
        self.set_cur_page(false);
    }

    /// Whether `frames[cur]` holds a frame of the page loaded now (`cur_page`).
    #[inline]
    fn set_cur_page(&mut self, drawn: bool) {
        #[cfg(feature = "compute")]
        {
            self.cur_page = drawn;
        }
        #[cfg(not(feature = "compute"))]
        let _ = drawn;
    }

    /// Drops every tile (benches and tests time cold frames this way).
    pub fn clear_tiles(&mut self) {
        self.abort_pending_whole();
        self.abort_pending_tile();
        self.abort_wide_blur();
        self.clear_clip_mask_cache();
        self.opening_pending = false;
        self.tiles.clear();
        self.drop_overview_page();
        self.shown = None;
    }

    pub fn clear_view_caches(&mut self) {
        // Every tile goes but the overview's, a few MiB that a zoom out stands on.
        self.abort_pending_whole();
        self.abort_pending_tile();
        self.abort_wide_blur();
        self.opening_pending = false;
        self.tiles.clear_keeping_overview();
        self.shown = None;
        self.fit_tiles(0);
        // `forget_last` also forgets that `frames[cur]` was this page's.
        self.forget_last();
        self.forget_motion_prefix();
        self.trim_pools(0);
        self.readers.evict_frame_scratch();
        self.blur.clear();
        self.masks.clear();
        for scratch in self.scratches.iter_mut().filter_map(Option::take) {
            scratch.texture.destroy();
            self.bytes -= scratch.width as usize * scratch.height as usize * 8;
        }
        #[cfg(feature = "compute")]
        {
            self.pending_compute = None;
            self.new_compute_epoch();
            if let Some(c) = self.compute.as_mut() {
                c.reset();
            }
        }
    }

    /// Gated frames still in flight no longer show on the canvas: something else was drawn or
    /// presented over them. Their checks still settle (growth, errors) but never report exact.
    #[cfg(feature = "compute")]
    fn gates_off_screen(&mut self) {
        for gate in &mut self.pending_gates {
            gate.on_screen = false;
        }
    }

    /// Compute's buffers and grown capacities went (a fresh page, a reset, a change of buffer
    /// policy): checks still in flight describe buffers that are gone, so they may not grow the
    /// new ones.
    #[cfg(feature = "compute")]
    fn new_compute_epoch(&mut self) {
        self.gates_off_screen();
        self.compute_epoch += 1;
        self.gate_overflows = 0;
    }

    #[cfg(feature = "compute")]
    pub fn supports_compute(&self) -> bool {
        let l = self.device.limits();
        l.max_storage_buffers_per_shader_stage >= 8 && l.max_compute_workgroup_storage_size >= 16384
    }

    #[cfg(feature = "compute")]
    pub fn set_compute_ordinary(&mut self, enabled: bool) {
        self.compute_ordinary = enabled;
        if !enabled {
            self.pending_compute = None;
            self.last_compute_used = false;
            self.new_compute_epoch();
            if let Some(c) = self.compute.as_mut() {
                c.reset();
            }
        }
    }

    #[cfg(feature = "compute")]
    pub fn compute_reset_stats(&mut self) {
        if let Some(c) = self.compute.as_mut() {
            c.reset_stats();
        }
    }

    /// A fresh list (a page switch or a reset): what the last page's frames needed says nothing
    /// about this one, so its buffers and grown capacities go.
    #[cfg(feature = "compute")]
    pub fn compute_page_reset(&mut self) {
        self.pending_compute = None;
        self.cur_page = false;
        self.new_compute_epoch();
        self.ordinary_revision = None;
        if let Some(c) = self.compute.as_mut() {
            c.reset();
        }
    }

    /// After a message: a fresh list drops everything (`compute_page_reset`), a no-op keeps the
    /// retained compute encoding, and one that only moved records patches its transforms in place
    /// (`compute_moves`); either way the cached ordinary-page answer carries over, since neither
    /// changes what a page holds.
    #[cfg(feature = "compute")]
    pub fn compute_applied(&mut self, from: u32, store: &Store, applied: &crate::store::Applied, generation: u64) {
        if applied.full {
            self.compute_page_reset();
            return;
        }
        let Some(compute) = self.compute.as_mut() else {
            return;
        };
        let kept = if applied.noop {
            compute.adopt_revision(from, store.revision);
            true
        } else if let Some(moved) = applied.moved.as_deref() {
            compute.apply_moves(&self.queue, store, from, generation, moved)
        } else {
            false
        };
        if kept
            && let Some((revision, ordinary)) = self.ordinary_revision
            && revision == from
        {
            self.ordinary_revision = Some((store.revision, ordinary));
        }
    }

    /// Starts compute frames from minimal buffers (or the usual ones), for the diagnostics'
    /// capacity matrix.
    #[cfg(feature = "compute")]
    pub fn compute_tight(&mut self, tight: bool) {
        self.compute_tight = tight;
        self.pending_compute = None;
        self.new_compute_epoch();
        if let Some(c) = self.compute.as_mut() {
            c.set_tight(tight);
        }
    }

    #[cfg(feature = "compute")]
    pub fn compute_stats_json(&self) -> Result<String> {
        self.compute
            .as_ref()
            .map(crate::vello_compute::VelloCompute::stats_json)
            .ok_or_else(|| EngineError::new(ErrorCode::State, "the compute pipeline has not run yet"))
    }

    #[cfg(feature = "compute")]
    pub fn stage_compute(
        &mut self,
        store: &Store,
        frame: &Frame,
        background: [f32; 4],
        generation: u64,
    ) -> Result<ComputeCheck> {
        self.check()?;
        self.pending_compute = None;
        self.last_compute_used = false;
        self.gates_off_screen();
        let (width, height) = (u32::from(frame.width), u32::from(frame.height));
        let dst = self.next_frame();
        let validation = self.device.push_error_scope(wgpu::ErrorFilter::Validation);
        let memory = self.device.push_error_scope(wgpu::ErrorFilter::OutOfMemory);
        let internal = self.device.push_error_scope(wgpu::ErrorFilter::Internal);
        self.ensure_frame(dst, width, height)?;
        let existing = self.compute.as_ref().map_or(0, |c| c.gpu_bytes());
        let working_budget = self.budget.saturating_sub(
            self.bytes()
                .saturating_sub(existing)
                .saturating_add(self.readbacks.bytes.get()),
        );
        let tight = self.compute_tight;
        let pipeline = self.compute.get_or_insert_with(|| {
            let mut pipeline = crate::vello_compute::VelloCompute::new(&self.device, &self.queue, self.timestamp_query);
            pipeline.set_tight(tight);
            pipeline
        });
        let main = &self.frames[dst];
        let (stats, diagnostic) = pipeline.render_into(
            &self.device,
            &self.queue,
            store,
            generation,
            width,
            height,
            frame.view,
            background,
            dst,
            main.view_id,
            &main.view,
            None,
            working_budget as u64,
        )?;
        let internal = internal.pop();
        let memory = memory.pop();
        let validation = validation.pop();
        let result = Rc::new(std::cell::RefCell::new(None));
        self.pending_compute = Some(PendingCompute {
            result: result.clone(),
            generation,
            dst,
            last: Last {
                view: frame.view,
                size: (width, height),
            },
            background: background.map(f32::to_bits),
            stats,
        });
        let device = self.device.clone();
        let health = self.health.clone();
        Ok(Box::pin(async move {
            let diagnostic = match diagnostic {
                Some(item) => crate::vello_compute::verify_compute_frame(&device, &health, item)
                    .await
                    .map(Some),
                None => Ok(None),
            };
            let error = internal.await.or(memory.await).or(validation.await);
            let result_value = match (health.stop_error(), error) {
                (Some(error), _) => Err(error),
                (None, Some(error)) => Err(EngineError::new(ErrorCode::Gpu, error.to_string())),
                (None, None) => diagnostic,
            };
            *result.borrow_mut() = Some(result_value);
        }))
    }

    /// Draws a compute frame and presents it at once, through the bump gate: the GPU itself keeps
    /// the frame on screen wherever a stage overflowed, so nothing overflowed is ever shown and
    /// presenting never waits for a read-back. Checks that landed since the last call are settled
    /// first (`finish_gate`), so growth keeps up with continuous motion. Needs a frame of this
    /// size on screen to keep (`GatePresent::Stage` otherwise), and at most `GATES_IN_FLIGHT`
    /// checks in flight (`GatePresent::Busy` otherwise: none is ever dropped).
    ///
    /// What the canvas shows is unknown until the frame's check lands (the gate may have kept
    /// the older pixels), so nothing reuses it as the last frame until `finish_gate` says so.
    #[cfg(feature = "compute")]
    pub fn present_compute(
        &mut self,
        store: &Store,
        frame: &Frame,
        background: [f32; 4],
        generation: u64,
    ) -> Result<GatePresent> {
        self.check()?;
        if matches!(self.finish_gate(generation)?, GateFinish::Fallback) || self.compute_reason.is_some() {
            return Ok(GatePresent::Stage);
        }
        if self.pending_gates.len() >= GATES_IN_FLIGHT {
            return Ok(GatePresent::Busy);
        }
        let (width, height) = (u32::from(frame.width), u32::from(frame.height));
        // The gate keeps what `frames[cur]` shows wherever a stage overflows: that has to be a
        // frame of this page and this size.
        let Some(cur) = self.cur.filter(|&c| {
            self.cur_page
                && self
                    .frames
                    .get(c)
                    .is_some_and(|m| m.width == width && m.height == height)
        }) else {
            return Ok(GatePresent::Stage);
        };
        self.pending_compute = None;
        let validation = self.device.push_error_scope(wgpu::ErrorFilter::Validation);
        let memory = self.device.push_error_scope(wgpu::ErrorFilter::OutOfMemory);
        let internal = self.device.push_error_scope(wgpu::ErrorFilter::Internal);
        let existing = self.compute.as_ref().map_or(0, |c| c.gpu_bytes());
        let working_budget = self.budget.saturating_sub(
            self.bytes()
                .saturating_sub(existing)
                .saturating_add(self.readbacks.bytes.get()),
        );
        let tight = self.compute_tight;
        let pipeline = self.compute.get_or_insert_with(|| {
            let mut pipeline = crate::vello_compute::VelloCompute::new(&self.device, &self.queue, self.timestamp_query);
            pipeline.set_tight(tight);
            pipeline
        });
        let drawn = pipeline.render_gated(
            &self.device,
            &self.queue,
            store,
            generation,
            width,
            height,
            frame.view,
            background,
            &self.frames[cur].view,
            FORMAT,
            working_budget as u64,
        );
        // Pop the scopes whatever happened, so a refusal doesn't leave them pushed.
        let internal = internal.pop();
        let memory = memory.pop();
        let validation = validation.pop();
        let (c, diagnostic) = drawn?;
        let t0 = now();
        let submits0 = self.submits;
        self.submits += 1;
        let mut stats = self.finish_frame(
            cur,
            DrawStats {
                direct: true,
                plan: 2,
                exact: false,
                standin: false,
                glyphs_outlined: c.glyphs,
                encode_ms: c.encode_ms,
                render_ms: c.render_ms,
                ..DrawStats::default()
            },
            t0,
            submits0,
            None,
        )?;
        stats.submit_ms += c.submit_ms;
        stats.cpu_ms += c.cpu_ms;
        // Only the newest gated frame can be the one on screen.
        self.gates_off_screen();
        let result = Rc::new(std::cell::RefCell::new(None));
        self.pending_gates.push_back(PendingGate {
            result: result.clone(),
            generation,
            last: Last {
                view: frame.view,
                size: (width, height),
            },
            background: background.map(f32::to_bits),
            on_screen: true,
            epoch: self.compute_epoch,
            growths: self.gate_growths,
        });
        self.last = None;
        self.last_scale = None;
        self.shown = None;
        self.last_compute_used = true;
        let device = self.device.clone();
        let health = self.health.clone();
        let check: ComputeCheck = Box::pin(async move {
            let diagnostic = match diagnostic {
                Some(item) => crate::vello_compute::verify_compute_frame(&device, &health, item)
                    .await
                    .map(Some),
                None => Ok(None),
            };
            let error = internal.await.or(memory.await).or(validation.await);
            let value = match (health.stop_error(), error) {
                (Some(error), _) => Err(error),
                (None, Some(error)) => Err(EngineError::new(ErrorCode::Gpu, error.to_string())),
                (None, None) => diagnostic,
            };
            *result.borrow_mut() = Some(value);
        });
        Ok(GatePresent::Presented(stats, check))
    }

    /// Settles every gated frame whose check has landed, oldest first. An error or a lost device
    /// turns compute off. An overflow grows the buffers; if that frame was the one on screen,
    /// the gate kept older pixels there, so `Redraw`. The newest frame on screen is exact once
    /// its check lands clean (`Verified`), and only then is it the last frame. Gated frames that
    /// keep overflowing after the buffers grew turn compute off, as six draws of one staged frame
    /// do. `Pending` when nothing on screen was settled.
    #[cfg(feature = "compute")]
    pub fn finish_gate(&mut self, generation: u64) -> Result<GateFinish> {
        let mut verdict = GateFinish::Pending;
        while let Some(front) = self.pending_gates.front() {
            let landed = front.result.borrow_mut().take();
            let Some(landed) = landed else { break };
            let gated = self.pending_gates.pop_front().expect("front");
            let diagnostic = match landed {
                Ok(diagnostic) => diagnostic,
                Err(error) => {
                    // The gate never showed bad pixels, but a GPU error stops compute.
                    self.disable_compute(format!("a compute frame failed its GPU check: {}", error.message));
                    if error.code == ErrorCode::DeviceLost {
                        return Err(error);
                    }
                    return Ok(GateFinish::Fallback);
                }
            };
            let current = gated.epoch == self.compute_epoch;
            let over = match (diagnostic, self.compute.as_mut()) {
                (Some(d), Some(compute)) if current => {
                    matches!(compute.check_frame(d), crate::vello_compute::FrameCheck::Overflow(_))
                }
                (Some(d), Some(compute)) => {
                    compute.discard_diagnostic(d);
                    false
                }
                (Some(d), None) => {
                    d.discard();
                    false
                }
                (None, _) => false,
            };
            if over {
                if gated.growths == self.gate_growths {
                    self.gate_overflows += 1;
                }
                self.gate_growths += 1;
                if self.gate_overflows >= GATE_OVERFLOWS_MAX {
                    self.disable_compute(format!(
                        "{GATE_OVERFLOWS_MAX} gated compute frames in a row overflowed after their buffers grew"
                    ));
                    return Ok(GateFinish::Fallback);
                }
                if gated.on_screen {
                    verdict = GateFinish::Redraw;
                }
            } else {
                if current {
                    self.gate_overflows = 0;
                }
                if gated.on_screen {
                    self.last_scale = Some(gated.last.view.as_coeffs()[0]);
                    self.last = Some(gated.last);
                    if gated.generation == generation {
                        self.set_shown(gated.generation, gated.background, true);
                    }
                    verdict = GateFinish::Verified;
                }
            }
        }
        Ok(verdict)
    }

    /// Shows a staged compute frame once its check has come back, or says why not. A frame
    /// whose check found an overflow, an error or a lost device is never presented.
    #[cfg(feature = "compute")]
    pub fn finish_compute(&mut self, generation: u64, final_attempt: bool) -> Result<ComputeFinish> {
        let Some(staged) = self.pending_compute.take() else {
            return Ok(ComputeFinish::Stale);
        };
        // A frame of an earlier generation (an edit landed while it was checked) is still a
        // correct picture of that page, so it may be shown while the current one is drawn, but
        // it isn't exact for the page as it is now.
        let current = staged.generation == generation;
        let verified = staged.result.borrow_mut().take();
        let Some(verified) = verified else {
            // Not checked yet: the caller asked too early. Keep it.
            self.pending_compute = Some(staged);
            return Ok(ComputeFinish::Stale);
        };
        let diagnostic = match verified {
            Ok(diagnostic) => diagnostic,
            Err(error) => {
                self.disable_compute(format!("a compute frame failed its GPU check: {}", error.message));
                if error.code == ErrorCode::DeviceLost {
                    return Err(error);
                }
                return Ok(ComputeFinish::Fallback);
            }
        };
        if let Some(diagnostic) = diagnostic {
            let compute = self.compute.as_mut().expect("staged compute pipeline");
            if let crate::vello_compute::FrameCheck::Overflow(stages) = compute.check_frame(diagnostic) {
                if final_attempt {
                    self.disable_compute(format!(
                        "compute buffers still overflowed (stages {stages:#x}) after growing"
                    ));
                    return Ok(ComputeFinish::Fallback);
                }
                return Ok(ComputeFinish::Retry);
            }
        }

        let c = staged.stats;
        let t0 = now();
        // The staged draw was one submit; presenting may add another.
        let submits0 = self.submits;
        self.submits += 1;
        let mut stats = self.finish_frame(
            staged.dst,
            DrawStats {
                direct: true,
                plan: 2,
                exact: current,
                standin: !current,
                glyphs_outlined: c.glyphs,
                encode_ms: c.encode_ms,
                render_ms: c.render_ms,
                ..DrawStats::default()
            },
            t0,
            submits0,
            None,
        )?;
        stats.submit_ms += c.submit_ms;
        stats.cpu_ms += c.cpu_ms;
        if stats.presented {
            self.cur = Some(staged.dst);
            // Frame indices come round again (`FRAMES`): a sliced frame never goes on from this.
            self.direct_slices = None;
            self.cur_page = true;
            self.last_scale = Some(staged.last.view.as_coeffs()[0]);
            self.last = Some(staged.last);
            self.set_shown(staged.generation, staged.background, true);
            self.last_compute_used = true;
        }
        Ok(ComputeFinish::Frame(stats))
    }

    #[cfg(feature = "compute")]
    pub fn cancel_compute_frame(&mut self) {
        self.pending_compute = None;
        self.gates_off_screen();
    }

    #[cfg(feature = "compute")]
    pub fn disable_compute(&mut self, reason: String) {
        self.compute_reason = Some(reason);
        self.pending_compute = None;
        self.pending_gates.clear();
        self.compute = None;
        self.last_compute_used = false;
    }

    fn per_row(&self) -> u32 {
        (self.page_side / TILE).max(1)
    }

    fn per_page(&self) -> u32 {
        let r = self.per_row();
        r * r
    }

    fn page_bytes(&self) -> usize {
        (self.page_side as usize) * (self.page_side as usize) * 4
    }

    /// Bytes the engine holds on the GPU outside its tile pages.
    fn bytes_beside_tiles(&self) -> usize {
        self.bytes().saturating_sub(self.pages.len() * self.page_bytes())
    }

    /// Available tile-page budget under `self.budget`, capped at `tile_bytes`.
    fn tile_budget_limit(&self, tile_bytes: usize) -> usize {
        let beside = self.bytes_beside_tiles() + self.readbacks.bytes.get() + HEADROOM;
        tile_bytes.min(self.budget.saturating_sub(beside))
    }

    /// Fits the tiles kept to the budget: what's left of it beside everything else, at most
    /// `tile_bytes`, in whole pages. Pages past it go, with their tiles. When no pages are
    /// allocated yet, picks 4096x4096 (64 tiles/page) if device limits and budget allow.
    fn fit_tiles(&mut self, tile_bytes: usize) {
        crate::tiles::fit_tile_pages(self, tile_bytes);
    }

    /// Checks that no ordinary tile's slot points past `self.pages`, dropping any that do so
    /// release builds recover by redrawing instead of repeating a missing-page composite forever.
    fn heal_unbacked_tiles(&mut self) {
        let resident = self.pages.len() * self.per_page() as usize;
        let dropped = self.tiles.drop_unbacked_slots(resident);
        debug_assert_eq!(
            dropped,
            0,
            "dropped {dropped} tile(s) pointing past {} page(s) (per_page={})",
            self.pages.len(),
            self.per_page(),
        );
    }

    /// Room remaining under `self.budget` for `self.readers` allocations.
    #[inline(never)]
    fn reader_budget_room(&self) -> usize {
        self.budget
            .saturating_sub(self.bytes() - self.readers.bytes() + self.readbacks.bytes.get())
    }

    #[inline(never)]
    fn ensure_reader_tex(&mut self, kind: u8, w: u32, h: u32, label: &str) -> Result<()> {
        for attempt in 0..2 {
            let budget = self.reader_budget_room();
            let res = if kind == 2 {
                self.readers.ensure_blur_out_budgeted(&self.device, w, h, budget)
            } else {
                self.readers
                    .ensure_frame_tex_budgeted(kind == 1, &self.device, w, h, label, budget)
            };
            match res {
                Ok(()) => return Ok(()),
                Err(e) if attempt == 0 && e.code == ErrorCode::Limit && self.pool_bytes > 0 => {
                    self.trim_pools(0);
                }
                Err(e) => return Err(e),
            }
        }
        Ok(())
    }

    /// Releases transient pools, scratch and reader working textures between failed whole-frame
    /// stages without touching cached tiles, overview tiles, shown frames, images or glyph atlas.
    #[inline(never)]
    fn trim_transient(&mut self) {
        self.trim_pools(0);
        if self.active.is_none() && !self.walk_paused() {
            self.readers.evict_frame_scratch();
            self.readers.flush_retired();
            if let Some(old) = self.scratches[1].take() {
                self.bytes -= Self::frame_bytes(old.width, old.height) * 2;
                old.texture.destroy();
            }
        }
    }

    /// The page and position of a slot, making its page (within the budget `fit_tiles` set).
    fn slot_place(&mut self, slot: u32) -> Result<(usize, u32, u32)> {
        if slot >= crate::tiles::OVERVIEW_SLOT {
            return self.overview_place(slot - crate::tiles::OVERVIEW_SLOT);
        }
        let per_page = self.per_page();
        let per_row = self.per_row();
        let page = (slot / per_page) as usize;
        let within = slot % per_page;
        let (x, y) = ((within % per_row) * TILE, (within / per_row) * TILE);
        let side = self.page_side;
        let pbytes = self.page_bytes();
        while self.pages.len() <= page {
            self.check_texture_size(side, side, "a page of tiles")?;
            self.reserve(pbytes, 0, "a page of tiles")?;
            let tex = texture(
                &self.device,
                side,
                side,
                wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_SRC | wgpu::TextureUsages::COPY_DST,
                "tiles",
            );
            let view = tex.create_view(&Default::default());
            let composite_group = self
                .compositor
                .as_ref()
                .map(|c| c.create_bind_group(&self.device, &view, "composite page"));
            self.pages.push(Page {
                view,
                texture: tex,
                composite_group,
            });
            self.bytes += pbytes;
        }
        Ok((page, x, y))
    }

    /// Where overview tile `index` lives, its texture made (for the overview's grid) if needed.
    fn overview_place(&mut self, index: u32) -> Result<(usize, u32, u32)> {
        let grid = self
            .tiles
            .overview_grid()
            .ok_or_else(|| EngineError::new(ErrorCode::State, "no overview"))?;
        if self.overview_page.as_ref().is_some_and(|o| o.grid != grid) {
            self.drop_overview_page();
        }
        if self.overview_page.is_none() {
            let (w, h) = (grid.0 * TILE, grid.1 * TILE);
            self.check_texture_size(w, h, "the overview")?;
            let bytes = w as usize * h as usize * 4;
            self.reserve(bytes, 0, "the overview")?;
            let tex = texture(
                &self.device,
                w,
                h,
                wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_SRC | wgpu::TextureUsages::COPY_DST,
                "overview",
            );
            let view = tex.create_view(&Default::default());
            let composite_group = self
                .compositor
                .as_ref()
                .map(|c| c.create_bind_group(&self.device, &view, "composite overview"));
            self.overview_page = Some(OverviewPage {
                page: Page {
                    texture: tex,
                    view,
                    composite_group,
                },
                grid,
                bytes,
            });
            self.bytes += bytes;
        }
        Ok((OVERVIEW_PAGE, (index % grid.0) * TILE, (index / grid.0) * TILE))
    }

    /// An overview tile couldn't be drawn: the overview goes, its texture with it, until the cache
    /// clears (`TileCache::refuse_overview`).
    fn refuse_overview(&mut self) {
        self.tiles.refuse_overview();
        self.drop_overview_page();
    }

    /// Frees the overview's texture.
    fn drop_overview_page(&mut self) {
        if let Some(o) = self.overview_page.take() {
            o.page.texture.destroy();
            self.bytes -= o.bytes;
        }
    }

    /// Sets the overview for the page in `store` (`TileCache::set_overview`), freeing its texture
    /// when it's gone or moved.
    fn set_overview(&mut self, store: &Store) {
        self.tiles.set_overview(Self::page_bounds(store));
        if self
            .overview_page
            .as_ref()
            .is_some_and(|o| Some(o.grid) != self.tiles.overview_grid())
        {
            self.drop_overview_page();
        }
    }

    /// A page of tiles (`slot_place`'s), or the overview's.
    fn page(&self, page: usize) -> &Page {
        if page == OVERVIEW_PAGE {
            &self.overview_page.as_ref().expect("overview page").page
        } else {
            &self.pages[page]
        }
    }

    fn flush_retired_textures(&mut self) {
        for (tex, bytes) in self.retired_textures.drain(..) {
            self.pool_bytes = self.pool_bytes.saturating_sub(bytes);
            tex.destroy();
        }
    }

    /// Takes the active tile's pending command encoder (or creates a new one).
    fn take_encoder(&mut self, label: &str) -> wgpu::CommandEncoder {
        self.active.as_mut().and_then(|a| a.before.take()).unwrap_or_else(|| {
            self.device
                .create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some(label) })
        })
    }

    /// Records a batched `vello_gpu` render into the active command encoder, automatically
    /// flushing and starting a fresh encoder only if staged Vello buffers reach capacity.
    fn vello_render(
        &mut self,
        use_mask_scene: bool,
        view: &wgpu::TextureView,
        depth: Option<&wgpu::TextureView>,
        options: RenderOptions<'_>,
        label: &str,
    ) -> Result<()> {
        if !use_mask_scene {
            self.flush_masks();
        }
        let target = RenderTarget {
            view,
            depth_view: depth,
        };
        let prepared = {
            let scene = if use_mask_scene { &self.mask_scene } else { &self.scene };
            self.renderer
                .prepare_batch_render(scene, &self.resources, target, &self.bindings, options)
                .map_err(vello_error)?
        };
        if prepared.needs_flush {
            self.submit_active_encoder();
        }
        let mut encoder = self.take_encoder(label);
        let draws = {
            let scene = if use_mask_scene { &self.mask_scene } else { &self.scene };
            self.renderer
                .execute_batch_render(prepared, scene, &mut encoder, target, &self.bindings, options)
                .map_err(vello_error)?
        };
        self.stash_encoder(encoder);
        if let Some(a) = self.active.as_mut() {
            a.vello_renders += 1;
            a.draws += draws;
        }
        let kind = match label {
            "scene flush" => 0,
            "glass mask batch" => 1,
            "blur reader clip" => 2,
            "backdrop blur" => 3,
            "scope composite" => 4,
            "reader clip" => 5,
            "reader glass" => 6,
            "shadow cache" => 7,
            "shadow" => 8,
            "shadow reduced" => 9,
            _ => 10,
        };
        self.counters.renders[kind] = self.counters.renders[kind].wrapping_add(1);
        self.passes = self.passes.wrapping_add(1);
        Ok(())
    }

    /// Records a direct two-pass dual-plane `vello_gpu` strip replay into both `primary` and
    /// `secondary` root targets, uploading strips/paints once and skipping `delta_frame` + `OverBoth`.
    #[allow(clippy::too_many_arguments)]
    fn vello_render_dual(
        &mut self,
        primary_view: &wgpu::TextureView,
        primary_depth: Option<&wgpu::TextureView>,
        secondary_view: &wgpu::TextureView,
        secondary_depth: Option<&wgpu::TextureView>,
        options: RenderOptions<'_>,
        label: &str,
    ) -> Result<()> {
        self.flush_masks();
        let primary = RenderTarget {
            view: primary_view,
            depth_view: primary_depth,
        };
        let secondary = RenderTarget {
            view: secondary_view,
            depth_view: secondary_depth,
        };
        let prepared = self
            .renderer
            .prepare_batch_render_dual(
                &self.scene,
                &self.resources,
                primary,
                secondary,
                &self.bindings,
                options,
            )
            .map_err(vello_error)?;
        if prepared.needs_flush {
            self.submit_active_encoder();
        }
        let mut encoder = self.take_encoder(label);
        let draws = self
            .renderer
            .execute_batch_render_dual(
                prepared,
                &self.scene,
                &mut encoder,
                primary,
                secondary,
                &self.bindings,
                options,
            )
            .map_err(vello_error)?;
        self.stash_encoder(encoder);
        if let Some(a) = self.active.as_mut() {
            a.vello_renders += 1;
            a.draws += draws;
        }
        self.counters.renders[0] = self.counters.renders[0].wrapping_add(1);
        Ok(())
    }

    fn submit_active_encoder(&mut self) {
        let mut can_recycle_scene = false;
        if let Some(active) = self.active.as_mut()
            && let Some(encoder) = active.before.take()
        {
            let t0 = now();
            self.renderer.flush_uploads();
            self.readers.flush_uniforms(&self.queue);
            self.blend.flush_uniforms(&self.queue);
            self.blur.flush_uniforms(&self.queue);
            self.shadow.flush_uniforms(&self.queue);
            active.draws += self.readers.take_draws() + self.blur.take_draws() + self.shadow.take_draws();
            self.queue.submit([encoder.finish()]);
            self.blur.flush_retired();
            self.readers.flush_retired();
            self.submits += 1;
            active.submit_ms += now() - t0;
            can_recycle_scene = !active.scene_dirty && self.atlas.pending.is_empty();
        }
        self.flush_retired_textures();
        self.offscreen_pool.append(&mut self.offscreen_in_use);
        if can_recycle_scene {
            self.recycle_scene_textures();
            self.atlas.at = (0, 0, 0);
        }
    }

    /// Enables or disables per-frame WebGPU timestamp queries (returns whether active).
    pub fn set_gpu_timestamps(&mut self, enabled: bool) -> bool {
        if let Some(ts) = self.timestamps.as_mut() {
            ts.enabled = enabled;
            if !enabled {
                ts.has_sample = false;
            }
            ts.enabled
        } else {
            false
        }
    }

    /// Enables or disables fixed-function hardware blending in Vello's strip pass.
    pub fn set_hw_blend_enabled(&mut self, enabled: bool) -> bool {
        if self.hw_blend_enabled != enabled {
            self.hw_blend_enabled = enabled;
            self.clear_tiles();
        }
        self.hw_blend_enabled
    }

    /// Enables or disables the tile-local clip-chain mask cache and AA-rect scissor fast path.
    pub fn set_clip_fast_path_enabled(&mut self, enabled: bool) -> bool {
        if self.clip_fast_path_enabled != enabled {
            self.clip_fast_path_enabled = enabled;
            self.clear_tiles();
        }
        self.clip_fast_path_enabled
    }

    /// Warms one HW-blend strip pipeline slot (`0..4` depth, `4..8` non-depth) in idle time.
    /// Returns `true` when additional slots remain.
    pub fn warm_hw_blend_pipeline(&mut self, slot: usize) -> bool {
        if !self.hw_blend_enabled {
            return false;
        }
        self.renderer.warm_hw_blend_pipeline(slot)
    }

    /// Returns the underlying browser `GPUDevice` handle plus the patched strip WGSL source and
    /// external-texture flag so WebGPU callers can precompile HW-blend pipelines asynchronously
    /// via `GPUDevice.createRenderPipelineAsync` before materializing `wgpu::RenderPipeline`s.
    #[cfg(all(target_arch = "wasm32", feature = "gpu"))]
    pub fn webgpu_hw_blend_warmup(&self) -> Option<(wasm_bindgen::JsValue, String, bool)> {
        if !self.hw_blend_enabled {
            return None;
        }
        let dev = self.device.as_webgpu()?;
        let (wgsl, ext) = self.renderer.hw_blend_strip_shader_wgsl();
        Some((wasm_bindgen::JsValue::from(dev.clone()), wgsl, ext))
    }

    /// True iff every destination plane that the current scene will flush onto is guaranteed
    /// to have alpha == 1.0 across its active area, and the scene has not promoted root to an
    /// intermediate blend layer.
    fn target_is_opaque(&self) -> bool {
        let Some(active) = self.active.as_ref() else {
            return false;
        };
        if self.scene.root_is_blend_target() {
            return false;
        }
        if let Some(scope) = self.offscreen_stack.last() {
            let shared = scope.backdrop.is_none();
            let (wm, wb) = if shared {
                (active.write_main || active.write_backdrop, false)
            } else {
                (active.write_main, active.write_backdrop)
            };
            (wm || wb) && (!wm || scope.main.opaque) && (!wb || scope.backdrop.as_ref().is_some_and(|b| b.opaque))
        } else {
            let wm = active.write_main;
            let wb = active.write_backdrop && !(active.detail && wm);
            (wm || wb) && (!wm || active.main_opaque) && (!wb || active.backdrop_opaque)
        }
    }

    /// Marks the currently active destination plane(s) non-opaque (called before a destructive
    /// root-level `DestOut`/`DestIn` layer).
    fn invalidate_active_opacity(&mut self) {
        let Some(active) = self.active.as_mut() else {
            return;
        };
        if let Some(scope) = self.offscreen_stack.last_mut() {
            if scope.backdrop.is_none() {
                scope.main.opaque = false;
            } else {
                if active.write_main {
                    scope.main.opaque = false;
                }
                if active.write_backdrop
                    && let Some(back) = scope.backdrop.as_mut()
                {
                    back.opaque = false;
                }
            }
        } else {
            if active.write_main {
                active.main_opaque = false;
            }
            if active.write_backdrop {
                active.backdrop_opaque = false;
            }
        }
    }

    fn begin_frame_timestamp(&mut self) {
        let Some(ts) = self.timestamps.as_mut().filter(|t| t.enabled) else {
            return;
        };
        ts.has_sample = false;
        let mut encoder = self.device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("frame timestamp start"),
        });
        {
            let _pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("frame timestamp start"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &ts.dummy_view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Load,
                        store: wgpu::StoreOp::Discard,
                    },
                })],
                timestamp_writes: Some(wgpu::RenderPassTimestampWrites {
                    query_set: &ts.query_set,
                    beginning_of_pass_write_index: Some(0),
                    end_of_pass_write_index: None,
                }),
                ..Default::default()
            });
        }
        self.queue.submit([encoder.finish()]);
    }

    fn end_frame_timestamp(&mut self) {
        let Some(ts) = self.timestamps.as_mut().filter(|t| t.enabled) else {
            return;
        };
        let mut encoder = self.device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("frame timestamp end"),
        });
        {
            let _pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("frame timestamp end"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &ts.dummy_view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Load,
                        store: wgpu::StoreOp::Discard,
                    },
                })],
                timestamp_writes: Some(wgpu::RenderPassTimestampWrites {
                    query_set: &ts.query_set,
                    beginning_of_pass_write_index: None,
                    end_of_pass_write_index: Some(1),
                }),
                ..Default::default()
            });
        }
        encoder.resolve_query_set(&ts.query_set, 0..2, &ts.resolve_buf, 0);
        self.queue.submit([encoder.finish()]);
        ts.has_sample = true;
    }

    pub fn gpu_timestamp_start(&self) -> Result<Option<(wgpu::Buffer, f64)>> {
        self.check()?;
        let Some(ts) = self.timestamps.as_ref().filter(|t| t.enabled && t.has_sample) else {
            return Ok(None);
        };
        let buffer = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("frame timestamps read"),
            size: 16,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let mut encoder = self.device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("frame timestamps copy"),
        });
        encoder.copy_buffer_to_buffer(&ts.resolve_buf, 0, &buffer, 0, 16);
        self.queue.submit([encoder.finish()]);
        self.check()?;
        Ok(Some((buffer, ts.period_ns)))
    }

    /// Stashes `encoder` onto the active tile so subsequent non-Vello reader/copy passes can join
    /// the same command buffer without an extra `queue.submit`.
    fn stash_encoder(&mut self, encoder: wgpu::CommandEncoder) {
        if let Some(a) = self.active.as_mut() {
            a.before = Some(encoder);
        } else {
            self.renderer.flush_uploads();
            self.readers.flush_uniforms(&self.queue);
            self.blend.flush_uniforms(&self.queue);
            self.blur.flush_uniforms(&self.queue);
            self.shadow.flush_uniforms(&self.queue);
            let _ = self.readers.take_draws() + self.blur.take_draws() + self.shadow.take_draws();
            self.queue.submit([encoder.finish()]);
            self.blur.flush_retired();
            self.readers.flush_retired();
            self.flush_retired_textures();
            self.submits += 1;
        }
    }

    /// The scratch tile (`side` × `side`, where `side = TILE + 2 * halo`) and its depth buffer.
    fn ensure_scratch(&mut self, side: u32) -> Result<()> {
        self.ensure_scratch_size(side, side)
    }

    /// The scratch render target (`width` × `height`) and its depth buffer.
    fn ensure_scratch_size(&mut self, width: u32, height: u32) -> Result<()> {
        let slot = if self.reader_halo.as_ref().is_some_and(|h| h.strip_capture.is_some()) {
            EDGE_STRIP_SCRATCH_SLOT
        } else if let Some(tier) = self.reader_halo.as_ref().and_then(|halo| halo.capture) {
            if tier.is_far {
                FAR_HALO_SCRATCH_SLOT
            } else {
                MID_HALO_SCRATCH_SLOT
            }
        } else {
            usize::from(!(width == TILE && height == TILE))
        };
        if self.scratches[slot]
            .as_ref()
            .is_some_and(|s| s.width == width && s.height == height)
        {
            self.active_scratch = slot;
            return Ok(());
        }
        let max_tex = self.device.limits().max_texture_dimension_2d.min(u32::from(u16::MAX));
        if width > max_tex || height > max_tex {
            return Err(EngineError::limit(format!(
                "render target ({width} × {height} px) exceeds device texture limit ({max_tex} px)"
            )));
        }
        let freed = self.scratches[slot]
            .as_ref()
            .map_or(0, |s| (s.width as usize) * (s.height as usize) * 4 * 2);
        let bytes = (width as usize) * (height as usize) * 4 * 2;
        for step in 0..=self.scratches.len() {
            if self.reserve(bytes, freed, "the scratch tile").is_ok() {
                break;
            }
            if step == 0 {
                self.trim_pools(0);
            } else if step - 1 != slot
                && let Some(old) = self.scratches[step - 1].take()
            {
                self.bytes -= Self::frame_bytes(old.width, old.height) * 2;
                old.texture.destroy();
            }
        }
        self.reserve(bytes, freed, "the scratch tile")?;
        if let Some(old) = self.scratches[slot].take() {
            old.texture.destroy();
            self.readers.clear_frame_targets();
        }
        let tex = texture(
            &self.device,
            width,
            height,
            // Sampled too: a drag's selection is laid over the frame from it, and readers sample it.
            wgpu::TextureUsages::RENDER_ATTACHMENT
                | wgpu::TextureUsages::COPY_SRC
                | wgpu::TextureUsages::COPY_DST
                | wgpu::TextureUsages::TEXTURE_BINDING,
            "scratch tile",
        );
        let depth = self.renderer.create_depth_texture_view(&RenderSize {
            width: width as u16,
            height: height as u16,
        });
        let view = tex.create_view(&Default::default());
        self.scratches[slot] = Some(ScratchTile {
            texture: tex,
            view,
            view_id: crate::blend::gpu::next_view_id(),
            depth,
            width,
            height,
        });
        self.active_scratch = slot;
        self.bytes = self.bytes - freed + bytes;
        Ok(())
    }

    /// Discards the prefix when ordinary paint can have changed, or the gesture settles.
    pub fn forget_motion_prefix(&mut self) {
        if let Some(prefix) = self.motion_prefix.take() {
            self.bytes -= prefix.texture.width() as usize * prefix.texture.height() as usize * 4;
            prefix.texture.destroy();
        }
    }

    fn prepare_motion_prefix(
        &mut self,
        store: &Store,
        frame: &Frame,
        background: [u32; 4],
        (serial, cut): (u64, usize),
        verbs: &mut usize,
        stats: &mut DrawStats,
    ) -> Result<Option<Split>> {
        let active = self.active.as_ref().expect("whole-frame draw");
        let (width, height) = (active.width, active.height);
        let target = self.root_plane(false)?.0.clone();
        let mut split = Split {
            pass: Pass::Below,
            parent: crate::store::ROOT,
            first: cut,
            last: cut - 1,
            path: Vec::new(),
        };
        let reuse = self.motion_prefix.as_ref().is_some_and(|p| {
            p.serial == serial
                && p.cut == cut
                && p.view == frame.view
                && p.background == background
                && (p.texture.width(), p.texture.height()) == (width, height)
        });
        if !reuse {
            self.forget_motion_prefix();
            let bytes = width as usize * height as usize * 4;
            if self.reserve(bytes, 0, "motion prefix").is_err() {
                return Ok(None);
            }
            let cached = texture(
                &self.device,
                width,
                height,
                wgpu::TextureUsages::COPY_SRC | wgpu::TextureUsages::COPY_DST,
                "motion prefix",
            );
            self.bytes += bytes;
            self.motion_prefix = Some(MotionPrefix {
                texture: cached,
                view: frame.view,
                background,
                serial,
                cut,
            });
            let s = exec::draw_split(store, self, frame, &store.limits, verbs, &split, false)?;
            stats.add(&s);
            self.flush_why = 1;
            self.flush_scene_gpu(true)?;
            self.scene.reset();
            let mut encoder = self.take_encoder("cache motion prefix");
            let cached = &self.motion_prefix.as_ref().expect("cached prefix").texture;
            copy_rect(&mut encoder, &target, cached, (0, 0), (0, 0), (width, height));
            self.stash_encoder(encoder);
        } else {
            let mut encoder = self.take_encoder("restore motion prefix");
            let cached = &self.motion_prefix.as_ref().expect("cached prefix").texture;
            copy_rect(&mut encoder, cached, &target, (0, 0), (0, 0), (width, height));
            self.stash_encoder(encoder);
            self.active.as_mut().expect("whole-frame draw").needs_clear = false;
        }
        split.pass = Pass::Above;
        Ok(Some(split))
    }

    /// Rasterizes independent shape coverage together before walking the paint stack.
    /// Slots are packed in canonical paint order and rasterized in lens-local coordinates
    /// (`fill_path_in_slot`), so batched masks match the serial path bit-for-bit.
    fn prepare_glass_masks(&mut self, store: &Store, frame: &Frame) -> Result<()> {
        let t0 = now();
        let sub0 = self.active.as_ref().map_or(0.0, |a| a.submit_ms);
        let frame_backdrop = (u32::from(frame.width) as usize)
            .saturating_mul(u32::from(frame.height) as usize)
            .saturating_mul(4);
        let existing_backdrop = self.readers.backdrop_frame.as_ref().map_or(0, PlainTex::bytes);
        // Reserve room for the mandatory backdrop plane so the optional mask atlas
        // never starves a frame under a tight GPU budget.
        let needed_backdrop = frame_backdrop.saturating_sub(existing_backdrop);
        let reader_room = self.reader_budget_room().saturating_sub(needed_backdrop);
        let other_reader_bytes = self
            .readers
            .bytes()
            .saturating_sub(self.readers.glass_mask_atlas_bytes());
        let atlas_room = reader_room.saturating_sub(other_reader_bytes);
        let root_area = self
            .active
            .as_ref()
            .and_then(|a| a.glass_display_area.or(a.display_area));
        let plan = glass::plan_glass_masks_clipped(store, frame, root_area, self.max_texture_2d, atlas_room);
        if plan.placements.len() < 2
            || !self
                .readers
                .ensure_glass_mask_atlas(&self.device, &self.renderer, plan.size, reader_room)
        {
            self.readers.drop_glass_mask_atlas();
            if let Some(active) = self.active.as_mut() {
                let sub = active.submit_ms - sub0;
                active.prepare_masks_ms += (now() - t0 - sub).max(0.0);
            }
            return Ok(());
        }
        self.mask_scene.reset_and_resize(plan.size.0 as u16, plan.size.1 as u16);
        self.mask_scene.set_paint(vello_common::color::palette::css::WHITE);
        for p in &plan.placements {
            self.mask_scene.set_transform(p.local_transform);
            self.mask_scene
                .set_fill_rule(if p.even_odd { Fill::EvenOdd } else { Fill::NonZero });
            self.mask_scene.fill_path_in_slot(
                &p.path,
                (p.slot.offset.0 as u16, p.slot.offset.1 as u16),
                (p.slot.region.2 as u16, p.slot.region.3 as u16),
            );
        }
        let mut options = RenderOptions::default();
        options.target_init = TargetInit::Clear(ClearSettings::Viewport {
            color: vello_common::color::AlphaColor::TRANSPARENT,
        });
        let (atlas_view, atlas_depth) = {
            let atlas = self.readers.glass_mask_atlas.as_ref().expect("glass mask atlas");
            (atlas.view.clone(), atlas.depth.clone())
        };
        self.vello_render(true, &atlas_view, Some(&atlas_depth), options, "glass mask batch")?;
        self.mask_scene.reset();
        let active = self.active.as_mut().expect("active draw");
        active.glass_masks = plan.slots;
        let sub = active.submit_ms - sub0;
        active.prepare_masks_ms += (now() - t0 - sub).max(0.0);
        Ok(())
    }

    /// The progressive blur tile side: 512 px on hardware GPUs when the stop atlas fits a third of
    /// the reader budget (a quarter of the framebuffer switches and copies on WebGL2), else 256 px.
    fn progressive_tile_side(&self, width: u32, height: u32, cols: u32, rows: u32, budget: usize) -> u32 {
        let base = progressive_blur::PROGRESSIVE_TILE_MAX
            .min(self.max_texture_2d / 4)
            .max(1);
        if self.fallback_adapter {
            return base;
        }
        let hw = 512u32.min(self.max_texture_2d / 4).max(base);
        let atlas_bytes = (width.min(hw) as usize)
            .saturating_mul(height.min(hw) as usize)
            .saturating_mul(cols as usize)
            .saturating_mul(rows as usize)
            .saturating_mul(4);
        if atlas_bytes <= budget / 3 { hw } else { base }
    }

    /// The widest reader apron a view tile may bake with at rest: the padded tile stays within
    /// the halo render side (4,096 px on hardware GPUs, 2,048 on software adapters) and the
    /// texture limit. Memory is checked when the tile's targets are made.
    pub fn max_view_apron(&self) -> i32 {
        let side = if self.fallback_adapter {
            SOFTWARE_HALO_RENDER_MAX_SIDE
        } else {
            HARDWARE_HALO_RENDER_MAX_SIDE
        };
        (side.min(self.max_texture_2d).saturating_sub(TILE) / 2) as i32
    }

    /// Logical coarse replay side cap used by `Engine::reader_halo_plan`.
    pub fn halo_replay_limit(&self) -> u32 {
        if self.fallback_adapter {
            halo::SOFTWARE_HALO_REPLAY_SIDE
        } else {
            halo::HALO_REPLAY_SIDE
        }
    }

    /// Maximum `(side, pixels)` for a world-grid `d = 2` wide-blur capture (`WideBlurPlan`),
    /// bounded by both adapter limits and available GPU memory (`28 B/px`).
    pub fn wide_blur_limits(&self) -> (u32, usize) {
        let (side, max_pixels) = if self.fallback_adapter {
            (self.max_texture_2d.min(WIDE_BLUR_MAX_SIDE_SW), WIDE_BLUR_MAX_PIXELS_SW)
        } else {
            (self.max_texture_2d.min(WIDE_BLUR_MAX_SIDE_HW), WIDE_BLUR_MAX_PIXELS_HW)
        };
        let cache_bytes: usize = match self.wide_blur.as_ref() {
            Some(WideBlurState::Ready(c)) => c
                .blurred
                .0
                .iter()
                .map(|(_, p)| Self::frame_bytes(p.texture.width(), p.texture.height()))
                .sum(),
            _ => 0,
        };
        let freed = cache_bytes
            + self.blur.bytes()
            + self.scratches[FAR_HALO_SCRATCH_SLOT]
                .as_ref()
                .map_or(0, |s| (s.width as usize) * (s.height as usize) * 8);
        let held = self.bytes().saturating_sub(self.pool_bytes) + self.readbacks.bytes.get();
        let room = self.budget.saturating_sub(held.saturating_sub(freed));
        (side, max_pixels.min(room / 28))
    }

    /// Where a `size` view padded to its readers' `samples` sits in the padded target, and that
    /// target's size, if one device-resolution pass of it fits this GPU: the texture limit, the
    /// software raster budget and the GPU memory budget. `draw_whole_pass` draws by this check,
    /// and the engine and `render_whole` decide by it (`prefers_padded_view`).
    #[inline(never)]
    fn padded_view(&self, samples: IRect, size: (u32, u32), extra_freed: usize) -> Result<((u32, u32), (u32, u32))> {
        // Keep the same strip phase at the original viewport origin.
        let x = samples.x0.unsigned_abs().next_multiple_of(4);
        let y = samples.y0.unsigned_abs().next_multiple_of(4);
        let padded = (
            (samples.x1.max(0) as u32).saturating_add(x),
            (samples.y1.max(0) as u32).saturating_add(y),
        );
        let pixels = (padded.0 as usize).saturating_mul(padded.1 as usize);
        if self.fallback_adapter && pixels > SOFTWARE_PADDED_PIXELS.max(size.0 as usize * size.1 as usize) {
            return Err(EngineError::limit(
                "viewport readers exceed the software GPU raster budget",
            ));
        }
        if padded.0 > u32::from(u16::MAX) || padded.1 > u32::from(u16::MAX) {
            return Err(EngineError::limit("a padded view past the frame size limit"));
        }
        self.check_texture_size(padded.0, padded.1, "a padded view")?;
        // Beside colour/depth scratch, the padded view needs room for its backdrop plane.
        let scratch_bytes = self.scratches[1]
            .as_ref()
            .map_or(0, |s| s.width as usize * s.height as usize * 8);
        self.check_frame(
            self.next_frame(),
            size.0,
            size.1,
            pixels.saturating_mul(12),
            scratch_bytes
                .saturating_add(self.readers.bytes())
                .saturating_add(extra_freed),
        )?;
        Ok(((x, y), padded))
    }

    #[inline(never)]
    fn prefers_padded_with(
        &self,
        plan: &ViewportHaloPlan,
        size: (u32, u32),
        max_pixels: usize,
        extra_freed: usize,
    ) -> bool {
        plan.coarse_post_scopes.is_empty()
            && self
                .padded_view(plan.samples, size, extra_freed)
                .is_ok_and(|(_, (w, h))| (w as usize).saturating_mul(h as usize) <= max_pixels)
    }

    /// Whether a `size` view needing `plan` is drawn exact in one device-resolution pass: no
    /// layer-blur scope needs the far tier, the padded view fits (`padded_view`), and it holds at
    /// most `max_pixels` (`Limits::padded_view_pixels`), past which apron tiles are cheaper.
    pub fn prefers_padded_view(&self, plan: &ViewportHaloPlan, size: (u32, u32), max_pixels: usize) -> bool {
        self.prefers_padded_with(plan, size, max_pixels, 0)
    }

    /// Draws the whole frame of a view at rest (what `render_whole` draws: one native pass of
    /// the padded view, else the reduced reader-halo frame) a slice at a time, at most
    /// `budget_ms` a call, so no frame waits for all of it. Until its last slice lands each call
    /// shows the last frame warped to the view (one quad, `present_motion_standin`) with one tile
    /// pending; `ahead_whole` runs the slices between frames. A slice that hits a memory limit
    /// steps down to the halo or a budgeted coarse stand-in without blocking or dropping view
    /// caches immediately; if tile pages were held, once the view stays still for
    /// `RETRY_QUIET_MS`, tile pages are dropped (keeping the overview) and the view retries once
    /// in budgeted slices.
    #[inline(never)]
    #[allow(clippy::too_many_arguments)]
    pub fn render_whole_sliced(
        &mut self,
        store: &Store,
        frame: &Frame,
        background: [f32; 4],
        generation: u64,
        plan: Option<ViewportHaloPlan>,
        budget_ms: f64,
    ) -> Result<DrawStats> {
        self.check()?;
        let t0 = now();
        let submits0 = self.submits;
        let size = (u32::from(frame.width), u32::from(frame.height));
        let inputs = Self::inputs(store, generation, background);
        let view_bits = frame.view.as_coeffs().map(f64::to_bits);
        if self.pending_whole.as_ref().is_some_and(|p| {
            p.view_bits != view_bits
                || p.frame.width != frame.width
                || p.frame.height != frame.height
                || p.inputs != inputs
        }) {
            self.abort_pending_whole();
        }
        if self.pending_whole.is_none()
            && let Some(shown) = self.present_finished_whole(view_bits, size, inputs)
        {
            return shown;
        }
        self.abort_pending_tile();
        self.abort_wide_blur();
        self.opening_pending = false;
        if self.pending_whole.is_none() {
            self.sliced_frame = None;
            self.pending_whole = Some(PendingWhole {
                stage: PendingStage::Start,
                plan,
                frame: *frame,
                background,
                view_bits,
                inputs,
                retry: 0,
            });
        }
        if let Some(stats) = self.advance_pending_whole(store, budget_ms)? {
            return Ok(stats);
        }
        self.present_pending_whole(frame.view, view_bits, background, size, inputs, t0, submits0)
    }

    /// Whether a whole frame is being drawn over slices (`render_whole_sliced`).
    pub fn has_pending_whole(&self) -> bool {
        self.pending_whole.is_some()
    }

    /// Tile level scale served by the active or in-progress wide-blur cache, if any.
    pub fn wide_blur_scale(&self) -> Option<f64> {
        self.wide_blur.as_ref().map(|wb| match wb {
            WideBlurState::Building(b) => b.plan.level.scale,
            WideBlurState::Ready(c) => c.level.scale,
        })
    }

    /// The scales at which something is drawn or being drawn (the tiles' levels, the frame shown):
    /// an image level no sampler picks at any of them changes nothing. None while a whole frame is
    /// shown or drawn: its readers' reduced captures sample images at scales of their own.
    pub fn scales_in_use(&self) -> Option<Vec<f64>> {
        if self.whole_reader_halo || self.pending_whole.is_some() || self.sliced_frame.is_some() {
            return None;
        }
        let mut scales: Vec<f64> = self.tiles.levels().iter().map(|(_, l)| l.scale).collect();
        scales.extend(self.last.map(|l| l.view.as_coeffs()[0]));
        if let Some(wb) = self.wide_blur.as_ref() {
            let s = match wb {
                WideBlurState::Building(b) => b.plan.level.scale * 0.5,
                WideBlurState::Ready(c) => c.level.scale * 0.5,
            };
            scales.push(s);
        }
        Some(scales)
    }

    /// The time between frames for a view drawn as whole frames (its readers reach past a tile's
    /// halo, so it has no tiles to draw ahead): the overview's tiles, coarse and without an apron,
    /// within `budget_ms`, so a zoom out from it has its stand-in. A tile that fails drops the
    /// overview, never the slice.
    pub fn ahead_overview(
        &mut self,
        store: &Store,
        background: [f32; 4],
        generation: u64,
        budget_ms: f64,
    ) -> Result<DrawStats> {
        self.check()?;
        self.pass_budget = None;
        let mut stats = DrawStats::default();
        let Some(last) = self.last else {
            return Ok(stats);
        };
        // Only once the view's own whole frame is shown: until then nothing here, so the caller
        // draws that frame.
        let inputs = Self::inputs(store, generation, background);
        if !self.sliced_frame.is_some_and(|f| f.inputs == inputs) {
            return Ok(stats);
        }
        if budget_ms >= 1.0 && self.gpu_behind(IDLE_IN_FLIGHT) {
            stats.in_progress = true;
            return Ok(stats);
        }
        if self
            .pending_tile
            .as_ref()
            .is_some_and(|pt| pt.inputs != inputs || !self.tiles.is_overview(&pt.key))
        {
            self.abort_pending_tile();
        }
        let t0 = now();
        let submits0 = self.submits;
        let scale = last.view.as_coeffs()[0];
        self.masks.begin_frame();
        self.blur.begin_frame();
        self.shadow.begin_frame();
        self.tiles.begin_scaled(background, scale, self.tiles.halo());
        self.set_overview(store);
        self.tiles.refine_overview = self.quiet_for_overview();
        self.fit_tiles(store.limits.tile_bytes);
        let jobs = self.tiles.overview_ahead(scale);
        // A paused tile no job here wants any more (a refined one while the camera hasn't been
        // still long enough) is let go, as the tiled time between frames does.
        if self
            .pending_tile
            .as_ref()
            .is_some_and(|pt| !jobs.iter().any(|j| j.key == pt.key))
        {
            self.abort_pending_tile();
        }
        let deadline = (budget_ms > 0.0).then_some(t0 + self.walk_budget_ms(budget_ms));
        let mut verbs = store.limits.frame_verbs;
        let mut paused = false;
        if let Some(key) = self.pending_tile.as_ref().map(|pt| pt.key) {
            self.deadline_ms = deadline;
            self.idle_pass_budget(&key);
            let step = self.resume_pending_tile(store, &mut stats);
            self.deadline_ms = None;
            self.pass_budget = None;
            match step {
                Ok(TileStep::Paused) => paused = true,
                Ok(_) => {}
                Err(e) if e.code == ErrorCode::DeviceLost => return Err(e),
                Err(_) => self.refuse_overview(),
            }
        }
        if !paused {
            for job in &jobs {
                // Drawn by the resume above, or the overview went with a failed one.
                if !self.tiles.is_overview(&job.key) || self.tiles.get(&job.key).is_some_and(|e| !e.stale && !e.refine)
                {
                    continue;
                }
                if deadline.is_some_and(|d| now() >= d) {
                    break;
                }
                self.deadline_ms = deadline;
                self.idle_pass_budget(&job.key);
                let step = self.start_slot_tile(store, job, true, 0, background, inputs, &mut stats, &mut verbs);
                self.deadline_ms = None;
                self.pass_budget = None;
                match step {
                    Ok(TileStep::Paused) => {
                        paused = true;
                        break;
                    }
                    Ok(_) => {}
                    Err(e) if e.code == ErrorCode::DeviceLost => return Err(e),
                    Err(_) => {
                        self.refuse_overview();
                        break;
                    }
                }
            }
        }
        // Nothing the view shows changed: no tile drawn to present, only work going on.
        stats.tiles_drawn = 0;
        // Refined tiles waiting for the camera to be still count as work going on.
        stats.in_progress =
            paused || !self.tiles.overview_ahead(scale).is_empty() || self.tiles.overview_refined_left(scale) > 0;
        stats.held = self.tiles.len() as u32;
        stats.evicted = self.tiles.stats.evicted;
        stats.submits = self.submits.saturating_sub(submits0);
        if stats.submits > 0 {
            self.note_submitted();
        }
        stats.cpu_ms = now() - t0;
        self.scene.reset();
        self.check()?;
        Ok(stats)
    }

    /// Runs a slice of the pending whole frame between frames, at most `budget_ms`: what `ahead`
    /// does for tiles. Once it finishes (and shows) it counts as one tile drawn with none pending,
    /// so the caller presents it. A frame asked for with other inputs (an edit, another
    /// background, other limits) is dropped unshown and nothing is drawn: the next frame draws
    /// afresh.
    pub fn ahead_whole(
        &mut self,
        store: &Store,
        background: [f32; 4],
        generation: u64,
        budget_ms: f64,
    ) -> Result<DrawStats> {
        self.check()?;
        let t0 = now();
        let submits0 = self.submits;
        let inputs = Self::inputs(store, generation, background);
        if self.pending_whole.as_ref().is_some_and(|p| p.inputs != inputs) {
            self.abort_pending_whole();
        }
        let mut stats = match self.advance_pending_whole(store, budget_ms)? {
            Some(mut stats) => {
                stats.tiles_drawn = 1;
                stats.pending = u32::from(self.pending_whole.is_some());
                stats
            }
            None => {
                // A paused slice's work, submitted without a frame.
                if self.submits > submits0 {
                    self.note_submitted();
                }
                DrawStats {
                    pending: u32::from(self.pending_whole.is_some()),
                    in_progress: self.pending_whole.is_some(),
                    ..DrawStats::default()
                }
            }
        };
        stats.submits = self.submits.saturating_sub(submits0);
        stats.cpu_ms = now() - t0;
        Ok(stats)
    }

    /// A present-only frame of a view whose whole frame is drawn over slices: while it's still
    /// being drawn for this view, size and inputs, its stand-in again (the draw goes on); once
    /// it's finished and still the one shown, that frame again. None otherwise.
    pub fn present_sliced_frame(
        &mut self,
        store: &Store,
        view: Affine,
        size: (u32, u32),
        generation: u64,
        background: [f32; 4],
    ) -> Option<Result<DrawStats>> {
        let inputs = Self::inputs(store, generation, background);
        let view_bits = view.as_coeffs().map(f64::to_bits);
        if let Some(p) = self.pending_whole.as_ref() {
            let same = p.view_bits == view_bits
                && (u32::from(p.frame.width), u32::from(p.frame.height)) == size
                && p.inputs == inputs;
            if !same {
                return None;
            }
            let (t0, submits0) = (now(), self.submits);
            return Some(self.present_pending_whole(view, view_bits, background, size, inputs, t0, submits0));
        }
        self.present_finished_whole(view_bits, size, inputs)
    }

    #[allow(clippy::too_many_arguments)]
    fn present_pending_whole(
        &mut self,
        view: Affine,
        view_bits: [u64; 6],
        background: [f32; 4],
        size: (u32, u32),
        inputs: DrawInputs,
        t0: f64,
        submits0: u32,
    ) -> Result<DrawStats> {
        if let Some(shown) = self.present_finished_whole(view_bits, size, inputs) {
            return shown;
        }
        let mut stats = self.present_motion_standin(view, background, size.0, size.1, t0, submits0, false)?;
        stats.pending = stats.pending.max(1);
        stats.in_progress = true;
        Ok(stats)
    }

    /// Shows again the whole frame drawn over slices when it's still the one shown and it's for
    /// this view, size and inputs.
    #[inline(never)]
    fn present_finished_whole(
        &mut self,
        view_bits: [u64; 6],
        size: (u32, u32),
        inputs: DrawInputs,
    ) -> Option<Result<DrawStats>> {
        let key = self.sliced_frame?;
        let matches = key.view_bits == view_bits && key.size == size && key.inputs == inputs;
        let cur = self.cur.filter(|_| matches)?;
        let (t0, submits0) = (now(), self.submits);
        let scale = f64::from_bits(view_bits[0]);
        let pending = self.pending_whole.is_some();
        let stats = DrawStats {
            direct: true,
            plan: if pending { 1 } else { key.plan },
            exact: key.exact && !pending,
            standin: !key.exact || pending,
            pending: u32::from(pending),
            in_progress: pending,
            held: self.tiles.len() as u32,
            evicted: self.tiles.stats.evicted,
            // The time between frames still has the overview to draw (`ahead_overview`).
            queued: self.tiles.overview_left(scale),
            ..DrawStats::default()
        };
        Some(self.finish_frame(cur, stats, t0, submits0, None))
    }

    /// Runs the pending whole frame until `budget_ms` runs out. Returns its counts once it
    /// finished and showed. Never drops view caches or runs an unbudgeted whole pass on a memory
    /// limit: `step_pending_whole` steps down to a budgeted coarse fallback instead, and schedules
    /// one quiet-gated retry once tile pages can be dropped.
    #[inline(never)]
    fn advance_pending_whole(&mut self, store: &Store, budget_ms: f64) -> Result<Option<DrawStats>> {
        let Some(mut pending) = self.pending_whole.take() else {
            return Ok(None);
        };
        let budgeted = budget_ms > 0.0;
        self.deadline_ms = budgeted.then(|| now() + self.walk_budget_ms(budget_ms));
        let result = self.step_pending_whole(store, &mut pending, budgeted);
        self.deadline_ms = None;
        let mut stats = match result {
            Ok(None) => {
                self.pending_whole = Some(pending);
                return Ok(None);
            }
            Ok(Some(stats)) => stats,
            Err(e) => {
                self.drop_pending_stage(&mut pending);
                return Err(e);
            }
        };
        let retry = !stats.exact && pending.retry == 1;
        self.sliced_frame = Some(SlicedFrame {
            view_bits: pending.view_bits,
            size: (u32::from(pending.frame.width), u32::from(pending.frame.height)),
            inputs: pending.inputs,
            exact: stats.exact,
            plan: stats.plan,
        });
        if retry {
            stats.plan = 1;
            stats.standin = true;
        }
        // The overview, for a view that never had tiles, and what's left of it reported from this
        // first presentation on (`present_finished_whole` after), so the time between frames
        // wakes to draw it.
        self.set_overview(store);
        stats.queued = stats
            .queued
            .max(self.tiles.overview_left(f64::from_bits(pending.view_bits[0])));
        if retry {
            pending.retry = 2;
            pending.stage = PendingStage::Retry;
            self.pending_whole = Some(pending);
            stats.pending = 1;
            stats.in_progress = true;
        }
        Ok(Some(stats))
    }

    /// Moves an already-begun pass's active draw into `pass.paused` when setup exhausted the
    /// slice budget, so `self.active` is never left dangling across a stand-in presentation.
    #[inline(never)]
    fn pause_begun(&mut self, pass: &mut WholePass) {
        pass.paused = Some(PausedWalk {
            active: self.active.take().expect("a begun pass"),
            scratch: self.active_scratch,
            backdrop_gen: self.backdrop_gen,
            backdrop_blur_written: self.backdrop_blur_written,
            checkpoint: None,
        });
        self.scene.reset();
    }

    /// Starts the halo stage after a native limit, or queues `CoarseStart(1)` if halo setup itself
    /// hits a memory limit or there is no halo plan.
    #[inline(never)]
    fn start_halo_or_coarse(&mut self, pending: &mut PendingWhole) -> Result<PendingStage> {
        let Some(plan) = pending.plan.as_ref().filter(|p| p.use_coarse_halo) else {
            return Ok(PendingStage::CoarseStart(1));
        };
        match self.begin_reader_halo(
            &pending.frame,
            pending.background,
            pending.inputs.generation,
            false,
            plan,
        ) {
            Ok(run) => Ok(PendingStage::Halo(Box::new(run))),
            Err(e) if e.code == ErrorCode::Limit => {
                self.mark_retry(&mut pending.retry, &e, 0, 0);
                Ok(PendingStage::CoarseStart(1))
            }
            Err(e) => Err(e),
        }
    }

    fn is_memory_limit(e: &EngineError) -> bool {
        let b = e.message.as_bytes();
        e.code == ErrorCode::Limit && (b.ends_with(b" MiB") || b.ends_with(b"available"))
    }

    fn memory_limit_shortfall(&self, e: &EngineError) -> Option<usize> {
        if !Self::is_memory_limit(e) {
            return None;
        }
        Some(if e.message.as_bytes().ends_with(b"available") {
            self.readers.last_limit_shortfall.get()
        } else {
            self.last_limit_shortfall.get()
        })
    }

    /// Lower-bound GPU working-set bytes required by `HaloStage::Final` (colour+depth scratch,
    /// reader working planes, and nested isolation targets enclosing visible readers).
    fn halo_stage_min_work(store: &Store, frame: &Frame, plan: &ViewportHaloPlan) -> usize {
        let native = plan.native_samples;
        let native_px =
            ((native.x1 - native.x0).max(0) as usize).saturating_mul((native.y1 - native.y0).max(0) as usize);
        // Colour+depth scratch (8 B/px) + reader backdrop/delta/work planes (12 B/px)
        // + nested isolation offscreens (8 B/px each).
        native_px
            .saturating_mul(20)
            .saturating_add(store.reader_isolation_bytes(frame.view, native))
    }

    fn mark_retry(&self, retry: &mut u8, e: &EngineError, extra_freed: usize, stage_min_work: usize) {
        if *retry != 0 {
            return;
        }
        let Some(shortfall) = self.memory_limit_shortfall(e) else {
            return;
        };
        let page_bytes = self.pages.len() * self.page_bytes();
        let steady_without_pages = self.bytes_beside_tiles() + self.readbacks.bytes.get();
        let room_without_pages = self.budget.saturating_sub(steady_without_pages);
        if crate::tiles::retry_covers_shortfall(page_bytes, extra_freed, shortfall, room_without_pages, stage_min_work)
        {
            *retry = 1;
        }
    }

    /// Frees the inactive frame buffer while keeping `frames[cur]` shown on screen.
    fn drop_spare_frame(&mut self) {
        if self.frames.len() > 1
            && let Some(last) = self.frames.pop()
        {
            let old = if self.cur == Some(1) {
                self.cur = Some(0);
                std::mem::replace(&mut self.frames[0], last)
            } else {
                last
            };
            self.bytes -= Self::frame_bytes(old.width, old.height);
            old.texture.destroy();
            self.screen.standin = None;
            self.direct_slices = None;
        }
    }

    /// A retried pass refused again for GPU memory: drops the overview page and inactive spare
    /// frame (keeping `frames[cur]` on screen) and asks for one final try (`retry = 3`).
    #[inline(never)]
    fn retry_without_overview(&mut self, retry: &mut u8, e: Option<&EngineError>) -> bool {
        if *retry != 2
            || e.is_some_and(|err| !Self::is_memory_limit(err))
            || (self.overview_page.is_none() && self.frames.len() <= 1)
        {
            return false;
        }
        *retry = 3;
        self.tiles.clear();
        self.drop_overview_page();
        self.drop_spare_frame();
        self.trim_transient();
        true
    }

    /// Handles a `Limit` from `Start` or `Native`: trims transient caches and schedules retry
    /// steps on a real memory limit, settles on an already-drawn `reader-halo` (`plan: 4`)
    /// stand-in if retry still failed, or transitions to `Halo`/`CoarseStart`.
    #[inline(never)]
    fn handle_native_limit(
        &mut self,
        pending: &mut PendingWhole,
        size: (u32, u32),
        err: Option<&EngineError>,
    ) -> Result<Option<DrawStats>> {
        if let Some(e) = err {
            let before = self.bytes();
            self.trim_transient();
            let freed = before.saturating_sub(self.bytes());
            self.mark_retry(&mut pending.retry, e, freed, 0);
            if self.retry_without_overview(&mut pending.retry, Some(e)) {
                pending.stage = PendingStage::Start;
                return Ok(None);
            }
        }
        if pending.retry >= 2
            && self.sliced_frame.is_some_and(|f| f.plan == 4)
            && let Some(shown) = self.present_finished_whole(pending.view_bits, size, pending.inputs)
        {
            return shown.map(Some);
        }
        pending.stage = self.start_halo_or_coarse(pending)?;
        Ok(None)
    }

    /// Starts a scratch tile draw: ensures scratch, resets per-tile state, and begins `active`.
    #[inline(never)]
    fn begin_scratch_draw(
        &mut self,
        side: u32,
        tile_halo: i32,
        clip_apron_glass: bool,
        view: Affine,
        background: [f32; 4],
        detail: bool,
    ) -> Result<()> {
        self.ensure_scratch(side)?;
        self.masks.begin_frame();
        self.atlas.at = (0, 0, 0);
        self.scene.reset_and_resize(side as u16, side as u16);
        self.readers.begin_frame();
        self.blur.begin_frame();
        self.shadow.begin_frame();
        self.bump_backdrop_gen();
        let glass_display_area = (clip_apron_glass && tile_halo > 0).then_some(IRect {
            x0: tile_halo,
            y0: tile_halo,
            x1: tile_halo + TILE as i32,
            y1: tile_halo + TILE as i32,
        });
        self.begin_active(
            None,
            None,
            glass_display_area,
            (tile_halo, tile_halo),
            view,
            side,
            side,
            background,
            detail,
        );
        Ok(())
    }

    /// Flushes `self.scene`, optionally copies the active scratch into a frame or tile page,
    /// submits, and trims transient pools.
    #[inline(never)]
    fn finish_scratch_to_frame(
        &mut self,
        copy: Option<(bool, usize, (u32, u32), CoarseTile)>,
        flush_why: u8,
    ) -> Result<ActiveDraw> {
        self.flush_why = flush_why;
        if let Err(e) = self.flush_scene_gpu(true) {
            self.discard_draw();
            return Err(e);
        }
        if let Some((is_page, idx, src_origin, (x0, y0, tw, th))) = copy {
            let mut encoder = self.take_encoder("copy scratch");
            let (sw, sh) = {
                let s = self.scratches[self.active_scratch].as_ref().expect("scratch");
                (s.width, s.height)
            };
            if !is_page && src_origin == (0, 0) && (sw < tw || sh < th) {
                self.blit_scratch_scaled(&mut encoder, idx, (tw, th), (sw, sh));
            } else {
                let source = &self.scratches[self.active_scratch].as_ref().expect("scratch").texture;
                let destination = if is_page {
                    &self.page(idx).texture
                } else {
                    &self.frames[idx].texture
                };
                copy_rect(&mut encoder, source, destination, src_origin, (x0, y0), (tw, th));
            }
            self.stash_encoder(encoder);
        }
        self.submit_active_encoder();
        let active = self.active.take().expect("active draw");
        self.clear_clip_mask_cache();
        self.recycle_scene_textures();
        if flush_why != 3 {
            self.trim_pools(GPU_POOL_KEEP_BYTES);
        }
        Ok(active)
    }

    /// Bilinearly upscales the active scratch texture (`src_size`) to `frames[dst]` (`dst_size`)
    /// using the compositor pipeline for a scaled-down coarse fallback pass.
    #[inline(never)]
    fn blit_scratch_scaled(
        &mut self,
        encoder: &mut wgpu::CommandEncoder,
        dst: usize,
        dst_size: (u32, u32),
        src_size: (u32, u32),
    ) {
        self.ensure_compositor();
        let c = self.compositor.as_mut().expect("compositor");
        let (w, h) = (dst_size.0 as f32, dst_size.1 as f32);
        let (sw, sh) = (src_size.0 as f32, src_size.1 as f32);
        let quad: [f32; 12] = [
            0.0,
            0.0,
            w,
            h,
            0.0,
            0.0,
            1.0,
            1.0,
            0.5 / sw,
            0.5 / sh,
            (sw - 0.5) / sw,
            (sh - 0.5) / sh,
        ];
        c.write_quads(&self.device, &self.queue, &[quad]);
        c.set_size(&self.queue, dst_size);
        let scratch = self.scratches[self.active_scratch].as_ref().expect("scratch");
        let group = c.create_bind_group(&self.device, &scratch.view, "composite");
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("composite"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &self.frames[dst].view,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                    store: wgpu::StoreOp::Store,
                },
            })],
            ..Default::default()
        });
        pass.set_pipeline(&c.pipeline);
        pass.set_vertex_buffer(0, c.instances.slice(0..48));
        pass.set_bind_group(0, &group, &[]);
        pass.draw(0..4, 0..1);
    }

    /// Runs `pending`'s stages on for this slice: sets up its native pass (or, where the view
    /// needs it, its reduced reader-halo frame), walks it, and finishes it. A native or halo pass
    /// that hits a memory limit steps down to a budgeted coarse fallback (divisor 1, 2 or 4)
    /// instead of wiping caches or running an unbudgeted whole pass.
    #[inline(never)]
    fn step_pending_whole(
        &mut self,
        store: &Store,
        pending: &mut PendingWhole,
        budgeted: bool,
    ) -> Result<Option<DrawStats>> {
        let generation = pending.inputs.generation;
        let size = (u32::from(pending.frame.width), u32::from(pending.frame.height));
        loop {
            match std::mem::replace(&mut pending.stage, PendingStage::Start) {
                PendingStage::Start => {
                    let mut halo = false;
                    if let Some(p) = pending.plan.as_ref().filter(|p| p.use_coarse_halo)
                        && !self.prefers_padded_view(p, size, store.limits.padded_view_pixels)
                    {
                        halo = true;
                        let extra = if pending.retry == 0 {
                            self.pages.len() * self.page_bytes()
                        } else if pending.retry == 2 {
                            self.overview_page.as_ref().map_or(0, |o| o.bytes)
                        } else {
                            0
                        };
                        if extra > 0
                            && self.prefers_padded_with(
                                p,
                                size,
                                store.limits.padded_view_pixels,
                                extra + self.pool_bytes,
                            )
                        {
                            if pending.retry == 0 {
                                pending.retry = 1;
                            } else if self.retry_without_overview(&mut pending.retry, None) {
                                halo = false;
                            }
                        }
                    }
                    let native = if halo {
                        Err(EngineError::limit("padded reader view exceeds whole-frame budget"))
                    } else {
                        let samples = pending.plan.as_ref().map(|p| p.samples);
                        self.begin_whole_pass(
                            store,
                            &pending.frame,
                            pending.background,
                            generation,
                            false,
                            None,
                            samples,
                            true,
                        )
                    };
                    match native {
                        Ok(WholeStart::Unchanged(stats)) => return Ok(Some(stats)),
                        Ok(WholeStart::Pass(pass)) => pending.stage = PendingStage::Native(pass),
                        Err(e) if e.code == ErrorCode::Limit => {
                            if let Some(stats) = self.handle_native_limit(pending, size, (!halo).then_some(&e))? {
                                return Ok(Some(stats));
                            }
                        }
                        Err(e) => return Err(e),
                    }
                }
                PendingStage::Native(mut pass) => {
                    let res = match self.walk_whole_pass(store, &mut pass, budgeted) {
                        Ok(false) => {
                            pending.stage = PendingStage::Native(pass);
                            return Ok(None);
                        }
                        Ok(true) => self.finish_whole_pass(pass, generation),
                        Err(e) => Err(e),
                    };
                    match res {
                        Ok(stats) => return Ok(Some(stats)),
                        Err(e) if e.code == ErrorCode::Limit => {
                            if let Some(stats) = self.handle_native_limit(pending, size, Some(&e))? {
                                return Ok(Some(stats));
                            }
                        }
                        Err(e) => return Err(e),
                    }
                }
                PendingStage::Halo(mut run) => {
                    let plan = pending
                        .plan
                        .as_ref()
                        .filter(|p| p.use_coarse_halo)
                        .expect("a halo plan");
                    match self.step_reader_halo(store, &mut run, plan, budgeted) {
                        Ok(None) => {
                            pending.stage = PendingStage::Halo(run);
                            return Ok(None);
                        }
                        Ok(Some(stats)) => {
                            self.end_reader_halo(&mut run, plan, true);
                            return Ok(Some(stats));
                        }
                        Err(e) => {
                            self.end_reader_halo(&mut run, plan, false);
                            if e.code == ErrorCode::Limit {
                                // Release transient halo pools before measuring steady headroom
                                // without tile pages (`CoarseStart` trims them immediately anyway).
                                self.trim_transient();
                                let min_work = Self::halo_stage_min_work(store, &pending.frame, plan);
                                self.mark_retry(&mut pending.retry, &e, 0, min_work);
                                pending.stage = if self.retry_without_overview(&mut pending.retry, Some(&e)) {
                                    PendingStage::Start
                                } else {
                                    PendingStage::CoarseStart(1)
                                };
                            } else {
                                return Err(e);
                            }
                        }
                    }
                }
                PendingStage::Retry => {
                    if now() - self.last_input_ms < RETRY_QUIET_MS {
                        pending.stage = PendingStage::Retry;
                        return Ok(None);
                    }
                    self.tiles.clear_keeping_overview();
                    self.fit_tiles(0);
                    self.trim_transient();
                }
                PendingStage::CoarseStart(div) => {
                    self.trim_transient();
                    let (sw, sh) = (size.0.div_ceil(div).max(1), size.1.div_ceil(div).max(1));
                    let scaled = if div == 1 {
                        pending.frame
                    } else {
                        Frame {
                            width: sw as u16,
                            height: sh as u16,
                            view: Affine::scale_non_uniform(
                                f64::from(sw) / f64::from(size.0),
                                f64::from(sh) / f64::from(size.1),
                            ) * pending.frame.view,
                            detail: false,
                            area: IRect {
                                x0: 0,
                                y0: 0,
                                x1: sw as i32,
                                y1: sh as i32,
                            },
                        }
                    };
                    match self.begin_whole_pass(store, &scaled, pending.background, generation, true, None, None, true)
                    {
                        Ok(WholeStart::Unchanged(stats)) => return Ok(Some(stats)),
                        Ok(WholeStart::Pass(mut pass)) => {
                            pass.size = size;
                            pass.view = pending.frame.view;
                            pending.stage = PendingStage::CoarseWhole(div, pass);
                        }
                        Err(e) if e.code == ErrorCode::Limit && div < 4 => {
                            pending.stage = PendingStage::CoarseStart(div * 2);
                        }
                        Err(e) => return Err(e),
                    }
                }
                PendingStage::CoarseWhole(div, mut pass) => {
                    let res = match self.walk_whole_pass(store, &mut pass, budgeted) {
                        Ok(false) => {
                            pending.stage = PendingStage::CoarseWhole(div, pass);
                            return Ok(None);
                        }
                        Ok(true) => self.finish_whole_pass(pass, generation),
                        Err(e) => Err(e),
                    };
                    match res {
                        Ok(mut stats) => {
                            stats.exact = false;
                            stats.standin = true;
                            stats.plan = 1;
                            return Ok(Some(stats));
                        }
                        Err(e) if e.code == ErrorCode::Limit && div < 4 => {
                            pending.stage = PendingStage::CoarseStart(div * 2);
                        }
                        Err(e) => return Err(e),
                    }
                }
            }
            // A stage's setup may have used the slice up.
            if budgeted && self.deadline_reached() {
                match &mut pending.stage {
                    PendingStage::Native(pass) | PendingStage::CoarseWhole(_, pass) if pass.paused.is_none() => {
                        self.pause_begun(pass);
                    }
                    _ => {}
                }
                return Ok(None);
            }
        }
    }

    /// Drops what `pending`'s stage holds (a paused walk's target and glass masks, a halo
    /// frame's captures); it starts again from its setup if run again.
    fn drop_pending_stage(&mut self, pending: &mut PendingWhole) {
        match std::mem::replace(&mut pending.stage, PendingStage::Start) {
            PendingStage::Start | PendingStage::CoarseStart(_) | PendingStage::Retry => {}
            PendingStage::Native(pass) | PendingStage::CoarseWhole(_, pass) => {
                if pass.paused.is_some() {
                    self.drop_walk();
                }
            }
            PendingStage::Halo(mut run) => {
                let plan = pending
                    .plan
                    .as_ref()
                    .filter(|p| p.use_coarse_halo)
                    .expect("a halo plan");
                self.end_reader_halo(&mut run, plan, false);
            }
        }
    }

    /// Drops the whole frame being drawn over slices, if any, and forgets the one shown.
    fn abort_pending_whole(&mut self) {
        self.sliced_frame = None;
        if let Some(mut pending) = self.pending_whole.take() {
            self.drop_pending_stage(&mut pending);
        }
    }

    /// Draws an untiled frame when a reader exceeds the tile halo or a whole draw is cheaper.
    #[allow(clippy::too_many_arguments)]
    pub fn render_whole(
        &mut self,
        store: &Store,
        frame: &Frame,
        background: [f32; 4],
        generation: u64,
        moving: bool,
        prefix: Option<(u64, usize)>,
        halo_plan: Option<&ViewportHaloPlan>,
        wide_plan: Option<&halo::WideBlurPlan>,
    ) -> Result<DrawStats> {
        self.abort_pending_tile();
        self.abort_pending_whole();
        self.pass_budget = None;
        self.opening_pending = false;
        if let Some(wp) = wide_plan {
            let inputs = Self::inputs(store, generation, background);
            let need_build = !matches!(
                self.wide_blur.as_ref(),
                Some(WideBlurState::Ready(c)) if c.covers(wp, inputs)
            );
            if need_build {
                self.abort_wide_blur();
                self.wide_blur = Some(WideBlurState::Building(Box::new(WideBlurBuild {
                    plan: wp.clone(),
                    inputs,
                    background,
                    pass: None,
                })));
                let mut wide_stats = DrawStats::default();
                self.step_wide_blur(store, false, &mut wide_stats)?;
            }
            return self.draw_whole_pass(
                store,
                frame,
                background,
                generation,
                moving,
                prefix,
                Some(wp.residual_samples),
            );
        }
        self.abort_wide_blur();
        let samples = halo_plan.map(|p| p.samples);
        let size = (u32::from(frame.width), u32::from(frame.height));
        if !moving
            && self.whole_reader_halo
            && self.last.is_some_and(|l| l.view == frame.view && l.size == size)
            && self.shown == Some((generation, background.map(f32::to_bits), false))
            && self.whole_samples == Some(samples)
        {
            let submits0 = self.submits;
            let stats = DrawStats {
                direct: true,
                plan: 4,
                standin: true,
                ..DrawStats::default()
            };
            return self.finish_frame(self.cur.expect("unchanged frame"), stats, now(), submits0, None);
        }
        let skip_native_whole = halo_plan
            .is_some_and(|p| p.use_coarse_halo && !self.prefers_padded_view(p, size, store.limits.padded_view_pixels));
        let result = if skip_native_whole {
            Err(EngineError::limit("padded reader view exceeds whole-frame budget"))
        } else {
            self.draw_whole_pass(store, frame, background, generation, moving, prefix, samples)
        };
        let Some(plan) = halo_plan.filter(|p| p.use_coarse_halo) else {
            return result;
        };
        if result.as_ref().is_err_and(|e| e.code == ErrorCode::Limit) {
            let halo_res = self.render_reader_halo(store, frame, background, generation, moving, plan);
            if halo_res.as_ref().is_err_and(|e| e.code == ErrorCode::Limit) {
                if !moving {
                    self.fit_tiles(0);
                }
                self.trim_pools(0);
                self.readers.flush_retired();
                return self.render_reader_halo(store, frame, background, generation, moving, plan);
            }
            return halo_res;
        }
        result
    }

    /// Captures exact device-aligned edge strips for unfilled `EdgeMode::Clamp` clip frames
    /// before a reduced halo tier runs its blur passes.
    #[allow(clippy::too_many_arguments)]
    fn capture_clamp_strips(
        &mut self,
        store: &Store,
        frame: &Frame,
        background: [f32; 4],
        generation: u64,
        clips: &[halo::HaloClampClip],
        render_divisor: i32,
        offset: (i32, i32),
    ) {
        if clips.is_empty() || render_divisor <= 1 {
            return;
        }
        let max_strip_side = self.max_texture_2d.min(4096);
        let render_strip = |gpu: &mut Self,
                            vertical: bool,
                            ex0: i32,
                            ey0: i32,
                            sw: u32,
                            sh: u32,
                            d_strip: i32,
                            reader_key: (u32, usize)|
         -> Option<HaloPatch> {
            if sw == 0 || sh == 0 || sw > u32::from(u16::MAX) || sh > u32::from(u16::MAX) {
                return None;
            }
            // Keep the perpendicular (short) axis at 1x device-pixel resolution so the 1-pixel
            // clip-edge column/row is never mixed with interior pixels even when the long axis
            // steps down by `d_strip > 1`.
            let scale = if vertical {
                Affine::scale_non_uniform(1.0, 1.0 / f64::from(d_strip))
            } else {
                Affine::scale_non_uniform(1.0 / f64::from(d_strip), 1.0)
            };
            let strip_frame = Frame {
                width: sw as u16,
                height: sh as u16,
                view: scale * Affine::translate((-f64::from(ex0), -f64::from(ey0))) * frame.view,
                detail: false,
                area: IRect {
                    x0: 0,
                    y0: 0,
                    x1: sw as i32,
                    y1: sh as i32,
                },
            };
            gpu.reader_halo.as_mut().expect("reader halo").strip_capture = Some(HaloStripCapture {
                reader_key,
                size: (sw, sh),
                captured: None,
            });
            let ok = gpu
                .draw_whole_pass(store, &strip_frame, background, generation, false, None, None)
                .is_ok();
            let cap = gpu.reader_halo.as_mut().expect("reader halo").strip_capture.take();
            if ok {
                cap.and_then(|c| c.captured)
            } else {
                if let Some(patch) = cap.and_then(|c| c.captured) {
                    gpu.recycle_halo_prefix(patch);
                }
                None
            }
        };

        for clip in clips {
            let l = clip.clip_dev[0].floor() as i32;
            let t = clip.clip_dev[1].floor() as i32;
            let r = clip.clip_dev[2].ceil() as i32;
            let b = clip.clip_dev[3].ceil() as i32;
            if r <= l || b <= t {
                continue;
            }
            let reach = clip.reach_rect;
            let mut set = HaloClampStripSet {
                left: None,
                right: None,
                top: None,
                bottom: None,
            };
            let capture_axis = |gpu: &mut Self,
                                vertical: bool,
                                edge: i32,
                                is_hi: bool,
                                lo_bound: i32,
                                hi_bound: i32,
                                long_start: i32,
                                long_len: u32,
                                d_strip: i32,
                                rpt: u32,
                                off_axis: i32|
             -> Option<HaloClampStrip> {
                let t_dev = if is_hi { edge - 1 } else { edge }.div_euclid(render_divisor);
                let (e0, span_short, weight_px) = if is_hi {
                    let start = (t_dev * render_divisor).max(lo_bound);
                    let s_px = (edge - start).max(1) as u32;
                    (edge - s_px as i32, s_px, (t_dev + 1) * render_divisor - edge)
                } else {
                    let end = ((t_dev + 1) * render_divisor).min(hi_bound);
                    let s_px = (end - edge).max(1) as u32;
                    (edge, s_px, edge - t_dev * render_divisor)
                };
                let (ex0, ey0, sw, sh) = if vertical {
                    (e0, long_start, span_short, long_len)
                } else {
                    (long_start, e0, long_len, span_short)
                };
                render_strip(gpu, vertical, ex0, ey0, sw, sh, d_strip, clip.reader_key).map(|patch| HaloClampStrip {
                    patch,
                    straddle_frame: t_dev + off_axis,
                    clamp_weight: weight_px as f32,
                    samples_per_texel: rpt,
                    long_start_dev: long_start,
                    strip_divisor: d_strip,
                })
            };
            let vy0 = reach.y0.max(t);
            let vy1 = reach.y1.min(b);
            if vy1 > vy0 {
                let span_y = (vy1 - vy0) as u32;
                let d_strip = span_y
                    .div_ceil(max_strip_side)
                    .max(1)
                    .next_power_of_two()
                    .min(render_divisor as u32) as i32;
                let sh = span_y.div_ceil(d_strip as u32).max(1);
                let rpt = (render_divisor / d_strip).max(1) as u32;
                if l > reach.x0 && l < reach.x1 {
                    set.left = capture_axis(self, true, l, false, l, r, vy0, sh, d_strip, rpt, offset.0);
                }
                if r > reach.x0 && r < reach.x1 {
                    set.right = capture_axis(self, true, r, true, l, r, vy0, sh, d_strip, rpt, offset.0);
                }
            }
            let vx0 = reach.x0.max(l);
            let vx1 = reach.x1.min(r);
            if vx1 > vx0 {
                let span_x = (vx1 - vx0) as u32;
                let d_strip = span_x
                    .div_ceil(max_strip_side)
                    .max(1)
                    .next_power_of_two()
                    .min(render_divisor as u32) as i32;
                let sw = span_x.div_ceil(d_strip as u32).max(1);
                let cpt = (render_divisor / d_strip).max(1) as u32;
                if t > reach.y0 && t < reach.y1 {
                    set.top = capture_axis(self, false, t, false, t, b, vx0, sw, d_strip, cpt, offset.1);
                }
                if b > reach.y0 && b < reach.y1 {
                    set.bottom = capture_axis(self, false, b, true, t, b, vx0, sw, d_strip, cpt, offset.1);
                }
            }
            if !set.is_empty()
                && let Some(old) = self
                    .reader_halo
                    .as_mut()
                    .expect("reader halo")
                    .clamp_strips
                    .insert(clip.reader_key, set)
            {
                for patch in old.into_patches() {
                    self.recycle_halo_prefix(patch);
                }
            }
        }
    }

    /// Sets up one supersampled reduced-resolution replay tier that captures eligible reader
    /// outputs: captures its clamp edge strips, swaps its reader planes in and begins its pass.
    /// Returns the pass and its render divisor; the planes stay swapped in until it finishes.
    #[allow(clippy::too_many_arguments)]
    #[inline(never)]
    fn begin_halo_tier(
        &mut self,
        store: &Store,
        frame: &Frame,
        background: [f32; 4],
        generation: u64,
        tier_bounds: IRect,
        coarse_divisor: i32,
        capture_bounds: IRect,
        prog_range: (f32, f32),
        unif_range: (f32, f32),
        is_far: bool,
        supersample_for_blur: bool,
        min_feature_px: f32,
        max_render_divisor: Option<i32>,
        clamp_clips: &[halo::HaloClampClip],
    ) -> Result<(Box<WholePass>, i32)> {
        let (coarse_offset, coarse_size) = halo::replay_grid(tier_bounds, coarse_divisor);
        let (max_side, max_pixels) = if self.fallback_adapter {
            (
                self.max_texture_2d.min(SOFTWARE_HALO_RENDER_MAX_SIDE),
                SOFTWARE_HALO_RENDER_MAX_PIXELS,
            )
        } else {
            (
                self.max_texture_2d.min(HARDWARE_HALO_RENDER_MAX_SIDE),
                HARDWARE_HALO_RENDER_MAX_PIXELS,
            )
        };
        let mut supersample = if supersample_for_blur {
            halo::choose_supersample(coarse_divisor, coarse_size, min_feature_px, max_side, max_pixels)
        } else {
            1
        };
        if let Some(max_rd) = max_render_divisor {
            let max_s = (coarse_divisor / 2).max(1);
            while (coarse_divisor / supersample).max(1) > max_rd && supersample < max_s {
                let next_s = supersample * 2;
                let fw = (coarse_size.0 * next_s) as u32;
                let fh = (coarse_size.1 * next_s) as u32;
                if fw <= max_side && fh <= max_side && (fw as usize).saturating_mul(fh as usize) <= max_pixels {
                    supersample = next_s;
                } else {
                    break;
                }
            }
        }
        // Keep the supersampled replay and its reader/mask/prefix working set comfortably within
        // the GPU memory budget so supersampling steps down gracefully before hitting Limit.
        let scratch_slot = if is_far {
            FAR_HALO_SCRATCH_SLOT
        } else {
            MID_HALO_SCRATCH_SLOT
        };
        let freed = self.scratches[scratch_slot]
            .as_ref()
            .map_or(0, |s| (s.width as usize) * (s.height as usize) * 8);
        let mut trimmed = false;
        while supersample > 1 {
            let fw = (coarse_size.0 * supersample) as usize;
            let fh = (coarse_size.1 * supersample) as usize;
            // Colour + depth + backdrop/delta/blur_source + mask/clip/prefix headroom (~40 B/px).
            if self
                .reserve(fw.saturating_mul(fh).saturating_mul(40), freed, "halo replay")
                .is_ok()
            {
                break;
            }
            if !trimmed
                && self.pool_bytes > 0
                && self
                    .reserve(
                        fw.saturating_mul(fh).saturating_mul(40),
                        freed + self.pool_bytes,
                        "halo replay",
                    )
                    .is_ok()
            {
                trimmed = true;
                self.trim_pools(0);
                continue;
            }
            supersample /= 2;
        }
        let render_divisor = (coarse_divisor / supersample).max(1);
        let offset = (coarse_offset.0 * supersample, coarse_offset.1 * supersample);
        let frame_size = (coarse_size.0 * supersample, coarse_size.1 * supersample);
        // Recycle any previous tier's edge strips and capture fresh ones at this tier's grid.
        let old_strips = std::mem::take(&mut self.reader_halo.as_mut().expect("reader halo").clamp_strips);
        for (_, set) in old_strips.into_vec() {
            for patch in set.into_patches() {
                self.recycle_halo_prefix(patch);
            }
        }
        self.capture_clamp_strips(
            store,
            frame,
            background,
            generation,
            clamp_clips,
            render_divisor,
            offset,
        );
        let transform = Affine::translate((f64::from(offset.0), f64::from(offset.1)))
            * Affine::scale(1.0 / f64::from(render_divisor));
        let coarse = Frame {
            width: frame_size.0 as u16,
            height: frame_size.1 as u16,
            view: transform * frame.view,
            detail: false,
            area: IRect {
                x0: 0,
                y0: 0,
                x1: frame_size.0,
                y1: frame_size.1,
            },
        };
        let visible = ReaderHalo::map_rect_to_grid(capture_bounds, (0, 0), render_divisor, offset);
        self.reader_halo.as_mut().expect("reader halo").capture = Some(HaloTierCapture {
            render_divisor,
            offset,
            frame_size,
            visible,
            prog_min_sigma: prog_range.0,
            prog_max_sigma: prog_range.1,
            unif_min_sigma: unif_range.0,
            unif_max_sigma: unif_range.1,
            is_far,
        });
        self.swap_halo_reader_planes(is_far);
        match self.begin_whole_pass(store, &coarse, background, generation, false, None, None, false) {
            Ok(WholeStart::Pass(pass)) => Ok((pass, render_divisor)),
            Ok(WholeStart::Unchanged(_)) => unreachable!("a capturing halo tier always draws"),
            Err(e) => {
                self.swap_halo_reader_planes(is_far);
                Err(e)
            }
        }
    }

    /// Releases oversized halo scratch targets and reader planes after a frame finishes so
    /// high-supersample tiers do not stay resident in steady-state GPU memory.
    fn release_oversized_halo_storage(&mut self) {
        if let Some(old) = self.scratches[EDGE_STRIP_SCRATCH_SLOT].take() {
            self.bytes -= Self::frame_bytes(old.width, old.height) * 2;
            old.texture.destroy();
        }
        let far_keep = if self.fallback_adapter {
            SOFTWARE_HALO_STEADY_PIXELS
        } else {
            HARDWARE_HALO_STEADY_FAR_PIXELS
        };
        let mid_keep = if self.fallback_adapter {
            SOFTWARE_HALO_STEADY_PIXELS / 2
        } else {
            HARDWARE_HALO_STEADY_MID_PIXELS
        };
        for (slot, planes_idx, keep_px) in [
            (FAR_HALO_SCRATCH_SLOT, 0usize, far_keep),
            (MID_HALO_SCRATCH_SLOT, 1usize, mid_keep),
        ] {
            if self.scratches[slot]
                .as_ref()
                .is_some_and(|s| (s.width as usize).saturating_mul(s.height as usize) > keep_px)
                && let Some(old) = self.scratches[slot].take()
            {
                self.bytes -= Self::frame_bytes(old.width, old.height) * 2;
                old.texture.destroy();
            }
            for plane_slot in &mut self.halo_reader_planes[planes_idx] {
                if plane_slot
                    .as_ref()
                    .is_some_and(|p| (p.width as usize).saturating_mul(p.height as usize) > keep_px)
                    && let Some(old) = plane_slot.take()
                {
                    self.readers.retire(old.texture);
                }
            }
        }
        let border_keep = if self.fallback_adapter { 262_144 } else { 1_048_576 };
        if self
            .readers
            .halo_border_src
            .as_ref()
            .is_some_and(|t| (t.width as usize).saturating_mul(t.height as usize) > border_keep)
            && let Some(old) = self.readers.halo_border_src.take()
        {
            self.readers.retire(old.texture);
        }
    }

    /// Draw the surrounding page at one or two supersampled lower-density tiers and snapshot each
    /// reader's backdrop/blurred stops. The final pass uses these samples for optics and renders
    /// the visible page at device resolution.
    fn render_reader_halo(
        &mut self,
        store: &Store,
        frame: &Frame,
        background: [f32; 4],
        generation: u64,
        moving: bool,
        plan: &ViewportHaloPlan,
    ) -> Result<DrawStats> {
        let mut run = self.begin_reader_halo(frame, background, generation, moving, plan)?;
        let result = self
            .step_reader_halo(store, &mut run, plan, false)
            .map(|done| done.expect("an unbudgeted halo frame finishes"));
        self.end_reader_halo(&mut run, plan, result.is_ok());
        result
    }

    /// Starts a reduced reader-halo frame (`render_reader_halo`): its stages run in
    /// `step_reader_halo`, and `end_reader_halo` releases what they captured.
    #[inline(never)]
    fn begin_reader_halo(
        &mut self,
        frame: &Frame,
        background: [f32; 4],
        generation: u64,
        moving: bool,
        plan: &ViewportHaloPlan,
    ) -> Result<HaloRun> {
        let native = plan.native_samples;
        let native_pixels = ((native.x1 - native.x0) as usize).saturating_mul((native.y1 - native.y0) as usize);
        let displayed_pixels = usize::from(frame.width) * usize::from(frame.height);
        if self.fallback_adapter
            && native != frame.area
            && native_pixels > displayed_pixels.saturating_mul(2).max(SOFTWARE_FILTER_PIXELS)
        {
            return Err(EngineError::limit(
                "viewport filters exceed the software GPU raster budget",
            ));
        }
        let lowest_div = plan.mid_divisor.unwrap_or(plan.far_divisor);
        self.reader_halo = Some(ReaderHalo {
            capture: None,
            strip_capture: None,
            wide_capture: false,
            wide_targets: Vec::new(),
            wide_last: None,
            wide_done: false,
            native_prog_cutover: halo::progressive_cutover_sigma(lowest_div),
            native_unif_cutover: halo::uniform_cutover_sigma(lowest_div),
            downstream_readers: plan.downstream_readers.clone(),
            downstream_mid_readers: plan.downstream_mid_readers.clone(),
            coarse_post_scopes: plan.coarse_post_scopes.clone(),
            inside_coarse_post_scope: 0,
            post_scopes: HaloMap::new(),
            prefixes: HaloMap::new(),
            blurred: HaloMap::new(),
            progressive_mid: HaloMap::new(),
            progressive_far: HaloMap::new(),
            clamp_strips: HaloMap::new(),
        });

        // If a mid-range tier exists and upstream blurs feed downstream readers, ensure the far
        // tier captures the full aligned mid-tier replay extent so mid-tier readers never miss
        // coverage at the 64-texel-padded edge.
        let far_capture_bounds = match (plan.mid_samples, plan.mid_divisor) {
            (Some(mid), Some(mid_div)) if !plan.downstream_readers.is_empty() => {
                let (mid_off, mid_size) = halo::replay_grid(mid, mid_div);
                let mid_device = IRect {
                    x0: (-mid_off.0).saturating_mul(mid_div),
                    y0: (-mid_off.1).saturating_mul(mid_div),
                    x1: (mid_size.0 - mid_off.0).saturating_mul(mid_div),
                    y1: (mid_size.1 - mid_off.1).saturating_mul(mid_div),
                };
                halo::rect_union(plan.capture_bounds, mid_device)
            }
            _ => plan.capture_bounds,
        };
        Ok(HaloRun {
            frame: *frame,
            background,
            generation,
            moving,
            far_capture_bounds,
            stage: HaloStage::Far,
            pass: None,
            tier_divisor: 0,
            far_render_div: 0,
            replay: DrawStats::default(),
            t0: now(),
        })
    }

    /// Runs `run`'s stages on: the far tier, the mid tier if any, then the final pass. With
    /// `allow_yield` a stage's pass pauses at the deadline (`deadline_ms`) and the next call
    /// resumes it, so the frame's work spreads over slices; between slices a tier's reader planes
    /// are swapped back out. Returns the finished frame's counts, or None while it isn't done.
    #[inline(never)]
    fn step_reader_halo(
        &mut self,
        store: &Store,
        run: &mut HaloRun,
        plan: &ViewportHaloPlan,
        allow_yield: bool,
    ) -> Result<Option<DrawStats>> {
        #[inline(never)]
        fn accumulate(dst: &mut DrawStats, src: &DrawStats) {
            dst.encode_ms += src.encode_ms;
            dst.render_ms += src.render_ms;
            dst.prepare_masks_ms += src.prepare_masks_ms;
            dst.vello_render_ms += src.vello_render_ms;
            dst.reader_ms += src.reader_ms;
            dst.shadow_ms += src.shadow_ms;
            dst.submit_ms += src.submit_ms;
            dst.submits += src.submits;
            dst.vello_renders += src.vello_renders;
            dst.glass_ops += src.glass_ops;
            dst.glass_batched += src.glass_batched;
            dst.bg_blur_ops += src.bg_blur_ops;
            dst.shadow_ops += src.shadow_ops;
            dst.shadow_hits += src.shadow_hits;
        }
        let far_prog_cut = halo::progressive_cutover_sigma(plan.far_divisor);
        let far_unif_cut = halo::uniform_cutover_sigma(plan.far_divisor);
        loop {
            match run.stage {
                HaloStage::Far | HaloStage::Mid => {
                    let is_far = run.stage == HaloStage::Far;
                    let mut pass = match run.pass.take() {
                        Some(pass) => {
                            self.swap_halo_reader_planes(is_far);
                            pass
                        }
                        None => {
                            let (pass, divisor) = if is_far {
                                let far_max_render_divisor = plan.coarse_post_min_sigma.is_finite().then(|| {
                                    (plan.coarse_post_min_sigma / halo::HALO_MIN_COARSE_SIGMA)
                                        .floor()
                                        .max(1.0) as i32
                                });
                                self.begin_halo_tier(
                                    store,
                                    &run.frame,
                                    run.background,
                                    run.generation,
                                    plan.samples,
                                    plan.far_divisor,
                                    run.far_capture_bounds,
                                    (far_prog_cut, f32::INFINITY),
                                    (far_unif_cut, f32::INFINITY),
                                    true,
                                    plan.far_has_blur,
                                    plan.far_min_feature_px,
                                    far_max_render_divisor,
                                    &plan.clamp_clips,
                                )?
                            } else {
                                let (Some(mid_samples), Some(mid_div)) = (plan.mid_samples, plan.mid_divisor) else {
                                    unreachable!("a mid stage has a mid tier");
                                };
                                self.begin_halo_tier(
                                    store,
                                    &run.frame,
                                    run.background,
                                    run.generation,
                                    mid_samples,
                                    mid_div,
                                    plan.capture_bounds,
                                    (halo::progressive_cutover_sigma(mid_div), far_prog_cut),
                                    (halo::uniform_cutover_sigma(mid_div), far_unif_cut),
                                    false,
                                    true,
                                    plan.mid_min_feature_px,
                                    Some(run.far_render_div),
                                    &plan.clamp_clips,
                                )?
                            };
                            run.tier_divisor = divisor;
                            // Its setup (the clamp edge strips) may have used the slice up: keep
                            // the pass, its target taken along as a paused walk's is.
                            if allow_yield && self.deadline_reached() {
                                let mut pass = pass;
                                self.pause_begun(&mut pass);
                                self.swap_halo_reader_planes(is_far);
                                run.pass = Some(pass);
                                return Ok(None);
                            }
                            pass
                        }
                    };
                    let walked = self.walk_whole_pass(store, &mut pass, allow_yield);
                    match walked {
                        Ok(true) => {}
                        Ok(false) => {
                            self.swap_halo_reader_planes(is_far);
                            run.pass = Some(pass);
                            return Ok(None);
                        }
                        Err(e) => {
                            self.swap_halo_reader_planes(is_far);
                            return Err(e);
                        }
                    }
                    let finished = self.finish_whole_pass(pass, run.generation);
                    self.swap_halo_reader_planes(is_far);
                    accumulate(&mut run.replay, &finished?);
                    run.stage = if is_far && plan.mid_samples.is_some() && plan.mid_divisor.is_some() {
                        run.far_render_div = run.tier_divisor;
                        HaloStage::Mid
                    } else {
                        HaloStage::Final
                    };
                }
                HaloStage::Final => {
                    let mut pass = match run.pass.take() {
                        Some(pass) => pass,
                        None => {
                            self.reader_halo.as_mut().expect("reader halo").capture = None;
                            let native = plan.native_samples;
                            let samples = (native != run.frame.area).then_some(native);
                            let mut pass = match self.begin_whole_pass(
                                store,
                                &run.frame,
                                run.background,
                                run.generation,
                                run.moving,
                                None,
                                samples,
                                allow_yield,
                            )? {
                                WholeStart::Pass(pass) => pass,
                                WholeStart::Unchanged(_) => unreachable!("a halo frame always draws"),
                            };
                            if allow_yield && self.deadline_reached() {
                                self.pause_begun(&mut pass);
                                run.pass = Some(pass);
                                return Ok(None);
                            }
                            pass
                        }
                    };
                    if !self.walk_whole_pass(store, &mut pass, allow_yield)? {
                        run.pass = Some(pass);
                        return Ok(None);
                    }
                    let mut stats = self.finish_whole_pass(pass, run.generation)?;
                    accumulate(&mut stats, &run.replay);
                    stats.cpu_ms = now() - run.t0;
                    return Ok(Some(stats));
                }
            }
            // Between stages: a new stage's setup (its strips) waits for the next slice.
            if allow_yield && self.deadline_reached() {
                return Ok(None);
            }
        }
    }

    fn recycle_reader_halo(&mut self, halo: ReaderHalo) {
        for (_, p) in halo.prefixes.into_vec() {
            self.recycle_halo_prefix(p);
        }
        for (_, p) in halo.blurred.into_vec() {
            self.recycle_halo_prefix(p);
        }
        for (_, p) in halo.progressive_mid.into_vec() {
            self.recycle_halo_prefix(p.patch);
        }
        for (_, p) in halo.progressive_far.into_vec() {
            self.recycle_halo_prefix(p.patch);
        }
        for (_, s) in halo.clamp_strips.into_vec() {
            for p in s.into_patches() {
                self.recycle_halo_prefix(p);
            }
        }
        for (_, ps) in halo.post_scopes.into_vec() {
            self.recycle_halo_prefix(ps.main);
            if let Some(b) = ps.backdrop {
                self.recycle_halo_prefix(b);
            }
        }
    }

    fn abort_wide_blur(&mut self) {
        match self.wide_blur.take() {
            Some(WideBlurState::Building(mut b)) => {
                if b.pass.take().is_some_and(|p| p.paused.is_some()) {
                    self.drop_walk();
                }
                if let Some(halo) = self.reader_halo.take() {
                    self.recycle_reader_halo(halo);
                }
                self.release_oversized_halo_storage();
            }
            Some(WideBlurState::Ready(cache)) => {
                for (_, p) in cache.blurred.into_vec() {
                    self.recycle_halo_prefix(p);
                }
            }
            None => {}
        }
    }

    fn abort_wide_blur_building(&mut self) {
        if matches!(self.wide_blur, Some(WideBlurState::Building(_))) {
            self.abort_wide_blur();
        }
    }

    #[inline(never)]
    fn begin_wide_blur_pass(&mut self, store: &Store, build: &WideBlurBuild) -> Result<Box<WholePass>> {
        let plan = &build.plan;
        let cap_d2_origin = (plan.cap_grid.x0 / 2, plan.cap_grid.y0 / 2);
        let cap_w = ((plan.cap_grid.x1 - plan.cap_grid.x0) / 2).max(1);
        let cap_h = ((plan.cap_grid.y1 - plan.cap_grid.y0) / 2).max(1);
        self.check_texture_size(cap_w as u32, cap_h as u32, "wide blur capture")?;
        let freed = self.scratches[FAR_HALO_SCRATCH_SLOT]
            .as_ref()
            .map_or(0, |s| (s.width as usize) * (s.height as usize) * 8);
        let est = (cap_w as usize).saturating_mul(cap_h as usize).saturating_mul(28);
        self.reserve_or_trim(est, freed, "wide blur capture")?;
        let offset = (-cap_d2_origin.0, -cap_d2_origin.1);
        let frame_size = (cap_w, cap_h);
        let visible = ReaderHalo::map_rect_to_grid(plan.cover_grid, (0, 0), 2, offset);
        let coarse = Frame {
            width: cap_w as u16,
            height: cap_h as u16,
            view: Affine::translate((f64::from(offset.0), f64::from(offset.1)))
                * Affine::scale(0.5)
                * plan.level.grid(),
            detail: false,
            area: IRect {
                x0: 0,
                y0: 0,
                x1: cap_w,
                y1: cap_h,
            },
        };
        self.reader_halo = Some(ReaderHalo {
            capture: Some(HaloTierCapture {
                render_divisor: 2,
                offset,
                frame_size,
                visible,
                prog_min_sigma: f32::INFINITY,
                prog_max_sigma: f32::INFINITY,
                unif_min_sigma: halo::WIDE_BLUR_MIN_SIGMA,
                unif_max_sigma: f32::INFINITY,
                is_far: true,
            }),
            strip_capture: None,
            wide_capture: true,
            wide_targets: plan.targets.clone(),
            wide_last: plan.targets.last().copied(),
            wide_done: false,
            native_prog_cutover: f32::INFINITY,
            native_unif_cutover: f32::INFINITY,
            downstream_readers: plan.downstream_readers.clone(),
            downstream_mid_readers: Vec::new(),
            coarse_post_scopes: Vec::new(),
            inside_coarse_post_scope: 0,
            post_scopes: HaloMap::new(),
            prefixes: HaloMap::new(),
            blurred: HaloMap::new(),
            progressive_mid: HaloMap::new(),
            progressive_far: HaloMap::new(),
            clamp_strips: HaloMap::new(),
        });
        self.swap_halo_reader_planes(true);
        match self.begin_whole_pass(
            store,
            &coarse,
            build.background,
            build.inputs.generation,
            false,
            None,
            None,
            false,
        ) {
            Ok(WholeStart::Pass(pass)) => Ok(pass),
            Ok(WholeStart::Unchanged(_)) => unreachable!("wide blur capture always draws"),
            Err(e) => {
                self.swap_halo_reader_planes(true);
                if let Some(halo) = self.reader_halo.take() {
                    self.recycle_reader_halo(halo);
                }
                Err(e)
            }
        }
    }

    /// Advances an in-progress world-grid `d = 2` wide-blur build. Returns `Ok(true)` once the
    /// `WideBlurCache` is ready (and installed in `self.wide_blur`), `Ok(false)` if paused at
    /// `self.deadline_ms`, or `Err` after tearing down cleanly.
    #[inline(never)]
    fn step_wide_blur(&mut self, store: &Store, allow_yield: bool, stats: &mut DrawStats) -> Result<bool> {
        let Some(WideBlurState::Building(mut build)) = self.wide_blur.take() else {
            return Ok(matches!(self.wide_blur, Some(WideBlurState::Ready(_))));
        };
        let mut pass = match build.pass.take() {
            Some(pass) => {
                self.swap_halo_reader_planes(true);
                pass
            }
            None => match self.begin_wide_blur_pass(store, &build) {
                Ok(mut pass) => {
                    if allow_yield && self.deadline_reached() {
                        self.pause_begun(&mut pass);
                        self.swap_halo_reader_planes(true);
                        build.pass = Some(pass);
                        self.wide_blur = Some(WideBlurState::Building(build));
                        return Ok(false);
                    }
                    pass
                }
                Err(e) => {
                    self.release_oversized_halo_storage();
                    return Err(e);
                }
            },
        };
        match self.walk_whole_pass(store, &mut pass, allow_yield) {
            Ok(true) => {}
            Ok(false) => {
                self.swap_halo_reader_planes(true);
                build.pass = Some(pass);
                self.wide_blur = Some(WideBlurState::Building(build));
                return Ok(false);
            }
            Err(e) => {
                self.swap_halo_reader_planes(true);
                if let Some(halo) = self.reader_halo.take() {
                    self.recycle_reader_halo(halo);
                }
                self.release_oversized_halo_storage();
                return Err(e);
            }
        }
        let finished = self.finish_whole_pass(pass, build.inputs.generation);
        self.swap_halo_reader_planes(true);
        let s = match finished {
            Ok(s) => s,
            Err(e) => {
                if let Some(halo) = self.reader_halo.take() {
                    self.recycle_reader_halo(halo);
                }
                self.release_oversized_halo_storage();
                return Err(e);
            }
        };
        stats.encode_ms += s.encode_ms;
        stats.render_ms += s.render_ms;
        stats.prepare_masks_ms += s.prepare_masks_ms;
        stats.vello_render_ms += s.vello_render_ms;
        stats.reader_ms += s.reader_ms;
        stats.shadow_ms += s.shadow_ms;
        stats.submit_ms += s.submit_ms;
        stats.draws += s.draws;
        stats.vello_renders += s.vello_renders;
        stats.bg_blur_ops += s.bg_blur_ops;
        stats.shadow_ops += s.shadow_ops;
        stats.shadow_hits += s.shadow_hits;
        let mut halo = self.reader_halo.take().expect("wide blur halo");
        let blurred = std::mem::take(&mut halo.blurred);
        self.recycle_reader_halo(halo);
        self.release_oversized_halo_storage();
        self.trim_pools(GPU_POOL_KEEP_BYTES);
        self.readers.flush_retired();
        self.wide_blur = Some(WideBlurState::Ready(Box::new(WideBlurCache {
            level: build.plan.level,
            cap_grid: build.plan.cap_grid,
            cover_grid: build.plan.cover_grid,
            vis_tiles_grid: build.plan.vis_tiles_grid,
            inputs: build.inputs,
            targets: build.plan.targets,
            apron_glass_safe: build.plan.apron_glass_safe,
            residual_readers: build.plan.residual_readers,
            blurred,
        })));
        Ok(true)
    }

    fn sample_wide_blur_patch(&self, reader: Option<(u32, usize)>, draw: &BlurReaderDraw) -> Option<BlurHaloSample> {
        let reader = reader?;
        let Some(WideBlurState::Ready(cache)) = self.wide_blur.as_ref() else {
            return None;
        };
        let active = self.active.as_ref()?;
        if active.draw_level != Some(cache.level) {
            return None;
        }
        let (nx, ny) = active.draw_grid_origin?;
        let patch = cache.blurred.get(&reader)?;
        let cap_d2_origin = (cache.cap_grid.x0 / 2, cache.cap_grid.y0 / 2);
        let inv = 0.5f32;
        let offset = (
            ((i64::from(draw.origin.0) - nx) as f64 * 0.5 - f64::from(cap_d2_origin.0) - f64::from(patch.origin.0))
                as f32,
            ((i64::from(draw.origin.1) - ny) as f64 * 0.5 - f64::from(cap_d2_origin.1) - f64::from(patch.origin.1))
                as f32,
        );
        let min_x = (draw.dirty.x0 as f32 + 0.5) * inv + offset.0;
        let min_y = (draw.dirty.y0 as f32 + 0.5) * inv + offset.1;
        let max_x = (draw.dirty.x1 as f32 - 0.5) * inv + offset.0;
        let max_y = (draw.dirty.y1 as f32 - 0.5) * inv + offset.1;
        if min_x < -1.5 || min_y < -1.5 || max_x > patch.size.0 as f32 + 1.5 || max_y > patch.size.1 as f32 + 1.5 {
            return None;
        }
        Some(BlurHaloSample {
            view: patch.view.clone(),
            view_id: patch.view_id,
            size: patch.size,
            inv,
            offset,
        })
    }

    /// Releases what `run` captured, finished or not (a paused pass is dropped), and keeps the
    /// sample bounds of a frame that finished.
    #[inline(never)]
    fn end_reader_halo(&mut self, run: &mut HaloRun, plan: &ViewportHaloPlan, finished: bool) {
        if run.pass.take().is_some_and(|pass| pass.paused.is_some()) {
            self.drop_walk();
        }
        let halo = self.reader_halo.take().expect("reader halo");
        self.recycle_reader_halo(halo);
        self.release_oversized_halo_storage();
        self.trim_pools(GPU_POOL_KEEP_BYTES);
        self.readers.flush_retired();
        if finished {
            self.whole_samples = Some(Some(plan.samples));
        }
    }

    fn swap_halo_reader_planes(&mut self, is_far: bool) {
        let [backdrop, delta, blur_source] = &mut self.halo_reader_planes[usize::from(!is_far)];
        std::mem::swap(&mut self.readers.backdrop_frame, backdrop);
        std::mem::swap(&mut self.readers.delta_frame, delta);
        std::mem::swap(&mut self.readers.blur_source, blur_source);
    }

    fn overlay_reader_interiors(
        &mut self,
        encoder: &mut wgpu::CommandEncoder,
        view: &wgpu::TextureView,
        bounds: IRect,
        interiors: &[usize],
    ) {
        for &layer in interiors {
            let paint = self.offscreen_stack[layer].plane(true);
            if paint.needs_clear {
                continue;
            }
            let visible = IRect {
                x0: paint.origin.0,
                y0: paint.origin.1,
                x1: paint.origin.0 + i32::from(paint.active_size.0),
                y1: paint.origin.1 + i32::from(paint.active_size.1),
            }
            .intersect(bounds);
            if !visible.is_empty() {
                let local = visible.translate(-bounds.x0, -bounds.y0);
                let (width, height) = local.size();
                self.readers.encode_composite(
                    &self.device,
                    encoder,
                    &paint.view,
                    paint.view_id,
                    CompositeTarget::Over(view),
                    (false, false),
                    (paint.origin.0 - bounds.x0, paint.origin.1 - bounds.y0),
                    (local.x0 as u32, local.y0 as u32, width, height),
                    1.0,
                );
            }
        }
    }

    fn acquire_halo_patch(
        &mut self,
        origin: (i32, i32),
        size: (u32, u32),
        divisor: i32,
        halo_offset: (i32, i32),
        frame_size: (i32, i32),
        within: Option<glass::ClipWithin>,
    ) -> Result<HaloPatch> {
        // Round the storage so a one-pixel change in the clipped view on pan reuses it.
        let width = size.0.next_multiple_of(64).min(self.max_texture_2d);
        let height = size.1.next_multiple_of(64).min(self.max_texture_2d);
        let bytes = Self::frame_bytes(width, height);
        let reusable = self
            .halo_prefix_pool
            .iter()
            .position(|prefix| prefix.texture.width() == width && prefix.texture.height() == height);
        let (texture, view, view_id) = if let Some(at) = reusable {
            let prefix = self.halo_prefix_pool.swap_remove(at);
            self.pool_bytes -= bytes;
            (prefix.texture, prefix.view, prefix.view_id)
        } else {
            self.reserve_or_trim(bytes, 0, "a coarse reader backdrop")?;
            let texture = texture(
                &self.device,
                width,
                height,
                wgpu::TextureUsages::TEXTURE_BINDING
                    | wgpu::TextureUsages::COPY_DST
                    | wgpu::TextureUsages::RENDER_ATTACHMENT,
                "coarse reader backdrop",
            );
            let view = texture.create_view(&Default::default());
            (texture, view, crate::blend::gpu::next_view_id())
        };
        self.bytes += bytes;
        Ok(HaloPatch {
            texture,
            view,
            view_id,
            origin,
            size,
            divisor,
            halo_offset,
            frame_size,
            within,
        })
    }

    /// Capture only the part of the tier's stop images the native viewport (or mid tier) can sample.
    fn capture_progressive_halo(
        &mut self,
        key: (u32, usize),
        draw: &BlurReaderDraw,
        first: usize,
        end: usize,
        inflate: bool,
    ) -> Result<Option<IRect>> {
        let Some(tier) = self.reader_halo.as_ref().and_then(|halo| halo.capture) else {
            return Ok(None);
        };
        let dirty = if inflate { draw.dirty.inflate(1, 1) } else { draw.dirty };
        let bounds = dirty
            .translate(draw.origin.0, draw.origin.1)
            .intersect(tier.visible.inflate(2, 2))
            .clamp(tier.frame_size.0, tier.frame_size.1);
        if first >= end || bounds.is_empty() {
            return Ok(None);
        }
        let width = (bounds.x1 - bounds.x0) as u32;
        let height = (bounds.y1 - bounds.y0) as u32;
        let count = (end - first) as u32;
        let cols = count.min(4).min(self.max_texture_2d / width).max(1);
        let size = (width * cols, height * count.div_ceil(cols));
        self.check_texture_size(size.0, size.1, "progressive halo stop atlas")?;
        let patch = self.acquire_halo_patch(
            (bounds.x0, bounds.y0),
            size,
            tier.render_divisor,
            tier.offset,
            tier.frame_size,
            None,
        )?;
        let atlas = ProgressiveHaloPatch {
            patch,
            bounds,
            cell_size: (width, height),
            first,
            end,
            cols,
        };
        let halo = self.reader_halo.as_mut().expect("reader halo");
        let old = halo.progressive_mut(tier.is_far).insert(key, atlas);
        if let Some(old) = old {
            self.submit_active_encoder();
            self.recycle_halo_prefix(old.patch);
        }
        Ok(Some(bounds))
    }

    /// Captures the backdrop right before `reader` during a fractional clip edge-strip pass.
    fn capture_halo_strip_backdrop(&mut self, reader: Option<(u32, usize)>, open: &[Open]) -> Result<bool> {
        let Some((target_key, size)) = self
            .reader_halo
            .as_ref()
            .and_then(|h| h.strip_capture.as_ref())
            .map(|s| (s.reader_key, s.size))
        else {
            return Ok(false);
        };
        if reader != Some(target_key) {
            return Ok(false);
        }
        self.flush_why = 2;
        self.flush_preserving_clips(open, true)?;
        if self.active.is_none() {
            return Ok(true);
        }
        let (base, interiors) = exec::reader_backdrop_layers(&self.offscreen_stack, false, |scope| scope.isolation);
        if let Some(base) = base {
            self.ensure_scope_cleared(base, false, true);
        }
        let active = self.active.as_ref().expect("active draw");
        let source = self.reader_source(base, active)?;
        let strip_bounds = IRect {
            x0: 0,
            y0: 0,
            x1: size.0 as i32,
            y1: size.1 as i32,
        };
        let patch = self.acquire_halo_patch((0, 0), size, 1, (0, 0), (size.0 as i32, size.1 as i32), None)?;
        let mut encoder = self.take_encoder("capture clamp edge strip");
        let overlap = source.bounds.intersect(strip_bounds);
        if overlap != strip_bounds {
            GpuReaders::encode_clear(&mut encoder, &patch.view, wgpu::Color::TRANSPARENT);
        }
        if !overlap.is_empty() {
            copy_rect(
                &mut encoder,
                &source.plane.texture,
                &patch.texture,
                (
                    (overlap.x0 - source.bounds.x0) as u32,
                    (overlap.y0 - source.bounds.y0) as u32,
                ),
                (overlap.x0 as u32, overlap.y0 as u32),
                overlap.size(),
            );
        }
        self.overlay_reader_interiors(&mut encoder, &patch.view, strip_bounds, &interiors);
        self.stash_encoder(encoder);
        if let Some(cap) = self.reader_halo.as_mut().and_then(|h| h.strip_capture.as_mut()) {
            cap.captured = Some(patch);
        }
        Ok(true)
    }

    #[allow(clippy::too_many_arguments)]
    #[inline(never)]
    fn encode_single_blur_into_out(
        &mut self,
        encoder: &mut wgpu::CommandEncoder,
        reader: Option<(u32, usize)>,
        tier: Option<HaloTierCapture>,
        draw: &BlurReaderDraw,
        dirty: IRect,
        sigma: f32,
        within: Option<glass::ClipWithin>,
    ) -> Result<()> {
        let bw = (dirty.x1 - dirty.x0) as u32;
        let bh = (dirty.y1 - dirty.y0) as u32;
        self.ensure_reader_tex(2, bw, bh, "")?;
        let blur_sigma = tier.map_or(sigma, |t| halo::compensate_halo_sigma(sigma, t.render_divisor));
        let clip_info = draw.halo_clip_bounds(tier, within, blur_sigma, tier.is_none());
        let sample = draw.source_rect(dirty);
        let (src_view, src_id, src_size, crop_origin, clamp_bounds, edge, key) =
            self.prefilter_halo_blur_source(encoder, reader, tier, draw, sample, blur_sigma, clip_info)?;
        let shifted_sample = sample.translate(-crop_origin.0, -crop_origin.1);
        let spec = BlurSpec {
            sigma: blur_sigma,
            edge,
            clamp_bounds,
            dirty: shifted_sample,
        };
        self.encode_blur_reader_slice(
            encoder,
            &src_view,
            src_id,
            src_size,
            (shifted_sample.x0, shifted_sample.y0),
            &spec,
            key,
        )
    }

    #[allow(clippy::too_many_arguments)]
    #[inline(never)]
    fn capture_blurred_halo_patch(
        &mut self,
        encoder: &mut wgpu::CommandEncoder,
        reader: (u32, usize),
        bounds: IRect,
        src_start: (u32, u32),
        tier: HaloTierCapture,
    ) -> Result<Option<HaloPatch>> {
        let size = ((bounds.x1 - bounds.x0) as u32, (bounds.y1 - bounds.y0) as u32);
        let patch = self.acquire_halo_patch(
            (bounds.x0, bounds.y0),
            size,
            tier.render_divisor,
            tier.offset,
            tier.frame_size,
            None,
        )?;
        let source = &self.readers.blur_out.as_ref().expect("blur halo output").texture;
        copy_rect(encoder, source, &patch.texture, src_start, (0, 0), size);
        Ok(self
            .reader_halo
            .as_mut()
            .expect("reader halo")
            .blurred
            .insert(reader, patch))
    }

    #[allow(clippy::too_many_arguments)]
    #[inline(never)]
    fn encode_progressive_tile_stops(
        &mut self,
        encoder: &mut wgpu::CommandEncoder,
        key: (u32, usize),
        capture_tier: Option<HaloTierCapture>,
        draw: &BlurReaderDraw,
        plan: &progressive_blur::ProgressivePlan,
        tile: IRect,
        dirty_pad: f64,
        source: &wgpu::TextureView,
        source_id: u64,
        src_size: (u32, u32),
        crop_origin: (i32, i32),
        clamp_bounds: IRect,
        edge: EdgeMode,
        pyramid_key: Option<blur::PyramidKey>,
        stop_first: usize,
        stop_end: usize,
        cols: u32,
    ) -> Result<()> {
        let tile_frame = Rect::new(
            f64::from(draw.origin.0 + tile.x0),
            f64::from(draw.origin.1 + tile.y0),
            f64::from(draw.origin.0 + tile.x1),
            f64::from(draw.origin.1 + tile.y1),
        )
        .inflate(dirty_pad, dirty_pad);
        let (tf, te) = plan.active_stop_range(tile_frame);
        let (tw, th) = (tile.x1 - tile.x0, tile.y1 - tile.y0);
        let shifted_sample = draw.source_rect(tile).translate(-crop_origin.0, -crop_origin.1);
        for (slot, &sigma) in plan.stops[stop_first..stop_end].iter().enumerate() {
            let stop = stop_first + slot;
            if stop < tf || stop >= te {
                continue;
            }
            let col = (slot as u32 % cols) as i32;
            let row = (slot as u32 / cols) as i32;
            let spec = BlurSpec {
                sigma: capture_tier.map_or(sigma, |t| halo::compensate_halo_sigma(sigma, t.render_divisor)),
                edge,
                clamp_bounds,
                dirty: shifted_sample,
            };
            self.encode_blur_reader_slice(
                encoder,
                source,
                source_id,
                src_size,
                (shifted_sample.x0 - col * tw, shifted_sample.y0 - row * th),
                &spec,
                pyramid_key,
            )?;
            if let Some(tier) = capture_tier
                && let Some(capture) = self
                    .reader_halo
                    .as_ref()
                    .and_then(|halo| halo.progressive(tier.is_far).get(&key))
            {
                let atlas = &self.readers.blur_out.as_ref().expect("progressive blur atlas").texture;
                capture.copy_stop(encoder, atlas, stop, slot, tile, draw.origin, cols);
            }
        }
        Ok(())
    }

    /// Prefilters `draw.source` into crop-sized `halo_border_src` for fractional solid-fill
    /// (`EdgeMode::Border`) or unfilled edge-strip (`EdgeMode::Clamp`) clips in a reduced pass.
    /// `sample_dirty` is in `draw.source`-local coordinates.
    /// Returns `(source_view, source_id, source_size, crop_origin, clamp_bounds, edge, pyramid_key)`.
    #[allow(clippy::too_many_arguments, clippy::type_complexity)]
    fn prefilter_halo_blur_source(
        &mut self,
        encoder: &mut wgpu::CommandEncoder,
        reader: Option<(u32, usize)>,
        tier: Option<HaloTierCapture>,
        draw: &BlurReaderDraw,
        sample_dirty: IRect,
        max_sigma: f32,
        clip_info: halo::HaloClipBounds,
    ) -> Result<(
        wgpu::TextureView,
        u64,
        (u32, u32),
        (i32, i32),
        IRect,
        EdgeMode,
        Option<blur::PyramidKey>,
    )> {
        let src_size = draw.source.bounds.size();
        let src_origin = (draw.source.bounds.x0, draw.source.bounds.y0);
        if let Some((clip_rect, border)) = clip_info.subtexel_border {
            let crop = halo::subtexel_border_crop(sample_dirty, max_sigma);
            let budget = self.reader_budget_room();
            let pf = self.readers.encode_halo_clip_border(
                &self.device,
                encoder,
                &draw.source.plane.view,
                draw.source.plane.view_id,
                src_size,
                crop,
                clip_rect,
                border,
                budget,
            )?;
            let cb = clip_info
                .clamp_bounds
                .translate(-pf.crop_origin.0, -pf.crop_origin.1)
                .clamp(pf.size.0 as i32, pf.size.1 as i32);
            return Ok((pf.view, pf.view_id, pf.size, pf.crop_origin, cb, clip_info.edge, None));
        }
        if clip_info.subtexel_clamp.is_some()
            && let Some(tier) = tier
            && let Some(reader_key) = reader
        {
            let budget = self.reader_budget_room();
            if let Some(set) = self.reader_halo.as_ref().and_then(|h| h.clamp_strips.get(&reader_key)) {
                fn make_edge<'a>(
                    s: &'a HaloClampStrip,
                    is_vertical: bool,
                    src_origin: (i32, i32),
                    tier: HaloTierCapture,
                ) -> HaloClampEdge<'a> {
                    let (straddle, axis_offset) = if is_vertical {
                        (
                            s.straddle_frame - src_origin.0,
                            ((src_origin.1 - tier.offset.1) * tier.render_divisor - s.long_start_dev) as f32
                                / s.strip_divisor as f32,
                        )
                    } else {
                        (
                            s.straddle_frame - src_origin.1,
                            ((src_origin.0 - tier.offset.0) * tier.render_divisor - s.long_start_dev) as f32
                                / s.strip_divisor as f32,
                        )
                    };
                    HaloClampEdge {
                        view: &s.patch.view,
                        view_id: s.patch.view_id,
                        straddle,
                        clamp_weight: s.clamp_weight,
                        size: s.patch.size,
                        samples_per_texel: s.samples_per_texel,
                        axis_offset,
                    }
                }
                let edges = HaloClampEdges {
                    left: set.left.as_ref().map(|s| make_edge(s, true, src_origin, tier)),
                    right: set.right.as_ref().map(|s| make_edge(s, true, src_origin, tier)),
                    top: set.top.as_ref().map(|s| make_edge(s, false, src_origin, tier)),
                    bottom: set.bottom.as_ref().map(|s| make_edge(s, false, src_origin, tier)),
                };
                let raw_crop = halo::subtexel_border_crop(sample_dirty, max_sigma);
                let min_x = edges.left.as_ref().map_or(0, |e| e.straddle - 1);
                let max_x = edges.right.as_ref().map_or(src_size.0 as i32, |e| e.straddle + 2);
                let min_y = edges.top.as_ref().map_or(0, |e| e.straddle - 1);
                let max_y = edges.bottom.as_ref().map_or(src_size.1 as i32, |e| e.straddle + 2);
                let crop = IRect {
                    x0: raw_crop.x0.max(min_x).min(sample_dirty.x0),
                    y0: raw_crop.y0.max(min_y).min(sample_dirty.y0),
                    x1: raw_crop.x1.min(max_x).max(sample_dirty.x1),
                    y1: raw_crop.y1.min(max_y).max(sample_dirty.y1),
                };
                let cb_src = IRect {
                    x0: edges
                        .left
                        .as_ref()
                        .map_or(clip_info.clamp_bounds.x0, |e| e.straddle - 1)
                        .max(crop.x0),
                    y0: edges
                        .top
                        .as_ref()
                        .map_or(clip_info.clamp_bounds.y0, |e| e.straddle - 1)
                        .max(crop.y0),
                    x1: edges
                        .right
                        .as_ref()
                        .map_or(clip_info.clamp_bounds.x1, |e| e.straddle + 2)
                        .min(crop.x1),
                    y1: edges
                        .bottom
                        .as_ref()
                        .map_or(clip_info.clamp_bounds.y1, |e| e.straddle + 2)
                        .min(crop.y1),
                };
                if !crop.is_empty()
                    && !cb_src.is_empty()
                    && (crop.x1 - crop.x0) as u32 <= self.max_texture_2d
                    && (crop.y1 - crop.y0) as u32 <= self.max_texture_2d
                {
                    let pf = self.readers.encode_halo_clip_clamp(
                        &self.device,
                        encoder,
                        &draw.source.plane.view,
                        draw.source.plane.view_id,
                        src_size,
                        crop,
                        &edges,
                        budget,
                    )?;
                    let cb = cb_src.translate(-pf.crop_origin.0, -pf.crop_origin.1);
                    return Ok((pf.view, pf.view_id, pf.size, pf.crop_origin, cb, EdgeMode::Clamp, None));
                }
            }
        }
        let key = draw
            .source_is_frame
            .then(|| blur::PyramidKey::new(self.backdrop_gen, clip_info.clamp_bounds, clip_info.edge));
        Ok((
            draw.source.plane.view.clone(),
            draw.source.plane.view_id,
            src_size,
            (0, 0),
            clip_info.clamp_bounds,
            clip_info.edge,
            key,
        ))
    }

    fn sample_blur_halo(
        &self,
        draw: &BlurReaderDraw,
        patch: &HaloPatch,
        cell_size: (u32, u32),
    ) -> Option<BlurHaloSample> {
        let halo = self.reader_halo.as_ref()?;
        let (cur_div, cur_origin) = match halo.capture {
            Some(tier) => (tier.render_divisor, tier.offset),
            None => (1, self.active.as_ref()?.display_area.map_or((0, 0), |r| (r.x0, r.y0))),
        };
        if patch.divisor < cur_div {
            return None;
        }
        let inv = cur_div as f32 / patch.divisor as f32;
        let offset = (
            (draw.origin.0 - cur_origin.0) as f32 * inv + (patch.halo_offset.0 - patch.origin.0) as f32,
            (draw.origin.1 - cur_origin.1) as f32 * inv + (patch.halo_offset.1 - patch.origin.1) as f32,
        );
        // Verify that the captured patch covers the active dirty region (for spatial post-effect
        // scopes whose src_area extends past the viewport). Allow a 1.5-texel tolerance for
        // rounding at the 2-texel inflated capture edge.
        let min_x = (draw.dirty.x0 as f32 + 0.5) * inv + offset.0;
        let min_y = (draw.dirty.y0 as f32 + 0.5) * inv + offset.1;
        let max_x = (draw.dirty.x1 as f32 - 0.5) * inv + offset.0;
        let max_y = (draw.dirty.y1 as f32 - 0.5) * inv + offset.1;
        if min_x < -1.5 || min_y < -1.5 || max_x > cell_size.0 as f32 + 1.5 || max_y > cell_size.1 as f32 + 1.5 {
            return None;
        }
        Some(BlurHaloSample {
            view: patch.view.clone(),
            view_id: patch.view_id,
            size: cell_size,
            inv,
            offset,
        })
    }

    #[inline(never)]
    fn recycle_halo_prefix(&mut self, prefix: HaloPatch) {
        let bytes = Self::frame_bytes(prefix.texture.width(), prefix.texture.height());
        self.bytes -= bytes;
        self.pool_bytes += bytes;
        self.halo_prefix_pool.push(prefix);
    }

    #[allow(clippy::too_many_arguments)]
    fn draw_whole_pass(
        &mut self,
        store: &Store,
        frame: &Frame,
        background: [f32; 4],
        generation: u64,
        moving: bool,
        prefix: Option<(u64, usize)>,
        samples: Option<IRect>,
    ) -> Result<DrawStats> {
        let mut pass =
            match self.begin_whole_pass(store, frame, background, generation, moving, prefix, samples, false)? {
                WholeStart::Unchanged(stats) => return Ok(stats),
                WholeStart::Pass(pass) => pass,
            };
        self.walk_whole_pass(store, &mut pass, false)?;
        self.finish_whole_pass(pass, generation)
    }

    /// Sets up a whole pass (`draw_whole_pass`): its target and the walk's split. With
    /// `scratch_target`, an unpadded frame draws into a scratch too and is copied to its frame
    /// when it finishes, so a frame presented while it is paused can't draw over it.
    #[allow(clippy::too_many_arguments)]
    #[inline(never)]
    fn begin_whole_pass(
        &mut self,
        store: &Store,
        frame: &Frame,
        background: [f32; 4],
        generation: u64,
        moving: bool,
        prefix: Option<(u64, usize)>,
        samples: Option<IRect>,
        scratch_target: bool,
    ) -> Result<WholeStart> {
        self.check()?;
        #[cfg(feature = "compute")]
        {
            self.pending_compute = None;
            self.last_compute_used = false;
            self.gates_off_screen();
        }
        let (width, height) = (u32::from(frame.width), u32::from(frame.height));
        let capturing = self.reader_halo.as_ref().is_some_and(ReaderHalo::capturing);
        let t0 = now();
        let submits0 = self.submits;
        let view = frame.view;
        let bg_bits = background.map(f32::to_bits);
        let mut stats = DrawStats {
            direct: true,
            plan: 2,
            ..DrawStats::default()
        };
        if self.reader_halo.is_none()
            && !moving
            && self.last.is_some_and(|l| l.view == view && l.size == (width, height))
            && self.shown == Some((generation, bg_bits, true))
            && self.whole_samples == Some(samples)
        {
            stats.exact = true;
            stats.plan = 3;
            let stats = self.finish_frame(self.cur.expect("unchanged frame"), stats, t0, submits0, None)?;
            return Ok(WholeStart::Unchanged(stats));
        }
        let dst = self.next_frame();
        let padded = match samples {
            Some(bounds) => Some(match self.padded_view(bounds, (width, height), 0) {
                Ok(p) => p,
                Err(e)
                    if e.code == ErrorCode::Limit
                        && self.pool_bytes > 0
                        && self.padded_view(bounds, (width, height), self.pool_bytes).is_ok() =>
                {
                    self.trim_pools(0);
                    self.padded_view(bounds, (width, height), 0)?
                }
                Err(e) => return Err(e),
            }),
            None => (scratch_target && !capturing).then_some(((0, 0), (width, height))),
        };
        if !capturing && padded.is_none() {
            self.ensure_frame(dst, width, height)?;
        }
        if prefix.is_none() {
            self.forget_motion_prefix();
        }
        if store.readers().is_empty() && !store.has_context() && self.readers.bytes() > 0 {
            self.readers.evict_frame_scratch();
        }
        let whole = if let Some(((x, y), (w, h))) = padded {
            self.ensure_scratch_size(w, h)?;
            Frame {
                width: w as u16,
                height: h as u16,
                view: Affine::translate((f64::from(x), f64::from(y))) * view,
                area: IRect {
                    x0: 0,
                    y0: 0,
                    x1: w as i32,
                    y1: h as i32,
                },
                ..*frame
            }
        } else {
            self.ensure_scratch_size(width, height)?;
            *frame
        };
        let (w, h) = (u32::from(whole.width), u32::from(whole.height));
        self.masks.begin_frame();
        self.blur.begin_frame();
        self.shadow.begin_frame();
        self.atlas.at = (0, 0, 0);
        self.scene.reset_and_resize(whole.width, whole.height);
        self.readers.begin_frame();
        self.bump_backdrop_gen();
        if !capturing {
            self.begin_frame_timestamp();
        }
        let display_area = padded.map(|((x, y), _)| IRect {
            x0: x as i32,
            y0: y as i32,
            x1: (x + width) as i32,
            y1: (y + height) as i32,
        });
        let grid_pad = display_area.map_or((0, 0), |d| (d.x0, d.y0));
        self.begin_active(
            (padded.is_none() && !capturing).then_some(dst),
            display_area,
            None,
            grid_pad,
            whole.view,
            w,
            h,
            background,
            moving,
        );
        let limits = store.limits;
        let mut verbs = limits.frame_verbs;
        let split = match prefix {
            Some(prefix) => self.prepare_motion_prefix(store, &whole, bg_bits, prefix, &mut verbs, &mut stats),
            None => {
                if moving || self.reader_halo.is_some() {
                    Ok(None)
                } else {
                    self.prepare_glass_masks(store, &whole).map(|()| None)
                }
            }
        };
        let split = match split {
            Ok(split) => split.unwrap_or_else(Split::all),
            Err(e) => {
                self.forget_motion_prefix();
                self.discard_draw();
                return Err(e);
            }
        };
        Ok(WholeStart::Pass(Box::new(WholePass {
            whole,
            size: (width, height),
            view,
            bg_bits,
            dst,
            padded,
            samples,
            capturing,
            moving,
            t0,
            submits0,
            stats,
            verbs,
            split,
            coarse_readers: moving && self.reader_halo.is_none(),
            paused: None,
            total: None,
        })))
    }

    /// Walks `pass` on: to its end, or with `allow_yield`, until the deadline (`deadline_ms`)
    /// pauses it at a safe boundary. A paused pass keeps its target, flushed, and its checkpoint;
    /// the next call resumes it as a paused tile resumes. Returns whether the walk is complete.
    #[inline(never)]
    fn walk_whole_pass(&mut self, store: &Store, pass: &mut WholePass, allow_yield: bool) -> Result<bool> {
        let t0 = now();
        let checkpoint = match pass.paused.take() {
            Some(paused) => self.resume_walk(paused, (pass.whole.width, pass.whole.height)),
            None => None,
        };
        let limits = store.limits;
        let outcome = exec::draw_split_resumable(
            store,
            self,
            &pass.whole,
            &limits,
            &mut pass.verbs,
            &pass.split,
            pass.coarse_readers,
            checkpoint,
            allow_yield,
        );
        match outcome {
            Err(e) => {
                self.forget_motion_prefix();
                self.discard_draw();
                Err(e)
            }
            Ok(exec::WalkOutcome::Complete { stats, total }) => {
                pass.stats.add(&stats);
                pass.total = Some(total);
                Ok(true)
            }
            Ok(exec::WalkOutcome::Paused { stats, checkpoint }) => {
                pass.stats.add(&stats);
                pass.paused = Some(self.pause_walk(Some(checkpoint), &mut pass.stats, t0)?);
                Ok(false)
            }
        }
    }

    /// Finishes a walked `pass`: flushes it, copies a padded or scratch target to its frame,
    /// and presents the frame (a capturing halo tier presents nothing).
    #[inline(never)]
    fn finish_whole_pass(&mut self, pass: Box<WholePass>, generation: u64) -> Result<DrawStats> {
        let WholePass {
            size: (width, height),
            view,
            bg_bits,
            dst,
            padded,
            samples,
            capturing,
            moving,
            t0,
            submits0,
            mut stats,
            total,
            ..
        } = *pass;
        let total = total.expect("a walked pass");
        // A pass that paused may have seen other frames take `dst`: copy into the next one now.
        let dst = if padded.is_some() && !capturing {
            let next = self.next_frame();
            if let Err(e) = self.ensure_frame(next, width, height) {
                self.discard_draw();
                return Err(e);
            }
            next
        } else {
            dst
        };
        let copy = padded.map(|(start, _)| (false, dst, start, (0, 0, width, height)));
        let active = self.finish_scratch_to_frame(copy, 3)?;
        active.record_into(&mut stats, now() - t0);
        if capturing {
            stats.submits = self.submits.saturating_sub(submits0);
            self.scene.reset();
            return Ok(stats);
        }
        stats.exact = self.reader_halo.is_none() && !moving && total.exact();
        stats.standin = !stats.exact;
        if self.reader_halo.is_some() {
            stats.plan = 4;
        }
        stats.held = self.tiles.len() as u32;
        stats.evicted = self.tiles.stats.evicted;
        let stats = self.finish_frame(dst, stats, t0, submits0, None)?;
        self.cur = Some(dst);
        self.direct_slices = None;
        self.set_cur_page(true);
        self.last = Some(Last {
            view,
            size: (width, height),
        });
        self.last_scale = Some(view.as_coeffs()[0]);
        self.whole_samples = (padded.is_some() == samples.is_some()).then_some(samples);
        self.whole_reader_halo = self.reader_halo.is_some() && !moving;
        self.set_shown(generation, bg_bits, stats.exact);
        Ok(stats)
    }

    /// Presents the last frame warped to `view` (or the background) when a budgeted moving frame
    /// hits a limit: a composite of one quad, never a whole-view replay. `cur` and `last` keep the
    /// sharp frame it was warped from, so the next frame warps from that again; a read-back shows
    /// this one (`pacing::Screen`).
    #[allow(clippy::too_many_arguments)]
    #[inline(never)]
    fn present_motion_standin(
        &mut self,
        view: Affine,
        background: [f32; 4],
        w: u32,
        h: u32,
        t0: f64,
        submits0: u32,
        timestamp_started: bool,
    ) -> Result<DrawStats> {
        self.abort_pending_tile();
        self.scene.reset();
        if !timestamp_started {
            self.begin_frame_timestamp();
        }
        let dst = self.next_frame();
        self.ensure_frame(dst, w, h)?;
        let mut comp = Composite {
            exact: false,
            complete: false,
            pending: 1,
            ..Composite::default()
        };
        if self.cur.is_some()
            && let Some(l) = self.last
            && l.view.determinant().abs() > 0.0
        {
            comp.base = Some(view * l.view.inverse());
            self.tiles.base_kept = self.screen.standin.is_some();
            comp.holes = self.tiles.holes(view, (w, h));
        }
        let mut stats = DrawStats {
            standin: true,
            plan: 1,
            pending: 1,
            held: self.tiles.len() as u32,
            evicted: self.tiles.stats.evicted,
            ..DrawStats::default()
        };
        let t1 = now();
        let encoder = self.composite(&comp, dst, background, w, h, false, &mut stats)?;
        stats.render_ms += now() - t1;
        let stats = self.finish_frame(dst, stats, t0, submits0, encoder)?;
        if self.cur.is_none() {
            self.cur = Some(dst);
            self.direct_slices = None;
            self.set_cur_page(true);
        } else {
            self.screen.standin = Some(dst);
        }
        self.shown = None;
        Ok(stats)
    }

    /// Draws a frame made of tiles (decision 0040, phase 2): draws the tiles it needs, as many as
    /// `options` allow beyond those nothing can stand in for, composites the frame from them
    /// (stand-ins beneath what isn't drawn yet), and, with a canvas, presents it. `exact` in the
    /// answer: every tile shown is up to date and drawn without level of detail, so the frame is
    /// what a fresh engine draws. The GPU may still be drawing when this returns.
    #[allow(clippy::too_many_arguments)]
    pub fn render(
        &mut self,
        store: &Store,
        frame: &Frame,
        background: [f32; 4],
        generation: u64,
        halo: i32,
        options: TiledOptions,
        drag: Option<&DragFrame>,
        wide_plan: Option<&halo::WideBlurPlan>,
    ) -> Result<DrawStats> {
        self.check()?;
        self.abort_pending_whole();
        // What this shows is made of tiles, not a whole frame (`present_sliced_frame` and
        // `render_whole` show one again only while it's shown).
        self.whole_reader_halo = false;
        self.pass_budget = None;
        #[cfg(feature = "compute")]
        {
            self.pending_compute = None;
            self.last_compute_used = false;
            self.gates_off_screen();
        }
        self.forget_motion_prefix();
        if self.pending_tile.is_none() {
            self.readers.drop_glass_mask_atlas();
            if store.readers().is_empty() && !store.has_context() && self.readers.bytes() > 0 {
                self.readers.evict_frame_scratch();
            }
        }
        let (w, h) = (u32::from(frame.width), u32::from(frame.height));
        self.ensure_compositor();
        self.masks.begin_frame();
        self.blur.begin_frame();
        self.shadow.begin_frame();
        self.trim_pools(GPU_POOL_KEEP_BYTES);
        let t0 = now();
        let submits0 = self.submits;
        let bg_bits = background.map(f32::to_bits);
        let inputs = Self::inputs(store, generation, background);
        if self.pending_tile.as_ref().is_some_and(|pt| pt.inputs != inputs) {
            self.abort_pending_tile();
        }
        let view = frame.view;
        let scale = view.as_coeffs()[0];
        self.tiles.begin_scaled(background, scale, halo);
        self.set_overview(store);
        self.tiles.moving = options.moving;
        // A stand-in after a limit was shown since the frame this one is laid on: that frame is
        // older than the screen where something changed since (`TileCache::base_kept`).
        self.tiles.base_kept = self.screen.standin.is_some();
        self.tiles.bake_overview = !options.moving && options.budget_ms > 0.0;
        // The overview's refined tiles are the time between frames' (`ahead`), once still.
        self.tiles.refine_overview = false;
        self.fit_tiles(store.limits.tile_bytes);
        self.heal_unbacked_tiles();
        let zooming = options.moving && self.last_scale.is_some_and(|s| s != scale);
        // A page just shown (opened, switched to, its list made afresh): nothing to stand on.
        // Under a budget its first frames draw coarse ladder tiles within the per-frame budget
        // without blocking; exact tiles follow progressively (decision 0040, phase 2: open time).
        if self.last.is_none() && self.tiles.is_empty() && options.budget_ms > 0.0 {
            self.opening_pending = true;
        } else if options.budget_ms <= 0.0 || zooming {
            self.opening_pending = false;
        }
        let opening = self.opening_pending;
        let last = self.last;
        let plan_last = if opening { None } else { last };
        let coarse_moving = options.moving && halo > 0;
        // Moving and composite-only frames never wait on a limited draw: they show a stand-in.
        let standin_on_limit = options.budget_ms < 0.0 || (options.moving && options.budget_ms > 0.0);
        macro_rules! or_standin {
            ($result:expr) => {
                match $result {
                    Ok(value) => value,
                    Err(e) if standin_on_limit && e.code == ErrorCode::Limit => {
                        return self.present_motion_standin(view, background, w, h, t0, submits0, true);
                    }
                    Err(e) => return Err(e),
                }
            };
        }
        self.tiles.opening = opening;
        // During moving coarse reader frames, draw only visible tiles rather than spending frame
        // budget prefetching off-screen coarse stand-ins that must be redrawn exact at rest.
        let Some(mut plan) = self.tiles.plan(
            view,
            (w, h),
            zooming || opening,
            plan_last,
            // No off-screen prefetch while tiles carry a wide apron or share a wide-blur cache.
            options.prefetch
                && !coarse_moving
                && !opening
                && wide_plan.is_none()
                && self.wide_blur.is_none()
                && i64::from(halo) <= i64::from(store.limits.halo),
            coarse_moving,
        ) else {
            if standin_on_limit {
                return self.present_motion_standin(view, background, w, h, t0, submits0, false);
            }
            return Err(EngineError::limit("a camera the tiles can't follow (too far out)"));
        };
        let selection = self.tiles.drag_prepare(&mut plan, drag.map(DragFrame::input).as_ref());
        // A composite-only frame can present cached tiles; direct tiles and drag layers
        // need an actual draw to produce pixels.
        let composite_only = options.budget_ms < 0.0
            && selection.is_none()
            && !plan.direct
            && (self.pending_tile.is_some() || !plan.jobs.iter().any(|j| j.direct));
        if !composite_only && (selection.is_some() || plan.direct || options.budget_ms <= 0.0) {
            self.abort_pending_tile();
        }
        let mut stats = DrawStats {
            direct: plan.direct,
            ..DrawStats::default()
        };
        // Nothing to draw and the frame shown is this one, exact: it stays.
        let same = !opening
            && self.pending_tile.is_none()
            && !matches!(self.wide_blur, Some(WideBlurState::Building(_)))
            && plan.jobs.is_empty()
            && selection.is_none()
            && last.is_some_and(|l| l.view == view && l.size == (w, h))
            && self.shown == Some((generation, bg_bits, true));
        if same {
            stats.exact = true;
            stats.plan = 3;
            if !options.moving && options.budget_ms < 0.0 {
                stats.queued = self.tiles.overview_left(scale);
            }
            return self.finish_frame(self.cur.expect("unchanged frame"), stats, t0, submits0, None);
        }
        self.begin_frame_timestamp();
        let dst = self.next_frame();
        self.ensure_frame(dst, w, h)?;
        let mut verbs = store.limits.frame_verbs;
        let mut direct_exact = true;
        // Moving coarse frames sample mipmaps inside `TILE` directly without growing a full halo.
        let frame_halo = if coarse_moving { 0 } else { halo };
        // Drawn straight into the frame after it's laid: what no slot could be kept for.
        let mut late: Vec<crate::tiles::Job> = Vec::new();
        let budgeted = options.budget_ms > 0.0;
        let bake_t0 = now();
        let walk_budget = self.walk_budget_ms(options.budget_ms);
        let deadline = budgeted.then_some(bake_t0 + walk_budget);
        let mut wide_paused = false;
        if options.moving {
            self.abort_wide_blur_building();
        } else if composite_only {
            if matches!(self.wide_blur, Some(WideBlurState::Building(_))) {
                wide_paused = true;
            }
        } else if let Some(wp) = wide_plan {
            let ready = if let Some(WideBlurState::Ready(c)) = self.wide_blur.as_mut()
                && c.covers(wp, inputs)
            {
                c.vis_tiles_grid = wp.vis_tiles_grid;
                c.apron_glass_safe = wp.apron_glass_safe;
                c.residual_readers.clone_from(&wp.residual_readers);
                true
            } else {
                false
            };
            if !ready {
                let need_wide = self.pending_tile.is_some() || plan.jobs.iter().any(|j| !j.detail && !j.rough);
                if !need_wide {
                    if !matches!(self.wide_blur.as_ref(), Some(WideBlurState::Ready(c)) if c.inputs == inputs) {
                        self.abort_wide_blur();
                    }
                } else {
                    self.abort_pending_tile();
                    let same_build = matches!(
                        self.wide_blur.as_ref(),
                        Some(WideBlurState::Building(b)) if b.inputs == inputs && b.plan == *wp
                    );
                    if !same_build {
                        self.abort_wide_blur();
                        self.wide_blur = Some(WideBlurState::Building(Box::new(WideBlurBuild {
                            plan: wp.clone(),
                            inputs,
                            background,
                            pass: None,
                        })));
                    }
                    self.deadline_ms = deadline;
                    let step = self.step_wide_blur(store, budgeted, &mut stats);
                    self.deadline_ms = None;
                    if !or_standin!(step) {
                        wide_paused = true;
                    }
                }
            }
        } else {
            self.abort_wide_blur();
        }
        // Drop a paused tile only when it no longer matches any desired job for this camera/halo
        // (and never drop it during a composite-only present call).
        if !composite_only
            && !wide_paused
            && let Some(pt) = self.pending_tile.as_ref()
            && (pt.halo != frame_halo
                || !plan.jobs.iter().any(|j| {
                    j.key == pt.key
                        && j.detail == pt.detail
                        && (j.detail || coarse_moving) == pt.coarse_readers
                        && (!options.moving || j.must)
                        && (plan.needs_on_screen(j) || !plan.jobs.iter().any(|j| plan.needs_on_screen(j)))
                }))
        {
            self.abort_pending_tile();
        }
        // While the camera moves, a frame starts at most `MOVING_PASSES` GPU passes of tile work,
        // and none while the GPU hasn't finished the last frame's: what isn't drawn shows its
        // stand-in (the overview at worst), and input never queues behind GPU work.
        let motion_capped = options.moving && options.budget_ms >= 1.0;
        if !motion_capped {
            self.motion_starved.fed();
        }
        // Moving frames that started no tile work for `pacing::STARVE_MS`, while some was wanted:
        // this one starts one bounded unit whatever the GPU says, so tiles always fill in.
        let starved = motion_capped && self.motion_starved.starved(now());
        let gpu_behind = motion_capped && !starved && self.gpu_behind(0);
        if gpu_behind {
            self.counters.motion_backoff = self.counters.motion_backoff.wrapping_add(1);
        }
        // A frame no slot can hold (`Plan::direct`) draws its tiles straight into the frame, and
        // they can't pause. While moving it's laid as stand-ins (the last frame moved, round what
        // changed, over the overview), with a few of its tiles drawn rough over them, the nearest
        // the middle first: bounded, soft, never an older frame's pixels.
        let direct_moving = plan.direct && motion_capped && !composite_only && selection.is_none();
        // At rest, under a real budget (or composite-only), such a frame is drawn over several
        // frames (`DirectSlices`), exact tiles within the budget each, nearest the middle first:
        // shown inexact, never old, until every tile is in. No budget: drawn at once, as before.
        let direct_sliced = plan.direct
            && !options.moving
            && !wide_paused
            && selection.is_none()
            && (options.budget_ms >= 1.0 || options.budget_ms < 0.0);
        self.pass_budget = motion_capped.then_some(MOVING_PASSES);
        self.passes_at = self.passes;
        let mut budget_hit = false;
        let mut unfinished_must = false;
        // Tiles nothing stands in for drawn this frame (moving frames draw one past their passes).
        let mut must_drawn = 0u32;
        if !composite_only && !wide_paused {
            // If we have a paused tile matching a job in this plan, resume it first so earlier
            // work completes cleanly before starting a new tile.
            let mut resumed_key: Option<TileKey> = None;
            if let Some(pt) = self.pending_tile.as_ref()
                && plan.jobs.iter().any(|j| j.key == pt.key && (!options.moving || j.must))
            {
                let key = pt.key;
                resumed_key = Some(key);
                let pt_job = plan.jobs.iter().find(|j| j.key == key).copied();
                let pt_must = pt_job.is_some_and(|j| j.must);
                let pt_deadline = if pt_must && options.budget_ms < 1.0 {
                    None
                } else {
                    deadline
                };
                if gpu_behind || pt_deadline.is_some_and(|d| now() >= d) {
                    budget_hit = true;
                    stats.in_progress = true;
                    if pt_must {
                        self.tiles.mark_unpainted(key);
                        unfinished_must = true;
                    }
                } else {
                    self.deadline_ms = pt_deadline;
                    must_drawn += u32::from(pt_must);
                    let rough = pt_job.is_some_and(|j| j.rough);
                    let step = self.resume_pending_tile(store, &mut stats);
                    self.deadline_ms = None;
                    // An overview tile that can't be drawn drops the overview, never the frame.
                    let step = match step {
                        Err(e) if rough && e.code != ErrorCode::DeviceLost => {
                            self.refuse_overview();
                            Ok(TileStep::Complete)
                        }
                        step => step,
                    };
                    match or_standin!(step) {
                        TileStep::Complete => {}
                        TileStep::Paused => {
                            budget_hit = true;
                            stats.in_progress = true;
                            if pt_must {
                                self.tiles.mark_unpainted(key);
                                unfinished_must = true;
                            }
                        }
                        TileStep::NoSlot => {
                            if let Some(job) = pt_job
                                && job.must
                            {
                                late.push(job);
                            }
                        }
                    }
                }
            }
            for job in &plan.jobs {
                if resumed_key == Some(job.key) || direct_moving || direct_sliced {
                    continue;
                }
                // The overview went with a tile that failed: its other jobs go too.
                if job.rough && !self.tiles.is_overview(&job.key) {
                    continue;
                }
                // Warm-cache fast path: during active budgeted motion, cached/stand-in tiles cover
                // `!job.must` slots with zero tile bakes so pan/zoom stays locked at 60 fps.
                if budgeted && options.moving && !job.must {
                    stats.queued += 1;
                    continue;
                }
                // A checkpoint owns its scratch, backdrop plane, and glass mask atlas.
                // It can span multiple frames. Leave other work queued until it releases them.
                if self.pending_tile.is_some() {
                    if job.must {
                        self.tiles.mark_unpainted(job.key);
                        unfinished_must = true;
                    } else {
                        stats.queued += 1;
                    }
                    continue;
                }
                // Direct visible work is drawn after compositing. Keep scratch free for it.
                if !late.is_empty() && !plan.needs_on_screen(job) {
                    stats.queued += 1;
                    continue;
                }
                // Microscopic budgets (`0 < budget_ms < 1 ms`) test spent optional budgets where
                // uncovered `must` tiles still draw. On real editor budgets (`>= 1 ms`), do not
                // cut off uncovered `must` tiles before real scene work (`records >= 64`) so
                // cold shader init on tiny scenes never leaves holes while heavy pages yield cleanly.
                // Direct tiles have no cache slot to carry progress to the next frame.
                // At rest, finish them together so a low-memory view can settle.
                let enforce_must =
                    budgeted && options.budget_ms >= 1.0 && stats.records >= 64 && (options.moving || !job.direct);
                // Moving: behind the GPU, tile work waits; past the frame's GPU passes too, but of
                // what nothing stands in for one tile a frame is still drawn, so it fills in.
                let passes_spent = motion_capped
                    && (gpu_behind
                        || ((!job.must || must_drawn > 0)
                            && self.passes.wrapping_sub(self.passes_at) >= MOVING_PASSES));
                let job_deadline = if job.must && !enforce_must { None } else { deadline };
                // A frame no slot can hold draws all its tiles or none (it shows the stand-in while
                // moving until starved): one left out would leave an older frame's pixels.
                let over_budget = !plan.direct
                    && (passes_spent
                        || if job.must {
                            enforce_must && (budget_hit || deadline.is_some_and(|d| now() >= d))
                        } else {
                            budget_hit || deadline.is_some_and(|d| now() >= d)
                        });
                if over_budget {
                    budget_hit = true;
                    if job.must {
                        self.tiles.mark_unpainted(job.key);
                        unfinished_must = true;
                    } else {
                        stats.queued += 1;
                    }
                    continue;
                }
                let tile_detail = job.detail || coarse_moving;
                if plan.direct {
                    let exact = or_standin!(self.draw_job(
                        store,
                        job,
                        tile_detail,
                        frame_halo,
                        background,
                        TileTarget::Scratch,
                        &plan,
                        dst,
                        &mut stats,
                        &mut verbs,
                    ));
                    direct_exact &= !tile_detail && exact;
                    must_drawn += 1;
                    continue;
                }
                if job.direct {
                    // Drawn straight into the frame, at once (it can't pause at the pass cap):
                    // while moving, only as a starved frame's one unit.
                    if motion_capped && (!starved || must_drawn > 0) {
                        self.tiles.mark_unpainted(job.key);
                        unfinished_must = true;
                        continue;
                    }
                    late.push(*job);
                    must_drawn += 1;
                    continue;
                }
                let elapsed = now() - t0;
                must_drawn += u32::from(job.must);
                if job.must && options.moving {
                    self.counters.motion_must = self.counters.motion_must.wrapping_add(1);
                }
                if budgeted {
                    // A drag composite also writes scratch this frame. Complete any tile
                    // started for it in one walk.
                    self.deadline_ms = if selection.is_some() || (job.must && options.budget_ms < 1.0) {
                        None
                    } else {
                        job_deadline.or(if job.must && options.budget_ms >= 1.0 {
                            deadline
                        } else {
                            None
                        })
                    };
                    let step = self.start_slot_tile(
                        store,
                        job,
                        tile_detail,
                        frame_halo,
                        background,
                        Self::inputs(store, generation, background),
                        &mut stats,
                        &mut verbs,
                    );
                    self.deadline_ms = None;
                    // An overview tile that can't be drawn drops the overview, never the frame.
                    let step = match step {
                        Err(e) if job.rough && e.code != ErrorCode::DeviceLost => {
                            self.refuse_overview();
                            continue;
                        }
                        step => step,
                    };
                    match or_standin!(step) {
                        TileStep::Complete => {
                            let took = now() - t0 - elapsed;
                            self.tile_ms = self.tile_ms * 0.75 + took * 0.25;
                        }
                        TileStep::Paused => {
                            budget_hit = true;
                            stats.in_progress = true;
                            if job.must {
                                self.tiles.mark_unpainted(job.key);
                                unfinished_must = true;
                            }
                        }
                        TileStep::NoSlot => {
                            if job.must {
                                late.push(*job);
                            }
                        }
                    }
                } else {
                    match self.tiles.slot_for(job.key) {
                        Some(s) => {
                            let reduced_before = stats.reduced;
                            let exact = self.draw_job(
                                store,
                                job,
                                tile_detail,
                                frame_halo,
                                background,
                                TileTarget::Slot(s),
                                &plan,
                                dst,
                                &mut stats,
                                &mut verbs,
                            )?;
                            let took = now() - t0 - elapsed;
                            self.tile_ms = self.tile_ms * 0.75 + took * 0.25;
                            self.tiles
                                .drawn(job.key, s, exact, !tile_detail, stats.reduced > reduced_before);
                        }
                        None => {
                            if job.must {
                                late.push(*job);
                            }
                        }
                    }
                }
            }
            self.pass_budget = None;
            if motion_capped {
                if must_drawn > 0 {
                    self.motion_starved.fed();
                } else if unfinished_must {
                    self.motion_starved.hungry(now());
                }
            }
        } else {
            // Composite-only presentation or paused wide-blur build: keep paused work intact.
            if self.pending_tile.is_some() || wide_paused {
                stats.in_progress = true;
            }
            if wide_paused {
                unfinished_must = true;
            }
            for job in &plan.jobs {
                if job.must {
                    if wide_paused {
                        self.tiles.mark_unpainted(job.key);
                    }
                    unfinished_must = true;
                } else {
                    stats.queued += 1;
                }
            }
        }
        if opening && !unfinished_must && self.pending_tile.is_none() {
            self.opening_pending = false;
        }
        if direct_moving {
            // The nearest the middle first, as many as a moving frame may: none while the GPU is
            // behind, unless starved.
            if !gpu_behind || starved {
                // Rough (`exec::Backend::rough`): no readers, isolated scopes or shadows, so
                // they're cheap and pause nowhere. Soft, never old, and drawn exactly at rest.
                let mut nearest: Vec<crate::tiles::Job> = plan.jobs.clone();
                nearest_middle(&mut nearest, plan.origin, (w, h));
                late.extend(nearest.into_iter().take(DIRECT_MOVING_TILES).map(|mut j| {
                    j.rough = true;
                    j.detail = true;
                    j
                }));
            }
            if late.is_empty() {
                self.motion_starved.hungry(now());
            } else {
                self.motion_starved.fed();
            }
        }
        // A sliced frame (`DirectSlices`) goes on from the frame shown when that's its last
        // slice, for this view: laid beneath unchanged, so the tiles in it stay exact. It's the
        // frame on screen, so what changed since the last slice shows its old pixels there until
        // drawn again (display never goes back), and the tiles under it are drawn again: only
        // changes since the last slice count, never a set an exact frame must clear. Else it
        // starts again over stand-ins.
        let mut slice_holes: Option<Vec<Rect>> = None;
        // The tiles this frame adds, each with whether it came out inexact: kept once it's shown.
        let mut slice_drawn: Vec<(TileKey, bool)> = Vec::new();
        if direct_sliced {
            let view_bits = view.as_coeffs().map(f64::to_bits);
            let goes_on = self.direct_slices.as_ref().is_some_and(|s| {
                s.view == view_bits
                    && s.size == (w, h)
                    && s.bg == bg_bits
                    && s.halo == frame_halo
                    && self.cur == Some(s.frame)
                    && self.screen.standin.is_none()
                    && last.is_some_and(|l| l.view == view && l.size == (w, h))
            });
            if goes_on {
                // What changed, and where an image got another resolution (never a hole: the
                // frame on screen shows there until drawn again, as for a refined tile). An edit
                // here starts the slice budget over.
                let mut gone = self.tiles.changed_on(view, (w, h));
                let edited = !gone.is_empty();
                gone.extend(self.tiles.sharpened_on(view, (w, h)));
                let t = i64::from(TILE);
                let origin = plan.origin;
                let s = self.direct_slices.as_mut().expect("sliced frame");
                if edited {
                    s.resting = 0;
                }
                let mut dropped = Vec::new();
                s.done.retain(|k| {
                    let (x, y) = (i64::from(k.i) * t + origin.0, i64::from(k.j) * t + origin.1);
                    let r = Rect::new(x as f64, y as f64, (x + t) as f64, (y + t) as f64);
                    let under = gone
                        .iter()
                        .any(|h| h.x0 < r.x1 && r.x0 < h.x1 && h.y0 < r.y1 && r.y0 < h.y1);
                    if under {
                        dropped.push(*k);
                    }
                    !under
                });
                // To the back of the queue to draw again, nearest the middle first among those
                // dropped together; one already waiting keeps its place.
                dropped.sort_by(|a, b| from_middle(a, origin, (w, h)).total_cmp(&from_middle(b, origin, (w, h))));
                for k in dropped {
                    s.inexact.remove(&k);
                    if !s.redraw.contains(&k) {
                        s.redraw.push(k);
                    }
                }
                // None while it's the frame on screen (`TileCache::base_kept`).
                slice_holes = Some(self.tiles.holes(view, (w, h)));
            } else {
                self.direct_slices = Some(DirectSlices {
                    view: view_bits,
                    size: (w, h),
                    bg: bg_bits,
                    halo: frame_halo,
                    frame: dst,
                    done: Vec::new(),
                    inexact: HashSet::new(),
                    redraw: Vec::new(),
                    redraw_first: false,
                    slowest_ms: 0.0,
                    resting: 0,
                });
            }
            // Tiles never drawn (nearest the middle first) and tiles to draw again (the longest
            // dropped first) take turns, whichever starts alternating by slice: each slice makes
            // progress on both.
            let s = self.direct_slices.as_mut().expect("sliced frame");
            let mut fresh: Vec<crate::tiles::Job> = plan
                .jobs
                .iter()
                .filter(|j| !s.done.contains(&j.key) && !s.redraw.contains(&j.key))
                .copied()
                .collect();
            nearest_middle(&mut fresh, plan.origin, (w, h));
            let again: Vec<crate::tiles::Job> = s
                .redraw
                .iter()
                .filter_map(|k| plan.jobs.iter().find(|j| j.key == *k && !s.done.contains(k)).copied())
                .collect();
            let (first, second) = if s.redraw_first { (again, fresh) } else { (fresh, again) };
            s.redraw_first = !s.redraw_first;
            let (mut a, mut b) = (first.into_iter(), second.into_iter());
            loop {
                let (x, y) = (a.next(), b.next());
                if x.is_none() && y.is_none() {
                    break;
                }
                late.extend(x);
                late.extend(y);
            }
        }
        // The slice's budget: the caller's (or `DIRECT_SLICE_MS` composite-only), doubled for
        // each slice the view has rested unchanged, up to `DIRECT_SLICE_MAX_MS`.
        let base_ms = if options.budget_ms >= 1.0 {
            options.budget_ms
        } else {
            DIRECT_SLICE_MS
        };
        let (resting, series_slowest) = self
            .direct_slices
            .as_ref()
            .filter(|_| direct_sliced)
            .map_or((0, 0.0), |s| (s.resting, s.slowest_ms));
        let slice_ms = (base_ms * f64::from(1u32 << resting.min(8))).min(DIRECT_SLICE_MAX_MS.max(base_ms));
        let slice_deadline = t0 + self.walk_budget_ms(slice_ms);
        // The slowest tile drawn this frame (for `DirectSlices::slowest_ms`).
        let mut slowest_tile: Option<f64> = None;
        let t1 = now();
        let mut present_encoder = None;
        if plan.direct && !direct_moving && !direct_sliced && !wide_paused {
            stats.plan = 2;
        } else {
            // What's drawn straight into the frame after it covers its tile there: the composite
            // counts it so (what no slot could be found for included).
            if self.pending_tile.is_some() && !late.is_empty() {
                // Direct tiles share scratch too. Present their stand-ins until the checkpoint
                // completes, rather than throwing away its progress to draw them this frame.
                unfinished_must = true;
                late.clear();
            }
            // A sliced frame draws only what its budget allows of `late`: the rest is laid
            // beneath (the frame on screen, or stand-ins), so none counts as drawn here.
            for job in &mut plan.jobs {
                job.direct = !direct_sliced && late.iter().any(|l| l.key == job.key);
            }
            let comp = if let Some(holes) = slice_holes.take() {
                Composite {
                    exact: false,
                    complete: false,
                    base: Some(Affine::IDENTITY),
                    holes,
                    ..Composite::default()
                }
            } else {
                self.heal_unbacked_tiles();
                self.tiles.compose(&plan, plan_last)
            };
            stats.exact = comp.exact;
            // A sliced frame counts what it leaves for later itself (below).
            stats.pending = if direct_sliced { 0 } else { comp.pending };
            // A frame shows a reduced effect when a visible tile holds one, whenever it was drawn.
            stats.reduced = stats.reduced.max(comp.reduced);
            stats.plan = if comp.complete && !self.opening_pending && !unfinished_must {
                0
            } else {
                1
            };
            let fuse_present = late.is_empty() && selection.is_none();
            present_encoder = self.composite(&comp, dst, background, w, h, !fuse_present, &mut stats)?;
            stats.render_ms += now() - t1;
            for (n, job) in late.iter().enumerate() {
                // A moving frame's rough tiles stop at the pass cap (the first always goes).
                if job.rough && n > 0 && self.passes.wrapping_sub(self.passes_at) >= MOVING_PASSES {
                    stats.pending += 1;
                    direct_exact = false;
                    continue;
                }
                // A sliced frame's tiles stop where the next would end past its budget, by the
                // slowest tile of the series so far (the first always goes: a tile can't pause),
                // unless what's left fits in about one and a half of the caller's budgets more
                // (never of a grown slice's): then this call finishes it.
                let slowest = slowest_tile.unwrap_or(0.0).max(series_slowest);
                if direct_sliced
                    && n > 0
                    && now() + slowest > slice_deadline
                    && slowest * (late.len() - n) as f64 > 1.5 * base_ms
                {
                    stats.pending += (late.len() - n) as u32;
                    break;
                }
                let tile_t0 = now();
                let tile_detail = job.detail || coarse_moving;
                self.rough = job.rough;
                let drawn = self.draw_job(
                    store,
                    job,
                    tile_detail,
                    if job.rough { 0 } else { frame_halo },
                    background,
                    TileTarget::Scratch,
                    &plan,
                    dst,
                    &mut stats,
                    &mut verbs,
                );
                self.rough = false;
                let exact = or_standin!(drawn);
                direct_exact &= !tile_detail && !job.rough && exact;
                if !job.rough {
                    slowest_tile = Some(slowest_tile.unwrap_or(0.0).max(now() - tile_t0));
                }
                if direct_sliced {
                    slice_drawn.push((job.key, tile_detail || !exact));
                }
            }
            if let (Some(now), Some(split)) = (selection, drag.and_then(|d| d.split.as_ref())) {
                let dragged = self.drag_composite(store, &plan, now, split, halo, background, dst, &mut stats);
                if let Err(e) = dragged {
                    self.scene.reset();
                    if standin_on_limit && e.code == ErrorCode::Limit {
                        return self.present_motion_standin(view, background, w, h, t0, submits0, true);
                    }
                    return Err(e);
                }
            }
        }
        // A composite-only frame at rest (the time between frames drew what it shows) plans no
        // overview: what's left of it is still the time between frames' to draw, so the caller
        // keeps that going. A frame drawn at once (no budget) waits for nothing.
        if !options.moving && options.budget_ms < 0.0 {
            stats.queued += self.tiles.overview_left(scale);
        }
        stats.pending = stats.pending.max(u32::from(self.opening_pending || unfinished_must));
        stats.exact = (plan.direct || stats.exact) && direct_exact && stats.pending == 0;
        if direct_sliced {
            // Exact once every tile is in, none inexact (as drawn last), whichever frame drew it.
            let inexact = slice_drawn.iter().any(|(_, inexact)| *inexact)
                || self
                    .direct_slices
                    .as_ref()
                    .is_none_or(|s| s.inexact.iter().any(|k| !slice_drawn.iter().any(|(d, _)| d == k)));
            stats.exact = stats.pending == 0 && !inexact;
            stats.plan = if stats.exact { 2 } else { 1 };
        }
        stats.direct = plan.direct || !late.is_empty();
        stats.standin = !stats.exact;
        stats.held = self.tiles.len() as u32;
        stats.evicted = self.tiles.stats.evicted;
        let stats = self.finish_frame(dst, stats, t0, submits0, present_encoder)?;
        self.cur = Some(dst);
        self.set_cur_page(true);
        self.last = Some(Last { view, size: (w, h) });
        self.last_scale = Some(scale);
        self.whole_samples = None;
        self.set_shown(generation, bg_bits, stats.exact);
        if direct_sliced && let Some(s) = self.direct_slices.as_mut() {
            s.frame = dst;
            s.slowest_ms = s.slowest_ms.max(slowest_tile.unwrap_or(0.0));
            s.resting = s.resting.saturating_add(1);
            for (k, inexact) in slice_drawn {
                s.done.push(k);
                s.redraw.retain(|r| *r != k);
                if inexact {
                    s.inexact.insert(k);
                } else {
                    s.inexact.remove(&k);
                }
            }
        } else {
            self.direct_slices = None;
        }
        Ok(stats)
    }

    /// Records the frame shown (`last`, set first), drawn at `generation` over `background`: the
    /// one the next is laid on. Drawn from what's current, it forgets what changed before it
    /// (`TileCache::frame_drawn`). A stand-in after a limit isn't recorded: it keeps the frame
    /// it was warped from, and what changed since.
    /// The scale of a frame no slot can hold being drawn over several frames (`DirectSlices`).
    pub fn direct_slices_scale(&self) -> Option<f64> {
        self.direct_slices.as_ref().map(|s| f64::from_bits(s.view[0]))
    }

    /// A sliced frame's tiles drawn inexact are drawn again, as the cache's are once no
    /// provisional record shows (`TileCache::invalidate_inexact_full`).
    pub fn direct_slices_drop_inexact(&mut self) {
        if let Some(s) = self.direct_slices.as_mut() {
            let inexact = std::mem::take(&mut s.inexact);
            s.done.retain(|k| !inexact.contains(k));
            for k in inexact {
                if !s.redraw.contains(&k) {
                    s.redraw.push(k);
                }
            }
        }
    }

    /// A frame was asked for at `view` and `size`: when it moves, or the view changed, the camera
    /// had input then (`OVERVIEW_REFINE_QUIET_MS` counts from it).
    pub fn note_input(&mut self, view: Affine, size: (u32, u32), moving: bool) {
        let at = (view.as_coeffs().map(f64::to_bits), size);
        if moving || self.input_view != Some(at) {
            self.last_input_ms = now();
            self.input_view = Some(at);
        }
    }

    /// Whether the camera has been still long enough to draw the overview's refined tiles again.
    fn quiet_for_overview(&self) -> bool {
        now() - self.last_input_ms >= OVERVIEW_REFINE_QUIET_MS
    }

    /// Before drawing `key` between frames: a refined overview tile's walk pauses after
    /// `OVERVIEW_REFINE_PASSES` GPU passes, so no submission of it is long; anything else has
    /// no pass budget there.
    fn idle_pass_budget(&mut self, key: &TileKey) {
        let refined = self.tiles.is_overview(key) && self.tiles.get(key).is_some_and(|e| !e.stale && e.refine);
        self.pass_budget = refined.then_some(OVERVIEW_REFINE_PASSES);
        self.passes_at = self.passes;
    }

    fn set_shown(&mut self, generation: u64, background: [u32; 4], exact: bool) {
        self.shown = Some((generation, background, exact));
        self.tiles.frame_drawn();
    }

    /// The frame last shown: the view it was drawn under and its size.
    pub fn last(&self) -> Option<Last> {
        self.last
    }

    /// Whether the frame shown was drawn over an opaque background (so every pixel is opaque).
    pub fn opaque(&self) -> bool {
        self.shown.is_some_and(|(_, bg, _)| f32::from_bits(bg[3]) >= 1.0)
    }

    /// Draws tiles the next frame will want, for the frame last shown (its view and size): the
    /// ones it shows that aren't up to date (nearest the view's centre first), then those round
    /// it, strictly bounded by `budget_ms` (cooperative mid-tile yielding ensures no slice stalls
    /// past ~1 frame while still making strict forward progress). Compositing and presenting are
    /// deferred to the caller.
    pub fn ahead(
        &mut self,
        store: &Store,
        background: [f32; 4],
        generation: u64,
        halo: i32,
        wide_plan: Option<&halo::WideBlurPlan>,
        budget_ms: f64,
    ) -> Result<DrawStats> {
        self.check()?;
        self.abort_pending_whole();
        self.pass_budget = None;
        let mut stats = DrawStats::default();
        let Some(last) = self.last else {
            return Ok(stats);
        };
        let inputs = Self::inputs(store, generation, background);
        if self
            .pending_tile
            .as_ref()
            .is_some_and(|pt| pt.inputs != inputs || pt.halo != halo)
        {
            self.abort_pending_tile();
        }
        if self.pending_tile.is_none() {
            self.readers.drop_glass_mask_atlas();
        }
        let t0 = now();
        let submits0 = self.submits;
        self.masks.begin_frame();
        self.blur.begin_frame();
        self.shadow.begin_frame();
        self.tiles.begin_scaled(background, last.view.as_coeffs()[0], halo);
        self.set_overview(store);
        self.tiles.moving = false;
        self.tiles.bake_overview = true;
        self.tiles.refine_overview = self.quiet_for_overview();
        self.fit_tiles(store.limits.tile_bytes);
        self.heal_unbacked_tiles();
        let opening = self.opening_pending;
        self.tiles.opening = opening;
        let plan_last = if opening { None } else { Some(last) };
        let Some(plan) = self.tiles.plan(
            last.view,
            last.size,
            opening,
            plan_last,
            !opening && wide_plan.is_none() && i64::from(halo) <= i64::from(store.limits.halo),
            false,
        ) else {
            return Ok(stats);
        };
        // Off-screen work (tiles round the view, the overview) waits while the GPU hasn't
        // finished the last slices: more would only queue behind them, and the next input behind
        // that. Between frames a slice or two may be in flight, so the CPU and GPU still overlap.
        // What the view shows is never held back.
        if budget_ms >= 1.0 && !plan.jobs.iter().any(|j| plan.needs_on_screen(j)) && self.gpu_behind(IDLE_IN_FLIGHT) {
            stats.pending = self.tiles.left(&plan).0.max(1);
            stats.in_progress = true;
            return Ok(stats);
        }
        let budgeted = budget_ms > 0.0;
        let walk_budget = self.walk_budget_ms(budget_ms);
        let deadline = budgeted.then_some(t0 + walk_budget);
        if let Some(wp) = wide_plan {
            let ready = if let Some(WideBlurState::Ready(c)) = self.wide_blur.as_mut()
                && c.covers(wp, inputs)
            {
                c.vis_tiles_grid = wp.vis_tiles_grid;
                c.apron_glass_safe = wp.apron_glass_safe;
                c.residual_readers.clone_from(&wp.residual_readers);
                true
            } else {
                false
            };
            if !ready {
                let need_wide = !opening
                    && (self.pending_tile.is_some() || plan.jobs.iter().any(|j| !j.direct && !j.detail && !j.rough));
                if !need_wide {
                    if !matches!(self.wide_blur.as_ref(), Some(WideBlurState::Ready(c)) if c.inputs == inputs) {
                        self.abort_wide_blur();
                    }
                } else {
                    self.abort_pending_tile();
                    let same_build = matches!(
                        self.wide_blur.as_ref(),
                        Some(WideBlurState::Building(b)) if b.inputs == inputs && b.plan == *wp
                    );
                    if !same_build {
                        self.abort_wide_blur();
                        self.wide_blur = Some(WideBlurState::Building(Box::new(WideBlurBuild {
                            plan: wp.clone(),
                            inputs,
                            background,
                            pass: None,
                        })));
                    }
                    self.deadline_ms = deadline;
                    let step = self.step_wide_blur(store, budgeted, &mut stats);
                    self.deadline_ms = None;
                    if !step? {
                        stats.pending = self.tiles.left(&plan).0.max(1);
                        stats.in_progress = true;
                        stats.held = self.tiles.len() as u32;
                        stats.evicted = self.tiles.stats.evicted;
                        stats.submits = self.submits.saturating_sub(submits0);
                        if stats.submits > 0 {
                            self.note_submitted();
                        }
                        stats.cpu_ms = now() - t0;
                        self.scene.reset();
                        self.check()?;
                        return Ok(stats);
                    }
                }
            }
        } else {
            self.abort_wide_blur();
        }
        // Ahead can't finish a direct tile. Let the caller present it, even when
        // there is optional work left that could otherwise keep ahead reporting progress.
        let mut needs_direct = plan.jobs.iter().any(|j| j.direct);
        if let Some(pt) = self.pending_tile.as_ref()
            && !plan.jobs.iter().any(|j| {
                !j.direct
                    && j.key == pt.key
                    && j.detail == pt.detail
                    && j.detail == pt.coarse_readers
                    && (plan.needs_on_screen(j) || !plan.jobs.iter().any(|j| plan.needs_on_screen(j)))
            })
        {
            self.abort_pending_tile();
        }
        let mut verbs = store.limits.frame_verbs;
        let mut resumed_key: Option<TileKey> = None;
        let mut budget_hit = false;
        if let Some(pt) = self.pending_tile.as_ref() {
            let key = pt.key;
            let rough = pt.rough;
            self.deadline_ms = deadline;
            self.idle_pass_budget(&key);
            let step = self.resume_pending_tile(store, &mut stats);
            self.deadline_ms = None;
            self.pass_budget = None;
            // An overview tile that can't be drawn drops the overview, never the slice.
            let step = match step {
                Err(e) if e.code != ErrorCode::DeviceLost && rough => {
                    self.refuse_overview();
                    Ok(TileStep::Complete)
                }
                step => step,
            };
            match step? {
                TileStep::Complete => resumed_key = Some(key),
                TileStep::NoSlot => {
                    resumed_key = Some(key);
                    needs_direct = true;
                }
                TileStep::Paused => {
                    budget_hit = true;
                    stats.in_progress = true;
                }
            }
        }
        if !budget_hit && !plan.direct {
            for job in &plan.jobs {
                if job.direct || resumed_key == Some(job.key) || (needs_direct && !plan.needs_on_screen(job)) {
                    continue;
                }
                // The overview went with a tile that failed: its other jobs go too.
                if job.rough && !self.tiles.is_overview(&job.key) {
                    continue;
                }
                if deadline.is_some_and(|d| now() >= d) {
                    break;
                }
                self.deadline_ms = deadline;
                self.idle_pass_budget(&job.key);
                let step = self.start_slot_tile(
                    store,
                    job,
                    job.detail,
                    halo,
                    background,
                    Self::inputs(store, generation, background),
                    &mut stats,
                    &mut verbs,
                );
                self.deadline_ms = None;
                self.pass_budget = None;
                let step = match step {
                    Err(e) if e.code != ErrorCode::DeviceLost && job.rough => {
                        self.refuse_overview();
                        continue;
                    }
                    step => step,
                };
                match step? {
                    TileStep::Complete => {}
                    TileStep::NoSlot => needs_direct |= plan.needs_on_screen(job),
                    TileStep::Paused => {
                        stats.in_progress = true;
                        break;
                    }
                }
            }
        }
        let (mut pending, queued) = self.tiles.left(&plan);
        // The overview's refined tiles wait for the camera to be still a while: the time between
        // frames goes on (doing nothing) until they're drawn.
        if pending == 0 && queued == 0 && self.tiles.overview_refined_left(last.view.as_coeffs()[0]) > 0 {
            stats.in_progress = true;
        }
        if opening && pending == 0 && self.pending_tile.is_none() {
            // Coarse opening ladder tiles are complete; next slices refine exact tiles.
            self.opening_pending = false;
            pending = 1;
        }
        stats.pending = pending;
        stats.queued = queued;
        stats.held = self.tiles.len() as u32;
        stats.evicted = self.tiles.stats.evicted;
        stats.submits = self.submits.saturating_sub(submits0);
        if stats.submits > 0 {
            self.note_submitted();
        }
        stats.cpu_ms = now() - t0;
        self.scene.reset();
        self.check()?;
        Ok(stats)
    }

    /// Presents the frame shown (with a canvas) and finishes the frame's numbers.
    /// When `pending_encoder` is provided (from `composite`), the present blit is recorded into
    /// the same command buffer so composite + present submit in a single `queue.submit`.
    fn finish_frame(
        &mut self,
        frame: usize,
        mut stats: DrawStats,
        t0: f64,
        submits0: u32,
        pending_encoder: Option<wgpu::CommandEncoder>,
    ) -> Result<DrawStats> {
        let t1 = now();
        self.check()?;
        self.configure_surface(frame)?;
        // What was shown stays recorded until this frame replaces it (issue #355).
        let acquired = self.acquire();
        stats.presented = self.screen.acquired(self.surface.is_some(), &acquired);
        let acquired = match acquired {
            Ok(t) => t,
            Err(e) => {
                if let Some(encoder) = pending_encoder {
                    self.queue.submit([encoder.finish()]);
                    self.submits += 1;
                }
                self.scene.reset();
                return Err(e);
            }
        };
        if let (Some(t), Some(blit)) = (acquired, self.blit.as_ref()) {
            let main = &self.frames[frame];
            let mut encoder = pending_encoder.unwrap_or_else(|| {
                self.device
                    .create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("present") })
            });
            let view = t.texture.create_view(&Default::default());
            let fallback_group;
            let group = match main.present_group.as_ref() {
                Some(g) => g,
                None => {
                    fallback_group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                        label: None,
                        layout: &blit.get_bind_group_layout(0),
                        entries: &[wgpu::BindGroupEntry {
                            binding: 0,
                            resource: wgpu::BindingResource::TextureView(&main.view),
                        }],
                    });
                    &fallback_group
                }
            };
            {
                let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: Some("present"),
                    color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                        view: &view,
                        depth_slice: None,
                        resolve_target: None,
                        ops: wgpu::Operations {
                            load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                            store: wgpu::StoreOp::Store,
                        },
                    })],
                    ..Default::default()
                });
                pass.set_pipeline(blit);
                pass.set_bind_group(0, group, &[]);
                pass.draw(0..3, 0..1);
            }
            stats.draws += 1;
            self.queue.submit([encoder.finish()]);
            self.submits += 1;
            self.queue.present(t);
        } else if let Some(encoder) = pending_encoder {
            self.queue.submit([encoder.finish()]);
            self.submits += 1;
        }
        stats.submit_ms += now() - t1;
        stats.submits = self.submits.saturating_sub(submits0);
        self.note_submitted();
        self.end_frame_timestamp();
        stats.cpu_ms = now() - t0;
        self.scene.reset();
        self.check()?;
        Ok(stats)
    }

    /// Draws a job's tile into `target`, with a fresh allowance of generated geometry (each tile
    /// is its own render); a slot handed out for it goes back if the draw fails.
    #[allow(clippy::too_many_arguments)]
    fn draw_job(
        &mut self,
        store: &Store,
        job: &crate::tiles::Job,
        detail: bool,
        halo: i32,
        background: [f32; 4],
        target: TileTarget,
        plan: &crate::tiles::Plan,
        dst: usize,
        stats: &mut DrawStats,
        verbs: &mut usize,
    ) -> Result<bool> {
        *verbs = store.limits.frame_verbs;
        match self.draw_tile(
            store,
            job.view,
            job.detail,
            detail,
            halo,
            background,
            &Split::all(),
            target,
            plan,
            job.key,
            dst,
            stats,
            verbs,
        ) {
            Ok(exact) => {
                stats.tiles_drawn += 1;
                Ok(exact)
            }
            Err(e) => {
                if let TileTarget::Slot(s) = target {
                    self.tiles.release(job.key, s);
                }
                self.scene.reset();
                Err(e)
            }
        }
    }

    /// Uploads the masks placed since the last flush: one write per atlas shelf they're on (a
    /// shelf's new masks lie side by side, so the box round them holds nothing else), not one per
    /// mask. A page shown at a new scale places thousands, and each write is a call into the
    /// browser.
    fn flush_masks(&mut self) {
        let mut pending = std::mem::take(&mut self.atlas.pending);
        if pending.is_empty() {
            return;
        }
        pending.sort_unstable_by_key(|m| (m.1, m.0));
        let mut i = 0;
        while i < pending.len() {
            let y = pending[i].1;
            let mut j = i;
            while j < pending.len() && pending[j].1 == y {
                j += 1;
            }
            let shelf = &pending[i..j];
            let x0 = shelf.iter().map(|m| m.0).min().unwrap_or(0);
            let x1 = shelf.iter().map(|m| m.0 + m.2).max().unwrap_or(0);
            let h = shelf.iter().map(|m| m.3).max().unwrap_or(0);
            let row = (x1 - x0) as usize * 4;
            let mut buf = vec![0u8; row * h as usize];
            for (x, _, w, mh, data) in shelf {
                let line = *w as usize * 4;
                for r in 0..*mh as usize {
                    let to = r * row + (*x - x0) as usize * 4;
                    buf[to..to + line].copy_from_slice(&data[r * line..r * line + line]);
                }
            }
            write(&self.queue, &self.atlas.texture, x0, y, x1 - x0, h, &buf);
            i = j;
        }
    }

    /// Draws one tile: the scene under its view (`TILE + 2 * halo` a side into `self.scratch`),
    /// then copies the middle `TILE` × `TILE` pixels into its slot (or straight into frame
    /// texture `dst`). Answers whether it was drawn exactly (no level of detail stood in).
    fn tile_apron_config(&self, store: &Store, view: Affine, key: TileKey, halo: i32, rough: bool) -> (i32, bool) {
        if halo <= 0 || rough {
            return (0, false);
        }
        if !store.has_context()
            && let Some(WideBlurState::Ready(cache)) = self.wide_blur.as_ref()
            && crate::tiles::Level::of(view).is_some_and(|(lvl, _)| lvl == cache.level)
        {
            return (cache.halo_for_tile(key.i, key.j, halo), cache.apron_glass_safe);
        }
        let tile_halo = if !store.has_context()
            && !store.has_reader_in_rect(
                view,
                Rect::new(-2.0, -2.0, f64::from(TILE) + 2.0, f64::from(TILE) + 2.0),
            ) {
            0
        } else {
            halo
        };
        (tile_halo, false)
    }

    #[allow(clippy::too_many_arguments)]
    fn draw_tile(
        &mut self,
        store: &Store,
        view: Affine,
        detail: bool,
        coarse_readers: bool,
        halo: i32,
        background: [f32; 4],
        split: &Split,
        target: TileTarget,
        plan: &crate::tiles::Plan,
        key: TileKey,
        dst: usize,
        stats: &mut DrawStats,
        verbs: &mut usize,
    ) -> Result<bool> {
        let t0 = now();
        let (tile_halo, clip_apron_glass) = self.tile_apron_config(store, view, key, halo, false);
        let clip_apron_glass = clip_apron_glass && !matches!(target, TileTarget::ScratchOnly);
        let h = tile_halo as u32;
        let side = TILE + 2 * h;
        let tile = Frame {
            width: side as u16,
            height: side as u16,
            view: Affine::translate((f64::from(h), f64::from(h))) * view,
            detail,
            area: IRect {
                x0: 0,
                y0: 0,
                x1: side as i32,
                y1: side as i32,
            },
        };
        // Every tile renders into the active scratch slot (ensured before walking so mid-tile
        // reader flushes can target it directly).
        self.begin_scratch_draw(side, tile_halo, clip_apron_glass, tile.view, background, coarse_readers)?;
        if !coarse_readers
            && tile_halo > 0
            && let Err(e) = self.prepare_glass_masks(store, &tile)
        {
            self.discard_draw();
            return Err(e);
        }
        let limits = store.limits;
        let s = match exec::draw_split(store, self, &tile, &limits, verbs, split, coarse_readers) {
            Ok(s) => s,
            Err(e) => {
                self.discard_draw();
                return Err(e);
            }
        };
        stats.add(&s);
        // Exact only if nothing stood in: no level of detail, no provisional record.
        let exact = s.exact();
        let place = match target {
            TileTarget::Slot(slot) => match self.slot_place(slot) {
                Ok(p) => Some(p),
                Err(e) => {
                    self.discard_draw();
                    return Err(e);
                }
            },
            TileTarget::Scratch | TileTarget::ScratchOnly => None,
        };
        let only = matches!(target, TileTarget::ScratchOnly);

        // Where the middle `TILE x TILE` pixels go: its slot in a page, or (drawn direct) the frame.
        let copy_info = if only {
            None
        } else {
            match place {
                Some((p, x, y)) => Some((true, p, (h, h), (x, y, TILE, TILE))),
                None => {
                    let t = i64::from(TILE);
                    let fx = i64::from(key.i) * t + plan.origin.0;
                    let fy = i64::from(key.j) * t + plan.origin.1;
                    let (fw, fh) = (i64::from(plan.size.0), i64::from(plan.size.1));
                    let (x0, y0) = (fx.max(0), fy.max(0));
                    let (x1, y1) = ((fx + t).min(fw), (fy + t).min(fh));
                    if x1 <= x0 || y1 <= y0 {
                        None
                    } else {
                        Some((
                            false,
                            dst,
                            (h + (x0 - fx) as u32, h + (y0 - fy) as u32),
                            (x0 as u32, y0 as u32, (x1 - x0) as u32, (y1 - y0) as u32),
                        ))
                    }
                }
            }
        };

        let active = self.finish_scratch_to_frame(copy_info, 4)?;
        active.record_into(stats, now() - t0);
        Ok(exact)
    }

    /// Computes the cooperative scene-walk budget for a slice, reserving headroom for
    /// synchronous `queue.submit` translation on backends like WebGL2.
    fn walk_budget_ms(&self, budget_ms: f64) -> f64 {
        if budget_ms < 1.0 {
            budget_ms
        } else {
            (budget_ms / (1.0 + self.submit_ratio)).clamp(1.0, budget_ms)
        }
    }

    fn update_submit_ratio(&mut self, slice_total_ms: f64, slice_submit_ms: f64) {
        if slice_submit_ms <= 0.0 || slice_total_ms <= 0.0 {
            return;
        }
        let work_ms = (slice_total_ms - slice_submit_ms).max(0.5);
        let ratio = (slice_submit_ms / work_ms).clamp(0.0, 6.0);
        self.submit_ratio = self.submit_ratio * 0.75 + ratio * 0.25;
    }

    /// Starts a budgeted tile render for a cache slot with cooperative mid-tile yielding.
    /// If the frame deadline expires mid-walk, flushes progress into scratch and stores a
    /// `PendingTile` without claiming an atlas slot until completion.
    #[allow(clippy::too_many_arguments)]
    fn start_slot_tile(
        &mut self,
        store: &Store,
        job: &crate::tiles::Job,
        coarse_readers: bool,
        halo: i32,
        background: [f32; 4],
        inputs: DrawInputs,
        stats: &mut DrawStats,
        verbs: &mut usize,
    ) -> Result<TileStep> {
        debug_assert!(self.pending_tile.is_none(), "paused tile still owns scratch");
        let t0 = now();
        *verbs = store.limits.frame_verbs;
        // A rough stand-in reads nothing, so it needs no apron.
        let (tile_halo, clip_apron_glass) = self.tile_apron_config(store, job.view, job.key, halo, job.rough);
        let h = tile_halo as u32;
        let side = TILE + 2 * h;
        let tile = Frame {
            width: side as u16,
            height: side as u16,
            view: Affine::translate((f64::from(h), f64::from(h))) * job.view,
            detail: job.detail,
            area: IRect {
                x0: 0,
                y0: 0,
                x1: side as i32,
                y1: side as i32,
            },
        };
        self.begin_scratch_draw(side, tile_halo, clip_apron_glass, tile.view, background, coarse_readers)?;
        if !coarse_readers
            && tile_halo > 0
            && let Err(e) = self.prepare_glass_masks(store, &tile)
        {
            self.discard_draw();
            return Err(e);
        }
        let limits = store.limits;
        let allow_yield = self.deadline_ms.is_some();
        self.rough = job.rough;
        let outcome = exec::draw_split_resumable(
            store,
            self,
            &tile,
            &limits,
            verbs,
            &Split::all(),
            coarse_readers,
            None,
            allow_yield,
        );
        self.rough = false;
        let outcome = match outcome {
            Ok(o) => o,
            Err(e) => {
                self.discard_draw();
                return Err(e);
            }
        };
        self.finish_slot_step(
            outcome,
            job.key,
            job.view,
            job.detail,
            job.rough,
            coarse_readers,
            halo,
            tile_halo,
            side,
            background,
            inputs,
            *verbs,
            t0,
            stats,
        )
    }

    /// Resumes the paused `PendingTile` for one more budgeted slice.
    fn resume_pending_tile(&mut self, store: &Store, stats: &mut DrawStats) -> Result<TileStep> {
        let Some(mut pt) = self.pending_tile.take() else {
            return Ok(TileStep::Complete);
        };
        let t0 = now();
        let checkpoint = self.resume_walk(pt.paused, (pt.side as u16, pt.side as u16));
        let h = pt.tile_halo as u32;
        let tile = Frame {
            width: pt.side as u16,
            height: pt.side as u16,
            view: Affine::translate((f64::from(h), f64::from(h))) * pt.view,
            detail: pt.detail,
            area: IRect {
                x0: 0,
                y0: 0,
                x1: pt.side as i32,
                y1: pt.side as i32,
            },
        };
        let limits = store.limits;
        let allow_yield = self.deadline_ms.is_some();
        self.rough = pt.rough;
        let outcome = exec::draw_split_resumable(
            store,
            self,
            &tile,
            &limits,
            &mut pt.verbs,
            &Split::all(),
            pt.coarse_readers,
            checkpoint,
            allow_yield,
        );
        self.rough = false;
        let outcome = match outcome {
            Ok(o) => o,
            Err(e) => {
                self.discard_draw();
                self.readers.drop_glass_mask_atlas();
                return Err(e);
            }
        };
        self.finish_slot_step(
            outcome,
            pt.key,
            pt.view,
            pt.detail,
            pt.rough,
            pt.coarse_readers,
            pt.halo,
            pt.tile_halo,
            pt.side,
            pt.background,
            pt.inputs,
            pt.verbs,
            t0,
            stats,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn finish_slot_step(
        &mut self,
        outcome: exec::WalkOutcome,
        key: TileKey,
        view: Affine,
        detail: bool,
        rough: bool,
        coarse_readers: bool,
        halo: i32,
        tile_halo: i32,
        side: u32,
        background: [f32; 4],
        inputs: DrawInputs,
        verbs: usize,
        t0: f64,
        stats: &mut DrawStats,
    ) -> Result<TileStep> {
        match outcome {
            exec::WalkOutcome::Paused {
                stats: slice_stats,
                checkpoint,
            } => {
                stats.add(&slice_stats);
                let paused = self.pause_walk(Some(checkpoint), stats, t0)?;
                self.pending_tile = Some(PendingTile {
                    key,
                    view,
                    detail,
                    rough,
                    coarse_readers,
                    halo,
                    tile_halo,
                    side,
                    background,
                    inputs,
                    paused,
                    verbs,
                });
                Ok(TileStep::Paused)
            }
            exec::WalkOutcome::Complete {
                stats: slice_stats,
                total,
            } => {
                let exact = total.exact();
                let reduced = total.reduced > 0;
                stats.add(&slice_stats);
                let sub0 = stats.submit_ms;
                let h = tile_halo as u32;
                // A rough tile is only ever the overview's: once that's gone it's kept nowhere,
                // never in a frame's slot.
                let slot = if rough && !self.tiles.is_overview(&key) {
                    None
                } else {
                    self.tiles.slot_for(key)
                };
                let place = match slot {
                    Some(s) => match self.slot_place(s) {
                        Ok(p) => Some((s, p)),
                        Err(e) => {
                            self.tiles.release(key, s);
                            self.discard_draw();
                            self.readers.drop_glass_mask_atlas();
                            return Err(e);
                        }
                    },
                    None => None,
                };
                let copy = place.map(|(_, (page, x, y))| (true, page, (h, h), (x, y, TILE, TILE)));
                let active = match self.finish_scratch_to_frame(copy, 6) {
                    Ok(active) => active,
                    Err(e) => {
                        if let Some((s, _)) = place {
                            self.tiles.release(key, s);
                        }
                        self.readers.drop_glass_mask_atlas();
                        return Err(e);
                    }
                };
                self.readers.drop_glass_mask_atlas();
                self.readers.flush_retired();
                let slice_total = now() - t0;
                active.record_into(stats, slice_total);
                self.update_submit_ratio(slice_total, stats.submit_ms - sub0);
                if let Some((s, _)) = place {
                    if self.tiles.is_overview(&key) {
                        self.counters.overview = self.counters.overview.wrapping_add(1);
                    }
                    self.tiles.drawn(key, s, exact, !coarse_readers, reduced);
                    stats.tiles_drawn += 1;
                    Ok(TileStep::Complete)
                } else {
                    Ok(TileStep::NoSlot)
                }
            }
        }
    }

    /// The active scope's planes never resolve past the top of the stack. A shared scope
    /// aliases both channels to its one source, even when only the backdrop channel is selected.
    fn plane(&self, backdrop: bool) -> Result<(&wgpu::Texture, &wgpu::TextureView, u64, &wgpu::TextureView)> {
        if let Some(scope) = self.offscreen_stack.last() {
            let target = scope.plane(backdrop);
            return Ok((&target.tex, &target.view, target.view_id, &target.depth));
        }
        self.root_plane(backdrop)
    }

    fn root_plane(&self, backdrop: bool) -> Result<(&wgpu::Texture, &wgpu::TextureView, u64, &wgpu::TextureView)> {
        let root = self.scratches[self.active_scratch]
            .as_ref()
            .ok_or_else(|| EngineError::new(ErrorCode::State, "no scratch tile"))?;
        if backdrop {
            let back = self
                .readers
                .backdrop_frame
                .as_ref()
                .ok_or_else(|| EngineError::new(ErrorCode::State, "no backdrop plane"))?;
            return Ok((&back.texture, &back.view, back.view_id, &root.depth));
        }
        if let Some(dst) = self.active.as_ref().and_then(|active| active.frame_dst) {
            let frame = &self.frames[dst];
            return Ok((&frame.texture, &frame.view, frame.tex_view_id, &root.depth));
        }
        Ok((&root.texture, &root.view, root.view_id, &root.depth))
    }

    fn active_scene_size(&self) -> (u16, u16) {
        if let Some(scope) = self.offscreen_stack.last() {
            scope.main.active_size
        } else {
            self.active
                .as_ref()
                .map_or((1, 1), |a| (a.width as u16, a.height as u16))
        }
    }

    fn discard_draw(&mut self) {
        self.active = None;
        self.renderer.discard_uploads();
        self.readers.discard_uniforms();
        self.blend.discard_uniforms();
        self.blur.discard_uniforms();
        self.shadow.discard_uniforms();
        let _ = self.readers.take_draws() + self.blur.take_draws() + self.shadow.take_draws();
        self.blur.flush_retired();
        self.readers.flush_retired();
        self.flush_retired_textures();
        self.atlas.pending.clear();
        while let Some(scope) = self.offscreen_stack.pop() {
            self.offscreen_pool.push(scope.main);
            self.offscreen_pool.extend(scope.backdrop);
        }
        self.offscreen_pool.append(&mut self.offscreen_in_use);
        self.clear_clip_mask_cache();
        self.scene.reset();
        self.recycle_scene_textures();
        self.atlas.at = (0, 0, 0);
    }

    /// Called after submitting the scene that references these textures, or dropping that scene.
    fn recycle_scene_textures(&mut self) {
        self.release_temp_textures();
        self.temp_pool.append(&mut self.temp_in_use);
        for shadow in self.retired_shadows.drain(..) {
            self.bindings.remove(shadow.tid);
            self.pool_bytes = self.pool_bytes.saturating_sub(shadow.bytes);
            shadow.tex.destroy();
        }
        self.in_use_bytes = 0;
    }

    fn reopen_clips(&mut self, open: &[Open]) {
        for o in open {
            if let Open::Clip {
                transform,
                path,
                even_odd,
                active_on_scene: true,
                ..
            } = o
            {
                self.scene.set_transform(*transform);
                self.scene
                    .set_fill_rule(if *even_odd { Fill::EvenOdd } else { Fill::NonZero });
                self.scene.push_clip_path(path);
            }
        }
    }

    fn reader_target_opaque(&self, within: Option<glass::ClipWithin>) -> bool {
        self.offscreen_stack.is_empty()
            && self
                .active
                .as_ref()
                .is_some_and(|a| a.background[3] >= 1.0 && !a.has_context)
            && within.is_none_or(|w| w.fill.is_none_or(|c| c[3] == 255))
    }

    fn ensure_scope_cleared(&mut self, scope_idx: usize, main: bool, backdrop: bool) {
        let shared = self.offscreen_stack[scope_idx].backdrop.is_none();
        let clear_main = (main || (shared && backdrop)) && self.offscreen_stack[scope_idx].main.needs_clear;
        let clear_back = !shared
            && backdrop
            && self.offscreen_stack[scope_idx]
                .backdrop
                .as_ref()
                .is_some_and(|b| b.needs_clear);
        if !clear_main && !clear_back {
            return;
        }
        let mut encoder = self.take_encoder("isolation lazy clear");
        if clear_main {
            let target = &mut self.offscreen_stack[scope_idx].main;
            GpuReaders::encode_clear(&mut encoder, &target.view, wgpu::Color::TRANSPARENT);
            target.needs_clear = false;
        }
        if clear_back {
            let target = self.offscreen_stack[scope_idx]
                .backdrop
                .as_mut()
                .expect("scope backdrop");
            GpuReaders::encode_clear(&mut encoder, &target.view, wgpu::Color::TRANSPARENT);
            target.needs_clear = false;
        }
        self.stash_encoder(encoder);
    }

    /// Flushes the scene into the active scope, rasterizing a segment once when both planes
    /// need it. The delta and both depth targets match the local scope's allocation.
    fn flush_scene_gpu(&mut self, force_clear: bool) -> Result<()> {
        let why = std::mem::take(&mut self.flush_why);
        let Some(active) = self.active.as_ref() else {
            return Ok(());
        };
        let root = self.offscreen_stack.is_empty();
        let needs_clear = root && active.needs_clear && (force_clear || active.scene_dirty);
        let scene_dirty = active.scene_dirty;
        if !scene_dirty && !needs_clear {
            return Ok(());
        }
        let t0 = now();
        let sub0 = active.submit_ms;
        let [r, g, b, a] = active.background;
        let write_main = active.write_main;
        let write_backdrop = active.write_backdrop;
        let shared = self.offscreen_stack.last().is_some_and(|s| s.backdrop.is_none());
        let (write_main, write_backdrop) = if shared {
            (write_main || write_backdrop, false)
        } else {
            (write_main, write_backdrop && !(root && active.detail && write_main))
        };
        let dual = write_main && write_backdrop;
        let draw = scene_dirty && (write_main || write_backdrop);
        let (scope_clear_main, scope_clear_back) = if !root && draw {
            let scope = self.offscreen_stack.last().expect("offscreen scope");
            (
                write_main && scope.main.needs_clear,
                write_backdrop && scope.backdrop.as_ref().is_some_and(|b| b.needs_clear),
            )
        } else {
            (false, false)
        };
        if draw {
            let slot = &mut self.counters.flushes[usize::from(why).min(14)];
            *slot = slot.wrapping_add(1);
        }

        // Vello defaults to clearing the attachment. Existing planes already hold their
        // prefix, including readers and composites from earlier segments.
        let mut options = RenderOptions::default();
        options.target_init = TargetInit::SrcOver;
        if needs_clear && draw && write_main && !write_backdrop {
            options.target_init = TargetInit::Clear(ClearSettings::Viewport {
                color: AlphaColor::new([r, g, b, a]),
            });
        } else if needs_clear {
            let mut encoder = self.take_encoder("scene clear");
            let (_, view, _, _) = self.plane(false)?;
            GpuReaders::encode_clear(
                &mut encoder,
                view,
                wgpu::Color {
                    r: f64::from(r * a),
                    g: f64::from(g * a),
                    b: f64::from(b * a),
                    a: f64::from(a),
                },
            );
            self.stash_encoder(encoder);
        } else if !dual && (scope_clear_main || scope_clear_back) {
            options.target_init = TargetInit::Clear(ClearSettings::Viewport {
                color: AlphaColor::TRANSPARENT,
            });
        }

        if draw {
            if dual && self.scene.has_hw_blend() {
                // Direct two-pass strip replay on dual-plane tiles: hardware-blended strips must
                // blend against the real opaque main and backdrop pixels (not a transparent delta).
                if !root && (scope_clear_main || scope_clear_back) {
                    if scope_clear_main && scope_clear_back {
                        options.target_init = TargetInit::Clear(ClearSettings::Viewport {
                            color: AlphaColor::TRANSPARENT,
                        });
                    } else if let Some(top) = self.offscreen_stack.len().checked_sub(1) {
                        self.ensure_scope_cleared(top, scope_clear_main, scope_clear_back);
                    }
                }
                let (_, main_view, _, main_depth) = self.plane(false)?;
                let (main_view, main_depth) = (main_view.clone(), main_depth.clone());
                let (_, back_view, _, back_depth) = self.plane(true)?;
                let (back_view, back_depth) = (back_view.clone(), back_depth.clone());
                self.vello_render_dual(
                    &main_view,
                    Some(&main_depth),
                    &back_view,
                    Some(&back_depth),
                    options,
                    "scene flush",
                )?;
                if !root && (scope_clear_main || scope_clear_back) {
                    let scope = self.offscreen_stack.last_mut().expect("offscreen scope");
                    if scope_clear_main {
                        scope.main.needs_clear = false;
                    }
                    if scope_clear_back && let Some(back) = scope.backdrop.as_mut() {
                        back.needs_clear = false;
                    }
                }
            } else {
                let (target, color, color_id, depth) = self.plane(!write_main)?;
                let depth = depth.clone();
                let (width, height) = (target.width(), target.height());
                let (color, color_id) = if dual {
                    self.ensure_reader_tex(0, width, height, "scene delta")?;
                    options.target_init = TargetInit::Clear(ClearSettings::Viewport {
                        color: AlphaColor::TRANSPARENT,
                    });
                    let delta = self.readers.delta_frame.as_ref().expect("scene delta");
                    (delta.view.clone(), delta.view_id)
                } else {
                    (color.clone(), color_id)
                };
                self.vello_render(false, &color, Some(&depth), options, "scene flush")?;
                if !dual && (scope_clear_main || scope_clear_back) {
                    self.offscreen_stack
                        .last_mut()
                        .expect("offscreen scope")
                        .plane_mut(!write_main)
                        .needs_clear = false;
                }
                if dual {
                    let mut encoder = self.take_encoder("scene dual composite");
                    let (w, h) = self.active_scene_size();
                    let (main_tex, main, _, _) = self.plane(false)?;
                    let (back_tex, backdrop, _, _) = self.plane(true)?;
                    let same_size = (main_tex.width(), main_tex.height()) == (back_tex.width(), back_tex.height());
                    let (main, backdrop) = (main.clone(), backdrop.clone());
                    let scissor = (0, 0, u32::from(w), u32::from(h));
                    if same_size {
                        self.readers.encode_composite(
                            &self.device,
                            &mut encoder,
                            &color,
                            color_id,
                            CompositeTarget::OverBoth(&main, &backdrop),
                            (scope_clear_main, scope_clear_back),
                            (0, 0),
                            scissor,
                            1.0,
                        );
                    } else {
                        // Reused offscreen planes can have different allocation sizes even
                        // though they share an active viewport. A pass requires matching extents.
                        for (view, clear) in [(&main, scope_clear_main), (&backdrop, scope_clear_back)] {
                            self.readers.encode_composite(
                                &self.device,
                                &mut encoder,
                                &color,
                                color_id,
                                CompositeTarget::Over(view),
                                (clear, false),
                                (0, 0),
                                scissor,
                                1.0,
                            );
                        }
                    }
                    self.stash_encoder(encoder);
                    if let Some(scope) = self.offscreen_stack.last_mut() {
                        if scope_clear_main {
                            scope.main.needs_clear = false;
                        }
                        if scope_clear_back && let Some(back) = scope.backdrop.as_mut() {
                            back.needs_clear = false;
                        }
                    }
                }
            }
        }
        let active = self.active.as_mut().expect("active draw");
        active.needs_clear &= !needs_clear;
        active.scene_dirty = false;
        let sub = active.submit_ms - sub0;
        active.vello_render_ms += (now() - t0 - sub).max(0.0);
        if needs_clear || (draw && (write_backdrop || (!active.backdrop_live && root))) {
            self.bump_backdrop_gen();
        }
        if self.in_use_bytes >= GPU_TEMP_FLUSH_BYTES
            || !self.temp_textures.is_empty()
            || self.retired_shadows.len() >= 16
            || self.atlas.at.1 >= ATLAS_SIDE * 3 / 4
        {
            self.submit_active_encoder();
        }
        Ok(())
    }

    fn flush_preserving_clips(&mut self, open: &[Open], force_clear: bool) -> Result<()> {
        let should = self
            .active
            .as_ref()
            .is_some_and(|a| a.scene_dirty || (force_clear && a.needs_clear && self.offscreen_stack.is_empty()));
        if !should {
            self.flush_why = 0;
            return Ok(());
        }
        if open.iter().any(|o| matches!(o, Open::Layer)) {
            return Err(EngineError::unsupported("a GPU pass inside a Vello opacity layer"));
        }
        for o in open.iter().rev() {
            if matches!(
                o,
                Open::Clip {
                    active_on_scene: true,
                    ..
                }
            ) {
                self.scene.pop_clip();
            }
        }
        let hw_blend = self.scene.hw_blend();
        let result = self.flush_scene_gpu(force_clear);
        self.scene.reset();
        self.scene.set_hw_blend(hw_blend);
        self.reopen_clips(open);
        result
    }

    fn retire_scope(&mut self, scope: GpuIsolation) {
        let recording = self.active.as_ref().is_some_and(|a| a.before.is_some());
        let retired = if recording {
            &mut self.offscreen_in_use
        } else {
            &mut self.offscreen_pool
        };
        retired.push(scope.main);
        retired.extend(scope.backdrop);
    }

    fn reader_source(&self, base: Option<usize>, active: &ActiveDraw) -> Result<ReaderSource> {
        let ((x, y), (width, height), texture, view, view_id) = if let Some(base) = base {
            let plane = self.offscreen_stack[base].plane(true);
            (
                plane.origin,
                (i32::from(plane.active_size.0), i32::from(plane.active_size.1)),
                &plane.tex,
                &plane.view,
                plane.view_id,
            )
        } else {
            let (texture, view, view_id, _) = self.root_plane(active.backdrop_live)?;
            (
                (0, 0),
                (active.width as i32, active.height as i32),
                texture,
                view,
                view_id,
            )
        };
        Ok(ReaderSource {
            plane: BlurReaderPlane {
                texture: texture.clone(),
                view: view.clone(),
                view_id,
            },
            bounds: IRect {
                x0: x,
                y0: y,
                x1: x + width,
                y1: y + height,
            },
        })
    }

    /// Freezes earlier paint without incorporating it into the scope's own picture.
    fn snapshot_reader_prefix(
        &mut self,
        source: &ReaderSource,
        interiors: &[usize],
        reads: IRect,
    ) -> Result<ReaderSource> {
        let bounds = source.bounds.reader_crop(reads);
        let size = bounds.size();
        let budget = self.reader_budget_room();
        self.readers.ensure_blur_source_budgeted(&self.device, size, budget)?;
        let mut encoder = self.take_encoder("reader prefix snapshot");
        let snapshot = self.readers.blur_source.as_ref().expect("reader prefix snapshot");
        let texture = snapshot.texture.clone();
        let view = snapshot.view.clone();
        let view_id = snapshot.view_id;
        let offset = (
            (bounds.x0 - source.bounds.x0) as u32,
            (bounds.y0 - source.bounds.y0) as u32,
        );
        copy_rect(&mut encoder, &source.plane.texture, &texture, offset, (0, 0), size);
        self.overlay_reader_interiors(&mut encoder, &view, bounds, interiors);
        self.stash_encoder(encoder);
        Ok(ReaderSource {
            plane: BlurReaderPlane { texture, view, view_id },
            bounds,
        })
    }

    fn resolve_blur_source(&mut self, draw: &mut BlurReaderDraw, sigma: f32, dirty: Option<IRect>) -> Result<()> {
        if draw.interiors.is_empty() {
            return Ok(());
        }
        let interiors = std::mem::take(&mut draw.interiors);
        let active = dirty.unwrap_or(draw.dirty);
        let reads = halo::subtexel_border_crop(active.translate(draw.origin.0, draw.origin.1), sigma);
        draw.source = self.snapshot_reader_prefix(&draw.source, &interiors, reads)?;
        draw.source_is_frame = false;
        draw.source_written = draw
            .targets
            .iter()
            .flatten()
            .any(|target| target.texture == draw.source.plane.texture);
        Ok(())
    }

    /// The draw region and both destination prefixes live in the current scope's coordinates.
    fn prepare_blur_reader(
        &mut self,
        paths: &[(BezPath, bool)],
        device: Affine,
        coarse: bool,
        open: &[Open],
    ) -> Result<Option<BlurReaderDraw>> {
        self.flush_why = 7;
        self.flush_preserving_clips(open, true)?;
        let Some(active) = self.active.as_ref() else {
            return Ok(None);
        };
        let scope = self.offscreen_stack.last();
        let source_is_frame = scope.is_none();
        let shared = scope.is_some_and(|scope| scope.backdrop.is_none());
        let (write_main, write_backdrop) = if shared {
            (active.write_main || active.write_backdrop, false)
        } else {
            (
                active.write_main,
                active.write_backdrop && !(source_is_frame && coarse && active.detail),
            )
        };
        if !write_main && !write_backdrop {
            return Ok(None);
        }
        let frame_size = (active.width as i32, active.height as i32);
        let origin = self.scene_offset();
        let (width, height) = self.active_scene_size();
        let Some(dirty) = progressive_blur::blur_dirty_rect(
            paths,
            device,
            frame_size,
            (-origin.0, -origin.1),
            (i32::from(width), i32::from(height)),
        ) else {
            return Ok(None);
        };
        let (base, interiors) = exec::reader_backdrop_layers(&self.offscreen_stack, false, |scope| scope.isolation);
        if let Some(top) = self.offscreen_stack.len().checked_sub(1) {
            self.ensure_scope_cleared(top, write_main, write_backdrop);
        }
        if let Some(base) = base {
            self.ensure_scope_cleared(base, false, true);
        }
        let clone_plane = |backdrop| -> Result<BlurReaderPlane> {
            let (texture, view, view_id, _) = self.plane(backdrop)?;
            Ok(BlurReaderPlane {
                texture: texture.clone(),
                view: view.clone(),
                view_id,
            })
        };
        let targets = [
            write_main.then(|| clone_plane(false)).transpose()?,
            write_backdrop.then(|| clone_plane(true)).transpose()?,
        ];
        let active = self.active.as_ref().expect("active draw");
        let grid_pad = active.grid_pad;
        let draw_grid_origin = active.draw_grid_origin;
        let source = self.reader_source(base, active)?;
        let source_written = targets
            .iter()
            .flatten()
            .any(|target| target.texture == source.plane.texture);
        Ok(Some(BlurReaderDraw {
            frame_size,
            origin,
            dirty,
            source,
            interiors,
            source_is_frame,
            source_written,
            grid_pad,
            draw_grid_origin,
            targets,
        }))
    }

    fn encode_blur_reader_masks(
        &mut self,
        draw: &BlurReaderDraw,
        paths: &[(BezPath, bool)],
        device: Affine,
        analytic: bool,
        clip: &ClipAnalysis<'_>,
    ) -> Result<(wgpu::CommandEncoder, Option<ClipMaskBinding>)> {
        let (w, h) = draw.dirty_size();
        let mut options = RenderOptions::default();
        options.target_init = TargetInit::Clear(ClearSettings::Viewport {
            color: AlphaColor::TRANSPARENT,
        });
        let clip_mask = self.prepare_clip_mask(clip, "blur reader clip")?;
        if !analytic {
            let budget = self.reader_budget_room();
            self.readers.ensure_vello_tex_budgeted(
                false,
                &self.device,
                &self.renderer,
                w,
                h,
                "blur reader shape",
                budget,
            )?;
            self.mask_scene.reset_and_resize(w as u16, h as u16);
            let (x, y) = draw.frame_dirty_origin();
            let shift = Affine::translate((-f64::from(x), -f64::from(y)));
            self.mask_scene.set_transform(shift * device);
            self.mask_scene.set_paint(vello_common::color::palette::css::WHITE);
            for (path, even_odd) in paths {
                self.mask_scene
                    .set_fill_rule(if *even_odd { Fill::EvenOdd } else { Fill::NonZero });
                self.mask_scene.fill_path(path);
            }
            let (mask_view, mask_depth) = {
                let mask = self.readers.mask_tex.as_ref().expect("blur reader shape");
                (mask.view.clone(), mask.depth.clone())
            };
            let t_vr = now();
            let sub0 = self.active.as_ref().map_or(0.0, |a| a.submit_ms);
            self.vello_render(true, &mask_view, Some(&mask_depth), options, "backdrop blur")?;
            if let Some(a) = self.active.as_mut() {
                a.vello_render_ms += (now() - t_vr - (a.submit_ms - sub0)).max(0.0);
            }
        }
        self.mask_scene.reset();
        let encoder = self.take_encoder("backdrop blur");
        Ok((encoder, clip_mask))
    }

    #[allow(clippy::too_many_arguments)]
    fn encode_blur_reader_slice(
        &mut self,
        encoder: &mut wgpu::CommandEncoder,
        source: &wgpu::TextureView,
        source_id: u64,
        source_size: (u32, u32),
        dst_origin: (i32, i32),
        spec: &BlurSpec,
        key: Option<blur::PyramidKey>,
    ) -> Result<()> {
        let out = self.readers.blur_out.as_ref().expect("blur reader output");
        let out_size = (out.width, out.height);
        let work = self
            .blur
            .estimate_work_bytes(source_size, out_size, dst_origin, spec, key);
        self.reserve_or_trim(work, 0, "backdrop Gaussian working textures")?;
        let out = self.readers.blur_out.as_ref().expect("blur reader output");
        self.blur.encode(
            &self.device,
            encoder,
            source,
            source_id,
            source_size,
            &out.view,
            out_size,
            dst_origin,
            spec,
            key,
        )
    }

    fn composite_scope(
        &mut self,
        content: &GpuIsolation,
        picture: Option<(&GpuIsolation, u32)>,
        blend: u32,
        opacity: f32,
        open: &[Open],
    ) -> Result<()> {
        let src = &content.main;
        let (sx, sy) = src.origin;
        let parent = self.target_bounds();
        let visible = parent.intersect(IRect {
            x0: sx,
            y0: sy,
            x1: sx + i32::from(src.active_size.0),
            y1: sy + i32::from(src.active_size.1),
        });
        if visible.is_empty() || opacity <= 0.0 {
            return Ok(());
        }
        let root = self.offscreen_stack.is_empty();
        let active = self.active.as_ref().expect("active draw");
        let shared_parent = self.offscreen_stack.last().is_some_and(|s| s.backdrop.is_none());
        let lerp = blend == crate::blend::BLEND_LERP;
        let plane_active = |backdrop: bool| -> bool {
            if !lerp {
                if content.plane(backdrop).needs_clear {
                    return false;
                }
                if let Some((mask, _)) = picture
                    && mask.plane(backdrop).needs_clear
                {
                    return false;
                }
            }
            true
        };
        let write_main = content.isolation.on_main && plane_active(false);
        let write_backdrop = content.isolation.on_backdrop
            && (!root || active.backdrop_live)
            && !(write_main && shared_parent)
            && plane_active(true);
        if !write_main && !write_backdrop {
            return Ok(());
        }
        let t0 = now();
        let (sub0, vr0) = self
            .active
            .as_ref()
            .map_or((0.0, 0.0), |a| (a.submit_ms, a.vello_render_ms));
        let dst_origin = (sx - parent.x0, sy - parent.y0);
        let visible_in_parent = IRect {
            x0: visible.x0 - parent.x0,
            y0: visible.y0 - parent.y0,
            x1: visible.x1 - parent.x0,
            y1: visible.y1 - parent.y0,
        };
        let target_rect = IRect {
            x0: 0,
            y0: 0,
            x1: parent.x1 - parent.x0,
            y1: parent.y1 - parent.y0,
        };
        let clip = self.analyze_open_clips(open, visible_in_parent, target_rect, false, true);
        if clip.clipped_rect.is_empty() {
            return Ok(());
        }
        let dst_offset = (clip.clipped_rect.x0 as u32, clip.clipped_rect.y0 as u32);
        let src_offset = (
            (clip.clipped_rect.x0 - dst_origin.0) as u32,
            (clip.clipped_rect.y0 - dst_origin.1) as u32,
        );
        let size = (
            (clip.clipped_rect.x1 - clip.clipped_rect.x0) as u32,
            (clip.clipped_rect.y1 - clip.clipped_rect.y0) as u32,
        );
        let scissor = (dst_offset.0, dst_offset.1, size.0, size.1);
        // Keep the same compositing arithmetic when a clip is present, including
        // UNORM rounding for normal and lerp modes. Only skip rasterizing its mask.
        let shader = clip.any_clip || picture.is_some() || (blend != 0 && !lerp);
        let (aw, ah) = (u32::from(src.active_size.0), u32::from(src.active_size.1));
        if shader {
            self.ensure_scratch_backdrop(aw, ah)?;
            let bytes = self.blend.pending_allocation();
            if bytes > 0 {
                self.reserve_or_trim(bytes, 0, "blend uniforms")?;
                self.blend.ensure_slab(&self.device);
            }
            if !self.blend.has_slots(u32::from(write_main) + u32::from(write_backdrop)) {
                self.submit_active_encoder();
            }
        }
        let clip_mask = self.prepare_clip_mask(&clip, "scope composite")?;
        if shader && let Some(top) = self.offscreen_stack.len().checked_sub(1) {
            self.ensure_scope_cleared(top, write_main, write_backdrop);
        }
        let mut encoder = self.take_encoder("scope composite");

        let mut blend_draws = 0u32;
        for backdrop in [false, true] {
            if (backdrop && !write_backdrop) || (!backdrop && !write_main) {
                continue;
            }
            let opacity = if !backdrop && content.isolation.unfaded_main {
                1.0
            } else {
                opacity
            };
            let src = content.plane(backdrop);
            let (dst_tex, dst_view, _, _) = self.plane(backdrop)?;
            let dst_view = dst_view.clone();
            if shader {
                let prefix = self.scratch_backdrop.as_ref().expect("composite prefix");
                let clip_arg = clip_mask.as_ref().map(|m| (&m.view, m.view_id, m.origin));
                let picture = picture.map(|(mask, kind)| {
                    let p = mask.plane(backdrop);
                    (&p.view, p.view_id, kind)
                });
                copy_rect(&mut encoder, dst_tex, &prefix.tex, dst_offset, src_offset, size);
                blend_draws += self.blend.encode(
                    &self.device,
                    &mut encoder,
                    (&src.view, src.view_id),
                    (&prefix.view, prefix.view_id),
                    clip_arg,
                    picture,
                    &dst_view,
                    dst_origin,
                    scissor,
                    blend,
                    opacity,
                );
            } else {
                let clear_dst = self.offscreen_stack.last_mut().is_some_and(|scope| {
                    let target = scope.plane_mut(backdrop);
                    std::mem::replace(&mut target.needs_clear, false)
                });
                self.readers.encode_composite(
                    &self.device,
                    &mut encoder,
                    &src.view,
                    src.view_id,
                    if lerp {
                        CompositeTarget::Lerp(&dst_view)
                    } else {
                        CompositeTarget::Over(&dst_view)
                    },
                    (clear_dst, false),
                    dst_origin,
                    scissor,
                    opacity,
                );
            }
        }
        self.stash_encoder(encoder);
        if write_backdrop || (write_main && root && !self.active.as_ref().expect("active draw").backdrop_live) {
            self.bump_backdrop_gen();
        }
        if let Some(a) = self.active.as_mut() {
            a.draws += blend_draws;
            let sub = a.submit_ms - sub0;
            let vr = a.vello_render_ms - vr0;
            a.flush_ms += (now() - t0 - sub - vr).max(0.0);
        }
        Ok(())
    }

    fn post_plane(&mut self, source: &GpuTarget, steps: &[PostStep]) -> Result<Option<GpuTarget>> {
        let t0 = now();
        let sub0 = self.active.as_ref().map_or(0.0, |a| a.submit_ms);
        let mut encoder = self.take_encoder("post effects");
        let mut outputs = Vec::with_capacity(steps.len());
        let result = (|| -> Result<bool> {
            for &step in steps {
                match step {
                    PostStep::LayerBlur { out_area, sigma } => {
                        if out_area.is_empty() {
                            return Ok(false);
                        }
                        let out_w = (out_area.x1 - out_area.x0) as u32;
                        let out_h = (out_area.y1 - out_area.y0) as u32;
                        let (src_size, src_origin, src_active) = {
                            let s = outputs.last().unwrap_or(source);
                            ((s.width, s.height), s.origin, s.active_size)
                        };
                        let dst_origin = (out_area.x0 - src_origin.0, out_area.y0 - src_origin.1);
                        let spec = BlurSpec {
                            sigma,
                            edge: EdgeMode::Zero,
                            clamp_bounds: IRect {
                                x0: 0,
                                y0: 0,
                                x1: i32::from(src_active.0),
                                y1: i32::from(src_active.1),
                            },
                            dirty: IRect {
                                x0: dst_origin.0,
                                y0: dst_origin.1,
                                x1: dst_origin.0 + out_w as i32,
                                y1: dst_origin.1 + out_h as i32,
                            },
                        };
                        let blur_work =
                            self.blur
                                .estimate_work_bytes(src_size, (out_w, out_h), dst_origin, &spec, None);
                        let dst = self.acquire_offscreen(out_w, out_h, (out_area.x0, out_area.y0))?;
                        if let Err(e) = self.reserve_or_trim(blur_work, 0, "a layer blur") {
                            self.offscreen_pool.push(dst);
                            return Err(e);
                        }
                        let src = outputs.last().unwrap_or(source);
                        if let Err(e) = self.blur.encode(
                            &self.device,
                            &mut encoder,
                            &src.view,
                            src.view_id,
                            (src.width, src.height),
                            &dst.view,
                            (out_w, out_h),
                            dst_origin,
                            &spec,
                            None,
                        ) {
                            self.offscreen_pool.push(dst);
                            return Err(e);
                        }
                        outputs.push(dst);
                    }
                    PostStep::Noise {
                        out_area,
                        noise_type,
                        size,
                        density,
                        color,
                        secondary_color,
                        opacity,
                        dev_to_layer,
                    } => {
                        if out_area.is_empty() {
                            return Ok(false);
                        }
                        let key = crate::noise::NoiseLookKey::from_params(
                            noise_type,
                            density,
                            color,
                            secondary_color,
                            opacity,
                        );
                        let out_w = (out_area.x1 - out_area.x0) as u32;
                        let out_h = (out_area.y1 - out_area.y0) as u32;
                        let dst = self.acquire_offscreen(out_w, out_h, (out_area.x0, out_area.y0))?;
                        if !self.noise.contains(key)
                            && let Err(e) =
                                self.reserve_or_trim(crate::noise::gpu::GpuNoise::TILE_BYTES, 0, "a noise tile")
                        {
                            self.offscreen_pool.push(dst);
                            return Err(e);
                        }
                        let src = outputs.last().unwrap_or(source);
                        let src_active = (u32::from(src.active_size.0), u32::from(src.active_size.1));
                        self.noise.encode(
                            &self.device,
                            &self.queue,
                            &mut encoder,
                            &src.view,
                            src_active,
                            src.origin,
                            &dst.view,
                            (out_w, out_h),
                            (out_area.x0, out_area.y0),
                            noise_type,
                            size,
                            density,
                            color,
                            secondary_color,
                            opacity,
                            dev_to_layer,
                        );
                        outputs.push(dst);
                    }
                    PostStep::Texture {
                        out_area,
                        size,
                        radius_dev,
                        clip_to_shape,
                        dev_to_layer,
                    } => {
                        if out_area.is_empty() {
                            return Ok(false);
                        }
                        let out_w = (out_area.x1 - out_area.x0) as u32;
                        let out_h = (out_area.y1 - out_area.y0) as u32;
                        let dst = self.acquire_offscreen(out_w, out_h, (out_area.x0, out_area.y0))?;
                        let src = outputs.last().unwrap_or(source);
                        let src_active = (u32::from(src.active_size.0), u32::from(src.active_size.1));
                        self.texture.encode(
                            &self.device,
                            &mut encoder,
                            &src.view,
                            src_active,
                            src.origin,
                            &dst.view,
                            (out_w, out_h),
                            (out_area.x0, out_area.y0),
                            size,
                            radius_dev,
                            clip_to_shape,
                            dev_to_layer,
                        );
                        outputs.push(dst);
                    }
                }
            }
            Ok(true)
        })();
        self.stash_encoder(encoder);
        self.submit_active_encoder();
        self.noise.flush_retired();
        if let Some(a) = self.active.as_mut() {
            let sub = a.submit_ms - sub0;
            a.flush_ms += (now() - t0 - sub).max(0.0);
        }
        let output = if matches!(result, Ok(true)) {
            outputs.pop()
        } else {
            None
        };
        self.offscreen_pool.extend(outputs);
        result.map(|_| output)
    }

    /// Upsamples a reduced-grid layer blur (grid spacing `divisor`, texel (0, 0) at device
    /// `origin`) into device pixels over `area`, runs `tail_steps` there, and composites it onto
    /// the parent with `blend`, `opacity` and `open` clips (cases L2 and L3).
    #[allow(clippy::too_many_arguments, clippy::type_complexity)]
    fn upsample_and_composite_post(
        &mut self,
        main: (&wgpu::TextureView, u64, (u32, u32), (u32, u32)),
        backdrop: Option<(&wgpu::TextureView, u64, (u32, u32), (u32, u32))>,
        origin: (f64, f64),
        divisor: i32,
        area: IRect,
        tail_steps: &[PostStep],
        isolation: Isolation,
        blend: u32,
        opacity: f32,
        open: &[Open],
    ) -> Result<()> {
        if area.is_empty() {
            return Ok(());
        }
        let (w, h) = area.size();
        let active = self.active.as_ref().expect("active draw");
        let previous_targets = (active.write_main, active.write_backdrop);
        let up_main = self.acquire_offscreen(w, h, (area.x0, area.y0))?;
        let up_backdrop = match backdrop {
            Some(_) => match self.acquire_offscreen(w, h, (area.x0, area.y0)) {
                Ok(t) => Some(t),
                Err(e) => {
                    self.offscreen_pool.push(up_main);
                    return Err(e);
                }
            },
            None => None,
        };
        let mut encoder = self.take_encoder("upsample layer blur");
        for (src, dst) in std::iter::once((main, &up_main)).chain(backdrop.zip(up_backdrop.as_ref())) {
            self.blur.encode_upsample_rect(
                &self.device,
                &mut encoder,
                src.0,
                src.1,
                src.2,
                src.3,
                origin,
                divisor,
                &dst.view,
                (area.x0, area.y0),
                (w, h),
            );
        }
        self.stash_encoder(encoder);
        let mut scope = GpuIsolation {
            main: up_main,
            backdrop: up_backdrop,
            isolation,
            clip_to_parent: false,
            previous_targets,
        };
        if !tail_steps.is_empty() {
            let tail = (|| -> Result<()> {
                let main = self.post_plane(&scope.main, tail_steps)?;
                let backdrop = match &scope.backdrop {
                    Some(src) => match self.post_plane(src, tail_steps) {
                        Ok(out) => out,
                        Err(e) => {
                            self.offscreen_pool.extend(main);
                            return Err(e);
                        }
                    },
                    None => None,
                };
                if let Some(out) = main {
                    self.offscreen_pool.push(std::mem::replace(&mut scope.main, out));
                } else {
                    scope.main.active_size = (0, 0);
                }
                if let Some(out) = backdrop {
                    self.offscreen_pool.extend(scope.backdrop.replace(out));
                } else if let Some(target) = scope.backdrop.as_mut() {
                    target.active_size = (0, 0);
                }
                Ok(())
            })();
            if let Err(e) = tail {
                self.retire_scope(scope);
                return Err(e);
            }
        }
        let result = self.composite_scope(&scope, None, blend, opacity, open);
        self.retire_scope(scope);
        result
    }

    /// A drag's tiles (decision 0040, "Dragging"): each tile the selection touched whose own
    /// tile isn't up to date shows the page's part below the selection (kept for the drag), the
    /// selection drawn afresh at its real position, and the part above (kept), laid over each
    /// other in order. Exact but for rounding: a stand-in until the camera and the drag rest.
    #[allow(clippy::too_many_arguments)]
    fn drag_composite(
        &mut self,
        store: &Store,
        plan: &crate::tiles::Plan,
        now: Rect,
        split: &Split,
        halo: i32,
        background: [f32; 4],
        dst: usize,
        stats: &mut DrawStats,
    ) -> Result<()> {
        let Some(level) = self.tiles.level(plan.level) else {
            return Ok(());
        };
        let side = TILE + 2 * halo.max(0) as u32;
        if let Some(c) = self.compositor.as_mut() {
            c.set_size(&self.queue, plan.size);
        }
        'tiles: for dt in self.tiles.drag_tiles(plan, now) {
            let view = level.tile_view(dt.i, dt.j, TILE);
            let mut slots = [0u32; 2];
            for (k, (pseudo, pass, fill)) in [
                (crate::tiles::DRAG_BELOW, Pass::Below, background),
                (crate::tiles::DRAG_ABOVE, Pass::Above, [0.0; 4]),
            ]
            .into_iter()
            .enumerate()
            {
                let key = TileKey {
                    level: pseudo,
                    i: dt.i,
                    j: dt.j,
                };
                slots[k] = match self.tiles.take_slot(&key) {
                    Some(slot) => slot,
                    None => {
                        let Some(slot) = self.tiles.slot_for(key) else {
                            // No room to keep the parts: the tile drawn whole and exact,
                            // straight into the frame, never left showing the selection where
                            // it was (or nothing).
                            self.ensure_scratch(side)?;
                            let mut verbs = store.limits.frame_verbs;
                            let tile_key = TileKey {
                                level: plan.level,
                                i: dt.i,
                                j: dt.j,
                            };
                            self.draw_tile(
                                store,
                                view,
                                false,
                                false,
                                halo,
                                background,
                                &Split::all(),
                                TileTarget::Scratch,
                                plan,
                                tile_key,
                                dst,
                                stats,
                                &mut verbs,
                            )?;
                            stats.tiles_drawn += 1;
                            stats.direct = true;
                            continue 'tiles;
                        };
                        let part = Split { pass, ..split.clone() };
                        let mut verbs = store.limits.frame_verbs;
                        let drawn = self.draw_tile(
                            store,
                            view,
                            false,
                            false,
                            halo,
                            fill,
                            &part,
                            TileTarget::Slot(slot),
                            plan,
                            key,
                            dst,
                            stats,
                            &mut verbs,
                        );
                        if let Err(e) = drawn {
                            self.tiles.release(key, slot);
                            return Err(e);
                        }
                        self.tiles.drawn(key, slot, true, true, false);
                        slot
                    }
                };
            }
            if dt.selection {
                let part = Split {
                    pass: Pass::Selection,
                    ..split.clone()
                };
                let mut verbs = store.limits.frame_verbs;
                let key = TileKey {
                    level: plan.level,
                    i: dt.i,
                    j: dt.j,
                };
                self.draw_tile(
                    store,
                    view,
                    false,
                    false,
                    halo,
                    [0.0; 4],
                    &part,
                    TileTarget::ScratchOnly,
                    plan,
                    key,
                    dst,
                    stats,
                    &mut verbs,
                )?;
            }
            self.lay_drag_tile(plan, dt, slots, dst)?;
            stats.dragged += 1;
            stats.exact = false;
        }
        Ok(())
    }

    /// Lays one drag tile into frame texture `dst`: the part below copied, then the selection
    /// (in the scratch tile, when it's over the tile) and the part above laid over it.
    fn lay_drag_tile(
        &mut self,
        plan: &crate::tiles::Plan,
        dt: crate::tiles::DragTile,
        slots: [u32; 2],
        dst: usize,
    ) -> Result<()> {
        let t = i64::from(TILE);
        let fx = i64::from(dt.i) * t + plan.origin.0;
        let fy = i64::from(dt.j) * t + plan.origin.1;
        let (fw, fh) = (i64::from(plan.size.0), i64::from(plan.size.1));
        let (x0, y0) = (fx.max(0), fy.max(0));
        let (x1, y1) = ((fx + t).min(fw), (fy + t).min(fh));
        if x1 <= x0 || y1 <= y0 {
            return Ok(());
        }
        let per_page = self.per_page();
        let per_row = self.per_row();
        let page_side = self.page_side;
        let place = |slot: u32| {
            let within = slot % per_page;
            (
                (slot / per_page) as usize,
                (within % per_row) * TILE,
                (within / per_row) * TILE,
            )
        };
        let (bp, bx, by) = place(slots[0]);
        let (ap, ax, ay) = place(slots[1]);
        if bp >= self.pages.len() || ap >= self.pages.len() {
            return Ok(());
        }
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("drag") });
        encoder.copy_texture_to_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &self.pages[bp].texture,
                mip_level: 0,
                origin: wgpu::Origin3d {
                    x: bx + (x0 - fx) as u32,
                    y: by + (y0 - fy) as u32,
                    z: 0,
                },
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyTextureInfo {
                texture: &self.frames[dst].texture,
                mip_level: 0,
                origin: wgpu::Origin3d {
                    x: x0 as u32,
                    y: y0 as u32,
                    z: 0,
                },
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::Extent3d {
                width: (x1 - x0) as u32,
                height: (y1 - y0) as u32,
                depth_or_array_layers: 1,
            },
        );
        // The tile's whole square in the frame (the viewport clips it), sampled texel for texel.
        let d = [fx as f32, fy as f32, (fx + t) as f32, (fy + t) as f32];
        let quad = |x: u32, y: u32, side: f64| {
            let (x, y, ts) = (f64::from(x), f64::from(y), f64::from(TILE));
            [
                d[0],
                d[1],
                d[2],
                d[3],
                (x / side) as f32,
                (y / side) as f32,
                ((x + ts) / side) as f32,
                ((y + ts) / side) as f32,
                ((x + 0.5) / side) as f32,
                ((y + 0.5) / side) as f32,
                ((x + ts - 0.5) / side) as f32,
                ((y + ts - 0.5) / side) as f32,
            ]
        };
        let mut quads: Vec<[f32; 12]> = Vec::new();
        if dt.selection {
            let side = self.scratches[self.active_scratch].as_ref().map_or(TILE, |s| s.width);
            let h = side.saturating_sub(TILE) / 2;
            quads.push(quad(h, h, f64::from(side)));
        }
        quads.push(quad(ax, ay, f64::from(page_side)));
        let c = self
            .compositor
            .as_mut()
            .ok_or_else(|| EngineError::new(ErrorCode::State, "no compositor"))?;
        c.write_quads(&self.device, &self.queue, &quads);
        let scratch_group = match (dt.selection, self.scratches[self.active_scratch].as_ref()) {
            (true, Some(s)) => Some(c.create_bind_group(&self.device, &s.view, "drag")),
            _ => None,
        };
        let above_group = match self.pages[ap].composite_group.as_ref() {
            Some(g) => g.clone(),
            None => c.create_bind_group(&self.device, &self.pages[ap].view, "drag"),
        };
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("drag"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &self.frames[dst].view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Load,
                        store: wgpu::StoreOp::Store,
                    },
                })],
                ..Default::default()
            });
            pass.set_pipeline(&c.over);
            pass.set_vertex_buffer(0, c.instances.slice(..));
            let mut at = 0u32;
            if let Some(g) = scratch_group.as_ref() {
                pass.set_bind_group(0, g, &[]);
                pass.draw(0..4, 0..1);
                at = 1;
            }
            pass.set_bind_group(0, &above_group, &[]);
            pass.draw(0..4, at..at + 1);
        }
        self.queue.submit([encoder.finish()]);
        self.submits += 1;
        Ok(())
    }

    /// Lays a frame into frame texture `dst`: under what the frame's own tiles don't cover, the
    /// background, refined tiles (the overview's, then other levels'), the overview's current
    /// tiles, the last frame moved and scaled, and other levels' tiles scaled; then the frame's
    /// tiles, pixel for pixel. When `submit` is false, returns the open encoder so
    /// `finish_frame` can record the present blit into the same submission.
    #[allow(clippy::too_many_arguments)]
    fn composite(
        &mut self,
        comp: &Composite,
        dst: usize,
        background: [f32; 4],
        w: u32,
        h: u32,
        submit: bool,
        stats: &mut DrawStats,
    ) -> Result<Option<wgpu::CommandEncoder>> {
        let per_page = self.per_page();
        let per_row = self.per_row();
        let page_side = self.page_side;
        let mut encoder = self.device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("composite"),
        });
        if !comp.complete {
            // Quads by source texture: the overview beneath, refined tiles, the last frame, then
            // pages, in the order given.
            let mut quads: Vec<(Option<usize>, [f32; 12])> = Vec::new();
            let pages = self.pages.len();
            let page_quad = |sc: &Scaled| -> Option<(Option<usize>, [f32; 12])> {
                let page = (sc.slot / per_page) as usize;
                if page >= pages {
                    return None;
                }
                let within = sc.slot % per_page;
                let (x, y) = (
                    f64::from((within % per_row) * TILE),
                    f64::from((within / per_row) * TILE),
                );
                let (p, t) = (f64::from(page_side), f64::from(TILE));
                let d = sc.dst;
                Some((
                    Some(page),
                    [
                        d.x0 as f32,
                        d.y0 as f32,
                        d.x1 as f32,
                        d.y1 as f32,
                        (x / p) as f32,
                        (y / p) as f32,
                        ((x + t) / p) as f32,
                        ((y + t) / p) as f32,
                        ((x + 0.5) / p) as f32,
                        ((y + 0.5) / p) as f32,
                        ((x + t - 0.5) / p) as f32,
                        ((y + t - 0.5) / p) as f32,
                    ],
                ))
            };
            // The overview's tiles, from its own texture.
            let overview_grid = self.overview_page.as_ref().map(|o| o.grid);
            let overview_quad = |sc: &Scaled| -> Option<(Option<usize>, [f32; 12])> {
                let grid = overview_grid?;
                let (pw, ph, t) = (f64::from(grid.0 * TILE), f64::from(grid.1 * TILE), f64::from(TILE));
                let index = sc.slot.checked_sub(crate::tiles::OVERVIEW_SLOT)?;
                if index >= grid.0 * grid.1 {
                    return None;
                }
                let (x, y) = (f64::from((index % grid.0) * TILE), f64::from((index / grid.0) * TILE));
                let d = sc.dst;
                Some((
                    Some(OVERVIEW_PAGE),
                    [
                        d.x0 as f32,
                        d.y0 as f32,
                        d.x1 as f32,
                        d.y1 as f32,
                        (x / pw) as f32,
                        (y / ph) as f32,
                        ((x + t) / pw) as f32,
                        ((y + t) / ph) as f32,
                        ((x + 0.5) / pw) as f32,
                        ((y + 0.5) / ph) as f32,
                        ((x + t - 0.5) / pw) as f32,
                        ((y + t - 0.5) / ph) as f32,
                    ],
                ))
            };
            // Refined tiles beneath anything drawn since, of any level, the longest drawn first
            // (`Composite::beneath`; the overview's by slot), then the overview's current tiles
            // over them.
            quads.extend(comp.beneath.iter().filter_map(|sc| {
                if sc.slot >= crate::tiles::OVERVIEW_SLOT {
                    overview_quad(sc)
                } else {
                    page_quad(sc)
                }
            }));
            quads.extend(comp.under.iter().filter_map(overview_quad));
            if let Some(m) = comp.base
                && let Some(l) = self.last
                && self
                    .current()
                    .is_ok_and(|f| f.width == l.size.0 && f.height == l.size.1)
            {
                let (lw, lh) = (f64::from(l.size.0), f64::from(l.size.1));
                let d = m.transform_rect_bbox(Rect::new(0.0, 0.0, lw, lh));
                // Laid round what changed since it was drawn (`Composite::holes`): its pixels
                // there are old. The mapping only scales and moves, so each part maps back to a
                // part of the last frame.
                let [sx, b, c, sy, ..] = m.as_coeffs();
                let parts = if comp.holes.is_empty() {
                    vec![d]
                } else if b == 0.0 && c == 0.0 && sx > 0.0 && sy > 0.0 {
                    crate::tiles::rect_minus(d, &comp.holes)
                } else {
                    Vec::new()
                };
                let back = m.inverse();
                for p in parts {
                    let s = back.transform_rect_bbox(p);
                    quads.push((
                        None,
                        [
                            p.x0 as f32,
                            p.y0 as f32,
                            p.x1 as f32,
                            p.y1 as f32,
                            (s.x0 / lw) as f32,
                            (s.y0 / lh) as f32,
                            (s.x1 / lw) as f32,
                            (s.y1 / lh) as f32,
                            (0.5 / lw) as f32,
                            (0.5 / lh) as f32,
                            (1.0 - 0.5 / lw) as f32,
                            (1.0 - 0.5 / lh) as f32,
                        ],
                    ));
                }
            }
            quads.extend(comp.scaled.iter().filter_map(page_quad));
            let c = self
                .compositor
                .as_mut()
                .ok_or_else(|| EngineError::new(ErrorCode::State, "no compositor"))?;
            let mut bytes = Vec::with_capacity(quads.len() * 48);
            for (_, q) in &quads {
                Compositor::push_quad(&mut bytes, q);
            }
            c.upload_quads(&self.device, &self.queue, quads.len(), &bytes);
            c.set_size(&self.queue, (w, h));
            // Runs of quads sharing a source, reusing cached bind groups on frames and tile pages.
            let mut runs: Vec<(Option<usize>, u32, u32)> = Vec::new();
            let mut i = 0;
            while i < quads.len() {
                let src = quads[i].0;
                let mut j = i + 1;
                while j < quads.len() && quads[j].0 == src {
                    j += 1;
                }
                match src {
                    None => {
                        let frame = &mut self.frames[self.cur.expect("stand-in frame")];
                        if frame.composite_group.is_none() {
                            frame.composite_group = Some(c.create_bind_group(&self.device, &frame.view, "composite"));
                        }
                    }
                    Some(p) => {
                        let page = if p == OVERVIEW_PAGE {
                            &mut self.overview_page.as_mut().expect("overview page").page
                        } else {
                            &mut self.pages[p]
                        };
                        if page.composite_group.is_none() {
                            page.composite_group = Some(c.create_bind_group(&self.device, &page.view, "composite"));
                        }
                    }
                }
                runs.push((src, i as u32, j as u32));
                i = j;
            }
            let a = background[3];
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("composite"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &self.frames[dst].view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color {
                            r: f64::from(background[0] * a),
                            g: f64::from(background[1] * a),
                            b: f64::from(background[2] * a),
                            a: f64::from(a),
                        }),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                ..Default::default()
            });
            pass.set_pipeline(&c.pipeline);
            pass.set_vertex_buffer(0, c.instances.slice(..));
            for &(src, from, to) in &runs {
                let group = match src {
                    None => self.frames[self.cur.expect("stand-in frame")]
                        .composite_group
                        .as_ref()
                        .expect("composite frame bg"),
                    Some(p) => self.page(p).composite_group.as_ref().expect("composite page bg"),
                };
                pass.set_bind_group(0, group, &[]);
                pass.draw(0..4, from..to);
            }
            stats.draws += runs.len() as u32;
        }
        for cp in &comp.copies {
            let page = (cp.slot / per_page) as usize;
            let Some(pg) = self.pages.get(page) else {
                debug_assert!(
                    false,
                    "tile copy slot {} past {} pages (per_page={})",
                    cp.slot,
                    self.pages.len(),
                    per_page
                );
                stats.exact = false;
                stats.pending = stats.pending.max(1);
                continue;
            };
            let within = cp.slot % per_page;
            let (x, y) = ((within % per_row) * TILE, (within / per_row) * TILE);
            encoder.copy_texture_to_texture(
                wgpu::TexelCopyTextureInfo {
                    texture: &pg.texture,
                    mip_level: 0,
                    origin: wgpu::Origin3d {
                        x: x + cp.src.x0 as u32,
                        y: y + cp.src.y0 as u32,
                        z: 0,
                    },
                    aspect: wgpu::TextureAspect::All,
                },
                wgpu::TexelCopyTextureInfo {
                    texture: &self.frames[dst].texture,
                    mip_level: 0,
                    origin: wgpu::Origin3d {
                        x: cp.dst.0 as u32,
                        y: cp.dst.1 as u32,
                        z: 0,
                    },
                    aspect: wgpu::TextureAspect::All,
                },
                wgpu::Extent3d {
                    width: (cp.src.x1 - cp.src.x0) as u32,
                    height: (cp.src.y1 - cp.src.y0) as u32,
                    depth_or_array_layers: 1,
                },
            );
        }
        if submit {
            self.queue.submit([encoder.finish()]);
            self.submits += 1;
            Ok(None)
        } else {
            Ok(Some(encoder))
        }
    }

    /// Makes the compositor's pipeline on first use.
    fn ensure_compositor(&mut self) {
        if self.compositor.is_some() {
            return;
        }
        let module = self.device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("composite"),
            source: wgpu::ShaderSource::Wgsl(QUADS.into()),
        });
        // One bind group layout for both pipelines (a pipeline's own layout can't be shared).
        let groups = self.device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("composite"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::VERTEX,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
            ],
        });
        let layout = self.device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("composite"),
            bind_group_layouts: &[Some(&groups)],
            immediate_size: 0,
        });
        let pipeline = self.device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("composite"),
            layout: Some(&layout),
            vertex: wgpu::VertexState {
                module: &module,
                entry_point: Some("vs"),
                compilation_options: Default::default(),
                buffers: &[Some(wgpu::VertexBufferLayout {
                    array_stride: 48,
                    step_mode: wgpu::VertexStepMode::Instance,
                    attributes: &wgpu::vertex_attr_array![0 => Float32x4, 1 => Float32x4, 2 => Float32x4],
                })],
            },
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::TriangleStrip,
                ..Default::default()
            },
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            fragment: Some(wgpu::FragmentState {
                module: &module,
                entry_point: Some("fs"),
                compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState {
                    format: FORMAT,
                    blend: None,
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            multiview_mask: None,
            cache: None,
        });
        // The same quads laid over what's there, through the same bind group layout.
        let over = self.device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("composite over"),
            layout: Some(&layout),
            vertex: wgpu::VertexState {
                module: &module,
                entry_point: Some("vs"),
                compilation_options: Default::default(),
                buffers: &[Some(wgpu::VertexBufferLayout {
                    array_stride: 48,
                    step_mode: wgpu::VertexStepMode::Instance,
                    attributes: &wgpu::vertex_attr_array![0 => Float32x4, 1 => Float32x4, 2 => Float32x4],
                })],
            },
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::TriangleStrip,
                ..Default::default()
            },
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            fragment: Some(wgpu::FragmentState {
                module: &module,
                entry_point: Some("fs"),
                compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState {
                    format: FORMAT,
                    blend: Some(wgpu::BlendState::PREMULTIPLIED_ALPHA_BLENDING),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            multiview_mask: None,
            cache: None,
        });
        let sampler = self.device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("composite"),
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });
        let uniforms = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("composite"),
            size: 16,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let capacity = 64;
        let instances = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("composite quads"),
            size: (capacity * 48) as u64,
            usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        self.compositor = Some(Compositor {
            bgl: groups,
            pipeline,
            over,
            sampler,
            uniforms,
            uniform_size: (0, 0),
            instances,
            capacity,
        });
    }

    /// Makes the pipeline that evaluates exact diamond gradients on both WebGPU and WebGL2.
    fn ensure_diamond(&mut self) {
        if self.diamond.is_some() {
            return;
        }
        let module = self.device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("diamond gradient"),
            source: wgpu::ShaderSource::Wgsl(crate::diamond::WGSL.into()),
        });
        let pipeline = self.device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("diamond gradient"),
            layout: None,
            vertex: wgpu::VertexState {
                module: &module,
                entry_point: Some("vs"),
                compilation_options: Default::default(),
                buffers: &[],
            },
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            fragment: Some(wgpu::FragmentState {
                module: &module,
                entry_point: Some("fs"),
                compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState {
                    format: FORMAT,
                    blend: None,
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            multiview_mask: None,
            cache: None,
        });
        let uniforms = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("diamond uniforms"),
            size: crate::diamond::UNIFORM_BYTES as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("diamond gradient"),
            layout: &pipeline.get_bind_group_layout(0),
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: uniforms.as_entire_binding(),
            }],
        });
        self.diamond = Some(DiamondPipeline {
            pipeline,
            uniforms,
            group,
        });
    }

    fn release_temp_textures(&mut self) {
        for (tid, tex) in self.temp_textures.drain(..) {
            self.bindings.remove(tid);
            tex.destroy();
        }
        self.bytes = self.bytes.saturating_sub(self.temp_bytes);
        self.temp_bytes = 0;
    }

    /// Starts reading the last frame back: a buffer the frame is copied into, mapped by
    /// `read_back_straight` (which takes the in-flight count it answers). At most `READBACKS` at once.
    pub fn read_back_start(&self) -> Result<ReadBack> {
        self.check()?;
        let main = match self.screen.standin {
            Some(frame) => &self.frames[frame],
            None => self.current()?,
        };
        if self.readbacks.count.get() >= READBACKS {
            return Err(EngineError::new(
                ErrorCode::State,
                "read-backs already in flight: wait for one to land",
            ));
        }
        let (w, h) = (main.width, main.height);
        let row = (w * 4).next_multiple_of(256);
        let size = u64::from(row) * u64::from(h);
        if size > self.max_buffer_size {
            return Err(EngineError::limit(format!(
                "a read-back buffer of {size} bytes exceeds this GPU's maxBufferSize ({})",
                self.max_buffer_size
            )));
        }
        self.reserve(row as usize * h as usize, 0, "a read-back")?;
        let buffer = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("read back"),
            size: u64::from(row) * u64::from(h),
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let mut encoder = self.device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("read back"),
        });
        encoder.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo {
                texture: &main.texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyBufferInfo {
                buffer: &buffer,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(row),
                    rows_per_image: None,
                },
            },
            wgpu::Extent3d {
                width: w,
                height: h,
                depth_or_array_layers: 1,
            },
        );
        self.queue.submit([encoder.finish()]);
        self.check()?;
        Ok((
            buffer,
            w,
            h,
            row,
            InFlight::new(self.readbacks.clone(), row as usize * h as usize),
        ))
    }

    /// Runs the GPU Gaussian blur pass on premultiplied RGBA8 pixels and starts reading the
    /// result back through a buffer (for CPU-vs-GPU conformance tests).
    #[allow(clippy::too_many_arguments)]
    pub fn blur_probe(
        &mut self,
        src: &[u8],
        src_size: (u32, u32),
        dst_size: (u32, u32),
        dst_origin: (i32, i32),
        spec: &crate::blur::BlurSpec,
        source_id: Option<u64>,
    ) -> Result<ReadBack> {
        self.check()?;
        self.blur.begin_frame();
        let (sw, sh) = src_size;
        let (dw, dh) = dst_size;
        let max_tex = self.device.limits().max_texture_dimension_2d;
        if sw == 0 || sh == 0 || dw == 0 || dh == 0 {
            return Err(EngineError::malformed("blur probe dimensions must be non-zero"));
        }
        if sw > max_tex || sh > max_tex || dw > max_tex || dh > max_tex {
            return Err(EngineError::limit("blur probe dimensions exceed GPU texture limit"));
        }
        let src_bytes = (sw as usize)
            .checked_mul(sh as usize)
            .and_then(|n| n.checked_mul(4))
            .ok_or_else(|| EngineError::limit("blur probe source size overflow"))?;
        if src.len() != src_bytes {
            return Err(EngineError::malformed("blur probe pixels don't match size"));
        }
        let dst_bytes = (dw as usize)
            .checked_mul(dh as usize)
            .and_then(|n| n.checked_mul(4))
            .ok_or_else(|| EngineError::limit("blur probe destination size overflow"))?;
        if self.readbacks.count.get() >= READBACKS {
            return Err(EngineError::new(
                ErrorCode::State,
                "read-backs already in flight: wait for one to land",
            ));
        }
        let cb = spec.clamp_bounds.clamp(sw as i32, sh as i32);
        crate::blur::validate_view_sigma(spec.sigma, cb, spec.edge)?;
        let key = source_id.map(|id| crate::blur::PyramidKey::new(id, spec.clamp_bounds, spec.edge));
        let blur_work = self.blur.estimate_work_bytes(src_size, dst_size, dst_origin, spec, key);
        let row = (dw * 4).next_multiple_of(256);
        let readback_bytes = (row as usize)
            .checked_mul(dh as usize)
            .ok_or_else(|| EngineError::limit("blur read-back size overflow"))?;
        let total_need = src_bytes
            .saturating_add(dst_bytes)
            .saturating_add(readback_bytes)
            .saturating_add(blur_work);
        if self.reserve(total_need, 0, "a blur read-back").is_err() {
            // Between submissions: release idle blur cache entries and re-estimate peak work.
            self.blur.clear();
            let blur_work = self.blur.estimate_work_bytes(src_size, dst_size, dst_origin, spec, key);
            let total_need = src_bytes
                .saturating_add(dst_bytes)
                .saturating_add(readback_bytes)
                .saturating_add(blur_work);
            self.reserve(total_need, 0, "a blur read-back")?;
        }
        let src_tex = texture(
            &self.device,
            sw,
            sh,
            wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            "blur probe src",
        );
        write(&self.queue, &src_tex, 0, 0, sw, sh, src);
        let src_view = src_tex.create_view(&Default::default());
        let dst_tex = texture(
            &self.device,
            dw,
            dh,
            wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC | wgpu::TextureUsages::COPY_DST,
            "blur probe dst",
        );
        // Zero-fill destination so callers can verify pixels outside `spec.dirty` are untouched.
        let zeros = vec![0u8; (dw as usize) * (dh as usize) * 4];
        write(&self.queue, &dst_tex, 0, 0, dw, dh, &zeros);
        let dst_view = dst_tex.create_view(&Default::default());
        let mut encoder = self.device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("blur probe"),
        });
        if let Err(e) = self.blur.encode(
            &self.device,
            &mut encoder,
            &src_view,
            0,
            src_size,
            &dst_view,
            dst_size,
            dst_origin,
            spec,
            key,
        ) {
            drop(encoder);
            self.blur.discard_uniforms();
            let _ = self.blur.take_draws();
            self.blur.flush_retired();
            return Err(e);
        }
        let buffer = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("blur probe readback"),
            size: u64::from(row) * u64::from(dh),
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        encoder.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo {
                texture: &dst_tex,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyBufferInfo {
                buffer: &buffer,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(row),
                    rows_per_image: None,
                },
            },
            wgpu::Extent3d {
                width: dw,
                height: dh,
                depth_or_array_layers: 1,
            },
        );
        self.blur.flush_uniforms(&self.queue);
        let _ = self.blur.take_draws();
        self.queue.submit([encoder.finish()]);
        self.submits += 1;
        self.blur.flush_retired();
        self.check()?;
        Ok((
            buffer,
            dw,
            dh,
            row,
            InFlight::new(self.readbacks.clone(), row as usize * dh as usize),
        ))
    }
}

/// A read-back's place in flight, and its buffer's bytes: given back when it lands or fails.
pub struct InFlight {
    flights: Rc<Flights>,
    bytes: usize,
}

impl InFlight {
    fn new(flights: Rc<Flights>, bytes: usize) -> Self {
        flights.count.set(flights.count.get() + 1);
        flights.bytes.set(flights.bytes.get() + bytes);
        Self { flights, bytes }
    }
}

impl Drop for InFlight {
    fn drop(&mut self) {
        self.flights.count.set(self.flights.count.get().saturating_sub(1));
        self.flights
            .bytes
            .set(self.flights.bytes.get().saturating_sub(self.bytes));
    }
}

/// Shared WebGL2 poll driver ticket: at most one non-blocking poll loop runs per device while any
/// wait is active, and it stops immediately when all waits end or `Health` is stopped/cancelled.
#[cfg(feature = "webgl")]
struct PollTicket(Arc<Health>);

#[cfg(feature = "webgl")]
impl PollTicket {
    fn enter(device: &wgpu::Device, health: &Arc<Health>) -> Self {
        health.poll_waiters.fetch_add(1, Ordering::SeqCst);
        ensure_poll_driver(device, health);
        Self(health.clone())
    }
}

#[cfg(feature = "webgl")]
impl Drop for PollTicket {
    fn drop(&mut self) {
        if self.0.poll_waiters.fetch_sub(1, Ordering::SeqCst) == 1 {
            self.0.wake_poll();
        }
    }
}

#[cfg(feature = "webgl")]
fn ensure_poll_driver(device: &wgpu::Device, health: &Arc<Health>) {
    if health.is_stopped() || health.poll_waiters.load(Ordering::SeqCst) == 0 {
        return;
    }
    if health.poll_running.swap(true, Ordering::SeqCst) {
        return;
    }
    let device = device.clone();
    let health = health.clone();
    wasm_bindgen_futures::spawn_local(async move {
        struct Running(Arc<Health>);
        impl Drop for Running {
            fn drop(&mut self) {
                self.0.poll_running.store(false, Ordering::SeqCst);
            }
        }
        let _running = Running(health.clone());
        loop {
            if health.is_stopped() || health.poll_waiters.load(Ordering::SeqCst) == 0 {
                break;
            }
            if let Err(e) = device.poll(wgpu::PollType::Poll) {
                health.fail_poll(format!("GPU poll failed: {e}"));
                break;
            }
            if health.is_stopped() || health.poll_waiters.load(Ordering::SeqCst) == 0 {
                break;
            }
            let (_timer, mut tick_rx) = Timeout::after(0);
            let mut wake_rx = health.watch_poll_wake();
            std::future::poll_fn(|cx| {
                if health.is_stopped() || health.poll_waiters.load(Ordering::SeqCst) == 0 {
                    return std::task::Poll::Ready(());
                }
                if Pin::new(&mut wake_rx).poll(cx).is_ready() {
                    return std::task::Poll::Ready(());
                }
                if Pin::new(&mut tick_rx).poll(cx).is_ready() {
                    return std::task::Poll::Ready(());
                }
                std::task::Poll::Pending
            })
            .await;
        }
    });
}

/// Waits for a wgpu callback with a hard timeout and cancellation tied to `Health` (device loss
/// or `Gpu` drop). On WebGL2, shares one non-blocking poll driver across all active waits.
pub(crate) async fn pump<T>(
    device: &wgpu::Device,
    health: &Arc<Health>,
    mut rx: futures_channel::oneshot::Receiver<T>,
    timeout_ms: i32,
) -> Result<T> {
    if let Some(err) = health.stop_error() {
        return Err(err);
    }
    match rx.try_recv() {
        Ok(Some(v)) => return Ok(v),
        Ok(None) => {}
        Err(_) => return Err(health.cancelled_or_callback_error()),
    }
    #[cfg(feature = "webgl")]
    let _poll = PollTicket::enter(device, health);
    #[cfg(not(feature = "webgl"))]
    let _ = device;
    let (_timer, mut timeout_rx) = Timeout::after(timeout_ms);
    let mut stop_rx = health.watch_stop();
    std::future::poll_fn(|cx| {
        if let Some(err) = health.stop_error() {
            return std::task::Poll::Ready(Err(err));
        }
        match Pin::new(&mut rx).poll(cx) {
            std::task::Poll::Ready(Ok(v)) => return std::task::Poll::Ready(Ok(v)),
            std::task::Poll::Ready(Err(_)) => {
                return std::task::Poll::Ready(Err(health.cancelled_or_callback_error()));
            }
            std::task::Poll::Pending => {}
        }
        if Pin::new(&mut stop_rx).poll(cx).is_ready() {
            return std::task::Poll::Ready(Err(health
                .stop_error()
                .unwrap_or_else(|| EngineError::new(ErrorCode::State, "GPU wait cancelled"))));
        }
        if Pin::new(&mut timeout_rx).poll(cx).is_ready() {
            return std::task::Poll::Ready(Err(EngineError::new(
                ErrorCode::Timeout,
                format!("GPU wait timed out after {timeout_ms} ms"),
            )));
        }
        std::task::Poll::Pending
    })
    .await
}

/// The frame's pixels, premultiplied RGBA8, from a buffer `read_back_start` filled. A failed
/// copy, map, cancellation, or timeout is an error, never empty pixels.
#[allow(clippy::too_many_arguments)]
async fn read_back_with_timeout(
    device: wgpu::Device,
    health: Arc<Health>,
    buffer: wgpu::Buffer,
    w: u32,
    h: u32,
    row: u32,
    flight: InFlight,
    timeout_ms: i32,
) -> Result<Vec<u8>> {
    let _flight = flight;
    if let Some(err) = health.stop_error() {
        buffer.destroy();
        return Err(err);
    }
    let (tx, rx) = futures_channel::oneshot::channel();
    buffer.slice(..).map_async(wgpu::MapMode::Read, move |r| {
        let _ = tx.send(r);
    });
    match pump(&device, &health, rx, timeout_ms).await {
        Ok(Ok(())) => {}
        Ok(Err(e)) => {
            buffer.destroy();
            return Err(EngineError::new(ErrorCode::Gpu, e.to_string()));
        }
        Err(e) => {
            buffer.destroy();
            return Err(e);
        }
    }
    let mapped = buffer
        .slice(..)
        .get_mapped_range()
        .map_err(|e| EngineError::new(ErrorCode::Gpu, format!("{e:?}")))?;
    let line = (w * 4) as usize;
    if mapped.len() < row as usize * h as usize || line > row as usize {
        drop(mapped);
        buffer.unmap();
        buffer.destroy();
        return Err(EngineError::new(ErrorCode::Gpu, "a read-back came back short"));
    }
    let mut out = Vec::with_capacity(line * h as usize);
    for chunk in mapped.chunks_exact(row as usize).take(h as usize) {
        out.extend_from_slice(&chunk[..line]);
    }
    drop(mapped);
    buffer.unmap();
    buffer.destroy();
    Ok(out)
}

/// Reads a frame back (`read_back_start`'s buffer) straight into a JS array, unpremultiplied (as
/// a canvas takes pixels) unless the frame is `opaque` (drawn over an opaque background, every
/// pixel is): one copy out of the mapping, for a frame read back at every presentation
/// (headless browsers). Bounded, cancellable, and driven through `pump` on WebGL2.
#[cfg(target_arch = "wasm32")]
#[allow(clippy::too_many_arguments)]
pub async fn read_back_straight(
    device: wgpu::Device,
    health: Arc<Health>,
    buffer: wgpu::Buffer,
    w: u32,
    h: u32,
    row: u32,
    flight: InFlight,
    opaque: bool,
) -> Result<js_sys::Uint8Array> {
    let _flight = flight;
    if let Some(err) = health.stop_error() {
        buffer.destroy();
        return Err(err);
    }
    let (tx, rx) = futures_channel::oneshot::channel();
    buffer.slice(..).map_async(wgpu::MapMode::Read, move |r| {
        let _ = tx.send(r);
    });
    match pump(&device, &health, rx, WAIT_TIMEOUT_MS).await {
        Ok(Ok(())) => {}
        Ok(Err(e)) => {
            buffer.destroy();
            return Err(EngineError::new(ErrorCode::Gpu, e.to_string()));
        }
        Err(e) => {
            buffer.destroy();
            return Err(e);
        }
    }
    let mapped = buffer
        .slice(..)
        .get_mapped_range()
        .map_err(|e| EngineError::new(ErrorCode::Gpu, format!("{e:?}")))?;
    let line = (w * 4) as usize;
    if mapped.len() < row as usize * h as usize || line > row as usize {
        drop(mapped);
        buffer.unmap();
        buffer.destroy();
        return Err(EngineError::new(ErrorCode::Gpu, "a read-back came back short"));
    }
    let out = js_sys::Uint8Array::new_with_length(w * h * 4);
    if opaque && row as usize == line {
        out.copy_from(&mapped[..line * h as usize]);
    } else {
        let mut scratch = Vec::with_capacity(line);
        for (y, chunk) in mapped.chunks_exact(row as usize).take(h as usize).enumerate() {
            let at = (y * line) as u32;
            let dst = out.subarray(at, at + line as u32);
            if opaque {
                dst.copy_from(&chunk[..line]);
            } else {
                scratch.clear();
                scratch.extend_from_slice(&chunk[..line]);
                crate::engine::unpremultiply(&mut scratch);
                dst.copy_from(&scratch);
            }
        }
    }
    drop(mapped);
    buffer.unmap();
    buffer.destroy();
    Ok(out)
}

/// Counts concurrent `gpuFinished` waits against `MAX_FINISHED_WAITERS`.
struct FinishedTicket(Arc<Health>);

impl FinishedTicket {
    fn try_enter(health: &Arc<Health>) -> Result<Self> {
        let mut cur = health.finished_waiters.load(Ordering::SeqCst);
        loop {
            if cur >= MAX_FINISHED_WAITERS {
                return Err(EngineError::new(
                    ErrorCode::State,
                    "too many gpuFinished waits in flight",
                ));
            }
            match health
                .finished_waiters
                .compare_exchange(cur, cur + 1, Ordering::SeqCst, Ordering::SeqCst)
            {
                Ok(_) => return Ok(Self(health.clone())),
                Err(next) => cur = next,
            }
        }
    }
}

impl Drop for FinishedTicket {
    fn drop(&mut self) {
        self.0.finished_waiters.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Resolves when the GPU has finished what was submitted (bounded, cancellable, capped waiters).
pub async fn finished(device: wgpu::Device, health: Arc<Health>, queue: wgpu::Queue) -> Result<()> {
    if let Some(err) = health.stop_error() {
        return Err(err);
    }
    let _ticket = FinishedTicket::try_enter(&health)?;
    let (tx, rx) = futures_channel::oneshot::channel();
    queue.on_submitted_work_done(move || {
        let _ = tx.send(());
    });
    pump(&device, &health, rx, WAIT_TIMEOUT_MS).await
}

/// Reads back a 16-byte resolved timestamp query buffer (`[t0, t1]` in GPU ticks) as milliseconds.
pub async fn read_timestamp_ms(
    device: wgpu::Device,
    health: Arc<Health>,
    buffer: wgpu::Buffer,
    period_ns: f64,
) -> Result<f64> {
    if let Some(err) = health.stop_error() {
        buffer.destroy();
        return Err(err);
    }
    let (tx, rx) = futures_channel::oneshot::channel();
    buffer.slice(..).map_async(wgpu::MapMode::Read, move |r| {
        let _ = tx.send(r);
    });
    match pump(&device, &health, rx, WAIT_TIMEOUT_MS).await {
        Ok(Ok(())) => {}
        Ok(Err(e)) => {
            buffer.destroy();
            return Err(EngineError::new(ErrorCode::Gpu, e.to_string()));
        }
        Err(e) => {
            buffer.destroy();
            return Err(e);
        }
    }
    let mapped = buffer
        .slice(..)
        .get_mapped_range()
        .map_err(|e| EngineError::new(ErrorCode::Gpu, format!("{e:?}")))?;
    let ms = if mapped.len() >= 16 {
        let t0 = u64::from_le_bytes(mapped[0..8].try_into().unwrap_or([0; 8]));
        let t1 = u64::from_le_bytes(mapped[8..16].try_into().unwrap_or([0; 8]));
        (t1.saturating_sub(t0) as f64) * period_ns / 1_000_000.0
    } else {
        0.0
    };
    drop(mapped);
    buffer.unmap();
    buffer.destroy();
    Ok(ms)
}

impl Backend for Gpu {
    fn scene(&mut self) -> &mut dyn Draw {
        // Direct Draw calls also include analytic shadows and Vello mask layers.
        self.mark_dirty();
        &mut self.scene
    }

    fn scene_offset(&self) -> (i32, i32) {
        self.offscreen_stack.last().map_or((0, 0), |s| s.main.origin)
    }

    fn target_bounds(&self) -> IRect {
        let (x0, y0) = self.scene_offset();
        let (width, height) = self.active_scene_size();
        IRect {
            x0,
            y0,
            x1: x0 + i32::from(width),
            y1: y0 + i32::from(height),
        }
    }

    fn mark_dirty(&mut self) {
        if let Some(a) = self.active.as_mut() {
            a.scene_dirty = true;
        }
    }

    fn can_hw_blend(&self) -> bool {
        self.hw_blend_enabled && self.target_is_opaque()
    }

    fn before_destructive_root_layer(&mut self, open: &[Open]) -> Result<()> {
        if self.scene.has_hw_blend() {
            self.flush_preserving_clips(open, false)?;
        }
        self.invalidate_active_opacity();
        Ok(())
    }

    fn begin_readers(&mut self, needs_backdrop: bool, has_context: bool) -> Result<()> {
        let Some(active) = self.active.as_ref() else {
            return Ok(());
        };
        let (aw, ah) = (active.width, active.height);
        let bg = active.background;
        if needs_backdrop {
            self.ensure_reader_tex(1, aw, ah, "backdrop tile")?;
            if has_context {
                let mut encoder = self.take_encoder("context init");
                let [r, g, b, a] = bg;
                let bg_col = wgpu::Color {
                    r: f64::from(r * a),
                    g: f64::from(g * a),
                    b: f64::from(b * a),
                    a: f64::from(a),
                };
                GpuReaders::encode_clear(&mut encoder, self.root_plane(false)?.1, bg_col);
                if let Some(back) = self.readers.backdrop_frame.as_ref() {
                    GpuReaders::encode_clear(&mut encoder, &back.view, wgpu::Color::TRANSPARENT);
                }
                self.stash_encoder(encoder);
                self.bump_backdrop_gen();
                if let Some(act) = self.active.as_mut() {
                    act.needs_clear = false;
                    act.backdrop_live = true;
                    act.has_context = true;
                    act.backdrop_opaque = false;
                }
            }
        }
        if has_context && let Some(act) = self.active.as_mut() {
            act.has_context = true;
        }
        Ok(())
    }

    fn snapshot_backdrop(&mut self, open: &[Open]) -> Result<()> {
        self.flush_why = 8;
        self.flush_preserving_clips(open, true)?;
        let Some(active) = self.active.as_ref() else {
            return Ok(());
        };
        let (aw, ah) = (active.width, active.height);
        self.ensure_reader_tex(1, aw, ah, "backdrop tile")?;
        let mut encoder = self.take_encoder("backdrop snapshot");
        let (source, _, _, _) = self.root_plane(false)?;
        encoder.copy_texture_to_texture(
            wgpu::TexelCopyTextureInfo {
                texture: source,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyTextureInfo {
                texture: &self.readers.backdrop_frame.as_ref().expect("backdrop").texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::Extent3d {
                width: aw,
                height: ah,
                depth_or_array_layers: 1,
            },
        );
        self.stash_encoder(encoder);
        self.bump_backdrop_gen();
        if let Some(a) = self.active.as_mut() {
            a.backdrop_live = true;
            a.backdrop_opaque = a.main_opaque;
        }
        Ok(())
    }

    fn rough(&self) -> bool {
        self.rough
    }

    fn stop_early(&self) -> bool {
        self.reader_halo
            .as_ref()
            .is_some_and(|h| h.wide_done || h.strip_capture.as_ref().is_some_and(|s| s.captured.is_some()))
    }

    fn deadline_reached(&self) -> bool {
        self.deadline_ms.is_some_and(|d| now() >= d)
            || self
                .pass_budget
                .is_some_and(|b| self.passes.wrapping_sub(self.passes_at) >= b)
    }

    fn set_targets(&mut self, write_main: bool, write_backdrop: bool, open: &[Open]) -> Result<()> {
        let Some(active) = self.active.as_ref() else {
            return Ok(());
        };
        let shared = self.offscreen_stack.last().is_some_and(|s| s.backdrop.is_none());
        let changed = if shared {
            (active.write_main || active.write_backdrop) != (write_main || write_backdrop)
        } else {
            (active.write_main, active.write_backdrop) != (write_main, write_backdrop)
        };
        if changed {
            self.flush_why = 9;
            self.flush_preserving_clips(open, false)?;
        }
        let active = self.active.as_mut().expect("active draw");
        (active.write_main, active.write_backdrop) = (write_main, write_backdrop);
        Ok(())
    }

    fn image(&mut self, id: u32, span: (f64, f64)) -> Option<ImageView> {
        let levels = self.images.get(&id)?;
        let i = images::pick(levels.iter().map(|l| (l.2, l.3)), span);
        let (tid, _, w, h) = levels.get(i)?;
        Some(ImageView {
            source: ImageSource::external_texture(*tid, TextureRegion::Full, true),
            width: *w,
            height: *h,
        })
    }

    fn checker(&mut self) -> ImageSource {
        ImageSource::external_texture(CHECKER_ID, TextureRegion::Full, false)
    }

    fn glyph_mask(&mut self, key: MaskKey, path: &BezPath, scale: (f64, f64), phase: (f64, f64)) -> Option<GlyphMask> {
        masks::coverage(
            &mut self.masks,
            &mut self.raster,
            key,
            path,
            scale,
            phase,
            self.mask_side,
        )
    }

    fn whole_runs(&self) -> bool {
        false
    }

    fn run_image(&mut self, w: u16, h: u16, pixels: Vec<u8>) -> Option<ImageSource> {
        let (x, y) = self.atlas.place(u32::from(w), u32::from(h))?;
        // Uploaded with the tile's other run images, a write per row (`flush_masks`).
        self.atlas.pending.push((x, y, u32::from(w), u32::from(h), pixels));
        let rect = RectU16 {
            x0: x as u16,
            y0: y as u16,
            x1: (x + u32::from(w)) as u16,
            y1: (y + u32::from(h)) as u16,
        };
        Some(ImageSource::external_texture(ATLAS_ID, TextureRegion::Rect(rect), true))
    }

    fn diamond_gradient(
        &mut self,
        area: IRect,
        device_to_grad: Affine,
        stops: &[(f32, crate::record::Rgba)],
        alpha: f32,
    ) -> Result<Option<ImageSource>> {
        if area.is_empty() {
            return Ok(None);
        }
        let w = (area.x1 - area.x0) as u32;
        let h = (area.y1 - area.y0) as u32;
        self.check_texture_size(w, h, "a diamond gradient")?;
        let tex_bytes = (w as usize).saturating_mul(h as usize).saturating_mul(4);
        self.reserve(tex_bytes, 0, "a diamond gradient")?;
        self.ensure_diamond();
        let dp = self
            .diamond
            .as_ref()
            .ok_or_else(|| EngineError::new(ErrorCode::Gpu, "no diamond gradient pipeline"))?;
        let tex = texture(
            &self.device,
            w,
            h,
            wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
            "diamond gradient",
        );
        self.bytes = self.bytes.saturating_add(tex_bytes);
        self.temp_bytes = self.temp_bytes.saturating_add(tex_bytes);
        let view = tex.create_view(&Default::default());
        let bytes = crate::diamond::pack_uniforms(area, device_to_grad, stops, alpha);
        self.queue.write_buffer(&dp.uniforms, 0, &bytes);
        let mut encoder = self.device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("diamond gradient"),
        });
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("diamond gradient"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                ..Default::default()
            });
            pass.set_pipeline(&dp.pipeline);
            pass.set_bind_group(0, &dp.group, &[]);
            pass.draw(0..3, 0..1);
        }
        self.queue.submit([encoder.finish()]);
        self.submits += 1;
        let tid = self.alloc_temp_id();
        self.bindings.insert(tid, view);
        self.temp_textures.push((tid, tex));
        Ok(Some(ImageSource::external_texture(tid, TextureRegion::Full, true)))
    }

    fn read(&mut self, kernel: u32, _paints: IRect, _reads: IRect, _open: &[Open]) -> Result<()> {
        // A kernel read: a capture and a pass back, toward the moving pass cap.
        self.note_passes(2);
        Err(EngineError::unsupported(format!(
            "backdrop reader {kernel} on the GPU (test kernel)"
        )))
    }

    fn glass(
        &mut self,
        key: (u32, usize),
        op: &GlassOp,
        paths: &[(BezPath, bool)],
        device: Affine,
        size: [f32; 2],
        alpha: f32,
        coarse: bool,
        read_parent: bool,
        open: &[Open],
    ) -> Result<()> {
        // Glass: its backdrop capture, blur and refraction passes, toward the moving pass cap.
        self.note_passes(4);
        if open.iter().any(|o| matches!(o, Open::Layer)) {
            return Err(EngineError::unsupported(
                "a backdrop reader inside a layer that fades as one",
            ));
        }
        if self
            .reader_halo
            .as_ref()
            .is_some_and(|h| h.strip_capture.is_some() || h.wide_capture)
        {
            // Glass never writes to the glass-free backdrop (rule b*), so edge strips and
            // world-grid wide-blur captures skip it.
            return Ok(());
        }
        self.flush_why = 10;
        self.flush_preserving_clips(open, true)?;
        if self.active.is_none() {
            return Ok(());
        }
        let t_reader = now();
        let (sub0, vr0, aw, ah) = {
            let active = self.active.as_ref().expect("active draw");
            (active.submit_ms, active.vello_render_ms, active.width, active.height)
        };
        let frame_size = (aw as i32, ah as i32);
        // A lens on an explicitly blended layer reads from its parent. A child lens
        // inherits that prefix with any preceding glass-free paint from the blend scope.
        let (base, interiors) =
            exec::reader_backdrop_layers(&self.offscreen_stack, read_parent, |scope| scope.isolation);
        if let Some(base) = base {
            self.ensure_scope_cleared(base, false, true);
        }
        let active = self.active.as_ref().expect("active draw");
        let mut backdrop_is_frame = base.is_none() && interiors.is_empty();
        let mut source = self.reader_source(base, active)?;
        let within = glass::clip_within_from_open(open);
        #[inline(never)]
        fn glass_reads_fit(lens: Rect, pad: f64, within: Option<glass::ClipWithin>, bounds: IRect) -> bool {
            let mut reads = IRect::around(lens.inflate(pad, pad));
            if let Some(w) = within {
                reads = reads.intersect(IRect {
                    x0: w.x0.floor() as i32,
                    y0: w.y0.floor() as i32,
                    x1: w.x1.ceil() as i32,
                    y1: w.y1.ceil() as i32,
                });
            }
            !reads.is_empty()
                && reads.x0 >= bounds.x0
                && reads.y0 >= bounds.y0
                && reads.x1 <= bounds.x1
                && reads.y1 <= bounds.y1
        }
        if let Some(tier) = self
            .reader_halo
            .as_ref()
            .filter(|halo| halo.inside_coarse_post_scope == 0)
            .and_then(|halo| halo.capture)
        {
            let visible = tier.visible;
            let lens = device.transform_rect_bbox(Rect::new(0.0, 0.0, f64::from(size[0]), f64::from(size[1])));
            if IRect::around(lens.inflate(2.0, 2.0)).intersect(visible).is_empty() {
                return Ok(());
            }
            // In the far tier, always snapshot a cropped prefix (#274). In the mid tier, replace
            // the far snapshot with a finer cropped mid snapshot when the lens's full refraction
            // and frost reach fits inside the mid backdrop plane so glass over wide blurs obeys
            // `sigma >= 3 * d`; otherwise box-downsample the overlapping mid region into the
            // existing far snapshot.
            let scale = device.determinant().abs().sqrt() as f32;
            let pad = (scale > 0.0 && scale.is_finite()).then(|| {
                let inradius = resolve_inradius(&mut self.cpu_resources, op, paths, size);
                f64::from(glass::glass_params(op, scale, inradius).margin) + 26.0
            });
            let fits_mid = !tier.is_far && pad.is_some_and(|p| glass_reads_fit(lens, p, within, source.bounds));
            if tier.is_far || fits_mid {
                let bounds = pad.map_or(source.bounds, |p| {
                    source.bounds.reader_crop(IRect::around(lens.inflate(p, p)))
                });
                let patch_size = bounds.size();
                let prefix = self.acquire_halo_patch(
                    (bounds.x0, bounds.y0),
                    patch_size,
                    tier.render_divisor,
                    tier.offset,
                    tier.frame_size,
                    within,
                )?;
                let mut encoder = self.take_encoder("snapshot coarse reader backdrop");
                let offset = (
                    (bounds.x0 - source.bounds.x0) as u32,
                    (bounds.y0 - source.bounds.y0) as u32,
                );
                copy_rect(
                    &mut encoder,
                    &source.plane.texture,
                    &prefix.texture,
                    offset,
                    (0, 0),
                    patch_size,
                );
                self.overlay_reader_interiors(&mut encoder, &prefix.view, bounds, &interiors);
                self.stash_encoder(encoder);
                let old = self
                    .reader_halo
                    .as_mut()
                    .expect("glass halo")
                    .prefixes
                    .insert(key, prefix);
                if let Some(old) = old {
                    self.submit_active_encoder();
                    self.recycle_halo_prefix(old);
                }
                return Ok(());
            }
            let far_info = self
                .reader_halo
                .as_ref()
                .and_then(|halo| halo.prefixes.get(&key))
                .filter(|p| p.divisor > tier.render_divisor && p.divisor % tier.render_divisor == 0)
                .map(|p| (p.view.clone(), p.origin, p.size, p.divisor, p.halo_offset));
            if let Some((far_view, far_origin, far_size, far_div, far_offset)) = far_info {
                let ratio = far_div / tier.render_divisor;
                let source_origin = (source.bounds.x0, source.bounds.y0);
                let source_size = source.bounds.size();
                // Far pixel `fx` covers mid-source texels `[fx * ratio + base_x .. (fx + 1) * ratio + base_x)`.
                let base_x = (far_origin.0 - far_offset.0) * ratio + tier.offset.0 - source_origin.0;
                let base_y = (far_origin.1 - far_offset.1) * ratio + tier.offset.1 - source_origin.1;
                let fx0 = (-base_x).div_euclid(ratio).max(0);
                let fy0 = (-base_y).div_euclid(ratio).max(0);
                // Ensure `fx * ratio + base_x >= 0` and `(fx + 1) * ratio + base_x <= source_size`.
                let fx0 = if fx0 * ratio + base_x < 0 { fx0 + 1 } else { fx0 };
                let fy0 = if fy0 * ratio + base_y < 0 { fy0 + 1 } else { fy0 };
                let fx1 = ((source_size.0 as i32 - base_x).div_euclid(ratio)).min(far_size.0 as i32);
                let fy1 = ((source_size.1 as i32 - base_y).div_euclid(ratio)).min(far_size.1 as i32);
                if fx1 > fx0 && fy1 > fy0 {
                    let (patch_view, patch_id, patch_size, patch_base) = if !interiors.is_empty() {
                        let reads = IRect {
                            x0: source_origin.0 + fx0 * ratio + base_x,
                            y0: source_origin.1 + fy0 * ratio + base_y,
                            x1: source_origin.0 + fx1 * ratio + base_x,
                            y1: source_origin.1 + fy1 * ratio + base_y,
                        };
                        let snap = self.snapshot_reader_prefix(&source, &interiors, reads)?;
                        (
                            snap.plane.view,
                            snap.plane.view_id,
                            snap.bounds.size(),
                            (
                                (far_origin.0 - far_offset.0) * ratio + tier.offset.0 - snap.bounds.x0,
                                (far_origin.1 - far_offset.1) * ratio + tier.offset.1 - snap.bounds.y0,
                            ),
                        )
                    } else {
                        (
                            source.plane.view.clone(),
                            source.plane.view_id,
                            source_size,
                            (base_x, base_y),
                        )
                    };
                    let mut encoder = self.take_encoder("patch far glass prefix from mid");
                    self.readers.encode_downsample_rect(
                        &self.device,
                        &mut encoder,
                        &patch_view,
                        patch_id,
                        patch_size,
                        &far_view,
                        (fx0 as u32, fy0 as u32, (fx1 - fx0) as u32, (fy1 - fy0) as u32),
                        (patch_base.0 as f32, patch_base.1 as f32),
                        ratio as u32,
                    );
                    self.stash_encoder(encoder);
                }
            }
            return Ok(());
        }
        let origin = self.scene_offset();
        // Glass writes only to the main (non-backdrop) plane. Outside spatial
        // post-effect scopes (`clip_to_parent == false`), pixels outside the
        // displayed area cannot affect output (provided `apron_glass_safe`).
        let clip_glass_to_display = self.offscreen_stack.iter().all(|s| s.clip_to_parent);
        let output = active
            .glass_display_area
            .or(active.display_area)
            .filter(|_| clip_glass_to_display)
            .map(|area| area.intersect(self.target_bounds()))
            .unwrap_or_else(|| self.target_bounds());
        if output.is_empty() {
            return Ok(());
        }
        let high_origin = active.display_area.map_or((0, 0), |area| (area.x0, area.y0));
        let high_scale = device.determinant().abs().sqrt() as f32;
        if !(high_scale > 0.0 && high_scale.is_finite()) {
            return Ok(());
        }
        let inradius = resolve_inradius(&mut self.cpu_resources, op, paths, size);
        let native_params = glass::glass_params(op, high_scale, inradius);
        let native_lens = device.transform_rect_bbox(Rect::new(0.0, 0.0, f64::from(size[0]), f64::from(size[1])));
        let max_tex = self.device.limits().max_texture_dimension_2d.min(u32::from(u16::MAX));
        let (split_side, split_pixels, chunk_side) = if coarse {
            (4096, 16_000_000, 2048)
        } else {
            (
                glass::EXACT_SPLIT_SIDE,
                glass::EXACT_SPLIT_PIXELS,
                glass::EXACT_CHUNK_SIDE,
            )
        };
        // In reader-halo mode, if this lens's entire device-resolution read rect fits inside the
        // device backdrop plane and exact glass chunking is compact, render directly at divisor=1
        // so the lens reads the exact device-resolution backdrop (including native/mid/far blurs).
        // The native pass of a reader-halo frame (not a tier capture, where a lens inside a
        // coarse post scope draws straight into the scope).
        let native_halo_pass = self.reader_halo.as_ref().is_some_and(|h| h.capture.is_none());
        let use_native_direct = if !coarse && native_halo_pass {
            let fits_source = glass_reads_fit(
                native_lens,
                f64::from(native_params.margin) + 2.0,
                within,
                source.bounds,
            );
            if fits_source {
                glass::compute_regions(
                    op,
                    &native_params,
                    device,
                    size,
                    frame_size,
                    (output.x0, output.y0),
                    (output.x1 - output.x0, output.y1 - output.y0),
                    max_tex,
                    glass::HARD_MAX_REGION_PIXELS,
                    split_side,
                    split_pixels,
                    chunk_side,
                )
                .ok()
                .is_some_and(|rs| {
                    rs.len() <= 4 && rs.iter().map(|r| u64::from(r.rw) * u64::from(r.rh)).sum::<u64>() <= 4_000_000
                })
            } else {
                false
            }
        } else {
            false
        };
        let (optical_device, optical_frame, optical_area, divisor, halo_offset, low_prefix) = if !use_native_direct
            && native_halo_pass
            && let Some(halo) = &self.reader_halo
        {
            if let Some(prefix) = halo.prefixes.get(&key) {
                let g_div = prefix.divisor;
                let g_off = prefix.halo_offset;
                let offset = (g_off.0 * g_div - high_origin.0, g_off.1 * g_div - high_origin.1);
                let map = Affine::scale(1.0 / f64::from(g_div))
                    * Affine::translate((f64::from(offset.0), f64::from(offset.1)));
                let opt_area = ReaderHalo::map_rect_to_grid(output, high_origin, g_div, g_off);
                (
                    map * device,
                    prefix.frame_size,
                    opt_area,
                    g_div,
                    offset,
                    Some((
                        prefix.origin,
                        prefix.size,
                        prefix.view.clone(),
                        prefix.view_id,
                        prefix.within,
                    )),
                )
            } else {
                // No captured prefix; fall back to checking whether the lens is visible on screen.
                (device, frame_size, output, 1, (0, 0), None)
            }
        } else {
            (device, frame_size, output, 1, (0, 0), None)
        };
        let output_origin = (optical_area.x0, optical_area.y0);
        let output_size = (optical_area.x1 - optical_area.x0, optical_area.y1 - optical_area.y0);
        let scale = high_scale / divisor as f32;
        if !(scale > 0.0 && scale.is_finite()) {
            return Ok(());
        }
        let params = if divisor == 1 {
            native_params
        } else {
            glass::glass_params(op, scale, inradius)
        };
        let mut regions = if coarse && divisor == 1 {
            glass::compute_coarse_region(op, optical_device, size, output_origin, output_size)
                .into_iter()
                .collect()
        } else {
            glass::compute_regions(
                op,
                &params,
                optical_device,
                size,
                optical_frame,
                output_origin,
                output_size,
                max_tex,
                glass::HARD_MAX_REGION_PIXELS,
                split_side,
                split_pixels,
                chunk_side,
            )?
        };
        if regions.is_empty() {
            return Ok(());
        }
        if !use_native_direct && native_halo_pass && low_prefix.is_none() {
            return Err(EngineError::limit("a visible glass lens has no coarse backdrop"));
        }
        for region in &mut regions {
            let map_x =
                |x: i32| ((x + optical_area.x0) * divisor - halo_offset.0).clamp(output.x0, output.x1) - origin.0;
            let map_y =
                |y: i32| ((y + optical_area.y0) * divisor - halo_offset.1).clamp(output.y0, output.y1) - origin.1;
            region.out_x0 = map_x(region.out_x0);
            region.out_x1 = map_x(region.out_x1);
            region.out_y0 = map_y(region.out_y0);
            region.out_y1 = map_y(region.out_y1);
        }
        let native_sampling = divisor > 1 && native_params.frost <= 0.4;

        // Compose inherited paint in scratch so it does not become part of the isolated picture.
        // The same scratch freezes an aliased prefix before any glass chunks write into it.
        if let Some(top) = self.offscreen_stack.len().checked_sub(1) {
            self.ensure_scope_cleared(top, true, false);
        }
        let (dst_tex, dst_view, _, _) = self.plane(false)?;
        let (dst_tex, dst_view) = (dst_tex.clone(), dst_view.clone());
        let needs_native_prefix = divisor == 1 || native_sampling;
        if needs_native_prefix
            && (!interiors.is_empty() || ((regions.len() > 1 || native_sampling) && source.plane.texture == dst_tex))
        {
            let reads = if divisor == 1 {
                IRect {
                    x0: regions.iter().map(|r| r.x0).min().unwrap(),
                    y0: regions.iter().map(|r| r.y0).min().unwrap(),
                    x1: regions.iter().map(|r| r.x0 + r.rw as i32).max().unwrap(),
                    y1: regions.iter().map(|r| r.y0 + r.rh as i32).max().unwrap(),
                }
            } else {
                let pad = native_params.margin + 2;
                IRect {
                    x0: regions
                        .iter()
                        .map(|r| (r.x0 * divisor - halo_offset.0 - 2).min(r.out_x0 + origin.0 - pad))
                        .min()
                        .unwrap(),
                    y0: regions
                        .iter()
                        .map(|r| (r.y0 * divisor - halo_offset.1 - 2).min(r.out_y0 + origin.1 - pad))
                        .min()
                        .unwrap(),
                    x1: regions
                        .iter()
                        .map(|r| ((r.x0 + r.rw as i32) * divisor - halo_offset.0 + 2).max(r.out_x1 + origin.0 + pad))
                        .max()
                        .unwrap(),
                    y1: regions
                        .iter()
                        .map(|r| ((r.y0 + r.rh as i32) * divisor - halo_offset.1 + 2).max(r.out_y1 + origin.1 + pad))
                        .max()
                        .unwrap(),
                }
            };
            source = self.snapshot_reader_prefix(&source, &interiors, reads)?;
            backdrop_is_frame = false;
        }
        let source_origin = (source.bounds.x0, source.bounds.y0);
        let source_size = source.bounds.size();
        let source_view = source.plane.view;
        let source_view_id = source.plane.view_id;

        let (target_w, target_h) = self.active_scene_size();
        let target_rect = IRect {
            x0: 0,
            y0: 0,
            x1: i32::from(target_w),
            y1: i32::from(target_h),
        };
        let [da, db, dc, dd, de, df] = device.as_coeffs();
        let det = da * dd - db * dc;
        let inv_device = (size[0] > 0.0 && size[1] > 0.0 && det.abs() > 1e-12).then(|| {
            (
                dd / det,
                -db / det,
                -dc / det,
                da / det,
                (dc * df - dd * de) / det,
                (db * de - da * df) / det,
                det.abs().sqrt() as f32,
            )
        });

        for region in &regions {
            let mut region = *region;
            let out_w = (region.out_x1 - region.out_x0) as u32;
            let out_h = (region.out_y1 - region.out_y0) as u32;
            if out_w == 0 || out_h == 0 {
                continue;
            }
            let (rx, ry) = (region.x0 * divisor - halo_offset.0, region.y0 * divisor - halo_offset.1);
            let rim = native_sampling.then(|| {
                let k = glass::height_scale(native_params.sigma) as i32;
                // The height shader uses at most 64 Gaussian taps on either side and
                // bilinear interpolation inside that grid. Refraction/frost never read this mask.
                let pad = ((3.0 * native_params.sigma / k as f32).ceil().min(64.0) as i32 + 2) * k + 2;
                let anchor_x = native_lens.x0.floor().clamp(-1e12, 1e12) as i64 - i64::from(native_params.margin);
                let anchor_y = native_lens.y0.floor().clamp(-1e12, 1e12) as i64 - i64::from(native_params.margin);
                let snap = |x: i32, anchor: i64| x - ((i64::from(x) - anchor).rem_euclid(i64::from(k))) as i32;
                let area = IRect {
                    x0: snap(region.out_x0 + origin.0 - pad, anchor_x),
                    y0: snap(region.out_y0 + origin.1 - pad, anchor_y),
                    x1: region.out_x1 + origin.0 + pad,
                    y1: region.out_y1 + origin.1 + pad,
                };
                NativeRim {
                    area,
                    offset: ((area.x0 - rx) as f32, (area.y0 - ry) as f32),
                    params: native_params,
                }
            });

            // 1. Optional open non-context clip mask.
            // Reduced-halo glass (`divisor > 1`) rasterizes the full-res lens paths clipped by
            // `open` into `readers.clip_tex`; native glass (`divisor == 1`) folds integer AA-rect
            // clips into the output scissor and shares tile-local cached clip-chain masks.
            let clip_mask = if divisor > 1 {
                let max_bytes = self.reader_budget_room();
                self.readers.ensure_vello_tex_budgeted(
                    true,
                    &self.device,
                    &self.renderer,
                    out_w,
                    out_h,
                    "reader clip",
                    max_bytes,
                )?;
                self.mask_scene.reset_and_resize(out_w as u16, out_h as u16);
                let shift = Affine::translate((-f64::from(region.out_x0), -f64::from(region.out_y0)));
                let mut depth = 0;
                for o in open {
                    if let Open::Clip {
                        transform,
                        path,
                        even_odd,
                        active_on_scene: true,
                        context_only: false,
                        ..
                    } = o
                    {
                        self.mask_scene.set_transform(shift * *transform);
                        self.mask_scene
                            .set_fill_rule(if *even_odd { Fill::EvenOdd } else { Fill::NonZero });
                        self.mask_scene.push_clip_path(path);
                        depth += 1;
                    }
                }
                self.mask_scene
                    .set_transform(shift * Affine::translate((-f64::from(origin.0), -f64::from(origin.1))) * device);
                self.mask_scene.set_paint(vello_common::color::palette::css::WHITE);
                for (p, even_odd) in paths {
                    self.mask_scene
                        .set_fill_rule(if *even_odd { Fill::EvenOdd } else { Fill::NonZero });
                    self.mask_scene.fill_path(p);
                }
                for _ in 0..depth {
                    self.mask_scene.pop_clip();
                }
                let mut options = RenderOptions::default();
                options.target_init = TargetInit::Clear(ClearSettings::Viewport {
                    color: vello_common::color::AlphaColor::TRANSPARENT,
                });
                let (clip_view, clip_view_id, clip_depth) = {
                    let clip_t = self.readers.clip_tex.as_ref().expect("clip");
                    (clip_t.view.clone(), clip_t.view_id, clip_t.depth.clone())
                };
                let t_vr = now();
                let vr_sub0 = self.active.as_ref().map_or(0.0, |a| a.submit_ms);
                self.vello_render(true, &clip_view, Some(&clip_depth), options, "reader clip")?;
                if let Some(a) = self.active.as_mut() {
                    a.vello_render_ms += (now() - t_vr - (a.submit_ms - vr_sub0)).max(0.0);
                }
                self.mask_scene.reset();
                Some(ClipMaskBinding {
                    view: clip_view,
                    view_id: clip_view_id,
                    origin: (region.out_x0, region.out_y0),
                })
            } else {
                let region_out = IRect {
                    x0: region.out_x0,
                    y0: region.out_y0,
                    x1: region.out_x1,
                    y1: region.out_y1,
                };
                let clip = self.analyze_open_clips(open, region_out, target_rect, true, true);
                if clip.clipped_rect.is_empty() {
                    continue;
                }
                region.out_x0 = clip.clipped_rect.x0;
                region.out_y0 = clip.clipped_rect.y0;
                region.out_x1 = clip.clipped_rect.x1;
                region.out_y1 = clip.clipped_rect.y1;
                self.prepare_clip_mask(&clip, "reader clip")?
            };
            let max_bytes = self.reader_budget_room();

            // 2. Analytic coarse coverage for box/ellipse (skips vello_gpu mask pass + submit!),
            //    or shape mask rasterized with vello_gpu into `mask_tex`.
            let analytic_coarse =
                if divisor == 1 && coarse && (op.kind == glass::KIND_BOX || op.kind == glass::KIND_ELLIPSE) {
                    inv_device.map(|(ia, ib, ic, id, ie, jf, unit_px)| {
                        let fx0 = f64::from(region.x0);
                        let fy0 = f64::from(region.y0);
                        CoarseAnalytic {
                            mode: if op.kind == glass::KIND_BOX { 1 } else { 2 },
                            to_box: [
                                ia as f32,
                                ib as f32,
                                ic as f32,
                                id as f32,
                                (ia * fx0 + ic * fy0 + ie) as f32,
                                (ib * fx0 + id * fy0 + jf) as f32,
                            ],
                            size,
                            radii: op.box_radii,
                            smoothing: op.box_smoothing,
                            unit_px,
                        }
                    })
                } else {
                    None
                };

            let mask_slot = self
                .active
                .as_ref()
                .filter(|_| !coarse && divisor == 1 && rim.is_none())
                .and_then(|draw| draw.glass_masks.get(&key))
                .filter(|slot| slot.region == (region.x0, region.y0, region.rw, region.rh))
                .map(|slot| slot.offset);
            if let Some(a) = self.active.as_mut() {
                a.glass_ops += 1;
                if mask_slot.is_some() {
                    a.glass_batched += 1;
                }
            }
            let render_mask = analytic_coarse.is_none() && mask_slot.is_none();

            if render_mask {
                let (mask_x, mask_y, mask_w, mask_h, mask_device) =
                    rim.map_or((region.x0, region.y0, region.rw, region.rh, optical_device), |r| {
                        (
                            r.area.x0,
                            r.area.y0,
                            (r.area.x1 - r.area.x0) as u32,
                            (r.area.y1 - r.area.y0) as u32,
                            device,
                        )
                    });
                self.check_texture_size(mask_w, mask_h, "a glass rim mask")?;
                self.readers.ensure_vello_tex_budgeted(
                    false,
                    &self.device,
                    &self.renderer,
                    mask_w,
                    mask_h,
                    "reader mask",
                    max_bytes,
                )?;
                self.mask_scene.reset_and_resize(mask_w as u16, mask_h as u16);
                let shifted = Affine::translate((-f64::from(mask_x), -f64::from(mask_y))) * mask_device;
                self.mask_scene.set_transform(shifted);
                self.mask_scene.set_paint(vello_common::color::palette::css::WHITE);
                for (p, even_odd) in paths {
                    self.mask_scene
                        .set_fill_rule(if *even_odd { Fill::EvenOdd } else { Fill::NonZero });
                    self.mask_scene.fill_path(p);
                }
                let mut options = RenderOptions::default();
                options.target_init = TargetInit::Clear(ClearSettings::Viewport {
                    color: vello_common::color::AlphaColor::TRANSPARENT,
                });
                let (mask_view, mask_depth) = {
                    let mask_t = self.readers.mask_tex.as_ref().expect("mask");
                    (mask_t.view.clone(), mask_t.depth.clone())
                };
                let t_vr = now();
                let vr_sub0 = self.active.as_ref().map_or(0.0, |a| a.submit_ms);
                self.vello_render(true, &mask_view, Some(&mask_depth), options, "reader glass")?;
                if let Some(a) = self.active.as_mut() {
                    a.vello_render_ms += (now() - t_vr - (a.submit_ms - vr_sub0)).max(0.0);
                }
                self.mask_scene.reset();
            }

            let resolve = low_prefix.as_ref().map(|_| GlassResolve {
                divisor: divisor as f32,
                rim,
                optical_origin: (
                    (region.x0 * divisor - halo_offset.0 - origin.0) as f32,
                    (region.y0 * divisor - halo_offset.1 - origin.1) as f32,
                ),
                native: native_sampling.then_some(&source_view),
                native_id: if native_sampling { source_view_id } else { 0 },
                native_origin: (
                    (region.x0 * divisor - halo_offset.0 - source_origin.0) as f32,
                    (region.y0 * divisor - halo_offset.1 - source_origin.1) as f32,
                ),
                native_size: source_size,
                native_clip: within,
                source_origin,
            });
            let (sample_origin, sample_size, sample_view, sample_view_id, sample_clip) = match &low_prefix {
                Some((origin, size, view, view_id, clip)) => (*origin, *size, view, *view_id, *clip),
                None => (source_origin, source_size, &source_view, source_view_id, within),
            };

            let opaque_target =
                self.reader_target_opaque(within) && sample_clip.is_none_or(|w| w.fill.is_none_or(|c| c[3] == 255));
            if low_prefix.is_none() && backdrop_is_frame {
                self.flush_backdrop_blur_written();
            }
            let quad_phase = self.active.as_ref().and_then(|a| a.draw_grid_origin).map_or(
                ((origin.0 & 1) as u32, (origin.1 & 1) as u32),
                |(nx, ny)| {
                    (
                        ((i64::from(origin.0) - nx) & 1) as u32,
                        ((i64::from(origin.1) - ny) & 1) as u32,
                    )
                },
            );
            let mut encoder = self.take_encoder("reader glass");
            let clip_arg = clip_mask.as_ref().map(|m| (&m.view, m.view_id, m.origin));
            self.readers.encode_glass(
                &self.device,
                &mut encoder,
                sample_view,
                sample_view_id,
                &dst_tex,
                &dst_view,
                sample_size,
                optical_frame,
                (-sample_origin.0, -sample_origin.1),
                (-origin.0, -origin.1),
                quad_phase,
                self.backdrop_gen,
                low_prefix.is_none() && backdrop_is_frame,
                &params,
                &region,
                sample_clip,
                alpha,
                coarse && divisor == 1,
                analytic_coarse,
                mask_slot,
                clip_arg,
                opaque_target,
                resolve,
                max_bytes,
            )?;

            self.stash_encoder(encoder);
        }
        if let Some(a) = self.active.as_mut() {
            let sub = a.submit_ms - sub0;
            let vr = a.vello_render_ms - vr0;
            a.reader_ms += (now() - t_reader - sub - vr).max(0.0);
        }
        Ok(())
    }

    fn push_isolated(
        &mut self,
        area: IRect,
        clip_to_parent: bool,
        _scene_origin_hint: Option<(i32, i32)>,
        isolation: Isolation,
        open: &[Open],
    ) -> Result<bool> {
        let parent_bounds = self.target_bounds();
        if area.is_empty() {
            return Ok(false);
        }
        self.counters.scopes = self.counters.scopes.wrapping_add(1);
        self.passes = self.passes.wrapping_add(1);
        let area = if clip_to_parent {
            // Match the CPU scope's sampling extent and preserve frame-relative raster cells.
            IRect {
                x0: area.x0.div_euclid(4) * 4 - 4,
                y0: area.y0.div_euclid(4) * 4 - 4,
                x1: (area.x1 + 3).div_euclid(4) * 4 + 4,
                y1: (area.y1 + 3).div_euclid(4) * 4 + 4,
            }
            .intersect(parent_bounds)
        } else {
            area
        };
        if area.is_empty() {
            return Ok(false);
        }
        if open.iter().any(|o| matches!(o, Open::Layer)) {
            return Err(EngineError::unsupported(
                "offscreen isolation inside a Vello opacity layer",
            ));
        }
        self.flush_why = 11;
        self.flush_preserving_clips(open, true)?;
        let active = self.active.as_ref().expect("active draw");
        let previous_targets = (active.write_main, active.write_backdrop);
        let parent_backdrop_live = !self.offscreen_stack.is_empty() || active.backdrop_live;
        let (parent_main_opaque, parent_backdrop_opaque) = if let Some(parent) = self.offscreen_stack.last() {
            (parent.main.opaque, parent.plane(true).opaque)
        } else {
            (
                active.main_opaque,
                if active.backdrop_live {
                    active.backdrop_opaque
                } else {
                    active.main_opaque
                },
            )
        };
        let (w, h) = ((area.x1 - area.x0) as u32, (area.y1 - area.y0) as u32);
        let origin = (area.x0, area.y0);
        if self.offscreen_in_use.iter().map(|target| target.bytes).sum::<usize>() >= GPU_TEMP_FLUSH_BYTES {
            self.submit_active_encoder();
        }
        let main = self.acquire_offscreen(w, h, origin)?;
        let mut scope = GpuIsolation {
            main,
            backdrop: None,
            isolation,
            clip_to_parent,
            previous_targets,
        };
        if isolation.separate {
            match self.acquire_offscreen(w, h, origin) {
                Ok(backdrop) => scope.backdrop = Some(backdrop),
                Err(e) => {
                    self.offscreen_pool.push(scope.main);
                    return Err(e);
                }
            }
        }
        if isolation.copy_parent {
            let overlap = area.intersect(parent_bounds);
            let full_copy = overlap == area;
            let main_from_backdrop = !isolation.on_main && !isolation.separate;
            scope.main.opaque = full_copy
                && if main_from_backdrop {
                    parent_backdrop_opaque
                } else {
                    parent_main_opaque
                };
            if let Some(back) = scope.backdrop.as_mut() {
                back.opaque = full_copy && parent_backdrop_opaque;
            }
            if !overlap.is_empty()
                && let Some(parent_idx) = self.offscreen_stack.len().checked_sub(1)
            {
                let main_reads_back = main_from_backdrop && parent_backdrop_live;
                let reads_main = !main_reads_back;
                let reads_back = main_reads_back || (scope.backdrop.is_some() && parent_backdrop_live);
                self.ensure_scope_cleared(parent_idx, reads_main, reads_back);
            }
            let mut encoder = self.take_encoder("isolation init");
            let res = (|| {
                for (backdrop, target) in
                    std::iter::once((main_from_backdrop, &scope.main)).chain(scope.backdrop.iter().map(|t| (true, t)))
                {
                    if overlap != area {
                        GpuReaders::encode_clear(&mut encoder, &target.view, wgpu::Color::TRANSPARENT);
                    }
                    if !overlap.is_empty() {
                        let parent = self.plane(backdrop && parent_backdrop_live)?.0;
                        copy_rect(
                            &mut encoder,
                            parent,
                            &target.tex,
                            (
                                (overlap.x0 - parent_bounds.x0) as u32,
                                (overlap.y0 - parent_bounds.y0) as u32,
                            ),
                            ((overlap.x0 - area.x0) as u32, (overlap.y0 - area.y0) as u32),
                            ((overlap.x1 - overlap.x0) as u32, (overlap.y1 - overlap.y0) as u32),
                        );
                    }
                }
                Ok(())
            })();
            self.stash_encoder(encoder);
            if let Err(e) = res {
                self.retire_scope(scope);
                return Err(e);
            }
        } else {
            // Defer clearing until the first draw/read into each plane; Vello folds it into LoadOp::Clear.
            scope.main.needs_clear = true;
            if let Some(back) = scope.backdrop.as_mut() {
                back.needs_clear = true;
            }
        }
        self.offscreen_stack.push(scope);
        let active = self.active.as_mut().expect("active draw");
        active.write_main = true;
        active.write_backdrop = isolation.separate;
        self.scene.reset_and_resize(w as u16, h as u16);
        Ok(true)
    }

    fn apply_post_isolated(&mut self, steps: &[PostStep]) -> Result<()> {
        if steps.is_empty() || self.offscreen_stack.is_empty() {
            return Ok(());
        }
        self.flush_why = 12;
        self.flush_scene_gpu(false)?;
        let top = self.offscreen_stack.len() - 1;
        self.ensure_scope_cleared(top, true, true);
        let mut scope = self.offscreen_stack.pop().expect("post scope");
        let result = (|| {
            let main = self.post_plane(&scope.main, steps)?;
            let backdrop = match &scope.backdrop {
                Some(src) => match self.post_plane(src, steps) {
                    Ok(out) => out,
                    Err(e) => {
                        self.offscreen_pool.extend(main);
                        return Err(e);
                    }
                },
                None => None,
            };
            if let Some(out) = main {
                self.offscreen_pool.push(std::mem::replace(&mut scope.main, out));
            } else {
                scope.main.active_size = (0, 0);
            }
            if let Some(out) = backdrop {
                self.offscreen_pool.extend(scope.backdrop.replace(out));
            } else if let Some(target) = scope.backdrop.as_mut() {
                target.active_size = (0, 0);
            }
            Ok(())
        })();
        self.offscreen_stack.push(scope);
        let (w, h) = self.active_scene_size();
        self.scene.reset_and_resize(w.max(1), h.max(1));
        result
    }

    fn pop_isolated(&mut self, opacity: f32, open: &[Open]) -> Result<()> {
        let through = self
            .offscreen_stack
            .last()
            .is_some_and(|scope| scope.isolation.copy_parent);
        self.pop_composited(if through { crate::blend::BLEND_LERP } else { 0 }, opacity, None, open)
    }

    fn pop_composited(&mut self, blend: u32, opacity: f32, mask_kind: Option<u32>, open: &[Open]) -> Result<()> {
        self.flush_why = 13;
        let flushed = self.flush_scene_gpu(false);
        let picture = mask_kind.and_then(|_| self.offscreen_stack.pop());
        let Some(content) = self.offscreen_stack.pop() else {
            if let Some(picture) = picture {
                self.retire_scope(picture);
            }
            return flushed;
        };
        let (w, h) = self.active_scene_size();
        let active = self.active.as_mut().expect("active draw");
        (active.write_main, active.write_backdrop) = content.previous_targets;
        active.scene_dirty = false;
        self.scene.reset_and_resize(w, h);
        self.reopen_clips(open);
        let result = flushed
            .and_then(|()| self.composite_scope(&content, picture.as_ref().zip(mask_kind), blend, opacity, open));
        if result.is_ok() && blend == crate::blend::BLEND_LERP {
            let main_lost = content.isolation.on_main && !content.main.opaque;
            let back_lost = content.isolation.on_backdrop && !content.plane(true).opaque;
            if main_lost || back_lost {
                if let Some(parent) = self.offscreen_stack.last_mut() {
                    if parent.backdrop.is_none() {
                        parent.main.opaque = false;
                    } else {
                        if main_lost {
                            parent.main.opaque = false;
                        }
                        if back_lost && let Some(back) = parent.backdrop.as_mut() {
                            back.opaque = false;
                        }
                    }
                } else if let Some(active) = self.active.as_mut() {
                    if main_lost {
                        active.main_opaque = false;
                    }
                    if back_lost {
                        active.backdrop_opaque = false;
                    }
                }
            }
        }
        self.retire_scope(content);
        if let Some(picture) = picture {
            self.retire_scope(picture);
        }
        result
    }

    fn abort_isolated(&mut self, open: &[Open]) {
        if let Some(scope) = self.offscreen_stack.pop() {
            let active = self.active.as_mut().expect("active draw");
            (active.write_main, active.write_backdrop) = scope.previous_targets;
            active.scene_dirty = false;
            self.retire_scope(scope);
        }
        self.recycle_scene_textures();
        let (w, h) = self.active_scene_size();
        self.scene.reset_and_resize(w, h);
        self.reopen_clips(open);
    }

    fn allow_unbounded_view_blur(&self) -> bool {
        true
    }

    fn reduced_layer_blur_limits(&self) -> ReducedBlurLimits {
        let (native_side, native_pixels) = if self.fallback_adapter {
            (
                self.max_texture_2d.min(SOFTWARE_HALO_RENDER_MAX_SIDE),
                SOFTWARE_HALO_RENDER_MAX_PIXELS,
            )
        } else {
            (self.max_texture_2d.min(HARDWARE_HALO_RENDER_MAX_SIDE), 16_000_000)
        };
        ReducedBlurLimits {
            replay_side: self.halo_replay_limit(),
            native_side,
            native_pixels,
        }
    }

    fn capturing_coarse_post_scope(&self, record_id: u32) -> Option<(i32, IRect, (i32, i32))> {
        let halo = self.reader_halo.as_ref()?;
        let tier = halo.capture?;
        (tier.is_far && halo.coarse_post_scopes.contains(&record_id)).then_some((
            tier.render_divisor,
            tier.visible,
            tier.frame_size,
        ))
    }

    fn set_inside_coarse_post_scope(&mut self, delta: i32) {
        if let Some(halo) = self.reader_halo.as_mut() {
            halo.inside_coarse_post_scope = halo.inside_coarse_post_scope.saturating_add_signed(delta as isize);
        }
    }

    fn capture_post_scope(&mut self, record_id: u32, cap_area: IRect) -> Result<()> {
        let Some(tier) = self.reader_halo.as_ref().and_then(|h| h.capture) else {
            return Ok(());
        };
        let Some(top) = self.offscreen_stack.len().checked_sub(1) else {
            return Ok(());
        };
        self.ensure_scope_cleared(top, true, true);
        let scope = &self.offscreen_stack[top];
        let bounds = |t: &GpuTarget| IRect {
            x0: t.origin.0,
            y0: t.origin.1,
            x1: t.origin.0 + i32::from(t.active_size.0),
            y1: t.origin.1 + i32::from(t.active_size.1),
        };
        let main_area = cap_area.intersect(bounds(&scope.main));
        if main_area.is_empty() {
            return Ok(());
        }
        let main_start = (
            (main_area.x0 - scope.main.origin.0) as u32,
            (main_area.y0 - scope.main.origin.1) as u32,
        );
        let main_tex = scope.main.tex.clone();
        let backdrop = scope.backdrop.as_ref().and_then(|b| {
            let area = cap_area.intersect(bounds(b));
            (!area.is_empty()).then(|| {
                (
                    b.tex.clone(),
                    area,
                    ((area.x0 - b.origin.0) as u32, (area.y0 - b.origin.1) as u32),
                )
            })
        });
        let main_patch = self.acquire_halo_patch(
            (main_area.x0, main_area.y0),
            main_area.size(),
            tier.render_divisor,
            tier.offset,
            tier.frame_size,
            None,
        )?;
        let backdrop_patch = match backdrop.as_ref() {
            Some((_, area, _)) => match self.acquire_halo_patch(
                (area.x0, area.y0),
                area.size(),
                tier.render_divisor,
                tier.offset,
                tier.frame_size,
                None,
            ) {
                Ok(p) => Some(p),
                Err(e) => {
                    self.recycle_halo_prefix(main_patch);
                    return Err(e);
                }
            },
            None => None,
        };
        let mut encoder = self.take_encoder("capture coarse post scope");
        copy_rect(
            &mut encoder,
            &main_tex,
            &main_patch.texture,
            main_start,
            (0, 0),
            main_area.size(),
        );
        if let (Some((tex, area, start)), Some(patch)) = (&backdrop, &backdrop_patch) {
            copy_rect(&mut encoder, tex, &patch.texture, *start, (0, 0), area.size());
        }
        self.stash_encoder(encoder);
        let old = self.reader_halo.as_mut().expect("reader halo").post_scopes.insert(
            (record_id, 0),
            PostScopePatch {
                main: main_patch,
                backdrop: backdrop_patch,
            },
        );
        if let Some(old) = old {
            self.submit_active_encoder();
            self.recycle_halo_prefix(old.main);
            if let Some(b) = old.backdrop {
                self.recycle_halo_prefix(b);
            }
        }
        Ok(())
    }

    fn has_captured_post_scope(&self, record_id: u32) -> bool {
        self.reader_halo
            .as_ref()
            .is_some_and(|h| h.capture.is_none() && h.post_scopes.contains_key(&(record_id, 0)))
    }

    fn composite_reduced_post(
        &mut self,
        source: ReducedPost<'_>,
        upsample_area: IRect,
        tail_steps: &[PostStep],
        isolation: Isolation,
        blend: u32,
        opacity: f32,
        open: &[Open],
    ) -> Result<()> {
        match source {
            ReducedPost::Captured(record_id) => {
                if upsample_area.is_empty() {
                    return Ok(());
                }
                self.flush_preserving_clips(open, true)?;
                let high_origin = self
                    .active
                    .as_ref()
                    .and_then(|a| a.display_area)
                    .map_or((0, 0), |r| (r.x0, r.y0));
                let Some((main, backdrop, origin, divisor)) = self
                    .reader_halo
                    .as_ref()
                    .and_then(|h| h.post_scopes.get(&(record_id, 0)))
                    .map(|ps| {
                        let m = &ps.main;
                        let plane = |p: &HaloPatch| {
                            (
                                p.view.clone(),
                                p.view_id,
                                (p.texture.width(), p.texture.height()),
                                p.size,
                            )
                        };
                        let origin = (
                            f64::from(m.origin.0 - m.halo_offset.0) * f64::from(m.divisor) + f64::from(high_origin.0),
                            f64::from(m.origin.1 - m.halo_offset.1) * f64::from(m.divisor) + f64::from(high_origin.1),
                        );
                        (plane(m), ps.backdrop.as_ref().map(plane), origin, m.divisor)
                    })
                else {
                    return Ok(());
                };
                self.upsample_and_composite_post(
                    (&main.0, main.1, main.2, main.3),
                    backdrop.as_ref().map(|b| (&b.0, b.1, b.2, b.3)),
                    origin,
                    divisor,
                    upsample_area,
                    tail_steps,
                    isolation,
                    blend,
                    opacity,
                    open,
                )
            }
            ReducedPost::Top { steps, origin, divisor } => {
                let stepped = self.apply_post_isolated(steps);
                if stepped.is_ok()
                    && let Some(top) = self.offscreen_stack.len().checked_sub(1)
                {
                    self.ensure_scope_cleared(top, true, true);
                }
                let Some(scope) = self.offscreen_stack.pop() else {
                    return stepped;
                };
                let active = self.active.as_mut().expect("active draw");
                (active.write_main, active.write_backdrop) = scope.previous_targets;
                active.scene_dirty = false;
                let (w, h) = self.active_scene_size();
                self.scene.reset_and_resize(w, h);
                let result = stepped.and_then(|()| {
                    self.reopen_clips(open);
                    let plane = |t: &GpuTarget| {
                        (
                            t.view.clone(),
                            t.view_id,
                            (t.width, t.height),
                            (u32::from(t.active_size.0), u32::from(t.active_size.1)),
                        )
                    };
                    let main = plane(&scope.main);
                    let backdrop = scope.backdrop.as_ref().map(plane);
                    self.upsample_and_composite_post(
                        (&main.0, main.1, main.2, main.3),
                        backdrop.as_ref().map(|b| (&b.0, b.1, b.2, b.3)),
                        origin,
                        divisor,
                        upsample_area,
                        tail_steps,
                        isolation,
                        blend,
                        opacity,
                        open,
                    )
                });
                self.retire_scope(scope);
                result
            }
        }
    }

    fn draw_blurred_shadow(
        &mut self,
        cast: &ShadowCast<'_>,
        canonical: Option<&CanonicalShadow>,
        invert: bool,
        dirty: IRect,
        sigma: f32,
        color: AlphaColor<Srgb>,
        open: &[Open],
    ) -> Result<()> {
        // A shadow's blur passes, toward the moving pass cap.
        self.note_passes(2);
        if dirty.is_empty() {
            return Ok(());
        }
        if let Some(a) = self.active.as_mut() {
            a.shadow_ops += 1;
        }
        validate_view_sigma(
            sigma,
            IRect {
                x0: 0,
                y0: 0,
                x1: (dirty.x1 - dirty.x0).max(1),
                y1: (dirty.y1 - dirty.y0).max(1),
            },
            EdgeMode::Zero,
        )?;

        // Fast path: bounded LRU canonical shadow mask cache (zero submits on hit!).
        if let Some(canon) = canonical {
            let cw = (canon.mask_rect.x1 - canon.mask_rect.x0) as u32;
            let ch = (canon.mask_rect.y1 - canon.mask_rect.y0) as u32;
            let cache_bytes = (cw as usize) * (ch as usize) * 4;
            if self.shadow_cache.fits_budget(cache_bytes) {
                if let Some(entry) = self.shadow_cache.get(&canon.key) {
                    let tid = entry.value.tid;
                    let (ew, eh) = entry.size;
                    let origin = (canon.anchor.0 + entry.origin.0, canon.anchor.1 + entry.origin.1);
                    if let Some(a) = self.active.as_mut() {
                        a.shadow_hits += 1;
                    }
                    self.counters.shadow_hits = self.counters.shadow_hits.wrapping_add(1);
                    let (sox, soy) = self.scene_offset();
                    let px = f64::from(origin.0 - sox);
                    let py = f64::from(origin.1 - soy);
                    let dx = f64::from(dirty.x0 - sox);
                    let dy = f64::from(dirty.y0 - soy);
                    let dw = f64::from(dirty.x1 - dirty.x0);
                    let dh = f64::from(dirty.y1 - dirty.y0);
                    let region = TextureRegion::Rect(RectU16 {
                        x0: 0,
                        y0: 0,
                        x1: ew,
                        y1: eh,
                    });
                    self.scene.set_transform(Affine::IDENTITY);
                    self.scene.set_paint(Image {
                        image: ImageSource::external_texture(tid, region, true),
                        sampler: ImageSampler {
                            x_extend: Extend::Pad,
                            y_extend: Extend::Pad,
                            quality: ImageQuality::Low,
                            alpha: 1.0,
                        },
                    });
                    self.scene.set_paint_transform(Affine::translate((px, py)));
                    self.scene.set_tint(Some(Tint {
                        color,
                        mode: TintMode::AlphaMask,
                    }));
                    self.scene.set_fill_rule(Fill::NonZero);
                    self.scene.fill_rect(&Rect::new(dx, dy, dx + dw, dy + dh));
                    self.scene.set_tint(None);
                    self.mark_dirty();
                    return Ok(());
                }

                // Cache miss: rasterise + blur canonical mask once and cache it.
                self.counters.shadow_misses = self.counters.shadow_misses.wrapping_add(1);
                let t0 = now();
                let sub0 = self.active.as_ref().map_or(0.0, |a| a.submit_ms);
                let max_tex = self.device.limits().max_texture_dimension_2d;
                if cw <= max_tex && ch <= max_tex {
                    self.ensure_scratch_mask(cw, ch)?;
                    let full = IRect {
                        x0: 0,
                        y0: 0,
                        x1: cw as i32,
                        y1: ch as i32,
                    };
                    let spec = BlurSpec {
                        sigma: canon.sigma,
                        edge: EdgeMode::Zero,
                        clamp_bounds: full,
                        dirty: full,
                    };
                    let mask_size = {
                        let m = self.scratch_mask.as_ref().expect("scratch_mask");
                        (m.width, m.height)
                    };
                    let blur_work = self.blur.estimate_work_bytes(mask_size, (cw, ch), (0, 0), &spec, None);
                    self.reserve_or_trim(cache_bytes.saturating_add(blur_work), 0, "a cached shadow mask")?;
                    let tex = texture(
                        &self.device,
                        cw,
                        ch,
                        wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
                        "shadow cache",
                    );
                    let view = tex.create_view(&Default::default());
                    let bind_view = tex.create_view(&Default::default());
                    let tid = self.alloc_temp_id();

                    self.mask_scene.reset_and_resize(cw as u16, ch as u16);
                    self.mask_scene.set_transform(Affine::translate((
                        -f64::from(canon.mask_rect.x0),
                        -f64::from(canon.mask_rect.y0),
                    )));
                    self.mask_scene.set_paint(AlphaColor::<Srgb>::new([1.0, 1.0, 1.0, 1.0]));
                    self.mask_scene.set_fill_rule(Fill::NonZero);
                    self.mask_scene.fill_path(&canon.path);

                    let res = (|| -> Result<()> {
                        let (mask_view, mask_id, mask_depth, mask_w_alloc, mask_h_alloc) = {
                            let mask_tex = self.scratch_mask.as_ref().expect("scratch_mask");
                            (
                                mask_tex.view.clone(),
                                mask_tex.view_id,
                                mask_tex.depth.clone(),
                                mask_tex.width,
                                mask_tex.height,
                            )
                        };
                        let mut options = RenderOptions::default();
                        options.target_init = TargetInit::Clear(ClearSettings::Viewport {
                            color: AlphaColor::TRANSPARENT,
                        });
                        self.vello_render(true, &mask_view, Some(&mask_depth), options, "shadow cache")?;
                        let mut encoder = self.take_encoder("shadow cache");
                        let blur_res = self.blur.encode_with_invert(
                            &self.device,
                            &mut encoder,
                            &mask_view,
                            mask_id,
                            (mask_w_alloc, mask_h_alloc),
                            &view,
                            (cw, ch),
                            (0, 0),
                            &spec,
                            None,
                            invert,
                        );
                        if let Err(e) = blur_res {
                            drop(encoder);
                            return Err(e);
                        }
                        self.stash_encoder(encoder);
                        Ok(())
                    })();
                    self.mask_scene.reset();
                    if let Err(e) = res {
                        tex.destroy();
                        return Err(e);
                    }
                    if let Some(root) = self.active.as_mut() {
                        let total_sub = root.submit_ms - sub0;
                        root.shadow_ms += (now() - t0 - total_sub).max(0.0);
                    }
                    self.bindings.insert(tid, bind_view);
                    let mask_origin = (canon.mask_rect.x0, canon.mask_rect.y0);
                    let evicted = self.shadow_cache.insert(
                        canon.key,
                        GpuCachedShadow {
                            tid,
                            tex,
                            bytes: cache_bytes,
                        },
                        mask_origin,
                        (cw as u16, ch as u16),
                        cache_bytes,
                    );
                    for ev in evicted {
                        self.pool_bytes += ev.bytes;
                        self.retired_shadows.push(ev);
                    }
                    let (sox, soy) = self.scene_offset();
                    let px = f64::from(canon.anchor.0 + mask_origin.0 - sox);
                    let py = f64::from(canon.anchor.1 + mask_origin.1 - soy);
                    let dx = f64::from(dirty.x0 - sox);
                    let dy = f64::from(dirty.y0 - soy);
                    let dw = f64::from(dirty.x1 - dirty.x0);
                    let dh = f64::from(dirty.y1 - dirty.y0);
                    let region = TextureRegion::Rect(RectU16 {
                        x0: 0,
                        y0: 0,
                        x1: cw as u16,
                        y1: ch as u16,
                    });
                    self.scene.set_transform(Affine::IDENTITY);
                    self.scene.set_paint(Image {
                        image: ImageSource::external_texture(tid, region, true),
                        sampler: ImageSampler {
                            x_extend: Extend::Pad,
                            y_extend: Extend::Pad,
                            quality: ImageQuality::Low,
                            alpha: 1.0,
                        },
                    });
                    self.scene.set_paint_transform(Affine::translate((px, py)));
                    self.scene.set_tint(Some(Tint {
                        color,
                        mode: TintMode::AlphaMask,
                    }));
                    self.scene.set_fill_rule(Fill::NonZero);
                    self.scene.fill_rect(&Rect::new(dx, dy, dx + dw, dy + dh));
                    self.scene.set_tint(None);
                    self.mark_dirty();
                    return Ok(());
                }
            }
        }

        let max_tex = self.device.limits().max_texture_dimension_2d as i32;
        let mask_opt = match cast {
            ShadowCast::Fill { paths, .. } => compute_view_mask_rect(paths, dirty, sigma, max_tex),
            ShadowCast::Stroke { bbox, .. } => compute_view_mask_rect_bounds(*bbox, dirty, sigma, max_tex),
        };
        let Some(mask) = mask_opt else {
            if invert {
                let (sox, soy) = self.scene_offset();
                let x = f64::from(dirty.x0 - sox);
                let y = f64::from(dirty.y0 - soy);
                let w = f64::from(dirty.x1 - dirty.x0);
                let h = f64::from(dirty.y1 - dirty.y0);
                self.scene.set_transform(Affine::IDENTITY);
                self.scene.reset_paint_transform();
                self.scene.set_tint(None);
                self.scene.set_paint(color);
                self.scene.set_fill_rule(Fill::NonZero);
                self.scene.fill_rect(&Rect::new(x, y, x + w, y + h));
                self.mark_dirty();
            }
            return Ok(());
        };
        if self.in_use_bytes >= GPU_TEMP_FLUSH_BYTES && !open.iter().any(|o| matches!(o, Open::Layer)) {
            self.flush_why = 14;
            self.flush_preserving_clips(open, false)?;
        }
        let dirty_w = (dirty.x1 - dirty.x0).max(1) as u32;
        let dirty_h = (dirty.y1 - dirty.y0).max(1) as u32;
        let shift = mask.shift;
        let dst_origin_i64 = (i64::from(dirty.x0) - mask.x0, i64::from(dirty.y0) - mask.y0);

        let t0 = now();
        let sub0 = self.active.as_ref().map_or(0.0, |a| a.submit_ms);
        let temp = self.acquire_temp(dirty_w, dirty_h)?;
        let res = (|| -> Result<()> {
            if shift == 0 {
                let (mask_w, mask_h) = (mask.sw, mask.sh);
                let dst_origin = (dst_origin_i64.0 as i32, dst_origin_i64.1 as i32);
                let spec = BlurSpec {
                    sigma,
                    edge: EdgeMode::Zero,
                    clamp_bounds: IRect {
                        x0: 0,
                        y0: 0,
                        x1: mask_w as i32,
                        y1: mask_h as i32,
                    },
                    dirty: IRect {
                        x0: dst_origin.0,
                        y0: dst_origin.1,
                        x1: dst_origin.0 + dirty_w as i32,
                        y1: dst_origin.1 + dirty_h as i32,
                    },
                };
                let blur_work =
                    self.blur
                        .estimate_work_bytes((mask_w, mask_h), (dirty_w, dirty_h), dst_origin, &spec, None);
                self.reserve_or_trim(blur_work, 0, "a shadow blur")?;
                self.ensure_scratch_mask(mask_w, mask_h)?;
                self.mask_scene.reset_and_resize(mask_w as u16, mask_h as u16);
                let base_shift = Affine::translate((-(mask.x0 as f64), -(mask.y0 as f64)));
                self.mask_scene.set_paint(AlphaColor::<Srgb>::new([1.0, 1.0, 1.0, 1.0]));
                match cast {
                    ShadowCast::Fill { paths, even_odd, .. } => {
                        self.mask_scene.set_transform(base_shift);
                        self.mask_scene
                            .set_fill_rule(if *even_odd { Fill::EvenOdd } else { Fill::NonZero });
                        for p in *paths {
                            if !p.is_empty() {
                                self.mask_scene.fill_path(p);
                            }
                        }
                    }
                    ShadowCast::Stroke {
                        paths,
                        transform,
                        stroke,
                        ..
                    } => {
                        self.mask_scene.set_transform(base_shift * *transform);
                        self.mask_scene.set_stroke(stroke.clone());
                        for p in *paths {
                            if !p.is_empty() {
                                self.mask_scene.stroke_path(p);
                            }
                        }
                    }
                }
                let (mask_view, mask_id, mask_depth, mask_w_alloc, mask_h_alloc) = {
                    let mask_tex = self.scratch_mask.as_ref().expect("scratch_mask");
                    (
                        mask_tex.view.clone(),
                        mask_tex.view_id,
                        mask_tex.depth.clone(),
                        mask_tex.width,
                        mask_tex.height,
                    )
                };
                let mut options = RenderOptions::default();
                options.target_init = TargetInit::Clear(ClearSettings::Viewport {
                    color: AlphaColor::TRANSPARENT,
                });
                self.vello_render(true, &mask_view, Some(&mask_depth), options, "shadow")?;
                let mut encoder = self.take_encoder("shadow");
                let blur_res = self.blur.encode_with_invert(
                    &self.device,
                    &mut encoder,
                    &mask_view,
                    mask_id,
                    (mask_w_alloc, mask_h_alloc),
                    &temp.view,
                    (dirty_w, dirty_h),
                    dst_origin,
                    &spec,
                    None,
                    invert,
                );
                if let Err(e) = blur_res {
                    drop(encoder);
                    return Err(e);
                }
                self.stash_encoder(encoder);
                Ok(())
            } else {
                let s = (1u64 << shift.min(30)) as f64;
                let (sw, sh) = (mask.sw, mask.sh);
                let (red_origin, (bd_w, bd_h)) = reduced_dirty_rect_i64((mask.x0, mask.y0), dirty, shift);
                let spec = BlurSpec {
                    sigma: scaled_shadow_sigma(sigma, shift),
                    edge: EdgeMode::Zero,
                    clamp_bounds: IRect {
                        x0: 0,
                        y0: 0,
                        x1: sw as i32,
                        y1: sh as i32,
                    },
                    dirty: IRect {
                        x0: red_origin.0,
                        y0: red_origin.1,
                        x1: red_origin.0 + bd_w as i32,
                        y1: red_origin.1 + bd_h as i32,
                    },
                };
                let blur_work = self
                    .blur
                    .estimate_work_bytes((sw, sh), (bd_w, bd_h), red_origin, &spec, None);
                self.reserve_or_trim(blur_work, 0, "a shadow blur")?;
                self.ensure_scratch_mask(sw, sh)?;
                self.ensure_scratch_blur(bd_w, bd_h)?;
                self.mask_scene.reset_and_resize(sw as u16, sh as u16);
                let red_tf = Affine::scale(1.0 / s) * Affine::translate((-(mask.x0 as f64), -(mask.y0 as f64)));
                self.mask_scene.set_paint(AlphaColor::<Srgb>::new([1.0, 1.0, 1.0, 1.0]));
                match cast {
                    ShadowCast::Fill { paths, even_odd, .. } => {
                        self.mask_scene.set_transform(red_tf);
                        self.mask_scene
                            .set_fill_rule(if *even_odd { Fill::EvenOdd } else { Fill::NonZero });
                        for p in *paths {
                            if !p.is_empty() {
                                self.mask_scene.fill_path(p);
                            }
                        }
                    }
                    ShadowCast::Stroke {
                        paths,
                        transform,
                        stroke,
                        ..
                    } => {
                        self.mask_scene.set_transform(red_tf * *transform);
                        self.mask_scene.set_stroke(stroke.clone());
                        for p in *paths {
                            if !p.is_empty() {
                                self.mask_scene.stroke_path(p);
                            }
                        }
                    }
                }
                let (mask_view, mask_id, mask_depth, mask_w_alloc, mask_h_alloc) = {
                    let mask_tex = self.scratch_mask.as_ref().expect("scratch_mask");
                    (
                        mask_tex.view.clone(),
                        mask_tex.view_id,
                        mask_tex.depth.clone(),
                        mask_tex.width,
                        mask_tex.height,
                    )
                };
                let (blur_view, blur_id, blur_w_alloc, blur_h_alloc) = {
                    let blur_tex = self.scratch_blur.as_ref().expect("scratch_blur");
                    (blur_tex.view.clone(), blur_tex.view_id, blur_tex.width, blur_tex.height)
                };
                let mut options = RenderOptions::default();
                options.target_init = TargetInit::Clear(ClearSettings::Viewport {
                    color: AlphaColor::TRANSPARENT,
                });
                self.vello_render(true, &mask_view, Some(&mask_depth), options, "shadow reduced")?;
                let mut encoder = self.take_encoder("shadow reduced");
                if let Err(e) = self.blur.encode(
                    &self.device,
                    &mut encoder,
                    &mask_view,
                    mask_id,
                    (mask_w_alloc, mask_h_alloc),
                    &blur_view,
                    (bd_w, bd_h),
                    red_origin,
                    &spec,
                    None,
                ) {
                    drop(encoder);
                    return Err(e);
                }
                self.shadow.encode_upsample_mask(
                    &self.device,
                    &mut encoder,
                    &blur_view,
                    blur_id,
                    (blur_w_alloc, blur_h_alloc),
                    (bd_w, bd_h),
                    red_origin,
                    &temp.view,
                    (dirty_w, dirty_h),
                    dst_origin_i64,
                    shift,
                    invert,
                );
                self.stash_encoder(encoder);
                Ok(())
            }
        })();
        self.mask_scene.reset();
        if let Err(e) = res {
            self.temp_pool.push(temp);
            return Err(e);
        }
        if let Some(root) = self.active.as_mut() {
            let total_sub = root.submit_ms - sub0;
            root.shadow_ms += (now() - t0 - total_sub).max(0.0);
        }

        let tid = temp.tid;
        let bytes = temp.bytes;
        self.temp_in_use.push(temp);
        self.in_use_bytes += bytes;

        let (sox, soy) = self.scene_offset();
        let x = f64::from(dirty.x0 - sox);
        let y = f64::from(dirty.y0 - soy);
        let region = TextureRegion::Rect(RectU16 {
            x0: 0,
            y0: 0,
            x1: dirty_w as u16,
            y1: dirty_h as u16,
        });
        self.scene.set_transform(Affine::IDENTITY);
        self.scene.set_paint(Image {
            image: ImageSource::external_texture(tid, region, true),
            sampler: ImageSampler {
                x_extend: Extend::Pad,
                y_extend: Extend::Pad,
                quality: ImageQuality::Low,
                alpha: 1.0,
            },
        });
        self.scene.set_paint_transform(Affine::translate((x, y)));
        self.scene.set_tint(Some(Tint {
            color,
            mode: TintMode::AlphaMask,
        }));
        self.scene.set_fill_rule(Fill::NonZero);
        self.scene
            .fill_rect(&Rect::new(x, y, x + f64::from(dirty_w), y + f64::from(dirty_h)));
        self.scene.set_tint(None);
        self.mark_dirty();
        Ok(())
    }

    fn background_blur(
        &mut self,
        reader: Option<(u32, usize)>,
        op: &BackgroundBlurOp,
        paths: &[(BezPath, bool)],
        device: Affine,
        size: [f32; 2],
        alpha: f32,
        coarse: bool,
        open: &[Open],
    ) -> Result<()> {
        // A blur's capture, downsample, blur and composite passes, toward the moving pass cap.
        self.note_passes(4);
        if open.iter().any(|o| matches!(o, Open::Layer)) {
            return Err(EngineError::unsupported(
                "a backdrop reader inside a layer that fades as one",
            ));
        }
        if self.capture_halo_strip_backdrop(reader, open)? {
            return Ok(());
        }
        if self.reader_halo.as_ref().is_some_and(|h| h.strip_capture.is_some()) {
            return Ok(());
        }
        if let Some(h) = self.reader_halo.as_mut()
            && h.wide_capture
            && reader == h.wide_last
        {
            h.wide_done = true;
        }
        let scale = device.determinant().abs().sqrt() as f32;
        if !(scale > 0.0 && scale.is_finite()) {
            return Ok(());
        }
        let Some(mut draw) = self.prepare_blur_reader(paths, device, coarse, open)? else {
            return Ok(());
        };
        let t_blur = now();
        let (sub0, vr0) = self
            .active
            .as_ref()
            .map_or((0.0, 0.0), |a| (a.submit_ms, a.vello_render_ms));
        if let Some(a) = self.active.as_mut() {
            a.bg_blur_ops += 1;
        }
        let sigma = blur::sigma_from_radius(op.radius) * scale;
        let within = glass::clip_within_from_open(open);
        let capture_tier = self.reader_halo.as_ref().and_then(|halo| halo.capture);
        let has_downstream = reader.is_none_or(|key| {
            self.reader_halo.as_ref().is_none_or(|halo| {
                if capture_tier.is_some_and(|t| !t.is_far) {
                    halo.downstream_mid_readers.contains(&key)
                } else {
                    halo.downstream_readers.contains(&key)
                }
            })
        });

        // During a halo capture pass, skip blurs that neither belong to this tier nor feed any
        // later visible reader.
        if let Some(tier) = capture_tier {
            let in_tier = if self.reader_halo.as_ref().is_some_and(|h| h.wide_capture) {
                reader.is_some_and(|key| self.reader_halo.as_ref().is_some_and(|h| h.wide_targets.contains(&key)))
            } else {
                let sigma_dev = sigma * tier.render_divisor as f32;
                reader.is_some() && sigma_dev >= tier.unif_min_sigma && sigma_dev < tier.unif_max_sigma
            };
            if !in_tier && !has_downstream {
                return Ok(());
            }
            if in_tier && !has_downstream {
                let reader_key = reader.expect("in_tier requires key");
                // Inflate by 1 coarse texel so bilinear upsampling of pixels just inside a
                // fractional shape/clip edge has its outer neighbor rather than clamping.
                let bounds = draw
                    .dirty
                    .inflate(1, 1)
                    .translate(draw.origin.0, draw.origin.1)
                    .intersect(tier.visible.inflate(2, 2))
                    .clamp(tier.frame_size.0, tier.frame_size.1);
                if bounds.is_empty() {
                    return Ok(());
                }
                let blur_dirty = bounds.translate(-draw.origin.0, -draw.origin.1);
                // Resolve inherited scope prefix (#274) before taking the blur encoder.
                self.resolve_blur_source(&mut draw, sigma, Some(blur_dirty))?;
                let mut encoder = self.take_encoder("reader blur halo capture");
                self.encode_single_blur_into_out(&mut encoder, reader, Some(tier), &draw, blur_dirty, sigma, within)?;
                let old = self.capture_blurred_halo_patch(&mut encoder, reader_key, bounds, (0, 0), tier)?;
                if let Some(old) = old {
                    self.stash_encoder(encoder);
                    self.submit_active_encoder();
                    self.recycle_halo_prefix(old);
                } else {
                    self.stash_encoder(encoder);
                }
                if let Some(a) = self.active.as_mut() {
                    let sub = a.submit_ms - sub0;
                    let vr = a.vello_render_ms - vr0;
                    a.reader_ms += (now() - t_blur - sub - vr).max(0.0);
                }
                return Ok(());
            }
        }
        let (target_w, target_h) = self.active_scene_size();
        let target_rect = IRect {
            x0: 0,
            y0: 0,
            x1: i32::from(target_w),
            y1: i32::from(target_h),
        };
        let coarse_shared = draw.source_is_frame
            && within.is_none()
            && draw.source.bounds.x0 == 0
            && draw.source.bounds.y0 == 0
            && draw.source.bounds.size() == (draw.frame_size.0 as u32, draw.frame_size.1 as u32);
        let allow_shrink = capture_tier.is_none() && (!coarse || coarse_shared);
        let clip = self.analyze_open_clips(open, draw.dirty, target_rect, true, allow_shrink);
        if clip.clipped_rect.is_empty() {
            return Ok(());
        }
        let mut halo_sample = if coarse {
            None
        } else {
            reader
                .and_then(|reader| self.reader_halo.as_ref()?.blurred.get(&reader))
                .and_then(|patch| self.sample_blur_halo(&draw, patch, patch.size))
                .or_else(|| {
                    capture_tier
                        .is_none()
                        .then(|| self.sample_wide_blur_patch(reader, &draw))
                        .flatten()
                })
        };
        if coarse || halo_sample.is_none() {
            if !coarse
                && self.reader_halo.is_some()
                && reader.is_some()
                && capture_tier.is_none()
                && sigma >= self.reader_halo.as_ref().expect("reader halo").native_unif_cutover
            {
                return Err(EngineError::limit("a visible background blur has no coarse backdrop"));
            }
            if !coarse
                && capture_tier.is_none()
                && let Some(key) = reader
                && let Some(WideBlurState::Ready(cache)) = self.wide_blur.as_ref()
                && self.active.as_ref().and_then(|a| a.draw_level) == Some(cache.level)
                && cache.targets.contains(&key)
            {
                return Err(EngineError::limit("wide blur patch outside capture"));
            }
            self.resolve_blur_source(&mut draw, sigma, None)?;
        }
        if allow_shrink {
            draw.dirty = clip.clipped_rect;
        }
        let analytic = if coarse {
            analytic_box_from_paths(paths, device, size, draw.frame_dirty_origin())
        } else {
            None
        };
        let (mut encoder, clip_mask) =
            self.encode_blur_reader_masks(&draw, paths, device, analytic.is_some(), &clip)?;
        let clip_arg = clip_mask.as_ref().map(|m| (&m.view, m.view_id, m.origin));
        if coarse {
            if draw.source_is_frame {
                self.flush_backdrop_blur_written();
            }
            let opaque_target = self.reader_target_opaque(within);
            let budget = self.reader_budget_room();
            self.readers.encode_coarse_blur(
                &self.device,
                &mut encoder,
                &draw.source.plane.view,
                draw.source.plane.view_id,
                draw.targets.iter().flatten().map(|t| (&t.texture, &t.view)),
                draw.source.bounds.size(),
                draw.frame_size,
                (-draw.source.bounds.x0, -draw.source.bounds.y0),
                draw.frame_dirty_origin(),
                self.backdrop_gen,
                draw.source_is_frame,
                draw.dirty,
                sigma,
                within,
                alpha,
                analytic,
                clip_arg,
                opaque_target,
                budget,
            )?;
        } else {
            if halo_sample.is_none() {
                if draw.source_is_frame
                    && let Some(written) = self.backdrop_blur_written
                {
                    let reach = blur::blur_reach_view_bg(sigma).min(1.0e7).ceil() as i32 + 2;
                    if !written
                        .intersect(draw.source_rect(draw.dirty).inflate(reach, reach))
                        .is_empty()
                    {
                        self.bump_backdrop_gen();
                    }
                }
                let fused = if capture_tier.is_none() && blur::choose_level_view_bg(sigma).0 > 0 {
                    let (clamp_bounds, edge) = draw.bounds_and_edge(within, sigma, true);
                    let sample = draw.source_rect(draw.dirty);
                    let src_size = draw.source.bounds.size();
                    let key = draw
                        .source_is_frame
                        .then(|| blur::PyramidKey::new(self.backdrop_gen, clamp_bounds, edge));
                    let spec = BlurSpec {
                        sigma,
                        edge,
                        clamp_bounds,
                        dirty: sample,
                    };
                    let work = self.blur.estimate_view_bg_work_bytes(src_size, &spec, key);
                    self.reserve_or_trim(work, 0, "backdrop Gaussian working textures")?;
                    self.blur
                        .encode_view_bg_level(
                            &self.device,
                            &mut encoder,
                            &draw.source.plane.view,
                            draw.source.plane.view_id,
                            src_size,
                            &spec,
                            key,
                        )?
                        .map(|out| {
                            let inv = out.inv_scale;
                            let offset = (
                                (sample.x0 - draw.dirty.x0 - out.cb_origin.0) as f32 * inv - out.blur_origin.0 as f32,
                                (sample.y0 - draw.dirty.y0 - out.cb_origin.1) as f32 * inv - out.blur_origin.1 as f32,
                            );
                            BlurHaloSample {
                                view: out.view,
                                view_id: out.view_id,
                                size: out.active_size,
                                inv,
                                offset,
                            }
                        })
                } else {
                    None
                };
                if let Some(sample) = fused {
                    halo_sample = Some(sample);
                } else {
                    self.encode_single_blur_into_out(
                        &mut encoder,
                        reader,
                        capture_tier,
                        &draw,
                        draw.dirty,
                        sigma,
                        within,
                    )?;
                    let capture = reader.and_then(|reader| {
                        let tier = capture_tier?;
                        let in_tier = if self.reader_halo.as_ref().is_some_and(|h| h.wide_capture) {
                            self.reader_halo
                                .as_ref()
                                .is_some_and(|h| h.wide_targets.contains(&reader))
                        } else {
                            let sigma_dev = sigma * tier.render_divisor as f32;
                            sigma_dev >= tier.unif_min_sigma && sigma_dev < tier.unif_max_sigma
                        };
                        let bounds = draw
                            .dirty
                            .translate(draw.origin.0, draw.origin.1)
                            .intersect(tier.visible.inflate(2, 2));
                        (in_tier && !bounds.is_empty()).then_some((reader, bounds, tier))
                    });
                    if let Some((reader, bounds, tier)) = capture {
                        let origin = draw.frame_dirty_origin();
                        let start = ((bounds.x0 - origin.0) as u32, (bounds.y0 - origin.1) as u32);
                        if let Some(old) = self.capture_blurred_halo_patch(&mut encoder, reader, bounds, start, tier)? {
                            // This encoder can still refer to the previous patch.
                            self.stash_encoder(encoder);
                            self.submit_active_encoder();
                            self.recycle_halo_prefix(old);
                            encoder = self.take_encoder("reader blur composite");
                        }
                    }
                }
            }
            let opaque_target = self.reader_target_opaque(within)
                && (halo_sample.is_some()
                    || !draw.bounds_and_edge(within, sigma, capture_tier.is_none()).0.is_empty()
                    || within.is_some_and(|w| w.fill.is_some_and(|c| c[3] == 255)));
            let budget = self.reader_budget_room();
            for target in draw.targets.iter().flatten() {
                self.readers.encode_bg_blur_composite(
                    &self.device,
                    &mut encoder,
                    &target.texture,
                    &target.view,
                    draw.dirty,
                    alpha,
                    clip_arg,
                    opaque_target,
                    halo_sample.as_ref(),
                    budget,
                )?;
            }
        }
        if draw.source_is_frame && draw.source_written {
            if coarse || capture_tier.is_some() {
                self.bump_backdrop_gen();
            } else {
                let written = draw.source_rect(draw.dirty);
                self.backdrop_blur_written = Some(
                    self.backdrop_blur_written
                        .map_or(written, |prev| halo::rect_union(prev, written)),
                );
            }
        }
        self.stash_encoder(encoder);
        if let Some(a) = self.active.as_mut() {
            let sub = a.submit_ms - sub0;
            let vr = a.vello_render_ms - vr0;
            a.reader_ms += (now() - t_blur - sub - vr).max(0.0);
        }
        Ok(())
    }

    fn progressive_blur(
        &mut self,
        key: (u32, usize),
        op: &ProgressiveBlurOp,
        paths: &[(BezPath, bool)],
        device: Affine,
        size: [f32; 2],
        alpha: f32,
        coarse: bool,
        open: &[Open],
    ) -> Result<()> {
        // A progressive blur's capture, levels and composite, toward the moving pass cap.
        self.note_passes(6);
        if open.iter().any(|o| matches!(o, Open::Layer)) {
            return Err(EngineError::unsupported(
                "a backdrop reader inside a layer that fades as one",
            ));
        }
        if self.capture_halo_strip_backdrop(Some(key), open)? {
            return Ok(());
        }
        if self.reader_halo.as_ref().is_some_and(|h| h.strip_capture.is_some()) {
            return Ok(());
        }
        let scale = device.determinant().abs().sqrt() as f32;
        if !(scale > 0.0 && scale.is_finite()) {
            return Ok(());
        }
        let plan = progressive_blur::ProgressivePlan::new(op, device, size, scale);
        let mut plan = match plan {
            Some(plan) if !coarse => plan,
            fallback => {
                let radius = if fallback.is_some() {
                    0.5 * (op.start_radius + op.end_radius)
                } else {
                    op.start_radius.max(op.end_radius)
                };
                let uniform = BackgroundBlurOp {
                    paths: op.paths.clone(),
                    even_odd: op.even_odd,
                    radius,
                };
                return self.background_blur(Some(key), &uniform, paths, device, size, alpha, coarse, open);
            }
        };
        let Some(mut draw) = self.prepare_blur_reader(paths, device, false, open)? else {
            return Ok(());
        };
        let t_blur = now();
        let (sub0, vr0) = self
            .active
            .as_ref()
            .map_or((0.0, 0.0), |a| (a.submit_ms, a.vello_render_ms));
        if let Some(a) = self.active.as_mut() {
            a.bg_blur_ops += 1;
        }
        let max_sigma = plan.start_sigma.max(plan.end_sigma);
        let within = glass::clip_within_from_open(open);
        let capture_tier = self.reader_halo.as_ref().and_then(|halo| halo.capture);
        let has_downstream = self.reader_halo.as_ref().is_none_or(|halo| {
            if capture_tier.is_some_and(|t| !t.is_far) {
                halo.downstream_mid_readers.contains(&key)
            } else {
                halo.downstream_readers.contains(&key)
            }
        });

        let mut captured_in_tier = false;
        if let Some(tier) = capture_tier {
            let d = tier.render_divisor as f32;
            let lo_dev = plan.start_sigma.min(plan.end_sigma) * d;
            let hi_dev = max_sigma * d;
            // Rebuild the exact device stop ladder scaled to the replay grid.
            if d > 1.0 {
                plan.stops = progressive_blur::choose_stops(lo_dev, hi_dev)
                    .into_iter()
                    .map(|sigma| sigma / d)
                    .collect();
            }
            let eligible = hi_dev >= tier.unif_min_sigma;
            let first = if eligible {
                plan.stops.partition_point(|sigma| *sigma * d < tier.prog_min_sigma)
            } else {
                plan.stops.len()
            };
            let end = if eligible {
                plan.stops.partition_point(|sigma| *sigma * d < tier.prog_max_sigma)
            } else {
                plan.stops.len()
            };
            let vis_bounds = draw
                .dirty
                .translate(draw.origin.0, draw.origin.1)
                .intersect(tier.visible.inflate(2, 2));
            let (cap_first, cap_end) = if eligible && first < end && !vis_bounds.is_empty() {
                let vis_rect = Rect::new(
                    f64::from(vis_bounds.x0),
                    f64::from(vis_bounds.y0),
                    f64::from(vis_bounds.x1),
                    f64::from(vis_bounds.y1),
                )
                .inflate(2.0, 2.0);
                let (vf, ve) = plan.active_stop_range(vis_rect);
                (first.max(vf), end.min(ve))
            } else {
                (end, end)
            };
            let capture_bounds = if cap_first < cap_end {
                self.capture_progressive_halo(key, &draw, cap_first, cap_end, !has_downstream)?
            } else {
                None
            };
            captured_in_tier = capture_bounds.is_some();
            if !has_downstream {
                let Some(bounds) = capture_bounds else {
                    return Ok(());
                };
                let active_dirty = bounds.translate(-draw.origin.0, -draw.origin.1);
                let stop_count = cap_end - cap_first;
                let max_raw_stop_sigma = plan.stops[cap_end - 1];
                // Resolve inherited scope prefix (#274) before taking the blur encoder.
                self.resolve_blur_source(&mut draw, max_raw_stop_sigma, Some(active_dirty))?;
                let max_stop_sigma = halo::compensate_halo_sigma(max_raw_stop_sigma, tier.render_divisor);
                let clip_info = draw.halo_clip_bounds(Some(tier), within, max_stop_sigma, false);
                let mut encoder = self.take_encoder("progressive halo capture");
                let cols = (stop_count as u32).clamp(1, 4);
                let rows = (stop_count as u32).div_ceil(cols).max(1);
                let width = (active_dirty.x1 - active_dirty.x0) as u32;
                let height = (active_dirty.y1 - active_dirty.y0) as u32;
                let budget = self.reader_budget_room();
                let tile_side = self.progressive_tile_side(width, height, cols, rows, budget);
                self.ensure_reader_tex(2, width.min(tile_side) * cols, height.min(tile_side) * rows, "")?;
                let sample_dirty = draw.source_rect(active_dirty);
                let (source, source_id, src_size, crop_origin, clamp_bounds, edge, pyramid_key) = self
                    .prefilter_halo_blur_source(
                        &mut encoder,
                        Some(key),
                        Some(tier),
                        &draw,
                        sample_dirty,
                        max_stop_sigma,
                        clip_info,
                    )?;
                let side = tile_side as i32;
                for y0 in (active_dirty.y0..active_dirty.y1).step_by(tile_side as usize) {
                    for x0 in (active_dirty.x0..active_dirty.x1).step_by(tile_side as usize) {
                        let tile = IRect {
                            x0,
                            y0,
                            x1: (x0 + side).min(active_dirty.x1),
                            y1: (y0 + side).min(active_dirty.y1),
                        };
                        self.encode_progressive_tile_stops(
                            &mut encoder,
                            key,
                            Some(tier),
                            &draw,
                            &plan,
                            tile,
                            2.0,
                            &source,
                            source_id,
                            src_size,
                            crop_origin,
                            clamp_bounds,
                            edge,
                            pyramid_key,
                            cap_first,
                            cap_end,
                            cols,
                        )?;
                    }
                }
                self.stash_encoder(encoder);
                return Ok(());
            }
        }

        let (target_w, target_h) = self.active_scene_size();
        let target_rect = IRect {
            x0: 0,
            y0: 0,
            x1: i32::from(target_w),
            y1: i32::from(target_h),
        };
        let allow_shrink = capture_tier.is_none();
        let clip = self.analyze_open_clips(open, draw.dirty, target_rect, true, allow_shrink);
        if clip.clipped_rect.is_empty() {
            return Ok(());
        }

        // Resolve captured progressive halo stops: in the device pass up to two tiers (mid + far),
        // and in a mid capture pass any already-captured far stops for downstream readers.
        let sample_prog = |patch: &ProgressiveHaloPatch| -> Option<ProgressiveHaloSample> {
            Some(ProgressiveHaloSample {
                sample: self.sample_blur_halo(&draw, &patch.patch, patch.cell_size)?,
                cell_size: patch.cell_size,
                first: patch.first,
                cols: patch.cols,
            })
        };
        let (halo_1, halo_2) = match capture_tier {
            Some(tier) if tier.is_far => (None, None),
            Some(_) => {
                let far = self
                    .reader_halo
                    .as_ref()
                    .and_then(|halo| halo.progressive_far.get(&key))
                    .and_then(sample_prog);
                (far, None)
            }
            None => {
                let mid = self
                    .reader_halo
                    .as_ref()
                    .and_then(|halo| halo.progressive_mid.get(&key))
                    .and_then(sample_prog);
                let far = self
                    .reader_halo
                    .as_ref()
                    .and_then(|halo| halo.progressive_far.get(&key))
                    .and_then(sample_prog);
                match (mid, far) {
                    (Some(m), Some(f)) => (Some(m), Some(f)),
                    (Some(m), None) => (Some(m), None),
                    (None, Some(f)) => (Some(f), None),
                    (None, None) => (None, None),
                }
            }
        };
        let orig_dirty = draw.dirty;
        let dirty_frame = Rect::new(
            f64::from(draw.origin.0 + orig_dirty.x0),
            f64::from(draw.origin.1 + orig_dirty.y0),
            f64::from(draw.origin.0 + orig_dirty.x1),
            f64::from(draw.origin.1 + orig_dirty.y1),
        );
        let dirty_pad = if capture_tier.is_some() { 2.0 } else { 0.0 };
        let (dirty_first, dirty_end) = plan.active_stop_range(dirty_frame.inflate(dirty_pad, dirty_pad));
        let vis_max_sigma = plan.stops.get(dirty_end.saturating_sub(1)).copied().unwrap_or(0.0);
        if let Some(halo) = self.reader_halo.as_ref()
            && capture_tier.is_none()
            && halo_1.is_none()
            && max_sigma >= halo.native_unif_cutover
            && vis_max_sigma >= halo.native_prog_cutover
        {
            return Err(EngineError::limit("a visible progressive blur has no coarse backdrop"));
        }
        let resident = halo_1.as_ref().map_or(plan.stops.len(), |halo| halo.first);
        let mid_tier_reuses_far = !captured_in_tier && capture_tier.is_some_and(|t| !t.is_far);
        let fast_halo_only = (capture_tier.is_none() || mid_tier_reuses_far) && dirty_first >= resident;
        let max_resident_sigma = plan
            .stops
            .get(resident.min(dirty_end).saturating_sub(1))
            .copied()
            .unwrap_or(0.0);
        if !fast_halo_only && resident > 0 {
            self.resolve_blur_source(&mut draw, max_resident_sigma, None)?;
        }
        if allow_shrink {
            draw.dirty = clip.clipped_rect;
        }
        let dirty = draw.dirty;
        let (mut encoder, clip_mask) = self.encode_blur_reader_masks(&draw, paths, device, false, &clip)?;
        let clip_arg = clip_mask.as_ref().map(|m| (&m.view, m.view_id, m.origin));
        let (width, height) = draw.dirty_size();

        // Fast path: when every active stop in `dirty` is already provided by captured halo tiers,
        // skip native blur passes, blur_out atlas allocation, and progressive tiling completely.
        if fast_halo_only {
            let opaque_target = self.reader_target_opaque(within)
                && (!draw.bounds_and_edge(within, max_sigma, false).0.is_empty()
                    || within.is_some_and(|w| w.fill.is_some_and(|c| c[3] == 255)));
            let chunk_side = if (width as usize).saturating_mul(height as usize) <= 6_000_000 {
                width.max(height).max(1)
            } else {
                1024u32.min(self.max_texture_2d).max(1)
            };
            let side = chunk_side as i32;
            for y0 in (dirty.y0..dirty.y1).step_by(chunk_side as usize) {
                for x0 in (dirty.x0..dirty.x1).step_by(chunk_side as usize) {
                    let tile = IRect {
                        x0,
                        y0,
                        x1: (x0 + side).min(dirty.x1),
                        y1: (y0 + side).min(dirty.y1),
                    };
                    let budget = self.reader_budget_room();
                    for target in draw.targets.iter().flatten() {
                        self.readers.encode_progressive_composite(
                            &self.device,
                            &mut encoder,
                            &target.texture,
                            &target.view,
                            tile,
                            dirty,
                            draw.origin,
                            &plan,
                            1,
                            alpha,
                            clip_arg,
                            opaque_target,
                            halo_1.as_ref(),
                            halo_2.as_ref(),
                            budget,
                        )?;
                    }
                }
            }
            if draw.source_is_frame && draw.source_written {
                self.bump_backdrop_gen();
            }
            self.stash_encoder(encoder);
            return Ok(());
        }

        let max_resident_blur_sigma = capture_tier.map_or(max_resident_sigma, |tier| {
            halo::compensate_halo_sigma(max_resident_sigma, tier.render_divisor)
        });
        let clip_info = draw.halo_clip_bounds(capture_tier, within, max_resident_blur_sigma, false);
        let cols = (resident as u32).clamp(1, 4);
        let rows = (resident as u32).div_ceil(cols).max(1);
        let budget = self.reader_budget_room();
        let tile_side = self.progressive_tile_side(width, height, cols, rows, budget);
        self.ensure_reader_tex(2, width.min(tile_side) * cols, height.min(tile_side) * rows, "")?;
        if draw.source_is_frame {
            self.flush_backdrop_blur_written();
        }
        // Each tile reads the same prefix. Keep a copy when a previous tile can have
        // replaced part of the source used by the next tile's Gaussian, or when a reduced pass
        // needs sub-texel clip border/clamp prefiltering.
        let (source, source_id, src_size, crop_origin, clamp_bounds, edge, pyramid_key) = if resident > 0
            && (clip_info.subtexel_border.is_some()
                || (clip_info.subtexel_clamp.is_some()
                    && self
                        .reader_halo
                        .as_ref()
                        .is_some_and(|h| h.clamp_strips.contains_key(&key))))
        {
            self.prefilter_halo_blur_source(
                &mut encoder,
                Some(key),
                capture_tier,
                &draw,
                draw.source_rect(draw.dirty),
                max_resident_blur_sigma,
                clip_info,
            )?
        } else {
            let pyramid_key = draw
                .source_is_frame
                .then(|| blur::PyramidKey::new(self.backdrop_gen, clip_info.clamp_bounds, clip_info.edge));
            let source_size = draw.source.bounds.size();
            let (view, view_id) = if resident > 0 && draw.source_written && (width > tile_side || height > tile_side) {
                let budget = self.reader_budget_room();
                self.readers
                    .ensure_blur_source_budgeted(&self.device, source_size, budget)?;
                let snapshot = self.readers.blur_source.as_ref().expect("blur reader source");
                copy_rect(
                    &mut encoder,
                    &draw.source.plane.texture,
                    &snapshot.texture,
                    (0, 0),
                    (0, 0),
                    source_size,
                );
                (snapshot.view.clone(), snapshot.view_id)
            } else {
                (draw.source.plane.view.clone(), draw.source.plane.view_id)
            };
            (
                view,
                view_id,
                source_size,
                (0, 0),
                clip_info.clamp_bounds,
                clip_info.edge,
                pyramid_key,
            )
        };

        let side = tile_side as i32;
        for y0 in (dirty.y0..dirty.y1).step_by(tile_side as usize) {
            for x0 in (dirty.x0..dirty.x1).step_by(tile_side as usize) {
                let tile = IRect {
                    x0,
                    y0,
                    x1: (x0 + side).min(dirty.x1),
                    y1: (y0 + side).min(dirty.y1),
                };
                self.encode_progressive_tile_stops(
                    &mut encoder,
                    key,
                    capture_tier,
                    &draw,
                    &plan,
                    tile,
                    dirty_pad,
                    &source,
                    source_id,
                    src_size,
                    crop_origin,
                    clamp_bounds,
                    edge,
                    pyramid_key,
                    0,
                    resident.min(plan.stops.len()),
                    cols,
                )?;
                let opaque_target = self.reader_target_opaque(within)
                    && (!clamp_bounds.is_empty() || within.is_some_and(|w| w.fill.is_some_and(|c| c[3] == 255)));
                let budget = self.reader_budget_room();
                for target in draw.targets.iter().flatten() {
                    self.readers.encode_progressive_composite(
                        &self.device,
                        &mut encoder,
                        &target.texture,
                        &target.view,
                        tile,
                        dirty,
                        draw.origin,
                        &plan,
                        cols,
                        alpha,
                        clip_arg,
                        opaque_target,
                        halo_1.as_ref(),
                        halo_2.as_ref(),
                        budget,
                    )?;
                }
            }
        }
        if draw.source_is_frame && draw.source_written {
            self.bump_backdrop_gen();
        }
        self.stash_encoder(encoder);
        if let Some(a) = self.active.as_mut() {
            let sub = a.submit_ms - sub0;
            let vr = a.vello_render_ms - vr0;
            a.reader_ms += (now() - t_blur - sub - vr).max(0.0);
        }
        Ok(())
    }
}

/// Detects a single closed axis-aligned rectangle or rounded rectangle in `[0..w] x [0..h]` so
/// interactive coarse background blur can evaluate coverage analytically without a `vello_gpu`
/// mask rasterization pass. Arbitrary paths return `None` and rasterize through `mask_tex`.
fn analytic_box_from_paths(
    paths: &[(BezPath, bool)],
    device: Affine,
    size: [f32; 2],
    origin: (i32, i32),
) -> Option<CoarseAnalytic> {
    if paths.len() != 1 || !(size[0] > 0.0 && size[1] > 0.0) {
        return None;
    }
    let w = f64::from(size[0]);
    let h = f64::from(size[1]);
    let [da, db, dc, dd, de, df] = device.as_coeffs();
    let det = da * dd - db * dc;
    if !(det.abs() > 1e-12 && det.is_finite()) {
        return None;
    }
    let eps = 1e-2;
    let on_edge = |p: vello_common::kurbo::Point| -> u8 {
        let mut m = 0u8;
        if p.y.abs() <= eps {
            m |= 1; // top
        }
        if (p.x - w).abs() <= eps {
            m |= 2; // right
        }
        if (p.y - h).abs() <= eps {
            m |= 4; // bottom
        }
        if p.x.abs() <= eps {
            m |= 8; // left
        }
        m
    };
    let in_bounds =
        |p: vello_common::kurbo::Point| -> bool { p.x >= -eps && p.x <= w + eps && p.y >= -eps && p.y <= h + eps };
    let mut moves = 0usize;
    let mut closed = false;
    let mut cur = vello_common::kurbo::Point::ZERO;
    let mut top = (f64::INFINITY, f64::NEG_INFINITY);
    let mut bot = (f64::INFINITY, f64::NEG_INFINITY);
    let mut left = (f64::INFINITY, f64::NEG_INFINITY);
    let mut right = (f64::INFINITY, f64::NEG_INFINITY);
    let mut record = |p: vello_common::kurbo::Point, require_edge: bool| -> bool {
        if !in_bounds(p) {
            return false;
        }
        let m = on_edge(p);
        if m == 0 {
            return !require_edge;
        }
        if (m & 1) != 0 {
            top.0 = top.0.min(p.x);
            top.1 = top.1.max(p.x);
        }
        if (m & 2) != 0 {
            right.0 = right.0.min(p.y);
            right.1 = right.1.max(p.y);
        }
        if (m & 4) != 0 {
            bot.0 = bot.0.min(p.x);
            bot.1 = bot.1.max(p.x);
        }
        if (m & 8) != 0 {
            left.0 = left.0.min(p.y);
            left.1 = left.1.max(p.y);
        }
        true
    };
    for el in paths[0].0.elements() {
        match *el {
            PathEl::MoveTo(p) => {
                moves += 1;
                if moves > 1 || !record(p, true) {
                    return None;
                }
                cur = p;
            }
            PathEl::LineTo(p) => {
                if !record(p, true) {
                    return None;
                }
                if (p - cur).hypot2() > 1e-6 && (on_edge(cur) & on_edge(p)) == 0 {
                    return None;
                }
                cur = p;
            }
            PathEl::QuadTo(p1, p2) => {
                // Multi-segment corner arcs have intermediate endpoints strictly inside the box.
                if !in_bounds(p1) || !record(p2, false) {
                    return None;
                }
                cur = p2;
            }
            PathEl::CurveTo(p1, p2, p3) => {
                if !in_bounds(p1) || !in_bounds(p2) || !record(p3, false) {
                    return None;
                }
                cur = p3;
            }
            PathEl::ClosePath => {
                closed = true;
            }
        }
    }
    if moves != 1 || !closed || !top.0.is_finite() || !bot.0.is_finite() || !left.0.is_finite() || !right.0.is_finite()
    {
        return None;
    }
    let corner = |a: f64, b: f64| -> Option<f32> {
        if a < -0.5 || b < -0.5 || (a - b).abs() > 0.5 {
            return None;
        }
        Some((0.5 * (a + b)).max(0.0) as f32)
    };
    let r_tl = corner(top.0, left.0)?;
    let r_tr = corner(w - top.1, right.0)?;
    let r_br = corner(w - bot.1, h - right.1)?;
    let r_bl = corner(bot.0, h - left.1)?;
    if f64::from(r_tl + r_tr) > w + 0.5
        || f64::from(r_bl + r_br) > w + 0.5
        || f64::from(r_tl + r_bl) > h + 0.5
        || f64::from(r_tr + r_br) > h + 0.5
    {
        return None;
    }
    let ia = dd / det;
    let ib = -db / det;
    let ic = -dc / det;
    let id = da / det;
    let ie = (dc * df - dd * de) / det;
    let jf = (db * de - da * df) / det;
    let unit_px = det.abs().sqrt() as f32;
    let fx0 = f64::from(origin.0);
    let fy0 = f64::from(origin.1);
    Some(CoarseAnalytic {
        mode: 1,
        to_box: [
            ia as f32,
            ib as f32,
            ic as f32,
            id as f32,
            (ia * fx0 + ic * fy0 + ie) as f32,
            (ib * fx0 + id * fy0 + jf) as f32,
        ],
        size,
        radii: [r_tl, r_tr, r_br, r_bl],
        smoothing: [0.0; 4],
        unit_px,
    })
}

impl crate::tiles::TilePageHost for Gpu {
    fn tile_cache_mut(&mut self) -> &mut TileCache {
        &mut self.tiles
    }
    fn page_side(&self) -> u32 {
        self.page_side
    }
    fn set_page_side(&mut self, side: u32) {
        self.page_side = side;
    }
    fn page_count(&self) -> usize {
        self.pages.len()
    }
    fn max_texture_2d(&self) -> u32 {
        self.max_texture_2d
    }
    fn tile_budget_limit(&self, tile_bytes: usize) -> usize {
        Gpu::tile_budget_limit(self, tile_bytes)
    }
    fn trim_transient(&mut self) {
        Gpu::trim_transient(self);
    }
    fn pop_page(&mut self) {
        let pbytes = self.page_bytes();
        if let Some(p) = self.pages.pop() {
            p.texture.destroy();
            self.bytes -= pbytes;
        }
    }
}
