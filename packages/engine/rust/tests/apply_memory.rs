//! Where a large list's memory goes (a diagnostic; run with ENGINE_LIST=<file>).
mod common;
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

#[test]
fn where_a_large_lists_memory_goes() {
    let Ok(path) = std::env::var("ENGINE_LIST") else { return };
    let bytes = std::fs::read(path).expect("list");
    let mib = |b: usize| b as f64 / 1048576.0;
    let base = LIVE.load(Ordering::SeqCst);
    let mut e = Engine::new(Limits {
        glyph_mask_bytes: 4 << 20,
        ..Limits::default()
    });
    PEAK.store(LIVE.load(Ordering::SeqCst), Ordering::SeqCst);
    e.apply(&bytes).expect("apply");
    eprintln!(
        "apply: peak {:.1} MiB, retained {:.1} MiB ({} records)",
        mib(PEAK.load(Ordering::SeqCst) - base),
        mib(LIVE.load(Ordering::SeqCst) - base),
        e.store.len()
    );
    let cam = Camera {
        zoom: 8192.0 / 7800.0,
        x: 0.0,
        y: 0.0,
        dpr: 1.0,
    };
    let before = LIVE.load(Ordering::SeqCst);
    PEAK.store(before, Ordering::SeqCst);
    for y in (0..1024).step_by(128) {
        e.render_band(8192, 8192, cam, [1.0; 4], y, 128).expect("band");
    }
    eprintln!(
        "bands: peak {:.1} MiB over the list, retained {:.1} MiB",
        mib(PEAK.load(Ordering::SeqCst) - before),
        mib(LIVE.load(Ordering::SeqCst) - before)
    );
}
