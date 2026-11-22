//! What the engine refuses to hold or draw, so a hostile or broken display list can't exhaust
//! memory or stall a frame. Each limit fails with `ErrorCode::Limit`; the caller falls back.
//! See docs/decisions/0040-display-list.md, "Limits".

/// The CPU-only Wasm module is linked with a 25 MiB maximum. A caller's limit
/// may narrow that maximum, but cannot disable or raise it.
pub(crate) fn memory_budget(requested: usize) -> usize {
    const WORKER_MEMORY_BYTES: usize = 25 << 20;
    if cfg!(all(target_arch = "wasm32", not(feature = "gpu-common")))
        && (requested == 0 || requested > WORKER_MEMORY_BYTES)
    {
        WORKER_MEMORY_BYTES
    } else {
        requested
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Limits {
    /// Records held at once (a 500,000-layer file's largest page is far below this).
    pub records: usize,
    /// Verbs in one path.
    pub path_verbs: usize,
    /// Paths and ops in one record.
    pub record_items: usize,
    /// Glyphs in one glyph run.
    pub run_glyphs: usize,
    /// Dashes in one stroke's pattern.
    pub dashes: usize,
    /// Stops in one gradient.
    pub stops: usize,
    /// Bytes of one patch message.
    pub message_bytes: usize,
    /// Glyph outlines held (bytes of their paths).
    pub glyph_outline_bytes: usize,
    /// Rasterised glyph masks held (bytes), per backend.
    pub glyph_mask_bytes: usize,
    /// A glyph drawn larger than this (device pixels, either side) is filled as an outline.
    pub glyph_mask_side: u32,
    /// Image pixels held (bytes, all levels).
    pub image_bytes: usize,
    /// Longest side of an image, and of a render target.
    pub texture_side: u32,
    /// Nesting of records (parent chains), and of clips and groups within a frame.
    pub depth: usize,
    /// Rows a band render holds at once (`render_band`).
    pub band_rows: u32,
    /// Bytes of output a band holds at once (rows × width × 4): 2 MiB, so a band of a frame
    /// 8,192 px wide is 64 rows.
    pub band_bytes: usize,
    /// Bytes the render graph holds, roughly (records and glyph outlines). While a fresh list is
    /// built, the graph it replaces counts too.
    pub graph_bytes: usize,
    /// Path elements the engine may generate drawing one frame (or one export tile): dashes,
    /// glyph runs expanded to outlines, shapes. Past it the frame is refused (`Limit`), so a
    /// legal document can't make a frame take unbounded time or memory.
    pub frame_verbs: usize,
    /// Clips and opacity layers open at once while drawing (across records).
    pub open_scopes: usize,
    /// Bytes of GPU memory the engine allocates: images, the glyph atlas, frames, tiles and their
    /// depth buffer, read-back buffers.
    pub gpu_bytes: usize,
    /// Bytes of tiles kept (decision 0040, phase 2), within `gpu_bytes`: what's left of it beside
    /// everything else, at most this.
    pub tile_bytes: usize,
    /// Bytes the whole engine may hold in a Worker (its WebAssembly memory's maximum): an export
    /// is refused before it starts if the graph, images, glyph masks and the export's own
    /// working set wouldn't fit. Zero: no such check (the browser).
    pub memory_bytes: usize,
    /// Columns of an export tile: a band is drawn a tile at a time (decision 0040: tiles of at
    /// most 1024 × 256 output pixels).
    pub export_tile: u32,
    /// How far a backdrop reader may read past where it paints (device pixels), summed through
    /// readers reading readers: what a band adds above and below itself.
    pub halo: u32,
    /// Bytes of expanded stroke outlines kept between frames (`stroke::StrokeBudget`). Past it,
    /// the least recently drawn are dropped and expanded again when next drawn. The largest page
    /// of the kits measured holds 26 MiB at the base level.
    pub stroke_bytes: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            records: 4_000_000,
            path_verbs: 1_000_000,
            record_items: 65_536,
            run_glyphs: 65_536,
            dashes: 64,
            stops: 4096,
            message_bytes: 512 * 1024 * 1024,
            glyph_outline_bytes: 64 * 1024 * 1024,
            // A Worker's share (decision 0040, "Text"); the browser's GPU asks for 32 MiB.
            glyph_mask_bytes: 4 * 1024 * 1024,
            glyph_mask_side: 160,
            image_bytes: 256 * 1024 * 1024,
            texture_side: 8192,
            depth: 512,
            band_rows: 256,
            band_bytes: 2 * 1024 * 1024,
            graph_bytes: 1024 * 1024 * 1024,
            frame_verbs: 4_000_000,
            open_scopes: 512,
            gpu_bytes: 768 * 1024 * 1024,
            tile_bytes: 256 * 1024 * 1024,
            memory_bytes: memory_budget(0),
            export_tile: 1024,
            halo: 512,
            stroke_bytes: 48 * 1024 * 1024,
        }
    }
}
