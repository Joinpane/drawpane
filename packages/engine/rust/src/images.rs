//! Images: uploaded once per handle as premultiplied RGBA8, with a chain of halved levels made
//! here so both backends sample the same pixels. A draw picks the smallest level at least as
//! wide as it shows (as the canvas renderer's `ImageCache.get` picks a bitmap).

use crate::error::{EngineError, ErrorCode, Result};

/// Levels are never smaller than this on their longer side.
const MIN_LEVEL: u32 = 32;

pub struct Level {
    pub width: u32,
    pub height: u32,
    /// Premultiplied RGBA8.
    pub pixels: Vec<u8>,
}

/// Validates an upload and builds its levels, the full image first.
pub fn levels(width: u32, height: u32, rgba: &[u8], premultiplied: bool, max_side: u32) -> Result<Vec<Level>> {
    if width == 0 || height == 0 {
        return Err(EngineError::new(ErrorCode::Image, "an image with no pixels"));
    }
    if width > max_side || height > max_side {
        return Err(EngineError::limit(format!(
            "an image {width} × {height}; the longest side allowed is {max_side}"
        )));
    }
    if rgba.len() != (width as usize) * (height as usize) * 4 {
        return Err(EngineError::new(ErrorCode::Image, "image bytes don't match its size"));
    }
    let pixels = premultiply(rgba, premultiplied);
    let mut out = vec![Level { width, height, pixels }];
    loop {
        let last = out.last().expect("one level");
        if last.width.max(last.height) / 2 < MIN_LEVEL || last.width < 2 || last.height < 2 {
            break;
        }
        let (w, h) = (last.width / 2, last.height / 2);
        let mut next = vec![0u8; (w * h * 4) as usize];
        let src = &last.pixels;
        let sw = last.width as usize;
        for y in 0..h as usize {
            for x in 0..w as usize {
                for c in 0..4 {
                    let at = |xx: usize, yy: usize| u32::from(src[(yy * sw + xx) * 4 + c]);
                    let sum = at(2 * x, 2 * y) + at(2 * x + 1, 2 * y) + at(2 * x, 2 * y + 1) + at(2 * x + 1, 2 * y + 1);
                    next[(y * w as usize + x) * 4 + c] = ((sum + 2) / 4) as u8;
                }
            }
        }
        out.push(Level {
            width: w,
            height: h,
            pixels: next,
        });
    }
    Ok(out)
}

/// Bytes the levels of a `width` × `height` image take, worked out before any is made (so an
/// upload past the budget is refused before it's copied).
pub fn levels_bytes(width: u32, height: u32) -> usize {
    let (mut w, mut h) = (width as usize, height as usize);
    let mut total = 0usize;
    loop {
        total = total.saturating_add(w * h * 4);
        if (w.max(h) / 2) < MIN_LEVEL as usize || w < 2 || h < 2 {
            return total;
        }
        w /= 2;
        h /= 2;
    }
}

pub fn bytes(levels: &[Level]) -> usize {
    levels.iter().map(|l| l.pixels.len()).sum()
}

pub fn premultiply(rgba: &[u8], premultiplied: bool) -> Vec<u8> {
    let mut pixels = rgba.to_vec();
    if !premultiplied {
        for pixel in pixels.as_chunks_mut::<4>().0 {
            let alpha = u32::from(pixel[3]);
            for channel in &mut pixel[..3] {
                *channel = ((u32::from(*channel) * alpha + 127) / 255) as u8;
            }
        }
    }
    pixels
}

/// The smallest resident level at least `px` wide, else the largest.
pub fn pick(widths: impl Iterator<Item = u32>, px: f64) -> usize {
    widths
        .take_while(|&width| f64::from(width) >= px)
        .count()
        .saturating_sub(1)
}
