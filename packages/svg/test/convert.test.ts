import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isPropName, PROPS, type PropName, propAllowed } from "@drawpane/model";
import { describe, expect, it } from "vitest";
import { type SvgLayer, svgToLayers } from "../src";

const fixture = (name: string) => readFileSync(join(import.meta.dirname, "fixtures", name), "utf8");

const svg = (body: string, attrs = 'width="100" height="100"') =>
  `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${body}</svg>`;

/** The frame's children, flattened depth first. */
function layers(text: string): SvgLayer[] {
  const out: SvgLayer[] = [];
  const walk = (l: SvgLayer) => {
    for (const c of l.children ?? []) {
      out.push(c);
      walk(c);
    }
  };
  walk(svgToLayers(text).root);
  return out;
}
const only = (text: string) => {
  const all = layers(text);
  expect(all).toHaveLength(1);
  return all[0] as SvgLayer;
};

/** Every prop is one the model has, allowed on the layer's type, with a valid value. */
function expectValid(layer: SvgLayer): void {
  for (const [name, value] of Object.entries(layer.props)) {
    expect(isPropName(name), `${layer.type}.${name}`).toBe(true);
    expect(propAllowed(layer.type, name as PropName), `${layer.type}.${name} allowed`).toBe(true);
    const parsed = PROPS[name as PropName].schema.safeParse(value);
    expect(parsed.success, `${layer.type}.${name} = ${JSON.stringify(value)}`).toBe(true);
  }
  for (const c of layer.children ?? []) expectValid(c);
}

describe("the frame", () => {
  it("is sized by width and height, named, and holds the layers", () => {
    const r = svgToLayers(svg('<rect width="10" height="10"/>', 'width="48" height="32"'), {
      name: "globe",
    });
    expect(r.root.type).toBe("frame");
    expect(r.root.props).toMatchObject({ name: "globe", width: 48, height: 32, fills: [] });
    expect(r.layerCount).toBe(2);
  });

  it("takes its size from the viewBox when width and height are missing", () => {
    const r = svgToLayers(svg("", 'viewBox="0 0 24 12"'));
    expect(r.root.props).toMatchObject({ width: 24, height: 12, name: "SVG" });
  });

  it("follows the viewBox's proportions when one side is given", () => {
    const r = svgToLayers(svg("", 'width="48" viewBox="0 0 24 12"'));
    expect(r.root.props).toMatchObject({ width: 48, height: 24 });
  });

  it("reads units: points, inches, em", () => {
    expect(svgToLayers(svg("", 'width="72pt" height="1in"')).root.props).toMatchObject({
      width: 96,
      height: 96,
    });
    expect(svgToLayers(svg("", 'width="2em" height="10mm"')).root.props).toMatchObject({
      width: 32,
      height: 37.795,
    });
  });

  it("scales the content by the viewBox, keeping its proportions centred (meet)", () => {
    const rect = only(
      svg('<rect width="10" height="10"/>', 'width="40" height="20" viewBox="0 0 10 10"'),
    );
    // Scaled by 2 (the smaller fit), centred across: 10 px in from the left.
    expect(rect.props).toMatchObject({ x: 10, y: 0, width: 20, height: 20 });
  });

  it("stretches with preserveAspectRatio none, and slices", () => {
    const none = only(
      svg(
        '<rect width="10" height="10"/>',
        'width="40" height="20" viewBox="0 0 10 10" preserveAspectRatio="none"',
      ),
    );
    expect(none.props).toMatchObject({ x: 0, y: 0, width: 40, height: 20 });
    const slice = only(
      svg(
        '<rect width="10" height="10"/>',
        'width="40" height="20" viewBox="0 0 10 10" preserveAspectRatio="xMinYMin slice"',
      ),
    );
    expect(slice.props).toMatchObject({ x: 0, y: 0, width: 40, height: 40 });
  });
});

describe("shapes", () => {
  it("makes rectangles with corner radii, and vectors when rx and ry differ", () => {
    const rect = only(svg('<rect x="5" y="6" width="20" height="10" rx="3"/>'));
    expect(rect.type).toBe("rect");
    expect(rect.props).toMatchObject({
      x: 5,
      y: 6,
      width: 20,
      height: 10,
      cornerRadius: 3,
      name: "Rectangle",
    });
    // ry alone sets rx too.
    expect(only(svg('<rect width="20" height="10" ry="2"/>')).props).toMatchObject({
      cornerRadius: 2,
    });
    // Radii past half the side are clamped.
    expect(only(svg('<rect width="20" height="20" rx="30"/>')).props).toMatchObject({
      cornerRadius: 10,
    });
    const elliptical = only(svg('<rect width="20" height="10" rx="4" ry="2"/>'));
    expect(elliptical.type).toBe("path");
    expect(elliptical.props).toMatchObject({ x: 0, y: 0, width: 20, height: 10 });
  });

  it("makes ellipses of circles and ellipses", () => {
    expect(only(svg('<circle cx="10" cy="20" r="5"/>'))).toMatchObject({
      type: "ellipse",
      props: { x: 5, y: 15, width: 10, height: 10 },
    });
    expect(only(svg('<ellipse cx="10" cy="20" rx="8" ry="4"/>'))).toMatchObject({
      type: "ellipse",
      props: { x: 2, y: 16, width: 16, height: 8 },
    });
  });

  it("makes lines, with their length and angle", () => {
    const line = only(svg('<line x1="10" y1="10" x2="10" y2="30" stroke="red"/>'));
    expect(line.type).toBe("line");
    expect(line.props).toMatchObject({ width: 20, height: 0, rotation: 90, x: 0, y: 20 });
  });

  it("makes vectors of paths, polygons and polylines, in their own box", () => {
    const path = only(svg('<path d="M10 10 L30 10 L30 40 Z"/>'));
    expect(path).toMatchObject({
      type: "path",
      props: {
        x: 10,
        y: 10,
        width: 20,
        height: 30,
        pathData: "M0 0 L20 0 L20 30 Z",
        name: "Vector",
      },
    });
    const polygon = only(svg('<polygon points="0,0 10,0 10,10"/>'));
    expect(polygon.props.pathData).toBe("M0 0 L10 0 L10 10 Z");
    const polyline = only(svg('<polyline points="0 0 10 0 10 10" fill="none" stroke="#000"/>'));
    expect(polyline.props.pathData).toBe("M0 0 L10 0 L10 10");
  });

  it("measures curves by their extremes, not their handles", () => {
    const arc = only(svg('<path d="M0 10 A10 10 0 0 1 20 10"/>'));
    expect(arc.props).toMatchObject({ x: 0, y: 0, width: 20, height: 10 });
  });

  it("skips shapes that draw nothing", () => {
    expect(layers(svg('<rect width="0" height="10"/><circle r="0"/><path d=""/>'))).toEqual([]);
  });

  it("names layers by id, data-name, Inkscape label or title", () => {
    expect(only(svg('<rect id="bg" width="1" height="1"/>')).props.name).toBe("bg");
    expect(only(svg('<rect id="x" data-name="Background" width="1" height="1"/>')).props.name).toBe(
      "Background",
    );
    expect(only(svg('<rect width="1" height="1"><title>Sky</title></rect>')).props.name).toBe(
      "Sky",
    );
  });
});

describe("transforms", () => {
  it("puts translation, rotation and uniform scale in a rectangle's box", () => {
    const rect = only(
      svg('<rect width="10" height="20" transform="translate(50 50) rotate(90) scale(2)"/>'),
    );
    expect(rect.type).toBe("rect");
    // 20 × 40 after scaling, turned a quarter about the origin, then moved to (50, 50).
    expect(rect.props).toMatchObject({ width: 20, height: 40, rotation: 90 });
    // Its centre: (10, 20) → rotated (−20, 10) → (30, 60).
    const p = rect.props;
    expect((p.x ?? 0) + 10).toBeCloseTo(30, 3);
    expect((p.y ?? 0) + 20).toBeCloseTo(60, 3);
  });

  it("scales unevenly by the box, and scales corner radii with it", () => {
    const rect = only(svg('<rect width="10" height="10" rx="2" transform="scale(2 1)"/>'));
    // rx 4 across, 2 down: not one radius, so a vector, exactly.
    expect(rect.type).toBe("path");
    const plain = only(svg('<rect width="10" height="10" transform="scale(2 3)"/>'));
    expect(plain).toMatchObject({ type: "rect", props: { width: 20, height: 30 } });
  });

  it("bakes skews into a vector's points", () => {
    const rect = only(svg('<rect width="10" height="10" transform="skewX(45)"/>'));
    expect(rect.type).toBe("path");
    expect(rect.props).toMatchObject({ x: 0, y: 0, width: 20, height: 10 });
    expect(rect.props.pathData).toBe("M0 0 L10 0 L20 10 L10 10 Z");
  });

  it("composes group transforms down the tree, and reads matrix() and rotate about a point", () => {
    const rect = only(
      svg(
        '<g transform="matrix(1 0 0 1 10 0)"><g transform="rotate(180 5 5)"><rect width="10" height="10"/></g></g>',
      ),
    );
    expect(rect.props).toMatchObject({ x: 10, y: 0, width: 10, height: 10 });
    expect(Math.abs(rect.props.rotation ?? 0)).toBe(180);
  });

  it("flips by a negative scale", () => {
    const rect = only(svg('<rect width="10" height="10" transform="scale(-1 1)"/>'));
    expect(rect.props).toMatchObject({ x: -10, y: 0, flipX: true });
  });

  it("reads a CSS transform in a style, with units", () => {
    const rect = only(svg('<rect width="10" height="10" style="transform: translate(5px, 6px)"/>'));
    expect(rect.props).toMatchObject({ x: 5, y: 6 });
  });
});

describe("paint", () => {
  it("fills black by default and strokes nothing", () => {
    const rect = only(svg('<rect width="1" height="1"/>'));
    expect(rect.props.fills).toEqual([{ type: "solid", color: "#000000" }]);
    expect(rect.props.strokes).toBeUndefined();
  });

  it("reads named, short hex, rgb, rgba and hsl colours", () => {
    const fill = (value: string) =>
      only(svg(`<rect width="1" height="1" fill="${value}"/>`)).props.fills;
    expect(fill("tomato")).toEqual([{ type: "solid", color: "#ff6347" }]);
    expect(fill("#0F8")).toEqual([{ type: "solid", color: "#00ff88" }]);
    expect(fill("rgb(255, 0, 128)")).toEqual([{ type: "solid", color: "#ff0080" }]);
    expect(fill("rgba(0,0,255,0.5)")).toEqual([{ type: "solid", color: "#0000ff", opacity: 0.5 }]);
    expect(fill("rgb(0 0 255 / 25%)")).toEqual([
      { type: "solid", color: "#0000ff", opacity: 0.25 },
    ]);
    expect(fill("hsl(120, 100%, 25%)")).toEqual([{ type: "solid", color: "#008000" }]);
    expect(fill("#ff000080")).toEqual([{ type: "solid", color: "#ff0000", opacity: 0.502 }]);
    expect(fill("none")).toEqual([]);
    expect(fill("transparent")).toEqual([]);
  });

  it("reads currentColor from color, black without it", () => {
    const icon = only(svg('<rect width="1" height="1" fill="currentColor"/>'));
    expect(icon.props.fills).toEqual([{ type: "solid", color: "#000000" }]);
    const coloured = only(
      svg('<g color="#336699"><rect width="1" height="1" fill="currentColor"/></g>'),
    );
    expect(coloured.props.fills).toEqual([{ type: "solid", color: "#336699" }]);
  });

  it("multiplies fill-opacity in, and puts opacity on the layer", () => {
    const rect = only(
      svg('<rect width="1" height="1" fill="red" fill-opacity="0.5" opacity="0.4"/>'),
    );
    expect(rect.props.fills).toEqual([{ type: "solid", color: "#ff0000", opacity: 0.5 }]);
    expect(rect.props.opacity).toBe(0.4);
  });

  it("strokes centred, with width, caps, joins and dashes scaled by the transform", () => {
    const path = only(
      svg(
        '<path d="M0 0 L10 0" fill="none" stroke="#123456" stroke-opacity=".5" stroke-width="2" stroke-linecap="round" stroke-linejoin="bevel" stroke-dasharray="1 2 3" transform="scale(2)"/>',
      ),
    );
    expect(path.props).toMatchObject({
      fills: [],
      strokes: [{ type: "solid", color: "#123456", opacity: 0.5 }],
      strokeWeight: 4,
      strokeAlign: "center",
      strokeCap: "round",
      strokeJoin: "bevel",
      // An odd list repeats.
      strokeDashes: [2, 4, 6, 2, 4, 6],
    });
  });

  it("keeps a non-scaling stroke's width", () => {
    const path = only(
      svg(
        '<path d="M0 0 L10 0" stroke="#000" stroke-width="2" vector-effect="non-scaling-stroke" transform="scale(3)"/>',
      ),
    );
    expect(path.props.strokeWeight).toBe(2);
  });

  it("dashes boxes as SVG does: round the outline, as a vector", () => {
    const rect = only(svg('<rect width="10" height="10" stroke="#000" stroke-dasharray="2"/>'));
    expect(rect.type).toBe("path");
  });

  it("reads fill-rule evenodd", () => {
    expect(only(svg('<path d="M0 0h10v10z" fill-rule="evenodd"/>')).props.windingRule).toBe(
      "evenodd",
    );
  });

  it("reads mix-blend-mode", () => {
    expect(
      only(svg('<rect width="1" height="1" style="mix-blend-mode: multiply"/>')).props.blendMode,
    ).toBe("multiply");
  });

  it("reads plus-lighter and plus-darker as linear dodge and burn", () => {
    const mode = (css: string) =>
      only(svg(`<rect width="1" height="1" style="mix-blend-mode: ${css}"/>`)).props.blendMode;
    expect(mode("plus-lighter")).toBe("linear-dodge");
    expect(mode("plus-darker")).toBe("linear-burn");
    expect(mode("normal")).toBeUndefined();
  });
});

describe("styles", () => {
  it("cascades attributes, then rules by specificity, then style, then !important", () => {
    const sheet =
      "<style>rect { fill: blue } .a { fill: green } #r { fill: yellow } .b { fill: purple !important }</style>";
    const fill = (attrs: string) => {
      const fills = only(svg(`${sheet}<rect width="1" height="1" ${attrs}/>`)).props.fills ?? [];
      return (fills[0] as { color: string }).color;
    };
    expect(fill('fill="red"')).toBe("#0000ff");
    expect(fill('class="a" fill="red"')).toBe("#008000");
    expect(fill('id="r" class="a"')).toBe("#ffff00");
    expect(fill('id="r" class="a" style="fill: orange"')).toBe("#ffa500");
    expect(fill('class="b" style="fill: orange"')).toBe("#800080");
  });

  it("inherits from groups and the root, and honours inherit", () => {
    const rect = only(
      svg(
        '<g fill="red" stroke="blue" stroke-width="3"><g fill="green"><rect width="1" height="1" stroke="inherit"/></g></g>',
        'width="10" height="10" stroke-linejoin="round"',
      ),
    );
    expect(rect.props).toMatchObject({
      fills: [{ type: "solid", color: "#008000" }],
      strokes: [{ type: "solid", color: "#0000ff" }],
      strokeWeight: 3,
      strokeJoin: "round",
    });
  });

  it("reads class rules with several selectors, comments and descendant selectors", () => {
    const rect = only(
      svg(
        '<style>/* Illustrator */ .x, .y { fill: #00f } g .z { stroke: #f00; stroke-width: 4px }</style><g><rect class="y z" width="1" height="1"/></g>',
      ),
    );
    expect(rect.props).toMatchObject({
      fills: [{ type: "solid", color: "#0000ff" }],
      strokes: [{ type: "solid", color: "#ff0000" }],
      strokeWeight: 4,
    });
  });

  it("skips at-rules and never fetches what they name", () => {
    const rect = only(
      svg(
        '<style>@import url(https://example.com/x.css); @media print { rect { fill: red } } rect { fill: lime }</style><rect width="1" height="1"/>',
      ),
    );
    expect(rect.props.fills).toEqual([{ type: "solid", color: "#00ff00" }]);
  });

  it("skips hidden elements and marks invisible ones", () => {
    expect(
      layers(
        svg(
          '<rect width="1" height="1" display="none"/><g style="display:none"><rect width="1" height="1"/></g>',
        ),
      ),
    ).toEqual([]);
    expect(only(svg('<g visibility="hidden"><rect width="1" height="1"/></g>')).props.visible).toBe(
      false,
    );
  });

  it("resolves em lengths against the font size", () => {
    const rect = only(
      svg(
        '<g font-size="10"><rect width="2em" height="1em" stroke="#000" stroke-width="0.5em"/></g>',
      ),
    );
    expect(rect.props).toMatchObject({ width: 20, height: 10, strokeWeight: 5 });
  });
});

describe("gradients", () => {
  const defs = (g: string) => `<defs>${g}</defs>`;

  it("lays a bounding-box linear gradient on the layer's unit square", () => {
    const rect = only(
      svg(
        `${defs('<linearGradient id="g"><stop offset="0" stop-color="red"/><stop offset="100%" stop-color="blue" stop-opacity="0.5"/></linearGradient>')}<rect x="10" y="10" width="50" height="20" fill="url(#g)"/>`,
      ),
    );
    expect(rect.props.fills).toEqual([
      {
        type: "linear",
        from: { x: 0, y: 0 },
        to: { x: 1, y: 0 },
        stops: [
          { position: 0, color: "#ff0000" },
          { position: 1, color: "#0000ff80" },
        ],
      },
    ]);
  });

  it("places a user-space linear gradient where it lands on the layer", () => {
    const rect = only(
      svg(
        `${defs('<linearGradient id="g" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="100"><stop stop-color="#fff"/><stop offset="1"/></linearGradient>')}<rect x="0" y="50" width="10" height="50" fill="url(#g)"/>`,
      ),
    );
    // The layer is the gradient's lower half: from 0.5 above it… to its bottom edge, in its unit square.
    const fill = rect.props.fills?.[0] as {
      from: { x: number; y: number };
      to: { x: number; y: number };
    };
    const t = (u: number) => {
      const dx = fill.to.x - fill.from.x;
      const dy = fill.to.y - fill.from.y;
      return ((0.5 - fill.from.x) * dx + (u - fill.from.y) * dy) / (dx * dx + dy * dy);
    };
    expect(t(0)).toBeCloseTo(0.5, 3);
    expect(t(1)).toBeCloseTo(1, 3);
  });

  it("follows gradientTransform, href templates and fill-opacity", () => {
    const rect = only(
      svg(
        `${defs('<linearGradient id="base"><stop stop-color="#000"/><stop offset="1" stop-color="#fff"/></linearGradient><linearGradient id="g" href="#base" gradientTransform="rotate(90 .5 .5)"/>')}<rect width="10" height="10" fill="url(#g)" fill-opacity="0.5"/>`,
      ),
    );
    const fill = rect.props.fills?.[0] as {
      type: string;
      from: object;
      to: object;
      opacity: number;
    };
    expect(fill.type).toBe("linear");
    expect(fill.opacity).toBe(0.5);
    // Turned a quarter: top to bottom.
    const from = fill.from as { x: number; y: number };
    const to = fill.to as { x: number; y: number };
    expect(from.y).toBe(0);
    expect({ x: to.x - from.x, y: to.y - from.y }).toEqual({ x: 0, y: 1 });
  });

  it("makes radial gradients circles in the unit square", () => {
    const circle = only(
      svg(
        `${defs('<radialGradient id="g"><stop stop-color="#fff"/><stop offset="1" stop-color="#000"/></radialGradient>')}<ellipse cx="50" cy="50" rx="40" ry="20" fill="url(#g)"/>`,
      ),
    );
    expect(circle.props.fills).toMatchObject([
      { type: "radial", from: { x: 0.5, y: 0.5 }, to: { x: 1, y: 0.5 } },
    ]);
  });

  it("notes a radial gradient it can only approximate, and an off-centre focus", () => {
    const r = svgToLayers(
      svg(
        `${defs('<radialGradient id="g" gradientUnits="userSpaceOnUse" cx="50" cy="50" r="40" fx="30"><stop stop-color="#fff"/><stop offset="1"/></radialGradient>')}<rect width="100" height="20" fill="url(#g)"/>`,
      ),
    );
    expect(r.notes.lines()).toEqual(["2 gradients were approximated"]);
  });

  it("paints one stop solid, no stops nothing, and a pattern with its fallback", () => {
    const one = only(
      svg(
        `${defs('<linearGradient id="g"><stop stop-color="#abcdef"/></linearGradient>')}<rect width="1" height="1" fill="url(#g)"/>`,
      ),
    );
    expect(one.props.fills).toEqual([{ type: "solid", color: "#abcdef" }]);
    const none = only(
      svg(`${defs('<linearGradient id="g"/>')}<rect width="1" height="1" fill="url(#g)"/>`),
    );
    expect(none.props.fills).toEqual([]);
    const r = svgToLayers(
      svg(`${defs('<pattern id="p"/>')}<rect width="1" height="1" fill="url(#p) #123123"/>`),
    );
    expect(r.root.children?.[0]?.props.fills).toEqual([{ type: "solid", color: "#123123" }]);
    expect(r.notes.lines()).toEqual(["1 pattern fill was left out"]);
  });
});

describe("structure", () => {
  it("keeps named groups and their opacity, and drops plain single-child wrappers", () => {
    const tree = svgToLayers(
      svg(
        '<g id="Icons" opacity=".5"><rect width="1" height="1"/><circle r="1"/></g><g><rect width="2" height="2"/></g>',
      ),
    ).root.children;
    expect(tree?.map((l) => l.type)).toEqual(["group", "rect"]);
    expect(tree?.[0]?.props).toMatchObject({ name: "Icons", opacity: 0.5 });
    expect(tree?.[0]?.children?.map((l) => l.type)).toEqual(["rect", "ellipse"]);
  });

  it("copies <use> targets where they're placed, inheriting the use's paint", () => {
    const tree = layers(
      svg(
        '<defs><rect id="r" width="10" height="10"/><symbol id="s" viewBox="0 0 1 1"><circle cx=".5" cy=".5" r=".5"/></symbol></defs><use href="#r" x="5" y="6" fill="red"/><use href="#s" x="20" width="10" height="10" fill="blue"/>',
      ),
    );
    expect(tree).toMatchObject([
      { type: "rect", props: { x: 5, y: 6, width: 10, height: 10, fills: [{ color: "#ff0000" }] } },
      {
        type: "ellipse",
        props: { x: 20, y: 0, width: 10, height: 10, fills: [{ color: "#0000ff" }] },
      },
    ]);
  });

  it("reads xlink:href even when the prefix wasn't declared", () => {
    const text =
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><defs><rect id="r" width="1" height="1"/></defs><use xlink:href="#r"/></svg>';
    expect(layers(text)).toHaveLength(1);
  });

  it("stops at a <use> that refers to itself", () => {
    expect(layers(svg('<g id="a"><use href="#a"/></g><use id="b" href="#b"/>'))).toEqual([]);
  });

  it("places nested <svg> viewports", () => {
    const circle = only(
      svg(
        '<svg x="10" y="10" width="20" height="20" viewBox="0 0 2 2"><circle cx="1" cy="1" r="1"/></svg>',
      ),
    );
    expect(circle.props).toMatchObject({ x: 10, y: 10, width: 20, height: 20 });
  });
});

describe("clips and masks", () => {
  it("makes a clip path the mask in a group", () => {
    const tree = svgToLayers(
      svg(
        '<defs><clipPath id="c"><circle cx="5" cy="5" r="5"/></clipPath></defs><rect width="20" height="20" clip-path="url(#c)"/>',
      ),
    ).root.children;
    expect(tree).toMatchObject([
      {
        type: "group",
        props: { name: "Clip group" },
        children: [
          { type: "ellipse", props: { isMask: true, x: 0, y: 0, width: 10, height: 10 } },
          { type: "rect" },
        ],
      },
    ]);
  });

  it("drops a clip to the whole frame, as Figma's exports have", () => {
    const tree = svgToLayers(
      svg(
        '<g clip-path="url(#c)"><rect width="5" height="5"/><rect x="5" width="5" height="5"/></g><defs><clipPath id="c"><rect width="100" height="100" fill="white"/></clipPath></defs>',
      ),
    ).root.children;
    expect(tree?.map((l) => l.type)).toEqual(["rect", "rect"]);
  });

  it("joins a clip of several shapes into one outline, in bounding-box units", () => {
    const tree = svgToLayers(
      svg(
        '<defs><clipPath id="c" clipPathUnits="objectBoundingBox"><rect width=".5" height="1"/><rect x=".5" y=".5" width=".5" height=".5"/></clipPath></defs><g clip-path="url(#c)"><rect x="10" y="10" width="40" height="40"/></g>',
      ),
    ).root.children;
    const mask = tree?.[0]?.children?.[0];
    expect(mask).toMatchObject({
      type: "path",
      props: { isMask: true, x: 10, y: 10, width: 40, height: 40 },
    });
  });

  it("makes a white mask an outline mask, and a grey one a luminance mask", () => {
    const white = svgToLayers(
      svg(
        '<mask id="m"><rect width="10" height="10" fill="white"/></mask><rect width="20" height="20" mask="url(#m)"/>',
      ),
    ).root.children?.[0];
    expect(white?.props.name).toBe("Mask group");
    expect(white?.children?.[0]?.props).toMatchObject({ isMask: true });
    expect(white?.children?.[0]?.props.maskType).toBeUndefined();
    const grey = svgToLayers(
      svg(
        '<mask id="m"><rect width="10" height="10" fill="#888"/></mask><rect width="20" height="20" mask="url(#m)"/>',
      ),
    ).root.children?.[0];
    expect(grey?.children?.[0]?.props).toMatchObject({ isMask: true, maskType: "luminance" });
    const alpha = svgToLayers(
      svg(
        '<mask id="m" style="mask-type:alpha"><rect width="10" height="10" fill="#888"/></mask><rect width="20" height="20" mask="url(#m)"/>',
      ),
    ).root.children?.[0];
    expect(alpha?.children?.[0]?.props.maskType).toBeUndefined();
  });
});

describe("filters", () => {
  it("reads feDropShadow and a lone blur", () => {
    const group = svgToLayers(
      svg(
        '<filter id="f"><feDropShadow dx="2" dy="3" stdDeviation="4" flood-color="#000" flood-opacity=".5"/></filter><filter id="b"><feGaussianBlur stdDeviation="3"/></filter><g id="g" filter="url(#b)"><rect width="10" height="10" filter="url(#f)"/></g>',
      ),
    ).root.children?.[0];
    expect(group?.props.effects).toEqual([{ type: "layer-blur", radius: 6 }]);
    expect(group?.children?.[0]?.props.effects).toEqual([
      { type: "drop-shadow", color: "#00000080", x: 2, y: 3, blur: 8, spread: 0 },
    ]);
  });

  it("reads Figma's drop and inner shadow chains", () => {
    const r = svgToLayers(fixture("figma-card.svg"));
    const card = r.root.children?.[0];
    expect(card?.type).toBe("rect");
    expect(card?.props.effects).toEqual([
      { type: "drop-shadow", color: "#10132340", x: 0, y: 4, blur: 8, spread: 0 },
    ]);
    const inner = svgToLayers(
      svg(
        '<filter id="f"><feFlood flood-opacity="0" result="BackgroundImageFix"/><feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape"/><feColorMatrix in="SourceAlpha" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" result="hardAlpha"/><feMorphology radius="2" operator="erode" in="SourceAlpha"/><feOffset dx="1" dy="2"/><feGaussianBlur stdDeviation="1.5"/><feComposite in2="hardAlpha" operator="arithmetic" k2="-1" k3="1"/><feColorMatrix type="matrix" values="0 0 0 0 1 0 0 0 0 0 0 0 0 0 0 0 0 0 0.5 0"/><feBlend in2="shape"/></filter><rect width="10" height="10" filter="url(#f)"/>',
      ),
    ).root.children?.[0];
    expect(inner?.props.effects).toEqual([
      { type: "inner-shadow", color: "#ff000080", x: 1, y: 2, blur: 3, spread: -2 },
    ]);
  });

  it("leaves out filters it can't draw, and says so", () => {
    const r = svgToLayers(
      svg(
        '<filter id="f"><feTurbulence baseFrequency=".1"/></filter><rect width="1" height="1" filter="url(#f)"/>',
      ),
    );
    expect(r.root.children?.[0]?.props.effects).toBeUndefined();
    expect(r.notes.lines()).toEqual(["1 filter effect was left out"]);
  });
});

describe("text", () => {
  it("makes text layers from <text>, with the font and paint", () => {
    const text = only(
      svg(
        '<text x="10" y="40" font-family="\'Inter\', sans-serif" font-size="20" font-weight="bold" fill="#c00">Hello <tspan>world</tspan></text>',
      ),
    );
    expect(text.type).toBe("text");
    expect(text.props).toMatchObject({
      characters: "Hello world",
      fontFamily: "Inter",
      fontWeight: 700,
      fontSize: 20,
      fills: [{ type: "solid", color: "#cc0000" }],
      textAutoResize: "width",
      x: 10,
    });
    // The baseline at 40: the box starts about an ascent above.
    expect(text.props.y).toBeLessThan(40);
  });

  it("centres anchored text on its anchor, and breaks lines at positioned tspans", () => {
    const text = only(
      svg(
        '<text x="50" y="20" text-anchor="middle"><tspan x="50" y="20">One</tspan><tspan x="50" y="40">Two</tspan></text>',
      ),
    );
    expect(text.props).toMatchObject({
      characters: "One\nTwo",
      textAlign: "center",
      textAutoResize: "height",
    });
    expect((text.props.x ?? 0) + (text.props.width ?? 0) / 2).toBeCloseTo(50, 3);
  });
});

describe("what's left out", () => {
  it("notes embedded images, HTML and markers, and runs nothing", () => {
    const r = svgToLayers(
      svg(
        '<script>window.hacked = true</script><image href="https://example.com/x.png" width="10" height="10"/><foreignObject width="10" height="10"><div xmlns="http://www.w3.org/1999/xhtml">Hi</div></foreignObject><marker id="m"><path d="M0 0L1 1"/></marker><path d="M0 0L10 10" stroke="#000" marker-end="url(#m)" onclick="alert(1)"/>',
      ),
    );
    expect(r.notes.lines()).toEqual([
      "1 embedded image was left out",
      "1 block of HTML was left out",
      "1 line-end marker was left out",
    ]);
    expect((globalThis as { hacked?: boolean }).hacked).toBeUndefined();
    const path = r.root.children?.[0];
    expect(Object.keys(path?.props ?? {})).not.toContain("onclick");
  });

  it("ignores references to other files", () => {
    expect(
      layers(
        svg('<use href="other.svg#icon"/><rect width="1" height="1" fill="url(other.svg#g)"/>'),
      ),
    ).toMatchObject([{ type: "rect", props: { fills: [] } }]);
  });
});

describe("the corpus", () => {
  for (const name of [
    "icon-stroke.svg",
    "figma-card.svg",
    "illustrator-badge.svg",
    "logo-evenodd.svg",
    "flag-use.svg",
    "units-dashes.svg",
  ])
    it(`${name} converts to valid layers`, () => {
      const r = svgToLayers(fixture(name));
      expectValid(r.root);
      expect(r.root.children?.length).toBeGreaterThan(0);
    });

  it("reads the Illustrator export's classes and transforms", () => {
    const r = svgToLayers(fixture("illustrator-badge.svg"));
    expect(r.root.props).toMatchObject({ name: "Layer 1", width: 100, height: 100 });
    const badge = r.root.children?.[0];
    expect(badge?.props.name).toBe("badge");
    expect(badge?.children?.map((l) => l.type)).toEqual([
      "path",
      "ellipse",
      "rect",
      "ellipse",
      "path",
    ]);
    const [star, ring, diamond, ellipse, smile] = badge?.children ?? [];
    expect(star?.props.fills).toEqual([{ type: "solid", color: "#1d3557" }]);
    expect(ring?.props).toMatchObject({
      fills: [],
      strokeWeight: 3,
      strokes: [{ color: "#f1faee" }],
    });
    expect(diamond?.props).toMatchObject({ rotation: 45, width: 24, height: 24 });
    expect(ellipse?.props.opacity).toBe(0.8);
    expect(ellipse?.props.rotation).toBeCloseTo(30, 2);
    expect(smile?.props.strokes).toEqual([{ type: "solid", color: "#ffb703" }]);
  });

  it("copies the flag's stars from one definition", () => {
    const r = svgToLayers(fixture("flag-use.svg"));
    const paths = layers(fixture("flag-use.svg")).filter((l) => l.type === "path");
    expect(paths).toHaveLength(9);
    expect(r.root.props).toMatchObject({ width: 90, height: 60 });
  });
});
