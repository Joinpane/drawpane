/**
 * Standalone renderer diagnostics page (`/diagnostics/renderer`).
 *
 * Designed to be opened directly in real Safari, Firefox, Chrome, or Edge with no sign-in
 * and zero API calls. Reports:
 * - browser & environment details;
 * - backend selection (`webgpu` -> `webgl2` -> `cpu-worker`) and why any backend was skipped;
 * - full adapter info, features, and limits from the active GPU backend (plus browser probes);
 * - WebKit/browser canvas & WebGL2 trap probes (OffscreenCanvas WebGL2 -> 2D, RGBA16F FBO, etc.);
 * - pixel accuracy for every cell in `DIAGNOSTIC_CELLS` compared against shipped CPU-oracle PNGs
 *   using decision 0040's tolerance (`CPU_GPU_TOLERANCE`) and warm per-frame timings;
 * - one-click "Copy report" exporting structured Markdown + JSON.
 */
import { type GpuInfo, RenderEngine } from "@drawpane/engine";
import { loadBrowserEngine, loadWebglEngine } from "@drawpane/engine/browser";
import { CPU_GPU_TOLERANCE, outsideTolerance, type Score, score } from "@drawpane/engine/compare";
import { Badge, Button, Logo, SegmentedControl } from "@drawpane/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useCopy } from "../app/CopyField";
import {
  type ComputeBenchReport,
  P0_BENCH_FRAMES,
  P0_LAPTOP_GPU_P95_TARGET_MS,
  runP0RetinaBench,
} from "./compute-bench";
import { EXPECTED_PNGS } from "./expected-pixels";
import {
  CELL_CAMERA,
  CELL_HEIGHT,
  CELL_WIDTH,
  DIAGNOSTIC_CELLS,
  type DiagnosticCell,
} from "./scene";
import "./diagnostics.css";

type RequestedMode = "auto" | "webgpu" | "webgl2" | "cpu";
type ActiveBackend = "webgpu" | "webgl2" | "cpu";

const SOFTWARE_RE =
  /swiftshader|llvmpipe|lavapipe|softpipe|software|basic render|mesa offscreen|subzero/i;

interface AdapterDetailsJson {
  readonly name?: string;
  readonly vendor?: number;
  readonly device?: number;
  readonly device_type?: string;
  readonly driver?: string;
  readonly driver_info?: string;
  readonly backend?: string;
  readonly features?: string | readonly string[];
  readonly limits?: Record<string, number>;
}

interface ProbeSummary {
  readonly webgpuCore: string;
  readonly webgpuCompat: string;
  readonly webgl2: string;
  readonly webgl2ExtFloat: boolean;
  readonly webgl2ExtHalfFloat: boolean;
  readonly offscreenGlTo2d: string;
  readonly rgba16fFbo: string;
  readonly ctxFilterBlur: boolean;
}

interface CellReport {
  readonly id: string;
  readonly title: string;
  readonly category: DiagnosticCell["category"];
  readonly description: string;
  readonly ok: boolean;
  readonly error: string | null;
  readonly violations: readonly string[];
  readonly score: Omit<Score, "heat"> | null;
  readonly renderMs: { readonly p50: number; readonly p95: number } | null;
  readonly computeUsed?: boolean;
  readonly expectedPngUrl: string;
  readonly actualRgba: Uint8Array | null;
  readonly diffHeat: Uint8Array | null;
}

interface RunState {
  readonly running: boolean;
  readonly requested: RequestedMode;
  readonly compute: boolean;
  readonly backend: ActiveBackend | null;
  readonly adapter: string;
  readonly software: boolean;
  readonly fallbackNotes: readonly string[];
  readonly details: AdapterDetailsJson | null;
  readonly rawDetails: string | null;
  readonly probes: ProbeSummary | null;
  readonly cells: readonly CellReport[];
  readonly computeFailedFrames: number;
  readonly totalMs: number;
  readonly error: string | null;
}

function quant(xs: number[]): { p50: number; p95: number } {
  const s = [...xs].sort((a, b) => a - b);
  const at = (q: number) => Math.round((s[Math.floor(q * (s.length - 1))] ?? 0) * 100) / 100;
  return { p50: at(0.5), p95: at(0.95) };
}

/** Decodes a base64 PNG to straight RGBA8 pixels in the browser. */
async function decodePngDataUrl(dataUrl: string): Promise<Uint8Array> {
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  const c = document.createElement("canvas");
  c.width = img.width;
  c.height = img.height;
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("2D canvas unavailable for PNG decode");
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, img.width, img.height).data;
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

/** Browser capability + WebKit trap probes (read-only, releases temporary GL contexts). */
async function probeEnvironment(): Promise<ProbeSummary> {
  const gpu = (
    navigator as Navigator & {
      gpu?: {
        requestAdapter(o?: object): Promise<{
          isFallbackAdapter?: boolean;
          info?: {
            vendor?: string;
            architecture?: string;
            device?: string;
            description?: string;
            isFallbackAdapter?: boolean;
          };
        } | null>;
      };
    }
  ).gpu;

  const describeGpu = async (compat: boolean): Promise<string> => {
    if (!gpu) return "unavailable (navigator.gpu absent)";
    try {
      const a = await gpu.requestAdapter(
        compat
          ? { featureLevel: "compatibility", powerPreference: "high-performance" }
          : { powerPreference: "high-performance" },
      );
      if (!a) return "no adapter";
      const i = a.info ?? {};
      const label =
        [i.vendor, i.architecture, i.device, i.description].filter(Boolean).join(" / ") ||
        "WebGPU adapter";
      const fb = i.isFallbackAdapter || a.isFallbackAdapter ? " (fallback)" : "";
      return `${label}${fb}`;
    } catch (err) {
      return `error: ${String(err)}`;
    }
  };

  let webgl2 = "unavailable";
  let webgl2ExtFloat = false;
  let webgl2ExtHalfFloat = false;
  let offscreenGlTo2d = "skipped";
  let rgba16fFbo = "skipped";
  try {
    const c = document.createElement("canvas");
    c.width = 4;
    c.height = 4;
    const gl = c.getContext("webgl2", { antialias: false });
    if (gl) {
      const ext = gl.getExtension("WEBGL_debug_renderer_info");
      const vendor = String(
        (ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : null) ??
          gl.getParameter(gl.VENDOR) ??
          "",
      );
      const renderer = String(
        (ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null) ??
          gl.getParameter(gl.RENDERER) ??
          "",
      );
      webgl2 = [vendor, renderer].filter(Boolean).join(" / ") || "WebGL2";
      webgl2ExtFloat = !!gl.getExtension("EXT_color_buffer_float");
      webgl2ExtHalfFloat = !!gl.getExtension("EXT_color_buffer_half_float");

      // RGBA16F FBO completeness probe.
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, 4, 4, 0, gl.RGBA, gl.HALF_FLOAT, null);
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      const st = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      rgba16fFbo =
        st === gl.FRAMEBUFFER_COMPLETE ? "complete" : `incomplete (0x${st.toString(16)})`;
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
  } catch (err) {
    webgl2 = `error: ${String(err)}`;
  }

  // OffscreenCanvas WebGL2 -> 2D drawImage probe (WebKit trap check).
  try {
    if (typeof OffscreenCanvas === "undefined") {
      offscreenGlTo2d = "no OffscreenCanvas";
    } else {
      const oc = new OffscreenCanvas(16, 16);
      const gl = oc.getContext("webgl2", { premultipliedAlpha: true, antialias: false });
      if (!gl) {
        offscreenGlTo2d = "no OffscreenCanvas WebGL2";
      } else {
        gl.clearColor(0, 1, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        const dst = document.createElement("canvas");
        dst.width = 16;
        dst.height = 16;
        const dctx = dst.getContext("2d");
        dctx?.drawImage(oc, 0, 0);
        const px = dctx ? [...dctx.getImageData(8, 8, 1, 1).data] : [];
        const ok =
          px.length === 4 &&
          Math.abs((px[0] ?? 0) - 0) <= 2 &&
          Math.abs((px[1] ?? 0) - 255) <= 2 &&
          Math.abs((px[2] ?? 0) - 0) <= 2 &&
          Math.abs((px[3] ?? 0) - 255) <= 2;
        offscreenGlTo2d = ok ? "ok" : `mismatch [${px.join(",")}]`;
        gl.getExtension("WEBGL_lose_context")?.loseContext();
      }
    }
  } catch (err) {
    offscreenGlTo2d = `error: ${String(err)}`;
  }

  // Canvas 2D ctx.filter blur support check.
  let ctxFilterBlur = false;
  try {
    const src = document.createElement("canvas");
    src.width = 32;
    src.height = 32;
    const sctx = src.getContext("2d");
    const dst = document.createElement("canvas");
    dst.width = 32;
    dst.height = 32;
    const dctx = dst.getContext("2d");
    if (sctx && dctx) {
      sctx.fillStyle = "#000";
      sctx.fillRect(0, 0, 16, 32);
      sctx.fillStyle = "#fff";
      sctx.fillRect(16, 0, 16, 32);
      dctx.filter = "blur(4px)";
      dctx.drawImage(src, 0, 0);
      const r = dctx.getImageData(16, 16, 1, 1).data[0] ?? 0;
      ctxFilterBlur = r > 40 && r < 215;
    }
  } catch {
    ctxFilterBlur = false;
  }

  return {
    webgpuCore: await describeGpu(false),
    webgpuCompat: await describeGpu(true),
    webgl2,
    webgl2ExtFloat,
    webgl2ExtHalfFloat,
    offscreenGlTo2d,
    rgba16fFbo,
    ctxFilterBlur,
  };
}

function PixelCanvas({
  rgba,
  width,
  height,
  label,
}: {
  rgba: Uint8Array | null;
  width: number;
  height: number;
  label: string;
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !rgba) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const clamped = new Uint8ClampedArray(
      rgba.buffer as ArrayBuffer,
      rgba.byteOffset,
      rgba.byteLength,
    );
    ctx.putImageData(new ImageData(clamped, width, height), 0, 0);
  }, [rgba, width, height]);
  return (
    <div className="diag__thumb">
      <canvas ref={ref} width={width} height={height} aria-label={label} />
      <span className="diag__thumb-label">{label}</span>
    </div>
  );
}

export function RendererDiagnosticsPage() {
  const [requested, setRequested] = useState<RequestedMode>("auto");
  const [allowSoftware, setAllowSoftware] = useState<boolean>(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      return (
        params.get("software") === "1" ||
        localStorage.getItem("drawpane:engine-software") === "allow"
      );
    } catch {
      return false;
    }
  });
  const [computeOn, setComputeOn] = useState<boolean>(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      return (
        params.get("compute") === "1" || localStorage.getItem("drawpane:engine-compute") === "1"
      );
    } catch {
      return false;
    }
  });
  const [state, setState] = useState<RunState>({
    running: true,
    requested: "auto",
    compute: false,
    backend: null,
    adapter: "Probing…",
    software: false,
    fallbackNotes: [],
    details: null,
    rawDetails: null,
    probes: null,
    cells: [],
    computeFailedFrames: 0,
    totalMs: 0,
    error: null,
  });
  const [benchRunning, setBenchRunning] = useState(false);
  const [benchProgress, setBenchProgress] = useState<string | null>(null);
  const [benchError, setBenchError] = useState<string | null>(null);
  const [benchReport, setBenchReport] = useState<ComputeBenchReport | null>(null);
  const benchCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [copied, copy] = useCopy<"report">();
  const runSeq = useRef(0);

  const runDiagnostics = useCallback(
    async (mode: RequestedMode, softwareOk: boolean, useCompute: boolean) => {
      const seq = ++runSeq.current;
      const started = performance.now();
      setState((prev) => ({
        ...prev,
        running: true,
        requested: mode,
        compute: useCompute,
        error: null,
      }));

      const probes = await probeEnvironment();
      if (seq !== runSeq.current) return;

      const fallbackNotes: string[] = [];
      type Selected = {
        readonly backend: ActiveBackend;
        readonly engine: RenderEngine;
        readonly gpuInfo: GpuInfo | null;
        readonly software: boolean;
      };
      let selected: Selected | null = null;

      const tryWebGpu = async (): Promise<Selected | null> => {
        const mod = await loadBrowserEngine();
        for (const compatibility of [false, true]) {
          const candidate = new RenderEngine(mod);
          const attached = await candidate.attachGpu(null, { compatibility });
          if (!attached.ok) {
            candidate.dispose();
            fallbackNotes.push(
              `WebGPU (${compatibility ? "compat" : "core"}): ${attached.message}`,
            );
            continue;
          }
          const isSoft = attached.value.fallback || SOFTWARE_RE.test(attached.value.adapter);
          if (isSoft && !softwareOk) {
            candidate.dispose();
            fallbackNotes.push(
              `WebGPU (${compatibility ? "compat" : "core"}): refused software adapter (${attached.value.adapter})`,
            );
            continue;
          }
          return {
            backend: "webgpu",
            engine: candidate,
            gpuInfo: attached.value,
            software: isSoft,
          };
        }
        return null;
      };

      const tryWebGl2 = async (): Promise<Selected | null> => {
        const mod = await loadWebglEngine();
        const canvas = document.createElement("canvas");
        canvas.width = CELL_WIDTH;
        canvas.height = CELL_HEIGHT;
        const candidate = new RenderEngine(mod);
        const attached = await candidate.attachGpu(canvas);
        if (!attached.ok) {
          candidate.dispose();
          fallbackNotes.push(`WebGL2: ${attached.message}`);
          return null;
        }
        const isSoft = attached.value.fallback || SOFTWARE_RE.test(attached.value.adapter);
        if (isSoft && !softwareOk) {
          candidate.dispose();
          fallbackNotes.push(`WebGL2: refused software adapter (${attached.value.adapter})`);
          return null;
        }
        return {
          backend: "webgl2",
          engine: candidate,
          gpuInfo: attached.value,
          software: isSoft,
        };
      };

      try {
        if (mode === "webgpu") {
          selected = await tryWebGpu();
          if (!selected) throw new Error(fallbackNotes.at(-1) ?? "WebGPU unavailable");
        } else if (mode === "webgl2") {
          selected = await tryWebGl2();
          if (!selected) throw new Error(fallbackNotes.at(-1) ?? "WebGL2 unavailable");
        } else if (mode === "cpu") {
          const mod = await loadBrowserEngine();
          selected = {
            backend: "cpu",
            engine: new RenderEngine(mod),
            gpuInfo: null,
            software: true,
          };
        } else {
          // Auto: WebGPU -> WebGL2 -> CPU (same order as the editor).
          selected = (await tryWebGpu()) ?? (await tryWebGl2());
          if (!selected) {
            const mod = await loadBrowserEngine();
            selected = {
              backend: "cpu",
              engine: new RenderEngine(mod),
              gpuInfo: null,
              software: true,
            };
          }
        }

        if (seq !== runSeq.current) {
          selected.engine.dispose();
          return;
        }

        const { backend: activeBackend, engine: activeEngine, gpuInfo, software } = selected;
        if (activeBackend === "webgpu") {
          activeEngine.setComputeOrdinary(useCompute);
          activeEngine.computeResetStats();
        }
        const sampleCount = software ? 1 : 5;
        const cells: CellReport[] = [];

        for (const [cellIndex, cell] of DIAGNOSTIC_CELLS.entries()) {
          if (seq !== runSeq.current) return;
          const expectedB64 = EXPECTED_PNGS[cell.id];
          const expectedPngUrl = expectedB64 ? `data:image/png;base64,${expectedB64}` : "";
          try {
            for (const img of cell.images ?? []) {
              const put = activeEngine.putImage(img.id, img.width, img.height, img.rgba, false);
              if (!put.ok) throw new Error(`putImage: ${put.message}`);
            }
            const applied = activeEngine.apply(cell.build(cellIndex + 1));
            if (!applied.ok) throw new Error(`apply: ${applied.message}`);

            let actualRgba: Uint8Array;
            const samples: number[] = [];
            let computeUsed = false;

            if (activeBackend === "cpu") {
              // Correctness render (kept separate from the warm timing samples).
              const first = activeEngine.renderCpu(
                CELL_WIDTH,
                CELL_HEIGHT,
                CELL_CAMERA,
                cell.background,
                false,
              );
              if (!first.ok) throw new Error(first.message);
              actualRgba = first.value.pixels;
              for (let i = 0; i < sampleCount; i++) {
                const ts = performance.now();
                const r = activeEngine.renderCpu(
                  CELL_WIDTH,
                  CELL_HEIGHT,
                  CELL_CAMERA,
                  cell.background,
                  false,
                );
                if (!r.ok) throw new Error(r.message);
                samples.push(performance.now() - ts);
              }
            } else {
              // Correctness render + readback (excluded from warm frame timings so every sample
              // measures the same renderGpu + gpuFinished work on both hardware and software GPUs).
              const first = activeEngine.renderGpu(
                CELL_WIDTH,
                CELL_HEIGHT,
                CELL_CAMERA,
                cell.background,
                false,
              );
              if (!first.ok) throw new Error(first.message);
              computeUsed = activeBackend === "webgpu" && activeEngine.computeUsed();
              const px = await activeEngine.gpuPixels();
              if (!px.ok) throw new Error(px.message);
              actualRgba = px.value;
              for (let i = 0; i < sampleCount; i++) {
                const ts = performance.now();
                const r = activeEngine.renderGpu(
                  CELL_WIDTH,
                  CELL_HEIGHT,
                  CELL_CAMERA,
                  cell.background,
                  false,
                );
                if (!r.ok) throw new Error(r.message);
                const done = await activeEngine.gpuFinished();
                if (!done.ok) throw new Error(done.message);
                samples.push(performance.now() - ts);
              }
            }

            if (!expectedPngUrl) throw new Error("Missing expected PNG for cell");
            const expectedRgba = await decodePngDataUrl(expectedPngUrl);
            const diff = score(actualRgba, expectedRgba, CELL_WIDTH, CELL_HEIGHT);
            const violations = outsideTolerance(diff);
            const { heat, ...metrics } = diff;
            cells.push({
              id: cell.id,
              title: cell.title,
              category: cell.category,
              description: cell.description,
              ok: violations.length === 0,
              error: null,
              violations,
              score: metrics,
              renderMs: quant(samples),
              ...(activeBackend === "webgpu" && useCompute ? { computeUsed } : {}),
              expectedPngUrl,
              actualRgba,
              diffHeat: heat,
            });
          } catch (err) {
            cells.push({
              id: cell.id,
              title: cell.title,
              category: cell.category,
              description: cell.description,
              ok: false,
              error: err instanceof Error ? err.message : String(err),
              violations: [],
              score: null,
              renderMs: null,
              expectedPngUrl,
              actualRgba: null,
              diffHeat: null,
            });
          }
        }

        let computeFailedFrames = 0;
        if (activeBackend === "webgpu" && useCompute) {
          const cs = await activeEngine.computeStats();
          if (cs.ok) computeFailedFrames = cs.value.failedFrames;
        }

        const rawDetails = gpuInfo?.details ?? null;
        let parsedDetails: AdapterDetailsJson | null = null;
        if (rawDetails) {
          try {
            parsedDetails = JSON.parse(rawDetails) as AdapterDetailsJson;
          } catch {
            parsedDetails = null;
          }
        }

        if (seq === runSeq.current) {
          setState({
            running: false,
            requested: mode,
            compute: useCompute,
            backend: activeBackend,
            adapter:
              gpuInfo?.adapter ??
              (activeBackend === "cpu" ? "vello_cpu (WebAssembly CPU)" : "none"),
            software,
            fallbackNotes,
            details: parsedDetails,
            rawDetails,
            probes,
            cells,
            computeFailedFrames,
            totalMs: Math.round(performance.now() - started),
            error: null,
          });
        }
      } catch (err) {
        if (seq === runSeq.current) {
          setState({
            running: false,
            requested: mode,
            compute: useCompute,
            backend: null,
            adapter: "unavailable",
            software: false,
            fallbackNotes,
            details: null,
            rawDetails: null,
            probes,
            cells: [],
            computeFailedFrames: 0,
            totalMs: Math.round(performance.now() - started),
            error: err instanceof Error ? err.message : String(err),
          });
        }
      } finally {
        selected?.engine.dispose();
      }
    },
    [],
  );

  useEffect(() => {
    const existing = document.querySelector<HTMLMetaElement>('meta[name="robots"]');
    const created = existing ? null : document.createElement("meta");
    const target = existing ?? created;
    const prevContent = existing?.getAttribute("content") ?? null;
    if (created) {
      created.name = "robots";
      document.head.appendChild(created);
    }
    target?.setAttribute("content", "noindex, nofollow");
    return () => {
      if (created) created.remove();
      else if (existing) {
        if (prevContent === null) existing.removeAttribute("content");
        else existing.setAttribute("content", prevContent);
      }
    };
  }, []);

  useEffect(() => {
    void runDiagnostics(requested, allowSoftware, computeOn);
    return () => {
      runSeq.current++;
    };
  }, [requested, allowSoftware, computeOn, runDiagnostics]);

  const handleRunBench = useCallback(async () => {
    const canvas = benchCanvasRef.current;
    if (!canvas || benchRunning) return;
    setBenchRunning(true);
    setBenchError(null);
    setBenchProgress(`0 / ${P0_BENCH_FRAMES}`);
    try {
      const report = await runP0RetinaBench({
        canvas,
        allowSoftware,
        frames: P0_BENCH_FRAMES,
        onProgress: (frame, total) => setBenchProgress(`${frame} / ${total}`),
      });
      setBenchReport(report);
    } catch (err) {
      setBenchError(err instanceof Error ? err.message : String(err));
    } finally {
      setBenchRunning(false);
      setBenchProgress(null);
    }
  }, [allowSoftware, benchRunning]);

  const passedCount = state.cells.filter((c) => c.ok).length;
  const totalCount = state.cells.length;
  const allPassed = !state.running && !state.error && totalCount > 0 && passedCount === totalCount;

  const reportText = useMemo(() => {
    const payload = {
      timestamp: new Date().toISOString(),
      browser: {
        userAgent: navigator.userAgent,
        platform: navigator.platform,
        devicePixelRatio: window.devicePixelRatio,
        hardwareConcurrency: navigator.hardwareConcurrency,
      },
      selection: {
        requested: state.requested,
        allowSoftware,
        compute: state.compute,
        backend: state.backend,
        adapter: state.adapter,
        software: state.software,
        fallbackNotes: state.fallbackNotes,
      },
      probes: state.probes,
      adapterDetails: state.details,
      tolerance: CPU_GPU_TOLERANCE,
      summary: {
        passed: passedCount,
        total: totalCount,
        computeFailedFrames: state.computeFailedFrames,
        totalMs: state.totalMs,
        error: state.error,
      },
      cells: state.cells.map((c) => ({
        id: c.id,
        ok: c.ok,
        ...(c.computeUsed !== undefined ? { computeUsed: c.computeUsed } : {}),
        error: c.error,
        violations: c.violations,
        renderMs: c.renderMs,
        score: c.score
          ? {
              mean: Number(c.score.mean.toFixed(4)),
              p99: c.score.p99,
              max: c.score.max,
              worstTile: Number(c.score.worstTile.toFixed(3)),
              severeInTile: c.score.severeInTile,
              alphaMax: c.score.alphaMax,
            }
          : null,
      })),
      ...(benchReport ? { computeP0Bench: benchReport } : {}),
    };
    const header = [
      "# Drawpane Renderer Diagnostics",
      `- Browser: ${navigator.userAgent}`,
      `- Backend: ${state.backend ?? "none"} (${state.adapter}${state.software ? ", software" : ""}${state.compute ? ", compute P0" : ""})`,
      `- Result: ${passedCount}/${totalCount} cells passed in ${state.totalMs} ms${state.compute ? ` (compute bump failures: ${state.computeFailedFrames})` : ""}`,
      ...(state.fallbackNotes.length
        ? [`- Fallback notes: ${state.fallbackNotes.join(" | ")}`]
        : []),
      ...(benchReport
        ? [
            `- P0 10k Retina 2x (${benchReport.width}x${benchReport.height}, ${benchReport.layers} layers, ${benchReport.frames} frames, ${benchReport.presentationMode}): rAF p50/p95/p99 ${benchReport.rafIntervalMs.p50}/${benchReport.rafIntervalMs.p95}/${benchReport.rafIntervalMs.p99} ms · CPU p50/p95/p99 ${benchReport.cpuMs.p50}/${benchReport.cpuMs.p95}/${benchReport.cpuMs.p99} ms · GPU timestamps ${benchReport.gpuMs ? `p50/p95/p99 ${benchReport.gpuMs.p50}/${benchReport.gpuMs.p95}/${benchReport.gpuMs.p99} ms` : "unsupported"} · bump failed ${benchReport.bump.failedFrames}/${benchReport.bump.framesChecked}`,
          ]
        : []),
      "",
      "| Cell | Status | Mean | p99 | Worst tile | Severe | Max | Frame p50 / p95 ms |",
      "| --- | --- | --- | --- | --- | --- | --- | --- |",
      ...state.cells.map((c) =>
        c.score
          ? `| ${c.id} | ${c.ok ? "PASS" : "FAIL"} | ${c.score.mean.toFixed(4)} | ${c.score.p99} | ${c.score.worstTile.toFixed(3)} | ${c.score.severeInTile} | ${c.score.max} | ${c.renderMs ? `${c.renderMs.p50} / ${c.renderMs.p95}` : "n/a"} |`
          : `| ${c.id} | FAIL | n/a | n/a | n/a | n/a | n/a | ${c.error ?? "error"} |`,
      ),
      "",
      "```json",
      JSON.stringify(payload, null, 2),
      "```",
    ];
    return header.join("\n");
  }, [state, allowSoftware, passedCount, totalCount, benchReport]);

  return (
    <div className="diag">
      <header className="diag__bar">
        <div className="diag__brand">
          <Logo size={20} />
          <span>Renderer diagnostics</span>
        </div>
        <Button
          variant="primary"
          size="sm"
          disabled={state.running}
          onClick={() => void copy(reportText, "report")}
        >
          {copied === "report" ? "Copied" : "Copy report"}
        </Button>
      </header>

      <main className="diag__main">
        <div className="diag__head">
          <div>
            <h1 className="diag__title">Render engine diagnostics</h1>
            <p className="diag__lede">
              Checks backend selection, GPU adapter limits, and pixel parity against the shipped CPU
              reference scene in your browser.
            </p>
          </div>
          <div className="diag__controls">
            <SegmentedControl<RequestedMode>
              label="Backend"
              value={requested}
              onChange={setRequested}
              options={[
                { value: "auto", label: "Auto" },
                { value: "webgpu", label: "WebGPU" },
                { value: "webgl2", label: "WebGL2" },
                { value: "cpu", label: "CPU" },
              ]}
            />
            <label className="diag__toggle">
              <input
                type="checkbox"
                checked={allowSoftware}
                onChange={(e) => setAllowSoftware(e.target.checked)}
              />
              Allow software GPU
            </label>
            <label className="diag__toggle">
              <input
                type="checkbox"
                checked={computeOn}
                onChange={(e) => setComputeOn(e.target.checked)}
              />
              Compute P0 (ordinary paint)
            </label>
            <Button
              size="sm"
              disabled={state.running}
              onClick={() => void runDiagnostics(requested, allowSoftware, computeOn)}
            >
              Re-run
            </Button>
          </div>
        </div>

        <section className="diag__summary" aria-label="Summary">
          <div className="diag__card">
            <span className="diag__label">Chosen backend</span>
            <span className="diag__value" data-testid="diag-backend">
              {state.running ? "Running…" : (state.backend ?? "None")}
            </span>
            <span className="diag__mono">
              {state.adapter}
              {state.software ? " (software)" : ""}
            </span>
          </div>
          <div className="diag__card">
            <span className="diag__label">Parity result</span>
            <span className="diag__value" data-testid="diag-summary">
              {state.running ? (
                "Checking cells…"
              ) : allPassed ? (
                <Badge tone="success">
                  {passedCount}/{totalCount} passed
                </Badge>
              ) : (
                <Badge tone="danger">
                  {passedCount}/{totalCount} passed
                </Badge>
              )}
            </span>
            <span className="diag__mono">
              Tolerance: mean &le; {CPU_GPU_TOLERANCE.mean}, p99 &le; {CPU_GPU_TOLERANCE.p99}, worst
              tile &le; {CPU_GPU_TOLERANCE.worstTile}
            </span>
          </div>
          <div className="diag__card">
            <span className="diag__label">Browser</span>
            <span className="diag__value">
              {navigator.platform || "Unknown platform"} · {window.devicePixelRatio}x DPR
            </span>
            <span className="diag__mono">{navigator.userAgent}</span>
          </div>
        </section>

        {state.error ? (
          <p className="diag__error" role="alert">
            {state.error}
          </p>
        ) : null}

        {state.fallbackNotes.length > 0 ? (
          <section className="diag__section">
            <h2 className="diag__section-title">Selection notes</h2>
            <div className="diag__table-wrap">
              <table className="diag__table">
                <tbody>
                  {state.fallbackNotes.map((note, idx) => (
                    <tr key={note}>
                      <th>Step {idx + 1}</th>
                      <td className="diag__mono">{note}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ) : null}

        <section className="diag__section">
          <h2 className="diag__section-title">Browser capabilities & adapter</h2>
          <div className="diag__table-wrap">
            <table className="diag__table">
              <tbody>
                <tr>
                  <th>WebGPU (core)</th>
                  <td className="diag__mono">{state.probes?.webgpuCore ?? "…"}</td>
                </tr>
                <tr>
                  <th>WebGPU (compat)</th>
                  <td className="diag__mono">{state.probes?.webgpuCompat ?? "…"}</td>
                </tr>
                <tr>
                  <th>WebGL2</th>
                  <td className="diag__mono">
                    {state.probes
                      ? `${state.probes.webgl2} (color_buffer_float: ${state.probes.webgl2ExtFloat ? "yes" : "no"}, half_float: ${state.probes.webgl2ExtHalfFloat ? "yes" : "no"})`
                      : "…"}
                  </td>
                </tr>
                <tr>
                  <th>WebKit / canvas probes</th>
                  <td className="diag__mono">
                    {state.probes
                      ? `OffscreenCanvas WebGL2 -> 2D: ${state.probes.offscreenGlTo2d} · RGBA16F FBO: ${state.probes.rgba16fFbo} · ctx.filter blur: ${state.probes.ctxFilterBlur ? "yes" : "no"}`
                      : "…"}
                  </td>
                </tr>
                {state.details ? (
                  <>
                    <tr>
                      <th>Adapter driver</th>
                      <td className="diag__mono">
                        {[
                          state.details.name,
                          state.details.device_type,
                          state.details.driver,
                          state.details.driver_info,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </td>
                    </tr>
                    <tr>
                      <th>Device features</th>
                      <td className="diag__mono">
                        {Array.isArray(state.details.features)
                          ? state.details.features.length
                            ? state.details.features.join(", ")
                            : "none"
                          : state.details.features || "none"}
                      </td>
                    </tr>
                    <tr>
                      <th>Device limits</th>
                      <td className="diag__mono">
                        {state.details.limits
                          ? Object.entries(state.details.limits)
                              .map(([k, v]) => `${k}=${v}`)
                              .join(" · ")
                          : "n/a"}
                      </td>
                    </tr>
                  </>
                ) : null}
              </tbody>
            </table>
          </div>
        </section>

        <section className="diag__section">
          <div className="diag__section-head">
            <h2 className="diag__section-title">Test scene ({DIAGNOSTIC_CELLS.length} cells)</h2>
            <span className="diag__mono">
              {CELL_WIDTH}x{CELL_HEIGHT} px · {state.totalMs} ms total
            </span>
          </div>
          <div className="diag__cells">
            {state.cells.map((cell) => (
              <article key={cell.id} className="diag__cell" data-cell-id={cell.id}>
                <div className="diag__cell-head">
                  <h3 className="diag__cell-title">{cell.title}</h3>
                  <Badge tone={cell.ok ? "success" : "danger"}>{cell.ok ? "Pass" : "Fail"}</Badge>
                </div>
                <p className="diag__cell-desc">{cell.description}</p>
                <div className="diag__thumbs">
                  <div className="diag__thumb">
                    <img
                      src={cell.expectedPngUrl}
                      width={CELL_WIDTH}
                      height={CELL_HEIGHT}
                      alt={`${cell.title} expected`}
                    />
                    <span className="diag__thumb-label">Expected (CPU)</span>
                  </div>
                  <PixelCanvas
                    rgba={cell.actualRgba}
                    width={CELL_WIDTH}
                    height={CELL_HEIGHT}
                    label={`Actual (${state.backend ?? ""})`}
                  />
                  <PixelCanvas
                    rgba={cell.diffHeat}
                    width={CELL_WIDTH}
                    height={CELL_HEIGHT}
                    label="Diff (4x)"
                  />
                </div>
                {cell.score ? (
                  <div className="diag__metrics">
                    <span>mean {cell.score.mean.toFixed(4)}</span>
                    <span>p99 {cell.score.p99}</span>
                    <span>tile {cell.score.worstTile.toFixed(3)}</span>
                    <span>max {cell.score.max}</span>
                    {cell.renderMs ? (
                      <span>
                        {cell.renderMs.p50}/{cell.renderMs.p95} ms
                      </span>
                    ) : null}
                    {cell.computeUsed !== undefined ? (
                      <span>{cell.computeUsed ? "compute" : "vello_gpu"}</span>
                    ) : null}
                  </div>
                ) : null}
                {cell.error ? <p className="diag__error">{cell.error}</p> : null}
                {cell.violations.length > 0 ? (
                  <p className="diag__error">{cell.violations.join("; ")}</p>
                ) : null}
              </article>
            ))}
          </div>
        </section>

        <section className="diag__section" aria-label="Compute P0 Retina benchmark">
          <div className="diag__section-head">
            <h2 className="diag__section-title">Compute P0 10k-layer Retina 2x benchmark</h2>
            <Button size="sm" disabled={benchRunning} onClick={() => void handleRunBench()}>
              {benchRunning
                ? `Running (${benchProgress ?? "…"})`
                : `Run 10k Retina 2x (${P0_BENCH_FRAMES} frames)`}
            </Button>
          </div>
          <p className="diag__cell-desc">
            Runs {P0_BENCH_FRAMES} presented rAF zoom frames around 100% zoom at 2880x1800 (Retina
            2x) on a 10,000-layer ordinary page using WebGPU Core compute, checking per-frame bump
            counters and hardware GPU timestamps where available (laptop target: GPU p95 &le;{" "}
            {P0_LAPTOP_GPU_P95_TARGET_MS} ms, 0 bump failures). Results are included in Copy report.
          </p>
          <canvas
            ref={benchCanvasRef}
            width={2880}
            height={1800}
            aria-label="Compute P0 10k Retina 2x live surface"
            style={{
              width: "100%",
              maxWidth: "480px",
              aspectRatio: "16 / 10",
              borderRadius: "var(--radius-sm)",
              boxShadow: "inset 0 0 0 1px var(--line)",
              display: benchRunning || benchReport ? "block" : "none",
            }}
          />
          {benchError ? (
            <p className="diag__error" role="alert">
              {benchError}
            </p>
          ) : null}
          {benchReport ? (
            <div className="diag__table-wrap">
              <table className="diag__table">
                <tbody>
                  <tr>
                    <th>Adapter &amp; mode</th>
                    <td className="diag__mono">
                      {benchReport.adapter} ({benchReport.presentationMode},{" "}
                      {benchReport.computeFrames}/{benchReport.frames} compute,{" "}
                      {benchReport.presentedFrames}/{benchReport.frames} presented)
                    </td>
                  </tr>
                  <tr>
                    <th>rAF frame interval (ms)</th>
                    <td className="diag__mono">
                      p50 {benchReport.rafIntervalMs.p50} · p95 {benchReport.rafIntervalMs.p95} ·
                      p99 {benchReport.rafIntervalMs.p99} · max {benchReport.rafIntervalMs.max}
                    </td>
                  </tr>
                  <tr>
                    <th>Main-thread CPU (ms)</th>
                    <td className="diag__mono">
                      p50 {benchReport.cpuMs.p50} · p95 {benchReport.cpuMs.p95} · p99{" "}
                      {benchReport.cpuMs.p99} · max {benchReport.cpuMs.max}
                    </td>
                  </tr>
                  <tr>
                    <th>GPU timestamps (ms)</th>
                    <td className="diag__mono">
                      {benchReport.gpuMs
                        ? `sum p50 ${benchReport.gpuMs.p50} · p95 ${benchReport.gpuMs.p95} · p99 ${benchReport.gpuMs.p99} · max ${benchReport.gpuMs.max}${benchReport.gpuSpanMs ? ` (span p95 ${benchReport.gpuSpanMs.p95})` : ""}`
                        : "timestamp-query not exposed by this browser/adapter"}
                    </td>
                  </tr>
                  <tr>
                    <th>Bump allocator check</th>
                    <td className="diag__mono">
                      {benchReport.bump.failedFrames === 0 &&
                      benchReport.bump.framesChecked >= benchReport.frames
                        ? `PASS (0/${benchReport.bump.framesChecked} failed)`
                        : `FAIL (${benchReport.bump.failedFrames}/${benchReport.bump.framesChecked} failed, mask 0x${benchReport.bump.anyFailedMask.toString(16)})`}{" "}
                      · max lines {benchReport.bump.maxLines} · max segments{" "}
                      {benchReport.bump.maxSegments}
                    </td>
                  </tr>
                  {benchReport.strokeCache ? (
                    <tr>
                      <th>Cached stroke outlines</th>
                      <td className="diag__mono">
                        {benchReport.strokeCache.opsCached}/{benchReport.strokeCache.opsTotal} ops ·
                        verbs {benchReport.strokeCache.inputVerbs} -&gt;{" "}
                        {benchReport.strokeCache.expandedVerbs} ·{" "}
                        {Math.round(benchReport.strokeCache.cachedBytes / 1024)} KiB
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          ) : null}
        </section>

        <details className="diag__details">
          <summary>Raw report (Markdown + JSON)</summary>
          <pre className="diag__pre" data-testid="diag-report">
            {reportText}
          </pre>
        </details>
      </main>
    </div>
  );
}
