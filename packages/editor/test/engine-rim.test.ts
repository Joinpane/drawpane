/**
 * A box's fill under an opaque inside stroke stops halfway under the stroke's band
 * (`engine/rim.ts`), so the box's anti-aliased edge is the stroke's alone. Drawn as the canvas
 * draws it, fill and stroke both ended on the edge and an edge pixel got 2c - c² of coverage
 * (the shadcn Carousel button's 98/255 where Figma has 64).
 */
import { type EngineModule, RenderEngine } from "@drawpane/engine";
import { built, loadNodeEngine } from "@drawpane/engine/node";
import type { PathEntry } from "@drawpane/engine/wire";
import { type NodeRecord, ROOT_ID } from "@drawpane/model";
import { beforeAll, describe, expect, it } from "vitest";
import { boxCommands } from "../src/corner-geometry";
import { Doc } from "../src/doc";
import { DisplayListBuilder } from "../src/engine/display-list";
import { underRim } from "../src/engine/rim";
import { Scene } from "../src/scene";
import type { TextMeasurer } from "../src/text";

const measurer: TextMeasurer = {
  width: (_font, t) => t.length * 9,
  metrics: () => ({ ascent: 14, descent: 4 }),
};

const box = (props: Record<string, unknown>, type: "rect" | "frame" | "ellipse" = "rect") => {
  const doc = new Doc();
  doc.apply([
    { op: "create", id: "p1", type: "page", parent: ROOT_ID, key: "a0", props: {} },
    {
      op: "create",
      id: "b",
      type,
      parent: "p1",
      key: "a0",
      props: { x: 2, y: 2, width: 28, height: 28, ...props },
    },
  ]);
  return doc;
};

/** Points along a box outline (cubics sampled), in order. */
function outline(w: number, h: number, radii: number[], smoothing: number, at = [0, 0]) {
  const [ox, oy] = at as [number, number];
  const pts: Array<[number, number]> = [];
  let last: [number, number] = [0, 0];
  for (const c of boxCommands(w, h, radii as [number, number, number, number], smoothing)) {
    if (c[0] === "M" || c[0] === "L") {
      last = [c[1] + ox, c[2] + oy];
      pts.push(last);
    } else if (c[0] === "C") {
      const [x0, y0] = last;
      const [x1, y1, x2, y2, x3, y3] = [
        c[1] + ox,
        c[2] + oy,
        c[3] + ox,
        c[4] + oy,
        c[5] + ox,
        c[6] + oy,
      ];
      for (let k = 1; k <= 32; k++) {
        const t = k / 32;
        const u = 1 - t;
        const b0 = u * u * u;
        const b1 = 3 * u * u * t;
        const b2 = 3 * u * t * t;
        const b3 = t * t * t;
        pts.push([b0 * x0 + b1 * x1 + b2 * x2 + b3 * x3, b0 * y0 + b1 * y1 + b2 * y2 + b3 * y3]);
      }
      last = [x3, y3];
    }
  }
  return pts;
}

/** The distance from `p` to a closed polyline, negative outside it (even-odd). */
function signedDistance(p: [number, number], poly: Array<[number, number]>): number {
  let inside = false;
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i] as [number, number];
    const [xj, yj] = poly[j] as [number, number];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi)
      inside = !inside;
    const dx = xj - xi;
    const dy = yj - yi;
    const t = Math.max(
      0,
      Math.min(1, ((p[0] - xi) * dx + (p[1] - yi) * dy) / (dx * dx + dy * dy || 1)),
    );
    best = Math.min(best, Math.hypot(p[0] - (xi + dx * t), p[1] - (yi + dy * t)));
  }
  return inside ? best : -best;
}

describe("underRim", () => {
  const node = (props: Record<string, unknown>) => box(props).get("b") as NodeRecord;
  const stroked = { strokes: [{ type: "solid", color: "#e5e5e5" }], strokeAlign: "inside" };

  it("shrinks the fill by half an opaque inside stroke, smoothed corners inside the band", () => {
    for (const [radius, smoothing, weight] of [
      [9999, 0, 1],
      [8, 0.6, 1],
      [20, 1, 2],
      [3, 0.6, 4],
      [0, 0, 1],
    ] as const) {
      const entry = underRim(
        node({
          ...stroked,
          cornerRadius: radius,
          cornerSmoothing: smoothing,
          strokeWeight: weight,
        }),
        28,
        28,
      ) as Extract<PathEntry, { kind: "box" }>;
      expect(entry.kind).toBe("box");
      const outer = outline(28, 28, [radius, radius, radius, radius], smoothing);
      const inner = outline(entry.w, entry.h, [...entry.radii], entry.smoothing, [
        entry.x,
        entry.y,
      ]);
      expect(inner.length).toBeGreaterThanOrEqual(4);
      // Every point of the fill's edge lies inside the stroke's band, a quarter of the stroke's
      // width or more from either of its edges.
      for (const p of inner) {
        const d = signedDistance(p, outer);
        expect(d, `${radius}/${smoothing}/${weight} at ${p}`).toBeGreaterThanOrEqual(weight / 4);
        expect(d).toBeLessThanOrEqual((weight * 3) / 4);
      }
    }
  });

  it("leaves fills alone unless an opaque, even, undashed inside stroke covers the rim", () => {
    for (const props of [
      { ...stroked, strokeAlign: "center" },
      { ...stroked, strokes: [{ type: "solid", color: "#e5e5e580" }] },
      { ...stroked, strokes: [{ type: "solid", color: "#e5e5e5", opacity: 0.5 }] },
      { ...stroked, strokeDashes: [2, 2] },
      { ...stroked, strokeWeights: [1, 2, 1, 1] },
      { strokes: [], strokeAlign: "inside" },
    ])
      expect(underRim(node(props), 28, 28), JSON.stringify(props)).toBeUndefined();
    expect(underRim(node({ ...stroked, strokeWeight: 28 }), 28, 28)).toBeNull();
  });
});

describe.skipIf(!built("worker") && !process.env.CI)("a filled box with an inside stroke", () => {
  let mod: EngineModule;
  beforeAll(async () => {
    mod = await loadNodeEngine("worker");
  });

  const alpha = (doc: Doc) => {
    const engine = new RenderEngine(mod);
    try {
      expect(engine.apply(new DisplayListBuilder(new Scene(doc), measurer).build("p1")).ok).toBe(
        true,
      );
      const r = engine.renderCpu(64, 64, { zoom: 2, x: 0, y: 0, dpr: 1 }, [0, 0, 0, 0]);
      if (!r.ok) throw new Error(r.message);
      return [...r.value.pixels].filter((_, i) => i % 4 === 3);
    } finally {
      engine.dispose();
    }
  };

  for (const [name, props, type] of [
    ["the shadcn Carousel button (a circle)", { cornerRadius: 9999 }, "frame"],
    ["a smoothed box", { cornerRadius: 8, cornerSmoothing: 0.6 }, "rect"],
    ["an ellipse", {}, "ellipse"],
  ] as const) {
    it(`covers its edge once: ${name}`, () => {
      const fill = { fills: [{ type: "solid", color: "#f5f5f5" }], ...props };
      const alone = alpha(box(fill, type));
      const bordered = alpha(
        box(
          {
            ...fill,
            strokes: [{ type: "solid", color: "#e5e5e5" }],
            strokeWeight: 1,
            strokeAlign: "inside",
          },
          type,
        ),
      );
      // The edge as the fill alone covers it; stroked, an edge pixel the fill covers c of
      // came out 2c - c².
      expect(
        Math.max(...bordered.map((a, i) => Math.abs(a - (alone[i] as number)))),
      ).toBeLessThanOrEqual(1);
    });
  }
});
