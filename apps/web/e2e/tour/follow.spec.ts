/**
 * Screenshots of following and spotlight for design review, in both themes,
 * from a second person's browser. Run with `pnpm --filter @drawpane/web tour`.
 */
import { type Browser, expect } from "@playwright/test";
import { buildMobileApp } from "../prototype-fixture";
import { passkey, shot, test } from "./harness";

async function person(browser: Browser, path: string, name: string, token?: string) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await passkey(context, page);
  await page.goto(path);
  await page.evaluate(() => localStorage.setItem("drawpane:debug", "1"));
  await page.getByLabel("Your name").fill(name);
  await page.getByLabel("Email").fill(`${name.split(" ")[0]?.toLowerCase()}@example.com`);
  if (token) await page.getByLabel("Setup token").fill(token);
  await page.getByRole("button", { name: "Create account with a passkey" }).click();
  await expect(page.getByRole("heading", { name: "Recent files" })).toBeVisible();
  return page;
}

test("follow tour", async ({ browser }) => {
  test.setTimeout(180_000);
  const ana = await person(
    browser,
    "/setup",
    "Lena Park",
    process.env.E2E_SETUP_TOKEN ?? "e2e-setup-token",
  );
  await ana.getByRole("button", { name: "New file" }).first().click();
  await expect(ana.getByRole("status")).toContainText("Saved", { timeout: 15_000 });
  await buildMobileApp(ana);
  await ana.keyboard.press("Shift+1");
  const fileUrl = ana.url();
  const invite = await ana.evaluate(async () => {
    const { teams } = (await (await fetch("/api/teams")).json()) as { teams: { id: string }[] };
    const response = await fetch(`/api/teams/${teams[0]?.id}/invites`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: "editor" }),
    });
    return ((await response.json()) as { url: string }).url;
  });
  const bo = await person(browser, new URL(invite).pathname, "Sam Okafor");
  await bo.goto(new URL(fileUrl).pathname);
  await expect(bo.getByRole("status")).toContainText("Saved", { timeout: 15_000 });

  // The people list.
  await bo.getByRole("button", { name: "People in this file" }).click();
  await expect(bo.getByRole("dialog", { name: "People in this file" })).toBeVisible();
  await shot(bo, "98-people");
  await bo.getByRole("button", { name: "Follow Lena Park", exact: true }).click();
  // Lena zooms in on something; Sam sees what she sees.
  await ana.mouse.move(720, 450);
  await ana.keyboard.press("Shift+2");
  await ana.mouse.move(700, 430);
  await bo.waitForTimeout(500);
  await shot(bo, "99-following");
  await bo.keyboard.press("Escape");

  // Lena spotlights.
  await ana.getByRole("button", { name: "People in this file" }).click();
  await ana.getByRole("button", { name: "Spotlight me" }).click();
  await expect(bo.getByRole("region", { name: /wants to spotlight/ })).toBeVisible();
  await shot(bo, "100-spotlight-prompt");
  await bo.getByRole("button", { name: "Follow Lena", exact: true }).click();
  await shot(ana, "101-spotlighting");
});
