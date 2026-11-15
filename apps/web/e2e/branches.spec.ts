/**
 * Branches in a real browser (decision 0012): make a branch from the title
 * bar, change it, review and merge it into main (with a restore point), then
 * resolve a conflict with main edited in another tab. Runs on its own
 * throwaway instance.
 */
import { expect, type Page, test } from "@playwright/test";
import { freshInstance, type Instance } from "./fresh-instance";

type Debug = {
  s: { pageId: string };
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

const fillOf = (page: Page, id: string) =>
  page.evaluate(
    (id) =>
      (
        (window as unknown as { drawpane: Debug }).drawpane.doc.get(id)?.props.fills as
          | Array<{ color: string }>
          | undefined
      )?.[0]?.color ?? null,
    id,
  );

const setFill = (page: Page, id: string, color: string) =>
  page.evaluate(
    ({ id, color }) =>
      (window as unknown as { drawpane: Debug }).drawpane.commit([
        { op: "set", id, prop: "fills", value: [{ type: "solid", color }] },
      ]),
    { id, color },
  );

const settled = (page: Page) =>
  expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { drawpane: Debug }).drawpane.sync.pendingCount),
    )
    .toBe(0);

const live = (page: Page) =>
  expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({ timeout: 15_000 });

/** Makes a branch of the file open in `page`, from the title bar, and waits for it to open. */
async function makeBranch(page: Page, name: string) {
  await page.getByRole("button", { name: "Branches" }).click();
  const menu = page.getByRole("dialog", { name: "Branches" });
  await menu.getByLabel(/New branch from/).fill(name);
  await menu.getByRole("button", { name: "Make branch" }).click();
  await expect(page.locator(".branch-chip")).toHaveText(name);
  await live(page);
}

test.describe
  .serial("Branches", () => {
    test.skip(!!process.env.E2E_BASE_URL, "Needs its own local instance.");

    let instance: Instance;
    let page: Page;
    let mainUrl: string;
    let card: string;

    test.beforeAll(async ({ browser }) => {
      test.setTimeout(180_000);
      instance = await freshInstance(browser, { port: 8901, inspectorPort: 9441 });
      page = instance.page;
      await page.evaluate(() => localStorage.setItem("drawpane:debug", "1"));
    });

    test.afterAll(async () => {
      await instance?.stop();
    });

    test("makes a branch from the title bar", async () => {
      await page.getByRole("button", { name: "New file" }).first().click();
      await live(page);
      mainUrl = page.url();
      card = await page.evaluate(() => {
        const e = (window as unknown as { drawpane: Debug }).drawpane;
        return e.createLayer("rect", { x: 0, y: 0, width: 200, height: 120 }, e.s.pageId, {
          name: "Card",
          fills: [{ type: "solid", color: "#e5484d" }],
        }) as string;
      });
      await settled(page);

      await makeBranch(page, "Blue card");
      expect(page.url()).not.toBe(mainUrl);
      // The title leads back to main; the branch has main's content.
      await expect(page.locator(".file-title__main")).toHaveText("Untitled");
      await expect.poll(() => fillOf(page, card)).toBe("#e5484d");
    });

    test("reviews the branch's changes and merges them into main", async () => {
      await setFill(page, card, "#3e63dd");
      await page.evaluate(() => {
        const e = (window as unknown as { drawpane: Debug }).drawpane;
        e.createLayer("rect", { x: 240, y: 0, width: 80, height: 40 }, e.s.pageId, {
          name: "Badge",
        });
      });
      await settled(page);

      await page.getByRole("button", { name: "Merge", exact: true }).click();
      const changes = page.getByRole("complementary", { name: "Branch review" });
      await expect(changes.getByText("Fill #e5484d → #3e63dd")).toBeVisible();
      await expect(changes.getByText("Badge")).toBeVisible();
      const merge = page.getByRole("complementary", { name: "Merge" });
      await expect(merge.getByText("No conflicts with main")).toBeVisible();

      // Main and the branch side by side, the changes numbered as listed: a change on both
      // sides, an addition on the branch's only.
      const compare = page.getByRole("toolbar", { name: "Compare with main" });
      await expect(page.getByRole("button", { name: /^Change 1: Card/ })).toHaveCount(2);
      await expect(page.getByRole("button", { name: /^Change 2: Badge/ })).toHaveCount(1);
      await compare.getByRole("radio", { name: "Swipe" }).click();
      const swipe = page.getByRole("slider", { name: "Swipe between main and the branch" });
      await swipe.focus();
      await page.keyboard.press("ArrowRight");
      await expect(swipe).toHaveAttribute("aria-valuenow", "52");
      await compare.getByRole("radio", { name: "Side by side" }).click();
      await merge.getByRole("button", { name: "Merge into Untitled" }).click();

      const toast = page
        .getByRole("alert")
        .filter({ hasText: "Merged “Blue card” into Untitled." });
      await expect(toast).toBeVisible();
      // History now: read-only.
      await expect(page.locator(".branch-chip")).toContainText("Merged");
      await expect(page.getByRole("button", { name: "Merge", exact: true })).toHaveCount(0);

      await toast.getByRole("button", { name: "Open Untitled" }).click();
      await live(page);
      await expect.poll(() => fillOf(page, card)).toBe("#3e63dd");
      // The merge can be undone from History: main kept a restore point.
      await page.getByRole("radio", { name: "History" }).click();
      await expect(page.getByRole("option", { name: /Before merging “Blue card”/ })).toBeVisible();
      await page.getByRole("radio", { name: "Layers" }).click();
    });

    test("asks which side to keep when main changed the same thing", async () => {
      await makeBranch(page, "Green card");
      await setFill(page, card, "#30a46c");
      await settled(page);

      // Meanwhile, someone changes the card on main.
      const other = await instance.context.newPage();
      await other.goto(mainUrl);
      await live(other);
      await setFill(other, card, "#ffb224");
      await settled(other);

      await page.getByRole("button", { name: "Merge", exact: true }).click();
      const changes = page.getByRole("complementary", { name: "Branch review" });
      const merge = page.getByRole("complementary", { name: "Merge" });
      await expect(merge.getByText("1 conflict to resolve")).toBeVisible();
      const button = merge.getByRole("button", { name: "Merge into Untitled" });
      await expect(button).toBeDisabled();
      await expect(changes.getByText("Fill #ffb224")).toBeVisible();
      await changes.getByText("Keep this branch").click();
      await expect(merge.getByText("1 conflict resolved")).toBeVisible();
      await button.click();

      // The other tab, on main, sees it arrive and hears who merged what.
      await expect.poll(() => fillOf(other, card)).toBe("#30a46c");
      await expect(other.getByRole("alert")).toContainText("merged “Green card” into this file");
      await other.close();
    });

    test("brings main's latest changes into the branch", async () => {
      await page.goto(mainUrl);
      await live(page);
      await makeBranch(page, "Purple card");
      await setFill(page, card, "#8e4ec6");
      await settled(page);

      // Meanwhile, someone adds a footer on main.
      const other = await instance.context.newPage();
      await other.goto(mainUrl);
      await live(other);
      const footer = await other.evaluate(() => {
        const e = (window as unknown as { drawpane: Debug }).drawpane;
        return e.createLayer("rect", { x: 0, y: 200, width: 320, height: 40 }, e.s.pageId, {
          name: "Footer",
        }) as string;
      });
      await settled(other);
      await other.close();

      await page.getByRole("button", { name: "Merge", exact: true }).click();
      const merge = page.getByRole("complementary", { name: "Merge" });
      await expect(merge.getByText("Untitled has moved on")).toBeVisible();
      await page.screenshot({ path: "/tmp/br-shot-update.png" }).catch(() => {});
      await merge.getByRole("button", { name: "Update from Untitled" }).click();
      await expect(page.getByRole("alert")).toContainText("Brought in 1 change from Untitled.");
      await expect(merge.getByText("Up to date with Untitled")).toBeVisible();
      // The footer is on the branch now, and the branch's own change is still its only one.
      await expect
        .poll(() =>
          page.evaluate(
            (id) => !!(window as unknown as { drawpane: Debug }).drawpane.doc.get(id),
            footer,
          ),
        )
        .toBe(true);
      const changes = page.getByRole("complementary", { name: "Branch review" });
      await expect(changes.getByText("Fill #30a46c → #8e4ec6")).toBeVisible();
      await expect(changes.getByText("Footer")).toHaveCount(0);
    });
  });
