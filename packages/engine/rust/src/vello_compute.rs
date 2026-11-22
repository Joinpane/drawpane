//! Vello 0.12 GPU compute path for ordinary paint (decision 0040, Phase P0).
//!
//! Gated strictly on `#[cfg(feature = "gpu")]` (WebGPU Core browser build only; zero impact on
//! `worker` or `webgl` builds) and kept behind an opt-in runtime flag (`compute_ordinary = false`
//! by default).
//!
//! Architecture:
//! 1. On document revision change (cold encode), `ordinary::walk_ordinary` walks `Store` once in
//!    page coordinates into `VelloComputeSink`, producing a single `vello_encoding::Encoding` plus
//!    a 1:1 `TransformMeta` table marking glyph transforms eligible for 1/8 px snapping. All
//!    strokes arrive pre-expanded via `stroke::resolve_stroke_outline`. Camera-invariant prefix
//!    passes (`pathtag_reduce`, `pathtag_scan`, `draw_reduce`) run once on the GPU.
//! 2. On every zoom/pan frame (hot frame), uploads only 160 bytes of uniforms (`ViewParams` +
//!    `ConfigUniform`), runs `APPLY_VIEW_WGSL` (multiplying `view * base_transforms[i]` and
//!    applying the exact 1/8 px glyph snap when eligible), runs Vello's compute stages through
//!    `fine_area` (writing premultiplied RGBA8 directly into `gpu.frames[dst]`), optionally
//!    records the present blit into the same `CommandEncoder`, resolves hardware GPU timestamp
//!    queries when supported, and copies the 32-byte `BumpAllocators` + 256-byte timestamps into
//!    a pooled 288-byte `MAP_READ` buffer checked asynchronously on every single frame with zero
//!    main-thread stalls.

use crate::error::{EngineError, ErrorCode, Result};
use crate::exec::expand_gradient_stops;
use crate::gpu::{self, Health};
use crate::ordinary::{OrdinarySink, walk_ordinary};
use crate::record::{CompactPath, ComposeMode, GlyphInstance, GradientKind, Paint};
use crate::store::Store;
use bytemuck::{Pod, Zeroable};
use std::collections::{HashMap, VecDeque};
use std::mem::size_of;
use std::sync::Arc;
use vello_common::kurbo::{Affine, BezPath, Rect};
use vello_common::peniko::{
    BlendMode, BrushRef, Color, ColorStop, ColorStops, Compose, Extend, Fill, Gradient, InterpolationAlphaSpace, Mix,
};
use vello_encoding::{
    BufferSize, BufferSizes, BumpAllocators, ConfigUniform, DrawBeginClip, Encoding, Layout, LineSoup, PathEncoder,
    PathSegment, PathTag, Resolver, SegmentCount, Tile, Transform, WorkgroupCounts,
};
use vello_shaders::{BindType, ComputeShader, SHADERS};

const NUM_TS_PASSES: usize = 16;
const TS_QUERY_COUNT: u32 = (NUM_TS_PASSES * 2) as u32;
const BUMP_BYTES: u64 = size_of::<BumpAllocators>() as u64;
const TS_BYTES: u64 = (TS_QUERY_COUNT as u64) * 8;
const DIAG_BUF_BYTES: u64 = BUMP_BYTES + TS_BYTES; // 32 + 256 = 288 bytes
const MAX_DIAG_SAMPLES: usize = 4096;
const MAX_DIAG_IN_FLIGHT: usize = 512;

const PASS_NAMES: [&str; NUM_TS_PASSES] = [
    "apply_view",
    "bbox_clear",
    "flatten",
    "draw_leaf",
    "clip_reduce",
    "clip_leaf",
    "binning",
    "tile_alloc",
    "path_count_setup",
    "path_count",
    "backdrop",
    "coarse",
    "path_tiling_setup",
    "path_tiling",
    "fine_area",
    "present_blit",
];

const APPLY_VIEW_WGSL: &str = r#"
struct ViewParams {
    mat: vec4<f32>,
    trans: vec2<f32>,
    transform_base: u32,
    n_transforms: u32,
    glyph_mask_side: f32,
    _pad0: u32,
    _pad1: u32,
    _pad2: u32,
}

struct TransformMeta {
    glyph_w: f32,
    glyph_h: f32,
    flags: u32,
    _pad: u32,
}

@group(0) @binding(0) var<uniform> view: ViewParams;
@group(0) @binding(1) var<storage, read> base_transforms: array<u32>;
@group(0) @binding(2) var<storage, read_write> scene: array<u32>;
@group(0) @binding(3) var<storage, read> transform_meta: array<TransformMeta>;

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
    var t0 = view.mat.x * o4 + view.mat.z * o5 + view.trans.x;
    var t1 = view.mat.y * o4 + view.mat.w * o5 + view.trans.y;

    let tm = transform_meta[i];
    if (tm.flags & 1u) != 0u {
        let scale_sum = abs(m0) + abs(m3);
        let axis_aligned = abs(m1) <= 1e-6 * scale_sum && abs(m2) <= 1e-6 * scale_sum;
        let small = tm.glyph_w * abs(m0) <= view.glyph_mask_side
            && tm.glyph_h * abs(m3) <= view.glyph_mask_side;
        if axis_aligned && small && abs(t0) < 1e7 && abs(t1) < 1e7 {
            // Exact 1/8 px snap matching exec.rs (round half away from zero on non-negative frac).
            let ix = floor(t0);
            let iy = floor(t1);
            let px = floor((t0 - ix) * 8.0 + 0.5);
            let py = floor((t1 - iy) * 8.0 + 0.5);
            t0 = ix + px * 0.125;
            t1 = iy + py * 0.125;
        }
    }

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
    glyph_mask_side: f32,
    _pad: [u32; 3],
}

#[derive(Clone, Copy, Debug, PartialEq, Pod, Zeroable)]
#[repr(C)]
struct TransformMeta {
    glyph_w: f32,
    glyph_h: f32,
    flags: u32,
    _pad: u32,
}

impl TransformMeta {
    const NONE: Self = Self {
        glyph_w: 0.0,
        glyph_h: 0.0,
        flags: 0,
        _pad: 0,
    };

    fn glyph(w: f32, h: f32) -> Self {
        Self {
            glyph_w: w,
            glyph_h: h,
            flags: 1,
            _pad: 0,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct ComputeFrameStats {
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

#[derive(Clone, Debug, Default)]
struct DiagSummary {
    frames_submitted: u32,
    frames_checked: u32,
    failed_frames: u32,
    any_failed_mask: u32,
    last_bump: BumpAllocators,
    max_bump: BumpAllocators,
    gpu_ms: Vec<f64>,
    gpu_span_ms: Vec<f64>,
    pass_ms_sum: [f64; NUM_TS_PASSES],
    pass_counts: [u32; NUM_TS_PASSES],
}

impl DiagSummary {
    fn record_frame(&mut self, bump: BumpAllocators, ts_ns: Option<(&[u64; TS_QUERY_COUNT as usize], u16, f32)>) {
        self.frames_checked += 1;
        if bump.failed != 0 {
            self.failed_frames += 1;
            self.any_failed_mask |= bump.failed;
        }
        self.last_bump = bump;
        self.max_bump.failed |= bump.failed;
        self.max_bump.binning = self.max_bump.binning.max(bump.binning);
        self.max_bump.ptcl = self.max_bump.ptcl.max(bump.ptcl);
        self.max_bump.tile = self.max_bump.tile.max(bump.tile);
        self.max_bump.seg_counts = self.max_bump.seg_counts.max(bump.seg_counts);
        self.max_bump.segments = self.max_bump.segments.max(bump.segments);
        self.max_bump.blend = self.max_bump.blend.max(bump.blend);
        self.max_bump.lines = self.max_bump.lines.max(bump.lines);

        if let Some((raw, pass_mask, period_ns)) = ts_ns
            && period_ns > 0.0
            && period_ns.is_finite()
        {
            let ns_to_ms = f64::from(period_ns) * 1e-6;
            let mut sum_ms = 0.0;
            let mut min_begin = u64::MAX;
            let mut max_end = 0u64;
            let mut any_valid = false;
            for slot in 0..NUM_TS_PASSES {
                if (pass_mask & (1u16 << slot)) == 0 {
                    continue;
                }
                let t0 = raw[slot * 2];
                let t1 = raw[slot * 2 + 1];
                if t1 >= t0 && (t0 != 0 || t1 != 0) {
                    let dt = (t1 - t0) as f64 * ns_to_ms;
                    self.pass_ms_sum[slot] += dt;
                    self.pass_counts[slot] += 1;
                    sum_ms += dt;
                    min_begin = min_begin.min(t0);
                    max_end = max_end.max(t1);
                    any_valid = true;
                }
            }
            if any_valid && self.gpu_ms.len() < MAX_DIAG_SAMPLES {
                self.gpu_ms.push(sum_ms);
                let span = if max_end >= min_begin {
                    (max_end - min_begin) as f64 * ns_to_ms
                } else {
                    sum_ms
                };
                self.gpu_span_ms.push(span);
            }
        }
    }
}

pub struct PendingDiag {
    staging: wgpu::Buffer,
    rx: futures_channel::oneshot::Receiver<std::result::Result<(), wgpu::BufferAsyncError>>,
    pass_mask: u16,
    has_ts: bool,
    period_ns: f32,
}

pub struct StatsReadback {
    pending: Vec<PendingDiag>,
    summary: DiagSummary,
    timestamps_supported: bool,
    timestamp_period_ns: f32,
    scene_meta_json: String,
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
            let bty = match ty {
                BindType::Uniform => wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                BindType::BufReadOnly => wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Storage { read_only: true },
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                BindType::Buffer => wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Storage { read_only: false },
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                BindType::ImageRead => wgpu::BindingType::Texture {
                    sample_type: wgpu::TextureSampleType::Float { filterable: false },
                    view_dimension: wgpu::TextureViewDimension::D2,
                    multisampled: false,
                },
                BindType::Image => wgpu::BindingType::StorageTexture {
                    access: wgpu::StorageTextureAccess::WriteOnly,
                    format: wgpu::TextureFormat::Rgba8Unorm,
                    view_dimension: wgpu::TextureViewDimension::D2,
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
        let pl = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some(label),
            bind_group_layouts: &[Some(&layout)],
            immediate_size: 0,
        });
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some(label),
            source: wgpu::ShaderSource::Wgsl(shader.wgsl.code.as_ref().into()),
        });
        let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some(label),
            layout: Some(&pl),
            module: &module,
            entry_point: Some("main"),
            compilation_options: Default::default(),
            cache: None,
        });
        Self {
            pipeline,
            layout,
            binding_indices,
        }
    }

    fn bind_group(
        &self,
        device: &wgpu::Device,
        label: &str,
        resources: &[wgpu::BindingResource<'_>],
    ) -> wgpu::BindGroup {
        debug_assert_eq!(self.binding_indices.len(), resources.len());
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

struct ComputePipelines {
    apply_view: wgpu::ComputePipeline,
    apply_view_layout: wgpu::BindGroupLayout,
    pathtag_reduce: PipelineEntry,
    pathtag_reduce2: Option<PipelineEntry>,
    pathtag_scan1: Option<PipelineEntry>,
    pathtag_scan_small: PipelineEntry,
    pathtag_scan_large: Option<PipelineEntry>,
    bbox_clear: PipelineEntry,
    flatten: PipelineEntry,
    draw_reduce: PipelineEntry,
    draw_leaf: PipelineEntry,
    clip_reduce: Option<PipelineEntry>,
    clip_leaf: Option<PipelineEntry>,
    binning: PipelineEntry,
    tile_alloc: PipelineEntry,
    path_count_setup: PipelineEntry,
    path_count: PipelineEntry,
    backdrop: PipelineEntry,
    coarse: PipelineEntry,
    path_tiling_setup: PipelineEntry,
    path_tiling: PipelineEntry,
    fine_area: PipelineEntry,
}

impl ComputePipelines {
    fn ensure_large_scan(&mut self, device: &wgpu::Device) {
        let s = &SHADERS;
        if self.pathtag_reduce2.is_none() {
            self.pathtag_reduce2 = Some(PipelineEntry::from_vello(
                device,
                "compute.pathtag_reduce2",
                &s.pathtag_reduce2,
            ));
        }
        if self.pathtag_scan1.is_none() {
            self.pathtag_scan1 = Some(PipelineEntry::from_vello(
                device,
                "compute.pathtag_scan1",
                &s.pathtag_scan1,
            ));
        }
        if self.pathtag_scan_large.is_none() {
            self.pathtag_scan_large = Some(PipelineEntry::from_vello(
                device,
                "compute.pathtag_scan_large",
                &s.pathtag_scan_large,
            ));
        }
    }

    fn ensure_clip_reduce(&mut self, device: &wgpu::Device) {
        if self.clip_reduce.is_none() {
            self.clip_reduce = Some(PipelineEntry::from_vello(
                device,
                "compute.clip_reduce",
                &SHADERS.clip_reduce,
            ));
        }
    }

    fn ensure_clip_leaf(&mut self, device: &wgpu::Device) {
        if self.clip_leaf.is_none() {
            self.clip_leaf = Some(PipelineEntry::from_vello(
                device,
                "compute.clip_leaf",
                &SHADERS.clip_leaf,
            ));
        }
    }

    fn new(device: &wgpu::Device) -> Self {
        let apply_view_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("compute.apply_view"),
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
                wgpu::BindGroupLayoutEntry {
                    binding: 3,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Storage { read_only: true },
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
            ],
        });
        let apply_view_pl = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("compute.apply_view"),
            bind_group_layouts: &[Some(&apply_view_layout)],
            immediate_size: 0,
        });
        let apply_view_mod = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("compute.apply_view"),
            source: wgpu::ShaderSource::Wgsl(APPLY_VIEW_WGSL.into()),
        });
        let apply_view = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("compute.apply_view"),
            layout: Some(&apply_view_pl),
            module: &apply_view_mod,
            entry_point: Some("main"),
            compilation_options: Default::default(),
            cache: None,
        });

        let s = &SHADERS;
        Self {
            apply_view,
            apply_view_layout,
            pathtag_reduce: PipelineEntry::from_vello(device, "compute.pathtag_reduce", &s.pathtag_reduce),
            pathtag_reduce2: None,
            pathtag_scan1: None,
            pathtag_scan_small: PipelineEntry::from_vello(device, "compute.pathtag_scan_small", &s.pathtag_scan_small),
            pathtag_scan_large: None,
            bbox_clear: PipelineEntry::from_vello(device, "compute.bbox_clear", &s.bbox_clear),
            flatten: PipelineEntry::from_vello(device, "compute.flatten", &s.flatten),
            draw_reduce: PipelineEntry::from_vello(device, "compute.draw_reduce", &s.draw_reduce),
            draw_leaf: PipelineEntry::from_vello(device, "compute.draw_leaf", &s.draw_leaf),
            clip_reduce: None,
            clip_leaf: None,
            binning: PipelineEntry::from_vello(device, "compute.binning", &s.binning),
            tile_alloc: PipelineEntry::from_vello(device, "compute.tile_alloc", &s.tile_alloc),
            path_count_setup: PipelineEntry::from_vello(device, "compute.path_count_setup", &s.path_count_setup),
            path_count: PipelineEntry::from_vello(device, "compute.path_count", &s.path_count),
            backdrop: PipelineEntry::from_vello(device, "compute.backdrop", &s.backdrop_dyn),
            coarse: PipelineEntry::from_vello(device, "compute.coarse", &s.coarse),
            path_tiling_setup: PipelineEntry::from_vello(device, "compute.path_tiling_setup", &s.path_tiling_setup),
            path_tiling: PipelineEntry::from_vello(device, "compute.path_tiling", &s.path_tiling),
            fine_area: PipelineEntry::from_vello(device, "compute.fine_area", &s.fine_area),
        }
    }
}

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
    scene_buf: wgpu::Buffer,
    base_transforms_buf: wgpu::Buffer,
    transform_meta_buf: wgpu::Buffer,
    tagmonoid_buf: wgpu::Buffer,
    draw_reduced_buf: wgpu::Buffer,
    gradient_tex: wgpu::Texture,
    gradient_view: wgpu::TextureView,
    image_atlas_tex: wgpu::Texture,
    image_atlas_view: wgpu::TextureView,
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
    bg_apply_view: wgpu::BindGroup,
    bg_bbox_clear: wgpu::BindGroup,
    bg_flatten: wgpu::BindGroup,
    bg_draw_leaf: wgpu::BindGroup,
    bg_clip_reduce: Option<wgpu::BindGroup>,
    bg_clip_leaf: Option<wgpu::BindGroup>,
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
        self.transform_meta_buf.destroy();
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

struct ViewportResources {
    width: u32,
    height: u32,
    scene_revision: u32,
    scene_generation: u64,
    bin_header_buf: wgpu::Buffer,
    bin_header_bytes: u64,
    wg_counts: WorkgroupCounts,
    bg_binning: wgpu::BindGroup,
    bg_coarse: wgpu::BindGroup,
    /// Cached `fine_area` bind group per `gpu.frames[dst]` slot (`FRAMES = 2`), keyed by target view
    /// pointer/generation (rebuilt when frame texture resizes or scene rebuilds).
    bg_fine_slots: [Option<(u64, wgpu::BindGroup)>; 2],
}

impl ViewportResources {
    fn destroy(&self) {
        self.bin_header_buf.destroy();
    }
}

pub struct VelloCompute {
    pipelines: ComputePipelines,
    retained: Option<RetainedScene>,
    viewport: Option<ViewportResources>,
    resolver: Resolver,
    ts_query_set: Option<wgpu::QuerySet>,
    ts_resolve_buf: Option<wgpu::Buffer>,
    timestamp_period_ns: f32,
    diag_pool: Vec<wgpu::Buffer>,
    pending_diag: VecDeque<PendingDiag>,
    diag_summary: DiagSummary,
}

impl Drop for VelloCompute {
    fn drop(&mut self) {
        self.reset();
        if let Some(b) = self.ts_resolve_buf.take() {
            b.destroy();
        }
        for b in self.diag_pool.drain(..) {
            b.destroy();
        }
        for p in self.pending_diag.drain(..) {
            p.staging.destroy();
        }
    }
}

impl VelloCompute {
    pub fn new(device: &wgpu::Device, queue: &wgpu::Queue, timestamp_query: bool) -> Self {
        let (ts_query_set, ts_resolve_buf, timestamp_period_ns) = if timestamp_query {
            let qs = device.create_query_set(&wgpu::QuerySetDescriptor {
                label: Some("compute.timestamps"),
                ty: wgpu::QueryType::Timestamp,
                count: TS_QUERY_COUNT,
            });
            let buf = device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("compute.ts_resolve"),
                size: TS_BYTES,
                usage: wgpu::BufferUsages::QUERY_RESOLVE | wgpu::BufferUsages::COPY_SRC,
                mapped_at_creation: false,
            });
            (Some(qs), Some(buf), queue.get_timestamp_period())
        } else {
            (None, None, 0.0)
        };
        Self {
            pipelines: ComputePipelines::new(device),
            retained: None,
            viewport: None,
            resolver: Resolver::new(),
            ts_query_set,
            ts_resolve_buf,
            timestamp_period_ns,
            diag_pool: Vec::new(),
            pending_diag: VecDeque::new(),
            diag_summary: DiagSummary::default(),
        }
    }

    pub fn gpu_bytes(&self) -> usize {
        let ret = self.retained.as_ref().map_or(0, |r| r.total_gpu_bytes as usize);
        let vp = self.viewport.as_ref().map_or(0, |v| v.bin_header_bytes as usize);
        ret + vp
    }

    pub fn reset(&mut self) {
        if let Some(vp) = self.viewport.take() {
            vp.destroy();
        }
        if let Some(ret) = self.retained.take() {
            ret.destroy();
        }
    }

    pub fn reset_stats(&mut self) {
        self.drain_ready_diag();
        for p in self.pending_diag.drain(..) {
            p.staging.destroy();
        }
        self.diag_summary = DiagSummary::default();
    }

    fn drain_ready_diag(&mut self) {
        while let Some(front) = self.pending_diag.front_mut() {
            match front.rx.try_recv() {
                Ok(Some(Ok(()))) => {
                    let item = self.pending_diag.pop_front().expect("front");
                    if let Ok(mapped) = item.staging.slice(..).get_mapped_range() {
                        let bump: BumpAllocators = *bytemuck::from_bytes(&mapped[..BUMP_BYTES as usize]);
                        let ts_parsed = if item.has_ts {
                            let mut ts = [0u64; TS_QUERY_COUNT as usize];
                            for (i, chunk) in mapped[BUMP_BYTES as usize..DIAG_BUF_BYTES as usize]
                                .as_chunks::<8>()
                                .0
                                .iter()
                                .enumerate()
                            {
                                ts[i] = u64::from_le_bytes(*chunk);
                            }
                            Some((ts, item.pass_mask, item.period_ns))
                        } else {
                            None
                        };
                        drop(mapped);
                        item.staging.unmap();
                        self.diag_summary
                            .record_frame(bump, ts_parsed.as_ref().map(|(t, m, p)| (t, *m, *p)));
                        if self.diag_pool.len() < MAX_DIAG_IN_FLIGHT {
                            self.diag_pool.push(item.staging);
                        } else {
                            item.staging.destroy();
                        }
                    } else {
                        item.staging.destroy();
                    }
                }
                Ok(Some(Err(_))) | Err(_) => {
                    let item = self.pending_diag.pop_front().expect("front");
                    item.staging.destroy();
                }
                Ok(None) => break,
            }
        }
    }

    fn acquire_diag_buffer(pool: &mut Vec<wgpu::Buffer>, device: &wgpu::Device) -> wgpu::Buffer {
        if let Some(buf) = pool.pop() {
            return buf;
        }
        device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("compute.diag_readback"),
            size: DIAG_BUF_BYTES,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        })
    }

    /// Renders the retained ordinary-paint scene directly into `dst_view` (`gpu.frames[dst]`) and
    /// optionally encodes the canvas present blit in the same command buffer (single submit).
    #[allow(clippy::too_many_arguments)]
    pub fn render_into(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        store: &Store,
        generation: u64,
        width: u32,
        height: u32,
        view: Affine,
        background: [f32; 4],
        dst_slot: usize,
        dst_view_id: u64,
        dst_view: &wgpu::TextureView,
        present: Option<(&wgpu::RenderPipeline, &wgpu::BindGroup, &wgpu::TextureView)>,
    ) -> Result<ComputeFrameStats> {
        let t_total = gpu::now();
        self.drain_ready_diag();
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
        let vp = self.viewport.as_mut().expect("viewport resources");
        let slot = dst_slot % 2;
        if vp.bg_fine_slots[slot].as_ref().is_none_or(|(id, _)| *id != dst_view_id) {
            let bg = self.pipelines.fine_area.bind_group(
                device,
                "compute.bg_fine_area",
                &[
                    ret.config_buf.as_entire_binding(),
                    ret.segments_buf.as_entire_binding(),
                    ret.ptcl_buf.as_entire_binding(),
                    ret.info_bin_data_buf.as_entire_binding(),
                    ret.blend_spill_buf.as_entire_binding(),
                    wgpu::BindingResource::TextureView(dst_view),
                    wgpu::BindingResource::TextureView(&ret.gradient_view),
                    wgpu::BindingResource::TextureView(&ret.image_atlas_view),
                ],
            );
            vp.bg_fine_slots[slot] = Some((dst_view_id, bg));
        }
        let render_ms = gpu::now() - t_setup;

        let t_sub = gpu::now();
        let ret = self.retained.as_ref().expect("retained scene");
        let vp = self.viewport.as_ref().expect("viewport resources");
        let bg_fine = &vp.bg_fine_slots[slot].as_ref().expect("fine bind group").1;

        if ret.layout.n_paths == 0 {
            let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("compute.clear_empty"),
            });
            let bg_p = [
                f64::from(background[0] * background[3]),
                f64::from(background[1] * background[3]),
                f64::from(background[2] * background[3]),
                f64::from(background[3]),
            ];
            {
                let _rpass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: Some("compute.clear"),
                    color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                        view: dst_view,
                        depth_slice: None,
                        resolve_target: None,
                        ops: wgpu::Operations {
                            load: wgpu::LoadOp::Clear(wgpu::Color {
                                r: bg_p[0],
                                g: bg_p[1],
                                b: bg_p[2],
                                a: bg_p[3],
                            }),
                            store: wgpu::StoreOp::Store,
                        },
                    })],
                    ..Default::default()
                });
            }
            if let Some((blit_pipe, blit_bg, surface_view)) = present {
                let mut rpass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: Some("compute.present"),
                    color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                        view: surface_view,
                        depth_slice: None,
                        resolve_target: None,
                        ops: wgpu::Operations {
                            load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                            store: wgpu::StoreOp::Store,
                        },
                    })],
                    ..Default::default()
                });
                rpass.set_pipeline(blit_pipe);
                rpass.set_bind_group(0, blit_bg, &[]);
                rpass.draw(0..3, 0..1);
            }
            queue.submit([encoder.finish()]);
            let submit_ms = gpu::now() - t_sub;
            self.diag_summary.frames_submitted += 1;
            self.diag_summary.frames_checked += 1;
            return Ok(ComputeFrameStats {
                encode_ms,
                render_ms,
                submit_ms,
                cpu_ms: gpu::now() - t_total,
                n_paths: 0,
                glyphs: 0,
            });
        }

        let bg_color = Color::new([background[0], background[1], background[2], background[3]]);
        let mut cfg = make_config_uniform(&ret.layout, width, height, &bg_color, ret.caps);
        cfg.target_width = width;
        cfg.target_height = height;

        let c = view.as_coeffs();
        let view_params = ViewParams {
            mat: [c[0] as f32, c[1] as f32, c[2] as f32, c[3] as f32],
            trans: [c[4] as f32, c[5] as f32],
            transform_base: ret.layout.transform_base,
            n_transforms: ret.n_transforms,
            glyph_mask_side: store.limits.glyph_mask_side as f32,
            _pad: [0; 3],
        };

        queue.write_buffer(&ret.view_buf, 0, bytemuck::bytes_of(&view_params));
        queue.write_buffer(&ret.config_buf, 0, bytemuck::bytes_of(&cfg));

        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("compute.vello"),
        });
        encoder.clear_buffer(&ret.bump_buf, 0, None);

        let ts_qs = self.ts_query_set.as_ref();
        let mut pass_mask = 0u16;

        let wg = &vp.wg_counts;

        if ret.n_transforms > 0 {
            pass_mask |= 1u16 << 0;
            let mut cpass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("compute.apply_view"),
                timestamp_writes: ts_qs.map(|qs| wgpu::ComputePassTimestampWrites {
                    query_set: qs,
                    beginning_of_pass_write_index: Some(0),
                    end_of_pass_write_index: Some(1),
                }),
            });
            cpass.set_pipeline(&self.pipelines.apply_view);
            cpass.set_bind_group(0, &ret.bg_apply_view, &[]);
            cpass.dispatch_workgroups(ret.n_transforms.div_ceil(256), 1, 1);
        }

        macro_rules! dispatch {
            ($slot:expr, $label:expr, $pipe:expr, $bg:expr, $size:expr) => {{
                let (x, y, z) = $size;
                if x > 0 && y > 0 && z > 0 {
                    pass_mask |= 1u16 << $slot;
                    let mut cpass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                        label: Some($label),
                        timestamp_writes: ts_qs.map(|qs| wgpu::ComputePassTimestampWrites {
                            query_set: qs,
                            beginning_of_pass_write_index: Some(($slot * 2) as u32),
                            end_of_pass_write_index: Some(($slot * 2 + 1) as u32),
                        }),
                    });
                    cpass.set_pipeline(&$pipe.pipeline);
                    cpass.set_bind_group(0, $bg, &[]);
                    cpass.dispatch_workgroups(x, y, z);
                }
            }};
        }

        macro_rules! dispatch_indirect {
            ($slot:expr, $label:expr, $pipe:expr, $bg:expr) => {{
                pass_mask |= 1u16 << $slot;
                let mut cpass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                    label: Some($label),
                    timestamp_writes: ts_qs.map(|qs| wgpu::ComputePassTimestampWrites {
                        query_set: qs,
                        beginning_of_pass_write_index: Some(($slot * 2) as u32),
                        end_of_pass_write_index: Some(($slot * 2 + 1) as u32),
                    }),
                });
                cpass.set_pipeline(&$pipe.pipeline);
                cpass.set_bind_group(0, $bg, &[]);
                cpass.dispatch_workgroups_indirect(&ret.indirect_count_buf, 0);
            }};
        }

        dispatch!(
            1,
            "compute.bbox_clear",
            self.pipelines.bbox_clear,
            &ret.bg_bbox_clear,
            wg.bbox_clear
        );
        dispatch!(
            2,
            "compute.flatten",
            self.pipelines.flatten,
            &ret.bg_flatten,
            wg.flatten
        );
        dispatch!(
            3,
            "compute.draw_leaf",
            self.pipelines.draw_leaf,
            &ret.bg_draw_leaf,
            wg.draw_leaf
        );
        if wg.clip_reduce.0 > 0
            && let (Some(pipe), Some(bg)) = (self.pipelines.clip_reduce.as_ref(), ret.bg_clip_reduce.as_ref())
        {
            dispatch!(4, "compute.clip_reduce", pipe, bg, wg.clip_reduce);
        }
        if wg.clip_leaf.0 > 0
            && let (Some(pipe), Some(bg)) = (self.pipelines.clip_leaf.as_ref(), ret.bg_clip_leaf.as_ref())
        {
            dispatch!(5, "compute.clip_leaf", pipe, bg, wg.clip_leaf);
        }
        dispatch!(6, "compute.binning", self.pipelines.binning, &vp.bg_binning, wg.binning);
        dispatch!(
            7,
            "compute.tile_alloc",
            self.pipelines.tile_alloc,
            &ret.bg_tile_alloc,
            wg.tile_alloc
        );
        dispatch!(
            8,
            "compute.path_count_setup",
            self.pipelines.path_count_setup,
            &ret.bg_path_count_setup,
            wg.path_count_setup
        );
        dispatch_indirect!(9, "compute.path_count", self.pipelines.path_count, &ret.bg_path_count);
        dispatch!(
            10,
            "compute.backdrop",
            self.pipelines.backdrop,
            &ret.bg_backdrop,
            wg.backdrop
        );
        dispatch!(11, "compute.coarse", self.pipelines.coarse, &vp.bg_coarse, wg.coarse);
        dispatch!(
            12,
            "compute.path_tiling_setup",
            self.pipelines.path_tiling_setup,
            &ret.bg_path_tiling_setup,
            wg.path_tiling_setup
        );
        dispatch_indirect!(
            13,
            "compute.path_tiling",
            self.pipelines.path_tiling,
            &ret.bg_path_tiling
        );
        dispatch!(14, "compute.fine_area", self.pipelines.fine_area, bg_fine, wg.fine);

        if let Some((blit_pipe, blit_bg, surface_view)) = present {
            pass_mask |= 1u16 << 15;
            let mut rpass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("compute.present"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: surface_view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                timestamp_writes: ts_qs.map(|qs| wgpu::RenderPassTimestampWrites {
                    query_set: qs,
                    beginning_of_pass_write_index: Some(30),
                    end_of_pass_write_index: Some(31),
                }),
                ..Default::default()
            });
            rpass.set_pipeline(blit_pipe);
            rpass.set_bind_group(0, blit_bg, &[]);
            rpass.draw(0..3, 0..1);
        }

        let has_ts = if let (Some(qs), Some(ts_buf)) = (ts_qs, self.ts_resolve_buf.as_ref()) {
            encoder.resolve_query_set(qs, 0..TS_QUERY_COUNT, ts_buf, 0);
            true
        } else {
            false
        };

        // Copy bump counters + resolved timestamps into a tiny 288-byte staging buffer on EVERY
        // frame so bump.failed and GPU timestamps are verified on every frame without stalling.
        let n_paths = ret.layout.n_paths;
        let n_glyphs = ret.n_glyphs;
        let bump_buf_ref = &ret.bump_buf;
        let record_diag = self.pending_diag.len() < MAX_DIAG_IN_FLIGHT;
        let diag_staging = if record_diag {
            let staging = Self::acquire_diag_buffer(&mut self.diag_pool, device);
            encoder.copy_buffer_to_buffer(bump_buf_ref, 0, &staging, 0, BUMP_BYTES);
            if has_ts && let Some(ts_buf) = self.ts_resolve_buf.as_ref() {
                encoder.copy_buffer_to_buffer(ts_buf, 0, &staging, BUMP_BYTES, TS_BYTES);
            }
            Some(staging)
        } else {
            None
        };

        queue.submit([encoder.finish()]);
        self.diag_summary.frames_submitted += 1;

        if let Some(staging) = diag_staging {
            let (tx, rx) = futures_channel::oneshot::channel();
            staging.slice(..).map_async(wgpu::MapMode::Read, move |r| {
                let _ = tx.send(r);
            });
            self.pending_diag.push_back(PendingDiag {
                staging,
                rx,
                pass_mask,
                has_ts,
                period_ns: self.timestamp_period_ns,
            });
        }

        let submit_ms = gpu::now() - t_sub;
        Ok(ComputeFrameStats {
            encode_ms,
            render_ms,
            submit_ms,
            cpu_ms: gpu::now() - t_total,
            n_paths,
            glyphs: n_glyphs,
        })
    }

    /// Drains ready per-frame diagnostics and hands any still-in-flight frames to an async finish
    /// call (`finish_stats_readback`) so every submitted frame is checked before reporting stats.
    pub fn start_stats_readback(&mut self) -> Result<StatsReadback> {
        self.drain_ready_diag();
        let pending: Vec<PendingDiag> = self.pending_diag.drain(..).collect();
        let summary = self.diag_summary.clone();
        let scene_meta_json = if let Some(ret) = self.retained.as_ref() {
            format!(
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
            )
        } else {
            "\"capacities\":null,\"scene\":null".to_string()
        };
        Ok(StatsReadback {
            pending,
            summary,
            timestamps_supported: self.ts_query_set.is_some(),
            timestamp_period_ns: self.timestamp_period_ns,
            scene_meta_json,
        })
    }

    fn build_retained(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        store: &Store,
        generation: u64,
    ) -> Result<RetainedScene> {
        let t0 = gpu::now();
        let mut sink = VelloComputeSink::new(store);
        walk_ordinary(store, &mut sink)?;
        let cold_encode_ms = gpu::now() - t0;

        let t1 = gpu::now();
        let n_path_segments = sink.encoding.n_path_segments;
        let n_glyphs = sink.glyphs_encoded;
        let mut packed = Vec::new();
        let (layout, ramps, images) = self.resolver.resolve(&sink.encoding, &mut packed);
        let cold_resolve_ms = gpu::now() - t1;

        let t2 = gpu::now();
        let packed_bytes = packed.len();
        if packed.is_empty() {
            packed.resize(4, 0);
        }

        let transform_bytes: &[u8] = if layout.n_paths > 0 {
            let start = layout.transform_base as usize * 4;
            let end = layout.style_base as usize * 4;
            &packed[start..end]
        } else {
            &[]
        };
        let n_transforms = (transform_bytes.len() / size_of::<Transform>()) as u32;
        if sink.transform_meta.len() < n_transforms as usize {
            sink.transform_meta.resize(n_transforms as usize, TransformMeta::NONE);
        } else {
            sink.transform_meta.truncate(n_transforms as usize);
        }

        let limits = device.limits();
        let max_bind = limits.max_storage_buffer_binding_size.min(limits.max_buffer_size);
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
            "compute.scene",
            packed.len() as u64,
            wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
        );
        queue.write_buffer(&scene_buf, 0, &packed);

        let base_transforms_buf = make_buf(
            "compute.base_transforms",
            (transform_bytes.len() as u64).max(24),
            wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
        );
        if !transform_bytes.is_empty() {
            queue.write_buffer(&base_transforms_buf, 0, transform_bytes);
        }

        let meta_bytes: &[u8] = bytemuck::cast_slice(&sink.transform_meta);
        let transform_meta_buf = make_buf(
            "compute.transform_meta",
            (meta_bytes.len() as u64).max(size_of::<TransformMeta>() as u64),
            wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
        );
        if !meta_bytes.is_empty() {
            queue.write_buffer(&transform_meta_buf, 0, meta_bytes);
        }

        let (gw, gh) = if ramps.height == 0 {
            (1, 1)
        } else {
            (ramps.width, ramps.height)
        };
        let gradient_tex = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("compute.gradients"),
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

        let (aw, ah) = (images.width.max(1), images.height.max(1));
        let image_atlas_tex = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("compute.image_atlas"),
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
        let image_atlas_view = image_atlas_tex.create_view(&Default::default());

        let wgc = WorkgroupCounts::new(&layout, 1, 1, layout.path_tags_size());
        let bs = BufferSizes::new(&layout, &wgc);

        let view_buf = make_buf(
            "compute.view",
            size_of::<ViewParams>() as u64,
            wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        );
        let config_buf = make_buf(
            "compute.config",
            size_of::<ConfigUniform>() as u64,
            wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        );
        let tagmonoid_buf = make_buf(
            "compute.tagmonoid",
            u64::from(bs.path_monoids.size_in_bytes()),
            wgpu::BufferUsages::STORAGE,
        );
        let draw_reduced_buf = make_buf(
            "compute.draw_reduced",
            u64::from(bs.draw_reduced.size_in_bytes()),
            wgpu::BufferUsages::STORAGE,
        );
        let bump_buf = make_buf(
            "compute.bump",
            u64::from(bs.bump_alloc.size_in_bytes()),
            wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::COPY_SRC,
        );
        let indirect_count_buf = make_buf(
            "compute.indirect",
            u64::from(bs.indirect_count.size_in_bytes()),
            wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::INDIRECT,
        );
        let path_bbox_buf = make_buf(
            "compute.path_bbox",
            u64::from(bs.path_bboxes.size_in_bytes()),
            wgpu::BufferUsages::STORAGE,
        );
        let draw_monoid_buf = make_buf(
            "compute.draw_monoid",
            u64::from(bs.draw_monoids.size_in_bytes()),
            wgpu::BufferUsages::STORAGE,
        );
        let clip_inp_buf = make_buf(
            "compute.clip_inp",
            u64::from(bs.clip_inps.size_in_bytes()),
            wgpu::BufferUsages::STORAGE,
        );
        let clip_el_buf = make_buf(
            "compute.clip_el",
            u64::from(bs.clip_els.size_in_bytes()),
            wgpu::BufferUsages::STORAGE,
        );
        let clip_bic_buf = make_buf(
            "compute.clip_bic",
            u64::from(bs.clip_bics.size_in_bytes()),
            wgpu::BufferUsages::STORAGE,
        );
        let clip_bbox_buf = make_buf(
            "compute.clip_bbox",
            u64::from(bs.clip_bboxes.size_in_bytes()),
            wgpu::BufferUsages::STORAGE,
        );
        let draw_bbox_buf = make_buf(
            "compute.draw_bbox",
            u64::from(bs.draw_bboxes.size_in_bytes()),
            wgpu::BufferUsages::STORAGE,
        );
        let path_buf = make_buf(
            "compute.paths",
            u64::from(bs.paths.size_in_bytes()),
            wgpu::BufferUsages::STORAGE,
        );

        let info_bin_words = u64::from(layout.bin_data_start) + u64::from(caps.binning);
        let info_bin_data_buf = make_buf("compute.info_bin_data", info_bin_words * 4, wgpu::BufferUsages::STORAGE);
        let tile_buf = make_buf(
            "compute.tiles",
            u64::from(caps.tile) * size_of::<Tile>() as u64,
            wgpu::BufferUsages::STORAGE,
        );
        let lines_buf = make_buf(
            "compute.lines",
            u64::from(caps.lines) * size_of::<LineSoup>() as u64,
            wgpu::BufferUsages::STORAGE,
        );
        let seg_counts_buf = make_buf(
            "compute.seg_counts",
            u64::from(caps.seg_counts) * size_of::<SegmentCount>() as u64,
            wgpu::BufferUsages::STORAGE,
        );
        let segments_buf = make_buf(
            "compute.segments",
            u64::from(caps.segments) * size_of::<PathSegment>() as u64,
            wgpu::BufferUsages::STORAGE,
        );
        let ptcl_buf = make_buf("compute.ptcl", u64::from(caps.ptcl) * 4, wgpu::BufferUsages::STORAGE);
        let blend_spill_buf = make_buf(
            "compute.blend_spill",
            u64::from(caps.blend) * 4,
            wgpu::BufferUsages::STORAGE,
        );
        drop(make_buf);
        total_gpu_bytes += u64::from(gw) * u64::from(gh) * 4 + u64::from(aw) * u64::from(ah) * 4;

        // Precompute camera-invariant prefix sums once per revision.
        if layout.n_paths > 0 {
            let init_cfg = make_config_uniform(&layout, 16, 16, &Color::TRANSPARENT, caps);
            queue.write_buffer(&config_buf, 0, bytemuck::bytes_of(&init_cfg));

            let reduced_buf = device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("compute.reduced_tmp"),
                size: u64::from(bs.path_reduced.size_in_bytes()).max(4),
                usage: wgpu::BufferUsages::STORAGE,
                mapped_at_creation: false,
            });
            let mut cmd = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("compute.precompute_monoids"),
            });
            let bg_pr = self.pipelines.pathtag_reduce.bind_group(
                device,
                "compute.bg_pathtag_reduce",
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
                self.pipelines.ensure_large_scan(device);
                let p_pr2 = self.pipelines.pathtag_reduce2.as_ref().expect("pathtag_reduce2");
                let p_ps1 = self.pipelines.pathtag_scan1.as_ref().expect("pathtag_scan1");
                let p_psl = self.pipelines.pathtag_scan_large.as_ref().expect("pathtag_scan_large");
                let reduced2_buf = device.create_buffer(&wgpu::BufferDescriptor {
                    label: Some("compute.reduced2_tmp"),
                    size: u64::from(bs.path_reduced2.size_in_bytes()).max(4),
                    usage: wgpu::BufferUsages::STORAGE,
                    mapped_at_creation: false,
                });
                let reduced_scan_buf = device.create_buffer(&wgpu::BufferDescriptor {
                    label: Some("compute.reduced_scan_tmp"),
                    size: u64::from(bs.path_reduced_scan.size_in_bytes()).max(4),
                    usage: wgpu::BufferUsages::STORAGE,
                    mapped_at_creation: false,
                });
                let bg_pr2 = p_pr2.bind_group(
                    device,
                    "compute.bg_pathtag_reduce2",
                    &[reduced_buf.as_entire_binding(), reduced2_buf.as_entire_binding()],
                );
                {
                    let mut cpass = cmd.begin_compute_pass(&wgpu::ComputePassDescriptor::default());
                    cpass.set_pipeline(&p_pr2.pipeline);
                    cpass.set_bind_group(0, &bg_pr2, &[]);
                    cpass.dispatch_workgroups(wgc.path_reduce2.0, 1, 1);
                }
                let bg_ps1 = p_ps1.bind_group(
                    device,
                    "compute.bg_pathtag_scan1",
                    &[
                        reduced_buf.as_entire_binding(),
                        reduced2_buf.as_entire_binding(),
                        reduced_scan_buf.as_entire_binding(),
                    ],
                );
                {
                    let mut cpass = cmd.begin_compute_pass(&wgpu::ComputePassDescriptor::default());
                    cpass.set_pipeline(&p_ps1.pipeline);
                    cpass.set_bind_group(0, &bg_ps1, &[]);
                    cpass.dispatch_workgroups(wgc.path_scan1.0, 1, 1);
                }
                let bg_ps = p_psl.bind_group(
                    device,
                    "compute.bg_pathtag_scan_large",
                    &[
                        config_buf.as_entire_binding(),
                        scene_buf.as_entire_binding(),
                        reduced_scan_buf.as_entire_binding(),
                        tagmonoid_buf.as_entire_binding(),
                    ],
                );
                {
                    let mut cpass = cmd.begin_compute_pass(&wgpu::ComputePassDescriptor::default());
                    cpass.set_pipeline(&p_psl.pipeline);
                    cpass.set_bind_group(0, &bg_ps, &[]);
                    cpass.dispatch_workgroups(wgc.path_scan.0, 1, 1);
                }
                large_tmps = Some((reduced2_buf, reduced_scan_buf));
            } else {
                let bg_ps = self.pipelines.pathtag_scan_small.bind_group(
                    device,
                    "compute.bg_pathtag_scan_small",
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
                    "compute.bg_draw_reduce",
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

        if wgc.clip_reduce.0 > 0 {
            self.pipelines.ensure_clip_reduce(device);
        }
        if wgc.clip_leaf.0 > 0 {
            self.pipelines.ensure_clip_leaf(device);
        }
        let p = &self.pipelines;
        let bg_apply_view = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("compute.bg_apply_view"),
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
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: transform_meta_buf.as_entire_binding(),
                },
            ],
        });
        let bg_bbox_clear = p.bbox_clear.bind_group(
            device,
            "compute.bg_bbox_clear",
            &[config_buf.as_entire_binding(), path_bbox_buf.as_entire_binding()],
        );
        let bg_flatten = p.flatten.bind_group(
            device,
            "compute.bg_flatten",
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
            "compute.bg_draw_leaf",
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
        let bg_clip_reduce = if wgc.clip_reduce.0 > 0 {
            Some(p.clip_reduce.as_ref().expect("clip_reduce").bind_group(
                device,
                "compute.bg_clip_reduce",
                &[
                    clip_inp_buf.as_entire_binding(),
                    path_bbox_buf.as_entire_binding(),
                    clip_bic_buf.as_entire_binding(),
                    clip_el_buf.as_entire_binding(),
                ],
            ))
        } else {
            None
        };
        let bg_clip_leaf = if wgc.clip_leaf.0 > 0 {
            Some(p.clip_leaf.as_ref().expect("clip_leaf").bind_group(
                device,
                "compute.bg_clip_leaf",
                &[
                    config_buf.as_entire_binding(),
                    clip_inp_buf.as_entire_binding(),
                    path_bbox_buf.as_entire_binding(),
                    clip_bic_buf.as_entire_binding(),
                    clip_el_buf.as_entire_binding(),
                    draw_monoid_buf.as_entire_binding(),
                    clip_bbox_buf.as_entire_binding(),
                ],
            ))
        } else {
            None
        };
        let bg_tile_alloc = p.tile_alloc.bind_group(
            device,
            "compute.bg_tile_alloc",
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
            "compute.bg_path_count_setup",
            &[bump_buf.as_entire_binding(), indirect_count_buf.as_entire_binding()],
        );
        let bg_path_count = p.path_count.bind_group(
            device,
            "compute.bg_path_count",
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
            "compute.bg_backdrop",
            &[
                config_buf.as_entire_binding(),
                bump_buf.as_entire_binding(),
                path_buf.as_entire_binding(),
                tile_buf.as_entire_binding(),
            ],
        );
        let bg_path_tiling_setup = p.path_tiling_setup.bind_group(
            device,
            "compute.bg_path_tiling_setup",
            &[
                bump_buf.as_entire_binding(),
                indirect_count_buf.as_entire_binding(),
                ptcl_buf.as_entire_binding(),
            ],
        );
        let bg_path_tiling = p.path_tiling.bind_group(
            device,
            "compute.bg_path_tiling",
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
            transform_meta_buf,
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
    mut readback: StatsReadback,
) -> Result<String> {
    if let Some(err) = health.stop_error() {
        for p in readback.pending {
            p.staging.destroy();
        }
        return Err(err);
    }
    for item in readback.pending {
        match gpu::pump(&device, &health, item.rx, 12_000).await {
            Ok(Ok(())) => {
                if let Ok(mapped) = item.staging.slice(..).get_mapped_range() {
                    let bump: BumpAllocators = *bytemuck::from_bytes(&mapped[..BUMP_BYTES as usize]);
                    let ts_parsed = if item.has_ts {
                        let mut ts = [0u64; TS_QUERY_COUNT as usize];
                        for (i, chunk) in mapped[BUMP_BYTES as usize..DIAG_BUF_BYTES as usize]
                            .as_chunks::<8>()
                            .0
                            .iter()
                            .enumerate()
                        {
                            ts[i] = u64::from_le_bytes(*chunk);
                        }
                        Some((ts, item.pass_mask, item.period_ns))
                    } else {
                        None
                    };
                    drop(mapped);
                    item.staging.unmap();
                    readback
                        .summary
                        .record_frame(bump, ts_parsed.as_ref().map(|(t, m, p)| (t, *m, *p)));
                }
                item.staging.destroy();
            }
            Ok(Err(e)) => {
                item.staging.destroy();
                return Err(EngineError::new(ErrorCode::Gpu, e.to_string()));
            }
            Err(e) => {
                item.staging.destroy();
                return Err(e);
            }
        }
    }

    let s = &readback.summary;
    let fmt_bump = |b: &BumpAllocators| {
        format!(
            "{{\"failed\":{},\"binning\":{},\"ptcl\":{},\"tile\":{},\"seg_counts\":{},\"segments\":{},\"blend\":{},\"lines\":{}}}",
            b.failed, b.binning, b.ptcl, b.tile, b.seg_counts, b.segments, b.blend, b.lines
        )
    };
    let gpu_ms_json: String = s.gpu_ms.iter().map(|v| format!("{v:.4}")).collect::<Vec<_>>().join(",");
    let gpu_span_json: String = s
        .gpu_span_ms
        .iter()
        .map(|v| format!("{v:.4}"))
        .collect::<Vec<_>>()
        .join(",");
    let pass_avg_json: String = PASS_NAMES
        .iter()
        .enumerate()
        .map(|(i, name)| {
            let avg = if s.pass_counts[i] > 0 {
                s.pass_ms_sum[i] / f64::from(s.pass_counts[i])
            } else {
                0.0
            };
            format!("\"{name}\":{avg:.4}")
        })
        .collect::<Vec<_>>()
        .join(",");

    Ok(format!(
        "{{\"framesSubmitted\":{},\"framesChecked\":{},\"failedFrames\":{},\"anyFailedMask\":{},\"bump\":{},\"maxBump\":{},\"timestampsSupported\":{},\"timestampPeriodNs\":{:.3},\"gpuMs\":[{}],\"gpuSpanMs\":[{}],\"passAvgMs\":{{{}}},{}}}",
        s.frames_submitted,
        s.frames_checked,
        s.failed_frames,
        s.any_failed_mask,
        fmt_bump(&s.last_bump),
        fmt_bump(&s.max_bump),
        readback.timestamps_supported,
        readback.timestamp_period_ns,
        gpu_ms_json,
        gpu_span_json,
        pass_avg_json,
        readback.scene_meta_json,
    ))
}

fn compute_bump_caps(layout: &Layout, n_path_segments: u32, max_bind: u64) -> BumpCaps {
    // Respect WebGPU Core's 128 MiB default storage-binding floor and keep the dynamic working set
    // well inside the engine's desktop GPU budget while preserving generous headroom for 10k-40k
    // pages (verified on every frame via per-frame bump.failed readback).
    let cap_bytes = max_bind.min(128 << 20);
    let max_lines = (cap_bytes / size_of::<LineSoup>() as u64) as u32;
    let max_segments = (cap_bytes / size_of::<PathSegment>() as u64) as u32;
    let max_tiles = (cap_bytes / size_of::<Tile>() as u64) as u32;
    let max_seg_counts = (cap_bytes / size_of::<SegmentCount>() as u64) as u32;
    let max_u32s = (cap_bytes / 4) as u32;

    let binning_max = max_u32s.saturating_sub(layout.bin_data_start).max(1 << 16);
    let binning = (layout.n_draw_objects.saturating_mul(32))
        .clamp(1 << 15, 2 << 20)
        .min(binning_max);
    let lines = (n_path_segments.saturating_mul(4))
        .clamp(1 << 16, 3 << 20)
        .min(max_lines);
    let tile = (layout.n_paths.saturating_mul(128))
        .clamp(1 << 16, 3 << 20)
        .min(max_tiles);
    let seg_counts = (n_path_segments.saturating_mul(3))
        .clamp(1 << 16, 2_500_000)
        .min(max_seg_counts);
    let segments = (n_path_segments.saturating_mul(3))
        .clamp(1 << 16, 2_500_000)
        .min(max_segments);
    let ptcl = (layout.n_paths.saturating_mul(256))
        .clamp(1 << 18, 6 << 20)
        .min(max_u32s);
    let blend = (layout.n_clips.saturating_mul(1024))
        .clamp(1 << 16, 2 << 20)
        .min(max_u32s);

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

fn make_config_uniform(layout: &Layout, width: u32, height: u32, base_color: &Color, caps: BumpCaps) -> ConfigUniform {
    let width_in_tiles = width.div_ceil(16);
    let height_in_tiles = height.div_ceil(16);
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
    p: &ComputePipelines,
    ret: &RetainedScene,
    width: u32,
    height: u32,
) -> Result<ViewportResources> {
    let width_in_tiles = width.div_ceil(16);
    let height_in_tiles = height.div_ceil(16);
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
            "Vello compute supports at most 256 bins (4096x4096); {width}x{height} needs {n_bins}"
        )));
    }
    let bin_header_size =
        u64::from(BufferSize::<vello_encoding::BinHeader>::new(bs.bin_headers.len()).size_in_bytes()).max(8);
    let bin_header_buf = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("compute.bin_headers"),
        size: bin_header_size,
        usage: wgpu::BufferUsages::STORAGE,
        mapped_at_creation: false,
    });

    let bg_binning = p.binning.bind_group(
        device,
        "compute.bg_binning",
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
        "compute.bg_coarse",
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

    Ok(ViewportResources {
        width,
        height,
        scene_revision: ret.revision,
        scene_generation: ret.generation,
        bin_header_buf,
        bin_header_bytes: bin_header_size,
        wg_counts: wg,
        bg_binning,
        bg_coarse,
        bg_fine_slots: [None, None],
    })
}

struct EncodedGlyph {
    tags: Vec<PathTag>,
    data: Vec<u32>,
    n_segments: u32,
    bounds: Option<Rect>,
}

/// Vello 0.12 encoder driven by `ordinary::walk_ordinary`.
struct VelloComputeSink<'a> {
    store: &'a Store,
    encoding: Encoding,
    transform_meta: Vec<TransformMeta>,
    last_meta: Option<TransformMeta>,
    glyph_cache: HashMap<u32, EncodedGlyph>,
    glyphs_encoded: u32,
}

impl<'a> VelloComputeSink<'a> {
    fn new(store: &'a Store) -> Self {
        Self {
            store,
            encoding: Encoding::new(),
            transform_meta: Vec::new(),
            last_meta: None,
            glyph_cache: HashMap::new(),
            glyphs_encoded: 0,
        }
    }

    /// Encodes a transform with matching `TransformMeta`, forcing a new transform entry whenever
    /// `meta` differs so `encoding.transforms` and `self.transform_meta` stay strictly 1:1.
    fn encode_transform_with_meta(&mut self, t: Transform, meta: TransformMeta) -> bool {
        if self.last_meta != Some(meta) {
            self.encoding.flags |= Encoding::FORCE_NEXT_TRANSFORM;
        }
        let pushed = self.encoding.encode_transform(t);
        if pushed {
            self.transform_meta.push(meta);
            self.last_meta = Some(meta);
        }
        pushed
    }

    fn encode_compact_path(&mut self, path: &CompactPath) -> bool {
        let mut pe = self.encoding.encode_path(true);
        let mut c = path.coords().as_chunks::<2>().0.iter();
        for &v in path.verbs() {
            match v {
                0 => {
                    if let Some(&[x, y]) = c.next() {
                        pe.move_to(x, y);
                    }
                }
                1 => {
                    if let Some(&[x, y]) = c.next() {
                        pe.line_to(x, y);
                    }
                }
                2 => {
                    if let (Some(&[x1, y1]), Some(&[x2, y2])) = (c.next(), c.next()) {
                        pe.quad_to(x1, y1, x2, y2);
                    }
                }
                3 => {
                    if let (Some(&[x1, y1]), Some(&[x2, y2]), Some(&[x3, y3])) = (c.next(), c.next(), c.next()) {
                        pe.cubic_to(x1, y1, x2, y2, x3, y3);
                    }
                }
                _ => pe.close(),
            }
        }
        pe.finish(true) != 0
    }

    fn finish_fill_brush(&mut self, world: Affine, brush: &ResolvedBrush, brush_transform: Option<Affine>) {
        if let Some(bt) = brush_transform
            && self.encode_transform_with_meta(Transform::from_kurbo(&(world * bt)), TransformMeta::NONE)
        {
            self.encoding.swap_last_path_tags();
        }
        encode_resolved_brush(&mut self.encoding, brush);
    }
}

impl OrdinarySink for VelloComputeSink<'_> {
    fn push_layer(&mut self, world: Affine, bounds: Rect, blend: u32, compose: ComposeMode, opacity: f32) {
        let vello_compose = match compose {
            ComposeMode::SrcOver => Compose::SrcOver,
            ComposeMode::DestOut => Compose::DestOut,
            ComposeMode::DestIn => Compose::DestIn,
        };
        let blend_mode = BlendMode::new(map_mix(blend), vello_compose);
        self.encode_transform_with_meta(Transform::from_kurbo(&world), TransformMeta::NONE);
        self.encoding.encode_fill_style(Fill::NonZero);
        if !self.encoding.encode_shape(&bounds, true) {
            self.encoding.encode_empty_shape();
        }
        self.encoding
            .encode_begin_clip(DrawBeginClip::new(blend_mode, opacity.clamp(0.0, 1.0)));
    }

    fn pop_layer(&mut self) {
        self.encoding.encode_end_clip();
    }

    fn push_clip(&mut self, world: Affine, path: &BezPath, even_odd: bool) {
        self.encode_transform_with_meta(Transform::from_kurbo(&world), TransformMeta::NONE);
        self.encoding
            .encode_fill_style(if even_odd { Fill::EvenOdd } else { Fill::NonZero });
        if path.is_empty() || !self.encoding.encode_shape(path, true) {
            self.encoding.encode_empty_shape();
        }
        self.encoding.encode_begin_clip(DrawBeginClip::clip());
    }

    fn pop_clip(&mut self) {
        self.encoding.encode_end_clip();
    }

    fn fill_path(&mut self, world: Affine, path: &BezPath, even_odd: bool, paint: &Paint, alpha: f32) {
        let Some((brush, brush_transform)) = build_brush(paint, alpha) else {
            return;
        };
        self.encode_transform_with_meta(Transform::from_kurbo(&world), TransformMeta::NONE);
        self.encoding
            .encode_fill_style(if even_odd { Fill::EvenOdd } else { Fill::NonZero });
        if self.encoding.encode_shape(path, true) {
            self.finish_fill_brush(world, &brush, brush_transform);
        }
    }

    fn fill_compact(&mut self, world: Affine, path: &CompactPath, even_odd: bool, paint: &Paint, alpha: f32) {
        let Some((brush, brush_transform)) = build_brush(paint, alpha) else {
            return;
        };
        self.encode_transform_with_meta(Transform::from_kurbo(&world), TransformMeta::NONE);
        self.encoding
            .encode_fill_style(if even_odd { Fill::EvenOdd } else { Fill::NonZero });
        if self.encode_compact_path(path) {
            self.finish_fill_brush(world, &brush, brush_transform);
        }
    }

    fn fill_glyphs(
        &mut self,
        world: Affine,
        scale: f64,
        glyphs: &[GlyphInstance],
        paint: &Paint,
        even_odd: bool,
        alpha: f32,
        allow_snap: bool,
    ) -> Result<()> {
        if glyphs.is_empty() {
            return Ok(());
        }
        let Some((brush, brush_transform)) = build_brush(paint, alpha) else {
            return Ok(());
        };

        for g in glyphs {
            if !self.glyph_cache.contains_key(&g.glyph) {
                let glyph = self
                    .store
                    .glyphs
                    .get(g.glyph)
                    .ok_or_else(|| EngineError::unknown(format!("glyph {}", g.glyph)))?;
                let mut tags = Vec::new();
                let mut data = Vec::new();
                let mut n_segments = 0u32;
                let mut dummy_paths = 0u32;
                let mut pe = PathEncoder::new(&mut tags, &mut data, &mut n_segments, &mut dummy_paths, true);
                pe.path_elements(glyph.path.elements().iter().copied());
                pe.finish(false);
                self.glyph_cache.insert(
                    g.glyph,
                    EncodedGlyph {
                        tags,
                        data,
                        n_segments,
                        bounds: glyph.bounds,
                    },
                );
            }
        }

        // Encode all glyphs of the run into ONE Vello path (single draw object, per-glyph
        // PathTag::TRANSFORM). Each glyph carries its own TransformMeta so `APPLY_VIEW_WGSL`
        // applies the exact 1/8 px snap iff `allow_snap` holds and the glyph is axis-aligned and
        // <= `glyph_mask_side` in device pixels.
        self.encoding
            .encode_fill_style(if even_odd { Fill::EvenOdd } else { Fill::NonZero });
        let mut run_segments = 0u32;
        for g in glyphs {
            let Some((n_segments, bounds)) = self.glyph_cache.get(&g.glyph).map(|eg| (eg.n_segments, eg.bounds)) else {
                continue;
            };
            if n_segments == 0 {
                continue;
            }
            let gm = world * Affine::new([scale, 0.0, 0.0, -scale, f64::from(g.x), f64::from(g.y)]);
            let meta = if allow_snap && let Some(gb) = bounds {
                TransformMeta::glyph(gb.width() as f32, gb.height() as f32)
            } else {
                TransformMeta::NONE
            };
            self.encode_transform_with_meta(Transform::from_kurbo(&gm), meta);
            let eg = &self.glyph_cache[&g.glyph];
            self.encoding.path_tags.extend_from_slice(&eg.tags);
            self.encoding.path_data.extend_from_slice(&eg.data);
            self.encoding.n_path_segments += n_segments;
            run_segments += n_segments;
            self.glyphs_encoded += 1;
        }
        if run_segments == 0 {
            return Ok(());
        }
        // Paint transform sits right before PathTag::PATH so flatten.wgsl stores it on PathBbox.
        if let Some(bt) = brush_transform {
            self.encode_transform_with_meta(Transform::from_kurbo(&(world * bt)), TransformMeta::NONE);
        }
        self.encoding.path_tags.push(PathTag::PATH);
        self.encoding.n_paths += 1;
        encode_resolved_brush(&mut self.encoding, &brush);
        Ok(())
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
                GradientKind::Diamond => return None,
            };
            grad.extend = Extend::Pad;
            grad.interpolation_alpha_space = InterpolationAlphaSpace::Unpremultiplied;
            let expanded = expand_gradient_stops(&g.stops, alpha);
            let stops: Vec<ColorStop> = expanded
                .into_iter()
                .map(|(t, c)| ColorStop::from((t, Color::new([c[0], c[1], c[2], c[3]]))))
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

fn map_mix(blend: u32) -> Mix {
    match blend {
        1 => Mix::Multiply,
        2 => Mix::Screen,
        3 => Mix::Overlay,
        4 => Mix::Darken,
        5 => Mix::Lighten,
        6 => Mix::ColorDodge,
        7 => Mix::ColorBurn,
        8 => Mix::HardLight,
        9 => Mix::SoftLight,
        10 => Mix::Difference,
        11 => Mix::Exclusion,
        12 => Mix::Hue,
        13 => Mix::Saturation,
        14 => Mix::Color,
        15 => Mix::Luminosity,
        _ => Mix::Normal,
    }
}
