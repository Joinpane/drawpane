//! A PNG written band by band (review item 5): rows go in as they're rendered and compressed
//! bytes come out as they're made, so an export's memory is one band and the compressor's
//! window, never the whole picture. 8-bit RGBA, each row filtered by `Sub`, one IDAT chunk per
//! flush.

use crate::error::{EngineError, ErrorCode, Result};
use miniz_oxide::deflate::core::{
    CompressorOxide, TDEFLFlush, TDEFLStatus, compress, create_comp_flags_from_zip_params,
};

fn crc32(chunks: &[&[u8]]) -> u32 {
    let mut crc = 0xffff_ffffu32;
    for data in chunks {
        for &b in *data {
            crc ^= u32::from(b);
            for _ in 0..8 {
                crc = if crc & 1 != 0 {
                    (crc >> 1) ^ 0xedb8_8320
                } else {
                    crc >> 1
                };
            }
        }
    }
    !crc
}

fn chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    out.extend_from_slice(kind);
    out.extend_from_slice(data);
    out.extend_from_slice(&crc32(&[kind, data]).to_be_bytes());
}

pub struct BandPng {
    pub width: u32,
    pub height: u32,
    pub rows_written: u32,
    compressor: Box<CompressorOxide>,
    /// Bytes ready to take.
    out: Vec<u8>,
    /// Compressed bytes not yet in an IDAT chunk.
    pending: Vec<u8>,
    scratch: Vec<u8>,
}

impl BandPng {
    pub fn new(width: u32, height: u32, max_side: u32) -> Result<Self> {
        if width == 0 || height == 0 || width > max_side || height > max_side {
            return Err(EngineError::limit(format!(
                "a PNG {width} × {height} px; the longest side an export may have is {max_side} px"
            )));
        }
        let mut out = b"\x89PNG\r\n\x1a\n".to_vec();
        let mut ihdr = Vec::with_capacity(13);
        ihdr.extend_from_slice(&width.to_be_bytes());
        ihdr.extend_from_slice(&height.to_be_bytes());
        ihdr.extend_from_slice(&[8, 6, 0, 0, 0]);
        chunk(&mut out, b"IHDR", &ihdr);
        Ok(Self {
            width,
            height,
            rows_written: 0,
            compressor: Box::new(CompressorOxide::new(create_comp_flags_from_zip_params(3, 15, 0))),
            out,
            pending: Vec::new(),
            scratch: vec![0u8; 64 * 1024],
        })
    }

    fn deflate(&mut self, mut input: &[u8], flush: TDEFLFlush) -> Result<()> {
        loop {
            let (status, read, wrote) = compress(&mut self.compressor, input, &mut self.scratch, flush);
            self.pending.extend_from_slice(&self.scratch[..wrote]);
            input = &input[read..];
            match status {
                TDEFLStatus::Done => return Ok(()),
                TDEFLStatus::Okay if input.is_empty() && wrote < self.scratch.len() => return Ok(()),
                TDEFLStatus::Okay => {}
                _ => return Err(EngineError::new(ErrorCode::State, "the PNG compressor failed")),
            }
        }
    }

    /// Adds `rows` rows of straight RGBA8.
    pub fn write_rows(&mut self, rgba: &[u8], rows: u32) -> Result<()> {
        let stride = self.width as usize * 4;
        if rgba.len() != stride * rows as usize || self.rows_written + rows > self.height {
            return Err(EngineError::new(
                ErrorCode::State,
                "PNG rows of the wrong size, or past its height",
            ));
        }
        let mut line = vec![0u8; stride + 1];
        for row in rgba.chunks_exact(stride) {
            line[0] = 1; // Sub
            for i in 0..stride {
                let left = if i >= 4 { row[i - 4] } else { 0 };
                line[i + 1] = row[i].wrapping_sub(left);
            }
            self.deflate(&line, TDEFLFlush::None)?;
            if self.pending.len() >= 32 * 1024 {
                chunk(&mut self.out, b"IDAT", &self.pending);
                self.pending.clear();
            }
        }
        self.rows_written += rows;
        Ok(())
    }

    pub fn take(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.out)
    }

    /// Ends the stream (the rows must all be in): the bytes not yet taken.
    pub fn finish(mut self) -> Vec<u8> {
        if self.deflate(&[], TDEFLFlush::Finish).is_ok() {
            let data = std::mem::take(&mut self.pending);
            chunk(&mut self.out, b"IDAT", &data);
        }
        chunk(&mut self.out, b"IEND", &[]);
        self.out
    }
}
