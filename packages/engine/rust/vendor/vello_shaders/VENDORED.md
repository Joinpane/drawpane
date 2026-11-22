# vello_shaders 0.12.0, vendored

Decision 0040 pins Vello and lets the engine carry patches to it. This is `vello_shaders` 0.12.0
from crates.io (`wgsl` feature only; `src/cpu` omitted), unchanged except:

- `shader/flatten.wgsl`: replaced Vello 0.12's Euler-spiral flattener and GPU stroke expander with
  a direct WGSL port of `vello_common 0.4`'s `flatten_simd` (0.25 px Wang/parabola-integral
  flattener, plus conservative-bbox viewport culling), so GPU compute emits the same flattened line
  segments as `vello_cpu` and `vello_gpu` 0.4. All strokes arrive pre-expanded as cached filled
  outlines (`src/stroke.rs`).
- `shader/draw_leaf.wgsl`: computes linear gradient ramp coordinates via the full inverse affine
  transform (`transform_inverse`) instead of transforming endpoints forward under a similarity
  assumption, matching `vello_cpu`, `vello_gpu`, and Figma on skewed / non-uniformly scaled
  linear gradients.
- `shader/fine.wgsl`: samples linear, radial, and sweep gradients at pixel centers
  (`(x + 0.5, y + 0.5)`, matching `vello_common 0.4`'s `PIXEL_CENTER_OFFSET = 0.5`) and writes
  premultiplied RGBA8 directly to `output` instead of unpremultiplying, matching `vello_cpu`,
  `vello_gpu`, and `gpu.rs`'s `BLIT` + `read_back_straight` pipeline.
- `shader/shared/blend.wgsl`: adds `1e-6` denominator epsilon guards in `color_burn` / `color_dodge`
  and clamps blended RGB channels to `[0.0, 1.0]` before premultiplication.
- `shader/permutations`: keeps only `pathtag_scan_large`, `pathtag_scan_small`, and `fine_area`,
  dropping the unused `fine_msaa8` and `fine_msaa16` variants to save ~32 KB of WASM gzipped size.
- `build.rs`: panics on shader parse/validation failure instead of emitting a warning and leaving
  `OUT_DIR/shaders.rs` unwritten.

Patches are marked `Drawpane:` in the code.
