import { getProp, type NodeRecord, type Props, ROOT_ID } from "@drawpane/model";
import { describe, expect, it } from "vitest";
import { Editor } from "../src/editor";
import { layoutText, type TextMeasurer } from "../src/text";

/** 10 px a character at 20 px; ascent 0.8 em, descent 0.2 (so auto line height is 1 em). */
const measurer: TextMeasurer = {
  width: (font, text) => text.length * (Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? 16) / 2),
  metrics: (font) => {
    const size = Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? 16);
    return { ascent: size * 0.8, descent: size * 0.2 };
  },
};

const text = (characters: string, props: Partial<Props>): NodeRecord =>
  ({
    id: "t",
    type: "text",
    parent: ROOT_ID,
    key: "a0",
    props: { characters, fontSize: 20, ...props } as Props,
  }) as NodeRecord;

describe("line height on part of a text", () => {
  it("puts each line its own line height below the last, as Figma does", () => {
    // 20 px lines, the middle paragraph at 200%: 40 px below the first, then 20 below that.
    const node = text("one\ntwo\nthree", {
      lineHeight: { unit: "px", value: 20 },
      textRuns: [{ start: 4, end: 8, lineHeight: { unit: "percent", value: 200 } }],
    } as Partial<Props>);
    const { lines, height } = layoutText(node, measurer, null);
    const [a = 0, b = 0, c = 0] = lines.map((l) => l.baseline);
    expect(b - a).toBe(40);
    expect(c - b).toBe(20);
    // The first sits centred in its own line, the box ends below the last.
    expect(a).toBe(16);
    expect(height).toBe(16 + 40 + 20 + 4);
  });

  it("gives a line the tallest line height of its characters", () => {
    const node = text("a tall b\nnext", {
      lineHeight: { unit: "px", value: 20 },
      textRuns: [{ start: 2, end: 6, lineHeight: { unit: "px", value: 50 } }],
    } as Partial<Props>);
    const { lines } = layoutText(node, measurer, null);
    expect(lines[0]?.step).toBe(50);
    expect((lines[1]?.baseline ?? 0) - (lines[0]?.baseline ?? 0)).toBe(20);
  });

  it("is set on the selected characters while editing, like any character style", () => {
    const editor = new Editor({ measurer, clientId: "t" });
    editor.state.set({ role: "editor" });
    editor.doc.apply([
      { op: "create", id: "p", type: "page", parent: ROOT_ID, key: "a0", props: {} },
    ]);
    editor.setPage("p");
    const id = editor.createLayer("text", { x: 0, y: 0, width: 10, height: 10 }, "p", {
      characters: "Heading\nBody",
    }) as string;
    editor.startTextEdit(id);
    editor.setTextSelection(0, 7);
    editor.setProp([id], "lineHeight", { unit: "px", value: 44 });
    const node = editor.doc.get(id) as NodeRecord;
    expect(getProp(node.props, "textRuns")).toEqual([
      { start: 0, end: 7, lineHeight: { unit: "px", value: 44 } },
    ]);
    expect(getProp(node.props, "lineHeight")).toEqual({ unit: "auto" });
  });
});
