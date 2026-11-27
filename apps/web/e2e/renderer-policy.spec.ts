import { expect, type Page, test } from "@playwright/test";
import { freshInstance, type Instance } from "./fresh-instance";

type TestWindow = {
  drawpane: {
    s: { pageId: string };
    createLayer(type: string, rect: object, parent: string, props: object): string;
  };
  drawpaneHeadless: {
    exportLayer(ids: string[], options: object): Promise<{ data: string }>;
    thumbnail(): Promise<{ type: string } | null>;
  };
  snapshotResults: string[];
};

const engineBackend = /^(webgpu|webgl2|cpu-worker)$/;
const chip = (page: Page) => page.getByRole("button", { name: /^Renderer:/ });
const live = (page: Page) =>
  expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({ timeout: 20_000 });

async function savePolicy(page: Page, forceCanvas: boolean) {
  await page.goto("/admin/health");
  await page.getByLabel("Default renderer").selectOption("engine");
  await page.getByLabel("Use Canvas for everyone").setChecked(forceCanvas);
  await page.getByRole("button", { name: "Save renderer settings" }).click();
  await expect(page.getByText("Renderer settings saved.")).toBeVisible();
}

test.describe("Instance renderer policy", () => {
  test.skip(
    !!process.env.E2E_BASE_URL || !!process.env.E2E_ENGINE,
    "Needs an unconfigured local instance.",
  );

  let instance: Instance;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000);
    const port = Number(process.env.RENDERER_POLICY_E2E_PORT ?? 9144);
    instance = await freshInstance(browser, { port, inspectorPort: port + 540 });
  });

  test.afterAll(async () => {
    await instance?.stop();
  });

  test("applies the instance default and rollback to the editor, exports, thumbnails and player", async ({
    request,
  }) => {
    test.setTimeout(180_000);
    const { page, url } = instance;
    const initial = await request.get(`${url}/api/renderer-policy`);
    expect(initial.headers()["cache-control"]).toBe("no-store");
    expect(await initial.json()).toEqual({ defaultRenderer: null, forceCanvas: false });
    const unauthorized = await request.put(`${url}/api/admin/renderer-policy`, {
      data: { defaultRenderer: "engine", forceCanvas: true },
    });
    expect(unauthorized.status()).toBe(401);

    await page.addInitScript(() => {
      localStorage.setItem("drawpane:debug", "1");
      const results: string[] = [];
      (window as unknown as TestWindow).snapshotResults = results;
      const BrowserWorker = window.Worker;
      window.Worker = class extends BrowserWorker {
        constructor(url: string | URL, options?: WorkerOptions) {
          super(url, options);
          if (String(url).includes("engine-snapshot.worker")) {
            this.addEventListener("message", ({ data }) => {
              if (data.type === "done") results.push(data.mime);
            });
          }
        }
      };
    });

    await savePolicy(page, false);
    await page.goto("/");
    await page.getByRole("button", { name: "New file" }).first().click();
    await live(page);
    const file = new URL(page.url()).pathname;
    const canvas = page.locator(".canvas[data-renderer]");
    await expect(canvas).toHaveAttribute("data-renderer-source", "instance-default");
    await expect(canvas).toHaveAttribute("data-renderer", engineBackend, { timeout: 45_000 });

    const frame = await page.evaluate(() => {
      const editor = (window as unknown as TestWindow).drawpane;
      return editor.createLayer("frame", { x: 0, y: 0, width: 117, height: 73 }, editor.s.pageId, {
        name: "Home",
        fills: [{ type: "solid", color: "#0868bf" }],
      });
    });
    const render = () =>
      page.evaluate(async (id) => {
        const w = window as unknown as TestWindow;
        w.snapshotResults.length = 0;
        const png = await w.drawpaneHeadless.exportLayer([id], { format: "png", scale: 1 });
        const thumb = await w.drawpaneHeadless.thumbnail();
        return { png: png.data, thumbnailType: thumb?.type, workers: [...w.snapshotResults] };
      }, frame);

    const engine = await render();
    expect(Buffer.from(engine.png, "base64").readUInt32BE(16)).toBe(117);
    expect(engine.thumbnailType).toBe("image/webp");
    expect(engine.workers).toEqual(expect.arrayContaining(["image/png", "image/webp"]));

    await live(page);
    await page.getByRole("button", { name: "Play prototype" }).click();
    const stage = page.locator(".stage__device");
    await expect(stage).toHaveAttribute("data-renderer", engineBackend, { timeout: 45_000 });
    await expect(stage).toHaveAttribute("data-renderer-source", "instance-default");

    await savePolicy(page, true);
    await page.evaluate(() => {
      localStorage.setItem("drawpane:renderer", "engine-webgl");
      sessionStorage.setItem("drawpane:renderer", "engine-cpu");
    });
    await page.goto(`${file}?renderer=engine`);
    await live(page);
    await expect(canvas).toHaveAttribute("data-renderer-source", "server");
    await expect(canvas).toHaveAttribute("data-renderer", "canvas");
    await expect(page.locator('[data-canvas-role="engine"]')).toHaveCount(0);
    const forced = await render();
    expect(Buffer.from(forced.png, "base64").readUInt32BE(16)).toBe(117);
    expect(forced.thumbnailType).toBe("image/webp");
    expect(forced.workers).toEqual([]);

    await page.getByRole("button", { name: "Play prototype" }).click();
    await expect(stage).toHaveAttribute("data-renderer", "canvas");
    await expect(stage).toHaveAttribute("data-renderer-source", "server");
    await page.goto("/diagnostics/renderer");
    const report = page.getByTestId("diag-report");
    await expect(report).toContainText("App renderer choice: canvas (server)");
    await expect(report).toContainText("Last active app backend in this tab: canvas (server)");

    await savePolicy(page, false);
    await page.goto(`${file}?renderer=engine-cpu`);
    await live(page);
    await expect(chip(page)).toContainText("Engine · CPU view", { timeout: 45_000 });
    await chip(page).click();
    await page.getByRole("button", { name: "Use Canvas in this browser" }).click();
    await expect(page).toHaveURL(
      (location) => location.pathname === file && !location.searchParams.has("renderer"),
    );
    await live(page);
    await expect(canvas).toHaveAttribute("data-renderer-source", "local");
    await expect(canvas).toHaveAttribute("data-renderer", "canvas");
    expect(
      await page.evaluate(() => ({
        local: localStorage.getItem("drawpane:renderer"),
        session: sessionStorage.getItem("drawpane:renderer"),
      })),
    ).toEqual({ local: "canvas", session: null });
  });
});
