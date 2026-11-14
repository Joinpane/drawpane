import { getProp, type NodeRecord, ROOT_ID, type TextRun } from "@drawpane/model";
import { describe, expect, it } from "vitest";
import { Editor } from "../src/editor";
import { normalizeRuns, rangeProps, remapRuns, styleRange, textSpans } from "../src/rich-text";
import { caretBox, indexAtPoint, layoutText, selectionBoxes } from "../src/text";

/** 10px a character at size 16, scaling with the font size in the font string. */
const measurer = {
  width: (font: string, text: string) =>
    text.length * (Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? 16) / 1.6),
};

function setup() {
  const editor = new Editor({ measurer, clientId: "t" });
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
  const node = (id: string) => editor.doc.get(id) as NodeRecord;
  const runs = (id: string) => getProp(node(id).props, "textRuns");
  return { editor, text, node, runs };
}

/** A bare text node for the pure functions. */
const textNode = (characters: string, textRuns: TextRun[] = [], props = {}): NodeRecord => ({
  id: "t",
  type: "text",
  parent: "p",
  key: "a0",
  props: { characters, textRuns, ...props },
});

describe("normalizeRuns", () => {
  it("sorts, clamps, merges equal neighbours and drops what matches the layer", () => {
    const runs: TextRun[] = [
      { start: 6, end: 9, fontWeight: 700 },
      { start: 0, end: 3, fontWeight: 700 },
      { start: 3, end: 6, fontWeight: 700 },
      { start: 8, end: 40, fontSize: 20 },
      { start: 2, end: 2, fontWeight: 300 } as TextRun,
    ];
    expect(normalizeRuns(runs, 10)).toEqual([
      { start: 0, end: 8, fontWeight: 700 },
      { start: 8, end: 9, fontWeight: 700, fontSize: 20 },
      { start: 9, end: 10, fontSize: 20 },
    ]);
    expect(normalizeRuns(runs, 10, { fontSize: 20 } as never)).toEqual([
      { start: 0, end: 9, fontWeight: 700 },
    ]);
  });
});

describe("styling a range", () => {
  it("styles part of the text and splits the runs around it", () => {
    const node = textNode("Plan your week", [{ start: 0, end: 4, fontWeight: 700 }]);
    expect(styleRange(node, 2, 9, { fills: [{ type: "solid", color: "#e8590c" }] })).toEqual([
      { start: 0, end: 2, fontWeight: 700 },
      { start: 2, end: 4, fontWeight: 700, fills: [{ type: "solid", color: "#e8590c" }] },
      { start: 4, end: 9, fills: [{ type: "solid", color: "#e8590c" }] },
    ]);
  });

  it("takes a property back to the layer's value with null", () => {
    const node = textNode("Plan your week", [{ start: 0, end: 4, fontWeight: 700 }]);
    expect(styleRange(node, 0, 14, { fontWeight: null })).toEqual([]);
    // Setting the layer's own value leaves no override either.
    expect(styleRange(node, 0, 4, { fontWeight: 400 })).toEqual([]);
  });

  it("reads back each distinct look in a range", () => {
    const node = textNode("Plan your week", [{ start: 5, end: 9, fontWeight: 700 }]);
    expect(rangeProps(node, 0, 4).map((p) => getProp(p, "fontWeight"))).toEqual([400]);
    expect(rangeProps(node, 3, 7).map((p) => getProp(p, "fontWeight"))).toEqual([400, 700]);
    // A caret reads what typing there would get: the character before it.
    expect(rangeProps(node, 9, 9).map((p) => getProp(p, "fontWeight"))).toEqual([700]);
  });
});

describe("remapping runs as text changes", () => {
  const bold = textNode("Plan your week", [{ start: 5, end: 9, fontWeight: 700 }]);

  it("continues the style of the character before what's typed", () => {
    expect(remapRuns(bold, "Plan yours week")).toEqual([{ start: 5, end: 10, fontWeight: 700 }]);
    expect(remapRuns(bold, "Plan your next week")).toEqual([{ start: 5, end: 9, fontWeight: 700 }]);
    // At the very start, typing takes the style of the first character.
    expect(remapRuns(textNode("week", [{ start: 0, end: 4, fontWeight: 700 }]), "A week")).toEqual([
      { start: 0, end: 6, fontWeight: 700 },
    ]);
  });

  it("shifts and shrinks runs around a deletion", () => {
    expect(remapRuns(bold, "Plan week")).toEqual([]);
    expect(remapRuns(bold, "Pl your week")).toEqual([{ start: 3, end: 7, fontWeight: 700 }]);
    expect(remapRuns(bold, "Plan yo week")).toEqual([{ start: 5, end: 7, fontWeight: 700 }]);
  });

  it("gives inserted text its own style when asked (⌘B at a caret)", () => {
    expect(
      remapRuns(textNode("Plan week"), "Plan new week", { inserted: { fontWeight: 700 } }),
    ).toEqual([{ start: 5, end: 9, fontWeight: 700 }]);
  });

  it("puts the edit where the editor says it was", () => {
    const node = textNode("Plan week", [{ start: 0, end: 4, fontWeight: 700 }]);
    // A space typed right after the bold "Plan" continues it…
    expect(remapRuns(node, "Plan  week", { edit: { start: 4, end: 4, caret: 5 } })).toEqual([
      { start: 0, end: 5, fontWeight: 700 },
    ]);
    // …though the strings alone read it as typed after the space that was there.
    expect(remapRuns(node, "Plan  week")).toEqual([{ start: 0, end: 4, fontWeight: 700 }]);
  });

  it("gives replaced text the style of what it replaces", () => {
    expect(remapRuns(bold, "Plan YOUR week", { edit: { start: 5, end: 9, caret: 9 } })).toEqual([
      { start: 5, end: 9, fontWeight: 700 },
    ]);
  });

  it("never splits an emoji", () => {
    const node = textNode("a😀b", [{ start: 1, end: 3, fontWeight: 700 }]);
    expect(remapRuns(node, "a😁b")).toEqual([{ start: 1, end: 3, fontWeight: 700 }]);
  });
});

describe("rich text layout", () => {
  it("draws each style as its own fragment, and a line as tall as its biggest text", () => {
    const node = textNode("Big small", [{ start: 0, end: 3, fontSize: 32 }]);
    const layout = layoutText(node, measurer, null);
    const line = layout.lines[0];
    expect(line?.fragments.map((f) => [f.text, f.fontSize, f.x, f.width])).toEqual([
      ["Big", 32, 0, 60],
      [" small", 16, 60, 60],
    ]);
    // 32 × 1.25 = 40, the bigger of the two line heights.
    expect(line?.height).toBe(40);
    expect(layout.height).toBe(40);
    expect(textSpans(node)).toHaveLength(2);
  });

  it("wraps words across styles", () => {
    const node = textNode("aaaa bbbb cccc", [{ start: 5, end: 9, fontSize: 32 }], {
      textAutoResize: "height",
      width: 100,
    });
    const layout = layoutText(node, measurer, 100);
    expect(layout.lines.map((l) => [l.start, l.end])).toEqual([
      [0, 4],
      [5, 9],
      [10, 14],
    ]);
  });

  it("places the caret, finds the character under a point, and highlights a selection", () => {
    const node = textNode("Big small", [{ start: 0, end: 3, fontSize: 32 }], { width: 120 });
    const layout = layoutText(node, measurer, null);
    expect(caretBox(node, layout, measurer, 3)).toEqual({ x: 60, y: 0, height: 40 });
    expect(caretBox(node, layout, measurer, 5)).toMatchObject({ x: 80 });
    expect(indexAtPoint(node, layout, measurer, 47, 10)).toBe(2);
    expect(indexAtPoint(node, layout, measurer, 500, 10)).toBe(9);
    expect(selectionBoxes(node, layout, measurer, 1, 5)).toEqual([
      { x: 20, y: 0, width: 60, height: 40 },
    ]);
  });
});

describe("editing rich text", () => {
  it("styles the selected characters while editing, and the layer otherwise", () => {
    const { editor, text, node, runs } = setup();
    const id = text("Plan your week");
    editor.startTextEdit(id);
    editor.setTextSelection(5, 9);
    editor.setProp([id], "fontWeight", 700);
    expect(runs(id)).toEqual([{ start: 5, end: 9, fontWeight: 700 }]);
    expect(getProp(node(id).props, "fontWeight")).toBe(400);
    // The inspector's null (the default) is stated outright on a run.
    editor.setTextSelection(0, 14);
    editor.setProp([id], "fontWeight", null);
    expect(runs(id)).toEqual([]);
    editor.endTextEdit();

    // Not editing: the whole layer, and the runs let go of that property.
    editor.startTextEdit(id);
    editor.setTextSelection(0, 4);
    editor.setProp([id], "fontSize", 24);
    editor.endTextEdit();
    expect(runs(id)).toEqual([{ start: 0, end: 4, fontSize: 24 }]);
    editor.setProp([id], "fontSize", 18);
    expect(runs(id)).toEqual([]);
    expect(getProp(node(id).props, "fontSize")).toBe(18);
  });

  it("keeps runs in step as the text is typed, and undoes with it", () => {
    const { editor, text, runs } = setup();
    const id = text("Plan your week");
    editor.startTextEdit(id);
    editor.setTextSelection(5, 9);
    editor.toggleTextStyle("bold");
    expect(runs(id)).toEqual([{ start: 5, end: 9, fontWeight: 700 }]);
    editor.updateText(id, "Plan yours week");
    expect(runs(id)).toEqual([{ start: 5, end: 10, fontWeight: 700 }]);
    editor.updateText(id, "Plan week");
    expect(runs(id)).toEqual([]);
    editor.endTextEdit();
    editor.undo();
    expect(runs(id)).toEqual([]);
    expect(getProp((editor.doc.get(id) as NodeRecord).props, "characters")).toBe("Plan your week");
  });

  it("⌘B at a caret makes the next characters bold, and toggles off over bold text", () => {
    const { editor, text, runs } = setup();
    const id = text("Plan week");
    editor.startTextEdit(id);
    editor.setTextSelection(5, 5);
    editor.toggleTextStyle("bold");
    editor.updateText(id, "Plan bweek", 6);
    expect(runs(id)).toEqual([{ start: 5, end: 6, fontWeight: 700 }]);
    // Typing on continues it.
    editor.setTextSelection(6, 6);
    editor.updateText(id, "Plan boweek", 7);
    expect(runs(id)).toEqual([{ start: 5, end: 7, fontWeight: 700 }]);
    // ⌘B over the bold word turns it back.
    editor.setTextSelection(5, 7);
    editor.toggleTextStyle("bold");
    expect(runs(id)).toEqual([]);
  });

  it("clears the runs' typography when a text style is applied", () => {
    const { editor, text, runs } = setup();
    const id = text("Plan your week", {
      textRuns: [
        { start: 0, end: 4, fontWeight: 700, fills: [{ type: "solid", color: "#ff0000" }] },
      ],
    });
    const style = editor.createTextStyle("body", id) as string;
    const other = text("Other");
    editor.applyTextStyle([id, other], style);
    expect(runs(id)).toEqual([{ start: 0, end: 4, fills: [{ type: "solid", color: "#ff0000" }] }]);
  });
});

describe("rich text in SVG", () => {
  it("anchors each line and states only what a fragment changes", async () => {
    const { exportSvg } = await import("../src/svg");
    const { editor, text } = setup();
    const id = text("Plan your week", {
      textAlign: "center",
      textAutoResize: "none",
      width: 200,
      fills: [{ type: "solid", color: "#1c1b1a" }],
      textRuns: [
        { start: 5, end: 9, fontWeight: 700, fills: [{ type: "solid", color: "#e8590c" }] },
      ],
    });
    const bounds = editor.scene.bounds(id);
    if (!bounds) throw new Error("no bounds");
    const svg = exportSvg(editor.scene, measurer, [id], bounds);
    expect(svg).toContain('text-anchor="middle"');
    expect(svg).toContain(
      '<tspan x="100" y="14.8">Plan <tspan font-weight="700" fill="#e8590c">your</tspan> week</tspan>',
    );
  });
});

describe("previewing while typing", () => {
  it("backs out of a font preview without undoing the typing around it", () => {
    const { editor, text, node } = setup();
    const id = text("Plan");
    editor.startTextEdit(id);
    editor.updateText(id, "Plan week");
    editor.beginGesture("Preview font");
    editor.setProp([id], "fontFamily", "Georgia");
    editor.cancelGesture();
    expect(getProp(node(id).props, "fontFamily")).toBe("Instrument Sans");
    expect(getProp(node(id).props, "characters")).toBe("Plan week");
    // Still typing: the outer gesture stays open, and closes as one undo step.
    expect(editor.s.gesture).toBe(true);
    editor.endTextEdit();
    expect(editor.s.gesture).toBe(false);
    editor.undo();
    expect(getProp(node(id).props, "characters")).toBe("Plan");
  });
});

describe("rich text as code", () => {
  it("writes styled runs as spans with what they change", async () => {
    const { jsxFor } = await import("../src/code");
    const { editor, text, node } = setup();
    const id = text("Plan your week", {
      textRuns: [
        { start: 5, end: 9, fontWeight: 700, fills: [{ type: "solid", color: "#e8590c" }] },
      ],
    });
    expect(jsxFor(editor.doc, node(id))).toContain(
      'Plan <span className="font-[700] text-[#e8590c]">your</span> week</p>',
    );
  });
});
