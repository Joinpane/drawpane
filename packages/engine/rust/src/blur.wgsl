// Reference separable Gaussian blur and shareable blur pyramid passes (decision 0040).
//
// Pure fragment passes over a full-screen triangle, scissored to the dirty region.
// Designed for WebGPU Core, WebGPU Compatibility, and wgpu's WebGL2 (GLSL ES 3.00) backend:
// no compute shaders, no storage buffers, only 16-byte-aligned vec4<f32> uniforms,
// textureLoad (texelFetch) for exact integer taps, and textureSampleLevel (textureLod)
// for bilinear upsampling.

struct BlurUniforms {
  // blur_1d:         (dir.x, dir.y, inv_two_sigma2, radius)
  // downsample_l0:   (0, 0, 0, 0)
  // downsample_next: (0, 0, 0, 0)
  // upsample:        (dst_origin.x, dst_origin.y, inv_scale, 0)
  p0: vec4<f32>,
  // blur_1d:         valid source rect (x0, y0, x1, y1) in source texels
  // downsample_l0:   clamp_bounds (x0, y0, x1, y1) in level-0 source texels
  // downsample_next: (0, 0, prev_stored_w, prev_stored_h)
  // upsample:        (cb.x0, cb.y0, blur_origin.x, blur_origin.y)
  clamp_bounds: vec4<f32>,
  // blur_1d:         (src_offset.x, src_offset.y, edge_mode, 0)
  // downsample_l0:   (0, 0, edge_mode, 0)
  // downsample_next: (0, 0, 1, 0)
  // upsample:        (inv_blur_w, inv_blur_h, 0, 0)
  p2: vec4<f32>,
  // Premultiplied RGBA border color for EdgeMode::Border (zero for EdgeMode::Zero).
  border: vec4<f32>,
};

@group(0) @binding(0) var src_tex: texture_2d<f32>;
@group(0) @binding(1) var src_samp: sampler;
@group(0) @binding(2) var<uniform> u: BlurUniforms;

@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
  let p = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4<f32>(p * 2.0 - 1.0, 0.0, 1.0);
}

fn sample_src(coord: vec2<i32>, cb: vec4<i32>, mode: i32, border: vec4<f32>) -> vec4<f32> {
  if (cb.z <= cb.x || cb.w <= cb.y) {
    return border;
  }
  if (mode == 1) {
    let c = clamp(coord, cb.xy, cb.zw - vec2<i32>(1, 1));
    return textureLoad(src_tex, c, 0);
  }
  if (coord.x < cb.x || coord.y < cb.y || coord.x >= cb.z || coord.y >= cb.w) {
    return border;
  }
  return textureLoad(src_tex, coord, 0);
}

// 1D separable Gaussian pass (horizontal or vertical), symmetric taps 1..=r.
@fragment
fn fs_blur_1d(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
  let dst = vec2<i32>(pos.xy);
  let center = dst + vec2<i32>(i32(u.p2.x), i32(u.p2.y));
  let cb = vec4<i32>(
    i32(u.clamp_bounds.x),
    i32(u.clamp_bounds.y),
    i32(u.clamp_bounds.z),
    i32(u.clamp_bounds.w),
  );
  let mode = i32(u.p2.z);
  if (cb.z <= cb.x || cb.w <= cb.y) {
    return u.border;
  }
  let r = min(i32(u.p0.w), 35);
  if (r <= 0) {
    return sample_src(center, cb, mode, u.border);
  }
  let dir = vec2<i32>(i32(u.p0.x), i32(u.p0.y));
  let k2 = clamp(u.p0.z, 0.0, 1e12);
  var acc = sample_src(center, cb, mode, u.border);
  var wsum = 1.0;
  for (var k: i32 = 1; k <= r; k = k + 1) {
    let fk = f32(k);
    let w = exp(-fk * fk * k2);
    let s_pos = sample_src(center + dir * k, cb, mode, u.border);
    let s_neg = sample_src(center - dir * k, cb, mode, u.border);
    acc = acc + (s_pos + s_neg) * w;
    wsum = wsum + 2.0 * w;
  }
  return clamp(acc / max(wsum, 1.0), vec4<f32>(0.0), vec4<f32>(1.0));
}

// Level 0 -> Level 1 4x4 separable [1, 3, 3, 1]/8 downsample into a 2-texel-aproned level.
// Stored texel (tx, ty) maps to logical (i, j) = (tx - 2, ty - 2), centered at
// (cb.x0 + 2*i + 1.0, cb.y0 + 2*j + 1.0) in level-0 pixel coordinates.
@fragment
fn fs_downsample_l0(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
  let stored = vec2<i32>(pos.xy);
  let logical = stored - vec2<i32>(2, 2);
  let cb = vec4<i32>(
    i32(u.clamp_bounds.x),
    i32(u.clamp_bounds.y),
    i32(u.clamp_bounds.z),
    i32(u.clamp_bounds.w),
  );
  let mode = i32(u.p2.z);
  let base = cb.xy + logical * 2 - vec2<i32>(1, 1);
  var acc = vec4<f32>(0.0);
  for (var dy: i32 = 0; dy < 4; dy = dy + 1) {
    let wy = select(3.0, 1.0, dy == 0 || dy == 3);
    let row = sample_src(base + vec2<i32>(0, dy), cb, mode, u.border)
      + 3.0 * sample_src(base + vec2<i32>(1, dy), cb, mode, u.border)
      + 3.0 * sample_src(base + vec2<i32>(2, dy), cb, mode, u.border)
      + sample_src(base + vec2<i32>(3, dy), cb, mode, u.border);
    acc = acc + row * wy;
  }
  return acc * (1.0 / 64.0);
}

// Aproned level k -> aproned level k + 1 4x4 separable [1, 3, 3, 1]/8 downsample.
// Level k's 2-texel apron preserves the exact infinite edge extension for Zero, Clamp and Border
// under the 4-tap filter across all odd/even sizes, so clamping reads to [0, prev_sw) x [0, prev_sh)
// is exact for all edge modes.
@fragment
fn fs_downsample_next(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
  let stored = vec2<i32>(pos.xy);
  let logical = stored - vec2<i32>(2, 2);
  let cb = vec4<i32>(
    i32(u.clamp_bounds.x),
    i32(u.clamp_bounds.y),
    i32(u.clamp_bounds.z),
    i32(u.clamp_bounds.w),
  );
  let base = logical * 2 + vec2<i32>(1, 1);
  var acc = vec4<f32>(0.0);
  for (var dy: i32 = 0; dy < 4; dy = dy + 1) {
    let wy = select(3.0, 1.0, dy == 0 || dy == 3);
    let row = sample_src(base + vec2<i32>(0, dy), cb, 1, u.border)
      + 3.0 * sample_src(base + vec2<i32>(1, dy), cb, 1, u.border)
      + 3.0 * sample_src(base + vec2<i32>(2, dy), cb, 1, u.border)
      + sample_src(base + vec2<i32>(3, dy), cb, 1, u.border);
    acc = acc + row * wy;
  }
  return acc * (1.0 / 64.0);
}

// Bilinear upsample from blurred level L scratch texture into dst over the scissored dirty rect.
// u.border.xy carries the active blurred size (bw, bh) inside the padded scratch texture so
// floating-point rounding never samples past the last written texel into scratch padding.
@fragment
fn fs_upsample(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
  let src_c = pos.xy + u.p0.xy;
  let l_coord = (src_c - u.clamp_bounds.xy) * u.p0.z;
  let local = clamp(l_coord - u.clamp_bounds.zw, vec2<f32>(0.5), u.border.xy - vec2<f32>(0.5));
  let uv = local * u.p2.xy;
  return textureSampleLevel(src_tex, src_samp, uv, 0.0);
}
