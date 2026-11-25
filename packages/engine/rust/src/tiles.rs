//! Board textures (decision 0040, phase 2): the page's picture kept as tiles, so pans, zooms and
//! the exact frame after the camera rests are made of pixels already drawn instead of a scene
//! encoded again. Decided apart from either backend, so it's tested natively; `engine.rs` runs it
//! on the CPU and `gpu.rs` on the GPU.
//!
//! - **What a tile holds.** The page is a scope (0040, "The render graph"): a tile holds the
//!   page's own composited result, background included, over `tile` × `tile` device pixels of a
//!   level's grid. It's the final picture there, so a frame shows it by copying it, and nothing
//!   is composited twice (a board drawn alone and laid over the page would differ from a fresh
//!   render by rounding at every translucent edge, and would be wrong under readers that read
//!   through it).
//! - **Levels.** A level is a raster scale (device pixels per page unit) and a phase (where the
//!   page's origin falls within a device pixel). A frame at that scale and phase lies on the
//!   level's grid exactly: frame pixel = grid pixel + a whole-pixel origin. A tile is drawn under
//!   its own view, a function of its level and its place only, so its pixels never depend on
//!   which frame asked for it, and an exact frame is bitwise the frame a fresh engine would make.
//! - **Stand-ins.** While the camera moves, a tile not drawn yet at the frame's level shows a
//!   stand-in: the same tile before an edit (stale), tiles of another level scaled, or the last
//!   frame moved. Zooming draws coarse "ladder" levels (scales in steps of √2, level of detail
//!   on) where nothing covers the view, never tiles of a scale that's gone a frame later. A
//!   frame with any stand-in on screen is never reported exact.
//! - **Invalidation.** Each patch's changes (page units, with the render graph's paint order)
//!   are turned into each level's grid pixels by `Store::dirty` (readers transitively), and every
//!   tile they touch is marked stale. A fresh list, a change of background or of the readers'
//!   reach drops everything.
//! - **Budget.** Tiles live in slots (`max_slots`, set from the engine's GPU budget). Over it, the
//!   tile least worth keeping goes: other levels before the frame's (finer first), then the
//!   frame level's farthest from the view, then the least recently used. A frame pins what it
//!   shows and what it counts on to stand in, and plans its jobs within the slots left: what
//!   nothing stands in for first (whatever the time budget), then what waits. Coverage is
//!   planned over the part of each tile on screen. What can't be given a slot is drawn straight
//!   into the frame without being kept (`Job::direct`); if the frame's own tiles can't fit at
//!   all, the whole frame is (`Plan::direct`): slower, still exact, never blank.

use crate::exec::IRect;
use std::collections::{HashMap, HashSet};
use vello_common::kurbo::{Affine, Rect};

/// A tile's side in device pixels, in the browser (decision 0040, "Tiles").
pub const TILE: u32 = 512;

/// A raster level: device pixels per page unit, and the phase of the page's origin within a
/// device pixel (each in [0, 1)).
#[derive(Clone, Copy, Debug)]
pub struct Level {
    pub scale: f64,
    pub phase: (f64, f64),
}

impl PartialEq for Level {
    fn eq(&self, o: &Level) -> bool {
        self.scale.to_bits() == o.scale.to_bits()
            && self.phase.0.to_bits() == o.phase.0.to_bits()
            && self.phase.1.to_bits() == o.phase.1.to_bits()
    }
}

/// Grid origins past this many device pixels are refused (a frame there is drawn directly).
const FAR: f64 = (1u64 << 40) as f64;

impl Level {
    /// The level a frame drawn under `view` lies on, and the frame pixel the level's grid
    /// origin falls on. None for a view that isn't a positive uniform scale and a translation
    /// (the editor's cameras always are) or lies too far out.
    pub fn of(view: Affine) -> Option<(Level, (i64, i64))> {
        let [a, b, c, d, e, f] = view.as_coeffs();
        let ok = view.as_coeffs().iter().all(|v| v.is_finite())
            && b == 0.0
            && c == 0.0
            && a == d
            && a > 0.0
            && e.abs() < FAR
            && f.abs() < FAR;
        if !ok {
            return None;
        }
        // Ignore the floating-point drift from adding whole pixels to a fraction.
        const PHASE_STEPS: f64 = 1_048_576.0;
        let e = (e * PHASE_STEPS).round() / PHASE_STEPS;
        let f = (f * PHASE_STEPS).round() / PHASE_STEPS;
        let (nx, ny) = (e.floor(), f.floor());
        Some((
            Level {
                scale: a,
                phase: ((e - nx).clamp(0.0, 1.0), (f - ny).clamp(0.0, 1.0)),
            },
            (nx as i64, ny as i64),
        ))
    }

    /// Page units to the level's grid pixels.
    pub fn grid(&self) -> Affine {
        Affine::new([self.scale, 0.0, 0.0, self.scale, self.phase.0, self.phase.1])
    }

    /// Page units to tile (`i`, `j`)'s own pixels: the only view a tile is ever drawn under.
    pub fn tile_view(&self, i: i32, j: i32, tile: u32) -> Affine {
        let t = f64::from(tile);
        Affine::new([
            self.scale,
            0.0,
            0.0,
            self.scale,
            self.phase.0 - f64::from(i) * t,
            self.phase.1 - f64::from(j) * t,
        ])
    }

    /// The ladder level just at or above `scale`: the smallest scale of the form 2^(k/2) not
    /// below it, phase 0. A page just opened starts at the one at or above a quarter of its
    /// scale, so it's never more than 4× coarser and always stands in (`stands_in`).
    pub fn ladder_at_least(scale: f64) -> Level {
        let k = (2.0 * scale.log2()).ceil().clamp(-60.0, 60.0);
        Level {
            scale: (k / 2.0).exp2(),
            phase: (0.0, 0.0),
        }
    }

    /// The coarse level a zoom draws where nothing covers the view: the largest scale of the
    /// form 2^(k/2) at or below `scale`, phase 0 (decision 0040: scales step by √2).
    pub fn ladder(scale: f64) -> Level {
        let k = (2.0 * scale.log2()).floor().clamp(-60.0, 60.0);
        Level {
            scale: (k / 2.0).exp2(),
            phase: (0.0, 0.0),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct TileKey {
    pub level: u32,
    pub i: i32,
    pub j: i32,
}

#[derive(Clone, Copy, Debug)]
pub struct TileEntry {
    /// Where its pixels live in the backend's storage.
    pub slot: u32,
    /// Drawn with no level of detail (no bars for small text, no specks skipped).
    pub exact: bool,
    /// Drawn at full detail (no level of detail): nothing to draw again until it's stale, even
    /// when it isn't exact (a provisional record in it, display list 1.1: what the list holds
    /// now, drawn as well as it can be).
    pub full: bool,
    /// Something it shows changed since it was drawn (an edit, an image replaced): it shows what's
    /// gone, so it stands in for nothing, not even itself, until drawn again.
    pub stale: bool,
    /// An image in it has another resolution now (a sharper level arrived, or one was dropped):
    /// the same picture, so it stands in, but it's never exact until drawn again.
    pub refine: bool,
    /// It holds an effect drawn on a reduced grid (a layer blur past the native limits): not
    /// exact, and nothing to draw again for.
    pub reduced: bool,
    /// The frame it was last shown or drawn in.
    pub used: u64,
}

impl TileEntry {
    /// Nothing to draw it again for: drawn at full detail and still current.
    pub fn current(&self) -> bool {
        !self.stale && !self.refine && self.full
    }
}

#[derive(Clone, Copy, Debug)]
struct LevelEntry {
    id: u32,
    level: Level,
    /// A ladder level: drawn with level of detail, only as a stand-in.
    ladder: bool,
    /// The reader halo width this level's tiles were baked with.
    halo: i32,
    used: u64,
    /// The overview's level (`set_overview`): its own entry, never a frame's or a stand-in's.
    overview: bool,
}

/// A tile to draw this frame.
#[derive(Clone, Copy, Debug)]
pub struct Job {
    pub key: TileKey,
    /// Page units to the tile's pixels.
    pub view: Affine,
    /// Levels of detail allowed (a ladder tile, a stand-in only).
    pub detail: bool,
    /// Nothing else can stand in for it on screen: drawn even past the frame's time budget.
    pub must: bool,
    /// No slot can be kept for it this frame (the budget): drawn straight into the frame, over
    /// what the frame composites, and kept nowhere. Always `must`, never `detail`.
    pub direct: bool,
    /// A rough stand-in (an overview tile, `exec::Backend::rough`): never exact, and never
    /// drawn for a frame's own level.
    pub rough: bool,
}

/// How a frame is made.
#[derive(Clone, Debug)]
pub struct Plan {
    /// The frame's level, and where its grid origin lands in the frame.
    pub level: u32,
    pub origin: (i64, i64),
    pub size: (u32, u32),
    /// Tiles of the frame's level it shows.
    pub visible: Vec<(i32, i32)>,
    /// Tiles to draw, the most wanted first.
    pub jobs: Vec<Job>,
    /// The frame's own tiles can't all be kept (the budget): draw them one at a time straight
    /// into the frame, keeping none.
    pub direct: bool,
    /// The camera's scale changed since the last frame: tiles of this level would be wasted.
    pub zooming: bool,
}

impl Plan {
    pub fn shows(&self, key: TileKey) -> bool {
        key.level == self.level && self.visible.contains(&(key.i, key.j))
    }

    /// A coarse opening tile can be required even when it uses a different level.
    pub fn needs_on_screen(&self, job: &Job) -> bool {
        job.must || self.shows(job.key)
    }
}

/// A tile of the frame's level laid into the frame, pixel for pixel.
#[derive(Clone, Copy, Debug)]
pub struct Copy {
    pub slot: u32,
    /// The part of the tile shown (its own pixels).
    pub src: IRect,
    /// Where that part's top left lands in the frame.
    pub dst: (i32, i32),
}

/// A tile of another level, scaled into the frame (a stand-in).
#[derive(Clone, Copy, Debug)]
pub struct Scaled {
    pub slot: u32,
    /// Where the whole tile lands, in frame pixels.
    pub dst: Rect,
}

/// What a frame shows, back to front: the last frame (mapped by `base`), other levels' tiles
/// scaled, then the frame level's tiles copied.
#[derive(Clone, Debug, Default)]
pub struct Composite {
    /// The last frame, mapped into this one (its device pixels to this frame's): a stand-in
    /// under whatever the tiles don't cover.
    pub base: Option<Affine>,
    /// Where the last frame's pixels are old (this frame's pixels): what changed since it was
    /// drawn, while moving. The last frame isn't laid there; the overview or the background shows.
    pub holes: Vec<Rect>,
    /// The overview's tiles, scaled, beneath the last frame: what shows where nothing else does.
    pub under: Vec<Scaled>,
    pub scaled: Vec<Scaled>,
    pub copies: Vec<Copy>,
    /// Every visible tile of the frame's level is there, up to date and drawn exactly: the
    /// frame is exactly what a fresh engine would draw.
    pub exact: bool,
    /// Every visible tile of the frame's level is there (some may be stale): nothing beneath
    /// them shows.
    pub complete: bool,
    /// Tiles the frame shows that are stale or missing.
    pub pending: u32,
    /// Tiles the frame shows that hold an effect drawn on a reduced grid.
    pub reduced: u32,
}

/// The last frame, as a stand-in: the view it was drawn under and its size.
#[derive(Clone, Copy, Debug)]
pub struct Last {
    pub view: Affine,
    pub size: (u32, u32),
}

#[derive(Default, Clone, Copy, Debug)]
pub struct TileStats {
    pub drawn: u32,
    pub evicted: u32,
    pub held: u32,
}

pub struct TileCache {
    pub tile: u32,
    /// Slots the backend may hold at once (each a tile's pixels).
    pub max_slots: usize,
    levels: Vec<LevelEntry>,
    tiles: HashMap<TileKey, TileEntry>,
    free: Vec<u32>,
    slots: u32,
    frame: u64,
    next_level: u32,
    background: Option<[u32; 4]>,
    halo: i32,
    /// The frame level and view centre (grid pixels) of the last plan: eviction keeps what's near.
    focus: Option<(u32, f64, f64)>,
    drag: DragTiles,
    /// The next plan is a page's first frame (set by the backend): its stand-in is coarser.
    pub opening: bool,
    /// Tiles an ended drag's selection was over, still stale: they show it where it was, so
    /// they're drawn again at once.
    ghosts: HashSet<TileKey>,
    /// Tiles whose `must` draw yielded or deferred under a frame budget so `last_page` does not
    /// mistakenly count their blank region as covered on the next frame.
    unpainted: HashSet<TileKey>,
    /// The whole page at one coarse scale (`set_overview`): drawn at rest after the frame's own
    /// tiles and kept, it stands in for any scale while the camera moves, so a zoom out shows
    /// it where nothing else covers instead of drawing full detail mid-gesture.
    overview: Option<Overview>,
    /// The next plan is for a frame while the camera moves (set by the backend): the overview
    /// stands in there.
    pub moving: bool,
    /// The frame the next is laid on (the last frame drawn) isn't the one on screen: a stand-in
    /// after a limit was shown since (set by the backend). Where something changed since that
    /// frame was drawn, it would show older pixels than the screen did, so it's laid round them
    /// (`holes`). Otherwise it's what's on screen, laid as it is until what changed is drawn.
    pub base_kept: bool,
    /// The next plan may draw the overview's tiles (set by the backend: frames at rest with a
    /// budget, and the time between frames; never a frame drawn at once, nor one in motion).
    pub bake_overview: bool,
    /// What changed (page units) since the frame the next is laid on (the last frame drawn) was
    /// drawn (`note_changed`). That frame shows older pixels there than the current version: if
    /// it's still the one on screen, it may be laid as it is until they're drawn (display never
    /// goes back); if a stand-in was shown since (`base_kept`), it's laid round them (`holes`).
    /// A frame drawn forgets them (`frame_drawn`): no stale tile is ever laid in one.
    changed: Vec<Rect>,
    /// Where an image got another resolution (page units) since the last frame was drawn
    /// (`note_refined`): not a change, so never a hole, but a frame drawn over several frames
    /// keeps no tiles to mark, and draws its tiles there again (`refined_on`). A frame drawn
    /// forgets them (`frame_drawn`).
    refined: Vec<Rect>,
    /// An overview tile failed to draw (past a limit, say): none is kept until the cache clears.
    overview_refused: bool,
    /// Overview tiles dropped (a cleared cache, a refused or moved overview): diagnostics.
    pub overview_lost: u32,
    pub stats: TileStats,
}

/// The overview's level and the tiles of it the page covers.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Overview {
    id: u32,
    span: (i32, i32, i32, i32),
}

impl Overview {
    /// Its tiles across and down.
    fn grid(&self) -> (u32, u32) {
        (
            (self.span.2 - self.span.0 + 1) as u32,
            (self.span.3 - self.span.1 + 1) as u32,
        )
    }
}

/// Overview tiles live in slots from here on, kept apart from the frames' (the backend gives them
/// their own storage, `slot - OVERVIEW_SLOT` in rows of `overview_grid().0`): no frame's tile
/// takes their place, and a cache cut to fit memory keeps them.
pub const OVERVIEW_SLOT: u32 = 1 << 31;

/// The overview's tiles at most, across and down (its storage is one texture).
const OVERVIEW_GRID: u32 = 8;

/// The whole page fits the overview in this many device pixels a side (at most 9 tiles at 512).
pub const OVERVIEW_SIDE: f64 = 1024.0;

/// Levels kept at once: more are dropped least recently used first.
const LEVELS: usize = 8;

/// `r` less `holes`, as rectangles that don't overlap (each cut leaves at most four).
pub fn rect_minus(r: Rect, holes: &[Rect]) -> Vec<Rect> {
    let mut parts = vec![r];
    for h in holes {
        let mut next = Vec::with_capacity(parts.len() + 3);
        for p in parts {
            let cut = p.intersect(*h);
            if cut.width() <= 0.0 || cut.height() <= 0.0 {
                next.push(p);
                continue;
            }
            // Above, below, then left and right of the cut.
            next.push(Rect::new(p.x0, p.y0, p.x1, cut.y0));
            next.push(Rect::new(p.x0, cut.y1, p.x1, p.y1));
            next.push(Rect::new(p.x0, cut.y0, cut.x0, cut.y1));
            next.push(Rect::new(cut.x1, cut.y0, p.x1, cut.y1));
        }
        parts = next
            .into_iter()
            .filter(|q| q.width() > 0.0 && q.height() > 0.0)
            .collect();
    }
    parts
}

/// Gives a dropped tile's slot back for another, unless it's the overview's own (`OVERVIEW_SLOT`).
fn give_back(free: &mut Vec<u32>, slot: u32) {
    if slot < OVERVIEW_SLOT {
        free.push(slot);
    }
}

/// Whether tiles of a level at scale `other` may stand in for a frame at `scale`: within 4× either
/// way. One rule for the plan (what it counts on) and the composite (what it lays).
pub fn stands_in(scale: f64, other: f64) -> bool {
    (other / scale).log2().abs() <= 2.0
}

/// Pseudo-levels of a drag's tiles at the frame's level (decision 0040, "Dragging"): the page
/// with everything painted before the dragged selection (background included), and everything
/// painted after it (over nothing). Never invalidated by patches: a drag lasts only while the
/// messages are moves of its selection, which change neither.
pub const DRAG_BELOW: u32 = u32::MAX - 1;
pub const DRAG_ABOVE: u32 = u32::MAX - 2;

/// A drag as the tiles see it: which drag, the level its tiles are for, the moves seen, and
/// the tiles the selection has been over (their own tiles are stale until drawn again).
#[derive(Default, Debug)]
struct DragTiles {
    serial: u64,
    level: Option<u32>,
    seen: u64,
    touched: HashSet<(i32, i32)>,
    /// Where the selection was drawn in the last frame (page units): that frame's pixels show
    /// it there, whether or not a tile of its own was kept, so where they're on screen the drag
    /// composites them again (without it, once it's gone).
    last: Option<Rect>,
}

/// A drag as a frame's tiles need it: which drag, its moves, where its selection was when it
/// began and is now (page units), and whether moving its picture is exact (the fast path).
#[derive(Clone, Copy, Debug)]
pub struct DragInput {
    pub serial: u64,
    pub moves: u64,
    pub start: Option<Rect>,
    pub now: Rect,
    pub eligible: bool,
}

/// A tile a drag composites this frame: the part below, the selection (drawn afresh at its
/// real position, when it's over the tile), and the part above.
#[derive(Clone, Copy, Debug)]
pub struct DragTile {
    pub i: i32,
    pub j: i32,
    pub selection: bool,
}

fn overlaps(a: Rect, b: Rect) -> bool {
    a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1
}

impl TileCache {
    pub fn new(tile: u32, max_slots: usize) -> Self {
        Self {
            tile: tile.max(1),
            max_slots,
            levels: Vec::new(),
            tiles: HashMap::new(),
            free: Vec::new(),
            slots: 0,
            frame: 0,
            next_level: 0,
            background: None,
            halo: 0,
            focus: None,
            drag: DragTiles::default(),
            opening: false,
            ghosts: HashSet::new(),
            unpainted: HashSet::new(),
            overview: None,
            moving: false,
            base_kept: false,
            bake_overview: false,
            changed: Vec::new(),
            refined: Vec::new(),
            overview_lost: 0,
            overview_refused: false,
            stats: TileStats::default(),
        }
    }

    /// Sets the overview for a page whose shown content lies in `page` (page units), each frame
    /// (it keeps its level in use): the ladder level that fits the page in `OVERVIEW_SIDE`
    /// device pixels a side. None (no content, or out of range) drops it.
    pub fn set_overview(&mut self, page: Option<Rect>) {
        let page = page.filter(|r| !self.overview_refused && r.is_finite() && r.width() > 0.0 && r.height() > 0.0);
        let wanted = page.and_then(|page| {
            let scale = OVERVIEW_SIDE / page.width().max(page.height());
            if !(scale.is_finite() && scale > 0.0) {
                return None;
            }
            let level = Level::ladder(scale);
            let span = self.span(level.grid().transform_rect_bbox(page))?;
            let (cols, rows) = (
                i64::from(span.2) - i64::from(span.0) + 1,
                i64::from(span.3) - i64::from(span.1) + 1,
            );
            if cols > i64::from(OVERVIEW_GRID) || rows > i64::from(OVERVIEW_GRID) {
                return None;
            }
            Some((level, span))
        });
        let id = wanted.map(|(level, _)| self.overview_level_id(level));
        let next = wanted.zip(id).map(|((_, span), id)| Overview { id, span });
        if let Some(old) = self.overview
            && next != Some(old)
        {
            // Moved (the page's content grew or shrank) or gone: its tiles sit where the new
            // one's would, so they go with it, and so does its level when that changed.
            self.drop_overview_tiles(old.id);
            if next.is_none_or(|n| n.id != old.id) {
                self.levels.retain(|e| e.id != old.id);
            }
        }
        self.overview = next;
    }

    /// The overview level's id, its own entry made if it's new.
    fn overview_level_id(&mut self, level: Level) -> u32 {
        let frame = self.frame;
        if let Some(e) = self.levels.iter_mut().find(|e| e.overview && e.level == level) {
            e.used = frame;
            return e.id;
        }
        self.new_level(level, true, true)
    }

    /// Drops the overview level's tiles (their storage is the backend's to free).
    fn drop_overview_tiles(&mut self, id: u32) {
        let before = self.tiles.len();
        self.tiles.retain(|k, _| k.level != id);
        self.overview_lost = self.overview_lost.wrapping_add((before - self.tiles.len()) as u32);
    }

    /// The overview's tiles across and down, when there is one: the backend's storage for them.
    pub fn overview_grid(&self) -> Option<(u32, u32)> {
        self.overview.map(|o| o.grid())
    }

    /// Where an overview tile lives (`OVERVIEW_SLOT` on), when `key` is one.
    fn overview_slot(&self, key: &TileKey) -> Option<u32> {
        let o = self.overview.filter(|o| o.id == key.level)?;
        if key.i < o.span.0 || key.i > o.span.2 || key.j < o.span.1 || key.j > o.span.3 {
            return None;
        }
        let (cols, _) = o.grid();
        Some(OVERVIEW_SLOT + (key.j - o.span.1) as u32 * cols + (key.i - o.span.0) as u32)
    }

    /// The overview, when it's coarser than anything that stands in for a frame at `scale`.
    fn coarse_overview(&self, scale: f64) -> Option<Overview> {
        let o = self.overview?;
        let l = self.level(o.id)?;
        (l.scale * 4.0 < scale).then_some(o)
    }

    /// The overview's tiles not up to date, as jobs (with level of detail, never `must`).
    fn overview_jobs(&self) -> Vec<Job> {
        let Some(o) = self.overview else {
            return Vec::new();
        };
        let Some(level) = self.level(o.id) else {
            return Vec::new();
        };
        let mut jobs = Vec::new();
        for j in o.span.1..=o.span.3 {
            for i in o.span.0..=o.span.2 {
                let key = TileKey { level: o.id, i, j };
                if self.tiles.get(&key).is_some_and(|e| !e.stale) {
                    continue;
                }
                jobs.push(Job {
                    key,
                    view: level.tile_view(i, j, self.tile),
                    detail: true,
                    must: false,
                    direct: false,
                    rough: true,
                });
            }
        }
        jobs
    }

    /// The overview's tiles under `page` (page units), when all are held and up to date: past
    /// the page's content there are none to hold, and the background is what shows there. A
    /// stale one (an edit, an image changed) never stands in: it would show what's gone.
    fn cover_overview(&self, o: Overview, page: Rect) -> Option<Vec<TileKey>> {
        let level = self.level(o.id)?;
        let (i0, j0, i1, j1) = self.span(level.grid().transform_rect_bbox(page))?;
        let (i0, j0, i1, j1) = (i0.max(o.span.0), j0.max(o.span.1), i1.min(o.span.2), j1.min(o.span.3));
        let mut keys = Vec::new();
        for j in j0..=j1 {
            for i in i0..=i1 {
                let key = TileKey { level: o.id, i, j };
                if !self.tiles.get(&key).is_some_and(|e| !e.stale) {
                    return None;
                }
                keys.push(key);
            }
        }
        Some(keys)
    }

    /// The overview's tiles to draw between frames for a view at `scale` (none when it isn't 4×
    /// coarser than the view).
    pub fn overview_ahead(&self, scale: f64) -> Vec<Job> {
        if self.coarse_overview(scale).is_none() {
            return Vec::new();
        }
        self.overview_jobs()
    }

    /// The overview's tiles still to draw between frames for a view at `scale`.
    pub fn overview_left(&self, scale: f64) -> u32 {
        if self.coarse_overview(scale).is_none() {
            return 0;
        }
        self.overview_jobs().len() as u32
    }

    /// Whether `key` is one of the overview's tiles.
    pub fn is_overview(&self, key: &TileKey) -> bool {
        self.overview.is_some_and(|o| o.id == key.level)
    }

    /// An overview tile couldn't be drawn: drops the overview until the cache clears (a fresh
    /// list, another background), so the time between frames never fails on it.
    pub fn refuse_overview(&mut self) {
        if let Some(o) = self.overview.take() {
            self.drop_overview_tiles(o.id);
            self.levels.retain(|e| e.id != o.id);
        }
        self.overview_refused = true;
    }

    /// Whether the overview is drawn (every tile of it held, none stale).
    pub fn overview_ready(&self) -> bool {
        self.overview.is_some() && self.overview_jobs().is_empty()
    }

    /// A frame's drag bookkeeping, shared by both backends: follows drag `d` (or ends the one
    /// held), notes the tiles its selection touched, drops jobs under a moving selection (the
    /// drag composites them) or, without a fast path, makes every touched tile's job one
    /// nothing stands in for, and redraws tiles an ended drag left. Answers where the selection
    /// is now, in the plan level's grid pixels, when the drag composites this frame.
    pub fn drag_prepare(&mut self, plan: &mut Plan, d: Option<&DragInput>) -> Option<Rect> {
        let out = match (d, self.level(plan.level)) {
            (Some(d), Some(level)) if !plan.direct => {
                let grid = level.grid();
                let moved = self.drag_frame(d.serial, d.moves, plan.level);
                let now = grid.transform_rect_bbox(d.now).inflate(2.0, 2.0);
                self.drag_prune(plan, now);
                if let Some(s) = d.start {
                    self.drag_touch(plan, grid.transform_rect_bbox(s).inflate(2.0, 2.0), false);
                }
                self.drag_touch(plan, now, true);
                if let Some(l) = self.drag.last {
                    self.drag_touch(plan, grid.transform_rect_bbox(l).inflate(2.0, 2.0), true);
                }
                self.drag.last = Some(d.now);
                if d.eligible {
                    if moved {
                        self.drag_skip(plan, now);
                    }
                    Some(now)
                } else {
                    self.must_touched(plan);
                    None
                }
            }
            _ => {
                self.drag_end();
                None
            }
        };
        self.must_ghosts(plan);
        out
    }

    /// Drops a drag's parts (below and above its selection) that rectangles of level `id`'s grid
    /// pixels touch, when the drag's tiles are for that level: an edit beside the drag changed
    /// them, so they're drawn again when next needed.
    pub fn drag_invalidate(&mut self, id: u32, rects: &[Rect]) {
        if self.drag.level != Some(id) {
            return;
        }
        let t = f64::from(self.tile);
        let free = &mut self.free;
        self.tiles.retain(|k, e| {
            if k.level != DRAG_BELOW && k.level != DRAG_ABOVE {
                return true;
            }
            let b = Rect::new(
                f64::from(k.i) * t,
                f64::from(k.j) * t,
                f64::from(k.i + 1) * t,
                f64::from(k.j + 1) * t,
            );
            let keep = !rects.iter().any(|r| overlaps(*r, b));
            if !keep {
                free.push(e.slot);
            }
            keep
        });
    }

    /// Drops a drag's tiles (it ended, or moved to another level).
    pub fn drag_end(&mut self) {
        if let Some(level) = self.drag.level {
            for &(i, j) in &self.drag.touched {
                self.ghosts.insert(TileKey { level, i, j });
            }
        }
        let free = &mut self.free;
        self.tiles.retain(|k, t| {
            let keep = k.level != DRAG_BELOW && k.level != DRAG_ABOVE;
            if !keep {
                free.push(t.slot);
            }
            keep
        });
        self.drag = DragTiles::default();
    }

    /// A frame of drag `serial`, after `moves` moves, at the plan's level: its tiles are kept
    /// while both stay the same. Answers whether it moved since the last frame.
    pub fn drag_frame(&mut self, serial: u64, moves: u64, level: u32) -> bool {
        if self.drag.serial != serial || self.drag.level != Some(level) {
            // The same drag at another level: the last frame still shows its selection where it
            // was, at whatever level that frame was drawn.
            let last = if self.drag.serial == serial {
                self.drag.last
            } else {
                None
            };
            self.drag_end();
            self.drag.serial = serial;
            self.drag.level = Some(level);
            self.drag.last = last;
        }
        let moved = self.drag.seen != moves;
        self.drag.seen = moves;
        moved
    }

    /// Notes the tiles of the plan's level a rectangle of its grid pixels covers as touched by
    /// the drag's selection (it was or is there), as far as frames need to know: tiles kept
    /// stale (their picture may show the selection where it was) and, when `shown`, tiles on
    /// screen. Bounded by the tiles kept and shown, however large the selection or long the drag.
    pub fn drag_touch(&mut self, plan: &Plan, r: Rect, shown: bool) {
        let t = f64::from(self.tile);
        let cell = |i: i32, j: i32| {
            Rect::new(
                f64::from(i) * t,
                f64::from(j) * t,
                f64::from(i + 1) * t,
                f64::from(j + 1) * t,
            )
        };
        if shown {
            for &(i, j) in &plan.visible {
                if overlaps(cell(i, j), r) {
                    self.drag.touched.insert((i, j));
                }
            }
        }
        for (k, e) in &self.tiles {
            if k.level == plan.level && e.stale && overlaps(cell(k.i, k.j), r) {
                self.drag.touched.insert((k.i, k.j));
            }
        }
    }

    /// Forgets the tiles the drag touched that no frame needs it to: those neither kept stale (a
    /// picture that may show the selection where it was) nor on screen under the selection now
    /// (`now`, grid pixels). Tiles go from the drag's record as their slots do.
    fn drag_prune(&mut self, plan: &Plan, now: Rect) {
        let t = f64::from(self.tile);
        let level = plan.level;
        let shown: HashSet<(i32, i32)> = plan.visible.iter().copied().collect();
        let tiles = &self.tiles;
        self.drag.touched.retain(|&(i, j)| {
            let stale = tiles.get(&TileKey { level, i, j }).is_some_and(|e| !e.current());
            let cell = Rect::new(
                f64::from(i) * t,
                f64::from(j) * t,
                f64::from(i + 1) * t,
                f64::from(j + 1) * t,
            );
            stale || (shown.contains(&(i, j)) && overlaps(cell, now))
        });
    }

    /// Whether a visible tile is one the drag composites: touched by the selection, and its own
    /// tile not up to date.
    fn dragged(&self, level: u32, i: i32, j: i32) -> bool {
        self.drag.touched.contains(&(i, j)) && !self.tiles.get(&TileKey { level, i, j }).is_some_and(|e| e.current())
    }

    /// The tiles the drag composites this frame: visible ones it touched whose own tile isn't up
    /// to date, and whether the selection (`selection`, grid pixels) is over each now.
    pub fn drag_tiles(&self, plan: &Plan, selection: Rect) -> Vec<DragTile> {
        let t = f64::from(self.tile);
        plan.visible
            .iter()
            .filter(|(i, j)| self.dragged(plan.level, *i, *j))
            .map(|&(i, j)| {
                let b = Rect::new(
                    f64::from(i) * t,
                    f64::from(j) * t,
                    f64::from(i + 1) * t,
                    f64::from(j + 1) * t,
                );
                DragTile {
                    i,
                    j,
                    selection: overlaps(b, selection),
                }
            })
            .collect()
    }

    /// Drops jobs for tiles under the moving selection that the drag composites: drawn now,
    /// they'd be stale again by the next move. Only those it touched (`drag_touch`), so nothing
    /// on screen is left without either.
    pub fn drag_skip(&self, plan: &mut Plan, selection: Rect) {
        let t = f64::from(self.tile);
        let level = plan.level;
        let touched = &self.drag.touched;
        plan.jobs.retain(|j| {
            if j.key.level != level || !touched.contains(&(j.key.i, j.key.j)) {
                return true;
            }
            let b = Rect::new(
                f64::from(j.key.i) * t,
                f64::from(j.key.j) * t,
                f64::from(j.key.i + 1) * t,
                f64::from(j.key.j + 1) * t,
            );
            !overlaps(b, selection)
        });
    }

    /// Marks jobs for the tiles an ended drag left showing its selection where it was as ones
    /// nothing stands in for.
    pub fn must_ghosts(&mut self, plan: &mut Plan) {
        if self.ghosts.is_empty() {
            return;
        }
        let tiles = &self.tiles;
        // Ghosts drawn since (or gone) are forgotten.
        self.ghosts
            .retain(|k| self.levels.iter().any(|l| l.id == k.level) && tiles.get(k).is_some_and(|e| e.stale));
        for j in plan.jobs.iter_mut() {
            if self.ghosts.contains(&j.key) {
                j.must = true;
            }
        }
    }

    /// Marks jobs for every tile the drag touched as ones nothing stands in for (a drag without
    /// a fast path draws its selection at its real position every frame, and leaves no copy of
    /// it where it was).
    pub fn must_touched(&self, plan: &mut Plan) {
        let level = plan.level;
        for j in plan.jobs.iter_mut() {
            if j.key.level == level && self.drag.touched.contains(&(j.key.i, j.key.j)) {
                j.must = true;
            }
        }
    }

    /// Marks jobs for tiles under a rectangle of grid pixels as ones nothing stands in for (a
    /// drag without a fast path draws its selection at its real position every frame).
    pub fn must_under(&self, plan: &mut Plan, r: Rect) {
        let t = f64::from(self.tile);
        let level = plan.level;
        for j in plan.jobs.iter_mut() {
            if j.key.level != level {
                continue;
            }
            let b = Rect::new(
                f64::from(j.key.i) * t,
                f64::from(j.key.j) * t,
                f64::from(j.key.i + 1) * t,
                f64::from(j.key.j + 1) * t,
            );
            if overlaps(b, r) {
                j.must = true;
            }
        }
    }

    /// Slots ever handed out (the backend's storage holds this many).
    pub fn slots(&self) -> u32 {
        self.slots
    }

    pub fn len(&self) -> usize {
        self.tiles.len()
    }

    pub fn is_empty(&self) -> bool {
        self.tiles.is_empty()
    }

    pub fn frame(&self) -> u64 {
        self.frame
    }

    /// Drops every tile and level (their slots stay, free, for reuse).
    pub fn clear(&mut self) {
        if let Some(o) = self.overview {
            self.drop_overview_tiles(o.id);
        }
        for (_, t) in self.tiles.drain() {
            give_back(&mut self.free, t.slot);
        }
        self.levels.clear();
        self.overview = None;
        self.overview_refused = false;
        self.focus = None;
        self.drag = DragTiles::default();
        self.ghosts.clear();
        self.unpainted.clear();
    }

    /// Drops every tile but the overview's, which keeps its own storage: memory runs short (a
    /// frame drawn at once needs what the tiles held), but what a zoom out stands on stays. A
    /// changed list or background still clears it (`clear`, `invalidate`).
    pub fn clear_keeping_overview(&mut self) {
        let keep = self.overview.map(|o| o.id);
        let free = &mut self.free;
        self.tiles.retain(|k, t| {
            let kept = Some(k.level) == keep;
            if !kept {
                give_back(free, t.slot);
            }
            kept
        });
        self.levels.retain(|e| Some(e.id) == keep);
        self.focus = None;
        self.drag = DragTiles::default();
        self.ghosts.clear();
        self.unpainted.clear();
    }

    /// Lowers or raises the slots kept; tiles in slots past a lower count are dropped.
    pub fn set_max_slots(&mut self, n: usize) {
        self.max_slots = n;
        if (self.slots as usize) > n {
            let cut = n as u32;
            self.tiles.retain(|_, t| t.slot < cut || t.slot >= OVERVIEW_SLOT);
            self.free.retain(|s| *s < cut);
            self.slots = cut;
        }
    }

    /// Starts a frame: a change of background or of the readers' reach (`halo`, which every
    /// tile is drawn with round it) drops everything.
    pub fn begin(&mut self, background: [f32; 4], halo: i32) {
        let bg = background.map(f32::to_bits);
        if self.background != Some(bg) || self.halo != halo {
            self.clear();
            self.background = Some(bg);
            self.halo = halo;
        }
        self.frame += 1;
        self.stats.drawn = 0;
        self.stats.evicted = 0;
    }

    /// Starts a frame at `scale` with reader reach `halo`: a background change still drops
    /// everything, while a halo change only drops levels at `scale` so cached tiles from other
    /// zoom scales stay resident as stand-ins and instant cache hits across zoom gestures.
    pub fn begin_scaled(&mut self, background: [f32; 4], scale: f64, halo: i32) {
        let bg = background.map(f32::to_bits);
        if self.background != Some(bg) {
            self.clear();
            self.background = Some(bg);
            self.halo = halo;
        } else {
            self.halo = halo;
            let tol = scale.abs() * 1e-6;
            let mut drop_levels: Vec<u32> = Vec::new();
            for entry in &mut self.levels {
                if !entry.ladder && !entry.overview && (entry.level.scale - scale).abs() <= tol && entry.halo != halo {
                    entry.halo = halo;
                    drop_levels.push(entry.id);
                }
            }
            if !drop_levels.is_empty() {
                let free = &mut self.free;
                self.tiles.retain(|k, t| {
                    let keep = !drop_levels.contains(&k.level);
                    if !keep {
                        give_back(free, t.slot);
                    }
                    keep
                });
                self.unpainted.retain(|k| !drop_levels.contains(&k.level));
                self.ghosts.retain(|k| !drop_levels.contains(&k.level));
            }
        }
        self.frame += 1;
        self.stats.drawn = 0;
        self.stats.evicted = 0;
    }

    /// The readers' reach the tiles were drawn with.
    pub fn halo(&self) -> i32 {
        self.halo
    }

    /// A level's id, made if it's new.
    pub fn level_id(&mut self, level: Level, ladder: bool) -> u32 {
        let frame = self.frame;
        if let Some(e) = self.levels.iter_mut().find(|e| !e.overview && e.level == level) {
            e.used = frame;
            e.ladder &= ladder;
            return e.id;
        }
        self.new_level(level, ladder, false)
    }

    fn new_level(&mut self, level: Level, ladder: bool, overview: bool) -> u32 {
        let frame = self.frame;
        if self.levels.len() >= LEVELS {
            // A level with no tiles goes first (a zoom passes through a scale a frame, drawing
            // none), else the least recently used, with its tiles.
            // Never one this frame uses (the frame's own level, made a moment before its ladder),
            // nor the overview's.
            let empty = |id: u32| !self.tiles.keys().any(|k| k.level == id);
            let old = |i: &usize| self.levels[*i].used < frame && !self.levels[*i].overview;
            let victim = (0..self.levels.len())
                .filter(old)
                .filter(|i| empty(self.levels[*i].id))
                .min_by_key(|i| self.levels[*i].used)
                .or_else(|| (0..self.levels.len()).filter(old).min_by_key(|i| self.levels[*i].used));
            if let Some(i) = victim {
                let gone = self.levels.remove(i).id;
                let free = &mut self.free;
                self.tiles.retain(|k, t| {
                    let keep = k.level != gone;
                    if !keep {
                        give_back(free, t.slot);
                    }
                    keep
                });
            }
        }
        let id = self.next_level;
        self.next_level = self.next_level.wrapping_add(1);
        self.levels.push(LevelEntry {
            id,
            level,
            ladder,
            halo: self.halo,
            used: frame,
            overview,
        });
        id
    }

    pub fn level(&self, id: u32) -> Option<Level> {
        self.levels.iter().find(|e| e.id == id).map(|e| e.level)
    }

    /// Every level held: its id and level, for invalidation.
    pub fn levels(&self) -> Vec<(u32, Level)> {
        self.levels.iter().map(|e| (e.id, e.level)).collect()
    }

    pub fn get(&self, key: &TileKey) -> Option<&TileEntry> {
        self.tiles.get(key)
    }

    /// A tile's slot, marking it used this frame (so no draw later in the frame evicts it).
    pub fn take_slot(&mut self, key: &TileKey) -> Option<u32> {
        let frame = self.frame;
        self.tiles.get_mut(key).map(|e| {
            e.used = frame;
            e.slot
        })
    }

    /// The tiles of level `id` a rectangle of its grid pixels touches.
    fn span(&self, r: Rect) -> Option<(i32, i32, i32, i32)> {
        if !(r.x0.is_finite() && r.y0.is_finite() && r.x1.is_finite() && r.y1.is_finite()) {
            return None;
        }
        let t = f64::from(self.tile);
        let c = |v: f64| v.clamp(-1.0e15, 1.0e15);
        let (i0, i1) = ((c(r.x0) / t).floor(), (c(r.x1) / t).ceil() - 1.0);
        let (j0, j1) = ((c(r.y0) / t).floor(), (c(r.y1) / t).ceil() - 1.0);
        let lim = f64::from(i32::MAX / 2);
        if i1 < i0 || j1 < j0 {
            return None;
        }
        Some((
            i0.max(-lim) as i32,
            j0.max(-lim) as i32,
            i1.min(lim) as i32,
            j1.min(lim) as i32,
        ))
    }

    /// Marks stale every tile of level `id` that rectangles of its grid pixels touch (pixels
    /// that may have changed, already grown for anti-aliasing and readers).
    pub fn invalidate(&mut self, id: u32, rects: &[Rect]) {
        if let Some(level) = self.level(id) {
            let page = level.grid().inverse();
            let changed: Vec<Rect> = rects.iter().map(|r| page.transform_rect_bbox(*r)).collect();
            self.note_changed(&changed);
        }
        let t = f64::from(self.tile);
        for (k, e) in self.tiles.iter_mut() {
            if k.level != id || e.stale {
                continue;
            }
            let b = Rect::new(
                f64::from(k.i) * t,
                f64::from(k.j) * t,
                f64::from(k.i + 1) * t,
                f64::from(k.j + 1) * t,
            );
            if rects.iter().any(|r| overlaps(*r, b)) {
                e.stale = true;
            }
        }
    }

    /// Marks the tiles of level `id` that rectangles of its grid pixels touch as drawn with
    /// another resolution of an image than the one picked now (`TileEntry::refine`): they stand
    /// in, never exact, until drawn again. Not a change: nothing is noted (`note_changed`).
    pub fn refine(&mut self, id: u32, rects: &[Rect]) {
        let t = f64::from(self.tile);
        for (k, e) in self.tiles.iter_mut() {
            if k.level != id || e.stale || e.refine {
                continue;
            }
            let b = Rect::new(
                f64::from(k.i) * t,
                f64::from(k.j) * t,
                f64::from(k.i + 1) * t,
                f64::from(k.j + 1) * t,
            );
            if rects.iter().any(|r| overlaps(*r, b)) {
                e.refine = true;
            }
        }
    }

    /// What changed (page units) since the last frame was drawn (`changed`).
    pub fn note_changed(&mut self, page: &[Rect]) {
        for r in page {
            if r.is_finite() && !self.changed.iter().any(|c| c.contains_rect(*r)) {
                self.changed.push(*r);
            }
        }
        if self.changed.len() > 64 {
            let all = self.changed.iter().copied().reduce(|a, b| a.union(b));
            self.changed = all.into_iter().collect();
        }
    }

    /// A frame was drawn and is the one the next is laid on: it holds nothing older than any
    /// change where the change was (`changed`), so what changed before it no longer matters.
    /// Not for a stand-in that keeps the frame it was warped from.
    pub fn frame_drawn(&mut self) {
        self.changed.clear();
        self.refined.clear();
    }

    /// Where an image got another resolution (page units) since the last frame was drawn: for a
    /// frame drawn over several frames, which draws its tiles there again (`refined_on`).
    pub fn note_refined(&mut self, page: &[Rect]) {
        for r in page {
            if r.is_finite() && !self.refined.iter().any(|c| c.contains_rect(*r)) {
                self.refined.push(*r);
            }
        }
        if self.refined.len() > 64 {
            let all = self.refined.iter().copied().reduce(|a, b| a.union(b));
            self.refined = all.into_iter().collect();
        }
    }

    /// What changed since the last frame was drawn (`note_changed`), in page units.
    #[doc(hidden)]
    pub fn changed(&self) -> &[Rect] {
        &self.changed
    }

    /// Whether anything changed in `page` (page units) since the last frame was drawn.
    fn changed_in(&self, page: Rect) -> bool {
        self.changed.iter().any(|c| overlaps(*c, page))
    }

    /// Where the last frame's pixels are older than the screen showed under `view` (page units to
    /// this frame's pixels), within `size`: what changed since it was drawn, when a stand-in was
    /// shown since (`base_kept`). None while it's the frame on screen.
    pub fn holes(&self, view: Affine, size: (u32, u32)) -> Vec<Rect> {
        if !self.base_kept {
            return Vec::new();
        }
        self.changed_on(view, size)
    }

    /// What changed since the last frame was drawn (`note_changed`), on a frame of `size` under
    /// `view`, grown a pixel: moving or not.
    pub fn changed_on(&self, view: Affine, size: (u32, u32)) -> Vec<Rect> {
        Self::on_frame(&self.changed, view, size)
    }

    /// Where an image got another resolution since the last frame was drawn (`note_refined`), on
    /// a frame of `size` under `view`, grown a pixel. Never a hole.
    pub fn refined_on(&self, view: Affine, size: (u32, u32)) -> Vec<Rect> {
        Self::on_frame(&self.refined, view, size)
    }

    fn on_frame(page: &[Rect], view: Affine, size: (u32, u32)) -> Vec<Rect> {
        let frame = Rect::new(0.0, 0.0, f64::from(size.0), f64::from(size.1));
        page.iter()
            .map(|c| view.transform_rect_bbox(*c).inflate(1.0, 1.0).intersect(frame))
            .filter(|r| r.width() > 0.0 && r.height() > 0.0)
            .collect()
    }

    /// Marks every tile stale (none stands in until drawn again).
    pub fn invalidate_all(&mut self) {
        for e in self.tiles.values_mut() {
            e.stale = true;
        }
    }

    /// Marks stale any tile drawn at full detail that was still inexact (e.g. because a
    /// provisional text record sat inside its reader halo when drawn) so the frame converges to
    /// exact once no provisional records remain shown.
    pub fn invalidate_inexact_full(&mut self) {
        for e in self.tiles.values_mut() {
            if !e.stale && e.full && !e.exact {
                e.stale = true;
            }
        }
    }

    /// A slot for drawing `key` into: its own if it's held, else a free one, a new one under
    /// `max_slots`, or the slot of the tile least worth keeping that this frame doesn't show.
    pub fn slot_for(&mut self, key: TileKey) -> Option<u32> {
        if self.is_overview(&key) {
            return self.overview_slot(&key);
        }
        if let Some(e) = self.tiles.get(&key) {
            return Some(e.slot);
        }
        if let Some(s) = self.free.pop() {
            return Some(s);
        }
        if (self.slots as usize) < self.max_slots {
            self.slots += 1;
            return Some(self.slots - 1);
        }
        let victim = self.victim()?;
        let e = self.tiles.remove(&victim)?;
        self.stats.evicted += 1;
        Some(e.slot)
    }

    /// The tile to evict: never one shown or drawn this frame. Other levels before the frame's
    /// (ladder and finer ones first), then the frame level's farthest from the view, then the
    /// least recently used.
    fn victim(&self) -> Option<TileKey> {
        let t = f64::from(self.tile);
        let focus = self.focus;
        let score = |k: &TileKey, e: &TileEntry| -> (u8, i64, u64) {
            let level = self.levels.iter().find(|l| l.id == k.level);
            match focus {
                Some((fl, cx, cy)) if fl == k.level => {
                    let (x, y) = ((f64::from(k.i) + 0.5) * t, (f64::from(k.j) + 0.5) * t);
                    let d = (x - cx).hypot(y - cy) as i64;
                    (1, d, u64::MAX - e.used)
                }
                _ => {
                    // Finer levels take more slots for the same view: they go first.
                    let s = level.map_or(0.0, |l| l.level.scale.log2() * 64.0) as i64;
                    let ladder = level.is_some_and(|l| l.ladder);
                    (if ladder { 2 } else { 3 }, s, u64::MAX - e.used)
                }
            }
        };
        self.tiles
            .iter()
            .filter(|(_, e)| e.used < self.frame && e.slot < OVERVIEW_SLOT)
            .max_by_key(|(k, e)| score(k, e))
            .map(|(k, _)| *k)
    }

    /// Records a tile drawn into `slot`: `exact`, nothing stood in for any record in it; `full`,
    /// drawn without level of detail.
    pub fn drawn(&mut self, key: TileKey, slot: u32, exact: bool, full: bool, reduced: bool) {
        self.unpainted.remove(&key);
        self.free.retain(|s| *s != slot);
        self.tiles.insert(
            key,
            TileEntry {
                slot,
                exact: full && exact,
                full,
                stale: false,
                refine: false,
                reduced,
                used: self.frame,
            },
        );
        self.stats.drawn += 1;
    }

    /// Marks `key` as unpainted because its `must` draw was deferred by a frame budget.
    pub fn mark_unpainted(&mut self, key: TileKey) {
        self.unpainted.insert(key);
    }

    /// Gives back a slot handed out for a tile that wasn't drawn (its draw failed).
    pub fn release(&mut self, key: TileKey, slot: u32) {
        if self.tiles.get(&key).is_some_and(|e| e.slot == slot) {
            self.tiles.remove(&key);
        }
        if !self.free.contains(&slot) && !self.tiles.values().any(|e| e.slot == slot) {
            give_back(&mut self.free, slot);
        }
    }

    fn touch(&mut self, key: &TileKey) {
        let frame = self.frame;
        if let Some(e) = self.tiles.get_mut(key) {
            e.used = frame;
        }
    }

    /// The tiles of level `id` (any state) covering a rectangle of page units, if they do.
    fn cover(&self, id: u32, page: Rect) -> Option<Vec<TileKey>> {
        let level = self.level(id)?;
        let (i0, j0, i1, j1) = self.span(level.grid().transform_rect_bbox(page))?;
        if (i64::from(i1) - i64::from(i0) + 1) * (i64::from(j1) - i64::from(j0) + 1) > 64 {
            return None;
        }
        let mut keys = Vec::new();
        for j in j0..=j1 {
            for i in i0..=i1 {
                let key = TileKey { level: id, i, j };
                // A stale tile shows what's gone: it stands in for nothing.
                if !self.tiles.get(&key).is_some_and(|e| !e.stale) {
                    return None;
                }
                keys.push(key);
            }
        }
        Some(keys)
    }

    /// Tiles pinned for the frame: shown, drawn or counted on by it, so never evicted by it.
    fn pinned(&self) -> usize {
        self.tiles
            .values()
            .filter(|e| e.used == self.frame && e.slot < OVERVIEW_SLOT)
            .count()
    }

    /// Pins a held tile, taking it from the frame's `room` if it wasn't pinned yet.
    fn pin(&mut self, key: &TileKey, room: &mut usize) {
        let frame = self.frame;
        if let Some(e) = self.tiles.get_mut(key)
            && e.used != frame
        {
            e.used = frame;
            // The overview's tiles have their own storage: they take no room from the frame's.
            if e.slot < OVERVIEW_SLOT {
                *room = room.saturating_sub(1);
            }
        }
    }

    /// Pins a held tile only while slots are spare (tiles round the view, kept ahead of a pan):
    /// never one the frame's own tiles were promised.
    fn pin_spare(&mut self, key: &TileKey, room: &mut usize) {
        if *room > 0 {
            self.pin(key, room);
        }
    }

    /// Plans a `size` frame under `view`. `zooming`: the scale changed since the last frame.
    /// `last`: the frame shown before, which may stand in under what isn't drawn yet.
    /// `prefetch`: tiles round the view may be drawn too, when the budget allows.
    pub fn plan(
        &mut self,
        view: Affine,
        size: (u32, u32),
        zooming: bool,
        last: Option<Last>,
        prefetch: bool,
        reuse_coarse: bool,
    ) -> Option<Plan> {
        let (level, origin) = Level::of(view)?;
        let id = self.level_id(level, false);
        let t = i64::from(self.tile);
        let (w, h) = (i64::from(size.0.max(1)), i64::from(size.1.max(1)));
        // Frame pixel = grid pixel + origin.
        let gx0 = -origin.0;
        let gy0 = -origin.1;
        let (i0, i1) = (gx0.div_euclid(t), (gx0 + w - 1).div_euclid(t));
        let (j0, j1) = (gy0.div_euclid(t), (gy0 + h - 1).div_euclid(t));
        let fits = |v: i64| v.abs() < i64::from(i32::MAX / 2);
        if ![i0, i1, j0, j1].iter().all(|v| fits(*v)) {
            return None;
        }
        let mut visible = Vec::new();
        for j in j0..=j1 {
            for i in i0..=i1 {
                visible.push((i as i32, j as i32));
            }
        }
        let centre = ((gx0 as f64) + w as f64 / 2.0, (gy0 as f64) + h as f64 / 2.0);
        self.focus = Some((id, centre.0, centre.1));
        // Ordered by distance from the view's centre: what's most in view first.
        let tf = self.tile as f64;
        let dist = |&(i, j): &(i32, i32)| {
            let (x, y) = ((f64::from(i) + 0.5) * tf, (f64::from(j) + 0.5) * tf);
            ((x - centre.0).hypot(y - centre.1) * 16.0) as i64
        };
        visible.sort_by_key(dist);
        for (i, j) in &visible {
            self.touch(&TileKey {
                level: id,
                i: *i,
                j: *j,
            });
        }
        let mut plan = Plan {
            level: id,
            origin,
            size,
            visible: visible.clone(),
            jobs: Vec::new(),
            direct: false,
            zooming,
        };
        if visible.len() > self.max_slots {
            plan.direct = true;
            plan.jobs = visible
                .iter()
                .map(|&(i, j)| Job {
                    key: TileKey { level: id, i, j },
                    view: level.tile_view(i, j, self.tile),
                    detail: false,
                    must: true,
                    direct: true,
                    rough: false,
                })
                .collect();
            return Some(plan);
        }
        // Where the last frame lands in this one, in page units (what it can stand in for).
        let last_page = last.and_then(|l| {
            let inv = if l.view.determinant().abs() > 0.0 {
                l.view.inverse()
            } else {
                return None;
            };
            let r = inv.transform_rect_bbox(Rect::new(0.0, 0.0, f64::from(l.size.0), f64::from(l.size.1)));
            r.is_finite().then_some(r)
        });
        let grid_inv = level.grid().inverse();
        let frame_grid = Rect::new(gx0 as f64, gy0 as f64, (gx0 + w) as f64, (gy0 + h) as f64);
        // A page just shown starts on a ladder level up to four times coarser: a few tiles, most
        // of the page specks at that scale, so its first frame comes soon (see `opening`).
        let ladder_level = if self.opening {
            Level::ladder_at_least(level.scale / 4.0)
        } else {
            Level::ladder(level.scale)
        };
        let ladder = zooming.then(|| self.level_id(ladder_level, true));
        // While the camera moves, the overview stands in for any scale, where nothing nearer does
        // (when it's coarser than what stands in anyway).
        let coarse = self.coarse_overview(level.scale);
        let overview = coarse.filter(|_| self.moving);
        let other_levels: Vec<u32> = self
            .levels
            .iter()
            .filter(|e| e.id != id && !e.overview && stands_in(level.scale, e.level.scale))
            .map(|e| e.id)
            .collect();
        // What stands in for each visible tile not up to date, over the part of it on screen:
        // itself (stale), the last frame, or another level's tiles (`deps`).
        struct Need {
            key: TileKey,
            held: bool,
            covered: bool,
            page: Rect,
            deps: Vec<TileKey>,
        }
        let mut needs: Vec<Need> = Vec::new();
        for &(i, j) in &visible {
            let key = TileKey { level: id, i, j };
            let held = self.tiles.get(&key).copied();
            if held.is_some_and(|e| e.current() || (reuse_coarse && !e.stale)) {
                continue;
            }
            let shown = Rect::new(
                f64::from(i) * tf,
                f64::from(j) * tf,
                f64::from(i + 1) * tf,
                f64::from(j + 1) * tf,
            )
            .intersect(frame_grid);
            let page = grid_inv.transform_rect_bbox(shown);
            let mut deps = Vec::new();
            // Nothing older than the screen showed stands in, moving or not: never a stale tile,
            // and not the last frame where something changed since it was drawn, once a stand-in
            // was shown since (`base_kept`, `Composite::holes`).
            let stands = held.is_some_and(|e| !e.stale);
            let old = self.base_kept && self.changed_in(page);
            let covered = stands
                || (!old && !self.unpainted.contains(&key) && last_page.is_some_and(|l| l.contains_rect(page)))
                || other_levels.iter().any(|o| match self.cover(*o, page) {
                    Some(keys) => {
                        deps = keys;
                        true
                    }
                    None => false,
                })
                || overview.is_some_and(|o| match self.cover_overview(o, page) {
                    Some(keys) => {
                        deps = keys;
                        true
                    }
                    None => false,
                });
            needs.push(Need {
                key,
                held: held.is_some(),
                covered,
                page,
                deps,
            });
        }
        // Slots the frame may fill: every one but those it pins (what it shows, and the other
        // levels' tiles it counts on, so its draws can't evict them). What nothing stands in
        // for gets one first. A tile that only another level's tiles stand in for, when no slot
        // is left, is drawn this frame instead (whatever the budget), so the tiles it counted on
        // are free again once nothing else counts on them: a frame at rest always progresses.
        // What still finds no slot is drawn straight into the frame (`direct`), never blank.
        let mut room = self.max_slots.saturating_sub(self.pinned());
        let frame = self.frame;
        let mut uses: HashMap<TileKey, (u32, u64)> = HashMap::new();
        for n in &needs {
            for k in &n.deps {
                if let Some(e) = self.tiles.get(k) {
                    uses.entry(*k).or_insert((0, e.used)).0 += 1;
                }
            }
        }
        // Tiles pinned before (shown) stay pinned whatever the count.
        uses.retain(|_, (_, used)| *used != frame);
        for k in uses.keys().copied().collect::<Vec<_>>() {
            self.pin(&k, &mut room);
        }
        let mut must = Vec::new();
        let mut optional = Vec::new();
        let mut covered_new = Vec::new();
        let tile = self.tile;
        let frame_job = |key: TileKey, must: bool, direct: bool| Job {
            key,
            view: level.tile_view(key.i, key.j, tile),
            detail: false,
            must,
            direct,
            rough: false,
        };
        let mut ladder_keys: Vec<TileKey> = Vec::new();
        for n in needs {
            if let Some(lid) = ladder {
                // Zooming: tiles of this scale would be gone next frame. Where nothing stands
                // in, the ladder level is drawn (coarse, with level of detail) over the part on
                // screen, if its tiles fit; else this tile, direct.
                if n.covered {
                    continue;
                }
                let span = self
                    .level(lid)
                    .and_then(|l| self.span(l.grid().transform_rect_bbox(n.page)));
                let mut fresh = Vec::new();
                let mut kept = Vec::new();
                if let Some((a0, b0, a1, b1)) = span {
                    for b in b0..=b1 {
                        for a in a0..=a1 {
                            let k = TileKey { level: lid, i: a, j: b };
                            if self.tiles.contains_key(&k) {
                                kept.push(k);
                            } else if !ladder_keys.contains(&k) {
                                fresh.push(k);
                            }
                        }
                    }
                }
                let unpinned = kept
                    .iter()
                    .filter(|k| self.tiles.get(k).is_some_and(|e| e.used != frame))
                    .count();
                if span.is_some() && fresh.len() + unpinned <= room {
                    for k in &kept {
                        self.pin(k, &mut room);
                    }
                    room -= fresh.len();
                    ladder_keys.extend(fresh);
                } else {
                    must.push(frame_job(n.key, true, true));
                }
                continue;
            }
            if n.held {
                // Drawn again in its own slot (pinned with what the frame shows). A stale tile
                // stands in for nothing, not even itself: where nothing else covers it, first.
                if n.covered {
                    optional.push(frame_job(n.key, false, false));
                } else {
                    must.push(frame_job(n.key, true, false));
                }
            } else if !n.covered {
                let direct = room == 0;
                room = room.saturating_sub(1);
                must.push(frame_job(n.key, true, direct));
            } else {
                covered_new.push(n);
            }
        }
        for n in covered_new {
            if room > 0 {
                room -= 1;
                optional.push(frame_job(n.key, false, false));
                continue;
            }
            // Drawn now: the tiles it counted on are free once nothing else counts on them.
            for k in &n.deps {
                if let Some((count, used)) = uses.get_mut(k) {
                    *count -= 1;
                    if *count == 0
                        && let Some(e) = self.tiles.get_mut(k)
                    {
                        e.used = *used;
                        // The overview's tiles took no room when pinned: none comes back.
                        if e.slot < OVERVIEW_SLOT {
                            room += 1;
                        }
                    }
                }
            }
            let direct = room == 0;
            room = room.saturating_sub(1);
            must.push(frame_job(n.key, true, direct));
        }
        plan.jobs = must;
        if let Some(lid) = ladder
            && let Some(l) = self.level(lid)
        {
            for k in ladder_keys {
                plan.jobs.push(Job {
                    key: k,
                    view: l.tile_view(k.i, k.j, self.tile),
                    detail: true,
                    must: true,
                    direct: false,
                    rough: false,
                });
            }
        }
        plan.jobs.extend(optional);
        // The overview, between frames, once the frame's own tiles are planned: what a zoom out
        // stands on.
        // Its tiles have their own storage: they take no room from the frame's.
        if self.bake_overview && !self.moving && !zooming && coarse.is_some() {
            plan.jobs.extend(self.overview_jobs());
        }
        // Not zooming: tiles round the view, for the pan to come, while slots allow.
        if prefetch && !zooming && visible.len() * 2 <= self.max_slots {
            let mut ring = Vec::new();
            for j in (j0 - 1)..=(j1 + 1) {
                for i in (i0 - 1)..=(i1 + 1) {
                    if i >= i0 && i <= i1 && j >= j0 && j <= j1 {
                        continue;
                    }
                    ring.push((i as i32, j as i32));
                }
            }
            ring.sort_by_key(dist);
            for (i, j) in ring {
                let key = TileKey { level: id, i, j };
                match self.tiles.get(&key).copied() {
                    Some(e) if e.current() => self.pin_spare(&key, &mut room),
                    Some(_) => {
                        self.pin_spare(&key, &mut room);
                        plan.jobs.push(frame_job(key, false, false));
                    }
                    None if room > 0 => {
                        room -= 1;
                        plan.jobs.push(frame_job(key, false, false));
                    }
                    None => {}
                }
            }
            // Last, a coarser level (a ladder level at about half the scale, with level of
            // detail) over the view grown by half of it each way: what a zoom out stands on, so
            // it never has to draw what nothing covers at once.
            let coarse = Level::ladder(level.scale / 2.0);
            if coarse != level && visible.len() * 3 <= self.max_slots {
                let cid = self.level_id(coarse, true);
                let frame = grid_inv.transform_rect_bbox(frame_grid);
                let grown = frame.inflate(frame.width() / 2.0, frame.height() / 2.0);
                if let Some((a0, b0, a1, b1)) = self.span(coarse.grid().transform_rect_bbox(grown))
                    && ((i64::from(a1) - i64::from(a0) + 1) * (i64::from(b1) - i64::from(b0) + 1)) as usize
                        <= self.max_slots / 4
                {
                    for b in b0..=b1 {
                        for a in a0..=a1 {
                            let key = TileKey { level: cid, i: a, j: b };
                            match self.tiles.get(&key).copied() {
                                Some(e) if !e.stale => self.pin_spare(&key, &mut room),
                                Some(_) => {
                                    self.pin_spare(&key, &mut room);
                                    plan.jobs.push(Job {
                                        key,
                                        view: coarse.tile_view(a, b, self.tile),
                                        detail: true,
                                        must: false,
                                        direct: false,
                                        rough: false,
                                    });
                                }
                                None if room > 0 => {
                                    room -= 1;
                                    plan.jobs.push(Job {
                                        key,
                                        view: coarse.tile_view(a, b, self.tile),
                                        detail: true,
                                        must: false,
                                        direct: false,
                                        rough: false,
                                    });
                                }
                                None => {}
                            }
                        }
                    }
                }
            }
        }
        Some(plan)
    }

    /// What's left of a plan's work: tiles the frame shows that aren't up to date (stale,
    /// missing, or drawn with level of detail), and jobs round it not drawn yet.
    pub fn left(&self, plan: &Plan) -> (u32, u32) {
        let done = |key: &TileKey| self.tiles.get(key).is_some_and(|e| e.current());
        let pending = plan
            .visible
            .iter()
            .filter(|&&(i, j)| {
                !done(&TileKey {
                    level: plan.level,
                    i,
                    j,
                })
            })
            .count();
        let queued = plan
            .jobs
            .iter()
            .filter(|j| !j.direct && !plan.shows(j.key))
            .filter(|j| {
                self.tiles
                    .get(&j.key)
                    .is_none_or(|e| e.stale || (!j.detail && !e.current()))
            })
            .count();
        (pending as u32, queued as u32)
    }

    /// What the frame planned shows, after its jobs were drawn (or some of them). Its `direct`
    /// jobs are drawn straight into the frame after it, over what it lays: they count as there
    /// (and exact; the caller adds whether they were).
    pub fn compose(&mut self, plan: &Plan, last: Option<Last>) -> Composite {
        let Some(level) = self.level(plan.level) else {
            return Composite::default();
        };
        let t = self.tile as i32;
        let (w, h) = (plan.size.0 as i32, plan.size.1 as i32);
        let mut out = Composite {
            exact: true,
            complete: true,
            ..Composite::default()
        };
        for &(i, j) in &plan.visible {
            let key = TileKey {
                level: plan.level,
                i,
                j,
            };
            let Some(e) = self.tiles.get(&key).copied() else {
                if !plan.jobs.iter().any(|j| j.direct && j.key == key) {
                    out.exact = false;
                    out.complete = false;
                    out.pending += 1;
                }
                continue;
            };
            if e.stale || e.refine || !e.exact {
                out.exact = false;
            }
            // A stale tile shows what's gone: what's beneath shows instead.
            if e.stale {
                out.complete = false;
                out.pending += 1;
                continue;
            }
            if e.reduced && !e.stale {
                out.reduced += 1;
            }
            // Pending: more frames will draw it (not a provisional record's tile, drawn as well
            // as the list allows until the list changes).
            if !e.current() {
                out.pending += 1;
            }
            // The tile's grid pixels, in the frame.
            let fx = i64::from(i) * i64::from(t) + plan.origin.0;
            let fy = i64::from(j) * i64::from(t) + plan.origin.1;
            let (x0, y0) = (fx.max(0), fy.max(0));
            let (x1, y1) = (
                (fx + i64::from(t)).min(i64::from(w)),
                (fy + i64::from(t)).min(i64::from(h)),
            );
            if x1 <= x0 || y1 <= y0 {
                continue;
            }
            out.copies.push(Copy {
                slot: e.slot,
                src: IRect {
                    x0: (x0 - fx) as i32,
                    y0: (y0 - fy) as i32,
                    x1: (x1 - fx) as i32,
                    y1: (y1 - fy) as i32,
                },
                dst: (x0 as i32, y0 as i32),
            });
        }
        if out.complete {
            return out;
        }
        // Stand-ins under what's missing: the last frame, then other levels' tiles, the nearest
        // scale last (on top).
        let view = Affine::new([
            level.scale,
            0.0,
            0.0,
            level.scale,
            level.phase.0 + plan.origin.0 as f64,
            level.phase.1 + plan.origin.1 as f64,
        ]);
        if let Some(l) = last
            && l.view.determinant().abs() > 0.0
        {
            out.base = Some(view * l.view.inverse());
            out.holes = self.holes(view, plan.size);
        }
        let frame_page = view
            .inverse()
            .transform_rect_bbox(Rect::new(0.0, 0.0, f64::from(w), f64::from(h)));
        let overview = self.coarse_overview(level.scale).map(|o| o.id);
        let mut others: Vec<(f64, u32, Level)> = self
            .levels
            .iter()
            .filter(|e| e.id != plan.level)
            .filter(|e| (!e.overview && stands_in(level.scale, e.level.scale)) || Some(e.id) == overview)
            .map(|e| {
                // The overview lies beneath every other stand-in.
                let far = if Some(e.id) == overview {
                    f64::INFINITY
                } else {
                    (e.level.scale / level.scale).log2().abs()
                };
                (far, e.id, e.level)
            })
            .collect();
        others.sort_by(|a, b| b.0.total_cmp(&a.0));
        let tf = f64::from(self.tile);
        for (_, id, l) in others {
            let Some((i0, j0, i1, j1)) = self.span(l.grid().transform_rect_bbox(frame_page)) else {
                continue;
            };
            if (i64::from(i1) - i64::from(i0) + 1) * (i64::from(j1) - i64::from(j0) + 1) > 4096 {
                continue;
            }
            let to_frame = view * l.grid().inverse();
            for j in j0..=j1 {
                for i in i0..=i1 {
                    let key = TileKey { level: id, i, j };
                    let Some(e) = self.tiles.get(&key).copied() else {
                        continue;
                    };
                    // A stale tile shows what's gone: never laid.
                    if e.stale {
                        continue;
                    }
                    let r = Rect::new(
                        f64::from(i) * tf,
                        f64::from(j) * tf,
                        f64::from(i + 1) * tf,
                        f64::from(j + 1) * tf,
                    );
                    let layer = if Some(id) == overview {
                        &mut out.under
                    } else {
                        &mut out.scaled
                    };
                    layer.push(Scaled {
                        slot: e.slot,
                        dst: to_frame.transform_rect_bbox(r),
                    });
                    self.touch(&key);
                }
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cam(z: f64, x: f64, y: f64) -> Affine {
        Affine::new([z, 0.0, 0.0, z, x, y])
    }

    #[test]
    fn a_frame_lies_on_its_levels_grid() {
        let (l, o) = Level::of(cam(1.5, 10.25, -3.75)).expect("level");
        assert_eq!(o, (10, -4));
        assert_eq!(l.phase, (0.25, 0.25));
        // A page point lands on the same pixel through the frame or through a tile.
        let p = vello_common::kurbo::Point::new(37.0, 81.0);
        let frame = cam(1.5, 10.25, -3.75) * p;
        let tile = l.tile_view(0, 0, 64) * p;
        assert!((frame.x - (tile.x + 10.0)).abs() < 1e-12);
        assert!((frame.y - (tile.y - 4.0)).abs() < 1e-12);
        let t1 = l.tile_view(1, 2, 64) * p;
        assert!((t1.x - (tile.x - 64.0)).abs() < 1e-12);
        assert!((t1.y - (tile.y - 128.0)).abs() < 1e-12);
        // Rotations and non-uniform scales aren't cameras.
        assert!(Level::of(Affine::new([1.0, 0.1, 0.0, 1.0, 0.0, 0.0])).is_none());
        assert!(Level::of(Affine::new([1.0, 0.0, 0.0, 2.0, 0.0, 0.0])).is_none());
        assert!(Level::of(cam(0.0, 0.0, 0.0)).is_none());
    }

    #[test]
    fn ladder_levels_step_by_root_two_at_or_below_the_scale() {
        for s in [0.03, 0.2, 0.7, 1.0, 1.3, 2.0, 5.5] {
            let l = Level::ladder(s);
            assert!(l.scale <= s * (1.0 + 1e-12), "{s}: {}", l.scale);
            assert!(
                l.scale * std::f64::consts::SQRT_2 > s * (1.0 - 1e-12),
                "{s}: {}",
                l.scale
            );
        }
        assert_eq!(Level::ladder(1.0).scale, 1.0);
    }

    fn draw_all(c: &mut TileCache, plan: &Plan) {
        for j in &plan.jobs {
            let s = c.slot_for(j.key).expect("slot");
            c.drawn(j.key, s, !j.detail, !j.detail, false);
        }
    }

    #[test]
    fn the_overview_is_drawn_between_frames_and_stands_in_while_zooming_out() {
        // A 4,000 × 2,000 unit page: its overview is the ladder level at 0.25 (1,000 × 500 px).
        let page = Rect::new(0.0, 0.0, 4000.0, 2000.0);
        let mut c = TileCache::new(512, 256);
        let frame = |c: &mut TileCache, moving: bool, idle: bool| {
            c.begin([1.0; 4], 0);
            c.set_overview(Some(page));
            c.moving = moving;
            c.bake_overview = idle;
        };
        let overview = |c: &TileCache| c.overview.map(|o| o.id).expect("overview");
        // Between frames: the frame's own tiles first, then the overview's, with level of detail.
        frame(&mut c, false, true);
        let rest = c
            .plan(cam(8.0, 0.0, 0.0), (1024, 768), false, None, false, false)
            .expect("plan");
        let first = rest
            .jobs
            .iter()
            .position(|j| j.key.level != rest.level)
            .expect("overview jobs");
        assert!(rest.jobs[..first].iter().all(|j| j.key.level == rest.level && j.must));
        assert!(rest.jobs[first..].iter().all(|j| j.detail && !j.must));
        assert_eq!(rest.jobs.len() - first, 2, "{:?}", rest.jobs);
        assert!(!c.overview_ready());
        draw_all(&mut c, &rest);
        assert!(c.overview_ready());
        // Zooming out to 3 while moving: what's newly in view is the overview's (12× coarser),
        // nothing must be drawn, and the overview lies under the last frame.
        frame(&mut c, true, false);
        let last = Last {
            view: cam(8.0, 0.0, 0.0),
            size: (1024, 768),
        };
        let at = cam(3.0, 300.0, 200.0);
        let out = c.plan(at, (1024, 768), true, Some(last), false, false).expect("plan");
        assert!(out.jobs.iter().all(|j| !j.must), "{:?}", out.jobs);
        let comp = c.compose(&out, Some(last));
        assert!(!comp.under.is_empty());
        assert!(comp.base.is_some());
        // The same view at rest draws its own tiles: the overview stands in only while moving.
        frame(&mut c, false, false);
        let settled = c.plan(at, (1024, 768), false, Some(last), false, false).expect("plan");
        assert!(settled.jobs.iter().any(|j| j.must && j.key.level == settled.level));
        // It's kept while anything else can go.
        let id = overview(&c);
        assert_eq!(c.tiles.keys().filter(|k| k.level == id).count(), 2);
        // A view it isn't 4× coarser than plans none of it (it stands in as any level does).
        frame(&mut c, false, true);
        let near = c
            .plan(cam(1.0, 0.0, 0.0), (1024, 768), false, None, false, false)
            .expect("plan");
        assert!(near.jobs.iter().all(|j| j.key.level != id));
        // A frame never draws it, even stale: only the time between frames does.
        frame(&mut c, false, false);
        c.invalidate(id, &[Rect::new(0.0, 0.0, 10.0, 10.0)]);
        let in_frame = c
            .plan(cam(8.0, 0.0, 0.0), (1024, 768), false, None, false, false)
            .expect("plan");
        assert!(in_frame.jobs.iter().all(|j| j.key.level != id));
    }

    /// An edited overview tile (stale) shows what's gone: it never counts as coverage nor is it
    /// laid under a frame, so what it stood for is drawn instead (review of #345).
    #[test]
    fn an_edited_overview_tile_never_stands_in() {
        let page = Rect::new(0.0, 0.0, 4000.0, 2000.0);
        let mut c = TileCache::new(512, 8);
        c.begin([1.0; 4], 0);
        c.set_overview(Some(page));
        for job in c.overview_ahead(8.0) {
            let slot = c.slot_for(job.key).expect("slot");
            c.drawn(job.key, slot, false, false, false);
        }
        let id = c.overview.map(|o| o.id).expect("overview");
        let key = TileKey { level: id, i: 0, j: 0 };
        let grid = c.level(id).expect("level").grid();
        c.invalidate(id, &[grid.transform_rect_bbox(Rect::new(50.0, 50.0, 70.0, 70.0))]);
        let entry = *c.get(&key).expect("held");
        assert!(entry.stale);
        c.begin([1.0; 4], 0);
        c.set_overview(Some(page));
        c.moving = true;
        let plan = c
            .plan(Affine::scale(8.0), (512, 512), true, None, false, false)
            .expect("plan");
        let comp = c.compose(&plan, None);
        assert!(!comp.exact && comp.pending > 0);
        assert!(
            plan.jobs.iter().any(|j| j.must),
            "a stale overview covered: {:?}",
            plan.jobs
        );
        assert!(
            comp.under.iter().all(|q| q.slot != entry.slot),
            "a stale overview tile was laid"
        );
    }

    /// Standing in on the overview takes none of the frame's slots: a tile it covers isn't made
    /// one nothing stands in for at the atlas limit (review of #345).
    #[test]
    fn the_overview_standing_in_takes_no_atlas_room() {
        let page = Rect::new(0.0, 0.0, 4000.0, 2000.0);
        let mut c = TileCache::new(512, 2);
        c.begin([1.0; 4], 0);
        c.set_overview(Some(page));
        let job = c.overview_ahead(8.0)[0];
        let slot = c.slot_for(job.key).expect("slot");
        c.drawn(job.key, slot, false, false, false);
        c.begin([1.0; 4], 0);
        c.set_overview(Some(page));
        c.moving = true;
        let view = Affine::new([8.0, 0.0, 0.0, 8.0, -15872.0, 0.0]);
        let plan = c.plan(view, (1024, 512), false, None, false, false).expect("plan");
        assert!(!plan.direct);
        assert_eq!(plan.jobs.len(), 2);
        let covered = plan.jobs.iter().find(|j| j.key.i == 31).expect("covered tile");
        assert!(
            !covered.must,
            "covered tile made one nothing stands in for: {covered:?}"
        );
    }

    fn bake_overview_for_test(c: &mut TileCache) {
        c.set_overview(Some(Rect::new(0.0, 0.0, 4000.0, 2000.0)));
        for job in c.overview_ahead(8.0) {
            let slot = c.slot_for(job.key).expect("slot");
            c.drawn(job.key, slot, false, false, false);
        }
    }

    /// Letting go of an overview tile a frame counted on gives back no room: it never took any.
    /// Every job planned for a slot gets one (re-check of #345: a phantom slot).
    #[test]
    fn dropping_an_overview_dependency_makes_no_atlas_slot() {
        let mut c = TileCache::new(512, 3);
        c.begin([1.0; 4], 0);
        bake_overview_for_test(&mut c);
        let (phase, _) = Level::of(Affine::new([8.0, 0.0, 0.0, 8.0, 0.5, 0.0])).expect("level");
        let mut hold = |level, indices: &[i32]| {
            let id = c.level_id(level, false);
            for &i in indices {
                let key = TileKey { level: id, i, j: 0 };
                let slot = c.slot_for(key).expect("slot");
                c.drawn(key, slot, true, true, false);
            }
        };
        hold(phase, &[0, 1]);
        hold(Level::of(Affine::scale(4.0)).expect("level").0, &[1]);
        c.begin([1.0; 4], 0);
        c.moving = true;
        let plan = c
            .plan(Affine::scale(8.0), (1536, 512), false, None, false, false)
            .expect("plan");
        assert_eq!(plan.jobs.len(), 3);
        for j in plan.jobs.iter().filter(|j| !j.direct) {
            let slot = c
                .slot_for(j.key)
                .unwrap_or_else(|| panic!("planned for a slot it can't have: {j:?} of {:?}", plan.jobs));
            c.drawn(j.key, slot, true, true, false);
        }
    }

    /// An edit under what the last frame showed (the overview, here), with a stand-in shown since
    /// that frame: while moving, the last frame isn't laid there and what's there is drawn
    /// (re-check of #345).
    #[test]
    fn what_changed_never_shows_through_the_last_frame_while_moving() {
        let mut c = TileCache::new(512, 8);
        c.begin([1.0; 4], 0);
        bake_overview_for_test(&mut c);
        c.moving = true;
        let last = Last {
            view: Affine::scale(8.0),
            size: (512, 512),
        };
        let plan = c.plan(last.view, last.size, true, None, false, false).expect("plan");
        let comp = c.compose(&plan, None);
        assert!(!comp.under.is_empty(), "the last frame showed the overview");
        let o = c.overview.map(|o| o.id).expect("overview");
        let grid = c.level(o).expect("level").grid();
        c.invalidate(o, &[grid.transform_rect_bbox(Rect::new(25.0, 25.0, 40.0, 40.0))]);
        c.begin([1.0; 4], 0);
        c.moving = true;
        // A stand-in after a limit was shown since the last frame was drawn.
        c.base_kept = true;
        let next = c
            .plan(Affine::scale(9.0), (512, 512), true, Some(last), false, false)
            .expect("plan");
        let comp = c.compose(&next, Some(last));
        assert!(comp.under.is_empty() && !comp.exact && comp.pending > 0);
        assert!(
            next.jobs.iter().any(|j| j.must),
            "nothing drawn where it changed: {:?}",
            next.jobs
        );
        // The last frame is laid only round what changed (in this frame's pixels, 25-40 at 9).
        let hole = comp.holes.iter().copied().reduce(|a, b| a.union(b)).expect("a hole");
        assert!(hole.contains_rect(Rect::new(225.0, 225.0, 360.0, 360.0)), "{hole:?}");
        // Once a frame is drawn (laid round it), the change is forgotten.
        c.frame_drawn();
        let next = c
            .plan(Affine::scale(9.0), (512, 512), true, Some(last), false, false)
            .expect("plan");
        assert!(c.compose(&next, Some(last)).holes.is_empty());
    }

    /// Display never goes back where something changed, at rest or moving: a stale tile is never
    /// laid nor stands in, not even for itself (any level). The last frame drawn, while it's the
    /// one on screen, is laid as it is until what changed is drawn (no hole); once a stand-in was
    /// shown since (`base_kept`), it's laid round what changed and that is drawn first (final
    /// re-checks of #345).
    #[test]
    fn a_stale_tile_never_shows_and_only_an_older_kept_frame_is_cut() {
        let mut c = TileCache::new(512, 32);
        c.begin([1.0; 4], 0);
        let view = Affine::IDENTITY;
        let size = (1024, 256);
        let plan = c.plan(view, size, false, None, false, false).expect("plan");
        for j in &plan.jobs {
            let slot = c.slot_for(j.key).expect("slot");
            c.drawn(j.key, slot, true, true, false);
        }
        let last = Last { view, size };
        c.frame_drawn();
        let id = plan.level;
        let changed = Rect::new(16.0, 16.0, 144.0, 48.0);
        let grid = c.level(id).expect("level").grid();
        c.invalidate(id, &[grid.transform_rect_bbox(changed)]);
        let stale = TileKey { level: id, i: 0, j: 0 };
        for (moving, kept) in [(false, false), (true, false), (false, true), (true, true)] {
            c.begin([1.0; 4], 0);
            c.moving = moving;
            c.base_kept = kept;
            let next = c.plan(view, size, false, Some(last), false, false).expect("plan");
            let job = next.jobs.iter().find(|j| j.key == stale);
            assert!(
                job.is_some(),
                "moving {moving} kept {kept}: drawn again, {:?}",
                next.jobs
            );
            // Under the frame on screen it waits its turn; under an older kept frame it's first.
            assert_eq!(job.is_some_and(|j| j.must), kept, "moving {moving} kept {kept}");
            let comp = c.compose(&next, Some(last));
            assert!(
                !comp.copies.iter().any(|cp| cp.dst == (0, 0)),
                "moving {moving} kept {kept}: a stale tile was laid"
            );
            assert!(comp.base.is_some() && !comp.exact && comp.pending > 0);
            assert_eq!(
                comp.holes.iter().any(|h| h.contains_rect(changed)),
                kept,
                "moving {moving} kept {kept}: {:?}",
                comp.holes
            );
        }
        // A frame drawn since holds nothing old: the change is forgotten.
        c.frame_drawn();
        c.begin([1.0; 4], 0);
        c.base_kept = true;
        let next = c.plan(view, size, false, Some(last), false, false).expect("plan");
        assert!(c.compose(&next, Some(last)).holes.is_empty());
    }

    /// A stale tile keeps its slot: with every slot taken by what the frame shows, it's drawn
    /// again there (not straight into the frame, which would leave it stale), so the frame gets
    /// exact (CI on 574048a7: CPU tiles never exact at rest after an edit).
    #[test]
    fn a_stale_tile_is_drawn_again_in_its_own_slot_when_no_room_is_left() {
        let mut c = TileCache::new(64, 4);
        c.begin([1.0; 4], 0);
        let view = Affine::IDENTITY;
        let size = (128, 128);
        let plan = c.plan(view, size, false, None, false, false).expect("plan");
        assert_eq!(plan.visible.len(), 4);
        for j in &plan.jobs {
            let slot = c.slot_for(j.key).expect("slot");
            c.drawn(j.key, slot, true, true, false);
        }
        let last = Last { view, size };
        c.frame_drawn();
        c.invalidate(plan.level, &[Rect::new(5.0, 5.0, 6.0, 6.0)]);
        for moving in [false, true] {
            c.begin([1.0; 4], 0);
            c.moving = moving;
            let next = c.plan(view, size, false, Some(last), false, false).expect("plan");
            assert_eq!(next.jobs.len(), 1, "moving {moving}: {:?}", next.jobs);
            assert!(!next.jobs[0].direct, "moving {moving}: drawn in its own slot");
        }
        c.begin([1.0; 4], 0);
        let next = c.plan(view, size, false, Some(last), false, false).expect("plan");
        let key = next.jobs[0].key;
        let slot = c.slot_for(key).expect("its own slot");
        c.drawn(key, slot, true, true, false);
        c.begin([1.0; 4], 0);
        let again = c.plan(view, size, false, Some(last), false, false).expect("plan");
        assert!(again.jobs.is_empty());
        assert!(c.compose(&again, Some(last)).exact);
    }

    /// Another resolution of an image (a sharper level, or one dropped) isn't a change: tiles
    /// drawn with the old one stand in for themselves, never exact, and are drawn again.
    #[test]
    fn another_resolution_of_an_image_stands_in_until_drawn_again() {
        let mut c = TileCache::new(512, 32);
        c.begin([1.0; 4], 0);
        let view = Affine::IDENTITY;
        let size = (1024, 256);
        let plan = c.plan(view, size, false, None, false, false).expect("plan");
        for j in &plan.jobs {
            let slot = c.slot_for(j.key).expect("slot");
            c.drawn(j.key, slot, true, true, false);
        }
        c.frame_drawn();
        let id = plan.level;
        c.refine(id, &[Rect::new(16.0, 16.0, 144.0, 48.0)]);
        assert!(c.changed().is_empty(), "nothing noted as changed");
        let key = TileKey { level: id, i: 0, j: 0 };
        c.begin([1.0; 4], 0);
        let next = c.plan(view, size, false, None, false, false).expect("plan");
        let job = next.jobs.iter().find(|j| j.key == key).expect("drawn again");
        assert!(!job.must, "it stands in for itself");
        let comp = c.compose(&next, None);
        assert!(comp.copies.iter().any(|cp| cp.dst == (0, 0)), "it's laid");
        assert!(!comp.exact && comp.pending == 1);
        let slot = c.slot_for(key).expect("its slot");
        c.drawn(key, slot, true, true, false);
        c.begin([1.0; 4], 0);
        let next = c.plan(view, size, false, None, false, false).expect("plan");
        assert!(c.compose(&next, None).exact);
    }

    /// The overview's tiles live apart from the frames' (`OVERVIEW_SLOT`): no frame's tile takes
    /// their place, a cache cut to fit memory keeps them, and a frame at the overview's own scale
    /// draws its tiles in ordinary slots, exactly. A changed background still drops them.
    #[test]
    fn the_overview_keeps_its_own_slots_through_memory_cuts() {
        let page = Rect::new(0.0, 0.0, 4000.0, 2000.0);
        let mut c = TileCache::new(512, 8);
        let frame = |c: &mut TileCache, bg: f32, idle: bool| {
            c.begin([bg; 4], 0);
            c.set_overview(Some(page));
            c.moving = false;
            c.bake_overview = idle;
        };
        frame(&mut c, 1.0, true);
        let rest = c
            .plan(cam(8.0, 0.0, 0.0), (1024, 512), false, None, false, false)
            .expect("plan");
        draw_all(&mut c, &rest);
        assert!(c.overview_ready());
        let id = c.overview.map(|o| o.id).expect("overview");
        let own = |c: &TileCache| {
            c.tiles
                .iter()
                .filter(|(k, _)| k.level == id)
                .map(|(_, e)| e.slot)
                .collect::<Vec<_>>()
        };
        assert_eq!(own(&c).len(), 2);
        assert!(own(&c).iter().all(|&s| s >= OVERVIEW_SLOT));
        assert_eq!(c.overview_grid(), Some((2, 1)));
        // Slots past the frame's go to other tiles, never the overview's.
        for x in 1..6 {
            frame(&mut c, 1.0, false);
            let p = c
                .plan(
                    cam(8.0, -2048.0 * f64::from(x), 0.0),
                    (1024, 512),
                    false,
                    None,
                    false,
                    false,
                )
                .expect("plan");
            draw_all(&mut c, &p);
            assert!(c.overview_ready(), "pan {x}");
        }
        // Memory runs short: the frames' slots go, the overview's stay.
        c.set_max_slots(0);
        assert!(c.overview_ready());
        c.clear_keeping_overview();
        assert!(c.overview_ready());
        assert_eq!(c.tiles.len(), 2);
        // A frame at the overview's own scale (0.25) has its own level and ordinary slots.
        c.set_max_slots(8);
        frame(&mut c, 1.0, false);
        let at = c
            .plan(cam(0.25, 0.0, 0.0), (1024, 512), false, None, false, false)
            .expect("plan");
        assert_ne!(at.level, id);
        assert!(!at.jobs.is_empty() && at.jobs.iter().all(|j| j.key.level == at.level && !j.rough));
        for j in &at.jobs {
            assert!(c.slot_for(j.key).is_some_and(|s| s < OVERVIEW_SLOT));
        }
        // Another background: everything goes.
        frame(&mut c, 0.5, false);
        assert!(!c.overview_ready());
        assert_eq!(c.tiles.keys().filter(|k| k.level == id).count(), 0);
    }

    #[test]
    fn a_rect_less_holes_covers_exactly_the_rest() {
        let r = Rect::new(0.0, 0.0, 100.0, 50.0);
        let holes = [Rect::new(10.0, 10.0, 30.0, 20.0), Rect::new(25.0, 15.0, 60.0, 70.0)];
        let parts = rect_minus(r, &holes);
        let area: f64 = parts.iter().map(|p| p.area()).sum();
        // 5,000 less the holes' union inside it: 200 + 35 × 35 - 5 × 5 overlap.
        assert!((area - (5000.0 - 200.0 - 1225.0 + 25.0)).abs() < 1e-9, "{area}");
        for (i, p) in parts.iter().enumerate() {
            assert!(
                holes
                    .iter()
                    .all(|h| p.intersect(*h).area() <= 0.0 || p.intersect(*h).width() <= 0.0)
            );
            for q in &parts[i + 1..] {
                let o = p.intersect(*q);
                assert!(o.width() <= 0.0 || o.height() <= 0.0, "{p:?} overlaps {q:?}");
            }
        }
        assert_eq!(rect_minus(r, &[]), vec![r]);
    }

    #[test]
    fn an_exact_frame_is_copies_of_up_to_date_tiles() {
        let mut c = TileCache::new(64, 64);
        c.begin([1.0; 4], 0);
        let plan = c
            .plan(cam(1.0, 10.0, 20.0), (100, 80), false, None, false, false)
            .expect("plan");
        // 100 × 80 from grid pixel (-10, -20): tiles -1..=1 by -1..=0.
        assert_eq!(plan.visible.len(), 6);
        assert!(plan.jobs.iter().all(|j| j.must));
        draw_all(&mut c, &plan);
        let comp = c.compose(&plan, None);
        assert!(comp.exact && comp.complete);
        let area: i32 = comp
            .copies
            .iter()
            .map(|cp| (cp.src.x1 - cp.src.x0) * (cp.src.y1 - cp.src.y0))
            .sum();
        assert_eq!(area, 100 * 80);
        // A stale tile shows what's gone: it stands in for nothing, not even itself, so it's
        // drawn before anything else and the frame is incomplete until it is.
        c.begin([1.0; 4], 0);
        c.invalidate(plan.level, &[Rect::new(5.0, 5.0, 6.0, 6.0)]);
        let again = c
            .plan(cam(1.0, 10.0, 20.0), (100, 80), false, None, false, false)
            .expect("plan");
        assert_eq!(again.jobs.len(), 1);
        assert!(again.jobs[0].must, "a stale tile stands in for nothing");
        let comp = c.compose(&again, None);
        assert!(!comp.exact && !comp.complete);
        assert_eq!(comp.pending, 1);
        assert_eq!(comp.copies.len(), 5, "the stale tile was laid");
        draw_all(&mut c, &again);
        assert!(c.compose(&again, None).exact);
    }

    #[test]
    fn a_whole_pixel_pan_reuses_tiles_and_a_fractional_one_does_not() {
        let mut c = TileCache::new(64, 64);
        c.begin([1.0; 4], 0);
        let p = c
            .plan(cam(1.0, 0.0, 0.0), (100, 80), false, None, true, false)
            .expect("plan");
        draw_all(&mut c, &p);
        c.begin([1.0; 4], 0);
        let p2 = c
            .plan(cam(1.0, -30.0, 7.0), (100, 80), false, None, false, false)
            .expect("plan");
        assert!(p2.jobs.is_empty(), "the ring was drawn: {:?}", p2.jobs);
        assert!(c.compose(&p2, None).exact);
        c.begin([1.0; 4], 0);
        let p3 = c
            .plan(cam(1.0, -30.5, 7.0), (100, 80), false, None, false, false)
            .expect("plan");
        assert_ne!(p3.level, p.level);
        assert!(!c.compose(&p3, None).exact);
    }

    #[test]
    fn zooming_draws_ladder_tiles_only_where_nothing_stands_in() {
        let mut c = TileCache::new(64, 256);
        c.begin([1.0; 4], 0);
        let p = c
            .plan(cam(1.0, 0.0, 0.0), (100, 80), false, None, false, false)
            .expect("plan");
        draw_all(&mut c, &p);
        let last = Last {
            view: cam(1.0, 0.0, 0.0),
            size: (100, 80),
        };
        // Zoomed in a little: the last frame covers the view, nothing is drawn.
        c.begin([1.0; 4], 0);
        let z = c
            .plan(cam(1.1, -5.0, -4.0), (100, 80), true, Some(last), false, false)
            .expect("plan");
        assert!(z.jobs.is_empty(), "{:?}", z.jobs);
        let comp = c.compose(&z, Some(last));
        assert!(!comp.exact && comp.base.is_some());
        // Zoomed far out: ladder tiles (level of detail on) where nothing covers.
        c.begin([1.0; 4], 0);
        let out = c
            .plan(cam(0.3, 30.0, 20.0), (100, 80), true, Some(last), false, false)
            .expect("plan");
        assert!(!out.jobs.is_empty());
        assert!(out.jobs.iter().all(|j| j.detail && j.must && j.key.level != out.level));
        draw_all(&mut c, &out);
        let comp = c.compose(&out, Some(last));
        assert!(!comp.exact, "a ladder stand-in is never exact");
        assert!(!comp.scaled.is_empty());
    }

    #[test]
    fn eviction_spares_what_the_frame_shows_and_drops_other_levels_first() {
        let mut c = TileCache::new(64, 12);
        c.begin([1.0; 4], 0);
        let a = c
            .plan(cam(2.0, 0.0, 0.0), (100, 80), false, None, false, false)
            .expect("plan");
        draw_all(&mut c, &a);
        assert_eq!(c.len(), 4);
        c.begin([1.0; 4], 0);
        let b = c
            .plan(cam(1.0, 0.0, 0.0), (200, 150), false, None, false, false)
            .expect("plan");
        draw_all(&mut c, &b);
        // 4 + 12 > 12: the finer level's tiles went, the frame's own stayed.
        assert_eq!(c.len(), 12);
        assert!(c.compose(&b, None).exact);
        assert!(c.tiles.keys().all(|k| k.level == b.level));
    }

    #[test]
    fn a_zoom_passing_through_scales_keeps_the_levels_that_stand_in() {
        let mut c = TileCache::new(64, 256);
        c.begin([1.0; 4], 0);
        let p = c
            .plan(cam(1.0, 0.0, 0.0), (100, 80), false, None, false, false)
            .expect("plan");
        draw_all(&mut c, &p);
        let last = Last {
            view: cam(1.0, 0.0, 0.0),
            size: (100, 80),
        };
        // Forty frames of a zoom, each a new scale drawing nothing of its own.
        for i in 1..=40 {
            c.begin([1.0; 4], 0);
            let z = 1.0 + f64::from(i) * 0.01;
            let _ = c.plan(cam(z, 0.0, 0.0), (100, 80), true, Some(last), false, false);
        }
        assert!(c.level(p.level).is_some(), "the drawn level stayed");
        assert_eq!(c.len(), p.visible.len());
    }

    #[test]
    fn a_zooming_frame_never_evicts_its_own_level_for_its_ladder() {
        // Eight levels held, each with tiles, used before this frame; a zoom to a ninth scale
        // makes its own level (empty) and then its ladder level: the ladder must not push out
        // the level the frame was planned at.
        let mut c = TileCache::new(64, 256);
        let mut last = None;
        for k in 0..8 {
            c.begin([1.0; 4], 0);
            let z = 1.0 + f64::from(k) * 0.37;
            let p = c
                .plan(cam(z, 0.0, 0.0), (100, 80), false, None, false, false)
                .expect("plan");
            draw_all(&mut c, &p);
            last = Some(Last {
                view: cam(z, 0.0, 0.0),
                size: (100, 80),
            });
        }
        c.begin([1.0; 4], 0);
        let z = c
            .plan(cam(5.3, 0.0, 0.0), (100, 80), true, last, false, false)
            .expect("plan");
        assert!(c.level(z.level).is_some(), "the frame's level survived its ladder");
        let comp = c.compose(&z, last);
        assert!(!comp.exact && comp.pending > 0, "{comp:?}");
    }

    #[test]
    fn a_frame_at_rest_draws_a_coarser_level_ahead_for_a_zoom_out() {
        let mut c = TileCache::new(64, 256);
        c.begin([1.0; 4], 0);
        let p = c
            .plan(cam(1.0, 0.0, 0.0), (128, 128), false, None, true, false)
            .expect("plan");
        let coarse: Vec<_> = p.jobs.iter().filter(|j| j.detail).collect();
        assert!(!coarse.is_empty(), "a coarser level is drawn ahead");
        draw_all(&mut c, &p);
        let last = Last {
            view: cam(1.0, 0.0, 0.0),
            size: (128, 128),
        };
        // Zoomed out to 60%: the coarse level stands in, nothing has to be drawn now.
        c.begin([1.0; 4], 0);
        let z = c
            .plan(cam(0.6, 25.0, 25.0), (128, 128), true, Some(last), true, false)
            .expect("plan");
        assert!(z.jobs.iter().all(|j| !j.must), "{:?}", z.jobs);
    }

    #[test]
    fn a_frame_too_large_for_the_budget_is_drawn_direct() {
        let mut c = TileCache::new(64, 4);
        c.begin([1.0; 4], 0);
        let p = c
            .plan(cam(1.0, 0.0, 0.0), (200, 200), false, None, true, false)
            .expect("plan");
        assert!(p.direct);
        assert_eq!(p.jobs.len(), 16);
        assert!(p.jobs.iter().all(|j| j.must && !j.detail));
    }

    #[test]
    fn what_nothing_stands_in_for_comes_before_what_waits() {
        let mut c = TileCache::new(64, 64);
        c.begin([1.0; 4], 0);
        let p = c
            .plan(cam(1.0, 0.0, 0.0), (192, 64), false, None, false, false)
            .expect("plan");
        draw_all(&mut c, &p);
        let last = Last {
            view: cam(1.0, 0.0, 0.0),
            size: (192, 64),
        };
        // Everything stale, then a pan: the centre tiles stand in for themselves, the one
        // entering on the right has nothing. It's first, whatever its distance.
        c.begin([1.0; 4], 0);
        c.invalidate_all();
        let q = c
            .plan(cam(1.0, -64.0, 0.0), (192, 64), false, Some(last), false, false)
            .expect("plan");
        let first_optional = q.jobs.iter().position(|j| !j.must).expect("stale tiles wait");
        assert!(q.jobs[..first_optional].iter().any(|j| j.key.i == 3), "{:?}", q.jobs);
        assert!(q.jobs[first_optional..].iter().all(|j| !j.must), "{:?}", q.jobs);
    }

    #[test]
    fn stand_ins_never_starve_a_frame_at_rest() {
        // Slots for the frame's tiles and two more; a finer level's tiles stand in for one of
        // them and hold slots. Drawing what must be drawn and one tile more a frame (the GPU's
        // least at rest), the frame becomes exact, never asking for a slot it can't have.
        let mut c = TileCache::new(64, 6);
        c.begin([1.0; 4], 0);
        let a = c
            .plan(cam(2.0, 0.0, 0.0), (100, 80), false, None, false, false)
            .expect("plan");
        draw_all(&mut c, &a);
        for _ in 0..8 {
            c.begin([1.0; 4], 0);
            let b = c
                .plan(cam(1.0, 0.0, 0.0), (100, 80), false, None, false, false)
                .expect("plan");
            let mut extra = 1;
            for j in &b.jobs {
                if j.direct {
                    continue;
                }
                if !j.must {
                    if extra == 0 {
                        continue;
                    }
                    extra -= 1;
                }
                let s = c.slot_for(j.key).expect("the plan counted a slot for it");
                c.drawn(j.key, s, true, true, false);
            }
            if c.compose(&b, None).exact {
                return;
            }
        }
        panic!("never became exact at rest");
    }

    #[test]
    fn a_background_or_reach_change_drops_everything() {
        let mut c = TileCache::new(64, 16);
        c.begin([1.0; 4], 0);
        let p = c
            .plan(cam(1.0, 0.0, 0.0), (100, 80), false, None, false, false)
            .expect("plan");
        draw_all(&mut c, &p);
        c.begin([0.5, 0.5, 0.5, 1.0], 0);
        assert!(c.is_empty());
        let p = c
            .plan(cam(1.0, 0.0, 0.0), (100, 80), false, None, false, false)
            .expect("plan");
        draw_all(&mut c, &p);
        c.begin([0.5, 0.5, 0.5, 1.0], 3);
        assert!(c.is_empty());
    }

    #[test]
    fn begin_scaled_keeps_other_zoom_levels_when_halo_changes() {
        let mut c = TileCache::new(64, 64);
        c.begin_scaled([1.0; 4], 1.0, 4);
        let p1 = c
            .plan(cam(1.0, 0.0, 0.0), (100, 80), false, None, false, false)
            .expect("plan 1x");
        draw_all(&mut c, &p1);
        let n1 = c.len();
        assert!(n1 > 0);
        // Zooming to 2x increases the reader halo; 1x cached tiles must stay resident as stand-ins.
        c.begin_scaled([1.0; 4], 2.0, 8);
        assert_eq!(c.len(), n1, "1x tiles stay cached when 2x halo changes");
        // Changing halo at the same 1x scale drops 1x tiles cleanly.
        c.begin_scaled([1.0; 4], 1.0, 9);
        assert!(c.is_empty(), "same-scale halo change drops that level's tiles");
    }

    #[test]
    fn fit_scale_integer_pan_reuses_exact_tile() {
        let mut c = TileCache::new(512, 64);
        let scale = 0.1783;
        c.begin_scaled([1.0; 4], scale, 4);
        let (mut x, mut y) = (-114.6, -57.3);
        let size = (32, 32);
        let start = c
            .plan(cam(scale, x, y), size, false, None, false, false)
            .expect("start");
        draw_all(&mut c, &start);

        for _ in 0..60 {
            x -= 6.0;
            y -= 3.0;
        }
        c.begin_scaled([1.0; 4], scale, 4);
        let panned = c.plan(cam(scale, x, y), size, false, None, false, false).expect("pan");

        assert_eq!(panned.level, start.level);
        assert_eq!(panned.origin, (start.origin.0 - 360, start.origin.1 - 180));
        assert!(panned.jobs.is_empty(), "the pan only exposes pixels of the same tile");
        assert!(c.compose(&panned, None).exact);
    }

    #[test]
    fn reduced_reader_tile_at_the_current_scale_is_replaced_at_rest() {
        let mut c = TileCache::new(64, 64);
        let view = cam(1.0, 0.0, 0.0);
        c.begin_scaled([1.0; 4], 1.0, 4);
        let size = (32, 32);
        let moving = c.plan(view, size, false, None, false, true).expect("motion");
        let key = moving.jobs[0].key;
        let slot = c.slot_for(key).expect("slot");
        // A coarse pass can draw every record it visits without sampling the full halo.
        c.drawn(key, slot, true, false, false);
        let shown = c.compose(&moving, None);
        assert!(!shown.exact);
        assert_eq!(shown.pending, 1);
        assert_eq!(shown.copies.len(), 1);

        c.begin_scaled([1.0; 4], 1.0, 4);
        let still = c.plan(view, size, false, None, false, false).expect("at rest");
        assert_eq!(still.jobs.len(), 1);
        draw_all(&mut c, &still);
        let shown = c.compose(&still, None);
        assert!(shown.exact);
        assert_eq!(shown.pending, 0);
    }
}
