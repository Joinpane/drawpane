//! The glass effect (decision 0007 and 0039): shared parameters, tuning, exact box distance,
//! inscribed-radius transform, and the CPU semantic reference that GPU shaders are held to.
//!
//! Coordinates throughout are y-down device pixels (matching Vello and WebGPU).
//! `DEFAULT_GLASS_TUNING` and `glass_params` match `packages/editor/src/glass.ts` number for number.

use crate::error::{EngineError, Result};
use crate::exec::IRect;
use crate::record::GlassOp;
use vello_common::kurbo::{Affine, Rect};

/// Preferred interior chunk side (in device pixels) when a glass layer exceeds single-pass bounds.
pub const DEFAULT_CHUNK_SIDE: u32 = 1024;
/// Exact CPU and GPU draws use identical region sizes so their mip texels have the same phase.
pub const EXACT_SPLIT_SIDE: u32 = 1024;
pub const EXACT_SPLIT_PIXELS: u64 = 1_048_576;
/// Sized for the Worker's memory cap.
pub const EXACT_CHUNK_SIDE: u32 = 512;
/// Hard per-chunk region side cap on CPU (`u16::MAX` / 16k).
pub const HARD_MAX_REGION_SIDE: u32 = 16_384;
/// Hard per-chunk pixel cap (24M px).
pub const HARD_MAX_REGION_PIXELS: u64 = 24_000_000;

/// Constants fitted to Figma's glass (`tools/glass-calibration` and `glass-probe-2`).
/// Single source of truth in Rust, serialized directly into GPU uniforms.
#[derive(Clone, Copy, Debug)]
pub struct GlassTuning {
    pub bend: f32,
    pub falloff: f32,
    pub falloff_per_depth: f32,
    pub slope_bend: f32,
    pub ellipse_loss: f32,
    pub ellipse_depth: f32,
    pub profile: f32,
    pub rim_sigma: f32,
    pub dispersion: f32,
    pub splay: f32,
    pub frost: f32,
    pub hairline: f32,
    pub front: f32,
    pub front_start: f32,
    pub back: f32,
    pub back_start: f32,
    pub shade: f32,
    pub shade_reach: f32,
}

pub const DEFAULT_GLASS_TUNING: GlassTuning = GlassTuning {
    bend: 1.02,
    falloff: 2.55,
    falloff_per_depth: 0.0075,
    slope_bend: 0.86,
    ellipse_loss: 12.1,
    ellipse_depth: 9.5,
    profile: 1.6,
    rim_sigma: 0.275,
    dispersion: 0.1,
    splay: 0.58,
    frost: crate::blur::FIGMA_BLUR_SIGMA,
    hairline: 0.35,
    front: 3.7,
    front_start: 0.45,
    back: 2.4,
    back_start: 0.42,
    shade: 0.09,
    shade_reach: 0.55,
};

/// Shape bending profile (matches `GlassKind` in `glass.ts`).
pub const KIND_BOX: u8 = 0;
pub const KIND_ELLIPSE: u8 = 1;
pub const KIND_OTHER: u8 = 2;

/// Glass parameters resolved into device pixels at `scale`.
#[derive(Clone, Copy, Debug)]
pub struct GlassParams {
    pub refraction: f32,
    pub depth: f32,
    pub sigma: f32,
    pub dispersion: f32,
    pub frost: f32,
    pub splay: f32,
    pub light: [f32; 2],
    pub intensity: f32,
    pub margin: i32,
    pub unit_px: f32,
    pub falloff: f32,
}

/// Resolves a `GlassOp` at device scale `scale` (device pixels per local unit) with effective
/// `inradius` (largest inscribed radius in local units).
pub fn glass_params(op: &GlassOp, scale: f32, inradius: f32) -> GlassParams {
    let tune = DEFAULT_GLASS_TUNING;
    let units = op.depth.min(100.0).min(inradius).max(0.0);
    let depth = units * scale;
    let share = match op.kind {
        KIND_BOX => tune.bend,
        KIND_ELLIPSE => (1.0 - tune.ellipse_loss / (units + tune.ellipse_depth)).max(0.0),
        _ => tune.slope_bend,
    };
    let refraction = (op.refraction / 100.0)
        * share
        * if op.kind == KIND_BOX {
            depth
        } else {
            depth.max(4.0 * scale)
        };
    let dispersion = (op.dispersion / 100.0) * tune.dispersion;
    let frost = op.frost.clamp(0.0, 100.0) * scale * tune.frost;
    let splay = (op.splay / 100.0) * tune.splay;
    let radians = op.angle.to_radians();
    let sigma = (depth.max(4.0 * scale) * tune.rim_sigma).max(0.5);
    let margin_f = refraction * (1.0 + dispersion) * (1.0 + splay) + frost * 3.0 + 2.0;
    let margin = if margin_f.is_finite() {
        margin_f.ceil().clamp(2.0, 4096.0) as i32
    } else {
        4096
    };
    GlassParams {
        refraction,
        depth,
        sigma,
        dispersion,
        frost,
        splay,
        light: [radians.sin(), -radians.cos()],
        intensity: op.intensity / 100.0,
        margin,
        unit_px: scale,
        falloff: tune.falloff + tune.falloff_per_depth * units,
    }
}

/// Conservative local-unit reach of a glass op past its box, for invalidation and band halos.
pub fn local_halo(op: &GlassOp) -> f32 {
    let inradius = if op.inradius > 0.0 { op.inradius } else { 100.0 };
    let p = glass_params(op, 1.0, inradius);
    let mip_pad = if p.refraction > 0.0 { 16.0 } else { 0.0 } + (p.frost * 0.7).ceil();
    let r = p.refraction * (1.0 + p.dispersion) * (1.0 + p.splay) + p.frost * 3.0 + mip_pad + 4.0;
    r.ceil().max(0.0)
}

/// How much the rim's blur can be downsampled: its Gaussian stays at least 3 pixels wide there.
pub fn height_scale(sigma: f32) -> u32 {
    let k = (sigma / 3.0).floor().clamp(1.0, 8.0) as u32;
    if k > 1 { k - (k % 2) } else { 1 }
}

/// Nearest clipping frames' intersection in device pixels, plus the innermost clipping frame's
/// opaque solid fill (premultiplied RGBA8) if it has one (decision 0007).
#[derive(Clone, Copy, Debug)]
pub struct ClipWithin {
    pub x0: f32,
    pub y0: f32,
    pub x1: f32,
    pub y1: f32,
    pub fill: Option<[u8; 4]>,
}

/// Device-space region and box geometry for one glass draw, in y-down frame pixels.
#[derive(Clone, Copy, Debug)]
pub struct GlassRegion {
    /// Extended backdrop & mask region in frame device pixels (may reach past `[0..frame]`).
    pub x0: i32,
    pub y0: i32,
    pub rw: u32,
    pub rh: u32,
    /// Clamped output paint region in target-local pixels (intersection of layer box + 2 px
    /// margin with the current target tile).
    pub out_x0: i32,
    pub out_y0: i32,
    pub out_x1: i32,
    pub out_y1: i32,
    /// Layer centre in y-down region pixels.
    pub center: [f32; 2],
    /// Layer half-extent on the device (for splay).
    pub half_size: [f32; 2],
    /// Exact rounded-box parameters when `op.kind == KIND_BOX` and `device` is invertible.
    pub box_geom: Option<BoxGeom>,
}

#[derive(Clone, Copy, Debug)]
pub struct BoxGeom {
    /// Maps y-down region pixel `(px, py)` to layer local `(bx, by)`.
    pub to_box: [f32; 6], // [a, b, c, d, e, f] where bx = a*px + c*py + e, by = b*px + d*py + f
    pub size: [f32; 2],
    pub radii: [f32; 4],
    pub smoothing: [f32; 4],
    pub unit_px: f32,
}

/// Computes one or more frame-anchored glass regions covering the layer's intersection with the
/// target tile. Layers fitting within `split_side`/`split_pixels` stay a single region (matching
/// whole-frame and banded tiles bit-for-bit); larger valid layers split into frame-anchored chunks
/// with full refraction + rim-blur support, aligned to `full_x0 (mod height_scale(sigma))`.
/// Returns `Err(ErrorCode::Limit)` if even a minimum chunk exceeds `hard_max_side`/`hard_max_pixels`.
#[allow(clippy::too_many_arguments)]
pub fn compute_regions(
    op: &GlassOp,
    params: &GlassParams,
    device: Affine,
    size: [f32; 2],
    frame_size: (i32, i32),
    target_origin: (i32, i32),
    target_size: (i32, i32),
    hard_max_side: u32,
    hard_max_pixels: u64,
    split_side: u32,
    split_pixels: u64,
    chunk_side: u32,
) -> Result<Vec<GlassRegion>> {
    let (w, h) = (f64::from(size[0]), f64::from(size[1]));
    let [a, b, c, d, e, f] = device.as_coeffs();
    let corners = [(0.0, 0.0), (w, 0.0), (0.0, h), (w, h)];
    let mut min_x = f64::INFINITY;
    let mut max_x = f64::NEG_INFINITY;
    let mut min_y = f64::INFINITY;
    let mut max_y = f64::NEG_INFINITY;
    for (px, py) in corners {
        let x = a * px + c * py + e;
        let y = b * px + d * py + f;
        min_x = min_x.min(x);
        max_x = max_x.max(x);
        min_y = min_y.min(y);
        max_y = max_y.max(y);
    }
    if !min_x.is_finite()
        || !max_x.is_finite()
        || !min_y.is_finite()
        || !max_y.is_finite()
        || !params.sigma.is_finite()
        || !params.refraction.is_finite()
        || !params.frost.is_finite()
    {
        return Ok(Vec::new());
    }
    let m = i64::from(params.margin);
    let rim_pad = (3.0 * f64::from(params.sigma)).ceil().clamp(0.0, 4096.0) as i64;
    let pad = m + rim_pad;
    let (fw, fh) = (i64::from(frame_size.0), i64::from(frame_size.1));
    let full_x0 = (-pad).max(min_x.floor().clamp(-1e12, 1e12) as i64 - m);
    let full_y0 = (-pad).max(min_y.floor().clamp(-1e12, 1e12) as i64 - m);
    let full_x1 = (fw + pad).min(max_x.ceil().clamp(-1e12, 1e12) as i64 + m);
    let full_y1 = (fh + pad).min(max_y.ceil().clamp(-1e12, 1e12) as i64 + m);
    let full_rw = full_x1 - full_x0;
    let full_rh = full_y1 - full_y0;
    if full_rw <= 0 || full_rh <= 0 || full_x1 <= 0 || full_y1 <= 0 || full_x0 >= fw || full_y0 >= fh {
        return Ok(Vec::new());
    }
    let k = i64::from(height_scale(params.sigma));
    // A wide, clear lens can reach mip level three at its rim. Preserve the mip
    // phase even when the lens is sliced: odd mip dimensions would stretch the
    // sampling grid to the slice's full width. The alignment also preserves the
    // low-resolution height grid when k is six.
    let align_mips =
        params.frost <= 0.4 && params.refraction > 0.0 && full_rw.max(full_rh) > i64::from(DEFAULT_CHUNK_SIDE);
    let alignment = if align_mips { if k == 6 { 24 } else { 8 } } else { k };
    let align_up = |edge: i64, origin: i64| edge + (origin - edge).rem_euclid(alignment);
    let (full_x1, full_y1) = if align_mips {
        (align_up(full_x1, full_x0), align_up(full_y1, full_y0))
    } else {
        (full_x1, full_y1)
    };
    let full_rw = full_x1 - full_x0;
    let full_rh = full_y1 - full_y0;

    // Output pixels that can have mask alpha > 0, plus 2 px for 2x2 quad derivatives.
    let paint_x0 = (min_x.floor().clamp(-1e12, 1e12) as i64 - 2).clamp(full_x0, full_x1);
    let paint_y0 = (min_y.floor().clamp(-1e12, 1e12) as i64 - 2).clamp(full_y0, full_y1);
    let paint_x1 = (max_x.ceil().clamp(-1e12, 1e12) as i64 + 2).clamp(full_x0, full_x1);
    let paint_y1 = (max_y.ceil().clamp(-1e12, 1e12) as i64 + 2).clamp(full_y0, full_y1);
    let vis_x0 = paint_x0.max(i64::from(target_origin.0));
    let vis_y0 = paint_y0.max(i64::from(target_origin.1));
    let vis_x1 = paint_x1.min(i64::from(target_origin.0 + target_size.0));
    let vis_y1 = paint_y1.min(i64::from(target_origin.1 + target_size.1));
    if vis_x1 <= vis_x0 || vis_y1 <= vis_y0 {
        return Ok(Vec::new());
    }

    let half_size = [((max_x - min_x) * 0.5) as f32, ((max_y - min_y) * 0.5) as f32];
    let det = a * d - b * c;
    let inv_box = if op.kind == KIND_BOX && w > 0.0 && h > 0.0 && det.abs() > 1e-12 {
        Some((
            d / det,
            -b / det,
            -c / det,
            a / det,
            (c * f - d * e) / det,
            (b * e - a * f) / det,
            det.abs().sqrt() as f32,
        ))
    } else {
        None
    };

    let build_region = |rx0: i64, ry0: i64, rx1: i64, ry1: i64, ox0: i64, oy0: i64, ox1: i64, oy1: i64| {
        let fx0 = rx0 as f64;
        let fy0 = ry0 as f64;
        let center = [
            ((min_x + max_x) * 0.5 - fx0) as f32,
            ((min_y + max_y) * 0.5 - fy0) as f32,
        ];
        let box_geom = inv_box.map(|(ia, ib, ic, id, ie, jf, unit_px)| BoxGeom {
            to_box: [
                ia as f32,
                ib as f32,
                ic as f32,
                id as f32,
                (ia * fx0 + ic * fy0 + ie) as f32,
                (ib * fx0 + id * fy0 + jf) as f32,
            ],
            size,
            radii: op.box_radii,
            smoothing: op.box_smoothing,
            unit_px,
        });
        GlassRegion {
            x0: rx0 as i32,
            y0: ry0 as i32,
            rw: (rx1 - rx0) as u32,
            rh: (ry1 - ry0) as u32,
            out_x0: (ox0 - i64::from(target_origin.0)) as i32,
            out_y0: (oy0 - i64::from(target_origin.1)) as i32,
            out_x1: (ox1 - i64::from(target_origin.0)) as i32,
            out_y1: (oy1 - i64::from(target_origin.1)) as i32,
            center,
            half_size,
            box_geom,
        }
    };

    let max_single_side = i64::from(hard_max_side.min(split_side));
    let max_single_pixels = hard_max_pixels.min(split_pixels);
    if full_rw <= max_single_side
        && full_rh <= max_single_side
        && (full_rw as u64).saturating_mul(full_rh as u64) <= max_single_pixels
    {
        return Ok(vec![build_region(
            full_x0, full_y0, full_x1, full_y1, vis_x0, vis_y0, vis_x1, vis_y1,
        )]);
    }

    // Frame-anchored chunking for large glass layers.
    let support = m + rim_pad + k * 2 + 16;
    let grid_pad = if align_mips { alignment * 2 } else { k };
    let avail_side = i64::from(hard_max_side) - 2 * support - grid_pad;
    let step = if avail_side >= 64 {
        i64::from(chunk_side.max(64)).min(avail_side)
    } else {
        64
    };

    // Only iterate over chunk indices overlapping `[vis_x0..vis_x1) x [vis_y0..vis_y1)`.
    let ix0 = (vis_x0 - paint_x0).div_euclid(step);
    let ix1 = (vis_x1 - 1 - paint_x0).div_euclid(step);
    let iy0 = (vis_y0 - paint_y0).div_euclid(step);
    let iy1 = (vis_y1 - 1 - paint_y0).div_euclid(step);

    let mut out = Vec::new();
    for iy in iy0..=iy1 {
        let ty0 = paint_y0 + iy * step;
        let ty1 = (ty0 + step).min(paint_y1);
        let oy0 = ty0.max(vis_y0);
        let oy1 = ty1.min(vis_y1);
        if oy1 <= oy0 {
            continue;
        }
        let cy0_raw = (ty0 - support).max(full_y0);
        let cy0 = (cy0_raw - (cy0_raw - full_y0).rem_euclid(alignment)).max(full_y0);
        let cy1 = (ty1 + support).min(full_y1);
        let cy1 = if align_mips { align_up(cy1, full_y0) } else { cy1 };
        let ch = cy1 - cy0;
        for ix in ix0..=ix1 {
            let tx0 = paint_x0 + ix * step;
            let tx1 = (tx0 + step).min(paint_x1);
            let ox0 = tx0.max(vis_x0);
            let ox1 = tx1.min(vis_x1);
            if ox1 <= ox0 {
                continue;
            }
            let cx0_raw = (tx0 - support).max(full_x0);
            let cx0 = (cx0_raw - (cx0_raw - full_x0).rem_euclid(alignment)).max(full_x0);
            let cx1 = (tx1 + support).min(full_x1);
            let cx1 = if align_mips { align_up(cx1, full_x0) } else { cx1 };
            let cw = cx1 - cx0;
            if cw <= 0
                || ch <= 0
                || cw > i64::from(hard_max_side)
                || ch > i64::from(hard_max_side)
                || (cw as u64).saturating_mul(ch as u64) > hard_max_pixels
            {
                return Err(EngineError::limit(format!(
                    "a glass effect chunk ({cw} x {ch} px) exceeds the backend limit ({hard_max_side} px side, {hard_max_pixels} px area)"
                )));
            }
            out.push(build_region(cx0, cy0, cx1, cy1, ox0, oy0, ox1, oy1));
        }
    }
    Ok(out)
}

/// Computes a single extended region for a glass layer (used by unit tests).
#[allow(clippy::too_many_arguments)]
pub fn compute_region(
    op: &GlassOp,
    params: &GlassParams,
    device: Affine,
    size: [f32; 2],
    frame_size: (i32, i32),
    target_origin: (i32, i32),
    target_size: (i32, i32),
) -> Option<GlassRegion> {
    let mut regions = compute_regions(
        op,
        params,
        device,
        size,
        frame_size,
        target_origin,
        target_size,
        HARD_MAX_REGION_SIDE,
        HARD_MAX_REGION_PIXELS,
        HARD_MAX_REGION_SIDE,
        HARD_MAX_REGION_PIXELS,
        DEFAULT_CHUNK_SIDE,
    )
    .ok()?;
    (regions.len() == 1).then(|| regions.pop()).flatten()
}

/// True when every output pixel in `region` lies strictly inside the flat, unlit, unrefracted
/// interior of a `KIND_BOX` glass layer with no frost blur (`frost <= 0.4`). Because a rounded
/// box (even with Figma corner smoothing) is convex, its signed inward distance is concave and
/// attains its minimum over the output rectangle at one of the four corners.
pub fn is_plain_box_interior(params: &GlassParams, region: &GlassRegion, target_origin: (i32, i32)) -> bool {
    if params.frost > 0.4 {
        return false;
    }
    let Some(ref bg) = region.box_geom else {
        return false;
    };
    let hairline_px = (DEFAULT_GLASS_TUNING.hairline * params.unit_px).max(1e-3);
    let safe_d = params
        .depth
        .max(1.0)
        .max(DEFAULT_GLASS_TUNING.shade_reach * params.depth)
        .max(hairline_px * 20.0)
        + 4.0;
    let rx0 = (target_origin.0 + region.out_x0 - region.x0) as f32 + 0.5;
    let ry0 = (target_origin.1 + region.out_y0 - region.y0) as f32 + 0.5;
    let rx1 = (target_origin.0 + region.out_x1 - 1 - region.x0) as f32 + 0.5;
    let ry1 = (target_origin.1 + region.out_y1 - 1 - region.y0) as f32 + 0.5;
    [(rx0, ry0), (rx1, ry0), (rx0, ry1), (rx1, ry1)]
        .into_iter()
        .all(|(px, py)| box_distance(px, py, bg) >= safe_d)
}

/// Fast exact CPU shading for an interior `KIND_BOX` glass chunk where `is_plain_box_interior` holds:
/// refraction, rim lighting, and frost are identically zero, and shape mask coverage is 1.0.
#[allow(clippy::too_many_arguments)]
pub fn shade_glass_plain_interior_cpu(
    target: &mut [u8],
    target_w: i32,
    target_origin: (i32, i32),
    backdrop_src: &[u8],
    backdrop_w: i32,
    backdrop_h: i32,
    backdrop_origin: (i32, i32),
    frame_size: (i32, i32),
    clip_mask: Option<&[u8]>,
    region: &GlassRegion,
    within: Option<ClipWithin>,
    alpha: f32,
) {
    let (bx0, by0, bx1, by1, fill) = match within {
        Some(w) => (
            w.x0.floor().max(0.0) as i32,
            w.y0.floor().max(0.0) as i32,
            (w.x1.ceil() as i32).min(frame_size.0),
            (w.y1.ceil() as i32).min(frame_size.1),
            w.fill.map(|c| {
                (
                    w.x0.round() as i32,
                    w.y0.round() as i32,
                    w.x1.round() as i32,
                    w.y1.round() as i32,
                    c,
                )
            }),
        ),
        None => (0, 0, frame_size.0, frame_size.1, None),
    };
    let sx0 = bx0.max(backdrop_origin.0);
    let sy0 = by0.max(backdrop_origin.1);
    let sx1 = bx1.min(backdrop_origin.0 + backdrop_w);
    let sy1 = by1.min(backdrop_origin.1 + backdrop_h);
    let empty_src = sx1 <= sx0 || sy1 <= sy0;
    let alpha = alpha.clamp(0.0, 1.0);
    if alpha <= 0.0 {
        return;
    }
    for ty in region.out_y0..region.out_y1 {
        let fy = target_origin.1 + ty;
        let cy = if empty_src {
            0
        } else {
            fy.clamp(sy0, sy1 - 1) - backdrop_origin.1
        };
        let row_src = (cy * backdrop_w) as usize;
        let row_dst = (ty * target_w) as usize;
        for tx in region.out_x0..region.out_x1 {
            let idx = (row_dst + tx as usize) * 4;
            let clip_cov = clip_mask.map_or(1.0f32, |cm| f32::from(cm[idx + 3]) / 255.0);
            let a_eff = (clip_cov * alpha).clamp(0.0, 1.0);
            if a_eff <= 0.0 {
                continue;
            }
            let fx = target_origin.0 + tx;
            let seen: [u8; 4] = if empty_src {
                fill.map_or([0, 0, 0, 0], |(_, _, _, _, fc)| fc)
            } else if let Some((fx0, fy0, fx1, fy1, fc)) = fill
                && (fx < fx0 || fx >= fx1 || fy < fy0 || fy >= fy1)
            {
                fc
            } else {
                let cx = fx.clamp(sx0, sx1 - 1) - backdrop_origin.0;
                let si = (row_src + cx as usize) * 4;
                [
                    backdrop_src[si],
                    backdrop_src[si + 1],
                    backdrop_src[si + 2],
                    backdrop_src[si + 3],
                ]
            };
            let dst = &mut target[idx..idx + 4];
            if a_eff >= 1.0 - 1e-6 {
                dst.copy_from_slice(&seen);
            } else if dst != seen {
                let inv_a = 1.0 - a_eff;
                for c in 0..4 {
                    let v = f32::from(dst[c]) * inv_a + f32::from(seen[c]) * a_eff;
                    dst[c] = (v.clamp(0.0, 255.0) + 0.5) as u8;
                }
            }
        }
    }
}

/// Computes `ClipWithin` from the open clip stack (innermost clipping frame determines `fill`,
/// and all clipping frames intersect their axis-aligned device boxes).
pub fn clip_within_from_open(open: &[crate::exec::Open]) -> Option<ClipWithin> {
    let mut out: Option<ClipWithin> = None;
    for o in open.iter().rev() {
        if let crate::exec::Open::Clip {
            frame_clip: Some(fc), ..
        } = o
        {
            let b = fc.device_box;
            out = Some(match out {
                Some(prev) => ClipWithin {
                    x0: prev.x0.max(b.x0 as f32),
                    y0: prev.y0.max(b.y0 as f32),
                    x1: prev.x1.min(b.x1 as f32),
                    y1: prev.y1.min(b.y1 as f32),
                    fill: prev.fill,
                },
                None => ClipWithin {
                    x0: b.x0 as f32,
                    y0: b.y0 as f32,
                    x1: b.x1 as f32,
                    y1: b.y1 as f32,
                    fill: fc.fill,
                },
            });
        }
    }
    out
}

/// Inverse error function (Giles' single-precision approximation, identical to WGSL and `glass.ts`).
#[inline]
#[allow(clippy::excessive_precision)]
pub fn erfinv(x: f32) -> f32 {
    let mut w = -((1.0 - x) * (1.0 + x)).ln();
    let q = if w < 5.0 {
        w -= 2.5;
        let mut q = 2.81022636e-08f32;
        q = 3.43273939e-07 + q * w;
        q = -3.5233877e-06 + q * w;
        q = -4.39150654e-06 + q * w;
        q = 0.00021858087 + q * w;
        q = -0.00125372503 + q * w;
        q = -0.00417768164 + q * w;
        q = 0.246640727 + q * w;
        1.50140941 + q * w
    } else {
        w = w.sqrt() - 3.0;
        let mut q = -0.000200214257f32;
        q = 0.000100950558 + q * w;
        q = 0.00134934322 + q * w;
        q = -0.00367342844 + q * w;
        q = 0.00573950773 + q * w;
        q = -0.0076224613 + q * w;
        q = 0.00943887047 + q * w;
        q = 1.00167406 + q * w;
        2.83297682 + q * w
    };
    q * x
}

/// Exact distance in from a rounded/smoothed corner (identical to `cornerDistance` in `glass.ts` and WGSL).
#[inline]
pub fn corner_distance(along: f32, off: f32, r: f32, s: f32) -> f32 {
    let p = (1.0 + s) * r;
    if along >= p {
        return off;
    }
    let arc_angle = core::f32::consts::FRAC_PI_2 * (1.0 - s);
    let arc_chord = (arc_angle * 0.5).sin() * r * core::f32::consts::SQRT_2;
    let alpha = (core::f32::consts::FRAC_PI_2 - arc_angle) * 0.5;
    let c = r * (alpha * 0.5).tan() * (core::f32::consts::FRAC_PI_4 * s).cos();
    let d = c * (core::f32::consts::FRAC_PI_4 * s).tan();
    let b = (p - arc_chord - c - d) / 3.0;
    let a = 2.0 * b;
    let x3 = p - a - b - c;
    let vx = along - r;
    let vy = off - r;
    let tsx = x3 - r;
    let tsy = d - r;
    if tsx * vy - tsy * vx <= 0.0 {
        return r - (vx * vx + vy * vy).sqrt();
    }
    let mut lo = 0.0f32;
    let mut hi = 1.0f32;
    for _ in 0..12 {
        let t = 0.5 * (lo + hi);
        let u = 1.0 - t;
        let x = u * u * u * p + 3.0 * u * u * t * (p - a) + 3.0 * u * t * t * (p - a - b) + t * t * t * x3;
        if x > along {
            lo = t;
        } else {
            hi = t;
        }
    }
    let t = 0.5 * (lo + hi);
    let u = 1.0 - t;
    let dx = -3.0 * u * u * a - 6.0 * u * t * b + 3.0 * t * t * (x3 - p + a + b);
    let slope = 3.0 * d * t * t / dx.min(-1e-6);
    (off - d * t * t * t) / (1.0 + slope * slope).sqrt()
}

/// Distance in from a box's edge in device pixels (negative outside), y-down.
#[inline]
pub fn box_distance(px: f32, py: f32, bg: &BoxGeom) -> f32 {
    let m = bg.to_box;
    let qx = (m[0] * px + m[2] * py + m[4]) - bg.size[0] * 0.5;
    let qy = (m[1] * px + m[3] * py + m[5]) - bg.size[1] * 0.5;
    let r = if qx < 0.0 {
        if qy < 0.0 { bg.radii[0] } else { bg.radii[3] }
    } else if qy < 0.0 {
        bg.radii[1]
    } else {
        bg.radii[2]
    };
    let s = if qx < 0.0 {
        if qy < 0.0 { bg.smoothing[0] } else { bg.smoothing[3] }
    } else if qy < 0.0 {
        bg.smoothing[1]
    } else {
        bg.smoothing[2]
    };
    if r <= 0.0 || s <= 0.0 {
        let ex = qx.abs() - bg.size[0] * 0.5 + r;
        let ey = qy.abs() - bg.size[1] * 0.5 + r;
        let mx = ex.max(0.0);
        let my = ey.max(0.0);
        return -(ex.max(ey).min(0.0) + (mx * mx + my * my).sqrt() - r) * bg.unit_px;
    }
    let ex = bg.size[0] * 0.5 - qx.abs();
    let ey = bg.size[1] * 0.5 - qy.abs();
    corner_distance(ex.max(ey), ex.min(ey), r, s) * bg.unit_px
}

/// Exact Euclidean distance transform (Felzenszwalb & Huttenlocher) matching `inradius.ts`.
pub fn largest_inscribed_radius(inside: &[u8], width: usize, height: usize) -> f32 {
    if width == 0 || height == 0 {
        return 0.0;
    }
    const INF: f64 = 1e20;
    let mut d = vec![0.0f64; width * height];
    let nmax = width.max(height);
    let mut f = vec![0.0f64; nmax + 2];
    let mut out = vec![0.0f64; nmax + 2];
    let mut v = vec![0i32; nmax + 2];
    let mut z = vec![0.0f64; nmax + 3];

    let line = |n: usize, f: &[f64], out: &mut [f64], v: &mut [i32], z: &mut [f64]| {
        let m = n + 2;
        let at = |q: usize| -> f64 { if q == 0 || q == m - 1 { 0.0 } else { f[q - 1] } };
        let mut k = 0usize;
        v[0] = 0;
        z[0] = -INF;
        z[1] = INF;
        for q in 1..m {
            let qf = q as f64;
            let mut s;
            loop {
                let p = v[k] as usize;
                let pf = p as f64;
                s = ((at(q) + qf * qf) - (at(p) + pf * pf)) / (2.0 * qf - 2.0 * pf);
                if s <= z[k] && k > 0 {
                    k -= 1;
                } else {
                    break;
                }
            }
            k += 1;
            v[k] = q as i32;
            z[k] = s;
            z[k + 1] = INF;
        }
        k = 0;
        for q in 1..(m - 1) {
            let qf = q as f64;
            while z[k + 1] < qf {
                k += 1;
            }
            let p = v[k] as usize;
            let pf = p as f64;
            out[q - 1] = (qf - pf) * (qf - pf) + at(p);
        }
    };

    for x in 0..width {
        for y in 0..height {
            f[y] = if inside[y * width + x] != 0 { INF } else { 0.0 };
        }
        line(height, &f, &mut out, &mut v, &mut z);
        for y in 0..height {
            d[y * width + x] = out[y];
        }
    }
    let mut best = 0.0f64;
    for y in 0..height {
        f[..width].copy_from_slice(&d[y * width..(y + 1) * width]);
        line(width, &f, &mut out, &mut v, &mut z);
        for &val in &out[..width] {
            if val > best {
                best = val;
            }
        }
    }
    best.sqrt() as f32
}

/// Measures a non-box, non-ellipse shape's largest inscribed radius in local units using `vello_cpu`,
/// matching `inradius.ts`'s `measure()`.
pub fn measure_inradius(
    resources: &mut vello_cpu::Resources,
    paths: &[(vello_common::kurbo::BezPath, bool)],
    w: f32,
    h: f32,
) -> f32 {
    if !(w > 0.0 && h > 0.0) {
        return 100.0;
    }
    const MEASURE_PIXELS: f64 = 262_144.0;
    const MEASURE_SCALE: f64 = 4.0;
    let scale = MEASURE_SCALE.min((MEASURE_PIXELS / (f64::from(w) * f64::from(h))).sqrt());
    let pw = (f64::from(w) * scale).ceil().max(1.0) as u16;
    let ph = (f64::from(h) * scale).ceil().max(1.0) as u16;
    let mut ctx = vello_cpu::RenderContext::new(pw, ph);
    ctx.set_transform(Affine::scale(scale));
    ctx.set_paint(vello_common::color::palette::css::WHITE);
    for (p, even_odd) in paths {
        ctx.set_fill_rule(if *even_odd {
            vello_common::peniko::Fill::EvenOdd
        } else {
            vello_common::peniko::Fill::NonZero
        });
        ctx.fill_path(p);
    }
    ctx.flush();
    let mut pix = vello_cpu::Pixmap::new(pw, ph);
    let settings = vello_cpu::RasterizerSettings {
        render_mode: vello_cpu::RenderMode::OptimizeQuality,
        ..Default::default()
    };
    ctx.render_with(&mut pix, resources, settings);
    let data = pix.data_as_u8_slice();
    let inside: Vec<u8> = data
        .as_chunks::<4>()
        .0
        .iter()
        .map(|px| u8::from(px[3] >= 128))
        .collect();
    ((largest_inscribed_radius(&inside, usize::from(pw), usize::from(ph)) - 0.25).max(0.0) as f64 / scale) as f32
}

/// Copies `(region.x0, region.y0, rw, rh)` from `src` (whose top-left is `src_origin` in frame
/// pixels, size `src_w x src_h`), clamping to `within` (and `0..frame_size`) with edge repeat and
/// optional solid `within.fill` outside `within` (matching `webgl.ts` `copyExtended` and WGSL
/// `fs_copy_extended`).
#[allow(clippy::too_many_arguments)]
pub fn copy_extended_cpu(
    src: &[u8],
    src_w: i32,
    src_h: i32,
    src_origin: (i32, i32),
    frame_size: (i32, i32),
    region: &GlassRegion,
    within: Option<ClipWithin>,
) -> Vec<u8> {
    let rw = region.rw as i32;
    let rh = region.rh as i32;
    let mut out = vec![0u8; (rw * rh * 4) as usize];
    let (bx0, by0, bx1, by1, fill) = match within {
        Some(w) => (
            w.x0.floor().max(0.0) as i32,
            w.y0.floor().max(0.0) as i32,
            (w.x1.ceil() as i32).min(frame_size.0),
            (w.y1.ceil() as i32).min(frame_size.1),
            w.fill.map(|c| {
                (
                    w.x0.round() as i32,
                    w.y0.round() as i32,
                    w.x1.round() as i32,
                    w.y1.round() as i32,
                    c,
                )
            }),
        ),
        None => (0, 0, frame_size.0, frame_size.1, None),
    };
    let sx0 = bx0.max(src_origin.0);
    let sy0 = by0.max(src_origin.1);
    let sx1 = bx1.min(src_origin.0 + src_w);
    let sy1 = by1.min(src_origin.1 + src_h);
    if sx1 <= sx0 || sy1 <= sy0 {
        if let Some((_, _, _, _, fc)) = fill {
            for p in out.as_chunks_mut::<4>().0.iter_mut() {
                p.copy_from_slice(&fc);
            }
        }
        return out;
    }
    for ry in 0..rh {
        let fy = region.y0 + ry;
        let cy = fy.clamp(sy0, sy1 - 1) - src_origin.1;
        let row_src = (cy * src_w) as usize;
        let row_dst = (ry * rw) as usize;
        for rx in 0..rw {
            let fx = region.x0 + rx;
            let dst = (row_dst + rx as usize) * 4;
            if let Some((fx0, fy0, fx1, fy1, fc)) = fill
                && (fx < fx0 || fx >= fx1 || fy < fy0 || fy >= fy1)
            {
                out[dst..dst + 4].copy_from_slice(&fc);
                continue;
            }
            let cx = fx.clamp(sx0, sx1 - 1) - src_origin.0;
            let si = (row_src + cx as usize) * 4;
            out[dst..dst + 4].copy_from_slice(&src[si..si + 4]);
        }
    }
    out
}

/// Number of mip levels for a `w x h` texture (`1 + floor(log2(max(w, h)))`).
pub fn mip_count(w: u32, h: u32) -> u32 {
    let m = w.max(h).max(1);
    u32::BITS - m.leading_zeros()
}

/// Builds a premultiplied RGBA8 mipmap chain (matching WGSL `fs_mip_down`).
/// Uses exact 2x2 box averaging on even dimensions and centered 4-tap bilinear sampling on odd
/// dimensions so odd sizes cover `[0..1]` uniformly with zero spatial shift (matching WebGL's
/// `generateMipmap` and avoiding split-edge drift under heavy frost).
pub fn build_mipmaps_cpu(base: Vec<u8>, w: u32, h: u32) -> Vec<(u32, u32, Vec<u8>)> {
    let count = mip_count(w, h) as usize;
    let mut levels = Vec::with_capacity(count);
    levels.push((w, h, base));
    while levels.len() < count {
        let (pw, ph, ref prev) = *levels.last().unwrap();
        let nw = (pw / 2).max(1);
        let nh = (ph / 2).max(1);
        let mut next = vec![0u8; (nw * nh * 4) as usize];
        let even = (pw & 1) == 0 && (ph & 1) == 0 && pw > 1 && ph > 1;
        if even {
            for y in 0..nh {
                let y0 = y * 2;
                let y1 = y0 + 1;
                for x in 0..nw {
                    let x0 = x * 2;
                    let x1 = x0 + 1;
                    let i00 = ((y0 * pw + x0) * 4) as usize;
                    let i10 = ((y0 * pw + x1) * 4) as usize;
                    let i01 = ((y1 * pw + x0) * 4) as usize;
                    let i11 = ((y1 * pw + x1) * 4) as usize;
                    let di = ((y * nw + x) * 4) as usize;
                    for c in 0..4 {
                        let s = u32::from(prev[i00 + c])
                            + u32::from(prev[i10 + c])
                            + u32::from(prev[i01 + c])
                            + u32::from(prev[i11 + c]);
                        next[di + c] = ((s + 2) >> 2) as u8;
                    }
                }
            }
        } else {
            let inv_w = 1.0 / (nw as f32);
            let inv_h = 1.0 / (nh as f32);
            for y in 0..nh {
                let v0 = (y as f32 + 0.25) * inv_h;
                let v1 = (y as f32 + 0.75) * inv_h;
                for x in 0..nw {
                    let u0 = (x as f32 + 0.25) * inv_w;
                    let u1 = (x as f32 + 0.75) * inv_w;
                    let c00 = sample_bilinear_rgba8(prev, pw, ph, u0, v0);
                    let c10 = sample_bilinear_rgba8(prev, pw, ph, u1, v0);
                    let c01 = sample_bilinear_rgba8(prev, pw, ph, u0, v1);
                    let c11 = sample_bilinear_rgba8(prev, pw, ph, u1, v1);
                    let di = ((y * nw + x) * 4) as usize;
                    for c in 0..4 {
                        let avg = (c00[c] + c10[c] + c01[c] + c11[c]) * 0.25;
                        next[di + c] = (avg.clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
                    }
                }
            }
        }
        levels.push((nw, nh, next));
    }
    levels
}

/// Bilinear lookup in a premultiplied RGBA8 level at normalized UV `[0, 1]`, clamp-to-edge.
#[inline]
fn sample_bilinear_rgba8(data: &[u8], w: u32, h: u32, u: f32, v: f32) -> [f32; 4] {
    let wf = w as f32;
    let hf = h as f32;
    let fx = u.clamp(0.0, 1.0) * wf - 0.5;
    let fy = v.clamp(0.0, 1.0) * hf - 0.5;
    let x0f = fx.floor();
    let y0f = fy.floor();
    let tx = fx - x0f;
    let ty = fy - y0f;
    let mx = (w as i32) - 1;
    let my = (h as i32) - 1;
    let x0 = (x0f as i32).clamp(0, mx) as usize;
    let x1 = (x0f as i32 + 1).clamp(0, mx) as usize;
    let y0 = (y0f as i32).clamp(0, my) as usize;
    let y1 = (y0f as i32 + 1).clamp(0, my) as usize;
    let stride = w as usize;
    let i00 = (y0 * stride + x0) * 4;
    let i10 = (y0 * stride + x1) * 4;
    let i01 = (y1 * stride + x0) * 4;
    let i11 = (y1 * stride + x1) * 4;
    let w00 = (1.0 - tx) * (1.0 - ty);
    let w10 = tx * (1.0 - ty);
    let w01 = (1.0 - tx) * ty;
    let w11 = tx * ty;
    const INV: f32 = 1.0 / 255.0;
    let mut out = [0.0f32; 4];
    for c in 0..4 {
        out[c] = (f32::from(data[i00 + c]) * w00
            + f32::from(data[i10 + c]) * w10
            + f32::from(data[i01 + c]) * w01
            + f32::from(data[i11 + c]) * w11)
            * INV;
    }
    out
}

/// Trilinear mipmap lookup matching GPU `textureSampleGrad`.
#[inline]
fn sample_trilinear(levels: &[(u32, u32, Vec<u8>)], u: f32, v: f32, lod: f32) -> [f32; 4] {
    let max_lod = (levels.len() - 1) as f32;
    let l = lod.clamp(0.0, max_lod);
    let l0 = l.floor() as usize;
    let l1 = (l0 + 1).min(levels.len() - 1);
    let frac = l - (l0 as f32);
    let (w0, h0, ref d0) = levels[l0];
    let c0 = sample_bilinear_rgba8(d0, w0, h0, u, v);
    if frac <= 1e-6 || l0 == l1 {
        return c0;
    }
    let (w1, h1, ref d1) = levels[l1];
    let c1 = sample_bilinear_rgba8(d1, w1, h1, u, v);
    [
        c0[0] + (c1[0] - c0[0]) * frac,
        c0[1] + (c1[1] - c0[1]) * frac,
        c0[2] + (c1[2] - c0[2]) * frac,
        c0[3] + (c1[3] - c0[3]) * frac,
    ]
}

/// Frost parameters (shared by CPU and GPU).
#[derive(Clone, Copy, Debug)]
pub struct FrostParams {
    pub level: u32,
    pub fw: u32,
    pub fh: u32,
    pub left: f32,
    pub radius: i32,
}

pub fn frost_params(sigma: f32, rw: u32, rh: u32, max_level: u32) -> FrostParams {
    let level = ((sigma / 3.0).max(1.0).log2().floor() as i32).clamp(0, 6) as u32;
    let level = level.min(max_level);
    let f = (1u32 << level) as f32;
    let fw = ((rw as f32) / f).ceil().max(1.0) as u32;
    let fh = ((rh as f32) / f).ceil().max(1.0) as u32;
    let left = (sigma * sigma - (f * f) / 12.0).max(0.25).sqrt() / f;
    let radius = (left * 3.0).ceil().min(64.0) as i32;
    FrostParams {
        level,
        fw,
        fh,
        left,
        radius,
    }
}

/// Glass keeps the lens alpha and low-resolution height through shading. Its RGBA mask is
/// released before building the backdrop mip chain and the optional frost intermediate.
pub(crate) fn cpu_work_bytes(region: &GlassRegion, params: &GlassParams) -> usize {
    let size = (region.rw as usize, region.rh as usize);
    let pixels = size.0 * size.1;
    let k = height_scale(params.sigma) as usize;
    let low_pixels = size.0.div_ceil(k) * size.1.div_ceil(k);
    let mask = pixels * 4 + crate::cpu::scene_work_bytes(size) + low_pixels * 24;
    let mip_bytes = |mut width: u32, mut height: u32| {
        let mut bytes = 0;
        for _ in 0..mip_count(width, height) {
            bytes += width as usize * height as usize * 4;
            width = (width / 2).max(1);
            height = (height / 2).max(1);
        }
        bytes
    };
    let frost = if params.frost > 0.4 {
        let f = frost_params(params.frost, region.rw, region.rh, mip_count(region.rw, region.rh) - 1);
        mip_bytes(f.fw, f.fh) + f.fw as usize * f.fh as usize * 4
    } else {
        0
    };
    pixels + mask.max(low_pixels * 12 + mip_bytes(region.rw, region.rh) + frost)
}

/// CPU frost pass matching WGSL `fs_frost` (horizontal from `backdrop` mip `level`, vertical on
/// `frosted[0]`, then mipmapped).
pub fn frost_cpu(backdrop_mips: &[(u32, u32, Vec<u8>)], rw: u32, rh: u32, sigma: f32) -> Vec<(u32, u32, Vec<u8>)> {
    let fp = frost_params(sigma, rw, rh, (backdrop_mips.len() - 1) as u32);
    let (fw, fh) = (fp.fw, fp.fh);
    let mut weights = Vec::with_capacity((2 * fp.radius + 1) as usize);
    let mut total = 0.0f32;
    let inv = 0.5 / (fp.left * fp.left);
    for i in -fp.radius..=fp.radius {
        let x = i as f32;
        let w = (-x * x * inv).exp();
        weights.push(w);
        total += w;
    }
    let inv_total = 1.0 / total;
    for w in &mut weights {
        *w *= inv_total;
    }

    // Horizontal pass from backdrop mip `fp.level`.
    let (sw, sh, ref src_mip) = backdrop_mips[fp.level as usize];
    let mut tmp = vec![0u8; (fw * fh * 4) as usize];
    let inv_fw = 1.0 / (fw as f32);
    let inv_fh = 1.0 / (fh as f32);
    for y in 0..fh {
        let v = (y as f32 + 0.5) * inv_fh;
        for x in 0..fw {
            let mut acc = [0.0f32; 4];
            for (idx, &w) in weights.iter().enumerate() {
                let i = idx as i32 - fp.radius;
                let u = (x as f32 + 0.5 + i as f32) * inv_fw;
                let c = sample_bilinear_rgba8(src_mip, sw, sh, u, v);
                acc[0] += c[0] * w;
                acc[1] += c[1] * w;
                acc[2] += c[2] * w;
                acc[3] += c[3] * w;
            }
            let di = ((y * fw + x) * 4) as usize;
            for c in 0..4 {
                tmp[di + c] = (acc[c].clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
            }
        }
    }

    // Vertical pass on `tmp`.
    let mut out = vec![0u8; (fw * fh * 4) as usize];
    for y in 0..fh {
        for x in 0..fw {
            let mut acc = [0.0f32; 4];
            for (idx, &w) in weights.iter().enumerate() {
                let i = idx as i32 - fp.radius;
                let sy = (y as i32 + i).clamp(0, fh as i32 - 1) as u32;
                let si = ((sy * fw + x) * 4) as usize;
                acc[0] += f32::from(tmp[si]) * w;
                acc[1] += f32::from(tmp[si + 1]) * w;
                acc[2] += f32::from(tmp[si + 2]) * w;
                acc[3] += f32::from(tmp[si + 3]) * w;
            }
            let di = ((y * fw + x) * 4) as usize;
            for c in 0..4 {
                out[di + c] = (acc[c].clamp(0.0, 255.0) + 0.5) as u8;
            }
        }
    }
    build_mipmaps_cpu(out, fw, fh)
}

/// Downsamples mask alpha (`rw x rh` RGBA8, alpha in channel 3) by `k x k` box average
/// (clamped to `rw, rh`, matching WGSL `fs_down` bit-for-bit).
pub fn downsample_mask_cpu(mask: &[u8], rw: u32, rh: u32, k: u32) -> (u32, u32, Vec<f32>) {
    let lw = rw.div_ceil(k);
    let lh = rh.div_ceil(k);
    let mut out = vec![0.0f32; (lw * lh) as usize];
    let inv = 1.0 / ((k * k) as f32 * 255.0);
    let mx = rw - 1;
    let my = rh - 1;
    for ly in 0..lh {
        let by = ly * k;
        for lx in 0..lw {
            let bx = lx * k;
            let mut sum = 0u32;
            for j in 0..k {
                let sy = (by + j).min(my);
                let row = (sy * rw) as usize;
                for i in 0..k {
                    let sx = (bx + i).min(mx);
                    sum += u32::from(mask[(row + sx as usize) * 4 + 3]);
                }
            }
            out[(ly * lw + lx) as usize] = (sum as f32) * inv;
        }
    }
    (lw, lh, out)
}

/// Separable Gaussian + derivative-of-Gaussian on the downsampled mask (`BLUR_X` + `BLUR_Y`),
/// returning `[height, dh/dx, dh/dy]` per low-res pixel in y-down coordinates.
pub fn blur_height_cpu(down: &[f32], lw: u32, lh: u32, sigma_low: f32) -> Vec<[f32; 3]> {
    let radius = (sigma_low * 3.0).ceil().min(64.0) as i32;
    let inv2 = 1.0 / (2.0 * sigma_low * sigma_low);
    let inv_s2 = 1.0 / (sigma_low * sigma_low);
    let mut w_g = Vec::with_capacity((2 * radius + 1) as usize);
    let mut w_d = Vec::with_capacity((2 * radius + 1) as usize);
    let mut total = 0.0f32;
    for i in -radius..=radius {
        let x = i as f32;
        let w = (-x * x * inv2).exp();
        w_g.push(w);
        w_d.push(w * x * inv_s2);
        total += w;
    }
    let inv_total = 1.0 / total;
    for w in &mut w_g {
        *w *= inv_total;
    }
    for w in &mut w_d {
        *w *= inv_total;
    }

    // Pass X: [h, dx]
    let mut tmp = vec![[0.0f32; 2]; (lw * lh) as usize];
    for y in 0..lh {
        let row = (y * lw) as usize;
        for x in 0..lw {
            let mut h = 0.0f32;
            let mut dx = 0.0f32;
            let xi = x as i32;
            for (idx, (&wg, &wd)) in w_g.iter().zip(&w_d).enumerate() {
                let qx = xi + idx as i32 - radius;
                if qx >= 0 && qx < lw as i32 {
                    let m = down[row + qx as usize];
                    h += wg * m;
                    dx += wd * m;
                }
            }
            tmp[row + x as usize] = [h, dx];
        }
    }

    // Pass Y: [h, dx, dy]
    let mut out = vec![[0.0f32; 3]; (lw * lh) as usize];
    for y in 0..lh {
        let yi = y as i32;
        for x in 0..lw {
            let mut h = 0.0f32;
            let mut dx = 0.0f32;
            let mut dy = 0.0f32;
            for (idx, (&wg, &wd)) in w_g.iter().zip(&w_d).enumerate() {
                let qy = yi + idx as i32 - radius;
                if qy >= 0 && qy < lh as i32 {
                    let v = tmp[(qy as u32 * lw + x) as usize];
                    h += wg * v[0];
                    dx += wg * v[1];
                    dy += wd * v[0];
                }
            }
            out[(y * lw + x) as usize] = [h, dx, dy];
        }
    }
    out
}

/// Bilinear sample of the low-res height field `[h, dx, dy]` at normalized UV `(u, v)`.
#[inline]
fn sample_height(height: &[[f32; 3]], lw: u32, lh: u32, u: f32, v: f32) -> [f32; 3] {
    let fx = u.clamp(0.0, 1.0) * (lw as f32) - 0.5;
    let fy = v.clamp(0.0, 1.0) * (lh as f32) - 0.5;
    let x0f = fx.floor();
    let y0f = fy.floor();
    let tx = fx - x0f;
    let ty = fy - y0f;
    let mx = (lw as i32) - 1;
    let my = (lh as i32) - 1;
    let x0 = (x0f as i32).clamp(0, mx) as usize;
    let x1 = (x0f as i32 + 1).clamp(0, mx) as usize;
    let y0 = (y0f as i32).clamp(0, my) as usize;
    let y1 = (y0f as i32 + 1).clamp(0, my) as usize;
    let s = lw as usize;
    let h00 = height[y0 * s + x0];
    let h10 = height[y0 * s + x1];
    let h01 = height[y1 * s + x0];
    let h11 = height[y1 * s + x1];
    let w00 = (1.0 - tx) * (1.0 - ty);
    let w10 = tx * (1.0 - ty);
    let w01 = (1.0 - tx) * ty;
    let w11 = tx * ty;
    [
        h00[0] * w00 + h10[0] * w10 + h01[0] * w01 + h11[0] * w11,
        h00[1] * w00 + h10[1] * w10 + h01[1] * w01 + h11[1] * w11,
        h00[2] * w00 + h10[2] * w10 + h01[2] * w01 + h11[2] * w11,
    ]
}

/// Extracts the single-byte mask alpha over `[region.out_x0..out_x1) x [region.out_y0..out_y1)`
/// so the full padded RGBA mask pixmap can be dropped before allocating backdrop mipmaps.
pub fn extract_output_alpha(mask_rgba: &[u8], region: &GlassRegion, target_origin: (i32, i32)) -> Vec<u8> {
    let out_w = (region.out_x1 - region.out_x0).max(0) as usize;
    let out_h = (region.out_y1 - region.out_y0).max(0) as usize;
    let mut out = vec![0u8; out_w * out_h];
    let rw = region.rw as i32;
    let rh = region.rh as i32;
    for oy in 0..out_h {
        let ty = region.out_y0 + oy as i32;
        let ry = target_origin.1 + ty - region.y0;
        if ry < 0 || ry >= rh {
            continue;
        }
        let src_row = (ry * rw) as usize;
        let dst_row = oy * out_w;
        for ox in 0..out_w {
            let tx = region.out_x0 + ox as i32;
            let rx = target_origin.0 + tx - region.x0;
            if rx >= 0 && rx < rw {
                out[dst_row + ox] = mask_rgba[(src_row + rx as usize) * 4 + 3];
            }
        }
    }
    out
}

/// Evaluates the full glass shader on CPU over `region`'s output area, compositing onto `target`
/// (`target_w x target_h`, premultiplied RGBA8) with exact premultiplied replace semantics.
///
/// Runs in 2x2 pixel quads to compute exact `dpdx`/`dpdy` mipmap LODs matching WGSL `textureSampleGrad`.
#[allow(clippy::too_many_arguments)]
pub fn shade_glass_cpu(
    target: &mut [u8],
    target_w: i32,
    target_origin: (i32, i32),
    backdrop_src: &[u8],
    backdrop_w: i32,
    backdrop_h: i32,
    backdrop_origin: (i32, i32),
    frame_size: (i32, i32),
    mask_rgba: &[u8],
    clip_mask: Option<&[u8]>,
    params: &GlassParams,
    region: &GlassRegion,
    within: Option<ClipWithin>,
    alpha: f32,
) {
    let out_alpha = extract_output_alpha(mask_rgba, region, target_origin);
    let k = height_scale(params.sigma);
    let (lw, lh, down) = downsample_mask_cpu(mask_rgba, region.rw, region.rh, k);
    let height = blur_height_cpu(&down, lw, lh, params.sigma / (k as f32));
    shade_glass_prepared_cpu(
        target,
        target_w,
        target_origin,
        backdrop_src,
        backdrop_w,
        backdrop_h,
        backdrop_origin,
        frame_size,
        &out_alpha,
        lw,
        lh,
        k,
        &height,
        clip_mask,
        params,
        region,
        within,
        alpha,
    );
}

/// Like [`shade_glass_cpu`], taking pre-extracted output alpha and precomputed height field so
/// the caller can drop the full padded RGBA mask pixmap before backdrop mipmaps are allocated.
#[allow(clippy::too_many_arguments)]
pub fn shade_glass_prepared_cpu(
    target: &mut [u8],
    target_w: i32,
    target_origin: (i32, i32),
    backdrop_src: &[u8],
    backdrop_w: i32,
    backdrop_h: i32,
    backdrop_origin: (i32, i32),
    frame_size: (i32, i32),
    out_alpha: &[u8],
    lw: u32,
    lh: u32,
    k: u32,
    height: &[[f32; 3]],
    clip_mask: Option<&[u8]>,
    params: &GlassParams,
    region: &GlassRegion,
    within: Option<ClipWithin>,
    alpha: f32,
) {
    let tune = DEFAULT_GLASS_TUNING;
    let extended = copy_extended_cpu(
        backdrop_src,
        backdrop_w,
        backdrop_h,
        backdrop_origin,
        frame_size,
        region,
        within,
    );
    let backdrop_mips = build_mipmaps_cpu(extended, region.rw, region.rh);
    let sampled_mips = if params.frost > 0.4 {
        let frosted = frost_cpu(&backdrop_mips, region.rw, region.rh, params.frost);
        drop(backdrop_mips);
        frosted
    } else {
        backdrop_mips
    };

    let out_w = (region.out_x1 - region.out_x0).max(0) as usize;
    let kf = k as f32;
    let inv_lw = 1.0 / (lw as f32);
    let inv_lh = 1.0 / (lh as f32);
    let inv_rw = 1.0 / (region.rw as f32);
    let inv_rh = 1.0 / (region.rh as f32);
    let (tex_w, tex_h) = (sampled_mips[0].0 as f32, sampled_mips[0].1 as f32);
    let hairline_px = (tune.hairline * params.unit_px).max(1e-3);

    // Align 2x2 quad grid to frame coordinates so band tiles match whole frames bit-for-bit.
    let qx_start = ((target_origin.0 + region.out_x0) & !1) - target_origin.0;
    let qy_start = ((target_origin.1 + region.out_y0) & !1) - target_origin.1;

    struct QuadPix {
        tx: i32,
        ty: i32,
        in_out: bool,
        a: f32,
        d: f32,
        facing: f32,
        uv_r: [f32; 2],
        uv_g: [f32; 2],
        uv_b: [f32; 2],
    }

    let eval_geom = |tx: i32, ty: i32| -> QuadPix {
        let fx = target_origin.0 + tx;
        let fy = target_origin.1 + ty;
        let rx = fx - region.x0;
        let ry = fy - region.y0;
        let px = rx as f32 + 0.5;
        let py = ry as f32 + 0.5;
        let in_out = tx >= region.out_x0 && tx < region.out_x1 && ty >= region.out_y0 && ty < region.out_y1;
        let a = if in_out {
            let oy = (ty - region.out_y0) as usize;
            let ox = (tx - region.out_x0) as usize;
            f32::from(out_alpha[oy * out_w + ox]) / 255.0
        } else {
            0.0
        };
        let hs = sample_height(height, lw, lh, (px / kf) * inv_lw, (py / kf) * inv_lh);
        let grad_x = hs[1] / kf;
        let grad_y = hs[2] / kf;
        let g = (grad_x * grad_x + grad_y * grad_y).sqrt();
        let d = match region.box_geom {
            Some(ref bg) => box_distance(px, py, bg).max(0.0),
            None => (core::f32::consts::SQRT_2 * params.sigma * erfinv((2.0 * hs[0] - 1.0).clamp(-0.99999, 0.99999)))
                .max(0.0),
        };
        let slope = if region.box_geom.is_some() {
            let ratio = d / params.sigma;
            (-0.5 * ratio * ratio).exp()
        } else {
            (g * params.sigma * 2.5066283).clamp(0.0, 1.0)
        };
        let (in_x, in_y) = if g > 1e-6 { (grad_x / g, grad_y / g) } else { (0.0, 0.0) };
        let rim = slope.powf(tune.profile);
        let fall = if region.box_geom.is_some() {
            (1.0 - d / params.depth.max(1.0)).clamp(0.0, 1.0).powf(params.falloff)
        } else {
            rim
        };
        let along_x = -in_y;
        let along_y = in_x;
        let extent = along_x.abs() * region.half_size[0] + along_y.abs() * region.half_size[1];
        let off = if extent > 0.0 {
            ((px - region.center[0]) * along_x + (py - region.center[1]) * along_y) / extent
        } else {
            0.0
        };
        let bend_x = (in_x - along_x * off * params.splay) * fall * params.refraction;
        let bend_y = (in_y - along_y * off * params.splay) * fall * params.refraction;
        let uv_r = [
            (px + bend_x * (1.0 + params.dispersion)) * inv_rw,
            (py + bend_y * (1.0 + params.dispersion)) * inv_rh,
        ];
        let uv_g = [(px + bend_x) * inv_rw, (py + bend_y) * inv_rh];
        let uv_b = [
            (px + bend_x * (1.0 - params.dispersion)) * inv_rw,
            (py + bend_y * (1.0 - params.dispersion)) * inv_rh,
        ];
        let facing = (-in_x) * params.light[0] + (-in_y) * params.light[1];
        QuadPix {
            tx,
            ty,
            in_out,
            a,
            d,
            facing,
            uv_r,
            uv_g,
            uv_b,
        }
    };

    let lod_of = |dx: [f32; 2], dy: [f32; 2]| -> f32 {
        let lx = (dx[0] * tex_w).hypot(dx[1] * tex_h);
        let ly = (dy[0] * tex_w).hypot(dy[1] * tex_h);
        let rho = lx.max(ly);
        if rho > 1.0 { rho.log2() } else { 0.0 }
    };

    let mut qy = qy_start;
    while qy < region.out_y1 {
        let mut qx = qx_start;
        while qx < region.out_x1 {
            let p00 = eval_geom(qx, qy);
            let p10 = eval_geom(qx + 1, qy);
            let p01 = eval_geom(qx, qy + 1);
            let p11 = eval_geom(qx + 1, qy + 1);
            let quad = [p00, p10, p01, p11];
            if quad.iter().all(|p| !p.in_out || p.a <= 0.0) {
                qx += 2;
                continue;
            }
            // Per-row dx, per-column dy (fine derivatives, matching WebGPU dpdx/dpdy).
            let dx_r = [
                [quad[1].uv_r[0] - quad[0].uv_r[0], quad[1].uv_r[1] - quad[0].uv_r[1]],
                [quad[3].uv_r[0] - quad[2].uv_r[0], quad[3].uv_r[1] - quad[2].uv_r[1]],
            ];
            let dy_r = [
                [quad[2].uv_r[0] - quad[0].uv_r[0], quad[2].uv_r[1] - quad[0].uv_r[1]],
                [quad[3].uv_r[0] - quad[1].uv_r[0], quad[3].uv_r[1] - quad[1].uv_r[1]],
            ];
            let dx_g = [
                [quad[1].uv_g[0] - quad[0].uv_g[0], quad[1].uv_g[1] - quad[0].uv_g[1]],
                [quad[3].uv_g[0] - quad[2].uv_g[0], quad[3].uv_g[1] - quad[2].uv_g[1]],
            ];
            let dy_g = [
                [quad[2].uv_g[0] - quad[0].uv_g[0], quad[2].uv_g[1] - quad[0].uv_g[1]],
                [quad[3].uv_g[0] - quad[1].uv_g[0], quad[3].uv_g[1] - quad[1].uv_g[1]],
            ];
            let dx_b = [
                [quad[1].uv_b[0] - quad[0].uv_b[0], quad[1].uv_b[1] - quad[0].uv_b[1]],
                [quad[3].uv_b[0] - quad[2].uv_b[0], quad[3].uv_b[1] - quad[2].uv_b[1]],
            ];
            let dy_b = [
                [quad[2].uv_b[0] - quad[0].uv_b[0], quad[2].uv_b[1] - quad[0].uv_b[1]],
                [quad[3].uv_b[0] - quad[1].uv_b[0], quad[3].uv_b[1] - quad[1].uv_b[1]],
            ];

            for (qi, p) in quad.iter().enumerate() {
                if !p.in_out || p.a <= 0.0 {
                    continue;
                }
                let idx = ((p.ty * target_w + p.tx) * 4) as usize;
                let clip_cov = clip_mask.map_or(1.0f32, |cm| f32::from(cm[idx + 3]) / 255.0);
                let a_eff = (p.a * clip_cov * alpha).clamp(0.0, 1.0);
                if a_eff <= 0.0 {
                    continue;
                }
                let row = qi >> 1;
                let col = qi & 1;
                let red = sample_trilinear(&sampled_mips, p.uv_r[0], p.uv_r[1], lod_of(dx_r[row], dy_r[col]));
                let green = sample_trilinear(&sampled_mips, p.uv_g[0], p.uv_g[1], lod_of(dx_g[row], dy_g[col]));
                let blue = sample_trilinear(&sampled_mips, p.uv_b[0], p.uv_b[1], lod_of(dx_b[row], dy_b[col]));
                let seen_alpha = red[3].max(green[3].max(blue[3]));
                let mut sr = red[0];
                let mut sg = green[1];
                let mut sb = blue[2];
                let hair = (-((p.d - 0.5).max(0.0)) / hairline_px).exp();
                let edge = (tune.front * (p.facing - tune.front_start)).max(0.0)
                    + (tune.back * (-p.facing - tune.back_start)).max(0.0);
                let shading = params.intensity
                    * tune.shade
                    * p.facing
                    * (1.0 - p.d / (tune.shade_reach * params.depth).max(1.0)).max(0.0);
                if shading > 0.0 {
                    let keep = 1.0 - shading;
                    sr *= keep;
                    sg *= keep;
                    sb *= keep;
                } else if shading < 0.0 {
                    let s = -shading;
                    sr += (seen_alpha - sr) * s;
                    sg += (seen_alpha - sg) * s;
                    sb += (seen_alpha - sb) * s;
                }
                let hl = (params.intensity * edge * hair).clamp(0.0, 1.0);
                sr += (seen_alpha - sr) * hl;
                sg += (seen_alpha - sg) * hl;
                sb += (seen_alpha - sb) * hl;

                // Premultiplied replace: dst * (1 - a_eff) + seen * a_eff.
                let inv_a = 1.0 - a_eff;
                let dst = &mut target[idx..idx + 4];
                let dr = f32::from(dst[0]) / 255.0;
                let dg = f32::from(dst[1]) / 255.0;
                let db = f32::from(dst[2]) / 255.0;
                let da = f32::from(dst[3]) / 255.0;
                dst[0] = ((dr * inv_a + sr * a_eff).clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
                dst[1] = ((dg * inv_a + sg * a_eff).clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
                dst[2] = ((db * inv_a + sb * a_eff).clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
                dst[3] = ((da * inv_a + seen_alpha * a_eff).clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
            }
            qx += 2;
        }
        qy += 2;
    }
}

/// Fast coarse stand-in for interactive frames (decision 0042): samples mip-blurred backdrop
/// inside the shape mask without computing the rim height field.
#[allow(clippy::too_many_arguments)]
pub fn shade_glass_coarse_cpu(
    target: &mut [u8],
    target_w: i32,
    target_origin: (i32, i32),
    backdrop_src: &[u8],
    backdrop_w: i32,
    backdrop_h: i32,
    backdrop_origin: (i32, i32),
    frame_size: (i32, i32),
    out_alpha: &[u8],
    clip_mask: Option<&[u8]>,
    params: &GlassParams,
    region: &GlassRegion,
    within: Option<ClipWithin>,
    alpha: f32,
) {
    let extended = copy_extended_cpu(
        backdrop_src,
        backdrop_w,
        backdrop_h,
        backdrop_origin,
        frame_size,
        region,
        within,
    );
    let mips = build_mipmaps_cpu(extended, region.rw, region.rh);
    let sigma = params.frost.max(3.0 * params.unit_px);
    let lod = (sigma * 1.5).max(1.0).log2().min((mips.len() - 1) as f32);
    let inv_rw = 1.0 / (region.rw as f32);
    let inv_rh = 1.0 / (region.rh as f32);
    let out_w = (region.out_x1 - region.out_x0).max(0) as usize;
    for ty in region.out_y0..region.out_y1 {
        let fy = target_origin.1 + ty;
        let ry = fy - region.y0;
        let v = (ry as f32 + 0.5) * inv_rh;
        let oy = (ty - region.out_y0) as usize;
        for tx in region.out_x0..region.out_x1 {
            let fx = target_origin.0 + tx;
            let rx = fx - region.x0;
            if rx < 0 || rx >= region.rw as i32 || ry < 0 || ry >= region.rh as i32 {
                continue;
            }
            let a = f32::from(out_alpha[oy * out_w + (tx - region.out_x0) as usize]) / 255.0;
            if a <= 0.0 {
                continue;
            }
            let idx = ((ty * target_w + tx) * 4) as usize;
            let clip_cov = clip_mask.map_or(1.0f32, |cm| f32::from(cm[idx + 3]) / 255.0);
            let a_eff = (a * clip_cov * alpha).clamp(0.0, 1.0);
            if a_eff <= 0.0 {
                continue;
            }
            let u = (rx as f32 + 0.5) * inv_rw;
            let seen = sample_trilinear(&mips, u, v, lod);
            let inv_a = 1.0 - a_eff;
            let dst = &mut target[idx..idx + 4];
            for c in 0..4 {
                let d = f32::from(dst[c]) / 255.0;
                dst[c] = ((d * inv_a + seen[c] * a_eff).clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
            }
        }
    }
}

/// Device-space bounding box of `size` under `device`, as `IRect`.
pub fn device_box(device: Affine, size: [f32; 2]) -> IRect {
    IRect::around(device.transform_rect_bbox(Rect::new(0.0, 0.0, f64::from(size[0]), f64::from(size[1]))))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn erfinv_matches_known_values() {
        assert!(erfinv(0.0).abs() < 1e-6);
        assert!((erfinv(0.5) - 0.47693628).abs() < 1e-5);
        assert!((erfinv(-0.8427008) + 1.0).abs() < 1e-4);
    }

    #[test]
    fn height_scale_matches_ts() {
        assert_eq!(height_scale(0.5), 1);
        assert_eq!(height_scale(5.0), 1);
        assert_eq!(height_scale(6.0), 2);
        assert_eq!(height_scale(10.0), 2);
        assert_eq!(height_scale(12.0), 4);
        assert_eq!(height_scale(30.0), 8);
    }

    #[test]
    fn box_distance_square_and_rounded() {
        let bg = BoxGeom {
            to_box: [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
            size: [100.0, 60.0],
            radii: [0.0; 4],
            smoothing: [0.0; 4],
            unit_px: 1.0,
        };
        assert!((box_distance(50.0, 30.0, &bg) - 30.0).abs() < 1e-4);
        assert!((box_distance(1.0, 1.0, &bg) - 1.0).abs() < 1e-4);
        assert!((box_distance(-2.0, 30.0, &bg) + 2.0).abs() < 1e-4);

        let rounded = BoxGeom { radii: [20.0; 4], ..bg };
        // Corner (0, 0) is (20*sqrt(2) - 20) outside a radius-20 circle.
        let expected = -(20.0 * 2.0f32.sqrt() - 20.0);
        assert!((box_distance(0.0, 0.0, &rounded) - expected).abs() < 1e-3);
    }

    #[test]
    fn edt_finds_circle_radius() {
        let side = 64usize;
        let mut inside = vec![0u8; side * side];
        for y in 0..side {
            for x in 0..side {
                let dx = x as f32 - 32.0;
                let dy = y as f32 - 32.0;
                if dx * dx + dy * dy <= 20.0 * 20.0 {
                    inside[y * side + x] = 1;
                }
            }
        }
        let r = largest_inscribed_radius(&inside, side, side);
        assert!((r - 20.5).abs() < 1.0, "got {r}");
    }

    #[test]
    fn large_clear_lens_chunks_keep_the_same_mip_grid() {
        let op = GlassOp {
            paths: vec![0],
            even_odd: false,
            kind: KIND_BOX,
            inradius: 450.0,
            angle: -45.0,
            intensity: 70.0,
            refraction: 100.0,
            depth: 40.0,
            dispersion: 100.0,
            frost: 0.0,
            splay: 0.0,
            box_radii: [60.0; 4],
            box_smoothing: [0.0; 4],
            measured_inradius: std::cell::Cell::new(-1.0),
        };
        let params = glass_params(&op, 1.0, op.inradius);
        let view = Affine::translate((50.0, 40.0));
        let size = [1300.0, 900.0];
        let frame = (1400, 1000);
        let whole = compute_region(&op, &params, view, size, frame, (0, 0), frame).unwrap();
        let chunks = compute_regions(
            &op,
            &params,
            view,
            size,
            frame,
            (0, 0),
            frame,
            HARD_MAX_REGION_SIDE,
            HARD_MAX_REGION_PIXELS,
            EXACT_SPLIT_SIDE,
            EXACT_SPLIT_PIXELS,
            EXACT_CHUNK_SIDE,
        )
        .unwrap();
        assert!(chunks.len() > 1);
        assert_eq!((whole.rw % 8, whole.rh % 8), (0, 0));
        for chunk in &chunks {
            assert_eq!((chunk.rw % 8, chunk.rh % 8), (0, 0));
            assert_eq!(((chunk.x0 - whole.x0) % 8, (chunk.y0 - whole.y0) % 8), (0, 0));
        }

        let mut backdrop = Vec::new();
        for y in 0..frame.1 {
            for x in 0..frame.0 {
                let color = if y % 33 < 5 {
                    [240, 30, 20, 255]
                } else if x % 12 < 6 {
                    [30, 60, 200, 255]
                } else {
                    [220, 200, 60, 255]
                };
                backdrop.extend_from_slice(&color);
            }
        }
        let draw = |regions: &[GlassRegion]| {
            let mut output = backdrop.clone();
            for region in regions {
                let mut mask = Vec::new();
                for y in 0..region.rh as i32 {
                    for x in 0..region.rw as i32 {
                        let px = (region.x0 + x - 50) as f32 + 0.5;
                        let py = (region.y0 + y - 40) as f32 + 0.5;
                        let dx = (px - 650.0).abs() - 590.0;
                        let dy = (py - 450.0).abs() - 390.0;
                        let distance = dx.max(0.0).hypot(dy.max(0.0)) + dx.max(dy).min(0.0) - 60.0;
                        mask.extend_from_slice(&[(0.5 - distance).clamp(0.0, 1.0).mul_add(255.0, 0.5) as u8; 4]);
                    }
                }
                shade_glass_cpu(
                    &mut output,
                    frame.0,
                    (0, 0),
                    &backdrop,
                    frame.0,
                    frame.1,
                    (0, 0),
                    frame,
                    &mask,
                    None,
                    &params,
                    region,
                    None,
                    1.0,
                );
            }
            output
        };
        let single = draw(std::slice::from_ref(&whole));
        let chunked = draw(&chunks);
        assert_ne!(single, backdrop);
        let worst = single.iter().zip(&chunked).map(|(a, b)| a.abs_diff(*b)).max().unwrap();
        assert!(worst <= 1, "chunked lens differs by {worst} levels");
    }

    #[test]
    fn glass_over_transparent_stays_transparent() {
        let op = GlassOp {
            paths: vec![0],
            even_odd: false,
            kind: KIND_BOX,
            inradius: 20.0,
            angle: -45.0,
            intensity: 80.0,
            refraction: 80.0,
            depth: 20.0,
            dispersion: 50.0,
            frost: 4.0,
            splay: 0.0,
            box_radii: [10.0; 4],
            box_smoothing: [0.0; 4],
            measured_inradius: std::cell::Cell::new(-1.0),
        };
        let params = glass_params(&op, 1.0, 20.0);
        let region = compute_region(
            &op,
            &params,
            Affine::translate((10.0, 10.0)),
            [40.0, 40.0],
            (64, 64),
            (0, 0),
            (64, 64),
        )
        .unwrap();
        let mut target = vec![0u8; 64 * 64 * 4];
        let backdrop = vec![0u8; 64 * 64 * 4];
        let mask = vec![255u8; (region.rw * region.rh * 4) as usize];
        shade_glass_cpu(
            &mut target,
            64,
            (0, 0),
            &backdrop,
            64,
            64,
            (0, 0),
            (64, 64),
            &mask,
            None,
            &params,
            &region,
            None,
            1.0,
        );
        assert!(
            target.iter().all(|&b| b == 0),
            "glass over empty backdrop must stay clear"
        );
    }
}
