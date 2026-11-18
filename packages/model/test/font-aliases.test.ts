import { describe, expect, it } from "vitest";
import {
  aliasSources,
  aliasTargets,
  FontAliasError,
  fontAliasIndex,
  OPTICAL_SIZE_SPLIT,
  parseFontAlias,
  pickAliasTarget,
  resolveFont,
  resolveFontFamily,
} from "../src/font-aliases";

const here =
  (...families: string[]) =>
  (family: string) =>
    families.includes(family);

describe("SF Pro by optical size", () => {
  const team = here("SF Pro Text", "SF Pro Display");

  it("draws text below 20 px in SF Pro Text and 20 px and up in SF Pro Display", () => {
    expect(OPTICAL_SIZE_SPLIT).toBe(20);
    for (const size of [1, 11, 13, 17, 19])
      expect(resolveFontFamily("SF Pro", size, team)).toBe("SF Pro Text");
    for (const size of [20, 22, 28, 34, 96])
      expect(resolveFontFamily("SF Pro", size, team)).toBe("SF Pro Display");
  });

  it("puts the half-points before the line with Text, the line itself with Display", () => {
    expect(resolveFontFamily("SF Pro", 19.5, team)).toBe("SF Pro Text");
    expect(resolveFontFamily("SF Pro", 19.99, team)).toBe("SF Pro Text");
    expect(resolveFontFamily("SF Pro", 20, team)).toBe("SF Pro Display");
    expect(resolveFontFamily("SF Pro", 20.01, team)).toBe("SF Pro Display");
  });

  it("uses whichever cut is here when only one is", () => {
    expect(resolveFontFamily("SF Pro", 34, here("SF Pro Text"))).toBe("SF Pro Text");
    expect(resolveFontFamily("SF Pro", 12, here("SF Pro Display"))).toBe("SF Pro Display");
  });

  it("leaves the family alone when neither cut is here (it shows as missing)", () => {
    expect(resolveFont("SF Pro", 17, here("Inter"))).toEqual({ family: "SF Pro", via: null });
  });

  it("does the same for SF Compact", () => {
    const compact = here("SF Compact Text", "SF Compact Display");
    expect(resolveFontFamily("SF Compact", 15, compact)).toBe("SF Compact Text");
    expect(resolveFontFamily("SF Compact", 24, compact)).toBe("SF Compact Display");
  });

  it("sends the cuts and the old SF UI names to whatever the team has", () => {
    expect(resolveFontFamily("SF Pro Text", 15, here("SF Pro"))).toBe("SF Pro");
    expect(resolveFontFamily("SF Pro Display", 34, here("SF Pro"))).toBe("SF Pro");
    expect(resolveFontFamily("SF UI Text", 15, here("SF Pro Text", "SF Pro"))).toBe("SF Pro Text");
    expect(resolveFontFamily("SF UI Display", 15, here("SF Pro"))).toBe("SF Pro");
  });
});

describe("precedence", () => {
  it("keeps the family itself when it's here: the variable SF Pro wins", () => {
    const all = here("SF Pro", "SF Pro Text", "SF Pro Display");
    expect(resolveFont("SF Pro", 12, all)).toEqual({ family: "SF Pro", via: null });
    expect(resolveFont("SF Pro", 40, all)).toEqual({ family: "SF Pro", via: null });
  });

  it("tries the team's alias before the built-in one", () => {
    const team = fontAliasIndex([{ family: "SF Pro", targets: [{ family: "Inter" }] }]);
    const available = here("Inter", "SF Pro Text", "SF Pro Display");
    expect(resolveFont("SF Pro", 12, available, team)).toEqual({ family: "Inter", via: "team" });
    expect(resolveFont("SF Pro", 40, available, team)).toEqual({ family: "Inter", via: "team" });
  });

  it("falls through to the built-in alias when the team's targets aren't here", () => {
    const team = fontAliasIndex([{ family: "SF Pro", targets: [{ family: "Gone Sans" }] }]);
    expect(resolveFont("SF Pro", 12, here("SF Pro Text"), team)).toEqual({
      family: "SF Pro Text",
      via: "built-in",
    });
  });

  it("never applies a team alias to a family that's here", () => {
    const team = fontAliasIndex([{ family: "Inter", targets: [{ family: "Roboto" }] }]);
    expect(resolveFontFamily("Inter", 16, here("Inter", "Roboto"), team)).toBe("Inter");
  });

  it("doesn't chain aliases", () => {
    const team = fontAliasIndex([{ family: "Brand", targets: [{ family: "SF Pro" }] }]);
    // "SF Pro" isn't here itself, so Brand finds nothing, though SF Pro would resolve.
    expect(resolveFontFamily("Brand", 16, here("SF Pro Text"), team)).toBe("Brand");
  });

  it("lets a team alias split by size too", () => {
    const team = fontAliasIndex([
      {
        family: "Acme",
        targets: [
          { family: "Acme Small", maxSize: 14 },
          { family: "Acme Mid", minSize: 14, maxSize: 40 },
          { family: "Acme Big", minSize: 40 },
        ],
      },
    ]);
    const all = here("Acme Small", "Acme Mid", "Acme Big");
    expect(resolveFontFamily("Acme", 10, all, team)).toBe("Acme Small");
    expect(resolveFontFamily("Acme", 14, all, team)).toBe("Acme Mid");
    expect(resolveFontFamily("Acme", 72, all, team)).toBe("Acme Big");
    // Without the middle cut, 20 px is nearer the small one's range than the big one's.
    expect(resolveFontFamily("Acme", 20, here("Acme Small", "Acme Big"), team)).toBe("Acme Small");
    expect(resolveFontFamily("Acme", 36, here("Acme Small", "Acme Big"), team)).toBe("Acme Big");
  });
});

describe("weights and styles", () => {
  it("are untouched: an alias swaps the family, the face keeps its weight and style", () => {
    // Resolution only ever returns a family; weight and italic come from the text as they are,
    // and the family's own faces are matched to them as for any font.
    for (const size of [12, 17, 34])
      expect(resolveFontFamily("SF Pro", size, here("SF Pro Text", "SF Pro Display"))).toMatch(
        /^SF Pro (Text|Display)$/,
      );
  });
});

describe("lists", () => {
  it("names every family an alias might use, team's first", () => {
    const team = fontAliasIndex([{ family: "SF Pro", targets: [{ family: "Inter" }] }]);
    expect(aliasTargets("SF Pro")).toEqual(["SF Pro Text", "SF Pro Display"]);
    expect(aliasTargets("SF Pro", team)).toEqual(["Inter", "SF Pro Text", "SF Pro Display"]);
    expect(aliasTargets("Roboto")).toEqual([]);
    expect(aliasSources("SF Pro Display")).toEqual(["SF Pro", "SF UI Display"]);
    expect(aliasSources("Inter", team)).toEqual(["SF Pro"]);
  });

  it("picks nothing when no target is here", () => {
    expect(pickAliasTarget([{ family: "A" }], 12, () => false)).toBeNull();
  });
});

describe("parseFontAlias", () => {
  it("tidies names and keeps sizes", () => {
    expect(
      parseFontAlias({
        family: "  SF   Pro ",
        targets: [
          { family: "SF Pro Text", maxSize: 20 },
          { family: "SF Pro Display", minSize: 20 },
        ],
      }),
    ).toEqual({
      family: "SF Pro",
      targets: [
        { family: "SF Pro Text", maxSize: 20 },
        { family: "SF Pro Display", minSize: 20 },
      ],
    });
  });

  it("refuses what isn't an alias", () => {
    const bad = [
      null,
      { family: "", targets: [{ family: "A" }] },
      { family: "A", targets: [] },
      { family: "A", targets: [{ family: "A" }] },
      { family: "A", targets: [{ family: "B", minSize: 20, maxSize: 10 }] },
      { family: "A", targets: [{ family: "B", minSize: -1 }] },
      { family: "A\u0007", targets: [{ family: "B" }] },
      { family: "A", targets: Array.from({ length: 9 }, (_, i) => ({ family: `B${i}` })) },
    ];
    for (const input of bad) expect(() => parseFontAlias(input)).toThrow(FontAliasError);
  });
});
