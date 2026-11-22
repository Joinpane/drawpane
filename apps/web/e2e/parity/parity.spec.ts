/**
 * Render parity with Figma (tools/figma-parity): every scene drawn in
 * Drawpane at 2× and compared, cell by cell, with Figma's own render of the
 * same scene (the goldens). Each cell's mean difference must stay within its
 * recorded threshold, so a render that drifts from Figma fails here; one
 * that gets closer is locked in by recording thresholds again:
 *
 *   UPDATE_THRESHOLDS=1 npx playwright test e2e/parity
 *
 * Writes a report (Figma, Drawpane and a heat map of the difference, per
 * cell) to PARITY_OUT, by default test-results/parity/index.html.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { freshInstance, type Instance } from "../fresh-instance";
import { compare, decodePng, encodePng } from "./pixels";
import {
  build,
  cellOrigin,
  exportRect,
  gridSize,
  over,
  ROOT,
  recorded,
  SCALE,
  type Suite,
  suites,
  THRESHOLDS,
  type Thresholds,
  updating,
  type W,
  waitForFonts,
} from "./suites";

const OUT =
  process.env.PARITY_OUT ?? fileURLToPath(new URL("../../test-results/parity", import.meta.url));

/**
 * Every cell's pixels at 2×, each drawn centred in the view: a suite's grid
 * can be bigger than any viewport.
 */
function capture(page: Page, suite: Suite): Promise<string[]> {
  return page.evaluate(
    async ({ rects, scale }) => {
      const w = window as unknown as W;
      const frames = async () => {
        for (let i = 0; i < 4; i++) await new Promise((r) => requestAnimationFrame(() => r(null)));
      };
      const canvas = document.querySelector(".canvas canvas") as HTMLCanvasElement;
      const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
      const ratio = canvas.width / canvas.getBoundingClientRect().width;
      const out: string[] = [];
      for (const rect of rects) {
        w.drawpane.centerOn({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
        w.drawpaneFrames.redraw();
        await frames();
        const at = w.drawpane.s.camera.toScreen({ x: rect.x, y: rect.y });
        const data = ctx.getImageData(
          Math.round(at.x * ratio),
          Math.round(at.y * ratio),
          rect.width * scale,
          rect.height * scale,
        ).data;
        let s = "";
        for (let i = 0; i < data.length; i += 0x8000)
          s += String.fromCharCode(...data.subarray(i, i + 0x8000));
        out.push(btoa(s));
      }
      return out;
    },
    {
      rects: suite.cells.map((_, i) => ({
        ...cellOrigin(suite, i),
        width: suite.cell.width,
        height: suite.cell.height,
      })),
      scale: SCALE,
    },
  );
}

/**
 * Every cell drawn alone, as an export draws it (no canvas behind it), at 2×: RGBA as base64.
 * For suites with no background, whose renders' alpha counts.
 */
function captureAlone(page: Page, suite: Suite, frames: readonly string[]): Promise<string[]> {
  return page.evaluate(
    async ({ frames, rects, scale }) => {
      const p = (window as unknown as W).drawpaneParity;
      const out: string[] = [];
      for (const [i, id] of frames.entries()) {
        const rect = rects[i] as { x: number; y: number; width: number; height: number };
        const w = rect.width * scale;
        const h = rect.height * scale;
        const { png } = await p.render(id, rect, scale, w, h);
        const bytes = Uint8Array.from(atob(png), (ch) => ch.charCodeAt(0));
        const img = await createImageBitmap(new Blob([bytes], { type: "image/png" }), {
          premultiplyAlpha: "none",
        });
        const c = new OffscreenCanvas(w, h);
        const ctx = c.getContext("2d") as OffscreenCanvasRenderingContext2D;
        ctx.drawImage(img, 0, 0);
        const data = ctx.getImageData(0, 0, w, h).data;
        let s = "";
        for (let j = 0; j < data.length; j += 0x8000)
          s += String.fromCharCode(...data.subarray(j, j + 0x8000));
        out.push(btoa(s));
      }
      return out;
    },
    { frames, rects: suite.cells.map((_, i) => exportRect(suite, i)), scale: SCALE },
  );
}

test.describe
  .serial("Render parity with Figma", () => {
    let instance: Instance;
    const results: Thresholds = {};
    const report: string[] = [];

    test.beforeAll(async ({ browser }) => {
      test.setTimeout(180_000);
      // PARITY_PORT: another port, when another checkout runs the suite at once.
      const port = Number(process.env.PARITY_PORT ?? 8941);
      instance = await freshInstance(browser, { port, inspectorPort: port + 540 });
      await instance.page.evaluate(() => localStorage.setItem("drawpane:debug", "1"));
      // PARITY_THROTTLE=6 slows the CPU as a busy CI machine does, to reproduce what only fails there.
      if (process.env.PARITY_THROTTLE) {
        const cdp = await instance.page.context().newCDPSession(instance.page);
        await cdp.send("Emulation.setCPUThrottlingRate", {
          rate: Number(process.env.PARITY_THROTTLE),
        });
      }
    });

    test.afterAll(async () => {
      await instance?.stop();
      mkdirSync(OUT, { recursive: true });
      writeFileSync(
        join(OUT, "index.html"),
        `<!doctype html><meta charset="utf-8"><title>Render parity</title><style>body{font:13px system-ui;margin:24px;background:#f4f3ef}img{width:240px;display:block}td,th{padding:4px 8px;vertical-align:top;text-align:left}h2{margin-top:32px}small{color:#666}</style><h1>Render parity with Figma</h1><p>Mean difference over RGB (0–255) and its 99th percentile; the heat map is white where the two are 64 or more apart.</p>${report.join("")}`,
      );
      if (updating) {
        const next: Thresholds = { ...recorded };
        // A little headroom over today's score: drift beyond it fails.
        for (const [suite, cells] of Object.entries(results))
          next[suite] = Object.fromEntries(
            Object.entries(cells).map(([id, mean]) => [
              id,
              Math.round((mean * 1.1 + 0.3) * 100) / 100,
            ]),
          );
        writeFileSync(THRESHOLDS, `${JSON.stringify(next, null, 2)}\n`);
      }
    });

    for (const suite of suites) {
      test(`${suite.suite}: ${suite.about}`, async () => {
        test.setTimeout(240_000);
        const page = instance.page;
        const grid = gridSize(suite);
        // Each glass probe is clipped to its own frame. A viewport sized to one cell
        // avoids redrawing most of the grid's lenses each time capture centers a cell.
        const view = suite.suite === "glass-probe-2" ? suite.cell : grid;
        await page.setViewportSize({
          width: Math.min(4000, view.width * SCALE + 200),
          height: Math.min(4000, view.height * SCALE + 200),
        });
        await page.goto("/");
        await page.getByRole("button", { name: "New file" }).first().click();
        await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
          timeout: 15_000,
        });
        await page.keyboard.press("ControlOrMeta+Shift+Backslash");
        const frames = await build(page, suite);
        await waitForFonts(page, suite);
        await page.evaluate(
          ({ grid, scale }) => {
            const e = (window as unknown as W).drawpane;
            e.zoomTo(scale);
            e.centerOn({ x: grid.width / 2, y: grid.height / 2 });
          },
          { grid, scale: SCALE },
        );
        await page.waitForTimeout(1500);
        const clear = suite.background === "none" || suite.export !== undefined;
        const ours = clear ? await captureAlone(page, suite, frames) : await capture(page, suite);

        const rows: string[] = [];
        const failures: string[] = [];
        results[suite.suite] = {};
        for (const [i, cell] of suite.cells.entries()) {
          const golden = join(ROOT, "goldens", suite.suite, `${cell.id}.png`);
          if (!existsSync(golden)) continue;
          const width = exportRect(suite, i).width * SCALE;
          const height = exportRect(suite, i).height * SCALE;
          const theirs = await decodePng(page, golden);
          expect(theirs.width, `${cell.id} golden size`).toBe(width);
          const diff = clear
            ? // Over white and over black, so alpha counts as much as colour.
              await Promise.all(
                [255, 0].map((grey) =>
                  compare(
                    page,
                    over(ours[i] as string, grey),
                    over(theirs.data, grey),
                    width,
                    height,
                    suite.blur,
                  ),
                ),
              ).then(([white, black]) => ({
                mean: Math.round((((white?.mean ?? 0) + (black?.mean ?? 0)) / 2) * 100) / 100,
                p99: Math.max(white?.p99 ?? 0, black?.p99 ?? 0),
                worstTile: Math.max(white?.worstTile ?? 0, black?.worstTile ?? 0),
                heat: white?.heat ?? "",
              }))
            : await compare(page, ours[i] as string, theirs.data, width, height, suite.blur);
          // Drawpane's render, as a file next to the report: for fitting against the golden.
          mkdirSync(join(OUT, suite.suite), { recursive: true });
          const ourPng = await encodePng(page, ours[i] as string, width, height);
          writeFileSync(
            join(OUT, suite.suite, `${cell.id}.png`),
            Buffer.from(ourPng.slice(ourPng.indexOf(",") + 1), "base64"),
          );
          (results[suite.suite] as Record<string, number>)[cell.id] = diff.mean;
          const limit = recorded[suite.suite]?.[cell.id];
          if (!updating && limit !== undefined && diff.mean > limit)
            failures.push(`${cell.id}: ${diff.mean} (allowed ${limit})`);
          const img = (b64: string) => encodePng(page, b64, width, height);
          rows.push(
            `<tr><th>${cell.id}<br><small>${diff.mean} · p99 ${diff.p99} · tile ${diff.worstTile}${limit !== undefined ? ` · max ${limit}` : ""}</small></th><td><img src="data:image/png;base64,${readFileSync(golden).toString("base64")}"></td><td><img src="${await img(ours[i] as string)}"></td><td><img src="${await img(diff.heat)}"></td></tr>`,
          );
        }
        const scores = Object.values(results[suite.suite] as Record<string, number>);
        const mean = scores.reduce((a, b) => a + b, 0) / Math.max(1, scores.length);
        report.push(
          `<h2>${suite.suite} <small>mean ${mean.toFixed(2)} over ${scores.length} cells</small></h2><p>${suite.about}</p><table><tr><th></th><th>Figma</th><th>Drawpane</th><th>Difference</th></tr>${rows.join("")}</table>`,
        );
        console.log(
          `${suite.suite}: mean difference ${mean.toFixed(2)} over ${scores.length} cells`,
        );
        expect(failures, `${suite.suite} drifted from Figma`).toEqual([]);
      });
    }
  });
