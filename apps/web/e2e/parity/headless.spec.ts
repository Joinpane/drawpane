/** The open editor's canvas export compared with the headless CPU engine at 2×. */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { freshInstance, type Instance } from "../fresh-instance";
import { compare, encodePng } from "./pixels";

const FIGMA = fileURLToPath(new URL("../../../../tools/figma-parity/scenes", import.meta.url));
const ROOT = fileURLToPath(new URL("../../../../tools/headless-parity", import.meta.url));
const THRESHOLDS = join(ROOT, "thresholds.json");
const OUT =
  process.env.PARITY_OUT ?? fileURLToPath(new URL("../../test-results/parity", import.meta.url));
const SCALE = 2;
/** The Figma suites worth drawing headless: not the glass probes, which repeat `glass`. */
const FROM_FIGMA = [
  "fills",
  "strokes",
  "shadows",
  "blurs",
  "masks",
  "text",
  "text-ranges",
  "lists",
  "vertical-trim",
  "glass",
  "grain",
  "linear-blends",
  "corners",
  "corners-glass",
];

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
  /** A picture to upload for image fills that name "$IMAGE": its size. */
  readonly image?: { width: number; height: number };
  readonly cells: ReadonlyArray<{ readonly id: string; readonly layers: readonly Layer[] }>;
}
type Thresholds = Record<string, Record<string, number>>;
interface Headless {
  png: string;
  width: number;
  height: number;
  approximate: string[];
  missingFonts: string[];
  missingImages: string[];
}
type W = {
  drawpane: {
    s: { pageId: string };
    createLayer(
      type: string,
      rect: { x: number; y: number; width: number; height: number },
      parent: string,
      props?: Record<string, unknown>,
    ): string | null;
    select(ids: string[]): void;
  };
  drawpaneHeadless: {
    headless(id: string, scale: number, background: string | null): Promise<Headless>;
    canvas(id: string, scale: number, background: string | null): Promise<string>;
    browser(id: string, scale: number, background: string | null): Promise<string>;
  };
};

const useBrowserEngine = process.env.HEADLESS_PARITY_BROWSER === "1";

const read = (dir: string, names?: readonly string[]): Suite[] =>
  readdirSync(dir)
    .filter((f) => f.endsWith(".json") && (!names || names.includes(f.slice(0, -5))))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Suite);
const suites: Suite[] = [...read(FIGMA, FROM_FIGMA), ...read(join(ROOT, "scenes"))];
const recorded: Thresholds = existsSync(THRESHOLDS)
  ? (JSON.parse(readFileSync(THRESHOLDS, "utf8")) as Thresholds)
  : {};
const updating = process.env.UPDATE_THRESHOLDS === "1";

const cellOrigin = (suite: Suite, i: number) => ({
  x: (i % suite.cell.columns) * (suite.cell.width + suite.cell.gap),
  y: Math.floor(i / suite.cell.columns) * (suite.cell.height + suite.cell.gap),
});

/** A picture for image fills, drawn and uploaded in the page: soft gradients, shapes and fine lines. */
function uploadImage(page: Page, size: { width: number; height: number }): Promise<string> {
  return page.evaluate(async ({ width, height }) => {
    const c = new OffscreenCanvas(width, height);
    const ctx = c.getContext("2d") as OffscreenCanvasRenderingContext2D;
    const sky = ctx.createLinearGradient(0, 0, 0, height);
    sky.addColorStop(0, "#2b4fd6");
    sky.addColorStop(1, "#ffd166");
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = "#e8590c";
    ctx.beginPath();
    ctx.arc(width * 0.7, height * 0.45, height * 0.22, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#1c1b1a";
    ctx.fillRect(0, height * 0.75, width, height * 0.25);
    ctx.strokeStyle = "#ffffff";
    for (let x = 0; x < width; x += 16) {
      ctx.beginPath();
      ctx.moveTo(x, height * 0.75);
      ctx.lineTo(x + 8, height);
      ctx.stroke();
    }
    const blob = await c.convertToBlob({ type: "image/png" });
    const fileId = /\/f\/([^/]+)/.exec(location.pathname)?.[1] ?? "";
    const response = await fetch(`/api/files/${encodeURIComponent(fileId)}/media`, {
      method: "POST",
      body: blob,
    });
    return ((await response.json()) as { sha: string }).sha;
  }, size);
}

/** Builds a suite's cells, as parity.spec.ts does; returns each cell's frame. */
function build(page: Page, suite: Suite, image: string | null): Promise<string[]> {
  const text = JSON.stringify(suite.cells).replaceAll('"$IMAGE"', JSON.stringify(image ?? ""));
  return page.evaluate(
    ({ suite, cells, origins }) => {
      const e = (window as unknown as W).drawpane;
      const place = (layer: Layer, parent: string, at: { x: number; y: number }) => {
        const { type, x, y, width, height, children, ...props } = layer;
        const id = e.createLayer(type, { x: at.x + x, y: at.y + y, width, height }, parent, {
          fills: [],
          ...props,
        });
        if (id) for (const child of children ?? []) place(child, id, { x: at.x + x, y: at.y + y });
      };
      const frames = (cells as Suite["cells"]).map((cell, i) => {
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
              { fills: [{ type: "solid", color: k % 2 ? "#ffffffa6" : "#1c1b1aa6" }] },
            );
          for (let x = 0; x < suite.cell.width; x += 30)
            e.createLayer(
              "rect",
              { x: at.x + x, y: at.y, width: 4, height: suite.cell.height },
              frame,
              { fills: [{ type: "solid", color: "#0b3d918c" }] },
            );
        }
        for (const layer of cell.layers) place(layer, frame, at);
        return frame;
      });
      e.select([]);
      return frames;
    },
    {
      suite: { cell: suite.cell, background: suite.background, backdrop: suite.backdrop },
      cells: JSON.parse(text) as Suite["cells"],
      origins: suite.cells.map((_, i) => cellOrigin(suite, i)),
    },
  );
}

/** Waits for the web fonts the suite's text uses, so the canvas draws in them (see parity.spec.ts). */
async function waitForFonts(page: Page, suite: Suite): Promise<void> {
  const faces = new Set<string>();
  const visit = (layer: Layer) => {
    if (layer.type === "text") {
      const runs = (layer.textRuns as Array<Record<string, unknown>> | undefined) ?? [];
      for (const style of [layer, ...runs]) {
        const italic = (style.fontStyle ?? layer.fontStyle) === "italic" ? "italic " : "";
        const weight = style.fontWeight ?? layer.fontWeight ?? 400;
        const family = style.fontFamily ?? layer.fontFamily ?? "Instrument Sans";
        faces.add(`${italic}${weight} 16px "${family}"`);
      }
    }
    for (const child of layer.children ?? []) visit(child);
  };
  for (const cell of suite.cells) for (const layer of cell.layers) visit(layer);
  if (faces.size === 0) return;
  await page.evaluate(
    async (faces) => {
      const deadline = performance.now() + 20_000;
      const loaded = async (font: string) => (await document.fonts.load(font)).length > 0;
      for (;;) {
        const all = await Promise.all(faces.map(loaded));
        if (all.every(Boolean) || performance.now() > deadline) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      await document.fonts.ready;
    },
    [...faces],
  );
}

/** RGBA pixels (base64) of a PNG (base64), decoded by the browser. */
function rgba(page: Page, png: string): Promise<{ data: string; width: number; height: number }> {
  return page.evaluate(async (png) => {
    const bitmap = await createImageBitmap(
      new Blob([Uint8Array.from(atob(png), (c) => c.charCodeAt(0))], { type: "image/png" }),
      { colorSpaceConversion: "none", premultiplyAlpha: "none" },
    );
    const c = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = c.getContext("2d") as OffscreenCanvasRenderingContext2D;
    ctx.drawImage(bitmap, 0, 0);
    const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
    let s = "";
    for (let i = 0; i < data.length; i += 0x8000)
      s += String.fromCharCode(...data.subarray(i, i + 0x8000));
    return { data: btoa(s), width: bitmap.width, height: bitmap.height };
  }, png);
}

test.describe("Render parity: canvas and headless", () => {
  test.skip(!!process.env.E2E_BASE_URL, "Needs its own local instance.");

  let instance: Instance;
  const results: Thresholds = {};
  const report: string[] = [];
  const summary: string[] = [];

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000);
    const port = Number(process.env.HEADLESS_PARITY_PORT ?? 9005);
    const inspectorPort = Number(process.env.HEADLESS_PARITY_INSPECTOR_PORT ?? port + 540);
    instance = await freshInstance(browser, { port, inspectorPort });
    // The canvas loads its web fonts. The outline pass reads deterministic TrueType fixtures.
    const fontFixtures = {
      Inter: ["Inter-Variable.ttf", "Inter-Italic-Variable.ttf"],
      "Instrument Sans": ["InstrumentSans-Variable.ttf"],
    } as const;
    for (const file of Object.values(fontFixtures).flat()) {
      const bytes = readFileSync(fileURLToPath(new URL(`../fixtures/${file}`, import.meta.url)));
      await instance.page.route(`**/parity/${file}`, (route) =>
        route.fulfill({ body: bytes, contentType: "font/ttf" }),
      );
    }
    await instance.page.route("**/api/fonts/google.css?**", (route) => {
      const query = new URL(route.request().url()).searchParams;
      const family = query.get("family") as keyof typeof fontFixtures;
      if (!Object.hasOwn(fontFixtures, family) || query.get("format") !== "ttf")
        return route.continue();
      const weights = (query.get("variants") ?? "400").split(",");
      const body = weights
        .map((weight) => {
          const [upright, italic] = fontFixtures[family];
          const file = weight.endsWith("i") ? italic : upright;
          return file
            ? `@font-face { font-weight: ${parseInt(weight, 10)}; font-style: ${file === italic ? "italic" : "normal"}; src: url(/parity/${file}) format('truetype'); }`
            : "";
        })
        .join("\n");
      return route.fulfill({ body, contentType: "text/css" });
    });
    await instance.page.evaluate(() => {
      localStorage.setItem("drawpane:debug", "1");
      localStorage.setItem("drawpane:face-deadline-ms", "20000");
    });
  });

  test.afterAll(async () => {
    await instance?.stop();
    mkdirSync(OUT, { recursive: true });
    writeFileSync(
      join(OUT, "headless.html"),
      `<!doctype html><meta charset="utf-8"><title>Headless render parity</title><style>body{font:13px system-ui;margin:24px;background:#f4f3ef}img{width:240px;display:block}td,th{padding:4px 8px;vertical-align:top;text-align:left}h2{margin-top:32px}small{color:#666}</style><h1>Render parity: canvas and headless</h1><p>Each cell exported at 2× by the canvas renderer and by the headless CPU engine. Mean difference over RGB (0–255) and its 99th percentile; the heat map is white where the two are 64 or more apart.</p><pre>${summary.join("\n")}</pre>${report.join("")}`,
    );
    if (updating) {
      const next: Thresholds = { ...recorded };
      // A little headroom over today's score, as parity.spec.ts records: drift beyond it fails.
      for (const [suite, cells] of Object.entries(results))
        next[suite] = Object.fromEntries(
          Object.entries(cells).map(([id, mean]) => [
            id,
            Math.round((mean * 1.1 + 0.3) * 100) / 100,
          ]),
        );
      writeFileSync(THRESHOLDS, `${JSON.stringify(next, null, 2)}\n`);
    }
    console.log(summary.join("\n"));
  });

  for (const suite of suites) {
    test(`${suite.suite}: ${suite.about}`, async () => {
      test.setTimeout(300_000);
      const page = instance.page;
      await page.goto("/");
      await page.getByRole("button", { name: "New file" }).first().click();
      await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
        timeout: 15_000,
      });
      const image = suite.image ? await uploadImage(page, suite.image) : null;
      const frames = await build(page, suite, image);
      await waitForFonts(page, suite);
      // Late fonts re-measure text and lay auto layout out again.
      await page.waitForTimeout(1500);

      const rows: string[] = [];
      const failures: string[] = [];
      const scores: Record<string, number> = {};
      results[suite.suite] = scores;
      for (const [i, cell] of suite.cells.entries()) {
        const frame = frames[i] as string;
        const [canvasPng, actual] = await page.evaluate(
          async ({ frame, scale, browserEngine }) => {
            const h = (window as unknown as W).drawpaneHeadless;
            const canvas = h.canvas(frame, scale, null);
            if (browserEngine) {
              const png = await h.browser(frame, scale, null);
              return [
                await canvas,
                { png, approximate: [] as string[], missingFonts: null, missingImages: null },
              ] as const;
            }
            const headless = await h.headless(frame, scale, null);
            return [await canvas, headless] as const;
          },
          { frame, scale: SCALE, browserEngine: useBrowserEngine },
        );
        // The circle exposes platform-dependent CSS blur. The translucent mask
        // tests Figma's coverage rule directly.
        const figmaBlur = suite.suite === "corners" && cell.id === "layer-blur";
        const figmaMask = suite.suite === "masks" && cell.id === "luminance-translucent";
        const fromFigma = figmaBlur || figmaMask;
        const referencePng = fromFigma
          ? readFileSync(join(FIGMA, "../goldens", suite.suite, `${cell.id}.png`)).toString(
              "base64",
            )
          : canvasPng;
        const theirs = await rgba(page, referencePng);
        const ours = await rgba(page, actual.png);
        expect([ours.width, ours.height], `${cell.id} size`).toEqual([theirs.width, theirs.height]);
        if (actual.missingFonts !== null && actual.missingImages !== null) {
          // Instrument Sans tops out at 700. This cell also checks the missing-weight note.
          const missingFonts = cell.id === "instrument-40-800" ? ["Instrument Sans 800"] : [];
          expect(actual.missingFonts, `${cell.id} fonts`).toEqual(missingFonts);
          expect(actual.missingImages, `${cell.id} images`).toEqual([]);
        }
        const diff = await compare(
          page,
          ours.data,
          theirs.data,
          ours.width,
          ours.height,
          suite.blur,
        );
        scores[cell.id] = diff.mean;
        if (fromFigma) {
          expect(diff.p99, "Figma p99").toBeLessThanOrEqual(5);
          expect(diff.worstTile, "Figma worst tile").toBeLessThanOrEqual(2);
        }
        const limit = recorded[suite.suite]?.[cell.id];
        if (!updating && limit !== undefined && diff.mean > limit)
          failures.push(`${cell.id}: ${diff.mean} (allowed ${limit})`);
        if (!updating && limit === undefined) failures.push(`${cell.id}: no threshold recorded`);
        const img = (b64: string) => encodePng(page, b64, ours.width, ours.height);
        const note = actual.approximate.length
          ? `<br><small>approximate: ${actual.approximate.join(", ")}</small>`
          : "";
        rows.push(
          `<tr><th>${cell.id}<br><small>${fromFigma ? "Figma · " : ""}${diff.mean} · p99 ${diff.p99} · worst tile ${diff.worstTile}${limit !== undefined ? ` · max ${limit}` : ""}</small>${note}</th><td><img src="data:image/png;base64,${referencePng}"></td><td><img src="data:image/png;base64,${actual.png}"></td><td><img src="${await img(diff.heat)}"></td></tr>`,
        );
      }
      const values = Object.values(scores);
      const mean = values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);
      const worst = Object.entries(scores)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([id, v]) => `${id} ${v}`)
        .join(", ");
      summary.push(
        `${suite.suite}: mean ${mean.toFixed(2)} over ${values.length} cells; worst ${worst}`,
      );
      report.push(
        `<h2>${suite.suite} <small>mean ${mean.toFixed(2)} over ${values.length} cells</small></h2><p>${suite.about}</p><table><tr><th></th><th>Reference</th><th>Headless</th><th>Difference</th></tr>${rows.join("")}</table>`,
      );
      expect(failures, `${suite.suite} drifted between canvas and headless`).toEqual([]);
    });
  }
});
