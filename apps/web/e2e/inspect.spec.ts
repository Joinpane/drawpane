/**
 * Inspect and SVG: export draws shadows and layer blur the way the canvas
 * does (the same card as PNG, from the canvas renderer, and as SVG,
 * rasterized by the browser, match within antialiasing); Inspect shows the
 * selection as readable SVG to copy; and a viewer lands on Inspect.
 */
import { readFileSync } from "node:fs";
import { type Download, expect, type Page, test } from "@playwright/test";
import { addPasskey, freshInstance, type Instance } from "./fresh-instance";

interface Debug {
  s: { pageId: string };
  createLayer(
    type: string,
    rect: { x: number; y: number; width: number; height: number },
    parent: string,
    props?: Record<string, unknown>,
  ): string | null;
  select(ids: string[]): void;
}
type W = { drawpane: Debug };

const saved = async (page: Page, start: () => Promise<void>): Promise<Download> => {
  const [download] = await Promise.all([page.waitForEvent("download"), start()]);
  return download;
};

test.describe
  .serial("Inspect and SVG", () => {
    test.skip(!!process.env.E2E_BASE_URL, "Needs its own local instance.");

    let instance: Instance;
    let page: Page;
    let card: string;

    test.beforeAll(async ({ browser }) => {
      test.setTimeout(180_000);
      instance = await freshInstance(browser, { port: 8847, inspectorPort: 9387 });
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

    test("exports shadows and layer blur as the canvas draws them", async () => {
      card = await page.evaluate(() => {
        const e = (window as unknown as W).drawpane;
        const solid = (color: string) => [{ type: "solid", color }];
        const frame = e.createLayer("frame", { x: 0, y: 0, width: 320, height: 220 }, e.s.pageId, {
          name: "Effects",
          fills: solid("#f4f2ee"),
        }) as string;
        // A card: a soft drop shadow with spread, and an inner shadow.
        e.createLayer("rect", { x: 32, y: 28, width: 140, height: 90 }, frame, {
          cornerRadius: 12,
          fills: solid("#ffffff"),
          effects: [
            { type: "drop-shadow", color: "#1c1b1a59", x: 0, y: 10, blur: 24, spread: 4 },
            { type: "inner-shadow", color: "#e0531f99", x: 4, y: 6, blur: 8, spread: 2 },
          ],
        });
        // Rotated: its shadow still falls straight down, as on the canvas.
        e.createLayer("rect", { x: 200, y: 40, width: 80, height: 60 }, frame, {
          rotation: 25,
          fills: solid("#2b4fd6"),
          effects: [{ type: "drop-shadow", color: "#00000080", x: 0, y: 12, blur: 10, spread: 0 }],
        });
        // Layer blur on an ellipse.
        e.createLayer("ellipse", { x: 60, y: 140, width: 120, height: 56 }, frame, {
          fills: solid("#0f8a7e"),
          effects: [{ type: "layer-blur", radius: 6 }],
        });
        e.select([frame]);
        return frame;
      });
      expect(card).toBeTruthy();

      await page.getByRole("radio", { name: "PNG" }).click();
      await page.getByRole("radio", { name: "1×" }).click();
      const png = await saved(page, () =>
        page.getByRole("button", { name: /Export layer/ }).click(),
      );
      await page.getByRole("radio", { name: "SVG" }).click();
      const svg = await saved(page, () =>
        page.getByRole("button", { name: /Export layer/ }).click(),
      );
      const svgText = readFileSync((await svg.path()) as string, "utf8");
      expect(svgText).toContain("<feGaussianBlur");
      expect(svgText).toContain("<mask");

      const difference = await page.evaluate(
        async ({ png, svg }) => {
          const load = (src: string) =>
            new Promise<HTMLImageElement>((resolve, reject) => {
              const img = new Image();
              img.onload = () => resolve(img);
              img.onerror = () => reject(new Error(`couldn't load ${src.slice(0, 30)}`));
              img.src = src;
            });
          const [a, b] = await Promise.all([
            load(`data:image/png;base64,${png}`),
            load(`data:image/svg+xml;base64,${svg}`),
          ]);
          const pixels = (img: HTMLImageElement) => {
            const canvas = document.createElement("canvas");
            canvas.width = a.naturalWidth;
            canvas.height = a.naturalHeight;
            const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
          };
          const x = pixels(a);
          const y = pixels(b);
          let total = 0;
          let off = 0;
          for (let i = 0; i < x.length; i += 4) {
            let worst = 0;
            for (let c = 0; c < 3; c++) {
              const d = Math.abs((x[i + c] ?? 0) - (y[i + c] ?? 0));
              total += d;
              worst = Math.max(worst, d);
            }
            if (worst > 24) off++;
          }
          const count = x.length / 4;
          return {
            size: [a.naturalWidth, a.naturalHeight, b.naturalWidth, b.naturalHeight],
            mean: total / (count * 3),
            offShare: off / count,
          };
        },
        {
          png: readFileSync((await png.path()) as string).toString("base64"),
          svg: Buffer.from(svgText).toString("base64"),
        },
      );
      expect(difference.size).toEqual([320, 220, 320, 220]);
      // Antialiasing differs between the two; the shadows and blur must not.
      expect(difference.mean).toBeLessThan(1.5);
      expect(difference.offShare).toBeLessThan(0.005);
    });

    test("Inspect shows the selection as readable SVG, and copies it", async () => {
      await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
      await page.getByRole("radio", { name: "Inspect" }).click();
      const code = page.getByRole("radiogroup", { name: "Code format" });
      await code.getByRole("radio", { name: "SVG" }).click();
      const shown = page.locator(".inspect__code");
      await expect(shown).toContainText('<svg xmlns="http://www.w3.org/2000/svg"');
      // One element per line, indented; effects as filters.
      await expect(shown).toContainText("\n  <defs>\n");
      await expect(shown).toContainText("<feGaussianBlur");
      await page.getByRole("button", { name: "Copy code" }).click();
      const copied = await page.evaluate(() => navigator.clipboard.readText());
      expect(copied.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
      expect(copied).toContain('data-name="Effects"');
      // Background blur can't be expressed in SVG: Inspect says so.
      await page.evaluate((id) => {
        const e = (window as unknown as W).drawpane as unknown as {
          doc: { childIds(id: string): string[] };
          commit(ops: unknown[]): boolean;
        };
        const first = e.doc.childIds(id)[0];
        e.commit([
          {
            op: "set",
            id: first,
            prop: "effects",
            value: [{ type: "background-blur", radius: 8 }],
          },
        ]);
      }, card);
      await expect(page.getByText("Background blur isn't part of SVG")).toBeVisible();
      await code.getByRole("radio", { name: "CSS" }).click();
    });

    test("a viewer lands on Inspect, with the code to copy", async ({ browser }) => {
      const fileUrl = new URL(page.url()).pathname;
      const invite = await page.evaluate(async () => {
        const { teams } = await (await fetch("/api/teams")).json();
        const response = await fetch(`/api/teams/${teams[0].id}/invites`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ role: "viewer" }),
        });
        return (await response.json()).url as string;
      });
      const context = await browser.newContext({ baseURL: instance.url });
      const viewer = await context.newPage();
      await addPasskey(context, viewer);
      await viewer.goto(new URL(invite).pathname);
      await viewer.getByLabel("Your name").fill("Sam Okafor");
      await viewer.getByLabel("Email").fill("sam@example.com");
      await viewer.getByRole("button", { name: "Create account with a passkey" }).click();
      await expect(viewer.getByRole("heading", { name: "Recent files" })).toBeVisible();
      await viewer.goto(fileUrl);
      await expect(viewer.getByRole("radio", { name: "Inspect", checked: true })).toBeVisible({
        timeout: 15_000,
      });
      await viewer.getByRole("treeitem", { name: /Effects/ }).click();
      await expect(viewer.locator(".inspect__code")).toContainText("width: 320px");
      await viewer
        .getByRole("radiogroup", { name: "Code format" })
        .getByRole("radio", { name: "SVG" })
        .click();
      await expect(viewer.locator(".inspect__code")).toContainText("<feGaussianBlur");
      await context.close();
    });
  });
