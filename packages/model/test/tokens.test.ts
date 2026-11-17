import { describe, expect, it } from "vitest";
import {
  composeAlpha,
  MemoryStore,
  type NodeRecord,
  numberText,
  parseFontStyle,
  ROOT_ID,
  TokenResolver,
  tokenRefs,
  usesTokens,
} from "../src";

const node = (
  id: string,
  type: NodeRecord["type"],
  parent: string,
  props: Record<string, unknown>,
): NodeRecord => ({ id, type, parent, key: `a${id}`, props }) as NodeRecord;

function file(extra: NodeRecord[] = []) {
  return new MemoryStore([
    node("p", "page", ROOT_ID, {}),
    node("c", "collection", ROOT_ID, {
      modes: [
        { id: "light", name: "Light" },
        { id: "dark", name: "Dark" },
      ],
    }),
    node("bg", "variable", "c", {
      variableType: "color",
      values: { light: "#ffffff", dark: "#000000" },
    }),
    node("gap", "variable", "c", { variableType: "number", values: { light: 4, dark: 8 } }),
    node("on", "variable", "c", { variableType: "boolean", values: { light: true, dark: false } }),
    node("label", "variable", "c", {
      variableType: "string",
      values: { light: "Semi Bold Italic" },
    }),
    node("loopA", "variable", "c", {
      variableType: "number",
      values: { light: { alias: "loopB" } },
    }),
    node("loopB", "variable", "c", {
      variableType: "number",
      values: { light: { alias: "loopA" } },
    }),
    node("dark", "frame", "p", { variableModes: { c: "dark" } }),
    ...extra,
  ]);
}

describe("resolving variables", () => {
  it("takes the nearest mode set, else the default", () => {
    const store = file([node("r", "rect", "dark", {}), node("s", "rect", "p", {})]);
    const resolver = new TokenResolver(store);
    expect(resolver.modeAt("r", "c")).toBe("dark");
    expect(resolver.modeAt("s", "c")).toBe("light");
    expect(resolver.value("gap", "r")).toEqual({ type: "number", value: 8 });
    expect(resolver.value("gap")).toEqual({ type: "number", value: 4 });
  });

  it("gives up on cycles and wrong types, so the stored value shows", () => {
    const store = file([
      node("r", "frame", "p", { gap: 3, bindings: { gap: "loopA", visible: "gap" } }),
    ]);
    const resolver = new TokenResolver(store);
    expect(resolver.value("loopA")).toBeUndefined();
    const r = store.get("r") as NodeRecord;
    expect(resolver.resolve(r)).toBe(r);
  });

  it("resolves layer bindings of every kind", () => {
    const store = file([
      node("t", "text", "dark", {
        bindings: {
          visible: "on",
          fontStyle: "label",
          characters: "gap",
          topRightRadius: "gap",
          opacity: "gap",
        },
      }),
    ]);
    const resolved = new TokenResolver(store).resolve(store.get("t") as NodeRecord);
    expect(resolved.props).toMatchObject({
      visible: false,
      fontWeight: 600,
      fontStyle: "italic",
      characters: "8",
      opacity: 0.08,
    });
  });

  it("resolves paints, stops and effects, and composes alias opacity", () => {
    const store = file([
      node("veil", "variable", "c", {
        variableType: "color",
        values: { light: { alias: "bg", opacity: 0.5 } },
      }),
      node("r", "rect", "dark", {
        fills: [
          { type: "solid", color: "#ff0000", opacity: 0.5, bind: { color: "veil" } },
          {
            type: "linear",
            from: { x: 0, y: 0 },
            to: { x: 1, y: 1 },
            stops: [
              { position: 0, color: "#ff0000", bind: { color: "bg" } },
              { position: 1, color: "#00ff00" },
            ],
          },
        ],
        effects: [
          {
            type: "drop-shadow",
            color: "#000000",
            x: 0,
            y: 0,
            blur: 0,
            spread: 0,
            bind: { y: "gap" },
          },
          { type: "layer-blur", radius: 0, bind: { radius: "gap", visible: "on" } },
        ],
      }),
    ]);
    const p = new TokenResolver(store).resolve(store.get("r") as NodeRecord).props as Record<
      string,
      unknown
    >;
    // The bound colour's alpha replaces the saved opacity (Figma saves the alpha there).
    expect((p.fills as Array<{ opacity?: number }>)[0]?.opacity).toBeUndefined();
    expect(p.fills).toMatchObject([
      { color: "#00000080" },
      { stops: [{ color: "#000000" }, { color: "#00ff00" }] },
    ]);
    expect(p.effects).toMatchObject([{ y: 8 }, { radius: 8, visible: false }]);
  });

  it("applies a linked style, resolved where the layer is", () => {
    const store = file([
      node("st", "paintStyle", ROOT_ID, {
        fills: [{ type: "solid", color: "#123456", bind: { color: "bg" } }],
      }),
      node("r", "rect", "dark", { fills: [{ type: "solid", color: "#ff0000" }], fillStyle: "st" }),
      node("gone", "rect", "p", {
        fills: [{ type: "solid", color: "#ff0000" }],
        fillStyle: "nope",
      }),
    ]);
    const resolver = new TokenResolver(store);
    expect(resolver.resolve(store.get("r") as NodeRecord).props.fills).toEqual([
      { type: "solid", color: "#000000", bind: { color: "bg" } },
    ]);
    // A link to a style that's gone shows the layer's own.
    const gone = store.get("gone") as NodeRecord;
    expect(resolver.resolve(gone).props.fills).toEqual([{ type: "solid", color: "#ff0000" }]);
  });

  it("lists what a node refers to", () => {
    const props = {
      bindings: { gap: "a" },
      fills: [{ type: "solid", color: "#000000", bind: { color: "b" } }],
      effectStyle: "s",
    } as never;
    expect(usesTokens(props)).toBe(true);
    expect(tokenRefs(props)).toEqual({ variables: ["a", "b"], styles: ["s"] });
    expect(usesTokens({ fills: [{ type: "solid", color: "#000000" }] } as never)).toBe(false);
  });

  it("helpers", () => {
    expect(composeAlpha("#ff0000", 0.5)).toBe("#ff000080");
    expect(composeAlpha("#ff000080", 0.5)).toBe("#ff000040");
    expect(numberText(3)).toBe("3");
    expect(numberText(1.005)).toBe("1.00");
    expect(parseFontStyle("Bold")).toEqual({ weight: 700, italic: false });
    expect(parseFontStyle("ExtraLight Italic")).toEqual({ weight: 200, italic: true });
  });
});
