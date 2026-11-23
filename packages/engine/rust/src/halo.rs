//! Divisor-aware reduced-resolution reader halo planning and prefilter math (decision 0040).
//!
//! When an editor viewport cannot admit full-resolution backdrop padding (for instance at extreme
//! zoom up to 25,600% or under very wide blurs), the GPU renders one or two lower-density replay
//! tiers and captures blurred patches for the device-resolution pass.
//!
//! Every rule here is derived so that reduced-grid blurs match a full-resolution Gaussian within
//! `<= 4/255` max and `<= 2/255` p99 across stripes, small blocks, thin detail, and clip edges:
//! - **Divisor-aware cut-over:** a blur or progressive-blur stop evaluated on a tier with logical
//!   coarse divisor `d` must satisfy `sigma >= HALO_MIN_COARSE_SIGMA * d` (`3.0 * d`).
//! - **Variance compensation:** box integration on the rendered grid (`1/12`) plus bilinear
//!   upsampling back to device pixels (minimax `1/8`, average `1/6`) adds `5/24` grid-px^2 of
//!   variance; subtracting it keeps worst-case 2D block curvature error under `1.5/255` at `3.0`.
//! - **Area-correct prefilter:** each coarse tier renders `S` times finer (`d_render = d / S`,
//!   power-of-two `S >= 2`, targeting `S = 4`) so disjoint thin shapes separate onto distinct
//!   pixels (preventing Porter-Duff AA conflation) and `GpuBlur`'s 16-bit `[1, 3, 3, 1]/8`
//!   pyramid eliminates Moire stripe aliasing near period `d`.
//! - **Hierarchical mid-tier:** when `d_far > 16` and blurs/stops fall in `[32, 3 * d_far)`, a
//!   compact mid-range replay tier (`d_mid = 8..32`) covers that band so native device-grid
//!   padding stays small (`<= 200` px) even at 25,600% zoom.

use crate::blur::{self, EdgeMode};
use crate::exec::IRect;
use crate::glass::ClipWithin;
use crate::progressive_blur;

/// Minimum blur standard deviation (in logical coarse texels) permitted in a reduced halo pass.
///
/// With minimax variance compensation (`5/24`) and `[1, 3, 3, 1]/8` prefiltering from a finer
/// render grid, `sigma_c >= 3.0` bounds worst-case 2D block error to `<= 1.47/255` (`p99 <= 0.81`)
/// and resonant stripe aliasing to `< 0.1/255`.
pub const HALO_MIN_COARSE_SIGMA: f32 = 3.0;

/// Coarse divisor above which an intermediate mid-range tier is considered to keep native device
/// padding compact. At `d <= 16`, `3 * d <= 48` px keeps native reach `<= 200` px.
pub const MID_TIER_TRIGGER_DIVISOR: i32 = 16;

/// Minimum logical coarse divisor for the mid-range replay tier (`3 * 8 = 24 <= 32`, keeping the
/// native progressive cut-over at `VIEWPORT_NATIVE_SIGMA = 32` px).
pub const MID_TIER_MIN_DIVISOR: i32 = 8;

/// Hardware coarse replay target side cap (in logical coarse texels, before supersampling).
pub const HALO_REPLAY_SIDE: u32 = 1024;

/// Software-adapter coarse replay side cap.
pub const SOFTWARE_HALO_REPLAY_SIDE: u32 = HALO_REPLAY_SIDE / 2;

/// Combined box-integration (`1/12`) plus minimax bilinear-upsampling (`1/8`) variance in rendered
/// grid texels squared (`1/12 + 1/8 = 5/24`).
pub const HALO_GRID_VARIANCE: f32 = 5.0 / 24.0;

/// Minimum device-pixel sigma for a progressive blur stop to run in a tier with coarse divisor `d`.
#[inline]
pub fn progressive_cutover_sigma(divisor: i32) -> f32 {
    let base = progressive_blur::VIEWPORT_NATIVE_SIGMA;
    if divisor <= 1 {
        base
    } else {
        base.max(HALO_MIN_COARSE_SIGMA * divisor as f32)
    }
}

/// Minimum device-pixel sigma for a uniform background blur (and for a progressive blur's max
/// sigma to enter a coarse tier) at coarse divisor `d`.
#[inline]
pub fn uniform_cutover_sigma(divisor: i32) -> f32 {
    if divisor <= 1 {
        blur::VIEWPORT_HALO_MIN_SIGMA
    } else {
        blur::VIEWPORT_HALO_MIN_SIGMA.max(HALO_MIN_COARSE_SIGMA * divisor as f32)
    }
}

/// Compensates a blur's grid-space standard deviation `sigma_grid` for box rasterization and
/// bilinear upsampling when `render_divisor > 1`.
#[inline]
pub fn compensate_halo_sigma(sigma_grid: f32, render_divisor: i32) -> f32 {
    if render_divisor <= 1 || !sigma_grid.is_finite() || sigma_grid <= 0.0 {
        return sigma_grid;
    }
    let rem = (f64::from(sigma_grid) * f64::from(sigma_grid) - f64::from(HALO_GRID_VARIANCE)).max(0.0);
    rem.sqrt() as f32
}

/// Computes the power-of-two coarse divisor (`>= 2`) that fits `bounds` inside `replay_limit`.
#[inline]
pub fn replay_divisor(bounds: IRect, replay_limit: u32) -> i32 {
    let span_x = i64::from(bounds.x1) - i64::from(bounds.x0);
    let span_y = i64::from(bounds.y1) - i64::from(bounds.y0);
    let span = span_x.max(span_y).clamp(1, i64::from(u32::MAX / 2)) as u32;
    span.div_ceil(replay_limit.max(1)).max(2).next_power_of_two() as i32
}

/// Computes the rounded coarse grid geometry `(offset, frame_size)` for `bounds` at `divisor`.
/// `frame_size` rounds up to multiples of 64 so small pans reuse pooled backing planes.
pub fn replay_grid(bounds: IRect, divisor: i32) -> ((i32, i32), (i32, i32)) {
    let d = divisor.max(1);
    let offset = (-bounds.x0.div_euclid(d), -bounds.y0.div_euclid(d));
    let side = |end: i32, start: i32| ((start - (-end).div_euclid(d)) as u32).max(1).next_multiple_of(64) as i32;
    let frame_size = (side(bounds.x1, offset.0), side(bounds.y1, offset.1));
    (offset, frame_size)
}

/// Picks the power-of-two supersample factor `S` (`1 <= S <= coarse_divisor / 2`) for rendering a
/// coarse replay of size `coarse_size` finer before prefiltering / blurring.
///
/// Chooses `S` from the finest backdrop feature `min_feature_px` (in device pixels) overlapping the
/// tier's reach:
/// - When `min_feature_px >= 1.5 * coarse_divisor` (every feature spans at least 1.5 coarse texels,
///   well clear of both Nyquist stripe resonance and AA conflation), returns `S = 1`.
/// - Otherwise targets the smallest power-of-two `S` with `d_render = coarse_divisor / S <=
///   min_feature_px`, clamped to `max_s = (coarse_divisor / 2).max(1)` and the `max_side` /
///   `max_pixels` render caps.
pub fn choose_supersample(
    coarse_divisor: i32,
    coarse_size: (i32, i32),
    min_feature_px: f32,
    max_side: u32,
    max_pixels: usize,
) -> i32 {
    let d = coarse_divisor.max(1) as u32;
    // Keep `render_divisor = d / s >= 2` for any coarse tier (`d >= 2`) so the replay stays
    // strictly coarser than the 1:1 full-res frame that just failed admission.
    let max_s = (d / 2).max(1);
    if max_s <= 1 {
        return 1;
    }
    if min_feature_px.is_finite() && min_feature_px >= 1.5 * d as f32 {
        return 1;
    }
    let target = if min_feature_px.is_finite() && min_feature_px > 0.0 {
        let needed = ((1.5 * d as f32) / min_feature_px).ceil().max(2.0) as u32;
        needed.next_power_of_two()
    } else if d <= 8 {
        2
    } else {
        4
    };
    let cw = coarse_size.0.max(1) as u32;
    let ch = coarse_size.1.max(1) as u32;
    let mut s = target.min(max_s).next_power_of_two();
    if s > max_s {
        s /= 2;
    }
    while s > 1 {
        let fw = cw.saturating_mul(s);
        let fh = ch.saturating_mul(s);
        let pixels = (fw as usize).saturating_mul(fh as usize);
        if fw <= max_side && fh <= max_side && pixels <= max_pixels {
            break;
        }
        s /= 2;
    }
    s.max(1) as i32
}

/// Summary of which progressive-blur stops fall into each resolution tier.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ProgressiveTierSplit {
    /// Largest device sigma remaining on the native (`d = 1`) grid (`0.0` if none).
    pub native_max_sigma: f32,
    /// Largest device sigma falling in the mid tier (`0.0` if no stops fall in `[mid_cut, far_cut)`).
    pub mid_max_sigma: f32,
    /// True when at least one stop runs in a coarse tier (`>= mid_cut` or `>= far_cut`).
    pub uses_coarse: bool,
}

/// Partitions a slice of active progressive-blur stops (from a blur whose overall max sigma is
/// `hi`) against a cut-over threshold `native_cut` and an optional coarser threshold `far_cut`.
pub fn split_progressive_stops_slice(
    stops: &[f32],
    hi: f32,
    min_eligible: f32,
    native_cut: f32,
    far_cut: f32,
) -> ProgressiveTierSplit {
    if hi < min_eligible {
        let active_max = stops.iter().copied().fold(0.0f32, f32::max);
        return ProgressiveTierSplit {
            native_max_sigma: active_max,
            mid_max_sigma: 0.0,
            uses_coarse: false,
        };
    }
    let mut native_max = 0.0f32;
    let mut mid_max = 0.0f32;
    let mut uses_coarse = false;
    for &s in stops {
        if s < native_cut {
            native_max = native_max.max(s);
        } else {
            uses_coarse = true;
            if s < far_cut {
                mid_max = mid_max.max(s);
            }
        }
    }
    ProgressiveTierSplit {
        native_max_sigma: native_max,
        mid_max_sigma: mid_max,
        uses_coarse,
    }
}

/// Partitions a progressive blur `[lo, hi]` (device sigmas) against a cut-over threshold `native_cut`
/// and an optional coarser threshold `far_cut` (`far_cut >= native_cut`).
pub fn split_progressive_stops(
    lo: f32,
    hi: f32,
    min_eligible: f32,
    native_cut: f32,
    far_cut: f32,
) -> ProgressiveTierSplit {
    let (lo, hi) = (lo.min(hi), lo.max(hi));
    if hi < min_eligible {
        return ProgressiveTierSplit {
            native_max_sigma: hi,
            mid_max_sigma: 0.0,
            uses_coarse: false,
        };
    }
    let stops = progressive_blur::choose_stops(lo, hi);
    split_progressive_stops_slice(&stops, hi, min_eligible, native_cut, far_cut)
}

/// Reduced-pass clip bounds resolution.
///
/// In a reduced pass (`render_divisor > 1`), `ClipWithin` coordinates are scaled by `1 / render_divisor`
/// and frequently land on fractional texels:
/// - For `EdgeMode::Clamp` (`fill == None`), rounding outward with `floor`/`ceil` includes a
///   straddling texel containing outside-frame paint and repeats that contamination to infinity,
///   while rounding inward to `[ceil(x0), floor(x1))` drops real paint sitting on the clip edge.
///   Returning `subtexel_clamp = Some([wx0, wy0, wx1, wy1])` lets the GPU composite exact
///   device-aligned edge strips into `halo_border_src` before blurring with `EdgeMode::Clamp`,
///   falling back to clean interior `[ceil(x0), floor(x1))` when no strip is available.
/// - For `EdgeMode::Border` (`fill == Some(c)`), rounding to integer texels shifts the border edge
///   by up to `d_render / 2` device px (up to `17/255` at `sigma_c = 3`). Returning
///   `subtexel_border = Some(...)` tells the GPU to apply an exact area-weighted edge blend on
///   straddling boundary texels before blurring with `outer_bounds`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct HaloClipBounds {
    pub clamp_bounds: IRect,
    pub edge: EdgeMode,
    /// When `Some`, the caller should prefilter `draw.source` through `fs_halo_clip_border` using
    /// these target-local float clip bounds `[x0, y0, x1, y1]` and premultiplied `border` color.
    pub subtexel_border: Option<([f32; 4], [f32; 4])>,
    /// When `Some`, the caller has an unfilled `EdgeMode::Clamp` clip with target-local float
    /// bounds `[x0, y0, x1, y1]` and may prefilter `draw.source` through `fs_halo_clip_clamp`
    /// using captured edge strips.
    pub subtexel_clamp: Option<[f32; 4]>,
}

pub fn reduced_blur_bounds_and_edge(
    within: Option<ClipWithin>,
    frame_size: (i32, i32),
    shift: (i32, i32),
    target_size: (i32, i32),
    max_sigma: f32,
) -> HaloClipBounds {
    let Some(w) = within else {
        let (clamp_bounds, edge) =
            progressive_blur::blur_bounds_and_edge(None, frame_size, shift, target_size, max_sigma);
        return HaloClipBounds {
            clamp_bounds,
            edge,
            subtexel_border: None,
            subtexel_clamp: None,
        };
    };
    let (lvl, _) = blur::choose_level_view(max_sigma.max(0.0));
    let align = blur::level_step(lvl);
    let anchor_min = |raw: i32, limit: i32| -> i32 {
        if raw < 0 {
            raw.rem_euclid(align).min(limit)
        } else {
            raw.min(limit)
        }
    };
    let wx0 = w.x0 + shift.0 as f32;
    let wy0 = w.y0 + shift.1 as f32;
    let wx1 = w.x1 + shift.0 as f32;
    let wy1 = w.y1 + shift.1 as f32;
    let is_fractional = |v: f32| (v - v.round()).abs() > 1e-3;

    if let Some(c) = w.fill {
        let border = [
            f32::from(c[0]) / 255.0,
            f32::from(c[1]) / 255.0,
            f32::from(c[2]) / 255.0,
            f32::from(c[3]) / 255.0,
        ];
        let fractional = is_fractional(wx0) || is_fractional(wy0) || is_fractional(wx1) || is_fractional(wy1);
        if !fractional {
            let (clamp_bounds, edge) =
                progressive_blur::blur_bounds_and_edge(Some(w), frame_size, shift, target_size, max_sigma);
            return HaloClipBounds {
                clamp_bounds,
                edge,
                subtexel_border: None,
                subtexel_clamp: None,
            };
        }
        let cb = IRect {
            x0: anchor_min(wx0.floor() as i32, target_size.0),
            y0: anchor_min(wy0.floor() as i32, target_size.1),
            x1: (wx1.ceil() as i32).clamp(0, target_size.0),
            y1: (wy1.ceil() as i32).clamp(0, target_size.1),
        };
        return HaloClipBounds {
            clamp_bounds: cb,
            edge: EdgeMode::Border(border),
            subtexel_border: Some(([wx0, wy0, wx1, wy1], border)),
            subtexel_clamp: None,
        };
    }

    // EdgeMode::Clamp without solid fill: fallback clamp_bounds uses clean interior
    // `[ceil(x0), floor(x1))`, while `subtexel_clamp` enables exact edge-strip prefiltering when
    // strips were captured for this reader.
    let inner_axis = |lo: f32, hi: f32, frame_max: i32, sh: i32, limit: i32| -> (i32, i32) {
        let a = lo.ceil().max(0.0) as i32;
        let b = (hi.floor() as i32).min(frame_max);
        if a < b {
            (anchor_min(a + sh, limit), (b + sh).clamp(0, limit))
        } else {
            (
                anchor_min(lo.floor().max(0.0) as i32 + sh, limit),
                ((hi.ceil() as i32).min(frame_max) + sh).clamp(0, limit),
            )
        }
    };
    let (x0, x1) = inner_axis(w.x0, w.x1, frame_size.0, shift.0, target_size.0);
    let (y0, y1) = inner_axis(w.y0, w.y1, frame_size.1, shift.1, target_size.1);
    HaloClipBounds {
        clamp_bounds: IRect { x0, y0, x1, y1 },
        edge: EdgeMode::Clamp,
        subtexel_border: None,
        subtexel_clamp: Some([wx0, wy0, wx1, wy1]),
    }
}

/// Source region to prefilter through `fs_halo_clip_border` or `fs_halo_clip_clamp` before
/// blurring `dirty` at `sigma`. Includes Gaussian support plus 4x pyramid-level alignment slack
/// for the 2-texel pyramid apron.
#[inline]
pub fn subtexel_border_crop(dirty: IRect, sigma: f32) -> IRect {
    let (lvl, _) = blur::choose_level_view(sigma.max(0.0));
    let align = blur::level_step(lvl);
    let reach = blur::blur_reach_view(sigma).min(1.0e7).ceil() as i32 + (4 * align) + 4;
    dirty.inflate(reach, reach)
}

/// Unfilled `EdgeMode::Clamp` clip frame wrapping a coarse-tier blur, recorded in device pixels
/// so the GPU can render exact 1-pixel-aligned edge strips before blurring.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct HaloClampClip {
    pub reader_key: (u32, usize),
    /// Clip bounds `[x0, y0, x1, y1]` in unpadded device pixels.
    pub clip_dev: [f32; 4],
    /// Blur Gaussian support extent in unpadded device pixels.
    pub reach_rect: IRect,
}

/// Axis-aligned bounding box union of two integer rectangles (ignoring empty inputs).
#[inline]
pub fn rect_union(a: IRect, b: IRect) -> IRect {
    if a.is_empty() {
        return b;
    }
    if b.is_empty() {
        return a;
    }
    IRect {
        x0: a.x0.min(b.x0),
        y0: a.y0.min(b.y0),
        x1: a.x1.max(b.x1),
        y1: a.y1.max(b.y1),
    }
}

/// Complete viewport halo plan computed in `Engine::render_gpu` and executed by `Gpu::render_whole`.
#[derive(Clone, Debug, PartialEq)]
pub struct ViewportHaloPlan {
    /// Union of all visible readers' full sample bounds (far replay).
    pub samples: IRect,
    /// Optional mid-range replay bounds (present when `far_divisor > 16` and mid-band blurs exist).
    pub mid_samples: Option<IRect>,
    /// Logical coarse divisor for the far replay (power of two `>= 2`).
    pub far_divisor: i32,
    /// Logical coarse divisor for the mid replay when `mid_samples.is_some()`.
    pub mid_divisor: Option<i32>,
    /// Padded bounds for the final device-resolution pass (for native stops and narrow readers).
    pub native_samples: IRect,
    /// Bounds in unpadded device pixels that coarse blur captures must cover (union of
    /// `native_samples` and any enclosing native spatial post-effect source area).
    pub capture_bounds: IRect,
    /// Readers `(record_id, op_index)` whose blurred output is overlapped by a later visible reader
    /// in the far replay tier and must therefore be composited back onto the far replay plane.
    pub downstream_readers: Vec<(u32, usize)>,
    /// Readers `(record_id, op_index)` whose blurred output is overlapped by a later visible reader
    /// that actually executes in the mid replay tier (including glass lenses sampling sub-far stops).
    pub downstream_mid_readers: Vec<(u32, usize)>,
    /// True when at least one visible reader is eligible for lower-density halo replay. When
    /// false, `samples` still pads a whole-frame draw but `render_reader_halo` is not entered.
    pub use_coarse_halo: bool,
    /// True when the far replay tier captures at least one uniform or progressive blur (and
    /// therefore may need supersampled area-correct prefiltering). Pure-glass replays keep `S = 1`.
    pub far_has_blur: bool,
    /// Finest visible backdrop feature width (in device pixels) preceding active blurs in the far
    /// replay (`f32::INFINITY` when none found). Drives content-aware `choose_supersample`.
    pub far_min_feature_px: f32,
    /// Finest visible backdrop feature width (in device pixels) preceding active blurs in the mid
    /// replay (`f32::INFINITY` when none found).
    pub mid_min_feature_px: f32,
    /// Unfilled `EdgeMode::Clamp` clip frames wrapping active coarse-tier blurs.
    pub clamp_clips: Vec<HaloClampClip>,
    /// Layer-blur scopes (record ids) wrapping active readers whose blur runs in the far tier
    /// rather than at device resolution (a layer blur past the native limits: case L3).
    pub coarse_post_scopes: Vec<u32>,
    /// The smallest device-pixel layer-blur sigma among `coarse_post_scopes` (`f32::INFINITY`
    /// when none): the far tier's render divisor stays at or below a third of it.
    pub coarse_post_min_sigma: f32,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cutover_scales_with_divisor_for_both_blur_types() {
        assert_eq!(progressive_cutover_sigma(2), 32.0);
        assert_eq!(progressive_cutover_sigma(8), 32.0);
        assert_eq!(progressive_cutover_sigma(16), 48.0);
        assert_eq!(progressive_cutover_sigma(32), 96.0);
        assert_eq!(progressive_cutover_sigma(64), 192.0);
        assert_eq!(progressive_cutover_sigma(128), 384.0);

        assert_eq!(uniform_cutover_sigma(8), 128.0);
        assert_eq!(uniform_cutover_sigma(32), 128.0);
        assert_eq!(uniform_cutover_sigma(64), 192.0);
        assert_eq!(uniform_cutover_sigma(128), 384.0);
    }

    #[test]
    fn variance_compensation_only_applies_above_unit_divisor() {
        assert_eq!(compensate_halo_sigma(10.0, 1), 10.0);
        let c = compensate_halo_sigma(3.0, 64);
        assert!((c * c - (9.0 - HALO_GRID_VARIANCE)).abs() < 1e-4);
        assert_eq!(compensate_halo_sigma(0.0, 64), 0.0);
    }

    #[test]
    fn supersample_adapts_to_feature_scale_and_respects_runtime_caps() {
        // Bench-style coarse content (68 px features at d=16, 170 px at d=32) skips supersampling.
        assert_eq!(choose_supersample(16, (768, 832), 68.0, 4096, 12_000_000), 1);
        assert_eq!(choose_supersample(32, (832, 896), 170.0, 4096, 12_000_000), 1);
        assert_eq!(choose_supersample(128, (640, 640), 500.0, 4096, 12_000_000), 1);

        // Real 2880x1800 at 100% zoom with r=250 (d=8, coarse 640x512) and 1-unit lines (2 px):
        // S=4 -> 2560x2048 = 5.24M <= 12M px, d_render = 2 px = 1 page unit.
        assert_eq!(choose_supersample(8, (640, 512), 2.0, 4096, 12_000_000), 4);
        // Real 2880x1800 at 500% zoom with r=250 (d=16, coarse 832x768) and k=1 (3 px bars):
        // targets S=8, steps down to S=4 -> 3328x3072 = 10.2M <= 12M px, d_render = 4 px.
        assert_eq!(choose_supersample(16, (832, 768), 3.0, 4096, 12_000_000), 4);
        // Software cap (2048 side, 4.2M px): d=128, coarse 320x320, fine 8 px -> S=4 (1280x1280).
        assert_eq!(choose_supersample(128, (320, 320), 8.0, 2048, 4_200_000), 4);
        // Large 1024x1024 coarse under 12M px cap with fine content -> S=2 (2048x2048 = 4.2M).
        assert_eq!(choose_supersample(64, (1024, 1024), 4.0, 4096, 12_000_000), 2);
        // Resonant stripes (width = d/2 -> period = d) trigger S=4 so features span >= 1.5 texels.
        assert_eq!(choose_supersample(16, (512, 512), 8.0, 4096, 12_000_000), 4);
        // Feature at 1.25 * d (< 1.5 * d threshold) still steps up to S=2.
        assert_eq!(choose_supersample(8, (512, 512), 10.0, 4096, 12_000_000), 2);
        // Tiny coarse frame (64x64) with fine 3 px features -> keeps render_divisor >= 2.
        assert_eq!(choose_supersample(128, (64, 64), 3.0, 2048, 4_200_000), 32);
        assert_eq!(choose_supersample(8, (64, 64), 2.0, 2048, 4_200_000), 4);
        assert_eq!(choose_supersample(2, (64, 64), 1.0, 2048, 4_200_000), 1);
    }

    #[test]
    fn reduced_clip_bounds_avoid_outside_clamp_and_flag_fractional_border() {
        let clamp_within = ClipWithin {
            x0: 10.5,
            y0: 20.25,
            x1: 50.75,
            y1: 60.5,
            fill: None,
        };
        let res = reduced_blur_bounds_and_edge(Some(clamp_within), (128, 128), (0, 0), (128, 128), 6.0);
        assert_eq!(res.edge, EdgeMode::Clamp);
        assert_eq!(
            res.clamp_bounds,
            IRect {
                x0: 11,
                y0: 21,
                x1: 50,
                y1: 60
            }
        );
        assert!(res.subtexel_border.is_none());
        assert_eq!(res.subtexel_clamp, Some([10.5, 20.25, 50.75, 60.5]));

        let border_within = ClipWithin {
            x0: 10.5,
            y0: 20.0,
            x1: 50.0,
            y1: 60.0,
            fill: Some([255, 255, 255, 255]),
        };
        let res_b = reduced_blur_bounds_and_edge(Some(border_within), (128, 128), (0, 0), (128, 128), 6.0);
        assert_eq!(
            res_b.clamp_bounds,
            IRect {
                x0: 10,
                y0: 20,
                x1: 50,
                y1: 60
            }
        );
        assert!(res_b.subtexel_border.is_some());
        assert!(res_b.subtexel_clamp.is_none());
    }

    /// Verifies the full-resolution-vs-reduced-blur error gate (`max <= 4/255`, `p99 <= 2/255`)
    /// at divisor 64 and 128 across stripes (including resonant periods), blocks, and fractional
    /// clip edges using the engine's exact `blur_reference` and `CpuBlurCache` pyramid math.
    #[test]
    fn reduced_prefiltered_blur_meets_fidelity_gate_at_d64_and_d128() {
        for &d in &[64i32, 128i32] {
            let s = 4i32;
            let dr = d / s;
            let coarse_n = 28i32;
            let n = (d * coarse_n) as usize;
            let fine_n = (n / dr as usize) as u32;
            let sigma = HALO_MIN_COARSE_SIGMA * d as f32;
            let sigma_fine = compensate_halo_sigma(sigma / dr as f32, dr);

            // Build 1D stripes (resonant period ~1.06*d, fine stripes, blocks) into 1-row RGBA8.
            let mut patterns: Vec<(&str, Vec<u8>)> = Vec::new();
            for &period in &[d / 2, d, d + d / 16, d * 2, d * 4] {
                let mut row = vec![0u8; n * 4];
                for x in 0..n {
                    let v = if (x as i32 % period) < (period / 2) { 240 } else { 16 };
                    row[x * 4..x * 4 + 4].copy_from_slice(&[v, v, v, 255]);
                }
                patterns.push(("stripe", row));
            }
            let mut block = vec![0u8; n * 4];
            let bw = (4 * d) as usize;
            for x in 0..n {
                let v = if x >= n / 2 - bw / 2 && x < n / 2 + bw / 2 {
                    240
                } else {
                    16
                };
                block[x * 4..x * 4 + 4].copy_from_slice(&[v, v, v, 255]);
            }
            patterns.push(("block", block));

            let m0 = (12 * d) as usize;
            let m1 = n - m0;
            let mut cache = blur::CpuBlurCache::new(4 << 20);
            for (idx, (kind, src)) in patterns.iter().enumerate() {
                let mut ref_out = vec![0u8; (m1 - m0) * 4];
                let ref_spec = blur::BlurSpec {
                    sigma,
                    edge: EdgeMode::Clamp,
                    clamp_bounds: IRect {
                        x0: 0,
                        y0: 0,
                        x1: n as i32,
                        y1: 1,
                    },
                    dirty: IRect {
                        x0: m0 as i32,
                        y0: 0,
                        x1: m1 as i32,
                        y1: 1,
                    },
                };
                blur::blur_reference(
                    src,
                    (n as u32, 1),
                    &mut ref_out,
                    ((m1 - m0) as u32, 1),
                    (m0 as i32, 0),
                    &ref_spec,
                );

                // Supersampled fine render (exact box over dr device px) + engine pyramid blur.
                let mut fine = vec![0u8; fine_n as usize * 4];
                for fx in 0..fine_n as usize {
                    let mut sum = 0u32;
                    for k in 0..dr as usize {
                        sum += u32::from(src[(fx * dr as usize + k) * 4]);
                    }
                    let v = ((sum + (dr as u32) / 2) / dr as u32) as u8;
                    fine[fx * 4..fx * 4 + 4].copy_from_slice(&[v, v, v, 255]);
                }
                let mut fine_blurred = vec![0u8; fine_n as usize * 4];
                let fine_spec = blur::BlurSpec {
                    sigma: sigma_fine,
                    edge: EdgeMode::Clamp,
                    clamp_bounds: IRect {
                        x0: 0,
                        y0: 0,
                        x1: fine_n as i32,
                        y1: 1,
                    },
                    dirty: IRect {
                        x0: 0,
                        y0: 0,
                        x1: fine_n as i32,
                        y1: 1,
                    },
                };
                let src_id = (d as u64) * 100 + idx as u64 + 1;
                cache
                    .try_blur(
                        src_id,
                        &fine,
                        (fine_n, 1),
                        &mut fine_blurred,
                        (fine_n, 1),
                        (0, 0),
                        &fine_spec,
                    )
                    .expect("fine blur");

                // Bilinear upsample matching readers.wgsl sample_progressive_stop.
                let mut diffs = Vec::with_capacity(m1 - m0);
                for x in m0..m1 {
                    let p = ((x as f32 + 0.5) / dr as f32 - 0.5).clamp(0.0, (fine_n - 1) as f32);
                    let a = p.floor() as usize;
                    let b = (a + 1).min(fine_n as usize - 1);
                    let f = p - a as f32;
                    let v = (f32::from(fine_blurred[a * 4]) * (1.0 - f) + f32::from(fine_blurred[b * 4]) * f)
                        .round_ties_even() as u8;
                    let r = ref_out[(x - m0) * 4];
                    diffs.push(v.abs_diff(r));
                }
                diffs.sort_unstable();
                let max = *diffs.last().unwrap_or(&0);
                let p99 = diffs[diffs.len() * 99 / 100];
                assert!(
                    max <= 4 && p99 <= 2,
                    "d={d} {kind}: max={max}/255, p99={p99}/255 exceeded gate (<=4, <=2)"
                );
            }
        }
    }
}
