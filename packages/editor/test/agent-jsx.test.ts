import { getProp, PROPS, type PropName, ROOT_ID } from "@drawpane/model";
import { describe, expect, it } from "vitest";
import { type JsxElement, JsxError, jsxToTrees, nodeToJsx, parseJsx } from "../src/agent/jsx";
import { Editor } from "../src/editor";
import type { TextMeasurer } from "../src/text";

const measurer: TextMeasurer = {
  width: (font, text) => text.length * Number(font.match(/(\d+(?:\.\d+)?)px/)?.[1] ?? 16) * 0.5,
};

function setup() {
  const editor = new Editor({ measurer, clientId: "test" });
  editor.state.set({ role: "editor" });
  editor.doc.apply([
    { op: "create", id: "p", type: "page", parent: ROOT_ID, key: "a0", props: {} },
  ]);
  editor.setPage("p");
  return editor;
}

describe("parsing", () => {
  it("reads elements, attributes as strings, JSON or bare, and text", () => {
    const [card] = parseJsx(`
      {/* A card */}
      <Frame name="Card" gap={12} effects={[{"type":"drop-shadow","x":0,"y":4,"blur":12,"spread":0,"color":"#00000033"}]} clip>
        <Text size={20}>Plan &amp; ship</Text>
        <Rect w="fill" h={1} />
      </Frame>`);
    expect(card?.tag).toBe("Frame");
    expect(card?.attrs).toEqual([
      { name: "name", value: "Card" },
      { name: "gap", value: 12 },
      {
        name: "effects",
        value: [{ type: "drop-shadow", x: 0, y: 4, blur: 12, spread: 0, color: "#00000033" }],
      },
      { name: "clip", value: true },
    ]);
    const [text, rule] = (card as JsxElement).children as unknown as [
      { children: string[] },
      { tag: string },
    ];
    expect(text.children).toEqual(["Plan & ship"]);
    expect(rule.tag).toBe("Rect");
  });

  it("joins text over several lines as JSX does", () => {
    const [el] = parseJsx(`<Text>
      Three things
      on today
    </Text>`);
    expect(el?.children).toEqual(["Three things on today"]);
  });

  it("says where it went wrong", () => {
    expect(() => parseJsx("<Frame>\n  <Text>Hi</Frame>")).toThrow(
      /<\/Frame> closes <Text> \(line 2/,
    );
    expect(() => parseJsx("<Frame gap={12")).toThrow(JsxError);
    expect(() => parseJsx("<Frame gap={twelve} />")).toThrow(/isn't a number/);
  });
});

describe("JSX to layers", () => {
  it("maps the short forms to model properties", () => {
    const [frame] = jsxToTrees(
      `<Frame flex="col" justify="between" align="center" p={16} px={24} gap={8} fill="#FFF" radius={[8,8,0,0]} w="fill"><Text size={14} weight={600} lineHeight="150%" tracking={-0.2} align="center">Hi</Text></Frame>`,
    );
    expect(frame?.type).toBe("frame");
    expect(frame?.props).toMatchObject({
      layoutMode: "column",
      justifyContent: "space-between",
      alignItems: "center",
      paddingTop: 16,
      paddingBottom: 16,
      paddingLeft: 24,
      paddingRight: 24,
      gap: 8,
      fills: [{ type: "solid", color: "#ffffff" }],
      cornerRadii: [8, 8, 0, 0],
      sizingH: "fill",
      // Auto layout hugs its content down when not told otherwise.
      sizingV: "hug",
    });
    expect(frame?.children?.[0]?.props).toMatchObject({
      characters: "Hi",
      fontSize: 14,
      fontWeight: 600,
      lineHeight: { unit: "percent", value: 150 },
      letterSpacing: { unit: "px", value: -0.2 },
      textAlign: "center",
    });
  });

  it("wraps a text given a width", () => {
    const [text] = jsxToTrees(`<Text w={200}>A long line</Text>`);
    expect(text?.props).toMatchObject({ width: 200, textAutoResize: "height" });
  });

  it("refuses what the model wouldn't take, saying which attribute", () => {
    expect(() => jsxToTrees(`<Frame fill="red" />`)).toThrow(/fill="red" isn't a colour/);
    expect(() => jsxToTrees(`<Button />`)).toThrow(/<Button> isn't a layer/);
    expect(() => jsxToTrees(`<Frame colour="#fff" />`)).toThrow(/no attribute "colour"/);
    expect(() => jsxToTrees(`<Rect size={12} />`)).toThrow(/can't take fontSize/);
    expect(() => jsxToTrees(`<Frame>Hello</Frame>`)).toThrow(/wrap it in <Text>/);
    expect(() => jsxToTrees(`<Frame opacity={2} />`)).toThrow(/opacity/);
  });
});

describe("layers to JSX", () => {
  it("writes back what render reads, so a layer round-trips", () => {
    const editor = setup();
    const source = `<Frame name="Card" flex="col" gap={12} p={16} fill="#ffffff" radius={12} w={320} clip>
      <Text size={20} weight={600}>Plan your week</Text>
      <Rect name="Rule" w="fill" h={1} fill="#e6e4df" />
    </Frame>`;
    const [id] = editor.createTrees("p", jsxToTrees(source));
    const jsx = nodeToJsx(editor.doc, id as string, { ids: false });
    expect(jsx).toContain('<Frame name="Card"');
    expect(jsx).toContain('flex="col"');
    expect(jsx).toContain("p={16}");
    expect(jsx).toContain("<Text weight={600} size={20}>Plan your week</Text>");
    // Rendering what was read gives the same layers, property for property.
    const [again] = editor.createTrees("p", jsxToTrees(jsx));
    const strip = (nodeId: string): unknown => {
      const node = editor.doc.get(nodeId);
      const { x: _x, y: _y, ...props } = node?.props ?? {};
      // What a property is set to, not whether its default is written out.
      const meaning = Object.fromEntries(
        Object.entries(props).filter(
          ([k, v]) => JSON.stringify(v) !== JSON.stringify(PROPS[k as PropName].default),
        ),
      );
      return { type: node?.type, props: meaning, children: editor.doc.childIds(nodeId).map(strip) };
    };
    expect(strip(again as string)).toEqual(strip(id as string));
  });

  it("cuts deep trees short, saying how to read the rest", () => {
    const editor = setup();
    const [id] = editor.createTrees(
      "p",
      jsxToTrees(`<Frame><Frame><Frame><Rect /></Frame></Frame></Frame>`),
    );
    const jsx = nodeToJsx(editor.doc, id as string, { depth: 1 });
    expect(jsx).toMatch(/1 layers not shown: read \S+ for them/);
    expect(getProp(editor.doc.get(id as string)?.props ?? {}, "width")).toBe(100);
  });
});
