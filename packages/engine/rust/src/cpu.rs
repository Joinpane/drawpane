//! The CPU backend: vello_cpu into a target of premultiplied RGBA8 rows. What a Worker runs, and
//! the reference the GPU is held to.
//!
//! The target is a tile: `cols` × `rows` of the frame from device pixel `origin`, so a large
//! export renders a tile at a time in bounded memory (`Engine::render_band`). A whole frame is
//! one tile. The scene is always the whole frame's size, so geometry lands on the same
//! coordinates whichever tile is drawn, and tiles are bit-identical to a whole frame.

use crate::blur::{BlurSpec, EdgeMode, try_blur_cpu, validate_sigma};
use crate::error::{EngineError, Result};
use crate::exec::{Backend, GlyphMask, IRect, ImageView, Open, ShadowCast, impl_draw};
use crate::images::{self, Level};
use crate::kernels;
use crate::masks::{self, MaskCache, MaskKey};
use crate::shadow::{
    CanonicalShadow, ShadowMaskCache, compute_mask_rect, compute_mask_rect_bounds, reduced_dirty_rect,
    scaled_shadow_sigma, shadow_raster_shift, upsample_shadow_mask_cpu,
};
use std::collections::HashMap;
use std::sync::Arc;
use vello_common::color::{AlphaColor, Srgb};
use vello_common::kurbo::{Affine, BezPath, Rect};
use vello_common::paint::{Image, ImageSource, Tint, TintMode};
use vello_common::peniko::{Extend, Fill, ImageAlphaType, ImageQuality, ImageSampler};
use vello_common::pixmap::PixelMetadata;
use vello_cpu::{Pixmap, RasterizerSettings, RenderContext, RenderMode, Resources, TargetInit};

impl_draw!(RenderContext);

struct CpuTarget {
    pixmap: Pixmap,
    origin: (i32, i32),
    scene_origin: (i32, i32),
    scene_size: (u16, u16),
    scene_pending: bool,
}

/// Aligns `r` outward to 4-pixel boundaries and adds a 4-pixel guard band (matching `vello_cpu`'s
/// 4x4 strip cells) so every painted pixel inside `r` stays strictly interior to the compositing
/// rect, never switching between `vello_cpu`'s edge-strip and solid-interior paths across tiles or
/// unrelated sibling edits.
fn align4_padded(r: IRect) -> IRect {
    IRect {
        x0: r.x0.div_euclid(4) * 4 - 4,
        y0: r.y0.div_euclid(4) * 4 - 4,
        x1: (r.x1 + 3).div_euclid(4) * 4 + 4,
        y1: (r.y1 + 3).div_euclid(4) * 4 + 4,
    }
}

/// Expands an integer rect 4 px past any side that touches `tb`'s boundary (discarded outside the
/// target) so `vello_cpu`'s 4x4 strip cells at tile seams stay strictly interior to the rect,
/// matching whole-frame rendering bit-for-bit.
fn tile_padded_rect(r: IRect, tb: IRect, scene_offset: (i32, i32)) -> Rect {
    let x0 = f64::from(r.x0 - scene_offset.0) - if r.x0 == tb.x0 { 4.0 } else { 0.0 };
    let y0 = f64::from(r.y0 - scene_offset.1) - if r.y0 == tb.y0 { 4.0 } else { 0.0 };
    let x1 = f64::from(r.x1 - scene_offset.0) + if r.x1 == tb.x1 { 4.0 } else { 0.0 };
    let y1 = f64::from(r.y1 - scene_offset.1) + if r.y1 == tb.y1 { 4.0 } else { 0.0 };
    Rect::new(x0, y0, x1, y1)
}

/// Byte cap on transient offscreen pixmaps held by the active CPU scene before an automatic flush
/// releases them in bounded Worker exports.
const WORKER_TEMP_FLUSH_BYTES: usize = 1 << 20;

fn pixmap(width: u32, height: u32, pixels: Vec<u8>) -> Pixmap {
    Pixmap::from_parts(
        pixels,
        width as u16,
        height as u16,
        PixelMetadata {
            may_have_transparency: true,
            alpha_type: ImageAlphaType::AlphaPremultiplied,
        },
    )
}

/// Rough byte footprint of a `vello_cpu::RenderContext` of size `w` x `h` (wide tiles + strips).
pub fn scene_estimate_bytes(w: u32, h: u32) -> usize {
    (w as usize)
        .div_ceil(256)
        .saturating_mul((h as usize).div_ceil(4))
        .saturating_mul(64)
}

/// The loading placeholder: two greys in 8-pixel cells (the canvas renderer's `PLACEHOLDER`).
pub fn checker_pixels() -> Vec<u8> {
    let (light, dark) = ([0xec, 0xec, 0xea, 0xff], [0xdf, 0xdf, 0xdc, 0xff]);
    let mut out = Vec::with_capacity(16 * 16 * 4);
    for y in 0..16 {
        for x in 0..16 {
            out.extend_from_slice(if (x < 8) == (y < 8) { &dark } else { &light });
        }
    }
    out
}

pub struct Cpu {
    pub target: Pixmap,
    /// The device pixel the target's top left is.
    pub origin: (i32, i32),
    /// Whole frame size in device pixels (for restoring root scene dimensions).
    frame_size: (u16, u16),
    scene: RenderContext,
    resources: Resources,
    /// Rasterises glyph masks.
    raster: masks::Rasterizer,
    images: HashMap<u32, Vec<Arc<Pixmap>>>,
    image_bytes: usize,
    /// Temporary diamond-gradient raster bytes retained during the current tile's scene build.
    diamond_bytes: usize,
    /// Upper bound on retained diamond-gradient raster bytes for the current tile.
    diamond_budget: usize,
    pub masks: MaskCache<Arc<Pixmap>>,
    mask_side: u32,
    checker: Arc<Pixmap>,
    /// Shareable CPU blur pyramids, reused across equal inputs within a frame.
    pub blur: crate::blur::CpuBlurCache,
    /// Strictly budgeted LRU cache for canonical blurred shadow masks.
    pub shadow_cache: ShadowMaskCache<Arc<Pixmap>>,
    /// How far the target extends past the band each way, for readers' reach: kernels may read
    /// past the band's edge, never past the target's.
    pub halo: i32,
    /// Stack of active offscreen targets for isolated layers and multi-pass effects.
    offscreen_stack: Vec<CpuTarget>,
    /// Bytes of transient shadow/offscreen pixmaps currently referenced by `self.scene`.
    temp_bytes: usize,
    /// Worker linear-memory cap (`Limits::memory_bytes`, 0 = unchecked).
    memory_budget: usize,
    /// Graph + band + compressor bytes reserved outside `Cpu` while rendering (for runtime guard).
    external_bytes: usize,
}

impl Cpu {
    pub fn new(mask_bytes: usize, mask_side: u32, memory_budget: usize) -> Self {
        let shadow_budget = if memory_budget > 0 {
            (memory_budget / 12).min(2 << 20)
        } else {
            4 << 20
        };
        let blur_budget = if memory_budget > 0 {
            (memory_budget / 12).min(2 << 20)
        } else {
            mask_bytes.clamp(1 << 20, 4 << 20)
        };
        Self {
            target: Pixmap::new(1, 1),
            origin: (0, 0),
            frame_size: (1, 1),
            scene: RenderContext::new(1, 1),
            resources: Resources::new(),
            raster: masks::Rasterizer::default(),
            images: HashMap::new(),
            image_bytes: 0,
            diamond_bytes: 0,
            diamond_budget: usize::MAX,
            masks: MaskCache::new(mask_bytes),
            mask_side,
            checker: Arc::new(pixmap(16, 16, checker_pixels())),
            blur: crate::blur::CpuBlurCache::new(blur_budget),
            shadow_cache: ShadowMaskCache::new(shadow_budget),
            halo: 0,
            offscreen_stack: Vec::new(),
            temp_bytes: 0,
            memory_budget,
            external_bytes: 0,
        }
    }

    pub fn set_diamond_budget(&mut self, budget: usize) {
        self.diamond_budget = budget;
    }

    pub fn set_memory_budget(&mut self, budget: usize) {
        self.memory_budget = budget;
        let shadow_budget = if budget > 0 {
            (budget / 12).min(2 << 20)
        } else {
            4 << 20
        };
        let _ = self.shadow_cache.set_budget(shadow_budget);
        let blur_budget = if budget > 0 {
            (budget / 12).min(2 << 20)
        } else {
            4 << 20
        };
        self.blur.set_budget(blur_budget);
    }

    pub fn set_external_bytes(&mut self, bytes: usize) {
        self.external_bytes = bytes;
    }

    /// Shrinks the reusable target pixmap and scene buffers to minimal size so stale full-frame
    /// allocations do not occupy bounded Worker memory before admitting a new render.
    pub fn shrink_target(&mut self) {
        if self.target.width() > 1 || self.target.height() > 1 {
            self.target = Pixmap::new(1, 1);
        }
        self.offscreen_stack.clear();
        self.temp_bytes = 0;
        self.scene.reset_and_resize(1, 1);
    }

    /// Bytes currently allocated inside `Cpu` (target, offscreen stack, images, caches, temp).
    fn runtime_bytes(&self) -> usize {
        let target_b = self.target.data_as_u8_slice().len();
        let off_b: usize = self
            .offscreen_stack
            .iter()
            .map(|t| t.pixmap.data_as_u8_slice().len())
            .sum();
        let scene_b = scene_estimate_bytes(u32::from(self.scene.width()), u32::from(self.scene.height()));
        target_b
            .saturating_add(off_b)
            .saturating_add(scene_b)
            .saturating_add(self.image_bytes)
            .saturating_add(self.masks.stats.bytes)
            .saturating_add(self.blur.bytes())
            .saturating_add(self.shadow_cache.bytes())
            .saturating_add(self.temp_bytes)
            .saturating_add(self.diamond_bytes)
    }

    /// Verifies that allocating `need` transient bytes stays inside `memory_budget` (when non-zero),
    /// evicting warm caches first and returning a clean `ErrorCode::Limit` instead of trapping Wasm.
    fn check_memory(&mut self, need: usize, what: &str) -> Result<()> {
        if self.memory_budget == 0 {
            return Ok(());
        }
        // Keep headroom for Wasm runtime, stack, and allocator fragmentation (about 4 MiB).
        let cap = self.memory_budget.saturating_sub(4 << 20).max(self.memory_budget / 2);
        let total = self
            .external_bytes
            .saturating_add(self.runtime_bytes())
            .saturating_add(need);
        if total > cap {
            let _ = self.shadow_cache.clear();
            self.blur.clear();
        }
        let total = self
            .external_bytes
            .saturating_add(self.runtime_bytes())
            .saturating_add(need);
        if total > cap {
            return Err(EngineError::limit(format!(
                "{what} needs {} MiB beside the engine's working set; the limit is {} MiB",
                need.div_ceil(1 << 20),
                self.memory_budget >> 20
            )));
        }
        Ok(())
    }

    pub fn image_bytes(&self) -> usize {
        self.image_bytes
    }

    /// Bytes an image held under `id` takes (0: none).
    pub fn held_image(&self, id: u32) -> usize {
        self.images
            .get(&id)
            .map_or(0, |l| l.iter().map(|p| p.data_as_u8_slice().len()).sum())
    }

    pub fn put_image(&mut self, id: u32, levels: &[Level], budget: usize) -> Result<()> {
        let bytes = images::bytes(levels);
        let freed = self
            .images
            .get(&id)
            .map_or(0, |l| l.iter().map(|p| p.data_as_u8_slice().len()).sum());
        if self.image_bytes - freed + bytes > budget {
            return Err(EngineError::limit("images over their budget"));
        }
        let pixmaps = levels
            .iter()
            .map(|l| Arc::new(pixmap(l.width, l.height, l.pixels.clone())))
            .collect();
        self.images.insert(id, pixmaps);
        self.image_bytes = self.image_bytes - freed + bytes;
        Ok(())
    }

    pub fn drop_image(&mut self, id: u32) {
        if let Some(l) = self.images.remove(&id) {
            self.image_bytes -= l.iter().map(|p| p.data_as_u8_slice().len()).sum::<usize>();
        }
    }

    /// Starts a frame (or a tile of one): a scene the whole frame's size, and a target of just
    /// `area`, filled with `background` (premultiplied RGBA8).
    pub fn begin(&mut self, width: u16, height: u16, area: IRect, background: [u8; 4]) {
        let (cols, rows) = ((area.x1 - area.x0).max(1) as u16, (area.y1 - area.y0).max(1) as u16);
        if self.target.width() != cols || self.target.height() != rows {
            self.target = Pixmap::new(cols, rows);
        }
        self.origin = (area.x0, area.y0);
        self.frame_size = (width, height);
        self.offscreen_stack.clear();
        self.temp_bytes = 0;
        for p in self.target.data_as_u8_slice_mut().as_chunks_mut::<4>().0.iter_mut() {
            p.copy_from_slice(&background);
        }
        self.scene.reset_and_resize(width, height);
        self.diamond_bytes = 0;
        self.masks.begin_frame();
        self.blur.begin_frame();
    }

    fn active_scene_size(&self) -> (u16, u16) {
        self.offscreen_stack.last().map_or(self.frame_size, |t| t.scene_size)
    }

    /// Lays the scene drawn since the last flush onto the active target (top offscreen target, or
    /// the root tile target). The scene keeps `(0, 0)` origin whenever the target lies within the
    /// frame bounds so geometry lands on identical floating-point coordinates in tiled exports and
    /// whole frames.
    fn flush_current(&mut self) {
        self.scene.flush();
        if let Some(top) = self.offscreen_stack.last_mut() {
            let settings = RasterizerSettings {
                render_mode: RenderMode::OptimizeQuality,
                target_init: TargetInit::SrcOver,
                offset: (top.scene_origin.0 - top.origin.0, top.scene_origin.1 - top.origin.1),
                ..Default::default()
            };
            self.scene.render_with(&mut top.pixmap, &mut self.resources, settings);
        } else {
            let settings = RasterizerSettings {
                render_mode: RenderMode::OptimizeQuality,
                target_init: TargetInit::SrcOver,
                offset: (-self.origin.0, -self.origin.1),
                ..Default::default()
            };
            self.scene.render_with(&mut self.target, &mut self.resources, settings);
        }
        self.temp_bytes = 0;
    }

    fn reopen_clips(&mut self, open: &[Open]) {
        for o in open {
            if let Open::Clip {
                transform,
                path,
                even_odd,
            } = o
            {
                self.scene.set_transform(*transform);
                self.scene
                    .set_fill_rule(if *even_odd { Fill::EvenOdd } else { Fill::NonZero });
                self.scene.push_clip_path(path);
            }
        }
    }

    pub fn finish(&mut self) {
        self.offscreen_stack.clear();
        self.flush_current();
        self.scene.reset();
    }

    fn stamp_shadow_pixmap(
        &mut self,
        pm: Arc<Pixmap>,
        origin: (i32, i32),
        dirty: IRect,
        color: AlphaColor<Srgb>,
        transient_bytes: usize,
        open: &[Open],
    ) {
        let tb = self.target_bounds();
        let so = self.scene_offset();
        self.scene.set_transform(Affine::IDENTITY);
        self.scene.set_paint(Image {
            image: ImageSource::Pixmap(pm),
            sampler: ImageSampler {
                x_extend: Extend::Pad,
                y_extend: Extend::Pad,
                quality: ImageQuality::Low,
                alpha: 1.0,
            },
        });
        self.scene.set_paint_transform(Affine::translate((
            f64::from(origin.0 - so.0),
            f64::from(origin.1 - so.1),
        )));
        self.scene.set_tint(Some(Tint {
            color,
            mode: TintMode::AlphaMask,
        }));
        self.scene.set_fill_rule(Fill::NonZero);
        self.scene.fill_rect(&tile_padded_rect(dirty, tb, so));
        self.scene.set_tint(None);
        if transient_bytes > 0 {
            self.temp_bytes += transient_bytes;
            if self.memory_budget > 0
                && self.temp_bytes >= WORKER_TEMP_FLUSH_BYTES
                && !open.iter().any(|o| matches!(o, Open::Layer))
            {
                for _ in open {
                    self.scene.pop_clip();
                }
                self.flush_current();
                self.scene.reset();
                self.reopen_clips(open);
            }
        }
    }
}

impl Backend for Cpu {
    type Scene = RenderContext;

    fn scene(&mut self) -> &mut RenderContext {
        &mut self.scene
    }

    fn flush_barrier(&mut self, open: &[Open]) {
        if open.iter().any(|o| matches!(o, Open::Layer)) {
            return;
        }
        for _ in open {
            self.scene.pop_clip();
        }
        self.flush_current();
        self.scene.reset();
        self.reopen_clips(open);
    }

    fn scene_offset(&self) -> (i32, i32) {
        self.offscreen_stack.last().map_or((0, 0), |t| t.scene_origin)
    }

    fn target_bounds(&self) -> IRect {
        if let Some(top) = self.offscreen_stack.last() {
            IRect {
                x0: top.origin.0,
                y0: top.origin.1,
                x1: top.origin.0 + i32::from(top.pixmap.width()),
                y1: top.origin.1 + i32::from(top.pixmap.height()),
            }
        } else {
            IRect {
                x0: self.origin.0,
                y0: self.origin.1,
                x1: self.origin.0 + i32::from(self.target.width()),
                y1: self.origin.1 + i32::from(self.target.height()),
            }
        }
    }

    fn image(&mut self, id: u32, px: f64) -> Option<ImageView> {
        let levels = self.images.get(&id)?;
        let i = images::pick(levels.iter().map(|l| u32::from(l.width())), px);
        let l = levels.get(i)?;
        Some(ImageView {
            source: ImageSource::Pixmap(l.clone()),
            width: u32::from(l.width()),
            height: u32::from(l.height()),
        })
    }

    fn checker(&mut self) -> ImageSource {
        ImageSource::Pixmap(self.checker.clone())
    }

    fn glyph_mask(&mut self, key: MaskKey, path: &BezPath, scale: (f64, f64), phase: (f64, f64)) -> Option<GlyphMask> {
        masks::coverage(
            &mut self.masks,
            &mut self.raster,
            key,
            path,
            scale,
            phase,
            self.mask_side,
        )
    }

    fn run_image(&mut self, w: u16, h: u16, pixels: Vec<u8>) -> Option<ImageSource> {
        Some(ImageSource::Pixmap(Arc::new(pixmap(
            u32::from(w),
            u32::from(h),
            pixels,
        ))))
    }

    fn whole_runs(&self) -> bool {
        true
    }

    fn diamond_gradient(
        &mut self,
        area: IRect,
        device_to_grad: vello_common::kurbo::Affine,
        stops: &[(f32, crate::record::Rgba)],
        alpha: f32,
    ) -> Result<Option<ImageSource>> {
        if area.is_empty() {
            return Ok(None);
        }
        let w = (area.x1 - area.x0).max(1) as usize;
        let h = (area.y1 - area.y0).max(1) as usize;
        let bytes = w.saturating_mul(h).saturating_mul(4);
        let next = self.diamond_bytes.saturating_add(bytes);
        if next > self.diamond_budget {
            return Err(EngineError::limit(format!(
                "diamond gradient rasters need {} MiB in this tile; the CPU budget allows {} MiB",
                next.div_ceil(1 << 20),
                self.diamond_budget >> 20
            )));
        }
        if !self.offscreen_stack.is_empty() {
            self.check_memory(bytes, "an isolated diamond gradient")?;
        }
        let pm = crate::diamond::render_cpu(area, device_to_grad, stops, alpha);
        self.diamond_bytes = next;
        Ok(Some(ImageSource::Pixmap(Arc::new(pm))))
    }

    fn push_isolated(
        &mut self,
        area: IRect,
        clip_to_parent: bool,
        scene_origin_hint: Option<(i32, i32)>,
        open: &[Open],
    ) -> Result<bool> {
        if open.iter().any(|o| matches!(o, Open::Layer)) {
            return Err(EngineError::unsupported(
                "offscreen isolation inside a Vello opacity layer",
            ));
        }
        let area = if clip_to_parent {
            align4_padded(area).intersect(self.target_bounds())
        } else {
            area
        };
        if area.is_empty() {
            return Ok(false);
        }
        let w = (area.x1 - area.x0) as u16;
        let h = (area.y1 - area.y0) as u16;
        let bytes = usize::from(w) * usize::from(h) * 4;
        let (scene_origin, scene_size) = if let Some((hx, hy)) = scene_origin_hint {
            let aligned = (area.x0.div_euclid(4) * 4, area.y0.div_euclid(4) * 4);
            let cx = hx.min(aligned.0);
            let cy = hy.min(aligned.1);
            let sox = if area.x1 - cx <= 8192 { cx } else { aligned.0 };
            let soy = if area.y1 - cy <= 8192 { cy } else { aligned.1 };
            if sox == 0
                && soy == 0
                && area.x1 <= i32::from(self.frame_size.0)
                && area.y1 <= i32::from(self.frame_size.1)
            {
                ((0, 0), self.frame_size)
            } else {
                let sw = (area.x1 - sox).clamp(1, 8192) as u16;
                let sh = (area.y1 - soy).clamp(1, 8192) as u16;
                ((sox, soy), (sw, sh))
            }
        } else if let Some(parent) = self.offscreen_stack.last()
            && area.x0 >= parent.scene_origin.0
            && area.y0 >= parent.scene_origin.1
            && area.x1 <= parent.scene_origin.0 + i32::from(parent.scene_size.0)
            && area.y1 <= parent.scene_origin.1 + i32::from(parent.scene_size.1)
        {
            (parent.scene_origin, parent.scene_size)
        } else if area.x0 >= 0
            && area.y0 >= 0
            && area.x1 <= i32::from(self.frame_size.0)
            && area.y1 <= i32::from(self.frame_size.1)
        {
            ((0, 0), self.frame_size)
        } else {
            let sox = area.x0.div_euclid(4) * 4;
            let soy = area.y0.div_euclid(4) * 4;
            let sw = (area.x1 - sox).clamp(1, 8192) as u16;
            let sh = (area.y1 - soy).clamp(1, 8192) as u16;
            ((sox, soy), (sw, sh))
        };
        self.check_memory(
            bytes.saturating_add(scene_estimate_bytes(u32::from(scene_size.0), u32::from(scene_size.1))),
            "an isolated layer target",
        )?;
        for _ in open {
            self.scene.pop_clip();
        }
        self.flush_current();
        self.offscreen_stack.push(CpuTarget {
            pixmap: Pixmap::new(w, h),
            origin: (area.x0, area.y0),
            scene_origin,
            scene_size,
            scene_pending: true,
        });
        if self.scene.width() != scene_size.0 || self.scene.height() != scene_size.1 {
            self.scene.reset_and_resize(scene_size.0, scene_size.1);
        } else {
            self.scene.reset();
        }
        Ok(true)
    }

    fn push_isolated_backdrop(&mut self, area: IRect, open: &[Open]) -> Result<bool> {
        if open.iter().any(|o| matches!(o, Open::Layer)) {
            return Err(EngineError::unsupported(
                "offscreen isolation inside a Vello opacity layer",
            ));
        }
        let area = align4_padded(area).intersect(self.target_bounds());
        if area.is_empty() {
            return Ok(false);
        }
        let w = (area.x1 - area.x0) as u16;
        let h = (area.y1 - area.y0) as u16;
        let bytes = usize::from(w) * usize::from(h) * 4;
        let (scene_origin, scene_size) = if let Some(parent) = self.offscreen_stack.last()
            && area.x0 >= parent.scene_origin.0
            && area.y0 >= parent.scene_origin.1
            && area.x1 <= parent.scene_origin.0 + i32::from(parent.scene_size.0)
            && area.y1 <= parent.scene_origin.1 + i32::from(parent.scene_size.1)
        {
            (parent.scene_origin, parent.scene_size)
        } else if area.x0 >= 0
            && area.y0 >= 0
            && area.x1 <= i32::from(self.frame_size.0)
            && area.y1 <= i32::from(self.frame_size.1)
        {
            ((0, 0), self.frame_size)
        } else {
            let sox = area.x0.div_euclid(4) * 4;
            let soy = area.y0.div_euclid(4) * 4;
            let sw = (area.x1 - sox).clamp(1, 8192) as u16;
            let sh = (area.y1 - soy).clamp(1, 8192) as u16;
            ((sox, soy), (sw, sh))
        };
        self.check_memory(
            bytes.saturating_add(scene_estimate_bytes(u32::from(scene_size.0), u32::from(scene_size.1))),
            "a pass-through isolated layer",
        )?;
        for _ in open {
            self.scene.pop_clip();
        }
        self.flush_current();
        let mut pm = Pixmap::new(w, h);
        {
            let (parent_origin, parent_pm) = if let Some(parent) = self.offscreen_stack.last() {
                (parent.origin, &parent.pixmap)
            } else {
                (self.origin, &self.target)
            };
            let pw = usize::from(parent_pm.width());
            let sx0 = (area.x0 - parent_origin.0) as usize;
            let sy0 = (area.y0 - parent_origin.1) as usize;
            let row_bytes = usize::from(w) * 4;
            let src = parent_pm.data_as_u8_slice();
            let dst = pm.data_as_u8_slice_mut();
            for row in 0..usize::from(h) {
                let s_off = ((sy0 + row) * pw + sx0) * 4;
                let d_off = row * row_bytes;
                dst[d_off..d_off + row_bytes].copy_from_slice(&src[s_off..s_off + row_bytes]);
            }
        }
        self.offscreen_stack.push(CpuTarget {
            pixmap: pm,
            origin: (area.x0, area.y0),
            scene_origin,
            scene_size,
            scene_pending: true,
        });
        if self.scene.width() != scene_size.0 || self.scene.height() != scene_size.1 {
            self.scene.reset_and_resize(scene_size.0, scene_size.1);
        } else {
            self.scene.reset();
        }
        Ok(true)
    }

    fn blur_isolated(&mut self, steps: &[(IRect, f32)]) -> Result<()> {
        if steps.is_empty() {
            return Ok(());
        }
        if self.offscreen_stack.last().is_some_and(|t| t.scene_pending) {
            self.flush_current();
            self.scene.reset();
        }
        let Some(mut src) = self.offscreen_stack.pop() else {
            return Ok(());
        };
        for &(out_area, sigma) in steps {
            if out_area.is_empty() {
                return Ok(());
            }
            let src_w = u32::from(src.pixmap.width());
            let src_h = u32::from(src.pixmap.height());
            let dst_w = (out_area.x1 - out_area.x0).max(1) as u32;
            let dst_h = (out_area.y1 - out_area.y0).max(1) as u32;
            let dst_origin = (out_area.x0 - src.origin.0, out_area.y0 - src.origin.1);
            let spec = BlurSpec {
                sigma,
                edge: EdgeMode::Zero,
                clamp_bounds: IRect {
                    x0: 0,
                    y0: 0,
                    x1: src_w as i32,
                    y1: src_h as i32,
                },
                dirty: IRect {
                    x0: dst_origin.0,
                    y0: dst_origin.1,
                    x1: dst_origin.0 + dst_w as i32,
                    y1: dst_origin.1 + dst_h as i32,
                },
            };
            crate::blur::validate_sigma(sigma, spec.clamp_bounds, spec.edge)?;
            let src_bytes = (src_w as usize).saturating_mul(src_h as usize).saturating_mul(4);
            let dst_bytes = (dst_w as usize)
                .checked_mul(dst_h as usize)
                .and_then(|n| n.checked_mul(4))
                .ok_or_else(|| EngineError::limit("layer blur output size overflow"))?;
            // Charge blurred output plus intermediate pyramid/scratch bytes beside current src.
            let scratch = crate::blur::cpu_work_bytes((src_w, src_h), (dst_w, dst_h), sigma);
            let need = src_bytes.saturating_add(dst_bytes).saturating_add(scratch);
            self.check_memory(need, "a layer blur pass")?;
            let mut out = vec![0u8; dst_bytes];
            try_blur_cpu(
                src.pixmap.data_as_u8_slice(),
                (src_w, src_h),
                &mut out,
                (dst_w, dst_h),
                dst_origin,
                &spec,
            )?;
            src = CpuTarget {
                pixmap: pixmap(dst_w, dst_h, out),
                origin: (out_area.x0, out_area.y0),
                scene_origin: (0, 0),
                scene_size: self.frame_size,
                scene_pending: false,
            };
        }
        self.offscreen_stack.push(src);
        Ok(())
    }

    fn pop_isolated(&mut self, opacity: f32, open: &[Open]) -> Result<()> {
        if self.offscreen_stack.last().is_some_and(|t| t.scene_pending) {
            self.flush_current();
        }
        let Some(mut top) = self.offscreen_stack.pop() else {
            return Ok(());
        };
        let (pw, ph) = self.active_scene_size();
        if self.scene.width() != pw || self.scene.height() != ph {
            self.scene.reset_and_resize(pw, ph);
        } else {
            self.scene.reset();
        }
        self.reopen_clips(open);
        let alpha = opacity.clamp(0.0, 1.0);
        if alpha <= 0.0 {
            return Ok(());
        }
        if alpha < 1.0 {
            for px in top.pixmap.data_as_u8_slice_mut().as_chunks_mut::<4>().0.iter_mut() {
                if px[3] == 0 {
                    continue;
                }
                for ch in px.iter_mut() {
                    *ch = (f32::from(*ch) * alpha).round().clamp(0.0, 255.0) as u8;
                }
            }
        }
        let so = self.scene_offset();
        let x = f64::from(top.origin.0 - so.0);
        let y = f64::from(top.origin.1 - so.1);
        let rect = IRect {
            x0: top.origin.0,
            y0: top.origin.1,
            x1: top.origin.0 + i32::from(top.pixmap.width()),
            y1: top.origin.1 + i32::from(top.pixmap.height()),
        };
        let bytes = top.pixmap.data_as_u8_slice().len();
        let pm = Arc::new(top.pixmap);
        self.scene.set_transform(Affine::IDENTITY);
        self.scene.set_paint(Image {
            image: ImageSource::Pixmap(pm),
            sampler: ImageSampler {
                x_extend: Extend::Pad,
                y_extend: Extend::Pad,
                quality: ImageQuality::Low,
                alpha: 1.0,
            },
        });
        self.scene.set_paint_transform(Affine::translate((x, y)));
        self.scene.set_tint(None);
        self.scene.set_fill_rule(Fill::NonZero);
        let tb = self.target_bounds();
        self.scene.fill_rect(&tile_padded_rect(rect, tb, so));
        self.temp_bytes += bytes;
        if self.memory_budget > 0
            && self.temp_bytes >= WORKER_TEMP_FLUSH_BYTES
            && !open.iter().any(|o| matches!(o, Open::Layer))
        {
            for _ in open {
                self.scene.pop_clip();
            }
            self.flush_current();
            self.scene.reset();
            self.reopen_clips(open);
        }
        Ok(())
    }

    fn pop_blended(&mut self, blend: u32, opacity: f32, open: &[Open]) -> Result<()> {
        if self.offscreen_stack.last().is_some_and(|t| t.scene_pending) {
            self.flush_current();
        }
        let Some(top) = self.offscreen_stack.pop() else {
            return Ok(());
        };
        let (pw, ph) = self.active_scene_size();
        if self.scene.width() != pw || self.scene.height() != ph {
            self.scene.reset_and_resize(pw, ph);
        } else {
            self.scene.reset();
        }
        let alpha = opacity.clamp(0.0, 1.0);
        if alpha > 0.0 {
            let tw = top.pixmap.width();
            let th = top.pixmap.height();
            let has_clips = open.iter().any(|o| matches!(o, Open::Clip { .. }));
            let clip_pm = if has_clips {
                let clip_bytes = usize::from(tw) * usize::from(th) * 4;
                self.check_memory(
                    clip_bytes.saturating_add(scene_estimate_bytes(u32::from(pw), u32::from(ph))),
                    "a blended clip mask",
                )?;
                let parent_so = self.scene_offset();
                let mut clip = RenderContext::new(pw, ph);
                for o in open {
                    if let Open::Clip {
                        transform,
                        path,
                        even_odd,
                    } = o
                    {
                        clip.set_transform(*transform);
                        clip.set_fill_rule(if *even_odd { Fill::EvenOdd } else { Fill::NonZero });
                        clip.push_clip_path(path);
                    }
                }
                clip.set_transform(Affine::IDENTITY);
                clip.set_paint(vello_common::color::palette::css::WHITE);
                clip.set_fill_rule(Fill::NonZero);
                clip.fill_rect(&Rect::new(
                    f64::from(top.origin.0 - parent_so.0) - 4.0,
                    f64::from(top.origin.1 - parent_so.1) - 4.0,
                    f64::from(top.origin.0 + i32::from(tw) - parent_so.0) + 4.0,
                    f64::from(top.origin.1 + i32::from(th) - parent_so.1) + 4.0,
                ));
                for o in open {
                    if matches!(o, Open::Clip { .. }) {
                        clip.pop_clip();
                    }
                }
                clip.flush();
                let mut mask = Pixmap::new(tw, th);
                let settings = RasterizerSettings {
                    render_mode: RenderMode::OptimizeQuality,
                    offset: (parent_so.0 - top.origin.0, parent_so.1 - top.origin.1),
                    ..Default::default()
                };
                clip.render_with(&mut mask, &mut self.resources, settings);
                Some(mask)
            } else {
                None
            };
            let (dst_origin, dst_pm) = if let Some(parent) = self.offscreen_stack.last_mut() {
                (parent.origin, &mut parent.pixmap)
            } else {
                (self.origin, &mut self.target)
            };
            let dst_size = (u32::from(dst_pm.width()), u32::from(dst_pm.height()));
            let offset = (top.origin.0 - dst_origin.0, top.origin.1 - dst_origin.1);
            crate::blend::blend_cpu(
                top.pixmap.data_as_u8_slice(),
                dst_pm.data_as_u8_slice_mut(),
                dst_size,
                (u32::from(tw), u32::from(th)),
                offset,
                blend,
                alpha,
                clip_pm.as_ref().map(|p| p.data_as_u8_slice()),
            );
        }
        self.reopen_clips(open);
        Ok(())
    }

    fn abort_isolated(&mut self) {
        self.offscreen_stack.pop();
        let (pw, ph) = self.active_scene_size();
        if self.scene.width() != pw || self.scene.height() != ph {
            self.scene.reset_and_resize(pw, ph);
        } else {
            self.scene.reset();
        }
        self.temp_bytes = 0;
    }

    fn draw_blurred_shadow(
        &mut self,
        cast: &ShadowCast<'_>,
        canonical: Option<&CanonicalShadow>,
        invert: bool,
        dirty: IRect,
        sigma: f32,
        color: AlphaColor<Srgb>,
        open: &[Open],
    ) -> Result<()> {
        let dirty = align4_padded(dirty).intersect(self.target_bounds());
        if dirty.is_empty() {
            return Ok(());
        }
        validate_sigma(
            sigma,
            IRect {
                x0: 0,
                y0: 0,
                x1: (dirty.x1 - dirty.x0).max(1),
                y1: (dirty.y1 - dirty.y0).max(1),
            },
            EdgeMode::Zero,
        )?;

        // Fast path: canonical rounded-box / ellipse mask cache (bit-identical across tiles because
        // the cached mask depends only on the canonical shape, never on tile bounds).
        if let Some(canon) = canonical {
            let cw = (canon.mask_rect.x1 - canon.mask_rect.x0) as u32;
            let ch = (canon.mask_rect.y1 - canon.mask_rect.y0) as u32;
            let cache_bytes = (cw as usize) * (ch as usize) * 4;
            if self.shadow_cache.fits_budget(cache_bytes) {
                if let Some(entry) = self.shadow_cache.get(&canon.key) {
                    let pm = entry.value.clone();
                    let origin = (canon.anchor.0 + entry.origin.0, canon.anchor.1 + entry.origin.1);
                    self.stamp_shadow_pixmap(pm, origin, dirty, color, 0, open);
                    return Ok(());
                }
                let need = cache_bytes
                    .saturating_mul(3)
                    .saturating_add(scene_estimate_bytes(cw, ch));
                if self.check_memory(need, "a cached shadow mask").is_ok() {
                    let mut mask_scene = RenderContext::new(cw as u16, ch as u16);
                    mask_scene.set_transform(Affine::translate((
                        -f64::from(canon.mask_rect.x0),
                        -f64::from(canon.mask_rect.y0),
                    )));
                    mask_scene.set_paint(AlphaColor::<Srgb>::new([1.0, 1.0, 1.0, 1.0]));
                    mask_scene.set_fill_rule(Fill::NonZero);
                    mask_scene.fill_path(&canon.path);
                    mask_scene.flush();
                    let mut mask_pm = Pixmap::new(cw as u16, ch as u16);
                    let settings = RasterizerSettings {
                        render_mode: RenderMode::OptimizeQuality,
                        ..Default::default()
                    };
                    mask_scene.render_with(&mut mask_pm, &mut self.resources, settings);
                    let mut out = vec![0u8; cache_bytes];
                    let full = IRect {
                        x0: 0,
                        y0: 0,
                        x1: cw as i32,
                        y1: ch as i32,
                    };
                    try_blur_cpu(
                        mask_pm.data_as_u8_slice(),
                        (cw, ch),
                        &mut out,
                        (cw, ch),
                        (0, 0),
                        &BlurSpec {
                            sigma: canon.sigma,
                            edge: EdgeMode::Zero,
                            clamp_bounds: full,
                            dirty: full,
                        },
                    )?;
                    if invert {
                        for px in out.as_chunks_mut::<4>().0.iter_mut() {
                            px[0] = 0;
                            px[1] = 0;
                            px[2] = 0;
                            px[3] = 255 - px[3];
                        }
                    }
                    let pm = Arc::new(pixmap(cw, ch, out));
                    let mask_origin = (canon.mask_rect.x0, canon.mask_rect.y0);
                    let _ = self.shadow_cache.insert(
                        canon.key,
                        pm.clone(),
                        mask_origin,
                        (cw as u16, ch as u16),
                        cache_bytes,
                    );
                    let origin = (canon.anchor.0 + mask_origin.0, canon.anchor.1 + mask_origin.1);
                    self.stamp_shadow_pixmap(pm, origin, dirty, color, 0, open);
                    return Ok(());
                }
            }
        }

        let mask_rect_opt = match cast {
            ShadowCast::Fill { paths, .. } => compute_mask_rect(paths, dirty, sigma, 8192),
            ShadowCast::Stroke { bbox, .. } => compute_mask_rect_bounds(*bbox, dirty, sigma, 8192),
        };
        let Some(mask_rect) = mask_rect_opt else {
            if invert {
                let tb = self.target_bounds();
                let so = self.scene_offset();
                self.scene.set_transform(Affine::IDENTITY);
                self.scene.reset_paint_transform();
                self.scene.set_tint(None);
                self.scene.set_paint(color);
                self.scene.set_fill_rule(Fill::NonZero);
                self.scene.fill_rect(&tile_padded_rect(dirty, tb, so));
            }
            return Ok(());
        };

        let mask_w = (mask_rect.x1 - mask_rect.x0).max(1) as u32;
        let mask_h = (mask_rect.y1 - mask_rect.y0).max(1) as u32;
        let dirty_w = (dirty.x1 - dirty.x0).max(1) as u32;
        let dirty_h = (dirty.y1 - dirty.y0).max(1) as u32;
        let out_bytes = (dirty_w as usize)
            .checked_mul(dirty_h as usize)
            .and_then(|n| n.checked_mul(4))
            .ok_or_else(|| EngineError::limit("shadow output size overflow"))?;
        let shift = shadow_raster_shift(sigma);
        let dst_origin = (dirty.x0 - mask_rect.x0, dirty.y0 - mask_rect.y0);
        let mut out = if shift == 0 {
            let mask_bytes = (mask_w as usize)
                .checked_mul(mask_h as usize)
                .and_then(|n| n.checked_mul(4))
                .ok_or_else(|| EngineError::limit("shadow mask size overflow"))?;
            // Mask pixmap + scene + blur scratch (~1.5x mask) + output.
            let need = mask_bytes
                .saturating_mul(2)
                .saturating_add(mask_bytes / 2)
                .saturating_add(scene_estimate_bytes(mask_w, mask_h))
                .saturating_add(out_bytes);
            self.check_memory(need, "a blurred shadow")?;

            let scene_origin = match cast {
                ShadowCast::Fill { paths, .. } => {
                    use vello_common::kurbo::Shape;
                    let mut bbox: Option<Rect> = None;
                    for p in *paths {
                        if !p.is_empty() {
                            let b = p.bounding_box();
                            bbox = Some(bbox.map_or(b, |o| o.union(b)));
                        }
                    }
                    let b = bbox.map_or(mask_rect, |r| IRect::around(r).inflate(2, 2));
                    let ox = b.x0.max(mask_rect.x0 - 4096).min(mask_rect.x0);
                    let oy = b.y0.max(mask_rect.y0 - 4096).min(mask_rect.y0);
                    if mask_rect.x1 - ox <= 8192 && mask_rect.y1 - oy <= 8192 {
                        (ox, oy)
                    } else {
                        (mask_rect.x0, mask_rect.y0)
                    }
                }
                ShadowCast::Stroke { .. } => (mask_rect.x0, mask_rect.y0),
            };
            let scene_w = (mask_rect.x1 - scene_origin.0).max(1) as u16;
            let scene_h = (mask_rect.y1 - scene_origin.1).max(1) as u16;
            let mut mask_scene = RenderContext::new(scene_w, scene_h);
            let base_shift = Affine::translate((-f64::from(scene_origin.0), -f64::from(scene_origin.1)));
            mask_scene.set_paint(AlphaColor::<Srgb>::new([1.0, 1.0, 1.0, 1.0]));
            match cast {
                ShadowCast::Fill { paths, even_odd } => {
                    mask_scene.set_transform(base_shift);
                    mask_scene.set_fill_rule(if *even_odd { Fill::EvenOdd } else { Fill::NonZero });
                    for p in *paths {
                        if !p.is_empty() {
                            mask_scene.fill_path(p);
                        }
                    }
                }
                ShadowCast::Stroke {
                    paths,
                    transform,
                    stroke,
                    ..
                } => {
                    mask_scene.set_transform(base_shift * *transform);
                    mask_scene.set_stroke(stroke.clone());
                    for p in *paths {
                        if !p.is_empty() {
                            mask_scene.stroke_path(p);
                        }
                    }
                }
            }
            mask_scene.flush();
            let mut mask_pm = Pixmap::new(mask_w as u16, mask_h as u16);
            let settings = RasterizerSettings {
                render_mode: RenderMode::OptimizeQuality,
                offset: (scene_origin.0 - mask_rect.x0, scene_origin.1 - mask_rect.y0),
                ..Default::default()
            };
            mask_scene.render_with(&mut mask_pm, &mut self.resources, settings);

            let spec = BlurSpec {
                sigma,
                edge: EdgeMode::Zero,
                clamp_bounds: IRect {
                    x0: 0,
                    y0: 0,
                    x1: mask_w as i32,
                    y1: mask_h as i32,
                },
                dirty: IRect {
                    x0: dst_origin.0,
                    y0: dst_origin.1,
                    x1: dst_origin.0 + dirty_w as i32,
                    y1: dst_origin.1 + dirty_h as i32,
                },
            };
            let mut buf = vec![0u8; out_bytes];
            try_blur_cpu(
                mask_pm.data_as_u8_slice(),
                (mask_w, mask_h),
                &mut buf,
                (dirty_w, dirty_h),
                dst_origin,
                &spec,
            )?;
            if invert {
                for px in buf.as_chunks_mut::<4>().0.iter_mut() {
                    px[0] = 0;
                    px[1] = 0;
                    px[2] = 0;
                    px[3] = 255 - px[3];
                }
            }
            buf
        } else {
            // Reduced-resolution mask rasterisation + variance-compensated blur + bilinear upsample.
            let s = 1u32 << shift;
            let sw = (mask_w / s).max(1);
            let sh = (mask_h / s).max(1);
            let (red_origin, (bd_w, bd_h)) = reduced_dirty_rect(mask_rect, dirty, shift);
            let red_mask_bytes = (sw as usize).saturating_mul(sh as usize).saturating_mul(4);
            let red_blur_bytes = (bd_w as usize).saturating_mul(bd_h as usize).saturating_mul(4);
            let need = red_mask_bytes
                .saturating_mul(3)
                .saturating_add(red_blur_bytes)
                .saturating_add(scene_estimate_bytes(sw, sh))
                .saturating_add(out_bytes);
            self.check_memory(need, "a large-radius blurred shadow")?;

            let mut mask_scene = RenderContext::new(sw as u16, sh as u16);
            let red_tf = Affine::scale(1.0 / f64::from(s))
                * Affine::translate((-f64::from(mask_rect.x0), -f64::from(mask_rect.y0)));
            mask_scene.set_paint(AlphaColor::<Srgb>::new([1.0, 1.0, 1.0, 1.0]));
            match cast {
                ShadowCast::Fill { paths, even_odd } => {
                    mask_scene.set_transform(red_tf);
                    mask_scene.set_fill_rule(if *even_odd { Fill::EvenOdd } else { Fill::NonZero });
                    for p in *paths {
                        if !p.is_empty() {
                            mask_scene.fill_path(p);
                        }
                    }
                }
                ShadowCast::Stroke {
                    paths,
                    transform,
                    stroke,
                    ..
                } => {
                    mask_scene.set_transform(red_tf * *transform);
                    mask_scene.set_stroke(stroke.clone());
                    for p in *paths {
                        if !p.is_empty() {
                            mask_scene.stroke_path(p);
                        }
                    }
                }
            }
            mask_scene.flush();
            let mut mask_pm = Pixmap::new(sw as u16, sh as u16);
            let settings = RasterizerSettings {
                render_mode: RenderMode::OptimizeQuality,
                ..Default::default()
            };
            mask_scene.render_with(&mut mask_pm, &mut self.resources, settings);

            let mut red_blurred = vec![0u8; red_blur_bytes];
            try_blur_cpu(
                mask_pm.data_as_u8_slice(),
                (sw, sh),
                &mut red_blurred,
                (bd_w, bd_h),
                red_origin,
                &BlurSpec {
                    sigma: scaled_shadow_sigma(sigma, shift),
                    edge: EdgeMode::Zero,
                    clamp_bounds: IRect {
                        x0: 0,
                        y0: 0,
                        x1: sw as i32,
                        y1: sh as i32,
                    },
                    dirty: IRect {
                        x0: red_origin.0,
                        y0: red_origin.1,
                        x1: red_origin.0 + bd_w as i32,
                        y1: red_origin.1 + bd_h as i32,
                    },
                },
            )?;
            let mut buf = vec![0u8; out_bytes];
            upsample_shadow_mask_cpu(
                &red_blurred,
                (bd_w, bd_h),
                red_origin,
                &mut buf,
                (dirty_w, dirty_h),
                dst_origin,
                shift,
                invert,
            );
            buf
        };

        let bytes = out.len();
        // Ensure RGB doesn't matter under AlphaMask; keep alpha intact.
        let _ = &mut out;
        let shadow_pm = Arc::new(pixmap(dirty_w, dirty_h, out));
        self.stamp_shadow_pixmap(shadow_pm, (dirty.x0, dirty.y0), dirty, color, bytes, open);
        Ok(())
    }

    fn read(&mut self, kernel: u32, paints: IRect, reads: IRect, open: &[Open]) -> Result<()> {
        if open.iter().any(|o| matches!(o, Open::Layer)) {
            return Err(EngineError::unsupported(
                "a backdrop reader inside a layer that fades as one",
            ));
        }
        // Everything drawn so far is the backdrop: lay it down, run the kernel over the target,
        // and reopen the clips. Clips are clip paths, which don't isolate, so the next scene's
        // source-over lands on the pixels exactly as one scene would have drawn them.
        for _ in open {
            self.scene.pop_clip();
        }
        self.flush_current();
        self.scene.reset();
        let (target_origin, w, h, src) = if let Some(top) = self.offscreen_stack.last() {
            (
                top.origin,
                i32::from(top.pixmap.width()),
                i32::from(top.pixmap.height()),
                top.pixmap.data_as_u8_slice().to_vec(),
            )
        } else {
            (
                self.origin,
                i32::from(self.target.width()),
                i32::from(self.target.height()),
                self.target.data_as_u8_slice().to_vec(),
            )
        };
        let halo = (i64::from(reads.x1) - i64::from(paints.x1))
            .max(i64::from(paints.x0) - i64::from(reads.x0))
            .clamp(0, 512) as i32;
        let mut out = src.clone();
        let result = kernels::run(kernel, &src, &mut out, w, h, target_origin, paints, reads, halo);
        if result.is_ok() {
            // What the reader paints goes through the clips it's drawn in, as any paint does:
            // their coverage, drawn in the frame's own coordinates (so a band agrees with the
            // whole frame), mixes its output with what was there.
            let mut clip = RenderContext::new(self.scene.width(), self.scene.height());
            for o in open {
                if let Open::Clip {
                    transform,
                    path,
                    even_odd,
                } = o
                {
                    clip.set_transform(*transform);
                    clip.set_fill_rule(if *even_odd { Fill::EvenOdd } else { Fill::NonZero });
                    clip.push_clip_path(path);
                }
            }
            let so = self.scene_offset();
            clip.set_transform(Affine::IDENTITY);
            clip.set_paint(vello_common::color::palette::css::WHITE);
            clip.fill_rect(&Rect::new(
                f64::from(paints.x0 - so.0),
                f64::from(paints.y0 - so.1),
                f64::from(paints.x1 - so.0),
                f64::from(paints.y1 - so.1),
            ));
            for o in open {
                if matches!(o, Open::Clip { .. }) {
                    clip.pop_clip();
                }
            }
            clip.flush();
            let mut mask = Pixmap::new(w as u16, h as u16);
            let settings = RasterizerSettings {
                render_mode: RenderMode::OptimizeQuality,
                offset: (so.0 - target_origin.0, so.1 - target_origin.1),
                ..Default::default()
            };
            clip.render_with(&mut mask, &mut self.resources, settings);
            let m = mask.data_as_u8_slice();
            let dst_pm = self
                .offscreen_stack
                .last_mut()
                .map_or(&mut self.target, |t| &mut t.pixmap);
            for ((t, o), k) in dst_pm
                .data_as_u8_slice_mut()
                .as_chunks_mut::<4>()
                .0
                .iter_mut()
                .zip(out.as_chunks::<4>().0.iter())
                .zip(m.as_chunks::<4>().0.iter())
            {
                let a = u32::from(k[3]);
                if a == 0 {
                    continue;
                }
                for c in 0..4 {
                    t[c] = ((u32::from(o[c]) * a + u32::from(t[c]) * (255 - a) + 127) / 255) as u8;
                }
            }
        }
        self.reopen_clips(open);
        result
    }
}
