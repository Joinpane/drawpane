/**
 * Screenshots of Keyboard shortcuts in Settings for design review, in both
 * themes: the list, recording a new one, and the question when another
 * command has it. Run with `pnpm --filter @drawpane/web tour`.
 */
import { expect } from "@playwright/test";
import { passkey, shot, test } from "./harness";

test("keyboard shortcuts tour", async ({ browser }) => {
  test.setTimeout(120_000);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await passkey(context, page);
  await page.goto("/setup");
  await page.getByLabel("Your name").fill("Ana Lima");
  await page.getByLabel("Email").fill("ana@example.com");
  await page.getByLabel("Setup token").fill(process.env.E2E_SETUP_TOKEN ?? "e2e-setup-token");
  await page.getByRole("button", { name: "Create account with a passkey" }).click();
  await expect(page.getByRole("heading", { name: "Recent files" })).toBeVisible();

  await page.goto("/settings/shortcuts");
  await expect(page.getByRole("heading", { name: "Keyboard shortcuts" })).toBeVisible();
  await shot(page, "159-shortcuts");

  const rect = page.getByRole("button", { name: /shortcut for Rectangle/ });
  await rect.click();
  await shot(page, "160-shortcuts-recording");
  await page.keyboard.press("v");
  await expect(page.getByRole("alert")).toContainText("Replace it?");
  await shot(page, "161-shortcuts-taken");
  await context.close();
});
