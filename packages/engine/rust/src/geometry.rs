//! Shapes the engine generates itself, so every backend and every use of a shape (fill, stroke,
//! clip, and later shadow and glass distance) draws the same curve (decision 0040, "Corner
//! smoothing").
//!
//! `fit_corners`, `corner_cubics` and `box_commands` are direct ports of
//! `packages/editor/src/corner-geometry.ts` (decision 0041) and are verified against all 455
//! Figma-checked vectors in `packages/editor/test/fixtures/corner-vectors.json`.

use core::f64::consts::{PI, SQRT_2};
use vello_common::kurbo::{BezPath, Ellipse, Point, Rect, Shape, Vec2};

/// The canvas's tolerance for turning arcs into curves is far finer than a pixel; kurbo's
/// default (0.1) is a tenth of a unit, which at high zoom shows. Shapes are generated at this.
const TOLERANCE: f64 = 1e-3;

/// The tolerance for an arc of radius `r`: `TOLERANCE` up to a radius of 100,000 units, then a
/// hundred-millionth of the radius, so an arc is at most about 22 cubics a quarter however large
/// it is (kurbo's count grows with the sixth root of radius over tolerance).
pub fn tolerance(r: f64) -> f64 {
    (r.abs() * 1e-8).max(TOLERANCE)
}

/// One corner as drawn, after cutting radius and smoothing to the space its edges allow.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FittedCorner {
    pub radius: f64,
    pub smoothing: f64,
    pub extent: f64,
}

/// One path command of a box outline, matching `corner-geometry.ts`'s `BoxCommand`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum BoxCommand {
    Move(f64, f64),
    Line(f64, f64),
    Cubic(f64, f64, f64, f64, f64, f64),
    Close,
}

fn clamp_unit(v: f64) -> f64 {
    if v > 0.0 { v.min(1.0) } else { 0.0 }
}

fn non_negative(v: f64) -> f64 {
    if v > 0.0 && v.is_finite() { v } else { 0.0 }
}

fn share(r: f64, other: f64, length: f64) -> f64 {
    let sum = r + other;
    if sum > 0.0 { (length * r) / sum } else { 0.0 }
}

/// The corners as drawn on a `w` x `h` box: radii and smoothing cut to the space each has
/// (direct port of `corner-geometry.ts`'s `fitCorners`, Figma's rule).
pub fn fit_corners(w: f64, h: f64, radii: [f64; 4], smoothing: f64) -> [FittedCorner; 4] {
    let w = non_negative(w);
    let h = non_negative(h);
    let [tl, tr, br, bl] = radii.map(non_negative);
    let s = clamp_unit(smoothing);
    let fit = |r: f64, along_x: f64, along_y: f64| -> FittedCorner {
        if r <= 0.0 {
            return FittedCorner {
                radius: 0.0,
                smoothing: 0.0,
                extent: 0.0,
            };
        }
        let budget = share(r, along_x, w).min(share(r, along_y, h));
        let radius = r.min(budget);
        if radius <= 0.0 {
            return FittedCorner {
                radius: 0.0,
                smoothing: 0.0,
                extent: 0.0,
            };
        }
        let smooth = 0.0f64.max(s.min(budget / radius - 1.0));
        FittedCorner {
            radius,
            smoothing: smooth,
            extent: ((1.0 + smooth) * radius).min(budget),
        }
    };
    [fit(tl, tr, bl), fit(tr, tl, br), fit(br, bl, tr), fit(bl, br, tl)]
}

/// Each corner's share of the sides it's on (radius only, smoothing 0).
pub fn fit_radii(w: f64, h: f64, radii: [f64; 4]) -> [f64; 4] {
    let c = fit_corners(w, h, radii, 0.0);
    [c[0].radius, c[1].radius, c[2].radius, c[3].radius]
}

/// One corner's curve, in a frame where the corner is at the origin, `x` is the distance back
/// along the incoming edge and `y` the distance along the outgoing edge: cubics (six numbers
/// each: two controls and an end) from `(extent, 0)` to `(0, extent)`. Empty for a square corner.
pub fn corner_cubics(corner: FittedCorner) -> Vec<f64> {
    let r = corner.radius;
    let s = corner.smoothing;
    let p = corner.extent;
    if r <= 0.0 {
        return Vec::new();
    }
    let deg = PI / 180.0;
    let arc_angle = 90.0 * (1.0 - s);
    let arc_chord = ((arc_angle / 2.0) * deg).sin() * r * SQRT_2;
    let alpha = (90.0 - arc_angle) / 2.0;
    let p3_to_p4 = r * ((alpha / 2.0) * deg).tan();
    let beta = 45.0 * s;
    let c = p3_to_p4 * (beta * deg).cos();
    let d = c * (beta * deg).tan();
    let b = (p - arc_chord - c - d) / 3.0;
    let a = 2.0 * b;
    let mut out = Vec::with_capacity(18);
    let x3 = p - a - b - c;
    let eases = p - x3 > 1e-9 || d > 1e-9;
    if eases {
        out.extend_from_slice(&[p - a, 0.0, p - a - b, 0.0, x3, d]);
    }
    let sweep = arc_angle * deg;
    if sweep > 1e-9 {
        let k = (4.0 / 3.0) * (sweep / 4.0).tan() * r;
        let sx = x3 - r;
        let sy = d - r;
        let ex = d - r;
        let ey = x3 - r;
        let sl = {
            let v = sx.hypot(sy);
            if v == 0.0 { 1.0 } else { v }
        };
        let el = {
            let v = ex.hypot(ey);
            if v == 0.0 { 1.0 } else { v }
        };
        let t0x = sy / sl;
        let t0y = -sx / sl;
        let t1x = ey / el;
        let t1y = -ex / el;
        out.extend_from_slice(&[x3 + t0x * k, d + t0y * k, d - t1x * k, x3 - t1y * k, d, x3]);
    }
    if eases {
        out.extend_from_slice(&[0.0, p - a - b, 0.0, p - a, 0.0, p]);
    }
    out
}

/// The outline of a `w` x `h` box at the origin with these corners, clockwise (direct port of
/// `corner-geometry.ts`'s `boxCommands`).
pub fn box_commands(w: f64, h: f64, radii: [f64; 4], smoothing: f64) -> Vec<BoxCommand> {
    let w = non_negative(w);
    let h = non_negative(h);
    let corners = fit_corners(w, h, radii, smoothing);
    let mut out = Vec::with_capacity(17);
    let frames: [[f64; 6]; 4] = [
        [0.0, 0.0, 0.0, 1.0, 1.0, 0.0],
        [w, 0.0, -1.0, 0.0, 0.0, 1.0],
        [w, h, 0.0, -1.0, -1.0, 0.0],
        [0.0, h, 1.0, 0.0, 0.0, -1.0],
    ];
    for (i, (&corner, &[ox, oy, ux, uy, vx, vy])) in corners.iter().zip(frames.iter()).enumerate() {
        let x = |a: f64, b: f64| ox + ux * a + vx * b;
        let y = |a: f64, b: f64| oy + uy * a + vy * b;
        let e = corner.extent;
        if i == 0 {
            out.push(BoxCommand::Move(x(e, 0.0), y(e, 0.0)));
        } else {
            out.push(BoxCommand::Line(x(e, 0.0), y(e, 0.0)));
        }
        let cubics = corner_cubics(corner);
        for chunk in cubics.as_chunks::<6>().0 {
            out.push(BoxCommand::Cubic(
                x(chunk[0], chunk[1]),
                y(chunk[0], chunk[1]),
                x(chunk[2], chunk[3]),
                y(chunk[2], chunk[3]),
                x(chunk[4], chunk[5]),
                y(chunk[4], chunk[5]),
            ));
        }
    }
    out.push(BoxCommand::Close);
    out
}

/// Appends a quarter-ellipse arc centered at `c`, clockwise in y-down coordinates.
fn push_quarter_arc(p: &mut BezPath, c: Point, rx: f64, ry: f64, start: f64, n: usize) {
    let step = core::f64::consts::FRAC_PI_2 / n as f64;
    let h = (4.0 / 3.0) * (step * 0.25).tan();
    for i in 0..n {
        let a0 = start + step * i as f64;
        let a1 = start + step * (i + 1) as f64;
        let (s0, c0) = a0.sin_cos();
        let (s1, c1) = a1.sin_cos();
        let p1 = Point::new(c.x + rx * (c0 - h * s0), c.y + ry * (s0 + h * c0));
        let p2 = Point::new(c.x + rx * (c1 + h * s1), c.y + ry * (s1 - h * c1));
        let p3 = Point::new(c.x + rx * c1, c.y + ry * s1);
        p.curve_to(p1, p2, p3);
    }
}

/// A box `w` × `h` with corner radii (top left, top right, bottom right, bottom left), each cut to
/// its share of its sides (`fit_radii`), as the canvas renderer cuts them (`corners.ts`).
/// Without radii it is the plain box path (`rect()`), which strokes even at zero height.
/// With smoothing 0 on every fitted corner it uses quarter-circle arcs (matching `roundRect`);
/// with any smoothed corner it uses `box_commands` squircle cubics (matching `corners-canvas.ts`).
pub fn rounded_rect(w: f32, h: f32, radii: [f32; 4], smoothing: f32) -> BezPath {
    let (w, h) = (f64::from(w), f64::from(h));
    let radii64 = radii.map(f64::from);
    let corners = fit_corners(w.abs(), h.abs(), radii64, f64::from(smoothing));
    if corners.iter().any(|c| c.smoothing > 0.0) {
        let mut p = BezPath::new();
        for cmd in box_commands(w.abs(), h.abs(), radii64, f64::from(smoothing)) {
            match cmd {
                BoxCommand::Move(x, y) => p.move_to((x, y)),
                BoxCommand::Line(x, y) => p.line_to((x, y)),
                BoxCommand::Cubic(x1, y1, x2, y2, x3, y3) => {
                    p.curve_to((x1, y1), (x2, y2), (x3, y3));
                }
                BoxCommand::Close => p.close_path(),
            }
        }
        return p;
    }
    rounded_rect_at(
        (0.0, 0.0),
        w,
        h,
        [
            corners[0].radius,
            corners[1].radius,
            corners[2].radius,
            corners[3].radius,
        ],
    )
}

/// A box `w` × `h` with its top left at `origin` and corner radii already fitted (`fit_radii`).
pub fn rounded_rect_at(origin: (f64, f64), w: f64, h: f64, [tl, tr, br, bl]: [f64; 4]) -> BezPath {
    let (x, y) = origin;
    let mut p = BezPath::new();
    if tl == 0.0 && tr == 0.0 && br == 0.0 && bl == 0.0 {
        p.move_to((x, y));
        p.line_to((x + w, y));
        p.line_to((x + w, y + h));
        p.line_to((x, y + h));
        p.close_path();
        return p;
    }
    // Clockwise from the top edge, as the canvas's roundRect: each corner a quarter circle, its
    // cubics worked out once per radius (`quarter`).
    let corner = |p: &mut BezPath, c: Point, r: f64, which: usize| {
        if r <= 0.0 {
            p.line_to(c);
            return;
        }
        quarter(r, which, |a, b, e| p.curve_to(c + a, c + b, c + e));
    };
    p.move_to((x + tl, y));
    p.line_to((x + w - tr, y));
    if tr > 0.0 {
        corner(&mut p, Point::new(x + w - tr, y + tr), tr, 0);
    }
    p.line_to((x + w, y + h - br));
    if br > 0.0 {
        corner(&mut p, Point::new(x + w - br, y + h - br), br, 1);
    }
    p.line_to((x + bl, y + h));
    if bl > 0.0 {
        corner(&mut p, Point::new(x + bl, y + h - bl), bl, 2);
    }
    p.line_to((x, y + tl));
    if tl > 0.0 {
        corner(&mut p, Point::new(x + tl, y + tl), tl, 3);
    }
    p.close_path();
    p
}

/// Quarter circles of radius `r` about the origin as cubics (`which`: from the top, right,
/// bottom or left, clockwise), as kurbo's arc makes them at `tolerance(r)`: kept per radius, so
/// a page of rounded boxes, drawn into tile after tile, works out its arcs' sines and cosines
/// once (they were a tenth of a cold tile's time).
fn quarter(r: f64, which: usize, mut out: impl FnMut(Vec2, Vec2, Vec2)) {
    use core::f64::consts::{FRAC_PI_2, PI};
    type Quarters = [Vec<[Vec2; 3]>; 4];
    type Kept = std::collections::HashMap<u64, Quarters, std::hash::BuildHasherDefault<crate::masks::KeyHasher>>;
    thread_local! {
        static QUARTERS: core::cell::RefCell<Kept> = core::cell::RefCell::new(Kept::default());
    }
    QUARTERS.with(|cache| {
        let mut cache = cache.borrow_mut();
        if cache.len() >= 4096 {
            cache.clear();
        }
        let q = cache.entry(r.to_bits()).or_insert_with(|| {
            [-FRAC_PI_2, 0.0, FRAC_PI_2, PI].map(|start| {
                let mut v = Vec::new();
                let arc = vello_common::kurbo::Arc::new(Point::ORIGIN, (r, r), start, FRAC_PI_2, 0.0);
                arc.to_cubic_beziers(tolerance(r), |a, b, e| v.push([a.to_vec2(), b.to_vec2(), e.to_vec2()]));
                v
            })
        });
        for [a, b, e] in &q[which] {
            out(*a, *b, *e);
        }
    });
}

/// Fixed quarter-ellipse cubic count (32 cubics total; radial error < 1e-7 * r).
/// Camera-independent so CPU, GPU, and cached stroke outlines feed identical cubics
/// to the flattener at every zoom level.
const ELLIPSE_QUARTER_SEGMENTS: usize = 8;

/// The ellipse inscribed in a `w` × `h` box, from its rightmost point, clockwise (the canvas's
/// `ellipse(w/2, h/2, w/2, h/2, 0, 0, 2π)`).
pub fn ellipse(w: f32, h: f32) -> BezPath {
    let (w, h) = (f64::from(w), f64::from(h));
    let (rx, ry) = (w.abs() / 2.0, h.abs() / 2.0);
    if !rx.is_finite() || !ry.is_finite() || (rx == 0.0 && ry == 0.0) {
        return Ellipse::new((w / 2.0, h / 2.0), (rx, ry), 0.0).to_path(tolerance(rx.max(ry)));
    }
    use core::f64::consts::{FRAC_PI_2, PI};
    let c = Point::new(w / 2.0, h / 2.0);
    let mut p = BezPath::new();
    p.move_to((c.x + rx, c.y));
    push_quarter_arc(&mut p, c, rx, ry, 0.0, ELLIPSE_QUARTER_SEGMENTS);
    push_quarter_arc(&mut p, c, rx, ry, FRAC_PI_2, ELLIPSE_QUARTER_SEGMENTS);
    push_quarter_arc(&mut p, c, rx, ry, PI, ELLIPSE_QUARTER_SEGMENTS);
    push_quarter_arc(&mut p, c, rx, ry, 3.0 * FRAC_PI_2, ELLIPSE_QUARTER_SEGMENTS);
    p.close_path();
    p
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
        assert!(
            p.segments()
                .any(|s| (s.start().x - 20.0).abs() < 1e-9 && s.start().y.abs() < 1e-9)
        );
    }

    #[test]
    fn huge_curves_stay_a_few_cubics() {
        assert!(ellipse(3.0e38, 3.0e38).elements().len() < 128);
        assert!(rounded_rect(3.0e38, 3.0e38, [1.0e38; 4], 0.0).elements().len() < 128);
        assert!(rounded_rect(3.0e38, 3.0e38, [1.0e38; 4], 0.6).elements().len() < 128);
    }

    #[test]
    fn ellipse_is_camera_independent_and_bounded() {
        assert_eq!(ellipse(10.0, 8.0).elements().len(), 34);
        assert_eq!(ellipse(1000.0, 800.0).elements().len(), 34);
    }

    #[test]
    fn radii_are_fitted_as_corners_ts_fits_them() {
        assert_eq!(
            fit_radii(160.0, 100.0, [200.0, 0.0, 200.0, 0.0]),
            [100.0, 0.0, 100.0, 0.0]
        );
        assert_eq!(fit_radii(100.0, 40.0, [50.0; 4]), [20.0; 4]);
        assert_eq!(fit_radii(100.0, 40.0, [-3.0, f64::NAN, 5.0, 0.0]), [0.0, 0.0, 5.0, 0.0]);
    }

    #[test]
    fn kept_corners_are_kurbos_arcs() {
        use core::f64::consts::{FRAC_PI_2, PI};
        for r in [0.5, 3.0, 12.0, 47.25, 1.0e3, 2.5e5] {
            for (which, start) in [-FRAC_PI_2, 0.0, FRAC_PI_2, PI].into_iter().enumerate() {
                let c = Point::new(10.0, -7.5);
                let mut want = Vec::new();
                vello_common::kurbo::Arc::new(c, (r, r), start, FRAC_PI_2, 0.0)
                    .to_cubic_beziers(tolerance(r), |a, b, e| want.push([a, b, e]));
                // Twice: from the cache the second time.
                for _ in 0..2 {
                    let mut got = Vec::new();
                    quarter(r, which, |a, b, e| got.push([c + a, c + b, c + e]));
                    assert_eq!(got.len(), want.len());
                    for (g, w) in got.iter().zip(&want) {
                        for (g, w) in g.iter().zip(w) {
                            assert!((g.x - w.x).abs() <= 1e-9 * r && (g.y - w.y).abs() <= 1e-9 * r);
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn a_plain_box_is_four_lines() {
        assert_eq!(rounded_rect(10.0, 0.0, [0.0; 4], 0.0).elements().len(), 5);
    }

    #[test]
    fn smoothed_box_matches_figma_ios_control_points() {
        // 200 x 120, radius 30, iOS 60% smoothing: matches corners.test.ts line 96.
        let cmds = box_commands(200.0, 120.0, [30.0; 4], 0.6);
        assert_eq!(cmds[0], BoxCommand::Move(0.0, 48.0));
        match cmds[1] {
            BoxCommand::Cubic(x1, y1, x2, y2, x3, y3) => {
                assert!(x1.abs() < 1e-6);
                assert!((y1 - 31.198).abs() < 1e-3);
                assert!(x2.abs() < 1e-6);
                assert!((y2 - 22.798).abs() < 1e-3);
                assert!((x3 - 3.27).abs() < 1e-3);
                assert!((y3 - 16.38).abs() < 1e-3);
            }
            other => panic!("expected cubic, got {other:?}"),
        }
    }
}
