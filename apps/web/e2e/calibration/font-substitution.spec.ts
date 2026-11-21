import type * as EditorModule from "@drawpane/editor";
import { expect, test } from "@playwright/test";

const cases = [
  { sample: "Kerning AVAV", direction: "ltr", fixture: "NotoSans-Metrics.ttf" },
  { sample: "Καλημέρα", direction: "ltr", fixture: "NotoSans-Metrics.ttf" },
  { sample: "Привет", direction: "ltr", fixture: "NotoSans-Metrics.ttf" },
  { sample: "مرحبا بالعالم", direction: "rtl", fixture: "NotoSansArabic-Metrics.ttf" },
] as const;

for (const cell of cases) {
  test(`substituted outline spacing for ${cell.sample}`, async ({ page }) => {
    await page.goto("/e2e/calibration/font-substitution.html");
    const result = await page.evaluate(async ({ sample, direction, fixture }) => {
      // Vite serves this test's real TypeScript modules from the workspace.
      const moduleUrl = "/e2e/calibration/system-text-harness.ts";
      const { Shaper, CanvasTextMeasurer } = (await import(moduleUrl)) as typeof EditorModule;
      const url = `/e2e/fixtures/${fixture}`;
      const bytes = await (await fetch(url)).arrayBuffer();
      const style = document.createElement("style");
      style.textContent = `@font-face { font-family: "Different Metrics"; src: url(${url}); size-adjust: 80%; }`;
      document.head.append(style);
      await document.fonts.load('36px "Different Metrics"', sample);
      const font = new CanvasTextMeasurer();
      const face = { family: "Test Outline", weight: 400, italic: false };
      const shaper = new Shaper(
        async (requested) => (requested.family === face.family ? bytes : null),
        {
          fallbackFaces: () => [face],
        },
      );
      await shaper.load(face);
      const styleRun = {
        ...face,
        size: 36,
        features: {},
        variations: {},
        direction,
        key: "outline",
      };
      const exact = shaper.shape(sample, styleRun);
      if (!exact || exact.glyphs.length === 0) throw new Error("Empty reference outline");
      const tests = ['36px "Different Metrics"', "36px system-ui"];
      return Promise.all(
        tests.map(async (canvasFont) => {
          const run = { ...styleRun, family: canvasFont, key: canvasFont };
          await Promise.all([
            shaper.load(run),
            shaper.load({ ...run, family: "Instrument Sans", variable: true }),
          ]);
          const measure = (prefix: string) => font.width(canvasFont, prefix, null, direction);
          const drawing = shaper.shapeForEngine(sample, run, measure);
          if ("waiting" in drawing) throw new Error("The substitute has not settled");
          const actual = drawing.shaped;
          const measured = measure(sample);
          const offset = direction === "rtl" ? measured - exact.width : 0;
          const geometryError = Math.max(
            ...exact.glyphs.map((glyph, i) =>
              Math.abs((actual.glyphs[i]?.x ?? Infinity) - glyph.x - offset),
            ),
          );
          const paint = (shaped: typeof exact, dx: number) => {
            const ctx = new OffscreenCanvas(430, 100).getContext("2d");
            if (!ctx) throw new Error("Missing draw context");
            for (const glyph of shaped.glyphs) {
              ctx.setTransform(shaped.scale, 0, 0, -shaped.scale, 40 + glyph.x + dx, 70 - glyph.y);
              ctx.fill(new Path2D(glyph.d));
            }
            return ctx.getImageData(0, 0, 430, 100).data;
          };
          const reference = paint(exact, offset);
          const pixels = paint(actual, 0);
          const pixelsDiffer = pixels.filter((value, i) => value !== reference[i]).length;
          return {
            measurementError: Math.abs(actual.width - measured),
            delta: Math.abs(exact.width - measured),
            geometryError,
            pixelsDiffer,
          };
        }),
      );
    }, cell);
    expect(result[0]?.delta).toBeGreaterThan(2);
    for (const comparison of result) {
      expect(comparison.measurementError).toBeLessThan(0.01);
      expect(comparison.geometryError).toBeLessThan(0.001);
      // Outlines are normalized from font units when faces are mixed. The
      // equivalent path can round to a different antialias value at a few edges.
      expect(comparison.pixelsDiffer).toBeLessThan(100);
    }
  });
}
