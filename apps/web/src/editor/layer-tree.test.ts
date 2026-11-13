import { Doc } from "@drawpane/editor";
import { type Op, ROOT_ID } from "@drawpane/model";
import { describe, expect, it } from "vitest";
import { containersWithin, kindOf, layerRows } from "./layer-tree";

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
