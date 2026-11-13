import { readFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { canvasColor, dropImage, freshInstance, type Instance } from "./fresh-instance";

/** Width and height from a PNG's IHDR chunk. */
function pngSize(bytes: Buffer): { width: number; height: number } {
  expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

const ORANGE = "#ff5a1f";
const BLUE = "#2b4fd6";

test.describe
  .serial("Images, export and thumbnails", () => {
    test.skip(!!process.env.E2E_BASE_URL, "Needs its own local instance.");

    let instance: Instance;
    let page: Page;
    let fileUrl = "";

    test.beforeAll(async ({ browser }) => {
      test.setTimeout(180_000);
      instance = await freshInstance(browser, { port: 8795, inspectorPort: 9335 });
      page = instance.page;
    });

    test.afterAll(async () => {
      await instance?.stop();
    });

    test("drops a PNG on the canvas, uploads it and draws it", async () => {
      await page.getByRole("button", { name: "New file" }).first().click();
      await expect(page).toHaveURL(/\/f\//);
      await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
        timeout: 15_000,
      });
      fileUrl = page.url();

      const uploaded = page.waitForResponse(
        (r) => r.url().endsWith("/media") && r.request().method() === "POST",
      );
      // 240 × 160: left half blue, right half orange, centred on the drop point.
      await dropImage(
        page,
        { x: 720, y: 450 },
        {
          name: "hero-photo.png",
          width: 240,
          height: 160,
          colors: [BLUE, ORANGE],
        },
      );
      await expect(page.getByRole("treeitem", { name: /hero-photo/ })).toBeVisible();
      const response = await uploaded;
      expect(response.status()).toBe(201);
      const { sha } = (await response.json()) as { sha: string };
      expect(sha).toMatch(/^[0-9a-f]{64}$/);
      await expect(page.getByRole("region", { name: "Image uploads" })).toContainText("Done");

      // At natural size on a 100% canvas: blue left, orange right.
      const width = page.getByRole("group", { name: "Properties" }).getByLabel("Width");
      await expect(width).toHaveValue("240");
      await expect.poll(() => canvasColor(page, { x: 650, y: 450 })).toBe(BLUE);
      await expect.poll(() => canvasColor(page, { x: 800, y: 450 })).toBe(ORANGE);

      // A second tab has nothing cached: it loads the image from storage.
      const other = await instance.context.newPage();
      const served = other.waitForResponse((r) => r.url().endsWith(`/api/media/${sha}`));
      await other.goto(fileUrl);
      expect((await served).headers()["content-type"]).toBe("image/png");
      await expect(other.getByRole("treeitem", { name: /hero-photo/ })).toBeVisible();
      // The second tab fits the content to the screen, so find the layer's centre there.
      await other.getByRole("treeitem", { name: /hero-photo/ }).click();
      const box = await other.evaluate(() => {
        const handle = document.querySelector(".canvas__overlay")?.getBoundingClientRect();
        return handle
          ? { x: handle.left + handle.width / 2, y: handle.top + handle.height / 2 }
          : null;
      });
      expect(box).not.toBeNull();
      await expect
        .poll(async () => {
          const colors = new Set<string>();
          for (const dx of [-80, -40, 40, 80])
            colors.add(await canvasColor(other, { x: (box?.x ?? 0) + dx, y: box?.y ?? 0 }));
          return [...colors].filter((c) => c === BLUE || c === ORANGE).sort();
        })
        .toEqual([BLUE, ORANGE].sort());
      await other.close();
    });

    test("switches the scale mode in the fill picker", async () => {
      const inspector = page.getByRole("group", { name: "Properties" });
      const picker = page.getByRole("dialog", { name: "Fill paint" });
      const mode = (name: string) => picker.getByRole("radio", { name });
      await inspector.getByRole("button", { name: "Edit fill" }).click();
      await expect(picker.getByRole("radio", { name: "Image" })).toHaveAttribute(
        "aria-checked",
        "true",
      );
      await expect(mode("Fill")).toHaveAttribute("aria-checked", "true");
      await mode("Fit").click();
      await expect(mode("Fit")).toHaveAttribute("aria-checked", "true");
      await expect(picker.getByText(/240 × 160/)).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(picker).toHaveCount(0);
      // Make the layer wider than the image: Fit leaves the page background at the sides.
      await inspector.getByLabel("Width").fill("480");
      await inspector.getByLabel("Width").press("Enter");
      await expect.poll(() => canvasColor(page, { x: 620, y: 450 })).not.toBe(BLUE);
      // Leave the field so undo goes to the document, not the input.
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.keyboard.press("ControlOrMeta+z");
      await page.keyboard.press("ControlOrMeta+z");
      await expect(inspector.getByLabel("Width")).toHaveValue("240");
      await inspector.getByRole("button", { name: "Edit fill" }).click();
      await expect(mode("Fill")).toHaveAttribute("aria-checked", "true");
      await page.keyboard.press("Escape");
    });

    test("refuses files that aren't images, with a notice", async () => {
      await page.evaluate(() => {
        const data = new DataTransfer();
        data.items.add(new File(["<svg/>"], "logo.svg", { type: "image/svg+xml" }));
        const target = document.querySelector(".canvas__overlay");
        const init = {
          dataTransfer: data,
          clientX: 400,
          clientY: 300,
          bubbles: true,
          cancelable: true,
        };
        target?.dispatchEvent(new DragEvent("drop", init));
      });
      await expect(page.getByRole("alert")).toContainText(
        'Couldn\'t place "logo.svg". Drawpane takes PNG, JPEG, WebP and GIF images.',
      );
    });

    test("exports the selection as PNG with ⇧⌘E and from the Inspector", async () => {
      await page.getByRole("treeitem", { name: /hero-photo/ }).click();
      const first = page.waitForEvent("download");
      await page.keyboard.press("ControlOrMeta+Shift+E");
      const download = await first;
      expect(download.suggestedFilename()).toBe("hero-photo.png");
      expect(pngSize(readFileSync(await download.path()))).toEqual({ width: 240, height: 160 });

      await page.getByRole("radio", { name: "2×" }).click();
      await expect(page.getByText("Saves hero-photo@2x.png")).toBeVisible();
      const second = page.waitForEvent("download");
      await page.getByRole("button", { name: /Export layer/ }).click();
      const bigger = await second;
      expect(bigger.suggestedFilename()).toBe("hero-photo@2x.png");
      const bytes = readFileSync(await bigger.path());
      expect(pngSize(bytes)).toEqual({ width: 480, height: 320 });

      await page.getByRole("radio", { name: "SVG" }).click();
      const third = page.waitForEvent("download");
      await page.getByRole("button", { name: /Export layer/ }).click();
      const svg = await third;
      expect(svg.suggestedFilename()).toBe("hero-photo.svg");
      expect(readFileSync(await svg.path(), "utf8")).toMatch(/^<svg xmlns/);
      await page.getByRole("radio", { name: "PNG" }).click();
      await page.getByRole("radio", { name: "1×" }).click();
    });

    test("publishes a thumbnail that the dashboard shows", async () => {
      // Leaving the file publishes any unpublished edits (earlier ones went after 10 s).
      await page.getByRole("link", { name: "Back to files" }).click();
      await expect(page.getByRole("heading", { name: "Recent files" })).toBeVisible();
      const thumb = page.locator(".dash__thumb img.thumb__image").first();
      await expect(thumb).toBeVisible({ timeout: 15_000 });
      await expect
        .poll(() => thumb.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth))
        .toBeGreaterThan(0);
    });
  });
