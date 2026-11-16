/**
 * What's left to draw exactly on a canvas being drawn a little at a time
 * (decision 0028). A full repaint of a large page can take far longer than
 * a frame, so the renderer shows a stand-in (the last frame scaled, cached
 * frames of the page) and draws the exact picture tile by tile, a few each
 * frame, centre first, until none is left.
 *
 * Regions are kept in "zoomed page pixels": device pixels with the
 * camera's translation taken away (`device = zoomed + t`, t in whole
 * pixels). A pan moves the canvas by whole pixels and leaves these where
 * they are, so work survives panning; a zoom starts it afresh.
 */
import type { Point, Rect } from "./geometry";

/** A tile's side in device pixels: small enough to draw a few in a frame, big enough not to cost much each. */
export const TILE = 256;

function clipTo(a: Rect, b: Rect): Rect | null {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.width, b.x + b.width);
  const y1 = Math.min(a.y + a.height, b.y + b.height);
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : null;
}

function union(a: Rect, b: Rect): Rect {
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const x1 = Math.max(a.x + a.width, b.x + b.width);
  const y1 = Math.max(a.y + a.height, b.y + b.height);
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** Areas still to draw, as a part of each tile they touch (the box around what's left there). */
export class TileWork {
  readonly tile: number;
  readonly #tiles = new Map<string, { tx: number; ty: number; rect: Rect }>();

  constructor(tile = TILE) {
    this.tile = tile;
  }

  get empty(): boolean {
    return this.#tiles.size === 0;
  }

  get size(): number {
    return this.#tiles.size;
  }

  /** Adds an area (zoomed page pixels; grown to whole pixels) to draw. */
  add(rect: Rect): void {
    const x0 = Math.floor(rect.x);
    const y0 = Math.floor(rect.y);
    const x1 = Math.ceil(rect.x + rect.width);
    const y1 = Math.ceil(rect.y + rect.height);
    if (!(x1 > x0 && y1 > y0)) return;
    const t = this.tile;
    for (let tx = Math.floor(x0 / t); tx * t < x1; tx++)
      for (let ty = Math.floor(y0 / t); ty * t < y1; ty++) {
        const cell = { x: tx * t, y: ty * t, width: t, height: t };
        const part = clipTo(cell, { x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
        if (!part) continue;
        const key = `${tx},${ty}`;
        const at = this.#tiles.get(key);
        this.#tiles.set(key, { tx, ty, rect: at ? union(at.rect, part) : part });
      }
  }

  clear(): void {
    this.#tiles.clear();
  }

  /** Forgets what's outside `view` (off the canvas, so not shown: a pan back draws it as it comes in). */
  keepWithin(view: Rect): void {
    for (const [key, entry] of this.#tiles) {
      const part = clipTo(entry.rect, view);
      if (part) entry.rect = part;
      else this.#tiles.delete(key);
    }
  }

  /**
   * Takes the next area to draw, within `view`: the one nearest `centre`,
   * so the middle of the screen sharpens first. Null when nothing is left.
   */
  take(view: Rect, centre: Point): Rect | null {
    let best: string | null = null;
    let bestRect: Rect | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const [key, entry] of this.#tiles) {
      const part = clipTo(entry.rect, view);
      if (!part) {
        this.#tiles.delete(key);
        continue;
      }
      const dx = part.x + part.width / 2 - centre.x;
      const dy = part.y + part.height / 2 - centre.y;
      const distance = dx * dx + dy * dy;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = key;
        bestRect = part;
      }
    }
    if (best === null) return null;
    this.#tiles.delete(best);
    return bestRect;
  }

  /** The areas left, for tests and debugging. */
  areas(): Rect[] {
    return [...this.#tiles.values()].map((e) => e.rect);
  }
}

/**
 * Merges rects (device pixels) into a few covering ones on a coarse grid:
 * thousands of small dirty places (a main edited, with copies everywhere)
 * become one rect per run of grid cells, each row's runs joined down when
 * they line up. Never less than what was given.
 */
export function coverRects(rects: readonly Rect[], bounds: Rect, cell = 64): Rect[] {
  const cols = Math.max(1, Math.ceil(bounds.width / cell));
  const rows = Math.max(1, Math.ceil(bounds.height / cell));
  const marked = new Uint8Array(cols * rows);
  let any = false;
  for (const r of rects) {
    const part = clipTo(r, bounds);
    if (!part) continue;
    any = true;
    const c0 = Math.floor((part.x - bounds.x) / cell);
    const r0 = Math.floor((part.y - bounds.y) / cell);
    const c1 = Math.min(cols - 1, Math.floor((part.x + part.width - bounds.x - 1e-9) / cell));
    const r1 = Math.min(rows - 1, Math.floor((part.y + part.height - bounds.y - 1e-9) / cell));
    for (let row = r0; row <= r1; row++) marked.fill(1, row * cols + c0, row * cols + c1 + 1);
  }
  if (!any) return [];
  // Runs along each row, then runs with the same columns on consecutive rows joined.
  const out: Rect[] = [];
  let open = new Map<string, Rect>();
  for (let row = 0; row < rows; row++) {
    const next = new Map<string, Rect>();
    for (let col = 0; col < cols; ) {
      if (!marked[row * cols + col]) {
        col++;
        continue;
      }
      const start = col;
      while (col < cols && marked[row * cols + col]) col++;
      const key = `${start},${col}`;
      const above = open.get(key);
      const x = bounds.x + start * cell;
      const y = bounds.y + row * cell;
      const rect = above
        ? { ...above, height: y + cell - above.y }
        : { x, y, width: (col - start) * cell, height: cell };
      open.delete(key);
      next.set(key, rect);
    }
    for (const rect of open.values()) out.push(rect);
    open = next;
  }
  for (const rect of open.values()) out.push(rect);
  return out.map((r) => clipTo(r, bounds) as Rect);
}
