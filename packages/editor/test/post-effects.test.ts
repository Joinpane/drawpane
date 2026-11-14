import {
  DEFAULT_NOISE,
  DEFAULT_TEXTURE,
  Effect,
  type Effect as EffectValue,
  effectBounds,
  type Noise,
  type Op,
  ROOT_ID,
} from "@drawpane/model";
import { describe, expect, it } from "vitest";
import { Editor } from "../src/editor";
import { exportBounds } from "../src/export";
import { NOISE_TILE, noisePixels, seeded } from "../src/noise";
import { postEffects, postMargin } from "../src/post-effects";
import { exportSvg, noiseThreshold, postPrimitives } from "../src/svg";
import type { TextMeasurer } from "../src/text";
import { textureReach } from "../src/texture";

const measurer: TextMeasurer = { width: (_font, text) => text.length * 8 };

function makeEditor(ops: Op[] = []) {
  const editor = new Editor({ measurer, clientId: "test" });
  editor.state.set({ role: "editor" });
  editor.doc.apply([
    { op: "create", id: "p", type: "page", parent: ROOT_ID, key: "a0", props: { name: "Page 1" } },
    ...ops,
  ]);
  editor.setPage("p");
  return editor;
}

const square = (effects: EffectValue[]): Op => ({
  op: "create",
  id: "r",
  type: "rect",
  parent: "p",
  key: "a0",
  props: {
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    fills: [{ type: "solid", color: "#2b4fd6" }],
    effects,
  },
});

/** Which cells of a tile are painted (alpha above 0). */
const painted = (pixels: Uint8ClampedArray) =>
  Array.from({ length: pixels.length / 4 }, (_, i) => (pixels[i * 4 + 3] ?? 0) > 0);

describe("noise and texture in a file", () => {
  it("are valid with their defaults, and keep their values in range", () => {
    expect(Effect.safeParse(DEFAULT_NOISE).success).toBe(true);
    expect(Effect.safeParse(DEFAULT_TEXTURE).success).toBe(true);
    expect(Effect.safeParse({ ...DEFAULT_NOISE, density: 101 }).success).toBe(false);
    expect(Effect.safeParse({ ...DEFAULT_NOISE, size: 0 }).success).toBe(false);
    expect(Effect.safeParse({ ...DEFAULT_NOISE, noiseType: "tri" }).success).toBe(false);
    expect(Effect.safeParse({ ...DEFAULT_TEXTURE, radius: -1 }).success).toBe(false);
  });

  it("tell fields their ranges", () => {
    expect(effectBounds("noise", "size")).toEqual({ min: 0.5, max: 50 });
    expect(effectBounds("noise", "density")).toEqual({ min: 0, max: 100 });
    expect(effectBounds("texture", "radius")).toEqual({ min: 0, max: 100 });
    expect(effectBounds("glass", "depth")).toEqual({ min: 0, max: 200 });
  });
});

describe("noise tiles", () => {
  const look = (over: Partial<Noise> = {}): Noise => ({ ...DEFAULT_NOISE, ...over });

  it("are the same every time: seeded, so a file looks the same on every screen", () => {
    expect(noisePixels(look())).toEqual(noisePixels(look()));
    const a = seeded(1);
    const b = seeded(1);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it("cover about the density's share of cells, and none or all at the ends", () => {
    const on = (density: number) => painted(noisePixels(look({ density }))).filter(Boolean).length;
    const cells = NOISE_TILE * NOISE_TILE;
    expect(on(0)).toBe(0);
    expect(on(100)).toBe(cells);
    expect(on(50) / cells).toBeCloseTo(0.5, 1);
    expect(on(20) / cells).toBeCloseTo(0.2, 1);
  });

  it("paint mono cells in its colour, straight (not premultiplied)", () => {
    const pixels = noisePixels(look({ color: "#ff800040", density: 100 }), 4);
    expect(Array.from(pixels.slice(0, 4))).toEqual([255, 128, 0, 64]);
  });

  it("paint duo's other cells in its second colour, so it covers the layer", () => {
    const pixels = noisePixels(
      look({ noiseType: "duo", color: "#000000ff", secondaryColor: "#ffffffff", density: 50 }),
    );
    const colours = new Set<number>();
    for (let i = 0; i < pixels.length; i += 4) {
      expect(pixels[i + 3]).toBe(255);
      colours.add(pixels[i] ?? -1);
    }
    expect([...colours].sort()).toEqual([0, 255]);
  });

  it("paint multi cells in many colours at its opacity", () => {
    const pixels = noisePixels(look({ noiseType: "multi", opacity: 50, density: 100 }));
    const reds = new Set<number>();
    for (let i = 0; i < pixels.length; i += 4) {
      expect(pixels[i + 3]).toBe(128);
      reds.add(pixels[i] ?? 0);
    }
    expect(reds.size).toBeGreaterThan(200);
  });

  it("keep which cells are on whatever the kind or colour: only the density moves them", () => {
    const mono = painted(noisePixels(look({ color: "#123456ff" })));
    const multi = painted(noisePixels(look({ noiseType: "multi" })));
    const other = painted(noisePixels(look({ color: "#abcdefff" })));
    expect(multi).toEqual(mono);
    expect(other).toEqual(mono);
  });
});

describe("post effects", () => {
  const blur = (radius: number, visible?: boolean) =>
    ({ type: "layer-blur", radius, ...(visible === false ? { visible } : {}) }) as const;

  it("are the layer blurs, noise and texture, in the order listed, hidden ones left out", () => {
    const post = postEffects([
      { type: "drop-shadow", color: "#000000", x: 0, y: 2, blur: 4, spread: 0 },
      DEFAULT_TEXTURE,
      { type: "background-blur", radius: 3 },
      blur(4),
      { ...DEFAULT_NOISE, visible: false },
      DEFAULT_NOISE,
    ]);
    expect(post.map((e) => e.type)).toEqual(["texture", "layer-blur", "noise"]);
  });

  it("count blurs next to each other as one, the strongest, as they always have", () => {
    expect(postEffects([blur(2), blur(6), blur(4)])).toEqual([blur(6)]);
    // Apart, each applies to what the one before left.
    expect(postEffects([blur(2), DEFAULT_NOISE, blur(4)]).map((e) => e.type)).toEqual([
      "layer-blur",
      "noise",
      "layer-blur",
    ]);
  });

  it("are none for a layer without them, without making anything", () => {
    expect(postEffects([])).toBe(postEffects([{ type: "background-blur", radius: 2 }]));
  });

  it("need room around the layer: 3σ of each blur and an unclipped texture's radius, added up", () => {
    expect(postMargin([blur(4)])).toBe(12);
    expect(postMargin([DEFAULT_NOISE])).toBe(0);
    expect(postMargin([{ ...DEFAULT_TEXTURE, radius: 5 }, blur(2)])).toBe(11);
    expect(postMargin([{ ...DEFAULT_TEXTURE, radius: 5, clipToShape: true }])).toBe(0);
    expect(textureReach({ ...DEFAULT_TEXTURE, radius: 7 })).toBe(7);
  });

  it("grow what an export covers by an unclipped texture's reach, and not for noise", () => {
    const at = (effects: EffectValue[]) =>
      exportBounds(makeEditor([square(effects)]).scene, ["r"]) ?? null;
    expect(at([DEFAULT_NOISE])).toEqual({ x: 0, y: 0, width: 100, height: 100 });
    expect(at([{ ...DEFAULT_TEXTURE, radius: 6 }])).toEqual({
      x: -6,
      y: -6,
      width: 112,
      height: 112,
    });
    expect(at([{ ...DEFAULT_TEXTURE, radius: 6, clipToShape: true }])).toEqual({
      x: 0,
      y: 0,
      width: 100,
      height: 100,
    });
  });
});

describe("post effects in SVG", () => {
  it("thresholds turbulence so about the density's share of it is on", () => {
    expect(noiseThreshold(50)).toBeCloseTo(0.5, 5);
    expect(noiseThreshold(20)).toBeGreaterThan(noiseThreshold(50));
    expect(noiseThreshold(80)).toBeLessThan(noiseThreshold(50));
    expect(noiseThreshold(0)).toBe(Number.POSITIVE_INFINITY);
    expect(noiseThreshold(100)).toBe(Number.NEGATIVE_INFINITY);
  });

  it("chains the effects in order, each working on what the last left", () => {
    const filter = postPrimitives(
      [{ type: "layer-blur", radius: 2 }, DEFAULT_NOISE, { ...DEFAULT_TEXTURE, clipToShape: true }],
      1,
    );
    expect(filter).toContain(
      '<feGaussianBlur in="SourceGraphic" stdDeviation="2" result="post0"/>',
    );
    // Noise lands atop the blurred layer, only where it paints.
    expect(filter).toContain('in2="post0" operator="atop" result="post1"/>');
    // Texture moves the noisy picture, then is cut to its coverage.
    expect(filter).toContain('<feDisplacementMap in="post1"');
    expect(filter).toContain('in2="post1" operator="in" result="post2"/>');
  });

  it("gives duo noise its second colour on the cells the first leaves", () => {
    const filter = postPrimitives(
      [{ ...DEFAULT_NOISE, noiseType: "duo", secondaryColor: "#ff000080" }],
      1,
    );
    expect(filter).toContain('flood-color="#ff0000" flood-opacity="0.502"');
    expect(filter).toContain('operator="out"');
    expect(filter).toContain("<feMerge");
  });

  it("wraps the whole layer in one filter over everything it reaches", () => {
    const editor = makeEditor([square([{ ...DEFAULT_TEXTURE, radius: 6 }, DEFAULT_NOISE])]);
    const bounds = exportBounds(editor.scene, ["r"]);
    if (!bounds) throw new Error("no bounds");
    const svg = exportSvg(editor.scene, measurer, ["r"], bounds);
    const filter = /<filter id="(post\d+)" filterUnits="userSpaceOnUse" x="([-\d.]+)"/.exec(svg);
    expect(filter).not.toBeNull();
    const [, id, x] = filter as RegExpExecArray;
    expect(Number(x)).toBeLessThanOrEqual(-12);
    expect(svg).toContain(`<g filter="url(#${id})"><rect`);
    expect(svg).toContain("feTurbulence");
  });
});
