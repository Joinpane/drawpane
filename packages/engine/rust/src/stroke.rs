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
use std::borrow::Cow;
use std::cell::{Cell, RefCell};
use std::sync::Arc;
use vello_common::kurbo::{self, Affine, BezPath, Cap, Join, PathEl, Rect, Shape, Stroke, StrokeCtx, StrokeOpts};

/// Device pixels of offset tolerance an outline is expanded at. Half of the 0.25 px upstream
/// vello_common's own stroker targets, because kurbo's offset fits land up to about 2.6 times their tolerance on
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

/// Builds kurbo's `Stroke` descriptor from a record's `StrokeStyle`, without dashes.
pub fn make_kurbo_stroke_undashed(style: &StrokeStyle) -> Stroke {
    Stroke::new(f64::from(style.width))
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
        .with_miter_limit(f64::from(style.miter.max(1.0)))
}

/// Builds kurbo's `Stroke` descriptor from a record's `StrokeStyle`.
pub fn make_kurbo_stroke(style: &StrokeStyle) -> Stroke {
    let mut s = make_kurbo_stroke_undashed(style);
    if !style.dashes.is_empty() {
        s = s.with_dashes(f64::from(style.dash_offset), style.dashes.iter().map(|d| f64::from(*d)));
    }
    s
}

/// Maximum coordinate magnitude or control-polygon segment length allowed to go directly to
/// `kurbo::dash` / `kurbo::stroke_with` without subpath normalization.
///
/// Inside kurbo 0.13.1, `DashIterator` hardcodes `DASH_ACCURACY = 1e-6`, and
/// `ParamCurveArclen::inv_arclen` passes `epsilon = DASH_ACCURACY / total_arclen` to
/// `solve_itp_fallible` on `[0, 1]`, which shifts `1u64 << nmax` with
/// `nmax = 1 + ceil(log2(total_arclen / 1e-6)) - 1`. That shift overflows at `nmax >= 64`
/// (`total_arclen > 9.22e12`), and the ITP loop `while b - a > 2.0 * epsilon` can stagnate once
/// `2.0 * epsilon <= f64::EPSILON` (`total_arclen >= 9.0e9`).
///
/// In addition, `CubicBez::subsegment(t..1.0)` evaluates `self.eval(t)` in absolute coordinates,
/// so even a short curve placed at large coordinates `M` (for example `1e30`) picks up roughly
/// `M * f64::EPSILON` of cancellation error in its endpoints, inflating `subsegment.arclen` past
/// the shift-overflow threshold.
///
/// Bounding both coordinate magnitude and segment polygon length by `1e6` keeps cancellation
/// error around `1e-9 << DASH_ACCURACY`, keeps `total_arclen / DASH_ACCURACY <= 1e12 < 2^40`
/// (`nmax <= 40`, well below 50 and 64), and keeps `2.0 * epsilon >= 2e-12 >> f64::EPSILON`.
/// Ordinary drawings sit well below `1e6`, so they take the unmodified fast path and stay
/// byte-identical.
const SAFE_DASH_EXTENT: f64 = 1e6;

/// Target extent when downscaling an oversized subpath before `kurbo::dash`. Using `1e5` leaves
/// 10x headroom below `SAFE_DASH_EXTENT` (`total_arclen / DASH_ACCURACY <= 1e11 < 2^37`).
const NORM_DASH_EXTENT: f64 = 1e5;

/// Returns `true` if `path` has any coordinate or segment control-polygon length outside
/// `SAFE_DASH_EXTENT` (or non-finite), meaning it must be normalized per subpath before dashing.
pub fn needs_safe_dash(path: &BezPath) -> bool {
    let pt_unsafe = |pt: kurbo::Point| {
        !pt.x.is_finite() || !pt.y.is_finite() || pt.x.abs() > SAFE_DASH_EXTENT || pt.y.abs() > SAFE_DASH_EXTENT
    };
    let mut last: Option<kurbo::Point> = None;
    let mut start: Option<kurbo::Point> = None;
    for el in path.elements() {
        match *el {
            PathEl::MoveTo(a) => {
                if pt_unsafe(a) {
                    return true;
                }
                last = Some(a);
                start = Some(a);
            }
            PathEl::LineTo(a) => {
                if pt_unsafe(a) {
                    return true;
                }
                if let Some(l) = last {
                    let len = (a.x - l.x).hypot(a.y - l.y);
                    if !len.is_finite() || len > SAFE_DASH_EXTENT {
                        return true;
                    }
                }
                last = Some(a);
            }
            PathEl::QuadTo(a, b) => {
                if pt_unsafe(a) || pt_unsafe(b) {
                    return true;
                }
                let mut len = (b.x - a.x).hypot(b.y - a.y);
                if let Some(l) = last {
                    len += (a.x - l.x).hypot(a.y - l.y);
                }
                if !len.is_finite() || len > SAFE_DASH_EXTENT {
                    return true;
                }
                last = Some(b);
            }
            PathEl::CurveTo(a, b, c) => {
                if pt_unsafe(a) || pt_unsafe(b) || pt_unsafe(c) {
                    return true;
                }
                let mut len = (b.x - a.x).hypot(b.y - a.y) + (c.x - b.x).hypot(c.y - b.y);
                if let Some(l) = last {
                    len += (a.x - l.x).hypot(a.y - l.y);
                }
                if !len.is_finite() || len > SAFE_DASH_EXTENT {
                    return true;
                }
                last = Some(c);
            }
            PathEl::ClosePath => {
                if let (Some(l), Some(s)) = (last, start) {
                    let len = (s.x - l.x).hypot(s.y - l.y);
                    if !len.is_finite() || len > SAFE_DASH_EXTENT {
                        return true;
                    }
                }
                last = start;
            }
        }
    }
    false
}

fn map_path_el(el: PathEl, mut f: impl FnMut(kurbo::Point) -> kurbo::Point) -> PathEl {
    match el {
        PathEl::MoveTo(a) => PathEl::MoveTo(f(a)),
        PathEl::LineTo(a) => PathEl::LineTo(f(a)),
        PathEl::QuadTo(a, b) => PathEl::QuadTo(f(a), f(b)),
        PathEl::CurveTo(a, b, c) => PathEl::CurveTo(f(a), f(b), f(c)),
        PathEl::ClosePath => PathEl::ClosePath,
    }
}

/// Applies `style`'s dash pattern to `path` subpath-by-subpath, translating each far-offset
/// subpath to its midpoint and downscaling oversized subpaths into
/// `[-NORM_DASH_EXTENT, NORM_DASH_EXTENT]` before calling `kurbo::dash`.
///
/// Fallback order when a subpath exceeds `SAFE_DASH_EXTENT`:
/// 1. Translate and scale down so dash tolerance scales proportionally to curve extent.
/// 2. If scaled dashes underflow or become non-finite, keep that subpath undashed (solid).
/// 3. If dashing exceeds the frame verb budget, return `EngineError::limit`.
pub fn dash_path_safely(path: &BezPath, style: &StrokeStyle, limits: &Limits) -> Result<BezPath> {
    let els = path.elements();
    if els.is_empty() || style.dashes.is_empty() {
        return Ok(path.clone());
    }
    if !style.dash_offset.is_finite() || style.dashes.iter().any(|d| !d.is_finite() || *d < 0.0) {
        return Ok(path.clone());
    }
    let sum: f64 = style.dashes.iter().map(|d| f64::from(*d)).sum();
    let full_period = if style.dashes.len() % 2 == 1 { 2.0 * sum } else { sum };
    if !full_period.is_finite() || full_period <= 0.0 {
        return Ok(path.clone());
    }
    let norm_offset = f64::from(style.dash_offset).rem_euclid(full_period);
    if !norm_offset.is_finite() {
        return Ok(path.clone());
    }

    let max_els = limits.frame_verbs.saturating_mul(4).saturating_add(els.len()).max(1024);
    let mut out = BezPath::new();
    let mut emitted = 0usize;
    let mut norm_sub = Vec::new();
    let mut scaled_dashes = Vec::with_capacity(style.dashes.len());

    let mut i = 0usize;
    while i < els.len() {
        if !matches!(els[i], PathEl::MoveTo(_)) {
            i += 1;
            continue;
        }
        let start_idx = i;
        i += 1;
        while i < els.len() && !matches!(els[i], PathEl::MoveTo(_)) {
            i += 1;
        }
        let sub = &els[start_idx..i];

        let mut min_x = f64::INFINITY;
        let mut max_x = f64::NEG_INFINITY;
        let mut min_y = f64::INFINITY;
        let mut max_y = f64::NEG_INFINITY;
        let mut all_finite = true;
        let mut visit_pt = |pt: kurbo::Point| {
            if !pt.x.is_finite() || !pt.y.is_finite() {
                all_finite = false;
                return;
            }
            min_x = min_x.min(pt.x);
            max_x = max_x.max(pt.x);
            min_y = min_y.min(pt.y);
            max_y = max_y.max(pt.y);
        };
        for el in sub {
            match *el {
                PathEl::MoveTo(a) | PathEl::LineTo(a) => visit_pt(a),
                PathEl::QuadTo(a, b) => {
                    visit_pt(a);
                    visit_pt(b);
                }
                PathEl::CurveTo(a, b, c) => {
                    visit_pt(a);
                    visit_pt(b);
                    visit_pt(c);
                }
                PathEl::ClosePath => {}
            }
        }
        if !all_finite || !min_x.is_finite() || !max_x.is_finite() || !min_y.is_finite() || !max_y.is_finite() {
            emitted = emitted.saturating_add(sub.len());
            if emitted > max_els {
                return Err(EngineError::limit("a stroke exceeds the frame geometry budget"));
            }
            out.extend(sub.iter().copied());
            continue;
        }

        let raw_max_abs = min_x.abs().max(max_x.abs()).max(min_y.abs()).max(max_y.abs());
        let origin = if raw_max_abs <= SAFE_DASH_EXTENT {
            kurbo::Point::ORIGIN
        } else {
            kurbo::Point::new(0.5 * min_x + 0.5 * max_x, 0.5 * min_y + 0.5 * max_y)
        };
        let shift = |pt: kurbo::Point| kurbo::Point::new(pt.x - origin.x, pt.y - origin.y);
        let mut max_abs = 0.0f64;
        let mut max_seg_len = 0.0f64;
        let mut sub_len = 0.0f64;
        let mut last = kurbo::Point::ORIGIN;
        let mut start = kurbo::Point::ORIGIN;
        let mut track = |pt: kurbo::Point| {
            max_abs = max_abs.max(pt.x.abs()).max(pt.y.abs());
        };
        for el in sub {
            match *el {
                PathEl::MoveTo(a) => {
                    let a = shift(a);
                    track(a);
                    last = a;
                    start = a;
                }
                PathEl::LineTo(a) => {
                    let a = shift(a);
                    track(a);
                    let len = (a.x - last.x).hypot(a.y - last.y);
                    max_seg_len = max_seg_len.max(len);
                    sub_len += len;
                    last = a;
                }
                PathEl::QuadTo(a, b) => {
                    let (a, b) = (shift(a), shift(b));
                    track(a);
                    track(b);
                    let len = (a.x - last.x).hypot(a.y - last.y) + (b.x - a.x).hypot(b.y - a.y);
                    max_seg_len = max_seg_len.max(len);
                    sub_len += len;
                    last = b;
                }
                PathEl::CurveTo(a, b, c) => {
                    let (a, b, c) = (shift(a), shift(b), shift(c));
                    track(a);
                    track(b);
                    track(c);
                    let len = (a.x - last.x).hypot(a.y - last.y)
                        + (b.x - a.x).hypot(b.y - a.y)
                        + (c.x - b.x).hypot(c.y - b.y);
                    max_seg_len = max_seg_len.max(len);
                    sub_len += len;
                    last = c;
                }
                PathEl::ClosePath => {
                    let len = (start.x - last.x).hypot(start.y - last.y);
                    max_seg_len = max_seg_len.max(len);
                    sub_len += len;
                    last = start;
                }
            }
        }
        let extent = max_abs.max(max_seg_len);
        if !extent.is_finite() || !sub_len.is_finite() {
            emitted = emitted.saturating_add(sub.len());
            if emitted > max_els {
                return Err(EngineError::limit("a stroke exceeds the frame geometry budget"));
            }
            out.extend(sub.iter().copied());
            continue;
        }

        let (scale, inv_scale) = if extent > SAFE_DASH_EXTENT {
            (NORM_DASH_EXTENT / extent, extent / NORM_DASH_EXTENT)
        } else {
            (1.0, 1.0)
        };
        scaled_dashes.clear();
        scaled_dashes.extend(style.dashes.iter().map(|d| f64::from(*d) * scale));
        let scaled_sum: f64 = scaled_dashes.iter().sum();
        let scaled_offset = norm_offset * scale;
        let scaled_sub_len = sub_len * scale;
        let scaled_pieces = if scaled_sub_len > 0.0 {
            scaled_sub_len / scaled_sum * scaled_dashes.len() as f64
        } else {
            0.0
        };
        let can_dash = scale.is_finite()
            && scale > 0.0
            && inv_scale.is_finite()
            && inv_scale > 0.0
            && scaled_sum.is_finite()
            && scaled_sum > 0.0
            && scaled_offset.is_finite()
            && scaled_dashes.iter().all(|d| d.is_finite() && *d >= 0.0)
            && scaled_pieces.is_finite()
            && scaled_pieces <= limits.frame_verbs as f64
            && (scaled_sub_len == 0.0 || scaled_sub_len / scaled_sum < 1e12);
        if !can_dash {
            emitted = emitted.saturating_add(sub.len());
            if emitted > max_els {
                return Err(EngineError::limit("a stroke exceeds the frame geometry budget"));
            }
            out.extend(sub.iter().copied());
            continue;
        }

        norm_sub.clear();
        norm_sub.reserve(sub.len());
        if scale == 1.0 {
            if origin == kurbo::Point::ORIGIN {
                norm_sub.extend_from_slice(sub);
            } else {
                norm_sub.extend(sub.iter().map(|&el| map_path_el(el, shift)));
            }
        } else {
            norm_sub.extend(sub.iter().map(|&el| {
                map_path_el(el, |pt| {
                    kurbo::Point::new((pt.x - origin.x) * scale, (pt.y - origin.y) * scale)
                })
            }));
        }
        for el in kurbo::dash(norm_sub.iter().copied(), scaled_offset, &scaled_dashes) {
            emitted += 1;
            if emitted > max_els {
                return Err(EngineError::limit("a stroke exceeds the frame geometry budget"));
            }
            let restored = if scale == 1.0 {
                if origin == kurbo::Point::ORIGIN {
                    el
                } else {
                    map_path_el(el, |pt| kurbo::Point::new(pt.x + origin.x, pt.y + origin.y))
                }
            } else {
                map_path_el(el, |pt| {
                    kurbo::Point::new(pt.x * inv_scale + origin.x, pt.y * inv_scale + origin.y)
                })
            };
            out.push(restored);
        }
    }
    Ok(out)
}

/// Prepares `(path, stroke)` for `kurbo::stroke_with` or `scene.stroke_path`. Normal dashed
/// strokes borrow `path` unmodified (byte-identical fast path). Oversized or far-offset dashed
/// paths are pre-dashed via `dash_path_safely` and paired with an undashed `Stroke`.
pub fn prepare_dashed_stroke<'a>(
    path: &'a BezPath,
    style: &StrokeStyle,
    limits: &Limits,
) -> Result<(Cow<'a, BezPath>, Stroke)> {
    if style.dashes.is_empty() || !needs_safe_dash(path) {
        return Ok((Cow::Borrowed(path), make_kurbo_stroke(style)));
    }
    let dashed = dash_path_safely(path, style, limits)?;
    Ok((Cow::Owned(dashed), make_kurbo_stroke_undashed(style)))
}

/// Record-space expansion tolerance for `kurbo::stroke_with`.
///
/// - For normal UI shapes and glyphs (`span <= 2500`), uses up to `0.025` units (10x finer than
///   upstream vello_common's 0.25 px flatten tolerance at 1x, 5x finer at Retina 2x, and
///   proportional for tiny shapes).
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
            let (stroke_path, kurbo_stroke) = prepare_dashed_stroke(&local, style, limits)?;
            let tol = stroke_tolerance(local.bounding_box(), style.width);
            let level = stroke_level(tol, scale);
            let mut ctx = StrokeCtx::default();
            kurbo::stroke_with(
                stroke_path.elements().iter().copied(),
                &kurbo_stroke,
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

    #[test]
    fn dashed_curve_at_extreme_offset_does_not_overflow_inv_arclen() {
        // Reduced from FUZZ_SEED=1795567103465747915 (issue #361): a short glyph cubic placed at
        // x = 1e30. Without subpath translation, CubicBez::subsegment(t..1.0) picks up ~1e30 *
        // f64::EPSILON (~2e14) of cancellation error, pushing solve_itp_fallible's nmax >= 64.
        let mut bez = BezPath::new();
        bez.move_to((1.0e30, 9.39976692199707));
        bez.curve_to(
            (1.0e30, 0.9851184487342834),
            (1.0e30, -4.6246472001075745),
            (1.0e30, -10.234412848949432),
        );
        let mut r = Record::empty();
        r.paths.push(PathEntry::Path(CompactPath::from_bez(&bez)));
        let st = StrokeStyle {
            width: 4.282675,
            join: 0,
            cap: 0,
            miter: 10.0,
            dashes: vec![4.7269444, 3.1771529],
            dash_offset: 0.0,
        };
        let out = resolve_stroke_outline(
            &r,
            0,
            &st,
            &StrokeCache::new(),
            &GlyphStore::default(),
            &Limits::default(),
            1.0,
            &StrokeBudget::default(),
        )
        .unwrap()
        .unwrap();
        assert!(!out.path.is_empty());
        assert!(out.path.coords().iter().all(|c| c.is_finite()));

        // Also test the exact GlyphRun form from the fuzz seed (mix of normal and far-offset glyphs).
        let mut glyphs = GlyphStore::default();
        let mut g = BezPath::new();
        g.move_to((0.0, 0.0));
        g.line_to((500.0, 0.0));
        g.curve_to((540.0, 300.0), (540.0, 500.0), (500.0, 700.0));
        g.line_to((0.0, 700.0));
        g.close_path();
        glyphs.define(2, g, &Limits::default()).unwrap();
        let mut r_glyphs = Record::empty();
        r_glyphs.paths.push(PathEntry::Glyphs {
            scale: 0.028048828,
            glyphs: vec![
                crate::record::GlyphInstance {
                    glyph: 2,
                    x: 0.0,
                    y: 9.399767,
                },
                crate::record::GlyphInstance {
                    glyph: 2,
                    x: 1.0e30,
                    y: 9.399767,
                },
            ],
        });
        let out_g = resolve_stroke_outline(
            &r_glyphs,
            0,
            &st,
            &StrokeCache::new(),
            &glyphs,
            &Limits::default(),
            1.0,
            &StrokeBudget::default(),
        )
        .unwrap()
        .unwrap();
        assert!(!out_g.path.is_empty());
        assert!(out_g.path.coords().iter().all(|c| c.is_finite()));
    }

    #[test]
    fn huge_dashed_curves_never_panic_or_hang() {
        let glyphs = GlyphStore::default();
        let budget = StrokeBudget::default();
        // Covers the ITP float-stagnation range (1e10..1e11), the u64 shift-overflow range
        // (1e15..1e30), and near-f32::MAX (1e38), with even/odd dash counts and huge offsets.
        for &(span, dash, offset) in &[
            (1.0e10f32, 2.0e9f32, 0.0f32),
            (1.0e11, 2.0e10, 5.0e9),
            (1.0e15, 2.0e14, -1.0e20),
            (1.0e30, 2.0e29, 1.0e38),
            (1.0e38, 2.0e37, -1.0e38),
        ] {
            // Cubic S-curve.
            let mut bez = BezPath::new();
            let s = f64::from(span);
            bez.move_to((0.0, 0.0));
            bez.curve_to((s * 0.3, s * 0.8), (s * 0.7, -s * 0.8), (s, 0.0));
            // Quadratic curve in a second subpath.
            bez.move_to((0.0, s * 0.1));
            bez.quad_to((s * 0.5, s * 0.9), (s, s * 0.1));

            let mut r = Record::empty();
            r.paths.push(PathEntry::Path(CompactPath::from_bez(&bez)));
            for dashes in [vec![dash, dash * 0.5], vec![dash]] {
                let st = StrokeStyle {
                    width: (span * 0.01).max(1.0),
                    join: 1,
                    cap: 1,
                    miter: 4.0,
                    dashes,
                    dash_offset: offset,
                };
                let out = resolve_stroke_outline(
                    &r,
                    0,
                    &st,
                    &StrokeCache::new(),
                    &glyphs,
                    &Limits::default(),
                    1.0,
                    &budget,
                )
                .unwrap()
                .unwrap();
                assert!(out.path.coords().iter().all(|c| c.is_finite()));
            }
        }
    }

    #[test]
    fn scaled_huge_dashed_ellipse_matches_normal_dashed_ellipse() {
        let glyphs = GlyphStore::default();
        let budget = StrokeBudget::default();

        // Normal size: fast path (unmodified kurbo::stroke_with).
        let mut r_small = Record::empty();
        r_small.paths.push(PathEntry::Ellipse { w: 200.0, h: 100.0 });
        let st_small = style(4.0, 1, 1, vec![20.0, 10.0]);
        let small = resolve_stroke_outline(
            &r_small,
            0,
            &st_small,
            &StrokeCache::new(),
            &glyphs,
            &Limits::default(),
            1.0,
            &budget,
        )
        .unwrap()
        .unwrap();

        // 10,000x larger: exceeds SAFE_DASH_EXTENT (1e6), so takes the normalized dash path.
        let k = 10_000.0f32;
        let mut r_big = Record::empty();
        r_big.paths.push(PathEntry::Ellipse {
            w: 200.0 * k,
            h: 100.0 * k,
        });
        let st_big = style(4.0 * k, 1, 1, vec![20.0 * k, 10.0 * k]);
        let big = resolve_stroke_outline(
            &r_big,
            0,
            &st_big,
            &StrokeCache::new(),
            &glyphs,
            &Limits::default(),
            1.0 / f64::from(k),
            &budget,
        )
        .unwrap()
        .unwrap();

        let small_moves = small.path.verbs().iter().filter(|&&v| v == 0).count();
        let big_moves = big.path.verbs().iter().filter(|&&v| v == 0).count();
        assert_eq!(small_moves, big_moves, "dash count changed after scaling");
        assert!(small_moves > 4, "expected multiple dashes, got {small_moves}");

        // Bounding boxes match closely after scaling back down.
        let sb = small.path.bounds().unwrap();
        let bb = big.path.bounds().unwrap();
        let inv = 1.0 / f64::from(k);
        assert!((sb.x0 - bb.x0 * inv).abs() < 0.25);
        assert!((sb.y0 - bb.y0 * inv).abs() < 0.25);
        assert!((sb.x1 - bb.x1 * inv).abs() < 0.25);
        assert!((sb.y1 - bb.y1 * inv).abs() < 0.25);
    }

    #[test]
    fn normal_dashed_strokes_are_byte_identical_to_kurbo() {
        let glyphs = GlyphStore::default();
        let budget = StrokeBudget::default();

        let mut s_bez = BezPath::new();
        let c = s_curve(160.0);
        s_bez.move_to(c.p0);
        s_bez.curve_to(c.p1, c.p2, c.p3);
        s_bez.move_to((10.0, 120.0));
        s_bez.quad_to((80.0, 20.0), (150.0, 120.0));

        let cases: Vec<(PathEntry, StrokeStyle)> = vec![
            (
                PathEntry::Ellipse { w: 120.0, h: 80.0 },
                StrokeStyle {
                    width: 3.0,
                    join: 1,
                    cap: 1,
                    miter: 4.0,
                    dashes: vec![8.0, 4.0],
                    dash_offset: 2.5,
                },
            ),
            (
                PathEntry::Rect {
                    w: 100.0,
                    h: 60.0,
                    radii: [12.0; 4],
                    smoothing: 0.5,
                },
                StrokeStyle {
                    width: 2.0,
                    join: 0,
                    cap: 2,
                    miter: 4.0,
                    dashes: vec![10.0, 3.0, 4.0],
                    dash_offset: -7.0,
                },
            ),
            (
                PathEntry::Path(CompactPath::from_bez(&s_bez)),
                StrokeStyle {
                    width: 5.0,
                    join: 2,
                    cap: 0,
                    miter: 4.0,
                    dashes: vec![12.0, 6.0],
                    dash_offset: 0.0,
                },
            ),
        ];

        for (entry, st) in cases {
            let mut r = Record::empty();
            r.paths.push(entry);
            let local = r.entry_path(0).unwrap();
            assert!(!needs_safe_dash(&local));

            let actual = resolve_stroke_outline(
                &r,
                0,
                &st,
                &StrokeCache::new(),
                &glyphs,
                &Limits::default(),
                1.0,
                &budget,
            )
            .unwrap()
            .unwrap();

            let tol = stroke_tolerance(local.bounding_box(), st.width);
            let level = stroke_level(tol, 1.0);
            let mut ctx = StrokeCtx::default();
            kurbo::stroke_with(
                local.elements().iter().copied(),
                &make_kurbo_stroke(&st),
                &StrokeOpts::default(),
                tol / f64::from(1u32 << level),
                &mut ctx,
            );
            let expected = bez_to_finite_compact(ctx.output());

            assert_eq!(actual.path.verbs(), expected.verbs());
            assert_eq!(actual.path.coords(), expected.coords());
        }
    }
}
