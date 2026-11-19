//! The GPU backend: vello_gpu on wgpu's WebGPU backend (the browser build).
//!
//! - The frame is drawn into an RGBA8 texture of the engine's own (`main`), then copied to the
//!   canvas's surface by one full-screen pass. Tests and the GPU bench read `main` back through
//!   a buffer (`copy_texture_to_buffer`), never through the canvas: a WebGPU canvas copied into a
//!   2D canvas can come back empty on headless drivers.
//! - Images are textures, one per level, uploaded once. Glyph masks are rasterised by vello_cpu
//!   (`masks.rs`, the same coverage as the CPU backend) and packed into one atlas texture.
//! - Errors never panic: wgpu's uncaptured errors and device loss are recorded and turned into
//!   `ErrorCode::Gpu` and `ErrorCode::DeviceLost` on the next call, so the editor falls back.
//! - Backdrop readers are phase 3 here (`read` refuses), as everywhere outside the tests.

use crate::error::{EngineError, ErrorCode, Result};
use crate::exec::{self, Backend, DrawStats, Frame, GlyphMask, IRect, ImageView, Open, impl_draw};
use crate::images::{self, Level};
use crate::masks::{self, MaskCache, MaskKey};
use crate::store::Store;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use vello_common::TextureId;
use vello_common::geometry::RectU16;
use vello_common::kurbo::BezPath;
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

/// Shelves of glyph masks in one texture. Space comes back only by resetting the whole atlas.
struct Atlas {
    texture: wgpu::Texture,
    shelves: Vec<(u32, u32, u32)>, // y, height, next x
    next_y: u32,
    full: bool,
}

impl Atlas {
    fn place(&mut self, w: u32, h: u32) -> Option<(u32, u32)> {
        if w > ATLAS_SIDE || h > ATLAS_SIDE {
            return None;
        }
        for shelf in &mut self.shelves {
            if h <= shelf.1 && h * 4 >= shelf.1 * 3 && shelf.2 + w <= ATLAS_SIDE {
                let at = (shelf.2, shelf.0);
                shelf.2 += w + 1;
                return Some(at);
            }
        }
        if self.next_y + h > ATLAS_SIDE {
            self.full = true;
            return None;
        }
        let y = self.next_y;
        self.shelves.push((y, h, w + 1));
        self.next_y += h + 1;
        Some((0, y))
    }
    fn reset(&mut self) {
        self.shelves.clear();
        self.next_y = 0;
        self.full = false;
    }
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
    main: Option<Main>,
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
        Ok(Self {
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
            main: None,
            blit,
            images: HashMap::new(),
            image_bytes: 0,
            atlas: Atlas {
                texture: atlas_tex,
                shelves: Vec::new(),
                next_y: 0,
                full: false,
            },
            masks: MaskCache::new(mask_bytes),
            mask_side,
            cpu_resources: vello_cpu::Resources::new(),
            health,
            submits: 0,
        })
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
        Ok(())
    }

    pub fn drop_image(&mut self, id: u32) {
        if let Some(levels) = self.images.remove(&id) {
            for (tid, tex, w, h) in levels {
                self.bindings.remove(tid);
                self.image_bytes -= (w * h * 4) as usize;
                tex.destroy();
            }
        }
    }

    fn ensure_main(&mut self, width: u32, height: u32) {
        if self
            .main
            .as_ref()
            .is_some_and(|m| m.width == width && m.height == height)
        {
            return;
        }
        if let Some(m) = self.main.take() {
            m.texture.destroy();
        }
        let tex = texture(
            &self.device,
            width,
            height,
            wgpu::TextureUsages::RENDER_ATTACHMENT
                | wgpu::TextureUsages::TEXTURE_BINDING
                | wgpu::TextureUsages::COPY_SRC,
            "frame",
        );
        let depth = self.renderer.create_depth_texture_view(&RenderSize {
            width: width as u16,
            height: height as u16,
        });
        self.main = Some(Main {
            view: tex.create_view(&Default::default()),
            texture: tex,
            depth,
            width,
            height,
        });
        if let Some((surface, config)) = self.surface.as_mut() {
            config.width = width;
            config.height = height;
            surface.configure(&self.device, config);
        }
    }

    /// Draws a frame: encodes, submits and, with a canvas, presents. The GPU may still be
    /// drawing when this returns (`finished` waits).
    pub fn render(&mut self, store: &Store, frame: &Frame, background: [f32; 4]) -> Result<DrawStats> {
        self.check()?;
        let (w, h) = (u32::from(frame.width), u32::from(frame.height));
        self.ensure_main(w, h);
        if self.atlas.full {
            self.atlas.reset();
            self.masks.clear();
        }
        self.masks.begin_frame();
        self.scene.reset_and_resize(frame.width, frame.height);
        let limits = store.limits;
        let stats = exec::draw(store, self, frame, limits.glyph_mask_side);
        let stats = match stats {
            Ok(s) => s,
            Err(e) => {
                self.scene.reset();
                return Err(e);
            }
        };
        let main = self
            .main
            .as_ref()
            .ok_or_else(|| EngineError::new(ErrorCode::State, "no frame texture"))?;
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("frame") });
        let mut options = RenderOptions::default();
        let [r, g, b, a] = background;
        options.target_init = TargetInit::Clear(ClearSettings::Viewport {
            color: vello_common::color::AlphaColor::new([r, g, b, a]),
        });
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
        let mut present = None;
        if let (Some((surface, _)), Some(blit)) = (self.surface.as_ref(), self.blit.as_ref()) {
            let out = surface.get_current_texture();
            if let wgpu::CurrentSurfaceTexture::Success(t) | wgpu::CurrentSurfaceTexture::Suboptimal(t) = out {
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
                present = Some(t);
            }
        }
        self.queue.submit([encoder.finish()]);
        self.submits += 1;
        if let Some(t) = present {
            self.queue.present(t);
        }
        self.scene.reset();
        Ok(stats)
    }

    /// Starts reading the last frame back: a buffer the frame is copied into, mapped by `read_back`.
    pub fn read_back_start(&self) -> Result<(wgpu::Buffer, u32, u32, u32)> {
        let main = self
            .main
            .as_ref()
            .ok_or_else(|| EngineError::new(ErrorCode::State, "nothing drawn on the GPU yet"))?;
        let (w, h) = (main.width, main.height);
        let row = (w * 4).next_multiple_of(256);
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
        Ok((buffer, w, h, row))
    }
}

/// The frame's pixels, premultiplied RGBA8, from a buffer `read_back_start` filled.
pub async fn read_back(buffer: wgpu::Buffer, w: u32, h: u32, row: u32) -> Result<Vec<u8>> {
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
        if let Some(e) = self.masks.get(&key) {
            return Some((source(e.value), e.origin, e.size));
        }
        if self.atlas.full {
            self.masks.stats.outlines += 1;
            return None;
        }
        let (mask, origin) = masks::rasterise(&mut self.cpu_resources, path, scale.0, scale.1, phase, self.mask_side)?;
        let (w, h) = (mask.width(), mask.height());
        if !self.masks.fits(usize::from(w) * usize::from(h) * 4) {
            self.masks.stats.outlines += 1;
            return None;
        }
        let Some((x, y)) = self.atlas.place(u32::from(w), u32::from(h)) else {
            self.masks.stats.outlines += 1;
            return None;
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
