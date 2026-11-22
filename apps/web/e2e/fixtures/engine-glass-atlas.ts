import {
  ANY_REVISION,
  BLEND,
  type Camera,
  FLAG,
  GLASS_KIND,
  ListWriter,
  RenderEngine,
  ROOT,
  type WireRecord,
} from "@drawpane/engine";
import { loadBrowserEngine, loadWebglEngine } from "@drawpane/engine/browser";

const ID = [1, 0, 0, 1, 0, 0] as const;
const BG = [0.92, 0.93, 0.95, 1] as const;
const CAM: Camera = { zoom: 1, x: 0, y: 0, dpr: 1 };

function rec(partial: Partial<WireRecord>): WireRecord {
  return {
    flags: 0,
    opacity: 1,
    transform: ID,
    width: 100,
    height: 80,
    coarseBelow: 0,
    reach: 0,
    unsupported: 0,
    paths: [],
    ops: [],
    coarse: [],
    ...partial,
  };
}

interface LensSpec {
  id: number;
  x: number;
  y: number;
  w: number;
  h: number;
  ellipse?: boolean;
  angleDeg?: number;
  refraction?: number;
  depth?: number;
  frost?: number;
  splay?: number;
}

function glassRecord(spec: LensSpec): WireRecord {
  const rad = ((spec.angleDeg ?? 0) * Math.PI) / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const r = Math.min(spec.w, spec.h) * 0.25;
  return rec({
    transform: [c, s, -s, c, spec.x, spec.y],
    width: spec.w,
    height: spec.h,
    paths: [
      spec.ellipse
        ? { kind: "ellipse", w: spec.w, h: spec.h }
        : { kind: "rect", w: spec.w, h: spec.h, radii: [r, r, r, r], smoothing: 0 },
    ],
    ops: [
      {
        op: "glass",
        paths: [0],
        evenOdd: false,
        kind: spec.ellipse ? GLASS_KIND.ellipse : GLASS_KIND.box,
        inradius: Math.min(spec.w, spec.h) * 0.5,
        angle: -45,
        intensity: 80,
        refraction: spec.refraction ?? 65,
        depth: spec.depth ?? 8,
        dispersion: 35,
        frost: spec.frost ?? 3,
        splay: spec.splay ?? 25,
        boxRadii: spec.ellipse ? [0, 0, 0, 0] : [r, r, r, r],
        boxSmoothing: [0, 0, 0, 0],
      },
    ],
  });
}

function buildGlassPage(
  lenses: readonly LensSpec[],
  revision: number,
  width: number,
  height: number,
): Uint8Array {
  const w = new ListWriter(ANY_REVISION, revision);
  w.reset();
  const kids: number[] = [];

  // Striped colorful backdrop so refraction, frost, and dual-plane ordering are clearly visible.
  let nextBgId = 1000;
  const stripeColors: Array<readonly [number, number, number, number]> = [
    [0.14, 0.34, 0.85, 1],
    [0.95, 0.42, 0.16, 1],
    [0.12, 0.7, 0.46, 1],
    [0.75, 0.18, 0.62, 1],
    [0.98, 0.82, 0.18, 1],
  ];
  for (let i = 0; i < 12; i++) {
    const id = nextBgId++;
    const sw = width / 12;
    const color = stripeColors[i % stripeColors.length] ?? [0.14, 0.34, 0.85, 1];
    w.set(
      id,
      ROOT,
      rec({
        transform: [1, 0, 0, 1, i * sw, 0],
        width: sw,
        height,
        paths: [{ kind: "rect", w: sw, h: height, radii: [0, 0, 0, 0], smoothing: 0 }],
        ops: [
          {
            op: "fill",
            path: 0,
            evenOdd: false,
            paint: { kind: "solid", color },
          },
        ],
      }),
    );
    kids.push(id);
  }

  // Interleave ordinary paint between lenses to exercise dual-plane paint in one pass.
  for (let i = 0; i < lenses.length; i++) {
    const lens = lenses[i];
    if (!lens) continue;
    if (i === Math.floor(lenses.length / 2)) {
      const midId = 2000;
      w.set(
        midId,
        ROOT,
        rec({
          transform: [1, 0, 0, 1, 20, Math.round(height * 0.42)],
          width: width - 40,
          height: 36,
          paths: [{ kind: "rect", w: width - 40, h: 36, radii: [8, 8, 8, 8], smoothing: 0 }],
          ops: [
            {
              op: "fill",
              path: 0,
              evenOdd: false,
              paint: { kind: "solid", color: [0.98, 0.98, 0.98, 0.88] },
            },
          ],
        }),
      );
      kids.push(midId);
    }
    w.set(lens.id, ROOT, glassRecord(lens));
    kids.push(lens.id);
  }

  w.order(ROOT, kids);
  return w.finish();
}

function diffPixels(a: Uint8Array, b: Uint8Array, width = 0) {
  if (a.length !== b.length) {
    throw new Error(`pixel length mismatch: ${a.length} vs ${b.length}`);
  }
  let differingBytes = 0;
  let differingPixels = 0;
  let maxDiff = 0;
  const sample: Array<{ x: number; y: number; a: number[]; b: number[] }> = [];
  for (let i = 0; i < a.length; i += 4) {
    let pDiff = 0;
    for (let c = 0; c < 4; c++) {
      const d = Math.abs((a[i + c] ?? 0) - (b[i + c] ?? 0));
      if (d > 0) differingBytes++;
      if (d > pDiff) pDiff = d;
    }
    if (pDiff > 0) {
      differingPixels++;
      if (sample.length < 8 && width > 0) {
        const px = i / 4;
        sample.push({
          x: px % width,
          y: Math.floor(px / width),
          a: [a[i] ?? 0, a[i + 1] ?? 0, a[i + 2] ?? 0, a[i + 3] ?? 0],
          b: [b[i] ?? 0, b[i + 1] ?? 0, b[i + 2] ?? 0, b[i + 3] ?? 0],
        });
      }
    }
    if (pDiff > maxDiff) maxDiff = pDiff;
  }
  return { totalBytes: a.length, differingBytes, differingPixels, maxDiff, sample };
}

async function makeEngine(backend: "webgpu" | "webgl2", gpuBytes?: number) {
  const mod = backend === "webgpu" ? await loadBrowserEngine() : await loadWebglEngine();
  for (let attempt = 0; attempt < 2; attempt++) {
    const engine = new RenderEngine(mod, {
      glyphMaskBytes: 4 << 20,
      ...(gpuBytes !== undefined ? { gpuBytes } : {}),
    });
    if (engine.failure) throw new Error(engine.failure.message);
    const attached = await engine.attachGpu(null);
    if (attached.ok) return { engine, info: attached.value };
    engine.dispose();
    if (attempt === 1 || !attached.message.includes("timed out")) {
      throw new Error(`${backend} attachGpu failed: ${attached.message}`);
    }
  }
  throw new Error(`${backend} attachGpu failed`);
}

async function renderExact(
  engine: RenderEngine,
  width: number,
  height: number,
  options: { budgetMs: number; editorViewport: boolean },
) {
  let lastStats = null;
  for (let attempt = 0; attempt < 32; attempt++) {
    const r = engine.renderGpu(
      width,
      height,
      CAM,
      BG,
      false,
      options.budgetMs,
      options.editorViewport,
    );
    if (!r.ok) throw new Error(`renderGpu failed: ${r.code} ${r.message}`);
    lastStats = r.value;
    if (lastStats.exact) break;
  }
  if (!lastStats?.exact) throw new Error("renderGpu did not settle exact");
  const px = await engine.gpuPixels();
  if (!px.ok) throw new Error(`gpuPixels failed: ${px.code} ${px.message}`);
  return { stats: lastStats, pixels: px.value };
}

async function checkBlendSlab(engine: RenderEngine) {
  const size = 16;
  const scopes = 260;
  const list = new ListWriter(ANY_REVISION, 5);
  list.reset();
  // Consecutive scope composites run after the innermost paint flush. Vary
  // opacity around the 256-slot boundary so a reused slot changes the output.
  for (let i = 1; i <= scopes; i++) {
    list.set(
      i,
      i - 1,
      rec({
        width: size,
        height: size,
        flags: FLAG.blend,
        blend: BLEND.multiply,
        opacity: i === scopes ? 0.5 : i === scopes - 256 ? 0.75 : 1,
        ops: [{ op: "children" }],
      }),
    );
  }
  list.set(
    scopes + 1,
    scopes,
    rec({
      width: size,
      height: size,
      paths: [{ kind: "rect", w: size, h: size, radii: [0, 0, 0, 0], smoothing: 0 }],
      ops: [{ op: "fill", path: 0, evenOdd: false, paint: { kind: "solid", color: [1, 0, 0, 1] } }],
    }),
  );
  const applied = engine.apply(list.finish());
  if (!applied.ok) throw new Error(applied.message);
  const cpu = engine.renderCpu(size, size, CAM, BG, false);
  if (!cpu.ok) throw new Error(cpu.message);
  const gpu = await renderExact(engine, size, size, { budgetMs: 0, editorViewport: true });
  return {
    maxDiff: diffPixels(cpu.value.pixels, gpu.pixels).maxDiff,
    submits: gpu.stats.counts.submits,
  };
}

export async function runGlassAtlasSuite(backend: "webgpu" | "webgl2") {
  // 1. Multi-lens scene (6 lenses: rounded rects, ellipses, rotated, overlapping, straddling x=512).
  // Kept compact in height so SwiftShader finishes well inside readback timeouts while exercising
  // the 512 px tile seam and multi-row atlas packing.
  const multiLenses: LensSpec[] = [
    { id: 10, x: 20, y: 16, w: 84, h: 52, refraction: 60, frost: 2 },
    { id: 20, x: 88, y: 42, w: 88, h: 56, ellipse: true, refraction: 72, frost: 3 },
    { id: 30, x: 208, y: 20, w: 84, h: 54, angleDeg: 14, refraction: 65, frost: 2 },
    { id: 40, x: 468, y: 18, w: 84, h: 54, refraction: 70, frost: 3 },
    { id: 50, x: 318, y: 84, w: 92, h: 54, angleDeg: -11, refraction: 55, frost: 2 },
    { id: 60, x: 462, y: 86, w: 90, h: 56, ellipse: true, refraction: 68, frost: 3 },
  ];
  const wMulti = 576;
  const hMulti = 160;
  const multiRev1 = buildGlassPage(multiLenses, 3, wMulti, hMulti);

  // 1a. Atlas active vs budget-refused serial whole-frame render on a 7-lens scene where lenses
  // sit well inside a compact 380x220 viewport (no padded target) with identical extents so the
  // serial path reuses one mip pyramid while the 3-row atlas (~2.84 MiB) exceeds a 20 MiB budget.
  const budgetLenses: LensSpec[] = Array.from({ length: 7 }, (_, i) => ({
    id: 11 + i * 11,
    x: 28 + i * 10,
    y: 28 + i * 6,
    w: 260,
    h: 124,
    depth: 4,
    refraction: 24,
    frost: 0,
    splay: 0,
  }));
  const wBudget = 380;
  const hBudget = 220;
  const budgetMsg = buildGlassPage(budgetLenses, 1, wBudget, hBudget);

  // Base GPU allocation is 16 MiB (glyph atlas) + ~1.28 MiB (frame + scratch + backdrop).
  // 7 lenses of ~268x132 pack across 3 rows (~832x448*8 = 2.84 MiB -> >20.1 MiB); cap at 20 MiB
  // so atlas refuses for the whole frame while serial + readback fits cleanly.
  const { engine: engMain, info } = await makeEngine(backend, 256 << 20);
  const { engine: engRefused } = await makeEngine(backend, 20 << 20);
  const { engine: engFresh } = await makeEngine(backend, 256 << 20);
  try {
    const a1 = engMain.apply(budgetMsg);
    if (!a1.ok) throw new Error(a1.message);
    const a2 = engRefused.apply(budgetMsg);
    if (!a2.ok) throw new Error(a2.message);
    const batched = await renderExact(engMain, wBudget, hBudget, {
      budgetMs: 0,
      editorViewport: true,
    });
    const refused = await renderExact(engRefused, wBudget, hBudget, {
      budgetMs: 0,
      editorViewport: true,
    });
    const budgetAtlasVsSerial = {
      batchedOps: batched.stats.counts.glassOps,
      batchedCount: batched.stats.counts.glassBatched,
      batchedSubmits: batched.stats.counts.submits,
      refusedOps: refused.stats.counts.glassOps,
      refusedCount: refused.stats.counts.glassBatched,
      refusedSubmits: refused.stats.counts.submits,
      diff: diffPixels(batched.pixels, refused.pixels),
    };

    // 2. Oversize lens (> 1024 px wide, thin in height for fast software raster) falls back to
    // serial while 3 eligible siblings batch.
    const oversizeLenses: LensSpec[] = [
      { id: 1, x: 16, y: 12, w: 1040, h: 20, refraction: 60, frost: 2 },
      { id: 2, x: 24, y: 52, w: 80, h: 48, refraction: 65, frost: 2 },
      { id: 3, x: 140, y: 52, w: 84, h: 52, ellipse: true, refraction: 70, frost: 2 },
      { id: 4, x: 260, y: 52, w: 80, h: 48, angleDeg: 10, refraction: 55, frost: 2 },
    ];
    const wOver = 1072;
    const hOver = 116;
    const oversizeMsg = buildGlassPage(oversizeLenses, 2, wOver, hOver);
    const ao = engMain.apply(oversizeMsg);
    if (!ao.ok) throw new Error(ao.message);
    const overRes = await renderExact(engMain, wOver, hOver, {
      budgetMs: 0,
      editorViewport: true,
    });
    let nonZeroPixels = 0;
    for (let i = 0; i < overRes.pixels.length; i += 4) {
      if ((overRes.pixels[i + 3] ?? 0) > 0) nonZeroPixels++;
    }
    const oversizeFallback = {
      glassOps: overRes.stats.counts.glassOps,
      glassBatched: overRes.stats.counts.glassBatched,
      submits: overRes.stats.counts.submits,
      nonZeroPixels,
    };

    // 3. Patched vs fresh after editing lens 10 (which reorders store.readers() to move 10 to the end).
    const editedLenses = multiLenses.map((l) =>
      l.id === 10 ? { ...l, refraction: 84, frost: 7, x: 42 } : l,
    );
    const multiRev2Fresh = buildGlassPage(editedLenses, 4, wMulti, hMulti);
    const editedFirst = editedLenses[0];
    if (!editedFirst) throw new Error("missing edited lens");
    const patchWriter = new ListWriter(3, 4);
    patchWriter.set(10, ROOT, glassRecord(editedFirst));
    const multiRev2Patch = patchWriter.finish();

    const p1 = engMain.apply(multiRev1);
    if (!p1.ok) throw new Error(p1.message);
    await renderExact(engMain, wMulti, hMulti, { budgetMs: 0, editorViewport: true });
    const p2 = engMain.apply(multiRev2Patch);
    if (!p2.ok) throw new Error(p2.message);
    const patchedRes = await renderExact(engMain, wMulti, hMulti, {
      budgetMs: 0,
      editorViewport: true,
    });

    const f2 = engFresh.apply(multiRev2Fresh);
    if (!f2.ok) throw new Error(f2.message);
    const freshRes = await renderExact(engFresh, wMulti, hMulti, {
      budgetMs: 0,
      editorViewport: true,
    });

    const patchedVsFresh = {
      patchedBatched: patchedRes.stats.counts.glassBatched,
      freshBatched: freshRes.stats.counts.glassBatched,
      diff: diffPixels(patchedRes.pixels, freshRes.pixels),
    };

    // 4. Tiles vs whole frame on the same 6-lens glass page (lenses 40 and 60 straddle x=512).
    engFresh.clearTiles();
    const tiledRes = await renderExact(engFresh, wMulti, hMulti, {
      budgetMs: 1000,
      editorViewport: true,
    });
    const wholeVsTiled = {
      wholePlan: freshRes.stats.plan,
      wholeBatched: freshRes.stats.counts.glassBatched,
      tiledPlan: tiledRes.stats.plan,
      tiledBatched: tiledRes.stats.counts.glassBatched,
      tiledDrawn: tiledRes.stats.tiles.drawn,
      diff: diffPixels(freshRes.pixels, tiledRes.pixels, wMulti),
    };

    return {
      backend: info.backend,
      adapter: info.adapter,
      budgetAtlasVsSerial,
      oversizeFallback,
      patchedVsFresh,
      wholeVsTiled,
      blendSlab: await checkBlendSlab(engFresh),
    };
  } finally {
    engMain.dispose();
    engRefused.dispose();
    engFresh.dispose();
  }
}
