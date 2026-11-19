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
    let mut pixels = rgba.to_vec();
    if !premultiplied {
        for p in pixels.as_chunks_mut::<4>().0.iter_mut() {
            let a = u32::from(p[3]);
            for c in &mut p[..3] {
                *c = ((u32::from(*c) * a + 127) / 255) as u8;
            }
        }
    }
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

pub fn bytes(levels: &[Level]) -> usize {
    levels.iter().map(|l| l.pixels.len()).sum()
}

/// The smallest level at least `px` wide, else the largest.
pub fn pick(widths: impl DoubleEndedIterator<Item = u32>, px: f64) -> usize {
    let widths: Vec<u32> = widths.collect();
    for (i, w) in widths.iter().enumerate().rev() {
        if f64::from(*w) >= px {
            return i;
        }
    }
    0
}
