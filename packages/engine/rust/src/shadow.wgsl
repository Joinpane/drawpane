// Shadow helper pass (decision 0040):
// - `fs_upsample_mask`: bilinearly upsamples a reduced-resolution blurred shadow mask to full
//   device resolution and optionally inverts alpha for inner shadows.
// Pure full-screen triangle fragment pass compatible with WebGPU Core, Compatibility, and
// wgpu's WebGL2 (GLSL ES 3.00) backend.

struct UpsampleUniforms {
  // xy = dst_origin_in_mask_px (full-res offset from reduced mask origin),
  // z  = inv_scale (1.0 / 2^shift),
  // w  = invert (1.0 for inner shadow, 0.0 for drop shadow).
  p0: vec4<f32>,
  // xy = reduced_origin_in_blurred_tex (reduced texels),
  // zw = 1.0 / blurred_tex_size (reduced texels).
  p1: vec4<f32>,
  // xy = active blurred region max center (bd_w - 0.5, bd_h - 0.5), zw = unused.
  p2: vec4<f32>,
};

@group(0) @binding(0) var src_tex: texture_2d<f32>;
@group(0) @binding(1) var src_samp: sampler;
@group(0) @binding(2) var<uniform> u: UpsampleUniforms;

@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
  let p = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4<f32>(p * 2.0 - 1.0, 0.0, 1.0);
}

@fragment
fn fs_upsample_mask(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
  // pos.xy is at pixel center `(x + 0.5, y + 0.5)` in dst coordinates.
  let full_pos = pos.xy + u.p0.xy;
  let red_pos = clamp(full_pos * u.p0.z - u.p1.xy, vec2<f32>(0.5), u.p2.xy);
  let uv = red_pos * u.p1.zw;
  let c = textureSampleLevel(src_tex, src_samp, uv, 0.0);
  let a = select(c.a, 1.0 - c.a, u.p0.w > 0.5);
  return vec4<f32>(0.0, 0.0, 0.0, clamp(a, 0.0, 1.0));
}
