# vello_shaders 0.12.0, vendored

Decision 0040 pins Vello and lets the engine carry patches to it. This is `vello_shaders` 0.12.0
from crates.io (`wgsl` feature only). Its source is Vello's research pipeline under
`research/vello_shaders` at upstream commit `b7e8f523b45c07a5edb806bb7241ef5afe34a882`.
The upstream crate archive SHA-256 is
`8af58dc04b4e7b87a9688fa12443a49d5916814fe78fa64d93f5b2d3f3e5bcac`.

Changes:

- The unused CPU implementation and feature are omitted.
- `shader/flatten.wgsl`: replaced Vello 0.12's Euler-spiral flattener and GPU stroke expander with
  a direct WGSL port of `vello_common 0.4`'s `flatten_simd` (Wang/parabola-integral flattener at
  the vendored vello_common's 1/16 px tolerance, plus conservative-bbox viewport culling), so GPU
  compute emits the same flattened line segments as `vello_cpu` and `vello_gpu` 0.4, to within
  the 1/2048 px vello_common's grid snap moves them. All strokes arrive pre-expanded as cached
  filled outlines (`src/stroke.rs`).
- `shader/draw_leaf.wgsl`: computes linear gradient ramp coordinates via the full inverse affine
  transform (`transform_inverse`) instead of transforming endpoints forward under a similarity
  assumption, matching `vello_cpu`, `vello_gpu`, and Figma on skewed / non-uniformly scaled
  linear gradients.
- `shader/fine.wgsl`: samples linear, radial, and sweep gradients at pixel centers
  (`(x + 0.5, y + 0.5)`, matching `vello_common 0.4`'s `PIXEL_CENTER_OFFSET = 0.5`) and writes
  premultiplied RGBA8 directly to `output` instead of unpremultiplying, matching `vello_cpu`,
  `vello_gpu`, and `gpu.rs`'s `BLIT` + `read_back_straight` pipeline.
- `shader/shared/blend.wgsl`: `clip_color` and `set_sat_inner` guard near-zero denominators with a
  `1e-6` epsilon, and `clip_color` and `unpremultiply` clamp channels to `[0, 1]`, matching
  `vello_common`'s `blend.rs`. Inert for now: non-normal blends never route to compute, and no
  test covers these lines yet.
- `shader/permutations`: keeps only `pathtag_scan_large`, `pathtag_scan_small`, and `fine_area`,
  dropping the unused `fine_msaa8` and `fine_msaa16` variants to save ~32 KB of WASM gzipped size.
- `build.rs`: panics on shader parse/validation failure instead of emitting a warning and leaving
  `OUT_DIR/shaders.rs` unwritten.
- `src/compile/mod.rs`: `ShaderInfo::new` strips comments, blank lines and indentation from each
  preprocessed shader (`strip`) before naga parses and validates it, so the embedded WGSL is the
  code alone: about 16 KB less gzipped in the compute module.

Patches are marked `Drawpane:` in the code.
