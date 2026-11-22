/**
 * Workstream W2 acceptance suite (decision 0040):
 * - Engine mode (`renderer=engine`): every product picture runs on the Rust/WebAssembly engine,
 *   with lazy CanvasRenderer fallback for 8,193..16,384 px exports and unsupported effects
 *   (progressive layer blur with offsets), full-sharpness photo budgeting with UI reduction notes,
 *   deterministic WebP thumbnails under 64 KiB keepalive (plus PNG CPU-GPU tolerance check),
 *   and live EngineView prototype player with transitions, overlays, scrolling, and fallback.
 * - Default canvas mode (switch off): exports (including > 8,192 px, progressive blur, and
 *   mixed-direction bidi text), export preview, thumbnails, component/template previews, and
 *   prototype player stay on CanvasRenderer.
 */
import { readFileSync } from "node:fs";
import { CPU_GPU_TOLERANCE, outsideTolerance, score } from "@drawpane/engine/compare";
import { type Download, expect, type Page, test } from "@playwright/test";
import { freshInstance, type Instance } from "./fresh-instance";

if (!process.env.ENGINE_BROWSER || process.env.ENGINE_BROWSER === "chromium") {
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
}

type DebugEditor = {
  s: { pageId: string; selection: string[] };
  createLayer(
    type: string,
    rect: { x: number; y: number; width: number; height: number },
    parent: string,
    props?: Record<string, unknown>,
  ): string | null;
  select(ids: string[]): void;
  createComponent(): void;
  commit(ops: unknown[], label?: string): boolean;
  doc: {
    get(id: string): { props: Record<string, unknown> } | undefined;
  };
};

type DebugHeadless = {
  thumbnail(options?: {
    pageId?: string;
    maxWidth?: number;
    maxHeight?: number;
    format?: "webp" | "png";
    quality?: number;
    forceEngine?: boolean;
  }): Promise<{
    data: string;
    png: string;
    bytes: number;
    type: string;
    layout: {
      pageId: string;
      rect: { x: number; y: number; width: number; height: number };
      scale: number;
      width: number;
      height: number;
      background: string | null;
    };
  } | null>;
  exportLayer(
    ids: readonly string[],
    options: {
      readonly format: "png" | "jpeg" | "webp";
      readonly scale: 1 | 2 | 3;
      readonly background?: string | null;
      readonly imageBudget?: number;
    },
  ): Promise<{
    data: string;
    bytes: number;
    type: string;
    reducedImages: number;
    omittedImages: number;
  }>;
};

type DebugEngine = {
  render(options: {
    pageId: string;
    rect: { x: number; y: number; width: number; height: number };
    scale: number;
    width: number;
    height: number;
    backend: "cpu" | "gpu" | "webgl";
    background?: [number, number, number, number];
  }): Promise<{ ok: boolean; error?: string; rgba?: string }>;
};

type W = {
  drawpane: DebugEditor;
  drawpaneHeadless: DebugHeadless;
  drawpaneEngine: DebugEngine;
};

function pngSize(bytes: Buffer): { width: number; height: number } {
  expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

async function saved(page: Page, start: () => Promise<void>): Promise<Download> {
  const [download] = await Promise.all([page.waitForEvent("download"), start()]);
  return download;
}

/** Decodes an image blob (PNG/JPEG/WebP, base64) into straight RGBA bytes in the browser. */
function decodeRgba(
  page: Page,
  b64: string,
  mime: string,
): Promise<{ width: number; height: number; rgba: string }> {
  return page.evaluate(
    async ({ b64, mime }) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: mime }), {
        colorSpaceConversion: "none",
        premultiplyAlpha: "none",
      });
      const c = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = c.getContext("2d") as OffscreenCanvasRenderingContext2D;
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
      const data = ctx.getImageData(0, 0, c.width, c.height).data;
      let s = "";
      for (let i = 0; i < data.length; i += 0x8000)
        s += String.fromCharCode(...data.subarray(i, i + 0x8000));
      return { width: c.width, height: c.height, rgba: btoa(s) };
    },
    { b64, mime },
  );
}

function uploadPhoto(page: Page, width: number, height: number): Promise<string> {
  return page.evaluate(
    async ({ width, height }) => {
      const c = new OffscreenCanvas(width, height);
      const ctx = c.getContext("2d") as OffscreenCanvasRenderingContext2D;
      const grad = ctx.createLinearGradient(0, 0, width, height);
      grad.addColorStop(0, "#1d4ed8");
      grad.addColorStop(1, "#f97316");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, width, height);
      // High-contrast vertical stripes to verify sharp photo decode.
      ctx.fillStyle = "#ffffff";
      for (let x = 0; x < width; x += 24) ctx.fillRect(x, 0, 8, height);
      const blob = await c.convertToBlob({ type: "image/png" });
      const fileId = /\/f\/([^/]+)/.exec(location.pathname)?.[1] ?? "";
      const response = await fetch(`/api/files/${encodeURIComponent(fileId)}/media`, {
        method: "POST",
        body: blob,
      });
      return ((await response.json()) as { sha: string }).sha;
    },
    { width, height },
  );
}

function hexToRgbaFloats(hex: string | null): [number, number, number, number] {
  if (!hex) return [0, 0, 0, 0];
  const m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(hex.trim());
  if (!m) return [0.92, 0.92, 0.9, 1];
  const n = Number.parseInt(m[1] as string, 16);
  const a = m[2] ? Number.parseInt(m[2], 16) / 255 : 1;
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, a];
}

test.describe
  .serial("Engine product flows (W2)", () => {
    test.skip(!!process.env.E2E_BASE_URL, "Needs its own local instance.");

    let instance: Instance;
    let page: Page;

    test.beforeAll(async ({ browser }) => {
      test.setTimeout(180_000);
      const port = Number(process.env.E2E_W2_PORT || 19101);
      const inspectorPort = Number(process.env.E2E_W2_INSPECTOR_PORT || 19601);
      instance = await freshInstance(browser, { port, inspectorPort });
      page = instance.page;
      await page.evaluate(() => {
        localStorage.setItem("drawpane:debug", "1");
        localStorage.setItem("drawpane:renderer", "engine");
        localStorage.setItem("drawpane:engine-software", "allow");
        localStorage.setItem("drawpane:engine-present", "readback");
      });
      await page.getByRole("button", { name: "New file" }).first().click();
      await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
        timeout: 15_000,
      });
      await expect(
        page.locator(
          '[data-renderer="webgpu"], [data-renderer="webgl2"], [data-renderer="cpu-worker"]',
        ),
      ).toBeVisible({ timeout: 60_000 });
    });

    test.afterAll(async () => {
      await instance?.stop();
    });

    test("exports PNG, JPEG, WebP with 0039 backdrop, full-res photos, reduction notes, progressive blur fallback, and vector notes", async () => {
      const photoSha = await uploadPhoto(page, 2000, 1500);
      const ids = await page.evaluate((sha) => {
        const e = (window as unknown as W).drawpane;
        const p = e.s.pageId;
        // Bright orange backdrop on the page beneath the glass card (not its parent).
        e.createLayer("rect", { x: 0, y: 0, width: 220, height: 140 }, p, {
          name: "Backdrop",
          fills: [{ type: "solid", color: "#ff5a1f" }],
        });
        // Rounded frosted glass + background blur card sitting over the backdrop.
        const glass = e.createLayer("rect", { x: 30, y: 20, width: 160, height: 100 }, p, {
          name: "Glass card",
          cornerRadius: 28,
          fills: [{ type: "solid", color: "#ffffff26" }],
          effects: [
            { type: "background-blur", radius: 12 },
            {
              type: "glass",
              angle: -45,
              intensity: 80,
              refraction: 80,
              depth: 20,
              dispersion: 50,
              frost: 4,
              splay: 0,
            },
          ],
        }) as string;
        // Large photo layer (2000 x 1500 drawn at 1000 x 750 @ 2x = 2000 x 1500 -> 16 MiB, fits raised budget).
        const photo = e.createLayer("rect", { x: 0, y: 200, width: 1000, height: 750 }, p, {
          name: "Hero photo",
          fills: [{ type: "image", ref: sha, scaleMode: "fill" }],
        }) as string;
        // Progressive layer blur with offsets (engine refuses; product export falls back to canvas).
        const progBlur = e.createLayer("rect", { x: 0, y: 1000, width: 120, height: 80 }, p, {
          name: "Progressive blur",
          fills: [{ type: "solid", color: "#2b4fd6" }],
          effects: [
            {
              type: "layer-blur",
              blurType: "progressive",
              radius: 16,
              startRadius: 2,
              startOffset: { x: 0, y: 0 },
              endOffset: { x: 0, y: 1 },
            },
          ],
        }) as string;
        e.select([glass]);
        return { glass, photo, progBlur };
      }, photoSha);
      expect(ids.glass).toBeTruthy();

      // Export panel preview renders through the snapshot service.
      const previewImg = page.locator(".export-section__preview img");
      await previewImg.scrollIntoViewIfNeeded();
      await expect(previewImg).toBeVisible({ timeout: 15_000 });
      await expect
        .poll(() =>
          previewImg.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth),
        )
        .toBeGreaterThan(0);

      // PNG 1x: transparent rounded corners AND contextual orange backdrop sampled inside glass.
      const formats = page.getByRole("radiogroup", { name: "Export format" });
      const scales = page.getByRole("radiogroup", { name: "Export scale" });
      await formats.getByRole("radio", { name: "PNG" }).click();
      await scales.getByRole("radio", { name: "1×" }).click();
      const png1x = await saved(page, () =>
        page.getByRole("button", { name: /Export layer/ }).click(),
      );
      const png1xBytes = readFileSync((await png1x.path()) as string);
      expect(pngSize(png1xBytes)).toEqual({ width: 160, height: 100 });
      const png1xPixels = await decodeRgba(page, png1xBytes.toString("base64"), "image/png");
      const raw1x = Buffer.from(png1xPixels.rgba, "base64");
      expect(raw1x[3]).toBe(0);
      const centerIdx = (50 * 160 + 80) * 4;
      expect(raw1x[centerIdx] ?? 0).toBeGreaterThan(180);
      expect(raw1x[centerIdx + 3] ?? 0).toBeGreaterThan(240);

      // PNG 2x: exact doubled dimensions.
      await scales.getByRole("radio", { name: "2×" }).click();
      const png2x = await saved(page, () =>
        page.getByRole("button", { name: /Export layer/ }).click(),
      );
      expect(png2x.suggestedFilename()).toBe("Glass card@2x.png");
      expect(pngSize(readFileSync((await png2x.path()) as string))).toEqual({
        width: 320,
        height: 200,
      });

      // JPEG 1x: opaque white outside the rounded corners.
      await scales.getByRole("radio", { name: "1×" }).click();
      await formats.getByRole("radio", { name: "JPEG" }).click();
      const jpeg = await saved(page, () =>
        page.getByRole("button", { name: /Export layer/ }).click(),
      );
      const jpegBytes = readFileSync((await jpeg.path()) as string);
      expect([jpegBytes[0], jpegBytes[1]]).toEqual([0xff, 0xd8]);
      const jpegPixels = await decodeRgba(page, jpegBytes.toString("base64"), "image/jpeg");
      const rawJpeg = Buffer.from(jpegPixels.rgba, "base64");
      expect(rawJpeg[0]).toBeGreaterThan(245);
      expect(rawJpeg[1]).toBeGreaterThan(245);
      expect(rawJpeg[2]).toBeGreaterThan(245);
      expect(rawJpeg[3]).toBe(255);

      // WebP 1x: valid RIFF/WEBP file.
      await formats.getByRole("radio", { name: "WebP" }).click();
      const webp = await saved(page, () =>
        page.getByRole("button", { name: /Export layer/ }).click(),
      );
      const webpBytes = readFileSync((await webp.path()) as string);
      expect(webpBytes.subarray(0, 4).toString("ascii")).toBe("RIFF");
      expect(webpBytes.subarray(8, 12).toString("ascii")).toBe("WEBP");

      // SVG and PDF surface explicit glass and background-blur approximation notes.
      await formats.getByRole("radio", { name: "SVG" }).click();
      await expect(
        page.getByText("Background blur isn't part of SVG, so it's left out."),
      ).toBeVisible();
      await expect(
        page.getByText(
          "Glass exports in SVG as a lit rim without refraction, frost or what's behind the layer.",
        ),
      ).toBeVisible();
      await formats.getByRole("radio", { name: "PDF" }).click();
      await expect(
        page.getByText("Background blur isn't part of PDF, so it's left out."),
      ).toBeVisible();
      await expect(
        page.getByText(
          "Glass exports in PDF as a lit rim without refraction, frost or what's behind the layer.",
        ),
      ).toBeVisible();
      await formats.getByRole("radio", { name: "PNG" }).click();

      // Photo export at 2x fits raised browser image budget without reduction; when the engine
      // budget would reduce a photo, product export routes to the sharp canvas exporter instead.
      const photoFull = await page.evaluate(
        (id) =>
          (window as unknown as W).drawpaneHeadless.exportLayer([id], {
            format: "png",
            scale: 2,
          }),
        ids.photo,
      );
      expect(photoFull.reducedImages).toBe(0);
      expect(photoFull.omittedImages).toBe(0);
      expect(pngSize(Buffer.from(photoFull.data, "base64"))).toEqual({ width: 2000, height: 1500 });

      const photoConstrained = await page.evaluate(
        (id) =>
          (window as unknown as W).drawpaneHeadless.exportLayer([id], {
            format: "png",
            scale: 2,
            imageBudget: 2 << 20,
          }),
        ids.photo,
      );
      expect(photoConstrained.reducedImages).toBe(0);
      expect(photoConstrained.omittedImages).toBe(0);
      expect(pngSize(Buffer.from(photoConstrained.data, "base64"))).toEqual({
        width: 2000,
        height: 1500,
      });

      // Progressive layer blur with offsets exports cleanly via canvas fallback (never refuses).
      const blurExport = await page.evaluate(
        (id) =>
          (window as unknown as W).drawpaneHeadless.exportLayer([id], {
            format: "png",
            scale: 1,
          }),
        ids.progBlur,
      );
      expect(blurExport.bytes).toBeGreaterThan(100);
    });

    test("streams 8,192 px on engine, keeps 10,000 px working via fallback, and refuses 16,385 px", async () => {
      test.setTimeout(120_000);
      const { maxEngineFrame, tallFrame, overLimitFrame } = await page.evaluate(() => {
        const e = (window as unknown as W).drawpane;
        const p = e.s.pageId;
        const maxEngineFrame = e.createLayer(
          "frame",
          { x: 400, y: 0, width: 8192, height: 8192 },
          p,
          {
            name: "Max 8192",
            fills: [{ type: "solid", color: "#2b4fd6" }],
          },
        ) as string;
        e.createLayer("rect", { x: 400, y: 0, width: 8192, height: 256 }, maxEngineFrame, {
          fills: [{ type: "solid", color: "#ff5a1f" }],
        });
        // 10,000 x 64 px: above 8,192 px engine cap, within 16,384 px product cap.
        const tallFrame = e.createLayer("frame", { x: 9000, y: 0, width: 10_000, height: 64 }, p, {
          name: "Wide 10000",
          fills: [{ type: "solid", color: "#0f8a7e" }],
        }) as string;
        // 16,385 x 64 px: exceeds 16,384 px product cap -> refused clearly.
        const overLimitFrame = e.createLayer(
          "frame",
          { x: 20_000, y: 0, width: 16_385, height: 64 },
          p,
          {
            name: "Over 16385",
            fills: [{ type: "solid", color: "#e03131" }],
          },
        ) as string;
        e.select([maxEngineFrame]);
        return { maxEngineFrame, tallFrame, overLimitFrame };
      });
      expect(maxEngineFrame).toBeTruthy();

      // 8,192 x 8,192 streams to a valid PNG on the engine snapshot Worker.
      const dl8192 = await saved(page, () =>
        page.getByRole("button", { name: /Export layer/ }).click(),
      );
      expect(dl8192.suggestedFilename()).toBe("Max 8192.png");
      expect(pngSize(readFileSync((await dl8192.path()) as string))).toEqual({
        width: 8192,
        height: 8192,
      });

      // 10,000 x 64 keeps working (via canvas fallback in engine mode).
      await page.evaluate((id) => (window as unknown as W).drawpane.select([id]), tallFrame);
      const dl10000 = await saved(page, () =>
        page.getByRole("button", { name: /Export layer/ }).click(),
      );
      expect(pngSize(readFileSync((await dl10000.path()) as string))).toEqual({
        width: 10_000,
        height: 64,
      });

      // 16,385 px is refused with a clear message naming 16,384 px.
      await page.evaluate((id) => (window as unknown as W).drawpane.select([id]), overLimitFrame);
      await page.getByRole("button", { name: /Export layer/ }).click();
      await expect(page.getByRole("alert")).toContainText("16,384 px");
    });

    test("produces deterministic WebP thumbnails under 64 KiB keepalive and PNG within CPU-GPU tolerance", async () => {
      test.setTimeout(120_000);
      await page.goto("/");
      await page.getByRole("button", { name: "New file" }).first().click();
      await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
        timeout: 15_000,
      });
      await expect(
        page.locator(
          '[data-renderer="webgpu"], [data-renderer="webgl2"], [data-renderer="cpu-worker"]',
        ),
      ).toBeVisible({ timeout: 60_000 });

      await page.evaluate(() => {
        const e = (window as unknown as W).drawpane;
        const p = e.s.pageId;
        const card = e.createLayer("frame", { x: 40, y: 40, width: 360, height: 240 }, p, {
          name: "Hero",
          cornerRadius: 16,
          fills: [
            {
              type: "linear",
              from: { x: 0, y: 0 },
              to: { x: 1, y: 1 },
              stops: [
                { position: 0, color: "#2b4fd6" },
                { position: 1, color: "#0f8a7e" },
              ],
            },
          ],
          effects: [{ type: "drop-shadow", color: "#00000040", x: 0, y: 10, blur: 18, spread: 0 }],
        }) as string;
        const badge = e.createLayer("rect", { x: 64, y: 64, width: 110, height: 36 }, card, {
          cornerRadius: 8,
          fills: [{ type: "solid", color: "#ffffff" }],
          strokes: [{ type: "solid", color: "#1c1b1a" }],
          strokeWeight: 2,
        }) as string;
        e.createLayer("text", { x: 64, y: 120, width: 280, height: 48 }, card, {
          characters: "Drawpane Engine",
          fontSize: 28,
          fontWeight: 600,
          fills: [{ type: "solid", color: "#ffffff" }],
        });
        e.commit([{ op: "set", id: p, prop: "guides", value: [{ axis: "x", position: 120 }] }]);
        e.select([badge]);
      });

      const [webpA, webpB, pngThumb] = await page.evaluate(async () => {
        const h = (window as unknown as W).drawpaneHeadless;
        const a = await h.thumbnail();
        const b = await h.thumbnail();
        const png = await h.thumbnail({ format: "png" });
        return [a, b, png] as const;
      });
      if (!webpA || !webpB || !pngThumb) throw new Error("expected page thumbnails");
      // Default format is WebP, byte-identical across runs, and under 64 KiB keepalive.
      expect(webpA.type).toBe("image/webp");
      expect(webpA.data).toBe(webpB.data);
      expect(webpA.bytes).toBeLessThanOrEqual(64 * 1024);

      // Compare lossless engine thumbnail against the editor engine's GPU render of the same framing.
      const layout = pngThumb.layout;
      const thumbDecoded = await decodeRgba(page, pngThumb.data, "image/png");
      expect([thumbDecoded.width, thumbDecoded.height]).toEqual([layout.width, layout.height]);

      const gpuRender = await page.evaluate(
        async ({ pageId, rect, scale, width, height, background }) => {
          const engine = (window as unknown as W).drawpaneEngine;
          const opts = { pageId, rect, scale, width, height, background };
          let res = await engine.render({ ...opts, backend: "gpu" });
          if (!res.ok) res = await engine.render({ ...opts, backend: "gpu" });
          if (!res.ok) res = await engine.render({ ...opts, backend: "webgl" });
          return res;
        },
        {
          pageId: layout.pageId,
          rect: layout.rect,
          scale: layout.scale,
          width: layout.width,
          height: layout.height,
          background: hexToRgbaFloats(layout.background),
        },
      );
      expect(gpuRender.ok, gpuRender.error).toBe(true);
      const cpuRgba = new Uint8Array(Buffer.from(thumbDecoded.rgba, "base64"));
      const gpuRgba = new Uint8Array(Buffer.from(gpuRender.rgba as string, "base64"));
      const diff = score(cpuRgba, gpuRgba, layout.width, layout.height);
      expect(outsideTolerance(diff, CPU_GPU_TOLERANCE)).toEqual([]);
    });

    test("renders component/template previews and engine prototype player transitions, overlays, scrolling, and fallback", async () => {
      test.setTimeout(120_000);
      await page.goto("/");
      await page.getByRole("button", { name: "New file" }).first().click();
      await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
        timeout: 15_000,
      });
      await expect(
        page.locator(
          '[data-renderer="webgpu"], [data-renderer="webgl2"], [data-renderer="cpu-worker"]',
        ),
      ).toBeVisible({ timeout: 60_000 });

      // Build a 3-screen prototype + overlay + component on the page:
      // - Screen 1 (red, tall 390x1200 so it scrolls): top tap -> Screen 2 (push 600ms),
      //   bottom tap -> Overlay (sheet).
      // - Screen 2 (blue): tap -> Screen 3 (green with progressive blur -> triggers per-page fallback).
      // - Overlay (amber sheet).
      await page.evaluate(() => {
        const e = (window as unknown as W).drawpane;
        const p = e.s.pageId;
        e.commit([{ op: "set", id: p, prop: "prototypeDevice", value: "iphone-16" }]);

        const s1 = e.createLayer("frame", { x: 0, y: 0, width: 393, height: 1400 }, p, {
          name: "Red Home",
          fills: [{ type: "solid", color: "#e03131" }],
        }) as string;
        const s2 = e.createLayer("frame", { x: 500, y: 0, width: 393, height: 852 }, p, {
          name: "Blue Detail",
          fills: [{ type: "solid", color: "#1971c2" }],
        }) as string;
        const s3 = e.createLayer("frame", { x: 1000, y: 0, width: 393, height: 852 }, p, {
          name: "Green Fallback",
          fills: [{ type: "solid", color: "#2f9e44" }],
        }) as string;
        // Progressive layer blur with offsets causes EngineView.draw to return NOT_DRAWN -> canvas fallback.
        e.createLayer("rect", { x: 1040, y: 40, width: 140, height: 100 }, s3, {
          name: "Prog blur box",
          fills: [{ type: "solid", color: "#ffffff" }],
          effects: [
            {
              type: "layer-blur",
              blurType: "progressive",
              radius: 14,
              startRadius: 2,
              startOffset: { x: 0, y: 0 },
              endOffset: { x: 0, y: 1 },
            },
          ],
        });
        const sheet = e.createLayer("frame", { x: 1500, y: 0, width: 393, height: 260 }, p, {
          name: "Amber Sheet",
          fills: [{ type: "solid", color: "#f08c00" }],
        }) as string;

        const goDetail = e.createLayer("rect", { x: 40, y: 100, width: 313, height: 120 }, s1, {
          name: "Go Blue",
          fills: [{ type: "solid", color: "#c92a2a" }],
        }) as string;
        const openSheet = e.createLayer("rect", { x: 40, y: 1180, width: 313, height: 140 }, s1, {
          name: "Open Sheet",
          fills: [{ type: "solid", color: "#fff5f5" }],
        }) as string;
        const goFallback = e.createLayer("rect", { x: 540, y: 100, width: 313, height: 140 }, s2, {
          name: "Go Fallback",
          fills: [{ type: "solid", color: "#1864ab" }],
        }) as string;

        e.commit([
          {
            op: "set",
            id: goDetail,
            prop: "reactions",
            value: [
              {
                id: "r1",
                trigger: { type: "tap" },
                action: { type: "navigate", to: s2 },
                transition: {
                  type: "push",
                  direction: "left",
                  duration: 600,
                  easing: { type: "linear" },
                },
              },
            ],
          },
          {
            op: "set",
            id: openSheet,
            prop: "reactions",
            value: [
              {
                id: "r2",
                trigger: { type: "tap" },
                action: {
                  type: "overlay",
                  to: sheet,
                  position: "bottom",
                  dim: 0.4,
                  closeOnOutside: true,
                },
                transition: {
                  type: "instant",
                  direction: "up",
                  duration: 0,
                  easing: { type: "linear" },
                },
              },
            ],
          },
          {
            op: "set",
            id: goFallback,
            prop: "reactions",
            value: [
              {
                id: "r3",
                trigger: { type: "tap" },
                action: { type: "navigate", to: s3 },
                transition: {
                  type: "instant",
                  direction: "left",
                  duration: 0,
                  easing: { type: "linear" },
                },
              },
            ],
          },
          {
            op: "set",
            id: p,
            prop: "flows",
            value: [{ id: "flow1", name: "Main", start: s1, description: "" }],
          },
        ]);

        const comp = e.createLayer("frame", { x: 0, y: 1600, width: 160, height: 80 }, p, {
          name: "Primary button",
          fills: [{ type: "solid", color: "#e04f1a" }],
        }) as string;
        e.select([comp]);
        e.createComponent();
        // Clear selection so Play prototype opens the flow's start screen (Red Home).
        e.select([]);
      });

      // Assets component preview renders via engine snapshot service.
      await page.getByRole("radio", { name: "Assets" }).click();
      const assetImg = page.locator(".assets__preview img").first();
      await expect(assetImg).toBeVisible({ timeout: 15_000 });
      await expect
        .poll(() => assetImg.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth))
        .toBeGreaterThan(0);

      // Clear readback override so the prototype player runs direct-present GPU when available,
      // exercising EngineView.captureFrame()'s GPU readback path on animated transitions.
      await page.evaluate(() => localStorage.removeItem("drawpane:engine-present"));

      // Launch prototype player on live EngineView.
      const editorUrl = page.url();
      await page.getByRole("button", { name: "Play prototype" }).click();
      await expect(page).toHaveURL(/\/present/);
      const device = page.locator(".stage__device");
      await expect
        .poll(() => device.getAttribute("data-renderer"), { timeout: 45_000 })
        .toMatch(/^(webgpu|webgl2|cpu-worker)$/);

      // Screen thumbnails render through snapshot service.
      const screenThumb = page.locator(".present__thumb img").first();
      await expect(screenThumb).toBeVisible({ timeout: 15_000 });
      await expect
        .poll(() =>
          screenThumb.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth),
        )
        .toBeGreaterThan(0);

      // Wait for Screen 1's red pixels to land on the live engine canvas (works on GPU or CPU).
      await expect
        .poll(
          async () => {
            const shot = await page.locator(".stage__engine-slot").screenshot();
            const decoded = await decodeRgba(page, shot.toString("base64"), "image/png");
            const raw = Buffer.from(decoded.rgba, "base64");
            const i =
              (Math.floor(decoded.height / 4) * decoded.width + Math.floor(decoded.width / 2)) * 4;
            return (raw[i] ?? 0) - (raw[i + 2] ?? 0);
          },
          { timeout: 15_000 },
        )
        .toBeGreaterThan(100);

      // Scrolling: tall Screen 1 overflows vertically inside .stage__screen; scroll down & open overlay.
      const scrollCheck = await page.evaluate(() => {
        const s = document.querySelector(".stage__screen") as HTMLElement | null;
        if (!s) return { overflow: false, scrollTop: 0 };
        const overflow = s.scrollHeight > s.clientHeight + 50;
        s.scrollTop = s.scrollHeight;
        return { overflow, scrollTop: s.scrollTop };
      });
      expect(scrollCheck.overflow).toBe(true);
      expect(scrollCheck.scrollTop).toBeGreaterThan(50);

      const viewport = page.locator(".stage__viewport");
      const box = (await viewport.boundingBox()) as {
        x: number;
        y: number;
        width: number;
        height: number;
      };
      // Tap the bottom hotspot (now scrolled into view) to open the Amber Sheet overlay.
      await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.85);
      await expect(viewport.locator(".stage__overlay")).toHaveCount(1);
      await expect(viewport.locator(".stage__dim")).toHaveCount(1);
      // Overlay canvas receives non-empty amber pixels from the snapshot service.
      await expect
        .poll(async () =>
          page.evaluate(() => {
            const c = document.querySelector(".stage__overlay canvas") as HTMLCanvasElement | null;
            if (!c || c.width === 0 || c.height === 0) return 0;
            const ctx = c.getContext("2d");
            if (!ctx) return 0;
            const px = ctx.getImageData(
              Math.floor(c.width / 2),
              Math.floor(c.height / 2),
              1,
              1,
            ).data;
            return (px[0] ?? 0) - (px[2] ?? 0);
          }),
        )
        .toBeGreaterThan(120);
      // Tap outside the bottom sheet to dismiss it.
      await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.15);
      await expect(viewport.locator(".stage__overlay")).toHaveCount(0, { timeout: 5000 });

      // Scroll back to top and trigger the 600ms animated push transition to Screen 2 (blue).
      await page.evaluate(() => {
        const s = document.querySelector(".stage__screen") as HTMLElement | null;
        if (s) s.scrollTop = 0;
      });
      await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.18);
      // Mid-transition, the outgoing canvas holds Screen 1's real red pixels (not blank white!).
      const outgoing = page.locator("canvas.stage__outgoing");
      await expect(outgoing).toBeVisible({ timeout: 2000 });
      const outgoingRgb = await outgoing.evaluate((c: HTMLCanvasElement) => {
        const ctx = c.getContext("2d");
        if (!ctx) return [0, 0, 0];
        const px = ctx.getImageData(Math.floor(c.width / 2), Math.floor(c.height / 4), 1, 1).data;
        return [px[0] ?? 0, px[1] ?? 0, px[2] ?? 0];
      });
      expect(outgoingRgb[0]).toBeGreaterThan(180);
      expect(outgoingRgb[2]).toBeLessThan(100);
      await expect(page.locator(".present__count")).toHaveText(/^Screen 2 of /);
      await expect(outgoing).toHaveCount(0, { timeout: 5000 });

      // Navigate from Screen 2 (blue) to Screen 3 (green + progressive layer blur):
      // Engine returns NOT_DRAWN -> stage falls back per page to canvas-fallback and draws green
      // (never keeping Screen 2's stale blue pixels).
      await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.18);
      await expect(page.getByRole("button", { name: /^Green Fallback/ })).toHaveAttribute(
        "aria-current",
        "true",
      );
      await expect
        .poll(() => device.getAttribute("data-renderer"), { timeout: 10_000 })
        .toBe("canvas-fallback");
      const fallbackRgb = await page.evaluate(() => {
        const canvases = [
          ...document.querySelectorAll(".stage__engine-slot > canvas"),
        ] as HTMLCanvasElement[];
        const visible = canvases.find((c) => getComputedStyle(c).display !== "none");
        if (!visible || visible.width === 0 || visible.height === 0) return [0, 0, 0];
        const ctx = visible.getContext("2d");
        if (!ctx) return [0, 0, 0];
        const px = ctx.getImageData(
          Math.floor(visible.width * 0.75),
          Math.floor(visible.height * 0.5),
          1,
          1,
        ).data;
        return [px[0] ?? 0, px[1] ?? 0, px[2] ?? 0];
      });
      // Green (#2f9e44): green channel clearly dominates blue/red (not stale blue Screen 2!).
      expect(fallbackRgb[1]).toBeGreaterThan(120);
      expect(fallbackRgb[1]).toBeGreaterThan((fallbackRgb[2] ?? 0) + 40);

      // Returning to a supported screen switches back from canvas-fallback to the live engine.
      await page.getByRole("button", { name: /^Red Home/ }).click();
      await expect
        .poll(() => device.getAttribute("data-renderer"), { timeout: 10_000 })
        .toMatch(/^(webgpu|webgl2|cpu-worker)$/);

      // Continuous remote edits from another tab on an unrelated layer must not starve overlay reveal.
      const remotePage = await page.context().newPage();
      try {
        await remotePage.goto(editorUrl);
        await expect(remotePage.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
          timeout: 15_000,
        });
        await remotePage.evaluate(() => {
          const e = (window as unknown as W).drawpane;
          const p = e.s.pageId;
          const remote = e.createLayer("rect", { x: 4000, y: 0, width: 40, height: 40 }, p, {
            name: "Remote mover",
            fills: [{ type: "solid", color: "#22b8cf" }],
          }) as string;
          let step = 0;
          const id = window.setInterval(() => {
            step++;
            e.commit([{ op: "set", id: remote, prop: "x", value: 4000 + step }]);
          }, 50);
          (window as unknown as { __stopRemoteEdits?: () => void }).__stopRemoteEdits = () =>
            window.clearInterval(id);
        });
        await page.bringToFront();
        await page.evaluate(() => {
          const s = document.querySelector(".stage__screen") as HTMLElement | null;
          if (s) s.scrollTop = s.scrollHeight;
        });
        await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.85);
        const liveOverlay = viewport.locator(".stage__overlay");
        await expect(liveOverlay).toHaveCount(1);
        await expect(liveOverlay).toHaveAttribute("data-painted", "true", { timeout: 5000 });
        await expect(liveOverlay).toBeVisible({ timeout: 2000 });
        await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.15);
        await expect(liveOverlay).toHaveCount(0, { timeout: 5000 });
      } finally {
        await remotePage
          .evaluate(() =>
            (window as unknown as { __stopRemoteEdits?: () => void }).__stopRemoteEdits?.(),
          )
          .catch(() => {});
        await remotePage.close();
      }

      // New-file template previews render via the engine snapshot service.
      await page.goto("/");
      await page.getByRole("button", { name: "Templates" }).click();
      const templateCard = page.getByRole("button", { name: /^Mobile app/ });
      const templateImg = templateCard.locator("img");
      await expect(templateImg).toBeVisible({ timeout: 20_000 });
      await expect
        .poll(() =>
          templateImg.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth),
        )
        .toBeGreaterThan(0);
    });

    test("default canvas mode keeps exports (including bidi text & 10,000 px), previews, thumbnails, and player on CanvasRenderer", async () => {
      test.setTimeout(120_000);
      // Clear renderer switch to test the default canvas experience every user gets today.
      await page.evaluate(() => {
        localStorage.removeItem("drawpane:renderer");
        sessionStorage.removeItem("drawpane:renderer");
        localStorage.setItem("drawpane:debug", "1");
      });
      await page.goto("/");
      await page.getByRole("button", { name: "New file" }).first().click();
      await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
        timeout: 15_000,
      });
      // Default canvas editor does not mount EngineView.
      await expect(
        page.locator(
          '[data-renderer="webgpu"], [data-renderer="webgl2"], [data-renderer="cpu-worker"]',
        ),
      ).toHaveCount(0);

      const { bidiFrame, wideFrame } = await page.evaluate(() => {
        const e = (window as unknown as W).drawpane;
        const p = e.s.pageId;
        const bidiFrame = e.createLayer("frame", { x: 20, y: 20, width: 320, height: 100 }, p, {
          name: "Bidi card",
          fills: [{ type: "solid", color: "#ffffff" }],
        }) as string;
        e.createLayer("text", { x: 36, y: 36, width: 288, height: 60 }, bidiFrame, {
          characters: "مرحبا 123 Hello שלום 456",
          fontSize: 22,
          fills: [{ type: "solid", color: "#111111" }],
        });
        const wideFrame = e.createLayer("frame", { x: 20, y: 200, width: 10_000, height: 64 }, p, {
          name: "Wide canvas",
          fills: [{ type: "solid", color: "#0f8a7e" }],
        }) as string;
        const comp = e.createLayer("frame", { x: 20, y: 320, width: 120, height: 60 }, p, {
          name: "Canvas comp",
          fills: [{ type: "solid", color: "#2b4fd6" }],
        }) as string;
        e.select([comp]);
        e.createComponent();
        e.select([bidiFrame]);
        return { bidiFrame, wideFrame };
      });

      // Export preview works in default canvas mode (scroll Export section into view first so its
      // IntersectionObserver activates useExportPreview).
      await page.locator(".inspector-export").scrollIntoViewIfNeeded();
      const previewImg = page.locator(".export-section__preview img");
      await expect(previewImg).toBeVisible({ timeout: 15_000 });

      // Mixed-direction bidi text exports cleanly in canvas mode with real inked pixels.
      const bidiExport = await page.evaluate(
        (id) =>
          (window as unknown as W).drawpaneHeadless.exportLayer([id], {
            format: "png",
            scale: 2,
          }),
        bidiFrame,
      );
      expect(pngSize(Buffer.from(bidiExport.data, "base64"))).toEqual({ width: 640, height: 200 });
      const bidiDecoded = await decodeRgba(page, bidiExport.data, "image/png");
      const bidiRaw = Buffer.from(bidiDecoded.rgba, "base64");
      let darkPixels = 0;
      for (let i = 0; i < bidiRaw.length; i += 4) {
        if ((bidiRaw[i] ?? 255) < 120 && (bidiRaw[i + 3] ?? 0) > 200) darkPixels++;
      }
      expect(darkPixels).toBeGreaterThan(200);

      // 10,000 px export succeeds in default canvas mode.
      const wideExport = await page.evaluate(
        (id) =>
          (window as unknown as W).drawpaneHeadless.exportLayer([id], {
            format: "png",
            scale: 1,
          }),
        wideFrame,
      );
      expect(pngSize(Buffer.from(wideExport.data, "base64"))).toEqual({
        width: 10_000,
        height: 64,
      });

      // Dashboard thumbnail in canvas mode uses WebP under 64 KiB.
      const thumb = await page.evaluate(() =>
        (window as unknown as W).drawpaneHeadless.thumbnail(),
      );
      expect(thumb?.type).toBe("image/webp");
      expect(thumb?.bytes ?? 0).toBeLessThanOrEqual(64 * 1024);

      // Component preview stays on CanvasRenderer (<canvas class="assets__preview">).
      await page.getByRole("radio", { name: "Assets" }).click();
      await expect(page.locator("canvas.assets__preview").first()).toBeVisible({ timeout: 10_000 });

      // Prototype player stays on CanvasRenderer (`data-renderer="canvas"`).
      await page.getByRole("button", { name: "Play prototype" }).click();
      await expect(page).toHaveURL(/\/present/);
      await expect(page.locator(".stage__device")).toHaveAttribute("data-renderer", "canvas");
      await expect(page.locator(".present__thumb canvas").first()).toBeVisible({ timeout: 10_000 });

      // Template previews also render in default canvas mode.
      await page.goto("/");
      await page.getByRole("button", { name: "Templates" }).click();
      const templateImg = page.getByRole("button", { name: /^Mobile app/ }).locator("img");
      await expect(templateImg).toBeVisible({ timeout: 15_000 });
      await expect
        .poll(() =>
          templateImg.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth),
        )
        .toBeGreaterThan(0);
    });

    test("falls back to canvas across all snapshot flows when the snapshot Worker fails to load", async () => {
      test.setTimeout(120_000);
      await page.route(/engine-snapshot\.worker/, (route) => route.abort("failed"));
      try {
        await page.evaluate(() => {
          localStorage.setItem("drawpane:renderer", "engine");
          localStorage.setItem("drawpane:engine-software", "allow");
          localStorage.setItem("drawpane:debug", "1");
        });
        await page.goto("/");
        await page.getByRole("button", { name: "New file" }).first().click();
        await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
          timeout: 15_000,
        });
        await expect(
          page.locator(
            '[data-renderer="webgpu"], [data-renderer="webgl2"], [data-renderer="cpu-worker"]',
          ),
        ).toBeVisible({ timeout: 60_000 });

        const { cardId } = await page.evaluate(() => {
          const e = (window as unknown as W).drawpane;
          const p = e.s.pageId;
          e.commit([{ op: "set", id: p, prop: "prototypeDevice", value: "iphone-16" }]);
          const cardId = e.createLayer("frame", { x: 0, y: 0, width: 393, height: 852 }, p, {
            name: "Home",
            fills: [{ type: "solid", color: "#e03131" }],
          }) as string;
          const sheetId = e.createLayer("frame", { x: 500, y: 0, width: 393, height: 260 }, p, {
            name: "Sheet",
            fills: [{ type: "solid", color: "#f59f00" }],
          }) as string;
          const openBtn = e.createLayer(
            "rect",
            { x: 40, y: 660, width: 313, height: 140 },
            cardId,
            {
              name: "Open sheet",
              fills: [{ type: "solid", color: "#ffffff" }],
            },
          ) as string;
          e.commit([
            {
              op: "set",
              id: openBtn,
              prop: "reactions",
              value: [
                {
                  id: "r-ov",
                  trigger: { type: "tap" },
                  action: {
                    type: "overlay",
                    to: sheetId,
                    position: "bottom",
                    closeOnOutside: true,
                    dim: 0.4,
                  },
                  transition: {
                    type: "instant",
                    direction: "up",
                    duration: 0,
                    easing: { type: "linear" },
                  },
                },
              ],
            },
            {
              op: "set",
              id: p,
              prop: "flows",
              value: [{ id: "flow1", name: "Main", start: cardId, description: "" }],
            },
          ]);
          const comp = e.createLayer("frame", { x: 0, y: 920, width: 120, height: 60 }, p, {
            name: "Fallback comp",
            fills: [{ type: "solid", color: "#1971c2" }],
          }) as string;
          e.select([comp]);
          e.createComponent();
          e.select([cardId]);
          return { cardId };
        });

        // 1. Export preview falls back to canvas.
        await page.locator(".inspector-export").evaluate((el) => el.scrollIntoView());
        const previewImg = page.locator(".export-section__preview img");
        await expect(previewImg).toBeVisible({ timeout: 15_000 });
        await expect
          .poll(() =>
            previewImg.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth),
          )
          .toBeGreaterThan(0);

        // 2. Raster export succeeds via canvas fallback with expected dimensions and red pixels.
        const exported = await page.evaluate(
          (id) =>
            (window as unknown as W).drawpaneHeadless.exportLayer([id], {
              format: "png",
              scale: 1,
            }),
          cardId,
        );
        expect(pngSize(Buffer.from(exported.data, "base64"))).toEqual({ width: 393, height: 852 });
        const decoded = await decodeRgba(page, exported.data, "image/png");
        const raw = Buffer.from(decoded.rgba, "base64");
        const mid = (100 * decoded.width + 160) * 4;
        expect(raw[mid] ?? 0).toBeGreaterThan(180);
        expect(raw[mid + 2] ?? 255).toBeLessThan(100);

        // 3. Dashboard thumbnail succeeds via canvas fallback under 64 KiB.
        const thumb = await page.evaluate(() =>
          (window as unknown as W).drawpaneHeadless.thumbnail(),
        );
        expect(thumb?.type).toBe("image/webp");
        expect(thumb?.bytes ?? 0).toBeGreaterThan(100);
        expect(thumb?.bytes ?? 0).toBeLessThanOrEqual(64 * 1024);

        // 4. Assets component preview falls back to canvas.
        await page.getByRole("radio", { name: "Assets" }).click();
        const assetImg = page.locator(".assets__preview img").first();
        await expect(assetImg).toBeVisible({ timeout: 15_000 });
        await expect
          .poll(() =>
            assetImg.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth),
          )
          .toBeGreaterThan(0);

        // 5. Prototype screen thumbnails and overlays fall back to canvas.
        await page.evaluate(() => (window as unknown as W).drawpane.select([]));
        await page.getByRole("button", { name: "Play prototype" }).click();
        await expect(page).toHaveURL(/\/present/);
        const device = page.locator(".stage__device");
        await expect
          .poll(() => device.getAttribute("data-renderer"), { timeout: 45_000 })
          .not.toBe("starting");
        const screenThumb = page.locator(".present__thumb img").first();
        await expect(screenThumb).toBeVisible({ timeout: 15_000 });
        await expect
          .poll(() =>
            screenThumb.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth),
          )
          .toBeGreaterThan(0);

        const viewport = page.locator(".stage__viewport");
        const box = (await viewport.boundingBox()) as {
          x: number;
          y: number;
          width: number;
          height: number;
        };
        await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.85);
        const overlay = viewport.locator(".stage__overlay");
        await expect(overlay).toHaveCount(1);
        await expect(overlay).toHaveAttribute("data-painted", "true", { timeout: 15_000 });
        await expect
          .poll(() =>
            page.evaluate(() => {
              const c = document.querySelector(
                ".stage__overlay canvas",
              ) as HTMLCanvasElement | null;
              if (!c || c.width === 0 || c.height === 0) return 0;
              const ctx = c.getContext("2d");
              if (!ctx) return 0;
              const px = ctx.getImageData(
                Math.floor(c.width / 2),
                Math.floor(c.height / 2),
                1,
                1,
              ).data;
              return (px[0] ?? 0) - (px[2] ?? 0);
            }),
          )
          .toBeGreaterThan(120);
        await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.15);
        await expect(overlay).toHaveCount(0, { timeout: 5000 });
      } finally {
        await page.unroute(/engine-snapshot\.worker/);
      }
    });
  });
