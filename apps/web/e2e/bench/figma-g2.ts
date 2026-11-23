import type { Page } from "@playwright/test";
import { type Summary, zoomSteps } from "./frames";
import { type Crop, decodePng, diffPercent, type Image } from "./png";

/** The iOS kit's "Examples/Control Center" board: Figma's node 12740:35188. */
export const CONTROL_CENTER = "f12740-35188";

/** Figma's G2 zoom: 14 wheel notches from 15% to 254% (research run 2, `bench_figma_run2.js`). */
const FROM = 0.15;
const TO = 2.54;
const STEPS = 14;
/** Four frames a step, 0.87 s in all: Figma's 14 notches took 963 ms. */
const HOLD = 3;
/** Where the zoom centres, as fractions of the canvas: Figma's `ccMid`. */
const AT = { x: 0.5, y: 0.45 };
/**
 * Figma's canvas was 900 CSS px high, and Shift+0 zoomed it to 100% about the board's centre:
 * the page point under `AT` sat this far (page units) above the board's centre for the whole
 * gesture, since every notch zooms about that point.
 */
const ABOVE_CENTRE = 0.05 * 900;
/** Figma's canvas: the 1440x900 window less its panels. */
const CANVAS = { width: 901, height: 900 };
/**
 * Where the research measured differences, in Figma's canvas px: 20 to 80% across and 8 to 90%
 * down its 1440x900 window, whose canvas started 298 px from the left.
 */
const CROP = { x0: 0, y0: 72, x1: 854, y1: 810 };

export interface G2 {
  summary: Summary;
  /** The canvas (CSS px) and the screencast's frame size (its px). */
  canvas: { x: number; y: number; width: number; height: number };
  frame: { width: number; height: number };
  /** Screencast frames after the last step. */
  frames: number;
  /**
   * Ms after the last step until the screencast first came within 0.5% and 0.1% of the settled
   * frame and matched it, as the Figma research measured, and until it stayed so.
   */
  first: { within05: number | null; within01: number | null; identical: number | null };
  stayed: { within05: number | null; within01: number | null; identical: number | null };
  /** "ms:diff%" for each frame from 100 ms before the last step on. */
  timeline: string;
  /** The settled frame, a PNG, to check the framing against Figma's. */
  settled: Buffer;
  /** The view at 15% before the zoom, a PNG. */
  start: Buffer;
  /**
   * The board's bounds and, before and after: the camera, the GPU backend, and the engine's last
   * frame (how it was made, whether exact, tiles pending and queued, any limit).
   */
  facts: string;
  /** Console warnings and errors while it ran, and the engine's fallback notes. */
  console: string[];
}

/**
 * Runs Figma's G2 on our canvas, the same board, canvas size and camera path: in a 901x900
 * window with the UI minimized, from 15%, 14 zoom steps about (50%, 45%) of the canvas to 254%.
 * It times the drawn-exact stamp (the bench's own measure) and, from a CDP screencast as the
 * research did, the time until frames are within 0.5% and 0.1% of the settled frame (pixels
 * whose largest RGB difference is over 3, over the research's crop). Null without the board.
 */
export async function figmaG2(
  page: Page,
  settle: (page: Page) => Promise<void>,
  postStopMs = 2400,
): Promise<G2 | null> {
  const size = page.viewportSize();
  await page.setViewportSize(CANVAS);
  // Minimize UI (the bench runs Chromium on Linux: Control is the modifier).
  await page.keyboard.press("Control+Shift+Backslash");
  try {
    return await run(page, settle, postStopMs);
  } finally {
    await page.keyboard.press("Control+Shift+Backslash");
    if (size) await page.setViewportSize(size);
  }
}

async function run(
  page: Page,
  settle: (page: Page) => Promise<void>,
  postStopMs: number,
): Promise<G2 | null> {
  await page.waitForTimeout(300);
  const messages: string[] = [];
  const listen = (m: { type(): string; text(): string }) => {
    const fallback = m.type() === "info" && m.text().startsWith("Drawpane:");
    if (fallback || m.type() === "warning" || m.type() === "error")
      messages.push(`${m.type()}: ${m.text()}`);
  };
  page.on("console", listen);
  try {
    return await measure(page, settle, postStopMs, messages);
  } finally {
    page.off("console", listen);
  }
}

/**
 * The camera, the GPU backend the engine draws with (or that it doesn't), and its last frame:
 * how it was made, whether it was exact, the tiles still pending and queued, and any limit.
 */
function facts(page: Page): Promise<string> {
  return page.evaluate(() => {
    const w = window as unknown as {
      drawpane: { s: { camera: { x: number; y: number; zoom: number } } };
      drawpaneEngineView?: {
        engine: { gpu: { backend: string } | null } | null;
        limitReason: string | null;
        last: { plan: string; exact: boolean; tiles: { pending: number; queued: number } };
      };
    };
    const c = w.drawpane.s.camera;
    const v = w.drawpaneEngineView;
    const gpu = v?.engine?.gpu?.backend ?? "no GPU engine";
    const last = v
      ? `, last frame ${v.last.plan}${v.last.exact ? " exact" : ""}, ${v.last.tiles.pending} pending, ` +
        `${v.last.tiles.queued} queued${v.limitReason ? `, limit: ${v.limitReason}` : ""}`
      : "";
    return `camera ${c.x.toFixed(1)},${c.y.toFixed(1)} at ${(c.zoom * 100).toFixed(1)}%, ${gpu}${last}`;
  });
}

async function measure(
  page: Page,
  settle: (page: Page) => Promise<void>,
  postStopMs: number,
  messages: string[],
): Promise<G2 | null> {
  const bounds = await page.evaluate(
    (id) =>
      (
        window as unknown as {
          drawpane: { scene: { bounds(id: string): unknown } };
        }
      ).drawpane.scene.bounds(id),
    CONTROL_CENTER,
  );
  const canvas = await page.evaluate(
    ({ id, from, at, above }) => {
      type Rect = { x: number; y: number; width: number; height: number };
      const e = (
        window as unknown as {
          drawpane: {
            scene: { bounds(id: string): Rect | null };
            s: { viewport: { width: number; height: number } };
            zoomTo(z: number): void;
            centerOn(p: { x: number; y: number }): void;
          };
        }
      ).drawpane;
      const b = e.scene.bounds(id);
      if (!b) return null;
      const { width, height } = e.s.viewport;
      const p = { x: b.x + b.width / 2, y: b.y + b.height / 2 - above };
      e.zoomTo(from);
      // The view's centre such that `p` sits at `at`.
      e.centerOn({
        x: p.x + ((0.5 - at.x) * width) / from,
        y: p.y + ((0.5 - at.y) * height) / from,
      });
      const r = (document.querySelector("canvas") as HTMLCanvasElement).getBoundingClientRect();
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    },
    { id: CONTROL_CENTER, from: FROM, at: AT, above: ABOVE_CENTRE },
  );
  if (!canvas) return null;
  await settle(page);
  const before = await facts(page);
  const start = await page.screenshot();

  const cdp = await page.context().newCDPSession(page);
  const shots: Array<{ wall: number; png: Buffer }> = [];
  cdp.on("Page.screencastFrame", (event) => {
    shots.push({ wall: Date.now(), png: Buffer.from(event.data, "base64") });
    void cdp.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => {});
  });
  await cdp.send("Page.startScreencast", {
    format: "png",
    everyNthFrame: 1,
    maxWidth: 2880,
    maxHeight: 1800,
  });
  await page.waitForTimeout(250);
  const summary = await zoomSteps(page, STEPS, (TO / FROM) ** (1 / STEPS), HOLD, {
    at: AT,
    from: "keep",
  });
  const end = summary.moveEndWall ?? Date.now();
  const exact = summary.engine?.exactMs ?? summary.exactMs ?? 0;
  await page.waitForTimeout(Math.max(0, end + Math.max(postStopMs, exact + 500) - Date.now()));
  await cdp.send("Page.stopScreencast").catch(() => {});
  await cdp.detach().catch(() => {});

  const last = shots.at(-1);
  if (!last) throw new Error("the screencast sent no frames");
  const settled = decodePng(last.png);
  const css = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const sx = settled.width / css.width;
  const sy = settled.height / css.height;
  const crop: Crop = {
    x0: Math.round((canvas.x + CROP.x0) * sx),
    y0: Math.round((canvas.y + CROP.y0) * sy),
    x1: Math.round(Math.min(canvas.x + CROP.x1, canvas.x + canvas.width) * sx),
    y1: Math.round(Math.min(canvas.y + CROP.y1, canvas.y + canvas.height) * sy),
  };
  const rows: Array<{ ms: number; diff: number }> = [];
  for (const shot of shots) {
    const ms = shot.wall - end;
    if (ms < -100) continue;
    const image: Image = decodePng(shot.png);
    rows.push({ ms, diff: diffPercent(image, settled, crop) });
  }
  const after = rows.filter((r) => r.ms > 0);
  const first = (limit: number) => after.find((r) => r.diff <= limit)?.ms ?? null;
  const stayed = (limit: number) => {
    let at: number | null = null;
    for (const r of after) at = r.diff <= limit ? (at ?? r.ms) : null;
    return at;
  };
  return {
    summary,
    canvas,
    frame: { width: settled.width, height: settled.height },
    frames: after.length,
    first: { within05: first(0.5), within01: first(0.1), identical: first(0) },
    stayed: { within05: stayed(0.5), within01: stayed(0.1), identical: stayed(0) },
    timeline: rows.map((r) => `${r.ms}:${r.diff.toFixed(3)}`).join(" "),
    settled: last.png,
    start,
    facts: `board ${JSON.stringify(bounds)}; before: ${before}; after: ${await facts(page)}`,
    console: messages,
  };
}
