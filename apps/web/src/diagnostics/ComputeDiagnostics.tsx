/**
 * The opt-in compute path's checks on `/diagnostics/renderer?compute=1` (decision 0040, P1-0):
 * the capacity matrix, then the Retina bench. Loaded only with that flag, so the page's default
 * bundle carries none of it. Runs after the main diagnostics finish, so nothing shares the GPU.
 */
import { Badge, Button } from "@drawpane/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ComputeBenchSection } from "./ComputeBenchSection";
import { type MatrixCell, type MatrixReport, runComputeMatrix } from "./compute-check";

type MatrixState =
  | { readonly kind: "waiting" }
  | { readonly kind: "running"; readonly cells: readonly MatrixCell[]; readonly total: number }
  | { readonly kind: "done"; readonly report: MatrixReport }
  | { readonly kind: "failed"; readonly message: string; readonly cells: readonly MatrixCell[] };

function cellLabel(c: MatrixCell): string {
  return `${c.page} (${c.layers.toLocaleString("en-US")} layers) · ${c.dpr}x · ${c.zoom}${c.tight ? " · tight" : ""}`;
}

export function matrixMarkdown(report: MatrixReport): string {
  const passed = report.cells.filter((c) => c.ok).length;
  const compute = report.cells.filter((c) => c.backend === "compute").length;
  return [
    "## Compute capacity matrix",
    `- GPU: ${report.adapter}${report.software ? " (software)" : ""}`,
    `- Result: ${passed}/${report.cells.length} cells exact or fell back; ${compute} drawn by compute; ${report.overflowChecks} checks found an overflow and redrew (none shown); ${report.ms} ms`,
    "",
    "| Cell | Status | Backend | Draws | Mean | p99 | Worst tile | Severe | Max | Notes |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...report.cells.map(
      (c) =>
        `| ${cellLabel(c)} | ${c.ok ? "PASS" : "FAIL"} | ${c.backend} | ${c.attempts} | ${c.mean} | ${c.p99} | ${c.worstTile} | ${c.severeInTile} | ${c.max} | ${[c.fallback, ...c.violations].filter(Boolean).join("; ")} |`,
    ),
  ].join("\n");
}

export function ComputeDiagnostics({
  start,
  allowSoftware,
}: {
  readonly start: boolean;
  readonly allowSoftware: boolean;
}) {
  const [state, setState] = useState<MatrixState>({ kind: "waiting" });
  const [bench, setBench] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!start) return;
    const controller = new AbortController();
    const cells: MatrixCell[] = [];
    setState({ kind: "running", cells, total: 0 });
    runComputeMatrix({
      allowSoftware,
      signal: controller.signal,
      onCell: (cell, _done, total) => {
        cells.push(cell);
        if (!controller.signal.aborted) setState({ kind: "running", cells: [...cells], total });
      },
    }).then(
      (report) => {
        if (!controller.signal.aborted) setState({ kind: "done", report });
      },
      (error: unknown) => {
        if (!controller.signal.aborted)
          setState({ kind: "failed", message: String(error), cells: [...cells] });
      },
    );
    return () => controller.abort();
  }, [start, allowSoftware]);

  // The report is ready to copy once the matrix and the bench after it have both ended, so a
  // copy taken as soon as the button enables holds both.
  const markdown = useMemo(() => {
    const matrix =
      state.kind === "done"
        ? `${matrixMarkdown(state.report)}\n\n\`\`\`json\n${JSON.stringify(state.report)}\n\`\`\``
        : state.kind === "failed"
          ? `## Compute capacity matrix\n- Failed: ${state.message}`
          : "";
    if (!matrix || !bench) return "";
    return `${matrix}\n\n${bench}`;
  }, [state, bench]);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(markdown);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }, [markdown]);

  const cells =
    state.kind === "done" ? state.report.cells : state.kind === "waiting" ? [] : state.cells;
  const passed = cells.filter((c) => c.ok).length;
  return (
    <section className="diag__section" aria-label="Compute checks">
      <div className="diag__section-head">
        <h2 className="diag__section-title">Compute capacity matrix</h2>
        <Button
          size="sm"
          disabled={!markdown}
          onClick={() => void copy()}
          data-testid="compute-copy"
        >
          {copied
            ? "Copied"
            : !markdown && (state.kind === "done" || state.kind === "failed")
              ? "Waiting for the bench…"
              : "Copy compute report"}
        </Button>
      </div>
      <p className="diag__cell-desc">
        Generated ordinary pages drawn by the compute pipeline and by Vello GPU, compared pixel for
        pixel. Every cell must be exact or fall back to Vello GPU. Tight cells start from minimal
        buffers, so each one has to grow and redraw before it is shown.
      </p>
      <p className="diag__mono" role="status" data-testid="compute-matrix-status">
        {state.kind === "waiting"
          ? "Waiting for the main checks to finish…"
          : state.kind === "running"
            ? `Running: ${state.cells.length}${state.total ? `/${state.total}` : ""} cells`
            : state.kind === "done"
              ? `${passed}/${cells.length} cells exact or fell back`
              : `Failed: ${state.message}`}
      </p>
      {cells.length > 0 ? (
        <div className="diag__table-wrap">
          <table className="diag__table">
            <thead>
              <tr>
                <th>Cell</th>
                <th>Status</th>
                <th>Backend</th>
                <th>Draws</th>
                <th>Mean</th>
                <th>p99</th>
                <th>Worst tile</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              {cells.map((c) => (
                <tr key={cellLabel(c)}>
                  <th>{cellLabel(c)}</th>
                  <td>
                    <Badge tone={c.ok ? "success" : "danger"}>{c.ok ? "Pass" : "Fail"}</Badge>
                  </td>
                  <td className="diag__mono">{c.backend}</td>
                  <td className="diag__mono">{c.attempts}</td>
                  <td className="diag__mono">{c.mean}</td>
                  <td className="diag__mono">{c.p99}</td>
                  <td className="diag__mono">{c.worstTile}</td>
                  <td className="diag__mono">
                    {[c.fallback, ...c.violations].filter(Boolean).join("; ")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {state.kind === "done" ? (
        <pre className="diag__pre" hidden data-testid="compute-matrix">
          {JSON.stringify(state.report)}
        </pre>
      ) : null}
      {state.kind === "failed" ? (
        <pre className="diag__pre" hidden data-testid="compute-matrix-error">
          {state.message}
        </pre>
      ) : null}
      <ComputeBenchSection
        start={state.kind === "done" || state.kind === "failed"}
        allowSoftware={allowSoftware}
        onReport={setBench}
      />
    </section>
  );
}
