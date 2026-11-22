//! Kept stroke outlines stay within `Limits::stroke_bytes`: past it, a frame drops the least
//! recently drawn (never one drawn in this frame or the last), and a dropped outline is expanded
//! again, identically, when next drawn.

mod common;

use common::{ANY, Entry, Op, Paint, Rec, W};
use drawpane_engine::limits::Limits;
use drawpane_engine::record::Op as RecordOp;
use drawpane_engine::store::{ROOT, Store};
use drawpane_engine::stroke::resolve_stroke_outline;

const N: u32 = 200;

fn page(limits: Limits) -> Store {
    let mut w = W::new(ANY, 1);
    w.reset();
    let mut ids = Vec::new();
    for k in 0..N {
        let id = k + 1;
        ids.push(id);
        let mut rec = Rec::new(
            [1.0, 0.0, 0.0, 1.0, f64::from(k % 20) * 50.0, f64::from(k / 20) * 50.0],
            [40.0, 30.0],
        );
        rec.paths = vec![Entry::Ellipse {
            w: 40.0,
            h: 12.0 + (k % 7) as f32,
        }];
        rec.ops = vec![Op::Stroke {
            path: 0,
            width: 2.0,
            join: 1,
            cap: 1,
            dashes: vec![],
            offset: 0.0,
            paint: Paint::Solid([0.0, 0.0, 0.0, 1.0]),
        }];
        w.set(id, ROOT, &rec);
    }
    w.order(ROOT, &ids);
    let mut store = Store::new(limits);
    store.apply(&w.finish()).unwrap();
    store
}

/// Draws record `id`'s stroke at `scale`, as a frame would, and returns its outline's verbs.
fn draw(store: &Store, id: u32, scale: f64) -> usize {
    let r = &store.nodes[&id].record;
    let RecordOp::Stroke { path, style, cache, .. } = &r.ops[0] else {
        panic!("record {id} has no stroke");
    };
    let out = resolve_stroke_outline(
        r,
        *path,
        style,
        cache,
        &store.glyphs,
        &store.limits,
        scale,
        &store.strokes,
    )
    .unwrap()
    .unwrap();
    out.path.len()
}

#[test]
fn kept_outlines_stay_within_the_budget_least_recently_drawn_first() {
    // Measure what one frame of every outline holds, then budget for about a third of it.
    let roomy = page(Limits::default());
    roomy.begin_stroke_frame();
    for id in 1..=N {
        draw(&roomy, id, 1.0);
    }
    let all = roomy.stroke_cache_stats().cached_bytes as usize;
    assert!(all > 0);

    let cap = all / 3;
    let store = page(Limits {
        stroke_bytes: cap,
        ..Limits::default()
    });
    let verbs: Vec<usize> = (1..=N)
        .map(|id| {
            store.begin_stroke_frame();
            draw(&store, id, 1.0)
        })
        .collect();
    // Two more frames drawing only the last ten: everything else is now old.
    for _ in 0..2 {
        store.begin_stroke_frame();
        for id in N - 9..=N {
            draw(&store, id, 1.0);
        }
    }
    store.begin_stroke_frame();
    let kept = store.stroke_cache_stats();
    assert!(
        (kept.cached_bytes as usize) <= cap,
        "kept {} bytes against a {cap} byte budget",
        kept.cached_bytes
    );
    for id in N - 9..=N {
        let r = &store.nodes[&id].record;
        let RecordOp::Stroke { cache, .. } = &r.ops[0] else {
            unreachable!()
        };
        assert!(cache.is_cached(), "record {id} was drawn last frame and must be kept");
    }
    let RecordOp::Stroke { cache, .. } = &store.nodes[&1].record.ops[0] else {
        unreachable!()
    };
    assert!(!cache.is_cached(), "the least recently drawn outline goes first");
    // A dropped outline comes back the same when drawn again.
    store.begin_stroke_frame();
    assert_eq!(draw(&store, 1, 1.0), verbs[0]);
}

#[test]
fn a_budget_that_fits_drops_nothing() {
    let store = page(Limits::default());
    store.begin_stroke_frame();
    for id in 1..=N {
        draw(&store, id, 1.0);
    }
    let before = store.stroke_cache_stats();
    for _ in 0..4 {
        store.begin_stroke_frame();
    }
    let after = store.stroke_cache_stats();
    assert_eq!(before.ops_cached, N);
    assert_eq!(after.ops_cached, N);
    assert_eq!(before.cached_bytes, after.cached_bytes);
}
