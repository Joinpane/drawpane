/**
 * Is a newer Drawpane out? Releases are versions of `create-drawpane` on npm
 * (see RELEASING.md), so the Worker asks the npm registry, only when the
 * instance's admin opens the health page, and remembers the answer for six
 * hours. It's the one request the Worker makes on its own behalf besides
 * Google Fonts; `UPDATE_CHECK=off` turns it off (docs/self-hosting.md).
 */
import type { Env } from "../env";

const LATEST = "https://registry.npmjs.org/create-drawpane/latest";
/** A key of our own in the Worker's cache, not a URL anyone requests. */
export const UPDATE_CACHE_KEY = "https://update-check.drawpane.invalid/latest";
const CACHE_SECONDS = 6 * 60 * 60;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export interface AvailableUpdate {
  readonly version: string;
  readonly notesUrl: string;
}

/** The newest released version, or null when unknown (switched off, offline, or npm slow). */
export async function latestVersion(env: Env): Promise<string | null> {
  if (env.UPDATE_CHECK === "off") return null;
  const cache = caches.default;
  const key = new Request(UPDATE_CACHE_KEY);
  try {
    const cached = await cache.match(key);
    if (cached) return ((await cached.json()) as { version: string | null }).version;
    const response = await fetch(LATEST, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) return null;
    const { version } = (await response.json()) as { version?: unknown };
    const latest = typeof version === "string" && VERSION.test(version) ? version : null;
    await cache.put(
      key,
      new Response(JSON.stringify({ version: latest }), {
        headers: {
          "content-type": "application/json",
          "cache-control": `max-age=${CACHE_SECONDS}`,
        },
      }),
    );
    return latest;
  } catch {
    return null;
  }
}

/** A newer release than `running`, with where to read about it; null when up to date or unknown. */
export async function availableUpdate(
  env: Env,
  running: string | null,
): Promise<AvailableUpdate | null> {
  if (!running || !VERSION.test(running)) return null;
  const latest = await latestVersion(env);
  if (!latest || compareVersions(latest, running) <= 0) return null;
  return {
    version: latest,
    notesUrl: `https://github.com/Joinpane/drawpane/releases/tag/v${latest}`,
  };
}

/** Dotted versions: negative when a is older. A pre-release sorts before its release. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core = "", pre] = v.split("-", 2);
    return { parts: core.split(".").map((n) => Number.parseInt(n, 10) || 0), pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.parts.length, y.parts.length); i++) {
    const d = (x.parts[i] ?? 0) - (y.parts[i] ?? 0);
    if (d !== 0) return d;
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === undefined) return 1;
  if (y.pre === undefined) return -1;
  return x.pre < y.pre ? -1 : 1;
}
