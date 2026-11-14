/**
 * Team fonts in a real browser, on a throwaway instance: uploading font
 * files from the dashboard (named from the fonts themselves), refusing a
 * file that isn't a font, removing a face, and setting text in a team font
 * from the editor's font picker.
 */
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { freshInstance, type Instance } from "./fresh-instance";

const fixture = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const SANS_TTF = fixture("./fixtures/InstrumentSans-Regular.ttf");
const SERIF_ITALIC_WOFF = fixture("../../worker/test/fixtures/InstrumentSerif-Italic.woff");
const NOT_A_FONT = fixture("./fixtures/InstrumentSans-OFL.txt");

type Debug = {
  s: { pageId: string };
  createLayer(
    type: string,
    rect: { x: number; y: number; width: number; height: number },
    parent: string,
    props?: Record<string, unknown>,
  ): string | null;
  select(ids: string[]): void;
  doc: { get(id: string): { props: Record<string, unknown> } | undefined };
};
type W = { drawpane: Debug };

const nav = (page: Page, name: string) =>
  page.getByRole("complementary", { name: "Navigation" }).getByRole("link", { name });

test.describe
  .serial("Team fonts", () => {
    test.skip(!!process.env.E2E_BASE_URL, "Needs its own local instance.");

    let instance: Instance;
    let page: Page;

    test.beforeAll(async ({ browser }) => {
      test.setTimeout(180_000);
      instance = await freshInstance(browser, { port: 8809, inspectorPort: 9349 });
      page = instance.page;
      await page.evaluate(() => localStorage.setItem("drawpane:debug", "1"));
    });

    test.afterAll(async () => {
      await instance?.stop();
    });

    test("uploads fonts, named from the files themselves", async () => {
      await nav(page, "Fonts").click();
      await expect(page.getByRole("heading", { name: "Fonts", level: 1 })).toBeVisible();
      await expect(page.getByText("No team fonts yet")).toBeVisible();

      await page.getByLabel("Font files").setInputFiles([SANS_TTF, SERIF_ITALIC_WOFF, NOT_A_FONT]);
      await expect(page.locator(".team-fonts__upload--added")).toHaveCount(2, { timeout: 15_000 });
      await expect(page.locator(".team-fonts__upload--error")).toContainText("isn't a font file");

      const list = page.locator(".team-fonts__list");
      await expect(list.getByRole("button", { name: /^Instrument Sans/ })).toContainText(
        "1 weight",
      );
      const serif = list.getByRole("button", { name: /^Instrument Serif/ });
      await expect(serif).toContainText("italics");
      await expect(serif).toContainText("OFL");
      await expect(page.getByRole("heading", { name: "Team fonts · 2 families" })).toBeVisible();
    });

    test("shows a family's faces and removes one", async () => {
      const sans = page
        .locator(".team-fonts__list")
        .getByRole("button", { name: /^Instrument Sans/ });
      await sans.click();
      await expect(sans).toHaveAttribute("aria-expanded", "true");
      const faces = page.locator(".team-fonts__faces");
      await expect(faces).toContainText("Regular");
      await expect(faces).toContainText("TTF");
      await faces.getByRole("button", { name: /^Remove Instrument Sans/ }).click();
      await expect(page.getByRole("heading", { name: "Team fonts · 1 family" })).toBeVisible();
    });

    test("sets text in a team font from the editor", async () => {
      await nav(page, "Recent").click();
      await page.getByRole("button", { name: "New file" }).first().click();
      await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
        timeout: 15_000,
      });
      const stylesheet = page.waitForRequest((r) =>
        /\/api\/teams\/[^/]+\/fonts\.css/.test(r.url()),
      );
      const id = await page.evaluate(() => {
        const e = (window as unknown as W).drawpane;
        const t = e.createLayer("text", { x: 0, y: 0, width: 10, height: 10 }, e.s.pageId, {
          characters: "Brand type",
          fontSize: 32,
        }) as string;
        e.select([t]);
        return t;
      });
      const panel = page.getByRole("group", { name: "Properties" });
      await panel.getByRole("button", { name: /^Font:/ }).click();
      const picker = page.getByRole("dialog", { name: "Fonts" });
      await picker.getByRole("radio", { name: "Team" }).click();
      const row = picker.getByRole("option", { name: /^Instrument Serif/ });
      await expect(row).toContainText("Team");
      await row.click();
      await expect
        .poll(() =>
          page.evaluate(
            (id) => (window as unknown as W).drawpane.doc.get(id)?.props.fontFamily,
            id,
          ),
        )
        .toBe("Instrument Serif");
      // The team's stylesheet came from this server, for the team's members.
      expect((await stylesheet).url()).toContain("/fonts.css");
    });
  });
