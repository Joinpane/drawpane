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
import {
  aimDrop,
  dropPlacement,
  type ListedRows,
  layerRows,
  patchRows,
  type Row,
  rowPositions,
} from "./layer-tree";

/** More runs when fuzzing (FUZZ_RUNS); the seed is set for every property test in vitest.setup.ts. */
const runs = (normally: number) => ({ numRuns: Number(process.env.FUZZ_RUNS) || normally });

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
      runs(400),
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
      runs(300),
    );
  }, 60_000);
});

/**
 * Edits patch the rows instead of walking the page (`patchRows`): after any
 * edits, patched rows must be the rows a fresh walk gives, whenever the
 * patch says it can tell. Edits move, rename, recolour, hide and show
 * layers, make them masks, clip frames, and add or delete layers.
 */
describe("patched rows", () => {
  type Edit =
    | {
        kind: "set";
        at: number;
        prop: "x" | "name" | "visible" | "isMask" | "clipContent" | "fills";
        value: number;
      }
    | { kind: "delete"; at: number }
    | { kind: "add"; at: number };
  const edit: fc.Arbitrary<Edit> = fc.oneof(
    fc.record({
      kind: fc.constant("set" as const),
      at: fc.nat(),
      prop: fc.constantFrom(
        "x",
        "name",
        "visible",
        "isMask",
        "clipContent",
        "fills",
      ) as fc.Arbitrary<"x" | "name" | "visible" | "isMask" | "clipContent" | "fills">,
      value: fc.nat(3),
    }),
    fc.record({ kind: fc.constant("delete" as const), at: fc.nat() }),
    fc.record({ kind: fc.constant("add" as const), at: fc.nat() }),
  );
  const shown = (rows: readonly Row[]) => rows.map((r) => ({ ...r, node: r.node, id: r.node.id }));

  it("are what a walk gives, whenever they can be patched", () => {
    fc.assert(
      fc.property(
        page,
        fc.array(fc.array(edit, { minLength: 1, maxLength: 3 }), { minLength: 1, maxLength: 6 }),
        fc.boolean(),
        (specs, rounds, fold) => {
          const doc = build(specs);
          const all = () => {
            const out: string[] = [];
            const visit = (id: string) => {
              for (const c of doc.childIds(id)) {
                out.push(c);
                visit(c);
              }
            };
            visit("p");
            return out;
          };
          // Sometimes with a container folded shut, so some layers have no row.
          const firstContainer = all().find((id) => doc.childIds(id).length > 0);
          const collapsed = new Set(fold && firstContainer ? [firstContainer] : []);
          let rows: readonly Row[] = layerRows(doc, "p", { collapsed }).rows;
          let listed: ListedRows = { rows, version: doc.version, at: rowPositions(rows) };
          let n = 0;
          for (const round of rounds) {
            const ops: Op[] = [];
            for (const e of round) {
              const ids = all();
              if (ids.length === 0) break;
              const id = ids[e.at % ids.length] as string;
              const node = doc.get(id);
              if (!node) continue;
              if (e.kind === "delete") ops.push({ op: "delete", id });
              else if (e.kind === "add")
                ops.push({
                  op: "create",
                  id: `new${n++}`,
                  type: "rect",
                  parent: node.type === "rect" ? node.parent : id,
                  key: keyBetween(
                    null,
                    doc.get(doc.childIds(node.type === "rect" ? node.parent : id)[0] ?? "")?.key ??
                      null,
                  ),
                  props: { name: "new" },
                } as Op);
              else {
                const value =
                  e.prop === "x"
                    ? e.value * 10
                    : e.prop === "name"
                      ? `n${e.value}`
                      : e.prop === "fills"
                        ? [
                            {
                              type: "solid",
                              color: ["#ff0000", "#00ff00", "#0000ff", "#000000"][e.value],
                            },
                          ]
                        : e.prop === "isMask" && node.type === "group"
                          ? null
                          : e.value % 2 === 0;
                if (value === null) continue;
                if (e.prop === "clipContent" && node.type !== "frame") continue;
                ops.push({ op: "set", id, prop: e.prop, value } as Op);
              }
              // One op at a time keeps each valid against the document as it is.
              try {
                doc.apply(ops.splice(0));
              } catch {
                // An edit that doesn't apply here (e.g. deleting what's gone) is skipped.
              }
            }
            const walked = layerRows(doc, "p", { collapsed }).rows;
            const patched = patchRows(doc, listed);
            if (patched) expect(shown(patched)).toEqual(shown(walked));
            rows = patched ?? walked;
            listed = patched
              ? { ...listed, rows: patched, version: doc.version }
              : { rows, version: doc.version, at: rowPositions(rows) };
          }
        },
      ),
      runs(200),
    );
  });

  it("patch a moved or recoloured layer without walking", () => {
    const doc = build([{ kind: "frame", children: [{ kind: "rect", children: [] }] }]);
    const rows = layerRows(doc, "p", { collapsed: new Set() }).rows;
    const listed = { rows, version: doc.version, at: rowPositions(rows) };
    doc.apply([{ op: "set", id: "rect1", prop: "x", value: 40 }]);
    const patched = patchRows(doc, listed);
    expect(patched?.find((r) => r.node.id === "rect1")?.node).toBe(doc.get("rect1"));
    doc.apply([{ op: "set", id: "rect1", prop: "visible", value: false }]);
    expect(
      patchRows(doc, { ...listed, rows: patched ?? rows, version: doc.version - 1 }),
    ).toBeNull();
  });
});
