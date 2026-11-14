import { ROOT_ID } from "@drawpane/model";
import { describe, expect, it } from "vitest";
import { cssFor, cssRule, jsxFor, tailwindFor } from "../src/code";
import { Editor } from "../src/editor";
import type { TextMeasurer } from "../src/text";

const measurer: TextMeasurer = { width: (_font, text) => text.length * 8 };

function setup() {
  const editor = new Editor({ measurer, clientId: "test" });
  editor.state.set({ role: "editor" });
  editor.doc.apply([
    { op: "create", id: "p", type: "page", parent: ROOT_ID, key: "a0", props: {} },
  ]);
  editor.setPage("p");
  return editor;
}

const decl = (list: ReturnType<typeof cssFor>) =>
  Object.fromEntries(list.map((d) => [d.property, d.value]));

describe("design to code", () => {
  it("writes auto layout as flexbox with sizing", () => {
    const editor = setup();
    const card = editor.createLayer("frame", { x: 0, y: 0, width: 300, height: 100 }, "p", {
      name: "Hero card",
      layoutMode: "column",
      gap: 12,
      paddingTop: 16,
      paddingBottom: 16,
      paddingLeft: 24,
      paddingRight: 24,
      alignItems: "center",
      cornerRadius: 12,
      sizingV: "hug",
      fills: [{ type: "solid", color: "#ffffff" }],
      effects: [{ type: "drop-shadow", color: "#00000033", x: 0, y: 4, blur: 12, spread: 0 }],
    }) as string;
    const button = editor.createLayer("rect", { x: 0, y: 0, width: 80, height: 32 }, card, {
      sizingH: "fill",
    }) as string;
    const css = decl(cssFor(editor.doc, editor.doc.get(card) as never));
    expect(css).toMatchObject({
      display: "flex",
      "flex-direction": "column",
      "align-items": "center",
      gap: "12px",
      padding: "16px 24px",
      width: "300px",
      height: "fit-content",
      "border-radius": "12px",
      "background-color": "#ffffff",
      "box-shadow": "0px 4px 12px 0px rgb(0 0 0 / 20%)",
    });
    expect(css).not.toHaveProperty("position");
    // A Fill child on the cross axis stretches.
    expect(decl(cssFor(editor.doc, editor.doc.get(button) as never))).toMatchObject({
      "align-self": "stretch",
      height: "32px",
    });
    expect(cssRule(editor.doc, editor.doc.get(card) as never)).toMatch(
      /^\/\* Hero card \*\/\n\.hero-card \{/,
    );
  });

  it("refers to variables by name, with the value in a comment", () => {
    const editor = setup();
    const collection = editor.createCollection("Space") as string;
    const space = editor.createVariable(collection, "space/300", "number", 12) as string;
    const frame = editor.createLayer("frame", { x: 0, y: 0, width: 100, height: 100 }, "p", {
      layoutMode: "row",
    }) as string;
    editor.bindVariable([frame], "gap", space);
    const gap = cssFor(editor.doc, editor.doc.get(frame) as never).find(
      (d) => d.property === "gap",
    );
    expect(gap).toEqual({
      property: "gap",
      value: "var(--space-300)",
      resolved: "12px",
      token: "space/300",
    });
    expect(cssRule(editor.doc, editor.doc.get(frame) as never)).toContain(
      "gap: var(--space-300); /* 12px */",
    );
    expect(tailwindFor(editor.doc, editor.doc.get(frame) as never)).toContain(
      "gap-[var(--space-300)]",
    );
  });

  it("writes truncation as line clamping, and paragraph spacing as spaced paragraphs", () => {
    const editor = setup();
    const id = editor.createLayer("text", { x: 0, y: 0, width: 0, height: 0 }, "p", {
      characters: "First **one**\nSecond",
      maxLines: 2,
      paragraphSpacing: 12,
    }) as string;
    const node = () => editor.doc.get(id) as never;
    expect(decl(cssFor(editor.doc, node()))).toMatchObject({
      display: "-webkit-box",
      "-webkit-box-orient": "vertical",
      "-webkit-line-clamp": "2",
      overflow: "hidden",
    });
    const tw = tailwindFor(editor.doc, node());
    // One class for all four, and none of them on their own.
    expect(tw).toContain("line-clamp-2");
    expect(tw.some((c) => c.includes("webkit") || c.includes("overflow"))).toBe(false);
    const jsx = jsxFor(editor.doc, node());
    expect(jsx).toContain("space-y-[12px]");
    expect(jsx).toMatch(/<p>First \*\*one\*\*<\/p>\n\s*<p>Second<\/p>/);
  });

  it("writes text styles and absolute children of plain frames", () => {
    const editor = setup();
    const frame = editor.createLayer(
      "frame",
      { x: 0, y: 0, width: 300, height: 300 },
      "p",
    ) as string;
    const text = editor.createLayer("text", { x: 20, y: 30, width: 0, height: 0 }, frame, {
      fontSize: 20,
      fontWeight: 600,
      textAlign: "center",
      fills: [{ type: "solid", color: "#16181d" }],
    }) as string;
    editor.updateText(text, "Hello");
    expect(decl(cssFor(editor.doc, editor.doc.get(text) as never))).toMatchObject({
      position: "absolute",
      left: "20px",
      top: "30px",
      color: "#16181d",
      "font-size": "20px",
      "font-weight": "600",
      "line-height": "25px",
      "text-align": "center",
    });
    expect(jsxFor(editor.doc, editor.doc.get(frame) as never)).toContain(
      '<p className="absolute left-5 top-[30px] text-[#16181d]',
    );
  });

  it("maps scale values to Tailwind steps", () => {
    const editor = setup();
    const frame = editor.createLayer("frame", { x: 0, y: 0, width: 64, height: 40 }, "p", {
      layoutMode: "row",
      gap: 8,
      paddingTop: 16,
      paddingRight: 16,
      paddingBottom: 16,
      paddingLeft: 16,
    }) as string;
    expect(tailwindFor(editor.doc, editor.doc.get(frame) as never)).toEqual([
      "flex",
      "gap-2",
      "p-4",
      "w-16",
      "h-10",
      "bg-white",
    ]);
  });

  it("writes grid layout as CSS grid, with areas and self alignment", () => {
    const editor = setup();
    const grid = editor.createLayer("frame", { x: 0, y: 0, width: 400, height: 300 }, "p", {
      layoutMode: "grid",
      gridColumns: [
        { unit: "fr", value: 1 },
        { unit: "fr", value: 1 },
        { unit: "fr", value: 1 },
      ],
      gridRows: [{ unit: "px", value: 120 }, { unit: "auto" }],
      gap: 16,
      rowGap: 8,
      justifyItems: "center",
    }) as string;
    const header = editor.createLayer("rect", { x: 0, y: 0, width: 80, height: 32 }, grid, {
      gridArea: { column: 2, row: 1, columnSpan: 2, rowSpan: 1 },
      sizingH: "fill",
      alignSelf: "end",
    }) as string;
    expect(decl(cssFor(editor.doc, editor.doc.get(grid) as never))).toMatchObject({
      display: "grid",
      "grid-template-columns": "repeat(3, 1fr)",
      "grid-template-rows": "120px auto",
      "justify-items": "center",
      "row-gap": "8px",
      "column-gap": "16px",
    });
    const css = decl(cssFor(editor.doc, editor.doc.get(header) as never));
    expect(css).toMatchObject({
      "grid-column": "2 / span 2",
      "grid-row": "1",
      "align-self": "end",
      "justify-self": "stretch",
    });
    expect(css).not.toHaveProperty("width");
    expect(tailwindFor(editor.doc, editor.doc.get(header) as never)).toEqual(
      expect.arrayContaining([
        "col-start-2",
        "col-span-2",
        "row-start-1",
        "self-end",
        "justify-self-stretch",
      ]),
    );
    expect(tailwindFor(editor.doc, editor.doc.get(grid) as never)).toEqual(
      expect.arrayContaining(["grid", "grid-cols-3", "gap-y-2", "gap-x-4"]),
    );
  });

  it("writes wrapping lines with their own gap", () => {
    const editor = setup();
    const row = editor.createLayer("frame", { x: 0, y: 0, width: 400, height: 300 }, "p", {
      layoutMode: "row",
      layoutWrap: true,
      gap: 8,
      rowGap: 24,
    }) as string;
    expect(decl(cssFor(editor.doc, editor.doc.get(row) as never))).toMatchObject({
      "flex-wrap": "wrap",
      "align-content": "flex-start",
      "row-gap": "24px",
      "column-gap": "8px",
    });
  });
});
