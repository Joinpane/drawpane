//! Unit tests for deterministic glass mask atlas planning and fallback semantics.

mod common;

use common::{ANY, Entry, Op, Rec, W};
use drawpane_engine::exec::{Frame, IRect};
use drawpane_engine::glass::{GLASS_MASK_ATLAS_MAX_BYTES, KIND_BOX, glass_mask_atlas_bytes, plan_glass_masks};
use drawpane_engine::limits::Limits;
use drawpane_engine::record::{FLAG_CONTEXT, FLAG_HIDDEN, FLAG_PROVISIONAL};
use drawpane_engine::store::{ROOT, Store};
use vello_common::kurbo::Affine;

fn glass_rec(x: f64, y: f64, w: f32, h: f32, flags: u32, opacity: f32, refraction: f32) -> Rec {
    let inradius = (w.min(h) * 0.5).max(1.0);
    let mut rec = Rec::new([1.0, 0.0, 0.0, 1.0, x, y], [w, h]);
    rec.flags = flags;
    rec.opacity = opacity;
    rec.paths = vec![Entry::Rect { w, h, radii: [8.0; 4] }];
    rec.ops = vec![Op::Glass {
        paths: vec![0],
        even_odd: false,
        kind: u32::from(KIND_BOX),
        inradius,
        angle: -45.0,
        intensity: 80.0,
        refraction,
        depth: 12.0,
        dispersion: 30.0,
        frost: 4.0,
        splay: 0.0,
        box_radii: [8.0; 4],
        box_smoothing: [0.0; 4],
    }];
    rec
}

fn group_rec(flags: u32, opacity: f32) -> Rec {
    let mut rec = Rec::group();
    rec.flags |= flags;
    rec.opacity = opacity;
    rec
}

fn frame_of(w: u16, h: u16) -> Frame {
    Frame {
        width: w,
        height: h,
        view: Affine::IDENTITY,
        detail: false,
        area: IRect {
            x0: 0,
            y0: 0,
            x1: i32::from(w),
            y1: i32::from(h),
        },
    }
}

#[test]
fn atlas_plan_packs_canonical_paint_order_across_reader_reordering() {
    let frame = frame_of(800, 600);

    let mut patched = Store::new(Limits::default());
    let mut w = W::new(ANY, 1);
    w.reset();
    w.set(10, ROOT, &glass_rec(40.0, 40.0, 80.0, 60.0, 0, 1.0, 60.0));
    w.set(20, ROOT, &glass_rec(180.0, 40.0, 100.0, 70.0, 0, 1.0, 60.0));
    w.set(30, ROOT, &glass_rec(340.0, 40.0, 90.0, 50.0, 0, 1.0, 60.0));
    w.order(ROOT, &[10, 20, 30]);
    patched.apply(&w.finish()).unwrap();

    // Edit lens 10: Store::apply removes 10 from store.readers() and appends it at the end.
    let mut edit = W::new(1, 2);
    edit.set(10, ROOT, &glass_rec(40.0, 40.0, 80.0, 60.0, 0, 1.0, 75.0));
    patched.apply(&edit.finish()).unwrap();
    assert_eq!(
        patched.readers(),
        &[20, 30, 10],
        "editing a glass record must reorder store.readers()"
    );

    // A fresh revision retains the original reader index order.
    let mut fresh = Store::new(Limits::default());
    let mut fw = W::new(ANY, 2);
    fw.reset();
    fw.set(10, ROOT, &glass_rec(40.0, 40.0, 80.0, 60.0, 0, 1.0, 75.0));
    fw.set(20, ROOT, &glass_rec(180.0, 40.0, 100.0, 70.0, 0, 1.0, 60.0));
    fw.set(30, ROOT, &glass_rec(340.0, 40.0, 90.0, 50.0, 0, 1.0, 60.0));
    fw.order(ROOT, &[10, 20, 30]);
    fresh.apply(&fw.finish()).unwrap();
    assert_eq!(fresh.readers(), &[10, 20, 30]);

    let p_plan = plan_glass_masks(&patched, &frame, 4096, GLASS_MASK_ATLAS_MAX_BYTES);
    let f_plan = plan_glass_masks(&fresh, &frame, 4096, GLASS_MASK_ATLAS_MAX_BYTES);

    assert_eq!(p_plan.placements.len(), 3);
    assert_eq!(p_plan.size, f_plan.size);
    let p_slots: Vec<_> = p_plan.placements.iter().map(|p| (p.key, p.slot)).collect();
    let f_slots: Vec<_> = f_plan.placements.iter().map(|p| (p.key, p.slot)).collect();
    assert_eq!(
        p_slots, f_slots,
        "patched and fresh stores must produce the exact same atlas layout"
    );
    assert_eq!(
        p_plan.placements.iter().map(|p| p.key.0).collect::<Vec<_>>(),
        vec![10, 20, 30],
        "atlas slots must pack in canonical paint order, not store.readers() order"
    );
    for p in &p_plan.placements {
        assert_eq!(p.slot.offset.0 % 4, 0, "slot x must be tile-aligned (multiple of 4)");
        assert_eq!(p.slot.offset.1 % 4, 0, "slot y must be tile-aligned (multiple of 4)");
    }
}

#[test]
fn atlas_plan_visits_children_between_parent_glass_ops() {
    let frame = frame_of(800, 600);
    let mut store = Store::new(Limits::default());
    let mut parent = glass_rec(40.0, 40.0, 80.0, 60.0, 0, 1.0, 60.0);
    let second_lens = glass_rec(40.0, 40.0, 80.0, 60.0, 0, 1.0, 20.0);
    parent.ops.push(Op::Children);
    parent.ops.extend(second_lens.ops);

    let mut writer = W::new(ANY, 1);
    writer.reset();
    writer.set(1, ROOT, &parent);
    writer.set(2, 1, &glass_rec(20.0, 20.0, 50.0, 40.0, 0, 1.0, 45.0));
    store.apply(&writer.finish()).unwrap();

    let plan = plan_glass_masks(&store, &frame, 4096, GLASS_MASK_ATLAS_MAX_BYTES);
    let keys: Vec<_> = plan.placements.iter().map(|p| p.key).collect();
    assert_eq!(keys, [(1, 0), (2, 0), (1, 2)]);
}

#[test]
fn atlas_plan_fallbacks_oversize_overflow_budget_and_culling() {
    let big_frame = frame_of(1600, 1600);
    let mut store = Store::new(Limits::default());
    let mut w = W::new(ANY, 1);
    w.reset();
    // Oversize lens (> 1024 px) alongside two eligible lenses.
    w.set(1, ROOT, &glass_rec(40.0, 40.0, 1100.0, 80.0, 0, 1.0, 60.0));
    w.set(2, ROOT, &glass_rec(40.0, 200.0, 80.0, 60.0, 0, 1.0, 60.0));
    w.set(3, ROOT, &glass_rec(200.0, 200.0, 90.0, 70.0, 0, 1.0, 60.0));
    // Culled cases: hidden ancestor, context ancestor, zero-opacity ancestor, provisional, off-screen.
    w.set(100, ROOT, &group_rec(FLAG_HIDDEN, 1.0));
    w.set(4, 100, &glass_rec(340.0, 200.0, 80.0, 60.0, 0, 1.0, 60.0));
    w.set(101, ROOT, &group_rec(FLAG_CONTEXT, 1.0));
    w.set(5, 101, &glass_rec(460.0, 200.0, 80.0, 60.0, 0, 1.0, 60.0));
    w.set(102, ROOT, &group_rec(0, 0.0));
    w.set(8, 102, &glass_rec(460.0, 320.0, 80.0, 60.0, 0, 1.0, 60.0));
    w.set(
        6,
        ROOT,
        &glass_rec(580.0, 200.0, 80.0, 60.0, FLAG_PROVISIONAL, 1.0, 60.0),
    );
    w.set(7, ROOT, &glass_rec(3000.0, 3000.0, 80.0, 60.0, 0, 1.0, 60.0));
    w.order(ROOT, &[1, 2, 3, 100, 101, 102, 6, 7]);
    w.order(100, &[4]);
    w.order(101, &[5]);
    w.order(102, &[8]);
    store.apply(&w.finish()).unwrap();

    let plan = plan_glass_masks(&store, &big_frame, 4096, GLASS_MASK_ATLAS_MAX_BYTES);
    assert_eq!(plan.placements.len(), 2);
    assert!(
        !plan.slots.contains_key(&(1, 0)),
        "oversize lens must fall back to serial drawing"
    );
    assert!(plan.slots.contains_key(&(2, 0)));
    assert!(plan.slots.contains_key(&(3, 0)));
    for skipped in [4u32, 5, 6, 7, 8] {
        assert!(
            !plan.slots.contains_key(&(skipped, 0)),
            "hidden/context/zero-opacity/provisional/off-screen lens {skipped} must be culled"
        );
    }

    // Budget refusal applies to the whole frame.
    let required = glass_mask_atlas_bytes(plan.size.0, plan.size.1);
    let refused = plan_glass_masks(&store, &big_frame, 4096, required.saturating_sub(1));
    assert!(
        refused.placements.is_empty() && refused.slots.is_empty(),
        "budget refusal must disable the atlas for the whole frame"
    );

    // Shelf overflow: 4 large lenses fit in 1024x1024; the 5th falls back to serial.
    let mut shelf_store = Store::new(Limits::default());
    let mut sw = W::new(ANY, 1);
    sw.reset();
    let mut kids = Vec::new();
    for i in 1..=5u32 {
        sw.set(
            i,
            ROOT,
            &glass_rec(60.0 + f64::from(i - 1) * 100.0, 60.0, 420.0, 420.0, 0, 1.0, 60.0),
        );
        kids.push(i);
    }
    sw.order(ROOT, &kids);
    shelf_store.apply(&sw.finish()).unwrap();

    let shelf_plan = plan_glass_masks(&shelf_store, &big_frame, 4096, GLASS_MASK_ATLAS_MAX_BYTES);
    assert_eq!(shelf_plan.placements.len(), 4, "first 4 large lenses fit in 1024x1024");
    assert!(
        !shelf_plan.slots.contains_key(&(5, 0)),
        "5th lens overflowing the 1024x1024 atlas must fall back to serial"
    );
}
