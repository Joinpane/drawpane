/**
 * Regression test for BrowserContext-scoped WebCrypto virtual passkey persistence:
 * a passkey registered on Firefox / WebKit survives full page reloads and sign-out / sign-in.
 */
import { expect, test } from "@playwright/test";
import { freshInstance } from "./fresh-instance";

test("virtual passkey persists across reload and sign-out on non-Chromium browsers", async ({
  browser,
}) => {
  test.skip(
    browser.browserType().name() === "chromium",
    "Exercises the BrowserContext-scoped WebCrypto authenticator used by Firefox and WebKit.",
  );
  test.setTimeout(180_000);
  const port = Number(process.env.PASSKEY_TEST_PORT ?? 52911);
  const instance = await freshInstance(browser, {
    port,
    inspectorPort: port + 540,
  });
  try {
    const { page } = instance;
    await page.reload();
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.getByRole("button", { name: "Continue with a passkey" }).click();
    const recent = page.getByRole("heading", { name: "Recent files" });
    await expect(recent).toBeVisible({ timeout: 20_000 });
  } finally {
    await instance.stop();
  }
});
