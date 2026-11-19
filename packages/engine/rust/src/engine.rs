//! The engine, without the WebAssembly boundary (`lib.rs` wraps it): the render graph, the CPU
//! backend and, in the browser build, the GPU backend.

use crate::cpu::Cpu;
use crate::error::{EngineError, ErrorCode, Result};
use crate::exec::{self, DrawStats, Frame, IRect};
use crate::images;
use crate::limits::Limits;
use crate::masks::MaskStats;
use crate::store::{Applied, Store};
use vello_common::kurbo::Affine;

/// Where the page is on the device: a page point p lands at `(p × zoom + (x, y)) × dpr`, as the
/// canvas renderer places it (`render.ts`, `place`).
#[derive(Clone, Copy, Debug)]
pub struct Camera {
    pub zoom: f64,
    pub x: f64,
    pub y: f64,
    pub dpr: f64,
}

impl Camera {
    pub fn view(&self) -> Affine {
        let z = self.zoom * self.dpr;
        Affine::new([z, 0.0, 0.0, z, self.x * self.dpr, self.y * self.dpr])
    }
    fn check(&self) -> Result<()> {
        let ok =
            [self.zoom, self.x, self.y, self.dpr].iter().all(|v| v.is_finite()) && self.zoom > 0.0 && self.dpr > 0.0;
        if ok {
            Ok(())
        } else {
            Err(EngineError::malformed("a camera that isn't finite and positive"))
        }
    }
}

/// Straight RGBA floats as premultiplied RGBA8.
pub fn premultiply(c: [f32; 4]) -> [u8; 4] {
    let a = c[3].clamp(0.0, 1.0);
    let q = |v: f32| (v.clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
    [q(c[0] * a), q(c[1] * a), q(c[2] * a), q(a)]
}

/// Premultiplied RGBA8 to straight, in place (as a PNG or `ImageData` holds pixels).
pub fn unpremultiply(px: &mut [u8]) {
    for p in px.as_chunks_mut::<4>().0.iter_mut() {
        let a = u32::from(p[3]);
        if a != 0 && a != 255 {
            for c in &mut p[..3] {
                *c = ((u32::from(*c) * 255 + a / 2) / a).min(255) as u8;
            }
        }
    }
}

#[derive(Default, Clone, Copy, Debug)]
pub struct FrameStats {
    pub draw: DrawStats,
    pub masks: MaskStats,
}

pub struct Engine {
    pub store: Store,
    pub cpu: Cpu,
    /// The band being exported.
    band: Vec<u8>,
    #[cfg(feature = "gpu")]
    pub gpu: Option<crate::gpu::Gpu>,
    /// Image uploads kept as levels, so a GPU attached later (or rebuilt after a device loss)
    /// gets them without asking TypeScript again.
    #[cfg(feature = "gpu")]
    pub image_levels: std::collections::HashMap<u32, std::rc::Rc<Vec<images::Level>>>,
}

impl Engine {
    pub fn new(limits: Limits) -> Self {
        Self {
            band: Vec::new(),
            cpu: Cpu::new(limits.glyph_mask_bytes, limits.glyph_mask_side),
            store: Store::new(limits),
            #[cfg(feature = "gpu")]
            gpu: None,
            #[cfg(feature = "gpu")]
            image_levels: std::collections::HashMap::new(),
        }
    }

    pub fn limits(&self) -> &Limits {
        &self.store.limits
    }

    pub fn apply(&mut self, bytes: &[u8]) -> Result<Applied> {
        self.store.apply(bytes)
    }

    pub fn put_image(&mut self, id: u32, width: u32, height: u32, rgba: &[u8], premultiplied: bool) -> Result<()> {
        let limits = self.store.limits;
        let levels = images::levels(width, height, rgba, premultiplied, limits.texture_side)?;
        self.cpu.put_image(id, &levels, limits.image_bytes)?;
        #[cfg(feature = "gpu")]
        {
            let levels = std::rc::Rc::new(levels);
            if let Some(gpu) = self.gpu.as_mut() {
                gpu.put_image(id, &levels, limits.image_bytes)?;
            }
            self.image_levels.insert(id, levels);
        }
        Ok(())
    }

    pub fn drop_image(&mut self, id: u32) {
        self.cpu.drop_image(id);
        #[cfg(feature = "gpu")]
        {
            self.image_levels.remove(&id);
            if let Some(gpu) = self.gpu.as_mut() {
                gpu.drop_image(id);
            }
        }
    }

    fn check_size(&self, width: u32, height: u32) -> Result<()> {
        let max = self.store.limits.texture_side;
        if width == 0 || height == 0 {
            return Err(EngineError::malformed("a frame with no pixels"));
        }
        if width > max || height > max {
            return Err(EngineError::limit(format!(
                "a frame {width} × {height} px; the longest side the engine draws is {max} px"
            )));
        }
        Ok(())
    }

    /// Draws the whole frame on the CPU: premultiplied RGBA8, `width` × `height`.
    pub fn render_cpu(
        &mut self,
        width: u32,
        height: u32,
        camera: Camera,
        background: [f32; 4],
        detail: bool,
    ) -> Result<(&[u8], FrameStats)> {
        self.check_size(width, height)?;
        camera.check()?;
        let (stats, _) = self.cpu_tile(
            width,
            height,
            camera,
            background,
            detail,
            IRect {
                x0: 0,
                y0: 0,
                x1: width as i32,
                y1: height as i32,
            },
        )?;
        Ok((self.cpu.target.data_as_u8_slice(), stats))
    }

    /// Attaches a GPU, uploading the images already held so it can draw everything at once.
    #[cfg(feature = "gpu")]
    pub fn attach_gpu(&mut self, mut gpu: crate::gpu::Gpu) -> Result<()> {
        let budget = self.store.limits.image_bytes;
        for (id, levels) in &self.image_levels {
            gpu.put_image(*id, levels, budget)?;
        }
        self.gpu = Some(gpu);
        Ok(())
    }

    /// Draws the whole frame on the GPU (into its canvas, when it has one).
    #[cfg(feature = "gpu")]
    pub fn render_gpu(
        &mut self,
        width: u32,
        height: u32,
        camera: Camera,
        background: [f32; 4],
        detail: bool,
    ) -> Result<DrawStats> {
        self.check_size(width, height)?;
        camera.check()?;
        let gpu = self
            .gpu
            .as_mut()
            .ok_or_else(|| EngineError::new(ErrorCode::State, "no GPU attached"))?;
        let frame = Frame {
            width: width as u16,
            height: height as u16,
            view: camera.view(),
            detail,
            area: IRect {
                x0: 0,
                y0: 0,
                x1: width as i32,
                y1: height as i32,
            },
        };
        gpu.render(&self.store, &frame, background)
    }

    /// Device pixels the readers on the page may read past where they paint, summed through
    /// readers reading readers (conservatively: every reader's reach added up).
    fn halo(&self, view: Affine) -> Result<i32> {
        let mut total = 0.0f64;
        for id in self.store.readers() {
            let Some(node) = self.store.nodes.get(id) else { continue };
            if let Some(h) = node.record.reads() {
                let m = view * self.store.world(*id);
                // The reach on the device, as a box around a rotated or sheared one grows it,
                // and a pixel each way for rounding to whole pixels.
                let [a, b, c, d, _, _] = m.as_coeffs();
                let reach = f64::from(h) * (a.abs() + c.abs()).max(b.abs() + d.abs());
                total += reach.ceil() + 2.0;
            }
        }
        if total > f64::from(self.store.limits.halo) {
            return Err(EngineError::limit(format!(
                "backdrop readers reach {total:.0} px past a band; the most is {}",
                self.store.limits.halo
            )));
        }
        Ok(total.ceil() as i32)
    }

    /// Draws `area` of a `width` × `height` frame into the CPU target, extended by the readers'
    /// reach each way so what they read is drawn; answers the extended area.
    fn cpu_tile(
        &mut self,
        width: u32,
        height: u32,
        camera: Camera,
        background: [f32; 4],
        detail: bool,
        area: IRect,
    ) -> Result<(FrameStats, IRect)> {
        let view = camera.view();
        let halo = self.halo(view)?;
        let grown = IRect {
            x0: area.x0 - halo,
            y0: area.y0 - halo,
            x1: area.x1 + halo,
            y1: area.y1 + halo,
        }
        .clamp(width as i32, height as i32);
        self.cpu.halo = halo;
        self.cpu
            .begin(width as u16, height as u16, grown, premultiply(background));
        let frame = Frame {
            width: width as u16,
            height: height as u16,
            view,
            detail,
            area: grown,
        };
        let limits = self.store.limits;
        let draw = exec::draw(&self.store, &mut self.cpu, &frame, limits.glyph_mask_side);
        // A scene left part-drawn by a failure is dropped; the next frame starts clean.
        self.cpu.finish();
        Ok((
            FrameStats {
                draw: draw?,
                masks: self.cpu.masks.stats,
            },
            grown,
        ))
    }

    /// Draws one band of a large export: device rows `y0..y0 + rows` of a `width` × `height`
    /// frame, premultiplied RGBA8, `rows` × `width` × 4 bytes. The band is drawn in tiles of at
    /// most `Limits::export_tile` columns (each with the readers' reach around it), so the working set
    /// is a tile, and the band (at most `Limits::band_rows` rows) is the only output held. The
    /// frame's longest side is at most `Limits::texture_side` (8,192 px): larger is refused.
    pub fn render_band(
        &mut self,
        width: u32,
        height: u32,
        camera: Camera,
        background: [f32; 4],
        y0: u32,
        rows: u32,
    ) -> Result<&[u8]> {
        self.check_size(width, height)?;
        camera.check()?;
        if rows == 0 || rows > self.store.limits.band_rows || y0.checked_add(rows).is_none_or(|end| end > height) {
            return Err(EngineError::new(
                ErrorCode::Limit,
                format!(
                    "a band of {rows} rows at {y0} in a frame {height} tall; bands are at most {} rows",
                    self.store.limits.band_rows
                ),
            ));
        }
        let stride = width as usize * 4;
        let mut band = std::mem::take(&mut self.band);
        band.clear();
        band.resize(stride * rows as usize, 0);
        let mut x0 = 0u32;
        let result = (|| {
            while x0 < width {
                let cols = self.store.limits.export_tile.max(1).min(width - x0);
                let area = IRect {
                    x0: x0 as i32,
                    y0: y0 as i32,
                    x1: (x0 + cols) as i32,
                    y1: (y0 + rows) as i32,
                };
                let (_, grown) = self.cpu_tile(width, height, camera, background, false, area)?;
                let tw = (grown.x1 - grown.x0) as usize * 4;
                let px = self.cpu.target.data_as_u8_slice();
                for r in 0..rows as usize {
                    let ty = (y0 as i32 - grown.y0) as usize + r;
                    let from = ty * tw + (x0 as i32 - grown.x0) as usize * 4;
                    let to = r * stride + x0 as usize * 4;
                    let n = cols as usize * 4;
                    band[to..to + n].copy_from_slice(&px[from..from + n]);
                }
                x0 += cols;
            }
            Ok(())
        })();
        self.band = band;
        result.map(|()| self.band.as_slice())
    }

    /// `render_band`, unpremultiplied in place (as a PNG holds pixels): no copy of the band.
    pub fn render_band_straight(
        &mut self,
        width: u32,
        height: u32,
        camera: Camera,
        background: [f32; 4],
        y0: u32,
        rows: u32,
    ) -> Result<&[u8]> {
        self.render_band(width, height, camera, background, y0, rows)?;
        unpremultiply(&mut self.band);
        Ok(self.band.as_slice())
    }
}
