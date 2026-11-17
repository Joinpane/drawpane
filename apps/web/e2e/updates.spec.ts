/**
 * A tab learns that a newer Drawpane was deployed (app/updates.ts): when the
 * build `version.json` names isn't its own, it offers a reload, and reloading
 * waits for an open file's edits to be saved.
 */
import { expect, test } from "@playwright/test";
import { freshInstance, type Instance } from "./fresh-instance";

test.describe("A newer Drawpane deployed", () => {
  test.skip(!!process.env.E2E_BASE_URL, "Needs its own local instance.");
  let instance: Instance;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000);
    instance = await freshInstance(browser, { port: 9043, inspectorPort: 9583 });
  });
  test.afterAll(async () => {
    await instance?.stop();
  });

  test("is offered as a reload, and the reload loads the app again", async () => {
    const page = instance.page;
    const ours = await (await page.request.get("/version.json")).json();
    expect(typeof ours.build).toBe("string");
    await page.getByRole("button", { name: "New file" }).first().click();
    await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText("Drawpane was updated")).toHaveCount(0);

    // A deploy: version.json now names another build.
    await page.route("**/version.json", (route) =>
      route.fulfill({ contentType: "application/json", body: '{"build":"newer"}' }),
    );
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    const banner = page.getByRole("status").filter({ hasText: "Drawpane was updated" });
    await expect(banner).toBeVisible();

    const reloaded = page.waitForEvent("load");
    await banner.getByRole("button", { name: "Reload" }).click();
    await reloaded;
    await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
      timeout: 30_000,
    });
  });
});
