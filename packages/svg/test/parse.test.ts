import { describe, expect, it } from "vitest";
import {
  looksLikeSvg,
  parseSvg,
  SVG_MAX_BYTES,
  SVG_MAX_ELEMENTS,
  SvgProblem,
  svgToLayers,
} from "../src";
import { parseColor } from "../src/color";
import { parseStyleSheet, specificity } from "../src/style";
import { parseTransform } from "../src/transform";
import { parseLength } from "../src/units";

describe("recognising SVG", () => {
  it("knows markup from icon sets and design tools", () => {
    expect(looksLikeSvg('<svg xmlns="http://www.w3.org/2000/svg"></svg>')).toBe(true);
    expect(looksLikeSvg('  \n<?xml version="1.0"?>\n<!-- Generator: Illustrator --><svg>')).toBe(
      true,
    );
    expect(
      looksLikeSvg(
        '<?xml version="1.0"?><!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x.dtd"><svg viewBox="0 0 1 1"/>',
      ),
    ).toBe(true);
    expect(looksLikeSvg('{"format":"drawpane/nodes"}')).toBe(false);
    expect(looksLikeSvg("Some text mentioning <svg> later")).toBe(false);
    expect(looksLikeSvg("<svgfoo>")).toBe(false);
    expect(looksLikeSvg("\uFEFF<svg/>")).toBe(true);
  });
});

describe("parsing safely", () => {
  it("refuses what isn't SVG, in words", () => {
    expect(() => parseSvg("<html><body>hi</body></html>")).toThrow(SvgProblem);
    expect(() => parseSvg("not markup")).toThrow(/isn't an SVG Drawpane can read/);
  });

  it("forgives markup that isn't well-formed XML, through the HTML parser", () => {
    const r = svgToLayers(
      '<svg width="10" height="10"><rect width="1" height="1" fill="red">&nbsp;</svg>',
    );
    expect(r.root.children).toHaveLength(1);
  });

  it("caps the size and the element count", () => {
    expect(() => parseSvg(`<svg>${" ".repeat(SVG_MAX_BYTES)}</svg>`)).toThrow(/up to 10 MB/);
    const many = `<svg xmlns="http://www.w3.org/2000/svg">${"<g/>".repeat(SVG_MAX_ELEMENTS + 1)}</svg>`;
    expect(() => parseSvg(many)).toThrow(/more than 50,000 elements/);
  });

  it("caps the layers <use> can multiply into", () => {
    // Each level doubles: 2^12 rectangles from a few lines.
    let defs = '<rect id="l0" width="1" height="1"/>';
    for (let i = 1; i <= 12; i++)
      defs += `<g id="l${i}"><use href="#l${i - 1}"/><use href="#l${i - 1}"/></g>`;
    const text = `<svg xmlns="http://www.w3.org/2000/svg"><defs>${defs}</defs><use href="#l12"/></svg>`;
    expect(() => svgToLayers(text, { maxLayers: 1000 })).toThrow(/more than 1,000 layers/);
  });

  it("never attaches the document to the page", () => {
    const root = parseSvg('<svg xmlns="http://www.w3.org/2000/svg"><script>x()</script></svg>');
    expect(root.ownerDocument).not.toBe(document);
    expect(document.querySelector("svg")).toBeNull();
  });
});

describe("pieces", () => {
  it("reads colours", () => {
    expect(parseColor("hsl(0 100% 50% / .5)")).toEqual({ hex: "#ff0000", alpha: 0.5 });
    expect(parseColor("hsla(240deg, 100%, 50%, 1)")).toEqual({ hex: "#0000ff", alpha: 1 });
    expect(parseColor("#abcd")).toEqual({ hex: "#aabbcc", alpha: 0xdd / 255 });
    expect(parseColor("rgb(100%, 0%, 0%)")).toEqual({ hex: "#ff0000", alpha: 1 });
    expect(parseColor("RebeccaPurple")).toEqual({ hex: "#663399", alpha: 1 });
    expect(parseColor("currentColor")).toBeNull();
    expect(parseColor("#12")).toBeNull();
  });

  it("reads lengths", () => {
    const vp = { width: 200, height: 100 };
    expect(parseLength("12pt", "x", vp)).toBe(16);
    expect(parseLength("50%", "x", vp)).toBe(100);
    expect(parseLength("50%", "y", vp)).toBe(50);
    expect(parseLength("1.5em", "x", vp, 10)).toBe(15);
    expect(parseLength("2.54cm", "x", vp)).toBeCloseTo(96, 6);
    expect(parseLength("1e1", "x", vp)).toBe(10);
    expect(parseLength("auto", "x", vp)).toBeNull();
  });

  it("composes transform lists left to right", () => {
    const m = parseTransform("translate(10, 20) scale(2)");
    expect(m).toEqual([2, 0, 0, 2, 10, 20]);
    const r = parseTransform("rotate(90)");
    expect(r.map((n) => Math.round(n * 1e9) / 1e9)).toEqual([0, 1, -1, 0, 0, 0]);
    expect(parseTransform("skewX(45)")[2]).toBeCloseTo(1, 9);
    expect(parseTransform("nonsense(3)")).toEqual([1, 0, 0, 1, 0, 0]);
  });

  it("ranks selectors by specificity", () => {
    expect(specificity("#a")).toBeGreaterThan(specificity(".a.b.c"));
    expect(specificity(".a")).toBeGreaterThan(specificity("g rect"));
    expect(specificity("rect")).toBe(1);
  });

  it("reads style sheets, skipping at-rules with blocks inside", () => {
    const rules = parseStyleSheet(
      "@font-face { font-family: X; src: url(x.woff) } @media (min-width: 1px) { .a { fill: red } } .b, .c { fill: blue; stroke: red !important }",
    );
    expect(rules.map((r) => r.selector)).toEqual([".b", ".c"]);
    expect(rules[0]?.declarations.get("stroke")).toEqual({ value: "red", important: true });
  });
});
