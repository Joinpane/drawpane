import { env } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import rasterPackage from "../../../packages/raster/package.json";
import runnerPackage from "../../agent-runner/package.json";
import { renderDeps, workerRasteriser } from "../../agent-runner/src/raster";
import { pickFace, stylesheetFaces } from "../../agent-runner/src/raster/fonts";
import { teamFontKey } from "../src/api/team-fonts";
import ttfUrl from "./fixtures/InstrumentSans-Regular.ttf?inline";

const TEAM = "team_render";
const SHA = "e".repeat(64);
const bytesOf = (dataUrl: string) =>
  Uint8Array.from(atob(dataUrl.slice(dataUrl.indexOf(",") + 1)), (c) => c.charCodeAt(0));
const TTF = bytesOf(ttfUrl);
// A 1×1 blue PNG.
const PNG = bytesOf(
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC",
);

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
       VALUES ('font_v', ?, 'Brand Sans', 'Variable', 100, 900, 0, 'ttf', ?, 16, ?)`,
    ).bind(TEAM, "a".repeat(64), now),
    env.DB.prepare(
      "INSERT INTO media (sha, team_id, mime, width, height, bytes, created_at) VALUES (?, ?, 'image/png', 1, 1, ?, ?)",
    ).bind(SHA, TEAM, PNG.byteLength, now),
  ]);
  await env.FILES.put(teamFontKey("f".repeat(64)), TTF);
  await env.FILES.put(teamFontKey("a".repeat(64)), new Uint8Array(16));
  await env.FILES.put(`media/${SHA}`, PNG);
});

afterEach(() => vi.restoreAllMocks());

describe("headless rendering in the Worker", () => {
  it("sets resvg up from the bundled WebAssembly and draws", async () => {
    const r = await workerRasteriser();
    const out = await r.rasterise(
      `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10" viewBox="0 0 20 10"><rect width="20" height="10" fill="#2b4fd6"/></svg>`,
      { scale: 2, fonts: [] },
    );
    expect([out.width, out.height]).toEqual([40, 20]);
    expect(String.fromCharCode(...out.png.subarray(1, 4))).toBe("PNG");
  });

  it("reads a team's fonts and images from R2, and only its own", async () => {
    const deps = await renderDeps(env, TEAM);
    const font = await deps.fonts({ family: "Brand Sans", weight: 700, italic: true });
    // The static face for a weight; the variable file only for text that sets axes.
    expect(font?.byteLength).toBe(TTF.byteLength);
    const variable = await deps.fonts({
      family: "Brand Sans",
      weight: 400,
      italic: false,
      variable: true,
    });
    expect(variable?.byteLength).toBe(16);
    const image = await deps.images(SHA);
    expect(image).toMatchObject({ type: "image/png", width: 1, height: 1 });
    const other = await renderDeps(env, "team_other");
    expect(await other.images(SHA)).toBeNull();
  });

  it("finds Google faces as TrueType, the nearest the family has", async () => {
    const asked: string[] = [];
    const real = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.startsWith("https://fonts.googleapis.com/")) {
        asked.push(decodeURIComponent(url));
        // A static family with only a regular weight: Google refuses the bold.
        if (!url.includes("family=Static+Sans&")) return new Response("no", { status: 400 });
        return new Response(
          "@font-face { font-family: 'Static Sans'; font-style: normal; font-weight: 400; src: url(https://fonts.gstatic.com/s/staticsans/v1/Regular.ttf) format('truetype'); }",
        );
      }
      if (url.startsWith("https://fonts.gstatic.com/")) return new Response(TTF);
      return real(input, init);
    });
    const deps = await renderDeps(env, TEAM);
    const font = await deps.fonts({ family: "Static Sans", weight: 700, italic: false });
    expect(font?.byteLength).toBe(TTF.byteLength);
    expect(asked).toEqual([
      expect.stringContaining("family=Static+Sans:wght@700"),
      expect.stringContaining("family=Static+Sans&"),
    ]);
    // Stored where the font proxy keeps it.
    expect(await env.FILES.head("fonts/gstatic/s/staticsans/v1/Regular.ttf")).not.toBeNull();
    // A family Google doesn't have: nothing, and the renderer falls back.
    expect(await deps.fonts({ family: "Nowhere", weight: 400, italic: false })).toBeNull();
  });
});

describe("the rasteriser's WebAssembly", () => {
  it("is the version @drawpane/raster's glue was written for", () => {
    expect(runnerPackage.dependencies["@resvg/resvg-wasm"]).toBe(
      rasterPackage.dependencies["@resvg/resvg-wasm"],
    );
  });
});

describe("picking a face", () => {
  it("keeps the style, then takes the nearest weight", () => {
    const faces = [
      { weight: 400, italic: false },
      { weight: 700, italic: false },
      { weight: 400, italic: true },
    ];
    expect(pickFace(faces, { weight: 600, italic: false })).toEqual({ weight: 700, italic: false });
    expect(pickFace(faces, { weight: 800, italic: true })).toEqual({ weight: 400, italic: true });
  });

  it("reads a stylesheet's faces", () => {
    expect(
      stylesheetFaces(
        "@font-face { font-style: italic; font-weight: 600; src: url(https://fonts.gstatic.com/s/x/v1/a.ttf) format('truetype'); }",
      ),
    ).toEqual([{ weight: 600, italic: true, url: "https://fonts.gstatic.com/s/x/v1/a.ttf" }]);
  });
});
