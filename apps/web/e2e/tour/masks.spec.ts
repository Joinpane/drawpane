/**
 * Screenshots of masks for design review, in both themes: a mask group on the
 * canvas, its layers tagged in the panel, and the inspector's Mask switch.
 * Run with `pnpm --filter @drawpane/web tour`.
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
  toggleMask(): void;
  zoomToFit(): void;
};

test("masks tour", async ({ browser }) => {
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

  const circle = await page.evaluate(() => {
    const e = (window as unknown as { drawpane: Debug }).drawpane;
    const p = e.s.pageId;
    const c = e.createLayer("ellipse", { x: 60, y: 60, width: 240, height: 240 }, p, {
      name: "Avatar mask",
    }) as string;
    const photo = e.createLayer("rect", { x: 0, y: 0, width: 360, height: 360 }, p, {
      name: "Portrait",
      fills: [
        {
          type: "linear",
          from: { x: 0, y: 0 },
          to: { x: 1, y: 1 },
          stops: [
            { position: 0, color: "#ffb38a" },
            { position: 1, color: "#e04f1a" },
          ],
        },
      ],
    }) as string;
    const badge = e.createLayer("ellipse", { x: 230, y: 230, width: 64, height: 64 }, p, {
      name: "Status",
      fills: [{ type: "solid", color: "#1d7a52" }],
    }) as string;
    e.select([c, photo, badge]);
    e.toggleMask();
    e.zoomToFit();
    return c;
  });
  await page.evaluate(
    (id) => (window as unknown as { drawpane: Debug }).drawpane.select([id]),
    circle,
  );
  await shot(page, "95-mask");
});
