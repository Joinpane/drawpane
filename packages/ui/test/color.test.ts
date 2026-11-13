import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  contrastLevel,
  contrastRatio,
  hexDigits,
  hslToRgb,
  hsvToRgb,
  parseColor,
  parseHex,
  rgbToHsl,
  rgbToHsv,
  toHex,
} from "../src/lib/color";

describe("hex", () => {
  it("parses every common length and writes the document's format", () => {
    expect(parseHex("#2B4FD6")).toEqual({ r: 43, g: 79, b: 214, a: 1 });
    expect(parseHex("fff")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseHex("#0008")?.a).toBeCloseTo(0x88 / 255);
    expect(parseHex("#12345")).toBeNull();
    expect(parseHex("#zzzzzz")).toBeNull();
    expect(toHex({ r: 43, g: 79, b: 214, a: 1 })).toBe("#2b4fd6");
    expect(toHex({ r: 0, g: 0, b: 0, a: 0.2 })).toBe("#00000033");
    expect(hexDigits({ r: 43, g: 79, b: 214, a: 0.5 })).toBe("2B4FD6");
  });

  it("round-trips every 8-digit hex", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 0xffffffff }), (n) => {
        const hex = `#${n.toString(16).padStart(8, "0")}`;
        const expected = hex.endsWith("ff") ? hex.slice(0, 7) : hex;
        expect(toHex(parseHex(hex) as never)).toBe(expected);
      }),
    );
  });
});

describe("HSV and HSL", () => {
  it("knows the primaries", () => {
    expect(rgbToHsv({ r: 255, g: 0, b: 0, a: 1 })).toEqual({ h: 0, s: 1, v: 1, a: 1 });
    expect(toHex(hsvToRgb({ h: 120, s: 1, v: 1, a: 1 }))).toBe("#00ff00");
    expect(toHex(hsvToRgb({ h: 240, s: 1, v: 1, a: 1 }))).toBe("#0000ff");
    expect(rgbToHsl({ r: 255, g: 0, b: 0, a: 1 })).toEqual({ h: 0, s: 1, l: 0.5 });
  });

  it("round-trips any color through HSV and HSL", () => {
    const color = fc.record({
      r: fc.integer({ min: 0, max: 255 }),
      g: fc.integer({ min: 0, max: 255 }),
      b: fc.integer({ min: 0, max: 255 }),
      a: fc.constant(1),
    });
    fc.assert(
      fc.property(color, (c) => {
        expect(toHex(hsvToRgb(rgbToHsv(c)))).toBe(toHex(c));
        expect(toHex(hslToRgb(rgbToHsl(c)))).toBe(toHex(c));
      }),
    );
  });
});

describe("parseColor", () => {
  it.each([
    ["#2b4fd6", "#2b4fd6"],
    ["2B4FD6", "#2b4fd6"],
    ["rgb(43, 79, 214)", "#2b4fd6"],
    ["rgba(0 0 0 / 50%)", "#00000080"],
    ["43,79,214", "#2b4fd6"],
    ["hsl(0, 100%, 50%)", "#ff0000"],
    ["hsla(240 100% 50% / 0.25)", "#0000ff40"],
  ])("reads %s", (text, hex) => {
    const c = parseColor(text);
    expect(c && toHex(c)).toBe(hex);
  });

  it.each(["", "blue-ish", "rgb(1,2)", "#12"])("rejects %s", (text) => {
    expect(parseColor(text)).toBeNull();
  });
});

describe("contrast", () => {
  it("matches the WCAG reference values", () => {
    const black = { r: 0, g: 0, b: 0, a: 1 };
    const white = { r: 255, g: 255, b: 255, a: 1 };
    expect(contrastRatio(black, white)).toBeCloseTo(21, 5);
    expect(contrastRatio(white, white)).toBeCloseTo(1, 5);
    // #767676 on white is the classic 4.54:1.
    expect(contrastRatio(parseHex("#767676") as never, white)).toBeCloseTo(4.54, 2);
  });

  it("composites a translucent foreground first", () => {
    const halfBlack = { r: 0, g: 0, b: 0, a: 0.5 };
    const white = { r: 255, g: 255, b: 255, a: 1 };
    expect(contrastRatio(halfBlack, white)).toBeLessThan(5);
    expect(contrastRatio(halfBlack, white)).toBeGreaterThan(3);
  });

  it("names the level for body and large text", () => {
    expect(contrastLevel(7.2)).toBe("AAA");
    expect(contrastLevel(4.6)).toBe("AA");
    expect(contrastLevel(3.2)).toBe("AA large");
    expect(contrastLevel(2.9)).toBe("Fail");
    expect(contrastLevel(3.2, true)).toBe("AA");
  });
});
