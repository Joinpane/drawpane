/**
 * OpenType features through the real HarfBuzz, with a real font (Instrument
 * Sans, which has tabular figures and ligatures), in Node: Path2D doesn't
 * exist here, so outlines are kept as their path data.
 */
import { readFileSync } from "node:fs";
import { ROOT_ID } from "@drawpane/model";
import { describe, expect, it, vi } from "vitest";
import { Editor } from "../src/editor";
import { axisSettings, Shaper, ShapingMeasurer, shapingFace } from "../src/shaping";
import { autoSize, layoutText, type ShapingRun, shapingRun, type TextMeasurer } from "../src/text";

const FONT = readFileSync(
  new URL("../../../apps/web/e2e/fixtures/InstrumentSans-Regular.ttf", import.meta.url),
);
const bytes = () => FONT.buffer.slice(FONT.byteOffset, FONT.byteOffset + FONT.byteLength);
const makePath = (d: string) => ({ d }) as unknown as Path2D;

function run(features: Record<string, boolean>, size = 10, family = "Instrument Sans") {
  return shapingRun({ fontFamily: family, fontSize: size, fontFeatures: features }) as ShapingRun;
}

async function ready(loader = async () => bytes()) {
  const shaper = new Shaper(loader, { makePath });
  const face = { family: "Instrument Sans", weight: 400, italic: false };
  expect(await shaper.load(face)).toBe("ready");
  return shaper;
}

describe("Shaper", () => {
  it("draws nothing until the face is ready, then tells the family", async () => {
    const shaper = new Shaper(async () => bytes(), { makePath });
    const heard = vi.fn();
    shaper.subscribe(heard);
    expect(shaper.shape("1111", run({ tnum: true }))).toBeNull();
    await shaper.load({ family: "Instrument Sans", weight: 400, italic: false });
    expect(heard).toHaveBeenCalledWith("Instrument Sans");
    expect(shaper.generation).toBe(1);
    expect(shaper.shape("1111", run({ tnum: true }))).not.toBeNull();
  });

  it("applies features: tabular figures are wider, ligatures can be turned off", async () => {
    const shaper = await ready();
    // Instrument Sans: proportional "1" is 382 units, tabular 600 (1000 per em).
    const proportional = shaper.shape("1111", run({ pnum: true }));
    const tabular = shaper.shape("1111", run({ tnum: true }));
    expect(proportional?.width).toBeCloseTo(15.28, 2);
    expect(tabular?.width).toBeCloseTo(24, 2);
    // "ffi" is one glyph with ligatures, three without; clusters point back at the characters.
    const ligated = shaper.shape("office", run({ liga: true }));
    const apart = shaper.shape("office", run({ liga: false }));
    expect(ligated?.glyphs.map((g) => g.cluster)).toEqual([0, 1, 4, 5]);
    expect(apart?.glyphs.map((g) => g.cluster)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("places glyphs in px at the run's size, with outlines in font units", async () => {
    const shaper = await ready();
    const shaped = shaper.shape("11", run({ tnum: true }, 20));
    expect(shaped?.scale).toBeCloseTo(0.02, 5);
    expect(shaped?.glyphs.map((g) => g.x)).toEqual([0, 12]);
    const outline = shaped?.glyphs[0]?.path as unknown as { d: string } | null | undefined;
    expect(outline?.d).toMatch(/^M/);
    // A space has no outline.
    expect(shaper.shape(" ", run({ tnum: true }))?.glyphs[0]?.path).toBeNull();
  });

  it("leaves right-to-left text, and characters the font lacks, to the canvas", async () => {
    const shaper = await ready();
    // Mixed direction would come out reversed (no bidi in HarfBuzz).
    expect(shaper.shape("מחיר 12", run({ tnum: true }))).toBeNull();
    expect(shaper.shape("ab אבג", run({ tnum: true }))).toBeNull();
    // Glyph 0 (a box) where the canvas would fall back to another font.
    expect(shaper.shape("1😀", run({ tnum: true }))).toBeNull();
    expect(shaper.shape("12", run({ tnum: true }))).not.toBeNull();
    // Measured as the canvas has it, so layout matches what's drawn.
    const base = { width: vi.fn(() => 42), invalidate: vi.fn() };
    expect(new ShapingMeasurer(base, shaper).width("f", "1😀", run({ tnum: true }))).toBe(42);
  });

  it("tries a face again after its file failed to load", async () => {
    let fail = true;
    const shaper = new Shaper(
      async () => {
        if (fail) throw new Error("offline");
        return bytes();
      },
      { makePath },
    );
    const face = { family: "Instrument Sans", weight: 400, italic: false };
    expect(await shaper.load(face)).toBe("unavailable");
    fail = false;
    shaper.retry(face);
    expect(await shaper.load(face)).toBe("ready");
  });

  it("lists the features a font offers", async () => {
    const shaper = await ready();
    const tags = (
      await shaper.offered({ family: "Instrument Sans", weight: 400, italic: false })
    )?.map((f) => f.tag);
    expect(tags).toEqual(expect.arrayContaining(["liga", "tnum", "pnum", "kern"]));
    // Once each, though a font lists some per script.
    expect(new Set(tags).size).toBe(tags?.length);
  });

  it("gives up on a face it can't read, without retrying forever", async () => {
    const loader = vi.fn(async () => null);
    const shaper = new Shaper(loader, { makePath });
    const face = { family: "Helvetica", weight: 400, italic: false };
    expect(await shaper.load(face)).toBe("unavailable");
    expect(shaper.shape("12", run({ tnum: true }, 10, "Helvetica"))).toBeNull();
    expect(await shaper.offered(face)).toBeNull();
    expect(loader).toHaveBeenCalledTimes(1);
  });
});

describe("ShapingMeasurer", () => {
  const canvas = () => {
    const base = { width: vi.fn((_f: string, t: string) => t.length * 5), invalidate: vi.fn() };
    return base as TextMeasurer & typeof base;
  };

  it("measures shaped runs by their glyphs, and everything else by the canvas", async () => {
    const base = canvas();
    const measurer = new ShapingMeasurer(base, await ready());
    expect(measurer.width("font", "1111", run({ tnum: true }))).toBeCloseTo(24, 2);
    expect(measurer.width("font", "1111")).toBe(20);
    expect(base.width).toHaveBeenCalledTimes(1);
  });

  it("lays text out, sizes it and keeps the run on each fragment", async () => {
    const measurer = new ShapingMeasurer(canvas(), await ready());
    const editor = new Editor({ measurer, clientId: "t" });
    editor.doc.apply([
      { op: "create", id: "p", type: "page", parent: ROOT_ID, key: "a0", props: {} },
      {
        op: "create",
        id: "t",
        type: "text",
        parent: "p",
        key: "a0",
        props: { characters: "1111", fontSize: 10, fontFeatures: { tnum: true } },
      },
    ]);
    const node = editor.doc.get("t");
    if (!node) throw new Error("no text");
    const layout = layoutText(node, measurer, null);
    expect(layout.width).toBeCloseTo(24, 2);
    expect(layout.lines[0]?.fragments[0]?.run?.features).toEqual({ tnum: true });
    expect(autoSize(node, measurer)?.width).toBe(24);
  });
});

describe("shapingRun", () => {
  it("is null without features, so plain text keeps the canvas's fast path", () => {
    expect(shapingRun({})).toBeNull();
    expect(shapingRun({ fontFeatures: {} })).toBeNull();
  });

  it("keys runs by face, size and features in a stable order", () => {
    const a = shapingRun({ fontFeatures: { tnum: true, liga: false } });
    const b = shapingRun({ fontFeatures: { liga: false, tnum: true } });
    expect(a?.key).toBe(b?.key);
    expect(a?.key).toBe("Instrument Sans|400|n|16|liga=0,tnum=1|");
  });
});

describe("variable fonts (decision 0009)", () => {
  const VARIABLE = readFileSync(
    new URL("../../../apps/web/e2e/fixtures/InstrumentSans-Variable.ttf", import.meta.url),
  );
  const variableBytes = () =>
    VARIABLE.buffer.slice(VARIABLE.byteOffset, VARIABLE.byteOffset + VARIABLE.byteLength);
  const axesRun = (variations: Record<string, number>, weight = 400, size = 10) =>
    shapingRun({
      fontFamily: "Instrument Sans",
      fontSize: size,
      fontWeight: weight,
      fontVariations: variations,
    }) as ShapingRun;
  /** Serves the variable file for variable faces, the static one otherwise, counting loads. */
  const loader = () =>
    vi.fn(async (face: { variable?: boolean }) => (face.variable ? variableBytes() : bytes()));

  it("shapes text that sets axes from the family's variable file", async () => {
    const load = loader();
    const shaper = new Shaper(load, { makePath });
    expect(shaper.shape("Width", axesRun({ wdth: 75 }))).toBeNull();
    await shaper.load(shapingFace(axesRun({ wdth: 75 })));
    expect(load).toHaveBeenLastCalledWith(expect.objectContaining({ variable: true }));
    const narrow = shaper.shape("Width", axesRun({ wdth: 75 }));
    const normal = shaper.shape("Width", axesRun({ wdth: 100 }));
    expect(narrow?.width).toBeGreaterThan(0);
    expect(narrow?.width).toBeLessThan((normal?.width ?? 0) * 0.95);
    // The glyphs themselves change shape along the axis, not just their spacing.
    expect(narrow?.glyphs[0]?.d).not.toBe(normal?.glyphs[0]?.d);
  });

  it("draws the text's weight on the weight axis, from one file for every weight", async () => {
    const load = loader();
    const shaper = new Shaper(load, { makePath });
    await shaper.load(shapingFace(axesRun({ wdth: 100 })));
    const regular = shaper.shape("Bold", axesRun({ wdth: 100 }, 400));
    const bold = shaper.shape("Bold", axesRun({ wdth: 100 }, 700));
    expect(bold?.width).toBeGreaterThan(regular?.width ?? 0);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("clamps axes to what the font covers, and leaves out what it lacks", () => {
    const axes = { wght: { min: 400, max: 700 }, wdth: { min: 75, max: 100 } };
    expect(
      axisSettings(axes, { weight: 900, size: 12, variations: { wdth: 50, GRAD: 100 } }),
    ).toEqual({ wght: 700, wdth: 75 });
    // Optical size follows the font size unless the text sets it.
    const optical = { opsz: { min: 8, max: 144 } };
    expect(axisSettings(optical, { weight: 400, size: 12, variations: {} })).toEqual({ opsz: 12 });
    expect(axisSettings(optical, { weight: 400, size: 300, variations: {} })).toEqual({
      opsz: 144,
    });
    expect(axisSettings(optical, { weight: 400, size: 12, variations: { opsz: 48 } })).toEqual({
      opsz: 48,
    });
  });

  it("lists a variable font's axes with its names for them, and none for a static font", async () => {
    const shaper = new Shaper(loader(), { makePath });
    const face = { family: "Instrument Sans", weight: 400, italic: false };
    expect(await shaper.axes(face)).toEqual([
      { tag: "wdth", name: "Width", min: 75, default: 100, max: 100 },
      { tag: "wght", name: "Weight", min: 400, default: 400, max: 700 },
    ]);
    const staticOnly = new Shaper(async () => bytes(), { makePath });
    expect(await staticOnly.axes(face)).toEqual([]);
    const none = new Shaper(async () => null, { makePath });
    expect(await none.axes(face)).toBeNull();
  });

  it("keys runs by their axes, so each point on them is shaped and cached on its own", () => {
    expect(axesRun({ wdth: 75 }).key).not.toBe(axesRun({ wdth: 80 }).key);
    expect(axesRun({ wdth: 75, GRAD: 1 }).key).toBe(axesRun({ GRAD: 1, wdth: 75 }).key);
    expect(shapingFace(axesRun({ wdth: 75 })).variable).toBe(true);
    expect(shapingFace(run({ tnum: true })).variable).toBeUndefined();
    expect(shapingRun({ fontFamily: "Inter" })).toBeNull();
  });
});
