//! A seeded model of a page (records in a tree, paint order) and random edits to it, written as
//! display-list patches: shared by the fuzz tests and the tile tests.
#![allow(dead_code)]

use super::*;
use std::collections::{BTreeMap, HashMap};

pub struct Model {
    pub nodes: BTreeMap<u32, (u32, Rec)>,
    pub children: HashMap<u32, Vec<u32>>,
    pub next: u32,
    pub readers: bool,
}

pub fn ident() -> [f64; 6] {
    [1.0, 0.0, 0.0, 1.0, 0.0, 0.0]
}

pub fn gen_paint(r: &mut Rng, w: f32, h: f32) -> Paint {
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

pub fn gen_rec(r: &mut Rng, readers: bool) -> Rec {
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
        if !readers && r.chance(0.12) {
            g.post.push(Post::LayerBlur(r.range(2.0, 14.0)));
        }
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
    if !readers && r.chance(0.22) {
        let blur = if r.chance(0.25) { 0.0 } else { r.range(2.0, 20.0) };
        let dx = r.range(-10.0, 10.0);
        let dy = r.range(-10.0, 10.0);
        let spread = if !text && r.chance(0.4) {
            r.range(-4.0, 6.0)
        } else {
            0.0
        };
        let cast_idx = if spread != 0.0 && matches!(rec.paths[0], Entry::Rect { .. }) {
            let gw = (w + spread * 2.0).max(0.0);
            let gh = (h + spread * 2.0).max(0.0);
            if gw > 0.0 && gh > 0.0 {
                rec.paths.push(Entry::Box {
                    x: -spread,
                    y: -spread,
                    w: gw,
                    h: gh,
                    radii: [0.0; 4],
                });
                Some(rec.paths.len() as u32 - 1)
            } else {
                None
            }
        } else {
            Some(0)
        };
        if let Some(cast_path) = cast_idx {
            let cut_out = !text && r.chance(0.3);
            if cut_out {
                rec.paths.push(Entry::Outside(0));
                let out_idx = rec.paths.len() as u32 - 1;
                rec.ops.push(Op::Clip {
                    path: out_idx,
                    even_odd: true,
                });
            }
            rec.ops.push(Op::DropShadow {
                paths: vec![cast_path],
                even_odd: false,
                dx,
                dy,
                blur,
                color: [r.unit(), r.unit(), r.unit(), r.range(0.15, 0.7)],
                blend: 0,
            });
            if cut_out {
                rec.ops.push(Op::Unclip);
            }
        }
    }
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
    if !readers && !text && r.chance(0.18) {
        let blur = if r.chance(0.25) { 0.0 } else { r.range(2.0, 16.0) };
        let dx = r.range(-8.0, 8.0);
        let dy = r.range(-8.0, 8.0);
        let spread = if r.chance(0.4) { r.range(-3.0, 6.0) } else { 0.0 };
        let hole = if spread != 0.0 && matches!(rec.paths[0], Entry::Rect { .. }) {
            let gw = (w - spread * 2.0).max(0.0);
            let gh = (h - spread * 2.0).max(0.0);
            if gw > 0.0 && gh > 0.0 {
                rec.paths.push(Entry::Box {
                    x: spread,
                    y: spread,
                    w: gw,
                    h: gh,
                    radii: [0.0; 4],
                });
                Some(rec.paths.len() as u32 - 1)
            } else {
                None
            }
        } else {
            Some(0)
        };
        rec.ops.push(Op::InnerShadow {
            shape: 0,
            hole,
            even_odd: false,
            dx,
            dy,
            blur,
            color: [r.unit(), r.unit(), r.unit(), r.range(0.15, 0.7)],
            blend: 0,
        });
    }
    if !readers && r.chance(0.10) {
        rec.post
            .push(Post::LayerBlur(if r.chance(0.2) { 0.0 } else { r.range(2.0, 14.0) }));
    }
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
    pub fn new(r: &mut Rng, n: u32, readers: bool) -> Self {
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
    pub fn random_parent(&self, r: &mut Rng) -> u32 {
        if self.nodes.is_empty() || r.chance(0.4) {
            return 0;
        }
        let ids: Vec<u32> = self.nodes.keys().copied().collect();
        ids[r.below(ids.len() as u32) as usize]
    }
    pub fn insert(&mut self, r: &mut Rng, parent: u32) -> u32 {
        let id = self.next;
        self.next += 1;
        let rec = gen_rec(r, self.readers);
        self.nodes.insert(id, (parent, rec));
        let list = self.children.entry(parent).or_default();
        let at = r.below(list.len() as u32 + 1) as usize;
        list.insert(at, id);
        id
    }
    pub fn subtree(&self, id: u32) -> Vec<u32> {
        let mut out = vec![id];
        let mut i = 0;
        while i < out.len() {
            out.extend(self.children.get(&out[i]).cloned().unwrap_or_default());
            i += 1;
        }
        out
    }
    pub fn fresh(&self, revision: u32) -> Vec<u8> {
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
    pub fn edit(&mut self, r: &mut Rng, base: u32, revision: u32) -> Vec<u8> {
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
