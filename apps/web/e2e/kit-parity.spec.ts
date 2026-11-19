/**
 * Kit parity (tools/kit-parity): a real Figma file, as Figma draws and lays
 * it out, against the same file imported into Drawpane. Opt-in: it runs only
 * with E2E_KIT_PARITY set to the harness's output folder, normally through
 * `node tools/kit-parity/kit-parity.mjs`, never in CI.
 *
 * - Stage "render" (E2E_KIT_PARITY_STAGE=render): the converted file
 *   (E2E_KIT_PARITY_CACHE, made by the harness's convert step as the
 *   dashboard converts) is imported into this run's instance the way the
 *   dashboard saves an import (images uploaded, nodes sent in parts), opened
 *   in the editor, and each sampled frame's fonts are loaded and checked, its
 *   layout read and its picture drawn at the comparison's scale over the
 *   page rect Figma exported. Missing fonts fail the stage: they'd swamp
 *   every other difference. With E2E_KIT_PARITY_ALLOW_MISSING_FONTS=1 they
 *   are only listed (run.json, the scoreboard and the log), for a file whose
 *   fonts can't be had yet: its frames still score, the text in a fallback.
 * - Stage "compare": each frame's pixels against Figma's (mean and p99 as
 *   e2e/parity/pixels.ts measures them, both over white) and its layout,
 *   matched by Figma id; then scoreboard.json and report.html in the run's
 *   folder. With E2E_KIT_PARITY_AGAINST (another run's scoreboard.json) it
 *   lists what got better and worse (against.json, and in the report); with
 *   E2E_KIT_PARITY_SAME=1 as well, the scores must be the same.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { drawpaneId } from "@drawpane/figma";
import { type Browser, expect, type Page, test } from "@playwright/test";
import {
  type DrawpaneNode,
  diffLayout,
  type FigmaNode,
} from "../../../tools/kit-parity/src/layout-diff";
import { type FrameScore, reportHtml, summarize } from "../../../tools/kit-parity/src/report";
import { addPasskey } from "./fresh-instance";
import { importConverted } from "./import-converted";

const OUT = process.env.E2E_KIT_PARITY;
const STAGE = process.env.E2E_KIT_PARITY_STAGE ?? "render";
/** Missing fonts listed, not failed: the run still scores, its text drawn in a fallback face. */
const ALLOW_MISSING_FONTS = process.env.E2E_KIT_PARITY_ALLOW_MISSING_FONTS === "1";
const fileSafe = (id: string) => id.replace(/:/g, "-").replace(/;/g, "_");

interface SampleFrame {
  readonly id: string;
  readonly name: string;
  readonly pageId: string;
  readonly pageName: string;
  readonly kind: string;
  readonly width: number;
  readonly height: number;
}
interface Sample {
  readonly createdWith: { readonly scale: number };
  readonly frames: readonly SampleFrame[];
}
interface FigmaTree {
  readonly id: string;
  readonly box: { x: number; y: number; width: number; height: number };
  readonly png: { width: number; height: number };
  readonly scale: number;
  readonly missingFonts: number;
  readonly matchesSample?: boolean;
  readonly nodes: readonly FigmaNode[];
}
interface DrawpaneFrame {
  readonly id: string;
  readonly drawpaneId: string;
  readonly faces: readonly string[];
  readonly missingFonts: readonly string[];
  readonly renderMs: number;
  readonly nodes: readonly DrawpaneNode[];
}

type W = {
  drawpane?: { s: { status: string } };
  drawpaneParity?: {
    has(id: string): boolean;
    fonts(id: string): Promise<{ faces: string[]; missing: string[] }>;
    layout(id: string): DrawpaneNode[];
    render(
      id: string,
      rect: { x: number; y: number; width: number; height: number },
      scale: number,
      width: number,
      height: number,
    ): Promise<{ png: string; ms: number }>;
  };
};

const readJson = <T>(file: string): T => JSON.parse(readFileSync(file, "utf8")) as T;
const seconds = (since: number) => Math.round((Date.now() - since) / 1000);

function latestRun(): string {
  const runs = join(OUT as string, "runs");
  const names = existsSync(runs) ? readdirSync(runs).sort() : [];
  const last = names.at(-1);
  if (!last) throw new Error(`No runs in ${runs}: run the render stage first.`);
  return join(runs, last);
}

/** Signs a new owner into this run's fresh instance with a virtual passkey. */
async function signIn(browser: Browser, baseURL: string): Promise<Page> {
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  await addPasskey(context, page);
  await page.goto("/setup");
  await page.getByLabel("Your name").fill("Kit Parity");
  await page.getByLabel("Email").fill("parity@example.com");
  await page.getByLabel("Setup token").fill("e2e-setup-token");
  await page.getByRole("button", { name: "Create account with a passkey" }).click();
  await expect(page.getByRole("heading", { name: "Recent files" })).toBeVisible();
  return page;
}

function git(): { head: string; dirty: boolean } {
  const run = (args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();
  try {
    return { head: run(["rev-parse", "HEAD"]), dirty: run(["status", "--porcelain"]) !== "" };
  } catch {
    return { head: "unknown", dirty: true };
  }
}

/** Pixel scores of two PNGs, in the page: both over white, as pixels.ts scores them. */
async function score(page: Page, figma: string, drawpane: string) {
  return page.evaluate(
    async ({ figma, drawpane }) => {
      const load = async (url: string) => createImageBitmap(await (await fetch(url)).blob());
      const theirs = await load(figma);
      const ours = await load(drawpane);
      const width = theirs.width;
      const height = theirs.height;
      if (ours.width !== width || ours.height !== height)
        return {
          error: `Sizes differ: Figma ${width}×${height}, Drawpane ${ours.width}×${ours.height}`,
        };
      const pixels = (bitmap: ImageBitmap) => {
        const c = new OffscreenCanvas(width, height);
        const ctx = c.getContext("2d") as OffscreenCanvasRenderingContext2D;
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(bitmap, 0, 0);
        return ctx.getImageData(0, 0, width, height).data;
      };
      const a = pixels(ours);
      const b = pixels(theirs);
      const n = width * height;
      const histogram = new Uint32Array(256);
      const heat = new Uint8ClampedArray(n * 4);
      let sum = 0;
      let changed = 0;
      for (let i = 0; i < n; i++) {
        const dr = Math.abs((a[i * 4] ?? 0) - (b[i * 4] ?? 0));
        const dg = Math.abs((a[i * 4 + 1] ?? 0) - (b[i * 4 + 1] ?? 0));
        const db = Math.abs((a[i * 4 + 2] ?? 0) - (b[i * 4 + 2] ?? 0));
        sum += (dr + dg + db) / 3;
        const d = Math.max(dr, dg, db);
        histogram[d] = (histogram[d] ?? 0) + 1;
        if (d > 32) changed++;
        const v = Math.min(255, d * 4);
        heat[i * 4] = v;
        heat[i * 4 + 1] = v;
        heat[i * 4 + 2] = v;
        heat[i * 4 + 3] = 255;
      }
      // pixels.ts sorts the differences and takes the one at floor(n × 0.99).
      const at = Math.floor(n * 0.99);
      let p99 = 0;
      for (let v = 0, seen = 0; v < 256; v++) {
        seen += histogram[v] ?? 0;
        if (seen > at) {
          p99 = v;
          break;
        }
      }
      const c = new OffscreenCanvas(width, height);
      (c.getContext("2d") as OffscreenCanvasRenderingContext2D).putImageData(
        new ImageData(heat, width, height),
        0,
        0,
      );
      const blob = await c.convertToBlob({ type: "image/png" });
      const buf = new Uint8Array(await blob.arrayBuffer());
      let s = "";
      for (let i = 0; i < buf.length; i += 0x8000)
        s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      return {
        mean: Math.round((sum / n) * 100) / 100,
        p99,
        changed: Math.round((changed / n) * 10000) / 10000,
        heat: btoa(s),
      };
    },
    { figma, drawpane },
  );
}

// Only when it runs: otherwise these options would start a browser of their own just to skip.
if (OUT)
  test.use({
    // A 500,000-layer file in one tab.
    launchOptions: {
      args: ["--js-flags=--max-old-space-size=8192"],
      ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
    },
    // No traces or screenshots: they'd hold hundreds of MB of import, and the file's content
    // belongs in the harness's own output folder, not in test-results.
    trace: "off",
    screenshot: "off",
  });

test.describe
  .serial("kit parity", () => {
    test.skip(!OUT, "Opt-in: set E2E_KIT_PARITY (see tools/kit-parity/README.md).");
    test.skip(!!process.env.E2E_BASE_URL, "Needs its own local instance.");

    test("render: Drawpane draws and lays out each sampled frame", async ({ browser }) => {
      test.skip(STAGE !== "render", "Stage render only.");
      test.setTimeout(6 * 60 * 60_000);
      const cache = process.env.E2E_KIT_PARITY_CACHE;
      if (!cache) throw new Error("Set E2E_KIT_PARITY_CACHE to the converted file's folder.");
      const out = OUT as string;
      const sample = readJson<Sample>(join(out, "sample.json"));
      const scale = sample.createdWith.scale;
      const runDir =
        process.env.E2E_KIT_PARITY_RUN ??
        join(out, "runs", new Date().toISOString().replace(/[:.]/g, "-"));
      mkdirSync(join(runDir, "drawpane"), { recursive: true });
      const started = Date.now();
      const port = process.env.E2E_PORT ?? "8788";

      const page = await signIn(browser, `http://localhost:${port}`);
      page.on("pageerror", (error) => console.log(`page error: ${error.message}`));
      await page.evaluate(() => localStorage.setItem("drawpane:debug", "1"));
      const fileId = await importConverted(page, cache);
      const importSeconds = seconds(started);

      const frames = sample.frames.filter((f) =>
        existsSync(join(out, "figma", `${fileSafe(f.id)}.json`)),
      );
      const withoutFigma = sample.frames.length - frames.length;
      const first = frames[0];
      if (!first) throw new Error("No sampled frame has Figma's truth yet: run the figma step.");

      const opening = Date.now();
      await page.goto(`/f/${fileId}`);
      await page.waitForFunction(
        (id) => {
          const w = window as unknown as W;
          return w.drawpane?.s.status === "live" && w.drawpaneParity?.has(id) === true;
        },
        drawpaneId(first.id),
        { timeout: 30 * 60_000, polling: 1000 },
      );
      const openSeconds = seconds(opening);
      console.log(`Imported in ${importSeconds} s, opened in ${openSeconds} s.`);

      const missingFonts = new Map<string, string[]>();
      const notInDrawpane: string[] = [];
      let n = 0;
      for (const frame of frames) {
        const id = drawpaneId(frame.id);
        const truth = readJson<FigmaTree>(join(out, "figma", `${fileSafe(frame.id)}.json`));
        const result = await page.evaluate(
          async ({ id, rect, scale, width, height }) => {
            const p = (window as unknown as W).drawpaneParity;
            if (!p?.has(id)) return null;
            const fonts = await p.fonts(id);
            const nodes = p.layout(id);
            const render = await p.render(id, rect, scale, width, height);
            return { fonts, nodes, render };
          },
          {
            id,
            rect: {
              x: truth.box.x,
              y: truth.box.y,
              width: truth.png.width / scale,
              height: truth.png.height / scale,
            },
            scale,
            width: truth.png.width,
            height: truth.png.height,
          },
        );
        if (!result) {
          notInDrawpane.push(frame.id);
          continue;
        }
        for (const face of result.fonts.missing)
          missingFonts.set(face, [...(missingFonts.get(face) ?? []), frame.id]);
        const record: DrawpaneFrame = {
          id: frame.id,
          drawpaneId: id,
          faces: result.fonts.faces,
          missingFonts: result.fonts.missing,
          renderMs: result.render.ms,
          nodes: result.nodes,
        };
        writeFileSync(
          join(runDir, "drawpane", `${fileSafe(frame.id)}.png`),
          Buffer.from(result.render.png, "base64"),
        );
        writeFileSync(
          join(runDir, "drawpane", `${fileSafe(frame.id)}.json`),
          JSON.stringify(record),
        );
        if (++n % 25 === 0) console.log(`  ${n}/${frames.length} frames (${seconds(started)} s)`);
      }
      const run = {
        startedAt: new Date(started).toISOString(),
        git: git(),
        cache: relative(out, cache),
        scale,
        frames: n,
        withoutFigma,
        notInDrawpane,
        missingFonts: Object.fromEntries(missingFonts),
        seconds: { import: importSeconds, open: openSeconds, total: seconds(started) },
      };
      writeFileSync(join(runDir, "run.json"), `${JSON.stringify(run, null, 2)}\n`);
      console.log(
        `Drew ${n} frames in ${seconds(started)} s into ${runDir}; ${withoutFigma} sampled frames have no Figma truth yet, ${notInDrawpane.length} aren't in Drawpane.`,
      );
      await page.context().close();
      if (ALLOW_MISSING_FONTS && missingFonts.size > 0)
        console.log(
          `Missing in Drawpane, allowed: ${[...missingFonts].map(([face, ids]) => `${face} (${ids.length} frames)`).join(", ")}.`,
        );
      else
        expect(
          [...missingFonts.keys()],
          "Fonts missing in Drawpane would swamp every other difference: make them available first.",
        ).toEqual([]);
    });

    test("compare: scores, scoreboard.json and report.html", async ({ browser }) => {
      test.skip(STAGE !== "compare", "Stage compare only.");
      test.setTimeout(3 * 60 * 60_000);
      const out = OUT as string;
      const runDir = process.env.E2E_KIT_PARITY_RUN ?? latestRun();
      const sample = readJson<Sample>(join(out, "sample.json"));
      const run = readJson<{ missingFonts: Record<string, string[]> } & Record<string, unknown>>(
        join(runDir, "run.json"),
      );
      mkdirSync(join(runDir, "heat"), { recursive: true });
      const started = Date.now();

      // A page of its own origin, so it can fetch both sides' files.
      const context = await browser.newContext();
      const page = await context.newPage();
      const origin = "https://kit-parity.invalid";
      await page.route(`${origin}/**`, async (route) => {
        const path = decodeURIComponent(new URL(route.request().url()).pathname);
        if (path === "/")
          return route.fulfill({ contentType: "text/html", body: "<!doctype html>" });
        const [side, name] = path.slice(1).split("/") as [string, string];
        const file = side === "figma" ? join(out, "figma", name) : join(runDir, "drawpane", name);
        return route.fulfill({ contentType: "image/png", body: readFileSync(file) });
      });
      await page.goto(`${origin}/`);

      const frames: FrameScore[] = [];
      const problems: string[] = [];
      let idsChecked = 0;
      let idsMismatched = 0;
      for (const frame of sample.frames) {
        const safe = fileSafe(frame.id);
        const figmaJson = join(out, "figma", `${safe}.json`);
        const oursJson = join(runDir, "drawpane", `${safe}.json`);
        if (!existsSync(figmaJson) || !existsSync(oursJson)) continue;
        const truth = readJson<FigmaTree>(figmaJson);
        const ours = readJson<DrawpaneFrame>(oursJson);
        idsChecked++;
        if (truth.matchesSample === false) idsMismatched++;
        const pixels = await score(
          page,
          `${origin}/figma/${safe}.png`,
          `${origin}/drawpane/${safe}.png`,
        );
        if ("error" in pixels) {
          problems.push(`${frame.id}: ${pixels.error}`);
          continue;
        }
        writeFileSync(join(runDir, "heat", `${safe}.png`), Buffer.from(pixels.heat, "base64"));
        frames.push({
          id: frame.id,
          name: frame.name,
          pageName: frame.pageName,
          kind: frame.kind,
          width: frame.width,
          height: frame.height,
          mean: pixels.mean,
          p99: pixels.p99,
          changed: pixels.changed,
          figmaMissingFonts: truth.missingFonts,
          drawpaneMissingFonts: ours.missingFonts,
          layout: diffLayout(truth.nodes, ours.nodes),
          images: {
            figma: relative(runDir, join(out, "figma", `${safe}.png`)),
            drawpane: `drawpane/${safe}.png`,
            heat: `heat/${safe}.png`,
          },
        });
      }
      const summary = summarize(frames);
      const meta = {
        run: relative(out, runDir),
        render: run,
        idsChecked,
        idsMismatched,
        problems,
        compareSeconds: seconds(started),
      };
      writeFileSync(
        join(runDir, "scoreboard.json"),
        `${JSON.stringify({ meta, summary, frames }, null, 1)}\n`,
      );
      // Against another run: what got better and worse, frame by frame.
      const against = process.env.E2E_KIT_PARITY_AGAINST;
      let was: Map<string, FrameScore> | null = null;
      let changed: string[] = [];
      if (against) {
        const before = readJson<{ frames: FrameScore[] }>(against);
        was = new Map(before.frames.map((f) => [f.id, f]));
        const prior = was;
        // Frames both runs scored; any one only scored is listed, not counted as changed.
        const both = frames.filter((f) => prior.has(f.id));
        const onlyOne = frames.length - both.length + (before.frames.length - both.length);
        const delta = (f: FrameScore) => ({
          id: f.id,
          name: f.name,
          was: (prior.get(f.id) as FrameScore).mean,
          now: f.mean,
        });
        const better = both
          .filter((f) => f.mean < (prior.get(f.id) as FrameScore).mean - 0.01)
          .map(delta)
          .sort((a, b) => a.now - a.was - (b.now - b.was));
        const worse = both
          .filter((f) => f.mean > (prior.get(f.id) as FrameScore).mean + 0.01)
          .map(delta)
          .sort((a, b) => b.now - b.was - (a.now - a.was));
        changed = both
          .filter((f) => {
            const b = prior.get(f.id) as FrameScore;
            return (
              b.mean !== f.mean ||
              b.p99 !== f.p99 ||
              JSON.stringify(b.layout) !== JSON.stringify(f.layout)
            );
          })
          .map((f) => `${f.id}: ${prior.get(f.id)?.mean} → ${f.mean}`);
        const beforeSummary = summarize(
          before.frames.filter((f) => frames.some((g) => g.id === f.id)),
        );
        const afterSummary = summarize(both);
        const sum = (list: readonly FrameScore[]) =>
          Math.round(list.reduce((a, f) => a + f.mean, 0) * 100) / 100;
        writeFileSync(
          join(runDir, "against.json"),
          `${JSON.stringify(
            {
              against,
              compared: both.length,
              onlyOne,
              before: {
                median: beforeSummary.median,
                p90: beforeSummary.p90,
                sum: sum(both.map((f) => prior.get(f.id) as FrameScore)),
                over: beforeSummary.over,
              },
              after: {
                median: afterSummary.median,
                p90: afterSummary.p90,
                sum: sum(both),
                over: afterSummary.over,
              },
              better,
              worse,
              changed: changed.length,
            },
            null,
            2,
          )}\n`,
        );
        console.log(
          `Against ${against}: ${both.length} frames compared; median ${beforeSummary.median} → ${afterSummary.median}, p90 ${beforeSummary.p90} → ${afterSummary.p90}, total ${sum(both.map((f) => prior.get(f.id) as FrameScore))} → ${sum(both)}; ${better.length} better, ${worse.length} worse, ${changed.length} changed, ${onlyOne} scored by one run only.`,
        );
        for (const w of worse.slice(0, 10)) console.log(`  worse: ${w.id} ${w.was} → ${w.now}`);
      }
      writeFileSync(
        join(runDir, "report.html"),
        reportHtml(
          "Kit parity",
          meta,
          summary,
          frames,
          was ? new Map([...was].map(([id, f]) => [id, f.mean])) : undefined,
        ),
      );
      console.log(
        `Scored ${frames.length} frames in ${seconds(started)} s: median ${summary.median}, p90 ${summary.p90}, over ${JSON.stringify(summary.over)}. Report: ${join(runDir, "report.html")}`,
      );
      await context.close();
      if (process.env.E2E_KIT_PARITY_SAME === "1")
        expect(changed, `Scores differ from ${against}`).toEqual([]);
      expect(idsMismatched, "Sampled ids that name another node in Figma").toBe(0);
      if (!ALLOW_MISSING_FONTS)
        expect(
          Object.keys(run.missingFonts),
          "Fonts missing in Drawpane would swamp every other difference.",
        ).toEqual([]);
    });
  });
