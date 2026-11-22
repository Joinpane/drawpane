/**
 * The render engine on the editor's canvas (decision 0040), behind a switch:
 * `?renderer=engine` in the URL, or `localStorage["drawpane:renderer"] = "engine"`
 * (`engine-compat` for explicit WebGPU compatibility testing, `engine-webgl` for WebGL2,
 * `engine-cpu` for the CPU Worker view mode).
 *
 * Switch persistence rule (see `renderer-switch.ts`):
 * - When the URL sets `renderer` (or `present`), that value is remembered in `sessionStorage`
 *   for the rest of the tab session, so in-app navigation (dashboard to file, toggling review,
 *   switching branches) and login redirects keep it.
 * - `?renderer=canvas` turns the engine back off for the session (clearing `sessionStorage`, or
 *   overriding `localStorage` for this session when `localStorage["drawpane:renderer"]` is set).
 * - Precedence: URL parameter, then `sessionStorage`, then `localStorage`, then `"canvas"`
 *   (and for `present`: URL, `sessionStorage`, `localStorage`, then `"webgpu"`).
 *
 * Backend selection order:
 * 1. WebGPU core (hardware only unless `drawpane:engine-software=allow`).
 *    The lazy WebGL2 module is never fetched when WebGPU succeeds.
 * 2. WebGL2 (lazy-loaded only after WebGPU is absent or fails; software adapters and
 *    major-performance-caveat contexts refused unless allowed).
 * 3. CPU view mode (`vello_cpu` in a dedicated Web Worker rendering tiled frames with
 *    bounded viewport pixel cap and byte-budgeted transfer backpressure, cancelling stale
 *    work on camera/edit changes and shifting/scaling received frames smoothly during pan/zoom).
 * 4. Canvas renderer fallback (for unsupported pages, or when even CPU view mode cannot run).
 *
 * Device and context loss recovery:
 * - On the 1st and 2nd loss within 60 s on a GPU backend, rebuilds that same backend on a fresh
 *   canvas element without losing edits (the canvas renderer draws while rebuilding so the screen
 *   is never blank).
 * - On the 3rd loss within 60 s (or when rebuilding fails), disables that backend for the session
 *   and steps down one backend without flapping back.
 *
 * Every fallback logs a console note and dispatches `drawpane:renderer-fallback`.
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
  type FrameStats,
  RenderEngine,
  type Result,
  refusingBits,
  unsupportedNames,
} from "@drawpane/engine";
import { loadBrowserEngine, loadComputeEngine, loadWebglEngine } from "@drawpane/engine/browser";
import type { CpuWorkerReply, CpuWorkerRequest } from "./engine-cpu.worker";
import { CPU_IMAGE_BUDGET, CPU_IMAGE_SIDE, ViewImages } from "./engine-image";
import { fitEngineRaster, MIN_RASTER_SCALE } from "./engine-raster";
import {
  type PresentationMode,
  presentation,
  type RendererChoice,
  rendererChoice,
  softwareAllowed,
  useEngineRenderer,
} from "./renderer-switch";

export {
  type PresentationMode,
  presentation,
  type RendererChoice,
  rendererChoice,
  softwareAllowed,
  useEngineRenderer,
};

export type EngineBackend = "webgpu" | "webgl2" | "cpu-worker";
export type AdapterClassification = "hardware" | "software" | "unknown" | "unidentified";

/** Software GPU strings refused by default unless `drawpane:engine-software = "allow"`. */
const SOFTWARE_RE =
  /swiftshader|llvmpipe|lavapipe|softpipe|software|basic render|mesa offscreen|subzero/i;

/**
 * WebKit privacy aliases: Safari on macOS Metal (16384 max texture size) and Linux WebKit
 * both report "Apple GPU" (or "WebKit WebGL" when WEBGL_debug_renderer_info is hidden).
 * Classified honestly as "unknown" rather than proven hardware or software, and gated by
 * `failIfMajorPerformanceCaveat: true` plus a lightweight fill-rate timing micro-probe.
 */
const WEBKIT_ALIASED_RE = /^(?:apple(?:\s+inc\.?)?\s*\/\s*)?apple\s+gpu$/i;
const WEBKIT_HIDDEN_RE = /^(?:webkit\s*\/\s*)?webkit\s+webgl$/i;

/** Non-WebKit generic renderer labels that cannot prove hardware identity. */
const GENERIC_ADAPTER_RE =
  /^(?:webgl\s*2?(?:\.0)?|mozilla|angle|unknown|webkit(?:\s*\/\s*webgl\s*2?(?:\.0)?)?|\s*\/\s*)*$/i;

/**
 * Upper bound (ms) for 16 passes of a 512x512 WebGL2 ALU fill probe on "unknown" WebKit adapters.
 * Hardware GPUs (macOS Metal, NVIDIA T4, integrated GPUs) complete in a few milliseconds;
 * CPU llvmpipe/SwiftShader takes ~250-600+ milliseconds.
 */
const WEBGL2_SOFTWARE_PROBE_MS = 100;
const WEBGL2_PROBE_PASSES = 16;
const WEBGL2_PROBE_SIDE = 512;

/** Sliding window for GPU device/context loss recovery before stepping down one backend. */
const LOSS_WINDOW_MS = 60_000;
/** Number of same-backend recoveries allowed within LOSS_WINDOW_MS (3rd loss steps down). */
const MAX_RECOVERIES_IN_WINDOW = 2;
/** Consecutive healthy GPU wait timeouts before stepping down without blaming device loss. */
const MAX_CONSECUTIVE_TIMEOUTS = 3;
const OPENING_PREVIEW_TIMEOUT_MS = 8_000;
/** Frames in a row a GPU canvas cannot take before stepping down. */
const UNPRESENTED = 3;
/** Device-pixel tile edge for CPU view mode. */
const CPU_TILE_SIZE = 512;
/** Pixel cap for CPU view mode visible + backing surfaces (4096 x 4096 = 64 MiB per surface). */
export const MAX_CPU_PIXELS = 4096 * 4096;

/** Active `EngineView.create` abort controllers keyed by the durable engine slot. */
const ACTIVE_CREATES = new WeakMap<HTMLElement, AbortController>();

function classifyAdapter(label: string, softwareFlag: boolean): AdapterClassification {
  if (softwareFlag || SOFTWARE_RE.test(label)) return "software";
  const trimmed = label.trim();
  if (!trimmed || GENERIC_ADAPTER_RE.test(trimmed)) return "unidentified";
  if (WEBKIT_ALIASED_RE.test(trimmed) || WEBKIT_HIDDEN_RE.test(trimmed)) return "unknown";
  return "hardware";
}

/**
 * Lightweight synchronous WebGL2 fill-rate micro-probe used only when an adapter reports an
 * aliased/hidden WebKit label ("Apple GPU" or "WebKit WebGL") after passing
 * `failIfMajorPerformanceCaveat: true`. Returns elapsed milliseconds, or `null` if the context
 * lacks shader drawing primitives (e.g. minimal unit-test mocks).
 */
function measureWebgl2FillRateMs(
  canvas: HTMLCanvasElement,
  gl: WebGL2RenderingContext,
): number | null {
  if (
    typeof gl.createShader !== "function" ||
    typeof gl.createProgram !== "function" ||
    typeof gl.drawArrays !== "function" ||
    typeof gl.readPixels !== "function"
  ) {
    return null;
  }
  canvas.width = WEBGL2_PROBE_SIDE;
  canvas.height = WEBGL2_PROBE_SIDE;
  const vs = gl.createShader(gl.VERTEX_SHADER);
  const fs = gl.createShader(gl.FRAGMENT_SHADER);
  const prog = gl.createProgram();
  if (!vs || !fs || !prog) {
    if (vs) gl.deleteShader(vs);
    if (fs) gl.deleteShader(fs);
    if (prog) gl.deleteProgram(prog);
    return null;
  }
  try {
    gl.shaderSource(
      vs,
      `#version 300 es
void main() {
  vec2 pos = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0);
  gl_Position = vec4(pos, 0.0, 1.0);
}`,
    );
    gl.compileShader(vs);
    gl.shaderSource(
      fs,
      `#version 300 es
precision highp float;
uniform float u_pass;
out vec4 outColor;
void main() {
  vec2 p = gl_FragCoord.xy * 0.001953125 + vec2(u_pass * 0.13, u_pass * 0.07);
  float acc = 0.0;
  for (int i = 0; i < 64; i++) {
    float fi = float(i) * 0.17;
    acc += sin(p.x * 12.9898 + fi) * cos(p.y * 78.233 - fi);
  }
  outColor = vec4(fract(abs(acc)), 0.5, 0.25, 1.0);
}`,
    );
    gl.compileShader(fs);
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
    gl.viewport(0, 0, WEBGL2_PROBE_SIDE, WEBGL2_PROBE_SIDE);
    gl.useProgram(prog);
    const loc = gl.getUniformLocation(prog, "u_pass");
    const px = new Uint8Array(4);
    // Warm up pipeline compilation before timing.
    gl.uniform1f(loc, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const t0 = performance.now();
    for (let i = 1; i <= WEBGL2_PROBE_PASSES; i++) {
      gl.uniform1f(loc, i);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return performance.now() - t0;
  } catch {
    return null;
  } finally {
    gl.deleteProgram(prog);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
  }
}

interface AdapterLike {
  readonly isFallbackAdapter?: boolean;
  readonly info?: {
    readonly isFallbackAdapter?: boolean;
    readonly vendor?: string;
    readonly architecture?: string;
    readonly device?: string;
    readonly description?: string;
  };
}

export type FallbackKind = "no-webgpu" | "software-gpu" | "error";

/**
 * Checks whether WebGPU can offer an acceptable adapter at core level (or explicit compatibility
 * mode when `?renderer=engine-compat` is requested). Compatibility mode is excluded from the
 * default automatic chain because Vello's shaders require core `flat, first` interpolation.
 */
export async function adapterLevel(
  choice: RendererChoice,
): Promise<
  | { readonly compatibility: boolean; readonly adapterClass: AdapterClassification }
  | { readonly reason: string; readonly kind: FallbackKind }
> {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(o?: object): Promise<unknown> } })
    .gpu;
  if (!gpu) return { reason: "this browser has no WebGPU", kind: "no-webgpu" };
  const classify = (a: unknown): AdapterClassification => {
    const x = a as AdapterLike | null;
    if (!x) return "software";
    const isFallback = x.info?.isFallbackAdapter === true || x.isFallbackAdapter === true;
    const label = [x.info?.vendor, x.info?.architecture, x.info?.device, x.info?.description]
      .filter(Boolean)
      .join(" ");
    return classifyAdapter(label, isFallback);
  };
  const ask = async (o: object) => {
    try {
      return await gpu.requestAdapter({ powerPreference: "high-performance", ...o });
    } catch {
      return null;
    }
  };
  const compatibility = choice === "engine-compat";
  const a = await ask(compatibility ? { featureLevel: "compatibility" } : {});
  if (!a) return { reason: "no WebGPU adapter", kind: "no-webgpu" };
  const adapterClass = classify(a);
  if (adapterClass !== "software") return { compatibility, adapterClass };
  if (softwareAllowed()) return { compatibility, adapterClass };
  return {
    reason:
      "only a software WebGPU adapter is available (set drawpane:engine-software to allow it)",
    kind: "software-gpu",
  };
}

/**
 * Cheap pre-check before downloading the lazy WebGL2 WASM module: verifies WebGL2 exists
 * and refuses software / major-performance-caveat renderers unless `drawpane:engine-software = "allow"`.
 */
export function probeWebgl2Support():
  | {
      readonly ok: true;
      readonly adapter: string;
      readonly adapterClass: AdapterClassification;
    }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly adapter: string | null;
      readonly adapterClass: AdapterClassification;
      readonly kind: FallbackKind;
    } {
  try {
    const allowSoft = softwareAllowed();
    const readInfo = (gl: WebGL2RenderingContext) => {
      const ext = gl.getExtension("WEBGL_debug_renderer_info");
      const renderer = String(
        (ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null) ??
          gl.getParameter(gl.RENDERER) ??
          "",
      );
      const vendor = String(
        (ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : null) ??
          gl.getParameter(gl.VENDOR) ??
          "",
      );
      return [vendor, renderer].filter(Boolean).join(" / ") || "WebGL2";
    };
    const probeCanvas = document.createElement("canvas");
    probeCanvas.width = 1;
    probeCanvas.height = 1;
    let gl = probeCanvas.getContext("webgl2", {
      antialias: false,
      ...(allowSoft ? {} : { failIfMajorPerformanceCaveat: true }),
    });
    if (!gl && !allowSoft) {
      // Distinguish software / major-performance-caveat WebGL2 from absent WebGL2.
      const fallbackCanvas = document.createElement("canvas");
      fallbackCanvas.width = 1;
      fallbackCanvas.height = 1;
      const softGl = fallbackCanvas.getContext("webgl2", { antialias: false });
      if (softGl) {
        const adapter = readInfo(softGl);
        softGl.getExtension("WEBGL_lose_context")?.loseContext();
        return {
          ok: false,
          reason: `only a software WebGL2 adapter is available (${adapter}, major performance caveat; set drawpane:engine-software to allow it)`,
          adapter,
          adapterClass: "software",
          kind: "software-gpu",
        };
      }
      return {
        ok: false,
        reason: "this browser has no WebGL2",
        adapter: null,
        adapterClass: "unidentified",
        kind: "no-webgpu",
      };
    }
    if (!gl) {
      return {
        ok: false,
        reason: "this browser has no WebGL2",
        adapter: null,
        adapterClass: "unidentified",
        kind: "no-webgpu",
      };
    }
    const adapter = readInfo(gl);
    const adapterClass = classifyAdapter(adapter, false);
    let fillMs: number | null = null;
    if (!allowSoft && adapterClass === "unknown") {
      fillMs = measureWebgl2FillRateMs(probeCanvas, gl);
    }
    // Release the probe context immediately so we never exhaust the browser's context cap.
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    gl = null;
    if (!allowSoft && adapterClass === "unknown") {
      if (fillMs !== null && fillMs > WEBGL2_SOFTWARE_PROBE_MS) {
        return {
          ok: false,
          reason: `WebGL2 adapter (${adapter}) performed at software speed (${fillMs.toFixed(1)} ms fill probe; set drawpane:engine-software to allow it)`,
          adapter,
          adapterClass: "software",
          kind: "software-gpu",
        };
      }
      // Explicit Safari / WebKit policy: keep identity as "unknown" (never claim hardware),
      // while allowing hardware-capable 16K Metal / non-caveat WebKit paths.
      return { ok: true, adapter, adapterClass: "unknown" };
    }
    if (!allowSoft && adapterClass !== "hardware") {
      return {
        ok: false,
        reason:
          adapterClass === "software"
            ? `only a software WebGL2 adapter is available (${adapter}; set drawpane:engine-software to allow it)`
            : `WebGL2 adapter identity is unavailable (${adapter}); refusing unverified GPU unless drawpane:engine-software is allowed`,
        adapter,
        adapterClass,
        kind: adapterClass === "software" ? "software-gpu" : "error",
      };
    }
    return { ok: true, adapter, adapterClass };
  } catch (err) {
    return {
      ok: false,
      reason: `WebGL2 probe failed: ${String(err)}`,
      adapter: null,
      adapterClass: "unidentified",
      kind: "error",
    };
  }
}

export interface FallbackEvent {
  readonly from: EngineBackend | null;
  readonly to: EngineBackend | "canvas";
  readonly reason: string;
  readonly code: ErrorCode | null;
  readonly adapter: string | null;
  readonly kind?: FallbackKind;
}

export interface RecoveredEvent {
  readonly backend: EngineBackend;
  readonly adapter: string | null;
  readonly attempt: number;
  readonly reason: string;
}

/** Backends disabled for this session so the engine never flaps back after stepping down. */
const sessionDisabled = new Set<EngineBackend>();
/** The last fallback recorded this session, if any. */
let lastFallback: FallbackEvent | null = null;

/** Resets session-scoped disabled backends (for unit tests only). */
export function resetSessionBackendsForTest(): void {
  sessionDisabled.clear();
  lastFallback = null;
}

/** Ordered backend candidates for a renderer choice. */
function chainFor(choice: RendererChoice): EngineBackend[] {
  if (choice === "engine-webgl") return ["webgl2", "cpu-worker"];
  if (choice === "engine-cpu") return ["cpu-worker"];
  return ["webgpu", "webgl2", "cpu-worker"];
}

function isCanvasElement(el: HTMLElement): el is HTMLCanvasElement {
  return (
    el.tagName === "CANVAS" ||
    (typeof (el as { getContext?: unknown }).getContext === "function" &&
      typeof (el as { replaceChildren?: unknown }).replaceChildren !== "function")
  );
}

/**
 * Creates a detached `<canvas>` carrying `template`'s layout metadata without touching the DOM.
 * Each candidate backend probes on its own detached element so a failed or superseded probe never
 * locks the React-owned slot to an unusable context type.
 */
function createCandidateCanvas(template: HTMLElement): HTMLCanvasElement {
  const next = document.createElement("canvas");
  if (isCanvasElement(template)) {
    next.className = template.className;
    next.style.cssText = template.style.cssText;
    next.width = template.width;
    next.height = template.height;
    const role = (template as { dataset?: { canvasRole?: string } }).dataset?.canvasRole;
    if (role && (next as { dataset?: { canvasRole?: string } }).dataset) {
      next.dataset.canvasRole = role;
    }
    return next;
  }
  next.className = "canvas__layer";
  next.style.visibility = template.style.visibility || "hidden";
  if (template.style.width) next.style.width = template.style.width;
  if (template.style.height) next.style.height = template.style.height;
  if ((next as { dataset?: { canvasRole?: string } }).dataset) {
    next.dataset.canvasRole = "engine";
  }
  return next;
}

/** Mounts a winning candidate `<canvas>` into a durable container slot (or legacy canvas). */
function mountIntoSlot(slot: HTMLElement, canvas: HTMLCanvasElement): void {
  if (!isCanvasElement(slot) && typeof slot.replaceChildren === "function") {
    slot.replaceChildren(canvas);
  } else {
    slot.replaceWith(canvas);
  }
}

/**
 * Waits briefly (or until the document becomes visible) before retrying one timed-out startup
 * candidate. Resolves `false` if `signal` aborts while waiting.
 */
function waitBeforeStartupRetry(signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (typeof document !== "undefined" && typeof document.removeEventListener === "function") {
        document.removeEventListener("visibilitychange", onVisible);
      }
      resolve(ok);
    };
    const onAbort = () => finish(false);
    const onVisible = () => {
      if (document.visibilityState === "visible") finish(true);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    let timer = 0;
    if (
      typeof document !== "undefined" &&
      document.visibilityState === "hidden" &&
      typeof document.addEventListener === "function"
    ) {
      document.addEventListener("visibilitychange", onVisible);
      // Cap background deferral so an offscreen test never stalls indefinitely.
      timer = window.setTimeout(() => finish(true), 2_000);
    } else {
      timer = window.setTimeout(() => finish(true), 150);
    }
  });
}

/** CSS colour (`#rrggbb[aa]`, or a canvas token) as straight RGBA floats. */
function colour(css: string): [number, number, number, number] {
  const m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(css.trim());
  if (!m) return [0.92, 0.92, 0.9, 1];
  const n = Number.parseInt(m[1] as string, 16);
  const a = m[2] ? Number.parseInt(m[2], 16) / 255 : 1;
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, a];
}

/** Bounds CPU view mode canvas dimensions so visible + backing surfaces stay within MAX_CPU_PIXELS. */
export function boundCpuViewport(
  width: number,
  height: number,
  dpr: number,
): { readonly width: number; readonly height: number; readonly dpr: number } {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const pixels = w * h;
  if (pixels <= MAX_CPU_PIXELS) return { width: w, height: h, dpr };
  const scale = Math.sqrt(MAX_CPU_PIXELS / pixels);
  const nextW = Math.max(1, Math.floor(w * scale));
  const nextH = Math.max(1, Math.floor(h * scale));
  return { width: nextW, height: nextH, dpr: dpr * (nextW / w) };
}

/** What a draw did. */
export interface EngineDraw {
  /** The engine drew this frame (false: the canvas renderer must). */
  readonly drawn: boolean;
  /** It's on screen now (presented). False while an async frame/read-back is on its way. */
  readonly ready: boolean;
  /**
   * No stand-ins and no level of detail: what an exact frame shows. While it's false, draw
   * again next frame: each draws more of the tiles still missing (decision 0040, phase 2).
   */
  readonly exact: boolean;
  /**
   * More to do between frames: tiles round the view to draw ahead of a pan, or text still to
   * send whole (`EngineView.ahead`).
   */
  readonly ahead: boolean;
  /**
   * Nothing more for frames or the time between them to do: every tile shown is as drawn as
   * the page's list allows. A frame that isn't exact then waits for something to change (text
   * provisional while its faces load, or an async CPU worker frame in flight).
   */
  readonly settled: boolean;
  /** An opening preview is already submitted. Its completion schedules the next slice. */
  readonly awaitingPreview?: boolean;
}

const WAITING_FOR_COMPUTE: EngineDraw = {
  drawn: true,
  ready: false,
  exact: false,
  ahead: false,
  settled: true,
  awaitingPreview: true,
};

/** Draws of one frame before repeated overflow turns compute off for the session. */
const MAX_COMPUTE_ATTEMPTS = 6;
let sessionComputeFallback: string | null = null;

function computeRequested(): boolean {
  return new URLSearchParams(window.location.search).get("compute") === "1";
}

/**
 * Still compute frames go through the bump gate with `?gate=1` (a prototype, decision 0040's
 * P1-0 latency gate); otherwise every compute frame is checked before it shows.
 */
function computeGated(): boolean {
  return new URLSearchParams(window.location.search).get("gate") === "1";
}

const NOT_DRAWN: EngineDraw = {
  drawn: false,
  ready: false,
  exact: false,
  ahead: false,
  settled: false,
};

/** What drawing between frames did (`EngineView.ahead`). */
export interface EngineAhead {
  /** It drew a tile or sent text: another slice may do more. */
  readonly progressed: boolean;
  /** Tiles the last frame shows still to draw (some, after text was sent). */
  readonly tiles: number;
  /** Tiles round the view still to draw. */
  readonly queued: number;
  /** Text still to send whole, and of it, what's in view. */
  readonly text: number;
  readonly textVisible: number;
}

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
 * holds input back for more than a frame. Text sent whole after a page opens goes in slices of
 * the same length.
 */
export const IDLE_SLICE_MS = 16;
/** A moving frame's budget that fits no tile: only what nothing stands in for is drawn. */
const NO_OPTIONAL_MS = 1e-6;

interface CpuBackedFrame {
  readonly canvas: HTMLCanvasElement;
  readonly pageId: string;
  readonly revision: number;
  readonly width: number;
  readonly height: number;
  readonly camera: Camera;
}

interface CpuJobMeta {
  readonly jobId: number;
  readonly frame: number;
  readonly sceneKey: string;
  readonly pageId: string;
  readonly revision: number;
  readonly width: number;
  readonly height: number;
  readonly camera: Camera;
  readonly background: string;
  readonly exact: boolean;
  readonly imagesExact: boolean;
  readonly epoch: number;
  firstTile: boolean;
}

type InitOutcome =
  | {
      readonly ok: true;
      readonly backend: EngineBackend;
      readonly canvas: HTMLCanvasElement;
      readonly engine: RenderEngine | null;
      readonly readback: CanvasRenderingContext2D | null;
      readonly cpuWorker: Worker | null;
      readonly cpu2d: CanvasRenderingContext2D | null;
      readonly compatibility: boolean;
      readonly adapter: string;
      readonly adapterClass: AdapterClassification;
    }
  | {
      readonly ok: false;
      readonly aborted?: boolean;
      readonly reason: string;
      readonly code: ErrorCode | null;
      readonly adapter: string | null;
      readonly kind?: FallbackKind;
    };

interface FailedCandidate {
  readonly from: EngineBackend;
  readonly reason: string;
  readonly code: ErrorCode | null;
  readonly adapter: string | null;
  readonly kind: FallbackKind;
}

function summarizeFailures(failed: readonly FailedCandidate[]): {
  from: EngineBackend;
  reason: string;
  code: ErrorCode | null;
  adapter: string | null;
  kind: FallbackKind;
} {
  const first = failed[0] as FailedCandidate;
  const last = failed[failed.length - 1] as FailedCandidate;
  const reason =
    failed.length === 1 ? first.reason : failed.map((f) => `${f.from}: ${f.reason}`).join("; ");
  const kind: FallbackKind = failed.every((f) => f.kind === "software-gpu")
    ? "software-gpu"
    : failed.every((f) => f.kind === "no-webgpu")
      ? "no-webgpu"
      : failed.every((f) => f.kind === "software-gpu" || f.kind === "no-webgpu")
        ? "software-gpu"
        : "error";
  return { from: first.from, reason, code: last.code, adapter: first.adapter, kind };
}

/** Starts a dedicated CPU view-mode worker and waits until its WASM engine is ready. */
function startCpuWorker(signal?: AbortSignal): Promise<Worker> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    if (typeof Worker === "undefined") {
      reject(new Error("Web Workers are not available in this browser"));
      return;
    }
    const worker = new Worker(new URL("./engine-cpu.worker.ts", import.meta.url), {
      type: "module",
    });
    const timer = window.setTimeout(() => {
      cleanup();
      worker.terminate();
      reject(new Error("CPU render worker timed out while starting"));
    }, 30_000);
    const onAbort = () => {
      cleanup();
      worker.terminate();
      reject(new Error("aborted"));
    };
    const onMessage = (e: MessageEvent<CpuWorkerReply>) => {
      if (e.data.type === "ready") {
        cleanup();
        resolve(worker);
      } else if (e.data.type === "error") {
        cleanup();
        worker.terminate();
        reject(new Error(e.data.message));
      }
    };
    const onError = (e: ErrorEvent) => {
      cleanup();
      worker.terminate();
      reject(new Error(e.message || "CPU render worker failed to load"));
    };
    const cleanup = () => {
      window.clearTimeout(timer);
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);
    worker.postMessage({ type: "init" } satisfies CpuWorkerRequest);
  });
}

/**
 * Tries to start one specific backend on a fresh detached candidate `<canvas>`.
 * Never mutates or claims a context on `templateSlot`; the caller commits `res.canvas` into the
 * live DOM slot only after `ok: true` and a final ownership/abort check.
 */
async function initBackend(
  backend: EngineBackend,
  templateSlot: HTMLElement,
  choice: RendererChoice,
  signal?: AbortSignal,
): Promise<InitOutcome> {
  const aborted = (): InitOutcome => ({
    ok: false,
    aborted: true,
    reason: "aborted",
    code: null,
    adapter: null,
    kind: "error",
  });

  try {
    if (signal?.aborted) return aborted();

    if (backend === "webgpu") {
      const level = await adapterLevel(choice);
      if (signal?.aborted) return aborted();
      if ("reason" in level) {
        return {
          ok: false,
          reason: level.reason,
          code: ErrorCode.NoAdapter,
          adapter: null,
          kind: level.kind,
        };
      }
      const useCompute = computeRequested() && !level.compatibility && !sessionComputeFallback;
      const mod = useCompute
        ? await loadComputeEngine().catch((error: unknown) => {
            sessionComputeFallback = `compute module unavailable (${String(error)})`;
            return loadBrowserEngine();
          })
        : await loadBrowserEngine();
      if (signal?.aborted) return aborted();
      const engine = new RenderEngine(mod, { glyphMaskBytes: 32 << 20 });
      if (engine.failure) {
        return {
          ok: false,
          reason: engine.failure.message,
          code: engine.failure.code,
          adapter: null,
          kind: "error",
        };
      }
      const useReadback = presentation() === "readback";
      const surface = createCandidateCanvas(templateSlot);
      const readback = useReadback ? surface.getContext("2d") : null;
      const gpu = await engine.attachGpu(useReadback ? null : surface, {
        compatibility: level.compatibility,
        glyphMaskBytes: 32 << 20,
      });
      if (signal?.aborted) {
        engine.dispose();
        return aborted();
      }
      if (!gpu.ok) {
        engine.dispose();
        return {
          ok: false,
          reason: gpu.message,
          code: gpu.code,
          adapter: null,
          kind: "error",
        };
      }
      if (useCompute && !sessionComputeFallback) {
        const compute = engine.setComputeOrdinary(true);
        if (!compute.ok) sessionComputeFallback = compute.message;
      }
      const rawClass = classifyAdapter(gpu.value.adapter, gpu.value.fallback);
      const adapterClass: AdapterClassification =
        rawClass === "unidentified" && !gpu.value.fallback ? "unknown" : rawClass;
      if (!softwareAllowed() && adapterClass === "software") {
        const adapter = gpu.value.adapter;
        engine.dispose();
        return {
          ok: false,
          reason: `only a software WebGPU adapter is available (${adapter})`,
          code: ErrorCode.NoAdapter,
          adapter,
          kind: "software-gpu",
        };
      }
      console.info(
        `Drawpane: drawing with the render engine on ${gpu.value.adapter} (WebGPU${level.compatibility ? " compatibility mode" : ""})${gpu.value.fallback ? " (a software adapter)" : ""}`,
      );
      return {
        ok: true,
        backend: "webgpu",
        canvas: surface,
        engine,
        readback,
        cpuWorker: null,
        cpu2d: null,
        compatibility: level.compatibility,
        adapter: gpu.value.adapter,
        adapterClass,
      };
    }

    if (backend === "webgl2") {
      const probe = probeWebgl2Support();
      if (signal?.aborted) return aborted();
      if (!probe.ok) {
        return {
          ok: false,
          reason: probe.reason,
          code: ErrorCode.NoAdapter,
          adapter: probe.adapter,
          kind: probe.kind,
        };
      }
      // Lazy-load the WebGL2 WASM module only after WebGPU was absent/refused and WebGL2 probed ok.
      const mod = await loadWebglEngine();
      if (signal?.aborted) return aborted();
      const engine = new RenderEngine(mod, { glyphMaskBytes: 32 << 20 });
      if (engine.failure) {
        return {
          ok: false,
          reason: engine.failure.message,
          code: engine.failure.code,
          adapter: probe.adapter,
          kind: "error",
        };
      }
      const useReadback = presentation() === "readback";
      const surface = createCandidateCanvas(templateSlot);
      const readback = useReadback ? surface.getContext("2d") : null;
      const gpu = await engine.attachGpu(useReadback ? null : surface, {
        glyphMaskBytes: 32 << 20,
      });
      if (signal?.aborted) {
        engine.dispose();
        return aborted();
      }
      if (!gpu.ok) {
        engine.dispose();
        return {
          ok: false,
          reason: gpu.message,
          code: gpu.code,
          adapter: probe.adapter,
          kind: "error",
        };
      }
      const rawClass = classifyAdapter(gpu.value.adapter, gpu.value.fallback);
      if (!softwareAllowed() && rawClass === "software") {
        const adapter = gpu.value.adapter;
        engine.dispose();
        return {
          ok: false,
          reason: `only a software WebGL2 adapter is available (${adapter})`,
          code: ErrorCode.NoAdapter,
          adapter,
          kind: "software-gpu",
        };
      }
      const adapterClass: AdapterClassification =
        probe.adapterClass === "unknown" || probe.adapterClass === "unidentified"
          ? probe.adapterClass
          : rawClass;
      console.info(
        `Drawpane: drawing with the render engine on ${gpu.value.adapter} (WebGL2)${gpu.value.fallback ? " (a software adapter)" : ""}`,
      );
      return {
        ok: true,
        backend: "webgl2",
        canvas: surface,
        engine,
        readback,
        cpuWorker: null,
        cpu2d: null,
        compatibility: false,
        adapter: gpu.value.adapter,
        adapterClass,
      };
    }

    // CPU view mode: start worker first, then create a fresh detached 2D canvas.
    const cpuWorker = await startCpuWorker(signal);
    if (signal?.aborted) {
      cpuWorker.terminate();
      return aborted();
    }
    const surface = createCandidateCanvas(templateSlot);
    const cpu2d = surface.getContext("2d");
    if (!cpu2d) {
      cpuWorker.terminate();
      return {
        ok: false,
        reason: "could not create a 2D canvas for CPU view mode",
        code: ErrorCode.Gpu,
        adapter: null,
        kind: "error",
      };
    }
    console.info(
      "Drawpane: drawing with the render engine in CPU view mode (vello_cpu in a Web Worker).",
    );
    return {
      ok: true,
      backend: "cpu-worker",
      canvas: surface,
      engine: null,
      readback: null,
      cpuWorker,
      cpu2d,
      compatibility: false,
      adapter: "vello_cpu (Web Worker)",
      adapterClass: "software",
    };
  } catch (err) {
    if (signal?.aborted) return aborted();
    return { ok: false, reason: String(err), code: null, adapter: null, kind: "error" };
  }
}

export class EngineView {
  readonly #slot: HTMLElement | null;
  #canvas: HTMLCanvasElement;
  readonly #editor: Editor;
  readonly #measurer: TextMeasurer;
  readonly #images: ViewImages;
  #imageLimits = { side: CPU_IMAGE_SIDE, bytes: CPU_IMAGE_BUDGET };
  readonly #imageUploads = new Map<number, { done(uploaded: boolean): void; cancel(): void }>();
  #imageTicket = 0;
  #imageVersion = 0;
  #hiddenImageTimer: ReturnType<typeof setTimeout> | undefined;
  readonly #offImageSource: () => void;
  readonly #choice: RendererChoice;
  #backend: EngineBackend;
  #adapter: string;
  #adapterClass: AdapterClassification;
  #compatibility: boolean;
  #engine: RenderEngine | null;
  #readback: CanvasRenderingContext2D | null;
  #cpuWorker: Worker | null;
  #cpu2d: CanvasRenderingContext2D | null;
  #builder: DisplayListBuilder;
  /** Monotonic device generation incremented on every GPU detach/reattach/replacement. */
  #deviceGeneration = 0;
  /** The latest GPU frame drawn, the one being read back, and whether one is on its way. */
  #frame = 0;
  #reading = false;
  #readbackFailTimer = 0;
  #timeoutBackoffTimer = 0;
  #consecutiveTimeouts = 0;
  #want: {
    n: number;
    width: number;
    height: number;
    exact: boolean;
    epoch: number;
    key: string;
    scale: number;
  } | null = null;
  #gpuRaster: {
    viewport: string;
    revision: number;
    zoom: number;
    settled: boolean;
    scale: number;
    reason: string;
  } | null = null;
  #pendingRasterLimit: string | null = null;
  #readbackLimit: { key: string; reason: string } | null = null;
  #cpuApplySequence = 0;
  #cpuApply: { pageId: string; version: number; attempt: number } | null = null;
  #listLimit: { pageId: string; version: number; reason: string } | null = null;
  /** CPU view mode state: monotonic job ids, last complete frame for pan/zoom stand-ins. */
  #cpuJobId = 0;
  #cpuRevision = 0;
  #cpuJob: CpuJobMeta | null = null;
  #cpuCompletedKey: string | null = null;
  #cpuCompletedExact = false;
  #cpuBacking: CpuBackedFrame | null = null;
  #cpuHasPage: string | null = null;
  #cpuUnsupportedPage: string | null = null;
  /** CPU view that hit a limit and cannot settle further at this camera. */
  #cpuLimitKey: string | null = null;
  #cpuLimitMessage: string | null = null;
  /** Why the engine is drawing at reduced detail or retaining its last usable picture. */
  #limitReason: string | null = null;
  /** The canvas, images and background the last compute step saw (`#computeStep`). */
  #computeContent: string | null = null;
  /** The frame on screen came from compute: drawing ahead with vello_gpu would be wasted. */
  #computeShown = false;
  /** The newest gated compute frame on screen whose check is in flight (`#presentGated`). */
  #pendingGate: { readonly key: string; readonly stats: FrameStats; ready: boolean } | null = null;
  /** The compute candidate being checked (`?compute=1`), at most one. */
  #pendingCompute: {
    readonly key: string;
    readonly content: string;
    ready: boolean;
    succeeded: boolean;
    readonly attempt: number;
  } | null = null;
  /** Aborted on dispose so any in-flight step-down probe stops immediately. */
  readonly #lifecycle = new AbortController();
  /**
   * Which presentation is current: moves on whenever a content frame isn't the engine's (the
   * canvas renderer draws it), the page changes or the size does. A read-back or CPU tile from
   * an earlier one is dropped when it lands.
   */
  #epoch = 0;
  #presenting: { pageId: string; width: number; height: number } | null = null;
  #dead = false;
  #unpresented = 0;
  /** Async device/context recovery or backend step-down in flight. */
  #recovering: Promise<void> | null = null;
  /** Loss timestamps within the last LOSS_WINDOW_MS per backend. */
  readonly #losses = new Map<EngineBackend, number[]>();
  /** Pages the engine couldn't draw (so the page-level event fires once per change). */
  readonly #refused = new Set<string>();
  /** Called after an engine-side change (an image arrived, recovery finished) that needs a frame. */
  onChange: () => void = () => {};
  /** Called once when all engine backends fail and the canvas renderer takes over for the session. */
  onFallback: (e: FallbackEvent) => void = () => {};
  /** Called when an async frame (read-back or CPU worker tiles) reaches the screen. */
  onPresented: (exact: boolean, frame?: number) => void = () => {};
  /**
   * Called on direct GPU presentation after `gpuFinished()` resolves and the following
   * animation frame fires (earliest compositor presentation tick).
   */
  onGpuPresented: (frame: number) => void = () => {};
  /** Coalesces direct-present `gpuFinished` stamps so WebGL2 never exceeds MAX_FINISHED_WAITERS. */
  #shownWaiting = false;
  #openingFrame: number | null = null;
  #openingPreviewTimer = 0;
  /** What drawing between frames did, summed (`ahead`), for the bench and the debug handle. */
  idle = { slices: 0, tiles: 0, ms: 0 };
  /**
   * Set to an object by the bench: when the first exact frame since was drawn (submitted), when
   * the GPU finished it (no read-back involved), and when an exact frame was first shown (a
   * read-back painted; with a WebGPU/WebGL2 canvas, the first animation frame after the GPU
   * finished it, the earliest a compositor could show it). Frame numbers tell them apart.
   */
  stamps: {
    drawn?: { n: number; at: number };
    gpu?: { n: number; at: number };
    shown?: { n: number; at: number };
  } | null = null;
  /**
   * The frame last put on screen, exact or not, and when: painted from its read-back or CPU
   * worker frame, or (a WebGPU/WebGL2 canvas) the first animation frame after the GPU finished it.
   * The bench samples the canvas as it changes.
   */
  shown = { n: 0, at: 0 };
  /** Set to a list by the bench: each frame and slice between frames, as it happens. */
  trace: Array<{
    t: number;
    k: "frame" | "idle" | "present" | "text";
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
  /** Called whenever the engine swaps in a fresh `<canvas>` DOM element. */
  onCanvas: (canvas: HTMLCanvasElement) => void = () => {};
  /** Called when the active backend changes (e.g. webgpu -> webgl2 -> cpu-worker). */
  onBackendChange: (backend: EngineBackend) => void = () => {};
  /** Called while a GPU backend is asynchronously recovering so the canvas renderer covers it. */
  onRecovering: (recovering: boolean) => void = () => {};
  /** The last frame's numbers, for the bench and the debug handle. */
  last = {
    /** The page drawn and the frame's number (benches tell frames of a page apart by them). */
    pageId: "",
    n: 0,
    revision: 0,
    ms: 0,
    patchMs: 0,
    records: 0,
    culled: 0,
    reads: 0,
    coarse: 0,
    glyphsMasked: 0,
    glyphsOutlined: 0,
    supported: true,
    exact: false,
    plan: "tiles" as FrameStats["plan"],
    tiles: {
      drawn: 0,
      pending: 0,
      queued: 0,
      held: 0,
      evicted: 0,
      dragged: 0,
    } as FrameStats["tiles"],
    /** Where the frame's CPU time went: the patch, the engine's encoding, its renderer, submit. */
    breakdown: {
      patch: 0,
      encode: 0,
      render: 0,
      submit: 0,
      readback: 0,
      prepareMasks: 0,
      velloRender: 0,
      reader: 0,
      shadow: 0,
    },
    counts: {
      submits: 0,
      velloRenders: 0,
      glassOps: 0,
      glassBatched: 0,
      bgBlurOps: 0,
      shadowOps: 0,
      shadowHits: 0,
    },
  };
  /** Readback presentation diagnostics (for debugging and verifying WebGPU readback confirmation). */
  readbackDiag: {
    started: number;
    ok: number;
    timeout: number;
    limit: number;
    error: number;
    epochDropped: number;
    sizeDropped: number;
    genDropped: number;
    deadDropped: number;
    presented: number;
    busySkipped: number;
    canvasGuardDropped: number;
    canvasNoSeq: number;
    canvasNoMotion: number;
    canvasConfirmed: number;
    events: Array<{
      t: number;
      k: string;
      n: number;
      frame: number;
      ms?: number;
      code?: number;
      msg?: string;
    }>;
  } = {
    started: 0,
    ok: 0,
    timeout: 0,
    limit: 0,
    error: 0,
    epochDropped: 0,
    sizeDropped: 0,
    genDropped: 0,
    deadDropped: 0,
    presented: 0,
    busySkipped: 0,
    canvasGuardDropped: 0,
    canvasNoSeq: 0,
    canvasNoMotion: 0,
    canvasConfirmed: 0,
    events: [],
  };
  readonly #health: number;
  #lastGpuWidth = 0;
  #lastGpuHeight = 0;

  private constructor(
    slot: HTMLElement | null,
    init: Extract<InitOutcome, { ok: true }>,
    editor: Editor,
    measurer: TextMeasurer,
    images: ImageCache,
    choice: RendererChoice,
  ) {
    this.#slot = slot;
    this.#canvas = init.canvas;
    this.#editor = editor;
    this.#measurer = measurer;
    this.#images = new ViewImages(
      images,
      (ref) => {
        this.#builder.imageReady(ref);
        this.onChange();
      },
      () => {
        this.#imageVersion++;
        this.onChange();
      },
    );
    this.#choice = choice;
    this.#backend = init.backend;
    this.#adapter = init.adapter;
    this.#adapterClass = init.adapterClass;
    this.#compatibility = init.compatibility;
    this.#engine = init.engine;
    this.#readback = init.readback;
    this.#cpuWorker = init.cpuWorker;
    this.#cpu2d = init.cpu2d;
    this.#builder = new DisplayListBuilder(editor.scene, measurer, {
      image: (ref) => this.#images.info(ref),
    });
    if (this.#cpuWorker) this.#wireCpuWorker(this.#cpuWorker);
    this.#attachImages();
    document.addEventListener("visibilitychange", this.#imageVisibility);
    this.#offImageSource = images.subscribe(() => this.onChange());
    // A GPU device or WebGL context can be lost between frames: poll without waiting for the
    // next frame so an idle page recovers or steps down cleanly.
    this.#health = window.setInterval(() => {
      if (this.#dead || this.#recovering || !this.#engine) return;
      const r = this.#engine.gpuCheck();
      if (!r.ok) this.#handleGpuFailure(r, true);
    }, 250);
  }

  /**
   * Starts the render engine in `slot` (either a durable React-owned container element or a
   * legacy `<canvas>`) following the ordered fallback chain, or returns null (with the reason
   * reported) when every engine backend is unavailable or initialization was superseded/aborted.
   */
  static async create(
    slot: HTMLElement,
    editor: Editor,
    measurer: TextMeasurer,
    images: ImageCache,
    choice: RendererChoice,
    signal?: AbortSignal,
  ): Promise<EngineView | null> {
    if (signal?.aborted) return null;
    // Supersede any earlier in-flight initialization targeting the same slot.
    ACTIVE_CREATES.get(slot)?.abort();
    const controller = new AbortController();
    ACTIVE_CREATES.set(slot, controller);
    const onCallerAbort = () => controller.abort();
    signal?.addEventListener("abort", onCallerAbort, { once: true });

    try {
      const chain = chainFor(choice);
      const failed: FailedCandidate[] = [];

      for (const candidate of chain) {
        if (controller.signal.aborted) return null;
        if (sessionDisabled.has(candidate)) continue;
        let res = await initBackend(candidate, slot, choice, controller.signal);
        // Retry a slow startup once (deferring while hidden) before stepping down.
        if (!res.ok && !res.aborted && res.code === ErrorCode.Timeout) {
          const keepGoing = await waitBeforeStartupRetry(controller.signal);
          if (!keepGoing || controller.signal.aborted) return null;
          res = await initBackend(candidate, slot, choice, controller.signal);
        }
        if (
          controller.signal.aborted ||
          ACTIVE_CREATES.get(slot) !== controller ||
          (!res.ok && res.aborted)
        ) {
          if (res.ok) {
            res.engine?.dispose();
            res.cpuWorker?.terminate();
          }
          return null;
        }
        if (res.ok) {
          // Commit the winning detached candidate into the React-owned slot only after attach
          // succeeded and final ownership is confirmed.
          mountIntoSlot(slot, res.canvas);
          if (failed.length > 0) {
            const summary = summarizeFailures(failed);
            EngineView.#report({
              from: summary.from,
              to: candidate,
              reason: summary.reason,
              code: summary.code,
              adapter: summary.adapter,
              kind: summary.kind,
            });
          }
          const containerSlot = isCanvasElement(slot) ? null : slot;
          return new EngineView(containerSlot, res, editor, measurer, images, choice);
        }
        // Do not permanently blacklist a candidate across future views on a transient wait timeout.
        if (res.code !== ErrorCode.Timeout) sessionDisabled.add(candidate);
        failed.push({
          from: candidate,
          reason: res.reason,
          code: res.code,
          adapter: res.adapter,
          kind: res.kind ?? "error",
        });
      }

      if (failed.length > 0) {
        const summary = summarizeFailures(failed);
        EngineView.#report({
          from: summary.from,
          to: "canvas",
          reason: summary.reason,
          code: summary.code,
          adapter: summary.adapter,
          kind: summary.kind,
        });
      }
      return null;
    } finally {
      signal?.removeEventListener("abort", onCallerAbort);
      if (ACTIVE_CREATES.get(slot) === controller) ACTIVE_CREATES.delete(slot);
    }
  }

  static #report(e: FallbackEvent): void {
    lastFallback = e;
    const fromLabel = e.from ?? "engine";
    if (e.to === "canvas") {
      console.info(
        `Drawpane: the render engine is off for this session (${fromLabel} failed: ${e.reason}); the canvas renderer draws instead.`,
      );
    } else {
      console.info(
        `Drawpane: the render engine fell back from ${fromLabel} to ${e.to} (${e.reason}).`,
      );
    }
    window.dispatchEvent(
      new CustomEvent<FallbackEvent>("drawpane:renderer-fallback", { detail: e }),
    );
  }

  get canvas(): HTMLCanvasElement {
    return this.#canvas;
  }

  get backend(): EngineBackend {
    return this.#backend;
  }

  get adapter(): string {
    return this.#adapter;
  }

  get adapterClass(): AdapterClassification {
    return this.#adapterClass;
  }

  get compatibility(): boolean {
    return this.#compatibility;
  }

  /** Whether the active GPU backend is running on a software adapter (excludes CPU view mode). */
  get software(): boolean {
    return (
      this.#backend !== "cpu-worker" &&
      (this.#adapterClass === "software" || !!this.#engine?.gpu?.fallback)
    );
  }

  get recovering(): boolean {
    return this.#recovering !== null;
  }

  get computeFallbackReason(): string | null {
    return computeRequested() ? sessionComputeFallback : null;
  }

  get limitReason(): string | null {
    return this.#limitReason;
  }

  get engine(): RenderEngine | null {
    return this.#engine;
  }

  get builder(): DisplayListBuilder {
    return this.#builder;
  }

  /** Whether frames reach the screen asynchronously (GPU read-back or CPU worker tiles). */
  get readsBack(): boolean {
    return this.#readback !== null || this.#backend === "cpu-worker";
  }

  /** Whether an async GPU read-back is currently in flight. */
  get reading(): boolean {
    return this.#reading;
  }

  /** Whether the latest engine draw presented a frame cleanly (not recovering or stalled). */
  get lastPresented(): boolean {
    return !this.#dead && !this.#recovering && this.#unpresented === 0 && this.last.supported;
  }

  /**
   * Captures the currently displayed frame for prototype transitions before the next screen draws.
   * - On readback and CPU-worker modes, returns the 2D canvas synchronously.
   * - On direct-present WebGPU and WebGL2, synchronously queues `gpuPixels()` from the engine's
   *   internal GPU render target before returning, so a subsequent `draw()` will not overwrite it.
   */
  captureFrame():
    | { readonly sync: HTMLCanvasElement }
    | {
        readonly async: Promise<{
          readonly width: number;
          readonly height: number;
          readonly pixels: Uint8Array;
        } | null>;
      }
    | null {
    if (this.#dead || this.#recovering) return null;
    if (this.#readback !== null || this.#backend === "cpu-worker") {
      return { sync: this.#canvas };
    }
    const engine = this.#engine;
    const width = this.#lastGpuWidth;
    const height = this.#lastGpuHeight;
    if (!engine || width <= 0 || height <= 0) return null;
    const pending = engine.gpuPixels();
    return {
      async: pending
        .then((res) =>
          res.ok && res.value.length === width * height * 4
            ? { width, height, pixels: res.value }
            : null,
        )
        .catch(() => null),
    };
  }

  /** Reads back the currently shown frame pixels (straight RGBA8), on any engine backend. */
  async pixels(): Promise<Result<Uint8Array>> {
    if (this.#engine) return this.#engine.gpuPixels();
    if (this.#cpu2d) {
      const { width, height } = this.#canvas;
      if (width <= 0 || height <= 0) {
        return { ok: false, code: ErrorCode.State, message: "empty canvas" };
      }
      const data = this.#cpu2d.getImageData(0, 0, width, height).data;
      return { ok: true, value: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) };
    }
    return { ok: false, code: ErrorCode.State, message: "no active backend" };
  }

  #pageLimit(pageId: string, reason: string): EngineDraw {
    this.#limitReason = reason;
    this.last = { ...this.last, exact: false, supported: false };
    this.#pageSupported(pageId, false, reason);
    return NOT_DRAWN;
  }

  #wireCpuWorker(worker: Worker): void {
    worker.onmessage = (e: MessageEvent<CpuWorkerReply>) => {
      if (this.#dead || this.#cpuWorker !== worker) return;
      const msg = e.data;
      if (msg.type === "image-result") {
        this.#imageUploads.get(msg.ticket)?.done(msg.uploaded);
        this.#imageUploads.delete(msg.ticket);
        return;
      }
      if (msg.type === "apply-result") {
        if (!msg.ok) {
          const apply = this.#cpuApply;
          if (!apply || msg.attempt !== apply.attempt) return;
          this.#supersede();
          this.#cpuCompletedKey = null;
          this.#cpuCompletedExact = false;
          this.#cpuRevision = msg.revision;
          this.#builder.acknowledge(false, msg.revision);
          if (msg.code === ErrorCode.Limit) {
            this.#listLimit = {
              pageId: apply.pageId,
              version: apply.version,
              reason: msg.message ?? "display list exceeded the engine limit",
            };
            this.onChange();
          } else if (msg.code === ErrorCode.Revision) {
            this.onChange();
          } else {
            this.#stepDown({
              message: msg.message ?? "CPU worker failed to apply display list",
              code: msg.code ?? null,
            });
          }
        }
        return;
      }
      if (msg.type === "unsupported") {
        const job = this.#cpuJob;
        if (job && msg.jobId === job.jobId && msg.revision === job.revision) {
          this.#cpuUnsupportedPage = job.pageId;
          this.#cpuJob = null;
          this.#cpuCompletedKey = null;
          this.#cpuCompletedExact = false;
          this.last = { ...this.last, supported: false };
          this.#pageSupported(job.pageId, false);
          this.onChange();
        }
        return;
      }
      if (msg.type === "error") {
        if (msg.jobId !== undefined) {
          const job = this.#cpuJob;
          if (
            !job ||
            msg.jobId !== job.jobId ||
            (msg.revision !== undefined && msg.revision !== job.revision) ||
            job.revision !== this.#cpuRevision ||
            job.epoch !== this.#epoch
          ) {
            return;
          }
          if (msg.code === ErrorCode.Limit) {
            // Even the smallest raster could not draw this view. Use Canvas for this camera.
            this.#cpuJob = null;
            this.#cpuCompletedKey = null;
            this.#cpuCompletedExact = false;
            this.#cpuLimitKey = job.sceneKey;
            this.#cpuLimitMessage = msg.message;
            this.#limitReason = msg.message;
            this.onChange();
            return;
          }
        }
        if (msg.code !== ErrorCode.Limit) this.#stepDown({ message: msg.message, code: msg.code });
        return;
      }
      if (msg.type === "tile") {
        // Release transfer credit immediately regardless of whether this tile is painted or stale.
        worker.postMessage({ type: "tile-ack", jobId: msg.jobId } satisfies CpuWorkerRequest);
        const job = this.#cpuJob;
        if (
          !job ||
          msg.jobId !== job.jobId ||
          msg.revision !== job.revision ||
          job.revision !== this.#cpuRevision ||
          job.epoch !== this.#epoch ||
          !this.#cpu2d
        ) {
          msg.bitmap?.close();
          return;
        }
        if (
          msg.reduced &&
          (msg.width !== this.#canvas.width || msg.height !== this.#canvas.height)
        ) {
          this.#canvas.width = msg.width;
          this.#canvas.height = msg.height;
        }
        this.#canvas.style.backgroundColor = "";
        if (job.firstTile) {
          job.firstTile = false;
          const backed =
            this.#cpuBacking &&
            this.#cpuBacking.pageId === job.pageId &&
            this.#cpuBacking.revision === job.revision;
          if (!backed) {
            this.#cpu2d.setTransform(1, 0, 0, 1, 0, 0);
            this.#cpu2d.clearRect(0, 0, job.width, job.height);
          }
        }
        this.#cpu2d.setTransform(1, 0, 0, 1, 0, 0);
        if (msg.bitmap) {
          // Clear the tile rect before drawing so translucent backgrounds never accumulate.
          this.#cpu2d.clearRect(msg.x, msg.y, msg.width, msg.height);
          this.#cpu2d.drawImage(msg.bitmap, msg.x, msg.y);
          msg.bitmap.close();
        } else if (msg.pixels) {
          const img = new ImageData(new Uint8ClampedArray(msg.pixels), msg.width, msg.height);
          this.#cpu2d.putImageData(img, msg.x, msg.y);
        }
        this.#cpuHasPage = job.pageId;
        if (job.frame > this.shown.n) this.shown = { n: job.frame, at: performance.now() };
        this.onPresented(false, job.frame);
        return;
      }
      if (msg.type === "done") {
        const job = this.#cpuJob;
        if (
          !job ||
          msg.jobId !== job.jobId ||
          msg.revision !== job.revision ||
          job.revision !== this.#cpuRevision ||
          job.epoch !== this.#epoch
        ) {
          return;
        }
        // Snapshot the completed frame for instant shifted/scaled pan and zoom previews.
        const backing = this.#cpuBacking?.canvas ?? document.createElement("canvas");
        if (backing.width !== msg.width) backing.width = msg.width;
        if (backing.height !== msg.height) backing.height = msg.height;
        const bctx = backing.getContext("2d");
        if (bctx) {
          bctx.setTransform(1, 0, 0, 1, 0, 0);
          bctx.clearRect(0, 0, msg.width, msg.height);
          bctx.drawImage(this.#canvas, 0, 0);
          this.#cpuBacking = {
            canvas: backing,
            pageId: job.pageId,
            revision: job.revision,
            width: msg.width,
            height: msg.height,
            camera: msg.camera,
          };
        }
        if (msg.limit) {
          this.#cpuLimitKey = job.sceneKey;
          this.#cpuLimitMessage = msg.limit;
          this.#limitReason = msg.limit;
        }
        const frameExact =
          msg.exact && job.exact && job.imagesExact && this.#builder.pendingVisible === 0;
        const at = performance.now();
        this.#cpuHasPage = job.pageId;
        this.#cpuCompletedKey = job.sceneKey;
        this.#cpuCompletedExact = frameExact;
        this.#cpuJob = null;
        if (job.frame > this.shown.n) this.shown = { n: job.frame, at };
        if (this.stamps && !this.stamps.shown && frameExact && job.frame === this.#frame) {
          this.stamps.shown = { n: job.frame, at };
        }
        this.last = {
          ...this.last,
          pageId: job.pageId,
          n: job.frame,
          ms: msg.ms,
          records: msg.records,
          culled: msg.culled,
          glyphsMasked: msg.glyphsMasked,
          glyphsOutlined: msg.glyphsOutlined,
          supported: true,
          exact: frameExact,
          plan: msg.plan,
          tiles: msg.tiles,
          breakdown: { ...this.last.breakdown, render: msg.ms },
        };
        this.onPresented(frameExact && msg.jobId === this.#cpuJobId, job.frame);
        // Once the visible frame is exact, let the idle loop finish shaping any offscreen text.
        if (frameExact && this.#builder.pending > 0) this.onChange();
      }
    };
    worker.onerror = (e) => {
      if (this.#dead || this.#cpuWorker !== worker) return;
      this.#stepDown({ message: e.message || "CPU render worker crashed", code: null });
    };
  }

  /** Invalidates the active GPU device generation and releases any in-flight readback state. */
  #bumpDeviceGeneration(): void {
    this.#deviceGeneration++;
    this.#supersede();
    this.#reading = false;
    this.#shownWaiting = false;
    this.#want = null;
    this.#consecutiveTimeouts = 0;
    this.#gpuRaster = null;
    this.#pendingRasterLimit = null;
    this.#readbackLimit = null;
    this.#cpuApply = null;
    this.#listLimit = null;
    if (this.#readbackFailTimer) {
      window.clearTimeout(this.#readbackFailTimer);
      this.#readbackFailTimer = 0;
    }
    if (this.#timeoutBackoffTimer) {
      window.clearTimeout(this.#timeoutBackoffTimer);
      this.#timeoutBackoffTimer = 0;
    }
  }

  /**
   * Handles a GPU failure (device loss, WebGL context loss, or unrecoverable error).
   * Recoverable losses rebuild the same backend on a fresh canvas up to MAX_RECOVERIES_IN_WINDOW
   * times within LOSS_WINDOW_MS; the next loss steps down one backend for the session.
   */
  #handleGpuFailure(
    r: { readonly message: string; readonly code: ErrorCode | null },
    recoverable: boolean,
  ): EngineDraw {
    if (this.#dead || this.#recovering) return NOT_DRAWN;
    if (r.code === ErrorCode.Limit) {
      this.#limitReason = r.message;
      if (this.#engine && this.#presenting) {
        const scale = this.#gpuRaster?.scale ?? 1;
        if (Math.max(this.#presenting.width, this.#presenting.height) * scale >= 2) {
          this.#pendingRasterLimit = r.message;
          this.onChange();
        }
      }
      return { drawn: true, ready: true, exact: false, ahead: false, settled: true };
    }
    if (this.#backend === "webgpu" && computeRequested() && !sessionComputeFallback) {
      sessionComputeFallback = this.#engine?.computeFallbackReason() ?? r.message;
    }
    this.#supersede();
    this.#bumpDeviceGeneration();
    this.#unpresented = 0;
    this.#lastGpuWidth = 0;
    this.#lastGpuHeight = 0;
    const isLoss =
      recoverable &&
      (r.code === ErrorCode.DeviceLost || r.code === ErrorCode.Gpu || /lost/i.test(r.message));
    if (isLoss && (this.#backend === "webgpu" || this.#backend === "webgl2")) {
      const now = Date.now();
      const history = (this.#losses.get(this.#backend) ?? []).filter(
        (t) => now - t < LOSS_WINDOW_MS,
      );
      history.push(now);
      this.#losses.set(this.#backend, history);
      if (history.length <= MAX_RECOVERIES_IN_WINDOW) {
        this.#recovering = this.#recoverSameBackend(r, history.length);
        return NOT_DRAWN;
      }
    }
    this.#recovering = this.#stepDown(r);
    return NOT_DRAWN;
  }

  async #recoverSameBackend(
    r: { readonly message: string; readonly code: ErrorCode | null },
    attempt: number,
  ): Promise<void> {
    const backend = this.#backend;
    const engine = this.#engine;
    if (!engine || this.#dead) {
      this.#recovering = null;
      return;
    }
    this.onRecovering(true);
    try {
      this.#detachImages();
      engine.detachGpu();
      const candidate = createCandidateCanvas(this.#canvas);
      const useReadback = presentation() === "readback";
      const readback = useReadback ? candidate.getContext("2d") : null;
      const gpu = await engine.attachGpu(useReadback ? null : candidate, {
        ...(backend === "webgpu" ? { compatibility: this.#compatibility } : {}),
        glyphMaskBytes: 32 << 20,
      });
      if (this.#dead) return;
      if (!gpu.ok) {
        await this.#stepDown({
          message: `${r.message}; recovery failed: ${gpu.message}`,
          code: gpu.code,
        });
        return;
      }
      const rawClass = classifyAdapter(gpu.value.adapter, gpu.value.fallback);
      const adapterClass: AdapterClassification =
        backend === "webgpu" && rawClass === "unidentified" && !gpu.value.fallback
          ? "unknown"
          : rawClass;
      if (!softwareAllowed() && adapterClass === "software") {
        await this.#stepDown({
          message: `recovery returned a software adapter (${gpu.value.adapter})`,
          code: ErrorCode.NoAdapter,
        });
        return;
      }
      // Commit the fresh canvas into the DOM slot only after recovery attach succeeded.
      if (this.#slot && typeof this.#slot.replaceChildren === "function") {
        this.#slot.replaceChildren(candidate);
      } else {
        this.#canvas.replaceWith(candidate);
      }
      this.#canvas = candidate;
      this.#readback = readback;
      this.#limitReason = null;
      this.onCanvas(candidate);
      this.#bumpDeviceGeneration();
      this.#adapter = gpu.value.adapter;
      this.#adapterClass = adapterClass;
      this.#recovering = null;
      this.#attachImages();
      console.info(
        `Drawpane: render engine recovered on ${backend} (${gpu.value.adapter}) after device loss (attempt ${attempt}/${MAX_RECOVERIES_IN_WINDOW} in 60 s).`,
      );
      window.dispatchEvent(
        new CustomEvent<RecoveredEvent>("drawpane:renderer-recovered", {
          detail: { backend, adapter: gpu.value.adapter, attempt, reason: r.message },
        }),
      );
      this.onRecovering(false);
      this.onChange();
    } catch (err) {
      if (this.#dead) return;
      await this.#stepDown({
        message: `${r.message}; recovery threw: ${String(err)}`,
        code: r.code,
      });
    }
  }

  /** Disables the failing backend for this session and steps down to the next available one. */
  async #stepDown(r: { readonly message: string; readonly code: ErrorCode | null }): Promise<void> {
    if (this.#dead) return;
    const oldBackend = this.#backend;
    const oldAdapter = this.#engine?.gpu?.adapter ?? this.#adapter;
    sessionDisabled.add(oldBackend);
    this.onRecovering(true);
    this.#supersede();
    this.#bumpDeviceGeneration();

    // Release the failing backend's resources before allocating the next one.
    this.#detachImages();
    this.#engine?.dispose();
    this.#engine = null;
    this.#readback = null;
    if (this.#cpuWorker) {
      this.#cpuWorker.postMessage({ type: "dispose" } satisfies CpuWorkerRequest);
      this.#cpuWorker.terminate();
      this.#cpuWorker = null;
    }
    this.#cpu2d = null;
    this.#cpuBacking = null;
    this.#cpuJob = null;
    this.#cpuCompletedKey = null;
    this.#cpuCompletedExact = false;
    this.#cpuHasPage = null;

    const chain = chainFor(this.#choice);
    const startAt = Math.max(0, chain.indexOf(oldBackend) + 1);
    const failed: FailedCandidate[] = [
      { from: oldBackend, reason: r.message, code: r.code, adapter: oldAdapter, kind: "error" },
    ];

    for (let i = startAt; i < chain.length; i++) {
      const candidate = chain[i] as EngineBackend;
      if (sessionDisabled.has(candidate)) continue;
      let res = await initBackend(candidate, this.#canvas, this.#choice, this.#lifecycle.signal);
      // After a WebGPU device crash, Chromium's GPU process can take a few hundred ms to restart,
      // during which getContext("webgl2") transiently returns null. Retry briefly before giving up.
      for (
        let retry = 0;
        retry < 3 &&
        !this.#dead &&
        !res.ok &&
        !res.aborted &&
        oldBackend === "webgpu" &&
        candidate === "webgl2" &&
        res.reason === "this browser has no WebGL2";
        retry++
      ) {
        await new Promise((resolve) => window.setTimeout(resolve, 250 * (retry + 1)));
        if (this.#dead) return;
        res = await initBackend(candidate, this.#canvas, this.#choice, this.#lifecycle.signal);
      }
      if (this.#dead || (!res.ok && res.aborted)) {
        if (res.ok) {
          res.engine?.dispose();
          res.cpuWorker?.terminate();
        }
        return;
      }
      if (res.ok) {
        if (this.#slot && typeof this.#slot.replaceChildren === "function") {
          this.#slot.replaceChildren(res.canvas);
        } else {
          this.#canvas.replaceWith(res.canvas);
        }
        this.#canvas = res.canvas;
        this.onCanvas(res.canvas);
        this.#backend = res.backend;
        this.#adapter = res.adapter;
        this.#adapterClass = res.adapterClass;
        this.#compatibility = res.compatibility;
        this.#engine = res.engine;
        this.#readback = res.readback;
        this.#cpuWorker = res.cpuWorker;
        this.#cpu2d = res.cpu2d;
        this.#cpuRevision = 0;
        this.#cpuUnsupportedPage = null;
        this.#cpuLimitKey = null;
        this.#cpuLimitMessage = null;
        this.#limitReason = null;
        this.#cpuCompletedKey = null;
        this.#cpuCompletedExact = false;
        this.#bumpDeviceGeneration();
        if (this.#cpuWorker) this.#wireCpuWorker(this.#cpuWorker);
        this.#builder = new DisplayListBuilder(this.#editor.scene, this.#measurer, {
          image: (ref) => this.#images.info(ref),
        });
        this.#recovering = null;
        this.#attachImages();
        const summary = summarizeFailures(failed);
        EngineView.#report({
          from: summary.from,
          to: candidate,
          reason: summary.reason,
          code: summary.code,
          adapter: summary.adapter,
          kind: summary.kind,
        });
        this.onBackendChange(candidate);
        this.onRecovering(false);
        this.onChange();
        return;
      }
      sessionDisabled.add(candidate);
      failed.push({
        from: candidate,
        reason: res.reason,
        code: res.code,
        adapter: res.adapter,
        kind: res.kind ?? "error",
      });
    }

    // No engine backend left: fall back to the canvas renderer for the rest of the session.
    this.#recovering = null;
    this.#dead = true;
    const summary = summarizeFailures(failed);
    const e: FallbackEvent = {
      from: summary.from,
      to: "canvas",
      reason: summary.reason,
      code: summary.code,
      adapter: summary.adapter,
      kind: summary.kind,
    };
    EngineView.#report(e);
    this.onFallback(e);
    this.dispose();
  }

  #detachImages(): void {
    this.#images.setBackend(null);
    for (const upload of this.#imageUploads.values()) upload.cancel();
    this.#imageUploads.clear();
  }

  #attachImages(): void {
    const engine = this.#engine;
    const worker = this.#cpuWorker;
    if (engine) {
      engine.enableViewImages();
      const limits = engine.viewImageLimits();
      if (limits.ok) this.#imageLimits = limits.value;
      this.#images.setBackend({
        retryUpload: true,
        upload: (handle, bitmap) => {
          const result = engine.putGpuImageLevel(handle, bitmap);
          if (!result.ok && result.code === ErrorCode.Trap) this.#handleGpuFailure(result, false);
          return result.ok;
        },
        drop: (handle, width) => {
          engine.dropImageLevel(handle, width);
        },
      });
    } else if (worker) {
      this.#imageLimits = { side: CPU_IMAGE_SIDE, bytes: CPU_IMAGE_BUDGET };
      this.#images.setBackend({
        upload: (handle, bitmap) =>
          new Promise<boolean>((done) => {
            const ticket = ++this.#imageTicket;
            const width = bitmap.width;
            worker.postMessage(
              { type: "put-image", handle, ticket, bitmap } satisfies CpuWorkerRequest,
              [bitmap],
            );
            this.#imageUploads.set(ticket, {
              done,
              cancel: () => {
                worker.postMessage({
                  type: "drop-image-level",
                  handle,
                  width,
                } satisfies CpuWorkerRequest);
                done(false);
              },
            });
          }),
        drop: (handle, width) => {
          worker.postMessage({
            type: "drop-image-level",
            handle,
            width,
          } satisfies CpuWorkerRequest);
        },
      });
    }
  }

  #evictImages = (): void => {
    this.#images.evict(true);
    this.#engine?.clearViewCaches();
    this.#cpuWorker?.postMessage({ type: "clear-view-caches" } satisfies CpuWorkerRequest);
    this.#imageVersion++;
    this.#cpuBacking = null;
    this.#supersede();
    if (document.visibilityState !== "hidden") this.onChange();
  };

  #imageVisibility = (): void => {
    clearTimeout(this.#hiddenImageTimer);
    if (document.visibilityState === "hidden") {
      this.#hiddenImageTimer = setTimeout(this.#evictImages, 30_000);
    } else {
      this.onChange();
    }
  };

  #updateImages(camera: Camera, width: number, height: number): boolean {
    if (document.visibilityState === "hidden") return false;
    const scale = camera.zoom * camera.dpr;
    const region = {
      x: -camera.x / camera.zoom,
      y: -camera.y / camera.zoom,
      width: width / scale,
      height: height / scale,
    };
    // The image cache covers the visible tiles plus the neighbouring tile ring.
    const demands = this.#builder.imageDemands(region, 1024 / scale);
    return this.#images.update(demands, scale, this.#imageLimits);
  }

  get reducedImages(): number {
    return this.#images.reduced;
  }

  /** The first message of the last fresh list: building and applying it, in ms (benches). */
  opened: { pageId: string; buildMs: number; applyMs: number; records: number } | null = null;

  /** Applies the builder's next message to a GPU engine; false if it failed. */
  #patchGpu(pageId: string, textMs?: number): boolean {
    const engine = this.#engine;
    if (!engine) return false;
    const version = this.#editor.doc.version;
    if (this.#listLimit?.pageId === pageId && this.#listLimit.version === version) return true;
    this.#listLimit = null;
    const t0 = performance.now();
    // A page shown afresh sends geometry in slices and leaves its text provisional until
    // the whole structure is in view. The first frame need not wait for the full list.
    let message =
      this.#builder.pageId !== pageId || this.#builder.opening
        ? this.#builder.openSlice(pageId)
        : this.#builder.update(textMs, true);
    if (!message) return true;
    const t1 = performance.now();
    let r = engine.apply(message);
    if (this.#builder.stats.fresh)
      this.opened = {
        pageId,
        buildMs: t1 - t0,
        applyMs: performance.now() - t1,
        records: this.#builder.stats.records,
      };
    this.#builder.acknowledge(r.ok, engine.revision);
    if (!r.ok && r.code === ErrorCode.Revision) {
      message = this.#builder.openSlice(pageId);
      r = engine.apply(message);
      this.#builder.acknowledge(r.ok, engine.revision);
    }
    if (!r.ok) {
      if (r.code === ErrorCode.Limit) {
        this.#listLimit = { pageId, version, reason: r.message };
        return true;
      }
      this.#handleGpuFailure(r, false);
      return false;
    }
    if (this.#builder.stats.fresh || !this.#builder.opening) {
      this.#images.retain(this.#builder.imagesInUse());
    }
    return true;
  }

  /** Sends the builder's next message to the CPU worker. */
  #patchCpu(pageId: string, textMs?: number): boolean {
    const worker = this.#cpuWorker;
    if (!worker) return false;
    const version = this.#editor.doc.version;
    if (this.#listLimit?.pageId === pageId && this.#listLimit.version === version) return true;
    this.#listLimit = null;
    const t0 = performance.now();
    const message =
      this.#builder.pageId === pageId
        ? this.#builder.update(textMs)
        : this.#builder.build(pageId, undefined, { deferText: true });
    if (!message) return true;
    const t1 = performance.now();
    // Wire header bytes 12..16 hold the message's target revision (docs/decisions/0040-display-list.md).
    const revision =
      message.byteLength >= 16
        ? new DataView(message.buffer, message.byteOffset, message.byteLength).getUint32(12, true)
        : this.#cpuRevision + 1;
    const copy = new Uint8Array(message.length);
    copy.set(message);
    this.#cpuRevision = revision;
    this.#cpuUnsupportedPage = null;
    this.#cpuLimitKey = null;
    this.#cpuLimitMessage = null;
    this.#limitReason = null;
    this.#cpuJob = null;
    this.#cpuCompletedKey = null;
    this.#cpuCompletedExact = false;
    // The worker applies messages in FIFO order before any subsequent render command.
    this.#builder.acknowledge(true, revision);
    const attempt = ++this.#cpuApplySequence;
    this.#cpuApply = { pageId, version, attempt };
    worker.postMessage({ type: "apply", bytes: copy.buffer, attempt } satisfies CpuWorkerRequest, [
      copy.buffer,
    ]);
    if (this.#builder.stats.fresh)
      this.opened = {
        pageId,
        buildMs: t1 - t0,
        applyMs: performance.now() - t1,
        records: this.#builder.stats.records,
      };
    this.#images.retain(this.#builder.imagesInUse());
    return true;
  }

  /** Tells listeners once when a page falls back to the canvas renderer, and why. */
  #pageSupported(pageId: string, supported: boolean, limit?: string): void {
    if (supported) {
      this.#refused.delete(pageId);
      return;
    }
    if (this.#refused.has(pageId)) return;
    this.#refused.add(pageId);
    const features = this.unsupported(false);
    window.dispatchEvent(
      new CustomEvent("drawpane:renderer-page-fallback", { detail: { pageId, features, limit } }),
    );
  }

  /**
   * Draws `pageId` under `camera` into the engine's canvas (`width` x `height` device pixels),
   * from the tiles the engine keeps (decision 0040, phase 2). `exact` says the camera rests;
   * otherwise it's moving, and tiles not drawn yet show stand-ins (a stale tile, another level
   * scaled, the last frame moved). `budgetMs` bounds the tiles drawn this frame beyond those
   * nothing can stand in for (0: none, so a frame at rest comes back exact). Returns `NOT_DRAWN`
   * when the canvas renderer must draw this frame (unsupported page, GPU recovery in progress,
   * or all engine backends failed).
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
    if (this.#dead || this.#recovering) return NOT_DRAWN;
    const at = this.#presenting;
    if (!at || at.pageId !== pageId || at.width !== width || at.height !== height) {
      this.#supersede();
      this.#presenting = { pageId, width, height };
    }
    try {
      const r =
        this.#backend === "cpu-worker"
          ? this.#drawCpu(pageId, camera, width, height, dpr, background, state, exact)
          : this.#drawGpu(pageId, camera, width, height, dpr, background, state, exact, budgetMs);
      // The canvas renderer draws this frame: nothing on its way from the engine may show.
      if (!r.drawn) this.#supersede();
      return r;
    } catch (err) {
      return this.#handleGpuFailure({ message: String(err), code: null }, true);
    }
  }

  /**
   * Between frames at rest, for at most `budgetMs` (decision 0040, phase 2): sends text of
   * `pageId` still to be encoded whole that's in view (tiles drawn before it would be drawn
   * again), else draws tiles the next frame will want on GPU backends (those the last frame
   * shows that aren't up to date, nearest the centre first, then those round it), else sends
   * the rest of the text. Composites and shows nothing. Null when there's nothing to do it for.
   */
  ahead(pageId: string, background: string, budgetMs: number): EngineAhead | null {
    if (this.#dead || this.#recovering || !this.#presenting || this.#presenting.pageId !== pageId) {
      return null;
    }
    const b = this.#builder;
    // Initial geometry advances with a new frame so each slice can be shown before the
    // next one starts. Do not run an unbroken sequence of idle slices during open.
    if (b.opening || this.#listLimit) return null;
    try {
      const text = (): EngineAhead | null => {
        const t = performance.now();
        const before = b.pending;
        const ok =
          this.#backend === "cpu-worker"
            ? this.#patchCpu(pageId, budgetMs)
            : this.#patchGpu(pageId, budgetMs);
        if (!ok) return null;
        this.trace?.push({
          t: performance.now(),
          k: "text",
          ms: performance.now() - t,
          tiles: 0,
          pending: before - b.pending,
          encode: 0,
          render: 0,
          misses: 0,
          records: b.stats.records,
          masked: 0,
          outlined: 0,
        });
        return {
          progressed: true,
          tiles: this.#backend === "cpu-worker" ? 0 : 1,
          queued: 0,
          text: b.pending,
          textVisible: b.pageId === pageId ? b.pendingVisible : 0,
        };
      };
      if (b.pageId === pageId && b.pendingVisible > 0) return text();
      if (this.#backend === "cpu-worker") {
        if (b.pageId === pageId && b.pending > 0 && this.#cpuJob === null) return text();
        return { progressed: false, tiles: 0, queued: 0, text: b.pending, textVisible: 0 };
      }
      const engine = this.#engine;
      if (!engine) return null;
      if (this.#gpuRaster) return b.pageId === pageId && b.pending > 0 ? text() : null;
      // Compute draws the whole view each frame: tiles drawn ahead would only take GPU memory.
      if (this.#computeShown) return b.pageId === pageId && b.pending > 0 ? text() : null;
      const r = engine.renderGpuAhead(colour(background), budgetMs);
      if (!r.ok) {
        // A layer the engine refuses: the next frame draws this page on the canvas.
        if (r.code !== ErrorCode.Unsupported && r.code !== ErrorCode.Limit)
          this.#handleGpuFailure(r, true);
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
      if (r.value.drawn === 0 && b.pageId === pageId && b.pending > 0) return text();
      return {
        progressed: r.value.drawn > 0,
        tiles: r.value.pending,
        queued: r.value.queued,
        text: b.pending,
        textVisible: 0,
      };
    } catch (err) {
      this.#handleGpuFailure({ message: String(err), code: null }, true);
      return null;
    }
  }

  /** Drops every read-back, direct-GPU presentation stamp, or CPU tile job on its way: a newer content frame decided otherwise. */
  #supersede(): void {
    this.#epoch++;
    if (this.#pendingCompute || this.#pendingGate) {
      this.#engine?.cancelComputeFrame();
      this.#pendingCompute = null;
      this.#pendingGate = null;
    }
    this.#shownWaiting = false;
    this.#clearOpeningFrame();
    this.#want = null;
    this.#cpuJob = null;
    this.#cpuCompletedKey = null;
    this.#cpuCompletedExact = false;
  }

  #clearOpeningFrame(): void {
    this.#openingFrame = null;
    if (!this.#openingPreviewTimer) return;
    window.clearTimeout(this.#openingPreviewTimer);
    this.#openingPreviewTimer = 0;
  }

  #completeOpeningFrame(n: number): void {
    if (this.#openingFrame !== n) return;
    this.#clearOpeningFrame();
    this.onChange();
  }

  #drawGpu(
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
    const engine = this.#engine;
    if (!engine) return NOT_DRAWN;
    if (this.#openingFrame !== null)
      return {
        drawn: true,
        ready: false,
        exact: false,
        ahead: false,
        settled: true,
        awaitingPreview: true,
      };
    const t0 = performance.now();
    this.#builder.setEditorState(state);
    // What's in view, in page units: text still to send whole goes there first.
    const z = camera.zoom > 0 ? camera.zoom : 1;
    this.#builder.setView({
      x0: -camera.x / z,
      y0: -camera.y / z,
      x1: (width / dpr - camera.x) / z,
      y1: (height / dpr - camera.y) / z,
    });
    if (!this.#patchGpu(pageId)) return NOT_DRAWN;
    const t1 = performance.now();
    if (this.#listLimit) return this.#pageLimit(pageId, this.#listLimit.reason);
    if (!this.#builder.supported) {
      this.#limitReason = null;
      this.last = { ...this.last, supported: false, patchMs: t1 - t0 };
      this.#pageSupported(pageId, false);
      return NOT_DRAWN;
    }
    const cam: Camera = { zoom: camera.zoom, x: camera.x, y: camera.y, dpr };
    const imagesExact = this.#updateImages(cam, width, height);
    // While text in view is still to be sent whole, a frame draws only what nothing stands in
    // for (as while moving): a tile drawn now would be stale again when the text arrives, and the
    // time between frames sends the text first.
    const opening = this.#builder.opening;
    const textFirst = opening || this.#builder.pendingVisible > 0;
    const viewport = `${pageId}|${width}x${height}|${dpr}`;
    const revision = engine.revision;
    // Everything a frame's pixels depend on: a compute frame checked for one key is exact only
    // for that key, so the background is part of it.
    const key = `${viewport}|${revision}|${this.#imageVersion}|${background}|${cam.zoom}|${cam.x}|${cam.y}`;
    if (this.#readbackLimit?.key === key)
      return this.#pageLimit(pageId, this.#readbackLimit.reason);
    this.#readbackLimit = null;
    const previous = this.#gpuRaster?.viewport === viewport ? this.#gpuRaster : null;
    const pendingLimit = this.#pendingRasterLimit;
    this.#pendingRasterLimit = null;
    const tryLarger =
      exact &&
      previous &&
      (!previous.settled || cam.zoom < previous.zoom * 0.8 || revision !== previous.revision);
    const initialScale = pendingLimit
      ? Math.max(MIN_RASTER_SCALE, (previous?.scale ?? 1) / 2)
      : tryLarger
        ? 1
        : previous?.scale;
    const bg = colour(background);
    // Opt-in compute (`?compute=1`): a frame is drawn into a back buffer and shown only after
    // its bump counters and GPU errors come back clean (decision 0040, P1-0).
    // What a candidate's pixels must match to be shown at all: the canvas, the images and the
    // background. An older revision or camera is shown as behind (not exact) and the current
    // one is staged.
    const content = `${viewport}|${this.#imageVersion}|${background}`;
    const computeOn = this.#backend === "webgpu" && computeRequested() && !sessionComputeFallback;
    let verifiedCompute: Result<FrameStats> | null = null;
    let frameKey = key;
    if (computeOn && !exact) {
      // Moving frames stay on vello_gpu: a checked frame takes two or three display frames to
      // show, so motion would stall on it. A candidate staged before the motion began is for a
      // camera that's gone; drop it, and the first still frame stages afresh.
      this.#cancelCompute(engine);
    } else if (computeOn) {
      const step = this.#computeStep(engine, key, content, width, height, cam, bg, {
        stage: !textFirst && (initialScale ?? 1) === 1,
      });
      if (step.kind === "wait") return WAITING_FOR_COMPUTE;
      if (step.kind === "frame") {
        verifiedCompute = step.result;
        frameKey = step.key;
      }
    }
    // A checked frame drawn for an earlier camera (verification takes a frame or two): shown,
    // since it's exact for where the camera was, but not counted as this frame's exact picture.
    const computeBehind = verifiedCompute !== null && frameKey !== key;
    const {
      raster,
      result: frame,
      limit,
    } = fitEngineRaster(
      width,
      height,
      cam,
      (r) =>
        (r.scale === 1 ? verifiedCompute : null) ??
        engine.renderGpu(
          r.width,
          r.height,
          r.camera,
          bg,
          r.scale === 1 && (!exact || textFirst),
          r.scale === 1 ? (textFirst ? NO_OPTIONAL_MS : budgetMs) : 0,
          true,
        ),
      initialScale,
    );
    this.#computeShown = verifiedCompute !== null && raster.scale === 1 && frame.ok;
    const rasterLimit =
      limit ?? pendingLimit ?? (raster.scale < 1 ? previous?.reason : null) ?? null;
    this.#gpuRaster = rasterLimit
      ? {
          viewport,
          revision,
          zoom: tryLarger ? cam.zoom : (previous?.zoom ?? cam.zoom),
          settled: exact,
          scale: raster.scale,
          reason: rasterLimit,
        }
      : null;
    this.#limitReason = rasterLimit;
    if (!frame.ok) {
      if (frame.code === ErrorCode.Unsupported) {
        this.last = { ...this.last, supported: false };
        this.#pageSupported(pageId, false);
        return NOT_DRAWN;
      }
      if (frame.code === ErrorCode.Limit)
        return this.#pageLimit(pageId, rasterLimit ?? frame.message);
      if (frame.code === ErrorCode.Timeout) {
        const health = engine.gpuCheck();
        if (!health.ok) return this.#handleGpuFailure(health, true);
        this.#consecutiveTimeouts++;
        if (this.#consecutiveTimeouts >= MAX_CONSECUTIVE_TIMEOUTS) {
          return this.#handleGpuFailure(
            {
              message: `GPU wait timed out ${this.#consecutiveTimeouts} times in a row (${frame.message})`,
              code: ErrorCode.Timeout,
            },
            false,
          );
        }
        return NOT_DRAWN;
      }
      return this.#handleGpuFailure(frame, true);
    }
    this.#pageSupported(pageId, true);
    const health = engine.gpuCheck();
    if (!health.ok) return this.#handleGpuFailure(health, true);
    if (!this.#readback) this.#consecutiveTimeouts = 0;
    const f = frame.value;
    if (f.plan === "reader-halo" && !this.#limitReason)
      this.#limitReason = "reader samples beyond the viewport use reduced detail";
    if (!f.presented) {
      if (++this.#unpresented >= UNPRESENTED) {
        return this.#handleGpuFailure(
          { message: "the canvas stopped taking frames", code: ErrorCode.Gpu },
          false,
        );
      }
      return NOT_DRAWN;
    }
    this.#unpresented = 0;
    this.#lastGpuWidth = width;
    this.#lastGpuHeight = height;
    // Exact only when the list holds what the page shows: text in view still to be sent again
    // (fonts arrived) leaves the frame a stand-in, whatever the engine drew.
    const shownExact =
      f.exact &&
      !computeBehind &&
      !opening &&
      imagesExact &&
      this.#builder.pendingVisible === 0 &&
      !this.#limitReason;
    this.#canvas.style.backgroundColor = "";
    const n = ++this.#frame;
    if (opening) {
      this.#openingFrame = n;
      this.#openingPreviewTimer = window.setTimeout(() => {
        if (this.#openingFrame !== n) return;
        this.#handleGpuFailure(
          {
            message: "opening preview did not present before the deadline",
            code: ErrorCode.Timeout,
          },
          false,
        );
      }, OPENING_PREVIEW_TIMEOUT_MS);
    }
    const stamps = this.stamps;
    const gen = this.#deviceGeneration;
    const epoch = this.#epoch;
    // Presented to a WebGPU/WebGL2 canvas, a frame is on screen at the compositor's first frame
    // after the GPU finished it, which nothing here can see: the first animation frame after then
    // is the earliest it could be shown, and what's stamped. Coalesce non-watch `gpuFinished`
    // probes so WebGL2 never exceeds `MAX_FINISHED_WAITERS`.
    const watch = Boolean(stamps && shownExact && !stamps.drawn);
    if (watch && stamps) stamps.drawn = { n, at: performance.now() };
    const trackShown = (targetN: number, isWatch: boolean) => {
      if (!isWatch) this.#shownWaiting = true;
      void engine.gpuFinished().then((res) => {
        if (!isWatch) this.#shownWaiting = false;
        if (
          this.#dead ||
          this.#recovering ||
          gen !== this.#deviceGeneration ||
          epoch !== this.#epoch
        ) {
          return;
        }
        if (!res.ok) {
          // An older probe can already be in flight when the opening preview is submitted.
          const openingFrame = this.#openingFrame;
          if (!isWatch && !this.#readback && openingFrame !== null && openingFrame > targetN)
            trackShown(openingFrame, false);
          return;
        }
        const gpu = performance.now();
        if (isWatch && stamps && this.stamps === stamps && stamps.drawn?.n === targetN) {
          stamps.gpu = { n: targetN, at: gpu };
        }
        if (this.#readback) return;
        requestAnimationFrame(() => {
          if (
            this.#dead ||
            this.#recovering ||
            gen !== this.#deviceGeneration ||
            epoch !== this.#epoch
          ) {
            return;
          }
          const at = performance.now();
          if (targetN > this.shown.n) {
            this.shown = { n: targetN, at };
            this.onGpuPresented(targetN);
          }
          this.#completeOpeningFrame(targetN);
          if (isWatch && stamps && this.stamps === stamps && !stamps.shown) {
            stamps.shown = { n: targetN, at };
          }
          // If newer frames were submitted while waiting, stamp the newest one next.
          if (!isWatch && this.#frame > targetN && !this.#shownWaiting && !this.#readback) {
            trackShown(this.#frame, false);
          }
        });
      });
    };
    if (watch) {
      trackShown(n, true);
    } else if (!this.#readback && !this.#shownWaiting) {
      trackShown(n, false);
    }
    if (this.#readback) {
      this.#want = {
        n,
        width: raster.width,
        height: raster.height,
        exact: shownExact,
        epoch: this.#epoch,
        key: frameKey,
        scale: raster.scale,
      };
      this.#readNext();
    }
    this.last = {
      pageId,
      n,
      revision: engine.revision,
      ms: performance.now() - t0,
      patchMs: t1 - t0,
      records: f.records,
      culled: f.culled,
      reads: f.reads,
      coarse: f.coarse,
      glyphsMasked: f.glyphsMasked,
      glyphsOutlined: f.glyphsOutlined,
      supported: true,
      exact: shownExact,
      plan: f.plan,
      tiles: f.tiles,
      breakdown: {
        ...this.last.breakdown,
        patch: t1 - t0,
        encode: f.ms.encode,
        render: f.ms.render,
        submit: f.ms.submit,
        prepareMasks: f.ms.prepareMasks,
        velloRender: f.ms.velloRender,
        reader: f.ms.reader,
        shadow: f.ms.shadow,
      },
      counts: f.counts,
    };
    this.trace?.push({
      t: performance.now(),
      k: "frame",
      ms: this.last.ms,
      tiles: f.tiles.drawn,
      pending: f.tiles.pending,
      encode: f.ms.encode,
      render: t1 - t0,
      misses: f.maskMisses,
      records: f.records,
      masked: f.glyphsMasked,
      outlined: f.glyphsOutlined,
    });
    // Behind the camera: stage the frame for where it is now; its check redraws.
    const caughtUp =
      !computeBehind ||
      this.#computeStep(engine, key, content, width, height, cam, bg, {
        stage: !textFirst && (initialScale ?? 1) === 1,
      }).kind === "wait";
    // A GPU canvas shows the frame once it's presented; a read-back one when it lands.
    return {
      drawn: true,
      ready: this.#readback === null,
      exact: shownExact,
      ahead: this.#builder.pending > 0 || (!rasterLimit && f.tiles.queued > 0),
      settled:
        !opening &&
        caughtUp &&
        (!!this.#limitReason ||
          (f.tiles.pending === 0 && f.tiles.queued === 0 && this.#builder.pending === 0)),
    };
  }

  /**
   * Drops the compute candidate being checked and the gated frame whose check is in flight, if
   * any: neither can be reported for what's asked now. The engine still settles a dropped gated
   * frame's check (growth, errors), but never as exact.
   */
  #cancelCompute(engine: RenderEngine): void {
    if (!this.#pendingCompute && !this.#pendingGate) return;
    engine.cancelComputeFrame();
    this.#pendingCompute = null;
    this.#pendingGate = null;
  }

  /**
   * The gated compute path (decision 0040, P1-0): the frame is drawn and presented at once, and
   * the GPU itself keeps the frame on screen wherever a stage overflowed, so nothing overflowed
   * shows and presenting waits for no read-back. The frame is exact once its check lands clean:
   * then the same key is reported again as exact without drawing. `null`: there is no frame of
   * this size to keep, so stage instead.
   */
  #presentGated(
    engine: RenderEngine,
    key: string,
    width: number,
    height: number,
    cam: Camera,
    bg: readonly [number, number, number, number],
  ):
    | { readonly kind: "wait" }
    | { readonly kind: "legacy" }
    | { readonly kind: "frame"; readonly result: Result<FrameStats>; readonly key: string }
    | null {
    const shown = this.#pendingGate;
    if (shown?.ready) {
      this.#pendingGate = null;
      const verdict = engine.finishComputeGate();
      if (verdict === "fallback" || verdict === "lost") {
        sessionComputeFallback = engine.computeFallbackReason() ?? "compute fell back";
        return { kind: "legacy" };
      }
      if (verdict === "verified" && shown.key === key)
        return { kind: "frame", result: { ok: true, value: { ...shown.stats, exact: true } }, key };
      // Redraw (the gate kept the last good frame and the buffers grew), or another view.
    } else if (shown && shown.key === key) {
      // This view is on screen; its check redraws when it lands.
      return { kind: "wait" };
    }
    const presented = engine.presentComputeFrame(width, height, cam, bg);
    if (!presented.ok) return { kind: "frame", result: presented, key };
    const reason = engine.computeFallbackReason();
    if (reason) {
      sessionComputeFallback = reason;
      return { kind: "legacy" };
    }
    // Too many checks in flight: vello_gpu draws this one, rather than drop a check.
    if (presented.value === "busy") return { kind: "legacy" };
    if (!presented.value) return null;
    const candidate = { key, stats: presented.value.stats, ready: false };
    this.#pendingGate = candidate;
    void presented.value.check.then(() => {
      if (this.#pendingGate !== candidate || this.#dead) return;
      candidate.ready = true;
      this.onChange();
    });
    return { kind: "frame", result: { ok: true, value: presented.value.stats }, key };
  }

  /**
   * One step of the checked compute path. `wait`: a candidate is being checked (its check
   * redraws); `frame`: a checked frame was shown (for `key`, possibly an earlier camera's); and
   * `legacy`: draw this frame with vello_gpu (the page isn't ordinary, compute is off for the
   * session, or `stage` is false).
   */
  #computeStep(
    engine: RenderEngine,
    key: string,
    content: string,
    width: number,
    height: number,
    cam: Camera,
    bg: readonly [number, number, number, number],
    opts: { readonly stage: boolean },
  ):
    | { readonly kind: "wait" }
    | { readonly kind: "legacy" }
    | { readonly kind: "frame"; readonly result: Result<FrameStats>; readonly key: string } {
    // A candidate drawn for another canvas, images or background can never be shown: drop it
    // at once, checked or not. Until those hold still for a frame, vello_gpu draws, so a
    // continuous resize keeps showing frames instead of cancelling every candidate unseen.
    const stable = this.#computeContent === content;
    this.#computeContent = content;
    if (!stable) this.#cancelCompute(engine);
    let pending = this.#pendingCompute;
    if (pending && pending.content !== content) {
      this.#cancelCompute(engine);
      pending = null;
    }
    let attempt = 1;
    if (pending) {
      if (!pending.ready) return { kind: "wait" };
      this.#pendingCompute = null;
      if (!pending.succeeded) {
        // The check never finished: the engine trapped or was replaced under it.
        engine.cancelComputeFrame();
        sessionComputeFallback ??= "a compute frame could not be checked";
        return { kind: "legacy" };
      }
      const checked = engine.finishComputeFrame(pending.attempt >= MAX_COMPUTE_ATTEMPTS);
      if (!checked.ok) return { kind: "frame", result: checked, key: pending.key };
      const value = checked.value;
      if (value === "fallback") {
        sessionComputeFallback = engine.computeFallbackReason() ?? "compute fell back";
        return { kind: "legacy" };
      }
      if (value === "retry") attempt = pending.attempt + 1;
      else if (value !== "stale")
        return { kind: "frame", result: { ok: true, value }, key: pending.key };
    }
    if (!opts.stage || sessionComputeFallback || !stable) return { kind: "legacy" };
    if (computeGated()) {
      const gated = this.#presentGated(engine, key, width, height, cam, bg);
      if (gated) return gated;
    }
    const staged = engine.stageComputeFrame(width, height, cam, bg);
    const reason = engine.computeFallbackReason();
    if (reason) {
      sessionComputeFallback = reason;
      return { kind: "legacy" };
    }
    // Not staged: the page isn't ordinary, or something the vello_gpu frame will report.
    if (!staged.ok || !staged.value) return { kind: "legacy" };
    const candidate = { key, content, ready: false, succeeded: false, attempt };
    this.#pendingCompute = candidate;
    void staged.value.then((succeeded) => {
      if (this.#pendingCompute !== candidate || this.#dead) return;
      candidate.ready = true;
      candidate.succeeded = succeeded;
      this.onChange();
    });
    return { kind: "wait" };
  }

  #drawCpu(
    pageId: string,
    camera: { x: number; y: number; zoom: number },
    width: number,
    height: number,
    dpr: number,
    background: string,
    state: { hidden: ReadonlySet<string>; whole: string | null },
    exact: boolean,
  ): EngineDraw {
    const worker = this.#cpuWorker;
    const ctx = this.#cpu2d;
    if (!worker || !ctx) return NOT_DRAWN;
    const t0 = performance.now();
    this.#builder.setEditorState(state);
    const z = camera.zoom > 0 ? camera.zoom : 1;
    this.#builder.setView({
      x0: -camera.x / z,
      y0: -camera.y / z,
      x1: (width / dpr - camera.x) / z,
      y1: (height / dpr - camera.y) / z,
    });
    if (!this.#patchCpu(pageId)) return NOT_DRAWN;
    if (this.#listLimit) return this.#pageLimit(pageId, this.#listLimit.reason);
    const t1 = performance.now();
    if (!this.#builder.supported || this.#cpuUnsupportedPage === pageId) {
      this.last = { ...this.last, supported: false, patchMs: t1 - t0 };
      this.#pageSupported(pageId, false);
      return NOT_DRAWN;
    }
    this.#pageSupported(pageId, true);

    const bounded = boundCpuViewport(width, height, dpr);
    const renderW = bounded.width;
    const renderH = bounded.height;
    const cam: Camera = { zoom: camera.zoom, x: camera.x, y: camera.y, dpr: bounded.dpr };
    const imagesExact = this.#updateImages(cam, renderW, renderH);
    const sceneKey = `${pageId}|${this.#cpuRevision}|${this.#imageVersion}|${renderW}x${renderH}|${cam.zoom}|${cam.x}|${cam.y}|${cam.dpr}|${background}`;
    const hasPendingText = this.#builder.pending > 0;
    const textFirst = this.#builder.pendingVisible > 0;

    if (this.#cpuLimitKey === sceneKey) {
      const reason = this.#cpuLimitMessage ?? "frame exceeded CPU render limit";
      if (this.#cpuCompletedKey !== sceneKey) return this.#pageLimit(pageId, reason);
      this.#limitReason = reason;
      return { drawn: true, ready: true, exact: false, ahead: hasPendingText, settled: true };
    }
    this.#limitReason = null;

    // Deduplicate against an already completed frame for identical inputs.
    if (this.#cpuCompletedKey === sceneKey && (this.#cpuCompletedExact || !exact || !imagesExact)) {
      const doneExact = this.#cpuCompletedExact && !textFirst;
      return {
        drawn: true,
        ready: true,
        exact: doneExact,
        ahead: hasPendingText,
        settled: !textFirst && (doneExact || !exact || !imagesExact),
      };
    }

    // Deduplicate against an already in-flight job for identical inputs so slow exact jobs are
    // never cancelled and restarted by an idle settle timer.
    const inflight = this.#cpuJob;
    if (inflight && inflight.sceneKey === sceneKey && (inflight.exact || !exact)) {
      return {
        drawn: true,
        ready: this.#cpuHasPage === pageId,
        exact: false,
        ahead: textFirst,
        settled: inflight.exact && !textFirst,
      };
    }

    if (this.#canvas.width !== renderW || this.#canvas.height !== renderH) {
      this.#canvas.width = renderW;
      this.#canvas.height = renderH;
    }

    // Instant pan/zoom preview: clear and composite the last completed backing frame once so
    // translucent page backgrounds never accumulate underneath.
    let previewReady = false;
    const backed = this.#cpuBacking;
    if (backed && backed.pageId === pageId && backed.revision === this.#cpuRevision) {
      const s = (cam.zoom * cam.dpr) / (backed.camera.zoom * backed.camera.dpr);
      const tx = cam.x * cam.dpr - s * backed.camera.x * backed.camera.dpr;
      const ty = cam.y * cam.dpr - s * backed.camera.y * backed.camera.dpr;
      const bw = backed.width * s;
      const bh = backed.height * s;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, renderW, renderH);
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, renderW, renderH);
      ctx.clearRect(tx, ty, bw, bh);
      ctx.drawImage(backed.canvas, tx, ty, bw, bh);
      previewReady = true;
    }

    const n = ++this.#frame;
    if (this.stamps && exact && this.#builder.pendingVisible === 0 && !this.stamps.drawn) {
      this.stamps.drawn = { n, at: performance.now() };
    }
    const jobId = ++this.#cpuJobId;
    this.#cpuCompletedKey = null;
    this.#cpuCompletedExact = false;
    this.#cpuJob = {
      jobId,
      frame: n,
      sceneKey,
      pageId,
      revision: this.#cpuRevision,
      width: renderW,
      height: renderH,
      camera: cam,
      background,
      exact: exact && !textFirst,
      imagesExact,
      epoch: this.#epoch,
      firstTile: true,
    };
    worker.postMessage({
      type: "render",
      jobId,
      revision: this.#cpuRevision,
      width: renderW,
      height: renderH,
      camera: cam,
      background: colour(background),
      moving: !exact || textFirst,
      tileSize: CPU_TILE_SIZE,
    } satisfies CpuWorkerRequest);

    this.last = {
      ...this.last,
      pageId,
      n,
      patchMs: t1 - t0,
      supported: true,
      exact: false,
      plan: previewReady ? "standin" : "tiles",
      breakdown: { ...this.last.breakdown, patch: t1 - t0 },
    };
    return {
      drawn: true,
      ready: previewReady || this.#cpuHasPage === pageId,
      exact: false,
      ahead: textFirst,
      settled: exact && !textFirst,
    };
  }

  resetReadbackDiag(): void {
    this.readbackDiag = {
      started: 0,
      ok: 0,
      timeout: 0,
      limit: 0,
      error: 0,
      epochDropped: 0,
      sizeDropped: 0,
      genDropped: 0,
      deadDropped: 0,
      presented: 0,
      busySkipped: 0,
      canvasGuardDropped: 0,
      canvasNoSeq: 0,
      canvasNoMotion: 0,
      canvasConfirmed: 0,
      events: [],
    };
  }

  #diagEvent(k: string, n: number, extra?: { ms?: number; code?: number; msg?: string }): void {
    const events = this.readbackDiag.events;
    if (events.length >= 60) events.splice(20, 1);
    events.push({
      t: Math.round(performance.now()),
      k,
      n,
      frame: this.#frame,
      ...(extra ?? {}),
    });
  }

  /**
   * Reads the latest GPU frame back into the 2D canvas: one read-back at a time, always of the
   * newest frame (frames drawn meanwhile are skipped, never queued).
   */
  #readNext(): void {
    const want = this.#want;
    const ctx = this.#readback;
    const engine = this.#engine;
    if (this.#reading) {
      if (want) this.readbackDiag.busySkipped++;
      return;
    }
    if (!want || !ctx || !engine || this.#dead || this.#recovering) return;
    this.#want = null;
    this.#reading = true;
    this.readbackDiag.started++;
    this.#diagEvent("start", want.n);
    const gen = this.#deviceGeneration;
    const t = performance.now();
    void engine.gpuPixels().then((px) => {
      if (gen !== this.#deviceGeneration) {
        this.readbackDiag.genDropped++;
        this.#diagEvent("genDrop", want.n, { ms: Math.round(performance.now() - t) });
        return;
      }
      this.#reading = false;
      if (this.#dead || this.#recovering || this.#engine !== engine) {
        this.readbackDiag.deadDropped++;
        this.#diagEvent("deadDrop", want.n, { ms: Math.round(performance.now() - t) });
        return;
      }
      if (!px.ok) {
        // Keep the existing timeout backoff in charge of waking the next opening slice.
        if (this.#openingFrame === want.n) this.#clearOpeningFrame();
        if (px.code === ErrorCode.Limit) {
          this.readbackDiag.limit++;
          this.#diagEvent("limit", want.n, {
            ms: Math.round(performance.now() - t),
            code: px.code,
            msg: px.message,
          });
          if (want.epoch === this.#epoch && want.n === this.#frame) {
            // A smaller raster is a size recovery only. Timeouts follow the
            // bounded device recovery path below, regardless of raster scale.
            if (want.scale <= MIN_RASTER_SCALE || (want.width === 1 && want.height === 1)) {
              this.#readbackLimit = { key: want.key, reason: px.message };
            } else {
              this.#pendingRasterLimit = px.message;
            }
            this.#limitReason = px.message;
            this.onChange();
          } else {
            this.#readNext();
          }
          return;
        }
        if (px.code === ErrorCode.Timeout) {
          this.readbackDiag.timeout++;
          this.#diagEvent("timeout", want.n, {
            ms: Math.round(performance.now() - t),
            code: px.code,
            msg: px.message,
          });
          const health = engine.gpuCheck();
          if (!health.ok) {
            this.#handleGpuFailure(health, true);
            return;
          }
          // Healthy context whose read-back wait expired: keep the device alive and back off
          // instead of spending the device-loss recovery budget.
          this.#consecutiveTimeouts++;
          if (this.#consecutiveTimeouts >= MAX_CONSECUTIVE_TIMEOUTS) {
            this.#handleGpuFailure(
              {
                message: `GPU read-back timed out ${this.#consecutiveTimeouts} times in a row (${px.message})`,
                code: ErrorCode.Timeout,
              },
              false,
            );
            return;
          }
          if (this.#timeoutBackoffTimer) window.clearTimeout(this.#timeoutBackoffTimer);
          const delay = 250 * this.#consecutiveTimeouts;
          this.#timeoutBackoffTimer = window.setTimeout(() => {
            this.#timeoutBackoffTimer = 0;
            if (
              this.#dead ||
              this.#recovering ||
              this.#engine !== engine ||
              gen !== this.#deviceGeneration
            ) {
              return;
            }
            if (this.#want) this.#readNext();
            else this.onChange();
          }, delay);
          return;
        }
        this.readbackDiag.error++;
        this.#diagEvent("err", want.n, {
          ms: Math.round(performance.now() - t),
          code: px.code,
          msg: px.message,
        });
        if (this.#readbackFailTimer) window.clearTimeout(this.#readbackFailTimer);
        this.#readbackFailTimer = window.setTimeout(() => {
          this.#readbackFailTimer = 0;
          if (
            this.#dead ||
            this.#recovering ||
            this.#engine !== engine ||
            gen !== this.#deviceGeneration
          ) {
            return;
          }
          const health = engine.gpuCheck();
          this.#handleGpuFailure(health.ok ? px : health, true);
        }, 300);
        return;
      }
      this.readbackDiag.ok++;
      this.#consecutiveTimeouts = 0;
      if (want.epoch !== this.#epoch || px.value.length !== want.width * want.height * 4) {
        if (want.epoch !== this.#epoch) this.readbackDiag.epochDropped++;
        else this.readbackDiag.sizeDropped++;
        this.#diagEvent("drop", want.n, { ms: Math.round(performance.now() - t) });
        this.#completeOpeningFrame(want.n);
        this.#readNext();
        return;
      }
      if (this.#canvas.width !== want.width || this.#canvas.height !== want.height) {
        this.#canvas.width = want.width;
        this.#canvas.height = want.height;
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
      this.shown = { n: want.n, at: performance.now() };
      if (this.stamps && !this.stamps.shown && want.exact && want.n === this.#frame)
        this.stamps.shown = { n: want.n, at: performance.now() };
      this.readbackDiag.presented++;
      this.#diagEvent("present", want.n, { ms: Math.round(performance.now() - t) });
      this.onPresented(want.exact && want.n === this.#frame, want.n);
      this.#completeOpeningFrame(want.n);
      this.#readNext();
    });
  }

  /** Unsupported features and optional diagnostic notes, by layer count. */
  unsupported(includeNotes = true): Record<string, number> {
    const out: Record<string, number> = {};
    for (const bits of this.#builder.unsupported.values())
      for (const name of unsupportedNames(includeNotes ? bits : refusingBits(bits)))
        out[name] = (out[name] ?? 0) + 1;
    return out;
  }

  dispose(): void {
    window.clearInterval(this.#health);
    this.#dead = true;
    this.#lifecycle.abort();
    this.#bumpDeviceGeneration();
    document.removeEventListener("visibilitychange", this.#imageVisibility);
    clearTimeout(this.#hiddenImageTimer);
    this.#offImageSource();
    this.#detachImages();
    this.#engine?.dispose();
    this.#engine = null;
    if (this.#cpuWorker) {
      this.#cpuWorker.postMessage({ type: "dispose" } satisfies CpuWorkerRequest);
      this.#cpuWorker.terminate();
      this.#cpuWorker = null;
    }
    this.#cpu2d = null;
    this.#cpuBacking = null;
    if (this.#slot && this.#canvas.parentElement === this.#slot) {
      this.#canvas.remove();
    }
  }
}

/** The last fallback recorded this session, if any. */
export function engineFallback(): FallbackEvent | null {
  return lastFallback;
}
