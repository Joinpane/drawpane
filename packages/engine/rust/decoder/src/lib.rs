//! Bounded decoding for headless exports. The Worker keeps one capped instance per export.
use image::{ImageDecoder, ImageFormat, ImageReader};
use std::io::Cursor;
use wasm_bindgen::prelude::*;

const MIB: usize = 1 << 20;
#[cfg(feature = "wasm")]
const MAX_MEMORY: usize = 16 * MIB;
// Bound total scan work before calling jpeg-decoder, which walks every block of a
// scan even when a tiny crafted file repeats empty SOS markers. Typical progressive
// encoders emit 6 to 18 scans; 256 scans and 32M weighted 8x8 block-scans leave
// generous headroom for real photos up to 8192 px while keeping worst-case wasm CPU
// well below the headless export deadline.
const MAX_JPEG_SCANS: usize = 256;
const MAX_JPEG_SCAN_BLOCKS: u64 = 32_000_000;

#[cfg(feature = "wasm")]
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

fn pixels(w: u32, h: u32) -> usize {
    w as usize * h as usize
}

fn rgba(data: &[u8]) -> [u8; 4] {
    match data {
        [grey] => [*grey, *grey, *grey, 255],
        [grey, alpha] => [*grey, *grey, *grey, *alpha],
        [r, g, b] => [*r, *g, *b, 255],
        [r, g, b, a] => [*r, *g, *b, *a],
        _ => unreachable!("normalized image channels"),
    }
}

/// Accumulates one output row at a time. Bins average premultiplied pixels, then
/// write straight RGBA for the render engine's upload.
struct Resample {
    width: usize,
    source_width: usize,
    output: Vec<u8>,
    sums: Vec<[u64; 5]>,
}

impl Resample {
    fn new(source_width: u32, width: u32, height: u32) -> Self {
        Self {
            width: width as usize,
            source_width: source_width as usize,
            output: Vec::with_capacity(pixels(width, height) * 4),
            sums: vec![[0; 5]; width as usize],
        }
    }

    fn row(&mut self, row: &[u8], channels: usize) {
        if self.source_width == self.width && self.sums.is_empty() {
            if channels == 4 {
                self.output.extend_from_slice(row);
            } else {
                for pixel in row.chunks_exact(channels) {
                    self.output.extend_from_slice(&rgba(pixel));
                }
            }
            return;
        }
        for (x, pixel) in row.chunks_exact(channels).enumerate() {
            let [r, g, b, a] = rgba(pixel).map(u64::from);
            let sum = &mut self.sums[x * self.width / self.source_width];
            sum[0] += r * a;
            sum[1] += g * a;
            sum[2] += b * a;
            sum[3] += a;
            sum[4] += 1;
        }
    }

    fn finish_row(&mut self) {
        for sum in &mut self.sums {
            let [r, g, b, a, n] = *sum;
            let channel = |v: u64| (v + a / 2).checked_div(a).unwrap_or_default() as u8;
            self.output
                .extend_from_slice(&[channel(r), channel(g), channel(b), ((a + n / 2) / n) as u8]);
            *sum = [0; 5];
        }
    }
}

fn png_rows(natural: (u32, u32), target: (u32, u32), bytes: &[u8], room: usize) -> Result<Option<Vec<u8>>, JsError> {
    let (w, h) = target;
    let mut decode = png::Decoder::new_with_limits(Cursor::new(bytes), png::Limits { bytes: MIB });
    decode.set_transformations(png::Transformations::normalize_to_color8());
    let mut reader = decode.read_info()?;
    if reader.info().size() != natural {
        return Err(JsError::new("the image size differs from its upload"));
    }
    if reader.info().interlaced {
        return full_image(natural, target, bytes, room, ImageFormat::Png);
    }
    let channels = reader.output_color_type().0.samples();
    let mut out = Resample::new(natural.0, w, h);
    if natural == target {
        out.sums.clear();
    }
    for y in 0..natural.1 {
        let row = reader.next_row()?.ok_or_else(|| JsError::new("incomplete PNG rows"))?;
        out.row(row.data(), channels);
        if natural != target && (y + 1) * h / natural.1 != y * h / natural.1 {
            out.finish_row();
        }
    }
    reader.finish()?;
    Ok(Some(out.output))
}

fn resample(data: &[u8], source: (u32, u32), target: (u32, u32), channels: usize) -> Vec<u8> {
    let mut out = Resample::new(source.0, target.0, target.1);
    if source == target {
        out.sums.clear();
    }
    for (y, row) in data.chunks_exact(source.0 as usize * channels).enumerate() {
        out.row(row, channels);
        if !out.sums.is_empty()
            && (y + 1) * target.1 as usize / source.1 as usize != y * target.1 as usize / source.1 as usize
        {
            out.finish_row();
        }
    }
    out.output
}

fn gif_rows(natural: (u32, u32), target: (u32, u32), bytes: &[u8], room: usize) -> Result<Option<Vec<u8>>, JsError> {
    let mut options = gif::DecodeOptions::new();
    options.check_frame_consistency(true);
    let mut reader = options.read_info(Cursor::new(bytes))?;
    if (u32::from(reader.width()), u32::from(reader.height())) != natural {
        return Err(JsError::new("the image size differs from its upload"));
    }
    let frame = reader
        .next_frame_info()?
        .ok_or_else(|| JsError::new("missing GIF frame"))?;
    let (left, top) = (frame.left as usize, frame.top as usize);
    let (width, height) = (frame.width as usize, frame.height as usize);
    let transparent = frame.transparent;
    // Interlacing needs row order before box filtering. Keep its one-byte indices.
    // Ordinary GIFs only need the current row. Like the previous decoder, draw the first frame.
    let indexed_bytes = if frame.interlaced { width * height } else { 0 };
    let row_bytes = natural.0 as usize * 4;
    let sums_bytes = target.0 as usize * size_of::<[u64; 5]>();
    if width == 0 || height == 0 {
        return Err(JsError::new("empty GIF frame"));
    }
    if indexed_bytes + width + row_bytes + sums_bytes + pixels(target.0, target.1) * 4 > room {
        return Ok(None);
    }
    let palette = reader.palette()?.to_vec();
    let mut indexed = vec![0; indexed_bytes];
    if indexed_bytes > 0 {
        reader.read_into_buffer(&mut indexed)?;
    }
    let mut indices = vec![0; width];
    let mut row = vec![0; row_bytes];
    let mut out = Resample::new(natural.0, target.0, target.1);
    if natural == target {
        out.sums.clear();
    }
    for y in 0..natural.1 as usize {
        if (top..top + height).contains(&y) {
            let indices = if indexed_bytes > 0 {
                &indexed[(y - top) * width..][..width]
            } else {
                if !reader.fill_buffer(&mut indices)? {
                    return Err(JsError::new("incomplete GIF rows"));
                }
                &indices
            };
            let (pixels, _) = row[left * 4..][..width * 4].as_chunks_mut::<4>();
            for (pixel, &index) in pixels.iter_mut().zip(indices) {
                let offset = index as usize * 3;
                if Some(index) == transparent {
                    pixel.fill(0);
                } else {
                    let rgb = palette
                        .get(offset..offset + 3)
                        .ok_or_else(|| JsError::new("invalid GIF palette index"))?;
                    pixel[..3].copy_from_slice(rgb);
                    pixel[3] = 255;
                }
            }
        } else if y == top + height {
            row.fill(0);
        }
        out.row(&row, 4);
        let h = target.1 as usize;
        if !out.sums.is_empty() && (y + 1) * h / natural.1 as usize != y * h / natural.1 as usize {
            out.finish_row();
        }
    }
    Ok(Some(out.output))
}

fn full_image(
    natural: (u32, u32),
    target: (u32, u32),
    bytes: &[u8],
    room: usize,
    format: ImageFormat,
) -> Result<Option<Vec<u8>>, JsError> {
    let scratch = pixels(natural.0, natural.1) * 12;
    if scratch + pixels(target.0, target.1) * 4 > room {
        return Ok(None);
    }
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(natural.0);
    limits.max_image_height = Some(natural.1);
    limits.max_alloc = Some(scratch as u64);
    reader.limits(limits);
    let decoder = reader.into_decoder()?;
    if decoder.dimensions() != natural {
        return Err(JsError::new("the image size differs from its upload"));
    }
    let image = image::DynamicImage::from_decoder(decoder)?.into_rgba8();
    if natural == target {
        Ok(Some(image.into_raw()))
    } else {
        Ok(Some(resample(&image, natural, target, 4)))
    }
}

/// Walks JPEG marker segments from SOI to EOI and checks that total scan work stays
/// within budget. Stops cleanly on truncated or malformed input so `jpeg-decoder`
/// reports the format error instead of panicking or looping.
fn jpeg_within_scan_budget(bytes: &[u8], width: u16, height: u16) -> bool {
    if bytes.get(..2) != Some(&[0xFF, 0xD8]) {
        return true;
    }
    let plane_blocks = u64::from(width).div_ceil(8) * u64::from(height).div_ceil(8);
    let mut pos = 2usize;
    let mut scans = 0usize;
    let mut scan_blocks = 0u64;

    while pos < bytes.len() {
        let Some(offset) = bytes[pos..].iter().position(|&b| b == 0xFF) else {
            break;
        };
        pos += offset + 1;
        while bytes.get(pos) == Some(&0xFF) {
            pos += 1;
        }
        let Some(&marker) = bytes.get(pos) else {
            break;
        };
        pos += 1;

        match marker {
            // Stuffed zero byte and standalone markers with no length field.
            0x00 | 0x01 | 0xD0..=0xD8 => continue,
            // End of image: jpeg-decoder stops decoding here.
            0xD9 => break,
            // Start of scan: read segment length and Ns (component count in scan).
            0xDA => {
                let Some(&[hi, lo, ..]) = bytes.get(pos..) else {
                    break;
                };
                let len = usize::from(u16::from_be_bytes([hi, lo]));
                if len < 2 {
                    break;
                }
                let Some(segment) = bytes.get(pos..).and_then(|rest| rest.get(..len)) else {
                    break;
                };
                let components = segment.get(2).copied().filter(|&n| (1..=4).contains(&n)).unwrap_or(1);
                pos += len;

                scans += 1;
                scan_blocks = scan_blocks.saturating_add(u64::from(components) * plane_blocks);
                if scans > MAX_JPEG_SCANS || scan_blocks > MAX_JPEG_SCAN_BLOCKS {
                    return false;
                }
            }
            // Length-bearing marker (APPn, COM, DQT, DHT, SOFn, DRI, etc.): skip its
            // payload so embedded thumbnails or metadata are not scanned for SOS.
            _ => {
                let Some(&[hi, lo, ..]) = bytes.get(pos..) else {
                    break;
                };
                let len = usize::from(u16::from_be_bytes([hi, lo]));
                if len < 2 || len > bytes.len() - pos {
                    break;
                }
                pos += len;
            }
        }
    }

    true
}

fn jpeg_scaled(natural: (u32, u32), target: (u32, u32), bytes: &[u8], room: usize) -> Result<Option<Vec<u8>>, JsError> {
    use jpeg_decoder::{CodingProcess, Decoder, PixelFormat};

    let mut decoder = Decoder::new(Cursor::new(bytes));
    decoder.read_info()?;
    let info = decoder.info().ok_or_else(|| JsError::new("missing JPEG dimensions"))?;
    if (u32::from(info.width), u32::from(info.height)) != natural {
        return Err(JsError::new("the image size differs from its upload"));
    }
    if !jpeg_within_scan_budget(bytes, info.width, info.height) {
        return Ok(None);
    }
    // jpeg-decoder selects a size meeting either axis. Request each axis in
    // turn so very narrow images still supply enough samples on the long axis.
    let (mut w, mut h) = decoder.scale(target.0 as u16, u16::MAX)?;
    if u32::from(h) < target.1 {
        (w, h) = decoder.scale(u16::MAX, target.1 as u16)?;
    }
    let coded = pixels(w.into(), h.into());
    let coefficients = match info.coding_process {
        CodingProcess::DctSequential | CodingProcess::DctProgressive => decoder.progressive_coefficient_bytes(),
        CodingProcess::Lossless => pixels(natural.0, natural.1) * 8,
    };
    let decode_peak = coded * 8 + coefficients;
    let resample_peak = coded * 4 + pixels(target.0, target.1) * 4 + target.0 as usize * size_of::<[u64; 5]>();
    if decode_peak.max(resample_peak) > room {
        return Ok(None);
    }
    decoder.set_max_decoding_buffer_size(coded * 4);
    let mut data = decoder.decode()?;
    drop(decoder);
    let channels = match info.pixel_format {
        PixelFormat::L8 => 1,
        PixelFormat::RGB24 => 3,
        PixelFormat::CMYK32 => {
            for pixel in data.as_chunks_mut::<4>().0 {
                let light = 255 - u16::from(pixel[3]);
                for channel in &mut pixel[..3] {
                    *channel = ((255 - u16::from(*channel)) * light / 255) as u8;
                }
                pixel[3] = 255;
            }
            4
        }
        PixelFormat::L16 => return Err(JsError::new("unsupported JPEG color space")),
    };
    Ok(Some(resample(&data, (w.into(), h.into()), target, channels)))
}

/// Decodes and resamples an image into straight RGBA8 inside `budget` bytes of working memory.
/// Returns `Ok(None)` when the image or target exceeds memory or scan budgets.
pub fn decode_rgba(
    natural: (u32, u32),
    target: (u32, u32),
    bytes: &[u8],
    budget: usize,
    max_natural_side: u32,
) -> Result<Option<Vec<u8>>, String> {
    let (width, height) = natural;
    let (output_width, output_height) = target;
    if width == 0
        || height == 0
        || width.max(height) > max_natural_side
        || output_width == 0
        || output_height == 0
        || output_width > width
        || output_height > height
    {
        return Err("image dimensions exceed the decoder's limit".into());
    }
    let room = budget.saturating_sub(bytes.len() + 2 * MIB);
    if pixels(output_width, output_height) * 4 > room {
        return Ok(None);
    }
    let format = image::guess_format(bytes).map_err(|e| e.to_string())?;
    let result = match format {
        ImageFormat::Png => png_rows(natural, target, bytes, room),
        ImageFormat::Jpeg => jpeg_scaled(natural, target, bytes, room),
        ImageFormat::Gif => gif_rows(natural, target, bytes, room),
        ImageFormat::WebP => full_image(natural, target, bytes, room, ImageFormat::WebP),
        _ => return Err("unsupported image format".into()),
    };
    result.map_err(|e| format!("{e:?}"))
}

/// A missing result asks the host for a smaller level. Invalid input returns an error.
#[cfg(feature = "wasm")]
#[wasm_bindgen(js_name = decodeImage)]
pub fn decode_image(
    width: u32,
    height: u32,
    output_width: u32,
    output_height: u32,
    bytes: &[u8],
    budget: u32,
) -> Result<Option<Vec<u8>>, JsError> {
    let natural = (width, height);
    let target = (output_width, output_height);
    if width.max(height) > 8192
        || output_width == 0
        || output_height == 0
        || output_width > width
        || output_height > height
    {
        return Err(JsError::new("image dimensions exceed the decoder's limit"));
    }
    let room = (budget as usize).min(MAX_MEMORY).saturating_sub(bytes.len() + 2 * MIB);
    if pixels(output_width, output_height) * 4 > room {
        return Ok(None);
    }
    match image::guess_format(bytes)? {
        ImageFormat::Png => png_rows(natural, target, bytes, room),
        ImageFormat::Jpeg => jpeg_scaled(natural, target, bytes, room),
        ImageFormat::Gif => gif_rows(natural, target, bytes, room),
        ImageFormat::WebP => full_image(natural, target, bytes, room, ImageFormat::WebP),
        _ => Err(JsError::new("unsupported image format")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Crafts a valid grayscale progressive JPEG with one initial DC scan followed by
    /// `extra_scans` empty DC refinement scans, matching the review's CPU-exhaustion repro.
    fn crafted_progressive_grayscale(width: u16, height: u16, extra_scans: usize) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(128 + extra_scans * 10);
        bytes.extend_from_slice(&[0xFF, 0xD8]); // SOI
        // DQT (table 0, all 1s)
        bytes.extend_from_slice(&[0xFF, 0xDB, 0x00, 0x43, 0x00]);
        bytes.extend_from_slice(&[1u8; 64]);
        // SOF2 (progressive, 8-bit, 1 component, 1x1 sampling)
        bytes.extend_from_slice(&[0xFF, 0xC2, 0x00, 0x0B, 0x08]);
        bytes.extend_from_slice(&height.to_be_bytes());
        bytes.extend_from_slice(&width.to_be_bytes());
        bytes.extend_from_slice(&[0x01, 0x01, 0x11, 0x00]);
        // DHT (DC table 0 with one 1-bit symbol 0)
        bytes.extend_from_slice(&[0xFF, 0xC4, 0x00, 0x14, 0x00, 0x01]);
        bytes.extend_from_slice(&[0u8; 15]);
        bytes.push(0x00);
        // Initial DC scan (Ss=0, Se=0, Ah=0, Al=1)
        bytes.extend_from_slice(&[0xFF, 0xDA, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x00, 0x01]);
        // Repeated empty DC refinement scans (Ss=0, Se=0, Ah=1, Al=0)
        for _ in 0..extra_scans {
            bytes.extend_from_slice(&[0xFF, 0xDA, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x00, 0x10]);
        }
        bytes.extend_from_slice(&[0xFF, 0xD9]); // EOI
        bytes
    }

    #[test]
    fn progressive_phone_photo_matches_unmodified_jpeg_at_each_reduced_scale() {
        let bytes = include_bytes!("../../../../../apps/worker/test/fixtures/progressive-4032.jpg");
        assert!(jpeg_within_scan_budget(bytes, 4032, 3024));
        for (width, height) in [(504, 378), (1008, 756), (2016, 1512)] {
            let mut dense = jpeg_decoder_reference::Decoder::new(bytes.as_slice());
            assert_eq!(dense.scale(width, height).unwrap(), (width, height));
            assert_eq!(
                dense.info().unwrap().coding_process,
                jpeg_decoder_reference::CodingProcess::DctProgressive
            );
            let mut compact = jpeg_decoder::Decoder::new(bytes.as_slice());
            assert_eq!(compact.scale(width, height).unwrap(), (width, height));
            assert!(
                compact.decode().unwrap() == dense.decode().unwrap(),
                "progressive pixels differ at {width} × {height}"
            );
        }
    }

    #[test]
    fn textured_progressive_fixtures_match_unmodified_jpeg_at_all_scales() {
        let fixtures: &[(&str, &[u8])] = &[
            ("4:2:0", include_bytes!("../test-fixtures/prog_2x2.jpg")),
            ("4:2:2", include_bytes!("../test-fixtures/prog_2x1.jpg")),
            ("4:4:4", include_bytes!("../test-fixtures/prog_1x1.jpg")),
            ("grayscale", include_bytes!("../test-fixtures/prog_gray.jpg")),
            ("cmyk", include_bytes!("../test-fixtures/prog_cmyk.jpg")),
            ("restart-interval", include_bytes!("../test-fixtures/prog_rst3.jpg")),
        ];
        // Odd 257x131 fixtures exercise 1/8, 1/4, 1/2, and 1/1 scales plus partial MCUs.
        let scales = [(33u16, 17u16), (65, 33), (129, 66), (257, 131)];
        for &(name, bytes) in fixtures {
            assert!(jpeg_within_scan_budget(bytes, 257, 131), "{name} exceeded scan budget");
            for (req_w, req_h) in scales {
                let mut dense = jpeg_decoder_reference::Decoder::new(bytes);
                let expected_size = dense.scale(req_w, req_h).unwrap();
                assert_eq!(
                    dense.info().unwrap().coding_process,
                    jpeg_decoder_reference::CodingProcess::DctProgressive,
                    "{name} is not progressive"
                );
                let mut compact = jpeg_decoder::Decoder::new(bytes);
                assert_eq!(compact.scale(req_w, req_h).unwrap(), expected_size);
                assert!(
                    compact.decode().unwrap() == dense.decode().unwrap(),
                    "{name} pixels differ at requested {req_w}x{req_h}"
                );
            }
            // Also verify the full decode_image entry point (including CMYK conversion).
            let rgba = decode_image(257, 131, 65, 33, bytes, MAX_MEMORY as u32)
                .unwrap()
                .expect("textured fixture should fit within memory and scan budgets");
            assert_eq!(rgba.len(), 65 * 33 * 4, "{name} output length mismatch");
        }
    }

    #[test]
    fn refuses_many_scan_progressive_jpeg_through_budget_path() {
        // 7000x7000 with 1,000 extra empty scans (~10 KB, 766M block-scans).
        let attack = crafted_progressive_grayscale(7000, 7000, 1000);
        assert!(attack.len() < 12_000);
        assert!(!jpeg_within_scan_budget(&attack, 7000, 7000));
        let refused = decode_image(7000, 7000, 875, 875, &attack, MAX_MEMORY as u32).unwrap();
        assert!(refused.is_none(), "expected Ok(None) refusal for 1000-scan attack file");

        // 7000x7000 with 100 extra empty scans (77.3M block-scans) is also refused.
        let medium = crafted_progressive_grayscale(7000, 7000, 100);
        assert!(
            decode_image(7000, 7000, 875, 875, &medium, MAX_MEMORY as u32)
                .unwrap()
                .is_none()
        );

        // Tiny image with > MAX_JPEG_SCANS scans is refused by the scan count cap.
        let tiny_many = crafted_progressive_grayscale(16, 16, MAX_JPEG_SCANS);
        assert!(
            decode_image(16, 16, 16, 16, &tiny_many, MAX_MEMORY as u32)
                .unwrap()
                .is_none()
        );

        // Normal multi-scan progressive image within budget still decodes.
        let benign = crafted_progressive_grayscale(64, 64, 9);
        let decoded = decode_image(64, 64, 64, 64, &benign, MAX_MEMORY as u32).unwrap();
        assert_eq!(decoded.map(|v| v.len()), Some(64 * 64 * 4));
    }

    #[test]
    fn marker_walk_skips_metadata_handles_fill_bytes_and_never_panics_on_corrupt_input() {
        // An APP1 segment containing embedded thumbnail SOS and EOI bytes must be skipped
        // cleanly, while real SOS markers after it (including with 0xFF fill bytes) are counted.
        let mut with_app1 = vec![0xFF, 0xD8];
        let mut app1_payload = vec![0xFF, 0xD9]; // fake EOI inside APP1
        for _ in 0..300 {
            app1_payload.extend_from_slice(&[0xFF, 0xDA, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x00, 0x10]);
        }
        let app1_len = (app1_payload.len() + 2) as u16;
        with_app1.extend_from_slice(&[0xFF, 0xE1]);
        with_app1.extend_from_slice(&app1_len.to_be_bytes());
        with_app1.extend_from_slice(&app1_payload);
        // One real SOS after APP1, with stuffed 0xFF 0x00 and RST0 inside entropy data.
        with_app1.extend_from_slice(&[0xFF, 0xDA, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00]);
        with_app1.extend_from_slice(&[0xFF, 0x00, 0x12, 0xFF, 0xD0, 0x34]);
        with_app1.extend_from_slice(&[0xFF, 0xD9]);
        assert!(jpeg_within_scan_budget(&with_app1, 7000, 7000));

        // 0xFF fill bytes before SOS must still be counted as scans.
        let mut with_fills = vec![0xFF, 0xD8];
        for _ in 0..60 {
            with_fills.extend_from_slice(&[0xFF, 0xFF, 0xFF, 0xDA, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x00, 0x10]);
        }
        with_fills.extend_from_slice(&[0xFF, 0xD9]);
        assert!(!jpeg_within_scan_budget(&with_fills, 7000, 7000));

        // Truncated and corrupt streams must stop cleanly without panicking or looping.
        let corrupt_cases: &[&[u8]] = &[
            &[],
            &[0xFF],
            &[0xFF, 0xD8],
            &[0xFF, 0xD8, 0xFF],
            &[0xFF, 0xD8, 0xFF, 0xFF, 0xFF],
            &[0xFF, 0xD8, 0xFF, 0xDA],
            &[0xFF, 0xD8, 0xFF, 0xDA, 0x00],
            &[0xFF, 0xD8, 0xFF, 0xDA, 0x00, 0x00],
            &[0xFF, 0xD8, 0xFF, 0xDA, 0x00, 0x01],
            &[0xFF, 0xD8, 0xFF, 0xDA, 0x00, 0x02],
            &[0xFF, 0xD8, 0xFF, 0xDA, 0xFF, 0xFF],
            &[0xFF, 0xD8, 0xFF, 0xE1, 0x00, 0x00, 0xFF, 0xDA],
            &[0xFF, 0xD8, 0xFF, 0xE1, 0x00, 0x01, 0xFF, 0xDA],
            &[0xFF, 0xD8, 0xFF, 0xE1, 0xFF, 0xFF],
            &[0xFF, 0xD8, 0xFF, 0x00, 0xFF, 0x01, 0xFF, 0xD0, 0xFF, 0xD8],
            &[0x00, 0x01, 0x02, 0x03],
        ];
        for case in corrupt_cases {
            let _ = jpeg_within_scan_budget(case, 7000, 7000);
        }
    }
}
