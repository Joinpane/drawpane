import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fontFileKey, googleStylesheetUrl, rewriteStylesheet } from "../src/api/fonts";
import { Browser } from "./helpers";

const WOFF2 = new Uint8Array([0x77, 0x4f, 0x46, 0x32, 1, 2, 3, 4]);
const TTF = new Uint8Array([0x00, 0x01, 0x00, 0x00, 5, 6, 7, 8]);
const CSS = `@font-face {
  font-family: 'Fraunces';
  src: url(https://fonts.gstatic.com/s/fraunces/v38/abc_DEF-1.woff2) format('woff2');
}
@import url(https://evil.example/x.css);`;

/** Stands in for Google: stylesheets and font files, counting requests. */
const agents: string[] = [];

function stubGoogle() {
  const calls: string[] = [];
  agents.length = 0;
  const real = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith("https://fonts.googleapis.com/")) {
      calls.push(url);
      agents.push(new Headers(init?.headers).get("user-agent") ?? "");
      return url.includes("family=Nope")
        ? new Response("no", { status: 400 })
        : new Response(CSS, { headers: { "content-type": "text/css" } });
    }
    if (url.startsWith("https://fonts.gstatic.com/")) {
      calls.push(url);
      return new Response(url.endsWith(".ttf") ? TTF : WOFF2);
    }
    return real(input, init);
  });
  return calls;
}

afterEach(() => vi.restoreAllMocks());

describe("Google Fonts URLs", () => {
  it("asks css2 for the variants, sorted", () => {
    expect(googleStylesheetUrl("Fraunces", ["700", "400", "400i"], null)).toBe(
      "https://fonts.googleapis.com/css2?family=Fraunces:ital,wght@0,400;0,700;1,400&display=swap",
    );
    expect(googleStylesheetUrl("Open Sans", ["400", "600"], null)).toContain(
      "family=Open+Sans:wght@400;600",
    );
    expect(googleStylesheetUrl("Inter", ["400"], "Inter")).toBe(
      "https://fonts.googleapis.com/css2?family=Inter&display=swap&text=Inter",
    );
  });

  it("points font URLs here and blanks everything else", () => {
    const css = rewriteStylesheet(CSS);
    expect(css).toContain("url(/api/fonts/gstatic/s/fraunces/v38/abc_DEF-1.woff2)");
    expect(css).not.toContain("evil.example");
  });

  it("serves only real gstatic paths", () => {
    const none = new URLSearchParams();
    expect(fontFileKey("s/fraunces/v38/abc.woff2", none)).toBe(
      "fonts/gstatic/s/fraunces/v38/abc.woff2",
    );
    expect(fontFileKey("s/../../secret.woff2", none)).toBeNull();
    expect(fontFileKey("s/fraunces/v38/abc.otf", none)).toBeNull();
    const kit = new URLSearchParams({ kit: "Ab_c-1", skey: "2eca4ab2", v: "v38" });
    expect(fontFileKey("l/font", kit)).toBe("fonts/gstatic/l/v38/2eca4ab2/Ab_c-1.woff2");
    expect(
      fontFileKey("l/font", new URLSearchParams({ kit: "x", skey: "zz", v: "v1" })),
    ).toBeNull();
  });
});

describe("/api/fonts", () => {
  it("tells the picker Google Fonts are on by default", async () => {
    const res = await new Browser().fetch("/api/fonts/config");
    expect(await res.json()).toEqual({ google: true });
  });

  it("serves a rewritten stylesheet to anyone, signed in or not", async () => {
    const calls = stubGoogle();
    const res = await new Browser().fetch("/api/fonts/google.css?family=Fraunces&variants=400,700");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/css");
    expect(await res.text()).toContain("/api/fonts/gstatic/s/fraunces/");
    expect(calls).toHaveLength(1);
  });

  it("refuses bad families, variants and preview text", async () => {
    stubGoogle();
    const browser = new Browser();
    expect((await browser.fetch("/api/fonts/google.css?family=<script>")).status).toBe(400);
    expect((await browser.fetch("/api/fonts/google.css?family=Inter&variants=450")).status).toBe(
      400,
    );
    expect((await browser.fetch("/api/fonts/google.css?family=Inter&text=Hello")).status).toBe(400);
    expect((await browser.fetch("/api/fonts/google.css?family=Nope")).status).toBe(404);
  });

  it("copies a font file to R2 once, then serves it from there", async () => {
    const calls = stubGoogle();
    const browser = new Browser();
    const path = "/api/fonts/gstatic/s/fraunces/v38/abc_DEF-1.woff2";
    const first = await browser.fetch(path);
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toContain("immutable");
    expect(new Uint8Array(await first.arrayBuffer())).toEqual(WOFF2);
    expect(await env.FILES.head("fonts/gstatic/s/fraunces/v38/abc_DEF-1.woff2")).not.toBeNull();
    const second = await browser.fetch(path);
    expect(new Uint8Array(await second.arrayBuffer())).toEqual(WOFF2);
    expect(calls).toHaveLength(1);
    expect((await browser.fetch("/api/fonts/gstatic/s/x/v1/..%2Fsecret.woff2")).status).toBe(404);
  });

  it("serves TrueType for PDF export, asked for without a browser's user agent", async () => {
    const calls = stubGoogle();
    const browser = new Browser();
    const res = await browser.fetch(
      "/api/fonts/google.css?family=Inter&variants=400,700&format=ttf",
    );
    expect(res.status).toBe(200);
    expect(agents.at(-1)).not.toMatch(/Chrome/);
    const font = await browser.fetch("/api/fonts/gstatic/s/inter/v20/AbC-1.ttf");
    expect(font.headers.get("content-type")).toBe("font/ttf");
    expect(new Uint8Array(await font.arrayBuffer())).toEqual(TTF);
    expect(calls.some((u) => u.endsWith(".ttf"))).toBe(true);
    expect((await browser.fetch("/api/fonts/google.css?family=Inter&format=otf")).status).toBe(400);
  });
});
