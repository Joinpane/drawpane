// Copyright 2025 the Vello Authors
// SPDX-License-Identifier: Apache-2.0 OR MIT

//! Creation and growth of the renderer's GPU resources.

use crate::draw::{EXTERNAL_TEXTURE_SLOT_COUNT, ExternalTextureBindings};
use crate::render::wgpu::passes::Programs;
use crate::render::wgpu::passes::filter::{
    FilterPairBindGroups, create_filter_original_texture_bind_group,
};
use crate::render::wgpu::passes::strip::StripTargetKind;
use crate::scene::HwBlendMode;
use crate::{
    LayersConfig, RenderSize,
    filter::FilterContext,
    gradient_cache::GradientRampCache,
    paint::{ExternalSampler, SamplerAddress, SamplerFilter},
    render::{
        Config,
        common::{DataTexture, DataTextureFormat, GpuEncodedPaint, ScratchTexture},
    },
    schedule::Schedule,
    target::{BlendPassBindings, FilterPassBindings, LayerTextureId},
};
use crate::{RenderError, ResourceTexture};
use alloc::vec::Vec;
use core::{borrow::Borrow, fmt::Debug, num::NonZeroU64, ops::Range};
use hashbrown::HashMap;
use vello_common::image_cache::ImageCache;
use vello_common::multi_atlas::AtlasConfig;
use vello_common::{geometry::SizeU16, tile::Tile};
use wgpu::{
    BindGroup, BindGroupLayout, Buffer, BufferDescriptor, COPY_BUFFER_ALIGNMENT, Device, Extent3d,
    Queue, RenderPipeline, Sampler, Texture, TextureView, TextureViewDescriptor, util::DeviceExt,
};

/// Drawpane: number of distinct `(RenderSize, scene_offset)` uniform slots per batch.
const CONFIG_SLOTS: u32 = 256;
/// Drawpane: initial vertex arena size so small draws batch without immediate growth flushes.
const INITIAL_STRIP_CAPACITY: u64 = 512 * 1024;
/// Drawpane: automatic growth ceiling for multi-render vertex batching.
const MAX_AUTO_GROW_STRIP_CAPACITY: u64 = 4 * 1024 * 1024;
/// Drawpane: minimum initial alpha-texture rows allocated for batching.
const MIN_BATCH_ALPHA_ROWS: u32 = 16;
/// Drawpane: maximum alpha staging bytes per batch (2,097,152 columns << 2^24 exact f32 integer limit).
const MAX_BATCH_ALPHA_BYTES: usize = 8 * 1024 * 1024;
/// Drawpane: minimum initial encoded-paint rows allocated for batching.
const MIN_BATCH_PAINT_ROWS: u32 = 4;
/// Drawpane: maximum encoded-paint staging bytes per batch.
const MAX_BATCH_PAINT_BYTES: usize = 2 * 1024 * 1024;
/// Drawpane: cap on cached external-texture bind groups before eviction at batch flush.
const MAX_EXTERNAL_BG_CACHE: usize = 512;

#[derive(Debug)]
pub(crate) struct StripBufferArena {
    pub(crate) buffer: Buffer,
    pub(crate) capacity: u64,
    pub(crate) cursor: u64,
}

pub(crate) fn create_arena_buffer(device: &Device, size: u64) -> Buffer {
    device.create_buffer(&BufferDescriptor {
        label: Some("Strips Arena"),
        size: size.max(16),
        usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    })
}

impl StripBufferArena {
    pub(crate) fn new(device: &Device) -> Self {
        let cap = INITIAL_STRIP_CAPACITY.min(device.limits().max_buffer_size);
        Self {
            buffer: create_arena_buffer(device, cap),
            capacity: cap,
            cursor: 0,
        }
    }

    pub(crate) fn ensure_capacity(&mut self, device: &Device, needed: u64) {
        if needed > self.capacity {
            let new_capacity = needed
                .max(INITIAL_STRIP_CAPACITY)
                .max(self.capacity * 2)
                .min(device.limits().max_buffer_size);
            self.buffer = create_arena_buffer(device, new_capacity);
            self.capacity = new_capacity;
        }
    }

    pub(crate) fn reset_cursor(&mut self) {
        self.cursor = 0;
    }

    pub(crate) fn alloc(&mut self, len: u64) -> u64 {
        let offset = self.cursor.next_multiple_of(16);
        self.cursor = offset + len;
        offset
    }
}

impl From<DataTextureFormat> for wgpu::TextureFormat {
    fn from(format: DataTextureFormat) -> Self {
        match format {
            DataTextureFormat::Rgba8 => Self::Rgba8Unorm,
            DataTextureFormat::Rgba32Uint => Self::Rgba32Uint,
        }
    }
}

/// A texture and a bind group that binds it as the only entry of its layout.
#[derive(Debug)]
pub(crate) struct BoundTexture {
    pub(crate) texture: Texture,
    pub(crate) bind_group: BindGroup,
}

impl Borrow<Texture> for BoundTexture {
    fn borrow(&self) -> &Texture {
        &self.texture
    }
}

fn write_data_texture_rows(
    queue: &Queue,
    texture: &Texture,
    bytes_per_texel: u32,
    staging: &mut Vec<u8>,
) {
    if staging.is_empty() {
        return;
    }
    let width = texture.width();
    let bytes_per_row = width * bytes_per_texel;
    let rows = staging.len().div_ceil(bytes_per_row as usize) as u32;
    let padded_len = rows as usize * bytes_per_row as usize;
    staging.resize(padded_len, 0);
    queue.write_texture(
        texture.as_image_copy(),
        staging,
        wgpu::TexelCopyBufferLayout {
            offset: 0,
            bytes_per_row: Some(bytes_per_row),
            rows_per_image: None,
        },
        Extent3d {
            width,
            height: rows,
            depth_or_array_layers: 1,
        },
    );
}

/// Contains all GPU resources needed for rendering
#[derive(Debug)]
pub(crate) struct GpuResources {
    /// Alpha texture.
    pub(crate) alphas_texture: DataTexture<Texture>,
    /// Maximum width or height of packed resource textures.
    pub(crate) resource_texture_dimension_2d: u32,
    /// One 2D texture per image atlas.
    pub(crate) atlas_textures: Vec<Texture>,
    /// Default view corresponding to each image atlas texture.
    pub(crate) atlas_texture_views: Vec<TextureView>,
    /// Configured atlas dimensions.
    pub(crate) atlas_size: (u16, u16),
    /// Transparent 1x1 placeholder used for unoccupied external texture slots.
    pub(crate) placeholder_external_texture_view: TextureView,
    /// Bind group used when a draw does not sample an external texture.
    pub(crate) empty_external_texture_bind_group: BindGroup,
    /// Texture for encoded paints
    pub(crate) encoded_paints_texture: DataTexture<BoundTexture>,
    /// Texture for gradient lookup table
    pub(crate) gradient_texture: DataTexture<BoundTexture>,
    /// Texture holding serialized `GpuFilterData` for all filter layers.
    pub(crate) filter_data_texture: DataTexture<BoundTexture>,
    /// Intermediate texture size.
    pub(crate) texture_size: SizeU16,
    /// Root config buffer (slotted for dynamic offsets across batched renders).
    pub(crate) view_config_buffer: Buffer,
    /// Alignment stride in bytes between slots in `view_config_buffer`.
    pub(crate) config_align: u32,
    /// Layer config buffer.
    pub(crate) layer_config_buffer: Buffer,

    /// Layer textures by parity.
    pub(crate) layer_textures: [Vec<TextureView>; 2],
    /// Scratch texture.
    pub(crate) scratch_texture: Option<ScratchTexture<TextureView>>,
    /// Filter bind group.
    pub(crate) filter_original_bind_group: BindGroup,
    /// Copy bind group.
    pub(crate) scratch_copy_bind_group: BindGroup,
    /// Native image samplers shared by external texture slots.
    pub(crate) external_samplers: HashMap<ExternalSampler, Sampler>,
    /// Strip bind group cache.
    pub(crate) strip_layer_bind_groups:
        HashMap<(StripTargetKind, Option<LayerTextureId>), BindGroup>,
    /// Blend bind group cache.
    pub(crate) blend_layer_bind_groups: HashMap<BlendPassBindings, BindGroup>,
    /// Filter bind group cache.
    pub(crate) filter_pair_bind_groups: HashMap<FilterPassBindings, FilterPairBindGroups>,
    /// Drawpane: persistent external-texture bind group cache keyed by bindings + version stamps.
    pub(crate) external_texture_bind_groups:
        HashMap<(ExternalTextureBindings, [u64; EXTERNAL_TEXTURE_SLOT_COUNT]), BindGroup>,
    /// Arena holding all [`GpuStrip`](crate::GpuStrip), blend, clear, and copy vertex data.
    pub(crate) strips_arena: StripBufferArena,
    /// Drawpane: CPU staging for batched uploads flushed once before `queue.submit`.
    pub(crate) batch_active: bool,
    pub(crate) batch_has_filter: bool,
    pub(crate) batch_gradient_upload_len: usize,
    pub(crate) batch_alpha_target_bytes: usize,
    pub(crate) batch_paint_target_texels: u32,
    pub(crate) batch_strip_target_bytes: u64,
    pub(crate) alphas_staging: Vec<u8>,
    pub(crate) paints_staging: Vec<u8>,
    pub(crate) strips_staging: Vec<u8>,
    pub(crate) config_staging: Vec<u8>,
    pub(crate) filter_data_staging: Vec<u8>,
    pub(crate) gradient_upload_scratch: Vec<u8>,
    pub(crate) batch_configs: HashMap<(RenderSize, (i32, i32)), u32>,
    /// Dimensions of the active rendering target.
    pub(crate) render_size: RenderSize,
    /// Offset of the scene within the active rendering target.
    pub(crate) scene_offset: (i32, i32),
    /// Whether the depth buffer has been cleared for the current render.
    pub(crate) depth_cleared_this_frame: bool,
    /// Drawpane: whether the secondary root target's depth buffer has been cleared in a dual replay.
    pub(crate) secondary_depth_cleared_this_frame: bool,
    /// Drawpane: lazily created root alpha-strip fixed-function HW blend pipelines (no depth test).
    pub(crate) alpha_hw_blend_pipelines: [Option<RenderPipeline>; HwBlendMode::NON_NORMAL_COUNT],
    /// Drawpane: lazily created root alpha-strip fixed-function HW blend pipelines (with depth test).
    pub(crate) depth_hw_blend_pipelines: [Option<RenderPipeline>; HwBlendMode::NON_NORMAL_COUNT],
}

impl GpuResources {
    pub(crate) fn new(
        device: &Device,
        programs: &Programs,
        image_cache: &ImageCache,
        render_size: RenderSize,
        layer_config: LayersConfig,
        resource_texture_dimension_2d: u32,
    ) -> Self {
        let texture_size = layer_config.min_texture_size;

        // The empty bind group needs a sampler even before any external image is drawn.
        let mut external_samplers = HashMap::new();
        external_samplers.insert(
            ExternalSampler::DEFAULT,
            Self::create_external_sampler(device, ExternalSampler::DEFAULT),
        );

        let layer_textures: [Vec<TextureView>; 2] = core::array::from_fn(|_| Vec::new());
        let scratch_texture = None;
        let placeholder_external_texture_view = Self::create_placeholder_external_texture(device);
        let filter_original_bind_group = create_filter_original_texture_bind_group(
            device,
            &programs.filter.input_bind_group_layouts[1],
            &placeholder_external_texture_view,
        );
        let layer_config_buffer = Self::create_config_buffer(
            device,
            u32::from(texture_size.width()),
            u32::from(texture_size.height()),
            resource_texture_dimension_2d,
        );

        let initial_alpha_rows = MIN_BATCH_ALPHA_ROWS.min(resource_texture_dimension_2d);
        let alphas_texture = DataTexture::new(
            Self::create_data_texture(
                device,
                "Alpha Texture",
                DataTextureFormat::Rgba32Uint,
                resource_texture_dimension_2d,
                initial_alpha_rows,
            ),
            ResourceTexture::Alphas,
            DataTextureFormat::Rgba32Uint,
            resource_texture_dimension_2d,
            initial_alpha_rows,
        );
        let config_align = device
            .limits()
            .min_uniform_buffer_offset_alignment
            .max(SIZE_OF_CONFIG.get() as u32);
        let view_config_buffer = device.create_buffer(&BufferDescriptor {
            label: Some("View Config Batch Buffer"),
            size: u64::from(config_align) * u64::from(CONFIG_SLOTS),
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        let AtlasConfig {
            atlas_size: (atlas_width, atlas_height),
            initial_atlas_count,
            ..
        } = image_cache.atlas_manager().config();
        let atlas_size = (*atlas_width, *atlas_height);
        let atlas_textures: Vec<_> = (0..*initial_atlas_count)
            .map(|_| Self::create_atlas_texture(device, *atlas_width, *atlas_height))
            .collect();
        let atlas_texture_views = atlas_textures
            .iter()
            .map(|texture| texture.create_view(&TextureViewDescriptor::default()))
            .collect();
        let empty_external_texture_bind_group =
            Programs::create_external_texture_bind_group(
                device,
                &programs.strip.external_texture_bind_group_layout,
                [&placeholder_external_texture_view; EXTERNAL_TEXTURE_SLOT_COUNT],
                [&external_samplers[&ExternalSampler::DEFAULT]; EXTERNAL_TEXTURE_SLOT_COUNT],
                programs.strip.wgpu_external_textures.then_some(
                    wgpu::BindingResource::TextureView(&placeholder_external_texture_view),
                ),
            );

        let initial_paint_rows = MIN_BATCH_PAINT_ROWS.min(resource_texture_dimension_2d);
        let encoded_paints_texture = DataTexture::new(
            Self::create_bound_data_texture(
                device,
                "Encoded Paints",
                &programs.encoded_paints_bind_group_layout,
                DataTextureFormat::Rgba32Uint,
                resource_texture_dimension_2d,
                initial_paint_rows,
            ),
            ResourceTexture::EncodedPaints,
            DataTextureFormat::Rgba32Uint,
            resource_texture_dimension_2d,
            initial_paint_rows,
        );
        let gradient_texture = Self::new_bound_data_texture(
            device,
            "Gradient",
            &programs.gradient_bind_group_layout,
            ResourceTexture::Gradients,
            DataTextureFormat::Rgba8,
            resource_texture_dimension_2d,
        );
        let filter_data_texture = Self::new_bound_data_texture(
            device,
            "Filter Data",
            &programs.filter.bind_group_layout,
            ResourceTexture::FilterData,
            DataTextureFormat::Rgba32Uint,
            resource_texture_dimension_2d,
        );
        let scratch_copy_bind_group = Programs::create_copy_bind_group(
            device,
            &programs.copy.bind_group_layout,
            &placeholder_external_texture_view,
        );

        let batch_alpha_target_bytes = alphas_texture.capacity_bytes();
        let batch_paint_target_texels = encoded_paints_texture.capacity_texels();
        let strips_arena = StripBufferArena::new(device);
        let batch_strip_target_bytes = strips_arena.capacity;

        Self {
            layer_textures,
            scratch_texture,
            filter_original_bind_group,
            scratch_copy_bind_group,
            layer_config_buffer,
            alphas_texture,
            resource_texture_dimension_2d,
            atlas_textures,
            atlas_texture_views,
            atlas_size,
            placeholder_external_texture_view,
            empty_external_texture_bind_group,
            encoded_paints_texture,
            gradient_texture,
            filter_data_texture,
            texture_size,
            view_config_buffer,
            config_align,
            external_samplers,
            strip_layer_bind_groups: HashMap::new(),
            blend_layer_bind_groups: HashMap::new(),
            filter_pair_bind_groups: HashMap::new(),
            external_texture_bind_groups: HashMap::new(),
            strips_arena,
            batch_active: false,
            batch_has_filter: false,
            batch_gradient_upload_len: 0,
            batch_alpha_target_bytes,
            batch_paint_target_texels,
            batch_strip_target_bytes,
            alphas_staging: Vec::new(),
            paints_staging: Vec::new(),
            strips_staging: Vec::new(),
            config_staging: Vec::new(),
            filter_data_staging: Vec::new(),
            gradient_upload_scratch: Vec::new(),
            batch_configs: HashMap::new(),
            render_size,
            scene_offset: (0, 0),
            depth_cleared_this_frame: false,
            secondary_depth_cleared_this_frame: false,
            alpha_hw_blend_pipelines: [const { None }; HwBlendMode::NON_NORMAL_COUNT],
            depth_hw_blend_pipelines: [const { None }; HwBlendMode::NON_NORMAL_COUNT],
        }
    }

    /// Drawpane: stage vertex bytes for blend/clear/copy passes in the shared vertex arena.
    pub(crate) fn upload_vertex_bytes(&mut self, bytes: &[u8]) -> Range<u64> {
        if bytes.is_empty() {
            return 0..0;
        }
        let len = bytes.len() as u64;
        let offset = self.strips_arena.alloc(len);
        debug_assert!(
            offset + len <= self.strips_arena.capacity,
            "strips arena overflow: {} > {}",
            offset + len,
            self.strips_arena.capacity
        );
        self.strips_staging.resize(offset as usize, 0);
        self.strips_staging.extend_from_slice(bytes);
        offset..offset + len
    }

    pub(crate) fn layer_views(&self, layer_ids: [LayerTextureId; 2]) -> [&TextureView; 2] {
        layer_ids.map(|id| self.layer_view(id))
    }

    pub(crate) fn layer_view(&self, id: LayerTextureId) -> &TextureView {
        self.layer_textures[id.texture_parity.get_parity()]
            .get(usize::from(id.page_index))
            .unwrap()
    }

    pub(crate) fn scratch_view(&self) -> &TextureView {
        self.scratch_texture.as_ref().unwrap().get()
    }
}

pub(crate) const SIZE_OF_CONFIG: NonZeroU64 = NonZeroU64::new(size_of::<Config>() as u64).unwrap();

impl GpuResources {
    fn create_intermediate_texture(
        device: &Device,
        size: SizeU16,
        label: &'static str,
    ) -> TextureView {
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some(label),
            size: Extent3d {
                width: u32::from(size.width()),
                height: u32::from(size.height()),
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::RENDER_ATTACHMENT,
            view_formats: &[],
        });

        texture.create_view(&TextureViewDescriptor::default())
    }

    pub(crate) fn prepare_intermediate_textures(
        &mut self,
        device: &Device,
        programs: &Programs,
        schedule: &Schedule,
    ) {
        let requirements = schedule.intermediate_texture_requirements();
        let texture_size = requirements.size;
        let current_size = self.texture_size;
        let allocations = requirements.allocations;
        let layer_pages = allocations.layer_pages;
        let scratch_required = allocations.scratch;
        let size_changed = current_size != texture_size;

        if size_changed {
            self.layer_config_buffer = Self::create_config_buffer(
                device,
                u32::from(texture_size.width()),
                u32::from(texture_size.height()),
                self.resource_texture_dimension_2d,
            );
        }

        for (index, textures) in self.layer_textures.iter_mut().enumerate() {
            let required_page_count = layer_pages[index];
            // Note: Currently, `texture_size` only grows across frames, so if this condition
            // is true it means that the new required size is larger than what we currently have.
            if size_changed {
                for texture in textures.iter_mut() {
                    *texture = Self::create_intermediate_texture(
                        device,
                        texture_size,
                        "Layer Intermediate Texture",
                    );
                }
            }

            textures.extend((textures.len()..required_page_count).map(|_| {
                Self::create_intermediate_texture(
                    device,
                    texture_size,
                    "Layer Intermediate Texture",
                )
            }));
        }
        let scratch_changed = (self.scratch_texture.is_some() && size_changed)
            || (self.scratch_texture.is_none() && scratch_required);
        if scratch_changed {
            self.scratch_texture = Some(ScratchTexture::new(Self::create_intermediate_texture(
                device,
                texture_size,
                "Scratch Texture",
            )));
        }

        self.texture_size = texture_size;

        if size_changed {
            self.clear_layer_bind_group_caches();
        }

        if scratch_changed {
            self.update_scratch_bind_groups(device, programs);
        }
    }

    fn clear_layer_bind_group_caches(&mut self) {
        self.strip_layer_bind_groups.clear();
        self.blend_layer_bind_groups.clear();
        self.filter_pair_bind_groups.clear();
    }

    fn update_scratch_bind_groups(&mut self, device: &Device, programs: &Programs) {
        let scratch_view = self.scratch_view();
        let filter_original_bind_group = create_filter_original_texture_bind_group(
            device,
            &programs.filter.input_bind_group_layouts[1],
            scratch_view,
        );
        let scratch_copy_bind_group = Programs::create_copy_bind_group(
            device,
            &programs.copy.bind_group_layout,
            scratch_view,
        );

        self.filter_original_bind_group = filter_original_bind_group;
        self.scratch_copy_bind_group = scratch_copy_bind_group;
    }

    pub(crate) fn create_config_buffer(
        device: &Device,
        width: u32,
        height: u32,
        alpha_texture_width: u32,
    ) -> Buffer {
        device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Config Buffer"),
            contents: bytemuck::bytes_of(&Config {
                width,
                height,
                strip_height: Tile::HEIGHT.into(),
                alphas_tex_width_bits: alpha_texture_width.trailing_zeros(),
                encoded_paints_tex_width_bits: alpha_texture_width.trailing_zeros(),
                strip_offset_x: 0,
                strip_offset_y: 0,
                negate_ndc: 0,
            }),
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        })
    }

    fn new_bound_data_texture(
        device: &Device,
        label: &'static str,
        layout: &BindGroupLayout,
        kind: ResourceTexture,
        format: DataTextureFormat,
        width: u32,
    ) -> DataTexture<BoundTexture> {
        DataTexture::new(
            Self::create_bound_data_texture(device, label, layout, format, width, 1),
            kind,
            format,
            width,
            1,
        )
    }

    pub(crate) fn create_bound_data_texture(
        device: &Device,
        label: &'static str,
        layout: &BindGroupLayout,
        format: DataTextureFormat,
        width: u32,
        height: u32,
    ) -> BoundTexture {
        let texture = Self::create_data_texture(device, label, format, width, height);
        let view = texture.create_view(&TextureViewDescriptor::default());
        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some(label),
            layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: wgpu::BindingResource::TextureView(&view),
            }],
        });
        BoundTexture {
            texture,
            bind_group,
        }
    }

    fn create_data_texture(
        device: &Device,
        label: &'static str,
        format: DataTextureFormat,
        width: u32,
        height: u32,
    ) -> Texture {
        device.create_texture(&wgpu::TextureDescriptor {
            label: Some(label),
            size: Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: format.into(),
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        })
    }

    pub(crate) fn create_atlas_texture(device: &Device, width: u16, height: u16) -> Texture {
        device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Atlas Texture"),
            size: Extent3d {
                width: u32::from(width),
                height: u32::from(height),
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING
                | wgpu::TextureUsages::COPY_DST
                | wgpu::TextureUsages::COPY_SRC
                | wgpu::TextureUsages::RENDER_ATTACHMENT,
            view_formats: &[],
        })
    }

    /// 1×1 placeholder bound to the external-texture slot when no real external texture is in
    /// use. `Rgba8Unorm` is accepted by both the `Texture` and `ExternalTexture` binding types.
    pub(crate) fn create_placeholder_external_texture(device: &Device) -> TextureView {
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Placeholder External Texture"),
            size: Extent3d {
                width: 1,
                height: 1,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });
        texture.create_view(&TextureViewDescriptor::default())
    }

    pub(crate) fn create_external_sampler(device: &Device, key: ExternalSampler) -> Sampler {
        let address_mode = |address| match address {
            SamplerAddress::Pad => wgpu::AddressMode::ClampToEdge,
            SamplerAddress::Repeat => wgpu::AddressMode::Repeat,
            SamplerAddress::Reflect => wgpu::AddressMode::MirrorRepeat,
        };
        let filter = match key.filter {
            SamplerFilter::Nearest => wgpu::FilterMode::Nearest,
            SamplerFilter::Linear => wgpu::FilterMode::Linear,
        };
        device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("External Texture Sampler"),
            address_mode_u: address_mode(key.address_x),
            address_mode_v: address_mode(key.address_y),
            mag_filter: filter,
            min_filter: filter,
            ..Default::default()
        })
    }

    /// Drawpane: check whether a prepared render fits into the active GPU batch without resizing
    /// any resource bound by earlier passes in the same `CommandEncoder`.
    #[expect(clippy::too_many_arguments, reason = "batch capacity check")]
    pub(crate) fn can_fit_in_batch(
        &mut self,
        schedule: &Schedule,
        gradient_cache: &GradientRampCache,
        alphas_len: usize,
        paint_texels: u32,
        filter_context: &FilterContext,
        render_size: RenderSize,
        secondary_render_size: Option<RenderSize>,
        scene_offset: (i32, i32),
        needed_vertex_bytes: u64,
    ) -> bool {
        if !self.batch_active {
            return true;
        }
        let req = schedule.intermediate_texture_requirements();
        if req.size != self.texture_size {
            return false;
        }
        if req.allocations.scratch && self.scratch_texture.is_none() {
            return false;
        }
        if !filter_context.is_empty() || self.batch_has_filter {
            return false;
        }
        if gradient_cache.has_changed()
            && gradient_cache.luts_size() > self.gradient_texture.capacity_bytes()
        {
            return false;
        }

        let max_tex_alpha_bytes = (self.resource_texture_dimension_2d as usize)
            .saturating_mul(self.resource_texture_dimension_2d as usize)
            .saturating_mul(16)
            .min(MAX_BATCH_ALPHA_BYTES);
        let alpha_pad = self.alphas_staging.len().next_multiple_of(16);
        let alpha_end = alpha_pad.saturating_add(alphas_len);
        if alpha_end > self.alphas_texture.capacity_bytes() || alpha_end > max_tex_alpha_bytes {
            if alpha_end <= max_tex_alpha_bytes
                && self.alphas_texture.capacity_bytes() < max_tex_alpha_bytes
            {
                self.batch_alpha_target_bytes =
                    (self.alphas_texture.capacity_bytes() * 2).min(max_tex_alpha_bytes);
            }
            return false;
        }

        let max_tex_paint_texels = self
            .resource_texture_dimension_2d
            .saturating_mul(self.resource_texture_dimension_2d)
            .min((MAX_BATCH_PAINT_BYTES / 16) as u32)
            .min((1 << 24) - 1);
        let paint_base_texel = (self.paints_staging.len() / 16) as u32;
        let paint_end_texels = paint_base_texel.saturating_add(paint_texels);
        if paint_end_texels > self.encoded_paints_texture.capacity_texels()
            || paint_end_texels > max_tex_paint_texels
        {
            if paint_end_texels <= max_tex_paint_texels
                && self.encoded_paints_texture.capacity_texels() < max_tex_paint_texels
            {
                self.batch_paint_target_texels =
                    (self.encoded_paints_texture.capacity_texels() * 2).min(max_tex_paint_texels);
            }
            return false;
        }

        let vertex_end = self
            .strips_arena
            .cursor
            .next_multiple_of(16)
            .saturating_add(needed_vertex_bytes);
        if vertex_end > self.strips_arena.capacity {
            if self.strips_arena.capacity < MAX_AUTO_GROW_STRIP_CAPACITY {
                self.batch_strip_target_bytes =
                    (self.strips_arena.capacity * 2).min(MAX_AUTO_GROW_STRIP_CAPACITY);
            }
            return false;
        }

        let config_key = (render_size, scene_offset);
        let mut extra_configs = usize::from(!self.batch_configs.contains_key(&config_key));
        if let Some(sec_size) = secondary_render_size
            && sec_size != render_size
            && !self.batch_configs.contains_key(&(sec_size, scene_offset))
        {
            extra_configs += 1;
        }
        if self.batch_configs.len() + extra_configs > CONFIG_SLOTS as usize {
            return false;
        }

        true
    }

    /// Drawpane: allocate or reuse a dynamic-offset slot in `view_config_buffer` for this render.
    pub(crate) fn alloc_config_slot(
        &mut self,
        render_size: RenderSize,
        scene_offset: (i32, i32),
    ) -> u32 {
        let key = (render_size, scene_offset);
        if let Some(&offset) = self.batch_configs.get(&key) {
            return offset;
        }
        let slot = self.batch_configs.len() as u32;
        let offset = slot * self.config_align;
        let config = Config {
            width: u32::from(render_size.width),
            height: u32::from(render_size.height),
            strip_height: Tile::HEIGHT.into(),
            alphas_tex_width_bits: self.resource_texture_dimension_2d.trailing_zeros(),
            encoded_paints_tex_width_bits: self.resource_texture_dimension_2d.trailing_zeros(),
            strip_offset_x: scene_offset.0,
            strip_offset_y: scene_offset.1,
            negate_ndc: 0,
        };
        let start = offset as usize;
        let end = start + self.config_align as usize;
        if self.config_staging.len() < end {
            self.config_staging.resize(end, 0);
        }
        let bytes = bytemuck::bytes_of(&config);
        self.config_staging[start..start + bytes.len()].copy_from_slice(bytes);
        self.batch_configs.insert(key, offset);
        offset
    }

    /// Drawpane: ensure GPU buffers/textures are sized (when starting a fresh batch) and stage
    /// this render's alphas, encoded paints, filters, and view config into CPU batch buffers.
    ///
    /// Returns `(view_config_offset, alpha_col_base, paint_base_texel)`.
    #[expect(clippy::too_many_arguments, reason = "batch resource preparation")]
    pub(crate) fn prepare_batch(
        &mut self,
        device: &Device,
        programs: &Programs,
        gradient_cache: &GradientRampCache,
        encoded_paints: &[GpuEncodedPaint],
        alphas: &[u8],
        new_render_size: RenderSize,
        scene_offset: (i32, i32),
        paint_texels: u32,
        filter_context: &FilterContext,
        needed_vertex_bytes: u64,
    ) -> Result<(u32, u32, u32), RenderError> {
        if !self.batch_active {
            let alphas_need = alphas.len().max(self.batch_alpha_target_bytes);
            self.maybe_resize_alphas_tex(device, alphas_need)?;
            let paints_need = paint_texels.max(self.batch_paint_target_texels);
            self.maybe_resize_encoded_paints_tex(device, programs, paints_need)?;
            self.maybe_resize_filter_tex(device, programs, filter_context)?;
            if gradient_cache.has_changed() {
                self.maybe_resize_gradient_tex(device, programs, gradient_cache)?;
            }
            self.strips_arena
                .ensure_capacity(device, needed_vertex_bytes.max(self.batch_strip_target_bytes));
            self.batch_active = true;
        }

        if !filter_context.is_empty() {
            self.batch_has_filter = true;
            self.stage_filter_texture(filter_context);
        }
        if gradient_cache.has_changed() {
            self.batch_gradient_upload_len = gradient_cache.luts_size();
        }

        let alpha_col_base = if alphas.is_empty() {
            0
        } else {
            let pad = self.alphas_staging.len().next_multiple_of(16);
            self.alphas_staging.resize(pad, 0);
            let base = (pad / 4) as u32;
            self.alphas_staging.extend_from_slice(alphas);
            base
        };

        let paint_base_texel = if encoded_paints.is_empty() {
            0
        } else {
            let base = (self.paints_staging.len() / 16) as u32;
            for paint in encoded_paints {
                self.paints_staging.extend_from_slice(paint.as_bytes());
            }
            debug_assert_eq!(
                (self.paints_staging.len() / 16) as u32 - base,
                paint_texels
            );
            base
        };

        let view_config_offset = self.alloc_config_slot(new_render_size, scene_offset);
        self.render_size = new_render_size;
        self.scene_offset = scene_offset;

        Ok((view_config_offset, alpha_col_base, paint_base_texel))
    }

    /// Drawpane: upload all CPU-staged buffers and data textures once before `queue.submit`.
    pub(crate) fn flush_uploads(
        &mut self,
        queue: &Queue,
        gradient_cache: &mut GradientRampCache,
    ) {
        if !self.batch_active {
            return;
        }
        if !self.alphas_staging.is_empty() {
            write_data_texture_rows(
                queue,
                self.alphas_texture.texture(),
                self.alphas_texture.format().bytes_per_texel(),
                &mut self.alphas_staging,
            );
            self.alphas_staging.clear();
        }
        if !self.paints_staging.is_empty() {
            write_data_texture_rows(
                queue,
                &self.encoded_paints_texture.texture().texture,
                self.encoded_paints_texture.format().bytes_per_texel(),
                &mut self.paints_staging,
            );
            self.paints_staging.clear();
        }
        if !self.filter_data_staging.is_empty() {
            write_data_texture_rows(
                queue,
                &self.filter_data_texture.texture().texture,
                self.filter_data_texture.format().bytes_per_texel(),
                &mut self.filter_data_staging,
            );
            self.filter_data_staging.clear();
        }
        if self.batch_gradient_upload_len > 0 {
            let luts = gradient_cache.luts();
            let upload_len = self.batch_gradient_upload_len.min(luts.len());
            self.gradient_upload_scratch.clear();
            self.gradient_upload_scratch
                .extend_from_slice(&luts[..upload_len]);
            write_data_texture_rows(
                queue,
                &self.gradient_texture.texture().texture,
                self.gradient_texture.format().bytes_per_texel(),
                &mut self.gradient_upload_scratch,
            );
            if upload_len == luts.len() {
                gradient_cache.mark_synced();
            }
            self.batch_gradient_upload_len = 0;
        }
        if !self.config_staging.is_empty() {
            queue.write_buffer(&self.view_config_buffer, 0, &self.config_staging);
            self.config_staging.clear();
            self.batch_configs.clear();
        }
        if !self.strips_staging.is_empty() {
            let padded = self
                .strips_staging
                .len()
                .next_multiple_of(COPY_BUFFER_ALIGNMENT as usize);
            self.strips_staging.resize(padded, 0);
            queue.write_buffer(&self.strips_arena.buffer, 0, &self.strips_staging);
            self.strips_staging.clear();
        }
        self.strips_arena.reset_cursor();
        if self.external_texture_bind_groups.len() > MAX_EXTERNAL_BG_CACHE {
            self.external_texture_bind_groups.clear();
        }
        self.batch_active = false;
        self.batch_has_filter = false;
    }

    /// Drawpane: discard staged batch data when an active `CommandEncoder` is dropped unsubmitted.
    pub(crate) fn discard_uploads(&mut self) {
        self.alphas_staging.clear();
        self.paints_staging.clear();
        self.strips_staging.clear();
        self.config_staging.clear();
        self.filter_data_staging.clear();
        self.batch_configs.clear();
        self.strips_arena.reset_cursor();
        if self.external_texture_bind_groups.len() > MAX_EXTERNAL_BG_CACHE {
            self.external_texture_bind_groups.clear();
        }
        self.batch_active = false;
        self.batch_has_filter = false;
        self.batch_gradient_upload_len = 0;
    }

    /// Update the alpha texture size if needed.
    fn maybe_resize_alphas_tex(
        &mut self,
        device: &Device,
        alphas_len: usize,
    ) -> Result<(), RenderError> {
        let resized = self
            .alphas_texture
            .ensure_bytes(alphas_len, |format, width, height| {
                // The alpha texture encodes 16 1-byte alpha values per texel, with 4 alpha values packed in each channel
                Ok::<_, RenderError>(Self::create_data_texture(
                    device,
                    "Alpha Texture",
                    format,
                    width,
                    height,
                ))
            })?;
        if resized {
            self.strip_layer_bind_groups.clear();
            self.blend_layer_bind_groups.clear();
        }

        Ok(())
    }

    /// Update the encoded paints texture size if needed.
    fn maybe_resize_encoded_paints_tex(
        &mut self,
        device: &Device,
        programs: &Programs,
        paint_texels: u32,
    ) -> Result<(), RenderError> {
        let layout = &programs.encoded_paints_bind_group_layout;
        self.encoded_paints_texture
            .ensure_texels(paint_texels, |format, width, height| {
                Ok::<_, RenderError>(Self::create_bound_data_texture(
                    device,
                    "Encoded Paints",
                    layout,
                    format,
                    width,
                    height,
                ))
            })?;

        Ok(())
    }

    /// Update the gradient texture size if needed.
    fn maybe_resize_gradient_tex(
        &mut self,
        device: &Device,
        programs: &Programs,
        gradient_cache: &GradientRampCache,
    ) -> Result<(), RenderError> {
        let layout = &programs.gradient_bind_group_layout;
        self.gradient_texture.ensure_bytes(
            gradient_cache.luts_size(),
            |format, width, height| {
                Ok::<_, RenderError>(Self::create_bound_data_texture(
                    device, "Gradient", layout, format, width, height,
                ))
            },
        )?;

        Ok(())
    }

    /// Create any newly allocated atlas textures.
    pub(crate) fn maybe_create_atlas_textures(
        &mut self,
        device: &Device,
        required_atlas_count: u32,
    ) {
        let (width, height) = self.atlas_size;
        while self.atlas_textures.len() < required_atlas_count as usize {
            let texture = Self::create_atlas_texture(device, width, height);
            let texture_view = texture.create_view(&TextureViewDescriptor::default());
            self.atlas_textures.push(texture);
            self.atlas_texture_views.push(texture_view);
        }
    }
}
