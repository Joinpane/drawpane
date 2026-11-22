//! Capacities for Vello 0.12's bump-allocated buffers on the opt-in compute path (decision
//! 0040, P1-0). Pure arithmetic, so it is tested natively; `vello_compute` feeds it the scene's
//! layout and the canvas size.
//!
//! The canvas matters as much as the scene. `coarse` reserves `PTCL_INITIAL_ALLOC` (64) command
//! words for every 16x16 tile before it allocates anything, and a few canvas-sized paths need a
//! tile entry for every canvas tile. PR #291 sized these from the path count alone, so a page
//! under ~5k paths drew blank rows at a Retina full window, and reported the frame exact.

use crate::error::{EngineError, Result};

/// Command words `coarse` reserves per 16x16 tile (`PTCL_INITIAL_ALLOC` in `coarse.wgsl`).
pub const PTCL_INITIAL_ALLOC: u32 = 64;

/// Bytes per element of each buffer, as `vello_encoding` lays them out.
pub const LINE_BYTES: u64 = 24;
pub const TILE_BYTES: u64 = 8;
pub const SEG_COUNT_BYTES: u64 = 8;
pub const SEGMENT_BYTES: u64 = 24;

/// What the capacities depend on in the scene.
#[derive(Clone, Copy, Debug, Default)]
pub struct SceneShape {
    pub n_paths: u32,
    pub n_draw_objects: u32,
    pub n_clips: u32,
    pub bin_data_start: u32,
    pub path_segments: u32,
}

/// The counts each stage's bump allocator reached (Vello's `BumpAllocators`, minus `failed`).
/// `ptcl` is the dynamic part only, as the allocator reports it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Needs {
    pub binning: u32,
    pub ptcl: u32,
    pub tile: u32,
    pub seg_counts: u32,
    pub segments: u32,
    pub blend: u32,
    pub lines: u32,
}

impl Needs {
    /// The larger of each, with half again of `seen`, so a stage that overflowed gets the room
    /// it asked for and some spare.
    pub fn grow(self, seen: Needs) -> Needs {
        let spare = |n: u32| n.saturating_add(n.div_ceil(2));
        Needs {
            binning: self.binning.max(spare(seen.binning)),
            ptcl: self.ptcl.max(spare(seen.ptcl)),
            tile: self.tile.max(spare(seen.tile)),
            seg_counts: self.seg_counts.max(spare(seen.seg_counts)),
            segments: self.segments.max(spare(seen.segments)),
            blend: self.blend.max(spare(seen.blend)),
            lines: self.lines.max(spare(seen.lines)),
        }
    }
}

/// Element counts for each buffer. `ptcl` includes `ptcl_fixed`, the per-tile region.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Caps {
    pub ptcl_fixed: u32,
    pub binning: u32,
    pub ptcl: u32,
    pub tile: u32,
    pub seg_counts: u32,
    pub segments: u32,
    pub blend: u32,
    pub lines: u32,
}

impl Caps {
    /// The dynamic command words: what the `ptcl` bump allocator may reach.
    pub fn ptcl_dynamic(&self) -> u32 {
        self.ptcl.saturating_sub(self.ptcl_fixed)
    }

    /// Whether these hold at least `other` in every buffer, for the same canvas.
    pub fn covers(&self, other: &Caps) -> bool {
        self.ptcl_fixed == other.ptcl_fixed
            && self.binning >= other.binning
            && self.ptcl >= other.ptcl
            && self.tile >= other.tile
            && self.seg_counts >= other.seg_counts
            && self.segments >= other.segments
            && self.blend >= other.blend
            && self.lines >= other.lines
    }

    /// Whether a frame's counts went past these. Vello flags most overflows in `failed`, but it
    /// never bounds-checks `segments`, and a failed stage skips the ones after it, so a count past
    /// its capacity is a failure too.
    pub fn exceeded_by(&self, seen: &Needs) -> bool {
        seen.binning > self.binning
            || seen.ptcl > self.ptcl_dynamic()
            || seen.tile > self.tile
            || seen.seg_counts > self.seg_counts
            || seen.segments > self.segments
            || seen.blend > self.blend
            || seen.lines > self.lines
    }
}

/// Capacities for a canvas of `tiles` (16x16 tiles, width by height) from the scene, the
/// binding limit and what earlier frames needed (`floor`). Refuses with `ErrorCode::Limit` when a
/// buffer cannot fit the binding limit.
pub fn caps(scene: &SceneShape, tiles: (u32, u32), max_bind: u64, floor: &Needs) -> Result<Caps> {
    caps_from(scene, tiles, max_bind, floor, false)
}

/// Like `caps`, but with minimal starting capacities (only the per-tile region and `floor`), so
/// the first draws of any page overflow and the grow-and-redraw path runs. For the diagnostics'
/// capacity matrix.
pub fn tight_caps(scene: &SceneShape, tiles: (u32, u32), max_bind: u64, floor: &Needs) -> Result<Caps> {
    caps_from(scene, tiles, max_bind, floor, true)
}

fn caps_from(
    scene: &SceneShape,
    (tiles_w, tiles_h): (u32, u32),
    max_bind: u64,
    floor: &Needs,
    tight: bool,
) -> Result<Caps> {
    if tight {
        return tight_from(scene, (tiles_w, tiles_h), max_bind, floor);
    }
    let tiles = tiles_w.saturating_mul(tiles_h);
    let ptcl_fixed = tiles.saturating_mul(PTCL_INITIAL_ALLOC);
    let max_words = (max_bind / 4).min(u64::from(u32::MAX)) as u32;
    if max_words <= ptcl_fixed || max_words <= scene.bin_data_start {
        return Err(EngineError::limit(
            "compute's per-tile commands exceed the GPU's storage binding limit",
        ));
    }
    let max_of = |bytes: u64| (max_bind / bytes).min(u64::from(u32::MAX)) as u32;
    let fit = |want: u32, max: u32, what: &str| {
        if want > max {
            Err(EngineError::limit(format!(
                "compute's {what} buffer would exceed the GPU's storage binding limit"
            )))
        } else {
            Ok(want)
        }
    };
    let per_tile = |n: u32| tiles.saturating_mul(n);
    let seg_counts = fit(
        scene
            .path_segments
            .saturating_mul(3)
            .min(2_500_000)
            .max(per_tile(4))
            .max(1 << 16)
            .max(floor.seg_counts),
        max_of(SEG_COUNT_BYTES),
        "segment count",
    )?;
    Ok(Caps {
        ptcl_fixed,
        binning: fit(
            scene
                .n_draw_objects
                .saturating_mul(32)
                .min(2 << 20)
                .max(tiles)
                .max(1 << 15)
                .max(floor.binning),
            max_words - scene.bin_data_start,
            "binning",
        )?,
        ptcl: ptcl_fixed
            + fit(
                scene
                    .n_paths
                    .saturating_mul(256)
                    .min(6 << 20)
                    .max(per_tile(8))
                    .max(1 << 18)
                    .max(floor.ptcl),
                max_words - ptcl_fixed,
                "tile command",
            )?,
        tile: fit(
            scene
                .n_paths
                .saturating_mul(128)
                .min(3 << 20)
                .max(per_tile(4))
                .max(1 << 16)
                .max(floor.tile),
            max_of(TILE_BYTES),
            "tile",
        )?,
        lines: fit(
            scene
                .path_segments
                .saturating_mul(4)
                .min(3 << 20)
                .max(per_tile(4))
                .max(1 << 16)
                .max(floor.lines),
            max_of(LINE_BYTES),
            "line",
        )?,
        seg_counts,
        // Upstream relies on segments never exceeding seg_counts (it never checks segments).
        segments: fit(seg_counts.max(floor.segments), max_of(SEGMENT_BYTES), "segment")?,
        blend: fit(
            scene
                .n_clips
                .saturating_mul(1024)
                .min(2 << 20)
                .max(per_tile(4))
                .max(1 << 16)
                .max(floor.blend),
            max_words,
            "blend",
        )?,
    })
}

fn tight_from(scene: &SceneShape, (tiles_w, tiles_h): (u32, u32), max_bind: u64, floor: &Needs) -> Result<Caps> {
    const MIN: u32 = 1 << 10;
    let ptcl_fixed = tiles_w.saturating_mul(tiles_h).saturating_mul(PTCL_INITIAL_ALLOC);
    let max_words = (max_bind / 4).min(u64::from(u32::MAX)) as u32;
    let caps = Caps {
        ptcl_fixed,
        binning: MIN.max(floor.binning),
        ptcl: ptcl_fixed.saturating_add(MIN.max(floor.ptcl)),
        tile: MIN.max(floor.tile),
        seg_counts: MIN.max(floor.seg_counts),
        segments: MIN.max(floor.seg_counts).max(floor.segments),
        blend: MIN.max(floor.blend),
        lines: MIN.max(floor.lines),
    };
    let max_of = |bytes: u64| (max_bind / bytes).min(u64::from(u32::MAX)) as u32;
    if caps.ptcl > max_words
        || caps.binning > max_words.saturating_sub(scene.bin_data_start)
        || caps.blend > max_words
        || caps.tile > max_of(TILE_BYTES)
        || caps.lines > max_of(LINE_BYTES)
        || caps.seg_counts > max_of(SEG_COUNT_BYTES)
        || caps.segments > max_of(SEGMENT_BYTES)
    {
        return Err(EngineError::limit(
            "compute's buffers would exceed the GPU's storage binding limit",
        ));
    }
    Ok(caps)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorCode;

    const RETINA: (u32, u32) = (2880 / 16, 1800_u32.div_ceil(16));
    const BIND_128_MIB: u64 = 128 << 20;

    fn page(n_paths: u32) -> SceneShape {
        SceneShape {
            n_paths,
            n_draw_objects: n_paths,
            n_clips: n_paths / 25,
            bin_data_start: n_paths * 4,
            path_segments: n_paths * 6,
        }
    }

    #[test]
    fn small_page_at_retina_reserves_every_tiles_commands() {
        // The review's T4 repro: 857 paths at 2880x1800 drew nothing below row 352, because ptcl
        // (262,144 words) was smaller than the 64 words x 20,340 tiles coarse reserves first.
        let caps = caps(&page(857), RETINA, BIND_128_MIB, &Needs::default()).unwrap();
        assert_eq!(caps.ptcl_fixed, 180 * 113 * 64);
        assert!(caps.ptcl >= caps.ptcl_fixed + (1 << 18));
        assert!(caps.ptcl_dynamic() >= 180 * 113 * 8);
        assert!(caps.tile >= 180 * 113 * 4, "a few canvas-sized paths fit");
    }

    #[test]
    fn segments_never_smaller_than_seg_counts() {
        for n in [1, 857, 10_748, 39_808, 200_000] {
            for tiles in [(1, 1), (90, 57), RETINA, (256, 256)] {
                let c = caps(&page(n), tiles, 2 << 30, &Needs::default()).unwrap();
                assert!(c.segments >= c.seg_counts, "{n} paths, {tiles:?}");
            }
        }
    }

    #[test]
    fn floor_grows_what_overflowed() {
        let scene = page(39_808);
        let first = caps(&scene, RETINA, 2 << 30, &Needs::default()).unwrap();
        // The review's 40k fit-all: flatten needed 5.36 M lines against 3.15 M.
        let seen = Needs {
            lines: 5_360_000,
            ..Needs::default()
        };
        assert!(first.exceeded_by(&seen));
        let floor = Needs::default().grow(seen);
        let second = caps(&scene, RETINA, 2 << 30, &floor).unwrap();
        assert!(!second.exceeded_by(&seen));
        assert!(second.lines >= 8_040_000);
        assert!(second.covers(&first));
        assert!(!first.covers(&second));
    }

    #[test]
    fn refuses_past_the_binding_limit_instead_of_clamping() {
        let seen = Needs {
            lines: 10_000_000,
            ..Needs::default()
        };
        let err = caps(&page(39_808), RETINA, BIND_128_MIB, &Needs::default().grow(seen)).unwrap_err();
        assert_eq!(err.code, ErrorCode::Limit);
        // A binding too small for the per-tile region itself.
        let err = caps(&page(10), (256, 256), 4 << 20, &Needs::default()).unwrap_err();
        assert_eq!(err.code, ErrorCode::Limit);
    }

    #[test]
    fn tight_keeps_the_per_tile_region_and_grows_from_the_floor() {
        let scene = page(10_748);
        let tight = tight_caps(&scene, RETINA, BIND_128_MIB, &Needs::default()).unwrap();
        assert_eq!(tight.ptcl_fixed, 180 * 113 * 64);
        assert_eq!(tight.ptcl_dynamic(), 1 << 10);
        assert!(tight.segments >= tight.seg_counts);
        let seen = Needs {
            lines: 70_000,
            seg_counts: 90_000,
            ..Needs::default()
        };
        let grown = tight_caps(&scene, RETINA, BIND_128_MIB, &Needs::default().grow(seen)).unwrap();
        assert!(!grown.exceeded_by(&seen));
        assert!(grown.segments >= grown.seg_counts);
    }

    #[test]
    fn counts_past_capacity_fail_even_without_a_flag() {
        let c = caps(&page(857), RETINA, BIND_128_MIB, &Needs::default()).unwrap();
        let fits = Needs {
            ptcl: c.ptcl_dynamic(),
            segments: c.segments,
            ..Needs::default()
        };
        assert!(!c.exceeded_by(&fits));
        assert!(c.exceeded_by(&Needs {
            segments: c.segments + 1,
            ..Needs::default()
        }));
        assert!(c.exceeded_by(&Needs {
            ptcl: c.ptcl_dynamic() + 1,
            ..Needs::default()
        }));
    }
}
