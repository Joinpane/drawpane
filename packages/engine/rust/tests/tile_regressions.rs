//! Regressions in the engine's tiles (decision 0040, phase 2), each one a frame that went wrong
//! before its fix: holes in zoom frames under tight slot budgets, a reader inside a reader left
//! stale, a mitered stroke culled from a tile; prefetch pinning the slots a missing tile was
//! promised, a reader chain rechecking every change on every pass; a drag's history growing with
//! its travel, a drag of a huge selection leaving the view blank, a split kept after its board
//! began to fade, a selection left in the last frame; a page opened at a fractional device pixel
//! ratio showing nothing, provisional text exported or reported exact.

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
    outer.ops = vec![Op::Children, Op::Read { kernel: 1, halo: 8.0 }];
    let mut inner = Rec::new([1.0, 0.0, 0.0, 1.0, -8.0, 0.0], [6.0, 32.0]);
    inner.ops = vec![Op::Read { kernel: 1, halo: 8.0 }];
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
        Op::Read { kernel: 1, halo: 8.0 },
        Op::Children,
        Op::Read { kernel: 1, halo: 8.0 },
    ];
    // On the page: the middle at 150..160, the inner at 140..150, the fill at 126..136; each
    // reader reads 8 round itself, so the inner reads the fill, the middle the inner, the outer
    // the middle, and none reads further.
    let mut middle = Rec::new([1.0, 0.0, 0.0, 1.0, -10.0, 0.0], [10.0, 32.0]);
    middle.ops = vec![Op::Children, Op::Read { kernel: 1, halo: 8.0 }];
    let mut inner = Rec::new([1.0, 0.0, 0.0, 1.0, -10.0, 0.0], [10.0, 32.0]);
    inner.ops = vec![Op::Read { kernel: 1, halo: 8.0 }];
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
    let level = cache.plan(view, (2048, 1024), false, None, false, false).unwrap().level;
    let warm = (0..2)
        .flat_map(|j| (0..4).map(move |i| (i, j)))
        .filter(|&cell| cell != (0, 0))
        .chain((-1..=4).map(|i| (i, -1)))
        .chain([(-1, 0), (-1, 1), (-1, 2)]);
    for (i, j) in warm {
        let key = TileKey { level, i, j };
        let slot = cache.slot_for(key).unwrap();
        cache.drawn(key, slot, true, true);
    }

    // Seven visible tiles and nine neighbors are still held. A prior stand-in covered the view.
    // The eighth visible coordinate has no tile.
    let last = Some(Last {
        view,
        size: (2048, 1024),
    });
    for _ in 0..3 {
        cache.begin([0.0; 4], 0);
        let plan = cache.plan(view, (2048, 1024), false, last, true, false).unwrap();
        let job = plan
            .jobs
            .iter()
            .find(|j| j.key == (TileKey { level, i: 0, j: 0 }))
            .unwrap();
        let slot = cache.slot_for(job.key);
        if let Some(slot) = slot {
            cache.drawn(job.key, slot, true, true);
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
        r.ops = vec![Op::Children, Op::Read { kernel: 1, halo: 2.0 }];
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
    let mut plan = cache
        .plan(Affine::IDENTITY, (64, 64), false, None, false, false)
        .unwrap();
    for step in 1u32..=2048 {
        let x = f64::from(step - 1) * 1024.0 + 32.0;
        cache.drag_prepare(
            &mut plan,
            Some(&DragInput {
                serial: 1,
                moves: u64::from(step),
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

/// A 512-unit square, filled red.
fn square() -> Rec {
    solid(0.0, 512.0, 512.0, 1.0)
}

/// An engine given `record` alone, in a list of version 1.1 (provisional records are 1.1).
fn provisional_engine(record: &Rec) -> Engine {
    let mut msg = W::new(ANY, 1);
    msg.b[6..8].copy_from_slice(&1u16.to_le_bytes());
    msg.reset();
    msg.set(1, 0, record);
    let mut engine = Engine::new(Limits::default());
    engine.apply(&msg.finish()).unwrap();
    engine
}

#[test]
fn opening_at_non_ladder_scale_draws_content() {
    let mut engine = provisional_engine(&square());
    engine.use_cpu_tiles(48, 32);
    let camera = Camera {
        dpr: 1.25,
        ..camera(1.0, 0.0, 0.0)
    };
    let (pixels, stats) = engine
        .render_cpu_tiled(
            64,
            64,
            camera,
            [0.0; 4],
            TiledOptions {
                max_jobs: 1,
                ..TiledOptions::default()
            },
        )
        .unwrap();
    assert!(!stats.exact, "opening should use a stand-in");
    assert!(stats.tiles_drawn > 0, "opening did no tile work");
    assert_eq!(&pixels[(32 * 64 + 32) * 4..][..4], &[255, 0, 0, 255]);
}

#[test]
fn provisional_text_is_refused_before_png_and_band() {
    let mut provisional = square();
    provisional.flags = 8;
    provisional.coarse = std::mem::take(&mut provisional.ops);
    let mut engine = provisional_engine(&provisional);
    let camera = camera(1.0, 0.0, 0.0);
    let admission = engine.admit_export(64, 64, camera);
    let band = engine.render_band(64, 64, camera, [0.0; 4], 0, 4);
    assert!(
        admission.is_err() && band.is_err(),
        "provisional content was accepted: admission {admission:?}, band first pixel {:?}",
        band.ok().map(|pixels| &pixels[..4])
    );
}

#[test]
fn a_visible_provisional_record_without_bars_is_not_exact() {
    let mut provisional = square();
    provisional.flags = 8;
    provisional.ops.clear();
    provisional.paths.clear();
    let mut engine = provisional_engine(&provisional);
    engine.use_cpu_tiles(48, 32);
    let (_, stats) = engine
        .render_cpu_tiled(64, 64, camera(1.0, 0.0, 0.0), [0.0; 4], TiledOptions::default())
        .unwrap();
    assert!(
        !stats.exact,
        "an accepted visible provisional record was described as exact"
    );
}

#[test]
fn a_provisional_tile_waits_for_the_text_and_is_not_drawn_again_meanwhile() {
    // Text still loading: its record is provisional. Its tiles are drawn once at full detail;
    // until the list changes there's nothing more to draw (no frame or slice between frames
    // draws them again), though no frame is exact. When the text arrives they're drawn again
    // and the frame is exact.
    let mut provisional = square();
    provisional.flags = 8;
    provisional.coarse = provisional.ops.clone();
    let mut engine = provisional_engine(&provisional);
    engine.use_cpu_tiles(48, 64);
    let c = camera(1.0, 0.0, 0.0);
    let options = TiledOptions {
        prefetch: false,
        ..TiledOptions::default()
    };
    // The page opens coarse, then its own tiles are drawn: a few frames, bounded.
    let mut frames = 0;
    loop {
        let (_, f) = engine.render_cpu_tiled(96, 96, c, [0.0; 4], options).unwrap();
        assert!(!f.exact, "{f:?}");
        frames += 1;
        if f.pending == 0 {
            break;
        }
        assert!(frames < 4, "never settled: {f:?}");
    }
    let (_, again) = engine.render_cpu_tiled(96, 96, c, [0.0; 4], options).unwrap();
    assert!(!again.exact, "{again:?}");
    assert_eq!((again.tiles_drawn, again.pending), (0, 0), "{again:?}");
    // Between frames: only tiles round the view (ahead of a pan), none of the frame's again.
    let ahead = engine.render_cpu_ahead([0.0; 4], usize::MAX).unwrap();
    assert_eq!(ahead.pending, 0, "{ahead:?}");
    let (_, still) = engine.render_cpu_tiled(96, 96, c, [0.0; 4], options).unwrap();
    assert_eq!(
        (still.tiles_drawn, still.pending, still.exact),
        (0, 0, false),
        "{still:?}"
    );

    let mut patch = W::new(1, 2);
    patch.b[6..8].copy_from_slice(&1u16.to_le_bytes());
    patch.set(1, 0, &square());
    engine.apply(&patch.finish()).unwrap();
    let (_, settled) = engine.render_cpu_tiled(96, 96, c, [0.0; 4], options).unwrap();
    assert!(settled.exact && settled.tiles_drawn > 0, "{settled:?}");
}

#[test]
fn no_frame_is_exact_while_provisional_text_outside_it_may_paint_into_it() {
    // A provisional record's box is off the view's left edge; its text, once it arrives, paints
    // 24 units from the same origin, into the view. The frame before can't know that, so it
    // isn't exact; the frame after, with the text, is.
    let transform = [1.0, 0.0, 0.0, 1.0, -18.0, 0.0];
    let mut provisional = Rec::new(transform, [16.0, 16.0]);
    provisional.flags = 8;
    let mut engine = provisional_engine(&provisional);
    engine.use_cpu_tiles(64, 16);
    let c = camera(1.0, 0.0, 0.0);
    let options = TiledOptions {
        prefetch: false,
        ..TiledOptions::default()
    };
    let at = (8 * 64 + 3) * 4;
    let (before, stats) = engine.render_cpu_tiled(64, 64, c, [0.0; 4], options).unwrap();
    let before = before[at..at + 4].to_vec();
    assert!(!stats.exact, "exact before the text arrived: {stats:?}");

    let mut text = Rec::new(transform, [16.0, 16.0]);
    text.paths.push(Entry::Rect {
        w: 24.0,
        h: 16.0,
        radii: [0.0; 4],
    });
    text.ops.push(Op::Fill {
        path: 0,
        even_odd: false,
        paint: Paint::Solid([1.0, 0.0, 0.0, 1.0]),
    });
    let mut patch = W::new(1, 2);
    patch.b[6..8].copy_from_slice(&1u16.to_le_bytes());
    patch.set(1, 0, &text);
    engine.apply(&patch.finish()).unwrap();
    let (after, ready) = engine.render_cpu_tiled(64, 64, c, [0.0; 4], options).unwrap();
    assert!(ready.exact, "{ready:?}");
    assert_eq!(&after[at..at + 4], &[255, 0, 0, 255]);
    assert_ne!(before, after[at..at + 4]);
}

#[test]
fn hidden_provisional_text_leaves_frames_exact() {
    // Only shown records count: text in a hidden layer never paints until it's shown, and
    // showing it is a change of its own.
    let mut provisional = square();
    provisional.flags = 8 | 1;
    let mut engine = provisional_engine(&provisional);
    engine.use_cpu_tiles(64, 16);
    let (_, stats) = engine
        .render_cpu_tiled(64, 64, camera(1.0, 0.0, 0.0), [0.0; 4], TiledOptions::default())
        .unwrap();
    assert!(stats.exact, "{stats:?}");
}

#[test]
fn a_curved_stroke_zoomed_out_draws_what_it_does_at_its_device_size() {
    // Zoomed out, a stroke is drawn on the device (vello's own tolerance is finer there the
    // further out). The same stroke, made that small and drawn at 100%, is the reference: within
    // anti-aliasing, dashes included.
    let draw = |k: f32, zoom: f64, dashes: Vec<f32>| {
        let mut r = Rec::new(
            [1.0, 0.0, 0.0, 1.0, f64::from(40.0 * k), f64::from(30.0 * k)],
            [300.0 * k, 180.0 * k],
        );
        r.paths.push(Entry::Ellipse {
            w: 300.0 * k,
            h: 180.0 * k,
        });
        r.ops.push(Op::Stroke {
            path: 0,
            width: 12.0 * k,
            join: 1,
            cap: 1,
            dashes: dashes.iter().map(|d| d * k).collect(),
            offset: 0.0,
            paint: Paint::Solid([0.8, 0.1, 0.3, 1.0]),
        });
        let mut msg = W::new(ANY, 1);
        msg.reset();
        msg.set(1, 0, &r);
        let mut e = Engine::new(Limits::default());
        e.apply(&msg.finish()).unwrap();
        e.render_cpu(120, 90, camera(zoom, 3.3, 2.7), [1.0; 4], false)
            .unwrap()
            .0
            .to_vec()
    };
    for dashes in [vec![], vec![40.0, 25.0]] {
        let zoomed = draw(1.0, 0.25, dashes.clone());
        let small = draw(0.25, 1.0, dashes.clone());
        let worst = zoomed
            .iter()
            .zip(&small)
            .map(|(a, b)| a.abs_diff(*b))
            .max()
            .unwrap_or(0);
        let off = zoomed.iter().zip(&small).filter(|(a, b)| a.abs_diff(**b) > 8).count();
        assert!(zoomed.iter().any(|v| *v != 255), "drew nothing");
        // The ellipse's curves are made at its own size, so the two outlines differ in their last
        // fraction of a pixel at a few dozen pixels along the edge (as they did before this drew
        // on the device: the same numbers either way).
        assert!(
            worst <= 64 && off <= 240,
            "dashes {dashes:?}: worst {worst}, {off} channels off"
        );
    }
}

#[test]
fn a_see_through_run_covers_its_overlaps_once() {
    // One glyph, a disjoint one, then the first again in the same place, at half alpha. Figma
    // covers a text layer's overlaps once, as one shape (`text-overlap` in the parity suites):
    // the GPU laid the run's masks into one image and did; the CPU laid them one over another
    // (alpha 192 where 128 is right), and its exports with it.
    let square = vec![
        (0, vec![0.0, 0.0]),
        (1, vec![16.0, 0.0]),
        (1, vec![16.0, 16.0]),
        (1, vec![0.0, 16.0]),
        (4, vec![]),
    ];
    let mut r = Rec::new([1.0, 0.0, 0.0, 1.0, 8.0, 8.0], [64.0, 48.0]);
    r.paths.push(Entry::Glyphs {
        scale: 1.0,
        glyphs: vec![(1, 0.0, 24.0), (1, 32.0, 24.0), (1, 0.0, 24.0)],
    });
    r.ops.push(Op::Fill {
        path: 0,
        even_odd: false,
        paint: Paint::Solid([1.0, 0.0, 0.0, 0.5]),
    });
    let mut list = W::new(ANY, 1);
    list.reset();
    list.glyph(1, &square);
    list.set(1, 0, &r);
    let mut e = Engine::new(Limits::default());
    e.apply(&list.finish()).unwrap();
    let c = camera(1.0, 0.0, 0.0);
    let whole = e.render_cpu(96, 64, c, [0.0; 4], false).unwrap().0.to_vec();
    let at = (24 * 96 + 16) * 4;
    assert!(whole[at + 3].abs_diff(128) <= 1, "alpha {}", whole[at + 3]);
    // The run's image is the whole run's, so bands draw what the whole frame does, bit for bit.
    let mut banded = e.render_band(96, 64, c, [0.0; 4], 0, 20).unwrap().to_vec();
    banded.extend_from_slice(e.render_band(96, 64, c, [0.0; 4], 20, 44).unwrap());
    assert!(banded == whole, "bands differ from the whole frame");
}

#[test]
fn drop_shadow_halo_matches_across_tile_seam_and_invalidates_neighbor_tile() {
    // Shape lies wholly in the left tile (x = 4..28 on 48 px tiles), while its offset blurred
    // drop shadow reaches well into the right tile (x >= 48). Both initial tiled rendering and
    // moving the shape away must keep the right tile exact.
    let mut caster = Rec::new([1.0, 0.0, 0.0, 1.0, 4.0, 12.0], [24.0, 24.0]);
    caster.paths.push(Entry::Rect {
        w: 24.0,
        h: 24.0,
        radii: [4.0; 4],
    });
    caster.ops.push(Op::DropShadow {
        paths: vec![0],
        even_odd: false,
        dx: 24.0,
        dy: 0.0,
        blur: 18.0,
        color: [0.0, 0.0, 0.0, 0.85],
        blend: 0,
    });
    caster.ops.push(Op::Fill {
        path: 0,
        even_odd: false,
        paint: Paint::Solid([0.9, 0.2, 0.2, 1.0]),
    });

    let mut msg = W::new(ANY, 1);
    msg.reset();
    msg.set(1, 0, &caster);
    let mut e = Engine::new(Limits::default());
    e.use_cpu_tiles(48, 64);
    e.apply(&msg.finish()).unwrap();
    let cam = camera(1.0, 0.0, 0.0);
    let whole = e.render_cpu(96, 64, cam, [1.0; 4], false).unwrap().0.to_vec();
    let (tiled, stats) = e
        .render_cpu_tiled(96, 64, cam, [1.0; 4], TiledOptions::default())
        .unwrap();
    assert!(stats.exact);
    let worst = whole.iter().zip(tiled).map(|(a, b)| a.abs_diff(*b)).max().unwrap_or(0);
    assert!(worst <= 1, "drop shadow tile seam mismatch: worst {worst}");
    // Right tile actually contains shadow pixels (not pure white).
    let right_dark = tiled
        .as_chunks::<4>()
        .0
        .iter()
        .enumerate()
        .any(|(i, px)| (i as u32 % 96) >= 48 && px[0] < 245);
    assert!(right_dark, "drop shadow did not reach across the tile seam");

    // Moving the caster far left must invalidate the right tile so no stale shadow remains.
    let mut move_away = W::new(1, 2);
    move_away.transform(1, [1.0, 0.0, 0.0, 1.0, -200.0, 12.0]);
    e.apply(&move_away.finish()).unwrap();
    let whole_after = e.render_cpu(96, 64, cam, [1.0; 4], false).unwrap().0.to_vec();
    let (tiled_after, _) = e
        .render_cpu_tiled(96, 64, cam, [1.0; 4], TiledOptions::default())
        .unwrap();
    assert_eq!(tiled_after, whole_after, "stale shadow survived in neighboring tile");
}

#[test]
fn clipped_frame_keeps_clip_when_child_has_drop_shadow() {
    // Child box lies well inside the parent's clipped box, but its drop shadow extends outside:
    // clip elision must not drop the parent's clip.
    let mut parent = Rec::new([1.0, 0.0, 0.0, 1.0, 16.0, 16.0], [48.0, 48.0]);
    parent.paths.push(Entry::Rect {
        w: 48.0,
        h: 48.0,
        radii: [0.0; 4],
    });
    parent.ops.push(Op::Clip {
        path: 0,
        even_odd: false,
    });
    parent.ops.push(Op::Children);
    parent.ops.push(Op::Unclip);

    let mut child = Rec::new([1.0, 0.0, 0.0, 1.0, 12.0, 12.0], [20.0, 20.0]);
    child.paths.push(Entry::Rect {
        w: 20.0,
        h: 20.0,
        radii: [0.0; 4],
    });
    child.ops.push(Op::DropShadow {
        paths: vec![0],
        even_odd: false,
        dx: 24.0,
        dy: 0.0,
        blur: 10.0,
        color: [0.0, 0.0, 0.0, 1.0],
        blend: 0,
    });
    child.ops.push(Op::Fill {
        path: 0,
        even_odd: false,
        paint: Paint::Solid([0.2, 0.4, 0.9, 1.0]),
    });

    let mut msg = W::new(ANY, 1);
    msg.reset();
    msg.set(1, 0, &parent);
    msg.set(2, 1, &child);
    let mut e = Engine::new(Limits::default());
    e.apply(&msg.finish()).unwrap();
    let px = e
        .render_cpu(96, 80, camera(1.0, 0.0, 0.0), [1.0; 4], false)
        .unwrap()
        .0
        .to_vec();
    // Pixel (68, 38) is 4 px outside the parent's right edge (x = 64): must stay pure white.
    let at = (38 * 96 + 68) * 4;
    assert_eq!(&px[at..at + 4], &[255, 255, 255, 255], "shadow escaped parent clip");
}

#[test]
fn layer_blur_matches_across_48px_tile_seams_at_pyramid_sigma_and_invalidates_children() {
    // Pyramid-regime layer blur (radius = 36 -> sigma = 18 > DIRECT_SIGMA_MAX) straddling a
    // 48 px tile boundary (non-power-of-two!) under a fractional camera pan: phase-aligned
    // pyramid snapping must keep tiled rendering aligned with whole-frame rendering, and moving
    // a child inside the blurred parent must invalidate every tile its blur halo reaches and
    // refuse split-drag.
    let mut parent = Rec::new([1.0, 0.0, 0.0, 1.0, 0.0, 0.0], [120.0, 80.0]);
    parent.ops.push(Op::Children);
    parent.post.push(Post::LayerBlur(36.0));

    let mut child = Rec::new([1.0, 0.0, 0.0, 1.0, 16.0, 18.0], [26.0, 26.0]);
    child.paths.push(Entry::Rect {
        w: 26.0,
        h: 26.0,
        radii: [4.0; 4],
    });
    child.ops.push(Op::Fill {
        path: 0,
        even_odd: false,
        paint: Paint::Solid([0.1, 0.5, 0.95, 1.0]),
    });

    let mut msg = W::new(ANY, 1);
    msg.reset();
    msg.set(1, 0, &parent);
    msg.set(2, 1, &child);
    let mut e = Engine::new(Limits::default());
    e.use_cpu_tiles(48, 64);
    e.apply(&msg.finish()).unwrap();
    // Selection inside a blurred parent must not use the split-drag fast path.
    assert!(e.store.selection(&[2]).is_none());

    let cam = camera(1.0, 3.25, -2.5);
    let whole = e.render_cpu(96, 64, cam, [1.0; 4], false).unwrap().0.to_vec();
    let (tiled, stats) = e
        .render_cpu_tiled(96, 64, cam, [1.0; 4], TiledOptions::default())
        .unwrap();
    assert!(stats.exact);
    let worst = whole.iter().zip(tiled).map(|(a, b)| a.abs_diff(*b)).max().unwrap_or(0);
    assert!(worst <= 2, "pyramid layer blur tile seam mismatch: worst {worst}");

    // Move the child far off-screen: every tile touched by the blurred halo must update cleanly.
    let mut move_child = W::new(1, 2);
    move_child.transform(2, [1.0, 0.0, 0.0, 1.0, -300.0, 18.0]);
    e.apply(&move_child.finish()).unwrap();
    let whole_after = e.render_cpu(96, 64, cam, [1.0; 4], false).unwrap().0.to_vec();
    let (tiled_after, _) = e
        .render_cpu_tiled(96, 64, cam, [1.0; 4], TiledOptions::default())
        .unwrap();
    assert_eq!(tiled_after, whole_after, "stale blurred halo survived in neighbor tile");
}

#[test]
fn blended_layer_and_pass_through_group_match_across_tile_seams_and_refuse_split_drag() {
    // A backdrop spanning two 48 px tiles, covered by a faded pass-through container holding a
    // linear-dodge blended child straddling the tile seam. Tiled rendering must match whole-frame
    // rendering bit-for-bit, split-drag must be refused when blends are present, and moving the
    // child must invalidate both tiles cleanly.
    let mut bg = Rec::new([1.0, 0.0, 0.0, 1.0, 0.0, 0.0], [96.0, 64.0]);
    bg.paths.push(Entry::Rect {
        w: 96.0,
        h: 64.0,
        radii: [0.0; 4],
    });
    bg.ops.push(Op::Fill {
        path: 0,
        even_odd: false,
        paint: Paint::Solid([0.25, 0.45, 0.7, 1.0]),
    });

    let mut frame = Rec::new([1.0, 0.0, 0.0, 1.0, 0.0, 0.0], [96.0, 64.0]);
    frame.flags = 2; // isolate (fades as one, pass-through because child uses blend)
    frame.opacity = 0.7;
    frame.ops.push(Op::Children);

    let mut blended = Rec::new([1.0, 0.0, 0.0, 1.0, 28.0, 12.0], [40.0, 36.0]);
    blended.layer_blend = 16; // linear-dodge
    blended.paths.push(Entry::Rect {
        w: 40.0,
        h: 36.0,
        radii: [6.0; 4],
    });
    blended.ops.push(Op::Fill {
        path: 0,
        even_odd: false,
        paint: Paint::Solid([0.6, 0.4, 0.2, 0.9]),
    });

    let mut msg = W::new(ANY, 1);
    msg.reset();
    msg.set(1, 0, &bg);
    msg.set(2, 0, &frame);
    msg.set(3, 2, &blended);
    msg.order(0, &[1, 2]);
    let mut e = Engine::new(Limits::default());
    e.use_cpu_tiles(48, 64);
    e.apply(&msg.finish()).unwrap();
    // Pages with non-normal blends must not use SrcOver split-drag compositing.
    assert!(e.store.selection(&[1]).is_none());
    assert!(e.store.selection(&[2]).is_none());
    assert!(e.store.selection(&[3]).is_none());

    let cam = camera(1.0, 0.0, 0.0);
    let whole = e.render_cpu(96, 64, cam, [1.0; 4], false).unwrap().0.to_vec();
    let (tiled, stats) = e
        .render_cpu_tiled(96, 64, cam, [1.0; 4], TiledOptions::default())
        .unwrap();
    assert!(stats.exact);
    assert_eq!(tiled, whole, "blended pass-through tile seam mismatch");

    let mut move_blend = W::new(1, 2);
    move_blend.transform(3, [1.0, 0.0, 0.0, 1.0, 56.0, 12.0]);
    e.apply(&move_blend.finish()).unwrap();
    let whole_after = e.render_cpu(96, 64, cam, [1.0; 4], false).unwrap().0.to_vec();
    let (tiled_after, _) = e
        .render_cpu_tiled(96, 64, cam, [1.0; 4], TiledOptions::default())
        .unwrap();
    assert_eq!(tiled_after, whole_after, "stale blended pixels survived after move");
}

#[test]
fn blended_group_isolates_children_like_figma_and_svg() {
    // Regression for PR #242 review: a group/frame with a non-normal blend mode (such as multiply)
    // isolates its children and blends the flattened group once against the backdrop (matching
    // Figma's dodge-layer-frame golden and SVG mix-blend-mode), rather than inheriting the blend
    // mode onto each overlapping child.
    let mut bg = Rec::new([1.0, 0.0, 0.0, 1.0, 0.0, 0.0], [64.0, 64.0]);
    bg.paths.push(Entry::Rect {
        w: 64.0,
        h: 64.0,
        radii: [0.0; 4],
    });
    bg.ops.push(Op::Fill {
        path: 0,
        even_odd: false,
        paint: Paint::Solid([128.0 / 255.0, 128.0 / 255.0, 128.0 / 255.0, 1.0]),
    });

    let mut group = Rec::new([1.0, 0.0, 0.0, 1.0, 0.0, 0.0], [64.0, 64.0]);
    group.flags = 4; // FLAG_GROUP
    group.layer_blend = 1; // multiply
    group.ops.push(Op::Children);

    let mut child1 = Rec::new([1.0, 0.0, 0.0, 1.0, 4.0, 4.0], [40.0, 40.0]);
    child1.paths.push(Entry::Rect {
        w: 40.0,
        h: 40.0,
        radii: [0.0; 4],
    });
    child1.ops.push(Op::Fill {
        path: 0,
        even_odd: false,
        paint: Paint::Solid([128.0 / 255.0, 128.0 / 255.0, 128.0 / 255.0, 1.0]),
    });

    let mut child2 = Rec::new([1.0, 0.0, 0.0, 1.0, 16.0, 16.0], [40.0, 40.0]);
    child2.paths.push(Entry::Rect {
        w: 40.0,
        h: 40.0,
        radii: [0.0; 4],
    });
    child2.ops.push(Op::Fill {
        path: 0,
        even_odd: false,
        paint: Paint::Solid([128.0 / 255.0, 128.0 / 255.0, 128.0 / 255.0, 1.0]),
    });

    let mut msg = W::new(ANY, 1);
    msg.reset();
    msg.set(1, 0, &bg);
    msg.set(2, 0, &group);
    msg.set(3, 2, &child1);
    msg.set(4, 2, &child2);
    msg.order(0, &[1, 2]);
    let mut e = Engine::new(Limits::default());
    e.apply(&msg.finish()).unwrap();
    let (px, _) = e.render_cpu(64, 64, camera(1.0, 0.0, 0.0), [1.0; 4], false).unwrap();
    // Overlap region (24, 24): isolated multiply of 0.5 over 0.5 -> ~64, NOT double-multiplied 32.
    let i = (24 * 64 + 24) * 4;
    assert!(
        (i32::from(px[i]) - 64).abs() <= 1,
        "expected isolated multiply gray ~64 at overlap, got {:?}",
        &px[i..i + 4]
    );
}

#[test]
fn wire_minor_version_gates_newer_features() {
    // Regression for PR #242 / #244 review: messages declaring a lower minor version must be
    // refused when they carry flags, ops, path entries, or paint blends introduced in a higher minor.
    let mut blended = Rec::new([1.0, 0.0, 0.0, 1.0, 0.0, 0.0], [20.0, 20.0]);
    blended.layer_blend = 1;
    blended.paths.push(Entry::Rect {
        w: 20.0,
        h: 20.0,
        radii: [0.0; 4],
    });
    blended.ops.push(Op::Fill {
        path: 0,
        even_odd: false,
        paint: Paint::Solid([1.0, 0.0, 0.0, 1.0]),
    });
    let mut w = W::new(ANY, 1);
    w.reset();
    w.set(1, 0, &blended);
    let mut bytes = w.finish();
    bytes[6] = 3;
    bytes[7] = 0;
    let mut e = Engine::new(Limits::default());
    let err = e.apply(&bytes).unwrap_err();
    assert_eq!(err.code, drawpane_engine::error::ErrorCode::Version);

    // Normal 1.0 record is accepted under minor 3, while FLAG_PROVISIONAL (1.1) is refused under 1.0.
    let mut plain = Rec::new([1.0, 0.0, 0.0, 1.0, 0.0, 0.0], [20.0, 20.0]);
    plain.paths.push(Entry::Rect {
        w: 20.0,
        h: 20.0,
        radii: [0.0; 4],
    });
    plain.ops.push(Op::Fill {
        path: 0,
        even_odd: false,
        paint: Paint::Solid([1.0, 0.0, 0.0, 1.0]),
    });
    let mut w2 = W::new(ANY, 1);
    w2.reset();
    w2.set(1, 0, &plain);
    let mut b2 = w2.finish();
    b2[6] = 3;
    b2[7] = 0;
    assert!(e.apply(&b2).is_ok());

    let mut prov = Rec::new([1.0, 0.0, 0.0, 1.0, 0.0, 0.0], [20.0, 20.0]);
    prov.flags = 8; // FLAG_PROVISIONAL (wire 1.1)
    let mut w3 = W::new(ANY, 2);
    w3.reset();
    w3.set(1, 0, &prov);
    let mut b3 = w3.finish();
    b3[6] = 0;
    b3[7] = 0;
    let err3 = e.apply(&b3).unwrap_err();
    assert_eq!(err3.code, drawpane_engine::error::ErrorCode::Version);

    // Layer blur post-effect (FLAG_POST, wire 1.4) refused under minor 3.
    let mut blurred = Rec::new([1.0, 0.0, 0.0, 1.0, 0.0, 0.0], [20.0, 20.0]);
    blurred.post.push(Post::LayerBlur(8.0));
    let mut w4 = W::new(ANY, 3);
    w4.reset();
    w4.set(1, 0, &blurred);
    let mut b4 = w4.finish();
    b4[6] = 3;
    b4[7] = 0;
    let err4 = e.apply(&b4).unwrap_err();
    assert_eq!(err4.code, drawpane_engine::error::ErrorCode::Version);

    // Paint-level non-normal blend (wire 1.4) refused under minor 3.
    let mut paint_blend = Rec::new([1.0, 0.0, 0.0, 1.0, 0.0, 0.0], [20.0, 20.0]);
    paint_blend.blend = 16; // linear-dodge
    paint_blend.paths.push(Entry::Rect {
        w: 20.0,
        h: 20.0,
        radii: [0.0; 4],
    });
    paint_blend.ops.push(Op::Fill {
        path: 0,
        even_odd: false,
        paint: Paint::Solid([1.0, 0.0, 0.0, 1.0]),
    });
    let mut w5 = W::new(ANY, 4);
    w5.reset();
    w5.set(1, 0, &paint_blend);
    let mut b5 = w5.finish();
    b5[6] = 3;
    b5[7] = 0;
    let err5 = e.apply(&b5).unwrap_err();
    assert_eq!(err5.code, drawpane_engine::error::ErrorCode::Malformed);

    // Mask and endsMask flags (wire 1.4) refused under minor 3.
    let mut masked = Rec::new([1.0, 0.0, 0.0, 1.0, 0.0, 0.0], [20.0, 20.0]);
    masked.mask = 4;
    let mut w6 = W::new(ANY, 5);
    w6.reset();
    w6.set(1, 0, &masked);
    let mut b6 = w6.finish();
    b6[6] = 3;
    b6[7] = 0;
    assert_eq!(
        e.apply(&b6).unwrap_err().code,
        drawpane_engine::error::ErrorCode::Version
    );

    let mut ends = Rec::new([1.0, 0.0, 0.0, 1.0, 0.0, 0.0], [20.0, 20.0]);
    ends.flags = 256; // FLAG_ENDS_MASK
    let mut w7 = W::new(ANY, 6);
    w7.reset();
    w7.set(1, 0, &ends);
    let mut b7 = w7.finish();
    b7[6] = 3;
    b7[7] = 0;
    assert_eq!(
        e.apply(&b7).unwrap_err().code,
        drawpane_engine::error::ErrorCode::Version
    );
}

#[test]
fn picture_mask_matches_across_48px_tile_seams_invalidates_siblings_and_refuses_split_drag() {
    // An alpha picture mask with layer blur straddling a 48 px tile boundary, masking a solid
    // sibling above it. Tiled rendering must match whole-frame rendering across the seam,
    // split-drag must be refused inside the masked container, and moving the mask must invalidate
    // both the old and new tiles cleanly.
    let mut mask = Rec::new([1.0, 0.0, 0.0, 1.0, 26.0, 10.0], [44.0, 44.0]);
    mask.mask = 4; // alpha picture mask
    mask.post.push(Post::LayerBlur(10.0));
    mask.paths.push(Entry::Ellipse { w: 44.0, h: 44.0 });
    mask.ops.push(Op::Fill {
        path: 0,
        even_odd: false,
        paint: Paint::Solid([1.0, 1.0, 1.0, 0.85]),
    });

    let mut content = Rec::new([1.0, 0.0, 0.0, 1.0, 0.0, 0.0], [96.0, 64.0]);
    content.paths.push(Entry::Rect {
        w: 96.0,
        h: 64.0,
        radii: [0.0; 4],
    });
    content.ops.push(Op::Fill {
        path: 0,
        even_odd: false,
        paint: Paint::Solid([0.9, 0.25, 0.15, 1.0]),
    });

    let mut msg = W::new(ANY, 1);
    msg.reset();
    msg.set(1, 0, &mask);
    msg.set(2, 0, &content);
    msg.order(0, &[1, 2]);
    let mut e = Engine::new(Limits::default());
    e.use_cpu_tiles(48, 64);
    e.apply(&msg.finish()).unwrap();
    // Moving a mask or a masked sibling must not use the SrcOver split-drag fast path.
    assert!(e.store.selection(&[1]).is_none());
    assert!(e.store.selection(&[2]).is_none());

    let cam = camera(1.0, 0.0, 0.0);
    let whole = e.render_cpu(96, 64, cam, [1.0; 4], false).unwrap().0.to_vec();
    let (tiled, stats) = e
        .render_cpu_tiled(96, 64, cam, [1.0; 4], TiledOptions::default())
        .unwrap();
    assert!(stats.exact);
    let worst = whole.iter().zip(tiled).map(|(a, b)| a.abs_diff(*b)).max().unwrap_or(0);
    assert!(worst <= 1, "blurred picture mask tile seam mismatch: worst {worst}");

    // Move the mask completely into the right tile: left tile must clear back to white.
    let mut move_mask = W::new(1, 2);
    move_mask.transform(1, [1.0, 0.0, 0.0, 1.0, 68.0, 10.0]);
    e.apply(&move_mask.finish()).unwrap();
    let whole_after = e.render_cpu(96, 64, cam, [1.0; 4], false).unwrap().0.to_vec();
    let (tiled_after, _) = e
        .render_cpu_tiled(96, 64, cam, [1.0; 4], TiledOptions::default())
        .unwrap();
    let worst_after = whole_after
        .iter()
        .zip(tiled_after)
        .map(|(a, b)| a.abs_diff(*b))
        .max()
        .unwrap_or(0);
    assert!(
        worst_after <= 1,
        "stale masked pixels survived after moving mask: worst {worst_after}"
    );
}

#[test]
fn batch_updating_clipping_frames_stays_linear_with_and_without_masks() {
    // Regression for PR #244 review: batch-updating N clipping frames (FLAG_ENDS_MASK = 256) in
    // one container previously re-scanned all N siblings per Set, producing O(N^2) work and N^2
    // duplicate dirty entries. Verify both unmasked and masked containers stay strictly linear.
    let n = 1000u32;
    let mut init = W::new(ANY, 1);
    init.reset();
    for i in 1..=n {
        let mut r = Rec::new([1.0, 0.0, 0.0, 1.0, f64::from(i) * 2.0, 0.0], [10.0, 10.0]);
        r.flags = 256; // FLAG_ENDS_MASK (every clipping frame carries this)
        r.paths.push(Entry::Rect {
            w: 10.0,
            h: 10.0,
            radii: [0.0; 4],
        });
        r.ops.push(Op::Fill {
            path: 0,
            even_odd: false,
            paint: Paint::Solid([0.2, 0.4, 0.6, 1.0]),
        });
        init.set(i, 0, &r);
    }
    let mut store = drawpane_engine::store::Store::new(Limits::default());
    store.apply(&init.finish()).unwrap();

    // Update all N clipping frames in a single patch when ROOT has no masks.
    let mut patch = W::new(1, 2);
    for i in 1..=n {
        let mut r = Rec::new([1.0, 0.0, 0.0, 1.0, f64::from(i) * 2.0 + 1.0, 0.0], [10.0, 10.0]);
        r.flags = 256;
        r.paths.push(Entry::Rect {
            w: 10.0,
            h: 10.0,
            radii: [0.0; 4],
        });
        r.ops.push(Op::Fill {
            path: 0,
            even_odd: false,
            paint: Paint::Solid([0.3, 0.4, 0.6, 1.0]),
        });
        patch.set(i, 0, &r);
    }
    let applied = store.apply(&patch.finish()).unwrap();
    assert_eq!(applied.touched.len(), n as usize);
    assert!(
        applied.changes.len() <= (n as usize) * 2,
        "expected O(N) dirty changes for {n} clipping frames, got {}",
        applied.changes.len()
    );

    // Now add a mask child under ROOT and batch-update all N clipping frames: must STILL be O(N),
    // with each sibling recorded at most once in before and once in after.
    let mut add_mask = W::new(2, 3);
    let mut mask = Rec::new([1.0, 0.0, 0.0, 1.0, 0.0, 0.0], [50.0, 50.0]);
    mask.mask = 4;
    mask.paths.push(Entry::Rect {
        w: 50.0,
        h: 50.0,
        radii: [0.0; 4],
    });
    mask.ops.push(Op::Fill {
        path: 0,
        even_odd: false,
        paint: Paint::Solid([1.0; 4]),
    });
    add_mask.set(n + 1, 0, &mask);
    store.apply(&add_mask.finish()).unwrap();

    let mut patch_masked = W::new(3, 4);
    for i in 1..=n {
        let mut r = Rec::new([1.0, 0.0, 0.0, 1.0, f64::from(i) * 2.0 + 2.0, 0.0], [10.0, 10.0]);
        r.flags = 256;
        r.paths.push(Entry::Rect {
            w: 10.0,
            h: 10.0,
            radii: [0.0; 4],
        });
        r.ops.push(Op::Fill {
            path: 0,
            even_odd: false,
            paint: Paint::Solid([0.4, 0.4, 0.6, 1.0]),
        });
        patch_masked.set(i, 0, &r);
    }
    let applied_masked = store.apply(&patch_masked.finish()).unwrap();
    assert_eq!(applied_masked.touched.len(), (n + 1) as usize);
    assert!(
        applied_masked.changes.len() <= ((n + 1) as usize) * 2,
        "expected O(N) dirty changes in masked container, got {}",
        applied_masked.changes.len()
    );
}

#[test]
fn noise_and_texture_match_across_48px_tile_seams_and_invalidate_neighbor_tiles() {
    // Two layers straddling a 48 px tile boundary:
    // 1) A rectangle with duo noise and unclipped texture (radius 10 extends past its box into the
    //    adjacent tile).
    // 2) A rotated ellipse with clipped texture and multi noise (sampling halo still crosses the
    //    48 px tile boundary even though clip_to_shape keeps outward reach zero).
    let mut noisy = Rec::new([1.0, 0.0, 0.0, 1.0, 24.0, 8.0], [36.0, 32.0]);
    noisy.paths.push(Entry::Rect {
        w: 36.0,
        h: 32.0,
        radii: [6.0; 4],
    });
    noisy.ops.push(Op::Fill {
        path: 0,
        even_odd: false,
        paint: Paint::Solid([0.2, 0.5, 0.85, 1.0]),
    });
    noisy.post.push(Post::Noise {
        noise_type: 1,
        size: 1.5,
        density: 65.0,
        color: [0.05, 0.05, 0.05, 0.7],
        secondary_color: [1.0, 1.0, 1.0, 0.6],
        opacity: 0.8,
    });
    noisy.post.push(Post::Texture {
        size: 4.0,
        radius: 10.0,
        clip_to_shape: false,
    });

    let mut clipped = Rec::new([0.92, 0.39, -0.39, 0.92, 42.0, 26.0], [34.0, 24.0]);
    clipped.paths.push(Entry::Ellipse { w: 34.0, h: 24.0 });
    clipped.ops.push(Op::Fill {
        path: 0,
        even_odd: false,
        paint: Paint::Solid([0.9, 0.35, 0.2, 0.9]),
    });
    clipped.post.push(Post::Texture {
        size: 3.0,
        radius: 6.0,
        clip_to_shape: true,
    });
    clipped.post.push(Post::Noise {
        noise_type: 2,
        size: 2.0,
        density: 75.0,
        color: [0.0; 4],
        secondary_color: [1.0; 4],
        opacity: 0.75,
    });

    let mut msg = W::new(ANY, 1);
    msg.reset();
    msg.set(1, 0, &noisy);
    msg.set(2, 0, &clipped);
    msg.order(0, &[1, 2]);
    let mut e = Engine::new(Limits::default());
    e.use_cpu_tiles(48, 64);
    e.apply(&msg.finish()).unwrap();

    let cam = camera(1.0, 0.0, 0.0);
    let whole = e.render_cpu(96, 64, cam, [1.0; 4], false).unwrap().0.to_vec();
    let (tiled, stats) = e
        .render_cpu_tiled(96, 64, cam, [1.0; 4], TiledOptions::default())
        .unwrap();
    assert!(stats.exact);
    assert_eq!(tiled, whole, "noise/texture 48 px tile seam mismatch");

    // Move the unclipped texture layer so its radius-10 halo leaves the left tile completely.
    let mut move_noisy = W::new(1, 2);
    move_noisy.transform(1, [1.0, 0.0, 0.0, 1.0, 62.0, 8.0]);
    e.apply(&move_noisy.finish()).unwrap();
    let whole_after = e.render_cpu(96, 64, cam, [1.0; 4], false).unwrap().0.to_vec();
    let (tiled_after, _) = e
        .render_cpu_tiled(96, 64, cam, [1.0; 4], TiledOptions::default())
        .unwrap();
    assert_eq!(
        tiled_after, whole_after,
        "stale unclipped texture halo survived in left tile after move"
    );
}

#[test]
fn image_replacement_under_ancestor_texture_and_blur_invalidates_displaced_tiles() {
    // Regression for PR #245 review: replacing an image inside a frame carrying an unclipped
    // texture (or clipped texture / layer blur) must invalidate neighbor tiles reached through
    // the ancestor's displacement or blur pad (`Store::image_users` using `dirty_extent`).
    let mut frame = Rec::new([1.0, 0.0, 0.0, 1.0, 0.0, 0.0], [96.0, 48.0]);
    frame.ops.push(Op::Children);
    frame.post.push(Post::Texture {
        size: 36.0,
        radius: 36.0,
        clip_to_shape: false,
    });

    let mut img_child = Rec::new([1.0, 0.0, 0.0, 1.0, 22.0, 12.0], [14.0, 24.0]);
    img_child.paths.push(Entry::Rect {
        w: 14.0,
        h: 24.0,
        radii: [0.0; 4],
    });
    img_child.ops.push(Op::Fill {
        path: 0,
        even_odd: false,
        paint: Paint::Image {
            id: 1,
            m: [14.0, 0.0, 0.0, 24.0, 0.0, 0.0],
            tile: false,
            opacity: 1.0,
        },
    });

    let mut msg = W::new(ANY, 1);
    msg.reset();
    msg.set(1, 0, &frame);
    msg.set(2, 1, &img_child);
    msg.order(0, &[1]);

    let mut e = Engine::new(Limits::default());
    e.use_cpu_tiles(48, 64);
    let red: Vec<u8> = [230u8, 25, 25, 255].repeat(4 * 4);
    let green: Vec<u8> = [25u8, 210, 40, 255].repeat(4 * 4);
    e.put_image(1, 4, 4, &red, false).unwrap();
    e.apply(&msg.finish()).unwrap();

    let cam = camera(1.0, 0.0, 0.0);
    let whole_red = e.render_cpu(96, 48, cam, [1.0; 4], false).unwrap().0.to_vec();
    let (tiled_red, stats_red) = e
        .render_cpu_tiled(96, 48, cam, [1.0; 4], TiledOptions::default())
        .unwrap();
    assert!(stats_red.exact);
    assert_eq!(tiled_red, whole_red);

    // Replace image 1 in place from red to green: right tile (x >= 48) receives displaced pixels
    // from x = 22..36 via the ancestor's radius-36 texture and must not keep stale red pixels.
    e.put_image(1, 4, 4, &green, false).unwrap();
    let whole_green = e.render_cpu(96, 48, cam, [1.0; 4], false).unwrap().0.to_vec();
    let (tiled_green, stats_green) = e
        .render_cpu_tiled(96, 48, cam, [1.0; 4], TiledOptions::default())
        .unwrap();
    assert!(stats_green.exact);
    assert_eq!(
        tiled_green, whole_green,
        "stale red pixels survived in displaced neighbor tile after image replacement"
    );
    // Verify the right tile actually shows displaced green (proving the test exercises displacement).
    let right_tile_has_green = (0..48usize).any(|y| {
        (48..96usize).any(|x| {
            let i = (y * 96 + x) * 4;
            tiled_green[i + 1] > 180 && tiled_green[i] < 80
        })
    });
    assert!(right_tile_has_green, "expected displaced green pixels in right tile");
}

#[test]
fn texture_matches_bit_identically_across_bands_and_tiles_at_fractional_zooms() {
    // Regression for PR #245 review + CI fuzz failure: texture displacement must evaluate the
    // exact same float coordinates regardless of band/tile origin (`dst_origin`, `src_origin`).
    let mut striped = Rec::new([1.0, 0.0, 0.0, 1.0, 7.35, 5.65], [78.0, 76.0]);
    striped.paths.push(Entry::Rect {
        w: 78.0,
        h: 76.0,
        radii: [0.0; 4],
    });
    for i in 0..8u32 {
        striped.paths.push(Entry::Rect {
            w: 78.0,
            h: 4.5,
            radii: [0.0; 4],
        });
        striped.ops.push(Op::Fill {
            path: 0,
            even_odd: false,
            paint: Paint::Solid(if i % 2 == 0 {
                [0.9, 0.15, 0.15, 1.0]
            } else {
                [0.1, 0.35, 0.85, 1.0]
            }),
        });
    }
    striped.post.push(Post::Texture {
        size: 7.5,
        radius: 12.0,
        clip_to_shape: false,
    });

    let mut msg = W::new(ANY, 1);
    msg.reset();
    msg.set(1, 0, &striped);
    let mut e = Engine::new(Limits::default());
    e.apply(&msg.finish()).unwrap();

    for zoom in [0.75, 1.0, 1.25, 1.5, 2.0] {
        let cam = camera(zoom, 3.25, 1.75);
        let whole = e.render_cpu(96, 96, cam, [1.0; 4], false).unwrap().0.to_vec();
        // Partition into 48 x 12 bands/tiles using tile mode.
        e.use_cpu_tiles(48, 64);
        let (tiled, stats) = e
            .render_cpu_tiled(96, 96, cam, [1.0; 4], TiledOptions::default())
            .unwrap();
        assert!(stats.exact);
        assert_eq!(tiled, whole, "texture mismatch across 48 px tiles at zoom {zoom}");
    }

    // Direct `texture_cpu` coordinate-coded probe across shifted destination/source windows.
    let (w, h) = (96usize, 96usize);
    let mut src = vec![0u8; w * h * 4];
    for y in 0..h {
        for x in 0..w {
            let i = (y * w + x) * 4;
            src[i] = (x * 2) as u8;
            src[i + 1] = (y * 2) as u8;
            src[i + 2] = ((x + y) & 255) as u8;
            src[i + 3] = 255;
        }
    }
    let dev_to_layer = vello_common::kurbo::Affine::new([0.8, 0.0, 0.0, 0.8, -5.88, -4.52]);
    let mut full = vec![0u8; w * h * 4];
    drawpane_engine::texture::texture_cpu(
        &src,
        (w as u32, h as u32),
        (0, 0),
        &mut full,
        (w as u32, h as u32),
        (0, 0),
        7.5,
        15.0,
        false,
        dev_to_layer,
    );
    for by in (0..h).step_by(12) {
        for bx in (0..w).step_by(48) {
            let mut tile = vec![0u8; 48 * 12 * 4];
            drawpane_engine::texture::texture_cpu(
                &src,
                (w as u32, h as u32),
                (0, 0),
                &mut tile,
                (48, 12),
                (bx as i32, by as i32),
                7.5,
                15.0,
                false,
                dev_to_layer,
            );
            for y in 0..12 {
                let f_off = ((by + y) * w + bx) * 4;
                let t_off = y * 48 * 4;
                assert_eq!(
                    &tile[t_off..t_off + 48 * 4],
                    &full[f_off..f_off + 48 * 4],
                    "texture_cpu window ({bx},{by}) row {y} diverged from full frame"
                );
            }
        }
    }
}

#[test]
fn texture_rejects_out_of_range_wire_inputs_and_device_radius() {
    use drawpane_engine::error::ErrorCode;

    let mut r = Rec::new([1.0, 0.0, 0.0, 1.0, 0.0, 0.0], [32.0, 32.0]);
    r.paths.push(Entry::Rect {
        w: 32.0,
        h: 32.0,
        radii: [0.0; 4],
    });
    r.ops.push(Op::Fill {
        path: 0,
        even_odd: false,
        paint: Paint::Solid([0.8, 0.2, 0.2, 1.0]),
    });

    let mut e = Engine::new(Limits::default());
    for (size, radius) in [(1.0e-38, 6.0), (4.0, 1.0e20), (51.0, 6.0)] {
        r.post = vec![Post::Texture {
            size,
            radius,
            clip_to_shape: false,
        }];
        let mut message = W::new(ANY, 1);
        message.reset();
        message.set(1, 0, &r);
        assert_eq!(e.apply(&message.finish()).unwrap_err().code, ErrorCode::Limit);
    }

    // A valid wire radius still needs device-space validation after zoom is applied.
    r.post = vec![Post::Texture {
        size: 4.0,
        radius: 100.0,
        clip_to_shape: false,
    }];
    let mut message = W::new(ANY, 1);
    message.reset();
    message.set(1, 0, &r);
    e.apply(&message.finish()).unwrap();
    let err = e
        .render_cpu(64, 64, camera(100.0, 0.0, 0.0), [1.0; 4], false)
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Limit);
}

#[test]
fn ordered_post_stack_and_phase_3a_substack_match_across_tiles() {
    // Phase 3A composition substack (decision 0040's glass arrives in phase 3B): layer blur,
    // separable blend (multiply), linear blend (linear-dodge), alpha and luminance masks with
    // real backdrop content inside each mask scope, mono/duo/multi noise, and unclipped + clipped
    // texture composed inside a translucent faded frame straddling a 48 px tile seam.
    let mut bg = Rec::new([1.0, 0.0, 0.0, 1.0, 0.0, 0.0], [96.0, 64.0]);
    bg.paths.push(Entry::Rect {
        w: 96.0,
        h: 64.0,
        radii: [0.0; 4],
    });
    bg.ops.push(Op::Fill {
        path: 0,
        even_odd: false,
        paint: Paint::Solid([0.2, 0.35, 0.6, 1.0]),
    });

    let mut frame = Rec::new([1.0, 0.0, 0.0, 1.0, 4.0, 4.0], [88.0, 56.0]);
    frame.flags = 2; // isolate (fades as one over visible outer bg)
    frame.opacity = 0.85;
    frame.paths.push(Entry::Rect {
        w: 88.0,
        h: 56.0,
        radii: [8.0; 4],
    });
    frame.ops.push(Op::Fill {
        path: 0,
        even_odd: false,
        paint: Paint::Solid([0.92, 0.9, 0.84, 0.5]),
    });
    frame.ops.push(Op::Clip {
        path: 0,
        even_odd: false,
    });
    frame.ops.push(Op::Children);
    frame.ops.push(Op::Unclip);

    // Alpha picture mask with layer blur gating a backdrop card + multiply noisy textured card.
    let mut alpha_mask = Rec::new([1.0, 0.0, 0.0, 1.0, 8.0, 6.0], [44.0, 44.0]);
    alpha_mask.mask = 4;
    alpha_mask.paths.push(Entry::Ellipse { w: 44.0, h: 44.0 });
    alpha_mask.ops.push(Op::Fill {
        path: 0,
        even_odd: false,
        paint: Paint::Solid([1.0, 1.0, 1.0, 0.85]),
    });
    alpha_mask.post.push(Post::LayerBlur(6.0));

    let mut mask1_base = Rec::new([1.0, 0.0, 0.0, 1.0, 8.0, 6.0], [46.0, 44.0]);
    mask1_base.paths.push(Entry::Rect {
        w: 46.0,
        h: 44.0,
        radii: [4.0; 4],
    });
    mask1_base.ops.push(Op::Fill {
        path: 0,
        even_odd: false,
        paint: Paint::Solid([0.85, 0.78, 0.45, 1.0]),
    });
    mask1_base.post.push(Post::Noise {
        noise_type: 0, // mono
        size: 1.5,
        density: 65.0,
        color: [0.0, 0.0, 0.0, 0.55],
        secondary_color: [1.0; 4],
        opacity: 1.0,
    });

    let mut sep_blended = Rec::new([1.0, 0.0, 0.0, 1.0, 16.0, 10.0], [44.0, 36.0]);
    sep_blended.layer_blend = 1; // multiply over mask1_base inside mask scope
    sep_blended.paths.push(Entry::Rect {
        w: 44.0,
        h: 36.0,
        radii: [6.0; 4],
    });
    sep_blended.ops.push(Op::Fill {
        path: 0,
        even_odd: false,
        paint: Paint::Solid([0.9, 0.35, 0.25, 0.95]),
    });
    sep_blended.post.push(Post::Noise {
        noise_type: 1, // duo
        size: 1.5,
        density: 70.0,
        color: [0.0, 0.0, 0.0, 0.6],
        secondary_color: [1.0, 1.0, 1.0, 0.6],
        opacity: 1.0,
    });
    sep_blended.post.push(Post::Texture {
        size: 3.5,
        radius: 5.0,
        clip_to_shape: false,
    });

    // Luminance picture mask closing previous scope and gating a dark base + linear-dodge badge.
    let mut lum_mask = Rec::new([1.0, 0.0, 0.0, 1.0, 34.0, 8.0], [44.0, 40.0]);
    lum_mask.mask = 5;
    lum_mask.paths.push(Entry::Rect {
        w: 44.0,
        h: 40.0,
        radii: [8.0; 4],
    });
    lum_mask.ops.push(Op::Fill {
        path: 0,
        even_odd: false,
        paint: Paint::Gradient {
            kind: 2,
            m: [44.0, 0.0, 0.0, 40.0, 0.0, 0.0],
            stops: vec![(0.0, [1.0, 1.0, 1.0, 1.0]), (1.0, [0.15, 0.15, 0.15, 1.0])],
        },
    });

    let mut mask2_base = Rec::new([1.0, 0.0, 0.0, 1.0, 34.0, 8.0], [44.0, 40.0]);
    mask2_base.paths.push(Entry::Rect {
        w: 44.0,
        h: 40.0,
        radii: [6.0; 4],
    });
    mask2_base.ops.push(Op::Fill {
        path: 0,
        even_odd: false,
        paint: Paint::Solid([0.25, 0.25, 0.35, 1.0]),
    });

    let mut lin_blended = Rec::new([1.0, 0.0, 0.0, 1.0, 38.0, 12.0], [40.0, 32.0]);
    lin_blended.layer_blend = 16; // linear-dodge over mask2_base inside mask scope
    lin_blended.paths.push(Entry::Rect {
        w: 40.0,
        h: 32.0,
        radii: [4.0; 4],
    });
    lin_blended.ops.push(Op::Fill {
        path: 0,
        even_odd: false,
        paint: Paint::Solid([0.4, 0.65, 0.9, 0.9]),
    });
    lin_blended.post.push(Post::LayerBlur(4.0));
    lin_blended.post.push(Post::Noise {
        noise_type: 2, // multi
        size: 1.5,
        density: 70.0,
        color: [0.0; 4],
        secondary_color: [1.0; 4],
        opacity: 0.7,
    });
    lin_blended.post.push(Post::Texture {
        size: 3.0,
        radius: 4.0,
        clip_to_shape: true,
    });

    let mut msg = W::new(ANY, 1);
    msg.reset();
    msg.set(1, 0, &bg);
    msg.set(2, 0, &frame);
    msg.set(3, 2, &alpha_mask);
    msg.set(4, 2, &mask1_base);
    msg.set(5, 2, &sep_blended);
    msg.set(6, 2, &lum_mask);
    msg.set(7, 2, &mask2_base);
    msg.set(8, 2, &lin_blended);
    msg.order(0, &[1, 2]);
    msg.order(2, &[3, 4, 5, 6, 7, 8]);

    let mut e = Engine::new(Limits::default());
    e.use_cpu_tiles(48, 64);
    e.apply(&msg.finish()).unwrap();

    let cam = camera(1.0, 0.0, 0.0);
    let whole = e.render_cpu(96, 64, cam, [1.0; 4], false).unwrap().0.to_vec();
    let (tiled, stats) = e
        .render_cpu_tiled(96, 64, cam, [1.0; 4], TiledOptions::default())
        .unwrap();
    assert!(stats.exact);
    let worst = whole.iter().zip(tiled).map(|(a, b)| a.abs_diff(*b)).max().unwrap_or(0);
    assert!(worst <= 1, "phase-3A substack 48 px tile mismatch: worst {worst}");

    // Verify that the blends inside the mask scopes actually blend against their mask-scope
    // backdrops (switching both to normal must materially change pixels).
    sep_blended.layer_blend = 0;
    lin_blended.layer_blend = 0;
    let mut no_blend = W::new(1, 2);
    no_blend.set(5, 2, &sep_blended);
    no_blend.set(8, 2, &lin_blended);
    e.apply(&no_blend.finish()).unwrap();
    let normal_px = e.render_cpu(96, 64, cam, [1.0; 4], false).unwrap().0.to_vec();
    let diff_count = whole
        .as_chunks::<4>()
        .0
        .iter()
        .zip(normal_px.as_chunks::<4>().0.iter())
        .filter(|(a, b)| a.iter().zip(b.iter()).any(|(x, y)| x.abs_diff(*y) > 8))
        .count();
    assert!(
        diff_count > 100,
        "expected blends inside mask scopes to visibly change pixels, only {diff_count} differed"
    );
}

#[test]
fn provisional_text_in_reader_halo_converges_to_exact() {
    // A provisional text record sits just below tile (0, 0)'s core (y = 70, tile = 64) inside the
    // tile's reader halo (halo = 24 from a reader elsewhere on the page). When tile (0, 0) draws
    // at full detail while the text is provisional, its grown walk visits the provisional record
    // and stores `full = true, exact = false`. When the text later resolves, `Store::dirty` only
    // invalidates tiles touching y = 70 (not tile (0, 0)), so `invalidate_inexact_full` must mark
    // tile (0, 0) stale once no provisional records remain so the frame converges to `exact = true`.
    let mut reader = Rec::new([1.0, 0.0, 0.0, 1.0, 140.0, 0.0], [32.0, 32.0]);
    reader.ops.push(Op::Read { kernel: 1, halo: 24.0 });

    let mut text = Rec::new([1.0, 0.0, 0.0, 1.0, 8.0, 70.0], [48.0, 16.0]);
    text.flags = 8; // FLAG_PROVISIONAL
    text.paths.push(Entry::Rect {
        w: 48.0,
        h: 16.0,
        radii: [0.0; 4],
    });
    text.coarse.push(Op::Fill {
        path: 0,
        even_odd: false,
        paint: Paint::Solid([0.2, 0.2, 0.2, 1.0]),
    });
    text.ops.push(Op::Fill {
        path: 0,
        even_odd: false,
        paint: Paint::Solid([0.0, 0.0, 0.0, 1.0]),
    });

    let mut init = W::new(ANY, 1);
    init.reset();
    init.set(1, 0, &reader);
    init.set(2, 0, &text);
    let mut engine = Engine::new(Limits::default());
    engine.use_cpu_tiles(64, 32);
    engine.apply(&init.finish()).unwrap();

    let opts = TiledOptions {
        prefetch: false,
        ..TiledOptions::default()
    };
    let (_, s1) = engine
        .render_cpu_tiled(192, 128, camera(1.0, 0.0, 0.0), [1.0; 4], opts)
        .unwrap();
    assert!(!s1.exact, "frame with provisional record must not be exact");

    // Resolve the provisional record to its final non-provisional form.
    text.flags = 0;
    let mut patch = W::new(1, 2);
    patch.set(2, 0, &text);
    engine.apply(&patch.finish()).unwrap();

    let (_, s2) = engine
        .render_cpu_tiled(192, 128, camera(1.0, 0.0, 0.0), [1.0; 4], opts)
        .unwrap();
    assert!(
        s2.exact,
        "tile that saw provisional record only in its reader halo must converge to exact: {s2:?}"
    );
}
