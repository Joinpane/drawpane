/**
 * The editor driven the way people drive it, at random: long runs of real
 * commands (draw, set properties, group, frame, delete, duplicate, move
 * between frames, auto layout, components, copy and paste, undo, redo),
 * with what must always hold checked after every one. Hand-written tests
 * cover the cases someone thought of; this looks for the ones nobody did.
 *
 * After every command:
 * - the tree is sound: every layer's parent exists, no cycles, layers live
 *   in pages, frames or groups;
 * - the selection only names layers that exist;
 * - auto layout has settled: laying out again changes nothing;
 * - Explain's sums add up to the sizes on the canvas;
 * - grouping, ungrouping, framing and moving between frames leave every
 *   layer where it was on the canvas (unless auto layout now places it);
 * At the end, undoing everything gets back the start, and redoing as many
 * steps gets back the end.
 */
import { type NodeRecord, type PropName, ROOT_ID } from "@drawpane/model";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { canMoveInto } from "../src/components";
import { Editor } from "../src/editor";
import { explainSize } from "../src/explain";
import { layoutOps } from "../src/layout";
import { sizePill } from "../src/size-pill";

type Action =
  | {
      kind: "create";
      type: "rect" | "frame" | "text";
      parent: number;
      x: number;
      y: number;
      w: number;
      h: number;
    }
  | { kind: "set"; node: number; prop: PropName; value: unknown }
  | { kind: "select"; nodes: number[] }
  | { kind: "group" | "ungroup" | "frame" | "frameAuto" | "delete" | "duplicate" | "component" }
  | { kind: "layout"; mode: "none" | "row" | "column" | "grid" }
  | { kind: "move"; node: number; into: number; top: boolean }
  | { kind: "nudge"; dx: number; dy: number }
  | { kind: "copyPaste" }
  | { kind: "gesture"; node: number; props: [PropName, unknown][]; cancel: boolean }
  | { kind: "undo" | "redo" };

const size = fc.integer({ min: 1, max: 320 });
const PROPS: fc.Arbitrary<[PropName, unknown]> = fc.oneof(
  fc.tuple(fc.constant<PropName>("layoutMode"), fc.constantFrom("none", "row", "column", "grid")),
  fc.tuple(fc.constant<PropName>("gap"), fc.integer({ min: 0, max: 24 })),
  fc.tuple(fc.constant<PropName>("rowGap"), fc.integer({ min: 0, max: 24 })),
  fc.tuple(
    fc.constantFrom<PropName>("paddingTop", "paddingRight", "paddingBottom", "paddingLeft"),
    fc.integer({ min: 0, max: 32 }),
  ),
  fc.tuple(
    fc.constantFrom<PropName>("sizingH", "sizingV"),
    fc.constantFrom("fixed", "hug", "fill"),
  ),
  fc.tuple(fc.constantFrom<PropName>("width", "height"), size),
  fc.tuple(fc.constantFrom<PropName>("minWidth", "maxHeight"), fc.option(size, { nil: null })),
  fc.tuple(fc.constant<PropName>("visible"), fc.constantFrom(false, null)),
  fc.tuple(fc.constant<PropName>("positioning"), fc.constantFrom("auto", "absolute")),
  fc.tuple(
    fc.constant<PropName>("alignItems"),
    fc.constantFrom("start", "center", "end", "stretch"),
  ),
  fc.tuple(fc.constant<PropName>("alignSelf"), fc.constantFrom("auto", "start", "stretch")),
  fc.tuple(fc.constant<PropName>("layoutWrap"), fc.boolean()),
  fc.tuple(fc.constant<PropName>("rotation"), fc.constantFrom(0, 15, 90)),
  fc.tuple(fc.constant<PropName>("characters"), fc.constantFrom("Hi", "A longer line of text", "")),
);
const pick = fc.nat();
const action: fc.Arbitrary<Action> = fc.oneof(
  {
    arbitrary: fc.record({
      kind: fc.constant("create" as const),
      type: fc.constantFrom("rect" as const, "frame" as const, "text" as const),
      parent: pick,
      x: fc.integer({ min: -50, max: 400 }),
      y: fc.integer({ min: -50, max: 400 }),
      w: size,
      h: size,
    }),
    weight: 5,
  },
  {
    arbitrary: fc
      .record({ kind: fc.constant("set" as const), node: pick })
      .chain((a) => PROPS.map(([prop, value]) => ({ ...a, prop, value }))),
    weight: 8,
  },
  {
    arbitrary: fc.record({
      kind: fc.constant("select" as const),
      nodes: fc.array(pick, { minLength: 1, maxLength: 3 }),
    }),
    weight: 4,
  },
  {
    arbitrary: fc.record({
      kind: fc.constantFrom(
        "group" as const,
        "ungroup" as const,
        "frame" as const,
        "frameAuto" as const,
        "delete" as const,
        "duplicate" as const,
        "component" as const,
      ),
    }),
    weight: 4,
  },
  {
    arbitrary: fc.record({
      kind: fc.constant("layout" as const),
      mode: fc.constantFrom("none" as const, "row" as const, "column" as const, "grid" as const),
    }),
    weight: 2,
  },
  {
    arbitrary: fc.record({
      kind: fc.constant("move" as const),
      node: pick,
      into: pick,
      top: fc.boolean(),
    }),
    weight: 3,
  },
  {
    arbitrary: fc.record({
      kind: fc.constant("nudge" as const),
      dx: fc.integer({ min: -10, max: 10 }),
      dy: fc.integer({ min: -10, max: 10 }),
    }),
    weight: 1,
  },
  { arbitrary: fc.record({ kind: fc.constant("copyPaste" as const) }), weight: 1 },
  {
    arbitrary: fc.record({
      kind: fc.constant("gesture" as const),
      node: pick,
      props: fc.array(PROPS, { minLength: 1, maxLength: 3 }),
      cancel: fc.boolean(),
    }),
    weight: 2,
  },
  { arbitrary: fc.record({ kind: fc.constantFrom("undo" as const, "redo" as const) }), weight: 3 },
);

/** More runs when fuzzing (FUZZ_RUNS); the seed is set for every property test in vitest.setup.ts. */
const runs = (normally: number) => ({ numRuns: Number(process.env.FUZZ_RUNS) || normally });

function setup() {
  const editor = new Editor({ measurer: { width: (_f, t) => t.length * 7 }, clientId: "monkey" });
  editor.state.set({ role: "editor" });
  editor.doc.apply([
    { op: "create", id: "p", type: "page", parent: ROOT_ID, key: "a0", props: {} },
  ]);
  editor.setPage("p");
  return editor;
}

/** The layers on the page, in tree order. */
function layers(editor: Editor): NodeRecord[] {
  const out: NodeRecord[] = [];
  const walk = (id: string) => {
    for (const child of editor.doc.childIds(id)) {
      const node = editor.doc.get(child);
      if (!node) continue;
      out.push(node);
      walk(child);
    }
  };
  walk("p");
  return out;
}
const at = <T>(list: readonly T[], i: number): T | undefined => list[i % Math.max(1, list.length)];

function run(editor: Editor, a: Action): void {
  const all = layers(editor);
  const containers = [
    "p",
    ...all.filter((n) => n.type === "frame" || n.type === "group").map((n) => n.id),
  ];
  switch (a.kind) {
    case "create": {
      const parent = at(containers, a.parent) as string;
      const id = editor.createLayer(
        a.type,
        { x: a.x, y: a.y, width: a.w, height: a.h },
        parent,
        a.type === "text" ? { characters: "Label" } : {},
      );
      if (id) editor.select([id]);
      return;
    }
    case "set": {
      const node = at(all, a.node);
      if (node) editor.setProp([node.id], a.prop, a.value);
      return;
    }
    case "select":
      editor.select([
        ...new Set(a.nodes.map((i) => at(all, i)?.id).filter((id): id is string => !!id)),
      ]);
      return;
    case "group":
      editor.group();
      return;
    case "ungroup":
      editor.ungroup();
      return;
    case "frame":
      editor.frameSelection(false);
      return;
    case "frameAuto":
      editor.frameSelection(true);
      return;
    case "delete":
      editor.deleteSelection();
      return;
    case "duplicate":
      editor.duplicate();
      return;
    case "component":
      editor.createComponent();
      return;
    case "layout":
      editor.setLayoutMode(
        editor.s.selection.filter((id) => editor.doc.get(id)?.type === "frame"),
        a.mode,
      );
      return;
    case "move": {
      // The layers panel's move: into another container, at its top or bottom.
      const node = at(all, a.node);
      const into = at(containers, a.into) as string;
      if (!node || into === node.id || editor.doc.ancestors(into).some((x) => x.id === node.id))
        return;
      // Only the moves the app allows: not into an instance, never a component into itself.
      if (!canMoveInto(editor.doc, [node.id], into)) return;
      const kids = editor.doc.childIds(into).filter((id) => id !== node.id);
      const keyOf = (id: string | undefined) => (id ? (editor.doc.get(id)?.key ?? null) : null);
      const key = a.top ? keyAbove(keyOf(kids.at(-1))) : keyBelow(keyOf(kids[0]));
      editor.commit(editor.reparentOps(node.id, into, key), "Move");
      return;
    }
    case "nudge":
      editor.nudge(a.dx, a.dy);
      return;
    case "copyPaste": {
      const text = editor.copy();
      if (text) editor.paste(text);
      return;
    }
    case "gesture": {
      const node = at(all, a.node);
      if (!node) return;
      editor.beginGesture("Monkey");
      for (const [prop, value] of a.props) editor.setProp([node.id], prop, value);
      if (a.cancel) editor.cancelGesture();
      else editor.endGesture();
      return;
    }
    case "undo":
      editor.undo();
      return;
    case "redo":
      editor.redo();
      return;
  }
}

import { keyBetween } from "@drawpane/model";

const keyAbove = (k: string | null) => keyBetween(k, null);
const keyBelow = (k: string | null) => keyBetween(null, k);

const snapshot = (editor: Editor) =>
  [...editor.doc.nodes()]
    .map((n) => ({ id: n.id, type: n.type, parent: n.parent, key: n.key, props: n.props }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));

const near = (a: number, b: number) => Math.abs(a - b) < 0.01;

function check(editor: Editor, history: string): void {
  const doc = editor.doc;
  for (const node of doc.nodes()) {
    if (node.id === ROOT_ID) continue;
    if (node.type === "page") {
      expect(node.parent).toBe(ROOT_ID);
      continue;
    }
    const parent = doc.get(node.parent);
    expect(parent, `${node.id}'s parent ${node.parent} is gone · ${history}`).toBeDefined();
    if (
      [
        "rect",
        "frame",
        "text",
        "group",
        "ellipse",
        "line",
        "path",
        "polygon",
        "star",
        "image",
      ].includes(node.type)
    )
      expect(
        ["page", "frame", "group"],
        `${node.type} ${node.id} inside a ${parent?.type} · ${history}`,
      ).toContain(parent?.type);
    // No cycles: the walk up ends at the root.
    const seen = new Set<string>();
    let at: string | undefined = node.id;
    while (at && at !== ROOT_ID) {
      expect(seen.has(at), `cycle at ${at} · ${history}`).toBe(false);
      seen.add(at);
      at = doc.get(at)?.parent;
    }
  }
  for (const id of editor.s.selection)
    expect(doc.get(id), `selected ${id} is gone · ${history}`).toBeDefined();

  // Auto layout has settled.
  const frames = layers(editor)
    .filter((n) => n.type === "frame")
    .map((n) => n.id);
  expect(layoutOps(doc, frames), `layout not settled · ${history}`).toEqual([]);

  // Explain's arithmetic is the canvas's.
  for (const node of layers(editor)) {
    for (const axis of ["width", "height"] as const) {
      const e = explainSize(doc, node.id, axis);
      if (!e?.formula) continue;
      const limit = e.terms.filter((t) => t.kind === "limit").reduce((s, t) => s + t.value, 0);
      const sum = e.terms.filter((t) => t.kind !== "limit").reduce((s, t) => s + t.value, 0);
      const share = Number(/÷ (\d+)$/.exec(e.formula)?.[1] ?? 1);
      expect(
        near(sum / share + limit, e.size),
        `Explain says ${e.formula} (${sum / share + limit}) for ${node.id}'s ${axis}, canvas says ${e.size} · ${history}`,
      ).toBe(true);
    }
  }
  sizePill(editor);
}

/** Commands that change the tree, not the design: nothing should move on the canvas. */
const STRUCTURAL = new Set<Action["kind"]>(["group", "ungroup", "frame", "move"]);

/** Whether auto layout places this layer (so it may move when the tree changes). */
const laidOut = (editor: Editor, id: string) =>
  editor.doc
    .ancestors(id)
    .some((a) => a.type === "frame" && a.props.layoutMode != null && a.props.layoutMode !== "none");

/** Where each shape and text is on the canvas. */
function placed(editor: Editor): Map<string, readonly { x: number; y: number }[]> {
  const out = new Map<string, readonly { x: number; y: number }[]>();
  for (const node of layers(editor)) {
    if (node.type === "group" || node.type === "frame" || laidOut(editor, node.id)) continue;
    const corners = editor.scene.corners(node.id);
    if (corners) out.set(node.id, corners);
  }
  return out;
}

function stayedPut(editor: Editor, before: ReturnType<typeof placed>, history: string): void {
  for (const [id, corners] of before) {
    if (!editor.doc.has(id) || laidOut(editor, id)) continue;
    const now = editor.scene.corners(id);
    const moved = now?.some((p, i) => {
      const was = corners[i] as { x: number; y: number };
      return Math.abs(p.x - was.x) > 0.02 || Math.abs(p.y - was.y) > 0.02;
    });
    expect(moved, `${id} moved on the canvas · ${history}`).toBe(false);
  }
}

describe("the editor, driven at random", () => {
  it("keeps the document sound, laid out and explainable, and undoes all the way back", () => {
    fc.assert(
      fc.property(
        fc.array(action, { minLength: 10, maxLength: Number(process.env.FUZZ_LENGTH ?? 60) }),
        (actions) => {
          const editor = setup();
          const start = snapshot(editor);
          const done: string[] = [];
          for (const a of actions) {
            const structural = STRUCTURAL.has(a.kind);
            const before = structural ? placed(editor) : null;
            run(editor, a);
            done.push(a.kind === "set" ? `set ${a.prop}=${JSON.stringify(a.value)}` : a.kind);
            check(editor, done.join(", "));
            if (before) stayedPut(editor, before, done.join(", "));
          }
          const end = snapshot(editor);
          // Undo to the start, then redo as many steps (the run may have ended on an undo).
          let steps = 0;
          while (editor.s.canUndo && steps < 500) {
            editor.undo();
            steps++;
          }
          expect(snapshot(editor), "undo all the way").toEqual(start);
          for (let i = 0; i < steps; i++) editor.redo();
          expect(snapshot(editor), "redo all the way").toEqual(end);
        },
      ),
      runs(150),
    );
  }, 120_000);
});
