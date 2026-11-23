/**
 * The prototype stage: the device, the live screen inside it, and any overlays, animated with
 * the Web Animations API. It turns pointer and key input into player steps and plays each step;
 * the React page around it only draws chrome.
 *
 * Follows the existing renderer switch (`rendererChoice()`):
 * - `"canvas"` (default): draws screens and overlays synchronously with `CanvasRenderer`.
 * - engine choices (`"engine"`, `"engine-compat"`, `"engine-webgl"`, `"engine-cpu"`): draws
 *   the active screen live on its own `EngineView` (`webgpu -> webgl2 -> cpu-worker`), captures
 *   outgoing frames from the live GPU view during transitions, renders overlays through the
 *   engine snapshot service, and falls back per page to `CanvasRenderer` (or shows a clear
 *   unavailable state with disabled hotspots) whenever the engine cannot draw a screen.
 *
 * Plain DOM rather than React because transitions need two copies of a screen at once, with
 * exact control over when each appears and goes.
 */

import {
  CanvasRenderer,
  chainAt,
  type Editor,
  easingCss,
  type Hit,
  hotspotRects,
  type ImageCache,
  type OverlayLayer,
  type PlayerStep,
  type PrototypePlayer,
  reverseTransition,
  ShapingMeasurer,
  transitionFrames,
  transitionMs,
} from "@drawpane/editor";
import { MAX_SIDE } from "@drawpane/engine";
import {
  DEVICES,
  type DeviceId,
  getProp,
  type OverlayPosition,
  SafeUrl,
  type Transition,
} from "@drawpane/model";
import { isAbortError, renderEngineSnapshot } from "../editor/engine-snapshot";
import {
  EngineView,
  IDLE_SLICE_MS,
  REST_BUDGET_MS,
  type RendererChoice,
  rendererChoice,
} from "../editor/engine-view";
import { shaper } from "../editor/shaping";
import { watchDocumentFonts } from "../fonts/document-fonts";

/** Tap slop: a pointer that moves further than this is a drag. */
const DRAG_PX = 8;
/** The most canvas pixels one screen may use (keeps very tall screens within memory). */
const MAX_PIXELS = 24_000_000;
/** Bound how long a GPU transition waits on live `gpuPixels()` readback before proceeding. */
const GPU_CAPTURE_TIMEOUT_MS = 150;
/**
 * Maximum wait for an engine overlay's first paint before showing a CanvasRenderer fallback
 * (swapped to the engine render once it arrives). Keeps overlays responsive on slow/stuck Workers.
 */
const OVERLAY_FIRST_PAINT_DEADLINE_MS = 400;
/**
 * On a phone, fitting the whole screen may shrink it to this much of the
 * width-filling size (a 393 × 852 design in a 390 × 791 browser fits at 93%);
 * past that, the design is a long page, so it fills the width and scrolls.
 */
const PHONE_MIN_FIT = 0.85;
/**
 * Kept free below the device for the hint pill (Player's .present__hint):
 * 16px up from the bottom, 28px tall, and 16px of air above it.
 */
const HINT_CLEARANCE = 60;
/** Bezel and corner sizes by device kind, in device pixels. */
const CHROME = {
  none: { bezel: 0, radius: 0, inner: 0 },
  phone: { bezel: 12, radius: 56, inner: 44 },
  tablet: { bezel: 16, radius: 40, inner: 24 },
  desktop: { bezel: 0, radius: 10, inner: 10 },
} as const;

interface ScreenLayer {
  readonly root: string;
  /** Scrolls when the screen is taller than the viewport. */
  readonly el: HTMLDivElement;
  /** Owned canvas in canvas mode; omitted in engine mode where `#engineSlot` draws the screen. */
  readonly canvas?: HTMLCanvasElement;
  /** Device pixels per document unit, before the stage scale. */
  readonly contentScale: number;
}

interface OverlaySurface {
  readonly root: string;
  readonly el: HTMLDivElement;
  readonly canvas: HTMLCanvasElement;
  readonly contentScale: number;
  painted: boolean;
  painting: boolean;
  dirty: boolean;
  disposed: boolean;
  firstPaintTimer: ReturnType<typeof setTimeout> | null;
  onFirstPaint: (() => void) | null;
  onCleanup: (() => void) | null;
  abort: AbortController | null;
}

interface OverlayView {
  readonly overlay: OverlayLayer;
  readonly layer: OverlaySurface;
  readonly dim: HTMLDivElement;
}

export interface StageCallbacks {
  /** Something worth a hint happened: hotspots flashed, a destination is gone. */
  onHint?: (hint: "hotspots" | "nothing") => void;
  /** The current screen or overlays changed (after a step starts). */
  onChange?: () => void;
}

export interface StageOptions extends StageCallbacks {
  readonly editor: Editor;
  readonly images: ImageCache;
  readonly player: PrototypePlayer;
  readonly host: HTMLElement;
  readonly device: DeviceId;
  /** Override the renderer switch (for tests). Defaults to `rendererChoice()`. */
  readonly choice?: RendererChoice;
  /** Override the engine overlay first-paint canvas-fallback deadline (ms, for tests). */
  readonly overlayFirstPaintDeadlineMs?: number;
}

/**
 * The room a device has on a stage of `width` × `height`: a margin all
 * round (less on a narrow window), and at the bottom enough to keep it clear
 * of the hint pill, so a hint never crowds the bezel. The room is kept
 * whether or not a hint shows, so the device holds still as hints come and
 * go. `lift` is how much deeper the bottom margin is than the top: the
 * device takes it as its own bottom margin to centre in the room that's left.
 */
export function deviceRoom(width: number, height: number) {
  const margin = width < 600 ? 16 : 48;
  const bottom = Math.max(margin, HINT_CLEARANCE);
  return {
    width: Math.max(100, width - margin * 2),
    height: Math.max(100, height - margin - bottom),
    lift: bottom - margin,
  };
}

const reducedMotion = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

function topLevelOf(editor: Editor, id: string): string {
  let current = editor.doc.get(id);
  while (current) {
    const parent = editor.doc.get(current.parent);
    if (!parent || parent.type === "page") return current.id;
    current = parent;
  }
  return id;
}

export class PlayerStage {
  readonly #editor: Editor;
  readonly #images: ImageCache;
  readonly #player: PrototypePlayer;
  readonly #host: HTMLElement;
  readonly #callbacks: StageCallbacks;
  readonly #choice: RendererChoice;
  readonly #useEngine: boolean;
  readonly #overlayFirstPaintDeadlineMs: number;
  #device: DeviceId;

  readonly #deviceEl: HTMLDivElement;
  readonly #viewport: HTMLDivElement;
  readonly #engineSlot: HTMLDivElement;
  /** Dedicated child container owned by EngineView (`mountIntoSlot` calls `replaceChildren`). */
  readonly #engineMount: HTMLDivElement;
  readonly #placeholderCanvas: HTMLCanvasElement;
  readonly #fallbackCanvas: HTMLCanvasElement;
  readonly #unavailableEl: HTMLDivElement;

  /** Canvas renderer: eager in canvas mode, lazy fallback-only in engine mode. */
  #canvasRenderer: CanvasRenderer | null = null;
  #canvasRendererFailed = false;
  #engine: EngineView | null = null;
  #engineFailed = false;
  #usingFallbackCanvas = false;
  #screenDrawable = true;
  readonly #engineInit = new AbortController();
  #disposed = false;
  #idleOn = false;
  #idlePosted = false;
  #idlePageId: string | null = null;
  readonly #idle = new MessageChannel();
  #navGen = 0;

  #screen: ScreenLayer | null = null;
  #overlays: OverlayView[] = [];
  /** Viewport size in device pixels, and the scale that fits it in the host. */
  #vw = 0;
  #vh = 0;
  #scale = 1;
  readonly #animations = new Set<Animation>();
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
  #hover: { step: PlayerStep; rect: DOMRect } | null = null;
  #press: { x: number; y: number; dragged: boolean; root: string; chain: string[] } | null = null;
  #frame = 0;
  readonly #cleanup: (() => void)[] = [];

  constructor(options: StageOptions) {
    this.#editor = options.editor;
    this.#images = options.images;
    this.#player = options.player;
    this.#host = options.host;
    this.#device = options.device;
    this.#callbacks = options;
    this.#choice = options.choice ?? rendererChoice();
    this.#useEngine = this.#choice !== "canvas";
    this.#overlayFirstPaintDeadlineMs =
      options.overlayFirstPaintDeadlineMs ?? OVERLAY_FIRST_PAINT_DEADLINE_MS;

    if (this.#editor.measurer instanceof ShapingMeasurer) {
      this.#editor.measurer.setEngineText(this.#useEngine);
    }
    if (this.#useEngine) {
      shaper.preloadFallback();
    } else {
      this.#getCanvasRenderer();
    }

    this.#deviceEl = document.createElement("div");
    this.#deviceEl.className = "stage__device";
    this.#deviceEl.dataset.renderer = this.#useEngine ? "starting" : "canvas";
    this.#viewport = document.createElement("div");
    this.#viewport.className = "stage__viewport";

    this.#engineSlot = document.createElement("div");
    this.#engineSlot.className = "stage__engine-slot";
    this.#engineSlot.style.visibility = "visible";

    this.#engineMount = document.createElement("div");
    this.#engineMount.className = "stage__engine-mount";
    this.#engineMount.style.visibility = "visible";

    this.#placeholderCanvas = document.createElement("canvas");
    this.#placeholderCanvas.className = "stage__canvas";
    this.#fallbackCanvas = document.createElement("canvas");
    this.#fallbackCanvas.className = "stage__canvas";
    this.#fallbackCanvas.style.display = "none";

    this.#unavailableEl = document.createElement("div");
    this.#unavailableEl.className = "stage__unavailable";
    this.#unavailableEl.setAttribute("role", "status");
    this.#unavailableEl.style.display = "none";
    this.#unavailableEl.textContent = "This screen couldn't be rendered here.";

    if (this.#useEngine) {
      this.#engineSlot.append(
        this.#engineMount,
        this.#placeholderCanvas,
        this.#fallbackCanvas,
        this.#unavailableEl,
      );
    }
    this.#deviceEl.append(this.#viewport);
    this.#host.append(this.#deviceEl);

    const vp = this.#viewport;
    const on = <K extends keyof HTMLElementEventMap>(
      el: HTMLElement,
      type: K,
      fn: (e: HTMLElementEventMap[K]) => void,
    ) => {
      el.addEventListener(type, fn);
      this.#cleanup.push(() => el.removeEventListener(type, fn));
    };
    on(vp, "pointerdown", (e) => this.#down(e));
    on(vp, "pointermove", (e) => this.#move(e));
    on(vp, "pointerup", (e) => this.#up(e));
    on(vp, "pointercancel", () => {
      this.#press = null;
    });
    on(vp, "pointerleave", () => this.#leave());

    const resize = new ResizeObserver(() => this.layout());
    resize.observe(this.#host);
    this.#cleanup.push(() => resize.disconnect());
    this.#cleanup.push(this.#editor.doc.subscribe(() => this.invalidate()));
    this.#cleanup.push(this.#images.subscribe(() => this.invalidate()));
    this.#cleanup.push(watchDocumentFonts(this.#editor.doc));
    const fonts = () => {
      if (this.#editor.measurer instanceof ShapingMeasurer) this.#editor.measurer.invalidate();
      this.invalidate();
    };
    document.fonts?.addEventListener?.("loadingdone", fonts);
    this.#cleanup.push(() => document.fonts?.removeEventListener?.("loadingdone", fonts));
    // Text with OpenType features draws once its face is shaped.
    this.#cleanup.push(shaper.subscribe(() => this.invalidate()));

    this.#idle.port1.onmessage = () => {
      this.#idlePosted = false;
      const view = this.#engine;
      const pageId = this.#idlePageId;
      if (!this.#idleOn || !view || this.#disposed || !pageId) return;
      const a = view.ahead(pageId, "#ffffff", IDLE_SLICE_MS);
      if (!a?.progressed) {
        this.#idleOn = false;
        this.invalidate();
        return;
      }
      if (a.tiles === 0 && a.textVisible === 0) {
        this.#idleOn = false;
        this.#paintScreen();
      } else if (a.tiles > 0 || a.queued > 0 || a.text > 0 || a.inProgress) {
        this.#postIdle();
      } else {
        this.#idleOn = false;
      }
    };

    // Size the viewport first: a screen's scale depends on it.
    this.layout();
    this.#showScreen(this.#player.state.screen);
    this.#scheduleDelays();
    if (this.#useEngine) this.#startEngine();
  }

  #getCanvasRenderer(): CanvasRenderer | null {
    if (this.#canvasRenderer) return this.#canvasRenderer;
    if (this.#canvasRendererFailed) return null;
    try {
      this.#canvasRenderer = new CanvasRenderer(this.#editor.scene, this.#editor.measurer, {
        images: this.#images,
      });
      return this.#canvasRenderer;
    } catch {
      this.#canvasRendererFailed = true;
      return null;
    }
  }

  #postIdle(): void {
    if (this.#idlePosted || this.#disposed) return;
    this.#idlePosted = true;
    this.#idle.port2.postMessage(0);
  }

  #startEngine(): void {
    void EngineView.create(
      this.#engineMount,
      this.#editor,
      this.#editor.measurer,
      this.#images,
      this.#choice,
      this.#engineInit.signal,
    ).then((view) => {
      if (this.#disposed || this.#engineInit.signal.aborted) {
        view?.dispose();
        return;
      }
      this.#engine = view;
      if (!view) {
        this.#engineFailed = true;
        this.#paintScreen();
        return;
      }
      this.#placeholderCanvas.style.display = "none";
      this.#styleEngineCanvas(view.canvas);
      view.onCanvas = (next) => {
        this.#styleEngineCanvas(next);
        this.invalidate();
      };
      view.onBackendChange = () => this.#syncRendererAttrs();
      view.onRecovering = () => {
        this.#syncRendererAttrs();
        this.invalidate();
      };
      view.onChange = () => this.invalidate();
      view.onPresented = () => this.#syncRendererAttrs();
      view.onFallback = () => {
        this.#engine = null;
        this.#engineFailed = true;
        this.#paintScreen();
      };
      this.#syncRendererAttrs();
      this.invalidate();
    });
  }

  #styleEngineCanvas(canvas: HTMLCanvasElement): void {
    canvas.className = "stage__canvas";
    canvas.style.visibility = "visible";
    if (this.#engineSlot.style.width) canvas.style.width = this.#engineSlot.style.width;
    if (this.#engineSlot.style.height) canvas.style.height = this.#engineSlot.style.height;
  }

  #syncRendererAttrs(): void {
    if (!this.#useEngine) {
      this.#deviceEl.dataset.renderer = "canvas";
      this.#deviceEl.dataset.rendererAdapter = "";
      return;
    }
    if (!this.#screenDrawable) {
      this.#deviceEl.dataset.renderer = "unavailable";
      this.#deviceEl.dataset.rendererAdapter = "";
      return;
    }
    if (this.#usingFallbackCanvas) {
      this.#deviceEl.dataset.renderer = "canvas-fallback";
      this.#deviceEl.dataset.rendererAdapter = "";
      return;
    }
    const view = this.#engine;
    this.#deviceEl.dataset.renderer = view
      ? view.backend
      : this.#engineFailed
        ? "unavailable"
        : "starting";
    this.#deviceEl.dataset.rendererAdapter = view ? view.adapter : "";
  }

  #activeCanvas(): HTMLCanvasElement {
    if (this.#usingFallbackCanvas) return this.#fallbackCanvas;
    return this.#engine?.canvas ?? this.#placeholderCanvas;
  }

  destroy(): void {
    this.#disposed = true;
    this.#navGen++;
    this.#idleOn = false;
    this.#idle.port1.close();
    this.#engineInit.abort();
    cancelAnimationFrame(this.#frame);
    for (const fn of this.#cleanup) fn();
    for (const t of this.#timers.values()) clearTimeout(t);
    for (const a of this.#animations) a.cancel();
    for (const view of this.#overlays) this.#disposeOverlayLayer(view.layer);
    this.#engine?.dispose();
    this.#engine = null;
    this.#deviceEl.remove();
  }

  setDevice(device: DeviceId): void {
    if (device === this.#device) return;
    this.#device = device;
    this.#rebuild();
  }

  /** Puts the player's current state on screen without animating (restart, flow change). */
  reset(): void {
    this.#hover = null;
    this.#rebuild();
    this.#scheduleDelays();
    this.#callbacks.onChange?.();
  }

  /** Repaints on the next frame (the document or an image changed). */
  invalidate(): void {
    if (this.#disposed) return;
    cancelAnimationFrame(this.#frame);
    this.#frame = requestAnimationFrame(() => this.#paintAll());
  }

  // -------------------------------------------------------------------------
  // Layout and painting

  #frameSize(id: string): { width: number; height: number } {
    const props = this.#editor.doc.get(id)?.props ?? {};
    return {
      width: Math.max(1, getProp(props, "width")),
      height: Math.max(1, getProp(props, "height")),
    };
  }

  /** Recomputes the viewport for the device and the start screen, and the scale that fits the host. */
  layout(): void {
    const device = DEVICES[this.#device];
    const start = this.#frameSize(this.#player.start);
    this.#vw = device.kind === "none" ? start.width : device.width;
    this.#vh = device.kind === "none" ? start.height : device.height;
    const box = this.#host.getBoundingClientRect();
    // On a phone, the phone is the device: no bezel, and the whole screen in
    // view, so a bar pinned to the bottom of the design isn't cut off by the
    // browser's own bars. Only a design much taller than the phone (a long
    // page with no device) fits the width and scrolls instead.
    if (box.width < 520 && box.width > 0 && box.height > 0) {
      const byWidth = box.width / this.#vw;
      const byHeight = box.height / this.#vh;
      const whole = byHeight >= byWidth * PHONE_MIN_FIT;
      this.#scale = whole ? Math.min(byWidth, byHeight) : byWidth;
      if (!whole) this.#vh = box.height / this.#scale;
      this.#deviceEl.dataset.kind = "none";
      const d = this.#deviceEl.style;
      d.marginBottom = "";
      d.setProperty("--bezel", "0px");
      d.setProperty("--radius", "0px");
      d.setProperty("--inner", "0px");
      this.#viewport.style.width = `${this.#vw * this.#scale}px`;
      this.#viewport.style.height = `${this.#vh * this.#scale}px`;
      this.#paintAll();
      return;
    }
    const chrome = CHROME[device.kind];
    const room = deviceRoom(box.width, box.height);
    const availW = room.width;
    const availH = room.height;
    const outerW = this.#vw + chrome.bezel * 2;
    const outerH = this.#vh + chrome.bezel * 2;
    // Never enlarge a design past its real size; shrink to fit.
    let scale = Math.min(1, availW / outerW, availH / outerH);
    // Very long screens with no device: fit the width and let the page scroll.
    if (device.kind === "none" && this.#vh * scale > availH) {
      scale = Math.min(1, availW / outerW);
      this.#vh = Math.max(100, availH / scale);
    }
    this.#scale = scale;
    const d = this.#deviceEl.style;
    this.#deviceEl.dataset.kind = device.kind;
    d.marginBottom = `${room.lift}px`;
    d.setProperty("--bezel", `${chrome.bezel * scale}px`);
    d.setProperty("--radius", `${chrome.radius * scale}px`);
    d.setProperty("--inner", `${chrome.inner * scale}px`);
    this.#viewport.style.width = `${this.#vw * scale}px`;
    this.#viewport.style.height = `${this.#vh * scale}px`;
    this.#paintAll();
  }

  #contentScale(root: string, base?: ScreenLayer): number {
    if (base) return base.contentScale;
    if (DEVICES[this.#device].kind === "none") return 1;
    return this.#vw / this.#frameSize(root).width;
  }

  #screenMetrics(root: string, contentScale: number) {
    const size = this.#frameSize(root);
    const css = contentScale * this.#scale;
    let dpr = window.devicePixelRatio || 1;
    const pixels = size.width * size.height * (css * dpr) ** 2;
    if (pixels > MAX_PIXELS) dpr *= Math.sqrt(MAX_PIXELS / pixels);
    if (this.#useEngine) {
      const longest = Math.max(size.width * css * dpr, size.height * css * dpr);
      if (longest > MAX_SIDE) dpr *= MAX_SIDE / longest;
    }
    const rawWidth = Math.max(1, Math.round(size.width * css * dpr));
    const rawHeight = Math.max(1, Math.round(size.height * css * dpr));
    const width = this.#useEngine ? Math.min(MAX_SIDE, rawWidth) : rawWidth;
    const height = this.#useEngine ? Math.min(MAX_SIDE, rawHeight) : rawHeight;
    return {
      size,
      css,
      dpr,
      width,
      height,
      cssWidth: size.width * css,
      cssHeight: size.height * css,
    };
  }

  #paintCanvasSurface(root: string, contentScale: number, canvas: HTMLCanvasElement): boolean {
    const renderer = this.#getCanvasRenderer();
    const bounds = this.#editor.scene.bounds(root);
    const m = this.#screenMetrics(root, contentScale);
    if (canvas.width !== m.width || canvas.height !== m.height) {
      canvas.width = m.width;
      canvas.height = m.height;
    }
    canvas.style.width = `${m.cssWidth}px`;
    canvas.style.height = `${m.cssHeight}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx || !bounds || !renderer) return false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    renderer.renderNodes(
      ctx,
      [root],
      { x: bounds.x, y: bounds.y, width: m.size.width, height: m.size.height },
      m.css * m.dpr,
    );
    return true;
  }

  /**
   * Falls back per page to CanvasRenderer when the engine cannot draw a screen, or hides stale
   * pixels and shows an explicit unavailable state with hotspots disabled.
   */
  #paintScreenFallback(layer: ScreenLayer): void {
    this.#engineMount.style.display = "none";
    this.#placeholderCanvas.style.display = "none";
    const drew = this.#paintCanvasSurface(layer.root, layer.contentScale, this.#fallbackCanvas);
    if (drew) {
      this.#usingFallbackCanvas = true;
      this.#screenDrawable = true;
      this.#fallbackCanvas.style.display = "block";
      this.#unavailableEl.style.display = "none";
    } else {
      this.#usingFallbackCanvas = false;
      this.#screenDrawable = false;
      this.#fallbackCanvas.style.display = "none";
      const ctx = this.#fallbackCanvas.getContext("2d");
      ctx?.clearRect(0, 0, this.#fallbackCanvas.width, this.#fallbackCanvas.height);
      this.#unavailableEl.style.display = "grid";
    }
    this.#syncRendererAttrs();
  }

  #paintScreen(): void {
    const layer = this.#screen;
    if (!layer || !this.#editor.doc.has(layer.root)) return;

    if (!this.#useEngine) {
      if (layer.canvas) {
        this.#screenDrawable = this.#paintCanvasSurface(
          layer.root,
          layer.contentScale,
          layer.canvas,
        );
      }
      this.#syncRendererAttrs();
      return;
    }

    const bounds = this.#editor.scene.bounds(layer.root);
    const page = this.#editor.doc.pageOf(layer.root);
    const m = this.#screenMetrics(layer.root, layer.contentScale);
    this.#engineSlot.style.width = `${m.cssWidth}px`;
    this.#engineSlot.style.height = `${m.cssHeight}px`;

    if (this.#engineFailed) {
      this.#paintScreenFallback(layer);
      return;
    }

    if (!this.#engine) {
      this.#placeholderCanvas.style.display = "block";
      this.#placeholderCanvas.style.width = `${m.cssWidth}px`;
      this.#placeholderCanvas.style.height = `${m.cssHeight}px`;
      if (
        this.#placeholderCanvas.width !== m.width ||
        this.#placeholderCanvas.height !== m.height
      ) {
        this.#placeholderCanvas.width = m.width;
        this.#placeholderCanvas.height = m.height;
      }
      this.#fallbackCanvas.style.display = "none";
      this.#unavailableEl.style.display = "none";
      this.#usingFallbackCanvas = false;
      this.#screenDrawable = true;
      this.#syncRendererAttrs();
      return;
    }

    if (!bounds || !page) return;
    const engineCanvas = this.#engine.canvas;
    this.#engineMount.style.width = `${m.cssWidth}px`;
    this.#engineMount.style.height = `${m.cssHeight}px`;
    engineCanvas.style.width = `${m.cssWidth}px`;
    engineCanvas.style.height = `${m.cssHeight}px`;
    const topRoot = topLevelOf(this.#editor, layer.root);
    const hidden = new Set(this.#editor.doc.childIds(page.id).filter((id) => id !== topRoot));
    this.#idleOn = false;
    const res = this.#engine.draw(
      page.id,
      { x: -bounds.x * m.css, y: -bounds.y * m.css, zoom: m.css },
      m.width,
      m.height,
      m.dpr,
      "#ffffff",
      { hidden, whole: null },
      true,
      REST_BUDGET_MS,
    );
    if (!res.drawn) {
      this.#paintScreenFallback(layer);
      return;
    }
    this.#usingFallbackCanvas = false;
    this.#screenDrawable = true;
    this.#fallbackCanvas.style.display = "none";
    this.#unavailableEl.style.display = "none";
    this.#placeholderCanvas.style.display = "none";
    this.#engineMount.style.display = "block";
    engineCanvas.style.display = "block";
    this.#syncRendererAttrs();
    if ((!res.exact && !res.settled) || res.ahead) {
      this.#idleOn = true;
      this.#idlePageId = page.id;
      this.#postIdle();
    }
  }

  #makeOverlay(root: string, base?: ScreenLayer): OverlaySurface {
    const el = document.createElement("div");
    el.className = "stage__overlay";
    el.dataset.painted = "false";
    const canvas = document.createElement("canvas");
    canvas.className = "stage__canvas";
    el.append(canvas);
    const layer: OverlaySurface = {
      root,
      el,
      canvas,
      contentScale: this.#contentScale(root, base),
      painted: false,
      painting: false,
      dirty: false,
      disposed: false,
      firstPaintTimer: null,
      onFirstPaint: null,
      onCleanup: null,
      abort: null,
    };
    this.#paintOverlay(layer);
    return layer;
  }

  #clearOverlayFirstPaintTimer(layer: OverlaySurface): void {
    if (layer.firstPaintTimer !== null) {
      clearTimeout(layer.firstPaintTimer);
      layer.firstPaintTimer = null;
    }
  }

  #markOverlayPainted(layer: OverlaySurface): void {
    this.#clearOverlayFirstPaintTimer(layer);
    const wasPainted = layer.painted;
    layer.painted = true;
    layer.el.dataset.painted = "true";
    layer.el.style.visibility = "";
    if (!wasPainted && layer.onFirstPaint) {
      const cb = layer.onFirstPaint;
      layer.onFirstPaint = null;
      cb();
    }
  }

  #disposeOverlayLayer(layer: OverlaySurface): void {
    layer.disposed = true;
    layer.dirty = false;
    layer.painting = false;
    this.#clearOverlayFirstPaintTimer(layer);
    layer.abort?.abort();
    layer.abort = null;
    layer.onFirstPaint = null;
    if (layer.onCleanup) {
      const cleanup = layer.onCleanup;
      layer.onCleanup = null;
      cleanup();
    }
  }

  #paintOverlay(layer: OverlaySurface): void {
    if (this.#disposed || layer.disposed) return;
    if (!this.#useEngine) {
      const drew = this.#paintCanvasSurface(layer.root, layer.contentScale, layer.canvas);
      if (drew) this.#markOverlayPainted(layer);
      return;
    }
    const bounds = this.#editor.scene.bounds(layer.root);
    const m = this.#screenMetrics(layer.root, layer.contentScale);
    const { canvas } = layer;
    canvas.style.width = `${m.cssWidth}px`;
    canvas.style.height = `${m.cssHeight}px`;
    if (!bounds) return;
    // Keep at most one snapshot in flight and coalesce subsequent invalidations behind a dirty
    // flag so continuous document edits never starve the overlay's paint.
    if (layer.painting) {
      layer.dirty = true;
      return;
    }
    layer.painting = true;
    layer.dirty = false;
    if (!layer.painted && layer.firstPaintTimer === null && this.#overlayFirstPaintDeadlineMs > 0) {
      layer.firstPaintTimer = setTimeout(() => {
        layer.firstPaintTimer = null;
        if (this.#disposed || layer.disposed || layer.painted) return;
        const drew = this.#paintCanvasSurface(layer.root, layer.contentScale, canvas);
        if (drew) this.#markOverlayPainted(layer);
      }, this.#overlayFirstPaintDeadlineMs);
    }
    const abort = new AbortController();
    layer.abort = abort;
    void renderEngineSnapshot(this.#editor, {
      ids: [layer.root],
      rect: { x: bounds.x, y: bounds.y, width: m.size.width, height: m.size.height },
      width: m.width,
      height: m.height,
      scale: m.css * m.dpr,
      format: "png",
      background: null,
      context: false,
      images: this.#images,
      priority: "normal",
      signal: abort.signal,
    })
      .then(async (blob) => {
        if (abort.signal.aborted || this.#disposed || layer.disposed) return;
        const bitmap = await createImageBitmap(blob);
        try {
          if (abort.signal.aborted || this.#disposed || layer.disposed) return;
          if (canvas.width !== m.width || canvas.height !== m.height) {
            canvas.width = m.width;
            canvas.height = m.height;
          }
          const ctx = canvas.getContext("2d");
          if (!ctx) return;
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
          this.#markOverlayPainted(layer);
        } finally {
          bitmap.close();
        }
      })
      .catch((error) => {
        if (abort.signal.aborted || this.#disposed || layer.disposed || isAbortError(error)) return;
        this.#clearOverlayFirstPaintTimer(layer);
        const drew = this.#paintCanvasSurface(layer.root, layer.contentScale, canvas);
        if (drew) this.#markOverlayPainted(layer);
      })
      .finally(() => {
        if (layer.abort !== abort) return;
        layer.abort = null;
        layer.painting = false;
        if (!this.#disposed && !layer.disposed && layer.dirty) {
          layer.dirty = false;
          this.#paintOverlay(layer);
        }
      });
  }

  #paintAll(): void {
    this.#frame = 0;
    this.#paintScreen();
    for (const view of this.#overlays) {
      this.#paintOverlay(view.layer);
      this.#placeOverlay(view);
    }
  }

  #rebuild(): void {
    this.#navGen++;
    this.#finishAnimations();
    for (const view of this.#overlays) this.#disposeOverlayLayer(view.layer);
    // Keep the live EngineView slot detached across viewport rebuilds rather than discarding it.
    if (this.#useEngine) this.#engineSlot.remove();
    this.#viewport.replaceChildren();
    this.#overlays = [];
    this.#screen = null;
    this.layout();
    this.#showScreen(this.#player.state.screen);
    for (const overlay of this.#player.state.overlays) this.#openOverlay(overlay, false);
  }

  #showScreen(root: string): ScreenLayer {
    const el = document.createElement("div");
    el.className = "stage__screen";
    let layer: ScreenLayer;
    if (this.#useEngine) {
      el.append(this.#engineSlot);
      layer = { root, el, contentScale: this.#contentScale(root) };
    } else {
      const canvas = document.createElement("canvas");
      canvas.className = "stage__canvas";
      el.append(canvas);
      layer = { root, el, canvas, contentScale: this.#contentScale(root) };
    }
    this.#viewport.prepend(layer.el);
    this.#screen = layer;
    this.#paintScreen();
    return layer;
  }

  #overlayRect(view: { overlay: OverlayLayer; layer: OverlaySurface }): {
    left: number;
    top: number;
    width: number;
    height: number;
  } {
    const size = this.#frameSize(view.layer.root);
    const s = view.layer.contentScale * this.#scale;
    const width = size.width * s;
    const height = size.height * s;
    const vw = this.#vw * this.#scale;
    const vh = this.#vh * this.#scale;
    const [v, h] = positionParts(view.overlay.position);
    const left = h === "left" ? 0 : h === "right" ? vw - width : (vw - width) / 2;
    const top = v === "top" ? 0 : v === "bottom" ? vh - height : (vh - height) / 2;
    return { left, top, width, height };
  }

  #placeOverlay(view: OverlayView): void {
    const r = this.#overlayRect(view);
    view.layer.el.style.left = `${r.left}px`;
    view.layer.el.style.top = `${r.top}px`;
  }

  // -------------------------------------------------------------------------
  // Steps

  /** Plays a step the player produced. */
  play(step: PlayerStep | null): void {
    if (!step) return;
    this.#finishAnimations();
    switch (step.type) {
      case "navigate":
        this.#navigate(step);
        break;
      case "open-overlay":
        this.#openOverlay(step.overlay, true);
        break;
      case "close-overlay":
        this.#closeOverlay(step.overlay);
        break;
      case "swap-overlay":
        this.#swapOverlay(step);
        break;
      case "open-url":
        if (SafeUrl.safeParse(step.url).success)
          window.open(step.url, step.newTab ? "_blank" : "_top", "noopener,noreferrer");
        break;
    }
    this.#scheduleDelays();
    this.#callbacks.onChange?.();
  }

  #timing(transition: Transition): KeyframeAnimationOptions | null {
    if (transition.type === "instant") return null;
    if (reducedMotion()) return { duration: 120, easing: "linear", fill: "both" };
    return {
      duration: transitionMs(transition),
      easing: easingCss(transition.easing),
      fill: "both",
    };
  }

  /** Under reduced motion every transition becomes a short dissolve. */
  #effective(transition: Transition): Transition {
    return reducedMotion() && transition.type !== "instant"
      ? { ...transition, type: "dissolve" }
      : transition;
  }

  #animate(el: HTMLElement, frames: Keyframe[] | null, timing: KeyframeAnimationOptions | null) {
    if (!frames || !timing) return null;
    const animation = el.animate(frames, timing);
    this.#animations.add(animation);
    const done = () => this.#animations.delete(animation);
    animation.finished.then(done, done);
    return animation;
  }

  #finishAnimations(): void {
    for (const a of [...this.#animations]) a.finish();
  }

  #makeOutgoingCanvas(old: ScreenLayer): HTMLCanvasElement {
    const m = this.#screenMetrics(old.root, old.contentScale);
    const snap = document.createElement("canvas");
    snap.className = "stage__canvas stage__outgoing";
    snap.width = m.width;
    snap.height = m.height;
    snap.style.width = `${m.cssWidth}px`;
    snap.style.height = `${m.cssHeight}px`;
    return snap;
  }

  #runNavigationAnimation(
    old: ScreenLayer,
    next: ScreenLayer,
    transition: Transition,
    timing: KeyframeAnimationOptions,
  ): void {
    const size = { width: this.#vw * this.#scale, height: this.#vh * this.#scale };
    const frames = transitionFrames(transition, size);
    // The one that moves over the other paints on top. Stacking rather than
    // reordering the DOM keeps the old screen's scroll position.
    old.el.style.zIndex = frames.top === "outgoing" ? "2" : "1";
    next.el.style.zIndex = frames.top === "outgoing" ? "1" : "2";
    old.el.style.pointerEvents = "none";
    const incoming = this.#animate(next.el, frames.incoming, timing);
    const outgoing = this.#animate(old.el, frames.outgoing, timing);
    const remove = () => {
      old.el.remove();
      next.el.style.zIndex = "";
    };
    const last = outgoing ?? incoming;
    if (last) last.finished.then(remove, remove);
    else remove();
  }

  #navigate(step: Extract<PlayerStep, { type: "navigate" }>): void {
    const navGen = ++this.#navGen;
    // Overlays close with the navigation, at once.
    for (const view of this.#overlays) {
      this.#disposeOverlayLayer(view.layer);
      view.layer.el.remove();
      view.dim.remove();
    }
    this.#overlays = [];
    this.#hover = null;
    const old = this.#screen;
    const transition = this.#effective(step.transition);
    const timing = this.#timing(transition);

    if (!old || !timing) {
      this.#showScreen(step.to);
      old?.el.remove();
      return;
    }

    if (!this.#useEngine) {
      const next = this.#showScreen(step.to);
      this.#runNavigationAnimation(old, next, transition, timing);
      return;
    }

    // Engine mode: capture the outgoing screen from the live view BEFORE `#showScreen` draws into
    // `#engineSlot` (direct-present GPU queues `gpuPixels()` synchronously from the GPU render
    // target and resolves before animating so the outgoing screen is never blank).
    const snap = this.#makeOutgoingCanvas(old);
    const ctx = snap.getContext("2d");

    if (this.#usingFallbackCanvas) {
      if (ctx) {
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, snap.width, snap.height);
        if (this.#fallbackCanvas.width > 0 && this.#fallbackCanvas.height > 0) {
          ctx.drawImage(this.#fallbackCanvas, 0, 0, snap.width, snap.height);
        }
      }
      old.el.prepend(snap);
      const next = this.#showScreen(step.to);
      this.#runNavigationAnimation(old, next, transition, timing);
      return;
    }

    const capture = this.#engine?.captureFrame() ?? null;
    if (capture && "sync" in capture) {
      if (ctx) {
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, snap.width, snap.height);
        if (capture.sync.width > 0 && capture.sync.height > 0) {
          ctx.drawImage(capture.sync, 0, 0, snap.width, snap.height);
        }
      }
      old.el.prepend(snap);
      const next = this.#showScreen(step.to);
      this.#runNavigationAnimation(old, next, transition, timing);
      return;
    }

    if (capture && "async" in capture) {
      const bounded = new Promise<{
        readonly width: number;
        readonly height: number;
        readonly pixels: Uint8Array;
      } | null>((resolve) => {
        let settled = false;
        const finish = (
          value: {
            readonly width: number;
            readonly height: number;
            readonly pixels: Uint8Array;
          } | null,
        ) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        };
        const timer = setTimeout(() => finish(null), GPU_CAPTURE_TIMEOUT_MS);
        void capture.async.then(finish, () => finish(null));
      });
      void bounded.then((frame) => {
        if (this.#disposed || navGen !== this.#navGen) return;
        if (ctx) {
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(0, 0, snap.width, snap.height);
          if (frame) {
            const clamped = new Uint8ClampedArray(frame.pixels.length);
            clamped.set(frame.pixels);
            const img = new ImageData(clamped, frame.width, frame.height);
            if (frame.width === snap.width && frame.height === snap.height) {
              ctx.putImageData(img, 0, 0);
            } else {
              const tmp = document.createElement("canvas");
              tmp.width = frame.width;
              tmp.height = frame.height;
              tmp.getContext("2d")?.putImageData(img, 0, 0);
              ctx.drawImage(tmp, 0, 0, snap.width, snap.height);
            }
          } else {
            const liveCanvas = this.#activeCanvas();
            try {
              if (liveCanvas.width > 0 && liveCanvas.height > 0) {
                ctx.drawImage(liveCanvas, 0, 0, snap.width, snap.height);
              }
            } catch {
              // Ignore swapchain read failures on timeout fallback.
            }
          }
        }
        old.el.prepend(snap);
        const next = this.#showScreen(step.to);
        this.#runNavigationAnimation(old, next, transition, timing);
      });
      return;
    }

    // No live frame available yet (e.g. engine still starting): copy canvas if any and transition.
    if (ctx) {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, snap.width, snap.height);
      const liveCanvas = this.#activeCanvas();
      try {
        if (liveCanvas.width > 0 && liveCanvas.height > 0) {
          ctx.drawImage(liveCanvas, 0, 0, snap.width, snap.height);
        }
      } catch {
        // Blank placeholder during startup.
      }
    }
    old.el.prepend(snap);
    const next = this.#showScreen(step.to);
    this.#runNavigationAnimation(old, next, transition, timing);
  }

  #overlayFrames(view: { overlay: OverlayLayer; layer: OverlaySurface }, transition: Transition) {
    if (transition.type === "dissolve") return [{ opacity: 0 }, { opacity: 1 }];
    if (transition.type === "instant") return null;
    // Overlays slide in from the edge they face away from, all the way off screen.
    const r = this.#overlayRect(view);
    const vw = this.#vw * this.#scale;
    const vh = this.#vh * this.#scale;
    const d =
      transition.type === "move-out" || transition.type === "slide-out"
        ? reverseTransition(transition).direction
        : transition.direction;
    const offset = {
      left: `translate(${vw - r.left}px, 0px)`,
      right: `translate(${-(r.left + r.width)}px, 0px)`,
      up: `translate(0px, ${vh - r.top}px)`,
      down: `translate(0px, ${-(r.top + r.height)}px)`,
    }[d];
    return [{ transform: offset }, { transform: "translate(0px, 0px)" }];
  }

  #openOverlay(overlay: OverlayLayer, animate: boolean): void {
    const base = this.#screen ?? undefined;
    const layer = this.#makeOverlay(overlay.screen, base);
    const dim = document.createElement("div");
    dim.className = "stage__dim";
    dim.style.background = `rgba(0, 0, 0, ${overlay.dim})`;
    const view: OverlayView = { overlay, layer, dim };
    const reveal = () => {
      if (this.#disposed || !this.#overlays.includes(view)) return;
      dim.style.visibility = "";
      layer.el.style.visibility = "";
      this.#placeOverlay(view);
      if (!animate) return;
      const transition = this.#effective(overlay.transition);
      const timing = this.#timing(transition);
      this.#animate(layer.el, this.#overlayFrames(view, transition), timing);
      this.#animate(dim, [{ opacity: 0 }, { opacity: 1 }], timing);
    };
    this.#viewport.append(dim, layer.el);
    this.#overlays.push(view);
    this.#placeOverlay(view);
    if (!this.#useEngine || layer.painted) {
      reveal();
    } else {
      // Hold engine-mode overlays and dim hidden until first paint arrives (or deadline falls back).
      dim.style.visibility = "hidden";
      layer.el.style.visibility = "hidden";
      layer.onFirstPaint = reveal;
    }
  }

  #closeOverlay(overlay: OverlayLayer): void {
    const index = this.#overlays.findIndex((v) => v.overlay.key === overlay.key);
    if (index === -1) return;
    const closing = this.#overlays.slice(index);
    this.#overlays = this.#overlays.slice(0, index);
    if (
      this.#hover &&
      this.#hover.step.type === "open-overlay" &&
      this.#hover.step.overlay.key === overlay.key
    )
      this.#hover = null;
    for (const view of closing) {
      this.#disposeOverlayLayer(view.layer);
      const remove = () => {
        view.layer.el.remove();
        view.dim.remove();
      };
      if (this.#useEngine && !view.layer.painted) {
        remove();
        continue;
      }
      const transition = this.#effective(view.overlay.transition);
      const timing = this.#timing(transition);
      const frames = this.#overlayFrames(view, transition);
      view.layer.el.style.pointerEvents = "none";
      const reversed = timing ? { ...timing, direction: "reverse" as const } : null;
      const a = this.#animate(view.layer.el, frames, reversed);
      this.#animate(view.dim, [{ opacity: 0 }, { opacity: 1 }], reversed);
      if (a) a.finished.then(remove, remove);
      else remove();
    }
  }

  #swapOverlay(step: Extract<PlayerStep, { type: "swap-overlay" }>): void {
    const index = this.#overlays.findIndex((v) => v.overlay.key === step.from.key);
    const old = this.#overlays[index];
    if (!old) return;
    this.#disposeOverlayLayer(old.layer);
    const layer = this.#makeOverlay(step.to.screen, this.#screen ?? undefined);
    const view: OverlayView = { overlay: step.to, layer, dim: old.dim };
    old.layer.el.after(layer.el);
    this.#overlays[index] = view;
    this.#placeOverlay(view);
    old.layer.el.style.pointerEvents = "none";
    const removeOld = () => old.layer.el.remove();
    const reveal = () => {
      layer.onCleanup = null;
      if (this.#disposed || !this.#overlays.includes(view)) {
        removeOld();
        return;
      }
      old.dim.style.visibility = "";
      layer.el.style.visibility = "";
      this.#placeOverlay(view);
      const transition = this.#effective(step.transition);
      const timing = this.#timing(transition);
      const a = this.#animate(
        layer.el,
        transition.type === "instant" ? null : [{ opacity: 0 }, { opacity: 1 }],
        timing,
      );
      if (a) a.finished.then(removeOld, removeOld);
      else removeOld();
    };
    if (!this.#useEngine || layer.painted) {
      reveal();
    } else {
      layer.el.style.visibility = "hidden";
      layer.onCleanup = removeOld;
      layer.onFirstPaint = reveal;
    }
  }

  // -------------------------------------------------------------------------
  // Delays

  /** Arms "after delay" reactions for what's showing; leaves running timers alone. */
  #scheduleDelays(): void {
    const { screen, overlays, history } = this.#player.state;
    const wanted = new Map<string, string>([[`s:${screen}:${history.length}`, screen]]);
    for (const o of overlays) wanted.set(`o:${o.key}`, o.screen);
    for (const [key, timer] of this.#timers) {
      if (!wanted.has(key)) {
        clearTimeout(timer);
        this.#timers.delete(key);
      }
    }
    for (const [key, root] of wanted) {
      if (this.#timers.has(key)) continue;
      const reaction = this.#player.delays(root)[0];
      if (reaction?.trigger.type !== "delay") continue;
      this.#timers.set(
        key,
        setTimeout(() => {
          this.play(this.#player.run({ source: root, reaction }));
        }, reaction.trigger.ms),
      );
    }
  }

  // -------------------------------------------------------------------------
  // Input

  #canvasOf(layer: ScreenLayer | OverlaySurface): HTMLCanvasElement {
    return layer.canvas ?? this.#activeCanvas();
  }

  /** The layer under a client point, topmost first, and the page point inside it. */
  #pick(
    clientX: number,
    clientY: number,
  ): { root: string; chain: string[]; outside: OverlayView | null } | null {
    const top = this.#overlays.at(-1);
    const layers: Array<ScreenLayer | OverlaySurface> = [
      ...this.#overlays.map((v) => v.layer),
    ].reverse();
    if (this.#screen && this.#screenDrawable) layers.push(this.#screen);
    for (const layer of layers) {
      const isOverlay = "painted" in layer;
      const rect = this.#canvasOf(layer).getBoundingClientRect();
      if (
        clientX < rect.left ||
        clientY < rect.top ||
        clientX > rect.right ||
        clientY > rect.bottom
      ) {
        // A click outside the top overlay never reaches what's under it.
        if (top && layer === top.layer) return { root: layer.root, chain: [], outside: top };
        continue;
      }
      // Never fire hotspots on an engine overlay that hasn't painted yet, nor let taps fall through.
      if (isOverlay && this.#useEngine && !layer.painted) return null;
      const bounds = this.#editor.scene.bounds(layer.root);
      if (!bounds) return null;
      const s = layer.contentScale * this.#scale;
      const p = { x: bounds.x + (clientX - rect.left) / s, y: bounds.y + (clientY - rect.top) / s };
      return { root: layer.root, chain: chainAt(this.#editor.scene, layer.root, p), outside: null };
    }
    return null;
  }

  #down(e: PointerEvent): void {
    if (e.button !== 0) return;
    const pick = this.#pick(e.clientX, e.clientY);
    if (!pick) return;
    if (pick.outside) {
      if (pick.outside.overlay.closeOnOutside)
        this.play(this.#player.closeOverlay(pick.outside.overlay.key));
      return;
    }
    this.#press = {
      x: e.clientX,
      y: e.clientY,
      dragged: false,
      root: pick.root,
      chain: pick.chain,
    };
  }

  #move(e: PointerEvent): void {
    const press = this.#press;
    if (press && !press.dragged && Math.hypot(e.clientX - press.x, e.clientY - press.y) > DRAG_PX) {
      const hit = this.#player.find(press.chain, "drag");
      if (hit) {
        press.dragged = true;
        this.play(this.#player.run(hit));
        return;
      }
    }
    if (e.buttons === 0) this.#hoverAt(e.clientX, e.clientY);
  }

  #up(e: PointerEvent): void {
    const press = this.#press;
    this.#press = null;
    if (!press || press.dragged) return;
    if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > DRAG_PX) return;
    const hit = this.#player.find(press.chain, "tap");
    if (hit) this.#run(hit);
    else this.flashHotspots();
  }

  #run(hit: Hit): void {
    const step = this.#player.run(hit);
    if (!step) {
      this.#callbacks.onHint?.("nothing");
      return;
    }
    this.play(step);
  }

  #hoverAt(clientX: number, clientY: number): void {
    const current = this.#hover;
    if (current) {
      const r = current.rect;
      const inside =
        clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom;
      if (inside) return;
      this.#hover = null;
      this.play(this.#player.revert(current.step));
    }
    const pick = this.#pick(clientX, clientY);
    if (!pick || pick.outside) return;
    const hit = this.#player.find(pick.chain, "hover");
    if (!hit) return;
    const rect = this.#clientRect(hit.source, pick.root);
    const step = this.#player.run(hit);
    if (!step || !rect) return;
    this.#hover = { step, rect };
    this.play(step);
  }

  #leave(): void {
    this.#press = null;
    const current = this.#hover;
    if (!current) return;
    this.#hover = null;
    this.play(this.#player.revert(current.step));
  }

  /** A layer's box on screen, from the layer it's drawn in. */
  #clientRect(id: string, root: string): DOMRect | null {
    const layers: Array<ScreenLayer | OverlaySurface | null> = [
      this.#screen,
      ...this.#overlays.map((v) => v.layer),
    ];
    const layer = layers.find((l) => l?.root === root);
    const bounds = this.#editor.scene.bounds(id);
    const origin = this.#editor.scene.bounds(root);
    if (!layer || !bounds || !origin) return null;
    const rect = this.#canvasOf(layer).getBoundingClientRect();
    const s = layer.contentScale * this.#scale;
    return new DOMRect(
      rect.left + (bounds.x - origin.x) * s,
      rect.top + (bounds.y - origin.y) * s,
      bounds.width * s,
      bounds.height * s,
    );
  }

  /** Runs a key reaction if one matches. Returns true when the key was used. */
  key(press: { key: string; shift: boolean; alt: boolean; mod: boolean }): boolean {
    const hit = this.#player.findKey(press);
    if (!hit) return false;
    this.#run(hit);
    return true;
  }

  /** Briefly highlights everything you can tap on what's showing. */
  flashHotspots(): void {
    const topOverlay = this.#overlays.at(-1)?.layer;
    const layer = topOverlay ?? this.#screen;
    if (!layer) return;
    if (topOverlay && this.#useEngine && !topOverlay.painted) return;
    if (layer === this.#screen && !this.#screenDrawable) return;
    const rects = hotspotRects(this.#editor.scene, layer.root);
    this.#callbacks.onHint?.("hotspots");
    const s = layer.contentScale * this.#scale;
    for (const r of rects) {
      const el = document.createElement("div");
      el.className = "stage__hotspot";
      el.style.left = `${r.x * s}px`;
      el.style.top = `${r.y * s}px`;
      el.style.width = `${r.width * s}px`;
      el.style.height = `${r.height * s}px`;
      layer.el.append(el);
      const a = el.animate(
        [{ opacity: 0 }, { opacity: 1, offset: 0.2 }, { opacity: 1, offset: 0.7 }, { opacity: 0 }],
        {
          duration: reducedMotion() ? 900 : 1100,
          easing: "ease-out",
        },
      );
      const remove = () => el.remove();
      a.finished.then(remove, remove);
    }
  }
}

function positionParts(
  position: OverlayPosition,
): ["top" | "middle" | "bottom", "left" | "center" | "right"] {
  const v = position.startsWith("top")
    ? "top"
    : position.startsWith("bottom")
      ? "bottom"
      : "middle";
  const h = position.endsWith("left") ? "left" : position.endsWith("right") ? "right" : "center";
  return [v, h];
}
