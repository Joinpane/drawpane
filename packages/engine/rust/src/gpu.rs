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

use crate::blur::{self, BlurSpec, EdgeMode, validate_sigma};
use crate::engine::{DragFrame, TiledOptions};
use crate::error::{EngineError, ErrorCode, Result};
use crate::exec::{
    self, Backend, DrawStats, Frame, GlyphMask, IRect, ImageView, Isolation, Open, Pass, PostStep, ShadowCast, Split,
    impl_draw, resolve_inradius,
};
use crate::glass;
use crate::gpu_readers::{CoarseAnalytic, GpuReaders};
use crate::images::{self, Level};
use crate::masks::{self, MaskCache, MaskKey};
use crate::progressive_blur;
use crate::record::{BackgroundBlurOp, GlassOp, ProgressiveBlurOp};
use crate::shadow::{
    CanonicalShadow, ShadowMaskCache, compute_mask_rect, compute_mask_rect_bounds, reduced_dirty_rect,
    scaled_shadow_sigma, shadow_raster_shift,
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
) -> String {
    let features_list = format!("{features:?}");
    format!(
        "{{\"backend\":{},\"wgpuBackend\":{},\"name\":{},\"vendor\":{},\"device\":{},\"deviceType\":{},\"driver\":{},\"driverInfo\":{},\"fallback\":{},\"features\":{},\"limits\":{{\"maxTextureDimension1D\":{},\"maxTextureDimension2D\":{},\"maxTextureDimension3D\":{},\"maxTextureArrayLayers\":{},\"maxBindGroups\":{},\"maxSampledTexturesPerShaderStage\":{},\"maxSamplersPerShaderStage\":{},\"maxUniformBuffersPerShaderStage\":{},\"maxUniformBufferBindingSize\":{},\"maxBufferSize\":{},\"maxColorAttachments\":{},\"maxInterStageShaderVariables\":{}}}}}",
        json_escape(backend),
        json_escape(&format!("{:?}", info.backend)),
        json_escape(&info.name),
        info.vendor,
        info.device,
        json_escape(&format!("{:?}", info.device_type)),
        json_escape(&info.driver),
        json_escape(&info.driver_info),
        fallback,
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

    fn stop_error(&self) -> Option<EngineError> {
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
    present_group: Option<wgpu::BindGroup>,
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

/// Tile pages: textures of `PAGE` × `PAGE` pixels, each holding `PER_PAGE` tiles.
const PAGE: u32 = 2048;
const PER_ROW: u32 = PAGE / TILE;
const PER_PAGE: u32 = PER_ROW * PER_ROW;
const PAGE_BYTES: usize = (PAGE * PAGE * 4) as usize;
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
}

struct Compositor {
    pipeline: wgpu::RenderPipeline,
    /// The same quads laid over what's there (premultiplied source over): a drag's selection
    /// and the part above it.
    over: wgpu::RenderPipeline,
    sampler: wgpu::Sampler,
    uniforms: wgpu::Buffer,
    instances: wgpu::Buffer,
    capacity: usize,
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
fn now() -> f64 {
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
    depth: wgpu::TextureView,
    width: u32,
    height: u32,
    bytes: usize,
}

/// Reusable scratch RGBA8 texture for inner-shadow blur output before alpha inversion.
struct GpuBlurScratch {
    tex: wgpu::Texture,
    view: wgpu::TextureView,
    width: u32,
    height: u32,
    bytes: usize,
}

/// The scratch target and its depth buffer (`TILE + 2 * halo` square for tiles, or `w x h` whole).
struct ScratchTile {
    texture: wgpu::Texture,
    view: wgpu::TextureView,
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
    before: Option<wgpu::CommandEncoder>,
    /// True once `before` contains a `vello_hybrid::Renderer::render` call; a second `render`
    /// must submit `before` first so `vello_hybrid`'s shared GPU staging buffers are not overwritten.
    encoder_has_vello: bool,
    flush_ms: f64,
}

struct BlurReaderPlane {
    texture: wgpu::Texture,
    view: wgpu::TextureView,
}

struct BlurReaderDraw {
    frame_size: (i32, i32),
    origin: (i32, i32),
    size: (u32, u32),
    dirty: IRect,
    source: BlurReaderPlane,
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
            (-self.origin.0, -self.origin.1),
            (self.size.0 as i32, self.size.1 as i32),
            sigma,
        )
    }
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
    active: Option<ActiveDraw>,
    backdrop_gen: u64,
    /// Frame textures: the one shown (`cur`) and the one being made.
    frames: Vec<Main>,
    cur: Option<usize>,
    surface_bytes: usize,
    /// The board textures (decision 0040, phase 2): which tiles are held, where, and how fresh.
    pub tiles: TileCache,
    pages: Vec<Page>,
    /// Scratch targets and their depth buffers: slot 0 caches the plain `TILE x TILE` target for
    /// non-reader and coarse tiles, slot 1 caches the haloed (`TILE + 2 * halo`) or whole-frame target.
    scratches: [Option<ScratchTile>; 2],
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
    /// Milliseconds a tile has lately taken to draw (a running average).
    tile_ms: f64,
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
}

impl Drop for Gpu {
    fn drop(&mut self) {
        self.health.cancel();
        for m in self.frames.drain(..) {
            m.texture.destroy();
        }
        for p in self.pages.drain(..) {
            p.texture.destroy();
        }
        for scratch in self.scratches.iter_mut().filter_map(Option::take) {
            scratch.texture.destroy();
        }
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

fn raster_clips(scene: &mut Scene, open: &[Open], shift: Affine, size: (u32, u32), skip_context: bool) {
    let mut pushed = 0;
    for o in open {
        if let Open::Clip {
            transform,
            path,
            even_odd,
            active_on_scene: true,
            context_only,
            ..
        } = o
        {
            if skip_context && *context_only {
                continue;
            }
            scene.set_transform(shift * *transform);
            scene.set_fill_rule(if *even_odd { Fill::EvenOdd } else { Fill::NonZero });
            scene.push_clip_path(path);
            pushed += 1;
        }
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
        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor {
                label: Some("drawpane engine"),
                required_features: wgpu::Features::empty(),
                required_limits,
                ..Default::default()
            })
            .await
            .map_err(|e| EngineError::new(ErrorCode::NoAdapter, format!("no {backend_name} device: {e}")))?;
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
        let details = format_details(&info, &adapter_limits, adapter_features, backend_name, fallback_adapter);
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
            active: None,
            backdrop_gen: 0,
            frames: Vec::new(),
            cur: None,
            surface_bytes: 0,
            tiles: TileCache::new(TILE, 0),
            pages: Vec::new(),
            scratches: [None, None],
            active_scratch: 0,
            motion_prefix: None,
            compositor: None,
            diamond: None,
            last: None,
            last_scale: None,
            shown: None,
            whole_samples: None,
            tile_ms: 0.0,
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
        self.bytes
            + self.readers.bytes()
            + self.blur.bytes()
            + self.pool_bytes
            + self.shadow_cache.bytes()
            + self.noise.gpu_bytes()
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
        if keep_bytes == 0 && self.active.is_none() {
            for s in self.shadow_cache.clear() {
                self.bindings.remove(s.tid);
                s.tex.destroy();
            }
            self.blur.clear();
            self.noise.clear();
        }
        while self.pool_bytes > keep_bytes {
            if let Some(t) = self.temp_pool.pop() {
                self.bindings.remove(t.tid);
                self.pool_bytes = self.pool_bytes.saturating_sub(t.bytes);
                t.tex.destroy();
            } else if let Some(t) = self.offscreen_pool.pop() {
                self.pool_bytes = self.pool_bytes.saturating_sub(t.bytes);
                t.tex.destroy();
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
        let reuse = self
            .scratch_mask
            .as_ref()
            .is_some_and(|s| s.width >= w && s.height >= h && (s.width as usize * s.height as usize) <= max_area);
        if reuse {
            return Ok(());
        }
        let freed = self.scratch_mask.as_ref().map_or(0, |s| s.bytes);
        let bytes = need_w as usize * need_h as usize * 8;
        self.reserve_or_trim(bytes, freed, "a shadow mask")?;
        if let Some(old) = self.scratch_mask.take() {
            self.pool_bytes = self.pool_bytes.saturating_sub(old.bytes);
            old.tex.destroy();
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
        let freed = self.scratch_blur.as_ref().map_or(0, |s| s.bytes);
        let bytes = need_w as usize * need_h as usize * 4;
        self.reserve_or_trim(bytes, freed, "a shadow blur buffer")?;
        if let Some(old) = self.scratch_blur.take() {
            self.pool_bytes = self.pool_bytes.saturating_sub(old.bytes);
            old.tex.destroy();
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
        let reuse = self
            .scratch_backdrop
            .as_ref()
            .is_some_and(|s| s.width >= w && s.height >= h && (s.width as usize * s.height as usize) <= max_area);
        if reuse {
            return Ok(());
        }
        let freed = self.scratch_backdrop.as_ref().map_or(0, |s| s.bytes);
        let bytes = need_w as usize * need_h as usize * 4;
        self.reserve_or_trim(bytes, freed, "a blend backdrop buffer")?;
        if let Some(old) = self.scratch_backdrop.take() {
            self.pool_bytes = self.pool_bytes.saturating_sub(old.bytes);
            old.tex.destroy();
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
        let tex = texture(
            &self.device,
            width,
            height,
            wgpu::TextureUsages::RENDER_ATTACHMENT
                | wgpu::TextureUsages::TEXTURE_BINDING
                | wgpu::TextureUsages::COPY_SRC
                | wgpu::TextureUsages::COPY_DST,
            "frame",
        );
        let view = tex.create_view(&Default::default());
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
        let frame = Main {
            view,
            texture: tex,
            present_group,
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

    /// Forgets the frame shown as a stand-in (after a fresh list: it shows a page that's gone).
    pub fn forget_last(&mut self) {
        self.last = None;
        self.last_scale = None;
        self.shown = None;
    }

    /// Drops every tile (benches and tests time cold frames this way).
    pub fn clear_tiles(&mut self) {
        self.tiles.clear();
        self.shown = None;
    }

    pub fn clear_view_caches(&mut self) {
        self.clear_tiles();
        self.fit_tiles(0);
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
    }

    /// Bytes the engine holds on the GPU outside its tile pages.
    fn bytes_beside_tiles(&self) -> usize {
        self.bytes().saturating_sub(self.pages.len() * PAGE_BYTES)
    }

    /// Fits the tiles kept to the budget: what's left of it beside everything else, at most
    /// `tile_bytes`, in whole pages. Pages past it go, with their tiles.
    fn fit_tiles(&mut self, tile_bytes: usize) {
        let beside = self.bytes_beside_tiles() + self.readbacks.bytes.get() + HEADROOM;
        let room = self.budget.saturating_sub(beside);
        let pages = (tile_bytes.min(room) / PAGE_BYTES).min(1024);
        while self.pages.len() > pages {
            if let Some(p) = self.pages.pop() {
                p.texture.destroy();
                self.bytes -= PAGE_BYTES;
            }
        }
        self.tiles.set_max_slots(pages * PER_PAGE as usize);
    }

    /// Room remaining under `self.budget` for `self.readers` allocations.
    fn reader_budget_room(&self) -> usize {
        self.budget
            .saturating_sub(self.bytes() - self.readers.bytes() + self.readbacks.bytes.get())
    }

    /// The page and position of a slot, making its page (within the budget `fit_tiles` set).
    fn slot_place(&mut self, slot: u32) -> Result<(usize, u32, u32)> {
        let page = (slot / PER_PAGE) as usize;
        let within = slot % PER_PAGE;
        let (x, y) = ((within % PER_ROW) * TILE, (within / PER_ROW) * TILE);
        while self.pages.len() <= page {
            self.check_texture_size(PAGE, PAGE, "a page of tiles")?;
            self.reserve(PAGE_BYTES, 0, "a page of tiles")?;
            let tex = texture(
                &self.device,
                PAGE,
                PAGE,
                wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_SRC | wgpu::TextureUsages::COPY_DST,
                "tiles",
            );
            self.pages.push(Page {
                view: tex.create_view(&Default::default()),
                texture: tex,
            });
            self.bytes += PAGE_BYTES;
        }
        Ok((page, x, y))
    }

    /// Takes the active tile's pending command encoder (or creates a new one). When `for_vello` is
    /// true and the pending encoder already recorded a `vello_hybrid::Renderer::render` call, that
    /// encoder is submitted first so `vello_hybrid`'s staging buffers are never overwritten in flight.
    fn take_encoder(&mut self, for_vello: bool, label: &str) -> wgpu::CommandEncoder {
        if for_vello && self.active.as_ref().is_some_and(|a| a.encoder_has_vello) {
            self.submit_active_encoder();
        }
        if for_vello && let Some(a) = self.active.as_mut() {
            a.encoder_has_vello = true;
        }
        self.active.as_mut().and_then(|a| a.before.take()).unwrap_or_else(|| {
            self.device
                .create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some(label) })
        })
    }

    fn submit_active_encoder(&mut self) {
        if let Some(active) = self.active.as_mut() {
            if let Some(encoder) = active.before.take() {
                self.readers.flush_uniforms(&self.queue);
                self.queue.submit([encoder.finish()]);
                self.blur.flush_retired();
                self.submits += 1;
            }
            active.encoder_has_vello = false;
        }
        self.offscreen_pool.append(&mut self.offscreen_in_use);
    }

    /// Stashes `encoder` onto the active tile so subsequent non-Vello reader/copy passes can join
    /// the same command buffer without an extra `queue.submit`.
    fn stash_encoder(&mut self, encoder: wgpu::CommandEncoder) {
        if let Some(a) = self.active.as_mut() {
            a.before = Some(encoder);
        } else {
            self.readers.flush_uniforms(&self.queue);
            self.queue.submit([encoder.finish()]);
            self.blur.flush_retired();
            self.submits += 1;
        }
    }

    /// The scratch tile (`side` × `side`, where `side = TILE + 2 * halo`) and its depth buffer.
    fn ensure_scratch(&mut self, side: u32) -> Result<()> {
        self.ensure_scratch_size(side, side)
    }

    /// The scratch render target (`width` × `height`) and its depth buffer.
    fn ensure_scratch_size(&mut self, width: u32, height: u32) -> Result<()> {
        let slot = usize::from(!(width == TILE && height == TILE));
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
        if self.reserve(bytes, freed, "the scratch tile").is_err()
            && let Some(old) = self.scratches[1 - slot].take()
        {
            let ob = (old.width as usize) * (old.height as usize) * 4 * 2;
            old.texture.destroy();
            self.bytes = self.bytes.saturating_sub(ob);
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
            let mut encoder = self.take_encoder(false, "cache motion prefix");
            let cached = &self.motion_prefix.as_ref().expect("cached prefix").texture;
            copy_rect(&mut encoder, &target, cached, (0, 0), (0, 0), (width, height));
            self.stash_encoder(encoder);
        } else {
            let mut encoder = self.take_encoder(false, "restore motion prefix");
            let cached = &self.motion_prefix.as_ref().expect("cached prefix").texture;
            copy_rect(&mut encoder, cached, &target, (0, 0), (0, 0), (width, height));
            self.stash_encoder(encoder);
            self.active.as_mut().expect("whole-frame draw").needs_clear = false;
        }
        split.pass = Pass::Above;
        Ok(Some(split))
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
        samples: Option<IRect>,
    ) -> Result<DrawStats> {
        self.check()?;
        let (width, height) = (u32::from(frame.width), u32::from(frame.height));
        let t0 = now();
        let view = frame.view;
        let scale = view.as_coeffs()[0];
        let bg_bits = background.map(f32::to_bits);
        let mut stats = DrawStats {
            direct: true,
            plan: 2,
            ..DrawStats::default()
        };
        if !moving
            && self.last.is_some_and(|l| l.view == view && l.size == (width, height))
            && self.shown == Some((generation, bg_bits, true))
            && self.whole_samples == Some(samples)
        {
            stats.exact = true;
            stats.plan = 3;
            return self.finish_frame(self.cur.expect("unchanged frame"), stats, t0);
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
        self.ensure_frame(dst, width, height)?;
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
        self.active = Some(ActiveDraw {
            frame_dst: padded.is_none().then_some(dst),
            display_area: padded.map(|((x, y), _)| IRect {
                x0: x as i32,
                y0: y as i32,
                x1: (x + width) as i32,
                y1: (y + height) as i32,
            }),
            width: w,
            height: h,
            background,
            detail: moving,
            needs_clear: true,
            backdrop_live: false,
            write_main: true,
            write_backdrop: false,
            scene_dirty: false,
            before: None,
            encoder_has_vello: false,
            flush_ms: 0.0,
        });
        let limits = store.limits;
        let mut verbs = limits.frame_verbs;
        let split = match prefix {
            Some(prefix) => self.prepare_motion_prefix(store, &whole, bg_bits, prefix, &mut verbs, &mut stats),
            None => Ok(None),
        };
        let draw = split.and_then(|split| {
            exec::draw_split(
                store,
                self,
                &whole,
                &limits,
                &mut verbs,
                &split.unwrap_or_else(Split::all),
                moving,
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
        let t1 = now();
        if let Err(e) = self.flush_scene_gpu(true) {
            self.discard_draw();
            return Err(e);
        }
        if let Some((start, _)) = padded {
            let mut encoder = self.take_encoder(false, "crop padded frame");
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
        let render_ms = active.flush_ms + now() - t1;
        stats.encode_ms += (now() - t0 - render_ms).max(0.0);
        stats.render_ms += render_ms;
        stats.exact = !moving && s.exact();
        stats.standin = !stats.exact;
        stats.held = self.tiles.len() as u32;
        stats.evicted = self.tiles.stats.evicted;
        let stats = self.finish_frame(dst, stats, t0)?;
        self.cur = Some(dst);
        self.last = Some(Last {
            view,
            size: (width, height),
        });
        self.last_scale = Some(scale);
        self.whole_samples = (padded.is_some() == samples.is_some()).then_some(samples);
        self.shown = Some((generation, bg_bits, stats.exact));
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
        self.forget_motion_prefix();
        if store.readers().is_empty() && !store.has_context() && self.readers.bytes() > 0 {
            self.readers.evict_frame_scratch();
        }
        let (w, h) = (u32::from(frame.width), u32::from(frame.height));
        self.ensure_compositor();
        self.masks.begin_frame();
        self.blur.begin_frame();
        self.shadow.begin_frame();
        self.trim_pools(GPU_POOL_KEEP_BYTES);
        let t0 = now();
        self.tiles.begin(background, halo);
        self.fit_tiles(store.limits.tile_bytes);
        let view = frame.view;
        let scale = view.as_coeffs()[0];
        let zooming = options.moving && self.last_scale.is_some_and(|s| s != scale);
        // A page just shown (opened, switched to, its list made afresh): nothing to stand on.
        // Under a budget its first frame is coarse tiles (a ladder level, level of detail on),
        // quick to draw; the exact tiles follow a few a frame (decision 0040, phase 2: open time).
        let opening = self.last.is_none() && self.tiles.is_empty() && options.budget_ms > 0.0;
        let last = self.last;
        let coarse_moving = options.moving && halo > 0;
        let bg_bits = background.map(f32::to_bits);
        self.tiles.opening = opening;
        // During moving coarse reader frames, draw only visible tiles rather than spending frame
        // budget prefetching off-screen coarse stand-ins that must be redrawn exact at rest.
        let mut plan = self
            .tiles
            .plan(
                view,
                (w, h),
                zooming || opening,
                last,
                options.prefetch && !coarse_moving,
            )
            .ok_or_else(|| EngineError::limit("a camera the tiles can't follow (too far out)"))?;
        let selection = self.tiles.drag_prepare(&mut plan, drag.map(DragFrame::input).as_ref());
        let mut stats = DrawStats {
            direct: plan.direct,
            ..DrawStats::default()
        };
        // Nothing to draw and the frame shown is this one, exact: it stays.
        let same = plan.jobs.is_empty()
            && selection.is_none()
            && last.is_some_and(|l| l.view == view && l.size == (w, h))
            && self.shown == Some((generation, bg_bits, true));
        if same {
            stats.exact = true;
            stats.plan = 3;
            return self.finish_frame(self.cur.expect("unchanged frame"), stats, t0);
        }
        let dst = self.next_frame();
        self.ensure_frame(dst, w, h)?;
        let mut verbs = store.limits.frame_verbs;
        let mut drew_any = false;
        let mut direct_exact = true;
        // Moving coarse frames sample mipmaps inside `TILE` directly without growing a full halo.
        let frame_halo = if coarse_moving { 0 } else { halo };
        // Drawn straight into the frame after it's laid: what no slot could be kept for.
        let mut late: Vec<crate::tiles::Job> = Vec::new();
        for job in &plan.jobs {
            // Within the budget. Past it, what something stands in for waits for a later frame;
            // what nothing stands in for is drawn regardless (the plan puts it first). At rest a
            // frame always draws one tile, so it makes progress. While the camera moves a tile is
            // drawn if one, at what tiles have lately cost, fits what's left; the frame's first
            // may take up to three budgets, so a pan keeps up with ordinary tiles while a dense
            // one (tens of ms) never makes a long moving frame.
            let elapsed = now() - t0;
            let over = options.budget_ms > 0.0
                && if options.moving {
                    let fits = elapsed + self.tile_ms <= options.budget_ms;
                    let first = !drew_any && elapsed + self.tile_ms.max(1.0) <= options.budget_ms * 3.0;
                    !(fits || first)
                } else {
                    drew_any && elapsed >= options.budget_ms
                };
            if !job.must && over {
                stats.queued += 1;
                continue;
            }
            let target = if plan.direct {
                TileTarget::Scratch
            } else if job.direct {
                late.push(*job);
                continue;
            } else {
                match self.tiles.slot_for(job.key) {
                    Some(s) => TileTarget::Slot(s),
                    None => {
                        if job.must {
                            late.push(*job);
                        }
                        continue;
                    }
                }
            };
            let tile_detail = job.detail || coarse_moving;
            let exact = self.draw_job(
                store,
                job,
                tile_detail,
                frame_halo,
                background,
                target,
                &plan,
                dst,
                &mut stats,
                &mut verbs,
            )?;
            drew_any = true;
            // What a tile costs lately (a running average), for moving frames' budget.
            let took = now() - t0 - elapsed;
            self.tile_ms = self.tile_ms * 0.75 + took * 0.25;
            match target {
                TileTarget::Slot(s) => self.tiles.drawn(job.key, s, exact, !tile_detail),
                TileTarget::Scratch | TileTarget::ScratchOnly => direct_exact &= exact,
            }
        }
        let t1 = now();
        if plan.direct {
            stats.plan = 2;
        } else {
            // What's drawn straight into the frame after it covers its tile there: the composite
            // counts it so (what no slot could be found for included).
            for job in plan.jobs.iter_mut() {
                if late.iter().any(|l| l.key == job.key) {
                    job.direct = true;
                }
            }
            let comp = self.tiles.compose(&plan, last);
            stats.exact = comp.exact;
            stats.pending = comp.pending;
            stats.plan = if comp.complete { 0 } else { 1 };
            self.composite(&comp, dst, background, w, h)?;
            stats.render_ms += now() - t1;
            for job in &late {
                let tile_detail = job.detail || coarse_moving;
                direct_exact &= self.draw_job(
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
                )?;
            }
            if let (Some(now), Some(split)) = (selection, drag.and_then(|d| d.split.as_ref())) {
                let dragged = self.drag_composite(store, &plan, now, split, halo, background, dst, &mut stats);
                if let Err(e) = dragged {
                    self.scene.reset();
                    return Err(e);
                }
            }
        }
        stats.exact = (plan.direct || stats.exact) && direct_exact;
        stats.direct = plan.direct || !late.is_empty();
        stats.standin = !stats.exact;
        stats.held = self.tiles.len() as u32;
        stats.evicted = self.tiles.stats.evicted;
        let stats = self.finish_frame(dst, stats, t0)?;
        self.cur = Some(dst);
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
    /// it, for at most `budget_ms` (at least one tile; zero or less: no limit), compositing and
    /// presenting nothing. What a browser runs between frames at rest, so the exact frame comes
    /// sooner without any one long frame. In the answer, `pending`: tiles the frame shows still
    /// to draw; `queued`: tiles round it still to draw.
    pub fn ahead(&mut self, store: &Store, background: [f32; 4], halo: i32, budget_ms: f64) -> Result<DrawStats> {
        self.check()?;
        let mut stats = DrawStats::default();
        let Some(last) = self.last else { return Ok(stats) };
        let t0 = now();
        self.masks.begin_frame();
        self.blur.begin_frame();
        self.tiles.begin(background, halo);
        self.fit_tiles(store.limits.tile_bytes);
        let Some(plan) = self.tiles.plan(last.view, last.size, false, Some(last), true) else {
            return Ok(stats);
        };
        let mut verbs = store.limits.frame_verbs;
        let dst = self.cur.expect("previous frame");
        for job in &plan.jobs {
            // A tile with no slot to keep it in is drawn by the frame itself.
            if plan.direct || job.direct {
                continue;
            }
            if stats.tiles_drawn > 0 && budget_ms > 0.0 && now() - t0 >= budget_ms {
                break;
            }
            let Some(slot) = self.tiles.slot_for(job.key) else {
                continue;
            };
            let exact = self.draw_job(
                store,
                job,
                job.detail,
                halo,
                background,
                TileTarget::Slot(slot),
                &plan,
                dst,
                &mut stats,
                &mut verbs,
            )?;
            self.tiles.drawn(job.key, slot, exact, !job.detail);
        }
        let (pending, queued) = self.tiles.left(&plan);
        stats.pending = pending;
        stats.queued = queued;
        stats.held = self.tiles.len() as u32;
        stats.evicted = self.tiles.stats.evicted;
        stats.cpu_ms = now() - t0;
        self.scene.reset();
        self.check()?;
        Ok(stats)
    }

    /// Presents the frame shown (with a canvas) and finishes the frame's numbers.
    fn finish_frame(&mut self, frame: usize, mut stats: DrawStats, t0: f64) -> Result<DrawStats> {
        let t1 = now();
        self.check()?;
        self.configure_surface(frame)?;
        let acquired = match self.acquire() {
            Ok(t) => t,
            Err(e) => {
                self.scene.reset();
                return Err(e);
            }
        };
        // A frame read back (no canvas) needs no presenting.
        stats.presented = self.surface.is_none() || acquired.is_some();
        if let (Some(t), Some(blit)) = (acquired, self.blit.as_ref()) {
            let main = &self.frames[frame];
            let mut encoder = self
                .device
                .create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("present") });
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
            self.queue.submit([encoder.finish()]);
            self.submits += 1;
            self.queue.present(t);
        }
        stats.submit_ms = now() - t1;
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
        self.backdrop_gen += 1;
        self.active = Some(ActiveDraw {
            frame_dst: None,
            display_area: None,
            width: side,
            height: side,
            background,
            detail: coarse_readers,
            needs_clear: true,
            backdrop_live: false,
            write_main: true,
            write_backdrop: false,
            scene_dirty: false,
            before: None,
            encoder_has_vello: false,
            flush_ms: 0.0,
        });
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
        let t1 = now();
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
            let mut encoder = self.take_encoder(false, "tile copy");
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
        let render_ms = active.flush_ms + now() - t1;
        stats.encode_ms += (now() - t0 - render_ms).max(0.0);
        stats.render_ms += render_ms;
        Ok(exact)
    }

    /// The active scope's planes never resolve past the top of the stack. A shared scope
    /// aliases both channels to its one source, even when only the backdrop channel is selected.
    fn plane(&self, backdrop: bool) -> Result<(&wgpu::Texture, &wgpu::TextureView, &wgpu::TextureView)> {
        if let Some(scope) = self.offscreen_stack.last() {
            let target = scope.plane(backdrop);
            return Ok((&target.tex, &target.view, &target.depth));
        }
        self.root_plane(backdrop)
    }

    fn root_plane(&self, backdrop: bool) -> Result<(&wgpu::Texture, &wgpu::TextureView, &wgpu::TextureView)> {
        let root = self.scratches[self.active_scratch]
            .as_ref()
            .ok_or_else(|| EngineError::new(ErrorCode::State, "no scratch tile"))?;
        if backdrop {
            let back = self
                .readers
                .backdrop_frame
                .as_ref()
                .ok_or_else(|| EngineError::new(ErrorCode::State, "no backdrop plane"))?;
            return Ok((&back.texture, &back.view, &root.depth));
        }
        if let Some(dst) = self.active.as_ref().and_then(|active| active.frame_dst) {
            let frame = &self.frames[dst];
            return Ok((&frame.texture, &frame.view, &root.depth));
        }
        Ok((&root.texture, &root.view, &root.depth))
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
        self.readers.discard_uniforms();
        self.blur.flush_retired();
        while let Some(scope) = self.offscreen_stack.pop() {
            self.offscreen_pool.push(scope.main);
            self.offscreen_pool.extend(scope.backdrop);
        }
        self.offscreen_pool.append(&mut self.offscreen_in_use);
        self.scene.reset();
        self.recycle_scene_textures();
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
        let mut encoder = self.take_encoder(draw, "scene flush");
        if draw {
            self.flush_masks();
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
            let (_, view, _) = self.plane(false)?;
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
        }

        if draw {
            let (target, color, depth) = self.plane(!write_main)?;
            let depth = depth.clone();
            let (width, height) = (target.width(), target.height());
            let color = if dual {
                let max_bytes = self.reader_budget_room();
                self.readers
                    .ensure_frame_tex_budgeted(false, &self.device, width, height, "scene delta", max_bytes)?;
                options.target_init = TargetInit::Clear(ClearSettings::Viewport {
                    color: AlphaColor::TRANSPARENT,
                });
                self.readers.delta_frame.as_ref().expect("scene delta").view.clone()
            } else {
                color.clone()
            };
            self.renderer
                .render(
                    &self.scene,
                    &mut self.resources,
                    &mut encoder,
                    RenderTarget {
                        view: &color,
                        depth_view: Some(&depth),
                    },
                    &self.bindings,
                    options,
                )
                .map_err(vello_error)?;
            if dual {
                let (w, h) = self.active_scene_size();
                for backdrop in [false, true] {
                    let dst = self.plane(backdrop)?.1.clone();
                    self.readers.encode_composite(
                        &self.device,
                        &self.queue,
                        &mut encoder,
                        &color,
                        &dst,
                        (0, 0),
                        (0, 0, u32::from(w), u32::from(h)),
                        1.0,
                        false,
                    );
                }
            }
        }
        let active = self.active.as_mut().expect("active draw");
        active.needs_clear &= !needs_clear;
        active.scene_dirty = false;
        active.flush_ms += now() - t0;
        if needs_clear || (draw && (write_backdrop || (!active.backdrop_live && root))) {
            self.backdrop_gen += 1;
        }
        self.stash_encoder(encoder);
        if !self.temp_in_use.is_empty() || !self.temp_textures.is_empty() || !self.retired_shadows.is_empty() {
            self.submit_active_encoder();
            self.recycle_scene_textures();
            self.atlas.at = (0, 0, 0);
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

    fn readable_backdrop_plane(&self, active: &ActiveDraw) -> bool {
        self.offscreen_stack
            .last()
            .map_or(active.backdrop_live, |scope| scope.backdrop.is_some())
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
        let size = (u32::from(width), u32::from(height));
        let Some(dirty) = progressive_blur::blur_dirty_rect(
            paths,
            device,
            frame_size,
            (-origin.0, -origin.1),
            (i32::from(width), i32::from(height)),
        ) else {
            return Ok(None);
        };
        let read_backdrop = self.readable_backdrop_plane(active);
        let clone_plane = |backdrop| -> Result<BlurReaderPlane> {
            let (texture, view, _) = self.plane(backdrop)?;
            Ok(BlurReaderPlane {
                texture: texture.clone(),
                view: view.clone(),
            })
        };
        Ok(Some(BlurReaderDraw {
            frame_size,
            origin,
            size,
            dirty,
            source: clone_plane(read_backdrop)?,
            source_is_frame,
            source_written: if read_backdrop { write_backdrop } else { write_main },
            targets: [
                write_main.then(|| clone_plane(false)).transpose()?,
                write_backdrop.then(|| clone_plane(true)).transpose()?,
            ],
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
        let clipped = open.iter().any(|o| {
            matches!(
                o,
                Open::Clip {
                    active_on_scene: true,
                    context_only: false,
                    ..
                }
            )
        });
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
            let mut encoder = self.take_encoder(true, "blur reader clip");
            let clip = self.readers.clip_tex.as_ref().expect("blur reader clip");
            self.renderer
                .render(
                    &self.mask_scene,
                    &mut self.resources,
                    &mut encoder,
                    RenderTarget {
                        view: &clip.view,
                        depth_view: Some(&clip.depth),
                    },
                    &self.bindings,
                    options,
                )
                .map_err(vello_error)?;
            self.stash_encoder(encoder);
        }
        let mut encoder = self.take_encoder(!analytic, "backdrop blur");
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
            let mask = self.readers.mask_tex.as_ref().expect("blur reader shape");
            self.renderer
                .render(
                    &self.mask_scene,
                    &mut self.resources,
                    &mut encoder,
                    RenderTarget {
                        view: &mask.view,
                        depth_view: Some(&mask.depth),
                    },
                    &self.bindings,
                    options,
                )
                .map_err(vello_error)?;
        }
        self.mask_scene.reset();
        Ok((encoder, clipped))
    }

    #[allow(clippy::too_many_arguments)]
    fn encode_blur_reader_slice(
        &mut self,
        encoder: &mut wgpu::CommandEncoder,
        source: &wgpu::TextureView,
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
            &self.queue,
            encoder,
            source,
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
        let dst_origin = (sx - parent.x0, sy - parent.y0);
        let src_offset = ((visible.x0 - sx) as u32, (visible.y0 - sy) as u32);
        let dst_offset = ((visible.x0 - parent.x0) as u32, (visible.y0 - parent.y0) as u32);
        let size = ((visible.x1 - visible.x0) as u32, (visible.y1 - visible.y0) as u32);
        let scissor = (dst_offset.0, dst_offset.1, size.0, size.1);
        let clipped = open.iter().any(|o| {
            matches!(
                o,
                Open::Clip {
                    active_on_scene: true,
                    ..
                }
            )
        });
        let lerp = blend == crate::blend::BLEND_LERP;
        let shader = clipped || picture.is_some() || (blend != 0 && !lerp);
        let (aw, ah) = (u32::from(src.active_size.0), u32::from(src.active_size.1));
        if shader {
            self.ensure_scratch_backdrop(aw, ah)?;
            if clipped {
                self.ensure_scratch_mask(aw, ah)?;
            }
        }
        let mut encoder = self.take_encoder(clipped, "scope composite");
        if clipped {
            self.mask_scene.reset_and_resize(aw as u16, ah as u16);
            let shift = Affine::translate((-f64::from(dst_origin.0), -f64::from(dst_origin.1)));
            raster_clips(&mut self.mask_scene, open, shift, (aw, ah), false);
            let mask = self.scratch_mask.as_ref().expect("composite clip mask");
            let mut options = RenderOptions::default();
            options.target_init = TargetInit::Clear(ClearSettings::Viewport {
                color: AlphaColor::TRANSPARENT,
            });
            self.renderer
                .render(
                    &self.mask_scene,
                    &mut self.resources,
                    &mut encoder,
                    RenderTarget {
                        view: &mask.view,
                        depth_view: Some(&mask.depth),
                    },
                    &self.bindings,
                    options,
                )
                .map_err(vello_error)?;
        }

        for backdrop in [false, true] {
            if (backdrop && !write_backdrop) || (!backdrop && !write_main) {
                continue;
            }
            if shader && backdrop && write_main && content.isolation.unfaded_main {
                // The second plane uses a different opacity in the blend uniform.
                self.stash_encoder(encoder);
                self.submit_active_encoder();
                encoder = self.take_encoder(false, "scope backdrop composite");
            }
            let opacity = if !backdrop && content.isolation.unfaded_main {
                1.0
            } else {
                opacity
            };
            let src = content.plane(backdrop);
            let (dst_tex, dst_view, _) = self.plane(backdrop)?;
            let dst_view = dst_view.clone();
            if shader {
                let prefix = self.scratch_backdrop.as_ref().expect("composite prefix");
                let clip = clipped.then(|| &self.scratch_mask.as_ref().expect("composite clip mask").view);
                let picture = picture.map(|(mask, kind)| (&mask.plane(backdrop).view, kind));
                copy_rect(&mut encoder, dst_tex, &prefix.tex, dst_offset, src_offset, size);
                self.blend.encode(
                    &self.device,
                    &self.queue,
                    &mut encoder,
                    &src.view,
                    &prefix.view,
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
                    &self.queue,
                    &mut encoder,
                    &src.view,
                    &dst_view,
                    dst_origin,
                    scissor,
                    opacity,
                    lerp,
                );
            }
        }
        self.stash_encoder(encoder);
        if shader {
            // Submit before another composite changes the blend uniform or trims the prefix scratch.
            self.submit_active_encoder();
        }
        if write_backdrop || (write_main && root && !self.active.as_ref().expect("active draw").backdrop_live) {
            self.backdrop_gen += 1;
        }
        self.active.as_mut().expect("active draw").flush_ms += now() - t0;
        Ok(())
    }

    fn post_plane(&mut self, source: &GpuTarget, steps: &[PostStep]) -> Result<Option<GpuTarget>> {
        let t0 = now();
        let mut encoder = self.take_encoder(false, "post effects");
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
                            &self.queue,
                            &mut encoder,
                            &src.view,
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
        self.active.as_mut().expect("active draw").flush_ms += now() - t0;
        let output = if matches!(result, Ok(true)) {
            outputs.pop()
        } else {
            None
        };
        self.offscreen_pool.extend(outputs);
        result.map(|_| output)
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
                        self.tiles.drawn(key, slot, true, true);
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
        let place = |slot: u32| {
            let within = slot % PER_PAGE;
            (
                (slot / PER_PAGE) as usize,
                (within % PER_ROW) * TILE,
                (within / PER_ROW) * TILE,
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
        quads.push(quad(ax, ay, f64::from(PAGE)));
        let c = self
            .compositor
            .as_ref()
            .ok_or_else(|| EngineError::new(ErrorCode::State, "no compositor"))?;
        let bytes: Vec<u8> = quads
            .iter()
            .flat_map(|q| q.iter().flat_map(|v| v.to_le_bytes()))
            .collect();
        self.queue.write_buffer(&c.instances, 0, &bytes);
        let layout = c.over.get_bind_group_layout(0);
        let group_for = |view: &wgpu::TextureView| {
            self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("drag"),
                layout: &layout,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: wgpu::BindingResource::TextureView(view),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: wgpu::BindingResource::Sampler(&c.sampler),
                    },
                    wgpu::BindGroupEntry {
                        binding: 2,
                        resource: c.uniforms.as_entire_binding(),
                    },
                ],
            })
        };
        let scratch_group = match (dt.selection, self.scratches[self.active_scratch].as_ref()) {
            (true, Some(s)) => Some(group_for(&s.view)),
            _ => None,
        };
        let above_group = group_for(&self.pages[ap].view);
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
    /// frame's tiles, pixel for pixel.
    fn composite(&mut self, comp: &Composite, dst: usize, background: [f32; 4], w: u32, h: u32) -> Result<()> {
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
                let page = (sc.slot / PER_PAGE) as usize;
                if page >= self.pages.len() {
                    continue;
                }
                let within = sc.slot % PER_PAGE;
                let (x, y) = (
                    f64::from((within % PER_ROW) * TILE),
                    f64::from((within / PER_ROW) * TILE),
                );
                let (p, t) = (f64::from(PAGE), f64::from(TILE));
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
            let size: [f32; 4] = [w as f32, h as f32, 0.0, 0.0];
            let ub: Vec<u8> = size.iter().flat_map(|v| v.to_le_bytes()).collect();
            self.queue.write_buffer(&c.uniforms, 0, &ub);
            let layout = c.pipeline.get_bind_group_layout(0);
            let group_for = |view: &wgpu::TextureView| {
                self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: Some("composite"),
                    layout: &layout,
                    entries: &[
                        wgpu::BindGroupEntry {
                            binding: 0,
                            resource: wgpu::BindingResource::TextureView(view),
                        },
                        wgpu::BindGroupEntry {
                            binding: 1,
                            resource: wgpu::BindingResource::Sampler(&c.sampler),
                        },
                        wgpu::BindGroupEntry {
                            binding: 2,
                            resource: c.uniforms.as_entire_binding(),
                        },
                    ],
                })
            };
            // Runs of quads sharing a source, each with its bind group.
            let mut runs: Vec<(wgpu::BindGroup, u32, u32)> = Vec::new();
            let mut i = 0;
            while i < quads.len() {
                let src = quads[i].0;
                let mut j = i + 1;
                while j < quads.len() && quads[j].0 == src {
                    j += 1;
                }
                let view = match src {
                    None => &self.frames[self.cur.expect("stand-in frame")].view,
                    Some(p) => &self.pages[p].view,
                };
                runs.push((group_for(view), i as u32, j as u32));
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
            for (group, from, to) in &runs {
                pass.set_bind_group(0, group, &[]);
                pass.draw(0..4, *from..*to);
            }
        }
        for cp in &comp.copies {
            let page = (cp.slot / PER_PAGE) as usize;
            let Some(pg) = self.pages.get(page) else { continue };
            let within = cp.slot % PER_PAGE;
            let (x, y) = ((within % PER_ROW) * TILE, (within / PER_ROW) * TILE);
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
        self.queue.submit([encoder.finish()]);
        self.submits += 1;
        Ok(())
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
            pipeline,
            over,
            sampler,
            uniforms,
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
        let main = self.current()?;
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
        crate::blur::validate_sigma(spec.sigma, cb, spec.edge)?;
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
            &self.queue,
            &mut encoder,
            &src_view,
            src_size,
            &dst_view,
            dst_size,
            dst_origin,
            spec,
            key,
        ) {
            drop(encoder);
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
async fn pump<T>(
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
                let mut encoder = self.take_encoder(false, "context init");
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
        let mut encoder = self.take_encoder(false, "backdrop snapshot");
        let (source, _, _) = self.root_plane(false)?;
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
        self.flush_preserving_clips(open, true)?;
        let Some(active) = self.active.as_ref() else {
            return Ok(());
        };
        let (aw, ah) = (active.width, active.height);
        let frame_size = (aw as i32, ah as i32);
        // A lens on an explicitly blended layer reads from its parent. A child lens
        // inherits that prefix with any preceding glass-free paint from the blend scope.
        let (base, interiors) =
            exec::glass_backdrop_layers(&self.offscreen_stack, read_parent, |scope| scope.isolation);
        let backdrop_is_frame = base.is_none() && interiors.is_empty();
        let (source_origin, source_size, source_tex, source_view) = if let Some(base) = base {
            let target = self.offscreen_stack[base].plane(true);
            (
                target.origin,
                (u32::from(target.active_size.0), u32::from(target.active_size.1)),
                target.tex.clone(),
                target.view.clone(),
            )
        } else {
            let (tex, view, _) = self.root_plane(active.backdrop_live)?;
            ((0, 0), (aw, ah), tex.clone(), view.clone())
        };
        let origin = self.scene_offset();
        // Root glass writes only to the displayed plane. Inside an isolate,
        // keep its effect halo because a later filter can read those pixels.
        let output = active
            .display_area
            .filter(|_| self.offscreen_stack.is_empty())
            .unwrap_or_else(|| self.target_bounds());
        let output_origin = (output.x0, output.y0);
        let output_size = (output.x1 - output.x0, output.y1 - output.y0);

        let scale = device.determinant().abs().sqrt() as f32;
        if !(scale > 0.0 && scale.is_finite()) {
            return Ok(());
        }
        let inradius = resolve_inradius(&mut self.cpu_resources, op, paths, size);
        let params = glass::glass_params(op, scale, inradius);
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
        let mut regions = glass::compute_regions(
            op,
            &params,
            device,
            size,
            frame_size,
            output_origin,
            output_size,
            max_tex,
            glass::HARD_MAX_REGION_PIXELS,
            split_side,
            split_pixels,
            chunk_side,
        )?;
        if regions.is_empty() {
            return Ok(());
        }
        for region in &mut regions {
            let (x, y) = (output.x0 - origin.0, output.y0 - origin.1);
            region.out_x0 += x;
            region.out_x1 += x;
            region.out_y0 += y;
            region.out_y1 += y;
        }

        // Compose inherited paint in scratch so it does not become part of the isolated picture.
        // The same scratch freezes an aliased prefix before any glass chunks write into it.
        let (dst_tex, dst_view, _) = self.plane(false)?;
        let (dst_tex, dst_view) = (dst_tex.clone(), dst_view.clone());
        let source_view = if !interiors.is_empty() || (regions.len() > 1 && source_tex == dst_tex) {
            let budget = self.reader_budget_room();
            self.readers
                .ensure_blur_source_budgeted(&self.device, source_size, budget)?;
            let mut encoder = self.take_encoder(false, "glass prefix snapshot");
            let snapshot = self.readers.blur_source.as_ref().expect("glass prefix snapshot");
            let (tex, view) = (snapshot.texture.clone(), snapshot.view.clone());
            copy_rect(&mut encoder, &source_tex, &tex, (0, 0), (0, 0), source_size);
            for layer in interiors {
                let paint = self.offscreen_stack[layer].plane(true);
                let offset = (paint.origin.0 - source_origin.0, paint.origin.1 - source_origin.1);
                let visible = IRect {
                    x0: offset.0,
                    y0: offset.1,
                    x1: offset.0 + i32::from(paint.active_size.0),
                    y1: offset.1 + i32::from(paint.active_size.1),
                }
                .clamp(source_size.0 as i32, source_size.1 as i32);
                if !visible.is_empty() {
                    self.readers.encode_composite(
                        &self.device,
                        &self.queue,
                        &mut encoder,
                        &paint.view,
                        &view,
                        offset,
                        (
                            visible.x0 as u32,
                            visible.y0 as u32,
                            (visible.x1 - visible.x0) as u32,
                            (visible.y1 - visible.y0) as u32,
                        ),
                        1.0,
                        false,
                    );
                }
            }
            self.stash_encoder(encoder);
            view
        } else {
            source_view
        };

        let has_clip_mask = open.iter().any(|o| {
            matches!(
                o,
                Open::Clip {
                    active_on_scene: true,
                    context_only: false,
                    ..
                }
            )
        });
        let within = glass::clip_within_from_open(open);
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
                raster_clips(&mut self.mask_scene, open, shift, (out_w, out_h), true);
                let mut enc = self.take_encoder(true, "reader clip");
                let mut options = RenderOptions::default();
                options.target_init = TargetInit::Clear(ClearSettings::Viewport {
                    color: vello_common::color::AlphaColor::TRANSPARENT,
                });
                let clip_t = self.readers.clip_tex.as_ref().expect("clip");
                self.renderer
                    .render(
                        &self.mask_scene,
                        &mut self.resources,
                        &mut enc,
                        RenderTarget {
                            view: &clip_t.view,
                            depth_view: Some(&clip_t.depth),
                        },
                        &self.bindings,
                        options,
                    )
                    .map_err(vello_error)?;
                self.stash_encoder(enc);
                self.mask_scene.reset();
            }

            // 2. Analytic coarse coverage for box/ellipse (skips vello_gpu mask pass + submit!),
            //    or shape mask rasterized with vello_gpu into `mask_tex`.
            let analytic_coarse = if coarse && (op.kind == glass::KIND_BOX || op.kind == glass::KIND_ELLIPSE) {
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

            let mut encoder = self.take_encoder(analytic_coarse.is_none(), "reader glass");

            if analytic_coarse.is_none() {
                self.readers.ensure_vello_tex_budgeted(
                    false,
                    &self.device,
                    &self.renderer,
                    region.rw,
                    region.rh,
                    "reader mask",
                    max_bytes,
                )?;
                self.mask_scene.reset_and_resize(region.rw as u16, region.rh as u16);
                let shifted = Affine::translate((-f64::from(region.x0), -f64::from(region.y0))) * device;
                self.mask_scene.set_transform(shifted);
                self.mask_scene.set_paint(vello_common::color::palette::css::WHITE);
                for (p, even_odd) in paths {
                    self.mask_scene
                        .set_fill_rule(if *even_odd { Fill::EvenOdd } else { Fill::NonZero });
                    self.mask_scene.fill_path(p);
                }
                {
                    let mut options = RenderOptions::default();
                    options.target_init = TargetInit::Clear(ClearSettings::Viewport {
                        color: vello_common::color::AlphaColor::TRANSPARENT,
                    });
                    let mask_t = self.readers.mask_tex.as_ref().expect("mask");
                    self.renderer
                        .render(
                            &self.mask_scene,
                            &mut self.resources,
                            &mut encoder,
                            RenderTarget {
                                view: &mask_t.view,
                                depth_view: Some(&mask_t.depth),
                            },
                            &self.bindings,
                            options,
                        )
                        .map_err(vello_error)?;
                }
                self.mask_scene.reset();
            }

            self.readers.encode_glass(
                &self.device,
                &self.queue,
                &mut encoder,
                &source_view,
                &dst_tex,
                &dst_view,
                source_size,
                frame_size,
                (-source_origin.0, -source_origin.1),
                (-origin.0, -origin.1),
                self.backdrop_gen,
                backdrop_is_frame,
                &params,
                region,
                within,
                alpha,
                coarse,
                analytic_coarse,
                has_clip_mask,
                max_bytes,
            )?;

            self.stash_encoder(encoder);
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
        let mut encoder = self.take_encoder(false, "isolation init");
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
        validate_sigma(
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

                    self.submit_active_encoder();
                    self.mask_scene.reset_and_resize(cw as u16, ch as u16);
                    self.mask_scene.set_transform(Affine::translate((
                        -f64::from(canon.mask_rect.x0),
                        -f64::from(canon.mask_rect.y0),
                    )));
                    self.mask_scene.set_paint(AlphaColor::<Srgb>::new([1.0, 1.0, 1.0, 1.0]));
                    self.mask_scene.set_fill_rule(Fill::NonZero);
                    self.mask_scene.fill_path(&canon.path);

                    let mut encoder = self.device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
                        label: Some("shadow cache"),
                    });
                    let res = (|| -> Result<()> {
                        let mask_tex = self.scratch_mask.as_ref().expect("scratch_mask");
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
                        self.renderer
                            .render(
                                &self.mask_scene,
                                &mut self.resources,
                                &mut encoder,
                                RenderTarget {
                                    view: &mask_tex.view,
                                    depth_view: Some(&mask_tex.depth),
                                },
                                &self.bindings,
                                options,
                            )
                            .map_err(vello_error)?;
                        if !invert {
                            self.blur.encode(
                                &self.device,
                                &self.queue,
                                &mut encoder,
                                &mask_tex.view,
                                (mask_tex.width, mask_tex.height),
                                &view,
                                (cw, ch),
                                (0, 0),
                                &spec,
                                None,
                            )?;
                        } else {
                            let blur_tex = self.scratch_blur.as_ref().expect("scratch_blur");
                            self.blur.encode(
                                &self.device,
                                &self.queue,
                                &mut encoder,
                                &mask_tex.view,
                                (mask_tex.width, mask_tex.height),
                                &blur_tex.view,
                                (cw, ch),
                                (0, 0),
                                &spec,
                                None,
                            )?;
                            self.shadow
                                .encode_invert_alpha(&self.device, &mut encoder, &blur_tex.view, &view, cw, ch);
                        }
                        Ok(())
                    })();
                    if let Err(e) = res {
                        drop(encoder);
                        self.blur.flush_retired();
                        tex.destroy();
                        return Err(e);
                    }
                    self.queue.submit([encoder.finish()]);
                    self.submits += 1;
                    self.blur.flush_retired();
                    if let Some(root) = self.active.as_mut() {
                        root.flush_ms += now() - t0;
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
        let mask_rect_opt = match cast {
            ShadowCast::Fill { paths, .. } => compute_mask_rect(paths, dirty, sigma, max_tex),
            ShadowCast::Stroke { bbox, .. } => compute_mask_rect_bounds(*bbox, dirty, sigma, max_tex),
        };
        let Some(mask_rect) = mask_rect_opt else {
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
        let mask_w = (mask_rect.x1 - mask_rect.x0).max(1) as u32;
        let mask_h = (mask_rect.y1 - mask_rect.y0).max(1) as u32;
        let dirty_w = (dirty.x1 - dirty.x0).max(1) as u32;
        let dirty_h = (dirty.y1 - dirty.y0).max(1) as u32;
        let shift = shadow_raster_shift(sigma);
        let dst_origin = (dirty.x0 - mask_rect.x0, dirty.y0 - mask_rect.y0);

        let t0 = now();
        self.submit_active_encoder();
        let temp = self.acquire_temp(dirty_w, dirty_h)?;
        let res = (|| -> Result<wgpu::CommandEncoder> {
            if shift == 0 {
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
                let base_shift = Affine::translate((-f64::from(mask_rect.x0), -f64::from(mask_rect.y0)));
                self.mask_scene.set_paint(AlphaColor::<Srgb>::new([1.0, 1.0, 1.0, 1.0]));
                match cast {
                    ShadowCast::Fill { paths, even_odd } => {
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
                let mut encoder = self
                    .device
                    .create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("shadow") });
                let mask_tex = self.scratch_mask.as_ref().expect("scratch_mask");
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
                self.renderer
                    .render(
                        &self.mask_scene,
                        &mut self.resources,
                        &mut encoder,
                        RenderTarget {
                            view: &mask_tex.view,
                            depth_view: Some(&mask_tex.depth),
                        },
                        &self.bindings,
                        options,
                    )
                    .map_err(vello_error)?;
                if !invert {
                    self.blur.encode(
                        &self.device,
                        &self.queue,
                        &mut encoder,
                        &mask_tex.view,
                        (mask_tex.width, mask_tex.height),
                        &temp.view,
                        (dirty_w, dirty_h),
                        dst_origin,
                        &spec,
                        None,
                    )?;
                } else {
                    let blur_tex = self.scratch_blur.as_ref().expect("scratch_blur");
                    self.blur.encode(
                        &self.device,
                        &self.queue,
                        &mut encoder,
                        &mask_tex.view,
                        (mask_tex.width, mask_tex.height),
                        &blur_tex.view,
                        (dirty_w, dirty_h),
                        dst_origin,
                        &spec,
                        None,
                    )?;
                    self.shadow.encode_invert_alpha(
                        &self.device,
                        &mut encoder,
                        &blur_tex.view,
                        &temp.view,
                        dirty_w,
                        dirty_h,
                    );
                }
                Ok(encoder)
            } else {
                let s = 1u32 << shift;
                let sw = (mask_w / s).max(1);
                let sh = (mask_h / s).max(1);
                let (red_origin, (bd_w, bd_h)) = reduced_dirty_rect(mask_rect, dirty, shift);
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
                let red_tf = Affine::scale(1.0 / f64::from(s))
                    * Affine::translate((-f64::from(mask_rect.x0), -f64::from(mask_rect.y0)));
                self.mask_scene.set_paint(AlphaColor::<Srgb>::new([1.0, 1.0, 1.0, 1.0]));
                match cast {
                    ShadowCast::Fill { paths, even_odd } => {
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
                let mut encoder = self.device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
                    label: Some("shadow reduced"),
                });
                let mask_tex = self.scratch_mask.as_ref().expect("scratch_mask");
                let blur_tex = self.scratch_blur.as_ref().expect("scratch_blur");
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
                self.renderer
                    .render(
                        &self.mask_scene,
                        &mut self.resources,
                        &mut encoder,
                        RenderTarget {
                            view: &mask_tex.view,
                            depth_view: Some(&mask_tex.depth),
                        },
                        &self.bindings,
                        options,
                    )
                    .map_err(vello_error)?;
                self.blur.encode(
                    &self.device,
                    &self.queue,
                    &mut encoder,
                    &mask_tex.view,
                    (mask_tex.width, mask_tex.height),
                    &blur_tex.view,
                    (bd_w, bd_h),
                    red_origin,
                    &spec,
                    None,
                )?;
                self.shadow.encode_upsample_mask(
                    &self.device,
                    &self.queue,
                    &mut encoder,
                    &blur_tex.view,
                    (blur_tex.width, blur_tex.height),
                    (bd_w, bd_h),
                    red_origin,
                    &temp.view,
                    (dirty_w, dirty_h),
                    dst_origin,
                    shift,
                    invert,
                );
                Ok(encoder)
            }
        })();
        let encoder = match res {
            Ok(enc) => enc,
            Err(e) => {
                self.blur.flush_retired();
                self.temp_pool.push(temp);
                return Err(e);
            }
        };
        self.queue.submit([encoder.finish()]);
        self.submits += 1;
        self.blur.flush_retired();
        if let Some(root) = self.active.as_mut() {
            root.flush_ms += now() - t0;
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
        let scale = device.determinant().abs().sqrt() as f32;
        if !(scale > 0.0 && scale.is_finite()) {
            return Ok(());
        }
        let Some(draw) = self.prepare_blur_reader(paths, device, coarse, open)? else {
            return Ok(());
        };
        let analytic = if coarse {
            analytic_box_from_paths(paths, device, size, draw.frame_dirty_origin())
        } else {
            None
        };
        let (mut encoder, clipped) = self.encode_blur_reader_masks(&draw, paths, device, analytic.is_some(), open)?;
        let sigma = blur::sigma_from_radius(op.radius) * scale;
        let within = glass::clip_within_from_open(open);
        if coarse {
            let budget = self.reader_budget_room();
            self.readers.encode_coarse_blur(
                &self.device,
                &self.queue,
                &mut encoder,
                &draw.source.view,
                draw.targets.iter().flatten().map(|t| (&t.texture, &t.view)),
                draw.size,
                draw.frame_size,
                (-draw.origin.0, -draw.origin.1),
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
            let (width, height) = draw.dirty_size();
            let budget = self.reader_budget_room();
            self.readers
                .ensure_blur_out_budgeted(&self.device, width, height, budget)?;
            let (clamp_bounds, edge) = draw.bounds_and_edge(within, sigma);
            let key = draw
                .source_is_frame
                .then(|| blur::PyramidKey::new(self.backdrop_gen, clamp_bounds, edge));
            let spec = BlurSpec {
                sigma,
                edge,
                clamp_bounds,
                dirty: draw.dirty,
            };
            self.encode_blur_reader_slice(
                &mut encoder,
                &draw.source.view,
                draw.size,
                (draw.dirty.x0, draw.dirty.y0),
                &spec,
                key,
            )?;
            let budget = self.reader_budget_room();
            for target in draw.targets.iter().flatten() {
                self.readers.encode_bg_blur_composite(
                    &self.device,
                    &self.queue,
                    &mut encoder,
                    &target.texture,
                    &target.view,
                    draw.dirty,
                    alpha,
                    clipped,
                    budget,
                )?;
            }
        }
        if draw.source_is_frame && draw.source_written {
            self.backdrop_gen += 1;
        }
        self.stash_encoder(encoder);
        Ok(())
    }

    fn progressive_blur(
        &mut self,
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
        let scale = device.determinant().abs().sqrt() as f32;
        if !(scale > 0.0 && scale.is_finite()) {
            return Ok(());
        }
        let plan = progressive_blur::ProgressivePlan::new(op, device, size, scale);
        let plan = match plan {
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
                return self.background_blur(&uniform, paths, device, size, alpha, coarse, open);
            }
        };
        let Some(draw) = self.prepare_blur_reader(paths, device, false, open)? else {
            return Ok(());
        };
        let (mut encoder, clipped) = self.encode_blur_reader_masks(&draw, paths, device, false, open)?;
        let (clamp_bounds, edge) =
            draw.bounds_and_edge(glass::clip_within_from_open(open), plan.start_sigma.max(plan.end_sigma));
        let key = draw
            .source_is_frame
            .then(|| blur::PyramidKey::new(self.backdrop_gen, clamp_bounds, edge));
        let cols = (plan.stops.len() as u32).clamp(1, 4);
        let rows = (plan.stops.len() as u32).div_ceil(cols).max(1);
        let tile_side = progressive_blur::PROGRESSIVE_TILE_MAX
            .min(self.max_texture_2d / 4)
            .max(1);
        let (width, height) = draw.dirty_size();
        let budget = self.reader_budget_room();
        self.readers.ensure_blur_out_budgeted(
            &self.device,
            width.min(tile_side) * cols,
            height.min(tile_side) * rows,
            budget,
        )?;
        // Each tile reads the same prefix. Keep a copy when a previous tile can have
        // replaced part of the source used by the next tile's Gaussian.
        let source = if draw.source_written && (width > tile_side || height > tile_side) {
            let budget = self.reader_budget_room();
            self.readers
                .ensure_blur_source_budgeted(&self.device, draw.size, budget)?;
            let snapshot = self.readers.blur_source.as_ref().expect("blur reader source");
            copy_rect(
                &mut encoder,
                &draw.source.texture,
                &snapshot.texture,
                (0, 0),
                (0, 0),
                draw.size,
            );
            &snapshot.view
        } else {
            &draw.source.view
        }
        .clone();

        let dirty = draw.dirty;
        let side = tile_side as i32;
        for y0 in (dirty.y0..dirty.y1).step_by(tile_side as usize) {
            for x0 in (dirty.x0..dirty.x1).step_by(tile_side as usize) {
                let tile = IRect {
                    x0,
                    y0,
                    x1: (x0 + side).min(dirty.x1),
                    y1: (y0 + side).min(dirty.y1),
                };
                let (tw, th) = (tile.x1 - x0, tile.y1 - y0);
                for (stop, &sigma) in plan.stops.iter().enumerate() {
                    let col = (stop as u32 % cols) as i32;
                    let row = (stop as u32 / cols) as i32;
                    let spec = BlurSpec {
                        sigma,
                        edge,
                        clamp_bounds,
                        dirty: tile,
                    };
                    self.encode_blur_reader_slice(
                        &mut encoder,
                        &source,
                        draw.size,
                        (x0 - col * tw, y0 - row * th),
                        &spec,
                        key,
                    )?;
                }
                let budget = self.reader_budget_room();
                for target in draw.targets.iter().flatten() {
                    self.readers.encode_progressive_composite(
                        &self.device,
                        &self.queue,
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
                        budget,
                    )?;
                }
            }
        }
        if draw.source_is_frame && draw.source_written {
            self.backdrop_gen += 1;
        }
        self.stash_encoder(encoder);
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
