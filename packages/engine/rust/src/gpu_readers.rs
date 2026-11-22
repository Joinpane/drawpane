//! GPU backdrop-reader pipelines, texture pools, and pass encoders (`readers.wgsl`).
//!
//! Pure fragment pipelines with 256-byte-aligned dynamic uniform slabs so every pass for a glass
//! layer (copy-extended, mipmaps, mask downsample, separable height blur, frost + mips, final
//! refraction + premultiplied replace) records into a single `CommandEncoder`.

use crate::error::{EngineError, Result};
use crate::exec::IRect;
use crate::glass::{self, ClipWithin, DEFAULT_GLASS_TUNING, GlassParams, GlassRegion};
use crate::progressive_blur::ProgressivePlan;
use vello_gpu::{RenderSize, Renderer};

const SHADER: &str = include_str!(concat!(env!("OUT_DIR"), "/readers.wgsl"));
const RGBA8: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;
const SLAB_SLOTS: u32 = 256;
const MIP_POOL_CAP: usize = 6;
const COARSE_MAX_MIPS: u32 = 5;

/// Picks the best supported rim-height texture format on `adapter`: `Rgba16Float` when both
/// renderable and filterable, otherwise `Rgba8Unorm` (with `[0, 1]`-packed gradients).
pub fn preferred_height_format(adapter: &wgpu::Adapter) -> wgpu::TextureFormat {
    let features = adapter.get_texture_format_features(wgpu::TextureFormat::Rgba16Float);
    let need = wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING;
    if features.allowed_usages.contains(need) && features.flags.contains(wgpu::TextureFormatFeatureFlags::FILTERABLE) {
        wgpu::TextureFormat::Rgba16Float
    } else {
        wgpu::TextureFormat::Rgba8Unorm
    }
}

/// Optional analytic shape coverage parameters for `fs_glass_coarse` (skipping vello_gpu mask passes).
#[derive(Clone, Copy, Debug)]
pub struct CoarseAnalytic {
    /// 1 = rounded/smoothed box, 2 = ellipse
    pub mode: u8,
    pub to_box: [f32; 6],
    pub size: [f32; 2],
    pub radii: [f32; 4],
    pub smoothing: [f32; 4],
    pub unit_px: f32,
}

/// Crop-sized prefiltered source returned by `encode_halo_clip_border` and `encode_halo_clip_clamp`.
pub struct PrefilteredSource {
    pub view: wgpu::TextureView,
    pub size: (u32, u32),
    pub crop_origin: (i32, i32),
}

/// A single-level Rgba8 or Rgba16F pooled texture.
pub struct PlainTex {
    pub texture: wgpu::Texture,
    pub view: wgpu::TextureView,
    pub width: u32,
    pub height: u32,
    pub bpp: usize,
}

impl PlainTex {
    pub fn bytes(&self) -> usize {
        self.width as usize * self.height as usize * self.bpp
    }
}

/// A Vello render target texture (Rgba8 + depth view) used for rasterizing shape/clip masks.
pub struct VelloTex {
    pub texture: wgpu::Texture,
    pub view: wgpu::TextureView,
    pub depth: wgpu::TextureView,
    pub width: u32,
    pub height: u32,
}

impl VelloTex {
    pub fn bytes(&self) -> usize {
        // RGBA8 + 32-bit depth attachment.
        self.width as usize * self.height as usize * 8
    }
}

/// A full mipmapped Rgba8 texture with per-level views for 2x2 box downsampling.
struct MipTex {
    texture: wgpu::Texture,
    pub full_view: wgpu::TextureView,
    pub mip_views: Vec<wgpu::TextureView>,
    downsample_groups: Vec<wgpu::BindGroup>,
    pub width: u32,
    pub height: u32,
    pub bytes: usize,
    pub used: u64,
}

impl MipTex {
    fn estimate_bytes(width: u32, height: u32, max_mips: u32) -> usize {
        let w = width.max(1);
        let h = height.max(1);
        let mips = glass::mip_count(w, h).min(max_mips.max(1));
        let mut bytes = 0usize;
        let (mut mw, mut mh) = (w, h);
        for _ in 0..mips {
            bytes += mw as usize * mh as usize * 4;
            mw = (mw / 2).max(1);
            mh = (mh / 2).max(1);
        }
        bytes
    }

    fn new(
        device: &wgpu::Device,
        mip_layout: &wgpu::BindGroupLayout,
        width: u32,
        height: u32,
        max_mips: u32,
        label: &str,
        used: u64,
    ) -> Self {
        let w = width.max(1);
        let h = height.max(1);
        let mips = glass::mip_count(w, h).min(max_mips.max(1));
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some(label),
            size: wgpu::Extent3d {
                width: w,
                height: h,
                depth_or_array_layers: 1,
            },
            mip_level_count: mips,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: RGBA8,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT
                | wgpu::TextureUsages::TEXTURE_BINDING
                | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        let full_view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        let mut mip_views = Vec::with_capacity(mips as usize);
        let mut bytes = 0usize;
        let (mut mw, mut mh) = (w, h);
        for level in 0..mips {
            mip_views.push(texture.create_view(&wgpu::TextureViewDescriptor {
                base_mip_level: level,
                mip_level_count: Some(1),
                ..Default::default()
            }));
            bytes += mw as usize * mh as usize * 4;
            mw = (mw / 2).max(1);
            mh = (mh / 2).max(1);
        }
        let downsample_groups = mip_views[..(mips - 1) as usize]
            .iter()
            .map(|view| {
                device.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: Some("reader mip source"),
                    layout: mip_layout,
                    entries: &[wgpu::BindGroupEntry {
                        binding: 0,
                        resource: wgpu::BindingResource::TextureView(view),
                    }],
                })
            })
            .collect();
        Self {
            texture,
            full_view,
            mip_views,
            downsample_groups,
            width: w,
            height: h,
            bytes,
            used,
        }
    }
}

#[derive(Clone, Copy)]
pub struct NativeRim {
    pub area: IRect,
    pub offset: (f32, f32),
    pub params: GlassParams,
}

pub struct BlurHaloSample {
    pub view: wgpu::TextureView,
    pub size: (u32, u32),
    pub inv: f32,
    pub offset: (f32, f32),
}

pub struct ProgressiveHaloSample {
    pub sample: BlurHaloSample,
    pub cell_size: (u32, u32),
    pub first: usize,
    pub cols: u32,
}

/// One device-aligned edge strip captured for fractional `EdgeMode::Clamp` halo prefiltering.
pub struct HaloClampEdge<'a> {
    pub view: &'a wgpu::TextureView,
    /// Straddling source texel index (`tx_L`, `tx_R`, `ty_T`, or `ty_B`).
    pub straddle: i32,
    /// Number of clamped outside strip pixels in the straddling texel (`k >= 0`).
    pub clamp_weight: f32,
    /// Strip dimensions `(width, height)` in strip pixels.
    pub size: (u32, u32),
    /// Strip pixels per coarse source texel (`d_render / d_strip`).
    pub samples_per_texel: u32,
    /// Strip coordinate offset so `coord(texel, r) = texel * samples_per_texel + r + offset`.
    pub axis_offset: f32,
}

pub struct HaloClampEdges<'a> {
    pub left: Option<HaloClampEdge<'a>>,
    pub right: Option<HaloClampEdge<'a>>,
    pub top: Option<HaloClampEdge<'a>>,
    pub bottom: Option<HaloClampEdge<'a>>,
}

pub struct GlassResolve<'a> {
    pub divisor: f32,
    pub rim: Option<NativeRim>,
    pub optical_origin: (f32, f32),
    pub native: Option<&'a wgpu::TextureView>,
    pub native_origin: (f32, f32),
    pub native_size: (u32, u32),
    pub native_clip: Option<ClipWithin>,
    pub source_origin: (i32, i32),
}

#[derive(Clone, Copy)]
pub enum CompositeTarget<'a> {
    Over(&'a wgpu::TextureView),
    /// Both planes receive the same premultiplied source over their own alpha.
    OverBoth(&'a wgpu::TextureView, &'a wgpu::TextureView),
    Lerp(&'a wgpu::TextureView),
}

pub use crate::glass::{GLASS_MASK_ATLAS_MAX_BYTES, GLASS_MASK_ATLAS_SIDE};

pub struct GpuReaders {
    // Bind group layouts
    copy_ext_bgl: wgpu::BindGroupLayout,
    mip_bgl: wgpu::BindGroupLayout,
    down_bgl: wgpu::BindGroupLayout,
    blur_bgl: wgpu::BindGroupLayout,
    frost_bgl: wgpu::BindGroupLayout,
    glass_bgl: wgpu::BindGroupLayout,
    coarse_bgl: wgpu::BindGroupLayout,
    comp_bgl: wgpu::BindGroupLayout,
    bg_blur_bgl: wgpu::BindGroupLayout,
    prog_blur_bgl: wgpu::BindGroupLayout,
    halo_clip_clamp_bgl: wgpu::BindGroupLayout,

    // Pipelines
    copy_ext_pipe: wgpu::RenderPipeline,
    mip_pipe: wgpu::RenderPipeline,
    coarse_down_pipe: wgpu::RenderPipeline,
    down_pipe: wgpu::RenderPipeline,
    blur_x_pipe: wgpu::RenderPipeline,
    blur_y_pipe: wgpu::RenderPipeline,
    frost_pipe: wgpu::RenderPipeline,
    glass_pipe: wgpu::RenderPipeline,
    coarse_pipe: wgpu::RenderPipeline,
    comp_pipe: wgpu::RenderPipeline,
    comp_dual_pipe: wgpu::RenderPipeline,
    lerp_pipe: wgpu::RenderPipeline,
    bg_blur_pipe: wgpu::RenderPipeline,
    prog_blur_pipe: wgpu::RenderPipeline,
    halo_clip_border_pipe: wgpu::RenderPipeline,
    halo_clip_clamp_pipe: wgpu::RenderPipeline,
    downsample_rect_pipe: wgpu::RenderPipeline,

    // Height field format (Rgba16Float or packed Rgba8Unorm fallback)
    pub height_format: wgpu::TextureFormat,
    height_bpp: usize,
    height_packed: bool,

    // Samplers & fallback textures
    lin_samp: wgpu::Sampler,
    mip_lin_samp: wgpu::Sampler,
    white_1x1: PlainTex,

    // Dynamic uniform slabs
    uniform_align: u32,
    slabs: Vec<wgpu::Buffer>,
    slab_idx: usize,
    slab_slot: u32,
    uniform_start: u32,
    uniform_bytes: Vec<u8>,

    // Tile/frame-sized reader textures
    pub backdrop_frame: Option<PlainTex>,
    pub delta_frame: Option<PlainTex>,

    // Shared full-frame coarse backdrop mipmap keyed by (backdrop_gen, width, height)
    shared_coarse_mips: Option<MipTex>,
    shared_coarse_key: Option<(u64, u32, u32)>,

    // Scratch / pooled textures for glass passes
    mip_pool: Vec<MipTex>,
    pool_tick: u64,
    frosted_tmp: Option<PlainTex>,
    low_0: Option<PlainTex>,
    low_1: Option<PlainTex>,
    pub mask_tex: Option<VelloTex>,
    pub glass_mask_atlas: Option<VelloTex>,
    pub clip_tex: Option<VelloTex>,
    pub blur_out: Option<PlainTex>,
    pub blur_source: Option<PlainTex>,
    pub(crate) halo_border_src: Option<PlainTex>,
    dst_copy: Option<PlainTex>,
    /// Replaced or evicted textures still referenced by an unsubmitted encoder, destroyed on
    /// `flush_retired()` after `queue.submit` so WebGPU VRAM does not wait for JS GC.
    retired: Vec<wgpu::Texture>,
}

fn tex_binding(binding: u32, filterable: bool) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        binding,
        visibility: wgpu::ShaderStages::FRAGMENT,
        ty: wgpu::BindingType::Texture {
            sample_type: wgpu::TextureSampleType::Float { filterable },
            view_dimension: wgpu::TextureViewDimension::D2,
            multisampled: false,
        },
        count: None,
    }
}

fn samp_binding(binding: u32) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        binding,
        visibility: wgpu::ShaderStages::FRAGMENT,
        ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
        count: None,
    }
}

fn uni_binding(binding: u32, min_size: u64) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        binding,
        visibility: wgpu::ShaderStages::FRAGMENT,
        ty: wgpu::BindingType::Buffer {
            ty: wgpu::BufferBindingType::Uniform,
            has_dynamic_offset: true,
            min_binding_size: wgpu::BufferSize::new(min_size),
        },
        count: None,
    }
}

fn make_pipeline(
    device: &wgpu::Device,
    bgl: &wgpu::BindGroupLayout,
    module: &wgpu::ShaderModule,
    entry: &str,
    format: wgpu::TextureFormat,
    blend: Option<wgpu::BlendState>,
    label: &str,
) -> wgpu::RenderPipeline {
    make_pipeline_targets(device, bgl, module, entry, &[color_target(format, blend)], label)
}

fn color_target(format: wgpu::TextureFormat, blend: Option<wgpu::BlendState>) -> Option<wgpu::ColorTargetState> {
    Some(wgpu::ColorTargetState {
        format,
        blend,
        write_mask: wgpu::ColorWrites::ALL,
    })
}

fn make_pipeline_targets(
    device: &wgpu::Device,
    bgl: &wgpu::BindGroupLayout,
    module: &wgpu::ShaderModule,
    entry: &str,
    targets: &[Option<wgpu::ColorTargetState>],
    label: &str,
) -> wgpu::RenderPipeline {
    let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some(label),
        bind_group_layouts: &[Some(bgl)],
        immediate_size: 0,
    });
    device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some(label),
        layout: Some(&layout),
        vertex: wgpu::VertexState {
            module,
            entry_point: Some("vs_fullscreen"),
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
            targets,
        }),
        multiview_mask: None,
        cache: None,
    })
}

fn make_plain(
    device: &wgpu::Device,
    w: u32,
    h: u32,
    format: wgpu::TextureFormat,
    bpp: usize,
    usage: wgpu::TextureUsages,
    label: &str,
) -> PlainTex {
    let width = w.max(1);
    let height = h.max(1);
    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some(label),
        size: wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format,
        usage,
        view_formats: &[],
    });
    let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
    PlainTex {
        texture,
        view,
        width,
        height,
        bpp,
    }
}

impl GpuReaders {
    pub fn new(adapter: &wgpu::Adapter, device: &wgpu::Device, queue: &wgpu::Queue) -> Self {
        Self::with_height_format(device, queue, preferred_height_format(adapter))
    }

    pub fn with_height_format(device: &wgpu::Device, queue: &wgpu::Queue, height_format: wgpu::TextureFormat) -> Self {
        let height_packed = height_format == RGBA8;
        let height_bpp = if height_packed { 4 } else { 8 };
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("backdrop readers"),
            source: wgpu::ShaderSource::Wgsl(SHADER.into()),
        });

        let copy_ext_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("copy_ext bgl"),
            entries: &[tex_binding(0, false), uni_binding(1, 64)],
        });
        let mip_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("mip_down bgl"),
            entries: &[tex_binding(0, false)],
        });
        let down_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("down bgl"),
            entries: &[tex_binding(0, false), uni_binding(1, 16)],
        });
        let blur_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("blur bgl"),
            entries: &[tex_binding(0, false), uni_binding(1, 32)],
        });
        let frost_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("frost bgl"),
            entries: &[tex_binding(0, false), uni_binding(1, 32)],
        });
        let glass_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("glass bgl"),
            entries: &[
                tex_binding(0, true),
                samp_binding(1),
                tex_binding(2, false),
                tex_binding(3, true),
                tex_binding(4, false),
                tex_binding(5, false),
                samp_binding(6),
                uni_binding(7, 256),
                tex_binding(8, true),
            ],
        });
        let coarse_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("glass_coarse bgl"),
            entries: &[
                tex_binding(0, true),
                samp_binding(1),
                tex_binding(2, false),
                tex_binding(3, false),
                tex_binding(4, false),
                uni_binding(5, 128),
            ],
        });
        let comp_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("composite bgl"),
            entries: &[tex_binding(0, false), uni_binding(1, 16)],
        });
        let bg_blur_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("bg_blur_comp bgl"),
            entries: &[
                tex_binding(0, false),
                tex_binding(1, false),
                tex_binding(2, false),
                tex_binding(3, false),
                uni_binding(4, 48),
            ],
        });
        let prog_blur_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("prog_blur bgl"),
            entries: &[
                tex_binding(0, false),
                tex_binding(1, false),
                tex_binding(2, false),
                tex_binding(3, false),
                uni_binding(4, 192),
                tex_binding(5, false),
                tex_binding(6, false),
            ],
        });
        let halo_clip_clamp_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("halo_clip_clamp bgl"),
            entries: &[
                tex_binding(0, false),
                tex_binding(1, false),
                tex_binding(2, false),
                tex_binding(3, false),
                tex_binding(4, false),
                uni_binding(5, 160),
            ],
        });

        let copy_ext_pipe = make_pipeline(
            device,
            &copy_ext_bgl,
            &module,
            "fs_copy_extended",
            RGBA8,
            None,
            "reader copy_ext",
        );
        let mip_pipe = make_pipeline(device, &mip_bgl, &module, "fs_mip_down", RGBA8, None, "reader mip_down");
        let coarse_down_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("coarse backdrop downsample"),
            entries: &[tex_binding(0, true), samp_binding(1)],
        });
        let coarse_down_pipe = make_pipeline(
            device,
            &coarse_down_bgl,
            &module,
            "fs_coarse_down",
            RGBA8,
            None,
            "coarse backdrop downsample",
        );
        let down_pipe = make_pipeline(
            device,
            &down_bgl,
            &module,
            "fs_down",
            height_format,
            None,
            "reader down",
        );
        let blur_x_pipe = make_pipeline(
            device,
            &blur_bgl,
            &module,
            "fs_blur_x",
            height_format,
            None,
            "reader blur_x",
        );
        let blur_y_pipe = make_pipeline(
            device,
            &blur_bgl,
            &module,
            "fs_blur_y",
            height_format,
            None,
            "reader blur_y",
        );
        let frost_pipe = make_pipeline(device, &frost_bgl, &module, "fs_frost", RGBA8, None, "reader frost");
        let glass_pipe = make_pipeline(device, &glass_bgl, &module, "fs_glass", RGBA8, None, "reader glass");
        let coarse_pipe = make_pipeline(
            device,
            &coarse_bgl,
            &module,
            "fs_glass_coarse",
            RGBA8,
            None,
            "reader glass_coarse",
        );
        let comp_pipe = make_pipeline(
            device,
            &comp_bgl,
            &module,
            "fs_composite",
            RGBA8,
            Some(wgpu::BlendState::PREMULTIPLIED_ALPHA_BLENDING),
            "reader composite",
        );
        let comp_dual_pipe = make_pipeline_targets(
            device,
            &comp_bgl,
            &module,
            "fs_composite_dual",
            &std::array::from_fn::<_, 2, _>(|_| {
                color_target(RGBA8, Some(wgpu::BlendState::PREMULTIPLIED_ALPHA_BLENDING))
            }),
            "reader dual composite",
        );
        let lerp_blend = wgpu::BlendState {
            color: wgpu::BlendComponent {
                src_factor: wgpu::BlendFactor::Constant,
                dst_factor: wgpu::BlendFactor::OneMinusConstant,
                operation: wgpu::BlendOperation::Add,
            },
            alpha: wgpu::BlendComponent {
                src_factor: wgpu::BlendFactor::Constant,
                dst_factor: wgpu::BlendFactor::OneMinusConstant,
                operation: wgpu::BlendOperation::Add,
            },
        };
        let lerp_pipe = make_pipeline(
            device,
            &comp_bgl,
            &module,
            "fs_composite",
            RGBA8,
            Some(lerp_blend),
            "reader lerp",
        );
        let bg_blur_pipe = make_pipeline(
            device,
            &bg_blur_bgl,
            &module,
            "fs_bg_blur_composite",
            RGBA8,
            None,
            "reader bg_blur_comp",
        );
        let prog_blur_pipe = make_pipeline(
            device,
            &prog_blur_bgl,
            &module,
            "fs_progressive_blur",
            RGBA8,
            None,
            "reader prog_blur",
        );
        let halo_clip_border_pipe = make_pipeline(
            device,
            &copy_ext_bgl,
            &module,
            "fs_halo_clip_border",
            RGBA8,
            None,
            "reader halo_clip_border",
        );
        let halo_clip_clamp_pipe = make_pipeline(
            device,
            &halo_clip_clamp_bgl,
            &module,
            "fs_halo_clip_clamp",
            RGBA8,
            None,
            "reader halo_clip_clamp",
        );
        let downsample_rect_pipe = make_pipeline(
            device,
            &blur_bgl,
            &module,
            "fs_downsample_rect",
            RGBA8,
            None,
            "reader downsample_rect",
        );

        let lin_samp = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("reader linear"),
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::MipmapFilterMode::Nearest,
            ..Default::default()
        });
        let mip_lin_samp = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("reader trilinear"),
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::MipmapFilterMode::Linear,
            ..Default::default()
        });

        let white_1x1 = make_plain(
            device,
            1,
            1,
            RGBA8,
            4,
            wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            "reader white 1x1",
        );
        queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &white_1x1.texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            &[255u8, 255, 255, 255],
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(4),
                rows_per_image: Some(1),
            },
            wgpu::Extent3d {
                width: 1,
                height: 1,
                depth_or_array_layers: 1,
            },
        );

        let uniform_align = device.limits().min_uniform_buffer_offset_alignment.max(256);

        Self {
            copy_ext_bgl,
            mip_bgl,
            down_bgl,
            blur_bgl,
            frost_bgl,
            glass_bgl,
            coarse_bgl,
            comp_bgl,
            bg_blur_bgl,
            prog_blur_bgl,
            halo_clip_clamp_bgl,
            copy_ext_pipe,
            mip_pipe,
            coarse_down_pipe,
            down_pipe,
            blur_x_pipe,
            blur_y_pipe,
            frost_pipe,
            glass_pipe,
            coarse_pipe,
            comp_pipe,
            comp_dual_pipe,
            lerp_pipe,
            bg_blur_pipe,
            prog_blur_pipe,
            halo_clip_border_pipe,
            halo_clip_clamp_pipe,
            downsample_rect_pipe,
            height_format,
            height_bpp,
            height_packed,
            lin_samp,
            mip_lin_samp,
            white_1x1,
            uniform_align,
            slabs: Vec::new(),
            slab_idx: 0,
            slab_slot: 0,
            uniform_start: 0,
            uniform_bytes: Vec::new(),
            backdrop_frame: None,
            delta_frame: None,
            shared_coarse_mips: None,
            shared_coarse_key: None,
            mip_pool: Vec::new(),
            pool_tick: 0,
            frosted_tmp: None,
            low_0: None,
            low_1: None,
            mask_tex: None,
            glass_mask_atlas: None,
            clip_tex: None,
            blur_out: None,
            blur_source: None,
            halo_border_src: None,
            dst_copy: None,
            retired: Vec::new(),
        }
    }

    fn make_slab(device: &wgpu::Device, align: u32) -> wgpu::Buffer {
        device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("reader uniforms"),
            size: u64::from(align) * u64::from(SLAB_SLOTS),
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        })
    }

    /// Total GPU memory currently allocated by reader slabs and textures.
    pub fn bytes(&self) -> usize {
        let mut total = self.slabs.len() * (self.uniform_align as usize * SLAB_SLOTS as usize);
        if let Some(t) = &self.backdrop_frame {
            total += t.bytes();
        }
        if let Some(t) = &self.delta_frame {
            total += t.bytes();
        }
        if let Some(t) = &self.shared_coarse_mips {
            total += t.bytes;
        }
        for t in &self.mip_pool {
            total += t.bytes;
        }
        if let Some(t) = &self.frosted_tmp {
            total += t.bytes();
        }
        if let Some(t) = &self.low_0 {
            total += t.bytes();
        }
        if let Some(t) = &self.low_1 {
            total += t.bytes();
        }
        if let Some(t) = &self.mask_tex {
            total += t.bytes();
        }
        if let Some(t) = &self.glass_mask_atlas {
            total += t.bytes();
        }
        if let Some(t) = &self.clip_tex {
            total += t.bytes();
        }
        if let Some(t) = &self.blur_out {
            total += t.bytes();
        }
        if let Some(t) = &self.blur_source {
            total += t.bytes();
        }
        if let Some(t) = &self.halo_border_src {
            total += t.bytes();
        }
        if let Some(t) = &self.dst_copy {
            total += t.bytes();
        }
        total
    }

    pub fn begin_frame(&mut self) {
        self.uniform_bytes.clear();
        self.slab_idx = 0;
        self.slab_slot = 0;
    }

    /// Upload all reader uniforms recorded since the preceding submission in one write.
    pub fn flush_uniforms(&mut self, queue: &wgpu::Queue) {
        if !self.uniform_bytes.is_empty() {
            queue.write_buffer(
                &self.slabs[self.slab_idx],
                u64::from(self.uniform_start),
                &self.uniform_bytes,
            );
            self.uniform_bytes.clear();
        }
    }

    pub fn discard_uniforms(&mut self) {
        self.uniform_bytes.clear();
    }

    pub fn retire(&mut self, tex: wgpu::Texture) {
        self.retired.push(tex);
    }

    /// Destroys replaced or evicted reader textures after `queue.submit` (or encoder discard).
    pub fn flush_retired(&mut self) {
        for tex in self.retired.drain(..) {
            tex.destroy();
        }
    }

    pub fn clear_frame_targets(&mut self) {
        if let Some(t) = self.backdrop_frame.take() {
            self.retired.push(t.texture);
        }
        if let Some(t) = self.delta_frame.take() {
            self.retired.push(t.texture);
        }
        if let Some(t) = self.blur_source.take() {
            self.retired.push(t.texture);
        }
        if let Some(t) = self.halo_border_src.take() {
            self.retired.push(t.texture);
        }
        if let Some(t) = self.shared_coarse_mips.take() {
            self.retired.push(t.texture);
        }
        self.shared_coarse_key = None;
    }

    /// Drops all cached reader frame targets and scratch pools (called when a frame has no readers).
    pub fn evict_frame_scratch(&mut self) {
        self.clear_frame_targets();
        for t in self.mip_pool.drain(..) {
            self.retired.push(t.texture);
        }
        if let Some(t) = self.frosted_tmp.take() {
            self.retired.push(t.texture);
        }
        if let Some(t) = self.low_0.take() {
            self.retired.push(t.texture);
        }
        if let Some(t) = self.low_1.take() {
            self.retired.push(t.texture);
        }
        if let Some(t) = self.mask_tex.take() {
            self.retired.push(t.texture);
        }
        if let Some(t) = self.glass_mask_atlas.take() {
            self.retired.push(t.texture);
        }
        if let Some(t) = self.clip_tex.take() {
            self.retired.push(t.texture);
        }
        if let Some(t) = self.blur_out.take() {
            self.retired.push(t.texture);
        }
        if let Some(t) = self.dst_copy.take() {
            self.retired.push(t.texture);
        }
    }

    fn reserve_bytes(&self, add: usize, freed: usize, what: &str, max_bytes: usize) -> Result<()> {
        let after = self.bytes().saturating_sub(freed).saturating_add(add);
        if after > max_bytes {
            return Err(EngineError::limit(format!(
                "{what} would take reader GPU memory to {} MiB; {} MiB available",
                after.div_ceil(1 << 20),
                max_bytes >> 20
            )));
        }
        Ok(())
    }

    pub fn ensure_frame_tex_budgeted(
        &mut self,
        which_backdrop: bool,
        device: &wgpu::Device,
        w: u32,
        h: u32,
        label: &str,
        max_bytes: usize,
    ) -> Result<()> {
        let current = if which_backdrop {
            self.backdrop_frame.as_ref()
        } else {
            self.delta_frame.as_ref()
        };
        if current.is_some_and(|t| t.width == w && t.height == h) {
            return Ok(());
        }
        let freed = current.map_or(0, PlainTex::bytes);
        let add = w.max(1) as usize * h.max(1) as usize * 4;
        self.reserve_bytes(add, freed, label, max_bytes)?;
        let slot = if which_backdrop {
            &mut self.backdrop_frame
        } else {
            &mut self.delta_frame
        };
        if let Some(old) = slot.take() {
            self.retired.push(old.texture);
        }
        Self::ensure_frame_tex(slot, device, w, h, label);
        Ok(())
    }

    pub fn ensure_frame_tex(slot: &mut Option<PlainTex>, device: &wgpu::Device, w: u32, h: u32, label: &str) {
        if slot.as_ref().is_some_and(|t| t.width == w && t.height == h) {
            return;
        }
        *slot = Some(make_plain(
            device,
            w,
            h,
            RGBA8,
            4,
            wgpu::TextureUsages::RENDER_ATTACHMENT
                | wgpu::TextureUsages::TEXTURE_BINDING
                | wgpu::TextureUsages::COPY_SRC
                | wgpu::TextureUsages::COPY_DST,
            label,
        ));
    }

    #[allow(clippy::too_many_arguments)]
    fn ensure_growable_plain(
        slot: &mut Option<PlainTex>,
        device: &wgpu::Device,
        w: u32,
        h: u32,
        format: wgpu::TextureFormat,
        bpp: usize,
        usage: wgpu::TextureUsages,
        label: &str,
    ) {
        let nw = w.max(1).next_multiple_of(64);
        let nh = h.max(1).next_multiple_of(64);
        let reuse = slot.as_ref().is_some_and(|t| {
            t.width >= w
                && t.height >= h
                && (t.width as usize * t.height as usize) <= (nw as usize * nh as usize * 4).max(1_048_576)
        });
        if !reuse {
            *slot = Some(make_plain(device, nw, nh, format, bpp, usage, label));
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn ensure_vello_tex_budgeted(
        &mut self,
        is_clip: bool,
        device: &wgpu::Device,
        renderer: &Renderer,
        w: u32,
        h: u32,
        label: &str,
        max_bytes: usize,
    ) -> Result<()> {
        let nw = w.max(1).next_multiple_of(64).min(u32::from(u16::MAX));
        let nh = h.max(1).next_multiple_of(64).min(u32::from(u16::MAX));
        let cur = if is_clip {
            self.clip_tex.as_ref()
        } else {
            self.mask_tex.as_ref()
        };
        let reuse = cur.is_some_and(|t| {
            t.width >= w
                && t.height >= h
                && (t.width as usize * t.height as usize) <= (nw as usize * nh as usize * 4).max(1_048_576)
        });
        if !reuse {
            let freed = cur.map_or(0, VelloTex::bytes);
            let add = nw as usize * nh as usize * 8;
            self.reserve_bytes(add, freed, label, max_bytes)?;
            let slot = if is_clip {
                &mut self.clip_tex
            } else {
                &mut self.mask_tex
            };
            if let Some(old) = slot.take() {
                self.retired.push(old.texture);
            }
            Self::ensure_vello_tex(slot, device, renderer, w, h, label);
        }
        Ok(())
    }

    pub fn glass_mask_atlas_bytes(&self) -> usize {
        self.glass_mask_atlas.as_ref().map_or(0, VelloTex::bytes)
    }

    pub fn drop_glass_mask_atlas(&mut self) {
        if let Some(old) = self.glass_mask_atlas.take() {
            self.retired.push(old.texture);
        }
    }

    pub fn ensure_glass_mask_atlas(
        &mut self,
        device: &wgpu::Device,
        renderer: &Renderer,
        size: (u32, u32),
        max_bytes: usize,
    ) -> bool {
        let nw = size.0.max(1).next_multiple_of(64).min(u32::from(u16::MAX));
        let nh = size.1.max(1).next_multiple_of(64).min(u32::from(u16::MAX));
        let reuse = self.glass_mask_atlas.as_ref().is_some_and(|t| {
            t.width >= size.0
                && t.height >= size.1
                && (t.width as usize * t.height as usize) <= (nw as usize * nh as usize * 4).max(1_048_576)
        });
        let freed = self.glass_mask_atlas_bytes();
        let needed = if reuse {
            freed
        } else {
            crate::glass::glass_mask_atlas_bytes(size.0, size.1)
        };
        if needed > GLASS_MASK_ATLAS_MAX_BYTES
            || self
                .reserve_bytes(needed, freed, "glass mask atlas", max_bytes)
                .is_err()
        {
            return false;
        }
        if !reuse {
            if let Some(old) = self.glass_mask_atlas.take() {
                self.retired.push(old.texture);
            }
            Self::ensure_vello_tex(
                &mut self.glass_mask_atlas,
                device,
                renderer,
                size.0,
                size.1,
                "glass mask atlas",
            );
        }
        true
    }

    fn glass_mask_view(&self, batched: bool) -> &wgpu::TextureView {
        if batched {
            &self.glass_mask_atlas.as_ref().expect("glass mask atlas").view
        } else {
            &self.mask_tex.as_ref().expect("glass mask").view
        }
    }

    pub fn ensure_vello_tex(
        slot: &mut Option<VelloTex>,
        device: &wgpu::Device,
        renderer: &Renderer,
        w: u32,
        h: u32,
        label: &str,
    ) {
        let nw = w.max(1).next_multiple_of(64).min(u32::from(u16::MAX));
        let nh = h.max(1).next_multiple_of(64).min(u32::from(u16::MAX));
        let reuse = slot.as_ref().is_some_and(|t| {
            t.width >= w
                && t.height >= h
                && (t.width as usize * t.height as usize) <= (nw as usize * nh as usize * 4).max(1_048_576)
        });
        if !reuse {
            let texture = device.create_texture(&wgpu::TextureDescriptor {
                label: Some(label),
                size: wgpu::Extent3d {
                    width: nw,
                    height: nh,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: RGBA8,
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
                view_formats: &[],
            });
            let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
            let depth = renderer.create_depth_texture_view(&RenderSize {
                width: nw as u16,
                height: nh as u16,
            });
            *slot = Some(VelloTex {
                texture,
                view,
                depth,
                width: nw,
                height: nh,
            });
        }
    }

    /// Acquires an exact-size mipmapped texture from the LRU pool (excluding `avoid` if provided),
    /// checking and enforcing `max_bytes` before allocation.
    fn acquire_mip_tex(
        &mut self,
        device: &wgpu::Device,
        size: (u32, u32),
        max_mips: u32,
        avoid: Option<usize>,
        label: &str,
        max_bytes: usize,
    ) -> Result<usize> {
        let (w, h) = size;
        self.pool_tick += 1;
        let tick = self.pool_tick;
        let levels = glass::mip_count(w, h).min(max_mips);
        if let Some(idx) =
            self.mip_pool.iter().enumerate().position(|(i, t)| {
                Some(i) != avoid && t.width == w && t.height == h && t.mip_views.len() as u32 == levels
            })
        {
            self.mip_pool[idx].used = tick;
            return Ok(idx);
        }
        let add = MipTex::estimate_bytes(w, h, levels);
        // Evict stale pool entries if needed to stay under `max_bytes`.
        let mut victim = if self.mip_pool.len() >= MIP_POOL_CAP {
            self.mip_pool
                .iter()
                .enumerate()
                .filter(|(i, _)| Some(*i) != avoid)
                .min_by_key(|(_, t)| t.used)
                .map(|(i, _)| i)
        } else {
            None
        };
        let mut freed = victim.map_or(0, |i| self.mip_pool[i].bytes);
        if self.bytes().saturating_sub(freed).saturating_add(add) > max_bytes {
            // Retain only `avoid` (if any) to maximize room under budget.
            let keep = avoid.and_then(|i| {
                if i < self.mip_pool.len() {
                    Some(self.mip_pool.swap_remove(i))
                } else {
                    None
                }
            });
            for t in self.mip_pool.drain(..) {
                self.retired.push(t.texture);
            }
            if let Some(t) = keep {
                self.mip_pool.push(t);
            }
            victim = None;
            freed = 0;
        }
        self.reserve_bytes(add, freed, label, max_bytes)?;
        let tex = MipTex::new(device, &self.mip_bgl, w, h, levels, label, tick);
        if let Some(v) = victim {
            let old = std::mem::replace(&mut self.mip_pool[v], tex);
            self.retired.push(old.texture);
            Ok(v)
        } else {
            self.mip_pool.push(tex);
            Ok(self.mip_pool.len() - 1)
        }
    }

    fn push_uniform(&mut self, device: &wgpu::Device, queue: &wgpu::Queue, values: &[f32]) -> (usize, u32) {
        if self.slabs.is_empty() {
            self.slabs.push(Self::make_slab(device, self.uniform_align));
        }
        if self.slab_slot >= SLAB_SLOTS {
            self.flush_uniforms(queue);
            self.slab_idx += 1;
            self.slab_slot = 0;
            if self.slab_idx >= self.slabs.len() {
                self.slabs.push(Self::make_slab(device, self.uniform_align));
            }
        }
        let offset = self.slab_slot * self.uniform_align;
        self.slab_slot += 1;
        if self.uniform_bytes.is_empty() {
            self.uniform_start = offset;
        }
        self.uniform_bytes.resize((offset - self.uniform_start) as usize, 0);
        for value in values {
            self.uniform_bytes.extend_from_slice(&value.to_le_bytes());
        }
        (self.slab_idx, offset)
    }

    /// Composites a scope-local source into a rectangle of its parent, either with
    /// premultiplied source-over or by interpolating between two complete pictures.
    #[allow(clippy::too_many_arguments)]
    pub fn encode_composite(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        encoder: &mut wgpu::CommandEncoder,
        src_view: &wgpu::TextureView,
        destination: CompositeTarget<'_>,
        dst_origin: (i32, i32),
        scissor: (u32, u32, u32, u32),
        opacity: f32,
    ) {
        let opacity = opacity.clamp(0.0, 1.0);
        let source_scale = if matches!(destination, CompositeTarget::Lerp(_)) {
            1.0
        } else {
            opacity
        };
        let data = &[source_scale, dst_origin.0 as f32, dst_origin.1 as f32, 0.0];
        let (slab_idx, offset) = self.push_uniform(device, queue, data);
        let group = self.make_tex_uniform_bg(device, &self.comp_bgl, src_view, slab_idx, 16);
        let (pipeline, first, second) = match destination {
            CompositeTarget::Over(view) => (&self.comp_pipe, view, None),
            CompositeTarget::OverBoth(main, backdrop) => (&self.comp_dual_pipe, main, Some(backdrop)),
            CompositeTarget::Lerp(view) => (&self.lerp_pipe, view, None),
        };
        fn attachment(view: &wgpu::TextureView) -> wgpu::RenderPassColorAttachment<'_> {
            wgpu::RenderPassColorAttachment {
                view,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Load,
                    store: wgpu::StoreOp::Store,
                },
            }
        }
        let attachments = [Some(attachment(first)), second.map(attachment)];
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("scope composite"),
            color_attachments: &attachments[..1 + usize::from(second.is_some())],
            ..Default::default()
        });
        pass.set_pipeline(pipeline);
        if matches!(destination, CompositeTarget::Lerp(_)) {
            let opacity = f64::from(opacity);
            pass.set_blend_constant(wgpu::Color {
                r: opacity,
                g: opacity,
                b: opacity,
                a: opacity,
            });
        }
        pass.set_bind_group(0, &group, &[offset]);
        pass.set_scissor_rect(scissor.0, scissor.1, scissor.2, scissor.3);
        pass.draw(0..3, 0..1);
    }

    /// Clears a texture to `color`.
    pub fn encode_clear(encoder: &mut wgpu::CommandEncoder, view: &wgpu::TextureView, color: wgpu::Color) {
        let _pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("reader clear"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(color),
                    store: wgpu::StoreOp::Store,
                },
            })],
            ..Default::default()
        });
    }

    fn encode_build_mipmaps(&self, encoder: &mut wgpu::CommandEncoder, mips: &MipTex) {
        for (view, group) in mips.mip_views[1..].iter().zip(&mips.downsample_groups) {
            Self::encode_fullscreen_pass(
                encoder,
                "reader mip_down",
                view,
                wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                None,
                &self.mip_pipe,
                group,
                None,
            );
        }
    }

    /// Reuses a half-resolution backdrop pyramid across unclipped readers of the same prefix.
    #[allow(clippy::too_many_arguments)]
    fn ensure_shared_coarse_mips(
        &mut self,
        device: &wgpu::Device,
        encoder: &mut wgpu::CommandEncoder,
        source: &wgpu::TextureView,
        size: (u32, u32),
        backdrop_gen: u64,
        max_bytes: usize,
    ) -> Result<()> {
        let key = (backdrop_gen, size.0, size.1);
        if self.shared_coarse_key == Some(key) && self.shared_coarse_mips.is_some() {
            return Ok(());
        }
        let (w, h) = ((size.0 / 2).max(1), (size.1 / 2).max(1));
        if !self
            .shared_coarse_mips
            .as_ref()
            .is_some_and(|t| t.width == w && t.height == h)
        {
            let freed = self.shared_coarse_mips.as_ref().map_or(0, |t| t.bytes);
            let levels = COARSE_MAX_MIPS - 1;
            let add = MipTex::estimate_bytes(w, h, levels);
            self.reserve_bytes(add, freed, "shared coarse backdrop", max_bytes)?;
            if let Some(old) = self.shared_coarse_mips.take() {
                self.retired.push(old.texture);
            }
            self.shared_coarse_mips = Some(MipTex::new(
                device,
                &self.mip_bgl,
                w,
                h,
                levels,
                "shared coarse backdrop",
                0,
            ));
        }
        let mips = self.shared_coarse_mips.as_ref().expect("just created");
        let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: None,
            layout: &self.coarse_down_pipe.get_bind_group_layout(0),
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(source),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Sampler(&self.lin_samp),
                },
            ],
        });
        Self::encode_fullscreen_pass(
            encoder,
            "coarse backdrop downsample",
            &mips.mip_views[0],
            wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
            None,
            &self.coarse_down_pipe,
            &group,
            None,
        );
        self.encode_build_mipmaps(encoder, mips);
        self.shared_coarse_key = Some(key);
        Ok(())
    }

    /// Encodes `copy_extended` + mipmaps into a pooled `MipTex` of size `(region.rw, region.rh)`.
    #[allow(clippy::too_many_arguments)]
    fn encode_copy_extended_and_mips(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        encoder: &mut wgpu::CommandEncoder,
        backdrop_view: &wgpu::TextureView,
        tex_size: (i32, i32),
        frame_size: (i32, i32),
        offset: (i32, i32),
        region: &GlassRegion,
        within: Option<ClipWithin>,
        max_mips: u32,
        max_bytes: usize,
    ) -> Result<usize> {
        let idx = self.acquire_mip_tex(
            device,
            (region.rw, region.rh),
            max_mips,
            None,
            "reader region backdrop",
            max_bytes,
        )?;
        let (bx0, by0, bx1, by1, fill_info) = match within {
            Some(w) => (
                w.x0.floor().max(0.0) as i32 + offset.0,
                w.y0.floor().max(0.0) as i32 + offset.1,
                (w.x1.ceil() as i32).min(frame_size.0) + offset.0,
                (w.y1.ceil() as i32).min(frame_size.1) + offset.1,
                w.fill.map(|c| {
                    (
                        (w.x0.round() as i32 + offset.0) as f32,
                        (w.y0.round() as i32 + offset.1) as f32,
                        (w.x1.round() as i32 + offset.0) as f32,
                        (w.y1.round() as i32 + offset.1) as f32,
                        c,
                    )
                }),
            ),
            None => (
                offset.0.max(0),
                offset.1.max(0),
                (frame_size.0 + offset.0).min(tex_size.0),
                (frame_size.1 + offset.1).min(tex_size.1),
                None,
            ),
        };
        let sx0 = bx0.clamp(0, tex_size.0);
        let sy0 = by0.clamp(0, tex_size.1);
        let sx1 = bx1.clamp(0, tex_size.0);
        let sy1 = by1.clamp(0, tex_size.1);
        let is_empty = sx1 <= sx0 || sy1 <= sy0;
        let (has_fill, fx0, fy0, fx1, fy1, fill_rgba) = match fill_info {
            Some((x0, y0, x1, y1, c)) => (
                1.0f32,
                x0,
                y0,
                x1,
                y1,
                [
                    f32::from(c[0]) / 255.0,
                    f32::from(c[1]) / 255.0,
                    f32::from(c[2]) / 255.0,
                    f32::from(c[3]) / 255.0,
                ],
            ),
            None => (0.0, 0.0, 0.0, 0.0, 0.0, [0.0; 4]),
        };
        let u_bytes = &[
            (region.x0 + offset.0) as f32,
            (region.y0 + offset.1) as f32,
            sx0 as f32,
            sy0 as f32,
            (sx1 - 1).max(sx0) as f32,
            (sy1 - 1).max(sy0) as f32,
            has_fill,
            if is_empty { 1.0 } else { 0.0 },
            fx0,
            fy0,
            fx1,
            fy1,
            fill_rgba[0],
            fill_rgba[1],
            fill_rgba[2],
            fill_rgba[3],
        ];
        let (slab_idx, u_off) = self.push_uniform(device, queue, u_bytes);
        let group = self.make_tex_uniform_bg(device, &self.copy_ext_bgl, backdrop_view, slab_idx, 64);
        Self::encode_fullscreen_pass(
            encoder,
            "reader copy_ext",
            &self.mip_pool[idx].mip_views[0],
            wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
            None,
            &self.copy_ext_pipe,
            &group,
            Some(u_off),
        );
        self.encode_build_mipmaps(encoder, &self.mip_pool[idx]);
        Ok(idx)
    }

    /// Encodes all GPU passes for one glass chunk (after `mask_tex` and optional `clip_tex` are
    /// already rendered by `vello_gpu`, unless `analytic_coarse` is provided) into `encoder`,
    /// writing the final result into `dst_tex`/`dst_view`.
    #[allow(clippy::too_many_arguments)]
    pub fn encode_glass(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        encoder: &mut wgpu::CommandEncoder,
        backdrop_view: &wgpu::TextureView,
        dst_tex: &wgpu::Texture,
        dst_view: &wgpu::TextureView,
        tex_size: (u32, u32),
        frame_size: (i32, i32),
        source_offset: (i32, i32),
        dst_offset: (i32, i32),
        backdrop_gen: u64,
        backdrop_is_frame: bool,
        params: &GlassParams,
        region: &GlassRegion,
        within: Option<ClipWithin>,
        alpha: f32,
        coarse: bool,
        analytic_coarse: Option<CoarseAnalytic>,
        mask_slot: Option<(u32, u32)>,
        has_clip_mask: bool,
        resolve: Option<GlassResolve<'_>>,
        max_bytes: usize,
    ) -> Result<()> {
        // GlassRegion's write rectangle is already local to the destination. Only
        // the region used for backdrop and mask sampling needs the frame offset.
        let out_x0 = region.out_x0 as u32;
        let out_y0 = region.out_y0 as u32;
        let out_w = (region.out_x1 - region.out_x0) as u32;
        let out_h = (region.out_y1 - region.out_y0) as u32;
        if out_w == 0 || out_h == 0 {
            return Ok(());
        }

        // Snapshot current dst pixels under the glass rect for exact premultiplied replace.
        let dst_nw = out_w.max(1).next_multiple_of(64);
        let dst_nh = out_h.max(1).next_multiple_of(64);
        let dst_reuse = self.dst_copy.as_ref().is_some_and(|t| {
            t.width >= out_w
                && t.height >= out_h
                && (t.width as usize * t.height as usize) <= (dst_nw as usize * dst_nh as usize * 4).max(1_048_576)
        });
        if !dst_reuse {
            let freed = self.dst_copy.as_ref().map_or(0, PlainTex::bytes);
            self.reserve_bytes(
                dst_nw as usize * dst_nh as usize * 4,
                freed,
                "reader dst_copy",
                max_bytes,
            )?;
            if let Some(old) = self.dst_copy.take() {
                self.retired.push(old.texture);
            }
            Self::ensure_growable_plain(
                &mut self.dst_copy,
                device,
                out_w,
                out_h,
                RGBA8,
                4,
                wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
                "reader dst_copy",
            );
        }
        self.copy_to_dst_copy(encoder, dst_tex, out_x0, out_y0, out_w, out_h);

        let mask_x0 = (region.x0 + dst_offset.0) as f32;
        let mask_y0 = (region.y0 + dst_offset.1) as f32;

        if coarse {
            // Fast interactive coarse stand-in: share one tile/frame mipmap (<= 5 levels) across
            // all unclipped glass cards on the same backdrop generation (zero per-card copy_extended/mipmaps).
            let use_shared = backdrop_is_frame && within.is_none() && source_offset == (0, 0);
            let (uv_ox, uv_oy, inv_bw, inv_bh, max_mip, region_idx) = if use_shared {
                self.ensure_shared_coarse_mips(device, encoder, backdrop_view, tex_size, backdrop_gen, max_bytes)?;
                let mips = self.shared_coarse_mips.as_ref().expect("shared");
                (
                    (region.x0 + source_offset.0) as f32,
                    (region.y0 + source_offset.1) as f32,
                    1.0 / (tex_size.0 as f32),
                    1.0 / (tex_size.1 as f32),
                    (mips.mip_views.len() - 1) as f32,
                    None,
                )
            } else {
                let idx = self.encode_copy_extended_and_mips(
                    device,
                    queue,
                    encoder,
                    backdrop_view,
                    (tex_size.0 as i32, tex_size.1 as i32),
                    frame_size,
                    source_offset,
                    region,
                    within,
                    u32::MAX,
                    max_bytes,
                )?;
                let m = &self.mip_pool[idx];
                (
                    0.0,
                    0.0,
                    1.0 / (m.width as f32),
                    1.0 / (m.height as f32),
                    (m.mip_views.len() - 1) as f32,
                    Some(idx),
                )
            };
            let sigma = params.frost.max(3.0 * params.unit_px);
            let base_lod = if use_shared { 1.0 } else { 0.0 };
            let lod = ((sigma * 1.5).max(1.0).log2() - base_lod).clamp(0.0, max_mip);
            let (mask_mode, unit_px, to_box_x, to_box_y, radii, smoothing) = match analytic_coarse {
                Some(ca) => (
                    f32::from(ca.mode),
                    ca.unit_px,
                    [ca.to_box[0], ca.to_box[2], ca.to_box[4], ca.size[0]],
                    [ca.to_box[1], ca.to_box[3], ca.to_box[5], ca.size[1]],
                    ca.radii,
                    ca.smoothing,
                ),
                None => (0.0, params.unit_px, [0.0; 4], [0.0; 4], [0.0; 4], [0.0; 4]),
            };
            let u_bytes = &[
                region.rw as f32,
                region.rh as f32,
                lod,
                alpha,
                mask_x0,
                mask_y0,
                out_x0 as f32,
                out_y0 as f32,
                if has_clip_mask { 1.0 } else { 0.0 },
                mask_mode,
                unit_px,
                0.0,
                uv_ox,
                uv_oy,
                inv_bw,
                inv_bh,
                to_box_x[0],
                to_box_x[1],
                to_box_x[2],
                to_box_x[3],
                to_box_y[0],
                to_box_y[1],
                to_box_y[2],
                to_box_y[3],
                radii[0],
                radii[1],
                radii[2],
                radii[3],
                smoothing[0],
                smoothing[1],
                smoothing[2],
                smoothing[3],
            ];
            let (slab_idx, u_off) = self.push_uniform(device, queue, u_bytes);
            let b_view = match region_idx {
                Some(i) => &self.mip_pool[i].full_view,
                None => &self.shared_coarse_mips.as_ref().expect("shared").full_view,
            };
            let mask_view = if analytic_coarse.is_some() {
                &self.white_1x1.view
            } else {
                &self.mask_tex.as_ref().expect("mask").view
            };
            let dst_copy_view = &self.dst_copy.as_ref().expect("dst_copy").view;
            let clip_view = if has_clip_mask {
                &self.clip_tex.as_ref().expect("clip").view
            } else {
                &self.white_1x1.view
            };
            let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: None,
                layout: &self.coarse_bgl,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: wgpu::BindingResource::TextureView(b_view),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: wgpu::BindingResource::Sampler(&self.mip_lin_samp),
                    },
                    wgpu::BindGroupEntry {
                        binding: 2,
                        resource: wgpu::BindingResource::TextureView(mask_view),
                    },
                    wgpu::BindGroupEntry {
                        binding: 3,
                        resource: wgpu::BindingResource::TextureView(dst_copy_view),
                    },
                    wgpu::BindGroupEntry {
                        binding: 4,
                        resource: wgpu::BindingResource::TextureView(clip_view),
                    },
                    wgpu::BindGroupEntry {
                        binding: 5,
                        resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                            buffer: &self.slabs[slab_idx],
                            offset: 0,
                            size: wgpu::BufferSize::new(128),
                        }),
                    },
                ],
            });
            Self::encode_scissored_pass(
                encoder,
                "reader glass_coarse",
                dst_view,
                (out_x0, out_y0, out_w, out_h),
                &self.coarse_pipe,
                &group,
                u_off,
            );
            return Ok(());
        }

        // Frost reads one integer LOD of the backdrop. Refraction samples the separate
        // frosted texture, so only that texture needs to retain its complete chain.
        let frost = (params.frost > 0.4).then(|| {
            glass::frost_params(
                params.frost,
                region.rw,
                region.rh,
                glass::mip_count(region.rw, region.rh) - 1,
            )
        });
        // 1. Copy extended backdrop and build the sampled mip levels.
        let base_mip_idx = self.encode_copy_extended_and_mips(
            device,
            queue,
            encoder,
            backdrop_view,
            (tex_size.0 as i32, tex_size.1 as i32),
            frame_size,
            source_offset,
            region,
            within,
            frost.map_or(u32::MAX, |f| f.level + 1),
            max_bytes,
        )?;

        // 2. Optional mip-assisted frost pass (exact port of glass.ts / frost_cpu).
        let sampled_mip_idx = if let Some(fp) = frost {
            let need_ft = !self
                .frosted_tmp
                .as_ref()
                .is_some_and(|t| t.width == fp.fw && t.height == fp.fh);
            if need_ft {
                let freed = self.frosted_tmp.as_ref().map_or(0, PlainTex::bytes);
                self.reserve_bytes(
                    fp.fw as usize * fp.fh as usize * 4,
                    freed,
                    "reader frosted_tmp",
                    max_bytes,
                )?;
                if let Some(old) = self.frosted_tmp.take() {
                    self.retired.push(old.texture);
                }
                Self::ensure_frame_tex(&mut self.frosted_tmp, device, fp.fw, fp.fh, "reader frosted_tmp");
            }
            let base_view = self.mip_pool[base_mip_idx].full_view.clone();
            let frosted_idx = self.acquire_mip_tex(
                device,
                (fp.fw, fp.fh),
                u32::MAX,
                Some(base_mip_idx),
                "reader frosted",
                max_bytes,
            )?;

            // Horizontal pass: base_mip -> frosted_tmp
            let u_h = &[
                fp.fw as f32,
                fp.fh as f32,
                1.0,
                0.0,
                fp.level as f32,
                fp.left,
                fp.radius as f32,
                0.0,
            ];
            let (sh_idx, sh_off) = self.push_uniform(device, queue, u_h);
            let group_h = self.make_tex_uniform_bg(device, &self.frost_bgl, &base_view, sh_idx, 32);
            Self::encode_fullscreen_pass(
                encoder,
                "reader frost_h",
                &self.frosted_tmp.as_ref().expect("frosted_tmp").view,
                wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                None,
                &self.frost_pipe,
                &group_h,
                Some(sh_off),
            );

            // Vertical pass: frosted_tmp -> frosted[0]
            let u_v = &[
                fp.fw as f32,
                fp.fh as f32,
                0.0,
                1.0,
                0.0,
                fp.left,
                fp.radius as f32,
                0.0,
            ];
            let (sv_idx, sv_off) = self.push_uniform(device, queue, u_v);
            let ft_view = &self.frosted_tmp.as_ref().expect("ft").view;
            let group_v = self.make_tex_uniform_bg(device, &self.frost_bgl, ft_view, sv_idx, 32);
            Self::encode_fullscreen_pass(
                encoder,
                "reader frost_v",
                &self.mip_pool[frosted_idx].mip_views[0],
                wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                None,
                &self.frost_pipe,
                &group_v,
                Some(sv_off),
            );
            self.encode_build_mipmaps(encoder, &self.mip_pool[frosted_idx]);
            frosted_idx
        } else {
            base_mip_idx
        };

        // 3. Rim height field: downsample mask by k x k, then separable blur_x + blur_y.
        let native_rim = resolve.as_ref().and_then(|r| r.rim.as_ref());
        let (rim_w, rim_h) = native_rim.map_or((region.rw, region.rh), |r| {
            ((r.area.x1 - r.area.x0) as u32, (r.area.y1 - r.area.y0) as u32)
        });
        let params = native_rim.map_or(params, |r| &r.params);
        let k = glass::height_scale(params.sigma);
        let lw = rim_w.div_ceil(k);
        let lh = rim_h.div_ceil(k);
        let h_usage = wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING;
        let low_nw = lw.max(1).next_multiple_of(64);
        let low_nh = lh.max(1).next_multiple_of(64);
        for (slot_is_zero, label) in [(true, "reader low_0"), (false, "reader low_1")] {
            let cur = if slot_is_zero {
                self.low_0.as_ref()
            } else {
                self.low_1.as_ref()
            };
            let reuse = cur.is_some_and(|t| {
                t.width >= lw
                    && t.height >= lh
                    && (t.width as usize * t.height as usize) <= (low_nw as usize * low_nh as usize * 4).max(65_536)
            });
            if !reuse {
                let freed = cur.map_or(0, PlainTex::bytes);
                let add = low_nw as usize * low_nh as usize * self.height_bpp;
                self.reserve_bytes(add, freed, label, max_bytes)?;
                let slot = if slot_is_zero { &mut self.low_0 } else { &mut self.low_1 };
                if let Some(old) = slot.take() {
                    self.retired.push(old.texture);
                }
                Self::ensure_growable_plain(
                    slot,
                    device,
                    lw,
                    lh,
                    self.height_format,
                    self.height_bpp,
                    h_usage,
                    label,
                );
            }
        }

        let mask_view = self.glass_mask_view(mask_slot.is_some()).clone();
        let (mask_x, mask_y) = mask_slot.unwrap_or_default();
        let mask_offset = (mask_x + mask_y * GLASS_MASK_ATLAS_SIDE) as f32;
        // A 1 × 1 reduction only copies the alpha channel to the red channel of
        // the height texture. Apply that conversion at the horizontal filter's
        // input and skip the draw and bandwidth of writing a full-size texture.
        let blur_x_view = if k == 1 {
            mask_view
        } else {
            // Downsample mask -> low_0
            let u_down = &[rim_w as f32, rim_h as f32, k as f32, mask_offset];
            let (sd_idx, sd_off) = self.push_uniform(device, queue, u_down);
            let group_down = self.make_tex_uniform_bg(device, &self.down_bgl, &mask_view, sd_idx, 16);
            Self::encode_fullscreen_pass(
                encoder,
                "reader down",
                &self.low_0.as_ref().expect("low_0").view,
                wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                Some((0, 0, lw, lh)),
                &self.down_pipe,
                &group_down,
                Some(sd_off),
            );

            self.low_0.as_ref().expect("low_0").view.clone()
        };

        let sigma_low = params.sigma / (k as f32);
        let blur_radius = (sigma_low * 3.0).ceil().min(64.0);
        let packed_flag = if self.height_packed { 1.0 } else { 0.0 };
        let u_blur = &[
            lw as f32,
            lh as f32,
            sigma_low,
            blur_radius,
            packed_flag,
            if k == 1 { 1.0 } else { 0.0 },
            mask_x as f32,
            mask_y as f32,
        ];
        let (sb_idx, sb_off) = self.push_uniform(device, queue, u_blur);

        // blur_x: low_0 -> low_1
        let group_bx = self.make_tex_uniform_bg(device, &self.blur_bgl, &blur_x_view, sb_idx, 32);
        Self::encode_fullscreen_pass(
            encoder,
            "reader blur_x",
            &self.low_1.as_ref().expect("low_1").view,
            wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
            Some((0, 0, lw, lh)),
            &self.blur_x_pipe,
            &group_bx,
            Some(sb_off),
        );

        // blur_y: low_1 -> low_0
        let low1_view = &self.low_1.as_ref().expect("low_1").view;
        let group_by = self.make_tex_uniform_bg(device, &self.blur_bgl, low1_view, sb_idx, 32);
        Self::encode_fullscreen_pass(
            encoder,
            "reader blur_y",
            &self.low_0.as_ref().expect("low_0").view,
            wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
            Some((0, 0, lw, lh)),
            &self.blur_y_pipe,
            &group_by,
            Some(sb_off),
        );

        // 4. Final glass refraction, dispersion, splay, lighting, and premultiplied replace.
        let tune = DEFAULT_GLASS_TUNING;
        let (divisor, optical_origin) = resolve
            .as_ref()
            .map_or((1.0, (mask_x0, mask_y0)), |r| (r.divisor, r.optical_origin));
        let rim_scale = if native_rim.is_some() { divisor } else { 1.0 };
        let (is_box, to_box_x, to_box_y, radii, smoothing, box_unit_px) = match region.box_geom {
            Some(ref bg) => (
                1.0f32,
                [
                    bg.to_box[0] / rim_scale,
                    bg.to_box[2] / rim_scale,
                    bg.to_box[4],
                    bg.size[0],
                ],
                [
                    bg.to_box[1] / rim_scale,
                    bg.to_box[3] / rim_scale,
                    bg.to_box[5],
                    bg.size[1],
                ],
                bg.radii,
                bg.smoothing,
                bg.unit_px * rim_scale,
            ),
            None => (0.0, [0.0; 4], [0.0; 4], [0.0; 4], [0.0; 4], params.unit_px),
        };
        let hairline_px = (tune.hairline * params.unit_px).max(1e-3);
        let (rim_x, rim_y) = native_rim.map_or((0.0, 0.0), |r| r.offset);
        let mut native_map = [0.0, 0.0, 0.0, divisor];
        let mut native_bounds = [0.0; 4];
        if let Some(r) = resolve.as_ref().filter(|r| r.native.is_some()) {
            native_map = [r.native_origin.0, r.native_origin.1, 1.0, divisor];
            let w = r.native_size.0 as f32;
            let h = r.native_size.1 as f32;
            let ox = r.source_origin.0 as f32;
            let oy = r.source_origin.1 as f32;
            native_bounds = r.native_clip.map_or([0.0, 0.0, w, h], |clip| {
                [
                    (clip.x0.floor() - ox).clamp(0.0, w),
                    (clip.y0.floor() - oy).clamp(0.0, h),
                    (clip.x1.ceil() - ox).clamp(0.0, w),
                    (clip.y1.ceil() - oy).clamp(0.0, h),
                ]
            });
        }
        let u_glass = &[
            // sizes
            region.rw as f32,
            region.rh as f32,
            rim_x,
            rim_y,
            // origin
            optical_origin.0,
            optical_origin.1,
            out_x0 as f32,
            out_y0 as f32,
            // rim
            k as f32,
            params.sigma,
            params.depth,
            params.refraction,
            // lens
            params.dispersion,
            params.splay,
            params.intensity,
            box_unit_px,
            // geom
            region.center[0] * rim_scale,
            region.center[1] * rim_scale,
            region.half_size[0] * rim_scale,
            region.half_size[1] * rim_scale,
            // light_box
            params.light[0],
            params.light[1],
            is_box,
            alpha,
            // to_box_x
            to_box_x[0],
            to_box_x[1],
            to_box_x[2],
            to_box_x[3],
            // to_box_y
            to_box_y[0],
            to_box_y[1],
            to_box_y[2],
            to_box_y[3],
            // box_radii
            radii[0],
            radii[1],
            radii[2],
            radii[3],
            // box_smoothing
            smoothing[0],
            smoothing[1],
            smoothing[2],
            smoothing[3],
            // tune_a
            tune.profile,
            params.falloff,
            hairline_px,
            if has_clip_mask { 1.0 } else { 0.0 },
            // tune_b
            tune.front,
            tune.front_start,
            tune.back,
            tune.back_start,
            // tune_c
            tune.shade,
            tune.shade_reach,
            lw as f32,
            lh as f32,
            // Packed height/quad-phase flags, atlas mask origin, and device-per-optical scale.
            (u32::from(self.height_packed) | (((dst_offset.0 & 1) as u32) << 1) | (((dst_offset.1 & 1) as u32) << 2))
                as f32,
            mask_x as f32,
            mask_y as f32,
            divisor / rim_scale,
            native_map[0],
            native_map[1],
            native_map[2],
            native_map[3],
            native_bounds[0],
            native_bounds[1],
            native_bounds[2],
            native_bounds[3],
        ];
        let (sg_idx, sg_off) = self.push_uniform(device, queue, u_glass);
        let clip_view = if has_clip_mask {
            &self.clip_tex.as_ref().expect("clip").view
        } else {
            &self.white_1x1.view
        };
        let group_glass = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: None,
            layout: &self.glass_bgl,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&self.mip_pool[sampled_mip_idx].full_view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Sampler(&self.mip_lin_samp),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::TextureView(self.glass_mask_view(mask_slot.is_some())),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: wgpu::BindingResource::TextureView(&self.low_0.as_ref().expect("low_0").view),
                },
                wgpu::BindGroupEntry {
                    binding: 4,
                    resource: wgpu::BindingResource::TextureView(&self.dst_copy.as_ref().expect("dst_copy").view),
                },
                wgpu::BindGroupEntry {
                    binding: 5,
                    resource: wgpu::BindingResource::TextureView(clip_view),
                },
                wgpu::BindGroupEntry {
                    binding: 6,
                    resource: wgpu::BindingResource::Sampler(&self.lin_samp),
                },
                wgpu::BindGroupEntry {
                    binding: 7,
                    resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                        buffer: &self.slabs[sg_idx],
                        offset: 0,
                        size: wgpu::BufferSize::new(256),
                    }),
                },
                wgpu::BindGroupEntry {
                    binding: 8,
                    resource: wgpu::BindingResource::TextureView(
                        resolve.as_ref().and_then(|r| r.native).unwrap_or(&self.white_1x1.view),
                    ),
                },
            ],
        });
        Self::encode_scissored_pass(
            encoder,
            "reader glass",
            dst_view,
            (out_x0, out_y0, out_w, out_h),
            &self.glass_pipe,
            &group_glass,
            sg_off,
        );
        Ok(())
    }

    /// Preserve the original scope when several blur tiles or glass chunks write
    /// to the same plane that they sample, or compose an inherited reader prefix.
    /// Growable in 64-pixel multiples so varying crop sizes reuse one scratch texture.
    pub fn ensure_blur_source_budgeted(
        &mut self,
        device: &wgpu::Device,
        size: (u32, u32),
        max_bytes: usize,
    ) -> Result<()> {
        let (w, h) = size;
        let max_dim = device.limits().max_texture_dimension_2d;
        if w > max_dim || h > max_dim {
            return Err(EngineError::limit(format!(
                "reader prefix snapshot ({w} x {h} px) exceeds device texture limit ({max_dim} px)"
            )));
        }
        let nw = w.max(1).next_multiple_of(64).min(max_dim);
        let nh = h.max(1).next_multiple_of(64).min(max_dim);
        let reuse = self.blur_source.as_ref().is_some_and(|t| {
            t.width >= w
                && t.height >= h
                && (t.width as usize * t.height as usize) <= (nw as usize * nh as usize * 4).max(1_048_576)
        });
        if reuse {
            return Ok(());
        }
        let freed = self.blur_source.as_ref().map_or(0, PlainTex::bytes);
        let add = nw as usize * nh as usize * 4;
        self.reserve_bytes(add, freed, "reader prefix snapshot", max_bytes)?;
        if let Some(old) = self.blur_source.take() {
            self.retired.push(old.texture);
        }
        self.blur_source = Some(make_plain(
            device,
            nw,
            nh,
            RGBA8,
            4,
            wgpu::TextureUsages::COPY_DST
                | wgpu::TextureUsages::COPY_SRC
                | wgpu::TextureUsages::TEXTURE_BINDING
                | wgpu::TextureUsages::RENDER_ATTACHMENT,
            "reader prefix snapshot",
        ));
        Ok(())
    }

    fn ensure_halo_border_src_budgeted(
        &mut self,
        device: &wgpu::Device,
        size: (u32, u32),
        max_bytes: usize,
    ) -> Result<()> {
        let (w, h) = (size.0.max(1), size.1.max(1));
        let nw = w.next_multiple_of(64);
        let nh = h.next_multiple_of(64);
        let reuse = self.halo_border_src.as_ref().is_some_and(|t| {
            t.width >= w
                && t.height >= h
                && (t.width as usize * t.height as usize) <= (nw as usize * nh as usize * 4).max(262_144)
        });
        if reuse {
            return Ok(());
        }
        let freed = self.halo_border_src.as_ref().map_or(0, PlainTex::bytes);
        let add = nw as usize * nh as usize * 4;
        self.reserve_bytes(add, freed, "reader halo border", max_bytes)?;
        if let Some(old) = self.halo_border_src.take() {
            self.retired.push(old.texture);
        }
        Self::ensure_growable_plain(
            &mut self.halo_border_src,
            device,
            w,
            h,
            RGBA8,
            4,
            wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
            "reader halo border",
        );
        Ok(())
    }

    /// Ensures the growable scratch target `blur_out` (for uniform or progressive blur slices)
    /// is at least `w x h` pixels, checking `max_bytes` before allocating.
    pub fn ensure_blur_out_budgeted(&mut self, device: &wgpu::Device, w: u32, h: u32, max_bytes: usize) -> Result<()> {
        let nw = w.max(1).next_multiple_of(64);
        let nh = h.max(1).next_multiple_of(64);
        let reuse = self.blur_out.as_ref().is_some_and(|t| {
            t.width >= w
                && t.height >= h
                && (t.width as usize * t.height as usize) <= (nw as usize * nh as usize * 4).max(1_048_576)
        });
        if !reuse {
            let freed = self.blur_out.as_ref().map_or(0, PlainTex::bytes);
            let add = nw as usize * nh as usize * 4;
            self.reserve_bytes(add, freed, "reader blur_out", max_bytes)?;
            if let Some(old) = self.blur_out.take() {
                self.retired.push(old.texture);
            }
            Self::ensure_growable_plain(
                &mut self.blur_out,
                device,
                w,
                h,
                RGBA8,
                4,
                wgpu::TextureUsages::RENDER_ATTACHMENT
                    | wgpu::TextureUsages::TEXTURE_BINDING
                    | wgpu::TextureUsages::COPY_SRC,
                "reader blur_out",
            );
        }
        Ok(())
    }

    fn ensure_dst_copy_budgeted(&mut self, device: &wgpu::Device, w: u32, h: u32, max_bytes: usize) -> Result<()> {
        let nw = w.max(1).next_multiple_of(64);
        let nh = h.max(1).next_multiple_of(64);
        let reuse = self.dst_copy.as_ref().is_some_and(|t| {
            t.width >= w
                && t.height >= h
                && (t.width as usize * t.height as usize) <= (nw as usize * nh as usize * 4).max(1_048_576)
        });
        if !reuse {
            let freed = self.dst_copy.as_ref().map_or(0, PlainTex::bytes);
            let add = nw as usize * nh as usize * 4;
            self.reserve_bytes(add, freed, "reader dst_copy", max_bytes)?;
            if let Some(old) = self.dst_copy.take() {
                self.retired.push(old.texture);
            }
            Self::ensure_growable_plain(
                &mut self.dst_copy,
                device,
                w,
                h,
                RGBA8,
                4,
                wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
                "reader dst_copy",
            );
        }
        Ok(())
    }

    #[inline(never)]
    fn copy_to_dst_copy(
        &self,
        encoder: &mut wgpu::CommandEncoder,
        dst_tex: &wgpu::Texture,
        x0: u32,
        y0: u32,
        width: u32,
        height: u32,
    ) {
        encoder.copy_texture_to_texture(
            wgpu::TexelCopyTextureInfo {
                texture: dst_tex,
                mip_level: 0,
                origin: wgpu::Origin3d { x: x0, y: y0, z: 0 },
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyTextureInfo {
                texture: &self.dst_copy.as_ref().expect("dst_copy").texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
        );
    }

    /// Snapshots `dst_tex[dirty]` and composites `blur_out` onto `dst_view` masked by
    /// `mask_tex * clip_tex * alpha` via premultiplied replace.
    #[allow(clippy::too_many_arguments)]
    pub fn encode_bg_blur_composite(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        encoder: &mut wgpu::CommandEncoder,
        dst_tex: &wgpu::Texture,
        dst_view: &wgpu::TextureView,
        dirty: IRect,
        alpha: f32,
        has_clip_mask: bool,
        halo: Option<&BlurHaloSample>,
        max_bytes: usize,
    ) -> Result<()> {
        let bw = (dirty.x1 - dirty.x0) as u32;
        let bh = (dirty.y1 - dirty.y0) as u32;
        if bw == 0 || bh == 0 {
            return Ok(());
        }
        let x0 = dirty.x0 as u32;
        let y0 = dirty.y0 as u32;
        self.ensure_dst_copy_budgeted(device, bw, bh, max_bytes)?;
        self.copy_to_dst_copy(encoder, dst_tex, x0, y0, bw, bh);
        let (map, bound) = if let Some(halo) = halo {
            (
                [halo.offset.0, halo.offset.1, halo.inv, 0.0],
                [halo.size.0 as f32, halo.size.1 as f32, 0.0, 0.0],
            )
        } else {
            ([0.0; 4], [0.0; 4])
        };
        let u_bytes = &[
            x0 as f32,
            y0 as f32,
            alpha,
            if has_clip_mask { 1.0 } else { 0.0 },
            map[0],
            map[1],
            map[2],
            map[3],
            bound[0],
            bound[1],
            bound[2],
            bound[3],
        ];
        let (slab_idx, u_off) = self.push_uniform(device, queue, u_bytes);
        let blurred = halo.map_or_else(|| &self.blur_out.as_ref().expect("blur_out").view, |halo| &halo.view);
        let clip_view = if has_clip_mask {
            &self.clip_tex.as_ref().expect("clip").view
        } else {
            &self.white_1x1.view
        };
        let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: None,
            layout: &self.bg_blur_bgl,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(blurred),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(&self.mask_tex.as_ref().expect("mask").view),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::TextureView(&self.dst_copy.as_ref().expect("dst_copy").view),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: wgpu::BindingResource::TextureView(clip_view),
                },
                wgpu::BindGroupEntry {
                    binding: 4,
                    resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                        buffer: &self.slabs[slab_idx],
                        offset: 0,
                        size: wgpu::BufferSize::new(48),
                    }),
                },
            ],
        });
        Self::encode_scissored_pass(
            encoder,
            "reader bg_blur_comp",
            dst_view,
            (x0, y0, bw, bh),
            &self.bg_blur_pipe,
            &group,
            u_off,
        );
        Ok(())
    }

    /// Prefilters `src_view[crop]` into crop-sized `halo_border_src`, applying exact sub-texel
    /// area weighting along a fractional solid-fill clip frame boundary. Returns
    /// `(view, target_size, crop_origin)` so the caller shifts `clamp_bounds`, `dirty`, and
    /// `dst_origin` by `(-crop_origin.0, -crop_origin.1)`.
    #[allow(clippy::too_many_arguments)]
    pub fn encode_halo_clip_border(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        encoder: &mut wgpu::CommandEncoder,
        src_view: &wgpu::TextureView,
        src_size: (u32, u32),
        crop: IRect,
        clip_rect: [f32; 4],
        border: [f32; 4],
        max_bytes: usize,
    ) -> Result<PrefilteredSource> {
        let crop = crop.clamp(src_size.0 as i32, src_size.1 as i32);
        if crop.is_empty() {
            return Ok(PrefilteredSource {
                view: src_view.clone(),
                size: src_size,
                crop_origin: (0, 0),
            });
        }
        let cw = (crop.x1 - crop.x0) as u32;
        let ch = (crop.y1 - crop.y0) as u32;
        self.ensure_halo_border_src_budgeted(device, (cw, ch), max_bytes)?;
        let max_x = src_size.0.saturating_sub(1) as f32;
        let max_y = src_size.1.saturating_sub(1) as f32;
        let inner_axis = |lo: f32, hi: f32, limit: f32| -> (f32, f32) {
            let a = lo.ceil().clamp(0.0, limit);
            let b = (hi.floor() - 1.0).clamp(0.0, limit);
            if a <= b {
                (a, b)
            } else {
                let p = lo.floor().clamp(0.0, limit);
                (p, p)
            }
        };
        let (ix0, ix1) = inner_axis(clip_rect[0], clip_rect[2], max_x);
        let (iy0, iy1) = inner_axis(clip_rect[1], clip_rect[3], max_y);
        let u_bytes = &[
            clip_rect[0],
            clip_rect[1],
            clip_rect[2],
            clip_rect[3],
            ix0,
            iy0,
            ix1,
            iy1,
            border[0],
            border[1],
            border[2],
            border[3],
            crop.x0 as f32,
            crop.y0 as f32,
            0.0,
            0.0,
        ];
        let (slab_idx, u_off) = self.push_uniform(device, queue, u_bytes);
        let group = self.make_tex_uniform_bg(device, &self.copy_ext_bgl, src_view, slab_idx, 64);
        let target = self.halo_border_src.as_ref().expect("halo_border_src");
        let dst_view = target.view.clone();
        Self::encode_scissored_pass(
            encoder,
            "reader halo_clip_border",
            &dst_view,
            (0, 0, cw, ch),
            &self.halo_clip_border_pipe,
            &group,
            u_off,
        );
        Ok(PrefilteredSource {
            view: dst_view,
            size: (cw, ch),
            crop_origin: (crop.x0, crop.y0),
        })
    }

    #[inline(never)]
    fn make_tex_uniform_bg(
        &self,
        device: &wgpu::Device,
        layout: &wgpu::BindGroupLayout,
        src_view: &wgpu::TextureView,
        slab_idx: usize,
        size: u64,
    ) -> wgpu::BindGroup {
        device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: None,
            layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(src_view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                        buffer: &self.slabs[slab_idx],
                        offset: 0,
                        size: wgpu::BufferSize::new(size),
                    }),
                },
            ],
        })
    }

    #[allow(clippy::too_many_arguments)]
    #[inline(never)]
    fn encode_fullscreen_pass(
        encoder: &mut wgpu::CommandEncoder,
        label: &str,
        dst_view: &wgpu::TextureView,
        load: wgpu::LoadOp<wgpu::Color>,
        scissor: Option<(u32, u32, u32, u32)>,
        pipeline: &wgpu::RenderPipeline,
        group: &wgpu::BindGroup,
        u_off: Option<u32>,
    ) {
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some(label),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: dst_view,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations {
                    load,
                    store: wgpu::StoreOp::Store,
                },
            })],
            ..Default::default()
        });
        if let Some((x, y, w, h)) = scissor {
            pass.set_scissor_rect(x, y, w, h);
        }
        pass.set_pipeline(pipeline);
        match u_off {
            Some(off) => pass.set_bind_group(0, group, &[off]),
            None => pass.set_bind_group(0, group, &[]),
        }
        pass.draw(0..3, 0..1);
    }

    #[allow(clippy::too_many_arguments)]
    fn encode_scissored_pass(
        encoder: &mut wgpu::CommandEncoder,
        label: &str,
        dst_view: &wgpu::TextureView,
        scissor: (u32, u32, u32, u32),
        pipeline: &wgpu::RenderPipeline,
        group: &wgpu::BindGroup,
        u_off: u32,
    ) {
        Self::encode_fullscreen_pass(
            encoder,
            label,
            dst_view,
            wgpu::LoadOp::Load,
            Some(scissor),
            pipeline,
            group,
            Some(u_off),
        );
    }

    /// Prefilters `src_view[crop]` into crop-sized `halo_border_src`, replacing straddling and
    /// outside-clamped texels along an unfilled `EdgeMode::Clamp` clip frame using exact
    /// device-aligned edge strips.
    #[allow(clippy::too_many_arguments)]
    pub fn encode_halo_clip_clamp(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        encoder: &mut wgpu::CommandEncoder,
        src_view: &wgpu::TextureView,
        src_size: (u32, u32),
        crop: IRect,
        edges: &HaloClampEdges<'_>,
        max_bytes: usize,
    ) -> Result<PrefilteredSource> {
        if crop.is_empty() {
            return Ok(PrefilteredSource {
                view: src_view.clone(),
                size: src_size,
                crop_origin: (0, 0),
            });
        }
        let cw = (crop.x1 - crop.x0) as u32;
        let ch = (crop.y1 - crop.y0) as u32;
        self.ensure_halo_border_src_budgeted(device, (cw, ch), max_bytes)?;
        let pack_edge = |edge: Option<&HaloClampEdge<'_>>, inactive: f32| -> (f32, [f32; 4], [f32; 4]) {
            match edge {
                Some(e) => (
                    e.straddle as f32,
                    [
                        e.clamp_weight,
                        e.size.0 as f32,
                        e.size.1 as f32,
                        e.samples_per_texel as f32,
                    ],
                    [e.axis_offset, 0.0, 0.0, 0.0],
                ),
                None => (inactive, [0.0, 1.0, 1.0, 1.0], [0.0; 4]),
            }
        };
        let (tx_l, la, lb) = pack_edge(edges.left.as_ref(), -1e7);
        let (tx_r, ra, rb) = pack_edge(edges.right.as_ref(), 1e7);
        let (ty_t, ta, tb) = pack_edge(edges.top.as_ref(), -1e7);
        let (ty_b, ba, bb) = pack_edge(edges.bottom.as_ref(), 1e7);
        let u_bytes = &[
            crop.x0 as f32,
            crop.y0 as f32,
            src_size.0.saturating_sub(1) as f32,
            src_size.1.saturating_sub(1) as f32,
            tx_l,
            ty_t,
            tx_r,
            ty_b,
            la[0],
            la[1],
            la[2],
            la[3],
            lb[0],
            lb[1],
            lb[2],
            lb[3],
            ra[0],
            ra[1],
            ra[2],
            ra[3],
            rb[0],
            rb[1],
            rb[2],
            rb[3],
            ta[0],
            ta[1],
            ta[2],
            ta[3],
            tb[0],
            tb[1],
            tb[2],
            tb[3],
            ba[0],
            ba[1],
            ba[2],
            ba[3],
            bb[0],
            bb[1],
            bb[2],
            bb[3],
        ];
        let (slab_idx, u_off) = self.push_uniform(device, queue, u_bytes);
        let white_view = &self.white_1x1.view;
        let left_view = edges.left.as_ref().map_or(white_view, |e| e.view);
        let right_view = edges.right.as_ref().map_or(white_view, |e| e.view);
        let top_view = edges.top.as_ref().map_or(white_view, |e| e.view);
        let bot_view = edges.bottom.as_ref().map_or(white_view, |e| e.view);
        let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: None,
            layout: &self.halo_clip_clamp_bgl,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(src_view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(left_view),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::TextureView(right_view),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: wgpu::BindingResource::TextureView(top_view),
                },
                wgpu::BindGroupEntry {
                    binding: 4,
                    resource: wgpu::BindingResource::TextureView(bot_view),
                },
                wgpu::BindGroupEntry {
                    binding: 5,
                    resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                        buffer: &self.slabs[slab_idx],
                        offset: 0,
                        size: wgpu::BufferSize::new(160),
                    }),
                },
            ],
        });
        let target = self.halo_border_src.as_ref().expect("halo_border_src");
        let dst_view = target.view.clone();
        Self::encode_scissored_pass(
            encoder,
            "reader halo_clip_clamp",
            &dst_view,
            (0, 0, cw, ch),
            &self.halo_clip_clamp_pipe,
            &group,
            u_off,
        );
        Ok(PrefilteredSource {
            view: dst_view,
            size: (cw, ch),
            crop_origin: (crop.x0, crop.y0),
        })
    }

    /// Box-downsamples a region of `src_view` into `dst_view` scissored to `scissor`, used when a
    /// mid-tier glass lens patches the overlapping sub-region of an existing far-tier glass prefix.
    #[allow(clippy::too_many_arguments)]
    pub fn encode_downsample_rect(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        encoder: &mut wgpu::CommandEncoder,
        src_view: &wgpu::TextureView,
        src_size: (u32, u32),
        dst_view: &wgpu::TextureView,
        scissor: (u32, u32, u32, u32),
        src_origin: (f32, f32),
        ratio: u32,
    ) {
        if scissor.2 == 0 || scissor.3 == 0 {
            return;
        }
        let scale = ratio.max(1) as f32;
        let u_bytes = &[
            src_origin.0,
            src_origin.1,
            scale,
            scale,
            src_size.0 as f32,
            src_size.1 as f32,
            scale,
            0.0,
        ];
        let (slab_idx, u_off) = self.push_uniform(device, queue, u_bytes);
        let group = self.make_tex_uniform_bg(device, &self.blur_bgl, src_view, slab_idx, 32);
        Self::encode_scissored_pass(
            encoder,
            "reader downsample_rect",
            dst_view,
            scissor,
            &self.downsample_rect_pipe,
            &group,
            u_off,
        );
    }

    /// Snapshots `dst_tex[tile]` and blends bracketing progressive blur slices from `blur_out`
    /// onto `dst_view` masked by `mask_tex * clip_tex * alpha`.
    #[allow(clippy::too_many_arguments)]
    pub fn encode_progressive_composite(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        encoder: &mut wgpu::CommandEncoder,
        dst_tex: &wgpu::Texture,
        dst_view: &wgpu::TextureView,
        tile: IRect,
        dirty: IRect,
        frame_origin: (i32, i32),
        plan: &ProgressivePlan,
        atlas_cols: u32,
        alpha: f32,
        has_clip_mask: bool,
        halo: Option<&ProgressiveHaloSample>,
        halo_far: Option<&ProgressiveHaloSample>,
        max_bytes: usize,
    ) -> Result<()> {
        let tw = (tile.x1 - tile.x0) as u32;
        let th = (tile.y1 - tile.y0) as u32;
        if tw == 0 || th == 0 {
            return Ok(());
        }
        let x0 = tile.x0 as u32;
        let y0 = tile.y0 as u32;
        self.ensure_dst_copy_budgeted(device, tw, th, max_bytes)?;
        self.copy_to_dst_copy(encoder, dst_tex, x0, y0, tw, th);
        let stops = plan.padded_stops();
        let pack_halo = |h: Option<&ProgressiveHaloSample>| {
            h.map_or(([0.0; 4], [0.0; 4]), |halo| {
                (
                    [
                        halo.sample.offset.0,
                        halo.sample.offset.1,
                        halo.sample.inv,
                        halo.first as f32,
                    ],
                    [halo.cell_size.0 as f32, halo.cell_size.1 as f32, halo.cols as f32, 0.0],
                )
            })
        };
        let (halo_map, halo_atlas) = pack_halo(halo);
        let (halo2_map, halo2_atlas) = pack_halo(halo_far);
        let u_bytes = &[
            // tile
            x0 as f32,
            y0 as f32,
            tw as f32,
            th as f32,
            // mask_info
            (tile.x0 - dirty.x0) as f32,
            (tile.y0 - dirty.y0) as f32,
            alpha,
            if has_clip_mask { 1.0 } else { 0.0 },
            // Gradient coordinates are relative to the frame, not the isolation.
            plan.start[0],
            plan.start[1],
            plan.dir_inv_len2[0],
            plan.dir_inv_len2[1],
            // params
            plan.start_sigma,
            plan.end_sigma,
            plan.stops.len() as f32,
            atlas_cols as f32,
            // stops0..2
            stops[0],
            stops[1],
            stops[2],
            stops[3],
            stops[4],
            stops[5],
            stops[6],
            stops[7],
            stops[8],
            stops[9],
            stops[10],
            stops[11],
            frame_origin.0 as f32,
            frame_origin.1 as f32,
            0.0,
            0.0,
            halo_map[0],
            halo_map[1],
            halo_map[2],
            halo_map[3],
            halo_atlas[0],
            halo_atlas[1],
            halo_atlas[2],
            halo_atlas[3],
            halo2_map[0],
            halo2_map[1],
            halo2_map[2],
            halo2_map[3],
            halo2_atlas[0],
            halo2_atlas[1],
            halo2_atlas[2],
            halo2_atlas[3],
        ];
        let (slab_idx, u_off) = self.push_uniform(device, queue, u_bytes);
        let clip_view = if has_clip_mask {
            &self.clip_tex.as_ref().expect("clip").view
        } else {
            &self.white_1x1.view
        };
        let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: None,
            layout: &self.prog_blur_bgl,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(
                        self.blur_out.as_ref().map_or(&self.white_1x1.view, |b| &b.view),
                    ),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(&self.mask_tex.as_ref().expect("mask").view),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::TextureView(&self.dst_copy.as_ref().expect("dst_copy").view),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: wgpu::BindingResource::TextureView(clip_view),
                },
                wgpu::BindGroupEntry {
                    binding: 4,
                    resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                        buffer: &self.slabs[slab_idx],
                        offset: 0,
                        size: wgpu::BufferSize::new(192),
                    }),
                },
                wgpu::BindGroupEntry {
                    binding: 5,
                    resource: wgpu::BindingResource::TextureView(
                        halo.map_or(&self.white_1x1.view, |halo| &halo.sample.view),
                    ),
                },
                wgpu::BindGroupEntry {
                    binding: 6,
                    resource: wgpu::BindingResource::TextureView(
                        halo_far.map_or(&self.white_1x1.view, |halo| &halo.sample.view),
                    ),
                },
            ],
        });
        Self::encode_scissored_pass(
            encoder,
            "reader prog_blur",
            dst_view,
            (x0, y0, tw, th),
            &self.prog_blur_pipe,
            &group,
            u_off,
        );
        Ok(())
    }

    /// Interactive coarse background blur (mip-sampled stand-in) masked by `analytic_coarse` or
    /// `mask_tex`, times `clip_tex * alpha`.
    #[allow(clippy::too_many_arguments)]
    pub fn encode_coarse_blur<'a>(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        encoder: &mut wgpu::CommandEncoder,
        backdrop_view: &wgpu::TextureView,
        targets: impl Iterator<Item = (&'a wgpu::Texture, &'a wgpu::TextureView)>,
        tex_size: (u32, u32),
        frame_size: (i32, i32),
        offset: (i32, i32),
        frame_dirty_origin: (i32, i32),
        backdrop_gen: u64,
        backdrop_is_frame: bool,
        dirty: IRect,
        sigma: f32,
        within: Option<ClipWithin>,
        alpha: f32,
        analytic_coarse: Option<CoarseAnalytic>,
        has_clip_mask: bool,
        max_bytes: usize,
    ) -> Result<()> {
        let bw = (dirty.x1 - dirty.x0) as u32;
        let bh = (dirty.y1 - dirty.y0) as u32;
        if bw == 0 || bh == 0 {
            return Ok(());
        }
        let x0 = dirty.x0 as u32;
        let y0 = dirty.y0 as u32;
        self.ensure_dst_copy_budgeted(device, bw, bh, max_bytes)?;
        let use_shared = backdrop_is_frame
            && within.is_none()
            && offset == (0, 0)
            && tex_size.0 as i32 == frame_size.0
            && tex_size.1 as i32 == frame_size.1;
        let (uv_ox, uv_oy, inv_bw, inv_bh, max_mip, region_idx) = if use_shared {
            self.ensure_shared_coarse_mips(device, encoder, backdrop_view, tex_size, backdrop_gen, max_bytes)?;
            let mips = self.shared_coarse_mips.as_ref().expect("shared");
            (
                frame_dirty_origin.0 as f32,
                frame_dirty_origin.1 as f32,
                1.0 / (tex_size.0 as f32),
                1.0 / (tex_size.1 as f32),
                (mips.mip_views.len() - 1) as f32,
                None,
            )
        } else {
            let region = GlassRegion {
                x0: frame_dirty_origin.0,
                y0: frame_dirty_origin.1,
                rw: bw,
                rh: bh,
                out_x0: dirty.x0,
                out_y0: dirty.y0,
                out_x1: dirty.x1,
                out_y1: dirty.y1,
                center: [0.0, 0.0],
                half_size: [1.0, 1.0],
                box_geom: None,
            };
            let idx = self.encode_copy_extended_and_mips(
                device,
                queue,
                encoder,
                backdrop_view,
                (tex_size.0 as i32, tex_size.1 as i32),
                frame_size,
                offset,
                &region,
                within,
                u32::MAX,
                max_bytes,
            )?;
            let m = &self.mip_pool[idx];
            (
                0.0,
                0.0,
                1.0 / (m.width as f32),
                1.0 / (m.height as f32),
                (m.mip_views.len() - 1) as f32,
                Some(idx),
            )
        };
        let base_lod = if use_shared { 1.0 } else { 0.0 };
        let lod = ((sigma * 1.5).max(1.0).log2() - base_lod).clamp(0.0, max_mip);
        let (mask_mode, unit_px, to_box_x, to_box_y, radii, smoothing) = match analytic_coarse {
            Some(ca) => (
                f32::from(ca.mode),
                ca.unit_px,
                [ca.to_box[0], ca.to_box[2], ca.to_box[4], ca.size[0]],
                [ca.to_box[1], ca.to_box[3], ca.to_box[5], ca.size[1]],
                ca.radii,
                ca.smoothing,
            ),
            None => (0.0, 0.0, [0.0; 4], [0.0; 4], [0.0; 4], [0.0; 4]),
        };
        // Matches 128-byte CoarseU in readers.wgsl.
        let u_bytes = &[
            bw as f32,
            bh as f32,
            lod,
            alpha,
            x0 as f32,
            y0 as f32,
            x0 as f32,
            y0 as f32,
            if has_clip_mask { 1.0 } else { 0.0 },
            mask_mode,
            unit_px,
            0.0,
            uv_ox,
            uv_oy,
            inv_bw,
            inv_bh,
            to_box_x[0],
            to_box_x[1],
            to_box_x[2],
            to_box_x[3],
            to_box_y[0],
            to_box_y[1],
            to_box_y[2],
            to_box_y[3],
            radii[0],
            radii[1],
            radii[2],
            radii[3],
            smoothing[0],
            smoothing[1],
            smoothing[2],
            smoothing[3],
        ];
        let (slab_idx, u_off) = self.push_uniform(device, queue, u_bytes);
        let b_view = match region_idx {
            Some(i) => &self.mip_pool[i].full_view,
            None => &self.shared_coarse_mips.as_ref().expect("shared").full_view,
        };
        let mask_view = if analytic_coarse.is_some() {
            &self.white_1x1.view
        } else {
            &self.mask_tex.as_ref().expect("mask").view
        };
        let clip_view = if has_clip_mask {
            &self.clip_tex.as_ref().expect("clip").view
        } else {
            &self.white_1x1.view
        };
        let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: None,
            layout: &self.coarse_bgl,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(b_view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Sampler(&self.mip_lin_samp),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::TextureView(mask_view),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: wgpu::BindingResource::TextureView(&self.dst_copy.as_ref().expect("dst_copy").view),
                },
                wgpu::BindGroupEntry {
                    binding: 4,
                    resource: wgpu::BindingResource::TextureView(clip_view),
                },
                wgpu::BindGroupEntry {
                    binding: 5,
                    resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                        buffer: &self.slabs[slab_idx],
                        offset: 0,
                        size: wgpu::BufferSize::new(128),
                    }),
                },
            ],
        });
        for (dst_tex, dst_view) in targets {
            self.copy_to_dst_copy(encoder, dst_tex, x0, y0, bw, bh);
            Self::encode_scissored_pass(
                encoder,
                "reader coarse_blur",
                dst_view,
                (x0, y0, bw, bh),
                &self.coarse_pipe,
                &group,
                u_off,
            );
        }
        Ok(())
    }
}
