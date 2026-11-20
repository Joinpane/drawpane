/**
 * Render engine URL and storage switches, kept separate from `engine-view.ts` so the router
 * can read and persist them before the lazy-loaded editor bundle arrives.
 *
 * Precedence (highest first):
 * 1. URL query parameter (`?renderer=engine`, `?renderer=engine-compat`, `?renderer=canvas`;
 *    `?present=readback`, `?present=webgpu`). Setting one in the URL remembers it in
 *    `sessionStorage` for the rest of the tab session, so in-app navigation, dashboard-to-file
 *    opens, and sign-in redirects keep it.
 * 2. `sessionStorage["drawpane:renderer"]` / `sessionStorage["drawpane:engine-present"]`.
 * 3. `localStorage["drawpane:renderer"]` / `localStorage["drawpane:engine-present"]`.
 * 4. Defaults: `"canvas"` and `"webgpu"`.
 *
 * `?renderer=canvas` turns the engine back off for the session (clearing `sessionStorage`, or
 * storing `"canvas"` in `sessionStorage` when `localStorage` has the engine enabled).
 */

export type RendererChoice = "canvas" | "engine" | "engine-compat";
export type PresentationMode = "webgpu" | "readback";

export interface EngineSearch {
  renderer?: RendererChoice;
  present?: PresentationMode;
}

export const RENDERER_STORAGE_KEY = "drawpane:renderer";
export const PRESENT_STORAGE_KEY = "drawpane:engine-present";
export const SOFTWARE_STORAGE_KEY = "drawpane:engine-software";

export function parseRenderer(value: unknown): RendererChoice | undefined {
  return value === "canvas" || value === "engine" || value === "engine-compat" ? value : undefined;
}

export function parsePresent(value: unknown): PresentationMode | undefined {
  return value === "webgpu" || value === "readback" ? value : undefined;
}

/** Validated render engine switches for route `validateSearch` hooks. */
export function engineSearch(search: Record<string, unknown>): EngineSearch {
  const renderer = parseRenderer(search.renderer);
  const present = parsePresent(search.present);
  return {
    ...(renderer ? { renderer } : {}),
    ...(present ? { present } : {}),
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

function rememberRenderer(choice: RendererChoice): void {
  try {
    if (choice === "canvas") {
      const stored = parseRenderer(localStorage.getItem(RENDERER_STORAGE_KEY));
      if (stored === "engine" || stored === "engine-compat") {
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
      if (parsePresent(localStorage.getItem(PRESENT_STORAGE_KEY)) === "readback") {
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
    const session = parseRenderer(sessionStorage.getItem(RENDERER_STORAGE_KEY));
    if (session) return session;
    const stored = parseRenderer(localStorage.getItem(RENDERER_STORAGE_KEY));
    return stored ?? "canvas";
  } catch {
    return "canvas";
  }
}

/**
 * How frames reach the screen: through the WebGPU canvas (the product), or read back through
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
    const session = parsePresent(sessionStorage.getItem(PRESENT_STORAGE_KEY));
    if (session) return session;
    const stored = parsePresent(localStorage.getItem(PRESENT_STORAGE_KEY));
    return stored ?? "webgpu";
  } catch {
    return "webgpu";
  }
}

/**
 * Whether the engine may draw on a software WebGPU adapter (SwiftShader, llvmpipe):
 * `drawpane:engine-software` = "allow". Off by default: on one, a page of any size draws far
 * slower than the canvas renderer, so the canvas renderer draws instead. Headless tests allow it.
 */
export function softwareAllowed(): boolean {
  try {
    return localStorage.getItem(SOFTWARE_STORAGE_KEY) === "allow";
  } catch {
    return false;
  }
}
