//! Drags on the compute path without re-encoding the page (decision 0040, P1-0 item 3).
//!
//! The compute encoder walks the page once per revision into one Vello encoding. A drag is a
//! patch that only moves records (`Applied::moved`), and moving a record changes nothing in the
//! encoding but the world transforms of its subtree: every world transform under it is
//! `parent_world * transform * local`, so the new one is `delta * old` with
//! `delta = new_world * old_world⁻¹`, left-multiplied into the record's span of the transform
//! stream. Paths, paints, stroke outlines, glyphs and tags stay as they are.
//!
//! The encoder records each record's span of the transform stream and forces a fresh transform
//! where a record starts and ends, so no transform entry is shared across a record's boundary.
//! Transforms are kept in f64 and rounded to f32 only for upload, so a patched encoding matches
//! a fresh one (`tests/compute_moves.rs` checks it, to one f32 ulp).

use crate::store::{ROOT, Store};
use std::collections::{HashMap, HashSet};
use std::ops::Range;
use vello_common::kurbo::Affine;

/// A record's run of the transform stream, and the world transform it was encoded under.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Span {
    pub start: u32,
    pub end: u32,
    pub world: Affine,
}

/// Records spans while the encoder walks: `begin` when a record starts (before its first
/// transform), `end` when it is done.
#[derive(Default)]
pub struct SpanRecorder {
    stack: Vec<(u32, u32, Affine)>,
    pub spans: HashMap<u32, Span>,
}

impl SpanRecorder {
    pub fn begin(&mut self, id: u32, world: Affine, transforms: usize) {
        self.stack.push((id, transforms as u32, world));
    }

    pub fn end(&mut self, id: u32, transforms: usize) {
        if let Some((open, start, world)) = self.stack.pop() {
            debug_assert_eq!(open, id);
            self.spans.insert(
                id,
                Span {
                    start,
                    end: transforms as u32,
                    world,
                },
            );
        }
    }
}

/// Applies a patch that only moved `moved` (the store already holds their new transforms) to
/// `transforms` in place. Returns the transform index ranges to upload again, or `None` when
/// the page must be encoded afresh instead, which is always safe:
///
/// - a moved record the encoder didn't draw (hidden, a mask, never walked);
/// - one inside another moved record (it would move twice);
/// - one under an ancestor that bounds its children with a fixed layer rect (an isolated
///   translucent group, a blend, an `Op::Layer`): the rect was sized from where the children
///   were, so a child moved out of it would be cut off (`ordinary::bounds_children`).
///
/// Descendants are found through the store's tree, never through span containment: a record
/// that draws nothing of its own shares its only child's span, and treating it as inside the
/// child moved it too (the stack review's live T4 repro: 7,200 wrong pixels shown exact).
pub fn apply_moves(
    transforms: &mut [Affine],
    spans: &mut HashMap<u32, Span>,
    store: &Store,
    moved: &[u32],
) -> Option<Vec<Range<usize>>> {
    let moving: HashSet<u32> = moved.iter().copied().collect();
    let mut plan: Vec<(u32, Span, Affine)> = Vec::with_capacity(moved.len());
    for &id in moved {
        let node = store.nodes.get(&id)?;
        let span = *spans.get(&id)?;
        let mut up = node.parent;
        while up != ROOT {
            if moving.contains(&up) {
                return None;
            }
            let ancestor = store.nodes.get(&up)?;
            if crate::ordinary::bounds_children(&ancestor.record) {
                return None;
            }
            up = ancestor.parent;
        }
        let parent_world = if node.parent == ROOT {
            Affine::IDENTITY
        } else {
            spans.get(&node.parent)?.world
        };
        let world = parent_world * node.record.transform;
        if !world.as_coeffs().iter().all(|c| c.is_finite()) || span.world.determinant().abs() < 1e-12 {
            return None;
        }
        plan.push((id, span, world));
    }
    let mut dirty = Vec::with_capacity(plan.len());
    let mut stack = Vec::new();
    for (id, span, world) in plan {
        let delta = world * span.world.inverse();
        let range = span.start as usize..span.end as usize;
        for t in &mut transforms[range.clone()] {
            *t = delta * *t;
        }
        // Everything under it moved with it, so later moves of those start from where they are.
        stack.clear();
        stack.extend(
            store
                .nodes
                .get(&id)
                .map(|n| n.children.iter().copied())
                .into_iter()
                .flatten(),
        );
        while let Some(child) = stack.pop() {
            if let Some(s) = spans.get_mut(&child) {
                s.world = delta * s.world;
            }
            if let Some(n) = store.nodes.get(&child) {
                stack.extend(n.children.iter().copied());
            }
        }
        if let Some(s) = spans.get_mut(&id) {
            s.world = world;
        }
        if !range.is_empty() {
            dirty.push(range);
        }
    }
    Some(dirty)
}
