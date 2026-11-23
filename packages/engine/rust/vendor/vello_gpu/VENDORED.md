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

The patch is marked `Drawpane:` in the code. Upgrading Vello means taking the new release and
carrying the patch again (or dropping it if upstream uploads through the queue on the web).
