import type { FontUse } from "@drawpane/editor";
import {
  BUNDLED_FONT_FAMILIES,
  fontAliasIndex,
  resolveFont,
  SYSTEM_FONT_FAMILIES,
} from "@drawpane/model";
import { describe, expect, it } from "vitest";
import { type FontFamily, fonts } from "./fonts";
import { fontReport, hasStyle, styleLabel } from "./missing-fonts";

const team = (family: string, weights: number[], italics: number[] = []): FontFamily => ({
  family,
  source: "team",
  category: null,
  weights,
  italics,
  variable: false,
});

const use = (family: string, weight: number, layers: string[], sizes: number[], italic = false) =>
  ({ family, weight, italic, layers, styles: [], sizes }) satisfies FontUse;

function lookup(families: FontFamily[], aliases = fontAliasIndex([])) {
  const byName = new Map(families.map((f) => [f.family, f]));
  const get = (name: string) => byName.get(name) ?? null;
  return {
    get,
    resolution: (family: string, size: number) =>
      resolveFont(family, size, (n) => get(n) !== null, aliases),
  };
}

describe("fontReport", () => {
  it("lists a missing family with its styles and layer counts", () => {
    const report = fontReport(
      [use("Söhne", 400, ["a", "b"], [16]), use("Söhne", 700, ["b", "c"], [24])],
      lookup([]),
    );
    expect(report).toHaveLength(1);
    expect(report[0]).toMatchObject({ family: "Söhne", status: "missing", layers: 3 });
    expect(report[0]?.styles.map((s) => [s.label, s.layers.length, s.missing])).toEqual([
      ["Regular", 2, true],
      ["Bold", 2, true],
    ]);
  });

  it("shows SF Pro drawn through the built-in alias, by size", () => {
    const report = fontReport(
      [use("SF Pro", 400, ["a"], [13, 17]), use("SF Pro", 600, ["b"], [34])],
      lookup([team("SF Pro Text", [400, 600]), team("SF Pro Display", [400, 600])]),
    );
    expect(report).toEqual([
      expect.objectContaining({
        family: "SF Pro",
        status: "aliased",
        via: "built-in",
        drawnIn: ["SF Pro Text", "SF Pro Display"],
      }),
    ]);
    expect(report[0]?.styles.every((s) => !s.missing)).toBe(true);
  });

  it("flags a style the alias's family lacks at that size", () => {
    const report = fontReport(
      [use("SF Pro", 600, ["a"], [34])],
      lookup([team("SF Pro Text", [400, 600]), team("SF Pro Display", [400])]),
    );
    expect(report[0]?.styles[0]).toMatchObject({ label: "Semibold", missing: true });
  });

  it("lists a family that's here only for its missing styles", () => {
    const here = lookup([team("Acme", [400, 700])]);
    expect(fontReport([use("Acme", 400, ["a"], [16])], here)).toEqual([]);
    const report = fontReport(
      [use("Acme", 400, ["a"], [16]), use("Acme", 300, ["b"], [16], true)],
      here,
    );
    expect(report[0]?.status).toBe("styles");
    expect(report[0]?.styles.filter((s) => s.missing).map((s) => s.label)).toEqual([
      "Light Italic",
    ]);
  });

  it("puts missing families first, then missing styles, then aliases", () => {
    const report = fontReport(
      [
        use("SF Pro", 400, ["a", "b", "c"], [17]),
        use("Acme", 900, ["d", "e"], [16]),
        use("Gone", 400, ["f"], [16]),
      ],
      lookup([team("SF Pro Text", [400]), team("Acme", [400])]),
    );
    expect(report.map((r) => r.status)).toEqual(["missing", "styles", "aliased"]);
  });
});

describe("styles", () => {
  it("names styles as type designers do", () => {
    expect(styleLabel(400, false)).toBe("Regular");
    expect(styleLabel(400, true)).toBe("Italic");
    expect(styleLabel(600, true)).toBe("Semibold Italic");
    expect(styleLabel(450, false)).toBe("450");
  });

  it("takes a variable family's whole range", () => {
    const variable = {
      ...team("V", [100, 200, 300, 400, 500, 600, 700, 800, 900]),
      variable: true,
    };
    expect(hasStyle(variable, 450, false)).toBe(true);
    expect(hasStyle(variable, 450, true)).toBe(false);
  });
});

describe("the registry", () => {
  it("knows the same system and bundled families as the Worker", () => {
    const system = fonts.builtIn.filter((f) => f.source === "system").map((f) => f.family);
    const bundled = fonts.builtIn.filter((f) => f.source === "bundled").map((f) => f.family);
    expect(system).toEqual(SYSTEM_FONT_FAMILIES);
    expect(bundled).toEqual(BUNDLED_FONT_FAMILIES);
  });

  it("doesn't alias anything before it knows what's here", () => {
    // The catalog hasn't loaded: "SF Pro" might be a Google family, so it stays itself.
    expect(fonts.family("SF Pro", 17)).toBe("SF Pro");
  });
});
