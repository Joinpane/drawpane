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
use crate::error::{EngineError, ErrorCode, Result};
use crate::exec::{self, Backend, DrawStats, Frame, GlyphMask, IRect, ImageView, Open, impl_draw};
use crate::images::{self, Level};
use crate::masks::{self, MaskCache, MaskKey};
use crate::store::Store;
use std::cell::Cell;
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use vello_common::TextureId;
use vello_common::geometry::RectU16;
use vello_common::kurbo::{Affine, BezPath};
use vello_common::paint::{ImageSource, TextureRegion};
use vello_gpu::{
    ClearSettings, RenderOptions, RenderSize, RenderTarget, RenderTargetConfig, Renderer, Resources, Scene, TargetInit,
    TextureBindings,
};

impl_draw!(Scene);

const FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;
const ATLAS_SIDE: u32 = 2048;
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
    depth: wgpu::TextureView,
    width: u32,
    height: u32,
}

/// The glyph atlas: one texture, and its shelves.
struct Atlas {
    texture: wgpu::Texture,
    shelves: Shelves,
}

/// Read-backs in flight at once, at most.
const READBACKS: u32 = 2;

/// Frame textures kept (see `Gpu::render`).
const FRAMES: usize = 3;

/// A stand-in's scaling: each pixel of the new frame from the last full frame, bilinear, the
/// background where it reaches past it. Frames are premultiplied, so filtering is exact.
const SCALE: &str = r"
struct U { m: vec4<f32>, bg: vec4<f32>, size: vec4<f32> };
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<uniform> u: U;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
  let p = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4<f32>(p * 2.0 - 1.0, 0.0, 1.0);
}
@fragment fn fs(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
  let q = p.xy * u.m.x + u.m.yz;
  if (q.x < 0.0 || q.y < 0.0 || q.x > u.size.x || q.y > u.size.y) { return u.bg; }
  return textureSampleLevel(src, samp, q / u.size.xy, 0.0);
}
";

/// How a frame is made (`Gpu::plan`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Plan {
    /// The whole scene drawn.
    Full,
    /// The last frame shifted, the uncovered strips drawn.
    Pan(i32, i32),
    /// The last full frame scaled.
    Zoom,
    /// Nothing changed: the frame shown stays.
    Same,
}

impl Plan {
    fn code(self) -> u32 {
        match self {
            Plan::Full => 0,
            Plan::Pan(..) => 1,
            Plan::Zoom => 2,
            Plan::Same => 3,
        }
    }
}

/// What a frame texture was drawn for.
#[derive(Clone, Copy)]
struct Shown {
    view: vello_common::kurbo::Affine,
    background: [f32; 4],
    generation: u64,
    /// Drawn exactly (no stand-ins, no level-of-detail).
    exact: bool,
}

/// The last full frame: which texture, and what for.
struct Basis {
    index: usize,
    shown: Shown,
}

struct Scaler {
    pipeline: wgpu::RenderPipeline,
    sampler: wgpu::Sampler,
    uniforms: wgpu::Buffer,
}

/// Milliseconds now, for the frame's breakdown.
fn now() -> f64 {
    web_sys::window().and_then(|w| w.performance()).map_or(0.0, |p| p.now())
}

/// A read-back begun: the buffer the frame is copied into, its width, height and row stride, and
/// the in-flight count it holds a place in.
pub type ReadBack = (wgpu::Buffer, u32, u32, u32, Rc<Cell<u32>>);

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
    /// Frame textures: the one shown (`cur`), the last full frame a zoom scales (`basis`), and
    /// a spare a pan shifts into.
    frames: Vec<Main>,
    cur: usize,
    basis: Option<Basis>,
    /// What the frame shown was drawn for.
    shown: Option<Shown>,
    scaler: Option<Scaler>,
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
    readbacks: Rc<Cell<u32>>,
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
            basis: None,
            shown: None,
            scaler: None,
            blit,
            images: HashMap::new(),
            image_bytes: 0,
            atlas: Atlas {
                texture: atlas_tex,
                shelves: Shelves::new(ATLAS_SIDE),
            },
            masks: MaskCache::new(mask_bytes),
            mask_side,
            cpu_resources: vello_cpu::Resources::new(),
            health,
            submits: 0,
            bytes: (ATLAS_SIDE * ATLAS_SIDE * 4 + 16 * 16 * 4) as usize,
            budget: crate::limits::Limits::default().gpu_bytes,
            readbacks: Rc::new(Cell::new(0)),
        };
        gpu.ensure_scaler();
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
        if self.bytes - freed + bytes > self.budget {
            return Err(EngineError::limit(format!(
                "{what} would take the engine's GPU memory to {} MiB; the most is {} MiB",
                (self.bytes - freed + bytes) >> 20,
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

    /// Bytes frames of this size take on the GPU: `FRAMES` textures and their depth buffers,
    /// and the canvas's own textures (two in flight).
    fn frame_bytes(width: u32, height: u32, presents: bool) -> usize {
        let px = width as usize * height as usize * 4;
        px * 2 * FRAMES + if presents { px * 2 } else { 0 }
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
            let depth = self.renderer.create_depth_texture_view(&RenderSize {
                width: width as u16,
                height: height as u16,
            });
            self.frames.push(Main {
                view: tex.create_view(&Default::default()),
                texture: tex,
                depth,
                width,
                height,
            });
        }
        self.cur = 0;
        self.basis = None;
        self.shown = None;
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

    /// What this frame can be made from (see `render`).
    fn plan(&self, frame: &Frame, background: [f32; 4], generation: u64) -> Plan {
        let same = |v: &Shown| v.generation == generation && v.background == background;
        if !frame.detail {
            return Plan::Full;
        }
        let [z, _, _, _, tx, ty] = frame.view.as_coeffs();
        if let Some(last) = self.shown.as_ref().filter(|v| same(v)) {
            let [lz, _, _, _, lx, ly] = last.view.as_coeffs();
            let (dx, dy) = (tx - lx, ty - ly);
            let whole = |v: f64| (v - v.round()).abs() < 1e-6;
            if z == lz && whole(dx) && whole(dy) {
                let (dx, dy) = (dx.round() as i32, dy.round() as i32);
                if dx == 0 && dy == 0 {
                    return Plan::Same;
                }
                if dx.unsigned_abs() < u32::from(frame.width) && dy.unsigned_abs() < u32::from(frame.height) {
                    return Plan::Pan(dx, dy);
                }
            }
        }
        if self.basis.as_ref().is_some_and(|b| same(&b.shown)) {
            return Plan::Zoom;
        }
        Plan::Full
    }

    /// Draws a frame: encodes, submits and, with a canvas, presents. The GPU may still be
    /// drawing when this returns (`finished` waits).
    ///
    /// An interactive frame (`frame.detail`) with nothing changed but the camera since the last
    /// one is a stand-in, cheap on the CPU (decision 0040, "Raster scales"): a pan by whole
    /// device pixels shifts the last frame on the GPU and draws only the strips it uncovers; any
    /// other camera change scales the last full frame. The caller draws an exact frame
    /// (`detail` off) once the camera rests. Anything else draws the whole scene.
    /// `generation` changes whenever what's drawn may have (a message, an image).
    pub fn render(&mut self, store: &Store, frame: &Frame, background: [f32; 4], generation: u64) -> Result<DrawStats> {
        self.check()?;
        let (w, h) = (u32::from(frame.width), u32::from(frame.height));
        self.ensure_frames(w, h)?;
        self.masks.begin_frame();
        let t0 = now();
        let plan = self.plan(frame, background, generation);
        let drawn = match plan {
            Plan::Same => Ok(DrawStats {
                standin: !self.shown.as_ref().is_some_and(|s| s.exact),
                ..DrawStats::default()
            }),
            Plan::Full => self.full(store, frame, background),
            Plan::Pan(dx, dy) => self.pan(store, frame, background, dx, dy),
            Plan::Zoom => self.zoom(frame, background),
        };
        let mut stats = match drawn {
            Ok(s) => s,
            Err(e) => {
                self.scene.reset();
                return Err(e);
            }
        };
        stats.plan = plan.code();
        let shown_exact = !stats.standin && stats.exact();
        if plan == Plan::Full {
            self.basis = Some(Basis {
                index: self.cur,
                shown: Shown {
                    view: frame.view,
                    background,
                    generation,
                    exact: shown_exact,
                },
            });
        }
        self.shown = Some(Shown {
            view: frame.view,
            background,
            generation,
            exact: shown_exact,
        });
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

    /// Encodes the scene into `self.scene` for `frame` and renders it into frame texture `dst`,
    /// clearing `clear` (all of it when None) to `background` first, offset by `offset`.
    #[allow(clippy::too_many_arguments)]
    fn draw_into(
        &mut self,
        store: &Store,
        frame: &Frame,
        background: [f32; 4],
        dst: usize,
        clear: Option<RectU16>,
        offset: (i32, i32),
        before: Option<wgpu::CommandEncoder>,
        stats: &mut DrawStats,
    ) -> Result<()> {
        let t0 = now();
        self.scene.reset_and_resize(frame.width, frame.height);
        let limits = store.limits;
        let s = exec::draw(store, self, frame, &limits)?;
        stats.add(&s);
        let t1 = now();
        let mut encoder = before.unwrap_or_else(|| {
            self.device
                .create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("frame") })
        });
        let mut options = RenderOptions::default();
        let [r, g, b, a] = background;
        let color = vello_common::color::AlphaColor::new([r, g, b, a]);
        let rects = clear.map(|c| [c]);
        options.target_init = TargetInit::Clear(match &rects {
            Some(rects) => ClearSettings::Rects { color, rects },
            None => ClearSettings::Viewport { color },
        });
        options.offset = offset;
        let main = self
            .frames
            .get(dst)
            .ok_or_else(|| EngineError::new(ErrorCode::State, "no frame texture"))?;
        self.renderer
            .render(
                &self.scene,
                &mut self.resources,
                &mut encoder,
                RenderTarget {
                    view: &main.view,
                    depth_view: Some(&main.depth),
                },
                &self.bindings,
                options,
            )
            .map_err(|e| EngineError::new(ErrorCode::Gpu, format!("{e:?}")))?;
        // One render per submission: the renderer writes its buffers through the queue, which a
        // second render in the same encoder would overwrite before the first ran.
        self.queue.submit([encoder.finish()]);
        self.submits += 1;
        stats.encode_ms += t1 - t0;
        stats.render_ms += now() - t1;
        Ok(())
    }

    /// The whole scene, into the frame shown.
    fn full(&mut self, store: &Store, frame: &Frame, background: [f32; 4]) -> Result<DrawStats> {
        let mut stats = DrawStats::default();
        // Not into the basis a zoom scales from while it's another frame: any frame will do.
        let dst = self.cur;
        self.draw_into(store, frame, background, dst, None, (0, 0), None, &mut stats)?;
        Ok(stats)
    }

    /// A frame texture that isn't `a` or `b`.
    fn spare(&self, a: usize, b: Option<usize>) -> usize {
        (0..FRAMES).find(|i| *i != a && Some(*i) != b).unwrap_or(0)
    }

    /// The last frame shifted by (`dx`, `dy`) device pixels, and the strips it uncovers drawn.
    fn pan(&mut self, store: &Store, frame: &Frame, background: [f32; 4], dx: i32, dy: i32) -> Result<DrawStats> {
        let (w, h) = (i32::from(frame.width), i32::from(frame.height));
        let src = self.cur;
        let dst = self.spare(src, self.basis.as_ref().map(|b| b.index));
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("pan") });
        {
            let (s, d) = (&self.frames[src], &self.frames[dst]);
            encoder.copy_texture_to_texture(
                wgpu::TexelCopyTextureInfo {
                    texture: &s.texture,
                    mip_level: 0,
                    origin: wgpu::Origin3d {
                        x: (-dx).max(0) as u32,
                        y: (-dy).max(0) as u32,
                        z: 0,
                    },
                    aspect: wgpu::TextureAspect::All,
                },
                wgpu::TexelCopyTextureInfo {
                    texture: &d.texture,
                    mip_level: 0,
                    origin: wgpu::Origin3d {
                        x: dx.max(0) as u32,
                        y: dy.max(0) as u32,
                        z: 0,
                    },
                    aspect: wgpu::TextureAspect::All,
                },
                wgpu::Extent3d {
                    width: (w - dx.abs()) as u32,
                    height: (h - dy.abs()) as u32,
                    depth_or_array_layers: 1,
                },
            );
        }
        // The uncovered strips: columns at the side it moved from, then rows across the rest.
        let mut parts: Vec<IRect> = Vec::new();
        let (cx0, cx1) = if dx > 0 { (dx, w) } else { (0, w + dx) };
        if dx > 0 {
            parts.push(IRect {
                x0: 0,
                y0: 0,
                x1: dx,
                y1: h,
            });
        } else if dx < 0 {
            parts.push(IRect {
                x0: w + dx,
                y0: 0,
                x1: w,
                y1: h,
            });
        }
        if dy > 0 {
            parts.push(IRect {
                x0: cx0,
                y0: 0,
                x1: cx1,
                y1: dy,
            });
        } else if dy < 0 {
            parts.push(IRect {
                x0: cx0,
                y0: h + dy,
                x1: cx1,
                y1: h,
            });
        }
        let mut stats = DrawStats {
            standin: true,
            ..DrawStats::default()
        };
        let mut before = Some(encoder);
        for p in parts.iter().filter(|p| !p.is_empty()) {
            let part = Frame {
                width: (p.x1 - p.x0) as u16,
                height: (p.y1 - p.y0) as u16,
                view: Affine::translate((-f64::from(p.x0), -f64::from(p.y0))) * frame.view,
                detail: true,
                area: IRect {
                    x0: 0,
                    y0: 0,
                    x1: p.x1 - p.x0,
                    y1: p.y1 - p.y0,
                },
            };
            let clear = RectU16 {
                x0: p.x0 as u16,
                y0: p.y0 as u16,
                x1: p.x1 as u16,
                y1: p.y1 as u16,
            };
            self.draw_into(
                store,
                &part,
                background,
                dst,
                Some(clear),
                (p.x0, p.y0),
                before.take(),
                &mut stats,
            )?;
        }
        if let Some(e) = before {
            self.queue.submit([e.finish()]);
        }
        self.cur = dst;
        Ok(stats)
    }

    /// The last full frame scaled and moved to the camera now, the rest the background.
    fn zoom(&mut self, frame: &Frame, background: [f32; 4]) -> Result<DrawStats> {
        let basis = self
            .basis
            .as_ref()
            .ok_or_else(|| EngineError::new(ErrorCode::State, "no frame to scale"))?;
        let src = basis.index;
        let [bz, _, _, _, bx, by] = basis.shown.view.as_coeffs();
        let [z, _, _, _, tx, ty] = frame.view.as_coeffs();
        let dst = self.spare(src, None);
        let scale = bz / z;
        let (ox, oy) = (bx - tx * scale, by - ty * scale);
        let t0 = now();
        self.ensure_scaler();
        let scaler = self
            .scaler
            .as_ref()
            .ok_or_else(|| EngineError::new(ErrorCode::State, "no scaling pipeline"))?;
        let a = background[3];
        let uniforms: [f32; 12] = [
            scale as f32,
            ox as f32,
            oy as f32,
            0.0,
            background[0] * a,
            background[1] * a,
            background[2] * a,
            a,
            f32::from(frame.width),
            f32::from(frame.height),
            0.0,
            0.0,
        ];
        let bytes: Vec<u8> = uniforms.iter().flat_map(|v| v.to_le_bytes()).collect();
        self.queue.write_buffer(&scaler.uniforms, 0, &bytes);
        let (s, d) = (&self.frames[src], &self.frames[dst]);
        let group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("stand-in"),
            layout: &scaler.pipeline.get_bind_group_layout(0),
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&s.view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Sampler(&scaler.sampler),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: scaler.uniforms.as_entire_binding(),
                },
            ],
        });
        let mut encoder = self.device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("stand-in"),
        });
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("stand-in"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &d.view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                ..Default::default()
            });
            pass.set_pipeline(&scaler.pipeline);
            pass.set_bind_group(0, &group, &[]);
            pass.draw(0..3, 0..1);
        }
        self.queue.submit([encoder.finish()]);
        self.submits += 1;
        self.cur = dst;
        Ok(DrawStats {
            standin: true,
            render_ms: now() - t0,
            ..DrawStats::default()
        })
    }

    /// Makes the pipeline that scales a frame into another, on first use.
    fn ensure_scaler(&mut self) {
        if self.scaler.is_none() {
            let module = self.device.create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("stand-in"),
                source: wgpu::ShaderSource::Wgsl(SCALE.into()),
            });
            let pipeline = self.device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some("stand-in"),
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
            let sampler = self.device.create_sampler(&wgpu::SamplerDescriptor {
                label: Some("stand-in"),
                mag_filter: wgpu::FilterMode::Linear,
                min_filter: wgpu::FilterMode::Linear,
                ..Default::default()
            });
            let uniforms = self.device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("stand-in"),
                size: 48,
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            });
            self.scaler = Some(Scaler {
                pipeline,
                sampler,
                uniforms,
            });
        }
    }

    /// Starts reading the last frame back: a buffer the frame is copied into, mapped by
    /// `read_back` (which takes the in-flight count it answers). At most `READBACKS` at once.
    pub fn read_back_start(&self) -> Result<ReadBack> {
        self.check()?;
        let main = self.current()?;
        if self.readbacks.get() >= READBACKS {
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
        self.readbacks.set(self.readbacks.get() + 1);
        Ok((buffer, w, h, row, self.readbacks.clone()))
    }
}

/// Counts a read-back out of flight when it lands or fails.
struct InFlight(Rc<Cell<u32>>);

impl Drop for InFlight {
    fn drop(&mut self) {
        self.0.set(self.0.get().saturating_sub(1));
    }
}

/// The frame's pixels, premultiplied RGBA8, from a buffer `read_back_start` filled. A failed
/// copy or map is an error, never empty pixels.
pub async fn read_back(buffer: wgpu::Buffer, w: u32, h: u32, row: u32, flight: Rc<Cell<u32>>) -> Result<Vec<u8>> {
    let _flight = InFlight(flight);
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
    let mut out = Vec::with_capacity((w * h * 4) as usize);
    for chunk in mapped.chunks_exact(row as usize) {
        out.extend_from_slice(&chunk[..(w * 4) as usize]);
    }
    drop(mapped);
    buffer.unmap();
    buffer.destroy();
    if out.len() != (w * h * 4) as usize {
        return Err(EngineError::new(ErrorCode::Gpu, "a read-back came back short"));
    }
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
        let source = |r: RectU16| ImageSource::external_texture(ATLAS_ID, TextureRegion::Rect(r), true);
        let frame = self.masks.frame();
        if let Some(e) = self.masks.get(&key) {
            let (rect, origin, size) = (e.value, e.origin, e.size);
            self.atlas.shelves.touch(u32::from(rect.y0), frame);
            return Some((source(rect), origin, size));
        }
        let (mask, origin) = masks::rasterise(&mut self.cpu_resources, path, scale.0, scale.1, phase, self.mask_side)?;
        let (w, h) = (mask.width(), mask.height());
        if !self.masks.fits(usize::from(w) * usize::from(h) * 4) {
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
        write(
            &self.queue,
            &self.atlas.texture,
            x,
            y,
            u32::from(w),
            u32::from(h),
            mask.data_as_u8_slice(),
        );
        let rect = RectU16 {
            x0: x as u16,
            y0: y as u16,
            x1: (x + u32::from(w)) as u16,
            y1: (y + u32::from(h)) as u16,
        };
        let e = self.masks.insert(key, rect, origin, (w, h));
        Some((source(e.value), e.origin, e.size))
    }

    fn read(&mut self, kernel: u32, _paints: IRect, _reads: IRect, _open: &[Open]) -> Result<()> {
        Err(EngineError::unsupported(format!(
            "backdrop reader {kernel} on the GPU (phase 3)"
        )))
    }
}
