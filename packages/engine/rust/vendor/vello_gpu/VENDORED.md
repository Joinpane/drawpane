# vello_gpu 0.4.0, vendored

Decision 0040 pins Vello and lets the engine carry patches to it. This is vello_gpu 0.4.0 from
crates.io, unchanged except:

- `src/render/wgpu/` (and `src/render/common/data_texture.rs`, `src/schedule/mod.rs`):
  multi-render encoder batching via `Renderer::prepare_batch_render`,
  `Renderer::execute_batch_render`, `Renderer::flush_uploads`, and `Renderer::discard_uploads`.
  Multiple `render` calls share one `CommandEncoder` and one `queue.submit()`: alphas, encoded
  paints, strip/blend/clear/copy vertex data, and dynamic-offset view configs are staged in CPU
  memory and uploaded once right before submit via `queue.write_buffer` / `queue.write_texture`,
  and external-texture bind groups are cached across renders using versioned `TextureBindings`.
- `src/scene.rs`: `Scene::fill_path_in_slot` generates solid-paint strips in slot-local
  coordinates and shifts the emitted strips by a tile-aligned atlas origin, keeping batched
  glass mask coverage bit-identical to standalone lens-local masks.
- `src/lib.rs`, `src/scene.rs`, `src/draw.rs`, `src/schedule/round.rs`, `src/schedule/execute.rs`,
  `src/render/webgl/passes/mod.rs`, `src/render/wgpu/`: fixed-function hardware blending inside
  the root strip pass and direct dual-plane strip replay:
  - `HwBlendMode` (`Normal`, `Multiply`, `Screen`, `LinearDodge`, `LinearBurn`) and
    `Scene::set_hw_blend`, `Scene::hw_blend`, `Scene::has_hw_blend`,
    `Scene::root_is_blend_target` tag recorded draws without introducing intermediate Vello blend
    layers.
  - `Draw` records contiguous `BlendRun` ranges (`blend_runs`, empty when all strips are `Normal`),
    and `DrawBuilder` always routes non-normal HW-blended strips to `alpha_strips` (never
    `opaque_strips`) with non-opaque `depth_index` so painter's-order depth testing stays exact.
  - `StripPipelines` uses a token-aware `const fn` WGSL parser (verified at compile time against
    `vello_gpu_shaders`) to rewrite `fs_main` into a shared `drawpane_strip_color` helper and
    append `fs_main_linear_burn` (`ceil(clamp((c.a - c.rgb) * 255, 0, 255) - 0.5001) / 255` with
    `ReverseSubtract(One, One)`) and `fs_main_linear_dodge`
    (`floor(clamp(c.rgb * 255, 0, 255) + 0.5) / 255` with `Add(One, One)`), plus `Multiply`
    (`Add(Dst, OneMinusSrcAlpha)`) and `Screen` (`Add(One, OneMinusSrc)`), created lazily on first
    use or via idle `Renderer::warm_hw_blend_pipeline` / `Renderer::hw_blend_strip_shader_wgsl`
    warmup (avoiding startup shader compilation overhead and mid-frame compile stalls).
    `strip_pass_inner` merge-sweeps `blend_runs` and `external_texture_runs` in painter's order
    inside a single render pass, with safe intermediate-layer HW-blend fallback in release builds
    and an explicit error guard in the native `webgl` backend's `draw_pass`.
  - `Renderer::prepare_batch_render_dual` and `Renderer::execute_batch_render_dual` replay
    uploaded root strip passes directly onto a primary and secondary root target inside the same
    command encoder without allocating a transparent delta texture.

The patch is marked `Drawpane:` in the code. Upgrading Vello means taking the new release and
carrying the patch again (or dropping it if upstream uploads through the queue on the web).
