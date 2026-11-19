//! Property and fuzz tests for the render graph (review items 1 and 6):
//!
//! - random scenes and random sequences of patches (insert, remove, reorder, move to another
//!   parent, change a record, transform only) never crash, and after every patch the patched
//!   engine's picture equals a fresh engine's, given the whole list, pixel for pixel;
//! - every pixel a patch changes lies inside the dirty region the patch reported, including
//!   pixels a backdrop reader changes because something beneath it moved (transitively);
//! - a message that fails changes nothing (transactions), and stale revisions are refused;
//! - random and mutated bytes never panic.
//!
//! `FUZZ_SEED` and `FUZZ_CASES` widen a run (`pnpm --filter @drawpane/engine fuzz`).

mod common;

use common::model::*;
use common::*;
use drawpane_engine::engine::{Camera, Engine};
use drawpane_engine::error::ErrorCode;
use drawpane_engine::limits::Limits;

const W_PX: u32 = 160;
const H_PX: u32 = 120;

fn engine() -> Engine {
    let mut e = Engine::new(Limits::default());
    let mut px = vec![0u8; 8 * 8 * 4];
    for (i, p) in px.as_chunks_mut::<4>().0.iter_mut().enumerate() {
        p.copy_from_slice(&[(i * 31) as u8, (i * 7) as u8, 200, if i % 3 == 0 { 128 } else { 255 }]);
    }
    e.put_image(IMAGE, 8, 8, &px, false).expect("image");
    e
}

fn render(e: &mut Engine, cam: Camera) -> Vec<u8> {
    let (px, _) = e
        .render_cpu(W_PX, H_PX, cam, [1.0, 1.0, 1.0, 1.0], true)
        .unwrap_or_else(|err| panic!("render: {err}"));
    px.to_vec()
}

fn seed() -> u64 {
    match std::env::var("FUZZ_SEED").ok().as_deref() {
        Some("random") => {
            let s = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(1, |d| d.as_nanos() as u64);
            eprintln!("FUZZ_SEED={s}");
            s
        }
        Some(v) => v.parse().unwrap_or(0x5eed_0040),
        None => 0x5eed_0040,
    }
}
fn cases(default: u32) -> u32 {
    std::env::var("FUZZ_CASES")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(default)
}

fn run_sequences(readers: bool, default_cases: u32) {
    let base = seed() ^ if readers { 0xabcd } else { 0 };
    let mut changed_pixels = 0u64;
    for case in 0..cases(default_cases) {
        let s = base.wrapping_add(u64::from(case) * 0x9e37_79b9);
        if let Some(one) = std::env::var("FUZZ_ONE").ok().and_then(|v| v.parse::<u64>().ok())
            && one != s
        {
            continue;
        }
        let mut r = Rng(s | 1);
        let n = 4 + r.below(24);
        let mut model = Model::new(&mut r, n, readers);
        let cam = Camera {
            zoom: f64::from(r.range(0.5, 1.4)),
            x: f64::from(r.range(-20.0, 20.0)),
            y: f64::from(r.range(-20.0, 20.0)),
            dpr: 1.0,
        };
        let mut patched = engine();
        let mut revision = 1;
        patched
            .apply(&model.fresh(revision))
            .unwrap_or_else(|e| panic!("seed {s}: fresh list refused: {e}"));
        let mut before = render(&mut patched, cam);
        for step in 0..12 {
            let patch = model.edit(&mut r, revision, revision + 1);
            let applied = patched
                .apply(&patch)
                .unwrap_or_else(|e| panic!("seed {s} step {step}: patch refused: {e}"));
            revision += 1;
            let after = render(&mut patched, cam);
            let mut fresh = engine();
            fresh
                .apply(&model.fresh(revision))
                .unwrap_or_else(|e| panic!("seed {s} step {step}: fresh refused: {e}"));
            let expected = render(&mut fresh, cam);
            if let Some(i) = after.iter().zip(&expected).position(|(a, b)| a != b) {
                let px = i / 4;
                panic!(
                    "seed {s} step {step}: patched and fresh differ at ({}, {})",
                    px as u32 % W_PX,
                    px as u32 / W_PX
                );
            }
            // Every changed pixel lies in the dirty region (device pixels, a pixel of anti-aliasing round it).
            if !applied.full {
                let rects = patched.store.dirty(&applied.changes, cam.view(), 1.5);
                if std::env::var("FUZZ_ONE").is_ok() {
                    for c in &applied.changes {
                        eprintln!(
                            "step {step} change {c:?} device {:?}",
                            cam.view().transform_rect_bbox(c.rect)
                        );
                    }
                    for id in patched.store.readers().to_vec() {
                        let order = patched.store.order_of(id);
                        let n = &patched.store.nodes[&id];
                        eprintln!(
                            "reader {id} order {:?} parent {} size {:?} halo {:?} world {:?}",
                            order,
                            n.parent,
                            n.record.size,
                            n.record.reads(),
                            cam.view() * patched.store.world(id)
                        );
                    }
                    for (id, (p, rec)) in &model.nodes {
                        eprintln!(
                            "model {id} parent {p} flags {} t {:?} size {:?} ops {:?}",
                            rec.flags,
                            rec.transform,
                            rec.size,
                            rec.ops
                                .iter()
                                .map(|o| format!("{o:?}").chars().take(30).collect::<String>())
                                .collect::<Vec<_>>()
                        );
                    }
                }
                for (i, (a, b)) in before
                    .as_chunks::<4>()
                    .0
                    .iter()
                    .zip(after.as_chunks::<4>().0.iter())
                    .enumerate()
                {
                    if a != b {
                        changed_pixels += 1;
                        let (x, y) = ((i as u32 % W_PX) as f64 + 0.5, (i as u32 / W_PX) as f64 + 0.5);
                        assert!(
                            rects.iter().any(|r| r.contains((x, y))),
                            "seed {s} step {step}: pixel ({x}, {y}) changed outside the dirty region {rects:?}"
                        );
                    }
                }
            }
            before = after;
            // Now and then the warmed engine (its glyph masks and images cached) takes a fresh
            // list in place of its graph, as a page switch does: it must draw what a new one does.
            if step % 4 == 3 {
                revision += 1;
                patched
                    .apply(&model.fresh(revision))
                    .unwrap_or_else(|e| panic!("seed {s} step {step}: fresh replacement refused: {e}"));
                let replaced = render(&mut patched, cam);
                assert!(
                    replaced == expected,
                    "seed {s} step {step}: a fresh list on a warmed engine differs from a new engine's"
                );
                before = replaced;
            }
        }
    }
    assert!(changed_pixels > 0, "the edits changed nothing: the test tests nothing");
}

#[test]
fn patches_equal_a_fresh_build() {
    run_sequences(false, 60);
}

#[test]
fn readers_are_invalidated_transitively() {
    run_sequences(true, 60);
}

#[test]
fn a_failing_message_changes_nothing() {
    let mut r = Rng(7);
    let model = Model::new(&mut r, 12, false);
    let mut e = engine();
    e.apply(&model.fresh(1)).expect("fresh");
    let cam = Camera {
        zoom: 1.0,
        x: 0.0,
        y: 0.0,
        dpr: 1.0,
    };
    let before = render(&mut e, cam);
    // A good command, then one naming a record that isn't there.
    let mut w = W::new(1, 2);
    w.transform(1, [1.0, 0.0, 0.0, 1.0, 50.0, 50.0]);
    w.remove(9999);
    let err = e.apply(&w.finish()).expect_err("refused");
    assert_eq!(err.code, ErrorCode::Unknown);
    assert_eq!(e.store.revision, 1);
    assert_eq!(render(&mut e, cam), before, "the first command was undone");
    // A patch for an old revision is refused.
    let mut w = W::new(0, 5);
    w.remove(1);
    assert_eq!(e.apply(&w.finish()).expect_err("stale").code, ErrorCode::Revision);
}

#[test]
fn cycles_and_bad_orders_are_refused() {
    let mut e = engine();
    let mut w = W::new(ANY, 1);
    w.reset();
    w.set(1, 0, &Rec::group());
    w.set(2, 1, &Rec::group());
    e.apply(&w.finish()).expect("fresh");
    let mut w = W::new(1, 2);
    w.set(1, 2, &Rec::group());
    assert_eq!(e.apply(&w.finish()).expect_err("cycle").code, ErrorCode::Malformed);
    let mut w = W::new(1, 2);
    w.order(0, &[1, 1]);
    assert_eq!(e.apply(&w.finish()).expect_err("order").code, ErrorCode::Malformed);
    assert_eq!(e.store.len(), 2);
}

#[test]
fn random_bytes_never_panic() {
    let mut r = Rng(seed() | 1);
    let model = Model::new(&mut r, 20, true);
    let good = model.fresh(1);
    for _ in 0..cases(3000) {
        let mut bytes = good.clone();
        match r.below(4) {
            0 => {
                for _ in 0..1 + r.below(8) {
                    let i = r.below(bytes.len() as u32) as usize;
                    bytes[i] = r.next() as u8;
                }
            }
            1 => bytes.truncate(r.below(bytes.len() as u32) as usize),
            2 => {
                let i = r.below(bytes.len() as u32) as usize;
                bytes[i..].iter_mut().for_each(|b| *b = r.next() as u8);
            }
            _ => {
                // A float set to NaN or infinity somewhere.
                let i = (r.below(bytes.len() as u32 / 4) * 4) as usize;
                let v = [f32::NAN, f32::INFINITY, -1e30, 1e30][r.below(4) as usize];
                bytes[i..i + 4].copy_from_slice(&v.to_le_bytes());
            }
        }
        let mut e = engine();
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _ = e.apply(&bytes);
            let _ = e.render_cpu(
                64,
                48,
                Camera {
                    zoom: 1.0,
                    x: 0.0,
                    y: 0.0,
                    dpr: 1.0,
                },
                [1.0; 4],
                true,
            );
        }));
        assert!(result.is_ok(), "a mutated list panicked");
    }
}

#[test]
fn limits_are_enforced() {
    let mut e = Engine::new(Limits {
        records: 10,
        ..Limits::default()
    });
    let mut w = W::new(ANY, 1);
    w.reset();
    for id in 1..20 {
        w.set(id, 0, &Rec::group());
    }
    assert_eq!(e.apply(&w.finish()).expect_err("records").code, ErrorCode::Limit);
    assert!(e.store.is_empty());
    let cam = Camera {
        zoom: 1.0,
        x: 0.0,
        y: 0.0,
        dpr: 1.0,
    };
    assert_eq!(
        e.render_cpu(9000, 10, cam, [1.0; 4], false).expect_err("size").code,
        ErrorCode::Limit
    );
    assert_eq!(
        e.put_image(1, 9000, 1, &vec![0; 9000 * 4], false)
            .expect_err("image")
            .code,
        ErrorCode::Limit
    );
}

#[test]
fn tiles_reproduce_the_whole_frame() {
    for case in 0..cases(20) {
        let mut r = Rng(seed().wrapping_add(u64::from(case) * 77) | 1);
        let model = Model::new(&mut r, 24, case % 2 == 0);
        let mut e = engine();
        // Tiles narrower than the frame, so a band is several tiles.
        e.store.limits.export_tile = 48;
        e.apply(&model.fresh(1)).expect("fresh");
        let cam = Camera {
            zoom: 1.0,
            x: 0.0,
            y: 0.0,
            dpr: 1.0,
        };
        let (whole, _) = e.render_cpu(W_PX, H_PX, cam, [1.0; 4], false).expect("whole");
        let whole = whole.to_vec();
        let mut banded = Vec::new();
        let mut y = 0;
        while y < H_PX {
            let rows = 32.min(H_PX - y);
            banded.extend_from_slice(e.render_band(W_PX, H_PX, cam, [1.0; 4], y, rows).expect("band"));
            y += rows;
        }
        let differing = whole
            .as_chunks::<4>()
            .0
            .iter()
            .zip(banded.as_chunks::<4>().0.iter())
            .filter(|(a, b)| a != b)
            .count();
        let worst = whole
            .iter()
            .zip(&banded)
            .map(|(a, b)| a.abs_diff(*b))
            .max()
            .unwrap_or(0);
        let at: Vec<(u32, u32)> = whole
            .as_chunks::<4>()
            .0
            .iter()
            .zip(banded.as_chunks::<4>().0.iter())
            .enumerate()
            .filter(|(_, (a, b))| a != b)
            .map(|(i, _)| (i as u32 % W_PX, i as u32 / W_PX))
            .take(8)
            .collect();
        if differing > 0 {
            eprintln!("case {case}: readers {:?}, differing at {at:?}", e.store.readers());
        }
        assert!(
            differing == 0,
            "case {case}: {differing} pixels differ between bands and the whole frame (worst {worst})"
        );
    }
}

#[test]
fn exports_larger_than_the_cap_are_refused() {
    let mut e = engine();
    let cam = Camera {
        zoom: 2.0,
        x: 0.0,
        y: 0.0,
        dpr: 1.0,
    };
    let err = e.render_band(8193, 100, cam, [1.0; 4], 0, 10).expect_err("too wide");
    assert_eq!(err.code, ErrorCode::Limit);
    assert!(err.message.contains("8192"), "{}", err.message);
    assert!(e.render_band(8192, 8192, cam, [1.0; 4], 8128, 64).is_ok());
    // A band of more than 2 MiB is refused with the limit named.
    let err = e.render_band(8192, 8192, cam, [1.0; 4], 0, 65).expect_err("too tall");
    assert_eq!(err.code, ErrorCode::Limit);
}
