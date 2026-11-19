//! Backdrop-reading kernels, written in Rust as the semantic reference (review item 6): the
//! GPU's versions, when they come (phase 3), are held to these.
//!
//! Phase 1 draws no real reader (glass and background blur fall back to the canvas renderer),
//! but the render graph's ordering and invalidation must already be right for them. So the
//! tests use a reference reader with a reach: it replaces each pixel it paints with the mean of
//! the backdrop around it (a box `halo` pixels each way). It's built only with the
//! `test-kernels` feature and is refused everywhere else.

use crate::error::{EngineError, Result};
use crate::exec::IRect;

/// The box mean over the backdrop: kernel 1, test builds only.
pub const KERNEL_BOX_MEAN: u32 = 1;

/// Runs `kernel` over the premultiplied RGBA8 backdrop `src` (`width` × `height`, the target's
/// pixels from `origin` on), writing what it paints over `paints` into `out` (the same size; pixels outside
/// `paints` are left alone). Pixels outside the target read as the nearest edge (repeat at the
/// canvas's edge, as the canvas renderer reads a backdrop). The caller lays `out` on the target
/// through the clips the reader is drawn in.
#[allow(clippy::too_many_arguments)]
pub fn run(
    kernel: u32,
    src: &[u8],
    out: &mut [u8],
    width: i32,
    height: i32,
    origin: (i32, i32),
    paints: IRect,
    reads: IRect,
    halo: i32,
) -> Result<()> {
    let (left, top) = origin;
    if !cfg!(feature = "test-kernels") || kernel != KERNEL_BOX_MEAN {
        return Err(EngineError::unsupported(format!("backdrop reader {kernel}")));
    }
    let p = IRect {
        x0: paints.x0.saturating_sub(left),
        y0: paints.y0.saturating_sub(top),
        x1: paints.x1.saturating_sub(left),
        y1: paints.y1.saturating_sub(top),
    }
    .clamp(width, height);
    if p.is_empty() {
        return Ok(());
    }
    // Samples stay inside what the reader says it reads (its read region, on the device), and
    // inside the target.
    let (rx0, rx1) = (
        reads.x0.saturating_sub(left).max(0),
        (reads.x1.saturating_sub(left) - 1).min(width - 1),
    );
    let (ry0, ry1) = (
        reads.y0.saturating_sub(top).max(0),
        (reads.y1.saturating_sub(top) - 1).min(height - 1),
    );
    if rx1 < rx0 || ry1 < ry0 {
        return Ok(());
    }
    let at = |x: i32, y: i32, c: usize| -> u32 {
        let x = x.clamp(rx0, rx1);
        let y = y.clamp(ry0, ry1);
        u32::from(src[((y * width + x) * 4) as usize + c])
    };
    let r = halo.clamp(0, 8);
    let n = ((2 * r + 1) * (2 * r + 1)) as u32;
    for y in p.y0..p.y1 {
        for x in p.x0..p.x1 {
            for c in 0..4 {
                let mut sum = 0u32;
                for dy in -r..=r {
                    for dx in -r..=r {
                        sum += at(x + dx, y + dy, c);
                    }
                }
                out[((y * width + x) * 4) as usize + c] = ((sum + n / 2) / n) as u8;
            }
        }
    }
    Ok(())
}
