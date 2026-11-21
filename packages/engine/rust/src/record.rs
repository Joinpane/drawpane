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
/// Sent ahead of its real drawing (wire 1.1+, text not shaped yet while a page opens): drawn as
/// its coarse ops at every scale, and never exact. Its record is sent again whole soon after.
pub const FLAG_PROVISIONAL: u32 = 8;
/// Export context (wire 1.3+, decision 0039): painted into the backdrop for exported readers,
/// never visible output.
pub const FLAG_CONTEXT: u32 = 16;
/// Has an ordered list of post-effects (`post_effects`) encoded after `coarse`.
pub const FLAG_POST: u32 = 32;
/// Has a non-normal layer blend mode (`1..=17`, minor 1.4) encoded after `post_effects` (or `coarse`).
pub const FLAG_BLEND: u32 = 64;
/// Layer is a mask (`1..=5`, minor 1.4) encoded after `blend` (or `post_effects` / `coarse`).
pub const FLAG_MASK: u32 = 128;
/// Layer ends an active sibling mask scope (visible clipping frame, minor 1.4).
pub const FLAG_ENDS_MASK: u32 = 256;

const FLAGS_V1_0: u32 = FLAG_HIDDEN | FLAG_ISOLATE | FLAG_GROUP;
const FLAGS_V1_1: u32 = FLAGS_V1_0 | FLAG_PROVISIONAL;
const FLAGS_V1_3: u32 = FLAGS_V1_1 | FLAG_CONTEXT;
const FLAGS_V1_4: u32 = FLAGS_V1_3 | FLAG_POST | FLAG_BLEND | FLAG_MASK | FLAG_ENDS_MASK;

fn allowed_flags(minor: u16) -> u32 {
    match minor {
        0 => FLAGS_V1_0,
        1 | 2 => FLAGS_V1_1,
        3 => FLAGS_V1_3,
        _ => FLAGS_V1_4,
    }
}

/// Mask kind values when `FLAG_MASK` is set (matching `MASK` in `wire.ts`).
pub const MASK_OUTLINE_NONZERO: u32 = 1;
pub const MASK_OUTLINE_EVENODD: u32 = 2;
pub const MASK_OUTLINE_PICTURE: u32 = 3;
pub const MASK_ALPHA: u32 = 4;
pub const MASK_LUMINANCE: u32 = 5;

/// Bits of `Record::unsupported` (`UNSUPPORTED` in wire.ts) the engine sets itself, from what it
/// decodes, so anything it would refuse while drawing refuses its page before any drawing, on
/// screen or not, in an export's crop or not, whatever the builder flagged.
pub mod derived {
    pub const BACKDROP_READER: u32 = 1 << 13;
}

/// The diagnostic text fallback bit (wire.ts UNSUPPORTED.textWithoutOutlines).
const TEXT_WITHOUT_OUTLINES: u32 = 1 << 8;

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

/// Canonical primitive geometry extracted from a `PathEntry` for shadow mask caching.
#[derive(Clone, Copy, Debug)]
pub enum CanonicalShadowShape {
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
    /// A positioned rounded box at `(x, y)` of size `w` x `h` (e.g. a spread shadow shape),
    /// preserving uniform corner radii metadata for analytic shadow rendering.
    Box {
        x: f32,
        y: f32,
        w: f32,
        h: f32,
        radii: [f32; 4],
        smoothing: f32,
    },
    /// A positioned ellipse inscribed in `(x, y, w, h)` (e.g. a spread ellipse shadow).
    Oval {
        x: f32,
        y: f32,
        w: f32,
        h: f32,
    },
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ComposeMode {
    SrcOver,
    DestOut,
    DestIn,
}

#[derive(Clone, Debug)]
pub struct GlassOp {
    /// Path entries forming the lens mask (1 entry for shapes; all runs + bars for text).
    pub paths: Vec<u32>,
    pub even_odd: bool,
    /// 0 = box, 1 = ellipse, 2 = other.
    pub kind: u8,
    /// Shape's largest inscribed radius in local units (0.0 means measure from `paths` once).
    pub inradius: f32,
    pub angle: f32,
    pub intensity: f32,
    pub refraction: f32,
    pub depth: f32,
    pub dispersion: f32,
    pub frost: f32,
    pub splay: f32,
    pub box_radii: [f32; 4],
    pub box_smoothing: [f32; 4],
    /// Lazily measured inradius when `inradius == 0.0` (negative means not measured yet).
    pub measured_inradius: std::cell::Cell<f32>,
}

#[derive(Clone, Debug)]
pub struct BackgroundBlurOp {
    pub paths: Vec<u32>,
    pub even_odd: bool,
    pub radius: f32,
}

#[derive(Clone, Debug)]
pub struct ProgressiveBlurOp {
    pub paths: Vec<u32>,
    pub even_odd: bool,
    pub start_radius: f32,
    pub end_radius: f32,
    pub start: [f32; 2],
    pub end: [f32; 2],
}

#[derive(Clone, Debug)]
pub enum Op {
    Fill {
        path: u32,
        even_odd: bool,
        paint: Paint,
        blend: u8,
    },
    Stroke {
        path: u32,
        style: Box<StrokeStyle>,
        paint: Paint,
        blend: u8,
    },
    Clip {
        path: u32,
        even_odd: bool,
    },
    Unclip,
    /// The record's children are drawn here, inside the clips open at this point.
    Children,
    /// Reads what's drawn beneath (test reference kernel 1), within its record's extent grown by
    /// `halo` local units, and paints over it in place.
    Read {
        kernel: u32,
        halo: f32,
    },
    /// Opens an isolated compositing layer (SrcOver, DestOut, DestIn), closed by `Unlayer`.
    Layer {
        compose: ComposeMode,
    },
    Unlayer,
    /// Drop shadow cast from `paths` (one spread shape, an open stroked path, or a text layer's
    /// glyph runs and decoration bars), offset in page units by `(dx, dy)` and blurred with
    /// Figma's calibrated blur sigma. Cut-out rules (decision 0031) are expressed by an enclosing
    /// `Clip(Outside(shape))`.
    DropShadow {
        paths: Vec<u32>,
        even_odd: bool,
        dx: f32,
        dy: f32,
        blur: f32,
        color: Rgba,
        blend: u32,
        stroke: Option<Box<StrokeStyle>>,
    },
    /// Inner shadow clipped to `shape`: the complement of `hole` (`None` when spread shrinks the
    /// hole to empty), offset in page units by `(dx, dy)` and blurred using decision 0013's sigma.
    InnerShadow {
        shape: u32,
        hole: Option<u32>,
        even_odd: bool,
        dx: f32,
        dy: f32,
        blur: f32,
        color: Rgba,
        blend: u32,
    },
    /// Glass lens over the non-glass backdrop (decisions 0007 and 0039).
    Glass(Box<GlassOp>),
    /// Gaussian background blur over the non-glass backdrop (decision 0039).
    BackgroundBlur(Box<BackgroundBlurOp>),
    /// Progressive background blur whose sigma follows a linear gradient across the layer box.
    ProgressiveBlur(Box<ProgressiveBlurOp>),
}

impl Op {
    pub fn is_reader(&self) -> bool {
        matches!(
            self,
            Op::Read { .. } | Op::Glass(_) | Op::BackgroundBlur(_) | Op::ProgressiveBlur(_)
        )
    }
}

/// An ordered post-effect applied to a record's finished picture (fills, strokes, shadows, and
/// children together), matching `packages/editor/src/post-effects.ts`.
#[derive(Clone, Debug)]
pub enum PostEffect {
    /// Gaussian layer blur with Figma `radius` in page units, using decision 0013's sigma.
    LayerBlur { radius: f32 },
    /// Grain noise composited with `source-atop` in layer coordinates (`noise.ts`).
    Noise {
        /// `0` mono, `1` duo, `2` multi.
        noise_type: u32,
        size: f32,
        density: f32,
        color: Rgba,
        secondary_color: Rgba,
        /// Multi-mode opacity in `0..=1`.
        opacity: f32,
    },
    /// Perlin displacement roughening edges and detail in layer coordinates (`texture.ts`).
    Texture {
        size: f32,
        radius: f32,
        clip_to_shape: bool,
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
    /// Ordered post-effects applied to the record's finished picture.
    pub post_effects: Vec<PostEffect>,
    /// Layer blend mode (`0` normal, `1..=17` per `BLEND` in `wire.ts`).
    pub blend: u32,
    /// Mask kind (`0` none, `1..=5` per `MASK` in `wire.ts` when `FLAG_MASK` is set).
    pub mask: u32,
    /// Features TypeScript found it needs that the engine doesn't draw (a bit set, see
    /// `UNSUPPORTED` in wire.ts). Includes bit 8, a diagnostic text fallback note.
    pub unsupported: u32,
}

impl Record {
    /// Features that prevent this record from drawing.
    pub(crate) fn refusing_bits(&self) -> u32 {
        self.unsupported & !TEXT_WITHOUT_OUTLINES
    }
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
    pub fn is_mask(&self) -> bool {
        self.mask != 0
    }
    pub fn is_picture_mask(&self) -> bool {
        self.mask >= MASK_OUTLINE_PICTURE
    }
    pub fn ends_mask(&self) -> bool {
        self.flags & FLAG_ENDS_MASK != 0
    }
    pub fn context(&self) -> bool {
        self.flags & FLAG_CONTEXT != 0
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
    /// The backdrop readers among its ops: their max local-unit halo.
    pub fn reads(&self) -> Option<f32> {
        self.ops.iter().fold(None, |acc, op| match op {
            Op::Read { halo, .. } => Some(acc.unwrap_or(0.0f32).max(*halo)),
            Op::Glass(g) => Some(acc.unwrap_or(0.0f32).max(crate::glass::local_halo(g))),
            Op::BackgroundBlur(b) => Some(
                acc.unwrap_or(0.0f32)
                    .max(crate::blur::blur_reach(crate::blur::sigma_from_radius(b.radius))),
            ),
            Op::ProgressiveBlur(b) => {
                let r = b.start_radius.max(b.end_radius);
                Some(
                    acc.unwrap_or(0.0f32)
                        .max(crate::blur::blur_reach(crate::blur::sigma_from_radius(r))),
                )
            }
            _ => acc,
        })
    }
    /// Whether this record has a glass op (which writes only to output, never to backdrop).
    pub fn has_glass(&self) -> bool {
        self.ops.iter().any(|op| matches!(op, Op::Glass(_)))
    }
    /// Whether this record's backdrop reader writes its result back into the backdrop read by
    /// later readers (`Op::Read`, `BackgroundBlur`, `ProgressiveBlur`, never `Glass`).
    pub fn reader_writes_backdrop(&self) -> bool {
        self.ops
            .iter()
            .any(|op| matches!(op, Op::Read { .. } | Op::BackgroundBlur(_) | Op::ProgressiveBlur(_)))
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
                    Op::DropShadow { paths, stroke, .. } => {
                        paths.capacity() * 4
                            + stroke
                                .as_ref()
                                .map_or(0, |s| size_of::<StrokeStyle>() + s.dashes.capacity() * 4)
                    }
                    Op::Glass(g) => size_of::<GlassOp>() + g.paths.capacity() * 4,
                    Op::BackgroundBlur(bb) => size_of::<BackgroundBlurOp>() + bb.paths.capacity() * 4,
                    Op::ProgressiveBlur(pb) => size_of::<ProgressiveBlurOp>() + pb.paths.capacity() * 4,
                    _ => 0,
                };
        }
        b += self.post_effects.capacity() * size_of::<PostEffect>();
        b
    }

    /// Page-unit reach added by drop shadows (`dx, dy, blur`) outside local geometry bounds.
    pub fn page_pad(&self) -> f64 {
        let mut pad = 0.0f64;
        for op in self.ops.iter().chain(&self.coarse) {
            if let Op::DropShadow { dx, dy, blur, .. } = op {
                let p = f64::from(*dx).abs().max(f64::from(*dy).abs()) + f64::from(*blur) * 1.75 + 2.0;
                pad = pad.max(p);
            }
        }
        pad
    }

    /// Page-unit reach added by post-effects (`layer-blur`, unclipped `texture`) outside the
    /// finished layer picture.
    pub fn post_pad(&self) -> f64 {
        let mut pad = 0.0f64;
        for pe in &self.post_effects {
            match *pe {
                PostEffect::LayerBlur { radius } if radius > 0.0 => {
                    pad += f64::from(radius) * 2.25 + 6.0;
                }
                PostEffect::Texture {
                    size,
                    radius,
                    clip_to_shape: false,
                } if size > 0.0 && radius > 0.0 => {
                    pad += f64::from(radius) + 2.0;
                }
                _ => {}
            }
        }
        pad
    }

    /// Page-unit displacement/blur reach for dirty invalidation of descendants: includes BOTH
    /// clipped and unclipped `texture` displacement radius (changing a child pixel inside a
    /// clipped texture can shift into neighboring pixels up to `radius` away).
    pub fn post_dirty_pad(&self) -> f64 {
        let mut pad = 0.0f64;
        for pe in &self.post_effects {
            match *pe {
                PostEffect::LayerBlur { radius } if radius > 0.0 => {
                    pad += f64::from(radius) * 2.25 + 6.0;
                }
                PostEffect::Texture { size, radius, .. } if size > 0.0 && radius > 0.0 => {
                    pad += f64::from(radius) + 2.0;
                }
                _ => {}
            }
        }
        pad
    }

    /// True if this record itself uses a non-normal blend mode on the layer, a paint, or a shadow.
    pub fn has_own_blend(&self) -> bool {
        self.blend != 0
            || self.ops.iter().chain(&self.coarse).any(|op| match op {
                Op::Fill { blend, .. } | Op::Stroke { blend, .. } => *blend != 0,
                Op::DropShadow { blend, .. } | Op::InnerShadow { blend, .. } => *blend != 0,
                _ => false,
            })
    }

    /// True if this record contains ops, post-effects, or blends that may flush the active Vello
    /// scene (so an enclosing `isolate` opacity scope must use the engine's offscreen target stack
    /// instead of a Vello opacity layer).
    pub fn has_offscreen_pass(&self) -> bool {
        // Normal shadows rasterize their masks separately and draw into the Vello scene.
        // Their temporary buffers never trigger a flush inside a Vello opacity layer.
        !self.post_effects.is_empty()
            || self.has_own_blend()
            || self.is_picture_mask()
            || self.ops.iter().chain(&self.coarse).any(Op::is_reader)
    }

    /// The length of an entry's outline, at most (a glyph run's isn't known here: None).
    pub fn entry_length(&self, i: u32) -> Option<f64> {
        match self.paths.get(i as usize)? {
            PathEntry::Path(p) => Some(p.polygon_length()),
            // An ellipse's perimeter is shorter than its box's.
            PathEntry::Rect { w, h, .. }
            | PathEntry::Ellipse { w, h }
            | PathEntry::Box { w, h, .. }
            | PathEntry::Oval { w, h, .. } => Some(2.0 * (f64::from(w.abs()) + f64::from(h.abs()))),
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
            post_effects: Vec::new(),
            blend: 0,
            mask: 0,
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
                match op {
                    Op::Fill { path, .. } => {
                        if let Some(b) = self.entry_bounds(*path, glyph_bounds) {
                            add(b);
                        }
                    }
                    Op::Stroke { path, style, .. } => {
                        let grow = style.reach();
                        if let Some(b) = self.entry_bounds(*path, glyph_bounds) {
                            add(b.inflate(grow, grow));
                        }
                    }
                    Op::DropShadow { paths, stroke, .. } => {
                        let grow = stroke.as_ref().map_or(0.0, |s| s.reach());
                        for p in paths {
                            if let Some(b) = self.entry_bounds(*p, glyph_bounds) {
                                add(if grow > 0.0 { b.inflate(grow, grow) } else { b });
                            }
                        }
                    }
                    Op::InnerShadow { shape, .. } => {
                        if let Some(b) = self.entry_bounds(*shape, glyph_bounds) {
                            add(b);
                        }
                    }
                    Op::Glass(g) => {
                        for &path in &g.paths {
                            if let Some(b) = self.entry_bounds(path, glyph_bounds) {
                                add(b);
                            }
                        }
                    }
                    Op::BackgroundBlur(bb) => {
                        for &path in &bb.paths {
                            if let Some(b) = self.entry_bounds(path, glyph_bounds) {
                                add(b);
                            }
                        }
                    }
                    Op::ProgressiveBlur(pb) => {
                        for &path in &pb.paths {
                            if let Some(b) = self.entry_bounds(path, glyph_bounds) {
                                add(b);
                            }
                        }
                    }
                    _ => {}
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
            PathEntry::Box { x, y, w, h, .. } | PathEntry::Oval { x, y, w, h } => Some(Rect::new(
                f64::from(*x),
                f64::from(*y),
                f64::from(*x + *w),
                f64::from(*y + *h),
            )),
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

    /// If path entry `i` is an unsmoothed rounded box or ellipse with positive size, returns its
    /// canonical primitive geometry (for shadow mask caching).
    pub fn entry_canonical_shape(&self, i: u32) -> Option<CanonicalShadowShape> {
        match self.paths.get(i as usize)? {
            PathEntry::Rect { w, h, radii, smoothing } if *smoothing == 0.0 && *w > 0.0 && *h > 0.0 => {
                let f = geometry::fit_radii(f64::from(*w), f64::from(*h), radii.map(f64::from));
                Some(CanonicalShadowShape::Box {
                    x: 0.0,
                    y: 0.0,
                    w: *w,
                    h: *h,
                    radii: f.map(|v| v as f32),
                })
            }
            PathEntry::Box {
                x,
                y,
                w,
                h,
                radii,
                smoothing,
            } if *smoothing == 0.0 && *w > 0.0 && *h > 0.0 => {
                let f = geometry::fit_radii(f64::from(*w), f64::from(*h), radii.map(f64::from));
                Some(CanonicalShadowShape::Box {
                    x: *x,
                    y: *y,
                    w: *w,
                    h: *h,
                    radii: f.map(|v| v as f32),
                })
            }
            PathEntry::Ellipse { w, h } if *w > 0.0 && *h > 0.0 => Some(CanonicalShadowShape::Oval {
                x: 0.0,
                y: 0.0,
                w: *w,
                h: *h,
            }),
            PathEntry::Oval { x, y, w, h } if *w > 0.0 && *h > 0.0 => Some(CanonicalShadowShape::Oval {
                x: *x,
                y: *y,
                w: *w,
                h: *h,
            }),
            _ => None,
        }
    }

    /// If path entry `i` is an unsmoothed uniform-radius rounded rectangle with positive size,
    /// returns its local `Rect` and fitted corner radius (for analytic box shadow rendering).
    pub fn entry_uniform_rect(&self, i: u32) -> Option<(Rect, f32)> {
        let (x, y, w, h, radii, smoothing) = match self.paths.get(i as usize)? {
            PathEntry::Rect { w, h, radii, smoothing } => (0.0f32, 0.0f32, *w, *h, *radii, *smoothing),
            PathEntry::Box {
                x,
                y,
                w,
                h,
                radii,
                smoothing,
            } => (*x, *y, *w, *h, *radii, *smoothing),
            _ => return None,
        };
        if smoothing != 0.0 || w <= 0.0 || h <= 0.0 {
            return None;
        }
        let fitted = geometry::fit_radii(f64::from(w), f64::from(h), radii.map(f64::from));
        let r0 = fitted[0];
        if fitted.iter().all(|&r| (r - r0).abs() <= 1e-4) {
            Some((
                Rect::new(f64::from(x), f64::from(y), f64::from(x + w), f64::from(y + h)),
                r0 as f32,
            ))
        } else {
            None
        }
    }

    /// An entry as a path in the record's units (glyph runs are built by the glyph store).
    pub fn entry_path(&self, i: u32, device: Affine) -> Option<BezPath> {
        match self.paths.get(i as usize)? {
            PathEntry::Path(p) => Some(p.to_bez()),
            PathEntry::Rect { w, h, radii, smoothing } => Some(geometry::rounded_rect(*w, *h, *radii, *smoothing)),
            PathEntry::Ellipse { w, h } => Some(geometry::ellipse(*w, *h, device)),
            PathEntry::Box {
                x,
                y,
                w,
                h,
                radii,
                smoothing,
            } => {
                let mut p = geometry::rounded_rect(*w, *h, *radii, *smoothing);
                if *x != 0.0 || *y != 0.0 {
                    p.apply_affine(Affine::translate((f64::from(*x), f64::from(*y))));
                }
                Some(p)
            }
            PathEntry::Oval { x, y, w, h } => {
                let mut p = geometry::ellipse(*w, *h, device);
                if *x != 0.0 || *y != 0.0 {
                    p.apply_affine(Affine::translate((f64::from(*x), f64::from(*y))));
                }
                Some(p)
            }
            // Built where it's drawn, around the viewport (`exec.rs`).
            PathEntry::Outside(_) | PathEntry::Glyphs { .. } => None,
        }
    }
}

fn paint(r: &mut Reader, limits: &Limits, minor: u16) -> Result<(Paint, u8)> {
    let kind = r.u32()?;
    let blend = r.u32()?;
    if blend > 17 {
        return Err(EngineError::malformed(format!("unknown paint blend mode {blend}")));
    }
    if blend != 0 && minor < 4 {
        return Err(EngineError::malformed("paint blend mode requires display list 1.4"));
    }
    let paint = match kind {
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
    };
    Ok((paint, blend as u8))
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

fn ops(
    r: &mut Reader,
    limits: &Limits,
    paths: usize,
    allow_children: bool,
    derived: &mut u32,
    minor: u16,
) -> Result<Vec<Op>> {
    let n = r.count(limits.record_items, "ops", 4)?;
    let mut out = Vec::with_capacity(n);
    // Strict LIFO scope stack: true = clip, false = layer, so clips and layers never interleave.
    let mut scopes: Vec<bool> = Vec::new();
    let mut children = false;
    let path_index = |r: &mut Reader| -> Result<u32> {
        let i = r.u32()?;
        if i as usize >= paths {
            return Err(EngineError::malformed(format!("an op names path {i} of {paths}")));
        }
        Ok(i)
    };
    for _ in 0..n {
        let code = r.u32()?;
        let op = match code {
            1 => {
                let path = path_index(r)?;
                let even_odd = r.u32()? == 1;
                let (paint, blend) = paint(r, limits, minor)?;
                Op::Fill {
                    path,
                    even_odd,
                    paint,
                    blend,
                }
            }
            2 => {
                let path = path_index(r)?;
                let style = Box::new(stroke_style(r, limits)?);
                let (paint, blend) = paint(r, limits, minor)?;
                Op::Stroke {
                    path,
                    style,
                    paint,
                    blend,
                }
            }
            3 => {
                if scopes.len() >= limits.depth {
                    return Err(EngineError::limit("clips and layers nested too deep"));
                }
                scopes.push(true);
                let path = path_index(r)?;
                Op::Clip {
                    path,
                    even_odd: r.u32()? == 1,
                }
            }
            4 => {
                if scopes.pop() != Some(true) {
                    return Err(EngineError::malformed("an unclip without a matching clip"));
                }
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
                // Test-only reference kernel: refused outside `test-kernels`.
                if !cfg!(feature = "test-kernels") || kernel != crate::kernels::KERNEL_BOX_MEAN {
                    *derived |= derived::BACKDROP_READER;
                }
                Op::Read { kernel, halo }
            }
            7 => {
                if minor < 2 {
                    return Err(EngineError::new(
                        crate::error::ErrorCode::Version,
                        format!("layer op requires display list 1.2 (header is 1.{minor})"),
                    ));
                }
                if scopes.len() >= limits.depth {
                    return Err(EngineError::limit("clips and layers nested too deep"));
                }
                scopes.push(false);
                let compose = match r.u32()? {
                    0 => ComposeMode::SrcOver,
                    1 => ComposeMode::DestOut,
                    2 => ComposeMode::DestIn,
                    k => return Err(EngineError::malformed(format!("unknown layer compose {k}"))),
                };
                Op::Layer { compose }
            }
            8 => {
                if minor < 2 {
                    return Err(EngineError::new(
                        crate::error::ErrorCode::Version,
                        format!("unlayer op requires display list 1.2 (header is 1.{minor})"),
                    ));
                }
                if scopes.pop() != Some(false) {
                    return Err(EngineError::malformed("an unlayer without a matching layer"));
                }
                Op::Unlayer
            }
            9 => {
                if minor < 3 {
                    return Err(EngineError::new(
                        crate::error::ErrorCode::Version,
                        format!("glass op (9) requires display list 1.3, got 1.{minor}"),
                    ));
                }
                let count = r.count(limits.record_items, "glass paths", 4)?;
                if count == 0 {
                    return Err(EngineError::malformed("glass op with no paths"));
                }
                let mut gpaths = Vec::with_capacity(count);
                for _ in 0..count {
                    gpaths.push(path_index(r)?);
                }
                let even_odd = r.u32()? == 1;
                let kind = r.u32()?;
                if kind > 2 {
                    return Err(EngineError::malformed(format!("unknown glass kind {kind}")));
                }
                let inradius = r.f32_nonneg()?;
                let angle = r.f32()?;
                let intensity = r.f32()?.clamp(0.0, 100.0);
                let refraction = r.f32()?.clamp(0.0, 100.0);
                let depth = r.f32()?.clamp(0.0, 100.0);
                let dispersion = r.f32()?.clamp(0.0, 100.0);
                let frost = r.f32()?.clamp(0.0, 100.0);
                let splay = r.f32()?.clamp(0.0, 100.0);
                let box_radii = [r.f32_nonneg()?, r.f32_nonneg()?, r.f32_nonneg()?, r.f32_nonneg()?];
                let box_smoothing = [
                    r.f32()?.clamp(0.0, 1.0),
                    r.f32()?.clamp(0.0, 1.0),
                    r.f32()?.clamp(0.0, 1.0),
                    r.f32()?.clamp(0.0, 1.0),
                ];
                Op::Glass(Box::new(GlassOp {
                    paths: gpaths,
                    even_odd,
                    kind: kind as u8,
                    inradius,
                    angle,
                    intensity,
                    refraction,
                    depth,
                    dispersion,
                    frost,
                    splay,
                    box_radii,
                    box_smoothing,
                    measured_inradius: std::cell::Cell::new(-1.0),
                }))
            }
            10 => {
                if minor < 3 {
                    return Err(EngineError::new(
                        crate::error::ErrorCode::Version,
                        format!("backgroundBlur op (10) requires display list 1.3, got 1.{minor}"),
                    ));
                }
                let count = r.count(limits.record_items, "background-blur paths", 4)?;
                if count == 0 {
                    return Err(EngineError::malformed("background-blur op with no paths"));
                }
                let mut bpaths = Vec::with_capacity(count);
                for _ in 0..count {
                    bpaths.push(path_index(r)?);
                }
                let even_odd = r.u32()? == 1;
                let radius = r.f32_nonneg()?;
                Op::BackgroundBlur(Box::new(BackgroundBlurOp {
                    paths: bpaths,
                    even_odd,
                    radius,
                }))
            }
            11 => {
                if minor < 3 {
                    return Err(EngineError::new(
                        crate::error::ErrorCode::Version,
                        format!("progressiveBlur op (11) requires display list 1.3, got 1.{minor}"),
                    ));
                }
                let count = r.count(limits.record_items, "progressive-blur paths", 4)?;
                if count == 0 {
                    return Err(EngineError::malformed("progressive-blur op with no paths"));
                }
                let mut bpaths = Vec::with_capacity(count);
                for _ in 0..count {
                    bpaths.push(path_index(r)?);
                }
                let even_odd = r.u32()? == 1;
                let start_radius = r.f32_nonneg()?;
                let end_radius = r.f32_nonneg()?;
                let start = [r.f32()?, r.f32()?];
                let end = [r.f32()?, r.f32()?];
                Op::ProgressiveBlur(Box::new(ProgressiveBlurOp {
                    paths: bpaths,
                    even_odd,
                    start_radius,
                    end_radius,
                    start,
                    end,
                }))
            }
            13 => {
                if minor < 4 {
                    return Err(EngineError::new(
                        crate::error::ErrorCode::Version,
                        "drop shadow op requires display list 1.4",
                    ));
                }
                let count = r.count(limits.record_items, "shadow paths", 4)?;
                let mut shadow_paths = Vec::with_capacity(count);
                for _ in 0..count {
                    shadow_paths.push(path_index(r)?);
                }
                let shadow_flags = r.u32()?;
                if shadow_flags & !3 != 0 {
                    return Err(EngineError::malformed(format!(
                        "unknown drop shadow flags {shadow_flags:#x}"
                    )));
                }
                let even_odd = shadow_flags & 1 != 0;
                let has_stroke = shadow_flags & 2 != 0;
                let dx = r.f32()?;
                let dy = r.f32()?;
                let blur = r.f32_nonneg()?;
                let color = r.rgba()?;
                let blend = r.u32()?;
                if blend > 17 {
                    return Err(EngineError::malformed(format!("unknown shadow blend mode {blend}")));
                }
                let stroke = if has_stroke {
                    Some(Box::new(stroke_style(r, limits)?))
                } else {
                    None
                };
                Op::DropShadow {
                    paths: shadow_paths,
                    even_odd,
                    dx,
                    dy,
                    blur,
                    color,
                    blend,
                    stroke,
                }
            }
            14 => {
                if minor < 4 {
                    return Err(EngineError::new(
                        crate::error::ErrorCode::Version,
                        "inner shadow op requires display list 1.4",
                    ));
                }
                let shape = path_index(r)?;
                let hole_raw = r.u32()?;
                let hole = if hole_raw == u32::MAX {
                    None
                } else {
                    if hole_raw as usize >= paths {
                        return Err(EngineError::malformed(format!(
                            "an op names path {hole_raw} of {paths}"
                        )));
                    }
                    Some(hole_raw)
                };
                let even_odd = r.u32()? == 1;
                let dx = r.f32()?;
                let dy = r.f32()?;
                let blur = r.f32_nonneg()?;
                let color = r.rgba()?;
                let blend = r.u32()?;
                if blend > 17 {
                    return Err(EngineError::malformed(format!("unknown shadow blend mode {blend}")));
                }
                Op::InnerShadow {
                    shape,
                    hole,
                    even_odd,
                    dx,
                    dy,
                    blur,
                    color,
                    blend,
                }
            }
            k => return Err(EngineError::malformed(format!("unknown op {k}"))),
        };
        out.push(op);
    }
    if !scopes.is_empty() {
        return Err(EngineError::malformed("clips or layers left open"));
    }
    Ok(out)
}

pub fn decode(r: &mut Reader, limits: &Limits, minor: u16) -> Result<Record> {
    let flags = r.u32()?;
    if flags & !FLAGS_V1_4 != 0 {
        return Err(EngineError::malformed(format!("unknown record flags {flags:#x}")));
    }
    if flags & !allowed_flags(minor) != 0 {
        return Err(EngineError::new(
            crate::error::ErrorCode::Version,
            format!("record flags {flags:#x} require a newer display list than 1.{minor}"),
        ));
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
                PathEntry::Rect { w, h, radii, smoothing }
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
            6 => {
                if minor < 4 {
                    return Err(EngineError::malformed("box path kind requires display list 1.4"));
                }
                let (x, y, w, h) = (r.f32()?, r.f32()?, r.f32()?, r.f32()?);
                let radii = [r.f32_nonneg()?, r.f32_nonneg()?, r.f32_nonneg()?, r.f32_nonneg()?];
                let smoothing = r.f32()?.clamp(0.0, 1.0);
                PathEntry::Box {
                    x,
                    y,
                    w,
                    h,
                    radii,
                    smoothing,
                }
            }
            7 => {
                if minor < 4 {
                    return Err(EngineError::malformed("oval path kind requires display list 1.4"));
                }
                PathEntry::Oval {
                    x: r.f32()?,
                    y: r.f32()?,
                    w: r.f32()?,
                    h: r.f32()?,
                }
            }
            k => return Err(EngineError::malformed(format!("unknown path kind {k}"))),
        });
    }
    let ops_list = ops(r, limits, paths.len(), true, &mut derived, minor)?;
    let coarse = ops(r, limits, paths.len(), false, &mut derived, minor)?;
    let mut post_effects = Vec::new();
    if flags & FLAG_POST != 0 {
        let count = r.count(limits.record_items, "post effects", 4)?;
        post_effects.reserve(count);
        for _ in 0..count {
            match r.u32()? {
                1 => {
                    let radius = r.f32_nonneg()?;
                    post_effects.push(PostEffect::LayerBlur { radius });
                }
                2 => {
                    let noise_type = r.u32()?;
                    if noise_type > 2 {
                        return Err(EngineError::malformed(format!("unknown noise type {noise_type}")));
                    }
                    let size = r.f32_nonneg()?;
                    let density = r.f32_nonneg()?.min(100.0);
                    let color = r.rgba()?;
                    let secondary_color = r.rgba()?;
                    let opacity = r.f32()?.clamp(0.0, 1.0);
                    post_effects.push(PostEffect::Noise {
                        noise_type,
                        size,
                        density,
                        color,
                        secondary_color,
                        opacity,
                    });
                }
                3 => {
                    let size = r.f32_nonneg()?;
                    let radius = r.f32_nonneg()?;
                    // Match the editor's effect schema before coordinates reach the shaders.
                    if !(0.5..=50.0).contains(&size) || radius > 100.0 {
                        return Err(EngineError::limit("texture size or radius exceeds the wire range"));
                    }
                    let clip_u32 = r.u32()?;
                    if clip_u32 > 1 {
                        return Err(EngineError::malformed(format!("invalid texture clip flag {clip_u32}")));
                    }
                    post_effects.push(PostEffect::Texture {
                        size,
                        radius,
                        clip_to_shape: clip_u32 != 0,
                    });
                }
                k => return Err(EngineError::malformed(format!("unknown post effect kind {k}"))),
            }
        }
    }
    let blend = if flags & FLAG_BLEND != 0 {
        let mode = r.u32()?;
        if mode > 17 {
            return Err(EngineError::malformed(format!("unknown layer blend mode {mode}")));
        }
        mode
    } else {
        0
    };
    let mask = if flags & FLAG_MASK != 0 {
        let kind = r.u32()?;
        if !(MASK_OUTLINE_NONZERO..=MASK_LUMINANCE).contains(&kind) {
            return Err(EngineError::malformed(format!("unknown mask kind {kind}")));
        }
        if matches!(kind, MASK_OUTLINE_NONZERO | MASK_OUTLINE_EVENODD) && paths.is_empty() {
            return Err(EngineError::malformed("outline shape mask has no shape path"));
        }
        kind
    } else {
        0
    };
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
        post_effects,
        blend,
        mask,
        unsupported: unsupported | derived,
    };
    if !record.coarse.is_empty() && record.ops.iter().any(|op| matches!(op, Op::Children)) {
        return Err(EngineError::malformed("coarse ops on a record with children"));
    }
    if record.group() && record.ops.iter().any(|op| !matches!(op, Op::Children)) {
        return Err(EngineError::malformed("a group record with paint of its own"));
    }
    for op in record.ops.iter().chain(&record.coarse) {
        match op {
            Op::Stroke { path, style, .. } => {
                if let Some(length) = record.entry_length(*path) {
                    check_dashes(style, length, limits)?;
                }
            }
            Op::DropShadow {
                paths: sp,
                stroke: Some(style),
                ..
            } => {
                for p in sp {
                    if let Some(length) = record.entry_length(*p) {
                        check_dashes(style, length, limits)?;
                    }
                }
            }
            _ => {}
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
