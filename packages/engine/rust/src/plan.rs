//! How a GPU frame is made (`gpu.rs`), decided apart from the GPU so it's tested natively.
//!
//! A frame texture is tied to the camera it holds (`Shown::view`), exactly: a frame made from
//! another keeps that camera's own numbers (the last one shifted by whole pixels), never the
//! camera asked for, so error can't build up across frames. Only an unchanged camera reuses a
//! frame as it was (exact if it was); anything else made from the last frame is a stand-in,
//! which the editor replaces with an exact frame once the camera rests.

use vello_common::kurbo::Affine;

/// What a frame texture holds.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Shown {
    /// The camera it was drawn for (page to device), exactly.
    pub view: Affine,
    pub background: [f32; 4],
    /// The engine's generation when drawn (`Engine::generation`): what's drawn may differ after.
    pub generation: u64,
    /// Drawn exactly: the whole scene, no stand-in, no level of detail.
    pub exact: bool,
}

/// How a frame is made.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Plan {
    /// The whole scene drawn.
    Full,
    /// The frame shown shifted by whole device pixels, the strips it uncovers drawn. A pan by a
    /// fraction of a pixel shifts by the nearest whole one.
    Pan(i32, i32),
    /// The last full frame scaled and moved.
    Zoom,
    /// The camera is the frame's own: it stays, exact if it was.
    Same,
    /// The camera moved less than half a pixel: the frame stays, as a stand-in.
    Hold,
}

impl Plan {
    /// The code reported to TypeScript (`FrameStats.plan`).
    pub fn code(self) -> u32 {
        match self {
            Plan::Full => 0,
            Plan::Pan(..) => 1,
            Plan::Zoom => 2,
            Plan::Same => 3,
            Plan::Hold => 4,
        }
    }
}

/// The least share of the view the last full frame must still cover for a zoom to scale it:
/// below it, a whole frame is drawn instead of a stand-in that would be mostly background.
pub const ZOOM_COVER: f64 = 0.5;

/// How to make a `width` × `height` frame for `view` (`detail`: an interactive frame, which may
/// be a stand-in), given the frame shown and the last full frame.
pub fn plan(
    view: Affine,
    detail: bool,
    size: (u16, u16),
    background: [f32; 4],
    generation: u64,
    shown: Option<&Shown>,
    basis: Option<&Shown>,
) -> Plan {
    let current = |s: &&Shown| s.generation == generation && s.background == background;
    let (w, h) = (f64::from(size.0), f64::from(size.1));
    if let Some(last) = shown.filter(current) {
        // The same camera reuses the frame, unless an exact frame is asked for and it isn't one.
        if last.view == view && (last.exact || detail) {
            return Plan::Same;
        }
        if !detail {
            return Plan::Full;
        }
        let [z, _, _, _, tx, ty] = view.as_coeffs();
        let [lz, _, _, _, lx, ly] = last.view.as_coeffs();
        if z == lz {
            let (dx, dy) = ((tx - lx).round(), (ty - ly).round());
            if dx == 0.0 && dy == 0.0 {
                return Plan::Hold;
            }
            if dx.abs() < w && dy.abs() < h {
                return Plan::Pan(dx as i32, dy as i32);
            }
        }
    }
    if !detail {
        return Plan::Full;
    }
    if let Some(b) = basis.filter(current)
        && cover(b.view, view, w, h) >= ZOOM_COVER
    {
        return Plan::Zoom;
    }
    Plan::Full
}

/// The share of a `w` × `h` view under `view` that a frame drawn under `from` covers.
pub fn cover(from: Affine, view: Affine, w: f64, h: f64) -> f64 {
    let [bz, _, _, _, bx, by] = from.as_coeffs();
    let [z, _, _, _, tx, ty] = view.as_coeffs();
    if bz == 0.0 || w <= 0.0 || h <= 0.0 {
        return 0.0;
    }
    // The old frame's corners, (0, 0) and (w, h) on its device, where they land on this one.
    let k = z / bz;
    let (x0, x1) = ((0.0 - bx) * k + tx, (w - bx) * k + tx);
    let (y0, y1) = ((0.0 - by) * k + ty, (h - by) * k + ty);
    let ox = (x1.min(w) - x0.max(0.0)).max(0.0);
    let oy = (y1.min(h) - y0.max(0.0)).max(0.0);
    let r = ox * oy / (w * h);
    if r.is_finite() { r } else { 0.0 }
}

/// The camera a frame made by `plan` from `last` holds: never the camera asked for unless the
/// frame was drawn for it.
pub fn held_view(plan: Plan, asked: Affine, last: Option<&Shown>) -> Affine {
    match (plan, last) {
        (Plan::Same | Plan::Hold, Some(l)) => l.view,
        (Plan::Pan(dx, dy), Some(l)) => Affine::translate((f64::from(dx), f64::from(dy))) * l.view,
        _ => asked,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const BG: [f32; 4] = [1.0; 4];

    fn cam(z: f64, x: f64, y: f64) -> Affine {
        Affine::new([z, 0.0, 0.0, z, x, y])
    }

    fn shown(view: Affine, exact: bool) -> Shown {
        Shown {
            view,
            background: BG,
            generation: 1,
            exact,
        }
    }

    #[test]
    fn only_the_frames_own_camera_reuses_it() {
        let last = shown(cam(1.0, 10.0, 20.0), true);
        let p = |v| plan(v, true, (100, 80), BG, 1, Some(&last), Some(&last));
        assert_eq!(p(cam(1.0, 10.0, 20.0)), Plan::Same);
        // A move far under a pixel isn't the same camera: the frame stays, as a stand-in.
        assert_eq!(p(cam(1.0, 10.0000009, 20.0)), Plan::Hold);
        assert_eq!(p(cam(1.0, 10.4, 20.0)), Plan::Hold);
        // An exact frame asked for a camera the texture doesn't hold is drawn whole.
        assert_eq!(
            plan(cam(1.0, 10.4, 20.0), false, (100, 80), BG, 1, Some(&last), None),
            Plan::Full
        );
        // And so is one asked for the texture's camera when the texture isn't exact.
        let standin = shown(cam(1.0, 10.0, 20.0), false);
        assert_eq!(
            plan(cam(1.0, 10.0, 20.0), false, (100, 80), BG, 1, Some(&standin), None),
            Plan::Full
        );
        assert_eq!(
            plan(cam(1.0, 10.0, 20.0), true, (100, 80), BG, 1, Some(&standin), None),
            Plan::Same
        );
    }

    #[test]
    fn tiny_moves_never_accumulate_on_the_frame() {
        // 32,768 moves of 0.0000009 px: the texture keeps its own camera, so the frame is
        // reported unchanged only while the camera asked for is exactly the texture's.
        let mut last = shown(cam(1.0, 0.0, 0.0), true);
        let mut x = 0.0;
        let mut planned = Plan::Same;
        for _ in 0..32_768 {
            x += 0.000_000_9;
            let v = cam(1.0, x, 0.0);
            planned = plan(v, true, (100, 80), BG, 1, Some(&last), Some(&last));
            last.view = held_view(planned, v, Some(&last));
        }
        assert_eq!(planned, Plan::Hold);
        assert_eq!(last.view, cam(1.0, 0.0, 0.0));
        // Once the asked camera is a pixel away the frame shifts, to its own camera plus one.
        let v = cam(1.0, 1.0 + x, 0.0);
        assert_eq!(
            plan(v, true, (100, 80), BG, 1, Some(&last), Some(&last)),
            Plan::Pan(1, 0)
        );
    }

    #[test]
    fn fractional_pans_shift_by_whole_pixels_and_draw_what_they_uncover() {
        // 1.5 device pixels a frame: each a shift (never a scaled stand-in of an old frame that
        // ends up all background), the texture's camera kept to whole pixels from the last.
        let mut last = shown(cam(1.0, 0.0, 0.0), true);
        let basis = last;
        for i in 1..=100 {
            let v = cam(1.0, -1.5 * f64::from(i), 0.0);
            let p = plan(v, true, (100, 80), BG, 1, Some(&last), Some(&basis));
            assert!(matches!(p, Plan::Pan(..)), "step {i}: {p:?}");
            last.view = held_view(p, v, Some(&last));
            let [_, _, _, _, held, _] = last.view.as_coeffs();
            assert!((held - (-1.5 * f64::from(i))).abs() <= 0.5);
            assert_eq!(held, held.round());
        }
    }

    #[test]
    fn a_zoom_scales_the_last_full_frame_only_while_it_covers_the_view() {
        let basis = shown(cam(1.0, 0.0, 0.0), true);
        let p = |v| plan(v, true, (100, 80), BG, 1, Some(&basis), Some(&basis));
        assert_eq!(p(cam(1.1, -5.0, -4.0)), Plan::Zoom);
        // Zoomed far out the old frame is a speck in the middle: drawn whole.
        assert_eq!(p(cam(0.2, 40.0, 32.0)), Plan::Full);
        // Moved past it: no overlap.
        assert_eq!(p(cam(1.1, -500.0, 0.0)), Plan::Full);
        assert!((cover(cam(1.0, 0.0, 0.0), cam(1.0, -50.0, 0.0), 100.0, 80.0) - 0.5).abs() < 1e-9);
    }

    #[test]
    fn another_generation_or_background_draws_whole() {
        let last = shown(cam(1.0, 0.0, 0.0), true);
        assert_eq!(
            plan(cam(1.0, 0.0, 0.0), true, (100, 80), BG, 2, Some(&last), Some(&last)),
            Plan::Full
        );
        assert_eq!(
            plan(
                cam(1.0, 0.0, 0.0),
                true,
                (100, 80),
                [0.0; 4],
                1,
                Some(&last),
                Some(&last)
            ),
            Plan::Full
        );
    }
}
