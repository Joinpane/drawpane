// The GPU kernels (decision 0040): the same arithmetic as exec.rs's `blend_pixel` and glass.rs,
// in WGSL. Each pass draws one triangle over the whole target, scissored to its region, so a
// fragment's position is its pixel in the page.

struct VsOut {
  @builtin(position) pos: vec4f,
};

@vertex
fn vs(@builtin(vertex_index) i: u32) -> VsOut {
  var corners = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var out: VsOut;
  out.pos = vec4f(corners[i], 0.0, 1.0);
  return out;
}

// ---- Blend kernel -------------------------------------------------------------------------

struct Comp {
  blend: u32,
  opacity: f32,
  pad0: u32,
  pad1: u32,
};

@group(0) @binding(0) var comp_src: texture_2d<f32>;
@group(0) @binding(1) var comp_dst: texture_2d<f32>;
@group(0) @binding(2) var<uniform> comp: Comp;

fn separable(blend: u32, cb: f32, cs: f32) -> f32 {
  switch blend {
    case 1u: { return cb * cs; }
    case 2u: { return cb + cs - cb * cs; }
    case 3u: {
      // Overlay is hard light with the layers swapped.
      if (cb <= 0.5) { return cs * 2.0 * cb; }
      let s = 2.0 * cb - 1.0;
      return cs + s - cs * s;
    }
    case 4u: { return min(cb, cs); }
    case 5u: { return max(cb, cs); }
    case 6u: {
      if (cb <= 0.0) { return 0.0; }
      if (cs >= 1.0) { return 1.0; }
      return min(cb / (1.0 - cs), 1.0);
    }
    case 7u: {
      if (cb >= 1.0) { return 1.0; }
      if (cs <= 0.0) { return 0.0; }
      return 1.0 - min((1.0 - cb) / cs, 1.0);
    }
    case 8u: {
      if (cs <= 0.5) { return cb * 2.0 * cs; }
      let s = 2.0 * cs - 1.0;
      return cb + s - cb * s;
    }
    case 9u: {
      if (cs <= 0.5) { return cb - (1.0 - 2.0 * cs) * cb * (1.0 - cb); }
      var d = sqrt(cb);
      if (cb <= 0.25) { d = ((16.0 * cb - 12.0) * cb + 4.0) * cb; }
      return cb + (2.0 * cs - 1.0) * (d - cb);
    }
    case 10u: { return abs(cb - cs); }
    case 11u: { return cb + cs - 2.0 * cb * cs; }
    default: { return cs; }
  }
}

fn blend_pixel(blend: u32, s: vec4f, b: vec4f) -> vec4f {
  let sa = s.a;
  let ba = b.a;
  let a = sa + ba - sa * ba;
  var out = vec4f(0.0, 0.0, 0.0, a);
  for (var i = 0; i < 3; i++) {
    var c: f32;
    if (blend == 100u) {
      c = min(s[i] + b[i], a);
    } else if (blend == 101u) {
      c = max(s[i] + b[i] - sa * ba, 0.0);
    } else if (blend >= 1u && blend <= 11u) {
      var cs = 0.0;
      var cb = 0.0;
      if (sa > 0.0) { cs = s[i] / sa; }
      if (ba > 0.0) { cb = b[i] / ba; }
      c = s[i] * (1.0 - ba) + b[i] * (1.0 - sa) + sa * ba * separable(blend, cb, cs);
    } else {
      c = s[i] + b[i] * (1.0 - sa);
    }
    out[i] = c;
  }
  return out;
}

@fragment
fn fs_composite(in: VsOut) -> @location(0) vec4f {
  let p = vec2i(in.pos.xy);
  let s = textureLoad(comp_src, p, 0) * comp.opacity;
  let b = textureLoad(comp_dst, p, 0);
  return clamp(blend_pixel(comp.blend, s, b), vec4f(0.0), vec4f(1.0));
}

// ---- Frost: a separable Gaussian, the edge of the area repeated ---------------------------

struct Blur {
  dir: vec2f,
  sigma: f32,
  pad: f32,
  area: vec4f,
};

@group(0) @binding(0) var blur_src: texture_2d<f32>;
@group(0) @binding(1) var<uniform> blur: Blur;

@fragment
fn fs_blur(in: VsOut) -> @location(0) vec4f {
  let p = vec2i(in.pos.xy);
  let lo = vec2i(blur.area.xy);
  let hi = vec2i(blur.area.zw) - vec2i(1);
  let r = i32(ceil(blur.sigma * 3.0));
  let d = vec2i(blur.dir);
  var acc = vec4f(0.0);
  var sum = 0.0;
  for (var i = -r; i <= r; i++) {
    let w = exp(-f32(i * i) / (2.0 * blur.sigma * blur.sigma));
    acc += textureLoad(blur_src, clamp(p + d * i, lo, hi), 0) * w;
    sum += w;
  }
  return acc / sum;
}

// ---- Glass (box), as glass.rs ------------------------------------------------------------

struct Glass {
  // 0: inverse transform a b c d; 1: e f, w, h; 2: radii tl tr br bl;
  // 3: refraction depth dispersion frost; 4: splay light.x light.y intensity;
  // 5: unit_px falloff hairline front; 6: front_start back back_start shade;
  // 7: shade_reach center.x center.y half.x; 8: half.y, area x0 y0 x1; 9: area y1.
  v: array<vec4f, 10>,
};

@group(0) @binding(0) var glass_under: texture_2d<f32>;
@group(0) @binding(1) var glass_seen: texture_2d<f32>;
@group(0) @binding(2) var glass_sampler: sampler;
@group(0) @binding(3) var<uniform> glass: Glass;

fn box_inside(local: vec2f) -> f32 {
  let w = glass.v[1].z;
  let h = glass.v[1].w;
  let half = vec2f(w, h) * 0.5;
  let q = local - half;
  let cap = min(half.x, half.y);
  let radii = clamp(glass.v[2], vec4f(0.0), vec4f(cap));
  var r = radii.z;
  if (q.x < 0.0) {
    if (q.y < 0.0) { r = radii.x; } else { r = radii.w; }
  } else if (q.y < 0.0) {
    r = radii.y;
  }
  let e = abs(q) - half + vec2f(r);
  let outside = length(max(e, vec2f(0.0)));
  return -(min(max(e.x, e.y), 0.0) + outside - r);
}

fn dist(p: vec2f) -> f32 {
  let m = glass.v[0];
  let t = glass.v[1].xy;
  let local = vec2f(m.x * p.x + m.z * p.y + t.x, m.y * p.x + m.w * p.y + t.y);
  return box_inside(local) * glass.v[5].x;
}

fn seen_at(p: vec2f) -> vec4f {
  let area = vec4f(glass.v[8].y, glass.v[8].z, glass.v[8].w, glass.v[9].x);
  let q = clamp(p, area.xy + vec2f(0.5), area.zw - vec2f(0.5));
  return textureSampleLevel(glass_seen, glass_sampler, q / vec2f(textureDimensions(glass_seen)), 0.0);
}

@fragment
fn fs_glass(in: VsOut) -> @location(0) vec4f {
  let p = in.pos.xy;
  let under = textureLoad(glass_under, vec2i(p), 0);
  let d0 = dist(p);
  let a = clamp(d0 + 0.5, 0.0, 1.0);
  if (a <= 0.0) { return under; }
  let refraction = glass.v[3].x;
  let depth = glass.v[3].y;
  let dispersion = glass.v[3].z;
  let splay = glass.v[4].x;
  let light = glass.v[4].yz;
  let intensity = glass.v[4].w;
  let unit_px = glass.v[5].x;
  let falloff = glass.v[5].y;
  let g = vec2f(dist(p + vec2f(1.0, 0.0)) - dist(p - vec2f(1.0, 0.0)), dist(p + vec2f(0.0, 1.0)) - dist(p - vec2f(0.0, 1.0))) * 0.5;
  let gl = length(g);
  var inward = vec2f(0.0);
  if (gl > 1e-6) { inward = g / gl; }
  let d = max(d0, 0.0);
  let fall = pow(clamp(1.0 - d / max(depth, 1.0), 0.0, 1.0), falloff);
  let along = vec2f(-inward.y, inward.x);
  let center = glass.v[7].yz;
  let half = vec2f(glass.v[7].w, glass.v[8].x);
  let extent = abs(along.x) * half.x + abs(along.y) * half.y;
  var off = 0.0;
  if (extent > 0.0) { off = dot(p - center, along) / extent; }
  let bend = (inward - along * off * splay) * fall * refraction;
  let red = seen_at(p + bend * (1.0 + dispersion));
  let green = seen_at(p + bend);
  let blue = seen_at(p + bend * (1.0 - dispersion));
  let seen_alpha = max(red.a, max(green.a, blue.a));
  var seen = vec3f(red.r, green.g, blue.b);
  let facing = -dot(inward, light);
  let hair = exp(-max(0.0, d - 0.5) / max(glass.v[5].z * unit_px, 1e-3));
  let edge = max(glass.v[5].w * (facing - glass.v[6].x), 0.0) + max(glass.v[6].y * (-facing - glass.v[6].z), 0.0);
  let shading = intensity * glass.v[6].w * facing * max(0.0, 1.0 - d / max(glass.v[7].x * depth, 1.0));
  if (shading > 0.0) {
    seen = seen * (1.0 - shading);
  } else {
    seen = seen + (vec3f(seen_alpha) - seen) * -shading;
  }
  let lit = clamp(intensity * edge * hair, 0.0, 1.0);
  seen = seen + (vec3f(seen_alpha) - seen) * lit;
  let out = vec4f(seen, seen_alpha) * a;
  return clamp(under * (1.0 - a) + out, vec4f(0.0), vec4f(1.0));
}
