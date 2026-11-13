/**
 * Cropping an image in a real browser: drop a photo, double-click to crop,
 * drag a handle, pick a preset, finish with Done, and see the canvas show
 * only the cropped part. Runs on its own throwaway instance.
 */
import { expect, type Page, test } from "@playwright/test";
import { canvasColor, dropImage, freshInstance, type Instance } from "./fresh-instance";

const ORANGE = "#ff5a1f";
const BLUE = "#2b4fd6";

type Debug = {
  s: { selection: string[]; cropping: { id: string } | null };
  doc: { get(id: string): { props: Record<string, unknown> } | undefined };
};
const state = (page: Page) =>
  page.evaluate(() => {
    const e = (window as unknown as { drawpane: Debug }).drawpane;
    const id = e.s.selection[0] ?? "";
    const props = e.doc.get(id)?.props ?? {};
    return {
      cropping: e.s.cropping?.id ?? null,
      width: props.width as number,
      height: props.height as number,
      fill: (props.fills as Array<{ scaleMode: string; crop?: { x: number; width: number } }>)?.[0],
    };
  });

test.describe
  .serial("Cropping images", () => {
    test.skip(!!process.env.E2E_BASE_URL, "Needs its own local instance.");

    let instance: Instance;
    let page: Page;

    test.beforeAll(async ({ browser }) => {
      test.setTimeout(180_000);
      instance = await freshInstance(browser, { port: 8777, inspectorPort: 9317 });
      page = instance.page;
      await page.evaluate(() => localStorage.setItem("drawpane:debug", "1"));
      await page.getByRole("button", { name: "New file" }).first().click();
      await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
        timeout: 15_000,
      });
      // 240 × 160 at 100%: blue on the left half, orange on the right, centred at (720, 450).
      await dropImage(
        page,
        { x: 720, y: 450 },
        {
          name: "photo.png",
          width: 240,
          height: 160,
          colors: [BLUE, ORANGE],
        },
      );
      await expect(page.getByRole("region", { name: "Image uploads" })).toContainText("Done");
      await expect.poll(() => canvasColor(page, { x: 780, y: 450 })).toBe(ORANGE);
    });

    test.afterAll(async () => {
      await instance?.stop();
    });

    test("double-click crops; dragging the right edge cuts the orange away", async () => {
      await page.mouse.dblclick(720, 450);
      await expect.poll(async () => (await state(page)).cropping).not.toBeNull();
      await expect(page.getByRole("toolbar", { name: "Crop" })).toBeVisible();
      // The right edge from x 840 to 720: only the blue half is left.
      await page.mouse.move(840, 450);
      await page.mouse.down();
      await page.mouse.move(780, 450, { steps: 4 });
      await page.mouse.move(720, 450, { steps: 4 });
      await page.mouse.up();
      const after = await state(page);
      expect(after.width).toBe(120);
      expect(after.fill).toMatchObject({ scaleMode: "crop", crop: { x: 0, width: 0.5 } });
      // The orange half shows only dimmed, outside the box.
      expect(await canvasColor(page, { x: 680, y: 450 })).toBe(BLUE);
    });

    test("a preset reshapes the crop; Done finishes", async () => {
      await page.getByRole("toolbar", { name: "Crop" }).getByRole("radio", { name: "1:1" }).click();
      await expect
        .poll(async () => {
          const s = await state(page);
          return Math.round((s.width / s.height) * 100) / 100;
        })
        .toBe(1);
      await page.getByRole("button", { name: "Done" }).click();
      await expect.poll(async () => (await state(page)).cropping).toBeNull();
      await expect(page.getByRole("toolbar", { name: "Crop" })).toHaveCount(0);
      // Undo walks back through the crop.
      await page.keyboard.press("ControlOrMeta+z");
      await expect.poll(async () => (await state(page)).width).toBe(120);
    });
  });
