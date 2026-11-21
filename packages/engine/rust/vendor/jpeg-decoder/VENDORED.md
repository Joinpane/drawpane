# jpeg-decoder 0.3.2

The decoder uses the 0.3.2 source from crates.io, under its original MIT or
Apache-2.0 license. The path dependency in `decoder/Cargo.toml` builds with the
optional Rayon backend disabled. Each modified file carries a short Drawpane
modification notice per Apache-2.0 section 4(b).

## Formatting

Every `.rs` file in this vendored copy was reformatted to match the workspace's
`packages/engine/rust/rustfmt.toml` (`max_width = 120`) using the Rust toolchain
pinned in `packages/engine/mise.toml`. Before diffing or rebasing onto a newer
upstream release, format the upstream source with the same command from
`packages/engine/rust`:

```sh
mise exec -- cargo fmt --manifest-path vendor/jpeg-decoder/Cargo.toml
```

Or on an unpacked upstream tree directly:

```sh
mise exec -- rustfmt --edition 2021 --config-path packages/engine/rust/rustfmt.toml <upstream>/src/**/*.rs
```

## Drawpane changes

- `src/progressive.rs` (added): compact `Plane` and `Block` storage that retains
  only the coefficients read by the selected scaled IDCT, plus a per-block `u64`
  significance mask for omitted coefficients so successive approximation
  refinement bits are consumed identically to upstream.
- `src/decoder.rs`: use `Plane` and `Block` during progressive scan decoding,
  expand retained coefficients one MCU row at a time for the IDCT worker, and
  expose `Decoder::progressive_coefficient_bytes()` so callers can bound memory
  after selecting a scale.
- `src/lib.rs`: register `mod progressive;`.
- `src/worker/mod.rs`: drop the obsolete `asmjs` cfg and gate
  `mod multithreaded` behind `not(target_arch = "wasm32")` (behavior-neutral on
  wasm32, which uses the immediate worker either way).

The upstream `tests/`, `benches/`, `examples/`, `CHANGELOG.md`, `appveyor.yml`,
`rust-toolchain`, and `Cargo.lock` files were omitted. The `decoder` crate's
differential tests compare reduced outputs against the unmodified crates.io
0.3.2 release across textured 4:2:0, 4:2:2, 4:4:4, grayscale, CMYK, and
restart-interval fixtures.
