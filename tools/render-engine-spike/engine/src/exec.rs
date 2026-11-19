//! Runs a display list on a backend. The same code drives the CPU and the GPU: Vello's two
//! renderers take the same drawing calls (`vello_cpu::RenderContext` and `vello_gpu::Scene`),
//! and what Vello can't draw as Figma does (glass, linear dodge and burn) is a kernel each
//! backend implements over pixels it has already drawn.
//!
//! A kernel needs the pixels beneath it, so the scene drawn so far is rendered first (a
//! "flush"). The layers open at that point are closed and opened again around it, which is
//! exact for clips (source-over is associative) and refused for anything that isolates.

use crate::dl::{BLEND_LINEAR_BURN, BLEND_LINEAR_DODGE, DisplayList, GlassOp, Op, Rgba};
use vello_common::filter_effects::{EdgeMode, Filter, FilterPrimitive};
use vello_common::kurbo::{Affine, BezPath, Cap, Join, Shape, Stroke};
use vello_common::peniko::{BlendMode, Compose, Fill, Mix};

/// What Vello's two scene types share, as the executor uses it.
pub trait Draw {
    fn set_transform(&mut self, t: Affine);
    fn set_color(&mut self, c: Rgba);
    fn set_fill_rule(&mut self, rule: Fill);
    fn set_stroke(&mut self, s: Stroke);
    fn fill_path(&mut self, p: &BezPath);
    fn stroke_path(&mut self, p: &BezPath);
    fn push_clip_path(&mut self, p: &BezPath);
    fn pop_clip(&mut self);
    fn reset(&mut self);
    fn push_layer(&mut self, blend: BlendMode, opacity: f32);
    fn push_filter_layer(&mut self, f: Filter);
    fn pop_layer(&mut self);
}

macro_rules! impl_draw {
    ($t:ty) => {
        impl crate::exec::Draw for $t {
            fn set_transform(&mut self, t: vello_common::kurbo::Affine) {
                <$t>::set_transform(self, t);
            }
            fn set_color(&mut self, c: crate::dl::Rgba) {
                let [r, g, b, a] = c.0;
                <$t>::set_paint(self, vello_common::color::AlphaColor::<vello_common::color::Srgb>::new([r, g, b, a]));
            }
            fn set_fill_rule(&mut self, rule: vello_common::peniko::Fill) {
                <$t>::set_fill_rule(self, rule);
            }
            fn set_stroke(&mut self, s: vello_common::kurbo::Stroke) {
                <$t>::set_stroke(self, s);
            }
            fn fill_path(&mut self, p: &vello_common::kurbo::BezPath) {
                <$t>::fill_path(self, p);
            }
            fn stroke_path(&mut self, p: &vello_common::kurbo::BezPath) {
                <$t>::stroke_path(self, p);
            }
            fn push_clip_path(&mut self, p: &vello_common::kurbo::BezPath) {
                <$t>::push_clip_path(self, p);
            }
            fn pop_clip(&mut self) {
                <$t>::pop_clip(self);
            }
            fn reset(&mut self) {
                <$t>::reset(self);
            }
            fn push_layer(&mut self, blend: vello_common::peniko::BlendMode, opacity: f32) {
                <$t>::push_layer(self, None, Some(blend), Some(opacity), None, None);
            }
            fn push_filter_layer(&mut self, f: vello_common::filter_effects::Filter) {
                <$t>::push_filter_layer(self, f);
            }
            fn pop_layer(&mut self) {
                <$t>::pop_layer(self);
            }
        }
    };
}
pub(crate) use impl_draw;

/// A backend: scenes, the targets they're rendered into, and the kernels.
pub trait Backend {
    type Scene: Draw;
    /// Starts a frame: the page cleared to transparent.
    fn begin(&mut self) -> Result<(), String>;
    /// A scene `w` × `h` device pixels.
    fn scene(&mut self, w: u16, h: u16) -> Self::Scene;
    /// Renders `scene` over the main target (source-over), only in rows `band[0]..band[1]`:
    /// content drawn since the last flush lies there, and a renderer that walks every tile of
    /// its target (vello_cpu does, even for an empty scene: 5 ms for this board natively)
    /// costs what the band does, not the page.
    fn render_main(&mut self, scene: &mut Self::Scene, band: [i32; 2]) -> Result<(), String>;
    /// Renders `scene` alone (over transparency) into a scratch picture `w` × `h`, which lies
    /// at `at` in the page.
    fn render_apart(&mut self, scene: &mut Self::Scene, at: [i32; 2], w: u16, h: u16) -> Result<(), String>;
    /// Blends the scratch picture into the main target at `at`, by Figma's rule for `blend`.
    fn composite(&mut self, at: [i32; 2], w: u16, h: u16, blend: u32, opacity: f32) -> Result<(), String>;
    /// Draws a glass lens into the main target from what it holds there.
    fn glass(&mut self, g: &GlassOp) -> Result<(), String>;
}

fn mix(blend: u32) -> BlendMode {
    let mix = match blend {
        1 => Mix::Multiply,
        2 => Mix::Screen,
        3 => Mix::Overlay,
        4 => Mix::Darken,
        5 => Mix::Lighten,
        6 => Mix::ColorDodge,
        7 => Mix::ColorBurn,
        8 => Mix::HardLight,
        9 => Mix::SoftLight,
        10 => Mix::Difference,
        11 => Mix::Exclusion,
        12 => Mix::Hue,
        13 => Mix::Saturation,
        14 => Mix::Color,
        15 => Mix::Luminosity,
        _ => Mix::Normal,
    };
    BlendMode::new(mix, Compose::SrcOver)
}

#[derive(Clone)]
enum Open {
    Clip { transform: Affine, path: BezPath, even_odd: bool },
    /// A layer that isolates (opacity, blend, blur): no kernel may run inside it in the spike.
    /// `pad` is how far it spreads what's in it (a blur's reach).
    Isolating { pad: f64 },
    /// Drawn apart, then composited by a kernel.
    Apart { blend: u32, opacity: f32, bounds: [i32; 4], depth: usize },
}

/// Counts for the report: how often the scene was interrupted for a kernel.
#[derive(Default, Debug, Clone, Copy)]
pub struct Stats {
    pub ops: u32,
    pub flushes: u32,
    pub apart: u32,
    pub glass: u32,
    /// Milliseconds in each phase: rendering scenes onto the page, drawing layers apart,
    /// the blend kernel, and the glass kernel.
    pub ms_main: f64,
    pub ms_apart: f64,
    pub ms_composite: f64,
    pub ms_glass: f64,
}

#[wasm_bindgen::prelude::wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = performance)]
    fn now() -> f64;
}

/// A clock in milliseconds: the host's `performance.now()` in WebAssembly.
pub fn clock() -> f64 {
    #[cfg(target_arch = "wasm32")]
    {
        now()
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        0.0
    }
}

pub fn run<B: Backend>(backend: &mut B, list: &DisplayList) -> Result<Stats, String> {
    let mut stats = Stats::default();
    backend.begin()?;
    let mut main = backend.scene(list.width, list.height);
    // While a layer is drawn apart: its scene, and the offset of its picture in the main one.
    let mut apart: Option<(B::Scene, [i32; 2])> = None;
    let mut stack: Vec<Open> = Vec::new();
    // Rows the main scene has drawn in since its last flush.
    let mut band: Option<[f64; 2]> = None;
    let rows = |band: &mut Option<[f64; 2]>, stack: &[Open], r: vello_common::kurbo::Rect, grow: f64| {
        let pad: f64 = stack.iter().map(|o| if let Open::Isolating { pad } = o { *pad } else { 0.0 }).sum::<f64>() + grow + 2.0;
        let (y0, y1) = (r.y0 - pad, r.y1 + pad);
        *band = Some(match band {
            Some([a, b]) => [a.min(y0), b.max(y1)],
            None => [y0, y1],
        });
    };
    let height = f64::from(list.height);
    let to_rows = |b: [f64; 2]| [b[0].floor().max(0.0) as i32, b[1].ceil().min(height) as i32];

    fn reopen<S: Draw>(scene: &mut S, stack: &[Open], offset: [i32; 2]) {
        for open in stack {
            if let Open::Clip { transform, path, even_odd } = open {
                scene.set_transform(Affine::translate((-f64::from(offset[0]), -f64::from(offset[1]))) * *transform);
                scene.set_fill_rule(if *even_odd { Fill::EvenOdd } else { Fill::NonZero });
                scene.push_clip_path(path);
            }
        }
    }
    // Renders what's drawn so far, so a kernel can read it, and starts the scene again with
    // the same clips open. Clips are clip paths, not layers: nothing isolates, so the next
    // scene's source-over lands on the pixels exactly as one scene would have drawn them.
    let flush = |backend: &mut B, main: &mut B::Scene, stack: &[Open], stats: &mut Stats, band: &mut Option<[f64; 2]>| -> Result<(), String> {
        if stack.iter().any(|o| !matches!(o, Open::Clip { .. })) {
            return Err("spike: a kernel inside a layer that isolates".into());
        }
        let Some(b) = band.take() else { return Ok(()) };
        for _ in stack {
            main.pop_clip();
        }
        let t = clock();
        backend.render_main(main, to_rows(b))?;
        stats.ms_main += clock() - t;
        stats.flushes += 1;
        main.reset();
        reopen(main, stack, [0, 0]);
        Ok(())
    };

    for op in &list.ops {
        stats.ops += 1;
        let (scene, offset) = match apart.as_mut() {
            Some((s, o)) => (s, *o),
            None => (&mut main, [0, 0]),
        };
        let shift = Affine::translate((-f64::from(offset[0]), -f64::from(offset[1])));
        let in_main = offset == [0, 0] && !matches!(stack.last(), Some(Open::Apart { .. })) && !stack.iter().any(|o| matches!(o, Open::Apart { .. }));
        match op {
            Op::Fill { transform, path, .. } | Op::Stroke { transform, path, .. } if in_main => {
                let grow = if let Op::Stroke { style, .. } = op { f64::from(style.width) * transform.as_coeffs()[0].hypot(transform.as_coeffs()[1]) } else { 0.0 };
                rows(&mut band, &stack, transform.transform_rect_bbox(path.bounding_box()), grow);
            }
            _ => {}
        }
        match op {
            Op::Fill { transform, path, even_odd, color } => {
                scene.set_transform(shift * *transform);
                scene.set_fill_rule(if *even_odd { Fill::EvenOdd } else { Fill::NonZero });
                scene.set_color(*color);
                scene.fill_path(path);
            }
            Op::Stroke { transform, path, style, color } => {
                scene.set_transform(shift * *transform);
                let mut s = Stroke::new(f64::from(style.width))
                    .with_join(match style.join {
                        1 => Join::Round,
                        2 => Join::Bevel,
                        _ => Join::Miter,
                    })
                    .with_caps(match style.cap {
                        1 => Cap::Round,
                        2 => Cap::Square,
                        _ => Cap::Butt,
                    })
                    .with_miter_limit(f64::from(style.miter));
                if !style.dashes.is_empty() {
                    s = s.with_dashes(f64::from(style.dash_offset), style.dashes.iter().map(|d| f64::from(*d)));
                }
                scene.set_stroke(s);
                scene.set_color(*color);
                scene.stroke_path(path);
            }
            Op::PushClip { transform, path, even_odd } => {
                scene.set_transform(shift * *transform);
                scene.set_fill_rule(if *even_odd { Fill::EvenOdd } else { Fill::NonZero });
                scene.push_clip_path(path);
                stack.push(Open::Clip { transform: *transform, path: path.clone(), even_odd: *even_odd });
            }
            Op::PushGroup { opacity, blend } => {
                scene.push_layer(mix(*blend), *opacity);
                stack.push(Open::Isolating { pad: 0.0 });
            }
            Op::PushBlur { sigma } => {
                scene.push_filter_layer(Filter::from_primitive(FilterPrimitive::gaussian_blur(*sigma, EdgeMode::None)));
                stack.push(Open::Isolating { pad: f64::from(*sigma) * 3.0 });
            }
            Op::PushIsolate { blend, opacity, bounds } => {
                if !matches!(*blend, 0..=11 | BLEND_LINEAR_DODGE | BLEND_LINEAR_BURN) {
                    // Refused, never drawn as something else (hue, saturation, colour and
                    // luminosity have no kernel in the spike).
                    return Err(format!("unsupported blend {blend}"));
                }
                if apart.is_some() {
                    return Err("spike: a layer apart inside another".into());
                }
                flush(backend, &mut main, &stack, &mut stats, &mut band)?;
                let w = (bounds[2] - bounds[0]).max(1) as u16;
                let h = (bounds[3] - bounds[1]).max(1) as u16;
                let mut s = backend.scene(w, h);
                let at = [bounds[0], bounds[1]];
                // What clips the layer in the page clips it apart too.
                reopen(&mut s, &stack, at);
                apart = Some((s, at));
                stack.push(Open::Apart { blend: *blend, opacity: *opacity, bounds: *bounds, depth: stack.len() });
            }
            Op::Pop => match stack.pop().ok_or("pop without push")? {
                Open::Apart { blend, opacity, bounds, depth } => {
                    let (mut s, at) = apart.take().ok_or("apart without a scene")?;
                    for _ in 0..depth {
                        s.pop_clip();
                    }
                    let w = (bounds[2] - bounds[0]).max(1) as u16;
                    let h = (bounds[3] - bounds[1]).max(1) as u16;
                    let t = clock();
                    backend.render_apart(&mut s, at, w, h)?;
                    let t2 = clock();
                    backend.composite(at, w, h, blend, opacity)?;
                    stats.ms_apart += t2 - t;
                    stats.ms_composite += clock() - t2;
                    stats.apart += 1;
                }
                Open::Clip { .. } => scene.pop_clip(),
                Open::Isolating { .. } => scene.pop_layer(),
            },
            Op::Glass(g) => {
                if apart.is_some() {
                    return Err("spike: glass inside a layer apart".into());
                }
                flush(backend, &mut main, &stack, &mut stats, &mut band)?;
                let t = clock();
                backend.glass(g)?;
                stats.ms_glass += clock() - t;
                stats.glass += 1;
            }
        }
    }
    if !stack.is_empty() {
        return Err("layers left open".into());
    }
    if let Some(b) = band {
        let t = clock();
        backend.render_main(&mut main, to_rows(b))?;
        stats.ms_main += clock() - t;
    }
    Ok(stats)
}

/// W3C's separable blend function B(cb, cs) on unpremultiplied channels.
#[inline]
fn separable(blend: u32, cb: f32, cs: f32) -> f32 {
    match blend {
        1 => cb * cs,
        2 => cb + cs - cb * cs,
        3 => separable(8, cs, cb),
        4 => cb.min(cs),
        5 => cb.max(cs),
        6 => {
            if cb <= 0.0 {
                0.0
            } else if cs >= 1.0 {
                1.0
            } else {
                (cb / (1.0 - cs)).min(1.0)
            }
        }
        7 => {
            if cb >= 1.0 {
                1.0
            } else if cs <= 0.0 {
                0.0
            } else {
                1.0 - ((1.0 - cb) / cs).min(1.0)
            }
        }
        8 => {
            if cs <= 0.5 {
                cb * 2.0 * cs
            } else {
                let s = 2.0 * cs - 1.0;
                cb + s - cb * s
            }
        }
        9 => {
            if cs <= 0.5 {
                cb - (1.0 - 2.0 * cs) * cb * (1.0 - cb)
            } else {
                let d = if cb <= 0.25 { ((16.0 * cb - 12.0) * cb + 4.0) * cb } else { cb.sqrt() };
                cb + (2.0 * cs - 1.0) * (d - cb)
            }
        }
        10 => (cb - cs).abs(),
        11 => cb + cs - 2.0 * cb * cs,
        _ => cs,
    }
}

/// A premultiplied source blended over a premultiplied backdrop: W3C's separable modes
/// (1 to 11), and Figma's linear dodge and burn (decision 0038), which no library blends as
/// Figma does. Every non-normal blend is drawn apart and composited here, because a scene
/// Vello renders over pixels it drew earlier starts from an isolated root: a blend layer in it
/// would blend with nothing. Mirrored by `kernels.wgsl`.
#[inline]
pub fn blend_pixel(blend: u32, s: [f32; 4], b: [f32; 4]) -> [f32; 4] {
    let (sa, ba) = (s[3], b[3]);
    let a = sa + ba - sa * ba;
    let mut out = [0.0, 0.0, 0.0, a];
    for i in 0..3 {
        out[i] = match blend {
            BLEND_LINEAR_DODGE => (s[i] + b[i]).min(a),
            BLEND_LINEAR_BURN => (s[i] + b[i] - sa * ba).max(0.0),
            1..=11 => {
                let cs = if sa > 0.0 { s[i] / sa } else { 0.0 };
                let cb = if ba > 0.0 { b[i] / ba } else { 0.0 };
                s[i] * (1.0 - ba) + b[i] * (1.0 - sa) + sa * ba * separable(blend, cb, cs)
            }
            _ => s[i] + b[i] * (1.0 - sa),
        };
    }
    out
}
