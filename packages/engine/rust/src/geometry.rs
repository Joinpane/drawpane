//! Shapes the engine generates itself, so every backend and every use of a shape (fill, stroke,
//! clip, and later shadow and glass distance) draws the same curve (decision 0040, "Corner
//! smoothing").
//!
//! `fit_corners`, `corner_cubics` and `box_commands` are direct ports of
//! `packages/editor/src/corner-geometry.ts` (decision 0041) and are verified against all 455
//! Figma-checked vectors in `packages/editor/test/fixtures/corner-vectors.json`.

use core::f64::consts::{PI, SQRT_2};
use vello_common::kurbo::{Affine, BezPath, Ellipse, Point, Rect, Shape, Vec2};

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

/// Returns true only when `path` transformed by `transform` provably has coverage 1.0 across
/// every pixel of `rect` under `even_odd` / non-zero fill rules.
///
/// Every segment must stay disjoint from `rect` (exact axis-aligned lines may lie on `rect`'s
/// integer edges; diagonal lines and curves must keep a 1 px margin outside `rect`). Disjointness
/// guarantees `rect` lies in a single connected component of the complement of the path, so a
/// single `+x` ray winding test at the center of `rect` is exact.
pub fn path_covers_rect(path: &BezPath, transform: Affine, even_odd: bool, rect: crate::exec::IRect) -> bool {
    use vello_common::kurbo::PathEl;

    // Keep within Vello's i16 winding range even when a clip has many coincident contours.
    if rect.is_empty()
        || path.elements().len() > i16::MAX as usize
        || transform.as_coeffs().iter().any(|c| !c.is_finite())
    {
        return false;
    }
    let rx0 = f64::from(rect.x0);
    let ry0 = f64::from(rect.y0);
    let rx1 = f64::from(rect.x1);
    let ry1 = f64::from(rect.y1);
    let cx = 0.5 * (rx0 + rx1);
    let cy = 0.5 * (ry0 + ry1);
    let mut winding = 0i32;

    // Vello flattens to f32. Keep coordinates small enough for the margin around
    // diagonal and curved segments to cover rounding and flattening error.
    let in_range = |p: Point| (p.x - cx).abs() <= 1_048_576.0 && (p.y - cy).abs() <= 1_048_576.0;
    let check_line = |a: Point, b: Point, winding: &mut i32| -> bool {
        if !in_range(a) || !in_range(b) {
            return false;
        }
        let min_x = a.x.min(b.x);
        let max_x = a.x.max(b.x);
        let min_y = a.y.min(b.y);
        let max_y = a.y.max(b.y);
        let axis_x = a.x == b.x;
        let axis_y = a.y == b.y;
        if axis_x && axis_y {
            return true;
        }
        let clear = if axis_x || axis_y {
            max_x <= rx0 || min_x >= rx1 || max_y <= ry0 || min_y >= ry1
        } else {
            // Exact slab test against the 1 px expanded rect so diagonal edges (e.g. rotated
            // frames) only reject when they actually come within 1 px of `rect`.
            let ex0 = rx0 - 1.0;
            let ey0 = ry0 - 1.0;
            let ex1 = rx1 + 1.0;
            let ey1 = ry1 + 1.0;
            if max_x <= ex0 || min_x >= ex1 || max_y <= ey0 || min_y >= ey1 {
                true
            } else {
                let dx = b.x - a.x;
                let dy = b.y - a.y;
                let (tx0, tx1) = {
                    let t1 = (ex0 - a.x) / dx;
                    let t2 = (ex1 - a.x) / dx;
                    (t1.min(t2), t1.max(t2))
                };
                let (ty0, ty1) = {
                    let t1 = (ey0 - a.y) / dy;
                    let t2 = (ey1 - a.y) / dy;
                    (t1.min(t2), t1.max(t2))
                };
                let t_enter = tx0.max(ty0).max(0.0);
                let t_exit = tx1.min(ty1).min(1.0);
                t_enter > t_exit
            }
        };
        if !clear {
            return false;
        }
        if a.y <= cy && b.y > cy {
            let x_cross = a.x + (cy - a.y) * (b.x - a.x) / (b.y - a.y);
            if x_cross > cx {
                *winding += 1;
            }
        } else if b.y <= cy && a.y > cy {
            let x_cross = a.x + (cy - a.y) * (b.x - a.x) / (b.y - a.y);
            if x_cross > cx {
                *winding -= 1;
            }
        }
        true
    };

    let check_curve = |pts: &[Point], winding: &mut i32| -> bool {
        let (mut min_x, mut max_x) = (f64::INFINITY, f64::NEG_INFINITY);
        let (mut min_y, mut max_y) = (f64::INFINITY, f64::NEG_INFINITY);
        for p in pts {
            if !in_range(*p) {
                return false;
            }
            min_x = min_x.min(p.x);
            max_x = max_x.max(p.x);
            min_y = min_y.min(p.y);
            max_y = max_y.max(p.y);
        }
        let clear = max_x <= rx0 - 1.0 || min_x >= rx1 + 1.0 || max_y <= ry0 - 1.0 || min_y >= ry1 + 1.0;
        if !clear {
            return false;
        }
        if min_x >= cx {
            let a = pts[0];
            let b = pts[pts.len() - 1];
            if a.y <= cy && b.y > cy {
                *winding += 1;
            } else if b.y <= cy && a.y > cy {
                *winding -= 1;
            }
        }
        true
    };

    let mut start: Option<Point> = None;
    let mut cur = Point::ORIGIN;
    for el in path.elements() {
        match *el {
            PathEl::MoveTo(p) => {
                if let Some(s) = start
                    && !check_line(cur, s, &mut winding)
                {
                    return false;
                }
                let tp = transform * p;
                start = Some(tp);
                cur = tp;
            }
            PathEl::LineTo(p) => {
                let tp = transform * p;
                if !check_line(cur, tp, &mut winding) {
                    return false;
                }
                cur = tp;
            }
            PathEl::QuadTo(p1, p2) => {
                let t1 = transform * p1;
                let t2 = transform * p2;
                if !check_curve(&[cur, t1, t2], &mut winding) {
                    return false;
                }
                cur = t2;
            }
            PathEl::CurveTo(p1, p2, p3) => {
                let t1 = transform * p1;
                let t2 = transform * p2;
                let t3 = transform * p3;
                if !check_curve(&[cur, t1, t2, t3], &mut winding) {
                    return false;
                }
                cur = t3;
            }
            PathEl::ClosePath => {
                if let Some(s) = start.take() {
                    if !check_line(cur, s, &mut winding) {
                        return false;
                    }
                    cur = s;
                }
            }
        }
    }
    if let Some(s) = start
        && !check_line(cur, s, &mut winding)
    {
        return false;
    }
    if even_odd { (winding & 1) != 0 } else { winding != 0 }
}

/// If `path` transformed by `transform` is a single closed axis-aligned rectangle whose vertices
/// all land on integer coordinates within `1e-4` device pixels (well below Vello's `0.5 / 255`
/// coverage rounding threshold), returns that exact integer `IRect` (empty for zero-area).
/// Returns `None` for any curved, fractional, sheared, multi-contour, or non-rectangular clip.
pub fn path_as_integer_aa_rect(path: &BezPath, transform: Affine) -> Option<crate::exec::IRect> {
    use vello_common::kurbo::PathEl;

    if transform.as_coeffs().iter().any(|c| !c.is_finite()) {
        return None;
    }
    const TOL: f64 = 1e-4;
    const MAX_COORD: f64 = 1_048_576.0;
    let snap = |p: Point| -> Option<(i32, i32)> {
        let tp = transform * p;
        if !tp.x.is_finite() || !tp.y.is_finite() || tp.x.abs() > MAX_COORD || tp.y.abs() > MAX_COORD {
            return None;
        }
        let rx = tp.x.round();
        let ry = tp.y.round();
        if (tp.x - rx).abs() > TOL || (tp.y - ry).abs() > TOL {
            return None;
        }
        Some((rx as i32, ry as i32))
    };

    let mut pts = [(0i32, 0i32); 4];
    let mut n = 0usize;
    let mut started = false;
    let mut closed = false;
    let mut returned = false;
    for el in path.elements() {
        if closed {
            return None;
        }
        match *el {
            PathEl::MoveTo(p) => {
                if started {
                    return None;
                }
                started = true;
                pts[0] = snap(p)?;
                n = 1;
            }
            PathEl::LineTo(p) => {
                if !started {
                    return None;
                }
                let q = snap(p)?;
                if returned {
                    if q != pts[0] {
                        return None;
                    }
                } else if q != pts[n - 1] {
                    if n == 4 {
                        if q != pts[0] {
                            return None;
                        }
                        returned = true;
                    } else {
                        pts[n] = q;
                        n += 1;
                    }
                }
            }
            PathEl::ClosePath => closed = true,
            PathEl::QuadTo(..) | PathEl::CurveTo(..) => return None,
        }
    }
    if !started {
        return None;
    }
    if n > 1 && pts[n - 1] == pts[0] {
        n -= 1;
    }
    if n <= 2 {
        return Some(crate::exec::IRect {
            x0: 0,
            y0: 0,
            x1: 0,
            y1: 0,
        });
    }
    if n != 4 {
        return None;
    }
    let [a, b, c, d] = pts;
    let horiz_first = a.1 == b.1 && b.0 == c.0 && c.1 == d.1 && d.0 == a.0;
    let vert_first = a.0 == b.0 && b.1 == c.1 && c.0 == d.0 && d.1 == a.1;
    if !horiz_first && !vert_first {
        return None;
    }
    Some(crate::exec::IRect {
        x0: a.0.min(c.0),
        y0: a.1.min(c.1),
        x1: a.0.max(c.0),
        y1: a.1.max(c.1),
    })
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

    #[test]
    fn path_covers_rect_handles_rects_rounded_frames_rotations_and_cutouts() {
        use crate::exec::IRect;
        let r = |x0, y0, x1, y1| IRect { x0, y0, x1, y1 };

        // Plain rectangle (strictly inside, exact boundary, partial overlap, outside).
        let box_path = rect_path(Rect::new(10.0, 20.0, 210.0, 120.0));
        assert!(path_covers_rect(&box_path, Affine::IDENTITY, false, r(20, 30, 100, 90)));
        assert!(path_covers_rect(
            &box_path,
            Affine::IDENTITY,
            false,
            r(10, 20, 210, 120)
        ));
        assert!(path_covers_rect(&box_path, Affine::IDENTITY, true, r(10, 20, 210, 120)));
        assert!(!path_covers_rect(&box_path, Affine::IDENTITY, false, r(9, 20, 100, 90)));
        assert!(!path_covers_rect(
            &box_path,
            Affine::IDENTITY,
            false,
            r(250, 30, 300, 90)
        ));
        assert!(!path_covers_rect(&box_path, Affine::IDENTITY, false, r(20, 30, 20, 90)));

        // A fractional edge still intersects the first column of pixels. A nearly
        // axis-aligned edge needs the general safety margin even if it misses the box.
        let target = r(10, 20, 210, 120);
        assert!(!path_covers_rect(
            &box_path,
            Affine::translate((0.25, 0.0)),
            false,
            target
        ));
        let shear = Affine::new([1.0, 0.0, -1e-9, 1.0, 0.0, 0.0]);
        assert!(!path_covers_rect(&box_path, shear, false, r(10, 20, 209, 120)));

        // Negative-scale flipped rectangle keeps non-zero and even-odd coverage.
        let flip = Affine::translate((220.0, 0.0)) * Affine::scale_non_uniform(-1.0, 1.0);
        assert!(path_covers_rect(&box_path, flip, false, r(20, 30, 100, 90)));
        assert!(path_covers_rect(&box_path, flip, true, r(20, 30, 100, 90)));

        // Rounded phone-screen frame: interior rect is covered, corner rects outside the arc are not.
        // At radius 55, the top-left arc midpoint is near (16.1, 16.1).
        let phone = rounded_rect(390.0, 844.0, [55.0; 4], 0.6);
        assert!(path_covers_rect(&phone, Affine::IDENTITY, false, r(60, 100, 330, 740)));
        assert!(path_covers_rect(&phone, Affine::IDENTITY, false, r(50, 50, 120, 120)));
        assert!(!path_covers_rect(&phone, Affine::IDENTITY, false, r(0, 0, 80, 80)));
        assert!(!path_covers_rect(&phone, Affine::IDENTITY, false, r(10, 10, 120, 120)));
        assert!(!path_covers_rect(&phone, Affine::IDENTITY, false, r(16, 16, 120, 120)));

        // Rotated square: center interior is covered, near-edge rect falls back.
        let sq = rect_path(Rect::new(-100.0, -100.0, 100.0, 100.0));
        let rot = Affine::translate((200.0, 200.0)) * Affine::rotate(core::f64::consts::FRAC_PI_4);
        assert!(path_covers_rect(&sq, rot, false, r(180, 180, 220, 220)));
        assert!(!path_covers_rect(&sq, rot, false, r(120, 120, 280, 280)));

        // Even-odd cutout ring: hole center is not covered.
        let mut ring = rect_path(Rect::new(0.0, 0.0, 200.0, 200.0));
        for el in rect_path(Rect::new(40.0, 40.0, 160.0, 160.0)).elements() {
            ring.push(*el);
        }
        assert!(!path_covers_rect(&ring, Affine::IDENTITY, true, r(60, 60, 140, 140)));
        assert!(path_covers_rect(&ring, Affine::IDENTITY, false, r(60, 60, 140, 140)));

        // Empty path never covers anything.
        assert!(!path_covers_rect(
            &BezPath::new(),
            Affine::IDENTITY,
            false,
            r(0, 0, 10, 10)
        ));
    }

    #[test]
    fn path_as_integer_aa_rect_accepts_only_pixel_aligned_axis_aligned_rects() {
        use crate::exec::IRect;
        let r = |x0, y0, x1, y1| IRect { x0, y0, x1, y1 };

        // Plain rectangle with identity, integer translate, negative offsets, 2x scale.
        let box_path = rect_path(Rect::new(10.0, 20.0, 110.0, 80.0));
        assert_eq!(
            path_as_integer_aa_rect(&box_path, Affine::IDENTITY),
            Some(r(10, 20, 110, 80))
        );
        assert_eq!(
            path_as_integer_aa_rect(&box_path, Affine::translate((-35.0, 12.0))),
            Some(r(-25, 32, 75, 92))
        );
        assert_eq!(
            path_as_integer_aa_rect(&box_path, Affine::scale(2.0)),
            Some(r(20, 40, 220, 160))
        );
        // Fractional source scaled into integer device pixels is exact.
        let half_box = rect_path(Rect::new(0.5, 1.5, 10.5, 20.5));
        assert_eq!(
            path_as_integer_aa_rect(&half_box, Affine::scale(2.0)),
            Some(r(1, 3, 21, 41))
        );
        // Within 1e-4 floating-point drift (far below 0.5/255 quantization boundary).
        assert_eq!(
            path_as_integer_aa_rect(&box_path, Affine::translate((5e-5, -5e-5))),
            Some(r(10, 20, 110, 80))
        );
        // Flipped and 90/180/270-degree rotated rects remain integer AA rects.
        assert_eq!(
            path_as_integer_aa_rect(&box_path, Affine::scale_non_uniform(-1.0, 1.0)),
            Some(r(-110, 20, -10, 80))
        );
        assert_eq!(
            path_as_integer_aa_rect(&box_path, Affine::rotate(core::f64::consts::FRAC_PI_2)),
            Some(r(-80, 10, -20, 110))
        );
        assert_eq!(
            path_as_integer_aa_rect(&box_path, Affine::rotate(core::f64::consts::PI)),
            Some(r(-110, -80, -10, -20))
        );
        // Degenerate zero-area rect folds to an empty IRect.
        let flat = rect_path(Rect::new(10.0, 20.0, 10.0, 80.0));
        assert_eq!(path_as_integer_aa_rect(&flat, Affine::IDENTITY), Some(r(0, 0, 0, 0)));

        // Fractional edges must be rejected so AA coverage is preserved.
        for dx in [0.002, -0.002, 0.25, 0.5, 0.99] {
            assert_eq!(
                path_as_integer_aa_rect(&box_path, Affine::translate((dx, 0.0))),
                None,
                "dx={dx} must not fold into scissor"
            );
        }
        // Arbitrary rotation, shear, rounded rect, triangle, multi-contour, and empty path rejected.
        assert_eq!(path_as_integer_aa_rect(&box_path, Affine::rotate(0.1)), None);
        assert_eq!(
            path_as_integer_aa_rect(&box_path, Affine::new([1.0, 0.0, 0.01, 1.0, 0.0, 0.0])),
            None
        );
        assert_eq!(
            path_as_integer_aa_rect(&rounded_rect(100.0, 80.0, [4.0; 4], 0.0), Affine::IDENTITY),
            None
        );
        let mut tri = BezPath::new();
        tri.move_to((0.0, 0.0));
        tri.line_to((100.0, 0.0));
        tri.line_to((100.0, 80.0));
        tri.close_path();
        assert_eq!(path_as_integer_aa_rect(&tri, Affine::IDENTITY), None);

        let mut two = rect_path(Rect::new(0.0, 0.0, 100.0, 100.0));
        for el in rect_path(Rect::new(20.0, 20.0, 80.0, 80.0)).elements() {
            two.push(*el);
        }
        assert_eq!(path_as_integer_aa_rect(&two, Affine::IDENTITY), None);
        assert_eq!(path_as_integer_aa_rect(&BezPath::new(), Affine::IDENTITY), None);
    }

    #[test]
    fn integer_aa_rect_scissor_matches_vello_rasterized_mask_byte_for_byte() {
        use vello_common::color::palette::css::WHITE;
        use vello_common::peniko::Fill;

        let cases: &[(&str, BezPath, Affine)] = &[
            (
                "identity",
                rect_path(Rect::new(8.0, 12.0, 52.0, 44.0)),
                Affine::IDENTITY,
            ),
            (
                "drift_within_tol",
                rect_path(Rect::new(8.0, 12.0, 52.0, 44.0)),
                Affine::translate((9e-5, -9e-5)),
            ),
            (
                "scaled_half",
                rect_path(Rect::new(4.5, 6.5, 26.5, 22.5)),
                Affine::scale(2.0),
            ),
            (
                "rotated_90",
                rect_path(Rect::new(10.0, -48.0, 42.0, -12.0)),
                Affine::rotate(core::f64::consts::FRAC_PI_2),
            ),
            (
                "flipped_x",
                rect_path(Rect::new(-52.0, 12.0, -8.0, 44.0)),
                Affine::scale_non_uniform(-1.0, 1.0),
            ),
            (
                "clipped_partially_off_left_top",
                rect_path(Rect::new(-10.0, -5.0, 30.0, 25.0)),
                Affine::IDENTITY,
            ),
        ];

        let (w, h) = (64u16, 64u16);
        for &(name, ref path, tf) in cases {
            let aa = path_as_integer_aa_rect(path, tf).expect(name);
            for even_odd in [false, true] {
                let mut ctx = vello_cpu::RenderContext::new(w, h);
                ctx.set_transform(tf);
                ctx.set_fill_rule(if even_odd { Fill::EvenOdd } else { Fill::NonZero });
                ctx.push_clip_path(path);
                ctx.set_transform(Affine::IDENTITY);
                ctx.set_fill_rule(Fill::NonZero);
                ctx.set_paint(WHITE);
                ctx.fill_rect(&Rect::new(0.0, 0.0, f64::from(w), f64::from(h)));
                ctx.pop_clip();
                ctx.flush();
                let mut pixmap = vello_cpu::Pixmap::new(w, h);
                let mut resources = vello_cpu::Resources::new();
                ctx.render_with(&mut pixmap, &mut resources, vello_cpu::RasterizerSettings::default());
                let px = pixmap.data_as_u8_slice();
                for y in 0..i32::from(h) {
                    for x in 0..i32::from(w) {
                        let inside = x >= aa.x0 && x < aa.x1 && y >= aa.y0 && y < aa.y1;
                        let want = if inside { 255u8 } else { 0u8 };
                        let off = ((y as usize) * usize::from(w) + (x as usize)) * 4;
                        assert_eq!(
                            &px[off..off + 4],
                            &[want, want, want, want],
                            "case={name} even_odd={even_odd} at ({x},{y}) aa={aa:?}"
                        );
                    }
                }
            }
        }
    }
}
