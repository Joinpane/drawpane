import { describe, expect, it } from "vitest";
import { boxCommands, fitCorners } from "../src/corner-geometry";
import { boxPath, boxPieces, flattenBox, hitsBox, pathData, type Radii } from "../src/corners";
import { parsePathCached } from "../src/vector/cache";
import { flattenPath } from "../src/vector/hit";
import table from "./fixtures/corner-vectors.json";

type Vector = {
  w: number;
  h: number;
  radii: [number, number, number, number];
  smoothing: number;
  corners: Array<[number, number, number]>;
  commands: Array<[string, ...number[]]>;
  figma: string | null;
};
const vectors = (table as unknown as { vectors: Vector[] }).vectors;

/** A path's outline as points, from its data. */
function polyline(d: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const ring of flattenPath(parsePathCached(d))) {
    for (let i = 0; i < ring.points.length; i += 2)
      out.push([ring.points[i] as number, ring.points[i + 1] as number]);
  }
  return out;
}

function distanceToPolyline(p: [number, number], poly: Array<[number, number]>): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i] as [number, number];
    const b = poly[(i + 1) % poly.length] as [number, number];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = dx * dx + dy * dy;
    const t =
      len > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len)) : 0;
    best = Math.min(best, Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy));
  }
  return best;
}

/** The furthest either outline strays from the other. */
function hausdorff(a: string, b: string): number {
  const pa = polyline(a);
  const pb = polyline(b);
  let worst = 0;
  for (const p of pa) worst = Math.max(worst, distanceToPolyline(p, pb));
  for (const p of pb) worst = Math.max(worst, distanceToPolyline(p, pa));
  return worst;
}

const label = (v: Vector) => `${v.w}x${v.h} r=${v.radii.join("/")} s=${v.smoothing}`;
const toData = (commands: Vector["commands"]) =>
  commands.map(([op, ...n]) => `${op}${n.join(" ")}`).join("");

describe("corner geometry", () => {
  it("reproduces every test vector (what any port must too)", () => {
    expect(vectors.length).toBeGreaterThan(450);
    const misses: string[] = [];
    for (const v of vectors) {
      const corners = fitCorners(v.w, v.h, v.radii, v.smoothing);
      const commands = boxCommands(v.w, v.h, v.radii, v.smoothing);
      const near = (a: number, b: number) => Math.abs(a - b) <= 1e-6;
      const cornersOk = corners.every((c, i) => {
        const [r, s, e] = v.corners[i] as [number, number, number];
        return near(c.radius, r) && near(c.smoothing, s) && near(c.extent, e);
      });
      const commandsOk =
        commands.length === v.commands.length &&
        commands.every(
          (c, i) =>
            c[0] === v.commands[i]?.[0] &&
            c.slice(1).every((n, k) => near(n as number, v.commands[i]?.[k + 1] as number)),
        );
      if (!cornersOk || !commandsOk) misses.push(label(v));
    }
    expect(misses).toEqual([]);
  });

  it("has every vector's outline within 0.02 px of Figma's own", () => {
    const fromFigma = vectors.filter((v) => v.figma !== null);
    expect(fromFigma.length).toBeGreaterThan(440);
    const misses: string[] = [];
    for (const v of fromFigma) {
      // Polylines from both flatten slightly differently: a hundredth of a pixel is nothing.
      const off = hausdorff(toData(v.commands), v.figma as string);
      if (off > 0.02) misses.push(`${label(v)}: ${off}`);
    }
    expect(misses).toEqual([]);
  });

  it("puts the control points where Figma does", () => {
    // 200 × 120, radius 30, iOS's 60%: Figma's numbers, to its five digits.
    const d = pathData(boxPath(200, 120, [30, 30, 30, 30], 0.6));
    expect(
      d.startsWith("M0 48C0 31.198 0 22.798 3.27 16.38C6.146 10.735 10.735 6.146 16.38 3.27"),
    ).toBe(true);
  });

  it("gives a uniform radius half the shorter side, and smoothing what's left", () => {
    const [tl] = fitCorners(100, 100, [40, 40, 40, 40], 0.6);
    expect(tl.radius).toBe(40);
    expect(tl.extent).toBeCloseTo(50, 9);
    expect(tl.smoothing).toBeCloseTo(0.25, 9);
    // No room left at all: a plain circle.
    expect(fitCorners(100, 100, [50, 50, 50, 50], 1)[0].smoothing).toBe(0);
    expect(fitCorners(100, 100, [500, 500, 500, 500], 1)[0].radius).toBe(50);
  });

  it("lets a corner beside square ones reach past half the shorter side, as Figma does", () => {
    const [tl, tr] = fitCorners(200, 120, [200, 0, 200, 0], 0);
    expect(tl.radius).toBe(120);
    expect(tr.radius).toBe(0);
    // Shared by radius along each edge: 100 against 10 on a 120 edge.
    expect(fitCorners(200, 120, [100, 10, 10, 10], 0.6)[3].extent).toBeCloseTo(120 / 11, 9);
  });

  it("treats a missing or out-of-range smoothing as Figma would", () => {
    expect(pathData(boxPath(80, 60, [10, 10, 10, 10]))).toBe(
      pathData(boxPath(80, 60, [10, 10, 10, 10], 0)),
    );
    expect(pathData(boxPath(80, 60, [10, 10, 10, 10], 3))).toBe(
      pathData(boxPath(80, 60, [10, 10, 10, 10], 1)),
    );
    expect(pathData(boxPath(80, 60, [10, 10, 10, 10], -1))).toBe(
      pathData(boxPath(80, 60, [10, 10, 10, 10], 0)),
    );
  });

  it("caches one outline per size, radii and smoothing", () => {
    expect(boxPath(64, 32, [8, 8, 8, 8], 0.6)).toBe(boxPath(64, 32, [8, 8, 8, 8], 0.6));
    expect(boxPath(64, 32, [8, 8, 8, 8], 0.6)).not.toBe(boxPath(64, 32, [8, 8, 8, 8], 0.5));
  });

  it("hits inside the curve and misses the corner it cuts off", () => {
    const radii: Radii = [30, 30, 30, 30];
    // Smoothing keeps the middle of the corner on the same circle and eases in further along the
    // edge: 25 px along it, the plain corner is 0.51 px in from the side, the smoothed one 0.78.
    expect(hitsBox(200, 120, radii, 0, 0.65, 25, 0)).toBe(true);
    expect(hitsBox(200, 120, radii, 0.6, 0.65, 25, 0)).toBe(false);
    const diagonal = 30 - 30 * Math.SQRT1_2;
    expect(hitsBox(200, 120, radii, 0.6, diagonal + 0.05, diagonal + 0.05, 0)).toBe(true);
    expect(hitsBox(200, 120, radii, 0.6, diagonal - 0.05, diagonal - 0.05, 0)).toBe(false);
    expect(hitsBox(200, 120, radii, 0.6, 1, 1, 0)).toBe(false);
    expect(hitsBox(200, 120, radii, 0.6, 1, 1, 10)).toBe(false);
    expect(hitsBox(200, 120, radii, 0.6, 1, 1, 11.2)).toBe(true);
    expect(hitsBox(200, 120, radii, 0.6, 100, 60, 0)).toBe(true);
    expect(hitsBox(200, 120, radii, 0.6, -2, 60, 1)).toBe(false);
  });

  it("splits the outline into edges and corners for dashes, the same length as the outline", () => {
    const pieces = boxPieces(200, 120, [30, 30, 30, 30], 0.6);
    // Each corner's easing curves and arc are pieces of their own, as Figma dashes them.
    expect(pieces.map((p) => p.kind)).toEqual(
      Array.from({ length: 4 }, () => ["line", "cubic", "cubic", "cubic"]).flat(),
    );
    expect(pieces[0]).toMatchObject({ x0: 48, y0: 0, x1: 152, y1: 0 });
    const poly = flattenBox(boxPath(200, 120, [30, 30, 30, 30], 0.6), 64);
    let perimeter = 0;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i] as { x: number; y: number };
      const b = poly[(i + 1) % poly.length] as { x: number; y: number };
      perimeter += Math.hypot(b.x - a.x, b.y - a.y);
    }
    const total = pieces.reduce((sum, p) => sum + p.length, 0);
    expect(total).toBeCloseTo(perimeter, 1);
  });
});
