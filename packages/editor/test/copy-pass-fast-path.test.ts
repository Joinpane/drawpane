/**
 * The copy pass's fast path (compact copies): a copy that would be written nothing isn't placed.
 * These check what it must still place, whatever it skips: a stored place gone stale, the layers
 * of a nested instance resized on its own, and copies a flow places that store a laid-out place.
 */
import { copyId, getProp, type NodeRecord, ROOT_ID } from "@drawpane/model";
import { describe, expect, it } from "vitest";
import { Editor } from "../src/editor";
import { layoutOps } from "../src/layout";

const measurer = { width: (_font: string, text: string) => text.length * 8 };

const n = (
  id: string,
  type: NodeRecord["type"],
  parent: string,
  props: NodeRecord["props"] = {},
  key = "a0",
): NodeRecord => ({ id, type, parent, key, props });

function make(nodes: NodeRecord[]) {
  const editor = new Editor({ measurer, clientId: "fast" });
  editor.doc.resetStored(nodes, "compact");
  editor.state.set({ role: "editor", viewport: { width: 1200, height: 800 } });
  editor.setPage("p");
  return editor;
}

const num = (editor: Editor, id: string, prop: "x" | "y" | "width" | "height") =>
  getProp(editor.doc.get(id)?.props ?? {}, prop);

describe("the copy pass's fast path", () => {
  it("repairs a stored place gone stale in an instance its main's size", () => {
    const instance = "i";
    const stale = copyId(instance, ["r"]);
    const editor = make([
      n("p", "page", ROOT_ID),
      n("main", "frame", "p", { isComponent: true, width: 100, height: 100 }),
      n("r", "rect", "main", { x: 10, y: 10, width: 20, height: 20 }),
      n("s", "rect", "main", { x: 60, y: 10, width: 20, height: 20 }, "a1"),
      n(instance, "frame", "p", { instanceOf: "main", x: 300, width: 100, height: 100 }, "a1"),
      // A place the file stored for the copy, though nothing makes it its own: stale.
      n(stale, "override", instance, { path: ["r"], x: 50 }),
    ]);
    expect(num(editor, stale, "x")).toBe(50);
    // An edit elsewhere in the main places the instance's copies again.
    editor.setProp(["s"], "x", 70);
    expect(num(editor, copyId(instance, ["s"]), "x")).toBe(70);
    expect(num(editor, stale, "x")).toBe(10);
    expect(editor.doc.storedReader().get(stale)?.props.x).toBeUndefined();
  });

  it("reads an unset overrides list as none, like the copy view", () => {
    const instance = "i";
    const stale = copyId(instance, ["r"]);
    const editor = make([
      n("p", "page", ROOT_ID),
      n("main", "frame", "p", { isComponent: true, width: 100, height: 100 }),
      n("r", "rect", "main", { x: 10, y: 10, width: 20, height: 20 }),
      n("s", "rect", "main", { x: 60, y: 10, width: 20, height: 20 }, "a1"),
      n(instance, "frame", "p", { instanceOf: "main", x: 300, width: 100, height: 100 }, "a1"),
      // A record that lists x as its own but unsets that list: the copy view presents no
      // overrides, so its stored x is stale and the next pass repairs it.
      n(stale, "override", instance, {
        path: ["r"],
        x: 50,
        overrides: ["x"],
        unset: ["overrides"],
      }),
    ]);
    editor.setProp(["s"], "x", 70);
    expect(num(editor, stale, "x")).toBe(10);
  });

  it("places the layers of a nested instance resized on its own", () => {
    const editor = make([
      n("p", "page", ROOT_ID),
      n("part", "frame", "p", { isComponent: true, x: 0, y: 400, width: 50, height: 50 }),
      n("c", "rect", "part", { x: 40, y: 0, width: 10, height: 10, constraintH: "end" }),
      n("main", "frame", "p", { isComponent: true, width: 200, height: 100 }, "a1"),
      n("nested", "frame", "main", { instanceOf: "part", x: 0, y: 0, width: 50, height: 50 }),
    ]);
    const instance = editor.insertInstance("main", { x: 300, y: 0 }) as string;
    const copy = editor.doc.childIds(instance)[0] as string;
    editor.resize([copy], "width", 80);
    const inner = editor.doc.childIds(copy)[0] as string;
    // Its end constraint keeps it 0 from the resized copy's right edge.
    expect(num(editor, inner, "x")).toBe(70);
    // The instance is its main's size; the nested copy in it isn't: its layer is placed there.
    editor.setProp(["c"], "x", 35);
    expect(num(editor, inner, "x")).toBe(65);
    expect(num(editor, editor.doc.childIds("nested")[0] as string, "x")).toBe(35);
  });

  it("places a layer that stores nothing in a nested instance resized on its own", () => {
    const editor = make([
      n("p", "page", ROOT_ID),
      n("part", "frame", "p", { isComponent: true, x: 0, y: 400, width: 50, height: 50 }),
      n("c", "rect", "part", { x: 40, y: 0, width: 10, height: 10 }),
      n("main", "frame", "p", { isComponent: true, width: 200, height: 100 }, "a1"),
      n("nested", "frame", "main", { instanceOf: "part", x: 0, y: 0, width: 50, height: 50 }),
    ]);
    const instance = editor.insertInstance("main", { x: 300, y: 0 }) as string;
    const copy = editor.doc.childIds(instance)[0] as string;
    editor.resize([copy], "width", 80);
    const inner = editor.doc.childIds(copy)[0] as string;
    // Pinned to the left, it stays where its main layer is, and stores nothing.
    expect(num(editor, inner, "x")).toBe(40);
    expect(editor.doc.storedReader().get(inner)).toBeUndefined();
    // Pinned to the right now: 30 further in the copy 30 wider, where it's placed though it
    // stores nothing and the instance is its main's size.
    editor.setProp(["c"], "constraintH", "end");
    expect(num(editor, inner, "x")).toBe(70);
    expect(num(editor, editor.doc.childIds("nested")[0] as string, "x")).toBe(40);
  });

  it("leaves copies a flow places where it put them, with their main layers' sizes", () => {
    const editor = make([
      n("p", "page", ROOT_ID),
      n("main", "frame", "p", {
        isComponent: true,
        layoutMode: "row",
        gap: 10,
        sizingH: "hug",
        sizingV: "hug",
        width: 50,
        height: 20,
      }),
      n("a", "rect", "main", { width: 20, height: 20 }),
      n("b", "rect", "main", { width: 20, height: 20 }, "a1"),
    ]);
    editor.commit(layoutOps(editor.doc, ["main"]));
    const instance = editor.insertInstance("main", { x: 300, y: 0 }) as string;
    const [a, b] = editor.doc.childIds(instance) as [string, string];
    editor.resize([a], "width", 40);
    // The flow stores b's place in the instance: after a's 40 and the gap.
    expect(num(editor, b, "x")).toBe(50);
    // A change in the main places the instance's copies again; b keeps the flow's place.
    editor.resize(["b"], "height", 30);
    expect(num(editor, b, "x")).toBe(50);
    expect(num(editor, b, "height")).toBe(30);
    expect(num(editor, a, "width")).toBe(40);
    expect(editor.doc.storedReader().get(b)?.props.height).toBeUndefined();
  });
});
