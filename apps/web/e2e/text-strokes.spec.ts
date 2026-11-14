/**
 * Strokes on text in a real browser: around the glyphs (centred, inside or
 * outside their edges), like Figma, never around the text's box.
 */
import { expect, type Page, test } from "@playwright/test";
import { freshInstance, type Instance } from "./fresh-instance";

type W = {
  drawpane: {
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
    revealSelection(): void;
    doc: { get(id: string): { props: Record<string, unknown> } | undefined };
  };
};

/** Red pixels in the layer's box on the canvas, and whether its corners are clear of them. */
function redIn(page: Page, id: string) {
  return page.evaluate((id) => {
    const e = (window as unknown as W).drawpane;
    const p = e.doc.get(id)?.props as { x: number; y: number; width: number; height: number };
    const a = e.s.camera.toScreen({ x: p.x, y: p.y });
    const b = e.s.camera.toScreen({ x: p.x + p.width, y: p.y + p.height });
    const canvas = document.querySelector(".canvas canvas") as HTMLCanvasElement;
    const ratio = canvas.width / canvas.getBoundingClientRect().width;
    const x = Math.round(a.x * ratio);
    const y = Math.round(a.y * ratio);
    const w = Math.round((b.x - a.x) * ratio);
    const h = Math.round((b.y - a.y) * ratio);
    const px = (canvas.getContext("2d") as CanvasRenderingContext2D).getImageData(x, y, w, h).data;
    const red = (i: number) =>
      (px[i] ?? 0) > 200 && (px[i + 1] ?? 255) < 90 && (px[i + 2] ?? 255) < 90;
    let count = 0;
    for (let i = 0; i < px.length; i += 4) if (red(i)) count++;
    // A box stroke would run along every edge: look at the corners, inset a pixel.
    const corner = (cx: number, cy: number) => red((cy * w + cx) * 4);
    const corners = [corner(1, 1), corner(w - 2, 1), corner(1, h - 2), corner(w - 2, h - 2)];
    return { count, cornersClear: corners.every((c) => !c) };
  }, id);
}

test.describe
  .serial("Text strokes", () => {
    test.skip(!!process.env.E2E_BASE_URL, "Needs its own local instance.");

    let instance: Instance;
    let page: Page;

    test.beforeAll(async ({ browser }) => {
      test.setTimeout(180_000);
      instance = await freshInstance(browser, { port: 8871, inspectorPort: 9411 });
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

    for (const align of ["center", "inside", "outside"] as const)
      test(`strokes the glyphs ${align === "center" ? "on" : align} their edges, not the box`, async () => {
        const id = await page.evaluate((align) => {
          const e = (window as unknown as W).drawpane;
          const t = e.createLayer("text", { x: 0, y: 0, width: 10, height: 10 }, e.s.pageId, {
            characters: "Menubar",
            fontSize: 64,
            fontWeight: 700,
            fills: [{ type: "solid", color: "#111827" }],
            strokes: [{ type: "solid", color: "#ff0000" }],
            strokeWeight: 3,
            strokeAlign: align,
          }) as string;
          e.select([t]);
          e.zoomTo(1);
          e.revealSelection();
          return t;
        }, align);
        await expect.poll(async () => (await redIn(page, id)).count).toBeGreaterThan(300);
        expect((await redIn(page, id)).cornersClear).toBe(true);
      });
  });
