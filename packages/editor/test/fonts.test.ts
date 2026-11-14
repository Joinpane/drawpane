import { getProp, type NodeRecord, ROOT_ID } from "@drawpane/model";
import { describe, expect, it } from "vitest";
import { Editor } from "../src/editor";
import type { TextMeasurer } from "../src/text";

/**
 * Measures 8px a character, or 12px once "Fraunces" has "loaded". Like the
 * real measurer, it bumps its generation when a font arrives, so layouts
 * cached with the fallback are redone.
 */
function setup() {
  let loaded = false;
  let generation = 0;
  const measurer: TextMeasurer = {
    width: (font, text) => text.length * (loaded && font.includes("Fraunces") ? 12 : 8),
    get generation() {
      return generation;
    },
  };
  const editor = new Editor({ measurer, clientId: "t" });
  editor.state.set({ role: "editor" });
  editor.doc.apply([
    { op: "create", id: "p", type: "page", parent: ROOT_ID, key: "a0", props: {} },
  ]);
  editor.setPage("p");
  return {
    editor,
    load: () => {
      loaded = true;
      generation++;
    },
  };
}

const width = (editor: Editor, id: string) =>
  getProp((editor.doc.get(id) as NodeRecord).props, "width");

describe("fonts", () => {
  it("re-measures text in a font once it loads, without an undo step", () => {
    const { editor, load } = setup();
    const a = editor.createLayer("text", { x: 0, y: 0, width: 10, height: 10 }, "p", {
      characters: "Hello",
      fontFamily: "Fraunces",
    }) as string;
    const b = editor.createLayer("text", { x: 0, y: 50, width: 10, height: 10 }, "p", {
      characters: "Hello",
    }) as string;
    expect(width(editor, a)).toBe(40);
    const undoable = editor.history.canUndo;
    load();
    editor.refitText(new Set(["Fraunces"]));
    expect(width(editor, a)).toBe(60);
    expect(width(editor, b)).toBe(40);
    // The refit isn't yours to undo: undo takes back the last real edit.
    expect(editor.history.canUndo).toBe(undoable);
  });

  it("cancels a previewing gesture without leaving undo or redo", () => {
    const { editor } = setup();
    const t = editor.createLayer("text", { x: 0, y: 0, width: 10, height: 10 }, "p", {
      characters: "Hi",
    }) as string;
    const before = editor.history.canRedo;
    editor.beginGesture("Font");
    editor.setProp([t], "fontFamily", "Georgia");
    editor.setProp([t], "fontFamily", "Arial");
    editor.cancelGesture();
    expect(getProp((editor.doc.get(t) as NodeRecord).props, "fontFamily")).toBe("Instrument Sans");
    expect(editor.history.canRedo).toBe(before);
    expect(editor.s.gesture).toBe(false);
  });
});
