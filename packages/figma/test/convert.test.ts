import { readFileSync } from "node:fs";
import {
  applyTransaction,
  getProp,
  MemoryStore,
  type NodeRecord,
  type Op,
  ROOT_ID,
} from "@drawpane/model";
import { describe, expect, it } from "vitest";
import { convertFile, drawpaneId, type Figma, mirroredId, networkPath, variantProps } from "../src";

/** Creates the nodes in a store the way the room does, parents first: throws on anything invalid. */
function validate(nodes: readonly NodeRecord[]): MemoryStore {
  const store = new MemoryStore([]);
  const byParent = new Map<string, NodeRecord[]>();
  for (const n of nodes) byParent.set(n.parent, [...(byParent.get(n.parent) ?? []), n]);
  const ops: Op[] = [];
  const queue = [...(byParent.get(ROOT_ID) ?? [])];
  for (let n = queue.shift(); n; n = queue.shift()) {
    ops.push({
      op: "create",
      id: n.id,
      type: n.type,
      parent: n.parent,
      key: n.key,
      props: n.props,
    });
    queue.push(...(byParent.get(n.id) ?? []));
  }
  expect(ops).toHaveLength(nodes.length);
  applyTransaction(store, ops, { rollback: false });
  return store;
}

const parity = JSON.parse(
  readFileSync(new URL("./fixtures/parity-file.json", import.meta.url), "utf8"),
) as Figma.File;

const white = { r: 1, g: 1, b: 1, a: 1 };
const node = (n: Partial<Figma.Node> & { id: string; type: string }): Figma.Node =>
  ({ name: n.type.toLowerCase(), ...n }) as Figma.Node;
const at = (x: number, y: number, r = 0): Figma.Transform => {
  const c = Math.cos((r * Math.PI) / 180);
  const s = Math.sin((r * Math.PI) / 180);
  return [
    [c, -s, x],
    [s, c, y],
  ];
};
const file = (...children: Figma.Node[]): Figma.File => ({
  name: "Test",
  document: node({
    id: "0:0",
    type: "DOCUMENT",
    children: [node({ id: "0:1", type: "CANVAS", name: "Page", children })],
  }),
});
const byName = (nodes: readonly NodeRecord[], name: string) =>
  nodes.find((n) => getProp(n.props, "name") === name) as NodeRecord;

describe("a real Figma file", () => {
  const { nodes, notes } = convertFile(parity);

  it("imports every page and cell as valid Drawpane layers", () => {
    validate(nodes);
    expect(nodes.filter((n) => n.type === "page").map((n) => getProp(n.props, "name"))).toEqual([
      "Page 1",
      "Glass calibration",
      "Parity: blurs",
      "Parity: fills",
      "Parity: shadows",
      "Parity: strokes",
    ]);
    // 22 + 63 cells.
    expect(nodes.filter((n) => n.type === "frame")).toHaveLength(85);
  });

  it("keeps paints, effects and strokes as Drawpane has them", () => {
    const radial = nodes.find(
      (n) => n.parent === drawpaneId("7:186") && n.type === "rect",
    ) as NodeRecord;
    expect(getProp(radial.props, "fills")[0]).toMatchObject({
      type: "radial",
      from: { x: 0.3, y: 0.3 },
      to: { x: 0.9, y: 0.6 },
    });
    const card = nodes.find(
      (n) => n.parent === drawpaneId(findCell("shadows/drop-layered")) && n.type === "rect",
    ) as NodeRecord;
    expect(getProp(card.props, "effects")).toEqual([
      { type: "drop-shadow", color: "#0000001a", x: 0, y: 1, blur: 2, spread: 0 },
      { type: "drop-shadow", color: "#0000001f", x: 0, y: 8, blur: 24, spread: 0 },
    ]);
    // Glass comes in with defaults: Figma's API doesn't give its settings.
    expect(notes.lines()).toContain(
      "22 glass effects came in with default settings (Figma's API doesn't share them)",
    );
  });
});

function findCell(name: string): string {
  for (const page of parity.document.children ?? [])
    for (const c of page.children ?? []) if (c.name === name) return c.id;
  throw new Error(name);
}

describe("geometry", () => {
  it("lands a rotated layer in its frame, and a group's children in the group's frame", () => {
    const rect = node({
      id: "1:3",
      type: "RECTANGLE",
      name: "Turned",
      size: { x: 100, y: 40 },
      relativeTransform: at(30, 20, 30),
      fills: [{ type: "SOLID", color: white }],
      // Where Figma puts it on the page: inside the frame at (100, 100), relative to it.
      absoluteBoundingBox: {
        x: 100 + 30 - 40 * Math.sin(Math.PI / 6),
        y: 120,
        width: 100 * Math.cos(Math.PI / 6) + 40 * Math.sin(Math.PI / 6),
        height: 100 * Math.sin(Math.PI / 6) + 40 * Math.cos(Math.PI / 6),
      },
    });
    const group = node({
      id: "1:2",
      type: "GROUP",
      name: "Group",
      relativeTransform: at(10, 10),
      children: [rect],
    });
    const frame = node({
      id: "1:1",
      type: "FRAME",
      name: "Frame",
      size: { x: 400, y: 300 },
      relativeTransform: at(100, 100),
      children: [group],
    });
    const { nodes } = convertFile(file(frame));
    validate(nodes);
    const turned = byName(nodes, "Turned");
    expect(turned.parent).toBe(drawpaneId("1:2"));
    // The box (rotated about its centre) is the same one Figma's transform gives, in the frame's space.
    expect(getProp(turned.props, "rotation")).toBeCloseTo(30, 3);
    expect(getProp(turned.props, "width")).toBe(100);
  });
});

describe("text", () => {
  it("takes the base style, and runs for characters styled differently", () => {
    const text = node({
      id: "2:1",
      type: "TEXT",
      name: "Hello",
      size: { x: 120, y: 24 },
      relativeTransform: at(0, 0),
      characters: "Hello world",
      style: {
        fontFamily: "Inter",
        fontWeight: 400,
        fontSize: 16,
        lineHeightUnit: "PIXELS",
        lineHeightPx: 24,
        letterSpacing: 0,
        textAlignHorizontal: "CENTER",
        textAutoResize: "WIDTH_AND_HEIGHT",
      },
      fills: [{ type: "SOLID", color: { r: 0, g: 0, b: 0, a: 1 } }],
      characterStyleOverrides: [0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1],
      styleOverrideTable: {
        "1": { fontWeight: 700, fills: [{ type: "SOLID", color: { r: 1, g: 0, b: 0, a: 1 } }] },
      },
    });
    const { nodes } = convertFile(file(text));
    validate(nodes);
    const t = byName(nodes, "Hello");
    expect(t.props).toMatchObject({
      characters: "Hello world",
      fontFamily: "Inter",
      fontSize: 16,
      lineHeight: { unit: "px", value: 24 },
      textAlign: "center",
      textAutoResize: "width",
    });
    expect(getProp(t.props, "textRuns")).toEqual([
      { start: 6, end: 11, fontWeight: 700, fills: [{ type: "solid", color: "#ff0000" }] },
    ]);
  });
});

describe("vertical trim", () => {
  it("brings Figma's cap height to baseline trim", () => {
    const text = (name: string, leadingTrim?: "CAP_HEIGHT" | "NONE") =>
      node({
        id: name,
        type: "TEXT",
        name,
        size: { x: 60, y: 12 },
        relativeTransform: at(0, 0),
        characters: "Title",
        style: { fontFamily: "Inter", fontSize: 16, ...(leadingTrim ? { leadingTrim } : {}) },
      });
    const { nodes } = convertFile(file(text("Trimmed", "CAP_HEIGHT"), text("Standard", "NONE")));
    validate(nodes);
    expect(getProp(byName(nodes, "Trimmed").props, "leadingTrim")).toBe("cap-height");
    expect(getProp(byName(nodes, "Standard").props, "leadingTrim")).toBe("none");
  });
});

describe("auto layout and components", () => {
  it("renames auto layout, and links instances to their main component with what they change", () => {
    const label = node({
      id: "3:2",
      type: "TEXT",
      name: "Label",
      size: { x: 40, y: 20 },
      relativeTransform: at(12, 8),
      characters: "Buy",
      style: { fontFamily: "Inter", fontSize: 14 },
      fills: [{ type: "SOLID", color: white }],
    });
    const main = node({
      id: "3:1",
      type: "COMPONENT",
      name: "Button",
      size: { x: 64, y: 36 },
      relativeTransform: at(0, 0),
      layoutMode: "HORIZONTAL",
      itemSpacing: 8,
      paddingLeft: 12,
      paddingRight: 12,
      paddingTop: 8,
      paddingBottom: 8,
      primaryAxisAlignItems: "CENTER",
      counterAxisAlignItems: "CENTER",
      layoutSizingHorizontal: "HUG",
      layoutSizingVertical: "HUG",
      fills: [{ type: "SOLID", color: { r: 0.2, g: 0.4, b: 1, a: 1 } }],
      children: [label],
    });
    const copy = node({
      id: "3:5",
      type: "INSTANCE",
      name: "Button",
      componentId: "3:1",
      size: { x: 64, y: 36 },
      relativeTransform: at(100, 0),
      layoutMode: "HORIZONTAL",
      itemSpacing: 8,
      paddingLeft: 12,
      paddingRight: 12,
      paddingTop: 8,
      paddingBottom: 8,
      primaryAxisAlignItems: "CENTER",
      counterAxisAlignItems: "CENTER",
      layoutSizingHorizontal: "HUG",
      layoutSizingVertical: "HUG",
      fills: [{ type: "SOLID", color: { r: 0.2, g: 0.4, b: 1, a: 1 } }],
      children: [{ ...label, id: "I3:5;3:2", characters: "Sell" }],
    });
    const { nodes } = convertFile(file(main, copy));
    validate(nodes);
    expect(byName(nodes, "Button").props).toMatchObject({
      isComponent: true,
      layoutMode: "row",
      gap: 8,
      justifyContent: "center",
      alignItems: "center",
      sizingH: "hug",
    });
    const instance = nodes.find((n) => n.id === drawpaneId("3:5")) as NodeRecord;
    expect(getProp(instance.props, "instanceOf")).toBe(drawpaneId("3:1"));
    const sell = nodes.find((n) => n.parent === instance.id) as NodeRecord;
    expect(sell.props).toMatchObject({ mirrors: drawpaneId("3:2"), overrides: ["characters"] });
  });

  it("reads variant names and nested instance ids", () => {
    expect(variantProps("Size=Large, State=Hover")).toEqual({ Size: "Large", State: "Hover" });
    expect(variantProps("Button")).toBeNull();
    expect(mirroredId("I1:2;3:4")).toBe("3:4");
    expect(mirroredId("I1:2;5:6;3:4")).toBe("I5:6;3:4");
    expect(drawpaneId("I1:2;3:4")).toBe("fI1-2_3-4");
  });
});

describe("strokes", () => {
  it("keeps a box's width per side, and the widest as its one width", () => {
    const row = node({
      id: "1:20",
      type: "RECTANGLE",
      name: "Row",
      size: { x: 320, y: 48 },
      relativeTransform: at(0, 0),
      fills: [{ type: "SOLID", color: white }],
      strokes: [{ type: "SOLID", color: { r: 0, g: 0, b: 0, a: 0.12 } }],
      strokeWeight: 1,
      strokeAlign: "INSIDE",
      individualStrokeWeights: { top: 0, right: 0, bottom: 1, left: 0 },
    });
    const even = node({
      id: "1:21",
      type: "RECTANGLE",
      name: "Even",
      size: { x: 40, y: 40 },
      relativeTransform: at(0, 60),
      strokes: [{ type: "SOLID", color: white }],
      strokeWeight: 2,
      individualStrokeWeights: { top: 2, right: 2, bottom: 2, left: 2 },
    });
    const { nodes, notes } = convertFile(file(row, even));
    validate(nodes);
    expect(getProp(byName(nodes, "Row").props, "strokeWeights")).toEqual([0, 0, 1, 0]);
    expect(getProp(byName(nodes, "Row").props, "strokeWeight")).toBe(1);
    // As wide all round: an ordinary stroke.
    expect(getProp(byName(nodes, "Even").props, "strokeWeights")).toBeNull();
    expect(notes.lines().some((n) => n.includes("per-side stroke"))).toBe(false);
  });
});

describe("line height", () => {
  it("comes in on the characters that set their own, with nothing noted", () => {
    const text = node({
      id: "1:50",
      type: "TEXT",
      name: "Heading and body",
      size: { x: 200, y: 60 },
      relativeTransform: at(0, 0),
      characters: "Title\nBody",
      style: {
        fontFamily: "Inter",
        fontWeight: 400,
        fontSize: 16,
        lineHeightPx: 22,
        lineHeightUnit: "PIXELS",
      },
      characterStyleOverrides: [1, 1, 1, 1, 1, 1],
      styleOverrideTable: { "1": { fontSize: 28, lineHeightPx: 40, lineHeightUnit: "PIXELS" } },
    });
    const { nodes, notes } = convertFile(file(text));
    validate(nodes);
    expect(getProp(byName(nodes, "Heading and body").props, "textRuns")).toEqual([
      { start: 0, end: 6, fontSize: 28, lineHeight: { unit: "px", value: 40 } },
    ]);
    expect(notes.lines()).toEqual([]);
  });
});

describe("lists", () => {
  it("come in on each paragraph's characters, merged with the character styles", () => {
    const text = node({
      id: "1:40",
      type: "TEXT",
      name: "Todo",
      size: { x: 200, y: 60 },
      relativeTransform: at(0, 0),
      characters: "Intro\nPlan\nBook",
      style: { fontFamily: "Inter", fontWeight: 400, fontSize: 16 },
      // "an" in "Plan" is bold, across nothing but the list item.
      characterStyleOverrides: [0, 0, 0, 0, 0, 0, 0, 0, 1, 1],
      styleOverrideTable: { "1": { fontWeight: 700 } },
      lineTypes: ["NONE", "UNORDERED", "ORDERED"],
      lineIndentations: [0, 1, 2],
    });
    const { nodes } = convertFile(file(text));
    validate(nodes);
    expect(getProp(byName(nodes, "Todo").props, "textRuns")).toEqual([
      { start: 6, end: 8, listType: "bullet" },
      { start: 8, end: 10, fontWeight: 700, listType: "bullet" },
      { start: 10, end: 11, listType: "bullet" },
      { start: 11, end: 15, listType: "number", listLevel: 1 },
    ]);
  });
});

describe("masks", () => {
  it("keep how they mask: by alpha (Figma's default), luminance or outline", () => {
    const mask = (id: string, name: string, extra: Partial<Figma.Node>) =>
      node({
        id,
        type: "RECTANGLE",
        name,
        size: { x: 40, y: 40 },
        relativeTransform: at(0, 0),
        fills: [{ type: "SOLID", color: white }],
        isMask: true,
        ...extra,
      });
    const { nodes } = convertFile(
      file(
        mask("1:30", "Alpha", { maskType: "ALPHA" }),
        mask("1:31", "Luminance", { maskType: "LUMINANCE" }),
        mask("1:32", "Outline", { maskType: "VECTOR" }),
        mask("1:33", "Old alpha", {}),
        mask("1:34", "Old outline", { isMaskOutline: true }),
      ),
    );
    validate(nodes);
    const type = (name: string) => getProp(byName(nodes, name).props, "maskType");
    expect(type("Alpha")).toBe("alpha");
    expect(type("Luminance")).toBe("luminance");
    expect(type("Outline")).toBe("outline");
    expect(type("Old alpha")).toBe("alpha");
    expect(type("Old outline")).toBe("outline");
  });

  it("leave a group used as a mask unmasking, with a note, as Drawpane masks with shapes", () => {
    const { nodes, notes } = convertFile(
      file(
        node({
          id: "1:40",
          type: "GROUP",
          name: "Group mask",
          isMask: true,
          relativeTransform: at(0, 0),
          absoluteBoundingBox: { x: 0, y: 0, width: 40, height: 40 },
          children: [
            node({
              id: "1:41",
              type: "RECTANGLE",
              name: "Inside",
              size: { x: 40, y: 40 },
              relativeTransform: at(0, 0),
              absoluteBoundingBox: { x: 0, y: 0, width: 40, height: 40 },
            }),
          ],
        }),
      ),
    );
    validate(nodes);
    expect(byName(nodes, "Group mask").props.isMask).toBeUndefined();
    expect(notes.lines().join(" ")).toContain("no longer mask");
  });
});

describe("vectors", () => {
  it("draws an open vector network as path data", () => {
    expect(
      networkPath({
        vertices: [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
          { x: 10, y: 10 },
        ],
        segments: [
          { start: 0, end: 1 },
          { start: 1, end: 2, tangentStart: { x: 5, y: 0 }, tangentEnd: { x: 0, y: -5 } },
        ],
      }),
    ).toBe("M0 0 L10 0 C15 0 10 5 10 10");
  });
});
