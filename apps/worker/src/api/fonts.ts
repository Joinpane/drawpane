/**
 * Google Fonts, served from this instance.
 *
 * The editor asks for a family's stylesheet here instead of at Google. On
 * first use the Worker fetches it from fonts.googleapis.com, points its font
 * URLs back at this origin, and copies each font file it's asked for into
 * R2 (`fonts/gstatic/…`). From then on everyone, signed in or viewing a
 * shared prototype, loads fonts from this server: browsers never contact
 * Google, and files keep rendering if Google changes or goes away.
 *
 * Stylesheets are small and keyed by what was asked, so they go to the edge
 * cache, not R2. Font files are immutable (their URLs carry a version), so
 * R2 holds each once. A preview stylesheet may only subset a family to its
 * own name. Engine fallbacks use a separate, fixed catalogue of Unicode
 * slices. Requests name a catalogue entry and never carry document characters.
 *
 * Browsers get woff2. `format=ttf` asks for TrueType instead, one static
 * file per weight, for embedding in exported PDFs. `/google-variable` names a
 * family's variable TrueType files, read from Google's download manifest, for
 * text that sets a variable font's axes (decision 0009).
 *
 * Self-hosters who don't want any traffic to Google set `GOOGLE_FONTS=off`.
 */
import { scriptSlice } from "@drawpane/model";
import { Hono } from "hono";
import { requireUser } from "../auth/session";
import type { AppContext } from "../env";
import { badRequest, HttpError, notFound, rateLimited } from "../lib/http";

const GOOGLE_CSS = "https://fonts.googleapis.com/css2";
/** What fonts.google.com's download button reads: a family's files, variable ones included. */
const GOOGLE_DOWNLOAD_LIST = "https://fonts.google.com/download/list";
const GSTATIC = "https://fonts.gstatic.com/";
/** Where rewritten stylesheets point font URLs: this router's `/gstatic/` route. */
export const GSTATIC_PROXY = "/api/fonts/gstatic/";
/** Google serves woff2 with unicode-range subsets only to browsers it recognises… */
const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

/** …and static TrueType files, one per weight, to anything else. */
export const PLAIN_UA = "Drawpane-Fonts/1.0";

const FAMILY = /^[A-Za-z0-9][A-Za-z0-9 ]{0,63}$/;
const VARIANT = /^([1-9]00)(i?)$/;
/** A versioned font file. */
const STATIC_FILE = /^s\/[a-z0-9]+\/v\d+\/[A-Za-z0-9_-]+\.(woff2|ttf)$/;
/** The parts of a kit Google builds for a `text=` subset. */
const KIT = /^[A-Za-z0-9_-]{1,1024}$/;
/** Google encodes a complete, fixed 256-code-point slice in its generated URL. */
const FIXED_KIT = /^[A-Za-z0-9_-]{1,4096}$/;
const SKEY = /^[a-f0-9]{1,64}$/;
const VERSION = /^v\d{1,4}$/;
const FONT_MAX_BYTES = 8 * 1024 * 1024;

const STYLESHEET_CACHE = "public, max-age=86400";
const IMMUTABLE = "public, max-age=31536000, immutable";

/**
 * The Google stylesheet URL for a family and its variants ("400", "700i"),
 * as css2 wants them: `ital,wght@0,400;0,700;1,700`, sorted.
 */
export function googleStylesheetUrl(
  family: string,
  variants: readonly string[],
  text: string | null,
): string {
  const tuples = variants
    .map((v) => VARIANT.exec(v))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => [m[2] ? 1 : 0, Number(m[1])] as const)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const unique = [...new Map(tuples.map((t) => [`${t[0]},${t[1]}`, t])).values()];
  const italic = unique.some(([i]) => i === 1);
  const regularOnly = unique.length === 1 && unique[0]?.[0] === 0 && unique[0][1] === 400;
  let spec = family.replace(/ /g, "+");
  if (unique.length > 0 && !regularOnly) {
    spec += italic
      ? `:ital,wght@${unique.map(([i, w]) => `${i},${w}`).join(";")}`
      : `:wght@${unique.map(([, w]) => w).join(";")}`;
  }
  const url = `${GOOGLE_CSS}?family=${spec}&display=swap`;
  return text ? `${url}&text=${encodeURIComponent(text)}` : url;
}

/** A family's variable font file, served through this origin. */
export interface VariableFile {
  readonly italic: boolean;
  readonly url: string;
}

/** A variable file's name in the manifest, at its top level: `Inter-Italic-VariableFont_opsz,wght.ttf`. */
const VARIABLE_FILENAME = /^[A-Za-z0-9_-]+-VariableFont_[A-Za-z0-9,]+\.ttf$/;

/**
 * The variable files a family's download manifest lists (roman and
 * italic), pointed at this origin. Empty for a static family, and for a
 * manifest that isn't the shape we know: the manifest isn't a documented
 * API, so anything unexpected means "none" (decision 0009).
 */
export function variableFiles(manifest: string): VariableFile[] {
  let json: unknown;
  try {
    // It starts with an XSSI guard line.
    json = JSON.parse(manifest.replace(/^\)\]\}'[^\n]*\n?/, ""));
  } catch {
    return [];
  }
  const refs = (json as { manifest?: { fileRefs?: unknown } } | null)?.manifest?.fileRefs;
  if (!Array.isArray(refs)) return [];
  const out = new Map<boolean, VariableFile>();
  for (const ref of refs) {
    const { filename, url } = (ref ?? {}) as { filename?: unknown; url?: unknown };
    if (typeof filename !== "string" || typeof url !== "string") continue;
    if (!VARIABLE_FILENAME.test(filename) || !url.startsWith(GSTATIC)) continue;
    const path = url.slice(GSTATIC.length);
    if (!STATIC_FILE.test(path)) continue;
    const italic = /-Italic-VariableFont_/.test(filename);
    if (!out.has(italic)) out.set(italic, { italic, url: `${GSTATIC_PROXY}${path}` });
  }
  return [...out.values()];
}

/** Points a Google stylesheet's font URLs at this origin, and blanks anything else it links. */
export function rewriteStylesheet(css: string): string {
  return css.replace(/url\((['"]?)([^)'"]+)\1\)/g, (_, _q: string, href: string) =>
    href.startsWith(GSTATIC) ? `url(${GSTATIC_PROXY}${href.slice(GSTATIC.length)})` : "url()",
  );
}

/** The R2 key for a gstatic path, or null when it isn't one we serve. */
export function fontFileKey(path: string, search: URLSearchParams): string | null {
  return googleFileKey(path, search, KIT);
}

function googleFileKey(path: string, search: URLSearchParams, kitPattern: RegExp): string | null {
  if (STATIC_FILE.test(path)) return `fonts/gstatic/${path}`;
  if (path === "l/font") {
    const kit = search.get("kit") ?? "";
    const skey = search.get("skey") ?? "";
    const v = search.get("v") ?? "";
    if (kitPattern.test(kit) && SKEY.test(skey) && VERSION.test(v))
      return `fonts/gstatic/l/${v}/${skey}/${kit}.woff2`;
  }
  return null;
}

function requireEnabled(env: { GOOGLE_FONTS?: string }): void {
  if (env.GOOGLE_FONTS === "off")
    throw new HttpError(404, "not_found", "Google Fonts are turned off on this server.");
}

/**
 * A response from the edge cache, ready to send: its headers are immutable,
 * and the API's middleware (security headers) still has to add its own.
 */
function fromCache(hit: Response): Response {
  return new Response(hit.body, hit);
}

/** The font format a file's first bytes declare, or null when it isn't a font we serve. */
function fontFormat(bytes: Uint8Array): "woff2" | "ttf" | null {
  const tag = String.fromCharCode(...bytes.subarray(0, 4));
  if (tag === "wOF2") return "woff2";
  if (tag === "\x00\x01\x00\x00" || tag === "true" || tag === "OTTO") return "ttf";
  return null;
}

const MIME = { woff2: "font/woff2", ttf: "font/ttf" } as const;

/** Where stylesheets and manifests are kept at the edge, by what was asked of Google. */
const edgeKey = (kind: string, upstream: string) =>
  new Request(`https://fonts.drawpane.internal/${kind}?${encodeURIComponent(upstream)}`);

/**
 * A Google stylesheet pointed at this origin, from the edge cache or from
 * Google (null when Google has no such family). The two formats are asked
 * for with different user agents from the same URL, so they're kept apart.
 */
export async function googleStylesheet(
  upstream: string,
  format: "woff2" | "ttf",
  waitUntil: (promise: Promise<unknown>) => void,
): Promise<Response | null> {
  const cache = caches.default;
  const cacheKey = edgeKey(format === "ttf" ? "ttf" : "", upstream);
  const hit = await cache.match(cacheKey);
  if (hit) return fromCache(hit);
  const response = await fetch(upstream, {
    headers: { "user-agent": format === "ttf" ? PLAIN_UA : BROWSER_UA },
  });
  if (!response.ok) return null;
  const out = new Response(rewriteStylesheet(await response.text()), {
    headers: { "content-type": "text/css; charset=utf-8", "cache-control": STYLESHEET_CACHE },
  });
  waitUntil(cache.put(cacheKey, out.clone()));
  return out;
}

/** A family's variable files as `{ files }` JSON, from the edge cache or Google's manifest (null when there's no such family). */
export async function googleVariableFiles(
  family: string,
  waitUntil: (promise: Promise<unknown>) => void,
): Promise<Response | null> {
  const upstream = `${GOOGLE_DOWNLOAD_LIST}?family=${encodeURIComponent(family)}`;
  const cache = caches.default;
  const cacheKey = edgeKey("variable", upstream);
  const hit = await cache.match(cacheKey);
  if (hit) return fromCache(hit);
  const response = await fetch(upstream, { headers: { "user-agent": PLAIN_UA } });
  if (!response.ok) return null;
  const out = Response.json(
    { files: variableFiles(await response.text()) },
    { headers: { "cache-control": STYLESHEET_CACHE } },
  );
  waitUntil(cache.put(cacheKey, out.clone()));
  return out;
}

/**
 * Copies a gstatic file (`s/inter/v20/….ttf`, with any query) into R2 at
 * `key`, and answers its bytes; null when Google doesn't have it, or it
 * isn't a font of the format its name says, or it's too big.
 */
export async function copyFromGoogle(
  env: { FILES: R2Bucket },
  key: string,
  pathAndQuery: string,
): Promise<Uint8Array | null> {
  const expected = /\.ttf(\?|$)/.test(pathAndQuery) ? "ttf" : "woff2";
  const response = await fetch(`${GSTATIC}${pathAndQuery}`, {
    headers: { "user-agent": BROWSER_UA },
  });
  if (!response.ok) return null;
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (fontFormat(bytes) !== expected || bytes.byteLength > FONT_MAX_BYTES) return null;
  await env.FILES.put(key, bytes, { httpMetadata: { contentType: MIME[expected] } });
  return bytes;
}

/** Signed-in viewers can request a page's slices at once. One counter per account. */
export const SCRIPT_FONT_REQUESTS_PER_MINUTE = 240;

/** Returns the same fixed outline file to the browser engine and Worker exports. */
export async function scriptFontFile(
  env: { FILES: R2Bucket; GOOGLE_FONTS?: string },
  family: string,
  subset: string,
): Promise<ArrayBuffer | null> {
  const slice = scriptSlice(family, subset);
  if (env.GOOGLE_FONTS === "off" || !slice) return null;
  const key = `fonts/fallback/v1/${family.replaceAll(" ", "-")}/${subset}.ttf`;
  const stored = await env.FILES.get(key);
  if (stored) return stored.arrayBuffer();
  // Google receives a fixed catalogue range. The file and its R2 key are
  // identical for every page that needs any character in that range.
  const characters =
    slice === "all"
      ? null
      : Array.from({ length: slice.end - slice.start + 1 }, (_, offset) =>
          String.fromCodePoint(slice.start + offset),
        ).join("");
  const signal = AbortSignal.timeout(15_000);
  const css = await fetch(googleStylesheetUrl(family, ["400"], characters), {
    headers: { "user-agent": PLAIN_UA },
    signal,
    redirect: "manual",
  });
  if (!css.ok) return null;
  const href = /url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/.exec(await css.text())?.[1];
  if (!href) return null;
  const asset = new URL(href);
  if (!googleFileKey(asset.pathname.slice(1), asset.searchParams, FIXED_KIT)) return null;
  const response = await fetch(asset, { signal, redirect: "manual" });
  if (!response.ok) return null;
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > FONT_MAX_BYTES || fontFormat(new Uint8Array(bytes)) !== "ttf") return null;
  await env.FILES.put(key, bytes, { httpMetadata: { contentType: MIME.ttf } });
  return bytes;
}

export const fonts = new Hono<AppContext>()
  /** What the font picker may offer on this server. */
  .get("/config", (c) =>
    c.json({ google: c.env.GOOGLE_FONTS !== "off" }, 200, { "cache-control": "no-cache" }),
  )
  /**
   * `?family=Fraunces&variants=400,700,400i` for a family, or
   * `?family=Fraunces&text=Fraunces` for a preview of its name.
   */
  .get("/google.css", async (c) => {
    requireEnabled(c.env);
    const family = c.req.query("family") ?? "";
    if (!FAMILY.test(family)) throw badRequest("Name a font family.");
    const variants = (c.req.query("variants") ?? "").split(",").filter(Boolean);
    if (variants.length > 18 || variants.some((v) => !VARIANT.test(v)))
      throw badRequest("Variants are weights like 400, or 400i for italic.");
    const text = c.req.query("text") ?? null;
    if (text !== null && text !== family) throw badRequest("Previews show the family's name.");
    const format = c.req.query("format") ?? "woff2";
    if (format !== "woff2" && format !== "ttf") throw badRequest("Formats are woff2 and ttf.");
    const upstream = googleStylesheetUrl(family, variants, text);
    const out = await googleStylesheet(upstream, format, (p) => c.executionCtx.waitUntil(p));
    if (!out) throw notFound(`Google Fonts has no family called ${family}.`);
    return out;
  })

  /**
   * `?family=Roboto Flex`: the family's variable TrueType files, as
   * `{ files: [{ italic, url }] }` (empty for a static family). Cached at
   * the edge for a day, like stylesheets.
   */
  .get("/google-variable", async (c) => {
    requireEnabled(c.env);
    const family = c.req.query("family") ?? "";
    if (!FAMILY.test(family)) throw badRequest("Name a font family.");
    const out = await googleVariableFiles(family, (p) => c.executionCtx.waitUntil(p));
    if (!out) throw notFound(`Google Fonts has no family called ${family}.`);
    return out;
  })

  .get("/fallback", async (c) => {
    const user = requireUser(c);
    requireEnabled(c.env);
    const family = c.req.query("family") ?? "";
    const subset = c.req.query("slice") ?? "";
    if (
      !scriptSlice(family, subset) ||
      Object.keys(c.req.queries()).some((key) => key !== "family" && key !== "slice")
    )
      throw badRequest("Name a fixed fallback font slice.");
    const window = Math.floor(Date.now() / 60_000);
    const result = await c.env.DB.prepare(
      `INSERT INTO font_fallback_limits (user_id, window, requests) VALUES (?1, ?2, 1)
       ON CONFLICT (user_id) DO UPDATE SET window = ?2,
         requests = CASE WHEN font_fallback_limits.window = ?2 THEN requests + 1 ELSE 1 END
       WHERE font_fallback_limits.window <> ?2 OR font_fallback_limits.requests < ?3`,
    )
      .bind(user.id, window, SCRIPT_FONT_REQUESTS_PER_MINUTE)
      .run();
    if (result.meta.changes === 0) {
      c.header("retry-after", String(60 - (Math.floor(Date.now() / 1000) % 60)));
      throw rateLimited("Too many fallback font requests. Try again shortly.");
    }
    const bytes = await scriptFontFile(c.env, family, subset);
    if (!bytes) throw notFound("No outline font is available for this slice.");
    return new Response(bytes, {
      headers: {
        "content-type": MIME.ttf,
        "cache-control": "private, max-age=86400",
        vary: "Cookie",
      },
    });
  })

  .get("/gstatic/*", async (c) => {
    requireEnabled(c.env);
    const url = new URL(c.req.url);
    const path = url.pathname.slice(GSTATIC_PROXY.length);
    const key = fontFileKey(path, url.searchParams);
    if (!key) throw notFound("That isn't a font file.");
    const expected = path.endsWith(".ttf") ? "ttf" : "woff2";
    const headers = { "content-type": MIME[expected], "cache-control": IMMUTABLE };

    const stored = await c.env.FILES.get(key);
    if (stored) return new Response(stored.body, { headers });
    const bytes = await copyFromGoogle(c.env, key, `${path}${url.search}`);
    if (!bytes) throw notFound("Google Fonts doesn't have that file, or it isn't a font.");
    return new Response(bytes, { headers });
  });

/**
 * A Google font file's bytes, by its gstatic URL or this proxy's: from R2,
 * or fetched and kept there as the proxy does, so the two share one copy.
 * Null when it isn't a file we serve or Google hasn't it. For rendering and
 * measuring text in the Worker (src/render/fonts.ts).
 */
export async function fontFileFromGoogle(
  env: { FILES: R2Bucket },
  href: string,
): Promise<ArrayBuffer | null> {
  const rest = href.startsWith(GSTATIC)
    ? href.slice(GSTATIC.length)
    : href.startsWith(GSTATIC_PROXY)
      ? href.slice(GSTATIC_PROXY.length)
      : null;
  if (rest === null) return null;
  const url = new URL(rest, "https://fonts.gstatic.com/");
  const path = url.pathname.slice(1);
  const key = fontFileKey(path, url.searchParams);
  if (!key) return null;
  const stored = await env.FILES.get(key);
  if (stored) return stored.arrayBuffer();
  const bytes = await copyFromGoogle(env, key, `${path}${url.search}`);
  return bytes
    ? (bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)
    : null;
}
