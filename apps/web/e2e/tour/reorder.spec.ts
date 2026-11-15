/**
 * Screenshots of reordering a layer's fills and effects, for design review:
 * a fill row lifted mid-drag with the others making room, and the grip an
 * effect row shows while hovered, in both themes. Run with
 * `pnpm --filter @drawpane/web tour`.
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

test("reorder tour", async ({ browser }) => {
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

  await page.evaluate(() => {
    const e = (window as unknown as { drawpane: Debug }).drawpane;
    const card = e.createLayer("rect", { x: 0, y: 0, width: 360, height: 220 }, e.s.pageId, {
      name: "Card",
      cornerRadius: 24,
      fills: [
        { type: "solid", color: "#f4efe6" },
        {
          type: "linear",
          from: { x: 0, y: 0 },
          to: { x: 1, y: 1 },
          stops: [
            { position: 0, color: "#ff7a4580" },
            { position: 1, color: "#3d7bf080" },
          ],
        },
        { type: "solid", color: "#1c1b1a14" },
      ],
      effects: [
        { type: "drop-shadow", x: 0, y: 12, blur: 32, spread: -8, color: "#1c1b1a33" },
        { type: "inner-shadow", x: 0, y: 1, blur: 0, spread: 0, color: "#ffffff80" },
        { type: "background-blur", radius: 12 },
      ],
    }) as string;
    e.select([card]);
    e.zoomToFit();
  });

  const panel = page.getByRole("group", { name: "Properties" });
  const fills = panel.getByRole("region", { name: "Fill" });
  const rows = fills.locator(".paint-row");
  await expect(rows).toHaveCount(3);

  // The top fill, picked up and carried past the middle one.
  const top = await rows.nth(0).getByRole("button", { name: "Edit fill" }).boundingBox();
  const middle = await rows.nth(1).boundingBox();
  if (!top || !middle) throw new Error("no fill rows");
  await page.mouse.move(top.x + top.width / 2, top.y + top.height / 2);
  await page.mouse.down();
  await page.mouse.move(top.x + top.width / 2, middle.y + middle.height - 2, { steps: 10 });
  await expect(rows.nth(0)).toHaveAttribute("data-reorder", "dragging");
  await shot(page, "175-reorder-fill-drag", panel);
  await page.mouse.up();

  // An effect row's grip, shown while hovered.
  await panel
    .getByRole("region", { name: "Effects" })
    .locator(".item-row")
    .nth(1)
    .hover({ position: { x: 120, y: 12 } });
  await shot(page, "176-reorder-effect-grip", panel);
  await context.close();
});
