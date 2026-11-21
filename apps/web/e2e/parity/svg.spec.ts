/**
 * SVG import fidelity (decision 0020): each SVG in the corpus
 * (packages/svg/test/fixtures: a stroked icon with currentColor, a Figma
 * "Copy as SVG" card with gradients, a shadow and clip paths, an
 * Illustrator export with <style> classes and transforms, an even-odd logo,
 * a flag built from <use> and <symbol>, and units, dashes and a skew) is
 * drawn by the browser as an image, then pasted into Drawpane and drawn by
 * its renderer, both at 2× on white, and the two compared pixel by pixel:
 * mean difference over RGB (0–255) and its 99th percentile. Each must stay
 * within its threshold below. The report (original, imported, heat map) goes
 * to PARITY_OUT, by default test-results/parity/svg.html.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { freshInstance, type Instance } from "../fresh-instance";
import { compare, encodePng } from "./pixels";

const FIXTURES = fileURLToPath(new URL("../../../../packages/svg/test/fixtures", import.meta.url));
const OUT =
  process.env.PARITY_OUT ?? fileURLToPath(new URL("../../test-results/parity", import.meta.url));
const SCALE = 2;

/** Most mean difference each fixture may have, recorded from a run with some room (×1.5 + 0.5). */
const THRESHOLDS: Readonly<Record<string, number>> = {
  "icon-stroke.svg": 0.5,
  "figma-card.svg": 0.92,
  "illustrator-badge.svg": 0.5,
  "logo-evenodd.svg": 1.27,
  "flag-use.svg": 0.5,
  "units-dashes.svg": 0.55,
};

type W = {
  drawpane: {
    s: { pageId: string; selection: string[] };
    doc: { get(id: string): { props: Record<string, unknown> } | undefined };
    setProp(ids: string[], prop: string, value: unknown, label: string): void;
    select(ids: string[]): void;
    deleteSelection(): void;
    zoomTo(z: number): void;
    centerOn(p: { x: number; y: number }): void;
  };
  drawpaneFrames: { redraw(): void };
};

/** The browser's own render of an SVG at `scale`, on white, as RGBA base64. */
function original(page: Page, text: string, width: number, height: number): Promise<string> {
  return page.evaluate(
    async ({ text, width, height }) => {
      const url = URL.createObjectURL(new Blob([text], { type: "image/svg+xml" }));
      const img = new Image();
      img.src = url;
      await img.decode();
      const c = new OffscreenCanvas(width, height);
      const ctx = c.getContext("2d") as OffscreenCanvasRenderingContext2D;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(img, 0, 0, width, height);
      URL.revokeObjectURL(url);
      const data = ctx.getImageData(0, 0, width, height).data;
      let s = "";
      for (let i = 0; i < data.length; i += 0x8000)
        s += String.fromCharCode(...data.subarray(i, i + 0x8000));
      return btoa(s);
    },
    { text, width, height },
  );
}

/** Pastes markup through the editor's own paste handler, and returns the frame it made. */
async function paste(
  page: Page,
  text: string,
): Promise<{ id: string; x: number; y: number; width: number; height: number }> {
  await page.evaluate((text) => {
    (window as unknown as W).drawpane.select([]);
    const data = new DataTransfer();
    data.setData("text/plain", text);
    document.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
    );
  }, text);
  await expect
    .poll(() => page.evaluate(() => (window as unknown as W).drawpane.s.selection.length))
    .toBe(1);
  return page.evaluate(() => {
    const e = (window as unknown as W).drawpane;
    const id = e.s.selection[0] as string;
    const p = e.doc.get(id)?.props ?? {};
    return {
      id,
      x: p.x as number,
      y: p.y as number,
      width: p.width as number,
      height: p.height as number,
    };
  });
}

/** Drawpane's render of the frame at `scale`, as RGBA base64. */
function rendered(page: Page, frame: { x: number; y: number; width: number; height: number }) {
  return page.evaluate(
    async ({ frame, scale }) => {
      const w = window as unknown as W & {
        drawpane: {
          s: { camera: { toScreen(p: { x: number; y: number }): { x: number; y: number } } };
        };
      };
      w.drawpane.select([]);
      w.drawpane.zoomTo(scale);
      w.drawpane.centerOn({ x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 });
      for (let i = 0; i < 3; i++) await new Promise((r) => requestAnimationFrame(() => r(null)));
      w.drawpaneFrames.redraw();
      for (let i = 0; i < 3; i++) await new Promise((r) => requestAnimationFrame(() => r(null)));
      const canvas = document.querySelector(".canvas canvas") as HTMLCanvasElement;
      const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
      const ratio = canvas.width / canvas.getBoundingClientRect().width;
      const at = w.drawpane.s.camera.toScreen({ x: frame.x, y: frame.y });
      const data = ctx.getImageData(
        Math.round(at.x * ratio),
        Math.round(at.y * ratio),
        Math.round(frame.width * scale),
        Math.round(frame.height * scale),
      ).data;
      let s = "";
      for (let i = 0; i < data.length; i += 0x8000)
        s += String.fromCharCode(...data.subarray(i, i + 0x8000));
      return btoa(s);
    },
    { frame, scale: SCALE },
  );
}

test.describe
  .serial("SVG import fidelity", () => {
    test.skip(!!process.env.E2E_BASE_URL, "Needs its own local instance.");

    let instance: Instance;
    let page: Page;
    const rows: string[] = [];
    const scores: Record<string, { mean: number; p99: number }> = {};

    test.beforeAll(async ({ browser }) => {
      test.setTimeout(180_000);
      instance = await freshInstance(browser, { port: 8983, inspectorPort: 9523 });
      page = instance.page;
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.evaluate(() => localStorage.setItem("drawpane:debug", "1"));
      await page.getByRole("button", { name: "New file" }).first().click();
      await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
        timeout: 15_000,
      });
      // White behind both renders, and no panels over the canvas.
      await page.evaluate(() => {
        const e = (window as unknown as W).drawpane;
        e.setProp([e.s.pageId], "backgroundColor", "#ffffff", "Background");
      });
      await page.keyboard.press("ControlOrMeta+Shift+Backslash");
    });

    test.afterAll(async () => {
      await instance?.stop();
      mkdirSync(OUT, { recursive: true });
      writeFileSync(
        join(OUT, "svg.html"),
        `<!doctype html><meta charset="utf-8"><title>SVG import fidelity</title><style>body{font:13px system-ui;margin:24px;background:#f4f3ef}img{width:240px;display:block;background:#fff}td,th{padding:4px 8px;vertical-align:top;text-align:left}small{color:#666}</style><h1>SVG import fidelity</h1><p>Each SVG drawn by the browser, against the layers Drawpane imported from it, drawn by Drawpane: mean difference over RGB (0–255), 99th percentile, and where they differ.</p><table><tr><th></th><th>Browser</th><th>Imported</th><th>Difference</th></tr>${rows.join("")}</table>`,
      );
      console.log(
        `SVG import fidelity: ${Object.entries(scores)
          .map(([name, s]) => `${name} mean ${s.mean} p99 ${s.p99}`)
          .join("; ")}`,
      );
    });

    for (const name of Object.keys(THRESHOLDS)) {
      test(`${name} looks the same imported`, async () => {
        const text = readFileSync(join(FIXTURES, name), "utf8");
        const frame = await paste(page, text);
        const width = Math.round(frame.width * SCALE);
        const height = Math.round(frame.height * SCALE);
        const theirs = await original(page, text, width, height);
        const ours = await rendered(page, frame);
        const diff = compare(ours, theirs, width, height);
        scores[name] = { mean: diff.mean, p99: diff.p99 };
        rows.push(
          `<tr><th>${name}<br><small>${diff.mean} · p99 ${diff.p99}</small></th><td><img src="${await encodePng(page, theirs, width, height)}"></td><td><img src="${await encodePng(page, ours, width, height)}"></td><td><img src="${await encodePng(page, diff.heat, width, height)}"></td></tr>`,
        );
        console.log(`${name}: mean ${diff.mean}, p99 ${diff.p99}`);
        // Out of the way of the next one.
        await page.evaluate((id) => {
          const e = (window as unknown as W).drawpane;
          e.select([id]);
          e.deleteSelection();
        }, frame.id);
        expect(diff.mean, `${name} drifted from the browser's render`).toBeLessThanOrEqual(
          THRESHOLDS[name] as number,
        );
      });
    }
  });
