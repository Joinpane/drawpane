/**
 * Screenshots of paragraph spacing and truncation for design review, in both
 * themes, set from the inspector. Run with `pnpm --filter @drawpane/web tour`.
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
    zoomTo(z: number): void;
    s: { pageId: string };
    doc: { get(id: string): { props: Record<string, unknown> } | undefined };
  };
};

test("type settings tour", async ({ browser }) => {
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

  const ids = await page.evaluate(() => {
    const e = (window as unknown as W).drawpane;
    const card = e.createLayer("frame", { x: 0, y: 0, width: 360, height: 420 }, e.s.pageId, {
      name: "Card",
      fills: [{ type: "solid", color: "#ffffff" }],
    }) as string;
    const body = e.createLayer("text", { x: 24, y: 24, width: 312, height: 10 }, card, {
      characters:
        "Plan your week in one glance. Everything that matters, nothing that doesn't.\nMeetings, focus time and errands share one calendar, so the day reads at a glance.\nWorks offline, and syncs the moment you're back.",
      fontSize: 15,
      textAutoResize: "height",
    }) as string;
    const preview = e.createLayer("text", { x: 24, y: 300, width: 312, height: 10 }, card, {
      characters:
        "A long preview line that runs on past its box, the way a message list cuts a message short after a couple of lines so every row stays the same height.",
      fontSize: 15,
      textAutoResize: "height",
    }) as string;
    e.zoomTo(1);
    return { card, body, preview };
  });
  const prop = (id: string, name: string) =>
    page.evaluate(([id, name]) => (window as unknown as W).drawpane.doc.get(id)?.props[name], [
      id,
      name,
    ] as const);

  // Paragraph spacing, from type settings.
  await page.evaluate((id) => (window as unknown as W).drawpane.select([id]), ids.body);
  await page.keyboard.press("Shift+1");
  const settings = page.getByRole("button", { name: /^Type settings/ });
  const panel = page.getByRole("dialog", { name: "Type settings" });
  await settings.click();
  await panel.getByRole("tab", { name: "Basics" }).click();
  const spacing = panel.getByLabel("Paragraph spacing");
  await spacing.fill("12");
  await spacing.press("Enter");
  await expect.poll(() => prop(ids.body, "paragraphSpacing")).toBe(12);
  await page.waitForTimeout(250);
  await shot(page, "150-paragraph-spacing");

  // Truncate the preview to two lines.
  await page.evaluate((id) => (window as unknown as W).drawpane.select([id]), ids.preview);
  await panel.getByRole("combobox", { name: "Truncate" }).selectOption("2");
  await expect.poll(() => prop(ids.preview, "maxLines")).toBe(2);
  await page.waitForTimeout(250);
  await shot(page, "151-truncate");
  await page.keyboard.press("Escape");
  // Closed, the button marks that something in it is set.
  await expect(settings).toHaveAccessibleName(/Max 2 lines/);

  // A heading trimmed to its capitals and baseline: its box hugs what's seen.
  const heading = await page.evaluate((card) => {
    const e = (window as unknown as W).drawpane;
    return e.createLayer("text", { x: 24, y: 196, width: 10, height: 10 }, card, {
      characters: "Weekly plan",
      fontSize: 40,
      fontWeight: 600,
    }) as string;
  }, ids.card);
  await page.evaluate((id) => (window as unknown as W).drawpane.select([id]), heading);
  const standard = (await prop(heading, "height")) as number;
  await settings.click();
  await panel.getByRole("radio", { name: "Cap height to baseline" }).click();
  await expect.poll(() => prop(heading, "leadingTrim")).toBe("cap-height");
  await expect.poll(() => prop(heading, "height")).toBeLessThan(standard * 0.7);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(250);
  await shot(page, "177-vertical-trim");

  // Details: the font's OpenType features.
  await settings.click();
  await panel.getByRole("tab", { name: "Details" }).click();
  await expect(
    page.getByRole("tabpanel", { name: "Details" }).getByRole("checkbox").first(),
  ).toBeVisible({
    timeout: 15_000,
  });
  await shot(page, "178-type-settings-details");
  await context.close();
});
