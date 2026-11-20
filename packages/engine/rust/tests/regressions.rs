//! Regressions found by the independent review of PR #216, each failing before its fix, and the
//! cases around them.

mod common;

use common::{ANY, Entry, Op, Paint, Rec, W};
use drawpane_engine::engine::{Camera, Engine};
use drawpane_engine::error::ErrorCode;
use drawpane_engine::limits::Limits;

fn rect(w: f32, h: f32, color: [f32; 4]) -> Rec {
    let mut r = Rec::new([1.0, 0.0, 0.0, 1.0, 0.0, 0.0], [w, h]);
    r.paths.push(Entry::Rect { w, h, radii: [0.0; 4] });
    r.ops.push(Op::Fill {
        path: 0,
        even_odd: false,
        paint: Paint::Solid(color),
    });
    r
}

fn pixels(e: &mut Engine) -> Vec<u8> {
    e.render_cpu(
        64,
        64,
        Camera {
            zoom: 1.0,
            x: 0.0,
            y: 0.0,
            dpr: 1.0,
        },
        [0.0; 4],
        false,
    )
    .unwrap()
    .0
    .to_vec()
}

#[test]
fn failed_fresh_list_keeps_previous_revision_pixels() {
    let mut e = Engine::new(Limits::default());
    let mut start = W::new(ANY, 1);
    start.reset();
    start.set(1, 0, &rect(20.0, 20.0, [1.0; 4]));
    e.apply(&start.finish()).unwrap();
    let before = pixels(&mut e);

    let mut invalid = W::new(ANY, 2);
    invalid.reset();
    invalid.set(2, 99, &rect(20.0, 20.0, [1.0; 4]));
    assert!(matches!(e.apply(&invalid.finish()), Err(err) if err.code == ErrorCode::Unknown));
    assert_eq!(e.store.revision, 1);
    assert!(pixels(&mut e) == before, "failed replacement lost the displayed scene");
}

fn glyph_list(revision: u32, width: f32) -> Vec<u8> {
    let mut w = W::new(ANY, revision);
    w.reset();
    w.glyph(
        1,
        &[
            (0, vec![0.0, 0.0]),
            (1, vec![width, 0.0]),
            (1, vec![width, 16.0]),
            (1, vec![0.0, 16.0]),
            (4, vec![]),
        ],
    );
    let mut text = rect(32.0, 32.0, [1.0; 4]);
    text.paths = vec![Entry::Glyphs {
        scale: 1.0,
        glyphs: vec![(1, 4.0, 20.0)],
    }];
    w.set(1, 0, &text);
    w.finish()
}

#[test]
fn glyph_masks_survive_fresh_replacement_only_for_the_same_outline() {
    let mut retained = Engine::new(Limits::default());
    retained.apply(&glyph_list(1, 8.0)).unwrap();
    let old = pixels(&mut retained);
    let second = glyph_list(2, 24.0);
    retained.apply(&second).unwrap();

    let mut fresh = Engine::new(Limits::default());
    fresh.apply(&second).unwrap();
    let expected = pixels(&mut fresh);
    assert!(old != expected, "fixture must change the outline");
    assert!(
        pixels(&mut retained) == expected,
        "stale coverage survived scene replacement"
    );
}

#[test]
fn stale_wire_versions_and_patch_bases_leave_the_scene_intact() {
    let mut e = Engine::new(Limits::default());
    let mut initial = W::new(ANY, 1);
    initial.reset();
    initial.set(1, 0, &rect(20.0, 20.0, [1.0; 4]));
    let initial = initial.finish();
    e.apply(&initial).unwrap();
    let before = pixels(&mut e);

    let mut from_future = initial.clone();
    // A minor version past this engine's.
    let next = drawpane_engine::wire::MINOR + 1;
    from_future[6..8].copy_from_slice(&next.to_le_bytes());
    assert!(matches!(e.apply(&from_future), Err(err) if err.code == ErrorCode::Version));

    let mut after_gap = W::new(2, 3);
    after_gap.remove(1);
    assert!(matches!(e.apply(&after_gap.finish()), Err(err) if err.code == ErrorCode::Revision));
    assert!(pixels(&mut e) == before);

    let mut patch = W::new(1, 2);
    patch.transform(1, [1.0, 0.0, 0.0, 1.0, 3.0, 0.0]);
    let patch = patch.finish();
    let mut reset_engine = Engine::new(Limits::default());
    assert!(matches!(reset_engine.apply(&patch), Err(err) if err.code == ErrorCode::Revision));
    reset_engine.apply(&initial).unwrap();
    reset_engine.apply(&patch).unwrap();
    assert!(matches!(reset_engine.apply(&patch), Err(err) if err.code == ErrorCode::Revision));
}

#[test]
fn duplicate_output_revision_cannot_replace_pixels() {
    let mut e = Engine::new(Limits::default());
    let mut start = W::new(ANY, 1);
    start.reset();
    start.set(1, 0, &rect(20.0, 20.0, [1.0; 4]));
    e.apply(&start.finish()).unwrap();
    let mut replayable = W::new(1, 1);
    replayable.remove(1);
    let result = e.apply(&replayable.finish());
    assert!(matches!(result, Err(err) if err.code == ErrorCode::Revision));
}

#[test]
fn reparent_checks_depth_of_the_moved_subtree() {
    let mut e = Engine::new(Limits {
        depth: 3,
        ..Limits::default()
    });
    let container = Rec {
        paths: vec![],
        ops: vec![Op::Children],
        ..rect(20.0, 20.0, [1.0; 4])
    };
    let mut start = W::new(ANY, 1);
    start.reset();
    start.set(1, 0, &container);
    start.set(2, 1, &container);
    start.set(3, 0, &container);
    start.set(4, 3, &container);
    e.apply(&start.finish()).unwrap();
    let mut move_deeper = W::new(1, 2);
    move_deeper.set(3, 2, &container);
    let result = e.apply(&move_deeper.finish());
    assert!(matches!(result, Err(err) if err.code == ErrorCode::Limit));
}

#[test]
fn outside_stroke_uses_the_viewport_even_past_one_million_units() {
    let mut e = Engine::new(Limits::default());
    let mut rec = rect(1_000_100.0, 40.0, [0.0; 4]);
    rec.paths.push(Entry::Outside(0));
    rec.ops = vec![
        Op::Clip {
            path: 1,
            even_odd: true,
        },
        Op::Stroke {
            path: 0,
            width: 8.0,
            join: 0,
            cap: 0,
            dashes: vec![],
            offset: 0.0,
            paint: Paint::Solid([1.0; 4]),
        },
        Op::Unclip,
    ];
    let mut w = W::new(ANY, 1);
    w.reset();
    w.set(1, 0, &rec);
    e.apply(&w.finish()).unwrap();
    let px = e
        .render_cpu(
            16,
            16,
            Camera {
                zoom: 1.0,
                x: -1_000_092.0,
                y: -12.0,
                dpr: 1.0,
            },
            [0.0; 4],
            false,
        )
        .unwrap()
        .0;
    assert_eq!((px[(8 * 16 + 6) * 4 + 3], px[(8 * 16 + 9) * 4 + 3]), (0, 255));
}

#[test]
fn gradient_stop_order_preserves_positions() {
    let draw = |stops| {
        let mut e = Engine::new(Limits::default());
        let mut rec = rect(64.0, 20.0, [0.0; 4]);
        rec.ops = vec![Op::Fill {
            path: 0,
            even_odd: false,
            paint: Paint::Gradient {
                kind: 2,
                m: [64.0, 0.0, 0.0, 20.0, 0.0, 0.0],
                stops,
            },
        }];
        let mut w = W::new(ANY, 1);
        w.reset();
        w.set(1, 0, &rec);
        e.apply(&w.finish()).unwrap();
        pixels(&mut e)
    };
    let red = (0.0, [1.0, 0.0, 0.0, 1.0]);
    let blue = (1.0, [0.0, 0.0, 1.0, 1.0]);
    assert!(draw(vec![blue, red]) == draw(vec![red, blue]));
}

#[test]
fn tiny_dash_period_is_refused_before_stroking() {
    let mut e = Engine::new(Limits::default());
    let mut line = rect(64.0, 64.0, [0.0; 4]);
    line.paths = vec![Entry::Path(vec![(0, vec![0.0, 20.0]), (1, vec![64.0, 20.0])])];
    line.ops = vec![Op::Stroke {
        path: 0,
        width: 2.0,
        join: 0,
        cap: 0,
        dashes: vec![1e-16, 1e-16],
        offset: 0.0,
        paint: Paint::Solid([1.0; 4]),
    }];
    let mut w = W::new(ANY, 1);
    w.reset();
    w.set(1, 0, &line);
    if let Err(err) = e.apply(&w.finish()) {
        assert_eq!(err.code, ErrorCode::Limit);
        return;
    }
    let result = e.render_cpu(
        64,
        64,
        Camera {
            zoom: 1.0,
            x: 0.0,
            y: 0.0,
            dpr: 1.0,
        },
        [0.0; 4],
        false,
    );
    assert!(matches!(result, Err(err) if err.code == ErrorCode::Limit));
}

fn camera() -> Camera {
    Camera {
        zoom: 1.0,
        x: 0.0,
        y: 0.0,
        dpr: 1.0,
    }
}

fn square_glyph(width: f32) -> Vec<(u8, Vec<f32>)> {
    vec![
        (0, vec![0.0, 0.0]),
        (1, vec![width, 0.0]),
        (1, vec![width, 16.0]),
        (1, vec![0.0, 16.0]),
        (4, vec![]),
    ]
}

#[test]
fn a_glyph_in_use_is_immutable() {
    let mut e = Engine::new(Limits::default());
    e.apply(&glyph_list(1, 8.0)).unwrap();
    // Redefining the glyph a record uses would change its pixels and bounds behind its back.
    let mut w = W::new(1, 2);
    w.glyph(1, &square_glyph(24.0));
    assert!(matches!(e.apply(&w.finish()), Err(err) if err.code == ErrorCode::Malformed));
    assert_eq!(e.store.revision, 1);
    // Once nothing uses it, it may be freed or redefined.
    let mut w = W::new(1, 2);
    w.remove(1);
    w.glyph(1, &square_glyph(24.0));
    e.apply(&w.finish()).unwrap();
}

#[test]
fn fresh_lists_move_forward_and_patches_make_the_next_revision() {
    let mut e = Engine::new(Limits::default());
    let fresh = |revision: u32| {
        let mut w = W::new(ANY, revision);
        w.reset();
        w.set(1, 0, &rect(20.0, 20.0, [1.0; 4]));
        w.finish()
    };
    e.apply(&fresh(5)).unwrap();
    // An older or equal fresh list (a stale one) is refused.
    assert!(matches!(e.apply(&fresh(5)), Err(err) if err.code == ErrorCode::Revision));
    assert!(matches!(e.apply(&fresh(3)), Err(err) if err.code == ErrorCode::Revision));
    // No message may make the fresh-list sentinel, and a patch can't skip revisions.
    assert!(matches!(e.apply(&fresh(ANY)), Err(err) if err.code == ErrorCode::Revision));
    let mut skip = W::new(5, 7);
    skip.transform(1, [1.0, 0.0, 0.0, 1.0, 1.0, 0.0]);
    assert!(matches!(e.apply(&skip.finish()), Err(err) if err.code == ErrorCode::Revision));
    // A fresh list with no commands at all is malformed (it must start with a reset).
    assert!(matches!(e.apply(&W::new(ANY, 9).finish()), Err(err) if err.code == ErrorCode::Malformed));
    assert_eq!(e.store.revision, 5);
    e.apply(&fresh(6)).unwrap();
}

#[test]
fn a_command_reads_only_its_own_bytes() {
    let mut e = Engine::new(Limits::default());
    let mut w = W::new(ANY, 1);
    w.reset();
    w.set(1, 0, &rect(20.0, 20.0, [1.0; 4]));
    w.set(2, 0, &rect(20.0, 20.0, [1.0; 4]));
    let mut bytes = w.finish();
    // Cut the first set's stated length short: its record must not read on into the next command.
    let first_set = 4 + 4 + 4 + 4 + 4 + 8;
    let len = u32::from_le_bytes(bytes[first_set + 4..first_set + 8].try_into().unwrap());
    bytes[first_set + 4..first_set + 8].copy_from_slice(&(len - 8).to_le_bytes());
    assert!(matches!(e.apply(&bytes), Err(err) if err.code == ErrorCode::Malformed));
    assert!(e.store.is_empty());
}

#[test]
fn a_page_with_a_refused_record_is_refused_whole() {
    let mut e = Engine::new(Limits::default());
    let mut far = rect(10.0, 10.0, [1.0; 4]);
    far.transform = [1.0, 0.0, 0.0, 1.0, 5000.0, 5000.0];
    far.unsupported = 1;
    let mut w = W::new(ANY, 1);
    w.reset();
    w.set(1, 0, &rect(20.0, 20.0, [1.0; 4]));
    w.set(2, 0, &far);
    e.apply(&w.finish()).unwrap();
    // Far off screen, it's still refused: the page falls back whole, never drawn without it.
    let r = e.render_cpu(64, 64, camera(), [0.0; 4], true);
    assert!(matches!(r, Err(err) if err.code == ErrorCode::Unsupported));
    // Hidden, it draws nothing, so the page is the engine's.
    let mut hidden = far.clone();
    hidden.flags = 1;
    let mut w = W::new(1, 2);
    w.set(2, 0, &hidden);
    e.apply(&w.finish()).unwrap();
    e.render_cpu(64, 64, camera(), [0.0; 4], true).unwrap();
}

#[test]
fn expanding_glyph_runs_is_budgeted() {
    // One outline of 40,000 segments, a hundred times over, filled with a gradient (outlines, not
    // masks): four million path elements, more than a frame may generate.
    let mut outline = vec![(0u8, vec![0.0f32, 0.0])];
    for i in 0..40_000 {
        let x = (i % 200) as f32 * 0.1;
        outline.push((1, vec![x, (i / 200) as f32 * 0.1]));
    }
    outline.push((4, vec![]));
    let mut w = W::new(ANY, 1);
    w.reset();
    w.glyph(1, &outline);
    let mut text = rect(64.0, 64.0, [0.0; 4]);
    text.paths = vec![Entry::Glyphs {
        scale: 1.0,
        glyphs: (0..100).map(|_| (1, 4.0, 40.0)).collect(),
    }];
    text.ops = vec![Op::Fill {
        path: 0,
        even_odd: false,
        paint: Paint::Gradient {
            kind: 2,
            m: [64.0, 0.0, 0.0, 64.0, 0.0, 0.0],
            stops: vec![(0.0, [1.0, 0.0, 0.0, 1.0]), (1.0, [0.0, 0.0, 1.0, 1.0])],
        },
    }];
    w.set(1, 0, &text);
    let mut e = Engine::new(Limits {
        frame_verbs: 1_000_000,
        ..Limits::default()
    });
    e.apply(&w.finish()).unwrap();
    let r = e.render_cpu(64, 64, camera(), [0.0; 4], false);
    assert!(matches!(r, Err(err) if err.code == ErrorCode::Limit));
    // Off screen, the same run costs nothing: glyphs beyond the viewport aren't expanded.
    let far = Camera {
        x: -10_000.0,
        ..camera()
    };
    e.render_cpu(64, 64, far, [0.0; 4], false).unwrap();
}

#[test]
fn open_clips_and_layers_are_capped_across_records() {
    let mut e = Engine::new(Limits {
        open_scopes: 4,
        ..Limits::default()
    });
    let clipping = Rec {
        ops: vec![
            Op::Clip {
                path: 0,
                even_odd: false,
            },
            Op::Children,
            Op::Unclip,
        ],
        ..rect(60.0, 60.0, [0.0; 4])
    };
    let mut w = W::new(ANY, 1);
    w.reset();
    for id in 1..=6u32 {
        w.set(id, id - 1, &clipping);
    }
    w.set(7, 6, &rect(10.0, 10.0, [1.0; 4]));
    e.apply(&w.finish()).unwrap();
    let r = e.render_cpu(64, 64, camera(), [0.0; 4], true);
    assert!(matches!(r, Err(err) if err.code == ErrorCode::Limit));
}

#[test]
fn a_band_holds_at_most_two_mebibytes() {
    let mut e = Engine::new(Limits::default());
    let mut w = W::new(ANY, 1);
    w.reset();
    w.set(1, 0, &rect(20.0, 20.0, [1.0; 4]));
    e.apply(&w.finish()).unwrap();
    assert_eq!(e.band_rows(8192), 64);
    let r = e.render_band(8192, 1024, camera(), [0.0; 4], 0, 256);
    assert!(matches!(r, Err(err) if err.code == ErrorCode::Limit));
    e.render_band(8192, 1024, camera(), [0.0; 4], 0, 64).unwrap();
}

#[test]
fn an_export_is_admitted_against_the_memory_budget() {
    let mut e = Engine::new(Limits {
        memory_bytes: 4 << 20,
        ..Limits::default()
    });
    let mut w = W::new(ANY, 1);
    w.reset();
    w.set(1, 0, &rect(20.0, 20.0, [1.0; 4]));
    e.apply(&w.finish()).unwrap();
    e.admit_export(512, 512, camera()).unwrap();
    // A band of 8,192 px rows, a tile and the frame's scene rows don't fit in 4 MiB.
    let r = e.admit_export(8192, 8192, camera());
    assert!(matches!(r, Err(err) if err.code == ErrorCode::Limit));
}

#[test]
fn a_transparent_placeholder_paints_nothing() {
    let mut e = Engine::new(Limits::default());
    let mut r = rect(32.0, 32.0, [0.0; 4]);
    r.ops = vec![Op::Fill {
        path: 0,
        even_odd: false,
        paint: Paint::PlaceholderAt(0.0),
    }];
    let mut w = W::new(ANY, 1);
    w.reset();
    w.set(1, 0, &r);
    e.apply(&w.finish()).unwrap();
    assert_eq!(pixels(&mut e)[3], 0);
    let mut half = r.clone();
    half.ops = vec![Op::Fill {
        path: 0,
        even_odd: false,
        paint: Paint::PlaceholderAt(0.5),
    }];
    let mut w = W::new(1, 2);
    w.set(1, 0, &half);
    e.apply(&w.finish()).unwrap();
    assert!((126..=129).contains(&pixels(&mut e)[3]));
}

/// A record with a paint the engine refuses when it draws it, placed far off screen.
fn far_with(paint: Paint) -> Rec {
    let mut r = rect(10.0, 10.0, [0.0; 4]);
    r.transform = [1.0, 0.0, 0.0, 1.0, 5000.0, 5000.0];
    r.ops = vec![Op::Fill {
        path: 0,
        even_odd: false,
        paint,
    }];
    r
}

#[test]
fn an_operation_the_engine_refuses_refuses_its_page_wherever_it_is() {
    // Backdrop readers outside the reference kernel are recognized before drawing, even offscreen.
    let mut e = Engine::new(Limits::default());
    let mut w = W::new(ANY, 1);
    w.reset();
    w.set(1, 0, &rect(20.0, 20.0, [1.0; 4]));
    let mut reader = far_with(Paint::Solid([1.0, 0.0, 0.0, 1.0]));
    reader.ops.push(Op::Read { kernel: 99, halo: 1.0 });
    w.set(2, 0, &reader);
    e.apply(&w.finish()).unwrap();
    assert!(matches!(e.render_cpu(64, 64, camera(), [0.0; 4], true), Err(err) if err.code == ErrorCode::Unsupported));
    assert!(matches!(e.render_band(64, 64, camera(), [0.0; 4], 0, 16), Err(err) if err.code == ErrorCode::Unsupported));
    assert!(matches!(e.admit_export(64, 64, camera()), Err(err) if err.code == ErrorCode::Unsupported));
}

#[test]
fn blended_paints_and_smoothed_corners_draw() {
    let mut e = Engine::new(Limits::default());
    let mut blended = far_with(Paint::Solid([1.0; 4]));
    blended.blend = 3;
    let mut w = W::new(ANY, 1);
    w.reset();
    w.set(1, 0, &blended);
    e.apply(&w.finish()).unwrap();
    e.render_cpu(64, 64, camera(), [0.0; 4], true).unwrap();

    // Unknown blend mode (> 17) is malformed on the wire.
    let mut bad_blend = rect(20.0, 20.0, [1.0; 4]);
    bad_blend.layer_blend = 18;
    let mut w = W::new(ANY, 2);
    w.reset();
    w.set(1, 0, &bad_blend);
    assert!(matches!(e.apply(&w.finish()), Err(err) if err.code == ErrorCode::Malformed));

    let mut smooth = rect(20.0, 20.0, [1.0; 4]);
    smooth.paths = vec![Entry::Rect {
        w: 40.0,
        h: 40.0,
        radii: [12.0; 4],
    }];
    smooth.smoothing = 0.6;
    let mut w = W::new(ANY, 3);
    w.reset();
    w.set(1, 0, &smooth);
    e.apply(&w.finish()).unwrap();
    let smooth_px = pixels(&mut e);
    smooth.smoothing = 0.0;
    let mut w = W::new(ANY, 4);
    w.reset();
    w.set(1, 0, &smooth);
    e.apply(&w.finish()).unwrap();
    let plain_px = pixels(&mut e);
    assert_ne!(
        smooth_px, plain_px,
        "smoothed corners must draw squircle curves, not plain arcs"
    );
}

#[test]
fn opacity_multiplies_into_a_placeholder() {
    // A 50% placeholder in a 50% record: a quarter, as the canvas multiplies globalAlpha.
    let mut e = Engine::new(Limits::default());
    let mut r = rect(32.0, 32.0, [0.0; 4]);
    r.opacity = 0.5;
    r.ops = vec![Op::Fill {
        path: 0,
        even_odd: false,
        paint: Paint::PlaceholderAt(0.5),
    }];
    let mut w = W::new(ANY, 1);
    w.reset();
    w.set(1, 0, &r);
    e.apply(&w.finish()).unwrap();
    let a = pixels(&mut e)[(16 * 64 + 16) * 4 + 3];
    assert!((63..=65).contains(&a), "alpha {a}");
}

#[test]
fn an_outside_clips_shape_is_charged_to_the_budget() {
    // An outside stroke's clip is a box with the shape cut out: the shape's elements count.
    let mut rec = rect(40.0, 40.0, [0.0; 4]);
    rec.paths = vec![
        Entry::Path(
            (0..40)
                .map(|i| (if i == 0 { 0 } else { 1 }, vec![i as f32, (i % 7) as f32]))
                .collect(),
        ),
        Entry::Outside(0),
    ];
    rec.ops = vec![
        Op::Clip {
            path: 1,
            even_odd: true,
        },
        Op::Fill {
            path: 0,
            even_odd: false,
            paint: Paint::Solid([1.0; 4]),
        },
        Op::Unclip,
    ];
    let mut w = W::new(ANY, 1);
    w.reset();
    w.set(1, 0, &rec);
    let list = w.finish();
    // The fill's 40 elements and the clip's box fit 60; with the clip's 40 cut-out elements
    // counted too they don't.
    let mut e = Engine::new(Limits {
        frame_verbs: 60,
        ..Limits::default()
    });
    e.apply(&list).unwrap();
    assert!(matches!(e.render_cpu(64, 64, camera(), [0.0; 4], true), Err(err) if err.code == ErrorCode::Limit));
    let mut roomy = Engine::new(Limits {
        frame_verbs: 100,
        ..Limits::default()
    });
    roomy.apply(&list).unwrap();
    roomy.render_cpu(64, 64, camera(), [0.0; 4], true).unwrap();
}

#[test]
fn canonical_shadow_pixels_do_not_depend_on_cache_admission() {
    let mut cast = Rec::new([1.0, 0.0, 0.0, 1.0, 24.38, 21.72], [420.0, 420.0]);
    cast.paths.push(Entry::Rect {
        w: 420.0,
        h: 420.0,
        radii: [18.0; 4],
    });
    cast.ops.push(Op::DropShadow {
        paths: vec![0],
        even_odd: false,
        dx: 0.0,
        dy: 6.0,
        blur: 24.0,
        color: [0.0, 0.0, 0.0, 0.58],
        blend: 0,
    });
    let mut list = W::new(ANY, 1);
    list.reset();
    list.set(1, 0, &cast);
    let wire = list.finish();
    let render = |memory_bytes| {
        let mut engine = Engine::new(Limits {
            memory_bytes,
            ..Limits::default()
        });
        engine.apply(&wire).expect("scene");
        engine
            .render_cpu(128, 128, camera(), [0.0; 4], false)
            .expect("shadow")
            .0
            .to_vec()
    };
    // The whole canonical mask fits in memory, but exceeds the 10 MiB engine's cache share.
    let cached = render(0);
    assert!(cached.iter().any(|&byte| byte != 0));
    assert!(
        cached == render(10 << 20),
        "shadow pixels changed when the cache was too small"
    );
}

fn glass_rect(x: f64, y: f64, w: f32, h: f32, radii: [f32; 4], refraction: f32, frost: f32) -> Rec {
    let mut r = Rec::new([1.0, 0.0, 0.0, 1.0, x, y], [w, h]);
    r.paths.push(Entry::Rect { w, h, radii });
    r.ops.push(Op::Glass {
        paths: vec![0],
        even_odd: false,
        kind: 0,
        inradius: w.min(h) * 0.5,
        angle: -45.0,
        intensity: 80.0,
        refraction,
        depth: 10.0,
        dispersion: 20.0,
        frost,
        splay: 0.0,
        box_radii: radii,
        box_smoothing: [0.0; 4],
    });
    r
}

#[test]
fn removing_glass_invalidates_earlier_paint_in_the_same_picture() {
    let cam = camera();
    let mut engine = Engine::new(Limits::default());
    let mut initial = W::new(ANY, 1);
    initial.reset();
    initial.set(1, 0, &rect(16.0, 16.0, [0.3, 0.6, 0.1, 0.5]));
    initial.set(2, 0, &glass_rect(96.0, 0.0, 16.0, 16.0, [2.0; 4], 30.0, 0.0));
    initial.set(3, 0, &glass_rect(96.0, 24.0, 16.0, 16.0, [2.0; 4], 30.0, 0.0));
    engine.apply(&initial.finish()).expect("scene");

    // The glass is distant, but removing it changes when the page's earlier draws round to RGBA8.
    let mut patch = W::new(1, 2);
    patch.remove(2);
    let applied = engine.apply(&patch.finish()).expect("remove glass");
    assert!(!applied.full);
    let dirty = engine.store.dirty(&applied.changes, cam.view(), 1.0);
    assert!(dirty.iter().any(|r| r.contains((8.5, 8.5))));
}

fn striped_backdrop(w: &mut W) {
    let mut bg = rect(64.0, 64.0, [0.95, 0.95, 0.95, 1.0]);
    bg.transform = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];
    w.set(1, 0, &bg);
    for i in 0..4u32 {
        let mut stripe = rect(8.0, 64.0, [0.1, 0.3, 0.85, 1.0]);
        stripe.transform = [1.0, 0.0, 0.0, 1.0, f64::from(i * 16), 0.0];
        w.set(2 + i, 0, &stripe);
    }
}

#[test]
fn stacked_glass_reads_non_glass_backdrop_and_keeps_fills_and_children() {
    // Decision 0007 rule (b*): upper glass sees lower glass's fills and children,
    // never lower glass's refraction/frost.
    let build = |lower_refraction: f32, lower_frost: f32, with_lower_glass: bool| {
        let mut e = Engine::new(Limits::default());
        let mut w = W::new(ANY, 1);
        w.reset();
        striped_backdrop(&mut w);
        let mut lower = if with_lower_glass {
            glass_rect(8.0, 8.0, 48.0, 48.0, [10.0; 4], lower_refraction, lower_frost)
        } else {
            let mut r = Rec::new([1.0, 0.0, 0.0, 1.0, 8.0, 8.0], [48.0, 48.0]);
            r.paths.push(Entry::Rect {
                w: 48.0,
                h: 48.0,
                radii: [10.0; 4],
            });
            r
        };
        lower.ops.push(Op::Fill {
            path: 0,
            even_odd: false,
            paint: Paint::Solid([0.9, 0.2, 0.1, 0.35]),
        });
        lower.ops.push(Op::Children);
        w.set(10, 0, &lower);
        let mut child = rect(16.0, 16.0, [0.1, 0.8, 0.2, 1.0]);
        child.transform = [1.0, 0.0, 0.0, 1.0, 16.0, 16.0];
        w.set(11, 10, &child);
        // Upper glass completely inside the lower glass.
        let upper = glass_rect(18.0, 18.0, 28.0, 28.0, [6.0; 4], 80.0, 3.0);
        w.set(12, 0, &upper);
        e.apply(&w.finish()).unwrap();
        pixels(&mut e)
    };

    let with_strong_lower = build(100.0, 20.0, true);
    let with_weak_lower = build(10.0, 0.0, true);
    let without_lower_glass = build(0.0, 0.0, false);

    // Inside the upper glass region (20..44, 20..44), the upper glass is opaque over its
    // backdrop, so its pixels must be IDENTICAL regardless of lower glass's refraction/frost
    // or whether lower had glass at all (only lower's fill and child enter the backdrop).
    let mut checked = 0;
    for y in 20..44u32 {
        for x in 20..44u32 {
            let i = ((y * 64 + x) * 4) as usize;
            assert_eq!(
                &with_strong_lower[i..i + 4],
                &without_lower_glass[i..i + 4],
                "upper glass leaked lower glass effect at ({x}, {y})"
            );
            assert_eq!(
                &with_strong_lower[i..i + 4],
                &with_weak_lower[i..i + 4],
                "upper glass changed when lower glass params changed at ({x}, {y})"
            );
            checked += 1;
        }
    }
    assert!(checked > 400);
    // Outside upper glass (inside lower glass only, e.g. 12, 12), lower glass DID change output.
    let outside_diff: usize = (10..16u32)
        .flat_map(|y| (10..16u32).map(move |x| ((y * 64 + x) * 4) as usize))
        .filter(|&i| with_strong_lower[i..i + 4] != without_lower_glass[i..i + 4])
        .count();
    assert!(outside_diff > 0, "lower glass must still refract outside the overlap");
}

#[test]
fn context_records_feed_backdrop_only_and_never_paint_output() {
    let mut e = Engine::new(Limits::default());
    let mut w = W::new(ANY, 1);
    w.reset();
    // Red backdrop marked FLAG_CONTEXT (16): invisible outside the glass, refracted inside it.
    let mut ctx = rect(64.0, 64.0, [0.9, 0.1, 0.1, 1.0]);
    ctx.flags = 16;
    w.set(1, 0, &ctx);
    let g = glass_rect(16.0, 16.0, 32.0, 32.0, [8.0; 4], 60.0, 2.0);
    w.set(2, 0, &g);
    e.apply(&w.finish()).unwrap();
    let px = pixels(&mut e);
    // Corner (2, 2) outside glass must stay transparent (context never painted to main).
    let corner = (2 * 64 + 2) * 4;
    assert_eq!(&px[corner..corner + 4], &[0, 0, 0, 0]);
    // Centre (32, 32) inside glass must show refracted red from the context layer.
    let center = (32 * 64 + 32) * 4;
    assert!(
        px[center] > 180 && px[center + 3] > 240,
        "center {:?}",
        &px[center..center + 4]
    );
}

#[test]
fn a_faded_context_scope_preserves_exported_opacity_and_refuses_crossing_blends() {
    let mut e = Engine::new(Limits::default());
    let mut list = W::new(ANY, 1);
    list.reset();
    let mut context = Rec::group();
    context.flags |= drawpane_engine::record::FLAG_CONTEXT | drawpane_engine::record::FLAG_ISOLATE;
    context.opacity = 0.5;
    list.set(1, 0, &context);
    let mut prior = rect(64.0, 64.0, [0.0, 0.0, 1.0, 1.0]);
    prior.flags |= drawpane_engine::record::FLAG_CONTEXT;
    list.set(2, 1, &prior);
    list.set(3, 1, &rect(12.0, 12.0, [1.0, 0.0, 0.0, 1.0]));
    list.set(4, 1, &glass_rect(16.0, 16.0, 32.0, 32.0, [8.0; 4], 0.0, 0.0));
    e.apply(&list.finish()).expect("context");
    let px = pixels(&mut e);
    let corner = (2 * 64 + 2) * 4;
    assert_eq!(&px[corner..corner + 4], &[255, 0, 0, 255]);

    context.layer_blend = 2;
    let mut patch = W::new(1, 2);
    patch.set(1, 0, &context);
    e.apply(&patch.finish()).expect("blended context");
    let error = e.render_cpu(64, 64, camera(), [0.0; 4], false).unwrap_err();
    assert_eq!(error.code, ErrorCode::Unsupported);
}

#[test]
fn isolated_opacity_group_with_glass_fades_as_one() {
    let mut e = Engine::new(Limits::default());
    let mut w = W::new(ANY, 1);
    w.reset();
    striped_backdrop(&mut w);
    let mut group = Rec::group();
    group.opacity = 0.5;
    group.flags |= 2; // FLAG_ISOLATE
    w.set(10, 0, &group);
    let mut g = glass_rect(12.0, 12.0, 40.0, 40.0, [8.0; 4], 75.0, 4.0);
    g.ops.push(Op::Fill {
        path: 0,
        even_odd: false,
        paint: Paint::Solid([1.0, 1.0, 1.0, 0.3]),
    });
    w.set(11, 10, &g);
    e.apply(&w.finish()).unwrap();
    let faded = pixels(&mut e);

    // Compare against an opaque group to ensure opacity took effect without failing.
    let mut full_group = group.clone();
    full_group.opacity = 1.0;
    let mut w2 = W::new(1, 2);
    w2.set(10, 0, &full_group);
    e.apply(&w2.finish()).unwrap();
    let opaque = pixels(&mut e);
    assert_ne!(faded, opaque, "isolated opacity group containing glass must fade");
}

#[test]
fn glass_bands_match_whole_frame_bit_for_bit() {
    let mut e = Engine::new(Limits::default());
    e.store.limits.export_tile = 24;
    let mut w = W::new(ANY, 1);
    w.reset();
    striped_backdrop(&mut w);
    w.set(10, 0, &glass_rect(10.0, 8.0, 44.0, 44.0, [10.0; 4], 80.0, 6.0));
    w.set(11, 0, &glass_rect(22.0, 20.0, 30.0, 30.0, [8.0; 4], 60.0, 4.0));
    e.apply(&w.finish()).unwrap();

    let (whole, _) = e.render_cpu(64, 64, camera(), [1.0; 4], false).unwrap();
    let whole = whole.to_vec();
    let mut banded = Vec::new();
    for y in (0..64u32).step_by(16) {
        banded.extend_from_slice(e.render_band(64, 64, camera(), [1.0; 4], y, 16).unwrap());
    }
    let diffs = whole
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
    assert_eq!(
        diffs, 0,
        "{diffs} pixels differ between banded and whole glass frame (worst {worst})"
    );
}

fn positioned_rect(x: f64, y: f64, w: f32, h: f32, rgba: Option<[f32; 4]>) -> Rec {
    let mut r = Rec::new([1.0, 0.0, 0.0, 1.0, x, y], [w, h]);
    r.paths.push(Entry::Rect { w, h, radii: [0.0; 4] });
    if let Some(c) = rgba {
        r.ops.push(Op::Fill {
            path: 0,
            even_odd: false,
            paint: Paint::Solid(c),
        });
    }
    r
}

fn tuned_glass(x: f64, y: f64, w: f32, h: f32, bend: f32, frost: f32, light: f32) -> Rec {
    let mut r = positioned_rect(x, y, w, h, None);
    r.ops.push(Op::Glass {
        paths: vec![0],
        even_odd: false,
        kind: 0,
        inradius: w.min(h) / 2.0,
        angle: -45.0,
        intensity: light,
        refraction: bend,
        depth: 8.0,
        dispersion: 50.0,
        frost,
        splay: 0.0,
        box_radii: [0.0; 4],
        box_smoothing: [0.0; 4],
    });
    r
}

#[test]
fn neutral_glass_in_faded_group_preserves_backdrop_alpha_and_fades_siblings() {
    let render = |grouped: bool, with_sibling: bool| {
        let mut e = Engine::new(Limits::default());
        let mut w = W::new(ANY, 1);
        w.reset();
        w.set(
            1,
            0,
            &positioned_rect(0.0, 0.0, 64.0, 64.0, Some([1.0, 0.0, 0.0, 0.30])),
        );
        let mut group = Rec::group();
        group.flags |= 2; // FLAG_ISOLATE
        group.opacity = 0.5;
        if grouped {
            w.set(2, 0, &group);
        }
        let parent = if grouped { 2 } else { 0 };
        if with_sibling {
            w.set(
                4,
                parent,
                &positioned_rect(2.0, 2.0, 8.0, 8.0, Some([0.0, 1.0, 0.0, 1.0])),
            );
        }
        w.set(3, parent, &tuned_glass(12.0, 12.0, 40.0, 40.0, 0.0, 0.0, 0.0));
        e.apply(&w.finish()).unwrap();
        let (px, stats) = e.render_cpu(64, 64, camera(), [0.0; 4], false).unwrap();
        assert_eq!(stats.draw.reads, 1);
        let centre = (32 * 64 + 32) * 4;
        let sib = (5 * 64 + 5) * 4;
        (
            px[..4].to_vec(),
            px[centre..centre + 4].to_vec(),
            px[sib..sib + 4].to_vec(),
        )
    };
    let (outside, plain, _) = render(false, false);
    let (_, grouped, _) = render(true, false);
    assert_eq!(plain, outside);
    assert_eq!(grouped, outside, "neutral glass must keep the 30% backdrop alpha");

    // With an opaque green sibling inside the faded group alongside neutral glass:
    // neutral glass still keeps the backdrop alpha, while the sibling fades by 0.5.
    let (_, grouped_sib_center, grouped_sib_px) = render(true, true);
    let (_, _, plain_sib_px) = render(false, true);
    assert_eq!(grouped_sib_center, outside);
    assert_eq!(plain_sib_px, vec![0, 255, 0, 255]);
    assert!(
        grouped_sib_px[1] > 100 && grouped_sib_px[1] < 200,
        "sibling inside faded group must fade by 0.5, got {grouped_sib_px:?}"
    );
}

#[test]
fn glass_limit_does_not_silently_drop_an_effect_from_a_valid_export() {
    let render = |width: u32, height: u32| {
        let mut e = Engine::new(Limits::default());
        let mut w = W::new(ANY, 1);
        w.reset();
        w.set(
            1,
            0,
            &tuned_glass(0.0, 0.0, width as f32, height as f32, 0.0, 0.0, 100.0),
        );
        e.apply(&w.finish()).unwrap();
        let bg = [0.12, 0.12, 0.12, 1.0];
        let (px, stats) = e.render_cpu(width, height, camera(), bg, false).unwrap();
        assert_eq!(stats.draw.reads, 1);
        assert!(stats.draw.exact());
        px[4..8].to_vec()
    };
    let small = render(128, 128);
    let large = render(5000, 5000);
    assert!(small[0] > 40, "small control must show the lit rim, got {small:?}");
    assert_eq!(large, small, "valid large frame must not silently drop glass");
}

#[test]
fn worker_admission_accounts_for_isolation_and_glass_allocations() {
    let limits = Limits {
        memory_bytes: 25 << 20,
        ..Limits::default()
    };
    let mut e = Engine::new(limits);
    let mut w = W::new(ANY, 1);
    w.reset();
    let mut group = Rec::group();
    group.flags |= 2; // FLAG_ISOLATE
    group.opacity = 0.5;
    let mut parent = 0;
    for id in 1..=24 {
        w.set(id, parent, &group);
        parent = id;
    }
    w.set(25, parent, &tuned_glass(0.0, 0.0, 2048.0, 1024.0, 80.0, 10.0, 60.0));
    e.apply(&w.finish()).unwrap();
    let admitted = e.admit_export(2048, 1024, camera());
    assert!(
        matches!(admitted, Err(err) if err.code == ErrorCode::Limit),
        "24 nested faded groups + glass must be refused by admit_export"
    );
}

#[test]
fn genuinely_grown_tiles_match_whole_glass_with_image_and_clip() {
    let mut e = Engine::new(Limits {
        export_tile: 173,
        ..Limits::default()
    });
    let mut w = W::new(ANY, 1);
    w.reset();
    let mut image = positioned_rect(0.0, 0.0, 540.0, 370.0, None);
    image.ops.push(Op::Fill {
        path: 0,
        even_odd: false,
        paint: Paint::Image {
            id: 1,
            m: [540.0, 0.0, 0.0, 370.0, 0.0, 0.0],
            tile: false,
            opacity: 1.0,
        },
    });
    w.set(1, 0, &image);
    let mut clipped = positioned_rect(91.3, 60.6, 370.0, 250.0, None);
    clipped.paths[0] = Entry::Rect {
        w: 370.0,
        h: 250.0,
        radii: [22.0; 4],
    };
    clipped.ops.extend([
        Op::Clip {
            path: 0,
            even_odd: false,
        },
        Op::Children,
        Op::Unclip,
    ]);
    w.set(2, 0, &clipped);
    w.set(3, 2, &tuned_glass(4.0, -13.0, 310.0, 236.0, 95.0, 5.0, 70.0));
    w.set(4, 0, &tuned_glass(135.0, 110.0, 370.0, 205.0, 90.0, 5.0, 55.0));
    e.apply(&w.finish()).unwrap();

    let img_px: Vec<u8> = (0..64)
        .flat_map(|y| {
            (0..64).flat_map(move |x| {
                if ((x / 3 + y / 3) % 2) == 0 {
                    [250, 60, 15, 255]
                } else {
                    [40, 120, 220, 147]
                }
            })
        })
        .collect();
    e.put_image(1, 64, 64, &img_px, false).unwrap();

    let (width, height) = (540, 370);
    let whole = e
        .render_cpu(width, height, camera(), [0.0; 4], false)
        .unwrap()
        .0
        .to_vec();
    let mut banded = Vec::new();
    for y in (0..height).step_by(47) {
        banded.extend_from_slice(
            e.render_band(width, height, camera(), [0.0; 4], y, 47.min(height - y))
                .unwrap(),
        );
    }
    let diff = whole
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
    assert_eq!(diff, 0, "split glass tiles differed in {diff} px (max {worst})");
}

#[test]
fn off_frame_isolate_does_not_insert_a_spurious_tile_flush() {
    let (width, height) = (320, 210);
    let mut e = Engine::new(Limits {
        export_tile: 80,
        ..Limits::default()
    });
    let mut w = W::new(ANY, 1);
    w.reset();
    w.set(
        1,
        0,
        &positioned_rect(0.0, 0.0, 320.0, 210.0, Some([0.6, 0.2, 0.4, 0.37])),
    );
    let mut group = Rec::group();
    group.opacity = 0.5;
    group.flags |= 2; // FLAG_ISOLATE
    group.transform[4] = 800.0;
    w.set(2, 0, &group);
    w.set(3, 2, &tuned_glass(0.0, 0.0, 20.0, 20.0, 0.0, 0.0, 0.0));
    w.set(
        4,
        0,
        &positioned_rect(0.0, 0.0, 320.0, 210.0, Some([0.2, 0.9, 0.1, 0.41])),
    );
    w.set(5, 0, &tuned_glass(280.0, 170.0, 20.0, 20.0, 0.0, 0.0, 0.0));
    e.apply(&w.finish()).unwrap();

    let whole = e.render_cpu(width, height, camera(), [0.0; 4], false).unwrap().0[..4].to_vec();
    let band = e.render_band(width, height, camera(), [0.0; 4], 0, 41).unwrap()[..4].to_vec();
    assert_eq!(band, whole);
}

#[test]
fn disjoint_readers_do_not_sum_halos_and_off_crop_readers_do_not_block_export() {
    let mut e = Engine::new(Limits::default());
    let mut w = W::new(ANY, 1);
    w.reset();
    // 12 disjoint glass cards across a row: summing halos would exceed the 512 px cap,
    // but disjoint readers take max reach instead.
    for i in 0..12u32 {
        w.set(
            i + 1,
            0,
            &tuned_glass(f64::from(i) * 200.0, 0.0, 120.0, 120.0, 80.0, 10.0, 60.0),
        );
    }
    e.apply(&w.finish()).unwrap();
    let halo = e
        .halo(camera().view())
        .expect("12 disjoint glass cards must stay under halo cap");
    assert!(halo > 0 && halo < 200, "unexpected halo {halo}");

    // Add two overlapping off-crop readers at (5000, 5000) whose combined chain exceeds 512 px:
    // whole-page `halo` fails, yet `halo_for_rect` and `admit_export` on 128x128 succeed.
    let mut off1 = positioned_rect(5000.0, 5000.0, 100.0, 100.0, None);
    off1.ops.push(Op::Read { kernel: 1, halo: 300.0 });
    let mut off2 = positioned_rect(5020.0, 5020.0, 100.0, 100.0, None);
    off2.ops.push(Op::Read { kernel: 1, halo: 300.0 });
    let mut w2 = W::new(1, 2);
    w2.set(98, 0, &off1);
    w2.set(99, 0, &off2);
    e.apply(&w2.finish()).unwrap();
    assert!(
        matches!(e.halo(camera().view()), Err(err) if err.code == ErrorCode::Limit),
        "overlapping off-crop reader chain should exceed whole-page halo cap"
    );
    let crop_halo = e
        .halo_for_rect(camera().view(), vello_common::kurbo::Rect::new(0.0, 0.0, 128.0, 128.0))
        .expect("off-crop reader must not fail halo_for_rect");
    assert!(crop_halo < 200);
    assert!(e.admit_export(128, 128, camera()).is_ok());
}

#[test]
fn wire_minor_version_gates_flags_and_reader_opcodes() {
    let set_minor = |bytes: &[u8], minor: u16| {
        let mut out = bytes.to_vec();
        out[6..8].copy_from_slice(&minor.to_le_bytes());
        out
    };

    // Plain 1.0 records are valid under every supported minor.
    let mut plain_w = W::new(ANY, 1);
    plain_w.reset();
    plain_w.set(1, 0, &rect(32.0, 32.0, [1.0, 0.0, 0.0, 1.0]));
    let plain = plain_w.finish();
    let current = drawpane_engine::wire::MINOR;
    for minor in 0..=current {
        let mut e = Engine::new(Limits::default());
        assert!(e.apply(&set_minor(&plain, minor)).is_ok(), "plain failed at 1.{minor}");
    }
    {
        let mut e = Engine::new(Limits::default());
        let err = e.apply(&set_minor(&plain, current + 1)).unwrap_err();
        assert_eq!(err.code, ErrorCode::Version);
    }

    // FLAG_PROVISIONAL (8) requires 1.1 or later.
    let mut prov_w = W::new(ANY, 1);
    prov_w.reset();
    let mut prov = rect(32.0, 32.0, [1.0, 0.0, 0.0, 1.0]);
    prov.flags = 8;
    prov_w.set(1, 0, &prov);
    let prov_bytes = prov_w.finish();
    {
        let mut e = Engine::new(Limits::default());
        assert_eq!(
            e.apply(&set_minor(&prov_bytes, 0)).unwrap_err().code,
            ErrorCode::Version
        );
    }
    for minor in 1..=current {
        let mut e = Engine::new(Limits::default());
        assert!(
            e.apply(&set_minor(&prov_bytes, minor)).is_ok(),
            "provisional failed at 1.{minor}"
        );
    }

    // FLAG_CONTEXT (16) requires 1.3 or later.
    let mut ctx_w = W::new(ANY, 1);
    ctx_w.reset();
    let mut ctx = rect(32.0, 32.0, [1.0, 0.0, 0.0, 1.0]);
    ctx.flags = 16;
    ctx_w.set(1, 0, &ctx);
    let ctx_bytes = ctx_w.finish();
    for minor in [0u16, 1, 2] {
        let mut e = Engine::new(Limits::default());
        assert_eq!(
            e.apply(&set_minor(&ctx_bytes, minor)).unwrap_err().code,
            ErrorCode::Version,
            "context should fail with Version at 1.{minor}"
        );
    }
    for minor in 3..=current {
        let mut e = Engine::new(Limits::default());
        assert!(e.apply(&set_minor(&ctx_bytes, minor)).is_ok());
    }

    // Glass (opcode 9) requires 1.3 or later.
    let mut glass_w = W::new(ANY, 1);
    glass_w.reset();
    glass_w.set(1, 0, &tuned_glass(0.0, 0.0, 32.0, 32.0, 50.0, 2.0, 40.0));
    let glass_bytes = glass_w.finish();
    for minor in [0u16, 1, 2] {
        let mut e = Engine::new(Limits::default());
        assert_eq!(
            e.apply(&set_minor(&glass_bytes, minor)).unwrap_err().code,
            ErrorCode::Version,
            "glass op should fail with Version at 1.{minor}"
        );
    }
    for minor in 3..=current {
        let mut e = Engine::new(Limits::default());
        assert!(e.apply(&set_minor(&glass_bytes, minor)).is_ok());
    }

    // An unassigned flag fails with Malformed.
    let mut bad_flag_w = W::new(ANY, 1);
    bad_flag_w.reset();
    let mut bad_flag = rect(32.0, 32.0, [1.0, 0.0, 0.0, 1.0]);
    bad_flag.flags = 512;
    bad_flag_w.set(1, 0, &bad_flag);
    let mut e = Engine::new(Limits::default());
    assert_eq!(e.apply(&bad_flag_w.finish()).unwrap_err().code, ErrorCode::Malformed);
}
