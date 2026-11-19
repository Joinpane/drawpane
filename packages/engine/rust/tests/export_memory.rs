//! An export's working set doesn't grow with the frame (decision 0040, "Memory, bounded"): a band
//! of an 8,192 px frame holds about what a band of a small one does, plus its own rows.
mod common;
use common::*;
use drawpane_engine::engine::{Camera, Engine};
use drawpane_engine::limits::Limits;
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};

struct Counting;
static LIVE: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        let n = LIVE.fetch_add(l.size(), Ordering::SeqCst) + l.size();
        PEAK.fetch_max(n, Ordering::SeqCst);
        unsafe { System.alloc(l) }
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        LIVE.fetch_sub(l.size(), Ordering::SeqCst);
        unsafe { System.dealloc(p, l) }
    }
}
#[global_allocator]
static A: Counting = Counting;

fn scene(e: &mut Engine) {
    let mut w = W::new(ANY, 1);
    w.reset();
    for i in 0..900u32 {
        let mut r = Rec::new(
            [1.0, 0.0, 0.0, 1.0, f64::from(i % 30) * 260.0, f64::from(i / 30) * 200.0],
            [240.0, 180.0],
        );
        r.paths.push(Entry::Rect {
            w: 240.0,
            h: 180.0,
            radii: [14.0; 4],
        });
        r.ops = vec![
            Op::Fill {
                path: 0,
                even_odd: false,
                paint: Paint::Solid([0.9, 0.9, 0.95, 1.0]),
            },
            Op::Stroke {
                path: 0,
                width: 1.0,
                join: 0,
                cap: 0,
                dashes: vec![],
                offset: 0.0,
                paint: Paint::Solid([0.5, 0.5, 0.5, 1.0]),
            },
        ];
        w.set(i + 1, 0, &r);
    }
    e.apply(&w.finish()).expect("scene");
}

fn band_peak(side: u32) -> usize {
    let mut e = Engine::new(Limits::default());
    scene(&mut e);
    let cam = Camera {
        zoom: f64::from(side) / 7800.0,
        x: 0.0,
        y: 0.0,
        dpr: 1.0,
    };
    // Warm: the first band allocates what every band reuses.
    e.render_band(side, side, cam, [1.0; 4], 0, 128).expect("band");
    let base = LIVE.load(Ordering::SeqCst);
    PEAK.store(base, Ordering::SeqCst);
    e.render_band(side, side, cam, [1.0; 4], side / 2, 128).expect("band");
    PEAK.load(Ordering::SeqCst) - base + base
}

#[test]
fn an_export_band_is_bounded() {
    let small = band_peak(1024);
    let large = band_peak(8192);
    let mib = |b: usize| b as f64 / 1048576.0;
    eprintln!(
        "peak heap with a band in flight: 1024 px frame {:.1} MiB, 8192 px frame {:.1} MiB",
        mib(small),
        mib(large)
    );
    // The band's own rows (8192 × 128 × 4 = 4 MiB) and its tiles are the difference allowed.
    assert!(
        large < small + 8 * 1024 * 1024,
        "{:.1} MiB against {:.1}",
        mib(large),
        mib(small)
    );
}

#[test]
fn patches_dont_leak() {
    let mut e = Engine::new(Limits::default());
    scene(&mut e);
    let cam = Camera {
        zoom: 0.2,
        x: 0.0,
        y: 0.0,
        dpr: 1.0,
    };
    e.render_cpu(800, 600, cam, [1.0; 4], true).expect("render");
    let settled = LIVE.load(Ordering::SeqCst);
    let mut revision = 1;
    for i in 0..400u32 {
        let mut w = W::new(revision, revision + 1);
        let id = 1 + (i * 7) % 900;
        if i % 2 == 0 {
            w.transform(id, [1.0, 0.0, 0.0, 1.0, f64::from(i % 50) * 3.0, 10.0]);
        } else {
            let mut r = Rec::new([1.0, 0.0, 0.0, 1.0, 20.0, 20.0], [100.0, 60.0]);
            r.paths.push(Entry::Rect {
                w: 100.0,
                h: 60.0,
                radii: [f32::from(u8::try_from(i % 9).unwrap_or(0)); 4],
            });
            r.ops = vec![Op::Fill {
                path: 0,
                even_odd: false,
                paint: Paint::Solid([0.3, 0.6, 0.9, 1.0]),
            }];
            w.set(id, 0, &r);
        }
        e.apply(&w.finish()).expect("patch");
        revision += 1;
        if i % 50 == 0 {
            e.render_cpu(800, 600, cam, [1.0; 4], true).expect("render");
        }
    }
    // The same scene afresh: what the graph holds goes back to what it held.
    scene(&mut e);
    e.render_cpu(800, 600, cam, [1.0; 4], true).expect("render");
    let after = LIVE.load(Ordering::SeqCst);
    let mib = |b: usize| b as f64 / 1048576.0;
    eprintln!(
        "live heap: {:.2} MiB settled, {:.2} MiB after 400 patches and a fresh list",
        mib(settled),
        mib(after)
    );
    assert!(
        after < settled + (1 << 20),
        "{:.2} MiB against {:.2}",
        mib(after),
        mib(settled)
    );
}
