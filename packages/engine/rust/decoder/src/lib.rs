//! Bounded decoding for headless exports. The Worker reuses one capped instance.
use image::{ImageDecoder, ImageFormat, ImageReader};
use std::io::Cursor;
use wasm_bindgen::prelude::*;

const MIB: usize = 1 << 20;
const MAX_MEMORY: usize = 16 * MIB;

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

fn jpeg_scaled(natural: (u32, u32), target: (u32, u32), bytes: &[u8], room: usize) -> Result<Option<Vec<u8>>, JsError> {
    use jpeg_decoder::{CodingProcess, Decoder, PixelFormat};

    let mut decoder = Decoder::new(Cursor::new(bytes));
    decoder.read_info()?;
    let info = decoder.info().ok_or_else(|| JsError::new("missing JPEG dimensions"))?;
    if (u32::from(info.width), u32::from(info.height)) != natural {
        return Err(JsError::new("the image size differs from its upload"));
    }
    // jpeg-decoder selects a size meeting either axis. Request each axis in
    // turn so very narrow images still supply enough samples on the long axis.
    let (mut w, mut h) = decoder.scale(target.0 as u16, u16::MAX)?;
    if u32::from(h) < target.1 {
        (w, h) = decoder.scale(u16::MAX, target.1 as u16)?;
    }
    let coded = pixels(w.into(), h.into());
    let coefficients = if info.coding_process == CodingProcess::DctSequential {
        0
    } else {
        pixels(natural.0, natural.1) * 8
    };
    if coded * 8 + coefficients + pixels(target.0, target.1) * 4 > room {
        return Ok(None);
    }
    decoder.set_max_decoding_buffer_size(coded * 4);
    let mut data = decoder.decode()?;
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

/// A missing result asks the host for a smaller level. Invalid input returns an error.
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
        format @ (ImageFormat::Gif | ImageFormat::WebP) => full_image(natural, target, bytes, room, format),
        _ => Err(JsError::new("unsupported image format")),
    }
}
