/**
 * Dashboard search looks through every file on the team, not just the list
 * on screen: across projects, every word in any order, best matches first,
 * with what matched marked in each name.
 */
import { expect, type Page, test } from "@playwright/test";
import { freshInstance, type Instance } from "./fresh-instance";

test.describe
  .serial("Dashboard search", () => {
    test.skip(!!process.env.E2E_BASE_URL, "Needs its own local instance.");

    let instance: Instance;
    let page: Page;

    test.beforeAll(async ({ browser }) => {
      test.setTimeout(180_000);
      instance = await freshInstance(browser, { port: 8861, inspectorPort: 9401 });
      page = instance.page;
      // Files in Drafts and in a second project.
      await page.evaluate(async () => {
        const post = (path: string, body: unknown) =>
          fetch(`/api${path}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }).then((r) => r.json());
        const { teams } = await (await fetch("/api/teams")).json();
        const team = teams[0].id;
        const { projects } = await (await fetch(`/api/teams/${team}/projects`)).json();
        const { project } = await post(`/teams/${team}/projects`, { name: "Marketing" });
        for (const [where, name] of [
          [projects[0].id, "Checkout flow"],
          [project.id, "Onboarding"],
          [projects[0].id, "Settings"],
          [project.id, "Onboarding flow v2"],
        ])
          await post(`/projects/${where}/files`, { name });
      });
      await page.reload();
    });

    test.afterAll(async () => {
      await instance?.stop();
    });

    test("finds files across projects, best first, and marks what matched", async () => {
      // Start inside one project: search still covers the whole team.
      await page.getByRole("link", { name: /^Drafts/ }).click();
      const search = page.getByRole("searchbox", { name: "Search files" });
      await search.fill("onboarding");
      await expect(page.getByRole("heading", { name: "Results for “onboarding”" })).toBeVisible();
      // The exact name first, though the other was edited later.
      const names = page.locator(".dash__card-name");
      await expect(names).toHaveText(["Onboarding", "Onboarding flow v2"]);
      await expect(names.last().locator("mark")).toHaveText("Onboarding");

      // Every word, any order: one file has both.
      await search.fill("flow onboarding");
      await expect(names).toHaveText(["Onboarding flow v2"]);
      await expect(names.first().locator("mark")).toHaveText(["Onboarding", "flow"]);

      await search.fill("roadmap");
      await expect(page.getByText("No files match.")).toBeVisible();
      await expect(page.getByText("That's every file on the team.")).toBeVisible();

      // Cleared: back to the project's own list.
      await search.fill("");
      await expect(page.getByRole("heading", { name: "Drafts", level: 1 })).toBeVisible();
      await expect(names).toHaveText(["Settings", "Checkout flow"]);
    });
  });
