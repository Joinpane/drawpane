/**
 * Screenshots of starting new files for design review, in both themes: the
 * New file page with its sizes and template previews, and each built-in
 * template opened in the editor. Run with `pnpm --filter @drawpane/web tour`.
 */
import { type BrowserContext, expect, type Page, test } from "@playwright/test";

const OUT = process.env.TOUR_OUT ?? "tour-shots";

async function passkey(context: BrowserContext, page: Page) {
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
}

async function shot(page: Page, name: string) {
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate((t) => {
      if (t === "dark") document.documentElement.dataset.theme = "dark";
      else delete document.documentElement.dataset.theme;
    }, theme);
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${OUT}/${name}-${theme}.png` });
  }
  await page.evaluate(() => delete document.documentElement.dataset.theme);
}

test("new file tour", async ({ browser }) => {
  test.setTimeout(180_000);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await passkey(context, page);
  await page.goto("/setup");
  await page.getByLabel("Your name").fill("Ana Lima");
  await page.getByLabel("Email").fill("ana@example.com");
  await page.getByLabel("Setup token").fill(process.env.E2E_SETUP_TOKEN ?? "e2e-setup-token");
  await page.getByRole("button", { name: "Create account with a passkey" }).click();
  await expect(page.getByRole("heading", { name: "Recent files" })).toBeVisible();
  const dashboard = page.url();
  await shot(page, "137-dashboard-empty-templates");

  await page.getByRole("button", { name: "Templates" }).click();
  await expect(page.getByRole("button", { name: /^Mobile app/ }).locator("img")).toBeVisible({
    timeout: 20_000,
  });
  await page.waitForTimeout(600);
  await shot(page, "138-new-file");

  const names = ["Mobile app", "Landing page", "Slides", "Design review board"];
  for (const [i, name] of names.entries()) {
    await page.goto(dashboard);
    await page.getByRole("button", { name: "Templates" }).click();
    await page.getByRole("button", { name: new RegExp(`^${name}`) }).click();
    await page.waitForURL(/\/f\//);
    await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
      timeout: 20_000,
    });
    await page.waitForTimeout(1200);
    await page.keyboard.press("Shift+1");
    await page.waitForTimeout(700);
    await shot(page, `${139 + i}-template-${name.toLowerCase().replaceAll(" ", "-")}`);
  }
  await context.close();
});
