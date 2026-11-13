/**
 * Version history in a real browser: name a version, change the file, look
 * at the version, restore one layer (and undo it), then restore the whole
 * file (and undo that from the toast). Runs on its own throwaway instance.
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
  commit(ops: unknown[], label?: string): boolean;
  doc: { get(id: string): { props: Record<string, unknown> } | undefined };
  sync: { pendingCount: number };
};
const debug = "drawpane";

const fillOf = (page: Page, id: string) =>
  page.evaluate(
    ({ id, debug }) =>
      (
        ((window as unknown as Record<string, Debug>)[debug] as Debug).doc.get(id)?.props.fills as
          | Array<{ color: string }>
          | undefined
      )?.[0]?.color ?? null,
    { id, debug },
  );

const settled = (page: Page) =>
  expect
    .poll(() =>
      page.evaluate(
        (debug) => ((window as unknown as Record<string, Debug>)[debug] as Debug).sync.pendingCount,
        debug,
      ),
    )
    .toBe(0);

test.describe
  .serial("Version history", () => {
    test.skip(!!process.env.E2E_BASE_URL, "Needs its own local instance.");

    let instance: Instance;
    let page: Page;
    let card: string;

    test.beforeAll(async ({ browser }) => {
      test.setTimeout(180_000);
      instance = await freshInstance(browser, { port: 8799, inspectorPort: 9339 });
      page = instance.page;
      await page.evaluate(() => localStorage.setItem("drawpane:debug", "1"));
    });

    test.afterAll(async () => {
      await instance?.stop();
    });

    test("names a version of the file as it is now", async () => {
      await page.getByRole("button", { name: "New file" }).first().click();
      await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
        timeout: 15_000,
      });
      card = await page.evaluate((debug) => {
        const e = (window as unknown as Record<string, Debug>)[debug] as Debug;
        return e.createLayer("rect", { x: 0, y: 0, width: 200, height: 120 }, e.s.pageId, {
          name: "Card",
          fills: [{ type: "solid", color: "#e5484d" }],
        }) as string;
      }, debug);
      await settled(page);

      await page.getByRole("radio", { name: "History" }).click();
      await expect(page.getByText("No saved versions yet")).toBeVisible();
      await page.getByRole("button", { name: "Name this version" }).click();
      await page.getByLabel("Name", { exact: true }).fill("Red card");
      await page.getByRole("button", { name: "Save version" }).click();
      await expect(page.getByRole("option", { name: /^Red card/ })).toBeVisible();

      // Change the file after the version.
      await page.evaluate(
        ({ id, debug }) =>
          ((window as unknown as Record<string, Debug>)[debug] as Debug).commit([
            { op: "set", id, prop: "fills", value: [{ type: "solid", color: "#3e63dd" }] },
            { op: "set", id, prop: "name", value: "Blue card" },
          ]),
        { id: card, debug },
      );
      await settled(page);
      expect(await fillOf(page, card)).toBe("#3e63dd");
    });

    test("shows a version read-only and restores one layer as an undoable edit", async () => {
      await page.getByRole("option", { name: /^Red card/ }).click();
      await expect(page.getByRole("status").filter({ hasText: "read-only" })).toContainText(
        "Viewing Red card",
      );
      // The layers tab shows the version's layers.
      await page.getByRole("radio", { name: "Layers" }).click();
      await page.getByRole("treeitem", { name: /^Card/ }).click();
      await expect(page.getByText("“Card” as it was in this version.")).toBeVisible();

      await page.getByRole("button", { name: "Restore layer" }).click();
      const toast = page.getByRole("alert").filter({ hasText: "Restored “Card”" });
      await expect(toast).toBeVisible();
      expect(await fillOf(page, card)).toBe("#e5484d");

      // "Show" goes back to now with the layer selected; undo takes the restore back.
      await toast.getByRole("button", { name: "Show" }).click();
      await expect(page.getByRole("status").filter({ hasText: "read-only" })).toHaveCount(0);
      expect(
        await page.evaluate(
          (debug) => ((window as unknown as Record<string, Debug>)[debug] as Debug).s.selection,
          debug,
        ),
      ).toEqual([card]);
      await page.keyboard.press("ControlOrMeta+z");
      await expect.poll(() => fillOf(page, card)).toBe("#3e63dd");
    });

    test("restores the whole file, and undoes it from the toast", async () => {
      await page.getByRole("radio", { name: "History" }).click();
      await page.getByRole("option", { name: /^Red card/ }).click();
      await page.getByRole("button", { name: "Restore this version" }).click();
      await page.getByRole("button", { name: "Restore version" }).click();

      const toast = page.getByRole("alert").filter({ hasText: "Restored “Red card”" });
      await expect(toast).toBeVisible();
      await expect.poll(() => fillOf(page, card)).toBe("#e5484d");
      // The state before the restore was saved first.
      await expect(page.getByRole("option", { name: /Before restoring “Red card”/ })).toBeVisible();

      await toast.getByRole("button", { name: "Undo" }).click();
      await expect.poll(() => fillOf(page, card)).toBe("#3e63dd");
    });

    test("Escape goes back to now", async () => {
      await page.getByRole("option", { name: /^Red card/ }).click();
      await expect(page.getByRole("status").filter({ hasText: "read-only" })).toBeVisible();
      await page.locator(".canvas__overlay").click({ position: { x: 600, y: 700 } });
      await page.keyboard.press("Escape");
      await expect(page.getByRole("status").filter({ hasText: "read-only" })).toHaveCount(0);
      await expect(page.getByRole("option", { name: /Current version/ })).toHaveAttribute(
        "aria-selected",
        "true",
      );
    });
  });
