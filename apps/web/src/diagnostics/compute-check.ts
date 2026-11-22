/**
 * The opt-in compute path's correctness checks for `/diagnostics/renderer?compute=1` (decision
 * 0040, P1-0): the capacity matrix the PR #291 review asked for. Small, bench-sized and large
 * ordinary pages at 1x and 2x, each at 100%, 200% and fit, drawn by the compute pipeline and by
 * vello_gpu on separate devices and compared pixel for pixel. Every cell must be exact or fall
 * back to vello_gpu; none may show a wrong frame. A "tight" pass starts each cell with minimal
 * buffers so the grow-and-redraw path runs on every page.
 */
import { type Camera, type FrameStats, RenderEngine } from "@drawpane/engine";
import { loadBrowserEngine, loadComputeEngine } from "@drawpane/engine/browser";
import { CPU_GPU_TOLERANCE, outsideTolerance, score } from "@drawpane/engine/compare";
import { FLAG, ListWriter, ROOT } from "@drawpane/engine/wire";
import { buildOrdinaryScene } from "./compute-scene";

export const COMPUTE_BG = [0.95, 0.95, 0.93, 1] as const;

/** Draws of one frame the matrix allows before it counts the cell as falling back. */
const MATRIX_ATTEMPTS = 8;

export interface CheckedFrame {
  readonly stats: FrameStats;
  readonly backend: "compute" | "vello_gpu";
  /** Compute draws staged for this frame (more than one: a buffer grew and it drew again). */
  readonly attempts: number;
  /** Main-thread time of every engine call the frame took (staging, showing, any fallback). */
  readonly cpuMs: number;
  /** The parts of `cpuMs`: `stageComputeFrame`, `finishComputeFrame`, and a vello_gpu frame. */
  readonly stageMs: number;
  readonly finishMs: number;
  readonly fallbackMs: number;
  /** Time waiting for the GPU check, off the main thread. */
  readonly checkMs: number;
  /** Why compute is off for the session, when it fell back. */
  readonly fallback: string | null;
}

/**
 * One frame the way the editor draws it with `?compute=1`: staged, checked, redrawn while a
 * buffer grows, shown only once clean; otherwise drawn by vello_gpu.
 */
export async function drawChecked(
  engine: RenderEngine,
  width: number,
  height: number,
  camera: Camera,
  maxAttempts = 4,
): Promise<CheckedFrame> {
  let stageMs = 0;
  let finishMs = 0;
  let checkMs = 0;
  let attempts = 0;
  while (attempts < maxAttempts) {
    let t = performance.now();
    const staged = engine.stageComputeFrame(width, height, camera, COMPUTE_BG);
    stageMs += performance.now() - t;
    if (!staged.ok) throw new Error(staged.message);
    if (!staged.value) break;
    attempts++;
    t = performance.now();
    const checked = await staged.value;
    checkMs += performance.now() - t;
    if (!checked) throw new Error("the compute check was interrupted");
    t = performance.now();
    const finished = engine.finishComputeFrame(attempts >= maxAttempts);
    finishMs += performance.now() - t;
    if (!finished.ok) throw new Error(finished.message);
    const value = finished.value;
    if (value === "fallback") break;
    if (value === "retry" || value === "stale") continue;
    return {
      stats: value,
      backend: "compute",
      attempts,
      cpuMs: stageMs + finishMs,
      stageMs,
      finishMs,
      fallbackMs: 0,
      checkMs,
      fallback: null,
    };
  }
  const t = performance.now();
  const drawn = engine.renderGpu(width, height, camera, COMPUTE_BG, false);
  const fallbackMs = performance.now() - t;
  if (!drawn.ok) throw new Error(drawn.message);
  return {
    stats: drawn.value,
    backend: "vello_gpu",
    attempts,
    cpuMs: stageMs + finishMs + fallbackMs,
    stageMs,
    finishMs,
    fallbackMs,
    checkMs,
    fallback: engine.computeFallbackReason(),
  };
}

export interface MatrixCell {
  readonly page: string;
  readonly layers: number;
  readonly tight: boolean;
  readonly dpr: number;
  readonly zoom: string;
  readonly backend: "compute" | "vello_gpu";
  readonly attempts: number;
  readonly fallback: string | null;
  /** Exact against vello_gpu (or fell back to it), and shown. */
  readonly ok: boolean;
  readonly mean: number;
  readonly p99: number;
  readonly max: number;
  readonly worstTile: number;
  readonly severeInTile: number;
  readonly violations: readonly string[];
}

export interface MatrixReport {
  readonly adapter: string;
  readonly software: boolean;
  readonly cells: readonly MatrixCell[];
  /** The cells the run planned, which progress counts toward: `cells` ends at this length. */
  readonly planned: number;
  /** Checks that found an overflow (each one redrew; none was shown). */
  readonly overflowChecks: number;
  readonly ms: number;
}

const PAGES = [
  { page: "small", columns: 6, rows: 6 },
  { page: "bench", columns: 20, rows: 20 },
  { page: "large", columns: 40, rows: 40 },
] as const;

const CSS_WIDTH = 1440;
const CSS_HEIGHT = 900;

export async function runComputeMatrix(options: {
  readonly allowSoftware: boolean;
  readonly signal: AbortSignal;
  readonly onCell?: (cell: MatrixCell, done: number, total: number) => void;
}): Promise<MatrixReport> {
  const started = performance.now();
  const [computeModule, legacyModule] = await Promise.all([
    loadComputeEngine(),
    loadBrowserEngine(),
  ]);
  const cells: MatrixCell[] = [];
  // Every cell the run adds, so progress counts toward the real end: the page cells, the bump
  // gate, the floor reset, then the drag steps.
  const total = PAGES.length * 2 * (3 + 2) + GATE_CELLS + 1 + DRAG_CELLS;
  let adapter = "";
  let software = false;
  let overflowChecks = 0;
  for (const spec of PAGES) {
    options.signal.throwIfAborted();
    const scene = buildOrdinaryScene(spec.columns, spec.rows);
    // Separate devices, fresh per page: one page's grown buffers or fallback can't hide another's.
    const reference = new RenderEngine(legacyModule);
    const candidate = new RenderEngine(computeModule);
    try {
      const [refGpu, gpu] = await Promise.all([
        reference.attachGpu(null, { compatibility: false }),
        candidate.attachGpu(null, { compatibility: false }),
      ]);
      if (!refGpu.ok) throw new Error(`vello_gpu device: ${refGpu.message}`);
      if (!gpu.ok) throw new Error(`compute device: ${gpu.message}`);
      adapter = gpu.value.adapter;
      software = gpu.value.fallback;
      if (software && !options.allowSoftware) throw new Error("only a software GPU is available");
      for (const engine of [reference, candidate]) {
        const applied = engine.apply(scene.list);
        if (!applied.ok) throw new Error(applied.message);
      }
      const on = candidate.setComputeOrdinary(true);
      if (!on.ok) throw new Error(on.message);
      const fit = Math.min(CSS_WIDTH / scene.pageWidth, CSS_HEIGHT / scene.pageHeight);
      const views = [
        { zoom: "100%", scale: 1, tight: false },
        { zoom: "200%", scale: 2, tight: false },
        { zoom: "fit", scale: fit, tight: false },
        { zoom: "100%", scale: 1, tight: true },
        { zoom: "fit", scale: fit, tight: true },
      ];
      for (const dpr of [1, 2]) {
        for (const view of views) {
          options.signal.throwIfAborted();
          const width = CSS_WIDTH * dpr;
          const height = CSS_HEIGHT * dpr;
          const camera: Camera = {
            zoom: view.scale,
            x: (CSS_WIDTH - scene.pageWidth * view.scale) / 2,
            y: view.zoom === "fit" ? (CSS_HEIGHT - scene.pageHeight * view.scale) / 2 : 0,
            dpr,
          };
          const expected = reference.renderGpu(width, height, camera, COMPUTE_BG, false);
          if (!expected.ok) throw new Error(`vello_gpu frame: ${expected.message}`);
          const ours = view.tight ? candidate.computeTight(true) : candidate.computeTight(false);
          if (!ours.ok) throw new Error(ours.message);
          const frame = await drawChecked(candidate, width, height, camera, MATRIX_ATTEMPTS);
          const [want, got] = await Promise.all([reference.gpuPixels(), candidate.gpuPixels()]);
          if (!want.ok) throw new Error(`vello_gpu pixels: ${want.message}`);
          if (!got.ok) throw new Error(`compute pixels: ${got.message}`);
          const s = score(got.value, want.value, width, height);
          const violations = outsideTolerance(s, CPU_GPU_TOLERANCE);
          if (!frame.stats.exact) violations.push("the frame shown was not exact");
          if (!frame.stats.presented) violations.push("the frame was not shown");
          const cell: MatrixCell = {
            page: spec.page,
            layers: scene.layers,
            tight: view.tight,
            dpr,
            zoom: view.zoom,
            backend: frame.backend,
            attempts: frame.attempts,
            fallback: frame.fallback,
            ok: violations.length === 0,
            mean: Number(s.mean.toFixed(4)),
            p99: s.p99,
            max: s.max,
            worstTile: Number(s.worstTile.toFixed(3)),
            severeInTile: s.severeInTile,
            violations,
          };
          cells.push(cell);
          options.onCell?.(cell, cells.length, total);
        }
      }
      const stats = candidate.computeStats();
      if (stats.ok) overflowChecks += stats.value.failedFrames;
    } finally {
      candidate.dispose();
      reference.dispose();
    }
  }
  options.signal.throwIfAborted();
  for (const cell of await checkGate(computeModule, legacyModule, options.allowSoftware)) {
    cells.push(cell);
    options.onCell?.(cell, cells.length, total);
  }
  options.signal.throwIfAborted();
  const floor = await checkFloorReset(computeModule, options.allowSoftware);
  cells.push(floor);
  options.onCell?.(floor, cells.length, total);
  options.signal.throwIfAborted();
  for (const cell of await runDragChecks(
    computeModule,
    legacyModule,
    options.allowSoftware,
    options.signal,
  )) {
    cells.push(cell);
    options.onCell?.(cell, cells.length, total);
  }
  return {
    adapter,
    software,
    cells,
    planned: total,
    overflowChecks,
    ms: Math.round(performance.now() - started),
  };
}

type Module = Awaited<ReturnType<typeof loadBrowserEngine>>;
type Patch = (w: ListWriter) => void;

/** Cells `checkGate` adds to the matrix. */
const GATE_CELLS = 4;

/** Cells `runDragChecks` adds to the matrix: one per drag step of each scene. */
const DRAG_CELLS = 4 + 2 + 3;

function rect(
  id: number,
  parent: number,
  x: number,
  y: number,
  side: number,
  color: readonly [number, number, number, number],
) {
  return {
    id,
    parent,
    record: {
      flags: 0,
      opacity: 1,
      transform: [1, 0, 0, 1, x, y] as [number, number, number, number, number, number],
      width: side,
      height: side,
      coarseBelow: 0,
      reach: 0,
      unsupported: 0,
      paths: [
        {
          kind: "rect" as const,
          w: side,
          h: side,
          radii: [0, 0, 0, 0] as [number, number, number, number],
          smoothing: 0,
        },
      ],
      ops: [
        { op: "fill" as const, path: 0, evenOdd: false, paint: { kind: "solid" as const, color } },
      ],
      coarse: [],
    },
  };
}

function group(id: number, x: number, y: number, opacity: number, isolate: boolean) {
  return {
    flags: FLAG.group | (isolate ? FLAG.isolate : 0),
    opacity,
    transform: [1, 0, 0, 1, x, y] as [number, number, number, number, number, number],
    width: 0,
    height: 0,
    coarseBelow: 0,
    reach: 0,
    unsupported: 0,
    paths: [],
    ops: [{ op: "children" as const }],
    coarse: [],
    id,
  };
}

/**
 * Drags on compute, step by step, each step's patch sent to both engines and compute's frame
 * compared with a fresh vello_gpu one (PR #300 review: a one-child group's shared span and an
 * isolated group's fixed layer rect both showed wrong pixels as exact). Moves compute can't
 * patch in place must re-encode and still match.
 */
async function runDragChecks(
  computeModule: Module,
  legacyModule: Module,
  allowSoftware: boolean,
  signal: AbortSignal,
): Promise<MatrixCell[]> {
  const W = 800;
  const H = 600;
  const camera: Camera = { zoom: 1, x: 0, y: 0, dpr: 1 };
  const translate = (dx: number, dy: number, x: number, y: number) =>
    [1, 0, 0, 1, x + dx, y + dy] as [number, number, number, number, number, number];
  const scenes: Array<{ name: string; build: (w: ListWriter) => void; steps: Patch[] }> = [
    {
      name: "drag in a one-child group",
      build: (w) => {
        const g = group(10, 100, 50, 1, false);
        w.set(10, ROOT, g);
        const r = rect(11, 10, 10, 20, 60, [0.9, 0.1, 0.1, 1]);
        w.set(r.id, r.parent, r.record);
        w.order(10, [11]);
        w.order(ROOT, [10]);
      },
      steps: [1, 2, 3, 4].map(
        (k) => (w: ListWriter) => w.transform(11, translate(25 * k, 0, 10, 20)),
      ),
    },
    {
      name: "drag out of an isolated group",
      build: (w) => {
        w.set(10, ROOT, group(10, 0, 0, 0.6, true));
        for (const r of [
          rect(11, 10, 40, 40, 40, [0.1, 0.4, 0.9, 1]),
          rect(12, 10, 50, 40, 40, [0.1, 0.6, 0.3, 1]),
        ]) {
          w.set(r.id, r.parent, r.record);
        }
        w.order(10, [11, 12]);
        w.order(ROOT, [10]);
      },
      steps: [220, 260].map((dx) => (w: ListWriter) => w.transform(11, translate(dx, 0, 40, 40))),
    },
    {
      name: "drag three cards",
      build: () => {},
      steps: [1, 2, 3].map((k) => (w: ListWriter) => {
        for (const id of [1, 26, 51])
          w.transform(id, translate(9 * k, 5 * k, 32 + ((id - 1) / 25) * 344, 32));
      }),
    },
  ];
  const cells: MatrixCell[] = [];
  for (const scene of scenes) {
    signal.throwIfAborted();
    const reference = new RenderEngine(legacyModule);
    const candidate = new RenderEngine(computeModule);
    try {
      const [refGpu, gpu] = await Promise.all([
        reference.attachGpu(null, { compatibility: false }),
        candidate.attachGpu(null, { compatibility: false }),
      ]);
      if (!refGpu.ok) throw new Error(`vello_gpu device: ${refGpu.message}`);
      if (!gpu.ok) throw new Error(`compute device: ${gpu.message}`);
      if (gpu.value.fallback && !allowSoftware) throw new Error("only a software GPU is available");
      let list: Uint8Array;
      if (scene.name === "drag three cards") {
        list = buildOrdinaryScene(6, 6).list;
      } else {
        const w = new ListWriter(0xffffffff, 1);
        w.reset();
        scene.build(w);
        list = w.finish();
      }
      for (const engine of [reference, candidate]) {
        const applied = engine.apply(list);
        if (!applied.ok) throw new Error(applied.message);
      }
      const on = candidate.setComputeOrdinary(true);
      if (!on.ok) throw new Error(on.message);
      // The first frame encodes the page; every later one is a patch.
      await drawChecked(candidate, W, H, camera, MATRIX_ATTEMPTS);
      for (const [k, step] of scene.steps.entries()) {
        for (const engine of [reference, candidate]) {
          const w = new ListWriter(engine.revision, engine.revision + 1);
          step(w);
          const applied = engine.apply(w.finish());
          if (!applied.ok) throw new Error(applied.message);
        }
        const expected = reference.renderGpu(W, H, camera, COMPUTE_BG, false);
        if (!expected.ok) throw new Error(`vello_gpu frame: ${expected.message}`);
        const frame = await drawChecked(candidate, W, H, camera, MATRIX_ATTEMPTS);
        const [want, got] = await Promise.all([reference.gpuPixels(), candidate.gpuPixels()]);
        if (!want.ok) throw new Error(`vello_gpu pixels: ${want.message}`);
        if (!got.ok) throw new Error(`compute pixels: ${got.message}`);
        const s = score(got.value, want.value, W, H);
        const violations = outsideTolerance(s, CPU_GPU_TOLERANCE);
        if (!frame.stats.exact) violations.push("the frame shown was not exact");
        cells.push({
          page: scene.name,
          layers: 0,
          tight: false,
          dpr: 1,
          zoom: `step ${k + 1}`,
          backend: frame.backend,
          attempts: frame.attempts,
          fallback: frame.fallback,
          ok: violations.length === 0,
          mean: Number(s.mean.toFixed(4)),
          p99: s.p99,
          max: s.max,
          worstTile: Number(s.worstTile.toFixed(3)),
          severeInTile: s.severeInTile,
          violations,
        });
      }
    } finally {
      candidate.dispose();
      reference.dispose();
    }
  }
  return cells;
}

/**
 * What one page's frames needed must not carry over to the next (the stack review: after a 40k
 * page overflowed, a small page kept ~193 MiB of buffers). One engine grows on the large page
 * from minimal buffers, then loads a small page as a fresh list; its capacities there must be a
 * fresh engine's.
 */
async function checkFloorReset(
  computeModule: Awaited<ReturnType<typeof loadComputeEngine>>,
  allowSoftware: boolean,
): Promise<MatrixCell> {
  const small = buildOrdinaryScene(6, 6);
  const camera: Camera = { zoom: 1, x: 0, y: 0, dpr: 1 };
  const capacitiesAfter = async (pages: readonly Uint8Array[]) => {
    const engine = new RenderEngine(computeModule);
    try {
      const gpu = await engine.attachGpu(null, { compatibility: false });
      if (!gpu.ok) throw new Error(`compute device: ${gpu.message}`);
      if (gpu.value.fallback && !allowSoftware) throw new Error("only a software GPU is available");
      const on = engine.setComputeOrdinary(true);
      if (!on.ok) throw new Error(on.message);
      const tight = engine.computeTight(true);
      if (!tight.ok) throw new Error(tight.message);
      let frame: CheckedFrame | null = null;
      for (const [k, list] of pages.entries()) {
        const copy = new Uint8Array(list);
        // A fresh list moves the revision on.
        new DataView(copy.buffer).setUint32(12, engine.revision + 1 + k, true);
        const applied = engine.apply(copy);
        if (!applied.ok) throw new Error(applied.message);
        frame = await drawChecked(engine, CSS_WIDTH, CSS_HEIGHT, camera, MATRIX_ATTEMPTS);
      }
      const stats = engine.computeStats();
      if (!stats.ok) throw new Error(stats.message);
      return { frame, capacities: stats.value.capacities };
    } finally {
      engine.dispose();
    }
  };
  const fresh = await capacitiesAfter([small.list]);
  const after = await capacitiesAfter([buildOrdinaryScene(40, 40).list, small.list]);
  const violations: string[] = [];
  if (JSON.stringify(after.capacities) !== JSON.stringify(fresh.capacities))
    violations.push(
      `capacities after the 40k page ${JSON.stringify(after.capacities)}, fresh ${JSON.stringify(fresh.capacities)}`,
    );
  if (after.frame?.backend !== "compute") violations.push("the small page fell back");
  return {
    page: "small page after a 40k one",
    layers: small.layers,
    tight: true,
    dpr: 1,
    zoom: "100%",
    backend: after.frame?.backend ?? "vello_gpu",
    attempts: after.frame?.attempts ?? 0,
    fallback: after.frame?.fallback ?? null,
    ok: violations.length === 0,
    mean: 0,
    p99: 0,
    max: 0,
    worstTile: 0,
    severeInTile: 0,
    violations,
  };
}

/**
 * The bump gate (decision 0040, P1-0): a gated frame that overflows must leave the frame on
 * screen exactly as it was (nothing overflowed shows), and once the buffers grew, the gated
 * frame must be exact. Tight buffers make the fit view overflow after a 100% one. Then two
 * cells the stack review's re-check asked for: a vello_gpu frame drawn over a gated one whose
 * check is in flight must not be reported exact or redrawn when that check lands, and past
 * `GATES_IN_FLIGHT` checks the gate draws nothing rather than drop one.
 */
async function checkGate(
  computeModule: Awaited<ReturnType<typeof loadComputeEngine>>,
  legacyModule: Awaited<ReturnType<typeof loadBrowserEngine>>,
  allowSoftware: boolean,
): Promise<MatrixCell[]> {
  const scene = buildOrdinaryScene(20, 20);
  const W = CSS_WIDTH;
  const H = CSS_HEIGHT;
  const fit = Math.min(W / scene.pageWidth, H / scene.pageHeight);
  const at = (zoom: number): Camera => ({
    zoom,
    x: (W - scene.pageWidth * zoom) / 2,
    y: (H - scene.pageHeight * zoom) / 2,
    dpr: 1,
  });
  const reference = new RenderEngine(legacyModule);
  const candidate = new RenderEngine(computeModule);
  const cell = (
    zoom: string,
    violations: string[],
    attempts: number,
    s?: ReturnType<typeof score>,
  ): MatrixCell => ({
    page: "bump gate",
    layers: scene.layers,
    tight: true,
    dpr: 1,
    zoom,
    backend: "compute",
    attempts,
    fallback: candidate.computeFallbackReason(),
    ok: violations.length === 0,
    mean: s ? Number(s.mean.toFixed(4)) : 0,
    p99: s?.p99 ?? 0,
    max: s?.max ?? 0,
    worstTile: s ? Number(s.worstTile.toFixed(3)) : 0,
    severeInTile: s?.severeInTile ?? 0,
    violations,
  });
  try {
    const [refGpu, gpu] = await Promise.all([
      reference.attachGpu(null, { compatibility: false }),
      candidate.attachGpu(null, { compatibility: false }),
    ]);
    if (!refGpu.ok) throw new Error(`vello_gpu device: ${refGpu.message}`);
    if (!gpu.ok) throw new Error(`compute device: ${gpu.message}`);
    if (gpu.value.fallback && !allowSoftware) throw new Error("only a software GPU is available");
    for (const engine of [reference, candidate]) {
      const applied = engine.apply(scene.list);
      if (!applied.ok) throw new Error(applied.message);
    }
    for (const r of [candidate.setComputeOrdinary(true), candidate.computeTight(true)]) {
      if (!r.ok) throw new Error(r.message);
    }
    // A checked frame at 100% to keep.
    await drawChecked(candidate, W, H, at(1), MATRIX_ATTEMPTS);
    const kept = await candidate.gpuPixels();
    if (!kept.ok) throw new Error(kept.message);
    const before = new Uint8Array(kept.value);
    // The fit view needs far more than 100% grew to: the first gated draws overflow.
    let overflowed = 0;
    let keptViolations: string[] | null = null;
    let verified = false;
    let draws = 0;
    for (; draws < MATRIX_ATTEMPTS && !verified; draws++) {
      const presented = candidate.presentComputeFrame(W, H, at(fit), COMPUTE_BG);
      if (!presented.ok) throw new Error(presented.message);
      if (!presented.value || presented.value === "busy")
        throw new Error("the gated path didn't draw");
      if (!(await presented.value.check)) throw new Error("the gate check was interrupted");
      const verdict = candidate.finishComputeGate();
      if (verdict === "redraw") {
        overflowed++;
        if (keptViolations === null) {
          const shown = await candidate.gpuPixels();
          if (!shown.ok) throw new Error(shown.message);
          const s = score(shown.value, before, W, H);
          keptViolations =
            s.max === 0 ? [] : [`the overflowed frame changed the screen (max ${s.max})`];
        }
      } else if (verdict === "verified") {
        verified = true;
      } else {
        throw new Error(`the gate check said ${verdict}`);
      }
    }
    const expected = reference.renderGpu(W, H, at(fit), COMPUTE_BG, false);
    if (!expected.ok) throw new Error(expected.message);
    const [want, got] = await Promise.all([reference.gpuPixels(), candidate.gpuPixels()]);
    if (!want.ok) throw new Error(want.message);
    if (!got.ok) throw new Error(got.message);
    const s = score(got.value, want.value, W, H);
    const exactViolations = outsideTolerance(s, CPU_GPU_TOLERANCE);
    if (!verified) exactViolations.push(`not verified after ${draws} gated draws`);

    // A vello_gpu frame over a gated one: the gated check lands after, and must neither report
    // the canvas exact nor ask for a redraw (the canvas shows vello_gpu's frame).
    const overViolations: string[] = [];
    const under = candidate.presentComputeFrame(W, H, at(1), COMPUTE_BG);
    if (!under.ok) throw new Error(under.message);
    if (!under.value || under.value === "busy") throw new Error("the gated path didn't draw");
    const over = candidate.renderGpu(W, H, at(1), COMPUTE_BG, false);
    if (!over.ok) throw new Error(over.message);
    await under.value.check;
    const afterVello = candidate.finishComputeGate();
    if (afterVello !== "pending")
      overViolations.push(`the gated check said ${afterVello} after a vello_gpu frame`);

    // Back-pressure: present until the engine refuses, without letting a check land.
    const busyViolations: string[] = [];
    const before0 = candidate.computeStats();
    if (!before0.ok) throw new Error(before0.message);
    const inFlight: Array<Promise<boolean>> = [];
    let refused = false;
    for (let i = 0; i < 12 && !refused; i++) {
      const r = candidate.presentComputeFrame(W, H, at(1), COMPUTE_BG);
      if (!r.ok) throw new Error(r.message);
      if (r.value === "busy") refused = true;
      else if (r.value) inFlight.push(r.value.check);
      else throw new Error("the gated path didn't draw");
    }
    await Promise.all(inFlight);
    candidate.finishComputeGate();
    const after0 = candidate.computeStats();
    if (!after0.ok) throw new Error(after0.message);
    const checked = after0.value.framesChecked - before0.value.framesChecked;
    if (!refused) busyViolations.push(`${inFlight.length} checks in flight and none refused`);
    if (checked !== inFlight.length)
      busyViolations.push(`${inFlight.length} gated frames presented, ${checked} checked`);
    return [
      cell(
        "overflow keeps the last good frame",
        overflowed === 0
          ? ["no gated draw overflowed, so the gate wasn't exercised"]
          : (keptViolations ?? []),
        overflowed,
      ),
      cell("exact after growing", exactViolations, draws, s),
      cell("a vello_gpu frame over a gated one", overViolations, 1),
      cell("checks in flight are never dropped", busyViolations, inFlight.length),
    ];
  } finally {
    candidate.dispose();
    reference.dispose();
  }
}
