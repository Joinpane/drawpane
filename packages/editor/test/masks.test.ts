import { getProp, type Op, type Props, ROOT_ID } from "@drawpane/model";
import { describe, expect, it } from "vitest";
import { Editor } from "../src/editor";
import { hitTest } from "../src/hit";
import { maskScopes } from "../src/masks";
import { exportSvg } from "../src/svg";

type Spec = Props & {
  id: string;
  type?: "rect" | "ellipse" | "group" | "text" | "frame" | "line";
  parent?: string;
};

function setup(nodes: Spec[]) {
  const editor = new Editor({ measurer: { width: (_f, t) => t.length * 8 }, clientId: "t" });
  editor.state.set({ role: "editor" });
  const ops: Op[] = [
    { op: "create", id: "p", type: "page", parent: ROOT_ID, key: "a0", props: {} },
  ];
  nodes.forEach(({ id, type, parent, ...props }, i) => {
    ops.push({
      op: "create",
      id,
      type: type ?? "rect",
      parent: parent ?? "p",
      key: `a${i}`,
      props,
    });
  });
  editor.doc.apply(ops);
  editor.setPage("p");
  return editor;
}

// A circle mask at the bottom of a group, with a big card above it.
const avatar = (): Spec[] => [
  { id: "g", type: "group" },
  { id: "circle", type: "ellipse", parent: "g", x: 0, y: 0, width: 100, height: 100, isMask: true },
  {
    id: "card",
    parent: "g",
    x: -50,
    y: -50,
    width: 300,
    height: 300,
    fills: [{ type: "solid", color: "#2b4fd6" }],
  },
  { id: "badge", parent: "g", x: 80, y: 80, width: 10, height: 10 },
];

/**
 * A popover as a large iOS UI kit draws one, in a frame that doesn't clip: an arrow below the
 * card (mirrored, masking by its alpha), the material masked to it (a group, wider than the
 * arrow), the card's background (a frame, clipping its content), a badge, then another mask.
 */
const popover = (): Spec[] => [
  { id: "pop", type: "frame", width: 200, height: 200, clipContent: false },
  {
    id: "arrow",
    parent: "pop",
    x: 72,
    y: 200,
    width: 56,
    height: 13,
    flipX: true,
    isMask: true,
    maskType: "alpha",
    fills: [{ type: "solid", color: "#ff0000" }],
  },
  { id: "material", type: "group", parent: "pop" },
  {
    id: "material-fill",
    parent: "material",
    x: 40,
    y: 200,
    width: 120,
    height: 13,
    fills: [{ type: "solid", color: "#2b4fd6" }],
  },
  {
    id: "background",
    type: "frame",
    parent: "pop",
    width: 200,
    height: 200,
    fills: [{ type: "solid", color: "#00ff00" }],
  },
  { id: "badge", parent: "pop", x: 10, y: 10, width: 10, height: 10 },
  { id: "m2", parent: "pop", x: 0, y: 0, width: 5, height: 5, isMask: true },
  { id: "after", parent: "pop", x: 0, y: 0, width: 50, height: 50 },
];

/** What's inside the first `<g mask=…>` of an SVG, to its matching `</g>`. */
function maskedGroup(svg: string): string {
  const start = svg.indexOf("<g mask=");
  if (start < 0) return "";
  const tags = /<g[\s>]|<\/g>/g;
  tags.lastIndex = start;
  let depth = 0;
  for (let m = tags.exec(svg); m; m = tags.exec(svg)) {
    depth += m[0] === "</g>" ? -1 : 1;
    if (depth === 0) return svg.slice(start, m.index);
  }
  return svg.slice(start);
}

describe("masks", () => {
  it("clip the layers above them, up to the next mask", () => {
    const editor = setup([
      { id: "g", type: "group" },
      { id: "below", parent: "g", width: 10, height: 10 },
      { id: "m1", parent: "g", width: 10, height: 10, isMask: true },
      { id: "a", parent: "g", width: 10, height: 10 },
      { id: "m2", parent: "g", width: 10, height: 10, isMask: true, visible: false },
      { id: "b", parent: "g", width: 10, height: 10 },
    ]);
    const scopes = maskScopes(editor.doc, "g").map((s) => [s.id, s.isMask, s.mask?.id ?? null]);
    // A hidden mask doesn't mask: "b" stays clipped by m1.
    expect(scopes).toEqual([
      ["below", false, null],
      ["m1", true, null],
      ["a", false, "m1"],
      ["m2", false, "m1"],
      ["b", false, "m1"],
    ]);
  });

  it("end at a frame that clips its content, as Figma's do", () => {
    // Figma's help: "The mask applies to all siblings above it until it reaches … a frame or
    // component with clip content on". A popover: its arrow masks the material over it, not the
    // clipping background above that, nor what's above the background.
    const editor = setup(popover());
    const scopes = maskScopes(editor.doc, "pop").map((s) => [s.id, s.isMask, s.mask?.id ?? null]);
    expect(scopes).toEqual([
      ["arrow", true, null],
      ["material", false, "arrow"],
      ["background", false, null],
      ["badge", false, null],
      ["m2", true, null],
      ["after", false, "m2"],
    ]);
  });

  it("go on past a frame that doesn't clip, and past a hidden one that does", () => {
    const editor = setup([
      { id: "g", type: "group" },
      { id: "m", parent: "g", width: 10, height: 10, isMask: true },
      { id: "open", type: "frame", parent: "g", width: 10, height: 10, clipContent: false },
      { id: "hidden", type: "frame", parent: "g", width: 10, height: 10, visible: false },
      { id: "top", parent: "g", width: 10, height: 10 },
    ]);
    expect(maskScopes(editor.doc, "g").map((s) => s.mask?.id ?? null)).toEqual([
      null,
      "m",
      "m",
      "m",
    ]);
  });

  it("can be any layer, as in Figma: a group, a text, a line", () => {
    const editor = setup([
      { id: "f", type: "frame", width: 100, height: 100 },
      { id: "g", type: "group", parent: "f", isMask: true, maskType: "luminance" },
      { id: "dot", type: "ellipse", parent: "g", width: 10, height: 10 },
      { id: "a", parent: "f", width: 10, height: 10 },
      { id: "t", type: "text", parent: "f", characters: "Hi", isMask: true },
      { id: "b", parent: "f", width: 10, height: 10 },
      { id: "l", type: "line", parent: "f", width: 10, height: 0, isMask: true },
      { id: "c", parent: "f", width: 10, height: 10 },
    ]);
    expect(maskScopes(editor.doc, "f").map((s) => [s.id, s.isMask, s.mask?.id ?? null])).toEqual([
      ["g", true, null],
      ["a", false, "g"],
      ["t", true, null],
      ["b", false, "t"],
      ["l", true, null],
      ["c", false, "l"],
    ]);
  });

  it("let clicks reach a clipping frame above their scope anywhere on it", () => {
    const editor = setup(popover());
    expect(hitTest(editor.scene, "p", { x: 100, y: 100 }, 0)).toBe("background");
    // On the material inside the arrow: the material; beside the arrow: the background.
    expect(hitTest(editor.scene, "p", { x: 100, y: 206 }, 0)).toBe("material-fill");
    expect(hitTest(editor.scene, "p", { x: 60, y: 206 }, 0)).toBeNull();
  });

  it("leave a group as big as the clipping frame above their scope", () => {
    const editor = setup([
      { id: "g", type: "group" },
      ...popover()
        .slice(1)
        .map((s) => (s.parent === "pop" ? { ...s, parent: "g" } : s)),
    ]);
    expect(editor.scene.bounds("g")).toEqual({ x: 0, y: 0, width: 200, height: 213 });
  });

  it("export the clipping frame above their scope unmasked", () => {
    const editor = setup(popover());
    const svg = exportSvg(editor.scene, editor.measurer, ["pop"], {
      x: 0,
      y: 0,
      width: 200,
      height: 213,
    });
    const masked = maskedGroup(svg);
    expect(masked).toContain("#2b4fd6");
    expect(masked).not.toContain("#00ff00");
    expect(svg).toContain("#00ff00");
  });

  it("only let clicks reach what they show", () => {
    const editor = setup(avatar());
    // Inside the circle: the card.
    expect(hitTest(editor.scene, "p", { x: 50, y: 50 }, 0)).toBe("card");
    // On the card but outside the circle (a corner of its box): nothing.
    expect(hitTest(editor.scene, "p", { x: 5, y: 5 }, 0)).toBeNull();
    expect(hitTest(editor.scene, "p", { x: 200, y: 200 }, 0)).toBeNull();
  });

  it("make a group as big as what shows", () => {
    const editor = setup(avatar());
    expect(editor.scene.bounds("g")).toEqual({ x: 0, y: 0, width: 100, height: 100 });
  });

  it("export as clip paths around the layers they clip", () => {
    const editor = setup(avatar());
    const svg = exportSvg(editor.scene, editor.measurer, ["g"], {
      x: 0,
      y: 0,
      width: 100,
      height: 100,
    });
    expect(svg).toContain('<clipPath id="mask1"><ellipse');
    expect(svg).toMatch(/<g clip-path="url\(#mask1\)"><rect[^>]*fill="#2b4fd6"/);
    // The mask itself isn't drawn.
    expect(svg.match(/<ellipse/g)?.length).toBe(1);
  });

  it("export by alpha or luminance as an SVG mask holding the mask layer itself", () => {
    for (const maskType of ["alpha", "luminance"] as const) {
      const editor = setup(
        avatar().map((s) =>
          s.id === "circle"
            ? {
                ...s,
                maskType,
                fills: [
                  {
                    type: "linear",
                    from: { x: 0, y: 0.5 },
                    to: { x: 1, y: 0.5 },
                    stops: [
                      { position: 0, color: "#ffffff" },
                      { position: 1, color: "#ffffff00" },
                    ],
                  },
                ],
              }
            : s,
        ),
      );
      const svg = exportSvg(editor.scene, editor.measurer, ["g"], {
        x: 0,
        y: 0,
        width: 100,
        height: 100,
      });
      // The circle, drawn with its gradient, inside the <mask>; the card masked by it.
      const id = new RegExp(
        `<mask id="(\\w+)"[^>]*mask-type="${maskType}"><ellipse[^>]*fill="url\\(#`,
      ).exec(svg)?.[1];
      expect(id).toBeTruthy();
      expect(svg).toContain(`<g mask="url(#${id})"><rect`);
      expect(svg).not.toContain("<clipPath");
    }
  });
});

describe("use as mask", () => {
  it("groups several layers with the bottom one as the mask, in one undo step", () => {
    const editor = setup([
      { id: "photo", x: 0, y: 0, width: 200, height: 200 },
      { id: "circle", type: "ellipse", x: 50, y: 50, width: 100, height: 100 },
    ]);
    // The circle is on top: order matters, so put it at the bottom first.
    editor.select(["circle"]);
    editor.reorder("back");
    editor.select(["photo", "circle"]);
    editor.toggleMask();
    const group = editor.doc.get("circle")?.parent as string;
    expect(editor.doc.get(group)).toMatchObject({ type: "group", props: { name: "Mask group" } });
    expect(getProp(editor.doc.get("circle")?.props ?? {}, "isMask")).toBe(true);
    expect(editor.scene.bounds(group)).toEqual({ x: 50, y: 50, width: 100, height: 100 });
    editor.undo();
    expect(editor.doc.get("circle")?.parent).toBe("p");
    expect(editor.doc.get("circle")?.props.isMask).toBeUndefined();
  });

  it("turns one layer into a mask, and back", () => {
    const editor = setup(avatar().map((n) => (n.id === "circle" ? { ...n, isMask: false } : n)));
    editor.select(["circle"]);
    editor.toggleMask();
    expect(getProp(editor.doc.get("circle")?.props ?? {}, "isMask")).toBe(true);
    editor.toggleMask();
    expect(editor.doc.get("circle")?.props.isMask).toBeUndefined();
  });

  it("asks for the layers to clip when one layer on the page is chosen", () => {
    const editor = setup([{ id: "box", width: 10, height: 10 }]);
    editor.select(["box"]);
    editor.toggleMask();
    expect(editor.s.notice?.text).toBe("Select the mask together with the layers it should clip.");
    expect(editor.doc.get("box")?.props.isMask).toBeUndefined();
  });

  it("masks with any bottom layer, a text too, as Figma does", () => {
    const editor = setup([
      { id: "label", type: "text", characters: "Hi" },
      { id: "box", width: 10, height: 10 },
    ]);
    editor.select(["label", "box"]);
    editor.toggleMask();
    const group = editor.doc.get("box")?.parent;
    expect(editor.doc.get(group ?? "")?.type).toBe("group");
    expect(getProp(editor.doc.get("label")?.props ?? {}, "isMask")).toBe(true);
  });
});
