//! Drawpane's render engine (decision 0040): a retained render graph, patched by display-list
//! messages from TypeScript, drawn by Vello on the CPU (every build) and on the GPU through
//! WebGPU (the browser build, feature `gpu`).
//!
//! The WebAssembly boundary is this file. Every call answers an `Outcome`: success, or an error
//! code and message. Nothing panics across it: inputs are validated (`wire.rs`, `record.rs`),
//! sizes are limited (`limits.rs`), and the fuzz tests (`tests/fuzz.rs`) hold that.

pub mod cpu;
pub mod engine;
pub mod error;
pub mod exec;
pub mod geometry;
pub mod glyphs;
#[cfg(feature = "gpu-common")]
pub mod gpu;
pub mod images;
pub mod kernels;
pub mod limits;
pub mod masks;
pub mod png;
pub mod record;
pub mod store;
pub mod tiles;
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
    pub mask_hits: f64,
    pub mask_misses: f64,
    pub mask_bytes: f64,
    /// Records drawn coarse (unreadable text as bars) and skipped as specks: a frame with
    /// either is a level-of-detail stand-in, not exact.
    pub coarse: u32,
    pub specks: u32,
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
            mask_hits: 0.0,
            mask_misses: 0.0,
            mask_bytes: 0.0,
            coarse: 0,
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
            mask_hits: s.masks.hits as f64,
            mask_misses: s.masks.misses as f64,
            mask_bytes: s.masks.bytes as f64,
            coarse: s.draw.coarse,
            specks: s.draw.specks,
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
    png: Option<png::BandPng>,
    changes: Vec<store::Dirty>,
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
            "memory_bytes" => l.memory_bytes = v,
            "gpu_bytes" => l.gpu_bytes = v,
            "tile_bytes" => l.tile_bytes = v,
            "band_bytes" => l.band_bytes = v.max(4),
            "frame_verbs" => l.frame_verbs = v,
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
        let bg = rgba(&background);
        match self
            .core
            .render_cpu(width, height, Camera { zoom, x, y, dpr }, bg, detail)
        {
            Ok((px, stats)) => {
                self.pixels.clear();
                self.pixels.extend_from_slice(px);
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
    /// on it), when another export is streaming, or when the export wouldn't fit the engine's
    /// memory budget. Until it ends (`pngEnd`) or is cancelled (`pngAbort`), the engine refuses
    /// changes, so every band draws the same revision.
    #[wasm_bindgen(js_name = pngBegin)]
    pub fn png_begin(&mut self, width: u32, height: u32, zoom: f64, x: f64, y: f64, dpr: f64) -> Outcome {
        if let Some(o) = self.exporting() {
            return o;
        }
        if let Err(e) = self.core.admit_export(width, height, Camera { zoom, x, y, dpr }) {
            return Outcome::err(e);
        }
        match png::BandPng::new(width, height, self.core.limits().texture_side) {
            Ok(p) => {
                self.png = Some(p);
                Outcome::ok()
            }
            Err(e) => Outcome::err(e),
        }
    }

    /// Renders the next band of the PNG begun and compresses it.
    #[allow(clippy::too_many_arguments)]
    #[wasm_bindgen(js_name = pngBand)]
    pub fn png_band(&mut self, zoom: f64, x: f64, y: f64, dpr: f64, background: Vec<f32>, rows: u32) -> Outcome {
        let Some(mut p) = self.png.take() else {
            return Outcome::err(EngineError::new(error::ErrorCode::State, "no PNG begun"));
        };
        let bg = rgba(&background);
        let (w, h, y0) = (p.width, p.height, p.rows_written);
        let rows = rows.min(h - y0);
        let result = self
            .core
            .render_band_straight(w, h, Camera { zoom, x, y, dpr }, bg, y0, rows)
            .and_then(|px| p.write_rows(px, rows));
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
        self.png.as_mut().map(|p| p.take()).unwrap_or_default()
    }

    /// Ends the PNG: answers its last bytes.
    #[wasm_bindgen(js_name = pngEnd)]
    pub fn png_end(&mut self) -> Vec<u8> {
        self.png.take().map(|p| p.finish()).unwrap_or_default()
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
    ) -> Outcome {
        let bg = rgba(&background);
        let options = engine::TiledOptions {
            moving,
            budget_ms: if budget_ms.is_finite() { budget_ms } else { 0.0 },
            ..engine::TiledOptions::default()
        };
        match self
            .core
            .render_gpu(width, height, Camera { zoom, x, y, dpr }, bg, options)
        {
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
                o.cpu_ms = draw.cpu_ms;
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
}
