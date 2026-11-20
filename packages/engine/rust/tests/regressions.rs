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
    // A non-normal paint blend is valid on the wire, and the executor refuses it only when it
    // walks it: off screen (or outside an export's crop) nothing walks it. It's found at decode.
    let mut e = Engine::new(Limits::default());
    let mut w = W::new(ANY, 1);
    w.reset();
    w.set(1, 0, &rect(20.0, 20.0, [1.0; 4]));
    let mut blended = far_with(Paint::Solid([1.0, 0.0, 0.0, 1.0]));
    blended.blend = 3;
    w.set(2, 0, &blended);
    e.apply(&w.finish()).unwrap();
    assert!(matches!(e.render_cpu(64, 64, camera(), [0.0; 4], true), Err(err) if err.code == ErrorCode::Unsupported));
    assert!(matches!(e.render_band(64, 64, camera(), [0.0; 4], 0, 16), Err(err) if err.code == ErrorCode::Unsupported));
    assert!(matches!(e.admit_export(64, 64, camera()), Err(err) if err.code == ErrorCode::Unsupported));
}

#[test]
fn a_blend_on_the_wire_refuses_the_page_not_the_message() {
    // Applying succeeds (the message is valid); drawing the page is refused, so the editor falls
    // back for the page, not for the session. Smoothed corners are now drawn natively.
    let mut e = Engine::new(Limits::default());
    let mut blended = far_with(Paint::Solid([1.0; 4]));
    blended.blend = 3;
    let mut w = W::new(ANY, 1);
    w.reset();
    w.set(1, 0, &blended);
    e.apply(&w.finish()).unwrap();
    assert!(matches!(e.render_cpu(64, 64, camera(), [0.0; 4], true), Err(err) if err.code == ErrorCode::Unsupported));
    let mut smooth = rect(40.0, 40.0, [1.0, 0.0, 0.0, 1.0]);
    smooth.paths = vec![Entry::Rect {
        w: 40.0,
        h: 40.0,
        radii: [12.0; 4],
    }];
    smooth.smoothing = 0.6;
    let mut w = W::new(ANY, 2);
    w.reset();
    w.set(1, 0, &smooth);
    e.apply(&w.finish()).unwrap();
    let smooth_px = pixels(&mut e);
    smooth.smoothing = 0.0;
    let mut w = W::new(ANY, 3);
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
