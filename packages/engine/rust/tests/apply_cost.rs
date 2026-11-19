//! A transform patch costs what it touches, not the graph's size.
mod common;
use common::*;
use drawpane_engine::engine::Engine;
use drawpane_engine::limits::Limits;

#[test]
fn a_transform_patch_is_cheap_at_scale() {
    let mut e = Engine::new(Limits::default());
    let mut w = W::new(ANY, 1);
    w.reset();
    let mut id = 1;
    for b in 0..30u32 {
        let board = id;
        id += 1;
        let mut r = Rec::new([1.0, 0.0, 0.0, 1.0, f64::from(b) * 300.0, 0.0], [280.0, 2000.0]);
        r.paths.push(Entry::Rect {
            w: 280.0,
            h: 2000.0,
            radii: [0.0; 4],
        });
        r.ops = vec![
            Op::Fill {
                path: 0,
                even_odd: false,
                paint: Paint::Solid([1.0; 4]),
            },
            Op::Children,
        ];
        w.set(board, 0, &r);
        for k in 0..300u32 {
            let mut c = Rec::new([1.0, 0.0, 0.0, 1.0, 10.0, f64::from(k) * 6.0], [100.0, 5.0]);
            c.paths.push(Entry::Rect {
                w: 100.0,
                h: 5.0,
                radii: [1.0; 4],
            });
            c.ops = vec![Op::Fill {
                path: 0,
                even_odd: false,
                paint: Paint::Solid([0.2, 0.3, 0.4, 1.0]),
            }];
            w.set(id, board, &c);
            id += 1;
        }
    }
    e.apply(&w.finish()).expect("fresh");
    let mut times = Vec::new();
    for i in 0..6u32 {
        let mut p = W::new(1 + i, 2 + i);
        p.transform(1, [1.0, 0.0, 0.0, 1.0, f64::from(i) * 5.0, 0.0]);
        let t = std::time::Instant::now();
        e.apply(&p.finish()).expect("patch");
        times.push(t.elapsed().as_secs_f64() * 1000.0);
    }
    eprintln!("transform patch ms: {times:?}");
    assert!(times[1..].iter().all(|t| *t < 2.0), "{times:?}");
}
