//! A page moved against the tile grid by whole pixels draws the same pixels: curves flatten to the
//! same lines wherever a tile's origin falls (e2e `engine-tiles-gpu.spec.ts`, "blended glyph runs
//! keep zero tile-edge seam", on the CPU's tiles).

mod common;

use common::{ANY, Entry, Op, Paint, Rec, W};
use drawpane_engine::engine::{Camera, Engine, TiledOptions};
use drawpane_engine::limits::Limits;

/// The e2e scene: two backdrop stripes and a run of an outlined curved glyph (too tall for a
/// glyph mask) straddling page x = 512, everything moved right by `dx`.
fn scene(dx: f64, glyph_scale: f32, at: [f32; 2]) -> Vec<u8> {
    let mut w = W::new(ANY, 1);
    w.reset();
    let arch = |h: f32| {
        vec![
            (0u8, vec![2.0, 0.0]),
            (1, vec![22.0, 0.0]),
            (2, vec![24.0, h / 2.0, 18.0, h]),
            (1, vec![6.0, h]),
            (2, vec![0.0, h / 2.0, 2.0, 0.0]),
            (4, vec![]),
        ]
    };
    w.glyph(1, &arch(204.0));
    let mut id = 1;
    for (x, color) in [(384.0, [0.22, 0.48, 0.78, 1.0]), (512.0, [0.86, 0.54, 0.28, 1.0])] {
        let mut r = Rec::new([1.0, 0.0, 0.0, 1.0, x + dx, 32.0], [128.0, 280.0]);
        r.paths.push(Entry::Rect {
            w: 128.0,
            h: 280.0,
            radii: [0.0; 4],
        });
        r.ops.push(Op::Fill {
            path: 0,
            even_odd: false,
            paint: Paint::Solid(color),
        });
        w.set(id, 0, &r);
        id += 1;
    }
    let mut run = Rec::new([1.0, 0.0, 0.0, 1.0, dx, 0.0], [640.0, 312.0]);
    run.paths.push(Entry::Glyphs {
        scale: glyph_scale,
        glyphs: vec![(1, at[0], at[1])],
    });
    run.ops.push(Op::Fill {
        path: 0,
        even_odd: false,
        paint: Paint::Solid([0.35, 0.65, 0.45, 0.8]),
    });
    w.set(id, 0, &run);
    w.finish()
}

fn draw(list: &[u8], x: f64) -> Vec<u8> {
    let mut e = Engine::new(Limits::default());
    e.use_cpu_tiles(512, 64);
    e.apply(list).expect("list");
    let camera = Camera {
        zoom: 1.0,
        x,
        y: -32.0,
        dpr: 1.0,
    };
    let (px, stats) = e
        .render_cpu_tiled(256, 280, camera, [0.15, 0.25, 0.35, 1.0], TiledOptions::default())
        .expect("frame");
    assert!(stats.exact);
    px.to_vec()
}

#[test]
fn curves_flatten_alike_wherever_the_tile_grid_falls() {
    let mut worst = 0u8;
    let mut differing = 0usize;
    // The e2e glyph at its spot, then at fractional spots and scales (outlined, too tall for a
    // mask), so flattened vertices land where a 128 px shift crosses a power of two.
    let mut seed = 0x5eed_0382_u64;
    let mut unit = || {
        seed = seed
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        (seed >> 40) as f32 / (1u64 << 24) as f32
    };
    let mut spots = vec![
        (1.0f32, [560.3f32, 270.4f32]),
        (1.0, [500.3, 70.4]),
        (0.75, [530.17, 40.61]),
        (1.3, [470.9, 20.05]),
    ];
    for _ in 0..16 {
        spots.push((0.8 + unit() * 0.6, [440.0 + unit() * 120.0, 20.0 + unit() * 60.0]));
    }
    for (k, (scale, at)) in spots.into_iter().enumerate() {
        let a = draw(&scene(0.0, scale, at), -384.0);
        let b = draw(&scene(128.0, scale, at), -512.0);
        let n = a.iter().zip(&b).filter(|(x, y)| x != y).count();
        let d = a.iter().zip(&b).map(|(x, y)| x.abs_diff(*y)).max().unwrap_or(0);
        if n > 0 {
            eprintln!("case {k}: {n} bytes differ, by up to {d}");
        }
        differing += n;
        worst = worst.max(d);
    }
    assert_eq!(differing, 0, "bytes differ after a whole-pixel shift, by up to {worst}");
}
