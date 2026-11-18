import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Rect } from "../src/geometry";
import { cellSizeFor, GridIndex, touches } from "../src/spatial";
import { coverRects, TileWork } from "../src/tiles";

const coord = fc.integer({ min: -5000, max: 5000 });
const side = fc.oneof(fc.integer({ min: 0, max: 300 }), fc.integer({ min: 0, max: 20000 }));
const rect = fc.record({ x: coord, y: coord, width: side, height: side });

function contains(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x - 1e-9 &&
    inner.y >= outer.y - 1e-9 &&
    inner.x + inner.width <= outer.x + outer.width + 1e-9 &&
    inner.y + inner.height <= outer.y + outer.height + 1e-9
  );
}

describe("GridIndex", () => {
  it("finds exactly the rects a query touches, through sets, moves and deletes", () => {
    const action = fc.oneof(
      fc.record({ kind: fc.constant("set" as const), id: fc.integer({ min: 0, max: 40 }), rect }),
      fc.record({ kind: fc.constant("delete" as const), id: fc.integer({ min: 0, max: 40 }) }),
      fc.record({ kind: fc.constant("query" as const), rect }),
    );
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 4000 }),
        fc.array(action, { maxLength: 80 }),
        (cell, actions) => {
          const grid = new GridIndex(cell);
          const truth = new Map<string, Rect>();
          for (const a of actions) {
            if (a.kind === "set") {
              grid.set(String(a.id), a.rect);
              truth.set(String(a.id), a.rect);
            } else if (a.kind === "delete") {
              expect(grid.delete(String(a.id))).toBe(truth.delete(String(a.id)));
            } else {
              const found = new Set<string>();
              grid.query(a.rect, found);
              const expected = [...truth].filter(([, r]) => touches(r, a.rect)).map(([id]) => id);
              expect([...found].sort()).toEqual(expected.sort());
            }
            expect(grid.size).toBe(truth.size);
          }
        },
      ),
    );
  });

  it("keeps rects that aren't finite, and finds them", () => {
    const grid = new GridIndex(10);
    grid.set("a", { x: 0, y: 0, width: Number.POSITIVE_INFINITY, height: 5 });
    const found = new Set<string>();
    grid.query({ x: 1e9, y: 1, width: 1, height: 1 }, found);
    expect([...found]).toEqual(["a"]);
  });

  it("sizes cells by the median rect", () => {
    expect(cellSizeFor([])).toBe(64);
    expect(
      cellSizeFor([
        { x: 0, y: 0, width: 10, height: 1 },
        { x: 0, y: 0, width: 100, height: 1 },
        { x: 0, y: 0, width: 1000, height: 1 },
      ]),
    ).toBe(100);
  });
});

describe("TileWork", () => {
  it("hands back every part added that's in view, a tile at a time, and nothing twice", () => {
    fc.assert(
      fc.property(fc.array(rect, { maxLength: 12 }), rect, (added, view) => {
        const work = new TileWork(256);
        for (const r of added) work.add(r);
        const taken: Rect[] = [];
        for (let r = work.take(view, { x: 0, y: 0 }); r; r = work.take(view, { x: 0, y: 0 })) {
          // Within one tile and within the view.
          expect(Math.floor(r.x / 256)).toBe(Math.floor((r.x + r.width - 1) / 256));
          expect(contains(view, r)).toBe(true);
          taken.push(r);
        }
        expect(work.empty).toBe(true);
        // Each added pixel in view lies in some taken part (sampled at corners and centre).
        for (const r of added) {
          const x0 = Math.max(Math.floor(r.x), view.x);
          const y0 = Math.max(Math.floor(r.y), view.y);
          const x1 = Math.min(Math.ceil(r.x + r.width), view.x + view.width);
          const y1 = Math.min(Math.ceil(r.y + r.height), view.y + view.height);
          if (x1 <= x0 || y1 <= y0) continue;
          for (const [px, py] of [
            [x0, y0],
            [x1 - 1, y1 - 1],
            [Math.floor((x0 + x1) / 2), Math.floor((y0 + y1) / 2)],
          ] as const)
            expect(
              taken.some(
                (t) => px >= t.x && px < t.x + t.width && py >= t.y && py < t.y + t.height,
              ),
            ).toBe(true);
        }
      }),
    );
  });

  it("forgets the parts a drawn rect covers whole, and only those", () => {
    fc.assert(
      fc.property(fc.array(rect, { maxLength: 12 }), rect, (added, drawn) => {
        const work = new TileWork(256);
        for (const r of added) work.add(r);
        const before = work.areas();
        const dropped = work.drop(drawn);
        const after = work.areas();
        // What's left is what was there, less the parts inside `drawn`.
        const kept = before.filter((r) => !contains(drawn, r));
        expect(after).toEqual(kept);
        const area = (rs: Rect[]) => rs.reduce((sum, r) => sum + r.width * r.height, 0);
        expect(dropped).toBe(area(before) - area(after));
      }),
    );
  });

  it("starts at the centre and forgets what's left the view", () => {
    const work = new TileWork(100);
    work.add({ x: 0, y: 0, width: 300, height: 100 });
    expect(work.take({ x: 0, y: 0, width: 300, height: 100 }, { x: 150, y: 50 })).toEqual({
      x: 100,
      y: 0,
      width: 100,
      height: 100,
    });
    work.keepWithin({ x: 0, y: 0, width: 50, height: 50 });
    expect(work.areas()).toEqual([{ x: 0, y: 0, width: 50, height: 50 }]);
  });
});

describe("coverRects", () => {
  it("covers every rect given, within the bounds, with few rects", () => {
    const bounds = { x: 0, y: 0, width: 1000, height: 700 };
    fc.assert(
      fc.property(fc.array(rect, { maxLength: 200 }), (rects) => {
        const cover = coverRects(rects, bounds, 64);
        for (const c of cover) expect(contains(bounds, c)).toBe(true);
        for (const r of rects) {
          const x0 = Math.max(r.x, 0);
          const y0 = Math.max(r.y, 0);
          const x1 = Math.min(r.x + r.width, 1000);
          const y1 = Math.min(r.y + r.height, 700);
          if (x1 <= x0 || y1 <= y0) continue;
          const part = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
          // Every point of it is in some cover rect: check its corners and centre.
          for (const [px, py] of [
            [x0, y0],
            [x1 - 1e-6, y1 - 1e-6],
            [(x0 + x1) / 2, (y0 + y1) / 2],
          ] as const)
            expect(
              cover.some(
                (c) => px >= c.x && px <= c.x + c.width && py >= c.y && py <= c.y + c.height,
              ),
              JSON.stringify(part),
            ).toBe(true);
        }
        // At most one rect per row of cells per run: far fewer than 16 × 11 cells.
        expect(cover.length).toBeLessThanOrEqual(16 * 11);
      }),
    );
  });
});
