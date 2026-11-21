import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fontFileKey,
  googleStylesheetUrl,
  rewriteStylesheet,
  SCRIPT_FONT_REQUESTS_PER_MINUTE,
  variableFiles,
} from "../src/api/fonts";
import { Browser, signedInUser } from "./helpers";

const WOFF2 = new Uint8Array([0x77, 0x4f, 0x46, 0x32, 1, 2, 3, 4]);
const TTF = new Uint8Array([0x00, 0x01, 0x00, 0x00, 5, 6, 7, 8]);
const CSS = `@font-face {
  font-family: 'Fraunces';
  src: url(https://fonts.gstatic.com/s/fraunces/v38/abc_DEF-1.woff2) format('woff2');
}
@import url(https://evil.example/x.css);`;

/** Google's download manifest, as fonts.google.com serves it: an XSSI guard, then JSON. */
const MANIFEST = `)]}'
${JSON.stringify({
  zipName: "Roboto_Flex.zip",
  manifest: {
    files: [{ filename: "OFL.txt", contents: "…" }],
    fileRefs: [
      {
        filename: "RobotoFlex-VariableFont_GRAD,opsz,wdth,wght.ttf",
        url: "https://fonts.gstatic.com/s/robotoflex/v31/AbC-1.ttf",
      },
      {
        filename: "RobotoFlex-Italic-VariableFont_GRAD,opsz,wdth,wght.ttf",
        url: "https://fonts.gstatic.com/s/robotoflex/v31/AbC-2.ttf",
      },
      {
        filename: "static/RobotoFlex-Bold.ttf",
        url: "https://fonts.gstatic.com/s/robotoflex/v31/AbC-3.ttf",
      },
      { filename: "Evil-VariableFont_wght.ttf", url: "https://evil.example/x.ttf" },
    ],
  },
})}`;

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
    if (url.startsWith("https://fonts.google.com/download/list")) {
      calls.push(url);
      agents.push(new Headers(init?.headers).get("user-agent") ?? "");
      return url.includes("family=Nope")
        ? new Response("no", { status: 400 })
        : new Response(MANIFEST, { headers: { "content-type": "application/json" } });
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

  it("finds a family's variable files in its download manifest, and nothing in anything else", () => {
    expect(variableFiles(MANIFEST)).toEqual([
      { italic: false, url: "/api/fonts/gstatic/s/robotoflex/v31/AbC-1.ttf" },
      { italic: true, url: "/api/fonts/gstatic/s/robotoflex/v31/AbC-2.ttf" },
    ]);
    // A static family lists only static files; a changed or broken manifest means none.
    expect(variableFiles(MANIFEST.replace(/VariableFont_[A-Za-z,]+/g, "Regular"))).toEqual([]);
    expect(variableFiles(')]}\'\n{"manifest":{}}')).toEqual([]);
    expect(variableFiles("<html>")).toEqual([]);
    expect(variableFiles(")]}'\nnull")).toEqual([]);
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

  it("requires a session and populates one shared object for an immutable slice", async () => {
    const requests: URL[] = [];
    const fetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname === "fonts.googleapis.com") {
        requests.push(url);
        return new Response(
          `@font-face{src:url(https://fonts.gstatic.com/l/font?kit=${"a".repeat(1071)}&skey=1234&v=v1)}`,
        );
      }
      if (url.hostname === "fonts.gstatic.com") {
        expect(init?.redirect).toBe("manual");
        requests.push(url);
        return new Response(TTF);
      }
      return fetch(input, init);
    });
    const path = (family: string, slice: string) =>
      `/api/fonts/fallback?${new URLSearchParams({ family, slice })}`;
    const valid = path("Noto Sans SC", "4e00");
    expect((await new Browser().fetch(valid)).status).toBe(401);
    const { browser } = await signedInUser();
    expect((await browser.fetch(path("Unknown", "4e00"))).status).toBe(400);
    expect((await browser.fetch(path("Noto Sans SC", "中漢"))).status).toBe(400);
    expect((await browser.fetch(path("Noto Sans SC", "4e01"))).status).toBe(400);
    expect((await browser.fetch(path("Noto Sans SC", "1000"))).status).toBe(400);
    expect((await browser.fetch(`${valid}&characters=secret`)).status).toBe(400);
    expect(requests).toHaveLength(0);
    const first = await browser.fetch(valid);
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toBe("font/ttf");
    expect(first.headers.get("cache-control")).toContain("private");
    expect(first.headers.get("vary")).toContain("Cookie");
    expect(new Uint8Array(await first.arrayBuffer())).toEqual(TTF);
    const upstream = requests[0]?.searchParams.get("text") ?? "";
    expect([...upstream].map((char) => char.codePointAt(0))).toEqual(
      Array.from({ length: 256 }, (_, index) => 0x4e00 + index),
    );
    expect(await env.FILES.head("fonts/fallback/v1/Noto-Sans-SC/4e00.ttf")).not.toBeNull();
    const another = await signedInUser();
    expect((await another.browser.fetch(valid)).status).toBe(200);
    expect(requests).toHaveLength(2);
  });

  it("limits fallback requests atomically per account, including cached slices", async () => {
    const { browser, userId } = await signedInUser();
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    await env.FILES.put("fonts/fallback/v1/Noto-Sans-JP/3000.ttf", TTF);
    await env.DB.prepare(
      "INSERT INTO font_fallback_limits (user_id, window, requests) VALUES (?, ?, ?)",
    )
      .bind(userId, Math.floor(now / 60_000), SCRIPT_FONT_REQUESTS_PER_MINUTE - 1)
      .run();
    const path = "/api/fonts/fallback?family=Noto+Sans+JP&slice=3000";
    const results = await Promise.all([browser.fetch(path), browser.fetch(path)]);
    expect(results.map((response) => response.status).sort()).toEqual([200, 429]);
    expect(
      Number(results.find((response) => response.status === 429)?.headers.get("retry-after")),
    ).toBeGreaterThan(0);
    vi.mocked(Date.now).mockReturnValue(now + 60_000);
    expect((await browser.fetch(path)).status).toBe(200);
  });

  it("batches fixed slices and shares Google's confirmed misses with other callers", async () => {
    const good = { family: "Noto Sans JP", slice: "3100" };
    const missing = { family: "Noto Sans TC", slice: "32000" };
    await env.FILES.put("fonts/fallback/v1/Noto-Sans-JP/3100.ttf", TTF);
    const lookup = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response("No requested characters in this font.", { status: 400 }),
      );
    const path = "/api/fonts/fallback";
    const args = { method: "POST", json: [missing, good] };
    expect((await new Browser().fetch(path, args)).status).toBe(401);
    const { browser } = await signedInUser();
    const response = await browser.fetch(path, args);
    expect(response.status).toBe(200);
    const form = await response.formData();
    expect(form.get("0")).toBeNull();
    const file = form.get("1");
    expect(file).toBeInstanceOf(Blob);
    expect(new Uint8Array(await (file as Blob).arrayBuffer())).toEqual(TTF);
    expect((await browser.fetch(path, args)).status).toBe(200);
    expect(lookup).toHaveBeenCalledTimes(1);
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

  it("keeps a family's TrueType and WOFF2 stylesheets apart in the cache", async () => {
    // The same Google URL answers each user agent differently, so one mustn't stand in for the other.
    stubGoogle();
    const browser = new Browser();
    await browser.fetch("/api/fonts/google.css?family=Gelasio&variants=400");
    await browser.fetch("/api/fonts/google.css?family=Gelasio&variants=400&format=ttf");
    expect(agents).toHaveLength(2);
    expect(agents[0]).toMatch(/Chrome/);
    expect(agents[1]).not.toMatch(/Chrome/);
  });

  it("names a family's variable files, cached, for text that sets its axes", async () => {
    const calls = stubGoogle();
    const browser = new Browser();
    const res = await browser.fetch("/api/fonts/google-variable?family=Roboto%20Flex");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      files: [
        { italic: false, url: "/api/fonts/gstatic/s/robotoflex/v31/AbC-1.ttf" },
        { italic: true, url: "/api/fonts/gstatic/s/robotoflex/v31/AbC-2.ttf" },
      ],
    });
    expect(calls[0]).toBe("https://fonts.google.com/download/list?family=Roboto%20Flex");
    expect(agents.at(-1)).not.toMatch(/Chrome/);
    expect((await browser.fetch("/api/fonts/google-variable?family=<x>")).status).toBe(400);
    expect((await browser.fetch("/api/fonts/google-variable?family=Nope")).status).toBe(404);
  });

  it("serves a stylesheet and variable files again from the edge cache", async () => {
    // A cached response's headers can't change; the API's own headers still have to go on.
    const calls = stubGoogle();
    const browser = new Browser();
    for (const path of [
      "/api/fonts/google.css?family=Lora&variants=400",
      "/api/fonts/google-variable?family=Recursive",
    ]) {
      const first = await browser.fetch(path);
      expect(first.status).toBe(200);
      const again = await browser.fetch(path);
      expect(again.status).toBe(200);
      expect(await again.text()).toBe(await first.text());
      expect(again.headers.get("x-content-type-options")).toBe("nosniff");
    }
    expect(calls).toHaveLength(2);
  });
});
