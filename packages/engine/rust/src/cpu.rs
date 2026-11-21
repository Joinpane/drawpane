//! The CPU backend: vello_cpu into a target of premultiplied RGBA8 rows. What a Worker runs, and
//! the reference the GPU is held to.
//!
//! The target is a tile: `cols` × `rows` of the frame from device pixel `origin`, so a large
//! export renders a tile at a time in bounded memory (`Engine::render_band`). A whole frame is
//! one tile. The scene is always the whole frame's size, so geometry lands on the same
//! coordinates whichever tile is drawn, and tiles are bit-identical to a whole frame.

use crate::blur;
use crate::blur::{BlurSpec, EdgeMode, try_blur_cpu, validate_sigma};
use crate::error::{EngineError, Result};
use crate::exec::{Backend, GlyphMask, IRect, ImageView, Isolation, Open, PostStep, ShadowCast, impl_draw};
use crate::exec::{glass_backdrop_layers, resolve_inradius};
use crate::glass;
use crate::images::{self, Level};
use crate::kernels;
use crate::masks::{self, MaskCache, MaskKey};
use crate::progressive_blur;
use crate::record::{BackgroundBlurOp, GlassOp, ProgressiveBlurOp};
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

/// Leaves room for the Wasm runtime, stack, and allocator fragmentation.
pub(crate) fn runtime_memory_cap(budget: usize) -> usize {
    budget.saturating_sub(4 << 20).max(budget / 2)
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

struct CpuScope {
    main: CpuTarget,
    backdrop: Option<CpuTarget>,
    isolation: Isolation,
    parent_writes: (bool, bool),
}

impl CpuScope {
    fn bytes(&self) -> usize {
        self.main.pixmap.data_as_u8_slice().len()
            + self.backdrop.as_ref().map_or(0, |t| t.pixmap.data_as_u8_slice().len())
    }
}

pub(crate) fn scene_work_bytes((width, height): (usize, usize)) -> usize {
    scene_estimate_bytes(width as u32, height as u32).saturating_add(width.saturating_mul(128))
}

pub(crate) fn blur_buffer_bytes((width, height): (u32, u32)) -> usize {
    let size = (width as usize, height as usize);
    let rgba = size.0 * size.1 * 4;
    rgba + rgba.max(scene_work_bytes(size))
}

pub(crate) fn reader_copy_bytes((width, height): (u32, u32), clip_scene: Option<(usize, usize)>) -> usize {
    let rgba = width as usize * height as usize * 4;
    rgba + clip_scene.map_or(0, |size| rgba + scene_work_bytes(size))
}

fn active_clip(open: &Open) -> bool {
    matches!(
        open,
        Open::Clip {
            active_on_scene: true,
            ..
        }
    )
}

fn reader_clip(open: &Open) -> bool {
    matches!(
        open,
        Open::Clip {
            active_on_scene: true,
            context_only: false,
            ..
        }
    )
}

fn copy_rect(src: &Pixmap, src_origin: (i32, i32), dst: &mut Pixmap, dst_origin: (i32, i32)) {
    let sx0 = (dst_origin.0 - src_origin.0) as usize;
    let sy0 = (dst_origin.1 - src_origin.1) as usize;
    let pitch = usize::from(src.width()) * 4;
    let row_bytes = usize::from(dst.width()) * 4;
    let src = src.data_as_u8_slice();
    for (row, dst_row) in dst.data_as_u8_slice_mut().chunks_exact_mut(row_bytes).enumerate() {
        let start = (sy0 + row) * pitch + sx0 * 4;
        dst_row.copy_from_slice(&src[start..start + row_bytes]);
    }
}

pub struct Cpu {
    pub target: Pixmap,
    /// Dual-target backdrop buffer when a frame has stacked glass or export context.
    backdrop: Option<Pixmap>,
    backdrop_live: bool,
    write_main: bool,
    write_backdrop: bool,
    backdrop_gen: u64,
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
    /// Bounded LRU cache of periodic 320 x 320 premultiplied noise grain tiles.
    pub noise: crate::noise::CpuNoiseCache,
    /// Strictly budgeted LRU cache for canonical blurred shadow masks.
    pub shadow_cache: ShadowMaskCache<Arc<Pixmap>>,
    /// How far the target extends past the band each way, for readers' reach: kernels may read
    /// past the band's edge, never past the target's.
    pub halo: i32,
    /// Stack of active offscreen targets for isolated layers and multi-pass effects.
    offscreen_stack: Vec<CpuScope>,
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
            backdrop: None,
            backdrop_live: false,
            write_main: true,
            write_backdrop: false,
            backdrop_gen: 0,
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
            noise: crate::noise::CpuNoiseCache::default(),
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
        let evicted = self.shadow_cache.set_budget(shadow_budget);
        self.account_for_evicted_shadows(evicted);
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
        self.backdrop = None;
        self.offscreen_stack.clear();
        self.temp_bytes = 0;
        self.scene.reset_and_resize(1, 1);
    }

    /// An evicted mask can still be referenced by a pending scene draw.
    fn account_for_evicted_shadows(&mut self, evicted: Vec<Arc<Pixmap>>) {
        for mask in evicted {
            if Arc::strong_count(&mask) > 1 {
                self.temp_bytes = self.temp_bytes.saturating_add(mask.data_as_u8_slice().len());
            }
        }
    }

    /// Bytes currently allocated inside `Cpu` (target, offscreen stack, images, caches, temp).
    fn runtime_bytes(&self) -> usize {
        let target_b = self.target.data_as_u8_slice().len();
        let off_b: usize = self.offscreen_stack.iter().map(CpuScope::bytes).sum();
        let scene_b = scene_estimate_bytes(u32::from(self.scene.width()), u32::from(self.scene.height()));
        target_b
            .saturating_add(self.backdrop.as_ref().map_or(0, |p| p.data_as_u8_slice().len()))
            .saturating_add(off_b)
            .saturating_add(scene_b)
            .saturating_add(self.image_bytes)
            .saturating_add(self.masks.stats.bytes)
            .saturating_add(self.blur.bytes())
            .saturating_add(self.noise.bytes())
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
        let cap = runtime_memory_cap(self.memory_budget);
        let total = self
            .external_bytes
            .saturating_add(self.runtime_bytes())
            .saturating_add(need);
        if total > cap {
            let evicted = self.shadow_cache.clear();
            self.account_for_evicted_shadows(evicted);
            self.blur.clear();
            self.noise.clear();
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

    pub fn clear_view_caches(&mut self) {
        self.masks.clear();
        let evicted = self.shadow_cache.clear();
        self.account_for_evicted_shadows(evicted);
        self.blur.clear();
        self.noise.clear();
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

    pub fn image_sizes(&self, id: u32) -> Vec<(u32, u32)> {
        self.images
            .get(&id)
            .into_iter()
            .flatten()
            .map(|l| (u32::from(l.width()), u32::from(l.height())))
            .collect()
    }

    pub fn image_level_bytes(&self, id: u32, width: u32) -> usize {
        self.images
            .get(&id)
            .and_then(|levels| levels.iter().find(|level| u32::from(level.width()) == width))
            .map_or(0, |level| level.data_as_u8_slice().len())
    }

    pub fn put_image_level(&mut self, id: u32, width: u32, height: u32, rgba: &[u8]) {
        self.drop_image_level(id, width);
        let levels = self.images.entry(id).or_default();
        let at = levels.partition_point(|level| u32::from(level.width()) > width);
        levels.insert(at, Arc::new(pixmap(width, height, images::premultiply(rgba, false))));
        self.image_bytes += rgba.len();
    }

    pub fn drop_image_level(&mut self, id: u32, width: u32) {
        if let Some(levels) = self.images.get_mut(&id) {
            if let Some(at) = levels.iter().position(|level| u32::from(level.width()) == width) {
                self.image_bytes -= levels.remove(at).data_as_u8_slice().len();
            }
            if levels.is_empty() {
                self.images.remove(&id);
            }
        }
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
            if self.memory_budget > 0 {
                self.target.resize(0, 0);
                self.target.shrink_to_fit();
                self.backdrop = None;
            }
            self.target = Pixmap::new(cols, rows);
        }
        self.origin = (area.x0, area.y0);
        self.frame_size = (width, height);
        self.offscreen_stack.clear();
        self.temp_bytes = 0;
        for p in self.target.data_as_u8_slice_mut().as_chunks_mut::<4>().0.iter_mut() {
            p.copy_from_slice(&background);
        }
        self.backdrop_live = false;
        self.write_main = true;
        self.write_backdrop = false;
        self.scene.reset_and_resize(width, height);
        self.diamond_bytes = 0;
        self.masks.begin_frame();
        self.blur.begin_frame();
    }

    fn active_scene_size(&self) -> (u16, u16) {
        self.offscreen_stack
            .last()
            .map_or(self.frame_size, |t| t.main.scene_size)
    }

    /// Lays the scene drawn since the last flush onto the active target (top offscreen target, or
    /// the root tile target). The scene keeps `(0, 0)` origin whenever the target lies within the
    /// frame bounds so geometry lands on identical floating-point coordinates in tiled exports and
    /// whole frames.
    fn flush_current(&mut self) {
        self.backdrop_gen = self.backdrop_gen.wrapping_add(1);
        self.scene.flush();
        let so = self.scene_offset();
        let target_origin = self.main().0;
        let settings = RasterizerSettings {
            render_mode: RenderMode::OptimizeQuality,
            target_init: TargetInit::SrcOver,
            offset: (so.0 - target_origin.0, so.1 - target_origin.1),
            ..Default::default()
        };
        if let Some(top) = self.offscreen_stack.last_mut() {
            if let Some(backdrop) = top.backdrop.as_mut() {
                if self.write_main {
                    self.scene
                        .render_with(&mut top.main.pixmap, &mut self.resources, settings);
                }
                if self.write_backdrop {
                    self.scene
                        .render_with(&mut backdrop.pixmap, &mut self.resources, settings);
                }
            } else if self.write_main || self.write_backdrop {
                self.scene
                    .render_with(&mut top.main.pixmap, &mut self.resources, settings);
            }
        } else {
            if self.write_main {
                self.scene.render_with(&mut self.target, &mut self.resources, settings);
            }
            if self.write_backdrop
                && self.backdrop_live
                && let Some(backdrop) = &mut self.backdrop
            {
                self.scene.render_with(backdrop, &mut self.resources, settings);
            }
        }
        self.temp_bytes = 0;
    }

    fn close_clips(&mut self, open: &[Open]) {
        for _ in open.iter().filter(|o| active_clip(o)) {
            self.scene.pop_clip();
        }
    }

    fn reopen_clips(&mut self, open: &[Open]) {
        for o in open {
            if let Open::Clip {
                transform,
                path,
                even_odd,
                active_on_scene: true,
                ..
            } = o
            {
                self.scene.set_transform(*transform);
                self.scene
                    .set_fill_rule(if *even_odd { Fill::EvenOdd } else { Fill::NonZero });
                self.scene.push_clip_path(path);
            }
        }
    }

    fn main(&self) -> ((i32, i32), &Pixmap) {
        self.offscreen_stack
            .last()
            .map_or((self.origin, &self.target), |scope| {
                (scope.main.origin, &scope.main.pixmap)
            })
    }

    fn readable_backdrop(&self) -> ((i32, i32), &Pixmap) {
        self.backdrop_layer(self.offscreen_stack.len().checked_sub(1))
    }

    fn backdrop_layer(&self, layer: Option<usize>) -> ((i32, i32), &Pixmap) {
        if let Some(layer) = layer {
            let scope = &self.offscreen_stack[layer];
            let target = scope.backdrop.as_ref().unwrap_or(&scope.main);
            (target.origin, &target.pixmap)
        } else if self.backdrop_live
            && let Some(backdrop) = self.backdrop.as_ref()
        {
            (self.origin, backdrop)
        } else {
            (self.origin, &self.target)
        }
    }

    fn main_mut(&mut self) -> ((i32, i32), &mut Pixmap) {
        self.offscreen_stack
            .last_mut()
            .map_or((self.origin, &mut self.target), |scope| {
                (scope.main.origin, &mut scope.main.pixmap)
            })
    }

    fn backdrop_mut(&mut self) -> Option<((i32, i32), &mut Pixmap)> {
        if let Some(scope) = self.offscreen_stack.last_mut() {
            scope
                .backdrop
                .as_mut()
                .map(|target| (target.origin, &mut target.pixmap))
        } else if self.backdrop_live {
            self.backdrop.as_mut().map(|pixmap| (self.origin, pixmap))
        } else {
            None
        }
    }

    fn ensure_backdrop(&mut self) -> Result<()> {
        let (w, h) = (self.target.width(), self.target.height());
        if !self
            .backdrop
            .as_ref()
            .is_some_and(|p| p.width() == w && p.height() == h)
        {
            self.backdrop = None;
            self.check_memory(usize::from(w) * usize::from(h) * 4, "a reader backdrop")?;
            self.backdrop = Some(Pixmap::new(w, h));
        }
        Ok(())
    }

    fn reset_parent_scene(&mut self) {
        let (w, h) = self.active_scene_size();
        if self.scene.width() != w || self.scene.height() != h {
            self.scene.reset_and_resize(w, h);
        } else {
            self.scene.reset();
        }
    }

    fn rasterize_open_clips(&mut self, area: IRect, open: &[Open]) -> Option<Pixmap> {
        if !open.iter().any(reader_clip) {
            return None;
        }
        let (origin, target) = self.main();
        let (w, h) = (target.width(), target.height());
        let so = self.scene_offset();
        let mut clip = RenderContext::new(self.scene.width(), self.scene.height());
        for o in open.iter().filter(|o| reader_clip(o)) {
            if let Open::Clip {
                transform,
                path,
                even_odd,
                ..
            } = o
            {
                clip.set_transform(*transform);
                clip.set_fill_rule(if *even_odd { Fill::EvenOdd } else { Fill::NonZero });
                clip.push_clip_path(path);
            }
        }
        clip.set_transform(Affine::IDENTITY);
        clip.set_paint(vello_common::color::palette::css::WHITE);
        clip.fill_rect(&Rect::new(
            f64::from(area.x0 - so.0),
            f64::from(area.y0 - so.1),
            f64::from(area.x1 - so.0),
            f64::from(area.y1 - so.1),
        ));
        for _ in open.iter().filter(|o| reader_clip(o)) {
            clip.pop_clip();
        }
        clip.flush();
        let mut mask = Pixmap::new(w, h);
        let settings = RasterizerSettings {
            render_mode: RenderMode::OptimizeQuality,
            offset: (so.0 - origin.0, so.1 - origin.1),
            ..Default::default()
        };
        clip.render_with(&mut mask, &mut self.resources, settings);
        Some(mask)
    }

    fn reader_shape_mask(
        &mut self,
        paths: &[(BezPath, bool)],
        device: Affine,
        origin: (i32, i32),
        (width, height): (u32, u32),
    ) -> Pixmap {
        let mut mask_ctx = RenderContext::new(width as u16, height as u16);
        let shifted = Affine::translate((-f64::from(origin.0), -f64::from(origin.1))) * device;
        mask_ctx.set_transform(shifted);
        mask_ctx.set_paint(vello_common::color::palette::css::WHITE);
        for (path, even_odd) in paths {
            mask_ctx.set_fill_rule(if *even_odd { Fill::EvenOdd } else { Fill::NonZero });
            mask_ctx.fill_path(path);
        }
        mask_ctx.flush();
        let mut mask = Pixmap::new(width as u16, height as u16);
        let settings = RasterizerSettings {
            render_mode: RenderMode::OptimizeQuality,
            ..Default::default()
        };
        mask_ctx.render_with(&mut mask, &mut self.resources, settings);
        mask
    }

    fn write_reader_result(&mut self, mut write: impl FnMut(&mut Pixmap)) {
        if self.write_main {
            write(self.main_mut().1);
        }
        if self.write_backdrop {
            if let Some((_, dst)) = self.backdrop_mut() {
                write(dst);
            } else if !self.write_main && !self.offscreen_stack.is_empty() {
                write(self.main_mut().1);
            }
        }
        self.backdrop_gen = self.backdrop_gen.wrapping_add(1);
    }

    pub fn finish(&mut self) {
        self.offscreen_stack.clear();
        self.flush_current();
        self.scene.reset();
    }

    fn post_target(&mut self, mut src: CpuTarget, steps: &[PostStep], held_peer: usize) -> Result<CpuTarget> {
        for step in steps {
            let src_w = u32::from(src.pixmap.width());
            let src_h = u32::from(src.pixmap.height());
            // `src` was popped from `offscreen_stack`, so `runtime_bytes()` does not count it;
            // charge it alongside `dst` in every step so Worker limits see both live buffers.
            let src_bytes =
                ((src_w as usize).saturating_mul(src_h as usize).saturating_mul(4)).saturating_add(held_peer);
            match *step {
                PostStep::LayerBlur { out_area, sigma } => {
                    if out_area.is_empty() {
                        return Ok(src);
                    }
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
                    let dst_bytes = (dst_w as usize)
                        .checked_mul(dst_h as usize)
                        .and_then(|n| n.checked_mul(4))
                        .ok_or_else(|| EngineError::limit("layer blur output size overflow"))?;
                    // Charge blurred output plus live src and scratch beside runtime bytes.
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
                PostStep::Noise {
                    out_area,
                    noise_type,
                    size,
                    density,
                    color,
                    secondary_color,
                    opacity,
                    dev_to_layer,
                } => {
                    if out_area.is_empty() {
                        return Ok(src);
                    }
                    let dst_w = (out_area.x1 - out_area.x0).max(1) as u32;
                    let dst_h = (out_area.y1 - out_area.y0).max(1) as u32;
                    let dst_bytes = (dst_w as usize)
                        .checked_mul(dst_h as usize)
                        .and_then(|n| n.checked_mul(4))
                        .ok_or_else(|| EngineError::limit("noise output size overflow"))?;
                    let active = size > 0.0 && density > 0.0;
                    let noise_need = if !active {
                        0
                    } else if !self.noise.has_fields() {
                        crate::noise::NOISE_WORKING_SET_BYTES
                    } else {
                        let key = crate::noise::NoiseLookKey::from_params(
                            noise_type,
                            density,
                            color,
                            secondary_color,
                            opacity,
                        );
                        if self.noise.contains(key) {
                            0
                        } else {
                            crate::noise::CpuNoiseCache::TILE_BYTES
                        }
                    };
                    self.check_memory(
                        src_bytes.saturating_add(dst_bytes).saturating_add(noise_need),
                        "a noise post-effect pass",
                    )?;
                    // If `check_memory` evicted warm caches (including `self.noise`), re-check
                    // with the full noise working set so we never regenerate it past the cap.
                    if active && !self.noise.has_fields() {
                        self.check_memory(
                            src_bytes
                                .saturating_add(dst_bytes)
                                .saturating_add(crate::noise::NOISE_WORKING_SET_BYTES),
                            "a noise post-effect pass",
                        )?;
                    }
                    let mut out = vec![0u8; dst_bytes];
                    crate::noise::noise_cpu(
                        &mut self.noise,
                        src.pixmap.data_as_u8_slice(),
                        (src_w, src_h),
                        src.origin,
                        &mut out,
                        (dst_w, dst_h),
                        (out_area.x0, out_area.y0),
                        noise_type,
                        size,
                        density,
                        color,
                        secondary_color,
                        opacity,
                        dev_to_layer,
                    );
                    src = CpuTarget {
                        pixmap: pixmap(dst_w, dst_h, out),
                        origin: (out_area.x0, out_area.y0),
                        scene_origin: (0, 0),
                        scene_size: self.frame_size,
                        scene_pending: false,
                    };
                }
                PostStep::Texture {
                    out_area,
                    size,
                    radius_dev,
                    clip_to_shape,
                    dev_to_layer,
                } => {
                    if out_area.is_empty() {
                        return Ok(src);
                    }
                    let dst_w = (out_area.x1 - out_area.x0).max(1) as u32;
                    let dst_h = (out_area.y1 - out_area.y0).max(1) as u32;
                    let dst_bytes = (dst_w as usize)
                        .checked_mul(dst_h as usize)
                        .and_then(|n| n.checked_mul(4))
                        .ok_or_else(|| EngineError::limit("texture output size overflow"))?;
                    self.check_memory(src_bytes.saturating_add(dst_bytes), "a texture post-effect pass")?;
                    let mut out = vec![0u8; dst_bytes];
                    crate::texture::texture_cpu(
                        src.pixmap.data_as_u8_slice(),
                        (src_w, src_h),
                        src.origin,
                        &mut out,
                        (dst_w, dst_h),
                        (out_area.x0, out_area.y0),
                        size,
                        radius_dev,
                        clip_to_shape,
                        dev_to_layer,
                    );
                    src = CpuTarget {
                        pixmap: pixmap(dst_w, dst_h, out),
                        origin: (out_area.x0, out_area.y0),
                        scene_origin: (0, 0),
                        scene_size: self.frame_size,
                        scene_pending: false,
                    };
                }
            }
        }
        Ok(src)
    }

    fn stamp_shadow_pixmap(
        &mut self,
        pm: Arc<Pixmap>,
        origin: (i32, i32),
        dirty: IRect,
        color: AlphaColor<Srgb>,
        transient_bytes: usize,
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
        self.temp_bytes = self.temp_bytes.saturating_add(transient_bytes);
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
        self.close_clips(open);
        self.flush_current();
        self.scene.reset();
        self.reopen_clips(open);
    }

    fn scene_offset(&self) -> (i32, i32) {
        self.offscreen_stack.last().map_or((0, 0), |t| t.main.scene_origin)
    }

    fn target_bounds(&self) -> IRect {
        if let Some(top) = self.offscreen_stack.last().map(|scope| &scope.main) {
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

    fn image(&mut self, id: u32, span: (f64, f64)) -> Option<ImageView> {
        let levels = self.images.get(&id)?;
        let i = images::pick(
            levels.iter().map(|l| (u32::from(l.width()), u32::from(l.height()))),
            span,
        );
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

    fn begin_readers(&mut self, needs_backdrop: bool, has_context: bool) -> Result<()> {
        if needs_backdrop {
            self.ensure_backdrop()?;
            if has_context {
                self.backdrop.as_mut().expect("backdrop").data_as_u8_slice_mut().fill(0);
                self.backdrop_live = true;
            }
        }
        Ok(())
    }

    fn snapshot_backdrop(&mut self, open: &[Open]) -> Result<()> {
        self.flush_barrier(open);
        self.ensure_backdrop()?;
        self.backdrop
            .as_mut()
            .expect("backdrop")
            .data_as_u8_slice_mut()
            .copy_from_slice(self.target.data_as_u8_slice());
        self.backdrop_live = true;
        Ok(())
    }

    fn set_targets(&mut self, write_main: bool, write_backdrop: bool, open: &[Open]) -> Result<()> {
        if (self.write_main, self.write_backdrop) != (write_main, write_backdrop) {
            self.flush_barrier(open);
            self.write_main = write_main;
            self.write_backdrop = write_backdrop;
        }
        Ok(())
    }

    fn push_isolated(
        &mut self,
        area: IRect,
        clip_to_parent: bool,
        scene_origin_hint: Option<(i32, i32)>,
        isolation: Isolation,
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
        } else if let Some(parent) = self.offscreen_stack.last().map(|scope| &scope.main)
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
            bytes
                .saturating_mul(1 + usize::from(isolation.separate))
                .saturating_add(scene_estimate_bytes(u32::from(scene_size.0), u32::from(scene_size.1))),
            "an isolated layer target",
        )?;
        self.close_clips(open);
        self.flush_current();
        let origin = (area.x0, area.y0);
        let make = |(src_origin, src): ((i32, i32), &Pixmap)| {
            let mut pixmap = Pixmap::new(w, h);
            if isolation.copy_parent {
                copy_rect(src, src_origin, &mut pixmap, origin);
            }
            CpuTarget {
                pixmap,
                origin,
                scene_origin,
                scene_size,
                scene_pending: true,
            }
        };
        let main = make(self.main());
        let backdrop = isolation.separate.then(|| make(self.readable_backdrop()));
        let parent_writes = (self.write_main, self.write_backdrop);
        self.offscreen_stack.push(CpuScope {
            main,
            backdrop,
            isolation,
            parent_writes,
        });
        self.write_main = isolation.on_main;
        self.write_backdrop = isolation.on_backdrop;
        self.reset_parent_scene();
        Ok(true)
    }

    fn apply_post_isolated(&mut self, steps: &[PostStep]) -> Result<()> {
        if steps.is_empty() {
            return Ok(());
        }
        if self
            .offscreen_stack
            .last()
            .is_some_and(|scope| scope.main.scene_pending)
        {
            self.flush_current();
            self.scene.reset();
        }
        let Some(CpuScope {
            main,
            backdrop,
            isolation,
            parent_writes,
        }) = self.offscreen_stack.pop()
        else {
            return Ok(());
        };
        // Keep this stack entry even if the pass fails, so abort_isolated unwinds this scope.
        let mut result = Ok(());
        let apply = |this: &mut Self, target, held_peer, result: &mut Result<()>| match this
            .post_target(target, steps, held_peer)
        {
            Ok(dst) => dst,
            Err(error) => {
                *result = Err(error);
                CpuTarget {
                    pixmap: Pixmap::new(1, 1),
                    origin: (0, 0),
                    scene_origin: (0, 0),
                    scene_size: (1, 1),
                    scene_pending: false,
                }
            }
        };
        let held = backdrop.as_ref().map_or(0, |t| t.pixmap.data_as_u8_slice().len());
        let main = apply(self, main, held, &mut result);
        let backdrop = if result.is_ok() {
            backdrop.map(|src| apply(self, src, main.pixmap.data_as_u8_slice().len(), &mut result))
        } else {
            backdrop
        };
        self.offscreen_stack.push(CpuScope {
            main,
            backdrop,
            isolation,
            parent_writes,
        });
        result
    }

    fn pop_isolated(&mut self, opacity: f32, open: &[Open]) -> Result<()> {
        if self
            .offscreen_stack
            .last()
            .is_some_and(|s| s.isolation.on_backdrop || !s.isolation.on_main)
        {
            return self.pop_composited(0, opacity, None, open);
        }
        if self.offscreen_stack.last().is_some_and(|s| s.main.scene_pending) {
            self.flush_current();
        }
        let Some(scope) = self.offscreen_stack.pop() else {
            return Ok(());
        };
        (self.write_main, self.write_backdrop) = scope.parent_writes;
        let mut top = scope.main;
        self.reset_parent_scene();
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
        // Keep the same Vello flush boundaries in the browser and in budgeted bands.
        // The pending pixmap stays charged until the next render-graph flush.
        self.temp_bytes = self.temp_bytes.saturating_add(bytes);
        Ok(())
    }

    fn pop_composited(&mut self, blend: u32, opacity: f32, mask_kind: Option<u32>, open: &[Open]) -> Result<()> {
        if self.offscreen_stack.last().is_some_and(|t| t.main.scene_pending) {
            self.flush_current();
        }
        let picture = mask_kind.and_then(|_| self.offscreen_stack.pop());
        let Some(scope) = self.offscreen_stack.pop() else {
            return Ok(());
        };
        (self.write_main, self.write_backdrop) = scope.parent_writes;
        self.reset_parent_scene();
        let (pw, ph) = self.active_scene_size();
        let top = &scope.main;
        let alpha = opacity.clamp(0.0, 1.0);
        if alpha > 0.0 {
            let tw = top.pixmap.width();
            let th = top.pixmap.height();
            let has_clips = open.iter().any(active_clip);
            let clip_pm = if has_clips {
                let clip_bytes = usize::from(tw) * usize::from(th) * 4;
                self.check_memory(
                    clip_bytes
                        .saturating_add(scene_estimate_bytes(u32::from(pw), u32::from(ph)))
                        .saturating_add(scope.bytes())
                        .saturating_add(picture.as_ref().map_or(0, CpuScope::bytes)),
                    "a blended clip mask",
                )?;
                let parent_so = self.scene_offset();
                let mut clip = RenderContext::new(pw, ph);
                for o in open {
                    if let Open::Clip {
                        transform,
                        path,
                        even_odd,
                        active_on_scene: true,
                        ..
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
                    if active_clip(o) {
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
            let composite = |(dst_origin, dst): ((i32, i32), &mut Pixmap),
                             src: &CpuTarget,
                             masked: Option<&CpuTarget>,
                             alpha: f32| {
                let dst_size = (u32::from(dst.width()), u32::from(dst.height()));
                let src_size = (u32::from(src.pixmap.width()), u32::from(src.pixmap.height()));
                let offset = (src.origin.0 - dst_origin.0, src.origin.1 - dst_origin.1);
                crate::blend::composite_cpu(
                    src.pixmap.data_as_u8_slice(),
                    dst.data_as_u8_slice_mut(),
                    dst_size,
                    src_size,
                    offset,
                    blend,
                    alpha,
                    clip_pm.as_ref().map(Pixmap::data_as_u8_slice),
                    masked
                        .zip(mask_kind)
                        .map(|(p, kind)| (p.pixmap.data_as_u8_slice(), kind)),
                );
            };
            if scope.isolation.on_main {
                composite(
                    self.main_mut(),
                    top,
                    picture.as_ref().map(|p| &p.main),
                    if scope.isolation.unfaded_main { 1.0 } else { alpha },
                );
            }
            if scope.isolation.on_backdrop {
                let src = scope.backdrop.as_ref().unwrap_or(top);
                let mask = picture.as_ref().map(|p| p.backdrop.as_ref().unwrap_or(&p.main));
                if let Some(dst) = self.backdrop_mut() {
                    composite(dst, src, mask, alpha);
                } else if !scope.isolation.on_main && !self.offscreen_stack.is_empty() {
                    composite(self.main_mut(), src, mask, alpha);
                }
            }
        }
        self.reopen_clips(open);
        Ok(())
    }

    fn abort_isolated(&mut self) {
        if let Some(scope) = self.offscreen_stack.pop() {
            (self.write_main, self.write_backdrop) = scope.parent_writes;
        }
        self.reset_parent_scene();
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
        _open: &[Open],
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

        // Canonical coordinates and sigma determine the pixels. Cache admission controls
        // reuse only. If the mask cannot fit, return Limit instead of switching rasterizers.
        if let Some(canon) = canonical {
            if let Some(entry) = self.shadow_cache.get(&canon.key) {
                let pm = entry.value.clone();
                let origin = (canon.anchor.0 + entry.origin.0, canon.anchor.1 + entry.origin.1);
                self.stamp_shadow_pixmap(pm, origin, dirty, color, 0);
                return Ok(());
            }
            let cw = (canon.mask_rect.x1 - canon.mask_rect.x0) as u32;
            let ch = (canon.mask_rect.y1 - canon.mask_rect.y0) as u32;
            let cache_bytes = (cw as usize) * (ch as usize) * 4;
            let blur_bytes = crate::blur::cpu_work_bytes((cw, ch), (cw, ch), canon.sigma);
            let need = cache_bytes
                .saturating_mul(2)
                .saturating_add(blur_bytes)
                .saturating_add(scene_estimate_bytes(cw, ch));
            self.check_memory(need, "a canonical shadow mask")?;

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
            let transient_bytes = if self.shadow_cache.fits_budget(cache_bytes) {
                let evicted =
                    self.shadow_cache
                        .insert(canon.key, pm.clone(), mask_origin, (cw as u16, ch as u16), cache_bytes);
                self.account_for_evicted_shadows(evicted);
                0
            } else {
                cache_bytes
            };
            let origin = (canon.anchor.0 + mask_origin.0, canon.anchor.1 + mask_origin.1);
            self.stamp_shadow_pixmap(pm, origin, dirty, color, transient_bytes);
            return Ok(());
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
        self.stamp_shadow_pixmap(shadow_pm, (dirty.x0, dirty.y0), dirty, color, bytes);
        Ok(())
    }

    fn read(&mut self, kernel: u32, paints: IRect, reads: IRect, open: &[Open]) -> Result<()> {
        if open.iter().any(|o| matches!(o, Open::Layer)) {
            return Err(EngineError::unsupported(
                "a backdrop reader inside a layer that fades as one",
            ));
        }
        self.flush_barrier(open);
        let (origin, backdrop) = self.readable_backdrop();
        let (w, h) = (i32::from(backdrop.width()), i32::from(backdrop.height()));
        let buffers = if open.iter().any(reader_clip) { 3 } else { 2 };
        self.check_memory(w as usize * h as usize * 4 * buffers, "a backdrop reader kernel")?;
        let halo = (i64::from(reads.x1) - i64::from(paints.x1))
            .max(i64::from(paints.x0) - i64::from(reads.x0))
            .clamp(0, 512) as i32;
        let src = self.readable_backdrop().1.data_as_u8_slice().to_vec();
        let mut out = src.clone();
        kernels::run(kernel, &src, &mut out, w, h, origin, paints, reads, halo)?;
        let clip_mask = self.rasterize_open_clips(paints, open);
        let apply = |dst: &mut [u8], out: &[u8], clip_mask: Option<&[u8]>, origin: (i32, i32), w: i32, h: i32| {
            let x0 = (paints.x0 - origin.0).clamp(0, w);
            let y0 = (paints.y0 - origin.1).clamp(0, h);
            let x1 = (paints.x1 - origin.0).clamp(0, w);
            let y1 = (paints.y1 - origin.1).clamp(0, h);
            for y in y0..y1 {
                for x in x0..x1 {
                    let i = ((y * w + x) * 4) as usize;
                    let a = clip_mask.map_or(255u32, |m| u32::from(m[i + 3]));
                    if a == 0 {
                        continue;
                    }
                    for c in 0..4 {
                        dst[i + c] =
                            ((u32::from(out[i + c]) * a + u32::from(dst[i + c]) * (255 - a) + 127) / 255) as u8;
                    }
                }
            }
        };
        let cm = clip_mask.as_ref().map(Pixmap::data_as_u8_slice);
        self.write_reader_result(|dst| apply(dst.data_as_u8_slice_mut(), &out, cm, origin, w, h));
        Ok(())
    }

    fn glass(
        &mut self,
        _key: (u32, usize),
        op: &GlassOp,
        paths: &[(BezPath, bool)],
        device: Affine,
        size: [f32; 2],
        alpha: f32,
        coarse: bool,
        read_parent: bool,
        open: &[Open],
    ) -> Result<()> {
        if open.iter().any(|o| matches!(o, Open::Layer)) {
            return Err(EngineError::unsupported(
                "a backdrop reader inside a layer that fades as one",
            ));
        }
        self.flush_barrier(open);
        let scale = device.determinant().abs().sqrt() as f32;
        if !(scale > 0.0 && scale.is_finite()) {
            return Ok(());
        }
        let inradius = resolve_inradius(&mut self.resources, op, paths, size);
        let params = glass::glass_params(op, scale, inradius);
        let frame_size = (i32::from(self.frame_size.0), i32::from(self.frame_size.1));
        let (origin, target) = self.main();
        let target_size = (i32::from(target.width()), i32::from(target.height()));
        let (base, interiors) = glass_backdrop_layers(&self.offscreen_stack, read_parent, |scope| scope.isolation);
        let (source_origin, source) = self.backdrop_layer(base);
        let source_size = (i32::from(source.width()), i32::from(source.height()));
        let regions = glass::compute_regions(
            op,
            &params,
            device,
            size,
            frame_size,
            origin,
            target_size,
            glass::HARD_MAX_REGION_SIDE.min(u32::from(u16::MAX)),
            glass::HARD_MAX_REGION_PIXELS,
            glass::EXACT_SPLIT_SIDE,
            glass::EXACT_SPLIT_PIXELS,
            glass::EXACT_CHUNK_SIDE,
        )?;
        if regions.is_empty() {
            return Ok(());
        }
        if self.memory_budget > 0 {
            self.blur.clear();
            let clip_scene = open
                .iter()
                .any(reader_clip)
                .then(|| (self.scene.width() as usize, self.scene.height() as usize));
            let copies = source_size.0 as usize * source_size.1 as usize * 4
                + clip_scene.map_or(0, |size| {
                    target_size.0 as usize * target_size.1 as usize * 4 + scene_work_bytes(size)
                });
            let scratch = regions
                .iter()
                .map(|r| glass::cpu_work_bytes(r, &params))
                .max()
                .unwrap_or(0);
            self.check_memory(copies.saturating_add(scratch), "glass working set")?;
        }
        let within = glass::clip_within_from_open(open);
        let mut backdrop_src = self.backdrop_layer(base).1.data_as_u8_slice().to_vec();
        for layer in interiors {
            let (origin, paint) = self.backdrop_layer(Some(layer));
            crate::blend::blend_cpu(
                paint.data_as_u8_slice(),
                &mut backdrop_src,
                (source_size.0 as u32, source_size.1 as u32),
                (u32::from(paint.width()), u32::from(paint.height())),
                (origin.0 - source_origin.0, origin.1 - source_origin.1),
                0,
                1.0,
                None,
            );
        }
        let target_w = target_size.0;
        // Rasterize open non-context clip mask once over the union of all chunk outputs.
        let mut union_paints = IRect {
            x0: i32::MAX,
            y0: i32::MAX,
            x1: i32::MIN,
            y1: i32::MIN,
        };
        for r in &regions {
            union_paints.x0 = union_paints.x0.min(origin.0 + r.out_x0);
            union_paints.y0 = union_paints.y0.min(origin.1 + r.out_y0);
            union_paints.x1 = union_paints.x1.max(origin.0 + r.out_x1);
            union_paints.y1 = union_paints.y1.max(origin.1 + r.out_y1);
        }
        let clip_pix = self.rasterize_open_clips(union_paints, open);

        for region in &regions {
            if !coarse && glass::is_plain_box_interior(&params, region, origin) {
                let (_, main_dst) = self.main_mut();
                glass::shade_glass_plain_interior_cpu(
                    main_dst.data_as_u8_slice_mut(),
                    target_w,
                    origin,
                    &backdrop_src,
                    source_size.0,
                    source_size.1,
                    source_origin,
                    frame_size,
                    clip_pix.as_ref().map(Pixmap::data_as_u8_slice),
                    region,
                    within,
                    alpha,
                );
                continue;
            }
            // Rasterize the shape mask, extract output-cropped alpha + downsampled height field,
            // and drop both the RenderContext and full RGBA mask pixmap before building mipmaps.
            let (out_alpha, prepared_height) = {
                let mut mask_ctx = RenderContext::new(region.rw as u16, region.rh as u16);
                let shifted = Affine::translate((-f64::from(region.x0), -f64::from(region.y0))) * device;
                mask_ctx.set_transform(shifted);
                mask_ctx.set_paint(vello_common::color::palette::css::WHITE);
                for (p, even_odd) in paths {
                    mask_ctx.set_fill_rule(if *even_odd { Fill::EvenOdd } else { Fill::NonZero });
                    mask_ctx.fill_path(p);
                }
                mask_ctx.flush();
                let mut mask_pix = Pixmap::new(region.rw as u16, region.rh as u16);
                let settings = RasterizerSettings {
                    render_mode: RenderMode::OptimizeQuality,
                    ..Default::default()
                };
                mask_ctx.render_with(&mut mask_pix, &mut self.resources, settings);
                drop(mask_ctx);
                let mask_bytes = mask_pix.data_as_u8_slice();
                let out_alpha = glass::extract_output_alpha(mask_bytes, region, origin);
                let prepared_height = if coarse {
                    None
                } else {
                    let k = glass::height_scale(params.sigma);
                    let (lw, lh, down) = glass::downsample_mask_cpu(mask_bytes, region.rw, region.rh, k);
                    let height = glass::blur_height_cpu(&down, lw, lh, params.sigma / (k as f32));
                    Some((lw, lh, k, height))
                };
                (out_alpha, prepared_height)
            };

            let (_, main_dst) = self.main_mut();
            if let Some((lw, lh, k, height)) = prepared_height {
                glass::shade_glass_prepared_cpu(
                    main_dst.data_as_u8_slice_mut(),
                    target_w,
                    origin,
                    &backdrop_src,
                    source_size.0,
                    source_size.1,
                    source_origin,
                    frame_size,
                    &out_alpha,
                    lw,
                    lh,
                    k,
                    &height,
                    clip_pix.as_ref().map(Pixmap::data_as_u8_slice),
                    &params,
                    region,
                    within,
                    alpha,
                );
            } else {
                glass::shade_glass_coarse_cpu(
                    main_dst.data_as_u8_slice_mut(),
                    target_w,
                    origin,
                    &backdrop_src,
                    source_size.0,
                    source_size.1,
                    source_origin,
                    frame_size,
                    &out_alpha,
                    clip_pix.as_ref().map(Pixmap::data_as_u8_slice),
                    &params,
                    region,
                    within,
                    alpha,
                );
            }
        }
        Ok(())
    }
    fn background_blur(
        &mut self,
        _key: Option<(u32, usize)>,
        op: &BackgroundBlurOp,
        paths: &[(BezPath, bool)],
        device: Affine,
        _size: [f32; 2],
        alpha: f32,
        _coarse: bool,
        open: &[Open],
    ) -> Result<()> {
        if open.iter().any(|o| matches!(o, Open::Layer)) {
            return Err(EngineError::unsupported(
                "a backdrop reader inside a layer that fades as one",
            ));
        }
        self.flush_barrier(open);
        let scale = device.determinant().abs().sqrt() as f32;
        if !(scale > 0.0 && scale.is_finite()) {
            return Ok(());
        }
        let frame_size = (i32::from(self.frame_size.0), i32::from(self.frame_size.1));
        let (origin, backdrop) = self.readable_backdrop();
        let source = (u32::from(backdrop.width()), u32::from(backdrop.height()));
        let target_size = (source.0 as i32, source.1 as i32);
        let shift = (-origin.0, -origin.1);
        let Some(dirty) = progressive_blur::blur_dirty_rect(paths, device, frame_size, shift, target_size) else {
            return Ok(());
        };
        let bw = (dirty.x1 - dirty.x0) as u32;
        let bh = (dirty.y1 - dirty.y0) as u32;
        if bw > u32::from(u16::MAX) || bh > u32::from(u16::MAX) {
            return Err(EngineError::limit("background blur region exceeds target dimensions"));
        }
        let buf_bytes = bw as usize * bh as usize * 4;
        let sigma = blur::sigma_from_radius(op.radius) * scale;
        let size = (bw, bh);
        if self.memory_budget > 0 {
            self.blur.clear();
            let clip_scene = open
                .iter()
                .any(reader_clip)
                .then(|| (self.scene.width() as usize, self.scene.height() as usize));
            let work = blur::cpu_work_bytes(source, size, sigma);
            self.check_memory(
                reader_copy_bytes(source, clip_scene) + blur_buffer_bytes(size) + work,
                "background blur working set",
            )?;
        }

        let frame_x0 = dirty.x0 + origin.0;
        let frame_y0 = dirty.y0 + origin.1;
        let mask_pix = self.reader_shape_mask(paths, device, (frame_x0, frame_y0), size);

        let paints = IRect {
            x0: frame_x0,
            y0: frame_y0,
            x1: frame_x0 + bw as i32,
            y1: frame_y0 + bh as i32,
        };
        let clip_pix = self.rasterize_open_clips(paints, open);
        let within = glass::clip_within_from_open(open);
        let (clamp_bounds, edge) =
            progressive_blur::blur_bounds_and_edge(within, frame_size, shift, target_size, sigma);
        let spec = blur::BlurSpec {
            sigma,
            edge,
            clamp_bounds,
            dirty,
        };
        let backdrop_src = self.readable_backdrop().1.data_as_u8_slice().to_vec();
        let mut blurred = vec![0u8; buf_bytes];
        self.blur.try_blur(
            self.backdrop_gen,
            &backdrop_src,
            source,
            &mut blurred,
            (bw, bh),
            (dirty.x0, dirty.y0),
            &spec,
        )?;
        let cm = clip_pix.as_ref().map(Pixmap::data_as_u8_slice);
        let target_w = target_size.0;
        self.write_reader_result(|dst| {
            progressive_blur::composite_blurred_cpu(
                dst.data_as_u8_slice_mut(),
                target_w,
                &blurred,
                mask_pix.data_as_u8_slice(),
                cm,
                dirty,
                alpha,
            );
        });
        Ok(())
    }

    fn progressive_blur(
        &mut self,
        _key: (u32, usize),
        op: &ProgressiveBlurOp,
        paths: &[(BezPath, bool)],
        device: Affine,
        size: [f32; 2],
        alpha: f32,
        coarse: bool,
        open: &[Open],
    ) -> Result<()> {
        if open.iter().any(|o| matches!(o, Open::Layer)) {
            return Err(EngineError::unsupported(
                "a backdrop reader inside a layer that fades as one",
            ));
        }
        let scale = device.determinant().abs().sqrt() as f32;
        if !(scale > 0.0 && scale.is_finite()) {
            return Ok(());
        }
        let Some(plan) = progressive_blur::ProgressivePlan::new(op, device, size, scale) else {
            let uniform = BackgroundBlurOp {
                paths: op.paths.clone(),
                even_odd: op.even_odd,
                radius: op.start_radius.max(op.end_radius),
            };
            return self.background_blur(None, &uniform, paths, device, size, alpha, coarse, open);
        };
        self.flush_barrier(open);
        let frame_size = (i32::from(self.frame_size.0), i32::from(self.frame_size.1));
        let (origin, backdrop) = self.readable_backdrop();
        let source = (u32::from(backdrop.width()), u32::from(backdrop.height()));
        let target_size = (source.0 as i32, source.1 as i32);
        let shift = (-origin.0, -origin.1);
        let Some(dirty) = progressive_blur::blur_dirty_rect(paths, device, frame_size, shift, target_size) else {
            return Ok(());
        };
        let bw = (dirty.x1 - dirty.x0) as u32;
        let bh = (dirty.y1 - dirty.y0) as u32;
        if bw > u32::from(u16::MAX) || bh > u32::from(u16::MAX) {
            return Err(EngineError::limit("progressive blur region exceeds target dimensions"));
        }
        let buf_bytes = bw as usize * bh as usize * 4;
        let size = (bw, bh);
        if self.memory_budget > 0 {
            self.blur.clear();
            let clip_scene = open
                .iter()
                .any(reader_clip)
                .then(|| (self.scene.width() as usize, self.scene.height() as usize));
            let work = progressive_blur::cpu_work_bytes(source, size, &plan.stops);
            self.check_memory(
                reader_copy_bytes(source, clip_scene) + blur_buffer_bytes(size) + work,
                "progressive blur working set",
            )?;
        }

        let frame_x0 = dirty.x0 + origin.0;
        let frame_y0 = dirty.y0 + origin.1;
        let mask_pix = self.reader_shape_mask(paths, device, (frame_x0, frame_y0), size);

        let paints = IRect {
            x0: frame_x0,
            y0: frame_y0,
            x1: frame_x0 + bw as i32,
            y1: frame_y0 + bh as i32,
        };
        let clip_pix = self.rasterize_open_clips(paints, open);
        let within = glass::clip_within_from_open(open);
        let max_sigma = plan.start_sigma.max(plan.end_sigma);
        let (clamp_bounds, edge) =
            progressive_blur::blur_bounds_and_edge(within, frame_size, shift, target_size, max_sigma);
        let backdrop_src = self.readable_backdrop().1.data_as_u8_slice().to_vec();
        let mut blurred = vec![0u8; buf_bytes];
        progressive_blur::eval_progressive_cpu(
            &mut self.blur,
            self.backdrop_gen,
            &backdrop_src,
            source,
            clamp_bounds,
            edge,
            dirty,
            origin,
            &plan,
            &mut blurred,
        )?;
        let cm = clip_pix.as_ref().map(Pixmap::data_as_u8_slice);
        let target_w = target_size.0;
        self.write_reader_result(|dst| {
            progressive_blur::composite_blurred_cpu(
                dst.data_as_u8_slice_mut(),
                target_w,
                &blurred,
                mask_pix.data_as_u8_slice(),
                cm,
                dirty,
                alpha,
            );
        });
        Ok(())
    }
}
