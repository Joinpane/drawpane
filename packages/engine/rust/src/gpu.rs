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
    self, Backend, DrawStats, Frame, GlyphMask, IRect, ImageView, Isolation, Open, Pass, PostStep, ReducedBlurLimits,
    ReducedPost, ShadowCast, Split, impl_draw, resolve_inradius,
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
use crate::tiles::{Composite, Last, TILE, TileCache, TileKey};
use std::cell::Cell;
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use vello_common::TextureId;
use vello_common::color::{AlphaColor, Srgb};
use vello_common::geometry::RectU16;
use vello_common::kurbo::{Affine, BezPath, PathEl, Rect};
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

impl_draw!(Scene);

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
/// Budget for the GPU canonical shadow mask cache (strictly enforced LRU).
const GPU_SHADOW_CACHE_BYTES: usize = 16 << 20;

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
struct Page {
    texture: wgpu::Texture,
    view: wgpu::TextureView,
    composite_group: Option<wgpu::BindGroup>,
}

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
}

/// A bounded isolated source, with a second plane when the channels can differ.
struct GpuIsolation {
    main: GpuTarget,
    backdrop: Option<GpuTarget>,
    isolation: Isolation,
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
    /// A whole frame writes straight to its destination; tiles use scratch color.
    frame_dst: Option<usize>,
    /// The part of a padded viewport that is actually presented.
    display_area: Option<IRect>,
    width: u32,
    height: u32,
    background: [f32; 4],
    detail: bool,
    needs_clear: bool,
    backdrop_live: bool,
    write_main: bool,
    write_backdrop: bool,
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
    fn new(
        frame_dst: Option<usize>,
        display_area: Option<IRect>,
        width: u32,
        height: u32,
        background: [f32; 4],
        detail: bool,
    ) -> Self {
        Self {
            frame_dst,
            display_area,
            width,
            height,
            background,
            detail,
            needs_clear: true,
            backdrop_live: false,
            write_main: true,
            write_backdrop: false,
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
    coarse_readers: bool,
    halo: i32,
    tile_halo: i32,
    side: u32,
    background: [f32; 4],
    bg_bits: [u32; 4],
    generation: u64,
    active_scratch: usize,
    active: ActiveDraw,
    checkpoint: exec::WalkCheckpoint,
    verbs: usize,
    backdrop_gen: u64,
}

enum TileStep {
    Complete,
    Paused,
    NoSlot,
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

    fn bounds_and_edge(&self, within: Option<glass::ClipWithin>, sigma: f32) -> (IRect, EdgeMode) {
        progressive_blur::blur_bounds_and_edge(
            within,
            self.frame_size,
            (-self.source.bounds.x0, -self.source.bounds.y0),
            (self.source.bounds.size().0 as i32, self.source.bounds.size().1 as i32),
            sigma,
        )
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
            let (clamp_bounds, edge) = self.bounds_and_edge(within, sigma);
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
    active: Option<ActiveDraw>,
    /// Hard wall-clock deadline (`now()` ms) checked cooperatively during budgeted tile walks.
    deadline_ms: Option<f64>,
    /// Tile cooperatively paused mid-walk so no single frame stalls past its CPU budget.
    pending_tile: Option<PendingTile>,
    /// True while a freshly opened page is still completing its coarse opening ladder tiles.
    opening_pending: bool,
    backdrop_gen: u64,
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
    /// the sharp frame it was warped from: what a read-back shows until the next frame.
    standin_frame: Option<usize>,
    /// Milliseconds a tile has lately taken to draw (a running average).
    tile_ms: f64,
    /// Running EWMA of `submit_ms / work_ms` for tile slices so backends with synchronous submit
    /// flush costs (such as WebGL2 across Chrome, Safari, and Firefox) reserve headroom inside
    /// each frame's time budget.
    submit_ratio: f64,
    blit: Option<wgpu::RenderPipeline>,
    images: HashMap<u32, Vec<(TextureId, wgpu::Texture, u32, u32)>>,
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
    /// GPU memory allocated (`Limits::gpu_bytes`), and the budget.
    bytes: usize,
    pub budget: usize,
    /// Actual device limits validated before allocating textures or read-back buffers.
    max_texture_2d: u32,
    max_buffer_size: u64,
    /// Read-backs in flight.
    readbacks: Rc<Flights>,
    /// Optional WebGPU GPU timestamp query state for frame-level GPU timing.
    timestamps: Option<GpuTimestampQuery>,
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
        for scratch in self.scratches.iter_mut().filter_map(Option::take) {
            scratch.texture.destroy();
        }
        for set in &mut self.halo_reader_planes {
            for plane in set.iter_mut().filter_map(Option::take) {
                plane.texture.destroy();
            }
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

fn active_clips(open: &[Open], skip_context: bool) -> impl Iterator<Item = (&BezPath, Affine, bool)> {
    open.iter().filter_map(move |o| match o {
        Open::Clip {
            transform,
            path,
            even_odd,
            active_on_scene: true,
            context_only,
            ..
        } if !skip_context || !*context_only => Some((path, *transform, *even_odd)),
        _ => None,
    })
}

fn open_clips_need_mask(open: &[Open], rect: IRect, skip_context: bool) -> bool {
    active_clips(open, skip_context)
        .any(|(path, transform, even_odd)| !crate::geometry::path_covers_rect(path, transform, even_odd, rect))
}

fn raster_clips(scene: &mut Scene, open: &[Open], shift: Affine, size: (u32, u32), skip_context: bool) {
    let mut pushed = 0;
    for (path, transform, even_odd) in active_clips(open, skip_context) {
        scene.set_transform(shift * transform);
        scene.set_fill_rule(if even_odd { Fill::EvenOdd } else { Fill::NonZero });
        scene.push_clip_path(path);
        pushed += 1;
    }
    scene.set_transform(Affine::IDENTITY);
    scene.set_fill_rule(Fill::NonZero);
    scene.set_paint(vello_common::color::palette::css::WHITE);
    scene.fill_rect(&Rect::new(0.0, 0.0, f64::from(size.0), f64::from(size.1)));
    for _ in 0..pushed {
        scene.pop_clip();
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
            active: None,
            deadline_ms: None,
            pending_tile: None,
            opening_pending: false,
            backdrop_gen: 0,
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
            standin_frame: None,
            tile_ms: 0.0,
            submit_ratio: if IS_WEBGL { 1.0 } else { 0.0 },
            blit,
            images: HashMap::new(),
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
            retired_textures: Vec::new(),
            next_temp_id: TEMP_TEX_BASE,
            pool_bytes: 0,
            in_use_bytes: 0,
            health,
            submits: 0,
            bytes: (ATLAS_SIDE * ATLAS_SIDE * 4 + 16 * 16 * 4) as usize,
            budget: crate::limits::Limits::default().gpu_bytes,
            max_texture_2d: device_limits.max_texture_dimension_2d,
            max_buffer_size: device_limits.max_buffer_size,
            readbacks: Rc::new(Flights::default()),
            timestamps,
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
    fn reserve(&self, bytes: usize, freed: usize, what: &str) -> Result<()> {
        // Read-back buffers in flight count against the budget.
        let held = self.bytes() + self.readbacks.bytes.get();
        if held.saturating_sub(freed).saturating_add(bytes) > self.budget {
            return Err(EngineError::limit(format!(
                "{what} would take the engine's GPU memory to {} MiB; the most is {} MiB",
                held.saturating_sub(freed).saturating_add(bytes) >> 20,
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
                self.readers.drop_glass_mask_atlas();
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
                // Keep scratch reservations valid while allocating the rest of a pass.
                break;
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

    pub fn image_sizes(&self, id: u32) -> Vec<(u32, u32)> {
        self.images
            .get(&id)
            .into_iter()
            .flatten()
            .map(|level| (level.2, level.3))
            .collect()
    }

    pub fn drop_image_level(&mut self, id: u32, width: u32) {
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
        self.check_frame(dst, width, height, 0, 0)?;
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
            self.readers.drop_glass_mask_atlas();
            self.readers.flush_retired();
            self.scene.reset();
        }
    }

    /// Forgets the frame shown as a stand-in (after a fresh list: it shows a page that's gone).
    pub fn forget_last(&mut self) {
        self.abort_pending_tile();
        self.opening_pending = false;
        self.last = None;
        self.last_scale = None;
        self.shown = None;
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
        self.abort_pending_tile();
        self.opening_pending = false;
        self.tiles.clear();
        self.shown = None;
    }

    pub fn clear_view_caches(&mut self) {
        self.clear_tiles();
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
                    if gated.generation == generation {
                        self.shown = Some((gated.generation, gated.background, true));
                    }
                    self.last_scale = Some(gated.last.view.as_coeffs()[0]);
                    self.last = Some(gated.last);
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
            self.cur_page = true;
            self.last_scale = Some(staged.last.view.as_coeffs()[0]);
            self.last = Some(staged.last);
            self.shown = Some((staged.generation, staged.background, true));
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

    fn choose_page_side(&self, limit: usize) -> u32 {
        for side in [4096u32, 2048, 1024, TILE] {
            if side <= self.max_texture_2d && (side as usize) * (side as usize) * 4 <= limit {
                return side;
            }
        }
        DEFAULT_PAGE.min(self.max_texture_2d).max(TILE)
    }

    /// Bytes the engine holds on the GPU outside its tile pages.
    fn bytes_beside_tiles(&self) -> usize {
        self.bytes().saturating_sub(self.pages.len() * self.page_bytes())
    }

    /// Fits the tiles kept to the budget: what's left of it beside everything else, at most
    /// `tile_bytes`, in whole pages. Pages past it go, with their tiles. When no pages are
    /// allocated yet, picks 4096x4096 (64 tiles/page) if device limits and budget allow.
    fn fit_tiles(&mut self, tile_bytes: usize) {
        let beside = self.bytes_beside_tiles() + self.readbacks.bytes.get() + HEADROOM;
        let room = self.budget.saturating_sub(beside);
        let limit = tile_bytes.min(room);
        if self.pages.is_empty() {
            self.page_side = self.choose_page_side(limit);
        }
        let mut pbytes = self.page_bytes();
        let mut pages = (limit / pbytes).min(1024);
        while self.pages.len() > pages {
            if let Some(p) = self.pages.pop() {
                p.texture.destroy();
                self.bytes -= pbytes;
            }
        }
        if pages == 0 && self.pages.is_empty() {
            let smaller = self.choose_page_side(limit);
            if smaller != self.page_side {
                self.page_side = smaller;
                pbytes = self.page_bytes();
                pages = (limit / pbytes).min(1024);
            }
        }
        self.tiles.set_max_slots(pages * self.per_page() as usize);
    }

    /// Room remaining under `self.budget` for `self.readers` allocations.
    fn reader_budget_room(&self) -> usize {
        self.budget
            .saturating_sub(self.bytes() - self.readers.bytes() + self.readbacks.bytes.get())
    }

    /// The page and position of a slot, making its page (within the budget `fit_tiles` set).
    fn slot_place(&mut self, slot: u32) -> Result<(usize, u32, u32)> {
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
        for other in 0..self.scratches.len() {
            if self.reserve(bytes, freed, "the scratch tile").is_ok() {
                break;
            }
            if other != slot
                && let Some(old) = self.scratches[other].take()
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
        let plan = glass::plan_glass_masks(store, frame, self.max_texture_2d, atlas_room);
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

    /// Whether a frame needing `plan`'s coarse tiers can instead draw its whole padded view at
    /// device resolution (exact): the padded view fits the texture limit, `max_pixels`
    /// (`Limits::padded_view_pixels`) and the GPU budget, and no layer-blur scope needs the far
    /// tier.
    pub fn padded_whole_fits(&self, plan: &ViewportHaloPlan, size: (u32, u32), max_pixels: usize) -> bool {
        if !plan.coarse_post_scopes.is_empty() {
            return false;
        }
        let b = plan.samples;
        let x = b.x0.unsigned_abs().next_multiple_of(4);
        let y = b.y0.unsigned_abs().next_multiple_of(4);
        let w = (b.x1 as u32).saturating_add(x);
        let h = (b.y1 as u32).saturating_add(y);
        let pixels = (w as usize).saturating_mul(h as usize);
        let max_tex = self.max_texture_2d.min(u32::from(u16::MAX));
        if w > max_tex || h > max_tex || pixels > max_pixels {
            return false;
        }
        let scratch_bytes = self.scratches[1]
            .as_ref()
            .map_or(0, |s| s.width as usize * s.height as usize * 8);
        self.check_frame(
            self.next_frame(),
            size.0,
            size.1,
            pixels.saturating_mul(24),
            scratch_bytes.saturating_add(self.readers.bytes()),
        )
        .is_ok()
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
    ) -> Result<DrawStats> {
        self.abort_pending_tile();
        self.opening_pending = false;
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
            .is_some_and(|p| p.use_coarse_halo && !self.padded_whole_fits(p, size, store.limits.padded_view_pixels));
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

    /// Runs one supersampled reduced-resolution replay tier and captures eligible reader outputs.
    #[allow(clippy::too_many_arguments)]
    fn run_halo_tier(
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
    ) -> Result<(DrawStats, i32)> {
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
        let result = self.draw_whole_pass(store, &coarse, background, generation, false, None, None);
        self.swap_halo_reader_planes(is_far);
        result.map(|stats| (stats, render_divisor))
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
    #[allow(clippy::too_many_arguments)]
    fn render_reader_halo(
        &mut self,
        store: &Store,
        frame: &Frame,
        background: [f32; 4],
        generation: u64,
        moving: bool,
        plan: &ViewportHaloPlan,
    ) -> Result<DrawStats> {
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
        let t0 = now();
        let lowest_div = plan.mid_divisor.unwrap_or(plan.far_divisor);
        let far_prog_cut = halo::progressive_cutover_sigma(plan.far_divisor);
        let far_unif_cut = halo::uniform_cutover_sigma(plan.far_divisor);
        self.reader_halo = Some(ReaderHalo {
            capture: None,
            strip_capture: None,
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
        let mut replay = DrawStats::default();
        let far_max_render_divisor = plan.coarse_post_min_sigma.is_finite().then(|| {
            (plan.coarse_post_min_sigma / halo::HALO_MIN_COARSE_SIGMA)
                .floor()
                .max(1.0) as i32
        });
        let mut tier_result = self.run_halo_tier(
            store,
            frame,
            background,
            generation,
            plan.samples,
            plan.far_divisor,
            far_capture_bounds,
            (far_prog_cut, f32::INFINITY),
            (far_unif_cut, f32::INFINITY),
            true,
            plan.far_has_blur,
            plan.far_min_feature_px,
            far_max_render_divisor,
            &plan.clamp_clips,
        );
        if let Ok((far_stats, far_render_div)) = &tier_result {
            accumulate(&mut replay, far_stats);
            let far_rd = *far_render_div;
            if let (Some(mid_samples), Some(mid_div)) = (plan.mid_samples, plan.mid_divisor) {
                let mid_prog_cut = halo::progressive_cutover_sigma(mid_div);
                let mid_unif_cut = halo::uniform_cutover_sigma(mid_div);
                tier_result = self.run_halo_tier(
                    store,
                    frame,
                    background,
                    generation,
                    mid_samples,
                    mid_div,
                    plan.capture_bounds,
                    (mid_prog_cut, far_prog_cut),
                    (mid_unif_cut, far_unif_cut),
                    false,
                    true,
                    plan.mid_min_feature_px,
                    Some(far_rd),
                    &plan.clamp_clips,
                );
                if let Ok((mid_stats, _)) = &tier_result {
                    accumulate(&mut replay, mid_stats);
                }
            }
        }
        let result = tier_result.and_then(|_| {
            self.reader_halo.as_mut().expect("reader halo").capture = None;
            let native = (native != frame.area).then_some(native);
            let mut stats = self.draw_whole_pass(store, frame, background, generation, moving, None, native)?;
            accumulate(&mut stats, &replay);
            stats.cpu_ms = now() - t0;
            Ok(stats)
        });
        let halo = self.reader_halo.take().expect("reader halo");
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
        self.release_oversized_halo_storage();
        self.trim_pools(GPU_POOL_KEEP_BYTES);
        self.readers.flush_retired();
        if result.is_ok() {
            self.whole_samples = Some(Some(plan.samples));
        }
        result
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
        self.flush_preserving_clips(open, true)?;
        let Some(active) = self.active.as_ref() else {
            return Ok(true);
        };
        let (base, interiors) = exec::reader_backdrop_layers(&self.offscreen_stack, false, |scope| scope.isolation);
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
        let budget = self.reader_budget_room();
        self.readers.ensure_blur_out_budgeted(&self.device, bw, bh, budget)?;
        let blur_sigma = tier.map_or(sigma, |t| halo::compensate_halo_sigma(sigma, t.render_divisor));
        let clip_info = draw.halo_clip_bounds(tier, within, blur_sigma);
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
        let scale = view.as_coeffs()[0];
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
            return self.finish_frame(self.cur.expect("unchanged frame"), stats, t0, submits0, None);
        }
        let dst = self.next_frame();
        let padded = if let Some(bounds) = samples {
            // Keep the same strip phase at the original viewport origin.
            let x = bounds.x0.unsigned_abs().next_multiple_of(4);
            let y = bounds.y0.unsigned_abs().next_multiple_of(4);
            let size = (
                (bounds.x1 as u32).saturating_add(x),
                (bounds.y1 as u32).saturating_add(y),
            );
            // In addition to colour/depth scratch, the padded view must have room
            // for its backdrop plane. Do not begin a frame that cannot hold both.
            let pixels = (size.0 as usize).saturating_mul(size.1 as usize);
            if self.fallback_adapter && pixels > SOFTWARE_PADDED_PIXELS.max(width as usize * height as usize) {
                return Err(EngineError::limit(
                    "viewport readers exceed the software GPU raster budget",
                ));
            }
            let scratch_bytes = self.scratches[1]
                .as_ref()
                .map_or(0, |s| s.width as usize * s.height as usize * 8);
            self.check_texture_size(size.0, size.1, "a padded view")?;
            self.check_frame(
                dst,
                width,
                height,
                pixels.saturating_mul(12),
                scratch_bytes.saturating_add(self.readers.bytes()),
            )?;
            Some(((x, y), size))
        } else {
            None
        };
        if !capturing {
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
        self.backdrop_gen += 1;
        if !capturing {
            self.begin_frame_timestamp();
        }
        self.active = Some(ActiveDraw::new(
            (padded.is_none() && !capturing).then_some(dst),
            padded.map(|((x, y), _)| IRect {
                x0: x as i32,
                y0: y as i32,
                x1: (x + width) as i32,
                y1: (y + height) as i32,
            }),
            w,
            h,
            background,
            moving,
        ));
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
        let draw = split.and_then(|split| {
            exec::draw_split(
                store,
                self,
                &whole,
                &limits,
                &mut verbs,
                &split.unwrap_or_else(Split::all),
                moving && self.reader_halo.is_none(),
            )
        });
        let s = match draw {
            Ok(s) => s,
            Err(e) => {
                self.forget_motion_prefix();
                self.discard_draw();
                return Err(e);
            }
        };
        stats.add(&s);
        if let Err(e) = self.flush_scene_gpu(true) {
            self.discard_draw();
            return Err(e);
        }
        if let Some((start, _)) = padded {
            let mut encoder = self.take_encoder("crop padded frame");
            let source = &self.scratches[self.active_scratch]
                .as_ref()
                .expect("padded frame")
                .texture;
            copy_rect(
                &mut encoder,
                source,
                &self.frames[dst].texture,
                start,
                (0, 0),
                (width, height),
            );
            self.stash_encoder(encoder);
        }
        self.submit_active_encoder();
        let active = self.active.take().expect("active draw");
        self.recycle_scene_textures();
        active.record_into(&mut stats, now() - t0);
        if capturing {
            stats.submits = self.submits.saturating_sub(submits0);
            self.scene.reset();
            return Ok(stats);
        }
        stats.exact = self.reader_halo.is_none() && !moving && s.exact();
        stats.standin = !stats.exact;
        if self.reader_halo.is_some() {
            stats.plan = 4;
        }
        stats.held = self.tiles.len() as u32;
        stats.evicted = self.tiles.stats.evicted;
        let stats = self.finish_frame(dst, stats, t0, submits0, None)?;
        self.cur = Some(dst);
        self.set_cur_page(true);
        self.last = Some(Last {
            view,
            size: (width, height),
        });
        self.last_scale = Some(scale);
        self.whole_samples = (padded.is_some() == samples.is_some()).then_some(samples);
        self.whole_reader_halo = self.reader_halo.is_some() && !moving;
        self.shown = Some((generation, bg_bits, stats.exact));
        Ok(stats)
    }

    /// Presents the last frame warped to `view` (or the background) when a budgeted moving frame
    /// hits a limit: a composite of one quad, never a whole-view replay. `cur` and `last` keep the
    /// sharp frame it was warped from, so the next frame warps from that again; a read-back shows
    /// this one (`standin_frame`).
    #[allow(clippy::too_many_arguments)]
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
            self.set_cur_page(true);
        } else {
            self.standin_frame = Some(dst);
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
    ) -> Result<DrawStats> {
        self.check()?;
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
        if self
            .pending_tile
            .as_ref()
            .is_some_and(|pt| pt.generation != generation || pt.bg_bits != bg_bits)
        {
            self.abort_pending_tile();
        }
        let view = frame.view;
        let scale = view.as_coeffs()[0];
        self.tiles.begin_scaled(background, scale, halo);
        self.fit_tiles(store.limits.tile_bytes);
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
            // No off-screen prefetch while tiles carry a wide apron: each costs many tiles.
            options.prefetch && !coarse_moving && !opening && i64::from(halo) <= i64::from(store.limits.halo),
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
            && plan.jobs.is_empty()
            && selection.is_none()
            && last.is_some_and(|l| l.view == view && l.size == (w, h))
            && self.shown == Some((generation, bg_bits, true));
        if same {
            stats.exact = true;
            stats.plan = 3;
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
        // Drop a paused tile only when it no longer matches any desired job for this camera/halo
        // (and never drop it during a composite-only present call).
        if !composite_only
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
        let mut budget_hit = false;
        let mut unfinished_must = false;
        if !composite_only {
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
                if pt_deadline.is_some_and(|d| now() >= d) {
                    budget_hit = true;
                    stats.in_progress = true;
                    if pt_must {
                        self.tiles.mark_unpainted(key);
                        unfinished_must = true;
                    }
                } else {
                    self.deadline_ms = pt_deadline;
                    let step = self.resume_pending_tile(store, &mut stats);
                    self.deadline_ms = None;
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
                if resumed_key == Some(job.key) {
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
                let job_deadline = if job.must && !enforce_must { None } else { deadline };
                let over_budget = if job.must {
                    enforce_must && (budget_hit || deadline.is_some_and(|d| now() >= d))
                } else {
                    budget_hit || deadline.is_some_and(|d| now() >= d)
                };
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
                    continue;
                }
                if job.direct {
                    late.push(*job);
                    continue;
                }
                let elapsed = now() - t0;
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
                        bg_bits,
                        generation,
                        &mut stats,
                        &mut verbs,
                    );
                    self.deadline_ms = None;
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
                            let reduced_before = stats.reduced;
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
        } else {
            // Composite-only presentation: keep any paused tile intact and note remaining work.
            if self.pending_tile.is_some() {
                stats.in_progress = true;
            }
            for job in &plan.jobs {
                if job.must {
                    unfinished_must = true;
                } else {
                    stats.queued += 1;
                }
            }
        }
        if opening && !unfinished_must && self.pending_tile.is_none() {
            self.opening_pending = false;
        }
        let t1 = now();
        let mut present_encoder = None;
        if plan.direct {
            stats.plan = 2;
        } else {
            // What's drawn straight into the frame after it covers its tile there: the composite
            // counts it so (what no slot could be found for included).
            // A frame shows a reduced effect when a visible tile holds one, whenever it was drawn.
            stats.reduced = stats.reduced.max(comp.reduced);
            if self.pending_tile.is_some() && !late.is_empty() {
                // Direct tiles share scratch too. Present their stand-ins until the checkpoint
                // completes, rather than throwing away its progress to draw them this frame.
                unfinished_must = true;
                late.clear();
            }
            for job in &mut plan.jobs {
                job.direct = late.iter().any(|l| l.key == job.key);
            }
            let comp = self.tiles.compose(&plan, plan_last);
            stats.exact = comp.exact;
            stats.pending = comp.pending;
            stats.plan = if comp.complete && !self.opening_pending && !unfinished_must {
                0
            } else {
                1
            };
            let fuse_present = late.is_empty() && selection.is_none();
            present_encoder = self.composite(&comp, dst, background, w, h, !fuse_present, &mut stats)?;
            stats.render_ms += now() - t1;
            for job in &late {
                let tile_detail = job.detail || coarse_moving;
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
        stats.pending = stats.pending.max(u32::from(self.opening_pending || unfinished_must));
        stats.exact = (plan.direct || stats.exact) && direct_exact && stats.pending == 0;
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
        self.shown = Some((generation, bg_bits, stats.exact));
        Ok(stats)
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
        budget_ms: f64,
    ) -> Result<DrawStats> {
        self.check()?;
        let mut stats = DrawStats::default();
        let Some(last) = self.last else {
            return Ok(stats);
        };
        let bg_bits = background.map(f32::to_bits);
        if self
            .pending_tile
            .as_ref()
            .is_some_and(|pt| pt.generation != generation || pt.bg_bits != bg_bits || pt.halo != halo)
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
        self.fit_tiles(store.limits.tile_bytes);
        let opening = self.opening_pending;
        self.tiles.opening = opening;
        let plan_last = if opening { None } else { Some(last) };
        let Some(plan) = self.tiles.plan(
            last.view,
            last.size,
            opening,
            plan_last,
            !opening && i64::from(halo) <= i64::from(store.limits.halo),
            false,
        ) else {
            return Ok(stats);
        };
        let budgeted = budget_ms > 0.0;
        let walk_budget = self.walk_budget_ms(budget_ms);
        let deadline = budgeted.then_some(t0 + walk_budget);
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
            self.deadline_ms = deadline;
            let step = self.resume_pending_tile(store, &mut stats);
            self.deadline_ms = None;
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
                if deadline.is_some_and(|d| now() >= d) {
                    break;
                }
                self.deadline_ms = deadline;
                let step = self.start_slot_tile(
                    store, job, job.detail, halo, background, bg_bits, generation, &mut stats, &mut verbs,
                );
                self.deadline_ms = None;
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
        self.standin_frame = None;
        self.configure_surface(frame)?;
        let acquired = match self.acquire() {
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
        // A frame read back (no canvas) needs no presenting.
        stats.presented = self.surface.is_none() || acquired.is_some();
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
        // Only tiles that actually overlap a backdrop reader (or carry export context) need the
        // haloed scratch size. Non-reader tiles produce bit-identical pixels at `TILE` and never
        // allocate reader backdrop targets; reader tiles in an exact frame keep uniform `halo`
        // (including ladder prefetch tiles) so reader frame targets never reallocate mid-frame.
        let tile_halo = if halo <= 0
            || (!store.has_context()
                && !store.has_reader_in_rect(
                    view,
                    Rect::new(-2.0, -2.0, f64::from(TILE) + 2.0, f64::from(TILE) + 2.0),
                )) {
            0
        } else {
            halo
        };
        let h = tile_halo as u32;
        let side = TILE + 2 * h;
        // Every tile renders into the active scratch slot (ensured before walking so mid-tile
        // reader flushes can target it directly).
        self.ensure_scratch(side)?;
        // Each tile is its own render and submission: masks the tiles before it drew from may go
        // now, and its run images pack from the atlas's top left again (the draws before run
        // before any upload made after them).
        self.masks.begin_frame();
        self.atlas.at = (0, 0, 0);
        self.scene.reset_and_resize(side as u16, side as u16);
        self.readers.begin_frame();
        self.blur.begin_frame();
        self.shadow.begin_frame();
        self.backdrop_gen += 1;
        self.active = Some(ActiveDraw::new(None, None, side, side, background, coarse_readers));
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
                Some((p, x, y)) => Some((Some(p), (h, h), (x, y), (TILE, TILE))),
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
                            None,
                            (h + (x0 - fx) as u32, h + (y0 - fy) as u32),
                            (x0 as u32, y0 as u32),
                            ((x1 - x0) as u32, (y1 - y0) as u32),
                        ))
                    }
                }
            }
        };

        if let Err(e) = self.flush_scene_gpu(true) {
            self.discard_draw();
            return Err(e);
        }
        if let Some((page, src_origin, dst_origin, size)) = copy_info {
            let mut encoder = self.take_encoder("tile copy");
            let scratch = self.scratches[self.active_scratch].as_ref().expect("scratch");
            let destination = match page {
                Some(page) => &self.pages[page].texture,
                None => &self.frames[dst].texture,
            };
            copy_rect(
                &mut encoder,
                &scratch.texture,
                destination,
                src_origin,
                dst_origin,
                size,
            );
            self.stash_encoder(encoder);
        }
        self.submit_active_encoder();
        let active = self.active.take().expect("active draw");
        self.recycle_scene_textures();
        self.trim_pools(GPU_POOL_KEEP_BYTES);
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
        bg_bits: [u32; 4],
        generation: u64,
        stats: &mut DrawStats,
        verbs: &mut usize,
    ) -> Result<TileStep> {
        debug_assert!(self.pending_tile.is_none(), "paused tile still owns scratch");
        let t0 = now();
        *verbs = store.limits.frame_verbs;
        let tile_halo = if halo <= 0
            || (!store.has_context()
                && !store.has_reader_in_rect(
                    job.view,
                    Rect::new(-2.0, -2.0, f64::from(TILE) + 2.0, f64::from(TILE) + 2.0),
                )) {
            0
        } else {
            halo
        };
        let h = tile_halo as u32;
        let side = TILE + 2 * h;
        self.ensure_scratch(side)?;
        self.masks.begin_frame();
        self.atlas.at = (0, 0, 0);
        self.scene.reset_and_resize(side as u16, side as u16);
        self.readers.begin_frame();
        self.blur.begin_frame();
        self.shadow.begin_frame();
        self.backdrop_gen += 1;
        self.active = Some(ActiveDraw::new(None, None, side, side, background, coarse_readers));
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
        if !coarse_readers
            && tile_halo > 0
            && let Err(e) = self.prepare_glass_masks(store, &tile)
        {
            self.discard_draw();
            return Err(e);
        }
        let limits = store.limits;
        let allow_yield = self.deadline_ms.is_some();
        let outcome = match exec::draw_split_resumable(
            store,
            self,
            &tile,
            &limits,
            verbs,
            &Split::all(),
            coarse_readers,
            None,
            allow_yield,
        ) {
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
            coarse_readers,
            halo,
            tile_halo,
            side,
            background,
            bg_bits,
            generation,
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
        self.active_scratch = pt.active_scratch;
        self.backdrop_gen = pt.backdrop_gen;
        self.active = Some(pt.active);
        self.masks.begin_frame();
        self.readers.begin_frame();
        self.atlas.at = (0, 0, 0);
        self.scene.reset_and_resize(pt.side as u16, pt.side as u16);
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
        let outcome = match exec::draw_split_resumable(
            store,
            self,
            &tile,
            &limits,
            &mut pt.verbs,
            &Split::all(),
            pt.coarse_readers,
            Some(pt.checkpoint),
            allow_yield,
        ) {
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
            pt.coarse_readers,
            pt.halo,
            pt.tile_halo,
            pt.side,
            pt.background,
            pt.bg_bits,
            pt.generation,
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
        coarse_readers: bool,
        halo: i32,
        tile_halo: i32,
        side: u32,
        background: [f32; 4],
        bg_bits: [u32; 4],
        generation: u64,
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
                let sub0 = stats.submit_ms;
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
                self.update_submit_ratio(slice_total, stats.submit_ms - sub0);
                self.pending_tile = Some(PendingTile {
                    key,
                    view,
                    detail,
                    coarse_readers,
                    halo,
                    tile_halo,
                    side,
                    background,
                    bg_bits,
                    generation,
                let exact = total.exact();
                let reduced = total.reduced > 0;
                    active_scratch: self.active_scratch,
                    active,
                    checkpoint,
                    verbs,
                    backdrop_gen: self.backdrop_gen,
                });
                Ok(TileStep::Paused)
            }
            exec::WalkOutcome::Complete {
                stats: slice_stats,
                total,
            } => {
                stats.add(&slice_stats);
                let sub0 = stats.submit_ms;
                let h = tile_halo as u32;
                let slot = self.tiles.slot_for(key);
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
                if let Err(e) = self.flush_scene_gpu(true) {
                    if let Some((s, _)) = place {
                        self.tiles.release(key, s);
                    }
                    self.discard_draw();
                    self.readers.drop_glass_mask_atlas();
                    return Err(e);
                }
                if let Some((_, (page, x, y))) = place {
                    let mut encoder = self.take_encoder("tile copy");
                    let scratch = self.scratches[self.active_scratch].as_ref().expect("scratch");
                    copy_rect(
                        &mut encoder,
                        &scratch.texture,
                        &self.pages[page].texture,
                        (h, h),
                        (x, y),
                        (TILE, TILE),
                    );
                    self.stash_encoder(encoder);
                }
                self.submit_active_encoder();
                let active = self.active.take().expect("active draw");
                self.recycle_scene_textures();
                self.readers.drop_glass_mask_atlas();
                self.readers.flush_retired();
                self.trim_pools(GPU_POOL_KEEP_BYTES);
                let slice_total = now() - t0;
                active.record_into(stats, slice_total);
                self.update_submit_ratio(slice_total, stats.submit_ms - sub0);
                if let Some((s, _)) = place {
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

    /// Flushes the scene into the active scope, rasterizing a segment once when both planes
    /// need it. The delta and both depth targets match the local scope's allocation.
    fn flush_scene_gpu(&mut self, force_clear: bool) -> Result<()> {
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
        }

        if draw {
            let (target, color, color_id, depth) = self.plane(!write_main)?;
            let depth = depth.clone();
            let (width, height) = (target.width(), target.height());
            let (color, color_id) = if dual {
                let max_bytes = self.reader_budget_room();
                self.readers
                    .ensure_frame_tex_budgeted(false, &self.device, width, height, "scene delta", max_bytes)?;
                options.target_init = TargetInit::Clear(ClearSettings::Viewport {
                    color: AlphaColor::TRANSPARENT,
                });
                let delta = self.readers.delta_frame.as_ref().expect("scene delta");
                (delta.view.clone(), delta.view_id)
            } else {
                (color.clone(), color_id)
            };
            self.vello_render(false, &color, Some(&depth), options, "scene flush")?;
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
                        (0, 0),
                        scissor,
                        1.0,
                    );
                } else {
                    // Reused offscreen planes can have different allocation sizes even
                    // though they share an active viewport. A pass requires matching extents.
                    for view in [&main, &backdrop] {
                        self.readers.encode_composite(
                            &self.device,
                            &mut encoder,
                            &color,
                            color_id,
                            CompositeTarget::Over(view),
                            (0, 0),
                            scissor,
                            1.0,
                        );
                    }
                }
                self.stash_encoder(encoder);
            }
        }
        let active = self.active.as_mut().expect("active draw");
        active.needs_clear &= !needs_clear;
        active.scene_dirty = false;
        let sub = active.submit_ms - sub0;
        active.vello_render_ms += (now() - t0 - sub).max(0.0);
        if needs_clear || (draw && (write_backdrop || (!active.backdrop_live && root))) {
            self.backdrop_gen += 1;
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
        let result = self.flush_scene_gpu(force_clear);
        self.scene.reset();
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
        let (base, interiors) = exec::reader_backdrop_layers(&self.offscreen_stack, false, |scope| scope.isolation);
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
            targets,
        }))
    }

    fn encode_blur_reader_masks(
        &mut self,
        draw: &BlurReaderDraw,
        paths: &[(BezPath, bool)],
        device: Affine,
        analytic: bool,
        open: &[Open],
    ) -> Result<(wgpu::CommandEncoder, bool)> {
        let (w, h) = draw.dirty_size();
        let mut options = RenderOptions::default();
        options.target_init = TargetInit::Clear(ClearSettings::Viewport {
            color: AlphaColor::TRANSPARENT,
        });
        let clipped = open_clips_need_mask(open, draw.dirty, true);
        if clipped {
            let budget = self.reader_budget_room();
            self.readers.ensure_vello_tex_budgeted(
                true,
                &self.device,
                &self.renderer,
                w,
                h,
                "blur reader clip",
                budget,
            )?;
            self.mask_scene.reset_and_resize(w as u16, h as u16);
            let shift = Affine::translate((-f64::from(draw.dirty.x0), -f64::from(draw.dirty.y0)));
            raster_clips(&mut self.mask_scene, open, shift, (w, h), true);
            let (clip_view, clip_depth) = {
                let clip = self.readers.clip_tex.as_ref().expect("blur reader clip");
                (clip.view.clone(), clip.depth.clone())
            };
            let t_vr = now();
            let sub0 = self.active.as_ref().map_or(0.0, |a| a.submit_ms);
            self.vello_render(true, &clip_view, Some(&clip_depth), options, "blur reader clip")?;
            if let Some(a) = self.active.as_mut() {
                a.vello_render_ms += (now() - t_vr - (a.submit_ms - sub0)).max(0.0);
            }
        }
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
        Ok((encoder, clipped))
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
        let write_main = content.isolation.on_main;
        let write_backdrop =
            content.isolation.on_backdrop && (!root || active.backdrop_live) && !(write_main && shared_parent);
        if !write_main && !write_backdrop {
            return Ok(());
        }
        let t0 = now();
        let (sub0, vr0) = self
            .active
            .as_ref()
            .map_or((0.0, 0.0), |a| (a.submit_ms, a.vello_render_ms));
        let dst_origin = (sx - parent.x0, sy - parent.y0);
        let src_offset = ((visible.x0 - sx) as u32, (visible.y0 - sy) as u32);
        let dst_offset = ((visible.x0 - parent.x0) as u32, (visible.y0 - parent.y0) as u32);
        let size = ((visible.x1 - visible.x0) as u32, (visible.y1 - visible.y0) as u32);
        let scissor = (dst_offset.0, dst_offset.1, size.0, size.1);
        let mut clips = active_clips(open, false).peekable();
        let lerp = blend == crate::blend::BLEND_LERP;
        // Keep the same compositing arithmetic when a clip is present, including
        // UNORM rounding for normal and lerp modes. Only skip rasterizing its mask.
        let shader = clips.peek().is_some() || picture.is_some() || (blend != 0 && !lerp);
        let visible_in_parent = IRect {
            x0: dst_offset.0 as i32,
            y0: dst_offset.1 as i32,
            x1: (dst_offset.0 + size.0) as i32,
            y1: (dst_offset.1 + size.1) as i32,
        };
        let clipped = clips.any(|(path, transform, even_odd)| {
            !crate::geometry::path_covers_rect(path, transform, even_odd, visible_in_parent)
        });
        let (aw, ah) = (u32::from(src.active_size.0), u32::from(src.active_size.1));
        if shader {
            self.ensure_scratch_backdrop(aw, ah)?;
            if clipped {
                self.ensure_scratch_mask(aw, ah)?;
            }
            let bytes = self.blend.pending_allocation();
            if bytes > 0 {
                self.reserve_or_trim(bytes, 0, "blend uniforms")?;
                self.blend.ensure_slab(&self.device);
            }
            if !self.blend.has_slots(u32::from(write_main) + u32::from(write_backdrop)) {
                self.submit_active_encoder();
            }
        }
        if clipped {
            self.mask_scene.reset_and_resize(aw as u16, ah as u16);
            let shift = Affine::translate((-f64::from(dst_origin.0), -f64::from(dst_origin.1)));
            raster_clips(&mut self.mask_scene, open, shift, (aw, ah), false);
            let (mask_view, mask_depth) = {
                let mask = self.scratch_mask.as_ref().expect("composite clip mask");
                (mask.view.clone(), mask.depth.clone())
            };
            let mut options = RenderOptions::default();
            options.target_init = TargetInit::Clear(ClearSettings::Viewport {
                color: AlphaColor::TRANSPARENT,
            });
            let t_vr = now();
            let vr_sub0 = self.active.as_ref().map_or(0.0, |a| a.submit_ms);
            self.vello_render(true, &mask_view, Some(&mask_depth), options, "scope composite")?;
            if let Some(a) = self.active.as_mut() {
                a.vello_render_ms += (now() - t_vr - (a.submit_ms - vr_sub0)).max(0.0);
            }
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
                let clip = clipped.then(|| {
                    let m = self.scratch_mask.as_ref().expect("composite clip mask");
                    (&m.view, m.view_id)
                });
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
                    clip,
                    picture,
                    &dst_view,
                    dst_origin,
                    scissor,
                    blend,
                    opacity,
                );
            } else {
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
                    dst_origin,
                    scissor,
                    opacity,
                );
            }
        }
        self.stash_encoder(encoder);
        if write_backdrop || (write_main && root && !self.active.as_ref().expect("active draw").backdrop_live) {
            self.backdrop_gen += 1;
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
        let size: [f32; 4] = [plan.size.0 as f32, plan.size.1 as f32, 0.0, 0.0];
        let ub: Vec<u8> = size.iter().flat_map(|v| v.to_le_bytes()).collect();
        if let Some(c) = self.compositor.as_ref() {
            self.queue.write_buffer(&c.uniforms, 0, &ub);
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
            .as_ref()
            .ok_or_else(|| EngineError::new(ErrorCode::State, "no compositor"))?;
        let bytes: Vec<u8> = quads
            .iter()
            .flat_map(|q| q.iter().flat_map(|v| v.to_le_bytes()))
            .collect();
        self.queue.write_buffer(&c.instances, 0, &bytes);
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
    /// background, the last frame moved and scaled, and other levels' tiles scaled; then the
    /// frame's tiles, pixel for pixel. When `submit` is false, returns the open encoder so
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
            // Quads by source texture: the last frame first, then pages, in the order given.
            let mut quads: Vec<(Option<usize>, [f32; 12])> = Vec::new();
            if let Some(m) = comp.base
                && let Some(l) = self.last
                && self
                    .current()
                    .is_ok_and(|f| f.width == l.size.0 && f.height == l.size.1)
            {
                let (lw, lh) = (f64::from(l.size.0), f64::from(l.size.1));
                let d = m.transform_rect_bbox(Rect::new(0.0, 0.0, lw, lh));
                quads.push((
                    None,
                    [
                        d.x0 as f32,
                        d.y0 as f32,
                        d.x1 as f32,
                        d.y1 as f32,
                        0.0,
                        0.0,
                        1.0,
                        1.0,
                        (0.5 / lw) as f32,
                        (0.5 / lh) as f32,
                        (1.0 - 0.5 / lw) as f32,
                        (1.0 - 0.5 / lh) as f32,
                    ],
                ));
            }
            for sc in &comp.scaled {
                let page = (sc.slot / per_page) as usize;
                if page >= self.pages.len() {
                    continue;
                }
                let within = sc.slot % per_page;
                let (x, y) = (
                    f64::from((within % per_row) * TILE),
                    f64::from((within / per_row) * TILE),
                );
                let (p, t) = (f64::from(page_side), f64::from(TILE));
                let d = sc.dst;
                quads.push((
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
                ));
            }
            let c = self
                .compositor
                .as_mut()
                .ok_or_else(|| EngineError::new(ErrorCode::State, "no compositor"))?;
            let bytes: Vec<u8> = quads
                .iter()
                .flat_map(|(_, q)| q.iter().flat_map(|v| v.to_le_bytes()))
                .collect();
            if quads.len() > c.capacity {
                let capacity = quads.len().next_power_of_two();
                c.instances.destroy();
                c.instances = self.device.create_buffer(&wgpu::BufferDescriptor {
                    label: Some("composite quads"),
                    size: (capacity * 48) as u64,
                    usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
                    mapped_at_creation: false,
                });
                c.capacity = capacity;
            }
            if !bytes.is_empty() {
                self.queue.write_buffer(&c.instances, 0, &bytes);
            }
            if c.uniform_size != (w, h) {
                let size: [f32; 4] = [w as f32, h as f32, 0.0, 0.0];
                let ub: Vec<u8> = size.iter().flat_map(|v| v.to_le_bytes()).collect();
                self.queue.write_buffer(&c.uniforms, 0, &ub);
                c.uniform_size = (w, h);
            }
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
                        let page = &mut self.pages[p];
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
                    Some(p) => self.pages[p].composite_group.as_ref().expect("composite page bg"),
                };
                pass.set_bind_group(0, group, &[]);
                pass.draw(0..4, from..to);
            }
            stats.draws += runs.len() as u32;
        }
        for cp in &comp.copies {
            let page = (cp.slot / per_page) as usize;
            let Some(pg) = self.pages.get(page) else {
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
        let main = match self.standin_frame {
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
    type Scene = Scene;

    fn scene(&mut self) -> &mut Scene {
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

    fn begin_readers(&mut self, needs_backdrop: bool, has_context: bool) -> Result<()> {
        let Some(active) = self.active.as_ref() else {
            return Ok(());
        };
        let (aw, ah) = (active.width, active.height);
        let bg = active.background;
        if needs_backdrop {
            let max_bytes = self.reader_budget_room();
            self.readers
                .ensure_frame_tex_budgeted(true, &self.device, aw, ah, "backdrop tile", max_bytes)?;
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
                self.backdrop_gen += 1;
                if let Some(act) = self.active.as_mut() {
                    act.needs_clear = false;
                    act.backdrop_live = true;
                }
            }
        }
        Ok(())
    }

    fn snapshot_backdrop(&mut self, open: &[Open]) -> Result<()> {
        self.flush_preserving_clips(open, true)?;
        let Some(active) = self.active.as_ref() else {
            return Ok(());
        };
        let (aw, ah) = (active.width, active.height);
        let max_bytes = self.reader_budget_room();
        self.readers
            .ensure_frame_tex_budgeted(true, &self.device, aw, ah, "backdrop tile", max_bytes)?;
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
        self.backdrop_gen += 1;
        if let Some(a) = self.active.as_mut() {
            a.backdrop_live = true;
        }
        Ok(())
    }

    fn stop_early(&self) -> bool {
        self.reader_halo
            .as_ref()
            .and_then(|h| h.strip_capture.as_ref())
            .is_some_and(|s| s.captured.is_some())
    }

    fn deadline_reached(&self) -> bool {
        self.deadline_ms.is_some_and(|d| now() >= d)
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
        if open.iter().any(|o| matches!(o, Open::Layer)) {
            return Err(EngineError::unsupported(
                "a backdrop reader inside a layer that fades as one",
            ));
        }
        if self.reader_halo.as_ref().is_some_and(|h| h.strip_capture.is_some()) {
            // Glass never writes to the glass-free backdrop (rule b*), so edge strips skip it.
            return Ok(());
        }
        self.flush_preserving_clips(open, true)?;
        let Some(active) = self.active.as_ref() else {
            return Ok(());
        };
        let t_reader = now();
        let sub0 = active.submit_ms;
        let vr0 = active.vello_render_ms;
        let (aw, ah) = (active.width, active.height);
        let frame_size = (aw as i32, ah as i32);
        // A lens on an explicitly blended layer reads from its parent. A child lens
        // inherits that prefix with any preceding glass-free paint from the blend scope.
        let (base, interiors) =
            exec::reader_backdrop_layers(&self.offscreen_stack, read_parent, |scope| scope.isolation);
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
        // Root glass writes only to the displayed plane. Inside an isolate,
        // keep its effect halo because a later filter can read those pixels.
        let output = active
            .display_area
            .filter(|_| self.offscreen_stack.is_empty())
            .unwrap_or_else(|| self.target_bounds());
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

        let any_clip = divisor > 1
            || open.iter().any(|o| {
                matches!(
                    o,
                    Open::Clip {
                        active_on_scene: true,
                        context_only: false,
                        ..
                    }
                )
            });
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
            let out_w = (region.out_x1 - region.out_x0) as u32;
            let out_h = (region.out_y1 - region.out_y0) as u32;
            if out_w == 0 || out_h == 0 {
                continue;
            }
            let has_clip_mask = divisor > 1
                || (any_clip
                    && open_clips_need_mask(
                        open,
                        IRect {
                            x0: region.out_x0,
                            y0: region.out_y0,
                            x1: region.out_x1,
                            y1: region.out_y1,
                        },
                        true,
                    ));
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
            let max_bytes = self.reader_budget_room();

            // 1. Optional open non-context clip mask (rasterized with vello_gpu into `clip_tex`).
            if has_clip_mask {
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
                // Open scene transforms and the output rectangle are both scope-local.
                let shift = Affine::translate((-f64::from(region.out_x0), -f64::from(region.out_y0)));
                if divisor > 1 {
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
                    self.mask_scene.set_transform(
                        shift * Affine::translate((-f64::from(origin.0), -f64::from(origin.1))) * device,
                    );
                    self.mask_scene.set_paint(vello_common::color::palette::css::WHITE);
                    for (p, even_odd) in paths {
                        self.mask_scene
                            .set_fill_rule(if *even_odd { Fill::EvenOdd } else { Fill::NonZero });
                        self.mask_scene.fill_path(p);
                    }
                    for _ in 0..depth {
                        self.mask_scene.pop_clip();
                    }
                } else {
                    raster_clips(&mut self.mask_scene, open, shift, (out_w, out_h), true);
                }
                let mut options = RenderOptions::default();
                options.target_init = TargetInit::Clear(ClearSettings::Viewport {
                    color: vello_common::color::AlphaColor::TRANSPARENT,
                });
                let (clip_view, clip_depth) = {
                    let clip_t = self.readers.clip_tex.as_ref().expect("clip");
                    (clip_t.view.clone(), clip_t.depth.clone())
                };
                let t_vr = now();
                let vr_sub0 = self.active.as_ref().map_or(0.0, |a| a.submit_ms);
                self.vello_render(true, &clip_view, Some(&clip_depth), options, "reader clip")?;
                if let Some(a) = self.active.as_mut() {
                    a.vello_render_ms += (now() - t_vr - (a.submit_ms - vr_sub0)).max(0.0);
                }
                self.mask_scene.reset();
            }

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

            let mut encoder = self.take_encoder("reader glass");
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
                self.backdrop_gen,
                low_prefix.is_none() && backdrop_is_frame,
                &params,
                region,
                sample_clip,
                alpha,
                coarse && divisor == 1,
                analytic_coarse,
                mask_slot,
                has_clip_mask,
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
        self.flush_preserving_clips(open, true)?;
        let active = self.active.as_ref().expect("active draw");
        let previous_targets = (active.write_main, active.write_backdrop);
        let parent_backdrop_live = !self.offscreen_stack.is_empty() || active.backdrop_live;
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
        let mut encoder = self.take_encoder("isolation init");
        let res = (|| {
            let overlap = area.intersect(parent_bounds);
            for (backdrop, target) in std::iter::once((!isolation.on_main && !isolation.separate, &scope.main))
                .chain(scope.backdrop.iter().map(|t| (true, t)))
            {
                if !isolation.copy_parent || overlap != area {
                    GpuReaders::encode_clear(&mut encoder, &target.view, wgpu::Color::TRANSPARENT);
                }
                if isolation.copy_parent && !overlap.is_empty() {
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
        self.flush_scene_gpu(false)?;
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
        self.retire_scope(content);
        if let Some(picture) = picture {
            self.retire_scope(picture);
        }
        result
    }

    fn abort_isolated(&mut self) {
        if let Some(scope) = self.offscreen_stack.pop() {
            let active = self.active.as_mut().expect("active draw");
            (active.write_main, active.write_backdrop) = scope.previous_targets;
            active.scene_dirty = false;
            self.retire_scope(scope);
        }
        self.recycle_scene_textures();
        let (w, h) = self.active_scene_size();
        self.scene.reset_and_resize(w, h);
    }

    const ALLOW_UNBOUNDED_VIEW_BLUR: bool = true;

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
        let Some(scope) = self.offscreen_stack.last() else {
            return Ok(());
        };
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
                let t0 = now();
                let sub0 = self.active.as_ref().map_or(0.0, |a| a.submit_ms);
                let max_tex = self.device.limits().max_texture_dimension_2d;
                if cw <= max_tex && ch <= max_tex {
                    self.ensure_scratch_mask(cw, ch)?;
                    if invert {
                        self.ensure_scratch_blur(cw, ch)?;
                    }
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
                        let mask_clear = [RectU16 {
                            x0: 0,
                            y0: 0,
                            x1: cw as u16,
                            y1: ch as u16,
                        }];
                        let mut options = RenderOptions::default();
                        options.target_init = TargetInit::Clear(ClearSettings::Rects {
                            color: AlphaColor::TRANSPARENT,
                            rects: &mask_clear,
                        });
                        self.vello_render(true, &mask_view, Some(&mask_depth), options, "shadow cache")?;
                        let mut encoder = self.take_encoder("shadow cache");
                        let blur_res = if !invert {
                            self.blur.encode(
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
                            )
                        } else {
                            let (blur_view, blur_id) = {
                                let blur_tex = self.scratch_blur.as_ref().expect("scratch_blur");
                                (blur_tex.view.clone(), blur_tex.view_id)
                            };
                            let r = self.blur.encode(
                                &self.device,
                                &mut encoder,
                                &mask_view,
                                mask_id,
                                (mask_w_alloc, mask_h_alloc),
                                &blur_view,
                                (cw, ch),
                                (0, 0),
                                &spec,
                                None,
                            );
                            if r.is_ok() {
                                self.shadow.encode_invert_alpha(
                                    &self.device,
                                    &mut encoder,
                                    &blur_view,
                                    blur_id,
                                    &view,
                                    cw,
                                    ch,
                                );
                            }
                            r
                        };
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
                if invert {
                    self.ensure_scratch_blur(dirty_w, dirty_h)?;
                }
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
                let mask_clear = [RectU16 {
                    x0: 0,
                    y0: 0,
                    x1: mask_w as u16,
                    y1: mask_h as u16,
                }];
                let mut options = RenderOptions::default();
                options.target_init = TargetInit::Clear(ClearSettings::Rects {
                    color: AlphaColor::TRANSPARENT,
                    rects: &mask_clear,
                });
                self.vello_render(true, &mask_view, Some(&mask_depth), options, "shadow")?;
                let mut encoder = self.take_encoder("shadow");
                let blur_res = if !invert {
                    self.blur.encode(
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
                    )
                } else {
                    let (blur_view, blur_id) = {
                        let blur_tex = self.scratch_blur.as_ref().expect("scratch_blur");
                        (blur_tex.view.clone(), blur_tex.view_id)
                    };
                    let r = self.blur.encode(
                        &self.device,
                        &mut encoder,
                        &mask_view,
                        mask_id,
                        (mask_w_alloc, mask_h_alloc),
                        &blur_view,
                        (dirty_w, dirty_h),
                        dst_origin,
                        &spec,
                        None,
                    );
                    if r.is_ok() {
                        self.shadow.encode_invert_alpha(
                            &self.device,
                            &mut encoder,
                            &blur_view,
                            blur_id,
                            &temp.view,
                            dirty_w,
                            dirty_h,
                        );
                    }
                    r
                };
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
                let mask_clear = [RectU16 {
                    x0: 0,
                    y0: 0,
                    x1: sw as u16,
                    y1: sh as u16,
                }];
                let mut options = RenderOptions::default();
                options.target_init = TargetInit::Clear(ClearSettings::Rects {
                    color: AlphaColor::TRANSPARENT,
                    rects: &mask_clear,
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
            let sigma_dev = sigma * tier.render_divisor as f32;
            let in_tier = reader.is_some() && sigma_dev >= tier.unif_min_sigma && sigma_dev < tier.unif_max_sigma;
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
        let halo_sample = if coarse {
            None
        } else {
            reader
                .and_then(|reader| self.reader_halo.as_ref()?.blurred.get(&reader))
                .and_then(|patch| self.sample_blur_halo(&draw, patch, patch.size))
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
            self.resolve_blur_source(&mut draw, sigma, None)?;
        }
        let analytic = if coarse {
            analytic_box_from_paths(paths, device, size, draw.frame_dirty_origin())
        } else {
            None
        };
        let (mut encoder, clipped) = self.encode_blur_reader_masks(&draw, paths, device, analytic.is_some(), open)?;
        if coarse {
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
                clipped,
                budget,
            )?;
        } else {
            if halo_sample.is_none() {
                self.encode_single_blur_into_out(&mut encoder, reader, capture_tier, &draw, draw.dirty, sigma, within)?;
                let capture = reader.and_then(|reader| {
                    let tier = capture_tier?;
                    let sigma_dev = sigma * tier.render_divisor as f32;
                    let bounds = draw
                        .dirty
                        .translate(draw.origin.0, draw.origin.1)
                        .intersect(tier.visible.inflate(2, 2));
                    (sigma_dev >= tier.unif_min_sigma && sigma_dev < tier.unif_max_sigma && !bounds.is_empty())
                        .then_some((reader, bounds, tier))
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
            let budget = self.reader_budget_room();
            for target in draw.targets.iter().flatten() {
                self.readers.encode_bg_blur_composite(
                    &self.device,
                    &mut encoder,
                    &target.texture,
                    &target.view,
                    draw.dirty,
                    alpha,
                    clipped,
                    halo_sample.as_ref(),
                    budget,
                )?;
            }
        }
        if draw.source_is_frame && draw.source_written {
            self.backdrop_gen += 1;
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
                let clip_info = draw.halo_clip_bounds(Some(tier), within, max_stop_sigma);
                let mut encoder = self.take_encoder("progressive halo capture");
                let cols = (stop_count as u32).clamp(1, 4);
                let rows = (stop_count as u32).div_ceil(cols).max(1);
                let width = (active_dirty.x1 - active_dirty.x0) as u32;
                let height = (active_dirty.y1 - active_dirty.y0) as u32;
                let budget = self.reader_budget_room();
                let tile_side = self.progressive_tile_side(width, height, cols, rows, budget);
                self.readers.ensure_blur_out_budgeted(
                    &self.device,
                    width.min(tile_side) * cols,
                    height.min(tile_side) * rows,
                    budget,
                )?;
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
        let dirty = draw.dirty;
        let dirty_frame = Rect::new(
            f64::from(draw.origin.0 + dirty.x0),
            f64::from(draw.origin.1 + dirty.y0),
            f64::from(draw.origin.0 + dirty.x1),
            f64::from(draw.origin.1 + dirty.y1),
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
        let (mut encoder, clipped) = self.encode_blur_reader_masks(&draw, paths, device, false, open)?;
        let (width, height) = draw.dirty_size();

        // Fast path: when every active stop in `dirty` is already provided by captured halo tiers,
        // skip native blur passes, blur_out atlas allocation, and progressive tiling completely.
        if fast_halo_only {
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
                            clipped,
                            halo_1.as_ref(),
                            halo_2.as_ref(),
                            budget,
                        )?;
                    }
                }
            }
            if draw.source_is_frame && draw.source_written {
                self.backdrop_gen += 1;
            }
            self.stash_encoder(encoder);
            return Ok(());
        }

        let max_resident_blur_sigma = capture_tier.map_or(max_resident_sigma, |tier| {
            halo::compensate_halo_sigma(max_resident_sigma, tier.render_divisor)
        });
        let clip_info = draw.halo_clip_bounds(capture_tier, within, max_resident_blur_sigma);
        let cols = (resident as u32).clamp(1, 4);
        let rows = (resident as u32).div_ceil(cols).max(1);
        let budget = self.reader_budget_room();
        let tile_side = self.progressive_tile_side(width, height, cols, rows, budget);
        self.readers.ensure_blur_out_budgeted(
            &self.device,
            width.min(tile_side) * cols,
            height.min(tile_side) * rows,
            budget,
        )?;
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
                        clipped,
                        halo_1.as_ref(),
                        halo_2.as_ref(),
                        budget,
                    )?;
                }
            }
        }
        if draw.source_is_frame && draw.source_written {
            self.backdrop_gen += 1;
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
