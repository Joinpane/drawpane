//! The CPU backend: vello_cpu into a target of premultiplied RGBA8 rows. What a Worker runs, and
//! the reference the GPU is held to.
//!
//! The target is a tile: `cols` × `rows` of the frame from device pixel `origin`, so a large
//! export renders a tile at a time in bounded memory (`Engine::render_band`). A whole frame is
//! one tile. The scene is always the whole frame's size, so geometry lands on the same
//! coordinates whichever tile is drawn, and tiles are bit-identical to a whole frame.

use crate::error::{EngineError, Result};
use crate::exec::{Backend, GlyphMask, IRect, ImageView, Open, impl_draw};
use crate::images::{self, Level};
use crate::kernels;
use crate::masks::{self, MaskCache, MaskKey};
use std::collections::HashMap;
use std::sync::Arc;
use vello_common::kurbo::BezPath;
use vello_common::paint::ImageSource;
use vello_common::peniko::{Fill, ImageAlphaType};
use vello_common::pixmap::PixelMetadata;
use vello_cpu::{Pixmap, RasterizerSettings, RenderContext, RenderMode, Resources, TargetInit};

impl_draw!(RenderContext);

fn pixmap(width: u32, height: u32, pixels: Vec<u8>) -> Pixmap {
    Pixmap::from_parts(
        pixels,
        width as u16,
        height as u16,
        PixelMetadata {
            may_have_transparency: true,
            alpha_type: ImageAlphaType::AlphaPremultiplied,
        },
    )
}

/// The loading placeholder: two greys in 8-pixel cells (the canvas renderer's `PLACEHOLDER`).
pub fn checker_pixels() -> Vec<u8> {
    let (light, dark) = ([0xec, 0xec, 0xea, 0xff], [0xdf, 0xdf, 0xdc, 0xff]);
    let mut out = Vec::with_capacity(16 * 16 * 4);
    for y in 0..16 {
        for x in 0..16 {
            out.extend_from_slice(if (x < 8) == (y < 8) { &dark } else { &light });
        }
    }
    out
}

pub struct Cpu {
    pub target: Pixmap,
    /// The device pixel the target's top left is.
    pub origin: (i32, i32),
    scene: RenderContext,
    resources: Resources,
    /// Rasterises glyph masks.
    raster: masks::Rasterizer,
    images: HashMap<u32, Vec<Arc<Pixmap>>>,
    image_bytes: usize,
    /// Temporary diamond-gradient raster bytes retained during the current tile's scene build.
    diamond_bytes: usize,
    /// Upper bound on retained diamond-gradient raster bytes for the current tile.
    diamond_budget: usize,
    pub masks: MaskCache<Arc<Pixmap>>,
    mask_side: u32,
    checker: Arc<Pixmap>,
    /// Shareable CPU blur pyramids, reused across equal inputs within a frame.
    pub blur: crate::blur::CpuBlurCache,
    /// How far the target extends past the band each way, for readers' reach: kernels may read
    /// past the band's edge, never past the target's.
    pub halo: i32,
}

impl Cpu {
    pub fn new(mask_bytes: usize, mask_side: u32) -> Self {
        Self {
            target: Pixmap::new(1, 1),
            origin: (0, 0),
            scene: RenderContext::new(1, 1),
            resources: Resources::new(),
            raster: masks::Rasterizer::default(),
            images: HashMap::new(),
            image_bytes: 0,
            diamond_bytes: 0,
            diamond_budget: usize::MAX,
            masks: MaskCache::new(mask_bytes),
            mask_side,
            checker: Arc::new(pixmap(16, 16, checker_pixels())),
            blur: crate::blur::CpuBlurCache::new(mask_bytes.clamp(1 << 20, 4 << 20)),
            halo: 0,
        }
    }

    pub fn set_diamond_budget(&mut self, budget: usize) {
        self.diamond_budget = budget;
    }

    pub fn image_bytes(&self) -> usize {
        self.image_bytes
    }

    /// Bytes an image held under `id` takes (0: none).
    pub fn held_image(&self, id: u32) -> usize {
        self.images
            .get(&id)
            .map_or(0, |l| l.iter().map(|p| p.data_as_u8_slice().len()).sum())
    }

    pub fn put_image(&mut self, id: u32, levels: &[Level], budget: usize) -> Result<()> {
        let bytes = images::bytes(levels);
        let freed = self
            .images
            .get(&id)
            .map_or(0, |l| l.iter().map(|p| p.data_as_u8_slice().len()).sum());
        if self.image_bytes - freed + bytes > budget {
            return Err(EngineError::limit("images over their budget"));
        }
        let pixmaps = levels
            .iter()
            .map(|l| Arc::new(pixmap(l.width, l.height, l.pixels.clone())))
            .collect();
        self.images.insert(id, pixmaps);
        self.image_bytes = self.image_bytes - freed + bytes;
        Ok(())
    }

    pub fn drop_image(&mut self, id: u32) {
        if let Some(l) = self.images.remove(&id) {
            self.image_bytes -= l.iter().map(|p| p.data_as_u8_slice().len()).sum::<usize>();
        }
    }

    /// Starts a frame (or a tile of one): a scene the whole frame's size, and a target of just
    /// `area`, filled with `background` (premultiplied RGBA8).
    pub fn begin(&mut self, width: u16, height: u16, area: IRect, background: [u8; 4]) {
        let (cols, rows) = ((area.x1 - area.x0).max(1) as u16, (area.y1 - area.y0).max(1) as u16);
        if self.target.width() != cols || self.target.height() != rows {
            self.target = Pixmap::new(cols, rows);
        }
        self.origin = (area.x0, area.y0);
        for p in self.target.data_as_u8_slice_mut().as_chunks_mut::<4>().0.iter_mut() {
            p.copy_from_slice(&background);
        }
        self.scene.reset_and_resize(width, height);
        self.diamond_bytes = 0;
        self.masks.begin_frame();
        self.blur.begin_frame();
    }

    /// Lays the scene drawn since the last flush onto the target.
    fn flush(&mut self) {
        self.scene.flush();
        let settings = RasterizerSettings {
            render_mode: RenderMode::OptimizeSpeed,
            target_init: TargetInit::SrcOver,
            offset: (-self.origin.0, -self.origin.1),
            ..Default::default()
        };
        self.scene.render_with(&mut self.target, &mut self.resources, settings);
    }

    pub fn finish(&mut self) {
        self.flush();
        self.scene.reset();
    }
}

impl Backend for Cpu {
    type Scene = RenderContext;

    fn scene(&mut self) -> &mut RenderContext {
        &mut self.scene
    }

    fn image(&mut self, id: u32, px: f64) -> Option<ImageView> {
        let levels = self.images.get(&id)?;
        let i = images::pick(levels.iter().map(|l| u32::from(l.width())), px);
        let l = levels.get(i)?;
        Some(ImageView {
            source: ImageSource::Pixmap(l.clone()),
            width: u32::from(l.width()),
            height: u32::from(l.height()),
        })
    }

    fn checker(&mut self) -> ImageSource {
        ImageSource::Pixmap(self.checker.clone())
    }

    fn glyph_mask(&mut self, key: MaskKey, path: &BezPath, scale: (f64, f64), phase: (f64, f64)) -> Option<GlyphMask> {
        masks::coverage(
            &mut self.masks,
            &mut self.raster,
            key,
            path,
            scale,
            phase,
            self.mask_side,
        )
    }

    fn run_image(&mut self, w: u16, h: u16, pixels: Vec<u8>) -> Option<ImageSource> {
        Some(ImageSource::Pixmap(Arc::new(pixmap(
            u32::from(w),
            u32::from(h),
            pixels,
        ))))
    }

    fn whole_runs(&self) -> bool {
        true
    }

    fn diamond_gradient(
        &mut self,
        area: IRect,
        device_to_grad: vello_common::kurbo::Affine,
        stops: &[(f32, crate::record::Rgba)],
        alpha: f32,
    ) -> Result<Option<ImageSource>> {
        if area.is_empty() {
            return Ok(None);
        }
        let w = (area.x1 - area.x0).max(1) as usize;
        let h = (area.y1 - area.y0).max(1) as usize;
        let bytes = w.saturating_mul(h).saturating_mul(4);
        let next = self.diamond_bytes.saturating_add(bytes);
        if next > self.diamond_budget {
            return Err(EngineError::limit(format!(
                "diamond gradient rasters need {} MiB in this tile; the CPU budget allows {} MiB",
                next.div_ceil(1 << 20),
                self.diamond_budget >> 20
            )));
        }
        let pm = crate::diamond::render_cpu(area, device_to_grad, stops, alpha);
        self.diamond_bytes = next;
        Ok(Some(ImageSource::Pixmap(Arc::new(pm))))
    }

    fn read(&mut self, kernel: u32, paints: IRect, reads: IRect, open: &[Open]) -> Result<()> {
        if open.iter().any(|o| matches!(o, Open::Layer)) {
            return Err(EngineError::unsupported(
                "a backdrop reader inside a layer that fades as one",
            ));
        }
        // Everything drawn so far is the backdrop: lay it down, run the kernel over the target,
        // and reopen the clips. Clips are clip paths, which don't isolate, so the next scene's
        // source-over lands on the pixels exactly as one scene would have drawn them.
        for _ in open {
            self.scene.pop_clip();
        }
        self.flush();
        self.scene.reset();
        let (w, h) = (i32::from(self.target.width()), i32::from(self.target.height()));
        let halo = (i64::from(reads.x1) - i64::from(paints.x1))
            .max(i64::from(paints.x0) - i64::from(reads.x0))
            .clamp(0, 512) as i32;
        let src = self.target.data_as_u8_slice().to_vec();
        let mut out = src.clone();
        let result = kernels::run(kernel, &src, &mut out, w, h, self.origin, paints, reads, halo);
        if result.is_ok() {
            // What the reader paints goes through the clips it's drawn in, as any paint does:
            // their coverage, drawn in the frame's own coordinates (so a band agrees with the
            // whole frame), mixes its output with what was there.
            let mut clip = RenderContext::new(self.scene.width(), self.scene.height());
            for o in open {
                if let Open::Clip {
                    transform,
                    path,
                    even_odd,
                } = o
                {
                    clip.set_transform(*transform);
                    clip.set_fill_rule(if *even_odd { Fill::EvenOdd } else { Fill::NonZero });
                    clip.push_clip_path(path);
                }
            }
            clip.set_transform(vello_common::kurbo::Affine::IDENTITY);
            clip.set_paint(vello_common::color::palette::css::WHITE);
            clip.fill_rect(&vello_common::kurbo::Rect::new(
                f64::from(paints.x0),
                f64::from(paints.y0),
                f64::from(paints.x1),
                f64::from(paints.y1),
            ));
            for o in open {
                if matches!(o, Open::Clip { .. }) {
                    clip.pop_clip();
                }
            }
            clip.flush();
            let mut mask = Pixmap::new(self.target.width(), self.target.height());
            let settings = RasterizerSettings {
                offset: (-self.origin.0, -self.origin.1),
                ..Default::default()
            };
            clip.render_with(&mut mask, &mut self.resources, settings);
            let m = mask.data_as_u8_slice();
            for ((t, o), k) in self
                .target
                .data_as_u8_slice_mut()
                .as_chunks_mut::<4>()
                .0
                .iter_mut()
                .zip(out.as_chunks::<4>().0.iter())
                .zip(m.as_chunks::<4>().0.iter())
            {
                let a = u32::from(k[3]);
                if a == 0 {
                    continue;
                }
                for c in 0..4 {
                    t[c] = ((u32::from(o[c]) * a + u32::from(t[c]) * (255 - a) + 127) / 255) as u8;
                }
            }
        }
        for o in open {
            if let Open::Clip {
                transform,
                path,
                even_odd,
            } = o
            {
                self.scene.set_transform(*transform);
                self.scene
                    .set_fill_rule(if *even_odd { Fill::EvenOdd } else { Fill::NonZero });
                self.scene.push_clip_path(path);
            }
        }
        result
    }
}
