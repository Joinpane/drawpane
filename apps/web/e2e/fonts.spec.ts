/**
 * The font picker in a real browser, on a throwaway instance: searching,
 * previewing with the arrow keys and going back with Esc, keeping a font
 * with Enter, picking a Google font (its stylesheet comes from this server),
 * and the families a file uses, including missing ones.
 *
 * Google is never contacted: the browser's /api/fonts requests are stubbed.
 */
import { expect, type Page, test } from "@playwright/test";
import { freshInstance, type Instance } from "./fresh-instance";

type Debug = {
  s: { pageId: string };
  createLayer(
    type: string,
    rect: { x: number; y: number; width: number; height: number },
    parent: string,
    props?: Record<string, unknown>,
  ): string | null;
  select(ids: string[]): void;
  zoomTo(z: number): void;
  history: { canRedo: boolean };
  doc: { get(id: string): { props: Record<string, unknown> } | undefined };
};
type W = { drawpane: Debug };

const props = (page: Page, id: string) =>
  page.evaluate((id) => (window as unknown as W).drawpane.doc.get(id)?.props ?? {}, id);
const panel = (page: Page) => page.getByRole("group", { name: "Properties" });
const picker = (page: Page) => page.getByRole("dialog", { name: "Fonts" });

test.describe
  .serial("Fonts", () => {
    test.skip(!!process.env.E2E_BASE_URL, "Needs its own local instance.");

    let instance: Instance;
    let page: Page;
    let title: string;
    let legacy: string;
    const stylesheets: string[] = [];

    test.beforeAll(async ({ browser }) => {
      test.setTimeout(180_000);
      instance = await freshInstance(browser, { port: 8803, inspectorPort: 9343 });
      page = instance.page;
      await page.route("**/api/fonts/**", async (route) => {
        const url = route.request().url();
        if (url.endsWith("/api/fonts/config"))
          return route.fulfill({ status: 200, json: { google: true } });
        if (url.includes("google.css") && !url.includes("text=")) stylesheets.push(url);
        await route.fulfill({ status: 200, contentType: "text/css", body: "" });
      });
      await page.evaluate(() => localStorage.setItem("drawpane:debug", "1"));
      await page.getByRole("button", { name: "New file" }).first().click();
      await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
        timeout: 15_000,
      });
      [title, legacy] = await page.evaluate(() => {
        const e = (window as unknown as W).drawpane;
        const p = e.s.pageId;
        const t = e.createLayer("text", { x: 0, y: 0, width: 10, height: 10 }, p, {
          characters: "Plan your week",
          fontSize: 32,
          fontWeight: 600,
        }) as string;
        // A family nobody has: the file shows it as missing.
        const l = e.createLayer("text", { x: 0, y: 80, width: 10, height: 10 }, p, {
          characters: "Legacy",
          fontFamily: "Frutiger",
        }) as string;
        e.zoomTo(1);
        e.select([t]);
        return [t, l];
      });
    });

    test.afterAll(async () => {
      await instance?.stop();
    });

    test("previews with the arrow keys and goes back with Esc", async () => {
      await panel(page).getByRole("button", { name: "Font: Instrument Sans" }).click();
      await expect(picker(page)).toBeVisible();
      await page.keyboard.type("georg");
      await expect(picker(page).getByRole("option").first()).toContainText("Georgia");
      await page.keyboard.press("ArrowDown");
      // Previewing writes to the file, so collaborators and the canvas see it…
      await expect.poll(async () => (await props(page, title)).fontFamily).toBeTruthy();
      await expect(picker(page)).toContainText("Previewing");
      await page.keyboard.press("Escape");
      // …and Esc takes it back, leaving nothing to redo.
      await expect(picker(page)).toBeHidden();
      await expect.poll(async () => (await props(page, title)).fontFamily ?? null).toBeNull();
      expect(await page.evaluate(() => (window as unknown as W).drawpane.history.canRedo)).toBe(
        false,
      );
    });

    test("keeps a font with Enter, at the nearest weight it has", async () => {
      await panel(page).getByRole("button", { name: "Font: Instrument Sans" }).click();
      await page.keyboard.type("Georgia");
      await page.keyboard.press("Enter");
      await expect(picker(page)).toBeHidden();
      // Georgia has 400 and 700: 600 moves to 700.
      await expect
        .poll(async () => {
          const p = await props(page, title);
          return [p.fontFamily, p.fontWeight];
        })
        .toEqual(["Georgia", 700]);
      await expect(panel(page).getByLabel("Weight")).toHaveValue("700");
    });

    test("picks a Google font, loading it from this server", async () => {
      await panel(page).getByRole("button", { name: "Font: Georgia" }).click();
      await picker(page).getByRole("radio", { name: "Google" }).click();
      await page.keyboard.type("Fraunces");
      const row = picker(page).getByRole("option", { name: /^Fraunces/ });
      await expect(row).toContainText("Google");
      await row.click();
      await expect.poll(async () => (await props(page, title)).fontFamily).toBe("Fraunces");
      await expect
        .poll(() => stylesheets.some((u) => u.includes("family=Fraunces") && u.includes("900i")))
        .toBe(true);
    });

    test("lists the file's fonts and flags the missing one", async () => {
      await panel(page).getByRole("button", { name: "Font: Fraunces" }).click();
      await picker(page).getByRole("radio", { name: "This file" }).click();
      const missing = picker(page).getByRole("option", { name: /^Frutiger/ });
      await expect(missing).toContainText("Missing");
      await expect(missing).toHaveAttribute("aria-disabled", "true");
      await expect(picker(page).getByRole("option", { name: /^Fraunces/ })).toContainText(
        "1 layer",
      );
      await page.keyboard.press("Escape");

      // Selecting the missing text warns on the trigger.
      await page.evaluate((id) => (window as unknown as W).drawpane.select([id]), legacy);
      const trigger = panel(page).getByRole("button", { name: "Font: Frutiger" });
      await expect(trigger.getByTitle(/isn't available here/)).toBeVisible();
    });
  });
