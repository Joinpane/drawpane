#!/usr/bin/env bash
# Builds the spike's two WebAssembly modules into dist/ (not committed):
#   dist/cpu/  vello_cpu and the CPU kernels: what the Worker bundles
#   dist/gpu/  vello_gpu on WebGPU, the WGSL kernels, and the CPU path: what the page loads
#   dist/gl/   the same on wgpu's WebGL2 backend; dist/gpu-gl/ with both backends
# The toolchain is this folder's mise.toml (Rust with the wasm32 target, wasm-bindgen).
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
cd "$here/engine"
export RUSTFLAGS="-C target-feature=+simd128"
build() {
  local name="$1"; shift
  mise exec -- cargo build --release --target wasm32-unknown-unknown --target-dir "$here/target/$name" "$@"
  mise exec -- wasm-bindgen --target web --remove-name-section --remove-producers-section --out-dir "$here/dist/$name" --out-name engine \
    "$here/target/$name/wasm32-unknown-unknown/release/drawpane_engine_spike.wasm"
}
build cpu
if [ "${SPIKE_SKIP_GPU:-}" != "1" ]; then
  build gpu --features webgpu            # WebGPU only: what the page loads by default
  build gl --features webgl              # WebGL2 only (wgpu's GL backend, kernels via naga)
  build gpu-gl --features webgpu,webgl   # both in one module, to price carrying the fallback
fi
ls -l "$here"/dist/*/engine_bg.wasm
