/**
 * Converting a file an instance at a time (convert.ts, decision 0029 phase
 * 4b): what the review of the room's conversion found, each pinned here.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  CopyView,
  compactByInstance,
  DEFAULT_TRANSITION,
  expand,
  firstDifference,
  heldNodeIds,
  ID_PATTERN,
  MemoryStore,
  NODE_ID_PROPS,
  type NodeRecord,
  PROPS,
  type Props,
  ROOT_ID,
  renameIds,
  unlinkedNode,
} from "../src/index";

function node(
  id: string,
  type: NodeRecord["type"],
  parent: string,
  key: string,
  props: Record<string, unknown> = {},
): NodeRecord {
  return { id, type, parent, key, props: props as Props };
}

/** A main and its materialized instances, as `instantiateOps` stores them. */
function file(): NodeRecord[] {
  return [
    node("page1", "page", ROOT_ID, "a0", { name: "Page" }),
    node("card", "frame", "page1", "a0", { name: "Card", isComponent: true, width: 100 }),
    node("title", "text", "card", "a0", { characters: "Title", width: 50, height: 10 }),
    node("body", "rect", "card", "a1", { width: 80, height: 40 }),
  ];
}

function instance(rootId: string, key: string, ids: { title: string; body: string }) {
  return [
    node(rootId, "frame", "page1", key, { name: "Card", width: 100, instanceOf: "card", x: 0 }),
    node(ids.title, "text", rootId, "a0", {
      characters: "Title",
      width: 50,
      height: 10,
      mirrors: "title",
    }),
    node(ids.body, "rect", rootId, "a1", { width: 80, height: 40, mirrors: "body" }),
  ];
}

const childOrder = (nodes: readonly NodeRecord[], parent: string) =>
  new MemoryStore(nodes).childIds(parent);

describe("converting an instance at a time", () => {
  it("keeps the drawing order of siblings that share a key", () => {
    // Two layers in the main share a key (two people inserted at one place at once): the main
    // draws them by id, title before zzBody. The copy's ids sort the other way round, so the
    // materialized copy draws its body first. Built from the main, it would draw the title first.
    const nodes = [
      node("page1", "page", ROOT_ID, "a0", { name: "Page" }),
      node("card", "frame", "page1", "a0", { name: "Card", isComponent: true, width: 100 }),
      node("title", "text", "card", "a5", { characters: "Title", width: 50, height: 10 }),
      node("zzBody", "rect", "card", "a5", { width: 80, height: 40 }),
      node("inst", "frame", "page1", "a1", { name: "Card", width: 100, instanceOf: "card" }),
      node("zTitle", "text", "inst", "a5", {
        characters: "Title",
        width: 50,
        height: 10,
        mirrors: "title",
      }),
      node("aBody", "rect", "inst", "a5", { width: 80, height: 40, mirrors: "zzBody" }),
    ];
    expect(childOrder(nodes, "inst")).toEqual(["aBody", "zTitle"]);
    const result = compactByInstance(nodes);
    // Either it's kept materialized (detached, its look as it was) or built in the same order.
    // The order a client draws them in: built copies follow their main's order.
    const view = new CopyView(new MemoryStore(result.nodes));
    const want = renameIds(nodes, result.ids);
    expect(view.childIds("inst")).toEqual(childOrder(want, "inst"));
    // Here it can't be built in that order, so it's detached, keeping its layers as they were.
    expect(result.detached.get("inst")).toMatch(/order/);
    const unlinked = want.map((n) =>
      n.id === "inst" || n.parent === "inst" ? unlinkedNode(n) : n,
    );
    expect(firstDifference(unlinked, expand(result.nodes))).toBeNull();
  });

  it("renames a copy's link to another instance's copy, whichever converts first", () => {
    // A's title (converted first: it comes first in the file) links to B's body.
    const nodes = [
      ...file(),
      ...instance("instA", "a1", { title: "aTitle", body: "aBody" }),
      ...instance("instB", "a2", { title: "bTitle", body: "bBody" }),
    ];
    const link = [
      {
        id: "r1",
        trigger: { type: "tap" },
        action: { type: "navigate", to: "bBody" },
        transition: { type: "instant" },
      },
    ];
    const at = nodes.findIndex((n) => n.id === "aTitle");
    const title = nodes[at] as NodeRecord;
    nodes[at] = {
      ...title,
      props: { ...title.props, reactions: link, overrides: ["reactions"] } as Props,
    };
    const result = compactByInstance(nodes);
    const bBody = result.ids.get("bBody") as string;
    expect(bBody).toBeTruthy();
    const built = expand(result.nodes);
    const aTitle = built.find((n) => n.id === result.ids.get("aTitle")) as NodeRecord;
    expect(JSON.stringify(aTitle.props.reactions)).toContain(bBody);
    expect(JSON.stringify(aTitle.props.reactions)).not.toContain('"bBody"');
    // No stored node holds the old id any more.
    expect(JSON.stringify(result.nodes)).not.toContain('"bBody"');
  });
});

describe("ids held in values (heldNodeIds)", () => {
  it("covers every property whose schema holds an id, node ids by what they name", () => {
    const pattern = ID_PATTERN.source.slice(1, 12);
    const holding = Object.entries(PROPS)
      .filter(([, spec]) =>
        JSON.stringify(
          z.toJSONSchema(spec.schema as z.ZodType, { unrepresentable: "any" }),
        ).includes(pattern),
      )
      .map(([prop]) => prop)
      .sort();
    // Ids that aren't nodes': a collection's modes, a library's file and publish.
    expect(holding).toEqual([...NODE_ID_PROPS, "modes", "libraryFile", "libraryPublish"].sort());
  });

  it("lists each kind", () => {
    const transition = DEFAULT_TRANSITION;
    expect(
      heldNodeIds({
        readingOrder: ["a", "b"],
        reactions: [
          { id: "r1", trigger: { type: "tap" }, action: { type: "navigate", to: "c" }, transition },
          { id: "r2", trigger: { type: "tap" }, action: { type: "back" }, transition },
        ],
        flows: [{ id: "f1", name: "F", start: "d", description: "" }],
        instanceOf: "e",
        mirrors: "f",
        textStyle: "g",
        path: ["h", "i"],
        bindings: { fill: "j" },
        variableModes: { k: "m1" },
        values: { m1: { alias: "l" }, m2: "#ffffff" },
        modes: [{ id: "m1", name: "Light" }],
        componentProps: [
          { id: "10:1", name: "Show", type: "boolean", default: true },
          { id: "10:2", name: "Icon", type: "instance", default: "m", preferred: ["n", "o"] },
        ],
      } as Props),
    ).toEqual({
      layers: ["a", "b", "c", "d"],
      others: ["e", "f", "g", "h", "i", "j", "k", "l", "m", "n", "o"],
    });
  });
});
