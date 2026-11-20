//! Shelves of glyph masks in one square texture (the GPU backend's atlas, `gpu.rs`). Kept apart
//! from the GPU code so it's tested natively.
//!
//! Masks are packed left to right on shelves of similar height. When the texture is full, the
//! shelf least recently used (not in the frame being drawn) is emptied and reused, and the caller
//! evicts the masks that were on it: space comes back a shelf at a time, never the whole page.

#[derive(Clone, Copy, Debug)]
struct Shelf {
    y: u32,
    h: u32,
    /// Where the next mask on it goes.
    x: u32,
    /// The last frame a mask on it was placed or drawn.
    used: u64,
}

/// Where a mask went.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Placed {
    /// Free space.
    At { x: u32, y: u32 },
    /// A shelf emptied for it: the masks on rows `shelf_y..shelf_y + shelf_h` must be evicted.
    Reused { x: u32, y: u32, shelf_y: u32, shelf_h: u32 },
}

pub struct Shelves {
    side: u32,
    shelves: Vec<Shelf>,
    next_y: u32,
}

impl Shelves {
    pub fn new(side: u32) -> Self {
        Self {
            side,
            shelves: Vec::new(),
            next_y: 0,
        }
    }

    /// A shelf a mask `h` tall goes on: no shorter, and not much taller (a quarter at most).
    fn suits(shelf_h: u32, h: u32) -> bool {
        h <= shelf_h && h * 4 >= shelf_h * 3
    }

    /// Finds room for a `w` × `h` mask in `frame`; None when there is none this frame.
    pub fn place(&mut self, w: u32, h: u32, frame: u64) -> Option<Placed> {
        if w == 0 || h == 0 || w > self.side || h > self.side {
            return None;
        }
        for shelf in &mut self.shelves {
            if Self::suits(shelf.h, h) && shelf.x + w <= self.side {
                let at = Placed::At { x: shelf.x, y: shelf.y };
                shelf.x += w + 1;
                shelf.used = frame;
                return Some(at);
            }
        }
        if self.next_y + h <= self.side {
            let y = self.next_y;
            self.shelves.push(Shelf {
                y,
                h,
                x: w + 1,
                used: frame,
            });
            self.next_y += h + 1;
            return Some(Placed::At { x: 0, y });
        }
        // Full: empty the least recently used shelf that suits, unless this frame drew from it
        // (its texels are in the frame's draws, which run after the upload).
        if let Some(shelf) = self
            .shelves
            .iter_mut()
            .filter(|s| Self::suits(s.h, h) && s.used < frame)
            .min_by_key(|s| s.used)
        {
            shelf.x = w + 1;
            shelf.used = frame;
            return Some(Placed::Reused {
                x: 0,
                y: shelf.y,
                shelf_y: shelf.y,
                shelf_h: shelf.h,
            });
        }
        // None suits (the masks wanted are another size now: a zoom changed the scale): neighbours
        // this frame didn't draw from, merged into a shelf of the height wanted (what's left
        // below it, a shelf of its own), the least recently used run first. Without this, a page
        // of shelves of one size would refuse every mask of another for good.
        self.merge(w, h, frame)
    }

    /// Empties the run of neighbouring shelves, none drawn from in `frame`, that's tall enough for
    /// a `w` × `h` mask and least recently used, and puts a shelf `h` tall at its top.
    fn merge(&mut self, w: u32, h: u32, frame: u64) -> Option<Placed> {
        // A run reaching the last shelf may also take the free rows below it.
        let last = self.shelves.len().checked_sub(1)?;
        let reach = |j: usize, s: &Shelf| if j == last { self.side } else { s.y + s.h };
        let mut best: Option<(u64, usize, usize)> = None;
        for i in 0..self.shelves.len() {
            let top = self.shelves[i].y;
            let mut newest = 0u64;
            for j in i..self.shelves.len() {
                let s = self.shelves[j];
                if s.used >= frame {
                    break;
                }
                newest = newest.max(s.used);
                if reach(j, &s) - top >= h {
                    if best.is_none_or(|(n, _, _)| newest < n) {
                        best = Some((newest, i, j));
                    }
                    break;
                }
            }
        }
        let (_, i, j) = best?;
        let top = self.shelves[i].y;
        // The rows masks were on (their masks are evicted); past them, free rows.
        let end = self.shelves[j].y + self.shelves[j].h;
        let mut fresh = vec![Shelf {
            y: top,
            h,
            x: w + 1,
            used: frame,
        }];
        if j == last {
            // The tail below is free again from the new shelf's end.
            self.next_y = top + h + 1;
        } else if end > top + h + 1 {
            fresh.push(Shelf {
                y: top + h + 1,
                h: end - (top + h + 1),
                x: 0,
                used: 0,
            });
        }
        self.shelves.splice(i..=j, fresh);
        Some(Placed::Reused {
            x: 0,
            y: top,
            shelf_y: top,
            shelf_h: end - top,
        })
    }

    /// A mask at row `y` was drawn in `frame`.
    pub fn touch(&mut self, y: u32, frame: u64) {
        // Shelves are made top to bottom: the one holding `y` is the last starting at or above it.
        let i = self.shelves.partition_point(|s| s.y <= y);
        if let Some(s) = i.checked_sub(1).and_then(|i| self.shelves.get_mut(i))
            && y < s.y + s.h
        {
            s.used = s.used.max(frame);
        }
    }

    /// Empties every shelf (the device was lost, or the atlas recreated).
    pub fn reset(&mut self) {
        self.shelves.clear();
        self.next_y = 0;
    }

    pub fn shelves(&self) -> usize {
        self.shelves.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn packs_then_reuses_the_least_recently_used_shelf() {
        let mut a = Shelves::new(64);
        // Four shelves 15 tall fill 64 rows (each takes a row of gap below it).
        let mut ys = Vec::new();
        for frame in 1..=4 {
            match a.place(60, 15, frame) {
                Some(Placed::At { y, .. }) => ys.push(y),
                other => panic!("expected free space, got {other:?}"),
            }
        }
        assert_eq!(ys, vec![0, 16, 32, 48]);
        // Shelf 0 was drawn from in frame 5; shelf 16 is now the least recently used.
        a.touch(3, 5);
        assert_eq!(
            a.place(60, 15, 6),
            Some(Placed::Reused {
                x: 0,
                y: 16,
                shelf_y: 16,
                shelf_h: 15
            })
        );
        // Then the next least recently used, oldest first, shelf 0 (drawn in frame 5) last.
        assert!(matches!(a.place(60, 15, 6), Some(Placed::Reused { y: 32, .. })));
        assert!(matches!(a.place(60, 15, 6), Some(Placed::Reused { y: 48, .. })));
        assert!(matches!(a.place(60, 15, 6), Some(Placed::Reused { y: 0, .. })));
        // Every shelf now holds a mask drawn in frame 6: none can be emptied during it.
        assert_eq!(a.place(60, 15, 6), None);
        // A later frame can (all drawn in frame 6: the first of them).
        assert!(matches!(a.place(60, 15, 7), Some(Placed::Reused { y: 0, .. })));
    }

    #[test]
    fn a_full_atlas_of_another_size_still_takes_a_mask() {
        let mut a = Shelves::new(64);
        // Eight shelves 7 tall fill the texture (each with a row of gap below it).
        for frame in 1..=8 {
            assert!(matches!(a.place(60, 7, frame), Some(Placed::At { .. })));
        }
        // A mask 20 tall suits none of them: the oldest run tall enough is emptied for it, and
        // what's left of the run below it is a shelf of its own.
        assert_eq!(
            a.place(30, 20, 9),
            Some(Placed::Reused {
                x: 0,
                y: 0,
                shelf_y: 0,
                shelf_h: 23
            })
        );
        assert_eq!(a.place(30, 20, 9), Some(Placed::At { x: 31, y: 0 }));
        // Shelves drawn from this frame are never emptied: past those, a run further down.
        a.touch(5, 10);
        a.touch(26, 10);
        assert!(matches!(a.place(30, 20, 10), Some(Placed::Reused { shelf_y: 32, .. })));
    }

    #[test]
    fn masks_go_on_shelves_that_suit_their_height() {
        let mut a = Shelves::new(64);
        assert_eq!(a.place(10, 20, 1), Some(Placed::At { x: 0, y: 0 }));
        // Too short for the 20-row shelf (under three quarters of it): a shelf of its own.
        assert_eq!(a.place(10, 10, 1), Some(Placed::At { x: 0, y: 21 }));
        assert_eq!(a.place(10, 16, 1), Some(Placed::At { x: 11, y: 0 }));
        assert_eq!(a.shelves(), 2);
    }
}
