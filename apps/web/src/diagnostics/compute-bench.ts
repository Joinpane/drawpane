/**
 * Standalone 10k-layer Retina 2x presented-frame benchmark for `/diagnostics/renderer`.
 *
 * Lets desktop Chrome and Safari users on Apple GPU verify the P0 compute kill-gate target
 * (GPU p95 <= 8 ms on a 10k-layer page at 100%, Retina 2x, 240 presented rAF frames, zero
 * bump-allocator failures) without needing a Playwright harness or API calls.
 */
import { type ComputeStats, RenderEngine, type StrokeCacheStats } from "@drawpane/engine";
import { loadBrowserEngine } from "@drawpane/engine/browser";
import { CAP, JOIN, ListWriter, PathData, ROOT } from "@drawpane/engine/wire";

export const P0_BENCH_WIDTH = 2880;
export const P0_BENCH_HEIGHT = 1800;
export const P0_BENCH_FRAMES = 240;
export const P0_LAPTOP_GPU_P95_TARGET_MS = 8;

export interface Quantiles {
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
}

export interface ComputeBenchReport {
  readonly adapter: string;
  readonly software: boolean;
  readonly presentationMode: "presented-canvas" | "offscreen-raf";
  readonly width: number;
  readonly height: number;
  readonly layers: number;
  readonly frames: number;
  readonly presentedFrames: number;
  readonly computeFrames: number;
  readonly timestampsSupported: boolean;
  readonly rafIntervalMs: Quantiles;
  readonly cpuMs: Quantiles;
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
  };
  readonly strokeCache: StrokeCacheStats | null;
  readonly scene: ComputeStats["scene"];
  readonly passLaptopTarget: boolean | null;
}

function quantiles(xs: readonly number[]): Quantiles {
  if (xs.length === 0) return { p50: 0, p95: 0, p99: 0, max: 0 };
  const s = [...xs].sort((a, b) => a - b);
  const at = (q: number) => Math.round((s[Math.floor(q * (s.length - 1))] ?? 0) * 100) / 100;
  return { p50: at(0.5), p95: at(0.95), p99: at(0.99), max: at(1) };
}

/**
 * Generates a deterministic 10,000-layer ordinary UI page (400 cards x 25 layers/card) with
 * fills, linear gradients, rounded rects, ellipses, cached stroked outlines, and geometric
 * glyph runs, requiring zero network fetches or external fonts.
 */
export function build10kOrdinaryScene(revision = 1): {
  readonly list: Uint8Array;
  readonly layers: number;
  readonly pageWidth: number;
  readonly pageHeight: number;
} {
  const w = new ListWriter(0xffffffff, revision);
  w.reset();

  // Register 4 lightweight geometric glyphs (font units, y up).
  w.glyph(
    1,
    new PathData()
      .moveTo(60, 0)
      .lineTo(380, 0)
      .cubicTo(540, 0, 640, 140, 640, 350)
      .cubicTo(640, 560, 540, 700, 380, 700)
      .lineTo(60, 700)
      .close()
      .moveTo(200, 140)
      .lineTo(200, 560)
      .lineTo(360, 560)
      .cubicTo(460, 560, 500, 480, 500, 350)
      .cubicTo(500, 220, 460, 140, 360, 140)
      .close(),
  );
  w.glyph(2, new PathData().moveTo(80, 0).lineTo(220, 0).lineTo(220, 700).lineTo(80, 700).close());
  w.glyph(
    3,
    new PathData()
      .moveTo(350, 0)
      .cubicTo(560, 0, 660, 150, 660, 350)
      .cubicTo(660, 550, 560, 700, 350, 700)
      .cubicTo(140, 700, 40, 550, 40, 350)
      .cubicTo(40, 150, 140, 0, 350, 0)
      .close()
      .moveTo(350, 130)
      .cubicTo(230, 130, 180, 220, 180, 350)
      .cubicTo(180, 480, 230, 570, 350, 570)
      .cubicTo(470, 570, 520, 480, 520, 350)
      .cubicTo(520, 220, 470, 130, 350, 130)
      .close(),
  );
  w.glyph(
    4,
    new PathData()
      .moveTo(60, 0)
      .lineTo(560, 0)
      .lineTo(560, 130)
      .lineTo(200, 130)
      .lineTo(200, 290)
      .lineTo(490, 290)
      .lineTo(490, 420)
      .lineTo(200, 420)
      .lineTo(200, 570)
      .lineTo(560, 570)
      .lineTo(560, 700)
      .lineTo(60, 700)
      .close(),
  );

  const cols = 20;
  const rows = 20;
  const cardW = 320;
  const cardH = 220;
  const gap = 24;
  let nextId = 1;
  let layers = 0;

  const spark = new PathData()
    .moveTo(0, 28)
    .cubicTo(24, 6, 48, 34, 72, 14)
    .cubicTo(96, 2, 120, 30, 144, 10)
    .cubicTo(168, 22, 192, 4, 220, 18);

  const palette: ReadonlyArray<readonly [number, number, number, number]> = [
    [0.16, 0.37, 0.88, 1],
    [0.05, 0.5, 0.48, 1],
    [0.88, 0.31, 0.1, 1],
    [0.45, 0.25, 0.82, 1],
  ];

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const idx = row * cols + col;
      const cx = col * (cardW + gap) + 32;
      const cy = row * (cardH + gap) + 32;
      const accent = palette[idx % palette.length] as readonly [number, number, number, number];
      const cardId = nextId++;
      layers++;

      // 1. Card container (clipped rounded rect with subtle border stroke).
      w.set(cardId, ROOT, {
        flags: 0,
        opacity: 1,
        transform: [1, 0, 0, 1, cx, cy],
        width: cardW,
        height: cardH,
        coarseBelow: 0,
        reach: 1,
        unsupported: 0,
        paths: [{ kind: "rect", w: cardW, h: cardH, radii: [12, 12, 12, 12], smoothing: 0 }],
        ops: [
          { op: "fill", path: 0, evenOdd: false, paint: { kind: "solid", color: [1, 1, 1, 1] } },
          { op: "clip", path: 0, evenOdd: false },
          { op: "children" },
          { op: "unclip" },
          {
            op: "stroke",
            path: 0,
            style: {
              width: 1,
              join: JOIN.miter,
              cap: CAP.butt,
              miter: 4,
              dashes: [],
              dashOffset: 0,
            },
            paint: { kind: "solid", color: [0.85, 0.85, 0.82, 1] },
          },
        ],
        coarse: [],
      });

      // 2. Header gradient banner.
      w.set(nextId++, cardId, {
        flags: 0,
        opacity: 1,
        transform: [1, 0, 0, 1, 14, 14],
        width: cardW - 28,
        height: 36,
        coarseBelow: 0,
        reach: 0,
        unsupported: 0,
        paths: [{ kind: "rect", w: cardW - 28, h: 36, radii: [8, 8, 8, 8], smoothing: 0 }],
        ops: [
          {
            op: "fill",
            path: 0,
            evenOdd: false,
            paint: {
              kind: "linear",
              matrix: [cardW - 28, 0, 0, 36, 0, 0],
              stops: [
                { position: 0, color: accent },
                { position: 1, color: [accent[0] * 0.65, accent[1] * 0.65, accent[2] * 0.65, 1] },
              ],
            },
          },
        ],
        coarse: [],
      });
      layers++;

      // 3. Stroked sparkline curve.
      w.set(nextId++, cardId, {
        flags: 0,
        opacity: 1,
        transform: [1, 0, 0, 1, 16, 62],
        width: 220,
        height: 36,
        coarseBelow: 0,
        reach: 2,
        unsupported: 0,
        paths: [{ kind: "path", path: spark }],
        ops: [
          {
            op: "stroke",
            path: 0,
            style: {
              width: 2,
              join: JOIN.round,
              cap: CAP.round,
              miter: 4,
              dashes: [],
              dashOffset: 0,
            },
            paint: { kind: "solid", color: accent },
          },
        ],
        coarse: [],
      });
      layers++;

      // 4. Two glyph run text layers (title + subtitle).
      for (let t = 0; t < 2; t++) {
        const glyphs: number[] = [];
        for (let g = 0; g < 12; g++) {
          glyphs.push(((idx + g + t) % 4) + 1, g * 10.5, 12);
        }
        w.set(nextId++, cardId, {
          flags: 0,
          opacity: 1,
          transform: [1, 0, 0, 1, 16, t === 0 ? 106 : 124],
          width: 200,
          height: 16,
          coarseBelow: 0,
          reach: 0,
          unsupported: 0,
          paths: [{ kind: "glyphs", scale: t === 0 ? 14 / 1000 : 11 / 1000, glyphs }],
          ops: [
            {
              op: "fill",
              path: 0,
              evenOdd: false,
              paint: {
                kind: "solid",
                color: t === 0 ? [0.11, 0.11, 0.1, 1] : [0.42, 0.42, 0.4, 1],
              },
            },
          ],
          coarse: [],
        });
        layers++;
      }

      // 5. 20 UI sub-elements (avatar circles, status pills, metric bars, stroked tags).
      for (let k = 0; k < 20; k++) {
        const subCol = k % 5;
        const subRow = Math.floor(k / 5);
        const sx = 14 + subCol * 59;
        const sy = 146 + subRow * 16;
        const isCircle = k % 5 === 0;
        const isStroked = k % 4 === 1;
        w.set(nextId++, cardId, {
          flags: 0,
          opacity: 1,
          transform: [1, 0, 0, 1, sx, sy],
          width: isCircle ? 12 : 52,
          height: 12,
          coarseBelow: 0,
          reach: isStroked ? 1 : 0,
          unsupported: 0,
          paths: [
            isCircle
              ? { kind: "ellipse", w: 12, h: 12 }
              : { kind: "rect", w: 52, h: 12, radii: [6, 6, 6, 6], smoothing: 0 },
          ],
          ops: [
            {
              op: "fill",
              path: 0,
              evenOdd: false,
              paint: {
                kind: "solid",
                color: k % 3 === 0 ? accent : [0.91, 0.91, 0.88, 1],
              },
            },
            ...(isStroked
              ? [
                  {
                    op: "stroke" as const,
                    path: 0,
                    style: {
                      width: 1,
                      join: JOIN.round,
                      cap: CAP.round,
                      miter: 4,
                      dashes: [],
                      dashOffset: 0,
                    },
                    paint: { kind: "solid" as const, color: [0.7, 0.7, 0.67, 1] as const },
                  },
                ]
              : []),
          ],
          coarse: [],
        });
        layers++;
      }
    }
  }

  return {
    list: w.finish(),
    layers,
    pageWidth: cols * (cardW + gap) + 64,
    pageHeight: rows * (cardH + gap) + 64,
  };
}

/**
 * Runs a 240-frame continuous zoom sweep around 100% zoom at Retina 2x (2880 x 1800) on a live
 * presented WebGPU canvas (falling back to offscreen rAF if canvas presentation is unavailable).
 */
export async function runP0RetinaBench(options: {
  readonly canvas: HTMLCanvasElement;
  readonly allowSoftware: boolean;
  readonly frames?: number;
  readonly onProgress?: (frame: number, total: number) => void;
}): Promise<ComputeBenchReport> {
  const frames = options.frames ?? P0_BENCH_FRAMES;
  const mod = await loadBrowserEngine();
  const engine = new RenderEngine(mod);
  try {
    options.canvas.width = P0_BENCH_WIDTH;
    options.canvas.height = P0_BENCH_HEIGHT;

    let presentationMode: "presented-canvas" | "offscreen-raf" = "presented-canvas";
    let attached = await engine.attachGpu(options.canvas, { compatibility: false });
    if (!attached.ok) {
      presentationMode = "offscreen-raf";
      attached = await engine.attachGpu(null, { compatibility: false });
    }
    if (!attached.ok) {
      throw new Error(`WebGPU Core unavailable: ${attached.message}`);
    }
    const software = attached.value.fallback;
    if (software && !options.allowSoftware) {
      throw new Error(`Refused software WebGPU adapter (${attached.value.adapter})`);
    }

    const enabled = engine.setComputeOrdinary(true);
    if (!enabled.ok) throw new Error(`setComputeOrdinary failed: ${enabled.message}`);

    const { list, layers, pageWidth, pageHeight } = build10kOrdinaryScene(1);
    const applied = engine.apply(list);
    if (!applied.ok) throw new Error(`apply failed: ${applied.message}`);

    const bg: [number, number, number, number] = [0.95, 0.95, 0.93, 1];
    const centerX = pageWidth * 0.5;
    const centerY = pageHeight * 0.5;
    const dpr = 2;
    const cssW = P0_BENCH_WIDTH / dpr;
    const cssH = P0_BENCH_HEIGHT / dpr;
    // Engine Camera::view maps page point p to (p * zoom + (x, y)) * dpr.
    const cameraAt = (zoom: number) => ({
      zoom,
      x: cssW * 0.5 - centerX * zoom,
      y: cssH * 0.5 - centerY * zoom,
      dpr,
    });

    // Warm up cold scene build, shader pipeline compilation, and stroke cache expansion.
    for (let i = 0; i < 3; i++) {
      const w = engine.renderGpu(
        P0_BENCH_WIDTH,
        P0_BENCH_HEIGHT,
        cameraAt(1 + i * 0.01),
        bg,
        false,
      );
      if (!w.ok) throw new Error(`warmup renderGpu failed: ${w.message}`);
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
    }
    const finWarm = await engine.gpuFinished();
    if (!finWarm.ok) throw new Error(`warmup gpuFinished failed: ${finWarm.message}`);

    engine.computeResetStats();

    const rafIntervals: number[] = [];
    const cpuSamples: number[] = [];
    let presentedFrames = 0;
    let computeFrames = 0;

    let prevRaf = await new Promise<number>((resolve) => requestAnimationFrame(resolve));
    for (let i = 0; i < frames; i++) {
      const nowRaf = await new Promise<number>((resolve) => requestAnimationFrame(resolve));
      rafIntervals.push(nowRaf - prevRaf);
      prevRaf = nowRaf;

      const phase = (i / Math.max(1, frames - 1)) * Math.PI * 4;
      const zoom = 1.0 + 0.22 * Math.sin(phase);
      const t0 = performance.now();
      const res = engine.renderGpu(P0_BENCH_WIDTH, P0_BENCH_HEIGHT, cameraAt(zoom), bg, false);
      const t1 = performance.now();
      if (!res.ok) throw new Error(`frame ${i} renderGpu failed: ${res.message}`);
      cpuSamples.push(t1 - t0);
      if (res.value.presented) presentedFrames++;
      if (engine.computeUsed()) computeFrames++;
      if (i % 16 === 0 || i === frames - 1) {
        options.onProgress?.(i + 1, frames);
      }
    }

    const fin = await engine.gpuFinished();
    if (!fin.ok) throw new Error(`gpuFinished failed: ${fin.message}`);
    const statsRes = await engine.computeStats();
    if (!statsRes.ok) throw new Error(`computeStats failed: ${statsRes.message}`);
    const stats = statsRes.value;
    const strokeRes = engine.strokeCacheStats();

    const gpuMs =
      stats.timestampsSupported && stats.gpuMs.length > 0 ? quantiles(stats.gpuMs) : null;
    const gpuSpanMs =
      stats.timestampsSupported && stats.gpuSpanMs.length > 0 ? quantiles(stats.gpuSpanMs) : null;

    const passLaptopTarget =
      gpuMs !== null
        ? gpuMs.p95 <= P0_LAPTOP_GPU_P95_TARGET_MS &&
          stats.failedFrames === 0 &&
          stats.framesChecked >= frames
        : null;

    return {
      adapter: attached.value.adapter,
      software,
      presentationMode: presentedFrames > 0 ? "presented-canvas" : presentationMode,
      width: P0_BENCH_WIDTH,
      height: P0_BENCH_HEIGHT,
      layers,
      frames,
      presentedFrames,
      computeFrames,
      timestampsSupported: stats.timestampsSupported,
      rafIntervalMs: quantiles(rafIntervals),
      cpuMs: quantiles(cpuSamples),
      gpuMs,
      gpuSpanMs,
      passAvgMs: stats.passAvgMs,
      bump: {
        framesSubmitted: stats.framesSubmitted,
        framesChecked: stats.framesChecked,
        failedFrames: stats.failedFrames,
        anyFailedMask: stats.anyFailedMask,
        maxLines: stats.maxBump.lines,
        maxSegments: stats.maxBump.segments,
        maxTile: stats.maxBump.tile,
        maxPtcl: stats.maxBump.ptcl,
      },
      strokeCache: strokeRes.ok ? strokeRes.value : null,
      scene: stats.scene,
      passLaptopTarget,
    };
  } finally {
    engine.dispose();
  }
}
