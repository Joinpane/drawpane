/**
 * The render engine on the editor's canvas (decision 0040, phase 1), behind a switch:
 * `?renderer=engine` in the URL, or `localStorage["drawpane:renderer"] = "engine"`
 * (`engine-compat` for WebGPU's compatibility feature level).
 *
 * The engine draws the page into a WebGPU canvas under the overlay. It's patched from the
 * document's change log and follows the camera every frame. A page holding anything the engine
 * doesn't draw yet (effects, masks, blends) is drawn by the canvas renderer instead, whole.
 * Missing WebGPU, an engine error or a lost device fall back to the canvas renderer for the
 * session, with a console note and a `drawpane:renderer-fallback` event (the telemetry hook):
 * the canvas is never left blank.
 */

import {
  DisplayListBuilder,
  type Editor,
  type ImageCache,
  type TextMeasurer,
} from "@drawpane/editor";
import {
  type AheadStats,
  type Camera,
  ErrorCode,
  type FrameStats,
  loadBrowserEngine,
  RenderEngine,
  unsupportedNames,
} from "@drawpane/engine";

export type RendererChoice = "canvas" | "engine" | "engine-compat";

/**
 * How frames reach the screen: through the WebGPU canvas (the product), or read back through
 * a buffer into a 2D canvas (`drawpane:engine-present` = "readback"). The second is for headless
 * browsers, where presenting a WebGPU canvas loses the device (SwiftShader on this VM, and the
 * GPU bench's NVIDIA driver on Modal): it's slow, and it exercises everything but presentation.
 */
export function presentation(): "webgpu" | "readback" {
  try {
    const v =
      new URL(window.location.href).searchParams.get("present") ??
      localStorage.getItem("drawpane:engine-present");
    return v === "readback" ? "readback" : "webgpu";
  } catch {
    return "webgpu";
  }
}

/**
 * Whether the engine may draw on a software WebGPU adapter (SwiftShader, llvmpipe):
 * `drawpane:engine-software` = "allow". Off by default: on one, a page of any size draws far
 * slower than the canvas renderer, so the canvas renderer draws instead. Headless tests allow it.
 */
function softwareAllowed(): boolean {
  try {
    return localStorage.getItem("drawpane:engine-software") === "allow";
  } catch {
    return false;
  }
}

interface AdapterLike {
  readonly isFallbackAdapter?: boolean;
  readonly info?: { readonly isFallbackAdapter?: boolean };
}

/**
 * Which WebGPU feature level the engine asks for: a hardware adapter at core level, else a
 * hardware one at compatibility level (some drivers offer only that, through OpenGL ES), else
 * a software one only when allowed. Answers the reason when there's none it may use.
 */
export async function adapterLevel(
  choice: RendererChoice,
): Promise<{ readonly compatibility: boolean } | { readonly reason: string }> {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(o?: object): Promise<unknown> } })
    .gpu;
  if (!gpu) return { reason: "this browser has no WebGPU" };
  const soft = (a: unknown) => {
    const x = a as AdapterLike | null;
    return !x || x.info?.isFallbackAdapter === true || x.isFallbackAdapter === true;
  };
  const ask = async (o: object) => {
    try {
      return await gpu.requestAdapter({ powerPreference: "high-performance", ...o });
    } catch {
      return null;
    }
  };
  const levels = choice === "engine-compat" ? [true] : [false, true];
  let any = false;
  for (const compatibility of levels) {
    const a = await ask(compatibility ? { featureLevel: "compatibility" } : {});
    if (a) any = true;
    if (a && !soft(a)) return { compatibility };
  }
  if (any && softwareAllowed()) return { compatibility: choice === "engine-compat" };
  return {
    reason: any
      ? "only a software WebGPU adapter is available (set drawpane:engine-software to allow it)"
      : "no WebGPU adapter",
  };
}

/** Which renderer the switch asks for. */
export function rendererChoice(): RendererChoice {
  try {
    const url = new URL(window.location.href).searchParams.get("renderer");
    const stored = localStorage.getItem("drawpane:renderer");
    const v = url ?? stored;
    return v === "engine" || v === "engine-compat" ? v : "canvas";
  } catch {
    return "canvas";
  }
}

export interface FallbackEvent {
  readonly reason: string;
  readonly code: ErrorCode | null;
  readonly adapter: string | null;
}

/** Fallbacks this session: once the engine fails, it stays off until the next session. */
let failed: FallbackEvent | null = null;

/** CSS colour (`#rrggbb[aa]`, or a canvas token) as straight RGBA floats. */
function colour(css: string): [number, number, number, number] {
  const m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(css.trim());
  if (!m) return [0.92, 0.92, 0.9, 1];
  const n = Number.parseInt(m[1] as string, 16);
  const a = m[2] ? Number.parseInt(m[2], 16) / 255 : 1;
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, a];
}

/** What a draw did. */
export interface EngineDraw {
  /** The engine drew this frame (false: the canvas renderer must). */
  readonly drawn: boolean;
  /** It's on screen now (presented). False while a read-back frame is on its way. */
  readonly ready: boolean;
  /**
   * No stand-ins and no level of detail: what an exact frame shows. While it's false, draw
   * again next frame: each draws more of the tiles still missing (decision 0040, phase 2).
   */
  readonly exact: boolean;
  /** Tiles round the view are still to draw ahead of a pan: an idle frame may draw them. */
  readonly ahead: boolean;
}

const NOT_DRAWN: EngineDraw = { drawn: false, ready: false, exact: false, ahead: false };

/**
 * Milliseconds a frame may spend drawing tiles beyond those nothing else can stand in for
 * (decision 0040, phase 2): little while the camera moves (tiles round the view are drawn
 * ahead), more once it rests, so the exact picture arrives within the 250 ms the freshness gate
 * allows without any one long frame.
 */
export const MOVING_BUDGET_MS = 4;
export const REST_BUDGET_MS = 12;
/**
 * Between frames at rest, the engine draws the tiles the next frame wants in slices this long
 * (`EngineView.ahead`): the time a page has between animation frames goes to the exact frame
 * too, not only each frame's budget. A frame's length at 60 Hz: the browser renders between
 * slices (on the T4 bench, ~8 ms each time), so fewer, longer slices settle sooner, and none
 * holds input back for more than a frame.
 */
export const IDLE_SLICE_MS = 16;

/** Frames in a row the canvas can't take before the engine gives up for the session. */
const UNPRESENTED = 3;

export class EngineView {
  readonly canvas: HTMLCanvasElement;
  readonly #engine: RenderEngine;
  readonly #builder: DisplayListBuilder;
  readonly #images: ImageCache;
  /** Image refs whose pixels the engine holds, by handle. */
  readonly #uploaded = new Map<string, { handle: number; width: number; height: number }>();
  readonly #pending = new Set<string>();
  /** Read-back presentation: the 2D context frames are painted into. */
  readonly #readback: CanvasRenderingContext2D | null;
  /** The latest frame drawn, the one being read back, and whether one is on its way. */
  #frame = 0;
  #reading = false;
  #want: { n: number; width: number; height: number; exact: boolean; epoch: number } | null = null;
  /**
   * Which presentation is current: moves on whenever a content frame isn't the engine's (the
   * canvas renderer draws it), the page changes or the size does. A read-back from an earlier
   * one is dropped when it lands: its pixels aren't written, its canvas isn't shown, and it's
   * never reported exact.
   */
  #epoch = 0;
  #presenting: { pageId: string; width: number; height: number } | null = null;
  #nextImage = 1;
  #offImages: () => void;
  #dead = false;
  #unpresented = 0;
  /** Pages the engine couldn't draw (so the page-level event fires once per change). */
  readonly #refused = new Set<string>();
  /** Called after an engine-side change (an image arrived) that needs a frame. */
  onChange: () => void = () => {};
  /** Called once when the engine gives up for the session. */
  onFallback: (e: FallbackEvent) => void = () => {};
  /** Called when a read-back frame reaches the screen, with whether it was exact. */
  onPresented: (exact: boolean) => void = () => {};
  /** What drawing between frames did, summed (`ahead`), for the bench and the debug handle. */
  idle = { slices: 0, tiles: 0, ms: 0 };
  /**
   * Set to an object by the bench: when the latest exact frame was drawn (submitted), when the
   * GPU finished it (no read-back involved), and when it was shown (a read-back painted; with a
   * WebGPU canvas, when it was drawn). Frame numbers tell them apart.
   */
  stamps: {
    drawn?: { n: number; at: number };
    gpu?: { n: number; at: number };
    shown?: { n: number; at: number };
  } | null = null;
  /** Set to a list by the bench: each frame and slice between frames, as it happens. */
  trace: Array<{
    t: number;
    k: "frame" | "idle" | "present";
    ms: number;
    tiles: number;
    pending: number;
    encode: number;
    render: number;
    misses: number;
    records: number;
    masked: number;
    outlined: number;
  }> | null = null;
  /** The last frame's numbers, for the bench and the debug handle. */
  last = {
    ms: 0,
    patchMs: 0,
    records: 0,
    culled: 0,
    glyphsMasked: 0,
    glyphsOutlined: 0,
    supported: true,
    exact: false,
    plan: "tiles" as FrameStats["plan"],
    tiles: { drawn: 0, pending: 0, queued: 0, held: 0, evicted: 0 } as FrameStats["tiles"],
    /** Where the frame's CPU time went: the patch, the engine's encoding, its renderer, submit. */
    breakdown: { patch: 0, encode: 0, render: 0, submit: 0, readback: 0 },
  };

  private constructor(
    canvas: HTMLCanvasElement,
    engine: RenderEngine,
    editor: Editor,
    measurer: TextMeasurer,
    images: ImageCache,
    readback: CanvasRenderingContext2D | null,
  ) {
    this.canvas = canvas;
    this.#readback = readback;
    this.#engine = engine;
    this.#images = images;
    this.#builder = new DisplayListBuilder(editor.scene, measurer, {
      image: (ref) => this.#image(ref),
    });
    this.#offImages = images.subscribe(() => this.#upload());
    // A device can be lost between frames (a driver reset, a headless browser presenting): find
    // out without waiting for the next frame, so an idle page never shows a dead canvas.
    this.#health = window.setInterval(() => {
      const r = this.#engine.gpuCheck();
      if (!r.ok) this.#fail(r);
    }, 250);
  }

  readonly #health: number;

  /** The engine on `canvas`, or null (with the reason reported) when it can't run here. */
  static async create(
    canvas: HTMLCanvasElement,
    editor: Editor,
    measurer: TextMeasurer,
    images: ImageCache,
    choice: RendererChoice,
  ): Promise<EngineView | null> {
    if (failed) return null;
    try {
      const module = await loadBrowserEngine();
      // The browser's GPU holds 32 MiB of glyph atlas (decision 0040, "Text").
      const engine = new RenderEngine(module, { glyphMaskBytes: 32 << 20 });
      if (engine.failure) {
        EngineView.#report({
          reason: engine.failure.message,
          code: engine.failure.code,
          adapter: null,
        });
        return null;
      }
      const level = await adapterLevel(choice);
      if ("reason" in level) {
        engine.dispose();
        EngineView.#report({ reason: level.reason, code: ErrorCode.NoAdapter, adapter: null });
        return null;
      }
      const readback = presentation() === "readback" ? canvas.getContext("2d") : null;
      const gpu = await engine.attachGpu(readback ? null : canvas, {
        compatibility: level.compatibility,
        glyphMaskBytes: 32 << 20,
      });
      if (!gpu.ok) {
        engine.dispose();
        EngineView.#report({ reason: gpu.message, code: gpu.code, adapter: null });
        return null;
      }
      console.info(
        `Drawpane: drawing with the render engine on ${gpu.value.adapter}${level.compatibility ? " (WebGPU compatibility mode)" : ""}${gpu.value.fallback ? " (a software adapter)" : ""}`,
      );
      return new EngineView(canvas, engine, editor, measurer, images, readback);
    } catch (err) {
      EngineView.#report({ reason: String(err), code: null, adapter: null });
      return null;
    }
  }

  static #report(e: FallbackEvent): void {
    failed = e;
    console.info(
      `Drawpane: the render engine is off for this session (${e.reason}); the canvas renderer draws instead.`,
    );
    window.dispatchEvent(
      new CustomEvent<FallbackEvent>("drawpane:renderer-fallback", { detail: e }),
    );
  }

  get engine(): RenderEngine {
    return this.#engine;
  }

  get builder(): DisplayListBuilder {
    return this.#builder;
  }

  /** Whether frames reach the screen through a read-back (headless browsers). */
  get readsBack(): boolean {
    return this.#readback !== null;
  }

  #fail(r: { readonly message: string; readonly code: ErrorCode | null }): EngineDraw {
    if (this.#dead) return NOT_DRAWN;
    this.#dead = true;
    const e = { reason: r.message, code: r.code, adapter: this.#engine.gpu?.adapter ?? null };
    EngineView.#report(e);
    this.onFallback(e);
    this.dispose();
    return NOT_DRAWN;
  }

  #image(ref: string) {
    const held = this.#uploaded.get(ref);
    if (held) return held;
    this.#pending.add(ref);
    // Starts its load; the cache tells us when it's ready.
    this.#images.natural(ref);
    return null;
  }

  /** Sends the engine every image the builder asked for that has finished loading. */
  #upload(): void {
    if (this.#dead) return;
    try {
      let any = false;
      for (const ref of this.#pending) {
        const natural = this.#images.natural(ref);
        const view = natural ? this.#images.get(ref) : null;
        if (!natural || !view) continue;
        const { bitmap } = view;
        const c = new OffscreenCanvas(bitmap.width, bitmap.height);
        const ctx = c.getContext("2d");
        if (!ctx) continue;
        ctx.drawImage(bitmap, 0, 0);
        const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
        const handle = this.#nextImage++;
        const r = this.#engine.putImage(
          handle,
          bitmap.width,
          bitmap.height,
          new Uint8Array(data.buffer),
          false,
        );
        if (!r.ok) {
          this.#fail(r);
          return;
        }
        this.#uploaded.set(ref, { handle, width: natural.width, height: natural.height });
        this.#pending.delete(ref);
        this.#builder.imageReady(ref);
        any = true;
      }
      if (any) this.onChange();
    } catch (err) {
      this.#fail({ message: String(err), code: null });
    }
  }

  /** Lets go of the images (and waits for images) no record on the page paints any more. */
  #dropUnused(): void {
    const used = this.#builder.imagesInUse();
    for (const [ref, held] of this.#uploaded) {
      if (used.has(ref)) continue;
      const r = this.#engine.dropImage(held.handle);
      if (!r.ok) return;
      this.#uploaded.delete(ref);
    }
    for (const ref of this.#pending) if (!used.has(ref)) this.#pending.delete(ref);
  }

  /** Applies the builder's next message, if any; false (and off for the session) if it can't. */
  #patch(pageId: string): boolean {
    let message =
      this.#builder.pageId === pageId ? this.#builder.update() : this.#builder.build(pageId);
    if (!message) return true;
    let r = this.#engine.apply(message);
    this.#builder.acknowledge(r.ok, this.#engine.revision);
    if (!r.ok && r.code === ErrorCode.Revision) {
      // Out of step (an earlier message was refused or lost): start the page afresh.
      message = this.#builder.build(pageId);
      r = this.#engine.apply(message);
      this.#builder.acknowledge(r.ok, this.#engine.revision);
    }
    if (!r.ok) {
      this.#fail(r);
      return false;
    }
    this.#dropUnused();
    return true;
  }

  /** Tells listeners once when a page falls back to the canvas renderer, and why. */
  #pageSupported(pageId: string, supported: boolean): void {
    if (supported) {
      this.#refused.delete(pageId);
      return;
    }
    if (this.#refused.has(pageId)) return;
    this.#refused.add(pageId);
    const features = this.unsupported();
    window.dispatchEvent(
      new CustomEvent("drawpane:renderer-page-fallback", { detail: { pageId, features } }),
    );
  }

  /**
   * Draws `pageId` under `camera` into the engine's canvas (`width` × `height` device pixels),
   * from the tiles the engine keeps (decision 0040, phase 2). `exact` says the camera rests;
   * otherwise it's moving, and tiles not drawn yet show stand-ins (a stale tile, another level
   * scaled, the last frame moved). `budgetMs` bounds the tiles drawn this frame beyond those
   * nothing can stand in for (0: none, so a frame at rest comes back exact). While the answer
   * isn't exact, draw again next frame. Not drawn when the canvas renderer must draw this
   * frame: the page holds something the engine doesn't draw, the canvas couldn't take the
   * frame, or the engine failed (and is off for the session).
   */
  draw(
    pageId: string,
    camera: { x: number; y: number; zoom: number },
    width: number,
    height: number,
    dpr: number,
    background: string,
    state: { hidden: ReadonlySet<string>; whole: string | null },
    exact = true,
    budgetMs = 0,
  ): EngineDraw {
    if (this.#dead) return NOT_DRAWN;
    const at = this.#presenting;
    if (!at || at.pageId !== pageId || at.width !== width || at.height !== height) {
      this.#supersede();
      this.#presenting = { pageId, width, height };
    }
    try {
      const r = this.#draw(pageId, camera, width, height, dpr, background, state, exact, budgetMs);
      // The canvas renderer draws this frame: nothing on its way from the engine may show.
      if (!r.drawn) this.#supersede();
      return r;
    } catch (err) {
      // Anything thrown on the way (the builder, a canvas call) is the engine's failure: the
      // canvas renderer takes over, never a blank or stale canvas.
      return this.#fail({ message: String(err), code: null });
    }
  }

  /**
   * Between frames at rest: draws tiles the next frame will want, for the frame last drawn, for
   * at most `budgetMs` (at least one tile), compositing and showing nothing (decision 0040,
   * phase 2). Answers what's left (`pending`: tiles the frame shows; `queued`: tiles round it)
   * and whether it drew any, or null when there's nothing to draw ahead for (the engine isn't
   * drawing, or failed: the next frame finds out).
   */
  ahead(background: string, budgetMs: number): AheadStats | null {
    if (this.#dead || !this.#presenting) return null;
    try {
      const r = this.#engine.renderGpuAhead(colour(background), budgetMs);
      if (!r.ok) {
        // A layer the engine refuses: the next frame draws this page on the canvas.
        if (r.code !== ErrorCode.Unsupported) this.#fail(r);
        return null;
      }
      this.idle = {
        slices: this.idle.slices + 1,
        tiles: this.idle.tiles + r.value.drawn,
        ms: this.idle.ms + r.value.ms,
      };
      this.trace?.push({
        t: performance.now(),
        k: "idle",
        ms: r.value.ms,
        tiles: r.value.drawn,
        pending: r.value.pending,
        encode: r.value.encodeMs,
        render: r.value.renderMs,
        misses: r.value.maskMisses,
        records: r.value.records,
        masked: r.value.glyphsMasked,
        outlined: r.value.glyphsOutlined,
      });
      return r.value;
    } catch (err) {
      this.#fail({ message: String(err), code: null });
      return null;
    }
  }

  /** Drops every read-back on its way: a newer content frame decided otherwise. */
  #supersede(): void {
    this.#epoch++;
    this.#want = null;
  }

  #draw(
    pageId: string,
    camera: { x: number; y: number; zoom: number },
    width: number,
    height: number,
    dpr: number,
    background: string,
    state: { hidden: ReadonlySet<string>; whole: string | null },
    exact: boolean,
    budgetMs: number,
  ): EngineDraw {
    const t0 = performance.now();
    this.#builder.setEditorState(state);
    if (!this.#patch(pageId)) return NOT_DRAWN;
    const t1 = performance.now();
    if (!this.#builder.supported) {
      this.last = { ...this.last, supported: false, patchMs: t1 - t0 };
      this.#pageSupported(pageId, false);
      return NOT_DRAWN;
    }
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    const cam: Camera = { zoom: camera.zoom, x: camera.x, y: camera.y, dpr };
    const frame = this.#engine.renderGpu(width, height, cam, colour(background), !exact, budgetMs);
    if (!frame.ok) {
      // A layer the builder didn't flag but the engine refuses: this page draws on the canvas.
      if (frame.code === ErrorCode.Unsupported) {
        this.last = { ...this.last, supported: false };
        this.#pageSupported(pageId, false);
        return NOT_DRAWN;
      }
      return this.#fail(frame);
    }
    this.#pageSupported(pageId, true);
    const health = this.#engine.gpuCheck();
    if (!health.ok) return this.#fail(health);
    const f = frame.value;
    if (!f.presented) {
      // The canvas couldn't take it now: the canvas renderer draws this frame; a few in a row
      // and the engine is off.
      if (++this.#unpresented >= UNPRESENTED)
        return this.#fail({ message: "the canvas stopped taking frames", code: ErrorCode.Gpu });
      return NOT_DRAWN;
    }
    this.#unpresented = 0;
    const n = ++this.#frame;
    const stamps = this.stamps;
    if (stamps && f.exact) {
      const at = performance.now();
      stamps.drawn = { n, at };
      if (!this.#readback) stamps.shown = { n, at };
      void this.#engine.gpuFinished().then(() => {
        if (this.stamps === stamps && stamps.drawn?.n === n)
          stamps.gpu = { n, at: performance.now() };
      });
    }
    if (this.#readback) {
      this.#want = { n, width, height, exact: f.exact, epoch: this.#epoch };
      this.#readNext();
    }
    this.last = {
      ms: performance.now() - t0,
      patchMs: t1 - t0,
      records: f.records,
      culled: f.culled,
      glyphsMasked: f.glyphsMasked,
      glyphsOutlined: f.glyphsOutlined,
      supported: true,
      exact: f.exact,
      plan: f.plan,
      tiles: f.tiles,
      breakdown: {
        ...this.last.breakdown,
        patch: t1 - t0,
        encode: f.ms.encode,
        render: f.ms.render,
        submit: f.ms.submit,
      },
    };
    this.trace?.push({
      t: performance.now(),
      k: "frame",
      ms: this.last.ms,
      tiles: f.tiles.drawn,
      pending: f.tiles.pending,
      encode: f.ms.encode,
      render: f.ms.render,
      misses: f.maskMisses,
      records: f.records,
      masked: f.glyphsMasked,
      outlined: f.glyphsOutlined,
    });
    // A WebGPU canvas shows the frame once it's presented; a read-back one when it lands.
    return {
      drawn: true,
      ready: this.#readback === null,
      exact: f.exact,
      ahead: f.tiles.queued > 0,
    };
  }

  /**
   * Reads the latest frame back into the 2D canvas: one read-back at a time, always of the
   * newest frame (frames drawn meanwhile are skipped, never queued). A failed one is the
   * engine's failure.
   */
  #readNext(): void {
    const want = this.#want;
    const ctx = this.#readback;
    if (this.#reading || !want || !ctx || this.#dead) return;
    this.#want = null;
    this.#reading = true;
    const t = performance.now();
    void this.#engine.gpuPixels().then((px) => {
      this.#reading = false;
      if (this.#dead) return;
      if (!px.ok) {
        // A read-back fails when the device goes, and its loss is told a moment later: wait for
        // it (the health check runs every 250 ms) so the cause is what's reported.
        window.setTimeout(() => {
          const health = this.#engine.gpuCheck();
          this.#fail(health.ok ? px : health);
        }, 300);
        return;
      }
      if (want.epoch !== this.#epoch || px.value.length !== want.width * want.height * 4) {
        // Superseded on its way (the canvas renderer drew a frame since, the page or the size
        // changed): dropped. The next read-back, if any, is of a frame drawn since.
        this.#readNext();
        return;
      }
      const p0 = performance.now();
      ctx.putImageData(
        new ImageData(
          new Uint8ClampedArray(
            px.value.buffer as ArrayBuffer,
            px.value.byteOffset,
            px.value.length,
          ),
          want.width,
          want.height,
        ),
        0,
        0,
      );
      this.trace?.push({
        t: performance.now(),
        k: "present",
        ms: performance.now() - p0,
        tiles: 0,
        pending: 0,
        encode: 0,
        render: 0,
        misses: 0,
        records: 0,
        masked: 0,
        outlined: 0,
      });
      this.last = {
        ...this.last,
        breakdown: { ...this.last.breakdown, readback: performance.now() - t },
      };
      // Exact only if it's still the newest frame drawn.
      if (this.stamps && want.exact && want.n === this.#frame)
        this.stamps.shown = { n: want.n, at: performance.now() };
      this.onPresented(want.exact && want.n === this.#frame);
      this.#readNext();
    });
  }

  /** What the page holds that the engine doesn't draw yet: feature names and layer counts. */
  unsupported(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const bits of this.#builder.unsupported.values())
      for (const name of unsupportedNames(bits)) out[name] = (out[name] ?? 0) + 1;
    return out;
  }

  dispose(): void {
    window.clearInterval(this.#health);
    this.#dead = true;
    this.#offImages();
    this.#engine.dispose();
  }
}

/** The fallback recorded this session, if any. */
export function engineFallback(): FallbackEvent | null {
  return failed;
}
