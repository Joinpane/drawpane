#!/usr/bin/env bash
# P0 macOS Apple GPU verification script (Chrome + Safari checklist).
#
# Target (decision 0040 P0 kill gate):
#   - 10k-layer ordinary page at 100% zoom, Retina 2x (2880 x 1800)
#   - Hardware GPU timestamp p95 <= 8.0 ms over 240 presented rAF frames
#   - Zero bump allocator failures (0 / 240 frames failed)
#   - Optional real-file interactive verification via bench/file.spec.ts
#
# Usage:
#   ./tools/gpu-bench/laptop-p0-check.sh
#   BENCH_FILE=/path/to/converted-kit ./tools/gpu-bench/laptop-p0-check.sh
#   BENCH_PORT=9243 ./tools/gpu-bench/laptop-p0-check.sh

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

PORT="${BENCH_PORT:-9243}"
OUT_DIR="${BENCH_OUT_DIR:-$ROOT_DIR/tools/gpu-bench/runs/laptop-p0-$(date +%Y%m%d-%H%M%S)}"
mkdir -p "$OUT_DIR"

echo "==> 1. Building @drawpane/engine and @drawpane/web"
pnpm --filter @drawpane/engine build
pnpm --filter @drawpane/web build

echo "==> 2. Running 10k-layer Retina 2x compute P0 bench in real Chrome (Apple GPU)"
BENCH_PORT="$PORT" \
BENCH_BROWSER_CHANNEL="${BENCH_BROWSER_CHANNEL:-chrome}" \
BENCH_SCALE="${BENCH_SCALE:-12000}" \
BENCH_ZOOM_FRAMES="${BENCH_ZOOM_FRAMES:-240}" \
BENCH_REQUIRE_PRESENT="${BENCH_REQUIRE_PRESENT:-1}" \
BENCH_LAPTOP_GATE="${BENCH_LAPTOP_GATE:-1}" \
BENCH_OUT="$OUT_DIR/compute-p0-chrome.json" \
pnpm --filter @drawpane/web bench -- bench/compute-p0.spec.ts

if [[ -n "${BENCH_FILE:-}" ]]; then
  echo "==> 3. Running real-file bench with compute P0 enabled in real Chrome"
  BENCH_PORT="$((PORT + 2))" \
  BENCH_BROWSER_CHANNEL="${BENCH_BROWSER_CHANNEL:-chrome}" \
  BENCH_FILE="$BENCH_FILE" \
  BENCH_RENDERER="engine" \
  BENCH_COMPUTE="1" \
  BENCH_OUT="$OUT_DIR/file-compute-p0-chrome.json" \
  pnpm --filter @drawpane/web bench -- bench/file.spec.ts
fi

cat <<EOF

==> Done with automated Chrome run.
    JSON output saved to: $OUT_DIR

==> Safari (macOS 26+ Apple GPU) manual checklist:
  1. Start the built app locally on a free port:
       E2E_PORT=$((PORT + 4)) node apps/web/e2e/server.mjs
  2. Open Safari and visit:
       http://localhost:$((PORT + 4))/diagnostics/renderer?compute=1
  3. Confirm:
       - Chosen backend is "webgpu" (hardware Apple GPU, not software).
       - Parity result is "10/10 passed" with 0 compute bump failures.
       - Ordinary-paint cells show the "compute" tag.
  4. Click "Run 10k Retina 2x (240 frames)" in the Compute P0 section and confirm:
       - Presentation mode is "presented-canvas" (240/240 presented, 240/240 compute).
       - Bump allocator check is PASS (0/240 failed).
       - GPU timestamp p95 <= 8.0 ms (if Safari exposes timestamp-query) and rAF p50 ~16.7 ms.
  5. Click "Copy report" and save/attach the Markdown + JSON report.
EOF
