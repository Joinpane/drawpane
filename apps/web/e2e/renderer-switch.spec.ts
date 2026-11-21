/**
 * End-to-end checks for the render engine switch (`?renderer=engine`) and its
 * bottom-bar status chip:
 *
 * - the chip is hidden when the switch is off;
 * - `?renderer=engine` survives opening a file from the dashboard, switching
 *   pages, toggling branch review, and a sign-out/sign-in redirect;
 * - `?renderer=canvas` turns the switch back off for the session;
 * - the chip reports "Engine · WebGPU" on a plain page and "Canvas renderer"
 *   with the reason on a page with progressive layer blur, on a software GPU
 *   when disallowed, and in a browser without WebGPU.
 */
import { expect, type Page, test } from "@playwright/test";
import { freshInstance, type Instance } from "./fresh-instance";

test.use({
  launchOptions: {
    args: [
      "--enable-unsafe-webgpu",
      ...(process.env.ENGINE_CHROME_ARGS ?? "").split(/\s+/).filter(Boolean),
    ],
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  },
});

type W = {
  drawpane: {
    s: { pageId: string };
    createLayer(t: string, r: object, p: string, props?: object): string;
    addPage(): void;
    setPage(id: string): void;
    commit(ops: object[]): boolean;
    doc: {
      pages(): Array<{ id: string; name: string }>;
    };
  };
};

const live = (page: Page) =>
  expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({ timeout: 15_000 });

const rendererChip = (page: Page) => page.getByRole("button", { name: /^Renderer:/ });

test.describe
  .serial("Renderer switch and status chip", () => {
    test.skip(!!process.env.E2E_BASE_URL, "Needs its own local instance.");

    let instance: Instance;
    let page: Page;
    let fileUrl: string;
    let plainPageId: string;
    let fallbackPageId: string;

    test.beforeAll(async ({ browser }) => {
      test.setTimeout(180_000);
      const port = Number(process.env.RENDERER_E2E_PORT ?? 9143);
      instance = await freshInstance(browser, { port, inspectorPort: port + 540 });
      page = instance.page;
      await page.evaluate(() => {
        localStorage.setItem("drawpane:debug", "1");
        // Headless Chromium's WebGPU adapter is SwiftShader, which the editor refuses by default.
        localStorage.setItem("drawpane:engine-software", "allow");
      });
    });

    test.afterAll(async () => {
      await instance?.stop();
    });

    test("hides the status chip when the switch is off", async () => {
      await page.goto("/?renderer=canvas");
      await page.getByRole("button", { name: "New file" }).first().click();
      await live(page);
      fileUrl = new URL(page.url()).pathname;
      await expect(rendererChip(page)).toHaveCount(0);
    });

    test("keeps ?renderer=engine from the dashboard into the editor and updates the chip per page", async () => {
      // Turn the switch on via the dashboard URL with no saved renderer preference.
      await page.evaluate(() => localStorage.removeItem("drawpane:renderer"));
      await page.goto("/?renderer=engine&present=readback");
      await expect(page.getByRole("button", { name: "New file" }).first()).toBeVisible({
        timeout: 15_000,
      });
      await page.getByRole("button", { name: "New file" }).first().click();
      await live(page);
      fileUrl = new URL(page.url()).pathname;

      // Plain page: chip reports the WebGPU engine.
      await expect(rendererChip(page)).toBeVisible({ timeout: 30_000 });
      await expect(rendererChip(page)).toContainText("Engine · WebGPU", { timeout: 30_000 });

      // Add a plain rect on Page 1, then create Page 2 with progressive layer blur.
      const pages = await page.evaluate(() => {
        const e = (window as unknown as W).drawpane;
        const plain = e.s.pageId;
        e.createLayer("rect", { x: 40, y: 40, width: 160, height: 100 }, plain, {
          fills: [{ type: "solid", color: "#228be6" }],
        });
        e.addPage();
        const fallback = e.s.pageId;
        e.createLayer("rect", { x: 40, y: 40, width: 160, height: 100 }, fallback, {
          fills: [{ type: "solid", color: "#ffffff" }],
          effects: [
            {
              type: "layer-blur",
              radius: 12,
              blurType: "progressive",
              startRadius: 0,
              startOffset: { x: 0, y: 0 },
              endOffset: { x: 1, y: 1 },
            },
          ],
        });
        return { plain, fallback };
      });
      plainPageId = pages.plain;
      fallbackPageId = pages.fallback;

      // The fallback page reports Canvas renderer and names layer blur in its popover.
      await expect(rendererChip(page)).toContainText("Canvas renderer", { timeout: 15_000 });
      await expect(rendererChip(page)).toHaveAttribute("aria-label", /this page uses layer blur/);
      await rendererChip(page).click();
      const popover = page.getByRole("dialog", { name: "Renderer status" });
      await expect(popover).toBeVisible();
      await expect(popover).toContainText("this page uses layer blur");
      await page.keyboard.press("Escape");
      await expect(popover).toHaveCount(0);
      await expect(rendererChip(page)).toBeFocused();

      // Switch back to the plain page: chip switches back to Engine · WebGPU.
      await page.evaluate((id) => (window as unknown as W).drawpane.setPage(id), plainPageId);
      await expect(rendererChip(page)).toContainText("Engine · WebGPU", { timeout: 15_000 });

      // And back to the fallback page once more to confirm switching pages preserves the switch.
      await page.evaluate((id) => (window as unknown as W).drawpane.setPage(id), fallbackPageId);
      await expect(rendererChip(page)).toContainText("Canvas renderer", { timeout: 15_000 });
    });

    test("keeps ?renderer=engine across branch review toggles and turns off with ?renderer=canvas", async () => {
      // Open the plain page with ?renderer=engine in the URL, then make a branch and toggle review.
      await page.goto(`${fileUrl}?renderer=engine&present=readback`);
      await live(page);
      await expect(rendererChip(page)).toContainText("Engine · WebGPU", { timeout: 30_000 });

      await page.getByRole("button", { name: "Branches" }).click();
      const menu = page.getByRole("dialog", { name: "Branches" });
      await menu.getByLabel(/New branch from/).fill("engine-check");
      await menu.getByRole("button", { name: "Make branch" }).click();
      await expect(page.locator(".branch-chip")).toHaveText("engine-check");
      await live(page);

      // Put ?renderer=engine on the branch URL and toggle review on and off.
      const branchPath = new URL(page.url()).pathname;
      await page.goto(`${branchPath}?renderer=engine&present=readback`);
      await live(page);
      await expect(rendererChip(page)).toBeVisible({ timeout: 30_000 });

      await page.getByRole("button", { name: "Merge" }).click();
      await expect(page).toHaveURL(/review=true/);
      await expect(page).toHaveURL(/renderer=engine/);
      await expect(rendererChip(page)).toBeVisible();

      await page.getByRole("button", { name: "Close review" }).click();
      await expect(page).not.toHaveURL(/review=true/);
      await expect(page).toHaveURL(/renderer=engine/);
      await expect(rendererChip(page)).toBeVisible();

      // `?renderer=canvas` turns the switch back off for the session.
      await page.goto(`${fileUrl}?renderer=canvas`);
      await live(page);
      await expect(rendererChip(page)).toHaveCount(0);
      await page.goto(fileUrl);
      await live(page);
      await expect(rendererChip(page)).toHaveCount(0);
    });

    test("keeps ?renderer=engine across a login redirect", async () => {
      // Sign out from the dashboard, then open the file with ?renderer=engine directly.
      await page.goto("/");
      await page.getByRole("button", { name: "Sign out" }).click();
      await expect(page).toHaveURL(/\/signin/);

      await page.goto(`${fileUrl}?renderer=engine&present=readback`);
      await expect(page).toHaveURL(/\/signin\?next=/);
      await expect(page).toHaveURL(/renderer%3Dengine/);

      await page.getByRole("button", { name: "Continue with a passkey" }).click();
      await expect(page).toHaveURL(new RegExp(`${fileUrl}.*renderer=engine`), { timeout: 15_000 });
      await live(page);
      await expect(rendererChip(page)).toContainText("Engine · WebGPU", { timeout: 30_000 });
    });

    test("switches renderers in place on the same route, persists engine-webgl/engine-cpu, and tracks fallback and recovery in the chip", async ({
      browser,
    }) => {
      test.setTimeout(120_000);
      const storageState = await instance.context.storageState();

      // 1. Same-route switching without a reload: engine -> canvas -> engine-cpu -> engine-webgl -> canvas.
      // Verifies durable slot cleanup (zero leaked engine canvases) and accurate chip labels.
      const switchCtx = await browser.newContext({ baseURL: instance.url, storageState });
      try {
        const p = await switchCtx.newPage();
        await p.addInitScript(() => {
          localStorage.setItem("drawpane:debug", "1");
          localStorage.setItem("drawpane:engine-software", "allow");
          localStorage.removeItem("drawpane:renderer");
          localStorage.removeItem("drawpane:engine-present");
        });
        await p.goto(`${fileUrl}?renderer=engine&present=readback`);
        await live(p);
        await expect(rendererChip(p)).toContainText("Engine · WebGPU", { timeout: 30_000 });
        await p.evaluate(() => {
          (window as unknown as { __sameDoc?: number }).__sameDoc = 42;
        });

        const pushSameRoute = async (search: string) => {
          await p.evaluate(
            ({ path, search }) => {
              window.history.pushState({}, "", `${path}${search}`);
              window.dispatchEvent(new PopStateEvent("popstate"));
            },
            { path: fileUrl, search },
          );
        };

        // Switch to canvas in place: chip disappears, engine canvas is removed from the durable slot.
        await pushSameRoute("?renderer=canvas");
        await expect(rendererChip(p)).toHaveCount(0, { timeout: 10_000 });
        await expect
          .poll(() =>
            p.evaluate(() => ({
              sameDoc: (window as unknown as { __sameDoc?: number }).__sameDoc,
              engineCanvases: document.querySelectorAll('[data-canvas-role="engine"]').length,
              contentVisible:
                document.querySelector<HTMLCanvasElement>('[data-canvas-role="content"]')?.style
                  .visibility !== "hidden",
              hasView: Boolean(
                (window as unknown as { drawpaneEngineView?: unknown }).drawpaneEngineView,
              ),
            })),
          )
          .toEqual({ sameDoc: 42, engineCanvases: 0, contentVisible: true, hasView: false });

        // Switch to engine-cpu in place: chip reports Engine · CPU view, persists across reload without query.
        await pushSameRoute("?renderer=engine-cpu");
        await expect(rendererChip(p)).toContainText("Engine · CPU view", { timeout: 30_000 });
        expect(
          await p.evaluate(() => document.querySelectorAll('[data-canvas-role="engine"]').length),
        ).toBe(1);
        await p.goto(fileUrl);
        await live(p);
        await expect(rendererChip(p)).toContainText("Engine · CPU view", { timeout: 30_000 });

        // Switch to engine-webgl in place (direct GPU presentation): chip reports Engine · WebGL2, shows recovery cover on context loss.
        await p.evaluate(() => {
          (window as unknown as { __sameDoc?: number }).__sameDoc = 99;
        });
        await pushSameRoute("?renderer=engine-webgl&present=webgpu");
        await expect(rendererChip(p)).toContainText("Engine · WebGL2", { timeout: 30_000 });
        await p.evaluate(() => {
          const w = window as unknown as {
            drawpaneEngineView?: {
              canvas: HTMLCanvasElement;
              engine?: { attachGpu: (...args: unknown[]) => Promise<unknown> };
            };
            releaseRecovery?: () => void;
          };
          const eng = w.drawpaneEngineView?.engine;
          if (!eng) throw new Error("no engine");
          const orig = eng.attachGpu.bind(eng);
          eng.attachGpu = (...args: unknown[]) =>
            new Promise((resolve) => {
              w.releaseRecovery = () => void orig(...args).then(resolve);
            });
          w.drawpaneEngineView?.canvas
            .getContext("webgl2")
            ?.getExtension("WEBGL_lose_context")
            ?.loseContext();
        });
        await expect(rendererChip(p)).toContainText("Canvas renderer", { timeout: 15_000 });
        await expect(rendererChip(p)).toHaveAttribute("aria-label", /recovering GPU surface/);
        await p.evaluate(() => {
          (window as unknown as { releaseRecovery?: () => void }).releaseRecovery?.();
        });
        await expect(rendererChip(p)).toContainText("Engine · WebGL2", { timeout: 20_000 });
        expect(
          await p.evaluate(() => (window as unknown as { __sameDoc?: number }).__sameDoc),
        ).toBe(99);
      } finally {
        await switchCtx.close();
      }

      // 2. Software GPU refused by default: steps down to CPU view mode, reported truthfully in the chip.
      const softCtx = await browser.newContext({ baseURL: instance.url, storageState });
      try {
        const p = await softCtx.newPage();
        await p.addInitScript(() => {
          localStorage.removeItem("drawpane:engine-software");
          localStorage.removeItem("drawpane:renderer");
        });
        await p.goto(`${fileUrl}?renderer=engine`);
        await live(p);
        await expect(rendererChip(p)).toContainText("Engine · CPU view", { timeout: 30_000 });
        await rendererChip(p).click();
        await expect(p.getByRole("dialog", { name: "Renderer status" })).toContainText(
          "Drawing with CPU view",
        );
      } finally {
        await softCtx.close();
      }

      // 3. No WebGPU (software WebGL2 allowed): steps down to WebGL2, reported truthfully in the chip.
      const noGpuCtx = await browser.newContext({ baseURL: instance.url, storageState });
      try {
        const p = await noGpuCtx.newPage();
        await p.addInitScript(() => {
          Object.defineProperty(navigator, "gpu", { value: undefined, configurable: true });
          localStorage.setItem("drawpane:engine-software", "allow");
          localStorage.removeItem("drawpane:renderer");
          localStorage.removeItem("drawpane:engine-present");
        });
        await p.goto(`${fileUrl}?renderer=engine`);
        await live(p);
        await expect(rendererChip(p)).toContainText("Engine · WebGL2", { timeout: 30_000 });
        await rendererChip(p).click();
        await expect(p.getByRole("dialog", { name: "Renderer status" })).toContainText(
          "Drawing with WebGL2",
        );
      } finally {
        await noGpuCtx.close();
      }

      // 4. Terminal Canvas fallback (no WebGPU, no WebGL2, no Worker): chip reports Canvas renderer with reason.
      const terminalCtx = await browser.newContext({ baseURL: instance.url, storageState });
      try {
        const p = await terminalCtx.newPage();
        await p.addInitScript(() => {
          Object.defineProperty(navigator, "gpu", { value: undefined, configurable: true });
          Object.defineProperty(window, "Worker", { value: undefined, configurable: true });
          const orig = HTMLCanvasElement.prototype.getContext;
          HTMLCanvasElement.prototype.getContext = function (
            this: HTMLCanvasElement,
            type: string,
            ...args: unknown[]
          ) {
            if (type === "webgl2" || type === "webgl") return null;
            return (orig as (this: HTMLCanvasElement, t: string, ...a: unknown[]) => unknown).call(
              this,
              type,
              ...args,
            );
          } as typeof HTMLCanvasElement.prototype.getContext;
          localStorage.removeItem("drawpane:renderer");
        });
        await p.goto(`${fileUrl}?renderer=engine`);
        await live(p);
        await expect(rendererChip(p)).toContainText("Canvas renderer", { timeout: 30_000 });
        await rendererChip(p).click();
        await expect(p.getByRole("dialog", { name: "Renderer status" })).toContainText(
          /Web Workers are not available/i,
        );
      } finally {
        await terminalCtx.close();
      }
    });
  });
