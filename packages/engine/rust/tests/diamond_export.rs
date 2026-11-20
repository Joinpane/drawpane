//! Regression tests for diamond-gradient stroke export admission vs draw-time budgets (PR #235).
mod common;

use common::{ANY, Entry, Op, Paint, Rec, W};
use drawpane_engine::engine::{Camera, Engine};
use drawpane_engine::error::ErrorCode;
use drawpane_engine::limits::Limits;

fn make_diamond_stroke_engine(memory_bytes: usize, stroke_count: usize) -> Engine {
    let mut engine = Engine::new(Limits {
        memory_bytes,
        ..Limits::default()
    });
    let mut record = Rec::new([1.0, 0.0, 0.0, 1.0, 0.0, 112.0], [1024.0, 32.0]);
    record.paths.push(Entry::Rect {
        w: 1024.0,
        h: 32.0,
        radii: [0.0; 4],
    });
    for _ in 0..stroke_count {
        record.ops.push(Op::Stroke {
            path: 0,
            width: 64.0,
            join: 0,
            cap: 0,
            dashes: vec![],
            offset: 0.0,
            paint: Paint::Gradient {
                kind: 5,
                m: [512.0, 0.0, 0.0, 16.0, 512.0, 16.0],
                stops: vec![(0.0, [1.0, 0.0, 0.0, 0.5]), (1.0, [0.0, 0.0, 1.0, 0.5])],
            },
        });
    }
    let mut writer = W::new(ANY, 1);
    writer.reset();
    writer.set(1, 0, &record);
    engine.apply(&writer.finish()).unwrap();
    engine
}

#[test]
fn wide_diamond_strokes_over_budget_are_refused_at_admit_export() {
    let mut engine = make_diamond_stroke_engine(8 << 20, 10);
    let camera = Camera {
        zoom: 1.0,
        x: 0.0,
        y: 0.0,
        dpr: 1.0,
    };
    let err = engine
        .admit_export(1024, 256, camera)
        .expect_err("10 wide diamond strokes exceed 8 MiB and must be refused upfront");
    assert_eq!(err.code, ErrorCode::Limit);

    // Direct render_band without preflight must also enforce the budget (including band bytes).
    let band_err = engine
        .render_band(1024, 256, camera, [1.0; 4], 0, 256)
        .expect_err("render_band must enforce diamond + band memory budget");
    assert_eq!(band_err.code, ErrorCode::Limit);
}

#[test]
fn admitted_wide_diamond_stroke_export_renders_all_bands_without_limit() {
    let camera = Camera {
        zoom: 1.0,
        x: 0.0,
        y: 0.0,
        dpr: 1.0,
    };
    // 4 wide strokes in 8 MiB: if admitted, every band must succeed without hitting Limit.
    let mut small = make_diamond_stroke_engine(8 << 20, 4);
    small.admit_export(1024, 256, camera).expect("4 strokes fit in 8 MiB");
    let rows = small.band_rows(1024).min(256);
    let mut y = 0;
    while y < 256 {
        let take = rows.min(256 - y);
        small
            .render_band(1024, 256, camera, [1.0; 4], y, take)
            .expect("admitted export band must not fail with Limit");
        y += take;
    }

    // 10 wide strokes in 16 MiB across multi-band 1024 x 512 export.
    let mut multi = make_diamond_stroke_engine(16 << 20, 10);
    multi.admit_export(1024, 512, camera).expect("10 strokes fit in 16 MiB");
    let band_h = multi.band_rows(1024).min(512);
    let mut y0 = 0;
    while y0 < 512 {
        let take = band_h.min(512 - y0);
        multi
            .render_band(1024, 512, camera, [1.0; 4], y0, take)
            .expect("multi-band admitted diamond export must succeed");
        y0 += take;
    }
}

#[test]
fn render_band_accounts_for_active_band_buffer_in_diamond_budget() {
    // 1024 x 256 band = 1 MiB, tile = 1 MiB, 2 strokes = 2 MiB -> 4 MiB total.
    // Under a 3.5 MiB budget, band + tile + 2 strokes must fail even though tile + 2 strokes = 3 MiB.
    let mut engine = make_diamond_stroke_engine(3_500_000, 2);
    let camera = Camera {
        zoom: 1.0,
        x: 0.0,
        y: 0.0,
        dpr: 1.0,
    };
    let err = engine
        .render_band(1024, 256, camera, [1.0; 4], 0, 256)
        .expect_err("active band buffer must count against runtime diamond budget");
    assert_eq!(err.code, ErrorCode::Limit);
}
