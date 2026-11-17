import { compactByInstance, getProp, type NodeRecord, ROOT_ID } from "@drawpane/model";
import { beforeEach, describe, expect, it } from "vitest";
import {
  canMoveInto,
  instancesOf,
  isInstanceRoot,
  isMainComponent,
  pinInstances,
  propagationOps,
  swapTargets,
} from "../src/components";
import { Doc } from "../src/doc";
import { Editor } from "../src/editor";
import { layoutOps } from "../src/layout";
import type { TextMeasurer } from "../src/text";

const measurer: TextMeasurer = {
  width: (font, text) => text.length * Number(font.match(/(\d+(?:\.\d+)?)px/)?.[1] ?? 16) * 0.5,
};

function setup() {
  const editor = new Editor({ measurer, clientId: "test" });
  editor.state.set({ role: "editor" });
  editor.doc.apply([
    { op: "create", id: "p", type: "page", parent: ROOT_ID, key: "a0", props: {} },
  ]);
  editor.setPage("p");
  return editor;
}

/** A button component: an auto-layout frame with a label and an icon square. */
function makeButton(editor: Editor) {
  const frame = editor.createLayer("frame", { x: 0, y: 0, width: 120, height: 40 }, "p", {
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
  const icon = editor.createLayer("rect", { x: 0, y: 0, width: 16, height: 16 }, frame) as string;
  const label = editor.createLayer("text", { x: 0, y: 0, width: 0, height: 0 }, frame, {
    fontSize: 16,
  }) as string;
  editor.updateText(label, "Save");
  editor.select([frame]);
  editor.createComponent();
  return { frame, icon, label };
}

const props = (editor: Editor, id: string) => editor.doc.get(id)?.props ?? {};

/** The instance's layer that mirrors main layer `mainId`. */
function mirrorOf(editor: Editor, instanceId: string, mainId: string): NodeRecord | undefined {
  const stack = [...editor.doc.childIds(instanceId)];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    const node = editor.doc.get(id);
    if (node && getProp(node.props, "mirrors") === mainId) return node;
    stack.push(...editor.doc.childIds(id));
  }
  return undefined;
}

describe("components and instances", () => {
  let editor: Editor;
  let button: ReturnType<typeof makeButton>;
  let instance: string;

  beforeEach(() => {
    editor = setup();
    button = makeButton(editor);
    editor.select([button.frame]);
    editor.duplicate();
    instance = editor.s.selection[0] as string;
  });

  it("keeps the instances index up to date edit by edit, as reading the file afresh would", () => {
    // Read once, then caught up from the change log after each edit.
    instancesOf(editor.doc, button.frame);
    const fresh = (componentId: string) => {
      const copy = new Doc();
      copy.resetStored(editor.doc.stored());
      return [...instancesOf(copy, componentId)].sort();
    };
    const same = (componentId: string) =>
      expect([...instancesOf(editor.doc, componentId)].sort()).toEqual(fresh(componentId));
    editor.select([instance]);
    editor.duplicate();
    const second = editor.s.selection[0] as string;
    same(button.frame);
    expect(instancesOf(editor.doc, button.frame)).toHaveLength(2);
    // Swapped for another component: it moves from one list to the other.
    const card = editor.createLayer(
      "frame",
      { x: 400, y: 0, width: 80, height: 80 },
      "p",
    ) as string;
    editor.select([card]);
    editor.createComponent();
    editor.swapInstance(second, card);
    same(button.frame);
    same(card);
    expect(instancesOf(editor.doc, card)).toEqual([second]);
    // Detached, then deleted: gone from the lists.
    editor.select([instance]);
    editor.detachInstances();
    same(button.frame);
    editor.select([second]);
    editor.deleteSelection();
    same(card);
    expect(instancesOf(editor.doc, button.frame)).toEqual([]);
    expect(instancesOf(editor.doc, card)).toEqual([]);
    // And undo brings them back.
    editor.undo();
    same(card);
    expect(instancesOf(editor.doc, card)).toEqual([second]);
  });

  it("turns a frame into a main component, and duplicating it makes an instance", () => {
    expect(isMainComponent(editor.doc.get(button.frame))).toBe(true);
    expect(isInstanceRoot(editor.doc.get(instance))).toBe(true);
    expect(getProp(props(editor, instance), "instanceOf")).toBe(button.frame);
    expect(instancesOf(editor.doc, button.frame)).toEqual([instance]);
    expect(editor.doc.childIds(instance)).toHaveLength(2);
    expect(mirrorOf(editor, instance, button.label)?.props.characters).toBe("Save");
    // The instance sits beside the main, not on top of it.
    expect(getProp(props(editor, instance), "x")).toBeGreaterThan(
      getProp(props(editor, button.frame), "width"),
    );
  });

  it("syncs main edits into instances, including auto layout and text size", () => {
    editor.setProp([button.frame], "fills", [{ type: "solid", color: "#2563eb" }]);
    expect(props(editor, instance).fills).toEqual([{ type: "solid", color: "#2563eb" }]);

    editor.updateText(button.label, "Save changes");
    const mirroredLabel = mirrorOf(editor, instance, button.label);
    expect(mirroredLabel?.props.characters).toBe("Save changes");
    // The hugging instance grew with its label, exactly like the main.
    expect(getProp(props(editor, instance), "width")).toBe(
      getProp(props(editor, button.frame), "width"),
    );
    expect(getProp(props(editor, instance), "width")).toBeGreaterThan(120);
  });

  it("keeps overrides when the main changes, and syncs everything else", () => {
    const label = mirrorOf(editor, instance, button.label) as NodeRecord;
    editor.updateText(label.id, "Cancel");
    expect(getProp(props(editor, label.id), "overrides")).toEqual(["characters"]);

    editor.updateText(button.label, "Submit");
    editor.setProp([button.label], "fontWeight", 700);
    expect(props(editor, label.id).characters).toBe("Cancel");
    expect(props(editor, label.id).fontWeight).toBe(700);
  });

  it("follows structural changes to the main: added, removed and reordered layers", () => {
    const badge = editor.createLayer(
      "ellipse",
      { x: 0, y: 0, width: 8, height: 8 },
      button.frame,
    ) as string;
    expect(mirrorOf(editor, instance, badge)).toBeDefined();

    editor.select([button.icon]);
    editor.reorder("front");
    const order = (parent: string) =>
      editor.doc.childIds(parent).map((id) => getProp(props(editor, id), "mirrors") ?? id);
    expect(order(instance)).toEqual(editor.doc.childIds(button.frame));

    editor.select([badge]);
    editor.deleteSelection();
    expect(mirrorOf(editor, instance, badge)).toBeUndefined();
    expect(editor.doc.childIds(instance)).toHaveLength(2);
  });

  it("resets overrides back to the main", () => {
    const icon = mirrorOf(editor, instance, button.icon) as NodeRecord;
    editor.setProp([icon.id], "fills", [{ type: "solid", color: "#000000" }]);
    editor.setProp([instance], "opacity", 0.5);
    editor.select([instance]);
    editor.resetInstances();
    expect(props(editor, icon.id).fills).toEqual(props(editor, button.icon).fills);
    expect(props(editor, instance).opacity).toBeUndefined();
    expect(getProp(props(editor, icon.id), "overrides")).toEqual([]);
  });

  it("undoes an instance edit back to no override", () => {
    const icon = mirrorOf(editor, instance, button.icon) as NodeRecord;
    editor.setProp([icon.id], "opacity", 0.4);
    expect(getProp(props(editor, icon.id), "overrides")).toEqual(["opacity"]);
    editor.undo();
    expect(getProp(props(editor, icon.id), "overrides")).toEqual([]);
    editor.setProp([button.icon], "opacity", 0.8);
    expect(props(editor, icon.id).opacity).toBe(0.8);
    editor.redo();
  });

  it("undoes a main edit in every instance at once", () => {
    editor.setProp([button.icon], "cornerRadius", 4);
    expect(mirrorOf(editor, instance, button.icon)?.props.cornerRadius).toBe(4);
    editor.undo();
    expect(props(editor, button.icon).cornerRadius).toBeUndefined();
    expect(mirrorOf(editor, instance, button.icon)?.props.cornerRadius).toBeUndefined();
  });

  it("detaches an instance into a plain frame that no longer follows the main", () => {
    editor.select([instance]);
    editor.detachInstances();
    expect(isInstanceRoot(editor.doc.get(instance))).toBe(false);
    editor.setProp([button.frame], "opacity", 0.2);
    expect(props(editor, instance).opacity).toBeUndefined();
    for (const id of editor.doc.childIds(instance))
      expect(getProp(props(editor, id), "mirrors")).toBeNull();
  });

  it("propagates through nested instances", () => {
    // A card component that contains an instance of the button.
    const card = editor.createLayer(
      "frame",
      { x: 0, y: 200, width: 300, height: 200 },
      "p",
    ) as string;
    editor.select([card]);
    editor.createComponent();
    editor.select([card]);
    const nested = editor.insertInstance(button.frame) as string;
    expect(editor.doc.get(nested)?.parent).toBe(card);
    editor.select([card]);
    editor.duplicate();
    const cardInstance = editor.s.selection[0] as string;
    const nestedCopy = mirrorOf(editor, cardInstance, nested) as NodeRecord;
    expect(getProp(nestedCopy.props, "instanceOf")).toBe(button.frame);

    // A change to the button reaches the button inside the card instance.
    editor.setProp([button.frame], "fills", [{ type: "solid", color: "#16a34a" }]);
    expect(props(editor, nested).fills).toEqual([{ type: "solid", color: "#16a34a" }]);
    expect(props(editor, nestedCopy.id).fills).toEqual([{ type: "solid", color: "#16a34a" }]);
  });

  it("refuses cycles, deletes inside instances, and restructuring instances", () => {
    // Dropped onto its own component, an instance would nest in itself: refused.
    const b = editor.scene.bounds(button.frame);
    expect(
      editor.insertInstance(button.frame, {
        x: (b?.x ?? 0) + (b?.width ?? 0) / 2,
        y: (b?.y ?? 0) + (b?.height ?? 0) / 2,
      }),
    ).toBeNull();
    const icon = mirrorOf(editor, instance, button.icon) as NodeRecord;
    editor.select([icon.id]);
    editor.deleteSelection();
    expect(editor.doc.has(icon.id)).toBe(true);
    editor.group();
    expect(editor.doc.get(icon.id)?.parent).toBe(instance);
  });

  it("pastes a copy of a main component as an instance", () => {
    editor.select([button.frame]);
    const data = editor.copy() as string;
    editor.select([]);
    editor.paste(data);
    const pasted = editor.s.selection[0] as string;
    expect(getProp(props(editor, pasted), "instanceOf")).toBe(button.frame);
    expect(instancesOf(editor.doc, button.frame)).toHaveLength(2);
  });

  it("pastes beside a component, never inside itself, with the component selected", () => {
    editor.select([button.frame]);
    const data = editor.copy() as string;
    // ⌘C ⌘V with the main still selected: pasting into the selection would nest it in itself.
    editor.paste(data);
    const pasted = editor.s.selection[0] as string;
    expect(getProp(props(editor, pasted), "instanceOf")).toBe(button.frame);
    expect(editor.doc.get(pasted)?.parent).toBe(editor.doc.get(button.frame)?.parent);
    // An instance pasted into the component is refused the same way.
    const inst = editor.copy() as string;
    editor.select([button.frame]);
    editor.paste(inst);
    expect(editor.doc.get(editor.s.selection[0] as string)?.parent).not.toBe(button.frame);
  });

  it("keeps instances in step with a component nested in their main", () => {
    // Make the icon inside Button a component of its own; then restyle it.
    editor.select([button.icon]);
    editor.createComponent();
    const nested = editor.s.selection[0] as string;
    const copy = mirrorOf(editor, instance, nested) as NodeRecord;
    expect(getProp(copy.props, "name")).toBe(getProp(props(editor, nested), "name"));
    editor.setProp([nested], "opacity", 0.5);
    expect(getProp(props(editor, copy.id), "opacity")).toBe(0.5);
  });

  it("offers every other component to swap an instance to, but none that would nest in itself", () => {
    // A second component, with an instance of Button inside it.
    const card = editor.createLayer("frame", { x: 400, y: 0, width: 200, height: 100 }, "p", {
      name: "Card",
    }) as string;
    editor.select([card]);
    editor.createComponent();
    const inCard = editor.insertInstance(button.frame, { x: 450, y: 50 }) as string;
    expect(editor.doc.get(inCard)?.parent).toBe(card);
    // The Button instance on the page can become a Card…
    expect(swapTargets(editor.doc, instance).map((t) => t.id)).toEqual([card]);
    // …but the one inside Card can't: Card would contain itself.
    expect(swapTargets(editor.doc, inCard)).toEqual([]);
    editor.swapInstance(instance, card);
    expect(getProp(props(editor, instance), "instanceOf")).toBe(card);
  });

  it("inserts an instance beside its component when the component is selected", () => {
    editor.select([button.frame]);
    const made = editor.insertInstance(button.frame) as string;
    expect(made).not.toBeNull();
    expect(getProp(props(editor, made), "instanceOf")).toBe(button.frame);
    expect(editor.doc.get(made)?.parent).toBe(editor.doc.get(button.frame)?.parent);
    // Just right of the main component, top-aligned with it.
    const main = editor.scene.bounds(button.frame);
    const copy = editor.scene.bounds(made);
    expect(copy?.x).toBeCloseTo((main?.x ?? 0) + (main?.width ?? 0) + 40, 2);
    expect(copy?.y).toBeCloseTo(main?.y ?? 0, 2);
  });

  it("never moves an instance into its own component, or anything into or out of an instance", () => {
    expect(canMoveInto(editor.doc, [instance], button.frame)).toBe(false);
    expect(canMoveInto(editor.doc, [button.label], instance)).toBe(false);
    // Nor out of one: its layers are its main component's.
    const copy = mirrorOf(editor, instance, button.label) as NodeRecord;
    expect(canMoveInto(editor.doc, [copy.id], "p")).toBe(false);
    const other = editor.createLayer(
      "frame",
      { x: 500, y: 0, width: 50, height: 50 },
      "p",
    ) as string;
    expect(canMoveInto(editor.doc, [instance], other)).toBe(true);
  });
});

describe("pinInstances (files made elsewhere)", () => {
  const node = (
    id: string,
    type: NodeRecord["type"],
    parent: string,
    key: string,
    props: Record<string, unknown>,
  ): NodeRecord => ({ id, type, parent, key, props: props as NodeRecord["props"] });
  /** A page with a main (a 100 × 40 button with a label) and a copy of it. */
  const file = (copy: Record<string, unknown>, extra: NodeRecord[] = []) => [
    node("p", "page", ROOT_ID, "a0", {}),
    node("main", "frame", "p", "a0", { isComponent: true, width: 100, height: 40 }),
    node("label", "rect", "main", "a0", { x: 10, y: 10, width: 80, height: 20 }),
    node("copy", "frame", "p", "a1", {
      instanceOf: "main",
      x: 0,
      y: 100,
      width: 100,
      height: 40,
      ...copy,
    }),
    node("copyLabel", "rect", "copy", "a0", {
      mirrors: "label",
      x: 10,
      y: 10,
      width: 80,
      height: 20,
    }),
    ...extra,
  ];
  const opened = (nodes: NodeRecord[]) => {
    const editor = new Editor({ measurer: { width: (_f, t) => t.length * 6 }, clientId: "t" });
    editor.doc.reset(nodes);
    editor.state.set({ role: "editor" });
    return editor;
  };

  it("lays out imported grids, and what hugs them, from their content", () => {
    // A table: a toolbar, a grid of a header row and a body row, a footer. As saved, the body
    // row is 36 tall; its button needs 28 + 8 + 8, so the grid lays it out 44 tall.
    const cellRow = { layoutMode: "row", alignItems: "center", sizingH: "fill", sizingV: "fill" };
    const pad = { paddingTop: 8, paddingRight: 8, paddingBottom: 8, paddingLeft: 8 };
    const nodes = [
      node("p", "page", ROOT_ID, "a0", {}),
      node("table", "frame", "p", "a0", {
        layoutMode: "column",
        sizingV: "hug",
        width: 200,
        height: 106,
      }),
      node("toolbar", "frame", "table", "a0", { layoutMode: "row", width: 200, height: 20 }),
      // Not where the toolbar's layout would put it: outside the grid, as saved.
      node("dot", "rect", "toolbar", "a0", { x: 50, width: 10, height: 10 }),
      node("grid", "frame", "table", "a1", {
        layoutMode: "grid",
        sizingV: "hug",
        y: 20,
        width: 200,
        height: 76,
        gridColumns: [
          { unit: "px", value: 32 },
          { unit: "fr", value: 1 },
        ],
        gridRows: [{ unit: "auto" }, { unit: "auto" }],
      }),
      node("h1", "rect", "grid", "a0", { width: 32, height: 40 }),
      node("h2", "rect", "grid", "a1", { x: 32, width: 168, height: 40, sizingH: "fill" }),
      node("b1", "frame", "grid", "a2", { ...cellRow, ...pad, y: 40, width: 32, height: 36 }),
      // A hugging chip as saved: Drawpane would hug it 32 wide, but the grid doesn't size it.
      node("chip", "frame", "b1", "a0", {
        layoutMode: "row",
        sizingH: "hug",
        sizingV: "hug",
        paddingLeft: 10,
        paddingRight: 10,
        x: 8,
        y: 4,
        width: 16,
        height: 28,
      }),
      node("icon", "rect", "chip", "a0", { x: 2, width: 12, height: 28 }),
      node("b2", "frame", "grid", "a3", {
        ...cellRow,
        ...pad,
        x: 32,
        y: 40,
        width: 168,
        height: 36,
      }),
      node("label", "rect", "b2", "a0", { x: 8, y: 8, width: 40, height: 20 }),
      node("footer", "rect", "table", "a2", { y: 96, width: 200, height: 10 }),
      // Auto layout away from any grid stays as saved too.
      node("row", "frame", "p", "a1", { layoutMode: "row", y: 200, width: 100, height: 20 }),
      node("item", "rect", "row", "a0", { x: 30, width: 10, height: 10 }),
    ];
    const out = pinInstances(nodes).nodes;
    const box = (id: string) => {
      const p = (out.find((n) => n.id === id) as NodeRecord).props;
      return [getProp(p, "x"), getProp(p, "y"), getProp(p, "width"), getProp(p, "height")];
    };
    expect(box("b1")).toEqual([0, 40, 32, 44]);
    expect(box("b2")).toEqual([32, 40, 168, 44]);
    expect(box("chip")).toEqual([8, 8, 16, 28]);
    expect(box("icon")).toEqual([2, 0, 12, 28]);
    expect(box("label")).toEqual([8, 12, 40, 20]);
    expect(box("grid")).toEqual([0, 20, 200, 84]);
    expect(box("footer")).toEqual([0, 104, 200, 10]);
    expect(box("table")).toEqual([0, 0, 200, 114]);
    expect(box("dot")).toEqual([50, 0, 10, 10]);
    expect(box("item")).toEqual([30, 0, 10, 10]);
    // As an edit lays it out again (what the grid doesn't size aside).
    const again = layoutOps(opened(out).doc, ["grid"]);
    const sized = (id: string) => !["dot", "chip", "icon"].includes(id);
    expect(again.filter((op) => op.op === "set" && sized(op.id))).toEqual([]);
  });

  it("keeps a copy as the file has it: what syncing would change is overridden", () => {
    const { nodes, pinned, detached } = pinInstances(file({ width: 160, height: 56 }));
    expect([pinned, detached]).toEqual([2, 0]);
    const copy = nodes.find((n) => n.id === "copy") as NodeRecord;
    expect(getProp(copy.props, "overrides")).toEqual(["height", "width"]);
    // Syncing with its main changes nothing now…
    const editor = opened(nodes);
    expect(propagationOps(editor.doc, ["main", "label"])).toEqual([]);
    // …and the copy still follows its main where it didn't differ.
    editor.setProp(["label"], "opacity", 0.5);
    // (With compact copies the copy layer's id is derived on the way in.)
    const copyLabel = editor.doc.resetIds.get("copyLabel") ?? "copyLabel";
    expect(getProp((editor.doc.get(copyLabel) as NodeRecord).props, "opacity")).toBe(0.5);
    expect(getProp((editor.doc.get("copy") as NodeRecord).props, "width")).toBe(160);
  });

  it("detaches a copy whose layers can't be matched to its main's, keeping every layer", () => {
    // A layer the main doesn't have (Penpot lets copies differ in structure).
    const extra = [node("badge", "rect", "copy", "a1", { x: 0, y: 0, width: 8, height: 8 })];
    const { nodes, detached } = pinInstances(file({}, extra));
    expect(detached).toBe(1);
    const props = (id: string) => (nodes.find((n) => n.id === id) as NodeRecord).props;
    expect(getProp(props("copy"), "instanceOf")).toBeNull();
    expect(getProp(props("copyLabel"), "mirrors")).toBeNull();
    // Nothing is rebuilt or lost when it opens.
    const editor = opened(nodes);
    expect(propagationOps(editor.doc, ["main", "label"])).toEqual([]);
    expect(editor.doc.childIds("copy")).toEqual(["copyLabel", "badge"]);
  });

  it("unlinks the copies of a nested instance it unlinks, so they copy it as it is now", () => {
    // A button whose icon has a layer its main doesn't (so it's unlinked), a copy of the button,
    // and a bar holding a button, with a copy of the bar: copies of copies.
    const nodes = [
      node("p", "page", ROOT_ID, "a0", {}),
      node("icon", "frame", "p", "a0", { isComponent: true, width: 16, height: 16 }),
      node("dot", "rect", "icon", "a0", { width: 4, height: 4 }),
      node("button", "frame", "p", "a1", { isComponent: true, width: 80, height: 32 }),
      node("slot", "frame", "button", "a0", { instanceOf: "icon", width: 16, height: 16 }),
      node("slotDot", "rect", "slot", "a0", { mirrors: "dot", width: 4, height: 4 }),
      node("extra", "rect", "slot", "a1", { width: 2, height: 2 }),
      node("copy", "frame", "p", "a2", { instanceOf: "button", width: 80, height: 32 }),
      node("copySlot", "frame", "copy", "a0", {
        instanceOf: "icon",
        mirrors: "slot",
        width: 16,
        height: 16,
      }),
      node("copyDot", "rect", "copySlot", "a0", { mirrors: "slotDot", width: 4, height: 4 }),
      node("copyExtra", "rect", "copySlot", "a1", { mirrors: "extra", width: 2, height: 2 }),
      node("bar", "frame", "p", "a3", { isComponent: true, width: 200, height: 40 }),
      node("barButton", "frame", "bar", "a0", { instanceOf: "button", width: 80, height: 32 }),
      node("barSlot", "frame", "barButton", "a0", {
        instanceOf: "icon",
        mirrors: "slot",
        width: 16,
        height: 16,
      }),
      node("barDot", "rect", "barSlot", "a0", { mirrors: "slotDot", width: 4, height: 4 }),
      node("barExtra", "rect", "barSlot", "a1", { mirrors: "extra", width: 2, height: 2 }),
      node("barCopy", "frame", "p", "a4", { instanceOf: "bar", width: 200, height: 40 }),
      node("bcButton", "frame", "barCopy", "a0", {
        instanceOf: "button",
        mirrors: "barButton",
        width: 80,
        height: 32,
      }),
      node("bcSlot", "frame", "bcButton", "a0", {
        instanceOf: "icon",
        mirrors: "barSlot",
        width: 16,
        height: 16,
      }),
      node("bcDot", "rect", "bcSlot", "a0", { mirrors: "barDot", width: 4, height: 4 }),
      node("bcExtra", "rect", "bcSlot", "a1", { mirrors: "barExtra", width: 2, height: 2 }),
    ];
    const { nodes: out, detached } = pinInstances(nodes);
    expect(detached).toBe(1);
    const props = (id: string) => (out.find((n) => n.id === id) as NodeRecord).props;
    expect(getProp(props("slot"), "instanceOf")).toBeNull();
    // Its copies, and copies of those, are plain copies of it, not swapped for the icon.
    for (const id of ["copySlot", "barSlot", "bcSlot"]) {
      expect(getProp(props(id), "instanceOf")).toBeNull();
      expect(getProp(props(id), "overrides")).not.toContain("instanceOf");
      expect(getProp(props(id), "mirrors")).not.toBeNull();
    }
    expect(getProp(props("bcButton"), "instanceOf")).toBe("button");
    // Nothing to rebuild when it opens, and every instance keeps its link in the compact form.
    expect(propagationOps(opened(out).doc, ["button", "bar", "icon"])).toEqual([]);
    expect([...compactByInstance(out).detached]).toEqual([]);
  });

  it("keeps an instance a detached copy put in a slot", () => {
    // The copy's slot holds an icon its main's slot doesn't: the copy is detached, the icon (an
    // instance copying nothing, its layers its own main's copies) stays an instance.
    const nodes = [
      node("p", "page", ROOT_ID, "a0", {}),
      node("icon", "frame", "p", "a0", { isComponent: true, width: 16, height: 16 }),
      node("dot", "rect", "icon", "a0", { width: 4, height: 4 }),
      node("card", "frame", "p", "a1", { isComponent: true, width: 80, height: 32 }),
      node("slot", "frame", "card", "a0", { width: 80, height: 32 }),
      node("copy", "frame", "p", "a2", { instanceOf: "card", width: 80, height: 32 }),
      node("copySlot", "frame", "copy", "a0", { mirrors: "slot", width: 80, height: 32 }),
      node("content", "frame", "copySlot", "a0", { instanceOf: "icon", width: 16, height: 16 }),
      node("contentDot", "rect", "content", "a0", { mirrors: "dot", width: 4, height: 4 }),
    ];
    const { nodes: out, detached } = pinInstances(nodes);
    expect(detached).toBe(1);
    const props = (id: string) => (out.find((n) => n.id === id) as NodeRecord).props;
    expect(getProp(props("copy"), "instanceOf")).toBeNull();
    expect(getProp(props("copySlot"), "mirrors")).toBeNull();
    expect(getProp(props("content"), "instanceOf")).toBe("icon");
    expect(getProp(props("contentDot"), "mirrors")).toBe("dot");
    expect(propagationOps(opened(out).doc, ["card", "icon"])).toEqual([]);
    // In the compact form it's an instance like any other: its layer isn't stored.
    const compact = compactByInstance(out);
    expect([...compact.detached]).toEqual([]);
    expect(compact.nodes.some((n) => n.id === "contentDot")).toBe(false);
  });

  it("leaves a file whose copies match their mains as it is", () => {
    const nodes = file({});
    expect(pinInstances(nodes)).toEqual({ nodes, pinned: 0, detached: 0 });
  });
});
