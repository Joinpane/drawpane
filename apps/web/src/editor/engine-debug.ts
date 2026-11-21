/**
 * The render engine for the e2e gates and the benches (decision 0040, "Parity gates"):
 * a page rectangle drawn by the engine on the CPU or the GPU, off screen, read back through a
 * buffer (never through a canvas: a WebGPU canvas copied to a 2D one can come back empty on
 * headless GPUs), with what the page holds that the engine doesn't draw. Attached to the debug
 * handle only (`drawpaneEngine`), whether or not the switch is on.
 */

import {
  CanvasRenderer,
  DisplayListBuilder,
  type Editor,
  imageRefs,
  type Rect,
} from "@drawpane/editor";
import {
  type BlurCacheStats,
  type BlurEdge,
  type BlurRect,
  type EngineModule,
  type FrameStats,
  type GpuInfo,
  loadBrowserEngine,
  loadWebglEngine,
  RenderEngine,
  unsupportedNames,
} from "@drawpane/engine";
import { colorBitmap } from "./color-glyphs";
import { imagesFor } from "./media";

const toBase64 = (bytes: Uint8Array) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

const fromBase64 = (b64: string) => {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

export interface EngineRender {
  readonly ok: boolean;
  readonly error?: string;
  readonly code?: number;
  /** Straight RGBA8, base64. */
  readonly rgba?: string;
  /** Unsupported features and text fallback notes, by layer. */
  readonly unsupported: Record<string, string[]>;
  readonly stats?: FrameStats;
  /** Milliseconds: building the list, applying it, rendering (GPU: until the GPU finished). */
  readonly ms?: { build: number; apply: number; render: number };
  readonly gpu?: GpuInfo | null;
}

export function engineDebug(editor: Editor) {
  let browserModule: EngineModule | null = null;
  let webglModule: EngineModule | null = null;
  const engines: Partial<Record<"cpu" | "gpu" | "webgl", RenderEngine>> = {};
  const uploadedByEngine = new WeakMap<
    RenderEngine,
    Map<string, { handle: number; width: number; height: number }>
  >();

  async function moduleFor(backend: "cpu" | "gpu" | "webgl"): Promise<EngineModule> {
    if (backend === "webgl") {
      if (!webglModule) webglModule = await loadWebglEngine();
      return webglModule;
    }
    if (!browserModule) browserModule = await loadBrowserEngine();
    return browserModule;
  }

  async function engineFor(
    backend: "cpu" | "gpu" | "webgl",
    compatibility: boolean,
  ): Promise<RenderEngine | string> {
    const mod = await moduleFor(backend);
    const have = engines[backend];
    if (have && !have.dead) return have;
    const e = new RenderEngine(mod, { glyphMaskBytes: 32 << 20 });
    if (backend === "gpu" || backend === "webgl") {
      const r = await e.attachGpu(null, { compatibility: backend === "gpu" && compatibility });
      if (!r.ok) {
        e.dispose();
        return `${r.message} (${r.code})`;
      }
    }
    engines[backend] = e;
    uploadedByEngine.set(e, new Map());
    return e;
  }

  /** Uploads every image the page's layers paint, once loaded, so the list can place them. */
  async function images(e: RenderEngine, pageId: string): Promise<void> {
    const uploaded = uploadedByEngine.get(e) ?? new Map();
    uploadedByEngine.set(e, uploaded);
    const cache = imagesFor(editor);
    const refs = imageRefs(editor.doc, [pageId]);
    await cache.ready(refs, 30_000);
    for (const ref of refs) {
      const natural = cache.natural(ref);
      const view = cache.get(ref);
      if (!natural || !view || uploaded.has(`${ref}`)) continue;
      const c = new OffscreenCanvas(view.bitmap.width, view.bitmap.height);
      const ctx = c.getContext("2d");
      if (!ctx) continue;
      ctx.drawImage(view.bitmap, 0, 0);
      const data = ctx.getImageData(0, 0, c.width, c.height).data;
      const handle = uploaded.size + 1;
      if (e.putImage(handle, c.width, c.height, new Uint8Array(data.buffer)).ok)
        uploaded.set(ref, { handle, width: natural.width, height: natural.height });
    }
  }

  let canvas: CanvasRenderer | null = null;

  function builder(
    uploaded: Map<string, { handle: number; width: number; height: number }>,
    e?: RenderEngine,
    scale = 1,
  ): DisplayListBuilder {
    const b = new DisplayListBuilder(editor.scene, editor.measurer, {
      image: (ref) => uploaded.get(ref) ?? null,
      colorGlyph: (text, font, rasterScale) => {
        if (!e) return null;
        const sprite = colorBitmap(text, font, rasterScale);
        if (!sprite) return null;
        let held = uploaded.get(sprite.ref);
        if (!held) {
          const { width, height, data } = sprite.pixels;
          const handle = uploaded.size + 1;
          if (!e.putImage(handle, width, height, new Uint8Array(data.buffer)).ok) return null;
          held = { handle, width: sprite.width, height: sprite.height };
          uploaded.set(sprite.ref, held);
        }
        return { ...sprite, ...held };
      },
    });
    b.setColorScale(scale);
    return b;
  }

  const unsupportedOf = (b: DisplayListBuilder) => {
    const out: Record<string, string[]> = {};
    for (const [id, bits] of b.unsupported)
      for (const name of unsupportedNames(bits)) {
        const ids = out[name] ?? [];
        ids.push(id);
        out[name] = ids;
      }
    return out;
  };

  return {
    /**
     * `rect` of page `pageId` (page units) at `scale`, `width` × `height` device pixels, drawn
     * by the engine on `backend`. `background` straight RGBA floats (transparent for exports).
     */
    async render(options: {
      pageId: string;
      /** Just these layers, drawn alone as an export draws them; else the whole page. */
      ids?: string[];
      /** Export with page backdrop context for backdrop readers (decision 0039). */
      context?: boolean;
      rect: Rect;
      scale: number;
      width: number;
      height: number;
      backend: "cpu" | "gpu" | "webgl";
      background?: [number, number, number, number];
      compatibility?: boolean;
    }): Promise<EngineRender> {
      const e = await engineFor(options.backend, options.compatibility ?? false);
      if (typeof e === "string") return { ok: false, error: e, unsupported: {} };
      await images(e, options.pageId);
      const uploaded = uploadedByEngine.get(e) ?? new Map();
      // Text whose face is still loading can't be outlined yet: the shaper starts loading it on
      // the first try, and the list sends it provisional (bars) meanwhile. Wait for it (as the
      // canvas's parity spec waits for fonts), up to 20 s: what's drawn is the text itself.
      const make = () => {
        const b = builder(uploaded, e, options.scale);
        return {
          b,
          list: options.ids
            ? b.buildLayers(options.ids, { context: options.context })
            : b.build(options.pageId),
        };
      };
      for (let waited = 0; waited < 20_000 && make().b.waiting > 0; waited += 100)
        await new Promise((r) => setTimeout(r, 100));
      const t0 = performance.now();
      // A fresh list replaces whatever the engine held: made for a revision past the engine's
      // (fresh lists only move the revision forward).
      const b = builder(uploaded, e, options.scale);
      b.acknowledge(false, e.revision);
      const list = options.ids
        ? b.buildLayers(options.ids, { context: options.context })
        : b.build(options.pageId);
      const t1 = performance.now();
      const applied = e.apply(list);
      const t2 = performance.now();
      const unsupported = unsupportedOf(b);
      if (!applied.ok)
        return { ok: false, error: applied.message, code: applied.code, unsupported };
      const camera = {
        zoom: options.scale,
        x: -options.rect.x * options.scale,
        y: -options.rect.y * options.scale,
        dpr: 1,
      };
      const bg = options.background ?? [1, 1, 1, 1];
      if (options.backend === "cpu") {
        const r = e.renderCpu(options.width, options.height, camera, bg, false);
        const t3 = performance.now();
        if (!r.ok) return { ok: false, error: r.message, code: r.code, unsupported };
        return {
          ok: true,
          rgba: toBase64(r.value.pixels),
          unsupported,
          stats: r.value.stats,
          ms: { build: t1 - t0, apply: t2 - t1, render: t3 - t2 },
        };
      }
      const r = e.renderGpu(options.width, options.height, camera, bg, false);
      if (!r.ok) return { ok: false, error: r.message, code: r.code, unsupported, gpu: e.gpu };
      const fin = await e.gpuFinished();
      if (!fin.ok)
        return { ok: false, error: fin.message, code: fin.code, unsupported, gpu: e.gpu };
      const t3 = performance.now();
      const px = await e.gpuPixels();
      if (!px.ok) return { ok: false, error: px.message, code: px.code, unsupported, gpu: e.gpu };
      return {
        ok: true,
        rgba: toBase64(px.value),
        unsupported,
        stats: r.value,
        ms: { build: t1 - t0, apply: t2 - t1, render: t3 - t2 },
        gpu: e.gpu,
      };
    },

    /**
     * Renders an asymmetric test scene onto a visible on-screen `<canvas>` and compares its
     * composited screen pixels against `gpuPixels()` to catch orientation, alpha, or presentation
     * bugs that offscreen readback alone misses.
     */
    async presentCheck(options: {
      backend: "gpu" | "webgl";
      compatibility?: boolean;
      width: number;
      height: number;
      backgrounds: Array<[number, number, number, number]>;
    }): Promise<{
      ok: boolean;
      error?: string;
      gpu?: GpuInfo | null;
      samples?: Array<{
        presented: boolean;
        topLeftScreen: number[];
        topLeftReadback: number[];
        bottomRightScreen: number[];
        bottomRightReadback: number[];
        bytes: number;
      }>;
    }> {
      const mod = await moduleFor(options.backend);
      const canvas = document.createElement("canvas");
      canvas.width = options.width;
      canvas.height = options.height;
      canvas.style.position = "fixed";
      canvas.style.left = "0";
      canvas.style.top = "0";
      canvas.style.width = `${options.width}px`;
      canvas.style.height = `${options.height}px`;
      canvas.style.pointerEvents = "none";
      document.body.append(canvas);
      const e = new RenderEngine(mod);
      try {
        const g = await e.attachGpu(canvas, {
          compatibility: options.backend === "gpu" && (options.compatibility ?? false),
        });
        if (!g.ok) return { ok: false, error: `${g.message} (${g.code})` };
        const { ListWriter, ROOT } = await import("@drawpane/engine");
        const w = new ListWriter(0xffffffff, 1);
        w.reset();
        const halfW = Math.floor(options.width / 2);
        const halfH = Math.floor(options.height / 2);
        w.set(1, ROOT, {
          flags: 0,
          opacity: 1,
          transform: [1, 0, 0, 1, 0, 0],
          width: halfW,
          height: halfH,
          coarseBelow: 0,
          reach: 0,
          unsupported: 0,
          paths: [{ kind: "rect", w: halfW, h: halfH, radii: [0, 0, 0, 0], smoothing: 0 }],
          ops: [
            { op: "fill", path: 0, evenOdd: false, paint: { kind: "solid", color: [1, 0, 0, 1] } },
          ],
          coarse: [],
        });
        const applied = e.apply(w.finish());
        if (!applied.ok) return { ok: false, error: applied.message, gpu: g.value };
        const scratch = document.createElement("canvas");
        scratch.width = options.width;
        scratch.height = options.height;
        const ctx = scratch.getContext("2d");
        if (!ctx) return { ok: false, error: "no 2D context", gpu: g.value };
        const samples = [];
        for (const background of options.backgrounds) {
          const r = e.renderGpu(
            options.width,
            options.height,
            { zoom: 1, x: 0, y: 0, dpr: 1 },
            background,
            false,
          );
          if (!r.ok) return { ok: false, error: r.message, gpu: g.value };
          ctx.clearRect(0, 0, options.width, options.height);
          ctx.drawImage(canvas, 0, 0);
          const tl = Array.from(ctx.getImageData(2, 2, 1, 1).data);
          const br = Array.from(ctx.getImageData(options.width - 1, options.height - 1, 1, 1).data);
          const fin = await e.gpuFinished();
          if (!fin.ok) return { ok: false, error: fin.message, gpu: g.value };
          const px = await e.gpuPixels();
          if (!px.ok) return { ok: false, error: px.message, gpu: g.value };
          const tlIdx = (2 * options.width + 2) * 4;
          const brIdx = (options.height * options.width - 1) * 4;
          samples.push({
            presented: r.value.presented,
            topLeftScreen: tl,
            topLeftReadback: Array.from(px.value.slice(tlIdx, tlIdx + 4)),
            bottomRightScreen: br,
            bottomRightReadback: Array.from(px.value.slice(brIdx, brIdx + 4)),
            bytes: px.value.length,
          });
        }
        return { ok: true, gpu: g.value, samples };
      } finally {
        e.dispose();
        canvas.remove();
      }
    },

    /** The canvas renderer's drawing of the same rect (every layer on the page, over `background`). */
    async canvasRender(options: {
      pageId: string;
      rect: Rect;
      scale: number;
      width: number;
      height: number;
      background: string | null;
    }): Promise<string> {
      canvas ??= new CanvasRenderer(editor.scene, editor.measurer, { images: imagesFor(editor) });
      await canvas.images.ready(imageRefs(editor.doc, [options.pageId]), 30_000);
      const c = new OffscreenCanvas(options.width, options.height);
      const ctx = c.getContext("2d");
      if (!ctx) throw new Error("No 2D context");
      canvas.renderNodes(
        ctx,
        editor.doc.childIds(options.pageId),
        options.rect,
        options.scale,
        options.background,
        false,
        false,
      );
      return toBase64(
        new Uint8Array(ctx.getImageData(0, 0, options.width, options.height).data.buffer),
      );
    },

    /** A fresh display list of the page, base64: for drawing the same list with the Worker build. */
    list(
      pageId: string,
      ids?: string[],
      context?: boolean,
    ): {
      list: string;
      unsupported: Record<string, string[]>;
      records: number;
      supported: boolean;
      waiting: number;
    } {
      const cpu = engines.cpu;
      const uploaded = (cpu && uploadedByEngine.get(cpu)) || new Map();
      const b = builder(uploaded);
      const list = ids ? b.buildLayers(ids, { context }) : b.build(pageId);
      return {
        list: toBase64(list),
        unsupported: unsupportedOf(b),
        records: b.stats.records,
        supported: b.supported,
        waiting: b.waiting,
      };
    },

    /**
     * Two read-backs of one `width` × `height` GPU frame at once, with a GPU budget that has
     * room for the frames and one read-back's buffer: what each answers (the second must be
     * refused by the budget, not admitted beside the first).
     */
    async readbackPair(
      width: number,
      height: number,
      backend: "gpu" | "webgl" = "gpu",
    ): Promise<Array<{ ok: boolean; code?: number }>> {
      const mod = await moduleFor(backend);
      const px = width * height * 4;
      const row = Math.ceil((width * 4) / 256) * 256;
      // The atlas (2,048² RGBA8) and checker, two frames, the scratch tile with its depth buffer
      // (a budget this small keeps no tiles: frames are drawn tile by tile), and one read-back
      // buffer and a half.
      const scratch = 512 * 512 * 4 * 2;
      const budget =
        2048 * 2048 * 4 + 16 * 16 * 4 + 2 * px + scratch + Math.floor(row * height * 1.5);
      const e = new RenderEngine(mod, { gpuBytes: budget });
      try {
        const g = await e.attachGpu(null);
        if (!g.ok) return [{ ok: false, code: g.code }];
        const camera = { zoom: 1, x: 0, y: 0, dpr: 1 };
        const r = e.renderGpu(width, height, camera, [1, 1, 1, 1], false);
        if (!r.ok) return [{ ok: false, code: r.code }];
        const both = await Promise.all([e.gpuPixels(), e.gpuPixels()]);
        return both.map((b) => (b.ok ? { ok: true } : { ok: false, code: b.code }));
      } finally {
        e.dispose();
      }
    },

    /** The GPU the engine gets here, or why it gets none. */
    async gpu(
      compatibility = false,
      backend: "gpu" | "webgl" = "gpu",
    ): Promise<GpuInfo | { error: string }> {
      const e = await engineFor(backend, compatibility);
      return typeof e === "string" ? { error: e } : (e.gpu ?? { error: "no GPU" });
    },

    /**
     * Runs the reference Gaussian blur on CPU (full reference and pyramid) and GPU for the same
     * premultiplied RGBA8 input (for CPU-vs-GPU conformance tests).
     */
    async blurProbe(options: {
      src: string;
      srcWidth: number;
      srcHeight: number;
      dstWidth?: number;
      dstHeight?: number;
      dstOriginX?: number;
      dstOriginY?: number;
      sigma: number;
      edge?: BlurEdge;
      clampBounds?: BlurRect;
      dirty?: BlurRect;
      sourceId?: number;
      compatibility?: boolean;
    }): Promise<{
      ok: boolean;
      error?: string;
      cpuRef?: string;
      cpuPyr?: string;
      gpu?: string;
      stats?: BlurCacheStats;
      gpuInfo?: GpuInfo | null;
    }> {
      const e = await engineFor("gpu", options.compatibility ?? false);
      if (typeof e === "string") return { ok: false, error: e };
      const src = fromBase64(options.src);
      const common = {
        src,
        srcWidth: options.srcWidth,
        srcHeight: options.srcHeight,
        sigma: options.sigma,
        ...(options.dstWidth !== undefined ? { dstWidth: options.dstWidth } : {}),
        ...(options.dstHeight !== undefined ? { dstHeight: options.dstHeight } : {}),
        ...(options.dstOriginX !== undefined ? { dstOriginX: options.dstOriginX } : {}),
        ...(options.dstOriginY !== undefined ? { dstOriginY: options.dstOriginY } : {}),
        ...(options.edge !== undefined ? { edge: options.edge } : {}),
        ...(options.clampBounds !== undefined ? { clampBounds: options.clampBounds } : {}),
        ...(options.dirty !== undefined ? { dirty: options.dirty } : {}),
      };
      const cpuRef = e.blurCpu({ ...common, reference: true });
      if (!cpuRef.ok) return { ok: false, error: cpuRef.message };
      const cpuPyr = e.blurCpu({ ...common, reference: false });
      if (!cpuPyr.ok) return { ok: false, error: cpuPyr.message };
      const gpu = await e.blurGpu({
        ...common,
        ...(options.sourceId !== undefined ? { sourceId: options.sourceId } : {}),
      });
      if (!gpu.ok) return { ok: false, error: gpu.message, gpuInfo: e.gpu };
      const stats = e.blurGpuStats();
      return {
        ok: true,
        cpuRef: toBase64(cpuRef.value),
        cpuPyr: toBase64(cpuPyr.value),
        gpu: toBase64(gpu.value),
        ...(stats.ok ? { stats: stats.value } : {}),
        gpuInfo: e.gpu,
      };
    },

    /** Builds the page's list and times a patch from a one-layer change (the bench's numbers). */
    timeBuild(pageId: string): { buildMs: number; records: number; bytes: number } {
      const b = builder(new Map());
      const t0 = performance.now();
      const list = b.build(pageId);
      return { buildMs: performance.now() - t0, records: b.stats.records, bytes: list.length };
    },
  };
}
