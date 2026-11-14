/**
 * Team libraries (decision 0010): a library file's components, copied into
 * a file that uses them, instanced there, and updated from a newer publish
 * with the instances following and keeping their overrides.
 */
import { getProp, type NodeRecord, ROOT_ID } from "@drawpane/model";
import { describe, expect, it } from "vitest";
import { instancesOf, listComponents } from "../src/components";
import { Doc } from "../src/doc";
import { Editor } from "../src/editor";
import {
  assetChanges,
  assetHash,
  isLibraryCopy,
  type LibraryRef,
  libraryAssets,
  libraryContainerId,
  libraryNodeId,
  libraryUses,
  updateOps,
  usedLibraries,
} from "../src/libraries";
import type { TextMeasurer } from "../src/text";

const measurer: TextMeasurer = {
  width: (font, text) => text.length * Number(font.match(/(\d+(?:\.\d+)?)px/)?.[1] ?? 16) * 0.5,
};

function editorWithPage() {
  const editor = new Editor({ measurer, clientId: "test" });
  editor.state.set({ role: "editor" });
  editor.doc.apply([
    { op: "create", id: "p", type: "page", parent: ROOT_ID, key: "a0", props: { name: "Page" } },
  ]);
  editor.setPage("p");
  return editor;
}

/**
 * A library: a Button (its fill bound to a colour variable, its label in a
 * text style) and a Card holding an instance of the Button.
 */
function makeLibrary() {
  const lib = editorWithPage();
  const collection = lib.createCollection("Brand") as string;
  const brand = lib.createVariable(collection, "brand", "color", "#ff5a1f") as string;
  const button = lib.createLayer("frame", { x: 0, y: 0, width: 120, height: 40 }, "p", {
    name: "Button",
    fills: [{ type: "solid", color: "#ff5a1f" }],
  }) as string;
  const label = lib.createLayer("text", { x: 10, y: 10, width: 0, height: 0 }, button, {
    fontSize: 16,
  }) as string;
  lib.updateText(label, "Save");
  const style = lib.createTextStyle("Body", label) as string;
  lib.bindVariable([button], "fill", brand);
  lib.select([button]);
  lib.createComponent();
  const card = lib.createLayer("frame", { x: 300, y: 0, width: 200, height: 120 }, "p", {
    name: "Card",
  }) as string;
  lib.select([card]);
  lib.createComponent();
  lib.select([card]);
  const inner = lib.insertInstance(button, { x: 400, y: 60 }) as string;
  return { lib, collection, brand, button, label, style, card, inner };
}

/** A publish's snapshot: the library's nodes as they are, in a document of their own. */
function snapshot(lib: Editor): Doc {
  const doc = new Doc();
  doc.reset([...lib.doc.nodes()].map((n) => ({ ...n, props: { ...n.props } })));
  return doc;
}

const LIB_FILE = "libFile01";
const ref = (publishId = "pub1"): LibraryRef => ({
  fileId: LIB_FILE,
  name: "Brand kit",
  publishId,
});

const textIn = (editor: Editor, rootId: string): NodeRecord | undefined => {
  const stack = [rootId];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    const node = editor.doc.get(id);
    if (node?.type === "text") return node;
    stack.push(...editor.doc.childIds(id));
  }
  return undefined;
};

describe("what a library offers", () => {
  it("lists its components with content hashes that change with what they draw", () => {
    const { lib, button, card } = makeLibrary();
    const assets = libraryAssets(lib.doc);
    expect(assets.map((a) => [a.id, a.name, a.set])).toEqual([
      [button, "Button", false],
      [card, "Card", false],
    ]);
    const before = assetHash(lib.doc, card);
    // Moving it on its page isn't a change; recolouring the button inside it is.
    lib.setProp([card], "x", 900, "Move");
    expect(assetHash(lib.doc, card)).toBe(before);
    lib.setProp([button], "cornerRadius", 8, "Radius");
    expect(assetHash(lib.doc, card)).not.toBe(before);
    expect(assetHash(lib.doc, button)).toMatch(/^[0-9a-f]{16}$/);
  });

  it("tells added, changed and removed components between publishes", () => {
    const a = { id: "a", name: "A", description: "", set: false, hash: "0".repeat(16) };
    const b = { ...a, id: "b", name: "B" };
    const changes = assetChanges(
      [a, b],
      [
        { ...a, hash: "1".repeat(16) },
        { ...b, id: "c" },
      ],
    );
    expect(changes.changed.map((x) => x.id)).toEqual(["a"]);
    expect(changes.added.map((x) => x.id)).toEqual(["c"]);
    expect(changes.removed.map((x) => x.id)).toEqual(["b"]);
  });
});

describe("using a library", () => {
  it("copies a component and what it needs, then instances the copy", () => {
    const { lib, card, button, brand, style, collection } = makeLibrary();
    const file = editorWithPage();
    const instance = file.insertLibraryComponent(snapshot(lib), ref(), card, { x: 50, y: 50 });
    expect(instance).not.toBeNull();
    const container = libraryContainerId(LIB_FILE);
    expect(usedLibraries(file.doc)).toEqual([ref()]);
    // The card, the button it nests, the colour's collection and the text style, by derived ids.
    for (const id of [card, button, collection, style])
      expect(file.doc.get(libraryNodeId(LIB_FILE, id))?.parent).toBe(container);
    expect(file.doc.has(libraryNodeId(LIB_FILE, brand))).toBe(true);
    // The instance is an ordinary one, of the copy.
    const root = file.doc.get(instance as string);
    expect(getProp(root?.props ?? {}, "instanceOf")).toBe(libraryNodeId(LIB_FILE, card));
    expect(root?.parent).toBe("p");
    // Copies aren't the file's own components, and are read-only library copies.
    expect(listComponents(file.doc)).toEqual([]);
    expect(isLibraryCopy(file.doc, libraryNodeId(LIB_FILE, button))).toBe(true);
    expect(isLibraryCopy(file.doc, instance as string)).toBe(false);
    // The copied button still points at the copied variable and style.
    const buttonCopy = file.doc.get(libraryNodeId(LIB_FILE, button));
    expect(getProp(buttonCopy?.props ?? {}, "bindings")).toEqual({
      fill: libraryNodeId(LIB_FILE, brand),
    });
  });

  it("copies once: a second instance reuses the copies, in one undo step each", () => {
    const { lib, card } = makeLibrary();
    const file = editorWithPage();
    const source = snapshot(lib);
    file.insertLibraryComponent(source, ref(), card, { x: 0, y: 0 });
    const nodes = file.doc.size;
    file.insertLibraryComponent(source, ref(), card, { x: 300, y: 0 });
    expect(instancesOf(file.doc, libraryNodeId(LIB_FILE, card))).toHaveLength(2);
    // Only the new instance's layers were added.
    expect(file.doc.size - nodes).toBeLessThan(10);
    file.undo();
    expect(instancesOf(file.doc, libraryNodeId(LIB_FILE, card))).toHaveLength(1);
    file.undo();
    expect(file.doc.has(libraryContainerId(LIB_FILE))).toBe(false);
  });
});

describe("updating from a newer publish", () => {
  it("brings the copies in line, and instances follow, keeping their overrides", () => {
    const { lib, card, button, label } = makeLibrary();
    const file = editorWithPage();
    const instance = file.insertLibraryComponent(snapshot(lib), ref(), card, {
      x: 0,
      y: 0,
    }) as string;
    // Override the button label inside the card instance.
    const text = textIn(file, instance) as NodeRecord;
    file.updateText(text.id, "Send");

    // The library rounds and greys the button, and renames its label (not overridden: text).
    lib.setProp([button], "cornerRadius", 12, "Radius");
    lib.setProp([button], "opacity", 0.5, "Opacity");
    lib.setProp([label], "fontSize", 20, "Size");
    expect(file.updateLibrary(snapshot(lib), ref("pub2"))).toBe(true);

    const buttonCopy = file.doc.get(libraryNodeId(LIB_FILE, button));
    expect(getProp(buttonCopy?.props ?? {}, "cornerRadius")).toBe(12);
    // The nested button inside the card instance followed both copies.
    const nested = file.doc
      .childIds(instance)
      .map((id) => file.doc.get(id))
      .find((n) => n?.type === "frame");
    expect(getProp(nested?.props ?? {}, "cornerRadius")).toBe(12);
    expect(getProp(nested?.props ?? {}, "opacity")).toBe(0.5);
    const after = textIn(file, instance);
    expect(getProp(after?.props ?? {}, "characters")).toBe("Send");
    expect(getProp(after?.props ?? {}, "fontSize")).toBe(20);
    expect(usedLibraries(file.doc)[0]?.publishId).toBe("pub2");
    // Nothing left to do for the same publish.
    expect(updateOps(file.doc, snapshot(lib), ref("pub2"))).toEqual([]);
  });

  it("adds and removes layers, and keeps a component the library dropped", () => {
    const { lib, card, button } = makeLibrary();
    const file = editorWithPage();
    file.insertLibraryComponent(snapshot(lib), ref(), card, { x: 0, y: 0 });
    file.insertLibraryComponent(snapshot(lib), ref(), button, { x: 300, y: 0 });
    // A new layer in the button; the card deleted from the library.
    const dot = lib.createLayer("ellipse", { x: 100, y: 5, width: 8, height: 8 }, button) as string;
    lib.select([card]);
    lib.deleteSelection();
    file.updateLibrary(snapshot(lib), ref("pub2"));
    expect(file.doc.get(libraryNodeId(LIB_FILE, dot))?.parent).toBe(
      libraryNodeId(LIB_FILE, button),
    );
    // The card's copy stays, so its instance still has a main.
    expect(file.doc.has(libraryNodeId(LIB_FILE, card))).toBe(true);
    // Removing the dot again removes its copy.
    lib.select([dot]);
    lib.deleteSelection();
    file.updateLibrary(snapshot(lib), ref("pub3"));
    expect(file.doc.has(libraryNodeId(LIB_FILE, dot))).toBe(false);
    // One undo takes the whole update back.
    file.undo();
    expect(file.doc.has(libraryNodeId(LIB_FILE, dot))).toBe(true);
  });
});

describe("using and no longer using a library", () => {
  it("shows a library before anything is inserted, and stops only when nothing uses it", () => {
    const { lib, button } = makeLibrary();
    const file = editorWithPage();
    expect(file.useLibrary(ref())).toBe(true);
    expect(usedLibraries(file.doc)).toEqual([ref()]);
    const instance = file.insertLibraryComponent(snapshot(lib), ref(), button, {
      x: 0,
      y: 0,
    }) as string;
    expect(libraryUses(file.doc, LIB_FILE)).toBe(1);
    expect(file.stopUsingLibrary(LIB_FILE)).toBe(false);
    expect(file.doc.has(libraryContainerId(LIB_FILE))).toBe(true);
    file.select([instance]);
    file.deleteSelection();
    expect(libraryUses(file.doc, LIB_FILE)).toBe(0);
    expect(file.stopUsingLibrary(LIB_FILE)).toBe(true);
    expect(usedLibraries(file.doc)).toEqual([]);
  });
});
