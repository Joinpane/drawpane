//! The CPU backend: vello_cpu, and the kernels in Rust. What a Worker runs (decision 0040,
//! "The CPU backend for Workers").

use crate::dl::GlassOp;
use crate::exec::{Backend, impl_draw, blend_pixel};
use crate::glass;
use vello_cpu::{Pixmap, RasterizerSettings, RenderContext, RenderMode, RenderSettings, Resources, TargetInit};

impl_draw!(RenderContext);

pub struct Cpu {
    pub main: Pixmap,
    scratch: Pixmap,
    resources: Resources,
    settings: RenderSettings,
    mode: RenderMode,
}

impl Cpu {
    pub fn new(width: u16, height: u16) -> Self {
        Self {
            main: Pixmap::new(width, height),
            scratch: Pixmap::new(1, 1),
            resources: Resources::new(),
            settings: RenderSettings::default(),
            mode: if cfg!(feature = "f32") { RenderMode::OptimizeQuality } else { RenderMode::OptimizeSpeed },
        }
    }
}

impl Backend for Cpu {
    type Scene = RenderContext;

    fn begin(&mut self) -> Result<(), String> {
        self.main.data_as_u8_slice_mut().fill(0);
        Ok(())
    }

    fn scene(&mut self, w: u16, h: u16) -> RenderContext {
        RenderContext::new_with(w, h, self.settings)
    }

    fn render_main(&mut self, scene: &mut RenderContext, band: [i32; 2]) -> Result<(), String> {
        scene.flush();
        if band[1] <= band[0] {
            return Ok(());
        }
        // The band's rows of the page, as a pixmap of their own: the scene is placed so that
        // only they are drawn.
        let w = self.main.width();
        let stride = usize::from(w) * 4;
        let rows = &mut self.main.data_as_u8_slice_mut()[band[0] as usize * stride..band[1] as usize * stride];
        let target = vello_common::pixmap::PixmapMut::new(w, (band[1] - band[0]) as u16, rows).ok_or("band")?;
        let settings = RasterizerSettings {
            render_mode: self.mode,
            target_init: TargetInit::SrcOver,
            offset: (0, -band[0]),
            ..Default::default()
        };
        scene.render_with(target, &mut self.resources, settings);
        Ok(())
    }

    fn render_apart(&mut self, scene: &mut RenderContext, _at: [i32; 2], w: u16, h: u16) -> Result<(), String> {
        scene.flush();
        if self.scratch.width() != w || self.scratch.height() != h {
            self.scratch = Pixmap::new(w, h);
        }
        let settings = RasterizerSettings {
            render_mode: self.mode,
            target_init: TargetInit::Clear(vello_common::color::palette::css::TRANSPARENT),
            ..Default::default()
        };
        scene.render_with(&mut self.scratch, &mut self.resources, settings);
        Ok(())
    }

    fn composite(&mut self, at: [i32; 2], w: u16, h: u16, blend: u32, opacity: f32) -> Result<(), String> {
        let (mw, mh) = (i32::from(self.main.width()), i32::from(self.main.height()));
        let src = self.scratch.data_as_u8_slice();
        let dst = self.main.data_as_u8_slice_mut();
        for y in 0..i32::from(h) {
            let dy = at[1] + y;
            if dy < 0 || dy >= mh {
                continue;
            }
            for x in 0..i32::from(w) {
                let dx = at[0] + x;
                if dx < 0 || dx >= mw {
                    continue;
                }
                let si = ((y * i32::from(w) + x) * 4) as usize;
                let di = ((dy * mw + dx) * 4) as usize;
                if src[si + 3] == 0 {
                    continue;
                }
                let s = [0, 1, 2, 3].map(|i| f32::from(src[si + i]) / 255.0 * opacity);
                let b = [0, 1, 2, 3].map(|i| f32::from(dst[di + i]) / 255.0);
                let o = blend_pixel(blend, s, b);
                for i in 0..4 {
                    dst[di + i] = (o[i].clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
                }
            }
        }
        Ok(())
    }

    fn glass(&mut self, g: &GlassOp) -> Result<(), String> {
        let (w, h) = (self.main.width(), self.main.height());
        glass::glass_cpu(self.main.data_as_u8_slice_mut(), w as usize, h as usize, g);
        Ok(())
    }
}

/// Draws a display list on the CPU; answers the stats.
pub fn render(list: &crate::dl::DisplayList) -> Result<(Pixmap, crate::exec::Stats), String> {
    let mut cpu = Cpu::new(list.width, list.height);
    let stats = crate::exec::run(&mut cpu, list)?;
    Ok((cpu.main, stats))
}
