/**
 * Measuring the canvas while it moves: panning and zooming for a number of
 * animation frames through the editor's debug handle (`drawpane:debug`), and
 * what drawing them took (`drawpaneFrames`). Shared by the benchmarks.
 */
import type { Page } from "@playwright/test";
import type { MotionStats } from "../../src/editor/frame-stats";

export interface CpuSplitSummary {
  readonly frames: number;
  readonly patchMs: number;
  readonly encodeMs: number;
  readonly prepareMasksMs: number;
  readonly velloRenderMs: number;
  readonly readerMs: number;
  readonly shadowMs: number;
  readonly renderMs: number;
  readonly submitMs: number;
  readonly totalMs: number;
  readonly submits: number;
  readonly draws: number;
  readonly velloRenders: number;
  readonly glassOps: number;
  readonly glassBatched: number;
  readonly bgBlurOps: number;
  readonly shadowOps: number;
  readonly shadowHits: number;
}

export interface Summary {
  frames: number;
  motion?: MotionStats;
  presentedInterval?: Summary["interval"];
  /** Time between animation frames: what you'd see, painting included (16.7 ms at 60 Hz). */
  interval?: { p50: number; p95: number; p99: number; max: number };
  content: { p50: number; p95: number; p99?: number; max: number };
  overlay: { p50: number; p95: number; p99?: number; max: number };
  drawn: number;
  culled: number;
  /** Ms from the last frame of the movement until the canvas showed an exact frame (null: never, within 10 s). */
  exactMs?: number | null;
  /** Longest browser main-thread long task (ms) observed during the gesture + settle window. */
  longTaskMaxMs?: number;
  /**
   * The render engine only: ms until it drew an exact frame (before a read-back shows it, in
   * headless browsers), and its slowest frame of the movement (ms, how it was made, tiles drawn).
   */
  engine?: {
    exactMs: number | null;
    worst: { ms: number; plan: string; tiles: number };
    settle?: Settle;
    split?: CpuSplitSummary;
    readbackDiag?: unknown;
  };
}

/**
 * The engine only: how it got from the movement's last frame to an exact one. Frames drawn (their
 * tiles and ms), and what it drew between frames (slices, tiles, ms).
 */
export interface Settle {
  frames: number;
  frameTiles: number;
  frameMs: number;
  idleSlices: number;
  idleTiles: number;
  idleMs: number;
  idleMaxSliceMs?: number;
  /** Each frame (f) and slice between frames (i): ms after the movement, its ms, tiles, pending. */
  trace?: string;
}

/** Pans for `frames` animation frames and returns what drawing them took. */
export function pan(page: Page, zoom: number | "fit", frames: number): Promise<Summary> {
  return move(page, "pan", zoom, frames);
}

/** Zooms in and out about the centre for `frames` frames, from the whole file. */
export function zoom(page: Page, frames: number): Promise<Summary> {
  return move(page, "zoom", "fit", frames);
}

async function move(
  page: Page,
  kind: "pan" | "zoom",
  zoom: number | "fit",
  frames: number,
): Promise<Summary> {
  return page.evaluate(
    async ({ kind, zoom, frames, instrument, native }) => {
      type Camera = {
        zoom: number;
        pan(dx: number, dy: number): Camera;
        zoomAt(screen: { x: number; y: number }, zoom: number): Camera;
      };
      const w = window as unknown as {
        drawpane: {
          s: { camera: Camera; viewport: { width: number; height: number } };
          state: { set(patch: { camera: Camera }): void };
          zoomToFit(): void;
          zoomTo(z: number): void;
        };
        drawpaneFrames: {
          reset(): void;
          summary(): Summary;
          beginMotion?(native: boolean): MotionStats;
          endMotion?(): void;
        };
      };
      const e = w.drawpane;
      if (zoom === "fit") e.zoomToFit();
      else e.zoomTo(zoom);
      const intervals = (times: number[]) => {
        const gaps = times
          .slice(1)
          .map((t, i) => t - (times[i] as number))
          .sort((a, b) => a - b);
        const at = (q: number) =>
          Math.round((gaps[Math.floor(q * (gaps.length - 1))] ?? 0) * 10) / 10;
        return { p50: at(0.5), p95: at(0.95), p99: at(0.99), max: at(1) };
      };
      const nextFrame = () => new Promise<number>((r) => requestAnimationFrame(r));
      type Breakdown = {
        patch: number;
        encode: number;
        render: number;
        submit: number;
        readback: number;
        prepareMasks: number;
        velloRender: number;
        reader: number;
        shadow: number;
      };
      type Counts = {
        submits: number;
        draws: number;
        velloRenders: number;
        glassOps: number;
        glassBatched: number;
        bgBlurOps: number;
        shadowOps: number;
        shadowHits: number;
      };
      type View = {
        readonly readsBack?: boolean;
        readonly reading?: boolean;
        readonly shown?: { readonly n: number; readonly at: number };
        last: {
          n: number;
          exact: boolean;
          ms: number;
          plan: string;
          tiles: { drawn: number };
          breakdown: Breakdown;
          counts: Counts;
        };
        idle: { slices: number; tiles: number; ms: number; maxSliceMs?: number };
        readbackDiag?: unknown;
        resetReadbackDiag?(): void;
        trace: Array<{
          t: number;
          k: string;
          ms: number;
          tiles: number;
          pending: number;
          encode: number;
          render: number;
          misses: number;
          records: number;
          masked: number;
          outlined: number;
        }> | null;
      };
      const view = () => (window as unknown as { drawpaneEngineView?: View }).drawpaneEngineView;
      let worst = { ms: 0, plan: "", tiles: 0 };
      const splitSamples: Array<{ ms: number; breakdown: Breakdown; counts: Counts }> = [];
      let lastWatchedN = -1;
      const watch = () => {
        const l = view()?.last;
        if (!l) return;
        if (l.ms > worst.ms)
          worst = { ms: Math.round(l.ms * 10) / 10, plan: l.plan, tiles: l.tiles.drawn };
        if (l.n !== lastWatchedN) {
          lastWatchedN = l.n;
          splitSamples.push({
            ms: l.ms,
            breakdown: { ...l.breakdown },
            counts: { ...l.counts },
          });
        }
      };
      const medianOf = (xs: number[]) => {
        if (xs.length === 0) return 0;
        const s = [...xs].sort((a, b) => a - b);
        return Math.round((s[Math.floor(0.5 * (s.length - 1))] ?? 0) * 10) / 10;
      };
      const summarizeSplit = () =>
        splitSamples.length === 0
          ? undefined
          : {
              frames: splitSamples.length,
              patchMs: medianOf(splitSamples.map((s) => s.breakdown.patch)),
              encodeMs: medianOf(splitSamples.map((s) => s.breakdown.encode)),
              prepareMasksMs: medianOf(splitSamples.map((s) => s.breakdown.prepareMasks)),
              velloRenderMs: medianOf(splitSamples.map((s) => s.breakdown.velloRender)),
              readerMs: medianOf(splitSamples.map((s) => s.breakdown.reader)),
              shadowMs: medianOf(splitSamples.map((s) => s.breakdown.shadow)),
              renderMs: medianOf(splitSamples.map((s) => s.breakdown.render)),
              submitMs: medianOf(splitSamples.map((s) => s.breakdown.submit)),
              totalMs: medianOf(splitSamples.map((s) => s.ms)),
              submits: medianOf(splitSamples.map((s) => s.counts.submits)),
              draws: medianOf(splitSamples.map((s) => s.counts.draws ?? 0)),
              velloRenders: medianOf(splitSamples.map((s) => s.counts.velloRenders)),
              glassOps: medianOf(splitSamples.map((s) => s.counts.glassOps)),
              glassBatched: medianOf(splitSamples.map((s) => s.counts.glassBatched)),
              bgBlurOps: medianOf(splitSamples.map((s) => s.counts.bgBlurOps)),
              shadowOps: medianOf(splitSamples.map((s) => s.counts.shadowOps)),
              shadowHits: medianOf(splitSamples.map((s) => s.counts.shadowHits)),
            };
      const exactAfter = async (since: number) => {
        const f = (window as unknown as { drawpaneFrames: { exact: boolean } }).drawpaneFrames;
        const limitMs = view()?.readsBack ? 25_000 : 10_000;
        let drawn = view()?.last.exact ? 0 : -1;
        const idle0 = view()?.idle;
        const traced = view();
        if (traced) traced.trace = [];
        let seen = view()?.last;
        const settle = {
          frames: 0,
          frameTiles: 0,
          frameMs: 0,
          idleSlices: 0,
          idleTiles: 0,
          idleMs: 0,
        };
        const tally = () => {
          const v = view();
          if (!v || drawn >= 0) return;
          if (v.last !== seen) {
            seen = v.last;
            settle.frames++;
            settle.frameTiles += v.last.tiles.drawn;
            settle.frameMs += v.last.ms;
          }
          if (idle0) {
            settle.idleSlices = v.idle.slices - idle0.slices;
            settle.idleTiles = v.idle.tiles - idle0.tiles;
            settle.idleMs = Math.round((v.idle.ms - idle0.ms) * 10) / 10;
          }
          if (v.last.exact) drawn = Math.max(0, performance.now() - since);
        };
        if (!f.exact) {
          await nextFrame();
          while (!f.exact && performance.now() - since < limitMs) {
            tally();
            await nextFrame();
          }
        }
        tally();
        settle.frameMs = Math.round(settle.frameMs * 10) / 10;
        const shownAt = view()?.shown?.at;
        const shown = Math.max(
          0,
          Math.round((shownAt && shownAt >= since ? shownAt : performance.now()) - since),
        );
        const traceEntries = traced?.trace ?? [];
        const idleMaxSliceMs =
          Math.round(
            traceEntries.filter((e) => e.k === "idle").reduce((m, e) => Math.max(m, e.ms), 0) * 10,
          ) / 10;
        const trace = traceEntries
          .map(
            (e) =>
              `${e.k === "frame" ? "f" : e.k === "present" ? "p" : e.k === "text" ? "t" : "i"}${Math.round(e.t - since)}:${Math.round(e.ms)}(${Math.round(e.encode)}+${Math.round(e.render)})/${e.tiles}/${e.pending}/m${e.misses}/r${e.records}/g${e.masked}+${e.outlined}`,
          )
          .join(" ");
        if (traced) traced.trace = null;
        // A wait that ran out is reported as such, never as the time it waited.
        const timedOut = !f.exact;
        return {
          shown: timedOut ? null : shown,
          drawn: drawn < 0 ? null : Math.round(drawn),
          settle: { ...settle, idleMaxSliceMs, trace },
        };
      };
      const waitReadback = async (targetN: number | null, timeoutMs: number) => {
        const start = performance.now();
        while (performance.now() - start < timeoutMs) {
          const v = view();
          if (!v?.readsBack) break;
          const shownN = v.shown?.n ?? 0;
          const done = targetN === null ? !v.reading && shownN >= v.last.n : shownN >= targetN;
          if (done) break;
          await nextFrame();
        }
      };
      await nextFrame();
      await nextFrame();
      // In read-back mode (headless WebGPU), let any pre-motion read-back finish before
      // beginMotion() so frame 0 of the gesture starts with a free read-back slot.
      if (view()?.readsBack) {
        await waitReadback(null, 25_000);
      }
      w.drawpaneFrames.reset();
      view()?.resetReadbackDiag?.();
      let longTaskMaxMs = 0;
      let longTaskObserver: PerformanceObserver | null = null;
      try {
        longTaskObserver = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (entry.duration > longTaskMaxMs) longTaskMaxMs = entry.duration;
          }
        });
        longTaskObserver.observe({ entryTypes: ["longtask"] });
      } catch {
        // Long Tasks API unsupported in this browser.
      }
      const motion = instrument && view() ? w.drawpaneFrames.beginMotion?.(native) : undefined;
      const centre = { x: e.s.viewport.width / 2, y: e.s.viewport.height / 2 };
      const times: number[] = [];
      for (let i = 0; i < frames; i++) {
        const forward = i % 120 < 60;
        const submitted = motion?.submitted;
        const camera = e.s.camera;
        const next =
          kind === "zoom"
            ? camera.zoomAt(centre, camera.zoom * (forward ? 1.03 : 1 / 1.03))
            : camera.pan(forward ? 6 : -6, forward ? 3 : -3);
        e.state.set({ camera: next });
        times.push(await nextFrame());
        if (motion && motion.submitted === submitted) motion.missed++;
        watch();
        // Whole-view WebGPU uses a single readback slot. Pace this native benchmark
        // by presentation so each request can finish before the next expensive draw.
        const drawn = view();
        if (native && motion && motion.submitted !== submitted && drawn?.readsBack) {
          await waitReadback(drawn.last.n, 30_000);
        }
      }
      const summary = w.drawpaneFrames.summary();
      const moveEnd = performance.now();
      const lastMotionN = view()?.last.n ?? 0;
      // Give the final submitted camera frame a completion-probe window before closing motion.
      // Read-back presentation (headless WebGPU) delivers asynchronously after the frame loop.
      if (motion) {
        if (view()?.readsBack && lastMotionN > 0) {
          await waitReadback(lastMotionN, 30_000);
        } else {
          await nextFrame();
          await nextFrame();
        }
        w.drawpaneFrames.endMotion?.();
      }
      const exact = await exactAfter(moveEnd);
      longTaskObserver?.disconnect();
      const split = summarizeSplit();
      const vNow = view();
      const readbackDiag = vNow?.readbackDiag
        ? {
            ...(structuredClone(vNow.readbackDiag) as Record<string, unknown>),
            snapAt: Math.round(performance.now()),
            lastN: vNow.last.n,
            shownN: vNow.shown?.n ?? 0,
            reading: vNow.reading ?? false,
          }
        : undefined;
      return {
        ...summary,
        interval: intervals(times),
        ...(motion ? { motion } : {}),
        ...(motion && motion.presentations.length > 1
          ? { presentedInterval: intervals(motion.presentations) }
          : {}),
        exactMs: exact.shown,
        longTaskMaxMs: Math.round(longTaskMaxMs * 10) / 10,
        ...(view()
          ? {
              engine: {
                exactMs: exact.drawn,
                worst,
                settle: exact.settle,
                ...(split ? { split } : {}),
                ...(readbackDiag ? { readbackDiag } : {}),
              },
            }
          : {}),
      };
    },
    {
      kind,
      zoom,
      frames,
      instrument: process.env.BENCH_W4_CAMERA_GATE === "1",
      native: process.env.BENCH_W4_NATIVE === "1",
    },
  );
}

function settleText(s: Settle | undefined): string {
  if (!s) return "";
  const maxIdle = s.idleMaxSliceMs !== undefined ? ` (max ${s.idleMaxSliceMs} ms)` : "";
  return `; settling: ${s.frames} frames drew ${s.frameTiles} tiles in ${s.frameMs} ms, ${s.idleSlices} idle slices ${s.idleTiles} tiles in ${s.idleMs} ms${maxIdle}${s.trace ? `; trace (end at: ms (encode+render) / tiles / pending / mask misses / records / glyphs masked+outlined) ${s.trace}` : ""}`;
}

/** One line of a frame summary for the console. */
export function summaryRow(name: string, r: Summary): string {
  const lt = r.longTaskMaxMs !== undefined ? ` · longTask max ${r.longTaskMaxMs} ms` : "";
  const split = r.engine?.split
    ? ` · split submits ${r.engine.split.submits}, draws ${r.engine.split.draws}`
    : "";
  return `${name.padEnd(12)} content p50 ${String(r.content.p50).padStart(6)} ms · p95 ${String(r.content.p95).padStart(6)} ms · p99 ${String(r.content.p99 ?? "-").padStart(6)} ms · max ${String(r.content.max).padStart(6)} ms · overlay p95 ${String(r.overlay.p95).padStart(5)} ms · frame interval p50 ${r.interval?.p50} / p95 ${r.interval?.p95} / p99 ${r.interval?.p99} ms · exact after ${r.exactMs ?? "-"} ms${lt}${split}${r.engine ? ` (drawn exact after ${r.engine.exactMs} ms; slowest engine frame ${r.engine.worst.ms} ms, ${r.engine.worst.plan}, ${r.engine.worst.tiles} tiles${settleText(r.engine.settle)})` : ""} · drawn ${r.drawn}, culled ${r.culled}`;
}

/** p50, p95 and the worst of some samples, in ms (empty: nulls). */
export interface Spread {
  p50: number | null;
  p95: number | null;
  max: number | null;
}

/**
 * Settling after movements, repeated: each gesture timed from its latest input (the last camera
 * or layer change it made, not the frame after it) to the engine's exact frame drawn, the GPU's
 * having finished it (no read-back in it), and its being shown (a read-back painted, headless).
 * Gestures that don't settle within 5 s count as timeouts, never as times. Stamped with what drew
 * them: the renderer, the page and the engine's revision.
 */
export interface Settles {
  kind: "zoom" | "pan" | "drag";
  gestures: number;
  timeouts: number;
  drawn: Spread;
  gpu: Spread;
  shown: Spread;
  stamp: { renderer: string; pageId: string; revision: number | null };
}

/** `count` gestures of `kind` (20 frames each, alternating direction), each settled before the next. */
export async function settles(
  page: Page,
  kind: "zoom" | "pan" | "drag",
  count: number,
  layer?: string,
): Promise<Settles> {
  return page.evaluate(
    async ({ kind, count, layer }) => {
      type Camera = {
        zoom: number;
        pan(dx: number, dy: number): Camera;
        zoomAt(screen: { x: number; y: number }, zoom: number): Camera;
      };
      type Stamp = { n: number; at: number };
      type View = {
        stamps: { drawn?: Stamp; gpu?: Stamp; shown?: Stamp } | null;
        last: { pageId?: string; supported: boolean };
        engine: { revision: number };
      };
      const w = window as unknown as {
        drawpane: {
          s: { camera: Camera; pageId: string; viewport: { width: number; height: number } };
          state: { set(patch: { camera: Camera }): void };
          doc: { get(id: string): { props: Record<string, unknown> } | undefined };
          setProp(ids: string[], prop: string, value: unknown): void;
        };
        drawpaneFrames: { exact: boolean };
        drawpaneEngineView?: View;
      };
      const e = w.drawpane;
      const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
      const view = () => w.drawpaneEngineView;
      const drawn: number[] = [];
      const gpu: number[] = [];
      const shown: number[] = [];
      let timeouts = 0;
      const centre = { x: e.s.viewport.width / 2, y: e.s.viewport.height / 2 };
      for (let g = 0; g < count; g++) {
        const sign = g % 2 === 0 ? 1 : -1;
        let input = 0;
        for (let i = 0; i < 20; i++) {
          if (kind === "zoom")
            e.state.set({
              camera: e.s.camera.zoomAt(centre, e.s.camera.zoom * (sign > 0 ? 1.03 : 1 / 1.03)),
            });
          else if (kind === "pan") e.state.set({ camera: e.s.camera.pan(6 * sign, 3 * sign) });
          else if (layer) {
            const x = Number(e.doc.get(layer)?.props.x ?? 0);
            e.setProp([layer], "x", x + 4 * sign);
          }
          input = performance.now();
          // From the latest input on: what an exact frame of the gesture's end is stamped with.
          const v = view();
          if (v && i === 19) v.stamps = {};
          await frame();
        }
        const v = view();
        const t = performance.now();
        while (performance.now() - t < 5000) {
          const st = v?.stamps;
          const engineDone = st?.drawn && st.shown && st.gpu;
          if (v ? engineDone : w.drawpaneFrames.exact) break;
          await frame();
        }
        const st = v?.stamps;
        if (v) v.stamps = null;
        // A gesture counts only with every stamp: one missing is a timeout, never a sample left
        // out of one column and not the others.
        if (v ? !(st?.drawn && st.shown && st.gpu) : !w.drawpaneFrames.exact) {
          timeouts++;
          continue;
        }
        if (st?.drawn) drawn.push(st.drawn.at - input);
        if (st?.gpu) gpu.push(st.gpu.at - input);
        if (st?.shown) shown.push(st.shown.at - input);
        else shown.push(performance.now() - input);
      }
      const spread = (xs: number[]) => {
        const s = [...xs].sort((a, b) => a - b);
        const at = (q: number) =>
          s.length ? Math.round(s[Math.ceil(q * (s.length - 1))] as number) : null;
        return { p50: at(0.5), p95: at(0.95), max: at(1) };
      };
      const v = view();
      return {
        kind,
        gestures: count,
        timeouts,
        drawn: spread(drawn),
        gpu: spread(gpu),
        shown: spread(shown),
        stamp: {
          renderer: v?.last.supported ? "engine" : "canvas",
          pageId: e.s.pageId,
          revision: v ? v.engine.revision : null,
        },
      };
    },
    { kind, count, layer },
  );
}

/** One line of settling results for the console. */
export function settlesRow(r: Settles): string {
  const s = (x: Spread) => `p50 ${x.p50 ?? "-"} / p95 ${x.p95 ?? "-"} / max ${x.max ?? "-"}`;
  return `settle, ${r.kind.padEnd(5)} ${r.gestures} gestures, ${r.timeouts} timed out · drawn ${s(r.drawn)} · gpu done ${s(r.gpu)} · shown ${s(r.shown)} ms · ${r.stamp.renderer} on ${r.stamp.pageId}, revision ${r.stamp.revision}`;
}

/** Opening a page: when it was first usefully on screen, and when exact (drawn, GPU, shown). */
export interface Opening {
  /** Two animation frames after the page was shown: the old proxy, kept for comparison. */
  twoFrames: number;
  /**
   * The first frame on screen that looks like the page (`USEFUL` in `opening`): when it was
   * shown, its number, and how much of it matched. Null when none did, or the canvas renderer
   * drew the page (its frames aren't sampled).
   */
  useful: { shown: number; n: number; foreground: number; all: number } | null;
  /** Frames sampled before the exact one, and the best match among them. */
  sampled: number;
  /** The first exact frame: submitted, finished by the GPU, shown (read back here). */
  exact: { drawn: number | null; gpu: number | null; shown: number | null };
  /** The editor's own exact flag (either renderer), for pages the canvas renderer draws. */
  exactAny: number;
  timedOut: boolean;
  stamp: { renderer: "engine" | "canvas"; pageId: string; revision: number | null };
  /** `performance.now()` in the page when the page was shown: other clocks are from it. */
  t0: number;
  /** Longest browser main-thread long task (ms) observed during opening until exact. */
  longTaskMaxMs?: number;
  /** Longest between-frame idle slice (ms) observed during opening until exact. */
  idleMaxSliceMs?: number;
  readbackDiag?: unknown;
  openDiag?: {
    opening: boolean;
    pending: number;
    pendingVisible: number;
    lastN: number;
    shownN: number;
    lastExact: boolean;
    limitReason: string | null;
  };
}

/**
 * Shows `pageId`, whole, and times it (decision 0040's targets: a useful first image within 1 s,
 * exact within 3 s). Every frame the engine puts on screen is sampled as it lands (its canvas
 * scaled to blocks of 16 device pixels); once the page is exact, the first sample that looks
 * like the exact frame is the useful one: at least 90% of the blocks where the exact frame
 * isn't background, and of all blocks, within 40 levels (of 255) of it in every channel. Coarse
 * tiles and text as bars pass; the loading checkerboard, a blank frame or one of the page before
 * don't. At most 60 s.
 */
export async function opening(page: Page, pageId: string): Promise<Opening> {
  return page.evaluate(async (pageId) => {
    type Stamp = { n: number; at: number };
    type View = {
      canvas: HTMLCanvasElement;
      stamps: { drawn?: Stamp; gpu?: Stamp; shown?: Stamp } | null;
      shown: Stamp;
      last: { n: number; exact: boolean; pageId: string; supported: boolean };
      engine: { revision: number };
      limitReason?: string | null;
      builder?: { opening: boolean; pending: number; pendingVisible: number };
      readbackDiag?: unknown;
      resetReadbackDiag?(): void;
    };
    const w = window as unknown as {
      drawpane: { setPage(id: string): void; zoomToFit(): void };
      drawpaneFrames: { exact: boolean };
      drawpaneEngineView?: View;
    };
    const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
    const v = w.drawpaneEngineView;
    const BLOCK = 16;
    const small = document.createElement("canvas");
    const sctx = small.getContext("2d", { willReadFrequently: true });
    const sample = (): Uint8ClampedArray | null => {
      if (!v || !sctx || v.canvas.width === 0) return null;
      small.width = Math.ceil(v.canvas.width / BLOCK);
      small.height = Math.ceil(v.canvas.height / BLOCK);
      sctx.imageSmoothingEnabled = true;
      sctx.imageSmoothingQuality = "high";
      sctx.clearRect(0, 0, small.width, small.height);
      sctx.drawImage(v.canvas, 0, 0, small.width, small.height);
      return sctx.getImageData(0, 0, small.width, small.height).data;
    };
    const samples: Array<{ n: number; at: number; px: Uint8ClampedArray }> = [];
    const shownBefore = v?.shown.n ?? 0;
    v?.resetReadbackDiag?.();
    if (v) v.stamps = {};
    let longTaskMaxMs = 0;
    let longTaskObserver: PerformanceObserver | null = null;
    try {
      longTaskObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.duration > longTaskMaxMs) longTaskMaxMs = entry.duration;
        }
      });
      longTaskObserver.observe({ entryTypes: ["longtask"] });
    } catch {
      // Long Tasks API unsupported in this browser.
    }
    const idleView = v as unknown as { idle?: { maxSliceMs?: number } } | undefined;
    if (idleView?.idle) idleView.idle.maxSliceMs = 0;
    const t0 = performance.now();
    w.drawpane.setPage(pageId);
    w.drawpane.zoomToFit();
    await frame();
    await frame();
    const twoFrames = performance.now() - t0;
    let exactAny: number | null = null;
    let lastSampled = shownBefore;
    const take = () => {
      if (!v || v.last.pageId !== pageId || v.shown.n === lastSampled || v.shown.n <= shownBefore)
        return;
      lastSampled = v.shown.n;
      const px = sample();
      if (px) samples.push({ n: v.shown.n, at: v.shown.at, px });
    };
    take();
    for (;;) {
      if (exactAny === null && w.drawpaneFrames.exact) exactAny = performance.now() - t0;
      const st = v?.stamps;
      const engineDone = !!(st?.drawn && st.shown && st.gpu);
      if ((v?.last.supported ? engineDone : exactAny !== null) || performance.now() - t0 > 60_000)
        break;
      await frame();
      take();
    }
    take();
    longTaskObserver?.disconnect();
    const timedOut = performance.now() - t0 > 60_000;
    const st = v?.stamps;
    const rel = (s?: Stamp) => (s ? Math.round(s.at - t0) : null);
    // The exact frame as shown, against every earlier sample.
    const exactPx = v?.last.supported ? sample() : null;
    let useful: Opening["useful"] = null;
    if (exactPx) {
      const counts = new Map<number, number>();
      for (let i = 0; i < exactPx.length; i += 4) {
        const key =
          ((exactPx[i] as number) << 16) |
          ((exactPx[i + 1] as number) << 8) |
          (exactPx[i + 2] as number);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      let bg = 0;
      let most = 0;
      for (const [key, c] of counts)
        if (c > most) {
          most = c;
          bg = key;
        }
      const bgc = [(bg >> 16) & 255, (bg >> 8) & 255, bg & 255];
      const near = (
        a: Uint8ClampedArray,
        i: number,
        b: ArrayLike<number>,
        j: number,
        tol: number,
      ) =>
        Math.abs((a[i] as number) - (b[j] as number)) <= tol &&
        Math.abs((a[i + 1] as number) - (b[j + 1] as number)) <= tol &&
        Math.abs((a[i + 2] as number) - (b[j + 2] as number)) <= tol;
      for (const s of samples) {
        if (s.px.length !== exactPx.length || (st?.shown && s.n > st.shown.n)) continue;
        let fg = 0;
        let fgOk = 0;
        let ok = 0;
        for (let i = 0; i < exactPx.length; i += 4) {
          const match = near(s.px, i, exactPx, i, 40);
          if (match) ok++;
          if (!near(exactPx, i, bgc, 0, 24)) {
            fg++;
            if (match) fgOk++;
          }
        }
        const foreground = fg ? fgOk / fg : 1;
        const all = ok / (exactPx.length / 4);
        if (foreground >= 0.9 && all >= 0.9) {
          useful = {
            shown: Math.round(s.at - t0),
            n: s.n,
            foreground: Math.round(foreground * 1000) / 1000,
            all: Math.round(all * 1000) / 1000,
          };
          break;
        }
      }
    }
    if (v) v.stamps = null;
    const readbackDiag = v?.readbackDiag ? structuredClone(v.readbackDiag) : undefined;
    const openDiag = v
      ? {
          opening: v.builder?.opening ?? false,
          pending: v.builder?.pending ?? 0,
          pendingVisible: v.builder?.pendingVisible ?? 0,
          lastN: v.last.n,
          shownN: v.shown.n,
          lastExact: v.last.exact,
          limitReason: v.limitReason ?? null,
        }
      : undefined;
    return {
      twoFrames: Math.round(twoFrames),
      useful,
      sampled: samples.length,
      exact: { drawn: rel(st?.drawn), gpu: rel(st?.gpu), shown: rel(st?.shown) },
      exactAny: Math.round(exactAny ?? performance.now() - t0),
      timedOut,
      stamp: {
        renderer: v?.last.supported && v.last.pageId === pageId ? "engine" : "canvas",
        pageId,
        revision: v ? v.engine.revision : null,
      },
      t0,
      longTaskMaxMs: Math.round(longTaskMaxMs * 10) / 10,
      idleMaxSliceMs: Math.round((idleView?.idle?.maxSliceMs ?? 0) * 10) / 10,
      ...(readbackDiag ? { readbackDiag } : {}),
      ...(openDiag ? { openDiag } : {}),
    } satisfies Opening;
  }, pageId);
}

/** One line of opening results for the console. */
export function openingRow(o: Opening): string {
  const u = o.useful
    ? `useful image shown at ${o.useful.shown} ms (frame ${o.useful.n}, ${Math.round(o.useful.foreground * 100)}% of the foreground)`
    : "no useful image sampled";
  const lt = o.longTaskMaxMs !== undefined ? ` · longTask max ${o.longTaskMaxMs} ms` : "";
  const idle = o.idleMaxSliceMs !== undefined ? ` · idle max ${o.idleMaxSliceMs} ms` : "";
  return `open        ${u} · exact drawn ${o.exact.drawn ?? "-"} / gpu done ${o.exact.gpu ?? "-"} / shown ${o.exact.shown ?? "-"} ms (editor's flag ${o.exactAny} ms)${lt}${idle} · ${o.sampled} frames sampled · two frames ${o.twoFrames} ms · ${o.stamp.renderer} on ${o.stamp.pageId}, revision ${o.stamp.revision}${o.timedOut ? " · TIMED OUT" : ""}`;
}
