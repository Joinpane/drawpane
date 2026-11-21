// All 17 non-normal blend modes (decision 0038 & W3C Compositing and Blending Level 1):
// 11 separable modes (1..11), 4 non-separable HSL modes (12..15), and Figma's linear-dodge (16)
// and linear-burn (17). Pure full-screen triangle fragment passes (WebGL2 / GLSL ES 3.00 compatible).

struct VsOut {
    @builtin(position) pos: vec4f,
};

@vertex
fn vs_quad(@builtin(vertex_index) i: u32) -> VsOut {
    var corners = array<vec2f, 3>(
        vec2f(-1.0, -1.0),
        vec2f(3.0, -1.0),
        vec2f(-1.0, 3.0),
    );
    var out: VsOut;
    out.pos = vec4f(corners[i], 0.0, 1.0);
    return out;
}

struct BlendParams {
    dst_origin_x: i32,
    dst_origin_y: i32,
    mode: u32,
    opacity: f32,
    mask_kind: u32,
    _pad0: u32,
    _pad1: u32,
    _pad2: u32,
};

@group(0) @binding(0) var src_tex: texture_2d<f32>;
@group(0) @binding(1) var backdrop_tex: texture_2d<f32>;
@group(0) @binding(2) var clip_tex: texture_2d<f32>;
@group(0) @binding(3) var<uniform> params: BlendParams;
@group(0) @binding(4) var mask_tex: texture_2d<f32>;

fn separable_ch(mode: u32, cb: f32, cs: f32) -> f32 {
    switch mode {
        // 1: multiply
        case 1u: { return cb * cs; }
        // 2: screen
        case 2u: { return cb + cs - cb * cs; }
        // 3: overlay (hard-light with cb and cs swapped)
        case 3u: {
            if (cb <= 0.5) { return 2.0 * cb * cs; }
            let s = 2.0 * cb - 1.0;
            return cs + s - cs * s;
        }
        // 4: darken
        case 4u: { return min(cb, cs); }
        // 5: lighten
        case 5u: { return max(cb, cs); }
        // 6: color-dodge
        case 6u: {
            if (cb <= 0.0) { return 0.0; }
            if (cs >= 1.0) { return 1.0; }
            return min(1.0, cb / (1.0 - cs));
        }
        // 7: color-burn
        case 7u: {
            if (cb >= 1.0) { return 1.0; }
            if (cs <= 0.0) { return 0.0; }
            return 1.0 - min(1.0, (1.0 - cb) / cs);
        }
        // 8: hard-light
        case 8u: {
            if (cs <= 0.5) { return 2.0 * cb * cs; }
            let s = 2.0 * cs - 1.0;
            return cb + s - cb * s;
        }
        // 9: soft-light (W3C exact)
        case 9u: {
            if (cs <= 0.5) {
                return cb - (1.0 - 2.0 * cs) * cb * (1.0 - cb);
            }
            var d = sqrt(max(cb, 0.0));
            if (cb <= 0.25) {
                d = ((16.0 * cb - 12.0) * cb + 4.0) * cb;
            }
            return cb + (2.0 * cs - 1.0) * (d - cb);
        }
        // 10: difference
        case 10u: { return abs(cb - cs); }
        // 11: exclusion
        case 11u: { return cb + cs - 2.0 * cb * cs; }
        default: { return cs; }
    }
}

fn lum(c: vec3f) -> f32 {
    return 0.3 * c.r + 0.59 * c.g + 0.11 * c.b;
}

fn clip_color(c_in: vec3f) -> vec3f {
    var c = c_in;
    let l = lum(c);
    let n = min(c.r, min(c.g, c.b));
    let x = max(c.r, max(c.g, c.b));
    if (n < 0.0) {
        let d = l - n;
        if (d > 1e-6) {
            c = vec3f(l) + ((c - vec3f(l)) * l) / d;
        } else {
            c = vec3f(l);
        }
    }
    if (x > 1.0) {
        let d = x - l;
        if (d > 1e-6) {
            c = vec3f(l) + ((c - vec3f(l)) * (1.0 - l)) / d;
        } else {
            c = vec3f(l);
        }
    }
    return clamp(c, vec3f(0.0), vec3f(1.0));
}

fn set_lum(c: vec3f, l: f32) -> vec3f {
    let d = l - lum(c);
    return clip_color(c + vec3f(d));
}

fn sat(c: vec3f) -> f32 {
    return max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b));
}

fn set_sat(c: vec3f, s: f32) -> vec3f {
    let c_min = min(c.r, min(c.g, c.b));
    let c_max = max(c.r, max(c.g, c.b));
    let span = c_max - c_min;
    if (span > 1e-6) {
        return (c - vec3f(c_min)) * (s / span);
    }
    return vec3f(0.0);
}

fn non_separable(mode: u32, cb: vec3f, cs: vec3f) -> vec3f {
    switch mode {
        // 12: hue
        case 12u: { return set_lum(set_sat(cs, sat(cb)), lum(cb)); }
        // 13: saturation
        case 13u: { return set_lum(set_sat(cb, sat(cs)), lum(cb)); }
        // 14: color
        case 14u: { return set_lum(cs, lum(cb)); }
        // 15: luminosity
        case 15u: { return set_lum(cb, lum(cs)); }
        default: { return cs; }
    }
}

fn blend_pixel(mode: u32, s: vec4f, b: vec4f) -> vec4f {
    let sa = s.a;
    if (sa <= 0.0) {
        return b;
    }
    let ba = b.a;
    if (ba <= 0.0) {
        return clamp(s, vec4f(0.0), vec4f(1.0));
    }
    let a = sa + ba - sa * ba;
    if (mode == 16u) {
        // Figma linear-dodge (Plus lighter, decision 0038): c = min(a, cs + cb)
        let rgb = min(vec3f(a), s.rgb + b.rgb);
        return clamp(vec4f(rgb, a), vec4f(0.0), vec4f(1.0));
    }
    if (mode == 0u) {
        let rgb = s.rgb + b.rgb * (1.0 - sa);
        return clamp(vec4f(rgb, a), vec4f(0.0), vec4f(1.0));
    }
    let cs = clamp(s.rgb / sa, vec3f(0.0), vec3f(1.0));
    let cb = clamp(b.rgb / ba, vec3f(0.0), vec3f(1.0));
    var blended: vec3f;
    if (mode <= 11u) {
        blended = vec3f(
            separable_ch(mode, cb.r, cs.r),
            separable_ch(mode, cb.g, cs.g),
            separable_ch(mode, cb.b, cs.b),
        );
    } else {
        blended = non_separable(mode, cb, cs);
    }
    let rgb = s.rgb * (1.0 - ba) + b.rgb * (1.0 - sa) + sa * ba * blended;
    return clamp(vec4f(rgb, a), vec4f(0.0), vec4f(1.0));
}

fn picture_coverage(p: vec2i) -> f32 {
    if (params.mask_kind == 0u) {
        return 1.0;
    }
    let mask = textureLoad(mask_tex, p, 0);
    if (params.mask_kind == 3u) {
        return select(0.0, 1.0, mask.a > 0.0);
    }
    if (params.mask_kind == 5u) {
        return clamp(dot(mask.rgb, vec3f(0.2126, 0.7152, 0.0722)), 0.0, 1.0);
    }
    return mask.a;
}

fn composite(s_raw: vec4f, b: vec4f, opacity: f32) -> vec4f {
    if (params.mode == 18u) {
        return clamp(b + (s_raw - b) * opacity, vec4f(0.0), vec4f(1.0));
    }
    if (params.mode == 17u) {
        // Undo UNORM normalization before computing the byte-domain result.
        // Quantize explicitly so Vulkan and OpenGL agree with the CPU on exact ties.
        let s8 = round(s_raw * 255.0);
        let b8 = round(b * 255.0);
        // A GPU may lower division to a reciprocal, nudging an exact half below
        // its rounding boundary. The product with an opaque alpha is exact.
        let sub = select(s8.a * b8.a / 255.0, min(s8.a, b8.a), max(s8.a, b8.a) == 255.0);
        let scaled = b8 + (s8 - vec4f(sub)) * opacity;
        return floor(clamp(scaled, vec4f(0.0), vec4f(255.0)) + 0.5) / 255.0;
    }
    return blend_pixel(params.mode, s_raw * opacity, b);
}

@fragment
fn fs_blend(in: VsOut) -> @location(0) vec4f {
    let p = vec2i(in.pos.xy) - vec2i(params.dst_origin_x, params.dst_origin_y);
    let s_raw = textureLoad(src_tex, p, 0);
    let b = textureLoad(backdrop_tex, p, 0);
    return composite(s_raw, b, params.opacity * picture_coverage(p));
}

@fragment
fn fs_blend_clipped(in: VsOut) -> @location(0) vec4f {
    let p = vec2i(in.pos.xy) - vec2i(params.dst_origin_x, params.dst_origin_y);
    let clip_a = textureLoad(clip_tex, p, 0).a;
    let s_raw = textureLoad(src_tex, p, 0);
    let b = textureLoad(backdrop_tex, p, 0);
    return composite(s_raw, b, params.opacity * clip_a * picture_coverage(p));
}
