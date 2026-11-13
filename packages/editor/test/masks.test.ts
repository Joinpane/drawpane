import { getProp, type Op, type Props, ROOT_ID } from "@drawpane/model";
import { describe, expect, it } from "vitest";
import { Editor } from "../src/editor";
import { hitTest } from "../src/hit";
import { maskScopes } from "../src/masks";
import { exportSvg } from "../src/svg";

type Spec = Props & {
  id: string;
  type?: "rect" | "ellipse" | "group" | "text" | "frame";
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

  it("refuses a bottom layer without an outline", () => {
    const editor = setup([
      { id: "label", type: "text", characters: "Hi" },
      { id: "box", width: 10, height: 10 },
    ]);
    editor.select(["label", "box"]);
    editor.toggleMask();
    expect(editor.s.notice?.text).toMatch(/A mask needs an outline/);
    expect(editor.doc.get("box")?.parent).toBe("p");
  });
});
