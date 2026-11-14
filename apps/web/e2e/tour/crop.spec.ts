/**
 * Screenshots of cropping for design review, in both themes: the crop
 * session on the canvas, and the image tab's crop preview.
 * Run with `pnpm --filter @drawpane/web tour`.
 */
import { expect } from "@playwright/test";
import { dropImage } from "../fresh-instance";
import { passkey, shot, test } from "./harness";

test("crop tour", async ({ browser }) => {
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

  await dropImage(
    page,
    { x: 720, y: 450 },
    {
      name: "landscape.png",
      width: 480,
      height: 300,
      colors: ["#2b4fd6", "#6b95ff", "#f5b400", "#ff5a1f"],
    },
  );
  await expect(page.getByRole("region", { name: "Image uploads" })).toContainText("Done");
  await page.mouse.dblclick(720, 450);
  await expect(page.getByRole("toolbar", { name: "Crop" })).toBeVisible();
  // Crop in from the right and the bottom.
  await page.mouse.move(960, 600);
  await page.mouse.down();
  await page.mouse.move(880, 560, { steps: 6 });
  await page.mouse.up();
  await page.mouse.move(800, 500);
  await shot(page, "96-crop");

  await page.getByRole("button", { name: "Done" }).click();
  await page
    .getByRole("group", { name: "Properties" })
    .getByRole("button", { name: "Edit fill" })
    .click();
  await expect(page.getByRole("dialog", { name: "Fill paint" })).toBeVisible();
  await page.waitForTimeout(300);
  await shot(page, "97-crop-preview");
});
