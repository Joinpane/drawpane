//! GPU backdrop-reader pipelines, texture pools, and pass encoders (`readers.wgsl`).
//!
//! Pure fragment pipelines with 256-byte-aligned dynamic uniform slabs so every pass for a glass
//! layer (copy-extended, mipmaps, mask downsample, separable height blur, frost + mips, final
//! refraction + premultiplied replace) records into a single `CommandEncoder`.

use crate::error::{EngineError, Result};
use crate::glass::{self, ClipWithin, DEFAULT_GLASS_TUNING, GlassParams, GlassRegion};
use vello_gpu::{RenderSize, Renderer};

const SHADER: &str = include_str!("readers.wgsl");
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
pub struct MipTex {
    pub texture: wgpu::Texture,
    pub full_view: wgpu::TextureView,
    pub mip_views: Vec<wgpu::TextureView>,
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

    fn new(device: &wgpu::Device, width: u32, height: u32, max_mips: u32, label: &str, used: u64) -> Self {
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
        Self {
            texture,
            full_view,
            mip_views,
            width: w,
            height: h,
            bytes,
            used,
        }
    }
}

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

    // Pipelines
    copy_ext_pipe: wgpu::RenderPipeline,
    mip_pipe: wgpu::RenderPipeline,
    down_pipe: wgpu::RenderPipeline,
    blur_x_pipe: wgpu::RenderPipeline,
    blur_y_pipe: wgpu::RenderPipeline,
    frost_pipe: wgpu::RenderPipeline,
    glass_pipe: wgpu::RenderPipeline,
    coarse_pipe: wgpu::RenderPipeline,
    comp_pipe: wgpu::RenderPipeline,
    lerp_pipe: wgpu::RenderPipeline,

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
    pub clip_tex: Option<VelloTex>,
    dst_copy: Option<PlainTex>,
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
            targets: &[Some(wgpu::ColorTargetState {
                format,
                blend,
                write_mask: wgpu::ColorWrites::ALL,
            })],
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

fn floats_to_bytes(vals: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(vals.len() * 4);
    for &v in vals {
        out.extend_from_slice(&v.to_le_bytes());
    }
    out
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
                uni_binding(7, 224),
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
            copy_ext_pipe,
            mip_pipe,
            down_pipe,
            blur_x_pipe,
            blur_y_pipe,
            frost_pipe,
            glass_pipe,
            coarse_pipe,
            comp_pipe,
            lerp_pipe,
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
            clip_tex: None,
            dst_copy: None,
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
        if let Some(t) = &self.clip_tex {
            total += t.bytes();
        }
        if let Some(t) = &self.dst_copy {
            total += t.bytes();
        }
        total
    }

    pub fn begin_frame(&mut self) {
        self.slab_idx = 0;
        self.slab_slot = 0;
    }

    pub fn clear_frame_targets(&mut self) {
        self.backdrop_frame = None;
        self.delta_frame = None;
        self.shared_coarse_mips = None;
        self.shared_coarse_key = None;
    }

    /// Drops all cached reader frame targets and scratch pools (called when a frame has no readers).
    pub fn evict_frame_scratch(&mut self) {
        self.clear_frame_targets();
        self.mip_pool.clear();
        self.frosted_tmp = None;
        self.low_0 = None;
        self.low_1 = None;
        self.mask_tex = None;
        self.clip_tex = None;
        self.dst_copy = None;
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
            Self::ensure_vello_tex(slot, device, renderer, w, h, label);
        }
        Ok(())
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
        w: u32,
        h: u32,
        avoid: Option<usize>,
        label: &str,
        max_bytes: usize,
    ) -> Result<usize> {
        self.pool_tick += 1;
        let tick = self.pool_tick;
        if let Some(idx) = self
            .mip_pool
            .iter()
            .enumerate()
            .position(|(i, t)| Some(i) != avoid && t.width == w && t.height == h)
        {
            self.mip_pool[idx].used = tick;
            return Ok(idx);
        }
        let add = MipTex::estimate_bytes(w, h, u32::MAX);
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
            self.mip_pool.clear();
            if let Some(t) = keep {
                self.mip_pool.push(t);
            }
            victim = None;
            freed = 0;
        }
        self.reserve_bytes(add, freed, label, max_bytes)?;
        let tex = MipTex::new(device, w, h, u32::MAX, label, tick);
        if let Some(v) = victim {
            self.mip_pool[v] = tex;
            Ok(v)
        } else {
            self.mip_pool.push(tex);
            Ok(self.mip_pool.len() - 1)
        }
    }

    fn push_uniform(&mut self, device: &wgpu::Device, queue: &wgpu::Queue, bytes: &[u8]) -> (usize, u32) {
        if self.slabs.is_empty() {
            self.slabs.push(Self::make_slab(device, self.uniform_align));
        }
        if self.slab_slot >= SLAB_SLOTS {
            self.slab_idx += 1;
            self.slab_slot = 0;
            if self.slab_idx >= self.slabs.len() {
                self.slabs.push(Self::make_slab(device, self.uniform_align));
            }
        }
        let offset = self.slab_slot * self.uniform_align;
        self.slab_slot += 1;
        queue.write_buffer(&self.slabs[self.slab_idx], u64::from(offset), bytes);
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
        dst_view: &wgpu::TextureView,
        dst_origin: (i32, i32),
        scissor: (u32, u32, u32, u32),
        opacity: f32,
        lerp: bool,
    ) {
        let opacity = opacity.clamp(0.0, 1.0);
        let source_scale = if lerp { 1.0 } else { opacity };
        let data = floats_to_bytes(&[source_scale, dst_origin.0 as f32, dst_origin.1 as f32, 0.0]);
        let (slab_idx, offset) = self.push_uniform(device, queue, &data);
        let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: None,
            layout: &self.comp_bgl,
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
                        size: wgpu::BufferSize::new(16),
                    }),
                },
            ],
        });
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("scope composite"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: dst_view,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Load,
                    store: wgpu::StoreOp::Store,
                },
            })],
            ..Default::default()
        });
        if lerp {
            let opacity = f64::from(opacity);
            pass.set_pipeline(&self.lerp_pipe);
            pass.set_blend_constant(wgpu::Color {
                r: opacity,
                g: opacity,
                b: opacity,
                a: opacity,
            });
        } else {
            pass.set_pipeline(&self.comp_pipe);
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

    fn encode_build_mipmaps(
        &self,
        device: &wgpu::Device,
        encoder: &mut wgpu::CommandEncoder,
        mip_views: &[wgpu::TextureView],
    ) {
        for level in 1..mip_views.len() {
            let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: None,
                layout: &self.mip_bgl,
                entries: &[wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&mip_views[level - 1]),
                }],
            });
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("reader mip_down"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &mip_views[level],
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                ..Default::default()
            });
            pass.set_pipeline(&self.mip_pipe);
            pass.set_bind_group(0, &group, &[]);
            pass.draw(0..3, 0..1);
        }
    }

    /// Ensures `shared_coarse_mips` holds an up-to-date mipmap chain (capped at `COARSE_MAX_MIPS`
    /// levels) of `src_tex` for `(backdrop_gen, w, h)`.
    #[allow(clippy::too_many_arguments)]
    fn ensure_shared_coarse_mips(
        &mut self,
        device: &wgpu::Device,
        encoder: &mut wgpu::CommandEncoder,
        src_tex: &wgpu::Texture,
        w: u32,
        h: u32,
        backdrop_gen: u64,
        max_bytes: usize,
    ) -> Result<()> {
        let key = (backdrop_gen, w, h);
        if self.shared_coarse_key == Some(key) && self.shared_coarse_mips.is_some() {
            return Ok(());
        }
        let reuse = self
            .shared_coarse_mips
            .as_ref()
            .is_some_and(|t| t.width == w && t.height == h);
        if !reuse {
            let freed = self.shared_coarse_mips.as_ref().map_or(0, |t| t.bytes);
            let add = MipTex::estimate_bytes(w, h, COARSE_MAX_MIPS);
            self.reserve_bytes(add, freed, "shared coarse backdrop", max_bytes)?;
            self.shared_coarse_mips = Some(MipTex::new(device, w, h, COARSE_MAX_MIPS, "shared coarse backdrop", 0));
        }
        let mips = self.shared_coarse_mips.as_ref().expect("just created");
        encoder.copy_texture_to_texture(
            wgpu::TexelCopyTextureInfo {
                texture: src_tex,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyTextureInfo {
                texture: &mips.texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::Extent3d {
                width: w,
                height: h,
                depth_or_array_layers: 1,
            },
        );
        self.encode_build_mipmaps(device, encoder, &mips.mip_views);
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
        max_bytes: usize,
    ) -> Result<usize> {
        let idx = self.acquire_mip_tex(device, region.rw, region.rh, None, "reader region backdrop", max_bytes)?;
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
        let u_bytes = floats_to_bytes(&[
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
        ]);
        let (slab_idx, u_off) = self.push_uniform(device, queue, &u_bytes);
        let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: None,
            layout: &self.copy_ext_bgl,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(backdrop_view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                        buffer: &self.slabs[slab_idx],
                        offset: 0,
                        size: wgpu::BufferSize::new(64),
                    }),
                },
            ],
        });
        {
            let dst_view = &self.mip_pool[idx].mip_views[0];
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("reader copy_ext"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: dst_view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                ..Default::default()
            });
            pass.set_pipeline(&self.copy_ext_pipe);
            pass.set_bind_group(0, &group, &[u_off]);
            pass.draw(0..3, 0..1);
        }
        self.encode_build_mipmaps(device, encoder, &self.mip_pool[idx].mip_views);
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
        backdrop_tex: &wgpu::Texture,
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
        has_clip_mask: bool,
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
        encoder.copy_texture_to_texture(
            wgpu::TexelCopyTextureInfo {
                texture: dst_tex,
                mip_level: 0,
                origin: wgpu::Origin3d {
                    x: out_x0,
                    y: out_y0,
                    z: 0,
                },
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyTextureInfo {
                texture: &self.dst_copy.as_ref().expect("dst_copy").texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::Extent3d {
                width: out_w,
                height: out_h,
                depth_or_array_layers: 1,
            },
        );

        let mask_x0 = (region.x0 + dst_offset.0) as f32;
        let mask_y0 = (region.y0 + dst_offset.1) as f32;

        if coarse {
            // Fast interactive coarse stand-in: share one tile/frame mipmap (<= 5 levels) across
            // all unclipped glass cards on the same backdrop generation (zero per-card copy_extended/mipmaps).
            let use_shared = backdrop_is_frame && within.is_none() && source_offset == (0, 0);
            let (uv_ox, uv_oy, inv_bw, inv_bh, max_mip, region_idx) = if use_shared {
                self.ensure_shared_coarse_mips(
                    device,
                    encoder,
                    backdrop_tex,
                    tex_size.0,
                    tex_size.1,
                    backdrop_gen,
                    max_bytes,
                )?;
                let mips = self.shared_coarse_mips.as_ref().expect("shared");
                (
                    (region.x0 + source_offset.0) as f32,
                    (region.y0 + source_offset.1) as f32,
                    1.0 / (mips.width as f32),
                    1.0 / (mips.height as f32),
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
            let lod = (sigma * 1.5).max(1.0).log2().min(max_mip);
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
            let u_bytes = floats_to_bytes(&[
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
            ]);
            let (slab_idx, u_off) = self.push_uniform(device, queue, &u_bytes);
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
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("reader glass_coarse"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: dst_view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Load,
                        store: wgpu::StoreOp::Store,
                    },
                })],
                ..Default::default()
            });
            pass.set_scissor_rect(out_x0, out_y0, out_w, out_h);
            pass.set_pipeline(&self.coarse_pipe);
            pass.set_bind_group(0, &group, &[u_off]);
            pass.draw(0..3, 0..1);
            return Ok(());
        }

        // Exact glass pipeline:
        // 1. Copy extended backdrop + build mipmap chain.
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
            max_bytes,
        )?;

        // 2. Optional mip-assisted frost pass (exact port of glass.ts / frost_cpu).
        let sampled_mip_idx = if params.frost > 0.4 {
            let max_lvl = (self.mip_pool[base_mip_idx].mip_views.len() - 1) as u32;
            let fp = glass::frost_params(params.frost, region.rw, region.rh, max_lvl);
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
                Self::ensure_frame_tex(&mut self.frosted_tmp, device, fp.fw, fp.fh, "reader frosted_tmp");
            }
            let frosted_idx =
                self.acquire_mip_tex(device, fp.fw, fp.fh, Some(base_mip_idx), "reader frosted", max_bytes)?;

            // Horizontal pass: base_mip -> frosted_tmp
            let u_h = floats_to_bytes(&[
                fp.fw as f32,
                fp.fh as f32,
                1.0,
                0.0,
                fp.level as f32,
                fp.left,
                fp.radius as f32,
                0.0,
            ]);
            let (sh_idx, sh_off) = self.push_uniform(device, queue, &u_h);
            let group_h = device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: None,
                layout: &self.frost_bgl,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: wgpu::BindingResource::TextureView(&self.mip_pool[base_mip_idx].full_view),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                            buffer: &self.slabs[sh_idx],
                            offset: 0,
                            size: wgpu::BufferSize::new(32),
                        }),
                    },
                ],
            });
            {
                let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: Some("reader frost_h"),
                    color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                        view: &self.frosted_tmp.as_ref().expect("frosted_tmp").view,
                        depth_slice: None,
                        resolve_target: None,
                        ops: wgpu::Operations {
                            load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                            store: wgpu::StoreOp::Store,
                        },
                    })],
                    ..Default::default()
                });
                pass.set_pipeline(&self.frost_pipe);
                pass.set_bind_group(0, &group_h, &[sh_off]);
                pass.draw(0..3, 0..1);
            }

            // Vertical pass: frosted_tmp -> frosted[0]
            let u_v = floats_to_bytes(&[
                fp.fw as f32,
                fp.fh as f32,
                0.0,
                1.0,
                0.0,
                fp.left,
                fp.radius as f32,
                0.0,
            ]);
            let (sv_idx, sv_off) = self.push_uniform(device, queue, &u_v);
            let group_v = device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: None,
                layout: &self.frost_bgl,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: wgpu::BindingResource::TextureView(&self.frosted_tmp.as_ref().expect("ft").view),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                            buffer: &self.slabs[sv_idx],
                            offset: 0,
                            size: wgpu::BufferSize::new(32),
                        }),
                    },
                ],
            });
            {
                let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: Some("reader frost_v"),
                    color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                        view: &self.mip_pool[frosted_idx].mip_views[0],
                        depth_slice: None,
                        resolve_target: None,
                        ops: wgpu::Operations {
                            load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                            store: wgpu::StoreOp::Store,
                        },
                    })],
                    ..Default::default()
                });
                pass.set_pipeline(&self.frost_pipe);
                pass.set_bind_group(0, &group_v, &[sv_off]);
                pass.draw(0..3, 0..1);
            }
            self.encode_build_mipmaps(device, encoder, &self.mip_pool[frosted_idx].mip_views);
            frosted_idx
        } else {
            base_mip_idx
        };

        // 3. Rim height field: downsample mask by k x k, then separable blur_x + blur_y.
        let k = glass::height_scale(params.sigma);
        let lw = region.rw.div_ceil(k);
        let lh = region.rh.div_ceil(k);
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

        // Downsample mask -> low_0
        let u_down = floats_to_bytes(&[region.rw as f32, region.rh as f32, k as f32, 0.0]);
        let (sd_idx, sd_off) = self.push_uniform(device, queue, &u_down);
        let group_down = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: None,
            layout: &self.down_bgl,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&self.mask_tex.as_ref().expect("mask").view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                        buffer: &self.slabs[sd_idx],
                        offset: 0,
                        size: wgpu::BufferSize::new(16),
                    }),
                },
            ],
        });
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("reader down"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &self.low_0.as_ref().expect("low_0").view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                ..Default::default()
            });
            pass.set_scissor_rect(0, 0, lw, lh);
            pass.set_pipeline(&self.down_pipe);
            pass.set_bind_group(0, &group_down, &[sd_off]);
            pass.draw(0..3, 0..1);
        }

        let sigma_low = params.sigma / (k as f32);
        let blur_radius = (sigma_low * 3.0).ceil().min(64.0);
        let packed_flag = if self.height_packed { 1.0 } else { 0.0 };
        let u_blur = floats_to_bytes(&[lw as f32, lh as f32, sigma_low, blur_radius, packed_flag, 0.0, 0.0, 0.0]);
        let (sb_idx, sb_off) = self.push_uniform(device, queue, &u_blur);

        // blur_x: low_0 -> low_1
        let group_bx = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: None,
            layout: &self.blur_bgl,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&self.low_0.as_ref().expect("low_0").view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                        buffer: &self.slabs[sb_idx],
                        offset: 0,
                        size: wgpu::BufferSize::new(32),
                    }),
                },
            ],
        });
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("reader blur_x"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &self.low_1.as_ref().expect("low_1").view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                ..Default::default()
            });
            pass.set_scissor_rect(0, 0, lw, lh);
            pass.set_pipeline(&self.blur_x_pipe);
            pass.set_bind_group(0, &group_bx, &[sb_off]);
            pass.draw(0..3, 0..1);
        }

        // blur_y: low_1 -> low_0
        let group_by = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: None,
            layout: &self.blur_bgl,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&self.low_1.as_ref().expect("low_1").view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                        buffer: &self.slabs[sb_idx],
                        offset: 0,
                        size: wgpu::BufferSize::new(32),
                    }),
                },
            ],
        });
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("reader blur_y"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &self.low_0.as_ref().expect("low_0").view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                ..Default::default()
            });
            pass.set_scissor_rect(0, 0, lw, lh);
            pass.set_pipeline(&self.blur_y_pipe);
            pass.set_bind_group(0, &group_by, &[sb_off]);
            pass.draw(0..3, 0..1);
        }

        // 4. Final glass refraction, dispersion, splay, lighting, and premultiplied replace.
        let low_tex = self.low_0.as_ref().expect("low_0");
        let low_tw = low_tex.width as f32;
        let low_th = low_tex.height as f32;
        let tune = DEFAULT_GLASS_TUNING;
        let (is_box, to_box_x, to_box_y, radii, smoothing, box_unit_px) = match region.box_geom {
            Some(ref bg) => (
                1.0f32,
                [bg.to_box[0], bg.to_box[2], bg.to_box[4], bg.size[0]],
                [bg.to_box[1], bg.to_box[3], bg.to_box[5], bg.size[1]],
                bg.radii,
                bg.smoothing,
                bg.unit_px,
            ),
            None => (0.0, [0.0; 4], [0.0; 4], [0.0; 4], [0.0; 4], params.unit_px),
        };
        let hairline_px = (tune.hairline * params.unit_px).max(1e-3);
        let u_glass = floats_to_bytes(&[
            // sizes
            region.rw as f32,
            region.rh as f32,
            low_tw,
            low_th,
            // origin
            mask_x0,
            mask_y0,
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
            region.center[0],
            region.center[1],
            region.half_size[0],
            region.half_size[1],
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
            // Height packing and frame-relative fragment quad phase.
            packed_flag,
            (dst_offset.0 & 1) as f32,
            (dst_offset.1 & 1) as f32,
            0.0,
        ]);
        let (sg_idx, sg_off) = self.push_uniform(device, queue, &u_glass);
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
                    resource: wgpu::BindingResource::TextureView(&self.mask_tex.as_ref().expect("mask").view),
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
                        size: wgpu::BufferSize::new(224),
                    }),
                },
            ],
        });
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("reader glass"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: dst_view,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Load,
                    store: wgpu::StoreOp::Store,
                },
            })],
            ..Default::default()
        });
        pass.set_scissor_rect(out_x0, out_y0, out_w, out_h);
        pass.set_pipeline(&self.glass_pipe);
        pass.set_bind_group(0, &group_glass, &[sg_off]);
        pass.draw(0..3, 0..1);
        Ok(())
    }
}
