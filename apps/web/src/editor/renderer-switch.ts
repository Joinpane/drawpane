/**
 * Render engine URL and storage switches, kept separate from `engine-view.ts` so the router
 * can read and persist them before the lazy-loaded editor bundle arrives.
 *
 * Precedence (highest first):
 * 1. URL query parameter (`?renderer=engine`, `?renderer=engine-compat`, `?renderer=engine-webgl`,
 *    `?renderer=engine-cpu`, `?renderer=canvas`; `?present=readback`, `?present=webgpu`). Setting
 *    one in the URL remembers it in `sessionStorage` for the rest of the tab session, so in-app
 *    navigation, dashboard-to-file opens, and sign-in redirects keep it.
 * 2. `sessionStorage["drawpane:renderer"]` / `sessionStorage["drawpane:engine-present"]`.
 * 3. `localStorage["drawpane:renderer"]` / `localStorage["drawpane:engine-present"]`.
 * 4. Defaults: `"canvas"` and `"webgpu"`.
 *
 * `?renderer=canvas` turns the engine back off for the session (clearing `sessionStorage`, or
 * storing `"canvas"` in `sessionStorage` when `localStorage` has an engine mode enabled).
 */

export type RendererChoice = "canvas" | "engine" | "engine-compat" | "engine-webgl" | "engine-cpu";
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

function rememberRenderer(choice: RendererChoice): void {
  try {
    if (choice === "canvas") {
      const stored = parseRenderer(getLocal(RENDERER_STORAGE_KEY));
      if (stored && stored !== "canvas") {
        sessionStorage.setItem(RENDERER_STORAGE_KEY, "canvas");
      } else {
        sessionStorage.removeItem(RENDERER_STORAGE_KEY);
      }
      return;
    }
    sessionStorage.setItem(RENDERER_STORAGE_KEY, choice);
  } catch {
    // Storage blocked.
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
    if (renderer) rememberRenderer(renderer);
    const present = parsePresent(params.get("present"));
    if (present) rememberPresent(present);
    const motion = parseMotionPolicy(params.get("motion"));
    if (motion) rememberMotionPolicy(motion);
  } catch {
    // URL or storage unavailable.
  }
}

/** Which renderer the switch asks for. */
export function rendererChoice(search?: string): RendererChoice {
  try {
    const url = parseRenderer(readParams(search).get("renderer"));
    if (url) {
      rememberRenderer(url);
      return url;
    }
  } catch {
    // URL unavailable.
  }
  const session = parseRenderer(getSession(RENDERER_STORAGE_KEY));
  if (session) return session;
  const stored = parseRenderer(getLocal(RENDERER_STORAGE_KEY));
  return stored ?? "canvas";
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
