//! Glass (decisions 0007 and 0039), for a box: the CPU kernel. `kernels.wgsl` is the same
//! arithmetic on the GPU; the two are kept in step by hand, which is exactly the cost decision
//! 0040 weighs (one source for both would need a shading language that runs on the CPU too).
//!
//! The spike's shortcuts against packages/editor/src/glass.ts: boxes only (the kit's knobs and
//! buttons), the rim's direction from the box's exact distance rather than the blurred height's
//! slope, and bilinear reads without mipmaps. Frost, the bend, its falloff, splay, dispersion,
//! the hairline light and the shade follow the shader's formulas and constants.

use crate::dl::GlassOp;
use vello_common::kurbo::Point;

/// Signed distance into a rounded box, in its units (positive inside).
pub fn box_inside(g: &GlassOp, local: Point) -> f32 {
    let (hw, hh) = (g.w * 0.5, g.h * 0.5);
    let qx = local.x as f32 - hw;
    let qy = local.y as f32 - hh;
    let cap = hw.min(hh);
    let [tl, tr, br, bl] = g.radii.map(|r| r.clamp(0.0, cap));
    let r = if qx < 0.0 {
        if qy < 0.0 { tl } else { bl }
    } else if qy < 0.0 {
        tr
    } else {
        br
    };
    let ex = qx.abs() - hw + r;
    let ey = qy.abs() - hh + r;
    let outside = ex.max(0.0).hypot(ey.max(0.0));
    -(ex.max(ey).min(0.0) + outside - r)
}

struct Area {
    x0: i32,
    y0: i32,
    w: i32,
    h: i32,
    px: Vec<[f32; 4]>,
}

impl Area {
    fn at(&self, x: i32, y: i32) -> [f32; 4] {
        let x = x.clamp(0, self.w - 1);
        let y = y.clamp(0, self.h - 1);
        self.px[(y * self.w + x) as usize]
    }
    /// Bilinear, at a device position (pixel centres at .5), clamped to the area's edge.
    fn sample(&self, x: f32, y: f32) -> [f32; 4] {
        let fx = x - 0.5 - self.x0 as f32;
        let fy = y - 0.5 - self.y0 as f32;
        let ix = fx.floor();
        let iy = fy.floor();
        let tx = fx - ix;
        let ty = fy - iy;
        let (ix, iy) = (ix as i32, iy as i32);
        let a = self.at(ix, iy);
        let b = self.at(ix + 1, iy);
        let c = self.at(ix, iy + 1);
        let d = self.at(ix + 1, iy + 1);
        let mut o = [0.0; 4];
        for i in 0..4 {
            let top = a[i] + (b[i] - a[i]) * tx;
            let bottom = c[i] + (d[i] - c[i]) * tx;
            o[i] = top + (bottom - top) * ty;
        }
        o
    }
}

fn gaussian(sigma: f32) -> Vec<f32> {
    let radius = (sigma * 3.0).ceil() as i32;
    let mut k: Vec<f32> = (-radius..=radius).map(|i| (-(i * i) as f32 / (2.0 * sigma * sigma)).exp()).collect();
    let sum: f32 = k.iter().sum();
    for v in &mut k {
        *v /= sum;
    }
    k
}

fn blur(area: &Area, sigma: f32) -> Area {
    let k = gaussian(sigma);
    let r = (k.len() / 2) as i32;
    let (w, h) = (area.w, area.h);
    // One pass along x or y, the edge repeated (as a GPU clamps a texture to its edge).
    let pass = |src: &[[f32; 4]], along_x: bool| -> Vec<[f32; 4]> {
        let mut out = vec![[0.0f32; 4]; src.len()];
        let (n, lines) = if along_x { (w, h) } else { (h, w) };
        let idx = |line: i32, i: i32| -> usize {
            if along_x { (line * w + i) as usize } else { (i * w + line) as usize }
        };
        let mut row = vec![[0.0f32; 4]; (n + 2 * r) as usize];
        for line in 0..lines {
            for (j, slot) in row.iter_mut().enumerate() {
                let i = (j as i32 - r).clamp(0, n - 1);
                *slot = src[idx(line, i)];
            }
            for i in 0..n {
                let mut acc = [0.0f32; 4];
                let window = &row[i as usize..i as usize + k.len()];
                for (p, wgt) in window.iter().zip(&k) {
                    acc[0] += p[0] * wgt;
                    acc[1] += p[1] * wgt;
                    acc[2] += p[2] * wgt;
                    acc[3] += p[3] * wgt;
                }
                out[idx(line, i)] = acc;
            }
        }
        out
    };
    let x = pass(&area.px, true);
    area.with(pass(&x, false))
}

impl Area {
    fn with(&self, px: Vec<[f32; 4]>) -> Area {
        Area { x0: self.x0, y0: self.y0, w: self.w, h: self.h, px }
    }
}

/// The lens over `main` (premultiplied RGBA8, `w` × `h`), in place.
pub fn glass_cpu(main: &mut [u8], w: usize, h: usize, g: &GlassOp) {
    let (cw, ch) = (w as i32, h as i32);
    let rx0 = g.region[0].max(0);
    let ry0 = g.region[1].max(0);
    let rx1 = g.region[2].min(cw);
    let ry1 = g.region[3].min(ch);
    if rx0 >= rx1 || ry0 >= ry1 {
        return;
    }
    // What the glass reads: its region and the margin a bent ray or the frost reaches.
    let ax0 = (rx0 - g.margin).max(0);
    let ay0 = (ry0 - g.margin).max(0);
    let ax1 = (rx1 + g.margin).min(cw);
    let ay1 = (ry1 + g.margin).min(ch);
    let mut px = Vec::with_capacity(((ax1 - ax0) * (ay1 - ay0)) as usize);
    for y in ay0..ay1 {
        for x in ax0..ax1 {
            let i = (y as usize * w + x as usize) * 4;
            px.push([0, 1, 2, 3].map(|c| f32::from(main[i + c]) / 255.0));
        }
    }
    let backdrop = Area { x0: ax0, y0: ay0, w: ax1 - ax0, h: ay1 - ay0, px };
    let seen_area = if g.frost > 0.4 { blur(&backdrop, g.frost) } else { backdrop.with(backdrop.px.clone()) };

    let inv = g.transform.inverse();
    let center = g.transform * Point::new(f64::from(g.w) * 0.5, f64::from(g.h) * 0.5);
    let c = g.transform.as_coeffs();
    let half = [
        ((c[0].abs() * f64::from(g.w) + c[2].abs() * f64::from(g.h)) * 0.5) as f32,
        ((c[1].abs() * f64::from(g.w) + c[3].abs() * f64::from(g.h)) * 0.5) as f32,
    ];
    let dist = |x: f32, y: f32| box_inside(g, inv * Point::new(f64::from(x), f64::from(y))) * g.unit_px;

    for y in ry0..ry1 {
        for x in rx0..rx1 {
            let px = x as f32 + 0.5;
            let py = y as f32 + 0.5;
            let d0 = dist(px, py);
            let a = (d0 + 0.5).clamp(0.0, 1.0);
            if a <= 0.0 {
                continue;
            }
            let gx = (dist(px + 1.0, py) - dist(px - 1.0, py)) * 0.5;
            let gy = (dist(px, py + 1.0) - dist(px, py - 1.0)) * 0.5;
            let gl = gx.hypot(gy);
            let inward = if gl > 1e-6 { [gx / gl, gy / gl] } else { [0.0, 0.0] };
            let d = d0.max(0.0);
            let fall = (1.0 - d / g.depth.max(1.0)).clamp(0.0, 1.0).powf(g.falloff);
            let along = [-inward[1], inward[0]];
            let extent = along[0].abs() * half[0] + along[1].abs() * half[1];
            let off = if extent > 0.0 {
                ((px - center.x as f32) * along[0] + (py - center.y as f32) * along[1]) / extent
            } else {
                0.0
            };
            let bend = [
                (inward[0] - along[0] * off * g.splay) * fall * g.refraction,
                (inward[1] - along[1] * off * g.splay) * fall * g.refraction,
            ];
            let red = seen_area.sample(px + bend[0] * (1.0 + g.dispersion), py + bend[1] * (1.0 + g.dispersion));
            let green = seen_area.sample(px + bend[0], py + bend[1]);
            let blue = seen_area.sample(px + bend[0] * (1.0 - g.dispersion), py + bend[1] * (1.0 - g.dispersion));
            let seen_alpha = red[3].max(green[3]).max(blue[3]);
            let mut seen = [red[0], green[1], blue[2]];
            let facing = -(inward[0] * g.light[0] + inward[1] * g.light[1]);
            let hair = (-(d - 0.5).max(0.0) / (g.hairline * g.unit_px).max(1e-3)).exp();
            let edge = (g.front * (facing - g.front_start)).max(0.0) + (g.back * (-facing - g.back_start)).max(0.0);
            let shading = g.intensity * g.shade * facing * (1.0 - d / (g.shade_reach * g.depth).max(1.0)).max(0.0);
            for v in &mut seen {
                *v = if shading > 0.0 { *v * (1.0 - shading) } else { *v + (seen_alpha - *v) * -shading };
            }
            let lit = (g.intensity * edge * hair).clamp(0.0, 1.0);
            for v in &mut seen {
                *v += (seen_alpha - *v) * lit;
            }
            let out = [seen[0] * a, seen[1] * a, seen[2] * a, seen_alpha * a];
            let i = (y as usize * w + x as usize) * 4;
            for k in 0..4 {
                let under = f32::from(main[i + k]) / 255.0;
                main[i + k] = ((under * (1.0 - a) + out[k]).clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
            }
        }
    }
}
