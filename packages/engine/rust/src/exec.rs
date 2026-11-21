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
use crate::record::{ComposeMode, GradientKind, Op, Paint, PathEntry, PostEffect, Record, Rgba, StrokeStyle};
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
    fn fill_blurred_rounded_rect_in(&mut self, p: &BezPath, r: &Rect, radius: f32, std_dev: f32, invert: bool);
    fn stroke_path(&mut self, p: &BezPath);
    fn push_clip_path(&mut self, p: &BezPath);
    fn pop_clip(&mut self);
    fn push_opacity(&mut self, opacity: f32);
    fn push_layer(&mut self, compose: Compose, opacity: Option<f32>);
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
            fn fill_blurred_rounded_rect_in(
                &mut self,
                p: &vello_common::kurbo::BezPath,
                r: &vello_common::kurbo::Rect,
                radius: f32,
                std_dev: f32,
                invert: bool,
            ) {
                <$t>::fill_blurred_rounded_rect_in(self, p, r, radius, std_dev, invert);
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
            fn push_layer(&mut self, compose: vello_common::peniko::Compose, opacity: Option<f32>) {
                let blend = (compose != vello_common::peniko::Compose::SrcOver).then_some(
                    vello_common::peniko::BlendMode::new(vello_common::peniko::Mix::Normal, compose),
                );
                <$t>::push_layer(self, None, blend, opacity, None, None);
            }
            fn pop_layer(&mut self) {
                <$t>::pop_layer(self);
            }
        }
    };
}
pub(crate) use impl_draw;

/// A glyph's mask: its source, its top left from the glyph's whole-pixel anchor, and its size.
/// A glyph's mask, kept on the CPU (premultiplied white: its alpha is the coverage), and its top
/// left from the glyph's whole-pixel anchor.
pub type GlyphMask = (std::sync::Arc<vello_cpu::Pixmap>, (i32, i32));

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
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
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
    pub fn intersect(self, o: Self) -> Self {
        Self {
            x0: self.x0.max(o.x0),
            y0: self.y0.max(o.y0),
            x1: self.x1.min(o.x1),
            y1: self.y1.min(o.y1),
        }
    }
    pub fn inflate(self, dx: i32, dy: i32) -> Self {
        Self {
            x0: self.x0.saturating_sub(dx),
            y0: self.y0.saturating_sub(dy),
            x1: self.x1.saturating_add(dx),
            y1: self.y1.saturating_add(dy),
        }
    }
}

pub enum ShadowCast<'a> {
    /// Filled device-space paths (general shapes, spread shapes, text runs + decoration bars).
    Fill { paths: &'a [BezPath], even_odd: bool },
    /// Stroked local-space paths under `transform` (open stroke-only layers).
    Stroke {
        paths: &'a [BezPath],
        transform: Affine,
        stroke: Stroke,
        /// Approximate device-space bounding box of the stroked paths.
        bbox: Rect,
    },
}

/// One resolved post-effect pass in device pixels, applied in order to an isolated target.
#[derive(Clone, Copy, Debug)]
pub enum PostStep {
    LayerBlur {
        out_area: IRect,
        sigma: f32,
    },
    Noise {
        out_area: IRect,
        noise_type: u32,
        size: f32,
        density: f32,
        color: Rgba,
        secondary_color: Rgba,
        opacity: f32,
        dev_to_layer: Affine,
    },
    Texture {
        out_area: IRect,
        size: f32,
        radius_dev: f32,
        clip_to_shape: bool,
        dev_to_layer: Affine,
    },
}

pub trait Backend {
    type Scene: Draw;
    fn scene(&mut self) -> &mut Self::Scene;
    /// Flushes pending scene draws on tiled CPU renders when a culled subtree would have flushed
    /// on the whole frame, preserving `f32 -> u8` flush boundaries under `vello_cpu`'s
    /// `f32_pipeline`.
    fn flush_barrier(&mut self, _open: &[Open]) {}
    /// Device-pixel offset of the active scene's `(0, 0)` (zero on root target, `origin` on
    /// pushed offscreen targets).
    fn scene_offset(&self) -> (i32, i32);
    /// Active target bounds in device pixels.
    fn target_bounds(&self) -> IRect;
    /// An image's level at least `px` device pixels wide (or its largest).
    fn image(&mut self, id: u32, px: f64) -> Option<ImageView>;
    /// The loading checkerboard, 16 × 16 device pixels, repeated.
    fn checker(&mut self) -> ImageSource;
    /// A glyph's coverage mask, made if it isn't held and fits (`masks::coverage`).
    fn glyph_mask(&mut self, key: MaskKey, path: &BezPath, scale: (f64, f64), phase: (f64, f64)) -> Option<GlyphMask>;
    /// A run's image for the frame being drawn (`w` × `h` premultiplied pixels, `masks::compose_run`),
    /// to paint from; None when it can't be had (the GPU's atlas is full for this tile).
    fn run_image(&mut self, w: u16, h: u16, pixels: Vec<u8>) -> Option<ImageSource>;
    /// Whether a run's image is made whole, the same wherever it's drawn (the CPU: vello_cpu rounds
    /// an image's pixels a level differently by its size, and an export's bands must be bitwise its
    /// whole frame), or only of the glyphs in view, cut to the tile drawing it (the GPU).
    fn whole_runs(&self) -> bool;
    /// Renders an exact diamond gradient (`t = clamp(|u| + |v|, 0, 1)`) covering device pixels `area`.
    fn diamond_gradient(
        &mut self,
        area: IRect,
        device_to_grad: Affine,
        stops: &[(f32, Rgba)],
        alpha: f32,
    ) -> Result<Option<ImageSource>>;
    /// Runs a backdrop reader over what's drawn so far (`open` is open in the scene).
    fn read(&mut self, kernel: u32, paints: IRect, reads: IRect, open: &[Open]) -> Result<()>;
    /// Pushes a transparent offscreen target covering `area` (device pixels), flushing the active
    /// scene first. When `clip_to_parent` is true, `area` is intersected with `target_bounds()`;
    /// when false (e.g. layer blur needing halo pixels outside a tile or frame edge), `area` is
    /// used as-is and `scene_origin_hint` provides a tile-independent CPU scene origin.
    /// Returns `false` if the resulting target is empty.
    fn push_isolated(
        &mut self,
        area: IRect,
        clip_to_parent: bool,
        scene_origin_hint: Option<(i32, i32)>,
        open: &[Open],
    ) -> Result<bool>;
    /// Pushes an offscreen target covering `area` (device pixels), initialized with a copy of the
    /// parent target's pixels over that area (for faded pass-through frames, decision 0038).
    /// Returns `false` if the resulting target is empty.
    fn push_isolated_backdrop(&mut self, area: IRect, open: &[Open]) -> Result<bool>;
    /// Flushes the active offscreen target (if pending), applies an ordered chain of post-effect
    /// steps (`LayerBlur`, `Noise`, `Texture`), and replaces the top of the offscreen stack with
    /// the final result.
    fn apply_post_isolated(&mut self, steps: &[PostStep]) -> Result<()>;
    /// Flushes (if pending) and pops the active offscreen target, reopens parent `open` clips,
    /// and draws it onto the parent scene with `SrcOver` at `opacity`.
    fn pop_isolated(&mut self, opacity: f32, open: &[Open]) -> Result<()>;
    /// Flushes (if pending) and pops the active offscreen target, blends it onto the parent target
    /// using blend mode `blend` (`1..=17` or `crate::blend::BLEND_LERP`) at `opacity` masked by
    /// parent `open` clips, and reopens parent `open` clips.
    fn pop_blended(&mut self, blend: u32, opacity: f32, open: &[Open]) -> Result<()> {
        self.pop_composited(blend, opacity, None, open)
    }
    /// Composites an isolated picture. With a mask kind, the stack top is the mask picture
    /// and the next target is the content. Apply mask coverage before the final RGBA8 store.
    fn pop_composited(&mut self, blend: u32, opacity: f32, mask_kind: Option<u32>, open: &[Open]) -> Result<()>;
    /// Discards the active offscreen target on error unwind without compositing.
    fn abort_isolated(&mut self);
    /// Renders a Gaussian-blurred shadow mask over `dirty` (device pixels) and draws it into the
    /// active scene tinted with `color` (`SrcOver`, respecting open clips). When `canonical` is
    /// provided, backends may satisfy the shadow from their bounded `ShadowMaskCache`.
    #[allow(clippy::too_many_arguments)]
    fn draw_blurred_shadow(
        &mut self,
        cast: &ShadowCast<'_>,
        canonical: Option<&crate::shadow::CanonicalShadow>,
        invert: bool,
        dirty: IRect,
        sigma: f32,
        color: AlphaColor<Srgb>,
        open: &[Open],
    ) -> Result<()>;
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
    /// Tiles a drag composited (the part below, its selection, the part above): a stand-in.
    pub dragged: u32,
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

/// Which part of the page a pass draws, split around a selection of consecutive siblings
/// (decision 0040, "Dragging"): everything painted before it, the selection alone, or
/// everything painted after it. The page's background goes with the part before; the other two
/// are drawn over nothing, so the three laid over each other in order are the page.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Pass {
    All,
    Below,
    Selection,
    Above,
}

/// The selection a pass splits around: children `first..=last` of `parent`, in paint order.
#[derive(Clone, Debug)]
pub struct Split {
    pub pass: Pass,
    pub parent: u32,
    pub first: usize,
    pub last: usize,
    /// `parent` and its ancestors: walked in every pass (their clips and transforms hold the
    /// selection, and paint order runs through them), though they paint only in their part.
    pub path: Vec<u32>,
}

impl Split {
    pub fn all() -> Self {
        Self {
            pass: Pass::All,
            parent: u32::MAX,
            first: 0,
            last: 0,
            path: Vec::new(),
        }
    }
}

/// Where the walk is in paint order relative to the selection.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
    Before,
    In,
    After,
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
    draw_split(store, backend, frame, limits, budget, &Split::all())
}

/// `draw_budgeted`, drawing only the part of the page `split` names.
pub fn draw_split<B: Backend>(
    store: &Store,
    backend: &mut B,
    frame: &Frame,
    limits: &Limits,
    budget: &mut usize,
    split: &Split,
) -> Result<DrawStats> {
    let full_frame = IRect {
        x0: 0,
        y0: 0,
        x1: i32::from(frame.width),
        y1: i32::from(frame.height),
    };
    let tiled = frame.area != full_frame;
    let full_viewport = Rect::new(-1.0, -1.0, f64::from(frame.width) + 1.0, f64::from(frame.height) + 1.0);
    let mut walk = Walk {
        split,
        phase: Phase::Before,
        store,
        backend,
        frame: *frame,
        viewport: Rect::new(
            f64::from(frame.area.x0) - 1.0,
            f64::from(frame.area.y0) - 1.0,
            f64::from(frame.area.x1) + 1.0,
            f64::from(frame.area.y1) + 1.0,
        ),
        tiled,
        full_frame,
        full_viewport,
        open: Vec::new(),
        stats: DrawStats::default(),
        glyph_mask_side: f64::from(limits.glyph_mask_side),
        verbs_left: *budget,
        open_scopes: limits.open_scopes,
    };
    if !store.nodes.contains_key(&crate::store::ROOT) {
        return Err(EngineError::malformed("no page"));
    }
    let result = walk.draw_children(crate::store::ROOT, Affine::IDENTITY, 1.0);
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
    split: &'a Split,
    phase: Phase,
    store: &'a Store,
    backend: &'a mut B,
    frame: Frame,
    viewport: Rect,
    tiled: bool,
    full_frame: IRect,
    full_viewport: Rect,
    open: Vec<Open>,
    stats: DrawStats,
    glyph_mask_side: f64,
    /// Path elements the frame may still generate.
    verbs_left: usize,
    open_scopes: usize,
}

/// The linear part of a transform (its translation dropped).
fn linear(t: Affine) -> Affine {
    let [a, b, c, d, _, _] = t.as_coeffs();
    Affine::new([a, b, c, d, 0.0, 0.0])
}

/// Whether a transform's linear part and its inverse are finite and within `most` on every
/// coefficient: neither collapses nor blows up space past what a float holds with room to spare.
fn bounded(t: Affine, most: f64) -> bool {
    let ok = |m: Affine| m.as_coeffs().iter().all(|c| c.is_finite() && c.abs() <= most);
    let l = linear(t);
    ok(l) && ok(l.inverse())
}

/// Sample positions a repeated image keeps exact: vello_cpu wraps them with a float remainder
/// (`euclid_mod`), exact for whole numbers below 2^24 and off past the image beyond.
const REPEAT_POSITIONS: f64 = (1u32 << 22) as f64;

/// The most pixels a whole run's image may hold (`Backend::whole_runs`): 16 MiB of them.
const WHOLE_RUN_PIXELS: i64 = 1 << 22;

/// Whether an image can be sampled where it's painted, decided from the record alone, never
/// from where the frame or tile sits, so a tile and the whole frame decide alike.
///
/// vello_cpu turns a sample's position into a pixel index with float arithmetic that, past what
/// a float holds, indexes past the image (a panic) or reads the wrong pixel: NaN and infinity
/// convert to an index past the end on x86, and a repeat's remainder loses whole pixels once
/// positions pass 2^24. So: the record's transform to the device and the image's placement
/// (`texel`, texel units to the record's) each neither collapse nor blow up space; and, repeated,
/// the image's positions over the region painted (`region`, the record's units, unknown: None)
/// stay within `REPEAT_POSITIONS`. A padded image's positions are clamped, so any finite one
/// does. Otherwise the paint draws nothing.
fn sampleable(device: Affine, texel: Affine, region: Option<Rect>, repeat: bool) -> bool {
    const MOST: f64 = 1e12;
    if !bounded(device, MOST) || !bounded(texel, MOST) || !finite(texel) {
        return false;
    }
    if !repeat {
        return true;
    }
    let Some(region) = region else { return false };
    // What the device's anti-aliasing reaches past the region: two device pixels.
    let pad = 2.0
        * linear(device).inverse().as_coeffs()[..4]
            .iter()
            .map(|c| c.abs())
            .sum::<f64>();
    let region = region.inflate(pad, pad);
    let inv = texel.inverse();
    [
        (region.x0, region.y0),
        (region.x1, region.y0),
        (region.x0, region.y1),
        (region.x1, region.y1),
    ]
    .into_iter()
    .all(|corner| {
        let p = inv * vello_common::kurbo::Point::from(corner);
        p.x.is_finite() && p.y.is_finite() && p.x.abs() <= REPEAT_POSITIONS && p.y.abs() <= REPEAT_POSITIONS
    })
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

/// Snaps `raw` outward to a `step`-pixel grid whose phase matches the page origin under `view`,
/// so tiles of any size (including non-power-of-two test tiles) share identical pyramid block
/// boundaries with a whole-frame render.
fn align_area_checked(raw: IRect, step: i32, phase: (i32, i32), max_side: i32) -> Result<IRect> {
    let step = step.max(1);
    let align_down = |v: i32, p: i32| (v - p).div_euclid(step) * step + p;
    let align_up = |v: i32, p: i32| (v - p + step - 1).div_euclid(step) * step + p;
    let r = IRect {
        x0: align_down(raw.x0, phase.0),
        y0: align_down(raw.y0, phase.1),
        x1: align_up(raw.x1, phase.0),
        y1: align_up(raw.y1, phase.1),
    };
    if r.x1 - r.x0 > max_side || r.y1 - r.y0 > max_side {
        return Err(EngineError::limit(format!(
            "layer blur source {} x {} px exceeds maximum target size {max_side} px",
            r.x1 - r.x0,
            r.y1 - r.y0
        )));
    }
    Ok(r)
}

fn view_grid_phase(view: Affine, step: i32) -> (i32, i32) {
    let s = f64::from(step.max(1));
    let [.., e, f] = view.as_coeffs();
    (e.floor().rem_euclid(s) as i32, f.floor().rem_euclid(s) as i32)
}

#[derive(Clone, Debug)]
enum ActivePost {
    LayerBlur {
        sigma: f32,
    },
    Noise {
        noise_type: u32,
        size: f32,
        density: f32,
        color: Rgba,
        secondary_color: Rgba,
        opacity: f32,
        dev_to_layer: Affine,
    },
    Texture {
        size: f32,
        radius_dev: f32,
        clip_to_shape: bool,
        dev_to_layer: Affine,
    },
}

impl ActivePost {
    fn src_pad(&self) -> i32 {
        match *self {
            Self::LayerBlur { sigma } => crate::shadow::blur_support_pad(sigma),
            Self::Noise { .. } => 0,
            Self::Texture { radius_dev, .. } => (radius_dev.ceil() as i32).saturating_add(2),
        }
    }

    fn grow_pad(&self) -> i32 {
        match *self {
            Self::LayerBlur { sigma } => crate::shadow::blur_support_pad(sigma),
            Self::Noise { .. } => 0,
            Self::Texture {
                radius_dev,
                clip_to_shape,
                ..
            } => {
                if clip_to_shape {
                    0
                } else {
                    (radius_dev.ceil() as i32).saturating_add(2)
                }
            }
        }
    }

    fn into_step(self, out_area: IRect) -> PostStep {
        match self {
            Self::LayerBlur { sigma } => PostStep::LayerBlur { out_area, sigma },
            Self::Noise {
                noise_type,
                size,
                density,
                color,
                secondary_color,
                opacity,
                dev_to_layer,
            } => PostStep::Noise {
                out_area,
                noise_type,
                size,
                density,
                color,
                secondary_color,
                opacity,
                dev_to_layer,
            },
            Self::Texture {
                size,
                radius_dev,
                clip_to_shape,
                dev_to_layer,
            } => PostStep::Texture {
                out_area,
                size,
                radius_dev,
                clip_to_shape,
                dev_to_layer,
            },
        }
    }
}

/// Verifies that the texture Perlin lattice coordinates `dev_to_layer(corner) / size` stay
/// finite and within safe `f32`/`i32` lattice precision (`|q| <= 1e6`) across `area`.
pub(crate) fn validate_texture_lattice(area: IRect, dev_to_layer: Affine, size: f32) -> Result<()> {
    const MAX_LATTICE: f64 = 1.0e6;
    if !size.is_finite() || size <= 0.0 {
        return Err(EngineError::limit("texture cell size is not finite"));
    }
    let coeffs = dev_to_layer.as_coeffs();
    if coeffs.iter().any(|c| !(*c as f32).is_finite()) {
        return Err(EngineError::limit("texture transform exceeds finite f32 bounds"));
    }
    let inv_cell = 1.0 / f64::from(size);
    if !inv_cell.is_finite() {
        return Err(EngineError::limit("texture cell size is too small for finite lattice"));
    }
    for (x, y) in [
        (f64::from(area.x0) + 0.5, f64::from(area.y0) + 0.5),
        (f64::from(area.x1) - 0.5, f64::from(area.y0) + 0.5),
        (f64::from(area.x0) + 0.5, f64::from(area.y1) - 0.5),
        (f64::from(area.x1) - 0.5, f64::from(area.y1) - 0.5),
    ] {
        let p = dev_to_layer * vello_common::kurbo::Point::new(x, y);
        let qx = p.x * inv_cell;
        let qy = p.y * inv_cell;
        if !qx.is_finite()
            || !qy.is_finite()
            || !(qx as f32).is_finite()
            || !(qy as f32).is_finite()
            || qx.abs() > MAX_LATTICE
            || qy.abs() > MAX_LATTICE
        {
            return Err(EngineError::limit("texture coordinates exceed finite lattice bounds"));
        }
    }
    Ok(())
}

fn active_posts(r: &Record, device: Affine, view_scale: f64) -> Vec<ActivePost> {
    if r.post_effects.is_empty() {
        return Vec::new();
    }
    let inv = bounded(device, 1e12).then(|| device.inverse());
    r.post_effects
        .iter()
        .filter_map(|pe| match *pe {
            PostEffect::LayerBlur { radius } => {
                let sigma = (f64::from(crate::blur::sigma_from_radius(radius)) * view_scale) as f32;
                (sigma >= 1e-4).then_some(ActivePost::LayerBlur { sigma })
            }
            PostEffect::Noise {
                noise_type,
                size,
                density,
                color,
                secondary_color,
                opacity,
            } => {
                let dev_to_layer = inv?;
                (size > 0.0 && density > 0.0).then_some(ActivePost::Noise {
                    noise_type,
                    size,
                    density,
                    color,
                    secondary_color,
                    opacity,
                    dev_to_layer,
                })
            }
            PostEffect::Texture {
                size,
                radius,
                clip_to_shape,
            } => {
                let dev_to_layer = inv?;
                let radius_dev = (f64::from(radius) * view_scale) as f32;
                (size > 0.0 && radius_dev >= 1e-4).then_some(ActivePost::Texture {
                    size,
                    radius_dev,
                    clip_to_shape,
                    dev_to_layer,
                })
            }
        })
        .collect()
}

struct PostIsoState {
    prev_open: Vec<Open>,
    prev_viewport: Rect,
    prev_full_frame: IRect,
    prev_full_viewport: Rect,
    out_area: IRect,
    content_rect: IRect,
    posts: Vec<ActivePost>,
    max_step: i32,
    phase: (i32, i32),
    blend: u32,
}

fn paint_visible(paint: &Paint, alpha: f32) -> bool {
    match paint {
        Paint::Solid(c) => c[3] * alpha > 0.0,
        Paint::Gradient(g) => g.matrix.determinant().abs() >= 1e-12 && !g.stops.is_empty(),
        Paint::Image(img) => img.opacity * alpha > 0.0,
        Paint::Placeholder(o) => *o * alpha > 0.0,
    }
}

/// Whether any child of `parent_id` (including picture-mask scopes) would flush the active CPU
/// scene on a full-frame render.
fn children_flush_in_full_frame(
    store: &Store,
    frame: &Frame,
    full_frame: IRect,
    full_viewport: Rect,
    parent_id: u32,
    world: Affine,
    inner: f32,
) -> bool {
    let Some(parent_node) = store.nodes.get(&parent_id) else {
        return false;
    };
    let has_mask = parent_node.children.iter().any(|c| {
        store
            .nodes
            .get(c)
            .is_some_and(|n| !n.record.hidden() && n.record.is_mask())
    });
    if !has_mask {
        return parent_node
            .children
            .iter()
            .any(|&c| subtree_flushes_in_full_frame(store, frame, full_frame, full_viewport, c, world, inner));
    }
    let view_scale = scale_of(frame.view);
    let mask_flushes = |mid: u32, has_ids: bool| -> bool {
        if !has_ids {
            return false;
        }
        let Some(mn) = store.nodes.get(&mid) else {
            return false;
        };
        let mdev = frame.view * world * mn.record.transform;
        if !finite(mdev) {
            return false;
        }
        let (Some(bounds), page_pad) = store.bounds_and_pad(mid) else {
            return false;
        };
        let pad_dev = if page_pad > 0.0 {
            page_pad * view_scale + 2.0
        } else {
            0.0
        };
        let raw = IRect::around(
            mdev.transform_rect_bbox(bounds)
                .inflate(pad_dev, pad_dev)
                .inflate(1.0, 1.0),
        );
        !raw.intersect(full_frame).is_empty()
    };
    let mut pic_scope: Option<(u32, bool)> = None;
    let mut active_clip = false;
    for &cid in &parent_node.children {
        let Some(cn) = store.nodes.get(&cid) else {
            continue;
        };
        let cr = &cn.record;
        if cr.hidden() {
            continue;
        }
        if cr.is_mask() {
            if let Some((mid, has_ids)) = pic_scope.take()
                && mask_flushes(mid, has_ids)
            {
                return true;
            }
            active_clip = false;
            if cr.is_picture_mask() {
                pic_scope = Some((cid, false));
            } else {
                active_clip = true;
            }
            continue;
        }
        if (active_clip || pic_scope.is_some()) && cr.ends_mask() {
            if let Some((mid, has_ids)) = pic_scope.take()
                && mask_flushes(mid, has_ids)
            {
                return true;
            }
            active_clip = false;
            if subtree_flushes_in_full_frame(store, frame, full_frame, full_viewport, cid, world, inner) {
                return true;
            }
            continue;
        }
        if let Some((_, ref mut has_ids)) = pic_scope {
            *has_ids = true;
        } else if subtree_flushes_in_full_frame(store, frame, full_frame, full_viewport, cid, world, inner) {
            return true;
        }
    }
    if let Some((mid, has_ids)) = pic_scope
        && mask_flushes(mid, has_ids)
    {
        return true;
    }
    false
}

/// Whether `id` (culled from a tile) would flush the active CPU scene on a full-frame render.
fn subtree_flushes_in_full_frame(
    store: &Store,
    frame: &Frame,
    full_frame: IRect,
    full_viewport: Rect,
    id: u32,
    parent: Affine,
    alpha: f32,
) -> bool {
    let Some(node) = store.nodes.get(&id) else {
        return false;
    };
    let r = &node.record;
    if r.hidden() || !store.subtree_has_pass(id) {
        return false;
    }
    let world = parent * r.transform;
    let device = frame.view * world;
    if !finite(device) {
        return false;
    }
    let (Some(bounds), page_pad) = store.bounds_and_pad(id) else {
        return false;
    };
    let view_scale = scale_of(frame.view);
    let pad_dev = if page_pad > 0.0 {
        page_pad * view_scale + 2.0
    } else {
        0.0
    };
    let dev_bbox = device.transform_rect_bbox(bounds).inflate(pad_dev, pad_dev);
    if !overlaps(dev_bbox, full_viewport) {
        return false;
    }
    if frame.detail && !r.group() {
        let b = device.transform_rect_bbox(Rect::new(0.0, 0.0, f64::from(r.size[0]), f64::from(r.size[1])));
        if b.width() < 0.5 && b.height() < 0.5 {
            return false;
        }
    }
    let opacity = alpha * r.opacity;
    if opacity <= 0.0 {
        return false;
    }
    let active = active_posts(r, device, view_scale);
    let has_post = !active.is_empty();
    let through = !has_post && r.blend == 0 && r.isolate() && r.opacity < 1.0 && store.subtree_has_blend(id);
    let isolate = has_post || r.blend != 0 || (r.isolate() && r.opacity < 1.0);
    if has_post {
        let raw_out = IRect::around(dev_bbox.inflate(1.0, 1.0));
        let full_out = if raw_out.intersect(full_frame).is_empty() {
            IRect {
                x0: 0,
                y0: 0,
                x1: 0,
                y1: 0,
            }
        } else {
            IRect {
                x0: raw_out.x0.div_euclid(4) * 4 - 4,
                y0: raw_out.y0.div_euclid(4) * 4 - 4,
                x1: (raw_out.x1 + 3).div_euclid(4) * 4 + 4,
                y1: (raw_out.y1 + 3).div_euclid(4) * 4 + 4,
            }
            .intersect(full_frame)
        };
        if !full_out.is_empty() {
            let inner_pad = (page_pad - r.post_pad()).max(0.0);
            let inner_pad_dev = if inner_pad > 0.0 {
                inner_pad * view_scale + 2.0
            } else {
                0.0
            };
            let content_bbox = device.transform_rect_bbox(bounds).inflate(inner_pad_dev, inner_pad_dev);
            let content_rect = IRect::around(content_bbox).inflate(2, 2);
            let total_post_pad: i32 = active.iter().fold(0i32, |acc, p| acc.saturating_add(p.src_pad()));
            if !content_rect
                .intersect(full_out.inflate(total_post_pad, total_post_pad))
                .is_empty()
            {
                return true;
            }
        }
    } else if r.blend != 0 || through || isolate {
        let raw = IRect::around(dev_bbox.inflate(1.0, 1.0));
        if !raw.intersect(full_frame).is_empty() {
            return true;
        }
    }
    let inner = if isolate { 1.0 } else { opacity };
    let coarse =
        r.provisional() || frame.detail && r.coarse_below > 0.0 && scale_of(device) < f64::from(r.coarse_below);
    let ops = if coarse { &r.coarse } else { &r.ops };
    for op in ops {
        match op {
            Op::Read { .. } => return true,
            Op::Fill { path, paint, blend, .. } if *blend != 0 && paint_visible(paint, inner) => {
                if let Some(local_b) = r.entry_bounds(*path, &|g| store.glyphs.bounds(g)) {
                    let raw = IRect::around(device.transform_rect_bbox(local_b).inflate(2.0, 2.0));
                    if !raw.intersect(full_frame).is_empty() {
                        return true;
                    }
                }
            }
            Op::Stroke {
                path,
                style,
                paint,
                blend,
            } if *blend != 0 && style.width > 0.0 && paint_visible(paint, inner) => {
                if let Some(local_b) = r.entry_bounds(*path, &|g| store.glyphs.bounds(g)) {
                    let grow =
                        f64::from(style.width) * f64::from(style.miter.max(1.0)) * 0.5 + f64::from(style.width) + 1.0;
                    let raw = IRect::around(
                        device
                            .transform_rect_bbox(local_b.inflate(grow, grow))
                            .inflate(2.0, 2.0),
                    );
                    if !raw.intersect(full_frame).is_empty() {
                        return true;
                    }
                }
            }
            Op::DropShadow {
                paths,
                dx,
                dy,
                blur,
                color: c,
                blend,
                stroke,
                ..
            } if *blend != 0 && c[3] * inner > 0.0 && stroke.as_ref().is_none_or(|st| st.width > 0.0) => {
                let shifted = Affine::translate((f64::from(*dx) * view_scale, f64::from(*dy) * view_scale)) * device;
                let sigma_dev = crate::blur::sigma_from_radius(*blur) * view_scale as f32;
                let stroke_grow = stroke.as_deref().map_or(0.0, |st| {
                    f64::from(st.width) * f64::from(st.miter.max(1.0)) * 0.5 + f64::from(st.width) + 1.0
                });
                let reach = f64::from(crate::blur::kernel_radius(sigma_dev)) + 2.0;
                for &pi in paths {
                    if let Some(b) = r.entry_bounds(pi, &|g| store.glyphs.bounds(g)) {
                        let lb = if stroke_grow > 0.0 {
                            b.inflate(stroke_grow, stroke_grow)
                        } else {
                            b
                        };
                        let raw = IRect::around(shifted.transform_rect_bbox(lb).inflate(reach, reach));
                        if !raw.intersect(full_frame).is_empty() {
                            return true;
                        }
                    }
                }
            }
            Op::InnerShadow {
                shape, color: c, blend, ..
            } if *blend != 0 && c[3] * inner > 0.0 => {
                if let Some(b) = r.entry_bounds(*shape, &|g| store.glyphs.bounds(g)) {
                    let raw = IRect::around(device.transform_rect_bbox(b).inflate(2.0, 2.0));
                    if !raw.intersect(full_frame).is_empty() {
                        return true;
                    }
                }
            }
            Op::Children if children_flush_in_full_frame(store, frame, full_frame, full_viewport, id, world, inner) => {
                return true;
            }
            _ => {}
        }
    }
    false
}

impl<B: Backend> Walk<'_, B> {
    /// Whether paint now belongs to the part being drawn.
    fn paints(&self) -> bool {
        match self.split.pass {
            Pass::All => true,
            Pass::Below => self.phase == Phase::Before,
            Pass::Selection => self.phase == Phase::In,
            Pass::Above => self.phase == Phase::After,
        }
    }

    /// A parent's children in paint order, the split's selection marking where paint order
    /// passes it.
    fn children(&mut self, parent: u32, children: &[u32], world: Affine, alpha: f32) -> Result<()> {
        let here = self.split.pass != Pass::All && self.split.parent == parent;
        for (k, c) in children.iter().enumerate() {
            if here {
                self.phase = if k < self.split.first {
                    Phase::Before
                } else if k <= self.split.last {
                    Phase::In
                } else {
                    Phase::After
                };
            }
            self.node(*c, world, alpha)?;
        }
        if here {
            self.phase = Phase::After;
        }
        Ok(())
    }

    fn flush_if_tiled_overlap(&mut self, raw: IRect) {
        if self.tiled && !raw.intersect(self.full_frame).is_empty() {
            self.backend.flush_barrier(&self.open);
        }
    }
    fn scene_device(&self, device: Affine) -> Affine {
        let (sox, soy) = self.backend.scene_offset();
        if sox == 0 && soy == 0 {
            device
        } else {
            Affine::translate((-f64::from(sox), -f64::from(soy))) * device
        }
    }
    fn draw_children(&mut self, parent_id: u32, world: Affine, inner: f32) -> Result<()> {
        let Some(parent_node) = self.store.nodes.get(&parent_id) else {
            return Ok(());
        };
        let has_mask = parent_node.children.iter().any(|c| {
            self.store
                .nodes
                .get(c)
                .is_some_and(|n| !n.record.hidden() && n.record.is_mask())
        });
        if !has_mask {
            return self.children(parent_id, &parent_node.children, world, inner);
        }
        let mut clipping = false;
        let mut pic_scope: Option<(u32, u32, Vec<u32>)> = None;
        for &cid in &parent_node.children {
            let Some(cn) = self.store.nodes.get(&cid) else {
                continue;
            };
            let cr = &cn.record;
            if cr.hidden() {
                continue;
            }
            if cr.is_mask() {
                if let Some((mid, mkind, ids)) = pic_scope.take() {
                    self.draw_picture_mask(mid, mkind, &ids, world, inner)?;
                }
                if clipping {
                    self.open.pop();
                    self.backend.scene().pop_clip();
                    clipping = false;
                }
                if cr.unsupported != 0 {
                    return Err(EngineError::unsupported(format!(
                        "record {cid} needs features {:#x}",
                        cr.unsupported
                    )));
                }
                match cr.mask {
                    crate::record::MASK_OUTLINE_NONZERO | crate::record::MASK_OUTLINE_EVENODD => {
                        let mask_world = world * cr.transform;
                        let mask_dev = self.frame.view * mask_world;
                        if !finite(mask_dev) {
                            return Err(EngineError::limit(format!(
                                "record {cid}'s transform overflows on the device"
                            )));
                        }
                        self.scope()?;
                        let p = self.path(cr, 0, mask_dev, 0.0)?;
                        let even_odd = cr.mask == crate::record::MASK_OUTLINE_EVENODD;
                        let sd = self.scene_device(mask_dev);
                        let scene = self.backend.scene();
                        scene.set_transform(sd);
                        scene.set_fill_rule(if even_odd { Fill::EvenOdd } else { Fill::NonZero });
                        scene.push_clip_path(&p);
                        self.open.push(Open::Clip {
                            transform: sd,
                            path: p,
                            even_odd,
                        });
                        clipping = true;
                    }
                    kind => {
                        pic_scope = Some((cid, kind, Vec::new()));
                    }
                }
                continue;
            }
            if (clipping || pic_scope.is_some()) && cr.ends_mask() {
                if let Some((mid, mkind, ids)) = pic_scope.take() {
                    self.draw_picture_mask(mid, mkind, &ids, world, inner)?;
                }
                if clipping {
                    self.open.pop();
                    self.backend.scene().pop_clip();
                    clipping = false;
                }
                self.node(cid, world, inner)?;
                continue;
            }
            if let Some((_, _, ref mut ids)) = pic_scope {
                ids.push(cid);
            } else {
                self.node(cid, world, inner)?;
            }
        }
        if let Some((mid, mkind, ids)) = pic_scope.take() {
            self.draw_picture_mask(mid, mkind, &ids, world, inner)?;
        }
        if clipping {
            self.open.pop();
            self.backend.scene().pop_clip();
        }
        Ok(())
    }

    fn draw_picture_mask(
        &mut self,
        mask_id: u32,
        mask_kind: u32,
        ids: &[u32],
        world: Affine,
        inner: f32,
    ) -> Result<()> {
        if ids.is_empty() {
            return Ok(());
        }
        let Some(mask_node) = self.store.nodes.get(&mask_id) else {
            return Ok(());
        };
        let mask_world = world * mask_node.record.transform;
        let mask_dev = self.frame.view * mask_world;
        if !finite(mask_dev) {
            return Err(EngineError::limit(format!(
                "record {mask_id}'s transform overflows on the device"
            )));
        }
        let (Some(bounds), page_pad) = self.store.bounds_and_pad(mask_id) else {
            return Ok(());
        };
        let view_scale = scale_of(self.frame.view);
        let pad_dev = if page_pad > 0.0 {
            page_pad * view_scale + 2.0
        } else {
            0.0
        };
        let mask_bbox = mask_dev.transform_rect_bbox(bounds).inflate(pad_dev, pad_dev);
        let raw_area = IRect::around(mask_bbox.inflate(1.0, 1.0));
        let mask_area = raw_area.intersect(self.backend.target_bounds());
        let whole_mask = {
            let r = raw_area.intersect(self.full_frame);
            if r.is_empty() {
                r
            } else {
                IRect {
                    x0: r.x0.div_euclid(4) * 4 - 4,
                    y0: r.y0.div_euclid(4) * 4 - 4,
                    x1: (r.x1 + 3).div_euclid(4) * 4 + 4,
                    y1: (r.y1 + 3).div_euclid(4) * 4 + 4,
                }
                .intersect(self.full_frame)
            }
        };
        if mask_area.is_empty() {
            if self.tiled && !whole_mask.is_empty() {
                self.backend.flush_barrier(&self.open);
            }
            return Ok(());
        }
        self.scope()?;
        if !self.backend.push_isolated(mask_area, true, None, &self.open)? {
            if self.tiled && !whole_mask.is_empty() {
                self.backend.flush_barrier(&self.open);
            }
            return Ok(());
        }
        let content_tb = self.backend.target_bounds();
        let prev_open = std::mem::take(&mut self.open);
        let prev_viewport = self.viewport;
        let prev_full_frame = self.full_frame;
        let prev_full_viewport = self.full_viewport;
        self.viewport = Rect::new(
            f64::from(content_tb.x0) - 1.0,
            f64::from(content_tb.y0) - 1.0,
            f64::from(content_tb.x1) + 1.0,
            f64::from(content_tb.y1) + 1.0,
        );
        self.full_frame = whole_mask;
        self.full_viewport = Rect::new(
            f64::from(whole_mask.x0) - 1.0,
            f64::from(whole_mask.y0) - 1.0,
            f64::from(whole_mask.x1) + 1.0,
            f64::from(whole_mask.y1) + 1.0,
        );
        let content_res = (|| -> Result<()> {
            for &cid in ids {
                self.node(cid, world, inner)?;
            }
            Ok(())
        })();
        while let Some(o) = self.open.pop() {
            match o {
                Open::Clip { .. } => self.backend.scene().pop_clip(),
                Open::Layer => self.backend.scene().pop_layer(),
            }
        }
        if let Err(e) = content_res {
            self.viewport = prev_viewport;
            self.full_frame = prev_full_frame;
            self.full_viewport = prev_full_viewport;
            self.open = prev_open;
            self.backend.abort_isolated();
            return Err(e);
        }
        let pushed_pic = match self.backend.push_isolated(content_tb, false, None, &[]) {
            Ok(p) => p,
            Err(e) => {
                self.viewport = prev_viewport;
                self.full_frame = prev_full_frame;
                self.full_viewport = prev_full_viewport;
                self.open = prev_open;
                self.backend.abort_isolated();
                return Err(e);
            }
        };
        if !pushed_pic {
            self.viewport = prev_viewport;
            self.full_frame = prev_full_frame;
            self.full_viewport = prev_full_viewport;
            self.open = prev_open;
            self.backend.abort_isolated();
            return Ok(());
        }
        let mask_res = self.node(mask_id, world, 1.0);
        while let Some(o) = self.open.pop() {
            match o {
                Open::Clip { .. } => self.backend.scene().pop_clip(),
                Open::Layer => self.backend.scene().pop_layer(),
            }
        }
        self.viewport = prev_viewport;
        self.full_frame = prev_full_frame;
        self.full_viewport = prev_full_viewport;
        self.open = prev_open;
        if let Err(e) = mask_res {
            self.backend.abort_isolated();
            self.backend.abort_isolated();
            return Err(e);
        }
        self.backend.pop_composited(0, 1.0, Some(mask_kind), &self.open)?;
        Ok(())
    }

    fn node(&mut self, id: u32, parent: Affine, alpha: f32) -> Result<()> {
        let on_path = self.split.pass != Pass::All && self.split.path.contains(&id);
        // A subtree that isn't on the selection's path lies wholly in one part: skipped when
        // that isn't the part being drawn.
        if self.split.pass != Pass::All && !on_path && !self.paints() {
            return Ok(());
        }
        let drawn = self.node_inner(id, parent, alpha);
        // Past a node on the selection's path, paint order has passed the selection, whether
        // the node was walked or culled (hidden, off the tile, transparent): what follows is
        // above it.
        if on_path {
            self.phase = Phase::After;
        }
        drawn
    }

    fn node_inner(&mut self, id: u32, parent: Affine, alpha: f32) -> Result<()> {
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
        let (Some(bounds), page_pad) = store.bounds_and_pad(id) else {
            return Ok(());
        };
        let view_scale = scale_of(self.frame.view);
        let pad_dev = if page_pad > 0.0 {
            page_pad * view_scale + 2.0
        } else {
            0.0
        };
        let dev_bbox = device.transform_rect_bbox(bounds).inflate(pad_dev, pad_dev);
        if !overlaps(dev_bbox, self.viewport) {
            if self.tiled
                && overlaps(dev_bbox, self.full_viewport)
                && store.subtree_has_pass(id)
                && subtree_flushes_in_full_frame(
                    store,
                    &self.frame,
                    self.full_frame,
                    self.full_viewport,
                    id,
                    parent,
                    alpha,
                )
            {
                self.backend.flush_barrier(&self.open);
            }
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
        let active = active_posts(r, device, view_scale);
        let has_post = !active.is_empty();
        let layer_blend = r.blend;
        let isolate = has_post || layer_blend != 0 || (r.isolate() && r.opacity < 1.0);
        let through = !has_post && layer_blend == 0 && r.isolate() && r.opacity < 1.0 && store.subtree_has_blend(id);
        let use_offscreen = has_post || layer_blend != 0 || through || (isolate && store.subtree_has_pass(id));
        let inner = if isolate { 1.0 } else { opacity };
        let mut post_state: Option<PostIsoState> = None;
        let saved_open = if has_post {
            self.scope()?;
            let parent_tb = self.backend.target_bounds();
            let raw_out = IRect::around(dev_bbox.inflate(1.0, 1.0));
            let padded_out = IRect {
                x0: raw_out.x0.div_euclid(4) * 4 - 4,
                y0: raw_out.y0.div_euclid(4) * 4 - 4,
                x1: (raw_out.x1 + 3).div_euclid(4) * 4 + 4,
                y1: (raw_out.y1 + 3).div_euclid(4) * 4 + 4,
            };
            let out_area = if raw_out.intersect(parent_tb).is_empty() {
                IRect {
                    x0: 0,
                    y0: 0,
                    x1: 0,
                    y1: 0,
                }
            } else {
                padded_out.intersect(parent_tb)
            };
            let inner_pad = (page_pad - r.post_pad()).max(0.0);
            let inner_pad_dev = if inner_pad > 0.0 {
                inner_pad * view_scale + 2.0
            } else {
                0.0
            };
            let content_bbox = device.transform_rect_bbox(bounds).inflate(inner_pad_dev, inner_pad_dev);
            let content_rect = IRect::around(content_bbox).inflate(2, 2);
            let max_side = self.store.limits.texture_side as i32;
            let mut total_post_pad = 0i32;
            let mut max_step = 4i32;
            for pe in &active {
                match *pe {
                    ActivePost::LayerBlur { sigma } => {
                        if !out_area.is_empty() {
                            crate::blur::validate_sigma(
                                sigma,
                                IRect {
                                    x0: 0,
                                    y0: 0,
                                    x1: (out_area.x1 - out_area.x0).max(1),
                                    y1: (out_area.y1 - out_area.y0).max(1),
                                },
                                crate::blur::EdgeMode::Zero,
                            )?;
                        }
                        if sigma > crate::blur::DIRECT_SIGMA_MAX {
                            let (lvl, _) = crate::blur::choose_level(sigma, crate::blur::MAX_PYRAMID_LEVELS);
                            max_step = max_step.max(1i32 << lvl.min(8));
                        }
                    }
                    ActivePost::Texture {
                        size,
                        radius_dev,
                        dev_to_layer,
                        ..
                    } => {
                        if !radius_dev.is_finite() || radius_dev > max_side as f32 {
                            return Err(EngineError::limit("texture radius exceeds finite target bounds"));
                        }
                        if !out_area.is_empty() {
                            validate_texture_lattice(out_area, dev_to_layer, size)?;
                        }
                    }
                    ActivePost::Noise { size, dev_to_layer, .. } => {
                        let uv_scale =
                            crate::noise::PIXELS_PER_UNIT / (f64::from(size) * crate::noise::NOISE_TILE as f64);
                        let coeffs = (Affine::scale(uv_scale) * dev_to_layer).as_coeffs();
                        if !uv_scale.is_finite() || coeffs.iter().any(|c| !(*c as f32).is_finite()) {
                            return Err(EngineError::limit("noise scale exceeds finite coordinate bounds"));
                        }
                    }
                }
                total_post_pad = total_post_pad.saturating_add(pe.src_pad());
            }
            let whole_out = padded_out.intersect(self.full_frame);
            let whole_raw_src = if whole_out.is_empty() {
                IRect {
                    x0: 0,
                    y0: 0,
                    x1: 0,
                    y1: 0,
                }
            } else {
                content_rect.intersect(whole_out.inflate(total_post_pad, total_post_pad))
            };
            let whole_would_flush = !whole_raw_src.is_empty();
            if out_area.is_empty() {
                if self.tiled && whole_would_flush {
                    self.backend.flush_barrier(&self.open);
                }
                return Ok(());
            }
            let raw_src = content_rect.intersect(out_area.inflate(total_post_pad, total_post_pad));
            if raw_src.is_empty() {
                if self.tiled && whole_would_flush {
                    self.backend.flush_barrier(&self.open);
                }
                return Ok(());
            }
            let phase = view_grid_phase(self.frame.view, max_step);
            let src_area = align_area_checked(raw_src, max_step, phase, max_side)?;
            let step = max_step.max(1);
            let scene_hint = (
                ((content_rect.x0 - phase.0).div_euclid(step) * step + phase.0).div_euclid(4) * 4,
                ((content_rect.y0 - phase.1).div_euclid(step) * step + phase.1).div_euclid(4) * 4,
            );
            if !self
                .backend
                .push_isolated(src_area, false, Some(scene_hint), &self.open)?
            {
                if self.tiled && whole_would_flush {
                    self.backend.flush_barrier(&self.open);
                }
                return Ok(());
            }
            let prev_viewport = self.viewport;
            let prev_full_frame = self.full_frame;
            let prev_full_viewport = self.full_viewport;
            self.viewport = Rect::new(
                f64::from(src_area.x0) - 1.0,
                f64::from(src_area.y0) - 1.0,
                f64::from(src_area.x1) + 1.0,
                f64::from(src_area.y1) + 1.0,
            );
            let whole_src = if !self.tiled || whole_raw_src.is_empty() {
                src_area
            } else {
                align_area_checked(whole_raw_src, max_step, phase, max_side).unwrap_or(src_area)
            };
            self.full_frame = whole_src;
            self.full_viewport = Rect::new(
                f64::from(whole_src.x0) - 1.0,
                f64::from(whole_src.y0) - 1.0,
                f64::from(whole_src.x1) + 1.0,
                f64::from(whole_src.y1) + 1.0,
            );
            post_state = Some(PostIsoState {
                prev_open: std::mem::take(&mut self.open),
                prev_viewport,
                prev_full_frame,
                prev_full_viewport,
                out_area,
                content_rect,
                posts: active,
                max_step,
                phase,
                blend: layer_blend,
            });
            None
        } else if use_offscreen {
            self.scope()?;
            let raw_iso = IRect::around(dev_bbox.inflate(1.0, 1.0));
            let iso_area = raw_iso.intersect(self.backend.target_bounds());
            let whole_iso = {
                let r = raw_iso.intersect(self.full_frame);
                if r.is_empty() {
                    r
                } else {
                    IRect {
                        x0: r.x0.div_euclid(4) * 4 - 4,
                        y0: r.y0.div_euclid(4) * 4 - 4,
                        x1: (r.x1 + 3).div_euclid(4) * 4 + 4,
                        y1: (r.y1 + 3).div_euclid(4) * 4 + 4,
                    }
                    .intersect(self.full_frame)
                }
            };
            if iso_area.is_empty() {
                if self.tiled && !whole_iso.is_empty() {
                    self.backend.flush_barrier(&self.open);
                }
                return Ok(());
            }
            let pushed = if through {
                self.backend.push_isolated_backdrop(iso_area, &self.open)?
            } else {
                self.backend.push_isolated(iso_area, true, None, &self.open)?
            };
            if !pushed {
                if self.tiled && !whole_iso.is_empty() {
                    self.backend.flush_barrier(&self.open);
                }
                return Ok(());
            }
            let prev_full_frame = self.full_frame;
            self.full_frame = whole_iso;
            Some((std::mem::take(&mut self.open), prev_full_frame))
        } else {
            if isolate {
                self.scope()?;
                self.backend.scene().push_opacity(opacity);
                self.open.push(Open::Layer);
            }
            None
        };
        let coarse = r.provisional()
            || self.frame.detail && r.coarse_below > 0.0 && scale_of(device) < f64::from(r.coarse_below);
        if coarse {
            self.stats.coarse += 1;
        }
        let ops = if coarse { &r.coarse } else { &r.ops };
        // Evaluate only on records that actually draw a drop shadow.
        let mut layered_shadows = None;
        let depth = self.open.len();
        let mut active_alpha = inner;
        let mut layer_stack: Vec<(f32, bool)> = Vec::new();
        let mut mask_depth = 0usize;
        let res = (|| -> Result<()> {
            for (at, op) in ops.iter().enumerate() {
                self.stats.ops += 1;
                match op {
                    Op::Fill { .. }
                    | Op::Stroke { .. }
                    | Op::Read { .. }
                    | Op::DropShadow { .. }
                    | Op::InnerShadow { .. }
                        if !self.paints() => {}
                    Op::Fill {
                        path,
                        even_odd,
                        paint,
                        blend,
                    } => self.fill(
                        r,
                        *path,
                        device,
                        *even_odd,
                        paint,
                        *blend,
                        active_alpha,
                        mask_depth == 0,
                    )?,
                    Op::Stroke {
                        path,
                        style,
                        paint,
                        blend,
                    } => self.stroke(r, *path, device, style, paint, *blend, active_alpha)?,
                    Op::Clip { path, .. } if self.clip_changes_nothing(id, r, &ops[at + 1..], *path, device) => {
                        // Left out: the same pixels (see `clip_changes_nothing`), and what's drawn
                        // under no clip takes the renderers' fast paths.
                    }
                    Op::Clip { path, even_odd } => {
                        self.scope()?;
                        let p = self.path(r, *path, device, 0.0)?;
                        let sd = self.scene_device(device);
                        let scene = self.backend.scene();
                        scene.set_transform(sd);
                        scene.set_fill_rule(if *even_odd { Fill::EvenOdd } else { Fill::NonZero });
                        scene.push_clip_path(&p);
                        self.open.push(Open::Clip {
                            transform: sd,
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
                    Op::Layer { compose } => {
                        self.scope()?;
                        let (vello_compose, is_mask, layer_opacity) = match compose {
                            ComposeMode::SrcOver => {
                                (Compose::SrcOver, false, (active_alpha < 1.0).then_some(active_alpha))
                            }
                            ComposeMode::DestOut => (Compose::DestOut, true, None),
                            ComposeMode::DestIn => (Compose::DestIn, true, None),
                        };
                        self.backend.scene().push_layer(vello_compose, layer_opacity);
                        self.open.push(Open::Layer);
                        layer_stack.push((active_alpha, is_mask));
                        // Inside an isolated SrcOver layer, opacity is applied once on pop; inside a
                        // DestOut/DestIn mask layer, the mask draws at full coverage regardless of opacity.
                        active_alpha = 1.0;
                        if is_mask {
                            mask_depth += 1;
                        }
                    }
                    Op::Unlayer => {
                        if self.open.len() > depth {
                            self.open.pop();
                            self.backend.scene().pop_layer();
                            if let Some((prev_alpha, is_mask)) = layer_stack.pop() {
                                active_alpha = prev_alpha;
                                if is_mask {
                                    mask_depth = mask_depth.saturating_sub(1);
                                }
                            }
                        }
                    }
                    Op::Children => self.draw_children(id, world, active_alpha)?,
                    Op::Read { kernel, halo } => {
                        self.stats.reads += 1;
                        let b = Rect::new(0.0, 0.0, f64::from(r.size[0]), f64::from(r.size[1]));
                        let h = f64::from(*halo);
                        let paints = IRect::around(device.transform_rect_bbox(b));
                        let reads = IRect::around(device.transform_rect_bbox(b.inflate(h, h)));
                        let open = self.open.clone();
                        self.backend.read(*kernel, paints, reads, &open)?;
                    }
                    Op::DropShadow {
                        paths,
                        even_odd,
                        dx,
                        dy,
                        blur,
                        color: shadow_color,
                        blend,
                        stroke,
                    } => {
                        let layered = *layered_shadows.get_or_insert_with(|| {
                            ops.iter()
                                .filter(|op| matches!(op, Op::DropShadow { color, .. } if color[3] > 0.0))
                                .take(2)
                                .count()
                                > 1
                        });
                        self.drop_shadow(
                            r,
                            paths,
                            *even_odd,
                            *dx,
                            *dy,
                            *blur,
                            *shadow_color,
                            *blend,
                            stroke.as_deref(),
                            device,
                            active_alpha,
                            layered,
                        )?;
                    }
                    Op::InnerShadow {
                        shape,
                        hole,
                        even_odd,
                        dx,
                        dy,
                        blur,
                        color: shadow_color,
                        blend,
                    } => {
                        self.inner_shadow(
                            r,
                            *shape,
                            *hole,
                            *even_odd,
                            *dx,
                            *dy,
                            *blur,
                            *shadow_color,
                            *blend,
                            device,
                            active_alpha,
                        )?;
                    }
                }
            }
            Ok(())
        })();
        if let Some(post) = post_state {
            self.viewport = post.prev_viewport;
            self.full_frame = post.prev_full_frame;
            self.full_viewport = post.prev_full_viewport;
            while let Some(o) = self.open.pop() {
                match o {
                    Open::Clip { .. } => self.backend.scene().pop_clip(),
                    Open::Layer => self.backend.scene().pop_layer(),
                }
            }
            self.open = post.prev_open;
            if res.is_ok() {
                let max_side = self.store.limits.texture_side as i32;
                let mut steps = Vec::with_capacity(post.posts.len());
                let mut post_res = Ok(());
                let mut grown = 0i32;
                let total = post.posts.len();
                let mut rem_pads = vec![0i32; total];
                let mut suffix = 0i32;
                for i in (0..total).rev() {
                    rem_pads[i] = suffix;
                    suffix = suffix.saturating_add(post.posts[i].src_pad());
                }
                for (idx, pe) in post.posts.into_iter().enumerate() {
                    grown = grown.saturating_add(pe.grow_pad());
                    let step_out = if idx + 1 == total {
                        Ok(post.out_area)
                    } else {
                        let rem = rem_pads[idx];
                        let raw = post
                            .content_rect
                            .inflate(grown, grown)
                            .intersect(post.out_area.inflate(rem, rem));
                        align_area_checked(raw, post.max_step, post.phase, max_side)
                    };
                    match step_out {
                        Ok(area) => steps.push(pe.into_step(area)),
                        Err(e) => {
                            post_res = Err(e);
                            break;
                        }
                    }
                }
                if post_res.is_ok() {
                    post_res = self.backend.apply_post_isolated(&steps);
                }
                if let Err(e) = post_res {
                    self.backend.abort_isolated();
                    return Err(e);
                }
                if post.blend != 0 {
                    self.backend.pop_blended(post.blend, opacity, &self.open)?;
                } else {
                    self.backend.pop_isolated(opacity, &self.open)?;
                }
            } else {
                self.backend.abort_isolated();
            }
            return res;
        }
        if let Some((prev_open, prev_full_frame)) = saved_open {
            self.full_frame = prev_full_frame;
            while let Some(o) = self.open.pop() {
                match o {
                    Open::Clip { .. } => self.backend.scene().pop_clip(),
                    Open::Layer => self.backend.scene().pop_layer(),
                }
            }
            self.open = prev_open;
            if res.is_ok() {
                if through {
                    self.backend
                        .pop_blended(crate::blend::BLEND_LERP, opacity, &self.open)?;
                } else if layer_blend != 0 {
                    self.backend.pop_blended(layer_blend, opacity, &self.open)?;
                } else {
                    self.backend.pop_isolated(opacity, &self.open)?;
                }
            } else {
                self.backend.abort_isolated();
            }
            return res;
        }
        res?;
        if isolate {
            self.open.pop();
            self.backend.scene().pop_layer();
        }
        Ok(())
    }

    /// Whether a clip changes nothing it encloses: a box (its corners rounded or not), axis
    /// aligned on the device, enclosing only the record's children (`after`: the ops after the
    /// clip), every one of which lies inside the box, clear of its corners, with a device pixel
    /// to spare for anti-aliasing. Then the clip's coverage is whole wherever they paint: leaving
    /// it out draws the same pictures, and what's drawn under no clip takes the renderers' fast
    /// paths (a card's text and boxes cost far less without its rounded clip).
    fn clip_changes_nothing(&self, id: u32, r: &Record, after: &[Op], path: u32, device: Affine) -> bool {
        let Some(PathEntry::Rect { w, h, radii, smoothing }) = r.paths.get(path as usize) else {
            return false;
        };
        let [a, b, c, d, _, _] = device.as_coeffs();
        if b != 0.0 || c != 0.0 || a == 0.0 || d == 0.0 || *smoothing != 0.0 {
            return false;
        }
        // Only children until the clip closes.
        if !after
            .iter()
            .take_while(|op| !matches!(op, Op::Unclip))
            .all(|op| matches!(op, Op::Children))
        {
            return false;
        }
        let (Some(e), child_pad) = self.store.children_extent_and_pad(id) else {
            return true;
        };
        if child_pad > 0.0 {
            return false;
        }
        // A device pixel and a half to spare: anti-aliasing, and the flattened arc lying inside
        // the true one by up to a quarter pixel.
        let (px, py) = (1.5 / a.abs(), 1.5 / d.abs());
        let (w, h) = (f64::from(*w), f64::from(*h));
        if !(e.is_finite() && e.x0 >= px && e.y0 >= py && e.x1 <= w - px && e.y1 <= h - py) {
            return false;
        }
        // In a corner's square, the content's nearest point to the box's corner must lie inside
        // the corner's arc by as much.
        let pad = px.max(py);
        let k = geometry::fit_radii(w, h, radii.map(f64::from));
        let inside = |k: f64, corner: (f64, f64), centre: (f64, f64)| {
            k <= 0.0 || (corner.0 - centre.0).hypot(corner.1 - centre.1) <= k - pad
        };
        let tl = !(e.x0 < k[0] && e.y0 < k[0]) || inside(k[0], (e.x0, e.y0), (k[0], k[0]));
        let tr = !(e.x1 > w - k[1] && e.y0 < k[1]) || inside(k[1], (e.x1, e.y0), (w - k[1], k[1]));
        let br = !(e.x1 > w - k[2] && e.y1 > h - k[2]) || inside(k[2], (e.x1, e.y1), (w - k[2], h - k[2]));
        let bl = !(e.x0 < k[3] && e.y1 > h - k[3]) || inside(k[3], (e.x0, e.y1), (k[3], h - k[3]));
        tl && tr && br && bl
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
                        .entry_path(*of, device)
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
                    .entry_path(i, device)
                    .ok_or_else(|| EngineError::malformed(format!("no path {i}")))?;
                self.spend(p.elements().len())?;
                Ok(p)
            }
        }
    }

    /// Sets `paint` up for what's drawn next under `device`, over `region` (the record's units,
    /// where known): answers whether it paints at all.
    fn set_paint(&mut self, paint: &Paint, device: Affine, alpha: f32, region: Option<Rect>) -> Result<bool> {
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
                if matrix.determinant().abs() < 1e-12 || alpha <= 0.0 {
                    return Ok(false);
                }
                if *kind == GradientKind::Diamond {
                    if device.determinant().abs() < 1e-300 {
                        return Ok(false);
                    }
                    let grad_to_device = device * *matrix;
                    if grad_to_device.determinant().abs() < 1e-300 {
                        return Ok(false);
                    }
                    let area = diamond_device_rect(region, device, self.frame.area);
                    if area.is_empty() {
                        return Ok(false);
                    }
                    let Some(source) = self
                        .backend
                        .diamond_gradient(area, grad_to_device.inverse(), stops, alpha)?
                    else {
                        return Ok(false);
                    };
                    let img = Image {
                        image: source,
                        sampler: ImageSampler {
                            x_extend: Extend::Pad,
                            y_extend: Extend::Pad,
                            quality: ImageQuality::Low,
                            alpha: 1.0,
                        },
                    };
                    let scene = self.backend.scene();
                    scene.set_paint(img.into());
                    scene.set_paint_transform(
                        device.inverse() * Affine::translate((f64::from(area.x0), f64::from(area.y0))),
                    );
                    return Ok(true);
                }
                let mut g = match kind {
                    GradientKind::Linear => Gradient::new_linear((0.0, 0.0), (1.0, 0.0)),
                    GradientKind::Radial => Gradient::new_radial((0.0, 0.0), 1.0),
                    // Conic gradients start at 3 o'clock and turn clockwise (y down), as the canvas's do.
                    GradientKind::Angular => Gradient::new_sweep((0.0, 0.0), 0.0, core::f32::consts::TAU),
                    GradientKind::Diamond => unreachable!(),
                };
                g.extend = Extend::Pad;
                // The canvas interpolates gradient colours unpremultiplied.
                g.interpolation_alpha_space = InterpolationAlphaSpace::Unpremultiplied;
                // Vello sizes its gradient LUT from the stop count (256 for 2 stops, 512 for 3,
                // 1024 for 4+) and truncates the LUT index. Inserting exact unpremultiplied
                // linear midpoints on 2- and 3-stop ramps is mathematically identical while
                // upgrading the LUT to 1024 entries (avoiding 1-2 LSB bias on linear-dodge
                // transparent fades).
                let expanded_stops: Vec<ColorStop> = if stops.len() >= 2 && stops.len() < 4 {
                    let mut out = Vec::with_capacity(5);
                    for pair in stops.windows(2) {
                        let (t0, c0) = pair[0];
                        let (t1, c1) = pair[1];
                        out.push(ColorStop::from((t0, color(c0, alpha))));
                        let dt = t1 - t0;
                        let subdivs: usize = if dt <= 0.0 {
                            1
                        } else if stops.len() == 2 {
                            4
                        } else {
                            2
                        };
                        for k in 1..subdivs {
                            let f = k as f32 / subdivs as f32;
                            let tm = t0 + dt * f;
                            let cm = [
                                c0[0] + (c1[0] - c0[0]) * f,
                                c0[1] + (c1[1] - c0[1]) * f,
                                c0[2] + (c1[2] - c0[2]) * f,
                                c0[3] + (c1[3] - c0[3]) * f,
                            ];
                            out.push(ColorStop::from((tm, color(cm, alpha))));
                        }
                    }
                    if let Some(&(tl, cl)) = stops.last() {
                        out.push(ColorStop::from((tl, color(cl, alpha))));
                    }
                    out
                } else {
                    stops
                        .iter()
                        .map(|(offset, c)| ColorStop::from((*offset, color(*c, alpha))))
                        .collect()
                };
                g.stops = ColorStops(expanded_stops.into_iter().collect());
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
                if opacity * alpha <= 0.0 || !bounded(*matrix, 1e12) || !finite(*matrix) {
                    return Ok(false);
                }
                // Device pixels the image's width spans: pick a level at least that wide.
                let span = (device * *matrix).as_coeffs();
                let px = span[0].hypot(span[1]);
                let view = self
                    .backend
                    .image(*image, px)
                    .ok_or_else(|| EngineError::unknown(format!("image {image} isn't held")))?;
                let texel =
                    *matrix * Affine::scale_non_uniform(1.0 / f64::from(view.width), 1.0 / f64::from(view.height));
                if !sampleable(device, texel, region, *tile) {
                    return Ok(false);
                }
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
                scene.set_paint_transform(texel);
            }
            Paint::Placeholder(opacity) => {
                if opacity * alpha <= 0.0 || !bounded(device, 1e12) {
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
                // pixel the page's origin falls in, so a tile and a whole frame draw it alike:
                // within one period of it (16 pixels, as tiles are placed), so its positions stay
                // small however far the view is from the page's origin (a repeat's remainder is
                // exact only for small ones).
                let [.., e, f] = self.frame.view.as_coeffs();
                let anchor = Affine::translate((e.floor().rem_euclid(16.0), f.floor().rem_euclid(16.0)));
                let scene = self.backend.scene();
                scene.set_paint(img.into());
                scene.set_paint_transform(device.inverse() * anchor);
            }
        }
        Ok(true)
    }

    /// Where a record's entry `i` paints, its own units, grown by `grow`: all of it, wherever the
    /// frame or tile is (glyphs included, not only those near the viewport).
    fn region(&self, r: &Record, i: u32, grow: f64) -> Option<Rect> {
        r.entry_bounds(i, &|g| self.store.glyphs.bounds(g))
            .map(|b| b.inflate(grow, grow))
    }

    #[allow(clippy::too_many_arguments)]
    fn fill(
        &mut self,
        r: &Record,
        i: u32,
        device: Affine,
        even_odd: bool,
        paint: &Paint,
        blend: u8,
        alpha: f32,
        allow_glyph_masks: bool,
    ) -> Result<()> {
        if blend != 0 {
            if !paint_visible(paint, alpha) {
                return Ok(());
            }
            let Some(local_b) = r.entry_bounds(i, &|g| self.store.glyphs.bounds(g)) else {
                return Ok(());
            };
            let raw = IRect::around(device.transform_rect_bbox(local_b).inflate(2.0, 2.0));
            let area = raw.intersect(self.backend.target_bounds());
            if area.is_empty() {
                self.flush_if_tiled_overlap(raw);
                return Ok(());
            }
            self.scope()?;
            if !self.backend.push_isolated(area, true, None, &self.open)? {
                return Ok(());
            }
            let prev_open = std::mem::take(&mut self.open);
            let res = self.fill(r, i, device, even_odd, paint, 0, alpha, allow_glyph_masks);
            self.open = prev_open;
            if res.is_ok() {
                self.backend.pop_blended(u32::from(blend), 1.0, &self.open)?;
            } else {
                self.backend.abort_isolated();
            }
            return res;
        }
        if allow_glyph_masks
            && let (Some(PathEntry::Glyphs { scale, glyphs }), Paint::Solid(c), false) =
                (r.paths.get(i as usize), paint, even_odd)
        {
            return self.glyphs(device, f64::from(*scale), glyphs, *c, alpha);
        }
        let p = self.path(r, i, device, 0.0)?;
        if p.is_empty() {
            return Ok(());
        }
        if !self.set_paint(paint, device, alpha, self.region(r, i, 0.0))? {
            return Ok(());
        }
        let sd = self.scene_device(device);
        let scene = self.backend.scene();
        scene.set_transform(sd);
        scene.set_fill_rule(if even_odd { Fill::EvenOdd } else { Fill::NonZero });
        scene.fill_path(&p);
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    fn stroke(
        &mut self,
        r: &Record,
        i: u32,
        device: Affine,
        style: &StrokeStyle,
        paint: &Paint,
        blend: u8,
        alpha: f32,
    ) -> Result<()> {
        if style.width <= 0.0 {
            return Ok(());
        }
        if blend != 0 {
            if !paint_visible(paint, alpha) {
                return Ok(());
            }
            let Some(local_b) = r.entry_bounds(i, &|g| self.store.glyphs.bounds(g)) else {
                return Ok(());
            };
            let grow = f64::from(style.width) * f64::from(style.miter.max(1.0)) * 0.5 + f64::from(style.width) + 1.0;
            let raw = IRect::around(
                device
                    .transform_rect_bbox(local_b.inflate(grow, grow))
                    .inflate(2.0, 2.0),
            );
            let area = raw.intersect(self.backend.target_bounds());
            if area.is_empty() {
                self.flush_if_tiled_overlap(raw);
                return Ok(());
            }
            self.scope()?;
            if !self.backend.push_isolated(area, true, None, &self.open)? {
                return Ok(());
            }
            let prev_open = std::mem::take(&mut self.open);
            let res = self.stroke(r, i, device, style, paint, 0, alpha);
            self.open = prev_open;
            if res.is_ok() {
                self.backend.pop_blended(u32::from(blend), 1.0, &self.open)?;
            } else {
                self.backend.abort_isolated();
            }
            return res;
        }
        if let Some(ring) = stroke_ring(r, i, style) {
            self.spend(ring.elements().len())?;
            if !self.set_paint(paint, device, alpha, self.region(r, i, style.reach()))? {
                return Ok(());
            }
            let sd = self.scene_device(device);
            let scene = self.backend.scene();
            scene.set_transform(sd);
            scene.set_fill_rule(Fill::EvenOdd);
            scene.fill_path(&ring);
            return Ok(());
        }
        // A glyph off the viewport by less than the stroke's reach still shows its stroke.
        let reach = stroke_paint_reach(style);
        let p = self.path(r, i, device, reach)?;
        if p.is_empty() {
            return Ok(());
        }
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
        if !self.set_paint(paint, device, alpha, self.region(r, i, style.reach()))? {
            return Ok(());
        }
        // Zoomed out, vello strokes to a tolerance of a quarter of the path's own units, finer on
        // the device the further out (a fortieth of a pixel at 10%), where most of a dense tile's
        // time went offsetting curves. Under a uniform scale (with any rotation or flip), the
        // stroke of the path scaled to its device size, as wide as it is there, is the same
        // outline: stroked so, it's to the quarter pixel everything else is flattened to. Only the
        // scale is applied first, the translation after, as before: a band or tile of the frame,
        // drawn under another translation, strokes the same outline. A solid paint only (another's
        // place follows the transform).
        let [a, b, c, d, e, f] = device.as_coeffs();
        let (sx, sy) = (a.hypot(b), c.hypot(d));
        let uniform = sx > 0.0
            && sx < 1.0
            && (sx - sy).abs() <= 1e-9 * sx
            && (a * c + b * d).abs() <= 1e-9 * sx * sy
            && matches!(paint, Paint::Solid(_));
        let (p, k, transform) = if uniform {
            let mut q = p;
            q.apply_affine(Affine::new([a, b, c, d, 0.0, 0.0]));
            (q, sx, Affine::translate((e, f)))
        } else {
            (p, 1.0, device)
        };
        let mut s = Stroke::new(f64::from(style.width) * k)
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
            s = s.with_dashes(
                f64::from(style.dash_offset) * k,
                style.dashes.iter().map(|d| f64::from(*d) * k),
            );
        }
        let sd = self.scene_device(transform);
        let scene = self.backend.scene();
        scene.set_transform(sd);
        scene.set_stroke(s);
        scene.stroke_path(&p);
        Ok(())
    }

    fn make_kurbo_stroke(style: &StrokeStyle) -> Stroke {
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
        s
    }

    #[allow(clippy::too_many_arguments)]
    fn drop_shadow(
        &mut self,
        r: &Record,
        paths: &[u32],
        even_odd: bool,
        dx: f32,
        dy: f32,
        blur: f32,
        shadow_color: Rgba,
        blend: u32,
        stroke_style: Option<&StrokeStyle>,
        device: Affine,
        alpha: f32,
        layered: bool,
    ) -> Result<()> {
        let eff_alpha = shadow_color[3] * alpha;
        if eff_alpha <= 0.0 || paths.is_empty() {
            return Ok(());
        }
        if let Some(st) = stroke_style
            && st.width <= 0.0
        {
            return Ok(());
        }
        let view_scale = scale_of(self.frame.view);
        let dx_dev = f64::from(dx) * view_scale;
        let dy_dev = f64::from(dy) * view_scale;
        let sigma_dev = crate::blur::sigma_from_radius(blur) * view_scale as f32;
        let shifted_device = Affine::translate((dx_dev, dy_dev)) * device;
        if blend != 0 {
            let stroke_grow = stroke_style.map_or(0.0, |st| {
                f64::from(st.width) * f64::from(st.miter.max(1.0)) * 0.5 + f64::from(st.width) + 1.0
            });
            let mut bbox: Option<Rect> = None;
            for &pi in paths {
                if let Some(b) = r.entry_bounds(pi, &|g| self.store.glyphs.bounds(g)) {
                    let lb = if stroke_grow > 0.0 {
                        b.inflate(stroke_grow, stroke_grow)
                    } else {
                        b
                    };
                    let db = shifted_device.transform_rect_bbox(lb);
                    bbox = Some(bbox.map_or(db, |o| o.union(db)));
                }
            }
            let Some(bbox) = bbox else {
                return Ok(());
            };
            let reach = f64::from(crate::blur::kernel_radius(sigma_dev)) + 2.0;
            let raw = IRect::around(bbox.inflate(reach, reach));
            let dirty = raw.intersect(self.backend.target_bounds());
            if dirty.is_empty() {
                self.flush_if_tiled_overlap(raw);
                return Ok(());
            }
            self.scope()?;
            if !self.backend.push_isolated(dirty, true, None, &self.open)? {
                return Ok(());
            }
            let prev_open = std::mem::take(&mut self.open);
            let res = self.drop_shadow(
                r,
                paths,
                even_odd,
                dx,
                dy,
                blur,
                shadow_color,
                0,
                stroke_style,
                device,
                alpha,
                layered,
            );
            while let Some(o) = self.open.pop() {
                match o {
                    Open::Clip { .. } => self.backend.scene().pop_clip(),
                    Open::Layer => self.backend.scene().pop_layer(),
                }
            }
            self.open = prev_open;
            if res.is_ok() {
                self.backend.pop_blended(blend, 1.0, &self.open)?;
            } else {
                self.backend.abort_isolated();
            }
            return res;
        }
        let tint = color(shadow_color, alpha);

        // Zero blur: draw shadow geometry directly with no offscreen pass.
        if crate::blur::kernel_radius(sigma_dev) == 0 {
            let mut combined = BezPath::new();
            let reach = stroke_style.map_or(0.0, |st| f64::from(st.width) * f64::from(st.miter.max(1.0)) + 1.0);
            for &pi in paths {
                let p = self.path(r, pi, shifted_device, reach)?;
                combined.extend(p);
            }
            if combined.is_empty() {
                return Ok(());
            }
            if let Some(st) = stroke_style {
                if !st.dashes.is_empty() {
                    let length = polygon_length(&combined);
                    crate::record::check_dashes(
                        st,
                        length,
                        &crate::limits::Limits {
                            frame_verbs: self.verbs_left,
                            ..self.store.limits
                        },
                    )?;
                    let period: f64 = st.dashes.iter().map(|d| f64::from(*d)).sum();
                    self.spend((length / period * st.dashes.len() as f64).ceil() as usize)?;
                }
                let s = Self::make_kurbo_stroke(st);
                let sd = self.scene_device(shifted_device);
                let scene = self.backend.scene();
                scene.reset_paint_transform();
                scene.set_paint(tint.into());
                scene.set_transform(sd);
                scene.set_stroke(s);
                scene.stroke_path(&combined);
            } else {
                let sd = self.scene_device(shifted_device);
                let scene = self.backend.scene();
                scene.reset_paint_transform();
                scene.set_paint(tint.into());
                scene.set_transform(sd);
                scene.set_fill_rule(if even_odd { Fill::EvenOdd } else { Fill::NonZero });
                scene.fill_path(&combined);
            }
            return Ok(());
        }

        // Stacked shadows accumulate the analytic approximation's error. Use the
        // reference masks for the stack, retaining the fast path for single shadows.
        if !layered
            && stroke_style.is_none()
            && paths.len() == 1
            && let Some((rect, radius)) = r.entry_uniform_rect(paths[0])
            && let Some(local_scale) = crate::shadow::similarity_scale(device)
        {
            let w_dev = (rect.width() * local_scale) as f32;
            let h_dev = (rect.height() * local_scale) as f32;
            let r_dev = (f64::from(radius) * local_scale) as f32;
            if crate::shadow::can_use_analytic_shadow(w_dev, h_dev, r_dev, sigma_dev, eff_alpha, false) {
                let pad_local = (f64::from(crate::blur::kernel_radius(sigma_dev)) + 2.0) / local_scale;
                let outer = geometry::rect_path(rect.inflate(pad_local, pad_local));
                let std_dev = (f64::from(sigma_dev) / local_scale) as f32 * core::f32::consts::SQRT_2;
                let sd = self.scene_device(shifted_device);
                let scene = self.backend.scene();
                scene.reset_paint_transform();
                scene.set_paint(tint.into());
                scene.set_transform(sd);
                scene.set_fill_rule(Fill::NonZero);
                scene.fill_blurred_rounded_rect_in(&outer, &rect, radius, std_dev, false);
                return Ok(());
            }
        }

        // General reference Gaussian blur over the rasterised cast mask (with canonical caching).
        let margin_local = {
            let s = scale_of(device).max(1e-6);
            (f64::from(crate::shadow::blur_support_pad(sigma_dev)) + 2.0) / s
        };
        if let Some(st) = stroke_style {
            let stroke_grow = f64::from(st.width) * f64::from(st.miter.max(1.0)) + 1.0;
            let mut local_paths = Vec::with_capacity(paths.len());
            let mut bbox: Option<Rect> = None;
            for &pi in paths {
                let p = self.path(r, pi, shifted_device, margin_local + stroke_grow)?;
                if p.is_empty() {
                    continue;
                }
                if !st.dashes.is_empty() {
                    let length = polygon_length(&p);
                    crate::record::check_dashes(
                        st,
                        length,
                        &crate::limits::Limits {
                            frame_verbs: self.verbs_left,
                            ..self.store.limits
                        },
                    )?;
                    let period: f64 = st.dashes.iter().map(|d| f64::from(*d)).sum();
                    self.spend((length / period * st.dashes.len() as f64).ceil() as usize)?;
                }
                use vello_common::kurbo::Shape;
                let b = shifted_device.transform_rect_bbox(p.bounding_box().inflate(stroke_grow, stroke_grow));
                bbox = Some(bbox.map_or(b, |o| o.union(b)));
                local_paths.push(p);
            }
            let Some(bbox) = bbox else {
                return Ok(());
            };
            let reach = f64::from(crate::blur::kernel_radius(sigma_dev)) + 2.0;
            let dirty = IRect::around(bbox.inflate(reach, reach)).intersect(self.backend.target_bounds());
            if dirty.is_empty() {
                return Ok(());
            }
            let cast = ShadowCast::Stroke {
                paths: &local_paths,
                transform: shifted_device,
                stroke: Self::make_kurbo_stroke(st),
                bbox,
            };
            let open = self.open.clone();
            return self
                .backend
                .draw_blurred_shadow(&cast, None, false, dirty, sigma_dev, tint, &open);
        }

        let canonical = if paths.len() == 1 {
            r.entry_canonical_shape(paths[0])
                .and_then(|sh| crate::shadow::canonical_shadow(sh, shifted_device, sigma_dev, false))
        } else {
            None
        };

        let mut dev_paths = Vec::with_capacity(paths.len());
        let mut bbox: Option<Rect> = None;
        for &pi in paths {
            let mut p = self.path(r, pi, shifted_device, margin_local)?;
            if p.is_empty() {
                continue;
            }
            p.apply_affine(shifted_device);
            use vello_common::kurbo::Shape;
            let b = p.bounding_box();
            bbox = Some(bbox.map_or(b, |o| o.union(b)));
            dev_paths.push(p);
        }
        let Some(bbox) = bbox else {
            return Ok(());
        };
        let reach = f64::from(crate::blur::kernel_radius(sigma_dev)) + 2.0;
        let dirty = IRect::around(bbox.inflate(reach, reach)).intersect(self.backend.target_bounds());
        if dirty.is_empty() {
            return Ok(());
        }
        let cast = ShadowCast::Fill {
            paths: &dev_paths,
            even_odd,
        };
        let open = self.open.clone();
        self.backend
            .draw_blurred_shadow(&cast, canonical.as_ref(), false, dirty, sigma_dev, tint, &open)
    }

    #[allow(clippy::too_many_arguments)]
    fn inner_shadow(
        &mut self,
        r: &Record,
        shape: u32,
        hole: Option<u32>,
        even_odd: bool,
        dx: f32,
        dy: f32,
        blur: f32,
        shadow_color: Rgba,
        blend: u32,
        device: Affine,
        alpha: f32,
    ) -> Result<()> {
        let eff_alpha = shadow_color[3] * alpha;
        if eff_alpha <= 0.0 {
            return Ok(());
        }
        if blend != 0 {
            let Some(local_b) = r.entry_bounds(shape, &|g| self.store.glyphs.bounds(g)) else {
                return Ok(());
            };
            let raw = IRect::around(device.transform_rect_bbox(local_b).inflate(2.0, 2.0));
            let dirty = raw.intersect(self.backend.target_bounds());
            if dirty.is_empty() {
                self.flush_if_tiled_overlap(raw);
                return Ok(());
            }
            self.scope()?;
            if !self.backend.push_isolated(dirty, true, None, &self.open)? {
                return Ok(());
            }
            let prev_open = std::mem::take(&mut self.open);
            let res = self.inner_shadow(r, shape, hole, even_odd, dx, dy, blur, shadow_color, 0, device, alpha);
            while let Some(o) = self.open.pop() {
                match o {
                    Open::Clip { .. } => self.backend.scene().pop_clip(),
                    Open::Layer => self.backend.scene().pop_layer(),
                }
            }
            self.open = prev_open;
            if res.is_ok() {
                self.backend.pop_blended(blend, 1.0, &self.open)?;
            } else {
                self.backend.abort_isolated();
            }
            return res;
        }
        let shape_local = self.path(r, shape, device, 0.0)?;
        if shape_local.is_empty() {
            return Ok(());
        }
        let tint = color(shadow_color, alpha);

        // Spread shrank the hole to empty: the entire shape fills with shadow color.
        let Some(hole_idx) = hole else {
            let sd = self.scene_device(device);
            let scene = self.backend.scene();
            scene.reset_paint_transform();
            scene.set_paint(tint.into());
            scene.set_transform(sd);
            scene.set_fill_rule(if even_odd { Fill::EvenOdd } else { Fill::NonZero });
            scene.fill_path(&shape_local);
            return Ok(());
        };

        let view_scale = scale_of(self.frame.view);
        let dx_dev = f64::from(dx) * view_scale;
        let dy_dev = f64::from(dy) * view_scale;
        let sigma_dev = crate::blur::sigma_from_radius(blur) * view_scale as f32;
        let shifted_device = Affine::translate((dx_dev, dy_dev)) * device;

        // Zero blur: clip to `shape`, fill outer box minus shifted `hole` (even-odd).
        if crate::blur::kernel_radius(sigma_dev) == 0 {
            use vello_common::kurbo::Shape;
            let mut shape_dev = shape_local.clone();
            shape_dev.apply_affine(device);
            let mut hole_dev = self.path(r, hole_idx, shifted_device, 0.0)?;
            hole_dev.apply_affine(shifted_device);
            let outer = shape_dev
                .bounding_box()
                .union(hole_dev.bounding_box())
                .inflate(4.0, 4.0);
            let mut ring_dev = geometry::rect_path(outer);
            ring_dev.extend(hole_dev);
            let (sox, soy) = self.backend.scene_offset();
            let scene_shift = Affine::translate((-f64::from(sox), -f64::from(soy)));
            self.scope()?;
            let scene = self.backend.scene();
            scene.set_transform(scene_shift * device);
            scene.set_fill_rule(if even_odd { Fill::EvenOdd } else { Fill::NonZero });
            scene.push_clip_path(&shape_local);
            scene.reset_paint_transform();
            scene.set_paint(tint.into());
            scene.set_transform(scene_shift);
            scene.set_fill_rule(Fill::EvenOdd);
            scene.fill_path(&ring_dev);
            scene.pop_clip();
            return Ok(());
        }

        // Measured Vello analytic fast path for uniform rounded rectangle holes.
        if let Some((hole_rect, hole_radius)) = r.entry_uniform_rect(hole_idx)
            && let Some(local_scale) = crate::shadow::similarity_scale(device)
        {
            let w_dev = (hole_rect.width() * local_scale) as f32;
            let h_dev = (hole_rect.height() * local_scale) as f32;
            let r_dev = (f64::from(hole_radius) * local_scale) as f32;
            if crate::shadow::can_use_analytic_shadow(w_dev, h_dev, r_dev, sigma_dev, eff_alpha, true) {
                let std_dev = (f64::from(sigma_dev) / local_scale) as f32 * core::f32::consts::SQRT_2;
                let mut shape_in_shifted = shape_local.clone();
                shape_in_shifted.apply_affine(shifted_device.inverse() * device);
                let sd = self.scene_device(shifted_device);
                let scene = self.backend.scene();
                scene.reset_paint_transform();
                scene.set_paint(tint.into());
                scene.set_transform(sd);
                scene.set_fill_rule(if even_odd { Fill::EvenOdd } else { Fill::NonZero });
                scene.fill_blurred_rounded_rect_in(&shape_in_shifted, &hole_rect, hole_radius, std_dev, true);
                return Ok(());
            }
        }

        // General reference Gaussian blur of shifted hole mask, inverted, clipped to `shape`.
        use vello_common::kurbo::Shape;
        let mut shape_dev = shape_local.clone();
        shape_dev.apply_affine(device);
        let dirty = IRect::around(shape_dev.bounding_box().inflate(1.0, 1.0)).intersect(self.backend.target_bounds());
        if dirty.is_empty() {
            return Ok(());
        }
        let canonical = r
            .entry_canonical_shape(hole_idx)
            .and_then(|sh| crate::shadow::canonical_shadow(sh, shifted_device, sigma_dev, true));
        let mut hole_dev = self.path(r, hole_idx, shifted_device, 0.0)?;
        hole_dev.apply_affine(shifted_device);
        self.scope()?;
        let sd = self.scene_device(device);
        {
            let scene = self.backend.scene();
            scene.set_transform(sd);
            scene.set_fill_rule(if even_odd { Fill::EvenOdd } else { Fill::NonZero });
            scene.push_clip_path(&shape_local);
        }
        self.open.push(Open::Clip {
            transform: sd,
            path: shape_local,
            even_odd,
        });
        let open = self.open.clone();
        let hole_slice = [hole_dev];
        let cast = ShadowCast::Fill {
            paths: &hole_slice,
            even_odd,
        };
        let res = self
            .backend
            .draw_blurred_shadow(&cast, canonical.as_ref(), true, dirty, sigma_dev, tint, &open);
        self.open.pop();
        self.backend.scene().pop_clip();
        res
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
        // The run's place on the device is the same for every glyph but its offset: whether masks
        // can be used at all, and their scale, are the run's.
        let [a, b, cc, d, _, _] = (device * Affine::new([s, 0.0, 0.0, -s, 0.0, 0.0])).as_coeffs();
        let axis_aligned = b.abs() <= 1e-9 * (a.abs() + d.abs()) && cc.abs() <= 1e-9 * (a.abs() + d.abs());
        let (sx, sy) = ((a as f32).to_bits(), (d as f32).to_bits());
        // Masks placed, each at its device pixel, with the glyph it's of: laid into one image of
        // the run and drawn once (`masks::compose_run`), so a run's overlaps are covered once, as
        // one shape's are (Figma's text: `text-overlap` in the parity suites).
        let mut placed: Vec<(std::sync::Arc<vello_cpu::Pixmap>, i32, i32)> = Vec::new();
        let mut of: Vec<usize> = Vec::new();
        let whole = self.backend.whole_runs();
        for (n, g) in glyphs.iter().enumerate() {
            let Some(glyph) = self.store.glyphs.get(g.glyph) else {
                return Err(EngineError::unknown(format!("glyph {}", g.glyph)));
            };
            let Some(gb) = glyph.bounds else { continue };
            let m = device * Affine::new([s, 0.0, 0.0, -s, f64::from(g.x), f64::from(g.y)]);
            let [_, _, _, _, e, f] = m.as_coeffs();
            let small = gb.width() * a.abs() <= self.glyph_mask_side && gb.height() * d.abs() <= self.glyph_mask_side;
            let maskable = masks && axis_aligned && small && e.abs() < 1.0e7 && f.abs() < 1.0e7;
            // Out of view, a glyph matters only to a whole run's image.
            let in_view = overlaps(m.transform_rect_bbox(gb), self.viewport);
            if !in_view && !(whole && maskable) {
                continue;
            }
            if maskable {
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
                    sx,
                    sy,
                    px: px as u8,
                    py: py as u8,
                };
                if let Some((mask, origin)) =
                    self.backend
                        .glyph_mask(key, &glyph.path, (a, d), (px / PHASES, py / PHASES))
                {
                    placed.push((mask, ix as i32 + origin.0, iy as i32 + origin.1));
                    of.push(n);
                    continue;
                }
            }
            if in_view {
                self.outline(g, s, &mut outlines)?;
            }
        }
        if !placed.is_empty() && !self.draw_run(&placed, tint) {
            // No room for the run's image: its glyphs fill their outlines.
            for &n in &of {
                self.outline(&glyphs[n], s, &mut outlines)?;
            }
        }
        if !outlines.is_empty() {
            let sd = self.scene_device(device);
            let scene = self.backend.scene();
            scene.reset_paint_transform();
            scene.set_paint(tint.into());
            scene.set_transform(sd);
            scene.set_fill_rule(Fill::NonZero);
            scene.fill_path(&outlines);
        }
        Ok(())
    }

    /// Adds a glyph's outline, placed in its run, to `outlines`, charged to the frame's budget.
    fn outline(&mut self, g: &crate::record::GlyphInstance, s: f64, outlines: &mut BezPath) -> Result<()> {
        let Some(glyph) = self.store.glyphs.get(g.glyph) else {
            return Err(EngineError::unknown(format!("glyph {}", g.glyph)));
        };
        self.spend(glyph.path.elements().len())?;
        let mut p = glyph.path.clone();
        p.apply_affine(Affine::new([s, 0.0, 0.0, -s, f64::from(g.x), f64::from(g.y)]));
        outlines.extend(p);
        self.stats.glyphs_outlined += 1;
        Ok(())
    }

    /// Draws a run's masks, laid into one image, tinted: answers false when the backend has no
    /// room for the image (nothing drawn). The image is cut to the viewport unless the backend
    /// makes runs whole (`Backend::whole_runs`), when it's the whole run's, at most
    /// `WHOLE_RUN_PIXELS` (else its glyphs fill their outlines, as one shape still).
    fn draw_run(&mut self, placed: &[(std::sync::Arc<vello_cpu::Pixmap>, i32, i32)], tint: AlphaColor<Srgb>) -> bool {
        let (mut x0, mut y0, mut x1, mut y1) = (i32::MAX, i32::MAX, i32::MIN, i32::MIN);
        for (m, x, y) in placed {
            x0 = x0.min(*x);
            y0 = y0.min(*y);
            x1 = x1.max(x + i32::from(m.width()));
            y1 = y1.max(y + i32::from(m.height()));
        }
        if self.backend.whole_runs() {
            if i64::from(x1 - x0) * i64::from(y1 - y0) > WHOLE_RUN_PIXELS {
                return false;
            }
        } else {
            let v = self.viewport;
            x0 = x0.max(v.x0.floor() as i32);
            y0 = y0.max(v.y0.floor() as i32);
            x1 = x1.min(v.x1.ceil() as i32);
            y1 = y1.min(v.y1.ceil() as i32);
        }
        if x1 <= x0 || y1 <= y0 {
            return true;
        }
        let (Ok(w), Ok(h)) = (u16::try_from(x1 - x0), u16::try_from(y1 - y0)) else {
            return false;
        };
        let mut pixels = Vec::new();
        crate::masks::compose_run(placed, (x0, y0, x1, y1), &mut pixels);
        let Some(source) = self.backend.run_image(w, h, pixels) else {
            return false;
        };
        let (sox, soy) = self.backend.scene_offset();
        let rx0 = f64::from(x0 - sox);
        let ry0 = f64::from(y0 - soy);
        let rx1 = f64::from(x1 - sox);
        let ry1 = f64::from(y1 - soy);
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
        scene.set_transform(Affine::IDENTITY);
        scene.set_tint(Some(Tint {
            color: tint,
            mode: TintMode::AlphaMask,
        }));
        scene.set_paint_transform(Affine::translate((rx0, ry0)));
        scene.fill_rect(&Rect::new(rx0, ry0, rx1, ry1));
        scene.set_tint(None);
        self.stats.glyphs_masked += placed.len() as u32;
        true
    }
}

/// A stroke of a box (its corners round or not) as the ring it paints: the box grown by half the
/// width, less the box shrunk by it, filled even-odd. The same outline the stroker makes, without
/// offsetting curves for every tile it's drawn into (a tenth of a cold tile's time on pages of
/// cards). Only where the join can't matter: every corner rounder than half the width (the
/// outline is smooth there), or every corner square under a miter join that holds at a right
/// angle (the outer corner is the box's) or a round one (rounded by half the width). Not for
/// dashes. None where the stroker is needed.
fn stroke_ring(r: &Record, i: u32, style: &StrokeStyle) -> Option<BezPath> {
    let Some(PathEntry::Rect { w, h, radii, smoothing }) = r.paths.get(i as usize) else {
        return None;
    };
    let (w, h) = (f64::from(*w), f64::from(*h));
    if *smoothing != 0.0 || !style.dashes.is_empty() || !(w > 0.0 && h > 0.0) {
        return None;
    }
    let half = f64::from(style.width) / 2.0;
    let fitted = geometry::fit_radii(w, h, radii.map(f64::from));
    let square = fitted.iter().all(|r| *r == 0.0);
    let outer_round = if fitted.iter().all(|r| *r >= half) {
        fitted.map(|r| r + half)
    } else if square && style.join == 0 && style.miter.max(1.0) >= core::f32::consts::SQRT_2 {
        [0.0; 4]
    } else if square && style.join == 1 {
        [half; 4]
    } else {
        return None;
    };
    let mut ring = geometry::rounded_rect_at((-half, -half), w + 2.0 * half, h + 2.0 * half, outer_round);
    if w > 2.0 * half && h > 2.0 * half {
        let inner = fitted.map(|r| (r - half).max(0.0));
        ring.extend(geometry::rounded_rect_at(
            (half, half),
            w - 2.0 * half,
            h - 2.0 * half,
            inner,
        ));
    }
    Some(ring)
}

/// Conservative local-space reach around a stroked path's bounding box, shared by draw-time
/// diamond rasterization and export preflight admission.
pub(crate) fn stroke_paint_reach(style: &StrokeStyle) -> f64 {
    if style.width <= 0.0 {
        0.0
    } else {
        f64::from(style.width) * f64::from(style.miter.max(1.0)) + 1.0
    }
}

/// Device-pixel rectangle that a diamond gradient rasterizes for `local_bounds` under `device`,
/// clipped to `clip_area`. Shared by draw-time rasterization and export preflight admission.
pub(crate) fn diamond_device_rect(local_bounds: Option<Rect>, device: Affine, clip_area: IRect) -> IRect {
    let dev_rect = local_bounds
        .map(|b| IRect::around(device.transform_rect_bbox(b).inflate(1.0, 1.0)))
        .unwrap_or(clip_area);
    IRect {
        x0: dev_rect.x0.max(clip_area.x0),
        y0: dev_rect.y0.max(clip_area.y0),
        x1: dev_rect.x1.min(clip_area.x1),
        y1: dev_rect.y1.min(clip_area.y1),
    }
}

/// Normal blending, for the record of what the engine composites by itself.
pub fn normal() -> BlendMode {
    BlendMode::new(Mix::Normal, Compose::SrcOver)
}
