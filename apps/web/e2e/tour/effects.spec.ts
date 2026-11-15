/**
 * Screenshots of the effects that work on what's behind or on the layer's
 * picture, for design review: glass on a card and on text over a busy
 * backdrop, the effect menu, and the glass, noise, texture and background
 * blur editors, in both themes. Run with `pnpm --filter @drawpane/web tour`.
 */
import { expect } from "@playwright/test";
import { passkey, shot, test } from "./harness";

type Debug = {
  s: { pageId: string };
  createLayer(
    type: string,
    rect: { x: number; y: number; width: number; height: number },
    parent: string,
    props?: Record<string, unknown>,
  ): string | null;
  select(ids: string[]): void;
  zoomToFit(): void;
};

const GLASS = {
  type: "glass",
  angle: -45,
  intensity: 80,
  refraction: 80,
  depth: 20,
  dispersion: 50,
  frost: 4,
  splay: 0,
};

test("effects tour", async ({ browser }) => {
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

  const ids = await page.evaluate((glass) => {
    const e = (window as unknown as { drawpane: Debug }).drawpane;
    const board = e.createLayer("frame", { x: 0, y: 0, width: 720, height: 480 }, e.s.pageId, {
      name: "Wallpaper",
      fills: [
        {
          type: "linear",
          from: { x: 0, y: 0 },
          to: { x: 1, y: 1 },
          stops: [
            { position: 0, color: "#ff7a45" },
            { position: 0.5, color: "#ffd166" },
            { position: 1, color: "#3d7bf0" },
          ],
        },
      ],
    }) as string;
    // Something for the glass to bend: soft blobs and a headline.
    for (const [x, y, size, color] of [
      [60, 260, 220, "#e8590c"],
      [420, 40, 260, "#2b4fd6"],
      [300, 300, 160, "#12b886"],
    ] as const)
      e.createLayer("ellipse", { x, y, width: size, height: size }, board, {
        fills: [{ type: "solid", color }],
      });
    e.createLayer("text", { x: 48, y: 48, width: 400, height: 80 }, board, {
      characters: "Weekend in Lisbon",
      fontSize: 56,
      fontWeight: 800,
      fills: [{ type: "solid", color: "#1c1b1a" }],
    });
    const card = e.createLayer("rect", { x: 140, y: 150, width: 320, height: 200 }, board, {
      name: "Glass card",
      cornerRadius: 32,
      fills: [{ type: "solid", color: "#ffffff22" }],
      effects: [glass],
    }) as string;
    const title = e.createLayer("text", { x: 480, y: 360, width: 200, height: 80 }, board, {
      name: "Glass title",
      characters: "Lumen",
      fontSize: 72,
      fontWeight: 800,
      fills: [{ type: "solid", color: "#ffffff33" }],
      effects: [glass],
    }) as string;
    const grain = e.createLayer("rect", { x: 520, y: 180, width: 160, height: 120 }, board, {
      name: "Grain",
      cornerRadius: 20,
      fills: [{ type: "solid", color: "#1c1b1a" }],
      effects: [
        {
          type: "noise",
          noiseType: "mono",
          size: 2,
          density: 60,
          color: "#ffffff66",
          secondaryColor: "#00000000",
          opacity: 100,
        },
        { type: "texture", size: 4, radius: 6, clipToShape: false },
      ],
    }) as string;
    const frosted = e.createLayer("rect", { x: 40, y: 400, width: 260, height: 56 }, board, {
      name: "Frosted bar",
      cornerRadius: 28,
      fills: [{ type: "solid", color: "#ffffff66" }],
      effects: [{ type: "background-blur", radius: 24 }],
    }) as string;
    e.zoomToFit();
    return { card, title, grain, frosted };
  }, GLASS);
  const select = (id: string) =>
    page.evaluate((i) => (window as unknown as { drawpane: Debug }).drawpane.select([i]), id);
  const inspector = page.getByRole("complementary", { name: "Inspector" });

  // Glass on a card, its editor open beside the inspector.
  await select(ids.card);
  await inspector.getByRole("button", { name: /^Glass/ }).click();
  await expect(page.getByRole("dialog", { name: "Glass" })).toBeVisible();
  await shot(page, "166-glass-editor");
  await page.keyboard.press("Escape");

  // Glass on text: each glyph a lens.
  await select(ids.title);
  await shot(page, "167-glass-text");

  // The effect menu.
  await inspector.getByRole("button", { name: "Add effect" }).click();
  await expect(page.getByRole("menu", { name: "Add effect" })).toBeVisible();
  await shot(page, "168-add-effect-menu");
  await page.keyboard.press("Escape");

  // Noise and texture on one layer.
  await select(ids.grain);
  await inspector.getByRole("button", { name: /^Noise/ }).click();
  await expect(page.getByRole("dialog", { name: "Noise" })).toBeVisible();
  await shot(page, "169-noise-editor");
  await page.keyboard.press("Escape");
  await inspector.getByRole("button", { name: /^Texture/ }).click();
  await expect(page.getByRole("dialog", { name: "Texture" })).toBeVisible();
  await shot(page, "170-texture-editor");
  await page.keyboard.press("Escape");

  // Background blur.
  await select(ids.frosted);
  await inspector.getByRole("button", { name: /^Background blur/ }).click();
  await shot(page, "171-background-blur");
  await page.keyboard.press("Escape");
});
