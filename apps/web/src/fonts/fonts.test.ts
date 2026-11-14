import type { TeamFontFace } from "@drawpane/model";
import { describe, expect, it } from "vitest";
import { matchRank } from "../editor/inspector/FontPicker";
import { loadedFamilies } from "./document-fonts";
import { describeFamily, fonts, nearestWeight, teamFamilies } from "./fonts";

describe("fonts", () => {
  it("knows the built-in families without loading anything", () => {
    expect(fonts.get("Instrument Sans")).toMatchObject({ source: "bundled", variable: true });
    expect(fonts.get("Georgia")?.source).toBe("system");
    expect(fonts.get("Fraunces")).toBeNull();
  });

  it("loads the Google catalog, most popular first, with weights and italics", async () => {
    const google = await fonts.loadGoogle();
    expect(google.length).toBeGreaterThan(1000);
    expect(google.slice(0, 20).map((f) => f.family)).toContain("Roboto");
    const fraunces = fonts.get("Fraunces");
    expect(fraunces).toMatchObject({ source: "google", category: "Serif", variable: true });
    expect(fraunces?.weights).toContain(900);
    expect(fraunces?.italics.length).toBeGreaterThan(0);
    // Bundled families keep their bundled entry.
    expect(fonts.get("Instrument Sans")?.source).toBe("bundled");
    expect(await fonts.resolve("Definitely Not A Font")).toBeNull();
  });

  it("picks the nearest weight, heavier on a tie", () => {
    expect(nearestWeight([400, 700], 600)).toBe(700);
    expect(nearestWeight([300, 500], 400)).toBe(500);
    expect(nearestWeight([400], 900)).toBe(400);
  });

  it("describes a family for its picker row", () => {
    expect(describeFamily(fonts.get("JetBrains Mono") as never)).toBe(
      "Built in · 8 weights · variable",
    );
    expect(describeFamily(fonts.get("Georgia") as never)).toBe("System · 2 weights");
  });

  it("ranks exact, prefix, word and substring matches", () => {
    expect(matchRank("Fraunces", "fraunces")).toBe(0);
    expect(matchRank("Fraunces", "fra")).toBe(1);
    expect(matchRank("Frank Ruhl Libre", "ruh")).toBe(2);
    expect(matchRank("Libre Franklin", "ankl")).toBe(3);
    expect(matchRank("Inter", "xyz")).toBe(-1);
  });

  it("maps loaded faces to document families, skipping previews", () => {
    const face = (family: string) => ({ family }) as FontFace;
    expect(
      loadedFamilies([face('"Instrument Sans Variable"'), face("Fraunces"), face("Inter Preview")]),
    ).toEqual(new Set(["Instrument Sans", "Fraunces"]));
  });

  it("groups a team's faces into families, with a variable face's whole range", () => {
    const face = (
      family: string,
      weight: number,
      italic = false,
      weightMax: number | null = null,
    ) =>
      ({
        id: `${family}-${weight}-${italic}`,
        family,
        style: italic ? "Italic" : "Regular",
        weight,
        weightMax,
        italic,
        format: "woff2",
        sha: "a".repeat(64),
        bytes: 1000,
        license: null,
        restricted: false,
        uploadedBy: "Lena",
        createdAt: 0,
      }) satisfies TeamFontFace;
    const [acme, frame] = teamFamilies([
      face("Frame", 300, false, 700),
      face("Acme Sans", 700),
      face("Acme Sans", 400),
      face("Acme Sans", 400, true),
    ]);
    expect(acme).toMatchObject({
      family: "Acme Sans",
      source: "team",
      weights: [400, 700],
      italics: [400],
    });
    expect(acme?.faces).toHaveLength(3);
    expect(frame).toMatchObject({ weights: [300, 400, 500, 600, 700], variable: true });
    expect(describeFamily(acme as never)).toBe("Team · 2 weights");
  });
});
