import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { apply, localMatrix, type Matrix, type Point } from "../src/geometry";
import {
  type Anchor,
  anchorKind,
  cubicAt,
  cubicBounds,
  deleteAnchors,
  ellipsePath,
  fitToNode,
  hitPathData,
  insertAnchor,
  nearestOnPath,
  parsePath,
  pathBounds,
  rectPath,
  segmentOf,
  segments,
  serializePath,
  setHandle,
  snap45,
  toggleSmooth,
  transformPath,
  type VectorPath,
} from "../src/vector";

// ---------------------------------------------------------------------------
// Generators

/** Coordinates on the 3-decimal grid the serializer writes. */
const coord = fc.integer({ min: -200_000, max: 200_000 }).map((n) => n / 1000);
const point = fc.record({ x: coord, y: coord });
const anchorArb: fc.Arbitrary<Anchor> = fc.record({
  x: coord,
  y: coord,
  in: fc.option(point, { nil: null }),
  out: fc.option(point, { nil: null }),
});
const subpathArb = fc
  .record({ anchors: fc.array(anchorArb, { minLength: 2, maxLength: 8 }), closed: fc.boolean() })
  // Coincident neighbours are legal but merge on a round trip; keep them apart.
  .filter(({ anchors }) =>
    anchors.every((a, i) => {
      const b = anchors[(i + 1) % anchors.length] as Anchor;
      return Math.hypot(a.x - b.x, a.y - b.y) > 0.01;
    }),
  )
  // Handles that sit exactly on their anchor serialize as "no handle", and an
  // open subpath's ends have no segment for their outer handle to shape.
  .map(({ anchors, closed }) => ({
    closed,
    anchors: anchors.map((a, i) => ({
      ...a,
      in: a.in && (a.in.x !== a.x || a.in.y !== a.y) && (closed || i > 0) ? a.in : null,
      out:
        a.out && (a.out.x !== a.x || a.out.y !== a.y) && (closed || i < anchors.length - 1)
          ? a.out
          : null,
    })),
  }));
const pathArb: fc.Arbitrary<VectorPath> = fc.array(subpathArb, { minLength: 1, maxLength: 3 });

const close = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;

function samples(path: VectorPath, per = 200): Point[] {
  const out: Point[] = [];
  for (const { a, b } of segments(path)) {
    const c = segmentOf(a, b);
    for (let k = 0; k <= per; k++) out.push(cubicAt(c, k / per));
  }
  for (const sub of path) for (const a of sub.anchors) out.push(a);
  return out;
}

// ---------------------------------------------------------------------------

describe("SVG path parsing", () => {
  it("reads every command, absolute and relative", () => {
    expect(serializePath(parsePath("M10 10 h 20 v 20 h -20 z"))).toBe("M10 10L30 10L30 30L10 30Z");
    expect(serializePath(parsePath("m10 10 l20 0 0 20 -20 0 z"))).toBe("M10 10L30 10L30 30L10 30Z");
    expect(serializePath(parsePath("M10 80 C 40 10, 65 10, 95 80 S 150 150, 180 80"))).toBe(
      "M10 80C40 10 65 10 95 80C125 150 150 150 180 80",
    );
    // Quadratics elevate exactly to cubics; T reflects the previous control point.
    expect(serializePath(parsePath("M0 0 Q 30 60 60 0 T 120 0"))).toBe(
      "M0 0C20 40 40 40 60 0C80 -40 100 -40 120 0",
    );
    // Implicit repeats: extra pairs after M are lines.
    expect(serializePath(parsePath("M0 0 10 0 10 10"))).toBe("M0 0L10 0L10 10");
    // Compact numbers and flags.
    expect(serializePath(parsePath("M1.5.5L-1-2e1z"))).toBe("M1.5 0.5L-1 -20Z");
    expect(serializePath(parsePath("M0,0a1,1 0 00 1,1"))).toBe("M0 0C0 0.552 0.448 1 1 1");
  });

  it("starts a new subpath at the old start after Z", () => {
    const p = parsePath("M10 10 L20 10 L20 20 Z l 5 0 l 0 5");
    expect(p).toHaveLength(2);
    expect(p[1]?.anchors[0]).toMatchObject({ x: 10, y: 10 });
    expect(p[1]?.anchors[2]).toMatchObject({ x: 15, y: 15 });
  });

  it("merges a closing curve that lands on the first anchor", () => {
    const p = parsePath("M0 0 C 10 -10 20 -10 30 0 C 20 10 10 10 0 0 Z");
    expect(p[0]?.anchors).toHaveLength(2);
    expect(p[0]?.closed).toBe(true);
    expect(p[0]?.anchors[0]?.in).toEqual({ x: 10, y: 10 });
  });

  it("converts arcs to cubics that stay on the ellipse", () => {
    const p = parsePath("M100 50 A 50 50 0 1 1 0 50 A 50 50 0 1 1 100 50 Z");
    for (const q of samples(p, 50)) expect(Math.hypot(q.x - 50, q.y - 50)).toBeCloseTo(50, 1);
    // Rotated, scaled-up radii: the endpoint is still exact.
    const r = parsePath("M0 0 A 1 2 30 0 1 40 10");
    expect(r[0]?.anchors.at(-1)).toMatchObject({ x: 40, y: 10 });
  });

  it("keeps what it read before an error, like browsers", () => {
    expect(serializePath(parsePath("M0 0 L10 10 L 20 oops 30"))).toBe("M0 0L10 10");
    expect(parsePath("")).toEqual([]);
    expect(parsePath("L 10 10")).toEqual([]);
  });

  it("round-trips: parse(serialize(p)) equals p", () => {
    fc.assert(
      fc.property(pathArb, (path) => {
        const d = serializePath(path);
        const back = parsePath(d);
        expect(back).toHaveLength(path.length);
        back.forEach((sub, s) => {
          const orig = path[s];
          expect(sub.closed).toBe(orig?.closed);
          expect(sub.anchors).toHaveLength(orig?.anchors.length ?? -1);
          sub.anchors.forEach((a, i) => {
            const o = orig?.anchors[i] as Anchor;
            expect(close(a.x, o.x) && close(a.y, o.y)).toBe(true);
            if (o.out) expect(a.out ?? { x: a.x, y: a.y }).toEqual(o.out);
            if (o.in) expect(a.in ?? { x: a.x, y: a.y }).toEqual(o.in);
          });
        });
        // Serializing again is stable.
        expect(serializePath(back)).toBe(d);
      }),
      { numRuns: 300 },
    );
  });

  it("round-trips relative and shorthand commands through absolute form", () => {
    const cmd = fc.oneof(
      fc.tuple(fc.constantFrom("l", "L", "m", "M", "t", "T"), coord, coord).map((t) => t.join(" ")),
      fc.tuple(fc.constantFrom("h", "H", "v", "V"), coord).map((t) => t.join(" ")),
      fc
        .tuple(fc.constantFrom("c", "C"), coord, coord, coord, coord, coord, coord)
        .map((t) => t.join(" ")),
      fc
        .tuple(fc.constantFrom("s", "S", "q", "Q"), coord, coord, coord, coord)
        .map((t) => t.join(" ")),
      fc
        .tuple(
          fc.constantFrom("a", "A"),
          fc.integer({ min: 1, max: 100 }),
          fc.integer({ min: 1, max: 100 }),
          fc.integer({ min: -180, max: 180 }),
          fc.constantFrom("0", "1"),
          fc.constantFrom("0", "1"),
          coord,
          coord,
        )
        .map((t) => t.join(" ")),
      fc.constant("z"),
    );
    const nums = (s: string) => s.match(/-?[\d.]+(?:e-?\d+)?/g)?.map(Number) ?? [];
    fc.assert(
      fc.property(point, fc.array(cmd, { maxLength: 12 }), (start, cmds) => {
        const d = `M${start.x} ${start.y} ${cmds.join(" ")}`;
        const once = parsePath(d);
        const onceD = serializePath(once);
        const twice = parsePath(onceD);
        // The same structure; coordinates agree up to the serializer's rounding.
        expect(twice.map((s) => [s.closed, s.anchors.length])).toEqual(
          once.map((s) => [s.closed, s.anchors.length]),
        );
        const a = nums(serializePath(twice));
        const b = nums(onceD);
        expect(a.length).toBe(b.length);
        a.forEach((n, i) => {
          expect(Math.abs(n - (b[i] ?? 0))).toBeLessThan(0.0021);
        });
      }),
      { numRuns: 300 },
    );
  });
});

describe("bounds", () => {
  it("uses curve extrema, not control points", () => {
    // A symmetric arch: control points reach y = -100, the curve only -75.
    const b = pathBounds(parsePath("M0 0 C 0 -100 100 -100 100 0"));
    expect(b?.x).toBe(0);
    expect(b?.width).toBe(100);
    expect(b?.y).toBeCloseTo(-75, 9);
    expect(b?.height).toBeCloseTo(75, 9);
  });

  it("contains every point on the path and is tight on each side", () => {
    fc.assert(
      fc.property(pathArb, (path) => {
        const b = pathBounds(path);
        if (!b) return;
        const pts = samples(path, 400);
        const eps = 1e-6 * (1 + Math.max(b.width, b.height));
        let minX = Number.POSITIVE_INFINITY;
        let minY = Number.POSITIVE_INFINITY;
        let maxX = Number.NEGATIVE_INFINITY;
        let maxY = Number.NEGATIVE_INFINITY;
        for (const p of pts) {
          minX = Math.min(minX, p.x);
          minY = Math.min(minY, p.y);
          maxX = Math.max(maxX, p.x);
          maxY = Math.max(maxY, p.y);
        }
        // Contains every sampled point...
        expect(minX).toBeGreaterThanOrEqual(b.x - eps);
        expect(minY).toBeGreaterThanOrEqual(b.y - eps);
        expect(maxX).toBeLessThanOrEqual(b.x + b.width + eps);
        expect(maxY).toBeLessThanOrEqual(b.y + b.height + eps);
        // ...and is tight: sampling at 1/400 misses an extremum by a tiny fraction.
        const slack = 1e-3 * (1 + Math.max(b.width, b.height));
        expect(minX - b.x).toBeLessThan(slack);
        expect(minY - b.y).toBeLessThan(slack);
        expect(b.x + b.width - maxX).toBeLessThan(slack);
        expect(b.y + b.height - maxY).toBeLessThan(slack);
      }),
      { numRuns: 300 },
    );
  });

  it("matches the cubic solver on single segments", () => {
    const c = {
      p0: { x: 0, y: 0 },
      p1: { x: 50, y: 80 },
      p2: { x: -30, y: 80 },
      p3: { x: 20, y: 0 },
    };
    const b = cubicBounds(c);
    const pts = Array.from({ length: 2001 }, (_, k) => cubicAt(c, k / 2000));
    expect(b.y + b.height).toBeCloseTo(Math.max(...pts.map((p) => p.y)), 4);
    expect(b.x).toBeCloseTo(Math.min(...pts.map((p) => p.x)), 4);
  });
});

describe("transforms and fitting", () => {
  const unitish = fc.double({ min: -3, max: 3, noNaN: true });
  const matrixArb: fc.Arbitrary<Matrix> = fc
    .tuple(unitish, unitish, unitish, unitish, coord, coord)
    .map(([a, b, c, d, e, f]): Matrix => [a, b, c, d, e, f]);

  it("maps every point on the curve, since Béziers are affine-invariant", () => {
    fc.assert(
      fc.property(pathArb, matrixArb, fc.double({ min: 0, max: 1, noNaN: true }), (path, m, t) => {
        const moved = transformPath(path, m);
        const a = [...segments(path)];
        const b = [...segments(moved)];
        a.forEach((seg, k) => {
          const other = b[k];
          if (!other) return;
          const p = apply(m, cubicAt(segmentOf(seg.a, seg.b), t));
          const q = cubicAt(segmentOf(other.a, other.b), t);
          expect(Math.hypot(p.x - q.x, p.y - q.y)).toBeLessThan(1e-6 * (1 + Math.hypot(p.x, p.y)));
        });
      }),
    );
  });

  it("re-fits a node's box to the path without moving it on screen", () => {
    fc.assert(
      fc.property(
        pathArb,
        fc.integer({ min: -180, max: 180 }),
        fc.boolean(),
        fc.boolean(),
        (path, rotation, flipX, flipY) => {
          const box = { x: 30, y: -40, width: 120, height: 80, rotation, flipX, flipY };
          const node = { id: "n", type: "path" as const, parent: "p", key: "a0", props: box };
          const before = localMatrix(box);
          const fitted = fitToNode(node, path);
          const after = localMatrix({ ...fitted, rotation, flipX, flipY });
          const local = parsePath(fitted.pathData);
          const b = pathBounds(local);
          // Normalized: the path starts at 0,0 and fills its box.
          expect(Math.abs(b?.x ?? 1)).toBeLessThanOrEqual(0.001);
          expect(Math.abs(b?.y ?? 1)).toBeLessThanOrEqual(0.001);
          expect(Math.abs((b?.width ?? 0) - fitted.width)).toBeLessThanOrEqual(0.002);
          expect(Math.abs((b?.height ?? 0) - fitted.height)).toBeLessThanOrEqual(0.002);
          // Every anchor lands where it was.
          path.forEach((sub, s) => {
            sub.anchors.forEach((a, i) => {
              const p = apply(before, a);
              const q = apply(after, local[s]?.anchors[i] as Anchor);
              expect(Math.hypot(p.x - q.x, p.y - q.y)).toBeLessThan(0.01);
            });
          });
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe("editing", () => {
  const curve = parsePath("M0 0 C 0 -100 100 -100 100 0 L 100 50");

  it("adds an anchor without changing the shape", () => {
    const { path, ref } = insertAnchor(curve, 0, 0, 0.3);
    expect(ref).toEqual({ s: 0, i: 1 });
    expect(path[0]?.anchors).toHaveLength(4);
    const orig = segmentOf(curve[0]?.anchors[0] as Anchor, curve[0]?.anchors[1] as Anchor);
    for (let k = 0; k <= 20; k++) {
      const near = nearestOnPath(path, cubicAt(orig, k / 20));
      expect(near?.distance ?? 1).toBeLessThan(1e-6);
    }
    // On a straight segment the new anchor has no handles.
    const line = insertAnchor(curve, 0, 1, 0.5);
    expect(line.path[0]?.anchors[2]).toEqual({ x: 100, y: 25, in: null, out: null });
  });

  it("deletes anchors and drops subpaths that become too short", () => {
    const tri = parsePath("M0 0 L10 0 L5 10 Z");
    expect(serializePath(deleteAnchors(tri, new Set(["0:1"])))).toBe("M0 0L5 10Z");
    expect(deleteAnchors(tri, new Set(["0:1", "0:2"]))).toEqual([]);
  });

  it("toggles corner and smooth", () => {
    const open = parsePath("M0 0 L10 0 L10 10");
    const smooth = toggleSmooth(open, { s: 0, i: 1 });
    expect(anchorKind(smooth[0]?.anchors[1] as Anchor)).toBe("mirrored");
    const back = toggleSmooth(smooth, { s: 0, i: 1 });
    expect(anchorKind(back[0]?.anchors[1] as Anchor)).toBe("corner");
  });

  it("mirrors handles unless broken", () => {
    const p = parsePath("M0 0 C 10 0 20 -10 30 0 C 40 10 50 0 60 0");
    expect(anchorKind(p[0]?.anchors[1] as Anchor)).toBe("mirrored");
    const mirrored = setHandle(p, { s: 0, i: 1 }, "out", { x: 30, y: 20 }, "mirror");
    expect(mirrored[0]?.anchors[1]?.in).toEqual({ x: 30, y: -20 });
    const free = setHandle(p, { s: 0, i: 1 }, "out", { x: 30, y: 20 }, "free");
    expect(free[0]?.anchors[1]?.in).toEqual({ x: 20, y: -10 });
    expect(anchorKind(free[0]?.anchors[1] as Anchor)).toBe("free");
  });

  it("snaps to 45 degrees", () => {
    const p = snap45({ x: 0, y: 0 }, { x: 10, y: 9 });
    expect(p.x).toBeCloseTo(p.y, 9);
    expect(snap45({ x: 0, y: 0 }, { x: 10, y: 1 })).toEqual({ x: 10, y: 0 });
  });
});

describe("shapes and hit testing", () => {
  it("draws rounded rectangles and ellipses within their box", () => {
    const r = rectPath(100, 60, [10, 20, 0, 40]);
    expect(pathBounds(r)).toEqual({ x: 0, y: 0, width: 100, height: 60 });
    // Three rounded corners (two anchors each) and one sharp corner.
    expect(r[0]?.anchors.length).toBe(7);
    const e = ellipsePath(80, 40);
    const b = pathBounds(e);
    expect(b?.width).toBeCloseTo(80, 9);
    expect(b?.height).toBeCloseTo(40, 9);
    for (const p of samples(e, 40)) {
      const v = ((p.x - 40) / 40) ** 2 + ((p.y - 20) / 20) ** 2;
      expect(Math.abs(v - 1)).toBeLessThan(0.002);
    }
  });

  it("hits fills by winding rule and open paths only on their stroke", () => {
    const ring = "M0 0H100V100H0Z M25 25H75V75H25Z";
    const opts = { fill: true, fillRule: "nonzero" as const, strokeReach: 1 };
    expect(hitPathData(ring, { x: 50, y: 50 }, opts)).toBe(true);
    expect(hitPathData(ring, { x: 50, y: 50 }, { ...opts, fillRule: "evenodd" })).toBe(false);
    expect(hitPathData(ring, { x: 10, y: 50 }, { ...opts, fillRule: "evenodd" })).toBe(true);
    const open = "M0 0 L100 0 L100 100";
    expect(hitPathData(open, { x: 60, y: 40 }, opts)).toBe(false);
    expect(hitPathData(open, { x: 60, y: 0.5 }, opts)).toBe(true);
    expect(hitPathData(open, { x: 60, y: 4 }, { ...opts, strokeReach: 5 })).toBe(true);
  });
});
