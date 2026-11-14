import { describe, expect, it } from "vitest";
import {
  type BranchChange,
  branchChanges,
  changeKey,
  mergeOps,
  POSITION,
  type Resolution,
} from "../src/branches";
import { nodeReader } from "../src/libraries";
import type { NodeRecord } from "../src/ops";

const node = (
  id: string,
  type: NodeRecord["type"],
  parent: string,
  key: string,
  props: Record<string, unknown> = {},
): NodeRecord => ({ id, type, parent, key, props }) as NodeRecord;

/** A page with a card (holding a title) and a badge. */
const BASE: NodeRecord[] = [
  node("p", "page", "root", "a0", { name: "Page" }),
  node("card", "frame", "p", "a0", { name: "Card", width: 320 }),
  node("title", "text", "card", "a0", { characters: "Hello", fontSize: 16 }),
  node("badge", "rect", "p", "a1", { name: "Badge", opacity: 1 }),
];

/** BASE with edits: replace a node's props (merged), remove ids, add nodes. */
function edit(
  nodes: readonly NodeRecord[],
  changes: {
    set?: Record<string, Record<string, unknown>>;
    move?: Record<string, { parent: string; key: string }>;
    remove?: string[];
    add?: NodeRecord[];
  },
): NodeRecord[] {
  const removed = new Set(changes.remove ?? []);
  const gone = (n: NodeRecord): boolean =>
    removed.has(n.id) || (n.parent !== "root" && nodes.some((p) => p.id === n.parent && gone(p)));
  return [
    ...nodes
      .filter((n) => !gone(n))
      .map((n) => ({
        ...n,
        ...(changes.move?.[n.id] ?? {}),
        props: { ...n.props, ...(changes.set?.[n.id] ?? {}) },
      })),
    ...(changes.add ?? []),
  ];
}

function diff(branch: NodeRecord[], main: NodeRecord[] = BASE) {
  return branchChanges(nodeReader(BASE), nodeReader(branch), nodeReader(main));
}

function merge(
  branch: NodeRecord[],
  main: NodeRecord[] = BASE,
  resolutions: Record<string, Resolution> = {},
) {
  const changes = diff(branch, main);
  return mergeOps(
    nodeReader(main),
    nodeReader(branch),
    changes,
    new Map(Object.entries(resolutions)),
  );
}

const changed = (changes: BranchChange[]) =>
  changes.flatMap((c) => (c.kind === "changed" ? [[c.id, c.field, c.conflict]] : []));

describe("what a branch changed", () => {
  it("is nothing when nothing changed, whatever main did", () => {
    expect(diff(BASE, edit(BASE, { set: { card: { width: 400 } } }))).toEqual([]);
  });

  it("is each property it changed, with main's value alongside", () => {
    const branch = edit(BASE, { set: { title: { characters: "Hi" } } });
    expect(diff(branch)).toEqual([
      {
        kind: "changed",
        id: "title",
        field: "characters",
        base: "Hello",
        branch: "Hi",
        main: "Hello",
        conflict: false,
      },
    ]);
    expect(merge(branch)).toEqual([{ op: "set", id: "title", prop: "characters", value: "Hi" }]);
  });

  it("conflicts only where main changed the same property to something else", () => {
    const branch = edit(BASE, { set: { card: { width: 400, name: "Card A" } } });
    const main = edit(BASE, {
      set: { card: { width: 360, name: "Card A" }, title: { fontSize: 20 } },
    });
    expect(changed(diff(branch, main))).toEqual([
      ["card", "name", false],
      ["card", "width", true],
    ]);
    // Main's value stays unless the conflict is resolved for the branch.
    expect(merge(branch, main)).toEqual([{ op: "set", id: "card", prop: "name", value: "Card A" }]);
    expect(merge(branch, main, { "card:width": "branch" })).toEqual([
      { op: "set", id: "card", prop: "name", value: "Card A" },
      { op: "set", id: "card", prop: "width", value: 400 },
    ]);
  });

  it("brings new layers in parents first, and leaves out one whose parent main deleted", () => {
    const branch = edit(BASE, {
      add: [
        node("chip", "frame", "p", "a2", { name: "Chip" }),
        node("dot", "ellipse", "chip", "a0"),
        node("sub", "text", "card", "a1", { characters: "Sub" }),
      ],
    });
    const main = edit(BASE, { remove: ["card"] });
    const changes = diff(branch, main);
    // In document order: the card's new subtitle comes before the new chip.
    expect(changes.filter((c) => c.kind === "added").map((c) => [c.id, c.conflict])).toEqual([
      ["sub", "parent-gone"],
      ["chip", null],
      ["dot", null],
    ]);
    expect(merge(branch, main).map((op) => [op.op, op.id])).toEqual([
      ["create", "chip"],
      ["create", "dot"],
    ]);
  });

  it("removes what the branch deleted, but asks first when main edited it since", () => {
    const branch = edit(BASE, { remove: ["card", "badge"] });
    const main = edit(BASE, { set: { title: { characters: "Edited on main" } } });
    const changes = diff(branch, main);
    // The card's title went with it: only the top of what was deleted counts.
    expect(changes.map((c) => [c.kind, c.id, c.conflict])).toEqual([
      ["removed", "card", "changed-on-main"],
      ["removed", "badge", null],
    ]);
    expect(merge(branch, main)).toEqual([{ op: "delete", id: "badge" }]);
    expect(merge(branch, main, { card: "branch" })).toEqual([
      { op: "delete", id: "card" },
      { op: "delete", id: "badge" },
    ]);
  });

  it("moves a layer the branch moved", () => {
    const branch = edit(BASE, { move: { badge: { parent: "card", key: "a1" } } });
    const changes = diff(branch);
    expect(changes).toEqual([
      expect.objectContaining({ kind: "changed", id: "badge", field: POSITION, conflict: false }),
    ]);
    expect(merge(branch)).toEqual([{ op: "move", id: "badge", parent: "card", key: "a1" }]);
    expect(changeKey(changes[0] as BranchChange)).toBe("badge:position");
  });

  it("agrees with main where both made the same change", () => {
    const both = edit(BASE, { set: { badge: { opacity: 0.5 } } });
    expect(changed(diff(both, both))).toEqual([["badge", "opacity", false]]);
  });

  it("conflicts where main deleted a layer the branch changed", () => {
    const branch = edit(BASE, { set: { badge: { opacity: 0.2 } } });
    const main = edit(BASE, { remove: ["badge"] });
    expect(changed(diff(branch, main))).toEqual([["badge", "opacity", true]]);
    expect(merge(branch, main, { "badge:opacity": "branch" })).toEqual([]);
  });
});
