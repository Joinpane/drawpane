import { getProp, type NodeRecord, ROOT_ID, type TextRun } from "@drawpane/model";
import { describe, expect, it } from "vitest";
import { Editor } from "../src/editor";
import { fontFaceKey, fontUsage, replaceFontOps } from "../src/replace-fonts";
import type { TextFace } from "../src/rich-text";

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
const face = (family: string, weight = 400, italic = false): TextFace => ({
  family,
  weight,
  italic,
});

describe("fontUsage", () => {
  it("counts each layer once per face, runs and text styles included, most used first", () => {
    const { editor, text } = setup();
    const a = text("Title", { fontFamily: "SF Pro", fontSize: 34, fontWeight: 600 });
    const b = text("Body bold", {
      fontFamily: "SF Pro",
      fontSize: 17,
      textRuns: [{ start: 5, end: 9, fontWeight: 700 }],
    });
    text("Inter", { fontFamily: "Inter" });
    const c = text("Styled", { fontFamily: "SF Pro", fontSize: 17 });
    editor.select([c]);
    editor.createTextStyle("body");
    const uses = fontUsage(editor.doc);
    const by = (f: TextFace) => uses.find((u) => fontFaceKey(u) === fontFaceKey(f));
    expect(by(face("SF Pro", 600))?.layers).toEqual([a]);
    expect(by(face("SF Pro", 600))?.sizes).toEqual([34]);
    expect(by(face("SF Pro", 400))?.layers).toEqual([b, c]);
    expect(by(face("SF Pro", 400))?.styles).toHaveLength(1);
    expect(by(face("SF Pro", 700))?.layers).toEqual([b]);
    expect(by(face("Inter"))?.layers).toHaveLength(1);
  });
});

describe("replaceFontOps", () => {
  it("swaps faces across layers, runs and styles in one undoable change", () => {
    const { editor, text } = setup();
    const title = text("Title", { fontFamily: "SF Pro", fontSize: 34, fontWeight: 600 });
    const body = text("Body bold", {
      fontFamily: "SF Pro",
      textRuns: [{ start: 5, end: 9, fontWeight: 700 }],
    });
    const italic = text("Aside", { fontFamily: "SF Pro", fontStyle: "italic" });
    const keep = text("Kept", { fontFamily: "Inter" });
    const replacements = new Map([
      [fontFaceKey(face("SF Pro", 600)), face("Inter", 600)],
      [fontFaceKey(face("SF Pro", 400)), face("Inter", 400)],
      [fontFaceKey(face("SF Pro", 700)), face("Inter", 800)],
      [fontFaceKey(face("SF Pro", 400, true)), face("Georgia", 400, false)],
    ]);
    const ops = replaceFontOps(editor.doc, replacements);
    expect(editor.commit(ops, "Replace fonts")).toBe(true);

    expect(getProp(props(editor, title), "fontFamily")).toBe("Inter");
    expect(getProp(props(editor, title), "fontWeight")).toBe(600);
    expect(getProp(props(editor, body), "fontFamily")).toBe("Inter");
    expect(getProp(props(editor, body), "textRuns")).toEqual([
      { start: 5, end: 9, fontWeight: 800 },
    ] satisfies TextRun[]);
    expect(getProp(props(editor, italic), "fontFamily")).toBe("Georgia");
    expect(getProp(props(editor, italic), "fontStyle")).toBe("normal");
    expect(getProp(props(editor, keep), "fontFamily")).toBe("Inter");
    expect(fontUsage(editor.doc).some((u) => u.family === "SF Pro")).toBe(false);

    editor.undo();
    expect(getProp(props(editor, title), "fontFamily")).toBe("SF Pro");
    expect(getProp(props(editor, body), "textRuns")).toEqual([
      { start: 5, end: 9, fontWeight: 700 },
    ]);
    expect(getProp(props(editor, italic), "fontStyle")).toBe("italic");
  });

  it("writes a run's family when the layer's own face isn't swapped", () => {
    const { editor, text } = setup();
    const id = text("Hello world", {
      fontFamily: "Inter",
      textRuns: [{ start: 6, end: 11, fontFamily: "SF Pro" }],
    });
    editor.commit(
      replaceFontOps(editor.doc, new Map([[fontFaceKey(face("SF Pro")), face("Georgia")]])),
    );
    expect(getProp(props(editor, id), "textRuns")).toEqual([
      { start: 6, end: 11, fontFamily: "Georgia" },
    ]);
  });

  it("rewrites a text style, and its layers follow without letting go of it", () => {
    const { editor, text } = setup();
    const id = text("Styled", { fontFamily: "SF Pro", fontSize: 20 });
    editor.select([id]);
    const style = editor.createTextStyle("heading") as string;
    editor.commit(
      replaceFontOps(editor.doc, new Map([[fontFaceKey(face("SF Pro")), face("Inter")]])),
    );
    expect(getProp(props(editor, style), "fontFamily")).toBe("Inter");
    expect(getProp(props(editor, id), "fontFamily")).toBe("Inter");
    expect(getProp(props(editor, id), "textStyle")).toBe(style);
  });

  it("does nothing without replacements", () => {
    const { editor, text } = setup();
    text("x", { fontFamily: "SF Pro" });
    expect(replaceFontOps(editor.doc, new Map())).toEqual([]);
  });
});
