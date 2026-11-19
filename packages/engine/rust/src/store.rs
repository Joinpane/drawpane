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
    /// Subtree bounds in the record's own units: unknown (None) until computed.
    bounds: Cell<Option<Option<Rect>>>,
}

impl Node {
    fn new(record: Record, parent: u32) -> Self {
        Self {
            record,
            parent,
            children: Vec::new(),
            bounds: Cell::new(None),
        }
    }
}

enum Command {
    Reset,
    Glyph { glyph: u32, path: BezPath },
    GlyphFree { glyph: u32 },
    Set { id: u32, parent: u32, record: Record },
    Remove { id: u32 },
    Order { parent: u32, ids: Vec<u32> },
    Transform { id: u32, transform: Affine },
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
}

pub struct Store {
    pub limits: Limits,
    pub nodes: HashMap<u32, Node>,
    pub glyphs: GlyphStore,
    pub revision: u32,
    /// Records with backdrop readers, for invalidation.
    readers: Vec<u32>,
    /// Records holding features the engine doesn't draw (their `unsupported` bits).
    unsupported: HashSet<u32>,
    /// What the records hold, roughly, in bytes (`Record::heap_bytes`): held to `Limits::graph_bytes`.
    bytes: usize,
    /// Preorder index and subtree end of every record; rebuilt when the structure changes.
    order: Option<HashMap<u32, (u32, u32)>>,
    /// Bumped whenever the structure (parents, children, their order) changes.
    structure: u64,
}

/// What one message's commands do as they're applied: the undo log and where pixels change. A
/// fresh list is built into a staged graph that isn't tracked (it's dropped whole on failure).
struct Txn {
    track: bool,
    undo: Vec<Undo>,
    before: Vec<Dirty>,
    touched: Vec<u32>,
    full: bool,
}

impl Txn {
    fn new(track: bool) -> Self {
        Self {
            track,
            undo: Vec::new(),
            before: Vec::new(),
            touched: Vec::new(),
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
        nodes.insert(ROOT, Node::new(Record::empty(), ROOT));
        Self {
            limits,
            nodes,
            glyphs: GlyphStore::default(),
            revision: 0,
            readers: Vec::new(),
            unsupported: HashSet::new(),
            bytes: 0,
            order: None,
            structure: 0,
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
        let (base, next, n) = header(&mut r, &limits)?;
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
            return self.apply_fresh(&mut r, next, n);
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
        // Each command is applied as it's read (never all of them decoded at once), with an undo
        // log: a command that fails puts back everything before it.
        for _ in 0..n {
            let result = next_command(&mut r, &limits).and_then(|command| self.command(command, &mut txn));
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
            });
        }
        if self.structure != before_structure {
            for d in &mut txn.before {
                d.stale = true;
            }
        }
        let changes = self.changes(std::mem::take(&mut txn.before), &txn.touched);
        Ok(Applied { changes, full: false })
    }

    /// A fresh list: built into a staged graph, read once, and swapped in whole.
    fn apply_fresh(&mut self, r: &mut Reader, next: u32, n: usize) -> Result<Applied> {
        let limits = self.limits;
        let mut staged = Store::new(limits);
        let mut txn = Txn::new(false);
        let held = self.bytes();
        for i in 0..n {
            let command = next_command(r, &limits)?;
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
        self.bytes = staged.bytes;
        self.order = None;
        self.structure += 1;
        self.revision = next;
        Ok(Applied {
            changes: Vec::new(),
            full: true,
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
                } => {
                    let current = self.nodes.get(&id).map(|n| n.parent);
                    if let Some(p) = current {
                        self.detach(id, p);
                    }
                    if let Some(node) = self.nodes.get_mut(&id) {
                        let old = std::mem::replace(&mut node.record, record);
                        node.parent = parent;
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
                Undo::Transform { id, transform } => {
                    if let Some(n) = self.nodes.get_mut(&id) {
                        n.record.transform = transform;
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
                nodes.insert(ROOT, Node::new(Record::empty(), ROOT));
                let old = std::mem::replace(&mut self.nodes, nodes);
                let glyphs = std::mem::take(&mut self.glyphs);
                let readers = std::mem::take(&mut self.readers);
                self.unsupported.clear();
                self.bytes = 0;
                txn.push(Undo::Everything {
                    nodes: old,
                    glyphs,
                    readers,
                });
                self.order = None;
                self.structure += 1;
                txn.before.clear();
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
            Command::Set { id, parent, record } => {
                if id == ROOT {
                    return Err(EngineError::malformed("the page can't be set"));
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
                if txn.track {
                    self.note_before(id, txn);
                }
                let reads = record.reads().is_some();
                let unsupported = record.unsupported != 0;
                let cost = record.heap_bytes();
                self.glyphs.retain(&record);
                let mut structural = true;
                if let Some(node) = self.nodes.get_mut(&id) {
                    let old_parent = node.parent;
                    structural = old_parent != parent;
                    let old = std::mem::replace(&mut node.record, record);
                    node.parent = parent;
                    node.bounds.set(None);
                    self.bytes = self.bytes + cost - old.heap_bytes();
                    self.glyphs.release(&old);
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
                        });
                    }
                } else {
                    if self.nodes.len() > self.limits.records {
                        self.glyphs.release(&record);
                        return Err(EngineError::limit("too many records"));
                    }
                    self.bytes += cost + NODE_BYTES;
                    self.nodes.insert(id, Node::new(record, parent));
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
                if txn.track {
                    self.note_before(id, txn);
                }
                let index = self.detach(id, parent);
                self.dirty_up(parent);
                let mut removed = Vec::new();
                let mut stack = vec![id];
                while let Some(at) = stack.pop() {
                    if let Some(node) = self.nodes.remove(&at) {
                        stack.extend(node.children.iter().copied());
                        self.glyphs.release(&node.record);
                        self.bytes -= node.record.heap_bytes() + NODE_BYTES;
                        self.unsupported.remove(&at);
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
                if txn.track {
                    self.note_before(id, txn);
                }
                let node = self.nodes.get_mut(&id).expect("checked");
                let old = std::mem::replace(&mut node.record.transform, transform);
                txn.push(Undo::Transform { id, transform: old });
                // Its own bounds hold (they're in its units); its ancestors' don't.
                let parent = node.parent;
                self.dirty_up(parent);
            }
        }
        Ok(())
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

    /// Forgets cached bounds of `id` and every ancestor.
    fn dirty_up(&self, mut id: u32) {
        loop {
            let Some(n) = self.nodes.get(&id) else { return };
            n.bounds.set(None);
            if id == ROOT {
                return;
            }
            id = n.parent;
        }
    }

    /// Notes where `id`'s subtree paints now, before a command changes it.
    fn note_before(&mut self, id: u32, txn: &mut Txn) {
        txn.touched.push(id);
        if !self.nodes.contains_key(&id) {
            return;
        }
        let (order, end) = self.order_of(id);
        if let Some(rect) = self.world_extent(id) {
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

    /// Where a record's subtree paints, in its own units: its ops' bounds and its visible
    /// children's, kept to the clip its children are drawn in. None when it paints nothing.
    pub fn bounds(&self, id: u32) -> Option<Rect> {
        let node = self.nodes.get(&id)?;
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
        if !r.hidden() {
            // What the engine doesn't draw still counts where it may paint, so it's refused
            // wherever it could show rather than culled away.
            if r.unsupported != 0 {
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
            for c in &node.children {
                if let (Some(b), Some(cn)) = (self.bounds(*c), self.nodes.get(c)) {
                    let t = cn.record.transform.transform_rect_bbox(b);
                    children = Some(children.map_or(t, |o| o.union(t)));
                }
            }
            if let (Some(mut ch), Some(clip)) = (children, self.children_clip(r)) {
                ch = ch.intersect(clip);
                children = (ch.width() >= 0.0 && ch.height() >= 0.0).then_some(ch);
            }
            if let Some(ch) = children {
                out = Some(out.map_or(ch, |o| o.union(ch)));
            }
        }
        node.bounds.set(Some(out));
        out
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
                _ => {
                    use vello_common::kurbo::Shape;
                    r.entry_path(p)?.bounding_box()
                }
            };
            out = Some(out.map_or(b, |o| o.intersect(b)));
        }
        out
    }

    /// Where a record's subtree paints, in page units.
    pub fn world_extent(&self, id: u32) -> Option<Rect> {
        let b = self.bounds(id)?;
        Some(self.world(id).transform_rect_bbox(b))
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
            if let Some(rect) = self.world_extent(*id) {
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
            let mut readers: Vec<(u32, u32, u32)> = self
                .readers
                .clone()
                .into_iter()
                .map(|id| {
                    let (o, e) = self.order_of(id);
                    (o, e, id)
                })
                .collect();
            readers.sort_unstable();
            for (order, end, id) in readers {
                let Some(node) = self.nodes.get(&id) else { continue };
                if !self.drawn(id) {
                    continue;
                }
                let halo = f64::from(node.record.reads().unwrap_or(0.0));
                let b = Rect::new(0.0, 0.0, f64::from(node.record.size[0]), f64::from(node.record.size[1]));
                let device = view * self.world(id);
                let paints = device.transform_rect_bbox(b).inflate(slop, slop);
                let reads = device.transform_rect_bbox(b.inflate(halo, halo)).inflate(slop, slop);
                // What it reads changed if a change beneath it (earlier in paint order: an
                // earlier subtree or an ancestor) touches its read region. Its own subtree's
                // changes are above it, unless it reads after its children are drawn.
                let reads_after_children = node
                    .record
                    .ops
                    .iter()
                    .position(|op| matches!(op, Op::Children))
                    .zip(node.record.ops.iter().position(|op| matches!(op, Op::Read { .. })))
                    .is_some_and(|(c, r)| r > c);
                let affected = items.iter().any(|d| {
                    let beneath =
                        d.stale || d.order < order || (reads_after_children && d.order <= end && d.order > order);
                    beneath && overlaps(d.rect, reads)
                });
                if affected {
                    items.push(Dirty {
                        rect: paints,
                        order,
                        end: order,
                        stale: false,
                    });
                }
            }
        }
        items.into_iter().map(|d| d.rect).collect()
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

/// Reads a message's header: the revision it applies to, the one it makes, and its command count.
fn header(r: &mut Reader, limits: &Limits) -> Result<(u32, u32, usize)> {
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
    Ok((base, next, n))
}

/// Reads one command from its own length-bounded reader, checking it's exactly as long as it says.
fn next_command(r: &mut Reader, limits: &Limits) -> Result<Command> {
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
            Command::Set {
                id,
                parent,
                record: record::decode(&mut c, limits)?,
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
