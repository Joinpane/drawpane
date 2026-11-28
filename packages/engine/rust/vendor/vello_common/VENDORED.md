# vello_common 0.4.0, vendored

Decision 0040 pins Vello and lets the engine carry patches to it. This is `vello_common` 0.4.0
from crates.io, unchanged except:

- `src/flatten.rs`: the fill flattening tolerance is 1/16 device pixel (`SQRT_TOL` 0.25) instead
  of a quarter pixel (`SQRT_TOL` 0.5). Every flattened chord lies on the concave side of its
  curve, so the error is a bias, not noise: at a quarter pixel a cubic whose control points sit
  within a third of a pixel of its chord is drawn as that chord, and small circles, rounded
  corners and glyph bowls came out polygonal and inside the true edge. The iOS kit's 8 x 8 page
  dot (16 px at 2x) lost about a sixth of its edge coverage and scored 5.40 against Figma where
  the canvas renderer scored 3.23; at 1/16 px it scores 2.23 (exact coverage would score 1.93).
  The CPU (`vello_cpu`), WebGPU and WebGL2 (`vello_gpu`) backends all flatten here, so they stay
  identical. The compute experiment's WGSL port (`vendor/vello_shaders/shader/flatten.wgsl`) and
  its native mirror test (`src/ordinary.rs`) carry the same constants. Glyph masks and glyph runs
  filled as outlines flatten at it too (`tests/glyph_flatten.rs`): a coarser tolerance for glyphs
  alone made no measurable difference to a text-heavy page's opening.
- `src/flatten.rs`: flattened points snap to a 1/1024 px grid in `f64` before they become `f32`
  (`snap`). Points are rounded to `f32` at their absolute position, where `f32`'s step doubles
  from one power of two to the next, so the same curve moved by whole pixels (a page drawn
  against a shifted tile grid) could round a vertex differently and change an edge pixel by a
  level; at 1/16 px there are enough vertices for that to show (the e2e "blended glyph runs keep
  zero tile-edge seam" check). On the grid, whole-pixel moves are exact up to 8,192 px, and a
  vertex moves at most 1/2048 px. The compute WGSL port doesn't snap: it stays within that of the
  CPU's lines.
- `assets/` (the `probe` feature's reference images) and `Cargo.toml.orig` are left out: the
  engine never enables `probe`.

Patches are marked `Drawpane:` in the code. Upgrading Vello means taking the new release and
carrying the patches again.
