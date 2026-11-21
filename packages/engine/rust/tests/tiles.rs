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
    drags: u32,
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
        match r.below(11) {
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
            9 => {
                // A drag: a run of siblings moved over a few frames, then dropped.
                let parents: Vec<u32> = std::iter::once(0)
                    .chain(model.nodes.keys().copied())
                    .filter(|p| model.children.get(p).is_some_and(|l| !l.is_empty()))
                    .collect();
                if let Some(&parent) = parents.get(r.below(parents.len().max(1) as u32) as usize) {
                    let list = model.children[&parent].clone();
                    let a = r.below(list.len() as u32) as usize;
                    let b = (a + r.below(2) as usize).min(list.len() - 1);
                    let ids = list[a..=b].to_vec();
                    for _ in 0..1 + r.below(4) {
                        let (dx, dy) = (f64::from(r.range(-30.0, 30.0)), f64::from(r.range(-20.0, 20.0)));
                        let patch = drag_patch(&mut model, &ids, dx, dy, revision);
                        e.apply(&patch)
                            .unwrap_or_else(|err| panic!("seed {s} {what}: move refused: {err}"));
                        revision += 1;
                        check(
                            &mut e,
                            c,
                            false,
                            r.below(2) as usize,
                            &model,
                            revision,
                            variant,
                            counts,
                            &what,
                        );
                    }
                    counts.drags += 1;
                }
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
        if let Some(one) = std::env::var("FUZZ_ONE").ok().and_then(|v| v.parse::<u64>().ok())
            && one != s
        {
            continue;
        }
        run(s, 64, &mut counts);
    }
    eprintln!("{counts:?}");
    assert!(
        counts.exact > 100 && counts.standins > 50,
        "the walk exercised too little: {counts:?}"
    );
    assert!(
        counts.edits > 0
            && counts.pans > 0
            && counts.zooms > 0
            && counts.switches > 0
            && counts.images > 0
            && counts.drags > 0
    );
}

#[test]
fn under_memory_pressure_frames_stay_exact_and_never_blank() {
    // Slots for fewer tiles than a frame shows: frames are drawn tile by tile, keeping none.
    let base = seed() ^ 0x55;
    let mut counts = Counts::default();
    for case in 0..cases(10) {
        let s = base.wrapping_add(u64::from(case) * 0x9e37_79b9);
        if std::env::var("FUZZ_ONE").is_ok() {
            continue;
        }
        run(s, 3, &mut counts);
    }
    // And slots for a frame and a bit: eviction every frame.
    for case in 0..cases(10) {
        let s = base.wrapping_add(u64::from(case) * 0x7f4a_7c15);
        if let Some(one) = std::env::var("FUZZ_ONE").ok().and_then(|v| v.parse::<u64>().ok())
            && one != s
        {
            continue;
        }
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
    let c = cam(1.3, 0.0, 0.0);
    assert!(
        e.render_cpu_tiled(W, H, c, BG, TiledOptions::default())
            .expect("a")
            .1
            .exact
    );
    e.apply(&b.fresh(2)).expect("switch");
    // Even while moving with no budget, nothing of the old page may show: the last frame (the
    // old page) doesn't stand in. The first frame is coarse tiles of the new page (a stand-in),
    // and frames at rest then draw it exactly.
    let moving = TiledOptions {
        moving: true,
        max_jobs: 0,
        ..TiledOptions::default()
    };
    let old = fresh(&a, 1, 0, c);
    let (px, s) = e.render_cpu_tiled(W, H, c, BG, moving).expect("b");
    assert!(!s.exact, "the first frame of a page just shown is coarse: {s:?}");
    assert!(diff(px, &old).is_some(), "the old page shows");
    let mut exact = false;
    for _ in 0..50 {
        let rest = TiledOptions {
            max_jobs: 1,
            ..TiledOptions::default()
        };
        let (px, s) = e.render_cpu_tiled(W, H, c, BG, rest).expect("b");
        if s.exact {
            assert!(diff(px, &fresh(&b, 2, 0, c)).is_none());
            exact = true;
            break;
        }
    }
    assert!(exact);
}

#[test]
fn tiles_drawn_ahead_between_frames_make_the_next_frame_exact() {
    // After a zoom, a frame at rest shows stand-ins; tiles drawn between frames (a few at a
    // time, nearest the view first) leave nothing for the next frame to draw: it's exact, and a
    // fresh engine's frame, without drawing a tile.
    let base = seed() ^ 0x99;
    for case in 0..cases(12) {
        let s = base.wrapping_add(u64::from(case) * 0x9e37_79b9);
        let mut r = Rng(s | 1);
        let n = 6 + r.below(30);
        let model = Model::new(&mut r, n, false);
        let mut e = engine(0, 256);
        e.apply(&model.fresh(1)).expect("fresh list");
        let c0 = cam(1.0, 0.0, 0.0);
        let still = TiledOptions {
            max_jobs: 0,
            ..TiledOptions::default()
        };
        e.render_cpu_tiled(W, H, c0, BG, TiledOptions::default())
            .expect("frame");
        let c1 = cam(f64::from(r.range(0.4, 2.5)), f64::from(r.range(-40.0, 40.0)), 3.5);
        let moving = TiledOptions {
            moving: true,
            max_jobs: 0,
            ..TiledOptions::default()
        };
        e.render_cpu_tiled(W, H, c1, BG, moving).expect("zoom frame");
        let (_, rest) = e.render_cpu_tiled(W, H, c1, BG, still).expect("rest frame");
        let mut passes = 0;
        loop {
            let a = e.render_cpu_ahead(BG, 2).expect("ahead");
            passes += 1;
            if a.pending == 0 {
                break;
            }
            assert!(a.tiles_drawn > 0, "seed {s}: drawing ahead made no progress");
            assert!(passes < 200, "seed {s}: drawing ahead never finished");
        }
        let (px, stats) = e.render_cpu_tiled(W, H, c1, BG, still).expect("next frame");
        assert!(stats.exact, "seed {s}: {stats:?} (after {rest:?})");
        assert_eq!(stats.tiles_drawn, 0, "seed {s}: the frame drew what was drawn ahead");
        let want = fresh(&model, 1, 0, c1);
        assert!(diff(px, &want).is_none(), "seed {s}: differs from a fresh engine");
    }
}

/// A patch moving `ids` by (`dx`, `dy`) (transforms only: a drag's move).
fn drag_patch(model: &mut Model, ids: &[u32], dx: f64, dy: f64, base: u32) -> Vec<u8> {
    let mut w = W::new(base, base + 1);
    for id in ids {
        if let Some((_, rec)) = model.nodes.get_mut(id) {
            rec.transform[4] += dx;
            rec.transform[5] += dy;
            w.transform(*id, rec.transform);
        }
    }
    w.finish()
}

/// The largest channel difference, and how many channels differ by more than 1.
fn spread(a: &[u8], b: &[u8]) -> (u8, usize) {
    let mut worst = 0;
    let mut over = 0;
    for (x, y) in a.iter().zip(b) {
        let d = x.abs_diff(*y);
        worst = worst.max(d);
        if d > 1 {
            over += 1;
        }
    }
    (worst, over)
}

#[derive(Default, Debug)]
struct DragCounts {
    composited: u32,
    eligible: u32,
    ineligible: u32,
    worst: u8,
    over: usize,
    exact: u32,
}

/// A seeded drag: a random run of siblings moved over several frames with no budget for tiles,
/// then left at rest until exact.
fn drag_run(s: u64, counts: &mut DragCounts) {
    let mut r = Rng(s | 1);
    let n = 8 + r.below(30);
    let mut model = Model::new(&mut r, n, false);
    let mut e = engine(0, 128);
    let mut revision = 1;
    e.apply(&model.fresh(revision)).expect("fresh");
    let c = cam(
        f64::from(r.range(0.7, 1.4)),
        f64::from(r.range(-20.0, 20.0)).round(),
        0.0,
    );
    let rest = TiledOptions::default();
    let moving = TiledOptions {
        moving: true,
        max_jobs: 0,
        ..TiledOptions::default()
    };
    assert!(e.render_cpu_tiled(W, H, c, BG, rest).expect("frame").1.exact);
    // A random run of consecutive siblings; sometimes not consecutive (no fast path).
    let parents: Vec<u32> = std::iter::once(0)
        .chain(model.nodes.keys().copied())
        .filter(|p| model.children.get(p).is_some_and(|l| !l.is_empty()))
        .collect();
    let parent = parents[r.below(parents.len() as u32) as usize];
    let list = model.children[&parent].clone();
    let a = r.below(list.len() as u32) as usize;
    let b = (a + r.below(3) as usize).min(list.len() - 1);
    let mut ids: Vec<u32> = list[a..=b].to_vec();
    if r.chance(0.25) && list.len() > 2 && b + 1 < list.len() - 1 {
        // A gap: the first and the one after the next.
        ids = vec![list[a], list[(b + 2).min(list.len() - 1)]];
    }
    let mut edited = false;
    for step in 0..5 {
        if step == 2 && r.chance(0.5) {
            edited = true;
            // An edit mid-drag (a collaborator's, text re-shaped): beside the selection the drag
            // goes on with its parts drawn again there; on it, or changing structure, it ends.
            let edit = model.edit(&mut r, revision, revision + 1);
            e.apply(&edit)
                .unwrap_or_else(|err| panic!("seed {s}: edit refused: {err}"));
            revision += 1;
            ids.retain(|id| model.nodes.contains_key(id));
            if ids.is_empty() {
                break;
            }
        }
        let (dx, dy) = (f64::from(r.range(-25.0, 25.0)), f64::from(r.range(-20.0, 20.0)));
        let patch = drag_patch(&mut model, &ids, dx, dy, revision);
        e.apply(&patch)
            .unwrap_or_else(|err| panic!("seed {s} step {step}: move refused: {err}"));
        revision += 1;
        let eligible = e.dragging.as_ref().is_some_and(|d| d.split.is_some());
        let (px, stats) = e
            .render_cpu_tiled(W, H, c, BG, moving)
            .map(|(p, s)| (p.to_vec(), s))
            .expect("drag frame");
        let px = px.as_slice();
        let want = fresh(&model, revision, 0, c);
        if stats.exact {
            counts.exact += 1;
            assert!(
                diff(px, &want).is_none(),
                "seed {s} step {step}: an exact drag frame differs from fresh"
            );
        } else if stats.dragged > 0 {
            assert!(eligible, "seed {s} step {step}: composited a drag without a fast path");
            counts.composited += 1;
            // After an edit, tiles it touched elsewhere stand in stale (reported, never exact):
            // only a drag with nothing else changing is held to rounding everywhere.
            if !edited {
                let (worst, over) = spread(px, &want);
                counts.worst = counts.worst.max(worst);
                counts.over += over;
                assert!(
                    worst <= 4,
                    "seed {s} step {step}: the drag's composite is {worst} levels from a fresh frame"
                );
            }
        }
        if eligible {
            counts.eligible += 1;
        } else {
            counts.ineligible += 1;
            // No fast path: the selection is drawn at its real position, so the frame is exact
            // (unless an edit left tiles elsewhere standing in stale).
            assert!(
                stats.exact || edited,
                "seed {s} step {step}: a drag without a fast path wasn't exact: {stats:?}"
            );
        }
    }
    // Dropped: at rest, exact and fresh within a bounded number of frames.
    let mut exact = false;
    for _ in 0..100 {
        let (px, stats) = e
            .render_cpu_tiled(W, H, c, BG, TiledOptions { max_jobs: 1, ..rest })
            .expect("rest frame");
        if stats.exact {
            let want = fresh(&model, revision, 0, c);
            if let Some((x, y)) = diff(px, &want) {
                let i = ((y * W + x) * 4) as usize;
                let (worst, over) = spread(px, &want);
                panic!(
                    "seed {s}: rest frame differs at ({x}, {y}): got {:?} want {:?} (worst {worst}, over {over})",
                    &px[i..i + 4],
                    &want[i..i + 4],
                );
            }
            exact = true;
            break;
        }
    }
    assert!(exact, "seed {s}: never became exact after the drag");
}

#[test]
fn drags_composite_within_rounding_and_settle_exact() {
    let base = seed() ^ 0xd7a9;
    let mut counts = DragCounts::default();
    for case in 0..cases(60) {
        let s = base.wrapping_add(u64::from(case) * 0x9e37_79b9);
        if let Some(one) = std::env::var("FUZZ_ONE").ok().and_then(|v| v.parse::<u64>().ok())
            && one != s
        {
            continue;
        }
        drag_run(s, &mut counts);
    }
    eprintln!("{counts:?}");
    assert!(
        counts.composited > 20 && counts.ineligible > 0,
        "the drags exercised too little: {counts:?}"
    );
}

#[test]
fn a_drag_into_a_board_is_a_removal_and_an_insertion() {
    // Two boards side by side, a layer in the first, dragged over the second and dropped in it
    // (reparented, as the editor does on drop, or as a provisional parent mid-drag).
    let mut model = Model {
        nodes: std::collections::BTreeMap::new(),
        children: std::collections::HashMap::new(),
        next: 1,
        readers: false,
    };
    let board = |x: f64, color: [f32; 4]| {
        let mut b = Rec::new([1.0, 0.0, 0.0, 1.0, x, 10.0], [70.0, 90.0]);
        b.paths.push(Entry::Rect {
            w: 70.0,
            h: 90.0,
            radii: [6.0; 4],
        });
        b.ops.push(Op::Fill {
            path: 0,
            even_odd: false,
            paint: Paint::Solid(color),
        });
        b.ops.push(Op::Clip {
            path: 0,
            even_odd: false,
        });
        b.ops.push(Op::Children);
        b.ops.push(Op::Unclip);
        b
    };
    let mut layer = Rec::new([1.0, 0.0, 0.0, 1.0, 10.0, 20.0], [30.0, 24.0]);
    layer.paths.push(Entry::Ellipse { w: 30.0, h: 24.0 });
    layer.ops.push(Op::Fill {
        path: 0,
        even_odd: false,
        paint: Paint::Solid([0.9, 0.2, 0.1, 0.8]),
    });
    model.nodes.insert(1, (0, board(5.0, [1.0, 1.0, 1.0, 1.0])));
    model.nodes.insert(2, (0, board(85.0, [0.85, 0.9, 1.0, 1.0])));
    model.nodes.insert(3, (1, layer));
    model.children.insert(0, vec![1, 2]);
    model.children.insert(1, vec![3]);
    model.next = 4;
    let mut e = engine(0, 64);
    e.apply(&model.fresh(1)).expect("fresh");
    let c = cam(1.0, 0.0, 0.0);
    let moving = TiledOptions {
        moving: true,
        max_jobs: 0,
        ..TiledOptions::default()
    };
    assert!(
        e.render_cpu_tiled(W, H, c, BG, TiledOptions::default())
            .expect("frame")
            .1
            .exact
    );
    let mut revision = 1;
    for _ in 0..4 {
        let patch = drag_patch(&mut model, &[3], 18.0, 2.0, revision);
        e.apply(&patch).expect("move");
        revision += 1;
        let (px, stats) = e.render_cpu_tiled(W, H, c, BG, moving).expect("drag frame");
        assert!(stats.dragged > 0 || stats.exact, "{stats:?}");
        let (worst, _) = spread(px, &fresh(&model, revision, 0, c));
        assert!(worst <= 4, "the drag's composite is {worst} levels off");
    }
    // Dropped into the second board, at the same place on the page.
    let (_, mut rec) = model.nodes[&3].clone();
    rec.transform[4] -= 80.0;
    model.nodes.insert(3, (2, rec.clone()));
    model.children.insert(1, vec![]);
    model.children.insert(2, vec![3]);
    let mut w = W::new(revision, revision + 1);
    w.set(3, 2, &rec);
    w.order(2, &[3]);
    e.apply(&w.finish()).expect("drop");
    revision += 1;
    assert!(e.dragging.is_none(), "a reparent ends the drag");
    // Then dragged on inside its new board: a new drag, split at its new place in paint order.
    for _ in 0..2 {
        let patch = drag_patch(&mut model, &[3], -6.0, 9.0, revision);
        e.apply(&patch).expect("move");
        revision += 1;
        let (px, _) = e.render_cpu_tiled(W, H, c, BG, moving).expect("drag frame");
        let (worst, _) = spread(px, &fresh(&model, revision, 0, c));
        assert!(
            worst <= 4,
            "the drag's composite in the new board is {worst} levels off"
        );
    }
    let (px, stats) = e.render_cpu_tiled(W, H, c, BG, TiledOptions::default()).expect("rest");
    assert!(stats.exact);
    assert!(diff(px, &fresh(&model, revision, 0, c)).is_none());
}

#[test]
fn a_record_sent_again_unchanged_changes_nothing_and_keeps_the_drag() {
    // The builder sends text still waiting for its faces again with every patch: the same
    // record, where it already is. It must neither end a drag nor dirty anything.
    let mut r = Rng(0x5a3e);
    let mut model = Model::new(&mut r, 12, false);
    let mut e = engine(0, 64);
    e.apply(&model.fresh(1)).expect("fresh");
    // The page drawn once at rest, as the editor would have, before the drag.
    let at_rest = e
        .render_cpu_tiled(W, H, cam(1.0, 0.0, 0.0), BG, TiledOptions::default())
        .expect("frame");
    assert!(at_rest.1.exact);
    let top = model.children[&0][0];
    let other = *model.children[&0].last().expect("two");
    let patch = drag_patch(&mut model, &[top], 5.0, 3.0, 1);
    e.apply(&patch).expect("move");
    let serial = e.dragging.as_ref().map(|d| d.serial);
    assert!(serial.is_some());
    // The same record again, with a move.
    let (p, rec) = model.nodes[&other].clone();
    let mut w = W::new(2, 3);
    w.set(other, p, &rec);
    let (_, moved) = model.nodes.get_mut(&top).expect("top").clone();
    let mut t = moved.transform;
    t[4] += 4.0;
    model.nodes.get_mut(&top).expect("top").1.transform = t;
    w.transform(top, t);
    let applied = e.apply(&w.finish()).expect("move and resend");
    assert_eq!(applied.moved.as_deref(), Some(&[top][..]));
    assert_eq!(e.dragging.as_ref().map(|d| d.serial), serial, "the drag goes on");
    // Only the same record again: nothing changes, nothing to draw.
    let mut w = W::new(3, 4);
    w.set(other, p, &rec);
    let applied = e.apply(&w.finish()).expect("resend");
    assert!(applied.noop && applied.changes.is_empty());
    assert_eq!(e.dragging.as_ref().map(|d| d.serial), serial);
    // A real change elsewhere doesn't end it either: the parts round the selection are drawn
    // again where it changed them, and the drag's frames stay within rounding of a fresh frame.
    let mut changed = rec.clone();
    changed.opacity = 0.5;
    model.nodes.insert(other, (p, changed.clone()));
    let mut w = W::new(4, 5);
    w.set(other, p, &changed);
    e.apply(&w.finish()).expect("change");
    assert_eq!(e.dragging.as_ref().map(|d| d.serial), serial);
    // One more move, then a frame free to draw every tile but those under the moving
    // selection (which the drag composites from its parts): if the edit hadn't redrawn the parts
    // where it changed them, the composite would show it as it was.
    let c = cam(1.0, 0.0, 0.0);
    e.apply(&drag_patch(&mut model, &[top], 3.0, 2.0, 5)).expect("move");
    let moving = TiledOptions {
        moving: true,
        ..TiledOptions::default()
    };
    let (px, _) = e.render_cpu_tiled(W, H, c, BG, moving).expect("frame");
    let (worst, _) = spread(px, &fresh(&model, 6, 0, c));
    assert!(worst <= 4, "the drag's parts went stale: {worst} levels off");
    // A change to the selection itself ends it.
    let (sp, mut srec) = model.nodes[&top].clone();
    srec.opacity = 0.4;
    model.nodes.insert(top, (sp, srec.clone()));
    let mut w = W::new(6, 7);
    w.set(top, sp, &srec);
    e.apply(&w.finish()).expect("change the selection");
    assert!(e.dragging.is_none());
}

#[test]
fn a_record_set_back_after_a_move_is_set_back() {
    // A record moved by transforms, then set again with the bytes it first had (its old place):
    // that's a change, not the same record sent again.
    let mut r = Rng(0x6a5);
    let mut model = Model::new(&mut r, 6, false);
    let mut e = engine(0, 64);
    e.apply(&model.fresh(1)).expect("fresh");
    let id = model.children[&0][0];
    let (p, original) = model.nodes[&id].clone();
    e.apply(&drag_patch(&mut model, &[id], 30.0, 12.0, 1)).expect("move");
    let mut w = W::new(2, 3);
    w.set(id, p, &original);
    let applied = e.apply(&w.finish()).expect("set back");
    assert!(!applied.noop, "setting it back is a change");
    model.nodes.insert(id, (p, original));
    let c = cam(1.0, 0.0, 0.0);
    let (px, stats) = e.render_cpu_tiled(W, H, c, BG, TiledOptions::default()).expect("frame");
    assert!(stats.exact);
    assert!(diff(px, &fresh(&model, 3, 0, c)).is_none());
}

#[test]
fn a_dragged_layer_passes_under_what_is_painted_after_its_board() {
    // A board (no clip) holding a layer, and a shape painted after the board, far from it. The
    // layer is dragged out of the board's area and under the shape: the shape stays above it.
    // (The random drags found the case where a board on the selection's path is culled from a
    // tile, which once left what follows it in the part below; `exec::Walk::node` now moves
    // past the selection after any node on its path, walked or not.)
    let mut model = Model {
        nodes: std::collections::BTreeMap::new(),
        children: std::collections::HashMap::new(),
        next: 4,
        readers: false,
    };
    let shape = |t: [f64; 6], w: f32, h: f32, color: [f32; 4], children: bool| {
        let mut r = Rec::new(t, [w, h]);
        r.paths.push(Entry::Rect { w, h, radii: [0.0; 4] });
        r.ops.push(Op::Fill {
            path: 0,
            even_odd: false,
            paint: Paint::Solid(color),
        });
        if children {
            r.ops.push(Op::Children);
        }
        r
    };
    model.nodes.insert(
        1,
        (
            0,
            shape([1.0, 0.0, 0.0, 1.0, 5.0, 5.0], 40.0, 40.0, [1.0, 1.0, 1.0, 1.0], true),
        ),
    );
    model.nodes.insert(
        2,
        (
            1,
            shape([1.0, 0.0, 0.0, 1.0, 5.0, 5.0], 20.0, 20.0, [0.1, 0.6, 0.2, 0.7], false),
        ),
    );
    model.nodes.insert(
        3,
        (
            0,
            shape(
                [1.0, 0.0, 0.0, 1.0, 100.0, 60.0],
                50.0,
                50.0,
                [0.68, 0.16, 1.0, 1.0],
                false,
            ),
        ),
    );
    model.children.insert(0, vec![1, 3]);
    model.children.insert(1, vec![2]);
    let mut e = engine(0, 64);
    e.apply(&model.fresh(1)).expect("fresh");
    let c = cam(1.0, 0.0, 0.0);
    assert!(
        e.render_cpu_tiled(W, H, c, BG, TiledOptions::default())
            .expect("frame")
            .1
            .exact
    );
    let moving = TiledOptions {
        moving: true,
        max_jobs: 0,
        ..TiledOptions::default()
    };
    let mut revision = 1;
    for _ in 0..6 {
        let patch = drag_patch(&mut model, &[2], 18.0, 11.0, revision);
        e.apply(&patch).expect("move");
        revision += 1;
        assert!(e.dragging.as_ref().is_some_and(|d| d.split.is_some()));
        let (px, _) = e.render_cpu_tiled(W, H, c, BG, moving).expect("drag frame");
        let (worst, _) = spread(px, &fresh(&model, revision, 0, c));
        assert!(
            worst <= 4,
            "the layer was drawn over what's painted after its board: {worst} levels off"
        );
    }
}

#[test]
fn a_provisional_record_is_drawn_coarse_and_never_exact() {
    // Text sent ahead of its shaping (a page opening): its coarse ops at every scale, a stand-in
    // until the whole record replaces it.
    let mut r = Rng(0x7e47);
    let mut model = Model::new(&mut r, 4, false);
    let mut rec = Rec::new([1.0, 0.0, 0.0, 1.0, 20.0, 20.0], [80.0, 30.0]);
    rec.paths.push(Entry::Rect {
        w: 80.0,
        h: 30.0,
        radii: [0.0; 4],
    });
    rec.ops.push(Op::Fill {
        path: 0,
        even_odd: false,
        paint: Paint::Solid([0.1, 0.1, 0.8, 1.0]),
    });
    rec.paths.push(Entry::Rect {
        w: 80.0,
        h: 12.0,
        radii: [0.0; 4],
    });
    rec.coarse.push(Op::Fill {
        path: 1,
        even_odd: false,
        paint: Paint::Solid([0.2, 0.2, 0.2, 0.55]),
    });
    rec.coarse_below = 0.01;
    let mut provisional = rec.clone();
    provisional.flags |= 8;
    let id = model.next;
    model.next += 1;
    model.nodes.insert(id, (0, provisional));
    model.children.entry(0).or_default().push(id);
    let mut e = engine(0, 64);
    e.apply(&model.fresh(1)).expect("fresh");
    let c = cam(1.0, 0.0, 0.0);
    let (_, s) = e.render_cpu_tiled(W, H, c, BG, TiledOptions::default()).expect("frame");
    assert!(
        !s.exact && s.draw.coarse > 0,
        "a provisional record is a stand-in: {s:?}"
    );
    // The whole record arrives.
    model.nodes.insert(id, (0, rec.clone()));
    let mut w = W::new(1, 2);
    w.set(id, 0, &rec);
    e.apply(&w.finish()).expect("whole");
    let (px, s) = e.render_cpu_tiled(W, H, c, BG, TiledOptions::default()).expect("frame");
    assert!(s.exact);
    assert!(diff(px, &fresh(&model, 2, 0, c)).is_none());
}

#[test]
fn an_edit_above_a_dragged_layer_redraws_the_drags_parts() {
    // A layer dragged under a translucent shape painted after it; the shape changes colour
    // mid-drag. The part above the selection, kept for the drag, must be drawn again there.
    let mut model = Model {
        nodes: std::collections::BTreeMap::new(),
        children: std::collections::HashMap::new(),
        next: 4,
        readers: false,
    };
    let rect = |t: [f64; 6], w: f32, h: f32, color: [f32; 4]| {
        let mut r = Rec::new(t, [w, h]);
        r.paths.push(Entry::Rect { w, h, radii: [0.0; 4] });
        r.ops.push(Op::Fill {
            path: 0,
            even_odd: false,
            paint: Paint::Solid(color),
        });
        r
    };
    model.nodes.insert(
        1,
        (
            0,
            rect([1.0, 0.0, 0.0, 1.0, 0.0, 0.0], 160.0, 120.0, [1.0, 1.0, 1.0, 1.0]),
        ),
    );
    model.nodes.insert(
        2,
        (
            0,
            rect([1.0, 0.0, 0.0, 1.0, 30.0, 30.0], 40.0, 30.0, [0.1, 0.5, 0.9, 1.0]),
        ),
    );
    model.nodes.insert(
        3,
        (
            0,
            rect([1.0, 0.0, 0.0, 1.0, 10.0, 10.0], 140.0, 100.0, [0.9, 0.2, 0.1, 0.5]),
        ),
    );
    model.children.insert(0, vec![1, 2, 3]);
    let mut e = engine(0, 64);
    e.apply(&model.fresh(1)).expect("fresh");
    let c = cam(1.0, 0.0, 0.0);
    assert!(
        e.render_cpu_tiled(W, H, c, BG, TiledOptions::default())
            .expect("rest")
            .1
            .exact
    );
    let moving = TiledOptions {
        moving: true,
        ..TiledOptions::default()
    };
    e.apply(&drag_patch(&mut model, &[2], 7.0, 4.0, 1)).expect("move");
    let _ = e.render_cpu_tiled(W, H, c, BG, moving).expect("drag frame");
    // The shape above changes colour.
    let (_, mut over) = model.nodes[&3].clone();
    over.ops[0] = Op::Fill {
        path: 0,
        even_odd: false,
        paint: Paint::Solid([0.1, 0.8, 0.2, 0.5]),
    };
    model.nodes.insert(3, (0, over.clone()));
    let mut w = W::new(2, 3);
    w.set(3, 0, &over);
    e.apply(&w.finish()).expect("recolour");
    assert!(e.dragging.is_some(), "an edit beside the drag keeps it");
    e.apply(&drag_patch(&mut model, &[2], 7.0, 4.0, 3)).expect("move");
    let (px, s) = e.render_cpu_tiled(W, H, c, BG, moving).expect("drag frame");
    assert!(s.dragged > 0, "{s:?}");
    let (worst, _) = spread(px, &fresh(&model, 4, 0, c));
    assert!(worst <= 4, "the part above the drag went stale: {worst} levels off");
}
