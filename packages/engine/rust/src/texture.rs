//! Texture displacement post-effect (decisions 0008, 0013, 0040).
//!
//! Direct port of `packages/editor/src/texture.ts`: pcg2d gradient hash, three-octave fractal
//! Perlin displacement in layer coordinates, nearest-neighbor sampling up to `radius_dev`, and
//! optional `clip_to_shape` alpha masking.
//!
//! Paired verbatim with `texture.wgsl` (pure fragment pass, WebGL2 / GLSL ES 3.00 compatible).

use vello_common::kurbo::Affine;

/// pcg2d (Jarzynski and Olano, 2020), matching `hash` in `packages/editor/src/texture.ts`.
#[inline]
fn hash2(mut x: u32, mut y: u32) -> (u32, u32) {
    x = x.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
    y = y.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
    x = x.wrapping_add(y.wrapping_mul(1_664_525));
    y = y.wrapping_add(x.wrapping_mul(1_664_525));
    x ^= x >> 16;
    y ^= y >> 16;
    x = x.wrapping_add(y.wrapping_mul(1_664_525));
    y = y.wrapping_add(x.wrapping_mul(1_664_525));
    x ^= x >> 16;
    y ^= y >> 16;
    (x, y)
}

#[inline]
#[allow(clippy::approx_constant)]
fn gradient_at(cx: i32, cy: i32) -> (f32, f32) {
    let (hx, _) = hash2(cx as u32, cy as u32);
    let r = (hx as f32) / 4_294_967_295.0;
    let turn = r * 6.283_185_3;
    (turn.cos(), turn.sin())
}

#[inline]
fn perlin(px: f32, py: f32) -> f32 {
    let ix = px.floor();
    let iy = py.floor();
    let fx = px - ix;
    let fy = py - iy;
    let ux = fx * fx * fx * (fx * (fx * 6.0 - 15.0) + 10.0);
    let uy = fy * fy * fy * (fy * (fy * 6.0 - 15.0) + 10.0);
    let cx = ix as i32;
    let cy = iy as i32;
    let (g00x, g00y) = gradient_at(cx, cy);
    let (g10x, g10y) = gradient_at(cx.wrapping_add(1), cy);
    let (g01x, g01y) = gradient_at(cx, cy.wrapping_add(1));
    let (g11x, g11y) = gradient_at(cx.wrapping_add(1), cy.wrapping_add(1));
    let a = g00x * fx + g00y * fy;
    let b = g10x * (fx - 1.0) + g10y * fy;
    let d = g01x * fx + g01y * (fy - 1.0);
    let e = g11x * (fx - 1.0) + g11y * (fy - 1.0);
    let top = a + (b - a) * ux;
    let bottom = d + (e - d) * ux;
    top + (bottom - top) * uy
}

#[inline]
fn fractal(px: f32, py: f32) -> f32 {
    perlin(px, py) + 0.5 * perlin(px * 2.0, py * 2.0) + 0.25 * perlin(px * 4.0, py * 4.0)
}

/// Applies texture displacement over `src` (premultiplied RGBA8 of size `src_size`, placed at
/// `src_origin`), writing premultiplied RGBA8 into `dst` (size `dst_size`, placed at `dst_origin`).
/// `dev_to_layer` maps device pixels to layer units (`inv(device)`).
#[allow(clippy::too_many_arguments)]
pub fn texture_cpu(
    src: &[u8],
    src_size: (u32, u32),
    src_origin: (i32, i32),
    dst: &mut [u8],
    dst_size: (u32, u32),
    dst_origin: (i32, i32),
    cell: f32,
    radius_dev: f32,
    clip_to_shape: bool,
    dev_to_layer: Affine,
) {
    let (sw, sh) = (src_size.0 as i32, src_size.1 as i32);
    let (dw, dh) = (dst_size.0 as usize, dst_size.1 as usize);
    let dx0 = dst_origin.0 - src_origin.0;
    let dy0 = dst_origin.1 - src_origin.1;
    let active = cell > 0.0 && radius_dev > 0.0;
    // Keep `dev_to_layer` unchanged by `dst_origin` so bands, tiles, and whole frames evaluate
    // the exact same `f32` affine and floor at every global device pixel center.
    let [a, b, c, d, e, f] = dev_to_layer.as_coeffs();
    let (a, b, c, d, e, f) = (a as f32, b as f32, c as f32, d as f32, e as f32, f as f32);
    let dst_ox = dst_origin.0 as f32;
    let dst_oy = dst_origin.1 as f32;
    const INV255: f32 = 1.0 / 255.0;

    for y in 0..dh {
        let dev_y = dst_oy + y as f32 + 0.5;
        let orig_y = dy0 + y as i32;
        for x in 0..dw {
            let di = (y * dw + x) * 4;
            if !active {
                let orig_x = dx0 + x as i32;
                if orig_x >= 0 && orig_y >= 0 && orig_x < sw && orig_y < sh {
                    let si = (orig_y as usize * src_size.0 as usize + orig_x as usize) * 4;
                    dst[di..di + 4].copy_from_slice(&src[si..si + 4]);
                } else {
                    dst[di..di + 4].fill(0);
                }
                continue;
            }
            let dev_x = dst_ox + x as f32 + 0.5;
            let orig_a = if clip_to_shape {
                let orig_x = dx0 + x as i32;
                if orig_x < 0 || orig_y < 0 || orig_x >= sw || orig_y >= sh {
                    dst[di..di + 4].fill(0);
                    continue;
                }
                let oi = (orig_y as usize * src_size.0 as usize + orig_x as usize) * 4;
                let oa = src[oi + 3];
                if oa == 0 {
                    dst[di..di + 4].fill(0);
                    continue;
                }
                oa
            } else {
                255
            };
            let lx = a * dev_x + c * dev_y + e;
            let ly = b * dev_x + d * dev_y + f;
            let qx = lx / cell;
            let qy = ly / cell;
            let mut ox = fractal(qx, qy) / 0.9;
            let mut oy = fractal(qx + 37.2, qy + 91.7) / 0.9;
            let len = (ox * ox + oy * oy).sqrt();
            if len > 1.0 {
                ox /= len;
                oy /= len;
            }
            let sx = (dev_x + ox * radius_dev).floor() as i32 - src_origin.0;
            let sy = (dev_y + oy * radius_dev).floor() as i32 - src_origin.1;
            if sx < 0 || sy < 0 || sx >= sw || sy >= sh {
                dst[di..di + 4].fill(0);
                continue;
            }
            let si = (sy as usize * src_size.0 as usize + sx as usize) * 4;
            if orig_a == 255 {
                dst[di..di + 4].copy_from_slice(&src[si..si + 4]);
            } else {
                let s = f32::from(orig_a) * INV255;
                for ch in 0..4 {
                    dst[di + ch] = (f32::from(src[si + ch]) * s).round().clamp(0.0, 255.0) as u8;
                }
            }
        }
    }
}

#[cfg(feature = "gpu-common")]
pub mod gpu {
    use super::*;
    use wgpu::util::DeviceExt;

    const TEXTURE_WGSL: &str = include_str!("texture.wgsl");

    /// GPU texture displacement pass (`texture.wgsl`).
    pub struct GpuTexture {
        layout: wgpu::BindGroupLayout,
        pipe: wgpu::RenderPipeline,
    }

    impl GpuTexture {
        pub fn new(device: &wgpu::Device) -> Self {
            let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("texture"),
                source: wgpu::ShaderSource::Wgsl(TEXTURE_WGSL.into()),
            });
            let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("texture"),
                entries: &[
                    wgpu::BindGroupLayoutEntry {
                        binding: 0,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Texture {
                            sample_type: wgpu::TextureSampleType::Float { filterable: false },
                            view_dimension: wgpu::TextureViewDimension::D2,
                            multisampled: false,
                        },
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 1,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Uniform,
                            has_dynamic_offset: false,
                            min_binding_size: None,
                        },
                        count: None,
                    },
                ],
            });
            let pipe_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("texture"),
                bind_group_layouts: &[Some(&layout)],
                immediate_size: 0,
            });
            let pipe = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some("texture"),
                layout: Some(&pipe_layout),
                vertex: wgpu::VertexState {
                    module: &shader,
                    entry_point: Some("vs_quad"),
                    buffers: &[],
                    compilation_options: Default::default(),
                },
                fragment: Some(wgpu::FragmentState {
                    module: &shader,
                    entry_point: Some("fs_texture"),
                    targets: &[Some(wgpu::ColorTargetState {
                        format: wgpu::TextureFormat::Rgba8Unorm,
                        blend: None,
                        write_mask: wgpu::ColorWrites::ALL,
                    })],
                    compilation_options: Default::default(),
                }),
                primitive: wgpu::PrimitiveState::default(),
                depth_stencil: None,
                multisample: wgpu::MultisampleState::default(),
                multiview_mask: None,
                cache: None,
            });
            Self { layout, pipe }
        }

        #[allow(clippy::too_many_arguments)]
        pub fn encode(
            &self,
            device: &wgpu::Device,
            encoder: &mut wgpu::CommandEncoder,
            src_view: &wgpu::TextureView,
            src_size: (u32, u32),
            src_origin: (i32, i32),
            dst_view: &wgpu::TextureView,
            dst_size: (u32, u32),
            dst_origin: (i32, i32),
            cell: f32,
            radius_dev: f32,
            clip_to_shape: bool,
            dev_to_layer: Affine,
        ) {
            if dst_size.0 == 0 || dst_size.1 == 0 {
                return;
            }
            let [a, b, c, d, e, f] = dev_to_layer.as_coeffs();
            let mut bytes = [0u8; 80];
            let put_f = |buf: &mut [u8], at: usize, v: f32| buf[at..at + 4].copy_from_slice(&v.to_le_bytes());
            let put_i = |buf: &mut [u8], at: usize, v: i32| buf[at..at + 4].copy_from_slice(&v.to_le_bytes());
            put_f(&mut bytes, 0, a as f32);
            put_f(&mut bytes, 4, c as f32);
            put_f(&mut bytes, 8, e as f32);
            put_f(&mut bytes, 16, b as f32);
            put_f(&mut bytes, 20, d as f32);
            put_f(&mut bytes, 24, f as f32);
            put_i(&mut bytes, 32, dst_origin.0);
            put_i(&mut bytes, 36, dst_origin.1);
            put_i(&mut bytes, 40, src_origin.0);
            put_i(&mut bytes, 44, src_origin.1);
            put_i(&mut bytes, 48, src_size.0 as i32);
            put_i(&mut bytes, 52, src_size.1 as i32);
            put_f(&mut bytes, 64, cell);
            put_f(&mut bytes, 68, radius_dev);
            put_f(&mut bytes, 72, if clip_to_shape { 1.0 } else { 0.0 });
            let uniform = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("texture params"),
                contents: &bytes,
                usage: wgpu::BufferUsages::UNIFORM,
            });
            let bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("texture"),
                layout: &self.layout,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: wgpu::BindingResource::TextureView(src_view),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: uniform.as_entire_binding(),
                    },
                ],
            });
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("texture"),
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
            pass.set_pipeline(&self.pipe);
            pass.set_bind_group(0, &bg, &[]);
            pass.set_scissor_rect(0, 0, dst_size.0, dst_size.1);
            pass.draw(0..3, 0..1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clipped_texture_never_paints_outside_source_alpha() {
        let (w, h) = (32, 32);
        let mut src = vec![0u8; w * h * 4];
        for y in 8..24 {
            for x in 8..24 {
                let i = (y * w + x) * 4;
                src[i] = 180;
                src[i + 1] = 120;
                src[i + 2] = 60;
                src[i + 3] = 255;
            }
        }
        let mut clipped = vec![0u8; src.len()];
        texture_cpu(
            &src,
            (w as u32, h as u32),
            (0, 0),
            &mut clipped,
            (w as u32, h as u32),
            (0, 0),
            3.0,
            6.0,
            true,
            Affine::IDENTITY,
        );
        for y in 0..h {
            for x in 0..w {
                let i = (y * w + x) * 4;
                if !(8..24).contains(&x) || !(8..24).contains(&y) {
                    assert_eq!(clipped[i + 3], 0, "clipped texture escaped at ({x},{y})");
                }
            }
        }
        // Unclipped texture must reach outside the 8..24 box.
        let mut unclipped = vec![0u8; src.len()];
        texture_cpu(
            &src,
            (w as u32, h as u32),
            (0, 0),
            &mut unclipped,
            (w as u32, h as u32),
            (0, 0),
            3.0,
            6.0,
            false,
            Affine::IDENTITY,
        );
        let outside_painted = (0..h)
            .flat_map(|y| (0..w).map(move |x| (x, y)))
            .filter(|&(x, y)| !(8..24).contains(&x) || !(8..24).contains(&y))
            .filter(|&(x, y)| unclipped[(y * w + x) * 4 + 3] > 0)
            .count();
        assert!(outside_painted > 0, "unclipped texture should expand past shape edges");
    }

    #[test]
    fn texture_tile_seam_matches_whole_frame_bit_identically() {
        let (w, h) = (40, 24);
        let mut src = vec![0u8; w * h * 4];
        for y in 4..20 {
            for x in 4..36 {
                let i = (y * w + x) * 4;
                src[i] = (x * 6) as u8;
                src[i + 1] = (y * 10) as u8;
                src[i + 2] = 180;
                src[i + 3] = 255;
            }
        }
        let mut whole = vec![0u8; src.len()];
        texture_cpu(
            &src,
            (w as u32, h as u32),
            (0, 0),
            &mut whole,
            (w as u32, h as u32),
            (0, 0),
            4.0,
            5.0,
            false,
            Affine::IDENTITY,
        );
        // Sub-tile x = 16..32 rendered from the padded src matches whole bit-for-bit.
        let mut tile = vec![0u8; 16 * h * 4];
        texture_cpu(
            &src,
            (w as u32, h as u32),
            (0, 0),
            &mut tile,
            (16, h as u32),
            (16, 0),
            4.0,
            5.0,
            false,
            Affine::IDENTITY,
        );
        for y in 0..h {
            let w_off = (y * w + 16) * 4;
            let t_off = y * 16 * 4;
            assert_eq!(&tile[t_off..t_off + 64], &whole[w_off..w_off + 64]);
        }
    }
}
