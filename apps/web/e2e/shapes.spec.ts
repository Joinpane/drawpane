/**
 * Polygons, stars, arrows and angular gradients in a real browser, on a
 * throwaway instance: the shape menu, the Star section, flattening, stroke
 * ends and the Angular gradient tab.
 */
import { expect, type Page, test } from "@playwright/test";
import { freshInstance, type Instance } from "./fresh-instance";

type Debug = {
  s: { selection: string[]; tool: string };
  doc: { get(id: string): { type: string; props: Record<string, unknown> } | undefined };
};
const selected = (page: Page) =>
  page.evaluate(() => {
    const e = (window as unknown as { drawpane: Debug }).drawpane;
    const node = e.doc.get(e.s.selection[0] ?? "");
    return node ? { type: node.type, props: node.props } : null;
  });
const panel = (page: Page) => page.getByRole("group", { name: "Properties" });

test.describe
  .serial("Shapes", () => {
    test.skip(!!process.env.E2E_BASE_URL, "Needs its own local instance.");

    let instance: Instance;
    let page: Page;

    test.beforeAll(async ({ browser }) => {
      test.setTimeout(180_000);
      instance = await freshInstance(browser, { port: 8781, inspectorPort: 9321 });
      page = instance.page;
      await page.evaluate(() => localStorage.setItem("drawpane:debug", "1"));
      await page.getByRole("button", { name: "New file" }).first().click();
      await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
        timeout: 15_000,
      });
    });

    test.afterAll(async () => {
      await instance?.stop();
    });

    test("draws a star from the shape menu and shapes it in the inspector", async () => {
      await page.getByRole("button", { name: "More shapes" }).click();
      await page.getByRole("menuitem", { name: /^Star/ }).click();
      // The toolbar's shape button now shows the star.
      await expect(
        page.getByRole("toolbar", { name: "Tools" }).getByRole("button", { name: "Star" }),
      ).toHaveAttribute("aria-pressed", "true");
      await page.mouse.move(600, 300);
      await page.mouse.down();
      await page.mouse.move(700, 400, { steps: 4 });
      await page.mouse.up();
      expect(await selected(page)).toMatchObject({ type: "star", props: { pointCount: 5 } });

      await panel(page).getByLabel("Points").fill("8");
      await panel(page).getByLabel("Points").press("Enter");
      await panel(page).getByLabel("Inner radius ratio").fill("60");
      await panel(page).getByLabel("Inner radius ratio").press("Enter");
      await expect
        .poll(async () => (await selected(page))?.props)
        .toMatchObject({ pointCount: 8, innerRadius: 0.6 });

      // Flattening turns it into an editable path with all 16 corners.
      // (Leave the field first: shortcuts don't fire while you type.)
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.keyboard.press("ControlOrMeta+e");
      await expect.poll(async () => (await selected(page))?.type).toBe("path");
      const d = (await selected(page))?.props.pathData as string;
      expect(d.match(/L/g)?.length).toBe(15);
    });

    test("draws an arrow with ⇧L and changes its ends", async () => {
      await page.keyboard.press("Shift+L");
      await page.mouse.move(500, 600);
      await page.mouse.down();
      await page.mouse.move(800, 600, { steps: 4 });
      await page.mouse.up();
      expect(await selected(page)).toMatchObject({ type: "line", props: { markerEnd: "arrow" } });
      await panel(page).getByLabel("Start of the stroke").selectOption("circle");
      await expect.poll(async () => (await selected(page))?.props.markerStart).toBe("circle");
      await panel(page).getByRole("button", { name: "Swap ends" }).click();
      await expect
        .poll(async () => (await selected(page))?.props)
        .toMatchObject({ markerStart: "arrow", markerEnd: "circle" });
    });

    test("fills a polygon with an angular gradient", async () => {
      await page.getByRole("button", { name: "More shapes" }).click();
      await page.getByRole("menuitem", { name: /^Polygon/ }).click();
      await page.mouse.click(1000, 300);
      expect((await selected(page))?.type).toBe("polygon");
      await panel(page).getByRole("button", { name: "Edit fill" }).click();
      const picker = page.getByRole("dialog", { name: "Fill paint" });
      await picker.getByRole("radio", { name: "Gradient" }).click();
      await picker.getByRole("radio", { name: "Angular" }).click();
      await picker.getByLabel("Gradient angle").fill("90");
      await picker.getByLabel("Gradient angle").press("Enter");
      await expect
        .poll(
          async () =>
            (
              (await selected(page))?.props.fills as
                | Array<{ type: string; to: unknown }>
                | undefined
            )?.[0],
        )
        .toMatchObject({ type: "angular", to: { x: 1, y: 0.5 } });
    });
  });
