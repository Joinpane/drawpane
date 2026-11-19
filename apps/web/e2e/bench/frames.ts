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
  /** Ms from the last frame of the movement until the canvas showed an exact frame. */
  exactMs?: number;
  /**
   * The render engine only: ms until it drew an exact frame (before a read-back shows it, in
   * headless browsers), and its slowest frame of the movement (ms, how it was made, tiles drawn).
   */
  engine?: { exactMs: number; worst: { ms: number; plan: string; tiles: number }; settle?: Settle };
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
              `${e.k === "frame" ? "f" : e.k === "present" ? "p" : "i"}${Math.round(e.t - t)}:${Math.round(e.ms)}(${Math.round(e.encode)}+${Math.round(e.render)})/${e.tiles}/${e.pending}/m${e.misses}/r${e.records}/g${e.masked}+${e.outlined}`,
          )
          .join(" ");
        if (traced) traced.trace = null;
        return {
          shown,
          drawn: Math.round(drawn < 0 ? shown : drawn),
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
            `${e.k === "frame" ? "f" : e.k === "present" ? "p" : "i"}${Math.round(e.t - t)}:${Math.round(e.ms)}(${Math.round(e.encode)}+${Math.round(e.render)})/${e.tiles}/${e.pending}/m${e.misses}/r${e.records}/g${e.masked}+${e.outlined}`,
        )
        .join(" ");
      if (traced) traced.trace = null;
      return { shown, drawn: Math.round(drawn < 0 ? shown : drawn), settle: { ...settle, trace } };
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
