import { getProp, type NodeRecord, type Props, ROOT_ID } from "@drawpane/model";
import { describe, expect, it } from "vitest";
import { Editor } from "../src/editor";
import { paragraphList, paragraphRanges } from "../src/rich-text";
import {
  LIST_INDENT_EM,
  LIST_NUMBER_GAP_EM,
  layoutText,
  lineOffset,
  type TextMeasurer,
} from "../src/text";

/** Every character 10 px wide at 20 px, scaling with the size; ascent 0.8 em, descent 0.2. */
const measurer: TextMeasurer = {
  width: (font, text) => text.length * (Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? 16) / 2),
  metrics: (font) => {
    const size = Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? 16);
    return { ascent: size * 0.8, descent: size * 0.2 };
  },
};

const text = (characters: string, props: Partial<Props> = {}): NodeRecord =>
  ({
    id: "t",
    type: "text",
    parent: ROOT_ID,
    key: "a0",
    props: { characters, fontSize: 20, ...props } as Props,
  }) as NodeRecord;

/** Runs putting each paragraph in `kinds[i]` at `levels[i]`. */
function lists(characters: string, kinds: string[], levels: number[] = []) {
  const runs: Array<Record<string, unknown>> = [];
  let start = 0;
  characters.split("\n").forEach((line, i) => {
    const end = Math.min(characters.length, start + line.length + 1);
    if (kinds[i] !== "none")
      runs.push({ start, end, listType: kinds[i], ...(levels[i] ? { listLevel: levels[i] } : {}) });
    start = end;
  });
  return text(characters, { textRuns: runs } as Partial<Props>);
}

describe("paragraph ranges", () => {
  it("are the paragraphs a caret or selection touches, each through its line break", () => {
    const t = "ab\ncd\nef";
    expect(paragraphRanges(t, 4, 4)).toEqual([{ start: 3, end: 6, first: 3 }]);
    expect(paragraphRanges(t, 1, 7)).toEqual([
      { start: 0, end: 3, first: 0 },
      { start: 3, end: 6, first: 3 },
      { start: 6, end: 8, first: 6 },
    ]);
    // Ending where the next paragraph starts: not that one.
    expect(paragraphRanges(t, 0, 3)).toEqual([{ start: 0, end: 3, first: 0 }]);
  });

  it("set an empty last paragraph through the line break before it", () => {
    expect(paragraphRanges("ab\n", 3, 3)).toEqual([{ start: 2, end: 3, first: 3 }]);
    expect(paragraphRanges("", 0, 0)).toEqual([]);
  });

  it("read a paragraph's list from its first character, or the end for an empty last one", () => {
    const node = lists("a\nb\n", ["bullet", "number"], [0, 2]);
    expect(paragraphList(node, 0)).toEqual({ listType: "bullet", listLevel: 0 });
    expect(paragraphList(node, 2)).toEqual({ listType: "number", listLevel: 2 });
    // The empty last paragraph continues the list before it.
    expect(paragraphList(node, 4).listType).toBe("number");
  });
});

describe("list layout", () => {
  it("indents items a level at a time and marks each one's first line", () => {
    const node = lists("one\ntwo\nthree", ["bullet", "bullet", "bullet"], [0, 1, 0]);
    const { lines } = layoutText(node, measurer, null);
    expect(lines.map((l) => l.indent)).toEqual([30, 60, 30]);
    expect(lines.map((l) => l.marker?.text)).toEqual(["•", "•", "•"]);
    // A bullet centred in its level's last indent.
    const bullet = lines[0]?.marker;
    expect((bullet?.x ?? 0) + (bullet?.width ?? 0) / 2).toBe(-(LIST_INDENT_EM / 2) * 20);
    expect(lineOffset(lines[1] as never, 400, node.props)).toBe(60);
  });

  it("numbers items per level, starting over after a paragraph out of the list", () => {
    const node = lists(
      "a\nb\nc\nd\ne\nf",
      ["number", "number", "number", "number", "none", "number"],
      [0, 1, 1, 0, 0, 0],
    );
    const markers = layoutText(node, measurer, null).lines.map((l) => l.marker?.text ?? null);
    expect(markers).toEqual(["1.", "1.", "2.", "2.", null, "1."]);
    const number = layoutText(node, measurer, null).lines[0]?.marker;
    // Ending a measured gap before the text.
    expect((number?.x ?? 0) + (number?.width ?? 0)).toBe(-LIST_NUMBER_GAP_EM * 20);
  });

  it("wraps an item within its indent, its later lines hanging under its text", () => {
    const node = lists("aaaa bbbb cccc", ["bullet"]);
    const { lines, width } = layoutText(node, measurer, 130);
    // 130 wide less the 30 indent leaves 100: two 4-letter words (40 each, a space 10).
    expect(lines.map((l) => l.text)).toEqual(["aaaa bbbb", "cccc"]);
    expect(lines.map((l) => [l.indent, l.marker?.text ?? null])).toEqual([
      [30, "•"],
      [30, null],
    ]);
    expect(width).toBe(30 + 90);
  });
});

describe("list commands", () => {
  function setup() {
    const editor = new Editor({ measurer, clientId: "t" });
    editor.state.set({ role: "editor" });
    editor.doc.apply([
      { op: "create", id: "p", type: "page", parent: ROOT_ID, key: "a0", props: {} },
    ]);
    editor.setPage("p");
    const id = editor.createLayer("text", { x: 0, y: 0, width: 10, height: 10 }, "p", {
      characters: "Plan\nBook\nSend",
    }) as string;
    const node = () => editor.doc.get(id) as NodeRecord;
    const kinds = () =>
      [0, 5, 10].map((first) => {
        const l = paragraphList(node(), first);
        return `${l.listType}:${l.listLevel}`;
      });
    return { editor, id, node, kinds };
  }

  it("put the paragraphs the caret or selection touches in a list, and take them out", () => {
    const { editor, id, kinds } = setup();
    editor.startTextEdit(id);
    editor.setTextSelection(6, 6);
    editor.toggleList("bullet");
    expect(kinds()).toEqual(["none:0", "bullet:0", "none:0"]);
    editor.setTextSelection(2, 12);
    editor.toggleList("number");
    expect(kinds()).toEqual(["number:0", "number:0", "number:0"]);
    // All numbered already: numbering comes off.
    editor.toggleList("number");
    expect(kinds()).toEqual(["none:0", "none:0", "none:0"]);
  });

  it("set a list outright, whatever the touched paragraphs had: one step, or none if it's so already", () => {
    const { editor, id, node, kinds } = setup();
    editor.startTextEdit(id);
    editor.setTextSelection(0, 9);
    editor.toggleList("bullet");
    editor.setTextSelection(6, 12);
    // Mixed (a bullet and a plain paragraph): a list type makes both that, unlike a toggle.
    editor.setList("number");
    expect(kinds()).toEqual(["bullet:0", "number:0", "number:0"]);
    const before = node().props;
    editor.setList("number");
    expect(node().props).toBe(before);
    editor.setList("none");
    expect(kinds()).toEqual(["bullet:0", "none:0", "none:0"]);
  });

  it("nest list items, and leave paragraphs out of a list alone", () => {
    const { editor, id, kinds } = setup();
    editor.startTextEdit(id);
    editor.setTextSelection(0, 9);
    editor.toggleList("bullet");
    editor.setTextSelection(6, 6);
    expect(editor.nestList(1)).toBe(true);
    expect(kinds()).toEqual(["bullet:0", "bullet:1", "none:0"]);
    expect(editor.nestList(-1)).toBe(true);
    expect(editor.nestList(-1)).toBe(true);
    expect(kinds()).toEqual(["bullet:0", "bullet:0", "none:0"]);
    editor.setTextSelection(12, 12);
    expect(editor.nestList(1)).toBe(false);
  });

  it("act on whole layers when the text isn't being edited, in one undo step", () => {
    const { editor, id, kinds } = setup();
    editor.select([id]);
    editor.toggleList("number");
    expect(kinds()).toEqual(["number:0", "number:0", "number:0"]);
    expect(editor.listState()).toEqual({ listType: "number", listLevel: 0 });
    editor.undo();
    expect(kinds()).toEqual(["none:0", "none:0", "none:0"]);
  });

  it("continue a list on a new line", () => {
    const { editor, id, node, kinds } = setup();
    editor.startTextEdit(id);
    editor.setTextSelection(0, 0);
    editor.toggleList("bullet");
    // Enter at the end of the first item.
    editor.updateText(id, "Plan\n\nBook\nSend", 5);
    expect(paragraphList(node(), 5).listType).toBe("bullet");
    expect(kinds()[0]).toBe("bullet:0");
  });

  it('turn "- " or "1. " typed at a paragraph\'s start into a list item', () => {
    const { editor, id, node } = setup();
    editor.startTextEdit(id);
    // "- " typed at the start of the second paragraph.
    editor.updateText(id, "Plan\n- Book\nSend", 7);
    editor.setTextSelection(7, 7);
    expect(editor.autoList(id)).toBe(5);
    expect(getProp(node().props, "characters")).toBe("Plan\nBook\nSend");
    expect(paragraphList(node(), 5).listType).toBe("bullet");
    // The other paragraphs stay as they were.
    expect(paragraphList(node(), 0).listType).toBe("none");
    expect(paragraphList(node(), 10).listType).toBe("none");

    // Not at a paragraph's start, or not that prefix: left alone.
    editor.updateText(id, "Plan - Book", 7);
    editor.setTextSelection(7, 7);
    expect(editor.autoList(id)).toBeNull();
    editor.updateText(id, "1. Plan", 3);
    editor.setTextSelection(3, 3);
    expect(editor.autoList(id)).toBe(0);
    expect(paragraphList(node(), 0).listType).toBe("number");
  });
});
