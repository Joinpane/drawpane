import { type Op, ROOT_ID } from "@drawpane/model";
import { nodeRasteriser, type ResvgRasteriser } from "@drawpane/raster/node";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Editor } from "../src/editor";
import { linearBlend } from "../src/linear-blend";
import { exportSvg } from "../src/svg";
import type { TextMeasurer } from "../src/text";

const measurer: TextMeasurer = { width: (_font, text) => text.length * 8 };

function makeEditor(ops: Op[]) {
  const editor = new Editor({ measurer, clientId: "test" });
  editor.state.set({ role: "editor" });
  editor.doc.apply([
    { op: "create", id: "p", type: "page", parent: ROOT_ID, key: "a0", props: { name: "Page 1" } },
    ...ops,
  ]);
  editor.setPage("p");
  return editor;
}

/** Order keys, in the order the layers are made (each test makes fewer than 25). */
let key = 0;
const rect = (id: string, props: Record<string, unknown>, parent = "p"): Op =>
  ({
    op: "create",
    id,
    type: "rect",
    parent,
    key: `a${"bcdefghijklmnopqrstuvwxyz"[key++ % 25]}`,
    props: { x: 0, y: 0, width: 10, height: 10, ...props },
  }) as Op;

/** Three grey bands, 60 wide, over the parity scenes' background: the Figma probes' backdrop. */
const bands = (): Op[] => [
  rect("bg", { width: 240, height: 40, fills: [{ type: "solid", color: "#f4f3ef" }] }),
  rect("b1", { width: 60, height: 40, fills: [{ type: "solid", color: "#303030" }] }),
  rect("b2", { x: 60, width: 60, height: 40, fills: [{ type: "solid", color: "#808080" }] }),
  rect("b3", { x: 120, width: 60, height: 40, fills: [{ type: "solid", color: "#b0b0b0" }] }),
];

beforeEach(() => {
  key = 0;
});

let rasteriser: ResvgRasteriser;
beforeAll(async () => {
  rasteriser = await nodeRasteriser();
});

/** Each band's middle (red channel, straight alpha), drawn headless at 2×. */
function probe(editor: Editor, ids: string[]): number[] {
  const bounds = { x: 0, y: 0, width: 240, height: 40 };
  const svg = exportSvg(editor.scene, measurer, ids, bounds);
  const p = rasteriser.pixels(svg, { scale: 2, fonts: [] });
  return [30, 90, 150, 210].map((x) => p.data[(40 * p.width + 2 * x) * 4] as number);
}

// What Figma draws for these (tools/figma-parity/goldens/linear-blends, the probe cells).
const FIGMA = {
  dodge: { 1: [208, 255, 255, 255], 0.5: [128, 208, 255, 255], 0.2: [80, 160, 208, 255] },
  burn: { 1: [0, 0, 17, 85], 0.5: [0, 48, 96, 164], 0.2: [16, 96, 144, 212] },
} as const;

describe("linear dodge and burn, as Figma blends them", () => {
  const near = (actual: number, expected: number) =>
    expect(Math.abs(actual - expected)).toBeLessThanOrEqual(1);

  it("adds premultiplied colour over an opaque backdrop: dodge clamps at 1, burn takes away the alpha", () => {
    // A #a0a0a0 paint at 50% over #808080: 128 + 80, where normal blending gives 144.
    near(linearBlend("linear-dodge", (160 / 255) * 0.5, 0.5, 128 / 255, 1).c * 255, 208);
    // A #606060 paint at 50% over #808080: 128 + 48 - 127.5.
    near(linearBlend("linear-burn", (96 / 255) * 0.5, 0.5, 128 / 255, 1).c * 255, 48);
    expect(linearBlend("linear-burn", (96 / 255) * 0.5, 0.5, 48 / 255, 1).c).toBe(0);
  });

  it("is the source over nothing, with normal blending's alpha over a see-through backdrop", () => {
    for (const mode of ["linear-dodge", "linear-burn"] as const) {
      const over = linearBlend(mode, 0.3, 0.5, 0, 0);
      expect(over.c).toBeCloseTo(0.3);
      expect(over.a).toBeCloseTo(0.5);
    }
    // Figma, half-opaque grey under a half-opaque paint: alpha 0.75 either way.
    const burn = linearBlend("linear-burn", (96 / 255) * 0.5, 0.5, (128 / 255) * 0.5, 0.5);
    expect(burn.a).toBeCloseTo(0.75);
    near(burn.c * 255, 48);
    const dodge = linearBlend("linear-dodge", (160 / 255) * 0.5, 0.5, (128 / 255) * 0.5, 0.5);
    near(dodge.c * 255, 144);
  });
});

describe("linear dodge and burn in SVG export, drawn headless", () => {
  // resvg's 8-bit filter steps (a division by the alpha and back) leave a level or two.
  const close = (actual: number[], expected: readonly number[]) =>
    actual.forEach((v, i) => {
      expect(Math.abs(v - (expected[i] as number))).toBeLessThanOrEqual(3);
    });

  for (const mode of ["dodge", "burn"] as const)
    for (const opacity of [1, 0.5, 0.2] as const) {
      const color = mode === "dodge" ? "#a0a0a0" : "#606060";
      const blendMode = `linear-${mode}`;
      it(`draws a paint's linear ${mode} at ${opacity * 100}% as Figma does`, () => {
        const paint = { type: "solid", color, blendMode, ...(opacity < 1 ? { opacity } : {}) };
        const editor = makeEditor([
          ...bands(),
          rect("s", { width: 240, height: 40, fills: [paint] }),
        ]);
        close(probe(editor, ["bg", "b1", "b2", "b3", "s"]), FIGMA[mode][opacity]);
      });
      it(`draws a layer's linear ${mode} at ${opacity * 100}% as Figma does`, () => {
        const editor = makeEditor([
          ...bands(),
          rect("s", {
            width: 240,
            height: 40,
            fills: [{ type: "solid", color }],
            blendMode,
            ...(opacity < 1 ? { opacity } : {}),
          }),
        ]);
        close(probe(editor, ["bg", "b1", "b2", "b3", "s"]), FIGMA[mode][opacity]);
      });
    }

  it("blends what's under the layer in its frame, and copies it by reference, once", () => {
    const editor = makeEditor([
      {
        op: "create",
        id: "f",
        type: "frame",
        parent: "p",
        key: "aa",
        props: { x: 0, y: 0, width: 240, height: 40, fills: [] },
      },
      ...bands().map((op) => ({ ...op, parent: "f" }) as Op),
      rect(
        "s",
        {
          width: 240,
          height: 40,
          fills: [{ type: "solid", color: "#606060", opacity: 0.5, blendMode: "linear-burn" }],
        },
        "f",
      ),
      rect(
        "t",
        {
          width: 240,
          height: 40,
          fills: [{ type: "solid", color: "#606060", opacity: 0.5, blendMode: "linear-burn" }],
        },
        "f",
      ),
    ]);
    const svg = exportSvg(editor.scene, measurer, ["f"], { x: 0, y: 0, width: 240, height: 40 });
    // Each band drawn once, in defs, and used from there.
    expect(svg.match(/fill="#303030"/g)).toHaveLength(1);
    expect(svg.match(/<g mask="url\(#under/g)).toHaveLength(2);
    const p = rasteriser.pixels(svg, { scale: 2, fonts: [] });
    const at = (x: number) => p.data[(40 * p.width + 2 * x) * 4] as number;
    // Burnt twice: 128 → 48 → 0, 176 → 96 → 17, 244 → 164 → 85 (Figma's opaque steps).
    expect(at(90)).toBeLessThanOrEqual(2);
    expect(Math.abs(at(150) - 17)).toBeLessThanOrEqual(4);
    expect(Math.abs(at(210) - 85)).toBeLessThanOrEqual(4);
  });

  it("burns a stroke's paint into what's under it", () => {
    const editor = makeEditor([
      ...bands(),
      rect("s", {
        x: 20,
        y: 10,
        width: 200,
        height: 20,
        strokes: [{ type: "solid", color: "#606060", blendMode: "linear-burn" }],
        strokeWeight: 8,
        strokeAlign: "center",
      }),
    ]);
    const svg = exportSvg(editor.scene, measurer, ["bg", "b1", "b2", "b3", "s"], {
      x: 0,
      y: 0,
      width: 240,
      height: 40,
    });
    const p = rasteriser.pixels(svg, { scale: 2, fonts: [] });
    // On the top edge (y 10) over the #b0b0b0 band: 176 + 96 - 255 = 17.
    expect(Math.abs((p.data[(20 * p.width + 300) * 4] as number) - 17)).toBeLessThanOrEqual(3);
  });

  it("blends a faded frame's layers with what's under the frame, as Figma does", () => {
    const editor = makeEditor([
      ...bands(),
      {
        op: "create",
        id: "f",
        type: "frame",
        parent: "p",
        key: "az",
        props: { x: 0, y: 0, width: 240, height: 40, fills: [], opacity: 0.99 },
      },
      rect(
        "s",
        {
          width: 240,
          height: 40,
          fills: [{ type: "solid", color: "#606060" }],
          blendMode: "linear-burn",
        },
        "f",
      ),
    ]);
    // Burnt into the bands, not drawn alone (which would be #606060 everywhere).
    close(probe(editor, ["bg", "b1", "b2", "b3", "f"]), FIGMA.burn[1]);
  });

  it("draws a paint over nothing as the paint, without a filter", () => {
    const editor = makeEditor([
      rect("s", {
        width: 240,
        height: 40,
        fills: [{ type: "solid", color: "#606060", blendMode: "linear-burn" }],
      }),
    ]);
    const svg = exportSvg(editor.scene, measurer, ["s"], { x: 0, y: 0, width: 240, height: 40 });
    expect(svg).not.toContain("<filter");
    expect(svg).toContain('fill="#606060"');
  });

  it("adds a dark inner shadow by linear dodge as a highlight", () => {
    const editor = makeEditor([
      rect("s", {
        width: 240,
        height: 40,
        fills: [{ type: "solid", color: "#3a3a3c" }],
        effects: [
          {
            type: "inner-shadow",
            color: "#505050",
            x: 0,
            y: 8,
            blur: 0,
            spread: 0,
            blendMode: "linear-dodge",
          },
        ],
      }),
    ]);
    const svg = exportSvg(editor.scene, measurer, ["s"], { x: 0, y: 0, width: 240, height: 40 });
    const p = rasteriser.pixels(svg, { scale: 2, fonts: [] });
    // The top 8 units: 0x3a + 0x50 = 138, where normal blending would draw 0x50 = 80.
    expect(Math.abs((p.data[(4 * p.width + 100) * 4] as number) - 138)).toBeLessThanOrEqual(3);
    // Below it, the fill as it is.
    expect(Math.abs((p.data[(60 * p.width + 100) * 4] as number) - 0x3a)).toBeLessThanOrEqual(1);
  });
});
