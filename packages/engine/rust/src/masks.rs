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
//!   by construction. Masks are kept on the CPU on both.
//! - **Drawn a run at a time:** a run's masks are laid into one image of the run, each at its
//!   device pixel, coverage combined as source-over (`compose_run`), and that image is drawn
//!   once, tinted: one draw a run instead of one a glyph (a dense tile holds 85,000 glyphs in
//!   15,000 runs). The GPU backend uploads each tile's run images into its atlas, a write per
//!   row, before the tile renders.
//! - **Budget and eviction:** masks are counted in bytes against `Limits::glyph_mask_bytes`.
//!   At each frame's start, masks not used in the last frame are evicted, least recently used
//!   first, until the cache is under budget. A mask that doesn't fit mid-frame isn't made: that
//!   glyph fills its outline for the frame.

use std::collections::HashMap;
use vello_common::kurbo::{Affine, BezPath, Shape};
use vello_cpu::{Pixmap, RasterizerSettings, RenderContext, RenderMode, Resources};

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

/// A quick hash for mask keys, looked up once per glyph drawn: their parts are the engine's own
/// (a serial it hands out, a scale, a phase), so nothing outside picks them to collide.
#[derive(Default, Clone, Copy)]
pub struct KeyHasher(u64);

impl std::hash::Hasher for KeyHasher {
    fn finish(&self) -> u64 {
        self.0
    }
    fn write(&mut self, bytes: &[u8]) {
        for b in bytes {
            self.write_u64(u64::from(*b));
        }
    }
    fn write_u8(&mut self, v: u8) {
        self.write_u64(u64::from(v));
    }
    fn write_u32(&mut self, v: u32) {
        self.write_u64(u64::from(v));
    }
    fn write_u64(&mut self, v: u64) {
        self.0 = (self.0.rotate_left(5) ^ v).wrapping_mul(0x517c_c1b7_2722_0a95);
    }
}

type KeyMap<V> = HashMap<MaskKey, V, std::hash::BuildHasherDefault<KeyHasher>>;

pub struct MaskCache<T> {
    map: KeyMap<MaskEntry<T>>,
    bytes: usize,
    frame: u64,
    budget: usize,
    pub stats: MaskStats,
}

impl<T> MaskCache<T> {
    pub fn new(budget: usize) -> Self {
        Self {
            map: KeyMap::default(),
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

    pub fn set_budget(&mut self, budget: usize) {
        self.budget = budget;
    }

    /// Drops the masks `drop` picks (the GPU atlas reusing a shelf); answers how many.
    pub fn evict_where(&mut self, mut drop: impl FnMut(&T) -> bool) -> usize {
        let before = self.map.len();
        let mut freed = 0usize;
        self.map.retain(|_, e| {
            let keep = !drop(&e.value);
            if !keep {
                freed += e.bytes;
            }
            keep
        });
        self.bytes -= freed;
        let n = before - self.map.len();
        self.stats.evicted += n as u64;
        n
    }

    /// The frame being drawn (masks used in it are never evicted during it).
    pub fn frame(&self) -> u64 {
        self.frame
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

/// Where a glyph's mask lies (top left from the whole-pixel anchor) and its size from its
/// precomputed outline bounds: None for an empty outline or one too large.
fn extent_bounds(
    bounds: vello_common::kurbo::Rect,
    sx: f64,
    sy: f64,
    phase: (f64, f64),
    max_side: u32,
) -> Option<(i64, i64, u16, u16)> {
    let t = Affine::new([sx, 0.0, 0.0, sy, phase.0, phase.1]);
    let b = t.transform_rect_bbox(bounds);
    let x0 = b.x0.floor() as i64 - 1;
    let y0 = b.y0.floor() as i64 - 1;
    let x1 = b.x1.ceil() as i64 + 1;
    let y1 = b.y1.ceil() as i64 + 1;
    let (w, h) = (x1 - x0, y1 - y0);
    if w <= 0 || h <= 0 || w > i64::from(max_side) + 2 || h > i64::from(max_side) + 2 {
        return None;
    }
    Some((x0, y0, w as u16, h as u16))
}

/// Whether a glyph with precomputed outline `bounds` fits within the rasterised mask size limit
/// at device scale (`sx`, `sy`) and subpixel `phase`.
pub fn fits_bounds(bounds: vello_common::kurbo::Rect, sx: f64, sy: f64, phase: (f64, f64), max_side: u32) -> bool {
    extent_bounds(bounds, sx, sy, phase, max_side).is_some()
}

/// Where a glyph's mask lies (top left from the whole-pixel anchor) and its size, before it's
/// rasterised: None for a glyph with no outline or one too large.
fn extent(path: &BezPath, sx: f64, sy: f64, phase: (f64, f64), max_side: u32) -> Option<(i64, i64, u16, u16)> {
    if path.is_empty() {
        return None;
    }
    extent_bounds(path.bounding_box(), sx, sy, phase, max_side)
}

/// The size of a glyph's mask (as `rasterise` makes it), so a full cache or atlas refuses it
/// before the work of rasterising: None for a glyph with no mask.
pub fn mask_size(path: &BezPath, sx: f64, sy: f64, phase: (f64, f64), max_side: u32) -> Option<(u16, u16)> {
    let (_, _, w, h) = extent(path, sx, sy, phase, max_side)?;
    Some((w, h))
}

/// The bytes of a mask `size` big.
pub fn bytes((w, h): (u16, u16)) -> usize {
    usize::from(w) * usize::from(h) * 4
}

/// What rasterising masks keeps between them: vello_cpu's resources and one render context,
/// reset and resized for each mask (making a context per mask cost more than drawing it: a page
/// opening rasterises thousands).
pub struct Rasterizer {
    pub resources: Resources,
    ctx: RenderContext,
}

impl Default for Rasterizer {
    fn default() -> Self {
        Self {
            resources: Resources::new(),
            ctx: RenderContext::new(1, 1),
        }
    }
}

/// A glyph's coverage at device scale (`sx`, `sy`) and subpixel phase, as premultiplied white:
/// its alpha is the coverage. Answers the mask and its top left from the whole-pixel anchor;
/// None for a glyph with no outline or one too large.
pub fn rasterise(
    r: &mut Rasterizer,
    path: &BezPath,
    sx: f64,
    sy: f64,
    phase: (f64, f64),
    max_side: u32,
) -> Option<(Pixmap, (i32, i32))> {
    let (x0, y0, w, h) = extent(path, sx, sy, phase, max_side)?;
    let t = Affine::new([sx, 0.0, 0.0, sy, phase.0, phase.1]);
    let ctx = &mut r.ctx;
    ctx.reset_and_resize(w, h);
    ctx.set_transform(Affine::translate((-(x0 as f64), -(y0 as f64))) * t);
    ctx.set_paint(vello_common::color::palette::css::WHITE);
    ctx.fill_path(path);
    ctx.flush();
    let mut pixmap = Pixmap::new(w, h);
    let settings = RasterizerSettings {
        render_mode: RenderMode::OptimizeQuality,
        ..Default::default()
    };
    ctx.render_with(&mut pixmap, &mut r.resources, settings);
    Some((pixmap, (x0 as i32, y0 as i32)))
}

/// A glyph's mask from `cache`, rasterised and kept if it isn't held and the budget has room:
/// the mask (premultiplied white, its alpha the coverage) and its top left from the glyph's
/// whole-pixel anchor. None when it can't be kept (the glyph fills its outline instead).
#[allow(clippy::too_many_arguments)]
pub fn coverage(
    cache: &mut MaskCache<std::sync::Arc<Pixmap>>,
    raster: &mut Rasterizer,
    key: MaskKey,
    path: &BezPath,
    scale: (f64, f64),
    phase: (f64, f64),
    side: u32,
) -> Option<(std::sync::Arc<Pixmap>, (i32, i32))> {
    if let Some(e) = cache.get(&key) {
        return Some((e.value.clone(), e.origin));
    }
    // Full: drawn as its outline, without rasterising a mask that can't be kept.
    if !cache.fits(bytes(mask_size(path, scale.0, scale.1, phase, side)?)) {
        cache.stats.outlines += 1;
        return None;
    }
    let (mask, origin) = rasterise(raster, path, scale.0, scale.1, phase, side)?;
    let size = (mask.width(), mask.height());
    let e = cache.insert(key, std::sync::Arc::new(mask), origin, size);
    Some((e.value.clone(), e.origin))
}

/// `a × b / 255`, rounded: 8-bit coverage times coverage.
fn mul255(a: u8, b: u8) -> u8 {
    let t = u32::from(a) * u32::from(b) + 128;
    ((t + (t >> 8)) >> 8) as u8
}

/// Lays a run's glyph masks, each with its top left at a device pixel, into one image of
/// `area` (x0, y0, x1, y1, device pixels; what's outside is cut off): coverage combined as
/// source-over (a + b - ab, what drawing them one over another gives), as premultiplied white.
pub fn compose_run(masks: &[(std::sync::Arc<Pixmap>, i32, i32)], area: (i32, i32, i32, i32), out: &mut Vec<u8>) {
    let (ax0, ay0, ax1, ay1) = area;
    let w = (ax1 - ax0).max(0) as usize;
    let h = (ay1 - ay0).max(0) as usize;
    out.clear();
    out.resize(w * h * 4, 0);
    for (m, mx, my) in masks {
        let (mw, mh) = (i32::from(m.width()), i32::from(m.height()));
        let data = m.data_as_u8_slice();
        let (x0, x1) = ((*mx).max(ax0), (mx + mw).min(ax1));
        let (y0, y1) = ((*my).max(ay0), (my + mh).min(ay1));
        if x0 >= x1 || y0 >= y1 {
            continue;
        }
        for y in y0..y1 {
            let src = ((y - my) * mw + (x0 - mx)) as usize * 4;
            let dst = ((y - ay0) as usize * w + (x0 - ax0) as usize) * 4;
            let n = (x1 - x0) as usize * 4;
            let (from, to) = (&data[src..src + n], &mut out[dst..dst + n]);
            for (s, d) in from.as_chunks::<4>().0.iter().zip(to.as_chunks_mut::<4>().0.iter_mut()) {
                let a = s[3];
                if a == 0 {
                    continue;
                }
                let b = d[3];
                let v = if b == 0 {
                    a
                } else {
                    (u16::from(b) + u16::from(a) - u16::from(mul255(a, b))) as u8
                };
                *d = [v; 4];
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_run_combines_its_masks_as_source_over() {
        let square = |w: u16, h: u16, a: u8| {
            let mut p = Pixmap::new(w, h);
            for px in p.data_as_u8_slice_mut().as_chunks_mut::<4>().0 {
                *px = [a; 4];
            }
            std::sync::Arc::new(p)
        };
        let mut out = Vec::new();
        // Two half-covered squares overlapping in one column, the second cut off at the right.
        compose_run(
            &[(square(2, 1, 128), 0, 0), (square(3, 1, 128), 1, 0)],
            (0, 0, 3, 1),
            &mut out,
        );
        assert_eq!(out, [128, 128, 128, 128, 192, 192, 192, 192, 128, 128, 128, 128]);
        for (a, b) in [(0u8, 0u8), (255, 7), (128, 128), (255, 255), (1, 254)] {
            let exact = f64::from(a) * f64::from(b) / 255.0;
            assert!((f64::from(mul255(a, b)) - exact).abs() <= 0.5, "{a} {b}");
        }
    }

    #[test]
    fn a_kept_context_rasterises_the_same_masks_as_a_new_one() {
        let mut p = BezPath::new();
        p.move_to((0.0, 0.0));
        p.curve_to((100.0, 700.0), (400.0, 700.0), (500.0, 0.0));
        p.line_to((450.0, 0.0));
        p.curve_to((380.0, 600.0), (120.0, 600.0), (50.0, 0.0));
        p.close_path();
        let mut kept = Rasterizer::default();
        for (i, s) in [0.004, 0.016, 0.031, 0.09, 0.2]
            .into_iter()
            .cycle()
            .take(40)
            .enumerate()
        {
            let phase = (f64::from(i as u32 % 8) / 8.0, f64::from(i as u32 % 3) / 8.0);
            let a = rasterise(&mut kept, &p, s, -s, phase, 160);
            let b = rasterise(&mut Rasterizer::default(), &p, s, -s, phase, 160);
            match (a, b) {
                (Some((a, ao)), Some((b, bo))) => {
                    assert_eq!(ao, bo);
                    assert_eq!(a.data_as_u8_slice(), b.data_as_u8_slice(), "scale {s}, phase {phase:?}");
                }
                (None, None) => {}
                _ => panic!("one rasterised and the other didn't"),
            }
        }
    }
}
