//! Property and fuzz tests for the render graph (review items 1 and 6):
//!
//! - random scenes and random sequences of patches (insert, remove, reorder, move to another
//!   parent, change a record, transform only) never crash, and after every patch the patched
//!   engine's picture equals a fresh engine's, given the whole list, pixel for pixel;
//! - every pixel a patch changes lies inside the dirty region the patch reported, including
//!   pixels a backdrop reader changes because something beneath it moved (transitively);
//! - a message that fails changes nothing (transactions), and stale revisions are refused;
//! - random and mutated bytes never panic.
//!
//! `FUZZ_SEED` and `FUZZ_CASES` widen a run (`pnpm --filter @drawpane/engine fuzz`).

mod common;

use common::*;
use drawpane_engine::engine::{Camera, Engine};
use drawpane_engine::error::ErrorCode;
use drawpane_engine::limits::Limits;
use std::collections::{BTreeMap, HashMap};

const W_PX: u32 = 160;
const H_PX: u32 = 120;

struct Model {
    nodes: BTreeMap<u32, (u32, Rec)>,
    children: HashMap<u32, Vec<u32>>,
    next: u32,
    readers: bool,
}

fn ident() -> [f64; 6] {
    [1.0, 0.0, 0.0, 1.0, 0.0, 0.0]
}

fn gen_paint(r: &mut Rng, w: f32, h: f32) -> Paint {
    match r.below(10) {
        0 | 1 => Paint::Gradient {
            kind: 2 + r.below(3),
            m: [
                f64::from(w * r.range(0.3, 1.0)),
                f64::from(h * r.range(-0.3, 0.3)),
                f64::from(-h * r.range(-0.3, 0.3)),
                f64::from(h * r.range(0.3, 1.0)),
                f64::from(w / 2.0),
                f64::from(h / 2.0),
            ],
            stops: vec![(0.0, r.color()), (r.range(0.2, 0.8), r.color()), (1.0, r.color())],
        },
        2 => Paint::Image {
            id: IMAGE,
            m: [f64::from(w), 0.0, 0.0, f64::from(h), 0.0, 0.0],
            tile: r.chance(0.5),
            opacity: r.range(0.3, 1.0),
        },
        3 if r.chance(0.3) => Paint::Placeholder,
        _ => Paint::Solid(r.color()),
    }
}

fn gen_rec(r: &mut Rng, readers: bool) -> Rec {
    let rot = if r.chance(0.2) { r.range(-0.6, 0.6) as f64 } else { 0.0 };
    let s = if r.chance(0.2) { r.range(0.5, 1.5) as f64 } else { 1.0 };
    let t = [
        s * rot.cos(),
        s * rot.sin(),
        -s * rot.sin(),
        s * rot.cos(),
        f64::from(r.range(-20.0, 140.0)),
        f64::from(r.range(-20.0, 100.0)),
    ];
    if r.chance(0.12) {
        let mut g = Rec::group();
        g.transform = ident();
        return g;
    }
    let (w, h) = (r.range(4.0, 80.0), r.range(4.0, 60.0));
    let mut rec = Rec::new(t, [w, h]);
    let shape = match r.below(5) {
        0 => Entry::Rect {
            w,
            h,
            radii: [r.range(0.0, 12.0), 0.0, r.range(0.0, 20.0), r.range(0.0, 6.0)],
        },
        1 => Entry::Ellipse { w, h },
        2 => Entry::Path(vec![
            (0, vec![0.0, 0.0]),
            (1, vec![w, h * 0.3]),
            (2, vec![w * 0.5, h * 1.4, 0.0, h]),
            (4, vec![]),
        ]),
        3 => Entry::Glyphs {
            scale: r.range(0.01, 0.04),
            glyphs: (0..1 + r.below(6))
                .map(|i| (1 + r.below(GLYPHS), i as f32 * r.range(6.0, 14.0), h))
                .collect(),
        },
        _ => Entry::Rect { w, h, radii: [0.0; 4] },
    };
    let text = matches!(shape, Entry::Glyphs { .. });
    rec.paths.push(shape);
    if readers && r.chance(0.15) {
        rec.ops.push(Op::Read {
            halo: r.range(0.0, 3.0).round(),
        });
    }
    let paint = if text && r.chance(0.7) {
        Paint::Solid(r.color())
    } else {
        gen_paint(r, w, h)
    };
    rec.ops.push(Op::Fill {
        path: 0,
        even_odd: r.chance(0.2),
        paint,
    });
    if !text && r.chance(0.6) {
        if r.chance(0.5) {
            rec.ops.push(Op::Clip {
                path: 0,
                even_odd: false,
            });
            rec.ops.push(Op::Children);
            rec.ops.push(Op::Unclip);
        } else {
            rec.ops.push(Op::Children);
        }
    }
    if r.chance(0.4) {
        let width = r.range(0.5, 6.0);
        let dashes = if r.chance(0.3) {
            vec![r.range(1.0, 6.0), r.range(1.0, 4.0)]
        } else {
            vec![]
        };
        let stroke = |width: f32, paint: Paint, dashes: Vec<f32>| Op::Stroke {
            path: 0,
            width,
            join: 0,
            cap: 0,
            dashes,
            offset: 0.0,
            paint,
        };
        match r.below(3) {
            0 => rec.ops.push(stroke(width, Paint::Solid(r.color()), dashes)),
            1 => {
                rec.ops.push(Op::Clip {
                    path: 0,
                    even_odd: false,
                });
                rec.ops.push(stroke(width * 2.0, Paint::Solid(r.color()), dashes));
                rec.ops.push(Op::Unclip);
            }
            _ => {
                rec.paths.push(Entry::Outside(0));
                rec.ops.push(Op::Clip {
                    path: 1,
                    even_odd: true,
                });
                rec.ops.push(stroke(width * 2.0, gen_paint(r, w, h), dashes));
                rec.ops.push(Op::Unclip);
            }
        }
    }
    if r.chance(0.25) {
        rec.opacity = r.range(0.2, 0.95);
        // Readers can't sit inside a layer that fades as one in phase 1: keep isolation out of
        // the reader runs.
        if !readers && r.chance(0.6) {
            rec.flags |= 2;
        }
    }
    if r.chance(0.05) {
        rec.flags |= 1;
    }
    if text && r.chance(0.3) {
        rec.coarse_below = 0.5;
        rec.paths.push(Entry::Rect {
            w,
            h: h * 0.5,
            radii: [0.0; 4],
        });
        let p = rec.paths.len() as u32 - 1;
        rec.coarse.push(Op::Fill {
            path: p,
            even_odd: false,
            paint: Paint::Solid([0.2, 0.2, 0.2, 0.55]),
        });
    }
    rec
}

impl Model {
    fn new(r: &mut Rng, n: u32, readers: bool) -> Self {
        let mut m = Model {
            nodes: BTreeMap::new(),
            children: HashMap::new(),
            next: 1,
            readers,
        };
        for _ in 0..n {
            let parent = m.random_parent(r);
            m.insert(r, parent);
        }
        m
    }
    fn random_parent(&self, r: &mut Rng) -> u32 {
        if self.nodes.is_empty() || r.chance(0.4) {
            return 0;
        }
        let ids: Vec<u32> = self.nodes.keys().copied().collect();
        ids[r.below(ids.len() as u32) as usize]
    }
    fn insert(&mut self, r: &mut Rng, parent: u32) -> u32 {
        let id = self.next;
        self.next += 1;
        let rec = gen_rec(r, self.readers);
        self.nodes.insert(id, (parent, rec));
        let list = self.children.entry(parent).or_default();
        let at = r.below(list.len() as u32 + 1) as usize;
        list.insert(at, id);
        id
    }
    fn subtree(&self, id: u32) -> Vec<u32> {
        let mut out = vec![id];
        let mut i = 0;
        while i < out.len() {
            out.extend(self.children.get(&out[i]).cloned().unwrap_or_default());
            i += 1;
        }
        out
    }
    fn fresh(&self, revision: u32) -> Vec<u8> {
        let mut w = W::new(ANY, revision);
        w.reset();
        for g in 1..=GLYPHS {
            w.glyph(g, &glyph_outline(g));
        }
        for id in self.subtree(0).into_iter().skip(1) {
            let (parent, rec) = &self.nodes[&id];
            w.set(id, *parent, rec);
        }
        for (parent, list) in &self.children {
            if !list.is_empty() {
                w.order(*parent, list);
            }
        }
        w.finish()
    }
    /// A random edit, applied to the model and written as a patch.
    fn edit(&mut self, r: &mut Rng, base: u32, revision: u32) -> Vec<u8> {
        let mut w = W::new(base, revision);
        let edits = 1 + r.below(3);
        for _ in 0..edits {
            let ids: Vec<u32> = self.nodes.keys().copied().collect();
            let pick = |r: &mut Rng| ids[r.below(ids.len() as u32) as usize];
            if self.nodes.is_empty() {
                let id = self.insert(r, 0);
                let (p, rec) = self.nodes[&id].clone();
                w.set(id, p, &rec);
                w.order(p, &self.children[&p]);
                continue;
            }
            match r.below(7) {
                0 => {
                    let parent = self.random_parent(r);
                    let id = self.insert(r, parent);
                    let rec = self.nodes[&id].1.clone();
                    w.set(id, parent, &rec);
                    w.order(parent, &self.children[&parent]);
                }
                1 => {
                    let id = pick(r);
                    if !self.nodes.contains_key(&id) {
                        continue;
                    }
                    for gone in self.subtree(id) {
                        self.nodes.remove(&gone);
                        self.children.remove(&gone);
                    }
                    for list in self.children.values_mut() {
                        list.retain(|c| *c != id);
                    }
                    w.remove(id);
                }
                2 => {
                    let parent = self.random_parent(r);
                    if let Some(list) = self.children.get_mut(&parent)
                        && list.len() > 1
                    {
                        let i = r.below(list.len() as u32) as usize;
                        let j = r.below(list.len() as u32) as usize;
                        list.swap(i, j);
                        let list = list.clone();
                        w.order(parent, &list);
                    }
                }
                3 => {
                    // Move to another parent, never into itself.
                    let id = pick(r);
                    let Some((old, rec)) = self.nodes.get(&id).cloned() else {
                        continue;
                    };
                    let parent = self.random_parent(r);
                    if self.subtree(id).contains(&parent) {
                        continue;
                    }
                    if let Some(l) = self.children.get_mut(&old) {
                        l.retain(|c| *c != id);
                    }
                    self.children.entry(parent).or_default().push(id);
                    self.nodes.insert(id, (parent, rec.clone()));
                    w.set(id, parent, &rec);
                    let list = self.children[&parent].clone();
                    w.order(parent, &list);
                }
                4 => {
                    let id = pick(r);
                    let Some((p, rec)) = self.nodes.get_mut(&id) else {
                        continue;
                    };
                    let mut t = rec.transform;
                    t[4] += f64::from(r.range(-30.0, 30.0));
                    t[5] += f64::from(r.range(-30.0, 30.0));
                    rec.transform = t;
                    let _ = p;
                    w.transform(id, t);
                }
                _ => {
                    let id = pick(r);
                    let Some((p, old)) = self.nodes.get(&id).cloned() else {
                        continue;
                    };
                    let mut rec = gen_rec(r, self.readers);
                    // Keep a container's children drawn where they were, sometimes.
                    if old.ops.iter().any(|o| matches!(o, Op::Children))
                        && !rec.ops.iter().any(|o| matches!(o, Op::Children))
                        && r.chance(0.5)
                    {
                        rec = old.clone();
                        rec.opacity = r.range(0.3, 1.0);
                    }
                    self.nodes.insert(id, (p, rec.clone()));
                    w.set(id, p, &rec);
                }
            }
        }
        w.finish()
    }
}

fn engine() -> Engine {
    let mut e = Engine::new(Limits::default());
    let mut px = vec![0u8; 8 * 8 * 4];
    for (i, p) in px.as_chunks_mut::<4>().0.iter_mut().enumerate() {
        p.copy_from_slice(&[(i * 31) as u8, (i * 7) as u8, 200, if i % 3 == 0 { 128 } else { 255 }]);
    }
    e.put_image(IMAGE, 8, 8, &px, false).expect("image");
    e
}

fn render(e: &mut Engine, cam: Camera) -> Vec<u8> {
    let (px, _) = e
        .render_cpu(W_PX, H_PX, cam, [1.0, 1.0, 1.0, 1.0], true)
        .unwrap_or_else(|err| panic!("render: {err}"));
    px.to_vec()
}

fn seed() -> u64 {
    match std::env::var("FUZZ_SEED").ok().as_deref() {
        Some("random") => {
            let s = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(1, |d| d.as_nanos() as u64);
            eprintln!("FUZZ_SEED={s}");
            s
        }
        Some(v) => v.parse().unwrap_or(0x5eed_0040),
        None => 0x5eed_0040,
    }
}
fn cases(default: u32) -> u32 {
    std::env::var("FUZZ_CASES")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(default)
}

fn run_sequences(readers: bool, default_cases: u32) {
    let base = seed() ^ if readers { 0xabcd } else { 0 };
    let mut changed_pixels = 0u64;
    for case in 0..cases(default_cases) {
        let s = base.wrapping_add(u64::from(case) * 0x9e37_79b9);
        if let Some(one) = std::env::var("FUZZ_ONE").ok().and_then(|v| v.parse::<u64>().ok())
            && one != s
        {
            continue;
        }
        let mut r = Rng(s | 1);
        let n = 4 + r.below(24);
        let mut model = Model::new(&mut r, n, readers);
        let cam = Camera {
            zoom: f64::from(r.range(0.5, 1.4)),
            x: f64::from(r.range(-20.0, 20.0)),
            y: f64::from(r.range(-20.0, 20.0)),
            dpr: 1.0,
        };
        let mut patched = engine();
        let mut revision = 1;
        patched
            .apply(&model.fresh(revision))
            .unwrap_or_else(|e| panic!("seed {s}: fresh list refused: {e}"));
        let mut before = render(&mut patched, cam);
        for step in 0..12 {
            let patch = model.edit(&mut r, revision, revision + 1);
            let applied = patched
                .apply(&patch)
                .unwrap_or_else(|e| panic!("seed {s} step {step}: patch refused: {e}"));
            revision += 1;
            let after = render(&mut patched, cam);
            let mut fresh = engine();
            fresh
                .apply(&model.fresh(revision))
                .unwrap_or_else(|e| panic!("seed {s} step {step}: fresh refused: {e}"));
            let expected = render(&mut fresh, cam);
            if let Some(i) = after.iter().zip(&expected).position(|(a, b)| a != b) {
                let px = i / 4;
                panic!(
                    "seed {s} step {step}: patched and fresh differ at ({}, {})",
                    px as u32 % W_PX,
                    px as u32 / W_PX
                );
            }
            // Every changed pixel lies in the dirty region (device pixels, a pixel of anti-aliasing round it).
            if !applied.full {
                let rects = patched.store.dirty(&applied.changes, cam.view(), 1.5);
                if std::env::var("FUZZ_ONE").is_ok() {
                    for c in &applied.changes {
                        eprintln!(
                            "step {step} change {c:?} device {:?}",
                            cam.view().transform_rect_bbox(c.rect)
                        );
                    }
                    for id in patched.store.readers().to_vec() {
                        let order = patched.store.order_of(id);
                        let n = &patched.store.nodes[&id];
                        eprintln!(
                            "reader {id} order {:?} parent {} size {:?} halo {:?} world {:?}",
                            order,
                            n.parent,
                            n.record.size,
                            n.record.reads(),
                            cam.view() * patched.store.world(id)
                        );
                    }
                    for (id, (p, rec)) in &model.nodes {
                        eprintln!(
                            "model {id} parent {p} flags {} t {:?} size {:?} ops {:?}",
                            rec.flags,
                            rec.transform,
                            rec.size,
                            rec.ops
                                .iter()
                                .map(|o| format!("{o:?}").chars().take(30).collect::<String>())
                                .collect::<Vec<_>>()
                        );
                    }
                }
                for (i, (a, b)) in before
                    .as_chunks::<4>()
                    .0
                    .iter()
                    .zip(after.as_chunks::<4>().0.iter())
                    .enumerate()
                {
                    if a != b {
                        changed_pixels += 1;
                        let (x, y) = ((i as u32 % W_PX) as f64 + 0.5, (i as u32 / W_PX) as f64 + 0.5);
                        assert!(
                            rects.iter().any(|r| r.contains((x, y))),
                            "seed {s} step {step}: pixel ({x}, {y}) changed outside the dirty region {rects:?}"
                        );
                    }
                }
            }
            before = after;
        }
    }
    assert!(changed_pixels > 0, "the edits changed nothing: the test tests nothing");
}

#[test]
fn patches_equal_a_fresh_build() {
    run_sequences(false, 60);
}

#[test]
fn readers_are_invalidated_transitively() {
    run_sequences(true, 60);
}

#[test]
fn a_failing_message_changes_nothing() {
    let mut r = Rng(7);
    let model = Model::new(&mut r, 12, false);
    let mut e = engine();
    e.apply(&model.fresh(1)).expect("fresh");
    let cam = Camera {
        zoom: 1.0,
        x: 0.0,
        y: 0.0,
        dpr: 1.0,
    };
    let before = render(&mut e, cam);
    // A good command, then one naming a record that isn't there.
    let mut w = W::new(1, 2);
    w.transform(1, [1.0, 0.0, 0.0, 1.0, 50.0, 50.0]);
    w.remove(9999);
    let err = e.apply(&w.finish()).expect_err("refused");
    assert_eq!(err.code, ErrorCode::Unknown);
    assert_eq!(e.store.revision, 1);
    assert_eq!(render(&mut e, cam), before, "the first command was undone");
    // A patch for an old revision is refused.
    let mut w = W::new(0, 5);
    w.remove(1);
    assert_eq!(e.apply(&w.finish()).expect_err("stale").code, ErrorCode::Revision);
}

#[test]
fn cycles_and_bad_orders_are_refused() {
    let mut e = engine();
    let mut w = W::new(ANY, 1);
    w.reset();
    w.set(1, 0, &Rec::group());
    w.set(2, 1, &Rec::group());
    e.apply(&w.finish()).expect("fresh");
    let mut w = W::new(1, 2);
    w.set(1, 2, &Rec::group());
    assert_eq!(e.apply(&w.finish()).expect_err("cycle").code, ErrorCode::Malformed);
    let mut w = W::new(1, 2);
    w.order(0, &[1, 1]);
    assert_eq!(e.apply(&w.finish()).expect_err("order").code, ErrorCode::Malformed);
    assert_eq!(e.store.len(), 2);
}

#[test]
fn random_bytes_never_panic() {
    let mut r = Rng(seed() | 1);
    let model = Model::new(&mut r, 20, true);
    let good = model.fresh(1);
    for _ in 0..cases(3000) {
        let mut bytes = good.clone();
        match r.below(4) {
            0 => {
                for _ in 0..1 + r.below(8) {
                    let i = r.below(bytes.len() as u32) as usize;
                    bytes[i] = r.next() as u8;
                }
            }
            1 => bytes.truncate(r.below(bytes.len() as u32) as usize),
            2 => {
                let i = r.below(bytes.len() as u32) as usize;
                bytes[i..].iter_mut().for_each(|b| *b = r.next() as u8);
            }
            _ => {
                // A float set to NaN or infinity somewhere.
                let i = (r.below(bytes.len() as u32 / 4) * 4) as usize;
                let v = [f32::NAN, f32::INFINITY, -1e30, 1e30][r.below(4) as usize];
                bytes[i..i + 4].copy_from_slice(&v.to_le_bytes());
            }
        }
        let mut e = engine();
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _ = e.apply(&bytes);
            let _ = e.render_cpu(
                64,
                48,
                Camera {
                    zoom: 1.0,
                    x: 0.0,
                    y: 0.0,
                    dpr: 1.0,
                },
                [1.0; 4],
                true,
            );
        }));
        assert!(result.is_ok(), "a mutated list panicked");
    }
}

#[test]
fn limits_are_enforced() {
    let mut e = Engine::new(Limits {
        records: 10,
        ..Limits::default()
    });
    let mut w = W::new(ANY, 1);
    w.reset();
    for id in 1..20 {
        w.set(id, 0, &Rec::group());
    }
    assert_eq!(e.apply(&w.finish()).expect_err("records").code, ErrorCode::Limit);
    assert!(e.store.is_empty());
    let cam = Camera {
        zoom: 1.0,
        x: 0.0,
        y: 0.0,
        dpr: 1.0,
    };
    assert_eq!(
        e.render_cpu(9000, 10, cam, [1.0; 4], false).expect_err("size").code,
        ErrorCode::Limit
    );
    assert_eq!(
        e.put_image(1, 9000, 1, &vec![0; 9000 * 4], false)
            .expect_err("image")
            .code,
        ErrorCode::Limit
    );
}

#[test]
fn tiles_reproduce_the_whole_frame() {
    for case in 0..cases(20) {
        let mut r = Rng(seed().wrapping_add(u64::from(case) * 77) | 1);
        let model = Model::new(&mut r, 24, case % 2 == 0);
        let mut e = engine();
        // Tiles narrower than the frame, so a band is several tiles.
        e.store.limits.export_tile = 48;
        e.apply(&model.fresh(1)).expect("fresh");
        let cam = Camera {
            zoom: 1.0,
            x: 0.0,
            y: 0.0,
            dpr: 1.0,
        };
        let (whole, _) = e.render_cpu(W_PX, H_PX, cam, [1.0; 4], false).expect("whole");
        let whole = whole.to_vec();
        let mut banded = Vec::new();
        let mut y = 0;
        while y < H_PX {
            let rows = 32.min(H_PX - y);
            banded.extend_from_slice(e.render_band(W_PX, H_PX, cam, [1.0; 4], y, rows).expect("band"));
            y += rows;
        }
        let differing = whole
            .as_chunks::<4>()
            .0
            .iter()
            .zip(banded.as_chunks::<4>().0.iter())
            .filter(|(a, b)| a != b)
            .count();
        let worst = whole
            .iter()
            .zip(&banded)
            .map(|(a, b)| a.abs_diff(*b))
            .max()
            .unwrap_or(0);
        let at: Vec<(u32, u32)> = whole
            .as_chunks::<4>()
            .0
            .iter()
            .zip(banded.as_chunks::<4>().0.iter())
            .enumerate()
            .filter(|(_, (a, b))| a != b)
            .map(|(i, _)| (i as u32 % W_PX, i as u32 / W_PX))
            .take(8)
            .collect();
        if differing > 0 {
            eprintln!("case {case}: readers {:?}, differing at {at:?}", e.store.readers());
        }
        assert!(
            differing == 0,
            "case {case}: {differing} pixels differ between bands and the whole frame (worst {worst})"
        );
    }
}

#[test]
fn exports_larger_than_the_cap_are_refused() {
    let mut e = engine();
    let cam = Camera {
        zoom: 2.0,
        x: 0.0,
        y: 0.0,
        dpr: 1.0,
    };
    let err = e.render_band(8193, 100, cam, [1.0; 4], 0, 10).expect_err("too wide");
    assert_eq!(err.code, ErrorCode::Limit);
    assert!(err.message.contains("8192"), "{}", err.message);
    assert!(e.render_band(8192, 8192, cam, [1.0; 4], 8000, 192).is_ok());
}
