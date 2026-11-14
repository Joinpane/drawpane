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

/**
 * Compares versions by semver precedence: negative when a is older than b.
 * A pre-release sorts before its release. The installer and the Worker each
 * keep a copy (the installer is published on its own); packages/create-drawpane/src/instance.ts has the other,
 * and both test the same cases.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    // Build metadata ("+abc") doesn't order versions.
    const [core = "", ...pre] = (v.split("+", 1)[0] ?? "").split("-");
    return {
      parts: core.split(".").map((n) => Number.parseInt(n, 10) || 0),
      pre: pre.length > 0 ? pre.join("-").split(".") : [],
    };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.parts.length, y.parts.length); i++) {
    const d = (x.parts[i] ?? 0) - (y.parts[i] ?? 0);
    if (d !== 0) return d;
  }
  // A release is newer than its pre-releases.
  if (x.pre.length === 0 || y.pre.length === 0) return y.pre.length - x.pre.length;
  // Pre-releases part by part: numbers as numbers ("beta.2" < "beta.10"), and before words.
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined || q === undefined) return p === undefined ? -1 : 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) return Number(p) - Number(q);
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}
