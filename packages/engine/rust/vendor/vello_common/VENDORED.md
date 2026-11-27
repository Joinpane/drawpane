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
  its native mirror test (`src/ordinary.rs`) carry the same constants.
- `assets/` (the `probe` feature's reference images) and `Cargo.toml.orig` are left out: the
  engine never enables `probe`.

The patch is marked `Drawpane:` in the code. Upgrading Vello means taking the new release and
carrying the patch again.
