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

/// The smallest resident level covering both projected axes, else the largest.
/// What rows `y..y + rows` of a level `height` rows tall, uploaded in strips from `source`, do
/// to the part of that level uploaded so far (`pending`: its source, height and next row): start
/// it afresh (`true`: rows from 0, any part from another upload let go) or go on with it
/// (`false`). Rows out of order, past the level, or from another source than the part uploaded
/// so far are refused: a level never mixes two images.
pub fn strip_step<S: PartialEq>(
    pending: Option<(&S, u32, u32)>,
    source: &S,
    height: u32,
    y: u32,
    rows: u32,
) -> Result<bool> {
    if rows == 0 || y >= height || rows > height - y {
        return Err(EngineError::new(ErrorCode::State, "image rows out of order"));
    }
    if y == 0 {
        return Ok(true);
    }
    match pending {
        None => Err(EngineError::new(
            ErrorCode::State,
            "image rows before the level's first",
        )),
        Some((s, _, _)) if s != source => Err(EngineError::new(ErrorCode::State, "image rows from another upload")),
        Some((_, h, next)) if h != height || y != next => {
            Err(EngineError::new(ErrorCode::State, "image rows out of order"))
        }
        Some(_) => Ok(false),
    }
}

#[cfg(test)]
mod strip_tests {
    use super::strip_step;

    /// Two uploads of one width interleaved: the second's first rows start it afresh, and the
    /// first's later rows are refused, never landing in the second's texture (#352 re-check 2).
    #[test]
    fn strips_from_another_upload_never_land_in_a_level() {
        let (a, b) = (1u32, 2u32);
        assert!(strip_step(None, &a, 512, 0, 64).expect("a starts"));
        assert!(!strip_step(Some((&a, 512, 64)), &a, 512, 64, 64).expect("a goes on"));
        assert!(strip_step(Some((&a, 512, 128)), &b, 512, 0, 64).expect("b starts afresh"));
        let refused = strip_step(Some((&b, 512, 64)), &a, 512, 128, 64).expect_err("a's rows refused");
        assert!(refused.message.contains("another upload"));
        assert!(!strip_step(Some((&b, 512, 64)), &b, 512, 64, 448).expect("b finishes"));
        // Out of order, past the level, empty, or with nothing started.
        assert!(strip_step(Some((&b, 512, 64)), &b, 512, 128, 64).is_err());
        assert!(strip_step(Some((&b, 512, 64)), &b, 512, 64, 449).is_err());
        assert!(strip_step(Some((&b, 512, 64)), &b, 512, 64, 0).is_err());
        assert!(strip_step(None, &b, 512, 64, 64).is_err());
        assert!(strip_step(Some((&b, 256, 64)), &b, 512, 64, 64).is_err());
    }
}

pub fn pick(sizes: impl Iterator<Item = (u32, u32)>, span: (f64, f64)) -> usize {
    sizes
        .take_while(|&(width, height)| f64::from(width) >= span.0 && f64::from(height) >= span.1)
        .count()
        .saturating_sub(1)
}

/// The projected lengths of the image's unit-square axes.
pub fn span(matrix: vello_common::kurbo::Affine) -> (f64, f64) {
    let [a, b, c, d, ..] = matrix.as_coeffs();
    (a.hypot(b), c.hypot(d))
}
