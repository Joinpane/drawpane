//! A display-list writer for the tests, mirroring `packages/engine/src/wire.ts`, and a seeded
//! generator of random scenes and edits.
#![allow(dead_code)]

pub mod model;

pub const ANY: u32 = u32::MAX;

#[derive(Default)]
pub struct W {
    pub b: Vec<u8>,
    commands: u32,
    count_at: usize,
}

impl W {
    pub fn new(base: u32, revision: u32) -> Self {
        let mut w = W::default();
        w.u32(u32::from_le_bytes(*b"DPDL"));
        w.b.extend_from_slice(&drawpane_engine::wire::MAJOR.to_le_bytes());
        w.b.extend_from_slice(&drawpane_engine::wire::MINOR.to_le_bytes());
        w.u32(base);
        w.u32(revision);
        w.count_at = w.b.len();
        w.u32(0);
        w
    }
    pub fn u32(&mut self, v: u32) {
        self.b.extend_from_slice(&v.to_le_bytes());
    }
    pub fn f32(&mut self, v: f32) {
        self.b.extend_from_slice(&v.to_le_bytes());
    }
    pub fn f64(&mut self, v: f64) {
        self.b.extend_from_slice(&v.to_le_bytes());
    }
    pub fn m(&mut self, m: [f64; 6]) {
        for v in m {
            self.f64(v);
        }
    }
    pub fn command(&mut self, op: u32, body: impl FnOnce(&mut W)) {
        self.u32(op);
        let at = self.b.len();
        self.u32(0);
        let start = self.b.len();
        body(self);
        let len = (self.b.len() - start) as u32;
        self.b[at..at + 4].copy_from_slice(&len.to_le_bytes());
        self.commands += 1;
    }
    pub fn finish(mut self) -> Vec<u8> {
        let c = self.commands;
        self.b[self.count_at..self.count_at + 4].copy_from_slice(&c.to_le_bytes());
        self.b
    }
    pub fn reset(&mut self) {
        self.command(1, |_| {});
    }
    pub fn path(&mut self, p: &[(u8, Vec<f32>)]) {
        self.u32(p.len() as u32);
        let coords: usize = p.iter().map(|(_, c)| c.len()).sum();
        self.u32(coords as u32);
        let padded = p.len().next_multiple_of(4);
        for i in 0..padded {
            self.b.push(p.get(i).map_or(0, |(v, _)| *v));
        }
        for (_, c) in p {
            for v in c {
                self.f32(*v);
            }
        }
    }
    pub fn glyph(&mut self, id: u32, p: &[(u8, Vec<f32>)]) {
        self.command(2, |w| {
            w.u32(id);
            w.path(p);
        });
    }
    pub fn set(&mut self, id: u32, parent: u32, r: &Rec) {
        self.command(4, |w| {
            w.u32(id);
            w.u32(parent);
            r.write(w);
        });
    }
    pub fn remove(&mut self, id: u32) {
        self.command(5, |w| w.u32(id));
    }
    pub fn order(&mut self, parent: u32, ids: &[u32]) {
        self.command(6, |w| {
            w.u32(parent);
            w.u32(ids.len() as u32);
            for id in ids {
                w.u32(*id);
            }
        });
    }
    pub fn transform(&mut self, id: u32, m: [f64; 6]) {
        self.command(7, |w| {
            w.u32(id);
            w.m(m);
        });
    }
}

#[derive(Clone, Debug)]
pub enum Entry {
    Path(Vec<(u8, Vec<f32>)>),
    Rect {
        w: f32,
        h: f32,
        radii: [f32; 4],
    },
    Ellipse {
        w: f32,
        h: f32,
    },
    Glyphs {
        scale: f32,
        glyphs: Vec<(u32, f32, f32)>,
    },
    Outside(u32),
    Box {
        x: f32,
        y: f32,
        w: f32,
        h: f32,
        radii: [f32; 4],
    },
    Oval {
        x: f32,
        y: f32,
        w: f32,
        h: f32,
    },
}

#[derive(Clone, Debug)]
pub enum Paint {
    Solid([f32; 4]),
    Gradient {
        kind: u32,
        m: [f64; 6],
        stops: Vec<(f32, [f32; 4])>,
    },
    Image {
        id: u32,
        m: [f64; 6],
        tile: bool,
        opacity: f32,
    },
    Placeholder,
    /// The loading checkerboard at an image paint's opacity.
    PlaceholderAt(f32),
}

#[derive(Clone, Debug)]
pub enum Op {
    Fill {
        path: u32,
        even_odd: bool,
        paint: Paint,
    },
    Stroke {
        path: u32,
        width: f32,
        join: u32,
        cap: u32,
        dashes: Vec<f32>,
        offset: f32,
        paint: Paint,
    },
    Clip {
        path: u32,
        even_odd: bool,
    },
    Unclip,
    Children,
    Read {
        halo: f32,
    },
    Layer {
        compose: u32,
    },
    Unlayer,
    DropShadow {
        paths: Vec<u32>,
        even_odd: bool,
        dx: f32,
        dy: f32,
        blur: f32,
        color: [f32; 4],
        blend: u32,
    },
    InnerShadow {
        shape: u32,
        hole: Option<u32>,
        even_odd: bool,
        dx: f32,
        dy: f32,
        blur: f32,
        color: [f32; 4],
        blend: u32,
    },
}

#[derive(Clone, Debug)]
pub struct Rec {
    pub flags: u32,
    pub opacity: f32,
    pub transform: [f64; 6],
    pub size: [f32; 2],
    pub coarse_below: f32,
    pub unsupported: u32,
    pub paths: Vec<Entry>,
    pub ops: Vec<Op>,
    pub coarse: Vec<Op>,
    /// The blend mode written on every paint (0 normal), and every rect entry's smoothing.
    pub blend: u32,
    pub smoothing: f32,
}

impl Rec {
    pub fn new(transform: [f64; 6], size: [f32; 2]) -> Self {
        Rec {
            flags: 0,
            opacity: 1.0,
            transform,
            size,
            coarse_below: 0.0,
            unsupported: 0,
            paths: vec![],
            ops: vec![],
            coarse: vec![],
            blend: 0,
            smoothing: 0.0,
        }
    }
    pub fn group() -> Self {
        Rec {
            flags: 4,
            ops: vec![Op::Children],
            ..Rec::new([1.0, 0.0, 0.0, 1.0, 0.0, 0.0], [0.0, 0.0])
        }
    }
    fn paint(w: &mut W, p: &Paint, blend: u32) {
        match p {
            Paint::Solid(c) => {
                w.u32(1);
                w.u32(blend);
                for v in c {
                    w.f32(*v);
                }
            }
            Paint::Gradient { kind, m, stops } => {
                w.u32(*kind);
                w.u32(blend);
                w.m(*m);
                w.u32(stops.len() as u32);
                for (p, c) in stops {
                    w.f32(*p);
                    for v in c {
                        w.f32(*v);
                    }
                }
            }
            Paint::Image { id, m, tile, opacity } => {
                w.u32(6);
                w.u32(0);
                w.u32(*id);
                w.m(*m);
                w.u32(u32::from(*tile));
                w.f32(*opacity);
            }
            Paint::Placeholder => {
                w.u32(7);
                w.u32(0);
                w.f32(1.0);
            }
            Paint::PlaceholderAt(opacity) => {
                w.u32(7);
                w.u32(0);
                w.f32(*opacity);
            }
        }
    }
    fn ops(w: &mut W, ops: &[Op], blend: u32) {
        w.u32(ops.len() as u32);
        for op in ops {
            match op {
                Op::Fill { path, even_odd, paint } => {
                    w.u32(1);
                    w.u32(*path);
                    w.u32(u32::from(*even_odd));
                    Self::paint(w, paint, blend);
                }
                Op::Stroke {
                    path,
                    width,
                    join,
                    cap,
                    dashes,
                    offset,
                    paint,
                } => {
                    w.u32(2);
                    w.u32(*path);
                    w.f32(*width);
                    w.u32(*join);
                    w.u32(*cap);
                    w.f32(10.0);
                    w.u32(dashes.len() as u32);
                    for d in dashes {
                        w.f32(*d);
                    }
                    w.f32(*offset);
                    Self::paint(w, paint, blend);
                }
                Op::Clip { path, even_odd } => {
                    w.u32(3);
                    w.u32(*path);
                    w.u32(u32::from(*even_odd));
                }
                Op::Unclip => w.u32(4),
                Op::Children => w.u32(5),
                Op::Read { halo } => {
                    w.u32(6);
                    w.u32(1);
                    w.f32(*halo);
                }
                Op::Layer { compose } => {
                    w.u32(7);
                    w.u32(*compose);
                }
                Op::Unlayer => w.u32(8),
                Op::DropShadow {
                    paths,
                    even_odd,
                    dx,
                    dy,
                    blur,
                    color,
                    blend: sb,
                } => {
                    w.u32(13);
                    w.u32(paths.len() as u32);
                    for p in paths {
                        w.u32(*p);
                    }
                    w.u32(u32::from(*even_odd));
                    w.f32(*dx);
                    w.f32(*dy);
                    w.f32(*blur);
                    for v in color {
                        w.f32(*v);
                    }
                    w.u32(*sb);
                }
                Op::InnerShadow {
                    shape,
                    hole,
                    even_odd,
                    dx,
                    dy,
                    blur,
                    color,
                    blend: sb,
                } => {
                    w.u32(14);
                    w.u32(*shape);
                    w.u32(hole.unwrap_or(u32::MAX));
                    w.u32(u32::from(*even_odd));
                    w.f32(*dx);
                    w.f32(*dy);
                    w.f32(*blur);
                    for v in color {
                        w.f32(*v);
                    }
                    w.u32(*sb);
                }
            }
        }
    }
    pub fn write(&self, w: &mut W) {
        w.u32(self.flags);
        w.f32(self.opacity);
        w.m(self.transform);
        w.f32(self.size[0]);
        w.f32(self.size[1]);
        w.f32(self.coarse_below);
        w.f32(0.0);
        w.u32(self.unsupported);
        w.u32(self.paths.len() as u32);
        for e in &self.paths {
            match e {
                Entry::Path(p) => {
                    w.u32(1);
                    w.path(p);
                }
                Entry::Rect { w: rw, h, radii } => {
                    w.u32(2);
                    w.f32(*rw);
                    w.f32(*h);
                    for r in radii {
                        w.f32(*r);
                    }
                    w.f32(self.smoothing);
                }
                Entry::Ellipse { w: ew, h } => {
                    w.u32(3);
                    w.f32(*ew);
                    w.f32(*h);
                }
                Entry::Glyphs { scale, glyphs } => {
                    w.u32(4);
                    w.f32(*scale);
                    w.u32(glyphs.len() as u32);
                    for (g, x, y) in glyphs {
                        w.u32(*g);
                        w.f32(*x);
                        w.f32(*y);
                    }
                }
                Entry::Outside(of) => {
                    w.u32(5);
                    w.u32(*of);
                }
                Entry::Box { x, y, w: bw, h, radii } => {
                    w.u32(6);
                    w.f32(*x);
                    w.f32(*y);
                    w.f32(*bw);
                    w.f32(*h);
                    for r in radii {
                        w.f32(*r);
                    }
                    w.f32(self.smoothing);
                }
                Entry::Oval { x, y, w: ow, h } => {
                    w.u32(7);
                    w.f32(*x);
                    w.f32(*y);
                    w.f32(*ow);
                    w.f32(*h);
                }
            }
        }
        Self::ops(w, &self.ops, self.blend);
        Self::ops(w, &self.coarse, self.blend);
    }
}

/// A small deterministic generator (xorshift*), so a failing seed reproduces.
pub struct Rng(pub u64);

impl Rng {
    pub fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_f491_4f6c_dd1d)
    }
    pub fn below(&mut self, n: u32) -> u32 {
        (self.next() % u64::from(n.max(1))) as u32
    }
    pub fn unit(&mut self) -> f32 {
        (self.next() >> 40) as f32 / (1u64 << 24) as f32
    }
    pub fn range(&mut self, a: f32, b: f32) -> f32 {
        a + (b - a) * self.unit()
    }
    pub fn chance(&mut self, p: f32) -> bool {
        self.unit() < p
    }
    pub fn color(&mut self) -> [f32; 4] {
        let a = if self.chance(0.3) { self.range(0.2, 1.0) } else { 1.0 };
        [self.unit(), self.unit(), self.unit(), a]
    }
}

/// A glyph outline: a box with a hole, in font units (y up), about 700 units tall.
pub fn glyph_outline(k: u32) -> Vec<(u8, Vec<f32>)> {
    let w = 300.0 + (k % 5) as f32 * 60.0;
    vec![
        (0, vec![0.0, 0.0]),
        (1, vec![w, 0.0]),
        (3, vec![w + 40.0, 300.0, w + 40.0, 500.0, w, 700.0]),
        (1, vec![0.0, 700.0]),
        (4, vec![]),
        (0, vec![80.0, 120.0]),
        (1, vec![80.0, 580.0]),
        (1, vec![w - 80.0, 580.0]),
        (1, vec![w - 80.0, 120.0]),
        (4, vec![]),
    ]
}

pub const GLYPHS: u32 = 6;
pub const IMAGE: u32 = 7;
