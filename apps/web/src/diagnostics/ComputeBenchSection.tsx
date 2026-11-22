/**
 * The compute path's Retina bench on `/diagnostics/renderer?compute=1` (decision 0040, P1-0):
 * runs after the capacity matrix, on the same page, so one report holds both.
 */
import { Badge } from "@drawpane/ui";
import { useEffect, useRef, useState } from "react";
import {
  type BenchReport,
  type CpuSplit,
  type EditReport,
  runComputeBench,
  type SweepReport,
} from "./compute-bench";

/** P0's laptop gate: GPU p95 at 100% on the 10k-layer page at Retina 2x. */
export const LAPTOP_GPU_P95_MS = 8;

type BenchState =
  | { readonly kind: "waiting" }
  | { readonly kind: "running"; readonly step: string }
  | { readonly kind: "done"; readonly report: BenchReport }
  | { readonly kind: "failed"; readonly message: string };

type Gate = { readonly kind: "pass" | "fail"; readonly p95: number } | { readonly kind: "unknown" };

const q = (x: { p50: number; p95: number; p99: number; max: number } | null) =>
  x ? `${x.p50} / ${x.p95} / ${x.p99} / ${x.max}` : "n/a";

const split = (s: CpuSplit) =>
  `stage ${s.stage} · finish ${s.finish} · vello ${s.fallback} · encode ${s.encode} · render ${s.render} · submit ${s.submit}`;

function gate(report: BenchReport): Gate {
  const sweep = report.sweeps.find((s) => s.label.startsWith("compute · zoom around 100%"));
  if (!sweep?.gpuMs) return { kind: "unknown" };
  return { kind: sweep.gpuMs.p95 <= LAPTOP_GPU_P95_MS ? "pass" : "fail", p95: sweep.gpuMs.p95 };
}

function gateText(g: Gate): string {
  if (g.kind === "unknown")
    return "Not measured: this browser has no GPU timestamp queries (Safari has none).";
  return `${g.kind === "pass" ? "Pass" : "Fail"}: GPU p95 ${g.p95} ms at 100% against ${LAPTOP_GPU_P95_MS} ms.`;
}

export function benchMarkdown(report: BenchReport): string {
  const sweepRow = (s: SweepReport) =>
    `| ${s.label} | ${s.frames.length} | ${s.computeFrames} | ${q(s.cpuMs)} | ${q(s.waitMs)} | ${q(s.gpuMs)} | ${q(s.shownMs)} |`;
  const editRow = (e: EditReport) =>
    `| ${e.label} | ${e.samples.length} | ${q(e.cpuMs)} | ${q(e.waitMs)} | ${q(e.shownMs)} | ${q(e.applyMs)} |`;
  const slow = report.sweeps.flatMap((s) =>
    s.slowest.map(
      (f) =>
        `| ${s.label} | ${f.i} | ${f.zoom} | ${f.backend} | ${f.draws} | ${f.cpuMs} | ${f.waitMs} | ${f.gpuMs ?? "n/a"} |`,
    ),
  );
  const passes = report.sweeps
    .filter((s) => s.passAvgMs)
    .map(
      (s) =>
        `- ${s.label}: ${Object.entries(s.passAvgMs ?? {})
          .map(([name, ms]) => `${name} ${ms}`)
          .join(" · ")}`,
    );
  return [
    "## Compute Retina bench",
    `- Browser: ${navigator.userAgent}`,
    `- GPU: ${report.adapter.trim() || "(the browser hides its name)"}${report.software ? " (software)" : ""}; timestamps ${report.timestamps ? "yes" : "no"}; both engines presented to ${report.presentation === "canvas" ? "a canvas each" : "offscreen textures"}`,
    `- Page: ${report.layers.toLocaleString("en-US")} layers at ${report.width}x${report.height}`,
    `- Laptop gate: ${gateText(gate(report))}`,
    `- Encodes: ${report.encodes ? `${report.encodes.full} whole page, ${report.encodes.patched} patched moves` : "n/a"}; overflow checks ${report.overflowChecks}${report.fallback ? `; compute fell back: ${report.fallback}` : ""}`,
    "",
    "CPU is the main-thread wall of every engine call a frame takes (routing included); wait is the check (checked compute) or the GPU fence (gated compute and vello_gpu), off the main thread; shown is from the request to the animation frame after the GPU finished showing it, the same fence for every sweep. Columns are p50 / p95 / p99 / max ms.",
    "",
    "| Sweep | Frames | Compute | CPU | Wait | GPU | Shown |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...report.sweeps.map(sweepRow),
    "",
    "CPU split, p50 ms:",
    "",
    ...report.sweeps.map((s) => `- ${s.label}: ${split(s.splitP50)}`),
    "",
    "Mean GPU ms per pass:",
    "",
    ...(passes.length ? passes : ["- n/a (no timestamps)"]),
    "",
    "| Edit of the centre card (frame after each patch) | Patches | CPU | Wait | Shown | Apply |",
    "| --- | --- | --- | --- | --- | --- |",
    ...report.edits.map(editRow),
    "",
    "Slowest frames (at or past the GPU p99, or the CPU p99 without timestamps):",
    "",
    "| Sweep | Frame | Zoom | Backend | Draws | CPU | Wait | GPU |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...slow,
  ].join("\n");
}

export function ComputeBenchSection({
  start,
  allowSoftware,
  onReport,
}: {
  readonly start: boolean;
  readonly allowSoftware: boolean;
  readonly onReport: (markdown: string) => void;
}) {
  const [state, setState] = useState<BenchState>({ kind: "waiting" });
  const computeCanvas = useRef<HTMLCanvasElement | null>(null);
  const velloCanvas = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!start) return;
    const controller = new AbortController();
    setState({ kind: "running", step: "starting" });
    runComputeBench({
      canvases: { compute: computeCanvas.current, vello: velloCanvas.current },
      allowSoftware,
      signal: controller.signal,
      onProgress: (step) => {
        if (!controller.signal.aborted) setState({ kind: "running", step });
      },
    }).then(
      (report) => {
        if (controller.signal.aborted) return;
        setState({ kind: "done", report });
        onReport(`${benchMarkdown(report)}\n\n\`\`\`json\n${JSON.stringify(report)}\n\`\`\``);
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setState({ kind: "failed", message: String(error) });
        onReport(`## Compute Retina bench\n- Failed: ${String(error)}`);
      },
    );
    return () => controller.abort();
  }, [start, allowSoftware, onReport]);

  const g = state.kind === "done" ? gate(state.report) : null;
  return (
    <section className="diag__section" aria-label="Compute Retina bench">
      <div className="diag__section-head">
        <h2 className="diag__section-title">Compute Retina bench</h2>
        {g ? (
          <Badge tone={g.kind === "pass" ? "success" : g.kind === "fail" ? "danger" : "neutral"}>
            {g.kind === "pass" ? "Pass" : g.kind === "fail" ? "Fail" : "No timestamps"}
          </Badge>
        ) : null}
      </div>
      <p className="diag__cell-desc">
        The 10,000-layer page at 2880 x 1800, zoomed around 100% and around fit on compute, then on
        Vello GPU, then edits and drags of the card in the middle of the view, on this page and on a
        40,000-layer one. CPU counts every engine call a frame takes.
      </p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 8 }}>
        <canvas
          ref={computeCanvas}
          className="diag__bench-canvas"
          style={{ width: 360, maxWidth: "100%", aspectRatio: "16 / 10", display: "block" }}
          aria-label="Compute bench frames"
        />
        <canvas
          ref={velloCanvas}
          className="diag__bench-canvas"
          style={{ width: 360, maxWidth: "100%", aspectRatio: "16 / 10", display: "block" }}
          aria-label="Vello GPU bench frames"
        />
      </div>
      <p className="diag__mono" role="status" data-testid="compute-bench-status">
        {state.kind === "waiting"
          ? "Waiting for the capacity matrix…"
          : state.kind === "running"
            ? `Running: ${state.step}`
            : state.kind === "done"
              ? gateText(gate(state.report))
              : `Failed: ${state.message}`}
      </p>
      {state.kind === "done" ? (
        <>
          <div className="diag__table-wrap">
            <table className="diag__table">
              <thead>
                <tr>
                  <th>Sweep or edit</th>
                  <th>CPU p50 / p95 / p99 / max</th>
                  <th>Wait p50 / p95 / p99 / max</th>
                  <th>GPU p50 / p95 / p99 / max</th>
                  <th>Shown p50 / p95 / p99 / max</th>
                </tr>
              </thead>
              <tbody>
                {state.report.sweeps.map((s) => (
                  <tr key={s.label}>
                    <th>{s.label}</th>
                    <td className="diag__mono">{q(s.cpuMs)}</td>
                    <td className="diag__mono">{q(s.waitMs)}</td>
                    <td className="diag__mono">{q(s.gpuMs)}</td>
                    <td className="diag__mono">{q(s.shownMs)}</td>
                  </tr>
                ))}
                {state.report.edits.map((e) => (
                  <tr key={e.label}>
                    <th>{e.label}</th>
                    <td className="diag__mono">{q(e.cpuMs)}</td>
                    <td className="diag__mono">{q(e.waitMs)}</td>
                    <td className="diag__mono">n/a</td>
                    <td className="diag__mono">{q(e.shownMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="diag__table-wrap">
            <table className="diag__table">
              <thead>
                <tr>
                  <th>Sweep</th>
                  <th>CPU split, p50 ms</th>
                  <th>Mean GPU ms per pass</th>
                </tr>
              </thead>
              <tbody>
                {state.report.sweeps.map((s) => (
                  <tr key={s.label}>
                    <th>{s.label}</th>
                    <td className="diag__mono">{split(s.splitP50)}</td>
                    <td className="diag__mono">
                      {s.passAvgMs
                        ? Object.entries(s.passAvgMs)
                            .map(([name, ms]) => `${name} ${ms}`)
                            .join(" · ")
                        : "n/a"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <pre className="diag__pre" hidden data-testid="compute-bench">
            {JSON.stringify(state.report)}
          </pre>
        </>
      ) : null}
      {state.kind === "failed" ? (
        <pre className="diag__pre" hidden data-testid="compute-bench-error">
          {state.message}
        </pre>
      ) : null}
    </section>
  );
}
