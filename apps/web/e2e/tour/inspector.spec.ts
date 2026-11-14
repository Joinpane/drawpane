/**
 * Screenshots of the inspector in depth for design review: frame presets,
 * the color picker (solid and gradient), effects, per-corner radius, strokes,
 * constraints, text and selection colors, in both themes.
 * Run with `pnpm --filter @drawpane/web tour`.
 */
import { expect, type Page } from "@playwright/test";
import { buildMobileApp } from "../prototype-fixture";
import { passkey, shot, test } from "./harness";

type Debug = {
  commit(ops: unknown[], label?: string): boolean;
  select(ids: string[]): void;
};

async function select(page: Page, ids: string[]) {
  await page.evaluate((i) => (window as unknown as { drawpane: Debug }).drawpane.select(i), ids);
}

async function commit(page: Page, ops: unknown[]) {
  await page.evaluate((o) => (window as unknown as { drawpane: Debug }).drawpane.commit(o), ops);
}

test("inspector tour", async ({ browser }) => {
  test.setTimeout(180_000);
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

  // Frame tool: presets in the inspector.
  await page.keyboard.press("f");
  await expect(page.getByRole("button", { name: /^iPhone 18 Pro 402/ })).toBeVisible();
  await shot(page, "60-frame-presets");
  await page
    .getByRole("button", { name: /^iPhone 18 Pro 402/ })
    .first()
    .click();
  await expect(page.getByLabel("Frame size")).toBeVisible();
  await shot(page, "61-frame-selected");

  const ids = await buildMobileApp(page);
  await page.keyboard.press("Shift+1");

  // A card: fill picker on Solid, with contrast and file colors.
  await select(page, [ids.done]);
  await page.getByRole("button", { name: "Edit fill" }).first().click();
  await expect(page.getByRole("dialog", { name: "Fill paint" })).toBeVisible();
  await shot(page, "62-picker-solid");

  // Gradient tab.
  await page
    .getByRole("dialog", { name: "Fill paint" })
    .getByRole("radio", { name: "Gradient" })
    .click();
  await expect(page.getByRole("button", { name: "Gradient start" })).toBeVisible();
  await shot(page, "63-picker-gradient");
  await page.keyboard.press("Escape");

  // Effects with a shadow open, and independent corners.
  await commit(page, [
    {
      op: "set",
      id: ids.done,
      prop: "effects",
      value: [{ type: "drop-shadow", color: "#1c1b1a33", x: 0, y: 6, blur: 18, spread: -2 }],
    },
  ]);
  await page.getByRole("button", { name: /Drop shadow/ }).click();
  await page.getByRole("button", { name: "Independent corners" }).click();
  await page.getByLabel("Top left radius").fill("20");
  await page.getByLabel("Top left radius").press("Enter");
  await shot(page, "64-effects-corners");
  await page.getByRole("button", { name: "Edit shadow color" }).click();
  await shot(page, "65-shadow-color");
  await page.keyboard.press("Escape");

  // A text layer.
  await select(page, [ids.row]);
  await shot(page, "66-text");

  // A whole screen: selection colors.
  await select(page, [ids.home]);
  await shot(page, "67-selection-colors");

  // A layer inside a frame: constraints.
  await select(page, [ids.back]);
  await page.getByRole("button", { name: "Pin to right" }).click();
  await shot(page, "68-constraints");

  // Several layers: align and distribute.
  await select(page, [ids.home, ids.detail, ids.sheet]);
  await shot(page, "69-multi");
});
