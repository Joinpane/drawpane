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
  const copy = page.getByTestId("compute-copy");
  // The bench runs after the matrix, and the report can't be copied until both have ended (a
  // copy taken when the matrix ended used to leave the bench out).
  await expect(
    page.getByTestId("compute-matrix").or(page.getByTestId("compute-matrix-error")),
  ).toBeAttached({ timeout: 15 * 60_000 });
  if (!(await done.or(failed).count())) await expect(copy).toBeDisabled();
  await expect(done.or(failed)).toBeAttached({ timeout: 24 * 60_000 });
  if (await failed.count()) throw new Error(`bench failed: ${await failed.textContent()}`);
  await expect(copy).toBeEnabled();
  const report = JSON.parse((await done.textContent()) ?? "{}");
  test.info().annotations.push({ type: "bench", description: JSON.stringify(report) });
  type Q = { n: number; p50: number; p95: number; max: number } | null;
  const sweeps = report.sweeps as ReadonlyArray<{
    label: string;
    frames: readonly unknown[];
    cpuMs: Q;
    checkMs: Q;
    fenceMs: Q;
    gpuMs: Q;
    gpuSpanMs: Q;
    shownMs: NonNullable<Q>;
    slowest: ReadonlyArray<{ shownMs: number }>;
  }>;
  const edits = report.edits as ReadonlyArray<{ label: string; cpuMs: unknown }>;
  const f = (x: Q) => (x ? `${x.p50}/${x.p95}/${x.max}` : "n/a");
  console.log(
    [
      `GPU ${report.adapter}; encodes ${JSON.stringify(report.encodes)}`,
      `baseline ${JSON.stringify(report.baseline)}`,
      ...sweeps.map(
        (s) =>
          `${s.label}: cpu ${f(s.cpuMs)} check ${f(s.checkMs)} fence ${f(s.fenceMs)} gpu ${f(s.gpuMs)} span ${f(s.gpuSpanMs)} shown ${f(s.shownMs)}`,
      ),
      ...edits.map((e) => `${e.label}: cpu ${JSON.stringify(e.cpuMs)}`),
    ].join("\n"),
  );
  expect(sweeps.length).toBeGreaterThan(0);
  // The Mac report's floor: the display's interval and a trivial WebGPU fence, both ways.
  expect(report.baseline.refreshHz).toBeGreaterThan(0);
  expect(report.baseline.rafMs.n).toBe(60);
  expect(report.baseline.trivialFence?.paced.n).toBe(30);
  expect(report.baseline.trivialFence?.backToBack.n).toBe(30);
  expect(
    sweeps.some(
      (s) => s.label.startsWith("compute gated · back to back") && s.frames.length === 30,
    ),
  ).toBe(true);
  for (const s of sweeps) {
    // Every frame is fenced; compute frames also say when their check landed.
    expect(s.fenceMs?.n, s.label).toBe(s.frames.length);
    if (s.label.startsWith("compute")) expect(s.checkMs?.n, s.label).toBe(s.frames.length);
    // With timestamps, every compute frame has its pass sum and span.
    if (report.timestamps && s.label.startsWith("compute")) {
      expect(s.gpuSpanMs?.n, s.label).toBe(s.frames.length);
      expect(s.gpuSpanMs?.p50 ?? 0, s.label).toBeGreaterThanOrEqual(s.gpuMs?.p50 ?? 0);
    }
    // The slowest frames start with the slowest to show, whatever its GPU time.
    expect(s.slowest[0]?.shownMs, s.label).toBe(s.shownMs.max);
  }
});
