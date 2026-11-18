/**
 * Font aliases in a real browser (decision 0034), on a throwaway instance:
 * the team uploads stand-ins named "SF Pro Text" and "SF Pro Display" (OFL
 * fonts renamed, tools/stand-in-fonts; Apple's own files are licensed and
 * never in the repo), and text the file sets in "SF Pro" is drawn in the cut
 * its size calls for. A symbol only SF Pro Text has draws from it at text
 * sizes, and as the missing-glyph box at display sizes. Then the missing
 * fonts panel: a family nobody has gets a team alias, and everyone sees it in
 * the alias's family while the file still names its own.
 *
 * Screenshots of the panel in both themes land in E2E_SHOTS (or the test's
 * output folder), for the pull request.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { freshInstance, type Instance } from "./fresh-instance";

const fixture = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const STAND_INS = [
  fixture("./fixtures/SFProText-StandIn-Regular.ttf"),
  fixture("./fixtures/SFProText-StandIn-Bold.ttf"),
  fixture("./fixtures/SFProDisplay-StandIn-Regular.ttf"),
];
const SYMBOL = String.fromCodePoint(0x100185);

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
  measurer: { family?(family: string, size: number): string };
  doc: { get(id: string): { props: Record<string, unknown> } | undefined };
};
type W = { drawpane: Debug };

const nav = (page: Page, name: string) =>
  page.getByRole("complementary", { name: "Navigation" }).getByRole("link", { name });

const prop = (page: Page, id: string, name: string) =>
  page.evaluate(
    ([id, name]) =>
      (window as unknown as Partial<W>).drawpane?.doc.get(id as string)?.props[name as string],
    [id, name],
  );

const drawnIn = (page: Page, family: string, size: number) =>
  page.evaluate(
    ([family, size]) =>
      (window as unknown as Partial<W>).drawpane?.measurer.family?.(
        family as string,
        size as number,
      ),
    [family, size] as const,
  );

test.describe
  .serial("Font aliases", () => {
    test.skip(!!process.env.E2E_BASE_URL, "Needs its own local instance.");

    let instance: Instance;
    let page: Page;
    const ids: Record<string, string> = {};

    test.beforeAll(async ({ browser }) => {
      test.setTimeout(180_000);
      instance = await freshInstance(browser, { port: 8993, inspectorPort: 9533 });
      page = instance.page;
      await page.evaluate(() => localStorage.setItem("drawpane:debug", "1"));
    });

    test.afterAll(async () => {
      await instance?.stop();
    });

    test("draws SF Pro in SF Pro Text below 20 px and SF Pro Display from 20 px", async () => {
      await nav(page, "Fonts").click();
      await page.getByLabel("Font files").setInputFiles(STAND_INS);
      await expect(page.locator(".team-fonts__upload--added")).toHaveCount(3, { timeout: 15_000 });

      await nav(page, "Recent").click();
      await page.getByRole("button", { name: "New file" }).first().click();
      await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
        timeout: 15_000,
      });
      Object.assign(
        ids,
        await page.evaluate((symbol) => {
          const e = (window as unknown as W).drawpane;
          const make = (y: number, props: Record<string, unknown>) =>
            e.createLayer("text", { x: 0, y, width: 10, height: 10 }, e.s.pageId, {
              textAutoResize: "width",
              fontFamily: "SF Pro",
              ...props,
            }) as string;
          return {
            body: make(0, { characters: "Body text", fontSize: 17 }),
            bold: make(40, { characters: "Body text", fontSize: 17, fontWeight: 700 }),
            title: make(80, { characters: "Large Title", fontSize: 34 }),
            symbolText: make(140, { characters: symbol, fontSize: 17 }),
            symbolDisplay: make(180, { characters: symbol, fontSize: 34 }),
          };
        }, SYMBOL),
      );

      await expect.poll(() => drawnIn(page, "SF Pro", 17), { timeout: 15_000 }).toBe("SF Pro Text");
      expect(await drawnIn(page, "SF Pro", 19.5)).toBe("SF Pro Text");
      expect(await drawnIn(page, "SF Pro", 20)).toBe("SF Pro Display");
      expect(await drawnIn(page, "SF Pro", 34)).toBe("SF Pro Display");

      // The browser has the stand-ins' faces, regular and bold, and draws from them.
      await expect
        .poll(() =>
          page.evaluate(() =>
            ["17px", "bold 17px"].every((f) => document.fonts.check(`${f} "SF Pro Text"`)),
          ),
        )
        .toBe(true);
      // A layer's width is its text's in the cut, rounded up to whole pixels: the symbol is
      // 1.25 em in SF Pro Text, and SF Pro Display has none, so there it's the missing-glyph box,
      // 0.7 em, not a fallback's guess.
      const width = (id: string) => async () => Number(await prop(page, id, "width"));
      await expect
        .poll(width(ids.symbolText as string), { timeout: 15_000 })
        .toBe(Math.ceil(17 * 1.25));
      await expect.poll(width(ids.symbolDisplay as string)).toBe(Math.ceil(34 * 0.7));
      // Bold is the bold cut, wider than the regular.
      expect(Number(await prop(page, ids.bold as string, "width"))).toBeGreaterThan(
        Number(await prop(page, ids.body as string, "width")),
      );
      // The file still names SF Pro.
      expect(await prop(page, ids.title as string, "fontFamily")).toBe("SF Pro");
    });

    test("lists missing fonts, and a team alias draws one in what the team picked", async () => {
      ids.brand = (await page.evaluate(() => {
        const e = (window as unknown as W).drawpane;
        return e.createLayer("text", { x: 0, y: 240, width: 10, height: 10 }, e.s.pageId, {
          characters: "Brand headline",
          textAutoResize: "width",
          fontFamily: "Acme Brand",
          fontSize: 28,
          fontWeight: 700,
        });
      })) as string;
      await page.evaluate(() => (window as unknown as W).drawpane.select([]));

      const inspector = page.locator(".inspector").filter({ hasText: "Page" });
      await expect(inspector.getByText("Acme Brand is missing here, on 1 layer.")).toBeVisible({
        timeout: 15_000,
      });
      await expect(
        inspector.getByText("SF Pro shows in SF Pro Text and SF Pro Display."),
      ).toBeVisible();
      await inspector.getByRole("button", { name: "Replace…" }).click();

      const dialog = page.getByRole("dialog", { name: "Missing fonts" });
      await expect(dialog.getByText("Acme Brand", { exact: true })).toBeVisible();
      await expect(dialog.getByLabel("Acme Brand Bold becomes")).toBeVisible();
      await expect(
        dialog.getByText("SF Pro Text below 20 px, SF Pro Display from 20 px"),
      ).toBeVisible();
      await dialog.getByLabel("Replace Acme Brand with").selectOption("SF Pro Display");

      const shots = process.env.E2E_SHOTS ?? test.info().outputPath();
      mkdirSync(shots, { recursive: true });
      for (const theme of ["light", "dark"] as const) {
        await page.evaluate((theme) => {
          if (theme === "dark") document.documentElement.dataset.theme = "dark";
          else delete document.documentElement.dataset.theme;
        }, theme);
        await page.waitForTimeout(150);
        await dialog.screenshot({ path: join(shots, `missing-fonts-${theme}.png`) });
      }
      await page.evaluate(() => delete document.documentElement.dataset.theme);

      // For everyone on the team: an alias, the file unchanged.
      await dialog.getByRole("radio", { name: "Every file in the team" }).click();
      await dialog.getByRole("button", { name: "Save for the team" }).click();
      await expect(dialog).toBeHidden();
      await expect.poll(() => drawnIn(page, "Acme Brand", 28)).toBe("SF Pro Display");
      expect(await prop(page, ids.brand as string, "fontFamily")).toBe("Acme Brand");
      await expect(inspector.getByText("Acme Brand shows in SF Pro Display.")).toBeVisible();

      // It's the team's, so it's there after a reload too.
      await page.reload();
      await expect
        .poll(() => drawnIn(page, "Acme Brand", 28), { timeout: 15_000 })
        .toBe("SF Pro Display");
    });

    test("replaces a missing font across the file in one change you can undo", async () => {
      ids.other = (await page.evaluate(() => {
        const e = (window as unknown as W).drawpane;
        return e.createLayer("text", { x: 0, y: 300, width: 10, height: 10 }, e.s.pageId, {
          characters: "Caption",
          fontFamily: "Gone Grotesk",
          fontStyle: "italic",
        });
      })) as string;
      await page.evaluate(() => (window as unknown as W).drawpane.select([]));
      await page.getByRole("button", { name: "Replace…" }).click();
      const dialog = page.getByRole("dialog", { name: "Missing fonts" });
      await dialog.getByLabel("Replace Gone Grotesk with").selectOption("SF Pro Text");
      await dialog.getByRole("button", { name: "Replace fonts" }).click();
      await expect(dialog).toBeHidden();
      expect(await prop(page, ids.other as string, "fontFamily")).toBe("SF Pro Text");
      // SF Pro Text has no italic: the nearest style is its upright (stored as the default).
      expect((await prop(page, ids.other as string, "fontStyle")) ?? "normal").toBe("normal");

      await page.evaluate(() => (window as unknown as W).drawpane.undo());
      expect(await prop(page, ids.other as string, "fontFamily")).toBe("Gone Grotesk");
    });
  });
