//! Regressions in the engine's tiles (decision 0040, phase 2), each one a frame that went wrong
//! before its fix: holes in zoom frames under tight slot budgets, a reader inside a reader left
//! stale, a mitered stroke culled from a tile; prefetch pinning the slots a missing tile was
//! promised, a reader chain rechecking every change on every pass, an atlas refusing a mask its
//! free rows would hold; a drag's history growing with its travel, a drag of a huge selection
//! leaving the view blank, a split kept after its board began to fade.

mod common;

use common::*;
use drawpane_engine::engine::{Camera, Engine, TiledOptions};
use drawpane_engine::limits::Limits;
use drawpane_engine::tiles::{DragInput, Last, TileCache, TileKey};
use vello_common::kurbo::{Affine, Rect};

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

#[test]
fn prefetch_cannot_pin_the_slots_promised_to_a_missing_visible_tile() {
    let mut cache = TileCache::new(512, 16);
    let view = Affine::IDENTITY;
    cache.begin([0.0; 4], 0);
    let level = cache.plan(view, (2048, 1024), false, None, false).unwrap().level;
    let warm = (0..2)
        .flat_map(|j| (0..4).map(move |i| (i, j)))
        .filter(|&cell| cell != (0, 0))
        .chain((-1..=4).map(|i| (i, -1)))
        .chain([(-1, 0), (-1, 1), (-1, 2)]);
    for (i, j) in warm {
        let key = TileKey { level, i, j };
        let slot = cache.slot_for(key).unwrap();
        cache.drawn(key, slot, true);
    }

    // Seven visible tiles and nine neighbors are still held. A prior stand-in covered the view.
    // The eighth visible coordinate has no tile.
    let last = Some(Last {
        view,
        size: (2048, 1024),
    });
    for _ in 0..3 {
        cache.begin([0.0; 4], 0);
        let plan = cache.plan(view, (2048, 1024), false, last, true).unwrap();
        let job = plan
            .jobs
            .iter()
            .find(|j| j.key == (TileKey { level, i: 0, j: 0 }))
            .unwrap();
        let slot = cache.slot_for(job.key);
        if let Some(slot) = slot {
            cache.drawn(job.key, slot, true);
            break;
        }
    }
    let key = TileKey { level, i: 0, j: 0 };
    assert!(
        cache.get(&key).is_some(),
        "prefetch pinned all 16 slots on every rest frame"
    );
}

#[test]
fn a_reader_chain_against_preorder_checks_each_change_once() {
    use drawpane_engine::engine::Engine;
    use drawpane_engine::limits::Limits;
    use drawpane_engine::store::Dirty;
    use vello_common::kurbo::Rect;

    const NESTED: u32 = 128;
    const UNRELATED: usize = 16_384;
    let mut list = W::new(ANY, 1);
    list.reset();
    for id in 1..=NESTED {
        let mut r = Rec::new([1.0, 0.0, 0.0, 1.0, -4.0, 0.0], [1.0, 8.0]);
        r.ops = vec![Op::Children, Op::Read { halo: 2.0 }];
        list.set(id, id - 1, &r);
    }
    let mut engine = Engine::new(Limits::default());
    engine.apply(&list.finish()).unwrap();
    assert_eq!(engine.halo(Affine::IDENTITY).unwrap(), 512);
    let mut dirty = vec![
        Dirty {
            rect: Rect::new(1000.0, 0.0, 1001.0, 8.0),
            order: 0,
            end: 0,
            stale: true,
        };
        UNRELATED
    ];
    let x = -4.0 * f64::from(NESTED);
    dirty.push(Dirty {
        rect: Rect::new(x, 0.0, x + 1.0, 8.0),
        order: 0,
        end: 0,
        stale: true,
    });
    let result = engine.store.dirty(&dirty, Affine::IDENTITY, 1.5);
    assert_eq!(result.len(), dirty.len() + NESTED as usize);
    // Each reader is checked against each change at most once: readers × (changes + readers).
    let bound = u64::from(NESTED) * (dirty.len() as u64 + u64::from(NESTED));
    assert!(
        engine.store.dirty_checks() <= bound,
        "{} checks for {NESTED} readers and {} changes",
        engine.store.dirty_checks(),
        dirty.len()
    );
}

#[test]
fn atlas_eviction_can_combine_the_last_shelf_and_free_tail() {
    use drawpane_engine::atlas::{Placed, Shelves};
    let mut atlas = Shelves::new(64);
    assert!(matches!(atlas.place(63, 50, 1), Some(Placed::At { y: 0, .. })));
    // The preceding submission alone used this shelf. The whole texture is now reusable.
    assert!(
        atlas.place(30, 60, 2).is_some(),
        "eviction ignored the unused rows below the last shelf"
    );
}

/// A card: a rounded box filled and stroked, then a clip to it round its children (a box and a
/// circle, inset by `inset`), as the editor sends a frame that clips its content.
fn card(inset: f32, radius: f32) -> Vec<u8> {
    let mut msg = W::new(ANY, 1);
    msg.reset();
    let mut frame = Rec::new([1.0, 0.0, 0.0, 1.0, 10.3, 7.7], [120.0, 90.0]);
    frame.paths.push(Entry::Rect {
        w: 120.0,
        h: 90.0,
        radii: [radius; 4],
    });
    frame.ops = vec![
        Op::Fill {
            path: 0,
            even_odd: false,
            paint: Paint::Solid([0.9, 0.9, 0.85, 1.0]),
        },
        Op::Clip {
            path: 0,
            even_odd: false,
        },
        Op::Children,
        Op::Unclip,
    ];
    msg.set(1, 0, &frame);
    let mut inner = solid(f64::from(inset) + 0.37, 120.0 - 2.0 * inset, 30.0, 0.8);
    inner.transform[5] = f64::from(inset) + 0.61;
    msg.set(2, 1, &inner);
    let mut dot = Rec::new([1.0, 0.0, 0.0, 1.0, f64::from(inset) + 3.3, 55.2], [21.7, 21.7]);
    dot.paths.push(Entry::Ellipse { w: 21.7, h: 21.7 });
    dot.ops.push(Op::Fill {
        path: 0,
        even_odd: false,
        paint: Paint::Solid([0.1, 0.4, 0.9, 0.7]),
    });
    msg.set(3, 1, &dot);
    msg.finish()
}

#[test]
fn a_clip_that_changes_nothing_draws_the_same_pixels_left_out() {
    // Content clear of the corners: the clip is left out. The same card with corners round
    // enough to reach the content keeps its clip; where the content is, both draw alike.
    let c = Camera {
        zoom: 0.73,
        x: 3.3,
        y: -1.6,
        dpr: 1.25,
    };
    let draw = |bytes: &[u8]| {
        let mut e = Engine::new(Limits::default());
        e.apply(bytes).unwrap();
        e.render_cpu(160, 120, c, [1.0; 4], false).unwrap().0.to_vec()
    };
    let left_out = draw(&card(16.0, 12.0));
    let kept = draw(&card(16.0, 40.0));
    let s = 0.73 * 1.25;
    let px = |v: f64, o: f64| (v * s + o * 1.25) as usize;
    let (x0, y0) = (px(10.3 + 16.0, 3.3) + 1, px(7.7 + 16.0, -1.6) + 1);
    let (x1, y1) = (px(10.3 + 104.0, 3.3) - 1, px(7.7 + 77.0, -1.6) - 1);
    for y in y0..y1 {
        for x in x0..x1 {
            let at = (y * 160 + x) * 4;
            assert_eq!(left_out[at..at + 4], kept[at..at + 4], "pixel ({x}, {y})");
        }
    }
}

#[test]
fn a_box_stroke_as_a_ring_matches_the_stroker() {
    // A box's stroke is drawn as the ring it paints (rounded corners, or square ones under a miter
    // or round join); the same outline sent as a path goes to the stroker. Within anti-aliasing.
    use vello_common::kurbo::PathEl;
    let draw = |entry: Entry, width: f32, join: u32| {
        let mut r = Rec::new([1.0, 0.0, 0.0, 1.0, 12.3, 9.6], [70.0, 44.0]);
        r.paths.push(entry);
        r.ops.push(Op::Stroke {
            path: 0,
            width,
            join,
            cap: 0,
            dashes: vec![],
            offset: 0.0,
            paint: Paint::Solid([0.1, 0.2, 0.8, 1.0]),
        });
        let mut msg = W::new(ANY, 1);
        msg.reset();
        msg.set(1, 0, &r);
        let mut e = Engine::new(Limits::default());
        e.apply(&msg.finish()).unwrap();
        e.render_cpu(100, 70, camera(1.3, 0.4, 0.2), [1.0; 4], false)
            .unwrap()
            .0
            .to_vec()
    };
    for (radius, width, join) in [(12.0, 4.0, 0), (9.0, 7.5, 1), (0.0, 3.0, 0), (0.0, 3.0, 1)] {
        let outline = drawpane_engine::geometry::rounded_rect(70.0, 44.0, [radius; 4], 0.0);
        let path = outline
            .elements()
            .iter()
            .map(|el| match *el {
                PathEl::MoveTo(p) => (0, vec![p.x as f32, p.y as f32]),
                PathEl::LineTo(p) => (1, vec![p.x as f32, p.y as f32]),
                PathEl::QuadTo(a, p) => (2, vec![a.x as f32, a.y as f32, p.x as f32, p.y as f32]),
                PathEl::CurveTo(a, b, p) => (
                    3,
                    vec![a.x as f32, a.y as f32, b.x as f32, b.y as f32, p.x as f32, p.y as f32],
                ),
                PathEl::ClosePath => (4, vec![]),
            })
            .collect();
        let ring = draw(
            Entry::Rect {
                w: 70.0,
                h: 44.0,
                radii: [radius; 4],
            },
            width,
            join,
        );
        let stroked = draw(Entry::Path(path), width, join);
        let worst = ring
            .iter()
            .zip(&stroked)
            .map(|(a, b)| a.abs_diff(*b))
            .max()
            .unwrap_or(0);
        let off = ring.iter().zip(&stroked).filter(|(a, b)| a.abs_diff(**b) > 2).count();
        assert!(ring.iter().any(|v| *v != 255), "drew nothing");
        // A square corner may differ in a pixel or two where the stroker closes its outline.
        let most = if radius > 0.0 { 24 } else { 64 };
        assert!(
            worst <= most && off <= 40,
            "radius {radius}, width {width}, join {join}: worst {worst}, {off} channels off"
        );
    }
}

#[test]
fn an_image_shrunk_to_nothing_paints_nothing() {
    // An image tiled at 1e-38 of a page unit: its inverse overflows a float, and vello_cpu's
    // sample positions become NaN. On x86 that indexed past the image and panicked (CI's fuzz,
    // seed 1795185273032291663); elsewhere it read the first pixel across the shape. Nothing.
    let mut r = Rec::new([1.0, 0.0, 0.0, 1.0, 4.0, 4.0], [40.0, 30.0]);
    r.paths.push(Entry::Rect {
        w: 40.0,
        h: 30.0,
        radii: [0.0; 4],
    });
    r.ops.push(Op::Fill {
        path: 0,
        even_odd: false,
        paint: Paint::Image {
            id: 7,
            m: [1e-38, 0.0, 0.0, 1e-38, 0.0, 0.0],
            tile: true,
            opacity: 1.0,
        },
    });
    let mut list = W::new(ANY, 1);
    list.reset();
    list.set(1, 0, &r);
    let mut e = Engine::new(Limits::default());
    e.apply(&list.finish()).unwrap();
    let pixels: Vec<u8> = (0..64).flat_map(|_| [200u8, 30, 60, 255]).collect();
    e.put_image(7, 8, 8, &pixels, false).unwrap();
    let (frame, _) = e.render_cpu(64, 48, camera(1.0, 0.0, 0.0), [1.0; 4], false).unwrap();
    assert!(frame.iter().all(|v| *v == 255), "the image painted");
}

/// A 640-unit square filled with a `side` × `side` image of one colour placed by `matrix`
/// (repeated when `tile`), under the record transform `at`.
fn image_fill(matrix: [f64; 6], tile: bool, side: u32, at: [f64; 6], colour: [u8; 4]) -> Engine {
    let mut shape = Rec::new(at, [640.0, 640.0]);
    shape.paths.push(Entry::Rect {
        w: 640.0,
        h: 640.0,
        radii: [0.0; 4],
    });
    shape.ops.push(Op::Fill {
        path: 0,
        even_odd: false,
        paint: Paint::Image {
            id: 7,
            m: matrix,
            tile,
            opacity: 1.0,
        },
    });
    let mut list = W::new(ANY, 1);
    list.reset();
    list.set(1, 0, &shape);
    let mut e = Engine::new(Limits::default());
    e.apply(&list.finish()).unwrap();
    let pixels: Vec<u8> = (0..side * side).flat_map(|_| colour).collect();
    e.put_image(7, side, side, &pixels, true).unwrap();
    e
}

#[test]
fn a_finite_but_lopsided_repeat_never_indexes_past_the_image() {
    // The re-check's case: a 3×3 image repeated every 1e-8 units down and 25 across. Its
    // positions down pass what a float's remainder keeps exact, and the repeat indexed past the
    // nine pixels (a panic on any CPU). Such a repeat paints nothing.
    for side in [3, 5, 7, 11, 17] {
        for exponent in [4, 6, 8, 9, 10, 11] {
            for offset in [0.0, 0.124, 19.25, -19.25, 80.75, -80.75] {
                let m = [25.0, 0.0, 0.0, 10f64.powi(-exponent), 0.3, offset];
                let mut e = image_fill(m, true, side, [1.0, 0.0, 0.0, 1.0, 0.0, 0.0], [160; 4]);
                e.render_cpu(48, 40, camera(1.0, 0.0, 0.0), [0.0; 4], false)
                    .unwrap_or_else(|err| panic!("{m:?}: {err}"));
            }
        }
    }
}

#[test]
fn an_image_is_painted_alike_in_a_tile_and_the_whole_frame() {
    // The re-check's case: a padded image 1e-10 units tall at y = 520. The old guard bounded the
    // inverse's translation, which differs between the whole frame and the tile at y = 512: the
    // whole frame left it out, the tile painted it. The decision is the record's now.
    let mut e = image_fill(
        [20.0, 0.0, 0.0, 1e-10, 0.0, 520.0],
        false,
        3,
        [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
        [160; 4],
    );
    let c = camera(1.0, 0.0, 0.0);
    let at = (550 * 64 + 24) * 4;
    let whole = e.render_cpu(64, 576, c, [0.0; 4], false).unwrap().0[at..at + 4].to_vec();
    let (tiled, stats) = e
        .render_cpu_tiled(64, 576, c, [0.0; 4], TiledOptions::default())
        .unwrap();
    assert!(stats.exact, "{stats:?}");
    assert_eq!(&tiled[at..at + 4], whole.as_slice());
}

#[test]
fn degenerate_image_placements_never_panic_and_tiles_match_the_whole_frame() {
    // Images placed every way that strains sampling: repeated or padded, scaled from 1e-12 to
    // 1e12 on each axis, skewed, rotated, nearly singular, far from the shape, under records
    // scaled and turned, at three zooms. None may panic, and the exact tiles must be the whole
    // frame's (one colour an image: only whether and where it paints shows).
    let mut r = Rng(0x1_3a6e_0040);
    let pow = |r: &mut Rng, lo: f32, hi: f32| 10f64.powf(f64::from(r.range(lo, hi)));
    for case in 0..400 {
        let side = 1 + r.below(17);
        let tile = r.chance(0.6);
        let (sx, sy) = (pow(&mut r, -12.0, 12.0), pow(&mut r, -12.0, 12.0));
        let skew = if r.chance(0.4) {
            f64::from(r.range(-50.0, 50.0))
        } else {
            0.0
        };
        let turn = if r.chance(0.4) {
            f64::from(r.range(0.0, 6.3))
        } else {
            0.0
        };
        let (cs, sn) = (turn.cos(), turn.sin());
        // Rotation × skew × scale, then nudged towards singular now and then.
        let (mut a, b, c0, d0) = (cs * sx, sn * sx, (cs * skew - sn) * sy, (sn * skew + cs) * sy);
        if r.chance(0.2) {
            // Columns nearly parallel: the determinant a tiny part of what it would be.
            let k = if d0.abs() > 1e-20 { c0 / d0 } else { 1.0 };
            a = k * b + a * pow(&mut r, -14.0, -6.0);
        }
        let shift = if r.chance(0.5) { pow(&mut r, -2.0, 9.0) } else { 0.0 };
        // As the wire carries it: f32s, none past what one holds.
        let f = |v: f64| f64::from(v.clamp(-1e30, 1e30) as f32);
        let m = [
            f(a),
            f(b),
            f(c0),
            f(d0),
            f(f64::from(r.range(-1.0, 1.0)) * shift),
            f(f64::from(r.range(-1.0, 1.0)) * shift),
        ];
        let k = pow(&mut r, -1.5, 1.5);
        let t = f64::from(r.range(0.0, 6.3));
        let at = [k * t.cos(), k * t.sin(), -k * t.sin(), k * t.cos(), 20.0, 10.0];
        let colour = [(r.below(200) + 40) as u8, 90, 30, 255];
        let zoom = [0.25, 1.0, 3.0][r.below(3) as usize];
        let c = camera(zoom, 3.5, -2.25);
        let mut e = image_fill(m, tile, side, at, colour);
        e.use_cpu_tiles(32, 256);
        let whole = e
            .render_cpu(96, 80, c, [0.0; 4], false)
            .unwrap_or_else(|err| panic!("case {case} {m:?}: {err}"))
            .0
            .to_vec();
        let (tiled, stats) = e
            .render_cpu_tiled(96, 80, c, [0.0; 4], TiledOptions::default())
            .unwrap_or_else(|err| panic!("case {case} {m:?}: {err}"));
        assert!(stats.exact, "case {case}: {stats:?}");
        let worst = whole.iter().zip(tiled).map(|(a, b)| a.abs_diff(*b)).max().unwrap_or(0);
        assert!(
            worst <= 2,
            "case {case} {m:?} tile {tile} at {at:?} zoom {zoom}: worst {worst}"
        );
    }
}

#[test]
fn large_drag_never_suppresses_all_visible_work() {
    let mut rect = Rec::new([1.0, 0.0, 0.0, 1.0, 0.0, 0.0], [34_000.0; 2]);
    rect.paths.push(Entry::Rect {
        w: 34_000.0,
        h: 34_000.0,
        radii: [0.0; 4],
    });
    rect.ops.push(Op::Fill {
        path: 0,
        even_odd: false,
        paint: Paint::Solid([1.0, 0.0, 0.0, 1.0]),
    });

    let options = TiledOptions {
        prefetch: false,
        ..TiledOptions::default()
    };
    let mut msg = W::new(ANY, 1);
    msg.reset();
    msg.set(1, 0, &rect);
    let mut engine = Engine::new(Limits::default());
    engine.use_cpu_tiles(512, 256);
    engine.apply(&msg.finish()).unwrap();
    engine
        .render_cpu_tiled(64, 64, camera(1.0, 1000.0, 0.0), [0.0; 4], options)
        .unwrap();

    let mut patch = W::new(1, 2);
    patch.transform(1, [1.0, 0.0, 0.0, 1.0, 1.0, 0.0]);
    engine.apply(&patch.finish()).unwrap();
    let (pixels, stats) = engine
        .render_cpu_tiled(64, 64, camera(1.0, 0.0, 0.0), [0.0; 4], options)
        .unwrap();
    assert_eq!(
        &pixels[(32 * 64 + 32) * 4..][..4],
        &[255, 0, 0, 255],
        "on-screen selection vanished: {stats:?}"
    );
}

#[test]
fn offscreen_drag_history_is_not_retained_without_a_slot() {
    let mut cache = TileCache::new(512, 16);
    cache.begin([0.0; 4], 0);
    let mut plan = cache.plan(Affine::IDENTITY, (64, 64), false, None, false).unwrap();
    for step in 1..=2048 {
        let x = f64::from(step - 1) * 1024.0 + 32.0;
        cache.drag_prepare(
            &mut plan,
            Some(&DragInput {
                serial: 1,
                moves: step as u64,
                start: None,
                now: Rect::new(x, 32.0, x + 4.0, 36.0),
                eligible: true,
            }),
        );
    }
    assert_eq!(cache.slots(), 0, "fixture must retain no tiles");
    let selection = Rect::new(2047.0 * 1024.0 + 32.0, 32.0, 2047.0 * 1024.0 + 36.0, 36.0);
    assert!(
        cache.drag_tiles(&plan, selection).is_empty(),
        "the cache still retains a tile from the start of the drag even though none was ever drawn"
    );
}

#[test]
fn fading_an_ancestor_rechecks_drag_eligibility() {
    let mut parent = Rec::new([1.0, 0.0, 0.0, 1.0, 0.0, 0.0], [128.0; 2]);
    parent.ops.push(Op::Children);
    let child = Rec::new([1.0, 0.0, 0.0, 1.0, 0.0, 0.0], [64.0; 2]);
    let mut fresh = W::new(ANY, 1);
    fresh.reset();
    fresh.set(1, 0, &parent);
    fresh.set(2, 1, &child);
    fresh.set(3, 1, &child);
    let mut e = Engine::new(Limits::default());
    e.apply(&fresh.finish()).unwrap();

    let mut move_child = W::new(1, 2);
    move_child.transform(2, [1.0, 0.0, 0.0, 1.0, 5.0, 0.0]);
    e.apply(&move_child.finish()).unwrap();
    assert!(e.drag_frame().unwrap().split.is_some(), "drag must start eligible");

    parent.flags = 2;
    parent.opacity = 0.5;
    let mut fade = W::new(2, 3);
    fade.set(1, 0, &parent);
    e.apply(&fade.finish()).unwrap();
    assert!(
        e.drag_frame().is_none_or(|d| d.split.is_none()),
        "drag retained an ineligible split"
    );
}

#[test]
fn a_drag_erases_its_selection_from_the_last_frame_with_no_tile_kept_there() {
    // The split draws the selection into the frame where no tile of its own is kept (the view
    // opened somewhere else); when the selection moves away, that frame's pixels are all that
    // show it there, and a frame drawing no optional tile must still not show it.
    let mut r = Rec::new([1.0, 0.0, 0.0, 1.0, 8.0, 8.0], [16.0; 2]);
    r.paths.push(Entry::Rect {
        w: 16.0,
        h: 16.0,
        radii: [0.0; 4],
    });
    r.ops.push(Op::Fill {
        path: 0,
        even_odd: false,
        paint: Paint::Solid([1.0, 0.0, 0.0, 1.0]),
    });
    let mut list = W::new(ANY, 1);
    list.reset();
    list.set(1, 0, &r);
    let mut engine = Engine::new(Limits::default());
    engine.use_cpu_tiles(64, 16);
    engine.apply(&list.finish()).unwrap();
    let bg = [0.0; 4];
    let still = TiledOptions {
        prefetch: false,
        ..TiledOptions::default()
    };
    let starved = TiledOptions {
        max_jobs: 0,
        prefetch: false,
        moving: true,
        ..TiledOptions::default()
    };
    engine
        .render_cpu_tiled(64, 64, camera(1.0, 512.0, 0.0), bg, still)
        .unwrap();
    let at = (16 * 64 + 32) * 4;
    let mut x = 24.0;
    for revision in 1..4 {
        let mut shift = W::new(revision, revision + 1);
        shift.transform(1, [1.0, 0.0, 0.0, 1.0, x, 8.0]);
        engine.apply(&shift.finish()).unwrap();
        let (frame, stats) = engine
            .render_cpu_tiled(64, 64, camera(1.0, 0.0, 0.0), bg, starved)
            .unwrap();
        let want: &[u8] = if x < 32.0 { &[255, 0, 0, 255] } else { &[0, 0, 0, 0] };
        assert_eq!(&frame[at..at + 4], want, "selection at {x}: {stats:?}");
        // In, out of the view, and back beside where it was.
        x = if revision == 1 { 200.0 } else { 40.0 };
    }
}
