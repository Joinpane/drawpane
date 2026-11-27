/**
 * Render engine URL and storage switches, kept separate from `engine-view.ts` so the router
 * can read and persist them before the lazy-loaded editor bundle arrives.
 *
 * The instance can force Canvas. Otherwise the URL, session, browser preference, instance
 * default, and built-in default are tried in that order. URL overrides follow the tab across
 * navigation and sign-in redirects. Presentation and motion keep their own URL and storage switches.
 */

export type RendererChoice = "canvas" | "engine" | "engine-compat" | "engine-webgl" | "engine-cpu";
export type StandardRenderer = "canvas" | "engine";
export interface RendererPolicy {
  readonly defaultRenderer: StandardRenderer | null;
  readonly forceCanvas: boolean;
}
export type RendererSource =
  | "server"
  | "url"
  | "session"
  | "local"
  | "instance-default"
  | "settings-unavailable"
  | "built-in";
export interface RendererSelection {
  readonly choice: RendererChoice;
  readonly source: RendererSource;
}
export const DEFAULT_RENDERER_POLICY: RendererPolicy = {
  defaultRenderer: null,
  forceCanvas: false,
};

// Null means the settings could not be read. Use Canvas for this route.
let policy: RendererPolicy | null = DEFAULT_RENDERER_POLICY;
let selected: RendererSelection | undefined;
let selectedPath: string | undefined;
let selectedUrlChoice: RendererChoice | undefined;
let temporarySession: RendererChoice | undefined;

export function rendererPolicy(): RendererPolicy | null {
  return policy;
}

export function setRendererPolicy(value: RendererPolicy | null): void {
  if (
    policy?.defaultRenderer === value?.defaultRenderer &&
    policy?.forceCanvas === value?.forceCanvas
  )
    return;
  policy = value;
  selected = undefined;
}

export function parseRendererPolicy(value: unknown): RendererPolicy | null {
  if (typeof value !== "object" || value === null) return null;
  const { defaultRenderer, forceCanvas } = value as Partial<RendererPolicy>;
  if (defaultRenderer !== null && defaultRenderer !== "canvas" && defaultRenderer !== "engine")
    return null;
  return typeof forceCanvas === "boolean" ? { defaultRenderer, forceCanvas } : null;
}
export type PresentationMode = "webgpu" | "readback";
/**
 * How interactive zoom/pan motion frames are rendered:
 * - `"standin"` (default): 60 fps cached/scaled tiles during motion, progressive refinement on stop.
 * - `"exact"`: synchronous exact frames during motion.
 */
export type MotionPolicy = "standin" | "exact";

export interface EngineSearch {
  renderer?: RendererChoice;
  present?: PresentationMode;
  motion?: MotionPolicy;
}

export const RENDERER_STORAGE_KEY = "drawpane:renderer";
export const PRESENT_STORAGE_KEY = "drawpane:engine-present";
export const MOTION_POLICY_STORAGE_KEY = "drawpane:motion-policy";
export const SOFTWARE_STORAGE_KEY = "drawpane:engine-software";

export function parseRenderer(value: unknown): RendererChoice | undefined {
  return value === "canvas" ||
    value === "engine" ||
    value === "engine-compat" ||
    value === "engine-webgl" ||
    value === "engine-cpu"
    ? value
    : undefined;
}

export function parsePresent(value: unknown): PresentationMode | undefined {
  return value === "webgpu" || value === "readback" ? value : undefined;
}

export function parseMotionPolicy(value: unknown): MotionPolicy | undefined {
  return value === "standin" || value === "exact" ? value : undefined;
}

/** Validated render engine switches for route `validateSearch` hooks. */
export function engineSearch(search: Record<string, unknown>): EngineSearch {
  const renderer = parseRenderer(search.renderer);
  const present = parsePresent(search.present);
  const motion = parseMotionPolicy(search.motion);
  return {
    ...(renderer ? { renderer } : {}),
    ...(present ? { present } : {}),
    ...(motion ? { motion } : {}),
  };
}

function readParams(search?: string): URLSearchParams {
  if (search === undefined) {
    return new URL(window.location.href).searchParams;
  }
  if (/^https?:\/\//i.test(search)) {
    return new URL(search).searchParams;
  }
  return new URLSearchParams(search);
}

function getSession(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function getLocal(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function rememberRenderer(
  choice: RendererChoice,
  instanceDefault?: StandardRenderer | null,
  keepCanvas = false,
): void {
  try {
    if (
      choice === "canvas" &&
      !keepCanvas &&
      (parseRenderer(getLocal(RENDERER_STORAGE_KEY)) ?? instanceDefault ?? "canvas") === "canvas"
    ) {
      sessionStorage.removeItem(RENDERER_STORAGE_KEY);
    } else {
      sessionStorage.setItem(RENDERER_STORAGE_KEY, choice);
    }
    temporarySession = undefined;
  } catch {
    temporarySession = choice;
  }
}

function rememberPresent(mode: PresentationMode): void {
  try {
    if (mode === "webgpu") {
      if (parsePresent(getLocal(PRESENT_STORAGE_KEY)) === "readback") {
        sessionStorage.setItem(PRESENT_STORAGE_KEY, "webgpu");
      } else {
        sessionStorage.removeItem(PRESENT_STORAGE_KEY);
      }
      return;
    }
    sessionStorage.setItem(PRESENT_STORAGE_KEY, mode);
  } catch {
    // Storage blocked.
  }
}

function rememberMotionPolicy(policy: MotionPolicy): void {
  try {
    if (policy === "standin") {
      if (parseMotionPolicy(getLocal(MOTION_POLICY_STORAGE_KEY)) === "exact") {
        sessionStorage.setItem(MOTION_POLICY_STORAGE_KEY, "standin");
      } else {
        sessionStorage.removeItem(MOTION_POLICY_STORAGE_KEY);
      }
      return;
    }
    sessionStorage.setItem(MOTION_POLICY_STORAGE_KEY, policy);
  } catch {
    // Storage blocked.
  }
}

/**
 * Captures any render engine switches present in a URL query string into `sessionStorage`,
 * so subsequent navigations and login redirects keep them for the session.
 */
export function rememberRendererSwitches(search: string | URLSearchParams): void {
  try {
    const params = typeof search === "string" ? readParams(search) : search;
    const renderer = parseRenderer(params.get("renderer"));
    if (renderer) rememberRenderer(renderer, policy?.defaultRenderer);
    rememberRenderingDetails(params);
  } catch {
    // URL or storage unavailable.
  }
}

function rememberRenderingDetails(params: URLSearchParams): void {
  const present = parsePresent(params.get("present"));
  if (present) rememberPresent(present);
  const motion = parseMotionPolicy(params.get("motion"));
  if (motion) rememberMotionPolicy(motion);
}

/** Resolves the renderer once for a route, before any of its rendering surfaces start. */
export function selectRenderer(
  search?: string,
  settings: RendererPolicy | null = policy,
  keepCanvas = false,
): RendererSelection {
  if (settings?.forceCanvas) return { choice: "canvas", source: "server" };
  if (settings === null) return { choice: "canvas", source: "settings-unavailable" };
  try {
    const url = parseRenderer(readParams(search).get("renderer"));
    if (url) {
      rememberRenderer(url, settings.defaultRenderer, keepCanvas);
      return { choice: url, source: "url" };
    }
  } catch {
    // URL unavailable.
  }
  const session = temporarySession ?? parseRenderer(getSession(RENDERER_STORAGE_KEY));
  if (session) return { choice: session, source: "session" };
  const stored = parseRenderer(getLocal(RENDERER_STORAGE_KEY));
  if (stored) return { choice: stored, source: "local" };
  if (settings.defaultRenderer)
    return { choice: settings.defaultRenderer, source: "instance-default" };
  return { choice: "canvas", source: "built-in" };
}

/** Runs in the router before a screen mounts, including before sign-in redirects. */
export function selectRendererForLocation(path: string, search: string, keepCanvas = false): void {
  const params = readParams(search);
  const urlChoice = parseRenderer(params.get("renderer"));
  if (!selected || path !== selectedPath || (urlChoice && urlChoice !== selectedUrlChoice)) {
    selected = selectRenderer(search, policy, keepCanvas);
    selectedPath = path;
  }
  selectedUrlChoice = urlChoice;
  rememberRenderingDetails(params);
}

export function rendererSelection(): RendererSelection {
  return selected ?? selectRenderer();
}

/** Which renderer the switch asks for. */
export function rendererChoice(search?: string): RendererChoice {
  return (search === undefined ? rendererSelection() : selectRenderer(search)).choice;
}

/** Reload with a browser preference, falling back to the URL if storage is blocked. */
export function switchBrowserRenderer(choice: StandardRenderer): void {
  const url = new URL(window.location.href);
  let saved = false;
  try {
    localStorage.setItem(RENDERER_STORAGE_KEY, choice);
    saved = true;
  } catch {
    // Use the URL if the browser won't save the preference.
  }
  try {
    sessionStorage.removeItem(RENDERER_STORAGE_KEY);
  } catch {
    saved = false;
  }
  if (saved) url.searchParams.delete("renderer");
  else url.searchParams.set("renderer", choice);
  if (url.href === window.location.href) window.location.reload();
  else window.location.replace(url.href);
}

/** Whether product flows should run on the render engine instead of CanvasRenderer. */
export function useEngineRenderer(search?: string): boolean {
  return rendererChoice(search) !== "canvas";
}

/**
 * How frames reach the screen: through the GPU canvas (the product), or read back through
 * a buffer into a 2D canvas (`?present=readback` or `drawpane:engine-present` = "readback").
 * The second is for headless browsers, where presenting a WebGPU canvas loses the device.
 */
export function presentation(search?: string): PresentationMode {
  try {
    const url = parsePresent(readParams(search).get("present"));
    if (url) {
      rememberPresent(url);
      return url;
    }
  } catch {
    // URL unavailable.
  }
  const session = parsePresent(getSession(PRESENT_STORAGE_KEY));
  if (session) return session;
  const stored = parsePresent(getLocal(PRESENT_STORAGE_KEY));
  return stored ?? "webgpu";
}

/**
 * Motion-frame policy: `"standin"` (default, 60 fps scaled cached tiles during pan/zoom with
 * progressive refinement on stop) or `"exact"` (full exact frames during motion).
 */
export function motionPolicy(search?: string): MotionPolicy {
  try {
    const url = parseMotionPolicy(readParams(search).get("motion"));
    if (url) {
      rememberMotionPolicy(url);
      return url;
    }
  } catch {
    // URL unavailable.
  }
  const session = parseMotionPolicy(getSession(MOTION_POLICY_STORAGE_KEY));
  if (session) return session;
  const stored = parseMotionPolicy(getLocal(MOTION_POLICY_STORAGE_KEY));
  return stored ?? "standin";
}

/**
 * Whether the engine may draw on a software GPU adapter (SwiftShader, llvmpipe):
 * `drawpane:engine-software` = "allow". Off by default so slow software GPUs step down to
 * the threaded CPU view mode instead. Headless tests allow it.
 */
export function softwareAllowed(): boolean {
  return getLocal(SOFTWARE_STORAGE_KEY) === "allow";
}
