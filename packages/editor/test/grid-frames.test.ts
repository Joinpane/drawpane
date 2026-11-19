/**
 * The overlay's list of frames with layout grids showing is kept across
 * edits that can't change it (`framesWithGrids`): after any edits it must be
 * the list a fresh walk of the page gives.
 */
import { keyBetween, type Op, ROOT_ID } from "@drawpane/model";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { Doc } from "../src/doc";
import { framesWithGrids, visibleGrids } from "../src/grids";

const runs = (normally: number) => ({ numRuns: Number(process.env.FUZZ_RUNS) || normally });
const grid = {
  type: "columns",
  count: 4,
  gutter: 20,
  margin: 10,
  alignment: "stretch",
  size: 50,
  color: "#ff00001a",
};

/** What a walk of the page finds, from scratch. */
function walked(doc: Doc, pageId: string): string[] {
  const ids: string[] = [];
  const walk = (id: string) => {
    for (const child of doc.childIds(id)) {
      const node = doc.get(child);
      if (!node || node.props.visible === false) continue;
      if (node.type === "frame" && visibleGrids(node).length > 0) ids.push(child);
      if (node.type === "frame" || node.type === "group") walk(child);
    }
  };
  walk(pageId);
  return ids;
}

function build(): Doc {
  const doc = new Doc();
  const ops: Op[] = [
    { op: "create", id: "p", type: "page", parent: ROOT_ID, key: "a0", props: {} },
  ];
  let key: string | null = null;
  const add = (id: string, type: string, parent: string, props: object = {}) => {
    key = keyBetween(key, null);
    ops.push({ op: "create", id, type, parent, key, props } as Op);
  };
  add("f1", "frame", "p", { width: 100, height: 100, layoutGrids: [grid] });
  add("f2", "frame", "p", { width: 100, height: 100 });
  add("g1", "group", "f2");
  add("f3", "frame", "g1", { width: 50, height: 50, layoutGrids: [grid] });
  add("r1", "rect", "f3", { width: 10, height: 10 });
  add("f4", "frame", "f1", { width: 50, height: 50, layoutGrids: [grid] });
  add("r2", "rect", "f1", { width: 10, height: 10 });
  doc.apply(ops);
  return doc;
}

describe("framesWithGrids", () => {
  it("keeps its list when a layer only moves or changes colour", () => {
    const doc = build();
    const first = framesWithGrids(doc, "p");
    expect(first).toEqual(["f1", "f4", "f3"]);
    doc.apply([{ op: "set", id: "r1", prop: "x", value: 5 }]);
    doc.apply([{ op: "set", id: "f3", prop: "x", value: 5 }]);
    expect(framesWithGrids(doc, "p")).toBe(first);
    doc.apply([{ op: "set", id: "g1", prop: "visible", value: false }]);
    expect(framesWithGrids(doc, "p")).toEqual(["f1", "f4"]);
  });

  it("is what a fresh walk gives after any edits", () => {
    const ids = ["f1", "f2", "g1", "f3", "r1", "f4", "r2"];
    const edit = fc.record({
      at: fc.nat(ids.length - 1),
      kind: fc.constantFrom("visible", "grid", "x", "delete", "add"),
      value: fc.boolean(),
    });
    fc.assert(
      fc.property(fc.array(edit, { minLength: 1, maxLength: 12 }), (edits) => {
        const doc = build();
        framesWithGrids(doc, "p");
        let n = 0;
        for (const e of edits) {
          const id = ids[e.at] as string;
          const node = doc.get(id);
          if (!node) continue;
          try {
            if (e.kind === "visible")
              doc.apply([{ op: "set", id, prop: "visible", value: e.value }]);
            else if (e.kind === "grid" && node.type === "frame")
              doc.apply([{ op: "set", id, prop: "layoutGrids", value: e.value ? [grid] : [] }]);
            else if (e.kind === "x") doc.apply([{ op: "set", id, prop: "x", value: n++ }]);
            else if (e.kind === "delete") doc.apply([{ op: "delete", id }]);
            else if (e.kind === "add" && node.type !== "rect")
              doc.apply([
                {
                  op: "create",
                  id: `new${n++}`,
                  type: "frame",
                  parent: id,
                  key: keyBetween(null, doc.get(doc.childIds(id)[0] ?? "")?.key ?? null),
                  props: { width: 20, height: 20, ...(e.value ? { layoutGrids: [grid] } : {}) },
                } as Op,
              ]);
          } catch {
            // Not valid here (a delete of what's gone): skipped.
          }
          expect([...framesWithGrids(doc, "p")]).toEqual(walked(doc, "p"));
        }
      }),
      runs(300),
    );
  });
});
