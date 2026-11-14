/**
 * Screenshots of text styles for design review, in both themes: the picker
 * with a type scale grouped by name, editing a style, and the Text section
 * with a style applied and the contrast note on the fill.
 * Run with `pnpm --filter @drawpane/web tour`.
 */
import { expect } from "@playwright/test";
import { passkey, shot, test } from "./harness";

type W = {
  drawpane: {
    createLayer(
      type: string,
      rect: { x: number; y: number; width: number; height: number },
      parent: string,
      props?: Record<string, unknown>,
    ): string | null;
    select(ids: string[]): void;
    createTextStyle(name: string, fromId?: string): string | null;
    zoomTo(z: number): void;
    s: { pageId: string };
  };
};

test("text styles tour", async ({ browser }) => {
  test.setTimeout(120_000);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await passkey(context, page);
  await page.goto("/setup");
  await page.evaluate(() => localStorage.setItem("drawpane:debug", "1"));
  await page.getByLabel("Your name").fill("Ana Lima");
  await page.getByLabel("Email").fill("ana@example.com");
  await page.getByLabel("Setup token").fill(process.env.E2E_SETUP_TOKEN ?? "e2e-setup-token");
  await page.getByRole("button", { name: "Create account with a passkey" }).click();
  await expect(page.getByRole("heading", { name: "Recent files" })).toBeVisible();
  await page.getByRole("button", { name: "New file" }).first().click();
  await expect(page.getByRole("status")).toContainText("Saved", { timeout: 15_000 });

  await page.evaluate(() => {
    const e = (window as unknown as W).drawpane;
    const card = e.createLayer("frame", { x: 0, y: 0, width: 420, height: 320 }, e.s.pageId, {
      name: "Card",
      fills: [{ type: "solid", color: "#ffffff" }],
    }) as string;
    const scale: Array<[string, string, object, number]> = [
      [
        "heading/xl",
        "Plan your week",
        { fontSize: 32, fontWeight: 700, lineHeight: { unit: "px", value: 40 } },
        24,
      ],
      [
        "heading/lg",
        "Today",
        { fontSize: 22, fontWeight: 600, lineHeight: { unit: "px", value: 28 } },
        84,
      ],
      [
        "body/md",
        "Three things on today, nothing more.",
        { fontSize: 15, lineHeight: { unit: "px", value: 22 } },
        128,
      ],
      [
        "label/caps",
        "Due friday",
        {
          fontSize: 11,
          fontWeight: 600,
          textCase: "upper",
          letterSpacing: { unit: "percent", value: 6 },
        },
        170,
      ],
    ];
    let first = "";
    for (const [name, characters, props, y] of scale) {
      const t = e.createLayer("text", { x: 24, y, width: 10, height: 10 }, card, {
        characters,
        ...props,
      }) as string;
      e.select([t]);
      e.createTextStyle(name);
      first ||= t;
    }
    e.zoomTo(1);
    e.select([first]);
  });
  await page.keyboard.press("Shift+1");
  await page.waitForTimeout(300);
  await shot(page, "119-text-style-applied");

  const panel = page.getByRole("group", { name: "Properties" });
  await panel.getByRole("button", { name: /^Text style:/ }).click();
  await page.waitForTimeout(300);
  await shot(page, "117-text-styles-picker");

  const dialog = page.getByRole("dialog", { name: "Text styles" });
  const row = dialog.getByRole("option", { name: /xl/ });
  await row.hover();
  await row.getByRole("button", { name: "Edit heading/xl" }).click();
  await page.waitForTimeout(300);
  await shot(page, "118-text-style-edit");
  await context.close();
});
