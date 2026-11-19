// biome-ignore-all lint/style/noNonNullAssertion: Complete fixtures and asserted records in review reproductions.
import {
  BuildBudget,
  BuildTooLarge,
  MemoryStore,
  type NodeRecord,
  type Op,
  type Paint,
  type Props,
  ROOT_ID,
} from "@drawpane/model";
import { describe, expect, it } from "vitest";
import { instancesOf } from "../src/components";
import { Doc } from "../src/doc";
import { Editor } from "../src/editor";
import { importOps } from "../src/libraries";

const n = (
  id: string,
  type: NodeRecord["type"],
  parent: string,
  props: Props = {},
): NodeRecord => ({ id, type, parent, key: "a0", props });
const paint = (color: string, id?: string): Paint => ({
  type: "solid",
  color,
  ...(id ? { bind: { color: id } } : {}),
});
const base = (): NodeRecord[] => [
  n("p", "page", ROOT_ID),
  n("c", "collection", ROOT_ID, {
    modes: [
      { id: "a", name: "A" },
      { id: "b", name: "B" },
    ],
  }),
  n("v", "variable", "c", { variableType: "color", values: { a: "#ffffff", b: "#000000" } }),
  n("num", "variable", "c", { variableType: "number", values: { a: 12, b: 24 } }),
];
const legacy = (): NodeRecord[] => [
  n("p", "page", ROOT_ID),
  n("c", "collection", ROOT_ID, { modes: [{ id: "a", name: "A" }] }),
  n("v", "variable", "c", { variableType: "number", values: { a: 0.5 } }),
  n("r", "rect", "p", { opacity: 0.5, bindings: { opacity: "v" } }),
];
const docOf = (nodes: NodeRecord[], compact = false) => {
  const d = new Doc({ compactCopies: compact });
  d.resetStored(nodes, compact ? "compact" : "materialized");
  return d;
};
const fresh = (d: Doc, ids: string[]) => {
  const cold = docOf([...d.stored()], d.compactCopies);
  for (const id of ids) expect(d.get(id)?.props).toEqual(cold.get(id)?.props);
};
const eOf = (nodes: NodeRecord[], compact = false) => {
  const e = new Editor({ clientId: "recheck", measurer: { width: () => 10 } });
  e.doc.resetStored(nodes, compact ? "compact" : "materialized");
  e.state.set({ role: "editor" });
  e.setPage("p");
  return e;
};

// #186's re-check (decision 0034). B3 to B5 were blockers in the opacity migration, which is
// gone: a binding says how its value maps onto the property, and one stored before 0034 is read
// as it was then. Nothing is converted, so each case holds with no special handling.
describe("old data needs no migration", () => {
  it("B3: cross-collection alias preserves each occurrence mode", () => {
    const nodes = [
      ...legacy(),
      n("d", "collection", ROOT_ID, {
        modes: [
          { id: "light", name: "Light" },
          { id: "dark", name: "Dark" },
        ],
      }),
      n("source", "variable", "d", { variableType: "number", values: { light: 0.5, dark: 0.25 } }),
      n("dark", "frame", "p", { variableModes: { d: "dark" } }),
    ];
    nodes[nodes.findIndex((x) => x.id === "v")] = n("v", "variable", "c", {
      variableType: "number",
      values: { a: { alias: "source" } },
    });
    nodes[nodes.findIndex((x) => x.id === "r")] = {
      ...nodes.find((x) => x.id === "r")!,
      parent: "dark",
    };
    const d = docOf(nodes);
    expect(d.get("r")?.props.opacity).toBe(0.25);
    expect(d.stored()).toEqual(nodes);
  });
  it("B4: an old download replayed with its log converges with the room, as it is", () => {
    const old = legacy();
    const later: Op[] = [
      {
        op: "create",
        id: "width",
        type: "rect",
        parent: "p",
        key: "a1",
        props: { width: 0.5, bindings: { width: "v" } },
      },
    ];
    const room = docOf(old);
    room.applyStored(later);
    // What the client does: the saved version, then its log, nothing else.
    const client = docOf(old);
    client.applyStored(later);
    expect(client.get("width")?.props.width).toBe(0.5);
    expect(client.get("r")?.props.opacity).toBe(0.5);
    expect(client.get("width")?.props.width).toBe(room.get("width")?.props.width);
    expect([...client.stored()]).toEqual([...room.stored()]);
  });
  it("B5: no node is made beside a variable, so none can collide with one already there", () => {
    const nodes = legacy();
    nodes.push(n("width", "rect", "p", { width: 0.5, bindings: { width: "v" } }));
    nodes.push(
      n("v_opacity", "variable", "c", {
        name: "Existing",
        variableType: "number",
        values: { a: 88 },
      }),
    );
    const d = docOf(nodes);
    expect(d.get("r")?.props.opacity).toBe(0.5);
    expect(d.get("width")?.props.width).toBe(0.5);
    expect(d.get("v_opacity")?.props.values).toEqual({ a: 88 });
    expect(d.stored()).toEqual(nodes);
  });
});

describe("nearby variants of original findings", () => {
  for (const compact of [false, true]) {
    it(`F1: detach a bound effect style and undo (${compact})`, () => {
      const shadow = {
        type: "drop-shadow" as const,
        x: 0,
        y: 1,
        blur: 2,
        spread: 0,
        color: "#000000",
        bind: { blur: "num" },
      };
      const e = eOf(
        [
          ...base(),
          n("s", "effectStyle", ROOT_ID, { effects: [shadow] }),
          n("r", "rect", "p", { effectStyle: "s", effects: [shadow] }),
        ],
        compact,
      );
      const shown = e.doc.get("r")!.props.effects!;
      e.setProp(["r"], "effects", [{ ...shown[0]!, y: 9 }]);
      expect(e.doc.getUnresolved("r")?.props.effectStyle).toBeUndefined();
      expect(e.doc.get("r")?.props.effects?.[0]).toMatchObject({
        y: 9,
        blur: 12,
        bind: { blur: "num" },
      });
      e.undo();
      expect(e.doc.getUnresolved("r")?.props.effectStyle).toBe("s");
    });
    it(`F5/F6: reorder bound effects; manual translucent paint opacity survives (${compact})`, () => {
      const shadow = (y: number) => ({
        type: "drop-shadow" as const,
        x: 0,
        y,
        blur: 2,
        spread: 0,
        color: "#000000",
        bind: { blur: "num" },
      });
      const e = eOf(
        [
          ...base(),
          n("r", "rect", "p", { effects: [shadow(1), shadow(2)], fills: [paint("#ffffff", "v")] }),
        ],
        compact,
      );
      const s = e.doc.get("r")!.props.effects!;
      e.setProp(["r"], "effects", [s[1]!, s[0]!]);
      expect(
        e.doc.getUnresolved("r")?.props.effects?.map((x) => (x as { bind?: unknown }).bind),
      ).toEqual([{ blur: "num" }, { blur: "num" }]);
      e.doc.applyStored([
        { op: "set", id: "v", prop: "values", value: { a: "#11223380", b: "#000000" } },
      ]);
      e.setProp(["r"], "fills", [{ ...e.doc.get("r")!.props.fills![0]!, opacity: 0.25 }]);
      expect(e.doc.get("r")?.props.fills?.[0]).toMatchObject({
        color: "#11223380",
        opacity: 0.25,
        bind: { color: "v" },
      });
    });
    it(`F8: detach bound fill from changed style and keep current mode (${compact})`, () => {
      const e = eOf(
        [
          ...base(),
          n("s", "paintStyle", ROOT_ID, { fills: [paint("#ffffff", "v")] }),
          n("f", "frame", "p", { variableModes: { c: "b" } }),
          n("r", "rect", "f", { fillStyle: "s", fills: [paint("#ffffff")] }),
        ],
        compact,
      );
      e.unbindVariable(["r"], "fill");
      expect(e.doc.get("r")?.props.fills?.[0]).toMatchObject({ color: "#000000" });
      expect(e.doc.getUnresolved("r")?.props.fillStyle).toBeUndefined();
      expect(e.doc.getUnresolved("r")?.props.fills?.[0]?.bind).toBeUndefined();
    });
  }
  it("F2/F3/F4: alias-only override on nested copies replays and rolls back", () => {
    const nodes = [
      ...base(),
      n("alias", "variable", "c", {
        variableType: "color",
        values: { a: { alias: "v" }, b: { alias: "v" } },
      }),
      n("m", "frame", "p", { isComponent: true }),
      n("f", "frame", "m"),
      n("r", "rect", "f", { fills: [paint("#ffffff")] }),
      n("i", "frame", "p", { instanceOf: "m" }),
    ];
    const a = docOf(nodes, true),
      b = docOf(nodes, true);
    const f = a.childIds("i")[0]!,
      r = a.childIds(f)[0]!;
    a.apply([{ op: "set", id: r, prop: "fills", value: [paint("#ffffff", "alias")] }]);
    b.applyStored(a.lastStoredOps);
    a.apply([{ op: "set", id: f, prop: "variableModes", value: { c: "b" } }]);
    b.get(r);
    b.applyStored(a.lastStoredOps);
    fresh(b, [f, r]);
    b.applyStored(a.lastStoredInverse);
    fresh(b, [f, r]);
    b.applyStored([{ op: "set", id: "v", prop: "values", value: { a: "#123456", b: "#654321" } }]);
    expect(b.get(r)?.props.fills?.[0]).toMatchObject({ color: "#123456" });
    fresh(b, [r]);
  });
  it("F7: instances index after a new instance avoids enumerating nodes", () => {
    const d = docOf(
      [
        ...base(),
        n("m", "frame", "p", { isComponent: true }),
        n("i", "frame", "p", { instanceOf: "m" }),
      ],
      true,
    );
    instancesOf(d, "m");
    d.applyStored([
      { op: "create", id: "j", type: "frame", parent: "p", key: "a1", props: { instanceOf: "m" } },
    ]);
    const original = d.nodes.bind(d);
    let visits = 0;
    d.nodes = function* () {
      for (const n of original()) {
        visits++;
        yield n;
      }
    };
    expect([...instancesOf(d, "m")].sort()).toEqual(["i", "j"]);
    expect(visits).toBe(0);
  });
  it("F9: a tiny fraction bound to opacity reads as it did", () => {
    const nodes = legacy();
    nodes[nodes.findIndex((x) => x.id === "v")] = n("v", "variable", "c", {
      variableType: "number",
      values: { a: 0.005 },
    });
    const d = docOf(nodes);
    expect(d.get("r")?.props.opacity).toBe(0.005);
  });
  it("F10: linked stroke style and gradient-stop IDs are remapped", () => {
    const style = n("s", "paintStyle", ROOT_ID, {
      fills: [
        {
          type: "linear",
          from: { x: 0, y: 0 },
          to: { x: 1, y: 1 },
          stops: [
            { position: 0, color: "#ffffff", bind: { color: "v" } },
            { position: 1, color: "#000000" },
          ],
        },
      ],
    });
    const nodes = [
      ...base(),
      style,
      n("r", "frame", "p", { isComponent: true, strokeStyle: "s", variableModes: { c: "b" } }),
    ];
    const e = eOf([n("p", "page", ROOT_ID)]);
    const ops = importOps(e.doc, docOf(nodes), { fileId: "lib", name: "Lib", publishId: "pub" }, [
      "r",
    ]);
    e.doc.apply(ops);
    const stored = [...e.doc.stored()];
    const imported = stored.find((x) => x.type === "frame")!;
    const s = stored.find((x) => x.type === "paintStyle")!;
    expect(imported.props.strokeStyle).toBe(s.id);
    expect(
      (s.props.fills?.[0] as { stops?: { bind?: { color?: string } }[] } | undefined)?.stops?.[0]
        ?.bind?.color,
    ).not.toBe("v");
  });
  it("F11: effect colour edit through alias queues no unrelated layout", () => {
    const d = docOf([
      ...base(),
      n("alias", "variable", "c", { variableType: "color", values: { a: { alias: "v" } } }),
      n("r", "rect", "p", {
        bindings: { width: "num" },
        effects: [
          {
            type: "drop-shadow",
            x: 0,
            y: 0,
            blur: 2,
            spread: 0,
            color: "#ffffff",
            bind: { color: "alias" },
          },
        ],
      }),
    ]);
    d.get("r");
    d.applyStored([{ op: "set", id: "v", prop: "values", value: { a: "#112233" } }]);
    expect([...d.takeTokenLayout()]).toEqual([]);
    fresh(d, ["r"]);
  });
  it("F15: alias/style users under an invalid shielding mode are invalidated", () => {
    const d = docOf([
      ...base(),
      n("alias", "variable", "c", {
        variableType: "color",
        values: { a: { alias: "v" }, b: { alias: "v" } },
      }),
      n("s", "paintStyle", ROOT_ID, { fills: [paint("#ffffff", "alias")] }),
      n("f", "frame", "p"),
      n("shield", "frame", "f", { variableModes: { c: "missing" } }),
      n("r", "rect", "shield", { fillStyle: "s" }),
    ]);
    d.get("r");
    d.applyStored([{ op: "set", id: "f", prop: "variableModes", value: { c: "b" } }]);
    expect(d.get("r")?.props.fills?.[0]).toMatchObject({ color: "#000000" });
    fresh(d, ["r"]);
  });
  it("F16: a meter that fits the store refuses indexes, and a full cache resolves without growing", () => {
    const nodes = [
      ...base(),
      ...Array.from({ length: 1000 }, (_, i) =>
        n(`r${i}`, "rect", "p", { fills: [paint("#ffffff", "v")] }),
      ),
    ];
    const rawMeter = new BuildBudget({ bytes: 10_000_000 });
    new MemoryStore(nodes, { meter: rawMeter });
    expect(() =>
      new Doc().resetStored(nodes, "materialized", {
        meter: new BuildBudget({ bytes: rawMeter.held + 100 }),
      }),
    ).toThrow(BuildTooLarge);
    const measured = new BuildBudget({ bytes: 10_000_000 });
    const first = new Doc();
    first.resetStored(nodes, "materialized", { meter: measured });
    const tight = new BuildBudget({ bytes: measured.held + 1 });
    const d = new Doc();
    d.resetStored(nodes, "materialized", { meter: tight });
    const held = tight.held;
    for (let i = 0; i < 1000; i++)
      expect(d.get(`r${i}`)?.props.fills?.[0]).toMatchObject({ color: "#ffffff" });
    expect(tight.held).toBe(held);
  });
});
