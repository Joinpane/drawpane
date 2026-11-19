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
  type EngineModule,
  type FrameStats,
  type GpuInfo,
  loadBrowserEngine,
  RenderEngine,
  unsupportedNames,
} from "@drawpane/engine";
import { imagesFor } from "./media";

const toBase64 = (bytes: Uint8Array) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

export interface EngineRender {
  readonly ok: boolean;
  readonly error?: string;
  readonly code?: number;
  /** Straight RGBA8, base64. */
  readonly rgba?: string;
  /** Layers on the page the engine doesn't draw, by feature. */
  readonly unsupported: Record<string, string[]>;
  readonly stats?: FrameStats;
  /** Milliseconds: building the list, applying it, rendering (GPU: until the GPU finished). */
  readonly ms?: { build: number; apply: number; render: number };
  readonly gpu?: GpuInfo | null;
}

export function engineDebug(editor: Editor) {
  let module: EngineModule | null = null;
  const engines: Partial<Record<"cpu" | "gpu", RenderEngine>> = {};
  const uploaded = new Map<string, { handle: number; width: number; height: number }>();

  async function engineFor(
    backend: "cpu" | "gpu",
    compatibility: boolean,
  ): Promise<RenderEngine | string> {
    module ??= await loadBrowserEngine();
    const have = engines[backend];
    if (have && !have.dead) return have;
    const e = new RenderEngine(module, { glyphMaskBytes: 32 << 20 });
    if (backend === "gpu") {
      const r = await e.attachGpu(null, { compatibility });
      if (!r.ok) return `${r.message} (${r.code})`;
    }
    engines[backend] = e;
    uploaded.clear();
    return e;
  }

  /** Uploads every image the page's layers paint, once loaded, so the list can place them. */
  async function images(e: RenderEngine, pageId: string): Promise<void> {
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

  function builder(_pageId: string): DisplayListBuilder {
    return new DisplayListBuilder(editor.scene, editor.measurer, {
      image: (ref) => uploaded.get(ref) ?? null,
    });
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
      rect: Rect;
      scale: number;
      width: number;
      height: number;
      backend: "cpu" | "gpu";
      background?: [number, number, number, number];
      compatibility?: boolean;
    }): Promise<EngineRender> {
      const e = await engineFor(options.backend, options.compatibility ?? false);
      if (typeof e === "string") return { ok: false, error: e, unsupported: {} };
      await images(e, options.pageId);
      // Text whose face is still loading can't be outlined yet: the shaper starts loading it on
      // the first try. Wait for it (as the canvas's parity spec waits for fonts), up to 20 s.
      const make = () => {
        const b = builder(options.pageId);
        return { b, list: options.ids ? b.buildLayers(options.ids) : b.build(options.pageId) };
      };
      const loading = (b: DisplayListBuilder) =>
        [...b.unsupported.values()].some((bits) =>
          unsupportedNames(bits).includes("textWithoutOutlines"),
        );
      for (let waited = 0; waited < 20_000 && loading(make().b); waited += 100)
        await new Promise((r) => setTimeout(r, 100));
      const t0 = performance.now();
      // A fresh list replaces whatever the engine held, at any revision.
      const { b, list } = make();
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
      await e.gpuFinished();
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
    ): { list: string; unsupported: Record<string, string[]>; records: number } {
      const b = builder(pageId);
      const list = ids ? b.buildLayers(ids) : b.build(pageId);
      return { list: toBase64(list), unsupported: unsupportedOf(b), records: b.stats.records };
    },

    /** The GPU the engine gets here, or why it gets none. */
    async gpu(compatibility = false): Promise<GpuInfo | { error: string }> {
      const e = await engineFor("gpu", compatibility);
      return typeof e === "string" ? { error: e } : (e.gpu ?? { error: "no GPU" });
    },

    /** Builds the page's list and times a patch from a one-layer change (the bench's numbers). */
    timeBuild(pageId: string): { buildMs: number; records: number; bytes: number } {
      const b = builder(pageId);
      const t0 = performance.now();
      const list = b.build(pageId);
      return { buildMs: performance.now() - t0, records: b.stats.records, bytes: list.length };
    },
  };
}
