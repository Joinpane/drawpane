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
  const vars = new Map<string, NodeRecord>([
    ["v", node("v", "variable", "c", { variableType: "color", values: { m: "#ff0000" } })],
    ["w", node("w", "variable", "c", { variableType: "color", values: { m: "#00ff00" } })],
    ["n", node("n", "variable", "c", { variableType: "number", values: { m: 4 } })],
    ["m", node("m", "variable", "c", { variableType: "number", values: { m: 8 } })],
    [
      "broken",
      node("broken", "variable", "c", { variableType: "number", values: { m: { alias: "gone" } } }),
    ],
  ]);
  const get = (id: string) => vars.get(id);
  it("differ only in the fields both bind to the same variables", () => {
    const a = [{ type: "solid", color: "#000000", bind: { color: "v" } }];
    const b = [{ type: "solid", color: "#ffffff", bind: { color: "v" } }];
    expect(boundAlike("fills", a, b, undefined, undefined, get)).toBe(true);
    expect(
      boundAlike("fills", a, [{ ...b[0], bind: { color: "w" } }], undefined, undefined, get),
    ).toBe(false);
    expect(boundAlike("fills", a, [{ ...b[0], opacity: 0.5 }], undefined, undefined, get)).toBe(
      false,
    );
    expect(boundAlike("width", 20, 40, { width: "n" }, { width: "n" }, get)).toBe(true);
    expect(boundAlike("width", 20, 40, { width: "n" }, { width: "m" }, get)).toBe(false);
    expect(
      boundAlike(
        "cornerRadii",
        [1, 2, 3, 4],
        [9, 2, 3, 4],
        { topLeftRadius: "n" },
        { topLeftRadius: "n" },
        get,
      ),
    ).toBe(true);
  });

  // A value, its binding and its fallback are one (review 3, R1 and R3).
  it("aren't alike where a binding can't be followed: the saved value shows there", () => {
    expect(boundAlike("opacity", 0.25, 0.5, { opacity: "gone" }, { opacity: "gone" }, get)).toBe(
      false,
    );
    expect(
      boundAlike("opacity", 0.25, 0.5, { opacity: "broken" }, { opacity: "broken" }, get),
    ).toBe(false);
    const paint = (color: string, id: string) => [{ type: "solid", color, bind: { color: id } }];
    expect(
      boundAlike("fills", paint("#000000", "gone"), paint("#ffffff", "gone"), {}, {}, get),
    ).toBe(false);
    // A legacy characters binding takes only text; a number shows the saved characters.
    expect(boundAlike("characters", "a", "b", { characters: "n" }, { characters: "n" }, get)).toBe(
      false,
    );
    expect(
      boundAlike(
        "characters",
        "a",
        "b",
        { characters: { variable: "n", unit: "text" } },
        { characters: { variable: "n", unit: "text" } },
        get,
      ),
    ).toBe(true);
  });

  // Review 4, blocker 2: a value the resolver can't apply leaves the saved one showing.
  it("aren't alike where a variable's value can't drive the property", () => {
    const more = new Map<string, NodeRecord>([
      ...vars,
      ["zero", node("zero", "variable", "c", { variableType: "number", values: { m: 0 } })],
      ["blank", node("blank", "variable", "c", { variableType: "string", values: { m: " " } })],
      ["inter", node("inter", "variable", "c", { variableType: "string", values: { m: "Inter" } })],
    ]);
    const at = (id: string) => more.get(id);
    expect(boundAlike("fontSize", 24, 14, { fontSize: "zero" }, { fontSize: "zero" }, at)).toBe(
      false,
    );
    expect(boundAlike("fontSize", 24, 14, { fontSize: "n" }, { fontSize: "n" }, at)).toBe(true);
    expect(
      boundAlike("fontFamily", "A", "B", { fontFamily: "blank" }, { fontFamily: "blank" }, at),
    ).toBe(false);
    expect(
      boundAlike("fontFamily", "A", "B", { fontFamily: "inter" }, { fontFamily: "inter" }, at),
    ).toBe(true);
  });

  it("aren't alike where the part no binding gives differs: a letter spacing's unit", () => {
    const pct = { unit: "percent", value: 5 };
    const px = { unit: "px", value: 5 };
    expect(
      boundAlike("letterSpacing", pct, px, { letterSpacing: "n" }, { letterSpacing: "n" }, get),
    ).toBe(false);
    expect(
      boundAlike(
        "letterSpacing",
        pct,
        { unit: "percent", value: 8 },
        { letterSpacing: "n" },
        { letterSpacing: "n" },
        get,
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
  it("a width or height bound `bounded` is clamped by the layer's min and max, as Figma does", () => {
    const bounded = { variable: "big", unit: "bounded" };
    const store = file([
      node("big", "variable", "c", { variableType: "number", values: { light: 40, dark: 40 } }),
      node("lo", "variable", "c", { variableType: "number", values: { light: 50, dark: 50 } }),
      node("r", "frame", "dark", {
        width: 32,
        height: 32,
        maxHeight: 32,
        minHeight: 32,
        bindings: { height: bounded, width: bounded, minWidth: "lo" },
      } as never),
    ]);
    const p = new TokenResolver(store).resolve(store.get("r") as NodeRecord).props;
    expect(p.height).toBe(32);
    expect(p.width).toBe(50);
  });

  // Review 3, R4: before 0034 a bound width was the variable's value, whatever the max.
  it("a size bound before 0034 (no unit) is the variable's value, as it was then", () => {
    const store = file([
      node("big", "variable", "c", { variableType: "number", values: { light: 40, dark: 40 } }),
      node("r", "rect", "p", { width: 40, maxWidth: 32, bindings: { width: "big" } } as never),
    ]);
    expect(new TokenResolver(store).resolve(store.get("r") as NodeRecord).props.width).toBe(40);
  });

  it("an unbound size is left to the layout, whatever its bound min or max gives", () => {
    const store = file([
      node("lo", "variable", "c", { variableType: "number", values: { light: 32, dark: 32 } }),
      node("b", "frame", "dark", {
        height: 28,
        minHeight: 32,
        sizingV: "hug",
        bindings: { minHeight: "lo" },
      } as never),
    ]);
    const p = new TokenResolver(store).resolve(store.get("b") as NodeRecord).props;
    expect(p.minHeight).toBe(32);
    expect(p.height).toBe(28);
  });
});

describe("text spacing is read in the layer's unit, as Figma does", () => {
  const text = (id: string, props: Record<string, unknown>) =>
    node(id, "text", "p", { characters: "a", fontSize: 20, ...props });
  it("letter spacing keeps the layer's unit", () => {
    const store = file([
      text("pct", {
        letterSpacing: { unit: "percent", value: 0 },
        bindings: { letterSpacing: "gap" },
      }),
      text("px", { letterSpacing: { unit: "px", value: 0 }, bindings: { letterSpacing: "gap" } }),
    ]);
    const resolver = new TokenResolver(store);
    const ls = (id: string) => resolver.resolve(store.get(id) as NodeRecord).props.letterSpacing;
    expect(ls("pct")).toEqual({ unit: "percent", value: 4 });
    expect(ls("px")).toEqual({ unit: "px", value: 4 });
  });
  it("line height is read in pixels, as every bound one Figma saves", () => {
    const store = file([
      text("pct", { lineHeight: { unit: "percent", value: 100 }, bindings: { lineHeight: "gap" } }),
      text("px", { lineHeight: { unit: "px", value: 10 }, bindings: { lineHeight: "gap" } }),
      text("auto", { lineHeight: { unit: "auto" }, bindings: { lineHeight: "gap" } }),
    ]);
    const resolver = new TokenResolver(store);
    const lh = (id: string) => resolver.resolve(store.get(id) as NodeRecord).props.lineHeight;
    expect(lh("pct")).toEqual({ unit: "px", value: 4 });
    expect(lh("px")).toEqual({ unit: "px", value: 4 });
    expect(lh("auto")).toEqual({ unit: "px", value: 4 });
  });
});
