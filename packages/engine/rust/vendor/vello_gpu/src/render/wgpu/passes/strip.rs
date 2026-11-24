// Copyright 2025 the Vello Authors
// SPDX-License-Identifier: Apache-2.0 OR MIT

//! The strip pass.

use crate::draw::{
    BlendRun, EXTERNAL_TEXTURE_SLOT_COUNT, ExternalTextureBindings, ExternalTextureRun,
};
use crate::render::wgpu::RenderTargetConfig;
use crate::render::wgpu::bindings::TextureBinding;
use crate::render::wgpu::passes::{Programs, RendererContext};
use crate::render::wgpu::resources::{GpuResources, SIZE_OF_CONFIG};
use crate::scene::HwBlendMode;
use crate::util::RangedSlice;
use crate::{
    GpuStrip,
    paint::{ExternalSampler, TextureSourceId},
    target::{DrawPassTarget, LayerTextureId, RootTarget},
};
use alloc::{format, string::String, vec, vec::Vec};
use core::{fmt::Debug, ops::Range};
use hashbrown::hash_map::Entry;
use wgpu::{
    BindGroup, BindGroupLayout, BlendComponent, BlendFactor, BlendOperation, BlendState, Buffer,
    ColorTargetState, ColorWrites, Device, PipelineCompilationOptions, RenderPassColorAttachment,
    RenderPassDescriptor, RenderPipeline, Sampler, TextureView, TextureViewDescriptor,
};

/// Drawpane: byte ranges locating `@fragment fn fs_main(...) -> @location(0) vec4<f32> { ... }`
/// inside `vello_gpu_shaders`'s WGSL strip shader.
#[derive(Debug, Clone, Copy)]
struct FsMainSpan {
    attr_start: usize,
    params_start: usize,
    params_end: usize,
    body_start: usize,
}

const fn is_ident_start(b: u8) -> bool {
    b.is_ascii_alphabetic() || b == b'_'
}

const fn is_ident_continue(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

/// Skips WGSL whitespace, `// ...` line comments, and nested `/* ... */` block comments.
const fn skip_wgsl_trivia(bytes: &[u8], mut i: usize) -> Option<usize> {
    let n = bytes.len();
    while i < n {
        let b = bytes[i];
        if b.is_ascii_whitespace() {
            i += 1;
        } else if b == b'/' && i + 1 < n && bytes[i + 1] == b'/' {
            i += 2;
            while i < n && bytes[i] != b'\n' {
                i += 1;
            }
        } else if b == b'/' && i + 1 < n && bytes[i + 1] == b'*' {
            i += 2;
            let mut depth = 1usize;
            while i < n && depth > 0 {
                if bytes[i] == b'/' && i + 1 < n && bytes[i + 1] == b'*' {
                    depth += 1;
                    i += 2;
                } else if bytes[i] == b'*' && i + 1 < n && bytes[i + 1] == b'/' {
                    depth -= 1;
                    i += 2;
                } else {
                    i += 1;
                }
            }
            if depth != 0 {
                return None;
            }
        } else {
            break;
        }
    }
    Some(i)
}

const fn eat_keyword(bytes: &[u8], pos: usize, kw: &[u8]) -> Option<usize> {
    let i = match skip_wgsl_trivia(bytes, pos) {
        Some(p) => p,
        None => return None,
    };
    if i + kw.len() > bytes.len() {
        return None;
    }
    let mut k = 0;
    while k < kw.len() {
        if bytes[i + k] != kw[k] {
            return None;
        }
        k += 1;
    }
    let end = i + kw.len();
    if end < bytes.len() && is_ident_continue(bytes[end]) {
        return None;
    }
    Some(end)
}

const fn eat_punct(bytes: &[u8], pos: usize, punct: &[u8]) -> Option<usize> {
    let i = match skip_wgsl_trivia(bytes, pos) {
        Some(p) => p,
        None => return None,
    };
    if i + punct.len() > bytes.len() {
        return None;
    }
    let mut k = 0;
    while k < punct.len() {
        if bytes[i + k] != punct[k] {
            return None;
        }
        k += 1;
    }
    Some(i + punct.len())
}

const fn find_matching_delim(bytes: &[u8], open_pos: usize, open: u8, close: u8) -> Option<usize> {
    let n = bytes.len();
    let mut i = open_pos + 1;
    let mut depth = 1usize;
    while i < n {
        if bytes[i] == b'/' && i + 1 < n && (bytes[i + 1] == b'/' || bytes[i + 1] == b'*') {
            i = match skip_wgsl_trivia(bytes, i) {
                Some(p) => p,
                None => return None,
            };
            continue;
        }
        if bytes[i] == open {
            depth += 1;
        } else if bytes[i] == close {
            depth -= 1;
            if depth == 0 {
                return Some(i);
            }
        }
        i += 1;
    }
    None
}

/// Validates a single WGSL parameter segment (`[@attr(...)]* ident : type`) and returns the
/// `(ident_start, ident_end, colon_pos)` byte offsets relative to `bytes`.
const fn parse_param_segment(bytes: &[u8], start: usize, end: usize) -> Option<(usize, usize, usize)> {
    let mut i = match skip_wgsl_trivia(bytes, start) {
        Some(p) => p,
        None => return None,
    };
    if i >= end {
        return None;
    }
    let mut colon = None;
    let mut pdepth = 0usize;
    let mut scan = i;
    while scan < end {
        if bytes[scan] == b'/' && scan + 1 < end && (bytes[scan + 1] == b'/' || bytes[scan + 1] == b'*') {
            scan = match skip_wgsl_trivia(bytes, scan) {
                Some(p) => p,
                None => return None,
            };
            continue;
        }
        if bytes[scan] == b'(' {
            pdepth += 1;
        } else if bytes[scan] == b')' {
            if pdepth == 0 {
                return None;
            }
            pdepth -= 1;
        } else if bytes[scan] == b':' && pdepth == 0 {
            colon = Some(scan);
            break;
        }
        scan += 1;
    }
    let colon = match colon {
        Some(c) => c,
        None => return None,
    };
    while i < colon {
        i = match skip_wgsl_trivia(bytes, i) {
            Some(p) => p,
            None => return None,
        };
        if i >= colon {
            return None;
        }
        if bytes[i] == b'@' {
            i += 1;
            i = match skip_wgsl_trivia(bytes, i) {
                Some(p) => p,
                None => return None,
            };
            if i >= colon || !is_ident_start(bytes[i]) {
                return None;
            }
            while i < colon && is_ident_continue(bytes[i]) {
                i += 1;
            }
            let after_name = match skip_wgsl_trivia(bytes, i) {
                Some(p) => p,
                None => return None,
            };
            if after_name < colon && bytes[after_name] == b'(' {
                let close = match find_matching_delim(bytes, after_name, b'(', b')') {
                    Some(c) if c < colon => c,
                    _ => return None,
                };
                i = close + 1;
            } else {
                i = after_name;
            }
        } else {
            break;
        }
    }
    if i >= colon || !is_ident_start(bytes[i]) {
        return None;
    }
    let ident_start = i;
    while i < colon && is_ident_continue(bytes[i]) {
        i += 1;
    }
    let ident_end = i;
    let after_ident = match skip_wgsl_trivia(bytes, ident_end) {
        Some(p) => p,
        None => return None,
    };
    if after_ident != colon {
        return None;
    }
    let ty_start = match skip_wgsl_trivia(bytes, colon + 1) {
        Some(p) => p,
        None => return None,
    };
    if ty_start >= end {
        return None;
    }
    Some((ident_start, ident_end, colon))
}

/// Validates every comma-separated parameter in `bytes[params_start..params_end]`.
const fn validate_params(bytes: &[u8], params_start: usize, params_end: usize) -> bool {
    let mut seg_start = params_start;
    let mut i = params_start;
    let mut pdepth = 0usize;
    while i < params_end {
        if bytes[i] == b'/' && i + 1 < params_end && (bytes[i + 1] == b'/' || bytes[i + 1] == b'*') {
            i = match skip_wgsl_trivia(bytes, i) {
                Some(p) => p,
                None => return false,
            };
            continue;
        }
        if bytes[i] == b'(' {
            pdepth += 1;
        } else if bytes[i] == b')' {
            if pdepth == 0 {
                return false;
            }
            pdepth -= 1;
        } else if bytes[i] == b',' && pdepth == 0 {
            if parse_param_segment(bytes, seg_start, i).is_none() {
                return false;
            }
            seg_start = i + 1;
        }
        i += 1;
    }
    if pdepth != 0 {
        return false;
    }
    let trailing = match skip_wgsl_trivia(bytes, seg_start) {
        Some(p) => p,
        None => return false,
    };
    if trailing < params_end {
        parse_param_segment(bytes, seg_start, params_end).is_some()
    } else {
        true
    }
}

/// Drawpane: token-aware `const fn` parser that locates and structurally validates
/// `@fragment fn fs_main(...) -> @location(0) vec4<f32> { ... }` in `vello_gpu_shaders`.
/// Run both at compile time (via `const _: () = ...`) and at shader build time.
const fn parse_fs_main(source: &str) -> Option<FsMainSpan> {
    let bytes = source.as_bytes();
    let n = bytes.len();
    let mut i = 0usize;
    while i < n {
        i = match skip_wgsl_trivia(bytes, i) {
            Some(p) => p,
            None => return None,
        };
        if i >= n {
            break;
        }
        if bytes[i] == b'@' {
            let attr_start = i;
            if let Some(after_frag) = eat_keyword(bytes, i + 1, b"fragment")
                && let Some(after_fn) = eat_keyword(bytes, after_frag, b"fn")
                && let Some(after_name) = eat_keyword(bytes, after_fn, b"fs_main")
                && let Some(after_open) = eat_punct(bytes, after_name, b"(")
            {
                let open_pos = after_open - 1;
                let params_end = match find_matching_delim(bytes, open_pos, b'(', b')') {
                    Some(p) => p,
                    None => return None,
                };
                if !validate_params(bytes, after_open, params_end) {
                    return None;
                }
                let after_arrow = match eat_punct(bytes, params_end + 1, b"->") {
                    Some(p) => p,
                    None => return None,
                };
                let after_at = match eat_punct(bytes, after_arrow, b"@") {
                    Some(p) => p,
                    None => return None,
                };
                let after_loc = match eat_keyword(bytes, after_at, b"location") {
                    Some(p) => p,
                    None => return None,
                };
                let after_lp = match eat_punct(bytes, after_loc, b"(") {
                    Some(p) => p,
                    None => return None,
                };
                let after_zero = match eat_punct(bytes, after_lp, b"0") {
                    Some(p) => p,
                    None => return None,
                };
                let after_rp = match eat_punct(bytes, after_zero, b")") {
                    Some(p) => p,
                    None => return None,
                };
                let after_vec = match eat_keyword(bytes, after_rp, b"vec4") {
                    Some(p) => p,
                    None => return None,
                };
                let after_lt = match eat_punct(bytes, after_vec, b"<") {
                    Some(p) => p,
                    None => return None,
                };
                let after_f32 = match eat_keyword(bytes, after_lt, b"f32") {
                    Some(p) => p,
                    None => return None,
                };
                let after_gt = match eat_punct(bytes, after_f32, b">") {
                    Some(p) => p,
                    None => return None,
                };
                let after_brace = match eat_punct(bytes, after_gt, b"{") {
                    Some(p) => p,
                    None => return None,
                };
                let body_start = after_brace - 1;
                if find_matching_delim(bytes, body_start, b'{', b'}').is_none() {
                    return None;
                }
                return Some(FsMainSpan {
                    attr_start,
                    params_start: after_open,
                    params_end,
                    body_start,
                });
            }
        }
        i += 1;
    }
    None
}

// Drawpane: fail at compile time if upstream `vello_gpu_shaders` changes `fs_main`'s signature.
const _: () = {
    if parse_fs_main(vello_gpu_shaders::wgsl::RENDER).is_none() {
        panic!("vello_gpu strip shader (RENDER) fs_main signature changed");
    }
    #[cfg(feature = "wgpu_external_texture")]
    if parse_fs_main(vello_gpu_shaders::wgsl::RENDER_TEXTURE_EXTERNAL).is_none() {
        panic!("vello_gpu strip shader (RENDER_TEXTURE_EXTERNAL) fs_main signature changed");
    }
};

/// Drawpane: rewrites `vello_gpu_shaders`'s `fs_main` fragment entry point into a shared
/// helper `drawpane_strip_color` and appends quantized fragment entry points for
/// `linear_burn` and `linear_dodge` in the same WGSL module.
fn build_strip_shader_with_hw_blends(source: &str) -> String {
    let span =
        parse_fs_main(source).expect("vello_gpu strip shader fs_main signature failed validation");
    let bytes = source.as_bytes();
    let params_raw = &source[span.params_start..span.params_end];

    let mut clean_params = Vec::new();
    let mut call_args = Vec::new();
    let mut seg_start = span.params_start;
    let mut i = span.params_start;
    let mut pdepth = 0usize;
    let mut emit_param = |start: usize, end: usize| {
        if let Some((ident_start, ident_end, colon)) = parse_param_segment(bytes, start, end) {
            let ident = &source[ident_start..ident_end];
            let ty = source[colon + 1..end].trim();
            clean_params.push(format!("{ident}:{ty}"));
            call_args.push(ident);
        }
    };
    while i < span.params_end {
        if bytes[i] == b'/' && i + 1 < span.params_end && (bytes[i + 1] == b'/' || bytes[i + 1] == b'*') {
            i = skip_wgsl_trivia(bytes, i).unwrap_or(span.params_end);
            continue;
        }
        match bytes[i] {
            b'(' => pdepth += 1,
            b')' => pdepth = pdepth.saturating_sub(1),
            b',' if pdepth == 0 => {
                emit_param(seg_start, i);
                seg_start = i + 1;
            }
            _ => {}
        }
        i += 1;
    }
    emit_param(seg_start, span.params_end);

    let clean_params_str = clean_params.join(",");
    let call_args_str = call_args.join(",");
    let prefix = &source[..span.attr_start];
    let body_and_rest = &source[span.body_start..];
    format!(
        "{prefix}fn drawpane_strip_color({clean_params_str})->vec4<f32>{body_and_rest}\n\
         @fragment fn fs_main({params_raw})->@location(0)vec4<f32>{{return drawpane_strip_color({call_args_str});}}\n\
         @fragment fn fs_main_linear_burn({params_raw})->@location(0)vec4<f32>{{\
             let c=drawpane_strip_color({call_args_str});\
             let d=max(ceil(clamp((c.a-c.rgb)*255.0,vec3<f32>(0.0),vec3<f32>(255.0))-0.5001),vec3<f32>(0.0))/255.0;\
             return vec4<f32>(d,c.a);\
         }}\n\
         @fragment fn fs_main_linear_dodge({params_raw})->@location(0)vec4<f32>{{\
             let c=drawpane_strip_color({call_args_str});\
             let s=floor(clamp(c.rgb*255.0,vec3<f32>(0.0),vec3<f32>(255.0))+0.5)/255.0;\
             return vec4<f32>(s,c.a);\
         }}\n"
    )
}

/// Drawpane: returns the patched WGSL source for the strip shader (matching `StripPipelines::new`).
pub(crate) fn strip_shader_wgsl(wgpu_external_textures: bool) -> String {
    #[cfg(feature = "wgpu_external_texture")]
    let raw = if wgpu_external_textures {
        vello_gpu_shaders::wgsl::RENDER_TEXTURE_EXTERNAL
    } else {
        vello_gpu_shaders::wgsl::RENDER
    };
    #[cfg(not(feature = "wgpu_external_texture"))]
    let raw = {
        let _ = wgpu_external_textures;
        vello_gpu_shaders::wgsl::RENDER
    };
    build_strip_shader_with_hw_blends(raw)
}

const ALPHA_SRC_OVER: BlendComponent = BlendComponent {
    src_factor: BlendFactor::One,
    dst_factor: BlendFactor::OneMinusSrcAlpha,
    operation: BlendOperation::Add,
};

/// Drawpane: `(name, fragment_entry, blend_state)` indexed by [`HwBlendMode::non_normal_index`].
const HW_BLEND_SPECS: [(&str, &str, BlendState); HwBlendMode::NON_NORMAL_COUNT] = [
    (
        "Multiply",
        "fs_main",
        BlendState {
            color: BlendComponent {
                src_factor: BlendFactor::Dst,
                dst_factor: BlendFactor::OneMinusSrcAlpha,
                operation: BlendOperation::Add,
            },
            alpha: ALPHA_SRC_OVER,
        },
    ),
    (
        "Screen",
        "fs_main",
        BlendState {
            color: BlendComponent {
                src_factor: BlendFactor::One,
                dst_factor: BlendFactor::OneMinusSrc,
                operation: BlendOperation::Add,
            },
            alpha: ALPHA_SRC_OVER,
        },
    ),
    (
        "LinearDodge",
        "fs_main_linear_dodge",
        BlendState {
            color: BlendComponent {
                src_factor: BlendFactor::One,
                dst_factor: BlendFactor::One,
                operation: BlendOperation::Add,
            },
            alpha: ALPHA_SRC_OVER,
        },
    ),
    (
        "LinearBurn",
        "fs_main_linear_burn",
        BlendState {
            color: BlendComponent {
                src_factor: BlendFactor::One,
                dst_factor: BlendFactor::One,
                operation: BlendOperation::ReverseSubtract,
            },
            alpha: ALPHA_SRC_OVER,
        },
    ),
];

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
    /// Drawpane: retained shader, layout, and format for lazy HW-blend pipeline creation.
    shader: wgpu::ShaderModule,
    pipeline_layout: wgpu::PipelineLayout,
    target_format: wgpu::TextureFormat,
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

        let strip_shader_source = strip_shader_wgsl(wgpu_external_textures);
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

        let create_strip_pipeline = |label: &str,
                                     entry_point: &str,
                                     format,
                                     blend,
                                     depth_stencil: Option<wgpu::DepthStencilState>| {
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
                        entry_point: Some(entry_point),
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
            "fs_main",
            wgpu::TextureFormat::Rgba8Unorm,
            Some(BlendState::PREMULTIPLIED_ALPHA_BLENDING),
            None,
        );

        let alpha_strip_pipeline = create_strip_pipeline(
            "Strip Alpha Pipeline",
            "fs_main",
            render_target_config.format,
            Some(BlendState::PREMULTIPLIED_ALPHA_BLENDING),
            None,
        );

        let depth_alpha_strip_pipeline = create_strip_pipeline(
            "Strip Depth Alpha Pipeline",
            "fs_main",
            render_target_config.format,
            Some(BlendState::PREMULTIPLIED_ALPHA_BLENDING),
            Some(depth_stencil(false)),
        );

        let opaque_strip_pipeline = create_strip_pipeline(
            "Strip Opaque Pipeline",
            "fs_main",
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
            shader: strip_shader,
            pipeline_layout: strip_pipeline_layout,
            target_format: render_target_config.format,
        }
    }

    /// Drawpane: lazily builds a fixed-function hardware blend strip pipeline for the given
    /// target format and depth attachment mode.
    pub(crate) fn create_hw_blend_pipeline(
        &self,
        device: &Device,
        mode: HwBlendMode,
        with_depth: bool,
        format: wgpu::TextureFormat,
    ) -> RenderPipeline {
        let idx = mode
            .non_normal_index()
            .expect("create_hw_blend_pipeline requires non-Normal HwBlendMode");
        let (name, entry, blend) = HW_BLEND_SPECS[idx];
        let label = if with_depth {
            format!("Strip Depth Alpha {name} Pipeline")
        } else {
            format!("Strip Alpha {name} Pipeline")
        };
        let strip_vertex_state = wgpu::VertexBufferLayout {
            array_stride: size_of::<GpuStrip>() as u64,
            step_mode: wgpu::VertexStepMode::Instance,
            attributes: &GpuStrip::vertex_attributes(),
        };
        let depth_stencil = with_depth.then_some(wgpu::DepthStencilState {
            format: wgpu::TextureFormat::Depth24Plus,
            depth_write_enabled: Some(false),
            depth_compare: Some(wgpu::CompareFunction::LessEqual),
            stencil: wgpu::StencilState::default(),
            bias: wgpu::DepthBiasState::default(),
        });
        device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some(&label),
            layout: Some(&self.pipeline_layout),
            vertex: wgpu::VertexState {
                module: &self.shader,
                entry_point: Some("vs_main"),
                buffers: &[Some(strip_vertex_state)],
                compilation_options: PipelineCompilationOptions::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &self.shader,
                entry_point: Some(entry),
                targets: &[Some(ColorTargetState {
                    format,
                    blend: Some(blend),
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
            cache: None,
        })
    }

    /// Drawpane: creates a root-target HW blend pipeline using `self.target_format`.
    pub(crate) fn create_root_hw_blend_pipeline(
        &self,
        device: &Device,
        mode: HwBlendMode,
        with_depth: bool,
    ) -> RenderPipeline {
        self.create_hw_blend_pipeline(device, mode, with_depth, self.target_format)
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
        blend_runs: &[BlendRun],
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

        let is_root = matches!(target, DrawPassTarget::Root(_));
        let color_load_op = if is_root {
            self.take_root_load_op()
        } else {
            // For layer targets we always want to load.
            wgpu::LoadOp::Load
        };
        let enable_opaque = self.depth_view.is_some() && target.enable_opaque();
        let depth_load = enable_opaque.then(|| {
            if self.resources.depth_cleared_this_frame {
                wgpu::LoadOp::Load
            } else {
                self.resources.depth_cleared_this_frame = true;
                wgpu::LoadOp::Clear(1.0)
            }
        });

        let secondary_pass = if is_root {
            self.secondary.as_mut().map(|sec| {
                let sec_load = core::mem::replace(&mut sec.load_op, wgpu::LoadOp::Load);
                let sec_enable_opaque = sec.depth_view.is_some() && target.enable_opaque();
                let sec_depth_load = sec_enable_opaque.then(|| {
                    if self.resources.secondary_depth_cleared_this_frame {
                        wgpu::LoadOp::Load
                    } else {
                        self.resources.secondary_depth_cleared_this_frame = true;
                        wgpu::LoadOp::Clear(1.0)
                    }
                });
                (
                    sec.view,
                    sec.depth_view,
                    sec.view_config_offset,
                    sec_load,
                    sec_depth_load,
                )
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
        let is_user_root = matches!(target, DrawPassTarget::Root(RootTarget::UserSurface));
        if !blend_runs.is_empty() {
            if is_user_root {
                let need_depth = depth_load.is_some()
                    || secondary_pass
                        .as_ref()
                        .is_some_and(|(_, _, _, _, dl)| dl.is_some());
                let need_no_depth = depth_load.is_none()
                    || secondary_pass
                        .as_ref()
                        .is_some_and(|(_, _, _, _, dl)| dl.is_none());
                for run in blend_runs {
                    if let Some(idx) = run.mode.non_normal_index() {
                        if need_depth && self.resources.depth_hw_blend_pipelines[idx].is_none() {
                            self.resources.depth_hw_blend_pipelines[idx] = Some(
                                self.programs
                                    .strip
                                    .create_root_hw_blend_pipeline(self.device, run.mode, true),
                            );
                        }
                        if need_no_depth && self.resources.alpha_hw_blend_pipelines[idx].is_none() {
                            self.resources.alpha_hw_blend_pipelines[idx] = Some(
                                self.programs
                                    .strip
                                    .create_root_hw_blend_pipeline(self.device, run.mode, false),
                            );
                        }
                    }
                }
            } else {
                debug_assert!(
                    false,
                    "Drawpane: hardware blend runs are only valid on root UserSurface"
                );
                // Safe release fallback: execute requested HW blend modes on the Rgba8Unorm
                // intermediate layer target instead of silently falling back to normal blending.
                for run in blend_runs {
                    if let Some(idx) = run.mode.non_normal_index()
                        && self.resources.intermediate_hw_blend_pipelines[idx].is_none()
                    {
                        self.resources.intermediate_hw_blend_pipelines[idx] = Some(
                            self.programs.strip.create_hw_blend_pipeline(
                                self.device,
                                run.mode,
                                false,
                                wgpu::TextureFormat::Rgba8Unorm,
                            ),
                        );
                    }
                }
            }
        }
        let resources = &*self.resources;
        let programs = self.programs;
        let texture_bindings = self.texture_bindings;
        let primary_view = match target {
            DrawPassTarget::Root(_) => self.view,
            DrawPassTarget::Layer(id) => resources.layer_view(id),
        };
        let bind_group = &resources.strip_layer_bind_groups[&bind_group_key];

        let encode_pass = |encoder: &mut wgpu::CommandEncoder,
                           view: &TextureView,
                           depth_view: Option<&TextureView>,
                           pass_config_offset: u32,
                           pass_color_load: wgpu::LoadOp<wgpu::Color>,
                           pass_depth_load: Option<wgpu::LoadOp<f32>>|
         -> u32 {
            let pass_enable_opaque = pass_depth_load.is_some();
            let depth_stencil_attachment = pass_depth_load.map(|load| {
                wgpu::RenderPassDepthStencilAttachment {
                    view: depth_view
                        .expect("enabled depth buffering requires a depth texture view"),
                    depth_ops: Some(wgpu::Operations {
                        load,
                        store: wgpu::StoreOp::Store,
                    }),
                    stencil_ops: None,
                }
            });

            let mut draws = 0u32;
            let mut render_pass = encoder.begin_render_pass(&RenderPassDescriptor {
                label: Some("Render to Texture Pass"),
                color_attachments: &[Some(RenderPassColorAttachment {
                    view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: pass_color_load,
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment,
                occlusion_query_set: None,
                timestamp_writes: None,
                multiview_mask: None,
            });
            render_pass.set_bind_group(0, bind_group, &[pass_config_offset]);
            render_pass.set_bind_group(
                2,
                &resources.encoded_paints_texture.texture().bind_group,
                &[],
            );
            render_pass.set_bind_group(3, &resources.gradient_texture.texture().bind_group, &[]);
            render_pass.set_vertex_buffer(
                0,
                resources.strips_arena.buffer.slice(strips_range.clone()),
            );

            let mut draw_strip_runs = |render_pass: &mut wgpu::RenderPass<'_>,
                                       first_instance: u32,
                                       count: u32| {
                if external_texture_runs.is_empty() {
                    render_pass.set_bind_group(
                        1,
                        &resources.empty_external_texture_bind_group,
                        &[],
                    );
                    render_pass.draw(0..4, first_instance..first_instance + count);
                    draws += 1;
                    return;
                }

                // Each run is drawn with different external texture bindings. Runs go from
                // `run.strips_start` to the next run's `strips_start`; the last run goes to the
                // end of the strips buffer.
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
                    pass_enable_opaque,
                    "opaque strips require the final view depth attachment"
                );
                render_pass.set_pipeline(&programs.strip.opaque);
                draw_strip_runs(&mut render_pass, 0, opaque_count);
            }

            if alpha_count > 0 {
                if blend_runs.is_empty() {
                    if is_user_root {
                        let pipeline = if pass_enable_opaque {
                            &programs.strip.depth_alpha
                        } else {
                            &programs.strip.alpha
                        };
                        render_pass.set_pipeline(pipeline);
                    } else {
                        render_pass.set_pipeline(&programs.strip.intermediate);
                    }

                    draw_strip_runs(&mut render_pass, opaque_count, alpha_count);
                } else {
                    // Drawpane: merge-sweep `blend_runs` and `external_texture_runs` in exact
                    // painter's order inside this single render pass.
                    let pipeline_for = |mode: HwBlendMode| -> &RenderPipeline {
                        if is_user_root {
                            match mode.non_normal_index() {
                                Some(idx) if pass_enable_opaque => resources
                                    .depth_hw_blend_pipelines[idx]
                                    .as_ref()
                                    .expect("lazy depth HW blend pipeline must be initialized"),
                                Some(idx) => resources.alpha_hw_blend_pipelines[idx]
                                    .as_ref()
                                    .expect("lazy alpha HW blend pipeline must be initialized"),
                                None if pass_enable_opaque => &programs.strip.depth_alpha,
                                None => &programs.strip.alpha,
                            }
                        } else {
                            match mode.non_normal_index() {
                                Some(idx) => resources.intermediate_hw_blend_pipelines[idx]
                                    .as_ref()
                                    .expect(
                                        "lazy intermediate HW blend pipeline must be initialized",
                                    ),
                                None => &programs.strip.intermediate,
                            }
                        }
                    };
                    let mut bi = 0usize;
                    let mut ti = 0usize;
                    let mut pos = 0u32;
                    let mut cur_mode: Option<HwBlendMode> = None;
                    let mut cur_tex: Option<usize> = None;
                    while pos < alpha_count {
                        while bi + 1 < blend_runs.len()
                            && u32::try_from(blend_runs[bi + 1].strips_start).unwrap() <= pos
                        {
                            bi += 1;
                        }
                        let b_end = blend_runs
                            .get(bi + 1)
                            .map_or(alpha_count, |r| u32::try_from(r.strips_start).unwrap());
                        let mode = blend_runs[bi].mode;

                        let t_end = if external_texture_runs.is_empty() {
                            if cur_tex != Some(usize::MAX) {
                                render_pass.set_bind_group(
                                    1,
                                    &resources.empty_external_texture_bind_group,
                                    &[],
                                );
                                cur_tex = Some(usize::MAX);
                            }
                            alpha_count
                        } else {
                            while ti + 1 < external_texture_runs.len()
                                && u32::try_from(external_texture_runs[ti + 1].strips_start)
                                    .unwrap()
                                    <= pos
                            {
                                ti += 1;
                            }
                            if cur_tex != Some(ti) {
                                let key = Self::external_texture_cache_key(
                                    texture_bindings,
                                    external_texture_runs[ti].bindings,
                                );
                                let bg = resources
                                    .external_texture_bind_groups
                                    .get(&key)
                                    .unwrap();
                                render_pass.set_bind_group(1, bg, &[]);
                                cur_tex = Some(ti);
                            }
                            external_texture_runs
                                .get(ti + 1)
                                .map_or(alpha_count, |r| u32::try_from(r.strips_start).unwrap())
                        };

                        if cur_mode != Some(mode) {
                            render_pass.set_pipeline(pipeline_for(mode));
                            cur_mode = Some(mode);
                        }

                        let end = b_end.min(t_end);
                        if end > pos {
                            render_pass.draw(0..4, opaque_count + pos..opaque_count + end);
                            draws += 1;
                        }
                        pos = end;
                    }
                }
            }
            draws
        };

        self.draws += encode_pass(
            self.encoder,
            primary_view,
            self.depth_view,
            config_offset,
            color_load_op,
            depth_load,
        );
        if let Some((sec_view, sec_depth, sec_offset, sec_load, sec_depth_load)) = secondary_pass {
            self.draws += encode_pass(
                self.encoder,
                sec_view,
                sec_depth,
                sec_offset,
                sec_load,
                sec_depth_load,
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{build_strip_shader_with_hw_blends, parse_fs_main};

    #[test]
    fn strip_shader_adds_quantized_hw_blend_entry_points() {
        let patched = build_strip_shader_with_hw_blends(vello_gpu_shaders::wgsl::RENDER);
        assert!(patched.contains("fn drawpane_strip_color("));
        assert!(patched.contains("@fragment fn fs_main("));
        assert!(patched.contains("@fragment fn fs_main_linear_burn("));
        assert!(patched.contains("@fragment fn fs_main_linear_dodge("));
        assert!(!patched.contains("fn drawpane_strip_color(@"));
    }

    #[test]
    fn strip_shader_parser_handles_whitespace_comments_and_rejects_mismatched_signatures() {
        let formatted = r#"
            // comment mentioning @fragment fn fs_main()
            /* block /* nested */ @fragment fn fs_main() */
            @fragment
            fn fs_main(
                @builtin(position) pos: vec4<f32>,
                @location(0) @interpolate(flat, first) paint: u32,
            ) -> @location(0) vec4<f32> {
                return vec4<f32>(1.0);
            }
        "#;
        assert!(parse_fs_main(formatted).is_some());
        let patched = build_strip_shader_with_hw_blends(formatted);
        assert!(patched.contains("fn drawpane_strip_color(pos:vec4<f32>,paint:u32)->vec4<f32>"));
        assert!(patched.contains("drawpane_strip_color(pos,paint)"));

        let wrong_ret =
            "@fragment fn fs_main(@location(0) x: f32) -> vec4<f32> { return vec4<f32>(x); }";
        assert!(parse_fs_main(wrong_ret).is_none());
        let wrong_loc = "@fragment fn fs_main(@location(0) x: f32) -> @location(1) vec4<f32> { return vec4<f32>(x); }";
        assert!(parse_fs_main(wrong_loc).is_none());
        let wrong_name = "@fragment fn fs_main_other(@location(0) x: f32) -> @location(0) vec4<f32> { return vec4<f32>(x); }";
        assert!(parse_fs_main(wrong_name).is_none());
    }
}
