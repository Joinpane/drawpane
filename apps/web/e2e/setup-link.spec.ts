/**
 * The installer opens `/setup#token=…`: the setup token arrives filled in,
 * leaves the address bar once read, and creating the first account works
 * without typing it.
 */
import { expect, test } from "@playwright/test";
import { addPasskey, startWorker, type TestWorker } from "./fresh-instance";

test.describe
  .serial("Setup link from the installer", () => {
    test.skip(!!process.env.E2E_BASE_URL, "Needs its own local instance.");

    let worker: TestWorker;
    test.beforeAll(async () => {
      test.setTimeout(150_000);
      worker = await startWorker({ port: 8833, inspectorPort: 9373 });
    });
    test.afterAll(() => worker?.stop());

    test("fills in the token, and takes it off the address bar", async ({ browser }) => {
      const context = await browser.newContext({ baseURL: worker.url });
      const page = await context.newPage();
      await addPasskey(context, page);
      await page.goto("/setup#token=e2e-setup-token");
      await expect(page.getByLabel("Setup token")).toHaveValue("e2e-setup-token");
      await expect.poll(() => new URL(page.url()).hash).toBe("");
      await page.getByLabel("Your name").fill("Ana Lima");
      await page.getByLabel("Email").fill("ana@example.com");
      await page.getByRole("button", { name: "Create account with a passkey" }).click();
      await expect(page.getByRole("heading", { name: "Recent files" })).toBeVisible();
      await context.close();
    });
  });
