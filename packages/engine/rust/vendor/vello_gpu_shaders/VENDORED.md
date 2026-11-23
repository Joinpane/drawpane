# vello_gpu_shaders 0.4.0, vendored

Decision 0040 pins Vello and lets the engine carry patches to it. This is vello_gpu_shaders 0.4.0
from crates.io, unchanged except:

- `shaders/helpers/drawpane_blend.wesl` (new): the engine's blend arithmetic, generated from
  `packages/engine/rust/src/blend.wgsl` (keep the two the same): modes 1..15 (W3C), 16 Figma
  linear-dodge, 17 Figma linear-burn in the byte domain, opacity scaling the source.
- `shaders/blend.wesl`: a non-normal mix over source-over composes with `dp_composite`, so a
  blend layer Vello draws in the scene matches the engine's offscreen blend kernel (and so the
  CPU backend, which always takes the kernel) within the parity tolerance. Other composes keep
  Vello's own `blend_mix_compose`.

The patch is marked `Drawpane:` in the code. The crate's own `Cargo.lock` is dropped (the engine's
workspace lock governs). Upgrading Vello means taking the new release and carrying the patch again.
