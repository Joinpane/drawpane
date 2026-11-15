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
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { freshInstance, type Instance } from "../fresh-instance";
import { compare, decodePng, encodePng } from "./pixels";

const ROOT = fileURLToPath(new URL("../../../../tools/figma-parity", import.meta.url));
const SCALE = 2;
const THRESHOLDS = join(ROOT, "thresholds.json");
const OUT =
  process.env.PARITY_OUT ?? fileURLToPath(new URL("../../test-results/parity", import.meta.url));

interface Layer {
  readonly type: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly children?: readonly Layer[];
  readonly [prop: string]: unknown;
}
interface Suite {
  readonly suite: string;
  readonly about: string;
  readonly cell: { width: number; height: number; gap: number; columns: number };
  readonly background?: string;
  readonly backdrop?: "stripes";
  /** Compare after blurring both by this many px: for grain, whose pixels are random. */
  readonly blur?: number;
  readonly cells: ReadonlyArray<{ readonly id: string; readonly layers: readonly Layer[] }>;
}
type Thresholds = Record<string, Record<string, number>>;
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
    centerOn(p: { x: number; y: number }): void;
    createPage?(): string;
  };
  drawpaneFrames: { redraw(): void };
};

const suites: Suite[] = readdirSync(join(ROOT, "scenes"))
  .filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(readFileSync(join(ROOT, "scenes", f), "utf8")) as Suite);
const recorded: Thresholds = existsSync(THRESHOLDS)
  ? (JSON.parse(readFileSync(THRESHOLDS, "utf8")) as Thresholds)
  : {};
const updating = process.env.UPDATE_THRESHOLDS === "1";

const cellOrigin = (suite: Suite, i: number) => ({
  x: (i % suite.cell.columns) * (suite.cell.width + suite.cell.gap),
  y: Math.floor(i / suite.cell.columns) * (suite.cell.height + suite.cell.gap),
});
const gridSize = (suite: Suite) => ({
  width: suite.cell.columns * (suite.cell.width + suite.cell.gap),
  height: Math.ceil(suite.cells.length / suite.cell.columns) * (suite.cell.height + suite.cell.gap),
});

/** Builds a suite's cells on the page, as figma-builder.js builds them in Figma. */
function build(page: Page, suite: Suite) {
  return page.evaluate(
    ({ suite, origins }) => {
      const e = (window as unknown as W).drawpane;
      const place = (layer: Layer, parent: string, at: { x: number; y: number }) => {
        const { type, x, y, width, height, children, ...props } = layer;
        const id = e.createLayer(type, { x: at.x + x, y: at.y + y, width, height }, parent, {
          fills: [],
          ...props,
        });
        if (id) for (const child of children ?? []) place(child, id, { x: at.x + x, y: at.y + y });
      };
      suite.cells.forEach((cell, i) => {
        const at = origins[i] as { x: number; y: number };
        const frame = e.createLayer(
          "frame",
          { ...at, width: suite.cell.width, height: suite.cell.height },
          e.s.pageId,
          { clipContent: true, fills: [{ type: "solid", color: suite.background ?? "#ffffff" }] },
        ) as string;
        if (suite.backdrop === "stripes") {
          // Bars both ways over a warm-to-cool gradient, as figma-builder.js draws them.
          e.createLayer(
            "rect",
            { ...at, width: suite.cell.width, height: suite.cell.height },
            frame,
            {
              fills: [
                {
                  type: "linear",
                  from: { x: 0, y: 0.5 },
                  to: { x: 1, y: 0.5 },
                  stops: [
                    { position: 0, color: "#ff7a45" },
                    { position: 0.5, color: "#ffd166" },
                    { position: 1, color: "#3d7bf0" },
                  ],
                },
              ],
            },
          );
          for (let y = 0, k = 0; y < suite.cell.height; y += 24, k++)
            e.createLayer(
              "rect",
              { x: at.x, y: at.y + y, width: suite.cell.width, height: 6 },
              frame,
              {
                fills: [{ type: "solid", color: k % 2 ? "#ffffffa6" : "#1c1b1aa6" }],
              },
            );
          for (let x = 0; x < suite.cell.width; x += 30)
            e.createLayer(
              "rect",
              { x: at.x + x, y: at.y, width: 4, height: suite.cell.height },
              frame,
              {
                fills: [{ type: "solid", color: "#0b3d918c" }],
              },
            );
        }
        for (const layer of cell.layers) place(layer, frame, at);
      });
      e.select([]);
    },
    { suite, origins: suite.cells.map((_, i) => cellOrigin(suite, i)) },
  );
}

/** Every cell's pixels on the canvas at 2× (RGBA, base64), in the suite's order. */
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

test.describe
  .serial("Render parity with Figma", () => {
    let instance: Instance;
    const results: Thresholds = {};
    const report: string[] = [];

    test.beforeAll(async ({ browser }) => {
      test.setTimeout(180_000);
      instance = await freshInstance(browser, { port: 8941, inspectorPort: 9481 });
      await instance.page.evaluate(() => localStorage.setItem("drawpane:debug", "1"));
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
        await page.setViewportSize({
          width: Math.min(4000, grid.width * SCALE + 200),
          height: Math.min(4000, grid.height * SCALE + 200),
        });
        await page.goto("/");
        await page.getByRole("button", { name: "New file" }).first().click();
        await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
          timeout: 15_000,
        });
        await page.keyboard.press("ControlOrMeta+Shift+Backslash");
        await build(page, suite);
        await page.evaluate(
          ({ grid, scale }) => {
            const e = (window as unknown as W).drawpane;
            e.zoomTo(scale);
            e.centerOn({ x: grid.width / 2, y: grid.height / 2 });
          },
          { grid, scale: SCALE },
        );
        await page.waitForTimeout(1500);
        const ours = await capture(page, suite);
        const width = suite.cell.width * SCALE;
        const height = suite.cell.height * SCALE;

        const rows: string[] = [];
        const failures: string[] = [];
        results[suite.suite] = {};
        for (const [i, cell] of suite.cells.entries()) {
          const golden = join(ROOT, "goldens", suite.suite, `${cell.id}.png`);
          if (!existsSync(golden)) continue;
          const theirs = await decodePng(page, golden);
          expect(theirs.width, `${cell.id} golden size`).toBe(width);
          const diff = await compare(
            page,
            ours[i] as string,
            theirs.data,
            width,
            height,
            suite.blur,
          );
          (results[suite.suite] as Record<string, number>)[cell.id] = diff.mean;
          const limit = recorded[suite.suite]?.[cell.id];
          if (!updating && limit !== undefined && diff.mean > limit)
            failures.push(`${cell.id}: ${diff.mean} (allowed ${limit})`);
          const img = (b64: string) => encodePng(page, b64, width, height);
          rows.push(
            `<tr><th>${cell.id}<br><small>${diff.mean} · p99 ${diff.p99}${limit !== undefined ? ` · max ${limit}` : ""}</small></th><td><img src="data:image/png;base64,${readFileSync(golden).toString("base64")}"></td><td><img src="${await img(ours[i] as string)}"></td><td><img src="${await img(diff.heat)}"></td></tr>`,
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
