//! Diamond gradient: `t = clamp(|u| + |v|, 0, 1)` in unit gradient space, stops interpolated
//! unpremultiplied (matching linear, radial and angular gradients and Canvas 2D), then
//! premultiplied and scaled by `alpha`.
//!
//! Both the CPU reference (`render_cpu`) and the GPU WGSL pass (`WGSL`) evaluate the exact same
//! formula into a device-pixel texture covering the shape's clamped viewport bounds, which Vello
//! then samples 1:1 through the shape's anti-aliased fill or stroke coverage (respecting open
//! clips, nested isolating opacity groups, pan strips and export tiles).

use crate::exec::IRect;
use crate::record::Rgba;
use vello_common::kurbo::Affine;
use vello_common::peniko::ImageAlphaType;
use vello_common::pixmap::PixelMetadata;
use vello_cpu::Pixmap;

/// Maximum stops supported by the diamond gradient uniform buffer (`Limits::stops` is 64).
pub const MAX_STOPS: usize = 64;

/// Evaluates a diamond gradient at `t` in `[0, 1]`, returning premultiplied RGBA floats.
pub fn evaluate(t: f32, stops: &[(f32, Rgba)], alpha: f32) -> [f32; 4] {
    if stops.is_empty() || alpha <= 0.0 {
        return [0.0; 4];
    }
    let t = t.clamp(0.0, 1.0);
    let mut c = stops[0].1;
    if t > stops[0].0 {
        for i in 1..stops.len() {
            let (pos1, c1) = stops[i];
            if t <= pos1 {
                let (pos0, c0) = stops[i - 1];
                let span = pos1 - pos0;
                if span > 0.0 {
                    let u = ((t - pos0) / span).clamp(0.0, 1.0);
                    c = [
                        c0[0] + (c1[0] - c0[0]) * u,
                        c0[1] + (c1[1] - c0[1]) * u,
                        c0[2] + (c1[2] - c0[2]) * u,
                        c0[3] + (c1[3] - c0[3]) * u,
                    ];
                } else {
                    c = c1;
                }
                break;
            }
            c = c1;
        }
    }
    let a = (c[3] * alpha).clamp(0.0, 1.0);
    [
        c[0].clamp(0.0, 1.0) * a,
        c[1].clamp(0.0, 1.0) * a,
        c[2].clamp(0.0, 1.0) * a,
        a,
    ]
}

/// Renders a diamond gradient over device rectangle `area` into a premultiplied RGBA8 `Pixmap`.
/// `device_to_grad` maps device pixel coordinates `(x + 0.5, y + 0.5)` to unit gradient `(u, v)`.
pub fn render_cpu(area: IRect, device_to_grad: Affine, stops: &[(f32, Rgba)], alpha: f32) -> Pixmap {
    let w = (area.x1 - area.x0).max(1) as usize;
    let h = (area.y1 - area.y0).max(1) as usize;
    let [a, b, c, d, e, f] = device_to_grad.as_coeffs();
    let mut pixels = vec![0u8; w * h * 4];
    let q = |v: f32| (v.clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
    for row in 0..h {
        let py = f64::from(area.y0) + row as f64 + 0.5;
        let base_u = c * py + e;
        let base_v = d * py + f;
        for col in 0..w {
            let px = f64::from(area.x0) + col as f64 + 0.5;
            let u = (a * px + base_u) as f32;
            let v = (b * px + base_v) as f32;
            let t = (u.abs() + v.abs()).clamp(0.0, 1.0);
            let rgba = evaluate(t, stops, alpha);
            let i = (row * w + col) * 4;
            pixels[i] = q(rgba[0]);
            pixels[i + 1] = q(rgba[1]);
            pixels[i + 2] = q(rgba[2]);
            pixels[i + 3] = q(rgba[3]);
        }
    }
    Pixmap::from_parts(
        pixels,
        w as u16,
        h as u16,
        PixelMetadata {
            may_have_transparency: true,
            alpha_type: ImageAlphaType::AlphaPremultiplied,
        },
    )
}

/// Byte size of the WGSL uniform buffer: header (3 * vec4<f32> = 48 B) + 64 stops * (2 * vec4<f32> = 32 B) = 2096 B.
pub const UNIFORM_BYTES: usize = 48 + MAX_STOPS * 32;

/// Packs the diamond gradient uniforms for `WGSL` (little-endian std140 layout, WebGL2 & WebGPU).
#[cfg(feature = "gpu-common")]
pub fn pack_uniforms(area: IRect, device_to_grad: Affine, stops: &[(f32, Rgba)], alpha: f32) -> Vec<u8> {
    let [a, b, c, d, e, f] = device_to_grad.as_coeffs();
    let count = stops.len().min(MAX_STOPS);
    let mut floats = Vec::with_capacity(UNIFORM_BYTES / 4);
    // inv_x = (a, c, e, 0)
    floats.extend_from_slice(&[a as f32, c as f32, e as f32, 0.0]);
    // inv_y = (b, d, f, 0)
    floats.extend_from_slice(&[b as f32, d as f32, f as f32, 0.0]);
    // params = (origin_x, origin_y, alpha, count)
    floats.extend_from_slice(&[area.x0 as f32, area.y0 as f32, alpha, count as f32]);
    for i in 0..MAX_STOPS {
        if let Some((pos, col)) = stops.get(i) {
            floats.extend_from_slice(col);
            floats.extend_from_slice(&[*pos, 0.0, 0.0, 0.0]);
        } else {
            floats.extend_from_slice(&[0.0; 8]);
        }
    }
    debug_assert_eq!(floats.len() * 4, UNIFORM_BYTES);
    floats.iter().flat_map(|v| v.to_le_bytes()).collect()
}

/// WGSL shader for exact diamond gradient evaluation on both WebGPU and WebGL2 (GLSL ES 3.0).
/// Uses a single uniform buffer (2,096 B, well within WebGL2's 16 KB minimum) and zero storage buffers.
#[cfg(feature = "gpu-common")]
pub const WGSL: &str = r"
struct Stop {
  color: vec4<f32>,
  pos: vec4<f32>,
};

struct DiamondUniforms {
  inv_x: vec4<f32>,
  inv_y: vec4<f32>,
  params: vec4<f32>,
  stops: array<Stop, 64>,
};

@group(0) @binding(0) var<uniform> u: DiamondUniforms;

@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
  let p = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4<f32>(p * 2.0 - 1.0, 0.0, 1.0);
}

@fragment fn fs(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
  let count = u32(u.params.w + 0.5);
  let alpha = u.params.z;
  if (count == 0u || alpha <= 0.0) {
    return vec4<f32>(0.0);
  }
  let px = p.x + u.params.x;
  let py = p.y + u.params.y;
  let gu = u.inv_x.x * px + u.inv_x.y * py + u.inv_x.z;
  let gv = u.inv_y.x * px + u.inv_y.y * py + u.inv_y.z;
  let t = clamp(abs(gu) + abs(gv), 0.0, 1.0);

  var col = u.stops[0].color;
  if (t > u.stops[0].pos.x) {
    for (var i: u32 = 1u; i < 64u; i = i + 1u) {
      if (i >= count) {
        break;
      }
      let p1 = u.stops[i].pos.x;
      let c1 = u.stops[i].color;
      if (t <= p1) {
        let p0 = u.stops[i - 1u].pos.x;
        let span = p1 - p0;
        if (span > 0.0) {
          let frac = clamp((t - p0) / span, 0.0, 1.0);
          col = mix(u.stops[i - 1u].color, c1, frac);
        } else {
          col = c1;
        }
        break;
      }
      col = c1;
    }
  }
  let a = clamp(col.a * alpha, 0.0, 1.0);
  let rgb = clamp(col.rgb, vec3<f32>(0.0), vec3<f32>(1.0)) * a;
  return vec4<f32>(rgb, a);
}
";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diamond_l1_norm_and_unpremultiplied_interpolation() {
        // Red opaque at centre (t = 0) to blue transparent at |u|+|v| = 1.
        let stops = vec![(0.0, [1.0, 0.0, 0.0, 1.0]), (1.0, [0.0, 0.0, 1.0, 0.0])];
        // At t = 0.5 unpremultiplied colour is (0.5, 0, 0.5, 0.5) -> premul (0.25, 0, 0.25, 0.5).
        let mid = evaluate(0.5, &stops, 1.0);
        assert!((mid[0] - 0.25).abs() < 1e-6);
        assert!((mid[2] - 0.25).abs() < 1e-6);
        assert!((mid[3] - 0.5).abs() < 1e-6);
        // Hard stop step at 0.5.
        let hard = vec![
            (0.0, [1.0, 0.0, 0.0, 1.0]),
            (0.5, [1.0, 0.0, 0.0, 1.0]),
            (0.5, [0.0, 1.0, 0.0, 1.0]),
            (1.0, [0.0, 1.0, 0.0, 1.0]),
        ];
        assert!((evaluate(0.49, &hard, 1.0)[0] - 1.0).abs() < 1e-6);
        assert!((evaluate(0.51, &hard, 1.0)[1] - 1.0).abs() < 1e-6);
    }

    #[test]
    fn diamond_cpu_renders_l1_contours() {
        // Unit gradient centred at (50, 50) with radius 40.
        let grad_to_device = Affine::new([40.0, 0.0, 0.0, 40.0, 50.0, 50.0]);
        let stops = vec![(0.0, [1.0, 1.0, 1.0, 1.0]), (1.0, [0.0, 0.0, 0.0, 1.0])];
        let area = IRect {
            x0: 0,
            y0: 0,
            x1: 100,
            y1: 100,
        };
        let px = render_cpu(area, grad_to_device.inverse(), &stops, 1.0);
        let at = |x: usize, y: usize| px.data_as_u8_slice()[(y * 100 + x) * 4];
        // Centre is bright (~255).
        assert!(at(50, 50) >= 248);
        // Diagonal (70, 70): u = 0.5125, v = 0.5125 -> |u|+|v| = 1.025 -> clamped to 1 -> black (0)!
        // A radial gradient at (70, 70) would be sqrt(0.5^2+0.5^2) = 0.707 (grey ~75), NOT black!
        assert_eq!(at(70, 70), 0);
        // Axis midpoint (70, 50): u ~ 0.51, v ~ 0.01 -> t ~ 0.52 -> mid-grey (~120).
        let axis = at(70, 50);
        assert!((110..=135).contains(&axis), "axis pixel {axis}");
    }
}
