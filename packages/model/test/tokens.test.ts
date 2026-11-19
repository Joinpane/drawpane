import { describe, expect, it } from "vitest";
import {
  boundAlike,
  checkNode,
  composeAlpha,
  heldNodeIds,
  MemoryStore,
  type NodeRecord,
  numberText,
  parseFontStyle,
  ROOT_ID,
  renameTokenIds,
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
          characters: { variable: "gap", unit: "text" },
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
    // The bound colour gives the colour and its alpha; the paint's own opacity is a person's,
    // on top (Figma's duplicated alpha is folded into the colour at import, not here).
    expect((p.fills as Array<{ opacity?: number }>)[0]?.opacity).toBe(0.5);
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

describe("text style bindings (F13)", () => {
  it("a text style may bind its typography, and nothing else", () => {
    const style = (bindings: Record<string, string>): NodeRecord => ({
      id: "ts",
      type: "textStyle",
      parent: ROOT_ID,
      key: "a0",
      props: { name: "Body", fontSize: 12, bindings } as never,
    });
    expect(checkNode(style({ fontSize: "v", lineHeight: "w" })).props.bindings).toEqual({
      fontSize: "v",
      lineHeight: "w",
    });
    expect(() => checkNode(style({ width: "v" }))).toThrow(/can't bind "width"/);
    // Kept, but not presented yet: its values are what they're read as.
    const store = file([style({ fontSize: "gap" })]);
    const ts = store.get("ts") as NodeRecord;
    expect(new TokenResolver(store).resolve(ts)).toBe(ts);
  });
});

describe("values alike where bound", () => {
  it("differ only in the fields both bind to the same variables", () => {
    const a = [{ type: "solid", color: "#000000", bind: { color: "v" } }];
    const b = [{ type: "solid", color: "#ffffff", bind: { color: "v" } }];
    expect(boundAlike("fills", a, b, undefined, undefined)).toBe(true);
    expect(boundAlike("fills", a, [{ ...b[0], bind: { color: "w" } }], undefined, undefined)).toBe(
      false,
    );
    expect(boundAlike("fills", a, [{ ...b[0], opacity: 0.5 }], undefined, undefined)).toBe(false);
    expect(boundAlike("width", 20, 40, { width: "n" }, { width: "n" })).toBe(true);
    expect(boundAlike("width", 20, 40, { width: "n" }, { width: "m" })).toBe(false);
    expect(
      boundAlike(
        "cornerRadii",
        [1, 2, 3, 4],
        [9, 2, 3, 4],
        { topLeftRadius: "n" },
        { topLeftRadius: "n" },
      ),
    ).toBe(true);
  });
});

describe("bindings say how their value maps onto the property (decision 0034)", () => {
  const rect = (bindings: unknown): NodeRecord => ({
    id: "r",
    type: "rect",
    parent: "p",
    key: "a0",
    props: { bindings } as never,
  });
  it("an id alone is a binding as before 0034; a unit is only where 0034 reads differently", () => {
    expect(checkNode(rect({ opacity: "v", width: "w" })).props.bindings).toEqual({
      opacity: "v",
      width: "w",
    });
    expect(checkNode(rect({ opacity: { variable: "v", unit: "percent" } })).props.bindings).toEqual(
      { opacity: { variable: "v", unit: "percent" } },
    );
    expect(() => checkNode(rect({ width: { variable: "v", unit: "percent" } }))).toThrow(/unit/);
    expect(() => checkNode(rect({ opacity: { variable: "v", unit: "text" } }))).toThrow(/unit/);
    expect(() => checkNode(rect({ opacity: { variable: "v" } }))).toThrow();
  });
  it("what reads a node's ids sees the variable either way", () => {
    const props = {
      bindings: { opacity: { variable: "v", unit: "percent" }, width: "w" },
    } as never;
    expect(tokenRefs(props).variables.sort()).toEqual(["v", "w"]);
    expect(heldNodeIds(props).others.sort()).toEqual(["v", "w"]);
    expect(renameTokenIds(props, (id) => `x${id}`)).toEqual({
      bindings: { opacity: { variable: "xv", unit: "percent" }, width: "xw" },
    });
  });
});

describe("bound sizes keep within their bounds", () => {
  it("a bound width or height is clamped by the layer's min and max, as Figma does", () => {
    const store = file([
      node("big", "variable", "c", { variableType: "number", values: { light: 40, dark: 40 } }),
      node("lo", "variable", "c", { variableType: "number", values: { light: 50, dark: 50 } }),
      node("r", "frame", "dark", {
        width: 32,
        height: 32,
        maxHeight: 32,
        minHeight: 32,
        bindings: { height: "big", width: "big", minWidth: "lo" },
      } as never),
    ]);
    const p = new TokenResolver(store).resolve(store.get("r") as NodeRecord).props;
    expect(p.height).toBe(32);
    expect(p.width).toBe(50);
  });
});
