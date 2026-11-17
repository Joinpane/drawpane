/**
 * Screenshots of a kit-shaped layer tree scrolled deep inside a component, in
 * the narrowest left pane, for design review in both themes: the ancestors of
 * the rows at the top stay pinned there, as in Figma; then the same, scrolled
 * sideways. The view is set by scroll position, so any build shoots the same one.
 * Run with `pnpm --filter @drawpane/web tour layers-pinned`.
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

test("pinned layers tour", async ({ browser }) => {
  test.setTimeout(120_000);
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await context.newPage();
  await passkey(context, page);
  await page.goto("/setup");
  await page.evaluate(() => {
    localStorage.setItem("drawpane:debug", "1");
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

  // A page of form blocks, shaped like a UI kit's: each variant a component of
  // auto layout frames, fields and text, six or seven levels deep.
  const target = await page.evaluate(() => {
    const e = (window as unknown as { drawpane: E }).drawpane;
    const frame = (parent: string, name: string, props: Record<string, unknown> = {}) =>
      e.createLayer("frame", { x: 0, y: 0, width: 320, height: 80 }, parent, { name, ...props });
    const text = (parent: string, characters: string, props: Record<string, unknown> = {}) =>
      e.createLayer("text", { x: 0, y: 0, width: 200, height: 20 }, parent, {
        name: characters,
        characters,
        ...props,
      });
    const blocks = frame(e.s.pageId, "Blocks / Forms", { isComponentSet: true });
    let deep = "";
    for (const variant of ["Account", "Profile", "Notifications", "Display"]) {
      for (const size of ["sm", "lg"]) {
        const v = frame(blocks, `Type=${variant}, Size=${size}`, { isComponent: true });
        const flex = frame(v, "Flex", { layoutMode: "row" });
        frame(flex, "Aside", { layoutMode: "column" });
        const column = frame(flex, "Flex Vertical", { layoutMode: "column" });
        frame(column, "Flex Vertical", { layoutMode: "column" });
        frame(column, "Separator", { isComponent: true });
        const form = frame(column, "Form", { layoutMode: "column" });
        for (const label of ["Email", "Password", "Bio"]) {
          const field = frame(form, "Field", { isComponent: true, layoutMode: "column" });
          text(field, label);
          const textarea = frame(field, "Textarea", { isComponent: true, layoutMode: "column" });
          const placeholder = text(textarea, "PlaceholderText");
          text(field, "This is an input description.");
          text(field, "Forgot your password?", { visible: false });
          if (variant === "Profile" && size === "lg" && label === "Password") deep = placeholder;
        }
        frame(form, "Flex Vertical", { layoutMode: "column" });
        frame(form, "Button", { isComponent: true });
        frame(column, "Separator", { isComponent: true });
      }
    }
    e.select([]);
    return deep;
  });

  const pane = page.locator(".pane--left");
  const scroller = page.locator(".layers__scroll");
  // Scrolled so the placeholder deep in a field sits a few rows down: the same view on any build.
  await page.evaluate((id) => (window as unknown as { drawpane: E }).drawpane.select([id]), target);
  const top = await page
    .locator(`.layers__list [data-layer-id="${target}"]`)
    .evaluate((el) => (el as HTMLElement).offsetTop);
  await page.evaluate(() => (window as unknown as { drawpane: E }).drawpane.select([]));
  await page.keyboard.press("Shift+1");
  await scroller.evaluate(
    (el, t) => {
      el.scrollLeft = 0;
      el.scrollTop = t;
    },
    top - 7 * 28,
  );
  await shot(page, "117-layers-pinned", pane);

  // Scrolled sideways: the pinned rows move with the tree, guides and all.
  await scroller.evaluate((el) => {
    el.scrollLeft = 48;
  });
  await shot(page, "118-layers-pinned-sideways", pane);
  await context.close();
});
