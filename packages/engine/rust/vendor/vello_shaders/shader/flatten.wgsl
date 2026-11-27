// Copyright 2022 the Vello Authors
// SPDX-License-Identifier: Apache-2.0 OR MIT OR Unlicense
//
// Drawpane: replaced Vello 0.12's Euler-spiral flattener and GPU stroke expander with a direct
// WGSL port of vello_common 0.4's `flatten_simd` (Wang/parabola-integral flattener at the vendored
// vello_common's 1/16 px tolerance) plus conservative-bbox viewport culling. All strokes arrive pre-expanded as cached filled outlines
// (`src/stroke.rs`), so CPU (`vello_cpu`), `vello_gpu`, and GPU compute flatten identical curves
// with the same algorithm.

#import config
#import drawtag
#import pathtag
#import segment
#import bump

@group(0) @binding(0)
var<uniform> config: Config;

@group(0) @binding(1)
var<storage> scene: array<u32>;

@group(0) @binding(2)
var<storage> tag_monoids: array<TagMonoid>;

struct AtomicPathBbox {
    x0: atomic<i32>,
    y0: atomic<i32>,
    x1: atomic<i32>,
    y1: atomic<i32>,
    draw_flags: u32,
    trans_ix: u32,
}

@group(0) @binding(3)
var<storage, read_write> path_bboxes: array<AtomicPathBbox>;

@group(0) @binding(4)
var<storage, read_write> bump: BumpAllocators;

@group(0) @binding(5)
var<storage, read_write> lines: array<LineSoup>;

// vello_common 0.4 flattening constants (flatten.rs / flatten_simd.rs), with Drawpane's 1/16 px
// tolerance (vendor/vello_common/VENDORED.md).
const TOL: f32 = 0.0625;
const SQRT_TOL: f32 = 0.25;
const TOL_2: f32 = 0.00390625;
const TO_QUAD_TOL: f32 = 0.1;
const CUBIC_TOL: f32 = 0.05625;
const CUBIC_SQRT_TOL: f32 = 0.23717082; // sqrt(0.05625)
const MAX_QUADS: u32 = 16u;
const MAX_QUAD_LINES: u32 = 4096u;
const MAX_HYPOT2: f32 = 0.016875; // 432.0 * (0.0625 * 0.1)^2
const BBOX_CLAMP: f32 = 1.0e8;

const D_CONST: f32 = 0.67;
const D_POWI_4: f32 = 0.2015112;
const B_CONST: f32 = 0.39;

fn is_finite_f32(x: f32) -> bool {
    return (bitcast<u32>(abs(x)) & 0x7fffffffu) < 0x7f800000u;
}

fn is_finite_vec2(p: vec2f) -> bool {
    return is_finite_f32(p.x) && is_finite_f32(p.y);
}

// Matches vello_common::flatten_simd::approx_parabola_integral_simd.
fn approx_parabola_integral(x: f32) -> f32 {
    let temp = sqrt(sqrt(fma(0.25, x * x, D_POWI_4)));
    return x / (temp + (1.0 - D_CONST));
}

// Matches vello_common::flatten_simd::approx_parabola_inv_integral_simd.
fn approx_parabola_inv_integral(x: f32) -> f32 {
    let temp = sqrt(fma(0.25, x * x, B_CONST * B_CONST));
    return x * ((1.0 - B_CONST) + temp);
}

// Exact port of kurbo::Line::nearest(p, 0.0).distance_sq.
fn line_nearest_dist_sq(p0: vec2f, p1: vec2f, p: vec2f) -> f32 {
    let d = p1 - p0;
    let dotp = dot(p - p0, d);
    let d_squared = dot(d, d);
    if dotp <= 0.0 {
        let diff = p - p0;
        return dot(diff, diff);
    } else if dotp >= d_squared {
        let diff = p - p1;
        return dot(diff, diff);
    } else {
        let t = dotp / d_squared;
        let diff = p - (p0 + d * t);
        return dot(diff, diff);
    }
}

// Matches vello_common::flatten_simd::estimate_num_quads (with p0 shifted to origin).
fn estimate_num_quads(c1: vec2f, c2: vec2f, c3: vec2f) -> u32 {
    let p1x2 = c1 * 3.0;
    let p2x2 = c2 * 3.0 - c3;
    let diff = p2x2 - p1x2;
    let err_div = dot(diff, diff) / MAX_HYPOT2;
    var lut = array<f32, 16>(
        1.0, 64.0, 729.0, 4096.0,
        15625.0, 46656.0, 117649.0, 262144.0,
        531441.0, 1000000.0, 1771561.0, 2985984.0,
        4826809.0, 7529536.0, 11390625.0, 16777216.0,
    );
    for (var i = 0u; i < MAX_QUADS; i += 1u) {
        if err_div <= lut[i] {
            return i + 1u;
        }
    }
    return MAX_QUADS;
}

fn read_f32_point(ix: u32) -> vec2f {
    let x = bitcast<f32>(scene[pathdata_base + ix]);
    let y = bitcast<f32>(scene[pathdata_base + ix + 1u]);
    return vec2(x, y);
}

fn read_i16_point(ix: u32) -> vec2f {
    let raw = scene[pathdata_base + ix];
    let x = f32(i32(raw << 16u) >> 16u);
    let y = f32(i32(raw) >> 16u);
    return vec2(x, y);
}

struct Transform {
    mat: vec4f,
    translate: vec2f,
}

fn read_transform(transform_base: u32, ix: u32) -> Transform {
    let base = transform_base + ix * 6u;
    let c0 = bitcast<f32>(scene[base]);
    let c1 = bitcast<f32>(scene[base + 1u]);
    let c2 = bitcast<f32>(scene[base + 2u]);
    let c3 = bitcast<f32>(scene[base + 3u]);
    let c4 = bitcast<f32>(scene[base + 4u]);
    let c5 = bitcast<f32>(scene[base + 5u]);
    return Transform(vec4(c0, c1, c2, c3), vec2(c4, c5));
}

fn transform_apply(transform: Transform, p: vec2f) -> vec2f {
    let px = fma(transform.mat.x, p.x, fma(transform.mat.z, p.y, transform.translate.x));
    let py = fma(transform.mat.y, p.x, fma(transform.mat.w, p.y, transform.translate.y));
    return vec2(px, py);
}

fn round_down(x: f32) -> i32 {
    return i32(floor(clamp(x, -BBOX_CLAMP, BBOX_CLAMP)));
}

fn round_up(x: f32) -> i32 {
    return i32(ceil(clamp(x, -BBOX_CLAMP, BBOX_CLAMP)));
}

struct PathTagData {
    tag_byte: u32,
    monoid: TagMonoid,
}

fn compute_tag_monoid(ix: u32) -> PathTagData {
    let tag_word = scene[config.pathtag_base + (ix >> 2u)];
    let shift = (ix & 3u) * 8u;
    var tm = reduce_tag(tag_word & ((1u << shift) - 1u));
    tm = combine_tag_monoid(tag_monoids[ix >> 2u], tm);
    let tag_byte = (tag_word >> shift) & 0xffu;
    tm.trans_ix -= 1u;
    tm.style_ix -= STYLE_SIZE_IN_WORDS;
    return PathTagData(tag_byte, tm);
}

// `pathdata_base` and `bbox` are per-invocation private state.
var<private> pathdata_base: u32;
var<private> bbox: vec4f;

fn include_point(p: vec2f) {
    bbox = vec4(min(bbox.xy, p), max(bbox.zw, p));
}

fn write_line(line_ix: u32, path_ix: u32, p0: vec2f, p1: vec2f) {
    bbox = vec4(min(bbox.xy, min(p0, p1)), max(bbox.zw, max(p0, p1)));
    if line_ix < config.lines_size {
        lines[line_ix] = LineSoup(path_ix, p0, p1);
    } else {
        atomicOr(&bump.failed, STAGE_FLATTEN);
    }
}

fn output_line(path_ix: u32, p0: vec2f, p1: vec2f) {
    let line_ix = atomicAdd(&bump.lines, 1u);
    write_line(line_ix, path_ix, p0, p1);
}

fn flatten_line(path_ix: u32, p0: vec2f, p1: vec2f, view_right: f32, view_bottom: f32) {
    if !is_finite_vec2(p0) || !is_finite_vec2(p1) || all(p0 == p1) {
        return;
    }
    // Always preserve conservative path bbox for viewport-enclosing shapes.
    include_point(p0);
    include_point(p1);
    let min_x = min(p0.x, p1.x);
    let min_y = min(p0.y, p1.y);
    let max_y = max(p0.y, p1.y);
    if min_x > view_right || max_y < -1.0 || min_y > view_bottom {
        return;
    }
    output_line(path_ix, p0, p1);
}

fn flatten_quad(path_ix: u32, p0: vec2f, p1: vec2f, p2: vec2f, view_right: f32, view_bottom: f32) {
    if !is_finite_vec2(p0) || !is_finite_vec2(p1) || !is_finite_vec2(p2) {
        return;
    }
    if all(p0 == p1) && all(p0 == p2) {
        return;
    }
    let min_pt = min(p0, min(p1, p2));
    let max_pt = max(p0, max(p1, p2));
    if min_pt.x > view_right || max_pt.y < -1.0 || min_pt.y > view_bottom {
        include_point(min_pt);
        include_point(max_pt);
        return;
    }
    // Left-of-viewport shortcut (exact backdrop winding) or flatness shortcut (`4 * TOL^2`).
    if max_pt.x < -1.0 || line_nearest_dist_sq(p0, p2, p1) <= 4.0 * TOL_2 {
        output_line(path_ix, p0, p2);
        return;
    }

    // Direct port of vello_common::flatten_simd::QuadBez::estimate_subdiv + loop.
    let d01 = p1 - p0;
    let d12 = p2 - p1;
    let dd = d01 - d12;
    let cross = (p2.x - p0.x) * dd.y - (p2.y - p0.y) * dd.x;
    let inv_cross = 1.0 / cross;
    let x0 = dot(d01, dd) * inv_cross;
    let x2 = dot(d12, dd) * inv_cross;
    let scale = abs(cross / (length(dd) * (x2 - x0)));

    let a0 = approx_parabola_integral(x0);
    let a2 = approx_parabola_integral(x2);
    var val = 0.0;
    if is_finite_f32(scale) {
        let da = abs(a2 - a0);
        let sqrt_scale = sqrt(scale);
        if ((bitcast<u32>(x0) ^ bitcast<u32>(x2)) & 0x80000000u) == 0u {
            val = da * sqrt_scale;
        } else {
            let xmin = SQRT_TOL / sqrt_scale;
            val = (SQRT_TOL * da) / approx_parabola_integral(xmin);
        }
    }
    let u0 = approx_parabola_inv_integral(a0);
    let u2 = approx_parabola_inv_integral(a2);
    let uscale = 1.0 / (u2 - u0);

    var n = 1u;
    if is_finite_f32(val) && val > 0.0 {
        n = clamp(u32(ceil((0.5 / SQRT_TOL) * val)), 1u, MAX_QUAD_LINES);
    }
    if n == 1u || !is_finite_f32(uscale) {
        output_line(path_ix, p0, p2);
        return;
    }

    let line_ix = atomicAdd(&bump.lines, n);
    let step = 1.0 / f32(n);
    let c1 = p1 - p0;
    let c2 = p2 - p0;
    let coeff_a = fma(c1, vec2f(-2.0), c2);
    let coeff_b = c1 * 2.0;
    var prev = p0;
    for (var i = 1u; i < n; i += 1u) {
        let frac = f32(i) * step;
        let a = fma(a2 - a0, frac, a0);
        let u = approx_parabola_inv_integral(a);
        let t = (u - u0) * uscale;
        let pt = p0 + fma(fma(coeff_a, vec2f(t), coeff_b), vec2f(t), vec2f(0.0));
        let safe_pt = select(prev, pt, is_finite_vec2(pt));
        write_line(line_ix + (i - 1u), path_ix, prev, safe_pt);
        prev = safe_pt;
    }
    write_line(line_ix + (n - 1u), path_ix, prev, p2);
}

fn flatten_cubic(path_ix: u32, p0: vec2f, p1: vec2f, p2: vec2f, p3: vec2f, view_right: f32, view_bottom: f32) {
    if !is_finite_vec2(p0) || !is_finite_vec2(p1) || !is_finite_vec2(p2) || !is_finite_vec2(p3) {
        return;
    }
    if all(p0 == p1) && all(p0 == p2) && all(p0 == p3) {
        return;
    }
    let min_pt = min(min(p0, p1), min(p2, p3));
    let max_pt = max(max(p0, p1), max(p2, p3));
    if min_pt.x > view_right || max_pt.y < -1.0 || min_pt.y > view_bottom {
        include_point(min_pt);
        include_point(max_pt);
        return;
    }
    // Left-of-viewport shortcut (exact backdrop winding) or flatness shortcut (`16/9 * TOL^2`).
    if max_pt.x < -1.0
        || max(line_nearest_dist_sq(p0, p3, p1), line_nearest_dist_sq(p0, p3, p2)) <= (16.0 / 9.0) * TOL_2
    {
        output_line(path_ix, p0, p3);
        return;
    }

    // Shift relative to p0 so flattening is translation-invariant in f32 (matches flatten_simd.rs:225).
    let origin = p0;
    let c1 = p1 - origin;
    let c2 = p2 - origin;
    let c3 = p3 - origin;

    let n_quads = estimate_num_quads(c1, c2, c3);
    let dt = 0.5 / f32(n_quads);

    // Horner cubic coefficients with c0 == (0, 0).
    let ca = fma(c1 - c2, vec2f(3.0), c3);
    let cb = fma(c1, vec2f(-2.0), c2) * 3.0;
    let cc = c1 * 3.0;

    var even_pts: array<vec2f, 17>;
    var odd_pts: array<vec2f, 16>;
    even_pts[0] = vec2f(0.0, 0.0);
    for (var k = 0u; k < n_quads; k += 1u) {
        if k > 0u {
            let te = f32(2u * k) * dt;
            even_pts[k] = fma(fma(ca, vec2f(te), cb), vec2f(te), cc) * te;
        }
        let to = f32(2u * k + 1u) * dt;
        odd_pts[k] = fma(fma(ca, vec2f(to), cb), vec2f(to), cc) * to;
    }
    even_pts[n_quads] = c3;

    var a0_arr: array<f32, 16>;
    var da_arr: array<f32, 16>;
    var u0_arr: array<f32, 16>;
    var uscale_arr: array<f32, 16>;
    var val_arr: array<f32, 16>;
    var sum = 0.0;

    // Direct port of vello_common::flatten_simd::estimate_subdiv_simd (lines 488-564),
    // preserving exact d12/d01 lane order and bitwise-OR cusp check.
    for (var k = 0u; k < n_quads; k += 1u) {
        let qp0 = even_pts[k];
        let qp_half = odd_pts[k];
        let qp2 = even_pts[k + 1u];
        let qp1 = fma(qp2, vec2f(-0.5), fma(qp_half, vec2f(2.0), qp0 * -0.5));
        odd_pts[k] = qp1;

        let d01 = qp1 - qp0;
        let d12 = qp2 - qp1;
        let dd = d01 - d12;
        let d02 = d01 + d12;
        let cross = fma(dd.x, -d02.y, d02.x * dd.y);

        // Matches flatten_simd.rs:517-530 (x0 uses d12, x2 uses d01).
        let x0 = fma(d12.y, dd.y, d12.x * dd.x) / cross;
        let x2 = fma(d01.y, dd.y, d01.x * dd.x) / cross;
        let dd_hypot = sqrt(fma(dd.y, dd.y, dd.x * dd.x));
        let scale = abs(cross / (dd_hypot * (x2 - x0)));

        let a0 = approx_parabola_integral(x0);
        let a2 = approx_parabola_integral(x2);
        let da = a2 - a0;
        let da_abs = abs(da);
        let sqrt_scale = sqrt(scale);
        let noncusp_mask = (bitcast<i32>(x0) | bitcast<i32>(x2)) >= 0;
        let noncusp = da_abs * sqrt_scale;
        let xmin = CUBIC_SQRT_TOL / sqrt_scale;
        let cusp = (CUBIC_SQRT_TOL * da_abs) / approx_parabola_integral(xmin);
        let val_raw = select(cusp, noncusp, noncusp_mask);
        let val = select(0.0, val_raw, is_finite_f32(val_raw));

        let u0 = approx_parabola_inv_integral(a0);
        let u2 = approx_parabola_inv_integral(a2);
        let uscale = 1.0 / (u2 - u0);

        a0_arr[k] = a0;
        da_arr[k] = da;
        u0_arr[k] = u0;
        uscale_arr[k] = uscale;
        val_arr[k] = val;
        sum += val;
    }

    if !is_finite_f32(sum) || sum <= 0.0 {
        output_line(path_ix, p0, p3);
        return;
    }

    let n = clamp(u32(ceil((0.5 * sum) / CUBIC_SQRT_TOL)), 1u, MAX_QUAD_LINES);
    if n == 1u {
        output_line(path_ix, p0, p3);
        return;
    }

    let line_ix = atomicAdd(&bump.lines, n);
    let step = sum / f32(n);
    let step_recip = 1.0 / step;
    var val_sum = 0.0;
    var last_n = 0u;
    var x0base = 0.0;
    var prev = p0;
    var emitted = 0u;

    for (var k = 0u; k < n_quads; k += 1u) {
        let val = val_arr[k];
        val_sum += val;
        let this_n = val_sum * step_recip;
        let this_n_next = 1.0 + floor(this_n);
        let next_n = u32(max(this_n_next, 0.0));
        if next_n > last_n {
            let dn = next_n - last_n;
            let dx = step / val;
            let x0 = x0base * dx;
            let qp0 = even_pts[k];
            let qp1 = odd_pts[k];
            let qp2 = even_pts[k + 1u];
            let qca = fma(qp1, vec2f(-2.0), qp0) + qp2;
            let qcb = (qp1 - qp0) * 2.0;
            let qcc = qp0;
            let a0_k = a0_arr[k];
            let da_k = da_arr[k];
            let u0_k = u0_arr[k];
            let uscale_k = uscale_arr[k];
            for (var j = 0u; j < dn; j += 1u) {
                let idx = last_n + j;
                if idx >= 1u && idx < n && emitted + 1u < n && val > 0.0 {
                    let x = fma(f32(j), dx, x0);
                    let a = fma(da_k, x, a0_k);
                    let u = approx_parabola_inv_integral(a);
                    let t = (u - u0_k) * uscale_k;
                    let pt = origin + fma(fma(qca, vec2f(t), qcb), vec2f(t), qcc);
                    let safe_pt = select(prev, pt, is_finite_vec2(pt));
                    write_line(line_ix + emitted, path_ix, prev, safe_pt);
                    prev = safe_pt;
                    emitted += 1u;
                }
            }
        }
        x0base = this_n_next - this_n;
        last_n = max(last_n, next_n);
    }

    // Emit the exact end point so the subpath stays watertight.
    write_line(line_ix + emitted, path_ix, prev, p3);
    emitted += 1u;
    // Pad any rare rounding slack slots with degenerate zero-length lines (dropped by path_count).
    while emitted < n {
        write_line(line_ix + emitted, path_ix, p3, p3);
        emitted += 1u;
    }
}

@compute @workgroup_size(256)
fn main(
    @builtin(global_invocation_id) global_id: vec3<u32>,
    @builtin(local_invocation_id) local_id: vec3<u32>,
) {
    let ix = global_id.x;
    pathdata_base = config.pathdata_base;
    bbox = vec4(1e31, 1e31, -1e31, -1e31);

    let tag = compute_tag_monoid(ix);
    let path_ix = tag.monoid.path_ix;
    let style_ix = tag.monoid.style_ix;
    let trans_ix = tag.monoid.trans_ix;

    let out = &path_bboxes[path_ix];
    let style_flags = scene[config.style_base + style_ix];
    let draw_flags = select(DRAW_INFO_FLAGS_FILL_RULE_BIT, 0u, (style_flags & STYLE_FLAGS_FILL) == 0u);
    if (tag.tag_byte & PATH_TAG_PATH) != 0u {
        (*out).draw_flags = draw_flags;
        (*out).trans_ix = trans_ix;
    }

    let seg_type = tag.tag_byte & PATH_TAG_SEG_TYPE;
    if seg_type != 0u {
        let transform = read_transform(config.transform_base, trans_ix);
        let pathseg_offset = tag.monoid.pathseg_offset;
        let is_f32 = (tag.tag_byte & PATH_TAG_F32) != 0u;
        let view_right = f32(config.target_width) + 1.0;
        let view_bottom = f32(config.target_height) + 1.0;

        var p0: vec2f;
        var p1: vec2f;
        if is_f32 {
            p0 = read_f32_point(pathseg_offset);
            p1 = read_f32_point(pathseg_offset + 2u);
        } else {
            p0 = read_i16_point(pathseg_offset);
            p1 = read_i16_point(pathseg_offset + 1u);
        }

        if seg_type == PATH_TAG_LINETO {
            let tp0 = transform_apply(transform, p0);
            let tp1 = transform_apply(transform, p1);
            flatten_line(path_ix, tp0, tp1, view_right, view_bottom);
        } else if seg_type == PATH_TAG_QUADTO {
            var p2: vec2f;
            if is_f32 {
                p2 = read_f32_point(pathseg_offset + 4u);
            } else {
                p2 = read_i16_point(pathseg_offset + 2u);
            }
            let tp0 = transform_apply(transform, p0);
            let tp1 = transform_apply(transform, p1);
            let tp2 = transform_apply(transform, p2);
            flatten_quad(path_ix, tp0, tp1, tp2, view_right, view_bottom);
        } else if seg_type == PATH_TAG_CUBICTO {
            var p2: vec2f;
            var p3: vec2f;
            if is_f32 {
                p2 = read_f32_point(pathseg_offset + 4u);
                p3 = read_f32_point(pathseg_offset + 6u);
            } else {
                p2 = read_i16_point(pathseg_offset + 2u);
                p3 = read_i16_point(pathseg_offset + 3u);
            }
            let tp0 = transform_apply(transform, p0);
            let tp1 = transform_apply(transform, p1);
            let tp2 = transform_apply(transform, p2);
            let tp3 = transform_apply(transform, p3);
            flatten_cubic(path_ix, tp0, tp1, tp2, tp3, view_right, view_bottom);
        }

        if bbox.z > bbox.x || bbox.w > bbox.y {
            atomicMin(&(*out).x0, round_down(bbox.x));
            atomicMin(&(*out).y0, round_down(bbox.y));
            atomicMax(&(*out).x1, round_up(bbox.z));
            atomicMax(&(*out).y1, round_up(bbox.w));
        }
    }
}
