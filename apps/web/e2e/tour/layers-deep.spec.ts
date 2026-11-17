/**
 * Screenshots of a deep layer tree in the narrowest left pane, for design
 * review in both themes: a kit-like tree 13 levels deep with locked and hidden
 * layers, as it opens; with its deepest layer selected from the canvas (the
 * tree scrolls across to it); and with an unlocked row hovered (the faint
 * offers to lock and hide).
 * Run with `pnpm --filter @drawpane/web tour layers-deep`.
 */
import { expect } from "@playwright/test";
import { passkey, shot, test } from "./harness";

type E = {
  s: { pageId: string };
  createLayer(
    type: string,
    rect: { x: number; y: number; width: number; height: number },
    parent: string,
    props?: Record<string, unknown>,
  ): string;
  select(ids: string[]): void;
};

test("deep layers tour", async ({ browser }) => {
  test.setTimeout(120_000);
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await context.newPage();
  await passkey(context, page);
  await page.goto("/setup");
  await page.evaluate(() => {
    localStorage.setItem("drawpane:debug", "1");
    // The narrowest left pane, and a short pages list: room for the tree.
    localStorage.setItem(
      "drawpane:panels",
      JSON.stringify({ left: 240, right: 264, pages: 42, minimized: false }),
    );
  });
  await page.getByLabel("Your name").fill("Ana Lima");
  await page.getByLabel("Email").fill("ana@example.com");
  await page.getByLabel("Setup token").fill(process.env.E2E_SETUP_TOKEN ?? "e2e-setup-token");
  await page.getByRole("button", { name: "Create account with a passkey" }).click();
  await expect(page.getByRole("heading", { name: "Recent files" })).toBeVisible();
  await page.getByRole("button", { name: "New file" }).first().click();
  await expect(page.getByRole("status")).toContainText("Saved", { timeout: 15_000 });

  const deepest = await page.evaluate(() => {
    const e = (window as unknown as { drawpane: E }).drawpane;
    // Nested the way a UI kit's icon buttons are: frames in frames, 13 levels down.
    const names = [
      "Lucide Icons",
      "Alert Dialog",
      "_AlertDialogFooter",
      "Button",
      "Kbd Group",
      "Item",
      "Key",
      "Icon slot",
      "Icon",
      "Glyph frame",
      "Stroke group",
      "Outline",
    ];
    let parent = e.s.pageId;
    let size = 600;
    for (const [i, name] of names.entries()) {
      parent = e.createLayer("frame", { x: 8, y: 8, width: size, height: size }, parent, {
        name,
        layoutMode: i % 3 === 1 ? "column" : i % 3 === 2 ? "row" : null,
        fills: [{ type: "solid", color: i % 2 ? "#eef0f3" : "#ffffff" }],
        // Kbd Group is locked; the icon slot is hidden (so everything in it reads dimmed).
        ...(name === "Kbd Group" ? { locked: true } : {}),
        ...(name === "Icon slot" ? { visible: false } : {}),
      });
      size -= 40;
      if (i >= 8)
        e.createLayer("rect", { x: 4, y: 4, width: 8, height: 8 }, parent, {
          name: "Vector",
          ...(i === 9 ? { locked: true } : {}),
        });
    }
    return e.createLayer("rect", { x: 4, y: 4, width: 40, height: 40 }, parent, {
      name: "Arrow path",
      fills: [{ type: "solid", color: "#e04f1a" }],
    });
  });

  const pane = page.locator(".pane--left");
  await page.evaluate(() => (window as unknown as { drawpane: E }).drawpane.select([]));
  await page.keyboard.press("Shift+1");
  await shot(page, "114-layers-deep", pane);

  // Selecting the deepest layer (as from the canvas) brings its row and name into view.
  await page.evaluate(
    (id) => (window as unknown as { drawpane: E }).drawpane.select([id]),
    deepest,
  );
  await shot(page, "115-layers-deep-selected", pane);

  // Hovering an unlocked row offers, faintly, to lock and hide it.
  await page
    .getByRole("tree", { name: "Layers" })
    .getByRole("treeitem", { name: /^Stroke group/ })
    .hover();
  await shot(page, "116-layers-deep-hover", pane);
  await context.close();
});
