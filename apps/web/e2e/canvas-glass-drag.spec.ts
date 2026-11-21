import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { build } from "vite";
import type { compareGlassDrag } from "./fixtures/canvas-glass-drag";

test("Canvas glass drag erases the old footprint before drawing the next", async ({ page }) => {
  test.setTimeout(240_000);
  // Bundle the production CanvasRenderer with the fixture. The test drives one
  // budgeted frame per move without the editor's automatic settling between reads.
  const result = await build({
    configFile: false,
    logLevel: "error",
    build: {
      write: false,
      lib: {
        entry: fileURLToPath(new URL("./fixtures/canvas-glass-drag.ts", import.meta.url)),
        name: "CanvasGlassDrag",
        formats: ["iife"],
      },
    },
  });
  const files = (Array.isArray(result) ? result : [result]).flatMap((bundle) =>
    "output" in bundle ? bundle.output : [],
  );
  const script = files.find((file) => file.type === "chunk" && file.isEntry);
  if (script?.type !== "chunk") throw new Error("no Canvas fixture bundle");
  await page.setContent("<!doctype html>");
  await page.addScriptTag({ content: script.code });
  const outcome = await page.evaluate(() => {
    const harness = window as unknown as {
      CanvasGlassDrag: { compareGlassDrag: typeof compareGlassDrag };
    };
    return harness.CanvasGlassDrag.compareGlassDrag();
  });
  for (const [index, frame] of outcome.frames.entries()) {
    expect(frame.oldPixels, `old glass pixels after drag step ${index + 1}`).toBe(0);
    if (frame.visible)
      expect(frame.lensPixels, `current glass on drag step ${index + 1}`).toBeGreaterThan(100);
  }
  expect(outcome.pending).toBe(false);
  expect(
    outcome.settled.differentPixels,
    `settled pixels differing from a fresh draw (sample ${JSON.stringify(outcome.settled.sample)})`,
  ).toBe(0);
});
