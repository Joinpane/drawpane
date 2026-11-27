import { getProp, ROOT_ID } from "@drawpane/model";
import { describe, expect, it } from "vitest";
import { Editor } from "../src";

function makeEditor() {
  const editor = new Editor({ measurer: { width: (_f, t) => t.length * 6 }, clientId: "t" });
  editor.state.set({ role: "owner", status: "live" });
  editor.doc.apply([
    { op: "create", id: "p", type: "page", parent: ROOT_ID, key: "a0", props: {} },
  ]);
  editor.setPage("p");
  editor.setViewport(393, 852);
  return { editor, pageId: "p" };
}

describe("workspace readOnly mode", () => {
  it("disables document mutations and authoring tools for an owner while keeping role and selection", () => {
    const { editor, pageId } = makeEditor();
    const rectId = editor.createLayer("rect", { x: 40, y: 40, width: 120, height: 80 }, pageId);
    const textId = editor.createLayer("text", { x: 40, y: 160, width: 120, height: 24 }, pageId);
    expect(rectId).toBeTruthy();
    expect(textId).toBeTruthy();
    editor.setProp([textId as string], "characters", "Hello");
    editor.setTool("rect");
    editor.startTextEdit(textId as string);
    expect(editor.s.editingText).toBe(textId);

    editor.setReadOnly(true);

    expect(editor.s.role).toBe("owner");
    expect(editor.s.readOnly).toBe(true);
    expect(editor.canEdit).toBe(false);
    expect(editor.s.editingText).toBeNull();
    expect(editor.s.tool).toBe("select");

    // Authoring tools are refused; view/comment tools remain available.
    editor.setTool("rect");
    expect(editor.s.tool).toBe("select");
    editor.setTool("comment");
    expect(editor.s.tool).toBe("comment");
    editor.setTool("hand");
    expect(editor.s.tool).toBe("hand");
    editor.setTool("select");
    expect(editor.s.tool).toBe("select");

    // Selection still works, while edits and text editing are refused.
    editor.select([rectId as string]);
    expect(editor.s.selection).toEqual([rectId]);
    editor.nudge(20, 0);
    expect(getProp(editor.doc.get(rectId as string)?.props ?? {}, "x")).toBe(40);
    editor.startTextEdit(textId as string);
    expect(editor.s.editingText).toBeNull();

    // Returning to editable mode restores editing for the owner.
    editor.setReadOnly(false);
    expect(editor.canEdit).toBe(true);
    editor.nudge(20, 0);
    expect(getProp(editor.doc.get(rectId as string)?.props ?? {}, "x")).toBe(60);
  });

  it("fits content using the requested padding and visible insets", () => {
    const { editor, pageId } = makeEditor();
    editor.createLayer("rect", { x: 0, y: 0, width: 1000, height: 500 }, pageId);
    editor.state.set({ insets: { top: 60, right: 0, bottom: 68, left: 0 } });

    editor.zoomToFit(20);
    const phoneZoom = editor.s.camera.zoom;
    // (393 - 40) / 1000 = 0.353
    expect(phoneZoom).toBeCloseTo(0.353, 3);

    editor.zoomToFit();
    const desktopZoom = editor.s.camera.zoom;
    // (393 - 128) / 1000 = 0.265
    expect(desktopZoom).toBeCloseTo(0.265, 3);
  });

  it("cancelTextEdit restores cleared or edited text without deleting the layer or polluting redo", () => {
    const { editor, pageId } = makeEditor();
    const textId = editor.createLayer("text", { x: 40, y: 40, width: 140, height: 28 }, pageId);
    expect(textId).toBeTruthy();
    editor.setProp([textId as string], "characters", "Original title");
    expect(editor.s.canUndo).toBe(true);
    expect(editor.s.canRedo).toBe(false);

    // Clearing all text and cancelling restores the original text, keeps the layer,
    // and leaves undo/redo as if the edit never started.
    editor.startTextEdit(textId as string);
    editor.updateText(textId as string, "");
    editor.cancelTextEdit();
    expect(editor.s.editingText).toBeNull();
    expect(editor.doc.get(textId as string)).toBeDefined();
    expect(getProp(editor.doc.get(textId as string)?.props ?? {}, "characters")).toBe(
      "Original title",
    );
    expect(editor.s.canRedo).toBe(false);

    // Typing new words and cancelling also leaves the redo stack untouched.
    editor.startTextEdit(textId as string);
    editor.updateText(textId as string, "Cancelled typing");
    editor.cancelTextEdit();
    expect(getProp(editor.doc.get(textId as string)?.props ?? {}, "characters")).toBe(
      "Original title",
    );
    expect(editor.s.canRedo).toBe(false);

    // A brand-new empty text layer cancelled without ever having text is still removed.
    const freshId = editor.createLayer("text", { x: 40, y: 120, width: 120, height: 24 }, pageId);
    expect(freshId).toBeTruthy();
    editor.startTextEdit(freshId as string);
    editor.updateText(freshId as string, "Temporary");
    editor.cancelTextEdit();
    expect(editor.doc.get(freshId as string)).toBeUndefined();
    expect(editor.s.canRedo).toBe(false);
  });

  it("closes text-edit undo group when a peer deletes the edited text so later Cancel never rolls back unrelated moves", () => {
    const { editor, pageId } = makeEditor();
    const doomedId = editor.createLayer("text", { x: 20, y: 20, width: 120, height: 24 }, pageId);
    const survivorId = editor.createLayer("text", { x: 20, y: 60, width: 120, height: 24 }, pageId);
    const markerId = editor.createLayer("rect", { x: 0, y: 120, width: 80, height: 40 }, pageId);
    expect(doomedId && survivorId && markerId).toBeTruthy();
    editor.setProp([doomedId as string], "characters", "Soon gone");
    editor.setProp([survivorId as string], "characters", "Survivor");

    // Start editing doomed text, then a peer deletes it remotely.
    editor.startTextEdit(doomedId as string);
    expect(editor.history.grouping).toBe(true);
    editor.doc.apply([{ op: "delete", id: doomedId as string }]);

    // #reconcile must leave text editing AND close the leaked "Edit text" group.
    expect(editor.s.editingText).toBeNull();
    expect(editor.history.grouping).toBe(false);
    expect(editor.history.groupDepth).toBe(0);
    expect(editor.s.gesture).toBe(false);

    // Move an unrelated layer twice; each move must be its own saved undo step.
    editor.select([markerId as string]);
    editor.setProp([markerId as string], "x", 100);
    editor.setProp([markerId as string], "x", 222);
    expect(getProp(editor.doc.get(markerId as string)?.props ?? {}, "x")).toBe(222);

    // Edit another text layer and cancel: must revert only the text edit, never the prior moves.
    editor.startTextEdit(survivorId as string);
    editor.updateText(survivorId as string, "Temporary edit");
    editor.cancelTextEdit();

    expect(getProp(editor.doc.get(survivorId as string)?.props ?? {}, "characters")).toBe(
      "Survivor",
    );
    expect(getProp(editor.doc.get(markerId as string)?.props ?? {}, "x")).toBe(222);
    expect(editor.s.canRedo).toBe(false);

    // Confirm the two prior moves were NOT merged into one leaked group.
    editor.undo();
    expect(getProp(editor.doc.get(markerId as string)?.props ?? {}, "x")).toBe(100);
    editor.undo();
    expect(getProp(editor.doc.get(markerId as string)?.props ?? {}, "x")).toBe(0);
  });

  it("cancelTextEdit discards nested font-preview groups without touching any outer undo group", () => {
    const { editor, pageId } = makeEditor();
    const textId = editor.createLayer("text", { x: 20, y: 20, width: 160, height: 28 }, pageId);
    const markerId = editor.createLayer("rect", { x: 0, y: 100, width: 80, height: 40 }, pageId);
    expect(textId && markerId).toBeTruthy();
    editor.setProp([textId as string], "characters", "Headline");
    const originalFont = getProp(editor.doc.get(textId as string)?.props ?? {}, "fontFamily");

    // 1. Nested font-preview group inside a normal text edit: Cancel reverts both preview and typing.
    editor.startTextEdit(textId as string);
    editor.updateText(textId as string, "Draft headline");
    editor.beginGesture("Preview font");
    editor.setProp([textId as string], "fontFamily", "Georgia");
    expect(editor.history.groupDepth).toBe(2);

    editor.cancelTextEdit();
    expect(editor.history.groupDepth).toBe(0);
    expect(editor.s.gesture).toBe(false);
    expect(getProp(editor.doc.get(textId as string)?.props ?? {}, "characters")).toBe("Headline");
    expect(getProp(editor.doc.get(textId as string)?.props ?? {}, "fontFamily")).toBe(originalFont);
    expect(editor.s.canRedo).toBe(false);

    // 2. If an unrelated outer group is already open, Cancel only discards groups opened by startTextEdit.
    editor.beginGesture("Outer work");
    editor.setProp([markerId as string], "x", 111);
    editor.setProp([markerId as string], "x", 222);
    expect(editor.history.groupDepth).toBe(1);

    editor.startTextEdit(textId as string);
    editor.updateText(textId as string, "Discarded");
    editor.beginGesture("Preview font");
    editor.setProp([textId as string], "fontFamily", "Georgia");
    expect(editor.history.groupDepth).toBe(3);

    editor.cancelTextEdit();
    expect(editor.history.groupDepth).toBe(1);
    expect(getProp(editor.doc.get(textId as string)?.props ?? {}, "characters")).toBe("Headline");
    expect(getProp(editor.doc.get(textId as string)?.props ?? {}, "fontFamily")).toBe(originalFont);
    expect(getProp(editor.doc.get(markerId as string)?.props ?? {}, "x")).toBe(222);

    editor.endGesture();
    expect(editor.history.groupDepth).toBe(0);
    expect(getProp(editor.doc.get(markerId as string)?.props ?? {}, "x")).toBe(222);
  });
});
