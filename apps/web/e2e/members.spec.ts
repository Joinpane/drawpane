/**
 * The Members page: an owner invites with a note, sees the invite pending,
 * takes one back, changes someone's role and removes them; someone who
 * isn't an owner sees the roles and can leave. The server side has its own
 * tests (apps/worker/test/members.test.ts).
 */
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { addPasskey, freshInstance, type Instance } from "./fresh-instance";

test.describe
  .serial("Members", () => {
    test.skip(!!process.env.E2E_BASE_URL, "Needs its own local instance.");

    let instance: Instance;
    let ana: Page;
    let boContext: BrowserContext;
    let bo: Page;

    test.beforeAll(async ({ browser }) => {
      test.setTimeout(180_000);
      instance = await freshInstance(browser, { port: 8845, inspectorPort: 9385 });
      ana = instance.page;
      boContext = await browser.newContext({ baseURL: instance.url });
      bo = await boContext.newPage();
      await addPasskey(boContext, bo);
    });

    test.afterAll(async () => {
      await boContext?.close();
      await instance?.stop();
    });

    test("invites with a note, and lists the invite until it's used", async () => {
      await ana.getByRole("link", { name: "Members" }).click();
      await expect(ana.getByRole("heading", { name: "Members", level: 1 })).toBeVisible();
      const people = ana.getByRole("list", { name: "People" });
      await expect(people.getByRole("listitem")).toHaveCount(1);
      await expect(people).toContainText("Ana Lima");
      await expect(people).toContainText("You");
      await expect(people).toContainText("Passkey");
      // The only owner can't step down: no menu, and a reason.
      await expect(people.getByRole("button", { name: /Change role/ })).toHaveCount(0);

      const invite = async (role: string, note: string) => {
        await ana.getByRole("button", { name: "Invite people" }).click();
        const dialog = ana.getByRole("dialog", { name: "Invite to this team" });
        await dialog.getByRole("radio", { name: role }).check();
        await dialog.getByLabel("Who's it for? (optional)").fill(note);
        await dialog.getByRole("button", { name: "Create link" }).click();
        await expect(dialog).toContainText(`Send this link to ${note}`);
        const url = (await dialog.locator(".app-copy code").textContent()) as string;
        await dialog.getByRole("button", { name: "Done" }).click();
        return url;
      };
      const forBo = await invite("Viewer", "Bo, research");
      await invite("Editor", "Cy, freelance");
      const pending = ana.getByRole("list", { name: /Pending invites/ });
      await expect(pending.getByRole("listitem")).toHaveCount(2);
      await expect(pending.getByRole("listitem").first()).toContainText("Cy, freelance");
      await expect(pending.getByRole("listitem").first()).toContainText("Joins as editor");

      // Taking one back: it leaves the list.
      await pending.getByRole("button", { name: "Take back the invite for Cy, freelance" }).click();
      await expect(ana.getByRole("status")).toContainText("Invite taken back");
      await expect(pending.getByRole("listitem")).toHaveCount(1);

      // Bo joins with his link, and his invite is no longer pending.
      await bo.goto(new URL(forBo).pathname);
      await bo.getByLabel("Your name").fill("Bo Chen");
      await bo.getByLabel("Email").fill("bo@example.com");
      await bo.getByRole("button", { name: "Create account with a passkey" }).click();
      await expect(bo.getByRole("heading", { name: "Recent files" })).toBeVisible();
      await ana.reload();
      await expect(people.getByRole("listitem")).toHaveCount(2);
      await expect(ana.getByRole("list", { name: /Pending invites/ })).toHaveCount(0);
      await expect(ana.getByText("2 people")).toBeVisible();
    });

    test("someone who isn't an owner sees roles, and can only leave", async () => {
      await bo.getByRole("link", { name: "Members" }).click();
      const people = bo.getByRole("list", { name: "People" });
      await expect(people.getByRole("listitem")).toHaveCount(2);
      await expect(bo.getByRole("button", { name: "Invite people" })).toHaveCount(0);
      await expect(bo.getByRole("list", { name: /Pending invites/ })).toHaveCount(0);
      await expect(people.getByRole("button", { name: /Change role/ })).toHaveCount(0);
      const mine = people.getByRole("listitem").filter({ hasText: "Bo Chen" });
      await expect(mine).toContainText("Viewer");
      // How people sign in is for owners to see.
      await expect(people).not.toContainText("Passkey");
      await expect(people).not.toContainText("Signed in");
      await expect(mine.getByRole("button", { name: "Leave" })).toBeVisible();
      await expect(bo.getByRole("complementary").getByText("What roles can do")).toBeVisible();
    });

    test("an owner changes a role, and removes someone after asking", async () => {
      // Bo has one of the team's files open the whole time.
      const fileId = await ana.evaluate(async () => {
        const { teams } = await (await fetch("/api/teams")).json();
        const { projects } = await (await fetch(`/api/teams/${teams[0].id}/projects`)).json();
        const response = await fetch(`/api/projects/${projects[0].id}/files`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "Onboarding" }),
        });
        return (await response.json()).file.id as string;
      });
      await bo.goto(`/f/${fileId}`);
      await expect(bo.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
        timeout: 15_000,
      });

      const people = ana.getByRole("list", { name: "People" });
      await people.getByRole("button", { name: "Bo Chen: Viewer. Change role" }).click();
      const menu = ana.getByRole("menu", { name: "Role for Bo Chen" });
      await expect(menu.getByRole("menuitemcheckbox", { name: "Viewer" })).toHaveAttribute(
        "aria-checked",
        "true",
      );
      await menu.getByRole("menuitemcheckbox", { name: "Editor" }).click();
      await expect(ana.getByRole("status")).toContainText("Bo Chen is now an editor.");
      // His open file hears it at once.
      await expect(
        bo.getByRole("alert").filter({ hasText: "Ana Lima made you an editor" }),
      ).toBeVisible();
      await expect(
        people.getByRole("button", { name: "Bo Chen: Editor. Change role" }),
      ).toBeVisible();

      await people.getByRole("button", { name: "Bo Chen: Editor. Change role" }).click();
      await ana.getByRole("menuitem", { name: "Remove from team" }).click();
      const confirm = ana.getByRole("dialog", { name: "Remove Bo Chen?" });
      await expect(confirm).toContainText("Their comments stay");
      await confirm.getByRole("button", { name: "Cancel" }).click();
      await expect(people.getByRole("listitem")).toHaveCount(2);
      await people.getByRole("button", { name: "Bo Chen: Editor. Change role" }).click();
      await ana.getByRole("menuitem", { name: "Remove from team" }).click();
      await confirm.getByRole("button", { name: "Remove" }).click();
      await expect(ana.getByRole("status")).toContainText("Bo Chen was removed");
      await expect(people.getByRole("listitem")).toHaveCount(1);

      // His open file closes at once, and says why; on no team, he lands on the page that says so.
      const gone = bo
        .getByRole("alert")
        .filter({ hasText: "You no longer have access to this file" });
      await expect(gone).toBeVisible();
      await gone.getByRole("button", { name: "Go to your files" }).click();
      await expect(bo.getByRole("heading", { name: "You're not on a team" })).toBeVisible();
    });

    test("fits a phone: who signs in how moves under the name", async () => {
      await ana.setViewportSize({ width: 390, height: 844 });
      expect(
        await ana.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
      ).toBe(true);
      await ana.setViewportSize({ width: 1440, height: 900 });
    });
  });
