import type { Editor } from "@drawpane/editor";
import { type Browser, devices, expect, type Page, test } from "@playwright/test";
import type { EngineView } from "../../src/editor/engine-view";
import type { FrameStats } from "../../src/editor/frame-stats";
import { freshInstance, type Instance } from "../fresh-instance";

const MiB = 1024 * 1024;
type DebugWindow = Window & {
  drawpane: Editor;
  drawpaneEngineView?: EngineView;
  drawpaneFrames: FrameStats;
  textureSizes: [number, number][];
  backendChanges: string[];
};

test.use({
  launchOptions: {
    args: ["--enable-unsafe-swiftshader"],
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  },
});

const pixel = devices["Pixel 8"];
const ipad = {
  ...devices["iPad Pro 11"],
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15",
  deviceScaleFactor: 2,
};

async function mobilePage(
  browser: Browser,
  instance: Instance,
  device: typeof pixel,
  memory: number | null,
  renderer: "canvas" | "engine-webgl",
) {
  const context = await browser.newContext({
    ...device,
    baseURL: instance.url,
    storageState: await instance.context.storageState(),
  });
  await context.addInitScript(
    ({ memory, renderer, ipad }) => {
      Object.defineProperty(navigator, "deviceMemory", { get: () => memory ?? undefined });
      if (ipad) Object.defineProperty(navigator, "maxTouchPoints", { get: () => 5 });
      localStorage.setItem("drawpane:debug", "1");
      if (renderer !== "canvas") localStorage.setItem("drawpane:renderer", renderer);
      localStorage.setItem("drawpane:engine-software", "allow");

      const w = window as unknown as DebugWindow;
      w.backendChanges = [];
      window.addEventListener("drawpane:renderer-fallback", (event) => {
        const { from, to } = (event as CustomEvent).detail;
        w.backendChanges.push(`${from} to ${to}`);
      });

      if (renderer !== "engine-webgl") return;
      w.textureSizes = [];
      const proto = WebGL2RenderingContext.prototype;
      const texStorage2D = proto.texStorage2D;
      proto.texStorage2D = function (...args: Parameters<typeof texStorage2D>) {
        if (args[2] === this.RGBA8) w.textureSizes.push([args[3], args[4]]);
        texStorage2D.apply(this, args);
      };
    },
    { memory, renderer, ipad: device.userAgent.includes("Macintosh") },
  );
  return context;
}

async function createFile(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "New file" }).first().click();
  await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
    timeout: 15_000,
  });
}

const backing = (canvas: HTMLCanvasElement) => ({
  width: canvas.width,
  height: canvas.height,
  cssWidth: canvas.getBoundingClientRect().width,
  cssHeight: canvas.getBoundingClientRect().height,
});

test.describe("Mobile renderer budgets", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "Uses Chromium device emulation.");
  test.skip(!!process.env.E2E_BASE_URL, "Needs a local throwaway instance.");
  let instance: Instance;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000);
    const port = Number(process.env.ENGINE_E2E_PORT ?? 8993);
    instance = await freshInstance(browser, { port, inspectorPort: port + 540 });
  });

  test.afterAll(async () => {
    await instance?.stop();
  });

  test("a low-memory DPR 3 phone gets a small real atlas and steps down after WebGL loss", async ({
    browser,
  }) => {
    const context = await mobilePage(
      browser,
      instance,
      { ...pixel, deviceScaleFactor: 3 },
      2,
      "engine-webgl",
    );
    try {
      const page = await context.newPage();
      await createFile(page);
      const marker = await page.evaluate(() => {
        const editor = (window as unknown as DebugWindow).drawpane;
        const pageId = editor.s.pageId;
        if (!pageId) throw new Error("Missing editor page");
        const id = editor.createLayer("rect", { x: 80, y: 140, width: 180, height: 130 }, pageId, {
          name: "Keep this layer",
          fills: [{ type: "solid", color: "#ff00ff" }],
        });
        editor.state.set({
          camera: editor.s.camera.zoomAt({ x: 0, y: 0 }, 1).pan(13, 21),
        });
        return id;
      });
      const host = page.locator(".canvas");
      await expect(host).toHaveAttribute("data-renderer", "webgl2", { timeout: 20_000 });

      const viewState = () =>
        page.evaluate(() => {
          const w = window as unknown as DebugWindow;
          const view = w.drawpaneEngineView;
          const rawImages = view?.engine?.viewImageLimits();
          return {
            limits: view?.memoryProfile?.gpuLimits,
            rawImageLimit: rawImages?.ok ? rawImages.value.bytes : null,
            imageBudget: view?.imageMemoryEstimate.budget,
            atlasPages: w.textureSizes.filter(([x, y]) => x === 2048 && y === 2048).length,
            desktopPages: w.textureSizes.filter(([x, y]) => x === 4096 && y === 4096).length,
            tiles: view?.last.tiles.held,
          };
        });
      // One 2048-square RGBA8 texture is the glyph atlas. A second is the first tile page.
      await expect.poll(viewState, { timeout: 20_000 }).toMatchObject({
        limits: { gpuBytes: 128 * MiB, tileBytes: 16 * MiB, glyphMaskBytes: 8 * MiB },
        rawImageLimit: 64 * MiB,
        imageBudget: 48 * MiB,
        atlasPages: 2,
        desktopPages: 0,
      });
      expect((await viewState()).tiles).toBeGreaterThan(0);
      const engine = page.locator("canvas[data-canvas-role=engine]");
      const surface = await engine.evaluate(backing);
      expect(surface.width).toBe(Math.round(surface.cssWidth * 2));
      expect(surface.height).toBe(Math.round(surface.cssHeight * 2));

      const readDocument = () =>
        page.evaluate((id) => {
          if (!id) throw new Error("Missing fixture layer");
          const { drawpane: e } = window as unknown as DebugWindow;
          return { page: e.s.pageId, camera: { ...e.s.camera }, layer: e.doc.get(id) };
        }, marker);
      const before = await readDocument();
      const oldCanvas = await engine.elementHandle();
      await engine.evaluate((canvas: HTMLCanvasElement) => {
        const gl = canvas.getContext("webgl2");
        const loss = gl?.getExtension("WEBGL_lose_context");
        if (!loss) throw new Error("Missing WEBGL_lose_context");
        loss.loseContext();
      });

      await expect(host).toHaveAttribute("data-renderer", "cpu-worker", { timeout: 20_000 });
      expect(await oldCanvas?.evaluate((old) => old.isConnected)).toBe(false);
      expect(await readDocument()).toEqual(before);
      const pixelCount = await engine.evaluate((canvas: HTMLCanvasElement) => {
        const rgba = canvas.getContext("2d")?.getImageData(0, 0, canvas.width, canvas.height).data;
        if (!rgba) throw new Error("Missing CPU canvas pixels");
        let magenta = 0;
        for (let p = 0; p < rgba.length; p += 4) {
          if (rgba[p] === 255 && rgba[p + 1] === 0 && rgba[p + 2] === 255) magenta++;
        }
        return magenta;
      });
      expect(pixelCount).toBeGreaterThan(1000);
      expect(await engine.evaluate(backing)).toEqual(surface);
      await expect
        .poll(() =>
          page.evaluate(
            () => (window as unknown as DebugWindow).drawpaneEngineView?.cpuSnapshotBytes,
          ),
        )
        .toBe(surface.width * surface.height * 4);
      await page.addStyleTag({ content: ".canvas { width: 1700px; height: 1300px; }" });
      await expect
        .poll(
          async () => {
            const { width, height } = await engine.evaluate(backing);
            const pixels = width * height;
            const saved = await page.evaluate(
              () => (window as unknown as DebugWindow).drawpaneEngineView?.cpuSnapshotBytes,
            );
            return pixels > 5_900_000 && pixels <= 6_000_000 && saved === pixels * 4;
          },
          { timeout: 20_000, message: "cap both CPU backings on an oversized viewport" },
        )
        .toBe(true);
      expect(await page.evaluate(() => (window as unknown as DebugWindow).backendChanges)).toEqual([
        "webgl2 to cpu-worker",
      ]);
    } finally {
      await context.close();
    }
  });

  test("a desktop-UA iPad without a hint bounds editor overscan and the prototype stage", async ({
    browser,
  }) => {
    const context = await mobilePage(browser, instance, ipad, null, "canvas");
    try {
      const page = await context.newPage();
      await createFile(page);
      const frame = await page.evaluate(() => {
        const e = (window as unknown as DebugWindow).drawpane;
        const pageId = e.s.pageId;
        if (!pageId) throw new Error("Missing editor page");
        return e.createLayer("frame", { x: 0, y: 0, width: 3200, height: 3000 }, pageId);
      });

      await page.addStyleTag({ content: ".canvas { width: 2200px; height: 1700px; }" });
      const content = page.locator("canvas[data-canvas-role=content]");
      await expect
        .poll(async () => {
          const surface = await content.evaluate(backing);
          return {
            cssWidth: surface.cssWidth,
            capped: surface.width * surface.height <= 7_000_000,
          };
        })
        .toEqual({ cssWidth: 2200, capped: true });
      for (const role of ["content", "overlay", "labels", "pixel-grid"]) {
        const surface = await page.locator(`canvas[data-canvas-role=${role}]`).evaluate(backing);
        expect(surface.cssWidth * surface.cssHeight * 4).toBeGreaterThan(7_000_000);
        expect(surface.width * surface.height).toBeLessThanOrEqual(7_000_000);
        expect(surface.width * surface.height).toBeGreaterThan(6_900_000);
      }
      await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();

      await page.goto(`${new URL(page.url()).pathname}/present?screen=${frame}`);
      await page.addStyleTag({ content: ".present__stage { width: 3400px; height: 3200px; }" });
      const stage = page.locator(".stage__screen canvas");
      await expect.poll(async () => (await stage.evaluate(backing)).cssWidth).toBe(3200);
      const surface = await stage.evaluate(backing);
      expect(surface.width * surface.height).toBeLessThanOrEqual(7_000_000);
      expect(surface.width * surface.height).toBeGreaterThan(6_900_000);
    } finally {
      await context.close();
    }
  });

  test("the shipping canvas stays within its decoded cache budget for visible images", async ({
    browser,
  }) => {
    const context = await mobilePage(
      browser,
      instance,
      { ...pixel, deviceScaleFactor: 3 },
      1,
      "canvas",
    );
    try {
      const page = await context.newPage();
      await createFile(page);
      const image = await page.evaluate(() => {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 2048;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("Missing PNG fixture context");
        ctx.fillStyle = "#36d96d";
        ctx.fillRect(0, 0, 2048, 2048);
        return canvas.toDataURL().split(",")[1] ?? "";
      });
      let requests = 0;
      await page.route("**/api/media/*", async (route) => {
        requests++;
        await route.fulfill({ body: Buffer.from(image, "base64"), contentType: "image/png" });
      });
      await page.evaluate(() => {
        const e = (window as unknown as DebugWindow).drawpane;
        const pageId = e.s.pageId;
        if (!pageId) throw new Error("Missing editor page");
        for (let i = 0; i < 16; i++) {
          e.createLayer(
            "rect",
            { x: 35 + (i % 4) * 70, y: 130 + Math.floor(i / 4) * 70, width: 65, height: 65 },
            pageId,
            {
              fills: [{ type: "image", ref: i.toString(16).padStart(64, "0"), scaleMode: "fill" }],
            },
          );
        }
        const camera = e.s.camera.zoomAt({ x: 0, y: 0 }, 1);
        e.state.set({ camera: camera.pan(-camera.x, -camera.y) });
      });
      await expect
        .poll(() => requests, { timeout: 20_000, message: "fetch all visible image refs" })
        .toBe(16);
      await expect
        .poll(() =>
          page.evaluate(
            () => (window as unknown as DebugWindow).drawpaneFrames.mobileMemory?.decodedBytes,
          ),
        )
        .toBeGreaterThan(30 * MiB);
      const pressure = await page.evaluate(() => {
        const { drawpaneFrames } = window as unknown as DebugWindow;
        return drawpaneFrames.mobileMemory;
      });
      expect(pressure?.decodedBytes).toBeLessThanOrEqual(48 * MiB);
      const content = page.locator("canvas[data-canvas-role=content]");
      await expect
        .poll(
          () =>
            content.evaluate((canvas: HTMLCanvasElement) => {
              const ctx = canvas.getContext("2d");
              if (!ctx) throw new Error("Missing content canvas");
              let drawn = 0;
              for (let i = 0; i < 16; i++) {
                const x = (35 + (i % 4) * 70 + 30) * 2;
                const y = (130 + Math.floor(i / 4) * 70 + 30) * 2;
                const [r, g, b] = ctx.getImageData(x, y, 1, 1).data;
                if (r === 0x36 && g === 0xd9 && b === 0x6d) drawn++;
              }
              return drawn;
            }),
          { timeout: 20_000, message: "paint all visible images within the decoded budget" },
        )
        .toBe(16);
      await page.evaluate(async () => {
        const w = window as unknown as DebugWindow;
        for (let i = 0; i < 5; i++) {
          w.drawpaneFrames.redraw();
          await new Promise(requestAnimationFrame);
        }
      });
      expect(requests).toBe(16);
    } finally {
      await context.close();
    }
  });
});
