# wgpu-core 30.0.2, vendored

This is `wgpu-core` 30.0.2 from crates.io under its original MIT or Apache-2.0 license.
The upstream crate archive SHA-256 is
`ad661da2ee99f208c30090b585284b2ab5b8bf2358ddf2d2215592808ec62f1a`.
Wired into `packages/engine/rust/Cargo.toml` via `[patch.crates-io]`.

Drawpane modifications (marked `Drawpane:` in the code, per Apache-2.0 section 4(b)):

- `src/track/metadata.rs`:
  - Maintain a sparse `dirty: Vec<usize>` list and `dirty_exact: bool` flag on `ResourceMetadata`
    so `clear_sparse_with`, `is_empty`, and `owned_indices` run in O(touched resources) instead
    of O(max live resource index) while keeping `BitVec` fallback whenever `remove` is used.
  - Debug assertions verify that `clear_sparse_with` leaves zero owned bits and zero retained
    resources and that the sparse list matches the `BitVec`.
  - Unit tests verify sparse clearing, re-insertion deduplication, sparse removal fallback, and
    recovery on clear.
- `src/track/texture.rs` and `src/track/buffer.rs`:
  - Use `ResourceMetadata::clear_sparse_with` in `TextureUsageScope::clear` and
    `BufferUsageScope::clear` to reset only touched slots while preserving backing `Vec` lengths,
    and make `set_size` grow-only on both scopes so pooled `UsageScope`s avoid O(live textures +
    buffers) zeroing on every render pass.
- `src/command/render.rs` and `src/command/query.rs`:
  - Add `QueryResetMap::is_empty`.
  - Update the encoder tracker and drain transitions before opening `"(wgpu internal) Pre Pass"`,
    skipping `open_pass` + `close_and_swap` when there are no discard fixups, no query resets,
    no indirect validation, and no backend-active barriers (on GL/WebGL2, only storage-write
    transitions emit `glMemoryBarrier`).

The upstream `.cargo-ok`, `Cargo.lock`, and `Cargo.toml.orig` files were omitted.
