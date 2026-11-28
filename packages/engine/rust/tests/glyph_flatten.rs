//! Glyph outlines flatten as every other fill does, at 1/16 device pixel (the vendored
//! vello_common, `vendor/vello_common/VENDORED.md`): their masks and the runs filled as outlines
//! alike. A coarser tolerance for glyphs alone (1/8 px, and 1/16 px growing to 1/4 as the em
//! shrinks below 32 px) was measured for text-heavy page openings and won nothing back there: the
//! iOS kit's Text Styles page, fitted, makes about 1,900 masks a frame in some 40 ms on the CPU
//! at either tolerance, and small text is where a coarser tolerance's bias shows most (PR #382).

mod common;

use common::{ANY, Entry, Op, Paint, Rec, W};
use drawpane_engine::engine::{Camera, Engine};
use drawpane_engine::limits::Limits;
use drawpane_engine::masks::{self, Rasterizer};
use vello_common::kurbo::{BezPath, Circle, PathEl, Point, Shape};

/// A dot glyph (an "o" without its hole): radius 350 about (500, 350), in glyph units (a
/// thousand to the em, y up).
const CENTRE: (f64, f64) = (500.0, 350.0);
const RADIUS: f64 = 350.0;

fn dot() -> BezPath {
    Circle::new(CENTRE, RADIUS).to_path(1e-3)
}

/// Exact coverage (64 x 64 samples a pixel) of the disc of radius `r` about (`cx`, `cy`), in a
/// `w` x `h` image.
fn disc(cx: f64, cy: f64, r: f64, w: u32, h: u32) -> Vec<u8> {
    const N: u32 = 64;
    let mut out = Vec::with_capacity((w * h) as usize);
    for y in 0..h {
        for x in 0..w {
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
fn a_small_glyph_mask_covers_its_whole_edge() {
    // Body and caption text on a fitted page, and at 1x and 2x.
    let path = dot();
    for em in [6.0, 9.0, 12.0, 17.0, 24.0, 34.0] {
        let s = em / 1000.0;
        for phase in [(0.0, 0.0), (0.375, 0.625)] {
            let (mask, (x0, y0)) =
                masks::rasterise(&mut Rasterizer::default(), &path, s, -s, phase, 160).expect("a mask");
            let drawn: Vec<u8> = mask
                .data_as_u8_slice()
                .as_chunks::<4>()
                .0
                .iter()
                .map(|p| p[3])
                .collect();
            let exact = disc(
                CENTRE.0 * s + phase.0 - f64::from(x0),
                -CENTRE.1 * s + phase.1 - f64::from(y0),
                RADIUS * s,
                u32::from(mask.width()),
                u32::from(mask.height()),
            );
            let (worst, bias) = errors(&drawn, &exact);
            assert!(
                worst <= WORST && bias.abs() <= BIAS,
                "a dot {em} px to the em at phase {phase:?}: worst {worst}, edge bias {bias:.2}"
            );
        }
    }
}

/// At 1/16 px a dot 6 to 34 px to the em is off by 13 levels at worst and its edge by 7.3 on
/// average; at 1/8 px by up to 24 and 13 (17 px to the em), at a quarter pixel 56 and 28.
const WORST: i32 = 14;
const BIAS: f64 = 8.0;

/// The dot as glyph path verbs.
fn glyph_path() -> Vec<(u8, Vec<f32>)> {
    let pt = |q: Point| [q.x as f32, q.y as f32];
    dot()
        .elements()
        .iter()
        .map(|el| match *el {
            PathEl::MoveTo(a) => (0u8, pt(a).to_vec()),
            PathEl::LineTo(a) => (1, pt(a).to_vec()),
            PathEl::QuadTo(a, b) => (2, [pt(a), pt(b)].concat()),
            PathEl::CurveTo(a, b, c) => (3, [pt(a), pt(b), pt(c)].concat()),
            PathEl::ClosePath => (4, vec![]),
        })
        .collect()
}

/// A frame of the dot, `em` px to the em with its baseline at (0, 0.8 em) in a record turned a
/// little (so a glyph run fills its outline rather than masks): as a glyph run when `glyph`, else
/// as an ordinary path placed where the run places it.
fn turned(em: f64, glyph: bool) -> Vec<u8> {
    let s = em / 1000.0;
    let mut w = W::new(ANY, 1);
    w.reset();
    w.glyph(1, &glyph_path());
    let (sn, cs) = 0.01f64.sin_cos();
    let mut r = Rec::new([cs, sn, -sn, cs, 8.0, 4.0], [96.0, 96.0]);
    r.paths.push(if glyph {
        Entry::Glyphs {
            scale: s as f32,
            glyphs: vec![(1, 0.0, (em * 0.8) as f32)],
        }
    } else {
        Entry::Path(
            glyph_path()
                .into_iter()
                .map(|(v, c)| {
                    let c = c
                        .chunks(2)
                        .flat_map(|p| [(f64::from(p[0]) * s) as f32, (-f64::from(p[1]) * s + em * 0.8) as f32])
                        .collect();
                    (v, c)
                })
                .collect(),
        )
    });
    r.ops.push(Op::Fill {
        path: 0,
        even_odd: false,
        paint: Paint::Solid([0.1, 0.2, 0.3, 1.0]),
    });
    w.set(1, 0, &r);
    let mut e = Engine::new(Limits::default());
    e.apply(&w.finish()).expect("list");
    let camera = Camera {
        zoom: 1.0,
        x: 0.0,
        y: 0.0,
        dpr: 1.0,
    };
    let (px, _) = e.render_cpu(112, 104, camera, [1.0; 4], false).expect("frame");
    px.to_vec()
}

#[test]
fn a_glyph_run_filled_as_its_outline_flattens_as_any_path() {
    // The run places its glyph in f64 and the record's path is f32: a level, here and there,
    // apart. A glyph tolerance coarser than 1/16 px moves edge pixels by up to 21 levels at 6 px.
    for em in [6.0, 12.0, 24.0, 90.0] {
        let (glyph, path) = (turned(em, true), turned(em, false));
        let off = glyph.iter().zip(&path).filter(|(a, b)| a != b).count();
        let most = glyph.iter().zip(&path).map(|(a, b)| a.abs_diff(*b)).max().unwrap_or(0);
        assert!(
            off <= 4 && most <= 1,
            "{em} px to the em: {off} bytes off, by up to {most}"
        );
    }
}
