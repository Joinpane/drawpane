// Backdrop-reader WGSL fragment shaders (decision 0007, 0039, 0040).
//
// Pure fragment shaders (no compute, no storage textures, no f16 shader extension) with
// std140-aligned vec4<f32> uniforms and strictly uniform control flow around dpdx/dpdy and
// textureSampleGrad, so they run on WebGPU core, WebGPU compatibility mode, and WebGL2 via naga.

@vertex
fn vs_fullscreen(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
    let p = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));
    return vec4<f32>(p * 2.0 - 1.0, 0.0, 1.0);
}

// ---------------------------------------------------------------------------
// 1. Copy-extended: extract (rw, rh) from frame backdrop with clamp-to-bounds
//    and optional nearest clipping-frame solid fill outside `within`.
// ---------------------------------------------------------------------------
struct CopyExtU {
    // (region_x0, region_y0, clamp_x0, clamp_y0) in backdrop texture pixels
    a: vec4<f32>,
    // (clamp_x1_minus_1, clamp_y1_minus_1, has_fill, is_empty)
    b: vec4<f32>,
    // (fill_x0, fill_y0, fill_x1, fill_y1) in backdrop texture pixels
    c: vec4<f32>,
    // premultiplied solid fill RGBA
    fill: vec4<f32>,
};

@group(0) @binding(0) var ce_src: texture_2d<f32>;
@group(0) @binding(1) var<uniform> ce_u: CopyExtU;

@fragment
fn fs_copy_extended(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
    if (ce_u.b.w > 0.5) {
        if (ce_u.b.z > 0.5) {
            return ce_u.fill;
        }
        return vec4<f32>(0.0);
    }
    let fx = floor(pos.x) + ce_u.a.x;
    let fy = floor(pos.y) + ce_u.a.y;
    if (ce_u.b.z > 0.5) {
        if (fx < ce_u.c.x || fx >= ce_u.c.z || fy < ce_u.c.y || fy >= ce_u.c.w) {
            return ce_u.fill;
        }
    }
    let cx = i32(clamp(fx, ce_u.a.z, ce_u.b.x));
    let cy = i32(clamp(fy, ce_u.a.w, ce_u.b.y));
    return textureLoad(ce_src, vec2<i32>(cx, cy), 0);
}

// Render-target UNORM conversion and texture filter precision can vary by GPU.
// Keep the glass prefilter's RGBA8 rounding and bilinear interpolation in the shader.
fn round_unorm8(value: vec4<f32>) -> vec4<f32> {
    return floor(clamp(value, vec4<f32>(0.0), vec4<f32>(1.0)) * 255.0 + 0.5) / 255.0;
}

fn bilinear_load(
    tex: texture_2d<f32>, uv: vec2<f32>, level: i32, dims: vec2<i32>,
) -> vec4<f32> {
    let p = clamp(uv, vec2<f32>(0.0), vec2<f32>(1.0)) * vec2<f32>(dims) - 0.5;
    let xy = vec2<i32>(floor(p));
    let f = fract(p);
    let lo = vec2<i32>(0);
    let hi = dims - 1;
    let a = textureLoad(tex, clamp(xy, lo, hi), level);
    let b = textureLoad(tex, clamp(xy + vec2<i32>(1, 0), lo, hi), level);
    let c = textureLoad(tex, clamp(xy + vec2<i32>(0, 1), lo, hi), level);
    let d = textureLoad(tex, clamp(xy + 1, lo, hi), level);
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

// ---------------------------------------------------------------------------
// 2. Centered 4-tap bilinear mipmap downsample (matches CPU build_mipmaps_cpu:
//    exact 2x2 box on even sizes, zero spatial shift on odd sizes).
// ---------------------------------------------------------------------------
@group(0) @binding(0) var mip_src: texture_2d<f32>;

@fragment
fn fs_mip_down(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
    let dims = vec2<i32>(textureDimensions(mip_src, 0));
    if (all((dims & vec2<i32>(1)) == vec2<i32>(0))) {
        // Match CPU's integer 2x2 box filter, including exact half-byte ties.
        let xy = vec2<i32>(pos.xy) * 2;
        let a = vec4<u32>(round(textureLoad(mip_src, xy, 0) * 255.0));
        let b = vec4<u32>(round(textureLoad(mip_src, xy + vec2<i32>(1, 0), 0) * 255.0));
        let c = vec4<u32>(round(textureLoad(mip_src, xy + vec2<i32>(0, 1), 0) * 255.0));
        let d = vec4<u32>(round(textureLoad(mip_src, xy + 1, 0) * 255.0));
        return vec4<f32>((a + b + c + d + 2u) / 4u) / 255.0;
    }
    let dst_dims = vec2<f32>(max(dims / 2, vec2<i32>(1)));
    let base = floor(pos.xy);
    let inv = vec2<f32>(1.0) / dst_dims;
    let c00 = bilinear_load(mip_src, (base + vec2<f32>(0.25, 0.25)) * inv, 0, dims);
    let c10 = bilinear_load(mip_src, (base + vec2<f32>(0.75, 0.25)) * inv, 0, dims);
    let c01 = bilinear_load(mip_src, (base + vec2<f32>(0.25, 0.75)) * inv, 0, dims);
    let c11 = bilinear_load(mip_src, (base + vec2<f32>(0.75, 0.75)) * inv, 0, dims);
    return round_unorm8((c00 + c10 + c01 + c11) * 0.25);
}

// Motion readers need only a low-resolution prefix. Sample the original directly
// with the filter hardware, without a full-size copy into the mip texture.
@group(0) @binding(0) var coarse_down_src: texture_2d<f32>;
@group(0) @binding(1) var coarse_down_sampler: sampler;

@fragment
fn fs_coarse_down(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
    let size = max(textureDimensions(coarse_down_src) / 2u, vec2<u32>(1u));
    return textureSampleLevel(coarse_down_src, coarse_down_sampler, pos.xy / vec2<f32>(size), 0.0);
}

// ---------------------------------------------------------------------------
// 3. Rim height downsample: average k x k alpha texels of mask into RGBA16F.
// ---------------------------------------------------------------------------
struct DownU {
    // (rw, rh, k, packed mask origin)
    info: vec4<f32>,
};

@group(0) @binding(0) var down_mask: texture_2d<f32>;
@group(0) @binding(1) var<uniform> down_u: DownU;

// A mask slot has a 10-bit coordinate on each axis.
fn mask_atlas_origin(packed: f32) -> vec2<i32> {
    let bits = i32(packed);
    return vec2<i32>(bits & 1023, bits >> 10);
}

@fragment
fn fs_down(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
    let k = i32(clamp(down_u.info.z, 1.0, 8.0));
    let max_c = vec2<i32>(i32(down_u.info.x) - 1, i32(down_u.info.y) - 1);
    let base = vec2<i32>(floor(pos.xy)) * k;
    var sum = 0.0;
    for (var j = 0; j < 8; j = j + 1) {
        if (j >= k) { break; }
        let sy = min(base.y + j, max_c.y);
        for (var i = 0; i < 8; i = i + 1) {
            if (i >= k) { break; }
            let sx = min(base.x + i, max_c.x);
            sum = sum + textureLoad(down_mask, vec2<i32>(sx, sy) + mask_atlas_origin(down_u.info.w), 0).a;
        }
    }
    let n = f32(k * k);
    return vec4<f32>(sum / n, 0.0, 0.0, 0.0);
}

// ---------------------------------------------------------------------------
// 4. Rim height separable Gaussian + derivative-of-Gaussian (RGBA16F or packed RGBA8).
// ---------------------------------------------------------------------------
struct BlurU {
    // (valid_w, valid_h, sigma, radius)
    info: vec4<f32>,
    // (packed_rgba8, horizontal_reads_mask_alpha, mask_x, mask_y)
    pack: vec4<f32>,
};

@group(0) @binding(0) var blur_src: texture_2d<f32>;
@group(0) @binding(1) var<uniform> blur_u: BlurU;

@fragment
fn fs_blur_x(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
    let p = vec2<i32>(floor(pos.xy));
    let valid_w = i32(blur_u.info.x);
    let sigma = clamp(blur_u.info.z, 1e-3, 1e12);
    let radius = i32(blur_u.info.w);
    let inv2 = 1.0 / (2.0 * sigma * sigma);
    let inv_s2 = 1.0 / (sigma * sigma);
    var h = 0.0;
    var dx = 0.0;
    var total = 0.0;
    for (var i = -radius; i <= radius; i = i + 1) {
        let x = f32(i);
        let w = exp(-x * x * inv2);
        let qx = p.x + i;
        var m = 0.0;
        if (qx >= 0 && qx < valid_w) {
            let mask_offset = vec2<i32>(blur_u.pack.zw);
            let local = vec2<i32>(qx, p.y);
            let src = textureLoad(blur_src, select(local, local + mask_offset, blur_u.pack.y > 0.5), 0);
            m = src.r;
            if (blur_u.pack.y > 0.5) {
                m = src.a;
                if (blur_u.pack.x < 0.5) {
                    m = quantizeToF16(m);
                }
            }
        }
        h = h + w * m;
        dx = dx + w * m * x * inv_s2;
        total = total + w;
    }
    let out_h = h / max(total, 1e-6);
    let out_dx = dx / max(total, 1e-6);
    if (blur_u.pack.x > 0.5) {
        return vec4<f32>(out_h, clamp(0.5 + 0.5 * out_dx, 0.0, 1.0), 0.0, 1.0);
    }
    return vec4<f32>(out_h, out_dx, 0.0, 0.0);
}

@fragment
fn fs_blur_y(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
    let p = vec2<i32>(floor(pos.xy));
    let valid_h = i32(blur_u.info.y);
    let sigma = clamp(blur_u.info.z, 1e-3, 1e12);
    let radius = i32(blur_u.info.w);
    let packed = blur_u.pack.x > 0.5;
    let inv2 = 1.0 / (2.0 * sigma * sigma);
    let inv_s2 = 1.0 / (sigma * sigma);
    var h = 0.0;
    var dx = 0.0;
    var dy = 0.0;
    var total = 0.0;
    for (var i = -radius; i <= radius; i = i + 1) {
        let y = f32(i);
        let w = exp(-y * y * inv2);
        let qy = p.y + i;
        var v = vec2<f32>(0.0);
        if (qy >= 0 && qy < valid_h) {
            v = textureLoad(blur_src, vec2<i32>(p.x, qy), 0).rg;
            if (packed) {
                v.g = (v.g - 0.5) * 2.0;
            }
        }
        h = h + w * v.r;
        dx = dx + w * v.g;
        dy = dy + w * v.r * y * inv_s2;
        total = total + w;
    }
    let out_h = h / max(total, 1e-6);
    let out_dx = dx / max(total, 1e-6);
    let out_dy = dy / max(total, 1e-6);
    if (packed) {
        return vec4<f32>(
            out_h,
            clamp(0.5 + 0.5 * out_dx, 0.0, 1.0),
            clamp(0.5 + 0.5 * out_dy, 0.0, 1.0),
            1.0
        );
    }
    return vec4<f32>(out_h, out_dx, out_dy, 0.0);
}

// ---------------------------------------------------------------------------
// 5. Mip-assisted separable frost Gaussian (RGBA8).
// ---------------------------------------------------------------------------
struct FrostU {
    // (fw, fh, dir_x, dir_y)
    a: vec4<f32>,
    // (lod, sigma, radius, 0)
    b: vec4<f32>,
};

@group(0) @binding(0) var frost_src: texture_2d<f32>;
@group(0) @binding(1) var<uniform> frost_u: FrostU;

@fragment
fn fs_frost(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
    let size = max(frost_u.a.xy, vec2<f32>(1.0));
    let dir = frost_u.a.zw;
    let lod = i32(frost_u.b.x);
    let source_size = vec2<i32>(textureDimensions(frost_src, lod));
    let aligned = all(source_size == vec2<i32>(size));
    let sigma = clamp(frost_u.b.y, 1e-3, 1e12);
    let radius = i32(frost_u.b.z);
    let inv2 = 0.5 / (sigma * sigma);
    var sum = vec4<f32>(0.0);
    var total = 0.0;
    for (var i = -radius; i <= radius; i = i + 1) {
        let fi = f32(i);
        let w = exp(-fi * fi * inv2);
        let tap = pos.xy + dir * fi;
        var rgba: vec4<f32>;
        if (aligned) {
            let xy = clamp(vec2<i32>(floor(tap)), vec2<i32>(0), source_size - 1);
            rgba = textureLoad(frost_src, xy, lod);
        } else {
            rgba = bilinear_load(frost_src, tap / size, lod, source_size);
        }
        sum = sum + rgba * w;
        total = total + w;
    }
    return round_unorm8(sum / max(total, 1e-6));
}

// ---------------------------------------------------------------------------
// 6. Full glass refraction, dispersion, splay, lighting, and premul replace.
// ---------------------------------------------------------------------------
struct GlassU {
    // (backdrop width, backdrop height, rim mask x offset, rim mask y offset)
    sizes: vec4<f32>,
    // (region_x0_in_target, region_y0_in_target, dst_x0_in_target, dst_y0_in_target)
    origin: vec4<f32>,
    // (k, sigma, depth, refraction)
    rim: vec4<f32>,
    // (dispersion, splay, intensity, unit_px)
    lens: vec4<f32>,
    // (center_x, center_y, half_x, half_y)
    geom: vec4<f32>,
    // (light_x, light_y, box_flag, alpha_opacity)
    light_box: vec4<f32>,
    // (to_box_a, to_box_c, to_box_e, box_w)
    to_box_x: vec4<f32>,
    // (to_box_b, to_box_d, to_box_f, box_h)
    to_box_y: vec4<f32>,
    // (r_tl, r_tr, r_br, r_bl)
    box_radii: vec4<f32>,
    // (s_tl, s_tr, s_br, s_bl)
    box_smoothing: vec4<f32>,
    // (profile, falloff, hairline_px, has_clip_mask)
    tune_a: vec4<f32>,
    // (front, front_start, back, back_start)
    tune_b: vec4<f32>,
    // (shade, shade_reach, valid_lw, valid_lh)
    tune_c: vec4<f32>,
    // (flags: bit0=height_packed bit1=quad_phase_x bit2=quad_phase_y, mask_x, mask_y, device px per optical px)
    tune_d: vec4<f32>,
    // (native coordinate at the optical origin, native sampling enabled, backdrop divisor)
    native_map: vec4<f32>,
    native_bounds: vec4<f32>,
};

@group(0) @binding(0) var g_backdrop: texture_2d<f32>;
@group(0) @binding(1) var g_mip_samp: sampler;
@group(0) @binding(2) var g_mask: texture_2d<f32>;
@group(0) @binding(3) var g_height: texture_2d<f32>;
@group(0) @binding(4) var g_dst: texture_2d<f32>;
@group(0) @binding(5) var g_clip: texture_2d<f32>;
@group(0) @binding(6) var g_lin_samp: sampler;
@group(0) @binding(7) var<uniform> gu: GlassU;
@group(0) @binding(8) var g_native: texture_2d<f32>;

fn safe_pow(base: f32, exponent: f32) -> f32 {
    // Metal/ANGLE pow(0.0, y) can be undefined or NaN; keep base strictly positive even on untaken lanes.
    return select(0.0, pow(clamp(base, 1e-30, 1.0), clamp(exponent, 0.0, 16.0)), base > 0.0);
}

fn erfinv(x: f32) -> f32 {
    var w = -log(clamp((1.0 - x) * (1.0 + x), 1e-7, 1.0));
    var q = 0.0;
    if (w < 5.0) {
        w = w - 2.5;
        q = 2.81022636e-08;
        q = 3.43273939e-07 + q * w;
        q = -3.5233877e-06 + q * w;
        q = -4.39150654e-06 + q * w;
        q = 0.00021858087 + q * w;
        q = -0.00125372503 + q * w;
        q = -0.00417768164 + q * w;
        q = 0.246640727 + q * w;
        q = 1.50140941 + q * w;
    } else {
        w = sqrt(max(w, 0.0)) - 3.0;
        q = -0.000200214257;
        q = 0.000100950558 + q * w;
        q = 0.00134934322 + q * w;
        q = -0.00367342844 + q * w;
        q = 0.00573950773 + q * w;
        q = -0.0076224613 + q * w;
        q = 0.00943887047 + q * w;
        q = 1.00167406 + q * w;
        q = 2.83297682 + q * w;
    }
    return q * x;
}

fn corner_distance(along: f32, off: f32, r: f32, s: f32) -> f32 {
    let p = (1.0 + s) * r;
    if (along >= p) {
        return off;
    }
    let arc_angle = 1.5707963 * (1.0 - s);
    let arc_chord = sin(arc_angle * 0.5) * r * 1.4142136;
    let alpha = (1.5707963 - arc_angle) * 0.5;
    let c = r * tan(alpha * 0.5) * cos(0.7853982 * s);
    let d = c * tan(0.7853982 * s);
    let b = (p - arc_chord - c - d) / 3.0;
    let a = 2.0 * b;
    let x3 = p - a - b - c;
    let v = vec2<f32>(along, off) - vec2<f32>(r, r);
    let to_start = vec2<f32>(x3, d) - vec2<f32>(r, r);
    if (to_start.x * v.y - to_start.y * v.x <= 0.0) {
        return r - length(v);
    }
    var lo = 0.0;
    var hi = 1.0;
    for (var i = 0; i < 12; i = i + 1) {
        let t = 0.5 * (lo + hi);
        let u = 1.0 - t;
        let x = u * u * u * p + 3.0 * u * u * t * (p - a) + 3.0 * u * t * t * (p - a - b) + t * t * t * x3;
        if (x > along) {
            lo = t;
        } else {
            hi = t;
        }
    }
    let t = 0.5 * (lo + hi);
    let u = 1.0 - t;
    let dx = -3.0 * u * u * a - 6.0 * u * t * b + 3.0 * t * t * (x3 - p + a + b);
    let slope = clamp(3.0 * d * t * t / min(dx, -1e-6), -1e12, 1e12);
    return (off - d * t * t * t) / sqrt(1.0 + slope * slope);
}

fn box_distance_params(
    p: vec2<f32>,
    to_box_x: vec4<f32>,
    to_box_y: vec4<f32>,
    box_radii: vec4<f32>,
    box_smoothing: vec4<f32>,
    unit_px: f32,
) -> f32 {
    let bx = to_box_x.x * p.x + to_box_x.y * p.y + to_box_x.z;
    let by = to_box_y.x * p.x + to_box_y.y * p.y + to_box_y.z;
    let box_size = vec2<f32>(to_box_x.w, to_box_y.w);
    let q = vec2<f32>(bx, by) - box_size * 0.5;
    let r = select(
        select(box_radii.z, box_radii.y, q.y < 0.0),
        select(box_radii.w, box_radii.x, q.y < 0.0),
        q.x < 0.0
    );
    let s = select(
        select(box_smoothing.z, box_smoothing.y, q.y < 0.0),
        select(box_smoothing.w, box_smoothing.x, q.y < 0.0),
        q.x < 0.0
    );
    if (r <= 0.0 || s <= 0.0) {
        let e = abs(q) - box_size * 0.5 + vec2<f32>(r, r);
        return -(min(max(e.x, e.y), 0.0) + length(max(e, vec2<f32>(0.0))) - r) * unit_px;
    }
    let e = box_size * 0.5 - abs(q);
    return corner_distance(max(e.x, e.y), min(e.x, e.y), r, s) * unit_px;
}

fn box_distance(p: vec2<f32>) -> f32 {
    return box_distance_params(p, gu.to_box_x, gu.to_box_y, gu.box_radii, gu.box_smoothing, gu.lens.w);
}

struct LensSample {
    bend: vec2<f32>,
    inward: vec2<f32>,
    distance: f32,
};

fn lens_sample(p: vec2<f32>) -> LensSample {
    let k = max(gu.rim.x, 1.0);
    let sigma = max(gu.rim.y, 1e-3);
    let depth = gu.rim.z;
    let refraction = gu.rim.w;
    let splay = gu.lens.y;
    let is_box = gu.light_box.z > 0.5;
    let valid_h = gu.tune_c.zw;
    let h_px = clamp((p - gu.sizes.zw) / k, vec2<f32>(0.5), max(valid_h - vec2<f32>(0.5), vec2<f32>(0.5)));
    let h_uv = clamp(h_px / vec2<f32>(textureDimensions(g_height)), vec2<f32>(0.0), vec2<f32>(1.0));
    let hs = textureSampleLevel(g_height, g_lin_samp, h_uv, 0.0).rgb;
    let grad_raw = select(hs.gb, (hs.gb - vec2<f32>(0.5)) * 2.0, (i32(gu.tune_d.x) & 1) != 0);
    let grad = grad_raw / k;
    let g = length(grad);
    var d_raw: f32;
    if (is_box) {
        d_raw = box_distance(p);
    } else {
        d_raw = 1.4142136 * sigma * erfinv(clamp(2.0 * hs.r - 1.0, -0.99999, 0.99999));
    }
    let d = max(0.0, d_raw);
    let slope = select(
        clamp(g * sigma * 2.5066283, 0.0, 1.0),
        exp(-0.5 * (d / sigma) * (d / sigma)),
        is_box
    );
    let inward = select(vec2<f32>(0.0), grad / max(g, 1e-6), g > 1e-6);
    let rim = safe_pow(slope, gu.tune_a.x);
    let fall = select(
        rim,
        safe_pow(clamp(1.0 - d / max(depth, 1.0 / gu.tune_d.w), 0.0, 1.0), gu.tune_a.y),
        is_box
    );
    let along = vec2<f32>(-inward.y, inward.x);
    let extent = abs(along.x) * gu.geom.z + abs(along.y) * gu.geom.w;
    let off = select(0.0, dot(p - gu.geom.xy, along) / max(extent, 1e-6), extent > 0.0);
    let bend = (inward - along * off * splay) * fall * refraction;

    return LensSample(bend, inward, d);
}

// Clear glass can sample unreduced backdrop pixels when the displaced ray
// stays in the viewport. Fade over the last device pixel at the halo boundary.
fn glass_color(uv: vec2<f32>, dx: vec2<f32>, dy: vec2<f32>) -> vec4<f32> {
    let halo_color = textureSampleGrad(g_backdrop, g_mip_samp, uv, dx, dy);
    if (gu.native_map.z < 0.5 || gu.native_bounds.z <= gu.native_bounds.x || gu.native_bounds.w <= gu.native_bounds.y) {
        return halo_color;
    }
    let scale = gu.sizes.xy * gu.native_map.w;
    let native_px = uv * scale + gu.native_map.xy;
    let edge = min(native_px - gu.native_bounds.xy, gu.native_bounds.zw - native_px);
    let footprint = max(length(dx * scale), length(dy * scale));
    let blend = clamp(min(edge.x, edge.y) + 0.5, 0.0, 1.0)
        * (1.0 - clamp((footprint - 1.0) / (gu.native_map.w - 1.0), 0.0, 1.0));
    // Clamp inside the logical native bounds so a growable scratch texture never leaks padding texels.
    let lo = gu.native_bounds.xy + vec2<f32>(0.5);
    let hi = max(lo, gu.native_bounds.zw - vec2<f32>(0.5));
    let uv_native = clamp(native_px, lo, hi) / vec2<f32>(textureDimensions(g_native));
    return mix(halo_color, textureSampleLevel(g_native, g_lin_samp, uv_native, 0.0), blend);
}

@fragment
fn fs_glass(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
    let p = (pos.xy - gu.origin.xy) / gu.tune_d.w;
    let rw = max(gu.sizes.x, 1.0);
    let rh = max(gu.sizes.y, 1.0);
    let depth = gu.rim.z;
    let dispersion = gu.lens.x;
    let intensity = gu.lens.z;
    let lens = lens_sample(p);
    let d = lens.distance;
    let inward = lens.inward;
    let inv_size = (gu.tune_d.w / gu.native_map.w) / vec2<f32>(rw, rh);
    let uv_r = (p + lens.bend * (1.0 + dispersion)) * inv_size;
    let uv_g = (p + lens.bend) * inv_size;
    let uv_b = (p + lens.bend * (1.0 - dispersion)) * inv_size;
    var dx_r = dpdx(uv_r);
    var dx_g = dpdx(uv_g);
    var dx_b = dpdx(uv_b);
    var dy_r = dpdy(uv_r);
    var dy_g = dpdy(uv_g);
    var dy_b = dpdy(uv_b);
    // Post-effect scopes can start on an odd frame pixel. Sample the other lane
    // of the frame-aligned quad on any axis where hardware quads are out of phase.
    let tune_flags = i32(gu.tune_d.x);
    if ((tune_flags & 2) != 0) {
        let step = select(-1.0, 1.0, (i32(pos.x) & 1) != 0);
        let q = p + vec2<f32>(step / gu.tune_d.w, 0.0);
        let bend = lens_sample(q).bend;
        dx_r = ((q + bend * (1.0 + dispersion)) * inv_size - uv_r) * step;
        dx_g = ((q + bend) * inv_size - uv_g) * step;
        dx_b = ((q + bend * (1.0 - dispersion)) * inv_size - uv_b) * step;
    }
    if ((tune_flags & 4) != 0) {
        let step = select(-1.0, 1.0, (i32(pos.y) & 1) != 0);
        let q = p + vec2<f32>(0.0, step / gu.tune_d.w);
        let bend = lens_sample(q).bend;
        dy_r = ((q + bend * (1.0 + dispersion)) * inv_size - uv_r) * step;
        dy_g = ((q + bend) * inv_size - uv_g) * step;
        dy_b = ((q + bend * (1.0 - dispersion)) * inv_size - uv_b) * step;
    }

    let red = glass_color(uv_r, dx_r, dy_r);
    let green = glass_color(uv_g, dx_g, dy_g);
    let blue = glass_color(uv_b, dx_b, dy_b);

    let dst_coord = vec2<i32>(floor(pos.xy - gu.origin.zw));
    let dst = textureLoad(g_dst, dst_coord, 0);

    let mask_coord = vec2<i32>(floor(p));
    let in_mask = mask_coord.x >= 0 && mask_coord.y >= 0 && mask_coord.x < i32(rw) && mask_coord.y < i32(rh);
    var a = select(0.0, 1.0, gu.native_map.w > 1.0);
    if (gu.native_map.w == 1.0 && in_mask) {
        a = textureLoad(g_mask, mask_coord + vec2<i32>(gu.tune_d.yz), 0).a;
    }
    var clip_cov = 1.0;
    if (gu.tune_a.w > 0.5) {
        clip_cov = textureLoad(g_clip, dst_coord, 0).a;
    }
    let a_eff = clamp(a * clip_cov * gu.light_box.w, 0.0, 1.0);
    if (a_eff <= 0.0) {
        return dst;
    }

    let seen_alpha = max(red.a, max(green.a, blue.a));
    var seen = vec3<f32>(red.r, green.g, blue.b);
    let facing = dot(-inward, gu.light_box.xy);
    let hair = exp(-max(0.0, d - 0.5 / gu.tune_d.w) / max(gu.tune_a.z, 1e-3));
    let edge = max(gu.tune_b.x * (facing - gu.tune_b.y), 0.0) + max(gu.tune_b.z * (-facing - gu.tune_b.w), 0.0);
    let shading = intensity * gu.tune_c.x * facing * max(0.0, 1.0 - d / max(gu.tune_c.y * depth, 1.0 / gu.tune_d.w));
    seen = select(
        mix(seen, vec3<f32>(seen_alpha), -shading),
        mix(seen, vec3<f32>(0.0), shading),
        shading > 0.0
    );
    seen = mix(seen, vec3<f32>(seen_alpha), clamp(intensity * edge * hair, 0.0, 1.0));

    let glass_col = vec4<f32>(seen, seen_alpha);
    return dst * (1.0 - a_eff) + glass_col * a_eff;
}

// ---------------------------------------------------------------------------
// 7. Fast coarse glass stand-in during interactive movement (decision 0042).
//    Supports analytic box/ellipse coverage (skipping vello_gpu mask passes)
//    as well as texture mask coverage for arbitrary paths.
// ---------------------------------------------------------------------------
struct CoarseU {
    // (rw, rh, lod, alpha_opacity)
    a: vec4<f32>,
    // (region_x0_in_target, region_y0_in_target, dst_x0_in_target, dst_y0_in_target)
    origin: vec4<f32>,
    // (has_clip_mask, mask_mode: 0=tex 1=box 2=ellipse, unit_px, 0)
    flags: vec4<f32>,
    // (uv_offset_x, uv_offset_y, inv_backdrop_w, inv_backdrop_h)
    uv_map: vec4<f32>,
    // (to_box_a, to_box_c, to_box_e, box_w)
    to_box_x: vec4<f32>,
    // (to_box_b, to_box_d, to_box_f, box_h)
    to_box_y: vec4<f32>,
    // (r_tl, r_tr, r_br, r_bl)
    box_radii: vec4<f32>,
    // (s_tl, s_tr, s_br, s_bl)
    box_smoothing: vec4<f32>,
};

@group(0) @binding(0) var c_backdrop: texture_2d<f32>;
@group(0) @binding(1) var c_mip_samp: sampler;
@group(0) @binding(2) var c_mask: texture_2d<f32>;
@group(0) @binding(3) var c_dst: texture_2d<f32>;
@group(0) @binding(4) var c_clip: texture_2d<f32>;
@group(0) @binding(5) var<uniform> cu: CoarseU;

@fragment
fn fs_glass_coarse(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
    let dst_coord = vec2<i32>(floor(pos.xy - cu.origin.zw));
    let dst = textureLoad(c_dst, dst_coord, 0);
    let p = pos.xy - cu.origin.xy;
    let mask_mode = cu.flags.y;
    var a = 0.0;
    if (mask_mode > 1.5) {
        // Analytic ellipse coverage in local box coordinates.
        let bx = cu.to_box_x.x * p.x + cu.to_box_x.y * p.y + cu.to_box_x.z;
        let by = cu.to_box_y.x * p.x + cu.to_box_y.y * p.y + cu.to_box_y.z;
        let half = max(vec2<f32>(cu.to_box_x.w, cu.to_box_y.w) * 0.5, vec2<f32>(1e-4));
        let u = (vec2<f32>(bx, by) - half) / half;
        let r = length(u);
        let grad_len = length(u / half);
        let d_px = select(min(half.x, half.y), (1.0 - r) / max(grad_len, 1e-6), grad_len > 1e-6) * cu.flags.z;
        a = clamp(d_px + 0.5, 0.0, 1.0);
    } else if (mask_mode > 0.5) {
        // Analytic rounded/smoothed box coverage.
        let d_px = box_distance_params(p, cu.to_box_x, cu.to_box_y, cu.box_radii, cu.box_smoothing, cu.flags.z);
        a = clamp(d_px + 0.5, 0.0, 1.0);
    } else {
        let mask_coord = vec2<i32>(floor(p));
        let rw = i32(cu.a.x);
        let rh = i32(cu.a.y);
        if (mask_coord.x < 0 || mask_coord.y < 0 || mask_coord.x >= rw || mask_coord.y >= rh) {
            return dst;
        }
        a = textureLoad(c_mask, mask_coord, 0).a;
    }
    var clip_cov = 1.0;
    if (cu.flags.x > 0.5) {
        clip_cov = textureLoad(c_clip, dst_coord, 0).a;
    }
    let a_eff = clamp(a * clip_cov * cu.a.w, 0.0, 1.0);
    if (a_eff <= 0.0) {
        return dst;
    }
    let uv = clamp((p + cu.uv_map.xy) * cu.uv_map.zw, vec2<f32>(0.0), vec2<f32>(1.0));
    let seen = textureSampleLevel(c_backdrop, c_mip_samp, uv, cu.a.z);
    return dst * (1.0 - a_eff) + seen * a_eff;
}

// ---------------------------------------------------------------------------
// 8. Premultiplied opacity composite (delta blits) & constant-blend lerp (isolated pop).
// ---------------------------------------------------------------------------
struct CompU {
    // (source scale, signed destination origin x/y, unused)
    info: vec4<f32>,
};

@group(0) @binding(0) var comp_src: texture_2d<f32>;
@group(0) @binding(1) var<uniform> comp_u: CompU;

fn composite_color(pos: vec4<f32>) -> vec4<f32> {
    let p = vec2<i32>(floor(pos.xy)) - vec2<i32>(comp_u.info.yz);
    return textureLoad(comp_src, p, 0) * comp_u.info.x;
}

@fragment
fn fs_composite(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
    return composite_color(pos);
}

struct DualComposite {
    @location(0) main: vec4<f32>,
    @location(1) backdrop: vec4<f32>,
};

@fragment
fn fs_composite_dual(@builtin(position) pos: vec4<f32>) -> DualComposite {
    let color = composite_color(pos);
    return DualComposite(color, color);
}

// ---------------------------------------------------------------------------
// 9. Background blur masked premultiplied replace (decision 0039 / 0040).
// ---------------------------------------------------------------------------
struct BgBlurCompU {
    // (dirty_x0_in_target, dirty_y0_in_target, alpha, has_clip_mask)
    a: vec4<f32>,
    // (coarse origin x/y, low pixels per device pixel, unused)
    map: vec4<f32>,
    size: vec4<f32>,
};

@group(0) @binding(0) var bg_blurred: texture_2d<f32>;
@group(0) @binding(1) var bg_mask: texture_2d<f32>;
@group(0) @binding(2) var bg_dst: texture_2d<f32>;
@group(0) @binding(3) var bg_clip: texture_2d<f32>;
@group(0) @binding(4) var<uniform> bgu: BgBlurCompU;

@fragment
fn fs_bg_blur_composite(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
    let local = vec2<i32>(floor(pos.xy - bgu.a.xy));
    let dst = textureLoad(bg_dst, local, 0);
    let m = textureLoad(bg_mask, local, 0).a;
    var clip_cov = 1.0;
    if (bgu.a.w > 0.5) {
        clip_cov = textureLoad(bg_clip, local, 0).a;
    }
    let a_eff = clamp(m * clip_cov * bgu.a.z, 0.0, 1.0);
    if (a_eff <= 0.0) {
        return dst;
    }
    var blurred = textureLoad(bg_blurred, local, 0);
    if (bgu.map.z > 0.0) {
        let last = bgu.size.xy - vec2<f32>(1.0);
        let p = clamp(pos.xy * bgu.map.z + bgu.map.xy - vec2<f32>(0.5), vec2<f32>(0.0), last);
        let a = vec2<i32>(floor(p));
        let b = vec2<i32>(min(vec2<f32>(a) + 1.0, last));
        let f = fract(p);
        blurred = mix(
            mix(textureLoad(bg_blurred, a, 0), textureLoad(bg_blurred, vec2<i32>(b.x, a.y), 0), f.x),
            mix(textureLoad(bg_blurred, vec2<i32>(a.x, b.y), 0), textureLoad(bg_blurred, b, 0), f.x),
            f.y
        );
    }
    return dst * (1.0 - a_eff) + blurred * a_eff;
}

// ---------------------------------------------------------------------------
// 10. Progressive background blur from slice atlas + masked premultiplied replace.
// ---------------------------------------------------------------------------
struct ProgBlurU {
    // (tile_x0_in_target, tile_y0_in_target, tile_w, tile_h)
    tile: vec4<f32>,
    // (mask_off_x, mask_off_y, alpha, has_clip_mask)
    mask_info: vec4<f32>,
    // (start_x_in_frame, start_y_in_frame, dir_x_div_len2, dir_y_div_len2)
    grad: vec4<f32>,
    // (start_sigma, end_sigma, stop_count, atlas_cols)
    params: vec4<f32>,
    // Up to 12 monotonic sigma stops
    stops0: vec4<f32>,
    stops1: vec4<f32>,
    stops2: vec4<f32>,
    // (frame_x_of_target, frame_y_of_target, unused, unused)
    frame_origin: vec4<f32>,
    // Tier 1 coarse patch: (offset x/y, inverse divisor, first stop)
    halo_map: vec4<f32>,
    // Tier 1 atlas: (stop cell width and height, atlas columns, unused)
    halo_atlas: vec4<f32>,
    // Tier 2 (farther) coarse patch: (offset x/y, inverse divisor, first stop)
    halo2_map: vec4<f32>,
    // Tier 2 atlas: (stop cell width and height, atlas columns, unused)
    halo2_atlas: vec4<f32>,
};

@group(0) @binding(0) var pb_atlas: texture_2d<f32>;
@group(0) @binding(1) var pb_mask: texture_2d<f32>;
@group(0) @binding(2) var pb_dst: texture_2d<f32>;
@group(0) @binding(3) var pb_clip: texture_2d<f32>;
@group(0) @binding(4) var<uniform> pbu: ProgBlurU;
@group(0) @binding(5) var pb_halo: texture_2d<f32>;
@group(0) @binding(6) var pb_halo2: texture_2d<f32>;

fn prog_stop(i: i32) -> f32 {
    if (i < 4) {
        if (i == 0) { return pbu.stops0.x; }
        if (i == 1) { return pbu.stops0.y; }
        if (i == 2) { return pbu.stops0.z; }
        return pbu.stops0.w;
    }
    if (i < 8) {
        if (i == 4) { return pbu.stops1.x; }
        if (i == 5) { return pbu.stops1.y; }
        if (i == 6) { return pbu.stops1.z; }
        return pbu.stops1.w;
    }
    if (i == 8) { return pbu.stops2.x; }
    if (i == 9) { return pbu.stops2.y; }
    if (i == 10) { return pbu.stops2.z; }
    return pbu.stops2.w;
}

fn sample_halo_atlas(
    tex: texture_2d<f32>,
    cell: i32,
    map: vec4<f32>,
    atlas: vec4<f32>,
    pos: vec2<f32>,
) -> vec4<f32> {
    let cols = max(1, i32(atlas.z));
    let start = vec2<i32>(cell % cols, cell / cols) * vec2<i32>(atlas.xy);
    let last = atlas.xy - vec2<f32>(1.0);
    let p = clamp(pos * map.z + map.xy - vec2<f32>(0.5), vec2<f32>(0.0), last);
    let a = vec2<i32>(floor(p)) + start;
    let b = vec2<i32>(min(floor(p) + 1.0, last)) + start;
    let f = fract(p);
    return mix(
        mix(textureLoad(tex, a, 0), textureLoad(tex, vec2<i32>(b.x, a.y), 0), f.x),
        mix(textureLoad(tex, vec2<i32>(a.x, b.y), 0), textureLoad(tex, b, 0), f.x),
        f.y
    );
}

fn sample_progressive_stop(stop: i32, local: vec2<i32>, pos: vec2<f32>) -> vec4<f32> {
    if (pbu.halo2_map.z > 0.0 && stop >= i32(pbu.halo2_map.w)) {
        return sample_halo_atlas(pb_halo2, stop - i32(pbu.halo2_map.w), pbu.halo2_map, pbu.halo2_atlas, pos);
    }
    if (pbu.halo_map.z > 0.0 && stop >= i32(pbu.halo_map.w)) {
        return sample_halo_atlas(pb_halo, stop - i32(pbu.halo_map.w), pbu.halo_map, pbu.halo_atlas, pos);
    }
    let cols = max(1, i32(pbu.params.w));
    let start = vec2<i32>(stop % cols, stop / cols) * vec2<i32>(pbu.tile.zw);
    return textureLoad(pb_atlas, start + local, 0);
}

struct HaloClipBorderU {
    clip: vec4<f32>,
    inner: vec4<f32>,
    border: vec4<f32>,
    crop_off: vec4<f32>,
};

@group(0) @binding(0) var hcb_src: texture_2d<f32>;
@group(0) @binding(1) var<uniform> hcb_u: HaloClipBorderU;

@fragment
fn fs_halo_clip_border(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
    let p = floor(pos.xy) + hcb_u.crop_off.xy;
    let cx = clamp(min(p.x + 1.0, hcb_u.clip.z) - max(p.x, hcb_u.clip.x), 0.0, 1.0);
    let cy = clamp(min(p.y + 1.0, hcb_u.clip.w) - max(p.y, hcb_u.clip.y), 0.0, 1.0);
    let cov = cx * cy;
    if (cov <= 0.0) {
        return hcb_u.border;
    }
    if (cov >= 1.0) {
        return textureLoad(hcb_src, vec2<i32>(p), 0);
    }
    let ix = i32(clamp(p.x, hcb_u.inner.x, hcb_u.inner.z));
    let iy = i32(clamp(p.y, hcb_u.inner.y, hcb_u.inner.w));
    return mix(hcb_u.border, textureLoad(hcb_src, vec2<i32>(ix, iy), 0), cov);
}

struct HaloClipClampU {
    crop: vec4<f32>,
    edges: vec4<f32>,
    left_a: vec4<f32>,
    left_b: vec4<f32>,
    right_a: vec4<f32>,
    right_b: vec4<f32>,
    top_a: vec4<f32>,
    top_b: vec4<f32>,
    bot_a: vec4<f32>,
    bot_b: vec4<f32>,
};

@group(0) @binding(0) var hcc_src: texture_2d<f32>;
@group(0) @binding(1) var hcc_left: texture_2d<f32>;
@group(0) @binding(2) var hcc_right: texture_2d<f32>;
@group(0) @binding(3) var hcc_top: texture_2d<f32>;
@group(0) @binding(4) var hcc_bot: texture_2d<f32>;
@group(0) @binding(5) var<uniform> hcc_u: HaloClipClampU;

fn sample_strip(
    strip: texture_2d<f32>,
    coord: i32,
    is_straddling: bool,
    clamp_idx: i32,
    vertical: bool,
    info_a: vec4<f32>,
    info_b: vec4<f32>,
) -> vec4<f32> {
    let k = info_a.x;
    let short_n = clamp(i32(round(select(info_a.z, info_a.y, vertical))), 1, 256);
    let long_max = max(i32(round(select(info_a.y, info_a.z, vertical))) - 1, 0);
    let spt = clamp(i32(round(info_a.w)), 1, 256);
    let base = f32(coord) * f32(spt) + info_b.x + 0.001;
    var sum = vec4<f32>(0.0);
    for (var i = 0; i < spt; i = i + 1) {
        let l = clamp(i32(floor(base + f32(i))), 0, long_max);
        let uv_c = select(vec2<i32>(l, clamp_idx), vec2<i32>(clamp_idx, l), vertical);
        if (!is_straddling) {
            sum = sum + textureLoad(strip, uv_c, 0);
        } else {
            if (k > 0.0) {
                sum = sum + textureLoad(strip, uv_c, 0) * k;
            }
            for (var s = 0; s < short_n; s = s + 1) {
                let uv_s = select(vec2<i32>(l, s), vec2<i32>(s, l), vertical);
                sum = sum + textureLoad(strip, uv_s, 0);
            }
        }
    }
    let denom = select(f32(spt), max((k + f32(short_n)) * f32(spt), 1.0), is_straddling);
    return sum / denom;
}

@fragment
fn fs_halo_clip_clamp(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
    let p = vec2<i32>(floor(pos.xy)) + vec2<i32>(floor(hcc_u.crop.xy));
    let tx_l = i32(round(hcc_u.edges.x));
    let ty_t = i32(round(hcc_u.edges.y));
    let tx_r = i32(round(hcc_u.edges.z));
    let ty_b = i32(round(hcc_u.edges.w));
    if (p.x <= tx_l) {
        return sample_strip(hcc_left, p.y, p.x == tx_l, 0, true, hcc_u.left_a, hcc_u.left_b);
    }
    if (p.x >= tx_r) {
        let w_r = clamp(i32(round(hcc_u.right_a.y)), 1, 256);
        return sample_strip(hcc_right, p.y, p.x == tx_r, w_r - 1, true, hcc_u.right_a, hcc_u.right_b);
    }
    if (p.y <= ty_t) {
        return sample_strip(hcc_top, p.x, p.y == ty_t, 0, false, hcc_u.top_a, hcc_u.top_b);
    }
    if (p.y >= ty_b) {
        let h_b = clamp(i32(round(hcc_u.bot_a.z)), 1, 256);
        return sample_strip(hcc_bot, p.x, p.y == ty_b, h_b - 1, false, hcc_u.bot_a, hcc_u.bot_b);
    }
    return textureLoad(hcc_src, clamp(p, vec2<i32>(0), vec2<i32>(floor(hcc_u.crop.zw))), 0);
}

struct DownsampleRectU {
    map: vec4<f32>,
    size: vec4<f32>,
};

@group(0) @binding(0) var dr_src: texture_2d<f32>;
@group(0) @binding(1) var<uniform> dr_u: DownsampleRectU;

@fragment
fn fs_downsample_rect(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
    let p = floor(pos.xy);
    let ratio = max(i32(round(dr_u.size.z)), 1);
    let max_c = max(vec2<i32>(floor(dr_u.size.xy)) - 1, vec2<i32>(0));
    let base = vec2<i32>(floor(p * dr_u.map.zw + dr_u.map.xy + 0.001));
    let step = max((ratio + 7) / 8, 1);
    let taps = min(ratio, 8);
    var sum = vec4<f32>(0.0);
    var count = 0.0;
    for (var dy = 0; dy < taps; dy = dy + 1) {
        let oy = dy * step;
        if (oy >= ratio) { break; }
        for (var dx = 0; dx < taps; dx = dx + 1) {
            let ox = dx * step;
            if (ox >= ratio) { break; }
            sum = sum + textureLoad(dr_src, clamp(base + vec2<i32>(ox, oy), vec2<i32>(0), max_c), 0);
            count = count + 1.0;
        }
    }
    return sum / max(count, 1.0);
}

@fragment
fn fs_progressive_blur(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
    let local = vec2<i32>(floor(pos.xy - pbu.tile.xy));
    let dst = textureLoad(pb_dst, local, 0);
    let mask_coord = local + vec2<i32>(i32(pbu.mask_info.x), i32(pbu.mask_info.y));
    let m = textureLoad(pb_mask, mask_coord, 0).a;
    var clip_cov = 1.0;
    if (pbu.mask_info.w > 0.5) {
        clip_cov = textureLoad(pb_clip, mask_coord, 0).a;
    }
    let a_eff = clamp(m * clip_cov * pbu.mask_info.z, 0.0, 1.0);
    if (a_eff <= 0.0) {
        return dst;
    }
    let t = clamp(dot(pos.xy + pbu.frame_origin.xy - pbu.grad.xy, pbu.grad.zw), 0.0, 1.0);
    let sigma = pbu.params.x + (pbu.params.y - pbu.params.x) * t;
    let count = i32(pbu.params.z);
    var lo = 0;
    var hi = 0;
    var frac = 0.0;
    if (count > 1) {
        lo = count - 2;
        hi = count - 1;
        for (var i = 0; i < 11; i = i + 1) {
            if (i + 1 >= count) { break; }
            if (sigma <= prog_stop(i + 1)) {
                lo = i;
                hi = i + 1;
                break;
            }
        }
        let s_lo = prog_stop(lo);
        let s_hi = prog_stop(hi);
        let v_lo = s_lo * s_lo;
        let v_hi = s_hi * s_hi;
        frac = clamp((sigma * sigma - v_lo) / max(v_hi - v_lo, 1e-6), 0.0, 1.0);
    }
    let c0 = sample_progressive_stop(lo, local, pos.xy);
    let c1 = sample_progressive_stop(hi, local, pos.xy);
    let blurred = mix(c0, c1, frac);
    return dst * (1.0 - a_eff) + blurred * a_eff;
}
