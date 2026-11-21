//! Noise grain post-effect (decisions 0008, 0013, 0040).
//!
//! Direct port of `packages/editor/src/noise.ts`: three-octave periodic gradient noise on a
//! 320 x 320 tile (`PIXELS_PER_UNIT = 4`, `UNITS_PER_CELL = 1.25`, `CELLS = 64`,
//! `SEED = 0x5eed_d9a1`, `EDGE = 0.1`), sampled bilinearly in layer coordinates and composited
//! over the layer's picture with Porter-Duff `source-atop`.
//!
//! Paired verbatim with `noise.wgsl` (pure fragment pass, WebGL2 / GLSL ES 3.00 compatible).

use crate::record::Rgba;
use std::collections::VecDeque;
use std::f64::consts::TAU;
use std::sync::{Arc, Mutex, OnceLock, Weak};
use vello_common::kurbo::Affine;

/// Tile pixels per noise size unit (matches `PIXELS_PER_UNIT` in `noise.ts`).
pub const PIXELS_PER_UNIT: f64 = 4.0;
/// Size units per base lattice cell (matches `UNITS_PER_CELL` in `noise.ts`).
const UNITS_PER_CELL: f64 = 1.25;
/// Lattice cells along one tile side (matches `CELLS` in `noise.ts`).
const CELLS: usize = 64;
/// Side length of the periodic grain tile, in pixels (`64 * 1.25 * 4 = 320`).
pub const NOISE_TILE: usize = 320;
/// Fixed seed so a file renders identically across platforms (`SEED` in `noise.ts`).
const SEED: u32 = 0x5eed_d9a1;
/// Soft edge transition width in field standard deviations (`EDGE` in `noise.ts`).
const EDGE: f32 = 0.1;

/// Noise kind wire values (matching `NOISE_TYPE` in `packages/engine/src/wire.ts`).
pub const NOISE_MONO: u32 = 0;
pub const NOISE_DUO: u32 = 1;
pub const NOISE_MULTI: u32 = 2;

/// Approximate memory held when the noise field and one cached tile are alive (for Worker admission).
pub const NOISE_WORKING_SET_BYTES: usize = NOISE_TILE * NOISE_TILE * 4 * 6;

const MAX_CPU_TILES: usize = 4;

/// Look parameters that determine the cached 320 x 320 premultiplied RGBA8 grain tile.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct NoiseLookKey {
    pub noise_type: u32,
    pub density_bits: u32,
    pub color: [u8; 4],
    pub secondary_color: [u8; 4],
    pub opacity_bits: u32,
}

impl NoiseLookKey {
    pub fn from_params(noise_type: u32, density: f32, color: Rgba, secondary_color: Rgba, opacity: f32) -> Self {
        let to_u8 = |c: Rgba| -> [u8; 4] {
            [
                (c[0].clamp(0.0, 1.0) * 255.0).round() as u8,
                (c[1].clamp(0.0, 1.0) * 255.0).round() as u8,
                (c[2].clamp(0.0, 1.0) * 255.0).round() as u8,
                (c[3].clamp(0.0, 1.0) * 255.0).round() as u8,
            ]
        };
        let d = density.clamp(0.0, 100.0);
        let op = opacity.clamp(0.0, 1.0);
        match noise_type {
            NOISE_MULTI => Self {
                noise_type,
                density_bits: d.to_bits(),
                color: [0; 4],
                secondary_color: [0; 4],
                opacity_bits: op.to_bits(),
            },
            NOISE_DUO => Self {
                noise_type,
                density_bits: d.to_bits(),
                color: to_u8(color),
                secondary_color: to_u8(secondary_color),
                opacity_bits: 0,
            },
            _ => Self {
                noise_type: NOISE_MONO,
                density_bits: d.to_bits(),
                color: to_u8(color),
                secondary_color: [0; 4],
                opacity_bits: 0,
            },
        }
    }
}

/// Mulberry32 PRNG matching `seeded(seed)` in `packages/editor/src/noise.ts` bit-for-bit.
struct Mulberry32(u32);

impl Mulberry32 {
    fn new(seed: u32) -> Self {
        Self(seed)
    }

    fn next(&mut self) -> f64 {
        self.0 = self.0.wrapping_add(0x6d2b_79f5);
        let mut t = self.0;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        f64::from(t ^ (t >> 14)) / 4_294_967_296.0
    }
}

/// Where density puts the grain cut in field standard deviations (`noiseThresholdZ` in `noise.ts`).
pub fn noise_threshold_z(density: f32) -> f32 {
    2.82 - 2.85 * (density / 100.0).clamp(0.0, 1.0)
}

fn gradient_noise(period: usize, side: usize, rng: &mut Mulberry32) -> Vec<f32> {
    let n = period * period;
    let mut gx = vec![0.0f32; n];
    let mut gy = vec![0.0f32; n];
    for i in 0..n {
        let a = rng.next() * TAU;
        gx[i] = a.cos() as f32;
        gy[i] = a.sin() as f32;
    }
    let fade = |t: f32| t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
    let mut out = vec![0.0f32; side * side];
    let scale = period as f32 / side as f32;
    let xs: Vec<(usize, usize, f32, f32)> = (0..side)
        .map(|x| {
            let fx = (x as f32 + 0.5) * scale;
            let x0 = fx.floor() as usize;
            let tx = fx - x0 as f32;
            (x0 % period, (x0 + 1) % period, tx, fade(tx))
        })
        .collect();
    for y in 0..side {
        let fy = (y as f32 + 0.5) * scale;
        let y0 = fy.floor() as usize;
        let ty = fy - y0 as f32;
        let v = fade(ty);
        let r0 = (y0 % period) * period;
        let r1 = ((y0 + 1) % period) * period;
        let row = &mut out[y * side..(y + 1) * side];
        for (x, &(c0, c1, tx, u)) in xs.iter().enumerate() {
            let i00 = r0 + c0;
            let i10 = r0 + c1;
            let i01 = r1 + c0;
            let i11 = r1 + c1;
            let n00 = gx[i00] * tx + gy[i00] * ty;
            let n10 = gx[i10] * (tx - 1.0) + gy[i10] * ty;
            let n01 = gx[i01] * tx + gy[i01] * (ty - 1.0);
            let n11 = gx[i11] * (tx - 1.0) + gy[i11] * (ty - 1.0);
            let top = n00 + (n10 - n00) * u;
            let bottom = n01 + (n11 - n01) * u;
            row[x] = top + (bottom - top) * v;
        }
    }
    out
}

fn standardise(mut field: Vec<f32>) -> Vec<f32> {
    let n = field.len() as f64;
    let sum: f64 = field.iter().map(|&v| f64::from(v)).sum();
    let mean = sum / n;
    let sq: f64 = field
        .iter()
        .map(|&v| {
            let d = f64::from(v) - mean;
            d * d
        })
        .sum();
    let sd = (sq / n).sqrt();
    let sd = if sd == 0.0 { 1.0 } else { sd };
    for v in &mut field {
        *v = ((f64::from(*v) - mean) / sd) as f32;
    }
    field
}

/// Lazily generated standardised periodic fields for `NOISE_TILE`.
pub struct NoiseFields {
    grain: Vec<f32>,
    second: Vec<f32>,
    hues: [Vec<f32>; 3],
}

impl NoiseFields {
    pub fn generate() -> Self {
        let mut rng = Mulberry32::new(SEED);
        let cells = ((NOISE_TILE as f64) / (UNITS_PER_CELL * PIXELS_PER_UNIT))
            .round()
            .max(1.0) as usize;
        debug_assert_eq!(cells, CELLS);
        let mut field = || {
            let mut a = gradient_noise(cells, NOISE_TILE, &mut rng);
            let b = gradient_noise(cells * 2, NOISE_TILE, &mut rng);
            let c = gradient_noise(cells * 4, NOISE_TILE, &mut rng);
            for i in 0..a.len() {
                a[i] += 0.5 * b[i] + 0.25 * c[i];
            }
            standardise(a)
        };
        let grain = field();
        let second = field();
        let half = (cells >> 1).max(1);
        let h0 = standardise(gradient_noise(half, NOISE_TILE, &mut rng));
        let h1 = standardise(gradient_noise(half, NOISE_TILE, &mut rng));
        let h2 = standardise(gradient_noise(half, NOISE_TILE, &mut rng));
        Self {
            grain,
            second,
            hues: [h0, h1, h2],
        }
    }

    pub fn shared() -> Arc<Self> {
        static SHARED: OnceLock<Mutex<Weak<NoiseFields>>> = OnceLock::new();
        let slot = SHARED.get_or_init(|| Mutex::new(Weak::new()));
        if let Ok(guard) = slot.lock()
            && let Some(existing) = guard.upgrade()
        {
            return existing;
        }
        let fresh = Arc::new(Self::generate());
        if let Ok(mut guard) = slot.lock() {
            if let Some(existing) = guard.upgrade() {
                return existing;
            }
            *guard = Arc::downgrade(&fresh);
        }
        fresh
    }

    pub fn bytes(&self) -> usize {
        (self.grain.len() + self.second.len() + self.hues.iter().map(Vec::len).sum::<usize>()) * 4
    }

    /// Generates premultiplied RGBA8 pixels for `key` (ready for bilinear sampling on CPU or GPU).
    pub fn premul_pixels(&self, key: NoiseLookKey) -> Vec<u8> {
        let count = NOISE_TILE * NOISE_TILE;
        let mut pixels = vec![0u8; count * 4];
        let density = f32::from_bits(key.density_bits);
        if density <= 0.0 {
            return pixels;
        }
        let z = noise_threshold_z(density);
        let on = key.color;
        let off = key.secondary_color;
        let multi_alpha = f32::from_bits(key.opacity_bits).clamp(0.0, 1.0) * 255.0;
        for i in 0..count {
            let o = i * 4;
            let (r, g, b, a_f): (f32, f32, f32, f32) = match key.noise_type {
                NOISE_DUO => {
                    let e1 = self.grain[i] - z;
                    let e2 = self.second[i] - z;
                    let first_wins = e1 >= e2;
                    let c = if first_wins { on } else { off };
                    let strength = ((if first_wins { e1 } else { e2 }) / EDGE + 0.5).clamp(0.0, 1.0);
                    if strength <= 0.0 {
                        continue;
                    }
                    (
                        f32::from(c[0]),
                        f32::from(c[1]),
                        f32::from(c[2]),
                        f32::from(c[3]) * strength,
                    )
                }
                NOISE_MULTI => {
                    let k = ((self.grain[i] - z) / EDGE + 0.5).clamp(0.0, 1.0);
                    if k <= 0.0 {
                        continue;
                    }
                    // Round straight RGB to u8 first to match noise.ts's Uint8ClampedArray write
                    // before premultiplication.
                    let ch = |h: f32| (128.0 + 110.0 * (h / 1.5).clamp(-1.0, 1.0)).round().clamp(0.0, 255.0);
                    (
                        ch(self.hues[0][i]),
                        ch(self.hues[1][i]),
                        ch(self.hues[2][i]),
                        multi_alpha * k,
                    )
                }
                _ => {
                    let k = ((self.grain[i] - z) / EDGE + 0.5).clamp(0.0, 1.0);
                    if k <= 0.0 {
                        continue;
                    }
                    (
                        f32::from(on[0]),
                        f32::from(on[1]),
                        f32::from(on[2]),
                        f32::from(on[3]) * k,
                    )
                }
            };
            let a_u8 = a_f.round().clamp(0.0, 255.0) as u8;
            if a_u8 == 0 {
                continue;
            }
            let af = f32::from(a_u8) / 255.0;
            pixels[o] = (r * af).round().clamp(0.0, 255.0) as u8;
            pixels[o + 1] = (g * af).round().clamp(0.0, 255.0) as u8;
            pixels[o + 2] = (b * af).round().clamp(0.0, 255.0) as u8;
            pixels[o + 3] = a_u8;
        }
        pixels
    }
}

/// Bounded CPU noise tile cache owned per engine (freed when the engine drops).
#[derive(Default)]
pub struct CpuNoiseCache {
    fields: Option<Arc<NoiseFields>>,
    tiles: VecDeque<(NoiseLookKey, Vec<u8>)>,
}

impl CpuNoiseCache {
    pub const TILE_BYTES: usize = NOISE_TILE * NOISE_TILE * 4;

    pub fn bytes(&self) -> usize {
        let f = self.fields.as_ref().map_or(0, |f| f.bytes());
        let t: usize = self.tiles.iter().map(|(_, v)| v.len()).sum();
        f + t
    }

    pub fn has_fields(&self) -> bool {
        self.fields.is_some()
    }

    pub fn contains(&self, key: NoiseLookKey) -> bool {
        self.tiles.iter().any(|(k, _)| *k == key)
    }

    pub fn clear(&mut self) {
        self.tiles.clear();
        self.fields = None;
    }

    pub fn tile(&mut self, key: NoiseLookKey) -> &[u8] {
        if let Some(pos) = self.tiles.iter().position(|(k, _)| *k == key) {
            if pos + 1 != self.tiles.len() {
                let entry = self.tiles.remove(pos).expect("checked");
                self.tiles.push_back(entry);
            }
            return &self.tiles.back().expect("non-empty").1;
        }
        if self.tiles.len() >= MAX_CPU_TILES {
            self.tiles.pop_front();
        }
        let fields = self.fields.get_or_insert_with(NoiseFields::shared);
        let pixels = fields.premul_pixels(key);
        self.tiles.push_back((key, pixels));
        &self.tiles.back().expect("non-empty").1
    }
}

/// Applies noise grain over `src` (premultiplied RGBA8 of size `src_size`, placed at `src_origin`)
/// writing premultiplied RGBA8 into `dst` (size `dst_size`, placed at `dst_origin`).
/// `dev_to_layer` maps device pixels to layer units (`inv(device)`).
#[allow(clippy::too_many_arguments)]
pub fn noise_cpu(
    cache: &mut CpuNoiseCache,
    src: &[u8],
    src_size: (u32, u32),
    src_origin: (i32, i32),
    dst: &mut [u8],
    dst_size: (u32, u32),
    dst_origin: (i32, i32),
    noise_type: u32,
    size: f32,
    density: f32,
    color: Rgba,
    secondary_color: Rgba,
    opacity: f32,
    dev_to_layer: Affine,
) {
    let (sw, sh) = (src_size.0 as i32, src_size.1 as i32);
    let (dw, dh) = (dst_size.0 as usize, dst_size.1 as usize);
    let dx0 = dst_origin.0 - src_origin.0;
    let dy0 = dst_origin.1 - src_origin.1;
    let key = NoiseLookKey::from_params(noise_type, density, color, secondary_color, opacity);
    let tile = if size > 0.0 && density > 0.0 {
        Some(cache.tile(key))
    } else {
        None
    };
    let scale = if size > 0.0 {
        PIXELS_PER_UNIT / f64::from(size)
    } else {
        0.0
    };
    let [a, b, c, d, e, f] = (Affine::scale(scale) * dev_to_layer).as_coeffs();
    let side_f = NOISE_TILE as f64;
    const INV255: f32 = 1.0 / 255.0;

    for y in 0..dh {
        let sy = dy0 + y as i32;
        if sy < 0 || sy >= sh {
            let row_start = y * dw * 4;
            dst[row_start..row_start + dw * 4].fill(0);
            continue;
        }
        let dev_y = f64::from(dst_origin.1) + y as f64 + 0.5;
        for x in 0..dw {
            let di = (y * dw + x) * 4;
            let sx = dx0 + x as i32;
            if sx < 0 || sx >= sw {
                dst[di..di + 4].fill(0);
                continue;
            }
            let si = (sy as usize * src_size.0 as usize + sx as usize) * 4;
            let da_u8 = src[si + 3];
            if da_u8 == 0 {
                dst[di..di + 4].fill(0);
                continue;
            }
            let Some(tile) = tile else {
                dst[di..di + 4].copy_from_slice(&src[si..si + 4]);
                continue;
            };
            let dev_x = f64::from(dst_origin.0) + x as f64 + 0.5;
            let tx = a * dev_x + c * dev_y + e;
            let ty = b * dev_x + d * dev_y + f;
            // Bilinear repeat sample matching WebGPU Linear + Repeat sampler (texel centers at i + 0.5).
            let u = tx - 0.5;
            let v = ty - 0.5;
            let u_fl = u.floor();
            let v_fl = v.floor();
            let fx = (u - u_fl) as f32;
            let fy = (v - v_fl) as f32;
            let x0 = (u_fl.rem_euclid(side_f) as usize) % NOISE_TILE;
            let y0 = (v_fl.rem_euclid(side_f) as usize) % NOISE_TILE;
            let x1 = (x0 + 1) % NOISE_TILE;
            let y1 = (y0 + 1) % NOISE_TILE;
            let i00 = (y0 * NOISE_TILE + x0) * 4;
            let i10 = (y0 * NOISE_TILE + x1) * 4;
            let i01 = (y1 * NOISE_TILE + x0) * 4;
            let i11 = (y1 * NOISE_TILE + x1) * 4;
            let w00 = (1.0 - fx) * (1.0 - fy);
            let w10 = fx * (1.0 - fy);
            let w01 = (1.0 - fx) * fy;
            let w11 = fx * fy;
            let sample = |ch: usize| -> f32 {
                (f32::from(tile[i00 + ch]) * w00
                    + f32::from(tile[i10 + ch]) * w10
                    + f32::from(tile[i01 + ch]) * w01
                    + f32::from(tile[i11 + ch]) * w11)
                    * INV255
            };
            let sa = sample(3);
            if sa <= 0.0 {
                dst[di..di + 4].copy_from_slice(&src[si..si + 4]);
                continue;
            }
            let da = f32::from(da_u8) * INV255;
            let inv_sa = 1.0 - sa;
            for ch in 0..3 {
                let sc = sample(ch);
                let dc = f32::from(src[si + ch]) * INV255;
                let out = (sc * da + dc * inv_sa).clamp(0.0, 1.0);
                dst[di + ch] = (out * 255.0).round() as u8;
            }
            dst[di + 3] = da_u8;
        }
    }
}

#[cfg(feature = "gpu-common")]
pub mod gpu {
    use super::*;
    use wgpu::util::DeviceExt;

    const NOISE_WGSL: &str = include_str!("noise.wgsl");
    const MAX_GPU_TILES: usize = 8;

    struct GpuNoiseTile {
        key: NoiseLookKey,
        tex: wgpu::Texture,
        view: wgpu::TextureView,
    }

    /// GPU noise grain pass (`noise.wgsl`) with a bounded LRU cache of 320 x 320 grain textures.
    /// Evicted tiles are held in `retired` until after `queue.submit` so a multi-look noise stack
    /// recorded into one `CommandEncoder` never destroys a texture referenced by that submit.
    pub struct GpuNoise {
        layout: wgpu::BindGroupLayout,
        pipe: wgpu::RenderPipeline,
        sampler: wgpu::Sampler,
        fields: Option<Arc<NoiseFields>>,
        tiles: VecDeque<GpuNoiseTile>,
        retired: Vec<wgpu::Texture>,
    }

    impl GpuNoise {
        pub const TILE_BYTES: usize = NOISE_TILE * NOISE_TILE * 4;

        pub fn new(device: &wgpu::Device) -> Self {
            let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("noise"),
                source: wgpu::ShaderSource::Wgsl(NOISE_WGSL.into()),
            });
            let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("noise"),
                entries: &[
                    wgpu::BindGroupLayoutEntry {
                        binding: 0,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Texture {
                            sample_type: wgpu::TextureSampleType::Float { filterable: false },
                            view_dimension: wgpu::TextureViewDimension::D2,
                            multisampled: false,
                        },
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 1,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Texture {
                            sample_type: wgpu::TextureSampleType::Float { filterable: true },
                            view_dimension: wgpu::TextureViewDimension::D2,
                            multisampled: false,
                        },
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 2,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 3,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Uniform,
                            has_dynamic_offset: false,
                            min_binding_size: None,
                        },
                        count: None,
                    },
                ],
            });
            let pipe_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("noise"),
                bind_group_layouts: &[Some(&layout)],
                immediate_size: 0,
            });
            let pipe = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some("noise"),
                layout: Some(&pipe_layout),
                vertex: wgpu::VertexState {
                    module: &shader,
                    entry_point: Some("vs_quad"),
                    buffers: &[],
                    compilation_options: Default::default(),
                },
                fragment: Some(wgpu::FragmentState {
                    module: &shader,
                    entry_point: Some("fs_noise"),
                    targets: &[Some(wgpu::ColorTargetState {
                        format: wgpu::TextureFormat::Rgba8Unorm,
                        blend: None,
                        write_mask: wgpu::ColorWrites::ALL,
                    })],
                    compilation_options: Default::default(),
                }),
                primitive: wgpu::PrimitiveState::default(),
                depth_stencil: None,
                multisample: wgpu::MultisampleState::default(),
                multiview_mask: None,
                cache: None,
            });
            let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
                label: Some("noise tile"),
                address_mode_u: wgpu::AddressMode::Repeat,
                address_mode_v: wgpu::AddressMode::Repeat,
                address_mode_w: wgpu::AddressMode::Repeat,
                mag_filter: wgpu::FilterMode::Linear,
                min_filter: wgpu::FilterMode::Linear,
                mipmap_filter: wgpu::MipmapFilterMode::Nearest,
                ..Default::default()
            });
            Self {
                layout,
                pipe,
                sampler,
                fields: None,
                tiles: VecDeque::new(),
                retired: Vec::new(),
            }
        }

        pub fn contains(&self, key: NoiseLookKey) -> bool {
            self.tiles.iter().any(|t| t.key == key)
        }

        pub fn gpu_bytes(&self) -> usize {
            (self.tiles.len() + self.retired.len()) * Self::TILE_BYTES
        }

        /// Destroys textures evicted during command encoding; call after `queue.submit` (or when
        /// discarding an unsubmitted encoder).
        pub fn flush_retired(&mut self) {
            for tex in self.retired.drain(..) {
                tex.destroy();
            }
        }

        pub fn clear(&mut self) {
            self.flush_retired();
            for t in self.tiles.drain(..) {
                t.tex.destroy();
            }
            self.fields = None;
        }

        fn ensure_tile(&mut self, device: &wgpu::Device, queue: &wgpu::Queue, key: NoiseLookKey) {
            if let Some(pos) = self.tiles.iter().position(|t| t.key == key) {
                if pos + 1 != self.tiles.len() {
                    let entry = self.tiles.remove(pos).expect("checked");
                    self.tiles.push_back(entry);
                }
                return;
            }
            let fields = self.fields.get_or_insert_with(NoiseFields::shared);
            let pixels = fields.premul_pixels(key);
            if self.tiles.len() >= MAX_GPU_TILES
                && let Some(old) = self.tiles.pop_front()
            {
                // Keep the evicted texture alive until the active CommandEncoder submits.
                self.retired.push(old.tex);
            }
            let side = NOISE_TILE as u32;
            let tex = device.create_texture(&wgpu::TextureDescriptor {
                label: Some("noise tile"),
                size: wgpu::Extent3d {
                    width: side,
                    height: side,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Rgba8Unorm,
                usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
                view_formats: &[],
            });
            queue.write_texture(
                wgpu::TexelCopyTextureInfo {
                    texture: &tex,
                    mip_level: 0,
                    origin: wgpu::Origin3d::ZERO,
                    aspect: wgpu::TextureAspect::All,
                },
                &pixels,
                wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(side * 4),
                    rows_per_image: Some(side),
                },
                wgpu::Extent3d {
                    width: side,
                    height: side,
                    depth_or_array_layers: 1,
                },
            );
            let view = tex.create_view(&Default::default());
            self.tiles.push_back(GpuNoiseTile { key, tex, view });
        }

        #[allow(clippy::too_many_arguments)]
        pub fn encode(
            &mut self,
            device: &wgpu::Device,
            queue: &wgpu::Queue,
            encoder: &mut wgpu::CommandEncoder,
            src_view: &wgpu::TextureView,
            src_size: (u32, u32),
            src_origin: (i32, i32),
            dst_view: &wgpu::TextureView,
            dst_size: (u32, u32),
            dst_origin: (i32, i32),
            noise_type: u32,
            size: f32,
            density: f32,
            color: Rgba,
            secondary_color: Rgba,
            opacity: f32,
            dev_to_layer: Affine,
        ) {
            if dst_size.0 == 0 || dst_size.1 == 0 {
                return;
            }
            let key = NoiseLookKey::from_params(noise_type, density, color, secondary_color, opacity);
            self.ensure_tile(device, queue, key);
            let tile_view = &self.tiles.back().expect("non-empty").view;
            let uv_scale = if size > 0.0 {
                PIXELS_PER_UNIT / (f64::from(size) * NOISE_TILE as f64)
            } else {
                0.0
            };
            // Keep `dev_to_uv` independent of `dst_origin` so tiles and bands compute identical
            // float UVs for the same global device pixel.
            let to_uv = Affine::scale(uv_scale) * dev_to_layer;
            let [a, b, c, d, e, f] = to_uv.as_coeffs();
            let mut bytes = [0u8; 64];
            let put_f = |buf: &mut [u8], at: usize, v: f32| buf[at..at + 4].copy_from_slice(&v.to_le_bytes());
            let put_i = |buf: &mut [u8], at: usize, v: i32| buf[at..at + 4].copy_from_slice(&v.to_le_bytes());
            put_f(&mut bytes, 0, a as f32);
            put_f(&mut bytes, 4, c as f32);
            put_f(&mut bytes, 8, e as f32);
            put_f(&mut bytes, 16, b as f32);
            put_f(&mut bytes, 20, d as f32);
            put_f(&mut bytes, 24, f as f32);
            put_i(&mut bytes, 32, dst_origin.0);
            put_i(&mut bytes, 36, dst_origin.1);
            put_i(&mut bytes, 40, src_origin.0);
            put_i(&mut bytes, 44, src_origin.1);
            put_i(&mut bytes, 48, src_size.0 as i32);
            put_i(&mut bytes, 52, src_size.1 as i32);
            let uniform = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("noise params"),
                contents: &bytes,
                usage: wgpu::BufferUsages::UNIFORM,
            });
            let bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("noise"),
                layout: &self.layout,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: wgpu::BindingResource::TextureView(src_view),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: wgpu::BindingResource::TextureView(tile_view),
                    },
                    wgpu::BindGroupEntry {
                        binding: 2,
                        resource: wgpu::BindingResource::Sampler(&self.sampler),
                    },
                    wgpu::BindGroupEntry {
                        binding: 3,
                        resource: uniform.as_entire_binding(),
                    },
                ],
            });
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("noise"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: dst_view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Load,
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            pass.set_pipeline(&self.pipe);
            pass.set_bind_group(0, &bg, &[]);
            pass.set_scissor_rect(0, 0, dst_size.0, dst_size.1);
            pass.draw(0..3, 0..1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn noise_source_atop_preserves_alpha_and_transparent_pixels() {
        let mut cache = CpuNoiseCache::default();
        // 4 x 2 pixels: left half transparent, right half opaque blue.
        let mut src = vec![0u8; 4 * 2 * 4];
        for y in 0..2 {
            for x in 2..4 {
                let i = (y * 4 + x) * 4;
                src[i] = 40;
                src[i + 1] = 100;
                src[i + 2] = 200;
                src[i + 3] = 255;
            }
        }
        let mut dst = vec![0u8; src.len()];
        noise_cpu(
            &mut cache,
            &src,
            (4, 2),
            (0, 0),
            &mut dst,
            (4, 2),
            (0, 0),
            NOISE_MONO,
            1.0,
            85.0,
            [1.0, 0.0, 0.0, 0.8],
            [1.0; 4],
            1.0,
            Affine::IDENTITY,
        );
        for y in 0..2 {
            for x in 0..2 {
                let i = (y * 4 + x) * 4;
                assert_eq!(&dst[i..i + 4], &[0, 0, 0, 0], "transparent pixel modified");
            }
            for x in 2..4 {
                let i = (y * 4 + x) * 4;
                assert_eq!(dst[i + 3], 255, "opaque alpha changed");
            }
        }
    }

    #[test]
    fn noise_threshold_and_coverage_match_decision_0013() {
        let fields = NoiseFields::generate();
        let px_low = fields.premul_pixels(NoiseLookKey::from_params(
            NOISE_MONO,
            20.0,
            [0.0, 0.0, 0.0, 1.0],
            [1.0; 4],
            1.0,
        ));
        let px_mid = fields.premul_pixels(NoiseLookKey::from_params(
            NOISE_MONO,
            50.0,
            [0.0, 0.0, 0.0, 1.0],
            [1.0; 4],
            1.0,
        ));
        let px_hi = fields.premul_pixels(NoiseLookKey::from_params(
            NOISE_MONO,
            85.0,
            [0.0, 0.0, 0.0, 1.0],
            [1.0; 4],
            1.0,
        ));
        let cov = |p: &[u8]| p.as_chunks::<4>().0.iter().filter(|px| px[3] > 127).count() as f64 / 102400.0;
        let (c20, c50, c85) = (cov(&px_low), cov(&px_mid), cov(&px_hi));
        assert!(c20 > 0.005 && c20 < 0.03, "20% density coverage {c20}");
        assert!(c50 > 0.05 && c50 < 0.14, "50% density coverage {c50}");
        assert!(c85 > 0.25 && c85 < 0.45, "85% density coverage {c85}");
        assert!(c20 < c50 && c50 < c85);
    }

    #[test]
    fn noise_tile_seam_matches_whole_frame_bit_identically() {
        let mut cache = CpuNoiseCache::default();
        let src = [120u8, 150, 210, 255].repeat(32 * 16);
        let mut whole = vec![0u8; src.len()];
        noise_cpu(
            &mut cache,
            &src,
            (32, 16),
            (10, 20),
            &mut whole,
            (32, 16),
            (10, 20),
            NOISE_DUO,
            2.5,
            60.0,
            [0.1, 0.1, 0.1, 0.6],
            [1.0, 1.0, 1.0, 0.7],
            0.5,
            Affine::translate((-10.0, -20.0)),
        );
        // Right half rendered as an offset tile: must match bit-for-bit.
        let mut tile = vec![0u8; 16 * 16 * 4];
        noise_cpu(
            &mut cache,
            &src,
            (32, 16),
            (10, 20),
            &mut tile,
            (16, 16),
            (26, 20),
            NOISE_DUO,
            2.5,
            60.0,
            [0.1, 0.1, 0.1, 0.6],
            [1.0, 1.0, 1.0, 0.7],
            0.5,
            Affine::translate((-10.0, -20.0)),
        );
        for y in 0..16 {
            let w_off = (y * 32 + 16) * 4;
            let t_off = y * 16 * 4;
            assert_eq!(&tile[t_off..t_off + 64], &whole[w_off..w_off + 64]);
        }
    }
}
