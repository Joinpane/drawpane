//! The GPU backend: vello_gpu on wgpu's WebGPU backend, and the kernels in WGSL
//! (`kernels.wgsl`). What the editor's canvas would run (decision 0040).
//!
//! Every target is the page's size, so a kernel's fragment position is its pixel in the page:
//! the page itself, a scratch target layers are drawn apart into, and two more for a copy of
//! what's under a kernel and the frost's passes. Each kernel is encoded and submitted on its
//! own, after the scene before it.

use crate::dl::GlassOp;
use crate::exec::{Backend, impl_draw};
use vello_common::kurbo::Point;
use vello_gpu::{ClearSettings, RenderOptions, RenderSize, RenderTarget, RenderTargetConfig, Renderer, Resources, Scene, TargetInit, TextureBindings};
use wgpu::util::DeviceExt;

impl_draw!(Scene);

const FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;

struct Target {
    texture: wgpu::Texture,
    view: wgpu::TextureView,
}

pub struct Gpu {
    pub device: wgpu::Device,
    pub queue: wgpu::Queue,
    renderer: Renderer,
    resources: Resources,
    bindings: TextureBindings,
    pub width: u16,
    pub height: u16,
    pub main: wgpu::Texture,
    main_view: wgpu::TextureView,
    scratch: Target,
    under: Target,
    temp: Target,
    seen: Target,
    depth: wgpu::TextureView,
    composite: wgpu::RenderPipeline,
    blur: wgpu::RenderPipeline,
    glass: wgpu::RenderPipeline,
    sampler: wgpu::Sampler,
    /// Command buffers submitted, for the report.
    pub submits: u32,
    /// Lay segments on with vello_gpu's own source-over (else drawn apart and composited).
    pub src_over: bool,
}

fn target(device: &wgpu::Device, w: u16, h: u16, label: &str) -> Target {
    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some(label),
        size: wgpu::Extent3d { width: u32::from(w), height: u32::from(h), depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: FORMAT,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT
            | wgpu::TextureUsages::TEXTURE_BINDING
            | wgpu::TextureUsages::COPY_SRC
            | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    });
    let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
    Target { texture, view }
}

fn pipeline(device: &wgpu::Device, module: &wgpu::ShaderModule, entry: &str) -> wgpu::RenderPipeline {
    device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some(entry),
        layout: None,
        vertex: wgpu::VertexState {
            module,
            entry_point: Some("vs"),
            compilation_options: Default::default(),
            buffers: &[],
        },
        primitive: wgpu::PrimitiveState::default(),
        depth_stencil: None,
        multisample: wgpu::MultisampleState::default(),
        fragment: Some(wgpu::FragmentState {
            module,
            entry_point: Some(entry),
            compilation_options: Default::default(),
            targets: &[Some(wgpu::ColorTargetState { format: FORMAT, blend: None, write_mask: wgpu::ColorWrites::ALL })],
        }),
        multiview_mask: None,
        cache: None,
    })
}

impl Gpu {
    pub fn new(device: wgpu::Device, queue: wgpu::Queue, width: u16, height: u16) -> Self {
        let (renderer, resources) = Renderer::new(&device, &queue, &RenderTargetConfig { format: FORMAT, width, height });
        let depth = renderer.create_depth_texture_view(&RenderSize { width, height });
        let main = target(&device, width, height, "page");
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("kernels"),
            source: wgpu::ShaderSource::Wgsl(include_str!("kernels.wgsl").into()),
        });
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });
        Self {
            composite: pipeline(&device, &module, "fs_composite"),
            blur: pipeline(&device, &module, "fs_blur"),
            glass: pipeline(&device, &module, "fs_glass"),
            scratch: target(&device, width, height, "apart"),
            under: target(&device, width, height, "under"),
            temp: target(&device, width, height, "frost-x"),
            seen: target(&device, width, height, "frost"),
            main_view: main.view,
            main: main.texture,
            depth,
            sampler,
            renderer,
            resources,
            bindings: TextureBindings::new(),
            width,
            height,
            device,
            queue,
            submits: 0,
            src_over: true,
        }
    }

    fn encoder(&self) -> wgpu::CommandEncoder {
        self.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: None })
    }

    fn submit(&mut self, encoder: wgpu::CommandEncoder) {
        self.queue.submit([encoder.finish()]);
        self.submits += 1;
    }

    /// Copies a region of the page into `to` at the same place.
    fn copy(&self, encoder: &mut wgpu::CommandEncoder, to: &wgpu::Texture, r: [u32; 4]) {
        if r[2] <= r[0] || r[3] <= r[1] {
            return;
        }
        let origin = wgpu::Origin3d { x: r[0], y: r[1], z: 0 };
        encoder.copy_texture_to_texture(
            wgpu::TexelCopyTextureInfo { texture: &self.main, mip_level: 0, origin, aspect: wgpu::TextureAspect::All },
            wgpu::TexelCopyTextureInfo { texture: to, mip_level: 0, origin, aspect: wgpu::TextureAspect::All },
            wgpu::Extent3d { width: r[2] - r[0], height: r[3] - r[1], depth_or_array_layers: 1 },
        );
    }

    fn clamp(&self, x0: i32, y0: i32, x1: i32, y1: i32) -> [u32; 4] {
        let (w, h) = (i32::from(self.width), i32::from(self.height));
        [x0.clamp(0, w) as u32, y0.clamp(0, h) as u32, x1.clamp(0, w) as u32, y1.clamp(0, h) as u32]
    }

    /// One triangle over `into`, scissored to `r`, with `group` bound.
    fn pass(&self, encoder: &mut wgpu::CommandEncoder, into: &wgpu::TextureView, pipe: &wgpu::RenderPipeline, group: &wgpu::BindGroup, r: [u32; 4]) {
        if r[2] <= r[0] || r[3] <= r[1] {
            return;
        }
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: None,
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: into,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations { load: wgpu::LoadOp::Load, store: wgpu::StoreOp::Store },
            })],
            ..Default::default()
        });
        pass.set_pipeline(pipe);
        pass.set_bind_group(0, group, &[]);
        pass.set_scissor_rect(r[0], r[1], r[2] - r[0], r[3] - r[1]);
        pass.draw(0..3, 0..1);
    }

    fn uniform(&self, words: &[f32]) -> wgpu::Buffer {
        let bytes: Vec<u8> = words.iter().flat_map(|w| w.to_le_bytes()).collect();
        self.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: None,
            contents: &bytes,
            usage: wgpu::BufferUsages::UNIFORM,
        })
    }

    fn group(&self, pipe: &wgpu::RenderPipeline, entries: &[wgpu::BindingResource<'_>]) -> wgpu::BindGroup {
        let entries: Vec<wgpu::BindGroupEntry<'_>> = entries
            .iter()
            .enumerate()
            .map(|(i, r)| wgpu::BindGroupEntry { binding: i as u32, resource: r.clone() })
            .collect();
        self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: None,
            layout: &pipe.get_bind_group_layout(0),
            entries: &entries,
        })
    }
}

fn options(target_init: TargetInit<'_>, offset: (i32, i32)) -> RenderOptions<'_> {
    let mut o = RenderOptions::default();
    o.target_init = target_init;
    o.offset = offset;
    o
}

impl Backend for Gpu {
    type Scene = Scene;

    fn begin(&mut self) -> Result<(), String> {
        let mut encoder = self.encoder();
        encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("clear page"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &self.main_view,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT), store: wgpu::StoreOp::Store },
            })],
            ..Default::default()
        });
        self.submit(encoder);
        Ok(())
    }

    fn scene(&mut self, w: u16, h: u16) -> Scene {
        Scene::new(w, h)
    }

    fn render_main(&mut self, scene: &mut Scene, band: [i32; 2]) -> Result<(), String> {
        if self.src_over {
            let mut encoder = self.encoder();
            self.renderer
                .render(
                    scene,
                    &mut self.resources,
                    &mut encoder,
                    RenderTarget { view: &self.main_view, depth_view: Some(&self.depth) },
                    &self.bindings,
                    options(TargetInit::SrcOver, (0, 0)),
                )
                .map_err(|e| format!("{e:?}"))?;
            self.submit(encoder);
            return Ok(());
        }
        // Or each segment drawn apart and laid on by the source-over kernel (`setVelloSrcOver`
        // false), which costs a copy and agrees with vello_gpu's own to the rounding.
        self.render_apart(scene, [0, 0], self.width, self.height)?;
        let rows = (band[1] - band[0]).max(0) as u16;
        self.composite([0, band[0]], self.width, rows, 0, 1.0)
    }

    fn render_apart(&mut self, scene: &mut Scene, at: [i32; 2], _w: u16, _h: u16) -> Result<(), String> {
        let mut encoder = self.encoder();
        self.renderer
            .render(
                scene,
                &mut self.resources,
                &mut encoder,
                RenderTarget { view: &self.scratch.view, depth_view: Some(&self.depth) },
                &self.bindings,
                options(
                    TargetInit::Clear(ClearSettings::Viewport { color: vello_common::color::palette::css::TRANSPARENT }),
                    (at[0], at[1]),
                ),
            )
            .map_err(|e| format!("{e:?}"))?;
        self.submit(encoder);
        Ok(())
    }

    fn composite(&mut self, at: [i32; 2], w: u16, h: u16, blend: u32, opacity: f32) -> Result<(), String> {
        let r = self.clamp(at[0], at[1], at[0] + i32::from(w), at[1] + i32::from(h));
        let mut encoder = self.encoder();
        self.copy(&mut encoder, &self.under.texture, r);
        let u = self.uniform(&[f32::from_bits(blend), opacity, 0.0, 0.0]);
        let group = self.group(
            &self.composite,
            &[
                wgpu::BindingResource::TextureView(&self.scratch.view),
                wgpu::BindingResource::TextureView(&self.under.view),
                u.as_entire_binding(),
            ],
        );
        self.pass(&mut encoder, &self.main_view, &self.composite, &group, r);
        self.submit(encoder);
        Ok(())
    }

    fn glass(&mut self, g: &GlassOp) -> Result<(), String> {
        let region = self.clamp(g.region[0], g.region[1], g.region[2], g.region[3]);
        let area = self.clamp(g.region[0] - g.margin, g.region[1] - g.margin, g.region[2] + g.margin, g.region[3] + g.margin);
        let areaf = area.map(|v| v as f32);
        let mut encoder = self.encoder();
        self.copy(&mut encoder, &self.under.texture, area);
        // Frost: the backdrop blurred along x into `temp`, then along y into `seen`.
        let seen_view = if g.frost > 0.4 {
            for (dir, from, to) in [([1.0, 0.0], &self.under.view, &self.temp.view), ([0.0, 1.0], &self.temp.view, &self.seen.view)] {
                let u = self.uniform(&[dir[0], dir[1], g.frost, 0.0, areaf[0], areaf[1], areaf[2], areaf[3]]);
                let group = self.group(&self.blur, &[wgpu::BindingResource::TextureView(from), u.as_entire_binding()]);
                self.pass(&mut encoder, to, &self.blur, &group, area);
            }
            &self.seen.view
        } else {
            &self.under.view
        };
        let inv = g.transform.inverse().as_coeffs().map(|v| v as f32);
        let center = g.transform * Point::new(f64::from(g.w) * 0.5, f64::from(g.h) * 0.5);
        let c = g.transform.as_coeffs();
        let half = [
            ((c[0].abs() * f64::from(g.w) + c[2].abs() * f64::from(g.h)) * 0.5) as f32,
            ((c[1].abs() * f64::from(g.w) + c[3].abs() * f64::from(g.h)) * 0.5) as f32,
        ];
        let u = self.uniform(&[
            inv[0], inv[1], inv[2], inv[3],
            inv[4], inv[5], g.w, g.h,
            g.radii[0], g.radii[1], g.radii[2], g.radii[3],
            g.refraction, g.depth, g.dispersion, g.frost,
            g.splay, g.light[0], g.light[1], g.intensity,
            g.unit_px, g.falloff, g.hairline, g.front,
            g.front_start, g.back, g.back_start, g.shade,
            g.shade_reach, center.x as f32, center.y as f32, half[0],
            half[1], areaf[0], areaf[1], areaf[2],
            areaf[3], 0.0, 0.0, 0.0,
        ]);
        let group = self.group(
            &self.glass,
            &[
                wgpu::BindingResource::TextureView(&self.under.view),
                wgpu::BindingResource::TextureView(seen_view),
                wgpu::BindingResource::Sampler(&self.sampler),
                u.as_entire_binding(),
            ],
        );
        self.pass(&mut encoder, &self.main_view, &self.glass, &group, region);
        self.submit(encoder);
        Ok(())
    }
}

/// The page's pixels, premultiplied RGBA8, read back from the GPU.
pub async fn read_back(gpu: &Gpu) -> Result<Vec<u8>, String> {
    let (w, h) = (u32::from(gpu.width), u32::from(gpu.height));
    let row = (w * 4).next_multiple_of(256);
    let buffer = gpu.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("read back"),
        size: u64::from(row) * u64::from(h),
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let mut encoder = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: None });
    encoder.copy_texture_to_buffer(
        wgpu::TexelCopyTextureInfo { texture: &gpu.main, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
        wgpu::TexelCopyBufferInfo {
            buffer: &buffer,
            layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(row), rows_per_image: None },
        },
        wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
    );
    gpu.queue.submit([encoder.finish()]);
    let (tx, rx) = futures_channel::oneshot::channel();
    buffer.slice(..).map_async(wgpu::MapMode::Read, move |r| {
        let _ = tx.send(r);
    });
    rx.await.map_err(|e| e.to_string())?.map_err(|e| e.to_string())?;
    let mapped = buffer.slice(..).get_mapped_range().map_err(|e| format!("{e:?}"))?;
    let mut out = Vec::with_capacity((w * h * 4) as usize);
    for chunk in mapped.chunks_exact(row as usize) {
        out.extend_from_slice(&chunk[..(w * 4) as usize]);
    }
    drop(mapped);
    buffer.unmap();
    Ok(out)
}

/// Resolves when the GPU has finished all work submitted so far.
pub async fn finished(gpu: &Gpu) {
    let (tx, rx) = futures_channel::oneshot::channel();
    gpu.queue.on_submitted_work_done(move || {
        let _ = tx.send(());
    });
    let _ = rx.await;
}
