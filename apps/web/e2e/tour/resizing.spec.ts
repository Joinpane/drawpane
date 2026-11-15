/**
 * Screenshots of the Resizing section, for design review: an item that hugs
 * one way and fills the other, with each axis's limits hanging from its row,
 * unset and then set, in both themes. Run with `pnpm --filter @drawpane/web tour`.
 */
import { expect } from "@playwright/test";
import { passkey, shot, test } from "./harness";

type Debug = {
  s: { pageId: string };
  createLayer(
    type: string,
    rect: { x: number; y: number; width: number; height: number },
    parent: string,
    props?: Record<string, unknown>,
  ): string | null;
  select(ids: string[]): void;
  zoomToFit(): void;
};

test("resizing tour", async ({ browser }) => {
  test.setTimeout(180_000);
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

  const item = (await page.evaluate(() => {
    const e = (window as unknown as { drawpane: Debug }).drawpane;
    const column = e.createLayer("frame", { x: 0, y: 0, width: 360, height: 480 }, e.s.pageId, {
      name: "Tasks",
      layoutMode: "column",
      fills: [{ type: "solid", color: "#f4efe6" }],
    }) as string;
    const card = e.createLayer("frame", { x: 0, y: 0, width: 200, height: 120 }, column, {
      name: "Card",
      sizingH: "fill",
      sizingV: "hug",
      fills: [{ type: "solid", color: "#ffffff" }],
    }) as string;
    e.select([card]);
    e.zoomToFit();
    return card;
  })) as string;

  const panel = page.getByRole("group", { name: "Properties" });
  const section = panel.getByRole("region", { name: "Resizing" });
  await expect(section.getByRole("group", { name: "Width limits" })).toBeVisible();
  await shot(page, "179-resizing-limits-unset", section);

  // Set limits read as values, in the ink of the field's text.
  await section.getByRole("spinbutton", { name: "Max width" }).fill("480");
  await section.getByRole("spinbutton", { name: "Max width" }).press("Enter");
  await section.getByRole("spinbutton", { name: "Min height" }).fill("64");
  await section.getByRole("spinbutton", { name: "Min height" }).press("Enter");
  await page.evaluate((id) => {
    (document.activeElement as HTMLElement | null)?.blur();
    (window as unknown as { drawpane: Debug }).drawpane.select([id]);
  }, item);
  await shot(page, "180-resizing-limits-set", section);
  await context.close();
});
