/**
 * PDF export in a real browser, on a throwaway instance: frames become
 * pages with their images and their text in its own embedded typeface, a
 * missing font falls back to Helvetica with a notice, and the page exports
 * as a deck from the canvas menu.
 *
 * Google is never contacted: /api/fonts answers with a bundled OFL font.
 */
import { readFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { dropImage, freshInstance, type Instance } from "./fresh-instance";

const FONT = readFileSync(new URL("./fixtures/InstrumentSans-Regular.ttf", import.meta.url));

type Debug = {
  s: { pageId: string; selection: string[] };
  createLayer(
    type: string,
    rect: { x: number; y: number; width: number; height: number },
    parent: string,
    props?: Record<string, unknown>,
  ): string | null;
  select(ids: string[]): void;
  zoomToFit(): void;
  reparentOps(id: string, parent: string, key: string): unknown[];
  topKey(parent: string): string;
  commit(ops: unknown[], label: string): boolean;
};
type W = { drawpane: Debug };

/** The text of a downloaded PDF: its object dictionaries are plain, its streams compressed. */
async function savedPdf(page: Page, start: () => Promise<void>) {
  const [download] = await Promise.all([page.waitForEvent("download"), start()]);
  const path = await download.path();
  if (!path) throw new Error("no download");
  return { name: download.suggestedFilename(), text: readFileSync(path).toString("latin1") };
}

const pageCount = (pdf: string) => pdf.match(/\/Type\s*\/Page[^s]/g)?.length ?? 0;

test.describe
  .serial("PDF export", () => {
    test.skip(!!process.env.E2E_BASE_URL, "Needs its own local instance.");

    let instance: Instance;
    let page: Page;
    let frames: string[];

    test.beforeAll(async ({ browser }) => {
      test.setTimeout(180_000);
      instance = await freshInstance(browser, { port: 8807, inspectorPort: 9347 });
      page = instance.page;
      await page.route("**/api/fonts/**", async (route) => {
        const url = route.request().url();
        if (url.endsWith("/api/fonts/config"))
          return route.fulfill({ status: 200, json: { google: true } });
        if (url.includes("format=ttf"))
          return route.fulfill({
            status: 200,
            contentType: "text/css",
            body: `@font-face {
  font-family: 'Instrument Sans';
  font-style: normal;
  font-weight: 400;
  src: url(/api/fonts/gstatic/s/instrumentsans/v4/fixture.ttf) format('truetype');
}`,
          });
        if (url.endsWith(".ttf"))
          return route.fulfill({ status: 200, contentType: "font/ttf", body: FONT });
        return route.fulfill({ status: 200, contentType: "text/css", body: "" });
      });
      await page.evaluate(() => localStorage.setItem("drawpane:debug", "1"));
      await page.getByRole("button", { name: "New file" }).first().click();
      await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
        timeout: 15_000,
      });
      await dropImage(
        page,
        { x: 720, y: 450 },
        { name: "photo.png", width: 120, height: 80, colors: ["#2b4fd6", "#f5b400"] },
      );
      await expect
        .poll(() => page.evaluate(() => (window as unknown as W).drawpane.s.selection.length))
        .toBe(1);
      frames = await page.evaluate(() => {
        const e = (window as unknown as W).drawpane;
        const p = e.s.pageId;
        const photo = e.s.selection[0] as string;
        const home = e.createLayer("frame", { x: -2000, y: 0, width: 400, height: 300 }, p, {
          name: "Home",
          fills: [{ type: "solid", color: "#ffffff" }],
        }) as string;
        e.createLayer("text", { x: -1980, y: 20, width: 10, height: 10 }, home, {
          characters: "Hello PDF",
          fontSize: 32,
        });
        e.commit(e.reparentOps(photo, home, e.topKey(home)), "Move");
        const settings = e.createLayer("frame", { x: -1500, y: 0, width: 300, height: 500 }, p, {
          name: "Settings",
          fills: [{ type: "solid", color: "#ffffff" }],
        }) as string;
        e.createLayer("text", { x: -1480, y: 20, width: 10, height: 10 }, settings, {
          characters: "Legacy type",
          fontFamily: "Frutiger",
        });
        e.zoomToFit();
        return [home, settings];
      });
    });

    test.afterAll(async () => {
      await instance?.stop();
    });

    test("exports selected frames as pages, with images and embedded type", async () => {
      await page.evaluate((ids) => (window as unknown as W).drawpane.select(ids), frames);
      await page
        .getByRole("radiogroup", { name: "Export format" })
        .getByRole("radio", { name: "PDF" })
        .click();
      await expect(page.getByText("· 2 pages")).toBeVisible();
      const pdf = await savedPdf(page, () =>
        page.getByRole("button", { name: "Export PDF" }).click(),
      );
      expect(pdf.name).toBe("Home and 1 more.pdf");
      expect(pdf.text.startsWith("%PDF-")).toBe(true);
      expect(pageCount(pdf.text)).toBe(2);
      // Home is 400 × 300 points, landscape; Settings 300 × 500, portrait.
      expect(pdf.text).toMatch(/\/MediaBox \[0 0 400\.?0* 300\.?0*\]/);
      expect(pdf.text).toMatch(/\/MediaBox \[0 0 300\.?0* 500\.?0*\]/);
      // The photo, the embedded TrueType, and a bookmark per frame.
      expect(pdf.text).toContain("/Subtype /Image");
      expect(pdf.text).toContain("/FontFile2");
      expect(pdf.text).toContain("/Title (Home)");
      expect(pdf.text).toContain("/Title (Settings)");
      // The missing family is named in the notice.
      await expect(
        page.getByText(/Frutiger isn't available, so it's set in Helvetica/),
      ).toBeVisible();
    });

    test("exports the whole page as a deck from the canvas menu", async () => {
      await page.evaluate(() => (window as unknown as W).drawpane.select([]));
      // The upload tray from the photo clears itself once it's done; wait for it.
      await expect(page.getByRole("region", { name: "Image uploads" })).toBeHidden({
        timeout: 15_000,
      });
      // Empty canvas, clear of the frames and the floating panels.
      await page.mouse.click(760, 760, { button: "right" });
      const item = page.getByRole("menuitem", { name: /^Export page as PDF/ });
      await expect(item).toBeVisible();
      const pdf = await savedPdf(page, () => item.click());
      expect(pdf.name).toBe("Page 1.pdf");
      expect(pageCount(pdf.text)).toBe(2);
    });
  });
