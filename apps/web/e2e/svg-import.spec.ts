/**
 * SVG in a real browser (decision 0020): dropping an .svg file places it as
 * a frame of editable layers (beside any images dropped with it, in one undo
 * step), pasting SVG markup does the same, and choosing an SVG for an image
 * fill uploads it drawn to a PNG. Files that are neither get a notice that
 * names SVG among what's taken.
 */
import { expect, type Page, test } from "@playwright/test";
import { freshInstance, type Instance } from "./fresh-instance";

type Node = { id: string; type: string; parent: string; props: Record<string, unknown> };
type W = {
  drawpane: {
    s: { pageId: string; selection: string[] };
    createLayer(
      type: string,
      rect: { x: number; y: number; width: number; height: number },
      parent: string,
      props?: Record<string, unknown>,
    ): string | null;
    select(ids: string[]): void;
    zoomTo(z: number): void;
    undo(): void;
    doc: { get(id: string): Node | undefined; childIds(id: string): string[] };
  };
};

const ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 2c-3.5 3-3.5 17 0 20c3.5-3 3.5-17 0-20"/><path d="M2.5 12h19"/></svg>`;

/** The selection's layers, with their children's types. */
function selectedTree(page: Page) {
  return page.evaluate(() => {
    const e = (window as unknown as W).drawpane;
    return e.s.selection.map((id) => {
      const node = e.doc.get(id) as Node;
      return {
        type: node.type,
        name: node.props.name,
        width: node.props.width,
        height: node.props.height,
        children: e.doc.childIds(id).map((c) => e.doc.get(c)?.type),
      };
    });
  });
}

/** Drops files made in the page onto the canvas at a screen point. */
async function drop(
  page: Page,
  at: { x: number; y: number },
  files: { name: string; type: string; text?: string; png?: { width: number; height: number } }[],
) {
  await page.evaluate(
    async ({ at, files }) => {
      const data = new DataTransfer();
      for (const f of files) {
        if (f.png) {
          const canvas = new OffscreenCanvas(f.png.width, f.png.height);
          const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
          ctx.fillStyle = "#2b4fd6";
          ctx.fillRect(0, 0, f.png.width, f.png.height);
          const blob = await canvas.convertToBlob({ type: "image/png" });
          data.items.add(new File([blob], f.name, { type: f.type }));
        } else data.items.add(new File([f.text ?? ""], f.name, { type: f.type }));
      }
      const target = document.querySelector(".canvas__overlay");
      const init = {
        dataTransfer: data,
        clientX: at.x,
        clientY: at.y,
        bubbles: true,
        cancelable: true,
      };
      target?.dispatchEvent(new DragEvent("dragover", init));
      target?.dispatchEvent(new DragEvent("drop", init));
    },
    { at, files },
  );
}

/** Pastes plain text, as the system clipboard would after "Copy SVG". */
async function pasteText(page: Page, text: string) {
  await page.evaluate((text) => {
    const data = new DataTransfer();
    data.setData("text/plain", text);
    document.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
    );
  }, text);
}

test.describe
  .serial("SVG import", () => {
    test.skip(!!process.env.E2E_BASE_URL, "Needs its own local instance.");

    let instance: Instance;
    let page: Page;

    test.beforeAll(async ({ browser }) => {
      test.setTimeout(180_000);
      instance = await freshInstance(browser, { port: 8971, inspectorPort: 9511 });
      page = instance.page;
      await page.evaluate(() => localStorage.setItem("drawpane:debug", "1"));
      await page.getByRole("button", { name: "New file" }).first().click();
      await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
        timeout: 15_000,
      });
      await page.evaluate(() => (window as unknown as W).drawpane.zoomTo(1));
    });

    test.afterAll(async () => {
      await instance?.stop();
    });

    test("drops an SVG beside a PNG: a frame of layers and an image, one undo step", async () => {
      const uploaded = page.waitForResponse(
        (r) => r.url().endsWith("/media") && r.request().method() === "POST",
      );
      await drop(page, { x: 700, y: 400 }, [
        { name: "globe.svg", type: "image/svg+xml", text: ICON },
        { name: "photo.png", type: "image/png", png: { width: 80, height: 40 } },
      ]);
      await expect(page.getByRole("treeitem", { name: /globe/ })).toBeVisible();
      expect(await selectedTree(page)).toEqual([
        {
          type: "frame",
          name: "globe",
          width: 48,
          height: 48,
          children: ["ellipse", "path", "path"],
        },
        { type: "rect", name: "photo", width: 80, height: 40, children: [] },
      ]);
      expect((await uploaded).status()).toBe(201);
      // Only the PNG went to storage: the SVG is layers now.
      await expect(page.getByRole("region", { name: "Image uploads" })).toContainText("photo.png");
      await expect(page.getByRole("region", { name: "Image uploads" })).not.toContainText(
        "globe.svg",
      );

      // The layers are editable: the globe's outline is a stroked ellipse.
      const ellipse = await page.evaluate(() => {
        const e = (window as unknown as W).drawpane;
        const frame = e.s.selection[0] as string;
        return e.doc.get(e.doc.childIds(frame)[0] as string)?.props;
      });
      expect(ellipse).toMatchObject({
        width: 40,
        height: 40,
        strokeWeight: 4,
        strokeAlign: "center",
        strokes: [{ type: "solid", color: "#000000" }],
      });

      await page.keyboard.press("ControlOrMeta+z");
      await expect(page.getByRole("treeitem", { name: /globe/ })).toHaveCount(0);
      await expect(page.getByRole("treeitem", { name: /photo/ })).toHaveCount(0);
      await page.keyboard.press("ControlOrMeta+Shift+z");
      await expect(page.getByRole("treeitem", { name: /globe/ })).toBeVisible();
    });

    test("pastes SVG markup as a frame of layers", async () => {
      await page.evaluate(() => (window as unknown as W).drawpane.select([]));
      await pasteText(
        page,
        `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="32"><g id="Shapes"><rect width="30" height="30" rx="6" fill="#ff5a1f"/><circle cx="48" cy="16" r="14" fill="#2b4fd6"/></g></svg>`,
      );
      await expect
        .poll(() => selectedTree(page))
        .toEqual([{ type: "frame", name: "SVG", width: 64, height: 32, children: ["group"] }]);
      await expect(page.getByRole("treeitem", { name: "Shapes" })).toBeVisible();
    });

    test("says what an import approximated", async () => {
      await pasteText(
        page,
        `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><filter id="f"><feTurbulence baseFrequency=".2"/></filter><rect width="20" height="20" filter="url(#f)"/></svg>`,
      );
      await expect(page.getByRole("alert")).toContainText(
        "Some parts are approximated: 1 filter effect was left out.",
      );
    });

    test("names SVG among what it takes when a file is neither", async () => {
      await drop(page, { x: 400, y: 300 }, [{ name: "notes.txt", type: "text/plain", text: "hi" }]);
      await expect(page.getByRole("alert")).toContainText(
        'Couldn\'t place "notes.txt". Drawpane takes SVG, PNG, JPEG, WebP and GIF images.',
      );
    });

    test("fills a layer with an SVG, drawn to a PNG at twice its size", async () => {
      await page.evaluate(() => {
        const e = (window as unknown as W).drawpane;
        const id = e.createLayer("rect", { x: 100, y: 500, width: 120, height: 80 }, e.s.pageId);
        if (id) e.select([id]);
      });
      await page
        .getByRole("group", { name: "Properties" })
        .getByRole("button", { name: "Edit fill" })
        .click();
      const picker = page.getByRole("dialog", { name: "Fill paint" });
      await picker.getByRole("radio", { name: "Image" }).click();
      await expect(picker.getByText("PNG, JPEG, WebP, GIF or SVG")).toBeVisible();
      const uploaded = page.waitForResponse(
        (r) => r.url().endsWith("/media") && r.request().method() === "POST",
      );
      const chooser = page.waitForEvent("filechooser");
      await picker.getByRole("button", { name: "Choose an image…" }).click();
      // Only a viewBox: its size comes from there (60 × 30), drawn at 120 × 60.
      await (await chooser).setFiles({
        name: "badge.svg",
        mimeType: "image/svg+xml",
        buffer: Buffer.from(
          `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 30"><rect width="60" height="30" fill="#0b7a75"/></svg>`,
        ),
      });
      const response = await uploaded;
      expect(response.request().headers()["content-type"]).toBe("image/png");
      expect(response.status()).toBe(201);
      const info = (await response.json()) as { mime: string; width: number; height: number };
      expect(info).toMatchObject({ mime: "image/png", width: 120, height: 60 });
      await expect
        .poll(() =>
          page.evaluate(() => {
            const e = (window as unknown as W).drawpane;
            return (e.doc.get(e.s.selection[0] as string)?.props.fills as { type: string }[])?.[0]
              ?.type;
          }),
        )
        .toBe("image");
    });
  });
