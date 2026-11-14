/**
 * Screenshots of Layout Explain and X-ray for design review, in both themes:
 * a hugging stack explained term by term, a fill across its parent, X-ray
 * with its key, and a size set by hand. Run with `pnpm --filter @drawpane/web tour`.
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
    zoomToSelection(): void;
    state: { set(patch: Record<string, unknown>): void };
    s: { pageId: string };
  };
};

test("layout explain tour", async ({ browser }) => {
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

  // The design's example: a phone screen whose Upcoming list hugs three event rows.
  const ids = await page.evaluate(() => {
    const e = (window as unknown as W).drawpane;
    const home = e.createLayer("frame", { x: 0, y: 0, width: 340, height: 560 }, e.s.pageId, {
      name: "Home",
      layoutMode: "column",
      gap: 16,
      paddingTop: 24,
      paddingRight: 20,
      paddingBottom: 24,
      paddingLeft: 20,
      fills: [{ type: "solid", color: "#ffffff" }],
    }) as string;
    e.createLayer("text", { x: 0, y: 0, width: 10, height: 10 }, home, {
      characters: "Good morning, Ana",
      fontSize: 24,
      fontWeight: 700,
    });
    const upcoming = e.createLayer("frame", { x: 0, y: 0, width: 100, height: 100 }, home, {
      name: "Upcoming",
      layoutMode: "column",
      gap: 8,
      paddingTop: 12,
      paddingRight: 12,
      paddingBottom: 12,
      paddingLeft: 12,
      sizingH: "fill",
      sizingV: "hug",
      cornerRadius: 12,
      fills: [{ type: "solid", color: "#f4f2ee" }],
    }) as string;
    const titles = ["Design review", "Lunch with Kai", "Ship the beta"];
    for (const title of titles) {
      const row = e.createLayer("frame", { x: 0, y: 0, width: 276, height: 52 }, upcoming, {
        name: "Event row",
        layoutMode: "row",
        alignItems: "center",
        paddingLeft: 12,
        sizingH: "fill",
        cornerRadius: 8,
        fills: [{ type: "solid", color: "#ffffff" }],
      }) as string;
      e.createLayer("text", { x: 0, y: 0, width: 10, height: 10 }, row, {
        characters: title,
        fontSize: 14,
        fontWeight: 500,
      });
    }
    e.select([home]);
    e.zoomToSelection();
    e.zoomTo(1.25);
    return { home, upcoming };
  });
  const card = page.getByRole("dialog", { name: /^Why is/ });

  await page.evaluate((id) => {
    const e = (window as unknown as W).drawpane;
    e.select([id]);
    e.state.set({ explain: { id, axis: "height" } });
  }, ids.upcoming);
  await expect(card).toBeVisible();
  await shot(page, "130-explain-height");

  await card.getByRole("button", { name: /^Width is Fill/ }).click();
  await shot(page, "131-explain-width");
  await page.keyboard.press("Escape");

  // X-ray held on, the way Alt shows it.
  await page.keyboard.down("Alt");
  await page.waitForTimeout(200);
  await shot(page, "132-xray");
  await page.keyboard.up("Alt");

  // A fixed layer: just the answer and the way back to hugging.
  await page.evaluate((id) => {
    const e = (window as unknown as W).drawpane;
    e.select([id]);
    e.state.set({ explain: { id, axis: "height" } });
  }, ids.home);
  await expect(card).toBeVisible();
  await shot(page, "133-explain-fixed");
  await context.close();
});
