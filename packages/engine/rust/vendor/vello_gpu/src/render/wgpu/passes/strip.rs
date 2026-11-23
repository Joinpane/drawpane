// Copyright 2025 the Vello Authors
// SPDX-License-Identifier: Apache-2.0 OR MIT

//! The strip pass.

use crate::draw::{EXTERNAL_TEXTURE_SLOT_COUNT, ExternalTextureBindings, ExternalTextureRun};
use crate::render::wgpu::RenderTargetConfig;
use crate::render::wgpu::bindings::TextureBinding;
use crate::render::wgpu::passes::{Programs, RendererContext};
use crate::render::wgpu::resources::{GpuResources, SIZE_OF_CONFIG};
use crate::util::RangedSlice;
use crate::{
    GpuStrip,
    paint::{ExternalSampler, TextureSourceId},
    target::{DrawPassTarget, LayerTextureId, RootTarget},
};
use alloc::vec;
use core::{fmt::Debug, ops::Range};
use hashbrown::hash_map::Entry;
use wgpu::{
    BindGroup, BindGroupLayout, BlendState, Buffer, ColorTargetState, ColorWrites,
    Device, PipelineCompilationOptions, RenderPassColorAttachment, RenderPassDescriptor,
    RenderPipeline, Sampler, TextureView, TextureViewDescriptor,
};

/// Bind group layouts and pipelines of the strip pass.
#[derive(Debug)]
pub(crate) struct StripPipelines {
    /// Bind group layout for strip draws
    pub(crate) bind_group_layout: BindGroupLayout,
    /// Bind group layout for external textures.
    pub(crate) external_texture_bind_group_layout: BindGroupLayout,
    /// Whether the external texture bind group has a `texture_external` binding.
    pub(crate) wgpu_external_textures: bool,
    /// Intermediate strip pipeline.
    pub(crate) intermediate: RenderPipeline,
    /// Root alpha-strip pipeline.
    pub(crate) alpha: RenderPipeline,
    /// Root alpha-strip pipeline with depth testing.
    pub(crate) depth_alpha: RenderPipeline,
    /// Root opaque-strip pipeline.
    pub(crate) opaque: RenderPipeline,
}

impl StripPipelines {
    pub(crate) fn new(
        device: &Device,
        render_target_config: &RenderTargetConfig,
        encoded_paints_bind_group_layout: &BindGroupLayout,
        gradient_bind_group_layout: &BindGroupLayout,
        pipeline_cache: Option<&wgpu::PipelineCache>,
    ) -> Self {
        let strip_bind_group_layout =
            device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("Strip Bind Group Layout"),
                entries: &[
                    wgpu::BindGroupLayoutEntry {
                        binding: 0,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Texture {
                            sample_type: wgpu::TextureSampleType::Uint,
                            view_dimension: wgpu::TextureViewDimension::D2,
                            multisampled: false,
                        },
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 1,
                        visibility: wgpu::ShaderStages::VERTEX | wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Uniform,
                            // Drawpane: dynamic offset allows batching renders with distinct sizes/offsets.
                            has_dynamic_offset: true,
                            min_binding_size: Some(SIZE_OF_CONFIG),
                        },
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 2,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Texture {
                            sample_type: wgpu::TextureSampleType::Float { filterable: false },
                            view_dimension: wgpu::TextureViewDimension::D2,
                            multisampled: false,
                        },
                        count: None,
                    },
                ],
            });

        #[cfg(feature = "wgpu_external_texture")]
        let wgpu_external_textures = device.features().contains(wgpu::Features::EXTERNAL_TEXTURE);
        #[cfg(not(feature = "wgpu_external_texture"))]
        let wgpu_external_textures = false;
        let external_texture_layout_entry = |binding| wgpu::BindGroupLayoutEntry {
            binding,
            visibility: wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Texture {
                sample_type: wgpu::TextureSampleType::Float { filterable: true },
                view_dimension: wgpu::TextureViewDimension::D2,
                multisampled: false,
            },
            count: None,
        };
        let external_sampler_layout_entry = |binding| wgpu::BindGroupLayoutEntry {
            binding,
            visibility: wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
            count: None,
        };
        let mut external_texture_layout_entries = vec![
            external_texture_layout_entry(0),
            external_sampler_layout_entry(1),
        ];
        if wgpu_external_textures {
            external_texture_layout_entries.push(wgpu::BindGroupLayoutEntry {
                binding: 2,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::ExternalTexture,
                count: None,
            });
        }
        let external_texture_bind_group_layout =
            device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("External Texture Bind Group Layout"),
                entries: &external_texture_layout_entries,
            });

        #[cfg(feature = "wgpu_external_texture")]
        let strip_shader_source = if wgpu_external_textures {
            vello_gpu_shaders::wgsl::RENDER_TEXTURE_EXTERNAL
        } else {
            vello_gpu_shaders::wgsl::RENDER
        };
        #[cfg(not(feature = "wgpu_external_texture"))]
        let strip_shader_source = vello_gpu_shaders::wgsl::RENDER;
        let strip_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Strip Shader"),
            source: wgpu::ShaderSource::Wgsl(strip_shader_source.into()),
        });

        let strip_pipeline_layout =
            device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("Strip Pipeline Layout"),
                bind_group_layouts: &[
                    Some(&strip_bind_group_layout),
                    Some(&external_texture_bind_group_layout),
                    Some(encoded_paints_bind_group_layout),
                    Some(gradient_bind_group_layout),
                ],
                immediate_size: 0,
            });

        let depth_format = wgpu::TextureFormat::Depth24Plus;

        let strip_vertex_state = wgpu::VertexBufferLayout {
            array_stride: size_of::<GpuStrip>() as u64,
            step_mode: wgpu::VertexStepMode::Instance,
            attributes: &GpuStrip::vertex_attributes(),
        };

        let create_strip_pipeline =
            |label, format, blend, depth_stencil: Option<wgpu::DepthStencilState>| {
                device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                    label: Some(label),
                    layout: Some(&strip_pipeline_layout),
                    vertex: wgpu::VertexState {
                        module: &strip_shader,
                        entry_point: Some("vs_main"),
                        buffers: &[Some(strip_vertex_state.clone())],
                        compilation_options: PipelineCompilationOptions::default(),
                    },
                    fragment: Some(wgpu::FragmentState {
                        module: &strip_shader,
                        entry_point: Some("fs_main"),
                        targets: &[Some(ColorTargetState {
                            format,
                            blend,
                            write_mask: ColorWrites::ALL,
                        })],
                        compilation_options: PipelineCompilationOptions::default(),
                    }),
                    primitive: wgpu::PrimitiveState {
                        topology: wgpu::PrimitiveTopology::TriangleStrip,
                        ..Default::default()
                    },
                    depth_stencil,
                    multisample: wgpu::MultisampleState::default(),
                    multiview_mask: None,
                    cache: pipeline_cache,
                })
            };

        let depth_stencil = |depth_write_enabled| wgpu::DepthStencilState {
            format: depth_format,
            depth_write_enabled: Some(depth_write_enabled),
            depth_compare: Some(wgpu::CompareFunction::LessEqual),
            stencil: wgpu::StencilState::default(),
            bias: wgpu::DepthBiasState::default(),
        };

        let intermediate_strip_pipeline = create_strip_pipeline(
            "Strip Intermediate Pipeline",
            wgpu::TextureFormat::Rgba8Unorm,
            Some(BlendState::PREMULTIPLIED_ALPHA_BLENDING),
            None,
        );

        let alpha_strip_pipeline = create_strip_pipeline(
            "Strip Alpha Pipeline",
            render_target_config.format,
            Some(BlendState::PREMULTIPLIED_ALPHA_BLENDING),
            None,
        );

        let depth_alpha_strip_pipeline = create_strip_pipeline(
            "Strip Depth Alpha Pipeline",
            render_target_config.format,
            Some(BlendState::PREMULTIPLIED_ALPHA_BLENDING),
            Some(depth_stencil(false)),
        );

        let opaque_strip_pipeline = create_strip_pipeline(
            "Strip Opaque Pipeline",
            render_target_config.format,
            None,
            Some(depth_stencil(true)),
        );

        Self {
            bind_group_layout: strip_bind_group_layout,
            external_texture_bind_group_layout,
            wgpu_external_textures,
            intermediate: intermediate_strip_pipeline,
            alpha: alpha_strip_pipeline,
            depth_alpha: depth_alpha_strip_pipeline,
            opaque: opaque_strip_pipeline,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum StripTargetKind {
    Root,
    Layer,
}

impl GpuStrip {
    /// Vertex attributes for the strip
    pub fn vertex_attributes() -> [wgpu::VertexAttribute; 6] {
        wgpu::vertex_attr_array![
            0 => Uint32,
            1 => Uint32,
            2 => Uint32,
            3 => Uint32,
            4 => Uint32,
            5 => Uint32,
        ]
    }
}

impl Programs {
    /// `wgpu_external_texture` must be `Some` exactly if the layout has a `texture_external`
    /// binding.
    pub(crate) fn create_external_texture_bind_group(
        device: &Device,
        external_texture_bind_group_layout: &BindGroupLayout,
        texture_views: [&TextureView; EXTERNAL_TEXTURE_SLOT_COUNT],
        samplers: [&Sampler; EXTERNAL_TEXTURE_SLOT_COUNT],
        wgpu_external_texture: Option<wgpu::BindingResource<'_>>,
    ) -> BindGroup {
        let mut entries = vec![
            wgpu::BindGroupEntry {
                binding: 0,
                resource: wgpu::BindingResource::TextureView(texture_views[0]),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: wgpu::BindingResource::Sampler(samplers[0]),
            },
        ];
        if let Some(resource) = wgpu_external_texture {
            entries.push(wgpu::BindGroupEntry {
                binding: 2,
                resource,
            });
        }
        device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("External Texture Bind Group"),
            layout: external_texture_bind_group_layout,
            entries: &entries,
        })
    }

    fn create_strip_bind_group(
        device: &Device,
        strip_bind_group_layout: &BindGroupLayout,
        alphas_texture_view: &TextureView,
        config_buffer: &Buffer,
        strip_texture_view: &TextureView,
    ) -> BindGroup {
        device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Strip Bind Group"),
            layout: strip_bind_group_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(alphas_texture_view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                        buffer: config_buffer,
                        offset: 0,
                        size: Some(SIZE_OF_CONFIG),
                    }),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::TextureView(strip_texture_view),
                },
            ],
        })
    }

    /// Bind a [`wgpu::ExternalTexture`] to the `texture_external` binding and any other texture to
    /// the regular texture binding, with the placeholder in the unused one.
    fn create_run_external_texture_bind_group(
        &self,
        device: &Device,
        placeholder: &TextureView,
        bindings: &[TextureBinding; EXTERNAL_TEXTURE_SLOT_COUNT],
        samplers: [&Sampler; EXTERNAL_TEXTURE_SLOT_COUNT],
    ) -> BindGroup {
        let [binding] = bindings;
        let (texture_view, wgpu_external_texture) = match binding {
            TextureBinding::TextureView(view) => (
                view,
                self.strip
                    .wgpu_external_textures
                    .then_some(wgpu::BindingResource::TextureView(placeholder)),
            ),
            #[cfg(feature = "wgpu_external_texture")]
            TextureBinding::WgpuExternalTexture { texture, .. } => (
                placeholder,
                Some(wgpu::BindingResource::ExternalTexture(texture)),
            ),
        };
        Self::create_external_texture_bind_group(
            device,
            &self.strip.external_texture_bind_group_layout,
            [texture_view],
            samplers,
            wgpu_external_texture,
        )
    }
}

impl GpuResources {
    /// Uploads two strip slices (opaque then alpha) into the batched frame arena and
    /// returns the byte range of the uploaded data.
    ///
    /// Drawpane: stages strips into CPU memory (uploaded once before `queue.submit`) and
    /// offsets strip alpha/paint indices for multi-render encoder batching.
    fn upload_strip_pair(
        &mut self,
        opaque_strips: &[GpuStrip],
        alpha_strips: RangedSlice<'_, GpuStrip>,
        alpha_col_base: u32,
        paint_base_texel: u32,
    ) -> Range<u64> {
        let opaque_len = size_of_val(opaque_strips) as u64;
        let alpha_len = (alpha_strips.len() * size_of::<GpuStrip>()) as u64;
        let total_len = opaque_len + alpha_len;
        if total_len == 0 {
            return 0..0;
        }

        const RECT_STRIP_FLAG: u32 = 1 << 31;
        let offset = self.strips_arena.alloc(total_len);
        self.strips_staging.resize(offset as usize, 0);
        if alpha_col_base == 0 && paint_base_texel == 0 {
            if opaque_len > 0 {
                self.strips_staging
                    .extend_from_slice(bytemuck::cast_slice(opaque_strips));
            }
            for strips in alpha_strips.slices() {
                self.strips_staging
                    .extend_from_slice(bytemuck::cast_slice(strips));
            }
        } else {
            let rebase = |mut s: GpuStrip| -> GpuStrip {
                if alpha_col_base > 0
                    && (s.paint_and_rect_flag & RECT_STRIP_FLAG) == 0
                    && s.dense_width_or_rect_height != 0
                {
                    s.col_idx_or_rect_frac += alpha_col_base;
                }
                if paint_base_texel > 0
                    && ((s.paint_and_rect_flag >> 29) & 0x3) == 0
                    && ((s.paint_and_rect_flag >> 26) & 0x7) != 0
                {
                    s.paint_and_rect_flag += paint_base_texel;
                }
                s
            };
            for &strip in opaque_strips {
                let rebased = rebase(strip);
                self.strips_staging
                    .extend_from_slice(bytemuck::bytes_of(&rebased));
            }
            for strips in alpha_strips.slices() {
                for &strip in strips {
                    let rebased = rebase(strip);
                    self.strips_staging
                        .extend_from_slice(bytemuck::bytes_of(&rebased));
                }
            }
        }

        offset..offset + total_len
    }
}

impl RendererContext<'_> {
    fn external_texture_cache_key(
        texture_bindings: &crate::render::wgpu::TextureBindings,
        bindings: ExternalTextureBindings,
    ) -> (ExternalTextureBindings, [u64; EXTERNAL_TEXTURE_SLOT_COUNT]) {
        let texture_sources = bindings.as_array();
        let versions = core::array::from_fn(|slot| match texture_sources[slot] {
            Some(TextureSourceId::External(texture_id, _)) => texture_bindings
                .get_versioned(texture_id)
                .expect("external texture binding was validated during paint preparation")
                .1,
            _ => 0,
        });
        (bindings, versions)
    }

    fn ensure_external_texture_bind_group(&mut self, bindings: ExternalTextureBindings) {
        let key = Self::external_texture_cache_key(self.texture_bindings, bindings);
        if self.resources.external_texture_bind_groups.contains_key(&key) {
            return;
        }
        let texture_sources = bindings.as_array();
        let placeholder = self.resources.placeholder_external_texture_view.clone();
        let slot_bindings = core::array::from_fn(|slot| match texture_sources[slot] {
            Some(TextureSourceId::Atlas(atlas_id)) => TextureBinding::TextureView(
                self.resources.atlas_texture_views[atlas_id.as_u32() as usize].clone(),
            ),
            Some(TextureSourceId::External(texture_id, _)) => self
                .texture_bindings
                .get(texture_id)
                .expect("external texture binding was validated during paint preparation")
                .clone(),
            None => TextureBinding::TextureView(placeholder.clone()),
        });
        let sampler_keys = texture_sources.map(|source| match source {
            Some(TextureSourceId::External(_, sampler)) => sampler,
            _ => ExternalSampler::DEFAULT,
        });
        let samplers = sampler_keys.map(|skey| {
            self.resources
                .external_samplers
                .entry(skey)
                .or_insert_with(|| GpuResources::create_external_sampler(self.device, skey))
                .clone()
        });
        let bind_group = self.programs.create_run_external_texture_bind_group(
            self.device,
            &placeholder,
            &slot_bindings,
            samplers.each_ref(),
        );
        if let Entry::Vacant(entry) = self.resources.external_texture_bind_groups.entry(key) {
            entry.insert(bind_group);
        }
    }

    /// Render the strips to the specified render target.
    pub(crate) fn strip_pass_inner(
        &mut self,
        opaque_strips: &[GpuStrip],
        alpha_strips: RangedSlice<'_, GpuStrip>,
        external_texture_runs: &[ExternalTextureRun],
        target: DrawPassTarget,
        child_layer_texture: Option<LayerTextureId>,
    ) {
        let opaque_count = opaque_strips.len();
        let alpha_count = alpha_strips.len();

        if opaque_count == 0 && alpha_count == 0 {
            return;
        }
        // Ensure cached bind groups exist for all external textures used by this pass.
        for run in external_texture_runs {
            self.ensure_external_texture_bind_group(run.bindings);
        }

        let strips_range = self.resources.upload_strip_pair(
            opaque_strips,
            alpha_strips,
            self.alpha_col_base,
            self.paint_base_texel,
        );
        let opaque_count = opaque_count as u32;
        let alpha_count = alpha_count as u32;

        let color_load_op = if matches!(target, DrawPassTarget::Root(_)) {
            self.take_root_load_op()
        } else {
            // For layer targets we always want to load.
            wgpu::LoadOp::Load
        };
        let enable_opaque = self.depth_view.is_some() && target.enable_opaque();

        let depth_stencil_attachment = if enable_opaque {
            let depth_load = if self.resources.depth_cleared_this_frame {
                wgpu::LoadOp::Load
            } else {
                self.resources.depth_cleared_this_frame = true;
                wgpu::LoadOp::Clear(1.0)
            };
            Some(wgpu::RenderPassDepthStencilAttachment {
                view: self
                    .depth_view
                    .expect("enabled depth buffering requires a depth texture view"),
                depth_ops: Some(wgpu::Operations {
                    load: depth_load,
                    store: wgpu::StoreOp::Store,
                }),
                stencil_ops: None,
            })
        } else {
            None
        };

        let bind_group_target = match target {
            DrawPassTarget::Root(_) => StripTargetKind::Root,
            DrawPassTarget::Layer(_) => StripTargetKind::Layer,
        };
        let bind_group_key = (bind_group_target, child_layer_texture);
        if !self
            .resources
            .strip_layer_bind_groups
            .contains_key(&bind_group_key)
        {
            let resources = &*self.resources;
            let config_buffer = match target {
                DrawPassTarget::Root(_) => &resources.view_config_buffer,
                DrawPassTarget::Layer(_) => &resources.layer_config_buffer,
            };
            let child_layer_view = child_layer_texture
                .map_or(&resources.placeholder_external_texture_view, |id| {
                    resources.layer_view(id)
                });
            let alphas_texture_view = resources
                .alphas_texture
                .texture()
                .create_view(&TextureViewDescriptor::default());
            let bind_group = Programs::create_strip_bind_group(
                self.device,
                &self.programs.strip.bind_group_layout,
                &alphas_texture_view,
                config_buffer,
                child_layer_view,
            );
            self.resources
                .strip_layer_bind_groups
                .insert(bind_group_key, bind_group);
        }

        let config_offset = match target {
            DrawPassTarget::Root(_) => self.view_config_offset,
            DrawPassTarget::Layer(_) => 0,
        };
        let resources = &*self.resources;
        let texture_bindings = self.texture_bindings;
        let view = match target {
            DrawPassTarget::Root(_) => self.view,
            DrawPassTarget::Layer(id) => resources.layer_view(id),
        };
        let bind_group = &resources.strip_layer_bind_groups[&bind_group_key];
        let mut draws = 0u32;

        {
            let mut render_pass = self.encoder.begin_render_pass(&RenderPassDescriptor {
                label: Some("Render to Texture Pass"),
                color_attachments: &[Some(RenderPassColorAttachment {
                    view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: color_load_op,
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment,
                occlusion_query_set: None,
                timestamp_writes: None,
                multiview_mask: None,
            });
            render_pass.set_bind_group(0, bind_group, &[config_offset]);
            render_pass.set_bind_group(
                2,
                &resources.encoded_paints_texture.texture().bind_group,
                &[],
            );
            render_pass.set_bind_group(3, &resources.gradient_texture.texture().bind_group, &[]);
            render_pass.set_vertex_buffer(0, resources.strips_arena.buffer.slice(strips_range.clone()));

            let mut draw_strip_runs = |render_pass: &mut wgpu::RenderPass<'_>, first_instance, count| {
                if external_texture_runs.is_empty() {
                    render_pass.set_bind_group(1, &resources.empty_external_texture_bind_group, &[]);
                    render_pass.draw(0..4, first_instance..first_instance + count);
                    draws += 1;
                    return;
                }

                // Each run is drawn with different external texture bindings. Runs go from
                // `run.strips_start` to the next run's `strips_start`; the last run goes to the end of
                // the strips buffer.
                for (i, run) in external_texture_runs.iter().enumerate() {
                    let key = Self::external_texture_cache_key(texture_bindings, run.bindings);
                    let external_texture_bind_group = resources
                        .external_texture_bind_groups
                        .get(&key)
                        .unwrap();
                    render_pass.set_bind_group(1, external_texture_bind_group, &[]);
                    let start = u32::try_from(run.strips_start).unwrap();
                    let end = external_texture_runs
                        .get(i + 1)
                        .map_or(count, |next| u32::try_from(next.strips_start).unwrap());
                    render_pass.draw(0..4, first_instance + start..first_instance + end);
                    draws += 1;
                }
            };

            if opaque_count > 0 {
                // Opaque pass
                debug_assert!(
                    enable_opaque,
                    "opaque strips require the final view depth attachment"
                );
                render_pass.set_pipeline(&self.programs.strip.opaque);
                draw_strip_runs(&mut render_pass, 0, opaque_count);
            }

            if alpha_count > 0 {
                // Alpha pass
                if matches!(target, DrawPassTarget::Root(RootTarget::UserSurface)) {
                    let pipeline = if enable_opaque {
                        &self.programs.strip.depth_alpha
                    } else {
                        &self.programs.strip.alpha
                    };
                    render_pass.set_pipeline(pipeline);
                } else {
                    render_pass.set_pipeline(&self.programs.strip.intermediate);
                }

                draw_strip_runs(&mut render_pass, opaque_count, alpha_count);
            }
        }
        self.draws += draws;
    }
}
