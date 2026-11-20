# vello_gpu 0.4.0, vendored

Decision 0040 pins Vello and lets the engine carry patches to it. This is vello_gpu 0.4.0 from
crates.io, unchanged except:

- `src/render/wgpu/resources.rs`: on the web, uploads (strips, the config, the alpha and paint
  textures) go through the queue (`write_buffer_with`, `write_texture`), which the browser
  stages itself. wgpu's `StagingBelt` gets its chunks back only after an asynchronous map, so
  every render in a burst of tile renders allocated new mapped buffers: about a fifth of a cold
  frame's main-thread time went to `createBuffer`.
- `src/render/wgpu/mod.rs`: the renderer hands its queue to that upload path.

The patch is marked `Drawpane:` in the code. Upgrading Vello means taking the new release and
carrying the patch again (or dropping it if upstream uploads through the queue on the web).
