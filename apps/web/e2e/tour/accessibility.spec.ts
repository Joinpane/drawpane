/**
 * Screenshots of accessibility at selection for design review, in both themes:
 * a tapped icon on a phone board, too small, with its warning in the inspector,
 * and a board's reading order on the canvas and in the inspector.
 * Run with `pnpm --filter @drawpane/web tour`.
 */
import { expect } from "@playwright/test";
import { passkey, shot, test } from "./harness";

type W = {
  drawpane: {
    s: { pageId: string };
    createLayer(t: string, r: object, parent: string, props?: object): string;
    select(ids: string[]): void;
    zoomToFit(): void;
  };
};

test("accessibility tour", async ({ browser }) => {
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
    const board = e.createLayer("frame", { x: 0, y: 0, width: 393, height: 852 }, e.s.pageId, {
      name: "Home",
      fills: [{ type: "solid", color: "#ffffff" }],
    });
    const bar = e.createLayer("rect", { x: 0, y: 768, width: 393, height: 84 }, board, {
      name: "Tab bar",
      fills: [{ type: "solid", color: "#f2f0ec" }],
    });
    void bar;
    const id = e.createLayer("rect", { x: 40, y: 790, width: 22, height: 22 }, board, {
      name: "Close",
      fills: [{ type: "solid", color: "#1c1b19" }],
      cornerRadius: 6,
      reactions: [
        {
          id: "tapback000000000",
          trigger: { type: "tap" },
          action: { type: "back" },
          transition: {
            type: "dissolve",
            direction: "left",
            duration: 240,
            easing: { type: "ease-out" },
          },
        },
      ],
    });
    e.select([id]);
    e.zoomToFit();
  });
  await expect(page.getByRole("region", { name: "Accessibility" })).toBeVisible();
  await shot(page, "162-tap-target");
  await shot(page, "163-tap-target-close", page.getByRole("group", { name: "Properties" }));

  // The board's reading order, on the canvas and in the inspector.
  await page.evaluate(() => {
    const e = (
      window as unknown as {
        drawpane: W["drawpane"] & {
          doc: { childIds(id: string): string[] };
          state: { set(p: object): void };
        };
      }
    ).drawpane;
    const home = e.doc.childIds(e.s.pageId)[0] as string;
    const text = (characters: string, y: number, fontSize: number) =>
      e.createLayer("text", { x: 24, y, width: 320, height: fontSize + 6 }, home, {
        characters,
        fontSize,
        fills: [{ type: "solid", color: "#1c1b19" }],
      });
    text("Good morning, Ana", 72, 26);
    text("Three things on today", 110, 15);
    const card = (label: string, y: number) =>
      e.createLayer("frame", { x: 24, y, width: 345, height: 64 }, home, {
        name: label,
        fills: [{ type: "solid", color: "#f2f0ec" }],
        cornerRadius: 12,
        reactions: [
          {
            id: `tap${label.replace(/\W/g, "").slice(0, 13).padEnd(13, "0")}`,
            trigger: { type: "tap" },
            action: { type: "back" },
            transition: {
              type: "dissolve",
              direction: "left",
              duration: 240,
              easing: { type: "ease-out" },
            },
          },
        ],
      });
    card("Ship onboarding v2", 156);
    card("Token audit", 232);
    card("Icon review", 308);
    e.select([home]);
    e.state.set({ showReadingOrder: true });
    e.zoomToFit();
  });
  await expect(page.getByRole("list", { name: /Reading order of/ })).toBeVisible();
  await shot(page, "164-reading-order");
  await shot(page, "165-reading-order-close", page.getByRole("region", { name: "Accessibility" }));
  await context.close();
});
