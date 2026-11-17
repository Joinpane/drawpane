import { DEFAULT_GLASS, type Op, ROOT_ID } from "@drawpane/model";
import { describe, expect, it } from "vitest";
import { Editor } from "../src/editor";
import {
  exportBounds,
  exportFileName,
  fitScale,
  imageRefs,
  outputSize,
  snapToPixels,
} from "../src/export";
import { exportSvg, formatSvg } from "../src/svg";
import type { TextMeasurer } from "../src/text";

/** Every character is half the font size wide; deterministic in Node. */
const measurer: TextMeasurer = {
  width: (font, text) => {
    const size = Number(font.match(/(\d+(?:\.\d+)?)px/)?.[1] ?? 16);
    return text.length * size * 0.5;
  },
};

const SHA = "a".repeat(64);
const SHA2 = "b".repeat(64);

function makeEditor(ops: Op[] = []) {
  const editor = new Editor({ measurer, clientId: "test" });
  editor.state.set({ role: "editor" });
  editor.doc.apply([
    { op: "create", id: "p", type: "page", parent: ROOT_ID, key: "a0", props: { name: "Page 1" } },
    ...ops,
  ]);
  editor.setPage("p");
  return editor;
}

const rect = (id: string, props: Record<string, unknown>, parent = "p", key = "a0"): Op => ({
  op: "create",
  id,
  type: "rect",
  parent,
  key,
  props: { x: 10, y: 20, width: 100, height: 50, ...props },
});

describe("exportBounds", () => {
  it("is the layer's box when nothing paints outside it", () => {
    const editor = makeEditor([rect("r", { strokes: [{ type: "solid", color: "#000000" }] })]);
    // Inside strokes (the default) stay inside.
    expect(exportBounds(editor.scene, ["r"])).toEqual({ x: 10, y: 20, width: 100, height: 50 });
  });

  it("grows for outside and centred strokes, shadows and blur", () => {
    const editor = makeEditor([
      rect("outside", {
        strokes: [{ type: "solid", color: "#000000" }],
        strokeWeight: 4,
        strokeAlign: "outside",
      }),
      rect(
        "shadow",
        {
          x: 0,
          y: 0,
          effects: [{ type: "drop-shadow", color: "#00000040", x: 0, y: 4, blur: 8, spread: 2 }],
        },
        "p",
        "a1",
      ),
      rect("blurred", { x: 0, y: 0, effects: [{ type: "layer-blur", radius: 5 }] }, "p", "a2"),
    ]);
    expect(exportBounds(editor.scene, ["outside"])).toEqual({
      x: 6,
      y: 16,
      width: 108,
      height: 58,
    });
    // Shadow reach is blur + spread around the offset copy: 10 left/right, 6 above, 14 below.
    expect(exportBounds(editor.scene, ["shadow"])).toEqual({
      x: -10,
      y: -6,
      width: 120,
      height: 70,
    });
    expect(exportBounds(editor.scene, ["blurred"])).toEqual({
      x: -10,
      y: -10,
      width: 120,
      height: 70,
    });
  });

  it("unions several layers and follows children out of unclipped frames", () => {
    const editor = makeEditor([
      {
        op: "create",
        id: "f",
        type: "frame",
        parent: "p",
        key: "a0",
        props: { x: 0, y: 0, width: 100, height: 100, clipContent: false },
      },
      rect("child", { x: 80, y: 80, width: 50, height: 50 }, "f"),
      rect("other", { x: 300, y: 0, width: 10, height: 10 }, "p", "a1"),
    ]);
    expect(exportBounds(editor.scene, ["f"])).toEqual({ x: 0, y: 0, width: 130, height: 130 });
    editor.setProp(["f"], "clipContent", null);
    expect(exportBounds(editor.scene, ["f"])).toEqual({ x: 0, y: 0, width: 100, height: 100 });
    expect(exportBounds(editor.scene, ["f", "other"])).toEqual({
      x: 0,
      y: 0,
      width: 310,
      height: 100,
    });
  });

  it("skips hidden layers", () => {
    const editor = makeEditor([rect("r", { visible: false })]);
    expect(exportBounds(editor.scene, ["r"])).toBeNull();
  });
});

describe("export sizing", () => {
  it("snaps outwards to whole output pixels", () => {
    expect(snapToPixels({ x: 0.3, y: 1.6, width: 10.2, height: 2 }, 1)).toEqual({
      x: 0,
      y: 1,
      width: 11,
      height: 3,
    });
    expect(snapToPixels({ x: 0.3, y: 0, width: 10, height: 10 }, 2)).toEqual({
      x: 0,
      y: 0,
      width: 10.5,
      height: 10,
    });
    expect(outputSize({ x: 0, y: 0, width: 10.5, height: 10 }, 2)).toEqual({
      width: 21,
      height: 20,
    });
  });

  it("refuses outputs browsers can't allocate", () => {
    expect(outputSize({ x: 0, y: 0, width: 6000, height: 10 }, 3)).toBeNull();
    expect(outputSize({ x: 0, y: 0, width: 9000, height: 9000 }, 1)).toBeNull();
  });

  it("fits thumbnails inside the box without enlarging past 2×", () => {
    expect(fitScale({ width: 1280, height: 480 }, { width: 640, height: 480 })).toBe(0.5);
    expect(fitScale({ width: 100, height: 100 }, { width: 640, height: 480 })).toBe(2);
  });

  it("names files after the layer", () => {
    expect(exportFileName("Hero card", "png")).toBe("Hero card.png");
    expect(exportFileName("Hero card", "png", 2)).toBe("Hero card@2x.png");
    expect(exportFileName("a/b: c?", "jpeg", 3)).toBe("a-b- c-@3x.jpg");
    expect(exportFileName("  ..  ", "svg", 2)).toBe("Export.svg");
  });

  it("collects image refs from a subtree", () => {
    const editor = makeEditor([
      { op: "create", id: "g", type: "group", parent: "p", key: "a0", props: {} },
      rect("a", { fills: [{ type: "image", ref: SHA, scaleMode: "fill" }] }, "g"),
      rect("b", { fills: [{ type: "image", ref: SHA2, scaleMode: "tile" }] }, "g", "a1"),
      rect("c", { fills: [{ type: "image", ref: SHA, scaleMode: "fit" }] }, "g", "a2"),
    ]);
    expect(imageRefs(editor.doc, ["g"]).sort()).toEqual([SHA, SHA2]);
  });
});

describe("Editor.insertImages", () => {
  it("places images in a row at the point, inside the frame under it", () => {
    const editor = makeEditor([
      {
        op: "create",
        id: "f",
        type: "frame",
        parent: "p",
        key: "a0",
        props: { x: 1000, y: 1000, width: 800, height: 600 },
      },
    ]);
    editor.setViewport(1600, 1000);
    const ids = editor.insertImages(
      [
        { ref: SHA, width: 200, height: 100, name: "Hero photo" },
        { ref: SHA2, width: 100, height: 100, name: "" },
      ],
      { x: 1400, y: 1300 },
    );
    expect(ids).toHaveLength(2);
    expect(editor.s.selection).toEqual(ids);
    const [a, b] = ids.map((id) => editor.doc.get(id));
    expect(a?.parent).toBe("f");
    // The row is 200 + 24 + 100 wide, centred on x 1400 (frame-local 400), tops aligned.
    expect(a?.props).toMatchObject({
      name: "Hero photo",
      x: 238,
      y: 250,
      width: 200,
      height: 100,
      fills: [{ type: "image", ref: SHA, scaleMode: "fill" }],
    });
    expect(b?.props).toMatchObject({ name: "Image", x: 462, y: 250, width: 100, height: 100 });
  });

  it("scales large images down to fit the viewport at the current zoom", () => {
    const editor = makeEditor();
    editor.setViewport(1000, 800);
    const [id] = editor.insertImages([{ ref: SHA, width: 4000, height: 2000, name: "Big" }]);
    const props = editor.doc.get(id ?? "")?.props;
    // 80% of the viewport: 800 wide.
    expect(props).toMatchObject({ width: 800, height: 400, x: 100, y: 200 });
  });
});

describe("Editor.insertLayers", () => {
  const svgFrame = {
    type: "frame" as const,
    props: { name: "globe", x: 999, y: 999, width: 2000, height: 40, fills: [] },
    children: [
      {
        type: "group" as const,
        props: { name: "Icons" },
        children: [
          { type: "ellipse" as const, props: { x: 2, y: 2, width: 20, height: 20 } },
          {
            type: "path" as const,
            props: { x: 0, y: 0, width: 10, height: 0, pathData: "M0 0 L10 0" },
          },
        ],
      },
    ],
  };

  it("places a tree whole, keeping an unscaled frame's size, beside images, in one undo step", () => {
    const editor = makeEditor();
    editor.setViewport(1000, 800);
    const before = [...editor.doc.nodes()].length;
    const ids = editor.insertLayers(
      [
        { tree: svgFrame },
        {
          fit: true,
          tree: {
            type: "rect",
            props: {
              name: "Photo",
              width: 4000,
              height: 2000,
              fills: [{ type: "image", ref: SHA, scaleMode: "fill" }],
            },
          },
        },
      ],
      { x: 0, y: 0 },
      "Place images",
    );
    expect(ids).toHaveLength(2);
    expect(editor.s.selection).toEqual(ids);
    const frame = editor.doc.get(ids[0] ?? "");
    // The SVG keeps its 2000 px; the image fits 80% of the viewport. 2000 + 24 + 800, centred on 0.
    expect(frame?.props).toMatchObject({
      name: "globe",
      width: 2000,
      height: 40,
      x: -1412,
      y: -200,
    });
    expect(editor.doc.get(ids[1] ?? "")?.props).toMatchObject({ width: 800, height: 400, x: 612 });
    const [group] = editor.doc.childIds(ids[0] ?? "");
    expect(editor.doc.get(group ?? "")?.props.name).toBe("Icons");
    const leaves = editor.doc.childIds(group ?? "").map((id) => editor.doc.get(id)?.type);
    expect(leaves).toEqual(["ellipse", "path"]);
    expect([...editor.doc.nodes()].length).toBe(before + 5);
    editor.undo();
    expect([...editor.doc.nodes()].length).toBe(before);
  });
});

describe("exportSvg", () => {
  const svgOf = (editor: Editor, ids: string[]) => {
    const bounds = exportBounds(editor.scene, ids);
    if (!bounds) throw new Error("no bounds");
    return exportSvg(editor.scene, measurer, ids, bounds);
  };

  it("writes a rect with fill, opacity and an inside stroke", () => {
    const editor = makeEditor([
      rect("r", {
        name: "Card & co",
        opacity: 0.5,
        cornerRadius: 8,
        fills: [{ type: "solid", color: "#ff5a1f80" }],
        strokes: [{ type: "solid", color: "#1c1b1a" }],
        strokeWeight: 2,
      }),
    ]);
    expect(svgOf(editor, ["r"])).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50" viewBox="10 20 100 50">' +
        '<defs><clipPath id="clip1"><rect transform="translate(10 20)" width="100" height="50" rx="8"/></clipPath></defs>' +
        '<g data-name="Card &amp; co" opacity="0.5">' +
        '<rect transform="translate(10 20)" width="100" height="50" rx="8" fill="#ff5a1f" fill-opacity="0.502"/>' +
        '<g clip-path="url(#clip1)"><rect transform="translate(10 20)" width="100" height="50" rx="8" fill="none" stroke="#1c1b1a" stroke-width="4"/></g>' +
        "</g></svg>\n",
    );
  });

  it("writes ellipses, lines, paths and rotation as a matrix", () => {
    const editor = makeEditor([
      {
        op: "create",
        id: "e",
        type: "ellipse",
        parent: "p",
        key: "a0",
        props: {
          x: 0,
          y: 0,
          width: 20,
          height: 10,
          rotation: 90,
          fills: [{ type: "solid", color: "#000000" }],
        },
      },
      {
        op: "create",
        id: "l",
        type: "line",
        parent: "p",
        key: "a1",
        props: {
          x: 0,
          y: 40,
          width: 50,
          height: 0,
          strokes: [{ type: "solid", color: "#000000" }],
          strokeCap: "round",
          strokeDashes: [4, 2],
        },
      },
      {
        op: "create",
        id: "v",
        type: "path",
        parent: "p",
        key: "a2",
        props: {
          x: 0,
          y: 60,
          width: 10,
          height: 10,
          pathData: "M0 0L10 0L10 10Z",
          windingRule: "evenodd",
          fills: [{ type: "solid", color: "#00ff00" }],
        },
      },
    ]);
    const svg = svgOf(editor, ["e", "l", "v"]);
    expect(svg).toContain(
      '<ellipse transform="matrix(0 1 -1 0 15 -5)" cx="10" cy="5" rx="10" ry="5" fill="#000000"/>',
    );
    expect(svg).toContain(
      '<line transform="translate(0 40)" x1="0" y1="0" x2="50" y2="0" fill="none" stroke="#000000" stroke-width="1" stroke-linecap="round" stroke-dasharray="4 2"/>',
    );
    expect(svg).toContain(
      '<path transform="translate(0 60)" d="M0 0L10 0L10 10Z" fill-rule="evenodd" fill="#00ff00"/>',
    );
  });

  it("puts upright lines of text on whole output pixels when asked, for rasterising", () => {
    const editor = makeEditor([
      {
        op: "create",
        id: "t",
        type: "text",
        parent: "p",
        key: "a0",
        props: { x: 0, y: 10.3, width: 100, height: 20, characters: "Hi", fontSize: 16 },
      },
    ]);
    const bounds = { x: 0, y: 0, width: 100, height: 40 };
    const y = (svg: string) => Number(/<tspan x="0" y="([\d.]+)"/.exec(svg)?.[1]);
    const exact = y(exportSvg(editor.scene, measurer, ["t"], bounds));
    const snapped = y(exportSvg(editor.scene, measurer, ["t"], bounds, { raster: 2 }));
    expect(Math.abs(snapped - exact)).toBeLessThanOrEqual(0.25);
    // On the page, the baseline lands on a half unit: a whole pixel at 2×.
    expect(((10.3 + snapped) * 2) % 1).toBeCloseTo(0, 5);
  });

  it("draws underlines as the canvas's bars when rasterising, and as text-decoration otherwise", () => {
    const editor = makeEditor([
      {
        op: "create",
        id: "t",
        type: "text",
        parent: "p",
        key: "a0",
        props: {
          width: 100,
          height: 20,
          characters: "Hi",
          fontSize: 16,
          textDecoration: "underline",
          fills: [{ type: "solid", color: "#ff0000" }],
        },
      },
    ]);
    const bounds = { x: 0, y: 0, width: 100, height: 40 };
    const plain = exportSvg(editor.scene, measurer, ["t"], bounds);
    expect(plain).toContain('text-decoration="underline"');
    expect(plain).not.toContain("<rect");
    const raster = exportSvg(editor.scene, measurer, ["t"], bounds, { raster: 2 });
    expect(raster).not.toContain("text-decoration");
    // As wide as the run, 1 unit thick (16 / 16), a tenth of an em under the baseline.
    expect(raster).toMatch(
      /<g fill="#ff0000"><rect x="0" y="[\d.]+" width="16" height="1"\/><\/g>/,
    );
  });

  it("fits a dashed box's pattern to each side and corner, as the canvas does", () => {
    const editor = makeEditor([
      rect("r", {
        x: 0,
        y: 0,
        width: 100,
        height: 40,
        cornerRadius: 10,
        strokes: [{ type: "solid", color: "#000000" }],
        strokeAlign: "center",
        strokeDashes: [6, 4],
      }),
    ]);
    const svg = svgOf(editor, ["r"]);
    // Eight pieces: four sides and four corners, each its own whole number of dashes.
    const pieces = [
      ...svg.matchAll(
        /<path d="([^"]+)" fill="none"[^>]*stroke-dasharray="([^"]+)" stroke-dashoffset="([^"]+)"/g,
      ),
    ];
    expect(pieces).toHaveLength(8);
    // The top edge, 80 long: eight of the 10-long pattern, a dash centred on each end.
    expect(pieces[0]?.slice(1)).toEqual(["M10 0L90 0", "6 4", "3"]);
    expect(pieces[1]?.[1]).toMatch(/^M90 0A10 10 0 0 1 100 10$/);
    expect(svg).not.toContain('stroke-dasharray="6 4"/>');
  });

  it("writes frames as clipped groups with children, and gradients as defs", () => {
    const editor = makeEditor([
      {
        op: "create",
        id: "f",
        type: "frame",
        parent: "p",
        key: "a0",
        props: {
          x: 100,
          y: 100,
          width: 200,
          height: 100,
          fills: [
            {
              type: "linear",
              from: { x: 0, y: 0 },
              to: { x: 1, y: 0 },
              stops: [
                { position: 0, color: "#000000" },
                { position: 1, color: "#ffffff00" },
              ],
            },
          ],
        },
      },
      rect(
        "inner",
        { x: 10, y: 10, width: 20, height: 20, fills: [{ type: "solid", color: "#123456" }] },
        "f",
      ),
    ]);
    const svg = svgOf(editor, ["f"]);
    expect(svg).toContain(
      '<linearGradient id="gradient1" gradientUnits="userSpaceOnUse" gradientTransform="matrix(200 0 0 100 0 0)" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#000000"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/></linearGradient>',
    );
    expect(svg).toContain(
      '<clipPath id="clip2"><rect transform="translate(100 100)" width="200" height="100"/></clipPath>',
    );
    // The frame's fill and its children share the clip, so children blend with the fill.
    expect(svg).toContain(
      '<g clip-path="url(#clip2)"><rect transform="translate(100 100)" width="200" height="100" fill="url(#gradient1)"/><rect transform="translate(110 110)"',
    );
    // Children are positioned in page space.
    expect(svg).toContain(
      '<rect transform="translate(110 110)" width="20" height="20" fill="#123456"/>',
    );
  });

  it("writes text as <text> with a tspan per line, escaped", () => {
    const editor = makeEditor([
      {
        op: "create",
        id: "t",
        type: "text",
        parent: "p",
        key: "a0",
        props: {
          x: 0,
          y: 0,
          width: 100,
          height: 40,
          characters: "Fish & <chips>\nNow",
          fontSize: 16,
          fontWeight: 600,
          textAlign: "center",
          fills: [{ type: "solid", color: "#1c1b1a" }],
        },
      },
    ]);
    const svg = svgOf(editor, ["t"]);
    expect(svg).toContain(
      `<text font-family="'Instrument Sans', sans-serif" font-size="16" font-weight="600" text-anchor="middle" fill="#1c1b1a" xml:space="preserve"><tspan x="50" y="14.8">Fish &amp; &lt;chips&gt;</tspan><tspan x="50" y="34.8">Now</tspan></text>`,
    );
  });

  it("keeps OpenType features as CSS, on the layer and on a range that differs", () => {
    const editor = makeEditor([
      {
        op: "create",
        id: "t",
        type: "text",
        parent: "p",
        key: "a0",
        props: {
          x: 0,
          y: 0,
          width: 100,
          height: 20,
          characters: "Total 1,010",
          fontFeatures: { tnum: true, liga: false },
          textRuns: [{ start: 6, end: 11, fontFeatures: { zero: true } }],
        },
      },
    ]);
    const svg = svgOf(editor, ["t"]);
    expect(svg).toMatch(/<text [^>]*style="font-feature-settings: 'liga' 0, 'tnum' 1"/);
    expect(svg).toContain(`<tspan style="font-feature-settings: 'zero' 1">1,010</tspan>`);
  });

  it("keeps variable axes as CSS, on the layer and on a range that differs", () => {
    const editor = makeEditor([
      {
        op: "create",
        id: "t",
        type: "text",
        parent: "p",
        key: "a0",
        props: {
          x: 0,
          y: 0,
          width: 100,
          height: 20,
          characters: "Wide narrow",
          fontVariations: { wdth: 125, GRAD: -50 },
          textRuns: [
            { start: 5, end: 11, fontVariations: { wdth: 75 } },
            { start: 0, end: 4, fontFeatures: { ss01: true } },
          ],
        },
      },
    ]);
    const svg = svgOf(editor, ["t"]);
    expect(svg).toMatch(/<text [^>]*style="font-variation-settings: 'GRAD' -50, 'wdth' 125"/);
    expect(svg).toContain(`<tspan style="font-variation-settings: 'wdth' 75">narrow</tspan>`);
    // A run that only changes features leaves the axes to the layer.
    expect(svg).toContain(`<tspan style="font-feature-settings: 'ss01' 1">Wide</tspan>`);
  });

  it("draws runs with features as glyph outlines when asked (for PDF), keeping their room", () => {
    // A shaper's measurer: every glyph a 10-unit square, 600 units wide, 1000 per em.
    const shaping: TextMeasurer = {
      // Shaped runs measure by their glyphs, as ShapingMeasurer does.
      width: (font, text, run) => (run ? text.length * run.size * 0.6 : measurer.width(font, text)),
      shape: (text, run) => ({
        glyphs: [...text].map((_, i) => ({
          path: null,
          d: "M0,0L10,0L10,10Z",
          x: i * run.size * 0.6,
          y: 0,
          cluster: i,
        })),
        width: text.length * run.size * 0.6,
        scale: run.size / 1000,
      }),
    };
    const editor = makeEditor([
      {
        op: "create",
        id: "t",
        type: "text",
        parent: "p",
        key: "a0",
        props: {
          x: 0,
          y: 0,
          width: 100,
          height: 20,
          characters: "12 ab",
          fontSize: 10,
          textRuns: [{ start: 0, end: 2, fontFeatures: { tnum: true } }],
          fills: [{ type: "solid", color: "#1c1b1a" }],
        },
      },
    ]);
    const bounds = exportBounds(editor.scene, ["t"]);
    if (!bounds) throw new Error("no bounds");
    const pdfSvg = exportSvg(editor.scene, shaping, ["t"], bounds, { outlineFeatures: true });
    // The rest of the line stays text, placed where the layout put it (after the shaped run).
    expect(pdfSvg).toContain(`<tspan x="12" y="9.25" text-anchor="start"> ab</tspan>`);
    expect(pdfSvg).not.toContain(">12</tspan>");
    expect(pdfSvg).toContain(
      `<g fill="#1c1b1a"><path transform="matrix(0.01 0 0 -0.01 0 9.25)" d="M0,0L10,0L10,10Z"/><path transform="matrix(0.01 0 0 -0.01 6 9.25)" d="M0,0L10,0L10,10Z"/></g>`,
    );
    // Without the option, features stay CSS.
    const plain = exportSvg(editor.scene, shaping, ["t"], bounds);
    expect(plain).not.toContain("<path");
    expect(plain).toContain("font-feature-settings: 'tnum' 1");
  });

  it("gives glass its lit rim, under the fills (SVG can't see the backdrop)", () => {
    const editor = makeEditor([
      {
        op: "create",
        id: "g",
        type: "rect",
        parent: "p",
        key: "a0",
        props: {
          x: 0,
          y: 0,
          width: 100,
          height: 60,
          cornerRadius: 16,
          fills: [{ type: "solid", color: "#ffffff33" }],
          effects: [{ ...DEFAULT_GLASS, angle: 0 }],
        },
      },
    ]);
    const svg = svgOf(editor, ["g"]);
    // Lit from the top: the gradient runs top to bottom, white fading out.
    expect(svg).toMatch(
      /<linearGradient id="light\d+" x1="0.5" y1="0" x2="0.5" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="0.56"\/>/,
    );
    const rim = svg.indexOf('stroke="url(#light');
    const fill = svg.indexOf('fill="#ffffff"');
    expect(rim).toBeGreaterThan(-1);
    expect(rim).toBeLessThan(fill);
  });

  it("strokes text around its glyphs: centred, or inside or outside them", () => {
    const textWith = (strokeAlign: "center" | "inside" | "outside") =>
      makeEditor([
        {
          op: "create",
          id: "t",
          type: "text",
          parent: "p",
          key: "a0",
          props: {
            x: 0,
            y: 0,
            width: 100,
            height: 20,
            characters: "Menubar",
            strokes: [{ type: "solid", color: "#ff0000" }],
            strokeWeight: 1,
            strokeAlign,
          },
        },
      ]);
    const svg = (align: "center" | "inside" | "outside") => {
      const editor = textWith(align);
      return svgOf(editor, ["t"]);
    };
    // Centred: the text itself, stroked and unfilled.
    expect(svg("center")).toMatch(
      /<text [^>]*fill="none" stroke="#ff0000" stroke-width="1"[^>]*><tspan[^>]*>Menubar<\/tspan><\/text>/,
    );
    // Inside: twice as wide, clipped to the glyphs.
    const inside = svg("inside");
    expect(inside).toMatch(
      /<clipPath id="(clip\d+)"><text [^>]*><tspan[^>]*>Menubar<\/tspan><\/text><\/clipPath>/,
    );
    expect(inside).toMatch(/<g clip-path="url\(#clip\d+\)"><text [^>]*stroke-width="2"/);
    // Outside: twice as wide, with the glyphs masked out.
    const outside = svg("outside");
    expect(outside).toMatch(/<mask [^>]*><rect [^>]*fill="#fff"\/><text [^>]*fill="#000"/);
    expect(outside).toMatch(/<g mask="url\(#mask\d+\)"><text [^>]*stroke-width="2"/);
    // Never the text's box.
    expect(svg("center")).not.toContain("<rect");
  });

  it("casts drop shadows from the shape grown by its spread, and inner shadows inside it", () => {
    const editor = makeEditor([
      rect("r", {
        cornerRadius: 8,
        fills: [{ type: "solid", color: "#ffffff" }],
        effects: [
          { type: "drop-shadow", color: "#00000040", x: 0, y: 4, blur: 12, spread: 2 },
          { type: "inner-shadow", color: "#ff000080", x: 2, y: 2, blur: 4, spread: 0 },
          { type: "drop-shadow", color: "#000000", x: 9, y: 9, blur: 0, spread: 0, visible: false },
        ],
      }),
    ]);
    const svg = svgOf(editor, ["r"]);
    // A canvas shadow's blur is twice the Gaussian's deviation; the region covers its reach.
    expect(svg).toContain(
      '<filter id="shadow1" filterUnits="userSpaceOnUse" x="-15" y="-5" width="150" height="100" color-interpolation-filters="sRGB"><feOffset dx="0" dy="4" result="moved"/><feGaussianBlur in="moved" stdDeviation="6" result="soft"/></filter>',
    );
    // Spread grows the box and its corners alike, under the fill.
    expect(svg).toContain(
      '<g filter="url(#shadow1)"><path transform="translate(10 20)" d="M8 -2H92A10 10 0 0 1 102 8V42A10 10 0 0 1 92 52H8A10 10 0 0 1 -2 42V8A10 10 0 0 1 8 -2Z" fill="#000000" fill-opacity="0.251"/></g><rect transform="translate(10 20)" width="100" height="50" rx="8" fill="#ffffff"/>',
    );
    // The inner shadow: a ring outside the shape, offset and blurred, clipped to the shape, over the fill.
    expect(svg).toMatch(
      /fill="#ffffff"\/><g clip-path="url\(#clip2\)"><g filter="url\(#shadow4\)"><rect x="-1" y="9" width="122" height="72" fill="#ff0000" fill-opacity="0.502" mask="url\(#ring3\)"\/><\/g><\/g>/,
    );
    // Hidden effects stay out.
    expect(svg.match(/<filter /g)).toHaveLength(2);
  });

  it("cuts a drop shadow out under the layer when it isn't shown behind it", () => {
    const editor = makeEditor([
      rect("ring", {
        cornerRadius: 6,
        fills: [{ type: "solid", color: "#ffffff80" }],
        effects: [
          {
            type: "drop-shadow",
            color: "#ff000080",
            x: 0,
            y: 0,
            blur: 0,
            spread: 3,
            behind: false,
          },
        ],
      }),
      rect("glow", {
        fills: [{ type: "solid", color: "#ffffff80" }],
        effects: [{ type: "drop-shadow", color: "#ff000080", x: 0, y: 0, blur: 0, spread: 3 }],
      }),
      rect("field", {
        fills: [{ type: "solid", color: "#ffffff00" }],
        effects: [{ type: "drop-shadow", color: "#ff000080", x: 0, y: 0, blur: 0, spread: 3 }],
      }),
    ]);
    // Masked out where the layer is: white everywhere, black inside its own shape.
    expect(svgOf(editor, ["ring"])).toMatch(
      /<mask id="cut\d+" maskUnits="userSpaceOnUse"[^>]*><rect [^>]*fill="#fff"\/><rect transform="translate\(10 20\)" width="100" height="50" rx="6" fill="#000"\/><\/mask>/,
    );
    expect(svgOf(editor, ["ring"])).toMatch(
      /<g mask="url\(#cut\d+\)"><g filter="url\(#shadow\d+\)">/,
    );
    // Nothing it fills is visible: cut out too, as Figma draws a ring around a see-through field.
    expect(svgOf(editor, ["field"])).toMatch(/<g mask="url\(#cut\d+\)">/);
    // A partly see-through fill shows the shadow through it, unless asked not to.
    expect(svgOf(editor, ["glow"])).not.toContain("<mask");
  });

  it("masks an outside stroke where the layer is on the page, not at the origin", () => {
    const editor = makeEditor([
      rect("r", {
        x: 300,
        y: 200,
        strokes: [{ type: "solid", color: "#000000" }],
        strokeWeight: 4,
        strokeAlign: "outside",
      }),
    ]);
    const svg = svgOf(editor, ["r"]);
    // The mask's region is in page space: it covers the layer at 300, 200, stroke included.
    const mask =
      /<mask id="mask\d+" maskUnits="userSpaceOnUse" x="([-\d.]+)" y="([-\d.]+)" width="([\d.]+)" height="([\d.]+)">/.exec(
        svg,
      );
    expect(mask).not.toBeNull();
    const [x, y, width, height] = (mask as RegExpExecArray).slice(1).map(Number) as [
      number,
      number,
      number,
      number,
    ];
    expect(x).toBeLessThanOrEqual(300 - 4);
    expect(y).toBeLessThanOrEqual(200 - 4);
    expect(x + width).toBeGreaterThanOrEqual(400 + 4);
    expect(y + height).toBeGreaterThanOrEqual(250 + 4);
  });

  it("blurs a whole layer, as the canvas and Figma do: shadows, fills, children and strokes", () => {
    const editor = makeEditor([
      {
        op: "create",
        id: "f",
        type: "frame",
        parent: "p",
        key: "a0",
        props: {
          x: 0,
          y: 0,
          width: 200,
          height: 100,
          fills: [{ type: "solid", color: "#eeeeee" }],
          strokes: [{ type: "solid", color: "#000000" }],
          strokeWeight: 8,
          strokeAlign: "outside",
          effects: [
            { type: "layer-blur", radius: 4 },
            { type: "drop-shadow", color: "#00000080", x: 0, y: 20, blur: 0, spread: 0 },
          ],
        },
      },
      rect(
        "c",
        { x: 10, y: 10, width: 20, height: 20, fills: [{ type: "solid", color: "#2b4fd6" }] },
        "f",
      ),
    ]);
    const svg = svgOf(editor, ["f"]);
    const filter =
      /<filter id="(post\d+)" filterUnits="userSpaceOnUse" x="([-\d.]+)" y="([-\d.]+)" width="([\d.]+)" height="([\d.]+)"/.exec(
        svg,
      );
    expect(filter).not.toBeNull();
    const [, id, x, y, width, height] = filter as RegExpExecArray;
    // One blurred group holds all of it.
    const group = new RegExp(`<g filter="url\\(#${id}\\)">(.*)</g>`).exec(svg)?.[1] ?? "";
    expect(group).toContain("shadow");
    expect(group).toContain('fill="#eeeeee"');
    expect(group).toContain('fill="#2b4fd6"');
    expect(group).toContain('stroke="#000000"');
    // Over everything it paints: the outside stroke (8), the shadow 20 below, and 3 radii of blur.
    expect(Number(x)).toBeLessThanOrEqual(-8 - 12);
    expect(Number(y)).toBeLessThanOrEqual(-8 - 12);
    expect(Number(x) + Number(width)).toBeGreaterThanOrEqual(208 + 12);
    expect(Number(y) + Number(height)).toBeGreaterThanOrEqual(120 + 12);
  });

  it("casts a rotated layer's shadow in page space, as the canvas does", () => {
    const editor = makeEditor([
      rect("r", {
        rotation: 90,
        fills: [{ type: "solid", color: "#2b4fd6" }],
        effects: [{ type: "drop-shadow", color: "#000000", x: 0, y: 12, blur: 0, spread: 0 }],
      }),
    ]);
    const svg = svgOf(editor, ["r"]);
    // The offset is on a group in page space, outside the shape's own rotation.
    expect(svg).toMatch(/<feOffset dx="0" dy="12" result="moved"\/>/);
    expect(svg).toMatch(/<g filter="url\(#shadow1\)"><rect transform="matrix\(/);
  });

  it("formats for reading without changing a thing", () => {
    const editor = makeEditor([
      rect("r", {
        name: "Card",
        opacity: 0.5,
        fills: [{ type: "solid", color: "#ffffff" }],
        effects: [{ type: "drop-shadow", color: "#00000040", x: 0, y: 4, blur: 12, spread: 0 }],
      }),
      {
        op: "create",
        id: "t",
        type: "text",
        parent: "p",
        key: "a1",
        props: { x: 0, y: 100, width: 40, height: 40, characters: "One two three" },
      },
    ]);
    const svg = svgOf(editor, ["r", "t"]);
    const pretty = formatSvg(svg);
    expect(pretty.replace(/>\s+</g, "><").trim()).toBe(svg.trim());
    expect(pretty.split("\n")[1]).toBe("  <defs>");
    // Text stays on one line: its whitespace is significant.
    expect(pretty).toMatch(/\n {2}<text [^\n]*<\/text>\n/);

    // Narrow: a long tag's attributes go one per line, and still read back the same.
    const narrow = formatSvg(svg, { width: 40 });
    expect(
      narrow
        .replace(/\n\s+(?=[\w:-]+=)/g, " ")
        .replace(/>\s+</g, "><")
        .trim(),
    ).toBe(svg.trim());
    expect(narrow.split("\n").slice(0, 3)).toEqual([
      "<svg",
      '  xmlns="http://www.w3.org/2000/svg"',
      expect.stringMatching(/^ {2}width="\d+"$/),
    ]);
    expect(narrow).toMatch(/\n +fill-opacity="0\.251"\/>\n/);
  });

  it("leaves out image fills and hidden layers", () => {
    const editor = makeEditor([
      rect("img", { fills: [{ type: "image", ref: SHA, scaleMode: "fill" }] }),
      rect("hidden", { visible: false, fills: [{ type: "solid", color: "#000000" }] }, "p", "a1"),
    ]);
    const svg = exportSvg(editor.scene, measurer, ["img", "hidden"], {
      x: 0,
      y: 0,
      width: 10,
      height: 10,
    });
    expect(svg).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 10 10"></svg>\n',
    );
  });
});
