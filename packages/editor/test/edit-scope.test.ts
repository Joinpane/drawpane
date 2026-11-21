/**
 * An edit lays out only what it can change (`EditorOptions.relayout`): the
 * frames from each change up to its outermost layout frame, the layers
 * those place, and the frames their layout sizes. Laying out everything
 * under those outermost frames, as before, must give the same document
 * after every edit, on documents made in the editor (laid out as made).
 */
import { getProp, type NodeRecord, type Op, ROOT_ID } from "@drawpane/model";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { Editor } from "../src/editor";

const measurer = { width: (_font: string, text: string) => text.length * 7 };

function makeEditor(relayout: "changes" | "subtree"): Editor {
  const editor = new Editor({ measurer, clientId: "scope", relayout });
  editor.state.set({ role: "editor" });
  editor.doc.apply([
    { op: "create", id: "p", type: "page", parent: ROOT_ID, key: "a0", props: { name: "Page" } },
  ]);
  editor.setPage("p");
  return editor;
}

/** Every layer's values, for comparing two documents. */
function snapshot(editor: Editor): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const walk = (id: string) => {
    for (const child of editor.doc.childIds(id)) {
      const node = editor.doc.get(child) as NodeRecord;
      out[child] = { parent: node.parent, key: node.key, props: node.props };
      walk(child);
    }
  };
  walk("p");
  return out;
}

type Sizing = "fixed" | "hug" | "fill";

interface FrameSpec {
  kind: "frame";
  layoutMode: "none" | "row" | "column" | "grid";
  sizingH: Sizing;
  sizingV: Sizing;
  wrap: boolean;
  align: "start" | "center" | "end" | "stretch";
  padding: number;
  gap: number;
  w: number;
  h: number;
  children: Spec[];
}
interface LeafSpec {
  kind: "rect" | "text";
  sizingH: Sizing;
  sizingV: Sizing;
  w: number;
  h: number;
}
type Spec = FrameSpec | LeafSpec;

const sizing = fc.constantFrom<Sizing>("fixed", "hug", "fill");
const leaf: fc.Arbitrary<LeafSpec> = fc.record({
  kind: fc.constantFrom<"rect" | "text">("rect", "rect", "text"),
  sizingH: fc.constantFrom<Sizing>("fixed", "fill"),
  sizingV: fc.constantFrom<Sizing>("fixed", "fill"),
  w: fc.integer({ min: 4, max: 60 }),
  h: fc.integer({ min: 4, max: 40 }),
});
const tree = fc.letrec<{ node: Spec; frame: FrameSpec }>((tie) => ({
  node: fc.oneof({ depthSize: "small", withCrossShrink: true }, leaf, tie("frame")),
  frame: fc.record({
    kind: fc.constant<"frame">("frame"),
    layoutMode: fc.constantFrom<FrameSpec["layoutMode"]>("row", "column", "row", "grid", "none"),
    sizingH: sizing,
    sizingV: sizing,
    wrap: fc.boolean(),
    align: fc.constantFrom<FrameSpec["align"]>("start", "center", "end", "stretch"),
    padding: fc.integer({ min: 0, max: 12 }),
    gap: fc.integer({ min: 0, max: 10 }),
    w: fc.integer({ min: 20, max: 300 }),
    h: fc.integer({ min: 20, max: 200 }),
    children: fc.array(tie("node"), { maxLength: 4 }),
  }),
})).frame;

/** Creates the tree as a person would, one layer at a time through the editor. */
function build(editor: Editor, spec: FrameSpec): string[] {
  const ids: string[] = [];
  let n = 0;
  const make = (s: Spec, parent: string) => {
    const id = `n${n++}`;
    ids.push(id);
    const props: Record<string, unknown> = {
      x: 5,
      y: 5,
      width: s.w,
      height: s.h,
      sizingH: s.sizingH,
      sizingV: s.sizingV,
    };
    if (s.kind === "frame") {
      Object.assign(props, {
        layoutMode: s.layoutMode,
        layoutWrap: s.wrap,
        alignItems: s.align,
        paddingLeft: s.padding,
        paddingTop: s.padding,
        paddingRight: s.padding,
        paddingBottom: s.padding,
        gap: s.gap,
      });
    }
    if (s.kind === "text") Object.assign(props, { characters: "Some words here", fontSize: 12 });
    editor.commit([
      { op: "create", id, type: s.kind, parent, key: `a${String(n).padStart(3, "0")}`, props },
    ]);
    if (s.kind === "frame") for (const child of s.children) make(child, id);
  };
  make(spec, "p");
  return ids;
}

type Edit =
  | { kind: "size"; at: number; prop: "width" | "height"; value: number }
  | { kind: "sizing"; at: number; prop: "sizingH" | "sizingV"; value: Sizing }
  | { kind: "padding"; at: number; value: number }
  | { kind: "gap"; at: number; value: number }
  | { kind: "visible"; at: number }
  | { kind: "absolute"; at: number }
  | { kind: "text"; at: number; words: number }
  | { kind: "nudge"; at: number; dx: number }
  | { kind: "move"; at: number; into: number }
  | { kind: "delete"; at: number }
  | { kind: "undo" };

const edit: fc.Arbitrary<Edit> = fc.oneof(
  fc.record({
    kind: fc.constant("size" as const),
    at: fc.nat(40),
    prop: fc.constantFrom<"width" | "height">("width", "height"),
    value: fc.integer({ min: 4, max: 400 }),
  }),
  fc.record({
    kind: fc.constant("sizing" as const),
    at: fc.nat(40),
    prop: fc.constantFrom<"sizingH" | "sizingV">("sizingH", "sizingV"),
    value: sizing,
  }),
  fc.record({ kind: fc.constant("padding" as const), at: fc.nat(40), value: fc.nat(20) }),
  fc.record({ kind: fc.constant("gap" as const), at: fc.nat(40), value: fc.nat(20) }),
  fc.record({ kind: fc.constant("visible" as const), at: fc.nat(40) }),
  fc.record({ kind: fc.constant("absolute" as const), at: fc.nat(40) }),
  fc.record({
    kind: fc.constant("text" as const),
    at: fc.nat(40),
    words: fc.integer({ min: 0, max: 9 }),
  }),
  fc.record({
    kind: fc.constant("nudge" as const),
    at: fc.nat(40),
    dx: fc.integer({ min: -9, max: 9 }),
  }),
  fc.record({ kind: fc.constant("move" as const), at: fc.nat(40), into: fc.nat(40) }),
  fc.record({ kind: fc.constant("delete" as const), at: fc.nat(40) }),
  fc.constant({ kind: "undo" as const }),
);

/** The operations an edit makes on `editor`'s document (the same on both, which match). */
function opsFor(editor: Editor, ids: readonly string[], e: Edit): Op[] | "undo" | null {
  if (e.kind === "undo") return "undo";
  const live = ids.filter((id) => editor.doc.has(id));
  const id = live[e.at % Math.max(1, live.length)];
  if (!id) return null;
  const node = editor.doc.get(id) as NodeRecord;
  switch (e.kind) {
    case "size":
      return [{ op: "set", id, prop: e.prop, value: e.value }];
    case "sizing":
      return [{ op: "set", id, prop: e.prop, value: e.value }];
    case "padding":
      if (node.type !== "frame") return null;
      return [
        { op: "set", id, prop: "paddingLeft", value: e.value },
        { op: "set", id, prop: "paddingTop", value: e.value },
      ];
    case "gap":
      if (node.type !== "frame") return null;
      return [{ op: "set", id, prop: "gap", value: e.value }];
    case "visible":
      return [{ op: "set", id, prop: "visible", value: !getProp(node.props, "visible") }];
    case "absolute": {
      const now = getProp(node.props, "positioning");
      return [{ op: "set", id, prop: "positioning", value: now === "auto" ? "absolute" : "auto" }];
    }
    case "text":
      if (node.type !== "text") return null;
      return [
        {
          op: "set",
          id,
          prop: "characters",
          value: Array.from({ length: e.words + 1 }, (_, i) => `w${i}`).join(" "),
        },
      ];
    case "nudge":
      return [{ op: "set", id, prop: "x", value: getProp(node.props, "x") + e.dx }];
    case "move": {
      const frames = live.filter((f) => editor.doc.get(f)?.type === "frame" && f !== id);
      const into = frames[e.into % Math.max(1, frames.length)];
      if (!into || editor.doc.ancestors(into).some((a) => a.id === id)) return null;
      return [{ op: "move", id, parent: into, key: `z${e.into}` }];
    }
    case "delete":
      if (id === ids[0]) return null;
      return [{ op: "delete", id }];
  }
}

describe("what an edit lays out", () => {
  it("lays out the same as laying out everything under the outermost layout frames", () => {
    fc.assert(
      fc.property(tree, fc.array(edit, { minLength: 1, maxLength: 12 }), (spec, edits) => {
        const changes = makeEditor("changes");
        const subtree = makeEditor("subtree");
        const ids = build(changes, spec);
        build(subtree, spec);
        expect(snapshot(changes)).toEqual(snapshot(subtree));
        for (const [step, e] of edits.entries()) {
          const ops = opsFor(changes, ids, e);
          if (ops === null) continue;
          if (ops === "undo") {
            changes.undo();
            subtree.undo();
          } else {
            const a = changes.commit(ops);
            const b = subtree.commit(ops);
            expect(a, `step ${step} committed alike`).toBe(b);
          }
          expect(snapshot(changes), `after step ${step}: ${JSON.stringify(e)}`).toEqual(
            snapshot(subtree),
          );
        }
      }),
      { numRuns: Number(process.env.FUZZ_RUNS) || 60 },
    );
  }, 120_000);

  it("doesn't lay out what's inside a layer that only moved", () => {
    const editor = makeEditor("changes");
    editor.commit([
      {
        op: "create",
        id: "card",
        type: "frame",
        parent: "p",
        key: "a0",
        props: { layoutMode: "row", width: 100, height: 40, sizingH: "fixed", sizingV: "fixed" },
      },
      {
        op: "create",
        id: "dot",
        type: "rect",
        parent: "card",
        key: "a0",
        props: { width: 10, height: 10 },
      },
    ]);
    // Out of step with its layout on purpose (as an imported file can be): a move keeps it.
    editor.doc.apply([{ op: "set", id: "dot", prop: "x", value: 33 }]);
    editor.commit([{ op: "set", id: "card", prop: "x", value: 50 }]);
    expect(getProp(editor.doc.get("dot")?.props ?? {}, "x")).toBe(33);
    // A change inside it lays it out.
    editor.commit([{ op: "set", id: "card", prop: "gap", value: 4 }]);
    expect(getProp(editor.doc.get("dot")?.props ?? {}, "x")).toBe(0);
  });
});

describe("frames a move empties through a bound visibility", () => {
  it("shrinks a hugging frame whose only layer a move into another mode hides", () => {
    const editor = new Editor({ measurer, clientId: "modes" });
    editor.doc.resetStored([
      { id: "p", type: "page", parent: ROOT_ID, key: "a0", props: {} },
      {
        id: "c",
        type: "collection",
        parent: ROOT_ID,
        key: "a1",
        props: {
          modes: [
            { id: "light", name: "Light" },
            { id: "dark", name: "Dark" },
          ],
        },
      },
      {
        id: "shown",
        type: "variable",
        parent: "c",
        key: "a0",
        props: { variableType: "boolean", values: { light: true, dark: false } },
      },
      {
        id: "zone",
        type: "frame",
        parent: "p",
        key: "a0",
        props: { width: 400, height: 400, variableModes: { c: "dark" } },
      },
      {
        id: "card",
        type: "frame",
        parent: "p",
        key: "a1",
        props: {
          x: 500,
          layoutMode: "row",
          sizingH: "hug",
          sizingV: "hug",
          paddingLeft: 5,
          paddingRight: 5,
          paddingTop: 5,
          paddingBottom: 5,
          width: 30,
          height: 30,
        },
      },
      {
        id: "dot",
        type: "rect",
        parent: "card",
        key: "a0",
        props: { x: 5, y: 5, width: 20, height: 20, bindings: { visible: "shown" } },
      },
    ]);
    editor.state.set({ role: "editor" });
    editor.setPage("p");
    expect(getProp(editor.doc.get("dot")?.props ?? {}, "visible")).toBe(true);
    editor.commit([{ op: "move", id: "card", parent: "zone", key: "a0" }]);
    expect(getProp(editor.doc.get("dot")?.props ?? {}, "visible")).toBe(false);
    const card = editor.doc.get("card")?.props ?? {};
    expect([getProp(card, "width"), getProp(card, "height")]).toEqual([10, 10]);
  });
});
