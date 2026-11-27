/**
 * How long the canvas takes to draw, frame by frame: the last 600 frames'
 * content and overlay times in a ring buffer (two `performance.now()` calls
 * a frame, nothing else). The benchmarks read it through the debug handle,
 * and it answers "is this file slow to pan?" from the console.
 */
import type { Camera, Editor } from "@drawpane/editor";

const SIZE = 600;

export interface Quantiles {
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
}

export interface FrameSummary {
  readonly frames: number;
  /** Milliseconds drawing the document. */
  readonly content: Quantiles;
  /** Milliseconds drawing selection, handles and guides. */
  readonly overlay: Quantiles;
  /** Layers drawn and skipped (off screen) in the last content frame. */
  readonly drawn: number;
  readonly culled: number;
}

/** Counts the GPU frames produced during the bench's camera inputs. */
export interface MotionStats {
  readonly native: boolean;
  readonly presentations: number[];
  submitted: number;
  degradedSubmitted: number;
  confirmed: number;
  degradedConfirmed: number;
  fallback: number;
  missed: number;
}

/** Opt-in pixel capture for a separate, untimed replay of the camera inputs. */
export interface MotionCapture {
  submitted(
    sequence: number,
    camera: Camera,
    width: number,
    height: number,
    exact: boolean,
    pixels: () => Promise<Uint8Array>,
  ): void;
  confirmed(sequence: number): void;
}

export class FrameStats {
  readonly #content = new Float64Array(SIZE);
  readonly #overlay = new Float64Array(SIZE);
  #count = 0;
  #at = 0;
  /** Estimated RGBA bytes of retained canvases, snapshots and visible-renderer image copies. */
  mobileMemory: {
    backingBytes: number;
    snapshotBytes: number;
    decodedBytes: number;
    peakBytes: number;
  } | null = null;
  drawn = 0;
  culled = 0;
  /** Whether the last content frame was exact (not a stand-in, nor drawn in part). */
  exact = true;
  motion: MotionStats | null = null;
  motionCapture: MotionCapture | null = null;
  #motionFrames = new Map<number, boolean>();

  beginMotion(native: boolean): MotionStats {
    this.#motionFrames.clear();
    this.motion = {
      native,
      presentations: [],
      submitted: 0,
      degradedSubmitted: 0,
      confirmed: 0,
      degradedConfirmed: 0,
      fallback: 0,
      missed: 0,
    };
    return this.motion;
  }

  endMotion(): void {
    this.motion = null;
    this.#motionFrames.clear();
  }

  submitMotionFrame(sequence: number, exact: boolean): void {
    if (!this.motion) return;
    this.motion.submitted++;
    // Until resampled pixels pass calibration, only a native exact frame qualifies.
    if (!exact) this.motion.degradedSubmitted++;
    this.#motionFrames.set(sequence, exact);
  }

  confirmMotionFrame(sequence: number): void {
    const exact = this.#motionFrames.get(sequence);
    if (!this.motion || exact === undefined) return;
    this.motion.confirmed++;
    this.motion.presentations.push(performance.now());
    if (!exact) this.motion.degradedConfirmed++;
    this.#motionFrames.delete(sequence);
    this.motionCapture?.confirmed(sequence);
  }
  /**
   * The canvas's drawing budget per frame in ms, when set (for checks: a tiny budget makes
   * every frame one that costs more than it, as a heavy file does on a slow machine).
   */
  budget: number | null = null;
  /** Draws the next frame in full, from nothing (set by the canvas; for checks and debugging). */
  redraw: () => void = () => {};
  /**
   * Draws the view afresh, whole, with a renderer of its own, and compares
   * it with the canvas: how many pixels differ and by how much at most (set
   * by the canvas; e2e/canvas-scale.spec.ts checks that a frame drawn a
   * little at a time ends up exactly that).
   */
  compare: () => { pixels: number; differing: number; max: number } | null = () => null;

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
      return {
        p50: round(at(0.5)),
        p95: round(at(0.95)),
        p99: round(at(0.99)),
        max: round(values.at(-1) ?? 0),
      };
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
