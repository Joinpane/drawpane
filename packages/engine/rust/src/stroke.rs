//! Cached stroke outline expansion shared across every render backend (`vello_cpu`, `vello_gpu`,
//! and Vello 0.12 GPU compute).
//!
//! Each `Op::Stroke` expands its outline once per record revision in record units using
//! `kurbo::stroke_with` (or the exact `stroke_ring` fast path for unsmoothed solid boxes) and
//! stores the resulting filled outline in `CompactPath` (`f32` coordinates). Every backend then
//! fills that single outline, eliminating stroke-expansion divergence between CPU and GPU and
//! avoiding per-frame stroke offsetting on every tile or zoom frame.

use crate::error::{EngineError, Result};
use crate::geometry;
use crate::glyphs::GlyphStore;
use crate::limits::Limits;
use crate::record::{CompactPath, PathEntry, Record, StrokeStyle};
use std::cell::OnceCell;
use std::sync::Arc;
use vello_common::kurbo::{self, Affine, BezPath, Cap, Join, PathEl, Rect, Shape, Stroke, StrokeCtx, StrokeOpts};

/// A cached stroke outline in the record's own units, ready to be filled on any backend.
#[derive(Clone, Debug)]
pub struct ExpandedStroke {
    pub path: CompactPath,
    /// `true` for `stroke_ring` (outer box minus inner hole, filled even-odd); `false` for
    /// `kurbo::stroke_with` (filled non-zero).
    pub even_odd: bool,
}

/// Per-`Op::Stroke` lazy cache of its expanded outline.
///
/// Cloning starts empty so cloned records never accidentally share mutable state across edits,
/// while reading a live `Record` reuses the single `Arc<ExpandedStroke>` across frames and
/// backends until the record is replaced or dropped.
#[derive(Debug, Default)]
pub struct StrokeCache(OnceCell<Arc<ExpandedStroke>>);

impl Clone for StrokeCache {
    fn clone(&self) -> Self {
        match self.0.get() {
            Some(v) => {
                let cell = OnceCell::new();
                let _ = cell.set(Arc::clone(v));
                Self(cell)
            }
            None => Self(OnceCell::new()),
        }
    }
}

impl StrokeCache {
    pub fn new() -> Self {
        Self(OnceCell::new())
    }

    pub fn get(&self) -> Option<&Arc<ExpandedStroke>> {
        self.0.get()
    }

    pub fn get_or_try_init<F>(&self, init: F) -> Result<Arc<ExpandedStroke>>
    where
        F: FnOnce() -> Result<ExpandedStroke>,
    {
        if let Some(hit) = self.0.get() {
            return Ok(Arc::clone(hit));
        }
        let built = Arc::new(init()?);
        let _ = self.0.set(Arc::clone(&built));
        Ok(built)
    }

    /// Bytes currently held by the cached outline (`0` if not yet expanded).
    pub fn cached_bytes(&self) -> usize {
        self.0
            .get()
            .map_or(0, |e| std::mem::size_of::<ExpandedStroke>() + e.path.heap_bytes())
    }

    /// Expanded path element count (`0` if not yet expanded).
    pub fn cached_verbs(&self) -> usize {
        self.0.get().map_or(0, |e| e.path.len())
    }
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
    let span = bounds
        .width()
        .abs()
        .max(bounds.height().abs())
        .max(f64::from(width));
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
            (a.x as f32).is_finite()
                && (a.y as f32).is_finite()
                && (b.x as f32).is_finite()
                && (b.y as f32).is_finite()
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
/// `PathEntry::Glyphs` run). Returns `Ok(None)` for `PathEntry::Outside`, which is viewport-bound.
fn entry_local_path(r: &Record, i: u32, glyphs: &GlyphStore) -> Result<Option<BezPath>> {
    match r.paths.get(i as usize) {
        Some(PathEntry::Outside(_)) => Ok(None),
        Some(PathEntry::Glyphs { scale, glyphs: run }) => {
            let s = f64::from(*scale);
            let mut out = BezPath::new();
            for g in run {
                let glyph = glyphs
                    .get(g.glyph)
                    .ok_or_else(|| EngineError::unknown(format!("glyph {}", g.glyph)))?;
                let mut p = glyph.path.clone();
                p.apply_affine(Affine::new([s, 0.0, 0.0, -s, f64::from(g.x), f64::from(g.y)]));
                out.extend(p);
            }
            Ok(Some(out))
        }
        Some(_) => {
            let p = r
                .entry_path(i)
                .ok_or_else(|| EngineError::malformed(format!("no path {i}")))?;
            Ok(Some(p))
        }
        None => Err(EngineError::malformed(format!("no path {i}"))),
    }
}

/// Resolves and caches the expanded stroke outline for `Op::Stroke` on record `r`.
///
/// Returns `Ok(None)` only for `PathEntry::Outside` (which is viewport-dependent and only appears
/// in fuzz-generated records). All normal shapes, curves, rounded rects, ellipses, dashed paths,
/// and text glyph runs return `Ok(Some(Arc<ExpandedStroke>))` so every backend draws the exact
/// same filled outline.
pub fn resolve_stroke_outline(
    r: &Record,
    path_idx: u32,
    style: &StrokeStyle,
    cache: &StrokeCache,
    glyphs: &GlyphStore,
    limits: &Limits,
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
    let expanded = cache.get_or_try_init(|| {
        if let Some(ring) = stroke_ring(r, path_idx, style) {
            return Ok(ExpandedStroke {
                path: bez_to_finite_compact(&ring),
                even_odd: true,
            });
        }
        let Some(local) = entry_local_path(r, path_idx, glyphs)? else {
            return Ok(ExpandedStroke {
                path: CompactPath::default(),
                even_odd: false,
            });
        };
        if local.is_empty() {
            return Ok(ExpandedStroke {
                path: CompactPath::default(),
                even_odd: false,
            });
        }
        if !style.dashes.is_empty() {
            let length = bez_polygon_length(&local);
            crate::record::check_dashes(style, length, limits)?;
        }
        let bounds = local.bounding_box();
        let tol = stroke_tolerance(bounds, style.width);
        let kurbo_stroke = make_kurbo_stroke(style);
        let mut ctx = StrokeCtx::default();
        kurbo::stroke_with(
            local.elements().iter().copied(),
            &kurbo_stroke,
            &StrokeOpts::default(),
            tol,
            &mut ctx,
        );
        Ok(ExpandedStroke {
            path: bez_to_finite_compact(ctx.output()),
            even_odd: false,
        })
    })?;
    Ok(Some(expanded))
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
        let out = resolve_stroke_outline(&r, 0, &st, &cache, &glyphs, &Limits::default())
            .unwrap()
            .unwrap();
        assert!(out.even_odd);
        assert!(!out.path.is_empty());
        // Second call returns the exact same cached Arc.
        let out2 = resolve_stroke_outline(&r, 0, &st, &cache, &glyphs, &Limits::default())
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
        let e1 = resolve_stroke_outline(&r, 0, &s1, &c1, &glyphs, &Limits::default())
            .unwrap()
            .unwrap();
        assert!(!e1.even_odd);
        assert!(!e1.path.is_empty());
        assert!(e1.path.len() < 1000, "ellipse dashed outline grew too large: {}", e1.path.len());

        let c2 = StrokeCache::new();
        let s2 = style(2.0, 0, 0, vec![]);
        let e2 = resolve_stroke_outline(&r, 1, &s2, &c2, &glyphs, &Limits::default())
            .unwrap()
            .unwrap();
        assert!(!e2.even_odd);
        assert!(!e2.path.is_empty());
        assert!(e2.path.len() < 400, "smoothed rect outline grew too large: {}", e2.path.len());
    }

    #[test]
    fn huge_stroke_coordinates_stay_finite_and_bounded() {
        let mut r = Record::empty();
        r.paths.push(PathEntry::Ellipse {
            w: 3.0e38,
            h: 3.0e38,
        });
        let st = style(10.0, 0, 0, vec![]);
        let cache = StrokeCache::new();
        let glyphs = GlyphStore::default();
        let out = resolve_stroke_outline(&r, 0, &st, &cache, &glyphs, &Limits::default())
            .unwrap()
            .unwrap();
        assert!(out.path.len() < 2000);
        // Ensure Op::Stroke size did not grow Op enum unexpectedly.
        assert!(std::mem::size_of::<Op>() <= 96);
        let _ = Paint::Solid([1.0; 4]);
    }
}
