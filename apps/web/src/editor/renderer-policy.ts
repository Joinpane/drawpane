import {
  DEFAULT_RENDERER_POLICY,
  parseRendererPolicy,
  type RendererPolicy,
  selectRendererForLocation,
  setRendererPolicy,
} from "./renderer-switch";

const MAX_AGE_MS = 60_000;
const TIMEOUT_MS = 1_500;

let cached: { value: RendererPolicy | null; readAt: number } | undefined;
let loading: Promise<void> | undefined;
let pathname: string | undefined;
let entering: { path: string; search: string; ready: Promise<void> } | undefined;

function isDiagnostics(path: string): boolean {
  return path.replace(/\/$/, "") === "/diagnostics/renderer";
}

async function readPolicy(): Promise<RendererPolicy | null> {
  try {
    const response = await fetch("/api/renderer-policy", {
      cache: "no-store",
      credentials: "omit",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return response.ok ? parseRendererPolicy(await response.json()) : null;
  } catch {
    return null;
  }
}

function refreshPolicy(force = false): Promise<void> | undefined {
  if (loading) return loading;
  if (!force && cached && Date.now() - cached.readAt < MAX_AGE_MS) return undefined;
  loading = readPolicy().then((value) => {
    cached = { value, readAt: Date.now() };
    loading = undefined;
  });
  return loading;
}

export function startRendererPolicy(): void {
  if (isDiagnostics(window.location.pathname)) {
    // The Worker includes the settings in the HTML so standalone diagnostics has no API requests.
    const embedded = document.querySelector<HTMLMetaElement>(
      'meta[name="drawpane-renderer-policy"]',
    );
    let value: RendererPolicy | null = DEFAULT_RENDERER_POLICY;
    if (embedded) {
      try {
        value = parseRendererPolicy(JSON.parse(embedded.content));
      } catch {
        value = null;
      }
    }
    cached = { value, readAt: Date.now() };
  } else {
    void refreshPolicy();
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && !isDiagnostics(window.location.pathname)) {
      // Cache the answer for the next route without restarting an open renderer.
      void refreshPolicy(true);
    }
  });
}

function applyPolicy(path: string, search: string): void {
  setRendererPolicy(cached ? cached.value : DEFAULT_RENDERER_POLICY);
  selectRendererForLocation(path, search, !cached);
}

/** Start the read during route navigation, in parallel with auth and code loading. */
export function enterRendererLocation(path: string, search: string): void {
  if (path === pathname) {
    if (entering) entering.search = search;
    else selectRendererForLocation(path, search, !cached);
    return;
  }
  pathname = path;
  entering = undefined;

  const draws = /^\/(?:f\/[^/]+(?:\/present)?|p\/[^/]+|t\/[^/]+\/new)\/?$/.test(path);
  const waiting = draws ? refreshPolicy() : undefined;
  if (!waiting) {
    applyPolicy(path, search);
    return;
  }
  const next = {
    path,
    search,
    ready: waiting.then(() => {
      if (entering !== next) return;
      entering = undefined;
      applyPolicy(path, next.search);
    }),
  };
  entering = next;
}

export function rendererLocationReady(path: string): Promise<void> | undefined {
  return entering?.path === path ? entering.ready : undefined;
}
