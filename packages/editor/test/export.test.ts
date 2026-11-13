import { type Op, ROOT_ID } from "@drawpane/model";
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
import { exportSvg } from "../src/svg";
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
      '<linearGradient id="gradient1" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="200" y2="0"><stop offset="0" stop-color="#000000"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/></linearGradient>',
    );
    expect(svg).toContain(
      '<clipPath id="clip2"><rect transform="translate(100 100)" width="200" height="100"/></clipPath>',
    );
    expect(svg).toContain('<g clip-path="url(#clip2)"><rect transform="translate(110 110)"');
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
