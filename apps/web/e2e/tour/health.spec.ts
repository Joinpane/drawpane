/**
 * Screenshots of the instance admin's health and cost page for design review,
 * in both themes: at a laptop's width and a narrow window, plus the dashboard
 * header at 1024 wide, where its secondary actions go icon-only.
 * Run with `pnpm --filter @drawpane/web tour`.
 */
import { expect } from "@playwright/test";
import { passkey, shot, test } from "./harness";

test("health tour", async ({ browser }) => {
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

  // Whoever set the instance up runs it: the bolt in the user menu leads here.
  await page.getByRole("link", { name: "Instance health and cost" }).click();
  const glance = page.getByRole("region", { name: "At a glance" });
  await expect(glance).toHaveAttribute("aria-busy", "false");
  await shot(page, "152-health");

  await page.setViewportSize({ width: 560, height: 900 });
  await shot(page, "153-health-narrow");

  await page.setViewportSize({ width: 1024, height: 768 });
  await page.getByRole("link", { name: "Files" }).click();
  await expect(page.getByRole("heading", { name: "Recent files" })).toBeVisible();
  await shot(page, "154-dashboard-1024");
  await context.close();
});
