import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { build } from "vite";
import type { drawExtremeZoom as drawFixture } from "./fixtures/engine-glass-zoom";

test.use({
  launchOptions: {
    args: [
      "--enable-unsafe-webgpu",
      "--enable-unsafe-swiftshader",
      ...(process.env.ENGINE_CHROME_ARGS ?? "").split(/\s+/).filter(Boolean),
    ],
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  },
});

const origin = `http://localhost:${process.env.ENGINE_GLASS_ORIGIN_PORT ?? "18479"}`;

for (const backend of ["webgpu", "webgl2"] as const) {
  test(`engine glass stays on ${backend} at extreme zoom`, async ({ page, browserName }) => {
    test.skip(browserName !== "chromium", "Runs both SwiftShader backends in Chromium.");
    test.setTimeout(240_000);
    const bundle = await build({
      configFile: false,
      logLevel: "error",
      build: {
        write: false,
        lib: {
          entry: fileURLToPath(new URL("./fixtures/engine-glass-zoom.ts", import.meta.url)),
          fileName: "fixture",
          formats: ["es"],
        },
      },
    });
    const files = (Array.isArray(bundle) ? bundle : [bundle]).flatMap((result) =>
      "output" in result ? result.output : [],
    );
    const entry = files.find((file) => file.type === "chunk" && file.isEntry);
    if (!entry) throw new Error("no engine fixture bundle");

    await page.route(`${origin}/**`, async (route) => {
      const filename = new URL(route.request().url()).pathname.slice(1);
      const file = files.find((output) => output.fileName === filename);
      const body =
        file?.type === "chunk"
          ? file.code
          : file?.source instanceof Uint8Array
            ? Buffer.from(file.source)
            : (file?.source ?? "<!doctype html>");
      await route.fulfill({
        body,
        contentType: filename.endsWith(".wasm")
          ? "application/wasm"
          : file
            ? "text/javascript"
            : "text/html",
      });
    });
    await page.goto(`${origin}/?present=readback`);
    const outcome = await page.evaluate(
      async ({ filename, backend }) => {
        const { drawExtremeZoom } = (await import(filename)) as {
          drawExtremeZoom: typeof drawFixture;
        };
        return drawExtremeZoom(backend === "webgpu" ? "engine" : "engine-webgl");
      },
      { filename: `/${entry.fileName}`, backend },
    );
    expect(outcome.fallbacks).toEqual([]);
    expect(outcome.backend).toBe(backend);
    expect(outcome.rim.some((frame) => frame.limit && !frame.exact)).toBe(true);
    const green = [36, 140, 80, 255];
    for (const frame of [outcome.interior, ...outcome.fuzz]) {
      for (const [channel, expected] of green.entries())
        expect(
          Math.abs((frame.pixel[channel] ?? 0) - expected),
          `interior at ${frame.zoom * 100}%`,
        ).toBeLessThanOrEqual(12);
    }
    for (const frame of outcome.rim) {
      const d = 0.65;
      const shade = 0.8 * 0.09 * (1 - d / (0.55 * 18));
      const light = 0.8 * 3.7 * (1 - 0.45) * Math.exp(-d / 0.35);
      const reference = green.slice(0, 3).map((v) => (1 - light) * (1 - shade) * v + light * 255);
      expect(frame.pixel[3]).toBe(255);
      for (const [channel, expected] of reference.entries())
        expect(
          Math.abs((frame.pixel[channel] ?? 0) - expected),
          `rim at ${frame.zoom * 100}%: ${frame.pixel}`,
        ).toBeLessThanOrEqual(18);
    }
  });
}
