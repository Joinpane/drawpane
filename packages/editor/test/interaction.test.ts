/**
 * Direct manipulation, the way people do it: pointer and wheel input
 * through `Interaction`, checked against where things end up.
 */
import { type NodeRecord, ROOT_ID } from "@drawpane/model";
import { describe, expect, it } from "vitest";
import { Editor } from "../src/editor";
import { Interaction, type PointerInput } from "../src/interaction";

function setup() {
  const editor = new Editor({ measurer: { width: (_f, t) => t.length * 8 }, clientId: "t" });
  editor.state.set({ role: "editor", viewport: { width: 1200, height: 800 } });
  editor.doc.apply([
    { op: "create", id: "p", type: "page", parent: ROOT_ID, key: "a0", props: {} },
  ]);
  editor.setPage("p");
  return { editor, ix: new Interaction(editor) };
}

const at = (x: number, y: number, mods: Partial<PointerInput> = {}): PointerInput => ({
  screen: { x, y },
  button: 0,
  shift: false,
  alt: false,
  mod: false,
  clicks: 1,
  ...mods,
});

const box = (editor: Editor, id: string) => {
  const p = (editor.doc.get(id) as NodeRecord).props;
  return { x: p.x, y: p.y };
};

describe("Alt-drag", () => {
  it("drops the copy exactly where it's let go, leaving the original", () => {
    const { editor, ix } = setup();
    const id = editor.createLayer(
      "rect",
      { x: 100, y: 100, width: 100, height: 80 },
      "p",
    ) as string;
    editor.select([id]);
    ix.down(at(150, 140, { alt: true }));
    ix.move(at(300, 140, { alt: true }));
    ix.move(at(450, 140, { alt: true }));
    ix.up(at(450, 140, { alt: true }));
    const copy = editor.s.selection[0] as string;
    expect(copy).not.toBe(id);
    expect(box(editor, copy)).toEqual({ x: 400, y: 100 });
    expect(box(editor, id)).toEqual({ x: 100, y: 100 });
    // One undo takes the copy away.
    editor.undo();
    expect(editor.doc.has(copy)).toBe(false);
  });

  it("copies a main component as an instance where it's dropped", () => {
    const { editor, ix } = setup();
    // A card component with a small icon in its corner; the press lands on the card itself.
    const main = editor.createLayer("frame", { x: 100, y: 100, width: 100, height: 80 }, "p", {
      isComponent: true,
    }) as string;
    editor.createLayer("rect", { x: 104, y: 104, width: 10, height: 10 }, main);
    editor.select([main]);
    ix.down(at(150, 150, { alt: true }));
    ix.move(at(150, 250, { alt: true }));
    ix.move(at(150, 350, { alt: true }));
    ix.up(at(150, 350, { alt: true }));
    const instance = editor.s.selection[0] as string;
    expect((editor.doc.get(instance) as NodeRecord).props.instanceOf).toBe(main);
    expect(box(editor, instance)).toEqual({ x: 100, y: 300 });
  });

  it("keeps the 16px nudge for Duplicate (⌘D)", () => {
    const { editor } = setup();
    const id = editor.createLayer(
      "rect",
      { x: 100, y: 100, width: 100, height: 80 },
      "p",
    ) as string;
    editor.select([id]);
    editor.duplicate();
    expect(box(editor, editor.s.selection[0] as string)).toEqual({ x: 116, y: 116 });
  });
});

describe("wheel zoom", () => {
  const wheel = (deltaY: number) => ({
    deltaX: 0,
    deltaY,
    ctrlKey: true,
    metaKey: false,
    shiftKey: false,
    screen: { x: 600, y: 400 },
  });

  it("zooms a mouse wheel notch by a step, not 2.7×", () => {
    const { editor, ix } = setup();
    ix.wheel(wheel(-100));
    const zoom = editor.s.camera.zoom;
    expect(zoom).toBeGreaterThan(1.2);
    expect(zoom).toBeLessThan(1.3);
    // And back out by the same step.
    ix.wheel(wheel(100));
    expect(editor.s.camera.zoom).toBeCloseTo(1, 6);
  });

  it("follows a trackpad pinch's small deltas smoothly", () => {
    const { editor, ix } = setup();
    ix.wheel(wheel(-4));
    expect(editor.s.camera.zoom).toBeCloseTo(Math.exp(0.04), 6);
  });
});

describe("locking", () => {
  it("keeps the layer selected, so the same shortcut unlocks it", () => {
    const { editor } = setup();
    const id = editor.createLayer(
      "rect",
      { x: 100, y: 100, width: 100, height: 80 },
      "p",
    ) as string;
    editor.select([id]);
    editor.toggleLocked();
    expect((editor.doc.get(id) as NodeRecord).props.locked).toBe(true);
    expect(editor.s.selection).toEqual([id]);
    editor.toggleLocked();
    expect((editor.doc.get(id) as NodeRecord).props.locked ?? false).toBe(false);
  });

  it("offers no resize handles on a locked layer, and dragging it does nothing", () => {
    const { editor, ix } = setup();
    const id = editor.createLayer(
      "rect",
      { x: 100, y: 100, width: 100, height: 80 },
      "p",
    ) as string;
    editor.select([id]);
    editor.toggleLocked();
    // The bottom-right corner handle.
    expect(ix.handleAt({ x: 200, y: 180 })).toBeNull();
    ix.down(at(200, 180));
    ix.move(at(260, 240));
    ix.up(at(260, 240));
    const p = (editor.doc.get(id) as NodeRecord).props;
    expect([p.x, p.y, p.width, p.height]).toEqual([100, 100, 100, 80]);
  });
});

describe("text editing", () => {
  it("ends when its layer stops being the selection, so it can't get stuck", () => {
    const { editor } = setup();
    const id = editor.createLayer("text", { x: 0, y: 0, width: 10, height: 10 }, "p", {
      characters: "Hello brave new world",
    }) as string;
    editor.startTextEdit(id);
    editor.setTextSelection(6, 11);
    // Something deselects (Escape from the inspector, a click elsewhere).
    editor.select([]);
    expect(editor.s.editingText).toBeNull();
    expect(editor.s.textSelection).toBeNull();
    expect(editor.doc.has(id)).toBe(true);
  });
});
