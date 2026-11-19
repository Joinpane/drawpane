//! Glyph outlines, interned (review item 2, decision 0040 amendment). A glyph is defined once,
//! by TypeScript, from HarfBuzz's shaping or from a file's saved outlines (decision 0037), and
//! records refer to it by handle with its position. The engine counts references so an outline
//! still in use can't be freed or redefined: a glyph is immutable while any record refers to it.
//! Each definition takes a serial no other definition ever has, in this engine or another, across
//! resets and fresh lists, so caches keyed by it (the backends' coverage masks, `masks.rs`) never
//! confuse two outlines, even when a fresh list reuses a handle.

use crate::error::{EngineError, Result};
use crate::limits::Limits;
use crate::record::{PathEntry, Record};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use vello_common::kurbo::{BezPath, Rect, Shape};

/// Serials for glyph definitions, process wide: never reused, so a coverage mask made for one
/// outline can't be found for another after a reset (which starts handles over).
static SERIAL: AtomicU64 = AtomicU64::new(1);

#[derive(Clone)]
pub struct Glyph {
    pub path: BezPath,
    pub bounds: Option<Rect>,
    pub serial: u64,
    refs: u32,
    bytes: usize,
}

#[derive(Default, Clone)]
pub struct GlyphStore {
    glyphs: HashMap<u32, Glyph>,
    bytes: usize,
}

impl GlyphStore {
    pub fn get(&self, glyph: u32) -> Option<&Glyph> {
        self.glyphs.get(&glyph)
    }

    pub fn bounds(&self, glyph: u32) -> Option<Rect> {
        self.glyphs.get(&glyph).and_then(|g| g.bounds)
    }

    pub fn len(&self) -> usize {
        self.glyphs.len()
    }

    pub fn is_empty(&self) -> bool {
        self.glyphs.is_empty()
    }

    pub fn bytes(&self) -> usize {
        self.bytes
    }

    /// Defines a glyph, or redefines one no record uses; answers what it replaced. A glyph in use
    /// is immutable: redefining it is refused, so no record's bounds or pixels change under it.
    pub fn define(&mut self, glyph: u32, path: BezPath, limits: &Limits) -> Result<Option<Glyph>> {
        let bytes = path.elements().len() * 56 + 64;
        if let Some(g) = self.glyphs.get(&glyph)
            && g.refs > 0
        {
            return Err(EngineError::malformed(format!(
                "glyph {glyph} redefined while {} records use it",
                g.refs
            )));
        }
        let previous = self.glyphs.remove(&glyph);
        let freed = previous.as_ref().map_or(0, |g| g.bytes);
        if self.bytes - freed + bytes > limits.glyph_outline_bytes {
            if let Some(p) = previous {
                self.glyphs.insert(glyph, p);
            }
            return Err(EngineError::limit("glyph outlines over their budget"));
        }
        let bounds = (!path.is_empty()).then(|| path.bounding_box());
        self.bytes = self.bytes - freed + bytes;
        self.glyphs.insert(
            glyph,
            Glyph {
                path,
                bounds,
                serial: SERIAL.fetch_add(1, Ordering::Relaxed),
                refs: 0,
                bytes,
            },
        );
        Ok(previous)
    }

    /// Verbs a glyph's outline holds (for the expansion budget).
    pub fn verbs(&self, glyph: u32) -> usize {
        self.glyphs.get(&glyph).map_or(0, |g| g.path.elements().len())
    }

    pub fn free(&mut self, glyph: u32) -> Result<Glyph> {
        match self.glyphs.get(&glyph) {
            None => Err(EngineError::unknown(format!("no glyph {glyph} to free"))),
            Some(g) if g.refs > 0 => Err(EngineError::malformed(format!(
                "glyph {glyph} freed while {} records use it",
                g.refs
            ))),
            Some(_) => {
                let g = self.glyphs.remove(&glyph).expect("checked");
                self.bytes -= g.bytes;
                Ok(g)
            }
        }
    }

    /// Puts a glyph back as it was before a command (undo).
    pub fn restore(&mut self, glyph: u32, before: Option<Glyph>) {
        if let Some(g) = self.glyphs.remove(&glyph) {
            self.bytes -= g.bytes;
        }
        if let Some(g) = before {
            self.bytes += g.bytes;
            self.glyphs.insert(glyph, g);
        }
    }

    fn each(record: &Record, mut f: impl FnMut(u32)) {
        for p in &record.paths {
            if let PathEntry::Glyphs { glyphs, .. } = p {
                for g in glyphs {
                    f(g.glyph);
                }
            }
        }
    }

    /// Every glyph a record uses must be defined.
    pub fn check(&self, record: &Record) -> Result<()> {
        let mut missing = None;
        Self::each(record, |g| {
            if missing.is_none() && !self.glyphs.contains_key(&g) {
                missing = Some(g);
            }
        });
        match missing {
            Some(g) => Err(EngineError::unknown(format!(
                "a record uses glyph {g}, which isn't defined"
            ))),
            None => Ok(()),
        }
    }

    pub fn retain(&mut self, record: &Record) {
        let glyphs = &mut self.glyphs;
        Self::each(record, |g| {
            if let Some(e) = glyphs.get_mut(&g) {
                e.refs += 1;
            }
        });
    }

    pub fn release(&mut self, record: &Record) {
        let glyphs = &mut self.glyphs;
        Self::each(record, |g| {
            if let Some(e) = glyphs.get_mut(&g) {
                e.refs = e.refs.saturating_sub(1);
            }
        });
    }
}
