/**
 * Alt-hover measuring, the way it's used: with a layer selected, hold Alt and
 * rest the pointer on something; the distances go to the layer at the
 * selection's level of the tree (measureTarget), like Figma.
 */
import { ROOT_ID } from "@drawpane/model";
import { describe, expect, it } from "vitest";
import { Editor } from "../src/editor";
import { measureTarget } from "../src/hit";
import { Interaction, type PointerInput } from "../src/interaction";
import { measureLines } from "../src/overlay";

const at = (x: number, y: number, mods: Partial<PointerInput> = {}): PointerInput => ({
  screen: { x, y },
  button: 0,
  shift: false,
  alt: false,
  mod: false,
  clicks: 1,
  ...mods,
});

/**
 * A switch component set, as in the screenshots:
 *
 *   switch (0,0 800×130)
 *   ├ state=off (40,40 310×50)
 *   │ ├ toggle (a group: knob and track, 40,40 90×50)
 *   │ └ Label (150,58 190×14)
 *   └ state=on (440,40 310×50)
 *     └ On label (550,58 190×14)
 *   Other (900,0 200×200), another top-level frame
 */
function setup() {
  const editor = new Editor({ measurer: { width: (_f, t) => t.length * 8 }, clientId: "t" });
  editor.state.set({ role: "editor", viewport: { width: 1400, height: 800 } });
  editor.doc.apply([
    { op: "create", id: "p", type: "page", parent: ROOT_ID, key: "a0", props: {} },
  ]);
  editor.setPage("p");
  const layer = (...args: Parameters<Editor["createLayer"]>) =>
    editor.createLayer(...args) as string;
  const sw = layer("frame", { x: 0, y: 0, width: 800, height: 130 }, "p", { name: "switch" });
  const off = layer("frame", { x: 40, y: 40, width: 310, height: 50 }, sw, { name: "state=off" });
  const knob = layer("ellipse", { x: 40, y: 40, width: 50, height: 50 }, off, { name: "Knob" });
  const track = layer("rect", { x: 40, y: 40, width: 90, height: 50 }, off, { name: "Track" });
  editor.select([knob, track]);
  editor.group({ name: "toggle" });
  const toggle = editor.s.selection[0] as string;
  const label = layer("rect", { x: 150, y: 58, width: 190, height: 14 }, off, { name: "Label" });
  const on = layer("frame", { x: 440, y: 40, width: 310, height: 50 }, sw, { name: "state=on" });
  const onLabel = layer("rect", { x: 550, y: 58, width: 190, height: 14 }, on, {
    name: "On label",
  });
  const other = layer("frame", { x: 900, y: 0, width: 200, height: 200 }, "p", { name: "Other" });
  editor.select([label]);
  return { editor, ix: new Interaction(editor), sw, off, toggle, knob, label, on, onLabel, other };
}

/** Alt-hovers a point, and names what's measured to (null: nothing). */
function measuring(editor: Editor, ix: Interaction, x: number, y: number, mod = false) {
  ix.move(at(x, y, { alt: true, mod }));
  if (!editor.s.measure) return "not measuring";
  return editor.s.hover ? (editor.doc.get(editor.s.hover)?.props.name ?? editor.s.hover) : null;
}

describe("what Alt-hover measures to", () => {
  it("is the parent, or the parent's parent, on their bare area", () => {
    const { editor, ix } = setup();
    expect(measuring(editor, ix, 200, 86)).toBe("state=off");
    expect(measuring(editor, ix, 10, 10)).toBe("switch");
  });

  it("is a sibling as a whole, not the layer inside it", () => {
    const { editor, ix } = setup();
    expect(measuring(editor, ix, 60, 65)).toBe("toggle");
    // ⌘ measures to the exact layer (the track is on top of the knob).
    expect(measuring(editor, ix, 60, 65, true)).toBe("Track");
  });

  it("is an ancestor's sibling as a whole, and another top-level frame", () => {
    const { editor, ix } = setup();
    expect(measuring(editor, ix, 600, 65)).toBe("state=on");
    expect(measuring(editor, ix, 445, 45)).toBe("state=on");
    expect(measuring(editor, ix, 600, 65, true)).toBe("On label");
    expect(measuring(editor, ix, 1000, 100)).toBe("Other");
  });

  it("is nothing over the selection itself or the empty canvas", () => {
    const { editor, ix } = setup();
    expect(measuring(editor, ix, 200, 65)).toBeNull();
    expect(measuring(editor, ix, 850, 400)).toBeNull();
  });

  it("is a child of the selection, from inside it", () => {
    const { editor, ix, off } = setup();
    editor.select([off]);
    expect(measuring(editor, ix, 60, 65)).toBe("toggle");
    expect(measuring(editor, ix, 200, 65)).toBe("Label");
  });

  it("follows Alt pressed and let go with the pointer still, and stops when it leaves", () => {
    const { editor, ix, off } = setup();
    ix.move(at(200, 86));
    expect(editor.s.measure).toBe(false);
    ix.modifiers({ alt: true, mod: false });
    expect(editor.s.measure).toBe(true);
    expect(editor.s.hover).toBe(off);
    ix.modifiers({ alt: false, mod: false });
    expect(editor.s.measure).toBe(false);
    ix.modifiers({ alt: true, mod: false });
    ix.leave();
    expect(editor.s.measure).toBe(false);
    expect(editor.s.hover).toBeNull();
  });

  it("needs a selection", () => {
    const { editor, ix } = setup();
    editor.select([]);
    ix.move(at(345, 45, { alt: true }));
    expect(editor.s.measure).toBe(false);
  });

  it("measures to an auto layout parent from its padding, with Layout X-ray on", () => {
    const editor = new Editor({ measurer: { width: (_f, t) => t.length * 8 }, clientId: "t" });
    editor.state.set({ role: "editor", viewport: { width: 1200, height: 800 } });
    editor.doc.apply([
      { op: "create", id: "p", type: "page", parent: ROOT_ID, key: "a0", props: {} },
    ]);
    editor.setPage("p");
    const row = editor.createLayer("frame", { x: 0, y: 0, width: 300, height: 100 }, "p", {
      layoutMode: "row",
      paddingTop: 20,
      paddingLeft: 20,
    }) as string;
    const child = editor.createLayer("rect", { x: 0, y: 0, width: 50, height: 50 }, row) as string;
    editor.select([child]);
    editor.state.set({ xray: true });
    const ix = new Interaction(editor);
    // The top padding, which X-ray can drag: still measured to.
    expect(measuring(editor, ix, 200, 10)).toBe(editor.doc.get(row)?.props.name);
    expect(ix.cursor).toBe("ns-resize");
  });
});

describe("measureTarget", () => {
  it("handles layers that are gone", () => {
    const { editor, label } = setup();
    expect(measureTarget(editor.scene, "p", "missing", [label], false)).toBeNull();
    expect(measureTarget(editor.scene, "p", label, [], false)).toBeNull();
  });
});

describe("measureLines", () => {
  const rect = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });

  it("measures out to every side of a container, through the selection's middle", () => {
    const lines = measureLines(rect(150, 58, 190, 14), rect(40, 40, 310, 50));
    expect(lines.map((l) => l.length)).toEqual([110, 10, 18, 18]);
    expect(lines[0]).toMatchObject({ from: { x: 40, y: 65 }, to: { x: 150, y: 65 } });
  });

  it("measures in to a layer inside the selection the same way", () => {
    expect(measureLines(rect(40, 40, 310, 50), rect(40, 40, 90, 50)).map((l) => l.length)).toEqual([
      220,
    ]);
  });

  it("measures across the gap to a layer beside it, through what they share", () => {
    const [line] = measureLines(rect(150, 58, 190, 14), rect(440, 40, 310, 50));
    expect(line).toEqual({ from: { x: 340, y: 65 }, to: { x: 440, y: 65 }, length: 100 });
  });

  it("measures both gaps to a layer off at a diagonal, leaving touching sides out", () => {
    const lines = measureLines(rect(0, 0, 100, 100), rect(150, 130, 50, 50));
    expect(lines.map((l) => l.length)).toEqual([50, 30]);
    expect(measureLines(rect(0, 0, 100, 100), rect(100, 0, 50, 50))).toEqual([]);
  });
});
