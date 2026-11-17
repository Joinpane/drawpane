/**
 * The editor's view of compact copies (decision 0029): copies stored as
 * their main plus what's overridden, presented as ordinary layers.
 */
import { copyId, DEFAULT_TRANSITION, getProp, type NodeRecord, ROOT_ID } from "@drawpane/model";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isInstanceRoot } from "../src/components";
import { compactCopiesDefault, type DocChange, setCompactCopiesDefault } from "../src/doc";
import { Editor } from "../src/editor";
import type { TextMeasurer } from "../src/text";

const measurer: TextMeasurer = {
  width: (font, text) => text.length * Number(font.match(/(\d+(?:\.\d+)?)px/)?.[1] ?? 16) * 0.5,
};

let previous = false;
beforeEach(() => {
  previous = compactCopiesDefault();
  setCompactCopiesDefault(true);
});
afterEach(() => setCompactCopiesDefault(previous));

function setup() {
  const editor = new Editor({ measurer, clientId: "test" });
  editor.state.set({ role: "editor" });
  editor.doc.apply([
    { op: "create", id: "p", type: "page", parent: ROOT_ID, key: "a0", props: {} },
  ]);
  editor.setPage("p");
  return editor;
}

/** An icon main, and a button main (auto layout, hugging) of a label and an icon instance. */
function makeKit(editor: Editor) {
  const icon = editor.createLayer("frame", { x: 400, y: 0, width: 16, height: 16 }, "p") as string;
  const glyph = editor.createLayer("rect", { x: 2, y: 2, width: 12, height: 12 }, icon) as string;
  editor.select([icon]);
  editor.createComponent();
  const icon2 = editor.createLayer(
    "frame",
    { x: 400, y: 40, width: 20, height: 20 },
    "p",
  ) as string;
  const dot = editor.createLayer("ellipse", { x: 0, y: 0, width: 20, height: 20 }, icon2) as string;
  editor.select([icon2]);
  editor.createComponent();
  const button = editor.createLayer("frame", { x: 0, y: 0, width: 120, height: 40 }, "p", {
    layoutMode: "row",
    gap: 8,
    paddingLeft: 12,
    paddingRight: 12,
    paddingTop: 8,
    paddingBottom: 8,
    sizingH: "hug",
    sizingV: "hug",
    fills: [{ type: "solid", color: "#ff5a1f" }],
  }) as string;
  const label = editor.createLayer("text", { x: 0, y: 0, width: 0, height: 0 }, button, {
    fontSize: 16,
  }) as string;
  editor.updateText(label, "Save");
  editor.select([button]);
  editor.createComponent();
  editor.select([]);
  const nestedIcon = insertInto(editor, icon, button);
  return { icon, glyph, icon2, dot, button, label, nestedIcon };
}

function insertInto(editor: Editor, componentId: string, parent: string): string {
  editor.select([parent]);
  const id = editor.insertInstance(componentId, { x: 0, y: 0 }) as string;
  if (editor.doc.get(id)?.parent !== parent) {
    const key = `a${editor.doc.childIds(parent).length + 1}`;
    editor.commit([{ op: "move", id, parent, key }]);
  }
  editor.select([]);
  return id;
}

const props = (editor: Editor, id: string) => editor.doc.get(id)?.props ?? {};

/** The instance's layer copying main layer `mainId` (through nesting). */
function copyIn(editor: Editor, root: string, mainId: string): NodeRecord | undefined {
  const queue = [...editor.doc.childIds(root)];
  for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
    const node = editor.doc.get(id);
    if (!node) continue;
    let source: string | null = getProp(node.props, "mirrors");
    while (source) {
      if (source === mainId) return node;
      source = getProp(props(editor, source), "mirrors");
    }
    queue.push(...editor.doc.childIds(id));
  }
  return undefined;
}

const records = (editor: Editor) => editor.doc.stored().filter((n) => n.type === "override");

describe("compact copies in the editor", () => {
  it("stores an instance as its root alone, and presents its layers with derived ids", () => {
    const editor = setup();
    const kit = makeKit(editor);
    const instance = editor.insertInstance(kit.button, { x: 0, y: 200 }) as string;
    expect(editor.doc.compactCopies).toBe(true);
    const label = copyIn(editor, instance, kit.label) as NodeRecord;
    expect(label.id).toBe(copyId(instance, [kit.label]));
    expect(getProp(label.props, "characters")).toBe("Save");
    // The icon inside: a copy of the button's own icon instance's layer, path through it.
    const glyph = copyIn(editor, instance, kit.glyph) as NodeRecord;
    const glyphInMain = copyId(kit.nestedIcon, [kit.glyph]);
    expect(glyph.id).toBe(copyId(instance, [kit.nestedIcon, glyphInMain]));
    expect(getProp(glyph.props, "mirrors")).toBe(glyphInMain);
    expect(editor.doc.ancestors(glyph.id).map((n) => n.id)).toContain(instance);
    expect(editor.doc.pageOf(glyph.id)?.id).toBe("p");
    expect(records(editor)).toEqual([]);
    const stored = editor.doc.stored().find((n) => n.id === instance) as NodeRecord;
    expect(Object.keys(stored.props).sort()).toEqual(["instanceOf", "x", "y"]);
    // Every presented layer is counted, and listed.
    expect(editor.doc.size).toBe([...editor.doc.nodes()].length);
  });

  it("edits a copy's text as an override record, and undoes and redoes it", () => {
    const editor = setup();
    const kit = makeKit(editor);
    const instance = editor.insertInstance(kit.button, { x: 0, y: 200 }) as string;
    const label = copyIn(editor, instance, kit.label) as NodeRecord;
    const before = getProp(props(editor, instance), "width");
    editor.updateText(label.id, "Save changes");
    expect(getProp(props(editor, label.id), "characters")).toBe("Save changes");
    expect(getProp(props(editor, label.id), "overrides")).toEqual(["characters"]);
    // Laid out for its own text: wider, and the hugging instance with it.
    expect(getProp(props(editor, label.id), "width")).toBeGreaterThan(
      getProp(props(editor, kit.label), "width"),
    );
    expect(getProp(props(editor, instance), "width")).toBeGreaterThan(before);
    // Two records: the text (overridden), and the icon after it, moved by layout
    // (a laid out value: stored, but not in its overrides).
    const stored = new Map(records(editor).map((r) => [r.id, r]));
    expect(stored.size).toBe(2);
    expect(stored.get(label.id)?.props.characters).toBe("Save changes");
    const icon = copyIn(editor, instance, kit.nestedIcon) as NodeRecord;
    expect(Object.keys(stored.get(icon.id)?.props ?? {}).sort()).toEqual(["path", "x"]);
    expect(getProp(props(editor, kit.label), "characters")).toBe("Save");

    editor.undo();
    expect(getProp(props(editor, label.id), "characters")).toBe("Save");
    expect(records(editor)).toEqual([]);
    expect(getProp(props(editor, instance), "width")).toBe(before);
    editor.redo();
    expect(getProp(props(editor, label.id), "characters")).toBe("Save changes");
    expect(records(editor)).toHaveLength(2);
  });

  it("shows a main's edit in every copy with no write to them, naming them in the change", () => {
    const editor = setup();
    const kit = makeKit(editor);
    const a = editor.insertInstance(kit.button, { x: 0, y: 200 }) as string;
    const b = editor.insertInstance(kit.button, { x: 0, y: 300 }) as string;
    const storedBefore = editor.doc.stored().length;
    const changes: DocChange[] = [];
    editor.doc.subscribe((change) => changes.push(change));
    editor.setProp([kit.glyph], "fills", [{ type: "solid", color: "#00ff00" }]);
    for (const root of [a, b]) {
      const glyph = copyIn(editor, root, kit.glyph) as NodeRecord;
      expect(getProp(glyph.props, "fills")).toEqual([{ type: "solid", color: "#00ff00" }]);
      expect(changes.some((c) => c.ids.has(glyph.id))).toBe(true);
    }
    expect(editor.doc.stored().length).toBe(storedBefore);
    expect(records(editor)).toEqual([]);
  });

  it("lays out again only the copies whose layout differs when a main's text changes", () => {
    const editor = setup();
    const kit = makeKit(editor);
    const plain = editor.insertInstance(kit.button, { x: 0, y: 200 }) as string;
    const own = editor.insertInstance(kit.button, { x: 0, y: 300 }) as string;
    const ownLabel = copyIn(editor, own, kit.label) as NodeRecord;
    editor.updateText(ownLabel.id, "OK");
    expect(editor.doc.layoutDiffers(own)).toBe(true);
    expect(editor.doc.layoutDiffers(plain)).toBe(false);

    editor.setProp([kit.label], "fontSize", 24);
    const mainWidth = getProp(props(editor, kit.button), "width");
    // The plain copy is its main: same size, nothing stored.
    expect(getProp(props(editor, plain), "width")).toBe(mainWidth);
    expect(editor.doc.stored().find((n) => n.id === plain)?.props.width).toBeUndefined();
    // The one with its own text measured it again at the new size.
    const label = editor.doc.get(ownLabel.id) as NodeRecord;
    expect(getProp(label.props, "fontSize")).toBe(24);
    expect(getProp(label.props, "characters")).toBe("OK");
    expect(getProp(label.props, "width")).toBe(measurer.width("24px x", "OK"));
  });

  it("swaps a nested instance, keeps the swap when the main changes, and undoes it", () => {
    const editor = setup();
    const kit = makeKit(editor);
    const instance = editor.insertInstance(kit.button, { x: 0, y: 200 }) as string;
    const nested = copyIn(editor, instance, kit.nestedIcon) as NodeRecord;
    expect(isInstanceRoot(nested)).toBe(true);
    editor.swapInstance(nested.id, kit.icon2);
    expect(getProp(props(editor, nested.id), "instanceOf")).toBe(kit.icon2);
    const kids = editor.doc.childIds(nested.id).map((id) => editor.doc.get(id) as NodeRecord);
    expect(kids.map((k) => getProp(k.props, "mirrors"))).toEqual([kit.dot]);
    expect(kids[0]?.id).toBe(copyId(instance, [kit.nestedIcon, kit.dot]));

    editor.setProp([kit.button], "gap", 4);
    expect(getProp(props(editor, nested.id), "instanceOf")).toBe(kit.icon2);
    expect(getProp(props(editor, instance), "gap")).toBe(4);

    editor.undo();
    editor.undo();
    expect(getProp(props(editor, nested.id), "instanceOf")).toBe(kit.icon);
    expect(copyIn(editor, instance, kit.glyph)).toBeDefined();
    expect(records(editor)).toEqual([]);
  });

  it("resets an instance's overrides back to its main", () => {
    const editor = setup();
    const kit = makeKit(editor);
    const instance = editor.insertInstance(kit.button, { x: 0, y: 200 }) as string;
    const label = copyIn(editor, instance, kit.label) as NodeRecord;
    editor.updateText(label.id, "Nope");
    editor.setProp([instance], "fills", [{ type: "solid", color: "#000000" }]);
    expect(records(editor)).toHaveLength(1);
    editor.select([instance]);
    editor.resetInstances();
    expect(getProp(props(editor, label.id), "characters")).toBe("Save");
    expect(getProp(props(editor, instance), "fills")).toEqual(
      getProp(props(editor, kit.button), "fills"),
    );
    expect(records(editor)).toEqual([]);
    const stored = editor.doc.stored().find((n) => n.id === instance) as NodeRecord;
    expect(Object.keys(stored.props).sort()).toEqual(["instanceOf", "x", "y"]);
  });

  it("detaches an instance into stored layers with the same ids, and undoes it", () => {
    const editor = setup();
    const kit = makeKit(editor);
    const instance = editor.insertInstance(kit.button, { x: 0, y: 200 }) as string;
    const label = copyIn(editor, instance, kit.label) as NodeRecord;
    editor.updateText(label.id, "Mine");
    const look = [...editor.doc.childIds(instance)].map((id) => editor.doc.get(id));
    editor.select([instance]);
    editor.detachInstances();
    expect(getProp(props(editor, instance), "instanceOf")).toBeNull();
    const stored = new Map(editor.doc.stored().map((n) => [n.id, n]));
    expect(stored.get(label.id)?.type).toBe("text");
    expect(getProp(props(editor, label.id), "mirrors")).toBeNull();
    expect(getProp(props(editor, label.id), "characters")).toBe("Mine");
    expect(records(editor)).toEqual([]);
    // The icon inside stays an instance of its own, stored compact.
    const nested = editor.doc.childIds(instance).find((id) => isInstanceRoot(editor.doc.get(id)));
    expect(nested && stored.get(nested)?.props.instanceOf).toBe(kit.icon);
    editor.setProp([kit.label], "fontSize", 30);
    expect(getProp(props(editor, label.id), "fontSize")).toBe(16);

    editor.undo();
    editor.undo();
    expect(getProp(props(editor, instance), "instanceOf")).toBe(kit.button);
    expect([...editor.doc.childIds(instance)].map((id) => editor.doc.get(id))).toEqual(look);
    expect(records(editor)).toHaveLength(1);
    expect(editor.doc.stored().some((n) => n.id === label.id && n.type === "text")).toBe(false);
  });

  it("keeps instances of a deleted main as they were, and takes them back on undo", () => {
    const editor = setup();
    const kit = makeKit(editor);
    const instance = editor.insertInstance(kit.icon2, { x: 0, y: 200 }) as string;
    const dot = copyIn(editor, instance, kit.dot) as NodeRecord;
    editor.select([kit.icon2]);
    editor.deleteSelection();
    expect(editor.doc.has(kit.icon2)).toBe(false);
    expect(editor.doc.get(dot.id)?.parent).toBe(instance);
    expect(editor.doc.stored().some((n) => n.id === dot.id)).toBe(true);
    editor.undo();
    expect(editor.doc.has(kit.icon2)).toBe(true);
    expect(editor.doc.stored().some((n) => n.id === dot.id)).toBe(false);
    expect(editor.doc.get(dot.id)?.props.mirrors).toBe(kit.dot);
  });

  it("refuses to delete, move or add layers inside a copy", () => {
    const editor = setup();
    const kit = makeKit(editor);
    const instance = editor.insertInstance(kit.button, { x: 0, y: 200 }) as string;
    const label = copyIn(editor, instance, kit.label) as NodeRecord;
    expect(editor.commit([{ op: "delete", id: label.id }])).toBe(false);
    expect(editor.commit([{ op: "move", id: label.id, parent: "p", key: "a9" }])).toBe(false);
    expect(
      editor.commit([
        { op: "create", id: "r1", type: "rect", parent: instance, key: "a9", props: {} },
      ]),
    ).toBe(false);
    expect(editor.doc.get(label.id)?.parent).toBe(instance);
  });

  it("changes a main's structure in every copy", () => {
    const editor = setup();
    const kit = makeKit(editor);
    const instance = editor.insertInstance(kit.button, { x: 0, y: 200 }) as string;
    const badge = editor.createLayer(
      "rect",
      { x: 0, y: 0, width: 6, height: 6 },
      kit.button,
    ) as string;
    const copy = copyIn(editor, instance, badge) as NodeRecord;
    expect(copy.id).toBe(copyId(instance, [badge]));
    expect(editor.doc.childIds(instance)).toContain(copy.id);
    expect(getProp(props(editor, instance), "width")).toBe(
      getProp(props(editor, kit.button), "width"),
    );
    editor.select([badge]);
    editor.deleteSelection();
    expect(editor.doc.has(copy.id)).toBe(false);
    expect(editor.doc.childIds(instance)).not.toContain(copy.id);
  });
});

describe("a saved version or a library shown in the compact form", () => {
  // `loadStatic` converts a snapshot stored materialized when the open file is compact. It does
  // so with the room's converter, so it shows what the room would store for it.
  it("keeps a prototype link to a copy, renamed to the copy's derived id", () => {
    const nodes: NodeRecord[] = [
      { id: "P", type: "page", parent: ROOT_ID, key: "a0", props: {} },
      { id: "M", type: "frame", parent: "P", key: "a0", props: { isComponent: true } },
      { id: "F", type: "frame", parent: "M", key: "a0", props: {} },
      { id: "I", type: "frame", parent: "P", key: "a1", props: { instanceOf: "M" } },
      { id: "C", type: "frame", parent: "I", key: "a0", props: { mirrors: "F" } },
      {
        id: "B",
        type: "rect",
        parent: "P",
        key: "a2",
        props: {
          reactions: [
            {
              id: "Reaction",
              trigger: { type: "tap" },
              action: { type: "navigate", to: "C" },
              transition: DEFAULT_TRANSITION,
            },
          ],
        },
      },
    ];
    const editor = new Editor({ measurer, clientId: "test" });
    editor.loadStatic(nodes, "materialized", "compact");
    const action = editor.doc.get("B")?.props.reactions?.[0]?.action;
    expect(action && "to" in action ? action.to : null).toBe(copyId("I", ["F"]));
    expect(editor.doc.has(copyId("I", ["F"]))).toBe(true);
  });

  it("keeps the drawing order of siblings that share a key", () => {
    // The copies' ids sort the other way round from their main layers': built, they'd draw in
    // the main's order, so the instance is detached and keeps its own.
    const nodes: NodeRecord[] = [
      { id: "P", type: "page", parent: ROOT_ID, key: "a0", props: {} },
      { id: "M", type: "frame", parent: "P", key: "a0", props: { isComponent: true } },
      { id: "A", type: "rect", parent: "M", key: "a5", props: { name: "red" } },
      { id: "Z", type: "rect", parent: "M", key: "a5", props: { name: "blue" } },
      { id: "I", type: "frame", parent: "P", key: "a1", props: { instanceOf: "M" } },
      { id: "zCopy", type: "rect", parent: "I", key: "a5", props: { name: "red", mirrors: "A" } },
      { id: "aCopy", type: "rect", parent: "I", key: "a5", props: { name: "blue", mirrors: "Z" } },
    ];
    const editor = new Editor({ measurer, clientId: "test" });
    editor.loadStatic(nodes, "materialized", "compact");
    const drawn = editor.doc.childIds("I").map((id) => editor.doc.get(id)?.props.name);
    expect(drawn).toEqual(["blue", "red"]);
  });
});
