//! Reading the display list's wire format: little-endian words, every read checked, every float
//! required finite. The format is specified in docs/decisions/0040-display-list.md and written
//! by `packages/engine/src/wire.ts`.

use crate::error::{EngineError, Result};
use vello_common::kurbo::{Affine, BezPath, Point};

pub const MAGIC: u32 = u32::from_le_bytes(*b"DPDL");
/// A change to the major version breaks old readers; the engine refuses other majors.
pub const MAJOR: u16 = 1;
/// Minor versions add commands or kinds; the engine reads lists up to its own minor.
pub const MINOR: u16 = 1;

pub struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> Reader<'a> {
    pub fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, at: 0 }
    }

    pub fn at(&self) -> usize {
        self.at
    }

    pub fn done(&self) -> bool {
        self.at >= self.bytes.len()
    }

    /// The bytes not read yet, without reading them.
    pub fn rest(&self) -> &'a [u8] {
        self.bytes.get(self.at..).unwrap_or(&[])
    }

    pub fn remaining(&self) -> usize {
        self.bytes.len().saturating_sub(self.at)
    }

    fn take(&mut self, n: usize) -> Result<&'a [u8]> {
        let end = self
            .at
            .checked_add(n)
            .ok_or_else(|| EngineError::malformed("length overflow"))?;
        let s = self
            .bytes
            .get(self.at..end)
            .ok_or_else(|| EngineError::malformed(format!("display list ends early at byte {}", self.at)))?;
        self.at = end;
        Ok(s)
    }

    pub fn u32(&mut self) -> Result<u32> {
        let b = self.take(4)?;
        Ok(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }

    pub fn u16(&mut self) -> Result<u16> {
        let b = self.take(2)?;
        Ok(u16::from_le_bytes([b[0], b[1]]))
    }

    pub fn bytes(&mut self, n: usize) -> Result<&'a [u8]> {
        self.take(n)
    }

    /// The next `n` bytes as a reader of their own: a command is read from one, so nothing in it
    /// can read (or allocate for) bytes past its own length.
    pub fn sub(&mut self, n: usize) -> Result<Reader<'a>> {
        Ok(Reader::new(self.take(n)?))
    }

    /// A count of items each at least `min_bytes` long, refused above `max`, or when that many
    /// couldn't fit in what's left, before anything is allocated for it.
    pub fn count(&mut self, max: usize, what: &str, min_bytes: usize) -> Result<usize> {
        let n = self.u32()? as usize;
        if n > max {
            return Err(EngineError::limit(format!("{what}: {n} is more than {max}")));
        }
        if n.saturating_mul(min_bytes.max(1)) > self.remaining() {
            return Err(EngineError::malformed(format!(
                "{what}: {n} items in {} bytes",
                self.remaining()
            )));
        }
        Ok(n)
    }

    pub fn f32(&mut self) -> Result<f32> {
        let v = f32::from_bits(self.u32()?);
        if !v.is_finite() {
            return Err(EngineError::malformed(format!(
                "a number that isn't finite at byte {}",
                self.at - 4
            )));
        }
        Ok(v)
    }

    /// A float that must not be negative.
    pub fn f32_nonneg(&mut self) -> Result<f32> {
        let v = self.f32()?;
        if v < 0.0 {
            return Err(EngineError::malformed(format!(
                "a negative number at byte {}",
                self.at - 4
            )));
        }
        Ok(v)
    }

    pub fn f64(&mut self) -> Result<f64> {
        let b = self.take(8)?;
        let v = f64::from_le_bytes([b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7]]);
        if !v.is_finite() {
            return Err(EngineError::malformed(format!(
                "a number that isn't finite at byte {}",
                self.at - 8
            )));
        }
        Ok(v)
    }

    pub fn affine(&mut self) -> Result<Affine> {
        let mut m = [0.0f64; 6];
        for v in &mut m {
            *v = self.f64()?;
        }
        Ok(Affine::new(m))
    }

    pub fn rgba(&mut self) -> Result<[f32; 4]> {
        let mut c = [0.0f32; 4];
        for v in &mut c {
            *v = self.f32()?.clamp(0.0, 1.0);
        }
        Ok(c)
    }

    /// A path: its verb count, coordinate count, the verbs a byte each (padded to four), then
    /// the coordinates. Verbs: 0 move, 1 line, 2 quad, 3 cubic, 4 close.
    pub fn path(&mut self, max_verbs: usize) -> Result<BezPath> {
        let verbs = self.count(max_verbs.saturating_mul(4), "path verbs", 1)?;
        if verbs > max_verbs {
            return Err(EngineError::limit(format!("a path of {verbs} verbs")));
        }
        let coords = self.u32()? as usize;
        let verb_bytes = self.take(verbs.next_multiple_of(4))?;
        if coords > self.remaining() / 4 {
            return Err(EngineError::malformed("path coordinates past the end"));
        }
        let mut path = BezPath::new();
        let mut used = 0usize;
        let mut started = false;
        for &v in &verb_bytes[..verbs] {
            let need = match v {
                0 | 1 => 2,
                2 => 4,
                3 => 6,
                4 => 0,
                _ => return Err(EngineError::malformed(format!("unknown path verb {v}"))),
            };
            used += need;
            if used > coords {
                return Err(EngineError::malformed("path verbs need more coordinates than it has"));
            }
            let mut p = || -> Result<Point> {
                let x = self.f32()?;
                let y = self.f32()?;
                Ok(Point::new(f64::from(x), f64::from(y)))
            };
            match v {
                0 => {
                    path.move_to(p()?);
                    started = true;
                }
                // A segment before any move starts from the origin, as a canvas path does not: refuse it.
                _ if !started => return Err(EngineError::malformed("a path segment before its first move")),
                1 => path.line_to(p()?),
                2 => {
                    let a = p()?;
                    path.quad_to(a, p()?);
                }
                3 => {
                    let a = p()?;
                    let b = p()?;
                    path.curve_to(a, b, p()?);
                }
                _ => path.close_path(),
            }
        }
        if used != coords {
            return Err(EngineError::malformed("path has coordinates its verbs don't use"));
        }
        Ok(path)
    }
}
