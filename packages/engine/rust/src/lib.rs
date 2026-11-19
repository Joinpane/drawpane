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
#[cfg(feature = "gpu")]
pub mod gpu;
pub mod images;
pub mod kernels;
pub mod limits;
pub mod masks;
pub mod png;
pub mod record;
pub mod store;
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
    cfg!(feature = "gpu")
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

    /// Applies a display-list message, all or nothing; answers where pixels may have changed.
    pub fn apply(&mut self, bytes: &[u8]) -> Outcome {
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
        outcome(self.core.put_image(id, width, height, rgba, premultiplied))
    }

    #[wasm_bindgen(js_name = dropImage)]
    pub fn drop_image(&mut self, id: u32) {
        self.core.drop_image(id);
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
    #[wasm_bindgen(js_name = pngBegin)]
    pub fn png_begin(&mut self, width: u32, height: u32) -> Outcome {
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
}

fn rgba(v: &[f32]) -> [f32; 4] {
    let g = |i: usize| v.get(i).copied().filter(|x| x.is_finite()).unwrap_or(0.0);
    [g(0), g(1), g(2), g(3)]
}

/// A GPU being created: `createGpu` answers one, `Engine.attachGpu` takes its device.
#[cfg(feature = "gpu")]
#[wasm_bindgen]
pub struct GpuInit {
    inner: Option<gpu::Gpu>,
    pub ok: bool,
    pub code: u32,
    message: String,
    adapter: String,
    /// A software adapter (SwiftShader, llvmpipe): its timings say nothing about a GPU.
    pub fallback: bool,
}

#[cfg(feature = "gpu")]
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
}

/// Creates a WebGPU device, drawing into `canvas` (an `HTMLCanvasElement` or `OffscreenCanvas`),
/// or into nothing (null: frames are only read back).
#[cfg(feature = "gpu")]
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
    let bytes = if glyph_mask_bytes > 0 {
        glyph_mask_bytes as usize
    } else {
        limits.glyph_mask_bytes
    };
    match gpu::Gpu::create(target, bytes, limits.glyph_mask_side).await {
        Ok(g) => GpuInit {
            adapter: g.adapter.clone(),
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
            fallback: false,
        },
    }
}

#[cfg(feature = "gpu")]
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

    /// Draws a frame on the GPU.
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
        detail: bool,
    ) -> Outcome {
        let bg = rgba(&background);
        match self
            .core
            .render_gpu(width, height, Camera { zoom, x, y, dpr }, bg, detail)
        {
            Ok(draw) => {
                let masks = self.core.gpu.as_ref().map(|g| g.masks.stats).unwrap_or_default();
                Outcome::stats(engine::FrameStats { draw, masks })
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

    /// Destroys the GPU device, as a driver reset would lose it: for testing the fallback.
    #[wasm_bindgen(js_name = gpuDestroy)]
    pub fn gpu_destroy(&self) {
        if let Some(g) = self.core.gpu.as_ref() {
            g.device.destroy();
        }
    }

    /// Resolves when the GPU has finished what it was given.
    #[wasm_bindgen(js_name = gpuFinished)]
    pub fn gpu_finished(&self) -> js_sys::Promise {
        let queue = self.core.gpu.as_ref().map(|g| g.queue.clone());
        wasm_bindgen_futures::future_to_promise(async move {
            if let Some(q) = queue {
                gpu::finished(q).await;
            }
            Ok(JsValue::UNDEFINED)
        })
    }

    /// Resolves to the last GPU frame, straight RGBA8, read back through a buffer.
    #[wasm_bindgen(js_name = gpuPixels)]
    pub fn gpu_pixels(&self) -> js_sys::Promise {
        let start = self.core.gpu.as_ref().map(|g| g.read_back_start());
        wasm_bindgen_futures::future_to_promise(async move {
            let (buffer, w, h, row) = match start {
                Some(Ok(s)) => s,
                Some(Err(e)) => return Err(JsValue::from_str(&e.message)),
                None => return Err(JsValue::from_str("no GPU attached")),
            };
            let mut px = gpu::read_back(buffer, w, h, row)
                .await
                .map_err(|e| JsValue::from_str(&e.message))?;
            engine::unpremultiply(&mut px);
            Ok(js_sys::Uint8Array::from(px.as_slice()).into())
        })
    }
}
