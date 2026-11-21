/**
 * SPIKE BENCHMARK (decision 0040 zoom-transform research spike):
 * Measures exact per-frame continuous zoom (every frame at a new scale, no resampling, no tile
 * reuse across zoom levels) on WebGPU, comparing:
 *   - Baseline (`main`): `vello_gpu 0.4` sparse strips (CPU flatten + strip generation each zoom)
 *   - Spike: `vello 0.12` full GPU compute pipeline with GPU-side view transform (zero CPU
 *     scene re-encode on zoom/pan; both `Area` and `Msaa16` AA modes)
 *
 * Also measures cold scene encode/upload cost, GPU bump allocator memory usage (asserting
 * `bump.failed === 0`), and CPU-reference pixel parity (`@drawpane/engine/compare`) on both the
 * scale corpus and a synthetic stroke + AA torture scene.
 *
 * Env:
 *   BENCH_SCALE=12000,50000  (default: ~10.3k-layer page and ~40.4k-layer page)
 *   BENCH_NO_EFFECTS=1       (default: strip effects; glass is out of scope for this spike)
 *   BENCH_ZOOM_FRAMES=24     (timed zoom frames per sweep)
 *   BENCH_PORT=8841          (unusual free port for local worker)
 */
import { generateKit } from "@drawpane/corpus";
import { ListWriter, PathData, ROOT } from "@drawpane/engine/wire";
import type { NodeRecord } from "@drawpane/model";
import { expect, type Page, test } from "@playwright/test";
import { freshInstance, type Instance } from "../fresh-instance";
import { opening } from "./frames";

const SIZES = (process.env.BENCH_SCALE ?? "12000,50000").split(",").map(Number);
const NO_EFFECTS = process.env.BENCH_NO_EFFECTS !== "0";
const ZOOM_FRAMES = Number(process.env.BENCH_ZOOM_FRAMES ?? 24);
const CHUNK = 20_000;
const BG: [number, number, number, number] = [0.92, 0.92, 0.9, 1.0];

interface SweepStats {
  readonly frames: number;
  readonly cpuMedianMs: number;
  readonly cpuP95Ms: number;
  readonly encodeMedianMs: number;
  readonly renderMedianMs: number;
  readonly submitMedianMs: number;
  readonly gpuWaitMedianMs: number;
  readonly totalMedianMs: number;
  readonly totalP95Ms: number;
  readonly totalMinMs: number;
  readonly totalMaxMs: number;
}

interface ParityRow {
  readonly label: string;
  readonly mean: number;
  readonly p99: number;
  readonly max: number;
  readonly worstTile: number;
  readonly severe: number;
  readonly severeInTile: number;
  readonly outside: string[];
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

/** Builds a 512x512 synthetic scene stressing AA, hairlines, joins, caps, dashes, curves, clips, gradients. */
function buildParityScene(): number[] {
  // Use a high revision so apply() moves strictly forward past the blank document's initial revision.
  const w = new ListWriter(0xffffffff, 1_000_000);
  w.reset();

  // 1. Rounded rect with linear gradient fill + 1px stroke ring
  w.set(1, ROOT, {
    flags: 0,
    transform: [1, 0, 0, 1, 20, 20],
    opacity: 1,
    width: 140,
    height: 90,
    coarseBelow: 0,
    reach: 2,
    unsupported: 0,
    paths: [{ kind: "rect", w: 140, h: 90, radii: [16, 16, 16, 16], smoothing: 0 }],
    ops: [
      {
        op: "fill",
        path: 0,
        evenOdd: false,
        paint: {
          kind: "linear",
          matrix: [140, 0, 0, 90, 0, 0],
          stops: [
            { position: 0, color: [0.15, 0.45, 0.95, 1] },
            { position: 0.5, color: [0.55, 0.25, 0.85, 1] },
            { position: 1, color: [0.95, 0.35, 0.3, 1] },
          ],
        },
      },
      {
        op: "stroke",
        path: 0,
        style: { width: 1.5, join: 0, cap: 0, miter: 4, dashes: [], dashOffset: 0 },
        paint: { kind: "solid", color: [0.08, 0.1, 0.14, 1] },
      },
    ],
    coarse: [],
  });

  // 2. Hairline strokes (0.5px, 1px, 2px) at shallow diagonal angles (AA stress)
  const diag = new PathData();
  diag.moveTo(0, 0);
  diag.lineTo(220, 31);
  diag.moveTo(0, 18);
  diag.lineTo(220, 65);
  diag.moveTo(0, 42);
  diag.cubicTo(60, 10, 140, 95, 220, 48);
  for (const [idx, width, yOff, cap] of [
    [2, 0.5, 130, 0],
    [3, 1.0, 205, 1],
    [4, 2.0, 280, 2],
  ] as const) {
    w.set(idx, ROOT, {
      flags: 0,
      transform: [1, 0, 0, 1, 20, yOff],
      opacity: 1,
      width: 220,
      height: 80,
      coarseBelow: 0,
      reach: 4,
      unsupported: 0,
      paths: [{ kind: "path", path: diag }],
      ops: [
        {
          op: "stroke",
          path: 0,
          style: { width, join: 1, cap, miter: 4, dashes: [], dashOffset: 0 },
          paint: { kind: "solid", color: [0.1, 0.12, 0.16, 1] },
        },
      ],
      coarse: [],
    });
  }

  // 3. Sharp miter, round, bevel joins + dashed cubic curve
  const zig = new PathData();
  zig.moveTo(0, 50);
  zig.lineTo(40, 5);
  zig.lineTo(80, 55);
  zig.lineTo(120, 10);
  zig.lineTo(160, 50);
  for (const [idx, join, yOff] of [
    [5, 0, 25],
    [6, 1, 95],
    [7, 2, 165],
  ] as const) {
    w.set(idx, ROOT, {
      flags: 0,
      transform: [1, 0, 0, 1, 290, yOff],
      opacity: 1,
      width: 170,
      height: 60,
      coarseBelow: 0,
      reach: 12,
      unsupported: 0,
      paths: [{ kind: "path", path: zig }],
      ops: [
        {
          op: "stroke",
          path: 0,
          style: { width: 5, join, cap: 0, miter: 4, dashes: [], dashOffset: 0 },
          paint: { kind: "solid", color: [0.12, 0.32, 0.72, 1] },
        },
      ],
      coarse: [],
    });
  }

  // 4. Dashed cubic stroke
  const dashPath = new PathData();
  dashPath.moveTo(0, 20);
  dashPath.cubicTo(50, -15, 130, 65, 190, 20);
  w.set(8, ROOT, {
    flags: 0,
    transform: [1, 0, 0, 1, 290, 250],
    opacity: 1,
    width: 190,
    height: 60,
    coarseBelow: 0,
    reach: 6,
    unsupported: 0,
    paths: [{ kind: "path", path: dashPath }],
    ops: [
      {
        op: "stroke",
        path: 0,
        style: { width: 3, join: 1, cap: 1, miter: 4, dashes: [10, 6], dashOffset: 2 },
        paint: { kind: "solid", color: [0.85, 0.25, 0.15, 1] },
      },
    ],
    coarse: [],
  });

  // 5. Clipped ellipse with radial gradient + translucent overlay
  w.set(9, ROOT, {
    flags: 0,
    transform: [1, 0, 0, 1, 280, 340],
    opacity: 1,
    width: 180,
    height: 120,
    coarseBelow: 0,
    reach: 2,
    unsupported: 0,
    paths: [
      { kind: "rect", w: 180, h: 120, radii: [20, 20, 20, 20], smoothing: 0 },
      { kind: "ellipse", w: 160, h: 100 },
    ],
    ops: [
      { op: "clip", path: 0, evenOdd: false },
      {
        op: "fill",
        path: 1,
        evenOdd: false,
        paint: {
          kind: "radial",
          matrix: [80, 0, 0, 50, 80, 50],
          stops: [
            { position: 0, color: [0.98, 0.85, 0.2, 1] },
            { position: 1, color: [0.2, 0.72, 0.55, 1] },
          ],
        },
      },
      { op: "unclip" },
    ],
    coarse: [],
  });

  // 6. Small circle/ellipse + rounded pill buttons
  w.set(10, ROOT, {
    flags: 0,
    transform: [1, 0, 0, 1, 25, 385],
    opacity: 0.85,
    width: 200,
    height: 90,
    coarseBelow: 0,
    reach: 2,
    unsupported: 0,
    paths: [
      { kind: "rect", w: 90, h: 36, radii: [18, 18, 18, 18], smoothing: 0 },
      { kind: "ellipse", w: 64, h: 64 },
    ],
    ops: [
      { op: "fill", path: 0, evenOdd: false, paint: { kind: "solid", color: [0.1, 0.55, 0.4, 1] } },
      {
        op: "fill",
        path: 1,
        evenOdd: false,
        paint: { kind: "solid", color: [0.8, 0.2, 0.4, 0.65] },
      },
    ],
    coarse: [],
  });

  return [...w.finish()];
}

async function openEditorWithEngine(page: Page): Promise<void> {
  await page.goto("/");
  await page.evaluate(
    ({ present }) => {
      localStorage.setItem("drawpane:debug", "1");
      localStorage.setItem("drawpane:renderer", "engine");
      localStorage.setItem("drawpane:engine-present", present);
    },
    {
      present: process.env.BENCH_ENGINE_PRESENT === "readback" ? "readback" : "webgpu",
    },
  );
  await page.reload();
  await page.getByRole("button", { name: "New file" }).first().click();
  await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
    timeout: 30_000,
  });
  await page.waitForFunction(
    () => {
      const v = (
        window as unknown as {
          drawpaneEngineView?: { engine?: { gpu?: { backend?: string } | null } };
        }
      ).drawpaneEngineView;
      return Boolean(v?.engine?.gpu);
    },
    undefined,
    { timeout: 30_000 },
  );
}

test.describe("WebGPU Zoom Transform Spike", () => {
  test.skip(!!process.env.E2E_BASE_URL, "Needs its own local instance.");
  let instance: Instance;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000);
    const port = Number(process.env.BENCH_PORT ?? 8841);
    instance = await freshInstance(browser, { port, inspectorPort: port + 540 });
  });
  test.afterAll(async () => {
    await instance?.stop();
  });

  test("synthetic stroke + AA parity against CPU reference", async () => {
    const page = instance.page;
    await openEditorWithEngine(page);

    const list = buildParityScene();
    const res = await page.evaluate(
      async ({ list, bg }) => {
        type ParityEngine = {
          readonly gpu: { adapter: string; backend: string; fallback: boolean } | null;
          apply(bytes: Uint8Array): { ok: boolean; message?: string };
          clearTiles(): void;
          renderCpu(
            w: number,
            h: number,
            cam: { zoom: number; x: number; y: number; dpr: number },
            bg: readonly [number, number, number, number],
            detail: boolean,
          ): { ok: boolean; message?: string; value?: { pixels: Uint8Array } };
          renderGpu(
            w: number,
            h: number,
            cam: { zoom: number; x: number; y: number; dpr: number },
            bg: readonly [number, number, number, number],
            moving: boolean,
            budgetMs: number,
          ): { ok: boolean; message?: string };
          gpuPixels(): Promise<{ ok: boolean; message?: string; value?: Uint8Array }>;
          spikeVelloComputeReset(): void;
          spikeVelloComputeRender(
            w: number,
            h: number,
            cam: { zoom: number; x: number; y: number; dpr: number },
            bg: readonly [number, number, number, number],
            aaMode: 0 | 1,
          ): { ok: boolean; message?: string };
          spikeVelloComputePixels(): Promise<{ ok: boolean; message?: string; value?: Uint8Array }>;
          spikeVelloComputeStats(): Promise<{
            ok: boolean;
            message?: string;
            value?: Record<string, unknown>;
          }>;
        };
        const view = (window as unknown as { drawpaneEngineView?: { engine: ParityEngine } })
          .drawpaneEngineView;
        const gpu = view?.engine?.gpu;
        if (!view || !gpu) throw new Error("drawpaneEngineView GPU not attached");
        const engine = view.engine;
        const app = engine.apply(new Uint8Array(list));
        if (!app.ok) throw new Error(`apply failed: ${app.message}`);
        engine.spikeVelloComputeReset();

        // Exact mirror of @drawpane/engine/compare score() + CPU_GPU_TOLERANCE (computed in-page
        // on Uint8Arrays to avoid serializing tens of megabytes of pixels over CDP).
        const scoreInPage = (
          label: string,
          ours: Uint8Array,
          theirs: Uint8Array,
          width: number,
          height: number,
        ): ParityRow => {
          const n = width * height;
          const over = (rgba: Uint8Array, level: number) => {
            const out = new Float32Array(n * 3);
            for (let i = 0; i < n; i++) {
              const a = (rgba[i * 4 + 3] ?? 0) / 255;
              out[i * 3] = Math.round((rgba[i * 4] ?? 0) * a + level * (1 - a));
              out[i * 3 + 1] = Math.round((rgba[i * 4 + 1] ?? 0) * a + level * (1 - a));
              out[i * 3 + 2] = Math.round((rgba[i * 4 + 2] ?? 0) * a + level * (1 - a));
            }
            return out;
          };
          const bgs = [
            [over(ours, 255), over(theirs, 255)] as const,
            [over(ours, 0), over(theirs, 0)] as const,
          ];
          const tilesX = Math.ceil(width / 32);
          const tilesY = Math.ceil(height / 32);
          const tileSum = new Float64Array(tilesX * tilesY * 2);
          const tileCount = new Uint32Array(tilesX * tilesY);
          const tileSevere = new Uint32Array(tilesX * tilesY);
          const hists = [new Uint32Array(256), new Uint32Array(256)];
          const sums = [0, 0];
          let max = 0;
          let severe = 0;
          for (let i = 0; i < n; i++) {
            const tile =
              Math.floor(Math.floor(i / width) / 32) * tilesX + Math.floor((i % width) / 32);
            tileCount[tile] = (tileCount[tile] ?? 0) + 1;
            let worst = Math.abs((ours[i * 4 + 3] ?? 0) - (theirs[i * 4 + 3] ?? 0));
            for (let b = 0; b < 2; b++) {
              const pair = bgs[b];
              if (!pair) continue;
              const [a, t] = pair;
              const dr = Math.abs((a[i * 3] ?? 0) - (t[i * 3] ?? 0));
              const dg = Math.abs((a[i * 3 + 1] ?? 0) - (t[i * 3 + 1] ?? 0));
              const db = Math.abs((a[i * 3 + 2] ?? 0) - (t[i * 3 + 2] ?? 0));
              const m = (dr + dg + db) / 3;
              sums[b] = (sums[b] ?? 0) + m;
              tileSum[tile * 2 + b] = (tileSum[tile * 2 + b] ?? 0) + m;
              const d = Math.max(dr, dg, db);
              const h = hists[b];
              if (h) h[d] = (h[d] ?? 0) + 1;
              if (d > worst) worst = d;
            }
            if (worst > max) max = worst;
            if (worst > 16) {
              severe++;
              tileSevere[tile] = (tileSevere[tile] ?? 0) + 1;
            }
          }
          const p99Of = (h: Uint32Array) => {
            const at = Math.floor(n * 0.99);
            for (let v = 0, seen = 0; v < 256; v++) {
              seen += h[v] ?? 0;
              if (seen > at) return v;
            }
            return 255;
          };
          let worstTile = 0;
          let severeInTile = 0;
          for (let t = 0; t < tilesX * tilesY; t++) {
            const cnt = tileCount[t] ?? 1;
            const m = Math.max((tileSum[t * 2] ?? 0) / cnt, (tileSum[t * 2 + 1] ?? 0) / cnt);
            if (m > worstTile) worstTile = m;
            severeInTile = Math.max(severeInTile, tileSevere[t] ?? 0);
          }
          const mean = Math.max(sums[0] ?? 0, sums[1] ?? 0) / n;
          const p99 = Math.max(p99Of(hists[0] as Uint32Array), p99Of(hists[1] as Uint32Array));
          const outside: string[] = [];
          if (mean > 0.25) outside.push(`mean ${mean.toFixed(3)} > 0.25`);
          if (p99 > 4) outside.push(`p99 ${p99} > 4`);
          if (worstTile > 2) outside.push(`worst tile ${worstTile.toFixed(2)} > 2`);
          if (severeInTile > 4) outside.push(`${severeInTile} severe pixels in one tile > 4`);
          return {
            label,
            mean: Math.round(mean * 10000) / 10000,
            p99,
            max,
            worstTile: Math.round(worstTile * 1000) / 1000,
            severe,
            severeInTile,
            outside,
          };
        };

        const w = 512;
        const h = 512;
        const rows: ParityRow[] = [];
        const bumpFailed: Array<{ zoom: number; failed: number }> = [];
        let firstArea: Uint8Array | null = null;
        let zoomDeltaMean = 0;
        for (const zoom of [1.0, 1.73]) {
          const cam = { zoom, x: zoom === 1 ? 0 : -110, y: zoom === 1 ? 0 : -80, dpr: 1 };
          const cpuR = engine.renderCpu(w, h, cam, bg, false);
          if (!cpuR.ok || !cpuR.value) throw new Error(`renderCpu failed: ${cpuR.message}`);
          const cpu = cpuR.value.pixels;

          engine.clearTiles();
          const mgR = engine.renderGpu(w, h, cam, bg, false, 0);
          if (!mgR.ok) throw new Error(`renderGpu failed: ${mgR.message}`);
          const mgPx = await engine.gpuPixels();
          if (!mgPx.ok || !mgPx.value) throw new Error(`gpuPixels failed: ${mgPx.message}`);

          const saR = engine.spikeVelloComputeRender(w, h, cam, bg, 0);
          if (!saR.ok) throw new Error(`spike area failed: ${saR.message}`);
          const saPx = await engine.spikeVelloComputePixels();
          if (!saPx.ok || !saPx.value) throw new Error(`spike area px failed: ${saPx.message}`);

          const stR = await engine.spikeVelloComputeStats();
          if (!stR.ok || !stR.value) throw new Error(`spike stats failed: ${stR.message}`);
          bumpFailed.push({
            zoom,
            failed: (stR.value as { bump: { failed: number } }).bump.failed,
          });

          const smR = engine.spikeVelloComputeRender(w, h, cam, bg, 1);
          if (!smR.ok) throw new Error(`spike msaa16 failed: ${smR.message}`);
          const smPx = await engine.spikeVelloComputePixels();
          if (!smPx.ok || !smPx.value) throw new Error(`spike msaa px failed: ${smPx.message}`);

          rows.push(scoreInPage(`main vello_gpu @${zoom}x`, mgPx.value, cpu, w, h));
          rows.push(scoreInPage(`spike vello_compute Area @${zoom}x`, saPx.value, cpu, w, h));
          rows.push(scoreInPage(`spike vello_compute Msaa16 @${zoom}x`, smPx.value, cpu, w, h));

          if (!firstArea) {
            firstArea = new Uint8Array(saPx.value);
          } else {
            zoomDeltaMean = scoreInPage("zoom-delta", saPx.value, firstArea, w, h).mean;
          }
        }
        return {
          adapter: gpu.adapter,
          fallback: gpu.fallback,
          rows,
          bumpFailed,
          zoomDeltaMean,
        };
      },
      { list, bg: BG },
    );

    console.log(
      `\nSynthetic Stroke + AA Parity (adapter: ${res.adapter}, fallback=${res.fallback}, zoomDeltaMean=${res.zoomDeltaMean}):`,
    );
    for (const r of res.rows) {
      console.log(
        `  ${r.label.padEnd(36)} mean=${r.mean.toFixed(4)} p99=${r.p99} max=${r.max} worstTile=${r.worstTile.toFixed(3)} severe=${r.severe} severeInTile=${r.severeInTile} ${r.outside.length ? `OUTSIDE(${r.outside.join(", ")})` : "PASS"}`,
      );
    }
    test.info().annotations.push({
      type: "bench",
      description: JSON.stringify({
        kind: "synthetic-parity",
        adapter: res.adapter,
        zoomDeltaMean: res.zoomDeltaMean,
        rows: res.rows,
      }),
    });

    for (const b of res.bumpFailed) {
      expect(b.failed, `bump allocator failed at zoom ${b.zoom}`).toBe(0);
    }
    expect(
      res.zoomDeltaMean,
      "spike GPU view transform must change pixels across zooms",
    ).toBeGreaterThan(5);
  });

  for (const layers of SIZES) {
    test(`${layers.toLocaleString("en")} layers exact zoom (main vs vello compute spike)`, async () => {
      test.setTimeout(1_800_000);
      const kit = generateKit({ layers });
      const nodes = NO_EFFECTS
        ? kit.nodes.map((n) => {
            if (!("effects" in n.props)) return n;
            const { effects: _effects, ...props } = n.props as Record<string, unknown>;
            return { ...n, props } as NodeRecord;
          })
        : kit.nodes;
      const largest = largestPage(nodes);
      const chunks: string[] = [];
      for (let i = 0; i < nodes.length; i += CHUNK) {
        chunks.push(JSON.stringify(nodes.slice(i, i + CHUNK)));
      }

      const page = instance.page;
      await page.route("**/__corpus/*", (route) =>
        route.fulfill({
          contentType: "application/json",
          body: chunks[Number(route.request().url().split("/").pop())] ?? "[]",
        }),
      );

      await openEditorWithEngine(page);
      await loadChunks(page, chunks.length);
      const open = await opening(page, largest.id);
      await page.waitForFunction(
        () => {
          const v = (
            window as unknown as {
              drawpaneEngineView?: { engine?: { records: number; gpu?: unknown } };
            }
          ).drawpaneEngineView;
          return Boolean(v?.engine?.gpu && v.engine.records > 0);
        },
        undefined,
        { timeout: 30_000 },
      );
      await page.waitForTimeout(1000);

      // Run the controlled exact-zoom benchmark directly against the live RenderEngine holding
      // the real display list + real font glyph outlines for `largest.id`.
      const bench = await page.evaluate(
        async ({
          pageId,
          zoomFrames,
          bg,
          allowSoftware,
          runParity,
        }: {
          pageId: string;
          zoomFrames: number;
          bg: [number, number, number, number];
          allowSoftware: boolean;
          runParity: boolean;
        }) => {
          type RenderEngineLike = {
            readonly records: number;
            readonly gpu: {
              adapter: string;
              backend: string;
              fallback: boolean;
              details: string;
            } | null;
            clearTiles(): void;
            renderGpu(
              w: number,
              h: number,
              cam: { zoom: number; x: number; y: number; dpr: number },
              bg: readonly [number, number, number, number],
              moving: boolean,
              budgetMs: number,
            ): {
              ok: boolean;
              message?: string;
              value?: {
                exact: boolean;
                records: number;
                ms: { encode: number; render: number; submit: number; total: number };
              };
            };
            renderCpu(
              w: number,
              h: number,
              cam: { zoom: number; x: number; y: number; dpr: number },
              bg: readonly [number, number, number, number],
              detail: boolean,
            ): { ok: boolean; message?: string; value?: { pixels: Uint8Array } };
            gpuFinished(): Promise<{ ok: boolean; message?: string }>;
            gpuPixels(): Promise<{ ok: boolean; message?: string; value?: Uint8Array }>;
            spikeVelloComputeReset(): void;
            spikeVelloComputeRender(
              w: number,
              h: number,
              cam: { zoom: number; x: number; y: number; dpr: number },
              bg: readonly [number, number, number, number],
              aaMode: 0 | 1,
            ): {
              ok: boolean;
              message?: string;
              value?: {
                records: number;
                glyphsOutlined: number;
                ms: { encode: number; render: number; submit: number; total: number };
              };
            };
            spikeVelloComputePixels(): Promise<{
              ok: boolean;
              message?: string;
              value?: Uint8Array;
            }>;
            spikeVelloComputeStats(): Promise<{
              ok: boolean;
              message?: string;
              value?: Record<string, unknown>;
            }>;
          };

          const w = window as unknown as {
            drawpane: {
              doc: { childIds(id: string): string[] };
              scene: {
                extent(id: string): { x: number; y: number; width: number; height: number } | null;
              };
            };
            drawpaneEngineView?: { engine: RenderEngineLike };
          };
          const view = w.drawpaneEngineView;
          if (!view) throw new Error("drawpaneEngineView not attached");
          const engine = view.engine;
          if (!engine.gpu) throw new Error("engine has no GPU attached");
          if (engine.gpu.backend !== "webgpu") {
            throw new Error(`expected webgpu backend, got ${engine.gpu.backend}`);
          }
          if (!allowSoftware && engine.gpu.fallback) {
            throw new Error(`refusing software adapter: ${engine.gpu.adapter}`);
          }

          // Compute page bounding box and first board bounding box (exact same views as scale.spec.ts).
          const top = w.drawpane.doc.childIds(pageId);
          let x0 = Infinity;
          let y0 = Infinity;
          let x1 = -Infinity;
          let y1 = -Infinity;
          for (const id of top) {
            const e = w.drawpane.scene.extent(id);
            if (!e) continue;
            x0 = Math.min(x0, e.x);
            y0 = Math.min(y0, e.y);
            x1 = Math.max(x1, e.x + e.width);
            y1 = Math.max(y1, e.y + e.height);
          }
          const firstId = top[0];
          const firstBoard = (firstId ? w.drawpane.scene.extent(firstId) : null) ?? {
            x: x0,
            y: y0,
            width: 1440,
            height: 900,
          };
          const pageW = Math.max(1, x1 - x0);
          const pageH = Math.max(1, y1 - y0);
          const fitZoom = Math.min(1440 / pageW, 900 / pageH);

          const makeCam = (
            vw: number,
            vh: number,
            dpr: number,
            cx: number,
            cy: number,
            zoom: number,
          ) => ({
            zoom,
            x: vw / (2 * dpr) - cx * zoom,
            y: vh / (2 * dpr) - cy * zoom,
            dpr,
          });

          const pct = (xs: number[], p: number) => {
            const s = [...xs].sort((a, b) => a - b);
            return (
              Math.round((s[Math.min(s.length - 1, Math.floor(s.length * p))] ?? 0) * 100) / 100
            );
          };
          const summarize = (
            rows: Array<{
              cpu: number;
              enc: number;
              ren: number;
              sub: number;
              gpu: number;
              tot: number;
            }>,
          ): SweepStats => ({
            frames: rows.length,
            cpuMedianMs: pct(
              rows.map((r) => r.cpu),
              0.5,
            ),
            cpuP95Ms: pct(
              rows.map((r) => r.cpu),
              0.95,
            ),
            encodeMedianMs: pct(
              rows.map((r) => r.enc),
              0.5,
            ),
            renderMedianMs: pct(
              rows.map((r) => r.ren),
              0.5,
            ),
            submitMedianMs: pct(
              rows.map((r) => r.sub),
              0.5,
            ),
            gpuWaitMedianMs: pct(
              rows.map((r) => r.gpu),
              0.5,
            ),
            totalMedianMs: pct(
              rows.map((r) => r.tot),
              0.5,
            ),
            totalP95Ms: pct(
              rows.map((r) => r.tot),
              0.95,
            ),
            totalMinMs: pct(
              rows.map((r) => r.tot),
              0,
            ),
            totalMaxMs: pct(
              rows.map((r) => r.tot),
              1,
            ),
          });

          const zoomSweep = (
            vw: number,
            vh: number,
            dpr: number,
            cx: number,
            cy: number,
            baseZoom: number,
            n: number,
          ) =>
            Array.from({ length: n }, (_, i) => {
              const t = n <= 1 ? 0.5 : i / (n - 1);
              // Strictly distinct scale every frame, sweeping from 0.72x to 1.38x of baseZoom.
              const z = baseZoom * (0.72 + t * 0.66);
              return makeCam(vw, vh, dpr, cx, cy, z);
            });

          const runMainSweep = async (
            vw: number,
            vh: number,
            cams: Array<{ zoom: number; x: number; y: number; dpr: number }>,
          ) => {
            // 1 warmup frame
            const firstCam = cams[0];
            if (!firstCam) throw new Error("empty zoom sweep");
            engine.clearTiles();
            const w0 = engine.renderGpu(vw, vh, firstCam, bg, false, 0);
            if (!w0.ok) throw new Error(`main warmup failed: ${w0.message}`);
            const wf = await engine.gpuFinished();
            if (!wf.ok) throw new Error(`main warmup gpuFinished failed: ${wf.message}`);

            const rows = [];
            for (const cam of cams) {
              engine.clearTiles();
              const t0 = performance.now();
              const r = engine.renderGpu(vw, vh, cam, bg, false, 0);
              const cpuWall = performance.now() - t0;
              if (!r.ok || !r.value) throw new Error(`main renderGpu failed: ${r.message}`);
              const fin = await engine.gpuFinished();
              const totWall = performance.now() - t0;
              if (!fin.ok) throw new Error(`main gpuFinished failed: ${fin.message}`);
              rows.push({
                cpu: cpuWall,
                enc: r.value.ms.encode,
                ren: r.value.ms.render,
                sub: r.value.ms.submit,
                gpu: Math.max(0, totWall - cpuWall),
                tot: totWall,
              });
            }
            return summarize(rows);
          };

          const runSpikeSweep = async (
            vw: number,
            vh: number,
            cams: Array<{ zoom: number; x: number; y: number; dpr: number }>,
            aaMode: 0 | 1,
          ) => {
            // 3 warmup frames (ensure shader JIT & caches are warm; scene already uploaded)
            for (let k = 0; k < 3; k++) {
              const wc = cams[k % cams.length];
              if (!wc) throw new Error("empty zoom sweep");
              const wr = engine.spikeVelloComputeRender(vw, vh, wc, bg, aaMode);
              if (!wr.ok) throw new Error(`spike warmup failed: ${wr.message}`);
              const wf = await engine.gpuFinished();
              if (!wf.ok) throw new Error(`spike warmup gpuFinished failed: ${wf.message}`);
            }
            const rows = [];
            for (const cam of cams) {
              const t0 = performance.now();
              const r = engine.spikeVelloComputeRender(vw, vh, cam, bg, aaMode);
              const cpuWall = performance.now() - t0;
              if (!r.ok || !r.value) throw new Error(`spike render failed: ${r.message}`);
              const fin = await engine.gpuFinished();
              const totWall = performance.now() - t0;
              if (!fin.ok) throw new Error(`spike gpuFinished failed: ${fin.message}`);
              rows.push({
                cpu: cpuWall,
                enc: r.value.ms.encode,
                ren: r.value.ms.render,
                sub: r.value.ms.submit,
                gpu: Math.max(0, totWall - cpuWall),
                tot: totWall,
              });
            }
            const stRes = await engine.spikeVelloComputeStats();
            if (!stRes.ok || !stRes.value) {
              throw new Error(`spike stats failed: ${stRes.message}`);
            }
            return { stats: summarize(rows), gpuStats: stRes.value };
          };

          const fitCx = (x0 + x1) / 2;
          const fitCy = (y0 + y1) / 2;
          const closeCx = firstBoard.x + Math.min(firstBoard.width / 2, 720);
          const closeCy = firstBoard.y + Math.min(firstBoard.height / 2, 450);

          // 1. Measure cold scene encode + upload + first frame.
          engine.spikeVelloComputeReset();
          const fitCam0 = makeCam(1440, 900, 1, fitCx, fitCy, fitZoom);
          const tCold = performance.now();
          const coldR = engine.spikeVelloComputeRender(1440, 900, fitCam0, bg, 0);
          const coldCpuMs = performance.now() - tCold;
          if (!coldR.ok || !coldR.value) throw new Error(`cold spike failed: ${coldR.message}`);
          const coldFin = await engine.gpuFinished();
          const coldTotalMs = performance.now() - tCold;
          if (!coldFin.ok) throw new Error(`cold spike gpuFinished failed: ${coldFin.message}`);
          const coldStatsRes = await engine.spikeVelloComputeStats();
          if (!coldStatsRes.ok || !coldStatsRes.value) {
            throw new Error(`cold stats failed: ${coldStatsRes.message}`);
          }

          // 2. Fit-all exact zoom sweep at 1440x900 @1x (EVERY layer in view).
          const mainN =
            engine.records > 20_000 ? Math.min(8, zoomFrames) : Math.min(16, zoomFrames);
          const fitCams = zoomSweep(1440, 900, 1, fitCx, fitCy, fitZoom, zoomFrames);
          const mainFit = await runMainSweep(1440, 900, fitCams.slice(0, mainN));
          const spikeFitArea = await runSpikeSweep(1440, 900, fitCams, 0);
          const spikeFitMsaa = await runSpikeSweep(1440, 900, fitCams, 1);

          // 3. 100% zoomed-in exact zoom sweep at 1440x900 @1x.
          const closeCams = zoomSweep(1440, 900, 1, closeCx, closeCy, 1.0, zoomFrames);
          const mainClose = await runMainSweep(1440, 900, closeCams.slice(0, mainN));
          const spikeCloseArea = await runSpikeSweep(1440, 900, closeCams, 0);
          const spikeCloseMsaa = await runSpikeSweep(1440, 900, closeCams, 1);

          // 4. Retina 2x (2880x1800) fit-all and 100% sweeps on 10k-class pages.
          let retina2x: {
            main: SweepStats;
            spikeArea: SweepStats;
            spikeMsaa16: SweepStats;
            gpuStats: Record<string, unknown>;
            closeMain: SweepStats;
            closeSpikeArea: SweepStats;
            closeSpikeMsaa16: SweepStats;
          } | null = null;
          if (runParity) {
            const retCams = zoomSweep(
              2880,
              1800,
              2,
              fitCx,
              fitCy,
              fitZoom,
              Math.min(16, zoomFrames),
            );
            const mainRet = await runMainSweep(
              2880,
              1800,
              retCams.slice(0, Math.min(8, retCams.length)),
            );
            const spAreaRet = await runSpikeSweep(2880, 1800, retCams, 0);
            const spMsaaRet = await runSpikeSweep(2880, 1800, retCams, 1);

            const retCloseCams = zoomSweep(
              2880,
              1800,
              2,
              closeCx,
              closeCy,
              1.0,
              Math.min(16, zoomFrames),
            );
            const closeMainRet = await runMainSweep(
              2880,
              1800,
              retCloseCams.slice(0, Math.min(8, retCloseCams.length)),
            );
            const closeSpAreaRet = await runSpikeSweep(2880, 1800, retCloseCams, 0);
            const closeSpMsaaRet = await runSpikeSweep(2880, 1800, retCloseCams, 1);
            retina2x = {
              main: mainRet,
              spikeArea: spAreaRet.stats,
              spikeMsaa16: spMsaaRet.stats,
              gpuStats: spAreaRet.gpuStats,
              closeMain: closeMainRet,
              closeSpikeArea: closeSpAreaRet.stats,
              closeSpikeMsaa16: closeSpMsaaRet.stats,
            };
          }

          // 5. Pixel verification & in-page CPU parity (computed directly on Uint8Arrays, no huge CDP JSON).
          const parityRows: ParityRow[] = [];
          const scoreInPage = (
            label: string,
            ours: Uint8Array,
            theirs: Uint8Array,
            width: number,
            height: number,
          ): ParityRow => {
            const n = width * height;
            const over = (rgba: Uint8Array, level: number) => {
              const out = new Float32Array(n * 3);
              for (let i = 0; i < n; i++) {
                const a = (rgba[i * 4 + 3] ?? 0) / 255;
                out[i * 3] = Math.round((rgba[i * 4] ?? 0) * a + level * (1 - a));
                out[i * 3 + 1] = Math.round((rgba[i * 4 + 1] ?? 0) * a + level * (1 - a));
                out[i * 3 + 2] = Math.round((rgba[i * 4 + 2] ?? 0) * a + level * (1 - a));
              }
              return out;
            };
            const bgs = [
              [over(ours, 255), over(theirs, 255)] as const,
              [over(ours, 0), over(theirs, 0)] as const,
            ];
            const tilesX = Math.ceil(width / 32);
            const tilesY = Math.ceil(height / 32);
            const tileSum = new Float64Array(tilesX * tilesY * 2);
            const tileCount = new Uint32Array(tilesX * tilesY);
            const tileSevere = new Uint32Array(tilesX * tilesY);
            const hists = [new Uint32Array(256), new Uint32Array(256)];
            const sums = [0, 0];
            let max = 0;
            let severe = 0;
            for (let i = 0; i < n; i++) {
              const tile =
                Math.floor(Math.floor(i / width) / 32) * tilesX + Math.floor((i % width) / 32);
              tileCount[tile] = (tileCount[tile] ?? 0) + 1;
              let worst = Math.abs((ours[i * 4 + 3] ?? 0) - (theirs[i * 4 + 3] ?? 0));
              for (let b = 0; b < 2; b++) {
                const pair = bgs[b];
                if (!pair) continue;
                const [a, t] = pair;
                const dr = Math.abs((a[i * 3] ?? 0) - (t[i * 3] ?? 0));
                const dg = Math.abs((a[i * 3 + 1] ?? 0) - (t[i * 3 + 1] ?? 0));
                const db = Math.abs((a[i * 3 + 2] ?? 0) - (t[i * 3 + 2] ?? 0));
                const m = (dr + dg + db) / 3;
                sums[b] = (sums[b] ?? 0) + m;
                tileSum[tile * 2 + b] = (tileSum[tile * 2 + b] ?? 0) + m;
                const d = Math.max(dr, dg, db);
                const h = hists[b];
                if (h) h[d] = (h[d] ?? 0) + 1;
                if (d > worst) worst = d;
              }
              if (worst > max) max = worst;
              if (worst > 16) {
                severe++;
                tileSevere[tile] = (tileSevere[tile] ?? 0) + 1;
              }
            }
            const p99Of = (h: Uint32Array) => {
              const at = Math.floor(n * 0.99);
              for (let v = 0, seen = 0; v < 256; v++) {
                seen += h[v] ?? 0;
                if (seen > at) return v;
              }
              return 255;
            };
            let worstTile = 0;
            let severeInTile = 0;
            for (let t = 0; t < tilesX * tilesY; t++) {
              const cnt = tileCount[t] ?? 1;
              const m = Math.max((tileSum[t * 2] ?? 0) / cnt, (tileSum[t * 2 + 1] ?? 0) / cnt);
              if (m > worstTile) worstTile = m;
              severeInTile = Math.max(severeInTile, tileSevere[t] ?? 0);
            }
            const mean = Math.max(sums[0] ?? 0, sums[1] ?? 0) / n;
            const p99 = Math.max(p99Of(hists[0] as Uint32Array), p99Of(hists[1] as Uint32Array));
            const outside: string[] = [];
            if (mean > 0.25) outside.push(`mean ${mean.toFixed(3)} > 0.25`);
            if (p99 > 4) outside.push(`p99 ${p99} > 4`);
            if (worstTile > 2) outside.push(`worst tile ${worstTile.toFixed(2)} > 2`);
            if (severeInTile > 4) outside.push(`${severeInTile} severe pixels in one tile > 4`);
            return {
              label,
              mean: Math.round(mean * 10000) / 10000,
              p99,
              max,
              worstTile: Math.round(worstTile * 1000) / 1000,
              severe,
              severeInTile,
              outside,
            };
          };

          // Quick non-blank + zoom-change check on EVERY page size (even 40k).
          const checkCamA = makeCam(1440, 900, 1, fitCx, fitCy, fitZoom);
          const checkCamB = makeCam(1440, 900, 1, fitCx, fitCy, fitZoom * 1.28);
          engine.spikeVelloComputeRender(1440, 900, checkCamA, bg, 0);
          const pxARes = await engine.spikeVelloComputePixels();
          engine.spikeVelloComputeRender(1440, 900, checkCamB, bg, 0);
          const pxBRes = await engine.spikeVelloComputePixels();
          if (!pxARes.ok || !pxARes.value || !pxBRes.ok || !pxBRes.value) {
            throw new Error("spike pixel check failed");
          }
          const pxA = pxARes.value;
          const pxB = pxBRes.value;
          let nonBg = 0;
          let changed = 0;
          const bgR = Math.round(bg[0] * 255);
          const bgG = Math.round(bg[1] * 255);
          const bgB = Math.round(bg[2] * 255);
          const totalPx = 1440 * 900;
          for (let i = 0; i < totalPx; i++) {
            const j = i * 4;
            const dBg =
              Math.abs((pxA[j] ?? 0) - bgR) +
              Math.abs((pxA[j + 1] ?? 0) - bgG) +
              Math.abs((pxA[j + 2] ?? 0) - bgB);
            if (dBg > 12) nonBg++;
            const dZ =
              Math.abs((pxA[j] ?? 0) - (pxB[j] ?? 0)) +
              Math.abs((pxA[j + 1] ?? 0) - (pxB[j + 1] ?? 0)) +
              Math.abs((pxA[j + 2] ?? 0) - (pxB[j + 2] ?? 0));
            if (dZ > 12) changed++;
          }
          const nonBackgroundRatio = Math.round((nonBg / totalPx) * 10000) / 10000;
          const zoomDeltaNonZero = changed / totalPx > 0.01;

          if (runParity) {
            const runParityView = async (
              viewName: string,
              cx: number,
              cy: number,
              zoom: number,
            ) => {
              const pw = 960;
              const ph = 600;
              const c = makeCam(pw, ph, 1, cx, cy, zoom);
              const cpuR = engine.renderCpu(pw, ph, c, bg, false);
              if (!cpuR.ok || !cpuR.value) throw new Error(`renderCpu failed: ${cpuR.message}`);
              const cpu = cpuR.value.pixels;
              engine.clearTiles();
              const mgR = engine.renderGpu(pw, ph, c, bg, false, 0);
              if (!mgR.ok) throw new Error(`renderGpu parity failed: ${mgR.message}`);
              const mgPx = await engine.gpuPixels();
              if (!mgPx.ok || !mgPx.value) throw new Error(`gpuPixels failed: ${mgPx.message}`);
              const saR = engine.spikeVelloComputeRender(pw, ph, c, bg, 0);
              if (!saR.ok) throw new Error(`spike area parity failed: ${saR.message}`);
              const saPx = await engine.spikeVelloComputePixels();
              if (!saPx.ok || !saPx.value) throw new Error("spike area pixels failed");
              const smR = engine.spikeVelloComputeRender(pw, ph, c, bg, 1);
              if (!smR.ok) throw new Error(`spike msaa parity failed: ${smR.message}`);
              const smPx = await engine.spikeVelloComputePixels();
              if (!smPx.ok || !smPx.value) throw new Error("spike msaa pixels failed");
              parityRows.push(scoreInPage(`${viewName} main vello_gpu`, mgPx.value, cpu, pw, ph));
              parityRows.push(scoreInPage(`${viewName} spike Area`, saPx.value, cpu, pw, ph));
              parityRows.push(scoreInPage(`${viewName} spike Msaa16`, smPx.value, cpu, pw, ph));
            };
            await runParityView("fit-all", fitCx, fitCy, fitZoom * (960 / 1440));
            await runParityView("100%", closeCx, closeCy, 1.0);
          }

          return {
            adapter: engine.gpu.adapter,
            fallback: engine.gpu.fallback,
            records: engine.records,
            fitZoom: Math.round(fitZoom * 10000) / 10000,
            cold: {
              cpuMs: Math.round(coldCpuMs * 100) / 100,
              totalMs: Math.round(coldTotalMs * 100) / 100,
              encodeMs: Math.round(coldR.value.ms.encode * 100) / 100,
              gpuStats: coldStatsRes.value,
            },
            fit1x: {
              main: mainFit,
              spikeArea: spikeFitArea.stats,
              spikeMsaa16: spikeFitMsaa.stats,
              gpuStats: spikeFitArea.gpuStats,
            },
            close1x: {
              main: mainClose,
              spikeArea: spikeCloseArea.stats,
              spikeMsaa16: spikeCloseMsaa.stats,
              gpuStats: spikeCloseArea.gpuStats,
            },
            retina2x,
            parityRows,
            nonBackgroundRatio,
            zoomDeltaNonZero,
          };
        },
        {
          pageId: largest.id,
          zoomFrames: ZOOM_FRAMES,
          bg: BG,
          allowSoftware: process.env.BENCH_ALLOW_SOFTWARE === "1",
          runParity: layers <= 20_000,
        },
      );

      const parityRows = bench.parityRows;

      const fmtSweep = (name: string, s: SweepStats) =>
        `  ${name.padEnd(28)} total=${s.totalMedianMs.toFixed(2)} ms (p95 ${s.totalP95Ms.toFixed(2)}) | cpu=${s.cpuMedianMs.toFixed(2)} ms (enc ${s.encodeMedianMs.toFixed(2)}, sub ${s.submitMedianMs.toFixed(2)}) | gpuWait=${s.gpuWaitMedianMs.toFixed(2)} ms`;

      const lines = [
        `\n=== WebGPU Exact Zoom Spike: kit=${layers.toLocaleString("en")} layers, largest page=${largest.layers.toLocaleString("en")} layers, engine records=${bench.records.toLocaleString("en")} ===`,
        `Adapter: ${bench.adapter} (fallback=${bench.fallback}) | fitZoom=${bench.fitZoom} | openExact=${open.exactAny} ms`,
        `Cold scene encode+upload+1st frame: total=${bench.cold.totalMs} ms (cpu=${bench.cold.cpuMs} ms, encode+upload=${bench.cold.encodeMs} ms)`,
        `Scene meta: ${JSON.stringify((bench.cold.gpuStats as { scene: unknown }).scene)}`,
        `Capacities: ${JSON.stringify((bench.cold.gpuStats as { capacities: unknown }).capacities)}`,
        `--- Fit-all exact zoom (1440x900 @1x, all ${largest.layers.toLocaleString("en")} layers in view) ---`,
        fmtSweep("main (vello_gpu 0.4)", bench.fit1x.main),
        fmtSweep("spike Area (vello 0.12)", bench.fit1x.spikeArea),
        fmtSweep("spike Msaa16 (vello 0.12)", bench.fit1x.spikeMsaa16),
        `  fit bump usage: ${JSON.stringify((bench.fit1x.gpuStats as { bump: unknown }).bump)}`,
        `--- 100% zoomed-in exact zoom (1440x900 @1x) ---`,
        fmtSweep("main (vello_gpu 0.4)", bench.close1x.main),
        fmtSweep("spike Area (vello 0.12)", bench.close1x.spikeArea),
        fmtSweep("spike Msaa16 (vello 0.12)", bench.close1x.spikeMsaa16),
        `  100% bump usage: ${JSON.stringify((bench.close1x.gpuStats as { bump: unknown }).bump)}`,
      ];
      if (bench.retina2x) {
        lines.push(`--- Retina 2x fit-all exact zoom (2880x1800 @2x) ---`);
        lines.push(fmtSweep("main (vello_gpu 0.4)", bench.retina2x.main));
        lines.push(fmtSweep("spike Area (vello 0.12)", bench.retina2x.spikeArea));
        lines.push(fmtSweep("spike Msaa16 (vello 0.12)", bench.retina2x.spikeMsaa16));
        lines.push(
          `  2x fit bump usage: ${JSON.stringify((bench.retina2x.gpuStats as { bump: unknown }).bump)}`,
        );
        lines.push(`--- Retina 2x 100% zoomed-in exact zoom (2880x1800 @2x) ---`);
        lines.push(fmtSweep("main (vello_gpu 0.4)", bench.retina2x.closeMain));
        lines.push(fmtSweep("spike Area (vello 0.12)", bench.retina2x.closeSpikeArea));
        lines.push(fmtSweep("spike Msaa16 (vello 0.12)", bench.retina2x.closeSpikeMsaa16));
      }
      if (parityRows.length > 0) {
        lines.push(`--- CPU-reference pixel parity (960x600) ---`);
        for (const r of parityRows) {
          lines.push(
            `  ${r.label.padEnd(28)} mean=${r.mean.toFixed(4)} p99=${r.p99} max=${r.max} worstTile=${r.worstTile.toFixed(3)} severe=${r.severe} severeInTile=${r.severeInTile} ${r.outside.length ? `OUTSIDE(${r.outside.join(", ")})` : "PASS"}`,
          );
        }
      }
      lines.push(
        `Pixel check: nonBackgroundRatio=${bench.nonBackgroundRatio}, zoomDeltaNonZero=${bench.zoomDeltaNonZero}\n`,
      );
      console.log(lines.join("\n"));

      const report = {
        kind: "scale-zoom-spike",
        kitLayers: layers,
        pageLayers: largest.layers,
        records: bench.records,
        adapter: bench.adapter,
        fallback: bench.fallback,
        fitZoom: bench.fitZoom,
        cold: bench.cold,
        fit1x: bench.fit1x,
        close1x: bench.close1x,
        retina2x: bench.retina2x,
        parity: parityRows,
        nonBackgroundRatio: bench.nonBackgroundRatio,
        zoomDeltaNonZero: bench.zoomDeltaNonZero,
      };
      test.info().annotations.push({
        type: "bench",
        description: JSON.stringify(report),
      });

      await page.unroute("**/__corpus/*");

      // Verify bump allocator never overflowed and rendered output is non-blank & zoom-reactive.
      const coldBump = (bench.cold.gpuStats as { bump: { failed: number } }).bump;
      const fitBump = (bench.fit1x.gpuStats as { bump: { failed: number } }).bump;
      const closeBump = (bench.close1x.gpuStats as { bump: { failed: number } }).bump;
      expect(coldBump.failed, "cold spike bump allocator overflowed").toBe(0);
      expect(fitBump.failed, "fit-all spike bump allocator overflowed").toBe(0);
      expect(closeBump.failed, "100% spike bump allocator overflowed").toBe(0);
      expect(bench.nonBackgroundRatio, "spike output appears blank").toBeGreaterThan(0.01);
      expect(bench.zoomDeltaNonZero, "spike output did not change across zoom scales").toBe(true);
    });
  }
});
