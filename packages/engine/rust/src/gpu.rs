//! The GPU backend: vello_gpu on wgpu's WebGPU backend (the browser build).
//!
//! - The frame is drawn into an RGBA8 texture of the engine's own (`main`), then copied to the
//!   canvas's surface by one full-screen pass. Tests and the GPU bench read `main` back through
//!   a buffer (`copy_texture_to_buffer`), never through the canvas: a WebGPU canvas copied into a
//!   2D canvas can come back empty on headless drivers.
//! - Images are textures, one per level, uploaded once. Glyph masks are rasterised by vello_cpu
//!   (`masks.rs`, the same coverage as the CPU backend) and packed into one atlas texture, whose
//!   space comes back a shelf at a time (`atlas.rs`).
//! - Everything the engine allocates on the GPU (images, the atlas, the frame and its depth
//!   buffer, read-back buffers) is counted against `Limits::gpu_bytes`, and at most two
//!   read-backs are in flight.
//! - A frame the canvas can't take (its surface lost, or a validation error getting its texture)
//!   is a failure, after one reconfiguration: the caller keeps or draws a picture another way,
//!   never a blank canvas.
//! - Errors never panic: wgpu's uncaptured errors and device loss are recorded and turned into
//!   `ErrorCode::Gpu` and `ErrorCode::DeviceLost` on the next call, so the editor falls back.
//! - Backdrop readers are phase 3 here (`read` refuses), as everywhere outside the tests.

use crate::atlas::{Placed, Shelves};
use crate::engine::TiledOptions;
use crate::error::{EngineError, ErrorCode, Result};
use crate::exec::{self, Backend, DrawStats, Frame, GlyphMask, IRect, ImageView, Open, impl_draw};
use crate::images::{self, Level};
use crate::masks::{self, MaskCache, MaskKey};
use crate::store::Store;
use crate::tiles::{Composite, Last, TILE, TileCache, TileKey};
use std::cell::Cell;
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use vello_common::TextureId;
use vello_common::geometry::RectU16;
use vello_common::kurbo::{Affine, BezPath, Rect};
use vello_common::paint::{ImageSource, TextureRegion};
use vello_gpu::{
    ClearSettings, RenderOptions, RenderSize, RenderTarget, RenderTargetConfig, Renderer, Resources, Scene, TargetInit,
    TextureBindings,
};

impl_draw!(Scene);

const FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;
const ATLAS_SIDE: u32 = 2048;
/// The glyph atlas's bytes: the masks a GPU keeps by default.
pub const ATLAS_BYTES: usize = (ATLAS_SIDE * ATLAS_SIDE * 4) as usize;
const ATLAS_ID: TextureId = TextureId(1 << 48);
const CHECKER_ID: TextureId = TextureId((1 << 48) + 1);

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

/// What wgpu reports out of band: uncaptured errors and the device's loss.
#[derive(Default)]
pub struct Health {
    errors: Mutex<Vec<String>>,
    lost: AtomicBool,
    lost_reason: Mutex<String>,
}

struct Main {
    texture: wgpu::Texture,
    view: wgpu::TextureView,
    width: u32,
    height: u32,
}

/// The glyph atlas: one texture, and its shelves.
struct Atlas {
    texture: wgpu::Texture,
    shelves: Shelves,
    /// Masks placed and not uploaded yet: x, y, width, height, pixels (`flush_masks`).
    pending: Vec<(u32, u32, u32, u32, Vec<u8>)>,
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
    sampler: wgpu::Sampler,
    uniforms: wgpu::Buffer,
    instances: wgpu::Buffer,
    capacity: usize,
}

/// Where a tile is drawn: a slot in a page, or the scratch tile (a frame drawn direct).
#[derive(Clone, Copy)]
enum TileTarget {
    Slot(u32),
    Scratch,
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
    /// The frame shown: what it was drawn for, so the next may stand on it.
    last: Option<Last>,
    last_scale: Option<f64>,
    /// The engine's generation and background the frame shown was made at, and whether it's exact.
    shown: Option<(u64, [u32; 4], bool)>,
    blit: Option<wgpu::RenderPipeline>,
    images: HashMap<u32, Vec<(TextureId, wgpu::Texture, u32, u32)>>,
    image_bytes: usize,
    atlas: Atlas,
    pub masks: MaskCache<RectU16>,
    mask_side: u32,
    cpu_resources: vello_cpu::Resources,
    pub health: Arc<Health>,
    pub adapter: String,
    pub fallback_adapter: bool,
    /// Command buffers submitted, for the report.
    pub submits: u32,
    /// GPU memory allocated (`Limits::gpu_bytes`), and the budget.
    bytes: usize,
    pub budget: usize,
    /// Read-backs in flight.
    readbacks: Rc<Flights>,
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

impl Gpu {
    /// A coverage mask for `key` (a glyph's or a run's), made if it isn't held and fits within
    /// `side` device pixels a side.
    fn mask_with(
        &mut self,
        key: MaskKey,
        path: &BezPath,
        scale: (f64, f64),
        phase: (f64, f64),
        side: u32,
    ) -> Option<GlyphMask> {
        let source = |r: RectU16| ImageSource::external_texture(ATLAS_ID, TextureRegion::Rect(r), true);
        let frame = self.masks.frame();
        if let Some(e) = self.masks.get(&key) {
            let (rect, origin, size) = (e.value, e.origin, e.size);
            self.atlas.shelves.touch(u32::from(rect.y0), frame);
            return Some((source(rect), origin, size));
        }
        // Room first (in the budget, then the atlas), so a mask that can't be kept isn't
        // rasterised: that glyph is drawn as its outline.
        let (w, h) = masks::mask_size(path, scale.0, scale.1, phase, side)?;
        if !self.masks.fits(masks::bytes((w, h))) {
            self.masks.stats.outlines += 1;
            return None;
        }
        let (x, y) = match self.atlas.shelves.place(u32::from(w), u32::from(h), frame) {
            Some(Placed::At { x, y }) => (x, y),
            Some(Placed::Reused { x, y, shelf_y, shelf_h }) => {
                let (y0, y1) = (shelf_y, shelf_y + shelf_h);
                self.masks
                    .evict_where(|r: &RectU16| u32::from(r.y0) >= y0 && u32::from(r.y0) < y1);
                (x, y)
            }
            None => {
                self.masks.stats.outlines += 1;
                return None;
            }
        };
        let (mask, origin) = masks::rasterise(&mut self.cpu_resources, path, scale.0, scale.1, phase, side)?;
        if (mask.width(), mask.height()) != (w, h) {
            return None;
        }
        // Uploaded with the tile's other new masks, a write per shelf (`flush_masks`).
        self.atlas
            .pending
            .push((x, y, u32::from(w), u32::from(h), mask.data_as_u8_slice().to_vec()));
        let rect = RectU16 {
            x0: x as u16,
            y0: y as u16,
            x1: (x + u32::from(w)) as u16,
            y1: (y + u32::from(h)) as u16,
        };
        let e = self.masks.insert(key, rect, origin, (w, h));
        Some((source(e.value), e.origin, e.size))
    }

    /// A WebGPU device and, given a canvas, a surface on it. In compatibility mode the caller
    /// has made `navigator.gpu.requestAdapter` ask for a compatibility adapter; the device is
    /// requested with the adapter's own limits either way, so a compatibility adapter takes it.
    pub async fn create(target: Target, mask_bytes: usize, mask_side: u32) -> Result<Self> {
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
            display: None,
            backends: wgpu::Backends::BROWSER_WEBGPU,
            flags: wgpu::InstanceFlags::default(),
            memory_budget_thresholds: wgpu::MemoryBudgetThresholds::default(),
            backend_options: wgpu::BackendOptions::default(),
        });
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
            .map_err(|e| EngineError::new(ErrorCode::NoAdapter, format!("no WebGPU adapter: {e}")))?;
        let info = adapter.get_info();
        let limits = adapter.limits();
        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor {
                label: Some("drawpane engine"),
                required_features: wgpu::Features::empty(),
                required_limits: limits.clone(),
                ..Default::default()
            })
            .await
            .map_err(|e| EngineError::new(ErrorCode::NoAdapter, format!("no WebGPU device: {e}")))?;
        let health = Arc::new(Health::default());
        {
            let h = health.clone();
            device.on_uncaptured_error(Arc::new(move |e: wgpu::Error| {
                if let Ok(mut list) = h.errors.lock()
                    && list.len() < 16
                {
                    list.push(e.to_string());
                }
            }));
            let h = health.clone();
            device.set_device_lost_callback(move |reason, message| {
                h.lost.store(true, Ordering::SeqCst);
                if let Ok(mut r) = h.lost_reason.lock() {
                    *r = format!("{reason:?}: {message}");
                }
            });
        }
        let surface = match surface {
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
            fallback_adapter: matches!(info.device_type, wgpu::DeviceType::Cpu),
            _instance: instance,
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
            last: None,
            last_scale: None,
            shown: None,
            blit,
            images: HashMap::new(),
            image_bytes: 0,
            atlas: Atlas {
                texture: atlas_tex,
                shelves: Shelves::new(ATLAS_SIDE),
                pending: Vec::new(),
            },
            masks: MaskCache::new(mask_bytes),
            mask_side,
            cpu_resources: vello_cpu::Resources::new(),
            health,
            submits: 0,
            bytes: (ATLAS_SIDE * ATLAS_SIDE * 4 + 16 * 16 * 4) as usize,
            budget: crate::limits::Limits::default().gpu_bytes,
            readbacks: Rc::new(Flights::default()),
        };
        gpu.ensure_compositor();
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
        Ok(gpu)
    }

    /// GPU memory the engine has allocated.
    pub fn bytes(&self) -> usize {
        self.bytes
    }

    /// Refuses an allocation of `bytes` (beside `freed`, about to go) past the budget.
    fn reserve(&self, bytes: usize, freed: usize, what: &str) -> Result<()> {
        // Read-back buffers in flight count until they land.
        let held = self.bytes + self.readbacks.bytes.get();
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
        if self.health.lost.load(Ordering::SeqCst) {
            let reason = self.health.lost_reason.lock().map(|r| r.clone()).unwrap_or_default();
            return Err(EngineError::new(
                ErrorCode::DeviceLost,
                format!("the GPU device was lost ({reason})"),
            ));
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
            self.frames.push(Main {
                view: tex.create_view(&Default::default()),
                texture: tex,
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
        self.bytes.saturating_sub(self.pages.len() * PAGE_BYTES)
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
            let bytes = (TILE * TILE * 4 * 2) as usize;
            self.reserve(bytes, 0, "the scratch tile")?;
            let tex = texture(
                &self.device,
                TILE,
                TILE,
                wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
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
    ) -> Result<DrawStats> {
        self.check()?;
        let (w, h) = (u32::from(frame.width), u32::from(frame.height));
        self.ensure_frames(w, h)?;
        self.ensure_compositor();
        self.masks.begin_frame();
        let t0 = now();
        self.tiles.begin(background, halo);
        self.fit_tiles(store.limits.tile_bytes);
        let view = frame.view;
        let scale = view.as_coeffs()[0];
        let zooming = options.moving && self.last_scale.is_some_and(|s| s != scale);
        let last = self.last;
        let bg_bits = background.map(f32::to_bits);
        let mut plan = self
            .tiles
            .plan(view, (w, h), zooming, last, options.prefetch)
            .ok_or_else(|| EngineError::limit("a camera the tiles can't follow (too far out)"))?;
        let mut stats = DrawStats {
            direct: plan.direct,
            ..DrawStats::default()
        };
        // Nothing to draw and the frame shown is this one, exact: it stays.
        let same = plan.jobs.is_empty()
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
            // Past the budget, what something stands in for waits for a later frame; what
            // nothing stands in for is drawn regardless (the plan puts it first).
            if !job.must && drew_any && options.budget_ms > 0.0 && now() - t0 >= options.budget_ms {
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
            match target {
                TileTarget::Slot(s) => self.tiles.drawn(job.key, s, exact),
                TileTarget::Scratch => direct_exact &= exact,
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
            self.tiles.drawn(job.key, slot, exact);
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
            let group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: None,
                layout: &blit.get_bind_group_layout(0),
                entries: &[wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&main.view),
                }],
            });
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
                pass.set_bind_group(0, &group, &[]);
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
            store, job.view, job.detail, background, target, plan, job.key, dst, stats, verbs,
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
        target: TileTarget,
        plan: &crate::tiles::Plan,
        key: TileKey,
        dst: usize,
        stats: &mut DrawStats,
        verbs: &mut usize,
    ) -> Result<bool> {
        let t0 = now();
        // Each tile is its own render and submission: masks and atlas shelves the tiles before
        // it drew from may go now (their draws run before any upload made after them).
        self.masks.begin_frame();
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
        let s = exec::draw_budgeted(store, self, &tile, &limits, verbs)?;
        stats.add(&s);
        let exact = !detail || s.exact();
        let t1 = now();
        // Every tile is drawn into the scratch tile, a target of its own size (Vello's work per
        // render follows its target's size, so a page as the target would cost a page's worth
        // for each tile), then copied where it goes. The same scene and view either way: the
        // same pixels.
        self.ensure_scratch()?;
        let place = match target {
            TileTarget::Slot(slot) => Some(self.slot_place(slot)?),
            TileTarget::Scratch => None,
        };
        // The masks this tile placed reach the atlas before it renders.
        self.flush_masks();
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("tile") });
        let mut options = RenderOptions::default();
        let [r, g, b, a] = background;
        let color = vello_common::color::AlphaColor::new([r, g, b, a]);
        options.target_init = TargetInit::Clear(ClearSettings::Viewport { color });
        let (scratch, view_t, depth_t) = self
            .scratch
            .as_ref()
            .ok_or_else(|| EngineError::new(ErrorCode::State, "no scratch tile"))?;
        self.renderer
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
            .map_err(|e| EngineError::new(ErrorCode::Gpu, format!("{e:?}")))?;
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
        if size.0 > 0 && size.1 > 0 {
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
        stats.encode_ms += t1 - t0;
        stats.render_ms += now() - t1;
        Ok(exact)
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
        let pipeline = self.device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("composite"),
            layout: None,
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
            sampler,
            uniforms,
            instances,
            capacity,
        });
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

/// The frame's pixels, premultiplied RGBA8, from a buffer `read_back_start` filled. A failed
/// copy or map is an error, never empty pixels.
/// Reads a frame back (`read_back_start`'s buffer) straight into a JS array, unpremultiplied (as
/// a canvas takes pixels) unless the frame is `opaque` (drawn over an opaque background, every
/// pixel is): one copy out of the mapping, for a frame read back at every presentation
/// (headless browsers).
#[cfg(target_arch = "wasm32")]
pub async fn read_back_straight(
    buffer: wgpu::Buffer,
    w: u32,
    h: u32,
    row: u32,
    flight: InFlight,
    opaque: bool,
) -> Result<js_sys::Uint8Array> {
    let _flight = flight;
    let (tx, rx) = futures_channel::oneshot::channel();
    buffer.slice(..).map_async(wgpu::MapMode::Read, move |r| {
        let _ = tx.send(r);
    });
    rx.await
        .map_err(|e| EngineError::new(ErrorCode::Gpu, e.to_string()))?
        .map_err(|e| EngineError::new(ErrorCode::Gpu, e.to_string()))?;
    let mapped = buffer
        .slice(..)
        .get_mapped_range()
        .map_err(|e| EngineError::new(ErrorCode::Gpu, format!("{e:?}")))?;
    let line = (w * 4) as usize;
    if mapped.len() < row as usize * h as usize || line > row as usize {
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

/// Resolves when the GPU has finished what was submitted (how the bench times GPU work).
pub async fn finished(queue: wgpu::Queue) {
    let (tx, rx) = futures_channel::oneshot::channel();
    queue.on_submitted_work_done(move || {
        let _ = tx.send(());
    });
    let _ = rx.await;
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
        let side = self.mask_side;
        self.mask_with(key, path, scale, phase, side)
    }

    fn read(&mut self, kernel: u32, _paints: IRect, _reads: IRect, _open: &[Open]) -> Result<()> {
        Err(EngineError::unsupported(format!(
            "backdrop reader {kernel} on the GPU (phase 3)"
        )))
    }
}
