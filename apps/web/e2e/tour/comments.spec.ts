/**
 * Screenshots of comments for design review, in both themes: a thread with
 * replies, the last comment's menu right above the reply box, and editing a
 * comment in place. Run with `pnpm --filter @drawpane/web tour`.
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

test("comments tour", async ({ browser }) => {
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
  await page.getByRole("button", { name: "New file" }).first().click();
  await expect(page.getByRole("status")).toContainText("Saved", { timeout: 15_000 });

  await page.keyboard.press("r");
  await page.mouse.move(560, 300);
  await page.mouse.down();
  await page.mouse.move(760, 440, { steps: 6 });
  await page.mouse.up();
  await page.keyboard.press("c");
  await page.mouse.click(680, 360);
  const draft = page.getByRole("dialog", { name: /^New comment/ });
  await draft
    .getByRole("combobox", { name: "Comment" })
    .fill("Should the hero follow the brand blue?");
  await page.keyboard.press("ControlOrMeta+Enter");
  const thread = page.getByRole("dialog", { name: /^Thread on/ });
  const messages = thread.getByRole("list", { name: "Messages" });
  for (const text of ["I'll check it against the tokens.", "@Ana Lima will work on this"]) {
    await thread.getByRole("combobox", { name: "Reply" }).fill(text);
    await page.keyboard.press("ControlOrMeta+Enter");
    await expect(messages.getByText(text)).toBeVisible();
  }
  await page.waitForTimeout(250);
  await shot(page, "140-comment-thread");

  const options = thread.getByRole("button", { name: /^Options for/ }).last();
  await options.hover();
  await options.click();
  await expect(page.getByRole("menu", { name: "Comment options" })).toBeVisible();
  await shot(page, "141-comment-menu");
  await page.getByRole("menuitem", { name: "Edit" }).click();
  await expect(thread.getByRole("combobox", { name: "Edit comment" })).toBeFocused();
  await shot(page, "142-comment-edit");
  await context.close();
});
