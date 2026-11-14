/**
 * Email preferences and unsubscribing, in a real browser: choose how you
 * hear in account settings, and stop emails from the link an email carries,
 * signed out, after being asked.
 */
import { createHmac } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { freshInstance, type Instance } from "./fresh-instance";

/** The e2e Worker's session secret (server.mjs): links are signed with it, as the Worker does. */
const SECRET = "e2e-session-secret-0123456789abcdef";
const unsubscribeToken = (userId: string) => {
  const body = Buffer.from(JSON.stringify({ uid: userId, purpose: "unsubscribe" })).toString(
    "base64url",
  );
  return `${body}.${createHmac("sha256", SECRET).update(body).digest("base64url")}`;
};

test.describe
  .serial("Email", () => {
    test.skip(!!process.env.E2E_BASE_URL, "Needs its own local instance.");

    let instance: Instance;
    let page: Page;

    test.beforeAll(async ({ browser }) => {
      test.setTimeout(180_000);
      instance = await freshInstance(browser, { port: 8873, inspectorPort: 9413 });
      page = instance.page;
    });

    test.afterAll(async () => {
      await instance?.stop();
    });

    test("choose how you hear, saved as you choose", async () => {
      await page.goto("/settings");
      const email = page.getByRole("radiogroup", { name: "Email" });
      await expect(email.getByRole("radio", { name: /As they happen/ })).toBeChecked();
      await email.getByRole("radio", { name: /Once a day/ }).check();
      const time = page.getByRole("combobox", { name: "Digest time" });
      await expect(time).toBeVisible();
      await time.selectOption({ index: 8 });
      await expect(page.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
      await page.reload();
      await expect(email.getByRole("radio", { name: /Once a day/ })).toBeChecked();
      await expect(page.getByRole("combobox", { name: "Digest time" })).toHaveValue("8");
    });

    test("stop emails from an email's link, signed out, after being asked", async ({ browser }) => {
      const userId = await page.evaluate(
        async () => (await (await fetch("/api/session")).json()).user.id as string,
      );
      const stranger = await browser.newContext({ baseURL: instance.url });
      const tab = await stranger.newPage();
      // The link in the email: it lands on a page that asks, and changes nothing yet.
      await tab.goto(
        `/api/email/unsubscribe?token=${encodeURIComponent(unsubscribeToken(userId))}`,
      );
      await expect(tab.getByRole("heading", { name: "Stop emails from Drawpane?" })).toBeVisible();
      await page.reload();
      await expect(page.getByRole("radio", { name: /Once a day/ })).toBeChecked();
      await tab.getByRole("button", { name: "Stop emails" }).click();
      await expect(tab.getByRole("heading", { name: "You won't get these emails" })).toBeVisible();
      await expect(tab.getByText("Nothing more goes to ana@example.com")).toBeVisible();
      await page.reload();
      await expect(page.getByRole("radio", { name: /Never/ })).toBeChecked();
      // A link that isn't one says so.
      await tab.goto("/unsubscribe?token=forged.token");
      await tab.getByRole("button", { name: "Stop emails" }).click();
      await expect(tab.getByRole("alert")).toContainText("isn't valid");
      await stranger.close();
    });
  });
