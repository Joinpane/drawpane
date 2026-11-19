//! Regressions in the engine's tiles (decision 0040, phase 2), each one a frame that went wrong
//! before its fix: holes in zoom frames under tight slot budgets, a reader inside a reader left
//! stale, a mitered stroke culled from a tile.

mod common;

use common::*;
use drawpane_engine::engine::{Camera, Engine, TiledOptions};
use drawpane_engine::limits::Limits;
use vello_common::kurbo::Affine;

fn camera(zoom: f64, x: f64, y: f64) -> Camera {
    Camera { zoom, x, y, dpr: 1.0 }
}

fn solid(x: f64, w: f32, h: f32, red: f32) -> Rec {
    let mut record = Rec::new([1.0, 0.0, 0.0, 1.0, x, 0.0], [w, h]);
    record.paths.push(Entry::Rect { w, h, radii: [0.0; 4] });
    record.ops.push(Op::Fill {
        path: 0,
        even_odd: false,
        paint: Paint::Solid([red, 0.0, 0.0, 1.0]),
    });
    record
}

#[test]
fn tight_tile_budget_never_produces_a_background_only_zoom_frame() {
    let mut msg = W::new(ANY, 1);
    msg.reset();
    msg.set(1, 0, &solid(0.0, 1500.0, 1500.0, 1.0));
    let mut engine = Engine::new(Limits::default());
    engine.use_cpu_tiles(48, 1);
    engine.apply(&msg.finish()).unwrap();
    engine
        .render_cpu_tiled(40, 40, camera(1.0, -1000.0, -1000.0), [0.0; 4], TiledOptions::default())
        .unwrap();

    let (pixels, stats) = engine
        .render_cpu_tiled(
            40,
            40,
            camera(2.0, 0.25, 0.25),
            [0.0; 4],
            TiledOptions {
                moving: true,
                max_jobs: 0,
                prefetch: false,
                ..TiledOptions::default()
            },
        )
        .unwrap();
    assert_eq!(&pixels[(20 * 40 + 20) * 4..][..4], &[255, 0, 0, 255], "{stats:?}");
}

#[test]
fn zoom_coverage_at_one_gpu_page_of_slots() {
    let mut msg = W::new(ANY, 1);
    msg.reset();
    msg.set(1, 0, &solid(0.0, 3500.0, 3500.0, 1.0));
    let mut engine = Engine::new(Limits::default());
    engine.use_cpu_tiles(512, 16);
    engine.apply(&msg.finish()).unwrap();
    engine
        .render_cpu_tiled(64, 64, camera(1.0, 4000.0, 4000.0), [0.0; 4], TiledOptions::default())
        .unwrap();
    let (pixels, stats) = engine
        .render_cpu_tiled(
            1536,
            1536,
            camera(2.0, -0.25, -0.25),
            [0.0; 4],
            TiledOptions {
                moving: true,
                max_jobs: 0,
                prefetch: false,
                ..TiledOptions::default()
            },
        )
        .unwrap();
    assert_eq!(&pixels[(1200 * 1536 + 1200) * 4..][..4], &[255, 0, 0, 255], "{stats:?}");
}

fn readers(revision: u32, red: f32) -> Vec<u8> {
    let mut msg = W::new(ANY, revision);
    msg.reset();
    let mut outer = Rec::new([1.0, 0.0, 0.0, 1.0, 128.0, 0.0], [18.0, 32.0]);
    outer.ops = vec![Op::Children, Op::Read { halo: 8.0 }];
    let mut inner = Rec::new([1.0, 0.0, 0.0, 1.0, -8.0, 0.0], [6.0, 32.0]);
    inner.ops = vec![Op::Read { halo: 8.0 }];
    msg.set(1, 0, &outer);
    msg.set(2, 1, &solid(-19.0, 7.0, 32.0, red));
    msg.set(3, 1, &inner);
    msg.finish()
}

#[test]
fn inner_reader_edit_invalidates_outer_post_children_reader() {
    let mut warm = Engine::new(Limits::default());
    let mut fresh = Engine::new(Limits::default());
    for engine in [&mut warm, &mut fresh] {
        engine.use_cpu_tiles(32, 32);
    }
    warm.apply(&readers(1, 0.0)).unwrap();
    fresh.apply(&readers(2, 1.0)).unwrap();
    let c = camera(1.0, 0.0, 0.0);
    let bg = [0.0, 0.0, 0.0, 1.0];
    let options = TiledOptions {
        prefetch: false,
        ..TiledOptions::default()
    };
    let before = warm.render_cpu_tiled(160, 32, c, bg, options).unwrap().0.to_vec();

    let mut patch = W::new(1, 2);
    patch.set(2, 1, &solid(-19.0, 7.0, 32.0, 1.0));
    warm.apply(&patch.finish()).unwrap();
    let (retained, stats) = warm.render_cpu_tiled(160, 32, c, bg, options).unwrap();
    let (expected, _) = fresh.render_cpu_tiled(160, 32, c, bg, options).unwrap();
    let at = (16 * 160 + 128) * 4;
    assert_ne!(before[at], expected[at], "fixture must change the outer reader's pixel");
    assert!(stats.exact);
    assert_eq!(retained[at], expected[at], "retained outer reader was stale");
}

/// Three readers nested, each reading after its children (the outer one with paint of its own
/// first and a read before its children too), in a row: a fill beneath the innermost, then
/// each reader reading the last one's paint and not the fill.
fn nested(revision: u32, red: f32) -> Vec<u8> {
    let mut msg = W::new(ANY, revision);
    msg.reset();
    let mut outer = Rec::new([1.0, 0.0, 0.0, 1.0, 160.0, 0.0], [30.0, 32.0]);
    outer.paths.push(Entry::Rect {
        w: 4.0,
        h: 32.0,
        radii: [0.0; 4],
    });
    outer.ops = vec![
        Op::Fill {
            path: 0,
            even_odd: false,
            paint: Paint::Solid([0.0, 0.0, 1.0, 1.0]),
        },
        Op::Read { halo: 8.0 },
        Op::Children,
        Op::Read { halo: 8.0 },
    ];
    // On the page: the middle at 150..160, the inner at 140..150, the fill at 126..136; each
    // reader reads 8 round itself, so the inner reads the fill, the middle the inner, the outer
    // the middle, and none reads further.
    let mut middle = Rec::new([1.0, 0.0, 0.0, 1.0, -10.0, 0.0], [10.0, 32.0]);
    middle.ops = vec![Op::Children, Op::Read { halo: 8.0 }];
    let mut inner = Rec::new([1.0, 0.0, 0.0, 1.0, -10.0, 0.0], [10.0, 32.0]);
    inner.ops = vec![Op::Read { halo: 8.0 }];
    msg.set(1, 0, &outer);
    msg.set(2, 1, &middle);
    msg.set(3, 2, &solid(-24.0, 10.0, 32.0, red));
    msg.set(4, 2, &inner);
    msg.finish()
}

#[test]
fn a_change_reaches_readers_through_nested_readers() {
    // Readers dim each other's changes (each averages), so pixels can't show the third reader's
    // turn reliably; the contract is where tiles go stale: every reader the change reaches,
    // through each other, joins the dirty region.
    let mut e = Engine::new(Limits::default());
    e.apply(&nested(1, 0.0)).unwrap();
    let mut patch = W::new(1, 2);
    patch.set(3, 2, &solid(-24.0, 10.0, 32.0, 1.0));
    let applied = e.apply(&patch.finish()).unwrap();
    let dirty = e.store.dirty(&applied.changes, Affine::IDENTITY, 0.0);
    let covered = |x0: f64, x1: f64| {
        dirty
            .iter()
            .any(|r| r.x0 <= x0 && r.x1 >= x1 && r.y0 <= 0.0 && r.y1 >= 32.0)
    };
    assert!(covered(126.0, 136.0), "the fill: {dirty:?}");
    assert!(covered(140.0, 150.0), "the inner reader: {dirty:?}");
    assert!(covered(150.0, 160.0), "the middle reader: {dirty:?}");
    assert!(covered(160.0, 190.0), "the outer reader: {dirty:?}");
}

#[test]
fn wire_stroke_miter_can_reach_across_a_tile_boundary() {
    let mut stroke = Rec::new([1.0, 0.0, 0.0, 1.0, 0.0, 0.0], [195.0, 64.0]);
    stroke.paths.push(Entry::Path(vec![
        (0, vec![194.0, 30.0]),
        (1, vec![154.0, 32.0]),
        (1, vec![194.0, 34.0]),
    ]));
    stroke.ops.push(Op::Stroke {
        path: 0,
        width: 4.0,
        join: 0,
        cap: 0,
        dashes: vec![],
        offset: 0.0,
        paint: Paint::Solid([1.0, 0.0, 0.0, 1.0]),
    });

    let mut msg = W::new(ANY, 1);
    msg.reset();
    msg.set(1, 0, &stroke);
    let mut bytes = msg.finish();
    // The common writer always emits a miter limit of 10. Override that wire field.
    let style = [2, 0, 4.0_f32.to_bits(), 0, 0, 10.0_f32.to_bits()]
        .into_iter()
        .flat_map(u32::to_le_bytes)
        .collect::<Vec<_>>();
    let at = bytes.windows(style.len()).position(|w| w == style).unwrap() + 20;
    bytes[at..at + 4].copy_from_slice(&40.0_f32.to_le_bytes());

    let mut engine = Engine::new(Limits::default());
    engine.use_cpu_tiles(64, 32);
    engine.apply(&bytes).unwrap();
    let c = camera(1.0, 0.0, 0.0);
    let whole = engine.render_cpu(256, 64, c, [0.0; 4], false).unwrap().0.to_vec();
    let (tiles, stats) = engine
        .render_cpu_tiled(256, 64, c, [0.0; 4], TiledOptions::default())
        .unwrap();
    let at = (32 * 256 + 124) * 4 + 3;
    assert!(
        whole[at] > 0,
        "fixture's whole frame must draw the miter in the left tile"
    );
    assert!(stats.exact);
    assert_eq!(tiles[at], whole[at], "the tile culled a visible miter");
}
