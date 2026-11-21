# jpeg-decoder 0.3.2

The decoder uses the 0.3.2 source from crates.io, under its original MIT or
Apache-2.0 license. The path dependency in `decoder/Cargo.toml` builds with
the optional Rayon backend disabled. The source follows the workspace's
Rust formatting.

Drawpane's patch is in `src/progressive.rs` and `src/decoder.rs`. Progressive
scans retain the coefficients read by the selected scaled IDCT. For each
omitted coefficient, the decoder retains whether it is nonzero so it can
consume the corresponding refinement bits. The IDCT worker receives the
retained coefficients one MCU row at a time. The caller can ask for the
coefficient storage size after selecting a scale. The decoder's differential
test compares reduced outputs against the unmodified crates.io release.
