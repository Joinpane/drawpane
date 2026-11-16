/**
 * Organising a team's files from the dashboard: renaming a project, moving
 * a file to another project (from its menu, and by dropping its card on a
 * project in the sidebar), deleting a project into the trash and getting it
 * back by restoring a file, and emptying the trash, each with a word first.
 */
import { expect, type Page, test } from "@playwright/test";
import { freshInstance, type Instance } from "./fresh-instance";

test.describe
  .serial("Projects and trash", () => {
    test.skip(!!process.env.E2E_BASE_URL, "Needs its own local instance.");

    let instance: Instance;
    let page: Page;

    const side = () => page.getByRole("complementary", { name: "Navigation" });
    const project = (name: string) => side().getByRole("link", { name: new RegExp(`^${name}`) });
    const card = (name: string) => page.locator(".dash__card").filter({ hasText: name });
    const dialog = () => page.getByRole("dialog");

    test.beforeAll(async ({ browser }) => {
      test.setTimeout(180_000);
      instance = await freshInstance(browser, { port: 9015, inspectorPort: 9555 });
      page = instance.page;
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
          [projects[0].id, "Settings"],
          [project.id, "Landing page"],
        ])
          await post(`/projects/${where}/files`, { name });
      });
      await page.reload();
    });

    test.afterAll(async () => {
      await instance?.stop();
    });

    test("renames a project from its options in the sidebar", async () => {
      await project("Marketing").hover();
      await side().getByRole("button", { name: "Options for Marketing" }).click();
      await page.getByRole("menuitem", { name: "Rename" }).click();
      const name = dialog().getByRole("textbox", { name: "Name" });
      await expect(name).toBeFocused();
      await name.fill("Brand site");
      await name.press("Enter");
      await expect(dialog()).toBeHidden();
      await expect(project("Brand site")).toBeVisible();
    });

    test("moves a file to another project from its menu", async () => {
      await project("Drafts").click();
      await expect(page.getByRole("heading", { name: "Drafts", level: 1 })).toBeVisible();
      await card("Settings").hover();
      await page.getByRole("button", { name: "Options for Settings" }).click();
      await page.getByRole("menuitem", { name: "Move to…" }).click();
      await expect(dialog().getByRole("heading", { name: "Move “Settings”" })).toBeVisible();
      // The file's own project isn't offered.
      await expect(dialog().getByRole("radio")).toHaveCount(1);
      await expect(dialog().getByRole("radio", { name: /Brand site/ })).toBeChecked();
      await dialog().getByRole("button", { name: "Move" }).click();
      await expect(dialog()).toBeHidden();
      await expect(card("Settings")).toHaveCount(0);
      await expect(project("Brand site")).toContainText("2");
    });

    test("moves a file by dropping its card on a project", async () => {
      await card("Checkout flow").dragTo(project("Brand site"));
      await expect(card("Checkout flow")).toHaveCount(0);
      await expect(project("Brand site")).toContainText("3");
    });

    test("deletes a project into the trash, and restoring a file brings it back", async () => {
      await project("Brand site").click();
      await page.getByRole("main").getByRole("button", { name: "Options for Brand site" }).click();
      await page.getByRole("menuitem", { name: "Delete project" }).click();
      await expect(dialog()).toContainText("Its 3 files move to the trash.");
      await dialog().getByRole("button", { name: "Delete project" }).click();
      // Off the project's page, which is gone.
      await expect(page.getByRole("heading", { name: "Recent files", level: 1 })).toBeVisible();
      await expect(project("Brand site")).toHaveCount(0);

      // The team's last project can't go.
      await project("Drafts").hover();
      await side().getByRole("button", { name: "Options for Drafts" }).click();
      await expect(page.getByRole("menuitem", { name: "Delete project" })).toBeDisabled();
      await page.keyboard.press("Escape");

      await side().getByRole("link", { name: "Trash" }).click();
      await expect(page.locator(".dash__card")).toHaveCount(3);
      await card("Landing page").hover();
      await card("Landing page").getByRole("button", { name: "Restore" }).click();
      await expect(project("Brand site")).toContainText("1");
    });

    test("deletes one file for good, and empties the trash, once asked", async () => {
      await card("Settings").hover();
      await card("Settings").getByRole("button", { name: "Delete forever" }).click();
      await expect(
        dialog().getByRole("heading", { name: "Delete “Settings” for good?" }),
      ).toBeVisible();
      await dialog().getByRole("button", { name: "Cancel" }).click();
      await expect(card("Settings")).toHaveCount(1);
      await card("Settings").hover();
      await card("Settings").getByRole("button", { name: "Delete forever" }).click();
      await dialog().getByRole("button", { name: "Delete forever" }).click();
      await expect(card("Settings")).toHaveCount(0);

      await page.getByRole("button", { name: "Empty trash" }).click();
      await expect(dialog()).toContainText("The file in the trash");
      await dialog().getByRole("button", { name: "Empty trash" }).click();
      await expect(page.getByText("Trash is empty.")).toBeVisible();
      await expect(page.getByRole("button", { name: "Empty trash" })).toHaveCount(0);
    });
  });
