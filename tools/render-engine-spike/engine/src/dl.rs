//! The display list: what TypeScript hands the engine (decision 0040, "The boundary").
//!
//! A flat little-endian stream of 32-bit words: a header, then ops, each an opcode followed by
//! its operands. Paths are verbs and coordinates; colours are straight RGBA floats; transforms
//! map an op's local units to device pixels. The spike decodes a whole list per frame; the
//! engine proper keeps it retained and patches it by layer (see the decision).

use vello_common::kurbo::{Affine, BezPath, Point};

pub const MAGIC: u32 = u32::from_le_bytes(*b"DPDL");
pub const VERSION: u32 = 1;

pub const OP_FILL: u32 = 1;
pub const OP_STROKE: u32 = 2;
pub const OP_PUSH_CLIP: u32 = 3;
pub const OP_PUSH_GROUP: u32 = 4;
pub const OP_PUSH_BLUR: u32 = 5;
pub const OP_POP: u32 = 6;
pub const OP_PUSH_ISOLATE: u32 = 7;
pub const OP_GLASS: u32 = 8;

/// Figma's linear dodge and burn (decision 0038), which no library blends as Figma does.
pub const BLEND_LINEAR_DODGE: u32 = 100;
pub const BLEND_LINEAR_BURN: u32 = 101;

#[derive(Clone, Copy, Debug)]
pub struct Rgba(pub [f32; 4]);

#[derive(Clone, Debug)]
pub struct StrokeStyle {
    pub width: f32,
    pub join: u32,
    pub cap: u32,
    pub miter: f32,
    pub dashes: Vec<f32>,
    pub dash_offset: f32,
}

/// A glass layer's lens, as `glassParams` (packages/editor/src/glass.ts) gives it, for a box.
#[derive(Clone, Copy, Debug)]
pub struct GlassOp {
    /// Box units to device pixels.
    pub transform: Affine,
    pub w: f32,
    pub h: f32,
    /// Top left, top right, bottom right, bottom left, in box units.
    pub radii: [f32; 4],
    pub refraction: f32,
    pub depth: f32,
    pub dispersion: f32,
    pub frost: f32,
    pub splay: f32,
    pub light: [f32; 2],
    pub intensity: f32,
    pub unit_px: f32,
    pub falloff: f32,
    pub hairline: f32,
    pub front: f32,
    pub front_start: f32,
    pub back: f32,
    pub back_start: f32,
    pub shade: f32,
    pub shade_reach: f32,
    /// Device pixels the glass paints in, and how far around them it reads.
    pub region: [i32; 4],
    pub margin: i32,
}

#[derive(Clone, Debug)]
pub enum Op {
    Fill { transform: Affine, path: BezPath, even_odd: bool, color: Rgba },
    Stroke { transform: Affine, path: BezPath, style: StrokeStyle, color: Rgba },
    PushClip { transform: Affine, path: BezPath, even_odd: bool },
    PushGroup { opacity: f32, blend: u32 },
    PushBlur { sigma: f32 },
    Pop,
    PushIsolate { blend: u32, opacity: f32, bounds: [i32; 4] },
    Glass(GlassOp),
}

pub struct DisplayList {
    pub width: u16,
    pub height: u16,
    pub ops: Vec<Op>,
}

struct Reader<'a> {
    words: &'a [u8],
    at: usize,
}

impl Reader<'_> {
    fn u32(&mut self) -> Result<u32, String> {
        let end = self.at + 4;
        let bytes = self.words.get(self.at..end).ok_or("display list ends early")?;
        self.at = end;
        Ok(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
    }
    fn f32(&mut self) -> Result<f32, String> {
        Ok(f32::from_bits(self.u32()?))
    }
    fn i32(&mut self) -> Result<i32, String> {
        Ok(self.f32()? as i32)
    }
    fn affine(&mut self) -> Result<Affine, String> {
        let mut m = [0.0f64; 6];
        for v in &mut m {
            *v = f64::from(self.f32()?);
        }
        Ok(Affine::new(m))
    }
    fn rgba(&mut self) -> Result<Rgba, String> {
        Ok(Rgba([self.f32()?, self.f32()?, self.f32()?, self.f32()?]))
    }
    fn rect(&mut self) -> Result<[i32; 4], String> {
        Ok([self.i32()?, self.i32()?, self.i32()?, self.i32()?])
    }
    fn point(&mut self) -> Result<Point, String> {
        let x = self.f32()?;
        let y = self.f32()?;
        Ok(Point::new(f64::from(x), f64::from(y)))
    }
    fn path(&mut self) -> Result<BezPath, String> {
        let verbs = self.u32()? as usize;
        let mut path = BezPath::new();
        for _ in 0..verbs {
            // One word per verb keeps the stream aligned; the spike doesn't pack them.
            match self.u32()? {
                0 => path.move_to(self.point()?),
                1 => path.line_to(self.point()?),
                2 => {
                    let a = self.point()?;
                    path.quad_to(a, self.point()?);
                }
                3 => {
                    let a = self.point()?;
                    let b = self.point()?;
                    path.curve_to(a, b, self.point()?);
                }
                4 => path.close_path(),
                v => return Err(format!("unknown path verb {v}")),
            }
        }
        Ok(path)
    }
}

pub fn decode(bytes: &[u8]) -> Result<DisplayList, String> {
    let mut r = Reader { words: bytes, at: 0 };
    if r.u32()? != MAGIC {
        return Err("not a display list".into());
    }
    if r.u32()? != VERSION {
        return Err("display list version".into());
    }
    let width = r.u32()? as u16;
    let height = r.u32()? as u16;
    let mut ops = Vec::new();
    while r.at < bytes.len() {
        let op = match r.u32()? {
            OP_FILL => Op::Fill {
                transform: r.affine()?,
                path: r.path()?,
                even_odd: r.u32()? == 1,
                color: r.rgba()?,
            },
            OP_STROKE => {
                let transform = r.affine()?;
                let path = r.path()?;
                let width = r.f32()?;
                let join = r.u32()?;
                let cap = r.u32()?;
                let miter = r.f32()?;
                let n = r.u32()? as usize;
                let mut dashes = Vec::with_capacity(n);
                for _ in 0..n {
                    dashes.push(r.f32()?);
                }
                let dash_offset = r.f32()?;
                let color = r.rgba()?;
                Op::Stroke {
                    transform,
                    path,
                    style: StrokeStyle { width, join, cap, miter, dashes, dash_offset },
                    color,
                }
            }
            OP_PUSH_CLIP => Op::PushClip {
                transform: r.affine()?,
                path: r.path()?,
                even_odd: r.u32()? == 1,
            },
            OP_PUSH_GROUP => Op::PushGroup { opacity: r.f32()?, blend: r.u32()? },
            OP_PUSH_BLUR => Op::PushBlur { sigma: r.f32()? },
            OP_POP => Op::Pop,
            OP_PUSH_ISOLATE => Op::PushIsolate {
                blend: r.u32()?,
                opacity: r.f32()?,
                bounds: r.rect()?,
            },
            OP_GLASS => Op::Glass(GlassOp {
                transform: r.affine()?,
                w: r.f32()?,
                h: r.f32()?,
                radii: [r.f32()?, r.f32()?, r.f32()?, r.f32()?],
                refraction: r.f32()?,
                depth: r.f32()?,
                dispersion: r.f32()?,
                frost: r.f32()?,
                splay: r.f32()?,
                light: [r.f32()?, r.f32()?],
                intensity: r.f32()?,
                unit_px: r.f32()?,
                falloff: r.f32()?,
                hairline: r.f32()?,
                front: r.f32()?,
                front_start: r.f32()?,
                back: r.f32()?,
                back_start: r.f32()?,
                shade: r.f32()?,
                shade_reach: r.f32()?,
                region: r.rect()?,
                margin: r.i32()?,
            }),
            other => return Err(format!("unknown op {other}")),
        };
        ops.push(op);
    }
    Ok(DisplayList { width, height, ops })
}
