//! Curved edges cover what their outline covers. vello_common 0.4 flattens fills at a quarter
//! pixel, and every flattened chord lies inside its curve, so small circles and rounded corners
//! came out polygonal and thinner than Figma draws them (the iOS kit's 8 x 8 page dot scored 5.40
//! against Figma where the canvas renderer scored 3.23). The vendored vello_common flattens at
//! 1/16 px (vendor/vello_common/VENDORED.md).

mod common;

use common::{ANY, Entry, Op, Paint, Rec, W};
use drawpane_engine::engine::{Camera, Engine};
use drawpane_engine::limits::Limits;

/// The alpha of a `size` x `size` CPU frame at `zoom` of one record filling `entry` in black.
fn alpha(entry: Entry, box_size: [f32; 2], at: [f64; 2], zoom: f64, size: u32) -> Vec<u8> {
    let mut r = Rec::new([1.0, 0.0, 0.0, 1.0, at[0], at[1]], box_size);
    r.paths.push(entry);
    r.ops.push(Op::Fill {
        path: 0,
        even_odd: false,
        paint: Paint::Solid([0.0, 0.0, 0.0, 1.0]),
    });
    let mut e = Engine::new(Limits::default());
    let mut w = W::new(ANY, 1);
    w.reset();
    w.set(1, 0, &r);
    e.apply(&w.finish()).unwrap();
    let camera = Camera {
        zoom,
        x: 0.0,
        y: 0.0,
        dpr: 1.0,
    };
    let (px, _) = e.render_cpu(size, size, camera, [0.0; 4], false).unwrap();
    px.as_chunks::<4>().0.iter().map(|p| p[3]).collect()
}

/// Exact coverage (64 x 64 samples a pixel) of the disc of radius `r` about (`cx`, `cy`), in
/// device pixels.
fn disc(cx: f64, cy: f64, r: f64, size: u32) -> Vec<u8> {
    const N: u32 = 64;
    let mut out = Vec::with_capacity((size * size) as usize);
    for y in 0..size {
        for x in 0..size {
            let mut inside = 0u32;
            for j in 0..N {
                for i in 0..N {
                    let px = f64::from(x) + (f64::from(i) + 0.5) / f64::from(N) - cx;
                    let py = f64::from(y) + (f64::from(j) + 0.5) / f64::from(N) - cy;
                    if px * px + py * py <= r * r {
                        inside += 1;
                    }
                }
            }
            out.push((f64::from(inside) / f64::from(N * N) * 255.0).round() as u8);
        }
    }
    out
}

/// Largest per-pixel error and the mean signed error over edge pixels (exact alpha strictly
/// between 0 and 255): the bias a flattener that cuts inside the curve leaves.
fn errors(drawn: &[u8], exact: &[u8]) -> (i32, f64) {
    let mut worst = 0;
    let mut sum = 0i64;
    let mut edge = 0i64;
    for (&d, &e) in drawn.iter().zip(exact) {
        let diff = i32::from(d) - i32::from(e);
        worst = worst.max(diff.abs());
        if e > 0 && e < 255 {
            sum += i64::from(diff);
            edge += 1;
        }
    }
    (worst, sum as f64 / edge.max(1) as f64)
}

#[test]
fn a_small_dot_covers_its_whole_edge() {
    // The iOS page dot: an 8 x 8 box with radius 50 (fitted to 4), at 2x: a 16 px disc.
    let drawn = alpha(
        Entry::Rect {
            w: 8.0,
            h: 8.0,
            radii: [50.0; 4],
        },
        [8.0, 8.0],
        [0.0, 0.0],
        2.0,
        16,
    );
    let (worst, bias) = errors(&drawn, &disc(8.0, 8.0, 8.0, 16));
    // At a quarter pixel the chords cut up to 44 levels from the edge.
    assert!(worst <= 12, "worst pixel {worst} levels from exact coverage");
    assert!(bias.abs() <= 6.0, "edge pixels {bias:.2} levels from exact on average");
}

#[test]
fn a_large_circle_has_no_flat_chords() {
    // The iOS date picker's selected day: a 38 x 38 ellipse at 2x, a 76 px disc. At a quarter
    // pixel its top was one 17 px chord a quarter pixel inside the curve (52 levels off at
    // worst). At 1/16 px the chords still sit inside, by 1/24 px on average.
    let drawn = alpha(Entry::Ellipse { w: 38.0, h: 38.0 }, [38.0, 38.0], [0.0, 0.0], 2.0, 76);
    let (worst, bias) = errors(&drawn, &disc(38.0, 38.0, 38.0, 76));
    assert!(worst <= 16, "worst pixel {worst} levels from exact coverage");
    assert!(bias.abs() <= 8.0, "edge pixels {bias:.2} levels from exact on average");
}

#[test]
fn a_small_rounded_corner_is_round_at_1x() {
    // A 3-unit corner at 1x, where a quarter pixel draws each corner as one chord: the corner's
    // quarter disc against exact coverage, the straight sides being exact anyway.
    let drawn = alpha(
        Entry::Rect {
            w: 12.0,
            h: 12.0,
            radii: [3.0; 4],
        },
        [12.0, 12.0],
        [2.0, 2.0],
        1.0,
        16,
    );
    let mut exact = disc(5.0, 5.0, 3.0, 16);
    // Inside the box away from the corner arcs the exact coverage is full.
    for y in 0..16u32 {
        for x in 0..16u32 {
            let (fx, fy) = (f64::from(x) + 0.5, f64::from(y) + 0.5);
            let in_box = (2.0..14.0).contains(&fx) && (2.0..14.0).contains(&fy);
            let corner = fx < 5.0 && fy < 5.0;
            if !corner {
                exact[(y * 16 + x) as usize] = if in_box { 255 } else { 0 };
            }
        }
    }
    // Only the top-left corner's square counts.
    let pick = |v: &[u8]| -> Vec<u8> {
        (0..5u32)
            .flat_map(|y| (0..5u32).map(move |x| (y, x)))
            .map(|(y, x)| v[(y * 16 + x) as usize])
            .collect()
    };
    let (worst, _) = errors(&pick(&drawn), &pick(&exact));
    assert!(worst <= 12, "worst corner pixel {worst} levels from exact coverage");
}
