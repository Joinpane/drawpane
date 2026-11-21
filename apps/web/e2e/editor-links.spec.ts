import type { Editor } from "@drawpane/editor";
import { expect, type Page, test } from "@playwright/test";
import { freshInstance, type Instance } from "./fresh-instance";

type Debug = { drawpane: Editor };

const saved = (page: Page) =>
  expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({ timeout: 15_000 });
const pageRows = (page: Page) => page.getByRole("list", { name: "Pages" }).getByRole("button");
const layer = (page: Page, id: string) => page.locator(`[data-layer-id="${id}"]`);
const param = (page: Page, key: string) => new URL(page.url()).searchParams.get(key);

test.describe
  .serial("Editor links", () => {
    test.skip(!!process.env.E2E_BASE_URL, "Needs its own local instance.");

    let instance: Instance;
    let page: Page;
    let fileUrl: string;
    let first: string;
    let second: string;
    let near: string;
    let far: string;
    let removed: string;

    test.beforeAll(async ({ browser }) => {
      test.setTimeout(180_000);
      const port = Number(process.env.EDITOR_LINKS_E2E_PORT ?? 18479);
      instance = await freshInstance(browser, { port, inspectorPort: port + 540 });
      page = instance.page;
      await page.evaluate(() => localStorage.setItem("drawpane:debug", "1"));
      await page.getByRole("button", { name: "New file" }).first().click();
      await saved(page);
      const url = new URL(page.url());
      fileUrl = url.origin + url.pathname;
      ({ first, second, near, far, removed } = await page.evaluate(() => {
        const editor = (window as unknown as Debug).drawpane;
        const first = editor.s.pageId as string;
        editor.addPage();
        const second = editor.s.pageId as string;
        const near = editor.createLayer("rect", { x: 12, y: 12, width: 180, height: 120 }, second);
        const far = editor.createLayer("rect", { x: 4000, y: 3000, width: 90, height: 60 }, second);
        const removed = editor.createLayer(
          "rect",
          { x: 200, y: 100, width: 60, height: 60 },
          second,
        );
        if (!near || !far || !removed) throw new Error("Couldn't create test layers.");
        editor.select([removed]);
        editor.deleteSelection();
        return { first, second, near, far, removed };
      }));
      await saved(page);
    });

    test.afterAll(async () => {
      await instance?.stop();
    });

    test("restores the selected layer and fits it after a reload", async () => {
      await pageRows(page).nth(0).click();
      await pageRows(page).nth(1).click();
      await layer(page, far).click();
      await expect.poll(() => param(page, "page-id")).toBe(second);
      await expect.poll(() => param(page, "node-id")).toBe(far);

      await page.reload();
      await expect(pageRows(page).nth(1)).toHaveAttribute("aria-current", "page");
      await expect(layer(page, far)).toHaveAttribute("aria-selected", "true");
      await expect
        .poll(() =>
          page.evaluate((id) => {
            const editor = (window as unknown as Debug).drawpane;
            const { camera, viewport, insets } = editor.s;
            const bounds = editor.scene.unionBounds([id]);
            if (!bounds) return false;
            const fit = camera.fit(bounds, viewport, 64, 8, insets);
            return camera.x === fit.x && camera.y === fit.y && camera.zoom === fit.zoom;
          }, far),
        )
        .toBe(true);
    });

    test("a deleted layer link still opens its page and shows a notice", async () => {
      await page.goto(`${fileUrl}?page-id=${second}&node-id=${removed}`);
      await expect(page.getByText("That layer is no longer available.")).toBeVisible();
      await expect(pageRows(page).nth(1)).toHaveAttribute("aria-current", "page");
      await expect(layer(page, near)).toHaveAttribute("aria-selected", "false");
      await expect.poll(() => param(page, "node-id")).toBeNull();
    });

    test("copies links from Layers, canvas, Pages, and the selection shortcut", async ({
      browserName,
    }) => {
      test.skip(browserName !== "chromium", "Clipboard reading uses Chromium browser permissions.");
      await instance.context.grantPermissions(["clipboard-read", "clipboard-write"]);
      await page.goto(`${fileUrl}?page-id=${second}&node-id=${far}`);
      await expect(layer(page, far)).toHaveAttribute("aria-selected", "true");
      const selectionUrl = `${fileUrl}?page-id=${second}&node-id=${far}`;
      const clipboard = () => page.evaluate(() => navigator.clipboard.readText());
      const clearClipboard = () => page.evaluate(() => navigator.clipboard.writeText(""));

      await clearClipboard();
      await layer(page, far).click({ button: "right" });
      await page.getByRole("menuitem", { name: /^Copy link to selection/ }).click();
      await expect.poll(clipboard).toBe(selectionUrl);

      await clearClipboard();
      const centre = await page.evaluate((id) => {
        const editor = (window as unknown as Debug).drawpane;
        const bounds = editor.scene.bounds(id);
        if (!bounds) throw new Error("Missing selected layer bounds.");
        const { x, y } = editor.s.camera.toScreen({
          x: bounds.x + bounds.width / 2,
          y: bounds.y + bounds.height / 2,
        });
        return { x, y };
      }, far);
      await page.mouse.click(centre.x, centre.y, { button: "right" });
      await page.getByRole("menuitem", { name: /^Copy link to selection/ }).click();
      await expect.poll(clipboard).toBe(selectionUrl);

      await pageRows(page).nth(0).click({ button: "right" });
      await page.getByRole("menuitem", { name: "Copy link to page" }).click();
      await expect.poll(clipboard).toBe(`${fileUrl}?page-id=${first}`);
      await expect(pageRows(page).nth(1)).toHaveAttribute("aria-current", "page");

      await page.keyboard.press("ControlOrMeta+l");
      await expect.poll(clipboard).toBe(selectionUrl);
    });

    test("Back skips page and selection changes, and Forward restores the last target", async () => {
      await page.goto("/");
      const recent = page.getByRole("heading", { name: "Recent files" });
      await expect(recent).toBeVisible();
      await page.goto(fileUrl);
      await expect.poll(() => param(page, "page-id")).toBe(first);
      await pageRows(page).nth(1).click();
      await layer(page, near).click();
      await layer(page, far).click();
      await expect.poll(() => param(page, "node-id")).toBe(far);

      await page.goBack();
      await expect(recent).toBeVisible();
      await page.goForward();
      await expect(pageRows(page).nth(1)).toHaveAttribute("aria-current", "page");
      await expect(layer(page, far)).toHaveAttribute("aria-selected", "true");
    });

    test("keeps review, renderer and present and opens a linked comment", async () => {
      const thread = await page.evaluate(
        async ({ fileId, pageId }) => {
          const response = await fetch(`/api/files/${fileId}/comments`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ pageId, x: 40, y: 40, body: "Check this page." }),
          });
          if (!response.ok) throw new Error("Couldn't create test comment.");
          return ((await response.json()) as { thread: { id: string } }).thread.id;
        },
        { fileId: new URL(fileUrl).pathname.split("/").at(-1), pageId: first },
      );
      const options = "review=true&renderer=canvas&present=readback";
      await page.goto(`${fileUrl}?page-id=${second}&node-id=${far}&${options}&thread=${thread}`);
      await expect(page.getByRole("dialog", { name: /^Thread on/ })).toBeVisible();
      await expect(pageRows(page).nth(0)).toHaveAttribute("aria-current", "page");
      await expect.poll(() => param(page, "thread")).toBeNull();
      await expect.poll(() => param(page, "page-id")).toBe(first);
      await pageRows(page).nth(1).click();
      await layer(page, near).click();
      await expect.poll(() => param(page, "node-id")).toBe(near);
      expect(param(page, "review")).toBe("true");
      expect(param(page, "renderer")).toBe("canvas");
      expect(param(page, "present")).toBe("readback");
    });

    test("keeps the deep link through sign-in", async () => {
      const target = `${fileUrl}?page-id=${second}&node-id=${far}&renderer=canvas&present=readback`;
      await page.goto("/");
      await page.getByRole("button", { name: "Sign out" }).click();
      await expect(page).toHaveURL(/\/signin/);
      await page.goto(target);
      const url = new URL(target);
      await expect
        .poll(() => {
          const next = param(page, "next");
          if (!next) return null;
          const redirect = new URL(next, url);
          return { path: redirect.pathname, query: Object.fromEntries(redirect.searchParams) };
        })
        .toEqual({ path: url.pathname, query: Object.fromEntries(url.searchParams) });
      await page.getByRole("button", { name: "Continue with a passkey" }).click();
      await expect(layer(page, far)).toHaveAttribute("aria-selected", "true", { timeout: 15_000 });
      expect(param(page, "renderer")).toBe("canvas");
      expect(param(page, "present")).toBe("readback");
    });
  });
