/**
 * Font files for the headless editor's text measurer (decision 0021): the
 * same files the browser draws and shapes from, picked as CSS picks them,
 * from Google through the font proxy's upstream and R2, and from a team's
 * uploads; kept for the isolate's life.
 */
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearHeadlessFonts,
  cssWeight,
  type GoogleFamily,
  type HeadlessFontFile,
  headlessFontLoader,
  pickTeamFace,
  unicodeRanges,
} from "../src/headless/font-files";
import ttfUrl from "./fixtures/InstrumentSans-Regular.ttf?inline";
import woffUrl from "./fixtures/InstrumentSerif-Italic.woff?inline";
import { type Browser, signedInUser } from "./helpers";

const bytesOf = (url: string) =>
  Uint8Array.from(atob(url.slice(url.indexOf(",") + 1)), (c) => c.charCodeAt(0));
const TTF = bytesOf(ttfUrl);
const WOFF = bytesOf(woffUrl);

/** A TrueType file's first bytes, then which file it is, so tests can tell files apart. */
const fakeTtf = (name: string) =>
  new Uint8Array([0, 1, 0, 0, ...new TextEncoder().encode(name.padEnd(12, " "))]);
const nameOf = (file: ArrayBuffer | HeadlessFontFile | null) => {
  const bytes = file instanceof ArrayBuffer ? file : file?.bytes;
  return bytes ? new TextDecoder().decode(new Uint8Array(bytes).subarray(4)).trim() : null;
};

const LATIN = "U+0000-00FF, U+0131, U+0152-0153, U+2000-206F";
const LATIN_EXT = "U+0100-02BA, U+1E00-1E9F, U+A720-A7FF";

/** Google, as each user agent sees it: stylesheets per format, manifests, and files. */
function stubGoogle() {
  const calls: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push(url);
    const agent = new Headers(init?.headers).get("user-agent") ?? "";
    const browser = agent.includes("Mozilla");
    if (url.startsWith("https://fonts.googleapis.com/css2")) {
      const query = decodeURIComponent(new URL(url).searchParams.get("family") ?? "");
      const [family = "", spec = ""] = query.split(":");
      const slug = family.replace(/[+ ]/g, "").toLowerCase();
      const variant = spec.replace(/^.*@/, "").replace(",", "-") || "400";
      if (browser)
        return new Response(
          `/* latin-ext */ @font-face { src: url(https://fonts.gstatic.com/s/${slug}/v1/ext.woff2) format('woff2'); unicode-range: ${LATIN_EXT}; }
/* latin */ @font-face { src: url(https://fonts.gstatic.com/s/${slug}/v1/latin.woff2) format('woff2'); unicode-range: ${LATIN}; }`,
        );
      return new Response(
        `@font-face { font-weight: ${variant}; src: url(https://fonts.gstatic.com/s/${slug}/v1/static-${variant}.ttf) format('truetype'); }`,
      );
    }
    if (url.startsWith("https://fonts.google.com/download/list")) {
      const family = new URL(url).searchParams.get("family") ?? "";
      const slug = family.replace(/ /g, "").toLowerCase();
      const name = family.replace(/ /g, "");
      return new Response(
        `)]}'\n${JSON.stringify({
          manifest: {
            fileRefs: [
              {
                filename: `${name}-VariableFont_wght.ttf`,
                url: `https://fonts.gstatic.com/s/${slug}/v1/var.ttf`,
              },
              {
                filename: `${name}-Italic-VariableFont_wght.ttf`,
                url: `https://fonts.gstatic.com/s/${slug}/v1/var-italic.ttf`,
              },
            ],
          },
        })}`,
      );
    }
    if (url.startsWith("https://fonts.gstatic.com/s/")) {
      const path = new URL(url).pathname.split("/");
      return new Response(fakeTtf(`${path[2]}/${path[4]?.replace(".ttf", "")}`));
    }
    return new Response("not stubbed", { status: 500 });
  });
  return calls;
}

const families: Record<string, GoogleFamily> = {
  Inter: {
    weights: [100, 200, 300, 400, 500, 600, 700, 800, 900],
    italics: [100, 400, 900],
    variable: true,
  },
  Lora: { weights: [400, 700], italics: [400], variable: false },
};
const google = async (family: string) => families[family] ?? null;

beforeEach(() => clearHeadlessFonts());
afterEach(() => vi.restoreAllMocks());

describe("cssWeight", () => {
  it("picks as CSS does: exact, then 400 to 500 heavier up to 500, lighter below 400, heavier above 500", () => {
    expect(cssWeight([400, 700], 700)).toBe(700);
    expect(cssWeight([300, 400, 500, 700], 450)).toBe(500);
    expect(cssWeight([300, 700], 450)).toBe(300);
    expect(cssWeight([400, 700], 600)).toBe(700);
    expect(cssWeight([400], 800)).toBe(400);
    expect(cssWeight([200, 500], 300)).toBe(200);
    expect(cssWeight([500, 700], 300)).toBe(500);
    expect(cssWeight([], 400)).toBeNull();
  });
});

describe("pickTeamFace", () => {
  const face = (weight: number, italic = false, weightMax: number | null = null) => ({
    weight,
    weightMax,
    italic,
    format: "ttf" as const,
    sha: `${weight}${italic ? "i" : ""}`,
  });
  it("keeps to the style, draws a variable face anywhere on its range, and a static one as CSS picks", () => {
    const faces = [face(400), face(700), face(300, true), face(100, false, 900)];
    expect(pickTeamFace(faces, { weight: 550, italic: false })).toEqual({
      face: faces[3],
      weight: 550,
    });
    expect(pickTeamFace([face(400), face(700)], { weight: 600, italic: false })?.face.sha).toBe(
      "700",
    );
    expect(pickTeamFace(faces, { weight: 700, italic: true })).toEqual({
      face: faces[2],
      weight: 300,
    });
    expect(pickTeamFace([face(400)], { weight: 700, italic: true })?.face.sha).toBe("400");
  });
});

describe("unicodeRanges", () => {
  it("reads a stylesheet's subsets in order, wildcards as spans", () => {
    expect(
      unicodeRanges(
        "@font-face { unicode-range: U+0000-00FF, U+0131; } @font-face { unicode-range: U+4??; }",
      ),
    ).toEqual([
      [
        [0, 0xff],
        [0x131, 0x131],
      ],
      [[0x400, 0x4ff]],
    ]);
  });
});

describe("headlessFontLoader", () => {
  it("draws a variable Google family from its variable file, at the weight CSS picks, in its subsets", async () => {
    stubGoogle();
    const load = headlessFontLoader({ env, teamId: null, google });
    const file = (await load({
      family: "Inter",
      weight: 650,
      italic: false,
      canvas: true,
    })) as HeadlessFontFile;
    expect(nameOf(file)).toBe("inter/var");
    expect(file.weight).toBe(700);
    expect(file.subsets).toEqual(
      unicodeRanges(`unicode-range: ${LATIN_EXT}; unicode-range: ${LATIN};`),
    );
    // Italic from the italic file, at the italic weights it offers.
    const italic = (await load({
      family: "Inter",
      weight: 600,
      italic: true,
      canvas: true,
    })) as HeadlessFontFile;
    expect(nameOf(italic)).toBe("inter/var-italic");
    expect(italic.weight).toBe(900);
  });

  it("draws a static Google family from the static file CSS picks, and its missing italic upright", async () => {
    stubGoogle();
    const load = headlessFontLoader({ env, teamId: null, google });
    const bold = (await load({
      family: "Lora",
      weight: 600,
      italic: false,
      canvas: true,
    })) as HeadlessFontFile;
    expect(nameOf(bold)).toBe("lora/static-700");
    expect(bold.weight).toBe(700);
    const italic = (await load({
      family: "Lora",
      weight: 700,
      italic: true,
      canvas: true,
    })) as HeadlessFontFile;
    expect(nameOf(italic)).toBe("lora/static-1-400");
  });

  it("gives the shaper what the browser's shaper reads: static files by weight, and variable files", async () => {
    stubGoogle();
    const load = headlessFontLoader({ env, teamId: null, google });
    expect(nameOf(await load({ family: "Inter", weight: 600, italic: false }))).toBe(
      "inter/static-600",
    );
    expect(nameOf(await load({ family: "Lora", weight: 600, italic: false }))).toBe(
      "lora/static-700",
    );
    expect(nameOf(await load({ family: "Inter", weight: 600, italic: true, variable: true }))).toBe(
      "inter/var-italic",
    );
    expect(await load({ family: "Lora", weight: 400, italic: false, variable: true })).toBeNull();
  });

  it("draws the built-in families as the app ships them: upright, within their weights", async () => {
    stubGoogle();
    const load = headlessFontLoader({ env, teamId: null, google });
    const file = (await load({
      family: "Instrument Sans",
      weight: 800,
      italic: true,
      canvas: true,
    })) as HeadlessFontFile;
    expect(nameOf(file)).toBe("instrumentsans/var");
    expect(file.weight).toBe(700);
    expect(file.subsets).toHaveLength(2);
    const serif = (await load({
      family: "Instrument Serif",
      weight: 700,
      italic: false,
      canvas: true,
    })) as HeadlessFontFile;
    expect(nameOf(serif)).toBe("instrumentserif/static-400");
  });

  it("knows the editor's Google catalog without being told", async () => {
    stubGoogle();
    const load = headlessFontLoader({ env, teamId: null });
    expect(nameOf(await load({ family: "Inter", weight: 400, italic: false, canvas: true }))).toBe(
      "inter/var",
    );
    expect(
      await load({ family: "Not A Real Family", weight: 400, italic: false, canvas: true }),
    ).toBeNull();
  });

  it("keeps files for the isolate, copied into R2 as the font proxy does", async () => {
    const calls = stubGoogle();
    const face = { family: "Inter", weight: 400, italic: false, canvas: true };
    await headlessFontLoader({ env, teamId: null, google })(face);
    expect(await env.FILES.head("fonts/gstatic/s/inter/v1/var.ttf")).not.toBeNull();
    const before = calls.filter((u) => u.includes("gstatic")).length;
    await headlessFontLoader({ env, teamId: null, google })(face);
    expect(calls.filter((u) => u.includes("gstatic")).length).toBe(before);
  });

  it("has nothing for system fonts, or for Google families when Google is turned off", async () => {
    stubGoogle();
    expect(
      await headlessFontLoader({ env, teamId: null, google })({
        family: "Arial",
        weight: 400,
        italic: false,
        canvas: true,
      }),
    ).toBeNull();
    const off = headlessFontLoader({ env: { ...env, GOOGLE_FONTS: "off" }, teamId: null, google });
    expect(await off({ family: "Inter", weight: 400, italic: false, canvas: true })).toBeNull();
  });

  it("reads a team's fonts from R2, ahead of any family of their name, but not WOFF", async () => {
    stubGoogle();
    const { browser, teamId } = await signedInUser();
    const upload = (b: Browser, body: Uint8Array) =>
      b.fetch(`/api/teams/${teamId}/fonts`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body,
      });
    expect((await upload(browser, TTF)).status).toBe(201);
    expect((await upload(browser, WOFF)).status).toBe(201);
    const load = headlessFontLoader({ env, teamId, google });
    // Instrument Sans is built in, but the team's upload wins.
    const file = (await load({
      family: "Instrument Sans",
      weight: 700,
      italic: false,
      canvas: true,
    })) as HeadlessFontFile;
    expect(new Uint8Array(file.bytes)).toEqual(TTF);
    expect(file.weight).toBe(400);
    expect(file.subsets).toBeUndefined();
    expect(
      new Uint8Array(
        (await load({ family: "Instrument Sans", weight: 400, italic: false })) as ArrayBuffer,
      ),
    ).toEqual(TTF);
    // Instrument Serif Italic was uploaded as WOFF: no file HarfBuzz can read.
    expect(
      await load({ family: "Instrument Serif", weight: 400, italic: true, canvas: true }),
    ).toBeNull();
  });
});
