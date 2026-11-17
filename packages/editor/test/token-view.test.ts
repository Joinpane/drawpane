/**
 * Variables and styles resolved where each layer is (decision 0034), with
 * copies compact (decision 0029) or not: a card whose fill, padding and
 * shadow (through an effect style) are bound, copied into a frame set to
 * Dark. Nothing is written into compact copies when a variable or a mode
 * changes; the document presents what they resolve to, and names them in
 * its change.
 */
import { getProp, keyBetween, type Op, ROOT_ID } from "@drawpane/model";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compactCopiesDefault, type DocChange, setCompactCopiesDefault } from "../src/doc";
import { Editor } from "../src/editor";
import type { TextMeasurer } from "../src/text";

const measurer: TextMeasurer = {
  width: (font, text) => text.length * Number(font.match(/(\d+(?:\.\d+)?)px/)?.[1] ?? 16) * 0.5,
};

const props = (editor: Editor, id: string) => editor.doc.get(id)?.props ?? {};
const fillOf = (editor: Editor, id: string) => {
  const fill = getProp(props(editor, id), "fills")[0];
  return fill?.type === "solid" ? fill.color : undefined;
};
const shadowOf = (editor: Editor, id: string) => {
  const e = getProp(props(editor, id), "effects")[0];
  return e?.type === "drop-shadow" ? { y: e.y, color: e.color } : undefined;
};

function setup() {
  const editor = new Editor({ measurer, clientId: "test" });
  editor.state.set({ role: "editor" });
  editor.doc.apply([
    { op: "create", id: "p", type: "page", parent: ROOT_ID, key: "a0", props: {} },
  ]);
  editor.setPage("p");

  const theme = editor.createCollection("Theme") as string;
  const light = getProp(props(editor, theme), "modes")[0]?.id as string;
  const dark = editor.addMode(theme, "Dark") as string;
  const bg = editor.createVariable(theme, "bg", "color", "#ffffff") as string;
  editor.setVariableValue(bg, dark, "#111111");
  const pad = editor.createVariable(theme, "pad", "number", 8) as string;
  editor.setVariableValue(pad, dark, 16);
  // A second collection whose token aliases the theme, at half opacity.
  const tokens = editor.createCollection("Tokens") as string;
  const shade = editor.createVariable(tokens, "shadow/color", "color", "#000000") as string;
  const tokensMode = getProp(props(editor, tokens), "modes")[0]?.id as string;
  editor.setVariableValue(shade, tokensMode, { alias: bg, opacity: 0.5 });
  const fall = editor.createVariable(theme, "shadow/y", "number", 0) as string;
  editor.setVariableValue(fall, dark, 8);

  const style = "es";
  const last = editor.doc.childIds(ROOT_ID).at(-1) as string;
  editor.commit([
    {
      op: "create",
      id: style,
      type: "effectStyle",
      parent: ROOT_ID,
      key: keyBetween(editor.doc.get(last)?.key ?? null, null),
      props: {
        name: "shadow/card",
        effects: [
          {
            type: "drop-shadow",
            color: "#00000040",
            x: 0,
            y: 0,
            blur: 4,
            spread: 0,
            bind: { y: fall, color: shade },
          },
        ],
      },
    },
  ]);

  const card = editor.createLayer("frame", { x: 0, y: 0, width: 40, height: 20 }, "p", {
    layoutMode: "row",
    sizingH: "hug",
    paddingLeft: 8,
    fills: [{ type: "solid", color: "#ffffff", bind: { color: bg } }],
    effectStyle: style,
    bindings: { paddingLeft: pad },
  }) as string;
  const dot = editor.createLayer("rect", { x: 0, y: 0, width: 10, height: 10 }, card) as string;
  editor.select([card]);
  editor.createComponent();
  editor.select([]);

  const darkFrame = editor.createLayer("frame", { x: 200, y: 0, width: 200, height: 200 }, "p", {
    variableModes: { [theme]: dark },
  }) as string;
  editor.select([darkFrame]);
  const copy = editor.insertInstance(card, { x: 210, y: 10 }) as string;
  if (editor.doc.get(copy)?.parent !== darkFrame)
    editor.commit([{ op: "move", id: copy, parent: darkFrame, key: "a1" }]);
  editor.select([]);
  const copyDot = editor.doc.childIds(copy)[0] as string;
  return { editor, theme, light, dark, bg, pad, fall, card, dot, copy, copyDot, darkFrame };
}

describe.each([
  ["compact", true],
  ["materialized", false],
])("variables resolved where layers are, copies %s", (_, compact) => {
  let previous = false;
  beforeEach(() => {
    previous = compactCopiesDefault();
    setCompactCopiesDefault(compact);
  });
  afterEach(() => setCompactCopiesDefault(previous));

  it("shows a copy in its frame's mode, stored as its main", () => {
    const k = setup();
    const { editor } = k;
    expect(editor.doc.compactCopies).toBe(compact);
    expect(fillOf(editor, k.card)).toBe("#ffffff");
    expect(fillOf(editor, k.copy)).toBe("#111111");
    expect(props(editor, k.copy).paddingLeft).toBe(16);
    // The shadow comes from the effect style, its colour aliased across collections at 50%.
    expect(shadowOf(editor, k.card)).toEqual({ y: 0, color: "#ffffff80" });
    expect(shadowOf(editor, k.copy)).toEqual({ y: 8, color: "#11111180" });
    // Laid out with the copy's padding: its dot sits 16 in.
    expect(props(editor, k.copyDot).x).toBe(16);
    expect(props(editor, k.dot).x).toBe(8);
    // A compact copy stores no fill or shadow of its own: they're its main's, resolved where it is.
    if (compact) {
      const stored = editor.doc.storedReader().get(k.copy)?.props ?? {};
      expect(stored.fills).toBeUndefined();
      expect(stored.effects).toBeUndefined();
    }
  });

  it("updates every bound layer when a variable changes, writing only the variable", () => {
    const k = setup();
    const { editor } = k;
    const changes: DocChange[] = [];
    editor.doc.subscribe((c) => changes.push(c));
    editor.setVariableValue(k.bg, k.dark, "#222222");
    expect(fillOf(editor, k.copy)).toBe("#222222");
    expect(fillOf(editor, k.card)).toBe("#ffffff");
    // The shadow's colour aliases it too.
    expect(shadowOf(editor, k.copy)).toEqual({ y: 8, color: "#22222280" });
    // What changed names the layers that resolve differently.
    const named = new Set(changes.flatMap((c) => [...c.ids]));
    expect(named.has(k.copy)).toBe(true);
    expect(named.has(k.card)).toBe(true);
    // Stored: the variable's value, and nothing in the layers.
    const stored = editor.doc.lastStoredOps;
    expect(stored.every((op: Op) => op.id === k.bg)).toBe(true);
  });

  it("lays out again when a number variable a layout reads changes", () => {
    const k = setup();
    const { editor } = k;
    editor.setVariableValue(k.pad, k.dark, 24);
    expect(props(editor, k.copy).paddingLeft).toBe(24);
    expect(props(editor, k.copyDot).x).toBe(24);
    expect(props(editor, k.dot).x).toBe(8);
  });

  it("follows a mode switch, and undo puts it back", () => {
    const k = setup();
    const { editor } = k;
    editor.setVariableMode(k.darkFrame, k.theme, k.light);
    expect(fillOf(editor, k.copy)).toBe("#ffffff");
    expect(shadowOf(editor, k.copy)).toEqual({ y: 0, color: "#ffffff80" });
    expect(props(editor, k.copyDot).x).toBe(8);
    editor.undo();
    expect(fillOf(editor, k.copy)).toBe("#111111");
    expect(props(editor, k.copyDot).x).toBe(16);
  });

  it("follows an effect style edit in every layer that links it", () => {
    const k = setup();
    const { editor } = k;
    const style = editor.doc.get("es");
    const effects = getProp(style?.props ?? {}, "effects");
    editor.commit([
      {
        op: "set",
        id: "es",
        prop: "effects",
        value: effects.map((e) => (e.type === "drop-shadow" ? { ...e, blur: 12 } : e)),
      },
    ]);
    const blurOf = (id: string) => {
      const e = getProp(props(editor, id), "effects")[0];
      return e?.type === "drop-shadow" ? e.blur : undefined;
    };
    expect(blurOf(k.card)).toBe(12);
    expect(blurOf(k.copy)).toBe(12);
  });

  it("detaches only the paint field set by hand", () => {
    const k = setup();
    const { editor } = k;
    const fills = getProp(props(editor, k.card), "fills");
    editor.setProp(
      [k.card],
      "fills",
      fills.map((f) => (f.type === "solid" ? { ...f, color: "#00ff00" } : f)),
    );
    expect(fillOf(editor, k.card)).toBe("#00ff00");
    const fill = getProp(props(editor, k.card), "fills")[0];
    expect(fill && "bind" in fill ? fill.bind : undefined).toBeUndefined();
    // Changing the variable no longer reaches it.
    editor.setVariableValue(k.bg, k.light, "#eeeeee");
    expect(fillOf(editor, k.card)).toBe("#00ff00");
  });
});
