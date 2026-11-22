//! Background blur and progressive background blur helpers (decisions 0013, 0039, 0040).
//!
//! Built directly on `crate::blur` (`CpuBlurCache` / `GpuBlur`), sharing the same separable
//! Gaussian kernel and dirty-bounded blur pyramid cache with zero duplicate blur implementations.

use crate::blur::{self, BlurSpec, CpuBlurCache, EdgeMode};
use crate::error::Result;
use crate::exec::IRect;
use crate::glass::ClipWithin;
use crate::record::ProgressiveBlurOp;
use vello_common::kurbo::{Affine, BezPath, Point, Rect, Shape};

/// Maximum discrete Gaussian stops blended across one progressive blur.
/// Twelve stops with log-shifted spacing keep every adjacent ratio `<= 1.37x` up to `sigma = 40 px`.
pub const MAX_PROGRESSIVE_STOPS: usize = 12;

/// Tile side cap for progressive blur slice buffers (bounds CPU/Worker scratch to <= 3 MiB and
/// GPU slice atlas textures to <= 2048 x 1536, well within WebGL2's 4096 texture limit).
pub const PROGRESSIVE_TILE_MAX: u32 = 256;

/// Target-local bounding box of `paths` under `device`, intersected with the frame and target.
pub fn blur_dirty_rect(
    paths: &[(BezPath, bool)],
    device: Affine,
    frame_size: (i32, i32),
    shift: (i32, i32),
    target_size: (i32, i32),
) -> Option<IRect> {
    let mut bbox: Option<Rect> = None;
    for (p, _) in paths {
        if p.is_empty() {
            continue;
        }
        let b = device.transform_rect_bbox(p.bounding_box());
        bbox = Some(bbox.map_or(b, |acc| acc.union(b)));
    }
    let bbox = bbox?;
    if !bbox.is_finite() {
        return None;
    }
    let frame_box = IRect::around(bbox).clamp(frame_size.0, frame_size.1);
    if frame_box.is_empty() {
        return None;
    }
    let dirty = IRect {
        x0: (frame_box.x0 + shift.0).clamp(0, target_size.0),
        y0: (frame_box.y0 + shift.1).clamp(0, target_size.1),
        x1: (frame_box.x1 + shift.0).clamp(0, target_size.0),
        y1: (frame_box.y1 + shift.1).clamp(0, target_size.1),
    };
    (!dirty.is_empty()).then_some(dirty)
}

/// Resolves `(clamp_bounds, EdgeMode)` in target-local coordinates from an optional `ClipWithin`
/// (decision 0007: background blur stops at clipping frames and extends an opaque solid fill).
/// When a tile crops past the left or top of the real clamp region, `x0`/`y0` are anchored
/// congruent to the frame clamp origin modulo `1 << level(max_sigma)` so pyramid downsampling
/// stays bit-identical between whole frames and split tiles.
pub fn blur_bounds_and_edge(
    within: Option<ClipWithin>,
    frame_size: (i32, i32),
    shift: (i32, i32),
    target_size: (i32, i32),
    max_sigma: f32,
) -> (IRect, EdgeMode) {
    let (lvl, _) = blur::choose_level(max_sigma.clamp(0.0, blur::MAX_BLUR_SIGMA), blur::MAX_PYRAMID_LEVELS);
    let align = 1i32 << lvl;
    let anchor_min = |raw: i32, limit: i32| -> i32 {
        if raw < 0 {
            raw.rem_euclid(align).min(limit)
        } else {
            raw.min(limit)
        }
    };
    match within {
        Some(w) => {
            if let Some(c) = w.fill {
                let cb = IRect {
                    x0: anchor_min(w.x0.round() as i32 + shift.0, target_size.0),
                    y0: anchor_min(w.y0.round() as i32 + shift.1, target_size.1),
                    x1: (w.x1.round() as i32 + shift.0).clamp(0, target_size.0),
                    y1: (w.y1.round() as i32 + shift.1).clamp(0, target_size.1),
                };
                let border = [
                    f32::from(c[0]) / 255.0,
                    f32::from(c[1]) / 255.0,
                    f32::from(c[2]) / 255.0,
                    f32::from(c[3]) / 255.0,
                ];
                (cb, EdgeMode::Border(border))
            } else {
                let cb = IRect {
                    x0: anchor_min(w.x0.floor().max(0.0) as i32 + shift.0, target_size.0),
                    y0: anchor_min(w.y0.floor().max(0.0) as i32 + shift.1, target_size.1),
                    x1: ((w.x1.ceil() as i32).min(frame_size.0) + shift.0).clamp(0, target_size.0),
                    y1: ((w.y1.ceil() as i32).min(frame_size.1) + shift.1).clamp(0, target_size.1),
                };
                (cb, EdgeMode::Clamp)
            }
        }
        None => {
            let cb = IRect {
                x0: anchor_min(shift.0, target_size.0),
                y0: anchor_min(shift.1, target_size.1),
                x1: (frame_size.0 + shift.0).clamp(0, target_size.0),
                y1: (frame_size.1 + shift.1).clamp(0, target_size.1),
            };
            (cb, EdgeMode::Clamp)
        }
    }
}

/// Premultiplied replace of `blurred` (`bw x bh` aligned at `dirty.x0, dirty.y0`) onto `dst`
/// (`dst_w x dst_h`) masked by `mask` (`bw x bh`), optional `clip_mask` (`dst_w x dst_h`), and `alpha`.
#[allow(clippy::too_many_arguments)]
pub fn composite_blurred_cpu(
    dst: &mut [u8],
    dst_w: i32,
    blurred: &[u8],
    mask: &[u8],
    clip_mask: Option<&[u8]>,
    dirty: IRect,
    alpha: f32,
) {
    let bw = (dirty.x1 - dirty.x0) as usize;
    let bh = (dirty.y1 - dirty.y0) as usize;
    let alpha = alpha.clamp(0.0, 1.0);
    if alpha <= 0.0 || bw == 0 || bh == 0 {
        return;
    }
    for ly in 0..bh {
        let dy = dirty.y0 + ly as i32;
        let dst_row = (dy * dst_w) as usize * 4;
        let loc_row = ly * bw * 4;
        for lx in 0..bw {
            let li = loc_row + lx * 4;
            let m = f32::from(mask[li + 3]) / 255.0;
            if m <= 0.0 {
                continue;
            }
            let dx = dirty.x0 + lx as i32;
            let di = dst_row + (dx as usize) * 4;
            let clip_cov = clip_mask.map_or(1.0f32, |cm| f32::from(cm[di + 3]) / 255.0);
            let a_eff = (m * clip_cov * alpha).clamp(0.0, 1.0);
            if a_eff <= 0.0 {
                continue;
            }
            if a_eff >= 1.0 - 1e-6 {
                dst[di..di + 4].copy_from_slice(&blurred[li..li + 4]);
            } else if dst[di..di + 4] != blurred[li..li + 4] {
                let inv = 1.0 - a_eff;
                for c in 0..4 {
                    let d = f32::from(dst[di + c]);
                    let s = f32::from(blurred[li + c]);
                    dst[di + c] = (d * inv + s * a_eff).clamp(0.0, 255.0).round_ties_even() as u8;
                }
            }
        }
    }
}

/// Linear gradient geometry and monotonic sigma stop ladder for a progressive background blur.
#[derive(Clone, Debug)]
pub struct ProgressivePlan {
    /// Start point in frame pixel coordinates (invariant across split tiles).
    pub start: [f32; 2],
    /// `(end - start) / |end - start|^2` in frame pixel coordinates.
    pub dir_inv_len2: [f32; 2],
    pub start_sigma: f32,
    pub end_sigma: f32,
    /// Monotonic sigma stops (`2..=MAX_PROGRESSIVE_STOPS`), spanning `[min(s0, s1), max(s0, s1)]`.
    pub stops: Vec<f32>,
}

/// Preserve small radii on the device grid, including the sharp end of a gradient.
pub(crate) const VIEWPORT_NATIVE_SIGMA: f32 = 32.0;

/// Builds a monotonic ladder of `2..=MAX_PROGRESSIVE_STOPS` sigma stops spanning `[min_s, max_s]`.
pub fn choose_stops(min_s: f32, max_s: f32) -> Vec<f32> {
    let lo = min_s.max(0.0);
    let hi = max_s.max(lo);
    if (hi - lo) < 1e-4 {
        return vec![lo];
    }
    // Log-shifted spacing dense near sigma = 0.3..2 (where discrete Gaussian support turns on)
    // without wasting stops below sigma = 0.2 where the discrete kernel is still an identity.
    const SHIFT: f32 = 0.75;
    let u0 = (lo + SHIFT).ln();
    let u1 = (hi + SHIFT).ln();
    let intervals = ((u1 - u0) / 0.15).ceil().clamp(1.0, (MAX_PROGRESSIVE_STOPS - 1) as f32) as usize;
    let mut stops = Vec::with_capacity(intervals + 1);
    for i in 0..=intervals {
        if i == 0 {
            stops.push(lo);
        } else if i == intervals {
            stops.push(hi);
        } else {
            let f = i as f32 / intervals as f32;
            let u = u0 + (u1 - u0) * f;
            stops.push((u.exp() - SHIFT).clamp(lo, hi));
        }
    }
    stops
}

impl ProgressivePlan {
    /// Builds a plan in frame pixel coordinates. Returns `None` if the blur is degenerate
    /// (zero or uniform sigma, in which case the caller falls back to uniform `BackgroundBlur`).
    pub fn new(op: &ProgressiveBlurOp, device: Affine, size: [f32; 2], scale: f32) -> Option<Self> {
        let start_sigma = blur::sigma_from_radius(op.start_radius) * scale;
        let end_sigma = blur::sigma_from_radius(op.end_radius) * scale;
        let min_s = start_sigma.min(end_sigma);
        let max_s = start_sigma.max(end_sigma);
        if max_s < blur::MIN_SIGMA || (max_s - min_s) < 1e-4 {
            return None;
        }
        let s_pt = device * Point::new(f64::from(op.start[0] * size[0]), f64::from(op.start[1] * size[1]));
        let e_pt = device * Point::new(f64::from(op.end[0] * size[0]), f64::from(op.end[1] * size[1]));
        let sx = s_pt.x as f32;
        let sy = s_pt.y as f32;
        let ex = e_pt.x as f32;
        let ey = e_pt.y as f32;
        let dx = ex - sx;
        let dy = ey - sy;
        let len2 = dx * dx + dy * dy;
        if !(len2 > 1e-6 && len2.is_finite()) {
            return None;
        }
        let inv = 1.0 / len2;
        let stops = choose_stops(min_s, max_s);
        Some(Self {
            start: [sx, sy],
            dir_inv_len2: [dx * inv, dy * inv],
            start_sigma,
            end_sigma,
            stops,
        })
    }

    /// Evaluates local sigma at frame pixel center `(x, y)`.
    #[inline]
    pub fn sigma_at(&self, x: f32, y: f32) -> f32 {
        let t =
            ((x - self.start[0]) * self.dir_inv_len2[0] + (y - self.start[1]) * self.dir_inv_len2[1]).clamp(0.0, 1.0);
        self.start_sigma + (self.end_sigma - self.start_sigma) * t
    }

    /// Returns the half-open stop index range `(first, end)` into `self.stops` covering every stop
    /// that `bracket(sigma_at(x, y))` can sample anywhere inside `rect` (in frame coordinates).
    /// Inflates `rect` by 1 px so floating-point rounding near stop boundaries is always covered.
    pub fn active_stop_range(&self, rect: Rect) -> (usize, usize) {
        let count = self.stops.len();
        if count <= 1 || !rect.is_finite() || rect.width() <= 0.0 || rect.height() <= 0.0 {
            return (0, count);
        }
        let r = rect.inflate(1.0, 1.0);
        let corners = [
            self.sigma_at(r.x0 as f32, r.y0 as f32),
            self.sigma_at(r.x1 as f32, r.y0 as f32),
            self.sigma_at(r.x0 as f32, r.y1 as f32),
            self.sigma_at(r.x1 as f32, r.y1 as f32),
        ];
        let min_s = corners.into_iter().fold(f32::INFINITY, f32::min);
        let max_s = corners.into_iter().fold(f32::NEG_INFINITY, f32::max);
        let (lo_idx, _, _) = self.bracket(min_s);
        let (_, hi_idx, _) = self.bracket(max_s);
        (lo_idx, (hi_idx + 1).min(count))
    }

    /// Returns `(lo_idx, hi_idx, frac)` matching `fs_progressive_blur` in `readers.wgsl`.
    #[inline]
    pub fn bracket(&self, sigma: f32) -> (usize, usize, f32) {
        let count = self.stops.len();
        if count <= 1 {
            return (0, 0, 0.0);
        }
        let mut lo = count - 2;
        let mut hi = count - 1;
        for i in 0..(count - 1) {
            if sigma <= self.stops[i + 1] {
                lo = i;
                hi = i + 1;
                break;
            }
        }
        let s_lo = self.stops[lo];
        let s_hi = self.stops[hi];
        // Variance-matched mixing: blending Gaussians G(s_lo) and G(s_hi) with weight w yields
        // mixture variance (1 - w) * s_lo^2 + w * s_hi^2 = sigma^2.
        let v_lo = s_lo * s_lo;
        let v_hi = s_hi * s_hi;
        let frac = ((sigma * sigma - v_lo) / (v_hi - v_lo).max(1e-6)).clamp(0.0, 1.0);
        (lo, hi, frac)
    }

    /// Packs the stop ladder into 12 floats (`stops0..stops2` uniforms in `readers.wgsl`).
    pub fn padded_stops(&self) -> [f32; MAX_PROGRESSIVE_STOPS] {
        let mut out = [0.0f32; MAX_PROGRESSIVE_STOPS];
        let last = self.stops.last().copied().unwrap_or(0.0);
        for (i, slot) in out.iter_mut().enumerate() {
            *slot = self.stops.get(i).copied().unwrap_or(last);
        }
        out
    }
}

/// All stop images of one output tile remain live while its largest Gaussian pass runs.
pub(crate) fn cpu_work_bytes(source: (u32, u32), dirty: (u32, u32), stops: &[f32]) -> usize {
    let tile = (dirty.0.min(PROGRESSIVE_TILE_MAX), dirty.1.min(PROGRESSIVE_TILE_MAX));
    let work = stops
        .iter()
        .map(|&sigma| blur::cpu_work_bytes(source, tile, sigma))
        .max()
        .unwrap_or(0);
    (tile.0 as usize * tile.1 as usize * 4 * stops.len()).saturating_add(work)
}

/// Evaluates progressive background blur on CPU into `out` (`bw x bh` aligned at `dirty.x0, dirty.y0`),
/// processing `dirty` in bounded tiles via `CpuBlurCache` so Worker export memory stays small.
/// `frame_origin` is the target origin in frame pixel coordinates (`(0, 0)` for whole frames).
#[allow(clippy::too_many_arguments)]
pub fn eval_progressive_cpu(
    cache: &mut CpuBlurCache,
    source_id: u64,
    src: &[u8],
    src_size: (u32, u32),
    clamp_bounds: IRect,
    edge: EdgeMode,
    dirty: IRect,
    frame_origin: (i32, i32),
    plan: &ProgressivePlan,
    out: &mut [u8],
) -> Result<()> {
    let bw = (dirty.x1 - dirty.x0) as usize;
    let bh = (dirty.y1 - dirty.y0) as usize;
    if bw == 0 || bh == 0 {
        return Ok(());
    }
    let stops = &plan.stops;
    let n = stops.len();
    let max_tile = PROGRESSIVE_TILE_MAX as i32;
    let mut tile_slices: Vec<Vec<u8>> = Vec::with_capacity(n);

    let mut ty0 = dirty.y0;
    while ty0 < dirty.y1 {
        let ty1 = (ty0 + max_tile).min(dirty.y1);
        let th = (ty1 - ty0) as usize;
        let mut tx0 = dirty.x0;
        while tx0 < dirty.x1 {
            let tx1 = (tx0 + max_tile).min(dirty.x1);
            let tw = (tx1 - tx0) as usize;
            let tile = IRect {
                x0: tx0,
                y0: ty0,
                x1: tx1,
                y1: ty1,
            };
            let slice_bytes = tw * th * 4;
            if tile_slices.len() < n {
                tile_slices.resize_with(n, Vec::new);
            }
            for (k, &sigma) in stops.iter().enumerate() {
                let buf = &mut tile_slices[k];
                if buf.len() != slice_bytes {
                    buf.resize(slice_bytes, 0);
                }
                let spec = BlurSpec {
                    sigma,
                    edge,
                    clamp_bounds,
                    dirty: tile,
                };
                cache.try_blur(source_id, src, src_size, buf, (tw as u32, th as u32), (tx0, ty0), &spec)?;
            }
            for ry in 0..th {
                let y = ty0 + ry as i32;
                let py = (frame_origin.1 + y) as f32 + 0.5;
                let out_row = ((y - dirty.y0) as usize * bw + (tx0 - dirty.x0) as usize) * 4;
                let sl_row = ry * tw * 4;
                for rx in 0..tw {
                    let x = tx0 + rx as i32;
                    let px = (frame_origin.0 + x) as f32 + 0.5;
                    let sigma = plan.sigma_at(px, py);
                    let (lo, hi, frac) = plan.bracket(sigma);
                    let si = sl_row + rx * 4;
                    let oi = out_row + rx * 4;
                    let a = &tile_slices[lo][si..si + 4];
                    let b = &tile_slices[hi][si..si + 4];
                    for c in 0..4 {
                        let v = f32::from(a[c]) * (1.0 - frac) + f32::from(b[c]) * frac;
                        out[oi + c] = v.clamp(0.0, 255.0).round_ties_even() as u8;
                    }
                }
            }
            tx0 = tx1;
        }
        ty0 = ty1;
    }
    Ok(())
}

/// Exact per-pixel 2D Gaussian progressive blur semantic oracle (for unit tests verifying the
/// discrete stop ladder against the continuous per-pixel definition).
#[cfg(test)]
pub fn progressive_blur_reference(
    src: &[u8],
    src_size: (u32, u32),
    clamp_bounds: IRect,
    edge: EdgeMode,
    dirty: IRect,
    plan: &ProgressivePlan,
) -> Vec<u8> {
    let bw = (dirty.x1 - dirty.x0) as usize;
    let bh = (dirty.y1 - dirty.y0) as usize;
    let src_w = src_size.0 as i32;
    let src_h = src_size.1 as i32;
    let cb = clamp_bounds.clamp(src_w, src_h);
    let border = match edge {
        EdgeMode::Border(c) => c.map(|v| v.clamp(0.0, 1.0)),
        EdgeMode::Zero | EdgeMode::Clamp => [0.0; 4],
    };
    let sample = |x: i32, y: i32| -> [f32; 4] {
        if cb.is_empty() {
            return border;
        }
        let (sx, sy) = match edge {
            EdgeMode::Clamp => (x.clamp(cb.x0, cb.x1 - 1), y.clamp(cb.y0, cb.y1 - 1)),
            EdgeMode::Zero | EdgeMode::Border(_) => {
                if x < cb.x0 || y < cb.y0 || x >= cb.x1 || y >= cb.y1 {
                    return border;
                }
                (x, y)
            }
        };
        let i = ((sy * src_w + sx) * 4) as usize;
        [
            f32::from(src[i]) / 255.0,
            f32::from(src[i + 1]) / 255.0,
            f32::from(src[i + 2]) / 255.0,
            f32::from(src[i + 3]) / 255.0,
        ]
    };

    let mut out = vec![0u8; bw * bh * 4];
    for ry in 0..bh {
        let sy = dirty.y0 + ry as i32;
        for rx in 0..bw {
            let sx = dirty.x0 + rx as i32;
            let sigma = plan.sigma_at(sx as f32 + 0.5, sy as f32 + 0.5);
            let r = blur::kernel_radius(sigma);
            let oi = (ry * bw + rx) * 4;
            if r == 0 {
                let c = sample(sx, sy);
                for ch in 0..4 {
                    out[oi + ch] = (c[ch].clamp(0.0, 1.0) * 255.0).round_ties_even() as u8;
                }
                continue;
            }
            let w = blur::gaussian_weights(sigma);
            let mut acc = [0.0f32; 4];
            for dy in -r..=r {
                let wy = w[(dy + r) as usize];
                let mut row = [0.0f32; 4];
                for dx in -r..=r {
                    let wx = w[(dx + r) as usize];
                    let p = sample(sx + dx, sy + dy);
                    for ch in 0..4 {
                        row[ch] += p[ch] * wx;
                    }
                }
                for ch in 0..4 {
                    acc[ch] += row[ch] * wy;
                }
            }
            for ch in 0..4 {
                out[oi + ch] = (acc[ch].clamp(0.0, 1.0) * 255.0).round_ties_even() as u8;
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stripes_image(w: u32, h: u32) -> Vec<u8> {
        let mut px = vec![0u8; (w * h * 4) as usize];
        for y in 0..h {
            for x in 0..w {
                let band = ((x / 10 + y / 10) % 2) == 0;
                let c = if band { [235, 80, 45, 255] } else { [30, 65, 160, 255] };
                let i = ((y * w + x) * 4) as usize;
                px[i..i + 4].copy_from_slice(&c);
            }
        }
        px
    }

    #[test]
    fn progressive_ladder_matches_exact_per_pixel_oracle() {
        let (w, h) = (96u32, 96u32);
        let src = stripes_image(w, h);
        let cb = IRect {
            x0: 0,
            y0: 0,
            x1: w as i32,
            y1: h as i32,
        };
        let dirty = IRect {
            x0: 8,
            y0: 8,
            x1: 88,
            y1: 88,
        };
        let cases = [
            ("vertical-0-10", 0.0, 10.0, [0.5, 0.0], [0.5, 1.0]),
            ("diagonal-0-24", 0.0, 24.0, [0.0, 0.0], [1.0, 1.0]),
            ("horizontal-4-20", 4.0, 20.0, [0.0, 0.5], [1.0, 0.5]),
        ];
        for (name, sr, er, start, end) in cases {
            let op = ProgressiveBlurOp {
                paths: vec![0],
                even_odd: false,
                start_radius: sr,
                end_radius: er,
                start,
                end,
            };
            let plan = ProgressivePlan::new(&op, Affine::IDENTITY, [w as f32, h as f32], 1.0).expect("plan");
            let oracle = progressive_blur_reference(&src, (w, h), cb, EdgeMode::Clamp, dirty, &plan);
            let bw = (dirty.x1 - dirty.x0) as usize;
            let bh = (dirty.y1 - dirty.y0) as usize;
            let mut approx = vec![0u8; bw * bh * 4];
            let mut cache = CpuBlurCache::new(4 << 20);
            eval_progressive_cpu(
                &mut cache,
                1,
                &src,
                (w, h),
                cb,
                EdgeMode::Clamp,
                dirty,
                (0, 0),
                &plan,
                &mut approx,
            )
            .expect("eval_progressive_cpu");
            let mut sum = 0u64;
            let mut hist = [0usize; 256];
            for (&a, &b) in oracle.iter().zip(&approx) {
                let d = a.abs_diff(b);
                sum += u64::from(d);
                hist[d as usize] += 1;
            }
            let total = oracle.len();
            let mean = sum as f64 / total as f64;
            let mut acc = 0usize;
            let mut p99 = 0usize;
            for (d, &c) in hist.iter().enumerate() {
                acc += c;
                if acc * 100 >= total * 99 {
                    p99 = d;
                    break;
                }
            }
            assert!(
                mean <= 0.35 && p99 <= 4,
                "{name}: progressive ladder drifted from per-pixel oracle: mean={mean:.4}, p99={p99}"
            );
        }
    }
}
