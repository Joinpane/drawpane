//! A layer record: what TypeScript resolved for one layer (decision 0040, "The boundary"), in the
//! layer's own units. Decoded and validated in full before anything in the engine changes.

use crate::error::{EngineError, Result};
use crate::geometry;
use crate::limits::Limits;
use crate::wire::Reader;
use std::mem::size_of;
use vello_common::kurbo::{Affine, BezPath, Rect};

pub type Rgba = [f32; 4];

pub const FLAG_HIDDEN: u32 = 1;
/// Drawn as one picture and faded as a whole (`fadesAsOne`): an isolating opacity group.
pub const FLAG_ISOLATE: u32 = 2;
/// No paint of its own: a group, whose children are drawn in its parent's space.
pub const FLAG_GROUP: u32 = 4;
/// Sent ahead of its real drawing (text not shaped yet, while a page opens): drawn as its coarse
/// ops at every scale, and never exact. Its record is sent again whole soon after.
pub const FLAG_PROVISIONAL: u32 = 8;
const KNOWN_FLAGS: u32 = FLAG_HIDDEN | FLAG_ISOLATE | FLAG_GROUP | FLAG_PROVISIONAL;

/// Bits of `Record::unsupported` (`UNSUPPORTED` in wire.ts) the engine sets itself, from what it
/// decodes, so anything it would refuse while drawing refuses its page before any drawing, on
/// screen or not, in an export's crop or not, whatever the builder flagged.
pub mod derived {
    pub const BLEND: u32 = 1 << 7;
    pub const CORNER_SMOOTHING: u32 = 1 << 9;
    pub const DIAMOND_GRADIENT: u32 = 1 << 12;
    pub const BACKDROP_READER: u32 = 1 << 13;
}

#[derive(Clone, Debug)]
pub struct GlyphInstance {
    pub glyph: u32,
    pub x: f32,
    pub y: f32,
}

/// A path as it arrives (verbs and f32 coordinates), expanded only to draw: kurbo's `BezPath`
/// takes 56 bytes an element, and a Worker holds tens of thousands of records under its cap.
#[derive(Clone, Debug, Default)]
pub struct CompactPath {
    verbs: Vec<u8>,
    coords: Vec<f32>,
}

impl CompactPath {
    pub fn from_bez(p: &BezPath) -> Self {
        use vello_common::kurbo::PathEl;
        let mut out = Self {
            verbs: Vec::with_capacity(p.elements().len()),
            coords: Vec::new(),
        };
        let push = |pt: vello_common::kurbo::Point, c: &mut Vec<f32>| {
            c.push(pt.x as f32);
            c.push(pt.y as f32);
        };
        for el in p.elements() {
            match *el {
                PathEl::MoveTo(a) => {
                    out.verbs.push(0);
                    push(a, &mut out.coords);
                }
                PathEl::LineTo(a) => {
                    out.verbs.push(1);
                    push(a, &mut out.coords);
                }
                PathEl::QuadTo(a, b) => {
                    out.verbs.push(2);
                    push(a, &mut out.coords);
                    push(b, &mut out.coords);
                }
                PathEl::CurveTo(a, b, c) => {
                    out.verbs.push(3);
                    push(a, &mut out.coords);
                    push(b, &mut out.coords);
                    push(c, &mut out.coords);
                }
                PathEl::ClosePath => out.verbs.push(4),
            }
        }
        out.verbs.shrink_to_fit();
        out.coords.shrink_to_fit();
        out
    }

    pub fn is_empty(&self) -> bool {
        self.verbs.is_empty()
    }

    /// Path elements it expands to.
    pub fn len(&self) -> usize {
        self.verbs.len()
    }

    /// Bytes it holds.
    pub fn heap_bytes(&self) -> usize {
        self.verbs.capacity() + self.coords.capacity() * 4
    }

    /// The length of its control polygon: at least the length of the curve it draws.
    pub fn polygon_length(&self) -> f64 {
        let mut total = 0.0f64;
        let mut last: Option<(f32, f32)> = None;
        let mut start: Option<(f32, f32)> = None;
        let mut c = self.coords.as_chunks::<2>().0.iter();
        for v in &self.verbs {
            let n = match v {
                0 => {
                    last = c.next().map(|xy| (xy[0], xy[1]));
                    start = last;
                    continue;
                }
                1 => 1,
                2 => 2,
                3 => 3,
                _ => {
                    if let (Some(a), Some(b)) = (last, start) {
                        total += f64::from(a.0 - b.0).hypot(f64::from(a.1 - b.1));
                    }
                    last = start;
                    continue;
                }
            };
            for _ in 0..n {
                if let Some(xy) = c.next() {
                    if let Some(a) = last {
                        total += f64::from(xy[0] - a.0).hypot(f64::from(xy[1] - a.1));
                    }
                    last = Some((xy[0], xy[1]));
                }
            }
        }
        total
    }

    pub fn to_bez(&self) -> BezPath {
        let mut p = BezPath::new();
        let mut c = self
            .coords
            .as_chunks::<2>()
            .0
            .iter()
            .map(|xy| (f64::from(xy[0]), f64::from(xy[1])));
        for v in &self.verbs {
            // The verbs and coordinates were checked together when they arrived.
            let mut next = || c.next().unwrap_or((0.0, 0.0));
            match v {
                0 => p.move_to(next()),
                1 => p.line_to(next()),
                2 => {
                    let a = next();
                    p.quad_to(a, next());
                }
                3 => {
                    let a = next();
                    let b = next();
                    p.curve_to(a, b, next());
                }
                _ => p.close_path(),
            }
        }
        p
    }

    /// The bounds of its control points (they hold the curve).
    pub fn bounds(&self) -> Option<Rect> {
        let mut it = self.coords.as_chunks::<2>().0.iter();
        let first = it.next()?;
        let (mut x0, mut y0) = (first[0], first[1]);
        let (mut x1, mut y1) = (x0, y0);
        for xy in it {
            x0 = x0.min(xy[0]);
            y0 = y0.min(xy[1]);
            x1 = x1.max(xy[0]);
            y1 = y1.max(xy[1]);
        }
        Some(Rect::new(f64::from(x0), f64::from(y0), f64::from(x1), f64::from(y1)))
    }
}

/// One of a record's shapes, referred to by its ops by index.
#[derive(Clone, Debug)]
pub enum PathEntry {
    Path(CompactPath),
    /// A box with corner radii (top left, top right, bottom right, bottom left) and corner
    /// smoothing; generated in Rust so every backend and use draws the same curve.
    Rect {
        w: f32,
        h: f32,
        radii: [f32; 4],
        smoothing: f32,
    },
    Ellipse {
        w: f32,
        h: f32,
    },
    /// Glyphs, each an interned outline in font units (y up), scaled by `scale` and flipped,
    /// placed at (x, y) on its baseline. Each keeps its identity, for the glyph cache.
    Glyphs {
        scale: f32,
        glyphs: Vec<GlyphInstance>,
    },
    /// Everything outside another entry: a huge box with it cut out, filled even-odd. What an
    /// outside stroke is clipped to.
    Outside(u32),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GradientKind {
    Linear,
    Radial,
    Angular,
    Diamond,
}

#[derive(Clone, Debug)]
pub enum Paint {
    Solid(Rgba),
    /// Boxed, as images are: most paints are solid, and a record's ops stay small (a Worker holds
    /// tens of thousands of records under its cap).
    Gradient(Box<GradientPaint>),
    Image(Box<ImagePaint>),
    /// An image still loading: a checkerboard fixed to device pixels, at the image paint's
    /// opacity (as the canvas renderer draws it).
    Placeholder(f32),
}

fn paint_bytes(p: &Paint) -> usize {
    match p {
        Paint::Gradient(g) => size_of::<GradientPaint>() + g.stops.capacity() * size_of::<(f32, Rgba)>(),
        Paint::Image(_) => size_of::<ImagePaint>(),
        _ => 0,
    }
}

/// The unit gradient (linear along x from 0 to 1; radial, angular and diamond around the origin
/// with radius 1) mapped into the layer by `matrix`.
#[derive(Clone, Debug)]
pub struct GradientPaint {
    pub kind: GradientKind,
    pub matrix: Affine,
    pub stops: Vec<(f32, Rgba)>,
}

/// An image: `matrix` maps its unit square into the layer; tiled repeats it.
#[derive(Clone, Debug)]
pub struct ImagePaint {
    pub image: u32,
    pub matrix: Affine,
    pub tile: bool,
    pub opacity: f32,
}

#[derive(Clone, Debug)]
pub struct StrokeStyle {
    pub width: f32,
    pub join: u8,
    pub cap: u8,
    pub miter: f32,
    pub dashes: Vec<f32>,
    pub dash_offset: f32,
}

/// The largest miter limit a stroke is drawn with (decode takes a larger one as this).
pub const MITER_MAX: f32 = 1000.0;

impl StrokeStyle {
    /// How far the stroke's outline can reach from its path, in the record's units, plus a unit
    /// for anti-aliasing: half the width, times the miter limit for mitered joins (a miter's tip
    /// lies at most limit × width / 2 from its corner) and √2 for square caps.
    pub fn reach(&self) -> f64 {
        let half = f64::from(self.width) / 2.0;
        let mut k: f64 = 1.0;
        if self.join == 0 {
            k = k.max(f64::from(self.miter.clamp(1.0, MITER_MAX)));
        }
        if self.cap == 2 {
            k = k.max(std::f64::consts::SQRT_2);
        }
        half * k + 1.0
    }
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
        style: Box<StrokeStyle>,
        paint: Paint,
    },
    Clip {
        path: u32,
        even_odd: bool,
    },
    Unclip,
    /// The record's children are drawn here, inside the clips open at this point.
    Children,
    /// Reads what's drawn beneath (a backdrop reader: glass, background blur), within its
    /// record's extent grown by `halo` device pixels, and paints over it in place.
    Read {
        kernel: u32,
        halo: f32,
    },
}

#[derive(Clone, Debug)]
pub struct Record {
    pub flags: u32,
    pub opacity: f32,
    /// Local units to the parent record's.
    pub transform: Affine,
    /// The layer's box, for the speck rule (layers under half a device pixel are skipped).
    pub size: [f32; 2],
    /// Below this many device pixels per unit, `coarse` is drawn instead of `ops` (text too small
    /// to read, drawn as bars). Zero: never.
    pub coarse_below: f32,
    /// How far, in its units, it may paint past its box (strokes, effects, overhanging type):
    /// with features the engine doesn't draw, this keeps it from being culled while it may show,
    /// so it's refused rather than left out.
    pub reach: f32,
    pub paths: Vec<PathEntry>,
    pub ops: Vec<Op>,
    pub coarse: Vec<Op>,
    /// Features TypeScript found it needs that the engine doesn't draw (a bit set, see
    /// `UNSUPPORTED` in wire.ts). Held to report, never drawn around.
    pub unsupported: u32,
}

impl Record {
    pub fn hidden(&self) -> bool {
        self.flags & FLAG_HIDDEN != 0
    }
    pub fn isolate(&self) -> bool {
        self.flags & FLAG_ISOLATE != 0
    }
    pub fn group(&self) -> bool {
        self.flags & FLAG_GROUP != 0
    }
    pub fn provisional(&self) -> bool {
        self.flags & FLAG_PROVISIONAL != 0
    }
    /// The images its paints draw (by handle), for invalidating what shows them when one changes.
    pub fn images(&self) -> impl Iterator<Item = u32> + '_ {
        self.ops.iter().chain(self.coarse.iter()).filter_map(|op| match op {
            Op::Fill {
                paint: Paint::Image(i), ..
            }
            | Op::Stroke {
                paint: Paint::Image(i), ..
            } => Some(i.image),
            _ => None,
        })
    }
    /// The backdrop readers among its ops: their halos (device pixels).
    pub fn reads(&self) -> Option<f32> {
        self.ops.iter().fold(None, |acc, op| match op {
            Op::Read { halo, .. } => Some(acc.unwrap_or(0.0f32).max(*halo)),
            _ => acc,
        })
    }

    /// Bytes it holds, roughly: what the render graph is held to (`Limits::graph_bytes`).
    pub fn heap_bytes(&self) -> usize {
        let mut b = size_of::<Record>();
        for p in &self.paths {
            b += size_of::<PathEntry>()
                + match p {
                    PathEntry::Path(c) => c.heap_bytes(),
                    PathEntry::Glyphs { glyphs, .. } => glyphs.capacity() * size_of::<GlyphInstance>(),
                    _ => 0,
                };
        }
        for op in self.ops.iter().chain(&self.coarse) {
            b += size_of::<Op>()
                + match op {
                    Op::Stroke { style, paint, .. } => {
                        size_of::<StrokeStyle>() + style.dashes.capacity() * 4 + paint_bytes(paint)
                    }
                    Op::Fill { paint, .. } => paint_bytes(paint),
                    _ => 0,
                };
        }
        b
    }

    /// The length of an entry's outline, at most (a glyph run's isn't known here: None).
    pub fn entry_length(&self, i: u32) -> Option<f64> {
        match self.paths.get(i as usize)? {
            PathEntry::Path(p) => Some(p.polygon_length()),
            // An ellipse's perimeter is shorter than its box's.
            PathEntry::Rect { w, h, .. } | PathEntry::Ellipse { w, h } => {
                Some(2.0 * (f64::from(w.abs()) + f64::from(h.abs())))
            }
            _ => None,
        }
    }

    /// A record that draws nothing (an empty group root).
    pub fn empty() -> Self {
        Self {
            flags: FLAG_GROUP,
            opacity: 1.0,
            transform: Affine::IDENTITY,
            size: [0.0, 0.0],
            coarse_below: 0.0,
            reach: 0.0,
            paths: Vec::new(),
            ops: vec![Op::Children],
            coarse: Vec::new(),
            unsupported: 0,
        }
    }

    /// Where its own ops paint, in its units, before children: the bounds of what it fills and
    /// strokes, each stroke grown by how far its outline can reach from its path
    /// (`StrokeStyle::reach`). Glyph runs need their outlines' bounds: `glyph_bounds` gives them.
    pub fn content_bounds(&self, glyph_bounds: &dyn Fn(u32) -> Option<Rect>) -> Option<Rect> {
        let mut out: Option<Rect> = None;
        let mut add = |r: Rect| out = Some(out.map_or(r, |o| o.union(r)));
        for list in [&self.ops, &self.coarse] {
            for op in list.iter() {
                let (path, grow) = match op {
                    Op::Fill { path, .. } => (*path, 0.0),
                    Op::Stroke { path, style, .. } => (*path, style.reach()),
                    _ => continue,
                };
                if let Some(b) = self.entry_bounds(path, glyph_bounds) {
                    add(b.inflate(grow, grow));
                }
            }
        }
        out
    }

    pub fn entry_bounds(&self, i: u32, glyph_bounds: &dyn Fn(u32) -> Option<Rect>) -> Option<Rect> {
        match self.paths.get(i as usize)? {
            PathEntry::Path(p) => p.bounds(),
            PathEntry::Rect { w, h, .. } | PathEntry::Ellipse { w, h } => {
                Some(Rect::new(0.0, 0.0, f64::from(*w), f64::from(*h)))
            }
            PathEntry::Glyphs { scale, glyphs } => {
                let s = f64::from(*scale);
                let mut out: Option<Rect> = None;
                for g in glyphs {
                    if let Some(b) = glyph_bounds(g.glyph) {
                        let t = Affine::new([s, 0.0, 0.0, -s, f64::from(g.x), f64::from(g.y)]);
                        let r = t.transform_rect_bbox(b);
                        out = Some(out.map_or(r, |o| o.union(r)));
                    }
                }
                out
            }
            // Clipping only; it paints nothing of its own.
            PathEntry::Outside(_) => None,
        }
    }

    /// An entry as a path in the record's units (glyph runs are built by the glyph store).
    pub fn entry_path(&self, i: u32) -> Option<BezPath> {
        match self.paths.get(i as usize)? {
            PathEntry::Path(p) => Some(p.to_bez()),
            PathEntry::Rect { w, h, radii, smoothing } => Some(geometry::rounded_rect(*w, *h, *radii, *smoothing)),
            PathEntry::Ellipse { w, h } => Some(geometry::ellipse(*w, *h)),
            // Built where it's drawn, around the viewport (`exec.rs`).
            PathEntry::Outside(_) | PathEntry::Glyphs { .. } => None,
        }
    }
}

fn paint(r: &mut Reader, limits: &Limits, derived: &mut u32) -> Result<Paint> {
    let kind = r.u32()?;
    let blend = r.u32()?;
    if blend != 0 {
        *derived |= derived::BLEND;
    }
    if kind == 5 {
        *derived |= derived::DIAMOND_GRADIENT;
    }
    Ok(match kind {
        1 => Paint::Solid(r.rgba()?),
        2..=5 => {
            let kind = match kind {
                2 => GradientKind::Linear,
                3 => GradientKind::Radial,
                4 => GradientKind::Angular,
                _ => GradientKind::Diamond,
            };
            let matrix = r.affine()?;
            let n = r.count(limits.stops, "gradient stops", 20)?;
            if n == 0 {
                return Err(EngineError::malformed("a gradient without stops"));
            }
            let mut stops = Vec::with_capacity(n);
            for _ in 0..n {
                let pos = r.f32()?.clamp(0.0, 1.0);
                stops.push((pos, r.rgba()?));
            }
            // As a CanvasGradient orders its stops: by offset, those at one offset in the order
            // they were added.
            stops.sort_by(|a, b| a.0.total_cmp(&b.0));
            Paint::Gradient(Box::new(GradientPaint { kind, matrix, stops }))
        }
        6 => {
            let image = r.u32()?;
            let matrix = r.affine()?;
            let flags = r.u32()?;
            let opacity = r.f32()?.clamp(0.0, 1.0);
            Paint::Image(Box::new(ImagePaint {
                image,
                matrix,
                tile: flags & 1 != 0,
                opacity,
            }))
        }
        7 => Paint::Placeholder(r.f32()?.clamp(0.0, 1.0)),
        k => return Err(EngineError::malformed(format!("unknown paint kind {k}"))),
    })
}

fn stroke_style(r: &mut Reader, limits: &Limits) -> Result<StrokeStyle> {
    let width = r.f32_nonneg()?;
    let join = r.u32()?;
    let cap = r.u32()?;
    if join > 2 || cap > 2 {
        return Err(EngineError::malformed("unknown stroke join or cap"));
    }
    // A limit past `MITER_MAX` is taken as `MITER_MAX`, for drawing and bounds alike: a miter
    // reaches at most limit × width / 2 from its path, so bounds stay finite and true.
    let miter = r.f32_nonneg()?.min(MITER_MAX);
    let n = r.count(limits.dashes, "dashes", 4)?;
    let mut dashes = Vec::with_capacity(n);
    for _ in 0..n {
        dashes.push(r.f32_nonneg()?);
    }
    // A pattern of nothing but gaps (or nothing at all) draws as a solid line, as on a canvas.
    if dashes.iter().all(|d| *d <= 0.0) {
        dashes.clear();
    }
    let dash_offset = r.f32()?;
    Ok(StrokeStyle {
        width,
        join: join as u8,
        cap: cap as u8,
        miter,
        dashes,
        dash_offset,
    })
}

fn ops(r: &mut Reader, limits: &Limits, paths: usize, allow_children: bool, derived: &mut u32) -> Result<Vec<Op>> {
    let n = r.count(limits.record_items, "ops", 4)?;
    let mut out = Vec::with_capacity(n);
    let mut clips = 0usize;
    let mut children = false;
    let path_index = |r: &mut Reader| -> Result<u32> {
        let i = r.u32()?;
        if i as usize >= paths {
            return Err(EngineError::malformed(format!("an op names path {i} of {paths}")));
        }
        Ok(i)
    };
    for _ in 0..n {
        let op = match r.u32()? {
            1 => {
                let path = path_index(r)?;
                let even_odd = r.u32()? == 1;
                Op::Fill {
                    path,
                    even_odd,
                    paint: paint(r, limits, derived)?,
                }
            }
            2 => {
                let path = path_index(r)?;
                let style = Box::new(stroke_style(r, limits)?);
                Op::Stroke {
                    path,
                    style,
                    paint: paint(r, limits, derived)?,
                }
            }
            3 => {
                clips += 1;
                if clips > limits.depth {
                    return Err(EngineError::limit("clips nested too deep"));
                }
                let path = path_index(r)?;
                Op::Clip {
                    path,
                    even_odd: r.u32()? == 1,
                }
            }
            4 => {
                clips = clips
                    .checked_sub(1)
                    .ok_or_else(|| EngineError::malformed("an unclip without a clip"))?;
                Op::Unclip
            }
            5 => {
                if children || !allow_children {
                    return Err(EngineError::malformed("children placed twice, or in coarse ops"));
                }
                children = true;
                Op::Children
            }
            6 => {
                let kernel = r.u32()?;
                let halo = r.f32_nonneg()?;
                if halo > limits.halo as f32 {
                    return Err(EngineError::limit("a backdrop reader reads too far"));
                }
                // Phase 1 draws no backdrop reader outside the tests (glass and background blur
                // are phase 3's): a reader refuses its page.
                if !cfg!(feature = "test-kernels") {
                    *derived |= derived::BACKDROP_READER;
                }
                Op::Read { kernel, halo }
            }
            k => return Err(EngineError::malformed(format!("unknown op {k}"))),
        };
        out.push(op);
    }
    if clips != 0 {
        return Err(EngineError::malformed("clips left open"));
    }
    Ok(out)
}

pub fn decode(r: &mut Reader, limits: &Limits) -> Result<Record> {
    let flags = r.u32()?;
    if flags & !KNOWN_FLAGS != 0 {
        return Err(EngineError::malformed(format!("unknown record flags {flags:#x}")));
    }
    let opacity = r.f32()?.clamp(0.0, 1.0);
    let transform = r.affine()?;
    let size = [r.f32()?, r.f32()?];
    let coarse_below = r.f32_nonneg()?;
    let reach = r.f32_nonneg()?;
    let mut derived = 0u32;
    let unsupported = r.u32()?;
    let n = r.count(limits.record_items, "paths", 8)?;
    let mut paths = Vec::with_capacity(n);
    for i in 0..n {
        paths.push(match r.u32()? {
            1 => PathEntry::Path(CompactPath::from_bez(&r.path(limits.path_verbs)?)),
            2 => {
                let (w, h) = (r.f32()?, r.f32()?);
                let radii = [r.f32_nonneg()?, r.f32_nonneg()?, r.f32_nonneg()?, r.f32_nonneg()?];
                let smoothing = r.f32()?.clamp(0.0, 1.0);
                if smoothing > 0.0 && radii.iter().any(|r| *r > 0.0) {
                    // Squircles come with the shared geometry function (see geometry.rs).
                    derived |= derived::CORNER_SMOOTHING;
                }
                PathEntry::Rect {
                    w,
                    h,
                    radii,
                    smoothing: 0.0,
                }
            }
            3 => PathEntry::Ellipse {
                w: r.f32()?,
                h: r.f32()?,
            },
            4 => {
                let scale = r.f32()?;
                let count = r.count(limits.run_glyphs, "glyphs", 12)?;
                let mut glyphs = Vec::with_capacity(count);
                for _ in 0..count {
                    glyphs.push(GlyphInstance {
                        glyph: r.u32()?,
                        x: r.f32()?,
                        y: r.f32()?,
                    });
                }
                PathEntry::Glyphs { scale, glyphs }
            }
            5 => {
                let of = r.u32()?;
                if of as usize >= i || matches!(paths.get(of as usize), Some(PathEntry::Outside(_))) {
                    return Err(EngineError::malformed("an outside entry must name an earlier shape"));
                }
                PathEntry::Outside(of)
            }
            k => return Err(EngineError::malformed(format!("unknown path kind {k}"))),
        });
    }
    let ops_list = ops(r, limits, paths.len(), true, &mut derived)?;
    let coarse = ops(r, limits, paths.len(), false, &mut derived)?;
    let record = Record {
        flags,
        opacity,
        transform,
        size,
        coarse_below,
        reach,
        paths,
        ops: ops_list,
        coarse,
        unsupported: unsupported | derived,
    };
    if !record.coarse.is_empty() && record.ops.iter().any(|op| matches!(op, Op::Children)) {
        return Err(EngineError::malformed("coarse ops on a record with children"));
    }
    if record.group() && record.ops.iter().any(|op| !matches!(op, Op::Children)) {
        return Err(EngineError::malformed("a group record with paint of its own"));
    }
    for op in record.ops.iter().chain(&record.coarse) {
        if let Op::Stroke { path, style, .. } = op
            && let Some(length) = record.entry_length(*path)
        {
            check_dashes(style, length, limits)?;
        }
    }
    Ok(record)
}

/// Refuses a dash pattern that would cut a stroke `length` long into more pieces than a frame may
/// generate (`Limits::frame_verbs`): a pattern far finer than its path stalls or exhausts a
/// stroker, before any drawing can refuse it.
pub fn check_dashes(style: &StrokeStyle, length: f64, limits: &Limits) -> Result<()> {
    if style.dashes.is_empty() || length <= 0.0 {
        return Ok(());
    }
    let period: f64 = style.dashes.iter().map(|d| f64::from(*d)).sum();
    let pieces = length / period * style.dashes.len() as f64;
    if !pieces.is_finite() || pieces > limits.frame_verbs as f64 {
        return Err(EngineError::limit(format!(
            "a dash pattern repeating every {period:e} units on a stroke {length:.0} units long"
        )));
    }
    Ok(())
}
