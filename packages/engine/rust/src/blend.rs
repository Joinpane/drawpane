//! All 17 non-normal blend modes (W3C Compositing and Blending Level 1 and decision 0038).
//!
//! Codes match `BLEND` in `packages/engine/src/wire.ts`:
//! - `0`: normal (`SrcOver`)
//! - `1..=11`: W3C separable (multiply, screen, overlay, darken, lighten, color-dodge, color-burn,
//!   hard-light, soft-light, difference, exclusion)
//! - `12..=15`: W3C non-separable HSL (hue, saturation, color, luminosity)
//! - `16`: Figma linear-dodge (Plus lighter): `c = min(a, cs + cb)`, `a = as + ab - as * ab`
//! - `17`: Figma linear-burn (Plus darker): `c = max(0, cs + cb - as * ab)`, `a = as + ab - as * ab`
//!
//! Paired verbatim with `blend.wgsl` (WebGL2 / GLSL ES 3.00 compatible pure fragment pass).

/// Internal-only composite mode (`18`): linear interpolation `b + (s - b) * opacity * clip_a`
/// used for faded pass-through frames (`through`, decision 0038) so untouched pixels stay
/// bit-identical to the backdrop at any backdrop alpha.
pub const BLEND_LERP: u32 = 18;

#[inline]
fn separable_ch(mode: u32, cb: f32, cs: f32) -> f32 {
    match mode {
        1 => cb * cs,
        2 => cb + cs - cb * cs,
        3 => {
            if cb <= 0.5 {
                2.0 * cb * cs
            } else {
                let s = 2.0 * cb - 1.0;
                cs + s - cs * s
            }
        }
        4 => cb.min(cs),
        5 => cb.max(cs),
        6 => {
            if cb <= 0.0 {
                0.0
            } else if cs >= 1.0 {
                1.0
            } else {
                (cb / (1.0 - cs)).min(1.0)
            }
        }
        7 => {
            if cb >= 1.0 {
                1.0
            } else if cs <= 0.0 {
                0.0
            } else {
                1.0 - ((1.0 - cb) / cs).min(1.0)
            }
        }
        8 => {
            if cs <= 0.5 {
                2.0 * cb * cs
            } else {
                let s = 2.0 * cs - 1.0;
                cb + s - cb * s
            }
        }
        9 => {
            if cs <= 0.5 {
                cb - (1.0 - 2.0 * cs) * cb * (1.0 - cb)
            } else {
                let d = if cb <= 0.25 {
                    ((16.0 * cb - 12.0) * cb + 4.0) * cb
                } else {
                    cb.max(0.0).sqrt()
                };
                cb + (2.0 * cs - 1.0) * (d - cb)
            }
        }
        10 => (cb - cs).abs(),
        11 => cb + cs - 2.0 * cb * cs,
        _ => cs,
    }
}

#[inline]
fn lum(c: [f32; 3]) -> f32 {
    0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2]
}

#[inline]
fn clip_color(mut c: [f32; 3]) -> [f32; 3] {
    let l = lum(c);
    let n = c[0].min(c[1]).min(c[2]);
    let x = c[0].max(c[1]).max(c[2]);
    if n < 0.0 {
        let d = l - n;
        if d > 1e-6 {
            for ch in &mut c {
                *ch = l + ((*ch - l) * l) / d;
            }
        } else {
            c = [l; 3];
        }
    }
    if x > 1.0 {
        let d = x - l;
        if d > 1e-6 {
            for ch in &mut c {
                *ch = l + ((*ch - l) * (1.0 - l)) / d;
            }
        } else {
            c = [l; 3];
        }
    }
    [c[0].clamp(0.0, 1.0), c[1].clamp(0.0, 1.0), c[2].clamp(0.0, 1.0)]
}

#[inline]
fn set_lum(c: [f32; 3], l: f32) -> [f32; 3] {
    let d = l - lum(c);
    clip_color([c[0] + d, c[1] + d, c[2] + d])
}

#[inline]
fn sat(c: [f32; 3]) -> f32 {
    c[0].max(c[1]).max(c[2]) - c[0].min(c[1]).min(c[2])
}

#[inline]
fn set_sat(c: [f32; 3], s: f32) -> [f32; 3] {
    let c_min = c[0].min(c[1]).min(c[2]);
    let c_max = c[0].max(c[1]).max(c[2]);
    let span = c_max - c_min;
    if span > 1e-6 {
        let scale = s / span;
        [(c[0] - c_min) * scale, (c[1] - c_min) * scale, (c[2] - c_min) * scale]
    } else {
        [0.0; 3]
    }
}

#[inline]
fn non_separable(mode: u32, cb: [f32; 3], cs: [f32; 3]) -> [f32; 3] {
    match mode {
        12 => set_lum(set_sat(cs, sat(cb)), lum(cb)),
        13 => set_lum(set_sat(cb, sat(cs)), lum(cb)),
        14 => set_lum(cs, lum(cb)),
        15 => set_lum(cb, lum(cs)),
        _ => cs,
    }
}

/// Blends premultiplied RGBA `s` over premultiplied RGBA `b` in `mode` (`0..=17`).
#[inline]
pub fn blend_pixel(mode: u32, s: [f32; 4], b: [f32; 4]) -> [f32; 4] {
    let sa = s[3];
    if sa <= 0.0 {
        return b;
    }
    let ba = b[3];
    if ba <= 0.0 {
        return [
            s[0].clamp(0.0, 1.0),
            s[1].clamp(0.0, 1.0),
            s[2].clamp(0.0, 1.0),
            sa.clamp(0.0, 1.0),
        ];
    }
    let a = (sa + ba - sa * ba).clamp(0.0, 1.0);
    if mode == 16 {
        return [
            (s[0] + b[0]).min(a).clamp(0.0, 1.0),
            (s[1] + b[1]).min(a).clamp(0.0, 1.0),
            (s[2] + b[2]).min(a).clamp(0.0, 1.0),
            a,
        ];
    }
    if mode == 17 {
        let sub = sa * ba;
        return [
            (s[0] + b[0] - sub).max(0.0).clamp(0.0, 1.0),
            (s[1] + b[1] - sub).max(0.0).clamp(0.0, 1.0),
            (s[2] + b[2] - sub).max(0.0).clamp(0.0, 1.0),
            a,
        ];
    }
    if mode == 0 {
        let inv = 1.0 - sa;
        return [
            (s[0] + b[0] * inv).clamp(0.0, 1.0),
            (s[1] + b[1] * inv).clamp(0.0, 1.0),
            (s[2] + b[2] * inv).clamp(0.0, 1.0),
            a,
        ];
    }
    let cs = [
        (s[0] / sa).clamp(0.0, 1.0),
        (s[1] / sa).clamp(0.0, 1.0),
        (s[2] / sa).clamp(0.0, 1.0),
    ];
    let cb = [
        (b[0] / ba).clamp(0.0, 1.0),
        (b[1] / ba).clamp(0.0, 1.0),
        (b[2] / ba).clamp(0.0, 1.0),
    ];
    let blended = if mode <= 11 {
        [
            separable_ch(mode, cb[0], cs[0]),
            separable_ch(mode, cb[1], cs[1]),
            separable_ch(mode, cb[2], cs[2]),
        ]
    } else {
        non_separable(mode, cb, cs)
    };
    let inv_ba = 1.0 - ba;
    let inv_sa = 1.0 - sa;
    let sa_ba = sa * ba;
    [
        (s[0] * inv_ba + b[0] * inv_sa + sa_ba * blended[0]).clamp(0.0, 1.0),
        (s[1] * inv_ba + b[1] * inv_sa + sa_ba * blended[1]).clamp(0.0, 1.0),
        (s[2] * inv_ba + b[2] * inv_sa + sa_ba * blended[2]).clamp(0.0, 1.0),
        a,
    ]
}

#[inline]
fn f32_to_u8(v: f32) -> u8 {
    (v.clamp(0.0, 1.0) * 255.0).round_ties_even() as u8
}

/// Blends `src` (size `w x h`, premultiplied RGBA8) over `dst` (size `dst_w x dst_h`,
/// premultiplied RGBA8) at pixel offset `(ox, oy)` in `dst`, scaled by `opacity` and optional
/// per-pixel clip coverage `clip` (size `w x h`, alpha channel used).
#[allow(clippy::too_many_arguments)]
pub fn blend_cpu(
    src: &[u8],
    dst: &mut [u8],
    dst_size: (u32, u32),
    src_size: (u32, u32),
    offset: (i32, i32),
    mode: u32,
    opacity: f32,
    clip: Option<&[u8]>,
) {
    composite_cpu(src, dst, dst_size, src_size, offset, mode, opacity, clip, None);
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn composite_cpu(
    src: &[u8],
    dst: &mut [u8],
    dst_size: (u32, u32),
    src_size: (u32, u32),
    offset: (i32, i32),
    mode: u32,
    opacity: f32,
    clip: Option<&[u8]>,
    mask: Option<(&[u8], u32)>,
) {
    let alpha = opacity.clamp(0.0, 1.0);
    if alpha <= 0.0 {
        return;
    }
    let (dw, dh) = (dst_size.0 as i32, dst_size.1 as i32);
    let (sw, sh) = (src_size.0 as i32, src_size.1 as i32);
    let x0 = (-offset.0).max(0);
    let y0 = (-offset.1).max(0);
    let x1 = sw.min(dw - offset.0);
    let y1 = sh.min(dh - offset.1);
    if x1 <= x0 || y1 <= y0 {
        return;
    }
    const INV255: f32 = 1.0 / 255.0;
    for y in y0..y1 {
        let dy = (y + offset.1) as usize;
        let sy = y as usize;
        for x in x0..x1 {
            let si = (sy * src_size.0 as usize + x as usize) * 4;
            let di = (dy * dst_size.0 as usize + (x + offset.0) as usize) * 4;
            if mode == BLEND_LERP {
                if src[si..si + 4] == dst[di..di + 4] {
                    continue;
                }
                let t = if let Some(c) = clip {
                    let ca = c[si + 3];
                    if ca == 0 {
                        continue;
                    }
                    alpha * (f32::from(ca) * INV255)
                } else {
                    alpha
                };
                for ch in 0..4 {
                    let b = f32::from(dst[di + ch]) * INV255;
                    let s = f32::from(src[si + ch]) * INV255;
                    dst[di + ch] = f32_to_u8(b + (s - b) * t);
                }
                continue;
            }
            let sa_u8 = src[si + 3];
            if sa_u8 == 0 {
                continue;
            }
            let scale = if let Some(c) = clip {
                let ca = c[si + 3];
                if ca == 0 {
                    continue;
                }
                alpha * (f32::from(ca) * INV255)
            } else {
                alpha
            };
            let scale = match mask {
                Some((picture, kind)) => scale * crate::mask::coverage(&picture[si..si + 4], kind),
                None => scale,
            };
            if scale <= 0.0 {
                continue;
            }
            if mode == 17 {
                // Figma rounds half-byte linear-burn results up. Keep the calculation in
                // byte units so an exact half such as 128 - 159 * 0.5 stays exact.
                let src_a = f32::from(sa_u8);
                let dst_a = f32::from(dst[di + 3]);
                let sub = (src_a * dst_a) / 255.0;
                for ch in 0..3 {
                    let source = f32::from(src[si + ch]) - sub;
                    dst[di + ch] = (f32::from(dst[di + ch]) + source * scale).round() as u8;
                }
                dst[di + 3] = (dst_a + (src_a - sub) * scale).round() as u8;
                continue;
            }
            let s = [
                f32::from(src[si]) * INV255 * scale,
                f32::from(src[si + 1]) * INV255 * scale,
                f32::from(src[si + 2]) * INV255 * scale,
                f32::from(sa_u8) * INV255 * scale,
            ];
            let b = [
                f32::from(dst[di]) * INV255,
                f32::from(dst[di + 1]) * INV255,
                f32::from(dst[di + 2]) * INV255,
                f32::from(dst[di + 3]) * INV255,
            ];
            let out = blend_pixel(mode, s, b);
            dst[di] = f32_to_u8(out[0]);
            dst[di + 1] = f32_to_u8(out[1]);
            dst[di + 2] = f32_to_u8(out[2]);
            dst[di + 3] = f32_to_u8(out[3]);
        }
    }
}

#[cfg(feature = "gpu-common")]
pub mod gpu {
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicU64, Ordering};

    const BLEND_WGSL: &str = include_str!(concat!(env!("OUT_DIR"), "/blend.wgsl"));
    const SLAB_SLOTS: u32 = 1024;
    const UNIFORM_SIZE: usize = 32;
    const BG_CACHE_CAP: usize = 256;

    /// Returns a process-unique non-zero identity for a newly created `wgpu::TextureView`,
    /// used as a cache key for persistent bind groups across batched GPU passes.
    pub fn next_view_id() -> u64 {
        static NEXT: AtomicU64 = AtomicU64::new(1);
        NEXT.fetch_add(1, Ordering::Relaxed)
    }

    /// GPU blend pass (`blend.wgsl`): composites a premultiplied source over a backdrop copy
    /// directly into the active target, optionally modulated by an anti-aliased clip mask.
    /// Uses a dynamic-offset uniform slab so consecutive blend passes batch into one encoder.
    pub struct GpuBlend {
        bgl: wgpu::BindGroupLayout,
        pipe_plain: wgpu::RenderPipeline,
        pipe_clipped: wgpu::RenderPipeline,
        slab: Option<wgpu::Buffer>,
        slab_slot: u32,
        uniform_align: u32,
        uniform_bytes: Vec<u8>,
        bg_cache: HashMap<(u64, u64, u64, u64), wgpu::BindGroup>,
        dummy_view: wgpu::TextureView,
        _dummy_tex: wgpu::Texture,
    }

    impl Drop for GpuBlend {
        fn drop(&mut self) {
            if let Some(slab) = self.slab.take() {
                slab.destroy();
            }
        }
    }

    impl GpuBlend {
        pub fn new(device: &wgpu::Device) -> Self {
            let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("blend"),
                source: wgpu::ShaderSource::Wgsl(BLEND_WGSL.into()),
            });
            let tex_entry = |binding: u32| wgpu::BindGroupLayoutEntry {
                binding,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Texture {
                    sample_type: wgpu::TextureSampleType::Float { filterable: false },
                    view_dimension: wgpu::TextureViewDimension::D2,
                    multisampled: false,
                },
                count: None,
            };
            let bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("blend bgl"),
                entries: &[
                    tex_entry(0),
                    tex_entry(1),
                    tex_entry(2),
                    wgpu::BindGroupLayoutEntry {
                        binding: 3,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Uniform,
                            has_dynamic_offset: true,
                            min_binding_size: wgpu::BufferSize::new(UNIFORM_SIZE as u64),
                        },
                        count: None,
                    },
                    tex_entry(4),
                ],
            });
            let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("blend layout"),
                bind_group_layouts: &[Some(&bgl)],
                immediate_size: 0,
            });
            let make_pipe = |label: &str, entry: &str| {
                device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                    label: Some(label),
                    layout: Some(&layout),
                    vertex: wgpu::VertexState {
                        module: &shader,
                        entry_point: Some("vs_quad"),
                        compilation_options: Default::default(),
                        buffers: &[],
                    },
                    primitive: wgpu::PrimitiveState::default(),
                    depth_stencil: None,
                    multisample: wgpu::MultisampleState::default(),
                    fragment: Some(wgpu::FragmentState {
                        module: &shader,
                        entry_point: Some(entry),
                        compilation_options: Default::default(),
                        targets: &[Some(wgpu::ColorTargetState {
                            format: wgpu::TextureFormat::Rgba8Unorm,
                            blend: None,
                            write_mask: wgpu::ColorWrites::ALL,
                        })],
                    }),
                    multiview_mask: None,
                    cache: None,
                })
            };
            let pipe_plain = make_pipe("blend plain", "fs_blend");
            let pipe_clipped = make_pipe("blend clipped", "fs_blend_clipped");
            let uniform_align = device.limits().min_uniform_buffer_offset_alignment.max(256);
            let dummy_tex = device.create_texture(&wgpu::TextureDescriptor {
                label: Some("blend dummy clip"),
                size: wgpu::Extent3d {
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
            let dummy_view = dummy_tex.create_view(&Default::default());
            Self {
                bgl,
                pipe_plain,
                pipe_clipped,
                slab: None,
                slab_slot: 0,
                uniform_align,
                uniform_bytes: Vec::new(),
                bg_cache: HashMap::new(),
                dummy_view,
                _dummy_tex: dummy_tex,
            }
        }

        fn slab_size(&self) -> usize {
            self.uniform_align as usize * SLAB_SLOTS as usize
        }

        pub fn bytes(&self) -> usize {
            self.slab.as_ref().map_or(0, |_| self.slab_size())
        }

        pub fn pending_allocation(&self) -> usize {
            self.slab.as_ref().map_or(self.slab_size(), |_| 0)
        }

        pub fn ensure_slab(&mut self, device: &wgpu::Device) {
            let size = self.slab_size() as u64;
            self.slab.get_or_insert_with(|| {
                device.create_buffer(&wgpu::BufferDescriptor {
                    label: Some("blend params slab"),
                    size,
                    usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                    mapped_at_creation: false,
                })
            });
        }

        pub fn has_slots(&self, count: u32) -> bool {
            count <= SLAB_SLOTS - self.slab_slot
        }

        /// Upload the slots before submitting the encoder that refers to them. The next upload
        /// runs after that submit, so the next encoder can reuse the same offsets.
        pub fn flush_uniforms(&mut self, queue: &wgpu::Queue) {
            if !self.uniform_bytes.is_empty() {
                queue.write_buffer(self.slab.as_ref().expect("blend slab"), 0, &self.uniform_bytes);
            }
            self.discard_uniforms();
        }

        pub fn discard_uniforms(&mut self) {
            self.uniform_bytes.clear();
            self.slab_slot = 0;
            if self.bg_cache.len() > BG_CACHE_CAP {
                self.bg_cache.clear();
            }
        }

        fn push_uniform(&mut self, bytes: &[u8; UNIFORM_SIZE]) -> u32 {
            assert!(self.has_slots(1), "submit before reusing blend uniform slots");
            let offset = self.slab_slot * self.uniform_align;
            self.slab_slot += 1;
            self.uniform_bytes.resize(offset as usize, 0);
            self.uniform_bytes.extend_from_slice(bytes);
            offset
        }

        /// Encodes a single scissored fragment pass writing `blend(src * opacity * clip, backdrop)`
        /// into `dst_view` over the portion of the source within the parent target.
        /// Returns the number of draw calls emitted (`0` or `1`).
        #[allow(clippy::too_many_arguments)]
        pub fn encode(
            &mut self,
            device: &wgpu::Device,
            encoder: &mut wgpu::CommandEncoder,
            src: (&wgpu::TextureView, u64),
            backdrop: (&wgpu::TextureView, u64),
            clip: Option<(&wgpu::TextureView, u64)>,
            picture: Option<(&wgpu::TextureView, u64, u32)>,
            dst_view: &wgpu::TextureView,
            dst_origin: (i32, i32),
            scissor: (u32, u32, u32, u32),
            mode: u32,
            opacity: f32,
        ) -> u32 {
            if scissor.2 == 0 || scissor.3 == 0 {
                return 0;
            }
            let mut bytes = [0u8; UNIFORM_SIZE];
            bytes[0..4].copy_from_slice(&dst_origin.0.to_le_bytes());
            bytes[4..8].copy_from_slice(&dst_origin.1.to_le_bytes());
            bytes[8..12].copy_from_slice(&mode.to_le_bytes());
            bytes[12..16].copy_from_slice(&opacity.clamp(0.0, 1.0).to_le_bytes());
            let mask_kind = picture.map_or(0, |(_, _, kind)| kind);
            bytes[16..20].copy_from_slice(&mask_kind.to_le_bytes());
            let offset = self.push_uniform(&bytes);
            let key = (
                src.1,
                backdrop.1,
                clip.map_or(0, |(_, id)| id),
                picture.map_or(0, |(_, id, _)| id),
            );
            let make_bg = || {
                let picture_view = picture.map_or(&self.dummy_view, |(view, _, _)| view);
                let clip_view = clip.map_or(&self.dummy_view, |(view, _)| view);
                device.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: Some("blend bg"),
                    layout: &self.bgl,
                    entries: &[
                        wgpu::BindGroupEntry {
                            binding: 0,
                            resource: wgpu::BindingResource::TextureView(src.0),
                        },
                        wgpu::BindGroupEntry {
                            binding: 1,
                            resource: wgpu::BindingResource::TextureView(backdrop.0),
                        },
                        wgpu::BindGroupEntry {
                            binding: 2,
                            resource: wgpu::BindingResource::TextureView(clip_view),
                        },
                        wgpu::BindGroupEntry {
                            binding: 3,
                            resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                                buffer: self.slab.as_ref().expect("blend slab"),
                                offset: 0,
                                size: wgpu::BufferSize::new(UNIFORM_SIZE as u64),
                            }),
                        },
                        wgpu::BindGroupEntry {
                            binding: 4,
                            resource: wgpu::BindingResource::TextureView(picture_view),
                        },
                    ],
                })
            };
            let bg = if src.1 != 0 && backdrop.1 != 0 {
                if let Some(cached) = self.bg_cache.get(&key) {
                    cached.clone()
                } else {
                    let created = make_bg();
                    self.bg_cache.insert(key, created.clone());
                    created
                }
            } else {
                make_bg()
            };
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("blend"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: dst_view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Load,
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            pass.set_pipeline(if clip.is_some() {
                &self.pipe_clipped
            } else {
                &self.pipe_plain
            });
            pass.set_bind_group(0, &bg, &[offset]);
            pass.set_scissor_rect(scissor.0, scissor.1, scissor.2, scissor.3);
            pass.draw(0..3, 0..1);
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn approx(a: [f32; 4], b: [f32; 4], tol: f32) {
        for i in 0..4 {
            assert!(
                (a[i] - b[i]).abs() <= tol,
                "channel {i}: got {:.5}, expected {:.5} (diff {:.5} > {tol})",
                a[i],
                b[i],
                (a[i] - b[i]).abs()
            );
        }
    }

    #[test]
    fn transparent_src_or_dst_identities_hold_for_every_mode() {
        let sample = [0.4, 0.25, 0.15, 0.5];
        let zero = [0.0; 4];
        for mode in 0..=17 {
            approx(blend_pixel(mode, zero, sample), sample, 1e-6);
            approx(blend_pixel(mode, sample, zero), sample, 1e-6);
        }
    }

    #[test]
    fn linear_dodge_and_linear_burn_follow_decision_0038_formulas() {
        // Decision 0038 example: #606060 at 50% over opaque #808080 -> (128 + 48)/255 - 0.5 = 48.5/255;
        // on 8-bit premul buffers (alpha = 128/255) that gives 48/255 exactly.
        let s = [96.0 / 255.0 * 0.5, 96.0 / 255.0 * 0.5, 96.0 / 255.0 * 0.5, 0.5];
        let b = [128.0 / 255.0, 128.0 / 255.0, 128.0 / 255.0, 1.0];
        let burn = blend_pixel(17, s, b);
        approx(burn, [48.5 / 255.0, 48.5 / 255.0, 48.5 / 255.0, 1.0], 1e-5);
        let mut dst = vec![128, 128, 128, 255];
        blend_cpu(&[48, 48, 48, 128], &mut dst, (1, 1), (1, 1), (0, 0), 17, 1.0, None);
        assert_eq!(dst, vec![48, 48, 48, 255]);

        // Linear dodge over opaque: #a0a0a0 at 50% over #808080 -> min(1, 80/255 + 128/255) = 208/255.
        let sd = [160.0 / 255.0 * 0.5, 160.0 / 255.0 * 0.5, 160.0 / 255.0 * 0.5, 0.5];
        let dodge = blend_pixel(16, sd, b);
        approx(dodge, [208.0 / 255.0, 208.0 / 255.0, 208.0 / 255.0, 1.0], 1e-5);

        // Translucent over translucent: keeps normal alpha as + ab - as*ab, clamps to a.
        let b_half = [0.4, 0.2, 0.3, 0.5];
        let s_half = [0.45, 0.4, 0.1, 0.5];
        let a = 0.75;
        approx(blend_pixel(16, s_half, b_half), [0.75, 0.6, 0.4, a], 1e-6);
        approx(blend_pixel(17, s_half, b_half), [0.6, 0.35, 0.15, a], 1e-6);
    }

    #[test]
    fn linear_burn_rounds_half_byte_ties_up() {
        let mut dst = [128, 176, 191, 255, 64, 64, 64, 128];
        let src = [96, 96, 2, 255, 96, 96, 96, 255];
        blend_cpu(&src, &mut dst, (2, 1), (2, 1), (0, 0), 17, 0.5, None);
        assert_eq!(dst, [49, 97, 65, 255, 48, 48, 48, 192]);
    }

    #[test]
    fn w3c_separable_and_non_separable_modes_match_spec_spot_checks() {
        let cb = [0.8, 0.4, 0.2, 1.0];
        let cs = [0.25, 0.75, 0.5, 1.0];
        // Multiply
        approx(blend_pixel(1, cs, cb), [0.2, 0.3, 0.1, 1.0], 1e-5);
        // Screen
        approx(blend_pixel(2, cs, cb), [0.85, 0.85, 0.6, 1.0], 1e-5);
        // Darken / Lighten
        approx(blend_pixel(4, cs, cb), [0.25, 0.4, 0.2, 1.0], 1e-5);
        approx(blend_pixel(5, cs, cb), [0.8, 0.75, 0.5, 1.0], 1e-5);
        // Difference / Exclusion
        approx(blend_pixel(10, cs, cb), [0.55, 0.35, 0.3, 1.0], 1e-5);
        approx(blend_pixel(11, cs, cb), [0.65, 0.55, 0.5, 1.0], 1e-5);
        // Color-dodge / Color-burn edge cases (0 / 1)
        approx(
            blend_pixel(6, [1.0, 0.5, 0.0, 1.0], [0.0, 0.25, 0.6, 1.0]),
            [0.0, 0.5, 0.6, 1.0],
            1e-5,
        );
        approx(
            blend_pixel(7, [0.0, 0.5, 1.0, 1.0], [1.0, 0.75, 0.4, 1.0]),
            [1.0, 0.5, 0.4, 1.0],
            1e-5,
        );
        // Non-separable invariants:
        // Color (14) preserves backdrop luminance
        let col = blend_pixel(14, cs, cb);
        assert!((lum([col[0], col[1], col[2]]) - lum([cb[0], cb[1], cb[2]])).abs() < 1e-4);
        // Luminosity (15) preserves source luminance
        let lum_out = blend_pixel(15, cs, cb);
        assert!((lum([lum_out[0], lum_out[1], lum_out[2]]) - lum([cs[0], cs[1], cs[2]])).abs() < 1e-4);
        // Hue (12) and Saturation (13) preserve backdrop luminance
        let hue = blend_pixel(12, cs, cb);
        let sat_out = blend_pixel(13, cs, cb);
        assert!((lum([hue[0], hue[1], hue[2]]) - lum([cb[0], cb[1], cb[2]])).abs() < 1e-4);
        assert!((lum([sat_out[0], sat_out[1], sat_out[2]]) - lum([cb[0], cb[1], cb[2]])).abs() < 1e-4);
        // Grey source in Color/Saturation leaves saturation 0 with backdrop luminance
        let grey = [0.5, 0.5, 0.5, 1.0];
        let gcol = blend_pixel(14, grey, cb);
        let l = lum([cb[0], cb[1], cb[2]]);
        approx(gcol, [l, l, l, 1.0], 1e-4);
        approx(blend_pixel(13, grey, cb), [l, l, l, 1.0], 1e-4);
    }

    #[test]
    fn blend_lerp_preserves_untouched_translucent_backdrop_bit_exactly() {
        let mut dst = vec![40, 80, 120, 128, 200, 100, 50, 255];
        let src = vec![40, 80, 120, 128, 100, 200, 150, 255];
        blend_cpu(&src, &mut dst, (2, 1), (2, 1), (0, 0), BLEND_LERP, 0.5, None);
        // Untouched translucent pixel stays bit-identical (no alpha doubling).
        assert_eq!(&dst[0..4], &[40, 80, 120, 128]);
        // Opaque touched pixel interpolates halfway.
        assert_eq!(&dst[4..8], &[150, 150, 100, 255]);
    }
}
