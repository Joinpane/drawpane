/**
 * Screenshots of signing in and account settings for design review, in both
 * themes: the sign-in page with GitHub and Google, joining from an invite,
 * and account settings, plain and with a provider error.
 * Run with `pnpm --filter @drawpane/web tour`.
 */
import { expect } from "@playwright/test";
import { passkey, shot, test } from "./harness";

test("account tour", async ({ browser }) => {
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

  // An invite to show the joining page.
  const url = await page.evaluate(async () => {
    const { teams } = await (await fetch("/api/teams")).json();
    const response = await fetch(`/api/teams/${teams[0].id}/invites`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: "editor" }),
    });
    return (await response.json()).url as string;
  });

  await page.getByRole("link", { name: /Ana Lima/ }).click();
  await expect(page.getByRole("heading", { name: "Account" })).toBeVisible();
  await page.waitForTimeout(200);
  await shot(page, "133-account");
  await page.goto("/settings?error=taken&provider=github");
  await expect(page.getByRole("alert")).toBeVisible();
  await shot(page, "134-account-error");

  const guest = await (
    await browser.newContext({ viewport: { width: 1440, height: 900 } })
  ).newPage();
  await guest.goto(`${new URL(page.url()).origin}/signin`);
  await expect(guest.getByRole("link", { name: "Continue with GitHub" })).toBeVisible();
  await shot(guest, "135-signin-providers");
  await guest.goto(new URL(new URL(url).pathname, page.url()).toString());
  await expect(guest.getByRole("link", { name: "Join with GitHub" })).toBeVisible();
  await shot(guest, "136-invite-providers");
  await context.close();
});
