/**
 * New files from sizes and templates in a real browser, on a throwaway
 * instance: the Templates page (and Esc back), a phone frame, a custom size,
 * a built-in template (with its preview, auto layout, text styles and
 * colours), duplicating a file, and starting from a team template.
 */
import { expect, type Page, test } from "@playwright/test";
import { freshInstance, type Instance } from "./fresh-instance";

type Node = { id: string; type: string; parent: string; props: Record<string, unknown> };
type W = { drawpane: { s: { status: string }; doc: { nodes(): Iterable<Node> } } };

const nodes = (page: Page) =>
  page.evaluate(() => [...(window as unknown as W).drawpane.doc.nodes()].map((n) => ({ ...n })));

/** Waits for the editor to open a live file. */
async function opened(page: Page) {
  await page.waitForURL(/\/f\//);
  await expect
    .poll(() => page.evaluate(() => (window as unknown as W).drawpane?.s.status ?? null), {
      timeout: 20_000,
    })
    .toBe("live");
}

test.describe
  .serial("New file", () => {
    test.skip(!!process.env.E2E_BASE_URL, "Needs its own local instance.");
    let instance: Instance;
    let page: Page;
    let dashboard: string;

    test.beforeAll(async ({ browser }) => {
      test.setTimeout(180_000);
      instance = await freshInstance(browser, { port: 8827, inspectorPort: 9367 });
      page = instance.page;
      await page.evaluate(() => localStorage.setItem("drawpane:debug", "1"));
      dashboard = page.url();
    });
    test.afterAll(async () => {
      await instance?.stop();
    });

    test("opens the templates page, and Esc goes back", async () => {
      await page.getByRole("button", { name: "Templates" }).click();
      await expect(page.getByRole("heading", { name: "Start with a blank pane" })).toBeVisible();
      await page.keyboard.press("Escape");
      // Back to the project it was opened from.
      await expect(page.getByRole("heading", { name: "Drafts" })).toBeVisible();
    });

    test("starts a file with a phone frame", async () => {
      await page.getByRole("button", { name: "Templates" }).click();
      await page.getByRole("button", { name: /^Phone/ }).click();
      await opened(page);
      const frame = (await nodes(page)).find((n) => n.type === "frame");
      expect(frame?.props).toMatchObject({ name: "iPhone 18 Pro", width: 402, height: 874 });
    });

    test("starts a file with a custom size", async () => {
      await page.goto(dashboard);
      await page.getByRole("button", { name: "Templates" }).click();
      await page.getByRole("button", { name: /^Custom/ }).click();
      await page.getByLabel("Width").fill("1280");
      await page.getByLabel("Height").fill("800");
      await page.getByRole("button", { name: "Create" }).click();
      await opened(page);
      const frame = (await nodes(page)).find((n) => n.type === "frame");
      expect(frame?.props).toMatchObject({ width: 1280, height: 800 });
    });

    test("starts from a built-in template, laid out and styled", async () => {
      await page.goto(dashboard);
      await page.getByRole("button", { name: "Templates" }).click();
      const card = page.getByRole("button", { name: /^Mobile app/ });
      // The preview is drawn from the template itself.
      await expect(card.locator("img")).toBeVisible({ timeout: 15_000 });
      await card.click();
      await opened(page);
      const all = await nodes(page);
      const frames = all.filter(
        (n) => n.type === "frame" && ["Welcome", "Today", "Profile"].includes(String(n.props.name)),
      );
      expect(frames).toHaveLength(3);
      expect(all.some((n) => n.type === "textStyle" && n.props.name === "heading/xl")).toBe(true);
      expect(all.some((n) => n.type === "variable" && n.props.name === "brand/primary")).toBe(true);
      // Auto layout placed the tasks one under another.
      const list = all.find((n) => n.props.name === "Tasks");
      const ys = all
        .filter((n) => n.parent === list?.id)
        .map((n) => Number(n.props.y))
        .sort((a, b) => a - b);
      expect(ys).toHaveLength(4);
      expect(new Set(ys).size).toBe(4);
    });

    test("duplicates a file, and makes a team template to start from", async () => {
      await page.goto(dashboard);
      const card = page.getByRole("listitem").filter({ hasText: "Mobile app" }).first();
      await card.getByRole("button", { name: /^Options for/ }).click();
      await page.getByRole("menuitem", { name: "Duplicate" }).click();
      await expect(page.getByText("Mobile app (copy)")).toBeVisible();

      await card.getByRole("button", { name: /^Options for/ }).click();
      await page.getByRole("menuitem", { name: "Make a template" }).click();
      await expect(card.getByText("Template", { exact: true })).toBeVisible();

      await page.getByRole("button", { name: "Templates" }).click();
      await page.getByRole("radio", { name: /team/ }).click();
      await page.getByRole("button", { name: /^Mobile app/ }).click();
      await opened(page);
      expect((await nodes(page)).filter((n) => n.props.name === "Welcome")).toHaveLength(1);
    });
  });
