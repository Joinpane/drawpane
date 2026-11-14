/**
 * Signing in with GitHub or Google, and account settings, in a real browser
 * on a throwaway instance. The providers aren't contacted: the trip to them
 * is intercepted, and the server side of the flow has its own tests.
 */
import { expect, type Page, test } from "@playwright/test";
import { freshInstance, type Instance } from "./fresh-instance";

test.describe
  .serial("Account and sign-in methods", () => {
    test.skip(!!process.env.E2E_BASE_URL, "Needs its own local instance.");

    let instance: Instance;
    let page: Page;

    test.beforeAll(async ({ browser }) => {
      test.setTimeout(180_000);
      instance = await freshInstance(browser, { port: 8819, inspectorPort: 9359 });
      page = instance.page;
    });

    test.afterAll(async () => {
      await instance?.stop();
    });

    test("opens account settings from the sidebar, with the ways to sign in", async () => {
      await page.getByRole("link", { name: /Ana Lima/ }).click();
      await expect(page.getByRole("heading", { name: "Account" })).toBeVisible();
      const methods = page.getByRole("list").filter({ hasText: "Passkey" });
      await expect(methods.getByRole("listitem")).toHaveCount(3);
      await expect(methods.getByRole("listitem").filter({ hasText: "GitHub" })).toContainText(
        "Not connected",
      );
      // The one passkey is the only way in, so it can't be removed.
      await expect(
        methods.getByRole("listitem").filter({ hasText: "Passkey" }).getByRole("button", {
          name: "Remove",
        }),
      ).toBeDisabled();
      const connect = methods
        .getByRole("listitem")
        .filter({ hasText: "Google" })
        .getByRole("link", {
          name: "Connect",
        });
      expect(await connect.getAttribute("href")).toBe(
        "/api/auth/oauth/google/start?intent=link&next=%2Fsettings",
      );
    });

    test("renames you everywhere", async () => {
      const name = page.getByLabel("Name");
      await name.fill("Ana Lima-Souza");
      await page.getByRole("button", { name: "Save" }).click();
      await expect(page.getByRole("button", { name: "Saved" })).toBeVisible();
      await page.getByRole("link", { name: "Files" }).click();
      await expect(page.getByRole("link", { name: /Ana Lima-Souza/ })).toBeVisible();
    });

    test("shows the instance's admin its health and cost", async () => {
      // Whoever ran setup runs the instance.
      await page.getByRole("link", { name: "Instance health and cost" }).click();
      await expect(page.getByRole("heading", { name: "Health and cost" })).toBeVisible();
      const glance = page.getByRole("region", { name: "At a glance" });
      await expect(glance).toHaveAttribute("aria-busy", "false");
      await expect(glance).toContainText("$5.00");
      const services = page.getByRole("list").filter({ hasText: "FileRoom objects" });
      await expect(services.getByRole("listitem")).toHaveCount(3);
      await expect(services.getByText("Down")).toHaveCount(0);
      // Each period asks again.
      await page.getByRole("radio", { name: "7 days" }).click();
      await expect(glance).toContainText("edits in 7 days");
      await page.getByRole("link", { name: "Files" }).click();
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    });

    test("explains adding a passkey from a device that already has one", async () => {
      await page.getByRole("link", { name: /Ana Lima-Souza/ }).click();
      await page.getByRole("button", { name: "Add a passkey" }).click();
      await expect(page.getByRole("alert")).toContainText("already has a passkey");
    });

    test("offers GitHub and Google on the sign-in page, and sends you to them", async ({
      browser,
    }) => {
      const context = await browser.newContext();
      const guest = await context.newPage();
      // GitHub itself is never contacted: the redirect to it is read, not followed.
      let location = "";
      await guest.route("**/api/auth/oauth/github/start**", async (route) => {
        const response = await route.fetch({ maxRedirects: 0 });
        location = response.headers().location ?? "";
        await route.fulfill({
          status: 200,
          contentType: "text/html",
          body: "<p>Off to GitHub</p>",
        });
      });
      await guest.goto(`${instance.url}/signin?next=/t/abc`);
      await expect(guest.getByRole("link", { name: "Continue with Google" })).toBeVisible();
      await guest.getByRole("link", { name: "Continue with GitHub" }).click();
      await expect(guest.getByText("Off to GitHub")).toBeVisible();
      const url = new URL(location);
      expect(url.pathname).toBe("/login/oauth/authorize");
      expect(url.searchParams.get("client_id")).toBe("e2e-github-client");
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      expect(url.searchParams.get("redirect_uri")).toBe(
        `${instance.url}/api/auth/oauth/github/callback`,
      );
      await context.close();
    });

    test("says why a provider sign-in didn't go through", async ({ browser }) => {
      const context = await browser.newContext();
      const guest = await context.newPage();
      await guest.goto(`${instance.url}/signin?error=no-account&provider=github`);
      await expect(guest.getByRole("alert")).toContainText(
        "no Drawpane account for that GitHub account",
      );
      await context.close();
    });
  });
