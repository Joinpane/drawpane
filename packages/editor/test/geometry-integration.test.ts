import { Paint, ROOT_ID } from "@drawpane/model";
import { describe, expect, it } from "vitest";
import { Doc } from "../src/doc";
import { encodeLayer } from "../src/engine/layer";
import { cssGradient, gradientMatrix } from "../src/gradients";
import { Scene } from "../src/scene";
import { exportSvg } from "../src/svg";
import type { TextMeasurer } from "../src/text";

const measure: TextMeasurer = {
  missing: () => true,
  width: () => 16,
  shape: () => ({
    glyphs: [{ path: null, d: "M0 0H500V800H0Z", x: 0, y: 0, cluster: 0 }],
    width: 16,
    scale: 0.02,
  }),
};

function sceneFor(type: "rect" | "text", props: Record<string, unknown>) {
  const doc = new Doc();
  doc.apply([
    { op: "create", id: "p", type: "page", parent: ROOT_ID, key: "a0", props: {} },
    {
      op: "create",
      id: "node",
      type,
      parent: "p",
      key: "a0",
      props: { x: 0, y: 0, width: 100, height: 100, ...props },
    },
  ]);
  return new Scene(doc);
}

describe("PR #235 geometry integration regressions", () => {
  it("exports diamond gradients in SVG and CSS using exact 4-quadrant linear gradients, never radial", () => {
    const paint = {
      type: "diamond" as const,
      from: { x: 0.5, y: 0.5 },
      to: { x: 0.9, y: 0.5 },
      width: { x: 0.5, y: 0.7 },
      stops: [
        { position: 0, color: "#ff0000" },
        { position: 1, color: "#0000ff" },
      ],
    };
    const scene = sceneFor("rect", { fills: [paint] });
    const svg = exportSvg(scene, measure, ["node"], { x: 0, y: 0, width: 100, height: 100 });
    const css = cssGradient(paint, 100, 100, (x) => x);
    expect(svg).not.toContain("radial");
    expect(css).not.toBeNull();
    expect(css).not.toContain("radial");
    expect(svg).toContain("<linearGradient");
    expect(svg).toContain("matrix(40 0 0 20 50 50)");
    expect(css).toMatch(/^url\("data:image\/svg\+xml,/);
    expect(decodeURIComponent(css ?? "")).toContain("matrix(40 0 0 20 50 50)");
  });

  it("uses the optional width handle as the diamond gradient second axis", () => {
    const regular = {
      type: "diamond" as const,
      from: { x: 0.5, y: 0.5 },
      to: { x: 0.9, y: 0.5 },
      stops: [
        { position: 0, color: "#ff0000" },
        { position: 1, color: "#0000ff" },
      ],
    };
    const stretched = { ...regular, width: { x: 0.5, y: 0.7 } };
    expect(Paint.parse(regular)).toEqual(regular);
    expect(Paint.parse(stretched)).toEqual(stretched);
    const clean = (m: readonly number[] | null) => m?.map((v) => Math.round(v * 1e6) / 1e6 + 0);
    expect(clean(gradientMatrix(regular, 100, 100))).toEqual([40, 0, 0, 40, 50, 50]);
    expect(clean(gradientMatrix(stretched, 100, 100))).toEqual([40, 0, 0, 20, 50, 50]);
  });

  it("emits outside text strokes in paint-major order across runs and strokes list markers like Figma", () => {
    const encodeText = (props: Record<string, unknown>) => {
      const scene = sceneFor("text", {
        fontSize: 20,
        textAutoResize: "none",
        strokeAlign: "outside",
        strokeWeight: 8,
        strokes: [
          { type: "solid", color: "#ff000080" },
          { type: "solid", color: "#0000ff80" },
        ],
        ...props,
      });
      const node = scene.doc.get("node");
      if (!node) throw new Error("missing test text");
      return encodeLayer(node, {
        scene,
        measurer: measure,
        image: () => null,
        glyph: () => 1,
        whole: null,
        hidden: new Set(),
      }).record;
    };

    // Distinct fills split the glyphs into two PathEntry::Glyphs runs; outside strokes must still
    // run paint-major across runs ([run0, run1, run0, run1]), matching Figma and render.ts.
    const multiRun = encodeText({
      characters: "A\nB",
      textRuns: [
        { start: 0, end: 1, fills: [{ type: "solid", color: "#111111" }] },
        { start: 2, end: 3, fills: [{ type: "solid", color: "#222222" }] },
      ],
    });
    const pathOrder = multiRun.ops.filter((op) => op.op === "stroke").map((op) => op.path);
    expect(new Set(pathOrder).size).toBe(2);
    expect(pathOrder[0]).toBe(pathOrder[2]);
    expect(pathOrder[1]).toBe(pathOrder[3]);

    // Real Figma golden (`text-strokes/outside-list.png`) strokes bullet list markers along with text runs.
    const strokedGlyphCount = (rec: ReturnType<typeof encodeText>) => {
      const strokedPaths = new Set(rec.ops.filter((op) => op.op === "stroke").map((op) => op.path));
      let count = 0;
      for (const p of strokedPaths) {
        const entry = rec.paths[p];
        if (entry?.kind === "glyphs") count += entry.glyphs.length / 3;
      }
      return count;
    };
    const plain = encodeText({ characters: "A" });
    const bullets = encodeText({
      characters: "A",
      textRuns: [{ start: 0, end: 1, listType: "bullet" }],
    });
    expect(strokedGlyphCount(plain)).toBe(1);
    expect(strokedGlyphCount(bullets)).toBe(2);
  });
});
