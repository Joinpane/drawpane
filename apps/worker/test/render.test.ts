import { env } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { headlessFontLoader } from "../../agent-runner/src/font-files";
import variableUrl from "../../web/e2e/fixtures/InstrumentSans-Variable.ttf?inline";
import { teamFontKey } from "../src/api/team-fonts";
import ttfUrl from "./fixtures/InstrumentSans-Regular.ttf?inline";

const TEAM = "team_render";
const bytes = (url: string) =>
  Uint8Array.from(atob(url.slice(url.indexOf(",") + 1)), (c) => c.charCodeAt(0));
const TTF = bytes(ttfUrl);
const VARIABLE = bytes(variableUrl);

beforeAll(async () => {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO teams (id, name, created_at) VALUES (?, 'Render', ?)").bind(
      TEAM,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO team_fonts (id, team_id, family, style, weight, weight_max, italic, format, sha, bytes, created_at)
       VALUES ('font_r', ?, 'Brand Sans', 'Regular', 400, NULL, 0, 'ttf', ?, ?, ?)`,
    ).bind(TEAM, "f".repeat(64), TTF.byteLength, now),
    env.DB.prepare(
      `INSERT INTO team_fonts (id, team_id, family, style, weight, weight_max, italic, format, sha, bytes, created_at)
       VALUES ('font_v', ?, 'Brand Sans', 'Variable', 100, 900, 0, 'ttf', ?, ?, ?)`,
    ).bind(TEAM, "a".repeat(64), VARIABLE.byteLength, now),
  ]);
  await env.FILES.put(teamFontKey("f".repeat(64)), TTF);
  await env.FILES.put(teamFontKey("a".repeat(64)), VARIABLE);
});

afterEach(() => vi.restoreAllMocks());

describe("fonts for headless rendering", () => {
  it("reads the team's static and variable font files from R2", async () => {
    const storage = { DB: env.DB, FILES: env.FILES, GOOGLE_FONTS: "off" };
    const fonts = headlessFontLoader({ env: storage, teamId: TEAM });
    const face = { family: "Brand Sans", weight: 400, italic: false };
    expect(await fonts(face)).toEqual(TTF.buffer);
    expect(await fonts({ ...face, variable: true })).toEqual(VARIABLE.buffer);
    const other = headlessFontLoader({ env: storage, teamId: "team_other" });
    expect(await other(face)).toBeNull();
  });

  it("uses the nearest offered Google weight and shares the proxy's cached bytes", async () => {
    const asked: string[] = [];
    const real = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.startsWith("https://fonts.googleapis.com/")) {
        asked.push(decodeURIComponent(url));
        return new Response(
          "@font-face { font-family: 'Static Sans'; font-style: normal; font-weight: 400; src: url(https://fonts.gstatic.com/s/staticsans/v1/Regular.ttf) format('truetype'); }",
        );
      }
      if (url.startsWith("https://fonts.gstatic.com/")) return new Response(TTF);
      return real(input, init);
    });
    const fonts = headlessFontLoader({
      env,
      teamId: TEAM,
      google: async (family) =>
        family === "Static Sans" ? { weights: [400], italics: [], variable: false } : null,
    });
    expect(await fonts({ family: "Static Sans", weight: 700, italic: false })).toEqual(TTF.buffer);
    expect(asked).toEqual([expect.stringContaining("family=Static+Sans&")]);
    expect(await env.FILES.head("fonts/gstatic/s/staticsans/v1/Regular.ttf")).not.toBeNull();
    expect(await fonts({ family: "Nowhere", weight: 400, italic: false })).toBeNull();
  });
});
