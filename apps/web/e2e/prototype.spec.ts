/**
 * Prototyping in a real browser: drag a connection from a layer onto a screen,
 * then play the prototype and tap through it, go back, and open and dismiss
 * an overlay. Runs on its own throwaway instance.
 */
import { expect, type Page, test } from "@playwright/test";
import { freshInstance, type Instance } from "./fresh-instance";
import { buildMobileApp, type MobileApp } from "./prototype-fixture";

/** A point on a layer, in page (CSS) pixels: its right edge middle, or a fraction across it. */
async function screenPoint(page: Page, id: string, fx = 1, fy = 0.5) {
  return page.evaluate(
    ({ id, fx, fy }) => {
      const e = (
        window as unknown as {
          drawpane: {
            scene: { bounds(id: string): { x: number; y: number; width: number; height: number } };
            s: { camera: { toScreen(p: { x: number; y: number }): { x: number; y: number } } };
          };
        }
      ).drawpane;
      const b = e.scene.bounds(id);
      const canvas = document.querySelector(".canvas__overlay") as HTMLElement;
      const r = canvas.getBoundingClientRect();
      const p = e.s.camera.toScreen({ x: b.x + b.width * fx, y: b.y + b.height * fy });
      return { x: r.left + p.x, y: r.top + p.y };
    },
    { id, fx, fy },
  );
}

const reactionsOf = (page: Page, id: string) =>
  page.evaluate(
    (id) =>
      (
        window as unknown as {
          drawpane: { doc: { get(id: string): { props: { reactions?: unknown[] } } | undefined } };
        }
      ).drawpane.doc.get(id)?.props.reactions ?? [],
    id,
  );

test.describe
  .serial("Prototyping", () => {
    test.skip(!!process.env.E2E_BASE_URL, "Needs its own local instance.");

    let instance: Instance;
    let page: Page;
    let app: MobileApp;

    test.beforeAll(async ({ browser }) => {
      test.setTimeout(180_000);
      instance = await freshInstance(browser, { port: 8797, inspectorPort: 9337 });
      page = instance.page;
      await page.evaluate(() => localStorage.setItem("drawpane:debug", "1"));
    });

    test.afterAll(async () => {
      await instance?.stop();
    });

    test("drags a connection from a layer onto a screen", async () => {
      await page.getByRole("button", { name: "New file" }).first().click();
      await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
        timeout: 15_000,
      });
      app = await buildMobileApp(page);
      await page.keyboard.press("Shift+1");

      await page.getByRole("radio", { name: "Prototype" }).click();
      // The second event row has no interaction yet.
      const second = await page.evaluate((row) => {
        const e = (
          window as unknown as {
            drawpane: {
              doc: {
                get(id: string): { parent: string } | undefined;
                childIds(id: string): string[];
              };
            };
          }
        ).drawpane;
        const list = e.doc.get(row)?.parent as string;
        return e.doc.childIds(list)[1] as string;
      }, app.row);
      await page.evaluate(
        (id) =>
          (window as unknown as { drawpane: { select(ids: string[]): void } }).drawpane.select([
            id,
          ]),
        second,
      );
      await expect(page.getByText("Drag the handle on the canvas onto a screen")).toBeVisible();

      const handle = await screenPoint(page, second);
      const target = await screenPoint(page, app.detail, 0.5, 0.4);
      await page.mouse.move(handle.x, handle.y);
      await page.mouse.down();
      await page.mouse.move((handle.x + target.x) / 2, target.y, { steps: 6 });
      await page.mouse.move(target.x, target.y, { steps: 6 });
      await page.mouse.up();

      expect(await reactionsOf(page, second)).toMatchObject([
        { trigger: { type: "tap" }, action: { type: "navigate", to: app.detail } },
      ]);
      await expect(
        page.getByRole("button", { name: /On tap\s*Navigate to Event detail/ }),
      ).toBeVisible();

      // Undo takes the connection back off in one step.
      await page.keyboard.press("Control+z");
      expect(await reactionsOf(page, second)).toEqual([]);
      await page.keyboard.press("Control+Shift+z");
      expect(await reactionsOf(page, second)).toHaveLength(1);
    });

    test("edits an interaction's transition in the Prototype tab", async () => {
      await page.evaluate(
        (id) =>
          (window as unknown as { drawpane: { select(ids: string[]): void } }).drawpane.select([
            id,
          ]),
        app.row,
      );
      await page.getByLabel("Transition").selectOption("push");
      await page.getByRole("radio", { name: "Spring" }).click();
      expect(await reactionsOf(page, app.row)).toMatchObject([
        { transition: { type: "push", easing: { type: "spring" } } },
      ]);
      await expect(page.getByText(/Settles in \d+ ms/)).toBeVisible();
    });

    test("plays the prototype: taps through, goes back, opens and closes an overlay", async () => {
      await page.getByRole("button", { name: "Play prototype" }).click();
      await expect(page).toHaveURL(/\/present/);
      const count = page.locator(".present__count");
      await expect(count).toHaveText("Screen 1 of 3");
      const viewport = page.locator(".stage__viewport");
      await expect(viewport.locator("canvas")).toHaveCount(1);
      const box = await viewport.boundingBox();
      if (!box) throw new Error("no viewport");
      const at = (fx: number, fy: number) =>
        page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);

      // Empty space: hotspots flash and a hint says why.
      await at(0.5, 0.65);
      await expect(page.getByText("Highlighted areas are clickable")).toBeVisible();
      await expect(page.locator(".stage__hotspot").first()).toBeAttached();

      // The first event row goes to the detail screen.
      await at(0.5, 0.3);
      await expect(count).toHaveText("Screen 2 of 3");
      await expect(page.getByRole("button", { name: /Event detail/ })).toHaveAttribute(
        "aria-current",
        "true",
      );

      // Mark done opens the sheet over the bottom of the screen, dimming the rest.
      await page.waitForTimeout(700);
      await at(0.5, 0.9);
      await expect(viewport.locator(".stage__overlay")).toHaveCount(1);
      await expect(viewport.locator(".stage__dim")).toHaveCount(1);
      // Tapping outside closes it.
      await at(0.5, 0.15);
      await expect(viewport.locator(".stage__overlay")).toHaveCount(0, { timeout: 3000 });

      // Escape goes back.
      await page.keyboard.press("Escape");
      await expect(count).toHaveText("Screen 1 of 3");

      // The arrow keys move through the flow's screens; R restarts.
      await page.keyboard.press("ArrowRight");
      await expect(count).toHaveText("Screen 2 of 3");
      await page.keyboard.press("r");
      await expect(count).toHaveText("Screen 1 of 3");

      // Back to the editor.
      await page.getByRole("link", { name: "Back to editor" }).click();
      await expect(page.getByRole("radio", { name: "Prototype" })).toBeVisible();
    });

    test("updates live while it plays", async () => {
      await page.getByRole("button", { name: "Play prototype" }).click();
      await expect(page.locator(".present__count")).toHaveText("Screen 1 of 3");
      // Another tab renames a screen; the screens list follows without a reload.
      const other = await instance.context.newPage();
      await other.goto(page.url().replace(/\/present.*$/, ""));
      await expect(other.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
        timeout: 15_000,
      });
      await other.evaluate(
        (id) =>
          (
            window as unknown as { drawpane: { rename(id: string, name: string): void } }
          ).drawpane.rename(id, "Today detail"),
        app.detail,
      );
      await expect(page.getByRole("button", { name: /Today detail/ })).toBeVisible({
        timeout: 10_000,
      });
      await other.close();
    });
  });
