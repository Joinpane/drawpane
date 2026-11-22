//! Drop and inner shadows (decisions 0013, 0031, and 0040).
//!
//! Reference semantics:
//! - Drop shadow: rasterise the cast geometry (spread shape, open stroked path, or text glyph runs
//!   and decoration bars) shifted in page/device space by `(dx, dy) * view_scale`, blur with the
//!   reference Gaussian (`sigma = sigma_from_radius(blur) * view_scale`, `EdgeMode::Zero`), tint
//!   with the shadow's color (modulated by inherited opacity), and composite under open clips
//!   (including `Outside(shape)` for decision 0031 cut-out shadows).
//! - Inner shadow: rasterise the shrunk/spread shape (`-spread`) shifted in page/device space by
//!   `(dx, dy) * view_scale` into a mask padded by the full Gaussian blur support around the shape's
//!   visible region, blur with the reference Gaussian, invert coverage (`1 - blurred.a`), tint with
//!   the shadow's color, and composite clipped to the layer's shape.
//! - Analytic fast path: for uniform-radius rounded rectangles under similarity transforms with
//!   normal blend, Vello's `fill_blurred_rounded_rect_in` (passing `std_dev = sigma * SQRT_2`,
//!   matching Vello's `erf(d / std_dev)` convention) stands in ONLY inside the measured parameter
//!   domain where it matches `blur_reference` within decision 0040's tolerance across all sizes,
//!   fractional placements, and rotations.
//! - Shadow mask cache: canonical rounded-box and ellipse shadows within `SHADOW_CACHE_MAX_SIDE`
//!   share a strictly budgeted LRU mask cache across identical UI components and pan frames on
//!   both CPU and GPU.
//! - Large-sigma bounded mask path: for `sigma > 20 px` (`level >= 2`), uncached masks rasterise
//!   directly at `1 / 2^(level - 1)` with exact analytical area coverage and variance-compensated
//!   blur + bilinear upsampling, bounding working memory under ~1 MiB even for `radius = 700` on
//!   a `4096 x 1800` Worker export while keeping tiled exports bit-identical.

use crate::blur::{DIRECT_SIGMA_MAX, MAX_PYRAMID_LEVELS, choose_level, kernel_radius};
use crate::exec::IRect;
use crate::geometry;
use crate::record::CanonicalShadowShape;
use std::collections::HashMap;
use vello_common::kurbo::{Affine, BezPath, Point, Rect, Shape};

/// Subpixel anchor phases per pixel for `ShadowMaskCache` (1/16 px grid, max error 0.031 px).
pub const SHADOW_CACHE_PHASES: f64 = 16.0;

/// Maximum side (device pixels) of a single cached canonical shadow mask texture.
pub const SHADOW_CACHE_MAX_SIDE: i32 = 512;

/// Returns `Some(scale)` when `m` is a similarity transform (orthogonal columns of equal positive
/// length: translation, uniform scale, rotation, and/or reflection), so an isotropic device blur
/// maps to an isotropic local blur of `sigma_dev / scale`.
pub fn similarity_scale(m: Affine) -> Option<f64> {
    let [a, b, c, d, _, _] = m.as_coeffs();
    let len2_x = a * a + b * b;
    let len2_y = c * c + d * d;
    if !len2_x.is_finite() || !len2_y.is_finite() || len2_x < 1e-12 || len2_y < 1e-12 {
        return None;
    }
    let dot = a * c + b * d;
    if dot.abs() > 1e-5 * len2_x.max(len2_y) {
        return None;
    }
    if (len2_x - len2_y).abs() > 1e-4 * len2_x.max(len2_y) {
        return None;
    }
    Some(((len2_x + len2_y) * 0.5).sqrt())
}

/// Whether Vello's analytic `fill_blurred_rounded_rect_in` matches our reference Gaussian within
/// decision 0040's tolerance (`mean <= 0.25`, `p99 <= 4`, `worst_tile <= 2`, `severe == 0`) across
/// all integer, fractional, and rotated placements.
///
/// Measured exhaustively against `blur_reference` (`review_analytic_sweep`):
/// - Vello's superellipse analytic formula (`erf7(d / (sqrt(2) * sigma))`) diverges on pills or
///   circles (`r > 0.25 * min_side`), large blur-to-size ratios (`sigma > 0.25 * min_side`),
///   tiny blurs (`sigma < 2`), and high-alpha shadows (`alpha > 0.28`, where corner-approximation
///   error at `r = 0.25 * min_side, sigma = 0.25 * min_side` exceeded `worst_tile = 2.0` on inner
///   shadows at `alpha = 0.55`).
/// - Capping both drop and inner analytic shadows at `alpha <= 0.28` keeps every measured case
///   (across sizes, radii, sigmas, fractional positions, and rotations) inside tolerance with
///   zero failures, while higher-alpha shadows route through `ShadowMaskCache` / reference blur.
pub fn can_use_analytic_shadow(w_dev: f32, h_dev: f32, r_dev: f32, sigma_dev: f32, alpha: f32, _invert: bool) -> bool {
    if !w_dev.is_finite() || !h_dev.is_finite() || !r_dev.is_finite() || !sigma_dev.is_finite() || !alpha.is_finite() {
        return false;
    }
    let min_side = w_dev.min(h_dev);
    if min_side < 8.0 || sigma_dev < 2.0 {
        return false;
    }
    if r_dev > 0.25 * min_side || sigma_dev > 0.25 * min_side {
        return false;
    }
    alpha <= 0.28
}

/// Device-pixel padding around a dirty region so neither the direct Gaussian kernel nor the
/// 4-tap `[1, 3, 3, 1]/8` blur pyramid reads past the padded mask boundary.
pub fn blur_support_pad(sigma: f32) -> i32 {
    let r = kernel_radius(sigma);
    if r == 0 {
        return 1;
    }
    let extra = if sigma <= DIRECT_SIGMA_MAX {
        1
    } else {
        let (lvl, _) = choose_level(sigma, MAX_PYRAMID_LEVELS);
        (1i32 << (lvl + 2).min(12)) + 2
    };
    r.saturating_add(extra)
}

/// Power-of-two downsample shift `k` (`scale = 2^k`) for rasterising a large-sigma shadow mask
/// directly at reduced resolution.
///
/// For `sigma <= 20 px` (`level <= 1`), `shift == 0` (full resolution). For `level >= 2`,
/// `shift = level - 1`, bounding the Gaussian support in rasterised pixels to `<= ~80 px` for any
/// blur radius while preserving Vello's analytical box-filtered coverage and `2^level` tile grid
/// phase alignment.
#[inline]
pub fn shadow_raster_shift(sigma: f32) -> usize {
    if !sigma.is_finite() || sigma <= DIRECT_SIGMA_MAX {
        return 0;
    }
    let (lvl, _) = choose_level(sigma, MAX_PYRAMID_LEVELS);
    lvl.saturating_sub(1)
}

/// Level-space sigma for a shadow mask rasterised at `1 / 2^shift` scale and bilinearly upsampled
/// by `2^shift` back to full device resolution.
///
/// Compensates for the `2^shift x 2^shift` analytical box rasterisation variance `(s^2 - 1) / 12`
/// plus the final bilinear upsample variance `s^2 / 6`.
#[inline]
pub fn scaled_shadow_sigma(sigma: f32, shift: usize) -> f32 {
    if shift == 0 || !sigma.is_finite() || sigma <= 0.0 {
        return sigma;
    }
    let s = f64::from(1u32 << shift);
    let s2 = s * s;
    let extra_var = (s2 - 1.0) / 12.0 + s2 / 6.0;
    let rem = (f64::from(sigma) * f64::from(sigma) - extra_var).max(0.0);
    (rem.sqrt() / s) as f32
}

/// Computes the exact device-pixel mask bounding rectangle for a blurred shadow over `dirty`,
/// phase-locked to `2^L` when `sigma > DIRECT_SIGMA_MAX` so tiled exports match full frames
/// bit-for-bit across tile boundaries.
pub fn compute_mask_rect_bounds(bbox: Rect, dirty: IRect, sigma: f32, max_side: i32) -> Option<IRect> {
    if dirty.is_empty() || !bbox.is_finite() {
        return None;
    }
    let pad = blur_support_pad(sigma);
    let mut raw = IRect::around(bbox).inflate(2, 2).intersect(dirty.inflate(pad, pad));
    if raw.is_empty() {
        return None;
    }
    let step = if sigma <= DIRECT_SIGMA_MAX {
        1
    } else {
        let (lvl, _) = choose_level(sigma, MAX_PYRAMID_LEVELS);
        1i32 << lvl.min(8)
    };
    let align_down = |v: i32| v.div_euclid(step) * step;
    let align_up = |v: i32| (v + step - 1).div_euclid(step) * step;
    raw = IRect {
        x0: align_down(raw.x0),
        y0: align_down(raw.y0),
        x1: align_up(raw.x1),
        y1: align_up(raw.y1),
    };
    let shift = shadow_raster_shift(sigma);
    let max_full = max_side.saturating_mul(1i32 << shift.min(8));
    let cap = align_down(max_full.max(step)).max(step);
    if raw.x1 - raw.x0 > cap {
        let cx = (dirty.x0 + dirty.x1) / 2;
        let x0 = align_down(cx - cap / 2).clamp(raw.x0, raw.x1 - cap);
        raw.x0 = x0;
        raw.x1 = x0 + cap;
    }
    if raw.y1 - raw.y0 > cap {
        let cy = (dirty.y0 + dirty.y1) / 2;
        let y0 = align_down(cy - cap / 2).clamp(raw.y0, raw.y1 - cap);
        raw.y0 = y0;
        raw.y1 = y0 + cap;
    }
    Some(raw)
}

/// Computes the mask rect from device-space filled paths.
pub fn compute_mask_rect(mask_paths: &[BezPath], dirty: IRect, sigma: f32, max_side: i32) -> Option<IRect> {
    let mut bbox: Option<Rect> = None;
    for p in mask_paths {
        if p.is_empty() {
            continue;
        }
        let b = p.bounding_box();
        bbox = Some(bbox.map_or(b, |o| o.union(b)));
    }
    compute_mask_rect_bounds(bbox?, dirty, sigma, max_side)
}

/// Reduced-resolution blurred dirty rectangle needed to bilinearly upsample `dirty` from a
/// reduced-resolution mask covering `mask_rect` at `1 / 2^shift` scale.
///
/// Coordinates may extend outside `[0, sw) x [0, sh)` because `dirty` includes the blur halo
/// outside the unblurred mask bbox (`EdgeMode::Zero` pads the exterior cleanly).
/// Returns `(red_dirty_origin, red_dirty_size)` in reduced-mask texel coordinates.
pub fn reduced_dirty_rect(mask_rect: IRect, dirty: IRect, shift: usize) -> ((i32, i32), (u32, u32)) {
    let s = 1i32 << shift;
    let dx0 = dirty.x0 - mask_rect.x0;
    let dy0 = dirty.y0 - mask_rect.y0;
    let dx1 = dirty.x1 - mask_rect.x0;
    let dy1 = dirty.y1 - mask_rect.y0;
    let rx0 = ((f64::from(dx0) + 0.5) / f64::from(s) - 0.5).floor() as i32;
    let ry0 = ((f64::from(dy0) + 0.5) / f64::from(s) - 0.5).floor() as i32;
    let rx1 = ((f64::from(dx1) - 0.5) / f64::from(s) - 0.5).floor() as i32 + 2;
    let ry1 = ((f64::from(dy1) - 0.5) / f64::from(s) - 0.5).floor() as i32 + 2;
    let w = (rx1 - rx0).max(1) as u32;
    let h = (ry1 - ry0).max(1) as u32;
    ((rx0, ry0), (w, h))
}

/// Bilinearly upsamples a reduced-resolution blurred alpha mask (`src`, premultiplied RGBA8 where
/// alpha holds coverage) into a full-resolution RGBA8 alpha mask (`dst`, white RGB = alpha or 0
/// with alpha in `.a`, inverted when `invert` is true). Matches `shadow.wgsl::fs_upsample_mask`.
#[allow(clippy::too_many_arguments)]
pub fn upsample_shadow_mask_cpu(
    src: &[u8],
    src_size: (u32, u32),
    red_origin: (i32, i32),
    dst: &mut [u8],
    dst_size: (u32, u32),
    dst_origin_in_mask: (i32, i32),
    shift: usize,
    invert: bool,
) {
    let (bw, bh) = (src_size.0 as i32, src_size.1 as i32);
    let (dw, dh) = (dst_size.0 as usize, dst_size.1 as usize);
    let inv_s = 1.0f32 / f32::from(1u16 << shift);
    let ox = dst_origin_in_mask.0 as f32;
    let oy = dst_origin_in_mask.1 as f32;
    let rox = red_origin.0 as f32;
    let roy = red_origin.1 as f32;

    let mut xs = Vec::with_capacity(dw);
    for x in 0..dw {
        let fx = (x as f32 + 0.5 + ox) * inv_s - rox - 0.5;
        let fxc = fx.clamp(0.0, (bw - 1) as f32);
        let x0 = fxc.floor() as i32;
        let x1 = (x0 + 1).min(bw - 1);
        let tx = fxc - x0 as f32;
        xs.push((x0 as usize, x1 as usize, tx));
    }

    let bwu = bw as usize;
    for y in 0..dh {
        let fy = (y as f32 + 0.5 + oy) * inv_s - roy - 0.5;
        let fyc = fy.clamp(0.0, (bh - 1) as f32);
        let y0 = fyc.floor() as i32;
        let y1 = (y0 + 1).min(bh - 1);
        let ty = fyc - y0 as f32;
        let row0 = y0 as usize * bwu;
        let row1 = y1 as usize * bwu;
        let out_row = &mut dst[y * dw * 4..(y + 1) * dw * 4];
        for (x, &(x0, x1, tx)) in xs.iter().enumerate() {
            let a00 = f32::from(src[(row0 + x0) * 4 + 3]);
            let a10 = f32::from(src[(row0 + x1) * 4 + 3]);
            let a01 = f32::from(src[(row1 + x0) * 4 + 3]);
            let a11 = f32::from(src[(row1 + x1) * 4 + 3]);
            let top = a00 + (a10 - a00) * tx;
            let bot = a01 + (a11 - a01) * tx;
            let mut a = (top + (bot - top) * ty) / 255.0;
            if invert {
                a = 1.0 - a;
            }
            let q = (a.clamp(0.0, 1.0) * 255.0).round_ties_even() as u8;
            let o = x * 4;
            out_row[o] = 0;
            out_row[o + 1] = 0;
            out_row[o + 2] = 0;
            out_row[o + 3] = q;
        }
    }
}

/// Canonical cache key for a blurred box/oval shadow mask.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ShadowMaskKey {
    /// 0 = rounded rect, 1 = ellipse.
    pub kind: u8,
    pub invert: bool,
    pub px: u8,
    pub py: u8,
    pub w: u32,
    pub h: u32,
    pub radii: [u32; 4],
    pub linear: [u32; 4],
    /// Device sigma quantised to 1/16 px so floating-point camera noise still hits the cache.
    pub sigma_q: u32,
}

/// Resolved canonical shadow descriptor for cache lookup and canonical rasterisation.
#[derive(Clone, Debug)]
pub struct CanonicalShadow {
    pub key: ShadowMaskKey,
    /// Whole-pixel device anchor of the shape's `(0, 0)` origin.
    pub anchor: (i32, i32),
    /// Canonical blurred mask rect relative to `anchor` (always covers full shape + blur support).
    pub mask_rect: IRect,
    /// Shape path in canonical coordinates (placed at `(px/16, py/16)` under `linear`).
    pub path: BezPath,
    /// Quantised sigma matching `key.sigma_q`.
    pub sigma: f32,
}

#[inline]
fn canon_f32_bits(v: f32) -> u32 {
    if v == 0.0 { 0.0f32.to_bits() } else { v.to_bits() }
}

/// Attempts to build a canonical cacheable shadow descriptor for a single primitive shape.
/// Returns `None` when the shadow's full blurred bounding box exceeds `SHADOW_CACHE_MAX_SIDE` or
/// has non-finite coordinates.
pub fn canonical_shadow(
    shape: CanonicalShadowShape,
    shifted_device: Affine,
    sigma: f32,
    invert: bool,
) -> Option<CanonicalShadow> {
    if !sigma.is_finite() || sigma <= 0.0 {
        return None;
    }
    let [a, b, c, d, _, _] = shifted_device.as_coeffs();
    if ![a, b, c, d].iter().all(|v| v.is_finite()) {
        return None;
    }
    let (kind, sx, sy, w, h, radii) = match shape {
        CanonicalShadowShape::Box { x, y, w, h, radii } => (0u8, x, y, w, h, radii),
        CanonicalShadowShape::Oval { x, y, w, h } => (1u8, x, y, w, h, [0.0; 4]),
    };
    let origin = shifted_device * Point::new(f64::from(sx), f64::from(sy));
    if !origin.x.is_finite() || !origin.y.is_finite() || origin.x.abs() > 1.0e7 || origin.y.abs() > 1.0e7 {
        return None;
    }
    let mut ix = origin.x.floor() as i32;
    let mut iy = origin.y.floor() as i32;
    let mut px = ((origin.x - f64::from(ix)) * SHADOW_CACHE_PHASES).round();
    let mut py = ((origin.y - f64::from(iy)) * SHADOW_CACHE_PHASES).round();
    if px >= SHADOW_CACHE_PHASES {
        px = 0.0;
        ix += 1;
    }
    if py >= SHADOW_CACHE_PHASES {
        py = 0.0;
        iy += 1;
    }
    let sigma_q = (f64::from(sigma) * 16.0).round().clamp(1.0, f64::from(u32::MAX)) as u32;
    let sigma_canon = sigma_q as f32 / 16.0;
    let linear_aff = Affine::new([
        f64::from(a as f32),
        f64::from(b as f32),
        f64::from(c as f32),
        f64::from(d as f32),
        px / SHADOW_CACHE_PHASES,
        py / SHADOW_CACHE_PHASES,
    ]);
    let local_bbox = Rect::new(0.0, 0.0, f64::from(w), f64::from(h));
    let dev_bbox = linear_aff.transform_rect_bbox(local_bbox);
    let pad = kernel_radius(sigma_canon) + 2;
    let mask_rect = IRect::around(dev_bbox).inflate(pad, pad);
    let mw = mask_rect.x1 - mask_rect.x0;
    let mh = mask_rect.y1 - mask_rect.y0;
    if mw <= 0 || mh <= 0 || mw > SHADOW_CACHE_MAX_SIDE || mh > SHADOW_CACHE_MAX_SIDE {
        return None;
    }
    let mut path = match shape {
        CanonicalShadowShape::Box { w, h, radii, .. } => geometry::rounded_rect(w, h, radii, 0.0),
        CanonicalShadowShape::Oval { w, h, .. } => geometry::ellipse(w, h),
    };
    path.apply_affine(linear_aff);
    let key = ShadowMaskKey {
        kind,
        invert,
        px: px as u8,
        py: py as u8,
        w: canon_f32_bits(w),
        h: canon_f32_bits(h),
        radii: radii.map(canon_f32_bits),
        linear: [
            canon_f32_bits(a as f32),
            canon_f32_bits(b as f32),
            canon_f32_bits(c as f32),
            canon_f32_bits(d as f32),
        ],
        sigma_q,
    };
    Some(CanonicalShadow {
        key,
        anchor: (ix, iy),
        mask_rect,
        path,
        sigma: sigma_canon,
    })
}

pub struct ShadowCacheEntry<T> {
    pub value: T,
    /// Top-left offset of the cached mask from the shape's integer anchor.
    pub origin: (i32, i32),
    pub size: (u16, u16),
    pub bytes: usize,
    use_seq: u64,
}

/// Strictly budgeted LRU cache for canonical blurred shadow masks.
/// Evicts least-recently-used entries BEFORE admitting a new one so `bytes <= budget` holds at
/// every point, including within a single frame.
pub struct ShadowMaskCache<T> {
    map: HashMap<ShadowMaskKey, ShadowCacheEntry<T>>,
    bytes: usize,
    budget: usize,
    use_seq: u64,
    pub hits: u64,
    pub misses: u64,
}

impl<T> ShadowMaskCache<T> {
    pub fn new(budget: usize) -> Self {
        Self {
            map: HashMap::new(),
            bytes: 0,
            budget,
            use_seq: 0,
            hits: 0,
            misses: 0,
        }
    }

    pub fn bytes(&self) -> usize {
        self.bytes
    }

    pub fn budget(&self) -> usize {
        self.budget
    }

    pub fn set_budget(&mut self, budget: usize) -> Vec<T> {
        self.budget = budget;
        self.evict_to(budget)
    }

    pub fn get(&mut self, key: &ShadowMaskKey) -> Option<&ShadowCacheEntry<T>> {
        self.use_seq += 1;
        let seq = self.use_seq;
        let e = self.map.get_mut(key)?;
        e.use_seq = seq;
        self.hits += 1;
        Some(e)
    }

    pub fn fits_budget(&self, bytes: usize) -> bool {
        bytes > 0 && bytes <= self.budget
    }

    /// Evicts oldest entries until `self.bytes + need <= self.budget`, returning evicted values so
    /// GPU callers can retire them safely after the current scene flushes.
    pub fn evict_for(&mut self, need: usize) -> Vec<T> {
        let target = self.budget.saturating_sub(need);
        self.evict_to(target)
    }

    pub fn evict_to(&mut self, target_bytes: usize) -> Vec<T> {
        let mut evicted = Vec::new();
        if self.bytes <= target_bytes {
            return evicted;
        }
        let mut order: Vec<(u64, ShadowMaskKey)> = self.map.iter().map(|(k, e)| (e.use_seq, *k)).collect();
        order.sort_unstable_by_key(|(seq, _)| *seq);
        for (_, k) in order {
            if self.bytes <= target_bytes {
                break;
            }
            if let Some(e) = self.map.remove(&k) {
                self.bytes = self.bytes.saturating_sub(e.bytes);
                evicted.push(e.value);
            }
        }
        evicted
    }

    pub fn insert(
        &mut self,
        key: ShadowMaskKey,
        value: T,
        origin: (i32, i32),
        size: (u16, u16),
        bytes: usize,
    ) -> Vec<T> {
        let mut evicted = self.evict_for(bytes);
        if let Some(old) = self.map.remove(&key) {
            self.bytes = self.bytes.saturating_sub(old.bytes);
            evicted.push(old.value);
        }
        self.use_seq += 1;
        self.misses += 1;
        self.bytes += bytes;
        self.map.insert(
            key,
            ShadowCacheEntry {
                value,
                origin,
                size,
                bytes,
                use_seq: self.use_seq,
            },
        );
        evicted
    }

    pub fn clear(&mut self) -> Vec<T> {
        self.bytes = 0;
        self.map.drain().map(|(_, e)| e.value).collect()
    }
}

/// GPU shadow helper pipelines (`shadow.wgsl`): inner-shadow alpha inversion and reduced-mask
/// bilinear upsampling.
#[cfg(feature = "gpu-common")]
pub mod gpu {
    const SHADER: &str = include_str!(concat!(env!("OUT_DIR"), "/shadow.wgsl"));
    const UPSAMPLE_UNIFORM_BYTES: u32 = 48;
    const SLAB_SLOTS: u32 = 64;

    pub struct GpuShadow {
        invert_layout: wgpu::BindGroupLayout,
        invert_alpha: wgpu::RenderPipeline,
        upsample_layout: wgpu::BindGroupLayout,
        upsample_mask: wgpu::RenderPipeline,
        linear_sampler: wgpu::Sampler,
        uniform_align: u32,
        uniform_buf: wgpu::Buffer,
        slot: u32,
    }

    impl GpuShadow {
        pub fn new(device: &wgpu::Device) -> Self {
            let uniform_align = device.limits().min_uniform_buffer_offset_alignment.max(256);
            let invert_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("shadow invert layout"),
                entries: &[wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: false },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                }],
            });
            let upsample_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("shadow upsample layout"),
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
                            min_binding_size: wgpu::BufferSize::new(u64::from(UPSAMPLE_UNIFORM_BYTES)),
                        },
                        count: None,
                    },
                ],
            });
            let invert_pl = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("shadow invert pipeline layout"),
                bind_group_layouts: &[Some(&invert_layout)],
                immediate_size: 0,
            });
            let upsample_pl = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("shadow upsample pipeline layout"),
                bind_group_layouts: &[Some(&upsample_layout)],
                immediate_size: 0,
            });
            let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("shadow helpers"),
                source: wgpu::ShaderSource::Wgsl(SHADER.into()),
            });
            let make = |pl: &wgpu::PipelineLayout, entry: &str, label: &str| {
                device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                    label: Some(label),
                    layout: Some(pl),
                    vertex: wgpu::VertexState {
                        module: &module,
                        entry_point: Some("vs"),
                        compilation_options: Default::default(),
                        buffers: &[],
                    },
                    primitive: wgpu::PrimitiveState::default(),
                    depth_stencil: None,
                    multisample: wgpu::MultisampleState::default(),
                    fragment: Some(wgpu::FragmentState {
                        module: &module,
                        entry_point: Some(entry),
                        compilation_options: Default::default(),
                        targets: &[Some(wgpu::ColorTargetState {
                            format: wgpu::TextureFormat::Rgba8Unorm,
                            blend: None,
                            write_mask: wgpu::ColorWrites::ALL,
                        })],
                    }),
                    multiview_mask: None,
                    cache: None,
                })
            };
            let invert_alpha = make(&invert_pl, "fs_invert_alpha", "shadow invert alpha");
            let upsample_mask = make(&upsample_pl, "fs_upsample_mask", "shadow upsample mask");
            let linear_sampler = device.create_sampler(&wgpu::SamplerDescriptor {
                label: Some("shadow upsample linear"),
                address_mode_u: wgpu::AddressMode::ClampToEdge,
                address_mode_v: wgpu::AddressMode::ClampToEdge,
                mag_filter: wgpu::FilterMode::Linear,
                min_filter: wgpu::FilterMode::Linear,
                ..Default::default()
            });
            let uniform_buf = device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("shadow upsample uniforms"),
                size: u64::from(uniform_align) * u64::from(SLAB_SLOTS),
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            });
            Self {
                invert_layout,
                invert_alpha,
                upsample_layout,
                upsample_mask,
                linear_sampler,
                uniform_align,
                uniform_buf,
                slot: 0,
            }
        }

        pub fn begin_frame(&mut self) {
            self.slot = 0;
        }

        pub fn encode_invert_alpha(
            &self,
            device: &wgpu::Device,
            encoder: &mut wgpu::CommandEncoder,
            src_view: &wgpu::TextureView,
            dst_view: &wgpu::TextureView,
            width: u32,
            height: u32,
        ) {
            if width == 0 || height == 0 {
                return;
            }
            let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: None,
                layout: &self.invert_layout,
                entries: &[wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(src_view),
                }],
            });
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("shadow invert alpha"),
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
            pass.set_scissor_rect(0, 0, width, height);
            pass.set_pipeline(&self.invert_alpha);
            pass.set_bind_group(0, &group, &[]);
            pass.draw(0..3, 0..1);
        }

        #[allow(clippy::too_many_arguments)]
        pub fn encode_upsample_mask(
            &mut self,
            device: &wgpu::Device,
            queue: &wgpu::Queue,
            encoder: &mut wgpu::CommandEncoder,
            src_view: &wgpu::TextureView,
            src_tex_size: (u32, u32),
            src_active_size: (u32, u32),
            red_origin: (i32, i32),
            dst_view: &wgpu::TextureView,
            dst_size: (u32, u32),
            dst_origin_in_mask: (i32, i32),
            shift: usize,
            invert: bool,
        ) {
            let (dw, dh) = dst_size;
            if dw == 0 || dh == 0 {
                return;
            }
            let offset = (self.slot % SLAB_SLOTS) * self.uniform_align;
            self.slot = self.slot.wrapping_add(1);
            let inv_s = 1.0f32 / f32::from(1u16 << shift);
            let vals: [f32; 12] = [
                dst_origin_in_mask.0 as f32,
                dst_origin_in_mask.1 as f32,
                inv_s,
                if invert { 1.0 } else { 0.0 },
                red_origin.0 as f32,
                red_origin.1 as f32,
                1.0 / src_tex_size.0.max(1) as f32,
                1.0 / src_tex_size.1.max(1) as f32,
                (src_active_size.0.max(1) as f32 - 0.5).max(0.5),
                (src_active_size.1.max(1) as f32 - 0.5).max(0.5),
                0.0,
                0.0,
            ];
            let mut bytes = [0u8; 48];
            for (i, v) in vals.iter().enumerate() {
                bytes[i * 4..(i + 1) * 4].copy_from_slice(&v.to_le_bytes());
            }
            queue.write_buffer(&self.uniform_buf, u64::from(offset), &bytes);
            let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: None,
                layout: &self.upsample_layout,
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
                            buffer: &self.uniform_buf,
                            offset: 0,
                            size: wgpu::BufferSize::new(u64::from(UPSAMPLE_UNIFORM_BYTES)),
                        }),
                    },
                ],
            });
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("shadow upsample mask"),
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
            pass.set_scissor_rect(0, 0, dw, dh);
            pass.set_pipeline(&self.upsample_mask);
            pass.set_bind_group(0, &group, &[offset]);
            pass.draw(0..3, 0..1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::blur::{BlurSpec, EdgeMode, blur_cpu, blur_reference, kernel_radius};
    use crate::exec::IRect;
    use crate::geometry;
    use vello_common::color::{AlphaColor, Srgb};
    use vello_common::kurbo::{Affine, Rect, Shape};
    use vello_common::peniko::Fill;
    use vello_cpu::{Pixmap, RasterizerSettings, RenderContext, RenderMode, Resources};

    fn score_0040(a: &[u8], b: &[u8], w: usize, h: usize) -> (f64, u8, u8, f64, usize) {
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

    #[test]
    fn analytic_blurred_rounded_rect_domain_matches_reference_within_0040_tolerance() {
        let mut resources = Resources::new();
        let settings = RasterizerSettings {
            render_mode: RenderMode::OptimizeQuality,
            ..Default::default()
        };
        let cases: &[(&str, f32, f32, f32, f32, u8, bool)] = &[
            ("drop_card_soft", 240.0, 160.0, 24.0, 12.0, 64, false),
            ("drop_card_large", 240.0, 160.0, 24.0, 32.0, 46, false),
            ("drop_card_sharp", 240.0, 160.0, 0.0, 12.0, 64, false),
            ("drop_button_sm", 120.0, 48.0, 8.0, 4.0, 38, false),
            ("drop_button_md", 120.0, 48.0, 12.0, 8.0, 64, false),
            ("drop_square_maxr", 64.0, 64.0, 16.0, 12.0, 70, false),
            ("drop_min_sigma", 160.0, 80.0, 16.0, 2.0, 64, false),
            ("inner_card_soft", 240.0, 160.0, 24.0, 6.0, 64, true),
            ("inner_card_sharp", 240.0, 160.0, 0.0, 12.0, 70, true),
            ("inner_button_soft", 120.0, 48.0, 12.0, 8.0, 70, true),
            ("inner_large_sigma", 240.0, 160.0, 40.0, 32.0, 64, true),
        ];

        for &(name, w, h, radius, sigma, a8, invert) in cases {
            let alpha = f32::from(a8) / 255.0;
            assert!(
                can_use_analytic_shadow(w, h, radius, sigma, alpha, invert),
                "{name} should be inside analytic domain"
            );
            let pad = kernel_radius(sigma) + 4;
            let cw = (w as i32 + 2 * pad) as u16;
            let ch = (h as i32 + 2 * pad) as u16;
            let ox = f64::from(pad);
            let oy = f64::from(pad);
            let rect = Rect::new(ox, oy, ox + f64::from(w), oy + f64::from(h));
            let shape = geometry::rounded_rect(w, h, [radius; 4], 0.0);
            let mut placed_shape = shape.clone();
            placed_shape.apply_affine(Affine::translate((ox, oy)));

            let mut analytic_scene = RenderContext::new(cw, ch);
            analytic_scene.set_transform(Affine::IDENTITY);
            analytic_scene.set_paint(AlphaColor::<Srgb>::new([0.0, 0.0, 0.0, alpha]));
            analytic_scene.set_fill_rule(Fill::NonZero);
            let clip_path = if invert {
                placed_shape
            } else {
                rect.inflate(f64::from(pad), f64::from(pad)).to_path(0.1)
            };
            analytic_scene.fill_blurred_rounded_rect_in(
                &clip_path,
                &rect,
                radius,
                sigma * std::f32::consts::SQRT_2,
                invert,
            );
            analytic_scene.flush();
            let mut analytic_pm = Pixmap::new(cw, ch);
            analytic_scene.render_with(&mut analytic_pm, &mut resources, settings);

            let mut mask_scene = RenderContext::new(cw, ch);
            mask_scene.set_transform(Affine::translate((ox, oy)));
            mask_scene.set_paint(AlphaColor::<Srgb>::new([1.0, 1.0, 1.0, 1.0]));
            mask_scene.set_fill_rule(Fill::NonZero);
            mask_scene.fill_path(&shape);
            mask_scene.flush();
            let mut mask_pm = Pixmap::new(cw, ch);
            mask_scene.render_with(&mut mask_pm, &mut resources, settings);

            let full = IRect {
                x0: 0,
                y0: 0,
                x1: i32::from(cw),
                y1: i32::from(ch),
            };
            let mut blurred = vec![0u8; mask_pm.data_as_u8_slice().len()];
            blur_reference(
                mask_pm.data_as_u8_slice(),
                (u32::from(cw), u32::from(ch)),
                &mut blurred,
                (u32::from(cw), u32::from(ch)),
                (0, 0),
                &BlurSpec {
                    sigma,
                    edge: EdgeMode::Zero,
                    clamp_bounds: full,
                    dirty: full,
                },
            );
            let mut ref_px = vec![0u8; blurred.len()];
            let mask_bytes = mask_pm.data_as_u8_slice();
            for i in (0..blurred.len()).step_by(4) {
                let mut cov = f32::from(blurred[i + 3]) / 255.0;
                if invert {
                    let clip_a = f32::from(mask_bytes[i + 3]) / 255.0;
                    cov = (1.0 - cov) * clip_a;
                }
                let a = (cov * alpha).clamp(0.0, 1.0);
                ref_px[i + 3] = (a * 255.0).round_ties_even() as u8;
            }
            let (mean, p99, max_d, worst_tile, severe) = score_0040(
                analytic_pm.data_as_u8_slice(),
                &ref_px,
                usize::from(cw),
                usize::from(ch),
            );
            assert!(
                mean <= 0.25 && p99 <= 4 && worst_tile <= 2.0 && severe == 0,
                "{name}: mean={mean:.4} p99={p99} max={max_d} tile={worst_tile:.3} severe={severe}"
            );
        }

        // Rejected outside the safe domain: pills, high-alpha drop and inner shadows, tiny sigma,
        // extreme blur, and the high-alpha inner shadow corner cases found in review.
        assert!(!can_use_analytic_shadow(200.0, 80.0, 40.0, 12.0, 0.25, false));
        assert!(!can_use_analytic_shadow(240.0, 160.0, 24.0, 12.0, 0.50, false));
        assert!(!can_use_analytic_shadow(240.0, 160.0, 24.0, 1.0, 0.25, false));
        assert!(!can_use_analytic_shadow(48.0, 48.0, 8.0, 16.0, 0.25, false));
        assert!(!can_use_analytic_shadow(48.0, 48.0, 12.0, 12.0, 140.0 / 255.0, true));
        assert!(!can_use_analytic_shadow(64.0, 64.0, 16.0, 16.0, 140.0 / 255.0, true));
    }

    #[test]
    fn review_analytic_sweep_all_accepted_cases_stay_in_tolerance() {
        let mut resources = Resources::new();
        let settings = RasterizerSettings {
            render_mode: RenderMode::OptimizeQuality,
            ..Default::default()
        };
        let mut cases = Vec::new();
        for (w, h) in [
            (8.0f32, 8.0f32),
            (12.0, 8.0),
            (58.0, 8.0),
            (13.5, 11.5),
            (32.0, 24.0),
            (48.0, 48.0),
            (64.0, 64.0),
            (97.25, 63.5),
        ] {
            for r_frac in [0.0, 0.125, 0.25] {
                for s_frac in [0.1, 0.2, 0.25] {
                    for (a8, invert) in [(71u8, false), (71u8, true), (140u8, true)] {
                        for (fx, fy, angle) in [
                            (0.0, 0.0, 0.0),
                            (0.13, 0.72, 0.0),
                            (0.5, 0.5, 0.0),
                            (0.27, 0.43, 0.32),
                            (0.63, 0.24, 0.71),
                        ] {
                            cases.push((
                                w,
                                h,
                                w.min(h) * r_frac,
                                (w.min(h) * s_frac).max(2.0),
                                a8,
                                invert,
                                fx,
                                fy,
                                angle,
                            ));
                        }
                    }
                }
            }
        }
        let mut accepted = 0usize;
        let mut exceed = 0usize;
        for (w, h, radius, sigma, a8, invert, fx, fy, angle) in cases {
            let alpha = f32::from(a8) / 255.0;
            if !can_use_analytic_shadow(w, h, radius, sigma, alpha, invert) {
                continue;
            }
            accepted += 1;
            let name = format!(
                "w={w} h={h} r={radius} sigma={sigma} alpha={a8} invert={invert} frac=({fx},{fy}) angle={angle}"
            );
            let pad = kernel_radius(sigma) + 4;
            let cw = (w as i32 + h as i32 + 2 * pad + 8) as u16;
            let ch = cw;
            let ox = f64::from(pad) + f64::from(h) + fx;
            let oy = f64::from(pad) + fy;
            let placed = Affine::translate((ox, oy)) * Affine::rotate(angle);
            let rect = Rect::new(0.0, 0.0, f64::from(w), f64::from(h));
            let shape = geometry::rounded_rect(w, h, [radius; 4], 0.0);

            let mut analytic_scene = RenderContext::new(cw, ch);
            analytic_scene.set_transform(placed);
            analytic_scene.set_paint(AlphaColor::<Srgb>::new([0.0, 0.0, 0.0, alpha]));
            analytic_scene.set_fill_rule(Fill::NonZero);
            let clip_path = if invert {
                shape.clone()
            } else {
                rect.inflate(f64::from(pad), f64::from(pad)).to_path(0.1)
            };
            analytic_scene.fill_blurred_rounded_rect_in(
                &clip_path,
                &rect,
                radius,
                sigma * std::f32::consts::SQRT_2,
                invert,
            );
            analytic_scene.flush();
            let mut analytic_pm = Pixmap::new(cw, ch);
            analytic_scene.render_with(&mut analytic_pm, &mut resources, settings);

            let mut mask_scene = RenderContext::new(cw, ch);
            mask_scene.set_transform(placed);
            mask_scene.set_paint(AlphaColor::<Srgb>::new([1.0, 1.0, 1.0, 1.0]));
            mask_scene.set_fill_rule(Fill::NonZero);
            mask_scene.fill_path(&shape);
            mask_scene.flush();
            let mut mask_pm = Pixmap::new(cw, ch);
            mask_scene.render_with(&mut mask_pm, &mut resources, settings);

            let full = IRect {
                x0: 0,
                y0: 0,
                x1: i32::from(cw),
                y1: i32::from(ch),
            };
            let mut blurred = vec![0u8; mask_pm.data_as_u8_slice().len()];
            blur_reference(
                mask_pm.data_as_u8_slice(),
                (u32::from(cw), u32::from(ch)),
                &mut blurred,
                (u32::from(cw), u32::from(ch)),
                (0, 0),
                &BlurSpec {
                    sigma,
                    edge: EdgeMode::Zero,
                    clamp_bounds: full,
                    dirty: full,
                },
            );
            let mut ref_px = vec![0u8; blurred.len()];
            let mask_bytes = mask_pm.data_as_u8_slice();
            for i in (0..blurred.len()).step_by(4) {
                let mut cov = f32::from(blurred[i + 3]) / 255.0;
                if invert {
                    let clip_a = f32::from(mask_bytes[i + 3]) / 255.0;
                    cov = (1.0 - cov) * clip_a;
                }
                let a = (cov * alpha).clamp(0.0, 1.0);
                ref_px[i + 3] = (a * 255.0).round_ties_even() as u8;
            }
            let (mean, p99, max_d, worst_tile, severe) = score_0040(
                analytic_pm.data_as_u8_slice(),
                &ref_px,
                usize::from(cw),
                usize::from(ch),
            );
            if mean > 0.25 || p99 > 4 || worst_tile > 2.0 || severe > 0 {
                exceed += 1;
                if exceed <= 15 {
                    eprintln!("FAIL {name}: mean={mean:.4} p99={p99} max={max_d} tile={worst_tile:.3} severe={severe}");
                }
            }
        }
        assert!(accepted > 100, "sweep must exercise the accepted analytic domain");
        assert_eq!(exceed, 0, "accepted analytic cases out of tolerance");
    }

    #[test]
    fn downsampled_large_sigma_shadow_matches_reference() {
        let mut resources = Resources::new();
        let settings = RasterizerSettings {
            render_mode: RenderMode::OptimizeQuality,
            ..Default::default()
        };
        let shape = geometry::rounded_rect(140.0, 90.0, [16.0; 4], 0.0);
        for &(sigma, invert) in &[(24.0f32, false), (48.0, false), (96.0, true)] {
            let shift = shadow_raster_shift(sigma);
            assert!(shift >= 1, "sigma {sigma} should use downsampled mask path");
            let pad = blur_support_pad(sigma);
            let mut placed = shape.clone();
            placed.apply_affine(Affine::translate((f64::from(pad) + 17.3, f64::from(pad) + 11.7)));
            let dirty = IRect {
                x0: 0,
                y0: 0,
                x1: 140 + 2 * pad + 32,
                y1: 90 + 2 * pad + 32,
            };
            let mask_rect = compute_mask_rect(&[placed.clone()], dirty, sigma, 8192).expect("mask_rect");
            let mask_w = (mask_rect.x1 - mask_rect.x0) as u32;
            let mask_h = (mask_rect.y1 - mask_rect.y0) as u32;

            // Full-resolution reference
            let mut full_scene = RenderContext::new(mask_w as u16, mask_h as u16);
            full_scene.set_transform(Affine::translate((-f64::from(mask_rect.x0), -f64::from(mask_rect.y0))));
            full_scene.set_paint(AlphaColor::<Srgb>::new([1.0, 1.0, 1.0, 1.0]));
            full_scene.fill_path(&placed);
            full_scene.flush();
            let mut full_pm = Pixmap::new(mask_w as u16, mask_h as u16);
            full_scene.render_with(&mut full_pm, &mut resources, settings);
            let dw = (dirty.x1 - dirty.x0) as u32;
            let dh = (dirty.y1 - dirty.y0) as u32;
            let dst_origin = (dirty.x0 - mask_rect.x0, dirty.y0 - mask_rect.y0);
            let mut ref_out = vec![0u8; (dw * dh * 4) as usize];
            blur_reference(
                full_pm.data_as_u8_slice(),
                (mask_w, mask_h),
                &mut ref_out,
                (dw, dh),
                dst_origin,
                &BlurSpec {
                    sigma,
                    edge: EdgeMode::Zero,
                    clamp_bounds: IRect {
                        x0: 0,
                        y0: 0,
                        x1: mask_w as i32,
                        y1: mask_h as i32,
                    },
                    dirty: IRect {
                        x0: dst_origin.0,
                        y0: dst_origin.1,
                        x1: dst_origin.0 + dw as i32,
                        y1: dst_origin.1 + dh as i32,
                    },
                },
            );
            for px in ref_out.as_chunks_mut::<4>().0.iter_mut() {
                let a = if invert { 255 - px[3] } else { px[3] };
                px[0] = 0;
                px[1] = 0;
                px[2] = 0;
                px[3] = a;
            }

            // Downsampled fast path
            let s = 1u32 << shift;
            let sw = (mask_w / s).max(1);
            let sh = (mask_h / s).max(1);
            let mut red_scene = RenderContext::new(sw as u16, sh as u16);
            red_scene.set_transform(
                Affine::scale(1.0 / f64::from(s))
                    * Affine::translate((-f64::from(mask_rect.x0), -f64::from(mask_rect.y0))),
            );
            red_scene.set_paint(AlphaColor::<Srgb>::new([1.0, 1.0, 1.0, 1.0]));
            red_scene.fill_path(&placed);
            red_scene.flush();
            let mut red_pm = Pixmap::new(sw as u16, sh as u16);
            red_scene.render_with(&mut red_pm, &mut resources, settings);
            let (red_origin, (bd_w, bd_h)) = reduced_dirty_rect(mask_rect, dirty, shift);
            let mut red_blurred = vec![0u8; (bd_w * bd_h * 4) as usize];
            blur_cpu(
                red_pm.data_as_u8_slice(),
                (sw, sh),
                &mut red_blurred,
                (bd_w, bd_h),
                red_origin,
                &BlurSpec {
                    sigma: scaled_shadow_sigma(sigma, shift),
                    edge: EdgeMode::Zero,
                    clamp_bounds: IRect {
                        x0: 0,
                        y0: 0,
                        x1: sw as i32,
                        y1: sh as i32,
                    },
                    dirty: IRect {
                        x0: red_origin.0,
                        y0: red_origin.1,
                        x1: red_origin.0 + bd_w as i32,
                        y1: red_origin.1 + bd_h as i32,
                    },
                },
            );
            let mut actual = vec![0u8; (dw * dh * 4) as usize];
            upsample_shadow_mask_cpu(
                &red_blurred,
                (bd_w, bd_h),
                red_origin,
                &mut actual,
                (dw, dh),
                dst_origin,
                shift,
                invert,
            );
            let (mean, p99, max_d, worst_tile, severe) = score_0040(&actual, &ref_out, dw as usize, dh as usize);
            assert!(
                mean <= 0.25 && p99 <= 4 && worst_tile <= 2.0 && severe == 0,
                "sigma={sigma} invert={invert}: mean={mean:.4} p99={p99} max={max_d} tile={worst_tile:.3} severe={severe}"
            );
        }
    }

    #[test]
    fn shadow_mask_cache_enforces_strict_budget() {
        let mut cache = ShadowMaskCache::<u32>::new(1000);
        for i in 0..20u32 {
            let key = ShadowMaskKey {
                kind: 0,
                invert: false,
                px: 0,
                py: 0,
                w: i,
                h: 10,
                radii: [0; 4],
                linear: [1.0f32.to_bits(), 0, 0, 1.0f32.to_bits()],
                sigma_q: 16,
            };
            let _ = cache.insert(key, i, (0, 0), (10, 10), 400);
            assert!(
                cache.bytes() <= cache.budget(),
                "cache bytes {} exceeded budget {}",
                cache.bytes(),
                cache.budget()
            );
        }
    }
}
