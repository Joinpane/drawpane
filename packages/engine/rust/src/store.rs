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
use std::cell::Cell;
use std::collections::{HashMap, HashSet};
use vello_common::kurbo::{Affine, BezPath, Rect};

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
}

#[derive(Default, Debug)]
pub struct Applied {
    /// Where the changed records painted before and paint now, in page units, with their
    /// places in paint order. `Store::dirty` adds the readers they reach, for a camera.
    pub changes: Vec<Dirty>,
    /// Everything changed (a reset): redraw it all.
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
    pub revision: u32,
    /// Records with backdrop readers, for invalidation.
    readers: Vec<u32>,
    /// How many change-against-reader checks the last `dirty` made (its cost, for the tests).
    dirty_checks: Cell<u64>,
    /// `provisional_shown`'s answer and the revision it was found for: asked every frame.
    provisional: Cell<Option<(u32, Option<u32>)>>,
    /// Records holding features the engine doesn't draw (their `unsupported` bits).
    unsupported: HashSet<u32>,
    /// Records that paint an image, so an image changing invalidates only what shows it.
    image_records: HashSet<u32>,
    /// Number of direct mask children under each parent, so `endsMask` edits in unmasked
    /// containers stay O(1) instead of scanning all siblings.
    masked_parents: HashMap<u32, usize>,
    /// What the records hold, roughly, in bytes (`Record::heap_bytes`): held to `Limits::graph_bytes`.
    bytes: usize,
    /// Preorder index and subtree end of every record; rebuilt when the structure changes.
    order: Option<HashMap<u32, (u32, u32)>>,
    /// Bumped whenever the structure (parents, children, their order) changes.
    structure: u64,
}

struct IsoAncestor {
    id: u32,
    had_pass: bool,
    had_pad: f64,
    had_blend: bool,
    before_rect: Option<Rect>,
    order: (u32, u32),
}

/// What one message's commands do as they're applied: the undo log and where pixels change. A
/// fresh list is built into a staged graph that isn't tracked (it's dropped whole on failure).
struct Txn {
    track: bool,
    undo: Vec<Undo>,
    before: Vec<Dirty>,
    before_seen: HashSet<u32>,
    mask_siblings_seen: HashSet<u32>,
    touched: Vec<u32>,
    /// Isolated faded ancestors of touched nodes, recorded before edits so if a descendant's
    /// edit flips `subtree_has_pass` (switching between Vello opacity and offscreen isolation),
    /// the ancestor's whole extent joins the dirty set.
    iso_ancestors: Vec<IsoAncestor>,
    iso_seen: HashSet<u32>,
    // A descendant edit can change where an offscreen pass quantizes this scope.
    iso_replay: HashSet<u32>,
    full: bool,
}

impl Txn {
    fn new(track: bool) -> Self {
        Self {
            track,
            undo: Vec::new(),
            before: Vec::new(),
            before_seen: HashSet::new(),
            mask_siblings_seen: HashSet::new(),
            touched: Vec::new(),
            iso_ancestors: Vec::new(),
            iso_seen: HashSet::new(),
            iso_replay: HashSet::new(),
            full: false,
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
            revision: 0,
            readers: Vec::new(),
            dirty_checks: Cell::new(0),
            provisional: Cell::new(None),
            unsupported: HashSet::new(),
            image_records: HashSet::new(),
            masked_parents: HashMap::new(),
            bytes: 0,
            order: None,
            structure: 0,
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
        let mut txn = Txn::new(true);
        let before_structure = self.structure;
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
        for IsoAncestor {
            id: a,
            had_pass,
            had_pad,
            had_blend,
            before_rect,
            order: (order, end),
        } in txn.iso_ancestors
        {
            if self.nodes.contains_key(&a)
                && (txn.iso_replay.contains(&a)
                    || self.subtree_has_pass(a) != had_pass
                    || self.subtree_has_blend(a) != had_blend
                    || (self.bounds_and_pad(a).1 - had_pad).abs() > 1e-6)
            {
                if let Some(rect) = before_rect {
                    txn.before.push(Dirty {
                        rect,
                        order,
                        end,
                        stale: false,
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
        let changes = self.changes(std::mem::take(&mut txn.before), &txn.touched);
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
        let mut txn = Txn::new(false);
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
        self.unsupported = staged.unsupported;
        self.image_records = staged.image_records;
        self.masked_parents = staged.masked_parents;
        self.bytes = staged.bytes;
        self.order = None;
        self.structure += 1;
        self.revision = next;
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
                    self.note_before(id, txn);
                    let draws_children = record.ops.iter().any(|op| matches!(op, Op::Children));
                    let may_flush = !record.hidden()
                        && (record.has_offscreen_pass()
                            || (draws_children
                                && self
                                    .nodes
                                    .get(&id)
                                    .is_some_and(|n| n.children.iter().any(|&child| self.subtree_has_pass(child)))));
                    self.note_iso_ancestors(parent, txn, may_flush.then_some(id));
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

    /// Notes isolated scopes before an edit. Adding or removing a descendant flush can change
    /// rounding anywhere in the scope, and its layer blend can amplify that difference.
    fn note_iso_ancestors(&mut self, mut at: u32, txn: &mut Txn, flush_origin: Option<u32>) {
        if !txn.track {
            return;
        }
        while at != ROOT {
            let Some(n) = self.nodes.get(&at) else { break };
            let parent = n.parent;
            let iso = n.record.blend != 0
                || (n.record.isolate() && n.record.opacity < 1.0)
                || !n.record.post_effects.is_empty();
            if iso && flush_origin.is_some_and(|id| id != at) {
                txn.iso_replay.insert(at);
            }
            if iso && txn.iso_seen.insert(at) {
                let had_pass = self.subtree_has_pass(at);
                let had_pad = self.bounds_and_pad(at).1;
                let had_blend = self.subtree_has_blend(at);
                let rect = self.dirty_extent(at);
                let ord = self.order_of(at);
                txn.iso_ancestors.push(IsoAncestor {
                    id: at,
                    had_pass,
                    had_pad,
                    had_blend,
                    before_rect: rect,
                    order: ord,
                });
            }
            at = parent;
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
        if !txn.before_seen.insert(id) {
            return;
        }
        txn.touched.push(id);
        if !self.nodes.contains_key(&id) {
            return;
        }
        let may_flush = self.subtree_has_pass(id);
        self.note_iso_ancestors(id, txn, may_flush.then_some(id));
        let (order, end) = self.order_of(id);
        if let Some(rect) = self.dirty_extent(id) {
            txn.before.push(Dirty {
                rect,
                order,
                end,
                stale: false,
            });
        }
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
            node.record.has_offscreen_pass()
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
            if r.unsupported != 0 {
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

    /// Where the touched records paint now, added to where they painted before.
    fn changes(&mut self, before: Vec<Dirty>, touched: &[u32]) -> Vec<Dirty> {
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
        let mut items: Vec<Dirty> = changes
            .iter()
            .map(|d| Dirty {
                rect: view.transform_rect_bbox(d.rect).inflate(slop, slop),
                ..*d
            })
            .collect();
        if !self.readers.is_empty() && !items.is_empty() {
            // Each reader's paint order, subtree end, read and paint regions on the device, and
            // whether it reads after its children: worked out once.
            struct Reader {
                order: u32,
                end: u32,
                reads: Rect,
                paints: Rect,
                after_children: bool,
                /// Changes before this index are known not to reach it.
                seen: usize,
                joined: bool,
            }
            let mut readers: Vec<Reader> = Vec::with_capacity(self.readers.len());
            for id in self.readers.clone() {
                if !self.drawn(id) {
                    continue;
                }
                let (order, end) = self.order_of(id);
                let Some(node) = self.nodes.get(&id) else { continue };
                let r = &node.record;
                let halo = f64::from(r.reads().unwrap_or(0.0));
                let b = Rect::new(0.0, 0.0, f64::from(r.size[0]), f64::from(r.size[1]));
                let device = view * self.world(id);
                readers.push(Reader {
                    order,
                    end,
                    reads: device.transform_rect_bbox(b.inflate(halo, halo)).inflate(slop, slop),
                    paints: device.transform_rect_bbox(b).inflate(slop, slop),
                    // Its own subtree's changes are above it, unless it reads (any of its reads)
                    // after its children are drawn.
                    after_children: r
                        .ops
                        .iter()
                        .skip_while(|op| !matches!(op, Op::Children))
                        .any(|op| matches!(op, Op::Read { .. })),
                    seen: 0,
                    joined: false,
                });
            }
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
                        grew = true;
                        items.push(Dirty {
                            rect: r.paints,
                            order: r.order,
                            end: r.order,
                            stale: false,
                        });
                    }
                }
                if !grew {
                    break;
                }
            }
            self.dirty_checks.set(checks);
        }
        items.into_iter().map(|d| d.rect).collect()
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

    /// Records whose features TypeScript flagged as not drawn by the engine.
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
            .filter(|id| self.drawn(**id))
            .filter_map(|id| self.nodes.get(id).map(|n| (*id, n.record.unsupported)))
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
