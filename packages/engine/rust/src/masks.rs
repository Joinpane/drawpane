//! The glyph coverage cache (review item 2): small glyphs are rasterised once per outline, scale
//! and subpixel phase, then drawn as masks tinted with their colour, on both backends.
//!
//! - **Keys:** the outline's serial (`glyphs.rs`: a redefinition never reuses a mask), the
//!   device scale's bits on each axis, and the subpixel phase quantised to eighths of a pixel
//!   on each axis (a glyph lands at most 1/16 px from where an outline fill puts it).
//! - **When:** a glyph filled with a solid colour under a transform without rotation or skew,
//!   no larger than `Limits::glyph_mask_side` device pixels. Everything else (large type,
//!   gradients or images in text, stroked text, rotated text) fills the outline itself, which is
//!   always kept, so nothing is ever drawn from a mask at the wrong size.
//! - **Rasterising** is vello_cpu on both backends, so CPU and GPU text has the same coverage
//!   by construction; the GPU backend uploads each mask into its atlas once.
//! - **Budget and eviction:** masks are counted in bytes against `Limits::glyph_mask_bytes`.
//!   At each frame's start, masks not used in the last frame are evicted, least recently used
//!   first, until the cache is under budget. A mask that doesn't fit mid-frame isn't made: that
//!   glyph fills its outline for the frame.

use std::collections::HashMap;
use vello_common::kurbo::{Affine, BezPath, Shape};
use vello_cpu::{Pixmap, RenderContext, Resources};

/// Subpixel positions per pixel, on each axis.
pub const PHASES: f64 = 8.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct MaskKey {
    pub serial: u64,
    pub sx: u32,
    pub sy: u32,
    pub px: u8,
    pub py: u8,
}

pub struct MaskEntry<T> {
    pub value: T,
    /// The mask's top left, from the glyph's whole-pixel anchor.
    pub origin: (i32, i32),
    pub size: (u16, u16),
    bytes: usize,
    used: u64,
}

#[derive(Default, Clone, Copy, Debug)]
pub struct MaskStats {
    pub hits: u64,
    pub misses: u64,
    pub evicted: u64,
    pub outlines: u64,
    pub bytes: usize,
    pub count: usize,
}

pub struct MaskCache<T> {
    map: HashMap<MaskKey, MaskEntry<T>>,
    bytes: usize,
    frame: u64,
    budget: usize,
    pub stats: MaskStats,
}

impl<T> MaskCache<T> {
    pub fn new(budget: usize) -> Self {
        Self {
            map: HashMap::new(),
            bytes: 0,
            frame: 0,
            budget,
            stats: MaskStats::default(),
        }
    }

    /// Starts a frame: evicts what the last frame didn't use while over budget. Answers what
    /// was evicted, for a backend that frees space (the GPU atlas).
    pub fn begin_frame(&mut self) -> Vec<T> {
        self.frame += 1;
        let mut out = Vec::new();
        if self.bytes > self.budget * 3 / 4 {
            let mut old: Vec<(u64, MaskKey)> = self
                .map
                .iter()
                .filter(|(_, e)| e.used + 1 < self.frame)
                .map(|(k, e)| (e.used, *k))
                .collect();
            old.sort_unstable_by_key(|(used, _)| *used);
            for (_, k) in old {
                if self.bytes <= self.budget / 2 {
                    break;
                }
                if let Some(e) = self.map.remove(&k) {
                    self.bytes -= e.bytes;
                    self.stats.evicted += 1;
                    out.push(e.value);
                }
            }
        }
        self.stats.bytes = self.bytes;
        self.stats.count = self.map.len();
        out
    }

    /// Drops every mask (the GPU atlas was reset, or the device lost).
    pub fn clear(&mut self) -> Vec<T> {
        self.bytes = 0;
        self.map.drain().map(|(_, e)| e.value).collect()
    }

    pub fn get(&mut self, key: &MaskKey) -> Option<&MaskEntry<T>> {
        let frame = self.frame;
        match self.map.get_mut(key) {
            Some(e) => {
                e.used = frame;
                self.stats.hits += 1;
                Some(e)
            }
            None => None,
        }
    }

    /// Whether a mask of `bytes` fits the budget now.
    pub fn fits(&self, bytes: usize) -> bool {
        self.bytes + bytes <= self.budget
    }

    pub fn insert(&mut self, key: MaskKey, value: T, origin: (i32, i32), size: (u16, u16)) -> &MaskEntry<T> {
        let bytes = usize::from(size.0) * usize::from(size.1) * 4 + 64;
        self.stats.misses += 1;
        self.bytes += bytes;
        let frame = self.frame;
        self.map.entry(key).or_insert(MaskEntry {
            value,
            origin,
            size,
            bytes,
            used: frame,
        })
    }

    pub fn len(&self) -> usize {
        self.map.len()
    }

    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }
}

/// A glyph's coverage at device scale (`sx`, `sy`) and subpixel phase, as premultiplied white:
/// its alpha is the coverage. Answers the mask and its top left from the whole-pixel anchor;
/// None for a glyph with no outline or one too large.
pub fn rasterise(
    resources: &mut Resources,
    path: &BezPath,
    sx: f64,
    sy: f64,
    phase: (f64, f64),
    max_side: u32,
) -> Option<(Pixmap, (i32, i32))> {
    if path.is_empty() {
        return None;
    }
    let t = Affine::new([sx, 0.0, 0.0, sy, phase.0, phase.1]);
    let b = t.transform_rect_bbox(path.bounding_box());
    let x0 = b.x0.floor() as i64 - 1;
    let y0 = b.y0.floor() as i64 - 1;
    let x1 = b.x1.ceil() as i64 + 1;
    let y1 = b.y1.ceil() as i64 + 1;
    let (w, h) = (x1 - x0, y1 - y0);
    if w <= 0 || h <= 0 || w > i64::from(max_side) + 2 || h > i64::from(max_side) + 2 {
        return None;
    }
    let (w, h) = (w as u16, h as u16);
    let mut ctx = RenderContext::new(w, h);
    ctx.set_transform(Affine::translate((-(x0 as f64), -(y0 as f64))) * t);
    ctx.set_paint(vello_common::color::palette::css::WHITE);
    ctx.fill_path(path);
    ctx.flush();
    let mut pixmap = Pixmap::new(w, h);
    ctx.render(&mut pixmap, resources);
    Some((pixmap, (x0 as i32, y0 as i32)))
}
