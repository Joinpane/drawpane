/**
 * PDF export for design review: a two-frame deck with real fonts (Fraunces
 * and Instrument Sans through this server's font proxy), a gradient, rounded
 * corners and a photo, exported from the canvas menu and saved next to the
 * screenshots for rendering and inspection.
 * Run with `pnpm --filter @drawpane/web tour`.
 */
import { expect } from "@playwright/test";
import { dropImage } from "../fresh-instance";
import { OUT, passkey, shot, test } from "./harness";

test("pdf tour", async ({ browser }) => {
  test.setTimeout(120_000);
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true,
  });
  const page = await context.newPage();
  await passkey(context, page);
  await page.goto("/setup");
  await page.evaluate(() => localStorage.setItem("drawpane:debug", "1"));
  await page.getByLabel("Your name").fill("Ana Lima");
  await page.getByLabel("Email").fill("ana@example.com");
  await page.getByLabel("Setup token").fill(process.env.E2E_SETUP_TOKEN ?? "e2e-setup-token");
  await page.getByRole("button", { name: "Create account with a passkey" }).click();
  await expect(page.getByRole("heading", { name: "Recent files" })).toBeVisible();
  await page.getByRole("button", { name: "New file" }).first().click();
  await expect(page.getByRole("status")).toContainText("Saved", { timeout: 15_000 });

  await dropImage(
    page,
    { x: 720, y: 450 },
    {
      name: "landscape.png",
      width: 480,
      height: 300,
      colors: ["#2b4fd6", "#6b95ff", "#f5b400", "#ff5a1f"],
    },
  );
  await expect(page.getByRole("region", { name: "Image uploads" })).toBeHidden({ timeout: 15_000 });
  await page.evaluate(() => {
    type E = {
      s: { pageId: string; selection: string[] };
      createLayer(t: string, r: object, p: string, props?: object): string;
      reparentOps(id: string, parent: string, key: string): unknown[];
      topKey(parent: string): string;
      commit(ops: unknown[], label: string): boolean;
      setProp(ids: string[], prop: string, value: unknown): void;
      select(ids: string[]): void;
      zoomToFit(): void;
    };
    const e = (window as unknown as { drawpane: E }).drawpane;
    const p = e.s.pageId;
    const photo = e.s.selection[0] as string;
    const cover = e.createLayer("frame", { x: 0, y: 0, width: 800, height: 450 }, p, {
      name: "Cover",
      fills: [
        {
          type: "linear",
          from: { x: 0, y: 0 },
          to: { x: 1, y: 1 },
          stops: [
            { position: 0, color: "#1c1b19" },
            { position: 1, color: "#3a2a6b" },
          ],
        },
      ],
    });
    e.createLayer("text", { x: 56, y: 140, width: 10, height: 10 }, cover, {
      characters: "Plan your week in one glance",
      fontFamily: "Fraunces",
      fontSize: 48,
      fontWeight: 700,
      fills: [{ type: "solid", color: "#ffffff" }],
    });
    e.createLayer("text", { x: 56, y: 220, width: 10, height: 10 }, cover, {
      characters: "Design review · November",
      fontSize: 20,
      fills: [{ type: "solid", color: "#c9c3ff" }],
    });
    const detail = e.createLayer("frame", { x: 880, y: 0, width: 800, height: 450 }, p, {
      name: "Detail",
      fills: [{ type: "solid", color: "#f7f6f2" }],
    });
    e.commit(e.reparentOps(photo, detail, e.topKey(detail)), "Move");
    // x and y are in the frame's own coordinates.
    e.setProp([photo], "x", 40);
    e.setProp([photo], "y", 40);
    e.setProp([photo], "width", 360);
    e.setProp([photo], "height", 370);
    e.setProp([photo], "cornerRadius", 24);
    e.createLayer("text", { x: 1320, y: 60, width: 10, height: 10 }, detail, {
      characters: "Three things on today",
      fontFamily: "Fraunces",
      fontSize: 28,
    });
    e.createLayer("rect", { x: 1320, y: 120, width: 320, height: 56 }, detail, {
      cornerRadius: 12,
      fills: [{ type: "solid", color: "#2b4fd6" }],
    });
    e.createLayer("text", { x: 1340, y: 138, width: 10, height: 10 }, detail, {
      characters: "Mark done",
      fontSize: 16,
      fontWeight: 600,
      fills: [{ type: "solid", color: "#ffffff" }],
    });
    e.select([]);
    e.zoomToFit();
  });
  await page.waitForTimeout(1500);
  await shot(page, "113-pdf-source");
  await page.mouse.click(720, 820, { button: "right" });
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("menuitem", { name: /^Export page as PDF/ }).click(),
  ]);
  await download.saveAs(`${OUT}/113-export.pdf`);
  await context.close();
});
