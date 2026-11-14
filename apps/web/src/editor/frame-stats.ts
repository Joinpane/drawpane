/**
 * How long the canvas takes to draw, frame by frame: the last 600 frames'
 * content and overlay times in a ring buffer (two `performance.now()` calls
 * a frame, nothing else). The benchmarks read it through the debug handle,
 * and it answers "is this file slow to pan?" from the console.
 */
import type { Editor } from "@drawpane/editor";

const SIZE = 600;

export interface FrameSummary {
  readonly frames: number;
  /** Milliseconds drawing the document. */
  readonly content: { readonly p50: number; readonly p95: number; readonly max: number };
  /** Milliseconds drawing selection, handles and guides. */
  readonly overlay: { readonly p50: number; readonly p95: number; readonly max: number };
  /** Layers drawn and skipped (off screen) in the last content frame. */
  readonly drawn: number;
  readonly culled: number;
}

export class FrameStats {
  readonly #content = new Float64Array(SIZE);
  readonly #overlay = new Float64Array(SIZE);
  #count = 0;
  #at = 0;
  drawn = 0;
  culled = 0;
  /** Draws the next frame in full, from nothing (set by the canvas; for checks and debugging). */
  redraw: () => void = () => {};

  record(content: number, overlay: number): void {
    this.#content[this.#at] = content;
    this.#overlay[this.#at] = overlay;
    this.#at = (this.#at + 1) % SIZE;
    this.#count = Math.min(SIZE, this.#count + 1);
  }

  reset(): void {
    this.#count = 0;
    this.#at = 0;
  }

  summary(): FrameSummary {
    const take = (buffer: Float64Array) => {
      const values = [...buffer.subarray(0, this.#count)].sort((a, b) => a - b);
      const at = (q: number) =>
        values[Math.min(values.length - 1, Math.floor(q * values.length))] ?? 0;
      const round = (n: number) => Math.round(n * 100) / 100;
      return { p50: round(at(0.5)), p95: round(at(0.95)), max: round(values.at(-1) ?? 0) };
    };
    return {
      frames: this.#count,
      content: take(this.#content),
      overlay: take(this.#overlay),
      drawn: this.drawn,
      culled: this.culled,
    };
  }
}

const stats = new WeakMap<Editor, FrameStats>();

export function frameStatsFor(editor: Editor): FrameStats {
  let s = stats.get(editor);
  if (!s) {
    s = new FrameStats();
    stats.set(editor, s);
  }
  return s;
}
