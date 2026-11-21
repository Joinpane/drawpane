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
//! - Backdrop readers are phase 3 here (`read` refuses), as everywhere outside the tests.

use crate::engine::{DragFrame, TiledOptions};
use crate::error::{EngineError, ErrorCode, Result};
use crate::exec::{self, Backend, DrawStats, Frame, GlyphMask, IRect, ImageView, Open, impl_draw};
use crate::exec::{Pass, Split};
use crate::images::{self, Level};
use crate::masks::{self, MaskCache, MaskKey};
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
use vello_common::geometry::RectU16;
use vello_common::kurbo::{Affine, BezPath, Rect};
use vello_common::paint::{ImageSource, TextureRegion};
use vello_gpu::{
    ClearSettings, RenderOptions, RenderSize, RenderTarget, RenderTargetConfig, Renderer, Resources, Scene, TargetInit,
    TextureBindings,
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
const TEMP_ID_BASE: u64 = (1 << 48) + 1024;

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
    errors: Mutex<Vec<String>>,
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

    fn record_error(&self, message: String) {
        if let Ok(mut list) = self.errors.lock()
            && list.len() < 16
        {
            list.push(message);
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
  o.pos = vec4<f32>(p.x / u.size.x * 2.0 - 1.0, 1.0 - p.y / u.size.y * 2.0, 0.0, 1.0);
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

/// Read-backs in flight: how many, and the bytes of their buffers (held against the budget).
#[derive(Default)]
pub struct Flights {
    count: Cell<u32>,
    bytes: Cell<usize>,
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
    bindings: TextureBindings,
    scene: Scene,
    /// Frame textures: the one shown (`cur`) and the one being made.
    frames: Vec<Main>,
    cur: usize,
    /// The board textures (decision 0040, phase 2): which tiles are held, where, and how fresh.
    pub tiles: TileCache,
    pages: Vec<Page>,
    /// The tile every tile is drawn into, with its depth buffer, then copied to its slot (or
    /// straight into the frame, for a frame whose tiles don't fit the budget).
    scratch: Option<(wgpu::Texture, wgpu::TextureView, wgpu::TextureView)>,
    compositor: Option<Compositor>,
    diamond: Option<DiamondPipeline>,
    /// The frame shown: what it was drawn for, so the next may stand on it.
    last: Option<Last>,
    last_scale: Option<f64>,
    /// The engine's generation and background the frame shown was made at, and whether it's exact.
    shown: Option<(u64, [u32; 4], bool)>,
    /// Milliseconds a tile has lately taken to draw (a running average).
    tile_ms: f64,
    blit: Option<wgpu::RenderPipeline>,
    images: HashMap<u32, Vec<(TextureId, wgpu::Texture, u32, u32)>>,
    /// Per-draw temporary textures (e.g. diamond gradients), released right after submit.
    temp_textures: Vec<(TextureId, wgpu::Texture)>,
    temp_bytes: usize,
    next_temp_id: u64,
    image_bytes: usize,
    atlas: Atlas,
    pub masks: MaskCache<Arc<vello_cpu::Pixmap>>,
    mask_side: u32,
    /// Rasterises glyph masks (on the CPU, as the CPU backend does: the same coverage).
    raster: masks::Rasterizer,
    /// Reusable reference Gaussian blur pass and shareable GPU blur pyramids.
    pub blur: crate::blur::gpu::GpuBlur,
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
        if let Some((tex, _, _)) = self.scratch.take() {
            tex.destroy();
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
                h.record_error(e.to_string());
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
            bindings,
            scene: Scene::new(1, 1),
            frames: Vec::new(),
            cur: 0,
            tiles: TileCache::new(TILE, 0),
            pages: Vec::new(),
            scratch: None,
            compositor: None,
            diamond: None,
            last: None,
            last_scale: None,
            shown: None,
            tile_ms: 0.0,
            blit,
            images: HashMap::new(),
            temp_textures: Vec::new(),
            temp_bytes: 0,
            next_temp_id: TEMP_ID_BASE,
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

    /// GPU memory the engine has allocated.
    pub fn bytes(&self) -> usize {
        self.bytes + self.blur.bytes()
    }

    /// Refuses an allocation of `bytes` (beside `freed`, about to go) past the budget.
    fn reserve(&self, bytes: usize, freed: usize, what: &str) -> Result<()> {
        // Read-back buffers in flight count until they land.
        let held = self.bytes() + self.readbacks.bytes.get();
        if held - freed + bytes > self.budget {
            return Err(EngineError::limit(format!(
                "{what} would take the engine's GPU memory to {} MiB; the most is {} MiB",
                (held - freed + bytes) >> 20,
                self.budget >> 20
            )));
        }
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
            let all = list.join("; ");
            list.clear();
            return Err(EngineError::new(ErrorCode::Gpu, all));
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

    /// Bytes frames of this size take on the GPU: `FRAMES` textures (no depth buffers: tiles are
    /// drawn into pages, frames only composited), and the canvas's own textures (two in flight).
    fn frame_bytes(width: u32, height: u32, presents: bool) -> usize {
        let px = width as usize * height as usize * 4;
        px * FRAMES + if presents { px * 2 } else { 0 }
    }

    fn ensure_frames(&mut self, width: u32, height: u32) -> Result<()> {
        self.check_texture_size(width, height, "a frame")?;
        if self
            .frames
            .first()
            .is_some_and(|m| m.width == width && m.height == height)
        {
            return Ok(());
        }
        let presents = self.surface.is_some();
        let freed = self
            .frames
            .first()
            .map_or(0, |m| Self::frame_bytes(m.width, m.height, presents));
        self.reserve(Self::frame_bytes(width, height, presents), freed, "a frame")?;
        for m in self.frames.drain(..) {
            m.texture.destroy();
        }
        self.bytes = self.bytes - freed + Self::frame_bytes(width, height, presents);
        for _ in 0..FRAMES {
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
            self.frames.push(Main {
                view,
                texture: tex,
                present_group,
                width,
                height,
            });
        }
        self.cur = 0;
        self.forget_last();
        if let Some((surface, config)) = self.surface.as_mut() {
            config.width = width;
            config.height = height;
            surface.configure(&self.device, config);
        }
        Ok(())
    }

    /// The frame shown now (presented or read back).
    fn current(&self) -> Result<&Main> {
        self.frames
            .get(self.cur)
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

    /// The scratch tile and its depth buffer, made on first use.
    fn ensure_scratch(&mut self) -> Result<()> {
        if self.scratch.is_none() {
            self.check_texture_size(TILE, TILE, "the scratch tile")?;
            let bytes = (TILE * TILE * 4 * 2) as usize;
            self.reserve(bytes, 0, "the scratch tile")?;
            let tex = texture(
                &self.device,
                TILE,
                TILE,
                // Sampled too: a drag's selection is laid over the frame from it.
                wgpu::TextureUsages::RENDER_ATTACHMENT
                    | wgpu::TextureUsages::COPY_SRC
                    | wgpu::TextureUsages::TEXTURE_BINDING,
                "scratch tile",
            );
            let depth = self.renderer.create_depth_texture_view(&RenderSize {
                width: TILE as u16,
                height: TILE as u16,
            });
            self.scratch = Some((tex.clone(), tex.create_view(&Default::default()), depth));
            self.bytes += bytes;
        }
        Ok(())
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
        let (w, h) = (u32::from(frame.width), u32::from(frame.height));
        self.ensure_frames(w, h)?;
        self.ensure_compositor();
        self.masks.begin_frame();
        self.blur.begin_frame();
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
        let bg_bits = background.map(f32::to_bits);
        self.tiles.opening = opening;
        let mut plan = self
            .tiles
            .plan(view, (w, h), zooming || opening, last, options.prefetch)
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
            return self.finish_frame(stats, t0);
        }
        let dst = (self.cur + 1) % FRAMES;
        let mut verbs = store.limits.frame_verbs;
        let mut drew_any = false;
        let mut direct_exact = true;
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
                self.ensure_scratch()?;
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
            let exact = self.draw_job(store, job, background, target, &plan, dst, &mut stats, &mut verbs)?;
            drew_any = true;
            // What a tile costs lately (a running average), for moving frames' budget.
            let took = now() - t0 - elapsed;
            self.tile_ms = self.tile_ms * 0.75 + took * 0.25;
            match target {
                TileTarget::Slot(s) => self.tiles.drawn(job.key, s, exact, !job.detail),
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
            if !late.is_empty() {
                self.ensure_scratch()?;
            }
            for job in &late {
                direct_exact &= self.draw_job(
                    store,
                    job,
                    background,
                    TileTarget::Scratch,
                    &plan,
                    dst,
                    &mut stats,
                    &mut verbs,
                )?;
            }
            if let (Some(now), Some(split)) = (selection, drag.and_then(|d| d.split.as_ref())) {
                let dragged = self.drag_composite(store, &plan, now, split, background, dst, &mut stats);
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
        self.cur = dst;
        self.last = Some(Last { view, size: (w, h) });
        self.last_scale = Some(scale);
        self.shown = Some((generation, bg_bits, stats.exact));
        self.finish_frame(stats, t0)
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
        self.tiles.begin(background, halo);
        self.fit_tiles(store.limits.tile_bytes);
        let Some(plan) = self.tiles.plan(last.view, last.size, false, Some(last), true) else {
            return Ok(stats);
        };
        let mut verbs = store.limits.frame_verbs;
        let dst = self.cur;
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
    fn finish_frame(&mut self, mut stats: DrawStats, t0: f64) -> Result<DrawStats> {
        let t1 = now();
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
            let main = self.current()?;
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

    /// Draws one tile: the scene under its view, `TILE` × `TILE` pixels, into its slot (or the
    /// scratch tile, then straight into frame texture `dst` where the frame shows it). Answers
    /// whether it was drawn exactly (no level of detail stood in).
    #[allow(clippy::too_many_arguments)]
    fn draw_tile(
        &mut self,
        store: &Store,
        view: Affine,
        detail: bool,
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
        // Each tile is its own render and submission: masks the tiles before it drew from may go
        // now, and its run images pack from the atlas's top left again (the draws before run
        // before any upload made after them).
        self.masks.begin_frame();
        self.atlas.at = (0, 0, 0);
        self.scene.reset_and_resize(TILE as u16, TILE as u16);
        let tile = Frame {
            width: TILE as u16,
            height: TILE as u16,
            view,
            detail,
            area: IRect {
                x0: 0,
                y0: 0,
                x1: TILE as i32,
                y1: TILE as i32,
            },
        };
        let limits = store.limits;
        let s = match exec::draw_split(store, self, &tile, &limits, verbs, split) {
            Ok(s) => s,
            Err(e) => {
                self.release_temp_textures();
                return Err(e);
            }
        };
        stats.add(&s);
        // Exact only if nothing stood in: no level of detail, no provisional record.
        let exact = s.exact();
        let t1 = now();
        // Every tile is drawn into the scratch tile, a target of its own size (Vello's work per
        // render follows its target's size, so a page as the target would cost a page's worth
        // for each tile), then copied where it goes. The same scene and view either way: the
        // same pixels.
        if let Err(e) = self.ensure_scratch() {
            self.release_temp_textures();
            return Err(e);
        }
        let place = match target {
            TileTarget::Slot(slot) => match self.slot_place(slot) {
                Ok(p) => Some(p),
                Err(e) => {
                    self.release_temp_textures();
                    return Err(e);
                }
            },
            TileTarget::Scratch | TileTarget::ScratchOnly => None,
        };
        // The masks this tile placed reach the atlas before it renders.
        self.flush_masks();
        let only = matches!(target, TileTarget::ScratchOnly);
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("tile") });
        let mut options = RenderOptions::default();
        let [r, g, b, a] = background;
        let color = vello_common::color::AlphaColor::new([r, g, b, a]);
        options.target_init = TargetInit::Clear(ClearSettings::Viewport { color });
        let (scratch, view_t, depth_t) = match self.scratch.as_ref() {
            Some(s) => s,
            None => {
                self.release_temp_textures();
                return Err(EngineError::new(ErrorCode::State, "no scratch tile"));
            }
        };
        let render_res = self
            .renderer
            .render(
                &self.scene,
                &mut self.resources,
                &mut encoder,
                RenderTarget {
                    view: view_t,
                    depth_view: Some(depth_t),
                },
                &self.bindings,
                options,
            )
            .map_err(|e| EngineError::new(ErrorCode::Gpu, format!("{e:?}")));
        if let Err(e) = render_res {
            self.release_temp_textures();
            return Err(e);
        }
        // Where it goes: its slot in a page, or (drawn direct) where the frame shows it.
        let (dst_tex, src, dst, size) = match place {
            Some((p, x, y)) => (&self.pages[p].texture, (0, 0), (x, y), (TILE, TILE)),
            None => {
                let t = i64::from(TILE);
                let fx = i64::from(key.i) * t + plan.origin.0;
                let fy = i64::from(key.j) * t + plan.origin.1;
                let (fw, fh) = (i64::from(plan.size.0), i64::from(plan.size.1));
                let (x0, y0) = (fx.max(0), fy.max(0));
                let (x1, y1) = ((fx + t).min(fw), (fy + t).min(fh));
                if x1 <= x0 || y1 <= y0 {
                    (&self.frames[dst].texture, (0, 0), (0, 0), (0, 0))
                } else {
                    (
                        &self.frames[dst].texture,
                        ((x0 - fx) as u32, (y0 - fy) as u32),
                        (x0 as u32, y0 as u32),
                        ((x1 - x0) as u32, (y1 - y0) as u32),
                    )
                }
            }
        };
        if !only && size.0 > 0 && size.1 > 0 {
            encoder.copy_texture_to_texture(
                wgpu::TexelCopyTextureInfo {
                    texture: scratch,
                    mip_level: 0,
                    origin: wgpu::Origin3d {
                        x: src.0,
                        y: src.1,
                        z: 0,
                    },
                    aspect: wgpu::TextureAspect::All,
                },
                wgpu::TexelCopyTextureInfo {
                    texture: dst_tex,
                    mip_level: 0,
                    origin: wgpu::Origin3d {
                        x: dst.0,
                        y: dst.1,
                        z: 0,
                    },
                    aspect: wgpu::TextureAspect::All,
                },
                wgpu::Extent3d {
                    width: size.0,
                    height: size.1,
                    depth_or_array_layers: 1,
                },
            );
        }
        // One render per submission: the renderer writes its buffers through the queue, which a
        // second render in the same encoder would overwrite before the first ran.
        self.queue.submit([encoder.finish()]);
        self.submits += 1;
        self.release_temp_textures();
        stats.encode_ms += t1 - t0;
        stats.render_ms += now() - t1;
        Ok(exact)
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
        background: [f32; 4],
        dst: usize,
        stats: &mut DrawStats,
    ) -> Result<()> {
        let Some(level) = self.tiles.level(plan.level) else {
            return Ok(());
        };
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
                            self.ensure_scratch()?;
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
            quads.push(quad(0, 0, f64::from(TILE)));
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
        let scratch_group = match (dt.selection, self.scratch.as_ref()) {
            (true, Some((_, v, _))) => Some(group_for(v)),
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
                    .frames
                    .get(self.cur)
                    .is_some_and(|f| f.width == l.size.0 && f.height == l.size.1)
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
                    None => &self.frames[self.cur].view,
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
    /// `read_back` (which takes the in-flight count it answers). At most `READBACKS` at once.
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
        &mut self.scene
    }

    fn image(&mut self, id: u32, px: f64) -> Option<ImageView> {
        let levels = self.images.get(&id)?;
        let i = images::pick(levels.iter().map(|l| l.2), px);
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
        let tid = TextureId(self.next_temp_id);
        self.next_temp_id = self.next_temp_id.wrapping_add(1).max(TEMP_ID_BASE);
        self.bindings.insert(tid, view);
        self.temp_textures.push((tid, tex));
        Ok(Some(ImageSource::external_texture(tid, TextureRegion::Full, true)))
    }

    fn read(&mut self, kernel: u32, _paints: IRect, _reads: IRect, _open: &[Open]) -> Result<()> {
        Err(EngineError::unsupported(format!(
            "backdrop reader {kernel} on the GPU (phase 3)"
        )))
    }
}
