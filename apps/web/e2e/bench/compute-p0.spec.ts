/**
 * P0 GPU compute benchmark (decision 0040, P0 kill gate).
 *
 * Addresses every methodology flaw identified in the PR #276 and PR #278 reviews:
 * - Hardware GPU timestamp queries (`wgpu::Features::TIMESTAMP_QUERY`) per pass when supported,
 *   recording summed pass GPU time (`gpuMs`), first-to-last pass wall span (`gpuSpanMs`), and
 *   per-pass averages (`apply_view` .. `fine_area` + `present_blit`).
 * - Explicit per-frame CPU (main thread: `encode`, `render`, `submit`, `total`, plus JS wall) vs
 *   GPU (hardware timestamps / post-submit fence) split for BOTH `compute P0` and `main vello_gpu`,
 *   showing directly how much of each frame is CPU encoding vs GPU execution.
 * - Real onscreen WebGPU presentation confirmation on a live 2880x1800 (1440x900 @ 2x DPR) canvas:
 *   verifies `presentedFrames`, `exactFrames` (zero stand-ins), readback non-blank and zoom pixel
 *   change, AND live Playwright element screenshots at two zoom levels so uncomposited drivers
 *   (such as headless Chromium `--disable-vulkan-surface`) are labeled honestly (`render-only-raf`)
 *   rather than falsely counted as onscreen presentations. Set `BENCH_REQUIRE_PRESENT=1` to
 *   hard-fail if onscreen WebGPU presentation is not confirmed.
 * - Enough frames (`BENCH_ZOOM_FRAMES`, default 240) for meaningful p95 and p99 quantiles.
 * - Per-frame bump allocator verification (`bump.failed === 0`) on every single frame of every
 *   sweep (`framesChecked === framesSubmitted` and `failedFrames === 0`).
 * - Cached stroke outline growth measurement (`strokeCacheStats()`) on the generated kit.
 *
 * Env:
 *   BENCH_SCALE=12000            (default: ~10.3k-layer page; pass 12000,50000 to include ~40.4k)
 *   BENCH_NO_EFFECTS=1           (default: 1, ordinary paint only for P0)
 *   BENCH_ZOOM_FRAMES=240        (default: 240 frames per compute sweep)
 *   BENCH_BASELINE_FRAMES=24     (default: 24 frames for main vello_gpu comparison; 0 to skip)
 *   BENCH_INCLUDE_FIT=1          (default: 1, run both 100% zoom and fit-all sweeps)
 *   BENCH_ENGINE_PRESENT=webgpu  (set "readback" to skip onscreen canvas attach)
 *   BENCH_REQUIRE_PRESENT=0      (set "1" to assert confirmed onscreen WebGPU canvas presentation)
 *   BENCH_LAPTOP_GATE=1          (optional: enforce GPU p95 <= 8 ms on the 10k 100% Retina sweep)
 *   BENCH_OUT=<path>             (optional JSON report path)
 *   BENCH_PORT=8843              (unusual free port for local worker)
 */
import { writeFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { generateKit } from "@drawpane/corpus";
import type { ComputeStats, FrameStats, GpuInfo, RenderEngine, Result } from "@drawpane/engine";
import type { NodeRecord } from "@drawpane/model";
import { expect, type Page, test } from "@playwright/test";
import { freshInstance, type Instance } from "../fresh-instance";

const SIZES = (process.env.BENCH_SCALE ?? "12000")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);
const NO_EFFECTS = process.env.BENCH_NO_EFFECTS !== "0";
const ZOOM_FRAMES = Number(process.env.BENCH_ZOOM_FRAMES ?? 240);
const BASELINE_FRAMES = Number(process.env.BENCH_BASELINE_FRAMES ?? 24);
const INCLUDE_FIT = process.env.BENCH_INCLUDE_FIT !== "0";
const FORCE_OFFSCREEN = process.env.BENCH_ENGINE_PRESENT === "readback";
const REQUIRE_PRESENT = process.env.BENCH_REQUIRE_PRESENT === "1";
const ENFORCE_LAPTOP_GATE = process.env.BENCH_LAPTOP_GATE === "1";
const CHUNK = 20_000;
const WIDTH = 2880;
const HEIGHT = 1800;
const BG: [number, number, number, number] = [0.95, 0.95, 0.93, 1.0];

type PresentationMode = "presented-canvas" | "render-only-raf" | "offscreen-raf";

interface Quantiles {
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly min: number;
  readonly max: number;
}

interface CpuSplit {
  readonly encodeMs: Quantiles;
  readonly renderMs: Quantiles;
  readonly submitMs: Quantiles;
  readonly totalMs: Quantiles;
  readonly callMs: Quantiles;
}

interface SweepResult {
  readonly label: string;
  readonly mode: "compute" | "vello_gpu";
  presentationMode: PresentationMode;
  readonly frames: number;
  readonly presentedFrames: number;
  readonly exactFrames: number;
  readonly standinFrames: number;
  readonly computeFrames: number;
  readonly rafIntervalMs: Quantiles;
  readonly cpuMs: Quantiles;
  readonly cpuSplit: CpuSplit;
  readonly fenceMs: Quantiles | null;
  readonly timestampsSupported: boolean;
  readonly gpuMs: Quantiles | null;
  readonly gpuSpanMs: Quantiles | null;
  readonly passAvgMs: Readonly<Record<string, number>>;
  readonly bump: {
    readonly framesSubmitted: number;
    readonly framesChecked: number;
    readonly failedFrames: number;
    readonly anyFailedMask: number;
    readonly maxLines: number;
    readonly maxSegments: number;
    readonly maxTile: number;
    readonly maxPtcl: number;
    readonly maxBinning: number;
    readonly maxBlend: number;
  } | null;
  readonly capacities: Record<string, number> | null;
  readonly scene: ComputeStats["scene"];
}

interface PresentationVerification {
  readonly readbackNonBlankRatioA: number;
  readonly readbackNonBlankRatioB: number;
  readonly readbackZoomChangedRatio: number;
  readonly readbackConfirmed: boolean;
  readonly onscreenNonBlankRatioA: number;
  readonly onscreenNonBlankRatioB: number;
  readonly onscreenZoomChangedRatio: number;
  readonly onscreenConfirmed: boolean;
}

interface ScaleReport {
  readonly requestedNodes: number;
  readonly layers: number;
  readonly listBytes: number;
  readonly listBuildMs: number;
  readonly applyMs: number;
  readonly adapter: string;
  readonly software: boolean;
  presentationMode: PresentationMode;
  readonly presentationCheck: PresentationVerification;
  readonly strokeCache: {
    readonly opsTotal: number;
    readonly opsCached: number;
    readonly inputVerbs: number;
    readonly expandedVerbs: number;
    readonly cachedBytes: number;
    readonly verbGrowthRatio: number;
  } | null;
  readonly sweeps: readonly SweepResult[];
}

function decodePngRgba(png: Buffer): { data: Uint8Array; width: number; height: number } {
  if (png.length < 33 || png.readUInt32BE(0) !== 0x89504e47) {
    return { data: new Uint8Array(0), width: 0, height: 0 };
  }
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat: Buffer[] = [];
  for (let off = 8; off + 12 <= png.length; ) {
    const len = png.readUInt32BE(off);
    const type = png.subarray(off + 4, off + 8).toString("ascii");
    const chunk = png.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      width = chunk.readUInt32BE(0);
      height = chunk.readUInt32BE(4);
      bitDepth = chunk[8] ?? 0;
      colorType = chunk[9] ?? 0;
    } else if (type === "IDAT") {
      idat.push(chunk);
    } else if (type === "IEND") {
      break;
    }
    off += 12 + len;
  }
  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!width || !height || bitDepth !== 8 || !bpp) {
    return { data: new Uint8Array(0), width: 0, height: 0 };
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const out = new Uint8Array(height * stride);
  const paeth = (a: number, b: number, c: number) => {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)] ?? 0;
    const rowOff = y * stride;
    const srcOff = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x++) {
      const v = raw[srcOff + x] ?? 0;
      const a = x >= bpp ? (out[rowOff + x - bpp] ?? 0) : 0;
      const b = y > 0 ? (out[rowOff - stride + x] ?? 0) : 0;
      const c = x >= bpp && y > 0 ? (out[rowOff - stride + x - bpp] ?? 0) : 0;
      let recon = v;
      if (filter === 1) recon = (v + a) & 0xff;
      else if (filter === 2) recon = (v + b) & 0xff;
      else if (filter === 3) recon = (v + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) recon = (v + paeth(a, b, c)) & 0xff;
      out[rowOff + x] = recon;
    }
  }
  if (bpp === 4) return { data: out, width, height };
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0, j = 0; i < out.length; i += 3, j += 4) {
    rgba[j] = out[i] ?? 0;
    rgba[j + 1] = out[i + 1] ?? 0;
    rgba[j + 2] = out[i + 2] ?? 0;
    rgba[j + 3] = 255;
  }
  return { data: rgba, width, height };
}

function measureNonBlank(data: Uint8Array, width: number, height: number): number {
  if (width === 0 || height === 0) return 0;
  const bgR = data[0] ?? 0;
  const bgG = data[1] ?? 0;
  const bgB = data[2] ?? 0;
  let total = 0;
  let differing = 0;
  const step = Math.max(1, Math.floor(Math.sqrt((width * height) / 40_000)));
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = (y * width + x) * 4;
      total++;
      const diff =
        Math.abs((data[i] ?? 0) - bgR) +
        Math.abs((data[i + 1] ?? 0) - bgG) +
        Math.abs((data[i + 2] ?? 0) - bgB);
      if (diff > 18) differing++;
    }
  }
  return total > 0 ? Math.round((differing / total) * 10000) / 10000 : 0;
}

function measureChanged(a: Uint8Array, b: Uint8Array, width: number, height: number): number {
  if (width === 0 || height === 0 || a.length !== b.length) return 0;
  let total = 0;
  let changed = 0;
  const step = Math.max(1, Math.floor(Math.sqrt((width * height) / 40_000)));
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = (y * width + x) * 4;
      total++;
      const diff =
        Math.abs((a[i] ?? 0) - (b[i] ?? 0)) +
        Math.abs((a[i + 1] ?? 0) - (b[i + 1] ?? 0)) +
        Math.abs((a[i + 2] ?? 0) - (b[i + 2] ?? 0));
      if (diff > 12) changed++;
    }
  }
  return total > 0 ? Math.round((changed / total) * 10000) / 10000 : 0;
}

function largestPage(nodes: readonly NodeRecord[]): { id: string; layers: number } {
  const parent = new Map(nodes.map((n) => [n.id, n.parent]));
  const pages = new Set(nodes.filter((n) => n.type === "page").map((n) => n.id));
  const count = new Map<string, number>();
  for (const n of nodes) {
    let at = n.parent;
    while (at && !pages.has(at)) at = parent.get(at) ?? "";
    if (at) count.set(at, (count.get(at) ?? 0) + 1);
  }
  const best = [...count].sort((a, b) => b[1] - a[1])[0] as [string, number];
  return { id: best[0], layers: best[1] };
}

async function loadChunks(page: Page, chunks: number): Promise<number> {
  return page.evaluate(async (n) => {
    const e = (
      window as unknown as {
        drawpane: {
          doc: {
            stored(): unknown[];
            resetStored(nodes: Iterable<unknown>, copies: "materialized" | "compact"): void;
          };
        };
      }
    ).drawpane;
    const all: unknown[] = [...e.doc.stored()];
    for (let i = 0; i < n; i++) {
      for (const node of (await (await fetch(`/__corpus/${i}`)).json()) as unknown[]) {
        all.push(node);
      }
    }
    const t = performance.now();
    e.doc.resetStored(all, "materialized");
    return performance.now() - t;
  }, chunks);
}

function fmtQ(q: Quantiles | null): string {
  if (!q) return "n/a";
  return `${q.p50.toFixed(2)} / ${q.p95.toFixed(2)} / ${q.p99.toFixed(2)}`;
}

test.describe("P0 GPU compute benchmark", () => {
  test.skip(!!process.env.E2E_BASE_URL, "Needs its own local instance.");
  let instance: Instance;
  let pages: NodeRecord[][] = [];

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(240_000);
    const port = Number(process.env.BENCH_PORT ?? 8843);
    instance = await freshInstance(browser, { port, inspectorPort: port + 540 });
    await instance.page.route("**/__corpus/*", (route) => {
      const i = Number(route.request().url().split("/").pop());
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(pages[i] ?? []),
      });
    });
  });

  test.afterAll(async () => {
    await instance?.stop();
  });

  test("measures Retina 2x continuous zoom with hardware timestamps, CPU/GPU split, and confirmed presentations", async () => {
    test.setTimeout(20 * 60_000);
    const page = instance.page;
    page.on("pageerror", (err) => console.log(`pageerror: ${err.message}`));

    const reports: ScaleReport[] = [];

    for (const scale of SIZES) {
      const kit = generateKit({ layers: scale });
      const nodes: NodeRecord[] = NO_EFFECTS
        ? kit.nodes.map((n) => {
            const p = n.props as Record<string, unknown>;
            if (
              p.effects === undefined &&
              p.blendMode === undefined &&
              p.isMask === undefined &&
              p.fills === undefined
            ) {
              return n;
            }
            const nextProps: Record<string, unknown> = { ...p };
            delete nextProps.effects;
            if (nextProps.blendMode && nextProps.blendMode !== "normal") {
              nextProps.blendMode = "normal";
            }
            if (nextProps.isMask) {
              delete nextProps.isMask;
              delete nextProps.maskType;
            }
            if (Array.isArray(nextProps.fills)) {
              nextProps.fills = (nextProps.fills as Array<Record<string, unknown>>).map((f) => {
                if (f.type === "diamond" || f.type === "image") {
                  return { type: "solid", color: "#4c78d8", opacity: 1 };
                }
                return f.blendMode && f.blendMode !== "normal" ? { ...f, blendMode: "normal" } : f;
              });
            }
            return { ...n, props: nextProps } as NodeRecord;
          })
        : kit.nodes;

      const target = largestPage(nodes);
      pages = [];
      for (let i = 0; i < nodes.length; i += CHUNK) pages.push(nodes.slice(i, i + CHUNK));

      await page.goto("/");
      await page.evaluate(() => {
        localStorage.setItem("drawpane:debug", "1");
        localStorage.setItem("drawpane:renderer", "canvas");
      });
      await page.reload();
      await page.getByRole("button", { name: "New file" }).first().click();
      await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
        timeout: 30_000,
      });

      await loadChunks(page, pages.length);

      // Run sweeps inside the page, leaving the live canvas + engine mounted for onscreen
      // screenshot presentation verification right after the sweeps finish.
      const rawReport = await page.evaluate(
        async ({
          pageId,
          width,
          height,
          bg,
          zoomFrames,
          baselineFrames,
          includeFit,
          forceOffscreen,
          requestedNodes,
          layers,
        }) => {
          type EngineApi = {
            drawpane: {
              scene: {
                bounds(id: string): { x: number; y: number; width: number; height: number } | null;
              };
              doc: { childIds(id: string): string[] };
              state: { set(p: object): void };
            };
            drawpaneEngine: {
              list(pageId: string): {
                list: string;
                unsupported: Record<string, string[]>;
                records: number;
                supported: boolean;
                waiting: number;
              };
              createBrowserEngine(options?: { glyphMaskBytes?: number }): Promise<RenderEngine>;
            };
            __p0Bench?: {
              renderAt(zoom: number): Promise<{ presented: boolean; exact: boolean }>;
              dispose(): void;
            };
          };
          const w = window as unknown as EngineApi;
          w.drawpane.state.set({ pageId });

          // Wait for fonts to settle so text outlines are complete (avoiding unoutlined stand-ins).
          for (let waited = 0; waited < 15_000; waited += 100) {
            if (w.drawpaneEngine.list(pageId).waiting === 0) break;
            await new Promise((r) => setTimeout(r, 100));
          }

          const tBuild0 = performance.now();
          const built = w.drawpaneEngine.list(pageId);
          const listBuildMs = performance.now() - tBuild0;
          const bin = atob(built.list);
          const listBytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) listBytes[i] = bin.charCodeAt(i);

          let minX = Number.POSITIVE_INFINITY;
          let minY = Number.POSITIVE_INFINITY;
          let maxX = Number.NEGATIVE_INFINITY;
          let maxY = Number.NEGATIVE_INFINITY;
          // Also locate the densest top-level artboard so 100% zoom frames dense UI content
          // rather than an empty gap between boards.
          const countSubtree = (id: string): number => {
            let total = 1;
            for (const c of w.drawpane.doc.childIds(id)) total += countSubtree(c);
            return total;
          };
          let bestCount = -1;
          let bestBox: { x: number; y: number; width: number; height: number } | null = null;
          for (const cid of w.drawpane.doc.childIds(pageId)) {
            const b = w.drawpane.scene.bounds(cid);
            if (!b || b.width <= 0 || b.height <= 0) continue;
            minX = Math.min(minX, b.x);
            minY = Math.min(minY, b.y);
            maxX = Math.max(maxX, b.x + b.width);
            maxY = Math.max(maxY, b.y + b.height);
            const n = countSubtree(cid);
            if (n > bestCount) {
              bestCount = n;
              bestBox = b;
            }
          }
          if (!Number.isFinite(minX)) {
            minX = 0;
            minY = 0;
            maxX = 2400;
            maxY = 1600;
          }
          const dpr = 2;
          const cssW = width / dpr;
          const cssH = height / dpr;
          const contentW = Math.max(1, maxX - minX);
          const contentH = Math.max(1, maxY - minY);
          const centerX = minX + contentW * 0.5;
          const centerY = minY + contentH * 0.5;
          const focusX = bestBox ? bestBox.x + bestBox.width * 0.5 : centerX;
          const focusY = bestBox ? bestBox.y + bestBox.height * 0.5 : centerY;
          const fitZoom = Math.min((cssW * 0.92) / contentW, (cssH * 0.92) / contentH, 1.0);

          const quant = (xs: readonly number[]) => {
            if (xs.length === 0) return { p50: 0, p95: 0, p99: 0, min: 0, max: 0 };
            const s = [...xs].sort((a, b) => a - b);
            const at = (q: number) =>
              Math.round((s[Math.floor(q * (s.length - 1))] ?? 0) * 1000) / 1000;
            return { p50: at(0.5), p95: at(0.95), p99: at(0.99), min: at(0), max: at(1) };
          };

          const sampleDiffRatio = (
            a: Uint8Array,
            b: Uint8Array | null,
            bgRgb: readonly [number, number, number],
          ): number => {
            let total = 0;
            let diff = 0;
            const step = Math.max(1, Math.floor(Math.sqrt((width * height) / 40_000)));
            for (let y = 0; y < height; y += step) {
              for (let x = 0; x < width; x += step) {
                const i = (y * width + x) * 4;
                total++;
                const d = b
                  ? Math.abs((a[i] ?? 0) - (b[i] ?? 0)) +
                    Math.abs((a[i + 1] ?? 0) - (b[i + 1] ?? 0)) +
                    Math.abs((a[i + 2] ?? 0) - (b[i + 2] ?? 0))
                  : Math.abs((a[i] ?? 0) - bgRgb[0]) +
                    Math.abs((a[i + 1] ?? 0) - bgRgb[1]) +
                    Math.abs((a[i + 2] ?? 0) - bgRgb[2]);
                if (d > (b ? 12 : 18)) diff++;
              }
            }
            return total > 0 ? Math.round((diff / total) * 10000) / 10000 : 0;
          };

          const canvas = document.createElement("canvas");
          canvas.dataset.p0Bench = "1";
          canvas.width = width;
          canvas.height = height;
          canvas.style.position = "fixed";
          canvas.style.left = "0";
          canvas.style.top = "0";
          canvas.style.width = `${width / 2}px`;
          canvas.style.height = `${height / 2}px`;
          canvas.style.zIndex = "999999";
          canvas.style.pointerEvents = "none";
          document.body.append(canvas);

          const engine = await w.drawpaneEngine.createBrowserEngine({ glyphMaskBytes: 32 << 20 });
          let keptAlive = false;
          try {
            let presentationMode: "presented-canvas" | "render-only-raf" | "offscreen-raf" =
              "presented-canvas";
            let attached: Result<GpuInfo> = forceOffscreen
              ? { ok: false, code: 11, message: "forced offscreen" }
              : await engine.attachGpu(canvas, { compatibility: false, glyphMaskBytes: 32 << 20 });
            if (!attached.ok) {
              presentationMode = "offscreen-raf";
              attached = await engine.attachGpu(null, {
                compatibility: false,
                glyphMaskBytes: 32 << 20,
              });
            }
            if (!attached.ok) {
              throw new Error(`WebGPU Core attach failed: ${attached.message}`);
            }

            const tApply0 = performance.now();
            const applied = engine.apply(listBytes);
            const applyMs = performance.now() - tApply0;
            if (!applied.ok) throw new Error(`apply failed: ${applied.message}`);

            // Engine Camera::view maps page point p to (p * zoom + (x, y)) * dpr.
            const cameraAt = (zoom: number, cx = focusX, cy = focusY) => ({
              zoom,
              x: cssW * 0.5 - cx * zoom,
              y: cssH * 0.5 - cy * zoom,
              dpr,
            });

            // Warm probe: verify whether direct presentation succeeded; if the driver refuses
            // canvas presentation, detach and label honestly as offscreen-raf.
            engine.setComputeOrdinary(true);
            const probe = engine.renderGpu(width, height, cameraAt(1.0), bg, false);
            if (!probe.ok) throw new Error(`probe renderGpu failed: ${probe.message}`);
            if (presentationMode === "presented-canvas" && !probe.value.presented) {
              engine.detachGpu();
              presentationMode = "offscreen-raf";
              const re = await engine.attachGpu(null, {
                compatibility: false,
                glyphMaskBytes: 32 << 20,
              });
              if (!re.ok) throw new Error(`offscreen reattach failed: ${re.message}`);
              engine.setComputeOrdinary(true);
            }
            const finProbe = await engine.gpuFinished();
            if (!finProbe.ok) throw new Error(`probe gpuFinished failed: ${finProbe.message}`);

            const runSweep = async (
              label: string,
              mode: "compute" | "vello_gpu",
              baseZoom: number,
              amplitude: number,
              frames: number,
              cx: number,
              cy: number,
            ) => {
              engine.setComputeOrdinary(mode === "compute");
              for (let i = 0; i < 3; i++) {
                const z = Math.max(0.05, baseZoom * (1 + (i - 1) * 0.02));
                const r = engine.renderGpu(width, height, cameraAt(z, cx, cy), bg, false);
                if (!r.ok) throw new Error(`${label} warmup failed: ${r.message}`);
                await new Promise<void>((res) => requestAnimationFrame(() => res()));
              }
              const fw = await engine.gpuFinished();
              if (!fw.ok) throw new Error(`${label} warmup fence failed: ${fw.message}`);

              engine.computeResetStats();

              const rafIntervals: number[] = [];
              const cpuEncode: number[] = [];
              const cpuRender: number[] = [];
              const cpuSubmit: number[] = [];
              const cpuTotal: number[] = [];
              const cpuCall: number[] = [];
              const fenceSamples: number[] = [];
              let presentedFrames = 0;
              let exactFrames = 0;
              let standinFrames = 0;
              let computeFrames = 0;

              let prevRaf = await new Promise<number>((res) => requestAnimationFrame(res));
              for (let i = 0; i < frames; i++) {
                const nowRaf = await new Promise<number>((res) => requestAnimationFrame(res));
                rafIntervals.push(nowRaf - prevRaf);
                prevRaf = nowRaf;

                const phase = (i / Math.max(1, frames - 1)) * Math.PI * 4;
                const zoom = Math.max(0.05, baseZoom * (1 + amplitude * Math.sin(phase)));
                const t0 = performance.now();
                const r: Result<FrameStats> = engine.renderGpu(
                  width,
                  height,
                  cameraAt(zoom, cx, cy),
                  bg,
                  false,
                );
                const t1 = performance.now();
                if (!r.ok) throw new Error(`${label} frame ${i} failed: ${r.message}`);
                cpuEncode.push(r.value.ms.encode);
                cpuRender.push(r.value.ms.render);
                cpuSubmit.push(r.value.ms.submit);
                cpuTotal.push(r.value.ms.total);
                cpuCall.push(t1 - t0);
                if (r.value.presented) presentedFrames++;
                if (r.value.exact) exactFrames++;
                if (r.value.standin) standinFrames++;
                if (engine.computeUsed()) computeFrames++;

                // Always measure post-submit GPU completion tail on main vello_gpu so the
                // CPU-encoding vs GPU-execution split is directly comparable on both paths.
                if (mode === "vello_gpu") {
                  const tf0 = performance.now();
                  const f = await engine.gpuFinished();
                  if (!f.ok) throw new Error(`${label} fence failed: ${f.message}`);
                  fenceSamples.push(performance.now() - tf0);
                }
              }

              const fin = await engine.gpuFinished();
              if (!fin.ok) throw new Error(`${label} final fence failed: ${fin.message}`);

              const cpuSplit = {
                encodeMs: quant(cpuEncode),
                renderMs: quant(cpuRender),
                submitMs: quant(cpuSubmit),
                totalMs: quant(cpuTotal),
                callMs: quant(cpuCall),
              };

              if (mode === "compute") {
                const cs = await engine.computeStats();
                if (!cs.ok) throw new Error(`${label} computeStats failed: ${cs.message}`);
                const s = cs.value;

                // When hardware timestamp queries are absent (e.g. Safari without timestamp-query),
                // measure a short post-sweep GPU completion fence probe so GPU tail is reported.
                if (!s.timestampsSupported) {
                  for (let k = 0; k < 12; k++) {
                    const zoom = Math.max(0.05, baseZoom * (1 + amplitude * Math.sin(k * 0.5)));
                    const r = engine.renderGpu(width, height, cameraAt(zoom, cx, cy), bg, false);
                    if (!r.ok) throw new Error(`${label} fence probe failed: ${r.message}`);
                    const tf0 = performance.now();
                    const f = await engine.gpuFinished();
                    if (!f.ok) throw new Error(`${label} fence probe wait failed: ${f.message}`);
                    fenceSamples.push(performance.now() - tf0);
                  }
                }

                return {
                  label,
                  mode,
                  presentationMode:
                    presentedFrames > 0 ? ("presented-canvas" as const) : presentationMode,
                  frames,
                  presentedFrames,
                  exactFrames,
                  standinFrames,
                  computeFrames,
                  rafIntervalMs: quant(rafIntervals),
                  cpuMs: cpuSplit.callMs,
                  cpuSplit,
                  fenceMs: fenceSamples.length > 0 ? quant(fenceSamples) : null,
                  timestampsSupported: s.timestampsSupported,
                  gpuMs: s.timestampsSupported && s.gpuMs.length > 0 ? quant(s.gpuMs) : null,
                  gpuSpanMs:
                    s.timestampsSupported && s.gpuSpanMs.length > 0 ? quant(s.gpuSpanMs) : null,
                  passAvgMs: s.passAvgMs,
                  bump: {
                    framesSubmitted: s.framesSubmitted,
                    framesChecked: s.framesChecked,
                    failedFrames: s.failedFrames,
                    anyFailedMask: s.anyFailedMask,
                    maxLines: s.maxBump.lines,
                    maxSegments: s.maxBump.segments,
                    maxTile: s.maxBump.tile,
                    maxPtcl: s.maxBump.ptcl,
                    maxBinning: s.maxBump.binning,
                    maxBlend: s.maxBump.blend,
                  },
                  capacities: s.capacities,
                  scene: s.scene,
                };
              }

              return {
                label,
                mode,
                presentationMode:
                  presentedFrames > 0 ? ("presented-canvas" as const) : presentationMode,
                frames,
                presentedFrames,
                exactFrames,
                standinFrames,
                computeFrames,
                rafIntervalMs: quant(rafIntervals),
                cpuMs: cpuSplit.callMs,
                cpuSplit,
                fenceMs: fenceSamples.length > 0 ? quant(fenceSamples) : null,
                timestampsSupported: false,
                gpuMs: null,
                gpuSpanMs: null,
                passAvgMs: {},
                bump: null,
                capacities: null,
                scene: null,
              };
            };

            const sweeps = [];
            sweeps.push(
              await runSweep(
                "100% zoom (compute P0)",
                "compute",
                1.0,
                0.22,
                zoomFrames,
                focusX,
                focusY,
              ),
            );
            if (includeFit) {
              sweeps.push(
                await runSweep(
                  "fit-all zoom (compute P0)",
                  "compute",
                  fitZoom,
                  0.2,
                  zoomFrames,
                  centerX,
                  centerY,
                ),
              );
            }
            if (baselineFrames > 0) {
              sweeps.push(
                await runSweep(
                  "100% zoom (main vello_gpu)",
                  "vello_gpu",
                  1.0,
                  0.22,
                  baselineFrames,
                  focusX,
                  focusY,
                ),
              );
            }

            // Readback check at two distinct zooms on compute to prove real non-blank rendered
            // pixels and real camera response (never blank or frozen).
            engine.setComputeOrdinary(true);
            const rA = engine.renderGpu(width, height, cameraAt(1.0), bg, false);
            if (!rA.ok) throw new Error(`readback zoom A failed: ${rA.message}`);
            const fA = await engine.gpuFinished();
            if (!fA.ok) throw new Error(`readback zoom A fence failed: ${fA.message}`);
            const pA = await engine.gpuPixels();
            if (!pA.ok) throw new Error(`readback zoom A gpuPixels failed: ${pA.message}`);

            const rB = engine.renderGpu(width, height, cameraAt(1.22), bg, false);
            if (!rB.ok) throw new Error(`readback zoom B failed: ${rB.message}`);
            const fB = await engine.gpuFinished();
            if (!fB.ok) throw new Error(`readback zoom B fence failed: ${fB.message}`);
            const pB = await engine.gpuPixels();
            if (!pB.ok) throw new Error(`readback zoom B gpuPixels failed: ${pB.message}`);

            const bgRgb: [number, number, number] = [
              Math.round(bg[0] * 255),
              Math.round(bg[1] * 255),
              Math.round(bg[2] * 255),
            ];
            const readbackNonBlankRatioA = sampleDiffRatio(pA.value, null, bgRgb);
            const readbackNonBlankRatioB = sampleDiffRatio(pB.value, null, bgRgb);
            const readbackZoomChangedRatio = sampleDiffRatio(pA.value, pB.value, bgRgb);

            const sc = engine.strokeCacheStats();
            const strokeCache = sc.ok
              ? {
                  ...sc.value,
                  verbGrowthRatio:
                    sc.value.inputVerbs > 0
                      ? Math.round((sc.value.expandedVerbs / sc.value.inputVerbs) * 100) / 100
                      : 0,
                }
              : null;

            // Keep canvas + engine alive briefly so Playwright can take real composited element
            // screenshots at two zooms to confirm onscreen WebGPU presentation.
            w.__p0Bench = {
              async renderAt(zoom: number) {
                engine.setComputeOrdinary(true);
                const r = engine.renderGpu(width, height, cameraAt(zoom), bg, false);
                if (!r.ok) throw new Error(`onscreen check renderGpu failed: ${r.message}`);
                const f = await engine.gpuFinished();
                if (!f.ok) throw new Error(`onscreen check gpuFinished failed: ${f.message}`);
                await new Promise<void>((res) =>
                  requestAnimationFrame(() => requestAnimationFrame(() => res())),
                );
                return { presented: r.value.presented, exact: r.value.exact };
              },
              dispose() {
                engine.dispose();
                canvas.remove();
              },
            };
            keptAlive = true;

            return {
              requestedNodes,
              layers,
              listBytes: listBytes.length,
              listBuildMs: Math.round(listBuildMs * 100) / 100,
              applyMs: Math.round(applyMs * 100) / 100,
              adapter: attached.value.adapter,
              software: attached.value.fallback,
              presentationMode,
              readbackNonBlankRatioA,
              readbackNonBlankRatioB,
              readbackZoomChangedRatio,
              strokeCache,
              sweeps,
            };
          } finally {
            if (!keptAlive) {
              engine.dispose();
              canvas.remove();
            }
          }
        },
        {
          pageId: target.id,
          width: WIDTH,
          height: HEIGHT,
          bg: BG,
          zoomFrames: ZOOM_FRAMES,
          baselineFrames: BASELINE_FRAMES,
          includeFit: INCLUDE_FIT,
          forceOffscreen: FORCE_OFFSCREEN,
          requestedNodes: scale,
          layers: target.layers,
        },
      );

      // Verify real onscreen composited presentation via Playwright element screenshots at zoom
      // 1.0 and zoom 1.22 (independent of 2D canvas readback), then dispose cleanly.
      let onscreenNonBlankRatioA = 0;
      let onscreenNonBlankRatioB = 0;
      let onscreenZoomChangedRatio = 0;
      try {
        if (rawReport.presentationMode === "presented-canvas") {
          const canvasLoc = page.locator('canvas[data-p0-bench="1"]');
          await page.evaluate(() =>
            (
              window as unknown as {
                __p0Bench: { renderAt(z: number): Promise<unknown> };
              }
            ).__p0Bench.renderAt(1.0),
          );
          const pngA = await canvasLoc.screenshot();
          await page.evaluate(() =>
            (
              window as unknown as {
                __p0Bench: { renderAt(z: number): Promise<unknown> };
              }
            ).__p0Bench.renderAt(1.22),
          );
          const pngB = await canvasLoc.screenshot();
          const decA = decodePngRgba(pngA);
          const decB = decodePngRgba(pngB);
          onscreenNonBlankRatioA = measureNonBlank(decA.data, decA.width, decA.height);
          onscreenNonBlankRatioB = measureNonBlank(decB.data, decB.width, decB.height);
          onscreenZoomChangedRatio = measureChanged(decA.data, decB.data, decA.width, decA.height);
        }
      } finally {
        await page.evaluate(() => {
          const w = window as unknown as { __p0Bench?: { dispose(): void } };
          w.__p0Bench?.dispose();
          delete w.__p0Bench;
        });
      }

      const readbackConfirmed =
        rawReport.readbackNonBlankRatioA >= 0.01 &&
        rawReport.readbackNonBlankRatioB >= 0.01 &&
        rawReport.readbackZoomChangedRatio >= 0.01;
      const onscreenConfirmed =
        rawReport.presentationMode === "presented-canvas" &&
        onscreenNonBlankRatioA >= 0.01 &&
        onscreenNonBlankRatioB >= 0.01 &&
        onscreenZoomChangedRatio >= 0.01;

      const effectivePresentationMode: PresentationMode = onscreenConfirmed
        ? "presented-canvas"
        : rawReport.presentationMode === "presented-canvas"
          ? "render-only-raf"
          : rawReport.presentationMode;

      const sweeps: SweepResult[] = rawReport.sweeps.map((sw) => ({
        ...sw,
        presentationMode:
          sw.presentationMode === "presented-canvas" && !onscreenConfirmed
            ? "render-only-raf"
            : sw.presentationMode,
      }));

      const report: ScaleReport = {
        requestedNodes: rawReport.requestedNodes,
        layers: rawReport.layers,
        listBytes: rawReport.listBytes,
        listBuildMs: rawReport.listBuildMs,
        applyMs: rawReport.applyMs,
        adapter: rawReport.adapter,
        software: rawReport.software,
        presentationMode: effectivePresentationMode,
        presentationCheck: {
          readbackNonBlankRatioA: rawReport.readbackNonBlankRatioA,
          readbackNonBlankRatioB: rawReport.readbackNonBlankRatioB,
          readbackZoomChangedRatio: rawReport.readbackZoomChangedRatio,
          readbackConfirmed,
          onscreenNonBlankRatioA,
          onscreenNonBlankRatioB,
          onscreenZoomChangedRatio,
          onscreenConfirmed,
        },
        strokeCache: rawReport.strokeCache,
        sweeps,
      };

      reports.push(report);

      // Print clear summary table with CPU-vs-GPU split and presentation verification.
      console.log(
        `\n=== P0 Bench: ${report.layers} layers (${report.requestedNodes} kit nodes), ${WIDTH}x${HEIGHT} Retina 2x, ${report.adapter}${report.software ? " (software)" : ""} [${report.presentationMode}] ===`,
      );
      console.log(
        `Presentation check: readback=${readbackConfirmed ? "OK" : "FAIL"} (nonBlank=${report.presentationCheck.readbackNonBlankRatioA}/${report.presentationCheck.readbackNonBlankRatioB}, zoomDelta=${report.presentationCheck.readbackZoomChangedRatio}) | onscreen=${onscreenConfirmed ? "CONFIRMED" : "UNCONFIRMED"} (nonBlank=${onscreenNonBlankRatioA}/${onscreenNonBlankRatioB}, zoomDelta=${onscreenZoomChangedRatio})`,
      );
      if (report.strokeCache) {
        const sc = report.strokeCache;
        console.log(
          `Stroke cache: ${sc.opsCached}/${sc.opsTotal} ops expanded, verbs ${sc.inputVerbs} -> ${sc.expandedVerbs} (${sc.verbGrowthRatio}x), ${(sc.cachedBytes / 1024).toFixed(1)} KiB`,
        );
      }
      for (const sw of report.sweeps) {
        console.log(
          `  ${sw.label.padEnd(28)} | n=${String(sw.frames).padStart(3)} (exact=${sw.exactFrames}, pres=${sw.presentedFrames}) | rAF ${fmtQ(sw.rafIntervalMs)} ms | CPU ${fmtQ(sw.cpuSplit.totalMs)} ms | GPU ts ${fmtQ(sw.gpuMs)} ms (span ${fmtQ(sw.gpuSpanMs)}) | fence ${fmtQ(sw.fenceMs)} ms | bump ${sw.bump ? `${sw.bump.failedFrames}/${sw.bump.framesChecked} failed` : "n/a"}`,
        );
        console.log(
          `    CPU split (p50/p95/p99 ms): encode=${fmtQ(sw.cpuSplit.encodeMs)} | render=${fmtQ(sw.cpuSplit.renderMs)} | submit=${fmtQ(sw.cpuSplit.submitMs)} | total=${fmtQ(sw.cpuSplit.totalMs)} | jsCall=${fmtQ(sw.cpuSplit.callMs)}`,
        );
        if (sw.mode === "compute" && Object.keys(sw.passAvgMs).length > 0) {
          const passes = Object.entries(sw.passAvgMs)
            .map(([k, v]) => `${k}=${v.toFixed(3)}`)
            .join(" ");
          console.log(`    GPU passes avg ms: ${passes}`);
        }
        if (sw.bump && sw.capacities) {
          console.log(
            `    bump peak/cap: lines=${sw.bump.maxLines}/${sw.capacities.lines} segs=${sw.bump.maxSegments}/${sw.capacities.segments} tile=${sw.bump.maxTile}/${sw.capacities.tile} ptcl=${sw.bump.maxPtcl}/${sw.capacities.ptcl} bin=${sw.bump.maxBinning}/${sw.capacities.binning} blend=${sw.bump.maxBlend}/${sw.capacities.blend}`,
          );
        }
        if (sw.scene) {
          console.log(
            `    scene: paths=${sw.scene.nPaths} draws=${sw.scene.nDrawObjects} segs=${sw.scene.nPathSegments} glyphs=${sw.scene.nGlyphs} cold=${sw.scene.coldEncodeMs.toFixed(1)}+${sw.scene.coldResolveMs.toFixed(1)}+${sw.scene.coldUploadMs.toFixed(1)} ms gpu=${(sw.scene.totalGpuBytes / (1024 * 1024)).toFixed(2)} MiB`,
          );
        }
      }

      // Hard P0 assertions: real non-blank rendered pixels, zoom response, zero stand-ins, and
      // per-frame bump verification on every compute sweep.
      expect(readbackConfirmed, "compute readback must be non-blank and respond to zoom").toBe(
        true,
      );
      if (REQUIRE_PRESENT) {
        expect(
          onscreenConfirmed,
          "BENCH_REQUIRE_PRESENT=1: onscreen WebGPU canvas presentation must be confirmed",
        ).toBe(true);
        expect(report.presentationMode).toBe("presented-canvas");
      }

      for (const sw of report.sweeps) {
        if (sw.mode !== "compute") continue;
        expect(sw.computeFrames, `${sw.label}: every frame must run compute`).toBe(sw.frames);
        expect(sw.exactFrames, `${sw.label}: every frame must be exact (no stand-ins)`).toBe(
          sw.frames,
        );
        expect(sw.standinFrames, `${sw.label}: zero stand-in frames`).toBe(0);
        if (REQUIRE_PRESENT) {
          expect(sw.presentedFrames, `${sw.label}: every frame must present onscreen`).toBe(
            sw.frames,
          );
        }
        expect(sw.bump, `${sw.label}: bump diagnostics must be present`).not.toBeNull();
        expect(
          sw.bump?.framesChecked,
          `${sw.label}: every frame's bump counters must be verified`,
        ).toBe(sw.bump?.framesSubmitted);
        expect(
          sw.bump?.framesChecked,
          `${sw.label}: framesChecked >= frames`,
        ).toBeGreaterThanOrEqual(sw.frames);
        expect(sw.bump?.failedFrames, `${sw.label}: zero bump allocator failures`).toBe(0);
        expect(sw.bump?.anyFailedMask, `${sw.label}: zero bump failure mask bits`).toBe(0);
        if (ENFORCE_LAPTOP_GATE && sw.label.startsWith("100%") && sw.gpuMs && !report.software) {
          expect(sw.gpuMs.p95, `${sw.label}: laptop GPU p95 <= 8 ms`).toBeLessThanOrEqual(8.0);
        }
      }
    }

    const payload = { width: WIDTH, height: HEIGHT, zoomFrames: ZOOM_FRAMES, reports };
    test.info().annotations.push({ type: "bench", description: JSON.stringify(payload) });
    if (process.env.BENCH_OUT) {
      writeFileSync(process.env.BENCH_OUT, `${JSON.stringify(payload, null, 2)}\n`);
    }
  });
});
