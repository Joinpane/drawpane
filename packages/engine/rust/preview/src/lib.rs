//! Bounded server-side preview generator: decodes PNG, JPEG, GIF and WebP inside a 32 MiB
//! WebAssembly linear-memory cap, applies EXIF orientation, box-downsamples to a fixed long side,
//! and encodes a lossy WebP preview (VP8, with ALPH when transparent).
use oxideav_webp::EncodeOptions;
use wasm_bindgen::prelude::*;

const MIB: usize = 1 << 20;
const MAX_MEMORY: usize = 32 * MIB;
const MAX_NATURAL_SIDE: u32 = 16_384;
const MAX_PREVIEW_SIDE: u32 = 4096;

#[wasm_bindgen(js_name = memoryBytes)]
pub fn memory_bytes() -> u32 {
    #[cfg(target_arch = "wasm32")]
    {
        (core::arch::wasm32::memory_size(0) * 65536) as u32
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        0
    }
}

/// Reads EXIF orientation (tag 0x0112, values 1..=8) from a TIFF header payload.
fn tiff_orientation(tiff: &[u8]) -> Option<u8> {
    if tiff.len() < 8 {
        return None;
    }
    let little = match &tiff[0..2] {
        b"II" => true,
        b"MM" => false,
        _ => return None,
    };
    let u16_at = |offset: usize| -> Option<u16> {
        let pair: [u8; 2] = tiff.get(offset..offset + 2)?.try_into().ok()?;
        Some(if little {
            u16::from_le_bytes(pair)
        } else {
            u16::from_be_bytes(pair)
        })
    };
    let u32_at = |offset: usize| -> Option<u32> {
        let quad: [u8; 4] = tiff.get(offset..offset + 4)?.try_into().ok()?;
        Some(if little {
            u32::from_le_bytes(quad)
        } else {
            u32::from_be_bytes(quad)
        })
    };
    if u16_at(2)? != 42 {
        return None;
    }
    let ifd = u32_at(4)? as usize;
    let count = usize::from(u16_at(ifd)?);
    let max_entries = count.min(256);
    for i in 0..max_entries {
        let entry = ifd.checked_add(2)?.checked_add(i.checked_mul(12)?)?;
        if entry.checked_add(12)? > tiff.len() {
            break;
        }
        let tag = u16_at(entry)?;
        if tag == 0x0112 {
            // SHORT (type 3), count 1, value in the first 2 bytes of the value/offset field.
            let typ = u16_at(entry + 2)?;
            let val_count = u32_at(entry + 4)?;
            if typ == 3 && val_count == 1 {
                let value = u16_at(entry + 8)?;
                if (1..=8).contains(&value) {
                    return Some(value as u8);
                }
            }
            return None;
        }
    }
    None
}

/// Extracts EXIF orientation (1..=8) from JPEG APP1 or WebP EXIF chunks. Defaults to 1.
pub fn exif_orientation(bytes: &[u8]) -> u8 {
    // JPEG: walk marker segments until SOS (0xDA) or EOI (0xD9).
    if bytes.get(..2) == Some(&[0xFF, 0xD8]) {
        let mut pos = 2usize;
        while pos + 4 <= bytes.len() {
            if bytes[pos] != 0xFF {
                break;
            }
            while bytes.get(pos) == Some(&0xFF) {
                pos += 1;
            }
            let Some(&marker) = bytes.get(pos) else {
                break;
            };
            pos += 1;
            if marker == 0x01 || (0xD0..=0xD8).contains(&marker) {
                continue;
            }
            if marker == 0xD9 || marker == 0xDA {
                break;
            }
            let Some(&[hi, lo, ..]) = bytes.get(pos..) else {
                break;
            };
            let len = usize::from(u16::from_be_bytes([hi, lo]));
            if len < 2 || pos.checked_add(len).is_none_or(|end| end > bytes.len()) {
                break;
            }
            if marker == 0xE1 {
                let payload = &bytes[pos + 2..pos + len];
                if let Some(tiff) = payload.strip_prefix(b"Exif\0\0")
                    && let Some(orientation) = tiff_orientation(tiff)
                {
                    return orientation;
                }
            }
            pos += len;
        }
        return 1;
    }

    // WebP: RIFF....WEBP followed by FourCC + u32le size chunks.
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        let mut pos = 12usize;
        while pos + 8 <= bytes.len() {
            let fourcc = &bytes[pos..pos + 4];
            let len = u32::from_le_bytes([bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]]) as usize;
            pos += 8;
            if pos.checked_add(len).is_none_or(|end| end > bytes.len()) {
                break;
            }
            if fourcc == b"EXIF" {
                let payload = &bytes[pos..pos + len];
                let tiff = payload.strip_prefix(b"Exif\0\0").unwrap_or(payload);
                if let Some(orientation) = tiff_orientation(tiff) {
                    return orientation;
                }
                return 1;
            }
            pos += len + (len & 1);
        }
    }

    1
}

fn swaps_axes(orientation: u8) -> bool {
    matches!(orientation, 5..=8)
}

fn apply_orientation(rgba: Vec<u8>, width: u32, height: u32, orientation: u8) -> (u32, u32, Vec<u8>) {
    if orientation <= 1 || orientation > 8 {
        return (width, height, rgba);
    }
    let w = width as usize;
    let h = height as usize;
    let (out_w, out_h) = if swaps_axes(orientation) { (h, w) } else { (w, h) };
    let mut out = vec![0u8; out_w * out_h * 4];
    for y in 0..h {
        for x in 0..w {
            let (dx, dy) = match orientation {
                2 => (w - 1 - x, y),
                3 => (w - 1 - x, h - 1 - y),
                4 => (x, h - 1 - y),
                5 => (y, x),
                6 => (h - 1 - y, x),
                7 => (h - 1 - y, w - 1 - x),
                8 => (y, w - 1 - x),
                _ => (x, y),
            };
            let src = (y * w + x) * 4;
            let dst = (dy * out_w + dx) * 4;
            out[dst..dst + 4].copy_from_slice(&rgba[src..src + 4]);
        }
    }
    (out_w as u32, out_h as u32, out)
}

fn preview_dimensions(width: u32, height: u32, max_side: u32) -> (u32, u32) {
    let longest = width.max(height);
    if longest <= max_side {
        return (width, height);
    }
    let scale = f64::from(max_side) / f64::from(longest);
    let w = ((f64::from(width) * scale).round() as u32).max(1);
    let h = ((f64::from(height) * scale).round() as u32).max(1);
    (w, h)
}

/// Core preview generator returning encoded WebP bytes, or `Ok(None)` when the image doesn't fit
/// inside the memory budget or encoding cannot beat the input size.
pub fn generate_preview(
    width: u32,
    height: u32,
    max_side: u32,
    quality: f32,
    bytes: &[u8],
    budget: usize,
) -> Result<Option<Vec<u8>>, String> {
    if width == 0 || height == 0 || max_side == 0 || max_side > MAX_PREVIEW_SIDE || width.max(height) > MAX_NATURAL_SIDE
    {
        return Err("image dimensions exceed the preview generator's limit".into());
    }
    let orientation = exif_orientation(bytes);
    let (orient_w, orient_h) = if swaps_axes(orientation) {
        (height, width)
    } else {
        (width, height)
    };
    let (target_w, target_h) = preview_dimensions(orient_w, orient_h, max_side);
    let (mut decode_w, mut decode_h) = if swaps_axes(orientation) {
        (target_h, target_w)
    } else {
        (target_w, target_h)
    };

    // Reserve working memory for orientation transform + WebP YUV/VP8 encoder buffers.
    let target_rgba_bytes = (target_w as usize) * (target_h as usize) * 4;
    let effective_budget = budget.min(MAX_MEMORY);
    let encode_headroom = target_rgba_bytes.saturating_mul(3);
    if bytes.len().saturating_add(encode_headroom).saturating_add(2 * MIB) > effective_budget {
        return Ok(None);
    }

    let mut decoded = drawpane_image_decoder::decode_rgba(
        (width, height),
        (decode_w, decode_h),
        bytes,
        effective_budget,
        MAX_NATURAL_SIDE,
    )?;

    // For large progressive JPEGs (e.g. 4032x3024 phone photos targeting 1024 px), a target just
    // above a DCT power-of-two scale (1008x756) forces 1/2 IDCT (2016x1512) which can exceed the
    // memory cap. Step down slightly to the nearest DCT scale (>= 75% of max_side) if it fits.
    if decoded.is_none() && bytes.get(..2) == Some(&[0xFF, 0xD8]) {
        let min_long = (max_side * 3) / 4;
        for div in [2u32, 4, 8] {
            let sw = width.div_ceil(div).max(1);
            let sh = height.div_ceil(div).max(1);
            if sw <= decode_w
                && sh <= decode_h
                && sw.max(sh) >= min_long
                && let Some(buf) = drawpane_image_decoder::decode_rgba(
                    (width, height),
                    (sw, sh),
                    bytes,
                    effective_budget,
                    MAX_NATURAL_SIDE,
                )?
            {
                decode_w = sw;
                decode_h = sh;
                decoded = Some(buf);
                break;
            }
        }
    }

    let Some(decoded) = decoded else {
        return Ok(None);
    };

    let (out_w, out_h, rgba) = apply_orientation(decoded, decode_w, decode_h, orientation);
    let opaque = rgba.as_chunks::<4>().0.iter().all(|px| px[3] == 255);
    let opts = EncodeOptions::default()
        .with_quality(quality.clamp(1.0, 100.0))
        .with_method(0)
        .with_threads(1);

    let encoded = if opaque {
        let mut rgb = Vec::with_capacity((out_w as usize) * (out_h as usize) * 3);
        for px in rgba.as_chunks::<4>().0 {
            rgb.extend_from_slice(&px[..3]);
        }
        drop(rgba);
        oxideav_webp::encode_rgb8(out_w, out_h, &rgb, &opts)
    } else {
        oxideav_webp::encode_rgba8(out_w, out_h, &rgba, &opts)
    }
    .map_err(|e| format!("webp encode failed: {e}"))?;

    if encoded.len() >= bytes.len() {
        return Ok(None);
    }
    Ok(Some(encoded))
}

/// Generates a bounded WebP preview capped to `max_side` on its longest side.
/// Returns `Ok(None)` when the preview would exceed memory limits or wouldn't be smaller than the original.
#[wasm_bindgen(js_name = makePreview)]
pub fn make_preview(
    width: u32,
    height: u32,
    max_side: u32,
    quality: f32,
    bytes: &[u8],
    budget: u32,
) -> Result<Option<Vec<u8>>, JsError> {
    generate_preview(width, height, max_side, quality, bytes, budget as usize).map_err(|e| JsError::new(&e))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn encode_test_png(width: u32, height: u32, rgba: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        {
            let mut enc = png::Encoder::new(&mut out, width, height);
            enc.set_color(png::ColorType::Rgba);
            enc.set_depth(png::BitDepth::Eight);
            let mut writer = enc.write_header().unwrap();
            writer.write_image_data(rgba).unwrap();
        }
        out
    }

    fn textured_rgba(width: u32, height: u32, with_alpha: bool) -> Vec<u8> {
        let mut buf = Vec::with_capacity((width * height * 4) as usize);
        for y in 0..height {
            for x in 0..width {
                let r = ((x * 7 + y * 3) ^ (x.wrapping_mul(y))) as u8;
                let g = ((x * 13 + y * 5) ^ ((x >> 1).wrapping_mul(y + 1))) as u8;
                let b = ((x * 17 + y * 11) ^ (x.wrapping_add(y * 3))) as u8;
                let a = if with_alpha && x < width / 2 { 128 } else { 255 };
                buf.extend_from_slice(&[r, g, b, a]);
            }
        }
        buf
    }

    #[test]
    fn generates_smaller_webp_previews_from_progressive_jpeg() {
        let bytes = include_bytes!("../../../../../apps/worker/test/fixtures/progressive-4032.jpg");
        for side in [256u32, 1024u32] {
            let webp = generate_preview(4032, 3024, side, 80.0, bytes, MAX_MEMORY)
                .unwrap()
                .expect("preview should be generated");
            assert!(
                webp.len() < bytes.len(),
                "preview ({} B) should be smaller than original ({} B)",
                webp.len(),
                bytes.len()
            );
            let info = oxideav_webp::info(&webp).expect("valid webp header");
            let longest = info.width.max(info.height);
            assert!(
                longest <= side && longest >= (side * 3) / 4,
                "expected preview long side near {side}, got {}x{}",
                info.width,
                info.height
            );
            assert!(!info.has_alpha);
            let decoded = oxideav_webp::decode_rgba8(&webp).expect("decodable webp");
            assert_eq!(decoded.width, info.width);
            assert_eq!(decoded.height, info.height);
        }
    }

    #[test]
    fn preserves_alpha_from_transparent_png() {
        let rgba = textured_rgba(512, 384, true);
        let png = encode_test_png(512, 384, &rgba);
        let webp = generate_preview(512, 384, 256, 80.0, &png, MAX_MEMORY)
            .unwrap()
            .expect("alpha PNG preview should be generated");
        assert!(webp.len() < png.len());
        let info = oxideav_webp::info(&webp).expect("valid webp");
        assert_eq!((info.width, info.height), (256, 192));
        assert!(info.has_alpha, "transparent PNG preview must keep alpha");
        let decoded = oxideav_webp::decode_rgba8(&webp).expect("decodable");
        let left_alpha = decoded.data[(96 * 256 + 32) * 4 + 3];
        let right_alpha = decoded.data[(96 * 256 + 224) * 4 + 3];
        assert!(
            left_alpha < 170 && left_alpha > 90,
            "expected ~128 alpha, got {left_alpha}"
        );
        assert_eq!(right_alpha, 255);
    }

    #[test]
    fn encodes_opaque_png_and_does_not_upscale_small_images() {
        let rgba = textured_rgba(200, 150, false);
        let png = encode_test_png(200, 150, &rgba);
        let webp = generate_preview(200, 150, 256, 80.0, &png, MAX_MEMORY)
            .unwrap()
            .expect("noisy 200x150 PNG should shrink as WebP");
        assert!(webp.len() < png.len());
        let info = oxideav_webp::info(&webp).expect("valid webp");
        assert_eq!((info.width, info.height), (200, 150), "must not upscale");
        assert!(!info.has_alpha);
    }

    #[test]
    fn downscales_gif_and_webp_originals() {
        // GIF 512x256 -> 256x128 WebP.
        let mut gif_bytes = Vec::new();
        {
            let mut palette = Vec::with_capacity(256 * 3);
            for i in 0..256u32 {
                palette.extend_from_slice(&[(i * 3) as u8, (i * 5) as u8, (i * 7) as u8]);
            }
            let mut enc = gif::Encoder::new(&mut gif_bytes, 512, 256, &palette).unwrap();
            let pixels: Vec<u8> = (0..512 * 256).map(|i| ((i * 31 + (i >> 8) * 17) & 255) as u8).collect();
            let frame = gif::Frame::from_indexed_pixels(512, 256, pixels, None);
            enc.write_frame(&frame).unwrap();
        }
        let gif_preview = generate_preview(512, 256, 256, 80.0, &gif_bytes, MAX_MEMORY)
            .unwrap()
            .expect("GIF preview should be generated");
        let gif_info = oxideav_webp::info(&gif_preview).unwrap();
        assert_eq!((gif_info.width, gif_info.height), (256, 128));

        // Large noisy WebP 640x480 -> 256x192 WebP.
        let rgba = textured_rgba(640, 480, false);
        let rgb: Vec<u8> = rgba
            .as_chunks::<4>()
            .0
            .iter()
            .flat_map(|p| [p[0], p[1], p[2]])
            .collect();
        let src_webp = oxideav_webp::encode_rgb8(
            640,
            480,
            &rgb,
            &EncodeOptions::default()
                .with_quality(95.0)
                .with_method(1)
                .with_threads(1),
        )
        .unwrap();
        let webp_preview = generate_preview(640, 480, 256, 80.0, &src_webp, MAX_MEMORY)
            .unwrap()
            .expect("WebP preview should be generated");
        let webp_info = oxideav_webp::info(&webp_preview).unwrap();
        assert_eq!((webp_info.width, webp_info.height), (256, 192));
        assert!(webp_preview.len() < src_webp.len());
    }

    #[test]
    fn returns_none_when_budget_is_too_small_and_errors_on_corrupt_input() {
        let bytes = include_bytes!("../../../../../apps/worker/test/fixtures/progressive-4032.jpg");
        let tiny = generate_preview(4032, 3024, 1024, 80.0, bytes, 3 * MIB).unwrap();
        assert!(tiny.is_none());

        assert!(generate_preview(64, 64, 256, 80.0, b"not-an-image", MAX_MEMORY).is_err());
        assert!(generate_preview(0, 64, 256, 80.0, bytes, MAX_MEMORY).is_err());
    }

    #[test]
    fn parses_exif_orientation_and_rotates_pixels() {
        // Minimal JPEG header with APP1 Exif orientation = 6 (90 deg CW).
        let mut jpeg = vec![0xFF, 0xD8, 0xFF, 0xE1, 0x00, 0x22];
        jpeg.extend_from_slice(b"Exif\0\0");
        jpeg.extend_from_slice(b"II"); // little endian
        jpeg.extend_from_slice(&42u16.to_le_bytes());
        jpeg.extend_from_slice(&8u32.to_le_bytes()); // IFD0 offset
        jpeg.extend_from_slice(&1u16.to_le_bytes()); // 1 entry
        jpeg.extend_from_slice(&0x0112u16.to_le_bytes()); // Orientation tag
        jpeg.extend_from_slice(&3u16.to_le_bytes()); // SHORT
        jpeg.extend_from_slice(&1u32.to_le_bytes()); // count 1
        jpeg.extend_from_slice(&6u16.to_le_bytes()); // value = 6
        jpeg.extend_from_slice(&0u16.to_le_bytes()); // padding
        jpeg.extend_from_slice(&0u32.to_le_bytes()); // next IFD
        jpeg.extend_from_slice(&[0xFF, 0xD9]);
        assert_eq!(exif_orientation(&jpeg), 6);

        // Minimal WebP with EXIF chunk orientation = 8 (90 deg CCW, big endian).
        let mut tiff = Vec::new();
        tiff.extend_from_slice(b"MM");
        tiff.extend_from_slice(&42u16.to_be_bytes());
        tiff.extend_from_slice(&8u32.to_be_bytes());
        tiff.extend_from_slice(&1u16.to_be_bytes());
        tiff.extend_from_slice(&0x0112u16.to_be_bytes());
        tiff.extend_from_slice(&3u16.to_be_bytes());
        tiff.extend_from_slice(&1u32.to_be_bytes());
        tiff.extend_from_slice(&8u16.to_be_bytes());
        tiff.extend_from_slice(&0u16.to_be_bytes());
        tiff.extend_from_slice(&0u32.to_be_bytes());
        let mut webp = Vec::new();
        webp.extend_from_slice(b"RIFF");
        webp.extend_from_slice(&(12 + tiff.len() as u32).to_le_bytes());
        webp.extend_from_slice(b"WEBP");
        webp.extend_from_slice(b"EXIF");
        webp.extend_from_slice(&(tiff.len() as u32).to_le_bytes());
        webp.extend_from_slice(&tiff);
        assert_eq!(exif_orientation(&webp), 8);

        // 2x3 image: top-left pixel (0,0) is red; verify all 8 orientations preserve total pixels
        // and place (0,0) in the expected corner.
        let mut rgba = vec![0u8; 2 * 3 * 4];
        rgba[0..4].copy_from_slice(&[255, 0, 0, 255]);
        let expected = [
            (1u8, (2u32, 3u32), (0u32, 0u32)),
            (2, (2, 3), (1, 0)),
            (3, (2, 3), (1, 2)),
            (4, (2, 3), (0, 2)),
            (5, (3, 2), (0, 0)),
            (6, (3, 2), (2, 0)),
            (7, (3, 2), (2, 1)),
            (8, (3, 2), (0, 1)),
        ];
        for (orient, (ew, eh), (ex, ey)) in expected {
            let (ow, oh, rotated) = apply_orientation(rgba.clone(), 2, 3, orient);
            assert_eq!((ow, oh), (ew, eh), "orientation {orient}");
            let idx = ((ey * ow + ex) * 4) as usize;
            assert_eq!(&rotated[idx..idx + 4], &[255, 0, 0, 255], "orientation {orient}");
        }
    }
}
