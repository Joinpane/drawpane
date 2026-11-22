/**
 * The compute path's capacity gate (decision 0040, P1-0): `/diagnostics/renderer?compute=1`'s
 * matrix of small, bench-sized and large ordinary pages at 1x and 2x, at 100%, 200% and fit,
 * plus tight cells that start from minimal buffers. Every cell must be exact against vello_gpu
 * or fall back to it; a wrong frame fails. Needs a real WebGPU Core device, so it runs only with
 * `BENCH_COMPUTE_MATRIX=1`, on `pnpm gpu-bench --modes webgpu` (tools/gpu-bench).
 */
import { expect, test } from "@playwright/test";

test.use({ trace: "off" });

interface Cell {
  readonly page: string;
  readonly dpr: number;
  readonly zoom: string;
  readonly tight: boolean;
  readonly backend: string;
  readonly ok: boolean;
  readonly violations: readonly string[];
}

test("compute frames are exact or fall back at every page size, scale and zoom", async ({
  page,
}) => {
  test.skip(process.env.BENCH_COMPUTE_MATRIX !== "1", "set BENCH_COMPUTE_MATRIX=1 on a real GPU");
  test.setTimeout(15 * 60_000);
  await page.goto("/diagnostics/renderer?compute=1");
  const done = page.getByTestId("compute-matrix");
  const failed = page.getByTestId("compute-matrix-error");
  await expect(done.or(failed)).toBeAttached({ timeout: 14 * 60_000 });
  if (await failed.count()) throw new Error(`matrix failed: ${await failed.textContent()}`);
  const report = JSON.parse((await done.textContent()) ?? "{}") as {
    readonly adapter: string;
    readonly cells: readonly Cell[];
    readonly overflowChecks: number;
  };
  test.info().annotations.push({ type: "bench", description: JSON.stringify(report) });
  const label = (c: Cell) => `${c.page} ${c.dpr}x ${c.zoom}${c.tight ? " tight" : ""}`;
  console.log(
    report.cells
      .map((c) => `${label(c)}: ${c.ok ? "ok" : "WRONG"} (${c.backend}) ${c.violations.join("; ")}`)
      .join("\n"),
  );
  // 30 capacity cells, then the floor check after a fresh page.
  expect(report.cells).toHaveLength(31);
  expect(
    report.cells.filter((c) => !c.ok).map((c) => `${label(c)}: ${c.violations.join("; ")}`),
  ).toEqual([]);
  // The gate is about compute: most cells must actually be drawn by it, not fall back.
  expect(report.cells.filter((c) => c.backend === "compute").length).toBeGreaterThan(20);
  // Tight cells start from minimal buffers, so they must have redrawn after growing.
  expect(report.overflowChecks).toBeGreaterThan(0);
});
