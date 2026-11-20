/**
 * Measuring the canvas while it moves: panning and zooming for a number of
 * animation frames through the editor's debug handle (`drawpane:debug`), and
 * what drawing them took (`drawpaneFrames`). Shared by the benchmarks.
 */
import type { Page } from "@playwright/test";

export interface Summary {
  frames: number;
  /** Time between animation frames: what you'd see, painting included (16.7 ms at 60 Hz). */
  interval?: { p50: number; p95: number; p99: number; max: number };
  content: { p50: number; p95: number; p99?: number; max: number };
  overlay: { p50: number; p95: number; p99?: number; max: number };
  drawn: number;
  culled: number;
  /** Ms from the last frame of the movement until the canvas showed an exact frame (null: never, within 10 s). */
  exactMs?: number | null;
  /**
   * The render engine only: ms until it drew an exact frame (before a read-back shows it, in
   * headless browsers), and its slowest frame of the movement (ms, how it was made, tiles drawn).
   */
  engine?: {
    exactMs: number | null;
    worst: { ms: number; plan: string; tiles: number };
    settle?: Settle;
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
  /** Each frame (f) and slice between frames (i): ms after the movement, its ms, tiles, pending. */
  trace?: string;
}

/** Pans for `frames` animation frames and returns what drawing them took. */
export async function pan(page: Page, zoom: number | "fit", frames: number): Promise<Summary> {
  return page.evaluate(
    async ({ zoom, frames }) => {
      type Camera = { pan(dx: number, dy: number): Camera };
      const e = (
        window as unknown as {
          drawpane: {
            s: { camera: Camera };
            state: { set(patch: { camera: Camera }): void };
            zoomTo(z: number): void;
            zoomToFit(): void;
          };
          drawpaneFrames: { reset(): void; summary(): Summary };
        }
      ).drawpane;
      const stats = (window as unknown as { drawpaneFrames: { reset(): void; summary(): Summary } })
        .drawpaneFrames;
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
      type View = {
        last: { exact: boolean; ms: number; plan: string; tiles: { drawn: number } };
        idle: { slices: number; tiles: number; ms: number };
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
      const watch = () => {
        const l = view()?.last;
        if (l && l.ms > worst.ms)
          worst = { ms: Math.round(l.ms * 10) / 10, plan: l.plan, tiles: l.tiles.drawn };
      };
      // Until an exact frame is on screen after the movement's last frame (at most 10 s), and
      // until the engine drew one.
      const exactAfter = async () => {
        const t = performance.now();
        const f = (window as unknown as { drawpaneFrames: { exact: boolean } }).drawpaneFrames;
        let drawn = -1;
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
          if (v.last.exact) drawn = performance.now() - t;
        };
        await nextFrame();
        while (!f.exact && performance.now() - t < 10_000) {
          tally();
          await nextFrame();
        }
        tally();
        settle.frameMs = Math.round(settle.frameMs * 10) / 10;
        const shown = Math.round(performance.now() - t);
        const trace = (traced?.trace ?? [])
          .map(
            (e) =>
              `${e.k === "frame" ? "f" : e.k === "present" ? "p" : e.k === "text" ? "t" : "i"}${Math.round(e.t - t)}:${Math.round(e.ms)}(${Math.round(e.encode)}+${Math.round(e.render)})/${e.tiles}/${e.pending}/m${e.misses}/r${e.records}/g${e.masked}+${e.outlined}`,
          )
          .join(" ");
        if (traced) traced.trace = null;
        // A wait that ran out is reported as such, never as the time it waited.
        const timedOut = !f.exact;
        return {
          shown: timedOut ? null : shown,
          drawn: drawn < 0 ? null : Math.round(drawn),
          settle: { ...settle, trace },
        };
      };
      const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
      await nextFrame();
      await nextFrame();
      stats.reset();
      const times: number[] = [];
      for (let i = 0; i < frames; i++) {
        // A steady diagonal drag, back and forth.
        const d = i % 120 < 60 ? 6 : -6;
        e.state.set({ camera: e.s.camera.pan(d, d / 2) });
        await nextFrame();
        times.push(performance.now());
        watch();
      }
      const summary = stats.summary();
      const exact = await exactAfter();
      return {
        ...summary,
        interval: intervals(times),
        exactMs: exact.shown,
        ...(view() ? { engine: { exactMs: exact.drawn, worst, settle: exact.settle } } : {}),
      };
    },
    { zoom, frames },
  );
}

/** Zooms in and out about the centre for `frames` frames, from the whole file. */
export async function zoom(page: Page, frames: number): Promise<Summary> {
  return page.evaluate(async (frames) => {
    type Camera = { zoomAt(screen: { x: number; y: number }, zoom: number): Camera; zoom: number };
    const w = window as unknown as {
      drawpane: {
        s: { camera: Camera; viewport: { width: number; height: number } };
        state: { set(patch: { camera: Camera }): void };
        zoomToFit(): void;
      };
      drawpaneFrames: { reset(): void; summary(): Summary };
    };
    const e = w.drawpane;
    e.zoomToFit();
    const intervals = (times: number[]) => {
      const gaps = times
        .slice(1)
        .map((t, i) => t - (times[i] as number))
        .sort((a, b) => a - b);
      const at = (q: number) =>
        Math.round((gaps[Math.floor(q * (gaps.length - 1))] ?? 0) * 10) / 10;
      return { p50: at(0.5), p95: at(0.95), p99: at(0.99), max: at(1) };
    };
    const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
    type View = {
      last: { exact: boolean; ms: number; plan: string; tiles: { drawn: number } };
      idle: { slices: number; tiles: number; ms: number };
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
    const watch = () => {
      const l = view()?.last;
      if (l && l.ms > worst.ms)
        worst = { ms: Math.round(l.ms * 10) / 10, plan: l.plan, tiles: l.tiles.drawn };
    };
    const exactAfter = async () => {
      const t = performance.now();
      const f = (window as unknown as { drawpaneFrames: { exact: boolean } }).drawpaneFrames;
      let drawn = -1;
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
        if (v.last.exact) drawn = performance.now() - t;
      };
      await nextFrame();
      while (!f.exact && performance.now() - t < 10_000) {
        tally();
        await nextFrame();
      }
      tally();
      settle.frameMs = Math.round(settle.frameMs * 10) / 10;
      const shown = Math.round(performance.now() - t);
      const trace = (traced?.trace ?? [])
        .map(
          (e) =>
            `${e.k === "frame" ? "f" : e.k === "present" ? "p" : e.k === "text" ? "t" : "i"}${Math.round(e.t - t)}:${Math.round(e.ms)}(${Math.round(e.encode)}+${Math.round(e.render)})/${e.tiles}/${e.pending}/m${e.misses}/r${e.records}/g${e.masked}+${e.outlined}`,
        )
        .join(" ");
      if (traced) traced.trace = null;
      // A wait that ran out is reported as such, never as the time it waited.
      const timedOut = !f.exact;
      return {
        shown: timedOut ? null : shown,
        drawn: drawn < 0 ? null : Math.round(drawn),
        settle: { ...settle, trace },
      };
    };
    await nextFrame();
    await nextFrame();
    w.drawpaneFrames.reset();
    const centre = { x: e.s.viewport.width / 2, y: e.s.viewport.height / 2 };
    const times: number[] = [];
    for (let i = 0; i < frames; i++) {
      // A pinch: 3% a frame, in for a second and out again.
      const factor = i % 120 < 60 ? 1.03 : 1 / 1.03;
      e.state.set({ camera: e.s.camera.zoomAt(centre, e.s.camera.zoom * factor) });
      await nextFrame();
      times.push(performance.now());
      watch();
    }
    const summary = w.drawpaneFrames.summary();
    const exact = await exactAfter();
    return {
      ...summary,
      interval: intervals(times),
      exactMs: exact.shown,
      ...(view() ? { engine: { exactMs: exact.drawn, worst, settle: exact.settle } } : {}),
    };
  }, frames);
}

function settleText(s: Settle | undefined): string {
  if (!s) return "";
  return `; settling: ${s.frames} frames drew ${s.frameTiles} tiles in ${s.frameMs} ms, ${s.idleSlices} idle slices ${s.idleTiles} tiles in ${s.idleMs} ms${s.trace ? `; trace (end at: ms (encode+render) / tiles / pending / mask misses / records / glyphs masked+outlined) ${s.trace}` : ""}`;
}

/** One line of a frame summary for the console. */
export function summaryRow(name: string, r: Summary): string {
  return `${name.padEnd(12)} content p50 ${String(r.content.p50).padStart(6)} ms · p95 ${String(r.content.p95).padStart(6)} ms · p99 ${String(r.content.p99 ?? "-").padStart(6)} ms · max ${String(r.content.max).padStart(6)} ms · overlay p95 ${String(r.overlay.p95).padStart(5)} ms · frame interval p50 ${r.interval?.p50} / p95 ${r.interval?.p95} / p99 ${r.interval?.p99} ms · exact after ${r.exactMs ?? "-"} ms${r.engine ? ` (drawn exact after ${r.engine.exactMs} ms; slowest engine frame ${r.engine.worst.ms} ms, ${r.engine.worst.plan}, ${r.engine.worst.tiles} tiles${settleText(r.engine.settle)})` : ""} · drawn ${r.drawn}, culled ${r.culled}`;
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
        if (v ? !(st?.drawn && st.shown) : !w.drawpaneFrames.exact) {
          timeouts++;
          continue;
        }
        if (st?.drawn) drawn.push(st.drawn.at - input);
        if (st?.gpu) gpu.push(st.gpu.at - input);
        if (st?.shown) shown.push(st.shown.at - input);
        else shown.push(performance.now() - input);
        if (v) v.stamps = null;
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
      last: { pageId: string; supported: boolean };
      engine: { revision: number };
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
    if (v) v.stamps = {};
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
    } satisfies Opening;
  }, pageId);
}

/** One line of opening results for the console. */
export function openingRow(o: Opening): string {
  const u = o.useful
    ? `useful image shown at ${o.useful.shown} ms (frame ${o.useful.n}, ${Math.round(o.useful.foreground * 100)}% of the foreground)`
    : "no useful image sampled";
  return `open        ${u} · exact drawn ${o.exact.drawn ?? "-"} / gpu done ${o.exact.gpu ?? "-"} / shown ${o.exact.shown ?? "-"} ms (editor's flag ${o.exactAny} ms) · ${o.sampled} frames sampled · two frames ${o.twoFrames} ms · ${o.stamp.renderer} on ${o.stamp.pageId}, revision ${o.stamp.revision}${o.timedOut ? " · TIMED OUT" : ""}`;
}
