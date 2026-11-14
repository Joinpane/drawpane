import { env } from "cloudflare:test";
import type { TeamFontFace } from "@drawpane/model";
import { describe, expect, it } from "vitest";
import { teamFontKey } from "../src/api/team-fonts";
import ttfUrl from "./fixtures/InstrumentSans-Regular.ttf?inline";
import variableUrl from "./fixtures/InstrumentSans-Variable.woff2?inline";
import woffUrl from "./fixtures/InstrumentSerif-Italic.woff?inline";
import { Browser, signedInUser } from "./helpers";

/** The bytes behind a Vite `?inline` data: URL. */
const bytesOf = (url: string) =>
  Uint8Array.from(atob(url.slice(url.indexOf(",") + 1)), (c) => c.charCodeAt(0));
const TTF = bytesOf(ttfUrl);
const VARIABLE = bytesOf(variableUrl);
const WOFF = bytesOf(woffUrl);

function upload(browser: Browser, teamId: string, body: Uint8Array) {
  return browser.fetch(`/api/teams/${teamId}/fonts`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body,
  });
}

describe("team fonts", () => {
  it("names an upload from the font itself, and lists it by family", async () => {
    const { browser, teamId } = await signedInUser();
    const res = await upload(browser, teamId, TTF);
    expect(res.status).toBe(201);
    const { face } = (await res.json()) as { face: TeamFontFace };
    expect(face).toMatchObject({
      family: "Instrument Sans",
      weight: 400,
      italic: false,
      format: "ttf",
      license: "OFL",
      restricted: false,
      uploadedBy: "Ana Lima",
    });
    expect(await env.FILES.head(teamFontKey(face.sha))).not.toBeNull();

    expect((await upload(browser, teamId, WOFF)).status).toBe(201);
    expect((await upload(browser, teamId, VARIABLE)).status).toBe(201);
    const { faces } = await browser.json<{ faces: TeamFontFace[] }>(`/api/teams/${teamId}/fonts`);
    // The variable font sits beside the static Regular rather than replacing it.
    expect(faces.map((f) => [f.family, f.weight, f.weightMax, f.italic])).toEqual([
      ["Instrument Sans", 400, null, false],
      ["Instrument Sans", 400, 700, false],
      ["Instrument Serif", 400, null, true],
    ]);
  });

  it("replaces the same face instead of adding it twice", async () => {
    const { browser, teamId } = await signedInUser();
    const first = (await (await upload(browser, teamId, TTF)).json()) as { face: TeamFontFace };
    const again = await upload(browser, teamId, TTF);
    expect(again.status).toBe(200);
    const body = (await again.json()) as { face: TeamFontFace; replaced: boolean };
    expect(body.replaced).toBe(true);
    expect(body.face.id).toBe(first.face.id);
  });

  it("serves a stylesheet and the files to the team only", async () => {
    const { browser, teamId } = await signedInUser();
    const { face } = (await (await upload(browser, teamId, WOFF)).json()) as { face: TeamFontFace };
    const css = await (await browser.fetch(`/api/teams/${teamId}/fonts.css`)).text();
    expect(css).toContain('font-family: "Instrument Serif"');
    expect(css).toContain("font-style: italic");
    expect(css).toContain(`url(/api/teams/${teamId}/fonts/file/${face.sha}) format("woff")`);
    const file = await browser.fetch(`/api/teams/${teamId}/fonts/file/${face.sha}`);
    expect(file.headers.get("content-type")).toBe("font/woff");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(WOFF);

    const stranger = await signedInUser("Bo Chen");
    expect((await stranger.browser.fetch(`/api/teams/${teamId}/fonts.css`)).status).toBe(404);
    expect(
      (await stranger.browser.fetch(`/api/teams/${teamId}/fonts/file/${face.sha}`)).status,
    ).toBe(404);
    expect((await new Browser().fetch(`/api/teams/${teamId}/fonts.css`)).status).toBe(401);
  });

  it("refuses files that aren't fonts, and viewers", async () => {
    const { browser, teamId } = await signedInUser();
    const res = await upload(browser, teamId, new TextEncoder().encode("<svg></svg> not a font"));
    expect(res.status).toBe(415);
    expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(
      /isn't a font file/,
    );
    const damaged = await upload(browser, teamId, TTF.slice(0, 300));
    expect(damaged.status).toBe(400);
    const viewer = await signedInUser("Vi Ewer", "viewer", teamId);
    expect((await upload(viewer.browser, teamId, TTF)).status).toBe(403);
  });

  it("removes a face, and its bytes once no team uses them", async () => {
    // A copy no other test uploads (trailing bytes don't change the font).
    const unique = new Uint8Array([...TTF, 0, 0, 0, 7]);
    const a = await signedInUser();
    const b = await signedInUser("Bo Chen");
    const { face } = (await (await upload(a.browser, a.teamId, unique)).json()) as {
      face: TeamFontFace;
    };
    const other = (await (await upload(b.browser, b.teamId, unique)).json()) as {
      face: TeamFontFace;
    };
    expect(other.face.sha).toBe(face.sha);

    const remove = (who: typeof a, id: string) =>
      who.browser.fetch(`/api/teams/${who.teamId}/fonts/${id}`, { method: "DELETE" });
    expect((await remove(a, face.id)).status).toBe(200);
    // Bo's team still uses the same file.
    expect(await env.FILES.head(teamFontKey(face.sha))).not.toBeNull();
    expect((await remove(b, other.face.id)).status).toBe(200);
    expect(await env.FILES.head(teamFontKey(face.sha))).toBeNull();
    expect((await remove(a, face.id)).status).toBe(404);
  });
});
