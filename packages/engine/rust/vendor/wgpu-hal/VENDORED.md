# wgpu-hal 30.0.2, vendored

This is `wgpu-hal` 30.0.2 from crates.io under its original MIT or Apache-2.0 license.
The upstream crate archive SHA-256 is
`a57452fe453658e141aafdb09de1028afa498805fab518238ddf372a518813ff`.
Wired into `packages/engine/rust/Cargo.toml` via `[patch.crates-io]`.

Drawpane modifications (marked `Drawpane:` in the code, per Apache-2.0 section 4(b)):

- `src/gles/queue.rs`:
  - Skip empty `CommandBuffer`s in `Queue::submit` instead of calling `reset_state(gl)` and
    binding the default framebuffer before empty Pre-Pass buffers.
  - Run `reset_state(gl)` once per `Queue::submit` (before the first non-empty command buffer),
    preserving safety against external GL use, `Surface::present`, `Device` resource creation,
    and context restore between submits, while avoiding redundant resets between command buffers
    inside the same submit.
  - Between consecutive command buffers in a submit (`reset_cmd_buf_state`), restore only the
    encoder-diffed default-off flags (`POLYGON_OFFSET_FILL`, `SAMPLE_ALPHA_TO_COVERAGE`, and
    `CLIP_DISTANCE0..N`) when dirtied.
  - Coalesce `ResetFramebuffer` + `BindAttachment` commands through a 64-entry LRU complete-FBO
    cache (`FboCache`) with per-FBO cached `glDrawBuffers` state and minimal dirty-slot diffing
    (`diff_fbo_slots`) on LRU reuse, eliminating per-pass 9-slot `framebufferTexture2D(..., None)`
    detach loops and redundant `drawBuffers` calls.
  - Shadow per-submit GL state (`SubmitState`: program, draw/read FBO, depth/stencil/scissor
    enable bits, scissor/viewport/depth-range, primitive state, color mask, uniform blend target,
    index buffer, `copy_fbo` read attachment, active texture unit), unbind `ELEMENT_ARRAY_BUFFER`
    before buffer copies/clears to uphold WebGL2 buffer-target rules, and restore clean
    `SCISSOR_TEST` / `color_mask` / `copy_fbo` state at the end of `submit` for `Surface::present`.
  - Cross-check all shadowed GL state against live GL queries in `#[cfg(debug_assertions)]`
    (`debug_verify_gl_state`) before draws and clears, plus unit tests for slot diffing and
    reset invariants.
- `src/gles/mod.rs` and `src/gles/adapter.rs`:
  - Store `fbo_cache: Mutex<queue::FboCache>` on `AdapterShared` and release all cached FBOs in
    `Queue::drop`.
  - Track `state_dirty: bool` on `CommandEncoder`.
- `src/gles/device.rs`, `src/gles/web.rs`, `src/gles/egl.rs`, `src/gles/wgl.rs`:
  - Evict and delete cached FBOs referencing a texture or renderbuffer before deleting it
    (`invalidate_texture` / `invalidate_renderbuffer`) to prevent WebGL2 VRAM retention and
    native handle reuse collisions.
- `src/gles/command.rs`:
  - Skip re-zeroing the ~2 KB encoder `State` in `CommandEncoder::begin_encoding` when the
    previous command buffer never mutated pass state.

The upstream `examples/`, `.cargo-ok`, `Cargo.lock`, and `Cargo.toml.orig` files (and the
`[[example]]` targets in `Cargo.toml`) were omitted.
