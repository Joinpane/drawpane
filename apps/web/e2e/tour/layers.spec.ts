/**
 * Screenshots of the layers panel for design review, in both themes: row
 * states (auto layout, components, masks, hidden, locked), finding layers
 * with a filter, and the status line while dragging.
 * Run with `pnpm --filter @drawpane/web tour`.
 */
import { expect } from "@playwright/test";
import { passkey, shot, test } from "./harness";

type W = {
  drawpane: {
    createLayer(
      type: string,
      rect: { x: number; y: number; width: number; height: number },
      parent: string,
      props?: Record<string, unknown>,
    ): string | null;
    select(ids: string[]): void;
    zoomTo(z: number): void;
    s: {
      pageId: string;
      camera: { toScreen(p: { x: number; y: number }): { x: number; y: number } };
    };
  };
};

test("layers tour", async ({ browser }) => {
  test.setTimeout(120_000);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await passkey(context, page);
  await page.goto("/setup");
  await page.evaluate(() => localStorage.setItem("drawpane:debug", "1"));
  await page.getByLabel("Your name").fill("Ana Lima");
  await page.getByLabel("Email").fill("ana@example.com");
  await page.getByLabel("Setup token").fill(process.env.E2E_SETUP_TOKEN ?? "e2e-setup-token");
  await page.getByRole("button", { name: "Create account with a passkey" }).click();
  await expect(page.getByRole("heading", { name: "Recent files" })).toBeVisible();
  await page.getByRole("button", { name: "New file" }).first().click();
  await expect(page.getByRole("status")).toContainText("Saved", { timeout: 15_000 });

  await page.evaluate(() => {
    const e = (window as unknown as W).drawpane as unknown as {
      s: { pageId: string };
      createLayer(t: string, r: object, p: string, props?: object): string;
      select(ids: string[]): void;
      createComponent(): void;
    };
    const p = e.s.pageId;
    const fill = (color: string) => ({ fills: [{ type: "solid", color }] });
    const home = e.createLayer("frame", { x: 0, y: 0, width: 393, height: 852 }, p, {
      name: "Home — iOS",
      ...fill("#ffffff"),
    });
    const list = e.createLayer("frame", { x: 16, y: 120, width: 361, height: 300 }, home, {
      name: "Upcoming",
      layoutMode: "column",
      gap: 8,
    });
    for (const title of ["Design review", "Token audit", "Icon review"])
      e.createLayer("text", { x: 0, y: 0, width: 200, height: 24 }, list, {
        name: "Event row",
        characters: title,
      });
    e.createLayer("text", { x: 16, y: 60, width: 300, height: 40 }, home, {
      name: "Greeting",
      characters: "Good morning, Ana",
      fontSize: 28,
    });
    e.createLayer("rect", { x: 16, y: 700, width: 361, height: 60 }, home, {
      name: "Tab bar",
      locked: true,
      ...fill("#f1f2f4"),
    });
    const old = e.createLayer("frame", { x: 16, y: 440, width: 361, height: 80 }, home, {
      name: "Old header",
      visible: false,
    });
    e.createLayer("text", { x: 24, y: 450, width: 200, height: 24 }, old, {
      name: "Old title",
      characters: "Welcome",
    });
    const card = e.createLayer("frame", { x: 500, y: 0, width: 240, height: 140 }, p, {
      name: "Hero card",
      ...fill("#e6ebfb"),
    });
    e.select([card]);
    e.createComponent();
    e.select([list]);
  });
  await page.keyboard.press("Shift+1");
  await page.waitForTimeout(300);
  await shot(page, "110-layers-states");

  await page.keyboard.press("ControlOrMeta+f");
  await page.keyboard.type("row");
  await page.getByRole("radio", { name: "Text" }).click();
  await page.waitForTimeout(200);
  await shot(page, "111-layers-find");
  await page.keyboard.press("Escape");

  const tree = page.getByRole("tree", { name: "Layers" });
  await tree.getByRole("treeitem", { name: /^Greeting/ }).hover();
  await page.mouse.down();
  await tree.getByRole("treeitem", { name: /^Hero card/ }).hover();
  await tree.getByRole("treeitem", { name: /^Hero card/ }).hover();
  await page.waitForTimeout(200);
  await shot(page, "112-layers-drag");
  await page.mouse.up();
  await context.close();
});
