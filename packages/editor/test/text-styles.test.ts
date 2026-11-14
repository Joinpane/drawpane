import { getProp, type NodeRecord, ROOT_ID } from "@drawpane/model";
import { describe, expect, it } from "vitest";
import { Editor } from "../src/editor";
import { describeTextStyle, textStyles, textStyleUsers } from "../src/text-styles";
import { exportDtcg } from "../src/variables";

/** 10px a character at size 16, scaling with the font size in the font string. */
function setup() {
  const editor = new Editor({
    measurer: {
      width: (font, text) =>
        text.length * (Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? 16) / 1.6),
    },
    clientId: "t",
  });
  editor.state.set({ role: "editor" });
  editor.doc.apply([
    { op: "create", id: "p", type: "page", parent: ROOT_ID, key: "a0", props: {} },
  ]);
  editor.setPage("p");
  const text = (characters: string, props = {}) =>
    editor.createLayer("text", { x: 0, y: 0, width: 10, height: 10 }, "p", {
      characters,
      ...props,
    }) as string;
  return { editor, text };
}

const props = (editor: Editor, id: string) => (editor.doc.get(id) as NodeRecord).props;

describe("text styles", () => {
  it("makes a style from a layer and applies it to the selection", () => {
    const { editor, text } = setup();
    const title = text("Title", { fontSize: 32, fontWeight: 600 });
    const other = text("Other");
    editor.select([title, other]);
    const style = editor.createTextStyle("heading/xl") as string;
    expect(getProp(props(editor, style), "fontSize")).toBe(32);
    expect(getProp(props(editor, style), "fontWeight")).toBe(600);
    // Both layers follow it, and the second one took its typography.
    expect(
      textStyleUsers(editor.doc, style)
        .map((n) => n.id)
        .sort(),
    ).toEqual([title, other].sort());
    expect(getProp(props(editor, other), "fontSize")).toBe(32);
    expect(describeTextStyle(editor.doc.get(style) as NodeRecord)).toBe("32 / Auto · Semibold");
    expect(textStyles(editor.doc).map((s) => getProp(s.props, "name"))).toEqual(["heading/xl"]);
    // One undo step for making and applying it.
    editor.undo();
    expect(editor.doc.get(style)).toBeUndefined();
    expect(getProp(props(editor, other), "fontSize")).toBe(16);
  });

  it("updates every layer when the style changes, and re-measures them", () => {
    const { editor, text } = setup();
    const a = text("Hello");
    const b = text("World");
    editor.select([a, b]);
    const style = editor.createTextStyle("body") as string;
    expect(getProp(props(editor, a), "width")).toBe(50);
    editor.setProp([style], "fontSize", 32);
    expect(getProp(props(editor, a), "fontSize")).toBe(32);
    expect(getProp(props(editor, b), "fontSize")).toBe(32);
    // Auto-width text grew with its new size.
    expect(getProp(props(editor, a), "width")).toBe(100);
  });

  it("detaches a layer when its styled typography is changed by hand", () => {
    const { editor, text } = setup();
    const a = text("Hello");
    editor.select([a]);
    const style = editor.createTextStyle("body") as string;
    // The same value the style has is no change: it stays attached.
    editor.setProp([a], "fontSize", 16);
    expect(getProp(props(editor, a), "textStyle")).toBe(style);
    editor.setProp([a], "fontSize", 20);
    expect(getProp(props(editor, a), "textStyle")).toBeNull();
    expect(getProp(props(editor, a), "fontSize")).toBe(20);
    // Detached, it no longer follows.
    editor.setProp([style], "fontSize", 40);
    expect(getProp(props(editor, a), "fontSize")).toBe(20);
    // Alignment isn't part of a style, so changing it keeps the style.
    editor.applyTextStyle([a], style);
    editor.setProp([a], "textAlign", "center");
    expect(getProp(props(editor, a), "textStyle")).toBe(style);
  });

  it("deletes a style, leaving its layers as they look", () => {
    const { editor, text } = setup();
    const a = text("Hello", { fontSize: 24 });
    editor.select([a]);
    const style = editor.createTextStyle("body") as string;
    editor.deleteTextStyle(style);
    expect(editor.doc.get(style)).toBeUndefined();
    expect(getProp(props(editor, a), "textStyle")).toBeNull();
    expect(getProp(props(editor, a), "fontSize")).toBe(24);
    editor.undo();
    expect(getProp(props(editor, a), "textStyle")).toBe(style);
  });

  it("updates a style from a layer, and every user follows", () => {
    const { editor, text } = setup();
    const a = text("A");
    const b = text("B");
    editor.select([a, b]);
    const style = editor.createTextStyle("body") as string;
    editor.setProp([a], "fontWeight", 700); // detaches a
    editor.updateTextStyle(style, a);
    expect(getProp(props(editor, style), "fontWeight")).toBe(700);
    expect(getProp(props(editor, b), "fontWeight")).toBe(700);
    expect(getProp(props(editor, a), "textStyle")).toBe(style);
  });

  it("lets go of variables bound to what a style sets", () => {
    const { editor, text } = setup();
    const a = text("A");
    const collection = editor.createCollection() as string;
    const size = editor.createVariable(collection, "size/lg", "number", 24) as string;
    editor.bindVariable([a], "fontSize", size);
    expect(getProp(props(editor, a), "fontSize")).toBe(24);
    const b = text("B", { fontSize: 18 });
    editor.select([b]);
    const style = editor.createTextStyle("body") as string;
    editor.applyTextStyle([a], style);
    expect(getProp(props(editor, a), "bindings").fontSize).toBeUndefined();
    expect(getProp(props(editor, a), "fontSize")).toBe(18);
  });

  it("toggles bold, italic and underline on the selected text", () => {
    const { editor, text } = setup();
    const a = text("A");
    const b = text("B", { fontWeight: 700 });
    editor.select([a, b]);
    editor.toggleTextStyle("bold");
    expect([
      getProp(props(editor, a), "fontWeight"),
      getProp(props(editor, b), "fontWeight"),
    ]).toEqual([700, 700]);
    editor.toggleTextStyle("bold");
    expect(getProp(props(editor, a), "fontWeight")).toBe(400);
    editor.toggleTextStyle("italic");
    expect(getProp(props(editor, b), "fontStyle")).toBe("italic");
    editor.toggleTextStyle("underline");
    expect(getProp(props(editor, a), "textDecoration")).toBe("underline");
  });

  it("exports styles as DTCG typography tokens, grouped by name", () => {
    const { editor, text } = setup();
    const a = text("A", {
      fontSize: 22,
      fontWeight: 600,
      lineHeight: { unit: "px", value: 28 },
      letterSpacing: { unit: "percent", value: -2 },
      textCase: "upper",
    });
    editor.select([a]);
    editor.createTextStyle("heading/xl");
    const tokens = exportDtcg(editor.doc) as { heading: { xl: Record<string, unknown> } };
    expect(tokens.heading.xl).toEqual({
      $type: "typography",
      $value: {
        fontFamily: "Instrument Sans",
        fontWeight: 600,
        fontSize: "22px",
        lineHeight: 1.27,
        letterSpacing: "-0.44px",
      },
      $extensions: { "drawpane.text": { textCase: "upper" } },
    });
  });
});
