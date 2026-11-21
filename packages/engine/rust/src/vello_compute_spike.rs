//! SPIKE PROTOTYPE (decision 0040 zoom-transform research spike):
//! Full Vello GPU compute pipeline (`vello_encoding` + `vello_shaders` WGSL) with a GPU-side
//! view-transform pass so zoom and pan frames render exact vectors without CPU re-encoding.
//!
//! NOT PRODUCTIONISED. Intentionally isolated to this module and gated on `#[cfg(feature = "gpu")]`
//! (WebGPU core browser build only; zero impact on `worker` or `webgl` builds).
//!
//! Architecture:
//! 1. On document revision change (cold encode), walk `Store` once in page coordinates (no camera
//!    view baked in), encode paths/strokes/clips/glyph runs into a `vello_encoding::Encoding`,
//!    resolve ramps/images, upload the packed scene buffer + immutable `base_transforms` buffer,
//!    and run the camera-invariant prefix passes (`pathtag_reduce`, `pathtag_scan`, `draw_reduce`)
//!    once on the GPU.
//! 2. On every zoom/pan frame (hot frame), upload only 128 bytes of uniforms (`ViewParams` +
//!    `ConfigUniform`), dispatch a 1-pass compute shader that writes `view * base_transforms[i]`
//!    into `scene[transform_base..]`, and dispatch Vello's remaining compute stages (`bbox_clear`
//!    through `fine_area` or `fine_msaa16`). Zero CPU scene walk, zero CPU flattening, zero
//!    per-frame scene upload.

use crate::error::{EngineError, ErrorCode, Result};
use crate::geometry;
use crate::gpu::{self, Flights, Health, InFlight, ReadBack};
use crate::record::{ComposeMode, GradientKind, Op, Paint, PathEntry, Record, StrokeStyle};
use crate::store::{ROOT, Store};
use bytemuck::{Pod, Zeroable};
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::Arc;
use vello_common::kurbo::{Affine, BezPath, Cap, Join, PathEl, Rect, Shape, Stroke};
use vello_common::peniko::{
    BlendMode, BrushRef, Color, ColorStop, ColorStops, Compose, Extend, Fill, Gradient,
    InterpolationAlphaSpace, Mix,
};
use vello_encoding::{
    BufferSize, BufferSizes, BumpAllocators, ConfigUniform, DrawBeginClip, Encoding, Layout,
    LineSoup, PathEncoder, PathSegment, PathTag, Resolver, SegmentCount, Tile, Transform,
    WorkgroupCounts, make_mask_lut_16,
};
use vello_shaders::{BindType, ComputeShader, SHADERS};

const APPLY_VIEW_WGSL: &str = r#"
struct ViewParams {
    mat: vec4<f32>,
    trans: vec2<f32>,
    transform_base: u32,
    n_transforms: u32,
}

@group(0) @binding(0) var<uniform> view: ViewParams;
@group(0) @binding(1) var<storage, read> base_transforms: array<u32>;
@group(0) @binding(2) var<storage, read_write> scene: array<u32>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let i = gid.x;
    if i >= view.n_transforms {
        return;
    }
    let src = i * 6u;
    let o0 = bitcast<f32>(base_transforms[src + 0u]);
    let o1 = bitcast<f32>(base_transforms[src + 1u]);
    let o2 = bitcast<f32>(base_transforms[src + 2u]);
    let o3 = bitcast<f32>(base_transforms[src + 3u]);
    let o4 = bitcast<f32>(base_transforms[src + 4u]);
    let o5 = bitcast<f32>(base_transforms[src + 5u]);

    let m0 = view.mat.x * o0 + view.mat.z * o1;
    let m1 = view.mat.y * o0 + view.mat.w * o1;
    let m2 = view.mat.x * o2 + view.mat.z * o3;
    let m3 = view.mat.y * o2 + view.mat.w * o3;
    let t0 = view.mat.x * o4 + view.mat.z * o5 + view.trans.x;
    let t1 = view.mat.y * o4 + view.mat.w * o5 + view.trans.y;

    let dst = view.transform_base + src;
    scene[dst + 0u] = bitcast<u32>(m0);
    scene[dst + 1u] = bitcast<u32>(m1);
    scene[dst + 2u] = bitcast<u32>(m2);
    scene[dst + 3u] = bitcast<u32>(m3);
    scene[dst + 4u] = bitcast<u32>(t0);
    scene[dst + 5u] = bitcast<u32>(t1);
}
"#;

#[derive(Clone, Copy, Pod, Zeroable)]
#[repr(C)]
struct ViewParams {
    mat: [f32; 4],
    trans: [f32; 2],
    transform_base: u32,
    n_transforms: u32,
}

#[derive(Clone, Copy, Debug)]
pub struct SpikeFrameStats {
    pub encode_ms: f64,
    pub render_ms: f64,
    pub submit_ms: f64,
    pub cpu_ms: f64,
    pub n_paths: u32,
    pub glyphs: u32,
}

#[derive(Clone, Copy, Debug, Default)]
struct BumpCaps {
    binning: u32,
    ptcl: u32,
    tile: u32,
    seg_counts: u32,
    segments: u32,
    blend: u32,
    lines: u32,
}

struct PipelineEntry {
    pipeline: wgpu::ComputePipeline,
    layout: wgpu::BindGroupLayout,
    binding_indices: Vec<u32>,
}

impl PipelineEntry {
    fn from_vello(device: &wgpu::Device, label: &str, shader: &ComputeShader<'_>) -> Self {
        let mut entries = Vec::with_capacity(shader.bindings.len());
        let mut binding_indices = Vec::with_capacity(shader.bindings.len());
        for (ty, &idx) in shader.bindings.iter().zip(shader.wgsl.binding_indices.iter()) {
            let binding = u32::from(idx);
            binding_indices.push(binding);
            let bty = match *ty {
                BindType::Buffer => wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Storage { read_only: false },
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                BindType::BufReadOnly => wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Storage { read_only: true },
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                BindType::Uniform => wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                BindType::Image => wgpu::BindingType::StorageTexture {
                    access: wgpu::StorageTextureAccess::WriteOnly,
                    format: wgpu::TextureFormat::Rgba8Unorm,
                    view_dimension: wgpu::TextureViewDimension::D2,
                },
                BindType::ImageRead => wgpu::BindingType::Texture {
                    sample_type: wgpu::TextureSampleType::Float { filterable: true },
                    view_dimension: wgpu::TextureViewDimension::D2,
                    multisampled: false,
                },
            };
            entries.push(wgpu::BindGroupLayoutEntry {
                binding,
                visibility: wgpu::ShaderStages::COMPUTE,
                ty: bty,
                count: None,
            });
        }
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some(label),
            entries: &entries,
        });
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some(label),
            source: wgpu::ShaderSource::Wgsl(shader.wgsl.code.as_ref().into()),
        });
        let pl = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some(label),
            bind_group_layouts: &[Some(&layout)],
            immediate_size: 0,
        });
        let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some(label),
            layout: Some(&pl),
            module: &module,
            entry_point: Some("main"),
            compilation_options: wgpu::PipelineCompilationOptions::default(),
            cache: None,
        });
        Self {
            pipeline,
            layout,
            binding_indices,
        }
    }

    fn bind_group(&self, device: &wgpu::Device, label: &str, resources: &[wgpu::BindingResource<'_>]) -> wgpu::BindGroup {
        debug_assert_eq!(resources.len(), self.binding_indices.len());
        let entries: Vec<wgpu::BindGroupEntry<'_>> = self
            .binding_indices
            .iter()
            .zip(resources.iter())
            .map(|(&binding, resource)| wgpu::BindGroupEntry {
                binding,
                resource: resource.clone(),
            })
            .collect();
        device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some(label),
            layout: &self.layout,
            entries: &entries,
        })
    }
}

struct SpikePipelines {
    apply_view: wgpu::ComputePipeline,
    apply_view_layout: wgpu::BindGroupLayout,
    pathtag_reduce: PipelineEntry,
    pathtag_reduce2: PipelineEntry,
    pathtag_scan1: PipelineEntry,
    pathtag_scan_small: PipelineEntry,
    pathtag_scan_large: PipelineEntry,
    bbox_clear: PipelineEntry,
    flatten: PipelineEntry,
    draw_reduce: PipelineEntry,
    draw_leaf: PipelineEntry,
    clip_reduce: PipelineEntry,
    clip_leaf: PipelineEntry,
    binning: PipelineEntry,
    tile_alloc: PipelineEntry,
    path_count_setup: PipelineEntry,
    path_count: PipelineEntry,
    backdrop: PipelineEntry,
    coarse: PipelineEntry,
    path_tiling_setup: PipelineEntry,
    path_tiling: PipelineEntry,
    fine_area: PipelineEntry,
    fine_msaa16: PipelineEntry,
    mask_lut_16: wgpu::Buffer,
}

impl SpikePipelines {
    fn new(device: &wgpu::Device, queue: &wgpu::Queue) -> Self {
        let apply_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("spike.apply_view"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Storage { read_only: true },
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Storage { read_only: false },
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
            ],
        });
        let apply_mod = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("spike.apply_view"),
            source: wgpu::ShaderSource::Wgsl(APPLY_VIEW_WGSL.into()),
        });
        let apply_pl = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("spike.apply_view"),
            bind_group_layouts: &[Some(&apply_layout)],
            immediate_size: 0,
        });
        let apply_view = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("spike.apply_view"),
            layout: Some(&apply_pl),
            module: &apply_mod,
            entry_point: Some("main"),
            compilation_options: wgpu::PipelineCompilationOptions::default(),
            cache: None,
        });

        let mask_bytes = make_mask_lut_16();
        let mask_lut_16 = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("spike.mask_lut_16"),
            size: (mask_bytes.len() as u64).max(4),
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        queue.write_buffer(&mask_lut_16, 0, &mask_bytes);

        let s = &SHADERS;
        Self {
            apply_view,
            apply_view_layout: apply_layout,
            pathtag_reduce: PipelineEntry::from_vello(device, "spike.pathtag_reduce", &s.pathtag_reduce),
            pathtag_reduce2: PipelineEntry::from_vello(device, "spike.pathtag_reduce2", &s.pathtag_reduce2),
            pathtag_scan1: PipelineEntry::from_vello(device, "spike.pathtag_scan1", &s.pathtag_scan1),
            pathtag_scan_small: PipelineEntry::from_vello(device, "spike.pathtag_scan_small", &s.pathtag_scan_small),
            pathtag_scan_large: PipelineEntry::from_vello(device, "spike.pathtag_scan_large", &s.pathtag_scan_large),
            bbox_clear: PipelineEntry::from_vello(device, "spike.bbox_clear", &s.bbox_clear),
            flatten: PipelineEntry::from_vello(device, "spike.flatten", &s.flatten),
            draw_reduce: PipelineEntry::from_vello(device, "spike.draw_reduce", &s.draw_reduce),
            draw_leaf: PipelineEntry::from_vello(device, "spike.draw_leaf", &s.draw_leaf),
            clip_reduce: PipelineEntry::from_vello(device, "spike.clip_reduce", &s.clip_reduce),
            clip_leaf: PipelineEntry::from_vello(device, "spike.clip_leaf", &s.clip_leaf),
            binning: PipelineEntry::from_vello(device, "spike.binning", &s.binning),
            tile_alloc: PipelineEntry::from_vello(device, "spike.tile_alloc", &s.tile_alloc),
            path_count_setup: PipelineEntry::from_vello(device, "spike.path_count_setup", &s.path_count_setup),
            path_count: PipelineEntry::from_vello(device, "spike.path_count", &s.path_count),
            backdrop: PipelineEntry::from_vello(device, "spike.backdrop", &s.backdrop_dyn),
            coarse: PipelineEntry::from_vello(device, "spike.coarse", &s.coarse),
            path_tiling_setup: PipelineEntry::from_vello(device, "spike.path_tiling_setup", &s.path_tiling_setup),
            path_tiling: PipelineEntry::from_vello(device, "spike.path_tiling", &s.path_tiling),
            fine_area: PipelineEntry::from_vello(device, "spike.fine_area", &s.fine_area),
            fine_msaa16: PipelineEntry::from_vello(device, "spike.fine_msaa16", &s.fine_msaa16),
            mask_lut_16,
        }
    }
}

/// GPU-resident scene built once per document revision in page coordinates, plus precomputed
/// camera-invariant monoids (`tagmonoid_buf`, `draw_reduced_buf`).
struct RetainedScene {
    revision: u32,
    generation: u64,
    layout: Layout,
    n_path_segments: u32,
    n_transforms: u32,
    n_glyphs: u32,
    packed_bytes: usize,
    cold_encode_ms: f64,
    cold_resolve_ms: f64,
    cold_upload_ms: f64,
    // GPU buffers owned by this scene
    scene_buf: wgpu::Buffer,
    base_transforms_buf: wgpu::Buffer,
    tagmonoid_buf: wgpu::Buffer,
    draw_reduced_buf: wgpu::Buffer,
    gradient_tex: wgpu::Texture,
    gradient_view: wgpu::TextureView,
    image_atlas_tex: wgpu::Texture,
    image_atlas_view: wgpu::TextureView,
    // Per-scene persistent working buffers (independent of viewport except bin_headers)
    view_buf: wgpu::Buffer,
    config_buf: wgpu::Buffer,
    bump_buf: wgpu::Buffer,
    indirect_count_buf: wgpu::Buffer,
    path_bbox_buf: wgpu::Buffer,
    draw_monoid_buf: wgpu::Buffer,
    clip_inp_buf: wgpu::Buffer,
    clip_el_buf: wgpu::Buffer,
    clip_bic_buf: wgpu::Buffer,
    clip_bbox_buf: wgpu::Buffer,
    draw_bbox_buf: wgpu::Buffer,
    path_buf: wgpu::Buffer,
    // Dynamically sized bump buffers
    caps: BumpCaps,
    info_bin_data_buf: wgpu::Buffer,
    tile_buf: wgpu::Buffer,
    lines_buf: wgpu::Buffer,
    seg_counts_buf: wgpu::Buffer,
    segments_buf: wgpu::Buffer,
    ptcl_buf: wgpu::Buffer,
    blend_spill_buf: wgpu::Buffer,
    total_gpu_bytes: u64,
    max_bind_bytes: u64,
    // Cached bind groups that do not depend on viewport
    bg_apply_view: wgpu::BindGroup,
    bg_bbox_clear: wgpu::BindGroup,
    bg_flatten: wgpu::BindGroup,
    bg_draw_leaf: wgpu::BindGroup,
    bg_clip_reduce: wgpu::BindGroup,
    bg_clip_leaf: wgpu::BindGroup,
    bg_tile_alloc: wgpu::BindGroup,
    bg_path_count_setup: wgpu::BindGroup,
    bg_path_count: wgpu::BindGroup,
    bg_backdrop: wgpu::BindGroup,
    bg_path_tiling_setup: wgpu::BindGroup,
    bg_path_tiling: wgpu::BindGroup,
}

impl RetainedScene {
    fn destroy(&self) {
        self.scene_buf.destroy();
        self.base_transforms_buf.destroy();
        self.tagmonoid_buf.destroy();
        self.draw_reduced_buf.destroy();
        self.gradient_tex.destroy();
        self.image_atlas_tex.destroy();
        self.view_buf.destroy();
        self.config_buf.destroy();
        self.bump_buf.destroy();
        self.indirect_count_buf.destroy();
        self.path_bbox_buf.destroy();
        self.draw_monoid_buf.destroy();
        self.clip_inp_buf.destroy();
        self.clip_el_buf.destroy();
        self.clip_bic_buf.destroy();
        self.clip_bbox_buf.destroy();
        self.draw_bbox_buf.destroy();
        self.path_buf.destroy();
        self.info_bin_data_buf.destroy();
        self.tile_buf.destroy();
        self.lines_buf.destroy();
        self.seg_counts_buf.destroy();
        self.segments_buf.destroy();
        self.ptcl_buf.destroy();
        self.blend_spill_buf.destroy();
    }
}

/// Viewport-dependent GPU resources (output storage texture, bin headers, and their bind groups).
struct ViewportResources {
    width: u32,
    height: u32,
    scene_revision: u32,
    scene_generation: u64,
    out_tex: wgpu::Texture,
    out_view: wgpu::TextureView,
    bin_header_buf: wgpu::Buffer,
    wg_counts: WorkgroupCounts,
    bg_binning: wgpu::BindGroup,
    bg_coarse: wgpu::BindGroup,
    bg_fine_area: wgpu::BindGroup,
    bg_fine_msaa16: wgpu::BindGroup,
}

impl ViewportResources {
    fn destroy(&self) {
        self.out_tex.destroy();
        self.bin_header_buf.destroy();
    }
}

pub struct VelloComputeSpike {
    pipelines: SpikePipelines,
    retained: Option<RetainedScene>,
    viewport: Option<ViewportResources>,
    resolver: Resolver,
}

impl Drop for VelloComputeSpike {
    fn drop(&mut self) {
        if let Some(vp) = self.viewport.take() {
            vp.destroy();
        }
        if let Some(ret) = self.retained.take() {
            ret.destroy();
        }
        self.pipelines.mask_lut_16.destroy();
    }
}

impl VelloComputeSpike {
    pub fn new(device: &wgpu::Device, queue: &wgpu::Queue) -> Self {
        Self {
            pipelines: SpikePipelines::new(device, queue),
            retained: None,
            viewport: None,
            resolver: Resolver::new(),
        }
    }

    pub fn reset(&mut self) {
        if let Some(vp) = self.viewport.take() {
            vp.destroy();
        }
        if let Some(ret) = self.retained.take() {
            ret.destroy();
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn render(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        store: &Store,
        generation: u64,
        width: u32,
        height: u32,
        view: Affine,
        background: [f32; 4],
        aa_mode: u32,
    ) -> Result<SpikeFrameStats> {
        let t_total = gpu::now();
        let mut encode_ms = 0.0;

        let need_rebuild = self
            .retained
            .as_ref()
            .is_none_or(|r| r.revision != store.revision || r.generation != generation);

        if need_rebuild {
            if let Some(vp) = self.viewport.take() {
                vp.destroy();
            }
            if let Some(ret) = self.retained.take() {
                ret.destroy();
            }
            let t_enc = gpu::now();
            let retained = self.build_retained(device, queue, store, generation)?;
            encode_ms = gpu::now() - t_enc;
            self.retained = Some(retained);
        }

        let t_setup = gpu::now();
        let ret = self.retained.as_ref().expect("retained scene");
        let need_vp = self.viewport.as_ref().is_none_or(|vp| {
            vp.width != width
                || vp.height != height
                || vp.scene_revision != ret.revision
                || vp.scene_generation != ret.generation
        });
        if need_vp {
            if let Some(vp) = self.viewport.take() {
                vp.destroy();
            }
            let vp = build_viewport(device, &self.pipelines, ret, width, height)?;
            self.viewport = Some(vp);
        }

        let ret = self.retained.as_ref().expect("retained scene");
        let vp = self.viewport.as_ref().expect("viewport resources");
        let render_ms = gpu::now() - t_setup;

        let t_sub = gpu::now();
        let bg_color = Color::new([background[0], background[1], background[2], background[3]]);
        let mut cfg = make_config_uniform(&ret.layout, width, height, &bg_color, ret.caps);

        if ret.layout.n_paths == 0 {
            // Empty scene: clear output texture via render pass.
            let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("spike.clear_empty"),
            });
            {
                let _rpass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: Some("spike.clear"),
                    color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                        view: &vp.out_view,
                        depth_slice: None,
                        resolve_target: None,
                        ops: wgpu::Operations {
                            load: wgpu::LoadOp::Clear(wgpu::Color {
                                r: f64::from(background[0]),
                                g: f64::from(background[1]),
                                b: f64::from(background[2]),
                                a: f64::from(background[3]),
                            }),
                            store: wgpu::StoreOp::Store,
                        },
                    })],
                    depth_stencil_attachment: None,
                    occlusion_query_set: None,
                    timestamp_writes: None,
                    multiview_mask: None,
                });
            }
            queue.submit([encoder.finish()]);
            let submit_ms = gpu::now() - t_sub;
            return Ok(SpikeFrameStats {
                encode_ms,
                render_ms,
                submit_ms,
                cpu_ms: gpu::now() - t_total,
                n_paths: 0,
                glyphs: 0,
            });
        }

        let c = view.as_coeffs();
        let view_params = ViewParams {
            mat: [c[0] as f32, c[1] as f32, c[2] as f32, c[3] as f32],
            trans: [c[4] as f32, c[5] as f32],
            transform_base: ret.layout.transform_base,
            n_transforms: ret.n_transforms,
        };
        // Ensure config_uniform has exact target dims and background.
        cfg.target_width = width;
        cfg.target_height = height;

        queue.write_buffer(&ret.view_buf, 0, bytemuck::bytes_of(&view_params));
        queue.write_buffer(&ret.config_buf, 0, bytemuck::bytes_of(&cfg));

        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("spike.vello_compute"),
        });
        encoder.clear_buffer(&ret.bump_buf, 0, None);

        let wg = &vp.wg_counts;

        // Pass 0: apply view transform to all transforms on GPU (zero CPU re-encode!).
        if ret.n_transforms > 0 {
            let mut cpass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("spike.apply_view"),
                timestamp_writes: None,
            });
            cpass.set_pipeline(&self.pipelines.apply_view);
            cpass.set_bind_group(0, &ret.bg_apply_view, &[]);
            cpass.dispatch_workgroups(ret.n_transforms.div_ceil(256), 1, 1);
        }

        // Helper macro to keep compute pass dispatch concise (each stage in its own compute pass
        // guarantees storage buffer barriers between stages, matching Vello's wgpu_engine.rs).
        macro_rules! dispatch {
            ($label:expr, $pipe:expr, $bg:expr, $size:expr) => {{
                let (x, y, z) = $size;
                if x > 0 && y > 0 && z > 0 {
                    let mut cpass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                        label: Some($label),
                        timestamp_writes: None,
                    });
                    cpass.set_pipeline(&$pipe.pipeline);
                    cpass.set_bind_group(0, $bg, &[]);
                    cpass.dispatch_workgroups(x, y, z);
                }
            }};
        }

        macro_rules! dispatch_indirect {
            ($label:expr, $pipe:expr, $bg:expr) => {{
                let mut cpass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                    label: Some($label),
                    timestamp_writes: None,
                });
                cpass.set_pipeline(&$pipe.pipeline);
                cpass.set_bind_group(0, $bg, &[]);
                cpass.dispatch_workgroups_indirect(&ret.indirect_count_buf, 0);
            }};
        }

        dispatch!("spike.bbox_clear", self.pipelines.bbox_clear, &ret.bg_bbox_clear, wg.bbox_clear);
        dispatch!("spike.flatten", self.pipelines.flatten, &ret.bg_flatten, wg.flatten);
        dispatch!("spike.draw_leaf", self.pipelines.draw_leaf, &ret.bg_draw_leaf, wg.draw_leaf);
        if wg.clip_reduce.0 > 0 {
            dispatch!(
                "spike.clip_reduce",
                self.pipelines.clip_reduce,
                &ret.bg_clip_reduce,
                wg.clip_reduce
            );
        }
        if wg.clip_leaf.0 > 0 {
            dispatch!(
                "spike.clip_leaf",
                self.pipelines.clip_leaf,
                &ret.bg_clip_leaf,
                wg.clip_leaf
            );
        }
        dispatch!("spike.binning", self.pipelines.binning, &vp.bg_binning, wg.binning);
        dispatch!("spike.tile_alloc", self.pipelines.tile_alloc, &ret.bg_tile_alloc, wg.tile_alloc);
        dispatch!(
            "spike.path_count_setup",
            self.pipelines.path_count_setup,
            &ret.bg_path_count_setup,
            wg.path_count_setup
        );
        dispatch_indirect!("spike.path_count", self.pipelines.path_count, &ret.bg_path_count);
        dispatch!("spike.backdrop", self.pipelines.backdrop, &ret.bg_backdrop, wg.backdrop);
        dispatch!("spike.coarse", self.pipelines.coarse, &vp.bg_coarse, wg.coarse);
        dispatch!(
            "spike.path_tiling_setup",
            self.pipelines.path_tiling_setup,
            &ret.bg_path_tiling_setup,
            wg.path_tiling_setup
        );
        dispatch_indirect!("spike.path_tiling", self.pipelines.path_tiling, &ret.bg_path_tiling);

        if aa_mode == 1 {
            dispatch!("spike.fine_msaa16", self.pipelines.fine_msaa16, &vp.bg_fine_msaa16, wg.fine);
        } else {
            dispatch!("spike.fine_area", self.pipelines.fine_area, &vp.bg_fine_area, wg.fine);
        }

        queue.submit([encoder.finish()]);
        let submit_ms = gpu::now() - t_sub;
        Ok(SpikeFrameStats {
            encode_ms,
            render_ms,
            submit_ms,
            cpu_ms: gpu::now() - t_total,
            n_paths: ret.layout.n_paths,
            glyphs: ret.n_glyphs,
        })
    }

    /// Starts a readback of the spike's output texture (already straight RGBA8 from `fine.wgsl`).
    pub fn read_back_start(&self, device: &wgpu::Device, queue: &wgpu::Queue, flights: Rc<Flights>) -> Result<ReadBack> {
        let vp = self
            .viewport
            .as_ref()
            .ok_or_else(|| EngineError::new(ErrorCode::State, "no spike frame rendered yet"))?;
        let (w, h) = (vp.width, vp.height);
        let row = (w * 4).next_multiple_of(256);
        let size = u64::from(row) * u64::from(h);
        let buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("spike.readback"),
            size,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("spike.readback"),
        });
        encoder.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo {
                texture: &vp.out_tex,
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
        queue.submit([encoder.finish()]);
        Ok((buffer, w, h, row, InFlight::new(flights, size as usize)))
    }

    /// Copies the 32-byte `BumpAllocators` buffer to a staging buffer for async diagnostic readback.
    pub fn start_stats_readback(&self, device: &wgpu::Device, queue: &wgpu::Queue) -> Result<(wgpu::Buffer, String)> {
        let ret = self
            .retained
            .as_ref()
            .ok_or_else(|| EngineError::new(ErrorCode::State, "no spike scene uploaded yet"))?;
        let size = size_of::<BumpAllocators>() as u64;
        let staging = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("spike.bump_readback"),
            size,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("spike.bump_readback"),
        });
        encoder.copy_buffer_to_buffer(&ret.bump_buf, 0, &staging, 0, size);
        queue.submit([encoder.finish()]);

        let meta = format!(
            concat!(
                "\"capacities\":{{\"binning\":{},\"ptcl\":{},\"tile\":{},\"seg_counts\":{},\"segments\":{},\"blend\":{},\"lines\":{},\"maxBindBytes\":{}}},",
                "\"scene\":{{\"nPaths\":{},\"nDrawObjects\":{},\"nClips\":{},\"nPathSegments\":{},\"nTransforms\":{},\"nGlyphs\":{},",
                "\"packedBytes\":{},\"totalGpuBytes\":{},\"coldEncodeMs\":{:.3},\"coldResolveMs\":{:.3},\"coldUploadMs\":{:.3}}}"
            ),
            ret.caps.binning,
            ret.caps.ptcl,
            ret.caps.tile,
            ret.caps.seg_counts,
            ret.caps.segments,
            ret.caps.blend,
            ret.caps.lines,
            ret.max_bind_bytes,
            ret.layout.n_paths,
            ret.layout.n_draw_objects,
            ret.layout.n_clips,
            ret.n_path_segments,
            ret.n_transforms,
            ret.n_glyphs,
            ret.packed_bytes,
            ret.total_gpu_bytes,
            ret.cold_encode_ms,
            ret.cold_resolve_ms,
            ret.cold_upload_ms,
        );
        Ok((staging, meta))
    }

    fn build_retained(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        store: &Store,
        generation: u64,
    ) -> Result<RetainedScene> {
        let t0 = gpu::now();
        let mut encoder = SceneBuilder::new(store);
        encoder.walk_root();
        let cold_encode_ms = gpu::now() - t0;

        let t1 = gpu::now();
        let n_path_segments = encoder.encoding.n_path_segments;
        let n_glyphs = encoder.glyphs_encoded;
        let mut packed = Vec::new();
        let (layout, ramps, images) = self.resolver.resolve(&encoder.encoding, &mut packed);
        let cold_resolve_ms = gpu::now() - t1;

        let t2 = gpu::now();
        let packed_bytes = packed.len();
        if packed.is_empty() {
            packed.resize(4, 0);
        }

        // Extract immutable page-space transforms for GPU-side view multiplication.
        let transform_bytes: &[u8] = if layout.n_paths > 0 {
            let start = layout.transform_base as usize * 4;
            let end = layout.style_base as usize * 4;
            &packed[start..end]
        } else {
            &[]
        };
        let n_transforms = (transform_bytes.len() / size_of::<Transform>()) as u32;

        let limits = device.limits();
        let max_bind = (limits.max_storage_buffer_binding_size as u64).min(limits.max_buffer_size);
        let caps = compute_bump_caps(&layout, n_path_segments, max_bind);

        let mut total_gpu_bytes = 0u64;
        let mut make_buf = |label: &str, size: u64, usage: wgpu::BufferUsages| -> wgpu::Buffer {
            let sz = size.max(4).next_multiple_of(4);
            total_gpu_bytes += sz;
            device.create_buffer(&wgpu::BufferDescriptor {
                label: Some(label),
                size: sz,
                usage,
                mapped_at_creation: false,
            })
        };

        let scene_buf = make_buf(
            "spike.scene",
            packed.len() as u64,
            wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
        );
        queue.write_buffer(&scene_buf, 0, &packed);

        let base_transforms_buf = make_buf(
            "spike.base_transforms",
            (transform_bytes.len() as u64).max(24),
            wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
        );
        if !transform_bytes.is_empty() {
            queue.write_buffer(&base_transforms_buf, 0, transform_bytes);
        }

        // Gradient ramp texture.
        let (gw, gh) = if ramps.height == 0 { (1, 1) } else { (ramps.width, ramps.height) };
        let gradient_tex = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("spike.gradients"),
            size: wgpu::Extent3d {
                width: gw,
                height: gh,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        if ramps.height > 0 {
            let data: &[u8] = bytemuck::cast_slice(ramps.data);
            queue.write_texture(
                wgpu::TexelCopyTextureInfo {
                    texture: &gradient_tex,
                    mip_level: 0,
                    origin: wgpu::Origin3d::ZERO,
                    aspect: wgpu::TextureAspect::All,
                },
                data,
                wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(gw * 4),
                    rows_per_image: None,
                },
                wgpu::Extent3d {
                    width: gw,
                    height: gh,
                    depth_or_array_layers: 1,
                },
            );
        }
        let gradient_view = gradient_tex.create_view(&Default::default());

        // Image atlas texture (minimal 1x1 if unused).
        let (aw, ah) = (images.width.max(1), images.height.max(1));
        let image_atlas_tex = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("spike.image_atlas"),
            size: wgpu::Extent3d {
                width: aw,
                height: ah,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        for (img, x, y) in images.images {
            queue.write_texture(
                wgpu::TexelCopyTextureInfo {
                    texture: &image_atlas_tex,
                    mip_level: 0,
                    origin: wgpu::Origin3d { x: *x, y: *y, z: 0 },
                    aspect: wgpu::TextureAspect::All,
                },
                img.data.data(),
                wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(img.width * 4),
                    rows_per_image: None,
                },
                wgpu::Extent3d {
                    width: img.width,
                    height: img.height,
                    depth_or_array_layers: 1,
                },
            );
        }
        let image_atlas_view = image_atlas_tex.create_view(&Default::default());

        // Compute base workgroup counts and known buffer sizes directly (avoiding stock
        // `RenderConfig::new`, whose `bin_data.len() - layout.bin_data_start` underflows once a
        // large page exceeds 262k draw-info words).
        let wgc = WorkgroupCounts::new(&layout, 1, 1, layout.path_tags_size());
        let bs = BufferSizes::new(&layout, &wgc);

        let view_buf = make_buf(
            "spike.view",
            size_of::<ViewParams>() as u64,
            wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        );
        let config_buf = make_buf(
            "spike.config",
            size_of::<ConfigUniform>() as u64,
            wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        );
        let tagmonoid_buf = make_buf(
            "spike.tagmonoid",
            u64::from(bs.path_monoids.size_in_bytes()),
            wgpu::BufferUsages::STORAGE,
        );
        let draw_reduced_buf = make_buf(
            "spike.draw_reduced",
            u64::from(bs.draw_reduced.size_in_bytes()),
            wgpu::BufferUsages::STORAGE,
        );
        let bump_buf = make_buf(
            "spike.bump",
            u64::from(bs.bump_alloc.size_in_bytes()),
            wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::COPY_SRC,
        );
        let indirect_count_buf = make_buf(
            "spike.indirect",
            u64::from(bs.indirect_count.size_in_bytes()),
            wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::INDIRECT,
        );
        let path_bbox_buf = make_buf(
            "spike.path_bbox",
            u64::from(bs.path_bboxes.size_in_bytes()),
            wgpu::BufferUsages::STORAGE,
        );
        let draw_monoid_buf = make_buf(
            "spike.draw_monoid",
            u64::from(bs.draw_monoids.size_in_bytes()),
            wgpu::BufferUsages::STORAGE,
        );
        let clip_inp_buf = make_buf(
            "spike.clip_inp",
            u64::from(bs.clip_inps.size_in_bytes()),
            wgpu::BufferUsages::STORAGE,
        );
        let clip_el_buf = make_buf(
            "spike.clip_el",
            u64::from(bs.clip_els.size_in_bytes()),
            wgpu::BufferUsages::STORAGE,
        );
        let clip_bic_buf = make_buf(
            "spike.clip_bic",
            u64::from(bs.clip_bics.size_in_bytes()),
            wgpu::BufferUsages::STORAGE,
        );
        let clip_bbox_buf = make_buf(
            "spike.clip_bbox",
            u64::from(bs.clip_bboxes.size_in_bytes()),
            wgpu::BufferUsages::STORAGE,
        );
        let draw_bbox_buf = make_buf(
            "spike.draw_bbox",
            u64::from(bs.draw_bboxes.size_in_bytes()),
            wgpu::BufferUsages::STORAGE,
        );
        let path_buf = make_buf(
            "spike.paths",
            u64::from(bs.paths.size_in_bytes()),
            wgpu::BufferUsages::STORAGE,
        );

        let info_bin_words = u64::from(layout.bin_data_start) + u64::from(caps.binning);
        let info_bin_data_buf = make_buf("spike.info_bin_data", info_bin_words * 4, wgpu::BufferUsages::STORAGE);
        let tile_buf = make_buf(
            "spike.tiles",
            u64::from(caps.tile) * size_of::<Tile>() as u64,
            wgpu::BufferUsages::STORAGE,
        );
        let lines_buf = make_buf(
            "spike.lines",
            u64::from(caps.lines) * size_of::<LineSoup>() as u64,
            wgpu::BufferUsages::STORAGE,
        );
        let seg_counts_buf = make_buf(
            "spike.seg_counts",
            u64::from(caps.seg_counts) * size_of::<SegmentCount>() as u64,
            wgpu::BufferUsages::STORAGE,
        );
        let segments_buf = make_buf(
            "spike.segments",
            u64::from(caps.segments) * size_of::<PathSegment>() as u64,
            wgpu::BufferUsages::STORAGE,
        );
        let ptcl_buf = make_buf("spike.ptcl", u64::from(caps.ptcl) * 4, wgpu::BufferUsages::STORAGE);
        let blend_spill_buf = make_buf(
            "spike.blend_spill",
            u64::from(caps.blend) * 4,
            wgpu::BufferUsages::STORAGE,
        );
        drop(make_buf);
        total_gpu_bytes += u64::from(gw) * u64::from(gh) * 4 + u64::from(aw) * u64::from(ah) * 4;

        // Precompute camera-invariant prefix sums ONCE on GPU:
        // pathtag_reduce -> (pathtag_reduce2 -> pathtag_scan1) -> pathtag_scan -> tagmonoid_buf
        // draw_reduce -> draw_reduced_buf
        if layout.n_paths > 0 {
            let init_cfg = make_config_uniform(&layout, 16, 16, &Color::TRANSPARENT, caps);
            queue.write_buffer(&config_buf, 0, bytemuck::bytes_of(&init_cfg));

            let reduced_buf = device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("spike.reduced_tmp"),
                size: u64::from(bs.path_reduced.size_in_bytes()).max(4),
                usage: wgpu::BufferUsages::STORAGE,
                mapped_at_creation: false,
            });
            let mut cmd = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("spike.precompute_monoids"),
            });
            let bg_pr = self.pipelines.pathtag_reduce.bind_group(
                device,
                "spike.bg_pathtag_reduce",
                &[
                    config_buf.as_entire_binding(),
                    scene_buf.as_entire_binding(),
                    reduced_buf.as_entire_binding(),
                ],
            );
            {
                let mut cpass = cmd.begin_compute_pass(&wgpu::ComputePassDescriptor::default());
                cpass.set_pipeline(&self.pipelines.pathtag_reduce.pipeline);
                cpass.set_bind_group(0, &bg_pr, &[]);
                cpass.dispatch_workgroups(wgc.path_reduce.0, 1, 1);
            }

            let mut large_tmps: Option<(wgpu::Buffer, wgpu::Buffer)> = None;
            if wgc.use_large_path_scan {
                let reduced2_buf = device.create_buffer(&wgpu::BufferDescriptor {
                    label: Some("spike.reduced2_tmp"),
                    size: u64::from(bs.path_reduced2.size_in_bytes()).max(4),
                    usage: wgpu::BufferUsages::STORAGE,
                    mapped_at_creation: false,
                });
                let reduced_scan_buf = device.create_buffer(&wgpu::BufferDescriptor {
                    label: Some("spike.reduced_scan_tmp"),
                    size: u64::from(bs.path_reduced_scan.size_in_bytes()).max(4),
                    usage: wgpu::BufferUsages::STORAGE,
                    mapped_at_creation: false,
                });
                let bg_pr2 = self.pipelines.pathtag_reduce2.bind_group(
                    device,
                    "spike.bg_pathtag_reduce2",
                    &[reduced_buf.as_entire_binding(), reduced2_buf.as_entire_binding()],
                );
                {
                    let mut cpass = cmd.begin_compute_pass(&wgpu::ComputePassDescriptor::default());
                    cpass.set_pipeline(&self.pipelines.pathtag_reduce2.pipeline);
                    cpass.set_bind_group(0, &bg_pr2, &[]);
                    cpass.dispatch_workgroups(wgc.path_reduce2.0, 1, 1);
                }
                let bg_ps1 = self.pipelines.pathtag_scan1.bind_group(
                    device,
                    "spike.bg_pathtag_scan1",
                    &[
                        reduced_buf.as_entire_binding(),
                        reduced2_buf.as_entire_binding(),
                        reduced_scan_buf.as_entire_binding(),
                    ],
                );
                {
                    let mut cpass = cmd.begin_compute_pass(&wgpu::ComputePassDescriptor::default());
                    cpass.set_pipeline(&self.pipelines.pathtag_scan1.pipeline);
                    cpass.set_bind_group(0, &bg_ps1, &[]);
                    cpass.dispatch_workgroups(wgc.path_scan1.0, 1, 1);
                }
                let bg_ps = self.pipelines.pathtag_scan_large.bind_group(
                    device,
                    "spike.bg_pathtag_scan_large",
                    &[
                        config_buf.as_entire_binding(),
                        scene_buf.as_entire_binding(),
                        reduced_scan_buf.as_entire_binding(),
                        tagmonoid_buf.as_entire_binding(),
                    ],
                );
                {
                    let mut cpass = cmd.begin_compute_pass(&wgpu::ComputePassDescriptor::default());
                    cpass.set_pipeline(&self.pipelines.pathtag_scan_large.pipeline);
                    cpass.set_bind_group(0, &bg_ps, &[]);
                    cpass.dispatch_workgroups(wgc.path_scan.0, 1, 1);
                }
                large_tmps = Some((reduced2_buf, reduced_scan_buf));
            } else {
                let bg_ps = self.pipelines.pathtag_scan_small.bind_group(
                    device,
                    "spike.bg_pathtag_scan_small",
                    &[
                        config_buf.as_entire_binding(),
                        scene_buf.as_entire_binding(),
                        reduced_buf.as_entire_binding(),
                        tagmonoid_buf.as_entire_binding(),
                    ],
                );
                {
                    let mut cpass = cmd.begin_compute_pass(&wgpu::ComputePassDescriptor::default());
                    cpass.set_pipeline(&self.pipelines.pathtag_scan_small.pipeline);
                    cpass.set_bind_group(0, &bg_ps, &[]);
                    cpass.dispatch_workgroups(wgc.path_scan.0, 1, 1);
                }
            }

            if wgc.draw_reduce.0 > 0 {
                let bg_dr = self.pipelines.draw_reduce.bind_group(
                    device,
                    "spike.bg_draw_reduce",
                    &[
                        config_buf.as_entire_binding(),
                        scene_buf.as_entire_binding(),
                        draw_reduced_buf.as_entire_binding(),
                    ],
                );
                let mut cpass = cmd.begin_compute_pass(&wgpu::ComputePassDescriptor::default());
                cpass.set_pipeline(&self.pipelines.draw_reduce.pipeline);
                cpass.set_bind_group(0, &bg_dr, &[]);
                cpass.dispatch_workgroups(wgc.draw_reduce.0, 1, 1);
            }

            queue.submit([cmd.finish()]);
            drop(large_tmps);
            drop(reduced_buf);
        }

        // Build cached bind groups for per-frame dispatches.
        let p = &self.pipelines;
        let bg_apply_view = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("spike.bg_apply_view"),
            layout: &p.apply_view_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: view_buf.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: base_transforms_buf.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: scene_buf.as_entire_binding(),
                },
            ],
        });
        let bg_bbox_clear = p.bbox_clear.bind_group(
            device,
            "spike.bg_bbox_clear",
            &[config_buf.as_entire_binding(), path_bbox_buf.as_entire_binding()],
        );
        let bg_flatten = p.flatten.bind_group(
            device,
            "spike.bg_flatten",
            &[
                config_buf.as_entire_binding(),
                scene_buf.as_entire_binding(),
                tagmonoid_buf.as_entire_binding(),
                path_bbox_buf.as_entire_binding(),
                bump_buf.as_entire_binding(),
                lines_buf.as_entire_binding(),
            ],
        );
        let bg_draw_leaf = p.draw_leaf.bind_group(
            device,
            "spike.bg_draw_leaf",
            &[
                config_buf.as_entire_binding(),
                scene_buf.as_entire_binding(),
                draw_reduced_buf.as_entire_binding(),
                path_bbox_buf.as_entire_binding(),
                draw_monoid_buf.as_entire_binding(),
                info_bin_data_buf.as_entire_binding(),
                clip_inp_buf.as_entire_binding(),
            ],
        );
        let bg_clip_reduce = p.clip_reduce.bind_group(
            device,
            "spike.bg_clip_reduce",
            &[
                clip_inp_buf.as_entire_binding(),
                path_bbox_buf.as_entire_binding(),
                clip_bic_buf.as_entire_binding(),
                clip_el_buf.as_entire_binding(),
            ],
        );
        let bg_clip_leaf = p.clip_leaf.bind_group(
            device,
            "spike.bg_clip_leaf",
            &[
                config_buf.as_entire_binding(),
                clip_inp_buf.as_entire_binding(),
                path_bbox_buf.as_entire_binding(),
                clip_bic_buf.as_entire_binding(),
                clip_el_buf.as_entire_binding(),
                draw_monoid_buf.as_entire_binding(),
                clip_bbox_buf.as_entire_binding(),
            ],
        );
        let bg_tile_alloc = p.tile_alloc.bind_group(
            device,
            "spike.bg_tile_alloc",
            &[
                config_buf.as_entire_binding(),
                scene_buf.as_entire_binding(),
                draw_bbox_buf.as_entire_binding(),
                bump_buf.as_entire_binding(),
                path_buf.as_entire_binding(),
                tile_buf.as_entire_binding(),
            ],
        );
        let bg_path_count_setup = p.path_count_setup.bind_group(
            device,
            "spike.bg_path_count_setup",
            &[bump_buf.as_entire_binding(), indirect_count_buf.as_entire_binding()],
        );
        let bg_path_count = p.path_count.bind_group(
            device,
            "spike.bg_path_count",
            &[
                config_buf.as_entire_binding(),
                bump_buf.as_entire_binding(),
                lines_buf.as_entire_binding(),
                path_buf.as_entire_binding(),
                tile_buf.as_entire_binding(),
                seg_counts_buf.as_entire_binding(),
            ],
        );
        let bg_backdrop = p.backdrop.bind_group(
            device,
            "spike.bg_backdrop",
            &[
                config_buf.as_entire_binding(),
                bump_buf.as_entire_binding(),
                path_buf.as_entire_binding(),
                tile_buf.as_entire_binding(),
            ],
        );
        let bg_path_tiling_setup = p.path_tiling_setup.bind_group(
            device,
            "spike.bg_path_tiling_setup",
            &[
                bump_buf.as_entire_binding(),
                indirect_count_buf.as_entire_binding(),
                ptcl_buf.as_entire_binding(),
            ],
        );
        let bg_path_tiling = p.path_tiling.bind_group(
            device,
            "spike.bg_path_tiling",
            &[
                bump_buf.as_entire_binding(),
                seg_counts_buf.as_entire_binding(),
                lines_buf.as_entire_binding(),
                path_buf.as_entire_binding(),
                tile_buf.as_entire_binding(),
                segments_buf.as_entire_binding(),
            ],
        );

        let cold_upload_ms = gpu::now() - t2;

        Ok(RetainedScene {
            revision: store.revision,
            generation,
            layout,
            n_path_segments,
            n_transforms,
            n_glyphs,
            packed_bytes,
            cold_encode_ms,
            cold_resolve_ms,
            cold_upload_ms,
            scene_buf,
            base_transforms_buf,
            tagmonoid_buf,
            draw_reduced_buf,
            gradient_tex,
            gradient_view,
            image_atlas_tex,
            image_atlas_view,
            view_buf,
            config_buf,
            bump_buf,
            indirect_count_buf,
            path_bbox_buf,
            draw_monoid_buf,
            clip_inp_buf,
            clip_el_buf,
            clip_bic_buf,
            clip_bbox_buf,
            draw_bbox_buf,
            path_buf,
            caps,
            info_bin_data_buf,
            tile_buf,
            lines_buf,
            seg_counts_buf,
            segments_buf,
            ptcl_buf,
            blend_spill_buf,
            total_gpu_bytes,
            max_bind_bytes: max_bind,
            bg_apply_view,
            bg_bbox_clear,
            bg_flatten,
            bg_draw_leaf,
            bg_clip_reduce,
            bg_clip_leaf,
            bg_tile_alloc,
            bg_path_count_setup,
            bg_path_count,
            bg_backdrop,
            bg_path_tiling_setup,
            bg_path_tiling,
        })
    }
}

pub async fn finish_stats_readback(
    device: wgpu::Device,
    health: Arc<Health>,
    staging: wgpu::Buffer,
    meta: String,
) -> Result<String> {
    if let Some(err) = health.stop_error() {
        staging.destroy();
        return Err(err);
    }
    let (tx, rx) = futures_channel::oneshot::channel();
    staging.slice(..).map_async(wgpu::MapMode::Read, move |r| {
        let _ = tx.send(r);
    });
    match gpu::pump(&device, &health, rx, 12_000).await {
        Ok(Ok(())) => {}
        Ok(Err(e)) => {
            staging.destroy();
            return Err(EngineError::new(ErrorCode::Gpu, e.to_string()));
        }
        Err(e) => {
            staging.destroy();
            return Err(e);
        }
    }
    let mapped = staging
        .slice(..)
        .get_mapped_range()
        .map_err(|e| EngineError::new(ErrorCode::Gpu, format!("{e:?}")))?;
    let bump: BumpAllocators = *bytemuck::from_bytes(&mapped[..size_of::<BumpAllocators>()]);
    drop(mapped);
    staging.unmap();
    staging.destroy();
    Ok(format!(
        "{{\"bump\":{{\"failed\":{},\"binning\":{},\"ptcl\":{},\"tile\":{},\"seg_counts\":{},\"segments\":{},\"blend\":{},\"lines\":{}}},{}}}",
        bump.failed,
        bump.binning,
        bump.ptcl,
        bump.tile,
        bump.seg_counts,
        bump.segments,
        bump.blend,
        bump.lines,
        meta,
    ))
}

fn compute_bump_caps(layout: &Layout, n_path_segments: u32, max_bind: u64) -> BumpCaps {
    // Respect the device's maxStorageBufferBindingSize (128 MiB guaranteed in Core, often 256 MiB+
    // on desktop GPUs) while giving 10k-40k layer scenes plenty of headroom at 100% zoom (where
    // stock flatten.wgsl flattens all off-screen curves at full scale without frustum culling).
    let cap_bytes = max_bind.min(256 << 20);
    let max_lines = (cap_bytes / size_of::<LineSoup>() as u64) as u32;
    let max_segments = (cap_bytes / size_of::<PathSegment>() as u64) as u32;
    let max_tiles = (cap_bytes / size_of::<Tile>() as u64) as u32;
    let max_seg_counts = (cap_bytes / size_of::<SegmentCount>() as u64) as u32;
    let max_u32s = (cap_bytes / 4) as u32;

    let binning_max = max_u32s.saturating_sub(layout.bin_data_start).max(1 << 18);
    let binning = (layout.n_draw_objects.saturating_mul(32))
        .clamp(1 << 20, 32 << 20)
        .min(binning_max);
    let lines = (n_path_segments.saturating_mul(24))
        .clamp(4 << 20, max_lines)
        .min(max_lines);
    let tile = (layout.n_paths.saturating_mul(256))
        .clamp(2 << 20, 16 << 20)
        .min(max_tiles);
    let seg_counts = (n_path_segments.saturating_mul(16))
        .clamp(2 << 20, 16 << 20)
        .min(max_seg_counts);
    let segments = (n_path_segments.saturating_mul(16))
        .clamp(2 << 20, max_segments)
        .min(max_segments);
    let ptcl = (16u32 << 20).min(max_u32s); // 64 MiB (16M u32s)
    let blend = (2u32 << 20).min(max_u32s); // 8 MiB (2M u32 pixels)

    BumpCaps {
        binning,
        ptcl,
        tile,
        seg_counts,
        segments,
        blend,
        lines,
    }
}

fn make_config_uniform(
    layout: &Layout,
    width: u32,
    height: u32,
    base_color: &Color,
    caps: BumpCaps,
) -> ConfigUniform {
    let width_in_tiles = width.next_multiple_of(16) / 16;
    let height_in_tiles = height.next_multiple_of(16) / 16;
    ConfigUniform {
        width_in_tiles,
        height_in_tiles,
        target_width: width,
        target_height: height,
        base_color: base_color.premultiply().to_rgba8().to_u32(),
        layout: *layout,
        lines_size: caps.lines,
        binning_size: caps.binning,
        tiles_size: caps.tile,
        seg_counts_size: caps.seg_counts,
        segments_size: caps.segments,
        blend_size: caps.blend,
        ptcl_size: caps.ptcl,
    }
}

fn build_viewport(
    device: &wgpu::Device,
    p: &SpikePipelines,
    ret: &RetainedScene,
    width: u32,
    height: u32,
) -> Result<ViewportResources> {
    let width_in_tiles = width.next_multiple_of(16) / 16;
    let height_in_tiles = height.next_multiple_of(16) / 16;
    let wg = WorkgroupCounts::new(
        &ret.layout,
        width_in_tiles,
        height_in_tiles,
        ret.layout.path_tags_size(),
    );
    let bs = BufferSizes::new(&ret.layout, &wg);
    let n_bins = wg.coarse.0 * wg.coarse.1;
    if n_bins > 256 {
        return Err(EngineError::limit(format!(
            "Vello compute spike supports at most 256 bins (4096x4096); {width}x{height} needs {n_bins}"
        )));
    }
    let out_tex = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("spike.out"),
        size: wgpu::Extent3d {
            width: width.max(1),
            height: height.max(1),
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba8Unorm,
        usage: wgpu::TextureUsages::STORAGE_BINDING
            | wgpu::TextureUsages::COPY_SRC
            | wgpu::TextureUsages::TEXTURE_BINDING
            | wgpu::TextureUsages::RENDER_ATTACHMENT,
        view_formats: &[],
    });
    let out_view = out_tex.create_view(&Default::default());

    let bin_header_size = BufferSize::<vello_encoding::BinHeader>::new(bs.bin_headers.len()).size_in_bytes();
    let bin_header_buf = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("spike.bin_headers"),
        size: u64::from(bin_header_size).max(8),
        usage: wgpu::BufferUsages::STORAGE,
        mapped_at_creation: false,
    });

    let bg_binning = p.binning.bind_group(
        device,
        "spike.bg_binning",
        &[
            ret.config_buf.as_entire_binding(),
            ret.draw_monoid_buf.as_entire_binding(),
            ret.path_bbox_buf.as_entire_binding(),
            ret.clip_bbox_buf.as_entire_binding(),
            ret.draw_bbox_buf.as_entire_binding(),
            ret.bump_buf.as_entire_binding(),
            ret.info_bin_data_buf.as_entire_binding(),
            bin_header_buf.as_entire_binding(),
        ],
    );
    let bg_coarse = p.coarse.bind_group(
        device,
        "spike.bg_coarse",
        &[
            ret.config_buf.as_entire_binding(),
            ret.scene_buf.as_entire_binding(),
            ret.draw_monoid_buf.as_entire_binding(),
            bin_header_buf.as_entire_binding(),
            ret.info_bin_data_buf.as_entire_binding(),
            ret.path_buf.as_entire_binding(),
            ret.tile_buf.as_entire_binding(),
            ret.bump_buf.as_entire_binding(),
            ret.ptcl_buf.as_entire_binding(),
        ],
    );
    let bg_fine_area = p.fine_area.bind_group(
        device,
        "spike.bg_fine_area",
        &[
            ret.config_buf.as_entire_binding(),
            ret.segments_buf.as_entire_binding(),
            ret.ptcl_buf.as_entire_binding(),
            ret.info_bin_data_buf.as_entire_binding(),
            ret.blend_spill_buf.as_entire_binding(),
            wgpu::BindingResource::TextureView(&out_view),
            wgpu::BindingResource::TextureView(&ret.gradient_view),
            wgpu::BindingResource::TextureView(&ret.image_atlas_view),
        ],
    );
    let bg_fine_msaa16 = p.fine_msaa16.bind_group(
        device,
        "spike.bg_fine_msaa16",
        &[
            ret.config_buf.as_entire_binding(),
            ret.segments_buf.as_entire_binding(),
            ret.ptcl_buf.as_entire_binding(),
            ret.info_bin_data_buf.as_entire_binding(),
            ret.blend_spill_buf.as_entire_binding(),
            wgpu::BindingResource::TextureView(&out_view),
            wgpu::BindingResource::TextureView(&ret.gradient_view),
            wgpu::BindingResource::TextureView(&ret.image_atlas_view),
            p.mask_lut_16.as_entire_binding(),
        ],
    );

    Ok(ViewportResources {
        width,
        height,
        scene_revision: ret.revision,
        scene_generation: ret.generation,
        out_tex,
        out_view,
        bin_header_buf,
        wg_counts: wg,
        bg_binning,
        bg_coarse,
        bg_fine_area,
        bg_fine_msaa16,
    })
}

/// Cached pre-encoded glyph outline (`PathTag`s + `u32` coords) for fast memcpy into `Encoding`.
struct EncodedGlyph {
    tags: Vec<PathTag>,
    data: Vec<u32>,
    n_segments: u32,
}

/// Walks Drawpane's `Store` once in PAGE coordinates (camera-independent) into a
/// `vello_encoding::Encoding`.
struct SceneBuilder<'a> {
    store: &'a Store,
    encoding: Encoding,
    glyph_cache: HashMap<u32, EncodedGlyph>,
    glyphs_encoded: u32,
}

impl<'a> SceneBuilder<'a> {
    fn new(store: &'a Store) -> Self {
        Self {
            store,
            encoding: Encoding::new(),
            glyph_cache: HashMap::new(),
            glyphs_encoded: 0,
        }
    }

    fn walk_root(&mut self) {
        let Some(root) = self.store.nodes.get(&ROOT) else {
            return;
        };
        let kids = root.children.clone();
        for id in kids {
            self.walk_node(id, Affine::IDENTITY, 1.0);
        }
    }

    fn walk_node(&mut self, id: u32, parent_world: Affine, parent_alpha: f32) {
        let Some(node) = self.store.nodes.get(&id) else {
            return;
        };
        let r = &node.record;
        if r.hidden() || r.context() {
            return;
        }
        let world = parent_world * r.transform;
        if !world.as_coeffs().iter().all(|v| v.is_finite()) {
            return;
        }
        let opacity = parent_alpha * r.opacity;
        if opacity <= 0.0 {
            return;
        }

        let isolate_layer = (r.isolate() && r.opacity < 1.0) || r.blend != 0;
        let inner_alpha = if isolate_layer { 1.0 } else { opacity };
        let mut pushed_iso = false;
        if isolate_layer {
            let mix = map_mix(r.blend);
            let clip_rect = node_clip_rect(self.store, r);
            self.push_layer_rect(world, clip_rect, BlendMode::new(mix, Compose::SrcOver), opacity);
            pushed_iso = true;
        }

        let mut active_alpha = inner_alpha;
        let mut layer_stack: Vec<f32> = Vec::new();
        let mut open_clips = 0usize;

        for op in &r.ops {
            match op {
                Op::Fill {
                    path,
                    even_odd,
                    paint,
                    blend,
                } => {
                    let pushed_blend = *blend != 0;
                    if pushed_blend {
                        let b = r
                            .entry_bounds(*path, &|g| self.store.glyphs.bounds(g))
                            .unwrap_or_else(|| Rect::new(0.0, 0.0, f64::from(r.size[0]), f64::from(r.size[1])));
                        self.push_layer_rect(
                            world,
                            b.inflate(2.0, 2.0),
                            BlendMode::new(map_mix(u32::from(*blend)), Compose::SrcOver),
                            1.0,
                        );
                    }
                    self.encode_fill(r, *path, world, *even_odd, paint, active_alpha);
                    if pushed_blend {
                        self.encoding.encode_end_clip();
                    }
                }
                Op::Stroke {
                    path,
                    style,
                    paint,
                    blend,
                } => {
                    if style.width <= 0.0 {
                        continue;
                    }
                    let pushed_blend = *blend != 0;
                    if pushed_blend {
                        let reach = style.reach();
                        let b = r
                            .entry_bounds(*path, &|g| self.store.glyphs.bounds(g))
                            .unwrap_or_else(|| Rect::new(0.0, 0.0, f64::from(r.size[0]), f64::from(r.size[1])))
                            .inflate(reach, reach);
                        self.push_layer_rect(
                            world,
                            b,
                            BlendMode::new(map_mix(u32::from(*blend)), Compose::SrcOver),
                            1.0,
                        );
                    }
                    self.encode_stroke(r, *path, world, style, paint, active_alpha);
                    if pushed_blend {
                        self.encoding.encode_end_clip();
                    }
                }
                Op::Clip { path, even_odd } => {
                    let fill = if *even_odd { Fill::EvenOdd } else { Fill::NonZero };
                    if let Some(p) = self.resolve_entry_path(r, *path) {
                        self.encoding.encode_transform(Transform::from_kurbo(&world));
                        self.encoding.encode_fill_style(fill);
                        if !self.encoding.encode_shape(&p, true) {
                            self.encoding.encode_empty_shape();
                        }
                    } else {
                        self.encoding.encode_transform(Transform::from_kurbo(&world));
                        self.encoding.encode_fill_style(fill);
                        self.encoding.encode_empty_shape();
                    }
                    self.encoding.encode_begin_clip(DrawBeginClip::clip());
                    open_clips += 1;
                }
                Op::Unclip => {
                    if open_clips > 0 {
                        self.encoding.encode_end_clip();
                        open_clips -= 1;
                    }
                }
                Op::Layer { compose } => {
                    let (vello_compose, layer_alpha) = match compose {
                        ComposeMode::SrcOver => (Compose::SrcOver, active_alpha),
                        ComposeMode::DestOut => (Compose::DestOut, 1.0),
                        ComposeMode::DestIn => (Compose::DestIn, 1.0),
                    };
                    let clip_rect = node_clip_rect(self.store, r);
                    self.push_layer_rect(world, clip_rect, BlendMode::new(Mix::Normal, vello_compose), layer_alpha);
                    layer_stack.push(active_alpha);
                    active_alpha = 1.0;
                    open_clips += 1;
                }
                Op::Unlayer => {
                    if open_clips > 0 {
                        self.encoding.encode_end_clip();
                        open_clips -= 1;
                        if let Some(prev) = layer_stack.pop() {
                            active_alpha = prev;
                        }
                    }
                }
                Op::Children => {
                    for &kid in &node.children {
                        self.walk_node(kid, world, active_alpha);
                    }
                }
                // Effects/glass are out of scope for this zoom-transform spike (BENCH_NO_EFFECTS=1).
                Op::Read { .. }
                | Op::Glass(_)
                | Op::BackgroundBlur(_)
                | Op::ProgressiveBlur(_)
                | Op::DropShadow { .. }
                | Op::InnerShadow { .. } => {}
            }
        }

        for _ in 0..open_clips {
            self.encoding.encode_end_clip();
        }
        if pushed_iso {
            self.encoding.encode_end_clip();
        }
    }

    fn push_layer_rect(&mut self, world: Affine, rect: Rect, blend: BlendMode, alpha: f32) {
        self.encoding.encode_transform(Transform::from_kurbo(&world));
        self.encoding.encode_fill_style(Fill::NonZero);
        if !self.encoding.encode_shape(&rect, true) {
            self.encoding.encode_empty_shape();
        }
        self.encoding
            .encode_begin_clip(DrawBeginClip::new(blend, alpha.clamp(0.0, 1.0)));
    }

    fn resolve_entry_path(&self, r: &Record, idx: u32) -> Option<BezPath> {
        match r.paths.get(idx as usize)? {
            PathEntry::Outside(inner_idx) => {
                let inner = self.resolve_entry_path(r, *inner_idx)?;
                let b = inner.bounding_box().inflate(100_000.0, 100_000.0);
                let mut outer = geometry::rect_path(b);
                outer.extend(inner);
                Some(outer)
            }
            PathEntry::Glyphs { scale, glyphs } => {
                let s = f64::from(*scale);
                let mut out = BezPath::new();
                for g in glyphs {
                    if let Some(glyph) = self.store.glyphs.get(g.glyph) {
                        let place = Affine::new([s, 0.0, 0.0, -s, f64::from(g.x), f64::from(g.y)]);
                        let mut p = glyph.path.clone();
                        p.apply_affine(place);
                        out.extend(p);
                    }
                }
                Some(out)
            }
            // Use scale 4.0 so ellipses are smooth even when zoomed in up to 400%+.
            _ => r.entry_path(idx, Affine::scale(4.0)),
        }
    }

    fn encode_fill(&mut self, r: &Record, idx: u32, world: Affine, even_odd: bool, paint: &Paint, alpha: f32) {
        if let Some(PathEntry::Glyphs { scale, glyphs }) = r.paths.get(idx as usize) {
            self.encode_glyph_run(world, f64::from(*scale), glyphs, paint, alpha);
            return;
        }
        let Some(path) = self.resolve_entry_path(r, idx) else {
            return;
        };
        if path.is_empty() {
            return;
        }
        let Some((brush_opt, brush_transform)) = build_brush(paint, alpha) else {
            return;
        };
        self.encoding.encode_transform(Transform::from_kurbo(&world));
        self.encoding
            .encode_fill_style(if even_odd { Fill::EvenOdd } else { Fill::NonZero });
        if self.encoding.encode_shape(&path, true) {
            if let Some(bt) = brush_transform
                && self
                    .encoding
                    .encode_transform(Transform::from_kurbo(&(world * bt)))
            {
                self.encoding.swap_last_path_tags();
            }
            encode_resolved_brush(&mut self.encoding, &brush_opt);
        }
    }

    fn encode_glyph_run(
        &mut self,
        world: Affine,
        s: f64,
        glyphs: &[crate::record::GlyphInstance],
        paint: &Paint,
        alpha: f32,
    ) {
        if glyphs.is_empty() {
            return;
        }
        let Some((brush_opt, brush_transform)) = build_brush(paint, alpha) else {
            return;
        };

        // Populate pre-encoded glyph cache first so we can borrow self.glyph_cache immutably below.
        for g in glyphs {
            if !self.glyph_cache.contains_key(&g.glyph) {
                let mut tags = Vec::new();
                let mut data = Vec::new();
                let mut n_segments = 0u32;
                let mut dummy_paths = 0u32;
                if let Some(glyph) = self.store.glyphs.get(g.glyph) {
                    let mut pe = PathEncoder::new(&mut tags, &mut data, &mut n_segments, &mut dummy_paths, true);
                    pe.path_elements(glyph.path.elements().iter().copied());
                    pe.finish(false);
                }
                self.glyph_cache.insert(
                    g.glyph,
                    EncodedGlyph {
                        tags,
                        data,
                        n_segments,
                    },
                );
            }
        }

        // Encode all glyphs of the run into a single Vello Path (one draw object, per-glyph
        // PathTag::TRANSFORM), matching vello_encoding::Resolver's GlyphRun output.
        self.encoding.encode_fill_style(Fill::NonZero);
        let mut run_segments = 0u32;
        for g in glyphs {
            let Some(eg) = self.glyph_cache.get(&g.glyph) else {
                continue;
            };
            if eg.n_segments == 0 {
                continue;
            }
            let gm = world * Affine::new([s, 0.0, 0.0, -s, f64::from(g.x), f64::from(g.y)]);
            self.encoding.encode_transform(Transform::from_kurbo(&gm));
            self.encoding.path_tags.extend_from_slice(&eg.tags);
            self.encoding.path_data.extend_from_slice(&eg.data);
            self.encoding.n_path_segments += eg.n_segments;
            run_segments += eg.n_segments;
            self.glyphs_encoded += 1;
        }
        if run_segments == 0 {
            return;
        }
        // Paint transform sits immediately before PathTag::PATH so flatten.wgsl stores it on PathBbox.
        if let Some(bt) = brush_transform {
            self.encoding
                .encode_transform(Transform::from_kurbo(&(world * bt)));
        }
        self.encoding.path_tags.push(PathTag::PATH);
        self.encoding.n_paths += 1;
        encode_resolved_brush(&mut self.encoding, &brush_opt);
    }

    fn encode_stroke(
        &mut self,
        r: &Record,
        idx: u32,
        world: Affine,
        style: &StrokeStyle,
        paint: &Paint,
        alpha: f32,
    ) {
        let Some((brush_opt, brush_transform)) = build_brush(paint, alpha) else {
            return;
        };
        // Fast path matching exec.rs: uniform rounded/square rect border as an EvenOdd ring fill.
        if let Some(ring) = stroke_ring(r, idx, style) {
            self.encoding.encode_transform(Transform::from_kurbo(&world));
            self.encoding.encode_fill_style(Fill::EvenOdd);
            if self.encoding.encode_shape(&ring, true) {
                if let Some(bt) = brush_transform
                    && self
                        .encoding
                        .encode_transform(Transform::from_kurbo(&(world * bt)))
                {
                    self.encoding.swap_last_path_tags();
                }
                encode_resolved_brush(&mut self.encoding, &brush_opt);
            }
            return;
        }

        let Some(path) = self.resolve_entry_path(r, idx) else {
            return;
        };
        if path.is_empty() {
            return;
        }
        let mut ks = Stroke::new(f64::from(style.width))
            .with_join(match style.join {
                1 => Join::Round,
                2 => Join::Bevel,
                _ => Join::Miter,
            })
            .with_caps(match style.cap {
                1 => Cap::Round,
                2 => Cap::Square,
                _ => Cap::Butt,
            })
            .with_miter_limit(f64::from(style.miter.max(1.0)));
        if !style.dashes.is_empty() {
            ks = ks.with_dashes(
                f64::from(style.dash_offset),
                style.dashes.iter().map(|d| f64::from(*d)),
            );
        }

        self.encoding.encode_transform(Transform::from_kurbo(&world));
        if !self.encoding.encode_stroke_style(&ks) {
            return;
        }
        let encoded = if ks.dash_pattern.is_empty() {
            self.encoding.encode_shape(&path, false)
        } else {
            let dashed: Vec<PathEl> = vello_common::kurbo::dash(
                path.elements().iter().copied(),
                ks.dash_offset,
                &ks.dash_pattern,
            )
            .collect();
            self.encoding.encode_path_elements(dashed.into_iter(), false)
        };
        if encoded {
            if let Some(bt) = brush_transform
                && self
                    .encoding
                    .encode_transform(Transform::from_kurbo(&(world * bt)))
            {
                self.encoding.swap_last_path_tags();
            }
            encode_resolved_brush(&mut self.encoding, &brush_opt);
        }
    }
}

enum ResolvedBrush {
    Solid(Color),
    Gradient(Gradient),
}

fn build_brush(paint: &Paint, alpha: f32) -> Option<(ResolvedBrush, Option<Affine>)> {
    match paint {
        Paint::Solid(c) => {
            let a = (c[3] * alpha).clamp(0.0, 1.0);
            if a <= 0.0 {
                return None;
            }
            Some((ResolvedBrush::Solid(Color::new([c[0], c[1], c[2], a])), None))
        }
        Paint::Gradient(g) => {
            if g.matrix.determinant().abs() < 1e-12 || alpha <= 0.0 || g.stops.is_empty() {
                return None;
            }
            let mut grad = match g.kind {
                GradientKind::Linear => Gradient::new_linear((0.0, 0.0), (1.0, 0.0)),
                GradientKind::Radial => Gradient::new_radial((0.0, 0.0), 1.0),
                GradientKind::Angular => Gradient::new_sweep((0.0, 0.0), 0.0, core::f32::consts::TAU),
                // Diamond gradient falls back to radial in this spike (scale corpus has no diamonds).
                GradientKind::Diamond => Gradient::new_radial((0.0, 0.0), 1.0),
            };
            grad.extend = Extend::Pad;
            grad.interpolation_alpha_space = InterpolationAlphaSpace::Unpremultiplied;
            let stops: Vec<ColorStop> = g
                .stops
                .iter()
                .map(|&(t, c)| ColorStop::from((t, Color::new([c[0], c[1], c[2], (c[3] * alpha).clamp(0.0, 1.0)]))))
                .collect();
            grad.stops = ColorStops(stops.into_iter().collect());
            Some((ResolvedBrush::Gradient(grad), Some(g.matrix)))
        }
        Paint::Image(_) | Paint::Placeholder(_) => None,
    }
}

fn encode_resolved_brush(encoding: &mut Encoding, brush: &ResolvedBrush) {
    match brush {
        ResolvedBrush::Solid(c) => encoding.encode_brush(BrushRef::Solid(*c), 1.0),
        ResolvedBrush::Gradient(g) => encoding.encode_brush(BrushRef::Gradient(g), 1.0),
    }
}

fn node_clip_rect(store: &Store, r: &Record) -> Rect {
    let box_rect = Rect::new(0.0, 0.0, f64::from(r.size[0]), f64::from(r.size[1]));
    let b = r
        .content_bounds(&|g| store.glyphs.bounds(g))
        .map_or(box_rect, |cb| cb.union(box_rect));
    if b.width() <= 0.0 || b.height() <= 0.0 {
        Rect::new(-1e5, -1e5, 1e5, 1e5)
    } else {
        b.inflate(4.0, 4.0)
    }
}

fn map_mix(blend: u32) -> Mix {
    match blend {
        1 => Mix::Darken,
        2 => Mix::Multiply,
        3 => Mix::ColorBurn,
        4 => Mix::Lighten,
        5 => Mix::Screen,
        6 => Mix::ColorDodge,
        7 => Mix::Overlay,
        8 => Mix::SoftLight,
        9 => Mix::HardLight,
        10 => Mix::Difference,
        11 => Mix::Exclusion,
        12 => Mix::Hue,
        13 => Mix::Saturation,
        14 => Mix::Color,
        15 => Mix::Luminosity,
        _ => Mix::Normal,
    }
}

fn stroke_ring(r: &Record, i: u32, style: &StrokeStyle) -> Option<BezPath> {
    let Some(PathEntry::Rect { w, h, radii, smoothing }) = r.paths.get(i as usize) else {
        return None;
    };
    let (w, h) = (f64::from(*w), f64::from(*h));
    if *smoothing != 0.0 || !style.dashes.is_empty() || !(w > 0.0 && h > 0.0) {
        return None;
    }
    let half = f64::from(style.width) / 2.0;
    let fitted = geometry::fit_radii(w, h, radii.map(f64::from));
    let square = fitted.iter().all(|r| *r == 0.0);
    let outer_round = if fitted.iter().all(|r| *r >= half) {
        fitted.map(|r| r + half)
    } else if square && style.join == 0 && style.miter.max(1.0) >= core::f32::consts::SQRT_2 {
        [0.0; 4]
    } else if square && style.join == 1 {
        [half; 4]
    } else {
        return None;
    };
    let mut ring = geometry::rounded_rect_at((-half, -half), w + 2.0 * half, h + 2.0 * half, outer_round);
    if w > 2.0 * half && h > 2.0 * half {
        let inner = fitted.map(|r| (r - half).max(0.0));
        ring.extend(geometry::rounded_rect_at(
            (half, half),
            w - 2.0 * half,
            h - 2.0 * half,
            inner,
        ));
    }
    Some(ring)
}
