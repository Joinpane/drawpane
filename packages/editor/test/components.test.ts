import { getProp, type NodeRecord, ROOT_ID } from "@drawpane/model";
import { beforeEach, describe, expect, it } from "vitest";
import {
  canMoveInto,
  instancesOf,
  isInstanceRoot,
  isMainComponent,
  swapTargets,
} from "../src/components";
import { Editor } from "../src/editor";
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
