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
import { join, relative, resolve } from "node:path";
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
import {
  type Backend,
  type Debug,
  installScoring,
  pageCensus,
  pngTransfer,
  renderFrame,
} from "./kit-engine";

/**
 * On the GPU bench (tools/gpu-bench `--file`), the uploaded folder is the out dir and the
 * converted file at once: E2E_KIT_PARITY_FROM_BENCH=1 reads both from BENCH_FILE.
 */
const FROM_BENCH = process.env.E2E_KIT_PARITY_FROM_BENCH === "1";
const OUT = process.env.E2E_KIT_PARITY ?? (FROM_BENCH ? process.env.BENCH_FILE : undefined);
const STAGE = process.env.E2E_KIT_PARITY_STAGE ?? "render";
/** Missing fonts listed, not failed: the run still scores, its text drawn in a fallback face. */
const ALLOW_MISSING_FONTS = process.env.E2E_KIT_PARITY_ALLOW_MISSING_FONTS === "1";
const fileSafe = (id: string) => id.replace(/:/g, "-").replace(/;/g, "_");
/** Draw the same export crop with these engine backends, then score it alongside the canvas. */
const ENGINE_BACKENDS = [
  ...new Set((process.env.E2E_KIT_PARITY_ENGINE ?? "").split(",").filter(Boolean)),
];
const INLINE = process.env.E2E_KIT_PARITY_INLINE === "1";

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

const readJson = <T>(file: string): T => JSON.parse(readFileSync(file, "utf8")) as T;
const seconds = (since: number) => Math.round((Date.now() - since) / 1000);

async function beforeDeadline<T>(work: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded 3 minutes`)), 180_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function latestRun(): string {
  const runs = join(OUT as string, "runs");
  const names = existsSync(runs) ? readdirSync(runs).sort() : [];
  const last = names.at(-1);
  if (!last) throw new Error(`No runs in ${runs}: run the render stage first.`);
  return join(runs, last);
}

/** Signs a new owner into this run's fresh instance with a virtual passkey. */
async function signIn(browser: Browser, baseURL: string): Promise<Page> {
  const context = await browser.newContext({ baseURL, bypassCSP: true });
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
      args: [
        "--js-flags=--max-old-space-size=8192",
        // WebGPU (SwiftShader here) for the engine's GPU backend, as the engine parity spec has it.
        ...(ENGINE_BACKENDS.length > 0
          ? ["--enable-unsafe-webgpu", "--enable-unsafe-swiftshader"]
          : []),
      ],
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
      const cache = process.env.E2E_KIT_PARITY_CACHE ?? (FROM_BENCH ? OUT : undefined);
      if (!cache || !OUT)
        throw new Error("Set E2E_KIT_PARITY_CACHE to the converted file's folder.");
      if (FROM_BENCH && !process.env.E2E_KIT_PARITY_RUN)
        throw new Error("Set E2E_KIT_PARITY_RUN to a writable folder outside BENCH_FILE.");
      const isBackend = (s: string): s is Backend => s === "cpu" || s === "gpu" || s === "webgl";
      const backends = ENGINE_BACKENDS.filter(isBackend);
      if (backends.length !== ENGINE_BACKENDS.length)
        throw new Error("Use cpu, gpu or webgl as backends.");
      // CPU is drawn first so it can be compared to each selected GPU backend.
      backends.sort((a, b) => Number(b === "cpu") - Number(a === "cpu"));

      const out = OUT;
      const sample = readJson<Sample>(join(out, "sample.json"));
      const scale = sample.createdWith.scale;
      const runDir = resolve(
        process.env.E2E_KIT_PARITY_RUN ??
          join(out, "runs", new Date().toISOString().replace(/[:.]/g, "-")),
      );
      const engineDirs = Object.fromEntries(
        backends.map((backend) => [backend, `${runDir}-engine-${backend}`]),
      );
      const scores = join(runDir, "scores.ndjson");
      mkdirSync(join(runDir, "drawpane"), { recursive: true });
      if (INLINE) writeFileSync(scores, "");
      for (const dir of Object.values(engineDirs)) {
        mkdirSync(join(dir, "drawpane"), { recursive: true });
        writeFileSync(join(dir, "facts.ndjson"), "");
      }

      // Shard the stable sample, including missing references, so each frame is accounted for.
      const [shardK, shardN] = (process.env.E2E_KIT_PARITY_SHARD ?? "1/1").split("/").map(Number);
      if (
        !shardK ||
        !shardN ||
        !Number.isInteger(shardK) ||
        !Number.isInteger(shardN) ||
        shardK < 1 ||
        shardK > shardN
      )
        throw new Error("E2E_KIT_PARITY_SHARD must be k/n, with 1 ≤ k ≤ n.");
      const onlyPages = process.env.E2E_KIT_PARITY_PAGES?.split(",").map((name) => name.trim());
      const frames = sample.frames.filter(
        (f, index) =>
          index % shardN === shardK - 1 && (!onlyPages || onlyPages.includes(f.pageName)),
      );
      if (frames.length === 0) throw new Error("No sampled frames selected.");

      const started = Date.now();
      const origin = `http://localhost:${process.env.E2E_PORT ?? "8788"}`;
      const dashboard = await signIn(browser, origin);
      const context = dashboard.context();
      const transfer = await pngTransfer(origin);
      const errors: Array<{ id: string; error: string }> = [];
      const missingFonts = new Map<string, string[]>();
      const missingReference: string[] = [];
      const mismatchedReference: string[] = [];
      const notInDrawpane: string[] = [];
      const counts = Object.fromEntries(
        backends.map((backend) => [
          backend,
          {
            drawn: 0,
            refused: 0,
            missingImages: 0,
            worse: 0,
            comparedToCpu: 0,
            outsideCpuTolerance: 0,
            worseBy: { mean: 0, worstTile: 0, alpha: 0 },
            canvasMeans: [] as number[],
            engineMeans: [] as number[],
          },
        ]),
      );
      let n = 0;
      let census: Awaited<ReturnType<typeof pageCensus>> = [];
      let censusAttempted = false;
      let censusError: string | undefined;
      let openSeconds: number | undefined;
      try {
        await context.addInitScript(() => {
          localStorage.setItem("drawpane:debug", "1");
          localStorage.setItem("drawpane:engine-software", "allow");
        });
        if (INLINE) await installScoring(context);
        const fileId = await importConverted(dashboard, cache);
        const importSeconds = seconds(started);
        const openEditor = async () => {
          const opening = Date.now();
          const tab = await context.newPage();
          try {
            await tab.goto(`/f/${fileId}`, { timeout: 180_000 });
            await tab.waitForFunction(
              () =>
                (window as unknown as Debug).drawpane?.s.status === "live" &&
                !!(window as unknown as Debug).drawpaneParity,
              undefined,
              { timeout: 180_000, polling: 500 },
            );
          } catch (error) {
            await tab.close().catch(() => undefined);
            throw error;
          }
          openSeconds ??= seconds(opening);
          return tab;
        };
        // Keep the authenticated context. A crashed tab is replaced before the next frame.
        let page: Page | undefined;
        for (const frame of frames) {
          const safe = fileSafe(frame.id);
          const figmaPng = join(out, "figma", `${safe}.png`);
          const figmaJson = join(out, "figma", `${safe}.json`);
          const appendScore = (value: Record<string, unknown>) => {
            if (INLINE)
              writeFileSync(
                scores,
                `${JSON.stringify({ id: frame.id, ...value })}
`,
                { flag: "a" },
              );
          };
          if (!existsSync(figmaPng) || !existsSync(figmaJson)) {
            missingReference.push(frame.id);
            appendScore({ error: "missing Figma reference" });
            continue;
          }
          const id = drawpaneId(frame.id);
          try {
            const truth = readJson<FigmaTree>(figmaJson);
            if (INLINE && (truth.id !== frame.id || truth.matchesSample === false)) {
              mismatchedReference.push(frame.id);
              appendScore({ error: "Figma reference does not match sample" });
              continue;
            }
            page ??= await openEditor();
            if (!censusAttempted && backends.length > 0 && shardK === 1) {
              censusAttempted = true;
              try {
                census = await beforeDeadline(pageCensus(page), "engine page census");
                writeFileSync(
                  join(runDir, "pages.json"),
                  `${JSON.stringify(census, null, 2)}
`,
                );
              } catch (error) {
                censusError = String(error);
                await page.close({ reason: "kit page census failed" }).catch(() => undefined);
                page = undefined;
                page = await openEditor();
              }
            }
            const { width, height } = truth.png;
            const outputs = Object.fromEntries([
              ["canvas", join(runDir, "drawpane", `${safe}.png`)],
              ...backends.map((backend) => [
                backend,
                join(engineDirs[backend] as string, "drawpane", `${safe}.png`),
              ]),
            ]);
            const result = await beforeDeadline(
              renderFrame(page, {
                id,
                backends,
                inline: INLINE,
                url: transfer.frame(figmaPng, outputs),
                rect: {
                  x: truth.box.x,
                  y: truth.box.y,
                  width: width / scale,
                  height: height / scale,
                },
                scale,
                width,
                height,
              }),
              "frame draw",
            );
            if (!result) {
              notInDrawpane.push(frame.id);
              appendScore({ error: "frame missing from imported kit" });
              continue;
            }
            for (const face of result.missing) {
              const ids = missingFonts.get(face) ?? [];
              ids.push(frame.id);
              missingFonts.set(face, ids);
            }
            const frameData: DrawpaneFrame = {
              id: frame.id,
              drawpaneId: id,
              faces: result.faces,
              missingFonts: result.missing,
              renderMs: result.ms,
              nodes: result.nodes,
            };
            if (!INLINE)
              writeFileSync(join(runDir, "drawpane", `${safe}.json`), JSON.stringify(frameData));
            for (const backend of backends) {
              const dir = engineDirs[backend] as string;
              const fact = result.facts[backend];
              const totals = counts[backend];
              if (!fact || !totals) continue;
              writeFileSync(
                join(dir, "facts.ndjson"),
                `${JSON.stringify({ id: frame.id, ...fact })}
`,
                { flag: "a" },
              );
              if (fact.ok && Object.keys(fact.unsupported).length === 0) {
                totals.drawn++;
                if (fact.missingImages?.length) totals.missingImages++;
                if (!INLINE)
                  writeFileSync(
                    join(dir, "drawpane", `${safe}.json`),
                    JSON.stringify({ ...frameData, renderMs: fact.wallMs }),
                  );
              } else {
                totals.refused++;
              }
              const parity = result.metrics?.engines[backend];
              if (parity && result.metrics) {
                totals.canvasMeans.push(result.metrics.canvas.mean);
                totals.engineMeans.push(parity.vsFigma.mean);
                if (parity.worse.length) totals.worse++;
                for (const key of Object.keys(totals.worseBy) as Array<
                  keyof typeof totals.worseBy
                >) {
                  if (parity.worse.includes(key)) totals.worseBy[key]++;
                }
              }
              const agreement = result.metrics?.cpuVsGpu[backend];
              if (agreement) {
                totals.comparedToCpu++;
                if (agreement.failures.length) totals.outsideCpuTolerance++;
              }
            }
            appendScore({ ...result.metrics, canvasMs: result.ms, facts: result.facts });
            if (++n % 25 === 0)
              console.log(`  ${n}/${frames.length} frames (${seconds(started)} s)`);
          } catch (error) {
            const issue = { id: frame.id, error: String(error) };
            errors.push(issue);
            appendScore(issue);
            console.log(`Frame ${frame.id} failed; continuing with a new tab.`);
            await page?.close({ reason: "kit parity frame failed" }).catch(() => undefined);
            page = undefined;
          }
        }
        const run = {
          startedAt: new Date(started).toISOString(),
          git: git(),
          cache: relative(out, cache),
          scale,
          frames: n,
          withoutFigma: missingReference.length,
          missingReference,
          mismatchedReference,
          notInDrawpane,
          errors,
          missingFonts: Object.fromEntries(missingFonts),
          seconds: { import: importSeconds, open: openSeconds, total: seconds(started) },
        };
        writeFileSync(
          join(runDir, "run.json"),
          `${JSON.stringify(run, null, 2)}
`,
        );
        for (const [backend, dir] of Object.entries(engineDirs))
          writeFileSync(
            join(dir, "run.json"),
            `${JSON.stringify({ ...run, renderer: `engine-${backend}` }, null, 2)}
`,
          );

        if (INLINE) {
          const summarizeMeans = (values: number[]) => {
            if (values.length === 0) return null;
            const middle = Math.floor(values.length / 2);
            values.sort((a, b) => a - b);
            const median =
              ((values[middle] as number) + (values[Math.ceil(values.length / 2) - 1] as number)) /
              2;
            return { median, mean: values.reduce((sum, value) => sum + value, 0) / values.length };
          };
          const engines = Object.fromEntries(
            Object.entries(counts).map(([backend, { canvasMeans, engineMeans, ...totals }]) => [
              backend,
              {
                ...totals,
                canvas: summarizeMeans(canvasMeans),
                engine: summarizeMeans(engineMeans),
              },
            ]),
          );
          const blockedPages = census.filter(
            ({ unsupported, waiting }) => waiting || Object.keys(unsupported).length,
          ).length;
          const failed =
            missingReference.length > 0 ||
            mismatchedReference.length > 0 ||
            notInDrawpane.length > 0 ||
            errors.length > 0 ||
            blockedPages > 0 ||
            !!censusError ||
            Object.values(engines).some(
              (totals) =>
                totals.drawn !== frames.length ||
                totals.worse > 0 ||
                totals.missingImages > 0 ||
                totals.outsideCpuTolerance > 0,
            );
          const complete =
            shardN === 1 &&
            !onlyPages &&
            backends.includes("cpu") &&
            (backends.includes("gpu") || backends.includes("webgl"));
          const scoreboard = {
            verdict: failed ? "fail" : complete ? "pass" : "partial",
            sampled: frames.length,
            canvasDrawn: n,
            missingReference: missingReference.length,
            mismatchedReference: mismatchedReference.length,
            notInDrawpane: notInDrawpane.length,
            frameErrors: errors.length,
            engines,
            census: { pages: census.length, blockedPages, error: censusError },
            seconds: run.seconds,
          };
          writeFileSync(
            join(runDir, "engine-scoreboard.json"),
            `${JSON.stringify(scoreboard, null, 2)}
`,
          );
          console.log(JSON.stringify(scoreboard, null, 2));
          if (process.env.E2E_KIT_PARITY_REQUIRE_PASS === "1")
            expect(scoreboard.verdict, "Decision 0040 kit gate").toBe("pass");
        } else {
          expect(errors, "Kit frames that failed to draw").toEqual([]);
        }
        if (ALLOW_MISSING_FONTS && missingFonts.size > 0)
          console.log(
            `Missing in Drawpane, allowed: ${[...missingFonts].map(([face, ids]) => `${face} (${ids.length} frames)`).join(", ")}.`,
          );
        else
          expect(
            [...missingFonts.keys()],
            "Make all missing faces available before scoring.",
          ).toEqual([]);
      } finally {
        transfer.close();
        await context.close();
      }
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
