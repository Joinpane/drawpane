/**
 * Measuring the canvas while it moves: panning and zooming for a number of
 * animation frames through the editor's debug handle (`drawpane:debug`), and
 * what drawing them took (`drawpaneFrames`). Shared by the benchmarks.
 */
import type { Page } from "@playwright/test";

export interface Summary {
  frames: number;
  /** Time between animation frames: what you'd see, painting included (16.7 ms at 60 Hz). */
  interval?: { p50: number; p95: number };
  content: { p50: number; p95: number; max: number };
  overlay: { p50: number; p95: number; max: number };
  drawn: number;
  culled: number;
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
        return { p50: at(0.5), p95: at(0.95) };
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
      }
      return { ...stats.summary(), interval: intervals(times) };
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
      return { p50: at(0.5), p95: at(0.95) };
    };
    const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
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
    }
    return { ...w.drawpaneFrames.summary(), interval: intervals(times) };
  }, frames);
}

/** One line of a frame summary for the console. */
export function summaryRow(name: string, r: Summary): string {
  return `${name.padEnd(12)} content p50 ${String(r.content.p50).padStart(6)} ms · p95 ${String(r.content.p95).padStart(6)} ms · max ${String(r.content.max).padStart(6)} ms · overlay p95 ${String(r.overlay.p95).padStart(5)} ms · frame interval p50 ${r.interval?.p50} / p95 ${r.interval?.p95} ms · drawn ${r.drawn}, culled ${r.culled}`;
}
