/**
 * A spatial index of rects by id: a uniform grid, so a rect moves in place
 * (out of its old cells, into its new ones) without rebuilding anything.
 * The scene keeps one per container with many children (decision 0028), so
 * drawing and hit testing visit what's near the view or the pointer instead
 * of every child.
 *
 * Rects that would cover many cells (a background behind everything, a
 * layer far larger than its siblings) are kept in a list of their own and
 * checked on every query.
 */
import type { Rect } from "./geometry";

/** Most cells a rect may cover before it's kept in the oversized list instead. */
const MAX_CELLS = 64;
/** Cell coordinates are clamped to ±this, so keys stay exact in a double. */
const LIMIT = 1 << 24;
const SPAN = LIMIT * 2 + 1;

function cellOf(v: number, size: number): number {
  const c = Math.floor(v / size);
  return Math.min(LIMIT, Math.max(-LIMIT, c));
}

function finite(r: Rect): boolean {
  return (
    Number.isFinite(r.x) &&
    Number.isFinite(r.y) &&
    Number.isFinite(r.width) &&
    Number.isFinite(r.height)
  );
}

/** Whether two rects overlap, edges touching included (as the renderer's cull counts them). */
export function touches(a: Rect, b: Rect): boolean {
  return (
    a.x <= b.x + b.width && b.x <= a.x + a.width && a.y <= b.y + b.height && b.y <= a.y + a.height
  );
}

export class GridIndex {
  readonly cell: number;
  readonly #cells = new Map<number, string[]>();
  readonly #rects = new Map<string, Rect>();
  /** Ids whose rect covers too many cells (or isn't finite): checked on every query. */
  readonly #big = new Set<string>();

  /** `cell` is the side of a cell, in the rects' units: about the size of a typical rect. */
  constructor(cell: number) {
    this.cell = cell > 0 && Number.isFinite(cell) ? cell : 1;
  }

  get size(): number {
    return this.#rects.size;
  }

  has(id: string): boolean {
    return this.#rects.has(id);
  }

  rect(id: string): Rect | undefined {
    return this.#rects.get(id);
  }

  ids(): IterableIterator<string> {
    return this.#rects.keys();
  }

  /** Adds `id` at `rect`, or moves it there. */
  set(id: string, rect: Rect): void {
    if (this.#rects.has(id)) this.delete(id);
    this.#rects.set(id, rect);
    const range = this.#range(rect);
    if (!range) {
      this.#big.add(id);
      return;
    }
    const [x0, y0, x1, y1] = range;
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++) {
        const key = (x + LIMIT) * SPAN + (y + LIMIT);
        const list = this.#cells.get(key);
        if (list) list.push(id);
        else this.#cells.set(key, [id]);
      }
  }

  delete(id: string): boolean {
    const rect = this.#rects.get(id);
    if (!rect) return false;
    this.#rects.delete(id);
    if (this.#big.delete(id)) return true;
    const range = this.#range(rect);
    if (!range) return true;
    const [x0, y0, x1, y1] = range;
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++) {
        const key = (x + LIMIT) * SPAN + (y + LIMIT);
        const list = this.#cells.get(key);
        if (!list) continue;
        const at = list.indexOf(id);
        if (at === -1) continue;
        // Order within a cell doesn't matter: swap the last one in.
        const last = list.pop() as string;
        if (at < list.length) list[at] = last;
        if (list.length === 0) this.#cells.delete(key);
      }
    return true;
  }

  /** Adds to `out` every id whose rect touches `rect`. */
  query(rect: Rect, out: Set<string>): void {
    for (const id of this.#big) if (touches(this.#rects.get(id) as Rect, rect)) out.add(id);
    if (!finite(rect)) {
      for (const [id, r] of this.#rects) if (touches(r, rect)) out.add(id);
      return;
    }
    const x0 = cellOf(rect.x, this.cell);
    const y0 = cellOf(rect.y, this.cell);
    const x1 = cellOf(rect.x + rect.width, this.cell);
    const y1 = cellOf(rect.y + rect.height, this.cell);
    // A query wider than the index itself: checking every rect costs less than every cell.
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > this.#rects.size) {
      for (const [id, r] of this.#rects) if (touches(r, rect)) out.add(id);
      return;
    }
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++) {
        const list = this.#cells.get((x + LIMIT) * SPAN + (y + LIMIT));
        if (!list) continue;
        for (const id of list) {
          if (out.has(id)) continue;
          if (touches(this.#rects.get(id) as Rect, rect)) out.add(id);
        }
      }
  }

  #range(rect: Rect): [number, number, number, number] | null {
    if (!finite(rect)) return null;
    const x0 = cellOf(rect.x, this.cell);
    const y0 = cellOf(rect.y, this.cell);
    const x1 = cellOf(rect.x + rect.width, this.cell);
    const y1 = cellOf(rect.y + rect.height, this.cell);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > MAX_CELLS) return null;
    return [x0, y0, x1, y1];
  }
}

/** A cell size for these rects: the median of their larger sides, so a typical rect covers a cell or four. */
export function cellSizeFor(rects: Iterable<Rect>): number {
  const sides: number[] = [];
  for (const r of rects) {
    const side = Math.max(r.width, r.height);
    if (Number.isFinite(side) && side > 0) sides.push(side);
  }
  if (sides.length === 0) return 64;
  sides.sort((a, b) => a - b);
  return Math.max(1, sides[Math.floor(sides.length / 2)] as number);
}
