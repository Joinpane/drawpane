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

/// Each corner's share of the sides it's on, as `corner-geometry.ts`'s `fitCorners` cuts radii
/// (Figma's rule): a radius is cut to its share of each side against the corner at the side's
/// other end, so a uniform radius gets half the shorter side and one large corner beside square
/// ones can reach further. Negative and non-finite radii count as 0.
pub fn fit_radii(w: f64, h: f64, radii: [f64; 4]) -> [f64; 4] {
    let ok = |v: f64| if v > 0.0 && v.is_finite() { v } else { 0.0 };
    let (w, h) = (ok(w), ok(h));
    let [tl, tr, br, bl] = radii.map(ok);
    let share = |r: f64, other: f64, length: f64| {
        let sum = r + other;
        if sum > 0.0 { length * r / sum } else { 0.0 }
    };
    let fit = |r: f64, along_x: f64, along_y: f64| {
        if r <= 0.0 {
            return 0.0;
        }
        r.min(share(r, along_x, w).min(share(r, along_y, h))).max(0.0)
    };
    [fit(tl, tr, bl), fit(tr, tl, br), fit(br, bl, tr), fit(bl, br, tl)]
}

/// A box `w` × `h` with corner radii (top left, top right, bottom right, bottom left), each cut to
/// its share of its sides (`fit_radii`), as the canvas renderer cuts them (`corners.ts`).
/// Without radii it is the plain box path (`rect()`), which strokes even at zero height.
///
/// `smoothing` (Figma's corner smoothing, squircles) is refused before it gets here
/// (`record::decode`): its curve is the shared geometry function another change adds, with test
/// vectors; it plugs in here so that every backend uses the one generator.
pub fn rounded_rect(w: f32, h: f32, radii: [f32; 4], smoothing: f32) -> BezPath {
    debug_assert!(smoothing == 0.0, "corner smoothing is refused at decode");
    let (w, h) = (f64::from(w), f64::from(h));
    let [tl, tr, br, bl] = fit_radii(w.abs(), h.abs(), radii.map(f64::from));
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
    fn a_lone_corner_takes_its_share_of_the_sides() {
        let p = rounded_rect(100.0, 20.0, [50.0, 0.0, 0.0, 0.0], 0.0);
        let b = p.bounding_box();
        assert!((b.width() - 100.0).abs() < 1e-9 && (b.height() - 20.0).abs() < 1e-9);
        // Beside square corners it may take the whole short side: a quarter circle of radius 20,
        // from (20, 0) to (0, 20).
        assert!(
            p.segments()
                .any(|s| (s.start().x - 20.0).abs() < 1e-9 && s.start().y.abs() < 1e-9)
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
    fn radii_are_fitted_as_corners_ts_fits_them() {
        // One big corner beside square ones reaches past half the shorter side (Figma's rule).
        assert_eq!(
            fit_radii(160.0, 100.0, [200.0, 0.0, 200.0, 0.0]),
            [100.0, 0.0, 100.0, 0.0]
        );
        // A uniform radius gets half the shorter side.
        assert_eq!(fit_radii(100.0, 40.0, [50.0; 4]), [20.0; 4]);
        assert_eq!(fit_radii(100.0, 40.0, [-3.0, f64::NAN, 5.0, 0.0]), [0.0, 0.0, 5.0, 0.0]);
    }

    #[test]
    fn a_plain_box_is_four_lines() {
        assert_eq!(rounded_rect(10.0, 0.0, [0.0; 4], 0.0).elements().len(), 5);
    }
}
