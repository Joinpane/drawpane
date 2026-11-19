/**
 * Review 8 of #187, B2 and B5: what a property's edit may write.
 *
 * - B5: a property id is unique only among one component's definitions. A
 *   reference belongs to the component whose main it was made in (where
 *   the layer's own `propRefs` were set, not copied from its main layer), so
 *   an outer property drives only layers bound to the outer component's
 *   definition, and a nested component's own properties are reached only
 *   through that nested instance.
 * - B2: a variant switch carries a property's value by id only onto layers
 *   the name carry gave nothing: a field it carried by name stays as it is.
 *
 * Both copy forms, through real sync engines and a room stand-in.
 */
import { Doc, instanceProperties } from "@drawpane/editor";
import { getProp, type NodeRecord, NodeRecordSchema, ROOT_ID } from "@drawpane/model";
import { describe, expect, it } from "vitest";
import { FORMS, node, Room } from "./property-rooms";

/** A layer named `name` in `parent`, as `doc` presents it. */
const named = (doc: Doc, parent: string, name: string) =>
  doc.childIds(parent).find((id) => getProp(doc.get(id)?.props ?? {}, "name") === name) as string;

/** What every client and the room's file hold for a layer's text. */
const textsEverywhere = (room: Room, find: (doc: Doc) => string) => {
  const opened = new Doc({ compactCopies: room.copies === "compact" });
  opened.resetStored(structuredClone([...room.store.nodes()]), room.copies);
  return [opened, ...room.clients.map((c) => c.editor.doc)].map((doc) =>
    getProp(doc.get(find(doc))?.props ?? {}, "characters"),
  );
};

/** Leaf (its own Label, id "label") nested and exposed in A (its own Label, id "label" too). */
function reused(): NodeRecord[] {
  const nodes = [
    node("p", "page", ROOT_ID, "a0", {}),
    node("leaf", "frame", "p", "a0", {
      isComponent: true,
      width: 100,
      height: 30,
      componentProps: [{ id: "label", name: "Leaf label", type: "text" }],
    }),
    node("lt", "text", "leaf", "a0", {
      name: "Leaf text",
      characters: "Leaf base",
      propRefs: { characters: "label" },
    }),
    node("a", "frame", "p", "a1", {
      isComponent: true,
      width: 100,
      height: 60,
      componentProps: [{ id: "label", name: "Outer label", type: "text" }],
    }),
    node("at", "text", "a", "a0", {
      name: "Outer text",
      characters: "Outer base",
      propRefs: { characters: "label" },
    }),
    node("na", "frame", "a", "a1", {
      name: "Nested",
      instanceOf: "leaf",
      width: 100,
      height: 30,
      exposeProps: true,
    }),
    node("nat", "text", "na", "a0", {
      mirrors: "lt",
      name: "Leaf text",
      characters: "Leaf base",
      propRefs: { characters: "label" },
    }),
    node("i", "frame", "p", "a2", { instanceOf: "a", width: 100, height: 60 }),
    node("it", "text", "i", "a0", {
      mirrors: "at",
      name: "Outer text",
      characters: "Outer base",
      propRefs: { characters: "label" },
    }),
    node("ni", "frame", "i", "a1", {
      mirrors: "na",
      name: "Nested",
      instanceOf: "leaf",
      width: 100,
      height: 30,
      exposeProps: true,
    }),
    node("nit", "text", "ni", "a0", {
      mirrors: "nat",
      name: "Leaf text",
      characters: "Leaf base",
      propRefs: { characters: "label" },
    }),
  ];
  for (const n of nodes) NodeRecordSchema.parse(n);
  return nodes;
}

for (const form of FORMS)
  describe(`a property drives only its own component's references (${form})`, () => {
    it("keeps a nested component's value when the outer one's property of the same id is set (B5)", () => {
      const room = new Room(reused(), form);
      const a = room.join("a");
      room.join("b");
      const doc = a.editor.doc;
      const nested = named(doc, "i", "Nested");
      // Each instance lists only its own component's layer for "label".
      expect(instanceProperties(doc, "i")?.rows.find((r) => r.id === "label")?.targets).toEqual([
        named(doc, "i", "Outer text"),
      ]);
      expect(instanceProperties(doc, nested)?.rows.find((r) => r.id === "label")?.targets).toEqual([
        named(doc, nested, "Leaf text"),
      ]);
      a.editor.setInstanceProperty(nested, "label", "Nested accepted");
      room.settle();
      a.editor.setInstanceProperty("i", "label", "Outer accepted");
      room.settle();
      expect(room.rejected).toEqual([]);
      expect(textsEverywhere(room, (d) => named(d, named(d, "i", "Nested"), "Leaf text"))).toEqual([
        "Nested accepted",
        "Nested accepted",
        "Nested accepted",
      ]);
      expect(textsEverywhere(room, (d) => named(d, "i", "Outer text"))).toEqual([
        "Outer accepted",
        "Outer accepted",
        "Outer accepted",
      ]);
      // And the exposed row reads its own, the outer row its own.
      expect(a.row("i", "label")?.value).toBe("Outer accepted");
      expect(a.row(named(doc, "i", "Nested"), "label")?.value).toBe("Nested accepted");
    });

    it("drives a layer inside a nested instance that the outer main bound to its own property", () => {
      // The outer main binds its nested Leaf's text to its own "label": that copy layer's
      // references are A's (set there, marked as its own), not Leaf's.
      // A's binding is its own: Leaf's property has another id, as it would in Figma.
      const nodes = reused().map((n): NodeRecord => {
        const props = n.props as Record<string, unknown>;
        if (n.id === "nat")
          return {
            ...n,
            props: { ...props, propRefs: { characters: "label" }, overrides: ["propRefs"] },
          } as NodeRecord;
        if (n.id === "leaf")
          return {
            ...n,
            props: {
              ...props,
              componentProps: [{ id: "leafLabel", name: "Leaf label", type: "text" }],
            },
          } as NodeRecord;
        if (n.id === "lt")
          return { ...n, props: { ...props, propRefs: { characters: "leafLabel" } } } as NodeRecord;
        return n;
      });
      const room = new Room(nodes, form);
      const a = room.join("a");
      const doc = a.editor.doc;
      const nested = named(doc, "i", "Nested");
      expect(
        [
          ...(instanceProperties(doc, "i")?.rows.find((r) => r.id === "label")?.targets ?? []),
        ].sort(),
      ).toEqual([named(doc, "i", "Outer text"), named(doc, nested, "Leaf text")].sort());
      // Leaf's own property isn't bound there any more (A rebound the layer).
      expect(
        instanceProperties(doc, nested)?.rows.find((r) => r.id === "leafLabel"),
      ).toBeUndefined();
      a.editor.setInstanceProperty("i", "label", "Both");
      room.settle();
      expect(textsEverywhere(room, (d) => named(d, named(d, "i", "Nested"), "Leaf text"))).toEqual([
        "Both",
        "Both",
      ]);
    });

    it("keeps a library component's property apart from a local one with the same id (B5)", () => {
      const source = new Doc({ compactCopies: false });
      source.resetStored(
        reused().filter((n) => n.id === "p" || n.id === "leaf" || n.id === "lt"),
        "materialized",
      );
      const room = new Room(
        reused().filter((n) => ["p", "a", "at"].includes(n.id)),
        form,
      );
      const a = room.join("a");
      room.join("b");
      const nested = a.editor.insertLibraryComponent(
        source,
        { fileId: "leafLibrary", name: "Leaf library", publishId: "v1" },
        "leaf",
      ) as string;
      a.editor.commit([
        { op: "move", id: nested, parent: "a", key: "a1" },
        { op: "set", id: nested, prop: "exposeProps", value: true },
      ]);
      room.settle();
      const instance = a.editor.insertInstance("a") as string;
      room.settle();
      const doc = a.editor.doc;
      const innerRoot = doc
        .childIds(instance)
        .find((id) => doc.get(id)?.type === "frame") as string;
      const inner = doc.childIds(innerRoot)[0] as string;
      a.editor.setInstanceProperty(innerRoot, "label", "Nested accepted");
      room.settle();
      a.editor.setInstanceProperty(instance, "label", "Outer accepted");
      room.settle();
      expect(room.rejected).toEqual([]);
      expect(textsEverywhere(room, () => inner)).toEqual([
        "Nested accepted",
        "Nested accepted",
        "Nested accepted",
      ]);
    });
  });

/** Variants A and B of a set with a text property "label", each with a Label and a Title. */
function twoTexts(): NodeRecord[] {
  const nodes = [
    node("p", "page", ROOT_ID, "a0", {}),
    node("set", "frame", "p", "a0", {
      isComponentSet: true,
      componentProps: [{ id: "label", name: "Label", type: "text" }],
    }),
    node("a", "frame", "set", "a0", {
      isComponent: true,
      variantProps: { State: "A" },
      width: 100,
      height: 30,
    }),
    // A's property drives its Label.
    node("al", "text", "a", "a0", {
      name: "Label",
      characters: "Base",
      propRefs: { characters: "label" },
    }),
    node("ac", "text", "a", "a1", { name: "Title", characters: "Caption" }),
    node("b", "frame", "set", "a1", {
      isComponent: true,
      variantProps: { State: "B" },
      width: 100,
      height: 30,
    }),
    // B's property drives its Title.
    node("bl", "text", "b", "a0", {
      name: "Title",
      characters: "Base",
      propRefs: { characters: "label" },
    }),
    node("bc", "text", "b", "a1", { name: "Label", characters: "Caption" }),
    node("i", "frame", "p", "a1", { instanceOf: "a", width: 100, height: 30 }),
    node("il", "text", "i", "a0", {
      mirrors: "al",
      name: "Label",
      characters: "Base",
      propRefs: { characters: "label" },
    }),
    node("ic", "text", "i", "a1", { mirrors: "ac", name: "Title", characters: "Caption" }),
  ];
  for (const n of nodes) NodeRecordSchema.parse(n);
  return nodes;
}

for (const form of FORMS)
  describe(`a variant switch's carry by id (${form})`, () => {
    it("never replaces a field the name carry kept (B2)", () => {
      const room = new Room(twoTexts(), form);
      const a = room.join("a");
      room.join("b");
      a.editor.setInstanceProperty("i", "label", "Property accepted");
      a.editor.commit([
        {
          op: "set",
          id: named(a.editor.doc, "i", "Title"),
          prop: "characters",
          value: "Manual accepted",
        },
      ]);
      room.settle();
      a.editor.setInstanceVariant("i", "State", "B");
      room.settle();
      expect(room.rejected).toEqual([]);
      // B's Title (its property's layer) kept the Title's own text, carried by name; B's Label
      // took A's Label's, by name too. Nothing was lost.
      expect(textsEverywhere(room, (d) => named(d, "i", "Title"))).toEqual([
        "Manual accepted",
        "Manual accepted",
        "Manual accepted",
      ]);
      expect(textsEverywhere(room, (d) => named(d, "i", "Label"))).toEqual([
        "Property accepted",
        "Property accepted",
        "Property accepted",
      ]);
    });

    it("still carries by id onto a layer the name carry gave nothing", () => {
      // A's Title isn't edited: B's Title, its property's layer, takes the value by id.
      const room = new Room(twoTexts(), form);
      const a = room.join("a");
      a.editor.setInstanceProperty("i", "label", "Property accepted");
      room.settle();
      a.editor.setInstanceVariant("i", "State", "B");
      room.settle();
      expect(a.row("i", "label")).toMatchObject({ value: "Property accepted", changed: true });
      expect(textsEverywhere(room, (d) => named(d, "i", "Title"))).toEqual([
        "Property accepted",
        "Property accepted",
      ]);
    });
  });

/**
 * Review 9 of #187 (R9-B1): Outer and Leaf are mains in one component set;
 * Outer holds an exposed instance of Leaf. Their "label" definitions are
 * each main's own (`shared` false), or one definition on the set both use
 * (`shared` true). Either way the nested Leaf is another occurrence of the
 * property: the outer instance's edit doesn't reach it.
 */
function sameSet(shared: boolean): NodeRecord[] {
  const own = (name: string) =>
    shared ? {} : { componentProps: [{ id: "label", name, type: "text" }] };
  const nodes = [
    node("p", "page", ROOT_ID, "a0", {}),
    node("set", "frame", "p", "a0", {
      isComponentSet: true,
      ...(shared ? { componentProps: [{ id: "label", name: "Label", type: "text" }] } : {}),
    }),
    node("leaf", "frame", "set", "a0", {
      isComponent: true,
      variantProps: { State: "Leaf" },
      width: 100,
      height: 30,
      ...own("Leaf label"),
    }),
    node("lt", "text", "leaf", "a0", {
      name: "Leaf text",
      characters: "Leaf base",
      propRefs: { characters: "label" },
    }),
    node("a", "frame", "set", "a1", {
      isComponent: true,
      variantProps: { State: "Outer" },
      width: 100,
      height: 60,
      ...own("Outer label"),
    }),
    node("at", "text", "a", "a0", {
      name: "Outer text",
      characters: "Outer base",
      propRefs: { characters: "label" },
    }),
    node("na", "frame", "a", "a1", {
      name: "Nested",
      instanceOf: "leaf",
      width: 100,
      height: 30,
      exposeProps: true,
    }),
    node("nat", "text", "na", "a0", {
      mirrors: "lt",
      name: "Leaf text",
      characters: "Leaf base",
      propRefs: { characters: "label" },
    }),
    node("i", "frame", "p", "a2", { instanceOf: "a", width: 100, height: 60 }),
    node("it", "text", "i", "a0", {
      mirrors: "at",
      name: "Outer text",
      characters: "Outer base",
      propRefs: { characters: "label" },
    }),
    node("ni", "frame", "i", "a1", {
      mirrors: "na",
      name: "Nested",
      instanceOf: "leaf",
      width: 100,
      height: 30,
      exposeProps: true,
    }),
    node("nit", "text", "ni", "a0", {
      mirrors: "nat",
      name: "Leaf text",
      characters: "Leaf base",
      propRefs: { characters: "label" },
    }),
  ];
  for (const n of nodes) NodeRecordSchema.parse(n);
  return nodes;
}

for (const shared of [false, true])
  for (const form of FORMS)
    describe(`a nested main from the same set is another occurrence (${form}, ${shared ? "a definition on the set" : "each main's own"})`, () => {
      it("keeps the nested instance's accepted value when the outer one's is set (R9-B1)", () => {
        const room = new Room(sameSet(shared), form);
        const a = room.join("a");
        room.join("b");
        const doc = a.editor.doc;
        const nested = named(doc, "i", "Nested");
        expect(instanceProperties(doc, "i")?.rows.find((r) => r.id === "label")?.targets).toEqual([
          named(doc, "i", "Outer text"),
        ]);
        a.editor.setInstanceProperty(nested, "label", "Nested accepted");
        room.settle();
        a.editor.setInstanceProperty("i", "label", "Outer accepted");
        room.settle();
        expect(room.rejected).toEqual([]);
        const leafText = (d: Doc) => named(d, named(d, "i", "Nested"), "Leaf text");
        expect(textsEverywhere(room, leafText)).toEqual([
          "Nested accepted",
          "Nested accepted",
          "Nested accepted",
        ]);
        expect(textsEverywhere(room, (d) => named(d, "i", "Outer text"))).toEqual([
          "Outer accepted",
          "Outer accepted",
          "Outer accepted",
        ]);
        // A reset of the outer one leaves the nested one's too.
        a.editor.resetInstanceProperty("i", "label");
        room.settle();
        expect(textsEverywhere(room, leafText)).toEqual([
          "Nested accepted",
          "Nested accepted",
          "Nested accepted",
        ]);
      });
    });
