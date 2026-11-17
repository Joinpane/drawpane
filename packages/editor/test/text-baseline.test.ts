/**
 * Where text's glyphs are drawn, against Figma. Figma lays text out without
 * rounding (the baselines it saves in a file's `derivedTextData` are the
 * font's height centred in the line box, ascent below that) but draws each
 * line's glyphs on a whole unit from the top of the text box: Inter 16/24
 * is laid out at 17.82 and drawn at 18, whatever the zoom or export scale.
 * The baselines below are Figma's own, saved for Inter (Figma's Inter has
 * 2816 units to the em, the web's 2048: baselines differ by under a thousandth of the size).
 */
import { readFileSync } from "node:fs";
import { type NodeRecord, ROOT_ID } from "@drawpane/model";
import { describe, expect, it } from "vitest";
import { Editor } from "../src/editor";
import { exportBounds } from "../src/export";
import { type FaceFileLoader, HarfBuzzMeasurer } from "../src/harfbuzz-measurer";
import { exportSvg } from "../src/svg";
import { drawnBaseline, layoutText, textBlockOffset } from "../src/text";

const bytes = readFileSync(
  new URL("../../../apps/web/e2e/fixtures/Inter-Variable.ttf", import.meta.url),
);
const INTER = bytes.buffer.slice(
  bytes.byteOffset,
  bytes.byteOffset + bytes.byteLength,
) as ArrayBuffer;
const loader: FaceFileLoader = async (face) =>
  face.family === "Inter" && !face.italic ? INTER : null;

async function measurer() {
  const m = new HarfBuzzMeasurer(loader);
  await m.load(
    [400, 500, 600].map((weight) => ({ family: "Inter", weight, italic: false, canvas: true })),
  );
  return m;
}

const text = (props: Record<string, unknown>): NodeRecord => ({
  id: "t",
  type: "text",
  parent: "p",
  key: "a0",
  props: {
    characters: "Hamburgefonstiv",
    fontFamily: "Inter",
    fontWeight: 400,
    width: 400,
    textAutoResize: "height",
    ...props,
  },
});

/** Font size, line height, and the first baselines Figma saved for Inter at them. */
const FIGMA: Array<[number, Record<string, unknown>, number[]]> = [
  [12, { unit: "px", value: 16 }, [12.364]],
  [14, { unit: "px", value: 20 }, [15.091]],
  [16, { unit: "px", value: 24 }, [17.818]],
  [18, { unit: "px", value: 28 }, [20.545]],
  [20, { unit: "px", value: 28 }, [21.273]],
  [24, { unit: "px", value: 32 }, [24.727]],
  [36, { unit: "px", value: 54 }, [40.091]],
  [14, { unit: "px", value: 22.75 }, [16.466, 39.216]],
  [16, { unit: "percent", value: 200 }, [21.818, 53.818, 85.818]],
  // "Auto": the font's own height in whole pixels (15 for 12 px Inter).
  [12, { unit: "auto", value: 0 }, [11.864]],
  // 100%: a line box shorter than the font, the baseline still centred.
  [14, { unit: "percent", value: 100 }, [12.091]],
];

describe("baselines, against Figma", () => {
  it("lays lines out where Figma does, unrounded", async () => {
    const m = await measurer();
    for (const [fontSize, lineHeight, figma] of FIGMA) {
      const characters = figma.map(() => "Hamburgefonstiv").join("\n");
      const layout = layoutText(text({ fontSize, lineHeight, characters }), m, 400);
      expect(layout.lines).toHaveLength(figma.length);
      for (const [i, b] of figma.entries())
        expect(
          Math.abs((layout.lines[i]?.baseline ?? 0) - b),
          `${fontSize}/${JSON.stringify(lineHeight)} line ${i}`,
        ).toBeLessThan(fontSize / 1000);
    }
  });

  it("draws each line's glyphs on a whole unit from the top of the box, as Figma draws them", async () => {
    const m = await measurer();
    for (const [fontSize, lineHeight, figma] of FIGMA) {
      const characters = figma.map(() => "Hamburgefonstiv").join("\n");
      const node = text({ fontSize, lineHeight, characters });
      const layout = layoutText(node, m, 400);
      const dy = textBlockOffset(node, layout);
      expect(layout.lines.map((l) => drawnBaseline(l, dy))).toEqual(figma.map(Math.round));
    }
  });

  it("rounds after aligning the block: half a pixel of slack in a middle-aligned box moves it", async () => {
    const m = await measurer();
    // Inter 14/22.75 in a 23 px box, centred: laid out at 16.47 + 0.125, drawn at 17.
    const node = text({
      fontSize: 14,
      lineHeight: { unit: "px", value: 22.75 },
      height: 23,
      textAutoResize: "none",
      textAlignVertical: "middle",
    });
    const layout = layoutText(node, m, 400);
    const [line] = layout.lines;
    if (!line) throw new Error("no line");
    expect(line.baseline + textBlockOffset(node, layout)).toBeCloseTo(16.596, 2);
    expect(drawnBaseline(line, textBlockOffset(node, layout))).toBe(17);
  });

  it("trims to the cap height, whose reading it takes the middle of", async () => {
    const m = await measurer();
    // Inter's "H" is 0.7275 em. Figma trims Inter 24 at 150% to 17.46 and draws it at 17; the
    // canvas reads the cap height as 47/64 em (17.63 at 24 px, drawn at 18), so the middle of
    // the 64th it reads stands for it.
    const node = text({
      fontSize: 24,
      lineHeight: { unit: "percent", value: 150 },
      leadingTrim: "cap-height",
      textAutoResize: "width",
      characters: "Two lines\nof type",
    });
    const layout = layoutText(node, m, null);
    const [first, second] = layout.lines;
    if (!first || !second) throw new Error("no lines");
    expect(first.baseline).toBeCloseTo((46.5 / 64) * 24, 6);
    expect(drawnBaseline(first, 0)).toBe(17);
    expect(drawnBaseline(second, 0)).toBe(53);
  });

  it("exports text on the same whole-unit baselines", async () => {
    const m = await measurer();
    const editor = new Editor({ measurer: m, clientId: "test" });
    editor.state.set({ role: "editor" });
    editor.doc.apply([
      { op: "create", id: "p", type: "page", parent: ROOT_ID, key: "a0", props: { name: "Page" } },
      {
        op: "create",
        id: "t",
        type: "text",
        parent: "p",
        key: "a0",
        props: {
          x: 10,
          y: 10,
          width: 300,
          height: 48,
          characters: "One\nTwo",
          fontFamily: "Inter",
          fontSize: 16,
          lineHeight: { unit: "px", value: 24 },
          textAutoResize: "height",
        },
      },
    ]);
    editor.setPage("p");
    const bounds = exportBounds(editor.scene, ["t"]);
    if (!bounds) throw new Error("no bounds");
    const svg = exportSvg(editor.scene, m, ["t"], bounds);
    // Laid out at 17.82 and 41.82; drawn, as in Figma, at 18 and 42.
    expect([...svg.matchAll(/<tspan [^>]*y="([\d.]+)"/g)].map((t) => Number(t[1]))).toEqual([
      18, 42,
    ]);
  });
});
