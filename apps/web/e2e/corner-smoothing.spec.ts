/**
 * Corner smoothing in the inspector, in a real browser (decision 0041): the
 * iOS stop, typing and dragging (one undo step each), a selection that
 * differs (Mixed) and setting it for all of it, and the canvas drawing the
 * smoothed corner: a pixel a plain corner covers along its edge is
 * background once smoothed. Runs on its own throwaway instance.
 */
import { expect, type Page, test } from "@playwright/test";
import { freshInstance, type Instance } from "./fresh-instance";

type Debug = {
  s: {
    pageId: string;
    camera: { toScreen(p: { x: number; y: number }): { x: number; y: number } };
  };
  createLayer(
    type: string,
    rect: { x: number; y: number; width: number; height: number },
    parent: string,
    props?: Record<string, unknown>,
  ): string | null;
  select(ids: string[]): void;
  zoomTo(z: number): void;
  centerOn(p: { x: number; y: number }): void;
  doc: { get(id: string): { props: Record<string, unknown> } | undefined };
};

const props = (page: Page, id: string) =>
  page.evaluate(
    (id) => (window as unknown as { drawpane: Debug }).drawpane.doc.get(id)?.props ?? {},
    id,
  );

/** Whether the canvas is covered by the dark fill at a page point (opaque, and dark). */
const dark = (page: Page, point: { x: number; y: number }) =>
  page.evaluate((point) => {
    const e = (window as unknown as { drawpane: Debug }).drawpane;
    const canvas = document.querySelector(".canvas canvas") as HTMLCanvasElement;
    const ratio = canvas.width / canvas.getBoundingClientRect().width;
    const p = e.s.camera.toScreen(point);
    const d = (canvas.getContext("2d") as CanvasRenderingContext2D).getImageData(
      Math.round(p.x * ratio),
      Math.round(p.y * ratio),
      1,
      1,
    ).data;
    return (d[3] ?? 0) > 230 && (d[0] ?? 0) + (d[1] ?? 0) + (d[2] ?? 0) < 200;
  }, point);

const select = (page: Page, ids: string[]) =>
  page.evaluate((ids) => (window as unknown as { drawpane: Debug }).drawpane.select(ids), ids);

/** The design inspector, not the floating Selection Lens. */
const panel = (page: Page) => page.getByRole("group", { name: "Properties" });

test.describe
  .serial("Corner smoothing", () => {
    test.skip(!!process.env.E2E_BASE_URL, "Needs its own local instance.");

    let instance: Instance;
    let page: Page;
    let a: string;
    let b: string;

    test.beforeAll(async ({ browser }) => {
      test.setTimeout(180_000);
      instance = await freshInstance(browser, { port: 9051, inspectorPort: 9591 });
      page = instance.page;
      await page.evaluate(() => localStorage.setItem("drawpane:debug", "1"));
      await page.getByRole("button", { name: "New file" }).first().click();
      await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
        timeout: 15_000,
      });
      [a, b] = await page.evaluate(() => {
        const e = (window as unknown as { drawpane: Debug }).drawpane;
        const dark = [{ type: "solid", color: "#1c1b1a" }];
        const one = e.createLayer("rect", { x: 0, y: 0, width: 200, height: 120 }, e.s.pageId, {
          cornerRadius: 40,
          fills: dark,
        }) as string;
        const two = e.createLayer("rect", { x: 260, y: 0, width: 200, height: 120 }, e.s.pageId, {
          cornerRadius: 40,
          fills: dark,
        }) as string;
        e.zoomTo(4);
        e.centerOn({ x: 40, y: 20 });
        return [one, two];
      });
    });

    test.afterAll(async () => {
      await instance?.stop();
    });

    test("the iOS stop sets 60%, smooths the corner on the canvas, and undoes", async () => {
      await select(page, [a]);
      const slider = panel(page).getByRole("slider", { name: "Corner smoothing" });
      await expect(slider).toHaveValue("0");
      // 36 px along the top edge, just inside it: a plain 40 px corner is already dark there, a
      // smoothed one (reaching 64 px) is still curving in.
      const probe = { x: 36, y: 0.6 };
      expect(await dark(page, probe)).toBe(true);
      await panel(page)
        .getByRole("button", { name: /^Corner smoothing: iOS/ })
        .click();
      expect(await props(page, a)).toMatchObject({ cornerSmoothing: 0.6 });
      await expect(slider).toHaveValue("60");
      await expect.poll(() => dark(page, probe)).toBe(false);
      await page.keyboard.press("ControlOrMeta+z");
      await expect.poll(async () => (await props(page, a)).cornerSmoothing).toBeUndefined();
      await expect.poll(() => dark(page, probe)).toBe(true);
    });

    test("types a value, and a drag is one undo step", async () => {
      await select(page, [a]);
      const field = panel(page).getByLabel("Corner smoothing value");
      await field.fill("35");
      await field.press("Enter");
      await expect.poll(async () => (await props(page, a)).cornerSmoothing).toBe(0.35);
      const slider = panel(page).getByRole("slider", { name: "Corner smoothing" });
      const box = (await slider.boundingBox()) as {
        x: number;
        y: number;
        width: number;
        height: number;
      };
      await page.mouse.move(box.x + box.width * 0.36, box.y + box.height / 2);
      await page.mouse.down();
      for (const share of [0.5, 0.7, 0.9])
        await page.mouse.move(box.x + box.width * share, box.y + box.height / 2, { steps: 3 });
      await page.mouse.up();
      const dragged = (await props(page, a)).cornerSmoothing as number;
      expect(dragged).toBeGreaterThan(0.8);
      // Keys in a focused field are the field's (as for every slider): undo from outside it.
      await slider.blur();
      await page.keyboard.press("ControlOrMeta+z");
      await expect.poll(async () => (await props(page, a)).cornerSmoothing).toBe(0.35);
      // Back to none: no property at all.
      await field.fill("0");
      await field.press("Enter");
      await expect.poll(async () => (await props(page, a)).cornerSmoothing).toBeUndefined();
    });

    test("a selection that differs shows Mixed, and setting it sets all of it", async () => {
      await select(page, [b]);
      await panel(page)
        .getByRole("button", { name: /^Corner smoothing: iOS/ })
        .click();
      await select(page, [a, b]);
      const field = panel(page).getByLabel("Corner smoothing value");
      await expect(field).toHaveValue("");
      await expect(field).toHaveAttribute("placeholder", "Mixed");
      await field.fill("100");
      await field.press("Enter");
      await field.blur();
      expect((await props(page, a)).cornerSmoothing).toBe(1);
      expect((await props(page, b)).cornerSmoothing).toBe(1);
      await page.keyboard.press("ControlOrMeta+z");
      await expect.poll(async () => (await props(page, a)).cornerSmoothing).toBeUndefined();
      expect((await props(page, b)).cornerSmoothing).toBe(0.6);
    });
  });
