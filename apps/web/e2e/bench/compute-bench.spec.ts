/**
 * The compute path's Retina bench (decision 0040, P1-0) on a real GPU: what
 * `/diagnostics/renderer?compute=1` reports after its capacity matrix. CPU is the main-thread
 * wall of every engine call a frame takes; every frame is kept in order. Runs only with
 * `BENCH_COMPUTE_BENCH=1`, on `pnpm gpu-bench --modes webgpu` (tools/gpu-bench).
 */
import { expect, test } from "@playwright/test";

test.use({ trace: "off" });

test("compute Retina bench: zoom, edits and drags against vello_gpu", async ({ page }) => {
  test.skip(process.env.BENCH_COMPUTE_BENCH !== "1", "set BENCH_COMPUTE_BENCH=1 on a real GPU");
  test.setTimeout(25 * 60_000);
  await page.goto("/diagnostics/renderer?compute=1");
  const done = page.getByTestId("compute-bench");
  const failed = page.getByTestId("compute-bench-error");
  await expect(done.or(failed)).toBeAttached({ timeout: 24 * 60_000 });
  if (await failed.count()) throw new Error(`bench failed: ${await failed.textContent()}`);
  const report = JSON.parse((await done.textContent()) ?? "{}");
  test.info().annotations.push({ type: "bench", description: JSON.stringify(report) });
  const sweeps = report.sweeps as ReadonlyArray<{ label: string; cpuMs: unknown; gpuMs: unknown }>;
  const edits = report.edits as ReadonlyArray<{ label: string; cpuMs: unknown }>;
  console.log(
    [
      `GPU ${report.adapter}; encodes ${JSON.stringify(report.encodes)}`,
      ...sweeps.map(
        (s) => `${s.label}: cpu ${JSON.stringify(s.cpuMs)} gpu ${JSON.stringify(s.gpuMs)}`,
      ),
      ...edits.map((e) => `${e.label}: cpu ${JSON.stringify(e.cpuMs)}`),
    ].join("\n"),
  );
  expect(sweeps.length).toBeGreaterThan(0);
});
