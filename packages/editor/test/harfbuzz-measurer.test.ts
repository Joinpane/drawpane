/**
 * The HarfBuzz measurer (decision 0021) in Node, with real fonts: Inter
 * (variable, weight only, as Google serves it to browsers) and Instrument
 * Sans. Values are checked against the fonts' own tables (read with
 * fontTools): advances, kerning, the weight axis, vertical metrics, and
 * what happens when a face or a character has no file. Parity with the
 * browser's canvas measurer is held in e2e/parity/text.spec.ts.
 */
import { readFileSync } from "node:fs";
import type { NodeRecord } from "@drawpane/model";
import { describe, expect, it } from "vitest";
import {
  type FaceFileLoader,
  HarfBuzzMeasurer,
  type MeasuredFace,
  measuredFaces,
  parseFont,
} from "../src/harfbuzz-measurer";
import { fontString, layoutText, type ShapingRun, shapingRun } from "../src/text";

const fixture = (name: string) => {
  const b = readFileSync(new URL(`../../../apps/web/e2e/fixtures/${name}`, import.meta.url));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};
const INTER = fixture("Inter-Variable.ttf");
const INTER_ITALIC = fixture("Inter-Italic-Variable.ttf");
const SANS = fixture("InstrumentSans-Variable.ttf");
const SANS_REGULAR = fixture("InstrumentSans-Regular.ttf");

/** Inter and Instrument Sans as the browser has them; anything else has no file. */
const loader: FaceFileLoader = async (face) => {
  if (face.family === "Inter") return face.italic ? INTER_ITALIC : INTER;
  if (face.family === "Instrument Sans") return face.canvas || face.variable ? SANS : SANS_REGULAR;
  return null;
};

const font = (family: string, size = 16, weight = 400, italic = false) =>
  fontString({
    fontFamily: family,
    fontSize: size,
    fontWeight: weight,
    fontStyle: italic ? "italic" : "normal",
  });

async function measurer(faces: MeasuredFace[] = [], load: FaceFileLoader = loader) {
  const m = new HarfBuzzMeasurer(load);
  await m.load([
    { family: "Inter", weight: 400, italic: false, canvas: true },
    { family: "Inter", weight: 700, italic: false, canvas: true },
    ...faces,
  ]);
  return m;
}

describe("parseFont", () => {
  it("reads the editor's font strings: style, weight, size, then families without aliases or generics", () => {
    expect(parseFont(font("Inter", 13.5, 600, true))).toEqual({
      italic: true,
      weight: 600,
      size: 13.5,
      families: ["Inter", "Drawpane Missing Glyph", "Instrument Sans"],
    });
    expect(
      parseFont('500 11px "Instrument Sans Variable", "Instrument Sans", system-ui, sans-serif'),
    ).toEqual({
      italic: false,
      weight: 500,
      size: 11,
      families: ["Instrument Sans"],
    });
    expect(parseFont("bold 20px 'Fira Code', monospace")?.weight).toBe(700);
    expect(parseFont("serif")).toBeNull();
  });
});

describe("HarfBuzzMeasurer", () => {
  it("measures at the font's own advances, kerned", async () => {
    const m = await measurer();
    // Inter: "H" is 1522 units of 2048.
    expect(m.width(font("Inter"), "H")).toBeCloseTo((1522 / 2048) * 16, 6);
    expect(m.width(font("Inter", 32), "H")).toBeCloseTo((1522 / 2048) * 32, 6);
    // "A" and "V" are 1413 each; kerned, the pair is narrower.
    const apart = (2 * 1413 * 16) / 2048;
    const av = m.width(font("Inter"), "AV");
    expect(av).toBeLessThan(apart - 0.5);
    expect(m.width(font("Inter"), "AVA")).toBeCloseTo(av + av - (1413 * 16) / 2048, 4);
    expect(m.approximations).toEqual([]);
  });

  it("draws a weight on the weight axis, at whole font units as Chromium does", async () => {
    const m = await measurer([{ family: "Inter", weight: 600, italic: false, canvas: true }]);
    const regular = m.width(font("Inter", 100), "n");
    const semibold = m.width(font("Inter", 100, 600), "n");
    const bold = m.width(font("Inter", 100, 700), "n");
    expect(semibold).toBeGreaterThan(regular);
    expect(bold).toBeGreaterThan(semibold);
    // Inter's "n" at 600 is 1253.196 units on the axis: HarfBuzz and Chromium both take 1253.
    expect(semibold).toBeCloseTo((1253 / 2048) * 100, 6);
  });

  it("measures italic from the italic file, and a family's missing style from its upright one", async () => {
    const m = await measurer([
      { family: "Inter", weight: 400, italic: true, canvas: true },
      { family: "Instrument Sans", weight: 400, italic: true, canvas: true },
    ]);
    expect(m.width(font("Inter", 16, 400, true), "Hamburgefonstiv")).not.toBeCloseTo(
      m.width(font("Inter"), "Hamburgefonstiv"),
      2,
    );
    expect(m.width(font("Instrument Sans", 16, 400, true), "Hamburg")).toBe(
      m.width(font("Instrument Sans"), "Hamburg"),
    );
  });

  it("reads ascent, descent and cap height as the canvas does, rounded as it reads them", async () => {
    const m = await measurer();
    // Inter sets USE_TYPO_METRICS; its typo and hhea metrics agree: 1984 and 494 of 2048
    // (0.96875 and 0.2412 em), read at 1000 px in whole pixels: 0.969 and 0.241.
    const metrics = m.metrics(font("Inter", 20));
    expect(metrics?.ascent).toBeCloseTo(0.969 * 20, 6);
    expect(metrics?.descent).toBeCloseTo(0.241 * 20, 6);
    // "H" is 1490 tall (0.7275 em), which Skia measures at 64 px in whole pixels: 47/64,
    // so the cap height is between 46/64 and 47/64; the middle stands for it.
    expect(metrics?.capHeight).toBeCloseTo((46.5 / 64) * 20, 6);
  });

  it("takes typo metrics only when the font asks for them, as Chromium does", async () => {
    // Instrument Sans with its typo ascender changed to 800 (hhea says 970).
    const patched = (useTypo: boolean) => {
      const bytes = SANS_REGULAR.slice(0);
      const v = new DataView(bytes);
      const tables = v.getUint16(4);
      for (let i = 0; i < tables; i++) {
        const at = 12 + i * 16;
        if (String.fromCharCode(...new Uint8Array(bytes, at, 4)) !== "OS/2") continue;
        const os2 = v.getUint32(at + 8);
        v.setInt16(os2 + 68, 800);
        const fsSelection = v.getUint16(os2 + 62);
        v.setUint16(os2 + 62, useTypo ? fsSelection | 0x80 : fsSelection & ~0x80);
      }
      return bytes;
    };
    for (const [useTypo, ascent] of [
      [true, 8],
      [false, 9.7],
    ] as const) {
      const m = new HarfBuzzMeasurer(async () => patched(useTypo));
      await m.load([{ family: "Patched", weight: 400, italic: false, canvas: true }]);
      expect(m.metrics(font("Patched", 10))?.ascent).toBeCloseTo(ascent, 6);
      expect(m.metrics(font("Patched", 10))?.descent).toBeCloseTo(2.5, 6);
    }
  });

  it("takes characters the face lacks from the fallback family, as the browser's font fallback does", async () => {
    const m = await measurer([
      { family: "Instrument Sans", weight: 400, italic: false, canvas: true },
    ]);
    // "Ș" isn't in the Inter subset; Instrument Sans has it.
    const mixed = m.width(font("Inter"), "HȘ");
    expect(mixed).toBeCloseTo(
      m.width(font("Inter"), "H") + m.width(font("Instrument Sans"), "Ș"),
      6,
    );
    expect(m.approximations).toEqual([]);
  });

  it("shapes a file the browser loads in subsets a subset at a time", async () => {
    // Google's Latin and Latin Extended subsets (abridged): "Ł" is in the second, "ó" in the first.
    const latin: Array<[number, number]> = [[0x20, 0xff]];
    const latinExt: Array<[number, number]> = [[0x100, 0x24f]];
    const whole = await measurer();
    const split = new HarfBuzzMeasurer(async (face) =>
      face.family === "Inter" ? { bytes: INTER, subsets: [latinExt, latin] } : loader(face),
    );
    await split.load([{ family: "Inter", weight: 400, italic: false, canvas: true }]);
    const f = font("Inter", 100);
    // Kerned together in one file; apart in two.
    expect(whole.width(f, "Ty")).toBeLessThan(whole.width(f, "T") + whole.width(f, "y"));
    expect(split.width(f, "Ty")).toBe(whole.width(f, "Ty"));
    expect(split.width(f, "Łó")).toBeCloseTo(whole.width(f, "Ł") + whole.width(f, "ó"), 6);
    // A character in no subset comes from the next family, though the file has it.
    const subsetOnly = new HarfBuzzMeasurer(async (face) =>
      face.family === "Inter" ? { bytes: INTER, subsets: [latin] } : loader(face),
    );
    await subsetOnly.load([{ family: "Inter", weight: 400, italic: false, canvas: true }]);
    expect(subsetOnly.width(f, "Ł")).toBe(whole.width(font("Instrument Sans", 100), "Ł"));
  });

  it("measures a family without a file in the fallback family, and says so", async () => {
    const m = await measurer();
    expect(m.width(font("Comic Neue"), "Hamburg")).toBe(
      m.width(font("Instrument Sans"), "Hamburg"),
    );
    expect(m.metrics(font("Comic Neue", 10))?.ascent).toBeCloseTo(9.7, 6);
    expect(m.approximations).toContainEqual({
      family: "Comic Neue",
      weight: 400,
      italic: false,
      reason: "face",
    });
    m.clearApproximations();
    expect(m.approximations).toEqual([]);
    // Measured again (from the cache), it's noted again.
    m.width(font("Comic Neue"), "Hamburg");
    expect(m.approximations).toEqual([
      { family: "Comic Neue", weight: 400, italic: false, reason: "face" },
    ]);
  });

  it("estimates characters no file has, and says so", async () => {
    const m = await measurer();
    // CJK is a full em in any font; the browser takes it from a system font.
    expect(m.width(font("Inter", 20), "漢字")).toBe(40);
    expect(m.width(font("Inter", 20), "H漢")).toBeCloseTo(m.width(font("Inter", 20), "H") + 20, 6);
    expect(m.approximations).toEqual([
      { family: "Inter", weight: 400, italic: false, reason: "glyphs" },
    ]);
  });

  it("never throws: a loader that fails leaves estimates, and nothing loaded leaves no metrics", async () => {
    const m = new HarfBuzzMeasurer(async () => {
      throw new Error("offline");
    });
    const { missing } = await m.load([
      { family: "Inter", weight: 400, italic: false, canvas: true },
    ]);
    expect(missing).toHaveLength(1);
    expect(m.status(missing[0] as MeasuredFace)).toBe("unavailable");
    expect(m.width(font("Inter", 10), "ab")).toBeCloseTo(11, 6);
    expect(m.metrics(font("Inter"))).toBeNull();
    expect(m.approximations.map((a) => a.reason).sort()).toEqual(["face", "glyphs"]);
  });

  it("shapes runs with features or axes as the browser's shaper does", async () => {
    const sans: ShapingRun = shapingRun({
      fontFamily: "Instrument Sans",
      fontSize: 10,
      fontFeatures: { tnum: true },
    }) as ShapingRun;
    const m = await measurer([{ family: "Instrument Sans", weight: 400, italic: false }]);
    // Instrument Sans: tabular "1" is 600 units of 1000.
    expect(m.width(font("Instrument Sans", 10), "1111", sans)).toBeCloseTo(24, 6);
    expect(m.shape("1111", sans)?.glyphs).toHaveLength(4);
    expect(m.width(font("Instrument Sans", 10), "1111")).toBeLessThan(24);
  });

  it("is bumped as faces load, and remeasures then", async () => {
    const m = new HarfBuzzMeasurer(loader);
    const before = m.width(font("Inter"), "H");
    const generation = m.generation;
    await m.load([{ family: "Inter", weight: 400, italic: false, canvas: true }]);
    expect(m.generation).toBeGreaterThan(generation);
    expect(m.width(font("Inter"), "H")).not.toBe(before);
    expect(m.width(font("Inter"), "H")).toBeCloseTo((1522 / 2048) * 16, 6);
  });

  it("lays out text as the canvas would: letter spacing on top, lines broken at the measured widths", async () => {
    const m = await measurer();
    const node = {
      id: "t",
      type: "text",
      parentId: null,
      index: "a0",
      props: {
        characters: "AV To Ty",
        fontFamily: "Inter",
        fontSize: 16,
        letterSpacing: { unit: "px", value: 2 },
      },
    } as unknown as NodeRecord;
    const layout = layoutText(node, m, null);
    expect(layout.lines[0]?.width).toBeCloseTo(m.width(font("Inter"), "AV To Ty") + 2 * 8, 4);
    // Auto line height is the font's own, rounded: 19.375 → 19.
    expect(layout.lines[0]?.height).toBe(19);
  });
});

describe("measuredFaces", () => {
  it("lists each text layer's faces as the canvas draws them, and its runs' shaping faces", () => {
    const node = {
      id: "t",
      type: "text",
      parentId: null,
      index: "a0",
      props: {
        characters: "Hello world",
        fontFamily: "Inter",
        fontWeight: 600,
        textRuns: [{ start: 6, end: 11, fontStyle: "italic", fontVariations: { wght: 650 } }],
      },
    } as unknown as NodeRecord;
    const rect = {
      id: "r",
      type: "rect",
      parentId: null,
      index: "a1",
      props: {},
    } as unknown as NodeRecord;
    expect(measuredFaces([node, rect])).toEqual([
      { family: "Inter", weight: 600, italic: false, canvas: true },
      { family: "Inter", weight: 600, italic: true, canvas: true },
      { family: "Inter", weight: 600, italic: true, variable: true },
    ]);
  });
});
