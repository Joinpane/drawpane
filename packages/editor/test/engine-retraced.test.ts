/**
 * Closed subpaths that only retrace themselves (an icon's line closed by an import, like the
 * shadcn kit's Lucide X instances, `M8 0 L0 8 Z M0 0 L8 8 Z`) are stroked open by the builder
 * (`engine/retraced.ts`): stroked closed, their two outlines cover the same ground and the
 * engine's analytic coverage counted their anti-aliased edges twice, drawing the line about half
 * a pixel wider and hard-edged.
 */
import { type EngineModule, RenderEngine } from "@drawpane/engine";
import { built, loadNodeEngine } from "@drawpane/engine/node";
import { type PathData, VERB } from "@drawpane/engine/wire";
import { ROOT_ID } from "@drawpane/model";
import { beforeAll, describe, expect, it } from "vitest";
import { Doc } from "../src/doc";
import { DisplayListBuilder } from "../src/engine/display-list";
import { encodeLayer } from "../src/engine/layer";
import { openRetraced } from "../src/engine/retraced";
import { svgPathData } from "../src/engine/svg-path";
import { Scene } from "../src/scene";
import type { TextMeasurer } from "../src/text";

/** A path as SVG-like text, to compare. */
const text = (p: PathData | null) => {
  if (!p) return null;
  const out: string[] = [];
  let c = 0;
  for (const v of p.verbs) {
    const n =
      v === VERB.move || v === VERB.line ? 2 : v === VERB.quad ? 4 : v === VERB.cubic ? 6 : 0;
    const letter = ["M", "L", "Q", "C", "Z"][v] as string;
    out.push(`${letter}${p.coords.slice(c, c + n).join(" ")}`);
    c += n;
  }
  return out.join(" ");
};

describe("openRetraced", () => {
  it("opens closed lines that only go out and back", () => {
    expect(text(openRetraced(svgPathData("M8 0 L0 8 Z M0 0 L8 8 Z")))).toBe("M8 0 L0 8 M0 0 L8 8");
  });

  it("opens a retraced polyline at its far end, and one closed back onto its start", () => {
    expect(text(openRetraced(svgPathData("M0 0 L4 4 L8 0 L4 4 Z")))).toBe("M0 0 L4 4 L8 0");
    expect(text(openRetraced(svgPathData("M0 0 L4 4 L0 0 Z")))).toBe("M0 0 L4 4");
    expect(text(openRetraced(svgPathData("M0 0 L10 0 L10 10 L10 0 Z")))).toBe("M0 0 L10 0 L10 10");
  });

  it("keeps everything else in place, verb for verb", () => {
    expect(
      text(openRetraced(svgPathData("M0 0 L10 0 L10 10 Z M2 2 L6 6 Z M0 20 C4 24 8 24 12 20"))),
    ).toBe("M0 0 L10 0 L10 10 Z M2 2 L6 6 M0 20 C4 24 8 24 12 20");
  });

  it("leaves paths with nothing retraced alone", () => {
    for (const d of [
      "M8 0 L0 8 M0 0 L8 8", // open
      "M0 0 L10 0 L10 10 Z", // a triangle
      "M0 0 L10 0 L10 10 L10 0 L5 5 Z", // retraces part of itself only
      "M0 0 Q5 5 10 0 Q5 5 0 0 Z", // curves
      "M3 3 Z", // a point
    ])
      expect(openRetraced(svgPathData(d)), d).toBeNull();
  });
});

const measurer: TextMeasurer = {
  width: (_font, t) => t.length * 9,
  metrics: () => ({ ascent: 14, descent: 4 }),
};

/** A document with one 8 x 8 path layer stroked 1.5 wide. */
function docWith(
  pathData: string,
  join: "round" | "miter",
  cap: "round" | "none",
  color = "#0a0a0a",
): Doc {
  const doc = new Doc();
  doc.apply([
    { op: "create", id: "p1", type: "page", parent: ROOT_ID, key: "a0", props: {} },
    {
      op: "create",
      id: "x",
      type: "path",
      parent: "p1",
      key: "a0",
      props: {
        x: 4,
        y: 4,
        width: 8,
        height: 8,
        pathData,
        strokes: [{ type: "solid", color }],
        strokeWeight: 1.5,
        strokeAlign: "center",
        strokeJoin: join,
        strokeCap: cap,
        // The kit's instances carry a fill too: a retraced path encloses nothing.
        fills: [{ type: "solid", color }],
      },
    },
  ]);
  return doc;
}

describe("a retraced closed path's stroke record", () => {
  const strokes = (doc: Doc) => {
    const node = doc.get("x");
    if (!node) throw new Error("no layer");
    const { record } = encodeLayer(node, {
      scene: new Scene(doc),
      measurer,
      image: () => undefined,
      glyph: () => 0,
      whole: null,
      hidden: new Set(),
    });
    return record.ops.filter((op) => op.op === "stroke").map((op) => record.paths[op.path]);
  };
  // A ring with a tick across it, as the iOS kit's gauges hold their vector networks.
  const gauge = "M0 0 L8 0 L8 8 L0 8 Z M4 0 L4 8 L4 0 Z";

  it("stays one stroke over the whole path, so a translucent paint covers overlaps once", () => {
    const paths = strokes(docWith(gauge, "round", "round", "#ffffff12"));
    expect(paths).toHaveLength(1);
    const entry = paths[0];
    expect(entry?.kind === "path" && text(entry.path)).toBe("M0 0 L8 0 L8 8 L0 8 Z M4 0 L4 8");
  });

  it("stays closed when the layer's cap isn't the end its join makes", () => {
    for (const [join, cap] of [
      ["miter", "round"],
      ["round", "none"],
    ] as const) {
      const entry = strokes(docWith(gauge, join, cap))[0];
      expect(entry?.kind === "path" && text(entry.path), `${join} join, ${cap} cap`).toBe(
        "M0 0 L8 0 L8 8 L0 8 Z M4 0 L4 8 L4 0 Z",
      );
    }
  });
});

describe.skipIf(!built("worker") && !process.env.CI)("a retraced closed path's stroke", () => {
  let mod: EngineModule;
  beforeAll(async () => {
    mod = await loadNodeEngine("worker");
  });

  /** The CPU frame of the layer at 2x. */
  const draw = (pathData: string, join: "round" | "miter", cap: "round" | "none") => {
    const builder = new DisplayListBuilder(new Scene(docWith(pathData, join, cap)), measurer);
    const engine = new RenderEngine(mod);
    try {
      expect(engine.apply(builder.build("p1")).ok).toBe(true);
      const r = engine.renderCpu(32, 32, { zoom: 2, x: 0, y: 0, dpr: 1 }, [0, 0, 0, 0]);
      if (!r.ok) throw new Error(r.message);
      return Buffer.from(r.value.pixels);
    } finally {
      engine.dispose();
    }
  };

  it("covers what the open lines with round caps cover, under a round join", () => {
    const closed = draw("M8 0 L0 8 Z M0 0 L8 8 Z", "round", "round");
    const open = draw("M8 0 L0 8 M0 0 L8 8", "round", "round");
    // Stroked closed, a 45° edge pixel the open stroke covers 157/255 of counted twice (255).
    expect(closed.equals(open)).toBe(true);
  });

  it("covers what the open lines with butt caps cover, under a miter join", () => {
    const closed = draw("M8 0 L0 8 Z M0 0 L8 8 Z", "miter", "none");
    const open = draw("M8 0 L0 8 M0 0 L8 8", "miter", "none");
    expect(closed.equals(open)).toBe(true);
  });
});
