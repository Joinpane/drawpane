/**
 * The inspector in depth, in a real browser: frame presets, the color picker
 * (solid, gradient, alpha), shadow color, per-corner radius, constraints that
 * follow a resize, and selection colors. Runs on its own throwaway instance.
 */
import { expect, type Page, test } from "@playwright/test";
import { freshInstance, type Instance } from "./fresh-instance";

type Debug = {
  s: { pageId: string; selection: string[] };
  createLayer(
    type: string,
    rect: { x: number; y: number; width: number; height: number },
    parent: string,
    props?: Record<string, unknown>,
  ): string | null;
  select(ids: string[]): void;
  doc: { get(id: string): { props: Record<string, unknown> } | undefined };
};

const props = (page: Page, id: string) =>
  page.evaluate(
    (id) => (window as unknown as { drawpane: Debug }).drawpane.doc.get(id)?.props ?? {},
    id,
  );

/** The design inspector, not the floating Selection Lens (which repeats a few fields). */
const panel = (page: Page) => page.getByRole("group", { name: "Properties" });

const select = (page: Page, ids: string[]) =>
  page.evaluate((ids) => (window as unknown as { drawpane: Debug }).drawpane.select(ids), ids);

test.describe
  .serial("Inspector", () => {
    test.skip(!!process.env.E2E_BASE_URL, "Needs its own local instance.");

    let instance: Instance;
    let page: Page;
    let frame: string;
    let card: string;

    test.beforeAll(async ({ browser }) => {
      test.setTimeout(180_000);
      instance = await freshInstance(browser, { port: 8793, inspectorPort: 9333 });
      page = instance.page;
      await page.evaluate(() => localStorage.setItem("drawpane:debug", "1"));
      await page.getByRole("button", { name: "New file" }).first().click();
      await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
        timeout: 15_000,
      });
    });

    test.afterAll(async () => {
      await instance?.stop();
    });

    test("adds a frame from a preset and switches its orientation", async () => {
      await page.keyboard.press("f");
      await page.getByRole("button", { name: /^iPhone 18 Pro 402/ }).click();
      frame = await page.evaluate(
        () => (window as unknown as { drawpane: Debug }).drawpane.s.selection[0] as string,
      );
      expect(await props(page, frame)).toMatchObject({
        name: "iPhone 18 Pro",
        width: 402,
        height: 874,
      });
      await expect(page.getByLabel("Frame size")).toHaveValue("iphone-18-pro");
      await page.getByRole("radio", { name: "Landscape" }).click();
      expect(await props(page, frame)).toMatchObject({ width: 874, height: 402 });
      await page.keyboard.press("ControlOrMeta+z");
      await expect.poll(async () => (await props(page, frame)).width).toBe(402);
    });

    test("edits a fill with the color picker, including alpha and a gradient", async () => {
      card = (await page.evaluate((frame) => {
        const e = (window as unknown as { drawpane: Debug }).drawpane;
        return e.createLayer("rect", { x: 40, y: 40, width: 200, height: 120 }, frame, {
          name: "Card",
          fills: [{ type: "solid", color: "#d9d9d6" }],
        });
      }, frame)) as string;
      await select(page, [card]);
      await page.getByRole("button", { name: "Edit fill" }).click();
      const picker = page.getByRole("dialog", { name: "Fill paint" });
      await picker.getByLabel("Fill hex").fill("rgba(43, 79, 214, 0.5)");
      await picker.getByLabel("Fill hex").press("Enter");
      await expect
        .poll(async () => (await props(page, card)).fills)
        .toEqual([{ type: "solid", color: "#2b4fd6", opacity: 0.5 }]);

      await picker.getByRole("radio", { name: "Gradient" }).click();
      await expect
        .poll(async () => ((await props(page, card)).fills as Array<{ type: string }>)[0]?.type)
        .toBe("linear");
      await picker.getByLabel("Gradient angle").fill("90");
      await picker.getByLabel("Gradient angle").press("Enter");
      await expect
        .poll(async () => ((await props(page, card)).fills as Array<{ from: unknown }>)[0]?.from)
        .toEqual({ x: 0, y: 0.5 });
      await page.keyboard.press("Escape");
      await expect(picker).toHaveCount(0);
      // Escape closed the picker, not the selection.
      await expect(page.getByRole("button", { name: "Edit fill" })).toBeVisible();
    });

    test("gives a shadow a color and spread", async () => {
      await panel(page).getByRole("button", { name: "Add effect" }).click();
      await panel(page).getByLabel("Shadow spread").fill("4");
      await panel(page).getByLabel("Shadow spread").press("Enter");
      await panel(page).getByLabel("Shadow hex").fill("ff5a1f");
      await panel(page).getByLabel("Shadow hex").press("Enter");
      await expect
        .poll(async () => (await props(page, card)).effects)
        .toEqual([{ type: "drop-shadow", color: "#ff5a1f40", x: 0, y: 4, blur: 12, spread: 4 }]);
    });

    test("rounds each corner on its own", async () => {
      await panel(page).getByLabel("Corner radius").fill("8");
      await panel(page).getByLabel("Corner radius").press("Enter");
      await panel(page).getByRole("button", { name: "Independent corners" }).click();
      await panel(page).getByLabel("Bottom right radius").fill("24");
      await panel(page).getByLabel("Bottom right radius").press("Enter");
      await expect.poll(async () => (await props(page, card)).cornerRadii).toEqual([8, 8, 24, 8]);
    });

    test("moves a layer by its constraints when its frame resizes", async () => {
      await page.getByRole("button", { name: "Pin to right" }).click();
      await page.getByRole("button", { name: "Pin to bottom" }).click();
      await expect.poll(async () => (await props(page, card)).constraintH).toBe("end");
      const before = await props(page, card);
      await select(page, [frame]);
      await panel(page).getByLabel("Width").fill("502");
      await panel(page).getByLabel("Width").press("Enter");
      // 100 wider: pinned right, the card moves 100; pinned bottom, the height didn't change.
      await expect.poll(async () => (await props(page, card)).x).toBe((before.x as number) + 100);
      expect((await props(page, card)).y).toBe(before.y);
    });

    test("recolors everything in a selection at once", async () => {
      const second = (await page.evaluate((frame) => {
        const e = (window as unknown as { drawpane: Debug }).drawpane;
        return e.createLayer("ellipse", { x: 40, y: 300, width: 40, height: 40 }, frame, {
          fills: [{ type: "solid", color: "#ffffff" }],
        });
      }, frame)) as string;
      await select(page, [frame]);
      const row = page.getByRole("button", { name: "Change FFFFFF everywhere in the selection" });
      await expect(row).toBeVisible();
      const hex = page.getByLabel("Selection color hex").first();
      await hex.fill("101010");
      await hex.press("Enter");
      await expect
        .poll(async () => (await props(page, second)).fills)
        .toEqual([{ type: "solid", color: "#101010" }]);
      expect((await props(page, frame)).fills).toEqual([{ type: "solid", color: "#101010" }]);
    });
  });
