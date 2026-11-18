/**
 * Finding out a file's fonts are missing (decision 0036), on a throwaway
 * instance: a file that sets text in families nobody has opens with a notice
 * naming them and a count in the top bar, either opens the missing fonts
 * panel, and replacing the fonts clears both. A family drawn through an alias
 * (SF Pro, here in the team's stand-ins) never counts. A viewer sees the same,
 * with replacing in the file turned off and the reason given.
 *
 * Screenshots of the notice and the top bar in both themes land in E2E_SHOTS
 * (or the test's output folder), for the pull request.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { addPasskey, freshInstance, type Instance } from "./fresh-instance";

const fixture = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const STAND_INS = [
  fixture("./fixtures/SFProText-StandIn-Regular.ttf"),
  fixture("./fixtures/SFProDisplay-StandIn-Regular.ttf"),
];

type Debug = {
  s: { pageId: string };
  createLayer(
    type: string,
    rect: { x: number; y: number; width: number; height: number },
    parent: string,
    props?: Record<string, unknown>,
  ): string | null;
  select(ids: string[]): void;
  undo(): void;
  notify(text: string): void;
  doc: { get(id: string): { props: Record<string, unknown> } | undefined };
};
type W = { drawpane: Debug };

const nav = (page: Page, name: string) =>
  page.getByRole("complementary", { name: "Navigation" }).getByRole("link", { name });

const notice = (page: Page) => page.getByRole("region", { name: "Missing fonts notice" });
const indicator = (page: Page) => page.getByRole("button", { name: /^Missing fonts: \d+$/ });
const panel = (page: Page) => page.getByRole("dialog", { name: "Missing fonts" });
const saved = (page: Page) => page.getByRole("status").filter({ hasText: "Saved" });

async function shoot(page: Page, name: string, target: Locator) {
  const shots = process.env.E2E_SHOTS ?? test.info().outputPath();
  mkdirSync(shots, { recursive: true });
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate((theme) => {
      if (theme === "dark") document.documentElement.dataset.theme = "dark";
      else delete document.documentElement.dataset.theme;
    }, theme);
    await page.waitForTimeout(250);
    await target.screenshot({ path: join(shots, `${name}-${theme}.png`) });
  }
  await page.evaluate(() => delete document.documentElement.dataset.theme);
}

test.describe
  .serial("Missing fonts notice", () => {
    test.skip(!!process.env.E2E_BASE_URL, "Needs its own local instance.");

    let instance: Instance;
    let page: Page;
    let fileUrl = "";
    const ids: Record<string, string> = {};

    test.beforeAll(async ({ browser }) => {
      test.setTimeout(180_000);
      instance = await freshInstance(browser, { port: 8841, inspectorPort: 9381 });
      page = instance.page;
      await page.evaluate(() => localStorage.setItem("drawpane:debug", "1"));
    });

    test.afterAll(async () => {
      await instance?.stop();
    });

    test("aliased families alone show nothing", async () => {
      await nav(page, "Fonts").click();
      await page.getByLabel("Font files").setInputFiles(STAND_INS);
      await expect(page.locator(".team-fonts__upload--added")).toHaveCount(2, { timeout: 15_000 });
      await nav(page, "Recent").click();
      await page.getByRole("button", { name: "New file" }).first().click();
      await expect(saved(page)).toBeVisible({ timeout: 15_000 });
      fileUrl = new URL(page.url()).pathname;

      ids.sf = (await page.evaluate(() => {
        const e = (window as unknown as W).drawpane;
        return e.createLayer("text", { x: 0, y: 0, width: 10, height: 10 }, e.s.pageId, {
          characters: "Drawn in the team's SF Pro Text",
          textAutoResize: "width",
          fontFamily: "SF Pro",
          fontSize: 17,
        });
      })) as string;
      // The page inspector reads the same report: once it says SF Pro is aliased, the report is in.
      await expect(page.getByText("SF Pro shows in SF Pro Text")).toBeVisible({ timeout: 15_000 });
      await expect(indicator(page)).toHaveCount(0);

      await page.reload();
      await expect(saved(page)).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText("SF Pro shows in SF Pro Text")).toBeVisible({ timeout: 15_000 });
      await page.waitForTimeout(800);
      await expect(notice(page)).toHaveCount(0);
      await expect(indicator(page)).toHaveCount(0);
    });

    test("a file with missing fonts opens with a notice and a count in the top bar", async () => {
      Object.assign(
        ids,
        await page.evaluate(() => {
          const e = (window as unknown as W).drawpane;
          const make = (y: number, props: Record<string, unknown>) =>
            e.createLayer("text", { x: 0, y, width: 10, height: 10 }, e.s.pageId, {
              textAutoResize: "width",
              ...props,
            }) as string;
          return {
            headline: make(60, { characters: "Brand headline", fontFamily: "Acme Brand" }),
            subhead: make(100, {
              characters: "Brand subhead",
              fontFamily: "Acme Brand",
              fontWeight: 700,
            }),
            caption: make(140, { characters: "Caption", fontFamily: "Gone Grotesk" }),
          };
        }),
      );
      // Added after the file opened: the count shows, the notice waits for the next open.
      await expect(indicator(page)).toHaveAccessibleName("Missing fonts: 2", { timeout: 15_000 });
      await expect(notice(page)).toHaveCount(0);
      await expect(saved(page)).toBeVisible({ timeout: 15_000 });

      await page.reload();
      await expect(notice(page)).toBeVisible({ timeout: 20_000 });
      await expect(notice(page)).toContainText(
        "Acme Brand and 1 other font are missing on 3 layers.",
      );
      await expect(indicator(page)).toHaveAccessibleName("Missing fonts: 2");
      // It takes no focus: typing still reaches the editor, not the notice.
      const focusedInNotice = await page.evaluate(
        () => !!document.activeElement?.closest(".fonts-notice"),
      );
      expect(focusedInNotice).toBe(false);

      await shoot(page, "missing-fonts-notice", page.locator(".editor"));
      await shoot(page, "missing-fonts-topbar", page.locator(".top-right"));

      // The indicator's tooltip names it.
      await indicator(page).hover();
      await expect(page.locator(".dp-tooltip")).toHaveText("Missing fonts");

      // Another message takes the toasts' spot for a moment; the notice comes back after it.
      await page.evaluate(() => (window as unknown as W).drawpane.notify("Copied 1 layer."));
      await expect(page.getByRole("alert").filter({ hasText: "Copied 1 layer." })).toBeVisible();
      await expect(notice(page)).toHaveCount(0);
      await expect(notice(page)).toBeVisible({ timeout: 10_000 });

      // Dismissed, it stays away for the rest of the session, reloads included.
      await notice(page).getByRole("button", { name: "Dismiss" }).click();
      await expect(notice(page)).toHaveCount(0);
      await page.reload();
      await expect(indicator(page)).toBeVisible({ timeout: 20_000 });
      await page.waitForTimeout(800);
      await expect(notice(page)).toHaveCount(0);
    });

    test("the notice opens the panel, and replacing clears the count", async () => {
      // A new session in the same browser: the notice is back.
      await page.evaluate(() => sessionStorage.clear());
      await page.reload();
      await expect(notice(page)).toBeVisible({ timeout: 20_000 });
      await notice(page).getByRole("button", { name: "Replace fonts…" }).click();
      const dialog = panel(page);
      await expect(dialog).toBeVisible();
      await expect(notice(page)).toHaveCount(0);
      await expect(dialog.getByText("Acme Brand", { exact: true })).toBeVisible();
      await expect(dialog.getByText("Gone Grotesk", { exact: true })).toBeVisible();

      // Replacing one leaves the other counted.
      await dialog.getByLabel("Replace Acme Brand with").selectOption("Instrument Sans");
      await dialog.getByRole("button", { name: "Replace fonts" }).click();
      await expect(dialog).toBeHidden();
      expect(
        await page.evaluate(
          (id) => (window as unknown as W).drawpane.doc.get(id)?.props.fontFamily,
          ids.headline as string,
        ),
      ).toBe("Instrument Sans");
      await expect(indicator(page)).toHaveAccessibleName("Missing fonts: 1", { timeout: 15_000 });

      // The top bar opens it too; replacing the last one clears the count.
      await indicator(page).click();
      await expect(dialog).toBeVisible();
      await dialog.getByLabel("Replace Gone Grotesk with").selectOption("Instrument Sans");
      await dialog.getByRole("button", { name: "Replace fonts" }).click();
      await expect(dialog).toBeHidden();
      await expect(indicator(page)).toHaveCount(0, { timeout: 15_000 });

      // Undo brings the family back, and the count with it.
      await page.evaluate(() => (window as unknown as W).drawpane.undo());
      await expect(indicator(page)).toHaveAccessibleName("Missing fonts: 1", { timeout: 15_000 });
      await expect(saved(page)).toBeVisible({ timeout: 15_000 });
    });

    test("a viewer sees what's missing, and why they can't replace it", async ({ browser }) => {
      test.setTimeout(120_000);
      const invite = await page.evaluate(async () => {
        const { teams } = await (await fetch("/api/teams")).json();
        const response = await fetch(`/api/teams/${teams[0].id}/invites`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ role: "viewer" }),
        });
        return (await response.json()).url as string;
      });
      const context = await browser.newContext({ baseURL: instance.url });
      const viewer = await context.newPage();
      await addPasskey(context, viewer);
      await viewer.goto(new URL(invite).pathname);
      await viewer.getByLabel("Your name").fill("Sam Okafor");
      await viewer.getByLabel("Email").fill("sam@example.com");
      await viewer.getByRole("button", { name: "Create account with a passkey" }).click();
      await expect(viewer.getByRole("heading", { name: "Recent files" })).toBeVisible();
      await viewer.goto(fileUrl);

      await expect(notice(viewer)).toBeVisible({ timeout: 20_000 });
      await expect(notice(viewer)).toContainText("Gone Grotesk is missing on 1 layer.");
      await expect(indicator(viewer)).toHaveAccessibleName("Missing fonts: 1");
      await notice(viewer).getByRole("button", { name: "Replace fonts…" }).click();
      const dialog = panel(viewer);
      await expect(dialog.getByText("You can view this file but not edit it")).toBeVisible();
      await expect(dialog.getByLabel("Replace Gone Grotesk with")).toBeDisabled();
      const replace = dialog.getByRole("button", { name: "Replace fonts" });
      await expect(replace).toBeDisabled();
      await expect(replace).toHaveAccessibleDescription(/You can view this file but not edit it/);
      await shoot(viewer, "missing-fonts-viewer", dialog);
      await context.close();
    });
  });
