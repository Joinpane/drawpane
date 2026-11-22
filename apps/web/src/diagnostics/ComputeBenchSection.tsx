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

/** p50 / p95 / max: short enough to paste, with the tail still in it. */
const q = (x: { p50: number; p95: number; max: number } | null) =>
  x ? `${x.p50} / ${x.p95} / ${x.max}` : "n/a";

const ms = (x: number | null) => (x === null ? "n/a" : `${x}`);

const split = (s: CpuSplit) =>
  `stage ${s.stage} · finish ${s.finish} · vello ${s.fallback} · encode ${s.encode} · render ${s.render} · submit ${s.submit}`;

/** How to read the times, once, above the tables. */
export const READING =
  "All times are ms, p50 / p95 / max, from the frame's request. Check: its read-back landed (compute). Fence: the GPU finished everything submitted. GPU: the sum of the frame's compute passes; span: first pass start to last pass end. So span - GPU is gaps between passes, fence - span is submitting, scheduling and the completion callback, check - fence (gated) is the read-back hop, and shown - fence is waiting for the display. Every sweep is fenced the same way.";

function baselineLines(report: BenchReport): string[] {
  const b = report.baseline;
  return [
    `- Display: an animation frame every ${q(b.rafMs)} ms (about ${b.refreshHz} Hz)`,
    `- Trivial WebGPU fence (16 one-workgroup passes and a 288-byte read-back, on its own device): ${
      b.trivialFence
        ? `${q(b.trivialFence.paced)} ms paced by animation frames, ${q(b.trivialFence.backToBack)} ms back to back`
        : "n/a (no WebGPU adapter)"
    }`,
  ];
}

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
    `| ${s.label} | ${s.frames.length} | ${q(s.cpuMs)} | ${q(s.checkMs)} | ${q(s.fenceMs)} | ${q(s.gpuMs)} | ${q(s.gpuSpanMs)} | ${q(s.shownMs)} |`;
  const editRow = (e: EditReport) =>
    `| ${e.label} | ${e.samples.length} | ${q(e.cpuMs)} | ${q(e.waitMs)} | ${q(e.shownMs)} | ${q(e.applyMs)} |`;
  const slow = report.sweeps.flatMap((s) =>
    s.slowest
      .slice(0, 3)
      .map(
        (f) =>
          `| ${s.label} | ${f.i} | ${f.zoom} | ${f.cpuMs} | ${ms(f.checkMs)} | ${ms(f.fenceMs)} | ${ms(f.gpuMs)} | ${ms(f.gpuSpanMs)} | ${f.shownMs} |`,
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
    ...baselineLines(report),
    "",
    READING,
    "",
    "| Sweep | Frames | CPU | Check | Fence | GPU | Span | Shown |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...report.sweeps.map(sweepRow),
    "",
    "Slowest frames, three per sweep (the slowest to show, then the latest to finish; a late fence with ordinary GPU time is a scheduling delay):",
    "",
    "| Sweep | Frame | Zoom | CPU | Check | Fence | GPU | Span | Shown |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...slow,
    "",
    "| Edit of the centre card (frame after each patch) | Patches | CPU | Wait | Shown | Apply |",
    "| --- | --- | --- | --- | --- | --- |",
    ...report.edits.map(editRow),
    "",
    "CPU split, p50 ms:",
    "",
    ...report.sweeps.map((s) => `- ${s.label}: ${split(s.splitP50)}`),
    "",
    "Mean GPU ms per pass:",
    "",
    ...(passes.length ? passes : ["- n/a (no timestamps)"]),
  ].join("\n");
}

/** The report's JSON without its per-frame samples, so the copied report stays pasteable. */
export function benchSummaryJson(report: BenchReport): string {
  return JSON.stringify({
    ...report,
    sweeps: report.sweeps.map(({ frames: _frames, ...rest }) => rest),
    edits: report.edits.map(({ samples: _samples, ...rest }) => rest),
  });
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
        onReport(`${benchMarkdown(report)}\n\n\`\`\`json\n${benchSummaryJson(report)}\n\`\`\``);
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
        The 10,000-layer page at 2880 x 1800, zoomed around 100% and around fit on compute (checked,
        then through the bump gate, then the gate back to back), then on Vello GPU, then edits and
        drags of the card in the middle of the view, on this page and on a 40,000-layer one. First,
        the display's frame interval and a trivial WebGPU fence, to compare the frames against.
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
          <div className="diag__mono">
            {baselineLines(state.report).map((line) => (
              <p key={line}>{line.slice(2)}</p>
            ))}
          </div>
          <p className="diag__cell-desc">{READING}</p>
          <div className="diag__table-wrap">
            <table className="diag__table">
              <thead>
                <tr>
                  <th>Sweep</th>
                  <th>CPU</th>
                  <th>Check</th>
                  <th>Fence</th>
                  <th>GPU</th>
                  <th>Span</th>
                  <th>Shown</th>
                </tr>
              </thead>
              <tbody>
                {state.report.sweeps.map((s) => (
                  <tr key={s.label}>
                    <th>{s.label}</th>
                    <td className="diag__mono">{q(s.cpuMs)}</td>
                    <td className="diag__mono">{q(s.checkMs)}</td>
                    <td className="diag__mono">{q(s.fenceMs)}</td>
                    <td className="diag__mono">{q(s.gpuMs)}</td>
                    <td className="diag__mono">{q(s.gpuSpanMs)}</td>
                    <td className="diag__mono">{q(s.shownMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="diag__table-wrap">
            <table className="diag__table">
              <thead>
                <tr>
                  <th>Slowest frames</th>
                  <th>Frame</th>
                  <th>CPU</th>
                  <th>Check</th>
                  <th>Fence</th>
                  <th>GPU</th>
                  <th>Span</th>
                  <th>Shown</th>
                </tr>
              </thead>
              <tbody>
                {state.report.sweeps.flatMap((s) =>
                  s.slowest.slice(0, 3).map((f) => (
                    <tr key={`${s.label}-${f.i}`}>
                      <th>{s.label}</th>
                      <td className="diag__mono">{f.i}</td>
                      <td className="diag__mono">{f.cpuMs}</td>
                      <td className="diag__mono">{ms(f.checkMs)}</td>
                      <td className="diag__mono">{ms(f.fenceMs)}</td>
                      <td className="diag__mono">{ms(f.gpuMs)}</td>
                      <td className="diag__mono">{ms(f.gpuSpanMs)}</td>
                      <td className="diag__mono">{f.shownMs}</td>
                    </tr>
                  )),
                )}
              </tbody>
            </table>
          </div>
          <div className="diag__table-wrap">
            <table className="diag__table">
              <thead>
                <tr>
                  <th>Edit of the centre card</th>
                  <th>CPU</th>
                  <th>Wait</th>
                  <th>Shown</th>
                </tr>
              </thead>
              <tbody>
                {state.report.edits.map((e) => (
                  <tr key={e.label}>
                    <th>{e.label}</th>
                    <td className="diag__mono">{q(e.cpuMs)}</td>
                    <td className="diag__mono">{q(e.waitMs)}</td>
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
