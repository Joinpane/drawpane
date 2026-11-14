import { getProp, type Op, ROOT_ID } from "@drawpane/model";
import { beforeEach, describe, expect, it } from "vitest";
import { Editor } from "../src/editor";
import type { TextMeasurer } from "../src/text";

/** Every character is half the font size wide; deterministic in Node. */
const measurer: TextMeasurer = {
  width: (font, text) => {
    const size = Number(font.match(/(\d+(?:\.\d+)?)px/)?.[1] ?? 16);
    return text.length * size * 0.5;
  },
};

function makeEditor() {
  const editor = new Editor({ measurer, clientId: "test" });
  editor.state.set({ role: "editor" });
  editor.doc.apply([
    { op: "create", id: "p", type: "page", parent: ROOT_ID, key: "a0", props: { name: "Page 1" } },
  ]);
  editor.setPage("p");
  return editor;
}

const props = (editor: Editor, id: string) => editor.doc.get(id)?.props ?? {};

describe("Editor", () => {
  let editor: Editor;
  beforeEach(() => {
    editor = makeEditor();
  });

  it("creates layers with names, defaults and page coordinates", () => {
    const a = editor.createLayer("rect", { x: 10, y: 20, width: 30, height: 40 }, "p");
    const b = editor.createLayer("rect", { x: 0, y: 0, width: 5, height: 5 }, "p");
    expect(props(editor, a as string)).toMatchObject({
      name: "Rectangle 1",
      x: 10,
      y: 20,
      width: 30,
      height: 40,
    });
    expect(props(editor, b as string).name).toBe("Rectangle 2");
    expect(editor.doc.childIds("p")).toEqual([a, b]);
  });

  it("converts coordinates into a frame's space, rotation included", () => {
    const frame = editor.createLayer(
      "frame",
      { x: 100, y: 100, width: 200, height: 200 },
      "p",
    ) as string;
    const rect = editor.createLayer(
      "rect",
      { x: 150, y: 120, width: 10, height: 10 },
      frame,
    ) as string;
    expect(props(editor, rect)).toMatchObject({ x: 50, y: 20 });
    // Moving out of the frame keeps the layer in place on the page.
    editor.commit(editor.reparentOps(rect, "p", editor.topKey("p")));
    expect(props(editor, rect)).toMatchObject({ x: 150, y: 120 });
    // Into a rotated frame: on-screen position and angle are preserved.
    editor.setProp([frame], "rotation", 90);
    const before = editor.scene.corners(rect);
    editor.commit(editor.reparentOps(rect, frame, editor.topKey(frame)));
    const after = editor.scene.corners(rect);
    expect(getProp(props(editor, rect), "rotation")).toBe(-90);
    for (let i = 0; i < 4; i++) {
      const a = before?.[i];
      const b = after?.find(
        (p) => Math.abs(p.x - (a?.x ?? 0)) < 0.01 && Math.abs(p.y - (a?.y ?? 0)) < 0.01,
      );
      expect(b).toBeDefined();
    }
  });

  it("undoes and redoes as single steps, including gestures", () => {
    const id = editor.createLayer("rect", { x: 0, y: 0, width: 10, height: 10 }, "p") as string;
    editor.beginGesture("Move");
    for (let x = 1; x <= 5; x++) editor.commit([{ op: "set", id, prop: "x", value: x }]);
    editor.endGesture();
    expect(props(editor, id).x).toBe(5);
    editor.undo();
    expect(props(editor, id).x).toBe(0);
    editor.redo();
    expect(props(editor, id).x).toBe(5);
    editor.undo();
    editor.undo();
    expect(editor.doc.has(id)).toBe(false);
  });

  it("groups and ungroups without moving anything", () => {
    const a = editor.createLayer("rect", { x: 0, y: 0, width: 10, height: 10 }, "p") as string;
    const b = editor.createLayer("ellipse", { x: 50, y: 50, width: 10, height: 10 }, "p") as string;
    editor.select([b, a]);
    editor.group();
    const group = editor.s.selection[0] as string;
    expect(editor.doc.get(group)?.type).toBe("group");
    expect(editor.doc.childIds(group)).toEqual([a, b]);
    expect(editor.scene.bounds(group)).toEqual({ x: 0, y: 0, width: 60, height: 60 });
    editor.ungroup();
    expect(editor.doc.has(group)).toBe(false);
    expect(editor.doc.childIds("p")).toEqual([a, b]);
    expect(props(editor, b)).toMatchObject({ x: 50, y: 50 });
  });

  it("groups inside a frame without moving anything", () => {
    const frame = editor.createLayer(
      "frame",
      { x: 100, y: 100, width: 200, height: 200 },
      "p",
    ) as string;
    const a = editor.createLayer(
      "rect",
      { x: 150, y: 150, width: 10, height: 10 },
      frame,
    ) as string;
    const before = editor.scene.bounds(a);
    editor.select([a]);
    editor.group();
    expect(editor.doc.get(a)?.parent).toBe(editor.s.selection[0]);
    expect(editor.scene.bounds(a)).toEqual(before);
  });

  it("groups or frames layers from different parents in the topmost one's parent, nothing moving", () => {
    // A layer inside a frame, and one beside the frame on the page, above it.
    const frame = editor.createLayer(
      "frame",
      { x: 100, y: 100, width: 200, height: 200 },
      "p",
    ) as string;
    const inner = editor.createLayer(
      "rect",
      { x: 150, y: 150, width: 10, height: 10 },
      frame,
    ) as string;
    const beside = editor.createLayer(
      "rect",
      { x: 400, y: 0, width: 20, height: 20 },
      "p",
    ) as string;
    const where = () => [editor.scene.bounds(inner), editor.scene.bounds(beside)];
    const before = where();
    for (const wrap of [() => editor.group(), () => editor.frameSelection()]) {
      editor.select([inner, beside]);
      wrap();
      const made = editor.s.selection[0] as string;
      // On the page, just above `beside` (the topmost), holding both in their order.
      expect(editor.doc.get(made)?.parent).toBe("p");
      expect(editor.doc.childIds("p")).toEqual([frame, made]);
      expect(editor.doc.childIds(made)).toEqual([inner, beside]);
      expect(where()).toEqual(before);
      editor.undo();
      expect(editor.doc.get(inner)?.parent).toBe(frame);
    }
  });

  it("keeps a layer mirrored when it leaves a flipped frame", () => {
    // A frame flipped horizontally, holding a layer off to its left side, rotated a little.
    const frame = editor.createLayer(
      "frame",
      { x: 0, y: 0, width: 200, height: 100 },
      "p",
    ) as string;
    const inner = editor.createLayer("rect", { x: 10, y: 20, width: 40, height: 30 }, frame, {
      rotation: 15,
    }) as string;
    editor.select([frame]);
    editor.flip("horizontal");
    const before = editor.scene.corners(inner);
    editor.select([frame]);
    editor.ungroup();
    expect(editor.doc.get(inner)?.parent).toBe("p");
    // Exactly where it was, corner for corner: still mirrored.
    const after = editor.scene.corners(inner);
    after?.forEach((p, i) => {
      expect(p.x).toBeCloseTo(before?.[i]?.x ?? Number.NaN, 2);
      expect(p.y).toBeCloseTo(before?.[i]?.y ?? Number.NaN, 2);
    });
    expect(props(editor, inner).flipX).toBe(true);
  });

  it("wraps a selection in an auto-layout frame that hugs it, keeping the space between", () => {
    const a = editor.createLayer("rect", { x: 100, y: 100, width: 40, height: 20 }, "p") as string;
    const b = editor.createLayer("rect", { x: 200, y: 100, width: 60, height: 20 }, "p") as string;
    editor.select([b, a]);
    editor.frameSelection(true);
    const frame = editor.s.selection[0] as string;
    // 60px apart: that's the gap, so nothing moves.
    expect(props(editor, frame)).toMatchObject({
      layoutMode: "row",
      gap: 60,
      width: 160,
      height: 20,
    });
    expect(editor.doc.childIds(frame)).toEqual([a, b]);
    expect(props(editor, b).x).toBe(100);
    // Changing the gap re-runs layout in the same commit.
    editor.setProp([frame], "gap", 20);
    expect(props(editor, frame).width).toBe(120);
    expect(props(editor, b).x).toBe(60);
  });

  it("turns on auto layout in a frame keeping its spacing, padding and order on screen", () => {
    // A card: three rows 12px apart, 16px in from the edges, made bottom row first.
    const card = editor.createLayer(
      "frame",
      { x: 0, y: 0, width: 200, height: 152 },
      "p",
    ) as string;
    const rows = [2, 1, 0].map(
      (i) =>
        editor.createLayer(
          "rect",
          { x: 16, y: 16 + i * 44, width: 168, height: 32 },
          card,
        ) as string,
    );
    const before = rows.map((id) => [props(editor, id).x, props(editor, id).y]);
    editor.setLayoutMode([card], "column");
    expect(props(editor, card)).toMatchObject({
      layoutMode: "column",
      gap: 12,
      paddingTop: 16,
      paddingLeft: 16,
      paddingRight: 16,
      paddingBottom: 16,
    });
    // Nothing moved, and the flow runs top to bottom as they're seen.
    expect(rows.map((id) => [props(editor, id).x, props(editor, id).y])).toEqual(before);
    expect(editor.doc.childIds(card)).toEqual([...rows].reverse());
  });

  it("sizes text to its content", () => {
    const id = editor.createLayer("text", { x: 0, y: 0, width: 0, height: 0 }, "p", {
      fontSize: 20,
    }) as string;
    editor.updateText(id, "Hello");
    expect(props(editor, id)).toMatchObject({ width: 50, height: 25 });
    editor.updateText(id, "Hello\nthere you");
    expect(props(editor, id)).toMatchObject({ width: 90, height: 50 });
  });

  it("copies and pastes subtrees with fresh ids, in place", () => {
    const frame = editor.createLayer(
      "frame",
      { x: 100, y: 100, width: 100, height: 100 },
      "p",
    ) as string;
    editor.createLayer("rect", { x: 110, y: 110, width: 10, height: 10 }, frame);
    editor.select([frame]);
    const data = editor.copy() as string;
    editor.select([]);
    expect(editor.paste(data)).toBe(true);
    const copy = editor.s.selection[0] as string;
    expect(copy).not.toBe(frame);
    expect(props(editor, copy)).toMatchObject({ x: 100, y: 100 });
    expect(editor.doc.childIds(copy)).toHaveLength(1);
    expect(editor.paste("not json")).toBe(false);
  });

  it("reorders layers", () => {
    const ids = [0, 1, 2].map(
      (i) => editor.createLayer("rect", { x: i, y: 0, width: 1, height: 1 }, "p") as string,
    );
    editor.select([ids[0] as string]);
    editor.reorder("front");
    expect(editor.doc.childIds("p")).toEqual([ids[1], ids[2], ids[0]]);
    editor.reorder("backward");
    expect(editor.doc.childIds("p")).toEqual([ids[1], ids[0], ids[2]]);
    editor.reorder("back");
    expect(editor.doc.childIds("p")).toEqual([ids[0], ids[1], ids[2]]);
  });

  it("refuses edits from viewers", () => {
    editor.state.set({ role: "viewer" });
    expect(editor.createLayer("rect", { x: 0, y: 0, width: 1, height: 1 }, "p")).toBeNull();
    const ops: Op[] = [{ op: "set", id: "p", prop: "name", value: "x" }];
    expect(editor.commit(ops)).toBe(false);
  });

  it("drops selection of layers a teammate deleted", () => {
    const id = editor.createLayer("rect", { x: 0, y: 0, width: 1, height: 1 }, "p") as string;
    editor.select([id]);
    editor.doc.apply([{ op: "delete", id }]);
    expect(editor.s.selection).toEqual([]);
  });
});
