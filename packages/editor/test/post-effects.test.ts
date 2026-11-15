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
import { noisePixels, seeded } from "../src/noise";
import { postEffects, postMargin, postReach } from "../src/post-effects";
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
    expect(effectBounds("glass", "depth")).toEqual({ min: 0, max: 100 });
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

  /** How much of the tile is grain: the mean of each pixel's coverage (its alpha over the colour's). */
  const coverage = (density: number) => {
    const pixels = noisePixels(look({ color: "#000000ff", density }));
    let sum = 0;
    for (let i = 3; i < pixels.length; i += 4) sum += (pixels[i] as number) / 255;
    return sum / (pixels.length / 4);
  };

  it("cover as much of the layer as Figma's does at each density", () => {
    // Measured from Figma's renders (tools/figma-parity, grain suite).
    expect(coverage(0)).toBe(0);
    expect(coverage(20)).toBeCloseTo(0.013, 2);
    expect(coverage(50)).toBeCloseTo(0.086, 1);
    expect(coverage(85)).toBeCloseTo(0.335, 1);
    expect(coverage(100)).toBeGreaterThan(0.4);
    expect(coverage(100)).toBeLessThan(0.6);
  });

  it("make grain in blobs with soft edges, not square cells", () => {
    const pixels = noisePixels(look({ color: "#000000ff", density: 85 }));
    const alphas = new Set<number>();
    for (let i = 3; i < pixels.length; i += 4) alphas.add(pixels[i] as number);
    // Inside, outside, and every step of an edge between.
    expect(alphas.has(0)).toBe(true);
    expect(alphas.has(255)).toBe(true);
    expect(alphas.size).toBeGreaterThan(50);
  });

  it("paint mono grain in its colour, straight (not premultiplied)", () => {
    const pixels = noisePixels(look({ color: "#ff800040", density: 100 }));
    const full = [...Array(pixels.length / 4).keys()].find(
      (i) => pixels[i * 4 + 3] === 64,
    ) as number;
    expect(Array.from(pixels.slice(full * 4, full * 4 + 4))).toEqual([255, 128, 0, 64]);
  });

  it("paint duo as two sets of grain, its second colour's between the first's", () => {
    const pixels = noisePixels(
      look({ noiseType: "duo", color: "#000000ff", secondaryColor: "#ffffffff", density: 85 }),
    );
    let first = 0;
    let second = 0;
    let clear = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if ((pixels[i + 3] as number) === 0) clear++;
      else if ((pixels[i] as number) === 0) first++;
      else second++;
    }
    // About as much of each, and the layer showing through between them.
    expect(first / second).toBeGreaterThan(0.7);
    expect(first / second).toBeLessThan(1.4);
    expect(clear).toBeGreaterThan(0);
  });

  it("paint multi grain in many colours at its opacity", () => {
    const pixels = noisePixels(look({ noiseType: "multi", opacity: 50, density: 100 }));
    const reds = new Set<number>();
    for (let i = 0; i < pixels.length; i += 4) {
      expect(pixels[i + 3]).toBeLessThanOrEqual(128);
      if ((pixels[i + 3] as number) === 128) reds.add(pixels[i] ?? 0);
    }
    expect(reds.size).toBeGreaterThan(100);
  });

  it("keep where grain is whatever the kind or colour: only the density moves it", () => {
    // Where grain is at least half there, by each look's own full strength.
    const core = (pixels: Uint8ClampedArray) => {
      let max = 0;
      for (let i = 3; i < pixels.length; i += 4) max = Math.max(max, pixels[i] as number);
      const out: boolean[] = [];
      for (let i = 3; i < pixels.length; i += 4) out.push((pixels[i] as number) >= max / 2);
      return out;
    };
    const mono = core(noisePixels(look({ color: "#123456ff" })));
    const multi = core(noisePixels(look({ noiseType: "multi" })));
    const other = core(noisePixels(look({ color: "#abcdefff" })));
    // The same grain, but for pixels rounding differently right at the cut.
    const differ = (a: boolean[], b: boolean[]) => a.filter((v, i) => v !== b[i]).length / a.length;
    expect(differ(multi, mono)).toBeLessThan(0.005);
    expect(differ(other, mono)).toBe(0);
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

  it("spread what the layer paints, shadows and strokes included: their reach adds", () => {
    expect(postReach([blur(3), { ...DEFAULT_TEXTURE, radius: 5 }])).toBe(11);
    const at = (effects: EffectValue[]) =>
      exportBounds(makeEditor([square(effects)]).scene, ["r"]) ?? null;
    // A shadow 10 below with blur 4, then texture moving its fringe up to 6 further.
    const shadow = {
      type: "drop-shadow",
      color: "#000000",
      x: 0,
      y: 10,
      blur: 4,
      spread: 0,
    } as const;
    const plain = at([shadow]);
    const rough = at([shadow, { ...DEFAULT_TEXTURE, radius: 6 }]);
    expect(rough?.height).toBe((plain?.height ?? 0) + 12);
    expect(rough?.y).toBe((plain?.y ?? 0) - 6);
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
  it("thresholds turbulence to cover as much as Figma's grain does", () => {
    // Half density covers about a tenth: the cut is 1.4 deviations up.
    expect(noiseThreshold(50)).toBeCloseTo(0.5 + 0.12 * 1.395, 5);
    expect(noiseThreshold(20)).toBeGreaterThan(noiseThreshold(50));
    expect(noiseThreshold(80)).toBeLessThan(noiseThreshold(50));
    // None at 0; about half (the cut at the mean) at 100.
    expect(noiseThreshold(0)).toBe(Number.POSITIVE_INFINITY);
    expect(noiseThreshold(100)).toBeCloseTo(0.5, 2);
  });

  it("chains the effects in order, each working on what the last left", () => {
    const filter = postPrimitives(
      [{ type: "layer-blur", radius: 2 }, DEFAULT_NOISE, { ...DEFAULT_TEXTURE, clipToShape: true }],
      1,
    );
    expect(filter).toContain(
      '<feGaussianBlur in="SourceGraphic" stdDeviation="1" result="post0"/>',
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
