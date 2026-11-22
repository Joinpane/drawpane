//! Camera-independent encoding of the ordinary paint subset for Vello compute.
//!
//! The compute encoder uses the same record geometry and glyph mask eligibility as the main
//! rasterizers. The page predicate keeps unsupported ops in the main render graph.

use crate::error::{EngineError, Result};
use crate::geometry;
use crate::record::{
    CompactPath, ComposeMode, GlyphInstance, GradientKind, MASK_OUTLINE_EVENODD, MASK_OUTLINE_NONZERO,
    MASK_OUTLINE_PICTURE, Op, Paint, PathEntry, Record,
};
use crate::store::{ROOT, Store};
use crate::stroke;
use vello_common::kurbo::{Affine, BezPath, Rect, Shape};

/// Receiver for ordinary-paint drawing commands in page coordinates (camera-independent).
pub trait OrdinarySink {
    /// The most device pixels per page unit the encoding will be drawn at, so strokes are
    /// expanded finely enough for it (`stroke::resolve_stroke_outline`).
    fn view_scale(&self) -> f64 {
        1.0
    }
    /// Opens an isolated compositing/blending layer clipped to `bounds` in `world` space.
    /// `blend` uses Drawpane's wire enum (`0` = Normal, `1..=15` = W3C separable/non-separable).
    fn push_layer(&mut self, world: Affine, bounds: Rect, blend: u32, compose: ComposeMode, opacity: f32);
    fn pop_layer(&mut self);

    fn push_clip(&mut self, world: Affine, path: &BezPath, even_odd: bool);
    fn pop_clip(&mut self);

    fn fill_path(&mut self, world: Affine, path: &BezPath, even_odd: bool, paint: &Paint, alpha: f32);
    fn fill_compact(&mut self, world: Affine, path: &CompactPath, even_odd: bool, paint: &Paint, alpha: f32);

    /// Draws a glyph run. When `allow_snap` is true (`masks` eligibility in `exec.rs`: solid paint,
    /// non-even-odd, outside `DestOut`/`DestIn` mask layers, and either opaque or adjacent glyphs
    /// non-overlapping), each glyph's device origin snaps to 1/8 px when axis-aligned and small.
    #[allow(clippy::too_many_arguments)]
    fn fill_glyphs(
        &mut self,
        world: Affine,
        scale: f64,
        glyphs: &[GlyphInstance],
        paint: &Paint,
        even_odd: bool,
        alpha: f32,
        allow_snap: bool,
    ) -> Result<()>;
}

fn finite_affine(t: Affine) -> bool {
    t.as_coeffs().iter().all(|v| v.is_finite())
}

/// Returns whether a solid non-even-odd glyph run is eligible for 1/8 px glyph mask snapping
/// (matching `exec.rs::Walk::glyphs`).
pub fn glyph_run_mask_eligible(
    store: &Store,
    scale: f64,
    glyphs: &[GlyphInstance],
    paint: &Paint,
    even_odd: bool,
    alpha: f32,
    mask_depth: usize,
) -> bool {
    if mask_depth > 0 || even_odd {
        return false;
    }
    let Paint::Solid(c) = paint else {
        return false;
    };
    if c[3] * alpha <= 0.0 {
        return false;
    }
    if c[3] * alpha >= 1.0 {
        return true;
    }
    crate::exec::glyphs_non_overlapping(store, scale, glyphs)
}

fn ordinary_paint_supported(paint: &Paint) -> bool {
    match paint {
        Paint::Solid(_) => true,
        Paint::Gradient(g) => g.kind != GradientKind::Diamond,
        // P0 routes Image and Placeholder paints through vello_gpu (dynamic mip levels / device
        // checker anchor); P1 adds image-atlas support in the unified encoder.
        Paint::Image(_) | Paint::Placeholder(_) => false,
    }
}

/// Returns `true` when the entire live visible scene in `store` consists solely of ordinary paint
/// supported by Vello 0.12's GPU compute pipeline (normal-blend fills, cached strokes, clips,
/// outline masks, isolated opacity/SrcOver/DestOut/DestIn layers, solid/linear/radial/angular
/// gradients, and text glyph runs). Any page with shadows, blurs, glass, grain/texture,
/// picture/alpha/luminance masks, diamond gradients, images, or non-normal blends returns `false`
/// and stays on `vello_gpu` (non-normal blends move to compute in P2).
pub fn is_ordinary_page(store: &Store) -> bool {
    if store.has_context() || !store.readers().is_empty() {
        return false;
    }
    let Some(root) = store.nodes.get(&ROOT) else {
        return false;
    };

    fn check_children(store: &Store, children: &[u32], alpha: f32) -> bool {
        for &cid in children {
            let Some(node) = store.nodes.get(&cid) else {
                continue;
            };
            let r = &node.record;
            if r.hidden() {
                continue;
            }
            if r.refusing_bits() != 0 || r.context() {
                return false;
            }
            if r.is_mask() {
                if r.mask >= MASK_OUTLINE_PICTURE {
                    return false;
                }
                if !matches!(r.mask, MASK_OUTLINE_NONZERO | MASK_OUTLINE_EVENODD) {
                    return false;
                }
                if r.paths.is_empty() {
                    return false;
                }
                continue;
            }
            let opacity = alpha * r.opacity;
            if opacity <= 0.0 {
                continue;
            }
            if !r.post_effects.is_empty() || r.blend != 0 {
                return false;
            }
            let isolate = r.isolate() && r.opacity < 1.0;
            let inner = if isolate { 1.0 } else { opacity };
            let ops = if r.provisional() { &r.coarse } else { &r.ops };
            let mut active_alpha = inner;
            let mut layer_stack: Vec<f32> = Vec::new();
            for op in ops {
                match op {
                    Op::Fill { paint, blend, .. } => {
                        if *blend != 0 || !ordinary_paint_supported(paint) {
                            return false;
                        }
                    }
                    Op::Stroke {
                        path,
                        style,
                        paint,
                        blend,
                        ..
                    } => {
                        if style.width <= 0.0 {
                            continue;
                        }
                        if *blend != 0
                            || !ordinary_paint_supported(paint)
                            || matches!(r.paths.get(*path as usize), Some(PathEntry::Outside(_)))
                        {
                            return false;
                        }
                    }
                    Op::Clip { .. } | Op::Unclip => {}
                    Op::Layer { .. } => {
                        layer_stack.push(active_alpha);
                        active_alpha = 1.0;
                    }
                    Op::Unlayer => {
                        if let Some(prev) = layer_stack.pop() {
                            active_alpha = prev;
                        }
                    }
                    Op::Children => {
                        if !check_children(store, &node.children, active_alpha) {
                            return false;
                        }
                    }
                    Op::Read { .. }
                    | Op::DropShadow { .. }
                    | Op::InnerShadow { .. }
                    | Op::Glass(_)
                    | Op::BackgroundBlur(_)
                    | Op::ProgressiveBlur(_) => return false,
                }
            }
        }
        true
    }

    check_children(store, &root.children, 1.0)
}

fn node_clip_rect(store: &Store, id: u32, r: &Record) -> Rect {
    let box_rect = Rect::new(0.0, 0.0, f64::from(r.size[0]), f64::from(r.size[1]));
    let mut b = r
        .content_bounds(&|g| store.glyphs.bounds(g))
        .map_or(box_rect, |cb| cb.union(box_rect));
    if let Some(sub) = store.bounds(id) {
        b = b.union(sub);
    }
    if !b.is_finite() || (b.width() <= 0.0 && b.height() <= 0.0) {
        Rect::new(-1e5, -1e5, 1e5, 1e5)
    } else {
        b.inflate(8.0, 8.0)
    }
}

fn resolve_entry_bez(store: &Store, id: u32, r: &Record, path_idx: u32) -> Result<Option<BezPath>> {
    match r.paths.get(path_idx as usize) {
        Some(PathEntry::Glyphs { scale, glyphs }) => {
            let s = f64::from(*scale);
            let mut out = BezPath::new();
            for g in glyphs {
                let glyph = store
                    .glyphs
                    .get(g.glyph)
                    .ok_or_else(|| EngineError::unknown(format!("glyph {}", g.glyph)))?;
                let mut p = glyph.path.clone();
                p.apply_affine(Affine::new([s, 0.0, 0.0, -s, f64::from(g.x), f64::from(g.y)]));
                out.extend(p);
            }
            Ok(Some(out))
        }
        Some(PathEntry::Outside(of)) => {
            let Some(inner) = resolve_entry_bez(store, id, r, *of)? else {
                return Ok(None);
            };
            let shape = if inner.is_empty() {
                Rect::ZERO
            } else {
                inner.bounding_box().inflate(1.0, 1.0)
            };
            let record_bounds = store.bounds(id).unwrap_or(shape);
            let base = shape.union(record_bounds);
            let pad = f64::from(r.reach)
                .max(base.width().abs().max(base.height().abs()) * 2.0)
                .max(65536.0);
            let outer = base.inflate(pad, pad);
            let mut p = geometry::rect_path(outer);
            p.extend(inner);
            Ok(Some(p))
        }
        Some(_) => Ok(r.entry_path(path_idx)),
        None => Err(EngineError::malformed(format!("no path {path_idx}"))),
    }
}

/// Walks the ordinary-paint render graph in page coordinates, emitting drawing operations to `sink`.
pub fn walk_ordinary<S: OrdinarySink>(store: &Store, sink: &mut S) -> Result<()> {
    let Some(root) = store.nodes.get(&ROOT) else {
        return Err(EngineError::malformed("no page"));
    };
    let kids = root.children.clone();
    walk_children(store, &kids, Affine::IDENTITY, 1.0, 0, sink)
}

fn walk_children<S: OrdinarySink>(
    store: &Store,
    children: &[u32],
    parent_world: Affine,
    parent_alpha: f32,
    mask_depth: usize,
    sink: &mut S,
) -> Result<()> {
    let mut clipping = false;
    for &cid in children {
        let Some(node) = store.nodes.get(&cid) else {
            continue;
        };
        let cr = &node.record;
        if cr.hidden() {
            continue;
        }
        if cr.is_mask() {
            if clipping {
                sink.pop_clip();
                clipping = false;
            }
            if matches!(cr.mask, MASK_OUTLINE_NONZERO | MASK_OUTLINE_EVENODD) {
                let mask_world = parent_world * cr.transform;
                if finite_affine(mask_world) {
                    let even_odd = cr.mask == MASK_OUTLINE_EVENODD;
                    let p = resolve_entry_bez(store, cid, cr, 0)?.unwrap_or_default();
                    sink.push_clip(mask_world, &p, even_odd);
                    clipping = true;
                }
            }
            continue;
        }
        if clipping && cr.ends_mask() {
            sink.pop_clip();
            clipping = false;
        }
        walk_node(store, cid, parent_world, parent_alpha, mask_depth, sink)?;
    }
    if clipping {
        sink.pop_clip();
    }
    Ok(())
}

fn walk_node<S: OrdinarySink>(
    store: &Store,
    id: u32,
    parent_world: Affine,
    parent_alpha: f32,
    parent_mask_depth: usize,
    sink: &mut S,
) -> Result<()> {
    let Some(node) = store.nodes.get(&id) else {
        return Ok(());
    };
    let r = &node.record;
    if r.hidden() || r.context() {
        return Ok(());
    }
    let world = parent_world * r.transform;
    if !finite_affine(world) {
        return Ok(());
    }
    let opacity = parent_alpha * r.opacity;
    if opacity <= 0.0 {
        return Ok(());
    }

    let isolate_layer = (r.isolate() && r.opacity < 1.0) || r.blend != 0;
    let inner_alpha = if isolate_layer { 1.0 } else { opacity };
    if isolate_layer {
        let bounds = node_clip_rect(store, id, r);
        sink.push_layer(world, bounds, r.blend, ComposeMode::SrcOver, opacity);
    }

    let ops = if r.provisional() { &r.coarse } else { &r.ops };
    let mut active_alpha = inner_alpha;
    let mut mask_depth = parent_mask_depth;
    let mut layer_stack: Vec<(f32, bool)> = Vec::new();
    let mut open_clips = 0usize;

    let res = (|| -> Result<()> {
        for op in ops {
            match op {
                Op::Fill {
                    path,
                    even_odd,
                    paint,
                    blend,
                } => {
                    let pushed_blend = *blend != 0;
                    if pushed_blend {
                        let b = r
                            .entry_bounds(*path, &|g| store.glyphs.bounds(g))
                            .unwrap_or_else(|| node_clip_rect(store, id, r))
                            .inflate(2.0, 2.0);
                        sink.push_layer(world, b, u32::from(*blend), ComposeMode::SrcOver, 1.0);
                    }
                    match r.paths.get(*path as usize) {
                        Some(PathEntry::Glyphs { scale, glyphs }) => {
                            let allow_snap = glyph_run_mask_eligible(
                                store,
                                f64::from(*scale),
                                glyphs,
                                paint,
                                *even_odd,
                                active_alpha,
                                mask_depth,
                            );
                            sink.fill_glyphs(
                                world,
                                f64::from(*scale),
                                glyphs,
                                paint,
                                *even_odd,
                                active_alpha,
                                allow_snap,
                            )?;
                        }
                        Some(PathEntry::Path(compact)) => {
                            if !compact.is_empty() {
                                sink.fill_compact(world, compact, *even_odd, paint, active_alpha);
                            }
                        }
                        _ => {
                            if let Some(p) = resolve_entry_bez(store, id, r, *path)?
                                && !p.is_empty()
                            {
                                sink.fill_path(world, &p, *even_odd, paint, active_alpha);
                            }
                        }
                    }
                    if pushed_blend {
                        sink.pop_layer();
                    }
                }
                Op::Stroke {
                    path,
                    style,
                    paint,
                    blend,
                    cache,
                } => {
                    if style.width <= 0.0 {
                        continue;
                    }
                    let Some(expanded) = stroke::resolve_stroke_outline(
                        r,
                        *path,
                        style,
                        cache,
                        &store.glyphs,
                        &store.limits,
                        stroke::max_scale(world) * sink.view_scale(),
                        &store.strokes,
                    )?
                    else {
                        continue;
                    };
                    if expanded.path.is_empty() {
                        continue;
                    }
                    let pushed_blend = *blend != 0;
                    if pushed_blend {
                        let reach = style.reach();
                        let b = r
                            .entry_bounds(*path, &|g| store.glyphs.bounds(g))
                            .unwrap_or_else(|| node_clip_rect(store, id, r))
                            .inflate(reach, reach);
                        sink.push_layer(world, b, u32::from(*blend), ComposeMode::SrcOver, 1.0);
                    }
                    sink.fill_compact(world, &expanded.path, expanded.even_odd, paint, active_alpha);
                    if pushed_blend {
                        sink.pop_layer();
                    }
                }
                Op::Clip { path, even_odd } => {
                    let p = resolve_entry_bez(store, id, r, *path)?.unwrap_or_default();
                    sink.push_clip(world, &p, *even_odd);
                    open_clips += 1;
                }
                Op::Unclip => {
                    if open_clips > 0 {
                        sink.pop_clip();
                        open_clips -= 1;
                    }
                }
                Op::Layer { compose } => {
                    let (layer_alpha, is_mask, bounds) = match compose {
                        ComposeMode::SrcOver => (active_alpha, false, node_clip_rect(store, id, r)),
                        ComposeMode::DestOut => (1.0, true, node_clip_rect(store, id, r)),
                        // DestIn must cover the entire enclosing layer so pixels outside the mask
                        // clear to transparent rather than staying untouched.
                        ComposeMode::DestIn => (1.0, true, Rect::new(-1e6, -1e6, 1e6, 1e6)),
                    };
                    sink.push_layer(world, bounds, 0, *compose, layer_alpha);
                    layer_stack.push((active_alpha, is_mask));
                    active_alpha = 1.0;
                    if is_mask {
                        mask_depth += 1;
                    }
                }
                Op::Unlayer => {
                    if let Some((prev_alpha, is_mask)) = layer_stack.pop() {
                        sink.pop_layer();
                        active_alpha = prev_alpha;
                        if is_mask {
                            mask_depth = mask_depth.saturating_sub(1);
                        }
                    }
                }
                Op::Children => {
                    let kids = node.children.clone();
                    walk_children(store, &kids, world, active_alpha, mask_depth, sink)?;
                }
                Op::Read { .. }
                | Op::DropShadow { .. }
                | Op::InnerShadow { .. }
                | Op::Glass(_)
                | Op::BackgroundBlur(_)
                | Op::ProgressiveBlur(_) => {}
            }
        }
        Ok(())
    })();

    while open_clips > 0 {
        sink.pop_clip();
        open_clips -= 1;
    }
    while let Some((_, _)) = layer_stack.pop() {
        sink.pop_layer();
    }
    if isolate_layer {
        sink.pop_layer();
    }
    res
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::masks::PHASES;
    use vello_common::fearless_simd::Level;
    use vello_common::flatten::{self, FlattenCtx, Line};
    use vello_common::geometry::RectU16;
    use vello_common::kurbo::PathEl;

    // Exact scalar Rust mirror of `vendor/vello_shaders/shader/flatten.wgsl` so native `cargo test`
    // continuously checks our WGSL flattener port against `vello_common 0.4::flatten::fill`.
    const TOL_2: f32 = 0.0625;
    const SQRT_TOL: f32 = 0.5;
    const CUBIC_SQRT_TOL: f32 = 0.47434165;
    const MAX_QUADS: usize = 16;
    const MAX_HYPOT2: f32 = 0.27;

    fn approx_parabola_integral(x: f32) -> f32 {
        const D: f32 = 0.67;
        const D4: f32 = 0.2015112;
        x / ((0.25f32.mul_add(x * x, D4)).sqrt().sqrt() + (1.0 - D))
    }

    fn approx_parabola_inv_integral(x: f32) -> f32 {
        const B: f32 = 0.39;
        x * ((1.0 - B) + (0.25f32.mul_add(x * x, B * B)).sqrt())
    }

    fn line_nearest_dist_sq(p0: [f32; 2], p1: [f32; 2], p: [f32; 2]) -> f32 {
        let d = [p1[0] - p0[0], p1[1] - p0[1]];
        let dotp = (p[0] - p0[0]) * d[0] + (p[1] - p0[1]) * d[1];
        let d2 = d[0] * d[0] + d[1] * d[1];
        if dotp <= 0.0 {
            let dx = p[0] - p0[0];
            let dy = p[1] - p0[1];
            dx * dx + dy * dy
        } else if dotp >= d2 {
            let dx = p[0] - p1[0];
            let dy = p[1] - p1[1];
            dx * dx + dy * dy
        } else {
            let t = dotp / d2;
            let dx = p[0] - (p0[0] + d[0] * t);
            let dy = p[1] - (p0[1] + d[1] * t);
            dx * dx + dy * dy
        }
    }

    fn wgsl_flatten_cubic(p0: [f32; 2], p1: [f32; 2], p2: [f32; 2], p3: [f32; 2], out: &mut Vec<([f32; 2], [f32; 2])>) {
        if line_nearest_dist_sq(p0, p3, p1).max(line_nearest_dist_sq(p0, p3, p2)) <= (16.0 / 9.0) * TOL_2 {
            out.push((p0, p3));
            return;
        }
        let origin = p0;
        let c1 = [p1[0] - origin[0], p1[1] - origin[1]];
        let c2 = [p2[0] - origin[0], p2[1] - origin[1]];
        let c3 = [p3[0] - origin[0], p3[1] - origin[1]];
        let p1x2 = [c1[0] * 3.0, c1[1] * 3.0];
        let p2x2 = [c2[0] * 3.0 - c3[0], c2[1] * 3.0 - c3[1]];
        let diff = [p2x2[0] - p1x2[0], p2x2[1] - p1x2[1]];
        let err_div = (diff[0] * diff[0] + diff[1] * diff[1]) / MAX_HYPOT2;
        const LUT: [f32; MAX_QUADS] = [
            1.0, 64.0, 729.0, 4096.0, 15625.0, 46656.0, 117649.0, 262144.0, 531441.0, 1000000.0, 1771561.0, 2985984.0,
            4826809.0, 7529536.0, 11390625.0, 16777216.0,
        ];
        let mut n_quads = MAX_QUADS;
        for (i, &lim) in LUT.iter().enumerate() {
            if err_div <= lim {
                n_quads = i + 1;
                break;
            }
        }
        let dt = 0.5 / n_quads as f32;
        let ca = [(c1[0] - c2[0]).mul_add(3.0, c3[0]), (c1[1] - c2[1]).mul_add(3.0, c3[1])];
        let cb = [c1[0].mul_add(-2.0, c2[0]) * 3.0, c1[1].mul_add(-2.0, c2[1]) * 3.0];
        let cc = [c1[0] * 3.0, c1[1] * 3.0];
        let mut even = [[0.0f32; 2]; 17];
        let mut odd = [[0.0f32; 2]; 16];
        for k in 0..n_quads {
            if k > 0 {
                let te = (2 * k) as f32 * dt;
                even[k] = [
                    ca[0].mul_add(te, cb[0]).mul_add(te, cc[0]) * te,
                    ca[1].mul_add(te, cb[1]).mul_add(te, cc[1]) * te,
                ];
            }
            let to = (2 * k + 1) as f32 * dt;
            odd[k] = [
                ca[0].mul_add(to, cb[0]).mul_add(to, cc[0]) * to,
                ca[1].mul_add(to, cb[1]).mul_add(to, cc[1]) * to,
            ];
        }
        even[n_quads] = c3;
        let mut a0_arr = [0.0f32; 16];
        let mut da_arr = [0.0f32; 16];
        let mut u0_arr = [0.0f32; 16];
        let mut uscale_arr = [0.0f32; 16];
        let mut val_arr = [0.0f32; 16];
        let mut sum = 0.0f32;
        for k in 0..n_quads {
            let qp0 = even[k];
            let qph = odd[k];
            let qp2 = even[k + 1];
            let qp1 = [
                qp2[0].mul_add(-0.5, qph[0].mul_add(2.0, qp0[0] * -0.5)),
                qp2[1].mul_add(-0.5, qph[1].mul_add(2.0, qp0[1] * -0.5)),
            ];
            odd[k] = qp1;
            let d01 = [qp1[0] - qp0[0], qp1[1] - qp0[1]];
            let d12 = [qp2[0] - qp1[0], qp2[1] - qp1[1]];
            let dd = [d01[0] - d12[0], d01[1] - d12[1]];
            let d02 = [d01[0] + d12[0], d01[1] + d12[1]];
            let cross = dd[0].mul_add(-d02[1], d02[0] * dd[1]);
            let x0 = d12[1].mul_add(dd[1], d12[0] * dd[0]) / cross;
            let x2 = d01[1].mul_add(dd[1], d01[0] * dd[0]) / cross;
            let dd_hypot = dd[1].mul_add(dd[1], dd[0] * dd[0]).sqrt();
            let scale = (cross / (dd_hypot * (x2 - x0))).abs();
            let a0 = approx_parabola_integral(x0);
            let a2 = approx_parabola_integral(x2);
            let da = a2 - a0;
            let da_abs = da.abs();
            let sqrt_scale = scale.sqrt();
            let noncusp = (x0.to_bits() as i32 | x2.to_bits() as i32) >= 0;
            let val_raw = if noncusp {
                da_abs * sqrt_scale
            } else {
                (CUBIC_SQRT_TOL * da_abs) / approx_parabola_integral(CUBIC_SQRT_TOL / sqrt_scale)
            };
            let val = if val_raw.is_finite() { val_raw } else { 0.0 };
            let u0 = approx_parabola_inv_integral(a0);
            let u2 = approx_parabola_inv_integral(a2);
            a0_arr[k] = a0;
            da_arr[k] = da;
            u0_arr[k] = u0;
            uscale_arr[k] = 1.0 / (u2 - u0);
            val_arr[k] = val;
            sum += val;
        }
        if !sum.is_finite() || sum <= 0.0 {
            out.push((p0, p3));
            return;
        }
        let n = ((0.5 * sum / CUBIC_SQRT_TOL).ceil() as usize).clamp(1, 4096);
        if n == 1 {
            out.push((p0, p3));
            return;
        }
        let step = sum / n as f32;
        let step_recip = 1.0 / step;
        let mut val_sum = 0.0f32;
        let mut last_n = 0usize;
        let mut x0base = 0.0f32;
        let mut prev = p0;
        let mut emitted = 0usize;
        for k in 0..n_quads {
            let val = val_arr[k];
            val_sum += val;
            let this_n = val_sum * step_recip;
            let this_n_next = 1.0 + this_n.floor();
            let next_n = this_n_next.max(0.0) as usize;
            if next_n > last_n {
                let dn = next_n - last_n;
                let dx = step / val;
                let x0 = x0base * dx;
                let qp0 = even[k];
                let qp1 = odd[k];
                let qp2 = even[k + 1];
                let qca = [
                    qp1[0].mul_add(-2.0, qp0[0]) + qp2[0],
                    qp1[1].mul_add(-2.0, qp0[1]) + qp2[1],
                ];
                let qcb = [(qp1[0] - qp0[0]) * 2.0, (qp1[1] - qp0[1]) * 2.0];
                let qcc = qp0;
                for j in 0..dn {
                    let idx = last_n + j;
                    if idx >= 1 && idx < n && emitted + 1 < n && val > 0.0 {
                        let x = (j as f32).mul_add(dx, x0);
                        let a = da_arr[k].mul_add(x, a0_arr[k]);
                        let u = approx_parabola_inv_integral(a);
                        let t = (u - u0_arr[k]) * uscale_arr[k];
                        let pt = [
                            origin[0] + qca[0].mul_add(t, qcb[0]).mul_add(t, qcc[0]),
                            origin[1] + qca[1].mul_add(t, qcb[1]).mul_add(t, qcc[1]),
                        ];
                        out.push((prev, pt));
                        prev = pt;
                        emitted += 1;
                    }
                }
            }
            x0base = this_n_next - this_n;
            last_n = last_n.max(next_n);
        }
        out.push((prev, p3));
    }

    #[test]
    fn wgsl_flattener_mirror_matches_vello_common_fill() {
        let shapes = [
            geometry::ellipse(180.0, 120.0),
            geometry::rounded_rect(200.0, 120.0, [30.0; 4], 0.6),
            geometry::rounded_rect(140.0, 80.0, [24.0, 8.0, 16.0, 4.0], 0.0),
            {
                // S-curve + cusp-like tight bend (like glyph bowls)
                let mut p = BezPath::new();
                p.move_to((10.0, 10.0));
                p.curve_to((140.0, 15.0), (20.0, 160.0), (180.0, 150.0));
                p.curve_to((90.0, 90.0), (95.0, 85.0), (10.0, 10.0));
                p.close_path();
                p
            },
        ];
        let mut ctx = FlattenCtx::default();
        let cull = RectU16::new(0, 0, 1000, 1000);
        for (si, shape) in shapes.iter().enumerate() {
            let mut ref_lines: Vec<Line> = Vec::new();
            flatten::fill(
                Level::baseline(),
                shape.iter(),
                Affine::IDENTITY,
                &mut ref_lines,
                &mut ctx,
                cull,
            );

            let mut mirror_lines = Vec::new();
            let mut start = [0.0f32; 2];
            let mut last = [0.0f32; 2];
            for el in shape.elements() {
                match *el {
                    PathEl::MoveTo(p) => {
                        start = [p.x as f32, p.y as f32];
                        last = start;
                    }
                    PathEl::LineTo(p) => {
                        let q = [p.x as f32, p.y as f32];
                        mirror_lines.push((last, q));
                        last = q;
                    }
                    PathEl::CurveTo(a, b, c) => {
                        let p1 = [a.x as f32, a.y as f32];
                        let p2 = [b.x as f32, b.y as f32];
                        let p3 = [c.x as f32, c.y as f32];
                        wgsl_flatten_cubic(last, p1, p2, p3, &mut mirror_lines);
                        last = p3;
                    }
                    PathEl::ClosePath => {
                        if last != start {
                            mirror_lines.push((last, start));
                            last = start;
                        }
                    }
                    PathEl::QuadTo(_, _) => unreachable!(),
                }
            }
            let ref_nonempty: Vec<([f32; 2], [f32; 2])> = ref_lines
                .iter()
                .filter(|l| (l.p1.x - l.p0.x).hypot(l.p1.y - l.p0.y) > 1e-5)
                .map(|l| ([l.p0.x, l.p0.y], [l.p1.x, l.p1.y]))
                .collect();
            let mirror_nonempty: Vec<([f32; 2], [f32; 2])> = mirror_lines
                .iter()
                .copied()
                .filter(|(a, b)| (b[0] - a[0]).hypot(b[1] - a[1]) > 1e-5)
                .collect();
            assert_eq!(
                mirror_nonempty.len(),
                ref_nonempty.len(),
                "shape {si}: line count mismatch ({} vs {})",
                mirror_nonempty.len(),
                ref_nonempty.len()
            );
            let mut max_err = 0.0f32;
            for (m, r) in mirror_nonempty.iter().zip(&ref_nonempty) {
                max_err = max_err
                    .max((m.0[0] - r.0[0]).abs())
                    .max((m.0[1] - r.0[1]).abs())
                    .max((m.1[0] - r.1[0]).abs())
                    .max((m.1[1] - r.1[1]).abs());
            }
            // vello_common's baseline SIMD level differs by platform (SSE without fused
            // multiply-add on x86-64, NEON with it on arm64), so tight bends land up to ~3e-4 px
            // apart between them. A porting error shows as a different line count or ~0.1 px.
            assert!(max_err <= 1e-3, "shape {si}: max vertex error {max_err} > 1e-3");
        }
        let _ = SQRT_TOL;
    }

    #[test]
    fn wgsl_eighth_pixel_snap_matches_exec_rounding() {
        let exec_snap = |t: f64| -> f64 {
            let mut i = t.floor();
            let mut p = ((t - i) * PHASES).round();
            if p >= PHASES {
                p = 0.0;
                i += 1.0;
            }
            i + p / PHASES
        };
        let wgsl_snap = |t: f32| -> f32 {
            let i = t.floor();
            let p = ((t - i) * 8.0 + 0.5).floor();
            i + p * 0.125
        };
        for k in -200..=200 {
            let t = (k as f64) * 0.03125; // steps of 1/32 px, hitting every 1/16 midpoint
            let expected = exec_snap(t);
            let got = f64::from(wgsl_snap(t as f32));
            assert_eq!(got, expected, "snap mismatch at t={t}");
        }
    }
}
