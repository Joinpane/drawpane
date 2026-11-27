//! Draws the render graph on a backend. The same code drives both: Vello's CPU and GPU scenes
//! take the same drawing calls, and what differs (where images and glyph masks live, how a
//! backdrop reader gets the pixels beneath it) is the `Backend` trait.
//!
//! The canvas renderer is the specification (`packages/editor/src/render.ts`): a record is
//! drawn in its parent's transform and opacity; a record that fades as one is an isolating
//! opacity group; otherwise opacity multiplies down into its paints and children. Clips are
//! clip paths, which don't isolate. Culling uses the engine's own subtree bounds.
//!
//! Stacked glass (decision 0007 amendment) and export context (decision 0039) share one dual-target
//! model when a frame has backdrop readers or `FLAG_CONTEXT`:
//! - A glass op writes only to the visible output (`main`), never to the backdrop (`backdrop`)
//!   read by subsequent readers.
//! - Non-glass fills, strokes, children, and earlier `background-blur` ops write to both `main`
//!   and `backdrop` up to the last reader in paint order, then only to `main`.
//! - `FLAG_CONTEXT` records write only to `backdrop` (skipping their own glass ops) and their
//!   clips bound `clip_within` without clipping non-context output.

use crate::error::{EngineError, Result};
use crate::geometry;
use crate::glass;
use crate::limits::Limits;
use crate::masks::{MaskKey, PHASES};
use crate::record::{
    BackgroundBlurOp, ComposeMode, GlassOp, GradientKind, Op, Paint, PathEntry, PostEffect, ProgressiveBlurOp, Record,
    Rgba, StrokeStyle,
};
use crate::store::Store;
use std::collections::{HashMap, HashSet};
use vello_common::color::{AlphaColor, Srgb};
use vello_common::kurbo::{Affine, BezPath, Rect, Stroke};
use vello_common::paint::{Image, ImageSource, PaintType, Tint, TintMode};
use vello_common::peniko::{
    BlendMode, ColorStop, ColorStops, Compose, Extend, Fill, Gradient, ImageQuality, ImageSampler,
    InterpolationAlphaSpace, Mix,
};

/// Fixed-function hardware blend modes supported directly inside `vello_gpu`'s strip pass
/// over an opaque target (backdrop alpha == 1).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum HwBlend {
    #[default]
    Normal,
    Multiply,
    Screen,
    LinearDodge,
    LinearBurn,
}

/// Maps a wire blend mode (`1..=17`, matching `BLEND` in `wire.ts` and `blend.rs`) to its
/// fixed-function hardware blend mode, if one exists.
#[inline]
pub const fn hw_blend_mode(blend: u32) -> Option<HwBlend> {
    match blend {
        1 => Some(HwBlend::Multiply),
        2 => Some(HwBlend::Screen),
        16 => Some(HwBlend::LinearDodge),
        17 => Some(HwBlend::LinearBurn),
        _ => None,
    }
}

/// What Vello's two scene types share, as the executor uses it.
pub trait Draw {
    fn set_transform(&mut self, t: Affine);
    fn set_paint(&mut self, p: PaintType);
    fn set_paint_transform(&mut self, t: Affine);
    fn reset_paint_transform(&mut self);
    fn set_tint(&mut self, t: Option<Tint>);
    fn set_fill_rule(&mut self, rule: Fill);
    fn set_stroke(&mut self, s: Stroke);
    fn set_hw_blend(&mut self, _mode: HwBlend) {}
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
    ($t:ty $(, hw_blend: $hw:expr)?) => {
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
            $(
                fn set_hw_blend(&mut self, mode: crate::exec::HwBlend) {
                    ($hw)(self, mode);
                }
            )?
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

/// Axis-aligned device box of a clipping frame, plus its innermost opaque solid fill if any
/// (decision 0007: glass and background blur stop at clipping frames and see their solid fill
/// beyond the edge).
#[derive(Clone, Copy, Debug)]
pub struct FrameClip {
    pub device_box: Rect,
    pub fill: Option<[u8; 4]>,
}

/// Stable geometry identity for `Open::Clip` within one `Store` generation.
/// Viewport-dependent `PathEntry` variants (`Glyphs`, `Outside`) return `None`.
#[inline]
fn clip_source(id: u32, r: &Record, path_idx: u32) -> Option<(u32, u32)> {
    match r.paths.get(path_idx as usize) {
        Some(PathEntry::Glyphs { .. } | PathEntry::Outside(_)) | None => None,
        Some(_) => Some((id, path_idx)),
    }
}

/// Something open in the scene where a backdrop reader runs, so a backend that renders what's
/// drawn so far can reopen it after.
#[derive(Clone)]
pub enum Open {
    Clip {
        transform: Affine,
        path: BezPath,
        even_odd: bool,
        frame_clip: Option<FrameClip>,
        /// Stable geometry identity `(record_id, path_idx)` within one `Store` generation for
        /// viewport-independent `PathEntry` variants (`None` for `Glyphs` / `Outside` / synthetic).
        source: Option<(u32, u32)>,
        /// True for clips belonging to an export-context ancestor (`FLAG_CONTEXT`): clips context
        /// drawing and bounds `clip_within`, never clips exported non-context output.
        context_only: bool,
        /// True while currently pushed onto `backend.scene()`.
        active_on_scene: bool,
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
    #[cfg(feature = "gpu-common")]
    pub(crate) fn contains_rect(self, o: Self) -> bool {
        self.x0 <= o.x0 && self.y0 <= o.y0 && self.x1 >= o.x1 && self.y1 >= o.y1
    }
    pub(crate) fn translate(self, x: i32, y: i32) -> Self {
        Self {
            x0: self.x0 + x,
            y0: self.y0 + y,
            x1: self.x1 + x,
            y1: self.y1 + y,
        }
    }
    pub(crate) fn size(self) -> (u32, u32) {
        ((self.x1 - self.x0) as u32, (self.y1 - self.y0) as u32)
    }
    /// Restrict a reader's scratch to its input region in this plane. Retain the
    /// nearest edge texel if the requested extent is wholly beyond the plane.
    pub(crate) fn reader_crop(self, reads: Self) -> Self {
        let x0 = reads.x0.clamp(self.x0, self.x1 - 1);
        let y0 = reads.y0.clamp(self.y0, self.y1 - 1);
        Self {
            x0,
            y0,
            x1: reads.x1.clamp(x0 + 1, self.x1),
            y1: reads.y1.clamp(y0 + 1, self.y1),
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
    Fill {
        paths: &'a [BezPath],
        even_odd: bool,
        /// Device-space bounds before tile culling, to anchor CPU rasterization.
        raster_bounds: Rect,
    },
    /// Stroked local-space paths under `transform` (open stroke-only layers).
    Stroke {
        paths: &'a [BezPath],
        transform: Affine,
        stroke: Stroke,
        /// Approximate device-space bounding box of the stroked paths.
        bbox: Rect,
    },
}

/// Limits for drawing a layer blur at device resolution (`Backend::reduced_layer_blur_limits`).
#[derive(Clone, Copy, Debug)]
pub struct ReducedBlurLimits {
    /// The reduced grid's longest side, in grid texels.
    pub replay_side: u32,
    /// The longest side of a device-resolution blur source.
    pub native_side: u32,
    /// The most pixels of a device-resolution blur source.
    pub native_pixels: usize,
}

/// Where a reduced-grid layer blur comes from (`Backend::composite_reduced_post`).
pub enum ReducedPost<'a> {
    /// The far tier kept this scope's blurred picture (case L3).
    Captured(u32),
    /// The top offscreen target holds the scope drawn on a reduced grid: apply `steps` (through
    /// the last layer blur) there, then upsample from grid spacing `divisor` whose texel (0, 0)
    /// sits at device `origin` (case L2).
    Top {
        steps: &'a [PostStep],
        origin: (f64, f64),
        divisor: i32,
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

/// How an isolated picture reads and where its result goes when the scope closes.
#[derive(Clone, Copy, Debug)]
pub struct Isolation {
    pub on_main: bool,
    pub on_backdrop: bool,
    pub separate: bool,
    pub copy_parent: bool,
    /// This picture's nested readers can see the prefix behind the picture.
    pub inherit_prefix: bool,
    /// An export selection crosses this faded context scope and keeps its own opacity.
    pub unfaded_main: bool,
}

/// Readers sample the base prefix (the root for None) with the listed glass-free interiors
/// composited over it in paint order.
pub fn reader_backdrop_layers<T>(
    scopes: &[T],
    read_parent: bool,
    isolation: impl Fn(&T) -> Isolation,
) -> (Option<usize>, Vec<usize>) {
    let mut base = None;
    let mut interiors = Vec::new();
    let mut copied = false;
    for (index, scope) in scopes.iter().enumerate().rev().skip(usize::from(read_parent)) {
        if !copied && let Some(interior) = base.replace(index) {
            interiors.push(interior);
        }
        let scope = isolation(scope);
        // A fading pass-through picture starts with the immediate parent's pixels. Keep
        // following that parent's scope rule, without blending those pixels into it again.
        copied = scope.copy_parent;
        if !scope.inherit_prefix && !copied {
            interiors.reverse();
            return (base, interiors);
        }
    }
    if !copied {
        interiors.extend(base.take());
    }
    interiors.reverse();
    (base, interiors)
}

pub trait Backend {
    fn scene(&mut self) -> &mut dyn Draw;
    fn mark_dirty(&mut self) {}
    /// Whether this backend can execute fixed-function hardware blending directly inside the
    /// active strip pass on the current target (true only on GPU when enabled and every active
    /// destination plane is guaranteed opaque). CPU and Worker export backends return false.
    fn can_hw_blend(&self) -> bool {
        false
    }
    /// Called before a root-level destructive `Op::Layer` (`DestOut` / `DestIn` with no enclosing
    /// `SrcOver` layer) so GPU backends flush pending HW-blended strips before `vello_gpu`
    /// promotes the root command stream to a blend target and mark the active target non-opaque.
    fn before_destructive_root_layer(&mut self, _open: &[Open]) -> Result<()> {
        Ok(())
    }
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
    fn image(&mut self, id: u32, span: (f64, f64)) -> Option<ImageView>;
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

    /// Prepares the backend for a frame with backdrop readers or export context.
    fn begin_readers(&mut self, _needs_backdrop: bool, _has_context: bool) -> Result<()> {
        Ok(())
    }
    /// Snapshots `main` into `backdrop` right before the first glass op (when `!has_context`).
    fn snapshot_backdrop(&mut self, _open: &[Open]) -> Result<()> {
        Ok(())
    }
    /// Whether the backend has captured what it needed and the current walk should unwind early
    /// (used for fractional clip edge-strip captures in reduced halo mode).
    fn stop_early(&self) -> bool {
        false
    }
    /// Whether the walk draws a rough stand-in (an overview tile, never shown at rest): no
    /// readers, shadows, layer effects or blend modes, group opacity unisolated, and anything
    /// under `ROUGH_SPECK` device pixels skipped. It is never exact.
    fn rough(&self) -> bool {
        false
    }
    /// Whether the caller's per-frame CPU budget has expired and a resumable walk should yield
    /// cooperatively at the next safe boundary (outside isolated and masked scopes).
    fn deadline_reached(&self) -> bool {
        false
    }
    /// Switches which targets subsequent scene draws write into, flushing pending scene ops first.
    fn set_targets(&mut self, _write_main: bool, _write_backdrop: bool, _open: &[Open]) -> Result<()> {
        Ok(())
    }
    /// Runs a test backdrop reader kernel over what's drawn so far (`open` is open in the scene).
    fn read(&mut self, kernel: u32, paints: IRect, reads: IRect, open: &[Open]) -> Result<()>;
    /// Draws a lens from the current glass-free picture into the main picture.
    #[allow(clippy::too_many_arguments)]
    fn glass(
        &mut self,
        key: (u32, usize),
        op: &GlassOp,
        paths: &[(BezPath, bool)],
        device: Affine,
        size: [f32; 2],
        alpha: f32,
        coarse: bool,
        read_parent: bool,
        open: &[Open],
    ) -> Result<()>;
    /// Runs Gaussian background blur over the current non-glass backdrop (`open` is open in the scene).
    #[allow(clippy::too_many_arguments)]
    fn background_blur(
        &mut self,
        key: Option<(u32, usize)>,
        op: &BackgroundBlurOp,
        paths: &[(BezPath, bool)],
        device: Affine,
        size: [f32; 2],
        alpha: f32,
        coarse: bool,
        open: &[Open],
    ) -> Result<()>;
    /// Runs progressive background blur over the current non-glass backdrop (`open` is open in the scene).
    #[allow(clippy::too_many_arguments)]
    fn progressive_blur(
        &mut self,
        key: (u32, usize),
        op: &ProgressiveBlurOp,
        paths: &[(BezPath, bool)],
        device: Affine,
        size: [f32; 2],
        alpha: f32,
        coarse: bool,
        open: &[Open],
    ) -> Result<()>;
    /// Pushes an offscreen target covering `area` (device pixels), flushing the active
    /// scene first. When `clip_to_parent` is true, `area` is intersected with `target_bounds()`;
    /// when false (e.g. layer blur needing halo pixels outside a tile or frame edge), `area` is
    /// used as-is and `scene_origin_hint` provides a tile-independent CPU scene origin.
    /// Returns `false` if the resulting target is empty.
    fn push_isolated(
        &mut self,
        area: IRect,
        clip_to_parent: bool,
        scene_origin_hint: Option<(i32, i32)>,
        isolation: Isolation,
        open: &[Open],
    ) -> Result<bool>;
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
    /// Discards the active offscreen target without compositing: on error unwind, or when the
    /// walk stops early inside it (an edge-strip capture). The parent's scene starts afresh, so
    /// the clips `open` keeps on it go back on, as after a pop.
    fn abort_isolated(&mut self, open: &[Open]);
    /// Whether this backend draws view blurs of any sigma (the GPU view pyramid, layer blurs on a
    /// reduced grid past the native limits). CPU and Worker exports keep the native limits.
    fn allow_unbounded_view_blur(&self) -> bool {
        false
    }
    /// Limits for a layer blur drawn at device resolution before it switches to a reduced grid.
    fn reduced_layer_blur_limits(&self) -> ReducedBlurLimits {
        ReducedBlurLimits {
            replay_side: crate::halo::HALO_REPLAY_SIDE,
            native_side: 8192,
            native_pixels: usize::MAX,
        }
    }
    /// In a far-tier capture pass, the tier's `(render_divisor, visible, frame_size)` when
    /// `record_id` is a coarse post scope whose blurred output the tier keeps (case L3).
    fn capturing_coarse_post_scope(&self, _record_id: u32) -> Option<(i32, IRect, (i32, i32))> {
        None
    }
    /// Enters (`1`) or leaves (`-1`) a coarse post scope during capture: glass inside draws
    /// straight into the scope's reduced picture.
    fn set_inside_coarse_post_scope(&mut self, _delta: i32) {}
    /// Keeps the top offscreen scope's blurred picture over `cap_area` for the native pass.
    fn capture_post_scope(&mut self, _record_id: u32, _cap_area: IRect) -> Result<()> {
        Ok(())
    }
    /// Whether the far tier kept `record_id`'s blurred picture for this native pass.
    fn has_captured_post_scope(&self, _record_id: u32) -> bool {
        false
    }
    /// Upsamples a reduced-grid layer blur to device pixels over `upsample_area`, applies the
    /// device-resolution `tail_steps`, and composites it onto the parent with `blend`, `opacity`
    /// and `open` clips.
    #[allow(clippy::too_many_arguments)]
    fn composite_reduced_post(
        &mut self,
        _source: ReducedPost<'_>,
        _upsample_area: IRect,
        _tail_steps: &[PostStep],
        _isolation: Isolation,
        _blend: u32,
        _opacity: f32,
        _open: &[Open],
    ) -> Result<()> {
        Ok(())
    }
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

/// Records under this many device pixels each way are left out of a rough stand-in.
pub const ROUGH_SPECK: f64 = 1.0;

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
    /// Records drawn by their coarse ops (unreadable text as bars, coarse glass): a stand-in, not exact.
    pub coarse: u32,
    /// Layer blurs drawn on a reduced grid (past the native limits): not exact.
    pub reduced: u32,
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
    /// Per-frame GPU CPU-side sub-timings (milliseconds) and dispatch counts.
    pub prepare_masks_ms: f64,
    pub vello_render_ms: f64,
    pub reader_ms: f64,
    pub shadow_ms: f64,
    pub submits: u32,
    pub draws: u32,
    pub vello_renders: u32,
    pub glass_ops: u32,
    pub glass_batched: u32,
    pub bg_blur_ops: u32,
    pub shadow_ops: u32,
    pub shadow_hits: u32,
    /// True when a tile slice yielded mid-tile to honor the frame CPU budget.
    pub in_progress: bool,
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
        self.reduced += o.reduced;
        self.specks += o.specks;
        self.verbs += o.verbs;
        self.draws += o.draws;
    }

    /// Whether the frame drew every record exactly (no level-of-detail stand-ins).
    pub fn exact(&self) -> bool {
        self.coarse == 0 && self.reduced == 0 && self.specks == 0
    }
}

/// Pre-pass plan for frames containing backdrop readers or export-context records.
/// Always computed against the full frame viewport so tiled band exports share exact reader
/// sequencing, `needs_backdrop`, and flush boundaries with whole-frame renders.
struct ReaderPlan {
    has_context: bool,
    needs_backdrop: bool,
    last_reader_seq: usize,
    isolated_with_reader: HashSet<u32>,
    /// Per full-frame-visible subtree that flushes on the whole frame (reader ops, backend-managed
    /// isolated groups, or context switches): `(reader_ops_in_subtree, contains_first_glass)`.
    subtree_readers: HashMap<u32, (usize, bool)>,
}

fn plan_readers(store: &Store, frame: &Frame) -> Option<ReaderPlan> {
    if store.readers().is_empty() && !store.has_context() {
        return None;
    }
    let cache = store.reader_cache();
    if !store.has_context() && cache.visible_readers.is_empty() {
        return None;
    }
    let root = store.nodes.get(&crate::store::ROOT)?;
    let full_viewport = Rect::new(-1.0, -1.0, f64::from(frame.width) + 1.0, f64::from(frame.height) + 1.0);
    let mut seq = 0usize;
    let mut first_glass_seq: Option<usize> = None;
    let mut last_reader_seq = 0usize;
    let mut has_readers = false;
    let mut has_context = false;
    // Mark isolated ancestors from the full graph (independent of viewport culling), so
    // off-screen reader motion or tiled band rendering never flips an ancestor's compositing path.
    let mut isolated_with_reader = cache.isolated_with_reader.clone();
    let mut subtree_readers: HashMap<u32, (usize, bool)> = HashMap::new();
    if store.has_context() {
        let mut mark_isolated_ancestors = |start_id: u32| {
            let mut chain = Vec::new();
            let mut cur = start_id;
            let mut child_of_cur = false;
            while cur != crate::store::ROOT {
                let Some(n) = store.nodes.get(&cur) else {
                    return;
                };
                if n.record.hidden() {
                    return;
                }
                // A child under a parent whose ops contain no `Op::Children` is never drawn.
                if child_of_cur && !n.record.ops.iter().any(|op| matches!(op, Op::Children)) {
                    return;
                }
                chain.push((cur, n.record.isolate() && n.record.opacity < 1.0));
                child_of_cur = true;
                cur = n.parent;
            }
            for (id, iso) in chain {
                if iso {
                    isolated_with_reader.insert(id);
                }
            }
        };
        for (&nid, node) in &store.nodes {
            if nid != crate::store::ROOT && !node.record.context() && !node.record.hidden() {
                let mut cur = node.parent;
                let mut under_context = false;
                while cur != crate::store::ROOT {
                    let Some(p) = store.nodes.get(&cur) else {
                        break;
                    };
                    if p.record.context() {
                        under_context = true;
                        break;
                    }
                    cur = p.parent;
                }
                if under_context {
                    mark_isolated_ancestors(nid);
                }
            }
        }
    }
    let reader_ancestors = (!store.has_context()).then_some(&cache.reader_ancestors);

    #[allow(clippy::too_many_arguments)]
    fn visit(
        store: &Store,
        frame: &Frame,
        viewport: Rect,
        id: u32,
        parent: Affine,
        alpha: f32,
        parent_context: bool,
        reader_ancestors: Option<&HashSet<u32>>,
        isolated_with_reader: &HashSet<u32>,
        seq: &mut usize,
        first_glass_seq: &mut Option<usize>,
        last_reader_seq: &mut usize,
        has_readers: &mut bool,
        has_context: &mut bool,
        subtree_readers: &mut HashMap<u32, (usize, bool)>,
    ) -> (usize, bool, bool) {
        if let Some(anc) = reader_ancestors
            && !anc.contains(&id)
        {
            return (0, false, false);
        }
        let Some(node) = store.nodes.get(&id) else {
            return (0, false, false);
        };
        let r = &node.record;
        if r.hidden() {
            return (0, false, false);
        }
        let world = parent * r.transform;
        let device = frame.view * world;
        if !finite(device) {
            return (0, false, false);
        }
        let Some(bounds) = store.bounds(id) else {
            return (0, false, false);
        };
        if !overlaps(device.transform_rect_bbox(bounds), viewport) {
            return (0, false, false);
        }
        if frame.detail && !r.group() {
            let b = device.transform_rect_bbox(Rect::new(0.0, 0.0, f64::from(r.size[0]), f64::from(r.size[1])));
            if b.width() < 0.5 && b.height() < 0.5 {
                return (0, false, false);
            }
        }
        let in_alpha = if parent_context && !r.context() { 1.0 } else { alpha };
        let opacity = in_alpha * r.opacity;
        if opacity <= 0.0 {
            return (0, false, false);
        }
        if r.context() {
            *has_context = true;
        }
        let isolate = r.isolate() && r.opacity < 1.0;
        let backend_isolate = isolate && isolated_with_reader.contains(&id);
        let inner = if isolate { 1.0 } else { opacity };
        let coarse =
            r.provisional() || frame.detail && r.coarse_below > 0.0 && scale_of(device) < f64::from(r.coarse_below);
        let ops = if coarse { &r.coarse } else { &r.ops };
        let mut count = 0usize;
        let mut has_first_glass = false;
        let mut flushes = backend_isolate || r.context() != parent_context;
        for op in ops {
            match op {
                Op::Children => {
                    for &c in &node.children {
                        let (cc, cg, cf) = visit(
                            store,
                            frame,
                            viewport,
                            c,
                            world,
                            inner,
                            r.context(),
                            reader_ancestors,
                            isolated_with_reader,
                            seq,
                            first_glass_seq,
                            last_reader_seq,
                            has_readers,
                            has_context,
                            subtree_readers,
                        );
                        count += cc;
                        has_first_glass |= cg;
                        flushes |= cf;
                    }
                }
                Op::Glass(_) => {
                    // A context record's own glass writes neither to output nor to backdrop.
                    if !r.context() {
                        *seq += 1;
                        count += 1;
                        flushes = true;
                        if first_glass_seq.is_none() {
                            *first_glass_seq = Some(*seq);
                            has_first_glass = true;
                        }
                        *last_reader_seq = *seq;
                        *has_readers = true;
                    }
                }
                Op::Read { .. } | Op::BackgroundBlur(_) | Op::ProgressiveBlur(_) => {
                    *seq += 1;
                    count += 1;
                    flushes = true;
                    *last_reader_seq = *seq;
                    *has_readers = true;
                }
                _ => {}
            }
        }
        if flushes {
            subtree_readers.insert(id, (count, has_first_glass));
        }
        (count, has_first_glass, flushes)
    }

    for &c in &root.children {
        visit(
            store,
            frame,
            full_viewport,
            c,
            Affine::IDENTITY,
            1.0,
            false,
            reader_ancestors,
            &isolated_with_reader,
            &mut seq,
            &mut first_glass_seq,
            &mut last_reader_seq,
            &mut has_readers,
            &mut has_context,
            &mut subtree_readers,
        );
    }
    if !has_readers && !has_context {
        return None;
    }
    // Dual-target backdrop is needed for export context OR whenever any glass precedes a later reader.
    let needs_backdrop = has_context || first_glass_seq.is_some_and(|g| g < last_reader_seq);
    Some(ReaderPlan {
        has_context,
        needs_backdrop,
        last_reader_seq,
        isolated_with_reader,
        subtree_readers,
    })
}

/// Peak reader working-set metrics for `Engine::admit_export`.
#[derive(Default, Clone, Copy, Debug)]
pub struct ExportMetrics {
    pub has_readers: bool,
    pub needs_backdrop: bool,
    pub max_iso_surfaces: usize,
    pub has_clipped_reader: bool,
    pub max_reader_work_bytes: usize,
}

pub(crate) fn background_reader_work_bytes(op: &Op, source: (u32, u32), dirty: (u32, u32), scale: f32) -> usize {
    let sigma = |radius| crate::blur::sigma_from_radius(radius) * scale;
    let scratch = match op {
        Op::BackgroundBlur(b) => crate::blur::cpu_work_bytes(source, dirty, sigma(b.radius)),
        Op::ProgressiveBlur(b) => {
            let start = sigma(b.start_radius);
            let end = sigma(b.end_radius);
            let stops = crate::progressive_blur::choose_stops(start.min(end), start.max(end));
            crate::progressive_blur::cpu_work_bytes(source, dirty, &stops)
        }
        _ => return 0,
    };
    crate::cpu::blur_buffer_bytes(dirty).saturating_add(scratch)
}

/// Estimates peak reader allocations for an export of `frame` under `memory_bytes` cap.
pub fn export_plan_metrics(store: &Store, frame: &Frame, tile: (usize, usize)) -> ExportMetrics {
    let Some(plan) = plan_readers(store, frame) else {
        return ExportMetrics::default();
    };
    let Some(root) = store.nodes.get(&crate::store::ROOT) else {
        return ExportMetrics::default();
    };
    let full_viewport = Rect::new(-1.0, -1.0, f64::from(frame.width) + 1.0, f64::from(frame.height) + 1.0);
    let metrics = ExportMetrics {
        has_readers: plan.last_reader_seq > 0,
        needs_backdrop: plan.needs_backdrop,
        ..ExportMetrics::default()
    };
    let (split_side, split_pixels, chunk_side) = (
        glass::EXACT_SPLIT_SIDE,
        glass::EXACT_SPLIT_PIXELS,
        glass::EXACT_CHUNK_SIDE,
    );
    let frame_size = (i32::from(frame.width), i32::from(frame.height));

    struct State<'a> {
        store: &'a Store,
        frame: &'a Frame,
        viewport: Rect,
        plan: &'a ReaderPlan,
        frame_size: (i32, i32),
        tile: (u32, u32),
        split_side: u32,
        split_pixels: u64,
        chunk_side: u32,
        reader_seq: usize,
        iso_surfaces: usize,
        clip_depth: usize,
        metrics: ExportMetrics,
    }

    fn visit(st: &mut State<'_>, id: u32, parent: Affine, alpha: f32, parent_context: bool) {
        let Some(node) = st.store.nodes.get(&id) else {
            return;
        };
        let r = &node.record;
        if r.hidden() {
            return;
        }
        let world = parent * r.transform;
        let device = st.frame.view * world;
        if !finite(device) {
            return;
        }
        let Some(bounds) = st.store.bounds(id) else {
            return;
        };
        if !overlaps(device.transform_rect_bbox(bounds), st.viewport) {
            return;
        }
        let is_context = r.context();
        let in_alpha = if parent_context && !is_context { 1.0 } else { alpha };
        let opacity = in_alpha * r.opacity;
        if opacity <= 0.0 {
            return;
        }
        let isolate = r.isolate() && r.opacity < 1.0;
        let backend_isolate = isolate && st.plan.isolated_with_reader.contains(&id);
        let inner = if isolate { 1.0 } else { opacity };
        let added_surfaces = if backend_isolate {
            let on_main = !is_context;
            let on_backdrop = st.plan.needs_backdrop && st.reader_seq < st.plan.last_reader_seq;
            usize::from(on_main) + usize::from(on_backdrop)
        } else {
            0
        };
        st.iso_surfaces += added_surfaces;
        st.metrics.max_iso_surfaces = st.metrics.max_iso_surfaces.max(st.iso_surfaces);

        let mut local_clips = 0usize;
        for op in &r.ops {
            match op {
                Op::Clip { .. } => {
                    if !is_context {
                        st.clip_depth += 1;
                        local_clips += 1;
                    }
                }
                Op::Unclip => {
                    if local_clips > 0 {
                        st.clip_depth -= 1;
                        local_clips -= 1;
                    }
                }
                Op::Children => {
                    for &c in &node.children {
                        visit(st, c, world, inner, is_context);
                    }
                }
                Op::Glass(g) => {
                    if !is_context {
                        st.reader_seq += 1;
                        if st.clip_depth > 0 {
                            st.metrics.has_clipped_reader = true;
                        }
                        let scale = device.determinant().abs().sqrt() as f32;
                        if scale > 0.0 && scale.is_finite() {
                            let inr = if g.inradius > 0.0 {
                                g.inradius
                            } else {
                                r.size[0].min(r.size[1]) * 0.5
                            };
                            let params = glass::glass_params(g, scale, inr);
                            let regions = glass::compute_regions(
                                g,
                                &params,
                                device,
                                r.size,
                                st.frame_size,
                                (0, 0),
                                st.frame_size,
                                glass::HARD_MAX_REGION_SIDE.min(u32::from(u16::MAX)),
                                glass::HARD_MAX_REGION_PIXELS,
                                st.split_side,
                                st.split_pixels,
                                st.chunk_side,
                            );
                            if let Ok(regions) = regions {
                                for reg in regions {
                                    let bytes = glass::cpu_work_bytes(&reg, &params);
                                    st.metrics.max_reader_work_bytes = st.metrics.max_reader_work_bytes.max(bytes);
                                }
                            }
                        }
                    }
                }
                Op::BackgroundBlur(_) | Op::ProgressiveBlur(_) => {
                    st.reader_seq += 1;
                    st.metrics.has_clipped_reader |= st.clip_depth > 0;
                    let q = IRect::around(device.transform_rect_bbox(bounds).inflate(2.0, 2.0))
                        .clamp(st.frame_size.0, st.frame_size.1);
                    let dirty = (
                        st.tile.0.min((q.x1 - q.x0).max(0) as u32),
                        st.tile.1.min((q.y1 - q.y0).max(0) as u32),
                    );
                    let scale = device.determinant().abs().sqrt() as f32;
                    let bytes = background_reader_work_bytes(op, st.tile, dirty, scale);
                    st.metrics.max_reader_work_bytes = st.metrics.max_reader_work_bytes.max(bytes);
                }
                Op::Read { .. } => {
                    st.reader_seq += 1;
                    if st.clip_depth > 0 {
                        st.metrics.has_clipped_reader = true;
                    }
                }
                _ => {}
            }
        }
        st.clip_depth -= local_clips;
        st.iso_surfaces -= added_surfaces;
    }

    let mut st = State {
        store,
        frame,
        viewport: full_viewport,
        plan: &plan,
        frame_size,
        tile: (tile.0 as u32, tile.1 as u32),
        split_side,
        split_pixels,
        chunk_side,
        reader_seq: 0,
        iso_surfaces: 0,
        clip_depth: 0,
        metrics,
    };
    for &c in &root.children {
        visit(&mut st, c, Affine::IDENTITY, 1.0, false);
    }
    st.metrics
}

#[cfg(any(test, feature = "gpu-common"))]
type WalkBackend = dyn Backend;
#[cfg(not(any(test, feature = "gpu-common")))]
type WalkBackend = crate::cpu::Cpu;

pub fn draw(store: &Store, backend: &mut WalkBackend, frame: &Frame, limits: &Limits) -> Result<DrawStats> {
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
pub fn draw_budgeted(
    store: &Store,
    backend: &mut WalkBackend,
    frame: &Frame,
    limits: &Limits,
    budget: &mut usize,
) -> Result<DrawStats> {
    draw_split(store, backend, frame, limits, budget, &Split::all(), frame.detail)
}

/// Saved state of a cooperatively yielded walk so the next frame slice resumes at the exact
/// sibling where execution paused with identical pixels.
pub struct WalkCheckpoint {
    plan: Option<ReaderPlan>,
    /// Path from `ROOT` down to the paused sibling: `(parent_id, children_op_idx, child_idx)`.
    resume_path: Vec<(u32, usize, usize)>,
    reader_seq: usize,
    backdrop_live: bool,
    /// What the slices before this one drew, so the finished walk's exactness counts every
    /// stand-in, speck and reduced effect across slices (`DrawStats::exact`).
    so_far: DrawStats,
}

/// Result of one slice of a resumable tile walk.
pub enum WalkOutcome {
    /// The walk finished; `stats` is this slice's incremental counts and `total` the whole
    /// walk's across all slices (its `exact()` says whether the tile is exact).
    Complete { stats: DrawStats, total: DrawStats },
    /// The walk yielded cooperatively at a safe boundary; `stats` is this slice's incremental
    /// counts and `checkpoint` resumes the remainder.
    Paused {
        stats: DrawStats,
        checkpoint: WalkCheckpoint,
    },
}

/// `draw_budgeted`, drawing only the part of the page `split` names.
pub fn draw_split(
    store: &Store,
    backend: &mut WalkBackend,
    frame: &Frame,
    limits: &Limits,
    budget: &mut usize,
    split: &Split,
    coarse_readers: bool,
) -> Result<DrawStats> {
    match draw_split_resumable(
        store,
        backend,
        frame,
        limits,
        budget,
        split,
        coarse_readers,
        None,
        false,
    )? {
        WalkOutcome::Complete { stats, .. } => Ok(stats),
        WalkOutcome::Paused { stats, .. } => Ok(stats),
    }
}

/// `draw_split` with cooperative mid-tile yielding when `allow_yield` is true and
/// `backend.deadline_reached()` triggers at a safe boundary (outside isolated and masked scopes).
/// Pass `checkpoint` from `WalkOutcome::Paused` on the next slice to resume the same paint order.
#[allow(clippy::too_many_arguments)]
pub fn draw_split_resumable(
    store: &Store,
    backend: &mut WalkBackend,
    frame: &Frame,
    limits: &Limits,
    budget: &mut usize,
    split: &Split,
    coarse_readers: bool,
    checkpoint: Option<WalkCheckpoint>,
    allow_yield: bool,
) -> Result<WalkOutcome> {
    let full_frame = IRect {
        x0: 0,
        y0: 0,
        x1: i32::from(frame.width),
        y1: i32::from(frame.height),
    };
    let tiled = frame.area != full_frame;
    let full_viewport = Rect::new(-1.0, -1.0, f64::from(frame.width) + 1.0, f64::from(frame.height) + 1.0);
    let resuming = checkpoint.is_some();
    let rough = backend.rough();
    let (plan, resume_path, reader_seq, backdrop_live, mut so_far) = match checkpoint {
        Some(cp) => (cp.plan, cp.resume_path, cp.reader_seq, cp.backdrop_live, cp.so_far),
        None => {
            // A rough stand-in reads nothing: what readers see isn't drawn.
            let plan = if rough { None } else { plan_readers(store, frame) };
            let has_ctx = plan.as_ref().is_some_and(|p| p.has_context);
            (plan, Vec::new(), 0, has_ctx, DrawStats::default())
        }
    };
    if rough && !resuming {
        // Never exact, whatever it held.
        so_far.coarse += 1;
    }
    let (has_context, needs_backdrop, last_reader_seq, isolated_with_reader, subtree_readers) = match plan {
        Some(p) => (
            p.has_context,
            p.needs_backdrop,
            p.last_reader_seq,
            p.isolated_with_reader,
            p.subtree_readers,
        ),
        None => (false, false, 0, HashSet::new(), HashMap::new()),
    };
    let readers_active = has_context || last_reader_seq > 0;
    if !resuming && readers_active {
        backend.begin_readers(needs_backdrop, has_context)?;
    }
    let can_yield = allow_yield && split.pass == Pass::All && !has_context;
    let mut walk = Walk {
        split,
        phase: Phase::Before,
        store,
        backend,
        frame: *frame,
        coarse_readers,
        rough,
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
        readers_active,
        needs_backdrop,
        backdrop_live,
        last_reader_seq,
        reader_seq,
        isolated_with_reader,
        subtree_readers,
        ancestor_clips: Vec::new(),
        current_context: false,
        context_clips_suspended: false,
        isolated_backdrop_depth: 0,
        allow_yield: can_yield,
        yield_safe_depth: 0,
        paused: false,
        paused_path: Vec::new(),
        resume_path,
        resume_depth: 0,
        records_since_probe: 0,
        verbs_at_probe: 0,
        heavy_op_ran: false,
        made_progress: false,
        skip_post_record: None,
        active_hw_blend: HwBlend::Normal,
    };
    if !store.nodes.contains_key(&crate::store::ROOT) {
        return Err(EngineError::malformed("no page"));
    }
    let result = walk.draw_children(crate::store::ROOT, 0, Affine::IDENTITY, 1.0, false);
    *budget = walk.verbs_left;
    // Whatever failed or yielded part way, close what's open so the scene stays usable.
    while let Some(o) = walk.open.pop() {
        match o {
            Open::Clip { active_on_scene, .. } => {
                if active_on_scene {
                    walk.backend.scene().pop_clip();
                }
            }
            Open::Layer => walk.backend.scene().pop_layer(),
        }
    }
    result?;
    if walk.paused {
        walk.paused_path.reverse();
        let saved_plan = walk.readers_active.then_some(ReaderPlan {
            has_context,
            needs_backdrop: walk.needs_backdrop,
            last_reader_seq: walk.last_reader_seq,
            isolated_with_reader: walk.isolated_with_reader,
            subtree_readers: walk.subtree_readers,
        });
        return Ok(WalkOutcome::Paused {
            stats: walk.stats,
            checkpoint: WalkCheckpoint {
                plan: saved_plan,
                resume_path: walk.paused_path,
                reader_seq: walk.reader_seq,
                backdrop_live: walk.backdrop_live,
                so_far: {
                    let mut so_far = so_far;
                    so_far.add(&walk.stats);
                    so_far
                },
            },
        });
    }
    let mut total = so_far;
    total.add(&walk.stats);
    Ok(WalkOutcome::Complete {
        stats: walk.stats,
        total,
    })
}

struct Walk<'a> {
    split: &'a Split,
    phase: Phase,
    store: &'a Store,
    backend: &'a mut WalkBackend,
    frame: Frame,
    coarse_readers: bool,
    /// A rough stand-in (`Backend::rough`).
    rough: bool,
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
    readers_active: bool,
    needs_backdrop: bool,
    backdrop_live: bool,
    last_reader_seq: usize,
    reader_seq: usize,
    isolated_with_reader: HashSet<u32>,
    subtree_readers: HashMap<u32, (usize, bool)>,
    ancestor_clips: Vec<Open>,
    current_context: bool,
    context_clips_suspended: bool,
    isolated_backdrop_depth: usize,
    allow_yield: bool,
    yield_safe_depth: usize,
    paused: bool,
    paused_path: Vec<(u32, usize, usize)>,
    resume_path: Vec<(u32, usize, usize)>,
    resume_depth: usize,
    records_since_probe: u32,
    verbs_at_probe: u64,
    heavy_op_ran: bool,
    made_progress: bool,
    skip_post_record: Option<u32>,
    active_hw_blend: HwBlend,
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
pub(crate) fn clip_wraps_children(ops: &[Op], clip_idx: usize) -> bool {
    let mut depth = 1usize;
    for op in &ops[clip_idx + 1..] {
        match op {
            Op::Clip { .. } => depth += 1,
            Op::Unclip => {
                depth -= 1;
                if depth == 0 {
                    return false;
                }
            }
            Op::Children => return true,
            _ => {}
        }
    }
    false
}

/// Innermost opaque solid fill painted before `clip_idx`, as premultiplied RGBA8 (decision 0007).
pub(crate) fn frame_solid_fill(ops: &[Op], clip_idx: usize, alpha: f32) -> Option<[u8; 4]> {
    for op in ops[..clip_idx].iter().rev() {
        if let Op::Fill {
            paint: Paint::Solid(c), ..
        } = op
            && c[3] >= 1.0 - 1e-4
        {
            let a = alpha.clamp(0.0, 1.0);
            return Some([
                ((c[0] * a).clamp(0.0, 1.0) * 255.0 + 0.5) as u8,
                ((c[1] * a).clamp(0.0, 1.0) * 255.0 + 0.5) as u8,
                ((c[2] * a).clamp(0.0, 1.0) * 255.0 + 0.5) as u8,
                (a * 255.0 + 0.5) as u8,
            ]);
        }
    }
    None
}

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

/// Post steps through the last layer blur, moved onto a reduced grid of spacing `divisor` (grid
/// texel (0, 0) at `grid_to_dev`). The grid adds variance once for the whole chain: box
/// rasterisation plus the bilinear upsample back (`HALO_GRID_VARIANCE` texels squared). That is
/// taken off the chain's layer blurs from the last backwards, so the chain's total variance
/// matches device resolution even when the last blur alone is narrower than the grid's.
fn posts_on_grid(posts: &[ActivePost], divisor: i32, grid_to_dev: Affine) -> Vec<ActivePost> {
    let d = f64::from(divisor);
    let mut out: Vec<ActivePost> = posts
        .iter()
        .map(|pe| match *pe {
            ActivePost::LayerBlur { sigma } => ActivePost::LayerBlur {
                sigma: (f64::from(sigma) / d) as f32,
            },
            ActivePost::Noise {
                noise_type,
                size,
                density,
                color,
                secondary_color,
                opacity,
                dev_to_layer,
            } => ActivePost::Noise {
                noise_type,
                size,
                density,
                color,
                secondary_color,
                opacity,
                dev_to_layer: dev_to_layer * grid_to_dev,
            },
            ActivePost::Texture {
                size,
                radius_dev,
                clip_to_shape,
                dev_to_layer,
            } => ActivePost::Texture {
                size,
                radius_dev: (f64::from(radius_dev) / d) as f32,
                clip_to_shape,
                dev_to_layer: dev_to_layer * grid_to_dev,
            },
        })
        .collect();
    take_grid_variance(
        out.iter_mut().filter_map(|pe| match pe {
            ActivePost::LayerBlur { sigma } => Some(sigma),
            _ => None,
        }),
        divisor,
    );
    out
}

/// Takes a reduced grid's own variance (`HALO_GRID_VARIANCE` texels squared, none at divisor 1)
/// off a chain of layer-blur sigmas in grid texels, from the last backwards.
fn take_grid_variance<'a>(sigmas: impl DoubleEndedIterator<Item = &'a mut f32>, divisor: i32) {
    let mut owed = if divisor > 1 {
        f64::from(crate::halo::HALO_GRID_VARIANCE)
    } else {
        0.0
    };
    for sigma in sigmas.rev() {
        if owed <= 0.0 {
            break;
        }
        let var = f64::from(*sigma) * f64::from(*sigma);
        let take = var.min(owed);
        owed -= take;
        *sigma = (var - take).sqrt() as f32;
    }
}

/// The reduced grid for a layer blur past the native limits (case L2).
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct ReducedGrid {
    /// Device pixels per grid texel (a power of two, at least 2).
    pub divisor: i32,
    /// Grid texel (0, 0) in device pixels, on the view's grid phase.
    pub origin: (i32, i32),
    /// The grid's size in texels.
    pub size: (u32, u32),
    /// The texture cap pushed the divisor past a third of the blur's sigma (fewer than
    /// `HALO_MIN_COARSE_SIGMA` grid texels), where the reduced blur visibly widens.
    pub past_cutover: bool,
}

/// Chooses the reduced grid covering `raw_src` (device pixels) for a layer blur of `sigma`: the
/// replay divisor for `replay_side`, capped at the largest power of two within a third of
/// `sigma`, then doubled while the grid is wider than `tex_cap` texels.
pub(crate) fn reduced_layer_blur_grid(
    raw_src: IRect,
    sigma: f32,
    replay_side: u32,
    tex_cap: u32,
    view: Affine,
) -> ReducedGrid {
    let third = (sigma / crate::halo::HALO_MIN_COARSE_SIGMA).floor().max(2.0) as u32;
    let max_valid = (1u32 << (31 - third.leading_zeros())) as i32;
    let mut divisor = crate::halo::replay_divisor(raw_src, replay_side).min(max_valid).max(2);
    loop {
        let phase = view_grid_phase(view, divisor);
        let x0 = (raw_src.x0 - phase.0).div_euclid(divisor) * divisor + phase.0;
        let y0 = (raw_src.y0 - phase.1).div_euclid(divisor) * divisor + phase.1;
        let w = ((raw_src.x1 - x0 + divisor - 1).div_euclid(divisor)).max(1) as u32;
        let h = ((raw_src.y1 - y0 + divisor - 1).div_euclid(divisor)).max(1) as u32;
        if (w <= tex_cap && h <= tex_cap) || divisor >= 1 << 20 {
            return ReducedGrid {
                divisor,
                origin: (x0, y0),
                size: (w, h),
                past_cutover: divisor as f32 * crate::halo::HALO_MIN_COARSE_SIGMA > sigma,
            };
        }
        divisor *= 2;
    }
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
    fn src_pad(&self, unbounded: bool) -> i32 {
        match *self {
            Self::LayerBlur { sigma } => {
                if unbounded {
                    crate::shadow::blur_support_pad_view(sigma)
                } else {
                    crate::shadow::blur_support_pad(sigma)
                }
            }
            Self::Noise { .. } => 0,
            Self::Texture { radius_dev, .. } => (radius_dev.ceil() as i32).saturating_add(2),
        }
    }

    fn grow_pad(&self, unbounded: bool) -> i32 {
        match *self {
            Self::LayerBlur { sigma } => {
                if unbounded {
                    crate::shadow::blur_support_pad_view(sigma)
                } else {
                    crate::shadow::blur_support_pad(sigma)
                }
            }
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
    capture_scope: Option<(u32, i32, IRect, (i32, i32))>,
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
    if !active.is_empty() {
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
        // A post-effect record whose output misses the frame skips its entire
        // subtree. Its descendants cannot flush the parent scene.
        if full_out.is_empty() {
            return false;
        }
        let inner_pad = (page_pad - r.post_pad()).max(0.0);
        let inner_pad_dev = if inner_pad > 0.0 {
            inner_pad * view_scale + 2.0
        } else {
            0.0
        };
        let content_bbox = device.transform_rect_bbox(bounds).inflate(inner_pad_dev, inner_pad_dev);
        let content_rect = IRect::around(content_bbox).inflate(2, 2);
        let total_post_pad: i32 = active.iter().fold(0i32, |acc, p| acc.saturating_add(p.src_pad(false)));
        return !content_rect
            .intersect(full_out.inflate(total_post_pad, total_post_pad))
            .is_empty();
    }
    if r.blend != 0 || (r.isolate() && r.opacity < 1.0) {
        let raw = IRect::around(dev_bbox.inflate(1.0, 1.0));
        return !raw.intersect(full_frame).is_empty();
    }
    let coarse =
        r.provisional() || frame.detail && r.coarse_below > 0.0 && scale_of(device) < f64::from(r.coarse_below);
    let ops = if coarse { &r.coarse } else { &r.ops };
    for op in ops {
        match op {
            op if op.is_reader() => return true,
            Op::Fill { path, paint, blend, .. } if *blend != 0 && paint_visible(paint, opacity) => {
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
                ..
            } if *blend != 0 && style.width > 0.0 && paint_visible(paint, opacity) => {
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
            } if *blend != 0 && c[3] * opacity > 0.0 && stroke.as_ref().is_none_or(|st| st.width > 0.0) => {
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
            } if *blend != 0 && c[3] * opacity > 0.0 => {
                if let Some(b) = r.entry_bounds(*shape, &|g| store.glyphs.bounds(g)) {
                    let raw = IRect::around(device.transform_rect_bbox(b).inflate(2.0, 2.0));
                    if !raw.intersect(full_frame).is_empty() {
                        return true;
                    }
                }
            }
            Op::Children
                if children_flush_in_full_frame(store, frame, full_frame, full_viewport, id, world, opacity) =>
            {
                return true;
            }
            _ => {}
        }
    }
    false
}

/// Maximum atomic draws inspected when proving a blended layer subtree has no self-overlap.
const MAX_HW_BLEND_DRAWS: usize = 16;
/// Maximum recursion depth when inspecting a blended layer subtree.
const MAX_HW_BLEND_DEPTH: usize = 8;

impl Walk<'_> {
    /// Explicit fixed-function hardware blend precondition shared by every op and layer gate:
    /// the mode is one of `{Multiply, Screen, LinearDodge, LinearBurn}`, we are not already inside
    /// a HW-blended unit or an open Vello opacity/compose layer, and the backend confirms the
    /// active target planes are opaque (and HW blending is enabled).
    #[inline]
    fn can_hw_blend_now(&self, blend: u32) -> Option<HwBlend> {
        let mode = hw_blend_mode(blend)?;
        if self.active_hw_blend != HwBlend::Normal
            || self.open.iter().any(|o| matches!(o, Open::Layer))
            || !self.backend.can_hw_blend()
        {
            return None;
        }
        Some(mode)
    }

    /// Runs `f` with fixed-function hardware blending active on the scene, preventing cooperative
    /// yields inside the blended unit and always restoring the previous blend state on exit.
    fn with_hw_blend<R>(&mut self, mode: HwBlend, f: impl FnOnce(&mut Self) -> Result<R>) -> Result<R> {
        let prev = self.active_hw_blend;
        self.active_hw_blend = mode;
        self.yield_safe_depth += 1;
        self.backend.scene().set_hw_blend(mode);
        let res = f(self);
        self.backend.scene().set_hw_blend(prev);
        self.yield_safe_depth -= 1;
        self.active_hw_blend = prev;
        res
    }

    /// Whether a single `Op::Fill` with non-normal `blend` can execute via fixed-function HW blend.
    /// Non-glyph paths rasterize in one strip pass with zero self-overlap; glyph runs additionally
    /// require pairwise non-overlapping glyph ink boxes (`glyphs_non_overlapping`), checked
    /// independent of tile viewport so tiled and whole-frame renders decide identically.
    fn can_hw_blend_fill(&self, r: &Record, path_idx: u32, blend: u32) -> Option<HwBlend> {
        let mode = self.can_hw_blend_now(blend)?;
        if let Some(PathEntry::Glyphs { scale, glyphs }) = r.paths.get(path_idx as usize)
            && !glyphs_non_overlapping(self.store, f64::from(*scale), glyphs)
        {
            return None;
        }
        Some(mode)
    }

    /// Proves that executing blended layer `id` (at `opacity == 1.0`, no active post-effects,
    /// no readers) directly with fixed-function HW blending produces the exact same pixels as
    /// offscreen isolation: every visible draw in the subtree is a single self-overlap-free op,
    /// no descendant introduces a reader, mask, post-effect, `Op::Layer`, inner blend, isolated
    /// opacity, or context switch, and when more than one draw exists their device-space bounds
    /// (computed under translation-invariant `linear(frame.view)` so tiled == whole) are pairwise
    /// separated by at least 2 device pixels (1 px AA clearance on each side).
    fn can_hw_blend_layer(&self, id: u32, world: Affine, root_context: bool) -> bool {
        if self.split.pass != Pass::All {
            return false;
        }
        let view_lin = linear(self.frame.view);
        let view_scale = scale_of(self.frame.view);
        let mut draws: Vec<Option<Rect>> = Vec::new();
        if !self.collect_hw_blend_draws(id, world, 1.0, root_context, true, 0, view_lin, view_scale, &mut draws) {
            return false;
        }
        if draws.len() <= 1 {
            return true;
        }
        for i in 0..draws.len() {
            let Some(a) = draws[i] else {
                return false;
            };
            for b in &draws[i + 1..] {
                let Some(b) = *b else {
                    return false;
                };
                let disjoint = a.x1 + 2.0 <= b.x0 || b.x1 + 2.0 <= a.x0 || a.y1 + 2.0 <= b.y0 || b.y1 + 2.0 <= a.y0;
                if !disjoint {
                    return false;
                }
            }
        }
        true
    }

    #[allow(clippy::too_many_arguments)]
    fn collect_hw_blend_draws(
        &self,
        id: u32,
        world: Affine,
        alpha: f32,
        root_context: bool,
        is_root: bool,
        depth: usize,
        view_lin: Affine,
        view_scale: f64,
        draws: &mut Vec<Option<Rect>>,
    ) -> bool {
        if depth > MAX_HW_BLEND_DEPTH {
            return false;
        }
        let Some(node) = self.store.nodes.get(&id) else {
            return true;
        };
        let r = &node.record;
        if r.hidden() {
            return true;
        }
        if r.refusing_bits() != 0 || r.context() != root_context || (!is_root && r.is_mask()) {
            return false;
        }
        let dev_lin = view_lin * world;
        if !finite(dev_lin) {
            return false;
        }
        if self.frame.detail {
            if !r.group() {
                let b = dev_lin.transform_rect_bbox(Rect::new(0.0, 0.0, f64::from(r.size[0]), f64::from(r.size[1])));
                if b.width() < 0.5 && b.height() < 0.5 {
                    return true;
                }
            } else if let (Some(bounds), page_pad) = self.store.bounds_and_pad(id) {
                let pad_dev = if page_pad > 0.0 {
                    page_pad * view_scale + 2.0
                } else {
                    0.0
                };
                let b = dev_lin.transform_rect_bbox(bounds).inflate(pad_dev, pad_dev);
                if b.width() < 0.5 && b.height() < 0.5 && !self.subtree_readers.contains_key(&id) {
                    return true;
                }
            }
        }
        let opacity = if is_root { alpha } else { alpha * r.opacity };
        if opacity <= 0.0 {
            return true;
        }
        if !is_root
            && (!active_posts(r, dev_lin, view_scale).is_empty() || r.blend != 0 || (r.isolate() && r.opacity < 1.0))
        {
            return false;
        }
        let coarse = r.provisional()
            || self.frame.detail && r.coarse_below > 0.0 && scale_of(dev_lin) < f64::from(r.coarse_below);
        let ops = if coarse { &r.coarse } else { &r.ops };
        for op in ops {
            match op {
                Op::Clip { .. } | Op::Unclip => {}
                Op::Layer { .. }
                | Op::Unlayer
                | Op::Read { .. }
                | Op::Glass(_)
                | Op::BackgroundBlur(_)
                | Op::ProgressiveBlur(_) => return false,
                Op::Fill { path, paint, blend, .. } => {
                    if !paint_visible(paint, opacity) {
                        continue;
                    }
                    if *blend != 0 {
                        return false;
                    }
                    if let Some(PathEntry::Glyphs { scale, glyphs }) = r.paths.get(*path as usize)
                        && !glyphs_non_overlapping(self.store, f64::from(*scale), glyphs)
                    {
                        return false;
                    }
                    if draws.len() >= MAX_HW_BLEND_DRAWS {
                        return false;
                    }
                    let bbox = r
                        .entry_bounds(*path, &|g| self.store.glyphs.bounds(g))
                        .map(|b| dev_lin.transform_rect_bbox(b));
                    draws.push(bbox);
                }
                Op::Stroke {
                    path,
                    style,
                    paint,
                    blend,
                    ..
                } => {
                    if style.width <= 0.0 || !paint_visible(paint, opacity) {
                        continue;
                    }
                    if *blend != 0 {
                        return false;
                    }
                    if draws.len() >= MAX_HW_BLEND_DRAWS {
                        return false;
                    }
                    let grow =
                        f64::from(style.width) * f64::from(style.miter.max(1.0)) * 0.5 + f64::from(style.width) + 1.0;
                    let bbox = r
                        .entry_bounds(*path, &|g| self.store.glyphs.bounds(g))
                        .map(|b| dev_lin.transform_rect_bbox(b.inflate(grow, grow)));
                    draws.push(bbox);
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
                } => {
                    if c[3] * opacity <= 0.0 || paths.is_empty() || stroke.as_ref().is_some_and(|st| st.width <= 0.0) {
                        continue;
                    }
                    if *blend != 0 {
                        return false;
                    }
                    if draws.len() >= MAX_HW_BLEND_DRAWS {
                        return false;
                    }
                    let shifted =
                        Affine::translate((f64::from(*dx) * view_scale, f64::from(*dy) * view_scale)) * dev_lin;
                    let sigma_dev = crate::blur::sigma_from_radius(*blur) * view_scale as f32;
                    let stroke_grow = stroke.as_deref().map_or(0.0, |st| {
                        f64::from(st.width) * f64::from(st.miter.max(1.0)) * 0.5 + f64::from(st.width) + 1.0
                    });
                    let reach = f64::from(crate::blur::kernel_radius(sigma_dev)) + 2.0;
                    let mut bbox: Option<Rect> = None;
                    for &pi in paths {
                        if let Some(b) = r.entry_bounds(pi, &|g| self.store.glyphs.bounds(g)) {
                            let lb = if stroke_grow > 0.0 {
                                b.inflate(stroke_grow, stroke_grow)
                            } else {
                                b
                            };
                            let db = shifted.transform_rect_bbox(lb).inflate(reach, reach);
                            bbox = Some(bbox.map_or(db, |o| o.union(db)));
                        }
                    }
                    draws.push(bbox);
                }
                Op::InnerShadow {
                    shape, color: c, blend, ..
                } => {
                    if c[3] * opacity <= 0.0 {
                        continue;
                    }
                    if *blend != 0 {
                        return false;
                    }
                    if draws.len() >= MAX_HW_BLEND_DRAWS {
                        return false;
                    }
                    let bbox = r
                        .entry_bounds(*shape, &|g| self.store.glyphs.bounds(g))
                        .map(|b| dev_lin.transform_rect_bbox(b));
                    draws.push(bbox);
                }
                Op::Children => {
                    for &cid in &node.children {
                        let Some(cn) = self.store.nodes.get(&cid) else {
                            continue;
                        };
                        if cn.record.hidden() {
                            continue;
                        }
                        if cn.record.is_mask() {
                            return false;
                        }
                        let child_world = world * cn.record.transform;
                        if !self.collect_hw_blend_draws(
                            cid,
                            child_world,
                            opacity,
                            root_context,
                            false,
                            depth + 1,
                            view_lin,
                            view_scale,
                            draws,
                        ) {
                            return false;
                        }
                    }
                }
            }
        }
        true
    }

    /// Whether paint now belongs to the part being drawn.
    fn paints(&self) -> bool {
        match self.split.pass {
            Pass::All => true,
            Pass::Below => self.phase == Phase::Before,
            Pass::Selection => self.phase == Phase::In,
            Pass::Above => self.phase == Phase::After,
        }
    }

    #[inline]
    fn should_yield(&mut self) -> bool {
        if !self.allow_yield || self.yield_safe_depth != 0 || !self.made_progress {
            return false;
        }
        // A single complex outline can cost as much as many simple records.
        if self.heavy_op_ran
            || self.records_since_probe >= 16
            || self.stats.verbs.saturating_sub(self.verbs_at_probe) >= 1024
        {
            self.heavy_op_ran = false;
            self.records_since_probe = 0;
            self.verbs_at_probe = self.stats.verbs;
            return self.backend.deadline_reached();
        }
        false
    }

    /// A parent's children in paint order, the split's selection marking where paint order
    /// passes it.
    fn children(
        &mut self,
        parent: u32,
        op_idx: usize,
        children: &[u32],
        world: Affine,
        alpha: f32,
        parent_context: bool,
    ) -> Result<()> {
        let here = self.split.pass != Pass::All && self.split.parent == parent;
        let start_k = if self.resume_depth < self.resume_path.len() && self.resume_path[self.resume_depth].0 == parent {
            let k = self.resume_path[self.resume_depth].2;
            self.resume_depth += 1;
            if self.resume_depth >= self.resume_path.len() {
                self.resume_path.clear();
                self.resume_depth = 0;
            }
            k
        } else {
            0
        };
        for (k, c) in children.iter().enumerate().skip(start_k) {
            if self.resume_path.is_empty() && self.should_yield() {
                self.paused = true;
                self.paused_path.push((parent, op_idx, k));
                return Ok(());
            }
            if here {
                self.phase = if k < self.split.first {
                    Phase::Before
                } else if k <= self.split.last {
                    Phase::In
                } else {
                    Phase::After
                };
            }
            self.node(*c, world, alpha, parent_context)?;
            if self.paused {
                self.paused_path.push((parent, op_idx, k));
                return Ok(());
            }
        }
        if here {
            self.phase = Phase::After;
        }
        Ok(())
    }

    /// Builds 1:1 device-space post steps (`Noise`, `Texture`) following an upsampled `LayerBlur`
    /// together with the required upsample source area covering their spatial pad.
    fn build_tail_post_steps(tail: &[ActivePost], out_area: IRect, max_side: i32) -> Result<(IRect, Vec<PostStep>)> {
        if tail.is_empty() {
            return Ok((out_area, Vec::new()));
        }
        let n = tail.len();
        let mut rem_pads = vec![0i32; n];
        let mut suffix = 0i32;
        for i in (0..n).rev() {
            rem_pads[i] = suffix;
            suffix = suffix.saturating_add(tail[i].src_pad(true));
        }
        let upsample_area = if suffix == 0 {
            out_area
        } else {
            align_area_checked(out_area.inflate(suffix, suffix), 4, (0, 0), max_side)?
        };
        let mut steps = Vec::with_capacity(n);
        for (i, pe) in tail.iter().enumerate() {
            let area = if i + 1 == n {
                out_area
            } else {
                align_area_checked(out_area.inflate(rem_pads[i], rem_pads[i]), 4, (0, 0), max_side)?
            };
            steps.push(pe.clone().into_step(area));
        }
        Ok((upsample_area, steps))
    }

    /// Draws a reader-free GPU view layer blur whose padded source exceeds the native texture or
    /// memory limits (case L2): the record's subtree on a reduced grid, its post steps through the
    /// last layer blur there (sigma compensated for the grid), then upsampled to device pixels
    /// where any later noise or texture runs. The frame counts it as reduced, never exact.
    #[inline(never)]
    #[allow(clippy::too_many_arguments)]
    fn exec_reduced_layer_blur(
        &mut self,
        id: u32,
        parent: Affine,
        opacity: f32,
        layer_blend: u32,
        isolation: Isolation,
        out_area: IRect,
        raw_src: IRect,
        active: &[ActivePost],
        lb_idx: usize,
        lb_sigma: f32,
    ) -> Result<()> {
        let max_side = self.store.limits.texture_side as i32;
        let (upsample_area, tail_steps) = Self::build_tail_post_steps(&active[lb_idx + 1..], out_area, max_side)?;
        let limits = self.backend.reduced_layer_blur_limits();
        let grid = reduced_layer_blur_grid(
            raw_src,
            lb_sigma,
            limits.replay_side,
            (max_side as u32).min(u32::from(u16::MAX)),
            self.frame.view,
        );
        self.stats.reduced += 1;
        if grid.past_cutover {
            // The texture cap pushed the grid past a third of the blur's sigma: the blur widens
            // visibly, so count it as a level-of-detail stand-in as well.
            self.stats.coarse += 1;
        }
        let d_render = grid.divisor;
        let (red_x0, red_y0) = grid.origin;
        let (red_w, red_h) = grid.size;
        let rx0 = (upsample_area.x0 - red_x0).div_euclid(d_render) - 1;
        let ry0 = (upsample_area.y0 - red_y0).div_euclid(d_render) - 1;
        let rx1 = (upsample_area.x1 - red_x0 + d_render - 1).div_euclid(d_render) + 1;
        let ry1 = (upsample_area.y1 - red_y0 + d_render - 1).div_euclid(d_render) + 1;
        let red_blur_out = IRect {
            x0: rx0,
            y0: ry0,
            x1: rx1.max(rx0 + 1),
            y1: ry1.max(ry0 + 1),
        };

        let d_f = f64::from(d_render);
        let red_to_dev = Affine::translate((f64::from(red_x0), f64::from(red_y0))) * Affine::scale(d_f);
        let red_posts = posts_on_grid(&active[..=lb_idx], d_render, red_to_dev);
        let n_pre = red_posts.len();
        let mut rem_pads = vec![0i32; n_pre];
        let mut suffix = 0i32;
        for i in (0..n_pre).rev() {
            rem_pads[i] = suffix;
            suffix = suffix.saturating_add(red_posts[i].src_pad(true));
        }
        let red_content = IRect {
            x0: 0,
            y0: 0,
            x1: red_w as i32,
            y1: red_h as i32,
        };
        let mut reduced_steps = Vec::with_capacity(n_pre);
        let mut grown = 0i32;
        for (i, pe) in red_posts.into_iter().enumerate() {
            grown = grown.saturating_add(pe.grow_pad(true));
            let area = if i + 1 == n_pre {
                red_blur_out
            } else {
                let raw = red_content
                    .inflate(grown, grown)
                    .intersect(red_blur_out.inflate(rem_pads[i], rem_pads[i]));
                align_area_checked(raw, 4, (0, 0), max_side)?
            };
            reduced_steps.push(pe.into_step(area));
        }

        let red_frame = Frame {
            width: red_w as u16,
            height: red_h as u16,
            view: Affine::scale(1.0 / d_f)
                * Affine::translate((-f64::from(red_x0), -f64::from(red_y0)))
                * self.frame.view,
            detail: false,
            area: red_content,
        };
        if !self
            .backend
            .push_isolated(red_content, false, None, isolation, &self.open)?
        {
            return Ok(());
        }
        let prev_frame = self.frame;
        let prev_viewport = self.viewport;
        let prev_full_frame = self.full_frame;
        let prev_full_viewport = self.full_viewport;
        let prev_tiled = self.tiled;
        let prev_open = std::mem::take(&mut self.open);
        let prev_ancestors = std::mem::take(&mut self.ancestor_clips);
        self.frame = red_frame;
        self.viewport = Rect::new(-1.0, -1.0, f64::from(red_w) + 1.0, f64::from(red_h) + 1.0);
        self.full_frame = red_content;
        self.full_viewport = self.viewport;
        self.tiled = false;
        self.skip_post_record = Some(id);
        // The subtree is blurred and composited once below: a walk paused inside it would blur
        // part of it now and the rest as a second blur on resume.
        self.yield_safe_depth += 1;
        let walk_res = self.node_inner(id, parent, 1.0, false);
        self.yield_safe_depth -= 1;
        self.skip_post_record = None;
        while let Some(o) = self.open.pop() {
            match o {
                Open::Clip { active_on_scene, .. } => {
                    if active_on_scene {
                        self.backend.scene().pop_clip();
                    }
                }
                Open::Layer => self.backend.scene().pop_layer(),
            }
        }
        self.frame = prev_frame;
        self.viewport = prev_viewport;
        self.full_frame = prev_full_frame;
        self.full_viewport = prev_full_viewport;
        self.tiled = prev_tiled;
        self.open = prev_open;
        self.ancestor_clips = prev_ancestors;
        if let Err(e) = walk_res {
            self.backend.abort_isolated(&self.open);
            return Err(e);
        }
        let origin = (
            f64::from(red_x0) + f64::from(red_blur_out.x0) * d_f,
            f64::from(red_y0) + f64::from(red_blur_out.y0) * d_f,
        );
        self.backend.composite_reduced_post(
            ReducedPost::Top {
                steps: &reduced_steps,
                origin,
                divisor: d_render,
            },
            upsample_area,
            &tail_steps,
            isolation,
            layer_blend,
            opacity,
            &self.open,
        )
    }

    fn sync_targets(&mut self, is_context: bool) -> Result<()> {
        if !self.readers_active {
            return Ok(());
        }
        let still_reading = self.reader_seq < self.last_reader_seq;
        let write_main = !is_context;
        let write_backdrop = (self.backdrop_live || self.isolated_backdrop_depth > 0) && still_reading;
        self.backend.set_targets(write_main, write_backdrop, &self.open)
    }

    /// Suspends open `context_only` clips from `scene` when entering an exported non-context node
    /// inside a `FLAG_CONTEXT` ancestor (keeping them in `self.open` for `clip_within`).
    fn suspend_context_clips(&mut self) -> Result<bool> {
        if self.context_clips_suspended {
            return Ok(false);
        }
        let any_active = self.open.iter().any(|o| {
            matches!(
                o,
                Open::Clip {
                    context_only: true,
                    active_on_scene: true,
                    ..
                }
            )
        });
        if !any_active {
            return Ok(false);
        }
        // Flush pending context ops under the active context clips first.
        self.backend.set_targets(false, false, &self.open)?;
        // Pop all active clips from scene, then reopen only non-context clips.
        for o in self.open.iter().rev() {
            if matches!(
                o,
                Open::Clip {
                    active_on_scene: true,
                    ..
                }
            ) {
                self.backend.scene().pop_clip();
            }
        }
        for o in &mut self.open {
            if let Open::Clip {
                transform,
                path,
                even_odd,
                context_only,
                active_on_scene,
                ..
            } = o
            {
                if *context_only {
                    *active_on_scene = false;
                } else if *active_on_scene {
                    let scene = self.backend.scene();
                    scene.set_transform(*transform);
                    scene.set_fill_rule(if *even_odd { Fill::EvenOdd } else { Fill::NonZero });
                    scene.push_clip_path(path);
                }
            }
        }
        self.context_clips_suspended = true;
        Ok(true)
    }

    fn resume_context_clips(&mut self) -> Result<()> {
        if !self.context_clips_suspended {
            return Ok(());
        }
        // Flush pending non-context ops before restoring context clips.
        self.backend.set_targets(false, false, &self.open)?;
        for o in self.open.iter().rev() {
            if matches!(
                o,
                Open::Clip {
                    active_on_scene: true,
                    ..
                }
            ) {
                self.backend.scene().pop_clip();
            }
        }
        for o in &mut self.open {
            if let Open::Clip {
                transform,
                path,
                even_odd,
                active_on_scene,
                ..
            } = o
            {
                let scene = self.backend.scene();
                scene.set_transform(*transform);
                scene.set_fill_rule(if *even_odd { Fill::EvenOdd } else { Fill::NonZero });
                scene.push_clip_path(path);
                *active_on_scene = true;
            }
        }
        self.context_clips_suspended = false;
        Ok(())
    }

    fn isolation(&self, has_reader: bool, copy_parent: bool) -> Isolation {
        let reading = self.needs_backdrop && self.reader_seq < self.last_reader_seq;
        let on_backdrop = reading && (self.backdrop_live || self.isolated_backdrop_depth != 0 || has_reader);
        Isolation {
            on_main: !self.current_context,
            on_backdrop,
            separate: on_backdrop && (has_reader || copy_parent),
            copy_parent,
            inherit_prefix: false,
            unfaded_main: false,
        }
    }

    fn isolate_area(
        &mut self,
        area: IRect,
        clip_to_parent: bool,
        hint: Option<(i32, i32)>,
        has_reader: bool,
        copy_parent: bool,
    ) -> Result<bool> {
        let isolation = self.isolation(has_reader, copy_parent);
        self.backend
            .push_isolated(area, clip_to_parent, hint, isolation, &self.open)
    }

    fn has_exported_subtree(&self, id: u32) -> bool {
        self.store.nodes.get(&id).is_some_and(|node| {
            !node.record.hidden()
                && (!node.record.context()
                    || (node.record.ops.iter().any(|op| matches!(op, Op::Children))
                        && node.children.iter().any(|&child| self.has_exported_subtree(child))))
        })
    }

    fn save_reader_clips(&mut self) -> usize {
        let previous = self.ancestor_clips.len();
        if self.readers_active {
            for clip in &self.open {
                if let Open::Clip {
                    frame_clip: Some(_), ..
                } = clip
                {
                    let mut clip = clip.clone();
                    if let Open::Clip { active_on_scene, .. } = &mut clip {
                        *active_on_scene = false;
                    }
                    self.ancestor_clips.push(clip);
                }
            }
        }
        previous
    }

    fn reader_open(&self) -> Vec<Open> {
        self.ancestor_clips.iter().chain(&self.open).cloned().collect()
    }

    fn skip_reader_subtree(&mut self, id: u32, parent_context: bool) -> Result<bool> {
        if self.tiled
            && let Some(&(count, first_glass)) = self.subtree_readers.get(&id)
        {
            if first_glass && self.needs_backdrop && !self.backdrop_live {
                self.backend.snapshot_backdrop(&self.open)?;
                self.backdrop_live = true;
            } else {
                self.backend.flush_barrier(&self.open);
            }
            self.reader_seq += count;
            self.sync_targets(parent_context)?;
            return Ok(true);
        }
        Ok(false)
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
    fn draw_children(
        &mut self,
        parent_id: u32,
        op_idx: usize,
        world: Affine,
        inner: f32,
        parent_context: bool,
    ) -> Result<()> {
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
            return self.children(parent_id, op_idx, &parent_node.children, world, inner, parent_context);
        }
        self.yield_safe_depth += 1;
        let res = (|| -> Result<()> {
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
                        self.draw_picture_mask(mid, mkind, &ids, world, inner, parent_context)?;
                    }
                    if clipping {
                        self.open.pop();
                        self.backend.scene().pop_clip();
                        clipping = false;
                    }
                    let refused = cr.refusing_bits();
                    if refused != 0 {
                        return Err(EngineError::unsupported(format!(
                            "record {cid} needs features {refused:#x}"
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
                                frame_clip: None,
                                source: clip_source(cid, cr, 0),
                                context_only: parent_context,
                                active_on_scene: true,
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
                        self.draw_picture_mask(mid, mkind, &ids, world, inner, parent_context)?;
                    }
                    if clipping {
                        self.open.pop();
                        self.backend.scene().pop_clip();
                        clipping = false;
                    }
                    self.node(cid, world, inner, parent_context)?;
                    continue;
                }
                if let Some((_, _, ref mut ids)) = pic_scope {
                    ids.push(cid);
                } else {
                    self.node(cid, world, inner, parent_context)?;
                }
            }
            if let Some((mid, mkind, ids)) = pic_scope.take() {
                self.draw_picture_mask(mid, mkind, &ids, world, inner, parent_context)?;
            }
            if clipping {
                self.open.pop();
                self.backend.scene().pop_clip();
            }
            Ok(())
        })();
        self.yield_safe_depth -= 1;
        self.heavy_op_ran = true;
        res
    }

    fn draw_picture_mask(
        &mut self,
        mask_id: u32,
        mask_kind: u32,
        ids: &[u32],
        world: Affine,
        inner: f32,
        parent_context: bool,
    ) -> Result<()> {
        if ids.is_empty() {
            return Ok(());
        }
        if parent_context && ids.iter().any(|&id| self.has_exported_subtree(id)) {
            return Err(EngineError::unsupported(
                "an export selection crossing a backdrop picture mask",
            ));
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
        let content_has_reader = ids
            .iter()
            .any(|id| self.subtree_readers.get(id).is_some_and(|&(n, _)| n > 0));
        let picture_has_reader = self.subtree_readers.get(&mask_id).is_some_and(|&(n, _)| n > 0);
        let has_reader = content_has_reader || picture_has_reader;
        if mask_area.is_empty() {
            if has_reader {
                for id in ids.iter().copied().chain(std::iter::once(mask_id)) {
                    self.skip_reader_subtree(id, parent_context)?;
                }
            }
            if self.tiled && !whole_mask.is_empty() {
                self.backend.flush_barrier(&self.open);
            }
            return Ok(());
        }
        self.scope()?;
        let mut isolation = self.isolation(has_reader, false);
        isolation.inherit_prefix = content_has_reader;
        let paired = isolation.separate;
        if !self
            .backend
            .push_isolated(mask_area, true, None, isolation, &self.open)?
        {
            if self.tiled && !whole_mask.is_empty() {
                self.backend.flush_barrier(&self.open);
            }
            return Ok(());
        }
        let content_tb = self.backend.target_bounds();
        let previous_reader_clips = self.save_reader_clips();
        self.isolated_backdrop_depth += usize::from(paired);
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
                self.node(cid, world, inner, parent_context)?;
            }
            Ok(())
        })();
        while let Some(o) = self.open.pop() {
            match o {
                Open::Clip { active_on_scene, .. } => {
                    if active_on_scene {
                        self.backend.scene().pop_clip();
                    }
                }
                Open::Layer => self.backend.scene().pop_layer(),
            }
        }
        if let Err(e) = content_res {
            self.viewport = prev_viewport;
            self.full_frame = prev_full_frame;
            self.full_viewport = prev_full_viewport;
            self.open = prev_open;
            self.ancestor_clips.truncate(previous_reader_clips);
            self.isolated_backdrop_depth -= usize::from(paired);
            self.backend.abort_isolated(&self.open);
            return Err(e);
        }
        if self.backend.stop_early() {
            self.viewport = prev_viewport;
            self.full_frame = prev_full_frame;
            self.full_viewport = prev_full_viewport;
            self.open = prev_open;
            self.ancestor_clips.truncate(previous_reader_clips);
            self.isolated_backdrop_depth -= usize::from(paired);
            self.backend.abort_isolated(&self.open);
            return Ok(());
        }
        let pushed_pic = match self.isolate_area(content_tb, false, None, picture_has_reader, false) {
            Ok(p) => p,
            Err(e) => {
                self.viewport = prev_viewport;
                self.full_frame = prev_full_frame;
                self.full_viewport = prev_full_viewport;
                self.open = prev_open;
                self.ancestor_clips.truncate(previous_reader_clips);
                self.isolated_backdrop_depth -= usize::from(paired);
                self.backend.abort_isolated(&self.open);
                return Err(e);
            }
        };
        if !pushed_pic {
            self.viewport = prev_viewport;
            self.full_frame = prev_full_frame;
            self.full_viewport = prev_full_viewport;
            self.open = prev_open;
            self.ancestor_clips.truncate(previous_reader_clips);
            self.isolated_backdrop_depth -= usize::from(paired);
            self.backend.abort_isolated(&self.open);
            return Ok(());
        }
        let mask_res = self.node(mask_id, world, 1.0, parent_context);
        while let Some(o) = self.open.pop() {
            match o {
                Open::Clip { active_on_scene, .. } => {
                    if active_on_scene {
                        self.backend.scene().pop_clip();
                    }
                }
                Open::Layer => self.backend.scene().pop_layer(),
            }
        }
        self.viewport = prev_viewport;
        self.full_frame = prev_full_frame;
        self.full_viewport = prev_full_viewport;
        self.open = prev_open;
        self.ancestor_clips.truncate(previous_reader_clips);
        self.isolated_backdrop_depth -= usize::from(paired);
        if let Err(e) = mask_res {
            self.backend.abort_isolated(&self.open);
            self.backend.abort_isolated(&self.open);
            return Err(e);
        }
        self.backend.pop_composited(0, 1.0, Some(mask_kind), &self.open)?;
        Ok(())
    }

    fn node(&mut self, id: u32, parent: Affine, alpha: f32, parent_context: bool) -> Result<()> {
        let on_path = self.split.pass != Pass::All && self.split.path.contains(&id);
        // A subtree that isn't on the selection's path lies wholly in one part: skipped when
        // that isn't the part being drawn.
        if self.split.pass != Pass::All && !on_path && !self.paints() {
            return Ok(());
        }
        let before = self.current_context;
        let drawn = self.node_inner(id, parent, alpha, parent_context);
        self.current_context = before;
        // Past a node on the selection's path, paint order has passed the selection, whether
        // the node was walked or culled (hidden, off the tile, transparent): what follows is
        // above it.
        if on_path {
            self.phase = Phase::After;
        }
        drawn
    }

    fn node_inner(&mut self, id: u32, parent: Affine, alpha: f32, parent_context: bool) -> Result<()> {
        if self.backend.stop_early() {
            return Ok(());
        }
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
            if !self.skip_reader_subtree(id, parent_context)?
                && self.tiled
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
            self.records_since_probe += 1;
            if self.stats.culled >= 256 {
                self.made_progress = true;
            }
            return Ok(());
        }
        if self.frame.detail || self.rough {
            let speck = if self.rough { ROUGH_SPECK } else { 0.5 };
            if !r.group() {
                let b = device.transform_rect_bbox(Rect::new(0.0, 0.0, f64::from(r.size[0]), f64::from(r.size[1])));
                if b.width() < speck && b.height() < speck {
                    self.stats.culled += 1;
                    self.stats.specks += 1;
                    self.records_since_probe += 1;
                    return Ok(());
                }
            } else if dev_bbox.width() < speck && dev_bbox.height() < speck && !self.subtree_readers.contains_key(&id) {
                self.stats.culled += 1;
                self.stats.specks += 1;
                self.records_since_probe += 1;
                return Ok(());
            }
        }
        let refused = r.refusing_bits();
        if refused != 0 {
            return Err(EngineError::unsupported(format!(
                "record {id} needs features {refused:#x}"
            )));
        }
        let resume_op: Option<usize> = (self.resume_depth < self.resume_path.len()
            && self.resume_path[self.resume_depth].0 == id)
            .then(|| self.resume_path[self.resume_depth].1);
        if resume_op.is_none() {
            self.stats.records += 1;
            self.records_since_probe += 1;
            self.made_progress = true;
        }
        let skipping_post = self.skip_post_record == Some(id);
        if skipping_post {
            self.skip_post_record = None;
        }
        let is_context = r.context();
        if self.rough && is_context {
            // Export context only feeds readers, and a rough stand-in has none.
            return Ok(());
        }
        let in_alpha = if parent_context && !is_context { 1.0 } else { alpha };
        let opacity = if skipping_post { 1.0 } else { in_alpha * r.opacity };
        if opacity <= 0.0 {
            return Ok(());
        }
        let suspended = if parent_context && !is_context {
            self.suspend_context_clips()?
        } else {
            false
        };
        self.current_context = is_context;
        self.sync_targets(is_context)?;
        // A rough stand-in draws a layer's content plainly: no effects, blend or isolation.
        let plain = skipping_post || self.rough;
        let active = if plain {
            Vec::new()
        } else {
            active_posts(r, device, view_scale)
        };
        let has_post = !active.is_empty();
        let layer_blend = if plain { 0 } else { r.blend };
        let has_reader = self.subtree_readers.get(&id).is_some_and(|&(n, _)| n > 0);
        let reader_fade = self.isolated_with_reader.contains(&id);
        let crosses_context = is_context
            && (has_post || layer_blend != 0 || (r.isolate() && r.opacity < 1.0))
            && r.ops.iter().any(|op| matches!(op, Op::Children))
            && node.children.iter().any(|&child| self.has_exported_subtree(child));
        if crosses_context && (has_post || layer_blend != 0) {
            return Err(EngineError::unsupported(
                "an export selection crossing a backdrop effect or blend",
            ));
        }
        // Route eligible layer blends directly to fixed-function hardware blending in Vello's
        // strip pass, bypassing offscreen isolation and scopeClip rasterization. A rough stand-in
        // has no blend (`plain`), so none is routed.
        let hw_layer_blend =
            (!has_post && layer_blend != 0 && opacity >= 1.0 && !has_reader && !reader_fade && !crosses_context)
                .then(|| {
                    self.can_hw_blend_now(layer_blend)
                        .filter(|_| self.can_hw_blend_layer(id, world, is_context))
                })
                .flatten();
        let isolate = if plain || hw_layer_blend.is_some() {
            false
        } else {
            has_post || layer_blend != 0 || (r.isolate() && r.opacity < 1.0)
        };
        let through = !plain
            && !has_post
            && layer_blend == 0
            && r.isolate()
            && r.opacity < 1.0
            && (store.subtree_has_blend(id) || reader_fade || crosses_context);
        let use_offscreen = if plain || hw_layer_blend.is_some() {
            false
        } else {
            has_post || layer_blend != 0 || through || (isolate && store.subtree_has_pass(id))
        };
        let mut isolation = self.isolation(has_reader, through);
        isolation.inherit_prefix = has_reader;
        if crosses_context {
            isolation.on_main = true;
            isolation.separate = true;
            isolation.unfaded_main = true;
        }
        let paired = isolation.separate;
        let previous_reader_clips = self.ancestor_clips.len();
        let inner = if isolate { 1.0 } else { opacity };
        let mut post_state: Option<PostIsoState> = None;
        let saved_open = if has_post {
            self.scope()?;
            let unbounded = self.backend.allow_unbounded_view_blur();
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
            let max_side = self.store.limits.texture_side as i32;
            // Case L3 (native pass): upsample and composite the coarse post-effect scope already
            // captured in the far reader-halo tier, skipping redundant re-execution of its subtree.
            if unbounded && self.backend.has_captured_post_scope(id) {
                if let Some(&(count, first_glass)) = self.subtree_readers.get(&id) {
                    if first_glass && self.needs_backdrop && !self.backdrop_live {
                        self.backend.snapshot_backdrop(&self.open)?;
                        self.backdrop_live = true;
                    }
                    if !out_area.is_empty()
                        && let Some(lb_idx) = active.iter().rposition(|p| matches!(p, ActivePost::LayerBlur { .. }))
                    {
                        let (upsample_area, tail_steps) =
                            Self::build_tail_post_steps(&active[lb_idx + 1..], out_area, max_side)?;
                        self.stats.reduced += 1;
                        self.backend.composite_reduced_post(
                            ReducedPost::Captured(id),
                            upsample_area,
                            &tail_steps,
                            isolation,
                            layer_blend,
                            opacity,
                            &self.open,
                        )?;
                    }
                    self.reader_seq += count;
                    self.sync_targets(is_context)?;
                }
                if suspended {
                    self.resume_context_clips()?;
                }
                return Ok(());
            }
            let inner_pad = (page_pad - r.post_pad()).max(0.0);
            let inner_pad_dev = if inner_pad > 0.0 {
                inner_pad * view_scale + 2.0
            } else {
                0.0
            };
            let content_bbox = device.transform_rect_bbox(bounds).inflate(inner_pad_dev, inner_pad_dev);
            let content_rect = IRect::around(content_bbox).inflate(2, 2);
            let mut total_post_pad = 0i32;
            let mut max_step = 4i32;
            for pe in &active {
                match *pe {
                    ActivePost::LayerBlur { sigma } => {
                        if !out_area.is_empty() {
                            let check_cb = IRect {
                                x0: 0,
                                y0: 0,
                                x1: (out_area.x1 - out_area.x0).max(1),
                                y1: (out_area.y1 - out_area.y0).max(1),
                            };
                            if unbounded {
                                crate::blur::validate_view_sigma(sigma, check_cb, crate::blur::EdgeMode::Zero)?;
                            } else {
                                crate::blur::validate_sigma(sigma, check_cb, crate::blur::EdgeMode::Zero)?;
                            }
                        }
                        if sigma > crate::blur::DIRECT_SIGMA_MAX {
                            let (lvl, _) = if unbounded {
                                crate::blur::choose_level_view(sigma)
                            } else {
                                crate::blur::choose_level(sigma, crate::blur::MAX_PYRAMID_LEVELS)
                            };
                            max_step = max_step.max(crate::blur::level_step(lvl));
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
                total_post_pad = total_post_pad.saturating_add(pe.src_pad(unbounded));
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
            let raw_src = if unbounded {
                let out_f = Rect::new(
                    f64::from(out_area.x0) - f64::from(total_post_pad),
                    f64::from(out_area.y0) - f64::from(total_post_pad),
                    f64::from(out_area.x1) + f64::from(total_post_pad),
                    f64::from(out_area.y1) + f64::from(total_post_pad),
                );
                let src_f = content_bbox.inflate(2.0, 2.0).intersect(out_f);
                if src_f.width() <= 0.0 || src_f.height() <= 0.0 {
                    IRect {
                        x0: 0,
                        y0: 0,
                        x1: 0,
                        y1: 0,
                    }
                } else {
                    IRect::around(src_f)
                }
            } else {
                content_rect.intersect(out_area.inflate(total_post_pad, total_post_pad))
            };
            if raw_src.is_empty() {
                if self.tiled && whole_would_flush {
                    self.backend.flush_barrier(&self.open);
                }
                return Ok(());
            }
            let capture_scope = if unbounded {
                self.backend
                    .capturing_coarse_post_scope(id)
                    .map(|(div, vis, fs)| (id, div, vis, fs))
            } else {
                None
            };
            let phase = view_grid_phase(self.frame.view, max_step);
            let last_blur = active.iter().enumerate().rev().find_map(|(idx, p)| match *p {
                ActivePost::LayerBlur { sigma } => Some((idx, sigma)),
                _ => None,
            });
            // Case L2: a reader-free GPU view layer blur whose padded source exceeds the native
            // texture or memory limits draws on a reduced grid (`exec_reduced_layer_blur`).
            let native_src_res = align_area_checked(raw_src, max_step, phase, max_side);
            let try_reduced = unbounded
                && !has_reader
                && capture_scope.is_none()
                && last_blur.is_some_and(|(_, lb_sig)| lb_sig >= 16.0);
            let prefer_reduced = if try_reduced {
                let limits = self.backend.reduced_layer_blur_limits();
                let (native_side, native_px) = (limits.native_side, limits.native_pixels);
                let rw = (raw_src.x1 - raw_src.x0).max(0) as u32;
                let rh = (raw_src.y1 - raw_src.y0).max(0) as u32;
                let big_over_cap = last_blur.is_some_and(|(_, lb_sig)| {
                    lb_sig > crate::blur::MAX_BLUR_SIGMA && (rw > native_side / 2 || rh > native_side / 2)
                });
                native_src_res.is_err()
                    || rw > native_side
                    || rh > native_side
                    || (rw as usize).saturating_mul(rh as usize) > native_px
                    || big_over_cap
            } else {
                false
            };
            if prefer_reduced {
                let (lb_idx, lb_sigma) = last_blur.expect("checked");
                self.exec_reduced_layer_blur(
                    id,
                    parent,
                    opacity,
                    layer_blend,
                    isolation,
                    out_area,
                    raw_src,
                    &active,
                    lb_idx,
                    lb_sigma,
                )?;
                if suspended {
                    self.resume_context_clips()?;
                }
                return Ok(());
            }
            let src_area = native_src_res?;
            let step = max_step.max(1);
            let scene_hint = (
                ((content_rect.x0 - phase.0).div_euclid(step) * step + phase.0).div_euclid(4) * 4,
                ((content_rect.y0 - phase.1).div_euclid(step) * step + phase.1).div_euclid(4) * 4,
            );
            let pushed = match self
                .backend
                .push_isolated(src_area, false, Some(scene_hint), isolation, &self.open)
            {
                Ok(p) => p,
                Err(e) if try_reduced && e.code == crate::error::ErrorCode::Limit => {
                    let (lb_idx, lb_sigma) = last_blur.expect("checked");
                    self.exec_reduced_layer_blur(
                        id,
                        parent,
                        opacity,
                        layer_blend,
                        isolation,
                        out_area,
                        raw_src,
                        &active,
                        lb_idx,
                        lb_sigma,
                    )?;
                    if suspended {
                        self.resume_context_clips()?;
                    }
                    return Ok(());
                }
                Err(e) => return Err(e),
            };
            if !pushed {
                if self.tiled && whole_would_flush {
                    self.backend.flush_barrier(&self.open);
                }
                return Ok(());
            }
            if capture_scope.is_some() {
                self.backend.set_inside_coarse_post_scope(1);
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
            self.save_reader_clips();
            self.isolated_backdrop_depth += usize::from(paired);
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
                capture_scope,
            });
            None
        } else if use_offscreen {
            self.scope()?;
            // A pass-through reader still sees the whole parent prefix, including its halo.
            let raw_iso = if reader_fade || crosses_context {
                self.backend.target_bounds()
            } else {
                IRect::around(dev_bbox.inflate(1.0, 1.0))
            };
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
            let pushed = self
                .backend
                .push_isolated(iso_area, true, None, isolation, &self.open)?;
            if !pushed {
                if self.tiled && !whole_iso.is_empty() {
                    self.backend.flush_barrier(&self.open);
                }
                return Ok(());
            }
            self.save_reader_clips();
            self.isolated_backdrop_depth += usize::from(paired);
            let prev_full_frame = self.full_frame;
            self.full_frame = if reader_fade || crosses_context {
                prev_full_frame
            } else {
                whole_iso
            };
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
        if coarse && resume_op.is_none() {
            self.stats.coarse += 1;
        }
        let ops = if coarse { &r.coarse } else { &r.ops };
        let entered_non_yieldable = has_post || use_offscreen || isolate || hw_layer_blend.is_some();
        if entered_non_yieldable {
            self.yield_safe_depth += 1;
        }
        let prev_hw_blend = hw_layer_blend.map(|hw_mode| {
            let prev = self.active_hw_blend;
            self.active_hw_blend = hw_mode;
            self.backend.scene().set_hw_blend(hw_mode);
            prev
        });
        let saved_yield_depth = self.yield_safe_depth;
        // Evaluate only on records that actually draw a drop shadow.
        let mut layered_shadows = None;
        let depth = self.open.len();
        let mut active_alpha = inner;
        let mut layer_stack: Vec<(f32, bool)> = Vec::new();
        let mut mask_depth = 0usize;
        let res = (|| -> Result<()> {
            for (at, op) in ops.iter().enumerate() {
                if self.backend.stop_early() || self.paused {
                    break;
                }
                if let Some(target_op) = resume_op {
                    if at < target_op {
                        // Fast-forward along the resumed ancestor: replay only open/close clips
                        // without re-charging verb budgets or re-executing already drawn ops.
                        match op {
                            Op::Clip { path, .. }
                                if !is_context
                                    && !has_reader
                                    && self.clip_changes_nothing(id, r, &ops[at + 1..], *path, device) => {}
                            Op::Clip { path, even_odd } => {
                                self.scope()?;
                                let saved_verbs = self.verbs_left;
                                let saved_stat_verbs = self.stats.verbs;
                                let p = self.path(r, *path, device, 0.0)?;
                                self.verbs_left = saved_verbs;
                                self.stats.verbs = saved_stat_verbs;
                                let sd = self.scene_device(device);
                                let scene = self.backend.scene();
                                scene.set_transform(sd);
                                scene.set_fill_rule(if *even_odd { Fill::EvenOdd } else { Fill::NonZero });
                                scene.push_clip_path(&p);
                                self.open.push(Open::Clip {
                                    transform: sd,
                                    path: p,
                                    even_odd: *even_odd,
                                    frame_clip: clip_wraps_children(ops, at).then(|| FrameClip {
                                        device_box: device.transform_rect_bbox(Rect::new(
                                            0.0,
                                            0.0,
                                            f64::from(r.size[0]),
                                            f64::from(r.size[1]),
                                        )),
                                        fill: frame_solid_fill(ops, at, active_alpha),
                                    }),
                                    source: clip_source(id, r, *path),
                                    context_only: is_context,
                                    active_on_scene: true,
                                });
                            }
                            Op::Unclip if self.open.len() > depth => {
                                self.open.pop();
                                self.backend.scene().pop_clip();
                            }
                            _ => {}
                        }
                        continue;
                    }
                    if at == target_op {
                        if matches!(op, Op::Children) {
                            self.draw_children(id, at, world, active_alpha, is_context)?;
                            if !self.paused {
                                self.sync_targets(is_context)?;
                            }
                        }
                        continue;
                    }
                }
                self.stats.ops += 1;
                match op {
                    Op::Fill { .. }
                    | Op::Stroke { .. }
                    | Op::Read { .. }
                    | Op::Glass(_)
                    | Op::BackgroundBlur(_)
                    | Op::ProgressiveBlur(_)
                    | Op::DropShadow { .. }
                    | Op::InnerShadow { .. }
                        if !self.paints() => {}
                    Op::Read { .. }
                    | Op::Glass(_)
                    | Op::BackgroundBlur(_)
                    | Op::ProgressiveBlur(_)
                    | Op::DropShadow { .. }
                    | Op::InnerShadow { .. }
                        if self.rough => {}
                    Op::Fill {
                        path,
                        even_odd,
                        paint,
                        blend,
                    } => {
                        self.sync_targets(is_context)?;
                        self.fill(
                            r,
                            *path,
                            device,
                            *even_odd,
                            paint,
                            if self.rough { 0 } else { *blend },
                            active_alpha,
                            mask_depth == 0,
                        )?;
                    }
                    Op::Stroke {
                        path,
                        style,
                        paint,
                        blend,
                        cache,
                    } => {
                        self.sync_targets(is_context)?;
                        let blend = if self.rough { 0 } else { *blend };
                        self.stroke(r, *path, device, style, paint, blend, active_alpha, cache)?;
                    }
                    Op::Clip { path, .. }
                        if !is_context
                            && !has_reader
                            && self.clip_changes_nothing(id, r, &ops[at + 1..], *path, device) =>
                    {
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
                            frame_clip: clip_wraps_children(ops, at).then(|| FrameClip {
                                device_box: device.transform_rect_bbox(Rect::new(
                                    0.0,
                                    0.0,
                                    f64::from(r.size[0]),
                                    f64::from(r.size[1]),
                                )),
                                fill: frame_solid_fill(ops, at, active_alpha),
                            }),
                            source: clip_source(id, r, *path),
                            context_only: is_context,
                            active_on_scene: true,
                        });
                    }
                    Op::Unclip => {
                        if self.open.len() > depth {
                            self.open.pop();
                            self.backend.scene().pop_clip();
                        }
                    }
                    Op::Layer { compose } => {
                        let is_destructive = matches!(compose, ComposeMode::DestOut | ComposeMode::DestIn);
                        if is_destructive && !self.open.iter().any(|o| matches!(o, Open::Layer)) {
                            self.backend.before_destructive_root_layer(&self.open)?;
                        }
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
                        self.yield_safe_depth += 1;
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
                            self.yield_safe_depth = self.yield_safe_depth.saturating_sub(1);
                            if let Some((prev_alpha, is_mask)) = layer_stack.pop() {
                                active_alpha = prev_alpha;
                                if is_mask {
                                    mask_depth = mask_depth.saturating_sub(1);
                                }
                            }
                        }
                    }
                    Op::Children => {
                        self.draw_children(id, at, world, active_alpha, is_context)?;
                        if !self.paused {
                            self.sync_targets(is_context)?;
                        }
                    }
                    Op::Read { kernel, halo } => {
                        self.stats.reads += 1;
                        self.reader_seq += 1;
                        self.sync_targets(is_context)?;
                        let b = Rect::new(0.0, 0.0, f64::from(r.size[0]), f64::from(r.size[1]));
                        let h = f64::from(*halo);
                        let paints = IRect::around(device.transform_rect_bbox(b));
                        let reads = IRect::around(device.transform_rect_bbox(b.inflate(h, h)));
                        let open = self.reader_open();
                        self.backend.read(*kernel, paints, reads, &open)?;
                        self.sync_targets(is_context)?;
                        self.heavy_op_ran = true;
                    }
                    Op::Glass(g) => {
                        // A context record's glass writes neither to output nor to backdrop
                        // (decision 0007 amendment + decision 0039).
                        if is_context {
                            continue;
                        }
                        if self.needs_backdrop && !self.backdrop_live {
                            let open = self.reader_open();
                            self.backend.snapshot_backdrop(&open)?;
                            self.backdrop_live = true;
                        }
                        self.stats.reads += 1;
                        self.reader_seq += 1;
                        let mut paths = Vec::with_capacity(g.paths.len());
                        for &pi in &g.paths {
                            let p = self.path(r, pi, device, 0.0)?;
                            paths.push((p, g.even_odd));
                        }
                        let glass_coarse = self.coarse_readers;
                        if glass_coarse {
                            self.stats.coarse += 1;
                        }
                        let open = self.reader_open();
                        self.backend.glass(
                            (id, at),
                            g,
                            &paths,
                            device,
                            r.size,
                            active_alpha,
                            glass_coarse,
                            layer_blend != 0,
                            &open,
                        )?;
                        self.sync_targets(is_context)?;
                        self.heavy_op_ran = true;
                    }
                    Op::BackgroundBlur(bb) => {
                        self.stats.reads += 1;
                        self.reader_seq += 1;
                        self.sync_targets(is_context)?;
                        let mut paths = Vec::with_capacity(bb.paths.len());
                        for &pi in &bb.paths {
                            let p = self.path(r, pi, device, 0.0)?;
                            paths.push((p, bb.even_odd));
                        }
                        let blur_coarse = self.coarse_readers && bb.radius > 0.0;
                        if blur_coarse {
                            self.stats.coarse += 1;
                        }
                        let open = self.reader_open();
                        self.backend.background_blur(
                            Some((id, at)),
                            bb,
                            &paths,
                            device,
                            r.size,
                            inner,
                            blur_coarse,
                            &open,
                        )?;
                        self.sync_targets(is_context)?;
                        self.heavy_op_ran = true;
                    }
                    Op::ProgressiveBlur(pb) => {
                        self.stats.reads += 1;
                        self.reader_seq += 1;
                        self.sync_targets(is_context)?;
                        let mut paths = Vec::with_capacity(pb.paths.len());
                        for &pi in &pb.paths {
                            let p = self.path(r, pi, device, 0.0)?;
                            paths.push((p, pb.even_odd));
                        }
                        let blur_coarse = self.coarse_readers && pb.start_radius.max(pb.end_radius) > 0.0;
                        if blur_coarse {
                            self.stats.coarse += 1;
                        }
                        let open = self.reader_open();
                        self.backend.progressive_blur(
                            (id, at),
                            pb,
                            &paths,
                            device,
                            r.size,
                            inner,
                            blur_coarse,
                            &open,
                        )?;
                        self.sync_targets(is_context)?;
                        self.heavy_op_ran = true;
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
                        self.sync_targets(is_context)?;
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
                        self.heavy_op_ran = true;
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
                        self.sync_targets(is_context)?;
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
                        self.heavy_op_ran = true;
                    }
                }
            }
            Ok(())
        })();
        self.yield_safe_depth = saved_yield_depth;
        if let Some(prev_hw) = prev_hw_blend {
            self.backend.scene().set_hw_blend(prev_hw);
            self.active_hw_blend = prev_hw;
        }
        if entered_non_yieldable {
            self.yield_safe_depth -= 1;
            self.heavy_op_ran = true;
        }
        if self.paused {
            while self.open.len() > depth {
                if let Some(o) = self.open.pop() {
                    match o {
                        Open::Clip { active_on_scene, .. } => {
                            if active_on_scene {
                                self.backend.scene().pop_clip();
                            }
                        }
                        Open::Layer => self.backend.scene().pop_layer(),
                    }
                }
            }
            return res;
        }
        if let Some(post) = post_state {
            if post.capture_scope.is_some() {
                self.backend.set_inside_coarse_post_scope(-1);
            }
            self.ancestor_clips.truncate(previous_reader_clips);
            self.isolated_backdrop_depth -= usize::from(paired);
            self.viewport = post.prev_viewport;
            self.full_frame = post.prev_full_frame;
            self.full_viewport = post.prev_full_viewport;
            while let Some(o) = self.open.pop() {
                match o {
                    Open::Clip { active_on_scene, .. } => {
                        if active_on_scene {
                            self.backend.scene().pop_clip();
                        }
                    }
                    Open::Layer => self.backend.scene().pop_layer(),
                }
            }
            self.open = post.prev_open;
            if res.is_ok() && !self.backend.stop_early() {
                let unbounded = self.backend.allow_unbounded_view_blur();
                let max_side = self.store.limits.texture_side as i32;
                let mut steps = Vec::with_capacity(post.posts.len());
                let mut post_res = Ok(());
                let mut grown = 0i32;
                let total = post.posts.len();
                let mut rem_pads = vec![0i32; total];
                let mut suffix = 0i32;
                for i in (0..total).rev() {
                    rem_pads[i] = suffix;
                    suffix = suffix.saturating_add(post.posts[i].src_pad(unbounded));
                }
                for (idx, pe) in post.posts.into_iter().enumerate() {
                    grown = grown.saturating_add(pe.grow_pad(unbounded));
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
                    if let Some((scope_id, render_div, visible, frame_size)) = post.capture_scope
                        && let Some(lb_idx) = steps.iter().rposition(|s| matches!(s, PostStep::LayerBlur { .. }))
                    {
                        let PostStep::LayerBlur {
                            out_area: blur_out_area,
                            ..
                        } = steps[lb_idx]
                        else {
                            unreachable!("found by rposition");
                        };
                        take_grid_variance(
                            steps[..=lb_idx].iter_mut().filter_map(|step| match step {
                                PostStep::LayerBlur { sigma, .. } => Some(sigma),
                                _ => None,
                            }),
                            render_div,
                        );
                        post_res = self.backend.apply_post_isolated(&steps[..=lb_idx]);
                        if post_res.is_ok() {
                            let cap_area = blur_out_area
                                .intersect(visible.inflate(2, 2))
                                .clamp(frame_size.0, frame_size.1);
                            post_res = self.backend.capture_post_scope(scope_id, cap_area);
                        }
                        if post_res.is_ok() && lb_idx + 1 < steps.len() {
                            post_res = self.backend.apply_post_isolated(&steps[lb_idx + 1..]);
                        }
                    } else {
                        post_res = self.backend.apply_post_isolated(&steps);
                    }
                }
                if let Err(e) = post_res {
                    self.backend.abort_isolated(&self.open);
                    return Err(e);
                }
                if post.blend != 0 {
                    self.backend.pop_blended(post.blend, opacity, &self.open)?;
                } else {
                    self.backend.pop_isolated(opacity, &self.open)?;
                }
            } else {
                self.backend.abort_isolated(&self.open);
            }
            if res.is_ok() && suspended {
                self.resume_context_clips()?;
            }
            return res;
        }
        if let Some((prev_open, prev_full_frame)) = saved_open {
            self.ancestor_clips.truncate(previous_reader_clips);
            self.isolated_backdrop_depth -= usize::from(paired);
            self.full_frame = prev_full_frame;
            while let Some(o) = self.open.pop() {
                match o {
                    Open::Clip { active_on_scene, .. } => {
                        if active_on_scene {
                            self.backend.scene().pop_clip();
                        }
                    }
                    Open::Layer => self.backend.scene().pop_layer(),
                }
            }
            self.open = prev_open;
            if res.is_ok() && !self.backend.stop_early() {
                if through {
                    self.backend
                        .pop_blended(crate::blend::BLEND_LERP, opacity, &self.open)?;
                } else if layer_blend != 0 {
                    self.backend.pop_blended(layer_blend, opacity, &self.open)?;
                } else {
                    self.backend.pop_isolated(opacity, &self.open)?;
                }
            } else {
                self.backend.abort_isolated(&self.open);
            }
            if res.is_ok() && suspended {
                self.resume_context_clips()?;
            }
            return res;
        }
        res?;
        if isolate {
            self.open.pop();
            self.backend.scene().pop_layer();
        }
        if suspended {
            self.resume_context_clips()?;
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
                let expanded_stops: Vec<ColorStop> = expand_gradient_stops(stops, alpha)
                    .into_iter()
                    .map(|(t, c)| ColorStop::from((t, color(c, 1.0))))
                    .collect();
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
                let (x, y) = crate::images::span(device * *matrix);
                // Keep the strict raw-image API's width-based sampling. The view
                // uses both axes to match its independently streamed levels.
                let span = (x, if self.store.view_images { y } else { 0.0 });
                let Some(view) = self.backend.image(*image, span) else {
                    if !self.store.view_images {
                        return Err(EngineError::unknown(format!("image {image} isn't held")));
                    }
                    // The view marks pending image loads provisional. A failed
                    // image's checkerboard is a settled paint at this residency.
                    return self.set_paint(&Paint::Placeholder(*opacity), device, alpha, region);
                };
                let texel =
                    *matrix * Affine::scale_non_uniform(1.0 / f64::from(view.width), 1.0 / f64::from(view.height));
                if !sampleable(device, texel, region, *tile) {
                    return Ok(false);
                }
                let quality = if span.0 > f64::from(view.width) || span.1 > f64::from(view.height) {
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
            if let Some(hw_mode) = self.can_hw_blend_fill(r, i, u32::from(blend)) {
                return self.with_hw_blend(hw_mode, |walk| {
                    walk.fill(r, i, device, even_odd, paint, 0, alpha, allow_glyph_masks)
                });
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
            if !self.isolate_area(area, true, None, false, false)? {
                return Ok(());
            }
            let prev_open = std::mem::take(&mut self.open);
            let res = self.fill(r, i, device, even_odd, paint, 0, alpha, allow_glyph_masks);
            self.open = prev_open;
            if res.is_ok() {
                self.backend.pop_blended(u32::from(blend), 1.0, &self.open)?;
            } else {
                self.backend.abort_isolated(&self.open);
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
        self.backend.mark_dirty();
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
        cache: &crate::stroke::StrokeCache,
    ) -> Result<()> {
        if style.width <= 0.0 {
            return Ok(());
        }
        if blend != 0 {
            if !paint_visible(paint, alpha) {
                return Ok(());
            }
            if let Some(hw_mode) = self.can_hw_blend_now(u32::from(blend)) {
                return self.with_hw_blend(hw_mode, |walk| walk.stroke(r, i, device, style, paint, 0, alpha, cache));
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
            if !self.isolate_area(area, true, None, false, false)? {
                return Ok(());
            }
            let prev_open = std::mem::take(&mut self.open);
            let res = self.stroke(r, i, device, style, paint, 0, alpha, cache);
            self.open = prev_open;
            if res.is_ok() {
                self.backend.pop_blended(u32::from(blend), 1.0, &self.open)?;
            } else {
                self.backend.abort_isolated(&self.open);
            }
            return res;
        }
        let stroke_limits = crate::limits::Limits {
            frame_verbs: self.verbs_left,
            ..self.store.limits
        };
        if let Some(expanded) = crate::stroke::resolve_stroke_outline(
            r,
            i,
            style,
            cache,
            &self.store.glyphs,
            &stroke_limits,
            crate::stroke::max_scale(device),
            &self.store.strokes,
        )? {
            if expanded.path.is_empty() {
                return Ok(());
            }
            self.spend(expanded.path.len())?;
            if !self.set_paint(paint, device, alpha, self.region(r, i, style.reach()))? {
                return Ok(());
            }
            let outline = expanded.path.to_bez();
            let sd = self.scene_device(device);
            let scene = self.backend.scene();
            scene.set_transform(sd);
            scene.set_fill_rule(if expanded.even_odd {
                Fill::EvenOdd
            } else {
                Fill::NonZero
            });
            scene.fill_path(&outline);
            self.backend.mark_dirty();
            return Ok(());
        }
        // Fallback only for viewport-dependent `PathEntry::Outside` strokes (fuzz inputs).
        let reach = stroke_paint_reach(style);
        let p = self.path(r, i, device, reach)?;
        if p.is_empty() {
            return Ok(());
        }
        if !style.dashes.is_empty() {
            let length = polygon_length(&p);
            crate::record::check_dashes(style, length, &stroke_limits)?;
            let period: f64 = style.dashes.iter().map(|d| f64::from(*d)).sum();
            self.spend((length / period * style.dashes.len() as f64).ceil() as usize)?;
        }
        let (stroke_path, kurbo_stroke) = crate::stroke::prepare_dashed_stroke(&p, style, &stroke_limits)?;
        if !self.set_paint(paint, device, alpha, self.region(r, i, style.reach()))? {
            return Ok(());
        }
        let sd = self.scene_device(device);
        let scene = self.backend.scene();
        scene.set_transform(sd);
        scene.set_stroke(kurbo_stroke);
        scene.stroke_path(&stroke_path);
        self.backend.mark_dirty();
        Ok(())
    }

    fn make_kurbo_stroke(style: &StrokeStyle) -> Stroke {
        crate::stroke::make_kurbo_stroke(style)
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
            if let Some(hw_mode) = self.can_hw_blend_now(blend) {
                return self.with_hw_blend(hw_mode, |walk| {
                    walk.drop_shadow(
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
                    )
                });
            }
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
            if !self.isolate_area(dirty, true, None, false, false)? {
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
                    Open::Clip { active_on_scene, .. } => {
                        if active_on_scene {
                            self.backend.scene().pop_clip();
                        }
                    }
                    Open::Layer => self.backend.scene().pop_layer(),
                }
            }
            self.open = prev_open;
            if res.is_ok() {
                self.backend.pop_blended(blend, 1.0, &self.open)?;
            } else {
                self.backend.abort_isolated(&self.open);
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
                let stroke_limits = crate::limits::Limits {
                    frame_verbs: self.verbs_left,
                    ..self.store.limits
                };
                if !st.dashes.is_empty() {
                    let length = polygon_length(&combined);
                    crate::record::check_dashes(st, length, &stroke_limits)?;
                    let period: f64 = st.dashes.iter().map(|d| f64::from(*d)).sum();
                    self.spend((length / period * st.dashes.len() as f64).ceil() as usize)?;
                }
                let (stroke_path, s) = crate::stroke::prepare_dashed_stroke(&combined, st, &stroke_limits)?;
                let sd = self.scene_device(shifted_device);
                let scene = self.backend.scene();
                scene.reset_paint_transform();
                scene.set_paint(tint.into());
                scene.set_transform(sd);
                scene.set_stroke(s);
                scene.stroke_path(&stroke_path);
            } else {
                let sd = self.scene_device(shifted_device);
                let scene = self.backend.scene();
                scene.reset_paint_transform();
                scene.set_paint(tint.into());
                scene.set_transform(sd);
                scene.set_fill_rule(if even_odd { Fill::EvenOdd } else { Fill::NonZero });
                scene.fill_path(&combined);
            }
            self.backend.mark_dirty();
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
                self.backend.mark_dirty();
                return Ok(());
            }
        }

        // General reference Gaussian blur over the rasterised cast mask (with canonical caching).
        let margin_local = {
            let s = scale_of(device).max(1e-6);
            let pad = if self.backend.allow_unbounded_view_blur() {
                crate::shadow::blur_support_pad_view(sigma_dev)
            } else {
                crate::shadow::blur_support_pad(sigma_dev)
            };
            (f64::from(pad) + 2.0) / s
        };
        if let Some(st) = stroke_style {
            let verbs_before = self.verbs_left;
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
            let stroke = if !st.dashes.is_empty() && local_paths.iter().any(crate::stroke::needs_safe_dash) {
                let stroke_limits = crate::limits::Limits {
                    frame_verbs: verbs_before,
                    ..self.store.limits
                };
                for p in &mut local_paths {
                    *p = crate::stroke::dash_path_safely(p, st, &stroke_limits)?;
                }
                crate::stroke::make_kurbo_stroke_undashed(st)
            } else {
                Self::make_kurbo_stroke(st)
            };
            let cast = ShadowCast::Stroke {
                paths: &local_paths,
                transform: shifted_device,
                stroke,
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
        let mut glyph_bounds: Option<Rect> = None;
        for &pi in paths {
            if let Some(b) = self.shadow_glyph_bounds(r, pi, shifted_device) {
                glyph_bounds = Some(glyph_bounds.map_or(b, |other| other.union(b)));
            }
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
            raster_bounds: glyph_bounds.map_or(bbox, |b| b.union(bbox)),
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
            if let Some(hw_mode) = self.can_hw_blend_now(blend) {
                return self.with_hw_blend(hw_mode, |walk| {
                    walk.inner_shadow(r, shape, hole, even_odd, dx, dy, blur, shadow_color, 0, device, alpha)
                });
            }
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
            if !self.isolate_area(dirty, true, None, false, false)? {
                return Ok(());
            }
            let prev_open = std::mem::take(&mut self.open);
            let res = self.inner_shadow(r, shape, hole, even_odd, dx, dy, blur, shadow_color, 0, device, alpha);
            while let Some(o) = self.open.pop() {
                match o {
                    Open::Clip { active_on_scene, .. } => {
                        if active_on_scene {
                            self.backend.scene().pop_clip();
                        }
                    }
                    Open::Layer => self.backend.scene().pop_layer(),
                }
            }
            self.open = prev_open;
            if res.is_ok() {
                self.backend.pop_blended(blend, 1.0, &self.open)?;
            } else {
                self.backend.abort_isolated(&self.open);
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
            self.backend.mark_dirty();
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
            self.backend.mark_dirty();
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
                self.backend.mark_dirty();
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
            frame_clip: None,
            source: None,
            context_only: self.current_context,
            active_on_scene: true,
        });
        let open = self.open.clone();
        let hole_slice = [hole_dev];
        let cast = ShadowCast::Fill {
            paths: &hole_slice,
            even_odd,
            raster_bounds: self
                .shadow_glyph_bounds(r, hole_idx, shifted_device)
                .unwrap_or_else(|| hole_slice[0].bounding_box()),
        };
        let res = self
            .backend
            .draw_blurred_shadow(&cast, canonical.as_ref(), true, dirty, sigma_dev, tint, &open);
        self.open.pop();
        self.backend.scene().pop_clip();
        res
    }

    fn shadow_glyph_bounds(&self, r: &Record, path: u32, device: Affine) -> Option<Rect> {
        if !matches!(r.paths.get(path as usize), Some(PathEntry::Glyphs { .. })) {
            return None;
        }
        r.entry_bounds(path, &|g| self.store.glyphs.bounds(g))
            .map(|bounds| device.transform_rect_bbox(bounds))
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
        let mut drew_any = false;
        // An outline fill is one path, so glyphs that overlap (including across lines) aren't laid
        // over each other; masks are. Opaque, that's the same picture. See-through, a run whose
        // glyphs touch fills its outlines.
        let mut masks = c[3] * alpha >= 1.0 || glyphs_non_overlapping(self.store, s, glyphs);
        // The run's place on the device is the same for every glyph but its offset: whether masks
        // can be used at all, and their scale, are the run's.
        let [a, b, cc, d, _, _] = (device * Affine::new([s, 0.0, 0.0, -s, 0.0, 0.0])).as_coeffs();
        let axis_aligned = b.abs() <= 1e-9 * (a.abs() + d.abs()) && cc.abs() <= 1e-9 * (a.abs() + d.abs());
        if self.active_hw_blend != HwBlend::Normal && masks && axis_aligned {
            // Under fixed-function HW blending, decide mask-vs-outline from the entire glyph run
            // (independent of the current tile viewport). Otherwise a run mixing maskable and
            // oversize glyphs would render masks on one tile and outlines on the next, leaving a
            // seam at the tile edge.
            let max_side = self.glyph_mask_side as u32;
            for g in glyphs {
                let Some(glyph) = self.store.glyphs.get(g.glyph) else {
                    return Err(EngineError::unknown(format!("glyph {}", g.glyph)));
                };
                let Some(gb) = glyph.bounds else { continue };
                let m = device * Affine::new([s, 0.0, 0.0, -s, f64::from(g.x), f64::from(g.y)]);
                let [_, _, _, _, e, f] = m.as_coeffs();
                let small =
                    gb.width() * a.abs() <= self.glyph_mask_side && gb.height() * d.abs() <= self.glyph_mask_side;
                if !(small && e.abs() < 1.0e7 && f.abs() < 1.0e7) {
                    masks = false;
                    break;
                }
                let (ix, iy) = (e.floor(), f.floor());
                let mut px = ((e - ix) * PHASES).round();
                let mut py = ((f - iy) * PHASES).round();
                if px >= PHASES {
                    px = 0.0;
                }
                if py >= PHASES {
                    py = 0.0;
                }
                if !crate::masks::fits_bounds(gb, a, d, (px / PHASES, py / PHASES), max_side) {
                    masks = false;
                    break;
                }
            }
        }
        let (sx, sy) = ((a as f32).to_bits(), (d as f32).to_bits());
        // Masks placed, each at its device pixel, with the glyph it's of: laid into one image of
        // the run and drawn once (`masks::compose_run`), so a run's overlaps are covered once, as
        // one shape's are (Figma's text: `text-overlap` in the parity suites).
        let mut placed: Vec<(std::sync::Arc<vello_cpu::Pixmap>, i32, i32)> = Vec::new();
        let mut of: Vec<usize> = Vec::new();
        let whole = self.backend.whole_runs();
        // Keep the outline contours identical across CPU bands. Omitting an off-tile
        // contour can change strip coverage by one level elsewhere in the same run.
        let outline_viewport = if whole { self.full_viewport } else { self.viewport };
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
            let in_view = overlaps(m.transform_rect_bbox(gb), outline_viewport);
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
        // Under fixed-function HW blending, never split one glyph run into two overlapping draws
        // (`draw_run` + `outlines`); if any glyph fell back to outlines, render the entire run
        // as one unified outline fill.
        let use_masks_run = !placed.is_empty() && (self.active_hw_blend == HwBlend::Normal || outlines.is_empty());
        if !placed.is_empty() && (!use_masks_run || !self.draw_run(&placed, tint)) {
            // No room for the run's image (or mixed run under HW blend): fill glyphs as outlines.
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
            drew_any = true;
        }
        if drew_any {
            self.backend.mark_dirty();
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
        self.backend.mark_dirty();
        self.stats.glyphs_masked += placed.len() as u32;
        true
    }
}

/// Expands 2- and 3-stop gradient ramps with exact unpremultiplied linear midpoints, scaling each
/// stop's alpha by `alpha`.
///
/// Vello 0.4 sizes its gradient LUT from stop count (256 for 2 stops, 512 for 3, 1024 for 4+) and
/// truncates the LUT index; expanding to 4+ stops upgrades the LUT to 1024 entries while remaining
/// mathematically identical across the render backends.
pub(crate) fn expand_gradient_stops(stops: &[(f32, Rgba)], alpha: f32) -> Vec<(f32, Rgba)> {
    let mul_alpha = |c: Rgba| [c[0], c[1], c[2], (c[3] * alpha).clamp(0.0, 1.0)];
    if stops.len() >= 2 && stops.len() < 4 {
        let mut out = Vec::with_capacity(5);
        for pair in stops.windows(2) {
            let (t0, c0) = pair[0];
            let (t1, c1) = pair[1];
            out.push((t0, mul_alpha(c0)));
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
                out.push((tm, mul_alpha(cm)));
            }
        }
        if let Some(&(tl, cl)) = stops.last() {
            out.push((tl, mul_alpha(cl)));
        }
        out
    } else {
        stops.iter().map(|(offset, c)| (*offset, mul_alpha(*c))).collect()
    }
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

/// Resolves a `GlassOp`'s inscribed radius in local units, measuring once via `vello_cpu` and
/// caching in `op.measured_inradius` when `op.inradius == 0.0`.
pub fn resolve_inradius(
    resources: &mut vello_cpu::Resources,
    op: &GlassOp,
    paths: &[(BezPath, bool)],
    size: [f32; 2],
) -> f32 {
    if op.inradius > 0.0 {
        return op.inradius;
    }
    let cached = op.measured_inradius.get();
    if cached >= 0.0 {
        return cached;
    }
    let measured = glass::measure_inradius(resources, paths, size[0], size[1]);
    op.measured_inradius.set(measured);
    measured
}

/// Whether no two glyphs in a run have overlapping ink bounding boxes (including across lines).
/// Uses a zero-allocation stack buffer for short runs (`<= 16` glyphs) and an x-sweep
/// for longer translucent runs.
pub(crate) fn glyphs_non_overlapping(store: &Store, scale: f64, glyphs: &[crate::record::GlyphInstance]) -> bool {
    if glyphs.len() < 2 {
        return true;
    }
    const SMALL: usize = 16;
    if glyphs.len() <= SMALL {
        let mut boxes = [(0.0f64, 0.0f64, 0.0f64, 0.0f64); SMALL];
        let mut n = 0usize;
        for g in glyphs {
            let Some(b) = store.glyphs.bounds(g.glyph) else {
                continue;
            };
            let x0 = f64::from(g.x) + b.x0 * scale;
            let x1 = f64::from(g.x) + b.x1 * scale;
            let y0 = f64::from(g.y) - b.y1 * scale;
            let y1 = f64::from(g.y) - b.y0 * scale;
            for &(ax0, ay0, ax1, ay1) in &boxes[..n] {
                if x0 < ax1 && ax0 < x1 && y0 < ay1 && ay0 < y1 {
                    return false;
                }
            }
            boxes[n] = (x0, y0, x1, y1);
            n += 1;
        }
        return true;
    }
    let mut boxes: Vec<(f64, f64, f64, f64)> = Vec::with_capacity(glyphs.len());
    for g in glyphs {
        let Some(b) = store.glyphs.bounds(g.glyph) else {
            continue;
        };
        let x0 = f64::from(g.x) + b.x0 * scale;
        let x1 = f64::from(g.x) + b.x1 * scale;
        let y0 = f64::from(g.y) - b.y1 * scale;
        let y1 = f64::from(g.y) - b.y0 * scale;
        boxes.push((x0, y0, x1, y1));
    }
    if boxes.len() < 2 {
        return true;
    }
    boxes.sort_unstable_by(|a, b| a.0.total_cmp(&b.0));
    for i in 0..boxes.len() {
        let (_, ay0, ax1, ay1) = boxes[i];
        for &(bx0, by0, _, by1) in &boxes[i + 1..] {
            if bx0 >= ax1 {
                break;
            }
            if ay0 < by1 && by0 < ay1 {
                return false;
            }
        }
    }
    true
}

/// Normal blending, for the record of what the engine composites by itself.
pub fn normal() -> BlendMode {
    BlendMode::new(Mix::Normal, Compose::SrcOver)
}

#[cfg(test)]
mod resumable_tests {
    use super::*;
    use crate::cpu::Cpu;
    use crate::record::{PathEntry, Record};
    use crate::store::ROOT;
    use std::cell::Cell;

    /// Wraps `Cpu` and forces a cooperative yield on every probe check so we stress-test
    /// pause/resume across clips, nested frames, opacity layers, shadows, and readers.
    /// With `UNBOUNDED`, it also takes the GPU's reduced-grid layer blur path (case L2) past a
    /// tiny native limit, counting the reduced composites.
    struct AlwaysYieldCpu<const UNBOUNDED: bool> {
        inner: Cpu,
        probes: Cell<u32>,
        reduced_composites: u32,
        /// Stops the walk early once a scope is open, as a GPU edge-strip capture does when it
        /// meets its reader inside one.
        stop_in_scope: bool,
        stopping: bool,
        /// Draws a rough stand-in (`Backend::rough`).
        rough: bool,
    }

    impl<const UNBOUNDED: bool> Backend for AlwaysYieldCpu<UNBOUNDED> {
        fn allow_unbounded_view_blur(&self) -> bool {
            UNBOUNDED
        }
        fn reduced_layer_blur_limits(&self) -> ReducedBlurLimits {
            ReducedBlurLimits {
                replay_side: crate::halo::HALO_REPLAY_SIDE,
                native_side: if UNBOUNDED { 16 } else { 8192 },
                native_pixels: if UNBOUNDED { 256 } else { usize::MAX },
            }
        }
        fn composite_reduced_post(
            &mut self,
            _source: ReducedPost<'_>,
            _upsample_area: IRect,
            _tail_steps: &[PostStep],
            _isolation: Isolation,
            _blend: u32,
            _opacity: f32,
            open: &[Open],
        ) -> Result<()> {
            self.reduced_composites += 1;
            self.inner.abort_isolated(open);
            Ok(())
        }
        fn scene(&mut self) -> &mut dyn Draw {
            self.inner.scene()
        }
        fn mark_dirty(&mut self) {
            self.inner.mark_dirty();
        }
        fn flush_barrier(&mut self, open: &[Open]) {
            self.inner.flush_barrier(open);
        }
        fn scene_offset(&self) -> (i32, i32) {
            self.inner.scene_offset()
        }
        fn target_bounds(&self) -> IRect {
            self.inner.target_bounds()
        }
        fn image(&mut self, id: u32, span: (f64, f64)) -> Option<ImageView> {
            self.inner.image(id, span)
        }
        fn checker(&mut self) -> ImageSource {
            self.inner.checker()
        }
        fn glyph_mask(
            &mut self,
            key: MaskKey,
            path: &BezPath,
            scale: (f64, f64),
            phase: (f64, f64),
        ) -> Option<GlyphMask> {
            self.inner.glyph_mask(key, path, scale, phase)
        }
        fn run_image(&mut self, w: u16, h: u16, pixels: Vec<u8>) -> Option<ImageSource> {
            self.inner.run_image(w, h, pixels)
        }
        fn whole_runs(&self) -> bool {
            self.inner.whole_runs()
        }
        fn diamond_gradient(
            &mut self,
            area: IRect,
            device_to_grad: Affine,
            stops: &[(f32, Rgba)],
            alpha: f32,
        ) -> Result<Option<ImageSource>> {
            self.inner.diamond_gradient(area, device_to_grad, stops, alpha)
        }
        fn begin_readers(&mut self, needs_backdrop: bool, has_context: bool) -> Result<()> {
            self.inner.begin_readers(needs_backdrop, has_context)
        }
        fn snapshot_backdrop(&mut self, open: &[Open]) -> Result<()> {
            self.inner.snapshot_backdrop(open)
        }
        fn stop_early(&self) -> bool {
            self.stopping || self.inner.stop_early()
        }
        fn deadline_reached(&self) -> bool {
            self.probes.set(self.probes.get() + 1);
            true
        }
        fn rough(&self) -> bool {
            self.rough
        }
        fn set_targets(&mut self, write_main: bool, write_backdrop: bool, open: &[Open]) -> Result<()> {
            self.inner.set_targets(write_main, write_backdrop, open)
        }
        fn read(&mut self, kernel: u32, paints: IRect, reads: IRect, open: &[Open]) -> Result<()> {
            self.inner.read(kernel, paints, reads, open)
        }
        fn glass(
            &mut self,
            key: (u32, usize),
            op: &GlassOp,
            paths: &[(BezPath, bool)],
            device: Affine,
            size: [f32; 2],
            alpha: f32,
            coarse: bool,
            read_parent: bool,
            open: &[Open],
        ) -> Result<()> {
            self.inner
                .glass(key, op, paths, device, size, alpha, coarse, read_parent, open)
        }
        fn background_blur(
            &mut self,
            key: Option<(u32, usize)>,
            op: &BackgroundBlurOp,
            paths: &[(BezPath, bool)],
            device: Affine,
            size: [f32; 2],
            alpha: f32,
            coarse: bool,
            open: &[Open],
        ) -> Result<()> {
            self.inner
                .background_blur(key, op, paths, device, size, alpha, coarse, open)
        }
        fn progressive_blur(
            &mut self,
            key: (u32, usize),
            op: &ProgressiveBlurOp,
            paths: &[(BezPath, bool)],
            device: Affine,
            size: [f32; 2],
            alpha: f32,
            coarse: bool,
            open: &[Open],
        ) -> Result<()> {
            self.inner
                .progressive_blur(key, op, paths, device, size, alpha, coarse, open)
        }
        fn push_isolated(
            &mut self,
            area: IRect,
            clip_to_parent: bool,
            scene_origin_hint: Option<(i32, i32)>,
            isolation: Isolation,
            open: &[Open],
        ) -> Result<bool> {
            let pushed = self
                .inner
                .push_isolated(area, clip_to_parent, scene_origin_hint, isolation, open)?;
            self.stopping |= self.stop_in_scope && pushed;
            Ok(pushed)
        }
        fn apply_post_isolated(&mut self, steps: &[PostStep]) -> Result<()> {
            self.inner.apply_post_isolated(steps)
        }
        fn pop_isolated(&mut self, opacity: f32, open: &[Open]) -> Result<()> {
            self.inner.pop_isolated(opacity, open)
        }
        fn pop_composited(&mut self, blend: u32, opacity: f32, mask_kind: Option<u32>, open: &[Open]) -> Result<()> {
            self.inner.pop_composited(blend, opacity, mask_kind, open)
        }
        fn abort_isolated(&mut self, open: &[Open]) {
            self.inner.abort_isolated(open);
        }
        fn draw_blurred_shadow(
            &mut self,
            cast: &ShadowCast<'_>,
            canonical: Option<&crate::shadow::CanonicalShadow>,
            invert: bool,
            dirty: IRect,
            sigma: f32,
            color: AlphaColor<Srgb>,
            open: &[Open],
        ) -> Result<()> {
            self.inner
                .draw_blurred_shadow(cast, canonical, invert, dirty, sigma, color, open)
        }
    }

    fn rect_path(w: f32, h: f32) -> PathEntry {
        use vello_common::kurbo::Shape;
        let p = Rect::new(0.0, 0.0, f64::from(w), f64::from(h)).into_path(0.1);
        PathEntry::Path(crate::record::CompactPath::from_bez(&p))
    }

    /// A walk that stops early inside an isolated scope (a GPU edge-strip capture meeting its
    /// reader there) aborts the scope: the frame's clip opened round it must stay on the scene,
    /// so closing it pops a clip that is there.
    #[test]
    fn a_scope_stopped_early_under_a_clip_keeps_the_clip_on_the_scene() {
        let limits = Limits::default();
        let mut store = Store::new(limits);
        let mut frame_rec = Record::empty();
        frame_rec.size = [64.0, 64.0];
        frame_rec.paths.push(rect_path(64.0, 64.0));
        frame_rec.ops = vec![
            Op::Clip {
                path: 0,
                even_odd: false,
            },
            Op::Children,
            Op::Unclip,
        ];
        store.insert_for_test(1, ROOT, frame_rec);
        let mut member = Record::empty();
        member.size = [32.0, 32.0];
        member.blend = 1;
        member.paths.push(rect_path(32.0, 32.0));
        member.ops = vec![Op::Fill {
            path: 0,
            even_odd: false,
            paint: Paint::Solid([0.2, 0.4, 0.8, 1.0]),
            blend: 0,
        }];
        store.insert_for_test(2, 1, member);
        let area = IRect {
            x0: 0,
            y0: 0,
            x1: 64,
            y1: 64,
        };
        let frame = Frame {
            width: 64,
            height: 64,
            view: Affine::IDENTITY,
            detail: false,
            area,
        };
        let mut cpu = AlwaysYieldCpu::<false> {
            inner: Cpu::new(limits.glyph_mask_bytes, limits.glyph_mask_side, 0),
            probes: Cell::new(0),
            reduced_composites: 0,
            stop_in_scope: true,
            stopping: false,
            rough: false,
        };
        cpu.inner.begin(64, 64, area, [255, 255, 255, 255]);
        let mut budget = limits.frame_verbs;
        draw_split(&store, &mut cpu, &frame, &limits, &mut budget, &Split::all(), false)
            .expect("the walk stops early and closes the frame's clip");
        assert!(cpu.stopping, "the member was drawn in a scope");
    }

    #[test]
    fn resumable_walk_matches_unsplit_bitwise() {
        let limits = Limits::default();
        let mut store = Store::new(limits);
        // Build a nested hierarchy with clipping frame, 40 child shapes (crossing the 16-record
        // yield probe multiple times), a drop shadow, a background blur, and trailing foreground
        // stroke after `Op::Children`.
        let mut frame_rec = Record::empty();
        frame_rec.transform = Affine::translate((12.0, 12.0));
        frame_rec.size = [104.0, 104.0];
        frame_rec.paths.push(rect_path(104.0, 104.0));
        frame_rec.ops = vec![
            Op::Fill {
                path: 0,
                even_odd: false,
                paint: Paint::Solid([0.9, 0.92, 0.96, 1.0]),
                blend: 0,
            },
            Op::Clip {
                path: 0,
                even_odd: false,
            },
            Op::Children,
            Op::Unclip,
            Op::Stroke {
                path: 0,
                style: Box::new(StrokeStyle {
                    width: 2.0,
                    cap: 0,
                    join: 0,
                    miter: 4.0,
                    dashes: Vec::new(),
                    dash_offset: 0.0,
                }),
                paint: Paint::Solid([0.1, 0.2, 0.4, 1.0]),
                blend: 0,
                cache: crate::stroke::StrokeCache::default(),
            },
        ];
        store.insert_for_test(1, ROOT, frame_rec);
        for i in 0..40u32 {
            let id = 10 + i;
            let mut r = Record::empty();
            r.transform = Affine::translate(((i % 8) as f64 * 12.0 + 4.0, (i / 8) as f64 * 18.0 + 4.0));
            r.size = [14.0, 14.0];
            r.paths.push(rect_path(14.0, 14.0));
            if i == 10 {
                r.ops.push(Op::DropShadow {
                    paths: vec![0],
                    even_odd: false,
                    dx: 2.0,
                    dy: 3.0,
                    blur: 4.0,
                    color: [0.0, 0.0, 0.0, 0.35],
                    blend: 0,
                    stroke: None,
                });
            }
            if i == 25 {
                r.ops.push(Op::BackgroundBlur(Box::new(BackgroundBlurOp {
                    paths: vec![0],
                    even_odd: false,
                    radius: 4.0,
                })));
            }
            r.ops.push(Op::Fill {
                path: 0,
                even_odd: false,
                paint: Paint::Solid([(i % 5) as f32 * 0.2, ((i / 5) % 5) as f32 * 0.2, 0.65, 0.85]),
                blend: 0,
            });
            store.insert_for_test(id, 1, r);
        }

        let frame = Frame {
            width: 128,
            height: 128,
            view: Affine::IDENTITY,
            detail: false,
            area: IRect {
                x0: 0,
                y0: 0,
                x1: 128,
                y1: 128,
            },
        };
        let bg = [255u8, 255, 255, 255];

        // 1. Reference unsplit render.
        let mut ref_cpu = Cpu::new(limits.glyph_mask_bytes, limits.glyph_mask_side, 0);
        ref_cpu.begin(128, 128, frame.area, bg);
        let mut ref_budget = limits.frame_verbs;
        let mut ref_stats = DrawStats::default();
        let s = draw_split(
            &store,
            &mut ref_cpu,
            &frame,
            &limits,
            &mut ref_budget,
            &Split::all(),
            false,
        )
        .expect("reference render");
        ref_stats.add(&s);
        ref_cpu.flush_slice_for_test();
        let ref_px = ref_cpu.target.data_as_u8_slice().to_vec();

        // 2. Resumable render pausing/resuming across the same scene: must be 100% bitwise identical.
        let mut ycpu_same = AlwaysYieldCpu::<false> {
            inner: Cpu::new(limits.glyph_mask_bytes, limits.glyph_mask_side, 0),
            probes: Cell::new(0),
            reduced_composites: 0,
            stop_in_scope: false,
            stopping: false,
            rough: false,
        };
        ycpu_same.inner.begin(128, 128, frame.area, bg);
        let mut budget_same = limits.frame_verbs;
        let mut checkpoint = None;
        let mut slices_same = 0u32;
        let mut out_stats = DrawStats::default();
        loop {
            slices_same += 1;
            match draw_split_resumable(
                &store,
                &mut ycpu_same,
                &frame,
                &limits,
                &mut budget_same,
                &Split::all(),
                false,
                checkpoint.take(),
                true,
            )
            .expect("resumable slice")
            {
                WalkOutcome::Complete { stats, .. } => {
                    out_stats.add(&stats);
                    ycpu_same.inner.flush_slice_for_test();
                    break;
                }
                WalkOutcome::Paused { stats, checkpoint: cp } => {
                    out_stats.add(&stats);
                    checkpoint = Some(cp);
                }
            }
            assert!(slices_same < 100, "resumable walk failed to terminate");
        }
        assert!(
            slices_same >= 3,
            "expected multiple cooperative slices, got {slices_same}"
        );
        assert_eq!(
            ref_stats.records, out_stats.records,
            "record count mismatch across {slices_same} slices"
        );
        assert_eq!(
            ref_stats.ops, out_stats.ops,
            "op count mismatch across {slices_same} slices"
        );
        assert_eq!(
            ref_px,
            ycpu_same.inner.target.data_as_u8_slice(),
            "same-scene resumable walk differed from unsplit render"
        );

        // 3. Resumable render flushing between slices (simulating GPU per-slice submit):
        // under vello_cpu's f32_pipeline, flushing between overlapping translucent shapes adds at
        // most 1/255 quantization rounding; clip replay and reader sequencing stay exact.
        let mut ycpu = AlwaysYieldCpu::<false> {
            inner: Cpu::new(limits.glyph_mask_bytes, limits.glyph_mask_side, 0),
            probes: Cell::new(0),
            reduced_composites: 0,
            stop_in_scope: false,
            stopping: false,
            rough: false,
        };
        ycpu.inner.begin(128, 128, frame.area, bg);
        let mut budget = limits.frame_verbs;
        let mut checkpoint = None;
        let mut slices = 0u32;
        loop {
            slices += 1;
            match draw_split_resumable(
                &store,
                &mut ycpu,
                &frame,
                &limits,
                &mut budget,
                &Split::all(),
                false,
                checkpoint.take(),
                true,
            )
            .expect("resumable slice")
            {
                WalkOutcome::Complete { .. } => {
                    ycpu.inner.flush_slice_for_test();
                    break;
                }
                WalkOutcome::Paused { checkpoint: cp, .. } => {
                    ycpu.inner.flush_slice_for_test();
                    checkpoint = Some(cp);
                }
            }
            assert!(slices < 100, "resumable walk failed to terminate");
        }
        assert!(slices >= 3, "expected multiple cooperative slices, got {slices}");
        let out_px = ycpu.inner.target.data_as_u8_slice().to_vec();
        let max_diff = ref_px
            .iter()
            .zip(&out_px)
            .map(|(a, b)| a.abs_diff(*b))
            .max()
            .unwrap_or(0);
        assert!(
            max_diff <= 1,
            "flushed resumable walk exceeded 1/255 rounding tolerance: slices={slices} max_diff={max_diff}"
        );
    }

    /// A rough stand-in (an overview tile) draws each layer's content plainly: no shadows,
    /// readers, layer blurs or blend modes, nothing under `ROUGH_SPECK`, and it yields as
    /// usual. It is the same picture as the page without those, and never exact.
    #[test]
    fn a_rough_walk_draws_content_plainly_and_is_never_exact() {
        let limits = Limits::default();
        let page = |effects: bool| {
            let mut store = Store::new(limits);
            let mut frame_rec = Record::empty();
            frame_rec.size = [128.0, 128.0];
            frame_rec.paths.push(rect_path(128.0, 128.0));
            frame_rec.ops = vec![
                Op::Fill {
                    path: 0,
                    even_odd: false,
                    paint: Paint::Solid([0.9, 0.92, 0.96, 1.0]),
                    blend: 0,
                },
                Op::Children,
            ];
            store.insert_for_test(1, ROOT, frame_rec);
            for i in 0..40u32 {
                let mut r = Record::empty();
                r.transform = Affine::translate(((i % 8) as f64 * 14.0 + 4.0, (i / 8) as f64 * 20.0 + 4.0));
                r.size = [12.0, 12.0];
                r.paths.push(rect_path(12.0, 12.0));
                if effects && i == 3 {
                    r.ops.push(Op::DropShadow {
                        paths: vec![0],
                        even_odd: false,
                        dx: 2.0,
                        dy: 3.0,
                        blur: 4.0,
                        color: [0.0, 0.0, 0.0, 0.35],
                        blend: 0,
                        stroke: None,
                    });
                }
                if effects && i == 12 {
                    r.ops.push(Op::BackgroundBlur(Box::new(BackgroundBlurOp {
                        paths: vec![0],
                        even_odd: false,
                        radius: 4.0,
                    })));
                }
                if effects && i == 20 {
                    r.blend = 1;
                }
                if effects && i == 28 {
                    r.post_effects = vec![PostEffect::LayerBlur { radius: 6.0 }];
                }
                r.ops.push(Op::Fill {
                    path: 0,
                    even_odd: false,
                    paint: Paint::Solid([(i % 5) as f32 * 0.2, ((i / 5) % 5) as f32 * 0.2, 0.65, 0.85]),
                    blend: if effects && i == 33 { 2 } else { 0 },
                });
                store.insert_for_test(10 + i, 1, r);
            }
            if effects {
                // Under a device pixel each way, over half of one: left out of a rough walk only.
                let mut speck = Record::empty();
                speck.transform = Affine::translate((120.0, 120.0));
                speck.size = [0.8, 0.8];
                speck.paths.push(rect_path(0.8, 0.8));
                speck.ops = vec![Op::Fill {
                    path: 0,
                    even_odd: false,
                    paint: Paint::Solid([0.0, 0.0, 0.0, 1.0]),
                    blend: 0,
                }];
                store.insert_for_test(90, 1, speck);
            }
            store
        };
        let frame = Frame {
            width: 128,
            height: 128,
            view: Affine::IDENTITY,
            detail: false,
            area: IRect {
                x0: 0,
                y0: 0,
                x1: 128,
                y1: 128,
            },
        };
        let bg = [255u8, 255, 255, 255];

        let plain = page(false);
        let mut ref_cpu = Cpu::new(limits.glyph_mask_bytes, limits.glyph_mask_side, 0);
        ref_cpu.begin(128, 128, frame.area, bg);
        let mut ref_budget = limits.frame_verbs;
        let s = draw_split(
            &plain,
            &mut ref_cpu,
            &frame,
            &limits,
            &mut ref_budget,
            &Split::all(),
            false,
        )
        .expect("plain page");
        assert!(s.exact(), "the plain page is drawn exactly");
        ref_cpu.flush_slice_for_test();
        let ref_px = ref_cpu.target.data_as_u8_slice().to_vec();

        let rich = page(true);
        let mut rough = AlwaysYieldCpu::<false> {
            inner: Cpu::new(limits.glyph_mask_bytes, limits.glyph_mask_side, 0),
            probes: Cell::new(0),
            reduced_composites: 0,
            stop_in_scope: false,
            stopping: false,
            rough: true,
        };
        rough.inner.begin(128, 128, frame.area, bg);
        let mut budget = limits.frame_verbs;
        let mut checkpoint = None;
        let mut slices = 0u32;
        let total = loop {
            slices += 1;
            match draw_split_resumable(
                &rich,
                &mut rough,
                &frame,
                &limits,
                &mut budget,
                &Split::all(),
                true,
                checkpoint.take(),
                true,
            )
            .expect("rough slice")
            {
                WalkOutcome::Complete { total, .. } => {
                    rough.inner.flush_slice_for_test();
                    break total;
                }
                WalkOutcome::Paused { checkpoint: cp, .. } => checkpoint = Some(cp),
            }
            assert!(slices < 100, "rough walk failed to terminate");
        };
        assert!(slices >= 3, "a rough walk yields as usual, got {slices} slices");
        assert!(!total.exact(), "a rough stand-in is never exact: {total:?}");
        assert_eq!(total.reads, 0, "a rough stand-in reads nothing");
        assert_eq!(total.specks, 1, "the speck under a device pixel is left out");
        assert_eq!(
            ref_px,
            rough.inner.target.data_as_u8_slice(),
            "a rough walk draws the page as if it had no effects, blends or specks"
        );
    }

    /// A layer blur past the native limits (case L2) blurs its whole subtree on a reduced grid
    /// and composites it once. A walk that yields at every chance must not pause inside it.
    #[test]
    fn resumable_walk_never_pauses_inside_a_reduced_layer_blur() {
        let limits = Limits::default();
        let mut store = Store::new(limits);
        let mut before = Record::empty();
        before.size = [128.0, 128.0];
        before.paths.push(rect_path(128.0, 128.0));
        before.ops = vec![Op::Fill {
            path: 0,
            even_odd: false,
            paint: Paint::Solid([1.0, 1.0, 1.0, 1.0]),
            blend: 0,
        }];
        store.insert_for_test(1, ROOT, before);
        let mut scope = Record::empty();
        scope.transform = Affine::translate((8.0, 8.0));
        scope.size = [112.0, 112.0];
        scope.paths.push(rect_path(112.0, 112.0));
        scope.ops = vec![Op::Children];
        scope.post_effects = vec![PostEffect::LayerBlur { radius: 40.0 }];
        store.insert_for_test(2, ROOT, scope);
        // 48 children cross the 16-record yield probe several times inside the scope.
        for i in 0..48u32 {
            let mut r = Record::empty();
            r.transform = Affine::translate(((i % 8) as f64 * 14.0, (i / 8) as f64 * 14.0));
            r.size = [14.0, 14.0];
            r.paths.push(rect_path(14.0, 14.0));
            r.ops = vec![Op::Fill {
                path: 0,
                even_odd: false,
                paint: Paint::Solid([(i % 4) as f32 * 0.25, 0.4, 0.8, 1.0]),
                blend: 0,
            }];
            store.insert_for_test(100 + i, 2, r);
        }
        for i in 0..20u32 {
            let mut r = Record::empty();
            r.transform = Affine::translate((f64::from(i) * 6.0, 120.0));
            r.size = [4.0, 4.0];
            r.paths.push(rect_path(4.0, 4.0));
            r.ops = vec![Op::Fill {
                path: 0,
                even_odd: false,
                paint: Paint::Solid([0.0, 0.0, 0.0, 1.0]),
                blend: 0,
            }];
            store.insert_for_test(200 + i, ROOT, r);
        }
        let area = IRect {
            x0: 0,
            y0: 0,
            x1: 128,
            y1: 128,
        };
        let frame = Frame {
            width: 128,
            height: 128,
            view: Affine::IDENTITY,
            detail: false,
            area,
        };
        let mut ycpu = AlwaysYieldCpu::<true> {
            inner: Cpu::new(limits.glyph_mask_bytes, limits.glyph_mask_side, 0),
            probes: Cell::new(0),
            reduced_composites: 0,
            stop_in_scope: false,
            stopping: false,
            rough: false,
        };
        ycpu.inner.begin(128, 128, area, [255, 255, 255, 255]);
        let mut budget = limits.frame_verbs;
        let mut checkpoint = None;
        let mut slices = 0u32;
        let total = loop {
            slices += 1;
            match draw_split_resumable(
                &store,
                &mut ycpu,
                &frame,
                &limits,
                &mut budget,
                &Split::all(),
                false,
                checkpoint.take(),
                true,
            )
            .expect("resumable slice")
            {
                WalkOutcome::Complete { total, .. } => break total,
                WalkOutcome::Paused { checkpoint: cp, .. } => checkpoint = Some(cp),
            }
            assert!(slices < 100, "resumable walk failed to terminate");
        };
        assert!(
            slices >= 2,
            "expected the walk to yield outside the scope, got {slices} slices"
        );
        assert_eq!(
            ycpu.reduced_composites, 1,
            "the reduced layer blur was split across {slices} slices"
        );
        assert_eq!(total.reduced, 1);
        assert!(!total.exact());
    }
}

#[cfg(test)]
mod reduced_layer_blur_tests {
    use super::*;

    fn blur_sigmas(posts: &[ActivePost]) -> Vec<f64> {
        posts
            .iter()
            .filter_map(|p| match *p {
                ActivePost::LayerBlur { sigma } => Some(f64::from(sigma)),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn grid_variance_is_compensated_once_across_a_layer_blur_chain() {
        let grid_var = f64::from(crate::halo::HALO_GRID_VARIANCE);
        // Two wide blurs: the chain's total variance on the grid is the device variance over
        // d^2 less the grid's own, and only the last blur gives any up.
        let d = 64;
        let chain = [
            ActivePost::LayerBlur { sigma: 3000.0 },
            ActivePost::LayerBlur { sigma: 2700.0 },
        ];
        let got = blur_sigmas(&posts_on_grid(&chain, d, Affine::IDENTITY));
        let device: f64 = 3000.0f64.powi(2) + 2700.0f64.powi(2);
        let total: f64 = got.iter().map(|s| s * s).sum();
        assert!((total - (device / f64::from(d * d) - grid_var)).abs() < 1e-3, "{got:?}");
        assert!((got[0] - 3000.0 / f64::from(d)).abs() < 1e-4, "{got:?}");
        // A last blur narrower than the grid's variance: the rest comes off the one before.
        let chain = [
            ActivePost::LayerBlur { sigma: 3000.0 },
            ActivePost::LayerBlur { sigma: 16.0 },
        ];
        let got = blur_sigmas(&posts_on_grid(&chain, d, Affine::IDENTITY));
        let device: f64 = 3000.0f64.powi(2) + 16.0f64.powi(2);
        let total: f64 = got.iter().map(|s| s * s).sum();
        assert_eq!(got[1], 0.0, "{got:?}");
        assert!((total - (device / f64::from(d * d) - grid_var)).abs() < 1e-3, "{got:?}");
        // At device resolution nothing is compensated.
        let got = blur_sigmas(&posts_on_grid(&chain, 1, Affine::IDENTITY));
        assert_eq!(got, vec![3000.0, 16.0]);
    }

    #[test]
    fn reduced_grid_flags_a_texture_cap_past_a_third_of_sigma() {
        let view = Affine::IDENTITY;
        // 40,000 px of source under sigma 2,700: the replay side picks the grid, well inside a
        // third of sigma, and the texture holds it.
        let src = IRect {
            x0: -20_000,
            y0: -20_000,
            x1: 20_000,
            y1: 20_000,
        };
        let g = reduced_layer_blur_grid(src, 2700.0, 1024, 8192, view);
        assert_eq!(g.divisor, 64);
        assert!(g.size.0 <= 8192 && g.size.1 <= 8192);
        assert!(!g.past_cutover);
        // The same source with a 16-texel cap: the divisor doubles past sigma / 3 and says so.
        let g = reduced_layer_blur_grid(src, 2700.0, 1024, 16, view);
        assert!(g.size.0 <= 16 && g.size.1 <= 16);
        assert!(g.divisor as f32 * crate::halo::HALO_MIN_COARSE_SIGMA > 2700.0);
        assert!(g.past_cutover);
        // A narrow blur is capped at the largest power of two within a third of its sigma.
        let g = reduced_layer_blur_grid(src, 100.0, 1024, 1 << 16, view);
        assert_eq!(g.divisor, 32);
        assert!(!g.past_cutover);
        // The grid covers the source on the view's phase.
        let g = reduced_layer_blur_grid(src, 2700.0, 1024, 8192, Affine::translate((3.0, 5.0)));
        assert!(g.origin.0 <= src.x0 && g.origin.1 <= src.y0);
        assert!(g.origin.0 + g.size.0 as i32 * g.divisor >= src.x1);
        assert!(g.origin.1 + g.size.1 as i32 * g.divisor >= src.y1);
    }
}

#[cfg(test)]
mod hw_blend_gate_tests {
    use super::*;
    use crate::cpu::Cpu;
    use crate::record::{
        BackgroundBlurOp, CompactPath, ComposeMode, GlyphInstance, MASK_ALPHA, PathEntry, Record, StrokeStyle,
    };
    use crate::store::ROOT;

    /// Recording `Draw` wrapper that logs every `HwBlend` transition and draw call's active mode.
    struct SpyScene {
        inner: vello_cpu::RenderContext,
        current: HwBlend,
        draw_modes: Vec<HwBlend>,
    }

    impl Draw for SpyScene {
        fn set_transform(&mut self, t: Affine) {
            self.inner.set_transform(t);
        }
        fn set_paint(&mut self, p: PaintType) {
            self.inner.set_paint(p);
        }
        fn set_paint_transform(&mut self, t: Affine) {
            self.inner.set_paint_transform(t);
        }
        fn reset_paint_transform(&mut self) {
            self.inner.reset_paint_transform();
        }
        fn set_tint(&mut self, t: Option<Tint>) {
            self.inner.set_tint(t);
        }
        fn set_fill_rule(&mut self, rule: Fill) {
            self.inner.set_fill_rule(rule);
        }
        fn set_stroke(&mut self, s: Stroke) {
            self.inner.set_stroke(s);
        }
        fn set_hw_blend(&mut self, mode: HwBlend) {
            self.current = mode;
        }
        fn fill_path(&mut self, p: &BezPath) {
            self.draw_modes.push(self.current);
            self.inner.fill_path(p);
        }
        fn fill_rect(&mut self, r: &Rect) {
            self.draw_modes.push(self.current);
            self.inner.fill_rect(r);
        }
        fn fill_blurred_rounded_rect_in(&mut self, p: &BezPath, r: &Rect, radius: f32, std_dev: f32, invert: bool) {
            self.draw_modes.push(self.current);
            self.inner.fill_blurred_rounded_rect_in(p, r, radius, std_dev, invert);
        }
        fn stroke_path(&mut self, p: &BezPath) {
            self.draw_modes.push(self.current);
            self.inner.stroke_path(p);
        }
        fn push_clip_path(&mut self, p: &BezPath) {
            self.inner.push_clip_path(p);
        }
        fn pop_clip(&mut self) {
            self.inner.pop_clip();
        }
        fn push_opacity(&mut self, opacity: f32) {
            self.inner.push_opacity(opacity);
        }
        fn push_layer(&mut self, compose: Compose, opacity: Option<f32>) {
            Draw::push_layer(&mut self.inner, compose, opacity);
        }
        fn pop_layer(&mut self) {
            self.inner.pop_layer();
        }
    }

    struct SpyBackend {
        scene: SpyScene,
        area: IRect,
        opaque_target: bool,
        scopes_pushed: u32,
        dirty_marks: u32,
        destructive_root_calls: u32,
        mask_support: Option<(
            crate::masks::Rasterizer,
            crate::masks::MaskCache<std::sync::Arc<vello_cpu::Pixmap>>,
        )>,
    }

    impl SpyBackend {
        fn new(w: u16, h: u16, opaque_target: bool) -> Self {
            Self {
                scene: SpyScene {
                    inner: vello_cpu::RenderContext::new(w, h),
                    current: HwBlend::Normal,
                    draw_modes: Vec::new(),
                },
                area: IRect {
                    x0: 0,
                    y0: 0,
                    x1: i32::from(w),
                    y1: i32::from(h),
                },
                opaque_target,
                scopes_pushed: 0,
                dirty_marks: 0,
                destructive_root_calls: 0,
                mask_support: None,
            }
        }
    }

    impl Backend for SpyBackend {
        fn scene(&mut self) -> &mut dyn Draw {
            &mut self.scene
        }
        fn mark_dirty(&mut self) {
            self.dirty_marks += 1;
        }
        fn can_hw_blend(&self) -> bool {
            self.opaque_target
        }
        fn before_destructive_root_layer(&mut self, _open: &[Open]) -> Result<()> {
            self.destructive_root_calls += 1;
            self.opaque_target = false;
            Ok(())
        }
        fn scene_offset(&self) -> (i32, i32) {
            (0, 0)
        }
        fn target_bounds(&self) -> IRect {
            self.area
        }
        fn image(&mut self, _id: u32, _span: (f64, f64)) -> Option<ImageView> {
            None
        }
        fn checker(&mut self) -> ImageSource {
            unimplemented!()
        }
        fn glyph_mask(&mut self, key: MaskKey, path: &BezPath, s: (f64, f64), p: (f64, f64)) -> Option<GlyphMask> {
            let (raster, cache) = self.mask_support.as_mut()?;
            crate::masks::coverage(cache, raster, key, path, s, p, 160)
        }
        fn run_image(&mut self, w: u16, h: u16, pixels: Vec<u8>) -> Option<ImageSource> {
            self.mask_support.as_ref()?;
            let data = vello_common::peniko::ImageData {
                data: pixels.into(),
                format: vello_common::peniko::ImageFormat::Rgba8,
                alpha_type: vello_common::peniko::ImageAlphaType::AlphaPremultiplied,
                width: u32::from(w),
                height: u32::from(h),
            };
            Some(ImageSource::from_peniko_image_data(&data))
        }
        fn whole_runs(&self) -> bool {
            false
        }
        fn diamond_gradient(&mut self, _: IRect, _: Affine, _: &[(f32, Rgba)], _: f32) -> Result<Option<ImageSource>> {
            Ok(None)
        }
        fn read(&mut self, _: u32, _: IRect, _: IRect, _: &[Open]) -> Result<()> {
            Ok(())
        }
        fn glass(
            &mut self,
            _: (u32, usize),
            _: &GlassOp,
            _: &[(BezPath, bool)],
            _: Affine,
            _: [f32; 2],
            _: f32,
            _: bool,
            _: bool,
            _: &[Open],
        ) -> Result<()> {
            Ok(())
        }
        fn background_blur(
            &mut self,
            _: Option<(u32, usize)>,
            _: &BackgroundBlurOp,
            _: &[(BezPath, bool)],
            _: Affine,
            _: [f32; 2],
            _: f32,
            _: bool,
            _: &[Open],
        ) -> Result<()> {
            Ok(())
        }
        fn progressive_blur(
            &mut self,
            _: (u32, usize),
            _: &ProgressiveBlurOp,
            _: &[(BezPath, bool)],
            _: Affine,
            _: [f32; 2],
            _: f32,
            _: bool,
            _: &[Open],
        ) -> Result<()> {
            Ok(())
        }
        fn push_isolated(
            &mut self,
            area: IRect,
            _: bool,
            _: Option<(i32, i32)>,
            _: Isolation,
            _: &[Open],
        ) -> Result<bool> {
            if area.is_empty() {
                return Ok(false);
            }
            self.scopes_pushed += 1;
            Ok(true)
        }
        fn apply_post_isolated(&mut self, _: &[PostStep]) -> Result<()> {
            Ok(())
        }
        fn pop_isolated(&mut self, _: f32, _: &[Open]) -> Result<()> {
            Ok(())
        }
        fn pop_composited(&mut self, _: u32, _: f32, _: Option<u32>, _: &[Open]) -> Result<()> {
            Ok(())
        }
        fn abort_isolated(&mut self, _: &[Open]) {}
        fn draw_blurred_shadow(
            &mut self,
            _: &ShadowCast<'_>,
            _: Option<&crate::shadow::CanonicalShadow>,
            _: bool,
            _: IRect,
            _: f32,
            _: AlphaColor<Srgb>,
            _: &[Open],
        ) -> Result<()> {
            self.scene.draw_modes.push(self.scene.current);
            self.dirty_marks += 1;
            Ok(())
        }
    }

    fn rect_entry(w: f32, h: f32) -> PathEntry {
        PathEntry::Rect {
            w,
            h,
            radii: [0.0; 4],
            smoothing: 0.0,
        }
    }

    fn solid_leaf(x: f64, y: f64, w: f32, h: f32, layer_blend: u32, fill_blend: u8) -> Record {
        let mut r = Record::empty();
        r.flags = 0;
        r.transform = Affine::translate((x, y));
        r.size = [w, h];
        r.blend = layer_blend;
        r.paths.push(rect_entry(w, h));
        r.ops = vec![Op::Fill {
            path: 0,
            even_odd: false,
            paint: Paint::Solid([0.4, 0.5, 0.6, 0.8]),
            blend: fill_blend,
        }];
        r
    }

    fn run_spy(store: &Store, area: IRect, opaque_target: bool) -> SpyBackend {
        let limits = Limits::default();
        let frame = Frame {
            width: 128,
            height: 128,
            view: Affine::IDENTITY,
            detail: false,
            area,
        };
        let mut spy = SpyBackend::new(128, 128, opaque_target);
        let mut budget = limits.frame_verbs;
        draw_split(store, &mut spy, &frame, &limits, &mut budget, &Split::all(), false).unwrap();
        assert_eq!(spy.scene.current, HwBlend::Normal, "hw_blend must reset to Normal");
        spy
    }

    #[test]
    fn cpu_backend_never_enables_hw_blend() {
        let cpu = Cpu::new(1 << 20, 128, 0);
        assert!(!cpu.can_hw_blend());
    }

    #[test]
    fn mode_and_target_opacity_gate_all_four_modes_and_fallbacks() {
        let full = IRect {
            x0: 0,
            y0: 0,
            x1: 128,
            y1: 128,
        };
        for (mode, expected) in [
            (1u32, HwBlend::Multiply),
            (2u32, HwBlend::Screen),
            (16u32, HwBlend::LinearDodge),
            (17u32, HwBlend::LinearBurn),
        ] {
            let mut store = Store::new(Limits::default());
            store.insert_for_test(1, ROOT, solid_leaf(10.0, 10.0, 40.0, 40.0, mode, 0));

            let spy_opaque = run_spy(&store, full, true);
            assert_eq!(spy_opaque.scopes_pushed, 0, "mode {mode} should use HW blend");
            assert_eq!(spy_opaque.scene.draw_modes, vec![expected]);

            let spy_translucent = run_spy(&store, full, false);
            assert_eq!(
                spy_translucent.scopes_pushed, 1,
                "mode {mode} must fall back when non-opaque"
            );
            assert_eq!(spy_translucent.scene.draw_modes, vec![HwBlend::Normal]);
        }

        // Unsupported modes (overlay=3, color-dodge=6, luminosity=15) always fall back.
        for mode in [3u32, 6, 15] {
            let mut store = Store::new(Limits::default());
            store.insert_for_test(1, ROOT, solid_leaf(10.0, 10.0, 40.0, 40.0, mode, 0));
            let spy = run_spy(&store, full, true);
            assert_eq!(spy.scopes_pushed, 1, "mode {mode} must isolate");
            assert_eq!(spy.scene.draw_modes, vec![HwBlend::Normal]);
        }
    }

    #[test]
    fn fill_stroke_and_shadows_use_hw_blend_and_mark_dirty() {
        let full = IRect {
            x0: 0,
            y0: 0,
            x1: 128,
            y1: 128,
        };
        let mut store = Store::new(Limits::default());
        let mut r = Record::empty();
        r.flags = 0;
        r.transform = Affine::translate((10.0, 10.0));
        r.size = [60.0, 60.0];
        r.paths.push(rect_entry(60.0, 60.0));
        r.ops = vec![
            Op::DropShadow {
                paths: vec![0],
                even_odd: false,
                dx: 2.0,
                dy: 2.0,
                blur: 0.0,
                color: [0.0, 0.0, 0.0, 0.5],
                blend: 17,
                stroke: None,
            },
            Op::Fill {
                path: 0,
                even_odd: false,
                paint: Paint::Solid([0.8, 0.2, 0.1, 1.0]),
                blend: 16,
            },
            Op::Stroke {
                path: 0,
                style: Box::new(StrokeStyle {
                    width: 2.0,
                    join: 0,
                    cap: 0,
                    miter: 4.0,
                    dashes: Vec::new(),
                    dash_offset: 0.0,
                }),
                paint: Paint::Solid([0.2, 0.4, 0.8, 1.0]),
                blend: 1,
                cache: Default::default(),
            },
            Op::InnerShadow {
                shape: 0,
                hole: None,
                even_odd: false,
                dx: 0.0,
                dy: 0.0,
                blur: 0.0,
                color: [0.2, 0.2, 0.2, 0.5],
                blend: 2,
            },
        ];
        store.insert_for_test(1, ROOT, r);
        let spy = run_spy(&store, full, true);
        assert_eq!(spy.scopes_pushed, 0);
        assert_eq!(spy.dirty_marks, 4);
        assert_eq!(
            spy.scene.draw_modes,
            vec![
                HwBlend::LinearBurn,
                HwBlend::LinearDodge,
                HwBlend::Multiply,
                HwBlend::Screen,
            ]
        );
    }

    #[test]
    fn disjoint_siblings_use_hw_blend_while_overlapping_siblings_fall_back_tile_invariantly() {
        let full = IRect {
            x0: 0,
            y0: 0,
            x1: 128,
            y1: 128,
        };
        let left_tile = IRect {
            x0: 0,
            y0: 0,
            x1: 64,
            y1: 128,
        };
        let right_tile = IRect {
            x0: 64,
            y0: 0,
            x1: 128,
            y1: 128,
        };

        // 1. Disjoint siblings (> 2 px gap) take HW blend.
        let mut disjoint_store = Store::new(Limits::default());
        let mut parent = Record::empty();
        parent.size = [120.0, 40.0];
        parent.blend = 17;
        parent.ops = vec![Op::Children];
        disjoint_store.insert_for_test(1, ROOT, parent.clone());
        disjoint_store.insert_for_test(2, 1, solid_leaf(10.0, 10.0, 20.0, 20.0, 0, 0));
        disjoint_store.insert_for_test(3, 1, solid_leaf(40.0, 10.0, 20.0, 20.0, 0, 0));
        let spy = run_spy(&disjoint_store, full, true);
        assert_eq!(spy.scopes_pushed, 0);
        assert_eq!(spy.scene.draw_modes, vec![HwBlend::LinearBurn, HwBlend::LinearBurn]);

        // 2. Overlapping siblings spanning across x=64 MUST fall back on BOTH tiles and whole frame.
        let mut overlap_store = Store::new(Limits::default());
        overlap_store.insert_for_test(1, ROOT, parent);
        overlap_store.insert_for_test(2, 1, solid_leaf(40.0, 10.0, 30.0, 20.0, 0, 0));
        overlap_store.insert_for_test(3, 1, solid_leaf(60.0, 10.0, 30.0, 20.0, 0, 0));
        for area in [full, left_tile, right_tile] {
            let spy = run_spy(&overlap_store, area, true);
            assert_eq!(spy.scopes_pushed, 1, "overlapping siblings must fall back on {area:?}");
            assert!(spy.scene.draw_modes.iter().all(|m| *m == HwBlend::Normal));
        }
    }

    #[test]
    fn layer_gate_rejects_partial_opacity_readers_masks_posts_layers_and_overlapping_glyphs() {
        let full = IRect {
            x0: 0,
            y0: 0,
            x1: 128,
            y1: 128,
        };

        // Partial opacity on blended layer must isolate (preserves half-byte tie rounding).
        let mut s = Store::new(Limits::default());
        let mut r = solid_leaf(10.0, 10.0, 40.0, 40.0, 17, 0);
        r.opacity = 0.5;
        s.insert_for_test(1, ROOT, r);
        assert_eq!(run_spy(&s, full, true).scopes_pushed, 1);

        // Inner reader must isolate.
        let mut s = Store::new(Limits::default());
        let mut p = Record::empty();
        p.size = [80.0, 80.0];
        p.blend = 16;
        p.ops = vec![Op::Children];
        s.insert_for_test(1, ROOT, p.clone());
        let mut reader = Record::empty();
        reader.flags = 0;
        reader.size = [40.0, 40.0];
        reader.paths.push(rect_entry(40.0, 40.0));
        reader.ops = vec![Op::BackgroundBlur(Box::new(BackgroundBlurOp {
            paths: vec![0],
            even_odd: false,
            radius: 4.0,
        }))];
        s.insert_for_test(2, 1, reader);
        assert_eq!(run_spy(&s, full, true).scopes_pushed, 1);

        // Inner mask child must isolate.
        let mut s = Store::new(Limits::default());
        s.insert_for_test(1, ROOT, p.clone());
        let mut mask = solid_leaf(10.0, 10.0, 30.0, 30.0, 0, 0);
        mask.mask = MASK_ALPHA;
        s.insert_for_test(2, 1, mask);
        s.insert_for_test(3, 1, solid_leaf(10.0, 10.0, 30.0, 30.0, 0, 0));
        assert!(run_spy(&s, full, true).scopes_pushed >= 1);

        // Inner post effect must isolate.
        let mut s = Store::new(Limits::default());
        s.insert_for_test(1, ROOT, p.clone());
        let mut blurred = solid_leaf(10.0, 10.0, 30.0, 30.0, 0, 0);
        blurred.post_effects.push(PostEffect::LayerBlur { radius: 4.0 });
        s.insert_for_test(2, 1, blurred);
        assert!(run_spy(&s, full, true).scopes_pushed >= 1);

        // Inner Op::Layer must isolate.
        let mut s = Store::new(Limits::default());
        let mut with_layer = Record::empty();
        with_layer.flags = 0;
        with_layer.size = [40.0, 40.0];
        with_layer.blend = 1;
        with_layer.paths.push(rect_entry(40.0, 40.0));
        with_layer.ops = vec![
            Op::Layer {
                compose: ComposeMode::SrcOver,
            },
            Op::Fill {
                path: 0,
                even_odd: false,
                paint: Paint::Solid([0.5, 0.5, 0.5, 1.0]),
                blend: 0,
            },
            Op::Unlayer,
        ];
        s.insert_for_test(1, ROOT, with_layer);
        assert_eq!(run_spy(&s, full, true).scopes_pushed, 1);

        // Glyph run: non-overlapping uses HW blend; overlapping falls back.
        let mut sq = BezPath::new();
        sq.move_to((0.0, 0.0));
        sq.line_to((10.0, 0.0));
        sq.line_to((10.0, 10.0));
        sq.line_to((0.0, 10.0));
        sq.close_path();
        let make_glyph_store = |dx: f32| {
            let limits = Limits::default();
            let mut st = Store::new(limits);
            st.glyphs.define(1, sq.clone(), &limits).unwrap();
            let mut rec = Record::empty();
            rec.flags = 0;
            rec.size = [60.0, 30.0];
            rec.paths.push(PathEntry::Glyphs {
                scale: 1.0,
                glyphs: vec![
                    GlyphInstance {
                        glyph: 1,
                        x: 10.0,
                        y: 20.0,
                    },
                    GlyphInstance {
                        glyph: 1,
                        x: 10.0 + dx,
                        y: 20.0,
                    },
                ],
            });
            rec.ops = vec![Op::Fill {
                path: 0,
                even_odd: false,
                paint: Paint::Solid([0.3, 0.3, 0.3, 1.0]),
                blend: 17,
            }];
            st.insert_for_test(1, ROOT, rec);
            st
        };
        let spy_disjoint = run_spy(&make_glyph_store(15.0), full, true);
        assert_eq!(spy_disjoint.scopes_pushed, 0);
        assert_eq!(spy_disjoint.scene.draw_modes, vec![HwBlend::LinearBurn]);
        let spy_overlap = run_spy(&make_glyph_store(5.0), full, true);
        assert_eq!(spy_overlap.scopes_pushed, 1);
        assert_eq!(spy_overlap.scene.draw_modes, vec![HwBlend::Normal]);

        // Destructive root Op::Layer invalidates target opacity for subsequent blended layers.
        let mut s = Store::new(Limits::default());
        let mut dest = Record::empty();
        dest.flags = 0;
        dest.size = [40.0, 40.0];
        dest.paths.push(PathEntry::Path(CompactPath::from_bez(&sq)));
        dest.ops = vec![
            Op::Layer {
                compose: ComposeMode::DestOut,
            },
            Op::Fill {
                path: 0,
                even_odd: false,
                paint: Paint::Solid([1.0, 1.0, 1.0, 1.0]),
                blend: 0,
            },
            Op::Unlayer,
        ];
        s.insert_for_test(1, ROOT, dest);
        s.insert_for_test(2, ROOT, solid_leaf(50.0, 10.0, 30.0, 30.0, 17, 0));
        let spy = run_spy(&s, full, true);
        assert_eq!(spy.destructive_root_calls, 1);
        assert_eq!(spy.scopes_pushed, 1);
    }

    #[test]
    fn hw_blended_glyph_run_decides_masks_vs_outlines_consistently_across_tiles() {
        let box_path = |w: f64, h: f64| {
            let mut p = BezPath::new();
            p.move_to((0.0, 0.0));
            p.line_to((w, 0.0));
            p.line_to((w, h));
            p.line_to((0.0, h));
            p.close_path();
            p
        };
        let run_tile = |store: &Store, area: IRect| {
            let limits = Limits::default();
            let frame = Frame {
                width: 1024,
                height: 512,
                view: Affine::IDENTITY,
                detail: false,
                area,
            };
            let mut backend = SpyBackend::new(1024, 512, true);
            backend.area = area;
            backend.mask_support = Some((
                crate::masks::Rasterizer::default(),
                crate::masks::MaskCache::new(1 << 20),
            ));
            let mut budget = limits.frame_verbs;
            let stats = draw_split(store, &mut backend, &frame, &limits, &mut budget, &Split::all(), false).unwrap();
            (backend.scopes_pushed, stats.glyphs_masked, stats.glyphs_outlined)
        };
        let left_tile = IRect {
            x0: 0,
            y0: 0,
            x1: 512,
            y1: 512,
        };
        let right_tile = IRect {
            x0: 512,
            y0: 0,
            x1: 1024,
            y1: 512,
        };

        // Mixed run: small glyph straddling x=512 plus tall (> 160 px) glyph strictly on the right
        // tile. Both tiles must choose outlines (0 masked, >= 1 outlined, 0 scopes).
        let limits = Limits::default();
        let mut mixed = Store::new(limits);
        mixed.glyphs.define(1, box_path(24.0, 30.0), &limits).unwrap();
        mixed.glyphs.define(2, box_path(24.0, 204.0), &limits).unwrap();
        let mut rec = Record::empty();
        rec.flags = 0;
        rec.size = [700.0, 300.0];
        rec.paths.push(PathEntry::Glyphs {
            scale: 1.0,
            glyphs: vec![
                GlyphInstance {
                    glyph: 1,
                    x: 500.0,
                    y: 260.0,
                },
                GlyphInstance {
                    glyph: 2,
                    x: 560.0,
                    y: 260.0,
                },
            ],
        });
        rec.ops = vec![Op::Fill {
            path: 0,
            even_odd: false,
            paint: Paint::Solid([0.3, 0.3, 0.3, 0.8]),
            blend: 17,
        }];
        mixed.insert_for_test(1, ROOT, rec);
        for area in [left_tile, right_tile] {
            let (scopes, masked, outlined) = run_tile(&mixed, area);
            assert_eq!(scopes, 0, "mixed run stays HW-blended on {area:?}");
            assert_eq!(masked, 0, "mixed run must not use masks on {area:?}");
            assert!(outlined > 0, "mixed run must outline visible glyphs on {area:?}");
        }

        // Uniform small run straddling x=512: both tiles keep full mask-cache speed (0 scopes).
        let mut uniform = Store::new(limits);
        uniform.glyphs.define(1, box_path(24.0, 30.0), &limits).unwrap();
        let mut rec = Record::empty();
        rec.flags = 0;
        rec.size = [700.0, 100.0];
        rec.paths.push(PathEntry::Glyphs {
            scale: 1.0,
            glyphs: vec![
                GlyphInstance {
                    glyph: 1,
                    x: 500.0,
                    y: 80.0,
                },
                GlyphInstance {
                    glyph: 1,
                    x: 540.0,
                    y: 80.0,
                },
            ],
        });
        rec.ops = vec![Op::Fill {
            path: 0,
            even_odd: false,
            paint: Paint::Solid([0.3, 0.3, 0.3, 0.8]),
            blend: 17,
        }];
        uniform.insert_for_test(1, ROOT, rec);
        for area in [left_tile, right_tile] {
            let (scopes, masked, outlined) = run_tile(&uniform, area);
            assert_eq!(scopes, 0, "uniform run stays HW-blended on {area:?}");
            assert!(masked > 0, "uniform run keeps mask cache on {area:?}");
            assert_eq!(outlined, 0, "uniform run should not outline on {area:?}");
        }
    }
}
