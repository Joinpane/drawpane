//! The readers' regions `Store::dirty` keeps a revision (in page units) stay right through every
//! edit: after each one, an engine that has kept them gives exactly what a fresh engine, given
//! the same page whole, works out. The cache is warmed before each edit, so one left stale shows.
//!
//! `FUZZ_SEED` and `FUZZ_CASES` widen a run, as in `fuzz.rs`.

mod common;

use common::model::*;
use common::*;
use drawpane_engine::engine::Engine;
use drawpane_engine::limits::Limits;
use drawpane_engine::store::Dirty;
use vello_common::kurbo::{Affine, Rect};

fn seed() -> u64 {
    std::env::var("FUZZ_SEED")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(0x0d17_7cac)
}

fn cases(default: u32) -> u32 {
    std::env::var("FUZZ_CASES")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(default)
}

/// Changes all over the page, beneath every reader (stale: from before the structure changed).
fn changes(r: &mut Rng) -> Vec<Dirty> {
    (0..4)
        .map(|_| {
            let (x, y) = (f64::from(r.unit()) * 400.0 - 50.0, f64::from(r.unit()) * 300.0 - 50.0);
            let (w, h) = (f64::from(r.unit()) * 120.0 + 1.0, f64::from(r.unit()) * 90.0 + 1.0);
            Dirty {
                rect: Rect::new(x, y, x + w, y + h),
                order: 0,
                end: 0,
                stale: true,
            }
        })
        .collect()
}

/// Tile grids and camera views: scale and offset, never rotated.
const VIEWS: [[f64; 6]; 4] = [
    [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
    [0.25, 0.0, 0.0, 0.25, -12.5, 7.0],
    [3.0, 0.0, 0.0, 3.0, -900.0, -40.0],
    [0.0371, 0.0, 0.0, 0.0371, 3.25, 1.75],
];

fn dirty(e: &mut Engine, changes: &[Dirty], view: [f64; 6]) -> Vec<Rect> {
    e.store.dirty(changes, Affine::new(view), 1.5)
}

#[test]
fn kept_reader_regions_match_a_fresh_engine_after_every_edit() {
    let s = seed();
    for case in 0..cases(12) {
        let mut r = Rng(s.wrapping_add(u64::from(case)).wrapping_mul(0x9e37_79b9_7f4a_7c15) | 1);
        let mut model = Model::new(&mut r, 24, true);
        let mut kept = Engine::new(Limits::default());
        kept.apply(&model.fresh(1)).expect("fresh list");
        let mut revision = 1;
        for step in 0..20 {
            let probe = changes(&mut r);
            // Warm what's kept: a stale entry would answer the next calls.
            for view in VIEWS {
                dirty(&mut kept, &probe, view);
            }
            let patch = model.edit(&mut r, revision, revision + 1);
            if kept.apply(&patch).is_err() {
                // A refused edit changes nothing: the model went on, so start the case afresh.
                break;
            }
            revision += 1;
            let mut fresh = Engine::new(Limits::default());
            fresh.apply(&model.fresh(revision)).expect("fresh list");
            for view in VIEWS {
                let a = dirty(&mut kept, &probe, view);
                let b = dirty(&mut fresh, &probe, view);
                assert_eq!(
                    a.len(),
                    b.len(),
                    "case {case} step {step} view {view:?}: {a:?} vs {b:?}"
                );
                for (x, y) in a.iter().zip(&b) {
                    let close = (x.x0 - y.x0).abs() < 1e-6
                        && (x.y0 - y.y0).abs() < 1e-6
                        && (x.x1 - y.x1).abs() < 1e-6
                        && (x.y1 - y.y1).abs() < 1e-6;
                    assert!(close, "case {case} step {step} view {view:?}: {x:?} vs {y:?}");
                }
            }
        }
    }
}
