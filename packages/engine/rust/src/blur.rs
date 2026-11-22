//! Reference separable Gaussian blur and shareable blur pyramids (decisions 0013 and 0040).
//!
//! - **Contract:** `BlurSpec.sigma` is the Gaussian standard deviation in device pixels; effects
//!   convert Figma blur radius via the shared `sigma_from_radius` helper (`0.45 * radius`, decision
//!   0013 revision). The kernel is a normalised discrete Gaussian over `±ceil(3.5 * sigma)`,
//!   separable, premultiplied RGBA8 between passes with f32 accumulation.
//!   Extending support from `3 * sigma` to `3.5 * sigma` removes the ~0.7 LSB `3 * sigma`
//!   truncation shelf against the true continuous Gaussian and keeps pyramid-vs-reference error
//!   well inside decision 0040's tolerance across every sigma transition.
//! - **Exactness and speed:** `blur_reference` is the full-resolution discrete semantic oracle.
//!   For `sigma <= DIRECT_SIGMA_MAX` (10 px, radius <= 35), production CPU and GPU both run the
//!   direct full-resolution separable kernel. Above that, both downsample through a shareable
//!   halved pyramid using a separable 4-tap `[1, 3, 3, 1]/8` filter with a 2-texel apron on all
//!   four sides (preserving exact `Zero`, `Clamp`, and `Border` edge extensions across every level
//!   and odd/even dimension, while suppressing high-frequency aliasing), blur at the chosen level
//!   with variance compensation (`sigma_level` in `(5, 10]`, `r <= 35`), and bilinearly upsample
//!   back to full resolution. Internal pyramid/scratch buffers use 16-bit precision (`u16` UNORM on
//!   CPU, `Rgba16Float` on GPU with automatic `Rgba8Unorm` fallback on restricted WebGL2 adapters).
//! - **Sharing and dirty bounds:** Every pyramid is keyed by `(source_id, clamp_bounds, edge)` and
//!   tracks computed regions in a compact 32x32-texel block bitset (`TileCoverage`), so multiple
//!   consumers reading the same input (background blurs, glass frost, repeated shadows) reuse
//!   computed pyramid levels without downsampling untouched areas of the frame.
//! - **WebGL2 / GLSL ES 3.00:** The GPU path (`blur.wgsl`) uses only full-screen triangle render
//!   passes with `set_scissor_rect`, `Rgba8Unorm` targets, dynamic uniform offsets, `textureLoad`,
//!   and `textureSampleLevel`. No compute shaders or storage buffers are used.

use crate::error::{EngineError, Result};
use crate::exec::IRect;
use std::collections::HashMap;

/// Calibrated Figma blur radius-to-sigma ratio (decision 0013 revision, 2026-11-20).
/// Shared across shadows, layer blur, background blur, and glass frost so every effect converts
/// Figma blur radius to Gaussian standard deviation through one contract.
pub const FIGMA_BLUR_SIGMA: f32 = 0.45;

/// Below this sigma, a discrete Gaussian has negligible weight on neighbours (radius 0: copy).
pub const MIN_SIGMA: f32 = 1e-3;

/// Largest sigma executed directly at level 0 (`r <= 35`). Larger sigmas use the blur pyramid so
/// the per-level kernel radius stays bounded at `<= 35` while staying well within decision 0040's
/// parity tolerance against `blur_reference` and against the continuous Gaussian.
pub const DIRECT_SIGMA_MAX: f32 = 10.0;

/// Viewport blurs this wide can use a lower-density backdrop without
/// sampling a visibly sharp source on that grid.
pub const VIEWPORT_HALO_MIN_SIGMA: f32 = 128.0;

/// Kernel half-width in standard deviations (`±ceil(3.5 * sigma)`). At `3.5 * sigma`, the omitted
/// Gaussian tail is 0.046% (0.12 / 255), avoiding both visible box-edge truncation shelves and
/// truncation-step mismatches at pyramid level transitions.
pub const KERNEL_SIGMA_MULT: f32 = 3.5;

/// Hard upper bound on 1D kernel half-width (`ceil(3.5 * DIRECT_SIGMA_MAX)` = 35 taps per side).
/// Every production CPU and GPU blur pass is bounded to at most `MAX_KERNEL_RADIUS` taps.
pub const MAX_KERNEL_RADIUS: i32 = 35;

/// Maximum downsample levels in a pyramid (2^8 = 256x, covering sigmas up to 2560 px).
pub const MAX_PYRAMID_LEVELS: usize = 8;

/// Largest standard deviation supported by the bounded pyramid (`DIRECT_SIGMA_MAX * 2^MAX_PYRAMID_LEVELS`).
/// Larger finite sigmas on non-constant sources are refused cleanly with `ErrorCode::Limit` rather
/// than growing kernel radius past `MAX_KERNEL_RADIUS` or allocating unbounded scratch memory.
pub const MAX_BLUR_SIGMA: f32 = DIRECT_SIGMA_MAX * (1u32 << MAX_PYRAMID_LEVELS) as f32;

/// Apron texels stored on each of the four sides of every downsampled pyramid level.
/// The 4-tap `[1, 3, 3, 1]/8` downsample needs a 2-texel apron so edge clamping stays exact across
/// arbitrary cascade depths and odd dimensions.
pub const PYRAMID_APRON: i32 = 2;

/// Side length (in level texels) of one dirty-tracking block inside a pyramid level.
const BLOCK_SIDE: i32 = 32;

/// Converts a Figma/Drawpane blur radius to Gaussian standard deviation sigma (decision 0013).
/// Non-positive or non-finite radii return `0.0`.
#[inline]
pub fn sigma_from_radius(radius: f32) -> f32 {
    if radius.is_finite() && radius > 0.0 {
        radius * FIGMA_BLUR_SIGMA
    } else {
        0.0
    }
}

/// Discrete kernel support half-width for `sigma`: `ceil(3.5 * sigma)`, or `0` for negligible sigma.
/// Saturates at `i32::MAX` instead of overflowing on extreme finite sigmas.
#[inline]
pub fn kernel_radius(sigma: f32) -> i32 {
    if !sigma.is_finite() || sigma < MIN_SIGMA {
        0
    } else {
        let raw = (f64::from(sigma) * f64::from(KERNEL_SIGMA_MULT)).ceil();
        if raw >= f64::from(i32::MAX) {
            i32::MAX
        } else {
            (raw as i32).max(1)
        }
    }
}

/// True when `cb` under `edge` defines an infinite constant plane (`1x1` with `EdgeMode::Clamp`),
/// whose Gaussian blur at any finite non-negative sigma is exactly that single pixel.
#[inline]
fn is_constant_clamp_pixel(cb: IRect, edge: EdgeMode) -> bool {
    matches!(edge, EdgeMode::Clamp) && cb.x1 - cb.x0 == 1 && cb.y1 - cb.y0 == 1
}

/// Validates that `sigma` can be evaluated within the bounded tap limit (`MAX_KERNEL_RADIUS`).
pub fn validate_sigma(sigma: f32, cb: IRect, edge: EdgeMode) -> Result<()> {
    if !sigma.is_finite() || sigma < 0.0 {
        return Err(EngineError::malformed("blur sigma must be finite and non-negative"));
    }
    if cb.is_empty() || sigma < MIN_SIGMA || is_constant_clamp_pixel(cb, edge) {
        return Ok(());
    }
    if sigma > MAX_BLUR_SIGMA {
        return Err(EngineError::limit(format!(
            "blur sigma {sigma} exceeds maximum {MAX_BLUR_SIGMA}"
        )));
    }
    Ok(())
}

/// Maximum device-pixel reach from an output pixel needed so split tiles/bands produce
/// bit-identical Gaussian blur output (kernel half-width, downsample cascade, and alignment slack).
pub fn blur_reach(sigma: f32) -> f32 {
    if !sigma.is_finite() || sigma < MIN_SIGMA {
        return 0.0;
    }
    let (lvl, lvl_sigma) = choose_level(sigma.min(MAX_BLUR_SIGMA), MAX_PYRAMID_LEVELS);
    let r = kernel_radius(lvl_sigma);
    if lvl == 0 {
        (r + 2) as f32
    } else {
        ((r + 4) * (1i32 << lvl)) as f32
    }
}

/// The viewport replay can draw radii above the native kernel limit by reducing its density.
pub(crate) fn replay_reach(sigma: f32) -> f32 {
    if !sigma.is_finite() {
        return blur_reach(sigma);
    }
    let ratio = (sigma / MAX_BLUR_SIGMA).max(1.0);
    blur_reach(sigma / ratio) * ratio
}

/// Normalised 1D discrete Gaussian weights for integer taps `-r..=r`, where `r = kernel_radius(sigma)`.
pub fn gaussian_weights(sigma: f32) -> Vec<f32> {
    let r = kernel_radius(sigma);
    if r == 0 {
        return vec![1.0];
    }
    let inv_two_s2 = 1.0 / (2.0 * f64::from(sigma) * f64::from(sigma));
    let mut weights = vec![0.0f64; (2 * r + 1) as usize];
    let center = r as usize;
    weights[center] = 1.0;
    let mut sum = 1.0f64;
    for k in 1..=r {
        let fk = f64::from(k);
        let w = (-fk * fk * inv_two_s2).exp();
        weights[center + k as usize] = w;
        weights[center - k as usize] = w;
        sum += 2.0 * w;
    }
    weights.into_iter().map(|w| (w / sum) as f32).collect()
}

/// Chooses the pyramid level `0..=max_level` and level-space sigma for a full-resolution `sigma`.
///
/// Level 0 runs directly for `sigma <= DIRECT_SIGMA_MAX`. Higher levels `L >= 1` halve resolution
/// by `2^L` and compensate for the variance introduced by `L` separable `[1, 3, 3, 1]/8`
/// downsamples `(4^L - 1) / 4` plus bilinear upsampling `4^L / 6` so the resulting impulse
/// response matches `blur_reference`.
pub fn choose_level(sigma: f32, max_level: usize) -> (usize, f32) {
    if !sigma.is_finite() || sigma < MIN_SIGMA {
        return (0, 0.0);
    }
    let cap = max_level.min(MAX_PYRAMID_LEVELS);
    if cap == 0 || sigma <= DIRECT_SIGMA_MAX {
        return (0, sigma);
    }
    let mut level = 0usize;
    let mut s = 1.0f64;
    let sig = f64::from(sigma);
    while level < cap && sig / s > f64::from(DIRECT_SIGMA_MAX) {
        level += 1;
        s *= 2.0;
    }
    // Separable `[1, 3, 3, 1]/8` downsampling across `level` stages adds variance
    // `sum_{k=0}^{L-1} 0.75 * 4^k = (4^level - 1) / 4` in level-0 px^2, and bilinear upsampling
    // across spacing `s = 2^level` adds average variance `s^2 / 6`.
    let s2 = s * s;
    let pyramid_var = (s2 - 1.0) / 4.0 + s2 / 6.0;
    let rem_var = (sig * sig - pyramid_var).max(0.0);
    let level_sigma = (rem_var.sqrt() / s) as f32;
    (level, level_sigma)
}

/// How many pyramid levels (`0..=L`) can be built for a region of size `width` x `height` up to `MAX_PYRAMID_LEVELS`.
///
/// Because every downsampled level stores a `PYRAMID_APRON`-texel apron on all four sides (`5x5`
/// stored at `1x1` logical), halving continues cleanly up to `MAX_PYRAMID_LEVELS` even for small
/// regions (such as `2x2` sources at large sigmas), keeping the level-space kernel radius strictly
/// bounded at `<= MAX_KERNEL_RADIUS` for every `sigma <= MAX_BLUR_SIGMA`.
pub fn max_pyramid_level(width: u32, height: u32) -> usize {
    if width == 0 || height == 0 {
        0
    } else {
        MAX_PYRAMID_LEVELS
    }
}

/// How samples outside `clamp_bounds` are resolved.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum EdgeMode {
    /// Transparent black (`[0, 0, 0, 0]`) outside `clamp_bounds`: layer blur, drop shadows.
    Zero,
    /// Nearest edge pixel inside `clamp_bounds` repeated: background blur, glass frost.
    Clamp,
    /// Constant premultiplied RGBA color outside `clamp_bounds`: clipping frame with opaque solid fill.
    Border([f32; 4]),
}

/// Hashable representation of `EdgeMode` for pyramid cache keys.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum EdgeKey {
    Zero,
    Clamp,
    Border([u32; 4]),
}

impl EdgeMode {
    #[inline]
    pub fn key(self) -> EdgeKey {
        match self {
            EdgeMode::Zero => EdgeKey::Zero,
            EdgeMode::Clamp => EdgeKey::Clamp,
            EdgeMode::Border(c) => EdgeKey::Border(c.map(|v| {
                // Canonicalise -0.0 to +0.0 and clamp to [0, 1].
                let clamped = v.clamp(0.0, 1.0);
                if clamped == 0.0 {
                    0.0f32.to_bits()
                } else {
                    clamped.to_bits()
                }
            })),
        }
    }

    #[cfg(feature = "gpu-common")]
    #[inline]
    fn mode_code(self) -> i32 {
        match self {
            EdgeMode::Clamp => 1,
            EdgeMode::Zero => 0,
            EdgeMode::Border(_) => 2,
        }
    }

    #[inline]
    fn border_f32(self) -> [f32; 4] {
        match self {
            EdgeMode::Border(c) => c.map(|v| v.clamp(0.0, 1.0)),
            EdgeMode::Zero | EdgeMode::Clamp => [0.0; 4],
        }
    }

    #[inline]
    fn border_u8(self) -> [u8; 4] {
        self.border_f32().map(f32_to_u8)
    }
}

/// Cache key identifying a shareable blur pyramid built over one input picture, region and edge rule.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct PyramidKey {
    /// Caller-assigned identity of the source picture (e.g. scope/backdrop generation + texture id).
    pub source_id: u64,
    /// Valid source pixel region where `edge` applies.
    pub clamp_bounds: IRect,
    /// Edge extension mode.
    pub edge: EdgeKey,
}

impl PyramidKey {
    pub fn new(source_id: u64, clamp_bounds: IRect, edge: EdgeMode) -> Self {
        Self {
            source_id,
            clamp_bounds,
            edge: edge.key(),
        }
    }
}

/// Parameters for one Gaussian blur operation in source pixel coordinates.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BlurSpec {
    /// Standard deviation in device pixels (`sigma_from_radius(radius) * scale`).
    pub sigma: f32,
    /// Edge extension mode outside `clamp_bounds`.
    pub edge: EdgeMode,
    /// Valid region of the source buffer (`[x0, x1) x [y0, y1)` in source pixels).
    pub clamp_bounds: IRect,
    /// Output pixels to compute (`[x0, x1) x [y0, y1)` in source pixel coordinates).
    /// Pixels outside `dirty` are left untouched in the destination buffer.
    pub dirty: IRect,
}

/// Cache reuse statistics for blur pyramids.
#[derive(Default, Clone, Copy, Debug, PartialEq, Eq)]
pub struct BlurCacheStats {
    pub hits: u64,
    pub misses: u64,
    pub evicted: u64,
    pub bytes: usize,
    pub count: usize,
}

#[inline]
fn f32_to_u8(v: f32) -> u8 {
    // Round-to-nearest-even avoids upward bias on ties and matches GPU UNORM8 conversion.
    (v.clamp(0.0, 1.0) * 255.0).round_ties_even() as u8
}

#[inline]
fn u8_to_f32(v: u8) -> f32 {
    f32::from(v) / 255.0
}

#[inline]
fn f32_to_u16(v: f32) -> u16 {
    (v.clamp(0.0, 1.0) * 65535.0).round_ties_even() as u16
}

#[inline]
fn u16_to_f32(v: u16) -> f32 {
    f32::from(v) / 65535.0
}

#[inline]
fn intersect_rect(a: IRect, b: IRect) -> IRect {
    IRect {
        x0: a.x0.max(b.x0),
        y0: a.y0.max(b.y0),
        x1: a.x1.min(b.x1),
        y1: a.y1.min(b.y1),
    }
}

/// Computes the destination-clamped dirty rectangle in source coordinates.
fn effective_dirty(dirty: IRect, dst_size: (u32, u32), dst_origin: (i32, i32)) -> IRect {
    let dst_rect = IRect {
        x0: dst_origin.0,
        y0: dst_origin.1,
        x1: dst_origin.0.saturating_add(dst_size.0 as i32),
        y1: dst_origin.1.saturating_add(dst_size.1 as i32),
    };
    intersect_rect(dirty, dst_rect)
}

/// Logical dimensions `(w_L, h_L)` of pyramid level `level >= 1` for a clamp region `(cb_w, cb_h)`.
/// Stored dimensions include a `PYRAMID_APRON`-texel apron on all four sides: `(w_L + 4, h_L + 4)`.
pub fn level_logical_size(cb_w: u32, cb_h: u32, level: usize) -> (u32, u32) {
    let mut w = cb_w.max(1);
    let mut h = cb_h.max(1);
    for _ in 0..level {
        w = w.div_ceil(2);
        h = h.div_ceil(2);
    }
    (w, h)
}

/// Logical rect at level `level >= 1` that must be blurred so bilinear upsampling covers `dirty`.
fn upsample_blur_rect(dirty: IRect, cb: IRect, level: usize) -> IRect {
    let s = (1u64 << level) as f64;
    let x0 = ((f64::from(dirty.x0) + 0.5 - f64::from(cb.x0)) / s - 0.5).floor() as i32;
    let y0 = ((f64::from(dirty.y0) + 0.5 - f64::from(cb.y0)) / s - 0.5).floor() as i32;
    let x1 = ((f64::from(dirty.x1) - 0.5 - f64::from(cb.x0)) / s - 0.5).floor() as i32 + 2;
    let y1 = ((f64::from(dirty.y1) - 0.5 - f64::from(cb.y0)) / s - 0.5).floor() as i32 + 2;
    IRect { x0, y0, x1, y1 }
}

/// Stored texel range in aproned level `level` needed by a blur over logical `blur_rect` with `r`.
fn level_needed_stored(blur_rect: IRect, r: i32, lw: u32, lh: u32) -> IRect {
    let ap = PYRAMID_APRON;
    let sw = lw as i32 + 2 * ap;
    let sh = lh as i32 + 2 * ap;
    let x0 = (blur_rect.x0 - r + ap).clamp(0, sw - 1);
    let y0 = (blur_rect.y0 - r + ap).clamp(0, sh - 1);
    let x1 = (blur_rect.x1 - 1 + r + ap).clamp(0, sw - 1) + 1;
    let y1 = (blur_rect.y1 - 1 + r + ap).clamp(0, sh - 1) + 1;
    IRect { x0, y0, x1, y1 }
}

/// Given a stored rect to compute in level `k` (`k >= 2`), returns the stored rect needed in level `k - 1`.
fn parent_stored_rect(child_stored: IRect, prev_lw: u32, prev_lh: u32) -> IRect {
    let ap = PYRAMID_APRON;
    let max_x = prev_lw as i32 + 2 * ap - 1;
    let max_y = prev_lh as i32 + 2 * ap - 1;
    let i_min = child_stored.x0 - ap;
    let j_min = child_stored.y0 - ap;
    let i_max = child_stored.x1 - 1 - ap;
    let j_max = child_stored.y1 - 1 - ap;
    // 4-tap downsample at logical `i` reads parent logical `2*i - 1 ..= 2*i + 2`,
    // which sits at parent stored `2*i - 1 + ap ..= 2*i + 2 + ap`.
    IRect {
        x0: (2 * i_min - 1 + ap).clamp(0, max_x),
        y0: (2 * j_min - 1 + ap).clamp(0, max_y),
        x1: (2 * i_max + 2 + ap).clamp(0, max_x) + 1,
        y1: (2 * j_max + 2 + ap).clamp(0, max_y) + 1,
    }
}

/// Compact 32x32-texel block bitset tracking which regions of a pyramid level have already been
/// downsampled, so disjoint or overlapping blurs on the same pyramid never redo computed blocks.
#[derive(Clone, Debug)]
pub struct TileCoverage {
    width: i32,
    height: i32,
    cols: usize,
    rows: usize,
    bits: Vec<u64>,
}

impl TileCoverage {
    pub fn new(width: u32, height: u32) -> Self {
        let w = width as i32;
        let h = height as i32;
        let cols = (w + BLOCK_SIDE - 1).max(0) as usize / BLOCK_SIDE as usize;
        let rows = (h + BLOCK_SIDE - 1).max(0) as usize / BLOCK_SIDE as usize;
        let words = (cols * rows).div_ceil(64);
        Self {
            width: w,
            height: h,
            cols,
            rows,
            bits: vec![0; words],
        }
    }

    pub fn clear(&mut self) {
        self.bits.fill(0);
    }

    #[inline]
    fn get(&self, bx: usize, by: usize) -> bool {
        let idx = by * self.cols + bx;
        (self.bits[idx >> 6] & (1u64 << (idx & 63))) != 0
    }

    #[inline]
    fn set(&mut self, bx: usize, by: usize) {
        let idx = by * self.cols + bx;
        self.bits[idx >> 6] |= 1u64 << (idx & 63);
    }

    /// Returns the tight bounding box (block-aligned, clamped to level size) of unset blocks
    /// intersecting `needed`, or `None` if `needed` is already fully populated.
    pub fn missing_rect(&self, needed: IRect) -> Option<IRect> {
        let r = needed.clamp(self.width, self.height);
        if r.is_empty() || self.cols == 0 || self.rows == 0 {
            return None;
        }
        let bx0 = (r.x0 / BLOCK_SIDE) as usize;
        let by0 = (r.y0 / BLOCK_SIDE) as usize;
        let bx1 = ((r.x1 - 1) / BLOCK_SIDE) as usize;
        let by1 = ((r.y1 - 1) / BLOCK_SIDE) as usize;
        let mut min_x = usize::MAX;
        let mut min_y = usize::MAX;
        let mut max_x = 0usize;
        let mut max_y = 0usize;
        for by in by0..=by1 {
            for bx in bx0..=bx1 {
                if !self.get(bx, by) {
                    min_x = min_x.min(bx);
                    min_y = min_y.min(by);
                    max_x = max_x.max(bx);
                    max_y = max_y.max(by);
                }
            }
        }
        if min_x == usize::MAX {
            return None;
        }
        Some(IRect {
            x0: (min_x as i32 * BLOCK_SIDE).min(self.width),
            y0: (min_y as i32 * BLOCK_SIDE).min(self.height),
            x1: ((max_x as i32 + 1) * BLOCK_SIDE).min(self.width),
            y1: ((max_y as i32 + 1) * BLOCK_SIDE).min(self.height),
        })
    }

    /// Marks every block fully covered by `rect` as populated.
    pub fn mark_rect(&mut self, rect: IRect) {
        let r = rect.clamp(self.width, self.height);
        if r.is_empty() || self.cols == 0 || self.rows == 0 {
            return;
        }
        let bx0 = (r.x0 / BLOCK_SIDE) as usize;
        let by0 = (r.y0 / BLOCK_SIDE) as usize;
        let bx1 = ((r.x1 - 1) / BLOCK_SIDE) as usize;
        let by1 = ((r.y1 - 1) / BLOCK_SIDE) as usize;
        for by in by0..=by1 {
            for bx in bx0..=bx1 {
                self.set(bx, by);
            }
        }
    }
}

#[inline]
fn sample_u8_f32(src: &[u8], src_w: i32, x: i32, y: i32, cb: IRect, edge: EdgeMode) -> [f32; 4] {
    if cb.is_empty() {
        return edge.border_f32();
    }
    let (sx, sy) = match edge {
        EdgeMode::Clamp => (x.clamp(cb.x0, cb.x1 - 1), y.clamp(cb.y0, cb.y1 - 1)),
        EdgeMode::Zero | EdgeMode::Border(_) => {
            if x < cb.x0 || y < cb.y0 || x >= cb.x1 || y >= cb.y1 {
                return edge.border_f32();
            }
            (x, y)
        }
    };
    let i = ((sy * src_w + sx) * 4) as usize;
    [
        u8_to_f32(src[i]),
        u8_to_f32(src[i + 1]),
        u8_to_f32(src[i + 2]),
        u8_to_f32(src[i + 3]),
    ]
}

fn fill_dirty_const(dst: &mut [u8], dst_w: i32, dst_origin: (i32, i32), dirty: IRect, px: [u8; 4]) {
    for y in dirty.y0..dirty.y1 {
        let dy = y - dst_origin.1;
        let row = (dy * dst_w) as usize * 4;
        for x in dirty.x0..dirty.x1 {
            let dx = x - dst_origin.0;
            let o = row + (dx as usize) * 4;
            dst[o..o + 4].copy_from_slice(&px);
        }
    }
}

/// Exact full-resolution separable discrete Gaussian blur (the semantic oracle, decision 0040).
///
/// Reads premultiplied RGBA8 `src` (`src_size.0` x `src_size.1`), applies the normalised discrete
/// kernel over `±ceil(3.5 * spec.sigma)` horizontally then vertically (with `f32` accumulation and
/// round-to-nearest RGBA8 output), and writes only `spec.dirty` into `dst` (whose top-left sits at
/// `dst_origin` in source pixel coordinates).
pub fn blur_reference(
    src: &[u8],
    src_size: (u32, u32),
    dst: &mut [u8],
    dst_size: (u32, u32),
    dst_origin: (i32, i32),
    spec: &BlurSpec,
) {
    let dirty = effective_dirty(spec.dirty, dst_size, dst_origin);
    if dirty.is_empty() {
        return;
    }
    let src_w = src_size.0 as i32;
    let src_h = src_size.1 as i32;
    let dst_w = dst_size.0 as i32;
    let cb = spec.clamp_bounds.clamp(src_w, src_h);
    if cb.is_empty() {
        fill_dirty_const(dst, dst_w, dst_origin, dirty, spec.edge.border_u8());
        return;
    }
    if is_constant_clamp_pixel(cb, spec.edge) {
        let i = ((cb.y0 * src_w + cb.x0) * 4) as usize;
        fill_dirty_const(
            dst,
            dst_w,
            dst_origin,
            dirty,
            [src[i], src[i + 1], src[i + 2], src[i + 3]],
        );
        return;
    }
    let r = kernel_radius(spec.sigma);
    if r == 0 {
        for y in dirty.y0..dirty.y1 {
            let dy = y - dst_origin.1;
            let row = (dy * dst_w) as usize * 4;
            for x in dirty.x0..dirty.x1 {
                let c = sample_u8_f32(src, src_w, x, y, cb, spec.edge);
                let dx = x - dst_origin.0;
                let o = row + (dx as usize) * 4;
                dst[o] = f32_to_u8(c[0]);
                dst[o + 1] = f32_to_u8(c[1]);
                dst[o + 2] = f32_to_u8(c[2]);
                dst[o + 3] = f32_to_u8(c[3]);
            }
        }
        return;
    }

    let dw = (dirty.x1 - dirty.x0) as usize;
    let (iy0, iy1) = match spec.edge {
        EdgeMode::Clamp => (
            (dirty.y0 - r).clamp(cb.y0, cb.y1 - 1),
            (dirty.y1 - 1 + r).clamp(cb.y0, cb.y1 - 1) + 1,
        ),
        EdgeMode::Zero | EdgeMode::Border(_) => {
            let lo = (dirty.y0 - r).max(cb.y0);
            let hi = (dirty.y1 + r).min(cb.y1);
            if lo >= hi {
                fill_dirty_const(dst, dst_w, dst_origin, dirty, spec.edge.border_u8());
                return;
            }
            (lo, hi)
        }
    };
    let ih = (iy1 - iy0) as usize;
    let weights = gaussian_weights(spec.sigma);
    let center = r as usize;
    let border = spec.edge.border_f32();

    // Pass 1 (Horizontal): compute only dirty columns x intermediate rows [iy0, iy1) in f32 so
    // the semantic oracle has zero intermediate quantization error.
    let mut tmp = vec![[0.0f32; 4]; dw * ih];
    for ry in 0..ih {
        let sy = iy0 + ry as i32;
        let tmp_row = ry * dw;
        for rx in 0..dw {
            let sx = dirty.x0 + rx as i32;
            let c0 = sample_u8_f32(src, src_w, sx, sy, cb, spec.edge);
            let w0 = weights[center];
            let mut acc = [c0[0] * w0, c0[1] * w0, c0[2] * w0, c0[3] * w0];
            for k in 1..=r {
                let w = weights[center + k as usize];
                let sp = sample_u8_f32(src, src_w, sx + k, sy, cb, spec.edge);
                let sn = sample_u8_f32(src, src_w, sx - k, sy, cb, spec.edge);
                for ch in 0..4 {
                    acc[ch] += (sp[ch] + sn[ch]) * w;
                }
            }
            tmp[tmp_row + rx] = acc;
        }
    }

    // Pass 2 (Vertical): read from `tmp`, write only `dirty` into `dst`.
    let read_tmp = |rx: usize, sy: i32| -> [f32; 4] {
        let ty = match spec.edge {
            EdgeMode::Clamp => (sy.clamp(cb.y0, cb.y1 - 1) - iy0) as usize,
            EdgeMode::Zero | EdgeMode::Border(_) => {
                if sy < cb.y0 || sy >= cb.y1 {
                    return border;
                }
                (sy - iy0) as usize
            }
        };
        tmp[ty * dw + rx]
    };

    for sy in dirty.y0..dirty.y1 {
        let dy = sy - dst_origin.1;
        let dst_row = (dy * dst_w) as usize * 4;
        for rx in 0..dw {
            let sx = dirty.x0 + rx as i32;
            let c0 = read_tmp(rx, sy);
            let w0 = weights[center];
            let mut acc = [c0[0] * w0, c0[1] * w0, c0[2] * w0, c0[3] * w0];
            for k in 1..=r {
                let w = weights[center + k as usize];
                let sp = read_tmp(rx, sy + k);
                let sn = read_tmp(rx, sy - k);
                for ch in 0..4 {
                    acc[ch] += (sp[ch] + sn[ch]) * w;
                }
            }
            let dx = sx - dst_origin.0;
            let o = dst_row + (dx as usize) * 4;
            for ch in 0..4 {
                dst[o + ch] = f32_to_u8(acc[ch]);
            }
        }
    }
}

/// Convenience wrapper for `blur_reference` when `src` and `dst` have the same size and origin `(0, 0)`.
pub fn blur_reference_same_size(src: &[u8], dst: &mut [u8], width: u32, height: u32, spec: &BlurSpec) {
    blur_reference(src, (width, height), dst, (width, height), (0, 0), spec);
}

/// One halved level (`level >= 1`) of a CPU blur pyramid, stored with a 2-texel apron on all sides
/// in premultiplied RGBA16 UNORM so cascaded downsamples never accumulate 8-bit rounding drift.
pub struct CpuBlurLevel {
    pub width: u32,
    pub height: u32,
    /// Premultiplied RGBA16 UNORM, `(width + 4) * (height + 4) * 4` u16 values.
    pub pixels: Vec<u16>,
    coverage: TileCoverage,
}

impl CpuBlurLevel {
    fn new(width: u32, height: u32) -> Self {
        let ap = (2 * PYRAMID_APRON) as u32;
        let sw = width + ap;
        let sh = height + ap;
        Self {
            width,
            height,
            pixels: vec![0u16; (sw as usize) * (sh as usize) * 4],
            coverage: TileCoverage::new(sw, sh),
        }
    }

    #[inline]
    pub fn stored_size(&self) -> (u32, u32) {
        let ap = (2 * PYRAMID_APRON) as u32;
        (self.width + ap, self.height + ap)
    }

    #[inline]
    fn bytes(&self) -> usize {
        self.pixels.len() * 2 + self.coverage.bits.len() * 8
    }

    fn byte_size(width: u32, height: u32) -> usize {
        let ap = (2 * PYRAMID_APRON) as u32;
        let sw = width.saturating_add(ap) as usize;
        let sh = height.saturating_add(ap) as usize;
        let pixels = sw.saturating_mul(sh).saturating_mul(8);
        let cols = sw.div_ceil(BLOCK_SIDE as usize);
        let rows = sh.div_ceil(BLOCK_SIDE as usize);
        let bits = cols.saturating_mul(rows).div_ceil(64).saturating_mul(8);
        pixels.saturating_add(bits)
    }
}

fn cpu_pyramid_levels_bytes(cb_w: u32, cb_h: u32, from_exclusive: usize, to_inclusive: usize) -> usize {
    let mut total = 0usize;
    for k in (from_exclusive + 1)..=to_inclusive {
        let (lw, lh) = level_logical_size(cb_w, cb_h, k);
        total = total.saturating_add(CpuBlurLevel::byte_size(lw, lh));
    }
    total
}

#[inline]
fn sample_u16_f32_clamp(src: &[u16], sw: i32, sh: i32, x: i32, y: i32) -> [f32; 4] {
    let sx = x.clamp(0, sw - 1);
    let sy = y.clamp(0, sh - 1);
    let i = ((sy * sw + sx) * 4) as usize;
    [
        u16_to_f32(src[i]),
        u16_to_f32(src[i + 1]),
        u16_to_f32(src[i + 2]),
        u16_to_f32(src[i + 3]),
    ]
}

/// Blurs a premultiplied RGBA16 UNORM aproned level with `EdgeMode::Clamp` into `Vec<[f32; 4]>`
/// covering `stored_dirty`, with zero intermediate quantization before bilinear upsampling.
fn blur_u16_level_to_f32(src: &[u16], sw: u32, sh: u32, stored_dirty: IRect, sigma: f32) -> Vec<[f32; 4]> {
    let sw_i = sw as i32;
    let sh_i = sh as i32;
    let bw = (stored_dirty.x1 - stored_dirty.x0) as usize;
    let bh = (stored_dirty.y1 - stored_dirty.y0) as usize;
    let r = kernel_radius(sigma).min(MAX_KERNEL_RADIUS);
    if r == 0 {
        let mut out = vec![[0.0f32; 4]; bw * bh];
        for ry in 0..bh {
            let sy = stored_dirty.y0 + ry as i32;
            for rx in 0..bw {
                let sx = stored_dirty.x0 + rx as i32;
                out[ry * bw + rx] = sample_u16_f32_clamp(src, sw_i, sh_i, sx, sy);
            }
        }
        return out;
    }
    let weights = gaussian_weights(sigma);
    let center = r as usize;
    let iy0 = (stored_dirty.y0 - r).clamp(0, sh_i - 1);
    let iy1 = (stored_dirty.y1 - 1 + r).clamp(0, sh_i - 1) + 1;
    let ih = (iy1 - iy0) as usize;
    let mut tmp = vec![[0.0f32; 4]; bw * ih];
    for ry in 0..ih {
        let sy = iy0 + ry as i32;
        let row = ry * bw;
        for rx in 0..bw {
            let sx = stored_dirty.x0 + rx as i32;
            let c0 = sample_u16_f32_clamp(src, sw_i, sh_i, sx, sy);
            let w0 = weights[center];
            let mut acc = [c0[0] * w0, c0[1] * w0, c0[2] * w0, c0[3] * w0];
            for k in 1..=r {
                let w = weights[center + k as usize];
                let sp = sample_u16_f32_clamp(src, sw_i, sh_i, sx + k, sy);
                let sn = sample_u16_f32_clamp(src, sw_i, sh_i, sx - k, sy);
                for ch in 0..4 {
                    acc[ch] += (sp[ch] + sn[ch]) * w;
                }
            }
            tmp[row + rx] = acc;
        }
    }
    let mut out = vec![[0.0f32; 4]; bw * bh];
    for ry in 0..bh {
        let sy = stored_dirty.y0 + ry as i32;
        let out_row = ry * bw;
        for rx in 0..bw {
            let ty0 = (sy.clamp(0, sh_i - 1) - iy0) as usize;
            let c0 = tmp[ty0 * bw + rx];
            let w0 = weights[center];
            let mut acc = [c0[0] * w0, c0[1] * w0, c0[2] * w0, c0[3] * w0];
            for k in 1..=r {
                let w = weights[center + k as usize];
                let typ = ((sy + k).clamp(0, sh_i - 1) - iy0) as usize;
                let tyn = ((sy - k).clamp(0, sh_i - 1) - iy0) as usize;
                let sp = tmp[typ * bw + rx];
                let sn = tmp[tyn * bw + rx];
                for ch in 0..4 {
                    acc[ch] += (sp[ch] + sn[ch]) * w;
                }
            }
            out[out_row + rx] = acc;
        }
    }
    out
}

/// A shareable, dirty-bounded CPU blur pyramid for one `(source_id, clamp_bounds, edge)`.
pub struct CpuBlurPyramid {
    pub key: PyramidKey,
    pub src_size: (u32, u32),
    pub clamp_bounds: IRect,
    pub edge: EdgeMode,
    /// Index `k - 1` holds level `k` (`k >= 1`, scale `2^k`).
    levels: Vec<CpuBlurLevel>,
    bytes: usize,
    used: u64,
    /// Number of downsample block passes executed on this pyramid (for tests and telemetry).
    pub downsample_ops: u64,
}

impl CpuBlurPyramid {
    pub fn new(key: PyramidKey, src_size: (u32, u32), clamp_bounds: IRect, edge: EdgeMode) -> Self {
        let cb = clamp_bounds.clamp(src_size.0 as i32, src_size.1 as i32);
        Self {
            key,
            src_size,
            clamp_bounds: cb,
            edge,
            levels: Vec::new(),
            bytes: 0,
            used: 0,
            downsample_ops: 0,
        }
    }

    pub fn bytes(&self) -> usize {
        self.bytes
    }

    pub fn max_level(&self) -> usize {
        if self.clamp_bounds.is_empty() {
            return 0;
        }
        max_pyramid_level(
            (self.clamp_bounds.x1 - self.clamp_bounds.x0) as u32,
            (self.clamp_bounds.y1 - self.clamp_bounds.y0) as u32,
        )
    }

    /// Returns a built pyramid level (`1..=levels.len()`), if allocated.
    pub fn level(&self, level: usize) -> Option<&CpuBlurLevel> {
        level.checked_sub(1).and_then(|i| self.levels.get(i))
    }

    /// Ensures levels `1..=level` are allocated and populated over the stored texels required for
    /// `needed_stored` at `level`. Only missing 32x32 blocks are downsampled.
    pub fn ensure_level(&mut self, src: &[u8], level: usize, needed_stored: IRect) {
        if level == 0 || self.clamp_bounds.is_empty() {
            return;
        }
        let cb_w = (self.clamp_bounds.x1 - self.clamp_bounds.x0) as u32;
        let cb_h = (self.clamp_bounds.y1 - self.clamp_bounds.y0) as u32;
        while self.levels.len() < level {
            let k = self.levels.len() + 1;
            let (lw, lh) = level_logical_size(cb_w, cb_h, k);
            let lvl = CpuBlurLevel::new(lw, lh);
            self.bytes += lvl.bytes();
            self.levels.push(lvl);
        }

        // Propagate missing regions top-down from `level` to `1`.
        let mut to_build: Vec<Option<IRect>> = vec![None; level];
        let mut req = needed_stored;
        for k in (1..=level).rev() {
            let lvl = &self.levels[k - 1];
            let Some(miss) = lvl.coverage.missing_rect(req) else {
                break;
            };
            to_build[k - 1] = Some(miss);
            if k > 1 {
                let prev = &self.levels[k - 2];
                req = parent_stored_rect(miss, prev.width, prev.height);
            }
        }

        // Downsample bottom-up from `1` to `level` using separable 4x4 `[1, 3, 3, 1]/8`.
        let src_w = self.src_size.0 as i32;
        let cb = self.clamp_bounds;
        let edge = self.edge;
        let ap = PYRAMID_APRON;
        const W4: [f32; 4] = [1.0, 3.0, 3.0, 1.0];
        if let Some(rect) = to_build[0] {
            let lvl = &mut self.levels[0];
            let sw = lvl.stored_size().0 as usize;
            for ty in rect.y0..rect.y1 {
                let j = ty - ap;
                let sy0 = cb.y0 + 2 * j - 1;
                let row = (ty as usize) * sw * 4;
                for tx in rect.x0..rect.x1 {
                    let i = tx - ap;
                    let sx0 = cb.x0 + 2 * i - 1;
                    let mut acc = [0.0f32; 4];
                    for (dy, &wy) in W4.iter().enumerate() {
                        let sy = sy0 + dy as i32;
                        let s0 = sample_u8_f32(src, src_w, sx0, sy, cb, edge);
                        let s1 = sample_u8_f32(src, src_w, sx0 + 1, sy, cb, edge);
                        let s2 = sample_u8_f32(src, src_w, sx0 + 2, sy, cb, edge);
                        let s3 = sample_u8_f32(src, src_w, sx0 + 3, sy, cb, edge);
                        for ch in 0..4 {
                            acc[ch] += (s0[ch] + 3.0 * s1[ch] + 3.0 * s2[ch] + s3[ch]) * wy;
                        }
                    }
                    let o = row + (tx as usize) * 4;
                    for (slot, &val) in lvl.pixels[o..o + 4].iter_mut().zip(&acc) {
                        *slot = f32_to_u16(val * (1.0 / 64.0));
                    }
                }
            }
            lvl.coverage.mark_rect(rect);
            self.downsample_ops += 1;
        }

        for k in 2..=level {
            let Some(rect) = to_build[k - 1] else {
                continue;
            };
            let (left, right) = self.levels.split_at_mut(k - 1);
            let prev = &left[k - 2];
            let curr = &mut right[0];
            let (pw, ph) = prev.stored_size();
            let pw_i = pw as i32;
            let ph_i = ph as i32;
            let cw = curr.stored_size().0 as usize;
            for ty in rect.y0..rect.y1 {
                let j = ty - ap;
                let py0 = 2 * j - 1 + ap;
                let row = (ty as usize) * cw * 4;
                for tx in rect.x0..rect.x1 {
                    let i = tx - ap;
                    let px0 = 2 * i - 1 + ap;
                    let mut acc = [0.0f32; 4];
                    for (dy, &wy) in W4.iter().enumerate() {
                        let py = py0 + dy as i32;
                        let s0 = sample_u16_f32_clamp(&prev.pixels, pw_i, ph_i, px0, py);
                        let s1 = sample_u16_f32_clamp(&prev.pixels, pw_i, ph_i, px0 + 1, py);
                        let s2 = sample_u16_f32_clamp(&prev.pixels, pw_i, ph_i, px0 + 2, py);
                        let s3 = sample_u16_f32_clamp(&prev.pixels, pw_i, ph_i, px0 + 3, py);
                        for ch in 0..4 {
                            acc[ch] += (s0[ch] + 3.0 * s1[ch] + 3.0 * s2[ch] + s3[ch]) * wy;
                        }
                    }
                    let o = row + (tx as usize) * 4;
                    for (slot, &val) in curr.pixels[o..o + 4].iter_mut().zip(&acc) {
                        *slot = f32_to_u16(val * (1.0 / 64.0));
                    }
                }
            }
            curr.coverage.mark_rect(rect);
            self.downsample_ops += 1;
        }
    }

    /// Blurs `src` with standard deviation `sigma` into `dst` over `dirty`, reusing this pyramid's
    /// downsampled levels whenever `sigma > DIRECT_SIGMA_MAX`.
    #[allow(clippy::too_many_arguments)]
    pub fn blur(
        &mut self,
        src: &[u8],
        dst: &mut [u8],
        dst_size: (u32, u32),
        dst_origin: (i32, i32),
        sigma: f32,
        dirty: IRect,
    ) {
        let dirty = effective_dirty(dirty, dst_size, dst_origin);
        if dirty.is_empty() {
            return;
        }
        let cb = self.clamp_bounds;
        if cb.is_empty() {
            fill_dirty_const(dst, dst_size.0 as i32, dst_origin, dirty, self.edge.border_u8());
            return;
        }
        if is_constant_clamp_pixel(cb, self.edge) {
            let i = ((cb.y0 * self.src_size.0 as i32 + cb.x0) * 4) as usize;
            fill_dirty_const(
                dst,
                dst_size.0 as i32,
                dst_origin,
                dirty,
                [src[i], src[i + 1], src[i + 2], src[i + 3]],
            );
            return;
        }
        let sigma = if sigma.is_finite() {
            sigma.clamp(0.0, MAX_BLUR_SIGMA)
        } else {
            0.0
        };
        let (level, level_sigma) = choose_level(sigma, self.max_level());
        if level == 0 {
            let spec = BlurSpec {
                sigma,
                edge: self.edge,
                clamp_bounds: cb,
                dirty,
            };
            blur_reference(src, self.src_size, dst, dst_size, dst_origin, &spec);
            return;
        }

        let blur_rect = upsample_blur_rect(dirty, cb, level);
        let r_l = kernel_radius(level_sigma).min(MAX_KERNEL_RADIUS);
        let cb_w = (cb.x1 - cb.x0) as u32;
        let cb_h = (cb.y1 - cb.y0) as u32;
        let (lw, lh) = level_logical_size(cb_w, cb_h, level);
        let needed_stored = level_needed_stored(blur_rect, r_l, lw, lh);
        self.ensure_level(src, level, needed_stored);

        let lvl = &self.levels[level - 1];
        let (sw, sh) = lvl.stored_size();
        let bw = (blur_rect.x1 - blur_rect.x0).max(1) as u32;
        let bh = (blur_rect.y1 - blur_rect.y0).max(1) as u32;
        let ap = PYRAMID_APRON;
        // Blur in aproned level-L stored coordinates: logical (i, j) sits at stored (i + ap, j + ap).
        let stored_dirty = IRect {
            x0: blur_rect.x0 + ap,
            y0: blur_rect.y0 + ap,
            x1: blur_rect.x1 + ap,
            y1: blur_rect.y1 + ap,
        };
        let blurred = blur_u16_level_to_f32(&lvl.pixels, sw, sh, stored_dirty, level_sigma);

        // Bilinearly upsample `blurred` into `dst` over `dirty`.
        let inv_scale = 1.0f32 / (1u32 << level) as f32;
        let dst_w = dst_size.0 as i32;
        let bw_i = bw as i32;
        let bh_i = bh as i32;
        for sy in dirty.y0..dirty.y1 {
            let dy = sy - dst_origin.1;
            let dst_row = (dy * dst_w) as usize * 4;
            let ly = (sy as f32 + 0.5 - cb.y0 as f32) * inv_scale - blur_rect.y0 as f32 - 0.5;
            let y0 = ly.floor() as i32;
            let fy = ly - y0 as f32;
            let y1 = (y0 + 1).clamp(0, bh_i - 1);
            let y0 = y0.clamp(0, bh_i - 1);
            let r0 = (y0 * bw_i) as usize;
            let r1 = (y1 * bw_i) as usize;
            for sx in dirty.x0..dirty.x1 {
                let lx = (sx as f32 + 0.5 - cb.x0 as f32) * inv_scale - blur_rect.x0 as f32 - 0.5;
                let x0 = lx.floor() as i32;
                let fx = lx - x0 as f32;
                let x1 = (x0 + 1).clamp(0, bw_i - 1) as usize;
                let x0 = x0.clamp(0, bw_i - 1) as usize;
                let w00 = (1.0 - fx) * (1.0 - fy);
                let w10 = fx * (1.0 - fy);
                let w01 = (1.0 - fx) * fy;
                let w11 = fx * fy;
                let p00 = blurred[r0 + x0];
                let p10 = blurred[r0 + x1];
                let p01 = blurred[r1 + x0];
                let p11 = blurred[r1 + x1];
                let dx = sx - dst_origin.0;
                let o = dst_row + (dx as usize) * 4;
                for ch in 0..4 {
                    let v = p00[ch] * w00 + p10[ch] * w10 + p01[ch] * w01 + p11[ch] * w11;
                    dst[o + ch] = f32_to_u8(v);
                }
            }
        }
    }

    /// Bilinearly samples a built pyramid level (`level >= 1`) at level-0 pixel coordinate `(x, y)`
    /// (with pixel centers at half-integers). Useful for progressive blur and mip-based frost.
    pub fn sample_level(&self, level: usize, x: f32, y: f32) -> [f32; 4] {
        let Some(lvl) = self.level(level) else {
            return self.edge.border_f32();
        };
        let inv_scale = 1.0f32 / (1u32 << level) as f32;
        let (sw, sh) = lvl.stored_size();
        let sw_i = sw as i32;
        let sh_i = sh as i32;
        // Stored texel `tx` has logical index `tx - ap`, center `tx - ap + 0.5`, so stored index
        // for level-0 coordinate `x` is `(x - cb.x0) * inv_scale - 0.5 + ap`.
        let ap_shift = PYRAMID_APRON as f32 - 0.5;
        let sx = (x - self.clamp_bounds.x0 as f32) * inv_scale + ap_shift;
        let sy = (y - self.clamp_bounds.y0 as f32) * inv_scale + ap_shift;
        let x0 = sx.floor() as i32;
        let y0 = sy.floor() as i32;
        let fx = sx - x0 as f32;
        let fy = sy - y0 as f32;
        let x1 = (x0 + 1).clamp(0, sw_i - 1) as usize * 4;
        let x0 = x0.clamp(0, sw_i - 1) as usize * 4;
        let y1 = (y0 + 1).clamp(0, sh_i - 1) as usize * (sw as usize) * 4;
        let y0 = y0.clamp(0, sh_i - 1) as usize * (sw as usize) * 4;
        let w00 = (1.0 - fx) * (1.0 - fy);
        let w10 = fx * (1.0 - fy);
        let w01 = (1.0 - fx) * fy;
        let w11 = fx * fy;
        let mut out = [0.0f32; 4];
        for (ch, slot) in out.iter_mut().enumerate() {
            *slot = u16_to_f32(lvl.pixels[y0 + x0 + ch]) * w00
                + u16_to_f32(lvl.pixels[y0 + x1 + ch]) * w10
                + u16_to_f32(lvl.pixels[y1 + x0 + ch]) * w01
                + u16_to_f32(lvl.pixels[y1 + x1 + ch]) * w11;
        }
        out
    }
}

/// Fallible production CPU Gaussian blur: validates `spec.sigma` against `MAX_BLUR_SIGMA`
/// (returning `ErrorCode::Limit` rather than trapping or exceeding `MAX_KERNEL_RADIUS`), runs
/// direct for `sigma <= DIRECT_SIGMA_MAX`, and uses the aproned pyramid above.
pub fn try_blur_cpu(
    src: &[u8],
    src_size: (u32, u32),
    dst: &mut [u8],
    dst_size: (u32, u32),
    dst_origin: (i32, i32),
    spec: &BlurSpec,
) -> Result<()> {
    let dirty = effective_dirty(spec.dirty, dst_size, dst_origin);
    let cb = spec.clamp_bounds.clamp(src_size.0 as i32, src_size.1 as i32);
    validate_sigma(spec.sigma, cb, spec.edge)?;
    if dirty.is_empty() {
        return Ok(());
    }
    if cb.is_empty() {
        fill_dirty_const(dst, dst_size.0 as i32, dst_origin, dirty, spec.edge.border_u8());
        return Ok(());
    }
    if is_constant_clamp_pixel(cb, spec.edge) {
        let i = ((cb.y0 * src_size.0 as i32 + cb.x0) * 4) as usize;
        fill_dirty_const(
            dst,
            dst_size.0 as i32,
            dst_origin,
            dirty,
            [src[i], src[i + 1], src[i + 2], src[i + 3]],
        );
        return Ok(());
    }
    let max_lvl = max_pyramid_level((cb.x1 - cb.x0) as u32, (cb.y1 - cb.y0) as u32);
    let (level, _) = choose_level(spec.sigma, max_lvl);
    if level == 0 {
        blur_reference(src, src_size, dst, dst_size, dst_origin, spec);
        return Ok(());
    }
    let key = PyramidKey::new(0, cb, spec.edge);
    let mut pyr = CpuBlurPyramid::new(key, src_size, cb, spec.edge);
    pyr.blur(src, dst, dst_size, dst_origin, spec.sigma, spec.dirty);
    Ok(())
}

/// Upper bound on the transient CPU buffers for an uncached blur, apart from source and
/// destination pixels. The dirty rect can only reduce this bound.
pub(crate) fn cpu_work_bytes(src: (u32, u32), dst: (u32, u32), sigma: f32) -> usize {
    let radius = kernel_radius(sigma) as u32;
    if radius == 0 {
        return 0;
    }
    let (level, level_sigma) = choose_level(sigma, max_pyramid_level(src.0, src.1));
    let (columns, rows, pyramid_bytes, weights) = if level == 0 {
        (dst.0, src.1.min(dst.1.saturating_add(2 * radius)), 0, radius)
    } else {
        let step = 1u32 << level;
        let w = dst.0.div_ceil(step).saturating_add(2);
        let h = dst.1.div_ceil(step).saturating_add(2);
        let (_, level_h) = level_logical_size(src.0, src.1, level);
        let level_radius = kernel_radius(level_sigma) as u32;
        let scratch_rows = level_h
            .saturating_add(2 * PYRAMID_APRON as u32)
            .min(h.saturating_add(2 * level_radius));
        (
            w,
            h.saturating_add(scratch_rows),
            cpu_pyramid_levels_bytes(src.0, src.1, 0, level),
            level_radius,
        )
    };
    (columns as usize)
        .saturating_mul(rows as usize)
        .saturating_mul(std::mem::size_of::<[f32; 4]>())
        .saturating_add(pyramid_bytes)
        .saturating_add(((2 * weights + 1) as usize) * (std::mem::size_of::<f64>() + std::mem::size_of::<f32>()))
}

/// Stateless production CPU Gaussian blur: direct for `sigma <= DIRECT_SIGMA_MAX`, pyramid above.
/// Clamps extreme sigmas on non-constant sources to `MAX_BLUR_SIGMA` so kernel radius never
/// exceeds `MAX_KERNEL_RADIUS`; callers needing an explicit `ErrorCode::Limit` refusal should use
/// `try_blur_cpu`.
pub fn blur_cpu(
    src: &[u8],
    src_size: (u32, u32),
    dst: &mut [u8],
    dst_size: (u32, u32),
    dst_origin: (i32, i32),
    spec: &BlurSpec,
) {
    let cb = spec.clamp_bounds.clamp(src_size.0 as i32, src_size.1 as i32);
    if is_constant_clamp_pixel(cb, spec.edge) {
        let dirty = effective_dirty(spec.dirty, dst_size, dst_origin);
        if !dirty.is_empty() {
            let i = ((cb.y0 * src_size.0 as i32 + cb.x0) * 4) as usize;
            fill_dirty_const(
                dst,
                dst_size.0 as i32,
                dst_origin,
                dirty,
                [src[i], src[i + 1], src[i + 2], src[i + 3]],
            );
        }
        return;
    }
    let clamped = BlurSpec {
        sigma: if spec.sigma.is_finite() {
            spec.sigma.clamp(0.0, MAX_BLUR_SIGMA)
        } else {
            0.0
        },
        ..*spec
    };
    let _ = try_blur_cpu(src, src_size, dst, dst_size, dst_origin, &clamped);
}

/// LRU cache of shareable `CpuBlurPyramid`s, strictly bounded by a byte budget at all times,
/// including within a single frame.
pub struct CpuBlurCache {
    map: HashMap<PyramidKey, CpuBlurPyramid>,
    bytes: usize,
    budget: usize,
    frame: u64,
    use_seq: u64,
    pub stats: BlurCacheStats,
}

impl CpuBlurCache {
    pub fn new(budget: usize) -> Self {
        Self {
            map: HashMap::new(),
            bytes: 0,
            budget,
            frame: 0,
            use_seq: 0,
            stats: BlurCacheStats::default(),
        }
    }

    pub fn set_budget(&mut self, budget: usize) {
        self.budget = budget;
        self.evict_for(0, None);
    }

    pub fn budget(&self) -> usize {
        self.budget
    }

    pub fn bytes(&self) -> usize {
        self.bytes
    }

    /// Starts a new frame and enforces the cache budget.
    pub fn begin_frame(&mut self) {
        self.frame += 1;
        self.evict_for(0, None);
    }

    /// Drops every cached pyramid built from `source_id`.
    pub fn invalidate_source(&mut self, source_id: u64) {
        let before = self.map.len();
        let mut freed = 0usize;
        self.map.retain(|k, p| {
            let keep = k.source_id != source_id;
            if !keep {
                freed += p.bytes();
            }
            keep
        });
        self.bytes = self.bytes.saturating_sub(freed);
        self.stats.evicted += (before - self.map.len()) as u64;
        self.sync_stats();
    }

    pub fn clear(&mut self) {
        self.stats.evicted += self.map.len() as u64;
        self.map.clear();
        self.bytes = 0;
        self.sync_stats();
    }

    /// Runs a blur, validating `spec.sigma` and reusing any cached pyramid matching
    /// `(source_id, clamp_bounds, edge)` while strictly respecting `self.budget()` intra-frame.
    #[allow(clippy::too_many_arguments)]
    pub fn try_blur(
        &mut self,
        source_id: u64,
        src: &[u8],
        src_size: (u32, u32),
        dst: &mut [u8],
        dst_size: (u32, u32),
        dst_origin: (i32, i32),
        spec: &BlurSpec,
    ) -> Result<()> {
        let cb = spec.clamp_bounds.clamp(src_size.0 as i32, src_size.1 as i32);
        validate_sigma(spec.sigma, cb, spec.edge)?;
        let dirty = effective_dirty(spec.dirty, dst_size, dst_origin);
        if dirty.is_empty() {
            return Ok(());
        }
        if cb.is_empty() {
            fill_dirty_const(dst, dst_size.0 as i32, dst_origin, dirty, spec.edge.border_u8());
            return Ok(());
        }
        if is_constant_clamp_pixel(cb, spec.edge) {
            let i = ((cb.y0 * src_size.0 as i32 + cb.x0) * 4) as usize;
            fill_dirty_const(
                dst,
                dst_size.0 as i32,
                dst_origin,
                dirty,
                [src[i], src[i + 1], src[i + 2], src[i + 3]],
            );
            return Ok(());
        }
        let cb_w = (cb.x1 - cb.x0) as u32;
        let cb_h = (cb.y1 - cb.y0) as u32;
        let max_lvl = max_pyramid_level(cb_w, cb_h);
        let (level, _) = choose_level(spec.sigma, max_lvl);
        if level == 0 {
            blur_reference(src, src_size, dst, dst_size, dst_origin, spec);
            return Ok(());
        }

        let key = PyramidKey::new(source_id, cb, spec.edge);
        let (existing_levels, existing_bytes) = self.map.get(&key).map_or((0, 0), |p| (p.levels.len(), p.bytes()));
        let add_bytes = if level > existing_levels {
            cpu_pyramid_levels_bytes(cb_w, cb_h, existing_levels, level)
        } else {
            0
        };
        let total_key_bytes = existing_bytes.saturating_add(add_bytes);

        // If this single pyramid does not fit in the cache budget, run it ephemerally without
        // retaining it in the cache so `self.bytes() <= self.budget()` stays strictly enforced.
        if total_key_bytes > self.budget {
            if let Some(old) = self.map.remove(&key) {
                self.bytes = self.bytes.saturating_sub(old.bytes());
                self.stats.evicted += 1;
            }
            self.evict_for(0, None);
            let mut ephemeral = CpuBlurPyramid::new(key, src_size, cb, spec.edge);
            ephemeral.blur(src, dst, dst_size, dst_origin, spec.sigma, spec.dirty);
            return Ok(());
        }

        // Evict LRU entries (including earlier entries from the same frame) BEFORE allocating so
        // peak cache memory never exceeds `self.budget`.
        if add_bytes > 0 {
            self.evict_for(add_bytes, Some(key));
        }

        let pyr = self.get_or_create(key, src_size, cb, spec.edge);
        let before = pyr.bytes();
        pyr.blur(src, dst, dst_size, dst_origin, spec.sigma, spec.dirty);
        let after = pyr.bytes();
        self.bytes = self.bytes - before + after;
        self.evict_for(0, Some(key));
        Ok(())
    }

    /// Runs a blur, reusing any cached pyramid matching `(source_id, clamp_bounds, edge)`.
    #[allow(clippy::too_many_arguments)]
    pub fn blur(
        &mut self,
        source_id: u64,
        src: &[u8],
        src_size: (u32, u32),
        dst: &mut [u8],
        dst_size: (u32, u32),
        dst_origin: (i32, i32),
        spec: &BlurSpec,
    ) {
        let cb = spec.clamp_bounds.clamp(src_size.0 as i32, src_size.1 as i32);
        let clamped = if is_constant_clamp_pixel(cb, spec.edge) {
            *spec
        } else {
            BlurSpec {
                sigma: if spec.sigma.is_finite() {
                    spec.sigma.clamp(0.0, MAX_BLUR_SIGMA)
                } else {
                    0.0
                },
                ..*spec
            }
        };
        let _ = self.try_blur(source_id, src, src_size, dst, dst_size, dst_origin, &clamped);
    }

    /// Ensures levels `1..=level` for `key` are built and returns a shared reference to the cached
    /// pyramid, strictly accounting for allocated bytes against `self.budget()`. Returns `Err(Limit)`
    /// when the pyramid alone exceeds `self.budget()`.
    #[allow(clippy::too_many_arguments)]
    pub fn ensure_pyramid(
        &mut self,
        key: PyramidKey,
        src: &[u8],
        src_size: (u32, u32),
        clamp_bounds: IRect,
        edge: EdgeMode,
        level: usize,
        needed_stored: IRect,
    ) -> Result<&CpuBlurPyramid> {
        let cb = clamp_bounds.clamp(src_size.0 as i32, src_size.1 as i32);
        let cb_w = (cb.x1 - cb.x0).max(0) as u32;
        let cb_h = (cb.y1 - cb.y0).max(0) as u32;
        let (existing_levels, existing_bytes) = self.map.get(&key).map_or((0, 0), |p| (p.levels.len(), p.bytes()));
        let add_bytes = if level > existing_levels && !cb.is_empty() {
            cpu_pyramid_levels_bytes(cb_w, cb_h, existing_levels, level)
        } else {
            0
        };
        if existing_bytes.saturating_add(add_bytes) > self.budget {
            return Err(EngineError::limit("blur pyramid exceeds CPU pyramid cache budget"));
        }
        if add_bytes > 0 {
            self.evict_for(add_bytes, Some(key));
        }
        let pyr = self.get_or_create(key, src_size, cb, edge);
        let before = pyr.bytes();
        pyr.ensure_level(src, level, needed_stored);
        let after = pyr.bytes();
        self.bytes = self.bytes - before + after;
        self.evict_for(0, Some(key));
        Ok(self.map.get(&key).expect("present"))
    }

    /// Gets or creates a cached pyramid for `key` (private so callers cannot grow levels without
    /// updating `self.bytes` and enforcing `self.budget`).
    fn get_or_create(
        &mut self,
        key: PyramidKey,
        src_size: (u32, u32),
        clamp_bounds: IRect,
        edge: EdgeMode,
    ) -> &mut CpuBlurPyramid {
        self.use_seq += 1;
        let seq = self.use_seq;
        if self.map.contains_key(&key) {
            self.stats.hits += 1;
            let p = self.map.get_mut(&key).expect("checked");
            p.used = seq;
            return p;
        }
        self.stats.misses += 1;
        let mut p = CpuBlurPyramid::new(key, src_size, clamp_bounds, edge);
        p.used = seq;
        self.map.insert(key, p);
        self.sync_stats();
        self.map.get_mut(&key).expect("inserted")
    }

    /// Evicts least-recently-used pyramids (including earlier pyramids from the current frame,
    /// excluding only `keep`) until `self.bytes + reserve <= self.budget`.
    fn evict_for(&mut self, reserve: usize, keep: Option<PyramidKey>) {
        if self.bytes.saturating_add(reserve) <= self.budget {
            self.sync_stats();
            return;
        }
        let mut order: Vec<(u64, PyramidKey)> = self
            .map
            .iter()
            .filter(|(k, _)| Some(**k) != keep)
            .map(|(k, p)| (p.used, *k))
            .collect();
        order.sort_unstable_by_key(|(used, _)| *used);
        for (_, k) in order {
            if self.bytes.saturating_add(reserve) <= self.budget {
                break;
            }
            if let Some(p) = self.map.remove(&k) {
                self.bytes = self.bytes.saturating_sub(p.bytes());
                self.stats.evicted += 1;
            }
        }
        self.sync_stats();
    }

    fn sync_stats(&mut self) {
        self.stats.bytes = self.bytes;
        self.stats.count = self.map.len();
    }
}

/// GPU implementation of the reference Gaussian blur and shareable blur pyramid (`blur.wgsl`).
#[cfg(feature = "gpu-common")]
pub mod gpu {
    use super::*;
    use crate::error::{EngineError, Result};

    const SHADER: &str = include_str!(concat!(env!("OUT_DIR"), "/blur.wgsl"));
    const DST_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;
    const UNIFORM_BYTES: usize = 64;
    /// Uniform slots allocated per dynamic uniform slab (256 * 256 B = 64 KiB).
    const SLAB_SLOTS: u32 = 256;

    /// Chooses the highest-precision renderable, filterable format for internal blur pyramids and
    /// scratch textures on `adapter`: `Rgba16Float` on WebGPU Core / WebGL2+float, falling back to
    /// `Rgba8Unorm` on adapters without renderable/filterable half-float targets.
    pub fn preferred_intermediate_format(adapter: &wgpu::Adapter) -> wgpu::TextureFormat {
        let f16 = adapter.get_texture_format_features(wgpu::TextureFormat::Rgba16Float);
        let need_usages = wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING;
        if f16.allowed_usages.contains(need_usages) && f16.flags.contains(wgpu::TextureFormatFeatureFlags::FILTERABLE) {
            wgpu::TextureFormat::Rgba16Float
        } else {
            DST_FORMAT
        }
    }

    fn format_bpp(format: wgpu::TextureFormat) -> usize {
        match format {
            wgpu::TextureFormat::Rgba16Float => 8,
            _ => 4,
        }
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct UniformData {
        p0: [f32; 4],
        clamp_bounds: [f32; 4],
        p2: [f32; 4],
        border: [f32; 4],
    }

    impl UniformData {
        fn to_bytes(self) -> [u8; UNIFORM_BYTES] {
            let mut out = [0u8; UNIFORM_BYTES];
            let floats: [f32; 16] = [
                self.p0[0],
                self.p0[1],
                self.p0[2],
                self.p0[3],
                self.clamp_bounds[0],
                self.clamp_bounds[1],
                self.clamp_bounds[2],
                self.clamp_bounds[3],
                self.p2[0],
                self.p2[1],
                self.p2[2],
                self.p2[3],
                self.border[0],
                self.border[1],
                self.border[2],
                self.border[3],
            ];
            for (i, f) in floats.iter().enumerate() {
                out[i * 4..(i + 1) * 4].copy_from_slice(&f.to_le_bytes());
            }
            out
        }
    }

    struct ScratchTex {
        _texture: wgpu::Texture,
        view: wgpu::TextureView,
        width: u32,
        height: u32,
        bpp: usize,
    }

    impl ScratchTex {
        fn bytes(&self) -> usize {
            self.width as usize * self.height as usize * self.bpp
        }
    }

    /// One downsampled level of a GPU blur pyramid, with a 2-texel apron on all four sides.
    pub struct GpuBlurLevel {
        pub width: u32,
        pub height: u32,
        pub texture: wgpu::Texture,
        pub view: wgpu::TextureView,
        bpp: usize,
        coverage: TileCoverage,
    }

    impl GpuBlurLevel {
        fn stored_size(&self) -> (u32, u32) {
            let ap = (2 * PYRAMID_APRON) as u32;
            (self.width + ap, self.height + ap)
        }
        fn bytes(&self) -> usize {
            let (sw, sh) = self.stored_size();
            sw as usize * sh as usize * self.bpp
        }
    }

    /// Shareable GPU blur pyramid keyed by `(source_id, clamp_bounds, edge)`.
    pub struct GpuBlurPyramid {
        pub key: PyramidKey,
        pub clamp_bounds: IRect,
        pub edge: EdgeMode,
        levels: Vec<GpuBlurLevel>,
        bytes: usize,
        used: u64,
    }

    impl GpuBlurPyramid {
        pub fn max_level(&self) -> usize {
            if self.clamp_bounds.is_empty() {
                return 0;
            }
            max_pyramid_level(
                (self.clamp_bounds.x1 - self.clamp_bounds.x0) as u32,
                (self.clamp_bounds.y1 - self.clamp_bounds.y0) as u32,
            )
        }
    }

    fn make_texture(
        device: &wgpu::Device,
        w: u32,
        h: u32,
        format: wgpu::TextureFormat,
        label: &str,
    ) -> (wgpu::Texture, wgpu::TextureView) {
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some(label),
            size: wgpu::Extent3d {
                width: w.max(1),
                height: h.max(1),
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT
                | wgpu::TextureUsages::TEXTURE_BINDING
                | wgpu::TextureUsages::COPY_SRC
                | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        let view = texture.create_view(&Default::default());
        (texture, view)
    }

    fn make_pipeline(
        device: &wgpu::Device,
        layout: &wgpu::PipelineLayout,
        module: &wgpu::ShaderModule,
        entry: &str,
        format: wgpu::TextureFormat,
        label: &str,
    ) -> wgpu::RenderPipeline {
        device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some(label),
            layout: Some(layout),
            vertex: wgpu::VertexState {
                module,
                entry_point: Some("vs"),
                compilation_options: Default::default(),
                buffers: &[],
            },
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            fragment: Some(wgpu::FragmentState {
                module,
                entry_point: Some(entry),
                compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState {
                    format,
                    blend: None,
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            multiview_mask: None,
            cache: None,
        })
    }

    /// Reusable GPU Gaussian blur pass with dynamic uniform batching and shareable blur pyramids.
    pub struct GpuBlur {
        layout: wgpu::BindGroupLayout,
        intermediate_format: wgpu::TextureFormat,
        inter_bpp: usize,
        blur_1d_inter: wgpu::RenderPipeline,
        blur_1d_dst: wgpu::RenderPipeline,
        downsample_l0: wgpu::RenderPipeline,
        downsample_next: wgpu::RenderPipeline,
        upsample: wgpu::RenderPipeline,
        linear_sampler: wgpu::Sampler,
        uniform_align: u32,
        uniform_slabs: Vec<wgpu::Buffer>,
        slab_idx: usize,
        slab_slot: u32,
        scratch_h: Option<ScratchTex>,
        scratch_v: Option<ScratchTex>,
        pyramids: HashMap<PyramidKey, GpuBlurPyramid>,
        pyramid_bytes: usize,
        pyramid_budget: usize,
        /// Evicted pyramids and replaced scratch textures still referenced by an active
        /// `CommandEncoder`, kept alive and counted in `bytes()` until `flush_retired()` runs
        /// after `queue.submit` (or when an encoder is dropped on error).
        retired: Vec<GpuBlurPyramid>,
        retired_bytes: usize,
        retired_scratch: Vec<ScratchTex>,
        retired_scratch_bytes: usize,
        frame: u64,
        use_seq: u64,
        pub stats: BlurCacheStats,
    }

    impl GpuBlur {
        /// Compiles the blur pipelines once on `device`. Call inside the device's startup error scopes.
        pub fn new(device: &wgpu::Device, intermediate_format: wgpu::TextureFormat, pyramid_budget: usize) -> Self {
            let uniform_align = device.limits().min_uniform_buffer_offset_alignment.max(256);
            let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("blur layout"),
                entries: &[
                    wgpu::BindGroupLayoutEntry {
                        binding: 0,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Texture {
                            sample_type: wgpu::TextureSampleType::Float { filterable: true },
                            view_dimension: wgpu::TextureViewDimension::D2,
                            multisampled: false,
                        },
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 1,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 2,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Uniform,
                            has_dynamic_offset: true,
                            min_binding_size: wgpu::BufferSize::new(UNIFORM_BYTES as u64),
                        },
                        count: None,
                    },
                ],
            });
            let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("blur pipeline layout"),
                bind_group_layouts: &[Some(&layout)],
                immediate_size: 0,
            });
            let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("gaussian blur"),
                source: wgpu::ShaderSource::Wgsl(SHADER.into()),
            });
            let blur_1d_inter = make_pipeline(
                device,
                &pipeline_layout,
                &module,
                "fs_blur_1d",
                intermediate_format,
                "blur 1d inter",
            );
            let blur_1d_dst = make_pipeline(
                device,
                &pipeline_layout,
                &module,
                "fs_blur_1d",
                DST_FORMAT,
                "blur 1d dst",
            );
            let downsample_l0 = make_pipeline(
                device,
                &pipeline_layout,
                &module,
                "fs_downsample_l0",
                intermediate_format,
                "blur down l0",
            );
            let downsample_next = make_pipeline(
                device,
                &pipeline_layout,
                &module,
                "fs_downsample_next",
                intermediate_format,
                "blur down next",
            );
            let upsample = make_pipeline(
                device,
                &pipeline_layout,
                &module,
                "fs_upsample",
                DST_FORMAT,
                "blur upsample",
            );
            let linear_sampler = device.create_sampler(&wgpu::SamplerDescriptor {
                label: Some("blur linear"),
                address_mode_u: wgpu::AddressMode::ClampToEdge,
                address_mode_v: wgpu::AddressMode::ClampToEdge,
                mag_filter: wgpu::FilterMode::Linear,
                min_filter: wgpu::FilterMode::Linear,
                ..Default::default()
            });
            let slab = Self::make_slab(device, uniform_align);
            Self {
                layout,
                intermediate_format,
                inter_bpp: format_bpp(intermediate_format),
                blur_1d_inter,
                blur_1d_dst,
                downsample_l0,
                downsample_next,
                upsample,
                linear_sampler,
                uniform_align,
                uniform_slabs: vec![slab],
                slab_idx: 0,
                slab_slot: 0,
                scratch_h: None,
                scratch_v: None,
                pyramids: HashMap::new(),
                pyramid_bytes: 0,
                pyramid_budget,
                retired: Vec::new(),
                retired_bytes: 0,
                retired_scratch: Vec::new(),
                retired_scratch_bytes: 0,
                frame: 0,
                use_seq: 0,
                stats: BlurCacheStats::default(),
            }
        }

        fn make_slab(device: &wgpu::Device, align: u32) -> wgpu::Buffer {
            device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("blur uniforms"),
                size: u64::from(align) * u64::from(SLAB_SLOTS),
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            })
        }

        /// GPU memory currently held by blur pyramids, scratch textures, in-flight retired
        /// textures, and uniform slabs.
        pub fn bytes(&self) -> usize {
            let uniforms = self.uniform_slabs.len() * (self.uniform_align as usize * SLAB_SLOTS as usize);
            let scratch = self.scratch_h.as_ref().map_or(0, ScratchTex::bytes)
                + self.scratch_v.as_ref().map_or(0, ScratchTex::bytes);
            self.pyramid_bytes
                .saturating_add(self.retired_bytes)
                .saturating_add(scratch)
                .saturating_add(self.retired_scratch_bytes)
                .saturating_add(uniforms)
        }

        /// Releases evicted pyramids and replaced scratch textures after `queue.submit` (or once
        /// an abandoned `CommandEncoder` is dropped), reclaiming their tracked GPU bytes and
        /// explicitly destroying the WebGPU texture handles so VRAM does not wait for JS GC.
        pub fn flush_retired(&mut self) {
            for pyr in self.retired.drain(..) {
                for lvl in pyr.levels {
                    lvl.texture.destroy();
                }
            }
            self.retired_bytes = 0;
            for tex in self.retired_scratch.drain(..) {
                tex._texture.destroy();
            }
            self.retired_scratch_bytes = 0;
        }

        fn scratch_growth(slot: &Option<ScratchTex>, w: u32, h: u32, bpp: usize) -> usize {
            let need_w = w.max(1).next_multiple_of(64);
            let need_h = h.max(1).next_multiple_of(64);
            let reuse = slot.as_ref().is_some_and(|s| {
                s.width >= w
                    && s.height >= h
                    && (s.width as usize * s.height as usize) <= (need_w as usize * need_h as usize * 4).max(65_536)
            });
            if reuse {
                0
            } else {
                (need_w as usize).saturating_mul(need_h as usize).saturating_mul(bpp)
            }
        }

        /// Estimates the peak additional GPU memory `encode` will allocate (above `self.bytes()`)
        /// for pyramid levels and scratch textures so callers can admit blur work against the
        /// engine's GPU budget before creating or submitting textures.
        pub fn estimate_work_bytes(
            &self,
            src_size: (u32, u32),
            dst_size: (u32, u32),
            dst_origin: (i32, i32),
            spec: &BlurSpec,
            pyramid_key: Option<PyramidKey>,
        ) -> usize {
            let dirty = effective_dirty(spec.dirty, dst_size, dst_origin);
            let cb = Self::source_bounds(spec, src_size, dirty);
            let pyramid_key = pyramid_key.map(|key| PyramidKey::new(key.source_id, cb, spec.edge));
            let r = kernel_radius(spec.sigma);
            if dirty.is_empty() || cb.is_empty() || r == 0 || is_constant_clamp_pixel(cb, spec.edge) {
                return 0;
            }
            let cb_w = (cb.x1 - cb.x0) as u32;
            let cb_h = (cb.y1 - cb.y0) as u32;
            let (level, level_sigma) = choose_level(spec.sigma, max_pyramid_level(cb_w, cb_h));
            if level == 0 {
                let r = r.min(MAX_KERNEL_RADIUS);
                let dw = (dirty.x1 - dirty.x0) as u32;
                let (iy0, iy1) = match spec.edge {
                    EdgeMode::Clamp => (
                        (dirty.y0 - r).clamp(cb.y0, cb.y1 - 1),
                        (dirty.y1 - 1 + r).clamp(cb.y0, cb.y1 - 1) + 1,
                    ),
                    EdgeMode::Zero | EdgeMode::Border(_) => {
                        let lo = (dirty.y0 - r).max(cb.y0);
                        let hi = (dirty.y1 + r).min(cb.y1);
                        if lo >= hi {
                            return 0;
                        }
                        (lo, hi)
                    }
                };
                let ih = (iy1 - iy0) as u32;
                return Self::scratch_growth(&self.scratch_h, dw, ih, self.inter_bpp);
            }
            let blur_rect = upsample_blur_rect(dirty, cb, level);
            let r_l = kernel_radius(level_sigma).min(MAX_KERNEL_RADIUS);
            let (_, lh) = level_logical_size(cb_w, cb_h, level);
            let bw = (blur_rect.x1 - blur_rect.x0).max(1) as u32;
            let bh = (blur_rect.y1 - blur_rect.y0).max(1) as u32;
            let sh = lh.saturating_add((2 * PYRAMID_APRON) as u32);
            let stored_y0 = blur_rect.y0 + PYRAMID_APRON;
            let stored_y1 = blur_rect.y1 + PYRAMID_APRON;
            let iy0 = (stored_y0 - r_l).clamp(0, sh as i32 - 1);
            let iy1 = (stored_y1 - 1 + r_l).clamp(0, sh as i32 - 1) + 1;
            let ih = (iy1 - iy0).max(1) as u32;
            let pyramid_total = Self::gpu_pyramid_levels_bytes(cb_w, cb_h, 0, level, self.inter_bpp);
            let oversized = pyramid_total > self.pyramid_budget;
            let ephemeral = pyramid_key.is_none() || oversized;
            let pyr_add = if ephemeral {
                pyramid_total
            } else {
                let key = pyramid_key.expect("checked");
                let existing_levels = self.pyramids.get(&key).map_or(0, |p| p.levels.len());
                if level > existing_levels {
                    Self::gpu_pyramid_levels_bytes(cb_w, cb_h, existing_levels, level, self.inter_bpp)
                } else {
                    0
                }
            };
            let scratch_v_add = Self::scratch_growth(&self.scratch_v, bw, bh, self.inter_bpp);
            let scratch_h_add = Self::scratch_growth(&self.scratch_h, bw, ih, self.inter_bpp);
            pyr_add.saturating_add(scratch_v_add).saturating_add(scratch_h_add)
        }

        /// The pyramid needs the output and its Gaussian support. Keep new
        /// edges on the original sampling grid so a window into a large
        /// backdrop has the same phase as the complete backdrop.
        fn source_bounds(spec: &BlurSpec, src_size: (u32, u32), dirty: IRect) -> IRect {
            let cb = spec.clamp_bounds.clamp(src_size.0 as i32, src_size.1 as i32);
            if cb.is_empty() || dirty.is_empty() || spec.sigma <= DIRECT_SIGMA_MAX {
                return cb;
            }
            let (level, _) = choose_level(spec.sigma.min(MAX_BLUR_SIGMA), MAX_PYRAMID_LEVELS);
            let step = 1 << level;
            let halo = blur_reach(spec.sigma) as i32;
            let axis = |from: i32, to: i32, lo: i32, hi: i32| {
                let a = (from.clamp(lo, hi - 1) - halo - lo).max(0);
                let b = (to.clamp(lo + 1, hi) + halo - lo).max(1);
                (lo + (a / step) * step, hi.min(lo + ((b + step - 1) / step) * step))
            };
            let (x0, x1) = axis(dirty.x0, dirty.x1, cb.x0, cb.x1);
            let (y0, y1) = axis(dirty.y0, dirty.y1, cb.y0, cb.y1);
            let cropped = IRect { x0, y0, x1, y1 };
            let pixels = |r: IRect| i64::from(r.x1 - r.x0) * i64::from(r.y1 - r.y0);
            // Reuse the full-frame pyramid for neighbouring readers when cropping
            // would save little memory.
            if pixels(cb) > 2 * pixels(cropped) { cropped } else { cb }
        }

        pub fn pyramid_bytes(&self) -> usize {
            self.pyramid_bytes
        }

        pub fn pyramid_budget(&self) -> usize {
            self.pyramid_budget
        }

        pub fn set_pyramid_budget(&mut self, budget: usize) {
            self.pyramid_budget = budget;
            self.evict_for(0, None, false);
        }

        /// Starts a new frame: resets the uniform cursor and enforces the pyramid cache budget.
        pub fn begin_frame(&mut self) {
            self.frame += 1;
            self.slab_idx = 0;
            self.slab_slot = 0;
            self.flush_retired();
            self.evict_for(0, None, false);
        }

        /// Drops all cached pyramids derived from `source_id`.
        pub fn invalidate_source(&mut self, source_id: u64) {
            self.invalidate_source_inner(source_id, false);
        }

        fn invalidate_source_inner(&mut self, source_id: u64, retain_until_submit: bool) {
            let keys: Vec<PyramidKey> = self
                .pyramids
                .keys()
                .filter(|k| k.source_id == source_id)
                .copied()
                .collect();
            for k in keys {
                if let Some(p) = self.pyramids.remove(&k) {
                    self.pyramid_bytes = self.pyramid_bytes.saturating_sub(p.bytes);
                    self.stats.evicted += 1;
                    if retain_until_submit {
                        self.retired_bytes = self.retired_bytes.saturating_add(p.bytes);
                        self.retired.push(p);
                    }
                }
            }
            self.sync_stats();
        }

        /// Releases all cached pyramids and scratch textures (call only between submissions).
        pub fn clear(&mut self) {
            self.stats.evicted += self.pyramids.len() as u64;
            for (_, pyr) in self.pyramids.drain() {
                for lvl in pyr.levels {
                    lvl.texture.destroy();
                }
            }
            self.pyramid_bytes = 0;
            if let Some(tex) = self.scratch_h.take() {
                tex._texture.destroy();
            }
            if let Some(tex) = self.scratch_v.take() {
                tex._texture.destroy();
            }
            self.flush_retired();
            self.sync_stats();
        }

        /// Evicts least-recently-used pyramids (including earlier pyramids from the current frame,
        /// excluding only `keep`) until `self.pyramid_bytes + reserve <= self.pyramid_budget`.
        /// When `retain_until_submit` is true (during an active `CommandEncoder`), evicted
        /// pyramids move into `self.retired` so both their GPU resources and byte accounting stay
        /// live until `flush_retired()` runs after `queue.submit`.
        fn evict_for(&mut self, reserve: usize, keep: Option<PyramidKey>, retain_until_submit: bool) {
            if self.pyramid_bytes.saturating_add(reserve) <= self.pyramid_budget {
                self.sync_stats();
                return;
            }
            let mut order: Vec<(u64, PyramidKey)> = self
                .pyramids
                .iter()
                .filter(|(k, _)| Some(**k) != keep)
                .map(|(k, p)| (p.used, *k))
                .collect();
            order.sort_unstable_by_key(|(used, _)| *used);
            for (_, k) in order {
                if self.pyramid_bytes.saturating_add(reserve) <= self.pyramid_budget {
                    break;
                }
                if let Some(p) = self.pyramids.remove(&k) {
                    self.pyramid_bytes = self.pyramid_bytes.saturating_sub(p.bytes);
                    self.stats.evicted += 1;
                    if retain_until_submit {
                        self.retired_bytes = self.retired_bytes.saturating_add(p.bytes);
                        self.retired.push(p);
                    }
                }
            }
            self.sync_stats();
        }

        fn gpu_pyramid_levels_bytes(
            cb_w: u32,
            cb_h: u32,
            from_exclusive: usize,
            to_inclusive: usize,
            bpp: usize,
        ) -> usize {
            let ap2 = (2 * PYRAMID_APRON) as u32;
            let mut total = 0usize;
            for k in (from_exclusive + 1)..=to_inclusive {
                let (lw, lh) = level_logical_size(cb_w, cb_h, k);
                let px = (lw.saturating_add(ap2) as usize).saturating_mul(lh.saturating_add(ap2) as usize);
                total = total.saturating_add(px.saturating_mul(bpp));
            }
            total
        }

        fn sync_stats(&mut self) {
            self.stats.bytes = self.pyramid_bytes;
            self.stats.count = self.pyramids.len();
        }

        fn push_uniform(&mut self, device: &wgpu::Device, queue: &wgpu::Queue, data: UniformData) -> (usize, u32) {
            if self.slab_slot >= SLAB_SLOTS {
                self.slab_idx += 1;
                self.slab_slot = 0;
                if self.slab_idx >= self.uniform_slabs.len() {
                    self.uniform_slabs.push(Self::make_slab(device, self.uniform_align));
                }
            }
            let offset = self.slab_slot * self.uniform_align;
            self.slab_slot += 1;
            queue.write_buffer(&self.uniform_slabs[self.slab_idx], u64::from(offset), &data.to_bytes());
            (self.slab_idx, offset)
        }

        #[allow(clippy::too_many_arguments)]
        fn ensure_scratch(
            slot: &mut Option<ScratchTex>,
            retired_scratch: &mut Vec<ScratchTex>,
            retired_scratch_bytes: &mut usize,
            device: &wgpu::Device,
            format: wgpu::TextureFormat,
            bpp: usize,
            w: u32,
            h: u32,
            label: &str,
        ) {
            let need_w = w.max(1).next_multiple_of(64);
            let need_h = h.max(1).next_multiple_of(64);
            let reuse = slot.as_ref().is_some_and(|s| {
                s.width >= w
                    && s.height >= h
                    && (s.width as usize * s.height as usize) <= (need_w as usize * need_h as usize * 4).max(65_536)
            });
            if !reuse {
                // Keep any replaced scratch texture alive and accounted in `bytes()` until
                // `flush_retired()` runs after `queue.submit`.
                let (texture, view) = make_texture(device, need_w, need_h, format, label);
                if let Some(old) = slot.replace(ScratchTex {
                    _texture: texture,
                    view,
                    width: need_w,
                    height: need_h,
                    bpp,
                }) {
                    *retired_scratch_bytes = retired_scratch_bytes.saturating_add(old.bytes());
                    retired_scratch.push(old);
                }
            }
        }

        fn make_bind_group(
            &self,
            device: &wgpu::Device,
            src_view: &wgpu::TextureView,
            slab_idx: usize,
        ) -> wgpu::BindGroup {
            device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: None,
                layout: &self.layout,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: wgpu::BindingResource::TextureView(src_view),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: wgpu::BindingResource::Sampler(&self.linear_sampler),
                    },
                    wgpu::BindGroupEntry {
                        binding: 2,
                        resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                            buffer: &self.uniform_slabs[slab_idx],
                            offset: 0,
                            size: wgpu::BufferSize::new(UNIFORM_BYTES as u64),
                        }),
                    },
                ],
            })
        }

        #[allow(clippy::too_many_arguments)]
        fn run_dst_blur_1d(
            &mut self,
            device: &wgpu::Device,
            queue: &wgpu::Queue,
            encoder: &mut wgpu::CommandEncoder,
            src_view: &wgpu::TextureView,
            dst_view: &wgpu::TextureView,
            scissor: (u32, u32, u32, u32),
            data: UniformData,
        ) {
            if scissor.2 == 0 || scissor.3 == 0 {
                return;
            }
            let (slab_idx, offset) = self.push_uniform(device, queue, data);
            let group = self.make_bind_group(device, src_view, slab_idx);
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("blur pass dst"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: dst_view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Load,
                        store: wgpu::StoreOp::Store,
                    },
                })],
                ..Default::default()
            });
            pass.set_scissor_rect(scissor.0, scissor.1, scissor.2, scissor.3);
            pass.set_pipeline(&self.blur_1d_dst);
            pass.set_bind_group(0, &group, &[offset]);
            pass.draw(0..3, 0..1);
        }

        /// Returns a cached pyramid level's texture view and stored size (`(w_L + 4, h_L + 4)`),
        /// useful for progressive blur or mip-based glass frost sampling.
        pub fn pyramid_level(&self, key: &PyramidKey, level: usize) -> Option<(&wgpu::TextureView, (u32, u32))> {
            let pyr = self.pyramids.get(key)?;
            let lvl = level.checked_sub(1).and_then(|i| pyr.levels.get(i))?;
            Some((&lvl.view, lvl.stored_size()))
        }

        /// Ensures the cached pyramid `key` has levels `1..=level` downsampled over the stored
        /// texels covering `needed_stored` at `level`. Encodes only missing blocks into `encoder`.
        #[allow(clippy::too_many_arguments)]
        pub fn ensure_pyramid(
            &mut self,
            device: &wgpu::Device,
            queue: &wgpu::Queue,
            encoder: &mut wgpu::CommandEncoder,
            key: PyramidKey,
            src_view: &wgpu::TextureView,
            src_size: (u32, u32),
            edge: EdgeMode,
            level: usize,
            needed_stored: IRect,
        ) -> Result<()> {
            self.ensure_pyramid_inner(
                device,
                queue,
                encoder,
                key,
                src_view,
                src_size,
                edge,
                level,
                needed_stored,
                false,
            )
        }

        #[allow(clippy::too_many_arguments)]
        fn ensure_pyramid_inner(
            &mut self,
            device: &wgpu::Device,
            queue: &wgpu::Queue,
            encoder: &mut wgpu::CommandEncoder,
            key: PyramidKey,
            src_view: &wgpu::TextureView,
            src_size: (u32, u32),
            edge: EdgeMode,
            level: usize,
            needed_stored: IRect,
            allow_oversized_ephemeral: bool,
        ) -> Result<()> {
            if level == 0 {
                return Ok(());
            }
            let cb = key.clamp_bounds.clamp(src_size.0 as i32, src_size.1 as i32);
            if cb.is_empty() {
                return Ok(());
            }
            let max_tex = device.limits().max_texture_dimension_2d;
            let cb_w = (cb.x1 - cb.x0) as u32;
            let cb_h = (cb.y1 - cb.y0) as u32;
            let ap2 = (2 * PYRAMID_APRON) as u32;
            let inter_fmt = self.intermediate_format;
            let inter_bpp = self.inter_bpp;

            // Validate texture dimensions and compute exact byte growth BEFORE allocating or mutating cache.
            let (existing_levels, existing_bytes) =
                self.pyramids.get(&key).map_or((0, 0), |p| (p.levels.len(), p.bytes));
            for k in (existing_levels + 1)..=level {
                let (lw, lh) = level_logical_size(cb_w, cb_h, k);
                if lw + ap2 > max_tex || lh + ap2 > max_tex {
                    return Err(EngineError::limit("blur pyramid exceeds GPU texture limit"));
                }
            }
            let add_bytes = if level > existing_levels {
                Self::gpu_pyramid_levels_bytes(cb_w, cb_h, existing_levels, level, inter_bpp)
            } else {
                0
            };
            let total_key_bytes = existing_bytes.saturating_add(add_bytes);
            if !allow_oversized_ephemeral && total_key_bytes > self.pyramid_budget {
                return Err(EngineError::limit("blur pyramid exceeds GPU pyramid cache budget"));
            }
            if add_bytes > 0 {
                self.evict_for(add_bytes, Some(key), true);
            }

            self.use_seq += 1;
            let seq = self.use_seq;
            if self.pyramids.contains_key(&key) {
                self.stats.hits += 1;
                if let Some(p) = self.pyramids.get_mut(&key) {
                    p.used = seq;
                }
            } else {
                self.stats.misses += 1;
                self.pyramids.insert(
                    key,
                    GpuBlurPyramid {
                        key,
                        clamp_bounds: cb,
                        edge,
                        levels: Vec::new(),
                        bytes: 0,
                        used: seq,
                    },
                );
            }

            let mut added_bytes = 0usize;
            {
                let pyr = self.pyramids.get_mut(&key).expect("inserted");
                while pyr.levels.len() < level {
                    let k = pyr.levels.len() + 1;
                    let (lw, lh) = level_logical_size(cb_w, cb_h, k);
                    let (texture, view) = make_texture(device, lw + ap2, lh + ap2, inter_fmt, "blur pyramid");
                    let lvl = GpuBlurLevel {
                        width: lw,
                        height: lh,
                        texture,
                        view,
                        bpp: inter_bpp,
                        coverage: TileCoverage::new(lw + ap2, lh + ap2),
                    };
                    added_bytes += lvl.bytes();
                    pyr.bytes += lvl.bytes();
                    pyr.levels.push(lvl);
                }
            }
            self.pyramid_bytes += added_bytes;
            self.sync_stats();

            // Determine missing regions top-down.
            let mut to_build: Vec<Option<IRect>> = vec![None; level];
            {
                let pyr = self.pyramids.get(&key).expect("present");
                let mut req = needed_stored;
                for k in (1..=level).rev() {
                    let lvl = &pyr.levels[k - 1];
                    let Some(miss) = lvl.coverage.missing_rect(req) else {
                        break;
                    };
                    to_build[k - 1] = Some(miss);
                    if k > 1 {
                        let prev = &pyr.levels[k - 2];
                        req = parent_stored_rect(miss, prev.width, prev.height);
                    }
                }
            }

            // Encode downsample passes bottom-up.
            if let Some(rect) = to_build[0] {
                let data = UniformData {
                    p0: [0.0; 4],
                    clamp_bounds: [cb.x0 as f32, cb.y0 as f32, cb.x1 as f32, cb.y1 as f32],
                    p2: [0.0, 0.0, edge.mode_code() as f32, 0.0],
                    border: edge.border_f32(),
                };
                let (slab_idx, offset) = self.push_uniform(device, queue, data);
                let group = self.make_bind_group(device, src_view, slab_idx);
                let pyr = self.pyramids.get_mut(&key).expect("present");
                let lvl = &mut pyr.levels[0];
                let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: Some("blur downsample l0"),
                    color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                        view: &lvl.view,
                        depth_slice: None,
                        resolve_target: None,
                        ops: wgpu::Operations {
                            load: wgpu::LoadOp::Load,
                            store: wgpu::StoreOp::Store,
                        },
                    })],
                    ..Default::default()
                });
                pass.set_scissor_rect(
                    rect.x0 as u32,
                    rect.y0 as u32,
                    (rect.x1 - rect.x0) as u32,
                    (rect.y1 - rect.y0) as u32,
                );
                pass.set_pipeline(&self.downsample_l0);
                pass.set_bind_group(0, &group, &[offset]);
                pass.draw(0..3, 0..1);
                drop(pass);
                lvl.coverage.mark_rect(rect);
            }

            for k in 2..=level {
                let Some(rect) = to_build[k - 1] else {
                    continue;
                };
                let (pw, ph) = {
                    let pyr = self.pyramids.get(&key).expect("present");
                    pyr.levels[k - 2].stored_size()
                };
                let data = UniformData {
                    p0: [0.0; 4],
                    clamp_bounds: [0.0, 0.0, pw as f32, ph as f32],
                    p2: [0.0, 0.0, 1.0, 0.0],
                    border: [0.0; 4],
                };
                let (slab_idx, offset) = self.push_uniform(device, queue, data);
                let group = {
                    let pyr = self.pyramids.get(&key).expect("present");
                    self.make_bind_group(device, &pyr.levels[k - 2].view, slab_idx)
                };
                let pyr = self.pyramids.get_mut(&key).expect("present");
                let lvl = &mut pyr.levels[k - 1];
                let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: Some("blur downsample next"),
                    color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                        view: &lvl.view,
                        depth_slice: None,
                        resolve_target: None,
                        ops: wgpu::Operations {
                            load: wgpu::LoadOp::Load,
                            store: wgpu::StoreOp::Store,
                        },
                    })],
                    ..Default::default()
                });
                pass.set_scissor_rect(
                    rect.x0 as u32,
                    rect.y0 as u32,
                    (rect.x1 - rect.x0) as u32,
                    (rect.y1 - rect.y0) as u32,
                );
                pass.set_pipeline(&self.downsample_next);
                pass.set_bind_group(0, &group, &[offset]);
                pass.draw(0..3, 0..1);
                drop(pass);
                lvl.coverage.mark_rect(rect);
            }

            self.evict_for(0, Some(key), true);
            Ok(())
        }

        /// Encodes a separable Gaussian blur into `encoder`, writing only `spec.dirty` into
        /// `dst_view` (at offset `dst_origin`).
        ///
        /// Pass `Some(key)` to reuse/populate a shared blur pyramid across equal inputs.
        #[allow(clippy::too_many_arguments)]
        pub fn encode(
            &mut self,
            device: &wgpu::Device,
            queue: &wgpu::Queue,
            encoder: &mut wgpu::CommandEncoder,
            src_view: &wgpu::TextureView,
            src_size: (u32, u32),
            dst_view: &wgpu::TextureView,
            dst_size: (u32, u32),
            dst_origin: (i32, i32),
            spec: &BlurSpec,
            pyramid_key: Option<PyramidKey>,
        ) -> Result<()> {
            let max_tex = device.limits().max_texture_dimension_2d;
            let dirty = effective_dirty(spec.dirty, dst_size, dst_origin);
            let cb = Self::source_bounds(spec, src_size, dirty);
            let pyramid_key = pyramid_key.map(|key| PyramidKey::new(key.source_id, cb, spec.edge));
            validate_sigma(spec.sigma, cb, spec.edge)?;
            if dirty.is_empty() {
                return Ok(());
            }
            let dst_scissor = (
                (dirty.x0 - dst_origin.0) as u32,
                (dirty.y0 - dst_origin.1) as u32,
                (dirty.x1 - dirty.x0) as u32,
                (dirty.y1 - dirty.y0) as u32,
            );

            // Empty clamp bounds, constant 1x1 clamp pixel, or zero sigma: single pass directly to dst.
            let r = kernel_radius(spec.sigma);
            if cb.is_empty() || r == 0 || is_constant_clamp_pixel(cb, spec.edge) {
                let data = UniformData {
                    p0: [0.0, 0.0, 0.0, 0.0],
                    clamp_bounds: [cb.x0 as f32, cb.y0 as f32, cb.x1 as f32, cb.y1 as f32],
                    p2: [
                        dst_origin.0 as f32,
                        dst_origin.1 as f32,
                        spec.edge.mode_code() as f32,
                        0.0,
                    ],
                    border: spec.edge.border_f32(),
                };
                self.run_dst_blur_1d(device, queue, encoder, src_view, dst_view, dst_scissor, data);
                return Ok(());
            }

            let cb_w = (cb.x1 - cb.x0) as u32;
            let cb_h = (cb.y1 - cb.y0) as u32;
            let (level, level_sigma) = choose_level(spec.sigma, max_pyramid_level(cb_w, cb_h));
            if level == 0 {
                return self.encode_direct(
                    device, queue, encoder, src_view, cb, spec.edge, spec.sigma, dst_view, dst_origin, dirty, max_tex,
                );
            }

            // Large sigma: build/reuse pyramid level `level`, blur at level `level`, then upsample.
            let blur_rect = upsample_blur_rect(dirty, cb, level);
            let r_l = kernel_radius(level_sigma).min(MAX_KERNEL_RADIUS);
            let (lw, lh) = level_logical_size(cb_w, cb_h, level);
            let needed_stored = level_needed_stored(blur_rect, r_l, lw, lh);
            let bw = (blur_rect.x1 - blur_rect.x0).max(1) as u32;
            let bh = (blur_rect.y1 - blur_rect.y0).max(1) as u32;
            if bw > max_tex || bh > max_tex {
                return Err(EngineError::limit("blur intermediate exceeds GPU texture limit"));
            }

            let pyramid_total_bytes = Self::gpu_pyramid_levels_bytes(cb_w, cb_h, 0, level, self.inter_bpp);
            let oversized = pyramid_total_bytes > self.pyramid_budget;
            let ephemeral = pyramid_key.is_none() || oversized;
            let use_key = if ephemeral {
                if let Some(k) = pyramid_key
                    && let Some(old) = self.pyramids.remove(&k)
                {
                    self.pyramid_bytes = self.pyramid_bytes.saturating_sub(old.bytes);
                    self.stats.evicted += 1;
                    self.retired_bytes = self.retired_bytes.saturating_add(old.bytes);
                    self.retired.push(old);
                    self.sync_stats();
                }
                self.invalidate_source_inner(u64::MAX, true);
                PyramidKey::new(u64::MAX, cb, spec.edge)
            } else {
                pyramid_key.expect("checked")
            };
            self.ensure_pyramid_inner(
                device,
                queue,
                encoder,
                use_key,
                src_view,
                src_size,
                spec.edge,
                level,
                needed_stored,
                ephemeral,
            )?;

            let (sw, sh) = self
                .pyramid_level(&use_key, level)
                .ok_or_else(|| EngineError::new(crate::error::ErrorCode::State, "missing blur pyramid level"))?
                .1;
            let ap = PYRAMID_APRON;
            let stored_dirty = IRect {
                x0: blur_rect.x0 + ap,
                y0: blur_rect.y0 + ap,
                x1: blur_rect.x1 + ap,
                y1: blur_rect.y1 + ap,
            };
            let lvl_cb = IRect {
                x0: 0,
                y0: 0,
                x1: sw as i32,
                y1: sh as i32,
            };

            let inter_fmt = self.intermediate_format;
            let inter_bpp = self.inter_bpp;
            Self::ensure_scratch(
                &mut self.scratch_v,
                &mut self.retired_scratch,
                &mut self.retired_scratch_bytes,
                device,
                inter_fmt,
                inter_bpp,
                bw,
                bh,
                "blur level out",
            );

            // Horizontal pass at level L: pyramid[level] -> scratch_h.
            let iy0 = (stored_dirty.y0 - r_l).clamp(0, sh as i32 - 1);
            let iy1 = (stored_dirty.y1 - 1 + r_l).clamp(0, sh as i32 - 1) + 1;
            let ih = (iy1 - iy0) as u32;
            if bw > max_tex || ih > max_tex {
                if ephemeral {
                    self.invalidate_source_inner(u64::MAX, true);
                }
                return Err(EngineError::limit("blur scratch exceeds GPU texture limit"));
            }
            Self::ensure_scratch(
                &mut self.scratch_h,
                &mut self.retired_scratch,
                &mut self.retired_scratch_bytes,
                device,
                inter_fmt,
                inter_bpp,
                bw,
                ih,
                "blur scratch h",
            );

            let inv_two_s2 = if r_l == 0 {
                0.0
            } else {
                1.0 / (2.0 * level_sigma * level_sigma)
            };

            // Pass 1 (H) into scratch_h
            {
                let data_h = UniformData {
                    p0: [1.0, 0.0, inv_two_s2, r_l as f32],
                    clamp_bounds: [lvl_cb.x0 as f32, lvl_cb.y0 as f32, lvl_cb.x1 as f32, lvl_cb.y1 as f32],
                    p2: [stored_dirty.x0 as f32, iy0 as f32, 1.0, 0.0],
                    border: [0.0; 4],
                };
                let (slab_idx, offset) = self.push_uniform(device, queue, data_h);
                let lvl_view = &self.pyramids.get(&use_key).expect("present").levels[level - 1].view;
                let group = self.make_bind_group(device, lvl_view, slab_idx);
                let h_view = &self.scratch_h.as_ref().expect("scratch_h").view;
                let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: Some("blur level h"),
                    color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                        view: h_view,
                        depth_slice: None,
                        resolve_target: None,
                        ops: wgpu::Operations {
                            load: wgpu::LoadOp::Load,
                            store: wgpu::StoreOp::Store,
                        },
                    })],
                    ..Default::default()
                });
                pass.set_scissor_rect(0, 0, bw, ih);
                pass.set_pipeline(&self.blur_1d_inter);
                pass.set_bind_group(0, &group, &[offset]);
                pass.draw(0..3, 0..1);
            }

            // Pass 2 (V): scratch_h -> scratch_v
            {
                let data_v = UniformData {
                    p0: [0.0, 1.0, inv_two_s2, r_l as f32],
                    clamp_bounds: [0.0, 0.0, bw as f32, ih as f32],
                    p2: [0.0, (stored_dirty.y0 - iy0) as f32, 1.0, 0.0],
                    border: [0.0; 4],
                };
                let (slab_idx, offset) = self.push_uniform(device, queue, data_v);
                let h_view = &self.scratch_h.as_ref().expect("scratch_h").view;
                let group = self.make_bind_group(device, h_view, slab_idx);
                let v_view = &self.scratch_v.as_ref().expect("scratch_v").view;
                let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: Some("blur level v"),
                    color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                        view: v_view,
                        depth_slice: None,
                        resolve_target: None,
                        ops: wgpu::Operations {
                            load: wgpu::LoadOp::Load,
                            store: wgpu::StoreOp::Store,
                        },
                    })],
                    ..Default::default()
                });
                pass.set_scissor_rect(0, 0, bw, bh);
                pass.set_pipeline(&self.blur_1d_inter);
                pass.set_bind_group(0, &group, &[offset]);
                pass.draw(0..3, 0..1);
            }

            // Pass 3 (Upsample): scratch_v -> dst_view (scissored to dirty).
            {
                let sv = self.scratch_v.as_ref().expect("scratch_v");
                let inv_scale = 1.0 / (1u32 << level) as f32;
                let data_up = UniformData {
                    p0: [dst_origin.0 as f32, dst_origin.1 as f32, inv_scale, 0.0],
                    clamp_bounds: [cb.x0 as f32, cb.y0 as f32, blur_rect.x0 as f32, blur_rect.y0 as f32],
                    p2: [1.0 / sv.width as f32, 1.0 / sv.height as f32, 0.0, 0.0],
                    border: [bw as f32, bh as f32, 0.0, 0.0],
                };
                let (slab_idx, offset) = self.push_uniform(device, queue, data_up);
                let v_view = &self.scratch_v.as_ref().expect("scratch_v").view;
                let group = self.make_bind_group(device, v_view, slab_idx);
                let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: Some("blur upsample"),
                    color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                        view: dst_view,
                        depth_slice: None,
                        resolve_target: None,
                        ops: wgpu::Operations {
                            load: wgpu::LoadOp::Load,
                            store: wgpu::StoreOp::Store,
                        },
                    })],
                    ..Default::default()
                });
                pass.set_scissor_rect(dst_scissor.0, dst_scissor.1, dst_scissor.2, dst_scissor.3);
                pass.set_pipeline(&self.upsample);
                pass.set_bind_group(0, &group, &[offset]);
                pass.draw(0..3, 0..1);
            }

            if ephemeral {
                self.invalidate_source_inner(u64::MAX, true);
            }
            Ok(())
        }

        #[allow(clippy::too_many_arguments)]
        fn encode_direct(
            &mut self,
            device: &wgpu::Device,
            queue: &wgpu::Queue,
            encoder: &mut wgpu::CommandEncoder,
            src_view: &wgpu::TextureView,
            cb: IRect,
            edge: EdgeMode,
            sigma: f32,
            dst_view: &wgpu::TextureView,
            dst_origin: (i32, i32),
            dirty: IRect,
            max_tex: u32,
        ) -> Result<()> {
            let r = kernel_radius(sigma).min(MAX_KERNEL_RADIUS);
            let dw = (dirty.x1 - dirty.x0) as u32;
            let dst_scissor = (
                (dirty.x0 - dst_origin.0) as u32,
                (dirty.y0 - dst_origin.1) as u32,
                dw,
                (dirty.y1 - dirty.y0) as u32,
            );
            let (iy0, iy1) = match edge {
                EdgeMode::Clamp => (
                    (dirty.y0 - r).clamp(cb.y0, cb.y1 - 1),
                    (dirty.y1 - 1 + r).clamp(cb.y0, cb.y1 - 1) + 1,
                ),
                EdgeMode::Zero | EdgeMode::Border(_) => {
                    let lo = (dirty.y0 - r).max(cb.y0);
                    let hi = (dirty.y1 + r).min(cb.y1);
                    if lo >= hi {
                        // Entire dirty region lies past the blur support of `cb`: write border.
                        let data = UniformData {
                            p0: [0.0; 4],
                            clamp_bounds: [0.0; 4],
                            p2: [0.0, 0.0, edge.mode_code() as f32, 0.0],
                            border: edge.border_f32(),
                        };
                        self.run_dst_blur_1d(device, queue, encoder, src_view, dst_view, dst_scissor, data);
                        return Ok(());
                    }
                    (lo, hi)
                }
            };
            let ih = (iy1 - iy0) as u32;
            if dw > max_tex || ih > max_tex {
                return Err(EngineError::limit("blur scratch exceeds GPU texture limit"));
            }
            let inter_fmt = self.intermediate_format;
            let inter_bpp = self.inter_bpp;
            Self::ensure_scratch(
                &mut self.scratch_h,
                &mut self.retired_scratch,
                &mut self.retired_scratch_bytes,
                device,
                inter_fmt,
                inter_bpp,
                dw,
                ih,
                "blur scratch h",
            );
            let inv_two_s2 = 1.0 / (2.0 * sigma * sigma);

            // Pass 1 (H): src_view -> scratch_h[0..dw, 0..ih].
            {
                let data_h = UniformData {
                    p0: [1.0, 0.0, inv_two_s2, r as f32],
                    clamp_bounds: [cb.x0 as f32, cb.y0 as f32, cb.x1 as f32, cb.y1 as f32],
                    p2: [dirty.x0 as f32, iy0 as f32, edge.mode_code() as f32, 0.0],
                    border: edge.border_f32(),
                };
                let (slab_idx, offset) = self.push_uniform(device, queue, data_h);
                let group = self.make_bind_group(device, src_view, slab_idx);
                let h_view = &self.scratch_h.as_ref().expect("scratch_h").view;
                let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: Some("blur direct h"),
                    color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                        view: h_view,
                        depth_slice: None,
                        resolve_target: None,
                        ops: wgpu::Operations {
                            load: wgpu::LoadOp::Load,
                            store: wgpu::StoreOp::Store,
                        },
                    })],
                    ..Default::default()
                });
                pass.set_scissor_rect(0, 0, dw, ih);
                pass.set_pipeline(&self.blur_1d_inter);
                pass.set_bind_group(0, &group, &[offset]);
                pass.draw(0..3, 0..1);
            }

            // Pass 2 (V): scratch_h -> dst_view (scissored to dirty).
            // In scratch_h, source row `sy` sits at `sy - iy0`. Valid rows of `cb` lie at
            // `[(cb.y0 - iy0).max(0), (cb.y1 - iy0).min(ih))`.
            {
                let v_cb_y0 = (cb.y0 - iy0).max(0);
                let v_cb_y1 = (cb.y1 - iy0).min(ih as i32);
                let data_v = UniformData {
                    p0: [0.0, 1.0, inv_two_s2, r as f32],
                    clamp_bounds: [0.0, v_cb_y0 as f32, dw as f32, v_cb_y1 as f32],
                    p2: [
                        (dst_origin.0 - dirty.x0) as f32,
                        (dst_origin.1 - iy0) as f32,
                        edge.mode_code() as f32,
                        0.0,
                    ],
                    border: edge.border_f32(),
                };
                let (slab_idx, offset) = self.push_uniform(device, queue, data_v);
                let h_view = &self.scratch_h.as_ref().expect("scratch_h").view;
                let group = self.make_bind_group(device, h_view, slab_idx);
                let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: Some("blur direct v"),
                    color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                        view: dst_view,
                        depth_slice: None,
                        resolve_target: None,
                        ops: wgpu::Operations {
                            load: wgpu::LoadOp::Load,
                            store: wgpu::StoreOp::Store,
                        },
                    })],
                    ..Default::default()
                });
                pass.set_scissor_rect(dst_scissor.0, dst_scissor.1, dst_scissor.2, dst_scissor.3);
                pass.set_pipeline(&self.blur_1d_dst);
                pass.set_bind_group(0, &group, &[offset]);
                pass.draw(0..3, 0..1);
            }
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn diff_stats(a: &[u8], b: &[u8], w: usize, h: usize) -> (f64, u8, u8, f64, usize) {
        assert_eq!(a.len(), b.len());
        assert_eq!(a.len(), w * h * 4);
        // Decision 0040 score over both white (255) and black (0) on premultiplied RGBA8 inputs,
        // matching `packages/engine/src/compare.ts`: over black is `c_pre`, over white is
        // `c_pre + (255 - alpha)`.
        let n = w * h;
        let mut sums = [0.0f64; 2];
        let mut max_d = 0u8;
        let mut hist = [[0u32; 256]; 2];
        let tx = w.div_ceil(32);
        let ty = h.div_ceil(32);
        let mut tile_sum = vec![[0.0f64; 2]; tx * ty];
        let mut tile_cnt = vec![0usize; tx * ty];
        let mut severe = 0usize;
        for y in 0..h {
            for x in 0..w {
                let i = (y * w + x) * 4;
                let aa = i32::from(a[i + 3]);
                let ba = i32::from(b[i + 3]);
                let da = aa.abs_diff(ba) as u8;
                let mut worst = da;
                let t = (y / 32) * tx + (x / 32);
                tile_cnt[t] += 1;
                for (bg_idx, bg) in [255i32, 0i32].into_iter().enumerate() {
                    let mut c_sum = 0.0f64;
                    let mut c_max = 0u8;
                    for c in 0..3 {
                        let ac = (i32::from(a[i + c]) + ((bg * (255 - aa) + 127) / 255)).clamp(0, 255);
                        let bc = (i32::from(b[i + c]) + ((bg * (255 - ba) + 127) / 255)).clamp(0, 255);
                        let d = ac.abs_diff(bc) as u8;
                        c_sum += f64::from(d);
                        c_max = c_max.max(d);
                    }
                    let m = c_sum / 3.0;
                    sums[bg_idx] += m;
                    tile_sum[t][bg_idx] += m;
                    hist[bg_idx][usize::from(c_max)] += 1;
                    worst = worst.max(c_max);
                }
                max_d = max_d.max(worst);
                if worst > 16 {
                    severe += 1;
                }
            }
        }
        let p99_of = |h: &[u32; 256]| -> u8 {
            let target = (n as f64 * 0.99) as u32;
            let mut seen = 0u32;
            for (v, &c) in h.iter().enumerate() {
                seen += c;
                if seen > target {
                    return v as u8;
                }
            }
            255
        };
        let p99 = p99_of(&hist[0]).max(p99_of(&hist[1]));
        let worst_tile = tile_sum
            .iter()
            .zip(&tile_cnt)
            .map(|(s, &c)| if c > 0 { s[0].max(s[1]) / c as f64 } else { 0.0 })
            .fold(0.0f64, f64::max);
        (sums[0].max(sums[1]) / n as f64, p99, max_d, worst_tile, severe)
    }

    fn make_pattern(w: u32, h: u32, kind: usize) -> Vec<u8> {
        let mut px = vec![0u8; (w * h * 4) as usize];
        for y in 0..h {
            for x in 0..w {
                let i = ((y * w + x) * 4) as usize;
                let c: [u8; 4] = match kind {
                    // Rounded/box shape in center (drop shadow / layer blur case).
                    0 => {
                        if x >= w / 4 && x < 3 * w / 4 && y >= h / 4 && y < 3 * h / 4 {
                            [220, 120, 40, 255]
                        } else {
                            [0, 0, 0, 0]
                        }
                    }
                    // Sharp vertical + horizontal step edge + semi-transparent quadrant.
                    1 => match (x < w / 2, y < h / 2) {
                        (true, true) => [255, 255, 255, 255],
                        (false, true) => [20, 40, 80, 255],
                        (true, false) => [120, 30, 10, 140],
                        (false, false) => [0, 0, 0, 0],
                    },
                    // Adversarial 1px bright white border on the edges (tests Clamp apron!).
                    2 => {
                        if x == 0 || y == 0 || x == w - 1 || y == h - 1 {
                            [255, 255, 255, 255]
                        } else {
                            [16, 24, 32, 255]
                        }
                    }
                    // High-frequency 2px stripes (aliasing stress test).
                    3 => {
                        if (x / 2) % 2 == 0 {
                            [240, 200, 100, 255]
                        } else {
                            [20, 30, 180, 255]
                        }
                    }
                    // Smooth gradient with partial alpha.
                    _ => {
                        let r = (x * 255 / w.max(1)) as u8;
                        let g = (y * 255 / h.max(1)) as u8;
                        let a = 128 + ((x + y) * 127 / (w + h).max(1)) as u8;
                        [
                            ((u32::from(r) * u32::from(a)) / 255) as u8,
                            ((u32::from(g) * u32::from(a)) / 255) as u8,
                            ((180 * u32::from(a)) / 255) as u8,
                            a,
                        ]
                    }
                };
                px[i..i + 4].copy_from_slice(&c);
            }
        }
        px
    }

    #[test]
    fn sigma_and_weights_follow_decisions_0013_and_0040() {
        assert_eq!(sigma_from_radius(0.0), 0.0);
        assert_eq!(sigma_from_radius(-4.0), 0.0);
        assert_eq!(sigma_from_radius(f32::NAN), 0.0);
        assert_eq!(sigma_from_radius(10.0), 4.5);
        assert_eq!(kernel_radius(0.0), 0);
        assert_eq!(kernel_radius(6.0), 21);
        assert_eq!(kernel_radius(0.4), 2);
        let w = gaussian_weights(4.0);
        assert_eq!(w.len(), 29);
        let sum: f32 = w.iter().sum();
        assert!((sum - 1.0).abs() < 1e-6, "sum = {sum}");
        for i in 0..14 {
            assert_eq!(w[i], w[28 - i], "weights must be symmetric");
        }
    }

    #[test]
    fn reference_matches_naive_2d_gaussian_and_exact_identities() {
        let (w, h) = (31u32, 27u32);
        let mut src = vec![0u8; (w * h * 4) as usize];
        // Single bright pixel impulse + uniform check.
        let cx = 15usize;
        let cy = 13usize;
        src[(cy * w as usize + cx) * 4..((cy * w as usize + cx) * 4) + 4].copy_from_slice(&[255, 128, 64, 255]);
        let full = IRect {
            x0: 0,
            y0: 0,
            x1: w as i32,
            y1: h as i32,
        };
        let sigma = 2.5f32;
        let spec = BlurSpec {
            sigma,
            edge: EdgeMode::Zero,
            clamp_bounds: full,
            dirty: full,
        };
        let mut sep = vec![0u8; src.len()];
        blur_reference_same_size(&src, &mut sep, w, h, &spec);

        // Naive 2D outer-product reference (no intermediate quantization).
        let weights = gaussian_weights(sigma);
        let r = kernel_radius(sigma);
        let mut naive = vec![0u8; src.len()];
        for y in 0..h as i32 {
            for x in 0..w as i32 {
                let mut acc = [0.0f32; 4];
                for dy in -r..=r {
                    let wy = weights[(dy + r) as usize];
                    for dx in -r..=r {
                        let wx = weights[(dx + r) as usize];
                        let s = sample_u8_f32(&src, w as i32, x + dx, y + dy, full, EdgeMode::Zero);
                        for c in 0..4 {
                            acc[c] += s[c] * wx * wy;
                        }
                    }
                }
                let o = ((y * w as i32 + x) * 4) as usize;
                for c in 0..4 {
                    naive[o + c] = f32_to_u8(acc[c]);
                }
            }
        }
        let (mean, p99, max_d, worst_tile, severe) = diff_stats(&sep, &naive, w as usize, h as usize);
        assert!(
            max_d <= 1,
            "separable vs naive 2D: mean={mean} p99={p99} max={max_d} tile={worst_tile} severe={severe}"
        );

        // Uniform color must stay exact under Clamp and matching Border.
        let solid = [90u8, 140, 210, 255];
        let uniform: Vec<u8> = solid.iter().copied().cycle().take(src.len()).collect();
        for edge in [EdgeMode::Clamp, EdgeMode::Border(solid.map(u8_to_f32))] {
            let mut out = vec![0u8; uniform.len()];
            blur_reference_same_size(
                &uniform,
                &mut out,
                w,
                h,
                &BlurSpec {
                    sigma: 5.0,
                    edge,
                    clamp_bounds: full,
                    dirty: full,
                },
            );
            assert_eq!(out, uniform, "uniform color drifted under {edge:?}");
        }

        // Zero sigma is an exact copy.
        let mut copy = vec![0u8; src.len()];
        blur_reference_same_size(
            &src,
            &mut copy,
            w,
            h,
            &BlurSpec {
                sigma: 0.0,
                edge: EdgeMode::Zero,
                clamp_bounds: full,
                dirty: full,
            },
        );
        assert_eq!(copy, src);
    }

    #[test]
    fn pyramid_blur_matches_reference_within_0040_tolerance() {
        // Odd dimensions stress-test aproned odd-half rounding across every level, including
        // level-transition sigmas (10.5, 20.5, 41.0).
        let (w, h) = (129u32, 97u32);
        let full = IRect {
            x0: 0,
            y0: 0,
            x1: w as i32,
            y1: h as i32,
        };
        let edges = [
            EdgeMode::Zero,
            EdgeMode::Clamp,
            EdgeMode::Border([0.15, 0.35, 0.55, 0.8]),
        ];
        let sigmas = [0.5f32, 2.0, 6.0, 10.0, 10.5, 14.0, 18.0, 20.5, 24.0, 33.0, 41.0, 48.0];
        let mut worst_mean = 0.0f64;
        let mut worst_case = String::new();
        for pattern_kind in 0..5 {
            let src = make_pattern(w, h, pattern_kind);
            for edge in edges {
                let mut cache = CpuBlurCache::new(32 << 20);
                for &sigma in &sigmas {
                    let spec = BlurSpec {
                        sigma,
                        edge,
                        clamp_bounds: full,
                        dirty: full,
                    };
                    let mut ref_out = vec![0u8; src.len()];
                    let mut pyr_out = vec![0u8; src.len()];
                    blur_reference_same_size(&src, &mut ref_out, w, h, &spec);
                    cache.blur(1, &src, (w, h), &mut pyr_out, (w, h), (0, 0), &spec);
                    let (mean, p99, max_d, worst_tile, severe) = diff_stats(&pyr_out, &ref_out, w as usize, h as usize);
                    if mean > worst_mean {
                        worst_mean = mean;
                        worst_case = format!(
                            "pattern={pattern_kind} edge={edge:?} sigma={sigma}: mean={mean:.4} p99={p99} max={max_d} worst_tile={worst_tile:.3} severe={severe}"
                        );
                    }
                    assert!(
                        mean <= 0.25 && p99 <= 4 && worst_tile <= 2.0 && severe == 0,
                        "pattern={pattern_kind} edge={edge:?} sigma={sigma}: mean={mean:.4} p99={p99} max={max_d} worst_tile={worst_tile:.3} severe={severe}"
                    );
                }
            }
        }
        eprintln!("worst overall: {worst_case}");
    }

    #[test]
    fn dirty_subrect_and_offset_dst_are_bit_identical_to_full() {
        let (w, h) = (165u32, 129u32);
        let src = make_pattern(w, h, 1);
        let cb = IRect {
            x0: 13,
            y0: 7,
            x1: 147,
            y1: 119,
        };
        let dirty = IRect {
            x0: 5,
            y0: 3,
            x1: 158,
            y1: 124,
        };
        let full = IRect {
            x0: 0,
            y0: 0,
            x1: w as i32,
            y1: h as i32,
        };
        for edge in [EdgeMode::Zero, EdgeMode::Clamp, EdgeMode::Border([0.4, 0.2, 0.1, 1.0])] {
            for sigma in [3.5f32, 14.0, 28.0] {
                let mut full_out = vec![0u8; src.len()];
                blur_cpu(
                    &src,
                    (w, h),
                    &mut full_out,
                    (w, h),
                    (0, 0),
                    &BlurSpec {
                        sigma,
                        edge,
                        clamp_bounds: cb,
                        dirty: full,
                    },
                );

                // Tight destination buffer positioned at `(dirty.x0, dirty.y0)`.
                let dw = (dirty.x1 - dirty.x0) as u32;
                let dh = (dirty.y1 - dirty.y0) as u32;
                let mut sub_out = vec![0xAAu8; (dw * dh * 4) as usize];
                blur_cpu(
                    &src,
                    (w, h),
                    &mut sub_out,
                    (dw, dh),
                    (dirty.x0, dirty.y0),
                    &BlurSpec {
                        sigma,
                        edge,
                        clamp_bounds: cb,
                        dirty,
                    },
                );

                for y in dirty.y0..dirty.y1 {
                    for x in dirty.x0..dirty.x1 {
                        let fi = ((y * w as i32 + x) * 4) as usize;
                        let si = (((y - dirty.y0) * dw as i32 + (x - dirty.x0)) * 4) as usize;
                        assert_eq!(
                            &sub_out[si..si + 4],
                            &full_out[fi..fi + 4],
                            "mismatch at ({x},{y}) edge={edge:?} sigma={sigma}"
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn shared_pyramid_reuses_computed_blocks_and_evicts_under_budget() {
        let (w, h) = (256u32, 256u32);
        let src = make_pattern(w, h, 4);
        let cb = IRect {
            x0: 0,
            y0: 0,
            x1: w as i32,
            y1: h as i32,
        };
        let mut cache = CpuBlurCache::new(1 << 20);
        cache.begin_frame();
        let d1 = IRect {
            x0: 16,
            y0: 16,
            x1: 80,
            y1: 80,
        };
        let d2 = IRect {
            x0: 24,
            y0: 24,
            x1: 72,
            y1: 72,
        };
        let mut o1 = vec![0u8; src.len()];
        let mut o2 = vec![0u8; src.len()];
        cache.blur(
            42,
            &src,
            (w, h),
            &mut o1,
            (w, h),
            (0, 0),
            &BlurSpec {
                sigma: 24.0,
                edge: EdgeMode::Clamp,
                clamp_bounds: cb,
                dirty: d1,
            },
        );
        assert_eq!(cache.stats.misses, 1);
        let key = PyramidKey::new(42, cb, EdgeMode::Clamp);
        let ops_after_first = cache.map.get(&key).unwrap().downsample_ops;
        assert!(ops_after_first >= 1);

        // Second blur inside already-covered region reuses the pyramid with zero new downsamples!
        cache.blur(
            42,
            &src,
            (w, h),
            &mut o2,
            (w, h),
            (0, 0),
            &BlurSpec {
                sigma: 18.0,
                edge: EdgeMode::Clamp,
                clamp_bounds: cb,
                dirty: d2,
            },
        );
        assert_eq!(cache.stats.hits, 1);
        assert_eq!(cache.map.get(&key).unwrap().downsample_ops, ops_after_first);

        // Compare `o2` inside `d2` against a fresh blur: must be bit-identical.
        let mut fresh = vec![0u8; src.len()];
        blur_cpu(
            &src,
            (w, h),
            &mut fresh,
            (w, h),
            (0, 0),
            &BlurSpec {
                sigma: 18.0,
                edge: EdgeMode::Clamp,
                clamp_bounds: cb,
                dirty: d2,
            },
        );
        for y in d2.y0..d2.y1 {
            for x in d2.x0..d2.x1 {
                let i = ((y * w as i32 + x) * 4) as usize;
                assert_eq!(&o2[i..i + 4], &fresh[i..i + 4]);
            }
        }

        // Budget eviction immediately drops pyramids past the new budget.
        cache.set_budget(1);
        assert_eq!(cache.stats.count, 0);
        assert_eq!(cache.bytes(), 0);
        assert_eq!(cache.stats.evicted, 1);
    }

    #[test]
    fn cache_never_exceeds_budget_within_a_single_frame() {
        let side = 256u32;
        let bounds = IRect {
            x0: 0,
            y0: 0,
            x1: side as i32,
            y1: side as i32,
        };
        let spec = BlurSpec {
            sigma: 16.0,
            edge: EdgeMode::Clamp,
            clamp_bounds: bounds,
            dirty: bounds,
        };
        let source = vec![255u8; (side * side * 4) as usize];
        let mut dest = vec![0u8; source.len()];
        let budget = 200_000usize;
        let mut cache = CpuBlurCache::new(budget);
        cache.begin_frame();
        for source_id in 0..8u64 {
            cache.blur(source_id, &source, (side, side), &mut dest, (side, side), (0, 0), &spec);
            assert!(
                cache.bytes() <= budget,
                "after source {source_id}: {} bytes > budget {budget}",
                cache.bytes()
            );
        }
        assert!(cache.stats.evicted >= 6);
        assert_eq!(dest, source);

        // Even a single pyramid larger than the cache budget runs ephemerally without retaining bytes.
        let mut tiny = CpuBlurCache::new(1024);
        tiny.begin_frame();
        let mut out = vec![0u8; source.len()];
        tiny.blur(1, &source, (side, side), &mut out, (side, side), (0, 0), &spec);
        assert!(tiny.bytes() <= tiny.budget());
        assert_eq!(tiny.stats.count, 0);
        assert_eq!(out, source);
    }

    #[test]
    fn small_source_keeps_kernel_tap_bound_and_handles_extreme_sigma() {
        let (level, level_sigma) = choose_level(256.0, max_pyramid_level(2, 2));
        assert!(level >= 5, "level={level}");
        assert!(
            kernel_radius(level_sigma) <= MAX_KERNEL_RADIUS,
            "level={level} level_sigma={level_sigma} radius={}",
            kernel_radius(level_sigma)
        );

        // 2x2 step source at sigma = 256 matches blur_reference across edge modes with bounded taps.
        let src = vec![
            255, 0, 0, 255, 0, 255, 0, 255, //
            0, 0, 255, 255, 255, 255, 255, 255,
        ];
        let cb = IRect {
            x0: 0,
            y0: 0,
            x1: 2,
            y1: 2,
        };
        let dst_dirty = IRect {
            x0: -32,
            y0: -32,
            x1: 34,
            y1: 34,
        };
        let dw = (dst_dirty.x1 - dst_dirty.x0) as u32;
        let dh = (dst_dirty.y1 - dst_dirty.y0) as u32;
        for edge in [EdgeMode::Clamp, EdgeMode::Zero, EdgeMode::Border([0.2, 0.4, 0.6, 0.8])] {
            let spec = BlurSpec {
                sigma: 256.0,
                edge,
                clamp_bounds: cb,
                dirty: dst_dirty,
            };
            let mut ref_out = vec![0u8; (dw * dh * 4) as usize];
            let mut pyr_out = vec![0u8; (dw * dh * 4) as usize];
            blur_reference(
                &src,
                (2, 2),
                &mut ref_out,
                (dw, dh),
                (dst_dirty.x0, dst_dirty.y0),
                &spec,
            );
            try_blur_cpu(
                &src,
                (2, 2),
                &mut pyr_out,
                (dw, dh),
                (dst_dirty.x0, dst_dirty.y0),
                &spec,
            )
            .unwrap();
            let (mean, p99, max_d, worst_tile, severe) = diff_stats(&pyr_out, &ref_out, dw as usize, dh as usize);
            assert!(
                mean <= 0.25 && p99 <= 4 && worst_tile <= 2.0 && severe == 0,
                "2x2 sigma=256 edge={edge:?}: mean={mean:.4} p99={p99} max={max_d} tile={worst_tile:.3} severe={severe}"
            );
        }

        // 1x1 Clamp is an exact constant plane at any finite sigma (including 1e9), never traps.
        let one = [255u8, 255, 255, 255];
        let cb1 = IRect {
            x0: 0,
            y0: 0,
            x1: 1,
            y1: 1,
        };
        let mut out1 = [0u8; 4];
        try_blur_cpu(
            &one,
            (1, 1),
            &mut out1,
            (1, 1),
            (0, 0),
            &BlurSpec {
                sigma: 1e9,
                edge: EdgeMode::Clamp,
                clamp_bounds: cb1,
                dirty: cb1,
            },
        )
        .unwrap();
        assert_eq!(out1, one);

        // Non-constant source past MAX_BLUR_SIGMA refuses cleanly with ErrorCode::Limit.
        let mut out2 = vec![0u8; src.len()];
        let err = try_blur_cpu(
            &src,
            (2, 2),
            &mut out2,
            (2, 2),
            (0, 0),
            &BlurSpec {
                sigma: 1e9,
                edge: EdgeMode::Clamp,
                clamp_bounds: cb,
                dirty: cb,
            },
        )
        .unwrap_err();
        assert_eq!(err.code, crate::error::ErrorCode::Limit);
    }
}
