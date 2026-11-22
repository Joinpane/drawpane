/**
 * The compute path's Retina bench for `/diagnostics/renderer?compute=1` (decision 0040, P1-0),
 * measured the way the PR #291 and stack reviews asked:
 *
 * - CPU is the main-thread wall of every engine call a frame takes, routing included, split into
 *   staging, showing the checked frame and any vello_gpu fallback, beside the engine's own
 *   encode, render and submit times.
 * - Every frame is kept in order with its zoom, CPU, check wait and GPU time, so the slow frames
 *   can be found, not just counted. Each sweep reports its own GPU pass times.
 * - Edits and drags are patches to the card in the middle of the view (an off-screen card costs
 *   vello_gpu nothing, which hid its real drag cost), on the 10k page and on a 40k one, against
 *   vello_gpu on its own device, with how long each took to show.
 * - Both engines present the same way, so their shown times compare: each to a real canvas of its
 *   own in a browser a person drives, both offscreen in automated runs (WebDriver), because
 *   headless Chromium loses a WebGPU device that presents.
 */
import { type Camera, type GpuInfo, RenderEngine, type Result } from "@drawpane/engine";
import { loadBrowserEngine, loadComputeEngine } from "@drawpane/engine/browser";
import { CAP, JOIN, ListWriter, ROOT } from "@drawpane/engine/wire";
import { type CheckedFrame, COMPUTE_BG, drawChecked } from "./compute-check";
import { buildOrdinaryScene } from "./compute-scene";

export const BENCH_WIDTH = 2880;
export const BENCH_HEIGHT = 1800;
const DPR = 2;
const CSS_W = BENCH_WIDTH / DPR;
const CSS_H = BENCH_HEIGHT / DPR;
/** Layers per card in `buildOrdinaryScene`: card ids are 1, 26, 51, ... */
const CARD_LAYERS = 25;
const CARD_W = 320;
const CARD_H = 220;
const CARD_GAP = 24;

export interface Quantiles {
  readonly n: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
}

export function quantiles(xs: readonly number[]): Quantiles {
  if (xs.length === 0) return { n: 0, p50: 0, p95: 0, p99: 0, max: 0 };
  const s = [...xs].sort((a, b) => a - b);
  const at = (q: number) => Math.round((s[Math.ceil(q * s.length) - 1] ?? 0) * 100) / 100;
  return { n: s.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: at(1) };
}

const round = (x: number) => Math.round(x * 100) / 100;

/** Where a frame's main-thread time went (ms). */
export interface CpuSplit {
  /** `stageComputeFrame` calls: routing, any encode, the dispatch. */
  readonly stage: number;
  /** `finishComputeFrame`: the check's verdict and presenting. */
  readonly finish: number;
  /** A vello_gpu frame instead (or the whole frame, on vello_gpu). */
  readonly fallback: number;
  /** The engine's own numbers for the frame shown. */
  readonly encode: number;
  readonly render: number;
  readonly submit: number;
}

/** One frame of a sweep, in order. */
export interface FrameSample {
  readonly i: number;
  readonly zoom: number;
  readonly backend: "compute" | "vello_gpu";
  readonly draws: number;
  /** Main-thread wall of every engine call the frame took. */
  readonly cpuMs: number;
  readonly split: CpuSplit;
  /** Waiting for the compute check (off the main thread), or for vello_gpu's fence. */
  readonly waitMs: number;
  /** GPU time of the frame's passes (timestamp queries), when the device has them. */
  readonly gpuMs: number | null;
  /** From the frame's request to the next animation frame after it was shown. */
  readonly shownMs: number;
}

export interface SweepReport {
  readonly label: string;
  readonly frames: readonly FrameSample[];
  readonly cpuMs: Quantiles;
  /** p50 of each part of the CPU split. */
  readonly splitP50: CpuSplit;
  readonly waitMs: Quantiles;
  readonly gpuMs: Quantiles | null;
  readonly shownMs: Quantiles;
  /** Mean GPU ms per compute pass over this sweep (compute sweeps with timestamps). */
  readonly passAvgMs: Readonly<Record<string, number>> | null;
  /** The frames at or past the GPU (else CPU) p99, with what they were drawing. */
  readonly slowest: readonly FrameSample[];
  readonly computeFrames: number;
}

export interface EditReport {
  readonly label: string;
  /** Main-thread wall of applying each patch and drawing the frame after it. */
  readonly cpuMs: Quantiles;
  readonly applyMs: Quantiles;
  /** Waiting for the compute check or vello_gpu's fence. */
  readonly waitMs: Quantiles;
  /** From the patch to the animation frame after its frame was shown. */
  readonly shownMs: Quantiles;
  readonly samples: readonly number[];
}

export interface BenchReport {
  readonly adapter: string;
  readonly software: boolean;
  readonly timestamps: boolean;
  readonly presentation: "canvas" | "offscreen";
  readonly width: number;
  readonly height: number;
  readonly layers: number;
  readonly sweeps: readonly SweepReport[];
  readonly edits: readonly EditReport[];
  /** Checks that found an overflow and redrew, over the whole bench. */
  readonly overflowChecks: number;
  /** Whole-page encodes and in-place patched moves on compute, over the whole bench. */
  readonly encodes: { readonly full: number; readonly patched: number } | null;
  readonly fallback: string | null;
  readonly ms: number;
}

const nextFrame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));

function cameraAt(pageWidth: number, pageHeight: number, zoom: number): Camera {
  return {
    zoom,
    x: CSS_W / 2 - (pageWidth / 2) * zoom,
    y: CSS_H / 2 - (pageHeight / 2) * zoom,
    dpr: DPR,
  };
}

const EMPTY_SPLIT: CpuSplit = { stage: 0, finish: 0, fallback: 0, encode: 0, render: 0, submit: 0 };

function splitOf(frame: CheckedFrame): CpuSplit {
  return {
    stage: round(frame.stageMs),
    finish: round(frame.finishMs),
    fallback: round(frame.fallbackMs),
    encode: round(frame.stats.ms.encode),
    render: round(frame.stats.ms.render),
    submit: round(frame.stats.ms.submit),
  };
}

function sweepReport(
  label: string,
  frames: FrameSample[],
  passAvgMs: Readonly<Record<string, number>> | null,
): SweepReport {
  const gpu = frames.map((f) => f.gpuMs).filter((x): x is number => x !== null);
  const gpuQ = gpu.length === frames.length && gpu.length > 0 ? quantiles(gpu) : null;
  const cpuQ = quantiles(frames.map((f) => f.cpuMs));
  const slowest = gpuQ
    ? frames.filter((f) => (f.gpuMs ?? 0) >= gpuQ.p99)
    : frames.filter((f) => f.cpuMs >= cpuQ.p99);
  const p50 = (pick: (s: CpuSplit) => number) => quantiles(frames.map((f) => pick(f.split))).p50;
  return {
    label,
    frames,
    cpuMs: cpuQ,
    splitP50: {
      stage: p50((s) => s.stage),
      finish: p50((s) => s.finish),
      fallback: p50((s) => s.fallback),
      encode: p50((s) => s.encode),
      render: p50((s) => s.render),
      submit: p50((s) => s.submit),
    },
    waitMs: quantiles(frames.map((f) => f.waitMs)),
    gpuMs: gpuQ,
    shownMs: quantiles(frames.map((f) => f.shownMs)),
    passAvgMs,
    slowest,
    computeFrames: frames.filter((f) => f.backend === "compute").length,
  };
}

/** What the compute engine counted since its stats were last reset, added to `totals`. */
function takeStats(
  engine: RenderEngine,
  totals: { overflow: number; full: number; patched: number },
) {
  const stats = engine.computeStats();
  if (!stats.ok) return null;
  totals.overflow += stats.value.failedFrames;
  totals.full += stats.value.encodes?.full ?? 0;
  totals.patched += stats.value.encodes?.patched ?? 0;
  engine.computeResetStats();
  return stats.value;
}

/** A zoom sweep on compute: each frame staged, checked and shown, as the editor does. */
async function computeSweep(
  engine: RenderEngine,
  label: string,
  zooms: readonly number[],
  page: { readonly pageWidth: number; readonly pageHeight: number },
  totals: { overflow: number; full: number; patched: number },
  signal: AbortSignal,
): Promise<SweepReport> {
  takeStats(engine, totals);
  const frames: FrameSample[] = [];
  await nextFrame();
  for (const [i, zoom] of zooms.entries()) {
    signal.throwIfAborted();
    const t0 = performance.now();
    const frame = await drawChecked(
      engine,
      BENCH_WIDTH,
      BENCH_HEIGHT,
      cameraAt(page.pageWidth, page.pageHeight, zoom),
    );
    // Fenced like every sweep: the frame counts as shown at the animation frame after the GPU
    // finished presenting it.
    const fence = await engine.gpuFinished();
    if (!fence.ok) throw new Error(`compute fence ${i}: ${fence.message}`);
    await nextFrame();
    frames.push({
      i,
      zoom: round(zoom),
      backend: frame.backend,
      draws: frame.attempts,
      cpuMs: round(frame.cpuMs),
      split: splitOf(frame),
      waitMs: round(frame.checkMs),
      gpuMs: null,
      shownMs: round(performance.now() - t0),
    });
  }
  // The engine keeps every checked frame's GPU time in order; a frame that redrew after an
  // overflow checked more than once, so line them up by draws.
  const stats = takeStats(engine, totals);
  if (stats?.timestampsSupported) {
    const gpu = stats.gpuMs;
    let at = 0;
    for (const [k, f] of frames.entries()) {
      if (f.backend !== "compute") continue;
      at += f.draws;
      const ms = gpu[at - 1];
      if (ms !== undefined) frames[k] = { ...f, gpuMs: round(ms) };
    }
  }
  const passes = stats?.timestampsSupported
    ? Object.fromEntries(
        Object.entries(stats.passAvgMs)
          .filter(([, ms]) => ms > 0)
          .map(([k, ms]) => [k, round(ms)]),
      )
    : null;
  return sweepReport(label, frames, passes);
}

/**
 * A zoom sweep through the bump gate: each frame presented at once (the GPU keeps the last good
 * frame wherever a stage overflowed), its check landing later. Fenced exactly as the vello_gpu
 * sweep is: wait is how long the GPU took to finish after the request, and shown is the
 * animation frame after that. Every frame's check is kept and settled; when the engine has as
 * many in flight as it allows, the sweep waits for the oldest before presenting again.
 */
async function gatedSweep(
  engine: RenderEngine,
  label: string,
  zooms: readonly number[],
  page: { readonly pageWidth: number; readonly pageHeight: number },
  totals: { overflow: number; full: number; patched: number },
  signal: AbortSignal,
): Promise<SweepReport> {
  // The gate keeps the frame on screen, so there has to be one: draw the first one checked.
  await drawChecked(
    engine,
    BENCH_WIDTH,
    BENCH_HEIGHT,
    cameraAt(page.pageWidth, page.pageHeight, zooms[0] ?? 1),
  );
  takeStats(engine, totals);
  const frames: FrameSample[] = [];
  const checks: Array<Promise<boolean>> = [];
  let settled = 0;
  let redraws = 0;
  let busy = 0;
  await nextFrame();
  for (const [i, zoom] of zooms.entries()) {
    signal.throwIfAborted();
    const camera = cameraAt(page.pageWidth, page.pageHeight, zoom);
    let t0 = performance.now();
    let presented = engine.presentComputeFrame(BENCH_WIDTH, BENCH_HEIGHT, camera, COMPUTE_BG);
    while (presented.ok && presented.value === "busy" && settled < checks.length) {
      busy++;
      await checks[settled++];
      t0 = performance.now();
      presented = engine.presentComputeFrame(BENCH_WIDTH, BENCH_HEIGHT, camera, COMPUTE_BG);
    }
    const cpuMs = performance.now() - t0;
    if (!presented.ok) throw new Error(`gated frame ${i}: ${presented.message}`);
    if (!presented.value || presented.value === "busy")
      throw new Error(`gated frame ${i}: compute didn't draw it`);
    checks.push(presented.value.check);
    const t1 = performance.now();
    const fence = await engine.gpuFinished();
    if (!fence.ok) throw new Error(`gated fence ${i}: ${fence.message}`);
    const waitMs = performance.now() - t1;
    await nextFrame();
    const verdict = engine.finishComputeGate();
    if (verdict === "redraw") redraws++;
    if (verdict === "fallback" || verdict === "lost")
      throw new Error(`gated frame ${i}: ${verdict}`);
    const stats = presented.value.stats;
    frames.push({
      i,
      zoom: round(zoom),
      backend: "compute",
      draws: 1,
      cpuMs: round(cpuMs),
      split: {
        ...EMPTY_SPLIT,
        stage: round(cpuMs),
        encode: round(stats.ms.encode),
        render: round(stats.ms.render),
        submit: round(stats.ms.submit),
      },
      waitMs: round(waitMs),
      gpuMs: null,
      shownMs: round(performance.now() - t0),
    });
  }
  await Promise.all(checks);

  engine.finishComputeGate();
  const stats = takeStats(engine, totals);
  if (stats?.timestampsSupported && stats.gpuMs.length === frames.length) {
    for (const [k, ms] of stats.gpuMs.entries()) {
      const f = frames[k];
      if (f) frames[k] = { ...f, gpuMs: round(ms) };
    }
  }
  const passes = stats?.timestampsSupported
    ? Object.fromEntries(
        Object.entries(stats.passAvgMs)
          .filter(([, ms]) => ms > 0)
          .map(([k, ms]) => [k, round(ms)]),
      )
    : null;
  const notes = [
    redraws ? `${redraws} redrew after an overflow` : "",
    busy ? `${busy} waited for a check` : "",
  ].filter(Boolean);
  return sweepReport(`${label}${notes.length ? ` (${notes.join("; ")})` : ""}`, frames, passes);
}

/** The same sweep on vello_gpu: `moving` is the editor's moving-frame path, else whole frames. */
async function velloSweep(
  engine: RenderEngine,
  label: string,
  zooms: readonly number[],
  page: { readonly pageWidth: number; readonly pageHeight: number },
  moving: boolean,
  signal: AbortSignal,
): Promise<SweepReport> {
  const frames: FrameSample[] = [];
  await nextFrame();
  for (const [i, zoom] of zooms.entries()) {
    signal.throwIfAborted();
    const t0 = performance.now();
    const drawn = engine.renderGpu(
      BENCH_WIDTH,
      BENCH_HEIGHT,
      cameraAt(page.pageWidth, page.pageHeight, zoom),
      COMPUTE_BG,
      moving,
      moving ? 8 : 0,
      true,
    );
    const cpuMs = performance.now() - t0;
    if (!drawn.ok) throw new Error(`vello_gpu frame ${i}: ${drawn.message}`);
    const t1 = performance.now();
    const fence = await engine.gpuFinished();
    if (!fence.ok) throw new Error(`vello_gpu fence ${i}: ${fence.message}`);
    const waitMs = performance.now() - t1;
    await nextFrame();
    frames.push({
      i,
      zoom: round(zoom),
      backend: "vello_gpu",
      draws: 1,
      cpuMs: round(cpuMs),
      split: {
        ...EMPTY_SPLIT,
        fallback: round(cpuMs),
        encode: round(drawn.value.ms.encode),
        render: round(drawn.value.ms.render),
        submit: round(drawn.value.ms.submit),
      },
      waitMs: round(waitMs),
      gpuMs: null,
      shownMs: round(performance.now() - t0),
    });
  }
  return sweepReport(label, frames, null);
}

/** The card in the middle of the view, which every frame of the edit loops draws. */
function centreCard(columns: number, rows: number) {
  const col = Math.floor(columns / 2);
  const row = Math.floor(rows / 2);
  return {
    id: (row * columns + col) * CARD_LAYERS + 1,
    x: col * (CARD_W + CARD_GAP) + 32,
    y: row * (CARD_H + CARD_GAP) + 32,
  };
}

/** The card record as `buildOrdinaryScene` makes it, with a fill colour of our choosing. */
function cardRecord(x: number, y: number, fill: readonly [number, number, number, number]) {
  return {
    flags: 0,
    opacity: 1,
    transform: [1, 0, 0, 1, x, y] as [number, number, number, number, number, number],
    width: CARD_W,
    height: CARD_H,
    coarseBelow: 0,
    reach: 1,
    unsupported: 0,
    paths: [
      {
        kind: "rect" as const,
        w: CARD_W,
        h: CARD_H,
        radii: [12, 12, 12, 12] as const,
        smoothing: 0,
      },
    ],
    ops: [
      {
        op: "fill" as const,
        path: 0,
        evenOdd: false,
        paint: { kind: "solid" as const, color: fill },
      },
      { op: "clip" as const, path: 0, evenOdd: false },
      { op: "children" as const },
      { op: "unclip" as const },
      {
        op: "stroke" as const,
        path: 0,
        style: { width: 1, join: JOIN.miter, cap: CAP.butt, miter: 4, dashes: [], dashOffset: 0 },
        paint: { kind: "solid" as const, color: [0.85, 0.85, 0.82, 1] as const },
      },
    ],
    coarse: [],
  };
}

interface Drawn {
  readonly cpuMs: number;
  readonly waitMs: number;
}

/**
 * Edits on the centre card, each a patch as the editor sends them: "fill" recolours it, "drag"
 * moves it. Measures the frame after each, until it was shown.
 */
async function editLoop(
  engine: RenderEngine,
  label: string,
  kind: "fill" | "drag",
  count: number,
  scene: {
    readonly pageWidth: number;
    readonly pageHeight: number;
    readonly columns: number;
    readonly rows: number;
  },
  draw: (engine: RenderEngine, camera: Camera) => Promise<Drawn>,
  signal: AbortSignal,
): Promise<EditReport> {
  const camera = cameraAt(scene.pageWidth, scene.pageHeight, 1);
  const card = centreCard(scene.columns, scene.rows);
  const samples: number[] = [];
  const apply: number[] = [];
  const waits: number[] = [];
  const shown: number[] = [];
  for (let i = 0; i < count; i++) {
    signal.throwIfAborted();
    const base = engine.revision;
    const w = new ListWriter(base, base + 1);
    if (kind === "drag") {
      w.transform(card.id, [1, 0, 0, 1, card.x + 6 * ((i % 10) + 1), card.y + 4 * ((i % 10) + 1)]);
    } else {
      // Even samples tint the card and odd ones restore it: the card starts white, so sample 0
      // must tint or it changes nothing.
      w.set(card.id, ROOT, cardRecord(card.x, card.y, [1, i % 2 ? 1 : 0.94, i % 2 ? 1 : 0.86, 1]));
    }
    const t0 = performance.now();
    const applied = engine.apply(w.finish());
    const t1 = performance.now();
    if (!applied.ok) throw new Error(`${label} edit ${i}: ${applied.message}`);
    if (applied.value.changes.length === 0) throw new Error(`${label} edit ${i} changed nothing`);
    apply.push(t1 - t0);
    const frame = await draw(engine, camera);
    await nextFrame();
    samples.push(round(t1 - t0 + frame.cpuMs));
    waits.push(frame.waitMs);
    shown.push(performance.now() - t0);
  }
  return {
    label,
    cpuMs: quantiles(samples),
    applyMs: quantiles(apply),
    waitMs: quantiles(waits),
    shownMs: quantiles(shown),
    samples,
  };
}

/** Whether a person drives this browser (automation reads back: headless loses presenting devices). */
function presentsToCanvas(): boolean {
  if (typeof navigator !== "undefined" && navigator.webdriver) return false;
  return new URLSearchParams(window.location.search).get("present") !== "0";
}

export async function runComputeBench(options: {
  /** Mounted canvases to present to, one per engine; used unless automation drives the browser. */
  readonly canvases: {
    readonly compute: HTMLCanvasElement | null;
    readonly vello: HTMLCanvasElement | null;
  };
  readonly allowSoftware: boolean;
  readonly frames?: number;
  readonly signal: AbortSignal;
  readonly onProgress?: (step: string) => void;
}): Promise<BenchReport> {
  const started = performance.now();
  const frames = options.frames ?? 240;
  const signal = options.signal;
  const [computeModule, legacyModule] = await Promise.all([
    loadComputeEngine(),
    loadBrowserEngine(),
  ]);
  const scene = { ...buildOrdinaryScene(20, 20), columns: 20, rows: 20 };
  let compute = new RenderEngine(computeModule);
  let vello = new RenderEngine(legacyModule);
  const totals = { overflow: 0, full: 0, patched: 0 };
  try {
    // Both present the same way: each to its own canvas, or both offscreen when automation
    // drives the browser or either one can't present.
    let presentation: "canvas" | "offscreen" = "offscreen";
    let attached: Result<GpuInfo> | null = null;
    let legacy: Result<GpuInfo> | null = null;
    const { compute: computeCanvas, vello: velloCanvas } = options.canvases;
    if (presentsToCanvas() && computeCanvas && velloCanvas) {
      for (const c of [computeCanvas, velloCanvas]) {
        c.width = BENCH_WIDTH;
        c.height = BENCH_HEIGHT;
      }
      attached = await compute.attachGpu(computeCanvas, { compatibility: false });
      legacy = attached.ok ? await vello.attachGpu(velloCanvas, { compatibility: false }) : null;
      if (attached.ok && legacy?.ok) presentation = "canvas";
      else {
        compute.dispose();
        vello.dispose();
        compute = new RenderEngine(computeModule);
        vello = new RenderEngine(legacyModule);
        attached = null;
        legacy = null;
      }
    }
    attached ??= await compute.attachGpu(null, { compatibility: false });
    if (!attached.ok) throw new Error(`WebGPU Core unavailable: ${attached.message}`);
    if (attached.value.fallback && !options.allowSoftware)
      throw new Error(`refused a software adapter (${attached.value.adapter})`);
    legacy ??= await vello.attachGpu(null, { compatibility: false });
    if (!legacy.ok) throw new Error(`vello_gpu device: ${legacy.message}`);
    for (const engine of [compute, vello]) {
      const applied = engine.apply(scene.list);
      if (!applied.ok) throw new Error(applied.message);
    }
    const on = compute.setComputeOrdinary(true);
    if (!on.ok) throw new Error(on.message);

    const fit = Math.min(CSS_W / scene.pageWidth, CSS_H / scene.pageHeight);
    const around = (center: number) =>
      Array.from(
        { length: frames },
        (_, i) => center * (1 + 0.22 * Math.sin((i / Math.max(1, frames - 1)) * Math.PI * 4)),
      );
    // Warm up: pipelines, the first encode, stroke outlines, glyphs.
    for (const zoom of [1, 1.01, fit]) {
      await drawChecked(
        compute,
        BENCH_WIDTH,
        BENCH_HEIGHT,
        cameraAt(scene.pageWidth, scene.pageHeight, zoom),
      );
      const warm = vello.renderGpu(
        BENCH_WIDTH,
        BENCH_HEIGHT,
        cameraAt(scene.pageWidth, scene.pageHeight, zoom),
        COMPUTE_BG,
        false,
      );
      if (!warm.ok) throw new Error(warm.message);
      await vello.gpuFinished();
    }

    const sweeps: SweepReport[] = [];
    options.onProgress?.("compute zoom at 100%");
    sweeps.push(
      await computeSweep(compute, "compute · zoom around 100%", around(1), scene, totals, signal),
    );
    options.onProgress?.("compute zoom around fit");
    sweeps.push(
      await computeSweep(compute, "compute · zoom around fit", around(fit), scene, totals, signal),
    );
    options.onProgress?.("compute zoom at 100%, through the bump gate");
    sweeps.push(
      await gatedSweep(
        compute,
        "compute gated · zoom around 100%",
        around(1),
        scene,
        totals,
        signal,
      ),
    );
    options.onProgress?.("compute zoom around fit, through the bump gate");
    sweeps.push(
      await gatedSweep(
        compute,
        "compute gated · zoom around fit",
        around(fit),
        scene,
        totals,
        signal,
      ),
    );
    const short = Math.min(frames, 60);
    options.onProgress?.("vello_gpu zoom (editor moving frames)");
    sweeps.push(
      await velloSweep(
        vello,
        "vello_gpu · zoom around 100%, moving frames",
        around(1).slice(0, short),
        scene,
        true,
        signal,
      ),
    );
    options.onProgress?.("vello_gpu zoom (whole exact frames)");
    sweeps.push(
      await velloSweep(
        vello,
        "vello_gpu · zoom around 100%, whole exact frames",
        around(1).slice(0, short),
        scene,
        false,
        signal,
      ),
    );

    const drawCompute = async (engine: RenderEngine, camera: Camera): Promise<Drawn> => {
      const frame = await drawChecked(engine, BENCH_WIDTH, BENCH_HEIGHT, camera);
      return { cpuMs: frame.cpuMs, waitMs: frame.checkMs };
    };
    const drawVello = async (engine: RenderEngine, camera: Camera): Promise<Drawn> => {
      const t0 = performance.now();
      const r = engine.renderGpu(BENCH_WIDTH, BENCH_HEIGHT, camera, COMPUTE_BG, true, 8, true);
      const cpuMs = performance.now() - t0;
      if (!r.ok) throw new Error(r.message);
      const t1 = performance.now();
      await engine.gpuFinished();
      return { cpuMs, waitMs: performance.now() - t1 };
    };
    const edits: EditReport[] = [];
    options.onProgress?.("edits and drags");
    edits.push(
      await editLoop(
        compute,
        "compute · recolour the centre card",
        "fill",
        12,
        scene,
        drawCompute,
        signal,
      ),
    );
    edits.push(
      await editLoop(
        vello,
        "vello_gpu · recolour the centre card",
        "fill",
        12,
        scene,
        drawVello,
        signal,
      ),
    );
    edits.push(
      await editLoop(
        compute,
        "compute · drag the centre card",
        "drag",
        30,
        scene,
        drawCompute,
        signal,
      ),
    );
    edits.push(
      await editLoop(
        vello,
        "vello_gpu · drag the centre card",
        "drag",
        30,
        scene,
        drawVello,
        signal,
      ),
    );

    // The same on a 40k-layer page: what an edit costs as the page grows.
    options.onProgress?.("edits on the 40k-layer page");
    const large = {
      ...buildOrdinaryScene(40, 40, Math.max(compute.revision, vello.revision) + 1),
      columns: 40,
      rows: 40,
    };
    for (const engine of [compute, vello]) {
      const applied = engine.apply(large.list);
      if (!applied.ok) throw new Error(applied.message);
    }
    const largeCamera = cameraAt(large.pageWidth, large.pageHeight, 1);
    await drawChecked(compute, BENCH_WIDTH, BENCH_HEIGHT, largeCamera);
    const warmLarge = vello.renderGpu(BENCH_WIDTH, BENCH_HEIGHT, largeCamera, COMPUTE_BG, false);
    if (!warmLarge.ok) throw new Error(warmLarge.message);
    await vello.gpuFinished();
    edits.push(
      await editLoop(
        compute,
        "compute · recolour the centre card, 40k layers",
        "fill",
        8,
        large,
        drawCompute,
        signal,
      ),
    );
    edits.push(
      await editLoop(
        vello,
        "vello_gpu · recolour the centre card, 40k layers",
        "fill",
        8,
        large,
        drawVello,
        signal,
      ),
    );
    edits.push(
      await editLoop(
        compute,
        "compute · drag the centre card, 40k layers",
        "drag",
        30,
        large,
        drawCompute,
        signal,
      ),
    );
    edits.push(
      await editLoop(
        vello,
        "vello_gpu · drag the centre card, 40k layers",
        "drag",
        30,
        large,
        drawVello,
        signal,
      ),
    );

    const last = takeStats(compute, totals);
    return {
      adapter: attached.value.adapter,
      software: attached.value.fallback,
      timestamps: last?.timestampsSupported ?? false,
      presentation,
      width: BENCH_WIDTH,
      height: BENCH_HEIGHT,
      layers: scene.layers,
      sweeps,
      edits,
      overflowChecks: totals.overflow,
      encodes: last?.encodes !== undefined ? { full: totals.full, patched: totals.patched } : null,
      fallback: compute.computeFallbackReason(),
      ms: Math.round(performance.now() - started),
    };
  } finally {
    compute.dispose();
    vello.dispose();
  }
}
