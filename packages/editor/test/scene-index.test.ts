/**
 * The scene keeps what it derives (matrices, bounds, extents, children
 * indexes) across changes, dropping only what each change affects
 * (decision 0028). Checked against a scene made afresh after every random
 * change, and its dirty places checked to hold every layer that may look
 * different.
 */
import { keyBetween, type NodeRecord, type Op, type PropName, ROOT_ID } from "@drawpane/model";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { Doc } from "../src/doc";
import type { Rect } from "../src/geometry";
import { hasMask } from "../src/masks";
import { paintMargin } from "../src/reach";
import { INDEX_MIN, Scene } from "../src/scene";
import { touches } from "../src/spatial";

type Action =
  | {
      kind: "create";
      type: "rect" | "frame" | "group" | "ellipse";
      parent: number;
      x: number;
      y: number;
      w: number;
      h: number;
    }
  | {
      kind: "geometry";
      node: number;
      prop: "x" | "y" | "width" | "height" | "rotation";
      value: number;
    }
  | { kind: "look"; node: number; look: number }
  | { kind: "move"; node: number; into: number; top: boolean }
  | { kind: "delete"; node: number }
  | { kind: "batch"; count: number };

const LOOKS: Array<[PropName, unknown]> = [
  ["effects", [{ type: "drop-shadow", x: 4, y: 8, blur: 12, spread: 0, color: "#00000040" }]],
  ["effects", [{ type: "layer-blur", radius: 6 }]],
  ["effects", [{ type: "background-blur", radius: 8 }]],
  ["effects", []],
  ["strokes", [{ type: "solid", color: "#000000" }]],
  ["strokeWeight", 12],
  ["clipContent", false],
  ["clipContent", true],
  ["visible", false],
  ["visible", true],
  ["isMask", true],
  ["isMask", false],
  ["opacity", 0.5],
  ["fills", [{ type: "solid", color: "#ff0000" }]],
];

const action: fc.Arbitrary<Action> = fc.oneof(
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant("create" as const),
      type: fc.constantFrom("rect", "frame", "group", "ellipse"),
      parent: fc.nat(),
      x: fc.integer({ min: -2000, max: 2000 }),
      y: fc.integer({ min: -2000, max: 2000 }),
      w: fc.integer({ min: 0, max: 600 }),
      h: fc.integer({ min: 0, max: 600 }),
    }),
  },
  {
    weight: 4,
    arbitrary: fc.record({
      kind: fc.constant("geometry" as const),
      node: fc.nat(),
      prop: fc.constantFrom("x", "y", "width", "height", "rotation"),
      value: fc.integer({ min: -1500, max: 1500 }),
    }),
  },
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant("look" as const),
      node: fc.nat(),
      look: fc.nat({ max: LOOKS.length - 1 }),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant("move" as const),
      node: fc.nat(),
      into: fc.nat(),
      top: fc.boolean(),
    }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("delete" as const), node: fc.nat() }) },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant("batch" as const),
      count: fc.integer({ min: 2, max: 4 }),
    }),
  },
);

let made = 0;
function create(
  type: NodeRecord["type"],
  parent: string,
  key: string,
  props: Record<string, unknown>,
): Op {
  return { op: "create", id: `n${made++}`, type, parent, key, props } as Op;
}

/** Two pages; on the first, a page with more children than the index threshold, and a frame too. */
function seed(doc: Doc): void {
  const ops: Op[] = [
    { op: "create", id: "p1", type: "page", parent: ROOT_ID, key: "a0", props: {} },
    { op: "create", id: "p2", type: "page", parent: ROOT_ID, key: "a1", props: {} },
    {
      op: "create",
      id: "big",
      type: "frame",
      parent: "p1",
      key: "a0",
      props: { x: 0, y: 0, width: 3000, height: 3000, clipContent: false },
    },
  ];
  let key: string | null = "a0";
  for (let i = 0; i < INDEX_MIN + 6; i++) {
    key = keyBetween(key, null);
    ops.push(
      create("rect", "p1", key, {
        x: (i % 10) * 220,
        y: Math.floor(i / 10) * 220,
        width: 200,
        height: 200,
      }),
    );
    ops.push(
      create("rect", "big", key, {
        x: (i % 8) * 300 - 400,
        y: Math.floor(i / 8) * 300,
        width: 120,
        height: 80,
      }),
    );
  }
  ops.push(create("rect", "p2", "a0", { x: 0, y: 0, width: 50, height: 50 }));
  doc.apply(ops);
}

function layers(doc: Doc): NodeRecord[] {
  return [...doc.nodes()].filter((n) => n.type !== "page");
}

function pick<T>(list: readonly T[], i: number): T | undefined {
  return list.length === 0 ? undefined : list[i % list.length];
}

function opsFor(doc: Doc, a: Action): Op[] {
  const all = layers(doc);
  const containers = [...doc.nodes()].filter(
    (n) => n.type === "page" || n.type === "frame" || n.type === "group",
  );
  switch (a.kind) {
    case "create": {
      const parent = pick(containers, a.parent);
      if (!parent) return [];
      const siblings = doc.childIds(parent.id);
      const last = siblings.at(-1);
      const key = keyBetween(last ? (doc.get(last) as NodeRecord).key : null, null);
      if (a.type === "group") {
        // A group needs a member to have bounds: make it with one.
        const group = create("group", parent.id, key, {});
        return [group, create("rect", group.id, "a0", { x: a.x, y: a.y, width: a.w, height: a.h })];
      }
      return [create(a.type, parent.id, key, { x: a.x, y: a.y, width: a.w, height: a.h })];
    }
    case "geometry": {
      const node = pick(all, a.node);
      if (!node || node.type === "group") return [];
      const value =
        a.prop === "width" || a.prop === "height"
          ? Math.abs(a.value) % 700
          : a.prop === "rotation"
            ? a.value % 360
            : a.value;
      return [{ op: "set", id: node.id, prop: a.prop, value }];
    }
    case "look": {
      const node = pick(all, a.node);
      const [prop, value] = LOOKS[a.look] as [PropName, unknown];
      if (!node) return [];
      if (prop === "clipContent" && node.type !== "frame") return [];
      if (prop === "isMask" && node.type !== "rect" && node.type !== "ellipse") return [];
      if (
        (prop === "strokes" || prop === "strokeWeight" || prop === "fills") &&
        node.type === "group"
      )
        return [];
      return [{ op: "set", id: node.id, prop, value }];
    }
    case "move": {
      const node = pick(all, a.node);
      const into = pick(containers, a.into);
      if (!node || !into || into.id === node.id) return [];
      // Not into itself or its own descendants.
      for (let at: NodeRecord | undefined = into; at; at = doc.get(at.parent))
        if (at.id === node.id) return [];
      if (into.type === "group" && doc.childIds(into.id).length === 0) return [];
      const siblings = doc.childIds(into.id).filter((id) => id !== node.id);
      const edge = a.top ? siblings.at(-1) : siblings[0];
      const edgeKey = edge ? (doc.get(edge) as NodeRecord).key : null;
      const key = a.top ? keyBetween(edgeKey, null) : keyBetween(null, edgeKey);
      return [{ op: "move", id: node.id, parent: into.id, key }];
    }
    case "delete": {
      const node = pick(all, a.node);
      return node ? [{ op: "delete", id: node.id }] : [];
    }
    case "batch":
      return [];
  }
}

const EPS = 1e-6;
function contains(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x - EPS &&
    inner.y >= outer.y - EPS &&
    inner.x + inner.width <= outer.x + outer.width + EPS &&
    inner.y + inner.height <= outer.y + outer.height + EPS
  );
}

function clip(a: Rect, b: Rect): Rect | null {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.width, b.x + b.width);
  const y1 = Math.min(a.y + a.height, b.y + b.height);
  return x1 >= x0 && y1 >= y0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : null;
}

interface Painted {
  readonly record: NodeRecord;
  readonly page: string;
  /** Where the layer itself can paint: its bounds and margin, cut to the frames that clip it. */
  readonly area: Rect | null;
  readonly matrix: string;
  /** Its ancestors' records: a change to one changes how it looks. */
  readonly chain: readonly NodeRecord[];
}

/** What each visible layer paints and where, from a fresh scene. */
function painted(doc: Doc): Map<string, Painted> {
  const scene = new Scene(doc);
  const out = new Map<string, Painted>();
  for (const node of layers(doc)) {
    if (!scene.isVisible(node.id)) continue;
    const page = doc.pageOf(node.id);
    if (!page) continue;
    const b = scene.bounds(node.id);
    const m = paintMargin(node);
    let area: Rect | null = b
      ? { x: b.x - m, y: b.y - m, width: b.width + m * 2, height: b.height + m * 2 }
      : null;
    const chain: NodeRecord[] = [];
    for (let a = doc.get(node.parent); a && a.type !== "page"; a = doc.get(a.parent)) {
      chain.push(a);
      const ab = scene.bounds(a.id);
      if (area && ab && a.type === "frame" && a.props.clipContent !== false) area = clip(area, ab);
    }
    out.set(node.id, {
      record: node,
      page: page.id,
      area,
      matrix: JSON.stringify(scene.worldMatrix(node.id)),
      chain,
    });
  }
  return out;
}

function changed(a: Painted | undefined, b: Painted | undefined): boolean {
  if (!a || !b) return a !== b;
  return (
    a.record !== b.record ||
    a.matrix !== b.matrix ||
    a.chain.length !== b.chain.length ||
    a.chain.some((n, i) => n !== b.chain[i])
  );
}

/** Touches every cached value, as drawing every layer would. */
function warm(scene: Scene, doc: Doc): void {
  for (const node of doc.nodes()) {
    scene.worldMatrix(node.id);
    scene.bounds(node.id);
    scene.extent(node.id);
    scene.childrenIn(node.id, { x: -1e5, y: -1e5, width: 2e5, height: 2e5 });
  }
}

function compare(kept: Scene, doc: Doc, queries: readonly Rect[]): void {
  const fresh = new Scene(doc);
  for (const node of doc.nodes()) {
    const id = node.id;
    expect(kept.worldMatrix(id), id).toEqual(fresh.worldMatrix(id));
    expect(kept.bounds(id), id).toEqual(fresh.bounds(id));
    expect(kept.extent(id), id).toEqual(fresh.extent(id));
    expect(kept.hasMask(id), id).toBe(hasMask(doc, id));
    const children = doc.childIds(id);
    for (const q of queries) {
      const got = kept.childrenIn(id, q);
      const touching = children.filter((c) => {
        const e = fresh.extent(c);
        return e !== null && touches(e, q);
      });
      if (children.length >= INDEX_MIN) expect(got, id).toEqual(touching);
      else expect(got).toEqual(children);
    }
  }
  for (const page of doc.pageIds())
    expect([...kept.backdropReaders(page)].sort()).toEqual([...fresh.backdropReaders(page)].sort());
}

describe("Scene, kept across changes", () => {
  it("derives what a fresh scene does, and its dirty places hold every layer that looks different", () => {
    fc.assert(
      fc.property(
        fc.array(action, { minLength: 1, maxLength: 24 }),
        fc.array(
          fc.record({
            x: fc.integer({ min: -3000, max: 3000 }),
            y: fc.integer({ min: -3000, max: 3000 }),
            width: fc.integer({ min: 0, max: 2500 }),
            height: fc.integer({ min: 0, max: 2500 }),
          }),
          { minLength: 1, maxLength: 3 },
        ),
        (actions, queries) => {
          const doc = new Doc();
          seed(doc);
          const kept = new Scene(doc);
          for (let i = 0; i < actions.length; i++) {
            const a = actions[i] as Action;
            warm(kept, doc);
            const before = painted(doc);
            const version = doc.version;
            if (a.kind === "batch") {
              // Several changes in one notification.
              doc.batch(() => {
                for (const b of actions.slice(i + 1, i + 1 + a.count)) {
                  const ops = opsFor(doc, b);
                  if (ops.length > 0) doc.apply(ops);
                }
              });
              i += a.count;
            } else {
              const ops = opsFor(doc, a);
              if (ops.length === 0) continue;
              doc.apply(ops);
            }
            compare(kept, doc, queries);
            const dirty = kept.dirtySince(version);
            expect(dirty).not.toBeNull();
            if (!dirty || dirty.full) continue;
            const after = painted(doc);
            for (const id of new Set([...before.keys(), ...after.keys()])) {
              const was = before.get(id);
              const now = after.get(id);
              if (!changed(was, now)) continue;
              for (const p of [was, now]) {
                if (!p?.area) continue;
                const area = p.area;
                expect(
                  dirty.rects.some(
                    (d) => (d.page === null || d.page === p.page) && contains(d.rect, area),
                  ),
                  `${id} at ${JSON.stringify(area)} after ${JSON.stringify(a)}`,
                ).toBe(true);
              }
            }
          }
        },
      ),
      { numRuns: 80 },
    );
  }, 120_000);

  it("starts afresh after a reset, and when the change log has moved on", () => {
    const doc = new Doc();
    seed(doc);
    const scene = new Scene(doc);
    warm(scene, doc);
    const version = doc.version;
    doc.reset(
      [...doc.nodes()].map((n) => (n.id === "big" ? { ...n, props: { ...n.props, x: 500 } } : n)),
    );
    expect(scene.dirtySince(version)?.full).toBe(true);
    expect(scene.bounds("big")?.x).toBe(500);
    // Far behind: not known any more.
    for (let i = 0; i < 300; i++) doc.apply([{ op: "set", id: "big", prop: "y", value: i }]);
    const behind = scene.dirtySince(version);
    expect(behind === null || behind.full).toBe(true);
    expect(scene.bounds("big")?.y).toBe(299);
  });
});
