// Texture displacement post-effect (decisions 0008, 0013, 0040):
// Direct port of `packages/editor/src/texture.ts` (pcg2d hash, 3-octave fractal Perlin in layer
// coordinates, nearest-neighbor sample displacement up to `radius`, optional `clip_to_shape`).
// Pure full-screen triangle fragment pass (WebGL2 / GLSL ES 3.00 compatible).

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

struct TextureParams {
    // Affine mapping global device pixel coordinates to layer units:
    // local.x = row0.x * dev_x + row0.y * dev_y + row0.z
    // local.y = row1.x * dev_x + row1.y * dev_y + row1.z
    row0: vec4f,
    row1: vec4f,
    // (dst_origin.x, dst_origin.y, src_origin.x, src_origin.y)
    origins: vec4i,
    // (src_w, src_h, 0, 0)
    src_size: vec4i,
    // (cell, radius_dev, clip_flag (0 or 1), 0)
    effect: vec4f,
};

@group(0) @binding(0) var src_tex: texture_2d<f32>;
@group(0) @binding(1) var<uniform> params: TextureParams;

// pcg2d (Jarzynski and Olano, 2020), matching `packages/editor/src/texture.ts`.
fn hash2(v_in: vec2u) -> vec2u {
    var v = v_in * 1664525u + 1013904223u;
    v.x = v.x + v.y * 1664525u;
    v.y = v.y + v.x * 1664525u;
    v = v ^ (v >> vec2u(16u));
    v.x = v.x + v.y * 1664525u;
    v.y = v.y + v.x * 1664525u;
    v = v ^ (v >> vec2u(16u));
    return v;
}

fn gradient_at(c: vec2i) -> vec2f {
    let h = hash2(vec2u(bitcast<u32>(c.x), bitcast<u32>(c.y)));
    let r = f32(h.x) / 4294967295.0;
    let turn = r * 6.2831853;
    return vec2f(cos(turn), sin(turn));
}

fn perlin(p: vec2f) -> f32 {
    let i = floor(p);
    let f = p - i;
    let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    let c = vec2i(i);
    let a = dot(gradient_at(c), f);
    let b = dot(gradient_at(c + vec2i(1, 0)), f - vec2f(1.0, 0.0));
    let d = dot(gradient_at(c + vec2i(0, 1)), f - vec2f(0.0, 1.0));
    let e = dot(gradient_at(c + vec2i(1, 1)), f - vec2f(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(d, e, u.x), u.y);
}

fn fractal(p: vec2f) -> f32 {
    return perlin(p) + 0.5 * perlin(p * 2.0) + 0.25 * perlin(p * 4.0);
}

fn load_src(p: vec2i) -> vec4f {
    if (p.x < 0 || p.y < 0 || p.x >= params.src_size.x || p.y >= params.src_size.y) {
        return vec4f(0.0);
    }
    return textureLoad(src_tex, p, 0);
}

@fragment
fn fs_texture(in: VsOut) -> @location(0) vec4f {
    let dev_pos = in.pos.xy + vec2f(f32(params.origins.x), f32(params.origins.y));
    let orig_sp = vec2i(in.pos.xy) + (params.origins.xy - params.origins.zw);
    let local = vec2f(
        params.row0.x * dev_pos.x + params.row0.y * dev_pos.y + params.row0.z,
        params.row1.x * dev_pos.x + params.row1.y * dev_pos.y + params.row1.z,
    );
    let cell = params.effect.x;
    let radius = params.effect.y;
    let clip = params.effect.z > 0.5;
    if (cell <= 0.0 || radius <= 0.0) {
        return load_src(orig_sp);
    }
    let q = local / cell;
    var offset = vec2f(fractal(q), fractal(q + vec2f(37.2, 91.7))) / 0.9;
    let len = length(offset);
    if (len > 1.0) {
        offset = offset / len;
    }
    let sample_dev = vec2i(floor(dev_pos + offset * radius));
    var color = load_src(sample_dev - params.origins.zw);
    if (clip) {
        let orig = load_src(orig_sp);
        color = color * orig.a;
    }
    return clamp(color, vec4f(0.0), vec4f(1.0));
}
