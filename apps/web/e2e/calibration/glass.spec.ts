/**
 * Fits glass's constants (GlassTuning) to Figma's renders of the same cells
 * (tools/glass-calibration). Run by hand:
 *
 *   TARGET_DIR=/path/to/figma-pngs OUT_DIR=/tmp/glass-fit \
 *     pnpm --filter @drawpane/web exec playwright test --project=calibration
 *
 * TARGET_DIR holds Figma's renders at 2×, glass-<id>.png (fetch-figma.mjs
 * writes them). Without it, a self-test fits to Drawpane's own renders at a
 * known tuning, to show the fitter finds it. OUT_DIR gets the fitted tuning,
 * each cell's renders and a page comparing them.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { freshInstance } from "../fresh-instance";

const SCENES = JSON.parse(
  readFileSync(new URL("../../../../tools/glass-calibration/scenes.json", import.meta.url), "utf8"),
) as Scenes;
const SCALE = 2;

interface Cell {
  id: string;
  shape?: "ellipse";
  glass?: Partial<Box & { cornerRadius: number }>;
  [setting: string]: unknown;
}
interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}
interface Scenes {
  cell: { width: number; height: number; gap: number; columns: number };
  backdrop: {
    gradient: Array<{ position: number; color: string }>;
    rows: { every: number; height: number; colors: string[]; opacity: number };
    columns: { every: number; width: number; color: string; opacity: number };
  };
  glass: Box & { cornerRadius: number };
  defaults: Record<string, number>;
  cells: Cell[];
}

/** One fitted constant: its range, and the first step the search takes. */
const SEARCH: Record<string, { min: number; max: number; step: number }> = {
  bend: { min: 0.05, max: 1.2, step: 0.1 },
  profile: { min: 1, max: 6, step: 0.5 },
  dispersion: { min: 0, max: 0.8, step: 0.05 },
  frost: { min: 0.1, max: 3, step: 0.2 },
  angleOffset: { min: -180, max: 180, step: 45 },
  lineWidth: { min: 0.005, max: 0.3, step: 0.02 },
  lineMin: { min: 0.5, max: 4, step: 0.5 },
  line: { min: 0, max: 3, step: 0.2 },
  glowWidth: { min: 0.05, max: 1.2, step: 0.1 },
  glowMin: { min: 1, max: 12, step: 1 },
  glow: { min: 0, max: 1.5, step: 0.1 },
  facing: { min: 0.5, max: 5, step: 0.5 },
  backLine: { min: 0, max: 2, step: 0.2 },
  backGlow: { min: 0, max: 1, step: 0.1 },
  backFacing: { min: 0.5, max: 5, step: 0.5 },
  sheen: { min: 0, max: 0.4, step: 0.03 },
  shade: { min: 0, max: 0.6, step: 0.05 },
};

type Tuning = Record<string, number>;
type W = {
  drawpane: {
    s: {
      pageId: string;
      camera: { toScreen(p: { x: number; y: number }): { x: number; y: number } };
    };
    createLayer(
      type: string,
      rect: Box,
      parent: string,
      props?: Record<string, unknown>,
    ): string | null;
    select(ids: string[]): void;
    zoomTo(z: number): void;
    centerOn(p: { x: number; y: number }): void;
  };
  drawpaneGlass: { set(t: Tuning | null): void; get(): Tuning };
  drawpaneFrames: { redraw(): void };
};

const cellOrigin = (i: number) => ({
  x: (i % SCENES.cell.columns) * (SCENES.cell.width + SCENES.cell.gap),
  y: Math.floor(i / SCENES.cell.columns) * (SCENES.cell.height + SCENES.cell.gap),
});
const glassBox = (cell: Cell) => ({ ...SCENES.glass, ...(cell.glass ?? {}) });

/** Figma's settings as Drawpane's glass effect (0–100 where Figma has 0–1). */
function glassEffect(cell: Cell) {
  const s = { ...SCENES.defaults, ...cell } as Record<string, number>;
  return {
    type: "glass",
    angle: s.lightAngle,
    intensity: Math.round((s.lightIntensity ?? 0) * 100),
    refraction: Math.round((s.refraction ?? 0) * 100),
    depth: Math.min(200, s.depth ?? 20),
    dispersion: Math.round((s.dispersion ?? 0) * 100),
    frost: s.frost ?? 0,
    splay: 0,
  };
}

/** Builds every cell on the page, at 2× with the whole grid in view; each cell's rect on the canvas. */
async function buildCells(page: Page): Promise<Array<{ id: string; rect: Box; glass: Box }>> {
  return page.evaluate(
    ({ scenes, cells }) => {
      const e = (window as unknown as W).drawpane;
      const hex = (c: string, a = 1) =>
        `${c}${Math.round(a * 255)
          .toString(16)
          .padStart(2, "0")}`;
      const out: Array<{ id: string; rect: Box; glass: Box }> = [];
      for (const { cell, origin, glass, effect } of cells) {
        const frame = e.createLayer(
          "frame",
          { x: origin.x, y: origin.y, width: scenes.cell.width, height: scenes.cell.height },
          e.s.pageId,
          {
            clipContent: true,
            fills: [
              {
                type: "linear",
                from: { x: 0, y: 0.5 },
                to: { x: 1, y: 0.5 },
                stops: scenes.backdrop.gradient,
              },
            ],
          },
        ) as string;
        const { rows, columns } = scenes.backdrop;
        for (let y = 0, k = 0; y < scenes.cell.height; y += rows.every, k++)
          e.createLayer(
            "rect",
            { x: origin.x, y: origin.y + y, width: scenes.cell.width, height: rows.height },
            frame,
            {
              fills: [
                {
                  type: "solid",
                  color: hex(rows.colors[k % rows.colors.length] as string, rows.opacity),
                },
              ],
            },
          );
        for (let x = 0; x < scenes.cell.width; x += columns.every)
          e.createLayer(
            "rect",
            { x: origin.x + x, y: origin.y, width: columns.width, height: scenes.cell.height },
            frame,
            {
              fills: [{ type: "solid", color: hex(columns.color, columns.opacity) }],
            },
          );
        e.createLayer(
          cell.shape === "ellipse" ? "ellipse" : "rect",
          {
            x: origin.x + glass.x,
            y: origin.y + glass.y,
            width: glass.width,
            height: glass.height,
          },
          frame,
          {
            ...(cell.shape === "ellipse" ? {} : { cornerRadius: glass.cornerRadius }),
            fills: [],
            effects: [effect],
          },
        );
        out.push({
          id: cell.id,
          rect: { x: origin.x, y: origin.y, width: scenes.cell.width, height: scenes.cell.height },
          glass: { x: glass.x, y: glass.y, width: glass.width, height: glass.height },
        });
      }
      e.select([]);
      return out;
    },
    {
      scenes: SCENES,
      cells: SCENES.cells.map((cell, i) => ({
        cell,
        origin: cellOrigin(i),
        glass: glassBox(cell),
        effect: glassEffect(cell),
      })),
    },
  );
}

/** Draws with `tuning` and reads every cell's pixels on the canvas (RGBA, 2×), as base64. */
async function render(page: Page, tuning: Tuning, cells: Array<{ rect: Box }>): Promise<string[]> {
  return page.evaluate(
    async ({ tuning, cells, scale }) => {
      const w = window as unknown as W;
      w.drawpaneGlass.set(tuning);
      w.drawpaneFrames.redraw();
      for (let i = 0; i < 3; i++) await new Promise((r) => requestAnimationFrame(() => r(null)));
      const canvas = document.querySelector(".canvas canvas") as HTMLCanvasElement;
      const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
      const ratio = canvas.width / canvas.getBoundingClientRect().width;
      return cells.map(({ rect }) => {
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
        return btoa(s);
      });
    },
    { tuning, cells, scale: SCALE },
  );
}

const bytes = (b64: string) => Uint8Array.from(Buffer.from(b64, "base64"));

/** RGBA pixels of a PNG, decoded by the browser. */
async function decodePng(page: Page, file: string): Promise<string> {
  const url = `data:image/png;base64,${readFileSync(file).toString("base64")}`;
  return page.evaluate(async (url) => {
    const img = new Image();
    img.src = url;
    await img.decode();
    const c = new OffscreenCanvas(img.width, img.height);
    const ctx = c.getContext("2d") as OffscreenCanvasRenderingContext2D;
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, img.width, img.height).data;
    let s = "";
    for (let i = 0; i < data.length; i += 0x8000)
      s += String.fromCharCode(...data.subarray(i, i + 0x8000));
    return btoa(s);
  }, url);
}

/** A PNG (as a data URL) of RGBA pixels, encoded by the browser. */
function encodePng(page: Page, b64: string, width: number, height: number): Promise<string> {
  return page.evaluate(
    async ({ b64, width, height }) => {
      const raw = Uint8ClampedArray.from(atob(b64), (ch) => ch.charCodeAt(0));
      const c = new OffscreenCanvas(width, height);
      (c.getContext("2d") as OffscreenCanvasRenderingContext2D).putImageData(
        new ImageData(raw, width, height),
        0,
        0,
      );
      const blob = await c.convertToBlob({ type: "image/png" });
      const buf = new Uint8Array(await blob.arrayBuffer());
      let s = "";
      for (let i = 0; i < buf.length; i += 0x8000)
        s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      return `data:image/png;base64,${btoa(s)}`;
    },
    { b64, width, height },
  );
}

test("fit glass to its targets", async ({ browser }) => {
  const out = process.env.OUT_DIR ?? "/tmp/glass-fit";
  mkdirSync(out, { recursive: true });
  const grid = {
    width: SCENES.cell.columns * (SCENES.cell.width + SCENES.cell.gap),
    height:
      Math.ceil(SCENES.cells.length / SCENES.cell.columns) * (SCENES.cell.height + SCENES.cell.gap),
  };
  const instance = await freshInstance(browser, { port: 8895, inspectorPort: 9435 });
  const page = instance.page;
  // The whole grid in view at 2×, with the UI tucked away.
  await page.setViewportSize({
    width: grid.width * SCALE + 200,
    height: grid.height * SCALE + 200,
  });
  await page.evaluate(() => localStorage.setItem("drawpane:debug", "1"));
  await page.getByRole("button", { name: "New file" }).first().click();
  await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
    timeout: 15_000,
  });
  await page.keyboard.press("ControlOrMeta+Shift+Backslash");
  const cells = await buildCells(page);
  await page.evaluate(
    ({ grid, scale }) => {
      const e = (window as unknown as W).drawpane;
      e.zoomTo(scale);
      e.centerOn({ x: grid.width / 2, y: grid.height / 2 });
    },
    { grid, scale: SCALE },
  );
  await page.waitForTimeout(1500);
  const width = SCENES.cell.width * SCALE;
  const height = SCENES.cell.height * SCALE;
  const defaults = await page.evaluate(() => (window as unknown as W).drawpaneGlass.get());

  // Targets: Figma's renders, or (self-test) Drawpane's own at a known tuning.
  let targets: Uint8Array[];
  let known: Tuning | null = null;
  if (process.env.TARGET_DIR) {
    const dir = process.env.TARGET_DIR;
    targets = [];
    for (const cell of cells)
      targets.push(bytes(await decodePng(page, join(dir, `glass-${cell.id}.png`))));
  } else {
    known = {
      ...defaults,
      bend: 0.7,
      profile: 2,
      dispersion: 0.15,
      line: 1.6,
      glow: 0.5,
      facing: 2,
    };
    targets = (await render(page, known, cells)).map(bytes);
  }

  // The targets stay in the page, where each score is taken: only numbers cross per try.
  await page.evaluate(
    (b64s) => {
      (window as unknown as { glassTargets: Uint8ClampedArray[] }).glassTargets = b64s.map((b) =>
        Uint8ClampedArray.from(atob(b), (ch) => ch.charCodeAt(0)),
      );
    },
    targets.map((t) => Buffer.from(t).toString("base64")),
  );

  const score = async (tuning: Tuning, keep = false) => {
    const result = await page.evaluate(
      async ({ tuning, cells, scale, width, keep }) => {
        const w = window as unknown as W & { glassTargets: Uint8ClampedArray[] };
        w.drawpaneGlass.set(tuning);
        w.drawpaneFrames.redraw();
        for (let i = 0; i < 3; i++) await new Promise((r) => requestAnimationFrame(() => r(null)));
        const canvas = document.querySelector(".canvas canvas") as HTMLCanvasElement;
        const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
        const ratio = canvas.width / canvas.getBoundingClientRect().width;
        const errors: number[] = [];
        const renders: string[] = [];
        cells.forEach(({ rect, glass }, c) => {
          const at = w.drawpane.s.camera.toScreen({ x: rect.x, y: rect.y });
          const ours = ctx.getImageData(
            Math.round(at.x * ratio),
            Math.round(at.y * ratio),
            rect.width * scale,
            rect.height * scale,
          ).data;
          const theirs = w.glassTargets[c] as Uint8ClampedArray;
          // Mean absolute difference (0–255) over the glass and a rim around it.
          const pad = 8;
          const x0 = Math.max(0, (glass.x - pad) * scale);
          const y0 = Math.max(0, (glass.y - pad) * scale);
          const x1 = Math.min(width, (glass.x + glass.width + pad) * scale);
          const y1 = Math.min(rect.height * scale, (glass.y + glass.height + pad) * scale);
          let sum = 0;
          let n = 0;
          for (let y = y0; y < y1; y++)
            for (let x = x0; x < x1; x++) {
              const i = (y * width + x) * 4;
              sum +=
                Math.abs((ours[i] ?? 0) - (theirs[i] ?? 0)) +
                Math.abs((ours[i + 1] ?? 0) - (theirs[i + 1] ?? 0)) +
                Math.abs((ours[i + 2] ?? 0) - (theirs[i + 2] ?? 0));
              n += 3;
            }
          errors.push(n ? sum / n : 0);
          if (keep) {
            let s = "";
            for (let i = 0; i < ours.length; i += 0x8000)
              s += String.fromCharCode(...ours.subarray(i, i + 0x8000));
            renders.push(btoa(s));
          }
        });
        return { errors, renders };
      },
      { tuning, cells, scale: SCALE, width, keep },
    );
    const total = result.errors.reduce((a, b) => a + b, 0) / result.errors.length;
    return { total, errors: result.errors, renders: result.renders.map(bytes) };
  };

  // Coordinate descent: each constant up or down a step, kept when it helps;
  // a step that helps neither way halves. Ends when every step is small.
  let best = { ...defaults };
  let bestScore = await score(best);
  const start = bestScore.total;
  const steps = Object.fromEntries(Object.entries(SEARCH).map(([k, s]) => [k, s.step]));
  const rounds = Number(process.env.ROUNDS ?? 6);
  for (let round = 0; round < rounds; round++) {
    let improved = false;
    for (const [key, range] of Object.entries(SEARCH)) {
      const step = steps[key] as number;
      for (const dir of [1, -1]) {
        const value = Math.min(range.max, Math.max(range.min, (best[key] as number) + dir * step));
        if (value === best[key]) continue;
        const trial = { ...best, [key]: value };
        const s = await score(trial);
        if (s.total < bestScore.total - 1e-4) {
          best = trial;
          bestScore = s;
          improved = true;
          break;
        }
      }
    }
    for (const key of Object.keys(steps))
      steps[key] = (steps[key] as number) * (improved ? 0.75 : 0.5);
    console.log(
      `round ${round + 1}: error ${bestScore.total.toFixed(3)} (from ${start.toFixed(3)})`,
    );
  }
  // The light's turning direction, tried once: Figma's angles may turn the other way.
  const flipped = { ...best, angleTurn: -(best.angleTurn as number) };
  const f = await score(flipped);
  if (f.total < bestScore.total) {
    best = flipped;
    bestScore = f;
  }

  bestScore = await score(best, true);
  writeFileSync(join(out, "tuning.json"), `${JSON.stringify(best, null, 2)}\n`);
  const rows: string[] = [];
  for (const [i, cell] of cells.entries()) {
    const ours = await encodePng(
      page,
      Buffer.from(bestScore.renders[i] as Uint8Array).toString("base64"),
      width,
      height,
    );
    const theirs = await encodePng(
      page,
      Buffer.from(targets[i] as Uint8Array).toString("base64"),
      width,
      height,
    );
    rows.push(
      `<tr><th>${cell.id}<br><small>${(bestScore.errors[i] as number).toFixed(2)}</small></th><td><img src="${theirs}"></td><td><img src="${ours}"></td></tr>`,
    );
  }
  writeFileSync(
    join(out, "compare.html"),
    `<!doctype html><meta charset="utf-8"><title>Glass calibration</title><style>body{font:14px system-ui;margin:24px}img{width:360px;display:block}td,th{padding:6px;vertical-align:top;text-align:left}</style><h1>Glass calibration</h1><p>Mean difference ${start.toFixed(2)} → ${bestScore.total.toFixed(2)} (0–255, over the glass and its rim).</p><table><tr><th></th><th>${known ? "Target (known tuning)" : "Figma"}</th><th>Drawpane, fitted</th></tr>${rows.join("")}</table>`,
  );
  console.log("fitted", JSON.stringify(best));
  if (known) {
    console.log("known ", JSON.stringify(known));
    // The fitter should get most of the way to a tuning it knows exists.
    expect(bestScore.total).toBeLessThan(start * 0.35);
  }
  await instance.stop();
});
