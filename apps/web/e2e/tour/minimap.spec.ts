/**
 * Screenshots of the minimap for design review, in both themes: a page of
 * boards (one hidden) with a collaborator pointing at one, scrolled away from
 * the boards, at a laptop width with the layers pane closed.
 * Run with `pnpm --filter @drawpane/web tour`.
 */
import { expect } from "@playwright/test";
import { passkey, shot, test } from "./harness";

type W = {
  drawpane: {
    s: { pageId: string };
    createLayer(
      type: string,
      rect: { x: number; y: number; width: number; height: number },
      parent: string,
      props?: Record<string, unknown>,
    ): string | null;
    select(ids: string[]): void;
    zoomToFit(): void;
    zoomTo(z: number): void;
    centerOn(p: { x: number; y: number }): void;
    state: { set(patch: Record<string, unknown>): void };
  };
};

test("minimap tour", async ({ browser }) => {
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
    const p = e.s.pageId;
    const white = [{ type: "solid", color: "#ffffff" }];
    e.createLayer("frame", { x: 0, y: 0, width: 393, height: 852 }, p, {
      name: "Home",
      fills: white,
    });
    e.createLayer("frame", { x: 480, y: 0, width: 393, height: 852 }, p, {
      name: "Settings",
      fills: white,
    });
    e.createLayer("frame", { x: 960, y: 0, width: 393, height: 852 }, p, {
      name: "Onboarding",
      fills: white,
      visible: false,
    });
    e.createLayer("rect", { x: 0, y: 940, width: 393, height: 60 }, p, { name: "Note" });
    // Someone else, pointing at the Settings board.
    e.state.set({
      peers: new Map([
        [
          // Pointer over a panel: a ring where they're looking.
          "bo",
          {
            sessionId: "bo",
            userId: "bo",
            name: "Bo Chen",
            color: 3,
            kind: "person",
            presence: {
              cursor: null,
              pageId: p,
              selection: [],
              viewport: { x: 900, y: 100, width: 500, height: 400 },
              following: null,
              spotlight: false,
            },
          },
        ],
        [
          // Far from everything: the map widens to keep them on it.
          "sam",
          {
            sessionId: "sam",
            userId: "sam",
            name: "Sam Okafor",
            color: 6,
            kind: "person",
            presence: {
              cursor: { x: 2600, y: 1400 },
              pageId: p,
              selection: [],
              viewport: null,
              following: null,
              spotlight: false,
            },
          },
        ],
        [
          "lena",
          {
            sessionId: "lena",
            userId: "lena",
            name: "Lena Park",
            color: 2,
            kind: "person",
            presence: {
              cursor: { x: 640, y: 300 },
              pageId: p,
              selection: [],
              viewport: null,
              following: null,
              spotlight: false,
            },
          },
        ],
      ]),
    });
    e.select([]);
    e.zoomTo(1);
    e.centerOn({ x: 196, y: 300 });
  });
  const minimap = page.getByRole("region", { name: "Minimap" });
  await expect(minimap).toContainText("3 boards");
  await shot(page, "155-minimap");
  await shot(page, "156-minimap-close", minimap);

  // Narrower, with the layers pane closed: it moves to the window's edge.
  await page.setViewportSize({ width: 1024, height: 768 });
  await expect(minimap).toBeHidden();
  await page.keyboard.press("ControlOrMeta+\\");
  await expect(minimap).toBeVisible();
  await shot(page, "157-minimap-1024-no-pane");
  await context.close();
});
