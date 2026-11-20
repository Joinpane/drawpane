/**
 * In-app hardware backend and presentation verification for engine benchmarks.
 *
 * Reads live DOM renderer state on `.canvas` (set by `Canvas.tsx` on every rendered frame),
 * tracks `drawpane:renderer-fallback` events across the measured scenario, hides transient
 * overlays (`.canvas__overlay`, `.canvas__mode-badge`) while sampling the engine `<canvas>`
 * directly, and verifies non-blank engine pixels plus camera-driven pixel changes. Any fallback
 * to Canvas, unexpected software or unidentified adapter, transparent engine layer, or frozen
 * surface fails the benchmark immediately.
 */
import { inflateSync } from "node:zlib";
import { expect, type Page } from "@playwright/test";

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

/** Deterministic NxN RGB sample grid from a decoded PNG, used to verify pixels change across inputs. */
function sampleRgbGrid(data: Uint8Array, width: number, height: number, grid = 16): number[] {
  if (width === 0 || height === 0) return [];
  const out: number[] = [];
  for (let gy = 0; gy < grid; gy++) {
    const y = Math.min(height - 1, Math.floor(((gy + 0.5) * height) / grid));
    for (let gx = 0; gx < grid; gx++) {
      const x = Math.min(width - 1, Math.floor(((gx + 0.5) * width) / grid));
      const i = (y * width + x) * 4;
      out.push(data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0);
    }
  }
  return out;
}

function gridChangedCells(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let changed = 0;
  for (let i = 0; i < a.length; i += 3) {
    const diff =
      Math.abs((a[i] ?? 0) - (b[i] ?? 0)) +
      Math.abs((a[i + 1] ?? 0) - (b[i + 1] ?? 0)) +
      Math.abs((a[i + 2] ?? 0) - (b[i + 2] ?? 0));
    if (diff > 12) changed++;
  }
  return changed;
}

function gridChangedRatio(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  const cells = a.length / 3;
  return Math.round((gridChangedCells(a, b) / cells) * 1000) / 1000;
}

export interface EngineSurfaceSample {
  readonly nonBlank: boolean;
  readonly nonBackgroundRatio: number;
  readonly grid: number[];
  readonly fineGrid: number[];
}

export interface DomRendererSnapshot {
  readonly renderer: string;
  readonly adapter: string;
  readonly adapterClass: string;
  readonly presentationPath: string;
  readonly software: boolean;
  readonly presented: boolean;
  /** Confirmed frame presentations (after GPU completion + rAF on direct GPU, or paint on readback/CPU). */
  readonly frames: number;
  /** Frames submitted to the render engine (distinct from confirmed presentations). */
  readonly submittedFrames: number;
  /** Highest submitted frame sequence number confirmed presented on the visible engine canvas, or null on synthetic fixtures without the attribute. */
  readonly confirmedFrame: number | null;
  readonly fallbackFrames: number;
  readonly fallbackEvents: unknown[];
  readonly visibleCanvasCount: number;
  readonly visibleEngineCanvas: {
    readonly width: number;
    readonly height: number;
    readonly cssWidth: number;
    readonly cssHeight: number;
  } | null;
  readonly engineSurface: EngineSurfaceSample | null;
}

export interface ScenarioCheckpoint {
  readonly submittedFramesDelta: number;
  readonly presentedFramesDelta: number;
  readonly confirmedFrame: number | null;
  readonly fallbackFramesDelta: number;
  readonly compositedNonBlank: boolean;
  readonly compositedNonBackgroundRatio: number;
  readonly deltaFromPrevious: number | null;
  readonly changedCellsFromPrevious: number | null;
  readonly grid: number[];
  readonly fineGrid: number[];
}

export interface PresentationCheck {
  readonly before: DomRendererSnapshot;
  readonly after: DomRendererSnapshot;
  readonly submittedFramesDelta: number;
  readonly presentedFramesDelta: number;
  readonly fallbackFramesDelta: number;
  readonly compositedNonBackgroundRatio: number;
  readonly compositedNonBlank: boolean;
  readonly cameraChangeRatio: number | null;
}

export async function installFallbackRecorder(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { engineFallbacks?: unknown[] };
    w.engineFallbacks = [];
    window.addEventListener("drawpane:renderer-fallback", (e) => {
      w.engineFallbacks = [...(w.engineFallbacks ?? []), (e as CustomEvent).detail];
    });
  });
}

/**
 * Samples ONLY the visible engine `<canvas>` while transient overlays (`.canvas__overlay`,
 * `.canvas__labels`, `.canvas__mode-badge`) are hidden so overlay ink can never satisfy the
 * non-blank check.
 */
export async function sampleEngineSurface(page: Page): Promise<EngineSurfaceSample> {
  const hiddenCount = await page.evaluate(async () => {
    const els = [
      ...document.querySelectorAll<HTMLElement>(
        ".canvas .canvas__overlay, .canvas .canvas__labels, .canvas .canvas__mode-badge",
      ),
    ];
    for (const el of els) {
      el.dataset.gatePrevVisibility = el.style.visibility;
      el.style.visibility = "hidden";
    }
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
    return els.length;
  });
  try {
    const engineLocator = page.locator(
      '.canvas canvas[data-canvas-role="engine"], .canvas canvas.canvas__layer:not(.canvas__overlay):nth-of-type(2)',
    );
    const count = await engineLocator.count();
    if (count === 0) return { nonBlank: false, nonBackgroundRatio: 0, grid: [], fineGrid: [] };
    const visible = await engineLocator
      .first()
      .evaluate((el) => getComputedStyle(el).visibility === "visible");
    if (!visible) return { nonBlank: false, nonBackgroundRatio: 0, grid: [], fineGrid: [] };
    const png = await engineLocator.first().screenshot();
    const decoded = decodePngRgba(png);
    const { data, width, height } = decoded;
    if (width === 0 || height === 0) {
      return { nonBlank: false, nonBackgroundRatio: 0, grid: [], fineGrid: [] };
    }
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
    const ratio = total > 0 ? differing / total : 0;
    return {
      nonBlank: ratio >= 0.01,
      nonBackgroundRatio: Math.round(ratio * 1000) / 1000,
      grid: sampleRgbGrid(data, width, height, 16),
      fineGrid: sampleRgbGrid(data, width, height, 64),
    };
  } finally {
    if (hiddenCount > 0) {
      await page.evaluate(async () => {
        const els = [
          ...document.querySelectorAll<HTMLElement>(
            ".canvas .canvas__overlay, .canvas .canvas__labels, .canvas .canvas__mode-badge",
          ),
        ];
        for (const el of els) {
          el.style.visibility = el.dataset.gatePrevVisibility ?? "";
          delete el.dataset.gatePrevVisibility;
        }
        await new Promise<void>((r) => requestAnimationFrame(() => r()));
      });
    }
  }
}

export async function captureRendererState(
  page: Page,
  options?: { sampleSurface?: boolean },
): Promise<DomRendererSnapshot> {
  const dom = await page.evaluate(() => {
    const host = document.querySelector(".canvas") as HTMLElement | null;
    const layers = [...document.querySelectorAll<HTMLCanvasElement>(".canvas canvas.canvas__layer")]
      .filter((c) => !c.classList.contains("canvas__overlay"))
      .map((c) => {
        const rect = c.getBoundingClientRect();
        return {
          role: c.dataset.canvasRole ?? null,
          visible: getComputedStyle(c).visibility === "visible",
          width: c.width,
          height: c.height,
          cssWidth: rect.width,
          cssHeight: rect.height,
        };
      });
    const visibleLayers = layers.filter((c) => c.visible && c.cssWidth > 0 && c.cssHeight > 0);
    const engineLayer = layers.find((c) => c.role === "engine") ?? layers[1];
    const engineCanvas = engineLayer?.visible ? engineLayer : null;
    const w = window as unknown as { engineFallbacks?: unknown[] };
    const frames = Number(host?.dataset.rendererFrames ?? "0");
    const submittedFrames =
      host?.dataset.rendererSubmittedFrames !== undefined
        ? Number(host.dataset.rendererSubmittedFrames)
        : frames;
    const confirmedFrame =
      host?.dataset.rendererConfirmedFrame !== undefined
        ? Number(host.dataset.rendererConfirmedFrame)
        : null;
    return {
      renderer: host?.dataset.renderer ?? "unknown",
      adapter: host?.dataset.rendererAdapter ?? "unidentified",
      adapterClass: host?.dataset.rendererAdapterClass ?? "unidentified",
      presentationPath: host?.dataset.rendererPresentation ?? "unknown",
      software: host?.dataset.rendererSoftware === "true",
      presented: host?.dataset.rendererPresented === "true",
      frames,
      submittedFrames,
      confirmedFrame,
      fallbackFrames: Number(host?.dataset.rendererFallbackFrames ?? "0"),
      fallbackEvents: [...(w.engineFallbacks ?? [])],
      visibleCanvasCount: visibleLayers.length,
      visibleEngineCanvas: engineCanvas
        ? {
            width: engineCanvas.width,
            height: engineCanvas.height,
            cssWidth: engineCanvas.cssWidth,
            cssHeight: engineCanvas.cssHeight,
          }
        : null,
    };
  });
  const engineSurface = options?.sampleSurface === false ? null : await sampleEngineSurface(page);
  return { ...dom, engineSurface };
}

/**
 * Verifies that shifting the live camera updates the engine canvas pixels (with overlay hidden)
 * and restores the camera afterwards. Proves the presented surface tracks live input rather than
 * showing a stale frame or overlay-only ink.
 */
export async function verifyCameraUpdatesEnginePixels(page: Page, label: string): Promise<number> {
  const before = await sampleEngineSurface(page);
  expect(
    before.nonBlank,
    `${label}: engine surface (with overlay hidden) is blank before camera probe`,
  ).toBe(true);
  const shifted = await page.evaluate(async () => {
    const e = (
      window as unknown as {
        drawpane?: {
          s: {
            camera: { x: number; y: number; zoom: number; pan(dx: number, dy: number): unknown };
          };
          state: { set(p: { camera: unknown }): void };
        };
      }
    ).drawpane;
    if (!e) return false;
    e.state.set({ camera: e.s.camera.pan(-120, -60) });
    for (let i = 0; i < 3; i++) await new Promise<void>((r) => requestAnimationFrame(() => r()));
    return true;
  });
  if (!shifted) return 0;
  try {
    const after = await sampleEngineSurface(page);
    expect(
      after.nonBlank,
      `${label}: engine surface (with overlay hidden) is blank after camera pan probe`,
    ).toBe(true);
    const ratio = gridChangedRatio(before.grid, after.grid);
    expect(
      ratio,
      `${label}: engine canvas pixels did not change after panning camera (changed ratio ${ratio})`,
    ).toBeGreaterThanOrEqual(0.02);
    return ratio;
  } finally {
    await page.evaluate(async () => {
      const e = (
        window as unknown as {
          drawpane?: {
            s: { camera: { pan(dx: number, dy: number): unknown } };
            state: { set(p: { camera: unknown }): void };
          };
        }
      ).drawpane;
      if (!e) return;
      e.state.set({ camera: e.s.camera.pan(120, 60) });
      for (let i = 0; i < 2; i++) await new Promise<void>((r) => requestAnimationFrame(() => r()));
    });
  }
}

/**
 * Runs a per-scenario presentation and pixel checkpoint OUTSIDE the measured timing loop:
 * asserts the engine canvas stays visible with zero fallback frames, confirmed presentations
 * advanced on a frame submitted during this gesture (not a late pre-gesture completion), the
 * engine surface (with overlays hidden) is non-blank, and pixels changed relative to the
 * pre-scenario baseline (or previous checkpoint).
 */
export async function verifyScenarioCheckpoint(
  page: Page,
  before: DomRendererSnapshot,
  label: string,
  options?: {
    minSubmitted?: number;
    minPresented?: number;
    previous?: ScenarioCheckpoint | null;
    requirePixelChange?: boolean;
    pixelMatchMode?: "coarse" | "fine";
    minDeltaFromPrevious?: number;
    minChangedCells?: number;
  },
): Promise<ScenarioCheckpoint> {
  // Allow the latest submitted direct-GPU frame one compositor rAF to confirm presentation.
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );
  const after = await captureRendererState(page, { sampleSurface: true });
  const surface = after.engineSurface ?? {
    nonBlank: false,
    nonBackgroundRatio: 0,
    grid: [],
    fineGrid: [],
  };
  const submittedFramesDelta = after.submittedFrames - before.submittedFrames;
  const presentedFramesDelta = after.frames - before.frames;
  const fallbackFramesDelta = after.fallbackFrames - before.fallbackFrames;
  const minSubmitted = options?.minSubmitted ?? 1;
  const minPresented = options?.minPresented ?? 1;
  const requirePixelChange = options?.requirePixelChange ?? true;
  const pixelMatchMode = options?.pixelMatchMode ?? "coarse";

  expect(after.renderer, `${label}: engine must remain active during scenario`).not.toBe("canvas");
  expect(
    after.visibleEngineCanvas,
    `${label}: engine canvas element must remain visible after scenario`,
  ).not.toBeNull();
  expect(fallbackFramesDelta, `${label}: fallback frames during scenario`).toBe(0);
  expect(
    submittedFramesDelta,
    `${label}: engine submitted frames during scenario (before=${before.submittedFrames}, after=${after.submittedFrames})`,
  ).toBeGreaterThanOrEqual(minSubmitted);
  expect(
    presentedFramesDelta,
    `${label}: confirmed engine presentations during scenario (before=${before.frames}, after=${after.frames})`,
  ).toBeGreaterThanOrEqual(minPresented);
  if (minPresented > 0 && after.confirmedFrame !== null) {
    expect(
      after.confirmedFrame,
      `${label}: confirmed frame (${after.confirmedFrame}) must be submitted during this gesture (> before.submittedFrames=${before.submittedFrames}), not a stale pre-gesture completion`,
    ).toBeGreaterThan(before.submittedFrames);
  }
  expect(
    surface.nonBlank,
    `${label}: engine surface (with overlays hidden) appears blank after scenario (non-background ratio ${surface.nonBackgroundRatio})`,
  ).toBe(true);

  const baseline =
    options?.previous && options.previous.grid.length > 0
      ? options.previous
      : before.engineSurface && before.engineSurface.grid.length > 0
        ? before.engineSurface
        : null;

  let deltaFromPrevious: number | null = null;
  let changedCellsFromPrevious: number | null = null;
  if (baseline) {
    deltaFromPrevious = gridChangedRatio(baseline.grid, surface.grid);
    if (baseline.fineGrid.length > 0 && surface.fineGrid.length === baseline.fineGrid.length) {
      changedCellsFromPrevious = gridChangedCells(baseline.fineGrid, surface.fineGrid);
    }
  }

  if (requirePixelChange) {
    expect(
      baseline,
      `${label}: scenario checkpoint requires a pre-scenario baseline surface (captureRendererState with sampleSurface: true) or previous checkpoint to detect frozen pixels`,
    ).not.toBeNull();
    if (pixelMatchMode === "fine") {
      const minCells = options?.minChangedCells ?? 1;
      expect(
        changedCellsFromPrevious ?? 0,
        `${label}: engine pixels did not change compared to pre-gesture baseline (changed fine cells ${changedCellsFromPrevious ?? 0}, coarse delta ${deltaFromPrevious ?? 0})`,
      ).toBeGreaterThanOrEqual(minCells);
    } else {
      const minDelta = options?.minDeltaFromPrevious ?? 0.01;
      expect(
        deltaFromPrevious ?? 0,
        `${label}: engine pixels did not change compared to baseline/previous scenario (changed ratio ${deltaFromPrevious ?? 0})`,
      ).toBeGreaterThanOrEqual(minDelta);
    }
  }
  return {
    submittedFramesDelta,
    presentedFramesDelta,
    confirmedFrame: after.confirmedFrame,
    fallbackFramesDelta,
    compositedNonBlank: surface.nonBlank,
    compositedNonBackgroundRatio: surface.nonBackgroundRatio,
    deltaFromPrevious,
    changedCellsFromPrevious,
    grid: surface.grid,
    fineGrid: surface.fineGrid,
  };
}

/**
 * Asserts that an engine benchmark actually ran on the expected hardware GPU backend
 * (bound to the standalone GPU gate's `verifiedBackends` when present), confirmed frame
 * presentation without falling back to Canvas or CPU view mode, and produced non-blank
 * engine pixels on screen (verified with overlays hidden).
 */
export async function verifyEngineBenchmark(
  page: Page,
  before: DomRendererSnapshot,
  label: string,
  options?: {
    allowSoftware?: boolean;
    allowCpuWorker?: boolean;
    allowReadback?: boolean;
    expectedBackends?: readonly string[];
    minSubmittedFrames?: number;
    minFrames?: number;
    checkCameraDelta?: boolean;
  },
): Promise<PresentationCheck> {
  const allowSoftware = options?.allowSoftware ?? process.env.BENCH_ALLOW_SOFTWARE === "1";
  const allowCpuWorker = options?.allowCpuWorker ?? process.env.BENCH_RENDERER === "engine-cpu";
  const allowReadback =
    options?.allowReadback ?? (process.env.BENCH_ENGINE_PRESENT === "readback" || allowCpuWorker);
  const envVerified = (process.env.BENCH_VERIFIED_BACKENDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const verifiedBackends =
    options?.expectedBackends ?? (envVerified.length > 0 ? envVerified : null);
  const minFrames = options?.minFrames ?? 1;
  const minSubmittedFrames = options?.minSubmittedFrames ?? minFrames;
  const after = await captureRendererState(page, { sampleSurface: true });
  const surface = after.engineSurface ?? { nonBlank: false, nonBackgroundRatio: 0, grid: [] };
  const check: PresentationCheck = {
    before,
    after,
    submittedFramesDelta: after.submittedFrames - before.submittedFrames,
    presentedFramesDelta: after.frames - before.frames,
    fallbackFramesDelta: after.fallbackFrames - before.fallbackFrames,
    compositedNonBackgroundRatio: surface.nonBackgroundRatio,
    compositedNonBlank: surface.nonBlank,
    cameraChangeRatio: null,
  };

  const allowedBackends = allowCpuWorker
    ? ["webgpu", "webgl2", "cpu-worker"]
    : ["webgpu", "webgl2"];
  expect(
    allowedBackends,
    `${label}: DOM data-renderer must be active engine backend (${allowedBackends.join("/")}), got "${after.renderer}" (adapter: ${after.adapter}, class: ${after.adapterClass}, fallbacks: ${JSON.stringify(after.fallbackEvents)})`,
  ).toContain(after.renderer);

  if (verifiedBackends !== null) {
    expect(
      verifiedBackends,
      `${label}: active engine backend "${after.renderer}" was not verified by the standalone GPU gate (verifiedBackends: [${verifiedBackends.join(", ")}], adapter: ${after.adapter}, class: ${after.adapterClass})`,
    ).toContain(after.renderer);
  }

  // Never allow unidentified / missing adapters to pass as verified engine benchmarks.
  expect(
    after.adapter.trim().toLowerCase(),
    `${label}: adapter must not be empty or "unidentified"`,
  ).not.toBe("");
  expect(
    after.adapter.trim().toLowerCase(),
    `${label}: adapter must not be "unidentified"`,
  ).not.toBe("unidentified");
  const allowedAdapterClasses = allowSoftware
    ? ["hardware", "unknown", "software"]
    : ["hardware", "unknown"];
  expect(
    allowedAdapterClasses,
    `${label}: unexpected adapter class "${after.adapterClass}" for adapter "${after.adapter}"`,
  ).toContain(after.adapterClass);

  // An "unknown" WebGPU adapter (e.g. empty/masked adapter.info on Firefox) is only trusted when
  // the standalone GPU gate explicitly verified WebGPU for this run.
  if (
    !allowSoftware &&
    after.renderer === "webgpu" &&
    after.adapterClass === "unknown" &&
    !verifiedBackends?.includes("webgpu")
  ) {
    throw new Error(
      `${label}: refusing unverified WebGPU adapter "${after.adapter}" with adapterClass="unknown" (requires explicit hardware identity or standalone gate verification in BENCH_VERIFIED_BACKENDS)`,
    );
  }

  if (!allowSoftware) {
    expect(
      after.software,
      `${label}: engine benchmark ran on a software adapter (${after.adapter})`,
    ).toBe(false);
  }
  if (!allowReadback) {
    expect(
      after.presentationPath,
      `${label}: expected direct onscreen GPU presentation, got "${after.presentationPath}"`,
    ).toBe("direct");
  }
  expect(
    after.presented,
    `${label}: engine did not present its latest frame (data-renderer-presented=false)`,
  ).toBe(true);
  expect(
    check.submittedFramesDelta,
    `${label}: engine must submit at least ${minSubmittedFrames} frame(s) during the measured scenario (before=${before.submittedFrames}, after=${after.submittedFrames})`,
  ).toBeGreaterThanOrEqual(minSubmittedFrames);
  expect(
    check.presentedFramesDelta,
    `${label}: engine must confirm presentation of at least ${minFrames} frame(s) during the measured scenario (before=${before.frames}, after=${after.frames})`,
  ).toBeGreaterThanOrEqual(minFrames);
  expect(
    check.fallbackFramesDelta,
    `${label}: engine fell back to Canvas for ${check.fallbackFramesDelta} frame(s) during the measured scenario`,
  ).toBe(0);
  expect(
    after.visibleEngineCanvas,
    `${label}: engine canvas element must be visible with non-zero dimensions`,
  ).not.toBeNull();
  expect(
    check.compositedNonBlank,
    `${label}: engine canvas screenshot (with overlays hidden) appears blank (non-background ratio ${check.compositedNonBackgroundRatio})`,
  ).toBe(true);

  if (options?.checkCameraDelta) {
    const delta = await verifyCameraUpdatesEnginePixels(page, label);
    return { ...check, cameraChangeRatio: delta };
  }
  return check;
}
