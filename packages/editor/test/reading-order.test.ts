import {
  DEFAULT_TRANSITION,
  getProp,
  type NodeRecord,
  type Reaction,
  ROOT_ID,
} from "@drawpane/model";
import { describe, expect, it } from "vitest";
import { Editor } from "../src/editor";
import { layoutReadingOrder, readingOrderOf, readingOrderText } from "../src/reading-order";

const tap = (id: string): Reaction[] => [
  { id, trigger: { type: "tap" }, action: { type: "back" }, transition: DEFAULT_TRANSITION },
];

/** A phone screen: a heading, a subtitle, two buttons side by side, and a list row. */
function setup() {
  const editor = new Editor({ measurer: { width: (_f, t) => t.length * 6 }, clientId: "t" });
  editor.state.set({ role: "editor" });
  editor.doc.apply([
    { op: "create", id: "p", type: "page", parent: ROOT_ID, key: "a0", props: {} },
  ]);
  editor.setPage("p");
  editor.setViewport(1600, 1200);
  const board = editor.createLayer("frame", { x: 0, y: 0, width: 393, height: 852 }, "p", {
    name: "Home",
  }) as string;
  const text = (characters: string, y: number, fontSize = 14, x = 20) =>
    editor.createLayer("text", { x, y, width: 300, height: fontSize + 4 }, board, {
      characters,
      fontSize,
    }) as string;
  const heading = text("Good morning, Ana", 60, 24);
  const subtitle = text("Three things on today", 92);
  const later = editor.createLayer("frame", { x: 200, y: 140, width: 150, height: 44 }, board, {
    name: "Later",
    reactions: tap("tapbuttonlater00"),
  }) as string;
  const join = editor.createLayer("frame", { x: 20, y: 142, width: 150, height: 44 }, board, {
    name: "Join",
    reactions: tap("tapbuttonjoin000"),
  }) as string;
  // Inside the Join button: part of that stop, not one of its own.
  editor.createLayer("text", { x: 40, y: 150, width: 60, height: 18 }, join, {
    characters: "Join",
  });
  const row = text("Token audit, tomorrow", 220);
  return { editor, board, heading, subtitle, join, later, row };
}

describe("reading order", () => {
  it("follows the layout: rows top to bottom, then left to right, one stop per button", () => {
    const { editor, board, heading, subtitle, join, later, row } = setup();
    expect(layoutReadingOrder(editor, board)).toEqual([heading, subtitle, join, later, row]);
    const order = readingOrderOf(editor, board);
    expect(order.custom).toBe(false);
    expect(order.items.map((i) => [i.name, i.role])).toEqual([
      ["Good morning, Ana", "heading"],
      ["Three things on today", "text"],
      ["Join", "button"],
      ["Later", "button"],
      ["Token audit, tomorrow", "text"],
    ]);
  });

  it("keeps an order someone set, as layers come and go", () => {
    const { editor, board, heading, subtitle, join, later, row } = setup();
    editor.setReadingOrder(board, [heading, later, join, subtitle, row]);
    expect(readingOrderOf(editor, board).custom).toBe(true);
    // A new layer joins at the end; a deleted one drops out.
    const footer = editor.createLayer("text", { x: 20, y: 0, width: 200, height: 18 }, board, {
      characters: "Footer",
    }) as string;
    editor.select([subtitle]);
    editor.deleteSelection();
    expect(readingOrderOf(editor, board).items.map((i) => i.id)).toEqual([
      heading,
      later,
      join,
      row,
      footer,
    ]);
  });

  it("moves one stop at a time in one undo step, and goes back to the layout's order", () => {
    const { editor, board, heading, subtitle, join, later, row } = setup();
    editor.moveInReadingOrder(board, later, -1);
    const ids = () => readingOrderOf(editor, board).items.map((i) => i.id);
    expect(ids()).toEqual([heading, subtitle, later, join, row]);
    editor.undo();
    expect(ids()).toEqual([heading, subtitle, join, later, row]);
    expect(getProp((editor.doc.get(board) as NodeRecord).props, "readingOrder")).toBeNull();
    editor.moveInReadingOrder(board, heading, 4);
    expect(ids().at(-1)).toBe(heading);
    editor.setReadingOrder(board, null);
    expect(readingOrderOf(editor, board).custom).toBe(false);
  });

  it("exports as a numbered list for a handoff", () => {
    const { editor, board } = setup();
    expect(readingOrderText(readingOrderOf(editor, board), "Home")).toBe(
      [
        "Reading order: Home",
        "",
        "1. Good morning, Ana (heading)",
        "2. Three things on today (text)",
        "3. Join (button)",
        "4. Later (button)",
        "5. Token audit, tomorrow (text)",
      ].join("\n"),
    );
  });
});
