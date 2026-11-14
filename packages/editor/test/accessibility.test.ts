import {
  DEFAULT_TRANSITION,
  getProp,
  type NodeRecord,
  type Reaction,
  ROOT_ID,
} from "@drawpane/model";
import { describe, expect, it } from "vitest";
import { MIN_TAP_TARGET, tapTargetIssue } from "../src/accessibility";
import { Editor } from "../src/editor";

/** A tap that goes back: what makes a layer something people tap. */
const TAP: Reaction[] = [
  {
    id: "tapback000000000",
    trigger: { type: "tap" },
    action: { type: "back" },
    transition: DEFAULT_TRANSITION,
  },
];

function setup(boardWidth = 393) {
  const editor = new Editor({ measurer: { width: (_f, t) => t.length * 6 }, clientId: "t" });
  editor.state.set({ role: "editor" });
  editor.doc.apply([
    { op: "create", id: "p", type: "page", parent: ROOT_ID, key: "a0", props: {} },
  ]);
  editor.setPage("p");
  editor.setViewport(1600, 1200);
  const board = editor.createLayer(
    "frame",
    { x: 0, y: 0, width: boardWidth, height: 852 },
    "p",
  ) as string;
  return { editor, board };
}
const props = (editor: Editor, id: string) => (editor.doc.get(id) as NodeRecord).props;

describe("tap targets", () => {
  it("flags a tapped layer smaller than 44 × 44 on a phone board, and grows it around its centre", () => {
    const { editor, board } = setup();
    const icon = editor.createLayer("rect", { x: 100, y: 800, width: 22, height: 22 }, board, {
      reactions: TAP,
    }) as string;
    expect(tapTargetIssue(editor, icon)).toEqual({
      width: 22,
      height: 22,
      min: MIN_TAP_TARGET,
      growable: true,
    });
    editor.growTapTarget(icon);
    const p = props(editor, icon);
    expect([getProp(p, "x"), getProp(p, "y"), getProp(p, "width"), getProp(p, "height")]).toEqual([
      89, 789, 44, 44,
    ]);
    expect(tapTargetIssue(editor, icon)).toBeNull();
    // One undo puts it back.
    editor.undo();
    expect(getProp(props(editor, icon), "width")).toBe(22);
  });

  it("says nothing for a layer nobody taps, on a desktop board, or once it's big enough", () => {
    const { editor, board } = setup();
    const plain = editor.createLayer(
      "rect",
      { x: 10, y: 10, width: 20, height: 20 },
      board,
    ) as string;
    expect(tapTargetIssue(editor, plain)).toBeNull();
    const roomy = editor.createLayer("rect", { x: 10, y: 50, width: 48, height: 44 }, board, {
      reactions: TAP,
    }) as string;
    expect(tapTargetIssue(editor, roomy)).toBeNull();
    const desktop = setup(1440);
    const small = desktop.editor.createLayer(
      "rect",
      { x: 10, y: 10, width: 20, height: 20 },
      desktop.board,
      { reactions: TAP },
    ) as string;
    expect(tapTargetIssue(desktop.editor, small)).toBeNull();
  });

  it("in auto layout, grows the size only (the layout places it), and fixes it so Hug can't shrink it", () => {
    const { editor, board } = setup();
    const bar = editor.createLayer("frame", { x: 0, y: 800, width: 393, height: 52 }, board, {
      layoutMode: "row",
      sizingV: "hug",
    }) as string;
    const tab = editor.createLayer("frame", { x: 0, y: 0, width: 30, height: 30 }, bar, {
      reactions: TAP,
      sizingH: "hug",
    }) as string;
    expect(tapTargetIssue(editor, tab)?.growable).toBe(true);
    editor.growTapTarget(tab);
    const p = props(editor, tab);
    expect([getProp(p, "width"), getProp(p, "height"), getProp(p, "sizingH")]).toEqual([
      44,
      44,
      "fixed",
    ]);
  });

  it("can't grow text or a group: their size follows what's in them", () => {
    const { editor, board } = setup();
    const label = editor.createLayer("text", { x: 10, y: 10, width: 30, height: 16 }, board, {
      characters: "Skip",
      reactions: TAP,
    }) as string;
    expect(tapTargetIssue(editor, label)?.growable).toBe(false);
  });
});
