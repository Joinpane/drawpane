//! The engine, without the WebAssembly boundary (`lib.rs` wraps it): the render graph, the CPU
//! backend and, in the browser build, the GPU backend.

use crate::cpu::Cpu;
use crate::error::{EngineError, ErrorCode, Result};
use crate::exec::{self, DrawStats, Frame, IRect, Pass, Split};
use crate::images;
use crate::limits::Limits;
use crate::masks::MaskStats;
use crate::store::{Applied, Dirty, Store};
use crate::tiles::{Last, TileCache};
use vello_common::kurbo::{Affine, Rect};

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
    // Fast path: check two pixels (8 bytes) at once so opaque (0xff) and transparent (0x00)
    // spans skip scalar division entirely.
    let (chunks8, rem) = px.as_chunks_mut::<8>();
    for pair in chunks8.iter_mut() {
        let a0 = pair[3];
        let a1 = pair[7];
        if (a0 == 0 || a0 == 255) && (a1 == 0 || a1 == 255) {
            continue;
        }
        if a0 != 0 && a0 != 255 {
            let a = u32::from(a0);
            for c in &mut pair[..3] {
                *c = ((u32::from(*c) * 255 + a / 2) / a).min(255) as u8;
            }
        }
        if a1 != 0 && a1 != 255 {
            let a = u32::from(a1);
            for c in &mut pair[4..7] {
                *c = ((u32::from(*c) * 255 + a / 2) / a).min(255) as u8;
            }
        }
    }
    for p in rem.as_chunks_mut::<4>().0.iter_mut() {
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

/// How a frame made of tiles is asked for (`Engine::render_cpu_tiled`, `Gpu::render`).
#[derive(Clone, Copy, Debug)]
pub struct TiledOptions {
    /// The camera is moving: stand-ins may show, and a zoom draws no tiles of a passing scale.
    pub moving: bool,
    /// Tiles drawn this frame beyond the ones nothing else can stand in for (the CPU's
    /// deterministic budget; the GPU's is in milliseconds).
    pub max_jobs: usize,
    /// Milliseconds the frame may spend drawing tiles (GPU), beyond the ones nothing else can
    /// stand in for. Zero or less: no limit.
    pub budget_ms: f64,
    /// Tiles round the view may be drawn when the budget allows.
    pub prefetch: bool,
}

impl Default for TiledOptions {
    fn default() -> Self {
        Self {
            moving: false,
            max_jobs: usize::MAX,
            budget_ms: 0.0,
            prefetch: true,
        }
    }
}

/// A drag in progress (decision 0040, "Dragging"): the records the last messages only moved.
#[derive(Clone, Debug)]
pub struct Dragging {
    pub ids: Vec<u32>,
    /// Which drag (a new selection is a new drag) and how many moves it has made.
    pub serial: u64,
    pub moves: u64,
    /// The selection's place in paint order, when moving its picture is exact (consecutive
    /// siblings, no readers, no faded ancestor): the page is drawn around it in parts. None: it's
    /// drawn at its real position every frame instead.
    pub split: Option<Split>,
    /// Where it was before the drag began (page units).
    pub start: Option<Rect>,
}

/// A drag as a frame needs it: which, its moves, its split, and where the selection is now and
/// was when it began (page units).
#[derive(Clone, Debug)]
pub struct DragFrame {
    pub serial: u64,
    pub moves: u64,
    pub split: Option<Split>,
    pub now: Rect,
    pub start: Option<Rect>,
}

impl DragFrame {
    pub fn input(&self) -> crate::tiles::DragInput {
        crate::tiles::DragInput {
            serial: self.serial,
            moves: self.moves,
            start: self.start,
            now: self.now,
            eligible: self.split.is_some(),
        }
    }
}

/// What a frame made of tiles did.
#[derive(Default, Clone, Copy, Debug)]
pub struct TiledStats {
    /// Summed over the tiles drawn this frame.
    pub draw: DrawStats,
    pub tiles_drawn: u32,
    /// Tiles the frame shows that are stale or missing: more frames will draw them.
    pub pending: u32,
    /// Exactly what a fresh engine draws: every tile shown up to date and drawn without level
    /// of detail, no stand-in anywhere.
    pub exact: bool,
    /// The frame's tiles didn't fit the budget: drawn one at a time straight into the frame.
    pub direct: bool,
    pub evicted: u32,
    pub held: u32,
    /// Tiles a drag composited (the part below, its selection, the part above): a stand-in.
    pub dragged: u32,
}

/// The CPU's tiles (decision 0040, phase 2): what the tests hold the GPU's tiles to, pixel for
/// pixel, and a Worker could show.
pub struct CpuTiles {
    pub cache: TileCache,
    slots: Vec<Vec<u8>>,
    /// The frame last made, premultiplied RGBA8, and what it was drawn for.
    pub frame: Vec<u8>,
    /// A copy of the frame, the stand-in the next one may draw from.
    frame_last: Vec<u8>,
    last: Option<Last>,
    last_scale: Option<f64>,
}

impl CpuTiles {
    pub fn new(tile: u32, max_slots: usize) -> Self {
        Self {
            cache: TileCache::new(tile, max_slots),
            slots: Vec::new(),
            frame: Vec::new(),
            frame_last: Vec::new(),
            last: None,
            last_scale: None,
        }
    }

    /// Forgets the last frame (it can't stand in for a page it doesn't show).
    pub fn forget(&mut self) {
        self.last = None;
        self.last_scale = None;
        self.frame_last.clear();
    }
}

pub struct Engine {
    pub store: Store,
    /// Changes whenever what's drawn may have (a message applied, an image put or dropped): a
    /// frame made from the last one is valid only within one generation.
    pub generation: u64,
    pub cpu: Cpu,
    /// The band being exported.
    band: Vec<u8>,
    #[cfg(feature = "gpu-common")]
    pub gpu: Option<crate::gpu::Gpu>,
    /// Image uploads kept as levels, so a GPU attached later (or rebuilt after a device loss)
    /// gets them without asking TypeScript again.
    #[cfg(feature = "gpu-common")]
    pub image_levels: std::collections::HashMap<u32, std::rc::Rc<Vec<images::Level>>>,
    /// Tiles on the CPU, once asked for (tests; a Worker's view mode).
    pub cpu_tiles: Option<CpuTiles>,
    /// The drag in progress, if the last messages only moved records.
    pub dragging: Option<Dragging>,
    drag_serial: u64,
}

impl Engine {
    pub fn new(limits: Limits) -> Self {
        Self {
            generation: 0,
            band: Vec::new(),
            cpu: Cpu::new(limits.glyph_mask_bytes, limits.glyph_mask_side, limits.memory_bytes),
            store: Store::new(limits),
            #[cfg(feature = "gpu-common")]
            gpu: None,
            #[cfg(feature = "gpu-common")]
            image_levels: std::collections::HashMap::new(),
            cpu_tiles: None,
            dragging: None,
            drag_serial: 0,
        }
    }

    /// Follows drags: a message that only moves records continues the drag of exactly those
    /// records, or starts one; anything else ends it.
    fn follow_drag(&mut self, applied: &Applied) {
        let Some(ids) = applied.moved.as_ref() else {
            // An edit elsewhere (a collaborator, text re-shaped as its faces arrive) doesn't end
            // a drag: the parts around the selection are drawn again where it changed them (see
            // `invalidate_tiles`). One that changes the structure, or the selection itself, does.
            let keeps = self
                .dragging
                .as_ref()
                .is_some_and(|d| !applied.structural && !applied.touched.iter().any(|t| self.store.within(*t, &d.ids)));
            if !keeps {
                self.dragging = None;
                return;
            }
            // An edit to a record the selection is drawn inside (a board fading as one, say) may
            // change whether moving its picture is exact: the split is decided again, as a new
            // drag (its parts were drawn for the old one).
            let on_path = self.dragging.as_ref().is_some_and(|d| {
                d.split
                    .as_ref()
                    .is_some_and(|s| applied.touched.iter().any(|t| s.path.contains(t)))
            });
            if on_path && let Some(ids) = self.dragging.as_ref().map(|d| d.ids.clone()) {
                let split = self.store.selection(&ids).map(|(parent, first, last, path)| Split {
                    pass: Pass::All,
                    parent,
                    first,
                    last,
                    path,
                });
                self.drag_serial += 1;
                let serial = self.drag_serial;
                if let Some(d) = self.dragging.as_mut() {
                    d.split = split;
                    d.serial = serial;
                }
            }
            return;
        };
        if let Some(d) = self.dragging.as_mut().filter(|d| &d.ids == ids) {
            d.moves += 1;
            return;
        }
        self.drag_serial += 1;
        let split = self.store.selection(ids).map(|(parent, first, last, path)| Split {
            pass: Pass::All,
            parent,
            first,
            last,
            path,
        });
        // Where it was: the changes hold where the moved records painted before and paint now.
        let start = applied.changes.iter().map(|d| d.rect).reduce(|a, b| a.union(b));
        self.dragging = Some(Dragging {
            ids: ids.clone(),
            serial: self.drag_serial,
            moves: 1,
            split,
            start,
        });
    }

    /// The drag as this frame needs it: where its selection is now (including any ancestor
    /// post-effect halo that moves with it).
    pub fn drag_frame(&self) -> Option<DragFrame> {
        let d = self.dragging.as_ref()?;
        let now = d
            .ids
            .iter()
            .filter_map(|id| self.store.dirty_extent(*id))
            .reduce(|a, b| a.union(b))
            .unwrap_or(Rect::ZERO);
        Some(DragFrame {
            serial: d.serial,
            moves: d.moves,
            split: d.split.clone(),
            now,
            start: d.start,
        })
    }

    /// Marks stale every tile, on every backend, that changes reach: each level's tiles under
    /// where the changed records painted before and paint now, grown for anti-aliasing, and
    /// every reader they reach, transitively (`Store::dirty`). A fresh list drops them all, and
    /// the last frame with them: it shows a page that's gone.
    fn invalidate_tiles(&mut self, changes: &[Dirty], full: bool, drag_parts: bool) {
        let store = &mut self.store;
        let mut each = |cache: &mut TileCache| {
            if full {
                cache.clear();
                return;
            }
            if changes.is_empty() {
                return;
            }
            for (id, level) in cache.levels() {
                let rects: Vec<Rect> = store.dirty(changes, level.grid(), 1.5);
                cache.invalidate(id, &rects);
                // An edit beside a drag: its parts around the selection are drawn again there.
                if drag_parts {
                    cache.drag_invalidate(id, &rects);
                }
            }
        };
        if let Some(t) = self.cpu_tiles.as_mut() {
            each(&mut t.cache);
            if full {
                t.forget();
            }
        }
        #[cfg(feature = "gpu-common")]
        if let Some(g) = self.gpu.as_mut() {
            each(&mut g.tiles);
            if full {
                g.forget_last();
            }
        }
    }

    /// Keeps tiles on the CPU of `tile` device pixels a side, at most `max_slots` at once.
    pub fn use_cpu_tiles(&mut self, tile: u32, max_slots: usize) {
        self.cpu_tiles = Some(CpuTiles::new(tile, max_slots));
    }

    pub fn limits(&self) -> &Limits {
        &self.store.limits
    }

    pub fn apply(&mut self, bytes: &[u8]) -> Result<Applied> {
        let applied = self.store.apply(bytes)?;
        if applied.noop {
            // Nothing changed: no frame needs drawing again, and a drag goes on.
            return Ok(applied);
        }
        self.generation += 1;
        self.invalidate_tiles(&applied.changes, applied.full, applied.moved.is_none());
        self.follow_drag(&applied);
        Ok(applied)
    }

    /// Marks stale what shows image `id` (its pixels are about to change or go).
    fn invalidate_image(&mut self, id: u32) {
        let users = self.store.image_users(id);
        if !users.is_empty() {
            self.invalidate_tiles(&users, false, true);
        }
    }

    pub fn put_image(&mut self, id: u32, width: u32, height: u32, rgba: &[u8], premultiplied: bool) -> Result<()> {
        let limits = self.store.limits;
        // Refused before anything is copied or levels are made: its size, and the budget.
        if width == 0 || height == 0 || rgba.len() != width as usize * height as usize * 4 {
            return Err(EngineError::new(ErrorCode::Image, "image bytes don't match its size"));
        }
        if width > limits.texture_side || height > limits.texture_side {
            return Err(EngineError::limit(format!(
                "an image {width} × {height}; the longest side allowed is {}",
                limits.texture_side
            )));
        }
        let held = self.cpu.image_bytes() - self.cpu.held_image(id);
        if held + images::levels_bytes(width, height) > limits.image_bytes {
            return Err(EngineError::limit(format!(
                "an image {width} × {height} takes {} MiB with its levels; images may hold {} MiB",
                images::levels_bytes(width, height).div_ceil(1 << 20),
                limits.image_bytes >> 20
            )));
        }
        #[cfg(feature = "gpu-common")]
        if let Some(gpu) = self.gpu.as_ref() {
            gpu.check_texture_size(width, height, "an image")?;
        }
        self.generation += 1;
        self.invalidate_image(id);
        let levels = images::levels(width, height, rgba, premultiplied, limits.texture_side)?;
        self.cpu.put_image(id, &levels, limits.image_bytes)?;
        #[cfg(feature = "gpu-common")]
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
        self.generation += 1;
        self.invalidate_image(id);
        self.cpu.drop_image(id);
        #[cfg(feature = "gpu-common")]
        {
            self.image_levels.remove(&id);
            if let Some(gpu) = self.gpu.as_mut() {
                gpu.drop_image(id);
            }
        }
    }

    /// Refuses a page holding a shown record the engine doesn't draw, wherever it is: the caller
    /// draws the whole page another way.
    /// Refuses an export while any shown record is provisional (display list 1.1, flag 8: its
    /// text still loading, drawn as placeholder bars): an export is exact or isn't made, so it
    /// waits for the list that has the text. Wherever the record is, in the crop or not: the list
    /// isn't the document yet.
    pub fn check_settled(&self) -> Result<()> {
        match self.store.provisional_shown() {
            Some(id) => Err(EngineError::new(
                ErrorCode::State,
                format!("record {id} is provisional (its text is still loading): an export waits for it"),
            )),
            None => Ok(()),
        }
    }

    pub fn check_supported(&self) -> Result<()> {
        match self.store.refusal() {
            Some((id, bits)) => Err(EngineError::unsupported(format!(
                "record {id} needs features {bits:#x}; the page is drawn another way"
            ))),
            None => Ok(()),
        }
    }

    /// Bytes the engine holds, roughly: the graph, images (on the CPU) and glyph masks.
    pub fn held_bytes(&self) -> usize {
        self.store.bytes() + self.cpu.image_bytes() + self.cpu.masks.stats.bytes
    }

    /// Rows a band of a frame `width` wide may have: `Limits::band_rows`, and no more than
    /// `Limits::band_bytes` of output.
    pub fn band_rows(&self, width: u32) -> u32 {
        let l = &self.store.limits;
        let by_bytes = (l.band_bytes / (width.max(1) as usize * 4)).max(1);
        l.band_rows.min(by_bytes as u32).max(1)
    }

    /// Estimates the peak extra transient working set needed by visible shadows, layer blurs, and
    /// isolated offscreen scopes on an export tile of `cols` x `tile_rows` (which already includes
    /// export backdrop-reader halos), and validates that no visible blur exceeds `MAX_BLUR_SIGMA`
    /// or `Limits::texture_side`. Propagates expanded offscreen dimensions through nested blur
    /// scopes so stacked blurs and shadows inside blurred containers are admitted accurately.
    fn export_effect_working_set(&self, cols: usize, tile_rows: usize, view: Affine) -> Result<usize> {
        let view_scale = view.determinant().abs().sqrt();
        let max_tex = self.store.limits.texture_side as usize;
        let mut peak_total = 0usize;
        // Stack entries: (id, parent_world, cur_cols, cur_rows, live_iso_bytes).
        let mut stack: Vec<(u32, Affine, usize, usize, usize)> =
            vec![(crate::store::ROOT, Affine::IDENTITY, cols, tile_rows, 0)];
        while let Some((id, parent_world, cur_cols, cur_rows, live_iso)) = stack.pop() {
            let Some(node) = self.store.nodes.get(&id) else {
                continue;
            };
            let r = &node.record;
            if id != crate::store::ROOT && r.hidden() {
                continue;
            }
            let world = if id == crate::store::ROOT {
                parent_world
            } else {
                parent_world * r.transform
            };
            let cur_tile_bytes = cur_cols.saturating_mul(cur_rows).saturating_mul(4);
            let has_post = id != crate::store::ROOT && !r.post_effects.is_empty();
            let through = id != crate::store::ROOT
                && !has_post
                && r.blend == 0
                && r.isolate()
                && r.opacity < 1.0
                && self.store.subtree_has_blend(id);
            let mut next_cols = cur_cols;
            let mut next_rows = cur_rows;
            let mut next_iso = live_iso;
            if has_post {
                enum StepKind {
                    Blur {
                        sigma: f32,
                        src_pad: usize,
                        grow_pad: usize,
                    },
                    Noise,
                    Texture {
                        src_pad: usize,
                        grow_pad: usize,
                    },
                }
                let mut active_steps: Vec<StepKind> = Vec::with_capacity(r.post_effects.len());
                let mut total_pad = 0usize;
                let mut max_step = 4usize;
                let mut has_noise = false;
                let device = view * world;
                let inv = (device.determinant().abs() > 1e-300).then(|| device.inverse());
                for pe in &r.post_effects {
                    match *pe {
                        crate::record::PostEffect::LayerBlur { radius } => {
                            let sigma = (f64::from(crate::blur::sigma_from_radius(radius)) * view_scale) as f32;
                            if sigma < 1e-4 {
                                continue;
                            }
                            crate::blur::validate_sigma(
                                sigma,
                                IRect {
                                    x0: 0,
                                    y0: 0,
                                    x1: cur_cols.max(1) as i32,
                                    y1: cur_rows.max(1) as i32,
                                },
                                crate::blur::EdgeMode::Zero,
                            )?;
                            let pad = crate::shadow::blur_support_pad(sigma) as usize;
                            total_pad = total_pad.saturating_add(pad);
                            if sigma > crate::blur::DIRECT_SIGMA_MAX {
                                let (lvl, _) = crate::blur::choose_level(sigma, crate::blur::MAX_PYRAMID_LEVELS);
                                max_step = max_step.max(1usize << lvl.min(8));
                            }
                            active_steps.push(StepKind::Blur {
                                sigma,
                                src_pad: pad,
                                grow_pad: pad,
                            });
                        }
                        crate::record::PostEffect::Noise { size, density, .. } => {
                            if size > 0.0 && density > 0.0 {
                                let Some(dev_to_layer) = inv else {
                                    continue;
                                };
                                let uv_scale =
                                    crate::noise::PIXELS_PER_UNIT / (f64::from(size) * crate::noise::NOISE_TILE as f64);
                                let coeffs = (Affine::scale(uv_scale) * dev_to_layer).as_coeffs();
                                if !uv_scale.is_finite() || coeffs.iter().any(|c| !(*c as f32).is_finite()) {
                                    return Err(EngineError::limit("noise scale exceeds finite coordinate bounds"));
                                }
                                has_noise = true;
                                active_steps.push(StepKind::Noise);
                            }
                        }
                        crate::record::PostEffect::Texture {
                            size,
                            radius,
                            clip_to_shape,
                        } => {
                            let Some(dev_to_layer) = inv else {
                                continue;
                            };
                            let radius_dev = (f64::from(radius) * view_scale) as f32;
                            if size > 0.0 && radius_dev >= 1e-4 {
                                if !radius_dev.is_finite() || radius_dev > max_tex as f32 {
                                    return Err(EngineError::limit("texture radius exceeds finite target bounds"));
                                }
                                crate::exec::validate_texture_lattice(
                                    IRect {
                                        x0: 0,
                                        y0: 0,
                                        x1: cur_cols.max(1) as i32,
                                        y1: cur_rows.max(1) as i32,
                                    },
                                    dev_to_layer,
                                    size,
                                )?;
                                let pad = (radius_dev.ceil() as usize).saturating_add(2);
                                total_pad = total_pad.saturating_add(pad);
                                active_steps.push(StepKind::Texture {
                                    src_pad: pad,
                                    grow_pad: if clip_to_shape { 0 } else { pad },
                                });
                            }
                        }
                    }
                }
                if !active_steps.is_empty() {
                    let (content_w, content_h) = if let (Some(bounds), page_pad) = self.store.bounds_and_pad(id) {
                        let inner_pad = (page_pad - r.post_pad()).max(0.0);
                        let inner_pad_dev = if inner_pad > 0.0 {
                            inner_pad * view_scale + 2.0
                        } else {
                            0.0
                        };
                        let dev_box = device.transform_rect_bbox(bounds).inflate(inner_pad_dev, inner_pad_dev);
                        let ir = IRect::around(dev_box).inflate(2, 2);
                        ((ir.x1 - ir.x0).max(1) as usize, (ir.y1 - ir.y0).max(1) as usize)
                    } else {
                        (cur_cols, cur_rows)
                    };
                    let raw_w = content_w.min(cur_cols.saturating_add(total_pad.saturating_mul(2)));
                    let raw_h = content_h.min(cur_rows.saturating_add(total_pad.saturating_mul(2)));
                    let src_w = raw_w.next_multiple_of(max_step);
                    let src_h = raw_h.next_multiple_of(max_step);
                    if src_w > max_tex || src_h > max_tex {
                        return Err(EngineError::limit(format!(
                            "post-effect source {src_w} x {src_h} px exceeds maximum target size {max_tex} px"
                        )));
                    }
                    let src_bytes = src_w.saturating_mul(src_h).saturating_mul(4);
                    let src_scene = crate::cpu::scene_estimate_bytes(src_w as u32, src_h as u32);
                    // Walk the ordered post chain mirroring `exec.rs` so multi-step chains account
                    // for coexisting halo-expanded intermediate buffers (`prev_bytes + step_bytes`).
                    let total_steps = active_steps.len();
                    let mut rem_pads = vec![0usize; total_steps];
                    let mut suffix = 0usize;
                    for i in (0..total_steps).rev() {
                        rem_pads[i] = suffix;
                        let sp = match active_steps[i] {
                            StepKind::Blur { src_pad, .. } | StepKind::Texture { src_pad, .. } => src_pad,
                            StepKind::Noise => 0,
                        };
                        suffix = suffix.saturating_add(sp);
                    }
                    let noise_extra = if has_noise {
                        crate::noise::NOISE_WORKING_SET_BYTES
                    } else {
                        0
                    };
                    let blend_extra = if r.blend != 0 { cur_tile_bytes } else { 0 };
                    // Peak during child rendering into `src_area`:
                    peak_total = peak_total.max(
                        live_iso
                            .saturating_add(src_bytes)
                            .saturating_add(src_scene)
                            .saturating_add(noise_extra),
                    );
                    let mut prev_size = (src_w as u32, src_h as u32);
                    let mut prev_bytes = src_bytes;
                    let mut grown = 0usize;
                    for (idx, step) in active_steps.iter().enumerate() {
                        let gp = match *step {
                            StepKind::Blur { grow_pad, .. } | StepKind::Texture { grow_pad, .. } => grow_pad,
                            StepKind::Noise => 0,
                        };
                        grown = grown.saturating_add(gp);
                        let (step_w, step_h) = if idx + 1 == total_steps {
                            (cur_cols, cur_rows)
                        } else {
                            let rem = rem_pads[idx];
                            let rw = content_w
                                .saturating_add(grown.saturating_mul(2))
                                .min(cur_cols.saturating_add(rem.saturating_mul(2)));
                            let rh = content_h
                                .saturating_add(grown.saturating_mul(2))
                                .min(cur_rows.saturating_add(rem.saturating_mul(2)));
                            let sw = rw.next_multiple_of(max_step);
                            let sh = rh.next_multiple_of(max_step);
                            if sw > max_tex || sh > max_tex {
                                return Err(EngineError::limit(format!(
                                    "post-effect intermediate {sw} x {sh} px exceeds maximum target size {max_tex} px"
                                )));
                            }
                            (sw, sh)
                        };
                        let step_bytes = step_w.saturating_mul(step_h).saturating_mul(4);
                        let step_size = (step_w as u32, step_h as u32);
                        let scratch_extra = match *step {
                            StepKind::Blur { sigma, .. } => crate::blur::cpu_work_bytes(prev_size, step_size, sigma),
                            _ => 0,
                        };
                        let step_need = live_iso
                            .saturating_add(prev_bytes)
                            .saturating_add(step_bytes)
                            .saturating_add(scratch_extra)
                            .saturating_add(noise_extra)
                            .saturating_add(if idx + 1 == total_steps { blend_extra } else { 0 });
                        peak_total = peak_total.max(step_need);
                        prev_bytes = step_bytes;
                        prev_size = step_size;
                    }
                    next_cols = src_w;
                    next_rows = src_h;
                    next_iso = live_iso.saturating_add(src_bytes).saturating_add(src_scene);
                } else if r.blend != 0 {
                    next_iso = live_iso
                        .saturating_add(cur_tile_bytes)
                        .saturating_add(crate::cpu::scene_estimate_bytes(cur_cols as u32, cur_rows as u32));
                    peak_total = peak_total.max(next_iso.saturating_add(cur_tile_bytes));
                }
            } else if id != crate::store::ROOT
                && (r.blend != 0 || through || (r.isolate() && r.opacity < 1.0 && self.store.subtree_has_pass(id)))
            {
                next_iso = live_iso
                    .saturating_add(cur_tile_bytes)
                    .saturating_add(crate::cpu::scene_estimate_bytes(cur_cols as u32, cur_rows as u32));
                let blend_extra = if r.blend != 0 || through { cur_tile_bytes } else { 0 };
                peak_total = peak_total.max(next_iso.saturating_add(blend_extra));
            }
            let next_tile_bytes = next_cols.saturating_mul(next_rows).saturating_mul(4);
            let next_scene_bytes = crate::cpu::scene_estimate_bytes(next_cols as u32, next_rows as u32);
            for op in &r.ops {
                match op {
                    crate::record::Op::Fill { blend, .. } | crate::record::Op::Stroke { blend, .. } if *blend != 0 => {
                        let blend_need = next_iso
                            .saturating_add(next_tile_bytes.saturating_mul(2))
                            .saturating_add(next_scene_bytes);
                        peak_total = peak_total.max(blend_need);
                    }
                    crate::record::Op::DropShadow { blur, blend, .. }
                    | crate::record::Op::InnerShadow { blur, blend, .. } => {
                        let shadow_iso = if *blend != 0 {
                            let b_iso = next_iso
                                .saturating_add(next_tile_bytes)
                                .saturating_add(next_scene_bytes);
                            peak_total = peak_total.max(b_iso.saturating_add(next_tile_bytes));
                            b_iso
                        } else {
                            next_iso
                        };
                        let sigma = crate::blur::sigma_from_radius(*blur) * view_scale as f32;
                        crate::blur::validate_sigma(
                            sigma,
                            IRect {
                                x0: 0,
                                y0: 0,
                                x1: next_cols.max(1) as i32,
                                y1: next_rows.max(1) as i32,
                            },
                            crate::blur::EdgeMode::Zero,
                        )?;
                        if crate::blur::kernel_radius(sigma) > 0 {
                            let pad = crate::shadow::blur_support_pad(sigma) as usize;
                            let shift = crate::shadow::shadow_raster_shift(sigma);
                            let s = 1usize << shift;
                            let mw = (next_cols.saturating_add(pad.saturating_mul(2))).div_ceil(s);
                            let mh = (next_rows.saturating_add(pad.saturating_mul(2))).div_ceil(s);
                            if mw > max_tex || mh > max_tex {
                                return Err(EngineError::limit(format!(
                                    "shadow mask {mw} x {mh} px exceeds maximum target size {max_tex} px"
                                )));
                            }
                            let mask_b = mw.saturating_mul(mh).saturating_mul(4);
                            let shadow_need = shadow_iso
                                .saturating_add(mask_b.saturating_mul(3))
                                .saturating_add(crate::cpu::scene_estimate_bytes(mw as u32, mh as u32))
                                .saturating_add(next_tile_bytes);
                            peak_total = peak_total.max(shadow_need);
                        }
                    }
                    crate::record::Op::Children => {
                        let has_pic_mask = node.children.iter().any(|c| {
                            self.store
                                .nodes
                                .get(c)
                                .is_some_and(|n| !n.record.hidden() && n.record.is_picture_mask())
                        });
                        let child_iso = if has_pic_mask {
                            let mask_iso = next_iso
                                .saturating_add(next_tile_bytes.saturating_mul(2))
                                .saturating_add(next_scene_bytes);
                            peak_total = peak_total.max(mask_iso.saturating_add(next_tile_bytes));
                            mask_iso
                        } else {
                            next_iso
                        };
                        for &c in &node.children {
                            stack.push((c, world, next_cols, next_rows, child_iso));
                        }
                    }
                    _ => {}
                }
            }
        }
        Ok(peak_total)
    }

    /// Refuses an export of a `width` × `height` frame before it starts when its working set
    /// wouldn't fit beside what the engine holds, under `Limits::memory_bytes` (a Worker's cap;
    /// zero: no check). The working set is a band of output, a tile of target (with the readers'
    /// reach round it), the scene's rows, peak shadow/isolated offscreen passes, and the compressor.
    pub fn admit_export(&self, width: u32, height: u32, camera: Camera) -> Result<()> {
        self.check_size(width, height)?;
        camera.check()?;
        self.check_supported()?;
        self.check_settled()?;
        let l = &self.store.limits;
        let rows = self.band_rows(width) as usize;
        let halo = self.halo(camera.view())? as usize;
        let cols = (l.export_tile.min(width) as usize + 2 * halo).min(width as usize);
        let tile_rows = (rows + 2 * halo).min(height as usize);
        let effects = self.export_effect_working_set(cols, tile_rows, camera.view())?;
        let budget = self.store.limits.memory_bytes;
        if budget == 0 {
            return Ok(());
        }
        let band = rows * width as usize * 4;
        // A tile's target and a copy of it for the PNG's straight pixels.
        let tile = cols * tile_rows * 4 * 2;
        // vello_cpu keeps per wide tile (256 × 4 px) command lists for the whole frame.
        let scene = crate::cpu::scene_estimate_bytes(width, height);
        let png = 512 * 1024;
        let diamond = self.export_diamond_bytes(width, height, camera.view(), cols, tile_rows);
        let need = band
            .saturating_add(tile)
            .saturating_add(scene)
            .saturating_add(effects)
            .saturating_add(png)
            .saturating_add(diamond);
        let held = self.held_bytes();
        if held.saturating_add(need) > budget {
            return Err(EngineError::limit(format!(
                "an export {width} × {height} px needs {} MiB beside the {} MiB the engine holds; it may hold {} MiB",
                need.div_ceil(1 << 20),
                held.div_ceil(1 << 20),
                budget >> 20
            )));
        }
        Ok(())
    }

    /// Upper bound on retained temporary diamond-gradient raster bytes for one export tile of
    /// `cols × tile_rows` device pixels.
    fn export_diamond_bytes(&self, width: u32, height: u32, view: Affine, cols: usize, tile_rows: usize) -> usize {
        use crate::record::{GradientKind, Op, Paint};
        let frame_rect = IRect {
            x0: 0,
            y0: 0,
            x1: width as i32,
            y1: height as i32,
        };
        let mut total = 0usize;
        let mut stack = vec![(crate::store::ROOT, Affine::IDENTITY)];
        let glyph_bounds = |g: u32| self.store.glyphs.get(g).and_then(|glyph| glyph.bounds);
        while let Some((id, parent_world)) = stack.pop() {
            let Some(node) = self.store.nodes.get(&id) else {
                continue;
            };
            let world = if id == crate::store::ROOT {
                parent_world
            } else {
                if node.record.hidden() {
                    continue;
                }
                parent_world * node.record.transform
            };
            if id != crate::store::ROOT {
                let device = view * world;
                if device.determinant().abs() >= 1e-300 {
                    for op in &node.record.ops {
                        let (path, pad, paint) = match op {
                            Op::Fill { path, paint, .. } => (*path, 0.0, paint),
                            Op::Stroke { path, style, paint, .. } => {
                                if style.width <= 0.0 {
                                    continue;
                                }
                                (*path, exec::stroke_paint_reach(style), paint)
                            }
                            _ => continue,
                        };
                        let Paint::Gradient(g) = paint else {
                            continue;
                        };
                        if g.kind != GradientKind::Diamond
                            || g.matrix.determinant().abs() < 1e-12
                            || (device * g.matrix).determinant().abs() < 1e-300
                        {
                            continue;
                        }
                        let local = node
                            .record
                            .entry_bounds(path, &glyph_bounds)
                            .map(|b| if pad > 0.0 { b.inflate(pad, pad) } else { b });
                        let clipped = exec::diamond_device_rect(local, device, frame_rect);
                        if clipped.is_empty() {
                            continue;
                        }
                        let w = ((clipped.x1 - clipped.x0) as usize).min(cols);
                        let h = ((clipped.y1 - clipped.y0) as usize).min(tile_rows);
                        total = total.saturating_add(w.saturating_mul(h).saturating_mul(4));
                    }
                }
            }
            for &child in &node.children {
                stack.push((child, world));
            }
        }
        total
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

    /// Draws the whole frame on the CPU into `out` (premultiplied RGBA8, `width` x `height`).
    ///
    /// When `Limits::memory_bytes` is non-zero (Worker builds or an explicit memory cap), admits
    /// the frame upfront and renders in bounded horizontal bands/tiles directly into `out` so a
    /// single output buffer is held (never duplicating the framebuffer beside a full-frame target
    /// or full-frame offscreen effect buffers), returning `ErrorCode::Limit` cleanly if the frame
    /// and its band working set cannot fit instead of trapping Wasm.
    pub fn render_cpu_into(
        &mut self,
        out: &mut Vec<u8>,
        width: u32,
        height: u32,
        camera: Camera,
        background: [f32; 4],
        detail: bool,
    ) -> Result<FrameStats> {
        self.check_size(width, height)?;
        camera.check()?;
        self.check_supported()?;
        let frame_bytes = (width as usize)
            .checked_mul(height as usize)
            .and_then(|n| n.checked_mul(4))
            .ok_or_else(|| EngineError::limit("frame pixel buffer overflow"))?;
        let budget = self.store.limits.memory_bytes;
        if budget == 0 {
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
                0,
            )?;
            out.clear();
            out.extend_from_slice(self.cpu.target.data_as_u8_slice());
            return Ok(stats);
        }

        // Bounded path: drop stale scratch buffers before checking admission so prior renders do
        // not inflate Wasm linear memory.
        out.clear();
        if out.capacity() != frame_bytes {
            out.shrink_to_fit();
        }
        self.band.clear();
        self.band.shrink_to_fit();
        self.cpu.shrink_target();

        let view = camera.view();
        let halo = self.halo(view)? as usize;
        let scene_bytes = crate::cpu::scene_estimate_bytes(width, height);
        let held = self.held_bytes();
        // Match `Cpu::check_memory`'s headroom for Wasm static data, stack, allocator overhead,
        // and transient `vello_cpu` strip buffers.
        let cap = budget.saturating_sub(4 << 20).max(budget / 2);

        let mut band_h = self.band_rows(width).min(128).min(height).max(1);
        let chosen_rows = loop {
            let cols = (self.store.limits.export_tile.max(1).min(width) as usize + 2 * halo).min(width as usize);
            let tile_rows = (band_h as usize + 2 * halo).min(height as usize);
            let effects = self.export_effect_working_set(cols, tile_rows, view)?;
            let diamond = self.export_diamond_bytes(width, height, view, cols, tile_rows);
            let tile_bytes = cols.saturating_mul(tile_rows).saturating_mul(4);
            let need = frame_bytes
                .saturating_add(tile_bytes)
                .saturating_add(scene_bytes)
                .saturating_add(effects)
                .saturating_add(diamond);
            if held.saturating_add(need) <= cap {
                break band_h;
            }
            if band_h <= 32 {
                return Err(EngineError::limit(format!(
                    "CPU render {width} x {height} px needs {} MiB beside the {} MiB held; limit is {} MiB",
                    need.div_ceil(1 << 20),
                    held.div_ceil(1 << 20),
                    budget >> 20
                )));
            }
            band_h = (band_h / 2).max(32);
        };

        out.resize(frame_bytes, 0);
        let stride = width as usize * 4;
        let mut total_stats = FrameStats::default();
        let res = (|| -> Result<()> {
            let mut y0 = 0u32;
            while y0 < height {
                let rows = chosen_rows.min(height - y0);
                let mut x0 = 0u32;
                while x0 < width {
                    let cols = self.store.limits.export_tile.max(1).min(width - x0);
                    let area = IRect {
                        x0: x0 as i32,
                        y0: y0 as i32,
                        x1: (x0 + cols) as i32,
                        y1: (y0 + rows) as i32,
                    };
                    let (tile_stats, grown) =
                        self.cpu_tile(width, height, camera, background, detail, area, out.capacity())?;
                    total_stats.draw.add(&tile_stats.draw);
                    total_stats.masks = tile_stats.masks;
                    let tw = (grown.x1 - grown.x0) as usize * 4;
                    let px = self.cpu.target.data_as_u8_slice();
                    let n = cols as usize * 4;
                    let x_off = (x0 as i32 - grown.x0) as usize * 4;
                    let y_off = (y0 as i32 - grown.y0) as usize;
                    for r in 0..rows as usize {
                        let from = (y_off + r) * tw + x_off;
                        let to = (y0 as usize + r) * stride + x0 as usize * 4;
                        out[to..to + n].copy_from_slice(&px[from..from + n]);
                    }
                    x0 += cols;
                }
                y0 += rows;
            }
            Ok(())
        })();
        if let Err(e) = res {
            out.clear();
            out.shrink_to_fit();
            self.cpu.shrink_target();
            return Err(e);
        }
        Ok(total_stats)
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
        if self.store.limits.memory_bytes > 0 {
            let mut buf = std::mem::take(&mut self.band);
            let res = self.render_cpu_into(&mut buf, width, height, camera, background, detail);
            self.band = buf;
            let stats = res?;
            return Ok((self.band.as_slice(), stats));
        }
        self.check_size(width, height)?;
        camera.check()?;
        self.check_supported()?;
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
            0,
        )?;
        Ok((self.cpu.target.data_as_u8_slice(), stats))
    }

    /// Attaches a GPU, uploading the images already held so it can draw everything at once.
    #[cfg(feature = "gpu-common")]
    pub fn attach_gpu(&mut self, mut gpu: crate::gpu::Gpu) -> Result<()> {
        let budget = self.store.limits.image_bytes;
        gpu.budget = self.store.limits.gpu_bytes;
        for (id, levels) in &self.image_levels {
            gpu.put_image(*id, levels, budget)?;
        }
        self.gpu = Some(gpu);
        Ok(())
    }

    /// Draws tiles on the GPU for the next frame of the view last drawn, for at most
    /// `budget_ms` (`Gpu::ahead`): what a browser runs between frames at rest.
    #[cfg(feature = "gpu-common")]
    pub fn render_gpu_ahead(&mut self, background: [f32; 4], budget_ms: f64) -> Result<DrawStats> {
        self.check_supported()?;
        let gpu = self
            .gpu
            .as_ref()
            .ok_or_else(|| EngineError::new(ErrorCode::State, "no GPU attached"))?;
        let Some(last) = gpu.last() else {
            return Ok(DrawStats::default());
        };
        let halo = self.halo(last.view)?;
        let gpu = self
            .gpu
            .as_mut()
            .ok_or_else(|| EngineError::new(ErrorCode::State, "no GPU attached"))?;
        gpu.ahead(&self.store, background, halo, budget_ms)
    }

    /// Draws a frame on the GPU, made of tiles (into its canvas, when it has one).
    #[cfg(feature = "gpu-common")]
    pub fn render_gpu(
        &mut self,
        width: u32,
        height: u32,
        camera: Camera,
        background: [f32; 4],
        options: TiledOptions,
    ) -> Result<DrawStats> {
        self.check_size(width, height)?;
        camera.check()?;
        self.check_supported()?;
        let view = camera.view();
        let halo = self.halo(view)?;
        if self.gpu.is_none() {
            return Err(EngineError::new(ErrorCode::State, "no GPU attached"));
        }
        let frame = Frame {
            width: width as u16,
            height: height as u16,
            view,
            detail: false,
            area: IRect {
                x0: 0,
                y0: 0,
                x1: width as i32,
                y1: height as i32,
            },
        };
        let drag = self.drag_frame();
        let gpu = self
            .gpu
            .as_mut()
            .ok_or_else(|| EngineError::new(ErrorCode::State, "no GPU attached"))?;
        let mut stats = gpu.render(
            &self.store,
            &frame,
            background,
            self.generation,
            halo,
            options,
            drag.as_ref(),
        )?;
        // No frame is exact while text is still to come: it may paint past its box.
        if stats.exact && self.store.provisional_shown().is_some() {
            stats.exact = false;
            stats.standin = true;
        }
        Ok(stats)
    }

    /// Device pixels the readers on the page may read past where they paint, summed through
    /// readers reading readers (conservatively: every reader's reach added up).
    pub fn halo(&self, view: Affine) -> Result<i32> {
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
    /// reach each way so what they read is drawn; answers the extended area. `extra_external`
    /// accounts for any live export band buffer temporarily taken out of `self.band`.
    #[allow(clippy::too_many_arguments)]
    fn cpu_tile(
        &mut self,
        width: u32,
        height: u32,
        camera: Camera,
        background: [f32; 4],
        detail: bool,
        area: IRect,
        extra_external: usize,
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
        let tile_w = (grown.x1 - grown.x0).max(1) as usize;
        let tile_h = (grown.y1 - grown.y0).max(1) as usize;
        let tile_bytes = tile_w.saturating_mul(tile_h).saturating_mul(4);
        let runtime_held = self
            .held_bytes()
            .saturating_add(tile_bytes)
            .saturating_add(extra_external);
        let diamond_budget = if self.store.limits.memory_bytes > 0 {
            self.store.limits.memory_bytes.saturating_sub(runtime_held)
        } else {
            self.store.limits.image_bytes
        };
        self.cpu.set_diamond_budget(diamond_budget);
        self.cpu.set_external_bytes(
            self.held_bytes()
                .saturating_sub(self.cpu.image_bytes())
                .saturating_add(extra_external)
                .saturating_add(512 * 1024),
        );
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
        let draw = exec::draw(&self.store, &mut self.cpu, &frame, &limits);
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

    /// Draws one tile on the CPU into `self.cpu.target`: `tile` × `tile` pixels under `view`
    /// (page to the tile's own pixels), with `halo` pixels drawn round it for readers, so the
    /// target is `tile + 2 × halo` a side and the tile is its middle.
    fn cpu_draw_tile(
        &mut self,
        view: Affine,
        tile: u32,
        halo: i32,
        detail: bool,
        background: [f32; 4],
    ) -> Result<FrameStats> {
        self.cpu_draw_tile_split(view, tile, halo, detail, background, &Split::all())
    }

    /// `cpu_draw_tile`, drawing only the part of the page `split` names.
    fn cpu_draw_tile_split(
        &mut self,
        view: Affine,
        tile: u32,
        halo: i32,
        detail: bool,
        background: [f32; 4],
        split: &Split,
    ) -> Result<FrameStats> {
        let side = tile as i32 + 2 * halo;
        let area = IRect {
            x0: 0,
            y0: 0,
            x1: side,
            y1: side,
        };
        self.cpu.halo = halo;
        let tile_bytes = (side as usize).saturating_mul(side as usize).saturating_mul(4);
        let runtime_held = self.held_bytes().saturating_add(tile_bytes);
        let diamond_budget = if self.store.limits.memory_bytes > 0 {
            self.store.limits.memory_bytes.saturating_sub(runtime_held)
        } else {
            self.store.limits.image_bytes
        };
        self.cpu.set_diamond_budget(diamond_budget);
        self.cpu.begin(side as u16, side as u16, area, premultiply(background));
        let frame = Frame {
            width: side as u16,
            height: side as u16,
            view: Affine::translate((f64::from(halo), f64::from(halo))) * view,
            detail,
            area,
        };
        let limits = self.store.limits;
        let mut verbs = limits.frame_verbs;
        let draw = exec::draw_split(&self.store, &mut self.cpu, &frame, &limits, &mut verbs, split);
        self.cpu.finish();
        Ok(FrameStats {
            draw: draw?,
            masks: self.cpu.masks.stats,
        })
    }

    /// One tile of the page drawn in a part (tests): premultiplied RGBA8, `tile` × `tile`.
    #[doc(hidden)]
    pub fn debug_tile_part(&mut self, view: Affine, tile: u32, background: [f32; 4], split: &Split) -> Result<Vec<u8>> {
        self.cpu_draw_tile_split(view, tile, 0, false, background, split)?;
        Ok(self.cpu.target.data_as_u8_slice().to_vec())
    }

    /// A frame made of tiles on the CPU (decision 0040, phase 2): premultiplied RGBA8. What the
    /// GPU's tiles are held to; exact frames are bitwise what a fresh engine makes.
    pub fn render_cpu_tiled(
        &mut self,
        width: u32,
        height: u32,
        camera: Camera,
        background: [f32; 4],
        options: TiledOptions,
    ) -> Result<(&[u8], TiledStats)> {
        self.check_size(width, height)?;
        camera.check()?;
        self.check_supported()?;
        if self.cpu_tiles.is_none() {
            self.use_cpu_tiles(crate::tiles::TILE, 256);
        }
        let view = camera.view();
        let halo = self.halo(view)?;
        let mut tiles = self.cpu_tiles.take().expect("made above");
        let result = self.cpu_tiled_frame(&mut tiles, width, height, view, halo, background, options);
        self.cpu_tiles = Some(tiles);
        let mut stats = result?;
        // No frame is exact while text is still to come: it may paint past its box.
        if self.store.provisional_shown().is_some() {
            stats.exact = false;
        }
        Ok((self.cpu_tiles.as_ref().map_or(&[][..], |t| t.frame.as_slice()), stats))
    }

    /// Draws tiles on the CPU for the next frame of the view last drawn (`Gpu::ahead`'s twin,
    /// at most `max_jobs` tiles): what the tests hold the GPU's idle drawing to.
    pub fn render_cpu_ahead(&mut self, background: [f32; 4], max_jobs: usize) -> Result<TiledStats> {
        self.check_supported()?;
        let Some(mut tiles) = self.cpu_tiles.take() else {
            return Ok(TiledStats::default());
        };
        let result = (|| {
            let mut stats = TiledStats::default();
            let Some(last) = tiles.last else { return Ok(stats) };
            let halo = self.halo(last.view)?;
            let tile = tiles.cache.tile;
            tiles.cache.begin(background, halo);
            let Some(plan) = tiles.cache.plan(last.view, last.size, false, Some(last), true) else {
                return Ok(stats);
            };
            let t = tile as usize;
            let side = t + 2 * halo.max(0) as usize;
            let h = halo.max(0) as usize;
            for job in plan.jobs.iter().filter(|j| !plan.direct && !j.direct).take(max_jobs) {
                let Some(slot) = tiles.cache.slot_for(job.key) else {
                    continue;
                };
                let fs = match self.cpu_draw_tile(job.view, tile, halo, job.detail, background) {
                    Ok(fs) => fs,
                    Err(e) => {
                        tiles.cache.release(job.key, slot);
                        return Err(e);
                    }
                };
                stats.draw.add(&fs.draw);
                stats.tiles_drawn += 1;
                let s = slot as usize;
                if tiles.slots.len() <= s {
                    tiles.slots.resize_with(s + 1, Vec::new);
                }
                let out = &mut tiles.slots[s];
                out.clear();
                let target = self.cpu.target.data_as_u8_slice();
                for y in 0..t {
                    let from = ((y + h) * side + h) * 4;
                    out.extend_from_slice(&target[from..from + t * 4]);
                }
                tiles.cache.drawn(job.key, slot, fs.draw.exact(), !job.detail);
            }
            let (pending, _) = tiles.cache.left(&plan);
            stats.pending = pending;
            stats.held = tiles.cache.len() as u32;
            Ok(stats)
        })();
        self.cpu_tiles = Some(tiles);
        result
    }

    #[allow(clippy::too_many_arguments)]
    fn cpu_tiled_frame(
        &mut self,
        tiles: &mut CpuTiles,
        width: u32,
        height: u32,
        view: Affine,
        halo: i32,
        background: [f32; 4],
        options: TiledOptions,
    ) -> Result<TiledStats> {
        let tile = tiles.cache.tile;
        tiles.cache.begin(background, halo);
        let scale = view.as_coeffs()[0];
        let zooming = options.moving && tiles.last_scale.is_some_and(|s| s != scale);
        // A page just shown: under a budget, coarse tiles first (see `Gpu::render`).
        let opening = tiles.last.is_none() && tiles.cache.is_empty() && options.max_jobs != usize::MAX;
        let last = tiles.last;
        tiles.cache.opening = opening;
        let mut plan = tiles
            .cache
            .plan(view, (width, height), zooming || opening, last, options.prefetch)
            .ok_or_else(|| EngineError::limit("a camera the tiles can't follow (too far out)"))?;
        let mut stats = TiledStats {
            direct: plan.direct,
            ..TiledStats::default()
        };
        // A drag: the tiles its selection touches are composited from the page's parts below and
        // above it with the selection drawn afresh between (when that's exact), else drawn at its
        // real position every frame.
        let drag = self.drag_frame();
        let selection = tiles
            .cache
            .drag_prepare(&mut plan, drag.as_ref().map(DragFrame::input).as_ref());
        let bg = premultiply(background);
        let stride = width as usize * 4;
        let mut frame = std::mem::take(&mut tiles.frame);
        frame.clear();
        frame.resize(stride * height as usize, 0);
        for p in frame.as_chunks_mut::<4>().0.iter_mut() {
            p.copy_from_slice(&bg);
        }
        let t = tile as usize;
        let side = tile as usize + 2 * halo.max(0) as usize;
        // The tile's own pixels, out of the target drawn with its halo.
        let take = |target: &[u8], out: &mut Vec<u8>| {
            out.clear();
            out.reserve(t * t * 4);
            let h = halo.max(0) as usize;
            for y in 0..t {
                let from = ((y + h) * side + h) * 4;
                out.extend_from_slice(&target[from..from + t * 4]);
            }
        };
        let mut optional = 0usize;
        let mut exact_direct = true;
        let mut scratch = Vec::new();
        // Drawn straight into the frame after it's laid: what no slot could be kept for.
        let mut late: Vec<crate::tiles::Job> = Vec::new();
        for job in &plan.jobs {
            if !job.must {
                if optional >= options.max_jobs {
                    continue;
                }
                optional += 1;
            }
            if plan.direct || job.direct {
                late.push(*job);
                continue;
            }
            let Some(slot) = tiles.cache.slot_for(job.key) else {
                if job.must {
                    late.push(*job);
                }
                continue;
            };
            let fs = match self.cpu_draw_tile(job.view, tile, halo, job.detail, background) {
                Ok(fs) => fs,
                Err(e) => {
                    tiles.cache.release(job.key, slot);
                    return Err(e);
                }
            };
            stats.draw.add(&fs.draw);
            stats.tiles_drawn += 1;
            // Exact only if nothing stood in: no level of detail, no provisional record.
            let exact = fs.draw.exact();
            let s = slot as usize;
            if tiles.slots.len() <= s {
                tiles.slots.resize_with(s + 1, Vec::new);
            }
            take(self.cpu.target.data_as_u8_slice(), &mut tiles.slots[s]);
            tiles.cache.drawn(job.key, slot, exact, !job.detail);
        }
        let mut comp_exact = true;
        if !plan.direct {
            // What's drawn straight into the frame after it covers its tile there: the composite
            // counts it so (what no slot could be found for included).
            for job in plan.jobs.iter_mut() {
                if late.iter().any(|l| l.key == job.key) {
                    job.direct = true;
                }
            }
            let comp = tiles.cache.compose(&plan, last);
            comp_exact = comp.exact;
            stats.pending = comp.pending;
            if !comp.complete {
                if let (Some(m), Some(l)) = (comp.base, last) {
                    // The last frame, moved and scaled (nearest pixel: a stand-in).
                    let prev = tiles.frame_last.clone();
                    let inv = m.inverse();
                    let (lw, lh) = (l.size.0 as i64, l.size.1 as i64);
                    if prev.len() == (lw * lh * 4) as usize {
                        for y in 0..height as usize {
                            for x in 0..width as usize {
                                let p = inv * vello_common::kurbo::Point::new(x as f64 + 0.5, y as f64 + 0.5);
                                let (sx, sy) = (p.x.floor() as i64, p.y.floor() as i64);
                                if sx >= 0 && sy >= 0 && sx < lw && sy < lh {
                                    let from = ((sy * lw + sx) * 4) as usize;
                                    let to = y * stride + x * 4;
                                    frame[to..to + 4].copy_from_slice(&prev[from..from + 4]);
                                }
                            }
                        }
                    }
                }
                for sc in &comp.scaled {
                    let Some(src) = tiles.slots.get(sc.slot as usize) else {
                        continue;
                    };
                    if src.len() != t * t * 4 {
                        continue;
                    }
                    let d = sc.dst;
                    let x0 = d.x0.max(0.0).floor() as usize;
                    let y0 = d.y0.max(0.0).floor() as usize;
                    let x1 = (d.x1.min(f64::from(width))).ceil().max(0.0) as usize;
                    let y1 = (d.y1.min(f64::from(height))).ceil().max(0.0) as usize;
                    for y in y0..y1.min(height as usize) {
                        let v = ((y as f64 + 0.5 - d.y0) / d.height() * t as f64).floor();
                        if !(0.0..t as f64).contains(&v) {
                            continue;
                        }
                        for x in x0..x1.min(width as usize) {
                            let u = ((x as f64 + 0.5 - d.x0) / d.width() * t as f64).floor();
                            if !(0.0..t as f64).contains(&u) {
                                continue;
                            }
                            let from = (v as usize * t + u as usize) * 4;
                            let to = y * stride + x * 4;
                            frame[to..to + 4].copy_from_slice(&src[from..from + 4]);
                        }
                    }
                }
            }
            for c in &comp.copies {
                let Some(src) = tiles.slots.get(c.slot as usize) else {
                    continue;
                };
                let cols = (c.src.x1 - c.src.x0) as usize * 4;
                for r in 0..(c.src.y1 - c.src.y0) as usize {
                    let from = ((c.src.y0 as usize + r) * t + c.src.x0 as usize) * 4;
                    let to = (c.dst.1 as usize + r) * stride + c.dst.0 as usize * 4;
                    frame[to..to + cols].copy_from_slice(&src[from..from + cols]);
                }
            }
        }
        for job in &late {
            let fs = self.cpu_draw_tile(job.view, tile, halo, job.detail, background)?;
            stats.draw.add(&fs.draw);
            stats.tiles_drawn += 1;
            exact_direct &= fs.draw.exact();
            take(self.cpu.target.data_as_u8_slice(), &mut scratch);
            let fx = i64::from(job.key.i) * i64::from(tile) + plan.origin.0;
            let fy = i64::from(job.key.j) * i64::from(tile) + plan.origin.1;
            blit(&mut frame, width, height, &scratch, t, fx, fy);
        }
        stats.exact = comp_exact && exact_direct;
        stats.direct = plan.direct || !late.is_empty();
        if let (Some(d), Some(now), Some(level)) = (&drag, selection, tiles.cache.level(plan.level))
            && let Some(split) = d.split.as_ref()
        {
            for dt in tiles.cache.drag_tiles(&plan, now) {
                let view = level.tile_view(dt.i, dt.j, tile);
                let fx = i64::from(dt.i) * i64::from(tile) + plan.origin.0;
                let fy = i64::from(dt.j) * i64::from(tile) + plan.origin.1;
                // The parts below and above, kept for the drag; the selection drawn afresh.
                let mut parts = [None, None];
                for (k, (pseudo, pass, fill)) in [
                    (crate::tiles::DRAG_BELOW, Pass::Below, background),
                    (crate::tiles::DRAG_ABOVE, Pass::Above, [0.0; 4]),
                ]
                .into_iter()
                .enumerate()
                {
                    let key = crate::tiles::TileKey {
                        level: pseudo,
                        i: dt.i,
                        j: dt.j,
                    };
                    parts[k] = match tiles.cache.take_slot(&key) {
                        Some(slot) => Some(slot),
                        None => match tiles.cache.slot_for(key) {
                            Some(slot) => {
                                let part = Split { pass, ..split.clone() };
                                if let Err(e) = self.cpu_draw_tile_split(view, tile, halo, false, fill, &part) {
                                    tiles.cache.release(key, slot);
                                    return Err(e);
                                }
                                let s = slot as usize;
                                if tiles.slots.len() <= s {
                                    tiles.slots.resize_with(s + 1, Vec::new);
                                }
                                take(self.cpu.target.data_as_u8_slice(), &mut tiles.slots[s]);
                                tiles.cache.drawn(key, slot, true, true);
                                Some(slot)
                            }
                            None => None,
                        },
                    };
                }
                let [Some(below), Some(above)] = parts else {
                    // No room to keep the parts: the tile drawn whole and exact, straight into
                    // the frame, never left showing the selection where it was (or nothing).
                    let fs = self.cpu_draw_tile(view, tile, halo, false, background)?;
                    stats.draw.add(&fs.draw);
                    stats.tiles_drawn += 1;
                    take(self.cpu.target.data_as_u8_slice(), &mut scratch);
                    blit(&mut frame, width, height, &scratch, t, fx, fy);
                    stats.direct = true;
                    continue;
                };
                blit(&mut frame, width, height, &tiles.slots[below as usize], t, fx, fy);
                if dt.selection {
                    let part = Split {
                        pass: Pass::Selection,
                        ..split.clone()
                    };
                    self.cpu_draw_tile_split(view, tile, halo, false, [0.0; 4], &part)?;
                    take(self.cpu.target.data_as_u8_slice(), &mut scratch);
                    blend(&mut frame, width, height, &scratch, t, fx, fy);
                }
                blend(&mut frame, width, height, &tiles.slots[above as usize], t, fx, fy);
                stats.dragged += 1;
                stats.exact = false;
            }
        }
        stats.evicted = tiles.cache.stats.evicted;
        stats.held = tiles.cache.len() as u32;
        tiles.frame_last.clone_from(&frame);
        tiles.frame = frame;
        tiles.last = Some(Last {
            view,
            size: (width, height),
        });
        tiles.last_scale = Some(scale);
        Ok(stats)
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
        self.check_supported()?;
        self.check_settled()?;
        let most = self.band_rows(width);
        if rows == 0 || rows > most || y0.checked_add(rows).is_none_or(|end| end > height) {
            return Err(EngineError::new(
                ErrorCode::Limit,
                format!(
                    "a band of {rows} rows at {y0} in a frame {height} tall; bands {width} px wide are at most {most} rows"
                ),
            ));
        }
        let stride = width as usize * 4;
        let mut band = std::mem::take(&mut self.band);
        let band_bytes = stride * rows as usize;
        band.clear();
        band.resize(band_bytes, 0);
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
                let (_, grown) = self.cpu_tile(width, height, camera, background, false, area, band_bytes)?;
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

/// Copies a `t` × `t` tile into a `width` × `height` frame with its top left at (`fx`, `fy`),
/// clipped to the frame.
fn blit(frame: &mut [u8], width: u32, height: u32, tile: &[u8], t: usize, fx: i64, fy: i64) {
    let (w, h) = (i64::from(width), i64::from(height));
    let ti = t as i64;
    let (x0, y0) = (fx.max(0), fy.max(0));
    let (x1, y1) = ((fx + ti).min(w), (fy + ti).min(h));
    if x1 <= x0 || y1 <= y0 || tile.len() < t * t * 4 {
        return;
    }
    let cols = (x1 - x0) as usize * 4;
    for y in y0..y1 {
        let from = (((y - fy) * ti + (x0 - fx)) * 4) as usize;
        let to = ((y * w + x0) * 4) as usize;
        frame[to..to + cols].copy_from_slice(&tile[from..from + cols]);
    }
}

/// Lays a `t` × `t` premultiplied tile over a frame (source over) with its top left at (`fx`,
/// `fy`), clipped to the frame.
fn blend(frame: &mut [u8], width: u32, height: u32, tile: &[u8], t: usize, fx: i64, fy: i64) {
    let (w, h) = (i64::from(width), i64::from(height));
    let ti = t as i64;
    let (x0, y0) = (fx.max(0), fy.max(0));
    let (x1, y1) = ((fx + ti).min(w), (fy + ti).min(h));
    if x1 <= x0 || y1 <= y0 || tile.len() < t * t * 4 {
        return;
    }
    for y in y0..y1 {
        for x in x0..x1 {
            let from = (((y - fy) * ti + (x - fx)) * 4) as usize;
            let to = ((y * w + x) * 4) as usize;
            let a = u32::from(tile[from + 3]);
            if a == 0 {
                continue;
            }
            for c in 0..4 {
                let d = u32::from(frame[to + c]);
                frame[to + c] = (u32::from(tile[from + c]) + (d * (255 - a) + 127) / 255).min(255) as u8;
            }
        }
    }
}
