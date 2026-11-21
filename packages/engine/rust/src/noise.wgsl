// Noise grain post-effect (decisions 0008, 0013, 0040):
// Pure full-screen triangle fragment pass (WebGL2 / GLSL ES 3.00 compatible).
// Samples a periodic 320 x 320 premultiplied RGBA8 grain tile anchored in layer coordinates and
// composites over the layer's picture with Porter-Duff `source-atop`.

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

struct NoiseParams {
    // Affine mapping global device pixel coordinates to normalized [0, 1] tile UVs:
    // uv.x = row0.x * dev_x + row0.y * dev_y + row0.z
    // uv.y = row1.x * dev_x + row1.y * dev_y + row1.z
    row0: vec4f,
    row1: vec4f,
    // (dst_origin.x, dst_origin.y, src_origin.x, src_origin.y)
    origins: vec4i,
    // (src_w, src_h, 0, 0)
    src_size: vec4i,
};

@group(0) @binding(0) var src_tex: texture_2d<f32>;
@group(0) @binding(1) var tile_tex: texture_2d<f32>;
@group(0) @binding(2) var tile_sampler: sampler;
@group(0) @binding(3) var<uniform> params: NoiseParams;

@fragment
fn fs_noise(in: VsOut) -> @location(0) vec4f {
    let dev_pos = in.pos.xy + vec2f(f32(params.origins.x), f32(params.origins.y));
    let uv = vec2f(
        params.row0.x * dev_pos.x + params.row0.y * dev_pos.y + params.row0.z,
        params.row1.x * dev_pos.x + params.row1.y * dev_pos.y + params.row1.z,
    );
    // Sample unconditionally in uniform control flow.
    let grain = textureSample(tile_tex, tile_sampler, uv);
    let sp = vec2i(in.pos.xy) + (params.origins.xy - params.origins.zw);
    if (sp.x < 0 || sp.y < 0 || sp.x >= params.src_size.x || sp.y >= params.src_size.y) {
        return vec4f(0.0);
    }
    let dst = textureLoad(src_tex, sp, 0);
    // Porter-Duff source-atop on premultiplied RGBA:
    // out.rgb = grain.rgb * dst.a + dst.rgb * (1 - grain.a); out.a = dst.a.
    let rgb = grain.rgb * dst.a + dst.rgb * (1.0 - grain.a);
    return clamp(vec4f(rgb, dst.a), vec4f(0.0), vec4f(1.0));
}
