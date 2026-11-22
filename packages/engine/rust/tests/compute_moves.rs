//! Drags on the compute path patch the retained encoding's transforms in place
//! (`compute_moves`, decision 0040 P1-0). Patched must equal fresh: after any number of drag
//! patches, the transforms match a fresh walk of the moved page to one f32 ulp, and the spans
//! line up.

mod common;

use common::{ANY, Entry, Op, Paint, Rec, W, glyph_outline};
use drawpane_engine::compute_moves::{SpanRecorder, apply_moves};
use drawpane_engine::error::Result;
use drawpane_engine::limits::Limits;
use drawpane_engine::ordinary::{OrdinarySink, walk_ordinary};
use drawpane_engine::record::{CompactPath, ComposeMode, GlyphInstance, Paint as RecordPaint};
use drawpane_engine::store::{ROOT, Store};
use vello_common::kurbo::{Affine, BezPath, Rect};

/// Keeps what the compute encoder keeps: one transform per draw (deduplicated as Vello's encoder
/// does, forced at record boundaries) and each record's span.
#[derive(Default)]
struct Recording {
    transforms: Vec<Affine>,
    force: bool,
    spans: SpanRecorder,
}

impl Recording {
    fn transform(&mut self, t: Affine) {
        if self.force || self.transforms.last() != Some(&t) {
            self.transforms.push(t);
            self.force = false;
        }
    }
}

impl OrdinarySink for Recording {
    fn begin_record(&mut self, id: u32, world: Affine) {
        self.force = true;
        self.spans.begin(id, world, self.transforms.len());
    }
    fn end_record(&mut self, id: u32) {
        self.force = true;
        self.spans.end(id, self.transforms.len());
    }
    fn push_layer(&mut self, world: Affine, _: Rect, _: u32, _: ComposeMode, _: f32) {
        self.transform(world);
    }
    fn pop_layer(&mut self) {}
    fn push_clip(&mut self, world: Affine, _: &BezPath, _: bool) {
        self.transform(world);
    }
    fn pop_clip(&mut self) {}
    fn fill_path(&mut self, world: Affine, _: &BezPath, _: bool, _: &RecordPaint, _: f32) {
        self.transform(world);
    }
    fn fill_compact(&mut self, world: Affine, _: &CompactPath, _: bool, _: &RecordPaint, _: f32) {
        self.transform(world);
    }
    fn fill_glyphs(
        &mut self,
        world: Affine,
        scale: f64,
        glyphs: &[GlyphInstance],
        _: &RecordPaint,
        _: bool,
        _: f32,
        _: bool,
    ) -> Result<()> {
        for g in glyphs {
            self.transform(world * Affine::new([scale, 0.0, 0.0, -scale, f64::from(g.x), f64::from(g.y)]));
        }
        Ok(())
    }
}

fn walk(store: &Store) -> Recording {
    let mut sink = Recording::default();
    walk_ordinary(store, &mut sink).unwrap();
    sink
}

const CARD: u32 = 100;

/// `n` cards at the top level, each clipped with a fill, a gradient, a stroke, a glyph run and
/// a nested group with two shapes of its own. Card `k` is id `CARD * (k + 1)`.
fn page(n: u32) -> Store {
    let mut w = W::new(ANY, 1);
    w.reset();
    for k in 1..=4 {
        w.glyph(k, &glyph_outline(k));
    }
    let solid = |c: f32| Paint::Solid([c, 0.3, 0.6, 1.0]);
    let mut cards = Vec::new();
    for k in 0..n {
        let card = CARD * (k + 1);
        cards.push(card);
        let x = f64::from(k % 4) * 340.0 + 20.0;
        let y = f64::from(k / 4) * 240.0 + 20.0;
        let mut rec = Rec::new([1.0, 0.0, 0.0, 1.0, x, y], [320.0, 220.0]);
        rec.paths = vec![Entry::Rect {
            w: 320.0,
            h: 220.0,
            radii: [12.0; 4],
        }];
        rec.ops = vec![
            Op::Fill {
                path: 0,
                even_odd: false,
                paint: solid(1.0),
            },
            Op::Clip {
                path: 0,
                even_odd: false,
            },
            Op::Children,
            Op::Unclip,
            Op::Stroke {
                path: 0,
                width: 1.0,
                join: 0,
                cap: 0,
                dashes: vec![],
                offset: 0.0,
                paint: solid(0.5),
            },
        ];
        w.set(card, ROOT, &rec);

        let mut banner = Rec::new([1.0, 0.0, 0.0, 1.0, 14.0, 14.0], [292.0, 36.0]);
        banner.paths = vec![Entry::Rect {
            w: 292.0,
            h: 36.0,
            radii: [8.0; 4],
        }];
        banner.ops = vec![Op::Fill {
            path: 0,
            even_odd: false,
            paint: Paint::Gradient {
                kind: 2,
                m: [292.0, 0.0, 0.0, 36.0, 0.0, 0.0],
                stops: vec![(0.0, [0.2, 0.4, 0.9, 1.0]), (1.0, [0.1, 0.2, 0.5, 1.0])],
            },
        }];
        w.set(card + 1, card, &banner);

        let mut text = Rec::new([1.0, 0.0, 0.0, 1.0, 16.0, 106.0], [200.0, 16.0]);
        text.paths = vec![Entry::Glyphs {
            scale: 0.014,
            glyphs: (0..10).map(|g| ((g + k) % 4 + 1, g as f32 * 10.5, 12.0)).collect(),
        }];
        text.ops = vec![Op::Fill {
            path: 0,
            even_odd: false,
            paint: solid(0.1),
        }];
        w.set(card + 2, card, &text);

        let mut group = Rec::group();
        group.transform = [0.8, 0.1, -0.1, 0.8, 30.0, 150.0];
        w.set(card + 3, card, &group);
        for (j, (sx, entry)) in [
            (0.0, Entry::Ellipse { w: 12.0, h: 12.0 }),
            (
                40.0,
                Entry::Rect {
                    w: 52.0,
                    h: 12.0,
                    radii: [6.0; 4],
                },
            ),
        ]
        .into_iter()
        .enumerate()
        {
            let mut shape = Rec::new([1.0, 0.0, 0.0, 1.0, sx, 0.0], [52.0, 12.0]);
            shape.paths = vec![entry];
            shape.ops = vec![
                Op::Fill {
                    path: 0,
                    even_odd: false,
                    paint: solid(0.7),
                },
                Op::Stroke {
                    path: 0,
                    width: 1.5,
                    join: 1,
                    cap: 1,
                    dashes: vec![],
                    offset: 0.0,
                    paint: solid(0.2),
                },
            ];
            w.set(card + 4 + j as u32, card + 3, &shape);
        }
        w.order(card + 3, &[card + 4, card + 5]);
        w.order(card, &[card + 1, card + 2, card + 3]);
    }
    w.order(ROOT, &cards);
    let mut store = Store::new(Limits::default());
    store.apply(&w.finish()).unwrap();
    store
}

/// Moves `ids` by `by` in one patch, as a drag does. Returns the moved ids.
fn drag(store: &mut Store, ids: &[u32], by: (f64, f64)) -> Vec<u32> {
    let revision = store.revision;
    let mut w = W::new(revision, revision + 1);
    for &id in ids {
        let next = Affine::translate(by) * store.nodes[&id].record.transform;
        w.transform(id, next.as_coeffs());
    }
    let applied = store.apply(&w.finish()).unwrap();
    let mut want: Vec<u32> = ids.to_vec();
    want.sort_unstable();
    assert_eq!(
        applied.moved.as_deref(),
        Some(&want[..]),
        "a transform-only patch is a move"
    );
    ids.to_vec()
}

fn assert_close(patched: &[Affine], fresh: &[Affine]) {
    assert_eq!(patched.len(), fresh.len(), "transform count");
    for (i, (a, b)) in patched.iter().zip(fresh).enumerate() {
        for (k, (x, y)) in a.as_coeffs().iter().zip(b.as_coeffs()).enumerate() {
            let (x, y) = (*x as f32, y as f32);
            let ulp = (x.abs().max(y.abs()) * f32::EPSILON).max(f32::MIN_POSITIVE);
            assert!((x - y).abs() <= ulp, "transform {i}[{k}]: patched {x}, fresh {y}");
        }
    }
}

#[test]
fn dragging_cards_patches_like_a_fresh_walk() {
    let mut store = page(12);
    let mut encoded = walk(&store);
    let mut transforms = encoded.transforms.clone();
    assert!(encoded.spans.spans.len() >= 12 * 6, "every drawn record has a span");
    for step in 0..60 {
        let ids = if step % 3 == 0 {
            vec![CARD, CARD * 5]
        } else {
            vec![CARD * 2]
        };
        let moved = drag(&mut store, &ids, (3.25, -1.5 + f64::from(step) * 0.125));
        let dirty = apply_moves(&mut transforms, &mut encoded.spans.spans, &store, &moved).expect("patched");
        assert!(!dirty.is_empty());
        let fresh = walk(&store);
        assert_close(&transforms, &fresh.transforms);
        for (id, span) in &fresh.spans.spans {
            let ours = encoded.spans.spans[id];
            assert_eq!((ours.start, ours.end), (span.start, span.end), "span of {id}");
        }
    }
}

#[test]
fn dragging_nested_records_patches_like_a_fresh_walk() {
    let mut store = page(4);
    let mut encoded = walk(&store);
    let mut transforms = encoded.transforms.clone();
    // A shape inside a rotated group, then the group's card, then the shape again, then the group.
    for (id, by) in [
        (CARD + 4, (5.0, 2.0)),
        (CARD, (-12.0, 7.5)),
        (CARD + 4, (0.5, 0.25)),
        (CARD + 3, (-3.0, 9.0)),
    ] {
        let moved = drag(&mut store, &[id], by);
        apply_moves(&mut transforms, &mut encoded.spans.spans, &store, &moved).expect("patched");
        assert_close(&transforms, &walk(&store).transforms);
    }
}

#[test]
fn refuses_what_it_cannot_patch_and_changes_nothing() {
    let store = page(4);
    let mut encoded = walk(&store);
    let mut transforms = encoded.transforms.clone();
    // A record the walk never drew.
    assert!(apply_moves(&mut transforms, &mut encoded.spans.spans, &store, &[999_999]).is_none());
    // A card and something inside it in the same patch would move twice.
    assert!(apply_moves(&mut transforms, &mut encoded.spans.spans, &store, &[CARD, CARD + 4]).is_none());
    assert_eq!(transforms, encoded.transforms);
}

fn rect_child(w: &mut W, id: u32, parent: u32, x: f64) {
    let mut child = Rec::new([1.0, 0.0, 0.0, 1.0, x, 0.0], [40.0, 40.0]);
    child.paths = vec![Entry::Rect {
        w: 40.0,
        h: 40.0,
        radii: [0.0; 4],
    }];
    child.ops = vec![Op::Fill {
        path: 0,
        even_odd: false,
        paint: Paint::Solid([1.0, 0.0, 0.0, 1.0]),
    }];
    w.set(id, parent, &child);
}

/// The stack review's bug 1: a group that draws nothing of its own shares its only child's
/// span. Dragging the child must move the child alone, step after step.
#[test]
fn dragging_the_only_child_of_an_empty_group_patches_like_a_fresh_walk() {
    let mut w = W::new(ANY, 1);
    w.reset();
    let mut group = Rec::group();
    group.transform = [1.0, 0.0, 0.0, 1.0, 100.0, 50.0];
    w.set(10, ROOT, &group);
    rect_child(&mut w, 11, 10, 10.0);
    w.order(10, &[11]);
    w.order(ROOT, &[10]);
    let mut store = Store::new(Limits::default());
    store.apply(&w.finish()).unwrap();
    let mut encoded = walk(&store);
    assert_eq!(
        (encoded.spans.spans[&10].start, encoded.spans.spans[&10].end),
        (encoded.spans.spans[&11].start, encoded.spans.spans[&11].end),
        "the group and its child share a span (what made the old containment test wrong)"
    );
    let mut transforms = encoded.transforms.clone();
    for _ in 0..5 {
        let moved = drag(&mut store, &[11], (10.0, 0.0));
        apply_moves(&mut transforms, &mut encoded.spans.spans, &store, &moved).expect("patched");
        assert_close(&transforms, &walk(&store).transforms);
        assert_eq!(
            encoded.spans.spans[&10].world,
            Affine::translate((100.0, 50.0)),
            "the group stays"
        );
    }
    // And the group itself, after its child moved.
    let moved = drag(&mut store, &[10], (-30.0, 12.0));
    apply_moves(&mut transforms, &mut encoded.spans.spans, &store, &moved).expect("patched");
    assert_close(&transforms, &walk(&store).transforms);
}

/// The stack review's bug 2: an isolated translucent group is drawn as one layer bounded by
/// where its children were; a child dragged out of it would be cut off. Such moves re-encode.
#[test]
fn moves_under_a_bounded_layer_re_encode() {
    let mut w = W::new(ANY, 1);
    w.reset();
    let mut iso = Rec::group();
    iso.flags |= 2; // isolate
    iso.opacity = 0.6;
    w.set(10, ROOT, &iso);
    rect_child(&mut w, 11, 10, 0.0);
    rect_child(&mut w, 12, 10, 10.0);
    w.order(10, &[11, 12]);
    w.order(ROOT, &[10]);
    let mut store = Store::new(Limits::default());
    store.apply(&w.finish()).unwrap();
    let mut encoded = walk(&store);
    let mut transforms = encoded.transforms.clone();
    let moved = drag(&mut store, &[11], (200.0, 0.0));
    assert!(
        apply_moves(&mut transforms, &mut encoded.spans.spans, &store, &moved).is_none(),
        "a move under an isolated layer must re-encode"
    );
    assert_eq!(transforms, encoded.transforms, "nothing changes when it refuses");
    // The group itself moves its layer with it, so that one is patched.
    let mut fresh = walk(&store);
    let mut transforms = fresh.transforms.clone();
    let moved = drag(&mut store, &[10], (25.0, -5.0));
    apply_moves(&mut transforms, &mut fresh.spans.spans, &store, &moved).expect("patched");
    assert_close(&transforms, &walk(&store).transforms);
}

/// The stack review's bug 3: moving many records walked every span once per record. Now each
/// move visits its own subtree: 500 cards of a 40k-record page patch like a fresh walk.
#[test]
fn moving_many_cards_visits_only_their_subtrees() {
    // 6,667 cards of six records: a 40k-record page.
    let mut store = page(6667);
    let mut encoded = walk(&store);
    let mut transforms = encoded.transforms.clone();
    let ids: Vec<u32> = (0..500).map(|k| CARD * (k * 3 + 1)).collect();
    let moved = drag(&mut store, &ids, (4.0, -2.0));
    let started = std::time::Instant::now();
    apply_moves(&mut transforms, &mut encoded.spans.spans, &store, &moved).expect("patched");
    let ms = started.elapsed().as_secs_f64() * 1e3;
    assert_close(&transforms, &walk(&store).transforms);
    // Generous, for a loaded machine: before, this took 103 ms natively.
    if !cfg!(debug_assertions) {
        assert!(ms < 25.0, "moving 500 cards took {ms:.1} ms");
    }
}
