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

#[test]
fn a_sliced_open_patch_with_readers_does_not_rebuild_order_per_command() {
    let mut e = Engine::new(Limits::default());
    let mut w = W::new(ANY, 1);
    w.reset();
    let mut id = 1u32;
    let mut frames = Vec::new();
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
        for k in 0..200u32 {
            let mut c = Rec::new([1.0, 0.0, 0.0, 1.0, 10.0, f64::from(k) * 8.0], [100.0, 6.0]);
            c.paths.push(Entry::Rect {
                w: 100.0,
                h: 6.0,
                radii: [1.0; 4],
            });
            c.ops = if k == 0 {
                vec![
                    Op::Fill {
                        path: 0,
                        even_odd: false,
                        paint: Paint::Solid([0.2, 0.3, 0.4, 1.0]),
                    },
                    Op::BackgroundBlur {
                        paths: vec![0],
                        even_odd: false,
                        radius: 8.0,
                    },
                    Op::Children,
                ]
            } else {
                vec![
                    Op::Fill {
                        path: 0,
                        even_odd: false,
                        paint: Paint::Solid([0.2, 0.3, 0.4, 1.0]),
                    },
                    Op::Children,
                ]
            };
            w.set(id, board, &c);
            if k < 10 {
                frames.push(id);
            }
            id += 1;
        }
    }
    e.apply(&w.finish()).expect("fresh");
    // Incremental sliced-open patch inserting 200 new children under distinct parents with readers present.
    let mut p = W::new(1, 2);
    for &parent in frames.iter().take(200) {
        let mut leaf = Rec::new([1.0, 0.0, 0.0, 1.0, 2.0, 1.0], [20.0, 4.0]);
        leaf.paths.push(Entry::Rect {
            w: 20.0,
            h: 4.0,
            radii: [0.0; 4],
        });
        leaf.ops = vec![Op::Fill {
            path: 0,
            even_odd: false,
            paint: Paint::Solid([0.8, 0.2, 0.1, 1.0]),
        }];
        p.set(id, parent, &leaf);
        id += 1;
    }
    let bytes = p.finish();
    let t = std::time::Instant::now();
    e.apply(&bytes).expect("slice patch");
    let ms = t.elapsed().as_secs_f64() * 1000.0;
    eprintln!("sliced-open patch (200 parents, 6k nodes + readers): {ms:.2} ms");
    assert!(
        ms < 40.0,
        "sliced-open patch took {ms:.2} ms (O(K*N) order rebuild regression)"
    );
}
