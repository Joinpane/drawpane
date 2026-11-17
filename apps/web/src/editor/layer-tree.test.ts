import { Doc } from "@drawpane/editor";
import { type Op, ROOT_ID } from "@drawpane/model";
import { describe, expect, it } from "vitest";
import {
  containersWithin,
  dropTarget,
  INDENT,
  indexRows,
  kindOf,
  layerRows,
  pinnedRows,
  type Row,
  revealLeft,
  rowWidthFor,
} from "./layer-tree";

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

describe("deep trees", () => {
  it("widens the tree a level at a time, so a deep name keeps its room", () => {
    expect(rowWidthFor(1) - rowWidthFor(0)).toBe(INDENT);
    // The narrowest pane (240px, less its 8px insets) fits about 8 levels before it scrolls.
    expect(rowWidthFor(0)).toBeLessThan(224);
    expect(rowWidthFor(14)).toBeGreaterThan(224);
  });

  it("leaves a row in view alone", () => {
    expect(revealLeft(0, 0, 224)).toBeNull();
    expect(revealLeft(2, 0, 224)).toBeNull();
  });

  it("scrolls across to a deep row's name, keeping a level of its parent in view", () => {
    const left = revealLeft(13, 0, 224);
    expect(left).toBe(4 + 12 * INDENT);
    // From there, the row is in view.
    expect(revealLeft(13, left ?? 0, 224)).toBeNull();
  });

  it("scrolls back to a shallow row", () => {
    expect(revealLeft(1, 150, 224)).toBe(4);
    expect(revealLeft(0, 150, 224)).toBe(0);
  });
});

describe("pinned ancestors", () => {
  const H = 28;
  /** Rows from depths alone: what pinning reads. */
  const rowsOf = (depths: number[]) =>
    depths.map(
      (depth, i) => ({ node: { id: `r${i}` }, depth, hasChildren: false }) as unknown as Row,
    );
  // r0 A
  //   r1 B
  //     r2 C
  //       r3 c1 … r7 c5
  //     r8 D
  //   r9 E
  // r10 F
  const tree = rowsOf([0, 1, 2, 3, 3, 3, 3, 3, 2, 1, 0]);
  const index = indexRows(tree);

  it("knows each row's parent and where what it holds ends", () => {
    expect([...index.parent]).toEqual([-1, 0, 1, 2, 2, 2, 2, 2, 1, 0, -1]);
    expect([...index.end]).toEqual([10, 9, 8, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it("pins nothing at the top", () => {
    expect(pinnedRows(index, 0, H, 10)).toEqual({ rows: [], offset: 0 });
  });

  it("pins each ancestor of the top row once its own row has scrolled out, by depth", () => {
    // A is still partly in view: nothing pinned.
    expect(pinnedRows(index, 10, H, 10).rows).toEqual([]);
    // A's row has gone. Pinned, it covers B, which pins under it and covers C:
    // a chain of first children pins together.
    expect(pinnedRows(index, H, H, 10)).toEqual({ rows: [0, 1, 2], offset: 0 });
    // Deep in C's children: A, B and C.
    expect(pinnedRows(index, 4 * H, H, 10)).toEqual({ rows: [0, 1, 2], offset: 0 });
  });

  it("slides the innermost pinned row up as the end of what it holds passes", () => {
    // C's last child (r7) ends at 8 rows; with three pinned, the stack ends 3 rows down.
    expect(pinnedRows(index, 5 * H, H, 10)).toEqual({ rows: [0, 1, 2], offset: 0 });
    expect(pinnedRows(index, 5 * H + 10, H, 10)).toEqual({ rows: [0, 1, 2], offset: -10 });
    // Past it, D is under B: C is no longer pinned.
    expect(pinnedRows(index, 6 * H, H, 10).rows).toEqual([0, 1]);
  });

  it("pins nothing past the end of a top-level row", () => {
    expect(pinnedRows(index, 10 * H, H, 10).rows).toEqual([]);
  });

  it("keeps the outermost when there are more than fit", () => {
    expect(pinnedRows(index, 4 * H, H, 2).rows).toEqual([0, 1]);
  });

  it("matches a brute-force reading of every scroll position", () => {
    const depths = [0, 1, 2, 2, 3, 4, 4, 1, 2, 0, 1, 1, 2, 3, 3, 3, 0, 0, 1];
    const rows = rowsOf(depths);
    const idx = indexRows(rows);
    const ancestors = (i: number) => {
      const out: number[] = [];
      for (let j = i - 1, d = depths[i] as number; j >= 0 && d > 0; j--)
        if ((depths[j] as number) < d) {
          out.unshift(j);
          d = depths[j] as number;
        }
      return out;
    };
    const inside = (row: number, of: number) => row > of && row < (idx.end[of] as number);
    for (let top = 0; top < rows.length * H; top += 7) {
      const { rows: pinned, offset } = pinnedRows(idx, top, H, 10);
      pinned.forEach((p, i) => {
        // A chain from the top level down, each the parent of the next...
        expect(depths[p]).toBe(i);
        if (i > 0) expect(idx.parent[p]).toBe(pinned[i - 1]);
        // ...each scrolled out from under the rows pinned above it, with what it holds still below them.
        expect(p * H).toBeLessThan(top + i * H);
        expect((idx.end[p] as number) * H).toBeGreaterThan(top + i * H);
      });
      // And nothing more to pin: the row under the stack is the last one's child (or is the top level).
      const under = Math.floor((top + pinned.length * H) / H);
      const last = pinned.at(-1);
      if (under < rows.length) {
        if (last === undefined) expect(depths[under]).toBe(0);
        else if (inside(under, last)) expect(idx.parent[under]).toBe(last);
      }
      expect(offset).toBeLessThanOrEqual(0);
      expect(offset).toBeGreaterThan(-H);
      // Brute force agrees on the rows' parents.
      for (let i = 0; i < rows.length; i++) expect(idx.parent[i]).toBe(ancestors(i).at(-1) ?? -1);
    }
  });
});
