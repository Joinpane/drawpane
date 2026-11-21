/**
 * OpenType features through the real HarfBuzz, with a real font (Instrument
 * Sans, which has tabular figures and ligatures), in Node: Path2D doesn't
 * exist here, so outlines are kept as their path data.
 */
import { readFileSync } from "node:fs";
import { ROOT_ID } from "@drawpane/model";
import { describe, expect, it, vi } from "vitest";
import { Editor } from "../src/editor";
import { DisplayListBuilder } from "../src/engine/display-list";
import { MISSING_GLYPH_FAMILY } from "../src/missing-glyph-font";
import { axisSettings, Shaper, ShapingMeasurer, shapingFace } from "../src/shaping";
import { autoSize, layoutText, type ShapingRun, shapingRun, type TextMeasurer } from "../src/text";

const FONT = readFileSync(
  new URL("../../../apps/web/e2e/fixtures/InstrumentSans-Regular.ttf", import.meta.url),
);
const bytes = () => FONT.buffer.slice(FONT.byteOffset, FONT.byteOffset + FONT.byteLength);
const makePath = (d: string) => ({ d }) as unknown as Path2D;

function run(features: Record<string, boolean>, size = 10, family = "Instrument Sans") {
  return (
    shapingRun({ fontFamily: family, fontSize: size, fontFeatures: features }) ?? {
      family,
      weight: 400,
      italic: false,
      size,
      features,
      variations: {},
      key: `${family}|${size}`,
    }
  );
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

  it("keeps default kerning and UTF-16 clusters across missing symbols and scripts", async () => {
    const shaper = new Shaper(
      async (face) => (face.family === "Instrument Sans" ? bytes() : null),
      { makePath },
    );
    const missing = run({ tnum: true }, 10, "SF Pro");
    expect(shaper.shapeForEngine("AV", missing)).toHaveProperty("waiting");
    expect(await shaper.load(shapingFace(missing))).toBe("unavailable");
    await Promise.all([
      shaper.load({ family: "Instrument Sans", weight: 400, italic: false, variable: true }),
      shaper.load({ family: MISSING_GLYPH_FAMILY, weight: 400, italic: false }),
    ]);
    const result = shaper.shapeForEngine("AV\u{100001}漢111", missing);
    if ("waiting" in result) throw new Error("Fallback faces are ready");
    expect(result.fallback).toBe(true);
    const glyphs = result.shaped.glyphs;
    expect(glyphs.map((g) => g.cluster)).toEqual([0, 1, 2, 4, 5, 6, 7]);
    expect(glyphs.every((g) => g.d.length > 0)).toBe(true);
    const kerned = shaper.shapeForEngine("AV", missing);
    if ("waiting" in kerned) throw new Error("Fallback faces are ready");
    const figures = shaper.shapeForEngine("111", missing);
    if ("waiting" in figures) throw new Error("Fallback faces are ready");
    expect(glyphs[2]?.x).toBeCloseTo(kerned.shaped.width, 5);
    expect(figures.shaped.width).toBeLessThan(18);
    expect(result.shaped.width).toBeCloseTo(kerned.shaped.width + 7 + 10 + figures.shaped.width, 5);
  });

  it("fits substitute glyph clusters to the same prefix advances used by the caret", async () => {
    const shaper = new Shaper(async ({ family }) => (family === "Arimo" ? bytes() : null), {
      makePath,
      substitute: () => ({ family: "Arimo", weight: 400, italic: false }),
    });
    const arial = run({}, 36, "Arial");
    await Promise.all([
      shaper.load(shapingFace(arial)),
      shaper.load({ family: "Arimo", weight: 400, italic: false }),
      shaper.load({ family: "Instrument Sans", weight: 400, italic: false, variable: true }),
    ]);
    const widths = new Map([
      ["", 0],
      ["A", 18],
      ["AV", 41],
      ["AVH", 68],
    ]);
    const result = shaper.shapeForEngine("AVH", arial, (prefix) => widths.get(prefix) ?? 0);
    if ("waiting" in result) throw new Error("Faces already settled");
    expect(result.shaped.width).toBe(68);
    expect(result.shaped.glyphs.map((glyph) => glyph.x)).toEqual([0, 18, 41]);
    expect(result.shaped.glyphs.every((glyph) => glyph.d)).toBe(true);
    expect(result.dependencies?.some((key) => key.startsWith("Arimo"))).toBe(true);
  });

  it("preloads bundled fallbacks and waits past the ordinary face deadline", async () => {
    await import("harfbuzzjs");
    vi.useFakeTimers();
    try {
      const loader = vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 4000));
        return bytes();
      });
      const shaper = new Shaper(loader, {
        fallbackFamily: "Instrument Sans Variable",
        bundledRetryMs: [250],
        makePath,
      });
      const face = {
        family: "Instrument Sans Variable",
        weight: 400,
        italic: false,
        variable: true,
      };
      shaper.preloadFallback();
      expect(loader).toHaveBeenCalledWith(face);
      expect(shaper.started({ family: MISSING_GLYPH_FAMILY, weight: 400, italic: false })).toBe(
        true,
      );
      await vi.advanceTimersByTimeAsync(3001);
      expect(shaper.status(face)).toBe("loading");
      await vi.advanceTimersByTimeAsync(999);
      expect(await shaper.load(face)).toBe("ready");
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries a failed bundled download with backoff and keeps the text provisional", async () => {
    await import("harfbuzzjs");
    vi.useFakeTimers();
    try {
      const loader = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(bytes());
      const shaper = new Shaper(loader, { bundledRetryMs: [250, 1000], makePath });
      const face = { family: "Instrument Sans", weight: 400, italic: false, variable: true };
      const status = shaper.load(face);
      await vi.advanceTimersByTimeAsync(249);
      expect(shaper.status(face)).toBe("loading");
      expect(loader).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(await status).toBe("ready");
      expect(loader).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("draws RTL runs in visual order without reversing European digits", async () => {
    const shaper = new Shaper(async ({ family }) =>
      family === "Instrument Sans" ? bytes() : null,
    );
    const missing = run({}, 16, "Unknown Hebrew Font");
    await Promise.all([
      shaper.load(shapingFace(missing)),
      shaper.load({ family: "Instrument Sans", weight: 400, italic: false, variable: true }),
    ]);
    const result = shaper.shapeForEngine("מחיר 100", missing);
    if ("waiting" in result) throw new Error("Faces already settled");
    expect(result.shaped.glyphs.map((glyph) => glyph.cluster)).toEqual([5, 6, 7, 4, 3, 2, 1, 0]);
  });

  it("uses script outlines after Instrument Sans and changes only runs with that coverage", async () => {
    const fixture = readFileSync(new URL("./fixtures/NotoSansSC-Subset.ttf", import.meta.url));
    const noto = fixture.buffer.slice(fixture.byteOffset, fixture.byteOffset + fixture.byteLength);
    const script = { family: "Noto Sans SC", subset: "中漢", weight: 400, italic: false };
    let prepared = false;
    const shaper = new Shaper(
      async (face) =>
        face.subset === script.subset ? noto : face.family === "Instrument Sans" ? bytes() : null,
      { fallbackFaces: () => (prepared ? [script] : []) },
    );
    const missing = run({}, 24, "Missing");
    await Promise.all([
      shaper.load(shapingFace(missing)),
      shaper.load({ family: "Instrument Sans", weight: 400, italic: false, variable: true }),
    ]);
    const latin = shaper.shapeForEngine("A", missing);
    const first = shaper.shapeForEngine("漢中", missing);
    expect(first.dependencies).toContain("script:漢");
    prepared = true;
    await shaper.load(script);
    shaper.invalidateMeasurements(new Set(), script.subset);
    const result = shaper.shapeForEngine("漢中", missing);
    if ("waiting" in result || "waiting" in first) throw new Error("Faces already settled");
    expect(result.shaped.glyphs[0]?.d).not.toBe(first.shaped.glyphs[0]?.d);
    expect(result.shaped.glyphs[0]?.d).not.toBe(result.shaped.glyphs[1]?.d);
    expect(shaper.shapeForEngine("A", missing)).toBe(latin);
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

  it("gives a face that never loads up at its deadline, and takes its file if it comes late", async () => {
    // A font request that stalls: its text isn't left waiting for as long as the file is open.
    let arrive: (b: ArrayBuffer) => void = () => {};
    const file = new Promise<ArrayBuffer>((resolve) => {
      arrive = resolve;
    });
    const shaper = new Shaper(() => file, { makePath, loadDeadlineMs: 20 });
    const heard = vi.fn();
    shaper.subscribe(heard);
    const face = { family: "Instrument Sans", weight: 400, italic: false };
    expect(await shaper.load(face)).toBe("unavailable");
    expect(heard).toHaveBeenCalledTimes(1);
    expect(shaper.generation).toBe(1);
    expect(shaper.shape("12", run({ tnum: true }))).toBeNull();
    // The file comes after all: the face is ready, and listeners hear it again.
    arrive(bytes());
    await vi.waitFor(() => expect(shaper.status(face)).toBe("ready"));
    expect(heard).toHaveBeenCalledTimes(2);
    expect(shaper.generation).toBe(2);
    expect(shaper.shape("12", run({ tnum: true }))).not.toBeNull();
  });

  it("keeps a face that never loads unavailable, once, however long it stalls", async () => {
    vi.useFakeTimers();
    try {
      const shaper = new Shaper(() => new Promise<ArrayBuffer>(() => {}), { makePath });
      const heard = vi.fn();
      shaper.subscribe(heard);
      const face = { family: "Instrument Sans", weight: 400, italic: false };
      const status = shaper.load(face);
      expect(shaper.status(face)).toBe("loading");
      await vi.advanceTimersByTimeAsync(2999);
      expect(shaper.status(face)).toBe("loading");
      await vi.advanceTimersByTimeAsync(1);
      expect(await status).toBe("unavailable");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(heard).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
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

describe("text dependencies in display lists", () => {
  it("re-encodes only the layers that use the face that settled", () => {
    let revision = 0;
    const shapeForEngine = vi.fn((text: string) => ({
      shaped: { glyphs: [], width: 10, scale: 0.01 },
      fallback: true,
      dependencies: [text],
    }));
    const measurer: TextMeasurer = {
      width: () => 10,
      shapeForEngine,
      get generation() {
        return revision;
      },
      get faceGeneration() {
        return revision;
      },
      faceRevision: (key) => (key === "first" ? revision : 0),
    };
    const editor = new Editor({ measurer, clientId: "t" });
    editor.doc.apply([
      { op: "create", id: "p", type: "page", parent: ROOT_ID, key: "a0", props: {} },
      ...["first", "second"].map((text, index) => ({
        op: "create" as const,
        id: text,
        parent: "p",
        key: `a${index}`,
        type: "text" as const,
        props: { characters: text, width: 100, height: 30 },
      })),
    ]);
    const builder = new DisplayListBuilder(editor.scene, measurer);
    builder.build("p");
    shapeForEngine.mockClear();
    revision++;
    expect(builder.update()).not.toBeNull();
    expect(shapeForEngine.mock.calls.map(([text]) => text)).toEqual(["first"]);
    expect(builder.stats.records).toBe(1);
  });

  it("uses one image for a colour emoji sequence and swaps its zoom bucket", () => {
    const measurer = { width: (_font: string, text: string) => [...text].length * 10 };
    const editor = new Editor({ measurer, clientId: "t" });
    editor.doc.apply([
      { op: "create", id: "p", type: "page", parent: ROOT_ID, key: "a0", props: {} },
      {
        op: "create",
        id: "t",
        type: "text",
        parent: "p",
        key: "a0",
        props: { characters: "A👩‍🔬B", width: 100, height: 30 },
      },
    ]);
    const raster = vi.fn((_: string, _font: string, scale: number) => ({
      ref: `emoji-${scale}`,
      handle: scale,
      x: 0,
      y: -16,
      width: 16,
      height: 16,
    }));
    const builder = new DisplayListBuilder(editor.scene, measurer, { colorGlyph: raster });
    builder.build("p");
    expect(raster.mock.calls.map(([text, _, scale]) => [text, scale])).toEqual([["👩‍🔬", 1]]);
    expect([...builder.imagesInUse()]).toEqual(["emoji-1"]);
    builder.setColorScale(1.5);
    expect(builder.update()).not.toBeNull();
    expect([...builder.imagesInUse()]).toEqual(["emoji-2"]);
  });
});
