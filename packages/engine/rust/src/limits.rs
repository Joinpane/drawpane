//! What the engine refuses to hold or draw, so a hostile or broken display list can't exhaust
//! memory or stall a frame. Each limit fails with `ErrorCode::Limit`; the caller falls back.
//! See docs/decisions/0040-display-list.md, "Limits".

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
    /// Columns of an export tile: a band is drawn a tile at a time (decision 0040: tiles of at
    /// most 1024 × 256 output pixels).
    pub export_tile: u32,
    /// How far a backdrop reader may read past where it paints (device pixels), summed through
    /// readers reading readers: what a band adds above and below itself.
    pub halo: u32,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            records: 4_000_000,
            path_verbs: 1_000_000,
            record_items: 65_536,
            run_glyphs: 65_536,
            dashes: 64,
            stops: 64,
            message_bytes: 512 * 1024 * 1024,
            glyph_outline_bytes: 64 * 1024 * 1024,
            // A Worker's share (decision 0040, "Text"); the browser's GPU asks for 32 MiB.
            glyph_mask_bytes: 4 * 1024 * 1024,
            glyph_mask_side: 160,
            image_bytes: 256 * 1024 * 1024,
            texture_side: 8192,
            depth: 512,
            band_rows: 256,
            export_tile: 1024,
            halo: 512,
        }
    }
}
