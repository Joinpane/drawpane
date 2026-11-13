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
 * own name, which keeps the number of distinct files bounded by the catalog.
 *
 * Browsers get woff2. `format=ttf` asks for TrueType instead, one static
 * file per weight, for embedding in exported PDFs.
 *
 * Self-hosters who don't want any traffic to Google set `GOOGLE_FONTS=off`.
 */
import { Hono } from "hono";
import type { AppContext } from "../env";
import { badRequest, HttpError, notFound } from "../lib/http";

const GOOGLE_CSS = "https://fonts.googleapis.com/css2";
const GSTATIC = "https://fonts.gstatic.com/";
/** Where rewritten stylesheets point font URLs: this router's `/gstatic/` route. */
export const GSTATIC_PROXY = "/api/fonts/gstatic/";
/** Google serves woff2 with unicode-range subsets only to browsers it recognises… */
const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

/** …and static TrueType files, one per weight, to anything else. */
const PLAIN_UA = "Drawpane-Fonts/1.0";

const FAMILY = /^[A-Za-z0-9][A-Za-z0-9 ]{0,63}$/;
const VARIANT = /^([1-9]00)(i?)$/;
/** A versioned font file. */
const STATIC_FILE = /^s\/[a-z0-9]+\/v\d+\/[A-Za-z0-9_-]+\.(woff2|ttf)$/;
/** The parts of a kit Google builds for a `text=` subset. */
const KIT = /^[A-Za-z0-9_-]{1,1024}$/;
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

/** Points a Google stylesheet's font URLs at this origin, and blanks anything else it links. */
export function rewriteStylesheet(css: string): string {
  return css.replace(/url\((['"]?)([^)'"]+)\1\)/g, (_, _q: string, href: string) =>
    href.startsWith(GSTATIC) ? `url(${GSTATIC_PROXY}${href.slice(GSTATIC.length)})` : "url()",
  );
}

/** The R2 key for a gstatic path, or null when it isn't one we serve. */
export function fontFileKey(path: string, search: URLSearchParams): string | null {
  if (STATIC_FILE.test(path)) return `fonts/gstatic/${path}`;
  if (path === "l/font") {
    const kit = search.get("kit") ?? "";
    const skey = search.get("skey") ?? "";
    const v = search.get("v") ?? "";
    if (KIT.test(kit) && SKEY.test(skey) && VERSION.test(v))
      return `fonts/gstatic/l/${v}/${skey}/${kit}.woff2`;
  }
  return null;
}

function requireEnabled(env: { GOOGLE_FONTS?: string }): void {
  if (env.GOOGLE_FONTS === "off")
    throw new HttpError(404, "not_found", "Google Fonts are turned off on this server.");
}

/** The font format a file's first bytes declare, or null when it isn't a font we serve. */
function fontFormat(bytes: Uint8Array): "woff2" | "ttf" | null {
  const tag = String.fromCharCode(...bytes.subarray(0, 4));
  if (tag === "wOF2") return "woff2";
  if (tag === "\x00\x01\x00\x00" || tag === "true" || tag === "OTTO") return "ttf";
  return null;
}

const MIME = { woff2: "font/woff2", ttf: "font/ttf" } as const;

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

    const cache = caches.default;
    const cacheKey = new Request(
      `https://fonts.drawpane.internal/?${encodeURIComponent(upstream)}`,
    );
    const hit = await cache.match(cacheKey);
    if (hit) return hit;

    const response = await fetch(upstream, {
      headers: { "user-agent": format === "ttf" ? PLAIN_UA : BROWSER_UA },
    });
    if (!response.ok) throw notFound(`Google Fonts has no family called ${family}.`);
    const out = new Response(rewriteStylesheet(await response.text()), {
      headers: { "content-type": "text/css; charset=utf-8", "cache-control": STYLESHEET_CACHE },
    });
    c.executionCtx.waitUntil(cache.put(cacheKey, out.clone()));
    return out;
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

    const response = await fetch(`${GSTATIC}${path}${url.search}`, {
      headers: { "user-agent": BROWSER_UA },
    });
    if (!response.ok) throw notFound("Google Fonts doesn't have that file.");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (fontFormat(bytes) !== expected || bytes.byteLength > FONT_MAX_BYTES)
      throw notFound("That isn't a font file.");
    await c.env.FILES.put(key, bytes, { httpMetadata: { contentType: MIME[expected] } });
    return new Response(bytes, { headers });
  });
