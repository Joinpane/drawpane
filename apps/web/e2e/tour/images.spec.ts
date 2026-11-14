/**
 * Screens for images, export and thumbnails, in both themes, for design
 * review. Runs on its own Worker; see `pnpm --filter @drawpane/web tour`.
 */
import { expect, type Page, test } from "@playwright/test";
import { freshInstance } from "../fresh-instance";
import { shot as tourShot } from "./harness";

/** Images tour shots share a prefix. */
const shot = (page: Page, name: string) => tourShot(page, `images-${name}`);

async function drag(page: Page, from: [number, number], to: [number, number]) {
  await page.mouse.move(from[0], from[1]);
  await page.mouse.down();
  await page.mouse.move(to[0], to[1], { steps: 6 });
  await page.mouse.up();
}

/** Drops a picture drawn in the page (a landscape, a portrait or a pattern) at a screen point. */
async function dropPicture(
  page: Page,
  at: { x: number; y: number },
  kind: "landscape" | "portrait" | "pattern",
  name: string,
  size: { width: number; height: number },
) {
  await page.evaluate(
    async ({ at, kind, name, size }) => {
      const c = new OffscreenCanvas(size.width, size.height);
      const ctx = c.getContext("2d");
      if (!ctx) return;
      const { width: w, height: h } = size;
      if (kind === "landscape") {
        const sky = ctx.createLinearGradient(0, 0, 0, h);
        sky.addColorStop(0, "#9fb8d6");
        sky.addColorStop(1, "#f3d9c4");
        ctx.fillStyle = sky;
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = "#fff6e3";
        ctx.beginPath();
        ctx.arc(w * 0.72, h * 0.32, h * 0.1, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#6f8a7a";
        ctx.beginPath();
        ctx.moveTo(0, h * 0.75);
        ctx.quadraticCurveTo(w * 0.3, h * 0.5, w * 0.6, h * 0.72);
        ctx.quadraticCurveTo(w * 0.8, h * 0.82, w, h * 0.66);
        ctx.lineTo(w, h);
        ctx.lineTo(0, h);
        ctx.fill();
        ctx.fillStyle = "#3f5a52";
        ctx.fillRect(0, h * 0.88, w, h * 0.12);
      } else if (kind === "portrait") {
        ctx.fillStyle = "#e9ddd0";
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = "#c98f6c";
        ctx.beginPath();
        ctx.arc(w / 2, h * 0.4, w * 0.2, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#2b4fd6";
        ctx.beginPath();
        ctx.ellipse(w / 2, h * 1.02, w * 0.42, h * 0.38, 0, 0, Math.PI * 2);
        ctx.fill();
      } else {
        for (let y = 0; y < h; y += 24)
          for (let x = 0; x < w; x += 24) {
            ctx.fillStyle = (x + y) % 48 === 0 ? "#ff5a1f" : "#ffd8c7";
            ctx.fillRect(x, y, 24, 24);
          }
      }
      const blob = await c.convertToBlob({
        type: kind === "pattern" ? "image/png" : "image/jpeg",
        quality: 0.9,
      });
      const data = new DataTransfer();
      data.items.add(new File([blob], name, { type: blob.type }));
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
    { at, kind, name, size },
  );
}

async function newFile(page: Page, name: string) {
  await page.goto("/");
  await page.getByRole("button", { name: "New file" }).first().click();
  await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
    timeout: 15_000,
  });
  await page.getByRole("button", { name: "Untitled" }).click();
  await page.getByLabel("File name").fill(name);
  await page.keyboard.press("Enter");
}

async function leave(page: Page) {
  const put = page.waitForResponse(
    (r) => r.url().endsWith("/thumbnail") && r.request().method() === "PUT",
  );
  await page.getByRole("link", { name: "Back to files" }).click();
  await put;
}

test("images tour", async ({ browser }) => {
  test.setTimeout(240_000);
  const instance = await freshInstance(browser, { port: 8796, inspectorPort: 9336 });
  const { page } = instance;
  try {
    // File 1: a mobile screen with a hero photo.
    await newFile(page, "Mobile app");
    await page.keyboard.press("f");
    await drag(page, [560, 150], [880, 760]);
    await page.keyboard.press("t");
    await page.mouse.click(590, 190);
    await page.keyboard.type("Good morning, Ana");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await dropPicture(page, { x: 720, y: 360 }, "landscape", "hero-photo.jpg", {
      width: 280,
      height: 200,
    });
    await expect(page.getByRole("treeitem", { name: /hero-photo/ })).toBeVisible();
    await page.keyboard.press("r");
    await drag(page, [580, 500], [860, 560]);
    await page.keyboard.press("r");
    await drag(page, [580, 580], [860, 640]);
    await page.getByRole("treeitem", { name: /hero-photo/ }).click();
    await expect(page.getByRole("region", { name: "Image uploads" })).toContainText("Done");
    await shot(page, "01-editor-image-fill");

    // The drop zone while files hover over the canvas.
    await page.evaluate(() => {
      const data = new DataTransfer();
      data.items.add(new File(["x"], "a.png", { type: "image/png" }));
      data.items.add(new File(["x"], "b.png", { type: "image/png" }));
      document.querySelector(".canvas__overlay")?.dispatchEvent(
        new DragEvent("dragover", {
          dataTransfer: data,
          clientX: 1000,
          clientY: 420,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await shot(page, "02-drop-zone");
    await page.evaluate(() =>
      document.dispatchEvent(new DragEvent("dragleave", { bubbles: true })),
    );

    // Slow uploads, to see the tray mid-flight.
    const cdp = await instance.context.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 40,
      downloadThroughput: -1,
      uploadThroughput: 4 * 1024,
    });
    await page.mouse.click(1040, 600);
    await dropPicture(page, { x: 1040, y: 420 }, "portrait", "team-portrait.jpg", {
      width: 900,
      height: 1200,
    });
    await dropPicture(page, { x: 1040, y: 680 }, "pattern", "brand-pattern.png", {
      width: 480,
      height: 240,
    });
    await page.waitForTimeout(1200);
    await shot(page, "03-upload-tray");
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });
    await expect(page.getByRole("region", { name: "Image uploads" })).not.toContainText("%", {
      timeout: 60_000,
    });

    // Tile mode, to show the picker with another mode and the export preview.
    await page.getByRole("treeitem", { name: /brand-pattern/ }).click();
    // The scale mode lives in the fill's picker.
    await page
      .getByRole("group", { name: "Properties" })
      .getByRole("button", { name: "Edit fill" })
      .click();
    await page
      .getByRole("dialog", { name: "Fill paint" })
      .getByRole("radio", { name: "Tile" })
      .click();
    await shot(page, "04-tile-mode");
    await page.keyboard.press("Escape");
    await page.getByRole("radio", { name: "2×" }).click();
    await shot(page, "04-tile-and-export");
    await page.getByRole("radio", { name: "1×" }).click();
    await leave(page);

    // File 2: a landing page with two photos side by side.
    await newFile(page, "Marketing site");
    await page.keyboard.press("f");
    await drag(page, [420, 160], [1020, 700]);
    await page.keyboard.press("r");
    await drag(page, [450, 190], [990, 240]);
    await dropPicture(page, { x: 720, y: 420 }, "landscape", "coast.jpg", {
      width: 480,
      height: 300,
    });
    await page.keyboard.press("t");
    await page.mouse.click(460, 610);
    await page.keyboard.type("Plan your next trip");
    await page.keyboard.press("Escape");
    await leave(page);

    // File 3: a pattern study (wide).
    await newFile(page, "Brand patterns");
    await dropPicture(page, { x: 720, y: 450 }, "pattern", "pattern-a.png", {
      width: 720,
      height: 240,
    });
    await expect(page.getByRole("region", { name: "Image uploads" })).toContainText("Done");
    await leave(page);

    // File 4: a tall portrait.
    await newFile(page, "Team page");
    await dropPicture(page, { x: 720, y: 450 }, "portrait", "portrait.jpg", {
      width: 360,
      height: 480,
    });
    await expect(page.getByRole("region", { name: "Image uploads" })).toContainText("Done");
    await leave(page);

    // File 5: empty, so the dashboard shows the placeholder next to real thumbnails.
    await newFile(page, "Untitled exploration");
    await page.getByRole("link", { name: "Back to files" }).click();

    await expect(page.getByRole("heading", { name: "Recent files" })).toBeVisible();
    await expect(page.locator(".thumb--ready")).toHaveCount(4, { timeout: 15_000 });
    await shot(page, "05-dashboard-thumbnails");
  } finally {
    await instance.stop();
  }
});
