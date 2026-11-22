//! Stroke outline expansion shared by the CPU and GPU render backends.
//!
//! Each `Op::Stroke` expands its outline in record units using `kurbo::stroke_with` (or the exact
//! `stroke_ring` fast path for unsmoothed solid boxes) and, when the engine has no fixed heap
//! limit, keeps the filled outline (`CompactPath`, `f32` coordinates) for later frames. Every
//! backend fills that outline, so CPU and GPU never diverge on stroke expansion and no frame
//! offsets strokes again on every tile or zoom step.
//!
//! The base outline is expanded at `stroke_tolerance` (0.025 record units for ordinary shapes),
//! which is invisible up to about 5 device pixels per unit. Past that, a circle's offset still
//! fits, but an ellipse's or a curve's drifts by several device pixels at 256x Retina, so a draw
//! asks for the device scale it draws at and gets an outline at a finer level: the base tolerance
//! halved until it is within `DEVICE_TOLERANCE`, with up to `FINE_LEVELS` finer levels kept per
//! op. Everything kept counts against `StrokeBudget`, and
//! the least recently drawn outlines are dropped past it.

use crate::error::{EngineError, Result};
use crate::geometry;
use crate::glyphs::GlyphStore;
use crate::limits::Limits;
use crate::record::{CompactPath, PathEntry, Record, StrokeStyle};
use std::cell::{Cell, RefCell};
use std::sync::Arc;
use vello_common::kurbo::{self, Affine, BezPath, Cap, Join, PathEl, Rect, Shape, Stroke, StrokeCtx, StrokeOpts};

/// Device pixels of offset tolerance an outline is expanded at. Half of the 0.25 px vello_common's
/// own stroker targets, because kurbo's offset fits land up to about 2.6 times their tolerance on
/// tight curves: this keeps them within 0.5 px at any zoom, where main's reached 0.7 px.
pub const DEVICE_TOLERANCE: f64 = 0.125;
/// Finer outlines kept per op beside the base one (a zoom ladder draws two scales at once).
const FINE_LEVELS: usize = 2;
/// The finest level asked for: the base tolerance halved this many times (1/4096 of it).
const MAX_LEVEL: u8 = 12;

/// A cached stroke outline in the record's own units, ready to be filled on any backend.
#[derive(Clone, Debug)]
pub struct ExpandedStroke {
    pub path: CompactPath,
    /// `true` for `stroke_ring` (outer box minus inner hole, filled even-odd); `false` for
    /// `kurbo::stroke_with` (filled non-zero).
    pub even_odd: bool,
}

impl ExpandedStroke {
    fn bytes(&self) -> usize {
        std::mem::size_of::<ExpandedStroke>() + self.path.heap_bytes()
    }
}

#[derive(Clone, Debug)]
struct Slot {
    /// 0 is the base outline; level `k` was expanded at the base tolerance / 2^k.
    level: u8,
    stroke: Arc<ExpandedStroke>,
    /// `StrokeBudget::tick` when last drawn, for least-recently-used eviction.
    used: u64,
}

#[derive(Clone, Debug, Default)]
struct Slots {
    /// The base tolerance once known; `Some(0.0)` for exact rings, which need no levels.
    tol: Option<f64>,
    slots: Vec<Slot>,
}

/// Per-`Op::Stroke` cache of its expanded outlines (the base one and up to `FINE_LEVELS` finer).
///
/// Cloning shares the immutable outlines (safe because records are replaced whole on edit and
/// glyphs in `GlyphStore` are immutable once inserted).
#[derive(Clone, Debug, Default)]
pub struct StrokeCache(RefCell<Option<Box<Slots>>>);

impl StrokeCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// Whether any outline is held.
    pub fn is_cached(&self) -> bool {
        self.0.borrow().as_ref().is_some_and(|s| !s.slots.is_empty())
    }

    /// The level-0 outline, when held.
    pub fn base(&self) -> Option<Arc<ExpandedStroke>> {
        self.0
            .borrow()
            .as_ref()?
            .slots
            .iter()
            .find(|s| s.level == 0)
            .map(|s| Arc::clone(&s.stroke))
    }

    /// Bytes currently held by the cached outlines (`0` if none).
    pub fn cached_bytes(&self) -> usize {
        self.0
            .borrow()
            .as_ref()
            .map_or(0, |s| s.slots.iter().map(|s| s.stroke.bytes()).sum())
    }

    /// Expanded path elements held, over all levels (`0` if none).
    pub fn cached_verbs(&self) -> usize {
        self.0
            .borrow()
            .as_ref()
            .map_or(0, |s| s.slots.iter().map(|s| s.stroke.path.len()).sum())
    }

    /// (last drawn, bytes) of each held outline, for `Store::trim_strokes`.
    pub(crate) fn usage(&self) -> Vec<(u64, usize, u8)> {
        self.0.borrow().as_ref().map_or_else(Vec::new, |s| {
            s.slots.iter().map(|s| (s.used, s.stroke.bytes(), s.level)).collect()
        })
    }

    /// Drops the outline at `level` (it is expanded again when next drawn).
    pub(crate) fn evict(&self, level: u8) -> usize {
        let mut inner = self.0.borrow_mut();
        let Some(slots) = inner.as_mut() else {
            return 0;
        };
        let Some(at) = slots.slots.iter().position(|s| s.level == level) else {
            return 0;
        };
        slots.slots.swap_remove(at).stroke.bytes()
    }
}

/// The store-wide budget for kept stroke outlines (`Limits::stroke_bytes`). `held` counts bytes
/// added since the last trim (outlines of replaced records are dropped without telling it), so
/// it can only overstate; `Store::trim_strokes` recounts what is live before dropping anything.
#[derive(Debug, Default)]
pub struct StrokeBudget {
    held: Cell<usize>,
    tick: Cell<u64>,
}

impl StrokeBudget {
    /// A new frame: outlines drawn from now on are the most recent.
    pub fn advance(&self) {
        self.tick.set(self.tick.get().wrapping_add(1));
    }

    pub fn tick(&self) -> u64 {
        self.tick.get()
    }

    pub(crate) fn held(&self) -> usize {
        self.held.get()
    }

    pub(crate) fn set_held(&self, bytes: usize) {
        self.held.set(bytes);
    }

    fn add(&self, bytes: usize) {
        self.held.set(self.held.get().saturating_add(bytes));
    }
}

/// The largest scale `m` applies in any direction (its larger singular value).
pub fn max_scale(m: Affine) -> f64 {
    let [a, b, c, d, _, _] = m.as_coeffs();
    let sum = a * a + b * b + c * c + d * d;
    let det = a * d - b * c;
    let disc = (sum * sum - 4.0 * det * det).max(0.0).sqrt();
    let s = ((sum + disc) * 0.5).sqrt();
    if s.is_finite() { s } else { f64::INFINITY }
}

/// The level an outline expanded at `tol` record units needs at `scale` device pixels per unit.
pub fn stroke_level(tol: f64, scale: f64) -> u8 {
    if tol <= 0.0 || !scale.is_finite() || scale <= 0.0 {
        return 0;
    }
    let need = DEVICE_TOLERANCE / scale;
    if tol <= need {
        return 0;
    }
    (tol / need).log2().ceil().clamp(0.0, f64::from(MAX_LEVEL)) as u8
}

/// Builds kurbo's `Stroke` descriptor from a record's `StrokeStyle`.
pub fn make_kurbo_stroke(style: &StrokeStyle) -> Stroke {
    let mut s = Stroke::new(f64::from(style.width))
        .with_join(match style.join {
            1 => Join::Round,
            2 => Join::Bevel,
            _ => Join::Miter,
        })
        .with_caps(match style.cap {
            1 => Cap::Round,
            2 => Cap::Square,
            _ => Cap::Butt,
        })
        .with_miter_limit(f64::from(style.miter.max(1.0)));
    if !style.dashes.is_empty() {
        s = s.with_dashes(f64::from(style.dash_offset), style.dashes.iter().map(|d| f64::from(*d)));
    }
    s
}

/// Record-space expansion tolerance for `kurbo::stroke_with`.
///
/// - For normal UI shapes and glyphs (`span <= 2500`), uses up to `0.025` units (10x finer than
///   the 0.25 px flatten tolerance at 1x, 5x finer at Retina 2x, and proportional for tiny shapes).
/// - For gigantic shapes (`span > 2500`, including fuzz inputs up to `1e38`), scales with `span`
///   so verb counts stay tightly bounded.
pub fn stroke_tolerance(bounds: Rect, width: f32) -> f64 {
    let span = bounds.width().abs().max(bounds.height().abs()).max(f64::from(width));
    if !span.is_finite() || span <= 0.0 {
        return 0.025;
    }
    if span > 2500.0 {
        (span * 1e-5).max(0.025)
    } else {
        (span * 1e-3).clamp(1e-5, 0.025)
    }
}

/// A stroke of a box (its corners round or not) as the ring it paints: the box grown by half the
/// width, less the box shrunk by it, filled even-odd. The same outline the stroker makes, without
/// offsetting curves. Only where the join cannot matter: every corner rounder than half the width
/// (the outline is smooth there), or every corner square under a miter join that holds at a right
/// angle or a round join. Not for dashes or smoothed corners.
pub fn stroke_ring(r: &Record, i: u32, style: &StrokeStyle) -> Option<BezPath> {
    let Some(PathEntry::Rect { w, h, radii, smoothing }) = r.paths.get(i as usize) else {
        return None;
    };
    let (w, h) = (f64::from(*w), f64::from(*h));
    if *smoothing != 0.0 || !style.dashes.is_empty() || !(w > 0.0 && h > 0.0) {
        return None;
    }
    let half = f64::from(style.width) / 2.0;
    let outer_w = w + 2.0 * half;
    let outer_h = h + 2.0 * half;
    if !outer_w.is_finite() || !outer_h.is_finite() || outer_w > f64::from(f32::MAX) || outer_h > f64::from(f32::MAX) {
        return None;
    }
    let fitted = geometry::fit_radii(w, h, radii.map(f64::from));
    let square = fitted.iter().all(|r| *r == 0.0);
    let outer_round = if fitted.iter().all(|r| *r >= half) {
        fitted.map(|r| r + half)
    } else if square && style.join == 0 && style.miter.max(1.0) >= core::f32::consts::SQRT_2 {
        [0.0; 4]
    } else if square && style.join == 1 {
        [half; 4]
    } else {
        return None;
    };
    let mut ring = geometry::rounded_rect_at((-half, -half), outer_w, outer_h, outer_round);
    if w > 2.0 * half && h > 2.0 * half {
        let inner = fitted.map(|r| (r - half).max(0.0));
        ring.extend(geometry::rounded_rect_at(
            (half, half),
            w - 2.0 * half,
            h - 2.0 * half,
            inner,
        ));
    }
    Some(ring)
}

/// Control-polygon length of a `BezPath` in record units (upper bound on curve arc length).
fn bez_polygon_length(p: &BezPath) -> f64 {
    let mut total = 0.0f64;
    let mut last = None;
    let mut start = None;
    let mut step = |a: kurbo::Point, b: kurbo::Point| {
        total += (b.x - a.x).hypot(b.y - a.y);
    };
    for el in p.elements() {
        match *el {
            PathEl::MoveTo(a) => {
                last = Some(a);
                start = Some(a);
            }
            PathEl::LineTo(a) => {
                if let Some(l) = last {
                    step(l, a);
                }
                last = Some(a);
            }
            PathEl::QuadTo(a, b) => {
                if let Some(l) = last {
                    step(l, a);
                }
                step(a, b);
                last = Some(b);
            }
            PathEl::CurveTo(a, b, c) => {
                if let Some(l) = last {
                    step(l, a);
                }
                step(a, b);
                step(b, c);
                last = Some(c);
            }
            PathEl::ClosePath => {
                if let (Some(l), Some(s)) = (last, start) {
                    step(l, s);
                }
                last = start;
            }
        }
    }
    total
}

/// Converts a `BezPath` to `CompactPath`, rejecting any subpath element whose coordinates become
/// non-finite when narrowed to `f32` so downstream `f32` flatteners never see NaN or infinity.
fn bez_to_finite_compact(p: &BezPath) -> CompactPath {
    let all_finite = p.elements().iter().all(|el| match *el {
        PathEl::MoveTo(a) | PathEl::LineTo(a) => (a.x as f32).is_finite() && (a.y as f32).is_finite(),
        PathEl::QuadTo(a, b) => {
            (a.x as f32).is_finite() && (a.y as f32).is_finite() && (b.x as f32).is_finite() && (b.y as f32).is_finite()
        }
        PathEl::CurveTo(a, b, c) => {
            (a.x as f32).is_finite()
                && (a.y as f32).is_finite()
                && (b.x as f32).is_finite()
                && (b.y as f32).is_finite()
                && (c.x as f32).is_finite()
                && (c.y as f32).is_finite()
        }
        PathEl::ClosePath => true,
    });
    if all_finite {
        return CompactPath::from_bez(p);
    }
    let mut clean = BezPath::new();
    let finite_pt = |pt: kurbo::Point| (pt.x as f32).is_finite() && (pt.y as f32).is_finite();
    let mut sub_open = false;
    for el in p.elements() {
        match *el {
            PathEl::MoveTo(a) if finite_pt(a) => {
                clean.move_to(a);
                sub_open = true;
            }
            PathEl::LineTo(a) if sub_open && finite_pt(a) => clean.line_to(a),
            PathEl::QuadTo(a, b) if sub_open && finite_pt(a) && finite_pt(b) => clean.quad_to(a, b),
            PathEl::CurveTo(a, b, c) if sub_open && finite_pt(a) && finite_pt(b) && finite_pt(c) => {
                clean.curve_to(a, b, c);
            }
            PathEl::ClosePath if sub_open => {
                clean.close_path();
                sub_open = false;
            }
            _ => {
                sub_open = false;
            }
        }
    }
    CompactPath::from_bez(&clean)
}

/// Builds the full local-space path of entry `i` for stroke expansion (including all glyphs of a
/// `PathEntry::Glyphs` run), bounded by the frame geometry budget.
fn entry_local_path(r: &Record, i: u32, glyphs: &GlyphStore, verb_limit: usize) -> Result<BezPath> {
    let geometry_limit = || EngineError::limit("a stroke exceeds the frame geometry budget");
    match r.paths.get(i as usize) {
        Some(PathEntry::Glyphs { scale, glyphs: run }) => {
            let s = f64::from(*scale);
            let mut out = BezPath::new();
            let mut verbs_left = verb_limit;
            for g in run {
                let glyph = glyphs
                    .get(g.glyph)
                    .ok_or_else(|| EngineError::unknown(format!("glyph {}", g.glyph)))?;
                verbs_left = verbs_left
                    .checked_sub(glyph.path.elements().len())
                    .ok_or_else(geometry_limit)?;
                let mut p = glyph.path.clone();
                p.apply_affine(Affine::new([s, 0.0, 0.0, -s, f64::from(g.x), f64::from(g.y)]));
                out.extend(p);
            }
            Ok(out)
        }
        Some(_) => {
            let p = r
                .entry_path(i)
                .ok_or_else(|| EngineError::malformed(format!("no path {i}")))?;
            if p.elements().len() > verb_limit {
                return Err(geometry_limit());
            }
            Ok(p)
        }
        None => Err(EngineError::malformed(format!("no path {i}"))),
    }
}

/// Resolves (and, without a fixed heap, keeps) the expanded stroke outline for `Op::Stroke` on
/// record `r`, accurate to `DEVICE_TOLERANCE` at `scale` device pixels per record unit.
///
/// Returns `Ok(None)` only for `PathEntry::Outside` (which is viewport-dependent and only appears
/// in fuzz-generated records). All normal shapes, curves, rounded rects, ellipses, dashed paths,
/// and text glyph runs return `Ok(Some(Arc<ExpandedStroke>))` so every backend draws the exact
/// same filled outline.
#[allow(clippy::too_many_arguments)]
pub fn resolve_stroke_outline(
    r: &Record,
    path_idx: u32,
    style: &StrokeStyle,
    cache: &StrokeCache,
    glyphs: &GlyphStore,
    limits: &Limits,
    scale: f64,
    budget: &StrokeBudget,
) -> Result<Option<Arc<ExpandedStroke>>> {
    if style.width <= 0.0 {
        return Ok(Some(Arc::new(ExpandedStroke {
            path: CompactPath::default(),
            even_odd: false,
        })));
    }
    if matches!(r.paths.get(path_idx as usize), Some(PathEntry::Outside(_))) {
        return Ok(None);
    }
    let tick = budget.tick();
    if let Some(inner) = cache.0.borrow_mut().as_mut()
        && let Some(tol) = inner.tol
    {
        let level = stroke_level(tol, scale);
        if let Some(slot) = inner.slots.iter_mut().find(|s| s.level == level) {
            slot.used = tick;
            return Ok(Some(Arc::clone(&slot.stroke)));
        }
    }
    // Fixed-heap builds reserve their remaining memory for rendering and export scratch.
    let retain = limits.memory_bytes == 0;
    let (stroke, tol, level) = if let Some(ring) = stroke_ring(r, path_idx, style) {
        let ring = ExpandedStroke {
            path: bez_to_finite_compact(&ring),
            even_odd: true,
        };
        (ring, 0.0, 0)
    } else {
        let local = entry_local_path(r, path_idx, glyphs, limits.frame_verbs)?;
        if local.is_empty() {
            let empty = ExpandedStroke {
                path: CompactPath::default(),
                even_odd: false,
            };
            (empty, 0.0, 0)
        } else {
            if !style.dashes.is_empty() {
                let length = bez_polygon_length(&local);
                crate::record::check_dashes(style, length, limits)?;
            }
            let tol = stroke_tolerance(local.bounding_box(), style.width);
            let level = stroke_level(tol, scale);
            let mut ctx = StrokeCtx::default();
            kurbo::stroke_with(
                local.elements().iter().copied(),
                &make_kurbo_stroke(style),
                &StrokeOpts::default(),
                tol / f64::from(1u32 << level),
                &mut ctx,
            );
            if ctx.output().elements().len() > limits.frame_verbs {
                return Err(EngineError::limit("a stroke exceeds the frame geometry budget"));
            }
            let stroke = ExpandedStroke {
                path: bez_to_finite_compact(ctx.output()),
                even_odd: false,
            };
            (stroke, tol, level)
        }
    };
    let stroke = Arc::new(stroke);
    if retain {
        let mut held = cache.0.borrow_mut();
        let inner = held.get_or_insert_with(Box::default);
        inner.tol = Some(tol);
        inner.slots.push(Slot {
            level,
            stroke: Arc::clone(&stroke),
            used: tick,
        });
        budget.add(stroke.bytes());
        // Keep the base outline and the most recently drawn finer ones.
        while inner.slots.iter().filter(|s| s.level > 0).count() > FINE_LEVELS {
            let Some(oldest) = inner
                .slots
                .iter()
                .enumerate()
                .filter(|(_, s)| s.level > 0)
                .min_by_key(|(_, s)| s.used)
                .map(|(i, _)| i)
            else {
                break;
            };
            inner.slots.swap_remove(oldest);
        }
    }
    Ok(Some(stroke))
}

/// Summary of cached stroke outline memory and verb counts across a store.
#[derive(Clone, Copy, Debug, Default)]
pub struct StrokeCacheStats {
    pub ops_total: u32,
    pub ops_cached: u32,
    pub input_verbs: u64,
    pub expanded_verbs: u64,
    pub cached_bytes: u64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::record::{Op, Paint};

    fn style(width: f32, join: u8, cap: u8, dashes: Vec<f32>) -> StrokeStyle {
        StrokeStyle {
            width,
            join,
            cap,
            miter: 4.0,
            dashes,
            dash_offset: 0.0,
        }
    }

    #[test]
    fn unsmoothed_rect_uses_even_odd_stroke_ring() {
        let mut r = Record::empty();
        r.paths.push(PathEntry::Rect {
            w: 100.0,
            h: 60.0,
            radii: [12.0; 4],
            smoothing: 0.0,
        });
        let st = style(2.0, 0, 0, vec![]);
        let cache = StrokeCache::new();
        let glyphs = GlyphStore::default();
        let out = resolve_stroke_outline(
            &r,
            0,
            &st,
            &cache,
            &glyphs,
            &Limits::default(),
            1.0,
            &StrokeBudget::default(),
        )
        .unwrap()
        .unwrap();
        assert!(out.even_odd);
        assert!(!out.path.is_empty());
        // Second call returns the exact same cached Arc.
        let out2 = resolve_stroke_outline(
            &r,
            0,
            &st,
            &cache,
            &glyphs,
            &Limits::default(),
            1.0,
            &StrokeBudget::default(),
        )
        .unwrap()
        .unwrap();
        assert!(Arc::ptr_eq(&out, &out2));
    }

    #[test]
    fn ellipse_and_dashed_strokes_expand_once_and_stay_bounded() {
        let mut r = Record::empty();
        r.paths.push(PathEntry::Ellipse { w: 120.0, h: 80.0 });
        r.paths.push(PathEntry::Rect {
            w: 100.0,
            h: 60.0,
            radii: [12.0; 4],
            smoothing: 0.6,
        });
        let glyphs = GlyphStore::default();
        let c1 = StrokeCache::new();
        let s1 = style(3.0, 1, 1, vec![8.0, 4.0]);
        let e1 = resolve_stroke_outline(
            &r,
            0,
            &s1,
            &c1,
            &glyphs,
            &Limits::default(),
            1.0,
            &StrokeBudget::default(),
        )
        .unwrap()
        .unwrap();
        assert!(!e1.even_odd);
        assert!(!e1.path.is_empty());
        assert!(
            e1.path.len() < 1000,
            "ellipse dashed outline grew too large: {}",
            e1.path.len()
        );

        let c2 = StrokeCache::new();
        let s2 = style(2.0, 0, 0, vec![]);
        let e2 = resolve_stroke_outline(
            &r,
            1,
            &s2,
            &c2,
            &glyphs,
            &Limits::default(),
            1.0,
            &StrokeBudget::default(),
        )
        .unwrap()
        .unwrap();
        assert!(!e2.even_odd);
        assert!(!e2.path.is_empty());
        assert!(
            e2.path.len() < 400,
            "smoothed rect outline grew too large: {}",
            e2.path.len()
        );
    }

    #[test]
    fn huge_stroke_coordinates_stay_finite_and_bounded() {
        let mut r = Record::empty();
        r.paths.push(PathEntry::Ellipse { w: 3.0e38, h: 3.0e38 });
        let st = style(10.0, 0, 0, vec![]);
        let cache = StrokeCache::new();
        let glyphs = GlyphStore::default();
        let out = resolve_stroke_outline(
            &r,
            0,
            &st,
            &cache,
            &glyphs,
            &Limits::default(),
            1.0,
            &StrokeBudget::default(),
        )
        .unwrap()
        .unwrap();
        assert!(out.path.len() < 2000);
        // Ensure Op::Stroke size did not grow Op enum unexpectedly.
        assert!(std::mem::size_of::<Op>() <= 96);
        let _ = Paint::Solid([1.0; 4]);
    }

    /// Points along an outline: eight per segment, where an offset fit drifts most.
    fn outline_samples(outline: &BezPath) -> Vec<kurbo::Point> {
        use kurbo::ParamCurve;
        let mut pts = Vec::new();
        for seg in outline.segments() {
            for k in 0..8 {
                pts.push(seg.eval(f64::from(k) / 8.0));
            }
        }
        pts
    }

    /// Distance from `p` to the ellipse centred at (`a`, `b`) with radii `a` and `b`, by Newton's
    /// method on the angle from the nearest of 64 seeds.
    fn ellipse_distance(p: kurbo::Point, a: f64, b: f64) -> f64 {
        let (x, y) = (p.x - a, p.y - b);
        let at = |t: f64| (a * t.cos() - x, b * t.sin() - y);
        let mut t = (0..64)
            .map(|k| f64::from(k) * std::f64::consts::TAU / 64.0)
            .min_by(|&s, &u| {
                let (d0, d1) = at(s);
                let (e0, e1) = at(u);
                (d0 * d0 + d1 * d1).total_cmp(&(e0 * e0 + e1 * e1))
            })
            .unwrap();
        for _ in 0..12 {
            let (dx, dy) = at(t);
            let (sx, sy) = (-a * t.sin(), b * t.cos());
            let (ax, ay) = (-a * t.cos(), -b * t.sin());
            let g = dx * sx + dy * sy;
            let h = sx * sx + sy * sy + dx * ax + dy * ay;
            if h.abs() < 1e-30 {
                break;
            }
            t -= g / h;
        }
        let (dx, dy) = at(t);
        dx.hypot(dy)
    }

    fn s_curve(span: f64) -> kurbo::CubicBez {
        kurbo::CubicBez::new((0.0, 0.0), (span * 0.7, 0.0), (span * 0.1, span), (span, span))
    }

    #[test]
    fn cached_strokes_stay_accurate_up_to_256x_retina() {
        // A circle's offset is a circle, which kurbo fits at any tolerance; ellipses and curves
        // are what drift (PR #293 review: 3.5 to 16.7 device px at 512x before levels). 512
        // device px per unit is MAX_ZOOM (256x) at Retina 2x. Shapes keep their curvature radius
        // above half the stroke width, so the true edges are offsets with no loops.
        use kurbo::ParamCurveNearest;
        let glyphs = GlyphStore::default();
        let budget = StrokeBudget::default();
        type Dist = Box<dyn Fn(kurbo::Point) -> f64>;
        let mut cases: Vec<(String, Record, f32, Dist)> = Vec::new();
        for &(w, h, sw) in &[
            (400.0f32, 400.0f32, 4.0f32),
            (4000.0, 4000.0, 8.0),
            (200.0, 40.0, 4.0),
            (800.0, 80.0, 6.0),
            (3000.0, 240.0, 12.0),
        ] {
            let mut r = Record::empty();
            r.paths.push(PathEntry::Ellipse { w, h });
            let (a, b) = (f64::from(w) / 2.0, f64::from(h) / 2.0);
            cases.push((
                format!("ellipse {w}x{h}"),
                r,
                sw,
                Box::new(move |p| ellipse_distance(p, a, b)),
            ));
        }
        for &(span, sw) in &[(400.0, 4.0f32), (5000.0, 10.0)] {
            let mut r = Record::empty();
            let curve = s_curve(span);
            let mut bez = BezPath::new();
            bez.move_to(curve.p0);
            bez.curve_to(curve.p1, curve.p2, curve.p3);
            r.paths.push(PathEntry::Path(CompactPath::from_bez(&bez)));
            cases.push((
                format!("S-curve {span}"),
                r,
                sw,
                // Points whose nearest point is an end are on the caps: kurbo draws a round cap as
                // one cubic per quarter (2.7e-4 of the radius off at any tolerance, on main too),
                // which is not what this measures.
                Box::new(move |p| {
                    let n = curve.nearest(p, 1e-12);
                    if n.t <= 1e-9 || n.t >= 1.0 - 1e-9 {
                        f64::NAN
                    } else {
                        n.distance_sq.sqrt()
                    }
                }),
            ));
        }
        for (name, r, sw, distance) in &cases {
            let st = style(*sw, 1, 1, vec![]);
            let cache = StrokeCache::new();
            let half = f64::from(*sw) / 2.0;
            for scale in [1.0, 16.0, 128.0, 512.0] {
                budget.advance();
                let out = resolve_stroke_outline(r, 0, &st, &cache, &glyphs, &Limits::default(), scale, &budget)
                    .unwrap()
                    .unwrap();
                let err = outline_samples(&out.path.to_bez())
                    .into_iter()
                    .map(|p| (distance(p) - half).abs())
                    .filter(|e| e.is_finite())
                    .fold(0.0, f64::max)
                    * scale;
                assert!(
                    err <= 0.5,
                    "{name} at {scale} device px per unit: outline off by {err:.3} device px"
                );
            }
            assert!(
                cache.usage().len() <= 1 + FINE_LEVELS,
                "{name}: {} kept",
                cache.usage().len()
            );
            // Without the finer levels (the base outline drawn at 512x), the same check fails on
            // everything but circles: the drift this guards against.
            if !name.starts_with("ellipse 400x400") && !name.starts_with("ellipse 4000x4000") {
                let base = cache.base().expect("the base outline is kept");
                let err = outline_samples(&base.path.to_bez())
                    .into_iter()
                    .map(|p| (distance(p) - half).abs())
                    .filter(|e| e.is_finite())
                    .fold(0.0, f64::max)
                    * 512.0;
                assert!(
                    err > 0.5,
                    "{name}: the base outline alone is within {err:.3} px at 512x"
                );
            }
        }
    }

    #[test]
    fn the_base_outline_serves_ordinary_scales_and_finer_ones_are_bounded() {
        let glyphs = GlyphStore::default();
        let budget = StrokeBudget::default();
        let mut r = Record::empty();
        r.paths.push(PathEntry::Ellipse { w: 200.0, h: 40.0 });
        let st = style(4.0, 1, 1, vec![]);
        let cache = StrokeCache::new();
        let at = |scale: f64| {
            resolve_stroke_outline(&r, 0, &st, &cache, &glyphs, &Limits::default(), scale, &budget)
                .unwrap()
                .unwrap()
        };
        // 0.025 units is within 0.125 px up to 5 px per unit: one outline up to 250% at Retina.
        let base = at(1.0);
        for scale in [2.0, 4.0, 5.0] {
            assert!(Arc::ptr_eq(&base, &at(scale)), "scale {scale} re-expanded");
        }
        assert_eq!(stroke_level(0.025, 5.0), 0);
        assert_eq!(stroke_level(0.025, 5.1), 1);
        assert_eq!(stroke_level(0.025, 512.0), 7);
        // Zooming in keeps the base and at most two finer levels, the most recently drawn.
        for scale in [20.0, 40.0, 80.0, 160.0, 320.0, 640.0] {
            budget.advance();
            at(scale);
        }
        let levels: Vec<u8> = cache.usage().iter().map(|u| u.2).collect();
        assert_eq!(levels.len(), 3, "{levels:?}");
        assert!(
            levels.contains(&0) && levels.contains(&6) && levels.contains(&7),
            "{levels:?}"
        );
        assert!(Arc::ptr_eq(&base, &at(2.0)), "the base outline is still kept");
        assert_eq!(cache.evict(0), base.bytes());
        assert!(!Arc::ptr_eq(&base, &at(2.0)), "an evicted outline is expanded again");
    }

    #[test]
    fn rings_need_no_finer_levels() {
        let glyphs = GlyphStore::default();
        let budget = StrokeBudget::default();
        let mut r = Record::empty();
        r.paths.push(PathEntry::Rect {
            w: 100.0,
            h: 60.0,
            radii: [12.0; 4],
            smoothing: 0.0,
        });
        let st = style(2.0, 0, 0, vec![]);
        let cache = StrokeCache::new();
        let low = resolve_stroke_outline(&r, 0, &st, &cache, &glyphs, &Limits::default(), 1.0, &budget)
            .unwrap()
            .unwrap();
        let high = resolve_stroke_outline(&r, 0, &st, &cache, &glyphs, &Limits::default(), 512.0, &budget)
            .unwrap()
            .unwrap();
        assert!(low.even_odd && Arc::ptr_eq(&low, &high));
    }
}
