import { type NodeRecord, ROOT_ID } from "@drawpane/model";
import { describe, expect, it } from "vitest";
import { Editor } from "../src/editor";
import { autoSize, layoutText } from "../src/text";

/** 10px a character at size 16 (the default). */
const measurer = {
  width: (font: string, text: string) =>
    text.length * (Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? 16) / 1.6),
};

const textNode = (characters: string, props = {}): NodeRecord => ({
  id: "t",
  type: "text",
  parent: "p",
  key: "a0",
  props: { characters, ...props },
});

describe("paragraph spacing", () => {
  it("adds space after each paragraph, not after the last, and not between wrapped lines", () => {
    // Two paragraphs; the first wraps onto two lines at 60px.
    const plain = layoutText(textNode("aaaa bbbb\ncc"), measurer, 60);
    const spaced = layoutText(textNode("aaaa bbbb\ncc", { paragraphSpacing: 12 }), measurer, 60);
    expect(spaced.lines.map((l) => l.text)).toEqual(["aaaa", "bbbb", "cc"]);
    const [a, b, c] = spaced.lines;
    const [pa, pb, pc] = plain.lines;
    expect(a?.top).toBe(pa?.top);
    // A wrapped line in the same paragraph: no extra space.
    expect(b?.top).toBe(pb?.top);
    expect((c?.top ?? 0) - (pc?.top ?? 0)).toBe(12);
    // Nothing after the last paragraph.
    expect(spaced.height - plain.height).toBe(12);
  });

  it("grows a text box that hugs its height", () => {
    const node = textNode("one\ntwo\nthree", {
      paragraphSpacing: 8,
      textAutoResize: "height",
      width: 200,
    });
    const plain = autoSize(
      textNode("one\ntwo\nthree", { textAutoResize: "height", width: 200 }),
      measurer,
    );
    expect((autoSize(node, measurer)?.height ?? 0) - (plain?.height ?? 0)).toBe(16);
  });
});

describe("truncation", () => {
  it("keeps the first lines and ends the last one in an ellipsis that fits the box", () => {
    // "aaaa bbbb cccc dddd" at 100px: lines "aaaa bbbb", "cccc dddd" (90px each).
    const node = textNode("aaaa bbbb cccc dddd eeee", { maxLines: 2 });
    const layout = layoutText(node, measurer, 100);
    expect(layout.lines).toHaveLength(2);
    expect(layout.lines[0]?.text).toBe("aaaa bbbb");
    // "cccc dddd…" would be 100px: it fits exactly.
    expect(layout.lines[1]?.text).toBe("cccc dddd…");
    expect(layout.lines[1]?.width).toBeLessThanOrEqual(100);
    // The box hugs two lines.
    expect(layout.height).toBe(layoutText(textNode("a\nb"), measurer, 100).height);
  });

  it("cuts into the last line when the ellipsis wouldn't fit, without a dangling space", () => {
    const layout = layoutText(textNode("aaaa bbbbbb cc", { maxLines: 1 }), measurer, 100);
    // "aaaa bbbbbb" is 110px: too wide with the dots. Cut back to fit, dots after a letter.
    expect(layout.lines).toHaveLength(1);
    const line = layout.lines[0];
    expect(line?.text.endsWith("…")).toBe(true);
    expect(line?.text).not.toMatch(/\s…$/);
    expect(line?.width).toBeLessThanOrEqual(100);
  });

  it("does nothing when the text fits, and shows everything while being edited", () => {
    expect(layoutText(textNode("short", { maxLines: 2 }), measurer, 100).lines[0]?.text).toBe(
      "short",
    );
    const node = textNode("aaaa\nbbbb\ncccc", { maxLines: 1 });
    expect(layoutText(node, measurer, null).lines.map((l) => l.text)).toEqual(["aaaa…"]);
    expect(layoutText(node, measurer, null, { whole: true }).lines.map((l) => l.text)).toEqual([
      "aaaa",
      "bbbb",
      "cccc",
    ]);
  });

  it("sizes truncated text to what shows, through the editor", () => {
    const editor = new Editor({ measurer, clientId: "t" });
    editor.state.set({ role: "editor" });
    editor.doc.apply([
      { op: "create", id: "p", type: "page", parent: ROOT_ID, key: "a0", props: {} },
    ]);
    editor.setPage("p");
    const id = editor.createLayer("text", { x: 0, y: 0, width: 10, height: 10 }, "p", {
      characters: "one\ntwo\nthree",
    }) as string;
    const tall = (editor.doc.get(id) as NodeRecord).props.height as number;
    editor.setProp([id], "maxLines", 1);
    const short = (editor.doc.get(id) as NodeRecord).props.height as number;
    expect(short).toBeCloseTo(tall / 3, 5);
    editor.undo();
    expect((editor.doc.get(id) as NodeRecord).props.height).toBe(tall);
  });
});
