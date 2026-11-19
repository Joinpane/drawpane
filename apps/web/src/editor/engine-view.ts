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
  type Camera,
  ErrorCode,
  loadBrowserEngine,
  RenderEngine,
  type Result,
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

export class EngineView {
  readonly canvas: HTMLCanvasElement;
  readonly #engine: RenderEngine;
  readonly #builder: DisplayListBuilder;
  readonly #images: ImageCache;
  /** Image refs whose pixels the engine holds, by handle. */
  readonly #uploaded = new Map<string, { handle: number; width: number; height: number }>();
  readonly #pending = new Set<string>();
  /** Read-back presentation: the 2D context frames are painted into, and the latest frame's number. */
  readonly #readback: CanvasRenderingContext2D | null;
  #frame = 0;
  #nextImage = 1;
  #offImages: () => void;
  #dead = false;
  /** Called after an engine-side change (an image arrived) that needs a frame. */
  onChange: () => void = () => {};
  /** Called once when the engine gives up for the session. */
  onFallback: (e: FallbackEvent) => void = () => {};
  /** The last frame's numbers, for the bench and the debug handle. */
  last = {
    ms: 0,
    patchMs: 0,
    records: 0,
    culled: 0,
    glyphsMasked: 0,
    glyphsOutlined: 0,
    supported: true,
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
      const readback = presentation() === "readback" ? canvas.getContext("2d") : null;
      const gpu = await engine.attachGpu(readback ? null : canvas, {
        compatibility: choice === "engine-compat",
        glyphMaskBytes: 32 << 20,
      });
      if (!gpu.ok) {
        engine.dispose();
        EngineView.#report({ reason: gpu.message, code: gpu.code, adapter: null });
        return null;
      }
      console.info(
        `Drawpane: drawing with the render engine on ${gpu.value.adapter}${gpu.value.fallback ? " (a software adapter)" : ""}`,
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

  #fail(r: Extract<Result, { ok: false }>): false {
    if (this.#dead) return false;
    this.#dead = true;
    const e = { reason: r.message, code: r.code, adapter: this.#engine.gpu?.adapter ?? null };
    EngineView.#report(e);
    this.onFallback(e);
    this.dispose();
    return false;
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
  }

  /**
   * Draws `pageId` under `camera` into the engine's canvas (`width` × `height` device pixels).
   * False when the canvas renderer must draw this frame: the page holds something the engine
   * doesn't draw, or the engine failed (and is off for the session).
   */
  draw(
    pageId: string,
    camera: { x: number; y: number; zoom: number },
    width: number,
    height: number,
    dpr: number,
    background: string,
    state: { hidden: ReadonlySet<string>; whole: string | null },
  ): boolean {
    if (this.#dead) return false;
    const t0 = performance.now();
    this.#builder.setEditorState(state);
    let message =
      this.#builder.pageId === pageId ? this.#builder.update() : this.#builder.build(pageId);
    if (message) {
      let r = this.#engine.apply(message);
      if (!r.ok && r.code === ErrorCode.Revision) {
        // Out of step (an earlier message was refused): start the page afresh.
        message = this.#builder.build(pageId);
        r = this.#engine.apply(message);
      }
      if (!r.ok) return this.#fail(r);
    }
    const t1 = performance.now();
    if (!this.#builder.supported) {
      this.last = { ...this.last, supported: false, patchMs: t1 - t0 };
      return false;
    }
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    const cam: Camera = { zoom: camera.zoom, x: camera.x, y: camera.y, dpr };
    const frame = this.#engine.renderGpu(width, height, cam, colour(background), true);
    if (!frame.ok) {
      // A layer the builder didn't flag but the engine refuses: this page draws on the canvas.
      if (frame.code === ErrorCode.Unsupported) {
        this.last = { ...this.last, supported: false };
        return false;
      }
      return this.#fail(frame);
    }
    const health = this.#engine.gpuCheck();
    if (!health.ok) return this.#fail(health);
    if (this.#readback) {
      const n = ++this.#frame;
      const ctx = this.#readback;
      void this.#engine.gpuPixels().then((px) => {
        // A later frame supersedes this one.
        if (!px.ok || n !== this.#frame || this.#dead) return;
        ctx.putImageData(
          new ImageData(
            new Uint8ClampedArray(
              px.value.buffer as ArrayBuffer,
              px.value.byteOffset,
              px.value.length,
            ),
            width,
            height,
          ),
          0,
          0,
        );
      });
    }
    this.last = {
      ms: performance.now() - t0,
      patchMs: t1 - t0,
      records: frame.value.records,
      culled: frame.value.culled,
      glyphsMasked: frame.value.glyphsMasked,
      glyphsOutlined: frame.value.glyphsOutlined,
      supported: true,
    };
    return true;
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
