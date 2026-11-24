//! The engine, without the WebAssembly boundary (`lib.rs` wraps it): the render graph, the CPU
//! backend and, in the browser build, the GPU backend.

use crate::cpu::Cpu;
use crate::error::{EngineError, ErrorCode, Result};
use crate::exec::{self, DrawStats, Frame, IRect, Pass, Split};
use crate::images;
use crate::limits::Limits;
use crate::masks::MaskStats;
use crate::store::{Applied, Dirty, Store};
use crate::tiles::{Last, TileCache};
use vello_common::kurbo::{Affine, Rect};

/// Where the page is on the device: a page point p lands at `(p × zoom + (x, y)) × dpr`, as the
/// canvas renderer places it (`render.ts`, `place`).
#[derive(Clone, Copy, Debug)]
pub struct Camera {
    pub zoom: f64,
    pub x: f64,
    pub y: f64,
    pub dpr: f64,
}

impl Camera {
    pub fn view(&self) -> Affine {
        let z = self.zoom * self.dpr;
        Affine::new([z, 0.0, 0.0, z, self.x * self.dpr, self.y * self.dpr])
    }
    fn check(&self) -> Result<()> {
        let ok =
            [self.zoom, self.x, self.y, self.dpr].iter().all(|v| v.is_finite()) && self.zoom > 0.0 && self.dpr > 0.0;
        if ok {
            Ok(())
        } else {
            Err(EngineError::malformed("a camera that isn't finite and positive"))
        }
    }
}

/// Straight RGBA floats as premultiplied RGBA8.
pub fn premultiply(c: [f32; 4]) -> [u8; 4] {
    let a = c[3].clamp(0.0, 1.0);
    let q = |v: f32| (v.clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
    [q(c[0] * a), q(c[1] * a), q(c[2] * a), q(a)]
}

/// Premultiplied RGBA8 to straight, in place (as a PNG or `ImageData` holds pixels).
pub fn unpremultiply(px: &mut [u8]) {
    // Fast path: check two pixels (8 bytes) at once so opaque (0xff) and transparent (0x00)
    // spans skip scalar division entirely.
    let (chunks8, rem) = px.as_chunks_mut::<8>();
    for pair in chunks8.iter_mut() {
        let a0 = pair[3];
        let a1 = pair[7];
        if (a0 == 0 || a0 == 255) && (a1 == 0 || a1 == 255) {
            continue;
        }
        if a0 != 0 && a0 != 255 {
            let a = u32::from(a0);
            for c in &mut pair[..3] {
                *c = ((u32::from(*c) * 255 + a / 2) / a).min(255) as u8;
            }
        }
        if a1 != 0 && a1 != 255 {
            let a = u32::from(a1);
            for c in &mut pair[4..7] {
                *c = ((u32::from(*c) * 255 + a / 2) / a).min(255) as u8;
            }
        }
    }
    for p in rem.as_chunks_mut::<4>().0.iter_mut() {
        let a = u32::from(p[3]);
        if a != 0 && a != 255 {
            for c in &mut p[..3] {
                *c = ((u32::from(*c) * 255 + a / 2) / a).min(255) as u8;
            }
        }
    }
}

#[derive(Default, Clone, Copy, Debug)]
pub struct FrameStats {
    pub draw: DrawStats,
    pub masks: MaskStats,
}

/// How a frame made of tiles is asked for (`Engine::render_cpu_tiled`, `Gpu::render`).
#[derive(Clone, Copy, Debug)]
pub struct TiledOptions {
    /// The camera is moving: stand-ins may show, and a zoom draws no tiles of a passing scale.
    pub moving: bool,
    /// Tiles drawn this frame beyond the ones nothing else can stand in for (the CPU's
    /// deterministic budget; the GPU's is in milliseconds).
    pub max_jobs: usize,
    /// Milliseconds the frame may spend drawing tiles (GPU), beyond the ones nothing else can
    /// stand in for. Zero or less: no limit.
    pub budget_ms: f64,
    /// Tiles round the view may be drawn when the budget allows.
    pub prefetch: bool,
}

impl Default for TiledOptions {
    fn default() -> Self {
        Self {
            moving: false,
            max_jobs: usize::MAX,
            budget_ms: 0.0,
            prefetch: true,
        }
    }
}

/// A drag in progress (decision 0040, "Dragging"): the records the last messages only moved.
#[derive(Clone, Debug)]
pub struct Dragging {
    pub ids: Vec<u32>,
    /// Which drag (a new selection is a new drag) and how many moves it has made.
    pub serial: u64,
    pub moves: u64,
    /// The selection's place in paint order, when moving its picture is exact (consecutive
    /// siblings, no readers, no faded ancestor): the page is drawn around it in parts. None: it's
    /// drawn at its real position every frame instead.
    pub split: Option<Split>,
    /// Where it was before the drag began (page units).
    pub start: Option<Rect>,
}

/// A drag as a frame needs it: which, its moves, its split, and where the selection is now and
/// was when it began (page units).
#[derive(Clone, Debug)]
pub struct DragFrame {
    pub serial: u64,
    pub moves: u64,
    pub split: Option<Split>,
    pub now: Rect,
    pub start: Option<Rect>,
}

impl DragFrame {
    pub fn input(&self) -> crate::tiles::DragInput {
        crate::tiles::DragInput {
            serial: self.serial,
            moves: self.moves,
            start: self.start,
            now: self.now,
            eligible: self.split.is_some(),
        }
    }
}

/// What a frame made of tiles did.
#[derive(Default, Clone, Copy, Debug)]
pub struct TiledStats {
    /// Summed over the tiles drawn this frame.
    pub draw: DrawStats,
    pub tiles_drawn: u32,
    /// Tiles the frame shows that are stale or missing: more frames will draw them.
    pub pending: u32,
    /// Exactly what a fresh engine draws: every tile shown up to date and drawn without level
    /// of detail, no stand-in anywhere.
    pub exact: bool,
    /// The frame's tiles didn't fit the budget: drawn one at a time straight into the frame.
    pub direct: bool,
    pub evicted: u32,
    pub held: u32,
    /// Tiles a drag composited (the part below, its selection, the part above): a stand-in.
    pub dragged: u32,
}

/// The CPU's tiles (decision 0040, phase 2): what the tests hold the GPU's tiles to, pixel for
/// pixel, and a Worker could show.
pub struct CpuTiles {
    pub cache: TileCache,
    slots: Vec<Vec<u8>>,
    /// The frame last made, premultiplied RGBA8, and what it was drawn for.
    pub frame: Vec<u8>,
    /// A copy of the frame, the stand-in the next one may draw from.
    frame_last: Vec<u8>,
    last: Option<Last>,
    last_scale: Option<f64>,
}

impl CpuTiles {
    pub fn new(tile: u32, max_slots: usize) -> Self {
        Self {
            cache: TileCache::new(tile, max_slots),
            slots: Vec::new(),
            frame: Vec::new(),
            frame_last: Vec::new(),
            last: None,
            last_scale: None,
        }
    }

    /// Forgets the last frame (it can't stand in for a page it doesn't show).
    pub fn forget(&mut self) {
        self.last = None;
        self.last_scale = None;
        self.frame_last.clear();
    }
}

fn image_level_size(width: u32, height: u32, max_side: u32) -> Result<usize> {
    if width == 0 || height == 0 {
        return Err(EngineError::new(ErrorCode::Image, "an image with no pixels"));
    }
    if width > max_side || height > max_side {
        return Err(EngineError::limit("image exceeds the texture size limit"));
    }
    (width as usize)
        .checked_mul(height as usize)
        .and_then(|pixels| pixels.checked_mul(4))
        .ok_or_else(|| EngineError::limit("image exceeds the address space"))
}

#[cfg(feature = "gpu-common")]
#[derive(Clone, Copy)]
struct HaloCache {
    generation: u64,
    view_bits: [u64; 6],
    size: (u32, u32),
    halo: i32,
}

pub struct Engine {
    pub store: Store,
    /// Changes whenever what's drawn may have (a message applied, an image put or dropped): a
    /// frame made from the last one is valid only within one generation.
    pub generation: u64,
    pub cpu: Cpu,
    /// The band being exported.
    band: Vec<u8>,
    #[cfg(feature = "gpu-common")]
    pub gpu: Option<crate::gpu::Gpu>,
    /// Image uploads kept as levels, so a GPU attached later (or rebuilt after a device loss)
    /// gets them without asking TypeScript again.
    #[cfg(feature = "gpu-common")]
    pub image_levels: std::collections::HashMap<u32, std::rc::Rc<Vec<images::Level>>>,
    /// Tiles on the CPU, once asked for (tests; a Worker's view mode).
    pub cpu_tiles: Option<CpuTiles>,
    /// Cached viewport reader halo for `(generation, view_bits, size)` so idle slices and
    /// composite-only frames never re-walk all 900+ backdrop readers unchanged.
    #[cfg(feature = "gpu-common")]
    halo_cache: Option<HaloCache>,
    /// The view whose apron tiles hit a GPU limit: it settles on the reduced halo frame instead.
    #[cfg(feature = "gpu-common")]
    apron_refused: Option<HaloCache>,
    /// The drag in progress, if the last messages only moved records.
    pub dragging: Option<Dragging>,
    drag_serial: u64,
}

impl Engine {
    pub fn new(limits: Limits) -> Self {
        Self {
            generation: 0,
            band: Vec::new(),
            cpu: Cpu::new(limits.glyph_mask_bytes, limits.glyph_mask_side, limits.memory_bytes),
            store: Store::new(limits),
            #[cfg(feature = "gpu-common")]
            gpu: None,
            #[cfg(feature = "gpu-common")]
            image_levels: std::collections::HashMap::new(),
            cpu_tiles: None,
            #[cfg(feature = "gpu-common")]
            halo_cache: None,
            #[cfg(feature = "gpu-common")]
            apron_refused: None,
            dragging: None,
            drag_serial: 0,
        }
    }

    /// Follows drags: a message that only moves records continues the drag of exactly those
    /// records, or starts one; anything else ends it.
    fn follow_drag(&mut self, applied: &Applied) {
        let Some(ids) = applied.moved.as_ref() else {
            // An edit elsewhere (a collaborator, text re-shaped as its faces arrive) doesn't end
            // a drag: the parts around the selection are drawn again where it changed them (see
            // `invalidate_tiles`). One that changes the structure, or the selection itself, does.
            let keeps = self
                .dragging
                .as_ref()
                .is_some_and(|d| !applied.structural && !applied.touched.iter().any(|t| self.store.within(*t, &d.ids)));
            if !keeps {
                self.dragging = None;
                return;
            }
            // An edit to a record the selection is drawn inside (a board fading as one, say) may
            // change whether moving its picture is exact: the split is decided again, as a new
            // drag (its parts were drawn for the old one).
            let on_path = self.dragging.as_ref().is_some_and(|d| {
                d.split
                    .as_ref()
                    .is_some_and(|s| applied.touched.iter().any(|t| s.path.contains(t)))
            });
            if on_path && let Some(ids) = self.dragging.as_ref().map(|d| d.ids.clone()) {
                let split = self.store.selection(&ids).map(|(parent, first, last, path)| Split {
                    pass: Pass::All,
                    parent,
                    first,
                    last,
                    path,
                });
                self.drag_serial += 1;
                let serial = self.drag_serial;
                if let Some(d) = self.dragging.as_mut() {
                    d.split = split;
                    d.serial = serial;
                }
            }
            return;
        };
        if let Some(d) = self.dragging.as_mut().filter(|d| &d.ids == ids) {
            d.moves += 1;
            return;
        }
        self.drag_serial += 1;
        let split = self.store.selection(ids).map(|(parent, first, last, path)| Split {
            pass: Pass::All,
            parent,
            first,
            last,
            path,
        });
        // Where it was: the changes hold where the moved records painted before and paint now.
        let start = applied.changes.iter().map(|d| d.rect).reduce(|a, b| a.union(b));
        self.dragging = Some(Dragging {
            ids: ids.clone(),
            serial: self.drag_serial,
            moves: 1,
            split,
            start,
        });
    }

    /// The drag as this frame needs it: where its selection is now (including any ancestor
    /// post-effect halo that moves with it).
    pub fn drag_frame(&self) -> Option<DragFrame> {
        let d = self.dragging.as_ref()?;
        let now = d
            .ids
            .iter()
            .filter_map(|id| self.store.dirty_extent(*id))
            .reduce(|a, b| a.union(b))
            .unwrap_or(Rect::ZERO);
        Some(DragFrame {
            serial: d.serial,
            moves: d.moves,
            split: d.split.clone(),
            now,
            start: d.start,
        })
    }

    /// Marks stale every tile, on every backend, that changes reach: each level's tiles under
    /// where the changed records painted before and paint now, grown for anti-aliasing, and
    /// every reader they reach, transitively (`Store::dirty`). A fresh list drops them all, and
    /// the last frame with them: it shows a page that's gone.
    fn invalidate_tiles(&mut self, changes: &[Dirty], full: bool, drag_parts: bool) {
        self.invalidate_tiles_at(changes, full, drag_parts, None, false);
    }

    /// `refine`: an image has another resolution now, not other content (a sharper level
    /// arrived, or one was dropped): tiles drawn with it still stand in, never exact
    /// (`TileCache::refine`), and nothing is noted as changed.
    fn invalidate_tiles_at(
        &mut self,
        changes: &[Dirty],
        full: bool,
        drag_parts: bool,
        at: Option<&dyn Fn(f64) -> bool>,
        refine: bool,
    ) {
        // Another resolution of an image, or an image loaded where its placeholder was
        // (`Dirty::refine`), isn't a change: what was drawn before stands in (`TileCache::refine`).
        let (soft, strict): (Vec<Dirty>, Vec<Dirty>) = if refine {
            (changes.to_vec(), Vec::new())
        } else {
            changes.iter().copied().partition(|d| d.refine)
        };
        // What changed, in page units, for the last frame shown (`TileCache::note_changed`),
        // whatever levels the cache holds. An image change counts at the scale the last frame was
        // drawn at only if the level drawn there changed.
        let changed = if full || strict.is_empty() {
            Vec::new()
        } else {
            self.store.dirty(&strict, Affine::IDENTITY, 1.5)
        };
        let store = &mut self.store;
        let mut each = |cache: &mut TileCache| {
            if full {
                cache.clear();
                return;
            }
            if changes.is_empty() {
                return;
            }
            for (id, level) in cache.levels() {
                if at.is_some_and(|select| !select(level.scale)) {
                    continue;
                }
                // Soft first: a tile both reach is stale.
                for (set, stale) in [(&soft, false), (&strict, true)] {
                    if set.is_empty() {
                        continue;
                    }
                    let rects: Vec<Rect> = store.dirty(set, level.grid(), 1.5);
                    if stale {
                        cache.invalidate(id, &rects);
                    } else {
                        cache.refine(id, &rects);
                    }
                    // An edit beside a drag: its parts around the selection are drawn again there.
                    if drag_parts {
                        cache.drag_invalidate(id, &rects);
                    }
                }
            }
            if at.is_none() && store.provisional_shown().is_none() {
                cache.invalidate_inexact_full();
            }
        };

        if let Some(t) = self.cpu_tiles.as_mut() {
            each(&mut t.cache);
            if full {
                t.forget();
            } else if at.is_none() {
                t.cache.note_changed(&changed);
            }
        }
        #[cfg(feature = "gpu-common")]
        if let Some(g) = self.gpu.as_mut() {
            each(&mut g.tiles);
            // As the cache's inexact tiles above: a sliced frame's are drawn again.
            if !full && !changes.is_empty() && at.is_none() && store.provisional_shown().is_none() {
                g.direct_slices_drop_inexact();
            }
            if full {
                g.forget_last();
            } else if let Some(last) = g.last()
                && at.is_none_or(|select| select(last.view.as_coeffs()[0]))
            {
                g.tiles.note_changed(&changed);
            }
            if full
                || drag_parts && at.is_none_or(|select| g.last().is_some_and(|last| select(last.view.as_coeffs()[0])))
            {
                g.forget_motion_prefix();
            }
        }
    }

    /// Keeps tiles on the CPU of `tile` device pixels a side, at most `max_slots` at once.
    pub fn use_cpu_tiles(&mut self, tile: u32, max_slots: usize) {
        self.cpu_tiles = Some(CpuTiles::new(tile, max_slots));
    }

    pub fn clear_view_caches(&mut self) {
        self.cpu.clear_view_caches();
        if let Some(tiles) = self.cpu_tiles.as_mut() {
            tiles.cache.clear();
            tiles.forget();
            tiles.slots = Vec::new();
            tiles.frame = Vec::new();
            tiles.frame_last = Vec::new();
        }
        #[cfg(feature = "gpu-common")]
        if let Some(gpu) = self.gpu.as_mut() {
            gpu.clear_view_caches();
        }
    }

    pub fn limits(&self) -> &Limits {
        &self.store.limits
    }

    pub fn apply(&mut self, bytes: &[u8]) -> Result<Applied> {
        #[cfg(feature = "compute")]
        let before = self.store.revision;
        let applied = self.store.apply(bytes)?;
        if applied.noop {
            // Nothing changed: no frame needs drawing again, and a drag goes on.
            #[cfg(feature = "compute")]
            if let Some(gpu) = self.gpu.as_mut() {
                gpu.compute_applied(before, &self.store, &applied, self.generation);
            }
            return Ok(applied);
        }
        self.generation += 1;
        self.invalidate_tiles(&applied.changes, applied.full, applied.moved.is_none());
        self.follow_drag(&applied);
        #[cfg(feature = "compute")]
        if let Some(gpu) = self.gpu.as_mut() {
            gpu.compute_applied(before, &self.store, &applied, self.generation);
        }
        Ok(applied)
    }

    /// Marks stale what shows image `id` (its pixels are about to change or go).
    fn invalidate_image(&mut self, id: u32) {
        let users = self.store.image_users(id);
        if !users.is_empty() {
            self.invalidate_tiles(&users, false, true);
        }
    }

    pub fn put_image(&mut self, id: u32, width: u32, height: u32, rgba: &[u8], premultiplied: bool) -> Result<()> {
        let limits = self.store.limits;
        // Refused before anything is copied or levels are made: its size, and the budget.
        if width == 0 || height == 0 || rgba.len() != width as usize * height as usize * 4 {
            return Err(EngineError::new(ErrorCode::Image, "image bytes don't match its size"));
        }
        if width > limits.texture_side || height > limits.texture_side {
            return Err(EngineError::limit(format!(
                "an image {width} × {height}; the longest side allowed is {}",
                limits.texture_side
            )));
        }
        let held = self.cpu.image_bytes() - self.cpu.held_image(id);
        if held + images::levels_bytes(width, height) > limits.image_bytes {
            return Err(EngineError::limit(format!(
                "an image {width} × {height} takes {} MiB with its levels; images may hold {} MiB",
                images::levels_bytes(width, height).div_ceil(1 << 20),
                limits.image_bytes >> 20
            )));
        }
        #[cfg(feature = "gpu-common")]
        if let Some(gpu) = self.gpu.as_ref() {
            gpu.check_texture_size(width, height, "an image")?;
        }
        let levels = images::levels(width, height, rgba, premultiplied, limits.texture_side)?;
        // GPU admission can fail independently of the CPU image cap. Commit neither
        // backend's new copy until the GPU has accepted the upload.
        #[cfg(feature = "gpu-common")]
        if let Some(gpu) = self.gpu.as_mut() {
            gpu.put_image(id, &levels, limits.image_bytes)?;
        }
        self.cpu.put_image(id, &levels, limits.image_bytes)?;
        #[cfg(feature = "gpu-common")]
        self.image_levels.insert(id, std::rc::Rc::new(levels));
        self.generation += 1;
        self.invalidate_image(id);
        Ok(())
    }

    /// An upload invalidates the cached scales whose sampler now chooses different pixels.
    fn image_levels_changed(
        &mut self,
        id: u32,
        before: &[(u32, u32)],
        after: &[(u32, u32)],
        replaced: Option<(u32, u32)>,
    ) {
        if before == after && replaced.is_none() {
            return;
        }
        let users = self.store.image_users(id);
        if users.is_empty() {
            return;
        }
        let spans = self.store.image_spans(id);
        let both_axes = self.store.view_images;
        let at = |scale| {
            spans.iter().any(|&(x, y)| {
                let span = (x * scale, if both_axes { y * scale } else { 0.0 });
                let selected = |levels: &[(u32, u32)]| levels.get(images::pick(levels.iter().copied(), span)).copied();
                let old = selected(before);
                let new = selected(after);
                old != new || replaced.is_some_and(|size| new == Some(size))
            })
        };
        // A frame no slot can hold, drawn over several frames at rest (`Gpu::direct_slices_scale`),
        // keeps no tiles to mark: where the level its scale picks changed, the tiles it has drawn
        // are drawn again (`TileCache::note_refined`; not a change, so never a hole).
        #[cfg(feature = "gpu-common")]
        if self.gpu.as_ref().and_then(|g| g.direct_slices_scale()).is_some_and(at) {
            let page = self.store.dirty(&users, Affine::IDENTITY, 1.5);
            if let Some(g) = self.gpu.as_mut() {
                g.tiles.note_refined(&page);
            }
        }
        // A level no sampler picks at any scale drawn or being drawn (one warmed ahead of a
        // zoom, say) changes nothing drawn: work in progress keeps going instead of starting over.
        if self.view_scales().is_some_and(|scales| !scales.into_iter().any(at)) {
            return;
        }
        self.generation += 1;
        // A level of a size the image didn't have (or one dropped) is the same picture at another
        // resolution; one replaced at a size it had may be other content.
        self.invalidate_tiles_at(&users, false, true, Some(&at), replaced.is_none());
    }

    /// The scales at which a view draws or keeps anything (tiles' levels, the frame shown), when
    /// it's made of tiles; None for frames drawn afresh, which any change may concern.
    fn view_scales(&self) -> Option<Vec<f64>> {
        let mut scales = Vec::new();
        let mut tiled = false;
        if let Some(t) = self.cpu_tiles.as_ref() {
            scales.extend(t.cache.levels().iter().map(|(_, l)| l.scale));
            tiled = true;
        }
        #[cfg(feature = "gpu-common")]
        if let Some(g) = self.gpu.as_ref() {
            scales.extend(g.scales_in_use()?);
            tiled = true;
        }
        tiled.then_some(scales)
    }

    pub fn put_cpu_image_level(&mut self, id: u32, width: u32, height: u32, rgba: &[u8]) -> Result<()> {
        let bytes = image_level_size(width, height, self.store.limits.texture_side)?;
        if bytes != rgba.len() {
            return Err(EngineError::new(ErrorCode::Image, "image bytes don't match its size"));
        }
        let held = self.cpu.image_bytes() - self.cpu.image_level_bytes(id, width);
        if held.saturating_add(bytes) > self.store.limits.image_bytes {
            return Err(EngineError::limit("images over their budget"));
        }
        let before = self.cpu.image_sizes(id);
        self.cpu.put_image_level(id, width, height, rgba);
        let after = self.cpu.image_sizes(id);
        let replaced = before.contains(&(width, height)).then_some((width, height));
        self.image_levels_changed(id, &before, &after, replaced);
        Ok(())
    }

    /// `put_gpu_image_level` in row strips over frames (`Gpu::put_image_bitmap_rows`): the level
    /// changes what's drawn once its last rows are in.
    #[cfg(all(target_arch = "wasm32", feature = "gpu-common"))]
    pub fn put_gpu_image_rows(&mut self, id: u32, bitmap: &web_sys::ImageBitmap, y: u32, rows: u32) -> Result<()> {
        let gpu = self
            .gpu
            .as_mut()
            .ok_or_else(|| EngineError::new(ErrorCode::State, "no GPU attached"))?;
        image_level_size(bitmap.width(), bitmap.height(), self.store.limits.texture_side)?;
        let size = (bitmap.width(), bitmap.height());
        let before = gpu.image_sizes(id);
        if gpu.put_image_bitmap_rows(id, bitmap, y, rows, self.store.limits.image_bytes)? {
            let after = gpu.image_sizes(id);
            let replaced = before.contains(&size).then_some(size);
            self.image_levels_changed(id, &before, &after, replaced);
        } else if y == 0 && before.contains(&size) {
            // The level it replaces went with the first rows: drawn with the others meanwhile.
            let after = gpu.image_sizes(id);
            self.image_levels_changed(id, &before, &after, None);
        }
        Ok(())
    }

    #[cfg(all(target_arch = "wasm32", feature = "gpu-common"))]
    pub fn put_gpu_image_level(&mut self, id: u32, bitmap: &web_sys::ImageBitmap) -> Result<()> {
        let gpu = self
            .gpu
            .as_mut()
            .ok_or_else(|| EngineError::new(ErrorCode::State, "no GPU attached"))?;
        image_level_size(bitmap.width(), bitmap.height(), self.store.limits.texture_side)?;
        let size = (bitmap.width(), bitmap.height());
        let before = gpu.image_sizes(id);
        gpu.put_image_bitmap(id, bitmap, self.store.limits.image_bytes)?;
        let after = gpu.image_sizes(id);
        let replaced = before.contains(&size).then_some(size);
        self.image_levels_changed(id, &before, &after, replaced);
        Ok(())
    }

    pub fn drop_image_level(&mut self, id: u32, width: u32) {
        let before = self.cpu.image_sizes(id);
        self.cpu.drop_image_level(id, width);
        self.image_levels_changed(id, &before, &self.cpu.image_sizes(id), None);
        #[cfg(feature = "gpu-common")]
        if let Some(gpu) = self.gpu.as_mut() {
            let before = gpu.image_sizes(id);
            gpu.drop_image_level(id, width);
            let after = gpu.image_sizes(id);
            self.image_levels_changed(id, &before, &after, None);
        }
    }

    pub fn drop_image(&mut self, id: u32) {
        self.generation += 1;
        self.invalidate_image(id);
        self.cpu.drop_image(id);
        #[cfg(feature = "gpu-common")]
        {
            self.image_levels.remove(&id);
            if let Some(gpu) = self.gpu.as_mut() {
                gpu.drop_image(id);
            }
        }
    }

    /// Refuses a page holding a shown record the engine doesn't draw, wherever it is: the caller
    /// draws the whole page another way.
    /// Refuses an export while any shown record is provisional (display list 1.1, flag 8: its
    /// text still loading, drawn as placeholder bars): an export is exact or isn't made, so it
    /// waits for the list that has the text. Wherever the record is, in the crop or not: the list
    /// isn't the document yet.
    pub fn check_settled(&self) -> Result<()> {
        match self.store.provisional_shown() {
            Some(id) => Err(EngineError::new(
                ErrorCode::State,
                format!("record {id} is provisional (its text is still loading): an export waits for it"),
            )),
            None => Ok(()),
        }
    }

    pub fn check_supported(&self) -> Result<()> {
        match self.store.refusal() {
            Some((id, bits)) => Err(EngineError::unsupported(format!(
                "record {id} needs features {bits:#x}; the page is drawn another way"
            ))),
            None => Ok(()),
        }
    }

    /// Bytes the engine holds, roughly: the graph, images (on the CPU) and glyph masks.
    pub fn held_bytes(&self) -> usize {
        self.store.bytes() + self.cpu.image_bytes() + self.cpu.masks.stats.bytes
    }

    /// Rows a band of a frame `width` wide may have: `Limits::band_rows`, and no more than
    /// `Limits::band_bytes` of output.
    pub fn band_rows(&self, width: u32) -> u32 {
        let l = &self.store.limits;
        let by_bytes = (l.band_bytes / (width.max(1) as usize * 4)).max(1);
        l.band_rows.min(by_bytes as u32).max(1)
    }

    /// Estimates the peak extra transient working set needed by visible shadows, layer blurs, and
    /// isolated offscreen scopes on an export tile of `cols` x `tile_rows` (which already includes
    /// export backdrop-reader halos), and validates that no visible blur exceeds `MAX_BLUR_SIGMA`
    /// or `Limits::texture_side`. Propagates expanded offscreen dimensions through nested blur
    /// scopes so stacked blurs and shadows inside blurred containers are admitted accurately.
    fn export_effect_working_set(&self, cols: usize, tile_rows: usize, view: Affine) -> Result<usize> {
        let view_scale = view.determinant().abs().sqrt();
        let max_tex = self.store.limits.texture_side as usize;
        let mut peak_total = 0usize;
        let mut expanded_reader_work = 0usize;
        // Stack entries: (id, parent_world, cur_cols, cur_rows, live_iso_bytes).
        let mut stack: Vec<(u32, Affine, usize, usize, usize)> =
            vec![(crate::store::ROOT, Affine::IDENTITY, cols, tile_rows, 0)];
        while let Some((id, parent_world, cur_cols, cur_rows, live_iso)) = stack.pop() {
            let Some(node) = self.store.nodes.get(&id) else {
                continue;
            };
            let r = &node.record;
            if id != crate::store::ROOT && r.hidden() {
                continue;
            }
            let world = if id == crate::store::ROOT {
                parent_world
            } else {
                parent_world * r.transform
            };
            let cur_tile_bytes = cur_cols.saturating_mul(cur_rows).saturating_mul(4);
            let has_post = id != crate::store::ROOT && !r.post_effects.is_empty();
            let through = id != crate::store::ROOT
                && !has_post
                && r.blend == 0
                && r.isolate()
                && r.opacity < 1.0
                && self.store.subtree_has_blend(id);
            let mut next_cols = cur_cols;
            let mut next_rows = cur_rows;
            let mut next_iso = live_iso;
            if has_post {
                enum StepKind {
                    Blur {
                        sigma: f32,
                        src_pad: usize,
                        grow_pad: usize,
                    },
                    Noise,
                    Texture {
                        src_pad: usize,
                        grow_pad: usize,
                    },
                }
                let mut active_steps: Vec<StepKind> = Vec::with_capacity(r.post_effects.len());
                let mut total_pad = 0usize;
                let mut max_step = 4usize;
                let mut has_noise = false;
                let device = view * world;
                let inv = (device.determinant().abs() > 1e-300).then(|| device.inverse());
                for pe in &r.post_effects {
                    match *pe {
                        crate::record::PostEffect::LayerBlur { radius } => {
                            let sigma = (f64::from(crate::blur::sigma_from_radius(radius)) * view_scale) as f32;
                            if sigma < 1e-4 {
                                continue;
                            }
                            crate::blur::validate_sigma(
                                sigma,
                                IRect {
                                    x0: 0,
                                    y0: 0,
                                    x1: cur_cols.max(1) as i32,
                                    y1: cur_rows.max(1) as i32,
                                },
                                crate::blur::EdgeMode::Zero,
                            )?;
                            let pad = crate::shadow::blur_support_pad(sigma) as usize;
                            total_pad = total_pad.saturating_add(pad);
                            if sigma > crate::blur::DIRECT_SIGMA_MAX {
                                let (lvl, _) = crate::blur::choose_level(sigma, crate::blur::MAX_PYRAMID_LEVELS);
                                max_step = max_step.max(1usize << lvl.min(8));
                            }
                            active_steps.push(StepKind::Blur {
                                sigma,
                                src_pad: pad,
                                grow_pad: pad,
                            });
                        }
                        crate::record::PostEffect::Noise { size, density, .. } => {
                            if size > 0.0 && density > 0.0 {
                                let Some(dev_to_layer) = inv else {
                                    continue;
                                };
                                let uv_scale =
                                    crate::noise::PIXELS_PER_UNIT / (f64::from(size) * crate::noise::NOISE_TILE as f64);
                                let coeffs = (Affine::scale(uv_scale) * dev_to_layer).as_coeffs();
                                if !uv_scale.is_finite() || coeffs.iter().any(|c| !(*c as f32).is_finite()) {
                                    return Err(EngineError::limit("noise scale exceeds finite coordinate bounds"));
                                }
                                has_noise = true;
                                active_steps.push(StepKind::Noise);
                            }
                        }
                        crate::record::PostEffect::Texture {
                            size,
                            radius,
                            clip_to_shape,
                        } => {
                            let Some(dev_to_layer) = inv else {
                                continue;
                            };
                            let radius_dev = (f64::from(radius) * view_scale) as f32;
                            if size > 0.0 && radius_dev >= 1e-4 {
                                if !radius_dev.is_finite() || radius_dev > max_tex as f32 {
                                    return Err(EngineError::limit("texture radius exceeds finite target bounds"));
                                }
                                crate::exec::validate_texture_lattice(
                                    IRect {
                                        x0: 0,
                                        y0: 0,
                                        x1: cur_cols.max(1) as i32,
                                        y1: cur_rows.max(1) as i32,
                                    },
                                    dev_to_layer,
                                    size,
                                )?;
                                let pad = (radius_dev.ceil() as usize).saturating_add(2);
                                total_pad = total_pad.saturating_add(pad);
                                active_steps.push(StepKind::Texture {
                                    src_pad: pad,
                                    grow_pad: if clip_to_shape { 0 } else { pad },
                                });
                            }
                        }
                    }
                }
                if !active_steps.is_empty() {
                    let (content_w, content_h) = if let (Some(bounds), page_pad) = self.store.bounds_and_pad(id) {
                        let inner_pad = (page_pad - r.post_pad()).max(0.0);
                        let inner_pad_dev = if inner_pad > 0.0 {
                            inner_pad * view_scale + 2.0
                        } else {
                            0.0
                        };
                        let dev_box = device.transform_rect_bbox(bounds).inflate(inner_pad_dev, inner_pad_dev);
                        let ir = IRect::around(dev_box).inflate(2, 2);
                        ((ir.x1 - ir.x0).max(1) as usize, (ir.y1 - ir.y0).max(1) as usize)
                    } else {
                        (cur_cols, cur_rows)
                    };
                    let raw_w = content_w.min(cur_cols.saturating_add(total_pad.saturating_mul(2)));
                    let raw_h = content_h.min(cur_rows.saturating_add(total_pad.saturating_mul(2)));
                    let src_w = raw_w.next_multiple_of(max_step);
                    let src_h = raw_h.next_multiple_of(max_step);
                    if src_w > max_tex || src_h > max_tex {
                        return Err(EngineError::limit(format!(
                            "post-effect source {src_w} x {src_h} px exceeds maximum target size {max_tex} px"
                        )));
                    }
                    let src_bytes = src_w.saturating_mul(src_h).saturating_mul(4);
                    let src_scene = crate::cpu::scene_estimate_bytes(src_w as u32, src_h as u32);
                    // Walk the ordered post chain mirroring `exec.rs` so multi-step chains account
                    // for coexisting halo-expanded intermediate buffers (`prev_bytes + step_bytes`).
                    let total_steps = active_steps.len();
                    let mut rem_pads = vec![0usize; total_steps];
                    let mut suffix = 0usize;
                    for i in (0..total_steps).rev() {
                        rem_pads[i] = suffix;
                        let sp = match active_steps[i] {
                            StepKind::Blur { src_pad, .. } | StepKind::Texture { src_pad, .. } => src_pad,
                            StepKind::Noise => 0,
                        };
                        suffix = suffix.saturating_add(sp);
                    }
                    let noise_extra = if has_noise {
                        crate::noise::NOISE_WORKING_SET_BYTES
                    } else {
                        0
                    };
                    let blend_extra = if r.blend != 0 { cur_tile_bytes } else { 0 };
                    // Peak during child rendering into `src_area`:
                    peak_total = peak_total.max(
                        live_iso
                            .saturating_add(src_bytes)
                            .saturating_add(src_scene)
                            .saturating_add(noise_extra),
                    );
                    let mut prev_size = (src_w as u32, src_h as u32);
                    let mut prev_bytes = src_bytes;
                    let mut grown = 0usize;
                    for (idx, step) in active_steps.iter().enumerate() {
                        let gp = match *step {
                            StepKind::Blur { grow_pad, .. } | StepKind::Texture { grow_pad, .. } => grow_pad,
                            StepKind::Noise => 0,
                        };
                        grown = grown.saturating_add(gp);
                        let (step_w, step_h) = if idx + 1 == total_steps {
                            (cur_cols, cur_rows)
                        } else {
                            let rem = rem_pads[idx];
                            let rw = content_w
                                .saturating_add(grown.saturating_mul(2))
                                .min(cur_cols.saturating_add(rem.saturating_mul(2)));
                            let rh = content_h
                                .saturating_add(grown.saturating_mul(2))
                                .min(cur_rows.saturating_add(rem.saturating_mul(2)));
                            let sw = rw.next_multiple_of(max_step);
                            let sh = rh.next_multiple_of(max_step);
                            if sw > max_tex || sh > max_tex {
                                return Err(EngineError::limit(format!(
                                    "post-effect intermediate {sw} x {sh} px exceeds maximum target size {max_tex} px"
                                )));
                            }
                            (sw, sh)
                        };
                        let step_bytes = step_w.saturating_mul(step_h).saturating_mul(4);
                        let step_size = (step_w as u32, step_h as u32);
                        let scratch_extra = match *step {
                            StepKind::Blur { sigma, .. } => crate::blur::cpu_work_bytes(prev_size, step_size, sigma),
                            _ => 0,
                        };
                        let step_need = live_iso
                            .saturating_add(prev_bytes)
                            .saturating_add(step_bytes)
                            .saturating_add(scratch_extra)
                            .saturating_add(noise_extra)
                            .saturating_add(if idx + 1 == total_steps { blend_extra } else { 0 });
                        peak_total = peak_total.max(step_need);
                        prev_bytes = step_bytes;
                        prev_size = step_size;
                    }
                    next_cols = src_w;
                    next_rows = src_h;
                    next_iso = live_iso.saturating_add(src_bytes).saturating_add(src_scene);
                } else if r.blend != 0 {
                    next_iso = live_iso
                        .saturating_add(cur_tile_bytes)
                        .saturating_add(crate::cpu::scene_estimate_bytes(cur_cols as u32, cur_rows as u32));
                    peak_total = peak_total.max(next_iso.saturating_add(cur_tile_bytes));
                }
            } else if id != crate::store::ROOT
                && (r.blend != 0 || through || (r.isolate() && r.opacity < 1.0 && self.store.subtree_has_pass(id)))
            {
                next_iso = live_iso
                    .saturating_add(cur_tile_bytes)
                    .saturating_add(crate::cpu::scene_estimate_bytes(cur_cols as u32, cur_rows as u32));
                let blend_extra = if r.blend != 0 || through { cur_tile_bytes } else { 0 };
                peak_total = peak_total.max(next_iso.saturating_add(blend_extra));
            }
            let next_tile_bytes = next_cols.saturating_mul(next_rows).saturating_mul(4);
            let next_scene_bytes = crate::cpu::scene_estimate_bytes(next_cols as u32, next_rows as u32);
            for op in &r.ops {
                match op {
                    crate::record::Op::Fill { blend, .. } | crate::record::Op::Stroke { blend, .. } if *blend != 0 => {
                        let blend_need = next_iso
                            .saturating_add(next_tile_bytes.saturating_mul(2))
                            .saturating_add(next_scene_bytes);
                        peak_total = peak_total.max(blend_need);
                    }
                    crate::record::Op::DropShadow { blur, blend, .. }
                    | crate::record::Op::InnerShadow { blur, blend, .. } => {
                        let shadow_iso = if *blend != 0 {
                            let b_iso = next_iso
                                .saturating_add(next_tile_bytes)
                                .saturating_add(next_scene_bytes);
                            peak_total = peak_total.max(b_iso.saturating_add(next_tile_bytes));
                            b_iso
                        } else {
                            next_iso
                        };
                        let sigma = crate::blur::sigma_from_radius(*blur) * view_scale as f32;
                        crate::blur::validate_sigma(
                            sigma,
                            IRect {
                                x0: 0,
                                y0: 0,
                                x1: next_cols.max(1) as i32,
                                y1: next_rows.max(1) as i32,
                            },
                            crate::blur::EdgeMode::Zero,
                        )?;
                        if crate::blur::kernel_radius(sigma) > 0 {
                            let pad = crate::shadow::blur_support_pad(sigma) as usize;
                            let shift = crate::shadow::shadow_raster_shift(sigma);
                            let s = 1usize << shift;
                            let mw = (next_cols.saturating_add(pad.saturating_mul(2))).div_ceil(s);
                            let mh = (next_rows.saturating_add(pad.saturating_mul(2))).div_ceil(s);
                            if mw > max_tex || mh > max_tex {
                                return Err(EngineError::limit(format!(
                                    "shadow mask {mw} x {mh} px exceeds maximum target size {max_tex} px"
                                )));
                            }
                            let mask_b = mw.saturating_mul(mh).saturating_mul(4);
                            let shadow_need = shadow_iso
                                .saturating_add(mask_b.saturating_mul(3))
                                .saturating_add(crate::cpu::scene_estimate_bytes(mw as u32, mh as u32))
                                .saturating_add(next_tile_bytes);
                            peak_total = peak_total.max(shadow_need);
                        }
                    }
                    crate::record::Op::Children => {
                        let has_pic_mask = node.children.iter().any(|c| {
                            self.store
                                .nodes
                                .get(c)
                                .is_some_and(|n| !n.record.hidden() && n.record.is_picture_mask())
                        });
                        let child_iso = if has_pic_mask {
                            let mask_iso = next_iso
                                .saturating_add(next_tile_bytes.saturating_mul(2))
                                .saturating_add(next_scene_bytes);
                            peak_total = peak_total.max(mask_iso.saturating_add(next_tile_bytes));
                            mask_iso
                        } else {
                            next_iso
                        };
                        for &c in &node.children {
                            stack.push((c, world, next_cols, next_rows, child_iso));
                        }
                    }
                    crate::record::Op::BackgroundBlur(_) | crate::record::Op::ProgressiveBlur(_)
                        if next_cols > cols || next_rows > tile_rows =>
                    {
                        // A layer effect can expand the source beyond the halo-grown export tile.
                        // In that case reserve the blur scratch and copies for the expanded scope.
                        let source = (next_cols as u32, next_rows as u32);
                        let device = view * world;
                        let scale = device.determinant().abs().sqrt() as f32;
                        let copies = crate::cpu::reader_copy_bytes(source, source, Some((next_cols, next_rows)));
                        expanded_reader_work = expanded_reader_work
                            .max(copies.saturating_add(exec::background_reader_work_bytes(op, source, source, scale)));
                    }
                    _ => {}
                }
            }
        }
        // A paired picture keeps the other plane live while one plane runs a post step.
        // This bound also covers shared per-target clip masks and the paired mask picture.
        if !self.store.readers().is_empty() || self.store.has_context() {
            peak_total = peak_total.saturating_mul(2);
        }
        Ok(peak_total.saturating_add(expanded_reader_work))
    }

    /// Maximum aggregate per-pass pixels (`tiles × pass_pixels`) allowed for a single banded
    /// export, enforced even when `Limits::memory_bytes == 0` (browser builds) so huge enclosing
    /// blurs or halos return a typed `ErrorCode::Limit` immediately instead of running into a
    /// watchdog timeout.
    const MAX_EXPORT_WORK_PIXELS: u64 = 1_000_000_000;

    #[allow(clippy::too_many_arguments)]
    fn check_export_work(
        &self,
        width: u32,
        height: u32,
        rows: u32,
        tile: u64,
        effects: usize,
        diamond: usize,
        readers: u64,
    ) -> Result<()> {
        // Tiling repeats halo and effect work. Bound that work separately from the peak
        // allocation, which only accounts for one tile at a time (and is disabled when
        // `Limits::memory_bytes == 0` in browser builds).
        let tiles =
            u64::from(width.div_ceil(self.store.limits.export_tile.max(1))) * u64::from(height.div_ceil(rows.max(1)));
        let pass_pixels = (tile
            .saturating_add(effects as u64)
            .saturating_add(diamond as u64)
            .saturating_add(readers))
            / 4;
        if tiles.saturating_mul(pass_pixels) > Self::MAX_EXPORT_WORK_PIXELS {
            return Err(EngineError::limit(
                "this export needs too much rendering work at this scale",
            ));
        }
        Ok(())
    }

    /// Refuses an export of a `width` × `height` frame before it starts when its total banded
    /// rendering work exceeds `MAX_EXPORT_WORK_PIXELS` (for all builds, including browser builds
    /// with `Limits::memory_bytes == 0`), or when its working set wouldn't fit beside what the
    /// engine holds under `Limits::memory_bytes` (when non-zero, as in Worker builds). The working
    /// set is a band of output, a tile of target (with the readers' reach round it), the scene's
    /// rows, peak shadow/isolated offscreen passes, and the compressor.
    pub fn admit_export(&self, width: u32, height: u32, camera: Camera) -> Result<()> {
        self.plan_export_rows(width, height, camera, self.band_rows(width), false)
            .map(|_| ())
    }

    /// Chooses an output band height before the first PNG byte. Shorter bands draw exactly the
    /// same pixels and keep large exports at their requested resolution when possible.
    pub(crate) fn export_rows(&self, width: u32, height: u32, camera: Camera, requested: u32) -> Result<u32> {
        self.plan_export_rows(width, height, camera, requested, true)
    }

    fn plan_export_rows(&self, width: u32, height: u32, camera: Camera, requested: u32, adaptive: bool) -> Result<u32> {
        self.check_size(width, height)?;
        camera.check()?;
        self.check_supported()?;
        self.check_settled()?;
        let limits = &self.store.limits;
        let mut rows = requested.clamp(1, self.band_rows(width)).min(height);
        let view = camera.view();
        let halo = self.export_halo(view, width, height)? as usize;
        let cols = (limits.export_tile.max(1).min(width) as usize + 2 * halo).min(width as usize);
        let budget = limits.memory_bytes;
        let scene = crate::cpu::scene_work_bytes((width as usize, height as usize)) as u64;
        let held = self.held_bytes() as u64;
        let runtime_headroom = if adaptive {
            (budget - crate::cpu::runtime_memory_cap(budget)) as u64
        } else {
            0
        };
        let minimum = if adaptive { rows.min(32) } else { rows };
        loop {
            let tile_rows = (rows as usize + 2 * halo).min(height as usize);
            let effects = self.export_effect_working_set(cols, tile_rows, view)?;
            let tile = cols as u64 * tile_rows as u64 * 4;
            let readers = self.export_reader_working_set(width, height, view, (cols, tile_rows));
            let diamond = self.export_diamond_bytes(width, height, view, cols, tile_rows);
            if budget == 0 {
                self.check_export_work(width, height, rows, tile, effects, diamond, readers)?;
                return Ok(rows);
            }
            let band = u64::from(rows) * u64::from(width) * 4;
            let draw = band + tile + scene + effects as u64 + diamond as u64 + readers;
            // PNG encoding follows drawing. A high-entropy band can grow the outgoing buffer
            // while its old allocation and the uncompressed band are still live.
            let encode = 4 * band + 2 * tile + scene;
            // Drawing must also fit the CPU's runtime guard. The second tile in the physical
            // budget covers target replacement, outside the guarded effect passes.
            let need = (draw + tile.max(runtime_headroom)).max(encode) + (512 << 10);
            if held + need <= budget as u64 {
                self.check_export_work(width, height, rows, tile, effects, diamond, readers)?;
                return Ok(rows);
            }
            if rows <= minimum {
                return Err(EngineError::limit(format!(
                    "an export {width} × {height} px needs {} MiB beside the {} MiB the engine holds; it may hold {} MiB",
                    need.div_ceil(1 << 20),
                    held.div_ceil(1 << 20),
                    budget >> 20,
                )));
            }
            rows = (rows / 2).max(minimum);
        }
    }

    fn export_reader_working_set(&self, width: u32, height: u32, view: Affine, tile: (usize, usize)) -> u64 {
        let frame = Frame {
            width: width as u16,
            height: height as u16,
            view,
            detail: false,
            area: IRect {
                x0: 0,
                y0: 0,
                x1: width as i32,
                y1: height as i32,
            },
        };
        let metrics = exec::export_plan_metrics(&self.store, &frame, tile);
        if !metrics.has_readers && !metrics.needs_backdrop {
            return 0;
        }
        let clip_scene = metrics.has_clipped_reader.then_some((width as usize, height as usize));
        let tile_size = (tile.0 as u32, tile.1 as u32);
        let copies = crate::cpu::reader_copy_bytes(tile_size, tile_size, clip_scene);
        let target_bytes = tile.0 as u64 * tile.1 as u64 * 4;
        target_bytes * (usize::from(metrics.needs_backdrop) + metrics.max_iso_surfaces) as u64
            + copies as u64
            + metrics.max_reader_work_bytes as u64
            + (3 << 20)
    }

    /// Upper bound on retained temporary diamond-gradient raster bytes for one export tile of
    /// `cols × tile_rows` device pixels.
    fn export_diamond_bytes(&self, width: u32, height: u32, view: Affine, cols: usize, tile_rows: usize) -> usize {
        use crate::record::{GradientKind, Op, Paint};
        let frame_rect = IRect {
            x0: 0,
            y0: 0,
            x1: width as i32,
            y1: height as i32,
        };
        let mut total = 0usize;
        let mut stack = vec![(crate::store::ROOT, Affine::IDENTITY)];
        let glyph_bounds = |g: u32| self.store.glyphs.get(g).and_then(|glyph| glyph.bounds);
        while let Some((id, parent_world)) = stack.pop() {
            let Some(node) = self.store.nodes.get(&id) else {
                continue;
            };
            let world = if id == crate::store::ROOT {
                parent_world
            } else {
                if node.record.hidden() {
                    continue;
                }
                parent_world * node.record.transform
            };
            if id != crate::store::ROOT {
                let device = view * world;
                if device.determinant().abs() >= 1e-300 {
                    for op in &node.record.ops {
                        let (path, pad, paint) = match op {
                            Op::Fill { path, paint, .. } => (*path, 0.0, paint),
                            Op::Stroke { path, style, paint, .. } => {
                                if style.width <= 0.0 {
                                    continue;
                                }
                                (*path, exec::stroke_paint_reach(style), paint)
                            }
                            _ => continue,
                        };
                        let Paint::Gradient(g) = paint else {
                            continue;
                        };
                        if g.kind != GradientKind::Diamond
                            || g.matrix.determinant().abs() < 1e-12
                            || (device * g.matrix).determinant().abs() < 1e-300
                        {
                            continue;
                        }
                        let local = node
                            .record
                            .entry_bounds(path, &glyph_bounds)
                            .map(|b| if pad > 0.0 { b.inflate(pad, pad) } else { b });
                        let clipped = exec::diamond_device_rect(local, device, frame_rect);
                        if clipped.is_empty() {
                            continue;
                        }
                        let w = ((clipped.x1 - clipped.x0) as usize).min(cols);
                        let h = ((clipped.y1 - clipped.y0) as usize).min(tile_rows);
                        total = total.saturating_add(w.saturating_mul(h).saturating_mul(4));
                    }
                }
            }
            for &child in &node.children {
                stack.push((child, world));
            }
        }
        total
    }

    fn check_size(&self, width: u32, height: u32) -> Result<()> {
        let max = self.store.limits.texture_side;
        if width == 0 || height == 0 {
            return Err(EngineError::malformed("a frame with no pixels"));
        }
        if width > max || height > max {
            return Err(EngineError::limit(format!(
                "a frame {width} × {height} px; the longest side the engine draws is {max} px"
            )));
        }
        Ok(())
    }

    /// Draws the whole frame on the CPU into `out` (premultiplied RGBA8, `width` x `height`).
    ///
    /// When `Limits::memory_bytes` is non-zero (Worker builds or an explicit memory cap), admits
    /// the frame upfront and renders in bounded horizontal bands/tiles directly into `out` so a
    /// single output buffer is held (never duplicating the framebuffer beside a full-frame target
    /// or full-frame offscreen effect buffers), returning `ErrorCode::Limit` cleanly if the frame
    /// and its band working set cannot fit instead of trapping Wasm.
    pub fn render_cpu_into(
        &mut self,
        out: &mut Vec<u8>,
        width: u32,
        height: u32,
        camera: Camera,
        background: [f32; 4],
        detail: bool,
    ) -> Result<FrameStats> {
        self.store.begin_stroke_frame();
        self.check_size(width, height)?;
        camera.check()?;
        self.check_supported()?;
        let frame_bytes = (width as usize)
            .checked_mul(height as usize)
            .and_then(|n| n.checked_mul(4))
            .ok_or_else(|| EngineError::limit("frame pixel buffer overflow"))?;
        let budget = self.store.limits.memory_bytes;
        if budget == 0 {
            let (stats, _) = self.cpu_tile(
                width,
                height,
                camera,
                background,
                detail,
                IRect {
                    x0: 0,
                    y0: 0,
                    x1: width as i32,
                    y1: height as i32,
                },
                false,
                0,
            )?;
            out.clear();
            out.extend_from_slice(self.cpu.target.data_as_u8_slice());
            return Ok(stats);
        }

        // Bounded path: drop stale scratch buffers before checking admission so prior renders do
        // not inflate Wasm linear memory.
        out.clear();
        if out.capacity() != frame_bytes {
            out.shrink_to_fit();
        }
        self.band.clear();
        self.band.shrink_to_fit();
        self.cpu.shrink_target();

        let view = camera.view();
        let halo = self.export_halo(view, width, height)? as usize;
        let scene_bytes = crate::cpu::scene_estimate_bytes(width, height);
        let held = self.held_bytes();
        // Match `Cpu::check_memory`'s headroom for Wasm static data, stack, allocator overhead,
        // and transient `vello_cpu` strip buffers.
        let cap = crate::cpu::runtime_memory_cap(budget);

        let mut band_h = self.band_rows(width).min(128).min(height).max(1);
        let chosen_rows = loop {
            let cols = (self.store.limits.export_tile.max(1).min(width) as usize + 2 * halo).min(width as usize);
            let tile_rows = (band_h as usize + 2 * halo).min(height as usize);
            let effects = self.export_effect_working_set(cols, tile_rows, view)?;
            let diamond = self.export_diamond_bytes(width, height, view, cols, tile_rows);
            let tile_bytes = cols.saturating_mul(tile_rows).saturating_mul(4);
            let need = frame_bytes as u64
                + tile_bytes as u64
                + scene_bytes as u64
                + effects as u64
                + diamond as u64
                + self.export_reader_working_set(width, height, view, (cols, tile_rows));
            if held as u64 + need <= cap as u64 {
                break band_h;
            }
            if band_h <= 32 {
                return Err(EngineError::limit(format!(
                    "CPU render {width} x {height} px needs {} MiB beside the {} MiB held; limit is {} MiB",
                    need.div_ceil(1 << 20),
                    held.div_ceil(1 << 20),
                    budget >> 20
                )));
            }
            band_h = (band_h / 2).max(32);
        };

        out.resize(frame_bytes, 0);
        let stride = width as usize * 4;
        let mut total_stats = FrameStats::default();
        let res = (|| -> Result<()> {
            let mut y0 = 0u32;
            while y0 < height {
                let rows = chosen_rows.min(height - y0);
                let mut x0 = 0u32;
                while x0 < width {
                    let cols = self.store.limits.export_tile.max(1).min(width - x0);
                    let area = IRect {
                        x0: x0 as i32,
                        y0: y0 as i32,
                        x1: (x0 + cols) as i32,
                        y1: (y0 + rows) as i32,
                    };
                    let (tile_stats, grown) =
                        self.cpu_tile(width, height, camera, background, detail, area, true, out.capacity())?;
                    total_stats.draw.add(&tile_stats.draw);
                    total_stats.masks = tile_stats.masks;
                    let tw = (grown.x1 - grown.x0) as usize * 4;
                    let px = self.cpu.target.data_as_u8_slice();
                    let n = cols as usize * 4;
                    let x_off = (x0 as i32 - grown.x0) as usize * 4;
                    let y_off = (y0 as i32 - grown.y0) as usize;
                    for r in 0..rows as usize {
                        let from = (y_off + r) * tw + x_off;
                        let to = (y0 as usize + r) * stride + x0 as usize * 4;
                        out[to..to + n].copy_from_slice(&px[from..from + n]);
                    }
                    x0 += cols;
                }
                y0 += rows;
            }
            Ok(())
        })();
        if let Err(e) = res {
            out.clear();
            out.shrink_to_fit();
            self.cpu.shrink_target();
            return Err(e);
        }
        Ok(total_stats)
    }

    /// Draws the whole frame on the CPU: premultiplied RGBA8, `width` × `height`.
    pub fn render_cpu(
        &mut self,
        width: u32,
        height: u32,
        camera: Camera,
        background: [f32; 4],
        detail: bool,
    ) -> Result<(&[u8], FrameStats)> {
        self.store.begin_stroke_frame();
        if self.store.limits.memory_bytes > 0 {
            let mut buf = std::mem::take(&mut self.band);
            let res = self.render_cpu_into(&mut buf, width, height, camera, background, detail);
            self.band = buf;
            let stats = res?;
            return Ok((self.band.as_slice(), stats));
        }
        self.check_size(width, height)?;
        camera.check()?;
        self.check_supported()?;
        let (stats, _) = self.cpu_tile(
            width,
            height,
            camera,
            background,
            detail,
            IRect {
                x0: 0,
                y0: 0,
                x1: width as i32,
                y1: height as i32,
            },
            false,
            0,
        )?;
        Ok((self.cpu.target.data_as_u8_slice(), stats))
    }

    /// Attaches a GPU, uploading the images already held so it can draw everything at once.
    #[cfg(feature = "gpu-common")]
    pub fn attach_gpu(&mut self, mut gpu: crate::gpu::Gpu) -> Result<()> {
        let budget = self.store.limits.image_bytes;
        gpu.budget = self.store.limits.gpu_bytes;
        for (id, levels) in &self.image_levels {
            gpu.put_image(*id, levels, budget)?;
        }
        self.gpu = Some(gpu);
        Ok(())
    }

    #[cfg(feature = "gpu-common")]
    fn cached_halo(&mut self, view: Affine, size: (u32, u32)) -> Result<i32> {
        let view_bits = view.as_coeffs().map(f64::to_bits);
        if let Some(c) = self.halo_cache
            && c.generation == self.generation
            && c.view_bits == view_bits
            && c.size == size
        {
            return Ok(c.halo);
        }
        let rect = Rect::new(0.0, 0.0, f64::from(size.0), f64::from(size.1));
        let halo = self.halo_for_rect(view, rect)?;
        self.halo_cache = Some(HaloCache {
            generation: self.generation,
            view_bits,
            size,
            halo,
        });
        Ok(halo)
    }

    /// Draws tiles on the GPU for the next frame of the view last drawn, for at most
    /// `budget_ms` (`Gpu::ahead`): what a browser runs between frames at rest.
    #[cfg(feature = "gpu-common")]
    pub fn render_gpu_ahead(&mut self, background: [f32; 4], budget_ms: f64) -> Result<DrawStats> {
        self.store.begin_stroke_frame();
        self.check_supported()?;
        let gpu = self
            .gpu
            .as_mut()
            .ok_or_else(|| EngineError::new(ErrorCode::State, "no GPU attached"))?;
        // A whole frame being drawn over slices: the next slice.
        if gpu.has_pending_whole() {
            return gpu.ahead_whole(&self.store, background, self.generation, budget_ms);
        }
        let Some(last) = gpu.last() else {
            return Ok(DrawStats::default());
        };
        let halo = match self.cached_halo(last.view, last.size) {
            Ok(h) => h,
            // A view drawn as whole frames: no tiles of its own to draw ahead, only the overview.
            Err(e) if e.code == ErrorCode::Limit => {
                let gpu = self
                    .gpu
                    .as_mut()
                    .ok_or_else(|| EngineError::new(ErrorCode::State, "no GPU attached"))?;
                return gpu.ahead_overview(&self.store, background, self.generation, budget_ms);
            }
            Err(e) => return Err(e),
        };
        let gpu = self
            .gpu
            .as_mut()
            .ok_or_else(|| EngineError::new(ErrorCode::State, "no GPU attached"))?;
        match gpu.ahead(&self.store, background, self.generation, halo, budget_ms) {
            // An apron tile too large for this GPU: the next frame settles without aprons.
            Err(e) if e.code == ErrorCode::Limit && i64::from(halo) > i64::from(self.store.limits.halo) => {
                self.apron_refused = Some(HaloCache {
                    generation: self.generation,
                    view_bits: last.view.as_coeffs().map(f64::to_bits),
                    size: last.size,
                    halo,
                });
                self.halo_cache = None;
                Ok(DrawStats::default())
            }
            r => r,
        }
    }

    /// Draws a frame on the GPU, made of tiles (into its canvas, when it has one).
    #[cfg(feature = "gpu-common")]
    pub fn render_gpu(
        &mut self,
        width: u32,
        height: u32,
        camera: Camera,
        background: [f32; 4],
        options: TiledOptions,
        editor_viewport: bool,
    ) -> Result<DrawStats> {
        self.store.begin_stroke_frame();
        self.check_size(width, height)?;
        camera.check()?;
        self.check_supported()?;
        let (replay_limit, cached_gpu_halo, max_apron) = {
            let gpu = self
                .gpu
                .as_ref()
                .ok_or_else(|| EngineError::new(ErrorCode::State, "no GPU attached"))?;
            (gpu.halo_replay_limit(), gpu.tiles.halo(), gpu.max_view_apron())
        };
        let view = camera.view();
        let frame_rect = Rect::new(0.0, 0.0, f64::from(width), f64::from(height));
        let drag = self.drag_frame();
        let simple_reader_drag =
            options.moving && drag.as_ref().is_some_and(|d| d.split.is_none()) && self.store.nodes.len() <= 512;
        let composite_only = options.budget_ms < 0.0;
        let reuse_moving_halo = options.moving
            && options.budget_ms > 0.0
            && !simple_reader_drag
            && !self.store.readers().is_empty()
            && cached_gpu_halo > 0;
        // Interactive moving frames and composite-only presents stay on cached/coarse tiles
        // without baking exact haloed tiles: reuse the active tile cache halo in O(1) instead of
        // re-walking all backdrop readers on every motion frame.
        let view_bits = view.as_coeffs().map(f64::to_bits);
        let unverified_halo = (composite_only || reuse_moving_halo)
            && !self.store.readers().is_empty()
            && !self.halo_cache.is_some_and(|c| {
                c.generation == self.generation
                    && c.view_bits == view_bits
                    && c.size == (width, height)
                    && c.halo == cached_gpu_halo
            });
        let (halo_opt, mut halo_plan) = if composite_only || reuse_moving_halo {
            (Some(cached_gpu_halo), None)
        } else {
            let plan_viewport = editor_viewport
                && !self.store.has_context()
                && !(options.moving && options.budget_ms > 0.0 && !simple_reader_drag);
            if !plan_viewport
                && let Some(c) = self.halo_cache
                && c.generation == self.generation
                && c.view_bits == view_bits
                && c.size == (width, height)
            {
                (Some(c.halo), None)
            } else {
                let (reach, _, halo_plan) = self.reader_halo_plan(view, Some(frame_rect), plan_viewport, replay_limit);
                let apron = (plan_viewport && !options.moving)
                    .then(|| self.rest_apron(halo_plan.as_ref(), reach, (width, height), view_bits, max_apron))
                    .flatten();
                let halo_opt = self.limit_halo(reach).ok().or(apron);
                if let Some(halo) = halo_opt {
                    self.halo_cache = Some(HaloCache {
                        generation: self.generation,
                        view_bits,
                        size: (width, height),
                        halo,
                    });
                }
                (halo_opt, halo_plan)
            }
        };
        let frame = Frame {
            width: width as u16,
            height: height as u16,
            view,
            detail: false,
            area: IRect {
                x0: 0,
                y0: 0,
                x1: width as i32,
                y1: height as i32,
            },
        };
        let prefix = if simple_reader_drag && options.budget_ms > 0.0 {
            self.dragging.as_ref().and_then(|d| {
                let kids = &self.store.nodes.get(&crate::store::ROOT)?.children;
                // The prefix must end at a root sibling boundary before every edited
                // record and before any effect can require a live backdrop plane.
                if self.store.has_context() || kids.iter().any(|id| self.store.nodes[id].record.is_mask()) {
                    return None;
                }
                if !d.ids.iter().all(|id| kids.contains(id)) {
                    return None;
                }
                let cut = kids
                    .iter()
                    .position(|id| d.ids.contains(id) || self.store.subtree_has_pass(*id))?;
                (cut != 0).then_some((d.serial, cut))
            })
        } else {
            None
        };
        let gpu = self
            .gpu
            .as_mut()
            .ok_or_else(|| EngineError::new(ErrorCode::State, "no GPU attached"))?;
        // One pass avoids rasterizing the same reader and prefix in each touched tile. For
        // interactive drags bound the scene walk. Dense pages use their retained tiles.
        // Apron tiles chosen at rest are the exact route: a whole pass would only fall back to
        // the reduced halo frame, so it is skipped at every budget, unbounded draws included.
        let apron_chosen =
            !options.moving && halo_opt.is_some_and(|h| i64::from(h) > i64::from(self.store.limits.halo));
        let whole =
            !composite_only && !apron_chosen && halo_opt != Some(0) && (options.budget_ms == 0.0 || simple_reader_drag);
        let whole_stats = if whole {
            let mut result = gpu.render_whole(
                &self.store,
                &frame,
                background,
                self.generation,
                options.moving,
                prefix,
                halo_plan.as_ref(),
            );
            if prefix.is_some() && result.as_ref().is_err_and(|e| e.code == ErrorCode::Limit) {
                result = gpu.render_whole(
                    &self.store,
                    &frame,
                    background,
                    self.generation,
                    options.moving,
                    None,
                    halo_plan.as_ref(),
                );
            }
            match result {
                Ok(stats) => Some(stats),
                Err(e) if e.code == ErrorCode::Limit && halo_opt.is_some() => None,
                Err(e) => return Err(e),
            }
        } else {
            None
        };
        // A view at rest drawn as a whole frame draws it over slices (`Gpu::render_whole_sliced`),
        // never all at once in a frame with a budget.
        let sliced = !options.moving && options.budget_ms > 0.0;
        let shown_halo = if composite_only {
            gpu.present_sliced_frame(&self.store, view, (width, height), self.generation, background)
        } else {
            None
        };
        let showed_halo = shown_halo.is_some();
        let mut stats = if let Some(stats) = whole_stats {
            stats
        } else if let Some(shown) = shown_halo {
            shown?
        } else if let Some(halo) = halo_opt {
            match gpu.render(
                &self.store,
                &frame,
                background,
                self.generation,
                halo,
                options,
                drag.as_ref(),
            ) {
                Ok(stats) => stats,
                // Apron tiles too large for this GPU's memory: the view settles on the reduced
                // halo frame (not exact) and stops trying aprons until it changes.
                Err(e)
                    if e.code == ErrorCode::Limit
                        && i64::from(halo) > i64::from(self.store.limits.halo)
                        && halo_plan.is_some() =>
                {
                    self.apron_refused = Some(HaloCache {
                        generation: self.generation,
                        view_bits: view.as_coeffs().map(f64::to_bits),
                        size: (width, height),
                        halo,
                    });
                    self.halo_cache = None;
                    let gpu = self.gpu.as_mut().expect("GPU attached");
                    if sliced {
                        gpu.render_whole_sliced(
                            &self.store,
                            &frame,
                            background,
                            self.generation,
                            halo_plan.take(),
                            options.budget_ms,
                        )?
                    } else {
                        gpu.render_whole(
                            &self.store,
                            &frame,
                            background,
                            self.generation,
                            options.moving,
                            None,
                            halo_plan.as_ref(),
                        )?
                    }
                }
                Err(e) => return Err(e),
            }
        } else if composite_only || (options.moving && options.budget_ms > 0.0) {
            // Moving and composite-only frames stay on coarse tiles within the frame budget. A
            // tile that hits a backend limit (an oversized glass chunk at 25,600%, say) makes
            // `Gpu::render` present a stand-in from the last frame rather than this frame running
            // an unbudgeted whole-view halo replay.
            gpu.render(
                &self.store,
                &frame,
                background,
                self.generation,
                i32::try_from(self.store.limits.halo.max(1)).unwrap_or(i32::MAX),
                options,
                drag.as_ref(),
            )?
        } else if sliced {
            gpu.render_whole_sliced(
                &self.store,
                &frame,
                background,
                self.generation,
                halo_plan.take(),
                options.budget_ms,
            )?
        } else {
            gpu.render_whole(
                &self.store,
                &frame,
                background,
                self.generation,
                options.moving,
                None,
                halo_plan.as_ref(),
            )?
        };
        // A cached halo may describe an earlier camera. Validate the current one before
        // calling the frame exact, even if all its tiles are already at the current scale.
        // (A reduced reader-halo frame shown again was drawn for this camera.)
        if unverified_halo && !showed_halo {
            stats.exact = false;
            stats.standin = true;
            stats.pending = stats.pending.max(1);
        }
        // No frame is exact while text is still to come: it may paint past its box.
        if stats.exact && self.store.provisional_shown().is_some() {
            stats.exact = false;
            stats.standin = true;
        }
        Ok(stats)
    }

    #[cfg(feature = "compute")]
    pub fn stage_compute(
        &mut self,
        width: u32,
        height: u32,
        camera: Camera,
        background: [f32; 4],
    ) -> Result<Option<crate::gpu::ComputeCheck>> {
        let Some(frame) = self.compute_frame(width, height, camera)? else {
            return Ok(None);
        };
        let gpu = self.gpu.as_mut().expect("routed to compute");
        match gpu.stage_compute(&self.store, &frame, background, self.generation) {
            Ok(check) => Ok(Some(check)),
            Err(error) => {
                gpu.disable_compute(error.message.clone());
                if error.code == ErrorCode::DeviceLost {
                    Err(error)
                } else {
                    Ok(None)
                }
            }
        }
    }

    /// Draws and presents a compute frame through the bump gate (`Gpu::present_compute`): its
    /// stats and its check; `Stage` to stage instead (no frame of this size to keep) or to draw
    /// with vello_gpu (not routed, or compute is off: `compute_reason` says which); or `Busy`.
    /// A failed draw turns compute off; only a lost device comes back as an error.
    #[cfg(feature = "compute")]
    pub fn present_compute(
        &mut self,
        width: u32,
        height: u32,
        camera: Camera,
        background: [f32; 4],
    ) -> Result<crate::gpu::GatePresent> {
        let Some(frame) = self.compute_frame(width, height, camera)? else {
            return Ok(crate::gpu::GatePresent::Stage);
        };
        let gpu = self.gpu.as_mut().expect("routed to compute");
        match gpu.present_compute(&self.store, &frame, background, self.generation) {
            Ok(drawn) => Ok(drawn),
            Err(error) => {
                gpu.disable_compute(error.message.clone());
                if error.code == ErrorCode::DeviceLost {
                    Err(error)
                } else {
                    Ok(crate::gpu::GatePresent::Stage)
                }
            }
        }
    }

    /// The frame for a compute draw of this view, or `None` when it isn't routed to compute: no
    /// GPU, compute off, past 4096 px, not an ordinary page, or text still provisional.
    #[cfg(feature = "compute")]
    fn compute_frame(&mut self, width: u32, height: u32, camera: Camera) -> Result<Option<Frame>> {
        self.store.begin_stroke_frame();
        self.check_size(width, height)?;
        camera.check()?;
        self.check_supported()?;
        let Some(gpu) = self.gpu.as_mut() else {
            return Ok(None);
        };
        if !gpu.compute_ordinary
            || gpu.compute_reason.is_some()
            || !gpu.supports_compute()
            || width > 4096
            || height > 4096
        {
            return Ok(None);
        }
        let revision = self.store.revision;
        let ordinary = gpu
            .ordinary_revision
            .filter(|(cached, _)| *cached == revision)
            .map_or_else(
                || {
                    let ordinary = crate::ordinary::is_ordinary_page(&self.store);
                    gpu.ordinary_revision = Some((revision, ordinary));
                    ordinary
                },
                |(_, ordinary)| ordinary,
            );
        if !ordinary || self.store.provisional_shown().is_some() {
            return Ok(None);
        }
        Ok(Some(Frame {
            width: width as u16,
            height: height as u16,
            view: camera.view(),
            detail: false,
            area: IRect {
                x0: 0,
                y0: 0,
                x1: width as i32,
                y1: height as i32,
            },
        }))
    }

    /// Longest geometric backdrop-dependency reach across all visible readers on the page:
    /// disjoint readers take their maximum reach rather than summing, and glass never feeds into
    /// later readers (decision 0007).
    pub fn halo(&self, view: Affine) -> Result<i32> {
        self.limit_halo(
            self.reader_halo_plan(view, None, false, crate::halo::HALO_REPLAY_SIDE)
                .0,
        )
    }

    /// Longest geometric backdrop-dependency reach affecting `crop` (in device pixels): unrelated
    /// readers outside `crop` (that don't transitively feed a reader overlapping `crop`) never
    /// inflate an export's halo.
    pub fn halo_for_rect(&self, view: Affine, crop: Rect) -> Result<i32> {
        self.limit_halo(
            self.reader_halo_plan(view, Some(crop), false, crate::halo::HALO_REPLAY_SIDE)
                .0,
        )
    }

    /// The tile apron an editor view at rest bakes with when its readers reach past the band
    /// halo (decision 0040, 2026-11-23): their whole device-resolution reach, so the settled
    /// frame is exact. None where one native pass of the padded view is the exact route
    /// (`Gpu::prefers_padded_view`, the same check `render_whole` draws by), where one padded tile
    /// would not fit `max_apron`, or where this view's apron tiles already hit a GPU limit; the
    /// view then keeps the reduced halo frame, which is not exact. Exports keep `Limits::halo`.
    #[cfg(feature = "gpu-common")]
    fn rest_apron(
        &self,
        plan: Option<&crate::halo::ViewportHaloPlan>,
        reach: f64,
        size: (u32, u32),
        view_bits: [u64; 6],
        max_apron: i32,
    ) -> Option<i32> {
        let refused = self
            .apron_refused
            .is_some_and(|c| c.generation == self.generation && c.view_bits == view_bits && c.size == size);
        let gpu = self.gpu.as_ref()?;
        let native_fits = plan.is_none_or(|p| gpu.prefers_padded_view(p, size, self.store.limits.padded_view_pixels));
        (!refused && !native_fits && reach <= f64::from(max_apron)).then(|| reach.ceil() as i32)
    }

    fn limit_halo(&self, total: f64) -> Result<i32> {
        if total > f64::from(self.store.limits.halo) {
            return Err(EngineError::limit(format!(
                "backdrop readers reach {total:.0} px past a band; the most is {}",
                self.store.limits.halo
            )));
        }
        Ok(total.ceil() as i32)
    }

    /// Band halo for exports into a `width` × `height` frame. Enclosing post-effects
    /// (layer blur, texture) can extend the required tile halo past `Limits::halo` while
    /// clamping to the frame bounds and keeping `Limits::halo` enforced on the reader-only
    /// reach. Total banded work is still bounded by `MAX_EXPORT_WORK_PIXELS` across all builds
    /// (including browser exports with `Limits::memory_bytes == 0`), while `Limits::memory_bytes`
    /// additionally bounds peak memory in Worker builds (`memory_bytes > 0`).
    fn export_halo(&self, view: Affine, width: u32, height: u32) -> Result<i32> {
        let crop = Rect::new(0.0, 0.0, f64::from(width), f64::from(height));
        let (total, reader_only, _) = self.reader_halo_plan(view, Some(crop), false, crate::halo::HALO_REPLAY_SIDE);
        self.limit_halo(reader_only)?;
        if !total.is_finite() {
            return self.limit_halo(total);
        }
        Ok(total.min(f64::from(width.max(height))).ceil() as i32)
    }

    /// Dependency reach `(total, reader_only, halo_plan)` outside a view, with an optional
    /// divisor-aware viewport halo plan.
    fn reader_halo_plan(
        &self,
        view: Affine,
        crop: Option<Rect>,
        plan_viewport: bool,
        replay_limit: u32,
    ) -> (f64, f64, Option<crate::halo::ViewportHaloPlan>) {
        if self.store.readers().is_empty() {
            return (0.0, 0.0, None);
        }
        enum ReaderKind {
            Glass,
            Read,
            UniformBlur {
                sigma: f32,
            },
            ProgressiveBlur {
                lo: f32,
                hi: f32,
                plan: Option<crate::progressive_blur::ProgressivePlan>,
            },
        }
        struct ReaderNode {
            key: (u32, usize),
            paint: Rect,
            read: Rect,
            reach_px: f64,
            post_reach_px: f64,
            writes_backdrop: bool,
            kind: ReaderKind,
            spatial_post_overflow: bool,
            paint_order: usize,
            unfilled_clip: Option<[f32; 4]>,
        }
        let view_scale = view.determinant().abs().sqrt();
        let max_side = f64::from(self.store.limits.texture_side);
        fn paint_alpha_visible(paint: &crate::record::Paint, alpha: f32) -> bool {
            match paint {
                crate::record::Paint::Solid(c) => c[3] * alpha >= 0.03,
                crate::record::Paint::Gradient(g) => {
                    !g.stops.is_empty() && g.stops.iter().any(|(_, c)| c[3] * alpha >= 0.03)
                }
                crate::record::Paint::Image(img) => img.opacity * alpha >= 0.03,
                crate::record::Paint::Placeholder(o) => *o * alpha >= 0.03,
            }
        }
        #[inline(never)]
        fn entry_feature_px(
            store: &Store,
            r: &crate::record::Record,
            path_idx: u32,
            paint: &crate::record::Paint,
            stroke_width: Option<f32>,
            device: Affine,
            det_scale: f32,
        ) -> Option<(Rect, f32)> {
            let entry = r.paths.get(path_idx as usize)?;
            let local_b = r.entry_bounds(path_idx, &|g| store.glyphs.bounds(g))?;
            let dev_b = if let Some(sw) = stroke_width {
                device.transform_rect_bbox(local_b.inflate(f64::from(sw), f64::from(sw)))
            } else {
                device.transform_rect_bbox(local_b)
            };
            if dev_b.width() <= 0.0 && dev_b.height() <= 0.0 {
                return None;
            }
            let mut feat = if let Some(sw) = stroke_width {
                if sw <= 0.0 {
                    return None;
                }
                sw * det_scale
            } else {
                match entry {
                    crate::record::PathEntry::Rect { w, h, .. }
                    | crate::record::PathEntry::Ellipse { w, h }
                    | crate::record::PathEntry::Box { w, h, .. }
                    | crate::record::PathEntry::Oval { w, h, .. } => w.min(*h) * det_scale,
                    crate::record::PathEntry::Glyphs { scale, glyphs } => {
                        let glyph_h = glyphs
                            .iter()
                            .find_map(|g| store.glyphs.bounds(g.glyph).map(|b| b.height() as f32))
                            .filter(|&h| h > 0.0)
                            .unwrap_or(1000.0);
                        glyph_h * *scale * 0.14 * det_scale
                    }
                    crate::record::PathEntry::Path(compact) => {
                        let b = compact.bounds()?;
                        let span = b.width().min(b.height()) as f32;
                        if span <= 0.0 {
                            return None;
                        }
                        let factor = if compact.len() > 6 { 0.25 } else { 1.0 };
                        span * factor * det_scale
                    }
                    crate::record::PathEntry::Outside(_) => return None,
                }
            };
            if stroke_width.is_none()
                && let crate::record::Paint::Image(img) = paint
            {
                let img_span = (device * img.matrix).determinant().abs().sqrt() as f32;
                if img_span > 0.0 && img_span.is_finite() {
                    feat = feat.min((img_span / 64.0).max(1.0));
                }
            }
            (feat > 0.0 && feat.is_finite()).then_some((dev_b, feat))
        }
        /// Spatial post-effect reach (LayerBlur, Texture) for enclosing scopes, whether a spatial
        /// post-effect overflows, and the record's widest layer-blur sigma. Noise is pointwise and
        /// adds zero reach. A viewport plan (`plan_viewport`) takes any finite layer-blur sigma
        /// (the GPU view pyramid has no sigma cap) and adds exec.rs's 4 px padded-output rounding
        /// and pyramid-alignment slack so coarse captures and native samples cover the full
        /// post-effect `src_area`. Export plans keep the native sigma limit and its refusals.
        #[inline(never)]
        fn post_effect_reach(
            r: &crate::record::Record,
            view_scale: f64,
            max_side: f64,
            plan_viewport: bool,
        ) -> (f64, bool, f32) {
            let mut reach = 0.0f64;
            let mut max_step = 4i32;
            let mut overflow = false;
            let mut max_lb_sigma = 0.0f32;
            for pe in &r.post_effects {
                match *pe {
                    crate::record::PostEffect::LayerBlur { radius } if radius > 0.0 => {
                        let sigma = (f64::from(crate::blur::sigma_from_radius(radius)) * view_scale) as f32;
                        if plan_viewport {
                            if !sigma.is_finite() {
                                overflow = true;
                            } else if sigma >= 1e-4 {
                                max_lb_sigma = max_lb_sigma.max(sigma);
                                reach += f64::from(crate::shadow::blur_support_pad_view(sigma))
                                    .max(f64::from(crate::blur::blur_reach_view(sigma)));
                                if sigma > crate::blur::DIRECT_SIGMA_MAX {
                                    let (lvl, _) = crate::blur::choose_level_view(sigma);
                                    max_step = max_step.max(crate::blur::level_step(lvl));
                                }
                            }
                        } else if !sigma.is_finite() || sigma > crate::blur::MAX_BLUR_SIGMA {
                            overflow = true;
                            if sigma >= 1e-4 {
                                reach += f64::from(crate::shadow::blur_support_pad(sigma))
                                    .max(f64::from(crate::blur::blur_reach(sigma)));
                            }
                        } else if sigma >= 1e-4 {
                            reach += f64::from(crate::shadow::blur_support_pad(sigma))
                                .max(f64::from(crate::blur::blur_reach(sigma)));
                        }
                    }
                    crate::record::PostEffect::Texture { size, radius, .. } if size > 0.0 && radius > 0.0 => {
                        let radius_dev = f64::from(radius) * view_scale;
                        if !radius_dev.is_finite() || radius_dev > max_side {
                            overflow = true;
                            if !plan_viewport && radius_dev >= 1e-4 {
                                reach += f64::from((radius_dev.ceil() as i32).saturating_add(2));
                            }
                        } else if radius_dev >= 1e-4 {
                            reach += f64::from((radius_dev.ceil() as i32).saturating_add(2));
                        }
                    }
                    _ => {}
                }
            }
            if plan_viewport && reach > 0.0 {
                reach += f64::from(max_step) + 8.0;
            }
            (reach, overflow, max_lb_sigma)
        }
        /// A layer blur too wide for a native device-resolution scope around readers: past the
        /// native pyramid, or a wide uniform-class blur reaching over 1,024 px.
        fn wide_layer_blur(sigma: f32, reach: f64) -> bool {
            sigma > crate::blur::MAX_BLUR_SIGMA || (sigma >= crate::blur::VIEWPORT_HALO_MIN_SIGMA && reach > 1024.0)
        }
        /// The outermost wide layer-blur scope around some readers (case L3): its blur runs in
        /// the far tier and the native pass upsamples the captured result.
        struct CoarsePostCandidate {
            id: u32,
            max_lb_sigma: f32,
            own_post_reach: f64,
            content_bbox: Rect,
            last_reader: usize,
        }
        let mut candidates: Vec<CoarsePostCandidate> = Vec::new();
        // For each reader node, the coarse post scope it sits in.
        let mut node_scope: Vec<Option<usize>> = Vec::new();
        let overlaps = |a: Rect, b: Rect| a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1;
        let cache = self.store.reader_cache();
        let mut nodes = Vec::with_capacity(cache.visible_readers.len());
        for (idx, cr) in cache.visible_readers.iter().enumerate() {
            let device = view * cr.world;
            if !device.as_coeffs().iter().all(|v| v.is_finite()) {
                continue;
            }
            let [a, b, c, d, _, _] = device.as_coeffs();
            let scale = (a.abs() + c.abs()).max(b.abs() + d.abs());
            let det_scale = device.determinant().abs().sqrt() as f32;
            let mut post_reach_px = 0.0f64;
            let mut spatial_post_overflow = false;
            let mut wide_scope: Option<(u32, f32, f64)> = None;
            for &pid in &cr.spatial_post_records {
                if let Some(pnode) = self.store.nodes.get(&pid) {
                    let (pr, ov, lb) = post_effect_reach(&pnode.record, view_scale, max_side, plan_viewport);
                    post_reach_px += pr;
                    spatial_post_overflow |= ov;
                    if plan_viewport && wide_scope.is_none() && !ov && lb > 0.0 && wide_layer_blur(lb, pr) {
                        wide_scope = Some((pid, lb, pr));
                    }
                }
            }
            let pushed_before = nodes.len();
            let paint = device.transform_rect_bbox(cr.local);
            let unfilled_clip = if plan_viewport && !cr.unfilled_clips.is_empty() {
                let mut bounds: Option<[f32; 4]> = None;
                for &(cw, lb) in &cr.unfilled_clips {
                    let b = (view * cw).transform_rect_bbox(lb);
                    bounds = Some(match bounds {
                        Some([x0, y0, x1, y1]) => [
                            x0.max(b.x0 as f32),
                            y0.max(b.y0 as f32),
                            x1.min(b.x1 as f32),
                            y1.min(b.y1 as f32),
                        ],
                        None => [b.x0 as f32, b.y0 as f32, b.x1 as f32, b.y1 as f32],
                    });
                }
                bounds.filter(|[x0, y0, x1, y1]| x1 > x0 && y1 > y0)
            } else {
                None
            };
            match cr.kind {
                crate::store::CachedReaderKind::Glass { local_halo } => {
                    let reach_px = (f64::from(local_halo) * scale).ceil() + 2.0;
                    nodes.push(ReaderNode {
                        key: cr.key,
                        paint,
                        read: paint.inflate(reach_px, reach_px),
                        reach_px,
                        post_reach_px,
                        writes_backdrop: false,
                        kind: ReaderKind::Glass,
                        spatial_post_overflow,
                        paint_order: idx + 1,
                        unfilled_clip: None,
                    });
                }
                crate::store::CachedReaderKind::Read { halo } => {
                    let reach_px = (f64::from(halo) * scale).ceil() + 2.0;
                    nodes.push(ReaderNode {
                        key: cr.key,
                        paint,
                        read: paint.inflate(reach_px, reach_px),
                        reach_px,
                        post_reach_px,
                        writes_backdrop: true,
                        kind: ReaderKind::Read,
                        spatial_post_overflow,
                        paint_order: idx + 1,
                        unfilled_clip: None,
                    });
                }
                crate::store::CachedReaderKind::BackgroundBlur { radius } => {
                    let sigma_px = crate::blur::sigma_from_radius(radius) * scale as f32;
                    let reach = if plan_viewport {
                        crate::blur::replay_reach_view(sigma_px)
                    } else {
                        crate::blur::replay_reach(sigma_px)
                    };
                    let reach_px = f64::from(reach).ceil() + 2.0;
                    let sigma_det = crate::blur::sigma_from_radius(radius) * det_scale;
                    nodes.push(ReaderNode {
                        key: cr.key,
                        paint,
                        read: paint.inflate(reach_px, reach_px),
                        reach_px,
                        post_reach_px,
                        writes_backdrop: true,
                        kind: ReaderKind::UniformBlur { sigma: sigma_det },
                        spatial_post_overflow,
                        paint_order: idx + 1,
                        unfilled_clip,
                    });
                }
                crate::store::CachedReaderKind::ProgressiveBlur => {
                    let Some(crate::record::Op::ProgressiveBlur(p_op)) =
                        self.store.nodes.get(&cr.key.0).and_then(|n| n.record.ops.get(cr.key.1))
                    else {
                        continue;
                    };
                    let max_r = p_op.start_radius.max(p_op.end_radius);
                    let sigma_px = crate::blur::sigma_from_radius(max_r) * scale as f32;
                    let reach = if plan_viewport {
                        crate::blur::replay_reach_view(sigma_px)
                    } else {
                        crate::blur::replay_reach(sigma_px)
                    };
                    let reach_px = f64::from(reach).ceil() + 2.0;
                    let s0 = crate::blur::sigma_from_radius(p_op.start_radius) * det_scale;
                    let s1 = crate::blur::sigma_from_radius(p_op.end_radius) * det_scale;
                    let plan = crate::progressive_blur::ProgressivePlan::new(p_op, device, cr.size, det_scale);
                    nodes.push(ReaderNode {
                        key: cr.key,
                        paint,
                        read: paint.inflate(reach_px, reach_px),
                        reach_px,
                        post_reach_px,
                        writes_backdrop: true,
                        kind: ReaderKind::ProgressiveBlur {
                            lo: s0.min(s1),
                            hi: s0.max(s1),
                            plan,
                        },
                        spatial_post_overflow,
                        paint_order: idx + 1,
                        unfilled_clip,
                    });
                }
            }
            if nodes.len() > pushed_before {
                let scope = wide_scope.map(|(pid, lb, pr)| {
                    let reader = nodes.len() - 1;
                    if let Some(at) = candidates.iter().position(|c| c.id == pid) {
                        candidates[at].last_reader = reader;
                        return at;
                    }
                    let content_bbox = match self.store.bounds_and_pad(pid) {
                        (Some(b), page_pad) => {
                            let inner_pad = self
                                .store
                                .nodes
                                .get(&pid)
                                .map_or(0.0, |n| (page_pad - n.record.post_pad()).max(0.0));
                            let inner_pad_dev = if inner_pad > 0.0 {
                                inner_pad * view_scale + 2.0
                            } else {
                                0.0
                            };
                            (view * self.store.world(pid))
                                .transform_rect_bbox(b)
                                .inflate(inner_pad_dev, inner_pad_dev)
                        }
                        (None, _) => nodes[reader].paint,
                    };
                    candidates.push(CoarsePostCandidate {
                        id: pid,
                        max_lb_sigma: lb,
                        own_post_reach: pr,
                        content_bbox,
                        last_reader: reader,
                    });
                    candidates.len() - 1
                });
                node_scope.resize(nodes.len(), scope);
            }
        }
        type DownstreamWriters<'a> = (&'a mut Vec<(u32, usize)>, &'a mut [bool]);
        #[inline(never)]
        fn propagate_writers(
            writers: &[usize],
            nodes: &[ReaderNode],
            i: usize,
            reach: f64,
            needed: &mut [f64],
            mut reader_only: Option<(&mut [f64], f64)>,
            mut downstream: Option<DownstreamWriters<'_>>,
        ) {
            let earlier = writers.partition_point(|&writer| writer < i);
            let read = nodes[i].read;
            for &writer in &writers[..earlier] {
                let wp = nodes[writer]
                    .paint
                    .inflate(nodes[writer].post_reach_px, nodes[writer].post_reach_px);
                if wp.x0 <= read.x1 && read.x0 <= wp.x1 && wp.y0 <= read.y1 && read.y0 <= wp.y1 {
                    needed[writer] = needed[writer].max(reach);
                    if let Some((ro_needed, ro_reach)) = reader_only.as_mut() {
                        ro_needed[writer] = ro_needed[writer].max(*ro_reach);
                    }
                    if let Some((ds, seen)) = downstream.as_mut()
                        && !seen[writer]
                    {
                        seen[writer] = true;
                        ds.push(nodes[writer].key);
                    }
                }
            }
        }
        #[inline(never)]
        fn split_prog_for_rect(
            lo: f32,
            hi: f32,
            plan: Option<&crate::progressive_blur::ProgressivePlan>,
            rect: Rect,
            min_el: f32,
            nat_cut: f32,
            far_cut: f32,
        ) -> crate::halo::ProgressiveTierSplit {
            match plan {
                Some(p) if rect.width() > 0.0 && rect.height() > 0.0 => {
                    let (vf, ve) = p.active_stop_range(rect);
                    crate::halo::split_progressive_stops_slice(&p.stops[vf..ve], hi, min_el, nat_cut, far_cut)
                }
                _ => crate::halo::split_progressive_stops(lo, hi, min_el, nat_cut, far_cut),
            }
        }
        // A reader contributes only when its output reaches the crop or a later relevant
        // reader. Glass can be a sink but never a source of another reader's backdrop.
        let writers: Vec<_> = nodes
            .iter()
            .enumerate()
            .filter_map(|(i, node)| node.writes_backdrop.then_some(i))
            .collect();
        let mut needed_by_later = vec![0.0f64; nodes.len()];
        let mut reader_only_needed = vec![0.0f64; nodes.len()];
        let mut active_node = vec![false; nodes.len()];
        let mut downstream_readers: Vec<(u32, usize)> = Vec::new();
        let mut downstream_seen = vec![false; nodes.len()];
        let mut samples = crop.unwrap_or(Rect::ZERO);
        let mut total = 0.0f64;
        let mut reader_only = 0.0f64;
        for (i, node) in nodes.iter().enumerate().rev() {
            let downstream = needed_by_later[i];
            let reader_downstream = reader_only_needed[i];
            let vis_pad = downstream + node.post_reach_px;
            let affected = node.paint.inflate(node.post_reach_px, node.post_reach_px);
            if downstream == 0.0 && crop.is_some_and(|rect| !overlaps(affected, rect)) {
                continue;
            }
            active_node[i] = true;
            let reach = node.reach_px + node.post_reach_px + downstream;
            let reader_reach_only = node.reach_px + reader_downstream;
            total = total.max(reach);
            reader_only = reader_only.max(reader_reach_only);
            if let Some(crop) = crop {
                let visible = node.paint.intersect(crop.inflate(vis_pad, vis_pad));
                if visible.width() > 0.0 && visible.height() > 0.0 {
                    samples = samples.union(visible.inflate(node.reach_px, node.reach_px));
                }
            }
            propagate_writers(
                &writers,
                &nodes,
                i,
                reach,
                &mut needed_by_later,
                Some((&mut reader_only_needed, reader_reach_only)),
                Some((&mut downstream_readers, &mut downstream_seen)),
            );
        }
        let Some(crop) = crop.filter(|_| plan_viewport) else {
            return (total, reader_only, None);
        };
        let frame_irect = IRect::around(crop);
        // Wide layer-blur scopes whose readers draw, or whose blurred output reaches the crop:
        // the far tier covers their source and output.
        let active_candidates: Vec<usize> = (0..candidates.len())
            .filter(|&ci| {
                let c = &candidates[ci];
                (0..nodes.len()).any(|i| node_scope[i] == Some(ci) && active_node[i])
                    || overlaps(c.content_bbox.inflate(c.own_post_reach, c.own_post_reach), crop)
            })
            .collect();
        for &ci in &active_candidates {
            let c = &candidates[ci];
            for r in [
                c.content_bbox
                    .intersect(crop.inflate(c.own_post_reach, c.own_post_reach)),
                c.content_bbox
                    .inflate(c.own_post_reach, c.own_post_reach)
                    .intersect(crop),
            ] {
                if r.width() > 0.0 && r.height() > 0.0 {
                    samples = samples.union(r);
                }
            }
        }
        let samples_rect = IRect::around(samples);
        if samples_rect == frame_irect
            && !active_candidates
                .iter()
                .any(|&ci| candidates[ci].max_lb_sigma > crate::blur::MAX_BLUR_SIGMA)
        {
            return (total, reader_only, None);
        }

        let far_divisor = crate::halo::replay_divisor(samples_rect, replay_limit);
        let far_prog_cut = crate::halo::progressive_cutover_sigma(far_divisor);
        let far_unif_cut = crate::halo::uniform_cutover_sigma(far_divisor);

        // Determine if any visible reader benefits from coarse halo mode, and whether a mid-range
        // coarse tier is needed when `far_divisor > 16` so native padding stays compact and glass
        // lenses stacked over wide blurs never sample sub-3*d_far stops.
        let mut any_coarse = false;
        let mut far_has_blur = false;
        let mut any_mid = false;
        let mut mid_needed = vec![0.0f64; nodes.len()];
        let mut downstream_mid_readers: Vec<(u32, usize)> = Vec::new();
        let mut downstream_mid_seen = vec![false; nodes.len()];
        let mut mid_samples_f = crop;
        let mut glass_mid_rects: Vec<Rect> = Vec::new();
        let mut max_far_blur_order = 0usize;
        let mut max_mid_blur_order = 0usize;
        let mut max_far_blur_key: Option<(u32, usize)> = None;
        let mut max_mid_blur_key: Option<(u32, usize)> = None;
        let mut node_uses_coarse_blur = vec![false; nodes.len()];
        // Readers inside a coarse post scope draw in the far tier with their scope.
        let mut in_coarse_post_scope = vec![false; nodes.len()];
        let mut coarse_post_scopes: Vec<u32> = Vec::new();
        let mut coarse_post_min_sigma = f32::INFINITY;
        for &ci in &active_candidates {
            let c = &candidates[ci];
            if c.max_lb_sigma <= crate::blur::MAX_BLUR_SIGMA && c.max_lb_sigma < far_unif_cut {
                continue;
            }
            coarse_post_scopes.push(c.id);
            coarse_post_min_sigma = coarse_post_min_sigma.min(c.max_lb_sigma);
            any_coarse = true;
            far_has_blur = true;
            let last = &nodes[c.last_reader];
            if last.paint_order > max_far_blur_order {
                max_far_blur_order = last.paint_order;
                max_far_blur_key = Some(last.key);
            }
            for i in 0..nodes.len() {
                if node_scope[i] != Some(ci) {
                    continue;
                }
                in_coarse_post_scope[i] = true;
                if matches!(
                    nodes[i].kind,
                    ReaderKind::UniformBlur { .. } | ReaderKind::ProgressiveBlur { .. }
                ) {
                    node_uses_coarse_blur[i] = true;
                }
                if nodes[i].writes_backdrop && !downstream_readers.contains(&nodes[i].key) {
                    downstream_readers.push(nodes[i].key);
                }
            }
        }
        for (i, node) in nodes.iter().enumerate().rev() {
            if !active_node[i] || in_coarse_post_scope[i] {
                continue;
            }
            let mid_downstream = mid_needed[i];
            let post_pad = if node.spatial_post_overflow {
                0.0
            } else {
                node.post_reach_px
            };
            let vis_pad = mid_downstream + post_pad;
            let visible = node.paint.intersect(crop.inflate(vis_pad, vis_pad));
            let mid_reach_px = if node.spatial_post_overflow {
                0.0
            } else {
                match node.kind {
                    ReaderKind::Glass => {
                        any_coarse = true;
                        // If this visible glass lens overlaps an earlier active blur that has stops
                        // below `far_cut` inside the lens's visible read area, pull that blur into
                        // `downstream_mid_readers` so glass can sample a mid-tier (or mid-patched)
                        // prefix obeying `sigma >= 3 * d`, without dragging stops that only sit
                        // off-screen into the mid tier.
                        let lens_read = if visible.width() > 0.0 && visible.height() > 0.0 {
                            visible.inflate(node.reach_px, node.reach_px)
                        } else {
                            Rect::ZERO
                        };
                        if far_divisor > crate::halo::MID_TIER_TRIGGER_DIVISOR && !lens_read.is_zero_area() {
                            let earlier = writers.partition_point(|&writer| writer < i);
                            let mut feeds_sub_far_blur = false;
                            for &writer in &writers[..earlier] {
                                if !active_node[writer] || nodes[writer].spatial_post_overflow {
                                    continue;
                                }
                                let writer_paint = nodes[writer]
                                    .paint
                                    .inflate(nodes[writer].post_reach_px, nodes[writer].post_reach_px);
                                if !overlaps(writer_paint, lens_read) {
                                    continue;
                                }
                                let has_sub_far = match nodes[writer].kind {
                                    ReaderKind::UniformBlur { sigma } => sigma > 0.0 && sigma < far_unif_cut,
                                    ReaderKind::ProgressiveBlur { lo, hi, ref plan } => {
                                        if hi <= 0.0 {
                                            false
                                        } else {
                                            let overlap = writer_paint.intersect(lens_read);
                                            match plan {
                                                Some(p) if overlap.width() > 0.0 && overlap.height() > 0.0 => {
                                                    let (vf, ve) = p.active_stop_range(overlap);
                                                    p.stops[vf..ve].iter().any(|&s| s > 0.0 && s < far_prog_cut)
                                                }
                                                _ => lo < far_prog_cut,
                                            }
                                        }
                                    }
                                    _ => false,
                                };
                                if has_sub_far {
                                    feeds_sub_far_blur = true;
                                    if !downstream_mid_seen[writer] {
                                        downstream_mid_seen[writer] = true;
                                        downstream_mid_readers.push(nodes[writer].key);
                                    }
                                    // Ensure the mid tier covers the visible glass lens (plus
                                    // modest padding capped below the blur's own mid reach) so
                                    // mid captures the blur under the lens.
                                    let lens_vis = visible.inflate(node.reach_px.min(512.0), node.reach_px.min(512.0));
                                    if lens_vis.width() > 0.0 && lens_vis.height() > 0.0 {
                                        let dx = (lens_vis.x0 - crop.x0)
                                            .abs()
                                            .max((lens_vis.x1 - crop.x1).abs())
                                            .max((lens_vis.y0 - crop.y0).abs())
                                            .max((lens_vis.y1 - crop.y1).abs());
                                        mid_needed[writer] = mid_needed[writer].max(dx.max(1.0));
                                    } else {
                                        mid_needed[writer] = mid_needed[writer].max(1.0);
                                    }
                                }
                            }
                            if feeds_sub_far_blur {
                                any_mid = true;
                                if visible.width() > 0.0 && visible.height() > 0.0 {
                                    glass_mid_rects.push(visible.inflate(node.reach_px, node.reach_px));
                                }
                            }
                        }
                        0.0
                    }
                    ReaderKind::Read => node.reach_px,
                    ReaderKind::UniformBlur { sigma } => {
                        if sigma >= far_unif_cut {
                            any_coarse = true;
                            far_has_blur = true;
                            node_uses_coarse_blur[i] = true;
                            if node.paint_order > max_far_blur_order {
                                max_far_blur_order = node.paint_order;
                                max_far_blur_key = Some(node.key);
                            }
                            0.0
                        } else if far_divisor > crate::halo::MID_TIER_TRIGGER_DIVISOR
                            && sigma >= crate::blur::VIEWPORT_HALO_MIN_SIGMA
                        {
                            any_coarse = true;
                            any_mid = true;
                            node_uses_coarse_blur[i] = true;
                            if node.paint_order > max_mid_blur_order {
                                max_mid_blur_order = node.paint_order;
                                max_mid_blur_key = Some(node.key);
                            }
                            f64::from(crate::blur::blur_reach(sigma)).ceil() + 2.0
                        } else {
                            0.0
                        }
                    }
                    ReaderKind::ProgressiveBlur { lo, hi, ref plan } => {
                        let split = split_prog_for_rect(
                            lo,
                            hi,
                            plan.as_ref(),
                            visible,
                            crate::blur::VIEWPORT_HALO_MIN_SIGMA,
                            crate::progressive_blur::VIEWPORT_NATIVE_SIGMA,
                            far_prog_cut,
                        );
                        if split.uses_coarse || (hi >= far_unif_cut && hi >= far_prog_cut) {
                            any_coarse = true;
                            node_uses_coarse_blur[i] = true;
                            if hi >= far_unif_cut && hi >= far_prog_cut {
                                far_has_blur = true;
                                if node.paint_order > max_far_blur_order {
                                    max_far_blur_order = node.paint_order;
                                    max_far_blur_key = Some(node.key);
                                }
                            }
                        }
                        if far_divisor > crate::halo::MID_TIER_TRIGGER_DIVISOR && split.mid_max_sigma > 0.0 {
                            any_mid = true;
                            if node.paint_order > max_mid_blur_order {
                                max_mid_blur_order = node.paint_order;
                                max_mid_blur_key = Some(node.key);
                            }
                            f64::from(crate::blur::blur_reach(split.mid_max_sigma)).ceil() + 2.0
                        } else {
                            0.0
                        }
                    }
                }
            };
            let mid_reach = if mid_reach_px > 0.0 && visible.width() > 0.0 && visible.height() > 0.0 {
                mid_samples_f = mid_samples_f.union(visible.inflate(mid_reach_px, mid_reach_px));
                mid_reach_px + post_pad + mid_downstream
            } else {
                0.0
            };
            if mid_reach > 0.0 {
                propagate_writers(
                    &writers,
                    &nodes,
                    i,
                    mid_reach,
                    &mut mid_needed,
                    None,
                    Some((&mut downstream_mid_readers, &mut downstream_mid_seen)),
                );
            }
        }
        if !any_coarse {
            return (
                total,
                reader_only,
                Some(crate::halo::ViewportHaloPlan {
                    samples: samples_rect,
                    mid_samples: None,
                    far_divisor,
                    mid_divisor: None,
                    native_samples: samples_rect,
                    capture_bounds: samples_rect,
                    downstream_readers,
                    downstream_mid_readers,
                    use_coarse_halo: false,
                    far_has_blur: false,
                    far_min_feature_px: f32::INFINITY,
                    mid_min_feature_px: f32::INFINITY,
                    clamp_clips: Vec::new(),
                    coarse_post_scopes: Vec::new(),
                    coarse_post_min_sigma: f32::INFINITY,
                }),
            );
        }

        let mid_limit = replay_limit.saturating_add(replay_limit / 2);
        let (mid_samples, mid_divisor) = if any_mid {
            let base_rect = IRect::around(mid_samples_f);
            let base_div = crate::halo::replay_divisor(base_rect, mid_limit).max(crate::halo::MID_TIER_MIN_DIVISOR);
            // Expand `mid_samples_f` to include glass lens read rects ONLY when doing so does not
            // inflate `d_mid` above `base_div` (or `far_divisor / 2`), keeping native padding compact.
            let max_glass_div = base_div.max(crate::halo::MID_TIER_MIN_DIVISOR).min(far_divisor / 2);
            for gr in &glass_mid_rects {
                let cand = IRect::around(mid_samples_f.union(*gr));
                let cand_div = crate::halo::replay_divisor(cand, mid_limit).max(crate::halo::MID_TIER_MIN_DIVISOR);
                if cand_div <= max_glass_div {
                    mid_samples_f = mid_samples_f.union(*gr);
                }
            }
            let mid_rect = IRect::around(mid_samples_f);
            let d_mid = crate::halo::replay_divisor(mid_rect, mid_limit).max(crate::halo::MID_TIER_MIN_DIVISOR);
            if d_mid < far_divisor {
                (Some(mid_rect), Some(d_mid))
            } else {
                (None, None)
            }
        } else {
            (None, None)
        };

        // Compute device-resolution native padding and coarse capture coverage against the finest
        // active coarse tier's divisor-aware cut-over.
        let lowest_div = mid_divisor.unwrap_or(far_divisor);
        let native_prog_cut = crate::halo::progressive_cutover_sigma(lowest_div);
        let native_unif_cut = crate::halo::uniform_cutover_sigma(lowest_div);
        let mut native_needed = vec![0.0f64; nodes.len()];
        let mut native_samples_f = crop;
        for (i, node) in nodes.iter().enumerate().rev() {
            if !active_node[i] || in_coarse_post_scope[i] {
                continue;
            }
            let native_downstream = native_needed[i];
            let post_pad = if node.spatial_post_overflow {
                0.0
            } else {
                node.post_reach_px
            };
            let vis_pad = native_downstream + post_pad;
            let visible = node.paint.intersect(crop.inflate(vis_pad, vis_pad));
            if post_pad > 0.0 && visible.width() > 0.0 && visible.height() > 0.0 {
                // Keep the device pass large enough to cover enclosing LayerBlur/Texture src_area
                // so `blur_dirty_rect` blurs the full apron and inherited prefixes cover it.
                native_samples_f = native_samples_f.union(visible);
            }
            let native_reach_px = match node.kind {
                ReaderKind::Glass => 0.0,
                ReaderKind::Read => node.reach_px,
                ReaderKind::UniformBlur { sigma } => {
                    if node.spatial_post_overflow || sigma < native_unif_cut {
                        node.reach_px
                    } else {
                        0.0
                    }
                }
                ReaderKind::ProgressiveBlur { lo, hi, ref plan } => {
                    if node.spatial_post_overflow {
                        node.reach_px
                    } else if visible.width() <= 0.0 || visible.height() <= 0.0 {
                        0.0
                    } else {
                        let split = split_prog_for_rect(
                            lo,
                            hi,
                            plan.as_ref(),
                            visible,
                            native_unif_cut,
                            native_prog_cut,
                            f32::INFINITY,
                        );
                        if split.native_max_sigma > 0.0 {
                            f64::from(crate::blur::blur_reach(split.native_max_sigma)).ceil() + 2.0
                        } else {
                            0.0
                        }
                    }
                }
            };
            let native_reach = if native_reach_px > 0.0 && visible.width() > 0.0 && visible.height() > 0.0 {
                native_samples_f = native_samples_f.union(visible.inflate(native_reach_px, native_reach_px));
                native_reach_px + post_pad + native_downstream
            } else {
                0.0
            };
            propagate_writers(&writers, &nodes, i, native_reach, &mut native_needed, None, None);
        }
        let native_samples = IRect::around(native_samples_f);
        // Enclosing native spatial post-effects (LayerBlur / Texture) clamp their out_area to the
        // device target (`native_samples`) and inflate `src_area` by `post_reach_px`. Ensure coarse
        // captures and replay bounds cover that full `src_area`.
        let mut capture_bounds_f = native_samples_f;
        let mut samples_final_f = samples;
        for (i, node) in nodes.iter().enumerate() {
            if !active_node[i] || in_coarse_post_scope[i] || node.post_reach_px <= 0.0 || node.spatial_post_overflow {
                continue;
            }
            let post_vis = node
                .paint
                .intersect(native_samples_f.inflate(node.post_reach_px, node.post_reach_px));
            if post_vis.width() > 0.0 && post_vis.height() > 0.0 {
                capture_bounds_f = capture_bounds_f.union(post_vis);
                samples_final_f = samples_final_f.union(post_vis.inflate(node.reach_px, node.reach_px));
            }
        }
        let capture_bounds = IRect::around(capture_bounds_f);
        let samples_rect = IRect::around(samples_final_f);

        // Compute finest backdrop feature size (device px) preceding active blurs in each tier,
        // using a viewport-culled walk executed ONLY when coarse blurs actually need it.
        let need_far_feat = max_far_blur_key.is_some();
        let need_mid_feat = mid_samples.is_some() && max_mid_blur_key.is_some();
        let (far_min_feature_px, mid_min_feature_px) = if need_far_feat || need_mid_feat {
            struct FeatureWalk {
                far_rect: Rect,
                mid_rect: Option<Rect>,
                cull_rect: Rect,
                far_stop: Option<(u32, usize)>,
                mid_stop: Option<(u32, usize)>,
                before_far: bool,
                before_mid: bool,
                far_min: f32,
                mid_min: f32,
            }
            #[allow(clippy::too_many_arguments)]
            fn scan_features(
                store: &Store,
                view: Affine,
                reader_ancestors: &std::collections::HashSet<u32>,
                id: u32,
                parent: Affine,
                alpha: f32,
                parent_context: bool,
                w: &mut FeatureWalk,
            ) {
                if !w.before_far && !w.before_mid {
                    return;
                }
                let Some(node) = store.nodes.get(&id) else {
                    return;
                };
                let r = &node.record;
                if r.hidden() {
                    return;
                }
                let world = parent * r.transform;
                let device = view * world;
                if !device.as_coeffs().iter().all(|v| v.is_finite()) {
                    return;
                }
                let is_context = r.context();
                let in_alpha = if parent_context && !is_context { 1.0 } else { alpha };
                let opacity = in_alpha * r.opacity;
                if opacity <= 0.0 {
                    return;
                }
                if !reader_ancestors.contains(&id) {
                    let Some(bounds) = store.bounds(id) else {
                        return;
                    };
                    let dev_b = device.transform_rect_bbox(bounds);
                    if !(dev_b.x0 <= w.cull_rect.x1
                        && w.cull_rect.x0 <= dev_b.x1
                        && dev_b.y0 <= w.cull_rect.y1
                        && w.cull_rect.y0 <= dev_b.y1)
                    {
                        return;
                    }
                }
                let inner = if r.isolate() && r.opacity < 1.0 { 1.0 } else { opacity };
                let det_scale = device.determinant().abs().sqrt() as f32;
                for (at, op) in r.ops.iter().enumerate() {
                    if !w.before_far && !w.before_mid {
                        return;
                    }
                    match op {
                        crate::record::Op::Fill { path, paint, .. } if !is_context => {
                            if paint_alpha_visible(paint, inner)
                                && let Some((dev_b, feat)) =
                                    entry_feature_px(store, r, *path, paint, None, device, det_scale)
                            {
                                if w.before_far
                                    && dev_b.x0 <= w.far_rect.x1
                                    && w.far_rect.x0 <= dev_b.x1
                                    && dev_b.y0 <= w.far_rect.y1
                                    && w.far_rect.y0 <= dev_b.y1
                                {
                                    w.far_min = w.far_min.min(feat);
                                }
                                if w.before_mid
                                    && let Some(mr) = w.mid_rect
                                    && dev_b.x0 <= mr.x1
                                    && mr.x0 <= dev_b.x1
                                    && dev_b.y0 <= mr.y1
                                    && mr.y0 <= dev_b.y1
                                {
                                    w.mid_min = w.mid_min.min(feat);
                                }
                            }
                        }
                        crate::record::Op::Stroke { path, style, paint, .. } if !is_context => {
                            if paint_alpha_visible(paint, inner)
                                && let Some((dev_b, feat)) =
                                    entry_feature_px(store, r, *path, paint, Some(style.width), device, det_scale)
                            {
                                if w.before_far
                                    && dev_b.x0 <= w.far_rect.x1
                                    && w.far_rect.x0 <= dev_b.x1
                                    && dev_b.y0 <= w.far_rect.y1
                                    && w.far_rect.y0 <= dev_b.y1
                                {
                                    w.far_min = w.far_min.min(feat);
                                }
                                if w.before_mid
                                    && let Some(mr) = w.mid_rect
                                    && dev_b.x0 <= mr.x1
                                    && mr.x0 <= dev_b.x1
                                    && dev_b.y0 <= mr.y1
                                    && mr.y0 <= dev_b.y1
                                {
                                    w.mid_min = w.mid_min.min(feat);
                                }
                            }
                        }
                        crate::record::Op::Children => {
                            for &kid in &node.children {
                                scan_features(store, view, reader_ancestors, kid, world, inner, is_context, w);
                                if !w.before_far && !w.before_mid {
                                    return;
                                }
                            }
                        }
                        crate::record::Op::BackgroundBlur(_) | crate::record::Op::ProgressiveBlur(_) => {
                            let k = (id, at);
                            if w.far_stop == Some(k) {
                                w.before_far = false;
                            }
                            if w.mid_stop == Some(k) {
                                w.before_mid = false;
                            }
                        }
                        _ => {}
                    }
                }
            }
            let mid_rect = need_mid_feat.then_some(mid_samples_f);
            let cull_rect = mid_rect.map_or(samples_final_f, |mr| samples_final_f.union(mr));
            let mut walk = FeatureWalk {
                far_rect: samples_final_f,
                mid_rect,
                cull_rect,
                far_stop: max_far_blur_key,
                mid_stop: max_mid_blur_key,
                before_far: need_far_feat,
                before_mid: need_mid_feat,
                far_min: f32::INFINITY,
                mid_min: f32::INFINITY,
            };
            if let Some(root) = self.store.nodes.get(&crate::store::ROOT) {
                for &kid in &root.children {
                    scan_features(
                        &self.store,
                        view,
                        &cache.reader_ancestors,
                        kid,
                        Affine::IDENTITY,
                        1.0,
                        false,
                        &mut walk,
                    );
                }
            }
            (walk.far_min, walk.mid_min)
        } else {
            (f32::INFINITY, f32::INFINITY)
        };

        // Record unfilled `EdgeMode::Clamp` clip frames wrapping active coarse-tier blurs so the
        // GPU can capture exact 1-pixel-aligned edge strips before blurring.
        let mut clamp_clips = Vec::new();
        for (i, node) in nodes.iter().enumerate() {
            if !active_node[i] || !node_uses_coarse_blur[i] || node.spatial_post_overflow {
                continue;
            }
            if let Some(clip_dev) = node.unfilled_clip {
                let vis = node.paint.intersect(capture_bounds_f);
                if vis.width() > 0.0 && vis.height() > 0.0 {
                    let reach_rect = IRect::around(vis.inflate(node.reach_px, node.reach_px));
                    clamp_clips.push(crate::halo::HaloClampClip {
                        reader_key: node.key,
                        clip_dev,
                        reach_rect,
                    });
                }
            }
        }

        (
            total,
            reader_only,
            Some(crate::halo::ViewportHaloPlan {
                samples: samples_rect,
                mid_samples,
                far_divisor,
                mid_divisor,
                native_samples,
                capture_bounds,
                downstream_readers,
                downstream_mid_readers,
                use_coarse_halo: true,
                far_has_blur,
                far_min_feature_px,
                mid_min_feature_px,
                clamp_clips,
                coarse_post_scopes,
                coarse_post_min_sigma,
            }),
        )
    }

    /// Draws `area` of a `width` × `height` frame into the CPU target, extended by the readers'
    /// reach each way so what they read is drawn; answers the extended area. `extra_external`
    /// accounts for any live export band buffer temporarily taken out of `self.band`.
    #[allow(clippy::too_many_arguments)]
    fn cpu_tile(
        &mut self,
        width: u32,
        height: u32,
        camera: Camera,
        background: [f32; 4],
        detail: bool,
        area: IRect,
        grow_halo: bool,
        extra_external: usize,
    ) -> Result<(FrameStats, IRect)> {
        let view = camera.view();
        let halo = if grow_halo {
            self.export_halo(view, width, height)?
        } else {
            0
        };
        let grown = IRect {
            x0: area.x0 - halo,
            y0: area.y0 - halo,
            x1: area.x1 + halo,
            y1: area.y1 + halo,
        }
        .clamp(width as i32, height as i32);
        self.cpu.halo = halo;
        let tile_w = (grown.x1 - grown.x0).max(1) as usize;
        let tile_h = (grown.y1 - grown.y0).max(1) as usize;
        let tile_bytes = tile_w.saturating_mul(tile_h).saturating_mul(4);
        let runtime_held = self
            .held_bytes()
            .saturating_add(tile_bytes)
            .saturating_add(extra_external);
        let diamond_budget = if self.store.limits.memory_bytes > 0 {
            self.store.limits.memory_bytes.saturating_sub(runtime_held)
        } else {
            self.store.limits.image_bytes
        };
        self.cpu.set_diamond_budget(diamond_budget);
        self.cpu.set_external_bytes(
            self.held_bytes()
                .saturating_sub(self.cpu.image_bytes())
                .saturating_add(extra_external)
                .saturating_add(512 * 1024),
        );
        self.cpu
            .begin(width as u16, height as u16, grown, premultiply(background));
        let frame = Frame {
            width: width as u16,
            height: height as u16,
            view,
            detail,
            area: grown,
        };
        let limits = self.store.limits;
        let draw = exec::draw(&self.store, &mut self.cpu, &frame, &limits);
        // A scene left part-drawn by a failure is dropped; the next frame starts clean.
        self.cpu.finish();
        Ok((
            FrameStats {
                draw: draw?,
                masks: self.cpu.masks.stats,
            },
            grown,
        ))
    }

    /// Draws one tile on the CPU into `self.cpu.target`: `tile` × `tile` pixels under `view`
    /// (page to the tile's own pixels), with `halo` pixels drawn round it for readers, so the
    /// target is `tile + 2 × halo` a side and the tile is its middle.
    fn cpu_draw_tile(
        &mut self,
        view: Affine,
        tile: u32,
        halo: i32,
        detail: bool,
        background: [f32; 4],
    ) -> Result<FrameStats> {
        self.cpu_draw_tile_split(view, tile, halo, detail, background, &Split::all())
    }

    /// `cpu_draw_tile`, drawing only the part of the page `split` names.
    fn cpu_draw_tile_split(
        &mut self,
        view: Affine,
        tile: u32,
        halo: i32,
        detail: bool,
        background: [f32; 4],
        split: &Split,
    ) -> Result<FrameStats> {
        let side = tile as i32 + 2 * halo;
        let area = IRect {
            x0: 0,
            y0: 0,
            x1: side,
            y1: side,
        };
        self.cpu.halo = halo;
        let tile_bytes = (side as usize).saturating_mul(side as usize).saturating_mul(4);
        let runtime_held = self.held_bytes().saturating_add(tile_bytes);
        let diamond_budget = if self.store.limits.memory_bytes > 0 {
            self.store.limits.memory_bytes.saturating_sub(runtime_held)
        } else {
            self.store.limits.image_bytes
        };
        self.cpu.set_diamond_budget(diamond_budget);
        self.cpu.set_external_bytes(self.store.bytes());
        self.cpu.begin(side as u16, side as u16, area, premultiply(background));
        let frame = Frame {
            width: side as u16,
            height: side as u16,
            view: Affine::translate((f64::from(halo), f64::from(halo))) * view,
            detail,
            area,
        };
        let limits = self.store.limits;
        let mut verbs = limits.frame_verbs;
        let draw = exec::draw_split(
            &self.store,
            &mut self.cpu,
            &frame,
            &limits,
            &mut verbs,
            split,
            frame.detail,
        );
        self.cpu.finish();
        Ok(FrameStats {
            draw: draw?,
            masks: self.cpu.masks.stats,
        })
    }

    /// One tile of the page drawn in a part (tests): premultiplied RGBA8, `tile` × `tile`.
    #[doc(hidden)]
    pub fn debug_tile_part(&mut self, view: Affine, tile: u32, background: [f32; 4], split: &Split) -> Result<Vec<u8>> {
        self.cpu_draw_tile_split(view, tile, 0, false, background, split)?;
        Ok(self.cpu.target.data_as_u8_slice().to_vec())
    }

    /// Viewport tiles can grow past the export-band halo if their working target fits.
    fn cpu_view_halo(&self, view: Affine, crop: Rect, tile: u32) -> Result<i32> {
        let halo = self
            .reader_halo_plan(view, Some(crop), false, crate::halo::HALO_REPLAY_SIDE)
            .0
            .ceil();
        let side = f64::from(tile) + 2.0 * halo;
        let tile_bytes = side * side * 4.0;
        let budget = self.store.limits.memory_bytes;
        if !side.is_finite()
            || side > f64::from(self.store.limits.texture_side)
            || tile_bytes
                > if budget > 0 {
                    budget.saturating_sub(self.held_bytes()) as f64
                } else {
                    (64 << 20) as f64
                }
        {
            return Err(EngineError::limit(
                "a CPU viewport tile and its halo exceed the working frame",
            ));
        }
        Ok(halo as i32)
    }

    /// A frame made of tiles on the CPU (decision 0040, phase 2): premultiplied RGBA8. What the
    /// GPU's tiles are held to; exact frames are bitwise what a fresh engine makes.
    pub fn render_cpu_tiled(
        &mut self,
        width: u32,
        height: u32,
        camera: Camera,
        background: [f32; 4],
        options: TiledOptions,
    ) -> Result<(&[u8], TiledStats)> {
        self.store.begin_stroke_frame();
        self.check_size(width, height)?;
        camera.check()?;
        self.check_supported()?;
        if self.cpu_tiles.is_none() {
            self.use_cpu_tiles(crate::tiles::TILE, 256);
        }
        let view = camera.view();
        let mut tiles = self.cpu_tiles.take().expect("made above");
        let crop = Rect::new(0.0, 0.0, f64::from(width), f64::from(height));
        let result = self
            .cpu_view_halo(view, crop, tiles.cache.tile)
            .and_then(|halo| self.cpu_tiled_frame(&mut tiles, width, height, view, halo, background, options));
        self.cpu_tiles = Some(tiles);
        let mut stats = result?;
        // No frame is exact while text is still to come: it may paint past its box.
        if self.store.provisional_shown().is_some() {
            stats.exact = false;
        }
        Ok((self.cpu_tiles.as_ref().map_or(&[][..], |t| t.frame.as_slice()), stats))
    }

    /// Draws tiles on the CPU for the next frame of the view last drawn (`Gpu::ahead`'s twin,
    /// at most `max_jobs` tiles): what the tests hold the GPU's idle drawing to.
    pub fn render_cpu_ahead(&mut self, background: [f32; 4], max_jobs: usize) -> Result<TiledStats> {
        self.store.begin_stroke_frame();
        self.check_supported()?;
        let Some(mut tiles) = self.cpu_tiles.take() else {
            return Ok(TiledStats::default());
        };
        let result = (|| {
            let mut stats = TiledStats::default();
            let Some(last) = tiles.last else {
                return Ok(stats);
            };
            let crop = Rect::new(0.0, 0.0, f64::from(last.size.0), f64::from(last.size.1));
            let tile = tiles.cache.tile;
            let halo = self.cpu_view_halo(last.view, crop, tile)?;
            tiles.cache.begin_scaled(background, last.view.as_coeffs()[0], halo);
            let Some(plan) = tiles.cache.plan(last.view, last.size, false, Some(last), true, false) else {
                return Ok(stats);
            };
            let t = tile as usize;
            let side = t + 2 * halo.max(0) as usize;
            let h = halo.max(0) as usize;
            for job in plan.jobs.iter().filter(|j| !plan.direct && !j.direct).take(max_jobs) {
                let Some(slot) = tiles.cache.slot_for(job.key) else {
                    continue;
                };
                let fs = match self.cpu_draw_tile(job.view, tile, halo, job.detail, background) {
                    Ok(fs) => fs,
                    Err(e) => {
                        tiles.cache.release(job.key, slot);
                        return Err(e);
                    }
                };
                stats.draw.add(&fs.draw);
                stats.tiles_drawn += 1;
                let s = slot as usize;
                if tiles.slots.len() <= s {
                    tiles.slots.resize_with(s + 1, Vec::new);
                }
                let out = &mut tiles.slots[s];
                out.clear();
                let target = self.cpu.target.data_as_u8_slice();
                for y in 0..t {
                    let from = ((y + h) * side + h) * 4;
                    out.extend_from_slice(&target[from..from + t * 4]);
                }
                tiles
                    .cache
                    .drawn(job.key, slot, fs.draw.exact(), !job.detail, fs.draw.reduced > 0);
            }
            let (pending, _) = tiles.cache.left(&plan);
            stats.pending = pending;
            stats.held = tiles.cache.len() as u32;
            Ok(stats)
        })();
        self.cpu_tiles = Some(tiles);
        result
    }

    #[allow(clippy::too_many_arguments)]
    fn cpu_tiled_frame(
        &mut self,
        tiles: &mut CpuTiles,
        width: u32,
        height: u32,
        view: Affine,
        halo: i32,
        background: [f32; 4],
        options: TiledOptions,
    ) -> Result<TiledStats> {
        let tile = tiles.cache.tile;
        let scale = view.as_coeffs()[0];
        tiles.cache.begin_scaled(background, scale, halo);
        let zooming = options.moving && tiles.last_scale.is_some_and(|s| s != scale);
        // A page just shown: under a budget, coarse tiles first (see `Gpu::render`).
        let opening = tiles.last.is_none() && tiles.cache.is_empty() && options.max_jobs != usize::MAX;
        let last = tiles.last;
        tiles.cache.opening = opening;
        let mut plan = tiles
            .cache
            .plan(view, (width, height), zooming || opening, last, options.prefetch, false)
            .ok_or_else(|| EngineError::limit("a camera the tiles can't follow (too far out)"))?;
        let mut stats = TiledStats {
            direct: plan.direct,
            ..TiledStats::default()
        };
        // A drag: the tiles its selection touches are composited from the page's parts below and
        // above it with the selection drawn afresh between (when that's exact), else drawn at its
        // real position every frame.
        let drag = self.drag_frame();
        let selection = tiles
            .cache
            .drag_prepare(&mut plan, drag.as_ref().map(DragFrame::input).as_ref());
        let bg = premultiply(background);
        let stride = width as usize * 4;
        let mut frame = std::mem::take(&mut tiles.frame);
        frame.clear();
        frame.resize(stride * height as usize, 0);
        for p in frame.as_chunks_mut::<4>().0.iter_mut() {
            p.copy_from_slice(&bg);
        }
        let t = tile as usize;
        let side = tile as usize + 2 * halo.max(0) as usize;
        // The tile's own pixels, out of the target drawn with its halo.
        let take = |target: &[u8], out: &mut Vec<u8>| {
            out.clear();
            out.reserve(t * t * 4);
            let h = halo.max(0) as usize;
            for y in 0..t {
                let from = ((y + h) * side + h) * 4;
                out.extend_from_slice(&target[from..from + t * 4]);
            }
        };
        let mut optional = 0usize;
        let mut exact_direct = true;
        let mut scratch = Vec::new();
        // Drawn straight into the frame after it's laid: what no slot could be kept for.
        let mut late: Vec<crate::tiles::Job> = Vec::new();
        for job in &plan.jobs {
            if !job.must {
                if optional >= options.max_jobs {
                    continue;
                }
                optional += 1;
            }
            if plan.direct || job.direct {
                late.push(*job);
                continue;
            }
            let Some(slot) = tiles.cache.slot_for(job.key) else {
                if job.must {
                    late.push(*job);
                }
                continue;
            };
            let fs = match self.cpu_draw_tile(job.view, tile, halo, job.detail, background) {
                Ok(fs) => fs,
                Err(e) => {
                    tiles.cache.release(job.key, slot);
                    return Err(e);
                }
            };
            stats.draw.add(&fs.draw);
            stats.tiles_drawn += 1;
            // Exact only if nothing stood in: no level of detail, no provisional record.
            let exact = fs.draw.exact();
            let s = slot as usize;
            if tiles.slots.len() <= s {
                tiles.slots.resize_with(s + 1, Vec::new);
            }
            take(self.cpu.target.data_as_u8_slice(), &mut tiles.slots[s]);
            tiles
                .cache
                .drawn(job.key, slot, exact, !job.detail, fs.draw.reduced > 0);
        }
        let mut comp_exact = true;
        if !plan.direct {
            // What's drawn straight into the frame after it covers its tile there: the composite
            // counts it so (what no slot could be found for included).
            for job in plan.jobs.iter_mut() {
                if late.iter().any(|l| l.key == job.key) {
                    job.direct = true;
                }
            }
            let comp = tiles.cache.compose(&plan, last);
            comp_exact = comp.exact;
            stats.pending = comp.pending;
            if !comp.complete {
                // Where something changed since, the last frame's pixels are old: then it isn't
                // laid at all here (the GPU lays it round what changed).
                if let (Some(m), Some(l), true) = (comp.base, last, comp.holes.is_empty()) {
                    // The last frame, moved and scaled (nearest pixel: a stand-in).
                    let prev = tiles.frame_last.clone();
                    let inv = m.inverse();
                    let (lw, lh) = (l.size.0 as i64, l.size.1 as i64);
                    if prev.len() == (lw * lh * 4) as usize {
                        for y in 0..height as usize {
                            for x in 0..width as usize {
                                let p = inv * vello_common::kurbo::Point::new(x as f64 + 0.5, y as f64 + 0.5);
                                let (sx, sy) = (p.x.floor() as i64, p.y.floor() as i64);
                                if sx >= 0 && sy >= 0 && sx < lw && sy < lh {
                                    let from = ((sy * lw + sx) * 4) as usize;
                                    let to = y * stride + x * 4;
                                    frame[to..to + 4].copy_from_slice(&prev[from..from + 4]);
                                }
                            }
                        }
                    }
                }
                for sc in &comp.scaled {
                    let Some(src) = tiles.slots.get(sc.slot as usize) else {
                        continue;
                    };
                    if src.len() != t * t * 4 {
                        continue;
                    }
                    let d = sc.dst;
                    let x0 = d.x0.max(0.0).floor() as usize;
                    let y0 = d.y0.max(0.0).floor() as usize;
                    let x1 = (d.x1.min(f64::from(width))).ceil().max(0.0) as usize;
                    let y1 = (d.y1.min(f64::from(height))).ceil().max(0.0) as usize;
                    for y in y0..y1.min(height as usize) {
                        let v = ((y as f64 + 0.5 - d.y0) / d.height() * t as f64).floor();
                        if !(0.0..t as f64).contains(&v) {
                            continue;
                        }
                        for x in x0..x1.min(width as usize) {
                            let u = ((x as f64 + 0.5 - d.x0) / d.width() * t as f64).floor();
                            if !(0.0..t as f64).contains(&u) {
                                continue;
                            }
                            let from = (v as usize * t + u as usize) * 4;
                            let to = y * stride + x * 4;
                            frame[to..to + 4].copy_from_slice(&src[from..from + 4]);
                        }
                    }
                }
            }
            for c in &comp.copies {
                let Some(src) = tiles.slots.get(c.slot as usize) else {
                    continue;
                };
                let cols = (c.src.x1 - c.src.x0) as usize * 4;
                for r in 0..(c.src.y1 - c.src.y0) as usize {
                    let from = ((c.src.y0 as usize + r) * t + c.src.x0 as usize) * 4;
                    let to = (c.dst.1 as usize + r) * stride + c.dst.0 as usize * 4;
                    frame[to..to + cols].copy_from_slice(&src[from..from + cols]);
                }
            }
        }
        for job in &late {
            let fs = self.cpu_draw_tile(job.view, tile, halo, job.detail, background)?;
            stats.draw.add(&fs.draw);
            stats.tiles_drawn += 1;
            exact_direct &= !job.detail && fs.draw.exact();
            take(self.cpu.target.data_as_u8_slice(), &mut scratch);
            let fx = i64::from(job.key.i) * i64::from(tile) + plan.origin.0;
            let fy = i64::from(job.key.j) * i64::from(tile) + plan.origin.1;
            blit(&mut frame, width, height, &scratch, t, fx, fy);
        }
        stats.exact = comp_exact && exact_direct;
        stats.direct = plan.direct || !late.is_empty();
        if let (Some(d), Some(now), Some(level)) = (&drag, selection, tiles.cache.level(plan.level))
            && let Some(split) = d.split.as_ref()
        {
            for dt in tiles.cache.drag_tiles(&plan, now) {
                let view = level.tile_view(dt.i, dt.j, tile);
                let fx = i64::from(dt.i) * i64::from(tile) + plan.origin.0;
                let fy = i64::from(dt.j) * i64::from(tile) + plan.origin.1;
                // The parts below and above, kept for the drag; the selection drawn afresh.
                let mut parts = [None, None];
                for (k, (pseudo, pass, fill)) in [
                    (crate::tiles::DRAG_BELOW, Pass::Below, background),
                    (crate::tiles::DRAG_ABOVE, Pass::Above, [0.0; 4]),
                ]
                .into_iter()
                .enumerate()
                {
                    let key = crate::tiles::TileKey {
                        level: pseudo,
                        i: dt.i,
                        j: dt.j,
                    };
                    parts[k] = match tiles.cache.take_slot(&key) {
                        Some(slot) => Some(slot),
                        None => match tiles.cache.slot_for(key) {
                            Some(slot) => {
                                let part = Split { pass, ..split.clone() };
                                if let Err(e) = self.cpu_draw_tile_split(view, tile, halo, false, fill, &part) {
                                    tiles.cache.release(key, slot);
                                    return Err(e);
                                }
                                let s = slot as usize;
                                if tiles.slots.len() <= s {
                                    tiles.slots.resize_with(s + 1, Vec::new);
                                }
                                take(self.cpu.target.data_as_u8_slice(), &mut tiles.slots[s]);
                                tiles.cache.drawn(key, slot, true, true, false);
                                Some(slot)
                            }
                            None => None,
                        },
                    };
                }
                let [Some(below), Some(above)] = parts else {
                    // No room to keep the parts: the tile drawn whole and exact, straight into
                    // the frame, never left showing the selection where it was (or nothing).
                    let fs = self.cpu_draw_tile(view, tile, halo, false, background)?;
                    stats.draw.add(&fs.draw);
                    stats.tiles_drawn += 1;
                    take(self.cpu.target.data_as_u8_slice(), &mut scratch);
                    blit(&mut frame, width, height, &scratch, t, fx, fy);
                    stats.direct = true;
                    continue;
                };
                blit(&mut frame, width, height, &tiles.slots[below as usize], t, fx, fy);
                if dt.selection {
                    let part = Split {
                        pass: Pass::Selection,
                        ..split.clone()
                    };
                    self.cpu_draw_tile_split(view, tile, halo, false, [0.0; 4], &part)?;
                    take(self.cpu.target.data_as_u8_slice(), &mut scratch);
                    blend(&mut frame, width, height, &scratch, t, fx, fy);
                }
                blend(&mut frame, width, height, &tiles.slots[above as usize], t, fx, fy);
                stats.dragged += 1;
                stats.exact = false;
            }
        }
        stats.evicted = tiles.cache.stats.evicted;
        stats.held = tiles.cache.len() as u32;
        tiles.frame_last.clone_from(&frame);
        tiles.frame = frame;
        tiles.last = Some(Last {
            view,
            size: (width, height),
        });
        tiles.last_scale = Some(scale);
        // The frame the next is laid on: drawn from what's current (`TileCache::frame_drawn`).
        tiles.cache.frame_drawn();
        Ok(stats)
    }

    /// Draws one band of a large export: device rows `y0..y0 + rows` of a `width` × `height`
    /// frame, premultiplied RGBA8, `rows` × `width` × 4 bytes. The band is drawn in tiles of at
    /// most `Limits::export_tile` columns (each with the readers' reach around it), so the working set
    /// is a tile, and the band (at most `Limits::band_rows` rows) is the only output held. The
    /// frame's longest side is at most `Limits::texture_side` (8,192 px): larger is refused.
    pub fn render_band(
        &mut self,
        width: u32,
        height: u32,
        camera: Camera,
        background: [f32; 4],
        y0: u32,
        rows: u32,
    ) -> Result<&[u8]> {
        self.render_band_inner(width, height, camera, background, y0, rows, true)
    }

    #[allow(clippy::too_many_arguments)]
    fn render_band_inner(
        &mut self,
        width: u32,
        height: u32,
        camera: Camera,
        background: [f32; 4],
        y0: u32,
        rows: u32,
        check_work: bool,
    ) -> Result<&[u8]> {
        self.store.begin_stroke_frame();
        self.check_size(width, height)?;
        camera.check()?;
        self.check_supported()?;
        self.check_settled()?;
        let most = self.band_rows(width);
        if rows == 0 || rows > most || y0.checked_add(rows).is_none_or(|end| end > height) {
            return Err(EngineError::new(
                ErrorCode::Limit,
                format!(
                    "a band of {rows} rows at {y0} in a frame {height} tall; bands {width} px wide are at most {most} rows"
                ),
            ));
        }
        if check_work {
            // A trailing partial band can be shorter than the nominal band height; estimate the
            // full export's tile count with the nominal height so the final short band is not
            // overcounted.
            let nominal_rows = if y0 + rows == height && y0 > 0 {
                rows.max(most.min(height))
            } else {
                rows
            };
            let view = camera.view();
            let halo = self.export_halo(view, width, height)? as usize;
            let cols = (self.store.limits.export_tile.max(1).min(width) as usize + 2 * halo).min(width as usize);
            let tile_rows = (nominal_rows as usize + 2 * halo).min(height as usize);
            let effects = self.export_effect_working_set(cols, tile_rows, view)?;
            let tile = cols as u64 * tile_rows as u64 * 4;
            let readers = self.export_reader_working_set(width, height, view, (cols, tile_rows));
            let diamond = self.export_diamond_bytes(width, height, view, cols, tile_rows);
            self.check_export_work(width, height, nominal_rows, tile, effects, diamond, readers)?;
        }
        let stride = width as usize * 4;
        let mut band = std::mem::take(&mut self.band);
        let band_bytes = stride * rows as usize;
        band.clear();
        if self.store.limits.memory_bytes > 0 && band.capacity() > self.store.limits.band_bytes {
            band.shrink_to_fit();
        }
        band.resize(band_bytes, 0);
        let mut x0 = 0u32;
        let result = (|| {
            while x0 < width {
                let cols = self.store.limits.export_tile.max(1).min(width - x0);
                let area = IRect {
                    x0: x0 as i32,
                    y0: y0 as i32,
                    x1: (x0 + cols) as i32,
                    y1: (y0 + rows) as i32,
                };
                let (_, grown) =
                    self.cpu_tile(width, height, camera, background, false, area, true, band.capacity())?;
                let tw = (grown.x1 - grown.x0) as usize * 4;
                let px = self.cpu.target.data_as_u8_slice();
                for r in 0..rows as usize {
                    let ty = (y0 as i32 - grown.y0) as usize + r;
                    let from = ty * tw + (x0 as i32 - grown.x0) as usize * 4;
                    let to = r * stride + x0 as usize * 4;
                    let n = cols as usize * 4;
                    band[to..to + n].copy_from_slice(&px[from..from + n]);
                }
                x0 += cols;
            }
            Ok(())
        })();
        self.band = band;
        result.map(|()| self.band.as_slice())
    }

    /// `render_band`, unpremultiplied in place (as a PNG holds pixels): no copy of the band.
    pub fn render_band_straight(
        &mut self,
        width: u32,
        height: u32,
        camera: Camera,
        background: [f32; 4],
        y0: u32,
        rows: u32,
    ) -> Result<&[u8]> {
        self.render_band_inner(width, height, camera, background, y0, rows, true)?;
        unpremultiply(&mut self.band);
        Ok(self.band.as_slice())
    }

    /// Used by `png_band` after `png_begin` has already validated export admission and pinned
    /// the revision, avoiding redundant per-band work-bound walks.
    pub(crate) fn render_band_straight_admitted(
        &mut self,
        width: u32,
        height: u32,
        camera: Camera,
        background: [f32; 4],
        y0: u32,
        rows: u32,
    ) -> Result<&[u8]> {
        self.render_band_inner(width, height, camera, background, y0, rows, false)?;
        unpremultiply(&mut self.band);
        Ok(self.band.as_slice())
    }
}

/// Copies a `t` × `t` tile into a `width` × `height` frame with its top left at (`fx`, `fy`),
/// clipped to the frame.
fn blit(frame: &mut [u8], width: u32, height: u32, tile: &[u8], t: usize, fx: i64, fy: i64) {
    let (w, h) = (i64::from(width), i64::from(height));
    let ti = t as i64;
    let (x0, y0) = (fx.max(0), fy.max(0));
    let (x1, y1) = ((fx + ti).min(w), (fy + ti).min(h));
    if x1 <= x0 || y1 <= y0 || tile.len() < t * t * 4 {
        return;
    }
    let cols = (x1 - x0) as usize * 4;
    for y in y0..y1 {
        let from = (((y - fy) * ti + (x0 - fx)) * 4) as usize;
        let to = ((y * w + x0) * 4) as usize;
        frame[to..to + cols].copy_from_slice(&tile[from..from + cols]);
    }
}

/// Lays a `t` × `t` premultiplied tile over a frame (source over) with its top left at (`fx`,
/// `fy`), clipped to the frame.
fn blend(frame: &mut [u8], width: u32, height: u32, tile: &[u8], t: usize, fx: i64, fy: i64) {
    let (w, h) = (i64::from(width), i64::from(height));
    let ti = t as i64;
    let (x0, y0) = (fx.max(0), fy.max(0));
    let (x1, y1) = ((fx + ti).min(w), (fy + ti).min(h));
    if x1 <= x0 || y1 <= y0 || tile.len() < t * t * 4 {
        return;
    }
    for y in y0..y1 {
        for x in x0..x1 {
            let from = (((y - fy) * ti + (x - fx)) * 4) as usize;
            let to = ((y * w + x) * 4) as usize;
            let a = u32::from(tile[from + 3]);
            if a == 0 {
                continue;
            }
            for c in 0..4 {
                let d = u32::from(frame[to + c]);
                frame[to + c] = (u32::from(tile[from + c]) + (d * (255 - a) + 127) / 255).min(255) as u8;
            }
        }
    }
}

#[cfg(test)]
mod halo_plan_tests {
    use super::*;
    use crate::record::{BackgroundBlurOp, Op, PathEntry, PostEffect, ProgressiveBlurOp, Record};
    use crate::store::ROOT;

    fn make_record(size: [f32; 2], ops: Vec<Op>, post_effects: Vec<PostEffect>) -> Record {
        Record {
            flags: 0,
            opacity: 1.0,
            transform: Affine::IDENTITY,
            size,
            coarse_below: 0.0,
            reach: 0.0,
            unsupported: 0,
            blend: 0,
            mask: 0,
            paths: vec![PathEntry::Box {
                x: 0.0,
                y: 0.0,
                w: size[0],
                h: size[1],
                radii: [0.0; 4],
                smoothing: 0.0,
            }],
            ops,
            coarse: Vec::new(),
            post_effects,
        }
    }

    #[test]
    fn post_effect_is_spatial_excludes_noise() {
        assert!(
            !PostEffect::Noise {
                noise_type: 0,
                size: 2.0,
                density: 0.5,
                color: [0.0, 0.0, 0.0, 1.0],
                secondary_color: [0.0; 4],
                opacity: 1.0,
            }
            .is_spatial()
        );
        assert!(PostEffect::LayerBlur { radius: 4.0 }.is_spatial());
        assert!(!PostEffect::LayerBlur { radius: 0.0 }.is_spatial());
        assert!(
            PostEffect::Texture {
                size: 8.0,
                radius: 4.0,
                clip_to_shape: false,
            }
            .is_spatial()
        );
        assert!(
            !PostEffect::Texture {
                size: 8.0,
                radius: 0.0,
                clip_to_shape: false,
            }
            .is_spatial()
        );
    }

    #[test]
    fn extreme_zoom_progressive_blur_uses_two_coarse_tiers_and_compact_native_pad() {
        let mut engine = Engine::new(Limits::default());
        let blur = make_record(
            [100.0, 100.0],
            vec![Op::ProgressiveBlur(Box::new(ProgressiveBlurOp {
                paths: vec![0],
                even_odd: false,
                start_radius: 0.0,
                end_radius: 40.0,
                start: [0.0, 0.0],
                end: [0.0, 1.0],
            }))],
            Vec::new(),
        );
        engine.store.insert_for_test(1, ROOT, blur);

        // 25,600% zoom, DPR 2 (scale 512), 2880 x 1800 viewport -> sigma_max = 9216 px.
        let view = Camera {
            zoom: 256.0,
            x: 0.0,
            y: 0.0,
            dpr: 2.0,
        }
        .view();
        let crop = Rect::new(0.0, 0.0, 2880.0, 1800.0);
        let (_, _, plan) = engine.reader_halo_plan(view, Some(crop), true, crate::halo::HALO_REPLAY_SIDE);
        let plan = plan.expect("viewport halo plan");
        assert!(plan.far_divisor >= 64, "far_divisor={}", plan.far_divisor);
        assert_eq!(plan.mid_divisor, Some(8), "mid tier keeps native cut-over at 32 px");
        // Native padding covers only stops < 32 px (~114 px reach), never 3 * far_divisor (~1344 px).
        let native_pad = (-plan.native_samples.x0)
            .max(-plan.native_samples.y0)
            .max(plan.native_samples.x1 - 2880)
            .max(plan.native_samples.y1 - 1800);
        assert!(native_pad <= 160, "native_pad={native_pad} should stay compact");

        // Panning into the deep-blur interior (y = 50 -> local sigma ~4600 px) needs neither the
        // mid tier nor any native padding because every visible stop is >= 3 * far_divisor.
        let deep_view = Camera {
            zoom: 256.0,
            x: 0.0,
            y: -50.0 * 256.0,
            dpr: 2.0,
        }
        .view();
        let (_, _, deep_plan) = engine.reader_halo_plan(deep_view, Some(crop), true, crate::halo::HALO_REPLAY_SIDE);
        let deep_plan = deep_plan.expect("deep blur halo plan");
        assert!(deep_plan.far_divisor >= 64);
        assert_eq!(deep_plan.mid_divisor, None, "deep interior skips unused mid tier");
        assert_eq!(deep_plan.native_samples, IRect::around(crop));
    }

    #[test]
    fn noise_scope_uses_coarse_halo_without_extra_post_pad_and_layer_blur_grows_capture_only() {
        let clipped_ops = vec![
            Op::Clip {
                path: 0,
                even_odd: false,
            },
            Op::Children,
            Op::Unclip,
        ];
        let wide_blur = make_record(
            [200.0, 200.0],
            vec![Op::BackgroundBlur(Box::new(BackgroundBlurOp {
                paths: vec![0],
                even_odd: false,
                radius: 40.0,
            }))],
            Vec::new(),
        );
        let noise_pe = vec![PostEffect::Noise {
            noise_type: 0,
            size: 4.0,
            density: 0.5,
            color: [1.0, 1.0, 1.0, 0.5],
            secondary_color: [0.0; 4],
            opacity: 1.0,
        }];
        let view = Camera {
            zoom: 128.0,
            x: -2000.0,
            y: -2000.0,
            dpr: 2.0,
        }
        .view();
        let crop = Rect::new(0.0, 0.0, 640.0, 384.0);

        // 1a. Clipped Noise scope around wide background blur: coarse halo with zero extra pad.
        let mut noise_engine = Engine::new(Limits::default());
        noise_engine.store.insert_for_test(
            1,
            ROOT,
            make_record([200.0, 200.0], clipped_ops.clone(), noise_pe.clone()),
        );
        noise_engine.store.insert_for_test(2, 1, wide_blur.clone());
        let (_, _, noise_plan) = noise_engine.reader_halo_plan(view, Some(crop), true, crate::halo::HALO_REPLAY_SIDE);
        let noise_plan = noise_plan.expect("clipped noise scope uses halo");
        assert!(noise_plan.use_coarse_halo);
        assert_eq!(
            noise_plan.native_samples,
            IRect {
                x0: 0,
                y0: 0,
                x1: 640,
                y1: 384
            }
        );
        assert_eq!(noise_plan.capture_bounds, noise_plan.native_samples);

        // 1b. Unclipped Noise scope also stays in coarse halo mode with zero extra pad.
        let mut unclipped_noise = Engine::new(Limits::default());
        unclipped_noise
            .store
            .insert_for_test(1, ROOT, make_record([200.0, 200.0], vec![Op::Children], noise_pe));
        unclipped_noise.store.insert_for_test(2, 1, wide_blur.clone());
        let (_, _, unclipped_plan) =
            unclipped_noise.reader_halo_plan(view, Some(crop), true, crate::halo::HALO_REPLAY_SIDE);
        let unclipped_plan = unclipped_plan.expect("unclipped noise scope uses halo");
        assert!(unclipped_plan.use_coarse_halo);
        assert_eq!(unclipped_plan.native_samples, noise_plan.native_samples);

        // 2a. Clipped native-fitting LayerBlur (radius 1 -> sigma = 115.2 <= 2560) stays in coarse
        //     halo mode and grows both `native_samples` and `capture_bounds` to cover its full
        //     `src_area` apron so `blur_dirty_rect` blurs the entire scope cleanly.
        let mut lb_engine = Engine::new(Limits::default());
        lb_engine.store.insert_for_test(
            1,
            ROOT,
            make_record(
                [200.0, 200.0],
                clipped_ops.clone(),
                vec![PostEffect::LayerBlur { radius: 1.0 }],
            ),
        );
        lb_engine.store.insert_for_test(2, 1, wide_blur.clone());
        let (_, _, lb_plan) = lb_engine.reader_halo_plan(view, Some(crop), true, crate::halo::HALO_REPLAY_SIDE);
        let lb_plan = lb_plan.expect("clipped native-fitting LayerBlur uses halo");
        assert!(lb_plan.use_coarse_halo);
        assert!(lb_plan.native_samples.x0 <= -400 && lb_plan.native_samples.x1 >= 1040);
        assert!(lb_plan.capture_bounds.x0 <= -400 && lb_plan.capture_bounds.x1 >= 1040);

        // 2b. Unclipped native-fitting LayerBlur scope also stays in coarse halo mode with full
        //     `src_area` padding in both `native_samples` and `capture_bounds`.
        let mut unclipped_lb = Engine::new(Limits::default());
        unclipped_lb.store.insert_for_test(
            1,
            ROOT,
            make_record(
                [200.0, 200.0],
                vec![Op::Children],
                vec![PostEffect::LayerBlur { radius: 1.0 }],
            ),
        );
        unclipped_lb.store.insert_for_test(2, 1, wide_blur.clone());
        let (_, _, unclipped_lb_plan) =
            unclipped_lb.reader_halo_plan(view, Some(crop), true, crate::halo::HALO_REPLAY_SIDE);
        let unclipped_lb_plan = unclipped_lb_plan.expect("unclipped LayerBlur plan");
        assert!(unclipped_lb_plan.use_coarse_halo);
        assert!(unclipped_lb_plan.native_samples.x0 <= -400 && unclipped_lb_plan.native_samples.x1 >= 1040);

        // 3. A layer blur past the native pyramid (radius 30 -> sigma = 3456 > 2560) wrapping a
        //    reader runs in the far tier as a coarse post scope (case L3), keeping the
        //    device-resolution pass to the crop. Export plans still refuse it (below).
        let mut ovf_engine = Engine::new(Limits::default());
        ovf_engine.store.insert_for_test(
            1,
            ROOT,
            make_record(
                [200.0, 200.0],
                clipped_ops,
                vec![PostEffect::LayerBlur { radius: 30.0 }],
            ),
        );
        ovf_engine.store.insert_for_test(2, 1, wide_blur);
        let (_, _, ovf_plan) = ovf_engine.reader_halo_plan(view, Some(crop), true, crate::halo::HALO_REPLAY_SIDE);
        let ovf_plan = ovf_plan.expect("coarse post-scope plan");
        assert!(ovf_plan.use_coarse_halo);
        assert_eq!(ovf_plan.coarse_post_scopes, vec![1]);
        assert!(ovf_plan.coarse_post_min_sigma > crate::blur::MAX_BLUR_SIGMA);
        assert_eq!(ovf_plan.native_samples, IRect::around(crop));
        // The same scope in an export plan keeps main's reach and refuses past the band halo.
        let (export_total, _, export_plan) =
            ovf_engine.reader_halo_plan(view, Some(crop), false, crate::halo::HALO_REPLAY_SIDE);
        assert!(export_plan.is_none());
        assert!(ovf_engine.limit_halo(export_total).is_err());
    }

    #[test]
    fn uniform_cutover_routes_below_3d_to_mid_tier_and_native_above_d64() {
        // Test BOTH orders: mid blur before overlapping far driver AND after, verifying the far
        // driver never inflates `mid_samples` with its own far-tier reach.
        for mid_first in [false, true] {
            let mut engine = Engine::new(Limits::default());
            // Wide driver blur pushes far_divisor to 64 (span ~36k / 1024 -> 64).
            let driver = make_record(
                [10.0, 10.0],
                vec![Op::BackgroundBlur(Box::new(BackgroundBlurOp {
                    paths: vec![0],
                    even_odd: false,
                    radius: 40.0,
                }))],
                Vec::new(),
            );
            // Secondary uniform blur with sigma = 144 (< 3 * 64 = 192, >= 128) -> routes to mid tier.
            let mid_blur = make_record(
                [10.0, 10.0],
                vec![Op::BackgroundBlur(Box::new(BackgroundBlurOp {
                    paths: vec![0],
                    even_odd: false,
                    radius: 1.25,
                }))],
                Vec::new(),
            );
            if mid_first {
                engine.store.insert_for_test(1, ROOT, mid_blur);
                engine.store.insert_for_test(2, ROOT, driver);
            } else {
                engine.store.insert_for_test(1, ROOT, driver);
                engine.store.insert_for_test(2, ROOT, mid_blur);
            }
            let view = Camera {
                zoom: 128.0,
                x: 0.0,
                y: 0.0,
                dpr: 2.0,
            }
            .view();
            let crop = Rect::new(0.0, 0.0, 640.0, 384.0);
            let (_, _, plan) = engine.reader_halo_plan(view, Some(crop), true, crate::halo::HALO_REPLAY_SIDE);
            let plan = plan.expect("two-tier halo plan");
            assert!(plan.use_coarse_halo);
            assert!(
                plan.far_divisor >= 32,
                "mid_first={mid_first} far_divisor={}",
                plan.far_divisor
            );
            assert_eq!(
                plan.mid_divisor,
                Some(8),
                "mid_first={mid_first}: mid tier must stay compact (d_mid=8) even under a later far driver"
            );
        }
    }

    #[test]
    fn narrow_blur_keeps_whole_frame_padding_without_entering_coarse_halo() {
        let mut engine = Engine::new(Limits::default());
        let narrow = make_record(
            [156.0, 160.0],
            vec![Op::BackgroundBlur(Box::new(BackgroundBlurOp {
                paths: vec![0],
                even_odd: false,
                radius: 48.0,
            }))],
            Vec::new(),
        );
        engine.store.insert_for_test(1, ROOT, narrow);
        let view = Camera {
            zoom: 1.0,
            x: -20.0,
            y: 0.0,
            dpr: 1.0,
        }
        .view();
        let crop = Rect::new(0.0, 0.0, 224.0, 224.0);
        let (_, _, plan) = engine.reader_halo_plan(view, Some(crop), true, crate::halo::HALO_REPLAY_SIDE);
        let plan = plan.expect("narrow whole-frame padding");
        assert!(!plan.use_coarse_halo);
        assert!(plan.samples.x0 < 0, "must pad left of viewport: {:?}", plan.samples);
    }

    #[test]
    fn feature_scale_skips_supersample_for_coarse_backdrop_and_enables_it_for_fine_detail() {
        use crate::record::{Paint, StrokeStyle};
        // Bench-style coarse backdrop (5-unit bar = 100 px at scale 20) + 1-unit stroke AFTER blur.
        let mut coarse = Engine::new(Limits::default());
        let bar = make_record(
            [200.0, 5.0],
            vec![Op::Fill {
                path: 0,
                even_odd: false,
                paint: Paint::Solid([0.1, 0.2, 0.8, 1.0]),
                blend: 0,
            }],
            Vec::new(),
        );
        let blur = make_record(
            [200.0, 200.0],
            vec![Op::BackgroundBlur(Box::new(BackgroundBlurOp {
                paths: vec![0],
                even_odd: false,
                radius: 40.0,
            }))],
            Vec::new(),
        );
        let after_stroke = make_record(
            [200.0, 200.0],
            vec![Op::Stroke {
                path: 0,
                style: Box::new(StrokeStyle {
                    width: 1.0,
                    cap: 0,
                    join: 0,
                    miter: 4.0,
                    dashes: Vec::new(),
                    dash_offset: 0.0,
                }),
                paint: Paint::Solid([1.0, 1.0, 1.0, 1.0]),
                blend: 0,
                cache: crate::stroke::StrokeCache::new(),
            }],
            Vec::new(),
        );
        coarse.store.insert_for_test(1, ROOT, bar);
        coarse.store.insert_for_test(2, ROOT, blur.clone());
        coarse.store.insert_for_test(3, ROOT, after_stroke);
        let view = Camera {
            zoom: 10.0,
            x: 0.0,
            y: 0.0,
            dpr: 2.0,
        }
        .view();
        let crop = Rect::new(0.0, 0.0, 2880.0, 1800.0);
        let (_, _, plan) = coarse.reader_halo_plan(view, Some(crop), true, crate::halo::HALO_REPLAY_SIDE);
        let plan = plan.expect("coarse halo plan");
        assert!(plan.use_coarse_halo);
        // Feature width before blur is 5 * 20 = 100 px (the 1-unit stroke is AFTER the blur).
        assert!(
            (plan.far_min_feature_px - 100.0).abs() < 0.5,
            "far_min_feature_px={}",
            plan.far_min_feature_px
        );
        assert_eq!(
            crate::halo::choose_supersample(plan.far_divisor, (768, 768), plan.far_min_feature_px, 4096, 12_000_000),
            1
        );

        // Fine 0.5-unit stripe (10 px at scale 20) BEFORE blur forces supersampling.
        let mut fine = Engine::new(Limits::default());
        let thin = make_record(
            [200.0, 0.5],
            vec![Op::Fill {
                path: 0,
                even_odd: false,
                paint: Paint::Solid([0.0, 0.0, 0.0, 1.0]),
                blend: 0,
            }],
            Vec::new(),
        );
        fine.store.insert_for_test(1, ROOT, thin);
        fine.store.insert_for_test(2, ROOT, blur);
        let (_, _, fine_plan) = fine.reader_halo_plan(view, Some(crop), true, crate::halo::HALO_REPLAY_SIDE);
        let fine_plan = fine_plan.expect("fine halo plan");
        assert!(
            (fine_plan.far_min_feature_px - 10.0).abs() < 0.5,
            "fine_plan.far_min_feature_px={}",
            fine_plan.far_min_feature_px
        );
        assert!(
            crate::halo::choose_supersample(
                fine_plan.far_divisor,
                (768, 768),
                fine_plan.far_min_feature_px,
                4096,
                12_000_000
            ) >= 2
        );
    }

    #[test]
    fn glass_over_wide_blur_pulls_sub_far_blur_into_mid_tier() {
        use crate::record::GlassOp;
        let mut engine = Engine::new(Limits::default());
        let blur = make_record(
            [52.0, 100.0],
            vec![Op::ProgressiveBlur(Box::new(ProgressiveBlurOp {
                paths: vec![0],
                even_odd: false,
                start_radius: 0.0,
                end_radius: 56.0,
                start: [0.0, 0.0],
                end: [0.0, 1.0],
            }))],
            Vec::new(),
        );
        let mut glass = make_record(
            [26.0, 30.0],
            vec![Op::Glass(Box::new(GlassOp {
                paths: vec![0],
                even_odd: false,
                kind: crate::glass::KIND_BOX,
                inradius: 13.0,
                angle: -45.0,
                intensity: 80.0,
                refraction: 80.0,
                depth: 20.0,
                dispersion: 50.0,
                frost: 4.0,
                splay: 0.0,
                box_radii: [4.0; 4],
                box_smoothing: [0.0; 4],
                measured_inradius: std::cell::Cell::new(-1.0),
            }))],
            Vec::new(),
        );
        glass.transform = Affine::translate((13.0, 55.0));
        engine.store.insert_for_test(1, ROOT, blur);
        engine.store.insert_for_test(2, ROOT, glass);

        let view = Camera {
            zoom: 5.0,
            x: -0.4 * 5.0,
            y: -68.0 * 5.0,
            dpr: 2.0,
        }
        .view();
        let crop = Rect::new(0.0, 0.0, 512.0, 320.0);
        let (_, _, plan) = engine.reader_halo_plan(view, Some(crop), true, 50);
        let plan = plan.expect("glass over blur plan");
        assert_eq!(plan.far_divisor, 64);
        assert!(
            plan.mid_divisor.is_some_and(|d| d < plan.far_divisor),
            "mid_divisor={:?}",
            plan.mid_divisor
        );
        assert!(
            plan.downstream_mid_readers.contains(&(1, 0)),
            "upstream blur must run in mid tier for stacked glass"
        );
    }

    #[test]
    fn unfilled_clip_frame_records_clamp_clip_for_coarse_blur() {
        use crate::record::Paint;
        let mut unfilled = Engine::new(Limits::default());
        let clip_frame = make_record(
            [40.0, 200.0],
            vec![
                Op::Clip {
                    path: 0,
                    even_odd: false,
                },
                Op::Children,
                Op::Unclip,
            ],
            Vec::new(),
        );
        let blur = make_record(
            [52.0, 100.0],
            vec![Op::BackgroundBlur(Box::new(BackgroundBlurOp {
                paths: vec![0],
                even_odd: false,
                radius: 56.0,
            }))],
            Vec::new(),
        );
        unfilled.store.insert_for_test(1, ROOT, clip_frame);
        unfilled.store.insert_for_test(2, 1, blur.clone());

        let view = Camera {
            zoom: 5.0,
            x: 0.0,
            y: 0.0,
            dpr: 2.0,
        }
        .view();
        let crop = Rect::new(0.0, 0.0, 512.0, 320.0);
        let (_, _, plan) = unfilled.reader_halo_plan(view, Some(crop), true, 50);
        let plan = plan.expect("unfilled clip halo plan");
        assert_eq!(plan.clamp_clips.len(), 1);
        assert_eq!(plan.clamp_clips[0].reader_key, (2, 0));

        // Solid-fill clip uses EdgeMode::Border subtexel prefiltering, not clamp edge strips.
        let mut filled = Engine::new(Limits::default());
        let solid_frame = make_record(
            [40.0, 200.0],
            vec![
                Op::Fill {
                    path: 0,
                    even_odd: false,
                    paint: Paint::Solid([1.0, 0.9, 0.8, 1.0]),
                    blend: 0,
                },
                Op::Clip {
                    path: 0,
                    even_odd: false,
                },
                Op::Children,
                Op::Unclip,
            ],
            Vec::new(),
        );
        filled.store.insert_for_test(1, ROOT, solid_frame);
        filled.store.insert_for_test(2, 1, blur);
        let (_, _, filled_plan) = filled.reader_halo_plan(view, Some(crop), true, 50);
        assert!(filled_plan.expect("filled clip plan").clamp_clips.is_empty());
    }

    #[test]
    fn glass_mid_tier_admission_skips_offscreen_sub_far_stops() {
        use crate::record::GlassOp;
        // A glass lens deep in the far-only part of a progressive blur: the blur's sub-far stops
        // lie thousands of device pixels off-screen, outside the lens's visible read area, so
        // they must not pull the blur into the mid tier (F3).
        let mut engine = Engine::new(Limits::default());
        let mut prog = make_record(
            [420.0, 320.0],
            vec![Op::ProgressiveBlur(Box::new(ProgressiveBlurOp {
                paths: vec![0],
                even_odd: false,
                start_radius: 0.0,
                end_radius: 120.0,
                start: [0.0, 0.0],
                end: [0.0, 1.0],
            }))],
            Vec::new(),
        );
        prog.transform = Affine::translate((420.0, 240.0));
        let mut glass = make_record(
            [480.0, 320.0],
            vec![Op::Glass(Box::new(GlassOp {
                paths: vec![0],
                even_odd: false,
                kind: crate::glass::KIND_BOX,
                inradius: 160.0,
                angle: -45.0,
                intensity: 80.0,
                refraction: 80.0,
                depth: 20.0,
                dispersion: 50.0,
                frost: 4.0,
                splay: 0.0,
                box_radii: [32.0; 4],
                box_smoothing: [0.0; 4],
                measured_inradius: std::cell::Cell::new(-1.0),
            }))],
            Vec::new(),
        );
        glass.transform = Affine::translate((360.0, 240.0));
        engine.store.insert_for_test(1, ROOT, prog);
        engine.store.insert_for_test(2, ROOT, glass);
        // 2,500% centred on (600, 400) in a 2,880 x 1,800 view at DPR 2.
        let zoom = 25.0;
        let view = Camera {
            zoom,
            x: 1440.0 / 2.0 - 600.0 * zoom,
            y: 900.0 / 2.0 - 400.0 * zoom,
            dpr: 2.0,
        }
        .view();
        let crop = Rect::new(0.0, 0.0, 2880.0, 1800.0);
        let (_, _, plan) = engine.reader_halo_plan(view, Some(crop), true, crate::halo::HALO_REPLAY_SIDE);
        let plan = plan.expect("2,500% glass over progressive blur plan");
        assert!(plan.far_divisor >= 32, "far divisor {}", plan.far_divisor);
        assert!(
            !plan.downstream_mid_readers.contains(&(1, 0)),
            "an off-screen sub-far progressive stop must not join the mid tier: {:?}",
            plan.downstream_mid_readers
        );
    }
}
