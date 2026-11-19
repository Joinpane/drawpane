//! Draws the render graph on a backend. The same code drives both: Vello's CPU and GPU scenes
//! take the same drawing calls, and what differs (where images and glyph masks live, how a
//! backdrop reader gets the pixels beneath it) is the `Backend` trait.
//!
//! The canvas renderer is the specification (`packages/editor/src/render.ts`): a record is
//! drawn in its parent's transform and opacity; a record that fades as one is an isolating
//! opacity group; otherwise opacity multiplies down into its paints and children. Clips are
//! clip paths, which don't isolate. Culling uses the engine's own subtree bounds.

use crate::error::{EngineError, Result};
use crate::geometry;
use crate::limits::Limits;
use crate::masks::{MaskKey, PHASES};
use crate::record::{GradientKind, Op, Paint, PathEntry, Record, Rgba, StrokeStyle};
use crate::store::Store;
use vello_common::color::{AlphaColor, Srgb};
use vello_common::kurbo::{Affine, BezPath, Cap, Join, Rect, Stroke};
use vello_common::paint::{Image, ImageSource, PaintType, Tint, TintMode};
use vello_common::peniko::{
    BlendMode, ColorStop, ColorStops, Compose, Extend, Fill, Gradient, ImageQuality, ImageSampler,
    InterpolationAlphaSpace, Mix,
};

/// What Vello's two scene types share, as the executor uses it.
pub trait Draw {
    fn set_transform(&mut self, t: Affine);
    fn set_paint(&mut self, p: PaintType);
    fn set_paint_transform(&mut self, t: Affine);
    fn reset_paint_transform(&mut self);
    fn set_tint(&mut self, t: Option<Tint>);
    fn set_fill_rule(&mut self, rule: Fill);
    fn set_stroke(&mut self, s: Stroke);
    fn fill_path(&mut self, p: &BezPath);
    fn fill_rect(&mut self, r: &Rect);
    fn stroke_path(&mut self, p: &BezPath);
    fn push_clip_path(&mut self, p: &BezPath);
    fn pop_clip(&mut self);
    fn push_opacity(&mut self, opacity: f32);
    fn pop_layer(&mut self);
}

macro_rules! impl_draw {
    ($t:ty) => {
        impl crate::exec::Draw for $t {
            fn set_transform(&mut self, t: vello_common::kurbo::Affine) {
                <$t>::set_transform(self, t);
            }
            fn set_paint(&mut self, p: vello_common::paint::PaintType) {
                <$t>::set_paint(self, p);
            }
            fn set_paint_transform(&mut self, t: vello_common::kurbo::Affine) {
                <$t>::set_paint_transform(self, t);
            }
            fn reset_paint_transform(&mut self) {
                <$t>::reset_paint_transform(self);
            }
            fn set_tint(&mut self, t: Option<vello_common::paint::Tint>) {
                <$t>::set_tint(self, t);
            }
            fn set_fill_rule(&mut self, rule: vello_common::peniko::Fill) {
                <$t>::set_fill_rule(self, rule);
            }
            fn set_stroke(&mut self, s: vello_common::kurbo::Stroke) {
                <$t>::set_stroke(self, s);
            }
            fn fill_path(&mut self, p: &vello_common::kurbo::BezPath) {
                <$t>::fill_path(self, p);
            }
            fn fill_rect(&mut self, r: &vello_common::kurbo::Rect) {
                <$t>::fill_rect(self, r);
            }
            fn stroke_path(&mut self, p: &vello_common::kurbo::BezPath) {
                <$t>::stroke_path(self, p);
            }
            fn push_clip_path(&mut self, p: &vello_common::kurbo::BezPath) {
                <$t>::push_clip_path(self, p);
            }
            fn pop_clip(&mut self) {
                <$t>::pop_clip(self);
            }
            fn push_opacity(&mut self, opacity: f32) {
                <$t>::push_layer(self, None, None, Some(opacity), None, None);
            }
            fn pop_layer(&mut self) {
                <$t>::pop_layer(self);
            }
        }
    };
}
pub(crate) use impl_draw;

/// A glyph's mask: its source, its top left from the glyph's whole-pixel anchor, and its size.
pub type GlyphMask = (ImageSource, (i32, i32), (u16, u16));

/// An image level a backend holds, to paint from.
pub struct ImageView {
    pub source: ImageSource,
    pub width: u32,
    pub height: u32,
}

/// Something open in the scene where a backdrop reader runs, so a backend that renders what's
/// drawn so far can reopen it after.
#[derive(Clone)]
pub enum Open {
    Clip {
        transform: Affine,
        path: BezPath,
        even_odd: bool,
    },
    Layer,
}

/// A rectangle of device pixels.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct IRect {
    pub x0: i32,
    pub y0: i32,
    pub x1: i32,
    pub y1: i32,
}

impl IRect {
    pub fn around(r: Rect) -> Self {
        let c = |v: f64| v.clamp(-1.0e7, 1.0e7);
        Self {
            x0: c(r.x0.floor()) as i32,
            y0: c(r.y0.floor()) as i32,
            x1: c(r.x1.ceil()) as i32,
            y1: c(r.y1.ceil()) as i32,
        }
    }
    pub fn clamp(self, w: i32, h: i32) -> Self {
        Self {
            x0: self.x0.clamp(0, w),
            y0: self.y0.clamp(0, h),
            x1: self.x1.clamp(0, w),
            y1: self.y1.clamp(0, h),
        }
    }
    pub fn is_empty(&self) -> bool {
        self.x1 <= self.x0 || self.y1 <= self.y0
    }
}

pub trait Backend {
    type Scene: Draw;
    fn scene(&mut self) -> &mut Self::Scene;
    /// An image's level at least `px` device pixels wide (or its largest).
    fn image(&mut self, id: u32, px: f64) -> Option<ImageView>;
    /// The loading checkerboard, 16 × 16 device pixels, repeated.
    fn checker(&mut self) -> ImageSource;
    /// A glyph's coverage mask, made if it isn't held and fits: its source, its top left from
    /// the glyph's whole-pixel anchor, and its size.
    fn glyph_mask(&mut self, key: MaskKey, path: &BezPath, scale: (f64, f64), phase: (f64, f64)) -> Option<GlyphMask>;
    /// Runs a backdrop reader over what's drawn so far (`open` is open in the scene).
    fn read(&mut self, kernel: u32, paints: IRect, reads: IRect, open: &[Open]) -> Result<()>;
}

/// The frame being drawn: its size, the page-to-device transform, and whether screen-only
/// levels of detail apply (specks skipped, unreadable text as bars; never for exports).
#[derive(Clone, Copy, Debug)]
pub struct Frame {
    pub width: u16,
    pub height: u16,
    pub view: Affine,
    pub detail: bool,
    /// The device pixels drawn (a tile of the frame: x0, y0, x1, y1): records outside are culled.
    pub area: IRect,
}

#[derive(Default, Clone, Copy, Debug)]
pub struct DrawStats {
    pub records: u32,
    pub culled: u32,
    pub ops: u32,
    pub glyphs_masked: u32,
    pub glyphs_outlined: u32,
    pub reads: u32,
    /// Records drawn by their coarse ops (unreadable text as bars): a stand-in, not exact.
    pub coarse: u32,
    /// Records skipped as specks (under half a device pixel): a stand-in, not exact.
    pub specks: u32,
    /// Path elements generated drawing the frame (held to `Limits::frame_verbs`).
    pub verbs: u64,
    /// The frame reached the canvas (GPU, presenting): false when the canvas couldn't take it
    /// now (a timeout, an occluded window), so the caller shows its last picture or another.
    pub presented: bool,
    /// Something on screen stands in for what isn't drawn yet (a stale tile, another level
    /// scaled, the last frame moved): not exact.
    pub standin: bool,
    /// How a frame made of tiles was made (GPU): 0 from its own tiles, all there; 1 with
    /// stand-ins under what isn't drawn yet; 2 drawn direct (its tiles don't fit the budget);
    /// 3 unchanged.
    pub plan: u32,
    /// A frame made of tiles: every tile shown up to date and drawn without level of detail,
    /// so it's what a fresh engine draws.
    pub exact: bool,
    /// Tiles drawn this frame, tiles the frame shows still stale or missing, tiles held, and
    /// tiles evicted to make room.
    pub tiles_drawn: u32,
    pub pending: u32,
    /// Tiles round the view still to draw ahead of a pan (idle frames may draw them).
    pub queued: u32,
    pub held: u32,
    pub evicted: u32,
    /// The frame's tiles didn't fit the budget: drawn one at a time straight into the frame.
    pub direct: bool,
    /// Where its CPU time went (GPU, milliseconds): encoding the scene (the walk and Vello's
    /// strips), the renderer's preparing and uploading, presenting and submitting, and all.
    pub encode_ms: f64,
    pub render_ms: f64,
    pub submit_ms: f64,
    pub cpu_ms: f64,
}

impl DrawStats {
    /// Adds another pass's counts (a pan's strips).
    pub fn add(&mut self, o: &DrawStats) {
        self.records += o.records;
        self.culled += o.culled;
        self.ops += o.ops;
        self.glyphs_masked += o.glyphs_masked;
        self.glyphs_outlined += o.glyphs_outlined;
        self.reads += o.reads;
        self.coarse += o.coarse;
        self.specks += o.specks;
        self.verbs += o.verbs;
    }

    /// Whether the frame drew every record exactly (no level-of-detail stand-ins).
    pub fn exact(&self) -> bool {
        self.coarse == 0 && self.specks == 0
    }
}

pub fn draw<B: Backend>(store: &Store, backend: &mut B, frame: &Frame, limits: &Limits) -> Result<DrawStats> {
    let mut budget = limits.frame_verbs;
    draw_budgeted(store, backend, frame, limits, &mut budget)
}

/// `draw`, charging what it generates to `budget` (path elements left), which several passes of
/// one frame share (a pan's strips): what's left is written back.
pub fn draw_budgeted<B: Backend>(
    store: &Store,
    backend: &mut B,
    frame: &Frame,
    limits: &Limits,
    budget: &mut usize,
) -> Result<DrawStats> {
    let mut walk = Walk {
        store,
        backend,
        frame: *frame,
        viewport: Rect::new(
            f64::from(frame.area.x0) - 1.0,
            f64::from(frame.area.y0) - 1.0,
            f64::from(frame.area.x1) + 1.0,
            f64::from(frame.area.y1) + 1.0,
        ),
        open: Vec::new(),
        stats: DrawStats::default(),
        glyph_mask_side: f64::from(limits.glyph_mask_side),
        verbs_left: *budget,
        open_scopes: limits.open_scopes,
    };
    let root = store
        .nodes
        .get(&crate::store::ROOT)
        .ok_or_else(|| EngineError::malformed("no page"))?;
    let result = (|| {
        for c in &root.children {
            walk.node(*c, Affine::IDENTITY, 1.0)?;
        }
        Ok(())
    })();
    *budget = walk.verbs_left;
    // Whatever failed part way, close what's open so the scene stays usable.
    while let Some(o) = walk.open.pop() {
        match o {
            Open::Clip { .. } => walk.backend.scene().pop_clip(),
            Open::Layer => walk.backend.scene().pop_layer(),
        }
    }
    result.map(|()| walk.stats)
}

struct Walk<'a, B: Backend> {
    store: &'a Store,
    backend: &'a mut B,
    frame: Frame,
    viewport: Rect,
    open: Vec<Open>,
    stats: DrawStats,
    glyph_mask_side: f64,
    /// Path elements the frame may still generate.
    verbs_left: usize,
    open_scopes: usize,
}

fn finite(m: Affine) -> bool {
    m.as_coeffs().iter().all(|v| v.is_finite())
}

/// The length of a path's control polygon: at least the length of the curve it draws.
fn polygon_length(p: &BezPath) -> f64 {
    use vello_common::kurbo::PathEl;
    let mut total = 0.0;
    let mut last = vello_common::kurbo::Point::ZERO;
    let mut start = last;
    for el in p.elements() {
        let pts: &[vello_common::kurbo::Point] = match el {
            PathEl::MoveTo(a) => {
                last = *a;
                start = *a;
                continue;
            }
            PathEl::LineTo(a) => &[*a],
            PathEl::QuadTo(a, b) => &[*a, *b],
            PathEl::CurveTo(a, b, c) => &[*a, *b, *c],
            PathEl::ClosePath => &[start],
        };
        for q in pts {
            total += last.distance(*q);
            last = *q;
        }
    }
    total
}

fn overlaps(a: Rect, b: Rect) -> bool {
    a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1
}

/// Device pixels per unit under `m`.
fn scale_of(m: Affine) -> f64 {
    m.determinant().abs().sqrt()
}

fn color(c: Rgba, alpha: f32) -> AlphaColor<Srgb> {
    AlphaColor::new([c[0], c[1], c[2], c[3] * alpha])
}

impl<B: Backend> Walk<'_, B> {
    fn node(&mut self, id: u32, parent: Affine, alpha: f32) -> Result<()> {
        let store = self.store;
        let Some(node) = store.nodes.get(&id) else {
            return Ok(());
        };
        let r = &node.record;
        if r.hidden() {
            return Ok(());
        }
        let world = parent * r.transform;
        let device = self.frame.view * world;
        if !finite(device) {
            return Err(EngineError::limit(format!(
                "record {id}'s transform overflows on the device"
            )));
        }
        let Some(bounds) = store.bounds(id) else { return Ok(()) };
        if !overlaps(device.transform_rect_bbox(bounds), self.viewport) {
            self.stats.culled += 1;
            return Ok(());
        }
        if self.frame.detail && !r.group() {
            let b = device.transform_rect_bbox(Rect::new(0.0, 0.0, f64::from(r.size[0]), f64::from(r.size[1])));
            if b.width() < 0.5 && b.height() < 0.5 {
                self.stats.culled += 1;
                self.stats.specks += 1;
                return Ok(());
            }
        }
        if r.unsupported != 0 {
            return Err(EngineError::unsupported(format!(
                "record {id} needs features {:#x}",
                r.unsupported
            )));
        }
        self.stats.records += 1;
        let opacity = alpha * r.opacity;
        if opacity <= 0.0 {
            return Ok(());
        }
        let isolate = r.isolate() && r.opacity < 1.0;
        let inner = if isolate { 1.0 } else { opacity };
        if isolate {
            self.scope()?;
            self.backend.scene().push_opacity(opacity);
            self.open.push(Open::Layer);
        }
        let coarse = self.frame.detail && r.coarse_below > 0.0 && scale_of(device) < f64::from(r.coarse_below);
        if coarse {
            self.stats.coarse += 1;
        }
        let ops = if coarse { &r.coarse } else { &r.ops };
        let depth = self.open.len();
        for op in ops {
            self.stats.ops += 1;
            match op {
                Op::Fill { path, even_odd, paint } => self.fill(r, *path, device, *even_odd, paint, inner)?,
                Op::Stroke { path, style, paint } => self.stroke(r, *path, device, style, paint, inner)?,
                Op::Clip { path, even_odd } => {
                    self.scope()?;
                    let p = self.path(r, *path, device, 0.0)?;
                    let scene = self.backend.scene();
                    scene.set_transform(device);
                    scene.set_fill_rule(if *even_odd { Fill::EvenOdd } else { Fill::NonZero });
                    scene.push_clip_path(&p);
                    self.open.push(Open::Clip {
                        transform: device,
                        path: p,
                        even_odd: *even_odd,
                    });
                }
                Op::Unclip => {
                    if self.open.len() > depth {
                        self.open.pop();
                        self.backend.scene().pop_clip();
                    }
                }
                Op::Children => {
                    for c in &node.children {
                        self.node(*c, world, inner)?;
                    }
                }
                Op::Read { kernel, halo } => {
                    self.stats.reads += 1;
                    let b = Rect::new(0.0, 0.0, f64::from(r.size[0]), f64::from(r.size[1]));
                    let h = f64::from(*halo);
                    let paints = IRect::around(device.transform_rect_bbox(b));
                    let reads = IRect::around(device.transform_rect_bbox(b.inflate(h, h)));
                    let open = self.open.clone();
                    self.backend.read(*kernel, paints, reads, &open)?;
                }
            }
        }
        if isolate {
            self.open.pop();
            self.backend.scene().pop_layer();
        }
        Ok(())
    }

    /// Opens a clip or layer, within `Limits::open_scopes`.
    fn scope(&self) -> Result<()> {
        if self.open.len() >= self.open_scopes {
            return Err(EngineError::limit("clips and layers nested too deep"));
        }
        Ok(())
    }

    /// Charges `n` generated path elements to the frame's budget.
    fn spend(&mut self, n: usize) -> Result<()> {
        self.stats.verbs += n as u64;
        self.verbs_left = self.verbs_left.checked_sub(n).ok_or_else(|| {
            EngineError::limit("a frame that would generate more geometry than the engine draws at once")
        })?;
        Ok(())
    }

    /// The viewport in a record's units (under `device`), if it can be mapped back.
    fn viewport_in(&self, device: Affine) -> Option<Rect> {
        if device.determinant().abs() < 1e-300 {
            return None;
        }
        let r = device.inverse().transform_rect_bbox(self.viewport.inflate(2.0, 2.0));
        r.is_finite().then_some(r)
    }

    /// An entry as a path in the record's units. Glyph runs are built from their outlines, the
    /// glyphs at least `margin` units off the viewport left out; an outside entry is a box round
    /// the viewport with the shape cut out. What's built is charged to the frame's budget.
    fn path(&mut self, r: &Record, i: u32, device: Affine, margin: f64) -> Result<BezPath> {
        match r.paths.get(i as usize) {
            Some(PathEntry::Glyphs { scale, glyphs }) => {
                let s = f64::from(*scale);
                let view = self.viewport_in(device).map(|v| v.inflate(margin, margin));
                let mut out = BezPath::new();
                for g in glyphs {
                    let glyph = self
                        .store
                        .glyphs
                        .get(g.glyph)
                        .ok_or_else(|| EngineError::unknown(format!("glyph {}", g.glyph)))?;
                    let place = Affine::new([s, 0.0, 0.0, -s, f64::from(g.x), f64::from(g.y)]);
                    if let (Some(v), Some(b)) = (view, glyph.bounds)
                        && !overlaps(place.transform_rect_bbox(b), v)
                    {
                        continue;
                    }
                    self.spend(glyph.path.elements().len())?;
                    let mut p = glyph.path.clone();
                    p.apply_affine(place);
                    out.extend(p);
                }
                Ok(out)
            }
            Some(PathEntry::Outside(of)) => {
                // The shape cut out is charged like any path (a glyph run's by `path`).
                let inner = if matches!(r.paths.get(*of as usize), Some(PathEntry::Glyphs { .. })) {
                    self.path(r, *of, device, 0.0)?
                } else {
                    let p = r
                        .entry_path(*of)
                        .ok_or_else(|| EngineError::malformed(format!("no path {of}")))?;
                    self.spend(p.elements().len())?;
                    p
                };
                use vello_common::kurbo::Shape;
                let shape = if inner.is_empty() {
                    Rect::ZERO
                } else {
                    inner.bounding_box().inflate(1.0, 1.0)
                };
                // Everything outside the shape that could show: the viewport, mapped into the
                // record's units, and round the shape itself (so its hole lies inside the box).
                let outer = self.viewport_in(device).map_or(shape, |v| v.union(shape));
                let mut p = geometry::rect_path(outer);
                self.spend(5)?;
                p.extend(inner);
                Ok(p)
            }
            _ => {
                let p = r
                    .entry_path(i)
                    .ok_or_else(|| EngineError::malformed(format!("no path {i}")))?;
                self.spend(p.elements().len())?;
                Ok(p)
            }
        }
    }

    /// Sets the scene's paint for `paint` drawn under `device`. False when it paints nothing.
    fn set_paint(&mut self, paint: &Paint, device: Affine, alpha: f32) -> Result<bool> {
        match paint {
            Paint::Solid(c) => {
                if c[3] * alpha <= 0.0 {
                    return Ok(false);
                }
                let scene = self.backend.scene();
                scene.reset_paint_transform();
                scene.set_paint(color(*c, alpha).into());
            }
            Paint::Gradient(g) => {
                let crate::record::GradientPaint { kind, matrix, stops } = &**g;
                let mut g = match kind {
                    GradientKind::Linear => Gradient::new_linear((0.0, 0.0), (1.0, 0.0)),
                    GradientKind::Radial => Gradient::new_radial((0.0, 0.0), 1.0),
                    // Conic gradients start at 3 o'clock and turn clockwise (y down), as the canvas's do.
                    GradientKind::Angular => Gradient::new_sweep((0.0, 0.0), 0.0, core::f32::consts::TAU),
                    GradientKind::Diamond => {
                        return Err(EngineError::unsupported("diamond gradients"));
                    }
                };
                if matrix.determinant().abs() < 1e-12 {
                    return Ok(false);
                }
                g.extend = Extend::Pad;
                // The canvas interpolates gradient colours unpremultiplied.
                g.interpolation_alpha_space = InterpolationAlphaSpace::Unpremultiplied;
                g.stops = ColorStops(
                    stops
                        .iter()
                        .map(|(offset, c)| ColorStop::from((*offset, color(*c, alpha))))
                        .collect(),
                );
                let scene = self.backend.scene();
                scene.set_paint(g.into());
                scene.set_paint_transform(*matrix);
            }
            Paint::Image(img) => {
                let crate::record::ImagePaint {
                    image,
                    matrix,
                    tile,
                    opacity,
                } = &**img;
                if opacity * alpha <= 0.0 {
                    return Ok(false);
                }
                // Device pixels the image's width spans: pick a level at least that wide.
                let span = (device * *matrix).as_coeffs();
                let px = span[0].hypot(span[1]);
                let view = self
                    .backend
                    .image(*image, px)
                    .ok_or_else(|| EngineError::unknown(format!("image {image} isn't held")))?;
                let quality = if px > f64::from(view.width) {
                    ImageQuality::High
                } else {
                    ImageQuality::Medium
                };
                let extend = if *tile { Extend::Repeat } else { Extend::Pad };
                let img = Image {
                    image: view.source,
                    sampler: ImageSampler {
                        x_extend: extend,
                        y_extend: extend,
                        quality,
                        alpha: opacity * alpha,
                    },
                };
                let scene = self.backend.scene();
                scene.set_paint(img.into());
                scene.set_paint_transform(
                    *matrix * Affine::scale_non_uniform(1.0 / f64::from(view.width), 1.0 / f64::from(view.height)),
                );
            }
            Paint::Placeholder(opacity) => {
                if opacity * alpha <= 0.0 {
                    return Ok(false);
                }
                let source = self.backend.checker();
                let img = Image {
                    image: source,
                    sampler: ImageSampler {
                        x_extend: Extend::Repeat,
                        y_extend: Extend::Repeat,
                        quality: ImageQuality::Low,
                        alpha: opacity * alpha,
                    },
                };
                // Fixed to device pixels, so it reads as loading at any zoom, and anchored on the
                // pixel the page's origin falls in, so a tile and a whole frame draw it alike.
                let [.., e, f] = self.frame.view.as_coeffs();
                let anchor = Affine::translate((e.floor(), f.floor()));
                let scene = self.backend.scene();
                scene.set_paint(img.into());
                scene.set_paint_transform(device.inverse() * anchor);
            }
        }
        Ok(true)
    }

    fn fill(&mut self, r: &Record, i: u32, device: Affine, even_odd: bool, paint: &Paint, alpha: f32) -> Result<()> {
        if let (Some(PathEntry::Glyphs { scale, glyphs }), Paint::Solid(c), false) =
            (r.paths.get(i as usize), paint, even_odd)
        {
            return self.glyphs(device, f64::from(*scale), glyphs, *c, alpha);
        }
        let p = self.path(r, i, device, 0.0)?;
        if !self.set_paint(paint, device, alpha)? {
            return Ok(());
        }
        let scene = self.backend.scene();
        scene.set_transform(device);
        scene.set_fill_rule(if even_odd { Fill::EvenOdd } else { Fill::NonZero });
        scene.fill_path(&p);
        Ok(())
    }

    fn stroke(
        &mut self,
        r: &Record,
        i: u32,
        device: Affine,
        style: &StrokeStyle,
        paint: &Paint,
        alpha: f32,
    ) -> Result<()> {
        if style.width <= 0.0 {
            return Ok(());
        }
        // A glyph off the viewport by less than the stroke's reach still shows its stroke.
        let reach = f64::from(style.width) * f64::from(style.miter.max(1.0)) + 1.0;
        let p = self.path(r, i, device, reach)?;
        if !style.dashes.is_empty() {
            // Decode checked the dashes on shapes whose length it knows; a glyph run's is known now.
            let length = polygon_length(&p);
            crate::record::check_dashes(
                style,
                length,
                &crate::limits::Limits {
                    frame_verbs: self.verbs_left,
                    ..self.store.limits
                },
            )?;
            let period: f64 = style.dashes.iter().map(|d| f64::from(*d)).sum();
            self.spend((length / period * style.dashes.len() as f64).ceil() as usize)?;
        }
        if !self.set_paint(paint, device, alpha)? {
            return Ok(());
        }
        let mut s = Stroke::new(f64::from(style.width))
            .with_join(match style.join {
                1 => Join::Round,
                2 => Join::Bevel,
                _ => Join::Miter,
            })
            .with_caps(match style.cap {
                1 => Cap::Round,
                2 => Cap::Square,
                _ => Cap::Butt,
            })
            .with_miter_limit(f64::from(style.miter.max(1.0)));
        if !style.dashes.is_empty() {
            s = s.with_dashes(f64::from(style.dash_offset), style.dashes.iter().map(|d| f64::from(*d)));
        }
        let scene = self.backend.scene();
        scene.set_transform(device);
        scene.set_stroke(s);
        scene.stroke_path(&p);
        Ok(())
    }

    /// A run of glyphs in one solid colour: each from the glyph cache where it can be, else
    /// filled as its outline.
    fn glyphs(
        &mut self,
        device: Affine,
        s: f64,
        glyphs: &[crate::record::GlyphInstance],
        c: Rgba,
        alpha: f32,
    ) -> Result<()> {
        if c[3] * alpha <= 0.0 {
            return Ok(());
        }
        let tint = color(c, alpha);
        let mut outlines = BezPath::new();
        // An outline fill is one path, so glyphs that overlap aren't laid over each other; masks
        // are. Opaque, that's the same picture. See-through, a run whose glyphs touch fills its
        // outlines.
        let place = |g: &crate::record::GlyphInstance| {
            self.store
                .glyphs
                .bounds(g.glyph)
                .map(|b| Affine::new([s, 0.0, 0.0, -s, f64::from(g.x), f64::from(g.y)]).transform_rect_bbox(b))
        };
        let masks = c[3] * alpha >= 1.0
            || glyphs.windows(2).all(|w| match (place(&w[0]), place(&w[1])) {
                (Some(a), Some(b)) => !overlaps(a, b),
                _ => true,
            });
        // Masks are laid in device pixels, tinted: set once for the run, on its first mask.
        let mut tinted = false;
        for g in glyphs {
            let Some(glyph) = self.store.glyphs.get(g.glyph) else {
                if tinted {
                    self.backend.scene().set_tint(None);
                }
                return Err(EngineError::unknown(format!("glyph {}", g.glyph)));
            };
            let Some(gb) = glyph.bounds else { continue };
            let m = device * Affine::new([s, 0.0, 0.0, -s, f64::from(g.x), f64::from(g.y)]);
            if !overlaps(m.transform_rect_bbox(gb), self.viewport) {
                continue;
            }
            let [a, b, cc, d, e, f] = m.as_coeffs();
            let axis_aligned = b.abs() <= 1e-9 * (a.abs() + d.abs()) && cc.abs() <= 1e-9 * (a.abs() + d.abs());
            let small = gb.width() * a.abs() <= self.glyph_mask_side && gb.height() * d.abs() <= self.glyph_mask_side;
            if masks && axis_aligned && small && e.abs() < 1.0e7 && f.abs() < 1.0e7 {
                let (mut ix, mut iy) = (e.floor(), f.floor());
                let mut px = ((e - ix) * PHASES).round();
                let mut py = ((f - iy) * PHASES).round();
                if px >= PHASES {
                    px = 0.0;
                    ix += 1.0;
                }
                if py >= PHASES {
                    py = 0.0;
                    iy += 1.0;
                }
                let key = MaskKey {
                    serial: glyph.serial,
                    sx: (a as f32).to_bits(),
                    sy: (d as f32).to_bits(),
                    px: px as u8,
                    py: py as u8,
                };
                if let Some((source, origin, size)) =
                    self.backend
                        .glyph_mask(key, &glyph.path, (a, d), (px / PHASES, py / PHASES))
                {
                    let x = ix + f64::from(origin.0);
                    let y = iy + f64::from(origin.1);
                    let scene = self.backend.scene();
                    scene.set_paint(
                        Image {
                            image: source,
                            sampler: ImageSampler {
                                x_extend: Extend::Pad,
                                y_extend: Extend::Pad,
                                quality: ImageQuality::Low,
                                alpha: 1.0,
                            },
                        }
                        .into(),
                    );
                    if !tinted {
                        scene.set_transform(Affine::IDENTITY);
                        scene.set_tint(Some(Tint {
                            color: tint,
                            mode: TintMode::AlphaMask,
                        }));
                        tinted = true;
                    }
                    scene.set_paint_transform(Affine::translate((x, y)));
                    scene.fill_rect(&Rect::new(x, y, x + f64::from(size.0), y + f64::from(size.1)));
                    self.stats.glyphs_masked += 1;
                    continue;
                }
            }
            if let Err(e) = self.spend(glyph.path.elements().len()) {
                if tinted {
                    self.backend.scene().set_tint(None);
                }
                return Err(e);
            }
            let mut p = glyph.path.clone();
            p.apply_affine(Affine::new([s, 0.0, 0.0, -s, f64::from(g.x), f64::from(g.y)]));
            outlines.extend(p);
            self.stats.glyphs_outlined += 1;
        }
        if tinted {
            self.backend.scene().set_tint(None);
        }
        if !outlines.is_empty() {
            let scene = self.backend.scene();
            scene.reset_paint_transform();
            scene.set_paint(tint.into());
            scene.set_transform(device);
            scene.set_fill_rule(Fill::NonZero);
            scene.fill_path(&outlines);
        }
        Ok(())
    }
}

/// Normal blending, for the record of what the engine composites by itself.
pub fn normal() -> BlendMode {
    BlendMode::new(Mix::Normal, Compose::SrcOver)
}
