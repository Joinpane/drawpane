//! Drawpane's render engine (decision 0040): a retained render graph, patched by display-list
//! messages from TypeScript, drawn by Vello on the CPU (every build) and on the GPU through
//! WebGPU (the browser build, feature `gpu`).
//!
//! The WebAssembly boundary is this file. Every call answers an `Outcome`: success, or an error
//! code and message. Nothing panics across it: inputs are validated (`wire.rs`, `record.rs`),
//! sizes are limited (`limits.rs`), and the fuzz tests (`tests/fuzz.rs`) hold that.

pub mod blend;
pub mod blur;
#[cfg(any(feature = "compute", test))]
pub mod compute_caps;
// Pure Rust, built everywhere so the integration tests can check a patched encoding against a
// fresh one. Only the compute module calls these, and the other builds drop them.
pub mod compute_moves;
pub mod cpu;
pub mod diamond;
pub mod engine;
pub mod error;
pub mod exec;
pub mod geometry;
pub mod glass;
pub mod glyphs;
#[cfg(feature = "gpu-common")]
pub mod gpu;
#[cfg(feature = "gpu-common")]
pub mod gpu_readers;
pub mod halo;
pub mod images;
pub mod kernels;
pub mod limits;
pub mod mask;
pub mod masks;
pub mod noise;
pub mod ordinary;
pub mod png;
pub mod progressive_blur;
pub mod record;
pub mod shadow;
pub mod store;
pub mod stroke;
pub mod texture;
pub mod tiles;
#[cfg(feature = "compute")]
pub mod vello_compute;
pub mod wire;

use engine::{Camera, Engine as Core};
use error::EngineError;
use limits::Limits;
use wasm_bindgen::prelude::*;

/// What a call did: `ok`, or an error `code` (`ErrorCode`) and `message`.
#[wasm_bindgen]
pub struct Outcome {
    pub ok: bool,
    pub code: u32,
    message: String,
    /// Dirty rectangles in page units (x0, y0, x1, y1 each), after `apply`.
    dirty: Vec<f64>,
    /// A reset: everything is dirty.
    pub full: bool,
    /// Counts for the frame, after a render.
    pub records: u32,
    pub culled: u32,
    pub glyphs_masked: u32,
    pub glyphs_outlined: u32,
    pub reads: u32,
    pub mask_hits: f64,
    pub mask_misses: f64,
    pub mask_bytes: f64,
    /// Records drawn coarse (unreadable text as bars) and skipped as specks: a frame with
    /// either is a level-of-detail stand-in, not exact.
    pub coarse: u32,
    pub specks: u32,
    /// Effects drawn on a reduced grid (a layer blur past the native limits), or visible tiles
    /// holding one: the frame isn't exact, and nothing more will make it so.
    pub reduced: u32,
    /// The frame reached the canvas (a GPU frame with a canvas; always true otherwise).
    pub presented: bool,
    /// Something on screen stands in for what isn't drawn yet: not exact.
    pub standin: bool,
    /// How a GPU frame was made: 0 from its tiles, 1 with stand-ins, 2 direct, 3 unchanged.
    pub plan: u32,
    /// A frame made of tiles that is exactly what a fresh engine draws.
    pub exact: bool,
    /// Tiles drawn this frame, still stale or missing on screen, held, and evicted.
    pub tiles_drawn: u32,
    pub pending: u32,
    pub queued: u32,
    pub held: u32,
    /// Tiles a drag composited this frame (decision 0040, "Dragging").
    pub dragged: u32,
    pub evicted: u32,
    /// Its CPU time (milliseconds): encoding, the renderer's preparing and uploading,
    /// presenting and submitting, and all.
    pub encode_ms: f64,
    pub render_ms: f64,
    pub submit_ms: f64,
    pub cpu_ms: f64,
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
    pub in_progress: bool,
}

#[wasm_bindgen]
impl Outcome {
    #[wasm_bindgen(getter)]
    pub fn message(&self) -> String {
        self.message.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn dirty(&self) -> Vec<f64> {
        self.dirty.clone()
    }
}

impl Outcome {
    fn ok() -> Self {
        Self {
            ok: true,
            code: 0,
            message: String::new(),
            dirty: Vec::new(),
            full: false,
            records: 0,
            culled: 0,
            glyphs_masked: 0,
            glyphs_outlined: 0,
            reads: 0,
            mask_hits: 0.0,
            mask_misses: 0.0,
            mask_bytes: 0.0,
            coarse: 0,
            reduced: 0,
            specks: 0,
            presented: true,
            standin: false,
            plan: 0,
            exact: false,
            tiles_drawn: 0,
            pending: 0,
            queued: 0,
            held: 0,
            dragged: 0,
            evicted: 0,
            encode_ms: 0.0,
            render_ms: 0.0,
            submit_ms: 0.0,
            cpu_ms: 0.0,
            prepare_masks_ms: 0.0,
            vello_render_ms: 0.0,
            reader_ms: 0.0,
            shadow_ms: 0.0,
            submits: 0,
            draws: 0,
            vello_renders: 0,
            glass_ops: 0,
            glass_batched: 0,
            bg_blur_ops: 0,
            shadow_ops: 0,
            shadow_hits: 0,
            in_progress: false,
        }
    }
    fn err(e: EngineError) -> Self {
        Self {
            ok: false,
            code: e.code as u32,
            message: e.message,
            ..Self::ok()
        }
    }
    fn stats(s: engine::FrameStats) -> Self {
        Self {
            records: s.draw.records,
            culled: s.draw.culled,
            glyphs_masked: s.draw.glyphs_masked,
            glyphs_outlined: s.draw.glyphs_outlined,
            reads: s.draw.reads,
            mask_hits: s.masks.hits as f64,
            mask_misses: s.masks.misses as f64,
            mask_bytes: s.masks.bytes as f64,
            coarse: s.draw.coarse,
            specks: s.draw.specks,
            reduced: s.draw.reduced,
            ..Self::ok()
        }
    }
}

fn outcome(r: error::Result<()>) -> Outcome {
    match r {
        Ok(()) => Outcome::ok(),
        Err(e) => Outcome::err(e),
    }
}

/// The display-list versions this build reads: major, then the highest minor.
#[wasm_bindgen(js_name = listVersion)]
pub fn list_version() -> Vec<u32> {
    vec![u32::from(wire::MAJOR), u32::from(wire::MINOR)]
}

/// Bytes of WebAssembly memory now (it only grows, so after a render it's the peak).
#[wasm_bindgen(js_name = memoryBytes)]
pub fn memory_bytes() -> f64 {
    #[cfg(target_arch = "wasm32")]
    {
        (core::arch::wasm32::memory_size(0) * 65536) as f64
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        0.0
    }
}

/// Whether this build draws on the GPU.
#[wasm_bindgen(js_name = hasGpu)]
pub fn has_gpu() -> bool {
    cfg!(feature = "gpu-common")
}

/// Which GPU backend this build uses: `"webgpu"`, `"webgl2"`, or `""` (CPU-only build).
#[wasm_bindgen(js_name = gpuBackend)]
pub fn gpu_backend() -> String {
    if cfg!(feature = "webgl") {
        "webgl2".to_string()
    } else if cfg!(feature = "gpu") {
        "webgpu".to_string()
    } else {
        String::new()
    }
}

#[wasm_bindgen]
pub struct Engine {
    core: Core,
    pixels: Vec<u8>,
    png: Option<ActivePng>,
    changes: Vec<store::Dirty>,
    /// The last gated compute frame's check (`presentComputeFrame`), until taken.
    #[cfg(feature = "compute")]
    gate_check: Option<js_sys::Promise>,
}

struct ActivePng {
    encoder: png::BandPng,
    camera: Camera,
    band_rows: u32,
}

#[wasm_bindgen]
impl Engine {
    /// An engine with the default limits; `glyph_mask_bytes` and `image_bytes` override two
    /// budgets when non-zero.
    #[wasm_bindgen(constructor)]
    pub fn new(glyph_mask_bytes: u32, image_bytes: u32) -> Engine {
        let mut limits = Limits::default();
        if glyph_mask_bytes > 0 {
            limits.glyph_mask_bytes = glyph_mask_bytes as usize;
        }
        if image_bytes > 0 {
            limits.image_bytes = image_bytes as usize;
        }
        Engine {
            core: Core::new(limits),
            pixels: Vec::new(),
            png: None,
            changes: Vec::new(),
            #[cfg(feature = "compute")]
            gate_check: None,
        }
    }

    /// The revision the engine holds (a patch must be made for it).
    #[wasm_bindgen(getter)]
    pub fn revision(&self) -> u32 {
        self.core.store.revision
    }

    /// The drag in progress (decision 0040, "Dragging"): 0 none, 1 drawn at its real position
    /// every frame (no fast path), 2 composited from the page's parts around it.
    #[wasm_bindgen(getter)]
    pub fn dragging(&self) -> u32 {
        match &self.core.dragging {
            None => 0,
            Some(d) if d.split.is_none() => 1,
            Some(_) => 2,
        }
    }

    /// Records held.
    #[wasm_bindgen(getter)]
    pub fn records(&self) -> u32 {
        self.core.store.len() as u32
    }

    /// Glyph outlines held, and their bytes.
    #[wasm_bindgen(getter)]
    pub fn glyphs(&self) -> u32 {
        self.core.store.glyphs.len() as u32
    }
    #[wasm_bindgen(getter, js_name = glyphBytes)]
    pub fn glyph_bytes(&self) -> f64 {
        self.core.store.glyphs.bytes() as f64
    }

    /// Sets a limit by name (`Limits`' fields: `graph_bytes`, `message_bytes`, `image_bytes`,
    /// `glyph_outline_bytes`, `glyph_mask_bytes`, `memory_bytes`, `gpu_bytes`, `tile_bytes`,
    /// `band_bytes`, `frame_verbs`), before anything is applied.
    #[wasm_bindgen(js_name = setLimit)]
    pub fn set_limit(&mut self, name: &str, value: f64) -> Outcome {
        if self.core.store.revision != 0 || !value.is_finite() || value < 0.0 {
            return Outcome::err(EngineError::new(
                error::ErrorCode::State,
                "limits are set before the first message, to a number of zero or more",
            ));
        }
        let v = value as usize;
        let l = &mut self.core.store.limits;
        match name {
            "graph_bytes" => l.graph_bytes = v,
            "message_bytes" => l.message_bytes = v,
            "image_bytes" => l.image_bytes = v,
            "glyph_outline_bytes" => l.glyph_outline_bytes = v,
            "memory_bytes" => {
                let budget = limits::memory_budget(v);
                l.memory_bytes = budget;
                self.core.cpu.set_memory_budget(budget);
            }
            "gpu_bytes" => l.gpu_bytes = v,
            "tile_bytes" => l.tile_bytes = v,
            "band_bytes" => l.band_bytes = v.max(4),
            "frame_verbs" => l.frame_verbs = v,
            "stroke_bytes" => l.stroke_bytes = v,
            "padded_view_pixels" => l.padded_view_pixels = v,
            "glyph_mask_bytes" => {
                l.glyph_mask_bytes = v;
                self.core.cpu.masks.set_budget(v);
            }
            other => {
                return Outcome::err(EngineError::new(error::ErrorCode::State, format!("no limit {other}")));
            }
        }
        Outcome::ok()
    }

    /// Bytes the engine holds, roughly: the graph, images and glyph masks.
    #[wasm_bindgen(getter, js_name = heldBytes)]
    pub fn held_bytes(&self) -> f64 {
        self.core.held_bytes() as f64
    }

    /// Bytes of images held, and the most that may be: the facade refuses an upload past it before
    /// its bytes are copied into the engine's memory.
    #[wasm_bindgen(getter, js_name = imageBytes)]
    pub fn image_bytes(&self) -> f64 {
        self.core.cpu.image_bytes() as f64
    }
    #[wasm_bindgen(js_name = imageHeld)]
    pub fn image_held(&self, id: u32) -> f64 {
        self.core.cpu.held_image(id) as f64
    }
    #[wasm_bindgen(getter, js_name = imageBudget)]
    pub fn image_budget(&self) -> f64 {
        self.core.store.limits.image_bytes as f64
    }
    #[wasm_bindgen(getter, js_name = textureSide)]
    pub fn texture_side(&self) -> u32 {
        self.core.store.limits.texture_side
    }

    /// Rows a band of a frame `width` wide may have.
    #[wasm_bindgen(js_name = bandRows)]
    pub fn band_rows(&self, width: u32) -> u32 {
        self.core.band_rows(width)
    }

    fn exporting(&self) -> Option<Outcome> {
        self.png.as_ref().map(|_| {
            Outcome::err(EngineError::new(
                error::ErrorCode::State,
                "an export is in progress: the engine changes once it ends or is cancelled",
            ))
        })
    }

    /// Applies a display-list message, all or nothing; answers where pixels may have changed.
    /// Refused while an export streams, so an export draws one revision.
    pub fn apply(&mut self, bytes: &[u8]) -> Outcome {
        if let Some(o) = self.exporting() {
            return o;
        }
        match self.core.apply(bytes) {
            Ok(a) => {
                let mut o = Outcome::ok();
                o.full = a.full;
                o.dirty = a
                    .changes
                    .iter()
                    .flat_map(|d| [d.rect.x0, d.rect.y0, d.rect.x1, d.rect.y1])
                    .collect();
                self.changes = a.changes;
                o
            }
            Err(e) => Outcome::err(e),
        }
    }

    /// Where pixels may have changed on the device since the last `apply`, for a camera: the
    /// changed records' places and every backdrop reader they reach, transitively (x0, y0, x1,
    /// y1 each, device pixels).
    #[wasm_bindgen(js_name = dirtyFor)]
    pub fn dirty_for(&mut self, zoom: f64, x: f64, y: f64, dpr: f64) -> Vec<f64> {
        let view = Camera { zoom, x, y, dpr }.view();
        self.core
            .store
            .dirty(&self.changes, view, 1.5)
            .iter()
            .flat_map(|r| [r.x0, r.y0, r.x1, r.y1])
            .collect()
    }

    /// A record's children in paint order (for tests and debugging).
    pub fn children(&self, id: u32) -> Vec<u32> {
        self.core
            .store
            .nodes
            .get(&id)
            .map(|n| n.children.clone())
            .unwrap_or_default()
    }

    /// Records TypeScript flagged as needing what the engine doesn't draw: id and feature bits, in pairs.
    pub fn unsupported(&self) -> Vec<u32> {
        self.core
            .store
            .unsupported()
            .into_iter()
            .flat_map(|(id, bits)| [id, bits])
            .collect()
    }

    #[wasm_bindgen(js_name = clearViewCaches)]
    pub fn clear_view_caches(&mut self) {
        self.core.clear_view_caches();
    }

    #[wasm_bindgen(js_name = enableViewImages)]
    pub fn enable_view_images(&mut self) {
        self.core.store.view_images = true;
    }

    #[wasm_bindgen(js_name = viewImageLimits)]
    pub fn view_image_limits(&self) -> Vec<u32> {
        let limits = self.core.limits();
        #[cfg(feature = "gpu-common")]
        if let Some(gpu) = self.core.gpu.as_ref() {
            let (side, bytes) = gpu.image_limits();
            return vec![side.min(limits.texture_side), bytes.min(limits.image_bytes) as u32];
        }
        vec![limits.texture_side, limits.image_bytes as u32]
    }

    #[wasm_bindgen(js_name = putCpuImageLevel)]
    pub fn put_cpu_image_level(&mut self, id: u32, width: u32, height: u32, rgba: &[u8]) -> Outcome {
        if let Some(o) = self.exporting() {
            return o;
        }
        outcome(self.core.put_cpu_image_level(id, width, height, rgba))
    }

    #[cfg(all(target_arch = "wasm32", feature = "gpu-common"))]
    #[wasm_bindgen(js_name = putGpuImageLevel)]
    pub fn put_gpu_image_level(&mut self, id: u32, bitmap: &web_sys::ImageBitmap) -> Outcome {
        if let Some(o) = self.exporting() {
            return o;
        }
        outcome(self.core.put_gpu_image_level(id, bitmap))
    }

    #[wasm_bindgen(js_name = dropImageLevel)]
    pub fn drop_image_level(&mut self, id: u32, width: u32) -> Outcome {
        if let Some(o) = self.exporting() {
            return o;
        }
        self.core.drop_image_level(id, width);
        Outcome::ok()
    }

    /// Uploads an image (RGBA8, straight unless `premultiplied`) under `id`.
    #[wasm_bindgen(js_name = putImage)]
    pub fn put_image(&mut self, id: u32, width: u32, height: u32, rgba: &[u8], premultiplied: bool) -> Outcome {
        if let Some(o) = self.exporting() {
            return o;
        }
        outcome(self.core.put_image(id, width, height, rgba, premultiplied))
    }

    #[wasm_bindgen(js_name = dropImage)]
    pub fn drop_image(&mut self, id: u32) -> Outcome {
        if let Some(o) = self.exporting() {
            return o;
        }
        self.core.drop_image(id);
        Outcome::ok()
    }

    /// Draws a frame on the CPU; `pixels()` then answers it (straight RGBA8).
    #[allow(clippy::too_many_arguments)]
    #[wasm_bindgen(js_name = renderCpu)]
    pub fn render_cpu(
        &mut self,
        width: u32,
        height: u32,
        zoom: f64,
        x: f64,
        y: f64,
        dpr: f64,
        background: Vec<f32>,
        detail: bool,
    ) -> Outcome {
        if self.core.limits().memory_bytes > 0 {
            self.pixels = Vec::new();
        }
        let bg = rgba(&background);
        match self
            .core
            .render_cpu_into(&mut self.pixels, width, height, Camera { zoom, x, y, dpr }, bg, detail)
        {
            Ok(stats) => {
                engine::unpremultiply(&mut self.pixels);
                Outcome::stats(stats)
            }
            Err(e) => Outcome::err(e),
        }
    }

    /// Keeps tiles on the CPU of `tile` device pixels a side, at most `slots` at once (decision
    /// 0040, phase 2): what `renderCpuTiled` draws from.
    #[wasm_bindgen(js_name = useCpuTiles)]
    pub fn use_cpu_tiles(&mut self, tile: u32, slots: u32) {
        self.core.use_cpu_tiles(tile.clamp(16, 2048), slots as usize);
    }

    /// Draws a frame made of tiles on the CPU, as the GPU makes its frames; `pixels()` then
    /// answers it (straight RGBA8). `max_jobs`: tiles drawn beyond those nothing else can stand
    /// in for (0xffffffff: no limit).
    #[allow(clippy::too_many_arguments)]
    #[wasm_bindgen(js_name = renderCpuTiled)]
    pub fn render_cpu_tiled(
        &mut self,
        width: u32,
        height: u32,
        zoom: f64,
        x: f64,
        y: f64,
        dpr: f64,
        background: Vec<f32>,
        moving: bool,
        max_jobs: u32,
    ) -> Outcome {
        let bg = rgba(&background);
        let options = engine::TiledOptions {
            moving,
            max_jobs: if max_jobs == u32::MAX {
                usize::MAX
            } else {
                max_jobs as usize
            },
            ..engine::TiledOptions::default()
        };
        match self
            .core
            .render_cpu_tiled(width, height, Camera { zoom, x, y, dpr }, bg, options)
        {
            Ok((px, stats)) => {
                self.pixels.clear();
                self.pixels.extend_from_slice(px);
                engine::unpremultiply(&mut self.pixels);
                let mut o = Outcome::stats(engine::FrameStats {
                    draw: stats.draw,
                    masks: self.core.cpu.masks.stats,
                });
                o.exact = stats.exact;
                o.standin = !stats.exact;
                o.plan = if stats.direct {
                    2
                } else if stats.pending > 0 {
                    1
                } else {
                    0
                };
                o.tiles_drawn = stats.tiles_drawn;
                o.pending = stats.pending;
                o.held = stats.held;
                o.evicted = stats.evicted;
                o.dragged = stats.dragged;
                o
            }
            Err(e) => Outcome::err(e),
        }
    }

    /// The last CPU frame or band, straight RGBA8.
    /// Copies directly out of Wasm memory into a JS `Uint8Array` without cloning a second full
    /// framebuffer inside Wasm linear memory.
    #[cfg(target_arch = "wasm32")]
    pub fn pixels(&self) -> js_sys::Uint8Array {
        js_sys::Uint8Array::from(self.pixels.as_slice())
    }

    /// The last CPU frame or band, straight RGBA8.
    #[cfg(not(target_arch = "wasm32"))]
    pub fn pixels(&self) -> Vec<u8> {
        self.pixels.clone()
    }

    /// Draws device rows `y0..y0 + rows` of a large frame on the CPU (see `Engine::render_band`):
    /// `pixels()` then answers just those rows.
    #[allow(clippy::too_many_arguments)]
    #[wasm_bindgen(js_name = renderBand)]
    pub fn render_band(
        &mut self,
        width: u32,
        height: u32,
        zoom: f64,
        x: f64,
        y: f64,
        dpr: f64,
        background: Vec<f32>,
        y0: u32,
        rows: u32,
    ) -> Outcome {
        if self.core.limits().memory_bytes > 0 {
            self.pixels = Vec::new();
        }
        let bg = rgba(&background);
        match self
            .core
            .render_band(width, height, Camera { zoom, x, y, dpr }, bg, y0, rows)
        {
            Ok(px) => {
                self.pixels.clear();
                self.pixels.extend_from_slice(px);
                engine::unpremultiply(&mut self.pixels);
                Outcome::ok()
            }
            Err(e) => Outcome::err(e),
        }
    }

    /// Starts a PNG of a `width` × `height` frame, written band by band (`pngBand`) in bounded
    /// memory: the compressed bytes are taken as they're made (`pngTake`).
    ///
    /// Refused before it starts when the page holds a record the engine doesn't draw (anywhere
    /// on it), when another export is streaming, when total banded rendering work exceeds the
    /// export work bound (all builds), or when the export wouldn't fit the engine's memory budget
    /// (`memory_bytes > 0`, as in Worker builds). Until it ends (`pngEnd`) or is cancelled
    /// (`pngAbort`), the engine refuses changes, so every band draws the same revision.
    #[wasm_bindgen(js_name = pngBegin)]
    #[allow(clippy::too_many_arguments)]
    pub fn png_begin(&mut self, width: u32, height: u32, zoom: f64, x: f64, y: f64, dpr: f64, rows: u32) -> Outcome {
        if let Some(o) = self.exporting() {
            return o;
        }
        if self.core.limits().memory_bytes > 0 {
            self.pixels = Vec::new();
        }
        let camera = Camera { zoom, x, y, dpr };
        let band_rows = match self.core.export_rows(width, height, camera, rows) {
            Ok(rows) => rows,
            Err(e) => return Outcome::err(e),
        };
        match png::BandPng::new(width, height, self.core.limits().texture_side) {
            Ok(encoder) => {
                self.png = Some(ActivePng {
                    encoder,
                    camera,
                    band_rows,
                });
                Outcome::ok()
            }
            Err(e) => Outcome::err(e),
        }
    }

    #[wasm_bindgen(js_name = pngRows)]
    pub fn png_rows(&self) -> u32 {
        self.png.as_ref().map_or(0, |p| p.band_rows)
    }

    #[wasm_bindgen(js_name = checkPng)]
    #[allow(clippy::too_many_arguments)]
    pub fn check_png(&self, width: u32, height: u32, zoom: f64, x: f64, y: f64, dpr: f64, rows: u32) -> Outcome {
        outcome(
            self.core
                .export_rows(width, height, Camera { zoom, x, y, dpr }, rows)
                .map(|_| ()),
        )
    }

    /// Renders the next band of the PNG begun and compresses it.
    #[wasm_bindgen(js_name = pngBand)]
    pub fn png_band(&mut self, background: Vec<f32>) -> Outcome {
        let Some(mut p) = self.png.take() else {
            return Outcome::err(EngineError::new(error::ErrorCode::State, "no PNG begun"));
        };
        let bg = rgba(&background);
        let (w, h, y0) = (p.encoder.width, p.encoder.height, p.encoder.rows_written);
        let rows = p.band_rows.min(h - y0);
        let result = self
            .core
            .render_band_straight_admitted(w, h, p.camera, bg, y0, rows)
            .and_then(|px| p.encoder.write_rows(px, rows));
        match result {
            Ok(()) => {
                self.png = Some(p);
                Outcome::ok()
            }
            // The export ends with its failure: the engine takes changes again.
            Err(e) => Outcome::err(e),
        }
    }

    /// The compressed bytes made since the last take (all of them once the last band is in).
    #[wasm_bindgen(js_name = pngTake)]
    pub fn png_take(&mut self) -> Vec<u8> {
        self.png.as_mut().map(|p| p.encoder.take()).unwrap_or_default()
    }

    /// Ends the PNG: answers its last bytes.
    #[wasm_bindgen(js_name = pngEnd)]
    pub fn png_end(&mut self) -> Vec<u8> {
        self.png.take().map(|p| p.encoder.finish()).unwrap_or_default()
    }

    /// Cancels the PNG begun, letting its memory go.
    #[wasm_bindgen(js_name = pngAbort)]
    pub fn png_abort(&mut self) {
        self.png = None;
    }

    /// Whether an export is streaming.
    #[wasm_bindgen(getter)]
    pub fn exporting_png(&self) -> bool {
        self.png.is_some()
    }

    /// Cached stroke outline statistics across all records:
    /// `[ops_total, ops_cached, input_verbs, expanded_verbs, cached_bytes]`.
    #[wasm_bindgen(js_name = strokeCacheStats)]
    pub fn stroke_cache_stats(&self) -> Vec<f64> {
        let s = self.core.store.stroke_cache_stats();
        vec![
            f64::from(s.ops_total),
            f64::from(s.ops_cached),
            s.input_verbs as f64,
            s.expanded_verbs as f64,
            s.cached_bytes as f64,
        ]
    }

    /// Runs the reference Gaussian blur on premultiplied RGBA8 pixels on the CPU (for conformance
    /// tests): `edge_mode` is 0=Zero, 1=Clamp, 2=Border; `reference` forces the full-resolution
    /// semantic oracle even above `DIRECT_SIGMA_MAX`. On success, premultiplied RGBA8 pixels are
    /// ready in `pixels()`.
    #[allow(clippy::too_many_arguments)]
    #[wasm_bindgen(js_name = blurCpu)]
    pub fn blur_cpu_probe(
        &mut self,
        src: &[u8],
        src_w: u32,
        src_h: u32,
        dst_w: u32,
        dst_h: u32,
        dst_ox: i32,
        dst_oy: i32,
        sigma: f32,
        edge_mode: u32,
        border: Vec<f32>,
        clamp_x0: i32,
        clamp_y0: i32,
        clamp_x1: i32,
        clamp_y1: i32,
        dirty_x0: i32,
        dirty_y0: i32,
        dirty_x1: i32,
        dirty_y1: i32,
        reference: bool,
    ) -> Outcome {
        let max_side = self.core.store.limits.texture_side;
        if src_w == 0 || src_h == 0 || dst_w == 0 || dst_h == 0 {
            return Outcome::err(EngineError::malformed("blur dimensions must be non-zero"));
        }
        if src_w > max_side || src_h > max_side || dst_w > max_side || dst_h > max_side {
            return Outcome::err(EngineError::limit(format!(
                "blur dimensions exceed maximum side {max_side}"
            )));
        }
        let Some(src_bytes) = (src_w as usize)
            .checked_mul(src_h as usize)
            .and_then(|n| n.checked_mul(4))
        else {
            return Outcome::err(EngineError::limit("blur source size overflow"));
        };
        if src.len() != src_bytes {
            return Outcome::err(EngineError::malformed(
                "blur source pixel length does not match dimensions",
            ));
        }
        let Some(dst_bytes) = (dst_w as usize)
            .checked_mul(dst_h as usize)
            .and_then(|n| n.checked_mul(4))
        else {
            return Outcome::err(EngineError::limit("blur destination size overflow"));
        };
        if !sigma.is_finite() || sigma < 0.0 {
            return Outcome::err(EngineError::malformed("blur sigma must be finite and non-negative"));
        }
        let spec = blur_spec_from_args(
            sigma, edge_mode, &border, clamp_x0, clamp_y0, clamp_x1, clamp_y1, dirty_x0, dirty_y0, dirty_x1, dirty_y1,
        );
        let cb = spec.clamp_bounds.clamp(src_w as i32, src_h as i32);
        if let Err(e) = blur::validate_sigma(spec.sigma, cb, spec.edge) {
            return Outcome::err(e);
        }
        let budget = self.core.store.limits.memory_bytes;
        if budget > 0 {
            let held = self.core.held_bytes();
            let extra = if reference {
                let r = blur::kernel_radius(spec.sigma) as usize;
                let ih = (dst_h as usize).saturating_add(r.saturating_mul(2));
                (dst_w as usize).saturating_mul(ih).saturating_mul(16)
            } else {
                // Worst-case level-1 pyramid + scratch working set estimate.
                (src_bytes / 2).saturating_add(dst_bytes)
            };
            if held.saturating_add(dst_bytes).saturating_add(extra) > budget {
                return Outcome::err(EngineError::limit("blur working set exceeds engine memory budget"));
            }
        }
        self.pixels.clear();
        self.pixels.resize(dst_bytes, 0);
        if reference {
            blur::blur_reference(
                src,
                (src_w, src_h),
                &mut self.pixels,
                (dst_w, dst_h),
                (dst_ox, dst_oy),
                &spec,
            );
        } else if let Err(e) = blur::try_blur_cpu(
            src,
            (src_w, src_h),
            &mut self.pixels,
            (dst_w, dst_h),
            (dst_ox, dst_oy),
            &spec,
        ) {
            self.pixels.clear();
            return Outcome::err(e);
        }
        Outcome::ok()
    }
}

#[allow(clippy::too_many_arguments)]
fn blur_spec_from_args(
    sigma: f32,
    edge_mode: u32,
    border: &[f32],
    clamp_x0: i32,
    clamp_y0: i32,
    clamp_x1: i32,
    clamp_y1: i32,
    dirty_x0: i32,
    dirty_y0: i32,
    dirty_x1: i32,
    dirty_y1: i32,
) -> blur::BlurSpec {
    let edge = match edge_mode {
        1 => blur::EdgeMode::Clamp,
        2 => blur::EdgeMode::Border(rgba(border)),
        _ => blur::EdgeMode::Zero,
    };
    blur::BlurSpec {
        sigma: if sigma.is_finite() { sigma.max(0.0) } else { 0.0 },
        edge,
        clamp_bounds: exec::IRect {
            x0: clamp_x0,
            y0: clamp_y0,
            x1: clamp_x1,
            y1: clamp_y1,
        },
        dirty: exec::IRect {
            x0: dirty_x0,
            y0: dirty_y0,
            x1: dirty_x1,
            y1: dirty_y1,
        },
    }
}

/// A failure as a JS value (an `Outcome`), for promises that resolve to one instead of rejecting.
#[cfg(feature = "gpu-common")]
fn failure(e: EngineError) -> JsValue {
    JsValue::from(Outcome::err(e))
}

fn rgba(v: &[f32]) -> [f32; 4] {
    let g = |i: usize| v.get(i).copied().filter(|x| x.is_finite()).unwrap_or(0.0);
    [g(0), g(1), g(2), g(3)]
}

/// A GPU being created: `createGpu` answers one, `Engine.attachGpu` takes its device.
#[cfg(feature = "gpu-common")]
#[wasm_bindgen]
pub struct GpuInit {
    inner: Option<gpu::Gpu>,
    pub ok: bool,
    pub code: u32,
    message: String,
    adapter: String,
    backend: String,
    details: String,
    /// A software adapter (SwiftShader, llvmpipe): its timings say nothing about a GPU.
    pub fallback: bool,
}

#[cfg(feature = "gpu-common")]
#[wasm_bindgen]
impl GpuInit {
    #[wasm_bindgen(getter)]
    pub fn message(&self) -> String {
        self.message.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn adapter(&self) -> String {
        self.adapter.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn backend(&self) -> String {
        self.backend.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn details(&self) -> String {
        self.details.clone()
    }
}

/// Creates a GPU device (WebGPU or WebGL2, per this build's feature), drawing into `canvas`
/// (an `HTMLCanvasElement` or `OffscreenCanvas`), or into nothing (null: frames are only read
/// back). Runs a capability probe (pipelines + small render readback) before succeeding.
#[cfg(feature = "gpu-common")]
#[wasm_bindgen(js_name = createGpu)]
pub async fn create_gpu(canvas: JsValue, glyph_mask_bytes: u32) -> GpuInit {
    use wasm_bindgen::JsCast;
    let limits = Limits::default();
    let target = if let Some(c) = canvas.dyn_ref::<web_sys::HtmlCanvasElement>() {
        gpu::Target::Canvas(c.clone())
    } else if let Some(c) = canvas.dyn_ref::<web_sys::OffscreenCanvas>() {
        gpu::Target::Offscreen(c.clone())
    } else {
        gpu::Target::None
    };
    // By default, as many bytes of glyph masks (kept on the CPU) as the atlas holds: a mask that
    // isn't kept is drawn as its outline, at many times the cost.
    let bytes = if glyph_mask_bytes > 0 {
        glyph_mask_bytes as usize
    } else {
        gpu::ATLAS_BYTES
    };
    match gpu::Gpu::create(target, bytes, limits.glyph_mask_side).await {
        Ok(g) => GpuInit {
            adapter: g.adapter.clone(),
            backend: g.backend.to_string(),
            details: g.details.clone(),
            fallback: g.fallback_adapter,
            inner: Some(g),
            ok: true,
            code: 0,
            message: String::new(),
        },
        Err(e) => GpuInit {
            inner: None,
            ok: false,
            code: e.code as u32,
            message: e.message,
            adapter: String::new(),
            backend: gpu_backend(),
            details: String::new(),
            fallback: false,
        },
    }
}

#[cfg(feature = "gpu-common")]
#[wasm_bindgen]
impl Engine {
    /// Takes the device `init` made (once).
    #[wasm_bindgen(js_name = attachGpu)]
    pub fn attach_gpu(&mut self, init: &mut GpuInit) -> Outcome {
        match init.inner.take() {
            Some(g) => outcome(self.core.attach_gpu(g)),
            None => Outcome::err(EngineError::new(
                error::ErrorCode::State,
                "that GPU was already attached, or failed",
            )),
        }
    }

    #[wasm_bindgen(js_name = detachGpu)]
    pub fn detach_gpu(&mut self) {
        self.core.gpu = None;
    }

    /// Draws a frame on the GPU, made of tiles (decision 0040, phase 2). `moving`: the camera is
    /// moving, so stand-ins may show and a zoom draws no tiles of a passing scale. `budget_ms`:
    /// milliseconds it may spend drawing tiles beyond those nothing else can stand in for (zero:
    /// no limit, so a frame at rest comes back exact). Call again while it isn't exact.
    #[allow(clippy::too_many_arguments)]
    #[wasm_bindgen(js_name = renderGpu)]
    pub fn render_gpu(
        &mut self,
        width: u32,
        height: u32,
        zoom: f64,
        x: f64,
        y: f64,
        dpr: f64,
        background: Vec<f32>,
        moving: bool,
        budget_ms: f64,
        editor_viewport: Option<bool>,
    ) -> Outcome {
        let bg = rgba(&background);
        let options = engine::TiledOptions {
            moving,
            budget_ms: if budget_ms.is_finite() { budget_ms } else { 0.0 },
            ..engine::TiledOptions::default()
        };
        match self.core.render_gpu(
            width,
            height,
            Camera { zoom, x, y, dpr },
            bg,
            options,
            editor_viewport.unwrap_or(false),
        ) {
            Ok(draw) => {
                let masks = self.core.gpu.as_ref().map(|g| g.masks.stats).unwrap_or_default();
                let mut o = Outcome::stats(engine::FrameStats { draw, masks });
                o.presented = draw.presented;
                o.standin = draw.standin;
                o.plan = draw.plan;
                o.exact = draw.exact;
                o.tiles_drawn = draw.tiles_drawn;
                o.pending = draw.pending;
                o.queued = draw.queued;
                o.dragged = draw.dragged;
                o.held = draw.held;
                o.evicted = draw.evicted;
                o.encode_ms = draw.encode_ms;
                o.render_ms = draw.render_ms;
                o.submit_ms = draw.submit_ms;
                o.cpu_ms = draw.cpu_ms;
                o.prepare_masks_ms = draw.prepare_masks_ms;
                o.vello_render_ms = draw.vello_render_ms;
                o.reader_ms = draw.reader_ms;
                o.shadow_ms = draw.shadow_ms;
                o.submits = draw.submits;
                o.draws = draw.draws;
                o.vello_renders = draw.vello_renders;
                o.glass_ops = draw.glass_ops;
                o.glass_batched = draw.glass_batched;
                o.bg_blur_ops = draw.bg_blur_ops;
                o.shadow_ops = draw.shadow_ops;
                o.shadow_hits = draw.shadow_hits;
                o.in_progress = draw.in_progress;
                o
            }
            Err(e) => Outcome::err(e),
        }
    }

    /// Draws tiles for the next frame of the view last drawn, for at most `budget_ms` (at least
    /// one tile), compositing and presenting nothing: what a browser runs between frames at rest
    /// (decision 0040, phase 2). In the answer, `tiles_drawn`; `pending`: tiles the last frame
    /// shows still to draw; `queued`: tiles round it still to draw.
    #[wasm_bindgen(js_name = renderGpuAhead)]
    pub fn render_gpu_ahead(&mut self, background: Vec<f32>, budget_ms: f64) -> Outcome {
        let bg = rgba(&background);
        let budget = if budget_ms.is_finite() { budget_ms } else { 0.0 };
        match self.core.render_gpu_ahead(bg, budget) {
            Ok(draw) => {
                let masks = self.core.gpu.as_ref().map(|g| g.masks.stats).unwrap_or_default();
                let mut o = Outcome::stats(engine::FrameStats { draw, masks });
                o.tiles_drawn = draw.tiles_drawn;
                o.pending = draw.pending;
                o.queued = draw.queued;
                o.held = draw.held;
                o.evicted = draw.evicted;
                o.encode_ms = draw.encode_ms;
                o.render_ms = draw.render_ms;
                o.submit_ms = draw.submit_ms;
                o.cpu_ms = draw.cpu_ms;
                o.prepare_masks_ms = draw.prepare_masks_ms;
                o.vello_render_ms = draw.vello_render_ms;
                o.reader_ms = draw.reader_ms;
                o.shadow_ms = draw.shadow_ms;
                o.submits = draw.submits;
                o.draws = draw.draws;
                o.vello_renders = draw.vello_renders;
                o.glass_ops = draw.glass_ops;
                o.glass_batched = draw.glass_batched;
                o.bg_blur_ops = draw.bg_blur_ops;
                o.shadow_ops = draw.shadow_ops;
                o.shadow_hits = draw.shadow_hits;
                o.in_progress = draw.in_progress;
                o
            }
            Err(e) => Outcome::err(e),
        }
    }

    /// Whether the GPU is healthy now: an error recorded since, or its loss, comes back here.
    #[wasm_bindgen(js_name = gpuCheck)]
    pub fn gpu_check(&self) -> Outcome {
        match self.core.gpu.as_ref() {
            Some(g) => outcome(g.check()),
            None => Outcome::err(EngineError::new(error::ErrorCode::State, "no GPU attached")),
        }
    }

    /// Drops every tile the GPU holds (benches time cold frames this way).
    #[wasm_bindgen(js_name = clearTiles)]
    pub fn clear_tiles(&mut self) {
        if let Some(g) = self.core.gpu.as_mut() {
            g.clear_tiles();
        }
    }

    /// Destroys the GPU device, as a driver reset would lose it: for testing the fallback.
    #[wasm_bindgen(js_name = gpuDestroy)]
    pub fn gpu_destroy(&self) {
        if let Some(g) = self.core.gpu.as_ref() {
            g.destroy();
        }
    }

    /// Enables or disables per-frame GPU timestamp queries (WebGPU `timestamp-query` only).
    /// Returns true if timestamp queries are active on the attached GPU.
    #[wasm_bindgen(js_name = setGpuTimestamps)]
    pub fn set_gpu_timestamps(&mut self, enabled: bool) -> bool {
        self.core.gpu.as_mut().is_some_and(|g| g.set_gpu_timestamps(enabled))
    }

    /// Reads the last frame's GPU timestamp duration in milliseconds, or `undefined` when
    /// timestamp queries are unsupported or disabled, or an `Outcome` on error (never rejects).
    #[wasm_bindgen(js_name = gpuTimestampMs)]
    pub fn gpu_timestamp_ms(&self) -> js_sys::Promise {
        let pair = self.core.gpu.as_ref().map(|g| (g.device.clone(), g.health.clone()));
        let start = self.core.gpu.as_ref().map(|g| g.gpu_timestamp_start());
        wasm_bindgen_futures::future_to_promise(async move {
            let (Some((device, health)), Some(start)) = (pair, start) else {
                return Ok(failure(EngineError::new(error::ErrorCode::State, "no GPU attached")));
            };
            let Some((buffer, period_ns)) = (match start {
                Ok(s) => s,
                Err(e) => return Ok(failure(e)),
            }) else {
                return Ok(JsValue::UNDEFINED);
            };
            match gpu::read_timestamp_ms(device, health, buffer, period_ns).await {
                Ok(ms) => Ok(JsValue::from_f64(ms)),
                Err(e) => Ok(failure(e)),
            }
        })
    }

    /// Resolves when the GPU has finished what it was given, or to an `Outcome` on failure
    /// (never rejects).
    #[wasm_bindgen(js_name = gpuFinished)]
    pub fn gpu_finished(&self) -> js_sys::Promise {
        let triple = self
            .core
            .gpu
            .as_ref()
            .map(|g| (g.device.clone(), g.health.clone(), g.queue.clone()));
        wasm_bindgen_futures::future_to_promise(async move {
            let Some((device, health, queue)) = triple else {
                return Ok(failure(EngineError::new(error::ErrorCode::State, "no GPU attached")));
            };
            match gpu::finished(device, health, queue).await {
                Ok(()) => Ok(JsValue::UNDEFINED),
                Err(e) => Ok(failure(e)),
            }
        })
    }

    /// Resolves to the last GPU frame, straight RGBA8, read back through a buffer, or to an
    /// `Outcome` saying why not (it never rejects).
    #[wasm_bindgen(js_name = gpuPixels)]
    pub fn gpu_pixels(&self) -> js_sys::Promise {
        let pair = self.core.gpu.as_ref().map(|g| (g.device.clone(), g.health.clone()));
        let start = self.core.gpu.as_ref().map(|g| g.read_back_start());
        let opaque = self.core.gpu.as_ref().is_some_and(|g| g.opaque());
        wasm_bindgen_futures::future_to_promise(async move {
            let (Some((device, health)), Some(start)) = (pair, start) else {
                return Ok(failure(EngineError::new(error::ErrorCode::State, "no GPU attached")));
            };
            let (buffer, w, h, row, flight) = match start {
                Ok(s) => s,
                Err(e) => return Ok(failure(e)),
            };
            match gpu::read_back_straight(device, health, buffer, w, h, row, flight, opaque).await {
                Ok(px) => Ok(px.into()),
                Err(e) => Ok(failure(e)),
            }
        })
    }

    /// Runs the GPU Gaussian blur pass on premultiplied RGBA8 pixels and resolves to premultiplied
    /// RGBA8 (or an `Outcome` on failure), for CPU-vs-GPU conformance tests.
    /// `source_id`: non-zero shares/reuses the cached GPU blur pyramid across calls.
    #[allow(clippy::too_many_arguments)]
    #[wasm_bindgen(js_name = blurGpu)]
    pub fn blur_gpu_probe(
        &mut self,
        src: &[u8],
        src_w: u32,
        src_h: u32,
        dst_w: u32,
        dst_h: u32,
        dst_ox: i32,
        dst_oy: i32,
        sigma: f32,
        edge_mode: u32,
        border: Vec<f32>,
        clamp_x0: i32,
        clamp_y0: i32,
        clamp_x1: i32,
        clamp_y1: i32,
        dirty_x0: i32,
        dirty_y0: i32,
        dirty_x1: i32,
        dirty_y1: i32,
        source_id: u32,
    ) -> js_sys::Promise {
        let spec = blur_spec_from_args(
            sigma, edge_mode, &border, clamp_x0, clamp_y0, clamp_x1, clamp_y1, dirty_x0, dirty_y0, dirty_x1, dirty_y1,
        );
        let sid = (source_id != 0).then(|| u64::from(source_id));
        let pair = self.core.gpu.as_ref().map(|g| (g.device.clone(), g.health.clone()));
        let start = self
            .core
            .gpu
            .as_mut()
            .map(|g| g.blur_probe(src, (src_w, src_h), (dst_w, dst_h), (dst_ox, dst_oy), &spec, sid));
        wasm_bindgen_futures::future_to_promise(async move {
            let (Some((device, health)), Some(start)) = (pair, start) else {
                return Ok(failure(EngineError::new(error::ErrorCode::State, "no GPU attached")));
            };
            let (buffer, w, h, row, flight) = match start {
                Ok(s) => s,
                Err(e) => return Ok(failure(e)),
            };
            match gpu::read_back_straight(device, health, buffer, w, h, row, flight, true).await {
                Ok(px) => Ok(px.into()),
                Err(e) => Ok(failure(e)),
            }
        })
    }

    /// GPU blur pyramid cache statistics: `[hits, misses, evicted, bytes]`.
    #[wasm_bindgen(js_name = blurGpuStats)]
    pub fn blur_gpu_stats(&self) -> Vec<f64> {
        match self.core.gpu.as_ref() {
            Some(g) => vec![
                g.blur.stats.hits as f64,
                g.blur.stats.misses as f64,
                g.blur.stats.evicted as f64,
                g.blur.stats.bytes as f64,
            ],
            None => vec![0.0; 4],
        }
    }

    /// Enables the experimental compute pipeline for explicit diagnostics.
    #[cfg(feature = "compute")]
    #[wasm_bindgen(js_name = setComputeOrdinary)]
    pub fn set_compute_ordinary(&mut self, enabled: bool) -> Outcome {
        let Some(gpu) = self.core.gpu.as_mut() else {
            return Outcome::err(EngineError::new(error::ErrorCode::State, "no GPU attached"));
        };
        gpu.set_compute_ordinary(enabled);
        Outcome::ok()
    }

    /// Draws and presents a compute frame through the bump gate: wherever a stage overflowed,
    /// the GPU keeps the frame that was on screen, so nothing overflowed is shown and nothing
    /// waits for a read-back. Returns the frame's outcome (never exact: `finishComputeGate`
    /// decides that once `takeComputeGateCheck`'s promise resolves), or a failed outcome (a lost
    /// device, or a call the engine refused); the number 1 when too many checks are in flight
    /// (nothing drawn: try again once one lands); or nothing when there is no frame of this size
    /// to keep (stage instead) or compute doesn't draw this view.
    #[cfg(feature = "compute")]
    #[allow(clippy::too_many_arguments)]
    #[wasm_bindgen(js_name = presentComputeFrame)]
    pub fn present_compute_frame(
        &mut self,
        width: u32,
        height: u32,
        zoom: f64,
        x: f64,
        y: f64,
        dpr: f64,
        background: Vec<f32>,
    ) -> JsValue {
        let drawn = self
            .core
            .present_compute(width, height, Camera { zoom, x, y, dpr }, rgba(&background));
        match drawn {
            Ok(gpu::GatePresent::Presented(draw, check)) => {
                self.gate_check = Some(wasm_bindgen_futures::future_to_promise(async move {
                    check.await;
                    Ok(JsValue::UNDEFINED)
                }));
                let masks = self.core.gpu.as_ref().map(|g| g.masks.stats).unwrap_or_default();
                let mut o = Outcome::stats(engine::FrameStats { draw, masks });
                o.presented = draw.presented;
                o.exact = false;
                o.plan = draw.plan;
                o.encode_ms = draw.encode_ms;
                o.render_ms = draw.render_ms;
                o.submit_ms = draw.submit_ms;
                o.cpu_ms = draw.cpu_ms;
                JsValue::from(o)
            }
            Ok(gpu::GatePresent::Busy) => JsValue::from(1),
            Ok(gpu::GatePresent::Stage) => JsValue::UNDEFINED,
            Err(error) => failure(error),
        }
    }

    /// The promise of the last gated frame's check (once; `None` after).
    #[cfg(feature = "compute")]
    #[wasm_bindgen(js_name = takeComputeGateCheck)]
    pub fn take_compute_gate_check(&mut self) -> Option<js_sys::Promise> {
        self.gate_check.take()
    }

    /// Settles the gated frame's check: 0 the frame on screen is exact; 1 a stage overflowed,
    /// the gate kept the last good frame and the buffers grew, so draw again; 2 compute is off
    /// for the session; 3 nothing to settle yet; 4 the device was lost.
    #[cfg(feature = "compute")]
    #[wasm_bindgen(js_name = finishComputeGate)]
    pub fn finish_compute_gate(&mut self) -> u32 {
        let generation = self.core.generation;
        let Some(gpu) = self.core.gpu.as_mut() else {
            return 2;
        };
        match gpu.finish_gate(generation) {
            Ok(gpu::GateFinish::Verified) => 0,
            Ok(gpu::GateFinish::Redraw) => 1,
            Ok(gpu::GateFinish::Fallback) => 2,
            Ok(gpu::GateFinish::Pending) => 3,
            Err(_) => 4,
        }
    }

    /// Schedules a candidate in a private GPU texture. The promise resolves after all checks.
    #[cfg(feature = "compute")]
    #[allow(clippy::too_many_arguments)]
    #[wasm_bindgen(js_name = stageComputeFrame)]
    pub fn stage_compute_frame(
        &mut self,
        width: u32,
        height: u32,
        zoom: f64,
        x: f64,
        y: f64,
        dpr: f64,
        background: Vec<f32>,
    ) -> Option<js_sys::Promise> {
        let check = self
            .core
            .stage_compute(width, height, Camera { zoom, x, y, dpr }, rgba(&background));
        match check {
            Ok(Some(check)) => Some(wasm_bindgen_futures::future_to_promise(async move {
                check.await;
                Ok(JsValue::UNDEFINED)
            })),
            Ok(None) | Err(_) => None,
        }
    }

    /// Shows a checked candidate. Returns its frame's outcome (not exact when an edit landed
    /// while it was checked); `None` to draw the same frame again (a buffer grew); or a plain
    /// success (no plan) when there is no frame to show: compute is off for the session if
    /// `computeFallbackReason` says so, otherwise there was no checked candidate to show.
    #[cfg(feature = "compute")]
    #[wasm_bindgen(js_name = finishComputeFrame)]
    pub fn finish_compute_frame(&mut self, final_attempt: bool) -> Option<Outcome> {
        let generation = self.core.generation;
        let gpu = self.core.gpu.as_mut()?;
        match gpu.finish_compute(generation, final_attempt) {
            Ok(gpu::ComputeFinish::Retry) => None,
            Ok(gpu::ComputeFinish::Fallback | gpu::ComputeFinish::Stale) => Some(Outcome::ok()),
            Ok(gpu::ComputeFinish::Frame(draw)) => {
                let mut o = Outcome::stats(engine::FrameStats {
                    draw,
                    masks: gpu.masks.stats,
                });
                o.presented = draw.presented;
                o.exact = draw.exact;
                o.standin = draw.standin;
                o.plan = draw.plan;
                o.encode_ms = draw.encode_ms;
                o.render_ms = draw.render_ms;
                o.submit_ms = draw.submit_ms;
                o.cpu_ms = draw.cpu_ms;
                Some(o)
            }
            Err(err) => Some(Outcome::err(err)),
        }
    }

    #[cfg(feature = "compute")]
    #[wasm_bindgen(js_name = computeFallbackReason)]
    pub fn compute_fallback_reason(&self) -> Option<String> {
        self.core.gpu.as_ref()?.compute_reason.clone()
    }

    #[cfg(feature = "compute")]
    #[wasm_bindgen(js_name = cancelComputeFrame)]
    pub fn cancel_compute_frame(&mut self) {
        if let Some(gpu) = self.core.gpu.as_mut() {
            gpu.cancel_compute_frame();
        }
    }

    /// Starts compute frames from minimal buffers so the grow-and-redraw path runs (the
    /// diagnostics' capacity matrix), or from the usual ones.
    #[cfg(feature = "compute")]
    #[wasm_bindgen(js_name = computeTight)]
    pub fn compute_tight(&mut self, tight: bool) -> Outcome {
        let Some(gpu) = self.core.gpu.as_mut() else {
            return Outcome::err(EngineError::new(error::ErrorCode::State, "no GPU attached"));
        };
        gpu.compute_tight(tight);
        Outcome::ok()
    }

    /// Whether the most recent GPU frame ran on the compute pipeline.
    #[cfg(feature = "compute")]
    #[wasm_bindgen(js_name = computeUsed)]
    pub fn compute_used(&self) -> bool {
        self.core.gpu.as_ref().is_some_and(|g| g.last_compute_used)
    }

    /// Resets accumulated bump and hardware timestamp diagnostics.
    #[cfg(feature = "compute")]
    #[wasm_bindgen(js_name = computeResetStats)]
    pub fn compute_reset_stats(&mut self) {
        if let Some(gpu) = self.core.gpu.as_mut() {
            gpu.compute_reset_stats();
        }
    }

    /// The compute path's diagnostics as JSON (every checked frame's counters and pass times),
    /// or an empty string before it has run.
    #[cfg(feature = "compute")]
    #[wasm_bindgen(js_name = computeStats)]
    pub fn compute_stats(&self) -> String {
        self.core
            .gpu
            .as_ref()
            .and_then(|gpu| gpu.compute_stats_json().ok())
            .unwrap_or_default()
    }
}
