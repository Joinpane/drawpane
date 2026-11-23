import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { build } from "vite";
import type { runGlassAtlasSuite as runFixture } from "./fixtures/engine-glass-atlas";

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

const origin = `http://localhost:${process.env.ENGINE_GLASS_ATLAS_ORIGIN_PORT ?? "18487"}`;

for (const backend of ["webgpu", "webgl2"] as const) {
  test(`deterministic glass mask atlas, fallbacks, and tiled parity on ${backend}`, async ({
    page,
    browserName,
  }) => {
    test.skip(browserName !== "chromium", "Runs both SwiftShader backends in Chromium.");
    test.setTimeout(240_000);
    const bundle = await build({
      configFile: false,
      logLevel: "error",
      build: {
        write: false,
        lib: {
          entry: fileURLToPath(new URL("./fixtures/engine-glass-atlas.ts", import.meta.url)),
          fileName: "fixture",
          formats: ["es"],
        },
      },
    });
    const files = (Array.isArray(bundle) ? bundle : [bundle]).flatMap((result) =>
      "output" in result ? result.output : [],
    );
    const entry = files.find((file) => file.type === "chunk" && file.isEntry);
    if (!entry) throw new Error("no glass atlas fixture bundle");

    const gpuMessages: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error" || message.text().startsWith("Drawpane:"))
        gpuMessages.push(message.text());
    });
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
    await page.goto(`${origin}/`);
    const result = await page
      .evaluate(
        async ({ filename, backend }) => {
          const { runGlassAtlasSuite } = (await import(filename)) as {
            runGlassAtlasSuite: typeof runFixture;
          };
          return runGlassAtlasSuite(backend);
        },
        { filename: `/${entry.fileName}`, backend },
      )
      .catch((error) => {
        throw new Error(
          [error instanceof Error ? error.message : String(error), ...gpuMessages]
            .filter(Boolean)
            .join("\n"),
          { cause: error },
        );
      });

    expect(result.backend).toBe(backend);
    expect(result.blendSlab.maxDiff).toBeLessThanOrEqual(2);
    // Allow setup submissions while catching a return to one submit per blend.
    expect(result.blendSlab.submits).toBeLessThan(32);

    // 1. Atlas active vs whole-frame budget refusal: bit-identical pixels, fewer Vello renders
    // and never more submissions (both paths share batched command encoders).
    expect(result.budgetAtlasVsSerial.batchedOps).toBe(7);
    expect(result.budgetAtlasVsSerial.batchedCount).toBe(7);
    expect(result.budgetAtlasVsSerial.refusedOps).toBe(7);
    expect(result.budgetAtlasVsSerial.refusedCount).toBe(0);
    expect(result.budgetAtlasVsSerial.batchedSubmits).toBeLessThanOrEqual(
      result.budgetAtlasVsSerial.refusedSubmits,
    );
    expect(result.budgetAtlasVsSerial.batchedVelloRenders).toBeLessThan(
      result.budgetAtlasVsSerial.refusedVelloRenders,
    );
    expect(result.budgetAtlasVsSerial.diff.differingBytes).toBe(0);

    // 2. Oversize lens (> 1024 px, split into serial chunks) falls back while 3 siblings batch.
    expect(result.oversizeFallback.glassOps).toBeGreaterThanOrEqual(4);
    expect(result.oversizeFallback.glassBatched).toBe(3);
    expect(result.oversizeFallback.nonZeroPixels).toBeGreaterThan(0);

    // 3. Patched vs fresh after an edit that reorders store.readers(): bit-identical.
    expect(result.patchedVsFresh.patchedBatched).toBe(6);
    expect(result.patchedVsFresh.freshBatched).toBe(6);
    expect(result.patchedVsFresh.diff.differingBytes).toBe(0);

    // 4. Whole frame (batched atlas) vs tiled (per-tile batched atlas) on a glass page straddling x=512.
    // Whole-atlas matches whole-serial bit-for-bit (case 1); remaining 1-2 level edge diffs on
    // <0.02% of bytes come from tile-origin coordinate/quad shifts on curved shapes.
    expect(result.wholeVsTiled.wholePlan).toBe("direct");
    expect(result.wholeVsTiled.wholeBatched).toBe(6);
    expect(result.wholeVsTiled.tiledPlan).toBe("tiles");
    expect(result.wholeVsTiled.tiledBatched).toBeGreaterThanOrEqual(6);
    expect(result.wholeVsTiled.tiledDrawn).toBeGreaterThanOrEqual(2);
    expect(
      result.wholeVsTiled.diff.maxDiff,
      JSON.stringify(result.wholeVsTiled.diff),
    ).toBeLessThanOrEqual(2);
    expect(
      result.wholeVsTiled.diff.differingBytes / result.wholeVsTiled.diff.totalBytes,
      JSON.stringify(result.wholeVsTiled.diff),
    ).toBeLessThan(0.001);
  });
}
