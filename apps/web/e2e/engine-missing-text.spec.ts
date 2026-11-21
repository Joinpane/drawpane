import { expect, test } from "@playwright/test";
import { freshInstance } from "./fresh-instance";

type Debug = {
  drawpane: {
    s: { pageId: string };
    createLayer(type: string, box: object, parent: string, props: object): string;
    startTextEdit(id: string): void;
    centerOn(point: { x: number; y: number }): void;
    zoomTo(zoom: number): void;
  };
  drawpaneFrames: { exact: boolean };
};

for (const { family, start, typed, features } of [
  { family: "SF Pro", start: "AV", typed: "\uE100H", features: { tnum: true } },
  { family: "Arial", start: "Continue with Apple", typed: " now", features: {} },
]) {
  test(`typing in ${family} keeps the engine and aligns the caret with the text`, async ({
    browser,
  }) => {
    test.skip(!!process.env.E2E_BASE_URL, "Needs its own local instance.");
    test.setTimeout(180_000);
    const port = Number(process.env.MISSING_TEXT_E2E_PORT ?? 9413);
    const { page, stop } = await freshInstance(browser, { port, inspectorPort: port + 540 });
    try {
      await page.evaluate(() => {
        localStorage.setItem("drawpane:debug", "1");
      });
      if (family === "SF Pro") await page.setViewportSize({ width: 760, height: 480 });
      await page.goto("/?renderer=engine-cpu");
      await page.getByRole("button", { name: "New file" }).first().click();
      await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
        timeout: 15_000,
      });
      const view = page.locator(".canvas[data-renderer]");
      const backend = "cpu-worker";
      await expect(view).toHaveAttribute("data-renderer", backend, { timeout: 30_000 });
      const id = await page.evaluate(
        ({ family, start, features }) => {
          const e = (window as unknown as Debug).drawpane;
          e.zoomTo(1);
          e.centerOn({ x: family === "Arial" ? 190 : 52, y: 26 });
          return e.createLayer("text", { x: 0, y: 0, width: 500, height: 56 }, e.s.pageId, {
            characters: start,
            fontFamily: family,
            fontSize: 36,
            fontFeatures: features,
            textAutoResize: "none",
            fills: [{ type: "solid", color: "#ce2100" }],
          });
        },
        { family, start, features },
      );
      const exact = () =>
        page.waitForFunction(() => (window as unknown as Debug).drawpaneFrames.exact, undefined, {
          timeout: 30_000,
        });
      await exact();
      await expect(view).toHaveAttribute("data-renderer", backend, { timeout: 15_000 });
      const fallbackFrames = await view.getAttribute("data-renderer-fallback-frames");
      const presented = Number(await view.getAttribute("data-renderer-frames"));
      await page.evaluate((id) => (window as unknown as Debug).drawpane.startTextEdit(id), id);
      const input = page.getByRole("textbox", { name: "Text", exact: true });
      await expect(input).toBeFocused();
      await input.press("End");
      await page.keyboard.insertText(typed);
      await expect(input).toHaveValue(start + typed);
      await expect
        .poll(async () => Number(await view.getAttribute("data-renderer-frames")))
        .toBeGreaterThan(presented);
      await exact();
      await expect(view).toHaveAttribute("data-renderer", backend, { timeout: 15_000 });
      await expect(view).toHaveAttribute("data-renderer-presented", "true");
      expect(await view.getAttribute("data-renderer-fallback-frames")).toBe(fallbackFrames);

      // Compare the DOM caret to the last painted glyph on the presented engine
      // canvas. Red selects the text independently of the editor's theme.
      const caret = page.locator(".canvas__caret");
      await expect(caret).toHaveCount(1);
      const engine = page.locator('[data-canvas-role="engine"]');
      const png = await engine.screenshot({ scale: "css" });
      const canvasBox = await engine.boundingBox();
      const caretBox = await caret.boundingBox();
      if (!canvasBox || !caretBox) throw new Error("Missing canvas or caret bounds");
      const top = Math.floor(caretBox.y - canvasBox.y);
      const bottom = Math.ceil(caretBox.y + caretBox.height - canvasBox.y);
      const right = await page.evaluate(
        async ({ base64, top, bottom }) => {
          const img = new Image();
          img.src = `data:image/png;base64,${base64}`;
          await img.decode();
          const ctx = new OffscreenCanvas(img.width, img.height).getContext("2d");
          if (!ctx) throw new Error("Missing 2D context");
          ctx.drawImage(img, 0, 0);
          const { data } = ctx.getImageData(0, top, img.width, bottom - top);
          let last = -1;
          for (let p = 0; p < data.length; p += 4) {
            if ((data[p] ?? 0) >= 185 && (data[p + 1] ?? 255) < 50 && (data[p + 2] ?? 255) < 25) {
              last = Math.max(last, (p / 4) % img.width);
            }
          }
          return last;
        },
        { base64: png.toString("base64"), top, bottom },
      );
      expect(right).toBeGreaterThan(0);
      const gap = caretBox.x - canvasBox.x - right;
      expect(gap).toBeGreaterThanOrEqual(-1);
      expect(gap).toBeLessThan(8);
    } finally {
      await stop();
    }
  });
}
