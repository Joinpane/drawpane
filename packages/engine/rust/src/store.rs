//! The retained render graph: records keyed by stable layer handles, in paint order, patched by
//! messages (docs/decisions/0040-display-list.md).
//!
//! - **Transactional.** A message is decoded and validated in full first, then applied with an
//!   undo log: if any command fails, everything it changed is put back and the revision stays.
//! - **Revisions.** Every message names the revision it applies to and the one it makes. A
//!   patch for another revision is refused (`ErrorCode::Revision`), so a camera frame never
//!   draws a half-applied document.
//! - **Local transforms.** A record's transform is to its parent's units, so moving a board is
//!   one patch, not one per layer inside it.
//! - **Invalidation.** Applying returns where pixels may have changed, in page units: where each
//!   changed record's subtree painted before and paints now, then, in paint order, every backdrop
//!   reader whose read region (its box grown by its halo) takes in a change beneath it, which
//!   dirties where the reader paints in turn (transitively). This is what retained surfaces
//!   (phase 2) invalidate by; phase 1 redraws the frame, and the tests hold every pixel that
//!   changes to lie inside it.

use crate::error::{EngineError, ErrorCode, Result};
use crate::glyphs::GlyphStore;
use crate::limits::Limits;
use crate::record::{self, Op, PathEntry, Record};
use crate::wire::{MAGIC, MAJOR, MINOR, Reader};
use std::cell::{Cell, Ref, RefCell};
use std::collections::{HashMap, HashSet};
use vello_common::kurbo::{Affine, BezPath, Rect};

/// Cached per-revision metadata for a single visible backdrop-reader op in exact paint order.
pub struct CachedReader {
    pub key: (u32, usize),
    pub world: Affine,
    pub local: Rect,
    pub size: [f32; 2],
    pub writes_backdrop: bool,
    /// Ancestor/self node IDs with spatial post-effects (`LayerBlur` / `Texture`).
    pub spatial_post_records: Vec<u32>,
    /// Wrapping ancestor clips `(world_transform, local_bounds)` open at this reader op.
    pub clip_within: Vec<(Affine, Rect)>,
    /// True when the innermost wrapping clip frame has no opaque solid fill (`EdgeMode::Clamp`).
    pub clip_unfilled: bool,
    pub kind: CachedReaderKind,
}

#[derive(Clone, Copy)]
pub enum CachedReaderKind {
    Glass { scale_halo: f32, pad_px: f32 },
    Read { halo: f32 },
    BackgroundBlur { radius: f32 },
    ProgressiveBlur,
}

/// A shown reader as `Store::dirty` sees it, in page units: its paint order and subtree end, the
/// region it reads (its halo included) and the one it paints (through enclosing layer effects),
/// whether it reads after its children, and whether it writes the backdrop later readers sample.
#[derive(Clone, Copy, Debug)]
pub struct DirtyReader {
    order: u32,
    end: u32,
    reads: Rect,
    paints: Rect,
    after_children: bool,
    writes_backdrop: bool,
}

/// Lazily computed per-revision reader acceleration structure, avoiding full-graph walks on
/// camera-only pan/zoom frames and per-tile `plan_readers` / `has_reader_in_rect` checks.
pub struct ReaderCache {
    pub readers_world_bbox: Option<Rect>,
    pub reader_extents: Vec<Rect>,
    pub isolated_with_reader: HashSet<u32>,
    /// Every node on the path from `ROOT` to a visible reader or `FLAG_CONTEXT` node (inclusive).
    pub reader_ancestors: HashSet<u32>,
    pub visible_readers: Vec<CachedReader>,
}

/// The page: the root every top-level record hangs from. Never set or removed.
pub const ROOT: u32 = 0;
/// A message with this base revision replaces everything (it must start with a reset).
pub const ANY_REVISION: u32 = u32::MAX;

pub struct Node {
    pub record: Record,
    pub parent: u32,
    pub children: Vec<u32>,
    /// Subtree bounds in the record's own units plus unclipped page-space effect reach (shadows,
    /// blur): unknown (None) until computed.
    bounds: Cell<Option<(Option<Rect>, f64)>>,
    /// Its shown children's bounds in its units (before any clip) plus their max unclipped
    /// page-space effect reach: computed with `bounds`.
    kids: Cell<Option<(Option<Rect>, f64)>>,
    /// A hash of the record's bytes as they arrived: a set of the very same record where it
    /// already is changes nothing (the builder re-sends text still waiting for its faces).
    hash: u64,
    /// Whether this record or any visible descendant has an offscreen pass that may flush the
    /// active Vello scene (shadows, readers, filters, blends, masks).
    has_pass: Cell<Option<bool>>,
    /// Whether this record or any visible descendant uses a non-normal blend mode (for faded
    /// pass-through frames, decision 0038).
    has_blend: Cell<Option<bool>>,
}

impl Node {
    fn new(record: Record, parent: u32, hash: u64) -> Self {
        Self {
            record,
            parent,
            children: Vec::new(),
            bounds: Cell::new(None),
            kids: Cell::new(None),
            hash,
            has_pass: Cell::new(None),
            has_blend: Cell::new(None),
        }
    }
}

/// FNV-1a over a record's bytes (never 0, which marks the page).
fn record_hash(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    h.max(1)
}

enum Command {
    Reset,
    Glyph {
        glyph: u32,
        path: BezPath,
    },
    GlyphFree {
        glyph: u32,
    },
    Set {
        id: u32,
        parent: u32,
        record: Record,
        hash: u64,
    },
    Remove {
        id: u32,
    },
    Order {
        parent: u32,
        ids: Vec<u32>,
    },
    Transform {
        id: u32,
        transform: Affine,
    },
}

/// What changing the graph undoes to, newest last.
enum Undo {
    Everything {
        nodes: HashMap<u32, Node>,
        glyphs: GlyphStore,
        readers: Vec<u32>,
    },
    Glyph {
        glyph: u32,
        before: Option<crate::glyphs::Glyph>,
    },
    Inserted {
        id: u32,
    },
    Replaced {
        id: u32,
        record: Record,
        parent: u32,
        index: usize,
        hash: u64,
    },
    Removed {
        nodes: Vec<(u32, Node)>,
        parent: u32,
        index: usize,
    },
    Order {
        parent: u32,
        children: Vec<u32>,
    },
    Transform {
        id: u32,
        transform: Affine,
        hash: u64,
    },
}

/// A place where pixels may have changed, in page units, and where it lies in paint order (the
/// preorder index of the record that painted it there; an item beneath a reader is earlier).
#[derive(Clone, Copy, Debug)]
pub struct Dirty {
    pub rect: Rect,
    pub order: u32,
    /// The end of the record's subtree in paint order.
    pub end: u32,
    /// Its place in paint order is from before the structure changed (a record added, removed,
    /// moved or reordered later in the same message): not comparable with the graph's order now,
    /// so it counts as beneath every reader.
    pub stale: bool,
    /// A record's image arrived where it drew its placeholder, and nothing else about it changed
    /// (`Store::fills_placeholder`): the same picture, loaded. What was drawn with the placeholder
    /// still stands in, never exact (`TileCache::refine`), as for a sharper image level.
    pub refine: bool,
}

#[derive(Default, Debug)]
pub struct Applied {
    /// Where the changed records painted before and paint now, in page units, with their
    /// places in paint order. `Store::dirty` adds the readers they reach, for a camera.
    pub changes: Vec<Dirty>,
    /// A reset or page-wide rasterization change requires redrawing every tile.
    pub full: bool,
    /// The message only moved these records (transform commands and nothing else): a drag
    /// (decision 0040, "Dragging"). Sorted, without repeats.
    pub moved: Option<Vec<u32>>,
    /// The message changed nothing (records set as they already were, children ordered as they
    /// already are): it neither continues nor ends a drag, and nothing needs drawing again.
    pub noop: bool,
    /// It changed the structure (a record added, removed, moved to another parent, reordered).
    pub structural: bool,
    /// The records it changed (set, moved, removed), before any structure changed.
    pub touched: Vec<u32>,
}

pub struct Store {
    pub limits: Limits,
    pub nodes: HashMap<u32, Node>,
    pub glyphs: GlyphStore,
    /// Bytes and recency of the kept stroke outlines (`Limits::stroke_bytes`).
    pub strokes: crate::stroke::StrokeBudget,
    pub revision: u32,
    /// Records with backdrop readers, for invalidation.
    readers: Vec<u32>,
    /// How many change-against-reader checks the last `dirty` made (its cost, for the tests).
    dirty_checks: Cell<u64>,
    /// `provisional_shown`'s answer and the revision it was found for: asked every frame.
    provisional: Cell<Option<(u32, Option<u32>)>>,
    /// Records with `FLAG_CONTEXT` (export context, decision 0039).
    context: HashSet<u32>,
    /// Records holding unsupported features or diagnostic text fallback notes.
    unsupported: HashSet<u32>,
    /// Records that paint an image, so an image changing invalidates only what shows it.
    image_records: HashSet<u32>,
    /// A view can draw an image whose independently managed texture is still arriving.
    pub view_images: bool,
    /// Number of direct mask children under each parent, so `endsMask` edits in unmasked
    /// containers stay O(1) instead of scanning all siblings.
    masked_parents: HashMap<u32, usize>,
    /// What the records hold, roughly, in bytes (`Record::heap_bytes`): held to `Limits::graph_bytes`.
    bytes: usize,
    /// Preorder index and subtree end of every record; rebuilt when the structure changes.
    order: Option<HashMap<u32, (u32, u32)>>,
    /// Bumped whenever the structure (parents, children, their order) changes.
    structure: u64,
    /// Cached per-revision reader index, invalidated whenever the graph mutates.
    reader_cache: RefCell<Option<ReaderCache>>,
    /// The readers as `dirty` sees them, in page units: worked out once a revision, not once a
    /// call (a change invalidates tiles at every cached level, and a page can hold hundreds).
    dirty_readers: RefCell<Option<std::rc::Rc<Vec<DirtyReader>>>>,
}

struct PassAncestor {
    id: u32,
    isolated: bool,
    had_pass: bool,
    had_pad: f64,
    had_blend: bool,
    before_rect: Option<Rect>,
    order: (u32, u32),
}

struct PageScope {
    before_rect: Option<Rect>,
    replay: bool,
}

/// What one message's commands do as they're applied: the undo log and where pixels change. A
/// fresh list is built into a staged graph that isn't tracked (it's dropped whole on failure).
struct Txn {
    track: bool,
    before_structure: u64,
    undo: Vec<Undo>,
    before: Vec<Dirty>,
    before_seen: HashSet<u32>,
    mask_siblings_seen: HashSet<u32>,
    touched: Vec<u32>,
    /// Ancestors with isolation or offscreen work. A patch can change their compositing mode
    /// or culling bounds, which can move a flush in their enclosing picture.
    pass_ancestors: Vec<PassAncestor>,
    pass_ancestor_seen: HashSet<u32>,
    // A descendant edit can change where an offscreen pass quantizes this scope.
    iso_replay: HashSet<u32>,
    page_scope: Option<PageScope>,
    full: bool,
    /// The record whose `Set` is noting it now fills its image placeholder (`fills_placeholder`).
    filling: Option<u32>,
    /// Records set only to fill their image placeholder, and those changed any other way.
    filled: HashSet<u32>,
    changed_otherwise: HashSet<u32>,
    /// Where each record's entry from before is in `before`.
    before_at: HashMap<u32, usize>,
}

impl Txn {
    fn new(track: bool, before_structure: u64) -> Self {
        Self {
            track,
            before_structure,
            undo: Vec::new(),
            before: Vec::new(),
            before_seen: HashSet::new(),
            mask_siblings_seen: HashSet::new(),
            touched: Vec::new(),
            pass_ancestors: Vec::new(),
            pass_ancestor_seen: HashSet::new(),
            iso_replay: HashSet::new(),
            page_scope: None,
            full: false,
            filling: None,
            filled: HashSet::new(),
            changed_otherwise: HashSet::new(),
            before_at: HashMap::new(),
        }
    }

    fn push(&mut self, u: Undo) {
        if self.track {
            self.undo.push(u);
        }
    }
}

/// Bytes a node costs beside its record: the map entry, its children list and cached bounds.
const NODE_BYTES: usize = 96;

impl Store {
    pub fn new(limits: Limits) -> Self {
        let mut nodes = HashMap::new();
        nodes.insert(ROOT, Node::new(Record::empty(), ROOT, 0));
        Self {
            limits,
            nodes,
            glyphs: GlyphStore::default(),
            strokes: crate::stroke::StrokeBudget::default(),
            revision: 0,
            readers: Vec::new(),
            dirty_checks: Cell::new(0),
            provisional: Cell::new(None),
            context: HashSet::new(),
            unsupported: HashSet::new(),
            image_records: HashSet::new(),
            view_images: false,
            masked_parents: HashMap::new(),
            bytes: 0,
            order: None,
            structure: 0,
            reader_cache: RefCell::new(None),
            dirty_readers: RefCell::new(None),
        }
    }

    fn parent_has_mask(&self, parent: u32) -> bool {
        self.masked_parents.get(&parent).copied().unwrap_or(0) > 0
    }

    fn bump_mask_parent(&mut self, parent: u32, delta: isize) {
        let count = self.masked_parents.get(&parent).copied().unwrap_or(0);
        let next = count.saturating_add_signed(delta);
        if next == 0 {
            self.masked_parents.remove(&parent);
        } else {
            self.masked_parents.insert(parent, next);
        }
    }

    pub fn len(&self) -> usize {
        self.nodes.len() - 1
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// What the graph holds, roughly, in bytes: its records and their glyph outlines.
    pub fn bytes(&self) -> usize {
        self.bytes + self.glyphs.bytes()
    }

    /// Applies a message, all or nothing.
    ///
    /// - A patch names the revision the engine holds and makes the next one (`base + 1`).
    /// - A fresh list (base `ANY_REVISION`) makes a revision later than the one held. It is built
    ///   beside the graph it replaces and swapped in once it's all read and valid, so a refused
    ///   one leaves the scene and the revision as they were. Both graphs together must fit
    ///   `Limits::graph_bytes`.
    pub fn apply(&mut self, bytes: &[u8]) -> Result<Applied> {
        if bytes.len() > self.limits.message_bytes {
            return Err(EngineError::limit("a display list message too large"));
        }
        let limits = self.limits;
        let mut r = Reader::new(bytes);
        let (base, next, n, minor) = header(&mut r, &limits)?;
        if next == ANY_REVISION {
            return Err(EngineError::new(
                ErrorCode::Revision,
                "a message can't make the fresh-list revision",
            ));
        }
        if base == ANY_REVISION {
            if next <= self.revision {
                return Err(EngineError::new(
                    ErrorCode::Revision,
                    format!(
                        "a fresh list for revision {next}; the engine holds {}, and revisions only move forward",
                        self.revision
                    ),
                ));
            }
            return self.apply_fresh(&mut r, next, n, minor);
        }
        if base != self.revision {
            return Err(EngineError::new(
                ErrorCode::Revision,
                format!("a patch for revision {base}; the engine holds {}", self.revision),
            ));
        }
        if base.checked_add(1) != Some(next) {
            return Err(EngineError::new(
                ErrorCode::Revision,
                format!(
                    "a patch from revision {base} must make {}, not {next}",
                    u64::from(base) + 1
                ),
            ));
        }
        let before_structure = self.structure;
        let mut txn = Txn::new(true, before_structure);
        let mut moved: Option<Vec<u32>> = (n > 0).then(Vec::new);
        let mut changed = false;
        // Each command is applied as it's read (never all of them decoded at once), with an undo
        // log: a command that fails puts back everything before it.
        for _ in 0..n {
            let result = next_command(&mut r, &limits, minor).and_then(|command| {
                match &command {
                    Command::Transform { id, .. } => {
                        changed = true;
                        if let Some(m) = moved.as_mut() {
                            m.push(*id);
                        }
                    }
                    // A record set as it already is, or children ordered as they already are,
                    // change nothing: a drag stays a drag.
                    Command::Set { id, parent, hash, .. } if self.unchanged_set(*id, *parent, *hash) => {}
                    Command::Order { parent, ids } if self.nodes.get(parent).is_some_and(|n| &n.children == ids) => {}
                    _ => {
                        changed = true;
                        moved = None;
                    }
                }
                self.command(command, &mut txn)
            });
            let result = result.and_then(|()| self.check_bytes(0));
            if let Err(e) = result {
                self.rollback(txn.undo);
                return Err(e);
            }
        }
        if !r.done() {
            self.rollback(txn.undo);
            return Err(EngineError::malformed("bytes after the last command"));
        }
        self.revision = next;
        if changed || txn.full {
            *self.reader_cache.borrow_mut() = None;
            *self.dirty_readers.borrow_mut() = None;
        }
        if txn.full {
            return Ok(Applied {
                changes: Vec::new(),
                full: true,
                moved: None,
                noop: false,
                structural: true,
                touched: Vec::new(),
            });
        }
        for PassAncestor {
            id: a,
            isolated,
            had_pass,
            had_pad,
            had_blend,
            before_rect,
            order: (order, end),
        } in txn.pass_ancestors
        {
            if !self.nodes.contains_key(&a) {
                continue;
            }
            let has_pass = self.subtree_has_pass(a);
            let mode_changed = has_pass != had_pass || self.subtree_has_blend(a) != had_blend;
            // A scope that changes mode or bounds can start or stop flushing its parent when
            // culled at a viewport edge. Its footprint alone cannot bound that rounding change.
            if let Some(page) = &mut txn.page_scope
                && (had_pass || has_pass)
                && (mode_changed || self.dirty_extent(a) != before_rect)
            {
                page.replay = true;
            }
            if isolated
                && (txn.iso_replay.contains(&a) || mode_changed || (self.bounds_and_pad(a).1 - had_pad).abs() > 1e-6)
            {
                if let Some(rect) = before_rect {
                    txn.before.push(Dirty {
                        rect,
                        order,
                        end,
                        stale: false,
                        refine: false,
                    });
                }
                txn.touched.push(a);
            }
        }
        if self.structure != before_structure {
            for d in &mut txn.before {
                d.stale = true;
            }
        }
        let touched = txn.touched.clone();
        // Records whose only change in the message filled their image placeholder.
        let refined: HashSet<u32> = txn.filled.difference(&txn.changed_otherwise).copied().collect();
        for id in &refined {
            if let Some(&at) = txn.before_at.get(id)
                && let Some(d) = txn.before.get_mut(at)
            {
                d.refine = true;
            }
        }
        let mut changes = self.changes(std::mem::take(&mut txn.before), &txn.touched, &refined);
        if let Some(PageScope {
            before_rect,
            replay: true,
        }) = txn.page_scope
        {
            // A root flush quantizes the current Vello scene across the target. Any overlapping
            // draws on either side of that boundary can round differently after it moves.
            let page_rect = before_rect
                .into_iter()
                .chain(self.world_extent(ROOT))
                .reduce(|before, after| before.union(after));
            if let Some(rect) = page_rect {
                // This entry also reaches every reader over it. Covered record changes would
                // only add redundant rectangles to the same invalidation sweep.
                changes.retain(|d| rect.union(d.rect) != rect);
                changes.push(Dirty {
                    rect,
                    order: 0,
                    end: u32::MAX,
                    stale: true,
                    refine: false,
                });
            }
        }
        if let Some(m) = moved.as_mut() {
            m.sort_unstable();
            m.dedup();
        }
        // Nothing moved (only sets and orders that changed nothing): not a move.
        if moved.as_ref().is_some_and(Vec::is_empty) {
            moved = None;
        }
        Ok(Applied {
            changes,
            full: false,
            moved,
            noop: !changed,
            structural: self.structure != before_structure,
            touched,
        })
    }

    /// A fresh list: built into a staged graph, read once, and swapped in whole.
    fn apply_fresh(&mut self, r: &mut Reader, next: u32, n: usize, minor: u16) -> Result<Applied> {
        let limits = self.limits;
        let mut staged = Store::new(limits);
        let mut txn = Txn::new(false, 0);
        let held = self.bytes();
        for i in 0..n {
            let command = next_command(r, &limits, minor)?;
            if i == 0 {
                if !matches!(command, Command::Reset) {
                    return Err(EngineError::malformed(
                        "a message for any revision must start with a reset",
                    ));
                }
                continue;
            }
            staged.command(command, &mut txn)?;
            staged.check_bytes(held)?;
        }
        if n == 0 {
            return Err(EngineError::malformed(
                "a message for any revision must start with a reset",
            ));
        }
        if !r.done() {
            return Err(EngineError::malformed("bytes after the last command"));
        }
        // Committed: the old graph goes now.
        self.nodes = staged.nodes;
        self.glyphs = staged.glyphs;
        self.readers = staged.readers;
        self.context = staged.context;
        self.unsupported = staged.unsupported;
        self.image_records = staged.image_records;
        self.masked_parents = staged.masked_parents;
        self.bytes = staged.bytes;
        self.order = None;
        self.structure += 1;
        self.revision = next;
        *self.reader_cache.borrow_mut() = None;
        *self.dirty_readers.borrow_mut() = None;
        Ok(Applied {
            changes: Vec::new(),
            full: true,
            moved: None,
            noop: false,
            structural: true,
            touched: Vec::new(),
        })
    }

    /// Refuses a graph (with `extra` bytes held beside it) past `Limits::graph_bytes`.
    fn check_bytes(&self, extra: usize) -> Result<()> {
        let total = self.bytes() + extra;
        if total > self.limits.graph_bytes {
            return Err(EngineError::limit(format!(
                "the render graph would hold {} MiB; the most is {} MiB",
                total >> 20,
                self.limits.graph_bytes >> 20
            )));
        }
        Ok(())
    }

    fn rollback(&mut self, undo: Vec<Undo>) {
        for u in undo.into_iter().rev() {
            match u {
                Undo::Everything { nodes, glyphs, readers } => {
                    self.nodes = nodes;
                    self.glyphs = glyphs;
                    self.readers = readers;
                }
                Undo::Glyph { glyph, before } => self.glyphs.restore(glyph, before),
                Undo::Inserted { id } => {
                    if let Some(node) = self.nodes.remove(&id) {
                        self.glyphs.release(&node.record);
                        self.detach(id, node.parent);
                    }
                }
                Undo::Replaced {
                    id,
                    record,
                    parent,
                    index,
                    hash,
                } => {
                    let current = self.nodes.get(&id).map(|n| n.parent);
                    if let Some(p) = current {
                        self.detach(id, p);
                    }
                    if let Some(node) = self.nodes.get_mut(&id) {
                        let old = std::mem::replace(&mut node.record, record);
                        node.parent = parent;
                        node.hash = hash;
                        self.glyphs.release(&old);
                        if let Some(n) = self.nodes.get(&id) {
                            self.glyphs.retain(&n.record);
                        }
                    }
                    self.attach(id, parent, Some(index));
                }
                Undo::Removed { nodes, parent, index } => {
                    let top = nodes.first().map(|(id, _)| *id);
                    for (id, node) in nodes {
                        self.glyphs.retain(&node.record);
                        self.nodes.insert(id, node);
                    }
                    if let Some(id) = top {
                        self.attach(id, parent, Some(index));
                    }
                }
                Undo::Order { parent, children } => {
                    if let Some(p) = self.nodes.get_mut(&parent) {
                        p.children = children;
                    }
                }
                Undo::Transform { id, transform, hash } => {
                    if let Some(n) = self.nodes.get_mut(&id) {
                        n.record.transform = transform;
                        n.hash = hash;
                    }
                }
            }
        }
        self.readers = self
            .nodes
            .iter()
            .filter(|(_, n)| n.record.reads().is_some())
            .map(|(id, _)| *id)
            .collect();
        self.context = self
            .nodes
            .iter()
            .filter(|(_, n)| n.record.context())
            .map(|(id, _)| *id)
            .collect();
        self.unsupported = self
            .nodes
            .iter()
            .filter(|(_, n)| n.record.unsupported != 0)
            .map(|(id, _)| *id)
            .collect();
        self.image_records = self
            .nodes
            .iter()
            .filter(|(_, n)| n.record.images().next().is_some())
            .map(|(id, _)| *id)
            .collect();
        self.masked_parents.clear();
        for (&id, n) in &self.nodes {
            if id != ROOT && n.record.is_mask() {
                *self.masked_parents.entry(n.parent).or_insert(0) += 1;
            }
        }
        self.bytes = self
            .nodes
            .iter()
            .filter(|(id, _)| **id != ROOT)
            .map(|(_, n)| n.record.heap_bytes() + NODE_BYTES)
            .sum();
        self.order = None;
        self.structure += 1;
        for n in self.nodes.values() {
            n.bounds.set(None);
            n.kids.set(None);
            n.has_pass.set(None);
            n.has_blend.set(None);
        }
    }

    /// How many records deep the subtree under `id` goes (0: no children).
    fn height(&self, id: u32) -> usize {
        let mut deepest = 0;
        let mut stack = vec![(id, 0usize)];
        while let Some((at, d)) = stack.pop() {
            deepest = deepest.max(d);
            if let Some(n) = self.nodes.get(&at) {
                stack.extend(n.children.iter().map(|c| (*c, d + 1)));
            }
        }
        deepest
    }

    fn command(&mut self, command: Command, txn: &mut Txn) -> Result<()> {
        match command {
            Command::Reset => {
                let mut nodes = HashMap::new();
                nodes.insert(ROOT, Node::new(Record::empty(), ROOT, 0));
                let old = std::mem::replace(&mut self.nodes, nodes);
                let glyphs = std::mem::take(&mut self.glyphs);
                let readers = std::mem::take(&mut self.readers);
                self.context.clear();
                self.unsupported.clear();
                self.image_records.clear();
                self.masked_parents.clear();
                self.bytes = 0;
                txn.push(Undo::Everything {
                    nodes: old,
                    glyphs,
                    readers,
                });
                self.order = None;
                self.structure += 1;
                txn.before.clear();
                txn.before_seen.clear();
                txn.mask_siblings_seen.clear();
                txn.touched.clear();
                txn.page_scope = None;
                txn.full = true;
            }
            Command::Glyph { glyph, path } => {
                let previous = self.glyphs.define(glyph, path, &self.limits)?;
                txn.push(Undo::Glyph {
                    glyph,
                    before: previous,
                });
            }
            Command::GlyphFree { glyph } => {
                let previous = self.glyphs.free(glyph)?;
                txn.push(Undo::Glyph {
                    glyph,
                    before: Some(previous),
                });
            }
            Command::Set {
                id,
                parent,
                record,
                hash,
            } => {
                if id == ROOT {
                    return Err(EngineError::malformed("the page can't be set"));
                }
                if self.unchanged_set(id, parent, hash) {
                    return Ok(());
                }
                if !self.nodes.contains_key(&parent) {
                    return Err(EngineError::unknown(format!(
                        "record {id}'s parent {parent} isn't held"
                    )));
                }
                self.glyphs.check(&record)?;
                // Refuse a cycle (a record under itself) and nesting past the limit, counting
                // the subtree a record brings with it when it moves.
                let existing = self.nodes.get(&id).map(|n| n.parent);
                let below = match existing {
                    Some(p) if p != parent => self.height(id),
                    _ => 0,
                };
                let mut depth = 1usize;
                let mut at = parent;
                while at != ROOT {
                    if at == id {
                        return Err(EngineError::malformed(format!("record {id} would contain itself")));
                    }
                    depth += 1;
                    if depth > self.limits.depth {
                        return Err(EngineError::limit("records nested too deep"));
                    }
                    at = self.nodes.get(&at).map_or(ROOT, |n| n.parent);
                }
                if depth + below > self.limits.depth {
                    return Err(EngineError::limit("records nested too deep"));
                }
                let old_info = self
                    .nodes
                    .get(&id)
                    .map(|n| (n.parent, n.record.is_mask(), n.record.ends_mask()));
                let new_mask = record.is_mask();
                let new_ends = record.ends_mask();
                if txn.track {
                    txn.filling = self
                        .nodes
                        .get(&id)
                        .is_some_and(|n| n.parent == parent && Self::fills_placeholder(&n.record, &record))
                        .then_some(id);
                    self.note_before(id, txn);
                    txn.filling = None;
                    let draws_children = record.ops.iter().any(|op| matches!(op, Op::Children));
                    let may_flush = !record.hidden()
                        && (self.parent_has_mask(parent)
                            || record.has_offscreen_pass()
                            || record.reads().is_some()
                            || (draws_children
                                && self
                                    .nodes
                                    .get(&id)
                                    .is_some_and(|n| n.children.iter().any(|&child| self.subtree_has_pass(child)))));
                    self.note_pass_ancestors(parent, txn, may_flush.then_some(id));
                    if let Some((old_parent, old_mask, old_ends)) = old_info
                        && (old_mask || (old_ends && self.parent_has_mask(old_parent)))
                    {
                        self.note_mask_siblings(old_parent, txn);
                    }
                    if new_mask || (new_ends && self.parent_has_mask(parent)) {
                        self.note_mask_siblings(parent, txn);
                    }
                }
                let reads = record.reads().is_some();
                let is_context = record.context();
                let unsupported = record.unsupported != 0;
                let images = record.images().next().is_some();
                let cost = record.heap_bytes();
                self.glyphs.retain(&record);
                let mut structural = true;
                if let Some(node) = self.nodes.get_mut(&id) {
                    let old_parent = node.parent;
                    let old_hash = std::mem::replace(&mut node.hash, hash);
                    structural = old_parent != parent;
                    let old = std::mem::replace(&mut node.record, record);
                    let old_was_mask = old.is_mask();
                    node.parent = parent;
                    node.bounds.set(None);
                    node.kids.set(None);
                    node.has_pass.set(None);
                    node.has_blend.set(None);
                    self.bytes = self.bytes + cost - old.heap_bytes();
                    self.glyphs.release(&old);
                    if old_was_mask && (!new_mask || old_parent != parent) {
                        self.bump_mask_parent(old_parent, -1);
                    }
                    if new_mask && (!old_was_mask || old_parent != parent) {
                        self.bump_mask_parent(parent, 1);
                    }
                    if structural {
                        let index = self.detach(id, old_parent);
                        // Its old parent's subtree shrank.
                        self.dirty_up(old_parent);
                        self.attach(id, parent, None);
                        txn.push(Undo::Replaced {
                            id,
                            record: old,
                            parent: old_parent,
                            index,
                            hash: old_hash,
                        });
                    } else {
                        // In place: same parent, same place among its siblings.
                        let index = self
                            .nodes
                            .get(&parent)
                            .and_then(|p| p.children.iter().position(|c| *c == id))
                            .unwrap_or(0);
                        txn.push(Undo::Replaced {
                            id,
                            record: old,
                            parent,
                            index,
                            hash: old_hash,
                        });
                    }
                } else {
                    if self.nodes.len() > self.limits.records {
                        self.glyphs.release(&record);
                        return Err(EngineError::limit("too many records"));
                    }
                    self.bytes += cost + NODE_BYTES;
                    self.nodes.insert(id, Node::new(record, parent, hash));
                    if new_mask {
                        self.bump_mask_parent(parent, 1);
                    }
                    self.attach(id, parent, None);
                    txn.push(Undo::Inserted { id });
                }
                self.readers.retain(|r| *r != id);
                if reads {
                    self.readers.push(id);
                }
                if is_context {
                    self.context.insert(id);
                } else {
                    self.context.remove(&id);
                }
                if unsupported {
                    self.unsupported.insert(id);
                } else {
                    self.unsupported.remove(&id);
                }
                if images {
                    self.image_records.insert(id);
                } else {
                    self.image_records.remove(&id);
                }
                self.dirty_up(id);
                if structural {
                    self.order = None;
                    self.structure += 1;
                }
            }
            Command::Remove { id } => {
                if id == ROOT {
                    return Err(EngineError::malformed("the page can't be removed"));
                }
                let parent = self
                    .nodes
                    .get(&id)
                    .ok_or_else(|| EngineError::unknown(format!("no record {id} to remove")))?
                    .parent;
                let (old_mask, old_ends) = self
                    .nodes
                    .get(&id)
                    .map_or((false, false), |n| (n.record.is_mask(), n.record.ends_mask()));
                if txn.track {
                    self.note_before(id, txn);
                    if old_mask || (old_ends && self.parent_has_mask(parent)) {
                        self.note_mask_siblings(parent, txn);
                    }
                }
                let index = self.detach(id, parent);
                self.dirty_up(parent);
                let mut removed = Vec::new();
                let mut stack = vec![id];
                while let Some(at) = stack.pop() {
                    if let Some(node) = self.nodes.remove(&at) {
                        stack.extend(node.children.iter().copied());
                        if node.record.is_mask() {
                            self.bump_mask_parent(node.parent, -1);
                        }
                        self.glyphs.release(&node.record);
                        self.bytes -= node.record.heap_bytes() + NODE_BYTES;
                        self.context.remove(&at);
                        self.unsupported.remove(&at);
                        self.image_records.remove(&at);
                        if txn.track {
                            removed.push((at, node));
                        }
                    }
                }
                self.readers.retain(|r| self.nodes.contains_key(r));
                txn.push(Undo::Removed {
                    nodes: removed,
                    parent,
                    index,
                });
                self.order = None;
                self.structure += 1;
            }
            Command::Order { parent, ids } => {
                let node = self
                    .nodes
                    .get(&parent)
                    .ok_or_else(|| EngineError::unknown(format!("no record {parent} to order")))?;
                let mut a = node.children.clone();
                let mut b = ids.clone();
                a.sort_unstable();
                b.sort_unstable();
                if a != b {
                    return Err(EngineError::malformed(format!(
                        "an order for {parent} that isn't its children"
                    )));
                }
                if node.children == ids {
                    return Ok(());
                }
                // Reordering moves paint in place: where the children paint may look different.
                if txn.track {
                    for id in &ids {
                        self.note_before(*id, txn);
                    }
                }
                let old = std::mem::replace(&mut self.nodes.get_mut(&parent).expect("checked").children, ids);
                txn.push(Undo::Order { parent, children: old });
                self.order = None;
                self.structure += 1;
            }
            Command::Transform { id, transform } => {
                if id == ROOT {
                    return Err(EngineError::malformed("the page has no transform"));
                }
                if !self.nodes.contains_key(&id) {
                    return Err(EngineError::unknown(format!("no record {id} to move")));
                }
                let mask_parent = self.nodes.get(&id).and_then(|n| n.record.is_mask().then_some(n.parent));
                if txn.track {
                    self.note_before(id, txn);
                    if let Some(p) = mask_parent {
                        self.note_mask_siblings(p, txn);
                    }
                }
                let node = self.nodes.get_mut(&id).expect("checked");
                let old = std::mem::replace(&mut node.record.transform, transform);
                // Its bytes as last set no longer describe it: no set is "the same" until the
                // next one (0 never matches a record's hash).
                let hash = std::mem::replace(&mut node.hash, 0);
                txn.push(Undo::Transform {
                    id,
                    transform: old,
                    hash,
                });
                // Its own bounds hold (they're in its units); its ancestors' don't.
                let parent = node.parent;
                self.dirty_up(parent);
            }
        }
        Ok(())
    }

    /// Starts a frame for the stroke budget: drops the least recently drawn outlines (never one
    /// drawn this frame or the last) once what is kept passes `Limits::stroke_bytes`, down to
    /// three quarters of it. What the budget counts can only overstate, so the live outlines are
    /// recounted first and nothing is dropped when they fit.
    pub fn begin_stroke_frame(&self) {
        self.strokes.advance();
        let cap = self.limits.stroke_bytes;
        if self.strokes.held() <= cap {
            return;
        }
        let mut held = 0usize;
        let mut kept: Vec<(u64, usize, u32, usize, u8)> = Vec::new();
        for (id, node) in &self.nodes {
            let r = &node.record;
            for (k, op) in r.ops.iter().chain(&r.coarse).enumerate() {
                if let crate::record::Op::Stroke { cache, .. } = op {
                    for (used, bytes, level) in cache.usage() {
                        held += bytes;
                        kept.push((used, bytes, *id, k, level));
                    }
                }
            }
        }
        if held > cap {
            let recent = self.strokes.tick().saturating_sub(1);
            kept.sort_unstable_by_key(|e| e.0);
            let target = cap / 4 * 3;
            for (used, _, id, k, level) in kept {
                if held <= target || used >= recent {
                    break;
                }
                let Some(node) = self.nodes.get(&id) else { continue };
                let r = &node.record;
                if let Some(crate::record::Op::Stroke { cache, .. }) = r.ops.iter().chain(&r.coarse).nth(k) {
                    held = held.saturating_sub(cache.evict(level));
                }
            }
        }
        self.strokes.set_held(held);
    }

    /// Summarises cached stroke outlines across all records currently held in the store.
    pub fn stroke_cache_stats(&self) -> crate::stroke::StrokeCacheStats {
        let mut s = crate::stroke::StrokeCacheStats::default();
        for node in self.nodes.values() {
            let r = &node.record;
            for op in r.ops.iter().chain(&r.coarse) {
                if let crate::record::Op::Stroke { path, cache, .. } = op {
                    s.ops_total += 1;
                    let in_verbs = match r.paths.get(*path as usize) {
                        Some(crate::record::PathEntry::Path(c)) => c.len() as u64,
                        Some(crate::record::PathEntry::Rect { .. } | crate::record::PathEntry::Box { .. }) => 9,
                        Some(crate::record::PathEntry::Ellipse { .. } | crate::record::PathEntry::Oval { .. }) => 34,
                        Some(crate::record::PathEntry::Glyphs { glyphs, .. }) => glyphs
                            .iter()
                            .filter_map(|g| self.glyphs.get(g.glyph))
                            .map(|g| g.path.elements().len() as u64)
                            .sum(),
                        _ => 0,
                    };
                    s.input_verbs += in_verbs;
                    let cached_verbs = cache.cached_verbs();
                    if cached_verbs > 0 || cache.is_cached() {
                        s.ops_cached += 1;
                        s.expanded_verbs += cached_verbs as u64;
                        s.cached_bytes += cache.cached_bytes() as u64;
                    }
                }
            }
        }
        s
    }

    /// Whether `id` is one of `of` or lies inside one of them.
    pub fn within(&self, mut id: u32, of: &[u32]) -> bool {
        loop {
            if of.contains(&id) {
                return true;
            }
            if id == ROOT {
                return false;
            }
            match self.nodes.get(&id) {
                Some(n) => id = n.parent,
                None => return false,
            }
        }
    }

    /// Whether setting `id` under `parent` to a record hashing to `hash` would change nothing:
    /// the very same record, where it already is.
    fn unchanged_set(&self, id: u32, parent: u32, hash: u64) -> bool {
        self.nodes
            .get(&id)
            .is_some_and(|n| n.hash != 0 && n.parent == parent && n.hash == hash)
    }

    /// Takes `id` out of `parent`'s children, answering where it was.
    fn detach(&mut self, id: u32, parent: u32) -> usize {
        let Some(p) = self.nodes.get_mut(&parent) else { return 0 };
        match p.children.iter().position(|c| *c == id) {
            Some(i) => {
                p.children.remove(i);
                i
            }
            None => p.children.len(),
        }
    }

    fn attach(&mut self, id: u32, parent: u32, index: Option<usize>) {
        if let Some(p) = self.nodes.get_mut(&parent) {
            let i = index.unwrap_or(p.children.len()).min(p.children.len());
            p.children.insert(i, id);
        }
        self.dirty_up(parent);
    }

    /// Forgets cached bounds and pass flags of `id` and every ancestor.
    fn dirty_up(&self, mut id: u32) {
        loop {
            let Some(n) = self.nodes.get(&id) else { return };
            n.bounds.set(None);
            n.kids.set(None);
            n.has_pass.set(None);
            n.has_blend.set(None);
            if id == ROOT {
                return;
            }
            id = n.parent;
        }
    }

    /// Notes ancestors of an edit where flushes can change. A clipped, non-isolating container
    /// can also stop or start a descendant's flush when the container is culled.
    fn note_pass_ancestors(&mut self, mut at: u32, txn: &mut Txn, flush_origin: Option<u32>) {
        if !txn.track {
            return;
        }
        let mut reaches_page = flush_origin.is_some();
        let mut may_change_scope = false;
        while at != ROOT {
            let Some(n) = self.nodes.get(&at) else { break };
            let parent = n.parent;
            let isolates = n.record.blend != 0 || (n.record.isolate() && n.record.opacity < 1.0);
            let iso = isolates || !n.record.post_effects.is_empty();
            if iso && flush_origin.is_some_and(|id| id != at) {
                may_change_scope = true;
                txn.iso_replay.insert(at);
                // A post effect can turn off at some scales. A blend or faded picture owns
                // its children's offscreen work whenever that work is present.
                reaches_page &= !isolates;
            }
            if txn.pass_ancestor_seen.insert(at) {
                let had_pass = self.subtree_has_pass(at);
                may_change_scope |= had_pass;
                if iso || had_pass {
                    let had_pad = self.bounds_and_pad(at).1;
                    let had_blend = self.subtree_has_blend(at);
                    let rect = self.dirty_extent(at);
                    // Once structure changes mid-patch, every `txn.before` entry is marked
                    // `stale = true` on commit, so rebuilding the full preorder map is dead work.
                    let ord = if self.structure == txn.before_structure {
                        self.order_of(at)
                    } else {
                        (0, u32::MAX)
                    };
                    txn.pass_ancestors.push(PassAncestor {
                        id: at,
                        isolated: iso,
                        had_pass,
                        had_pad,
                        had_blend,
                        before_rect: rect,
                        order: ord,
                    });
                }
            }
            at = parent;
        }
        if reaches_page || may_change_scope {
            let page = txn.page_scope.get_or_insert_with(|| PageScope {
                before_rect: self.world_extent(ROOT),
                replay: false,
            });
            page.replay |= reaches_page;
        }
    }

    /// Notes all direct children of `parent` once per transaction when a mask or mask-ending
    /// sibling changes inside a container that actually has a mask.
    fn note_mask_siblings(&mut self, parent: u32, txn: &mut Txn) {
        if !txn.mask_siblings_seen.insert(parent) {
            return;
        }
        let Some(kids) = self.nodes.get(&parent).map(|n| n.children.clone()) else {
            return;
        };
        for c in kids {
            self.note_before(c, txn);
        }
    }

    /// Notes where `id`'s subtree paints now, before a command changes it (at most once per
    /// transaction so batch patches never build duplicate dirty rectangles).
    fn note_before(&mut self, id: u32, txn: &mut Txn) {
        if txn.filling == Some(id) {
            txn.filled.insert(id);
        } else {
            txn.changed_otherwise.insert(id);
        }
        if !txn.before_seen.insert(id) {
            return;
        }
        txn.touched.push(id);
        let Some(node) = self.nodes.get(&id) else {
            return;
        };
        // In a masked sibling list, even ordinary content can create or remove a picture
        // mask pass by becoming the first or last record in its scope.
        let may_flush = self.parent_has_mask(node.parent) || self.subtree_has_pass(id);
        self.note_pass_ancestors(id, txn, may_flush.then_some(id));
        let (order, end) = if self.structure == txn.before_structure {
            self.order_of(id)
        } else {
            (0, u32::MAX)
        };
        if let Some(rect) = self.dirty_extent(id) {
            txn.before_at.insert(id, txn.before.len());
            txn.before.push(Dirty {
                rect,
                order,
                end,
                stale: false,
                refine: false,
            });
        }
    }

    /// Whether setting `old` to `new` only loads an image where its placeholder was (#352
    /// re-check): a placeholder fill becomes the image, clipped to the very same shape (path
    /// contents and even-odd rule) or filling it (tiled), at the placeholder's opacity and blend,
    /// and nothing else about the record changes. Ops compare by what they draw: their paths'
    /// contents, not indices (the image's placement adds a path), caches set aside. An image
    /// already there stays exactly as it was. The caller checks the parent.
    fn fills_placeholder(old: &Record, new: &Record) -> bool {
        use crate::record::{BackgroundBlurOp, Paint, ProgressiveBlurOp};
        // Paths compare by contents, not index: the image's placement adds a path, which shifts
        // later indices. Everything compares with `PartialEq`, never by formatting.
        fn same_path(a: &Record, i: u32, b: &Record, j: u32) -> bool {
            matches!((a.paths.get(i as usize), b.paths.get(j as usize)), (Some(p), Some(q)) if p == q)
        }
        fn same_paths(a: &Record, i: &[u32], b: &Record, j: &[u32]) -> bool {
            i.len() == j.len() && i.iter().zip(j).all(|(&x, &y)| same_path(a, x, b, y))
        }
        /// Whether two ops draw the same: equal but for path indices (their paths compare), a
        /// stroke's outline cache and a glass op's measured inradius set aside.
        fn same_op(a: &Record, x: &Op, b: &Record, y: &Op) -> bool {
            match (x, y) {
                (
                    Op::Fill {
                        path: p,
                        even_odd: e,
                        paint: f,
                        blend: l,
                    },
                    Op::Fill {
                        path: q,
                        even_odd: e2,
                        paint: f2,
                        blend: l2,
                    },
                ) => e == e2 && f == f2 && l == l2 && same_path(a, *p, b, *q),
                (
                    Op::Stroke {
                        path: p,
                        style: s,
                        paint: f,
                        blend: l,
                        cache: _,
                    },
                    Op::Stroke {
                        path: q,
                        style: s2,
                        paint: f2,
                        blend: l2,
                        cache: _,
                    },
                ) => s == s2 && f == f2 && l == l2 && same_path(a, *p, b, *q),
                (Op::Clip { path: p, even_odd: e }, Op::Clip { path: q, even_odd: e2 }) => {
                    e == e2 && same_path(a, *p, b, *q)
                }
                (Op::Unclip, Op::Unclip) | (Op::Children, Op::Children) | (Op::Unlayer, Op::Unlayer) => true,
                (Op::Read { kernel: k, halo: h }, Op::Read { kernel: k2, halo: h2 }) => k == k2 && h == h2,
                (Op::Layer { compose: c }, Op::Layer { compose: c2 }) => c == c2,
                (
                    Op::DropShadow {
                        paths: p,
                        even_odd: e,
                        dx,
                        dy,
                        blur,
                        color,
                        blend,
                        stroke,
                    },
                    Op::DropShadow {
                        paths: q,
                        even_odd: e2,
                        dx: dx2,
                        dy: dy2,
                        blur: r2,
                        color: c2,
                        blend: l2,
                        stroke: s2,
                    },
                ) => {
                    e == e2
                        && (dx, dy, blur, color, blend) == (dx2, dy2, r2, c2, l2)
                        && stroke == s2
                        && same_paths(a, p, b, q)
                }
                (
                    Op::InnerShadow {
                        shape: p,
                        hole: h,
                        even_odd: e,
                        dx,
                        dy,
                        blur,
                        color,
                        blend,
                    },
                    Op::InnerShadow {
                        shape: q,
                        hole: h2,
                        even_odd: e2,
                        dx: dx2,
                        dy: dy2,
                        blur: r2,
                        color: c2,
                        blend: l2,
                    },
                ) => {
                    e == e2
                        && (dx, dy, blur, color, blend) == (dx2, dy2, r2, c2, l2)
                        && same_path(a, *p, b, *q)
                        && match (h, h2) {
                            (None, None) => true,
                            (Some(i), Some(j)) => same_path(a, *i, b, *j),
                            _ => false,
                        }
                }
                // Destructured whole, so a field added later can't go uncompared. The lens's
                // measured inradius is a cache of what drawing measured, so it is set aside.
                (Op::Glass(g), Op::Glass(g2)) => {
                    let crate::record::GlassOp {
                        paths: p,
                        even_odd: e,
                        kind: k,
                        inradius: r,
                        angle: an,
                        intensity: i,
                        refraction: rf,
                        depth: d,
                        dispersion: di,
                        frost: fr,
                        splay: sp,
                        box_radii: br,
                        box_smoothing: bs,
                        measured_inradius: _,
                    } = &**g;
                    let crate::record::GlassOp {
                        paths: q,
                        even_odd: e2,
                        kind: k2,
                        inradius: r2,
                        angle: an2,
                        intensity: i2,
                        refraction: rf2,
                        depth: d2,
                        dispersion: di2,
                        frost: fr2,
                        splay: sp2,
                        box_radii: br2,
                        box_smoothing: bs2,
                        measured_inradius: _,
                    } = &**g2;
                    (e, k, r, an, i, rf, d, di, fr, sp, br, bs)
                        == (e2, k2, r2, an2, i2, rf2, d2, di2, fr2, sp2, br2, bs2)
                        && same_paths(a, p, b, q)
                }
                // Destructured whole, so a field added later can't go uncompared.
                (Op::BackgroundBlur(o), Op::BackgroundBlur(o2)) => {
                    let BackgroundBlurOp {
                        paths: p,
                        even_odd: e,
                        radius: r,
                    } = &**o;
                    let BackgroundBlurOp {
                        paths: q,
                        even_odd: e2,
                        radius: r2,
                    } = &**o2;
                    (e, r) == (e2, r2) && same_paths(a, p, b, q)
                }
                (Op::ProgressiveBlur(o), Op::ProgressiveBlur(o2)) => {
                    let ProgressiveBlurOp {
                        paths: p,
                        even_odd: e,
                        start_radius: r0,
                        end_radius: r1,
                        start: s0,
                        end: s1,
                    } = &**o;
                    let ProgressiveBlurOp {
                        paths: q,
                        even_odd: e2,
                        start_radius: r0_2,
                        end_radius: r1_2,
                        start: s0_2,
                        end: s1_2,
                    } = &**o2;
                    (e, r0, r1, s0, s1) == (e2, r0_2, r1_2, s0_2, s1_2) && same_paths(a, p, b, q)
                }
                _ => false,
            }
        }
        // Old and new ops in step: a placeholder fill becomes the image on its very shape (the
        // image clipped to the placeholder's path, or filling it, tiled), at its opacity and
        // blend; every other op draws the same, an image already there included.
        let (o, n) = (&old.ops, &new.ops);
        let (mut i, mut j, mut filled) = (0, 0, false);
        while i < o.len() {
            if let Op::Fill {
                path: p,
                even_odd: e,
                paint: Paint::Placeholder(opacity),
                blend: l,
            } = &o[i]
            {
                let image = |paint: &Paint, blend: &u8| {
                    matches!(paint, Paint::Image(im) if im.opacity == *opacity) && blend == l
                };
                let step = match (n.get(j), n.get(j + 1), n.get(j + 2)) {
                    (
                        Some(Op::Clip { path: c, even_odd: e2 }),
                        Some(Op::Fill { paint, blend, .. }),
                        Some(Op::Unclip),
                    ) if e == e2 && image(paint, blend) && same_path(old, *p, new, *c) => 3,
                    (
                        Some(Op::Fill {
                            path: q,
                            even_odd: e2,
                            paint,
                            blend,
                        }),
                        ..,
                    ) if e == e2 && image(paint, blend) && same_path(old, *p, new, *q) => 1,
                    _ => return false,
                };
                filled = true;
                i += 1;
                j += step;
                continue;
            }
            if !n.get(j).is_some_and(|y| same_op(old, &o[i], new, y)) {
                return false;
            }
            i += 1;
            j += 1;
        }
        // Everything else about the record stays as it was. Destructured whole, so a field
        // added later can't go uncompared: paths compare through the ops that use them, ops
        // above, and the coarse ops below, op by op.
        let Record {
            flags,
            opacity,
            transform,
            size,
            coarse_below,
            reach,
            paths: _,
            ops: _,
            coarse: _,
            post_effects,
            blend,
            mask,
            unsupported,
        } = old;
        filled
            && j == n.len()
            && *flags == new.flags
            && *opacity == new.opacity
            && *transform == new.transform
            && *size == new.size
            && *coarse_below == new.coarse_below
            && *reach == new.reach
            && *post_effects == new.post_effects
            && *blend == new.blend
            && *mask == new.mask
            && *unsupported == new.unsupported
            && old.coarse.len() == new.coarse.len()
            && old.coarse.iter().zip(&new.coarse).all(|(x, y)| same_op(old, x, new, y))
    }

    /// Paint order: each record's preorder index and the last index in its subtree.
    pub fn order_of(&mut self, id: u32) -> (u32, u32) {
        if self.readers.is_empty() {
            // Without readers order never matters to invalidation: skip building it.
            return (0, u32::MAX);
        }
        if self.order.is_none() {
            let mut map = HashMap::with_capacity(self.nodes.len());
            let mut next = 0u32;
            // Iterative preorder, then subtree ends on the way back up.
            let mut stack: Vec<(u32, bool)> = vec![(ROOT, false)];
            while let Some((at, done)) = stack.pop() {
                if done {
                    if let Some(e) = map.get_mut(&at) {
                        let (start, _) = *e;
                        *e = (start, next.saturating_sub(1).max(start));
                    }
                    continue;
                }
                map.insert(at, (next, next));
                next += 1;
                stack.push((at, true));
                if let Some(n) = self.nodes.get(&at) {
                    for c in n.children.iter().rev() {
                        stack.push((*c, false));
                    }
                }
            }
            self.order = Some(map);
        }
        self.order
            .as_ref()
            .and_then(|m| m.get(&id).copied())
            .unwrap_or((0, u32::MAX))
    }

    /// The world (page) transform of a record: its ancestors' transforms and its own.
    pub fn world(&self, id: u32) -> Affine {
        let mut chain = Vec::new();
        let mut at = id;
        while at != ROOT {
            let Some(n) = self.nodes.get(&at) else { break };
            chain.push(n.record.transform);
            at = n.parent;
        }
        chain.iter().rev().fold(Affine::IDENTITY, |m, t| m * *t)
    }

    /// Whether `id` or any visible descendant contains an offscreen pass that may flush Vello.
    pub fn subtree_has_pass(&self, id: u32) -> bool {
        let Some(node) = self.nodes.get(&id) else {
            return false;
        };
        if let Some(v) = node.has_pass.get() {
            return v;
        }
        let v = if node.record.hidden() {
            false
        } else {
            let draws_children = id == ROOT || node.record.ops.iter().any(|op| matches!(op, Op::Children));
            (node.record.has_offscreen_pass() || node.record.reads().is_some())
                || (draws_children && node.children.iter().any(|c| self.subtree_has_pass(*c)))
        };
        node.has_pass.set(Some(v));
        v
    }

    /// Whether `id` or any visible descendant uses a non-normal blend mode (for faded
    /// pass-through frames, decision 0038).
    pub fn subtree_has_blend(&self, id: u32) -> bool {
        let Some(node) = self.nodes.get(&id) else {
            return false;
        };
        if let Some(v) = node.has_blend.get() {
            return v;
        }
        let v = if node.record.hidden() {
            false
        } else {
            let draws_children = id == ROOT || node.record.ops.iter().any(|op| matches!(op, Op::Children));
            node.record.has_own_blend() || (draws_children && node.children.iter().any(|c| self.subtree_has_blend(*c)))
        };
        node.has_blend.set(Some(v));
        v
    }

    /// Where a record's subtree paints, in its own units, plus any unclipped page-space effect
    /// reach (drop shadows, layer blur).
    pub fn bounds_and_pad(&self, id: u32) -> (Option<Rect>, f64) {
        let Some(node) = self.nodes.get(&id) else {
            return (None, 0.0);
        };
        if let Some(b) = node.bounds.get() {
            return b;
        }
        let r = &node.record;
        let glyph_bounds = |g: u32| self.glyphs.bounds(g);
        let mut out = if r.hidden() {
            None
        } else {
            r.content_bounds(&glyph_bounds)
        };
        let mut pad = if r.hidden() { 0.0 } else { r.page_pad() };
        if !r.hidden() {
            // What the engine doesn't draw still counts where it may paint, so it's refused
            // wherever it could show rather than culled away.
            if r.refusing_bits() != 0 {
                let reach = f64::from(r.reach);
                let b = Rect::new(0.0, 0.0, f64::from(r.size[0]), f64::from(r.size[1])).inflate(reach, reach);
                out = Some(out.map_or(b, |o| o.union(b)));
            }
            // A provisional record (its text still loading) stands in over its box, grown by its
            // reach, whatever its placeholder ops cover: so it's never culled away uncounted (a
            // frame showing it is never exact), and its tiles go stale when the text arrives.
            if r.provisional() {
                let reach = f64::from(r.reach);
                let b = Rect::new(0.0, 0.0, f64::from(r.size[0]), f64::from(r.size[1])).inflate(reach, reach);
                out = Some(out.map_or(b, |o| o.union(b)));
            }
            // A reader paints over its own box.
            if r.reads().is_some() {
                let b = Rect::new(0.0, 0.0, f64::from(r.size[0]), f64::from(r.size[1]));
                out = Some(out.map_or(b, |o| o.union(b)));
            }
            let mut children: Option<Rect> = None;
            let mut child_pad = 0.0f64;
            if r.ops.iter().any(|op| matches!(op, Op::Children)) {
                for c in &node.children {
                    let (cb, cp) = self.bounds_and_pad(*c);
                    if let (Some(b), Some(cn)) = (cb, self.nodes.get(c)) {
                        let t = cn.record.transform.transform_rect_bbox(b);
                        children = Some(children.map_or(t, |o| o.union(t)));
                        child_pad = child_pad.max(cp);
                    }
                }
            }
            node.kids.set(Some((children, child_pad)));
            if let (Some(mut ch), Some(clip)) = (children, self.children_clip(r)) {
                // Children clipped to `clip` cannot paint outside `clip`, even with their own
                // page-space shadows; if any child has page-space reach, `clip` bounds it
                // regardless of local scale.
                ch = if child_pad > 0.0 { clip } else { ch.intersect(clip) };
                children = (ch.width() >= 0.0 && ch.height() >= 0.0).then_some(ch);
            } else {
                pad = pad.max(child_pad);
            }
            if let Some(ch) = children {
                out = Some(out.map_or(ch, |o| o.union(ch)));
            }
            if out.is_some() {
                pad += r.post_pad();
            }
        }
        node.bounds.set(Some((out, pad)));
        (out, pad)
    }

    /// Where a record's subtree paints, in its own units: its ops' bounds and its visible
    /// children's, kept to the clip its children are drawn in. None when it paints nothing.
    pub fn bounds(&self, id: u32) -> Option<Rect> {
        self.bounds_and_pad(id).0
    }

    /// The bounds of the innermost clip open where a record draws its children, if any.
    fn children_clip(&self, r: &Record) -> Option<Rect> {
        let mut open: Vec<u32> = Vec::new();
        for op in &r.ops {
            match op {
                Op::Clip { path, .. } => open.push(*path),
                Op::Unclip => {
                    open.pop();
                }
                Op::Children => break,
                _ => {}
            }
        }
        let mut out: Option<Rect> = None;
        for p in open {
            let b = match r.paths.get(p as usize)? {
                PathEntry::Outside(_) => continue,
                PathEntry::Glyphs { .. } => continue,
                _ => r.entry_bounds(p, &|g| self.glyphs.bounds(g))?,
            };
            out = Some(out.map_or(b, |o| o.intersect(b)));
        }
        out
    }

    /// Where a record's shown children paint, in its units, before any clip it draws them in,
    /// along with their maximum unclipped page-space effect reach.
    pub fn children_extent_and_pad(&self, id: u32) -> (Option<Rect>, f64) {
        self.bounds_and_pad(id);
        self.nodes.get(&id).and_then(|n| n.kids.get()).unwrap_or((None, 0.0))
    }

    /// Where a record's subtree paints, in page units.
    pub fn world_extent(&self, id: u32) -> Option<Rect> {
        let (b, pad) = self.bounds_and_pad(id);
        let r = self.world(id).transform_rect_bbox(b?);
        Some(if pad > 0.0 { r.inflate(pad, pad) } else { r })
    }

    /// Page-unit extent where a change to `id` may alter pixels, including outward spread from
    /// any blurred/post-processed ancestors and any isolated offscreen ancestor's page-space pad.
    pub fn dirty_extent(&self, id: u32) -> Option<Rect> {
        let r = self.world_extent(id)?;
        let mut anc_pad = 0.0f64;
        let mut at = id;
        while let Some(n) = self.nodes.get(&at) {
            let p = n.parent;
            if p == ROOT {
                break;
            }
            if let Some(pn) = self.nodes.get(&p) {
                anc_pad += pn.record.post_dirty_pad();
                if pn.record.blend != 0 || (pn.record.isolate() && pn.record.opacity < 1.0) {
                    anc_pad = anc_pad.max(self.bounds_and_pad(p).1);
                }
            }
            at = p;
        }
        Some(if anc_pad > 0.0 { r.inflate(anc_pad, anc_pad) } else { r })
    }

    /// Returns the lazily built per-revision reader acceleration cache.
    pub fn reader_cache(&self) -> Ref<'_, ReaderCache> {
        if self.reader_cache.borrow().is_none() {
            let built = self.build_reader_cache();
            *self.reader_cache.borrow_mut() = Some(built);
        }
        Ref::map(self.reader_cache.borrow(), |opt| opt.as_ref().expect("reader cache"))
    }

    fn build_reader_cache(&self) -> ReaderCache {
        let mut readers_world_bbox: Option<Rect> = None;
        let mut reader_extents = Vec::with_capacity(self.readers.len());
        for &id in &self.readers {
            if let Some(wb) = self.world_extent(id) {
                readers_world_bbox = Some(readers_world_bbox.map_or(wb, |acc| acc.union(wb)));
                reader_extents.push(wb);
            }
        }
        let mut isolated_with_reader = HashSet::new();
        let mut reader_ancestors = HashSet::new();
        let mut mark_ancestors = |start_id: u32, mark_isolated: bool| {
            let mut chain = Vec::new();
            let mut cur = start_id;
            let mut child_of_cur = false;
            while cur != ROOT {
                let Some(n) = self.nodes.get(&cur) else {
                    return;
                };
                if n.record.hidden() {
                    return;
                }
                if child_of_cur && !n.record.ops.iter().any(|op| matches!(op, Op::Children)) {
                    return;
                }
                chain.push((cur, n.record.isolate() && n.record.opacity < 1.0));
                child_of_cur = true;
                cur = n.parent;
            }
            for (id, iso) in chain {
                reader_ancestors.insert(id);
                if mark_isolated && iso {
                    isolated_with_reader.insert(id);
                }
            }
        };
        for &rid in &self.readers {
            mark_ancestors(rid, true);
        }
        if !self.context.is_empty() {
            for &cid in &self.context {
                mark_ancestors(cid, false);
            }
            for (&nid, node) in &self.nodes {
                if nid != ROOT && !node.record.context() && !node.record.hidden() {
                    let mut cur = node.parent;
                    let mut under_context = false;
                    while cur != ROOT {
                        let Some(p) = self.nodes.get(&cur) else {
                            break;
                        };
                        if p.record.context() {
                            under_context = true;
                            break;
                        }
                        cur = p.parent;
                    }
                    if under_context {
                        mark_ancestors(nid, true);
                    }
                }
            }
        }

        let mut visible_readers = Vec::new();
        if !self.readers.is_empty() {
            type ClipEntry = Option<(Affine, Rect, Option<[u8; 4]>)>;
            #[allow(clippy::too_many_arguments)]
            fn walk(
                store: &Store,
                ancestors: &HashSet<u32>,
                id: u32,
                parent: Affine,
                alpha: f32,
                parent_context: bool,
                post_records: &mut Vec<u32>,
                clip_stack: &mut Vec<ClipEntry>,
                out: &mut Vec<CachedReader>,
            ) {
                if !ancestors.contains(&id) {
                    return;
                }
                let Some(node) = store.nodes.get(&id) else {
                    return;
                };
                let r = &node.record;
                if r.hidden() {
                    return;
                }
                let world = parent * r.transform;
                if !world.as_coeffs().iter().all(|v| v.is_finite()) {
                    return;
                }
                let is_context = r.context();
                let in_alpha = if parent_context && !is_context { 1.0 } else { alpha };
                let opacity = in_alpha * r.opacity;
                if opacity <= 0.0 {
                    return;
                }
                let inner = if r.isolate() && r.opacity < 1.0 { 1.0 } else { opacity };
                let post_base = post_records.len();
                if r.post_effects.iter().any(crate::record::PostEffect::is_spatial) {
                    post_records.push(id);
                }
                let mut local_cache: Option<Rect> = None;
                let mut local_rect = || -> Rect {
                    *local_cache.get_or_insert_with(|| {
                        let box_rect = Rect::new(0.0, 0.0, f64::from(r.size[0]), f64::from(r.size[1]));
                        r.content_bounds(&|g| store.glyphs.bounds(g))
                            .map_or(box_rect, |cb| cb.union(box_rect))
                    })
                };
                let collect_clips = |stack: &[ClipEntry]| -> (Vec<(Affine, Rect)>, bool) {
                    let mut inner_fill: Option<Option<[u8; 4]>> = None;
                    for item in stack.iter().rev() {
                        if let Some((_, _, fill)) = *item {
                            inner_fill = Some(fill);
                            break;
                        }
                    }
                    let clips = stack.iter().filter_map(|item| item.map(|(w, lb, _)| (w, lb))).collect();
                    (clips, matches!(inner_fill, Some(None)))
                };
                let clip_base = clip_stack.len();
                for (at, op) in r.ops.iter().enumerate() {
                    match op {
                        Op::Clip { path, .. } => {
                            let entry = if crate::exec::clip_wraps_children(&r.ops, at) {
                                r.entry_bounds(*path, &|g| store.glyphs.bounds(g))
                                    .map(|lb| (world, lb, crate::exec::frame_solid_fill(&r.ops, at, inner)))
                            } else {
                                None
                            };
                            clip_stack.push(entry);
                        }
                        Op::Unclip => {
                            if clip_stack.len() > clip_base {
                                clip_stack.pop();
                            }
                        }
                        Op::Children => {
                            for &kid in &node.children {
                                walk(
                                    store,
                                    ancestors,
                                    kid,
                                    world,
                                    inner,
                                    is_context,
                                    post_records,
                                    clip_stack,
                                    out,
                                );
                            }
                        }
                        Op::Glass(g) if !is_context => {
                            let (clip_within, clip_unfilled) = collect_clips(clip_stack);
                            let (scale_halo, pad_px) = crate::glass::halo_parts(g);
                            out.push(CachedReader {
                                key: (id, at),
                                world,
                                local: local_rect(),
                                size: r.size,
                                writes_backdrop: false,
                                spatial_post_records: post_records.clone(),
                                clip_within,
                                clip_unfilled,
                                kind: CachedReaderKind::Glass { scale_halo, pad_px },
                            });
                        }
                        Op::Read { halo, .. } => {
                            let (clip_within, clip_unfilled) = collect_clips(clip_stack);
                            out.push(CachedReader {
                                key: (id, at),
                                world,
                                local: local_rect(),
                                size: r.size,
                                writes_backdrop: true,
                                spatial_post_records: post_records.clone(),
                                clip_within,
                                clip_unfilled,
                                kind: CachedReaderKind::Read { halo: *halo },
                            });
                        }
                        Op::BackgroundBlur(b_op) => {
                            let (clip_within, clip_unfilled) = collect_clips(clip_stack);
                            out.push(CachedReader {
                                key: (id, at),
                                world,
                                local: local_rect(),
                                size: r.size,
                                writes_backdrop: true,
                                spatial_post_records: post_records.clone(),
                                clip_within,
                                clip_unfilled,
                                kind: CachedReaderKind::BackgroundBlur { radius: b_op.radius },
                            });
                        }
                        Op::ProgressiveBlur(_) => {
                            let (clip_within, clip_unfilled) = collect_clips(clip_stack);
                            out.push(CachedReader {
                                key: (id, at),
                                world,
                                local: local_rect(),
                                size: r.size,
                                writes_backdrop: true,
                                spatial_post_records: post_records.clone(),
                                clip_within,
                                clip_unfilled,
                                kind: CachedReaderKind::ProgressiveBlur,
                            });
                        }
                        _ => {}
                    }
                }
                clip_stack.truncate(clip_base);
                post_records.truncate(post_base);
            }
            let mut post_records = Vec::new();
            let mut clip_stack = Vec::new();
            if let Some(root) = self.nodes.get(&ROOT) {
                for &kid in &root.children {
                    walk(
                        self,
                        &reader_ancestors,
                        kid,
                        Affine::IDENTITY,
                        1.0,
                        false,
                        &mut post_records,
                        &mut clip_stack,
                        &mut visible_readers,
                    );
                }
            }
        }

        ReaderCache {
            readers_world_bbox,
            reader_extents,
            isolated_with_reader,
            reader_ancestors,
            visible_readers,
        }
    }

    /// Whether any visible backdrop reader may paint inside `rect` (in device pixels under `view`).
    pub fn has_reader_in_rect(&self, view: Affine, rect: Rect) -> bool {
        if self.readers.is_empty() {
            return false;
        }
        let cache = self.reader_cache();
        let Some(all) = cache.readers_world_bbox else {
            return false;
        };
        let all_dev = view.transform_rect_bbox(all);
        if !(all_dev.x0 <= rect.x1 && rect.x0 <= all_dev.x1 && all_dev.y0 <= rect.y1 && rect.y0 <= all_dev.y1) {
            return false;
        }
        for &wb in &cache.reader_extents {
            let db = view.transform_rect_bbox(wb);
            if db.x0 <= rect.x1 && rect.x0 <= db.x1 && db.y0 <= rect.y1 && rect.y0 <= db.y1 {
                return true;
            }
        }
        false
    }

    /// Where the touched records paint now, added to where they painted before.
    fn changes(&mut self, before: Vec<Dirty>, touched: &[u32], refined: &HashSet<u32>) -> Vec<Dirty> {
        let mut items = before;
        let mut seen = std::collections::HashSet::new();
        for id in touched {
            if !seen.insert(*id) || !self.nodes.contains_key(id) {
                continue;
            }
            let (order, end) = self.order_of(*id);
            if let Some(rect) = self.dirty_extent(*id) {
                items.push(Dirty {
                    rect,
                    order,
                    end,
                    stale: false,
                    refine: refined.contains(id),
                });
            }
        }
        items
    }

    /// Where pixels may have changed on the device under `view`, from a patch's changes: each
    /// change's place, grown by `slop` device pixels (anti-aliasing reaches the pixels an edge
    /// crosses), then, in paint order, every backdrop reader that reads a change beneath it,
    /// which changes where the reader paints in turn (transitively). Readers sample whole
    /// pixels, so this is resolved on the device, for a camera, not in page units. Call it
    /// before the next patch: it uses the paint order the graph has now.
    pub fn dirty(&mut self, changes: &[Dirty], view: Affine, slop: f64) -> Vec<Rect> {
        self.dirty_with(changes, view, slop, true)
    }

    /// `dirty`, with the readers' page boxes kept a revision (`cached`) or worked out afresh.
    fn dirty_with(&mut self, changes: &[Dirty], view: Affine, slop: f64, cached: bool) -> Vec<Rect> {
        let mut items: Vec<Dirty> = changes
            .iter()
            .map(|d| Dirty {
                rect: view.transform_rect_bbox(d.rect).inflate(slop, slop),
                ..*d
            })
            .collect();
        let mut output_only: Vec<Rect> = Vec::new();
        if !self.readers.is_empty() && !items.is_empty() {
            // Each reader's paint order, subtree end, read and paint regions on the device, and
            // whether it reads after its children: worked out once.
            struct Reader {
                order: u32,
                end: u32,
                reads: Rect,
                paints: Rect,
                after_children: bool,
                writes_backdrop: bool,
                /// Changes before this index are known not to reach it.
                seen: usize,
                joined: bool,
            }
            // A view that keeps axes (a tile grid, a camera) maps page boxes to device boxes exactly,
            // so the readers' page boxes, worked out once a revision, serve every level.
            let [_, b, c, ..] = view.as_coeffs();
            let page = if cached && b == 0.0 && c == 0.0 {
                Some(self.dirty_readers())
            } else {
                None
            };
            let mut readers: Vec<Reader> = match &page {
                Some(page) => page
                    .iter()
                    .map(|r| Reader {
                        order: r.order,
                        end: r.end,
                        reads: view.transform_rect_bbox(r.reads).inflate(slop, slop),
                        paints: view.transform_rect_bbox(r.paints).inflate(slop, slop),
                        after_children: r.after_children,
                        writes_backdrop: r.writes_backdrop,
                        seen: 0,
                        joined: false,
                    })
                    .collect(),
                None => self
                    .readers_seen(view)
                    .into_iter()
                    .map(|r| Reader {
                        order: r.order,
                        end: r.end,
                        reads: r.reads.inflate(slop, slop),
                        paints: r.paints.inflate(slop, slop),
                        after_children: r.after_children,
                        writes_backdrop: r.writes_backdrop,
                        seen: 0,
                        joined: false,
                    })
                    .collect(),
            };
            readers.sort_unstable_by_key(|r| r.order);
            // In paint order, then again until no reader joins: a reader that reads after its
            // children reads what readers inside it paint, and those come later in paint order
            // (a fixed point, conservative). Each reader is checked only against the changes it
            // hasn't seen, so the closure costs readers × changes at most, however the passes go.
            let mut checks = 0u64;
            loop {
                let mut grew = false;
                for r in readers.iter_mut() {
                    if r.joined {
                        continue;
                    }
                    let from = r.seen;
                    checks += (items.len() - from) as u64;
                    let hit = items[from..].iter().any(|d| {
                        let beneath =
                            d.stale || d.order < r.order || (r.after_children && d.order <= r.end && d.order > r.order);
                        beneath && overlaps(d.rect, r.reads)
                    });
                    r.seen = items.len();
                    if hit {
                        r.joined = true;
                        // Decision 0007 (2026-11-20): glass writes only to output, never to the
                        // backdrop later readers sample, so a glass-only reader never transitively
                        // dirties later readers' full boxes.
                        if r.writes_backdrop {
                            grew = true;
                            items.push(Dirty {
                                rect: r.paints,
                                order: r.order,
                                end: r.order,
                                stale: false,
                                refine: false,
                            });
                        } else {
                            output_only.push(r.paints);
                        }
                    }
                }
                if !grew {
                    break;
                }
            }
            self.dirty_checks.set(checks);
        }
        let mut out: Vec<Rect> = items.into_iter().map(|d| d.rect).collect();
        out.extend(output_only);
        out
    }

    /// Drops the readers' page boxes kept for this revision (`dirty_readers`), as an edit does:
    /// for tests that compare against a store that keeps them.
    #[doc(hidden)]
    pub fn forget_dirty_readers(&self) {
        self.dirty_readers.borrow_mut().take();
    }

    /// The shown readers in page units (`DirtyReader`), worked out once a revision.
    fn dirty_readers(&mut self) -> std::rc::Rc<Vec<DirtyReader>> {
        if let Some(cached) = self.dirty_readers.borrow().as_ref() {
            return cached.clone();
        }
        let built = std::rc::Rc::new(self.readers_seen(Affine::IDENTITY));
        *self.dirty_readers.borrow_mut() = Some(built.clone());
        built
    }

    /// The shown readers as `dirty` sees them under `view` (device boxes, before slop).
    fn readers_seen(&mut self, view: Affine) -> Vec<DirtyReader> {
        let mut out = Vec::with_capacity(self.readers.len());
        for id in self.readers.clone() {
            if !self.drawn(id) {
                continue;
            }
            let (order, end) = self.order_of(id);
            let Some(node) = self.nodes.get(&id) else { continue };
            let r = &node.record;
            let halo = f64::from(r.reads().unwrap_or(0.0));
            let box_rect = Rect::new(0.0, 0.0, f64::from(r.size[0]), f64::from(r.size[1]));
            let b = r
                .content_bounds(&|g| self.glyphs.bounds(g))
                .map_or(box_rect, |cb| cb.union(box_rect));
            let device = view * self.world(id);
            let paint = device.transform_rect_bbox(b);
            // A reader's result passes through its own and enclosing layer effects.
            // Include that expanded output in damage and in later reader dependencies.
            let paints = self
                .dirty_extent(id)
                .map_or(paint, |extent| paint.union(view.transform_rect_bbox(extent)));
            out.push(DirtyReader {
                order,
                end,
                reads: device.transform_rect_bbox(b.inflate(halo, halo)),
                paints,
                // Its own subtree's changes are above it, unless it reads (any of its reads)
                // after its children are drawn.
                after_children: r
                    .ops
                    .iter()
                    .skip_while(|op| !matches!(op, Op::Children))
                    .any(Op::is_reader),
                writes_backdrop: r.reader_writes_backdrop(),
            });
        }
        out
    }

    /// Whether any export-context record (`FLAG_CONTEXT`) is held.
    pub fn has_context(&self) -> bool {
        !self.context.is_empty()
    }

    /// How many change-against-reader checks the last `dirty` made: its cost, bounded by readers
    /// times the changes and the readers that join.
    pub fn dirty_checks(&self) -> u64 {
        self.dirty_checks.get()
    }

    /// A provisional record that's shown (it and every ancestor), if there is one: an export
    /// waits until there's none, and no frame is exact while there's one (its text, once it
    /// arrives, may paint anywhere: its box bounds only its bars). Found once a revision.
    pub fn provisional_shown(&self) -> Option<u32> {
        if let Some((revision, found)) = self.provisional.get()
            && revision == self.revision
        {
            return found;
        }
        let found = self
            .nodes
            .iter()
            .filter(|(_, n)| n.record.provisional())
            .map(|(id, _)| *id)
            .find(|id| self.drawn(*id));
        self.provisional.set(Some((self.revision, found)));
        found
    }

    /// Whether a record and every ancestor are shown.
    fn drawn(&self, mut id: u32) -> bool {
        while id != ROOT {
            let Some(n) = self.nodes.get(&id) else { return false };
            if n.record.hidden() {
                return false;
            }
            id = n.parent;
        }
        true
    }

    /// Projected image axes in page units, before a tile's raster scale.
    pub fn image_spans(&self, image: u32) -> Vec<(f64, f64)> {
        let mut spans = Vec::new();
        for id in &self.image_records {
            if let Some(node) = self.nodes.get(id) {
                for paint in node.record.image_paints() {
                    if paint.image == image && paint.opacity > 0.0 {
                        spans.push(crate::images::span(self.world(*id) * paint.matrix));
                    }
                }
            }
        }
        spans
    }

    /// Where the records painting image `id` may change pixels, including outward spread from
    /// any blurred/textured ancestors and any siblings gated by an image-bearing mask. Readers
    /// they reach join through `dirty`.
    pub fn image_users(&mut self, id: u32) -> Vec<Dirty> {
        let mut users: Vec<u32> = self
            .image_records
            .iter()
            .copied()
            .filter(|r| self.nodes.get(r).is_some_and(|n| n.record.images().any(|i| i == id)))
            .collect();
        // If an image belongs to a mask layer, replacing it can alter all siblings in that container.
        let mut extra: Vec<u32> = Vec::new();
        for &r in &users {
            if let Some(n) = self.nodes.get(&r)
                && n.record.is_mask()
                && let Some(p) = self.nodes.get(&n.parent)
            {
                extra.extend(p.children.iter().copied());
            }
        }
        users.extend(extra);
        users.sort_unstable();
        users.dedup();
        let mut out = Vec::new();
        for r in users {
            let (order, end) = self.order_of(r);
            if let Some(rect) = self.dirty_extent(r) {
                out.push(Dirty {
                    rect,
                    order,
                    end,
                    stale: false,
                    refine: false,
                });
            }
        }
        out
    }

    /// The selection a drag's moved records make, if moving a cached picture of it is exact
    /// (decision 0040, "Dragging"): consecutive children of one parent (so contiguous in paint
    /// order within one scope), no backdrop reader on the page (phase 2 draws none: a page with
    /// one has no fast path), and no ancestor that fades as one (a faded frame would composite
    /// the selection with what's beneath it inside the group). Answers the parent, the first and
    /// last child index, and the parent's ancestor path (parent first).
    pub fn selection(&self, ids: &[u32]) -> Option<(u32, usize, usize, Vec<u32>)> {
        if ids.is_empty() || !self.readers.is_empty() || self.subtree_has_blend(ROOT) {
            return None;
        }
        let parent = self.nodes.get(ids.first()?)?.parent;
        if ids
            .iter()
            .any(|id| self.nodes.get(id).is_none_or(|n| n.parent != parent))
        {
            return None;
        }
        let siblings = &self.nodes.get(&parent)?.children;
        let mut at: Vec<usize> = ids
            .iter()
            .filter_map(|id| siblings.iter().position(|c| c == id))
            .collect();
        if at.len() != ids.len() {
            return None;
        }
        at.sort_unstable();
        let (first, last) = (*at.first()?, *at.last()?);
        if last - first + 1 != at.len() {
            return None;
        }
        let mut path = Vec::new();
        let mut p = parent;
        loop {
            path.push(p);
            let n = self.nodes.get(&p)?;
            if n.children.iter().any(|c| {
                self.nodes
                    .get(c)
                    .is_some_and(|cn| !cn.record.hidden() && cn.record.is_mask())
            }) {
                return None;
            }
            if p == ROOT {
                break;
            }
            if (n.record.isolate() && n.record.opacity < 1.0) || !n.record.post_effects.is_empty() {
                return None;
            }
            p = n.parent;
        }
        Some((parent, first, last, path))
    }

    /// Records with backdrop readers.
    pub fn readers(&self) -> &[u32] {
        &self.readers
    }

    /// Minimum offscreen GPU bytes (`width * height * 8`, colour + depth) held simultaneously by
    /// nested isolation groups enclosing any visible backdrop reader within `target` device pixels.
    pub fn reader_isolation_bytes(&self, view: Affine, target: crate::exec::IRect) -> usize {
        let target_rect = Rect::new(
            f64::from(target.x0),
            f64::from(target.y0),
            f64::from(target.x1),
            f64::from(target.y1),
        );
        let mut max_bytes = 0usize;
        for &id in &self.readers {
            let Some(r_world) = self.world_extent(id) else {
                continue;
            };
            if view.transform_rect_bbox(r_world).intersect(target_rect).area() <= 0.0 {
                continue;
            }
            let mut stack_bytes = 0usize;
            let mut at = id;
            while let Some(n) = self.nodes.get(&at) {
                let p = n.parent;
                if p == ROOT {
                    break;
                }
                if let Some(pn) = self.nodes.get(&p)
                    && (pn.record.blend != 0 || (pn.record.isolate() && pn.record.opacity < 1.0))
                    && let Some(ext) = self.world_extent(p)
                {
                    let clipped = view.transform_rect_bbox(ext).intersect(target_rect);
                    if clipped.area() > 0.0 {
                        let w = (clipped.x1.ceil() - clipped.x0.floor()).max(0.0) as usize;
                        let h = (clipped.y1.ceil() - clipped.y0.floor()).max(0.0) as usize;
                        stack_bytes = stack_bytes.saturating_add(w.saturating_mul(h).saturating_mul(8));
                    }
                }
                at = p;
            }
            max_bytes = max_bytes.max(stack_bytes);
        }
        max_bytes
    }

    /// Unsupported features and diagnostic notes, by record.
    pub fn unsupported(&self) -> Vec<(u32, u32)> {
        let mut out: Vec<(u32, u32)> = self
            .unsupported
            .iter()
            .filter_map(|id| self.nodes.get(id).map(|n| (*id, n.record.unsupported)))
            .collect();
        out.sort_unstable();
        out
    }

    /// The first shown record holding features the engine doesn't draw, if any: a page with one
    /// is refused whole, wherever it is (on screen or not, in an export's crop or not).
    pub fn refusal(&self) -> Option<(u32, u32)> {
        self.unsupported
            .iter()
            .filter_map(|id| {
                let bits = self.nodes.get(id)?.record.refusing_bits();
                (bits != 0 && self.drawn(*id)).then_some((*id, bits))
            })
            .min()
    }
}

fn overlaps(a: Rect, b: Rect) -> bool {
    a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1
}

/// Reads a message's header: the revision it applies to, the one it makes, command count, and minor version.
fn header(r: &mut Reader, limits: &Limits) -> Result<(u32, u32, usize, u16)> {
    if r.u32()? != MAGIC {
        return Err(EngineError::malformed("not a display list"));
    }
    let major = r.u16()?;
    let minor = r.u16()?;
    if major != MAJOR || minor > MINOR {
        return Err(EngineError::new(
            ErrorCode::Version,
            format!("display list {major}.{minor}; this engine reads {MAJOR}.0 to {MAJOR}.{MINOR}"),
        ));
    }
    let base = r.u32()?;
    let next = r.u32()?;
    let n = r.count(limits.records.saturating_mul(4), "commands", 8)?;
    Ok((base, next, n, minor))
}

/// Reads one command from its own length-bounded reader, checking it's exactly as long as it says.
fn next_command(r: &mut Reader, limits: &Limits, minor: u16) -> Result<Command> {
    let op = r.u32()?;
    let len = r.u32()? as usize;
    if len > r.remaining() {
        return Err(EngineError::malformed("a command longer than the message"));
    }
    let mut c = r.sub(len)?;
    let command = match op {
        1 => Command::Reset,
        2 => Command::Glyph {
            glyph: c.u32()?,
            path: c.path(limits.path_verbs)?,
        },
        3 => Command::GlyphFree { glyph: c.u32()? },
        4 => {
            let id = c.u32()?;
            let parent = c.u32()?;
            let hash = record_hash(c.rest());
            Command::Set {
                id,
                parent,
                record: record::decode(&mut c, limits, minor)?,
                hash,
            }
        }
        5 => Command::Remove { id: c.u32()? },
        6 => {
            let parent = c.u32()?;
            let count = c.count(limits.records, "children", 4)?;
            let mut ids = Vec::with_capacity(count);
            for _ in 0..count {
                ids.push(c.u32()?);
            }
            Command::Order { parent, ids }
        }
        7 => Command::Transform {
            id: c.u32()?,
            transform: c.affine()?,
        },
        k => return Err(EngineError::malformed(format!("unknown command {k}"))),
    };
    if !c.done() {
        return Err(EngineError::malformed(format!(
            "command {op} is {} bytes, not the {len} it says",
            c.at()
        )));
    }
    Ok(command)
}

#[cfg(test)]
impl Store {
    pub(crate) fn insert_for_test(&mut self, id: u32, parent: u32, record: Record) {
        if record.ops.iter().any(Op::is_reader) {
            self.readers.push(id);
        }
        self.nodes.insert(id, Node::new(record, parent, 0));
        if let Some(p) = self.nodes.get_mut(&parent) {
            p.children.push(id);
        }
        self.reader_cache.borrow_mut().take();
        self.dirty_readers.borrow_mut().take();
    }
}

#[cfg(test)]
mod dirty_tests {
    use super::*;
    use crate::record::{BackgroundBlurOp, CompactPath, PathEntry};

    fn rect_path(w: f64, h: f64) -> PathEntry {
        use vello_common::kurbo::Shape;
        PathEntry::Path(CompactPath::from_bez(&Rect::new(0.0, 0.0, w, h).into_path(0.1)))
    }

    /// The readers' page boxes, kept a revision, give what working them out under each view gives:
    /// tile grids at any scale and offset, readers under rotated and scaled groups, with halos.
    #[test]
    fn readers_kept_a_revision_dirty_what_each_view_works_out() {
        let mut store = Store::new(Limits::default());
        let mut group = Record::empty();
        group.transform = Affine::translate((40.0, -20.0)) * Affine::rotate(0.4) * Affine::scale(1.5);
        group.size = [200.0, 120.0];
        group.ops = vec![Op::Children];
        store.insert_for_test(1, ROOT, group);
        let mut blur = Record::empty();
        blur.transform = Affine::translate((10.0, 15.0));
        blur.size = [60.0, 30.0];
        blur.paths.push(rect_path(60.0, 30.0));
        blur.ops = vec![Op::BackgroundBlur(Box::new(BackgroundBlurOp {
            paths: vec![0],
            even_odd: false,
            radius: 8.0,
        }))];
        store.insert_for_test(2, 1, blur);
        let mut read = Record::empty();
        read.transform = Affine::translate((300.0, 90.0)) * Affine::scale_non_uniform(0.5, 2.0);
        read.size = [40.0, 40.0];
        read.ops = vec![Op::Read { kernel: 0, halo: 12.0 }];
        store.insert_for_test(3, ROOT, read);
        let mut plain = Record::empty();
        plain.size = [500.0, 400.0];
        store.insert_for_test(4, ROOT, plain);
        let changes = [
            Dirty {
                rect: Rect::new(30.0, 0.0, 80.0, 60.0),
                order: 0,
                end: 0,
                stale: true,
                refine: false,
            },
            Dirty {
                rect: Rect::new(280.0, 60.0, 330.0, 200.0),
                order: 0,
                end: 0,
                stale: true,
                refine: false,
            },
        ];
        for view in [
            Affine::IDENTITY,
            Affine::new([0.25, 0.0, 0.0, 0.25, -12.5, 7.0]),
            Affine::new([3.0, 0.0, 0.0, 3.0, -900.0, -40.0]),
            Affine::new([0.0371, 0.0, 0.0, 0.0371, 3.25, 1.75]),
        ] {
            let kept = store.dirty_with(&changes, view, 1.5, true);
            let afresh = store.dirty_with(&changes, view, 1.5, false);
            assert_eq!(kept.len(), afresh.len(), "{view:?}");
            assert!(kept.len() > changes.len(), "a reader joined under {view:?}");
            for (a, b) in kept.iter().zip(&afresh) {
                for (x, y) in [(a.x0, b.x0), (a.y0, b.y0), (a.x1, b.x1), (a.y1, b.y1)] {
                    assert!((x - y).abs() < 1e-9, "{a:?} vs {b:?} under {view:?}");
                }
            }
        }
    }

    #[test]
    fn reader_isolation_bytes_sums_nested_isolating_ancestors_clipped_to_target() {
        let mut store = Store::new(Limits::default());
        let mut outer = Record::empty();
        outer.flags = crate::record::FLAG_ISOLATE;
        outer.opacity = 0.95;
        outer.size = [3200.0, 3200.0];
        outer.ops = vec![Op::Children];
        store.insert_for_test(1, ROOT, outer);

        let mut inner = Record::empty();
        inner.flags = crate::record::FLAG_ISOLATE;
        inner.opacity = 0.95;
        inner.transform = Affine::translate((100.0, 50.0));
        inner.size = [800.0, 400.0];
        inner.ops = vec![Op::Children];
        store.insert_for_test(2, 1, inner);

        let mut blur = Record::empty();
        blur.size = [800.0, 400.0];
        blur.paths.push(rect_path(800.0, 400.0));
        blur.ops = vec![Op::BackgroundBlur(Box::new(BackgroundBlurOp {
            paths: vec![0],
            even_odd: false,
            radius: 28.0,
        }))];
        store.insert_for_test(3, 2, blur);

        let target = crate::exec::IRect {
            x0: 0,
            y0: 0,
            x1: 1000,
            y1: 500,
        };
        let bytes = store.reader_isolation_bytes(Affine::IDENTITY, target);
        // Both outer and inner clip to inner's visible extent inside target (800x400 + blur pad),
        // giving 2 nested isolation targets at 8 B/px each (>= 2 * 800 * 400 * 8).
        assert!(bytes >= 2 * 800 * 400 * 8, "got {bytes}");
        // Off-screen target reports 0.
        let off = crate::exec::IRect {
            x0: 5000,
            y0: 5000,
            x1: 5500,
            y1: 5500,
        };
        assert_eq!(store.reader_isolation_bytes(Affine::IDENTITY, off), 0);
    }
}
