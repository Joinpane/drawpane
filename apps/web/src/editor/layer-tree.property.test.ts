/**
 * The layers panel's drag and drop, checked against every place a layer
 * could go, on random layer trees. Hand-written tests check the cases
 * someone thought of; these check that the panel can say every move there
 * is (no place a layer can't be dragged to), and that it never shows a drop
 * that won't happen.
 */
import { Doc } from "@drawpane/editor";
import { keyBetween, type Op, ROOT_ID } from "@drawpane/model";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { aimDrop, dropPlacement, layerRows, type Row } from "./layer-tree";

/**
 * How hard to look: a fixed seed by default, so a push never fails on a bug
 * found by chance in someone else's change; `pnpm fuzz` (nightly in CI)
 * sets FUZZ_SEED=random and far more runs. A failure prints its seed to replay.
 */
function fuzzing(runs: number): { numRuns: number; seed?: number } {
  const seed = process.env.FUZZ_SEED;
  const numRuns = Number(process.env.FUZZ_RUNS ?? runs);
  if (seed === "random") return { numRuns };
  return { numRuns, seed: seed ? Number(seed) : 20261114 };
}

type Kind = "frame" | "group" | "rect";
interface Spec {
  readonly kind: Kind;
  readonly children: readonly Spec[];
}

/** Trees up to four levels deep: frames (maybe empty), groups (never empty) and shapes. */
const spec: fc.Arbitrary<Spec> = fc.letrec<{ node: Spec }>((tie) => ({
  node: fc.oneof(
    { depthSize: "small", withCrossShrink: true },
    fc.record({ kind: fc.constant<Kind>("rect"), children: fc.constant([]) }),
    fc.record({
      kind: fc.constant<Kind>("frame"),
      children: fc.array(tie("node"), { maxLength: 3 }),
    }),
    fc.record({
      kind: fc.constant<Kind>("group"),
      children: fc.array(tie("node"), { minLength: 1, maxLength: 3 }),
    }),
  ),
})).node;
const page = fc.array(spec, { minLength: 1, maxLength: 4 });

function build(specs: readonly Spec[]): Doc {
  const doc = new Doc();
  const ops: Op[] = [
    { op: "create", id: "p", type: "page", parent: ROOT_ID, key: "a0", props: {} },
  ];
  let n = 0;
  const add = (list: readonly Spec[], parent: string) => {
    let key: string | null = null;
    for (const s of list) {
      const id = `${s.kind}${n++}`;
      key = keyBetween(key, null);
      ops.push({ op: "create", id, type: s.kind, parent, key, props: { name: id } } as Op);
      add(s.children, id);
    }
  };
  add(specs, "p");
  doc.apply(ops);
  return doc;
}

const isContainer = (doc: Doc, id: string) => {
  const type = doc.get(id)?.type;
  return type === "page" || type === "frame" || type === "group";
};
const within = (doc: Doc, id: string, ancestor: string) =>
  id === ancestor || doc.ancestors(id).some((a) => a.id === ancestor);
const spot = (p: { parent: string; below: string | null; above: string | null }) =>
  `${p.parent}: ${p.below ?? "bottom"} < · < ${p.above ?? "top"}`;

/** Every place `moving` could go: each gap among each container's children (not inside itself). */
function everyPlace(doc: Doc, moving: string): Set<string> {
  const out = new Set<string>();
  const visit = (id: string) => {
    if (within(doc, id, moving)) return;
    if (isContainer(doc, id)) {
      const kids = doc.childIds(id).filter((k) => k !== moving);
      for (let i = 0; i <= kids.length; i++)
        out.add(spot({ parent: id, below: kids[i - 1] ?? null, above: kids[i] ?? null }));
    }
    for (const child of doc.childIds(id)) visit(child);
  };
  visit("p");
  return out;
}

/** Every pointer position over the rows: each row's top, middle and bottom, at each level. */
function* pointers(rows: readonly Row[]) {
  const deepest = Math.max(...rows.map((r) => r.depth));
  for (let index = 0; index < rows.length; index++)
    for (const y of [0.1, 0.5, 0.9])
      for (let depth = -1; depth <= deepest + 1; depth++) yield { index, y, depth };
}

describe("dragging in the layers panel", () => {
  it("can take any layer to any place in the tree", () => {
    fc.assert(
      fc.property(page, fc.nat(), (specs, pick) => {
        const doc = build(specs);
        const { rows } = layerRows(doc, "p", { collapsed: new Set() });
        const moving = (rows[pick % rows.length] as Row).node.id;
        const parentOf = (id: string) => {
          const parent = doc.get(id)?.parent;
          return parent && parent !== "p" ? parent : null;
        };
        const reached = new Set<string>();
        // Not moving at all is always on offer: let go where it started.
        const node = doc.get(moving);
        const kids = doc.childIds(node?.parent ?? "p");
        const at = kids.indexOf(moving);
        reached.add(
          spot({
            parent: node?.parent ?? "p",
            below: kids[at - 1] ?? null,
            above: kids[at + 1] ?? null,
          }),
        );
        for (const { index, y, depth } of pointers(rows)) {
          const target = aimDrop({ doc, rows, index, y, depth, moving: [moving], parentOf });
          if (!target) continue;
          const place = dropPlacement(doc, target, [moving]);
          // A drop line that shows always leads somewhere.
          expect(place).not.toBeNull();
          if (place) reached.add(spot(place));
        }
        const missing = [...everyPlace(doc, moving)].filter((p) => !reached.has(p));
        expect(missing, `can't drag ${moving} to`).toEqual([]);
      }),
      fuzzing(400),
    );
  }, 60_000);

  it("never drops a layer inside itself or relative to one being moved", () => {
    fc.assert(
      fc.property(page, fc.array(fc.nat(), { minLength: 1, maxLength: 3 }), (specs, picks) => {
        const doc = build(specs);
        const { rows } = layerRows(doc, "p", { collapsed: new Set() });
        const moving = [...new Set(picks.map((i) => (rows[i % rows.length] as Row).node.id))];
        const parentOf = (id: string) => {
          const parent = doc.get(id)?.parent;
          return parent && parent !== "p" ? parent : null;
        };
        for (const { index, y, depth } of pointers(rows)) {
          const target = aimDrop({ doc, rows, index, y, depth, moving, parentOf });
          if (!target) continue;
          const place = dropPlacement(doc, target, moving);
          expect(place).not.toBeNull();
          if (!place) continue;
          for (const id of moving) expect(within(doc, place.parent, id)).toBe(false);
          expect(moving).not.toContain(place.below);
          expect(moving).not.toContain(place.above);
        }
      }),
      fuzzing(300),
    );
  }, 60_000);
});
