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
import { canMoveInto, componentSetOf, variantProperties } from "../src/components";
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
  | { kind: "undo" | "redo" }
  /** A named editor command, with two picks for whatever it needs (a layer, a style, an edge). */
  | { kind: "command"; name: Command; a: number; b: number };

const COMMANDS = [
  "mask",
  "align",
  "distribute",
  "flip",
  "tidy",
  "grid",
  "variants",
  "addVariant",
  "setVariant",
  "insertInstance",
  "swap",
  "detach",
  "resetInstances",
  "resetOverride",
  "copyStyle",
  "pasteStyle",
  "text",
  "fit",
  "reorder",
  "textStyle",
  "applyStyle",
  "flatten",
  "addPage",
  "duplicatePage",
  "deletePage",
  "switchPage",
] as const;
type Command = (typeof COMMANDS)[number];

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
      kind: fc.constant("command" as const),
      name: fc.constantFrom(...COMMANDS),
      a: pick,
      b: pick,
    }),
    weight: 6,
  },
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
  walk(editor.s.pageId ?? "p");
  return out;
}
const at = <T>(list: readonly T[], i: number): T | undefined => list[i % Math.max(1, list.length)];

function run(editor: Editor, a: Action): void {
  const all = layers(editor);
  const containers = [
    editor.s.pageId ?? "p",
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
    case "command":
      command(editor, a, all);
      return;
  }
}

const ALIGN_EDGES = ["left", "center", "right", "top", "middle", "bottom"] as const;
const WORDS = ["Hi", "Sign in", "", "A longer line\nwith a break", "Plan your week"];

/** Runs one named command the way its menu item or shortcut does. */
function command(
  editor: Editor,
  { name, a, b }: Extract<Action, { kind: "command" }>,
  all: readonly NodeRecord[],
): void {
  const doc = editor.doc;
  const of = (type: string) => all.filter((n) => n.type === type);
  const mains = all.filter((n) => n.type === "frame" && n.props.isComponent === true);
  const instances = all.filter((n) => n.type === "frame" && typeof n.props.instanceOf === "string");
  const texts = of("text");
  const styles = doc.childIds(ROOT_ID).filter((id) => doc.get(id)?.type === "textStyle");
  switch (name) {
    case "mask":
      editor.toggleMask();
      return;
    case "align":
      editor.align(ALIGN_EDGES[a % ALIGN_EDGES.length] as (typeof ALIGN_EDGES)[number]);
      return;
    case "distribute":
      editor.distribute(a % 2 ? "horizontal" : "vertical");
      return;
    case "flip":
      editor.flip(a % 2 ? "horizontal" : "vertical");
      return;
    case "tidy":
      editor.tidyUp();
      return;
    case "grid":
      editor.addGridLayout();
      return;
    case "variants":
      editor.combineAsVariants();
      return;
    case "addVariant": {
      const inSet = mains.filter((m) => componentSetOf(doc, m.id));
      const main = at(inSet, a);
      if (main) editor.addVariant(main.id);
      return;
    }
    case "setVariant": {
      const instance = at(instances, a);
      const main = instance ? doc.get(String(instance.props.instanceOf)) : undefined;
      const set = main ? componentSetOf(doc, main.id) : undefined;
      const property = set ? at(variantProperties(doc, set.id), b) : undefined;
      if (instance && property)
        editor.setInstanceVariant(instance.id, property.name, at(property.values, a + b) as string);
      return;
    }
    case "insertInstance": {
      const main = at(mains, a);
      if (main) editor.insertInstance(main.id, { x: (b % 400) - 50, y: (a % 400) - 50 });
      return;
    }
    case "swap": {
      const instance = at(instances, a);
      const main = at(mains, b);
      if (instance && main) editor.swapInstance(instance.id, main.id);
      return;
    }
    case "detach":
      editor.detachInstances();
      return;
    case "resetInstances":
      editor.resetInstances();
      return;
    case "resetOverride": {
      const overridden = all.filter(
        (n) => Array.isArray(n.props.overrides) && n.props.overrides.length > 0,
      );
      const node = at(overridden, a);
      const prop = node ? at(node.props.overrides as string[], b) : undefined;
      if (node && prop) editor.resetOverride(node.id, prop);
      return;
    }
    case "copyStyle":
      editor.copyProperties();
      return;
    case "pasteStyle":
      editor.pasteProperties();
      return;
    case "text": {
      const text = at(texts, a);
      if (text) editor.updateText(text.id, at(WORDS, b) as string);
      return;
    }
    case "fit":
      editor.fitToContent();
      return;
    case "reorder":
      editor.reorder((["forward", "backward", "front", "back"] as const)[a % 4] ?? "front");
      return;
    case "textStyle": {
      const text = at(texts, a);
      if (text) editor.createTextStyle(`style ${b % 5}`, text.id);
      return;
    }
    case "applyStyle": {
      const text = at(texts, a);
      if (text) editor.applyTextStyle([text.id], b % 3 === 0 ? null : (at(styles, b) ?? null));
      return;
    }
    case "flatten":
      editor.flatten();
      return;
    case "addPage":
      editor.addPage();
      return;
    case "duplicatePage":
      if (editor.s.pageId) editor.duplicatePage(editor.s.pageId);
      return;
    case "deletePage":
      if (editor.s.pageId && doc.pageIds().length > 1) editor.deletePage(editor.s.pageId);
      return;
    case "switchPage": {
      const page = at(doc.pageIds(), a);
      if (page) editor.setPage(page);
      return;
    }
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
    // Pages, text styles and variable collections live at the document's root.
    if (node.type === "page" || node.type === "textStyle" || node.type === "collection") {
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
            done.push(
              a.kind === "set"
                ? `set ${a.prop}=${JSON.stringify(a.value)}`
                : a.kind === "command"
                  ? a.name
                  : a.kind,
            );
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
