import { Doc } from "@drawpane/editor";
import { type Op, ROOT_ID } from "@drawpane/model";
import { describe, expect, it } from "vitest";
import { containersWithin, dropTarget, kindOf, layerRows } from "./layer-tree";

/**
 * Home (frame, auto layout)
 *   Header (text)
 *   Cards (group)
 *     Card title (text)
 *     Photo (image)
 * Old (rect, hidden)
 *   — no children
 * Settings (frame, hidden)
 *   Toggle (component)
 */
function setup() {
  const doc = new Doc();
  const create = (id: string, type: string, parent: string, key: string, props = {}): Op =>
    ({ op: "create", id, type, parent, key, props }) as Op;
  doc.apply([
    create("p", "page", ROOT_ID, "a0"),
    create("home", "frame", "p", "a2", { name: "Home", layoutMode: "column" }),
    create("header", "text", "home", "a1", { name: "Header" }),
    create("cards", "group", "home", "a0", { name: "Cards" }),
    create("title", "text", "cards", "a1", { name: "Card title" }),
    create("photo", "rect", "cards", "a0", {
      name: "Photo",
      fills: [{ type: "image", ref: "a".repeat(64), scaleMode: "fill" }],
    }),
    create("old", "rect", "p", "a1", { name: "Old", visible: false }),
    create("settings", "frame", "p", "a0", { name: "Settings", visible: false }),
    create("toggle", "frame", "settings", "a0", { name: "Toggle", isComponent: true }),
  ]);
  return doc;
}

const names = (doc: Doc, rows: { node: { id: string }; context?: boolean }[]) =>
  rows.map(
    (r) => `${r.context ? "(" : ""}${doc.get(r.node.id)?.props.name}${r.context ? ")" : ""}`,
  );

describe("layer tree", () => {
  it("lists topmost first, folding collapsed containers", () => {
    const doc = setup();
    const { rows } = layerRows(doc, "p", { collapsed: new Set(["cards"]) });
    expect(names(doc, rows)).toEqual(["Home", "Header", "Cards", "Old", "Settings", "Toggle"]);
    expect(rows.find((r) => r.node.id === "toggle")?.hiddenByParent).toBe(true);
  });

  it("finds by name inside folded containers, showing where each result sits", () => {
    const doc = setup();
    const { rows, found } = layerRows(doc, "p", {
      collapsed: new Set(["home", "cards"]),
      query: "title",
    });
    expect(names(doc, rows)).toEqual(["(Home)", "(Cards)", "Card title"]);
    expect(found).toEqual(["title"]);
  });

  it("filters by kind, alone or with a query", () => {
    const doc = setup();
    expect(layerRows(doc, "p", { collapsed: new Set(), filter: "text" }).found).toEqual([
      "header",
      "title",
    ]);
    expect(layerRows(doc, "p", { collapsed: new Set(), filter: "components" }).found).toEqual([
      "toggle",
    ]);
    expect(layerRows(doc, "p", { collapsed: new Set(), filter: "images" }).found).toEqual([
      "photo",
    ]);
    expect(layerRows(doc, "p", { collapsed: new Set(), filter: "hidden" }).found).toEqual([
      "old",
      "settings",
    ]);
    const both = layerRows(doc, "p", { collapsed: new Set(), filter: "text", query: "head" });
    expect(both.found).toEqual(["header"]);
    // A matching container keeps its own matching children, not the rest.
    expect(names(doc, layerRows(doc, "p", { collapsed: new Set(), query: "o" }).rows)).toEqual([
      "Home",
      "(Cards)",
      "Photo",
      "Old",
      "(Settings)",
      "Toggle",
    ]);
  });

  it("reads auto layout, images and components from the layer", () => {
    const doc = setup();
    expect(kindOf(doc.get("home") as never)).toBe("frame-column");
    expect(kindOf(doc.get("photo") as never)).toBe("image");
    expect(kindOf(doc.get("toggle") as never)).toBe("component");
  });

  it("collects every container inside one, for an Alt-click", () => {
    expect(containersWithin(setup(), "home")).toEqual(["home", "cards"]);
  });
});

describe("dropTarget", () => {
  // iPhone 18 Pro > Frame 1 > (Text 1, Image), then Other at the top level, as the panel lists them.
  const node = (id: string, type = "rect") =>
    ({ id, type, parent: "", key: "a0", props: {} }) as never;
  const rows = [
    { node: node("phone", "frame"), depth: 0, hasChildren: true },
    { node: node("frame1", "frame"), depth: 1, hasChildren: true },
    { node: node("text1", "text"), depth: 2, hasChildren: false },
    { node: node("image"), depth: 2, hasChildren: false },
  ];
  const parents: Record<string, string> = { frame1: "phone", text1: "frame1", image: "frame1" };
  const parentOf = (id: string) => parents[id] ?? null;

  it("drops below the last row at the level the pointer is at", () => {
    expect(dropTarget(rows, 3, 0.8, 2, parentOf)).toMatchObject({
      id: "image",
      where: "after",
      depth: 2,
    });
    // Out one level: below Frame 1, still inside the phone.
    expect(dropTarget(rows, 3, 0.8, 1, parentOf)).toMatchObject({
      id: "frame1",
      where: "after",
      depth: 1,
    });
    // All the way out: below the phone, on the page.
    expect(dropTarget(rows, 3, 0.8, -3, parentOf)).toMatchObject({
      id: "phone",
      where: "after",
      depth: 0,
    });
    // Further right than the row's own level is just below the row.
    expect(dropTarget(rows, 3, 0.8, 9, parentOf)).toMatchObject({ id: "image", depth: 2 });
  });

  it("can't go further out than the next row allows", () => {
    // Text 1 is followed by Image at the same level: only below Text 1.
    expect(dropTarget(rows, 2, 0.8, 0, parentOf)).toMatchObject({ id: "text1", where: "after" });
  });

  it("drops inside a group from its middle, and at the top of an open group's list from below its row", () => {
    expect(dropTarget(rows, 1, 0.5, 1, parentOf)).toMatchObject({
      id: "frame1",
      where: "inside",
      show: "box",
    });
    expect(dropTarget(rows, 1, 0.9, 1, parentOf)).toMatchObject({
      id: "frame1",
      where: "inside",
      show: "line-after",
      depth: 2,
    });
    expect(dropTarget(rows, 1, 0.1, 1, parentOf)).toMatchObject({ id: "frame1", where: "before" });
  });
});
