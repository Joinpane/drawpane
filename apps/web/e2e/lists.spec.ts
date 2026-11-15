/**
 * Lists in a real browser (decision 0017): "- " typed at a paragraph's start
 * makes a bulleted item, Enter continues the list, Tab nests an item, Enter
 * on an empty item ends the list, ⌘⇧7 numbers the paragraphs touched, and
 * type settings show (and set) what the caret's paragraph is.
 */
import { expect, type Page, test } from "@playwright/test";
import { freshInstance, type Instance } from "./fresh-instance";

type Debug = {
  s: { pageId: string; editingText: string | null };
  createLayer(
    type: string,
    rect: { x: number; y: number; width: number; height: number },
    parent: string,
    props?: Record<string, unknown>,
  ): string | null;
  select(ids: string[]): void;
  zoomTo(z: number): void;
  startTextEdit(id: string): void;
  doc: { get(id: string): { props: Record<string, unknown> } | undefined };
};
type W = { drawpane: Debug };

const editing = (page: Page) => page.getByRole("textbox", { name: "Text", exact: true });
/** Type settings' button: its name says what's set, lists included. */
const settings = (page: Page) =>
  page.getByRole("group", { name: "Properties" }).getByRole("button", { name: /^Type settings/ });

/** Each paragraph's text and list, as "text|type:level", read the way layout reads it. */
async function paragraphs(page: Page, id: string): Promise<string[]> {
  const props = await page.evaluate(
    (id) => (window as unknown as W).drawpane.doc.get(id)?.props ?? {},
    id,
  );
  const text = String(props.characters ?? "");
  const runs = (props.textRuns ?? []) as Array<{
    start: number;
    end: number;
    listType?: string;
    listLevel?: number;
  }>;
  const out: string[] = [];
  let start = 0;
  for (const line of text.split("\n")) {
    const at = Math.min(start, Math.max(0, text.length - 1));
    const run = runs.find((r) => r.start <= at && at < r.end);
    out.push(`${line}|${run?.listType ?? "none"}:${run?.listLevel ?? 0}`);
    start += line.length + 1;
  }
  return out;
}

test.describe
  .serial("Lists", () => {
    test.skip(!!process.env.E2E_BASE_URL, "Needs its own local instance.");

    let instance: Instance;
    let page: Page;
    let id: string;

    test.beforeAll(async ({ browser }) => {
      test.setTimeout(180_000);
      instance = await freshInstance(browser, { port: 8885, inspectorPort: 9425 });
      page = instance.page;
      await page.evaluate(() => localStorage.setItem("drawpane:debug", "1"));
      await page.getByRole("button", { name: "New file" }).first().click();
      await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
        timeout: 15_000,
      });
      id = await page.evaluate(() => {
        const e = (window as unknown as W).drawpane;
        const t = e.createLayer("text", { x: 40, y: 40, width: 10, height: 10 }, e.s.pageId, {
          characters: "Week",
          fontSize: 24,
        }) as string;
        e.zoomTo(1);
        e.select([t]);
        e.startTextEdit(t);
        return t;
      });
      await expect(editing(page)).toBeFocused();
    });

    test.afterAll(async () => {
      await instance?.stop();
    });

    test('starts a list from "- ", continues it on Enter, and nests with Tab', async () => {
      await page.keyboard.press("End");
      await page.keyboard.press("Enter");
      await page.keyboard.type("- Plan");
      await expect.poll(() => paragraphs(page, id)).toEqual(["Week|none:0", "Plan|bullet:0"]);
      await expect(settings(page)).toHaveAccessibleName(/Bulleted list/);
      await page.keyboard.press("Enter");
      await page.keyboard.type("Book");
      await page.keyboard.press("Tab");
      await expect
        .poll(() => paragraphs(page, id))
        .toEqual(["Week|none:0", "Plan|bullet:0", "Book|bullet:1"]);
      // Still editing: Tab nested the item rather than leaving the text.
      await expect(editing(page)).toBeFocused();
      await page.keyboard.press("Shift+Tab");
      await expect
        .poll(() => paragraphs(page, id))
        .toEqual(["Week|none:0", "Plan|bullet:0", "Book|bullet:0"]);
    });

    test("ends the list on Enter at an empty item", async () => {
      await page.keyboard.press("Enter");
      await page.keyboard.press("Enter");
      await page.keyboard.type("Done");
      await expect
        .poll(() => paragraphs(page, id))
        .toEqual(["Week|none:0", "Plan|bullet:0", "Book|bullet:0", "Done|none:0"]);
    });

    test("numbers the paragraphs touched with ⌘⇧7, and type settings take it off", async () => {
      // From inside "Plan" to inside "Book".
      await page.evaluate(() => {
        const t = document.querySelector<HTMLTextAreaElement>("textarea[aria-label='Text']");
        if (!t) throw new Error("no text editor");
        t.setSelectionRange(6, 13);
        t.dispatchEvent(new Event("select", { bubbles: true }));
      });
      await page.keyboard.press("ControlOrMeta+Shift+7");
      await expect
        .poll(() => paragraphs(page, id))
        .toEqual(["Week|none:0", "Plan|number:0", "Book|number:0", "Done|none:0"]);
      await settings(page).click();
      await page
        .getByRole("dialog", { name: "Type settings" })
        .getByRole("radiogroup", { name: "List style" })
        .getByRole("radio", { name: "No list" })
        .click();
      await expect
        .poll(() => paragraphs(page, id))
        .toEqual(["Week|none:0", "Plan|none:0", "Book|none:0", "Done|none:0"]);
    });
  });
