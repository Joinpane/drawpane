// Drawpane: the engine's blend arithmetic (packages/engine/rust/src/blend.wgsl, generated from
// it: keep the two the same), so a blend layer Vello composes in the scene matches the engine's
// offscreen blend kernel: modes 1..15 (W3C), 16 Figma linear-dodge, 17 Figma linear-burn in the
// byte domain. Opacity scales the source, as the kernel does.

fn dp_separable_ch(mode: u32, cb: f32, cs: f32) -> f32 {
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

fn dp_lum(c: vec3f) -> f32 {
    return 0.3 * c.r + 0.59 * c.g + 0.11 * c.b;
}

fn dp_clip_color(c_in: vec3f) -> vec3f {
    var c = c_in;
    let l = dp_lum(c);
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

fn dp_set_lum(c: vec3f, l: f32) -> vec3f {
    let d = l - dp_lum(c);
    return dp_clip_color(c + vec3f(d));
}

fn dp_sat(c: vec3f) -> f32 {
    return max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b));
}

fn dp_set_sat(c: vec3f, s: f32) -> vec3f {
    let c_min = min(c.r, min(c.g, c.b));
    let c_max = max(c.r, max(c.g, c.b));
    let span = c_max - c_min;
    if (span > 1e-6) {
        return (c - vec3f(c_min)) * (s / span);
    }
    return vec3f(0.0);
}

fn dp_non_separable(mode: u32, cb: vec3f, cs: vec3f) -> vec3f {
    switch mode {
        // 12: hue
        case 12u: { return dp_set_lum(dp_set_sat(cs, dp_sat(cb)), dp_lum(cb)); }
        // 13: saturation
        case 13u: { return dp_set_lum(dp_set_sat(cb, dp_sat(cs)), dp_lum(cb)); }
        // 14: color
        case 14u: { return dp_set_lum(cs, dp_lum(cb)); }
        // 15: luminosity
        case 15u: { return dp_set_lum(cb, dp_lum(cs)); }
        default: { return cs; }
    }
}

fn dp_blend_pixel(mode: u32, s: vec4f, b: vec4f) -> vec4f {
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
            dp_separable_ch(mode, cb.r, cs.r),
            dp_separable_ch(mode, cb.g, cs.g),
            dp_separable_ch(mode, cb.b, cs.b),
        );
    } else {
        blended = dp_non_separable(mode, cb, cs);
    }
    let rgb = s.rgb * (1.0 - ba) + b.rgb * (1.0 - sa) + sa * ba * blended;
    return clamp(vec4f(rgb, a), vec4f(0.0), vec4f(1.0));
}

fn dp_composite(mode: u32, s_raw: vec4f, b: vec4f, opacity: f32) -> vec4f {
    if (mode == 17u) {
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
    return dp_blend_pixel(mode, s_raw * opacity, b);
}
