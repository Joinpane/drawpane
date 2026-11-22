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

/// The SplitMix64 finalizer spreads adjacent case keys across the xorshift state.
fn case_rng(key: u64) -> Rng {
    let key = (key ^ (key >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    let key = (key ^ (key >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    Rng((key ^ (key >> 31)).max(1))
}

fn run_sequences(readers: bool, effects: bool, default_cases: u32) {
    let base = seed() ^ if readers { 0xabcd } else { 0 };
    let mut changed_pixels = 0u64;
    for case in 0..cases(default_cases) {
        let s = base.wrapping_add(u64::from(case) * 0x9e37_79b9);
        if let Some(one) = std::env::var("FUZZ_ONE").ok().and_then(|v| v.parse::<u64>().ok())
            && one != s
        {
            continue;
        }
        let mut r = case_rng(s);
        let n = 4 + r.below(24);
        let mut model = Model::new_with_features(&mut r, n, readers, effects);
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
        let store_has_pass = |e: &Engine| -> bool {
            e.store
                .nodes
                .get(&drawpane_engine::store::ROOT)
                .is_some_and(|root| root.children.iter().any(|&c| e.store.subtree_has_pass(c)))
        };
        let mut before = render(&mut patched, cam);
        let mut had_pass = store_has_pass(&patched);
        for step in 0..12 {
            let patch = model.edit(&mut r, revision, revision + 1);
            let applied = patched
                .apply(&patch)
                .unwrap_or_else(|e| panic!("seed {s} step {step}: patch refused: {e}"));
            revision += 1;
            let after = render(&mut patched, cam);
            let has_pass = store_has_pass(&patched);
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
                        let max_diff = a.iter().zip(b).map(|(u, v)| u.abs_diff(*v)).max().unwrap_or(0);
                        if !(had_pass || has_pass) || max_diff > 2 {
                            assert!(
                                rects.iter().any(|r| r.contains((x, y))),
                                "seed {s} step {step}: pixel ({x}, {y}) changed by {max_diff} outside the dirty region {rects:?}"
                            );
                        }
                    }
                }
            }
            before = after;
            had_pass = has_pass;
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
    run_sequences(false, true, 60);
}

#[test]
fn readers_are_invalidated_transitively() {
    run_sequences(true, false, 60);
}

#[test]
fn backdrop_readers_and_composites_match_fresh_after_edits() {
    run_sequences(true, true, 30);
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
    let mut r = case_rng(seed());
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
    let seed = seed();
    for case in 0..cases(20) {
        let key = seed.wrapping_add(u64::from(case) * 77);
        bands_match(case_rng(key), case);
    }
}

#[test]
fn bands_reproduce_the_whole_frame_where_a_run_of_glyphs_crosses_them() {
    // CI's random seed that found a run's image, cut to a band, a level off the whole frame's
    // (vello_cpu rounds an image's pixels by its size): the CPU draws a run's masks one by one.
    bands_match(Rng(1_795_184_124_632_860_535), 27);
}

#[test]
fn bands_reproduce_the_whole_frame_for_rotated_glyph_outlines() {
    // CI found a one-level difference in an outline fill when a band culled other glyphs in the run.
    bands_match(Rng(1_795_215_203_959_853_517), 212);
}

#[test]
fn bands_match_for_a_blurred_glyph_run_shadow() {
    // The tile starting at x = 96 omits the first glyph from the shadow cast.
    // The remaining outlines must rasterize at the same subpixel positions.
    let mut rec = Rec::new(
        [1.0, 0.0, 0.0, 1.0, 69.16212463378906, 31.058765411376953],
        [16.642899, 41.32984],
    );
    rec.flags = 2;
    rec.opacity = 0.71289533;
    rec.paths.push(Entry::Glyphs {
        scale: 0.020390728,
        glyphs: vec![(5, 0.0, 41.32984), (4, 25.620796, 41.32984), (6, 33.070835, 41.32984)],
    });
    rec.ops.push(Op::DropShadow {
        paths: vec![0],
        even_odd: false,
        dx: 2.8119097,
        dy: -8.109604,
        blur: 5.437962,
        color: [0.590207, 0.6368347, 0.32833868, 0.38753042],
        blend: 0,
    });

    let mut w = W::new(ANY, 1);
    w.reset();
    for id in [4, 5, 6] {
        w.glyph(id, &glyph_outline(id));
    }
    w.set(1, 0, &rec);

    assert_bands_match(&w.finish(), "blurred glyph run shadow");
}

/// Draws the given case whole and in bands. Historical regressions pass their original RNG state.
fn bands_match(mut r: Rng, case: u32) {
    let model = Model::new(&mut r, 24, case.is_multiple_of(2));
    assert_bands_match(&model.fresh(1), format_args!("case {case}"));
}

fn assert_bands_match(scene: &[u8], label: impl std::fmt::Display) {
    let mut e = engine();
    // Tiles narrower than the frame, so a band is several tiles.
    e.store.limits.export_tile = 48;
    e.apply(scene).expect("fresh");
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
        eprintln!("{label}: readers {:?}, differing at {at:?}", e.store.readers());
    }
    assert!(
        differing == 0,
        "{label}: {differing} pixels differ between bands and the whole frame (worst {worst})"
    );
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

#[test]
fn removing_a_shadow_keeps_unrelated_blended_pixels() {
    let cam = Camera {
        zoom: 1.3424164056777954,
        x: 9.77043342590332,
        y: 9.752151489257813,
        dpr: 1.0,
    };
    let (w, h) = (72.772865, 53.64728);
    let mut frame = Rec::new([1., 0., 0., 1., -6.497554779052734, 50.14446258544922], [w, h]);
    frame.paths.push(Entry::Rect {
        w,
        h,
        radii: [5.075545, 0., 13.92761, 4.554621],
    });
    frame.ops = vec![
        Op::Fill {
            path: 0,
            even_odd: false,
            paint: Paint::Solid([0.575056, 0.27041346, 0.308474, 1.]),
        },
        Op::Clip {
            path: 0,
            even_odd: false,
        },
        Op::Children,
        Op::Unclip,
        Op::Clip {
            path: 0,
            even_odd: false,
        },
        Op::Stroke {
            path: 0,
            width: 8.668327,
            join: 0,
            cap: 0,
            dashes: vec![1.3157645, 3.659711],
            offset: 0.0,
            paint: Paint::Solid([0.9124175, 0.45539433, 0.84493494, 1.0]),
        },
        Op::Unclip,
    ];

    let (w, h) = (50.042316, 34.208965);
    let mut child = Rec::new([1., 0., 0., 1., -11.81910514831543, 59.47084045410156], [w, h]);
    child.flags = 2;
    child.opacity = 0.7108273;
    child.paths.push(Entry::Ellipse { w, h });
    child.ops = vec![
        Op::DropShadow {
            paths: vec![0],
            even_odd: false,
            dx: 3.403202,
            dy: -9.620993,
            blur: 4.6614447,
            color: [0.3033346, 0.63583434, 0.5370639, 0.43632632],
            blend: 0,
        },
        Op::Fill {
            path: 0,
            even_odd: false,
            paint: Paint::Solid([0.1432299, 0.001193881, 0.2930926, 1.]),
        },
        Op::Clip {
            path: 0,
            even_odd: false,
        },
        Op::Stroke {
            path: 0,
            width: 1.1940131,
            join: 0,
            cap: 0,
            dashes: vec![2.3953164, 1.3487685],
            offset: 0.0,
            paint: Paint::Solid([0.36385566, 0.20120287, 0.40161306, 1.0]),
        },
        Op::Unclip,
    ];

    let mut label = Rec::new(
        [
            0.8941329842053497,
            0.4478015258527329,
            -0.4478015258527329,
            0.8941329842053497,
            14.287452697753906,
            69.68342590332031,
        ],
        [73.91113, 5.2407093],
    );
    label.flags = 2;
    label.opacity = 0.5121845;
    label.layer_blend = 13;
    label.paths.push(Entry::Glyphs {
        scale: 0.021137804,
        glyphs: vec![
            (2, 0., 5.2407093),
            (4, 11.887746, 5.2407093),
            (3, 16.63705, 5.2407093),
            (5, 19.109865, 5.2407093),
            (5, 52.406654, 5.2407093),
        ],
    });
    label.ops.push(Op::Fill {
        path: 0,
        even_odd: false,
        paint: Paint::Solid([0.09701687, 0.4338537, 0.60826266, 1.]),
    });

    let mut text = Rec::new(
        [
            1.129729986190796,
            0.,
            0.,
            1.129729986190796,
            -9.265012741088867,
            16.653560638427734,
        ],
        [71.40791, 44.69925],
    );
    text.paths.push(Entry::Glyphs {
        scale: 0.016062751,
        glyphs: vec![
            (5, 0., 44.69925),
            (6, 12.166812, 44.69925),
            (2, 17.040646, 44.69925),
            (5, 24.879559, 44.69925),
            (4, 27.33095, 44.69925),
        ],
    });
    text.ops.push(Op::Fill {
        path: 0,
        even_odd: false,
        paint: Paint::Solid([0.35829508, 0.41634965, 0.32656687, 1.]),
    });

    let mut list = W::new(ANY, 1);
    list.reset();
    for id in 1..=GLYPHS {
        list.glyph(id, &glyph_outline(id));
    }
    list.set(1, 0, &Rec::group());
    list.set(6, 1, &frame);
    list.set(14, 6, &child);
    list.set(21, 0, &label);
    list.set(23, 0, &text);
    list.order(0, &[1, 23, 21]);
    let mut engine = engine();
    engine.apply(&list.finish()).expect("scene");
    let before = render(&mut engine, cam);
    let mut patch = W::new(1, 2);
    patch.remove(14);
    let applied = engine.apply(&patch.finish()).expect("remove the clipped child");
    let after = render(&mut engine, cam);
    let dirty = engine.store.dirty(&applied.changes, cam.view(), 1.5);
    let pixel = (99 * W_PX as usize + 42) * 4;
    assert!(!dirty.iter().any(|r| r.contains((42.5, 99.5))));
    assert_eq!(&before[pixel..pixel + 4], &after[pixel..pixel + 4]);
}

#[test]
fn removing_a_post_effect_replays_its_enclosing_blend_scope() {
    let cam = Camera {
        zoom: 0.67231285572052,
        x: 17.04401397705078,
        y: -3.1899490356445313,
        dpr: 1.0,
    };
    let (w, h) = (76.516846, 7.971436);
    let mut parent = Rec::new([1.0, 0.0, 0.0, 1.0, 125.52778625488281, 27.114261627197266], [w, h]);
    parent.layer_blend = 8; // Hard light amplifies rounding inside the isolated picture.
    parent.paths.push(Entry::Ellipse { w, h });
    parent.ops = vec![
        Op::Fill {
            path: 0,
            even_odd: false,
            paint: Paint::Solid([0.6339728, 0.34588432, 0.7632257, 1.0]),
        },
        Op::InnerShadow {
            shape: 0,
            hole: Some(0),
            even_odd: false,
            dx: 3.744215,
            dy: 2.7105007,
            blur: 6.0666904,
            color: [0.651453, 0.20278758, 0.00039190054, 0.3968969],
            blend: 0,
        },
        Op::Clip {
            path: 0,
            even_odd: false,
        },
        Op::Children,
        Op::Unclip,
        Op::Clip {
            path: 0,
            even_odd: false,
        },
        Op::Stroke {
            path: 0,
            width: 3.1409926,
            join: 0,
            cap: 0,
            dashes: vec![],
            offset: 0.0,
            paint: Paint::Solid([0.6881718, 0.63965327, 0.04992664, 0.7795898]),
        },
        Op::Unclip,
    ];
    let (w, h) = (73.59229, 58.603302);
    let mut child = Rec::new([1.0, 0.0, 0.0, 1.0, 85.62858581542969, 23.33599853515625], [w, h]);
    child.paths.push(Entry::Rect {
        w,
        h,
        radii: [1.2612097, 0.0, 10.552095, 1.7148013],
    });
    child.ops = vec![
        Op::Fill {
            path: 0,
            even_odd: false,
            paint: Paint::Solid([0.7322975, 0.05596584, 0.9780997, 1.0]),
        },
        Op::Clip {
            path: 0,
            even_odd: false,
        },
        Op::Stroke {
            path: 0,
            width: 4.189373,
            join: 0,
            cap: 0,
            dashes: vec![5.1542583, 3.4690719],
            offset: 0.0,
            paint: Paint::Solid([0.8436228, 0.22885567, 0.3941515, 0.5803918]),
        },
        Op::Unclip,
    ];
    child.post.push(Post::Noise {
        noise_type: 0,
        size: 3.81252,
        density: 58.760143,
        color: [0.90198493, 0.59954596, 0.58126754, 1.0],
        secondary_color: [0.23300016, 0.042927325, 0.66057754, 0.7937112],
        opacity: 0.47280753,
    });
    let mut list = W::new(ANY, 1);
    list.reset();
    list.set(1, 0, &parent);
    list.set(2, 1, &child);
    let mut engine = engine();
    engine.apply(&list.finish()).expect("scene");
    let mut patch = W::new(1, 2);
    patch.remove(2);
    let applied = engine.apply(&patch.finish()).expect("remove the clipped child");
    let dirty = engine.store.dirty(&applied.changes, cam.view(), 1.5);
    assert!(dirty.iter().any(|r| r.contains((136.5, 20.5))));
}

#[test]
fn replacing_a_page_blend_boundary_replays_the_page_scope() {
    let at = |x, y| {
        let mut record = Rec::new([1.0, 0.0, 0.0, 1.0, x, y], [20.0, 20.0]);
        record.paths.push(Entry::Rect {
            w: 20.0,
            h: 20.0,
            radii: [0.0; 4],
        });
        record.ops.push(Op::Fill {
            path: 0,
            even_odd: false,
            paint: Paint::Solid([0.5, 0.5, 0.5, 1.0]),
        });
        record
    };
    let mut blend = at(100.0, 20.0);
    blend.layer_blend = 5; // Lighten forces the pending page scene into the RGBA8 target.
    let mut list = W::new(ANY, 1);
    list.reset();
    list.set(1, 0, &at(10.0, 85.0));
    list.set(2, 0, &blend);
    list.set(3, 0, &at(105.0, 25.0));
    let mut engine = engine();
    engine.apply(&list.finish()).expect("scene");
    let covers_other_paint = |engine: &mut Engine, applied: &drawpane_engine::store::Applied| {
        engine
            .store
            .dirty(&applied.changes, vello_common::kurbo::Affine::IDENTITY, 1.5)
            .iter()
            .any(|rect| rect.contains((17.5, 93.5)))
    };

    let mut ordinary = W::new(1, 2);
    ordinary.transform(3, [1.0, 0.0, 0.0, 1.0, 108.0, 25.0]);
    let applied = engine.apply(&ordinary.finish()).expect("move ordinary fill");
    assert!(!covers_other_paint(&mut engine, &applied));

    let mut replace_blend = W::new(2, 3);
    replace_blend.set(2, 0, &at(135.0, 60.0));
    let applied = engine.apply(&replace_blend.finish()).expect("replace the blend");
    assert!(!applied.full);
    assert!(covers_other_paint(&mut engine, &applied));
}

#[test]
fn an_edit_can_expose_a_pass_inside_an_ordinary_clip() {
    let at = |x, y, h| {
        let mut record = Rec::new([1.0, 0.0, 0.0, 1.0, x, y], [15.0, h]);
        record.paths.push(Entry::Rect {
            w: 15.0,
            h,
            radii: [0.0; 4],
        });
        record.ops.push(Op::Fill {
            path: 0,
            even_odd: false,
            paint: Paint::Solid([0.5, 0.5, 0.5, 1.0]),
        });
        record
    };
    let c = std::f64::consts::FRAC_1_SQRT_2;
    let mut clipped = Rec::new([c, c, -c, c, 155.0, 0.0], [40.0, 40.0]);
    clipped.paths.push(Entry::Rect {
        w: 40.0,
        h: 40.0,
        radii: [0.0; 4],
    });
    clipped.ops = vec![
        Op::Clip {
            path: 0,
            even_odd: false,
        },
        Op::Children,
        Op::Unclip,
    ];
    let mut blend = at(50.0, 30.0, 40.0);
    blend.layer_blend = 5;
    let mut list = W::new(ANY, 1);
    list.reset();
    list.set(1, 0, &at(10.0, 85.0, 15.0));
    list.set(2, 0, &clipped);
    list.set(3, 2, &blend);
    list.set(4, 2, &at(65.0, 30.0, 15.0));
    let mut engine = engine();
    engine.apply(&list.finish()).expect("scene");
    // At 160 px wide, walking the unchanged blend would overlap the viewport, but its
    // parent is culled. The ordinary child edit brings the parent into view.
    assert!(engine.store.world_extent(2).unwrap().x0 > 161.0);
    assert!(engine.store.world_extent(3).unwrap().x0 < 160.0);
    let mut patch = W::new(1, 2);
    patch.transform(4, [1.0, 0.0, 0.0, 1.0, 10.0, 10.0]);
    let applied = engine.apply(&patch.finish()).expect("move ordinary child");
    assert!(engine.store.world_extent(2).unwrap().x0 < 160.0);
    let dirty = engine
        .store
        .dirty(&applied.changes, vello_common::kurbo::Affine::IDENTITY, 1.5);
    assert!(dirty.iter().any(|rect| rect.contains((17.5, 93.5))));
}
