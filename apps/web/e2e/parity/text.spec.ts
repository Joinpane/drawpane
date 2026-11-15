/**
 * Text measurement parity (decision 0021): the headless editor measures
 * text with HarfBuzz, the browser with the canvas, and a layout an agent
 * makes headless has to be the one a person sees. Both measurers get the
 * same font files (Inter, upright and italic, as Google serves it to
 * browsers; Instrument Sans, the default family) and measure a corpus:
 * weights 400 to 800, italic, sizes 11 to 96, kerning pairs, punctuation,
 * figures, accented Latin, letter spacing, wrapped paragraphs, a run with a
 * variable axis and one with a feature, and some CJK and Arabic, which the
 * browser takes from system fonts the Worker doesn't have (recorded, held
 * loosely). Widths are compared at 16 px (the difference scaled to 16 px),
 * metrics as a share of the canvas's. The numbers go to PARITY_OUT, by
 * default test-results/parity/text.json.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { freshInstance, type Instance } from "../fresh-instance";

const OUT =
  process.env.PARITY_OUT ?? fileURLToPath(new URL("../../test-results/parity", import.meta.url));
const font = (name: string) =>
  readFileSync(new URL(`../fixtures/${name}`, import.meta.url)).toString("base64");

/** A stylesheet's unicode-range subsets, in order, as [first, last] code points. */
function unicodeRanges(css: string): Array<Array<[number, number]>> {
  return [...css.matchAll(/unicode-range:\s*([^;}]+)/g)].map(([, list = ""]) =>
    list.split(",").map((part) => {
      const [a = "0", b = a] = part.trim().replace(/^U\+/i, "").split("-");
      return [
        Number.parseInt(a.replace(/\?/g, "0"), 16),
        Number.parseInt(b.replace(/\?/g, "F"), 16),
      ];
    }),
  );
}
/** The subsets the app loads its Instrument Sans as (Fontsource's: Latin Extended, then Latin). */
const BUNDLED_SUBSETS = unicodeRanges(
  readFileSync(
    fileURLToPath(
      new URL(
        "../../../../packages/ui/node_modules/@fontsource-variable/instrument-sans/index.css",
        import.meta.url,
      ),
    ),
    "utf8",
  ),
);

/** Most a Latin width may differ, scaled to 16 px. */
const WIDTH_16 = 0.05;
/** Most ascent, descent or cap height may differ, as a share of the canvas's. */
const METRICS = 0.005;
/** Most a CJK or Arabic width may differ, as a share: the browser has system fonts the Worker estimates. */
const SCRIPTS = 0.6;

const FAMILIES = ["Inter", "Instrument Sans"] as const;
const WEIGHTS = [400, 600, 700, 800] as const;
const SIZES = [11, 13, 16, 24, 48, 96] as const;
const LATIN = [
  "Hamburgefonstiv",
  "The quick brown fox jumps over the lazy dog.",
  "AV To Ty Wa Yo LT AVATAR",
  "Typography, Tracking & Kerning",
  "0123456789 $1,234.56 +42% 3/4",
  "“Quotes,” (parens) [brackets] {braces} \u2014 dashes – ellipsis… ¿¡!?",
  "Crème brûlée à Zürich, Ñandú, Øresund, Łódź, Šťastný",
  "fi fl ffi office affluent",
  "Quarterly report",
] as const;
const SCRIPT_STRINGS = [
  "漢字かなカナ한글",
  "東京都渋谷区",
  "مرحبا بالعالم",
  "Hello مرحبا world",
] as const;
const PARAGRAPH =
  "Type is laid out at the font's own advances, kerned, so a line breaks where it would in Figma. AV, To and Ty pull together; figures like 1,234.56 keep their place.";

type Measured = {
  family: string;
  weight: number;
  italic: boolean;
  size: number;
  text: string;
  canvas: number;
  harfbuzz: number;
};
type Metrics = {
  family: string;
  weight: number;
  italic: boolean;
  canvas: { ascent: number; descent: number; capHeight?: number } | null;
  harfbuzz: { ascent: number; descent: number; capHeight?: number } | null;
};
type Layouts = Array<{
  name: string;
  canvas: Array<{ text: string; width: number; height: number }>;
  harfbuzz: Array<{ text: string; width: number; height: number }>;
}>;
type Runs = Array<{ name: string; canvas: number; harfbuzz: number }>;
type Report = {
  widths: Measured[];
  scripts: Measured[];
  bundled: Measured[];
  metrics: Metrics[];
  layouts: Layouts;
  runs: Runs;
  approximations: unknown[];
};

type MeasureModule = typeof import("../../src/editor/measure-parity");
type W = { drawpaneMeasurers: () => Promise<MeasureModule> };

/** Measures the corpus in the page with both measurers, fed the same files. */
function measure(page: Page): Promise<Report> {
  return page.evaluate(
    async ({ files, families, weights, sizes, latin, scripts, paragraph, subsets }) => {
      const m = await (window as unknown as W).drawpaneMeasurers();
      const bytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer;
      const inter = bytes(files.inter);
      const interItalic = bytes(files.interItalic);
      const sans = bytes(files.sans);
      // As the browser has them: Google's Inter for every weight, Instrument Sans upright only.
      for (const face of [
        new FontFace("Inter", inter.slice(0), { weight: "100 900" }),
        new FontFace("Inter", interItalic.slice(0), { weight: "100 900", style: "italic" }),
        new FontFace("Instrument Sans", sans.slice(0), { weight: "400 700" }),
      ]) {
        await face.load();
        document.fonts.add(face);
      }

      const fileFor = async (face: { family: string; italic: boolean }) =>
        face.family === "Inter"
          ? face.italic
            ? interItalic
            : inter
          : face.family === "Instrument Sans"
            ? sans
            : null;
      const canvas = new m.CanvasTextMeasurer();
      const harfbuzz = new m.HarfBuzzMeasurer(fileFor);
      const faces = families.flatMap((family) =>
        weights.flatMap((weight) =>
          [false, true].map((italic) => ({ family, weight, italic, canvas: true })),
        ),
      );
      const { missing } = await harfbuzz.load(faces);
      if (missing.length > 0) throw new Error(`Faces without files: ${JSON.stringify(missing)}`);

      const fontOf = (family: string, weight: number, italic: boolean, size: number) =>
        m.fontString({
          fontFamily: family,
          fontWeight: weight,
          fontStyle: italic ? "italic" : "normal",
          fontSize: size,
        });
      const widths: Array<Record<string, unknown>> = [];
      const scriptWidths: Array<Record<string, unknown>> = [];
      const metrics: Array<Record<string, unknown>> = [];
      for (const family of families)
        for (const weight of weights)
          for (const italic of [false, true]) {
            metrics.push({
              family,
              weight,
              italic,
              canvas: canvas.metrics(fontOf(family, weight, italic, 1000)),
              harfbuzz: harfbuzz.metrics(fontOf(family, weight, italic, 1000)),
            });
            for (const size of sizes) {
              const f = fontOf(family, weight, italic, size);
              for (const text of latin)
                widths.push({
                  family,
                  weight,
                  italic,
                  size,
                  text,
                  canvas: canvas.width(f, text),
                  harfbuzz: harfbuzz.width(f, text),
                });
              if (size === 16 && weight === 400)
                for (const text of scripts)
                  scriptWidths.push({
                    family,
                    weight,
                    italic,
                    size,
                    text,
                    canvas: canvas.width(f, text),
                    harfbuzz: harfbuzz.width(f, text),
                  });
            }
          }
      const scriptApproximations = harfbuzz.approximations;

      // The bundled Instrument Sans the app ships (Fontsource's, in subsets), against the file the
      // Worker reads, told the same subsets.
      const bundled: Array<Record<string, unknown>> = [];
      const inSubsets = new m.HarfBuzzMeasurer(async (face) =>
        face.family === "Instrument Sans" ? { bytes: sans, subsets } : fileFor(face),
      );
      await inSubsets.load(
        [400, 500, 600, 700].map((weight) => ({
          family: "Instrument Sans",
          weight,
          italic: false,
          canvas: true,
        })),
      );
      for (const weight of [400, 500, 600, 700])
        for (const text of latin) {
          const f = `${weight} 16px "Instrument Sans Variable"`;
          // Its subsets (Latin, Latin Extended) load as text needs them.
          await document.fonts.load(f, text);
          canvas.invalidate();
          const h = fontOf("Instrument Sans", weight, false, 16);
          bundled.push({
            family: "Instrument Sans Variable",
            weight,
            italic: false,
            size: 16,
            text,
            canvas: canvas.width(f, text),
            harfbuzz: inSubsets.width(h, text),
          });
        }

      // Whole layouts: letter spacing on top of the widths, and paragraphs wrapped at them.
      const node = (props: Record<string, unknown>) =>
        ({
          id: "t",
          type: "text",
          parentId: null,
          index: "a0",
          props: { characters: paragraph, ...props },
        }) as never;
      const cases: Array<[string, Record<string, unknown>, number | null]> = [
        ["Inter 16, wrapped at 240", { fontFamily: "Inter", fontSize: 16 }, 240],
        [
          "Inter 13 semibold, 2 px letter spacing, wrapped at 200",
          {
            fontFamily: "Inter",
            fontSize: 13,
            fontWeight: 600,
            letterSpacing: { unit: "px", value: 2 },
          },
          200,
        ],
        [
          "Instrument Sans 14, -2% letter spacing, wrapped at 180",
          {
            fontFamily: "Instrument Sans",
            fontSize: 14,
            letterSpacing: { unit: "percent", value: -2 },
          },
          180,
        ],
        [
          "Inter 24 italic, 10% letter spacing, one line",
          {
            fontFamily: "Inter",
            fontSize: 24,
            fontStyle: "italic",
            letterSpacing: { unit: "percent", value: 10 },
          },
          null,
        ],
        [
          "Instrument Sans 11 bold, wrapped at 120",
          { fontFamily: "Instrument Sans", fontSize: 11, fontWeight: 700 },
          120,
        ],
      ];
      const lines = (l: ReturnType<MeasureModule["layoutText"]>) =>
        l.lines.map((line) => ({ text: line.text, width: line.width, height: line.height }));
      const layouts = cases.map(([name, props, width]) => ({
        name,
        canvas: lines(m.layoutText(node(props), canvas, width)),
        harfbuzz: lines(m.layoutText(node(props), harfbuzz, width)),
      }));

      // Runs with a variable axis or a feature: the browser's shaping measurer against the headless one.
      const shaper = new m.Shaper(async (face) => fileFor(face));
      const shaping = new m.ShapingMeasurer(canvas, shaper);
      const runs: Array<{ name: string; canvas: number; harfbuzz: number }> = [];
      for (const [name, props] of [
        ["Inter wght 550", { fontFamily: "Inter", fontSize: 20, fontVariations: { wght: 550 } }],
        [
          "Instrument Sans wdth 80",
          { fontFamily: "Instrument Sans", fontSize: 20, fontVariations: { wdth: 80 } },
        ],
        [
          "Inter tabular figures",
          { fontFamily: "Inter", fontSize: 20, fontFeatures: { tnum: true } },
        ],
      ] as const) {
        const props2 = props as Record<string, unknown>;
        const run = shapingRunOf(m, props2);
        const face = {
          family: run.family,
          weight: run.weight,
          italic: run.italic,
          ...(Object.keys(run.variations).length > 0 ? { variable: true } : {}),
        };
        await shaper.load(face);
        await harfbuzz.load([face]);
        const f = m.fontString(props2);
        const text = "Hamburgefonstiv 1,234.56";
        runs.push({
          name,
          canvas: shaping.width(f, text, run),
          harfbuzz: harfbuzz.width(f, text, run),
        });
      }

      function shapingRunOf(mod: MeasureModule, props: Record<string, unknown>) {
        return mod.shapingRun(props) as NonNullable<ReturnType<MeasureModule["shapingRun"]>>;
      }

      return {
        widths,
        scripts: scriptWidths,
        bundled,
        metrics,
        layouts,
        runs,
        approximations: scriptApproximations,
      } as unknown as Report;
    },
    {
      files: {
        inter: font("Inter-Variable.ttf"),
        interItalic: font("Inter-Italic-Variable.ttf"),
        sans: font("InstrumentSans-Variable.ttf"),
      },
      families: [...FAMILIES],
      weights: [...WEIGHTS],
      sizes: [...SIZES],
      latin: [...LATIN],
      scripts: [...SCRIPT_STRINGS],
      paragraph: PARAGRAPH,
      subsets: BUNDLED_SUBSETS,
    },
  );
}

/** The difference between two widths, scaled to 16 px. */
const at16 = (w: Measured) => (Math.abs(w.canvas - w.harfbuzz) * 16) / w.size;
const share = (a: number, b: number) => Math.abs(a - b) / Math.max(Math.abs(a), 1e-9);

test.describe("Text measurement parity", () => {
  test.describe.configure({ mode: "serial" });
  let instance: Instance;
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000);
    instance = await freshInstance(browser, { port: 9003, inspectorPort: 9543 });
    page = instance.page;
    await page.evaluate(() => localStorage.setItem("drawpane:debug", "1"));
    await page.getByRole("button", { name: "New file" }).first().click();
    await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
      timeout: 15_000,
    });
  });

  test.afterAll(async () => {
    await instance?.stop();
  });

  test("HarfBuzz measures text as the canvas does", async () => {
    test.setTimeout(120_000);
    const report = await measure(page);
    mkdirSync(OUT, { recursive: true });
    writeFileSync(join(OUT, "text.json"), JSON.stringify(report, null, 2));

    const worst = (list: Measured[]) =>
      list.reduce((a, b) => (at16(b) > at16(a) ? b : a), list[0] as Measured);
    const summary = {
      latin: {
        count: report.widths.length,
        worst16: at16(worst(report.widths)),
        at: worst(report.widths),
      },
      bundled: { worst16: at16(worst(report.bundled)), at: worst(report.bundled) },
      metrics: Math.max(
        ...report.metrics.flatMap((m) =>
          m.canvas && m.harfbuzz
            ? [
                share(m.canvas.ascent, m.harfbuzz.ascent),
                share(m.canvas.descent, m.harfbuzz.descent),
                share(m.canvas.capHeight ?? 0, m.harfbuzz.capHeight ?? 0),
              ]
            : [1],
        ),
      ),
      scripts: report.scripts.map((s) => ({
        text: s.text,
        family: s.family,
        italic: s.italic,
        canvas: s.canvas,
        harfbuzz: s.harfbuzz,
        share: share(s.canvas, s.harfbuzz),
      })),
      runs: report.runs,
      layouts: report.layouts.map((l) => ({
        name: l.name,
        lines: [l.canvas.length, l.harfbuzz.length],
        worst: Math.max(...l.canvas.map((c, i) => Math.abs(c.width - (l.harfbuzz[i]?.width ?? 0)))),
      })),
    };
    console.log(JSON.stringify(summary, null, 2));

    for (const w of report.widths)
      expect(
        at16(w),
        `${w.family} ${w.weight}${w.italic ? " italic" : ""} ${w.size}px "${w.text}"`,
      ).toBeLessThanOrEqual(WIDTH_16);
    for (const w of report.bundled)
      expect(at16(w), `bundled ${w.weight} "${w.text}"`).toBeLessThanOrEqual(WIDTH_16);
    for (const m of report.metrics) {
      const name = `${m.family} ${m.weight}${m.italic ? " italic" : ""}`;
      expect(m.canvas, name).not.toBeNull();
      expect(m.harfbuzz, name).not.toBeNull();
      if (!m.canvas || !m.harfbuzz) continue;
      // Linux's Chromium moves a pixel (at 1000 px) from ascent to descent when descent rounds down; the sum holds.
      expect(m.harfbuzz.ascent + m.harfbuzz.descent, `${name} ascent and descent`).toBeCloseTo(
        m.canvas.ascent + m.canvas.descent,
        6,
      );
      expect(share(m.canvas.ascent, m.harfbuzz.ascent), `${name} ascent`).toBeLessThanOrEqual(
        METRICS,
      );
      expect(share(m.canvas.descent, m.harfbuzz.descent), `${name} descent`).toBeLessThanOrEqual(
        METRICS,
      );
      expect(
        share(m.canvas.capHeight ?? 0, m.harfbuzz.capHeight ?? 0),
        `${name} cap height`,
      ).toBeLessThanOrEqual(METRICS);
    }
    for (const l of report.layouts) {
      expect(
        l.harfbuzz.map((x) => x.text),
        l.name,
      ).toEqual(l.canvas.map((x) => x.text));
      for (const [i, line] of l.canvas.entries()) {
        expect(
          Math.abs(line.width - (l.harfbuzz[i]?.width ?? 0)),
          `${l.name}, line ${i + 1}`,
        ).toBeLessThanOrEqual(WIDTH_16 * 2);
        expect(l.harfbuzz[i]?.height, `${l.name}, line ${i + 1}`).toBe(line.height);
      }
    }
    for (const r of report.runs)
      expect(Math.abs(r.canvas - r.harfbuzz), r.name).toBeLessThanOrEqual(0.001);
    for (const s of report.scripts)
      expect(share(s.canvas, s.harfbuzz), s.text).toBeLessThanOrEqual(SCRIPTS);
    // Characters no file has are estimated, and said to be.
    expect(report.approximations).toContainEqual(expect.objectContaining({ reason: "glyphs" }));
  });
});
