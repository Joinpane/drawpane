import { describe, expect, it } from "vitest";
import { featureGroups, featureLabel, featureOn, featureSummary, withFeature } from "./opentype";

describe("OpenType features in the inspector", () => {
  it("lists only what the font offers, grouped, with its stylistic sets by name", () => {
    const offered = new Map<string, string | null>([
      ["tnum", null],
      ["liga", null],
      ["kern", null],
      ["ss02", "Single-storey a"],
      ["ss01", null],
      ["locl", null],
    ]);
    const groups = featureGroups(offered);
    expect(groups.map((g) => [g.title, g.choices.map((c) => c.label)])).toEqual([
      ["Figures", ["Tabular figures"]],
      ["Letters", ["Ligatures", "Kerning"]],
      ["Stylistic sets", ["Stylistic set 1", "Single-storey a"]],
    ]);
  });

  it("keeps a feature the text sets, even when the font lacks it, so it can be turned off", () => {
    const groups = featureGroups(new Map(), { zero: true });
    expect(groups.flatMap((g) => g.choices.map((c) => c.tag))).toEqual(["zero"]);
  });

  it("knows which features fonts turn on by themselves", () => {
    expect(featureOn({}, "liga")).toBe(true);
    expect(featureOn({}, "tnum")).toBe(false);
    expect(featureOn({ liga: false }, "liga")).toBe(false);
  });

  it("stores only what differs from the font's default", () => {
    expect(withFeature({}, "tnum", true)).toEqual({ tnum: true });
    expect(withFeature({ tnum: true }, "tnum", false)).toEqual({});
    expect(withFeature({}, "liga", false)).toEqual({ liga: false });
    expect(withFeature({ liga: false }, "liga", true)).toEqual({});
  });

  it("says what's set in words", () => {
    expect(featureSummary({})).toBeNull();
    expect(featureSummary({ tnum: true, liga: false })).toBe("No ligatures, tabular figures");
    expect(featureSummary({ ss03: true }, new Map([["ss03", "Round dots"]]))).toBe("Round dots");
    expect(featureLabel("cv07")).toBe("Character variant 7");
  });
});
