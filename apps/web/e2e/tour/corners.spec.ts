/**
 * Screenshots of corner smoothing for design review, in both themes: plain
 * and smoothed corners side by side (app icons, a card, a button, a stroked
 * field), and the Corner smoothing control with its iOS stop. Run with
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
  zoomTo(z: number): void;
  centerOn(p: { x: number; y: number }): void;
};

test("corner smoothing tour", async ({ browser }) => {
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

  const card = await page.evaluate(() => {
    const e = (window as unknown as { drawpane: Debug }).drawpane;
    const p = e.s.pageId;
    const fill = (color: string) => [{ type: "solid", color }];
    let card = "";
    // Each row: plain corners on the left, iOS's 60% smoothing on the right.
    for (const [col, smoothing] of [
      [0, 0],
      [1, 0.6],
    ] as const) {
      const x = col * 360;
      const s = smoothing > 0 ? { cornerSmoothing: smoothing } : {};
      for (const [i, color] of ["#2b4fd6", "#e8590c", "#1c1b1a"].entries())
        e.createLayer("rect", { x: x + i * 104, y: 0, width: 88, height: 88 }, p, {
          name: "App icon",
          cornerRadius: 20,
          fills: fill(color),
          ...s,
        });
      const c = e.createLayer("rect", { x, y: 120, width: 296, height: 160 }, p, {
        name: "Card",
        cornerRadius: 32,
        fills: fill("#ffffff"),
        effects: [{ type: "drop-shadow", color: "#1c1b1a29", x: 0, y: 8, blur: 24, spread: 0 }],
        ...s,
      }) as string;
      if (smoothing > 0) card = c;
      e.createLayer("rect", { x, y: 312, width: 296, height: 52 }, p, {
        name: "Button",
        cornerRadius: 14,
        fills: fill("#2b4fd6"),
        ...s,
      });
      e.createLayer("rect", { x, y: 388, width: 296, height: 52 }, p, {
        name: "Field",
        cornerRadius: 14,
        fills: fill("#ffffff"),
        strokes: fill("#1c1b1a"),
        strokeWeight: 2,
        ...s,
      });
    }
    e.select([]);
    e.zoomTo(1.5);
    e.centerOn({ x: 328, y: 220 });
    return card;
  });

  // Plain corners (left) against smoothed ones (right).
  await shot(page, "95-corner-smoothing-canvas", page.locator(".canvas"));

  // The smoothed card selected: the Corner smoothing control under the radius.
  await page.evaluate(
    (id) => (window as unknown as { drawpane: Debug }).drawpane.select([id]),
    card,
  );
  await shot(page, "96-corner-smoothing-inspector");
  await shot(
    page,
    "97-corner-smoothing-control",
    page.getByRole("group", { name: "Properties" }).locator(".inspector__smoothing"),
  );
});
