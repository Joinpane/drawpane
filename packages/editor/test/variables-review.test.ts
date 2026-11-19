/**
 * Variables and styles (decision 0034) against #186's review: each case is
 * one of its reproductions (F1 to F15), through the editor's and the
 * document's public operations, with a warm document compared to one built
 * fresh where a cache could hold a stale value.
 */
import {
  libraryNodeId,
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
import { SyncEngine } from "../src/sync";

const node = (id: string, type: NodeRecord["type"], parent: string, props: Props = {}) =>
  ({ id, type, parent, key: "a0", props }) as NodeRecord;
const fill = (color: string, variable?: string): Paint =>
  ({ type: "solid", color, ...(variable ? { bind: { color: variable } } : {}) }) as Paint;
const base = (): NodeRecord[] => [
  node("p", "page", ROOT_ID),
  node("c", "collection", ROOT_ID, {
    modes: [
      { id: "light", name: "Light" },
      { id: "dark", name: "Dark" },
    ],
  }),
  node("v", "variable", "c", {
    variableType: "color",
    values: { light: "#ffffff", dark: "#000000" },
  }),
  node("w", "variable", "c", {
    variableType: "color",
    values: { light: "#ff0000", dark: "#00ff00" },
  }),
];
/** A node's own values, as stored (bound fields as their fallbacks). */
const raw = (doc: Doc, id: string) => (doc.getUnresolved(id) as NodeRecord).props;
const fills = (doc: Doc, id: string) => (doc.get(id)?.props.fills ?? []) as Paint[];
const color = (doc: Doc, id: string) => {
  const paint = fills(doc, id)[0];
  return paint?.type === "solid" ? paint.color : undefined;
};

function editor(nodes: NodeRecord[], compact = true): Editor {
  const e = new Editor({ clientId: "review", measurer: { width: () => 10 } });
  e.doc.resetStored(nodes, compact ? "compact" : "materialized");
  e.state.set({ role: "editor" });
  e.setPage("p");
  return e;
}

/** A document built afresh from another's stored form: what a cold reader shows. */
function fresh(doc: Doc): Doc {
  const cold = new Doc({ compactCopies: doc.compactCopies });
  cold.resetStored(doc.stored(), doc.copies);
  return cold;
}

/** Every presented node of `doc` shows what a fresh build of it shows. */
function expectFresh(doc: Doc, ids: readonly string[]): void {
  const cold = fresh(doc);
  for (const id of ids) expect(doc.get(id)?.props, id).toEqual(cold.get(id)?.props);
}

describe("editing a styled or bound paint (F1, F5, F6, F8)", () => {
  for (const compact of [true, false])
    describe(compact ? "compact" : "materialized", () => {
      it("F1: a manual edit of a fill linked to a style detaches the style in the same change", () => {
        const e = editor(
          [
            ...base(),
            node("s", "paintStyle", ROOT_ID, { fills: [fill("#ffffff")] }),
            node("r", "rect", "p", { fills: [fill("#ffffff")], fillStyle: "s" }),
          ],
          compact,
        );
        e.setProp(["r"], "fills", [fill("#ff0000")]);
        expect(color(e.doc, "r")).toBe("#ff0000");
        expect(raw(e.doc, "r").fillStyle).toBeUndefined();
        // One change: undo puts the link and the old paint back together.
        e.undo();
        expect(raw(e.doc, "r").fillStyle).toBe("s");
        expect(color(e.doc, "r")).toBe("#ffffff");
      });

      it("F1: the same holds for strokes and effects linked to styles", () => {
        const shadow = {
          type: "drop-shadow" as const,
          x: 0,
          y: 2,
          blur: 4,
          spread: 0,
          color: "#00000040",
        };
        const e = editor(
          [
            ...base(),
            node("s", "paintStyle", ROOT_ID, { fills: [fill("#ffffff")] }),
            node("es", "effectStyle", ROOT_ID, { effects: [shadow] }),
            node("r", "rect", "p", {
              strokes: [fill("#ffffff")],
              strokeStyle: "s",
              effects: [shadow],
              effectStyle: "es",
            } as Props),
          ],
          compact,
        );
        e.setProp(["r"], "strokes", [fill("#00ff00")]);
        e.setProp(["r"], "effects", [{ ...shadow, y: 8 }]);
        const r = e.doc.get("r")?.props as Props;
        expect(r.strokes?.[0]).toMatchObject({ color: "#00ff00" });
        expect(r.effects?.[0]).toMatchObject({ y: 8 });
        expect(raw(e.doc, "r").strokeStyle).toBeUndefined();
        expect(raw(e.doc, "r").effectStyle).toBeUndefined();
      });

      it("F5: reordering bound paints keeps each paint's binding", () => {
        const e = editor(
          [
            ...base(),
            node("r", "rect", "p", { fills: [fill("#ffffff", "v"), fill("#ff0000", "w")] }),
          ],
          compact,
        );
        const paints = fills(e.doc, "r");
        e.setProp(["r"], "fills", [paints[1] as Paint, paints[0] as Paint]);
        expect((raw(e.doc, "r").fills as Paint[]).map((p) => p.bind?.color)).toEqual(["w", "v"]);
        expect(fills(e.doc, "r").map((p) => (p as { color: string }).color)).toEqual([
          "#ff0000",
          "#ffffff",
        ]);
      });

      it("F5: reordering gradient stops keeps each stop's binding", () => {
        const gradient = {
          type: "linear",
          from: { x: 0, y: 0 },
          to: { x: 1, y: 1 },
          stops: [
            { position: 0, color: "#ffffff", bind: { color: "v" } },
            { position: 1, color: "#ff0000", bind: { color: "w" } },
          ],
        };
        const e = editor(
          [...base(), node("r", "rect", "p", { fills: [gradient] } as Props)],
          compact,
        );
        const shown = fills(e.doc, "r")[0] as typeof gradient;
        const swapped = {
          ...shown,
          stops: [
            { ...(shown.stops[1] as (typeof gradient.stops)[number]), position: 0 },
            { ...(shown.stops[0] as (typeof gradient.stops)[number]), position: 1 },
          ],
        };
        e.setProp(["r"], "fills", [swapped as unknown as Paint]);
        const stored = (raw(e.doc, "r").fills as unknown as Array<typeof gradient>)[0];
        expect(stored?.stops.map((s) => s.bind?.color)).toEqual(["w", "v"]);
      });

      it("F5: an actual edit of one reordered paint detaches only that paint", () => {
        const e = editor(
          [
            ...base(),
            node("r", "rect", "p", { fills: [fill("#ffffff", "v"), fill("#ff0000", "w")] }),
          ],
          compact,
        );
        const paints = fills(e.doc, "r");
        e.setProp(["r"], "fills", [
          paints[1] as Paint,
          { ...(paints[0] as Paint), color: "#123456" } as Paint,
        ]);
        expect((raw(e.doc, "r").fills as Paint[]).map((p) => p.bind?.color)).toEqual([
          "w",
          undefined,
        ]);
      });

      it("F6: a bound paint's own opacity can be edited", () => {
        const e = editor(
          [...base(), node("r", "rect", "p", { fills: [fill("#ffffff", "v")] })],
          compact,
        );
        e.setProp(["r"], "fills", [{ ...(fills(e.doc, "r")[0] as Paint), opacity: 0.5 } as Paint]);
        expect(fills(e.doc, "r")[0]?.opacity).toBe(0.5);
        // The colour stays bound: the opacity is the paint's own, on top of the variable's alpha.
        expect((raw(e.doc, "r").fills as Paint[])[0]?.bind?.color).toBe("v");
        e.doc.apply([
          { op: "set", id: "v", prop: "values", value: { light: "#00000080", dark: "#000000" } },
        ]);
        expect(fills(e.doc, "r")[0]).toMatchObject({ color: "#00000080", opacity: 0.5 });
      });

      it("F8: binding captures what shows, and detaching keeps what it shows", () => {
        const e = editor(
          [...base(), node("r", "rect", "p", { fills: [fill("#123456")] })],
          compact,
        );
        e.bindVariable(["r"], "fill", "v");
        expect(color(e.doc, "r")).toBe("#ffffff");
        e.unbindVariable(["r"], "fill");
        expect(color(e.doc, "r")).toBe("#ffffff");
        expect(raw(e.doc, "r").fills).toEqual([fill("#ffffff")]);
      });

      it("F8: detaching after a mode change keeps the mode's value, for every field the key drives", () => {
        const e = editor(
          [
            ...base(),
            node("n", "variable", "c", { variableType: "number", values: { light: 4, dark: 12 } }),
            node("s", "variable", "c", {
              variableType: "string",
              values: { light: "Regular", dark: "Bold Italic" },
            }),
            node("f", "frame", "p", { variableModes: { c: "dark" } }),
            node("r", "rect", "f", { cornerRadius: 1, strokeWeight: 1 }),
            node("t", "text", "f", { characters: "Hi", fontWeight: 400, fontStyle: "normal" }),
          ],
          compact,
        );
        e.bindVariable(["r"], "topLeftRadius", "n");
        e.bindVariable(["r"], "strokeRightWeight", "n");
        e.bindVariable(["t"], "fontStyle", "s");
        expect(e.doc.get("r")?.props.cornerRadii).toEqual([12, 1, 1, 1]);
        expect(e.doc.get("t")?.props).toMatchObject({ fontWeight: 700, fontStyle: "italic" });
        e.unbindVariable(["r"], "topLeftRadius");
        e.unbindVariable(["r"], "strokeRightWeight");
        e.unbindVariable(["t"], "fontStyle");
        const r = raw(e.doc, "r") as Props;
        expect(r.bindings).toBeUndefined();
        expect(r.cornerRadii).toEqual([12, 1, 1, 1]);
        expect(r.strokeWeights).toEqual([1, 12, 1, 1]);
        expect(raw(e.doc, "t")).toMatchObject({
          fontWeight: 700,
          fontStyle: "italic",
        });
      });

      it("F8: detaching a paint's own binding keeps what it shows", () => {
        const e = editor(
          [...base(), node("r", "rect", "p", { fills: [fill("#123456", "v")] })],
          compact,
        );
        e.unbindVariable(["r"], "fill");
        expect(color(e.doc, "r")).toBe("#ffffff");
        expect((raw(e.doc, "r").fills as Paint[])[0]?.bind).toBeUndefined();
      });
    });
});

describe("modes reach every occurrence (F2, F3, F4)", () => {
  const card = () => [
    ...base(),
    node("m", "frame", "p", { isComponent: true }),
    node("f", "frame", "m", {}),
    node("r", "rect", "f", { fills: [fill("#ffffff", "v")], width: 10, height: 10 }),
    node("i", "frame", "p", { instanceOf: "m" }),
  ];

  it("F2: a variable used only in a compact override invalidates the presented copy", () => {
    const doc = new Doc({ compactCopies: true });
    doc.resetStored(
      [
        ...base(),
        node("m", "frame", "p", { isComponent: true }),
        node("r", "rect", "m", { fills: [fill("#ffffff")] }),
        node("i", "frame", "p", { instanceOf: "m" }),
      ],
      "compact",
    );
    const child = doc.childIds("i")[0] as string;
    doc.apply([{ op: "set", id: child, prop: "fills", value: [fill("#ff0000", "w")] }]);
    expect(color(doc, child)).toBe("#ff0000");
    doc.applyStored([
      { op: "set", id: "w", prop: "values", value: { light: "#0000ff", dark: "#00ff00" } },
    ]);
    expect(color(doc, child)).toBe("#0000ff");
  });

  it("F3: replaying a stored mode override (a record's create) invalidates the occurrence's layers", () => {
    const local = new Doc({ compactCopies: true });
    local.resetStored(card(), "compact");
    const remote = new Doc({ compactCopies: true });
    remote.resetStored(card(), "compact");
    const f = local.childIds("i")[0] as string;
    const r = local.childIds(f)[0] as string;
    expect(color(local, r)).toBe("#ffffff");
    expect(color(remote, r)).toBe("#ffffff");
    local.apply([{ op: "set", id: f, prop: "variableModes", value: { c: "dark" } }]);
    expect(color(local, r)).toBe("#000000");
    const stored = [...local.lastStoredOps];
    expect(stored.some((op) => op.op === "create")).toBe(true);
    const changes: string[][] = [];
    remote.subscribe((change) => changes.push([...change.ids]));
    remote.applyStored(stored);
    expect(color(remote, r)).toBe("#000000");
    expect(changes.flat()).toContain(r);
    expectFresh(remote, [f, r]);

    // Then a set of the record that exists, and its rollback (the inverse, as stored).
    local.apply([{ op: "set", id: f, prop: "variableModes", value: { c: "light" } }]);
    const set = [...local.lastStoredOps];
    const undo = [...local.lastStoredInverse];
    expect(set.every((op) => op.op === "set")).toBe(true);
    remote.applyStored(set);
    expect(color(remote, r)).toBe("#ffffff");
    remote.applyStored(undo);
    expect(color(remote, r)).toBe("#000000");
    expectFresh(remote, [f, r]);
    // Rolling the record's create back (its delete): the main's mode again.
    remote.applyStored([{ op: "delete", id: f }]);
    expect(color(remote, r)).toBe("#ffffff");
    expectFresh(remote, [f, r]);
  });

  it("F4: a main's mode reaches layers of its built copies, and copies of copies", () => {
    const doc = new Doc({ compactCopies: true });
    doc.resetStored(
      [
        ...card(),
        node("m2", "frame", "p", { isComponent: true }),
        node("i2", "frame", "m2", { instanceOf: "m" }),
        node("j", "frame", "p", { instanceOf: "m2" }),
      ],
      "compact",
    );
    const f = doc.childIds("i")[0] as string;
    const r = doc.childIds(f)[0] as string;
    const ji = doc.childIds("j")[0] as string;
    const jr = doc.childIds(doc.childIds(ji)[0] as string)[0] as string;
    expect(color(doc, r)).toBe("#ffffff");
    expect(color(doc, jr)).toBe("#ffffff");
    doc.apply([{ op: "set", id: "m", prop: "variableModes", value: { c: "dark" } }]);
    expect(doc.get("i")?.props.variableModes).toEqual({ c: "dark" });
    expect(color(doc, r)).toBe("#000000");
    expect(color(doc, jr)).toBe("#000000");
    expectFresh(doc, [r, jr]);
  });

  it("F4: a materialized move under another mode, and back, reads fresh", () => {
    const doc = new Doc({ compactCopies: false });
    doc.resetStored(
      [
        ...base(),
        node("d", "frame", "p", { variableModes: { c: "dark" } }),
        node("g", "frame", "p"),
        node("r", "rect", "g", { fills: [fill("#ffffff", "v")] }),
      ],
      "materialized",
    );
    expect(color(doc, "r")).toBe("#ffffff");
    const undo = doc.apply([{ op: "move", id: "g", parent: "d", key: "a1" }]);
    expect(color(doc, "r")).toBe("#000000");
    doc.apply(undo);
    expect(color(doc, "r")).toBe("#ffffff");
  });

  it("a mode change queues layout only for layers whose layout reads that collection", () => {
    const doc = new Doc({ compactCopies: true });
    doc.resetStored(
      [
        ...card(),
        node("d", "collection", ROOT_ID, {
          modes: [
            { id: "s", name: "S" },
            { id: "l", name: "L" },
          ],
        }),
        node("n", "variable", "d", { variableType: "number", values: { s: 10, l: 40 } }),
        node("q", "rect", "f", { bindings: { width: "n" } } as Props),
      ],
      "compact",
    );
    const f = doc.childIds("i")[0] as string;
    const copyOf = (source: string) =>
      doc.childIds(f).find((id) => doc.get(id)?.props.mirrors === source) as string;
    const r = copyOf("r");
    const q = copyOf("q");
    expect(doc.get(q)?.props.width).toBe(10);
    doc.takeTokenLayout();
    doc.apply([{ op: "set", id: f, prop: "variableModes", value: { c: "dark" } }]);
    expect([...doc.takeTokenLayout()]).toEqual([]);
    expect(color(doc, r)).toBe("#000000");
    const remote = new Doc({ compactCopies: true });
    remote.resetStored(doc.stored(), "compact");
    expect(remote.get(q)?.props.width).toBe(10);
    remote.takeTokenLayout();
    doc.apply([{ op: "set", id: f, prop: "variableModes", value: { c: "dark", d: "l" } }]);
    expect(doc.get(q)?.props.width).toBe(40);
    expect([...doc.takeTokenLayout()]).toContain(q);
    remote.applyStored(doc.lastStoredOps);
    expect(remote.get(q)?.props.width).toBe(40);
    expect([...remote.takeTokenLayout()]).toContain(q);
  });
});

describe("what a change walks and lays out (F7, F11, F15)", () => {
  it("F7: instancesOf does not enumerate the whole file again after an edit", () => {
    const doc = new Doc({ compactCopies: true });
    doc.resetStored(
      [
        ...base(),
        node("m", "frame", "p", { isComponent: true }),
        node("r", "rect", "m", { fills: [fill("#ffffff", "v")] }),
        node("i", "frame", "p", { instanceOf: "m" }),
      ],
      "compact",
    );
    instancesOf(doc, "m");
    let scanned = 0;
    const original = doc.nodes.bind(doc);
    doc.nodes = function* () {
      for (const n of original()) {
        scanned++;
        yield n;
      }
    };
    doc.apply([{ op: "set", id: "r", prop: "name", value: "renamed" }]);
    instancesOf(doc, "m");
    expect(scanned).toBe(0);
  });

  it("F11: a colour-only edit does not queue layout for an unrelated numeric binding", () => {
    const doc = new Doc();
    doc.resetStored(
      [
        ...base(),
        node("n", "variable", "c", { variableType: "number", values: { light: 100 } }),
        node("r", "rect", "p", {
          width: 100,
          bindings: { width: "n" },
          fills: [fill("#ffffff", "v")],
        } as Props),
      ],
      "materialized",
    );
    doc.apply([
      { op: "set", id: "v", prop: "values", value: { light: "#123456", dark: "#000000" } },
    ]);
    expect([...doc.takeTokenLayout()]).toEqual([]);
    expect(color(doc, "r")).toBe("#123456");
    doc.apply([{ op: "set", id: "n", prop: "values", value: { light: 50 } }]);
    expect([...doc.takeTokenLayout()]).toEqual(["r"]);
  });

  it("F11: a paint style's change queues no layout", () => {
    const doc = new Doc();
    doc.resetStored(
      [
        ...base(),
        node("n", "variable", "c", { variableType: "number", values: { light: 100 } }),
        node("s", "paintStyle", ROOT_ID, { fills: [fill("#ffffff")] }),
        node("r", "rect", "p", { fillStyle: "s", bindings: { width: "n" } } as Props),
      ],
      "materialized",
    );
    doc.apply([{ op: "set", id: "s", prop: "fills", value: [fill("#000000")] }]);
    expect([...doc.takeTokenLayout()]).toEqual([]);
    expect(color(doc, "r")).toBe("#000000");
  });

  for (const compact of [false, true])
    it(`F15: switching a mode does not visit an unbound subtree (${compact ? "compact" : "materialized"})`, () => {
      const doc = new Doc({ compactCopies: compact });
      doc.resetStored(
        [
          ...base(),
          node("f", "frame", "p"),
          ...Array.from({ length: 1000 }, (_, i) => node(`u${i}`, "rect", "f")),
          node("b", "rect", "p", { fills: [fill("#ffffff", "v")] }),
        ],
        compact ? "compact" : "materialized",
      );
      let visited = 0;
      const children = doc.childIds.bind(doc);
      doc.childIds = (id) => {
        visited++;
        return children(id);
      };
      doc.apply([{ op: "set", id: "f", prop: "variableModes", value: { c: "dark" } }]);
      doc.apply([{ op: "move", id: "f", parent: "p", key: "a5" }]);
      expect(visited).toBeLessThan(10);
    });

  it("F15: a mode switch stops at a frame that sets its own mode", () => {
    const doc = new Doc();
    doc.resetStored(
      [
        ...base(),
        node("f", "frame", "p"),
        node("g", "frame", "f", { variableModes: { c: "light" } }),
        node("r", "rect", "g", { fills: [fill("#ffffff", "v")] }),
      ],
      "materialized",
    );
    expect(color(doc, "r")).toBe("#ffffff");
    const ids: string[] = [];
    doc.subscribe((change) => ids.push(...change.ids));
    doc.apply([{ op: "set", id: "f", prop: "variableModes", value: { c: "dark" } }]);
    expect(ids).not.toContain("r");
    expect(color(doc, "r")).toBe("#ffffff");
  });
});

describe("old files mean what they meant (F9)", () => {
  // Decision 0034: a binding says how its value maps onto the property. One without the field
  // (every binding written before 0034) is read as it was then; nothing is ever converted.
  const legacyOpacity = (values: Record<string, number>) => [
    ...base(),
    node("o", "variable", "c", { variableType: "number", values }),
    node("r", "rect", "p", { opacity: 0.5, bindings: { opacity: "o" } } as Props),
    node("d", "frame", "p", { variableModes: { c: "dark" } }),
    node("q", "rect", "d", { opacity: 0.3, bindings: { opacity: "o" } } as Props),
  ];

  for (const compact of [false, true])
    it(`F9: an opacity binding stored before 0034 keeps its look, as stored (${compact ? "compact" : "materialized"})`, () => {
      const nodes = legacyOpacity({ light: 0.5, dark: 30 });
      const doc = new Doc({ compactCopies: compact });
      doc.resetStored(nodes, compact ? "compact" : "materialized");
      // Read as it was: 1 or less a fraction, more a percentage.
      expect(doc.get("r")?.props.opacity).toBe(0.5);
      expect(doc.get("q")?.props.opacity).toBe(0.3);
      // And nothing about it is rewritten.
      expect(doc.stored()).toEqual(nodes);
    });

  it("F9: a tiny fraction stays what it was", () => {
    const doc = new Doc();
    doc.resetStored(legacyOpacity({ light: 0.005 }), "materialized");
    expect(doc.get("r")?.props.opacity).toBe(0.005);
  });

  it("F9: one variable bound both ways reads through each binding's own unit, with no copy of it", () => {
    const doc = new Doc();
    doc.resetStored(
      [
        ...base(),
        node("o", "variable", "c", { variableType: "number", values: { light: 0.5, dark: 50 } }),
        node("old", "rect", "p", { bindings: { opacity: "o", width: "o" } } as Props),
        node("new", "rect", "p", {
          bindings: { opacity: { variable: "o", unit: "percent" } },
        } as Props),
        node("d", "frame", "p", { variableModes: { c: "dark" } }),
        node("newDark", "rect", "d", {
          bindings: { opacity: { variable: "o", unit: "percent" } },
        } as Props),
      ],
      "materialized",
    );
    expect(doc.get("old")?.props).toMatchObject({ opacity: 0.5, width: 0.5 });
    expect(doc.get("new")?.props.opacity).toBe(0.005);
    expect(doc.get("newDark")?.props.opacity).toBe(0.5);
    expect(doc.get("o")?.props.values).toEqual({ light: 0.5, dark: 50 });
    expect(doc.stored().filter((n) => n.type === "variable")).toHaveLength(3);
  });

  it("F9: binding opacity now writes its unit, and stores what it shows", () => {
    const e = editor(
      [
        ...base(),
        node("o", "variable", "c", { variableType: "number", values: { light: 40, dark: 80 } }),
        node("r", "rect", "p", {}),
      ],
      false,
    );
    e.bindVariable(["r"], "opacity", "o");
    expect(raw(e.doc, "r").bindings).toEqual({ opacity: { variable: "o", unit: "percent" } });
    expect(raw(e.doc, "r").opacity).toBe(0.4);
    expect(e.doc.get("r")?.props.opacity).toBe(0.4);
    e.unbindVariable(["r"], "opacity");
    expect(raw(e.doc, "r").bindings).toBeUndefined();
    expect(raw(e.doc, "r").opacity).toBe(0.4);
  });

  it("F9: text bound to a number: as stored before 0034, Figma's way when the binding says so", () => {
    const doc = new Doc();
    doc.resetStored(
      [
        ...base(),
        node("n", "variable", "c", { variableType: "number", values: { light: 3, dark: 4 } }),
        node("old", "text", "p", { characters: "Three", bindings: { characters: "n" } } as Props),
        node("new", "text", "p", {
          characters: "Three",
          bindings: { characters: { variable: "n", unit: "text" } },
        } as Props),
      ],
      "materialized",
    );
    expect(doc.get("old")?.props.characters).toBe("Three");
    expect(doc.get("new")?.props.characters).toBe("3");
  });

  it("F9: a value missing for a mode falls back to the first one stored, as before", () => {
    const doc = new Doc();
    doc.resetStored(
      [
        node("p", "page", ROOT_ID),
        node("t", "collection", ROOT_ID, {
          modes: [
            { id: "light", name: "Light" },
            { id: "dark", name: "Dark" },
            { id: "dim", name: "Dim" },
          ],
        }),
        // No value for Dim; Dark's was stored first, Light (the default) second.
        node("n", "variable", "t", { variableType: "number", values: { dark: 30, light: 10 } }),
        node("f", "frame", "p", { variableModes: { t: "dim" } }),
        node("r", "rect", "f", { width: 1, bindings: { width: "n" } } as Props),
      ],
      "materialized",
    );
    expect(doc.get("r")?.props.width).toBe(30);
  });
});

describe("library imports (F10)", () => {
  it("F10: a library copy remaps its style links and paint bindings, alias payloads whole", () => {
    const source = new Doc();
    source.resetStored(
      [
        ...base(),
        node("a", "variable", "c", {
          variableType: "color",
          values: { light: { alias: "v", opacity: 0.5 }, dark: { alias: "w" } },
        } as Props),
        node("s", "paintStyle", ROOT_ID, { fills: [fill("#ffffff", "v")] }),
        node("e", "effectStyle", ROOT_ID, {
          effects: [
            {
              type: "drop-shadow",
              x: 0,
              y: 1,
              blur: 2,
              spread: 0,
              color: "#000000",
              bind: { color: "a" },
            },
          ],
        } as Props),
        node("m", "frame", "p", {
          isComponent: true,
          fills: [fill("#ffffff", "v")],
          fillStyle: "s",
          effectStyle: "e",
          strokes: [
            {
              type: "linear",
              from: { x: 0, y: 0 },
              to: { x: 1, y: 1 },
              stops: [
                { position: 0, color: "#000000", bind: { color: "w" } },
                { position: 1, color: "#ffffff" },
              ],
            },
          ],
        } as Props),
      ],
      "materialized",
    );
    const target = new Doc();
    target.resetStored(
      [
        node("p", "page", ROOT_ID),
        node("v", "variable", ROOT_ID, { variableType: "color", values: {} }),
      ],
      "materialized",
    );
    const lib = { fileId: "libfile", name: "Library", publishId: "pub" };
    target.apply(importOps(target, source, lib, ["m"]));
    const id = (x: string) => libraryNodeId(lib.fileId, x);
    const main = raw(target, id("m")) as Props;
    expect(main.fillStyle).toBe(id("s"));
    expect(main.effectStyle).toBe(id("e"));
    expect((main.fills as Paint[])[0]?.bind?.color).toBe(id("v"));
    expect(
      (main.strokes as Array<{ stops: Array<{ bind?: { color?: string } }> }>)[0]?.stops[0]?.bind
        ?.color,
    ).toBe(id("w"));
    const style = raw(target, id("e")) as Props;
    expect((style.effects as Array<{ bind?: { color?: string } }>)[0]?.bind?.color).toBe(id("a"));
    expect(raw(target, id("a")).values).toEqual({
      light: { alias: id("v"), opacity: 0.5 },
      dark: { alias: id("w") },
    });
    // It resolves through the copied tokens, not the target's own "v".
    expect(color(target, id("m"))).toBe("#ffffff");
  });
});

describe("stored ops reach a warm second client the same as a fresh one", () => {
  it("record ops with variableModes, and their inverses, keep warm and cold documents equal", () => {
    const nodes = (): NodeRecord[] => [
      ...base(),
      node("m", "frame", "p", { isComponent: true }),
      node("f", "frame", "m", {}),
      node("r", "rect", "f", { fills: [fill("#ffffff", "v")] }),
      node("m2", "frame", "p", { isComponent: true }),
      node("i", "frame", "m2", { instanceOf: "m" }),
      node("j", "frame", "p", { instanceOf: "m2" }),
    ];
    const local = new Doc({ compactCopies: true });
    local.resetStored(nodes(), "compact");
    const remote = new Doc({ compactCopies: true });
    remote.resetStored(nodes(), "compact");
    const all = (doc: Doc) => [...doc.nodes()].map((n) => n.id);
    for (const id of all(remote)) remote.get(id);
    const ifr = local.childIds("i")[0] as string;
    const steps: Op[][] = [
      [{ op: "set", id: ifr, prop: "variableModes", value: { c: "dark" } }],
      [{ op: "set", id: "m2", prop: "variableModes", value: { c: "light" } }],
      [{ op: "set", id: "i", prop: "variableModes", value: { c: "dark" } }],
      [{ op: "set", id: ifr, prop: "variableModes", value: null }],
    ];
    const undos: Op[][] = [];
    for (const step of steps) {
      local.apply(step);
      undos.push([...local.lastStoredInverse]);
      remote.applyStored(local.lastStoredOps);
      expectFresh(remote, all(remote));
    }
    for (const undo of undos.reverse()) {
      remote.applyStored(undo);
      expectFresh(remote, all(remote));
    }
  });
});

describe("a rebase over a pending mode override (F3)", () => {
  it("undoes, applies the remote change, applies again: warm reads equal fresh ones", () => {
    const nodes = (): NodeRecord[] => [
      ...base(),
      node("m", "frame", "p", { isComponent: true }),
      node("f", "frame", "m", {}),
      node("r", "rect", "f", { fills: [fill("#ffffff", "v")] }),
      node("i", "frame", "p", { instanceOf: "m" }),
    ];
    const doc = new Doc({ compactCopies: true });
    const engine = new SyncEngine(doc, { clientId: "c1", setTimer: () => 0 });
    engine.connected(() => {});
    engine.receive({
      t: "welcome",
      sessionId: "s1",
      revn: 1,
      role: "editor",
      peers: [],
      mode: "snapshot",
      lastSeq: 0,
      copies: "compact",
    });
    engine.receive({ t: "snapshot", nodes: nodes(), done: true });
    const f = doc.childIds("i")[0] as string;
    const r = doc.childIds(f)[0] as string;
    expect(color(doc, r)).toBe("#ffffff");
    // A mode override made here, not yet confirmed (an override record's create, as stored).
    engine.commit([{ op: "set", id: f, prop: "variableModes", value: { c: "dark" } }]);
    expect(color(doc, r)).toBe("#000000");
    // Someone else's change arrives first: the pending edit is undone, theirs applied, and it again.
    engine.receive({
      t: "txn",
      revn: 2,
      ops: [{ op: "set", id: "v", prop: "values", value: { light: "#eeeeee", dark: "#111111" } }],
      author: { userId: "u2", sessionId: "s2" },
    });
    expect(color(doc, r)).toBe("#111111");
    expectFresh(doc, [f, r]);
    // And a remote mode set on the main while the override is pending: the override still wins.
    engine.receive({
      t: "txn",
      revn: 3,
      ops: [{ op: "set", id: "m", prop: "variableModes", value: { c: "light" } }],
      author: { userId: "u2", sessionId: "s2" },
    });
    expect(color(doc, r)).toBe("#111111");
    expectFresh(doc, [f, r, "i"]);
    // The room refuses the override: it's rolled back (its stored inverse), the main's mode again.
    engine.flush();
    engine.receive({ t: "reject", seq: 1, code: "invalid_value", message: "No.", fix: {} });
    expect(color(doc, r)).toBe("#eeeeee");
    expectFresh(doc, [f, r, "i"]);
  });
});
