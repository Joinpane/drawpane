import { expect, type Page, test } from "@playwright/test";
import { freshInstance, type Instance } from "./fresh-instance";

type TestWindow = {
  drawpane: {
    s: { pageId: string };
    createLayer(type: string, rect: object, parent: string, props: object): string;
    select(ids: string[]): void;
    createComponent(): void;
  };
  drawpaneHeadless: {
    exportLayer(ids: string[], options: object): Promise<{ data: string; type: string }>;
    thumbnail(): Promise<{ type: string } | null>;
  };
  snapshotResults: string[];
  snapshotWorkers: number;
};

const engineBackend = /^(webgpu|webgl2|cpu-worker)$/;
const chip = (page: Page) => page.getByRole("button", { name: /^Renderer:/ });
const live = (page: Page) =>
  expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({ timeout: 20_000 });
const content = (page: Page) => page.locator(".canvas[data-renderer]");
const policyPath = "**/api/renderer-policy";

async function createFile(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "New file" }).first().click();
  await live(page);
  return new URL(page.url()).pathname;
}

async function savePolicy(page: Page, forceCanvas: boolean, defaultRenderer = "engine") {
  await page.goto("/admin/health");
  await page.getByLabel("Default renderer").selectOption(defaultRenderer);
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
    browserName,
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
      const w = window as unknown as TestWindow;
      w.snapshotResults = results;
      w.snapshotWorkers = 0;
      const BrowserWorker = window.Worker;
      window.Worker = class extends BrowserWorker {
        constructor(url: string | URL, options?: WorkerOptions) {
          super(url, options);
          if (String(url).includes("engine-snapshot.worker")) {
            w.snapshotWorkers++;
            this.addEventListener("message", ({ data }) => {
              if (data.type === "done") results.push(data.mime);
            });
          }
        }
      };
    });

    await savePolicy(page, false);
    const file = await createFile(page);
    const canvas = content(page);
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
    await expect(chip(page)).toHaveAccessibleName(
      /administrator has turned on Canvas for everyone/,
    );
    await expect(page.locator('[data-canvas-role="engine"]')).toHaveCount(0);
    const forced = await render();
    expect(Buffer.from(forced.png, "base64").readUInt32BE(16)).toBe(117);
    expect(forced.thumbnailType).toBe("image/webp");
    expect(forced.workers).toEqual([]);

    await page.evaluate((id) => (window as unknown as TestWindow).drawpane.select([id]), frame);
    await page.locator(".inspector-export").scrollIntoViewIfNeeded();
    const preview = page.locator(".export-section__preview img");
    await expect
      .poll(() => preview.evaluate((img: HTMLImageElement) => img.naturalWidth))
      .toBeGreaterThan(0);
    for (const [label, mime] of [
      ["JPEG", "image/jpeg"],
      ["WebP", "image/webp"],
    ] as const) {
      await page.getByRole("radio", { name: label, exact: true }).click();
      const [download] = await Promise.all([
        page.waitForEvent("download"),
        page.getByRole("button", { name: /Export layer/ }).click(),
      ]);
      expect(download.suggestedFilename()).toMatch(label === "JPEG" ? /\.jpe?g$/i : /\.webp$/i);
      const exported = await page.evaluate(
        ({ id, format }) =>
          (window as unknown as TestWindow).drawpaneHeadless.exportLayer([id], {
            format,
            scale: 1,
          }),
        { id: frame, format: label.toLowerCase() },
      );
      expect(exported.type).toBe(mime);
    }
    if (browserName === "chromium") {
      await instance.context.grantPermissions(["clipboard-read", "clipboard-write"]);
      await page.keyboard.press("ControlOrMeta+Shift+c");
      await expect(page.getByText("Copied Home as PNG.")).toBeVisible();
      const pngWidth = await page.evaluate(async () => {
        const entries = await navigator.clipboard.read();
        const entry = entries.find((value) => value.types.includes("image/png"));
        if (!entry) return null;
        return new DataView(await (await entry.getType("image/png")).arrayBuffer()).getUint32(16);
      });
      expect(pngWidth).toBe(234);
    }
    expect(await page.evaluate(() => (window as unknown as TestWindow).snapshotWorkers)).toBe(0);

    await page.getByRole("button", { name: "Play prototype" }).click();
    await expect(stage).toHaveAttribute("data-renderer", "canvas");
    await expect(stage).toHaveAttribute("data-renderer-source", "server");
    await expect(page.locator(".present__thumb canvas").first()).toBeVisible();
    await page.goto("/diagnostics/renderer");
    const report = page.getByTestId("diag-report");
    await expect(report).toContainText("App renderer choice: canvas (server)");
    await expect(report).toContainText("Last active app backend in this tab: canvas (server)");

    await page.goto(file);
    await live(page);
    await page.evaluate(async (path) => {
      await fetch(`/api/files/${path.split("/").pop()}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Renderer library" }),
      });
      const editor = (window as unknown as TestWindow).drawpane;
      const id = editor.createLayer(
        "frame",
        { x: 150, y: 0, width: 100, height: 40 },
        editor.s.pageId,
        {
          name: "Library button",
          fills: [{ type: "solid", color: "#0868bf" }],
        },
      );
      editor.select([id]);
      editor.createComponent();
    }, file);
    await page.getByRole("radio", { name: "Assets" }).click();
    await page.getByRole("button", { name: "Team libraries" }).click();
    await page
      .getByRole("dialog", { name: "Team libraries" })
      .getByRole("button", { name: "Publish…" })
      .click();
    await page
      .getByRole("dialog", { name: "Publish as a library" })
      .getByRole("button", { name: "Publish" })
      .click();
    await expect(page.getByText("Published 1 component to the team.")).toBeVisible();
    await createFile(page);
    await page.getByRole("radio", { name: "Assets" }).click();
    await page.getByRole("button", { name: "Browse team libraries" }).click();
    const libraries = page.getByRole("dialog", { name: "Team libraries" });
    await libraries.getByRole("button", { name: "Use Renderer library" }).click();
    await expect(
      libraries.getByRole("button", { name: "Stop using Renderer library" }),
    ).toBeVisible();
    await libraries.getByRole("button", { name: "Done" }).click();
    const library = page.getByRole("region", { name: "Renderer library" });
    await expect(library.locator("canvas.assets__preview")).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as TestWindow).snapshotWorkers)).toBe(0);

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

  test("refreshes open dashboard tabs before they enter a file", async () => {
    test.setTimeout(90_000);
    const { context, page } = instance;
    await savePolicy(page, false);
    const stale = await context.newPage();
    const foreground = await context.newPage();
    try {
      const before = Date.now();
      await stale.clock.setFixedTime(before);
      for (const dashboard of [stale, foreground]) {
        const [settings] = await Promise.all([
          dashboard.waitForResponse((response) => response.url().endsWith("/api/renderer-policy")),
          dashboard.goto("/"),
        ]);
        expect(await settings.json()).toEqual({ defaultRenderer: "engine", forceCanvas: false });
        await expect(dashboard.getByRole("heading", { name: "Recent files" })).toBeVisible();
        await dashboard.evaluate(() => localStorage.setItem("drawpane:renderer", "engine-cpu"));
      }

      const changed = await context.request.put("/api/admin/renderer-policy", {
        data: { defaultRenderer: "engine", forceCanvas: true },
      });
      expect(changed.ok()).toBe(true);
      await stale.clock.setFixedTime(before + 61_000);
      const refreshed = foreground.waitForResponse((response) =>
        response.url().endsWith("/api/renderer-policy"),
      );
      await foreground.evaluate(() => {
        Object.defineProperty(document, "visibilityState", {
          configurable: true,
          value: "visible",
        });
        document.dispatchEvent(new Event("visibilitychange"));
      });
      expect(await (await refreshed).json()).toEqual({
        defaultRenderer: "engine",
        forceCanvas: true,
      });

      for (const dashboard of [stale, foreground]) {
        await dashboard.getByRole("button", { name: "New file" }).first().click();
        await live(dashboard);
        await expect(content(dashboard)).toHaveAttribute("data-renderer-source", "server");
        await expect(content(dashboard)).toHaveAttribute("data-renderer", "canvas");
        await expect(dashboard.locator('[data-canvas-role="engine"]')).toHaveCount(0);
      }
    } finally {
      await stale.close();
      await foreground.close();
    }
  });

  test("shows the app immediately and waits for settings only before drawing", async () => {
    const { context, page } = instance;
    const file = await createFile(page);
    const slow = await context.newPage();
    const release = Promise.withResolvers<void>();
    try {
      await slow.route(policyPath, async (route) => {
        await release.promise;
        await route
          .fulfill({ json: { defaultRenderer: "engine", forceCanvas: true } })
          .catch(() => {});
      });
      await slow.goto("/signin", { waitUntil: "commit" });
      await expect(slow.getByRole("heading", { name: "Sign in to Drawpane" })).toBeVisible();
      await slow.goto(`${file}?renderer=engine-cpu`, { waitUntil: "commit" });
      await expect(slow.locator(".app-loading")).toBeAttached();
      await expect(content(slow)).toHaveCount(0);
      release.resolve();
      await live(slow);
      await expect(content(slow)).toHaveAttribute("data-renderer-source", "server");
      await expect(content(slow)).toHaveAttribute("data-renderer", "canvas");
    } finally {
      release.resolve();
      await slow.close();
    }
  });

  test("uses and explains Canvas when settings fail or time out", async () => {
    const { context, page } = instance;
    const file = await createFile(page);
    for (const stalls of [false, true]) {
      const tab = await context.newPage();
      const release = Promise.withResolvers<void>();
      try {
        await tab.route(policyPath, async (route) => {
          if (stalls) await release.promise;
          await route.fulfill({ status: 500 }).catch(() => {});
        });
        await tab.goto(`${file}?renderer=engine-cpu`);
        await live(tab);
        await expect(content(tab)).toHaveAttribute("data-renderer-source", "settings-unavailable");
        await expect(content(tab)).toHaveAttribute("data-renderer", "canvas");
        await expect(chip(tab)).toHaveAccessibleName(/Renderer settings couldn.t be loaded/);
        await tab.goto("/diagnostics/renderer");
        await expect(tab.getByTestId("diag-report")).toContainText(
          "Last active app backend in this tab: canvas (settings failed to load)",
        );
      } finally {
        release.resolve();
        await tab.close();
      }
    }
  });

  test("keeps the engine opt-in behind details for an explicit Canvas default", async () => {
    const { page } = instance;
    await savePolicy(page, false, "canvas");
    await page.evaluate(() => {
      localStorage.removeItem("drawpane:renderer");
      sessionStorage.removeItem("drawpane:renderer");
    });
    await createFile(page);
    await expect(content(page)).toHaveAttribute("data-renderer-source", "instance-default");
    await chip(page).click();
    const details = page.getByRole("dialog", { name: "Renderer status" });
    const action = details.getByRole("button", { name: "Use the render engine in this browser" });
    await expect(action).toBeHidden();
    await details.getByText("Switch renderer", { exact: true }).click();
    await expect(action).toBeVisible();
  });
});
