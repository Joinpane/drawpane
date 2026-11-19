//! The engine, without the WebAssembly boundary (`lib.rs` wraps it): the render graph, the CPU
//! backend and, in the browser build, the GPU backend.

use crate::cpu::Cpu;
use crate::error::{EngineError, ErrorCode, Result};
use crate::exec::{self, DrawStats, Frame, IRect};
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
    for p in px.as_chunks_mut::<4>().0.iter_mut() {
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

pub struct Engine {
    pub store: Store,
    /// Changes whenever what's drawn may have (a message applied, an image put or dropped): a
    /// frame made from the last one is valid only within one generation.
    pub generation: u64,
    pub cpu: Cpu,
    /// The band being exported.
    band: Vec<u8>,
    #[cfg(feature = "gpu")]
    pub gpu: Option<crate::gpu::Gpu>,
    /// Image uploads kept as levels, so a GPU attached later (or rebuilt after a device loss)
    /// gets them without asking TypeScript again.
    #[cfg(feature = "gpu")]
    pub image_levels: std::collections::HashMap<u32, std::rc::Rc<Vec<images::Level>>>,
    /// Tiles on the CPU, once asked for (tests; a Worker's view mode).
    pub cpu_tiles: Option<CpuTiles>,
}

impl Engine {
    pub fn new(limits: Limits) -> Self {
        Self {
            generation: 0,
            band: Vec::new(),
            cpu: Cpu::new(limits.glyph_mask_bytes, limits.glyph_mask_side),
            store: Store::new(limits),
            #[cfg(feature = "gpu")]
            gpu: None,
            #[cfg(feature = "gpu")]
            image_levels: std::collections::HashMap::new(),
            cpu_tiles: None,
        }
    }

    /// Marks stale every tile, on every backend, that changes reach: each level's tiles under
    /// where the changed records painted before and paint now, grown for anti-aliasing, and
    /// every reader they reach, transitively (`Store::dirty`). A fresh list drops them all, and
    /// the last frame with them: it shows a page that's gone.
    fn invalidate_tiles(&mut self, changes: &[Dirty], full: bool) {
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
                let rects: Vec<Rect> = store.dirty(changes, level.grid(), 1.5);
                cache.invalidate(id, &rects);
            }
        };
        if let Some(t) = self.cpu_tiles.as_mut() {
            each(&mut t.cache);
            if full {
                t.forget();
            }
        }
        #[cfg(feature = "gpu")]
        if let Some(g) = self.gpu.as_mut() {
            each(&mut g.tiles);
            if full {
                g.forget_last();
            }
        }
    }

    /// Keeps tiles on the CPU of `tile` device pixels a side, at most `max_slots` at once.
    pub fn use_cpu_tiles(&mut self, tile: u32, max_slots: usize) {
        self.cpu_tiles = Some(CpuTiles::new(tile, max_slots));
    }

    pub fn limits(&self) -> &Limits {
        &self.store.limits
    }

    pub fn apply(&mut self, bytes: &[u8]) -> Result<Applied> {
        let applied = self.store.apply(bytes)?;
        self.generation += 1;
        self.invalidate_tiles(&applied.changes, applied.full);
        Ok(applied)
    }

    /// Marks stale what shows image `id` (its pixels are about to change or go).
    fn invalidate_image(&mut self, id: u32) {
        let users = self.store.image_users(id);
        if !users.is_empty() {
            self.invalidate_tiles(&users, false);
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
        self.generation += 1;
        self.invalidate_image(id);
        let levels = images::levels(width, height, rgba, premultiplied, limits.texture_side)?;
        self.cpu.put_image(id, &levels, limits.image_bytes)?;
        #[cfg(feature = "gpu")]
        {
            let levels = std::rc::Rc::new(levels);
            if let Some(gpu) = self.gpu.as_mut() {
                gpu.put_image(id, &levels, limits.image_bytes)?;
            }
            self.image_levels.insert(id, levels);
        }
        Ok(())
    }

    pub fn drop_image(&mut self, id: u32) {
        self.generation += 1;
        self.invalidate_image(id);
        self.cpu.drop_image(id);
        #[cfg(feature = "gpu")]
        {
            self.image_levels.remove(&id);
            if let Some(gpu) = self.gpu.as_mut() {
                gpu.drop_image(id);
            }
        }
    }

    /// Refuses a page holding a shown record the engine doesn't draw, wherever it is: the caller
    /// draws the whole page another way.
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

    /// Refuses an export of a `width` × `height` frame before it starts when its working set
    /// wouldn't fit beside what the engine holds, under `Limits::memory_bytes` (a Worker's cap;
    /// zero: no check). The working set is a band of output, a tile of target (with the readers'
    /// reach round it), the scene's rows, and the compressor.
    pub fn admit_export(&self, width: u32, height: u32, camera: Camera) -> Result<()> {
        self.check_size(width, height)?;
        camera.check()?;
        self.check_supported()?;
        let budget = self.store.limits.memory_bytes;
        if budget == 0 {
            return Ok(());
        }
        let l = &self.store.limits;
        let rows = self.band_rows(width) as usize;
        let halo = self.halo(camera.view())? as usize;
        let cols = (l.export_tile.min(width) as usize + 2 * halo).min(width as usize);
        let tile_rows = (rows + 2 * halo).min(height as usize);
        let band = rows * width as usize * 4;
        // A tile's target and a copy of it for the PNG's straight pixels.
        let tile = cols * tile_rows * 4 * 2;
        // vello_cpu keeps per wide tile (256 × 4 px) command lists for the whole frame.
        let scene = (width as usize).div_ceil(256) * (height as usize).div_ceil(4) * 64;
        let png = 512 * 1024;
        let need = band + tile + scene + png;
        let held = self.held_bytes();
        if held + need > budget {
            return Err(EngineError::limit(format!(
                "an export {width} × {height} px needs {} MiB beside the {} MiB the engine holds; it may hold {} MiB",
                need.div_ceil(1 << 20),
                held.div_ceil(1 << 20),
                budget >> 20
            )));
        }
        Ok(())
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

    /// Draws the whole frame on the CPU: premultiplied RGBA8, `width` × `height`.
    pub fn render_cpu(
        &mut self,
        width: u32,
        height: u32,
        camera: Camera,
        background: [f32; 4],
        detail: bool,
    ) -> Result<(&[u8], FrameStats)> {
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
        )?;
        Ok((self.cpu.target.data_as_u8_slice(), stats))
    }

    /// Attaches a GPU, uploading the images already held so it can draw everything at once.
    #[cfg(feature = "gpu")]
    pub fn attach_gpu(&mut self, mut gpu: crate::gpu::Gpu) -> Result<()> {
        let budget = self.store.limits.image_bytes;
        gpu.budget = self.store.limits.gpu_bytes;
        for (id, levels) in &self.image_levels {
            gpu.put_image(*id, levels, budget)?;
        }
        self.gpu = Some(gpu);
        Ok(())
    }

    /// Draws tiles on the GPU for the next frame of the view last drawn, for at most
    /// `budget_ms` (`Gpu::ahead`): what a browser runs between frames at rest.
    #[cfg(feature = "gpu")]
    pub fn render_gpu_ahead(&mut self, background: [f32; 4], budget_ms: f64) -> Result<DrawStats> {
        self.check_supported()?;
        let gpu = self
            .gpu
            .as_ref()
            .ok_or_else(|| EngineError::new(ErrorCode::State, "no GPU attached"))?;
        let Some(last) = gpu.last() else {
            return Ok(DrawStats::default());
        };
        let halo = self.halo(last.view)?;
        let gpu = self
            .gpu
            .as_mut()
            .ok_or_else(|| EngineError::new(ErrorCode::State, "no GPU attached"))?;
        gpu.ahead(&self.store, background, halo, budget_ms)
    }

    /// Draws a frame on the GPU, made of tiles (into its canvas, when it has one).
    #[cfg(feature = "gpu")]
    pub fn render_gpu(
        &mut self,
        width: u32,
        height: u32,
        camera: Camera,
        background: [f32; 4],
        options: TiledOptions,
    ) -> Result<DrawStats> {
        self.check_size(width, height)?;
        camera.check()?;
        self.check_supported()?;
        let view = camera.view();
        let halo = self.halo(view)?;
        let gpu = self
            .gpu
            .as_mut()
            .ok_or_else(|| EngineError::new(ErrorCode::State, "no GPU attached"))?;
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
        gpu.render(&self.store, &frame, background, self.generation, halo, options)
    }

    /// Device pixels the readers on the page may read past where they paint, summed through
    /// readers reading readers (conservatively: every reader's reach added up).
    pub fn halo(&self, view: Affine) -> Result<i32> {
        let mut total = 0.0f64;
        for id in self.store.readers() {
            let Some(node) = self.store.nodes.get(id) else { continue };
            if let Some(h) = node.record.reads() {
                let m = view * self.store.world(*id);
                // The reach on the device, as a box around a rotated or sheared one grows it,
                // and a pixel each way for rounding to whole pixels.
                let [a, b, c, d, _, _] = m.as_coeffs();
                let reach = f64::from(h) * (a.abs() + c.abs()).max(b.abs() + d.abs());
                total += reach.ceil() + 2.0;
            }
        }
        if total > f64::from(self.store.limits.halo) {
            return Err(EngineError::limit(format!(
                "backdrop readers reach {total:.0} px past a band; the most is {}",
                self.store.limits.halo
            )));
        }
        Ok(total.ceil() as i32)
    }

    /// Draws `area` of a `width` × `height` frame into the CPU target, extended by the readers'
    /// reach each way so what they read is drawn; answers the extended area.
    fn cpu_tile(
        &mut self,
        width: u32,
        height: u32,
        camera: Camera,
        background: [f32; 4],
        detail: bool,
        area: IRect,
    ) -> Result<(FrameStats, IRect)> {
        let view = camera.view();
        let halo = self.halo(view)?;
        let grown = IRect {
            x0: area.x0 - halo,
            y0: area.y0 - halo,
            x1: area.x1 + halo,
            y1: area.y1 + halo,
        }
        .clamp(width as i32, height as i32);
        self.cpu.halo = halo;
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
        let side = tile as i32 + 2 * halo;
        let area = IRect {
            x0: 0,
            y0: 0,
            x1: side,
            y1: side,
        };
        self.cpu.halo = halo;
        self.cpu.begin(side as u16, side as u16, area, premultiply(background));
        let frame = Frame {
            width: side as u16,
            height: side as u16,
            view: Affine::translate((f64::from(halo), f64::from(halo))) * view,
            detail,
            area,
        };
        let limits = self.store.limits;
        let draw = exec::draw(&self.store, &mut self.cpu, &frame, &limits);
        self.cpu.finish();
        Ok(FrameStats {
            draw: draw?,
            masks: self.cpu.masks.stats,
        })
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
        self.check_size(width, height)?;
        camera.check()?;
        self.check_supported()?;
        if self.cpu_tiles.is_none() {
            self.use_cpu_tiles(crate::tiles::TILE, 256);
        }
        let view = camera.view();
        let halo = self.halo(view)?;
        let mut tiles = self.cpu_tiles.take().expect("made above");
        let result = self.cpu_tiled_frame(&mut tiles, width, height, view, halo, background, options);
        self.cpu_tiles = Some(tiles);
        let stats = result?;
        Ok((self.cpu_tiles.as_ref().map_or(&[][..], |t| t.frame.as_slice()), stats))
    }

    /// Draws tiles on the CPU for the next frame of the view last drawn (`Gpu::ahead`'s twin,
    /// at most `max_jobs` tiles): what the tests hold the GPU's idle drawing to.
    pub fn render_cpu_ahead(&mut self, background: [f32; 4], max_jobs: usize) -> Result<TiledStats> {
        self.check_supported()?;
        let Some(mut tiles) = self.cpu_tiles.take() else {
            return Ok(TiledStats::default());
        };
        let result = (|| {
            let mut stats = TiledStats::default();
            let Some(last) = tiles.last else { return Ok(stats) };
            let halo = self.halo(last.view)?;
            let tile = tiles.cache.tile;
            tiles.cache.begin(background, halo);
            let Some(plan) = tiles.cache.plan(last.view, last.size, false, Some(last), true) else {
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
                tiles.cache.drawn(job.key, slot, !job.detail || fs.draw.exact());
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
        tiles.cache.begin(background, halo);
        let scale = view.as_coeffs()[0];
        let zooming = options.moving && tiles.last_scale.is_some_and(|s| s != scale);
        let last = tiles.last;
        let plan = tiles
            .cache
            .plan(view, (width, height), zooming, last, options.prefetch)
            .ok_or_else(|| EngineError::limit("a camera the tiles can't follow (too far out)"))?;
        let mut stats = TiledStats {
            direct: plan.direct,
            ..TiledStats::default()
        };
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
            let exact = !job.detail || fs.draw.exact();
            let s = slot as usize;
            if tiles.slots.len() <= s {
                tiles.slots.resize_with(s + 1, Vec::new);
            }
            take(self.cpu.target.data_as_u8_slice(), &mut tiles.slots[s]);
            tiles.cache.drawn(job.key, slot, exact);
        }
        let mut comp_exact = true;
        if !plan.direct {
            let comp = tiles.cache.compose(&plan, last);
            comp_exact = comp.exact;
            stats.pending = comp.pending;
            if !comp.complete {
                if let (Some(m), Some(l)) = (comp.base, last) {
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
            exact_direct &= !job.detail || fs.draw.exact();
            take(self.cpu.target.data_as_u8_slice(), &mut scratch);
            let fx = i64::from(job.key.i) * i64::from(tile) + plan.origin.0;
            let fy = i64::from(job.key.j) * i64::from(tile) + plan.origin.1;
            blit(&mut frame, width, height, &scratch, t, fx, fy);
        }
        stats.exact = comp_exact && exact_direct;
        stats.direct = plan.direct || !late.is_empty();
        stats.evicted = tiles.cache.stats.evicted;
        stats.held = tiles.cache.len() as u32;
        tiles.frame_last.clone_from(&frame);
        tiles.frame = frame;
        tiles.last = Some(Last {
            view,
            size: (width, height),
        });
        tiles.last_scale = Some(scale);
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
        self.check_size(width, height)?;
        camera.check()?;
        self.check_supported()?;
        let most = self.band_rows(width);
        if rows == 0 || rows > most || y0.checked_add(rows).is_none_or(|end| end > height) {
            return Err(EngineError::new(
                ErrorCode::Limit,
                format!(
                    "a band of {rows} rows at {y0} in a frame {height} tall; bands {width} px wide are at most {most} rows"
                ),
            ));
        }
        let stride = width as usize * 4;
        let mut band = std::mem::take(&mut self.band);
        band.clear();
        band.resize(stride * rows as usize, 0);
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
                let (_, grown) = self.cpu_tile(width, height, camera, background, false, area)?;
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
        self.render_band(width, height, camera, background, y0, rows)?;
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
