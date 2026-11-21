import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { build } from "vite";
import type { glassAtHighZoom } from "./fixtures/canvas-glass-zoom";

test("Canvas glass keeps its backdrop and rim at extreme zoom", async ({ page }) => {
  const bundle = await build({
    configFile: false,
    logLevel: "error",
    build: {
      write: false,
      lib: {
        entry: fileURLToPath(new URL("./fixtures/canvas-glass-zoom.ts", import.meta.url)),
        name: "CanvasGlassZoom",
        formats: ["iife"],
      },
    },
  });
  const entry = (Array.isArray(bundle) ? bundle : [bundle])
    .flatMap((result) => ("output" in result ? result.output : []))
    .find((file) => file.type === "chunk" && file.isEntry);
  if (entry?.type !== "chunk") throw new Error("no canvas fixture bundle");
  await page.setContent("<!doctype html>");
  await page.addScriptTag({ content: entry.code });
  const frames = await page.evaluate(() => {
    const w = window as unknown as { CanvasGlassZoom: { glassAtHighZoom: typeof glassAtHighZoom } };
    return w.CanvasGlassZoom.glassAtHighZoom();
  });
  for (const { zoom, outside, rim } of frames) {
    expect(outside).toEqual([36, 140, 80, 255]);
    // At a straight top edge facing the light, the constant backdrop is shaded and
    // receives a white hairline. The sample is 48.5 device pixels inside the lens.
    const d = 48.5 / (zoom * 2);
    const shade = 0.8 * 0.09 * Math.max(0, 1 - d / (0.55 * 18));
    const light = Math.min(1, 0.8 * 3.7 * (1 - 0.45) * Math.exp(-d / 0.35));
    const reference = outside.slice(0, 3).map((v) => (1 - light) * (1 - shade) * v + light * 255);
    expect(rim[3]).toBe(255);
    for (const [channel, expected] of reference.entries())
      expect(
        Math.abs((rim[channel] ?? 0) - expected),
        `rim at ${zoom * 100}%: ${rim.join(",")}, expected ${reference.map(Math.round).join(",")}`,
      ).toBeLessThan(12);
  }
});
