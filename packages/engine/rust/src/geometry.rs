//! Shapes the engine generates itself, so every backend and every use of a shape (fill, stroke,
//! clip, and later shadow and glass distance) draws the same curve (decision 0040, "Corner
//! smoothing").

use vello_common::kurbo::{BezPath, Ellipse, Point, Rect, Shape};

/// The canvas's tolerance for turning arcs into curves is far finer than a pixel; kurbo's
/// default (0.1) is a tenth of a unit, which at high zoom shows. Shapes are generated at this.
const TOLERANCE: f64 = 1e-3;

/// The tolerance for an arc of radius `r`: `TOLERANCE` up to a radius of 100,000 units, then a
/// hundred-millionth of the radius, so an arc is at most about 22 cubics a quarter however large
/// it is (kurbo's count grows with the sixth root of radius over tolerance).
pub fn tolerance(r: f64) -> f64 {
    (r.abs() * 1e-8).max(TOLERANCE)
}

/// A box `w` × `h` with corner radii (top left, top right, bottom right, bottom left), each kept
/// to half the shorter side, as the canvas renderer keeps them (`render.ts`, `#buildShape`).
/// Without radii it is the plain box path (`rect()`), which strokes even at zero height.
///
/// `smoothing` (Figma's corner smoothing, squircles) is refused before it gets here
/// (`record::decode`): its curve is the shared geometry function another change adds, with test
/// vectors; it plugs in here so that every backend uses the one generator.
pub fn rounded_rect(w: f32, h: f32, radii: [f32; 4], smoothing: f32) -> BezPath {
    debug_assert!(smoothing == 0.0, "corner smoothing is refused at decode");
    let (w, h) = (f64::from(w), f64::from(h));
    let max = (w.abs().min(h.abs()) / 2.0).max(0.0);
    let [tl, tr, br, bl] = radii.map(|r| f64::from(r).clamp(0.0, max));
    let mut p = BezPath::new();
    if tl == 0.0 && tr == 0.0 && br == 0.0 && bl == 0.0 {
        p.move_to((0.0, 0.0));
        p.line_to((w, 0.0));
        p.line_to((w, h));
        p.line_to((0.0, h));
        p.close_path();
        return p;
    }
    // Clockwise from the top edge, as the canvas's roundRect: each corner a quarter circle.
    let quarter = |p: &mut BezPath, c: Point, r: f64, start: f64| {
        if r <= 0.0 {
            p.line_to(c);
            return;
        }
        let arc = vello_common::kurbo::Arc::new(c, (r, r), start, core::f64::consts::FRAC_PI_2, 0.0);
        arc.to_cubic_beziers(tolerance(r), |a, b, e| p.curve_to(a, b, e));
    };
    use core::f64::consts::{FRAC_PI_2, PI};
    p.move_to((tl, 0.0));
    p.line_to((w - tr, 0.0));
    if tr > 0.0 {
        quarter(&mut p, Point::new(w - tr, tr), tr, -FRAC_PI_2);
    }
    p.line_to((w, h - br));
    if br > 0.0 {
        quarter(&mut p, Point::new(w - br, h - br), br, 0.0);
    }
    p.line_to((bl, h));
    if bl > 0.0 {
        quarter(&mut p, Point::new(bl, h - bl), bl, FRAC_PI_2);
    }
    p.line_to((0.0, tl));
    if tl > 0.0 {
        quarter(&mut p, Point::new(tl, tl), tl, PI);
    }
    p.close_path();
    p
}

/// The ellipse inscribed in a `w` × `h` box, from its rightmost point, clockwise (the canvas's
/// `ellipse(w/2, h/2, w/2, h/2, 0, 0, 2π)`).
pub fn ellipse(w: f32, h: f32) -> BezPath {
    let (w, h) = (f64::from(w), f64::from(h));
    Ellipse::new((w / 2.0, h / 2.0), (w.abs() / 2.0, h.abs() / 2.0), 0.0).to_path(tolerance(w.abs().max(h.abs()) / 2.0))
}

/// A box as a path, clockwise.
pub fn rect_path(r: Rect) -> BezPath {
    let mut p = BezPath::new();
    p.move_to((r.x0, r.y0));
    p.line_to((r.x1, r.y0));
    p.line_to((r.x1, r.y1));
    p.line_to((r.x0, r.y1));
    p.close_path();
    p
}

#[cfg(test)]
mod tests {
    use super::*;
    use vello_common::kurbo::{ParamCurve, Shape};

    #[test]
    fn radii_are_kept_to_half_the_shorter_side() {
        let p = rounded_rect(100.0, 20.0, [50.0, 0.0, 0.0, 0.0], 0.0);
        let b = p.bounding_box();
        assert!((b.width() - 100.0).abs() < 1e-9 && (b.height() - 20.0).abs() < 1e-9);
        // The top left corner is a quarter circle of radius 10: it passes (10, 0) and (0, 10).
        assert!(
            p.segments()
                .any(|s| (s.start().x - 10.0).abs() < 1e-9 && s.start().y.abs() < 1e-9)
        );
    }

    #[test]
    fn huge_curves_stay_a_few_cubics() {
        // At the canvas's fixed tolerance an ellipse this size would be millions of cubics.
        assert!(ellipse(3.0e38, 3.0e38).elements().len() < 128);
        assert!(rounded_rect(3.0e38, 3.0e38, [1.0e38; 4], 0.0).elements().len() < 128);
        // A normal one keeps the canvas's precision.
        assert!(ellipse(100.0, 100.0).elements().len() >= 5);
    }

    #[test]
    fn a_plain_box_is_four_lines() {
        assert_eq!(rounded_rect(10.0, 0.0, [0.0; 4], 0.0).elements().len(), 5);
    }
}
