/**
 * Font aliases in the Worker (decision 0034): the headless measurer draws
 * "SF Pro" text in the team's SF Pro Text below 20 px and SF Pro Display from
 * 20 px, as the editor does, and a team's own alias wins over the built-in
 * one. The SF fonts are stand-ins (OFL fonts renamed, tools/stand-in-fonts).
 */
import { env } from "cloudflare:test";
import { fontString, layoutText } from "@drawpane/editor";
import type { NodeRecord, Props } from "@drawpane/model";
import { describe, expect, it } from "vitest";
import displayUrl from "../../web/e2e/fixtures/SFProDisplay-StandIn-Regular.ttf?inline";
import textBoldUrl from "../../web/e2e/fixtures/SFProText-StandIn-Bold.ttf?inline";
import textUrl from "../../web/e2e/fixtures/SFProText-StandIn-Regular.ttf?inline";
import { harfBuzzMeasurer } from "../src/agent/harfbuzz";
import { headlessFontResolver } from "../src/headless/font-aliases";
import { headlessFontLoader } from "../src/headless/font-files";
import { type Browser, signedInUser } from "./helpers";

const bytesOf = (url: string) =>
  Uint8Array.from(atob(url.slice(url.indexOf(",") + 1)), (c) => c.charCodeAt(0));

function upload(browser: Browser, teamId: string, url: string) {
  return browser.fetch(`/api/teams/${teamId}/fonts`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: bytesOf(url),
  });
}

function setAlias(browser: Browser, teamId: string, body: unknown) {
  return browser.fetch(`/api/teams/${teamId}/font-aliases`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function teamWithSfPro() {
  const user = await signedInUser();
  for (const url of [textUrl, textBoldUrl, displayUrl])
    expect((await upload(user.browser, user.teamId, url)).status).toBe(201);
  return user;
}

const SYMBOL = String.fromCodePoint(0x100185);
const text = (props: Partial<Props>, characters = "Hello"): NodeRecord => ({
  id: "t",
  type: "text",
  parent: "p",
  key: "a0",
  props: { characters, textAutoResize: "width", ...props } as Props,
});

describe("headless font aliases", () => {
  it("resolve SF Pro by size to the team's cuts", async () => {
    const { teamId } = await teamWithSfPro();
    const fonts = headlessFontResolver({
      env,
      teamId: async () => teamId,
      google: async () => null,
    });
    await fonts.prepare(["SF Pro", "Instrument Sans"]);
    expect(fonts.prepared("SF Pro")).toBe(true);
    expect(fonts.family("SF Pro", 17)).toBe("SF Pro Text");
    expect(fonts.family("SF Pro", 19.5)).toBe("SF Pro Text");
    expect(fonts.family("SF Pro", 20)).toBe("SF Pro Display");
    expect(fonts.family("Instrument Sans", 40)).toBe("Instrument Sans");
    expect(fonts.standIns("SF Pro")).toEqual(["SF Pro Text", "SF Pro Display"]);
  });

  it("try the team's alias first, and pick up a new one after a minute", async () => {
    const { browser, teamId } = await teamWithSfPro();
    let now = 1_000;
    const fonts = headlessFontResolver({
      env,
      teamId: async () => teamId,
      google: async () => null,
      now: () => now,
    });
    await fonts.prepare(["SF Pro"]);
    expect(fonts.family("SF Pro", 34)).toBe("SF Pro Display");
    const generation = fonts.generation;

    expect(
      (
        await setAlias(browser, teamId, {
          family: "SF Pro",
          targets: [{ family: "Instrument Sans" }],
        })
      ).status,
    ).toBe(201);
    await fonts.prepare(["SF Pro"]);
    // Still the minute it was looked up in.
    expect(fonts.family("SF Pro", 34)).toBe("SF Pro Display");
    now += 61_000;
    await fonts.prepare(["SF Pro"]);
    expect(fonts.family("SF Pro", 34)).toBe("Instrument Sans");
    expect(fonts.generation).toBeGreaterThan(generation);
  });

  it("measure text as the cut its size calls for, symbols included", async () => {
    const { teamId } = await teamWithSfPro();
    const loader = headlessFontLoader({ env, teamId, google: async () => null });
    const fonts = headlessFontResolver({
      env,
      teamId: async () => teamId,
      google: async () => null,
    });
    const measurer = harfBuzzMeasurer(loader, fonts);
    const face = { family: "SF Pro", weight: 400, italic: false };
    expect(measurer.has(face)).toBe(false);
    await measurer.load([face, { ...face, weight: 700 }]);
    expect(measurer.has(face)).toBe(true);

    const small = layoutText(text({ fontFamily: "SF Pro", fontSize: 17 }), measurer, null);
    expect(small.font).toContain('17px "SF Pro Text"');
    expect(small.width).toBeCloseTo(
      measurer.width(fontString({ fontFamily: "SF Pro Text", fontSize: 17 }), "Hello"),
    );
    const bold = layoutText(
      text({ fontFamily: "SF Pro", fontSize: 17, fontWeight: 700 }),
      measurer,
      null,
    );
    expect(bold.width).toBeGreaterThan(small.width);
    const large = layoutText(text({ fontFamily: "SF Pro", fontSize: 34 }), measurer, null);
    expect(large.font).toContain('34px "SF Pro Display"');

    // The symbol is in the stand-in SF Pro Text (1.25 em); SF Pro Display lacks it: the box (0.7 em).
    const symbol = (size: number) =>
      layoutText(text({ fontFamily: "SF Pro", fontSize: size }, SYMBOL), measurer, null).width;
    expect(symbol(16)).toBeCloseTo(16 * 1.25, 3);
    expect(symbol(40)).toBeCloseTo(40 * 0.7, 3);
  });
});
