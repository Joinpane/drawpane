//! Board textures' correctness gates (decision 0040, phase 2), on the CPU, where they're bitwise:
//!
//! - every frame made of tiles that reports exact equals a fresh engine's frame (the same page
//!   given whole to an engine that never drew anything), pixel for pixel;
//! - seeded random sequences of edits, pans (whole and fractional pixels), zooms, page switches,
//!   image changes and memory pressure, checked at every exact frame; frames under budgets of a
//!   few tiles stand in meanwhile, and become exact within a bounded number of frames at rest;
//! - a stand-in (a stale tile, a scaled level, the last frame moved) is never reported exact;
//! - tiles agree with a whole frame drawn at once (no seams) within rounding.
//!
//! `FUZZ_SEED` and `FUZZ_CASES` widen a run, as in `fuzz.rs`.

mod common;

use common::model::*;
use common::*;
use drawpane_engine::engine::{Camera, Engine, TiledOptions};
use drawpane_engine::limits::Limits;

const W: u32 = 160;
const H: u32 = 120;
const TILE: u32 = 48;
const BG: [f32; 4] = [0.95, 0.94, 0.9, 1.0];

fn seed() -> u64 {
    match std::env::var("FUZZ_SEED").ok().as_deref() {
        Some("random") => {
            let s = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(1, |d| d.as_nanos() as u64);
            eprintln!("FUZZ_SEED={s}");
            s
        }
        Some(v) => v.parse().unwrap_or(0x7113_0040),
        None => 0x7113_0040,
    }
}

fn cases(default: u32) -> u32 {
    std::env::var("FUZZ_CASES")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(default)
}

fn image(variant: u8) -> Vec<u8> {
    let mut px = vec![0u8; 8 * 8 * 4];
    for (i, p) in px.as_chunks_mut::<4>().0.iter_mut().enumerate() {
        let i = i as u8;
        p.copy_from_slice(&[
            i.wrapping_mul(31).wrapping_add(variant),
            i.wrapping_mul(7),
            200u8.wrapping_sub(variant),
            if i.is_multiple_of(3) { 128 } else { 255 },
        ]);
    }
    px
}

fn engine(variant: u8, slots: usize) -> Engine {
    let mut e = Engine::new(Limits::default());
    e.put_image(IMAGE, 8, 8, &image(variant), false).expect("image");
    e.use_cpu_tiles(TILE, slots);
    e
}

/// What a fresh engine, given the whole page, draws (tiles, nothing kept from before).
fn fresh(model: &Model, revision: u32, variant: u8, cam: Camera) -> Vec<u8> {
    let mut e = engine(variant, 4096);
    e.apply(&model.fresh(revision)).expect("fresh list");
    let (px, stats) = e
        .render_cpu_tiled(W, H, cam, BG, TiledOptions::default())
        .expect("fresh frame");
    assert!(stats.exact, "a fresh engine's frame at rest is exact");
    px.to_vec()
}

fn diff(a: &[u8], b: &[u8]) -> Option<(u32, u32)> {
    a.iter()
        .zip(b)
        .position(|(x, y)| x != y)
        .map(|i| ((i / 4) as u32 % W, (i / 4) as u32 / W))
}

fn cam(zoom: f64, x: f64, y: f64) -> Camera {
    Camera { zoom, x, y, dpr: 1.0 }
}

#[derive(Default, Debug)]
struct Counts {
    exact: u32,
    standins: u32,
    edits: u32,
    pans: u32,
    zooms: u32,
    switches: u32,
    images: u32,
}

/// One seeded run: a page, then a random walk of edits and camera moves, frames under small
/// budgets while "moving", and frames at rest until exact.
fn run(s: u64, slots: usize, counts: &mut Counts) {
    let mut r = Rng(s | 1);
    let n = 6 + r.below(30);
    let mut model = Model::new(&mut r, n, false);
    let mut variant = 0u8;
    let mut e = engine(variant, slots);
    let mut revision = 1;
    e.apply(&model.fresh(revision))
        .unwrap_or_else(|err| panic!("seed {s}: fresh list refused: {err}"));
    let mut c = cam(
        f64::from(r.range(0.6, 1.6)),
        f64::from(r.range(-30.0, 30.0)).round(),
        0.0,
    );
    let check = |e: &mut Engine,
                 c: Camera,
                 moving: bool,
                 max_jobs: usize,
                 model: &Model,
                 revision: u32,
                 variant: u8,
                 counts: &mut Counts,
                 what: &str| {
        let opts = TiledOptions {
            moving,
            max_jobs,
            ..TiledOptions::default()
        };
        let (px, stats) = e
            .render_cpu_tiled(W, H, c, BG, opts)
            .unwrap_or_else(|err| panic!("seed {s} {what}: frame failed: {err}"));
        if stats.exact {
            counts.exact += 1;
            let want = fresh(model, revision, variant, c);
            if let Some((x, y)) = diff(px, &want) {
                panic!(
                    "seed {s} {what}: a frame reported exact differs from a fresh engine's at ({x}, {y}) ({stats:?}, camera {c:?})"
                );
            }
        } else {
            counts.standins += 1;
            assert!(
                stats.pending > 0 || stats.direct,
                "seed {s} {what}: not exact with nothing pending: {stats:?}"
            );
        }
        stats.exact
    };
    for step in 0..24 {
        let what = format!("step {step}");
        match r.below(10) {
            0..=2 => {
                let patch = model.edit(&mut r, revision, revision + 1);
                e.apply(&patch)
                    .unwrap_or_else(|err| panic!("seed {s} {what}: patch refused: {err}"));
                revision += 1;
                counts.edits += 1;
            }
            3 | 4 => {
                // Pans: whole pixels, sometimes a fraction.
                let frac = if r.chance(0.3) { 0.5 } else { 0.0 };
                for _ in 0..1 + r.below(4) {
                    c.x += f64::from(r.range(-40.0, 40.0)).round() + frac;
                    c.y += f64::from(r.range(-30.0, 30.0)).round();
                    check(
                        &mut e,
                        c,
                        true,
                        r.below(2) as usize,
                        &model,
                        revision,
                        variant,
                        counts,
                        &what,
                    );
                }
                counts.pans += 1;
            }
            5 | 6 => {
                for _ in 0..1 + r.below(4) {
                    let k = f64::from(r.range(0.7, 1.4));
                    let (ax, ay) = (f64::from(r.range(0.0, W as f32)), f64::from(r.range(0.0, H as f32)));
                    // Zoom about a point, as the editor does.
                    let z = (c.zoom * k).clamp(0.1, 6.0);
                    let (px, py) = ((ax - c.x) / c.zoom, (ay - c.y) / c.zoom);
                    c = cam(z, ax - px * z, ay - py * z);
                    check(
                        &mut e,
                        c,
                        true,
                        r.below(2) as usize,
                        &model,
                        revision,
                        variant,
                        counts,
                        &what,
                    );
                }
                counts.zooms += 1;
            }
            7 => {
                // A page switch: another page, given whole.
                let n = 4 + r.below(20);
                model = Model::new(&mut r, n, false);
                revision += 1;
                e.apply(&model.fresh(revision))
                    .unwrap_or_else(|err| panic!("seed {s} {what}: page switch refused: {err}"));
                counts.switches += 1;
            }
            8 => {
                // The image's pixels change under its handle.
                variant = variant.wrapping_add(17);
                e.put_image(IMAGE, 8, 8, &image(variant), false).expect("image");
                counts.images += 1;
            }
            _ => {}
        }
        // At rest: a frame or a few under a budget, until exact (bounded: the budget only
        // spreads the work, it never stalls it).
        let mut exact = false;
        for frame in 0..200 {
            exact = check(
                &mut e,
                c,
                false,
                (r.below(3)) as usize,
                &model,
                revision,
                variant,
                counts,
                &format!("{what} rest {frame}"),
            );
            if exact {
                break;
            }
        }
        assert!(exact, "seed {s} {what}: never became exact at rest");
    }
}

#[test]
fn exact_tiled_frames_equal_a_fresh_engine() {
    let base = seed();
    let mut counts = Counts::default();
    for case in 0..cases(40) {
        let s = base.wrapping_add(u64::from(case) * 0x9e37_79b9);
        run(s, 64, &mut counts);
    }
    eprintln!("{counts:?}");
    assert!(
        counts.exact > 100 && counts.standins > 50,
        "the walk exercised too little: {counts:?}"
    );
    assert!(counts.edits > 0 && counts.pans > 0 && counts.zooms > 0 && counts.switches > 0 && counts.images > 0);
}

#[test]
fn under_memory_pressure_frames_stay_exact_and_never_blank() {
    // Slots for fewer tiles than a frame shows: frames are drawn tile by tile, keeping none.
    let base = seed() ^ 0x55;
    let mut counts = Counts::default();
    for case in 0..cases(10) {
        let s = base.wrapping_add(u64::from(case) * 0x9e37_79b9);
        run(s, 3, &mut counts);
    }
    // And slots for a frame and a bit: eviction every frame.
    for case in 0..cases(10) {
        let s = base.wrapping_add(u64::from(case) * 0x7f4a_7c15);
        run(s, 14, &mut counts);
    }
    eprintln!("{counts:?}");
}

#[test]
fn tiles_agree_with_a_whole_frame() {
    // The tile grid draws each tile under its own view; a whole frame draws the page under the
    // camera. Coordinates differ in their last bits only, so pixels agree within rounding.
    let base = seed() ^ 0x77;
    let mut worst = 0u8;
    let mut off = 0usize;
    for case in 0..cases(30) {
        let s = base.wrapping_add(u64::from(case) * 0x9e37_79b9);
        let mut r = Rng(s | 1);
        let n = 6 + r.below(30);
        let model = Model::new(&mut r, n, false);
        let c = cam(
            f64::from(r.range(0.4, 2.5)),
            f64::from(r.range(-60.0, 60.0)),
            f64::from(r.range(-60.0, 60.0)),
        );
        let tiled = fresh(&model, 1, 0, c);
        let mut e = engine(0, 16);
        e.apply(&model.fresh(1)).expect("fresh");
        let (whole, _) = e.render_cpu(W, H, c, BG, false).expect("whole");
        for (a, b) in tiled.iter().zip(whole) {
            let d = a.abs_diff(*b);
            worst = worst.max(d);
            if d > 2 {
                off += 1;
            }
        }
    }
    eprintln!("tiles against whole frames: largest difference {worst}, {off} channels over 2");
    assert!(
        worst <= 2 && off == 0,
        "tiles differ from a whole frame by {worst} ({off} channels over 2)"
    );
}

#[test]
fn a_stand_in_is_never_reported_exact() {
    let mut r = Rng(0x0005_7a1d);
    let model = Model::new(&mut r, 24, false);
    let mut e = engine(0, 64);
    e.apply(&model.fresh(1)).expect("fresh");
    let c = cam(1.0, 0.0, 0.0);
    let rest = TiledOptions::default();
    let moving = TiledOptions {
        moving: true,
        max_jobs: 0,
        ..TiledOptions::default()
    };
    assert!(e.render_cpu_tiled(W, H, c, BG, rest).expect("frame").1.exact);
    // A zoom: the last frame scaled.
    let (_, s) = e
        .render_cpu_tiled(W, H, cam(1.3, -10.0, -10.0), BG, moving)
        .expect("zoom");
    assert!(!s.exact && s.pending > 0, "{s:?}");
    // A fractional pan: another phase, tiles not drawn yet.
    let _ = e.render_cpu_tiled(W, H, c, BG, rest).expect("frame");
    let (_, s) = e.render_cpu_tiled(W, H, cam(1.0, 0.5, 0.0), BG, moving).expect("pan");
    assert!(!s.exact, "{s:?}");
    // An edit: stale tiles.
    let _ = e.render_cpu_tiled(W, H, c, BG, rest).expect("frame");
    let mut model = model;
    let patch = model.edit(&mut r, 1, 2);
    e.apply(&patch).expect("patch");
    let (_, s) = e.render_cpu_tiled(W, H, c, BG, moving).expect("edit");
    // Unless the edit happened entirely off screen.
    if s.pending > 0 {
        assert!(!s.exact, "{s:?}");
    }
}

#[test]
fn an_image_change_redraws_what_shows_it() {
    let mut r = Rng(0x1a6e);
    let mut model = Model::new(&mut r, 1, false);
    // One big record filled with the image.
    let mut rec = Rec::new([1.0, 0.0, 0.0, 1.0, 10.0, 10.0], [120.0, 90.0]);
    rec.paths.push(Entry::Rect {
        w: 120.0,
        h: 90.0,
        radii: [0.0; 4],
    });
    rec.ops.push(Op::Fill {
        path: 0,
        even_odd: false,
        paint: Paint::Image {
            id: IMAGE,
            m: [120.0, 0.0, 0.0, 90.0, 0.0, 0.0],
            tile: false,
            opacity: 1.0,
        },
    });
    model.nodes.insert(model.next, (0, rec));
    model.children.entry(0).or_default().push(model.next);
    model.next += 1;
    let mut e = engine(0, 64);
    e.apply(&model.fresh(1)).expect("fresh");
    let c = cam(1.0, 0.0, 0.0);
    let (a, s) = e.render_cpu_tiled(W, H, c, BG, TiledOptions::default()).expect("frame");
    assert!(s.exact);
    let a = a.to_vec();
    e.put_image(IMAGE, 8, 8, &image(99), false).expect("image");
    let (b, s) = e.render_cpu_tiled(W, H, c, BG, TiledOptions::default()).expect("frame");
    assert!(s.exact && s.tiles_drawn > 0, "{s:?}");
    assert_ne!(a, b, "the image changed on screen");
    assert!(diff(b, &fresh(&model, 1, 99, c)).is_none());
}

#[test]
fn a_page_switch_leaves_no_stale_tile() {
    let mut r = Rng(0x9a6e);
    let a = Model::new(&mut r, 30, false);
    let b = Model::new(&mut r, 30, false);
    let mut e = engine(0, 64);
    e.apply(&a.fresh(1)).expect("fresh");
    let c = cam(1.0, 0.0, 0.0);
    assert!(
        e.render_cpu_tiled(W, H, c, BG, TiledOptions::default())
            .expect("a")
            .1
            .exact
    );
    e.apply(&b.fresh(2)).expect("switch");
    // Even while moving with no budget, nothing of the old page may show: what's missing is
    // drawn, and the last frame (the old page) doesn't stand in.
    let moving = TiledOptions {
        moving: true,
        max_jobs: 0,
        ..TiledOptions::default()
    };
    let (px, s) = e.render_cpu_tiled(W, H, c, BG, moving).expect("b");
    assert!(s.exact, "{s:?}");
    assert!(diff(px, &fresh(&b, 2, 0, c)).is_none());
}
