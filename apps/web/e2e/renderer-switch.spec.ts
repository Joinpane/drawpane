/**
 * End-to-end checks for the render engine switch (`?renderer=engine`) and its
 * bottom-bar status chip:
 *
 * - the chip is hidden when the switch is off;
 * - `?renderer=engine` survives opening a file from the dashboard, switching
 *   pages, toggling branch review, and a sign-out/sign-in redirect;
 * - `?renderer=canvas` turns the switch back off for the session;
 * - the chip reports "Engine · WebGPU" on a plain page and "Canvas renderer"
 *   with the reason on a page with a drop shadow, on a software GPU when not
 *   allowed, and in a browser without WebGPU.
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
    let shadowPageId: string;

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
      await page.getByRole("button", { name: "New file" }).first().click();
      await live(page);
      fileUrl = new URL(page.url()).pathname;
      await expect(rendererChip(page)).toHaveCount(0);
    });

    test("keeps ?renderer=engine from the dashboard into the editor and updates the chip per page", async () => {
      // Turn the switch on via the dashboard URL (no localStorage["drawpane:renderer"]).
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

      // Add a plain rect on Page 1, then create Page 2 with a drop shadow.
      const pages = await page.evaluate(() => {
        const e = (window as unknown as W).drawpane;
        const plain = e.s.pageId;
        e.createLayer("rect", { x: 40, y: 40, width: 160, height: 100 }, plain, {
          fills: [{ type: "solid", color: "#228be6" }],
        });
        e.addPage();
        const shadow = e.s.pageId;
        e.createLayer("rect", { x: 40, y: 40, width: 160, height: 100 }, shadow, {
          fills: [{ type: "solid", color: "#ffffff" }],
          effects: [{ type: "drop-shadow", x: 0, y: 4, blur: 12, spread: 0, color: "#00000040" }],
        });
        return { plain, shadow };
      });
      plainPageId = pages.plain;
      shadowPageId = pages.shadow;

      // Drop shadow page: chip reports Canvas renderer and names shadow in its popover.
      await expect(rendererChip(page)).toContainText("Canvas renderer", { timeout: 15_000 });
      await expect(rendererChip(page)).toHaveAttribute("aria-label", /this page uses shadow/);
      await rendererChip(page).click();
      const popover = page.getByRole("dialog", { name: "Renderer status" });
      await expect(popover).toBeVisible();
      await expect(popover).toContainText("this page uses shadow");
      await page.keyboard.press("Escape");
      await expect(popover).toHaveCount(0);
      await expect(rendererChip(page)).toBeFocused();

      // Switch back to the plain page: chip switches back to Engine · WebGPU.
      await page.evaluate((id) => (window as unknown as W).drawpane.setPage(id), plainPageId);
      await expect(rendererChip(page)).toContainText("Engine · WebGPU", { timeout: 15_000 });

      // And back to the shadow page once more to confirm switching pages preserves the switch.
      await page.evaluate((id) => (window as unknown as W).drawpane.setPage(id), shadowPageId);
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

    test("reports software GPU refusal and missing WebGPU in the status chip", async ({
      browser,
    }) => {
      const storageState = await instance.context.storageState();

      // Software GPU refused (drawpane:engine-software is not set).
      const softCtx = await browser.newContext({ baseURL: instance.url, storageState });
      try {
        const p = await softCtx.newPage();
        await p.addInitScript(() => {
          localStorage.removeItem("drawpane:engine-software");
          localStorage.removeItem("drawpane:renderer");
        });
        await p.goto(`${fileUrl}?renderer=engine`);
        await live(p);
        await expect(rendererChip(p)).toContainText("Canvas renderer", { timeout: 30_000 });
        await rendererChip(p).click();
        await expect(p.getByRole("dialog", { name: "Renderer status" })).toContainText(
          "only a software GPU",
        );
      } finally {
        await softCtx.close();
      }

      // No WebGPU in this browser.
      const noGpuCtx = await browser.newContext({ baseURL: instance.url, storageState });
      try {
        const p = await noGpuCtx.newPage();
        await p.addInitScript(() => {
          Object.defineProperty(navigator, "gpu", { value: undefined, configurable: true });
          localStorage.removeItem("drawpane:renderer");
        });
        await p.goto(`${fileUrl}?renderer=engine`);
        await live(p);
        await expect(rendererChip(p)).toContainText("Canvas renderer", { timeout: 30_000 });
        await rendererChip(p).click();
        await expect(p.getByRole("dialog", { name: "Renderer status" })).toContainText(
          "no WebGPU in this browser",
        );
      } finally {
        await noGpuCtx.close();
      }
    });
  });
