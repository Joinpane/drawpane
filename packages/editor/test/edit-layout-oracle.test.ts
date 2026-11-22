/**
 * Every edit leaves the document as a full layout of the whole document
 * would: whatever an edit lays out, laying out everything afresh afterwards
 * changes nothing. The oracles here share nothing with the commit pipeline
 * (which layers an edit counts as changed, which it lays out, which empty
 * frames shrink): only the layout engine run whole, the text measurer, and
 * the stored form.
 *
 * After every edit:
 * - a full layout of every layout frame in the document makes no changes,
 *   where a Hug frame the edit left with nothing in its flow (it had
 *   something before, or it hugs now and didn't) shrinks to its padding and
 *   one empty already keeps its box;
 * - auto-sized text is the size it measures at;
 * - the document read back from its stored form is the same (a reload);
 * - another document that applied the stored operations is the same (a
 *   collaborator, or patch replay).
 * Undoing an edit and redoing it gives the document it left. At the end,
 * merging the run into the document it started from, as a branch merges,
 * gives the same document. Every kind of edit has to have changed the
 * document somewhere in the runs, so none is quietly refused.
 *
 * The documents are made in the editor (laid out as made): auto layout
 * frames, text that wraps and hugs, groups with absolute members,
 * constraints on both axes, two components (bound to variables) and their
 * instances, one in a frame set to the other mode, and variables with two
 * modes bound to visibility, padding and gaps. The edits are the editor's
 * own commands, each on a layer it applies to, copies inside instances
 * included.
 */
import {
  type BindingKey,
  branchChanges,
  constrainedValues,
  getProp,
  hugsOn,
  keyBetween,
  measuresOn,
  mergeOps,
  type NodeRecord,
  nodeReader,
  type Op,
  type Props,
  ROOT_ID,
} from "@drawpane/model";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { affectedComponents, canMoveInto, instancesOf, wouldCycle } from "../src/components";
import { Doc } from "../src/doc";
import { Editor } from "../src/editor";
import { layoutOps } from "../src/layout";
import { autoSize, type TextMeasurer } from "../src/text";

const measurer: TextMeasurer = {
  width: (font, text) => text.length * Number(font.match(/(\d+(?:\.\d+)?)px/)?.[1] ?? 16) * 0.5,
};

/** Every layer under the pages, as presented (copies included), parents first. */
function layers(doc: Doc): NodeRecord[] {
  const out: NodeRecord[] = [];
  const walk = (id: string) => {
    for (const child of doc.childIds(id)) {
      const node = doc.get(child);
      if (!node) continue;
      out.push(node);
      walk(child);
    }
  };
  for (const page of doc.pageIds()) walk(page);
  return out;
}

/** The document as people see it: every layer's place and values. */
function snapshot(doc: Doc): Snapshot {
  const out: Snapshot = {};
  for (const node of layers(doc))
    out[node.id] = { parent: node.parent, key: node.key, type: node.type, props: node.props };
  return out;
}

/** Whether auto layout places a layer: shown, and not absolute. */
const flows = (node: NodeRecord) =>
  getProp(node.props, "visible") !== false && getProp(node.props, "positioning") !== "absolute";

/** A layout frame as an edit found it: whether anything was in its flow, and how it sized. */
interface FrameState {
  readonly flow: boolean;
  readonly hugH: boolean;
  readonly hugV: boolean;
}

const isLayoutFrame = (node: NodeRecord) =>
  node.type === "frame" && getProp(node.props, "layoutMode") !== "none";

function frameStates(doc: Doc): Map<string, FrameState> {
  const out = new Map<string, FrameState>();
  for (const node of layers(doc))
    if (node.type === "frame")
      out.set(node.id, {
        flow: doc.childIds(node.id).some((id) => {
          const child = doc.get(id);
          return !!child && flows(child);
        }),
        hugH: getProp(node.props, "sizingH") === "hug",
        hugV: getProp(node.props, "sizingV") === "hug",
      });
  return out;
}

/**
 * What laying out the whole document afresh would still change, and text
 * that measures otherwise. With `before` (the frames as the edit found
 * them), a Hug frame the edit left empty shrinks to its padding: on both
 * axes when it had something in its flow, on an axis it newly hugs on
 * otherwise. Any other empty frame keeps the box it has.
 */
function unsettled(doc: Doc, before?: ReadonlyMap<string, FrameState>): unknown[] {
  const all = layers(doc);
  const frames = all.filter((n) => n.type === "frame").map((n) => n.id);
  const shrinkEmpty = new Set<string>();
  const keepEmpty = new Set<string>();
  if (before) {
    const now = frameStates(doc);
    for (const node of all) {
      const state = now.get(node.id);
      if (!state || state.flow || !isLayoutFrame(node)) continue;
      const was = before.get(node.id);
      if (was?.flow) {
        shrinkEmpty.add(node.id);
        continue;
      }
      keepEmpty.add(node.id);
      if (was && !was.hugH && state.hugH) shrinkEmpty.add(`${node.id}:h`);
      if (was && !was.hugV && state.hugV) shrinkEmpty.add(`${node.id}:v`);
    }
  }
  // Issue 283: an empty layout frame turned a quarter with Fill across and Hug on its height has
  // two answers; what a full layout would change of one is set aside, nothing else.
  const twoAnswers = (id: string) => {
    const n = doc.get(id);
    if (!n || !isLayoutFrame(n) || frameStates(doc).get(id)?.flow) return false;
    if (Math.abs(getProp(n.props, "rotation")) % 180 !== 90) return false;
    const h = getProp(n.props, "sizingH");
    const v = getProp(n.props, "sizingV");
    return (h === "fill" && v === "hug") || (h === "hug" && v === "fill");
  };
  let ops = layoutOps(doc, frames, { shrinkEmpty, keepEmpty }).filter((op) => !twoAnswers(op.id));
  // Issue 283 too: a layout frame turned a quarter with Fill on an axis can swing between two
  // answers, a full layout of each giving the other, and every flow it's in reflows with it.
  // Where a second full layout doesn't settle, what it changes in the auto layout around such a
  // frame (from the outermost layout frame it's in down) is set aside.
  const turnedFill = (n: NodeRecord) =>
    isLayoutFrame(n) &&
    Math.abs(getProp(n.props, "rotation")) % 180 === 90 &&
    (getProp(n.props, "sizingH") === "fill" || getProp(n.props, "sizingV") === "fill");
  const swingRoots = new Set<string>();
  for (const n of all) {
    if (!turnedFill(n)) continue;
    let root = n;
    for (let up = doc.get(root.parent); up && isLayoutFrame(up); up = doc.get(up.parent)) root = up;
    swingRoots.add(root.id);
  }
  const swings = (op: Op) =>
    swingRoots.has(op.id) || doc.ancestors(op.id).some((a) => swingRoots.has(a.id));
  if (ops.some(swings)) {
    const again = new Doc();
    again.resetStored(doc.stored(), doc.compactCopies ? "compact" : "materialized");
    again.applyStored(ops, { held: true });
    if (layoutOps(again, frames, { shrinkEmpty, keepEmpty }).some(swings))
      ops = ops.filter((op) => !swings(op));
  }
  // Issue 306: layers kept by an instance whose main is gone aren't laid out in another mode;
  // what a full layout changes inside one is set aside.
  ops = ops.filter(
    (op) =>
      !doc.ancestors(op.id).some((a) => {
        const main = getProp(a.props, "instanceOf");
        return !!main && !doc.has(main);
      }),
  );
  // Issue 302: layout stretches a size bound to a variable, which the binding sets otherwise. A
  // full layout's width or height for a layer that binds it, in a flow stretching that axis, is
  // set aside.
  ops = ops.filter((op) => {
    if (op.op !== "set" || (op.prop !== "width" && op.prop !== "height")) return true;
    const n = doc.get(op.id);
    const parent = n ? doc.get(n.parent) : undefined;
    if (!n || !parent || !isLayoutFrame(parent) || !getProp(n.props, "bindings")[op.prop])
      return true;
    const mode = getProp(parent.props, "layoutMode");
    const cross = mode === "column" ? "width" : mode === "row" ? "height" : undefined;
    const sizing = getProp(n.props, op.prop === "width" ? "sizingH" : "sizingV");
    return !(
      cross === op.prop &&
      getProp(parent.props, "alignItems") === "stretch" &&
      sizing === "fixed" &&
      getProp(n.props, "positioning") !== "absolute"
    );
  });
  const out: unknown[] = ops;
  // A copy layer its frame places freely sits where its constraints put it, from its main layer
  // (moved by the difference in size where its frame differs from its main's), unless it
  // overrides its own place.
  for (const node of all) {
    const sourceId = getProp(node.props, "mirrors");
    const source = sourceId ? doc.get(sourceId) : undefined;
    const parent = doc.get(node.parent);
    if (!source || parent?.type !== "frame" || node.type === "group") continue;
    if (isLayoutFrame(parent) && getProp(node.props, "positioning") !== "absolute") continue;
    // Placed otherwise by the copy's own choice: made absolute, or in a frame it gave (or took)
    // auto layout. Its place then is where that left it.
    const parentSource = doc.get(source.parent);
    if (
      getProp(node.props, "positioning") !== getProp(source.props, "positioning") ||
      getProp(parent.props, "layoutMode") !== getProp(parentSource?.props ?? {}, "layoutMode") ||
      getProp(parent.props, "overrides").includes("layoutMode")
    )
      continue;
    // Issue 305: an instance sized by a binding, or a nested instance nothing lays out left at a
    // size its main layer no longer has (swapped), doesn't place its layers again; their places
    // and sizes are set aside, nothing else.
    const instances = doc.ancestors(node.id).filter((a) => getProp(a.props, "instanceOf"));
    // Issue 306: layers kept by an instance whose main is gone lose what placed them.
    if (instances.some((a) => !doc.has(getProp(a.props, "instanceOf") as string))) continue;
    if (
      instances.some((a) => {
        const bound = getProp(a.props, "bindings") as Record<string, unknown>;
        // A nested instance nothing lays out (hidden, or not in a flow) keeps a size its main
        // layer no longer has (after a swap).
        const layer = doc.get(getProp(a.props, "mirrors") ?? "");
        const frame = doc.get(a.parent);
        const unplaced =
          !getProp(a.props, "visible") ||
          getProp(a.props, "positioning") === "absolute" ||
          !frame ||
          !isLayoutFrame(frame);
        const stale =
          !!layer &&
          unplaced &&
          (getProp(a.props, "width") !== getProp(layer.props, "width") ||
            getProp(a.props, "height") !== getProp(layer.props, "height"));
        return !!bound.width || !!bound.height || stale;
      })
    )
      continue;
    const derived = constrainedValues(node, source, parent, parentSource);
    const own = getProp(node.props, "overrides");
    for (const [prop, axis] of [
      ["x", "h"],
      ["y", "v"],
      ["width", "h"],
      ["height", "v"],
    ] as const) {
      // A bound value is its variable's, in the copy's mode (decision 0034).
      const bound = getProp(node.props, "bindings") as Record<string, unknown>;
      if (own.includes(prop) || bound[prop]) continue;
      // A size its own layout decides (it hugs, its text measures itself, or it's an instance,
      // sized as its own main is in its mode) is checked above; one whose sizing it overrides is
      // its own (made fixed, it keeps the size it had).
      if (
        (prop === "width" || prop === "height") &&
        (hugsOn(node, axis) ||
          measuresOn(node, axis) ||
          getProp(node.props, "instanceOf") ||
          own.includes(axis === "h" ? "sizingH" : "sizingV"))
      )
        continue;
      const want = derived[prop] ?? getProp(source.props, prop);
      const have = getProp(node.props, prop);
      // Both are kept to two places: compare them there.
      if (Math.round(Math.abs(want - have) * 100) > 1)
        out.push({ constrained: node.id, prop, have, want });
    }
  }
  for (const node of all) {
    if (node.type !== "text") continue;
    const size = autoSize(node, measurer);
    if (!size) continue;
    const r = (v: number) => Math.round(v * 100) / 100;
    // A bound size is its variable's, whatever the text measures (decision 0034).
    const bound = getProp(node.props, "bindings");
    if (!bound.width && r(size.width) !== r(getProp(node.props, "width")))
      out.push({ text: node.id, width: [getProp(node.props, "width"), r(size.width)] });
    // Issue 295: text with Fill across in a flow that wraps gets a height measured at another
    // width; its height alone is set aside, nothing else.
    const parent = doc.get(node.parent);
    const wrapped =
      getProp(node.props, "sizingH") === "fill" &&
      !!parent &&
      isLayoutFrame(parent) &&
      getProp(parent.props, "layoutWrap") &&
      getProp(node.props, "positioning") !== "absolute";
    if (!bound.height && !wrapped && r(size.height) !== r(getProp(node.props, "height")))
      out.push({ text: node.id, height: [getProp(node.props, "height"), r(size.height)] });
  }
  return out;
}

type Kind = "rect" | "text" | "frame" | "group" | "instance";
type Constraint = "start" | "end" | "center" | "stretch" | "scale";
const constraint = fc.constantFrom<Constraint>("start", "end", "center", "stretch", "scale");
interface Spec {
  kind: Kind;
  layoutMode: "none" | "row" | "column" | "grid";
  sizingH: "fixed" | "hug" | "fill";
  sizingV: "fixed" | "hug" | "fill";
  align: "start" | "center" | "end" | "stretch";
  wrap: boolean;
  padding: number;
  gap: number;
  w: number;
  h: number;
  absolute: boolean;
  text: "width" | "height" | "none";
  constraintH: Constraint;
  constraintV: Constraint;
  main: number;
  children: Spec[];
}

const leafKind = fc.constantFrom<Kind>("rect", "rect", "text", "text", "instance", "group");
const base = {
  layoutMode: fc.constantFrom<Spec["layoutMode"]>("row", "row", "column", "grid", "none"),
  sizingH: fc.constantFrom<Spec["sizingH"]>("fixed", "hug", "fill"),
  sizingV: fc.constantFrom<Spec["sizingV"]>("fixed", "hug", "fill"),
  align: fc.constantFrom<Spec["align"]>("start", "center", "end", "stretch"),
  wrap: fc.boolean(),
  padding: fc.integer({ min: 0, max: 8 }),
  gap: fc.integer({ min: 0, max: 8 }),
  w: fc.integer({ min: 8, max: 120 }),
  h: fc.integer({ min: 8, max: 60 }),
  absolute: fc.constantFrom(false, false, true),
  text: fc.constantFrom<Spec["text"]>("width", "height", "none"),
  constraintH: constraint,
  constraintV: constraint,
  main: fc.nat(3),
};
const tree = fc.letrec<{ node: Spec; frame: Spec }>((tie) => ({
  node: fc.oneof(
    { depthSize: "small", withCrossShrink: true },
    fc.record({ ...base, kind: leafKind, children: fc.constant([] as Spec[]) }),
    tie("frame"),
  ),
  frame: fc.record({
    ...base,
    kind: fc.constant<Kind>("frame"),
    children: fc.array(tie("node"), { maxLength: 4 }),
  }),
})).frame;

const VARIABLES = {
  show: "show",
  shown: "shown",
  pad: "pad",
  gap: "gapv",
  words: "words",
  size: "size",
} as const;

/** Makes the document through the editor, a commit at a time, as a person would. */
function build(editor: Editor, spec: Spec): void {
  let n = 0;
  const id = () => `n${(n++).toString(36)}`;
  // One rising sequence for every parent: each layer goes after its siblings.
  let last: string | null = null;
  const key = () => {
    last = keyBetween(last, null);
    return last;
  };
  // Every part of it is made: an edit refused here would leave a document other than meant.
  const commit = (ops: Op[]) => expect(editor.commit(ops), JSON.stringify(ops)).toBe(true);
  commit([
    {
      op: "create",
      id: "c",
      type: "collection",
      parent: ROOT_ID,
      key: "a1",
      props: {
        name: "Theme",
        modes: [
          { id: "light", name: "Light" },
          { id: "dark", name: "Dark" },
        ],
      },
    },
    {
      op: "create",
      id: VARIABLES.show,
      type: "variable",
      parent: "c",
      key: "a0",
      props: {
        name: "Show",
        variableType: "boolean",
        values: { light: true, dark: false },
      },
    },
    {
      op: "create",
      id: VARIABLES.shown,
      type: "variable",
      parent: "c",
      key: "a1",
      props: {
        name: "Shown",
        variableType: "boolean",
        values: { light: true, dark: true },
      },
    },
    {
      op: "create",
      id: VARIABLES.pad,
      type: "variable",
      parent: "c",
      key: "a2",
      props: {
        name: "Pad",
        variableType: "number",
        values: { light: 4, dark: 12 },
      },
    },
    {
      op: "create",
      id: VARIABLES.gap,
      type: "variable",
      parent: "c",
      key: "a3",
      props: {
        name: "Gap",
        variableType: "number",
        values: { light: 2, dark: 10 },
      },
    },
    {
      op: "create",
      id: VARIABLES.words,
      type: "variable",
      parent: "c",
      key: "a4",
      props: {
        name: "Words",
        variableType: "string",
        values: { light: "Column", dark: "A longer dark column" },
      },
    },
    {
      op: "create",
      id: VARIABLES.size,
      type: "variable",
      parent: "c",
      key: "a5",
      props: { name: "Size", variableType: "number", values: { light: 10, dark: 14 } },
    },
  ]);
  // Two components: a hugging row with a text and a padded inner row, and a column. The
  // inner row's padding and the column's text's visibility are bound, so copies shown in
  // another mode are laid out otherwise than their mains.
  const mains: string[] = [];
  for (const [i, mode] of (["row", "column"] as const).entries()) {
    const main = `main${i}`;
    mains.push(main);
    commit([
      {
        op: "create",
        id: main,
        type: "frame",
        parent: "p",
        key: key(),
        props: {
          name: `Main ${i}`,
          isComponent: true,
          x: 600 + i * 300,
          y: 0,
          width: 100,
          height: 40,
          layoutMode: mode,
          sizingH: "hug",
          sizingV: "hug",
          paddingLeft: 4,
          paddingRight: 4,
          paddingTop: 4,
          paddingBottom: 4,
          gap: 4,
        },
      },
      {
        op: "create",
        id: `${main}t`,
        type: "text",
        parent: main,
        key: "a0",
        props: {
          characters: i ? "Column" : "Label",
          fontSize: 10,
          textAutoResize: "width",
          // Words and sizes that differ by mode, so copies in Dark measure for themselves.
          bindings: i
            ? { visible: VARIABLES.show, characters: VARIABLES.words }
            : { fontSize: VARIABLES.size },
        },
      },
      {
        op: "create",
        id: `${main}f`,
        type: "frame",
        parent: main,
        key: "a1",
        props: {
          layoutMode: "row",
          width: 40,
          height: 20,
          sizingH: i ? "fill" : "fixed",
          sizingV: "hug",
          paddingLeft: 4,
          gap: 2,
          ...(i ? {} : { bindings: { paddingLeft: VARIABLES.pad } }),
        },
      },
      {
        op: "create",
        id: `${main}r`,
        type: "rect",
        parent: `${main}f`,
        key: "a0",
        props: {
          width: 8,
          height: 8,
        },
      },
      {
        op: "create",
        id: `${main}s`,
        type: "rect",
        parent: `${main}f`,
        key: "a1",
        props: {
          width: 6,
          height: 10,
        },
      },
    ]);
  }
  const instance = (main: string, parent: string) => {
    editor.select([]);
    const made = editor.insertInstance(main, { x: 2000, y: 2000 });
    expect(made, `an instance of ${main}`).toBeTruthy();
    commit([{ op: "move", id: made as string, parent, key: key() }]);
  };
  // A frame in the other mode, with an instance of each component.
  commit([
    {
      op: "create",
      id: "dark",
      type: "frame",
      parent: "p",
      key: key(),
      props: { name: "Dark", x: 0, y: 600, width: 400, height: 200, variableModes: { c: "dark" } },
    },
  ]);
  // A component holding an instance of the first, and one with a plain root whose layers its
  // constraints place: a stretched auto-width text and a stretched row.
  commit([
    {
      op: "create",
      id: "main2",
      type: "frame",
      parent: "p",
      key: key(),
      props: {
        name: "Main 2",
        isComponent: true,
        x: 1200,
        y: 0,
        width: 120,
        height: 50,
        layoutMode: "row",
        sizingH: "hug",
        sizingV: "hug",
        paddingLeft: 6,
        gap: 4,
      },
    },
    {
      op: "create",
      id: "main3",
      type: "frame",
      parent: "p",
      key: key(),
      props: { name: "Main 3", isComponent: true, x: 1500, y: 0, width: 160, height: 80 },
    },
    {
      op: "create",
      id: "main3t",
      type: "text",
      parent: "main3",
      key: "a0",
      props: {
        x: 10,
        y: 10,
        characters: "Words that wrap",
        fontSize: 10,
        textAutoResize: "width",
        constraintH: "stretch",
      },
    },
    {
      op: "create",
      id: "main3f",
      type: "frame",
      parent: "main3",
      key: "a1",
      props: {
        x: 10,
        y: 40,
        width: 140,
        height: 20,
        layoutMode: "row",
        constraintH: "stretch",
        paddingLeft: 4,
        bindings: { paddingLeft: VARIABLES.pad },
      },
    },
    {
      op: "create",
      id: "main3r",
      type: "rect",
      parent: "main3f",
      key: "a0",
      props: { width: 8, height: 8, sizingH: "fill" },
    },
  ]);
  instance("main0", "main2");
  mains.push("main2", "main3");
  for (const main of mains) instance(main, "dark");
  const make = (s: Spec, parent: string) => {
    if (s.kind === "instance") {
      instance(mains[s.main] as string, parent);
      return;
    }
    if (s.kind === "group") {
      const group = id();
      commit([
        { op: "create", id: group, type: "group", parent, key: key(), props: {} },
        {
          op: "create",
          id: id(),
          type: "rect",
          parent: group,
          key: "a0",
          props: {
            x: 0,
            y: 0,
            width: s.w,
            height: s.h,
            ...(s.absolute ? { positioning: "absolute" } : {}),
          },
        },
        {
          op: "create",
          id: id(),
          type: "rect",
          parent: group,
          key: "a1",
          props: {
            x: s.w,
            y: 4,
            width: 10,
            height: 10,
          },
        },
      ]);
      return;
    }
    const own = id();
    const props: Record<string, unknown> = {
      x: 4,
      y: 4,
      width: s.w,
      height: s.h,
      sizingH: s.sizingH,
      sizingV: s.sizingV,
      constraintH: s.constraintH,
      constraintV: s.constraintV,
      ...(s.absolute ? { positioning: "absolute" } : {}),
    };
    if (s.kind === "frame")
      Object.assign(props, {
        layoutMode: s.layoutMode,
        layoutWrap: s.wrap,
        alignItems: s.align,
        paddingLeft: s.padding,
        paddingRight: s.padding,
        paddingTop: s.padding,
        paddingBottom: s.padding,
        gap: s.gap,
      });
    if (s.kind === "text")
      Object.assign(props, {
        characters: "Words that wrap here",
        fontSize: 10,
        textAutoResize: s.text,
      });
    commit([{ op: "create", id: own, type: s.kind, parent, key: key(), props }]);
    for (const child of s.children) make(child, own);
  };
  make(spec, "p");
}

type Edit =
  | { kind: "size"; at: number; prop: "width" | "height"; value: number }
  | { kind: "sizing"; at: number; prop: "sizingH" | "sizingV"; value: Spec["sizingH"] }
  | { kind: "padding" | "gap"; at: number; value: number }
  | { kind: "layoutMode"; at: number; value: Spec["layoutMode"] }
  | { kind: "visible" | "absolute"; at: number }
  | { kind: "constraint"; at: number; prop: "constraintH" | "constraintV"; value: Constraint }
  | { kind: "rotate"; at: number; value: number }
  | { kind: "fill"; at: number; value: number }
  | { kind: "text"; at: number; words: number }
  | { kind: "nudge"; at: number; dx: number; dy: number }
  | { kind: "move"; at: number; into: number }
  | { kind: "delete"; at: number }
  | { kind: "group" | "ungroup"; at: number }
  | { kind: "bind"; at: number; binding: number }
  | { kind: "unbind"; at: number; binding: number }
  | { kind: "variable"; variable: number; mode: number; value: number }
  | { kind: "mode"; at: number; mode: number }
  | { kind: "swap" | "detach" | "reset" | "reset-all"; at: number }
  | { kind: "undo" }
  | { kind: "undo-redo" };

const at = fc.nat(400);
const edit: fc.Arbitrary<Edit> = fc.oneof(
  fc.record({
    kind: fc.constant("size" as const),
    at,
    prop: fc.constantFrom<"width" | "height">("width", "height"),
    value: fc.integer({ min: 4, max: 200 }),
  }),
  fc.record({
    kind: fc.constant("sizing" as const),
    at,
    prop: fc.constantFrom<"sizingH" | "sizingV">("sizingH", "sizingV"),
    value: base.sizingH,
  }),
  fc.record({ kind: fc.constantFrom("padding" as const, "gap" as const), at, value: fc.nat(12) }),
  fc.record({ kind: fc.constant("layoutMode" as const), at, value: base.layoutMode }),
  fc.record({ kind: fc.constantFrom("visible" as const, "absolute" as const), at }),
  fc.record({
    kind: fc.constant("constraint" as const),
    at,
    prop: fc.constantFrom<"constraintH" | "constraintV">("constraintH", "constraintV"),
    value: constraint,
  }),
  fc.record({ kind: fc.constant("rotate" as const), at, value: fc.constantFrom(0, 15, 30, 90) }),
  fc.record({ kind: fc.constant("fill" as const), at, value: fc.nat(2) }),
  fc.record({ kind: fc.constant("text" as const), at, words: fc.integer({ min: 0, max: 8 }) }),
  fc.record({
    kind: fc.constant("nudge" as const),
    at,
    dx: fc.integer({ min: -12, max: 12 }),
    dy: fc.integer({ min: -6, max: 6 }),
  }),
  fc.record({ kind: fc.constant("move" as const), at, into: at }),
  fc.record({ kind: fc.constant("delete" as const), at }),
  fc.record({ kind: fc.constantFrom("group" as const, "ungroup" as const), at }),
  fc.record({ kind: fc.constantFrom("bind" as const, "unbind" as const), at, binding: fc.nat(6) }),
  fc.record({
    kind: fc.constant("variable" as const),
    variable: fc.nat(5),
    mode: fc.nat(1),
    value: fc.nat(1),
  }),
  fc.record({ kind: fc.constant("mode" as const), at, mode: fc.nat(2) }),
  fc.record({
    kind: fc.constantFrom(
      "swap" as const,
      "detach" as const,
      "reset" as const,
      "reset-all" as const,
    ),
    at,
  }),
  fc.constantFrom({ kind: "undo" as const }, { kind: "undo-redo" as const }),
);
const KINDS: readonly Edit["kind"][] = [
  "size",
  "sizing",
  "padding",
  "gap",
  "layoutMode",
  "visible",
  "absolute",
  "constraint",
  "rotate",
  "fill",
  "text",
  "nudge",
  "move",
  "delete",
  "group",
  "ungroup",
  "bind",
  "unbind",
  "variable",
  "mode",
  "swap",
  "detach",
  "reset",
  "reset-all",
  "undo",
  "undo-redo",
];

const BINDINGS: Array<[BindingKey, string]> = [
  ["visible", VARIABLES.show],
  ["visible", VARIABLES.shown],
  ["paddingLeft", VARIABLES.pad],
  ["gap", VARIABLES.gap],
  ["width", VARIABLES.pad],
  ["characters", VARIABLES.words],
  ["fontSize", VARIABLES.size],
];

const isFrame = (node: NodeRecord) => node.type === "frame";
const isInstance = (node: NodeRecord) => !!getProp(node.props, "instanceOf");
/** The layers each kind of edit applies to (any layer, for a kind not here). */
const TARGETS: Partial<Record<Edit["kind"], (node: NodeRecord) => boolean>> = {
  padding: isFrame,
  gap: isFrame,
  layoutMode: isFrame,
  mode: isFrame,
  text: (node) => node.type === "text",
  ungroup: (node) => node.type === "group",
  swap: isInstance,
  detach: isInstance,
  reset: (node) => getProp(node.props, "overrides").length > 0,
  "reset-all": isInstance,
  unbind: (node) => Object.keys(getProp(node.props, "bindings")).length > 0,
};

type Snapshot = Record<string, { parent: string; key: string; type: string; props: Props }>;

/**
 * How `after` differs from `before`, less what two known issues explain,
 * each by its own signature (and #310's, a Fill layer in a grid only moved or
 * resized): #280, a layer of an instance whose main is
 * gone, lost when its delete is redone; #281, a materialized layer (a copy
 * layer or an instance) only moved or resized by the redo; #290, a layer
 * only moved or resized in a flow holding a group with an absolute member.
 */
function unexplained(before: Snapshot, after: Snapshot, doc: Doc): string[] {
  const out: string[] = [];
  for (const id of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const was = before[id];
    const now = after[id];
    if (stable(was) === stable(now)) continue;
    const source = was && getProp(was.props, "mirrors");
    if (was && !now && orphaned(before, id, doc)) continue;
    if (was && now && placedOnly(was, now) && inGroupedFlow(before, id)) continue;
    // Issue 310: a Fill layer directly in a grid has more than one settled layout.
    const grid = was ? before[was.parent] : undefined;
    if (
      was &&
      now &&
      placedOnly(was, now) &&
      grid &&
      getProp(grid.props, "layoutMode") === "grid" &&
      (getProp(was.props, "sizingH") === "fill" || getProp(was.props, "sizingV") === "fill")
    )
      continue;
    const linked = source !== null || getProp(was?.props ?? {}, "instanceOf") !== null;
    if (was && now && linked && !doc.compactCopies && getProp(now.props, "mirrors") === source) {
      const same = (n: typeof was) => stable({ ...n, props: placeless(n.props) });
      if (same(was) === same(now)) continue;
    }
    out.push(id);
  }
  return out;
}

/** Whether two states of a layer differ in nothing but place and size. */
function placedOnly(a: Snapshot[string], b: Snapshot[string]): boolean {
  return (
    stable({ ...a, props: placeless(a.props) }) === stable({ ...b, props: placeless(b.props) })
  );
}

/**
 * Whether a layer is, or is in (through groups), a layout frame holding a
 * group with an absolute member: issue 290's flow, whose placement isn't
 * one answer.
 */
function inGroupedFlow(before: Snapshot, id: string): boolean {
  const kids = new Map<string, string[]>();
  for (const [kid, n] of Object.entries(before)) {
    const list = kids.get(n.parent) ?? [];
    list.push(kid);
    kids.set(n.parent, list);
  }
  const holds = (frameId: string) =>
    (kids.get(frameId) ?? []).some(
      (g) =>
        before[g]?.type === "group" &&
        (kids.get(g) ?? []).some(
          (m) => getProp(before[m]?.props ?? {}, "positioning") === "absolute",
        ),
    );
  for (let at: string | undefined = id; at && before[at]; at = before[at]?.parent) {
    const n = before[at];
    if (n?.type === "frame" && getProp(n.props, "layoutMode") !== "none" && holds(at)) return true;
    if (at !== id && n?.type !== "group") break;
  }
  return false;
}

/** Every layer under `id`, as presented. */
function collectDescendants(doc: Doc, id: string): NodeRecord[] {
  const out: NodeRecord[] = [];
  const stack = [...doc.childIds(id)];
  for (let at = stack.pop(); at !== undefined; at = stack.pop()) {
    const n = doc.get(at);
    if (n) out.push(n);
    stack.push(...doc.childIds(at));
  }
  return out;
}

/** Whether a layer sat, before, in an instance whose main is gone now (issue 280's). */
function orphaned(before: Snapshot, id: string, doc: Doc): boolean {
  for (let at = before[id]; at; at = before[at.parent]) {
    const main = getProp(at.props, "instanceOf");
    if (main && !doc.has(main)) return true;
  }
  return false;
}

/** A value as JSON with its keys in order, so two orders of the same fields compare equal. */
function stable(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

/** Props without a place or size. */
function placeless(props: Props): Props {
  const { x: _x, y: _y, width: _w, height: _h, ...rest } = props as Record<string, unknown>;
  return rest as Props;
}

/**
 * Makes the edit through the editor's own commands, on a layer it applies
 * to. "lost" when it deleted a component a swapped copy shows (issue 289:
 * compact copies drop that layer, and the run can't go on from there).
 */
function perform(
  editor: Editor,
  e: Edit,
  roundTrip = true,
  concurrent: ReadonlySet<string> = new Set(),
): "lost" | undefined {
  const doc = editor.doc;
  if (e.kind === "undo") {
    editor.undo();
    return;
  }
  if (e.kind === "undo-redo") {
    // Back where it was, layout and all.
    const before = snapshot(doc);
    editor.undo();
    editor.redo();
    // Issue 307: a layer both clients changed concurrently can have lost the other's override
    // marks, so a redo's sync puts its main's values back; those layers are set aside.
    if (roundTrip)
      expect(
        unexplained(before, snapshot(doc), doc).filter((id) => !concurrent.has(id)),
        "undone and redone",
      ).toEqual([]);
    return;
  }
  if (e.kind === "variable") {
    const variable = [
      VARIABLES.show,
      VARIABLES.shown,
      VARIABLES.pad,
      VARIABLES.gap,
      VARIABLES.words,
      VARIABLES.size,
    ][e.variable] as string;
    const mode = e.mode ? "dark" : "light";
    const value =
      e.variable < 2
        ? e.value === 1
        : e.variable === 4
          ? e.value
            ? "A much longer label in this mode"
            : "Short"
          : e.value
            ? 14
            : 3;
    editor.setVariableValue(variable, mode, value);
    return;
  }
  const all = layers(doc);
  const [binding, variable] = BINDINGS[e.kind === "bind" ? e.binding : 0] as [BindingKey, string];
  const fits =
    e.kind === "bind" && (binding === "paddingLeft" || binding === "gap")
      ? isFrame
      : e.kind === "bind" && (binding === "characters" || binding === "fontSize")
        ? (n: NodeRecord) => n.type === "text"
        : TARGETS[e.kind];
  const candidates = fits ? all.filter(fits) : all;
  const node = candidates[e.at % Math.max(1, candidates.length)];
  if (!node) return;
  const id = node.id;
  switch (e.kind) {
    case "size":
      editor.resize([id], e.prop, e.value);
      break;
    case "sizing":
      editor.setProp([id], e.prop, e.value);
      break;
    case "padding":
      editor.setProp([id], "paddingLeft", e.value);
      break;
    case "gap":
      editor.setProp([id], "gap", e.value);
      break;
    case "layoutMode":
      editor.setLayoutMode([id], e.value);
      break;
    case "visible":
      editor.setProp([id], "visible", !getProp(node.props, "visible"));
      break;
    case "absolute":
      editor.setProp(
        [id],
        "positioning",
        getProp(node.props, "positioning") === "auto" ? "absolute" : "auto",
      );
      break;
    case "constraint":
      editor.setProp([id], e.prop, e.value);
      break;
    case "rotate":
      editor.setProp([id], "rotation", e.value);
      break;
    case "fill":
      // Nothing a layout reads: mains' copies lay out nothing for it.
      editor.setProp([id], "fills", [
        { type: "solid", color: ["#ff0000", "#00aa00", "#0000ff"][e.value] as string },
      ]);
      break;
    case "text":
      editor.setProp(
        [id],
        "characters",
        Array.from({ length: e.words + 1 }, (_, i) => `w${i}`).join(" "),
      );
      break;
    case "nudge":
      editor.select([id]);
      editor.nudge(e.dx, e.dy);
      break;
    case "move": {
      // Only where people can move it, as the editor's moves and drops ask (`canMoveInto`): not
      // into or out of an instance (issue 282: a materialized one takes a raw move, and its
      // main's next edit is refused half applied), nor a component into itself.
      const frames = all.filter(
        (f) => f.type === "frame" && f.id !== id && canMoveInto(doc, [id], f.id),
      );
      const into = frames[e.into % Math.max(1, frames.length)];
      if (!into || doc.ancestors(into.id).some((a) => a.id === id)) break;
      // Issue 311: a component moved into one its instances show through a swap makes a cycle
      // `canMoveInto` doesn't see yet; that move isn't made.
      if (getProp(node.props, "isComponent")) {
        const above = new Set(affectedComponents(doc, [into.id]));
        const swappedTo = instancesOf(doc, id).flatMap((root) =>
          collectDescendants(doc, root)
            .filter((n) => {
              const shown = getProp(n.props, "instanceOf");
              const layer = doc.get(getProp(n.props, "mirrors") ?? "");
              return !!shown && !!layer && shown !== getProp(layer.props, "instanceOf");
            })
            .map((n) => getProp(n.props, "instanceOf") as string),
        );
        if (swappedTo.some((c) => above.has(c))) break;
      }
      editor.commit([{ op: "move", id, parent: into.id, key: editor.topKey(into.id) }]);
      break;
    }
    case "delete": {
      const gone = new Set(
        [node, ...collectDescendants(doc, id)]
          .filter((n) => getProp(n.props, "isComponent"))
          .map((n) => n.id),
      );
      const swapped =
        doc.compactCopies &&
        all.some((n) => {
          const to = getProp(n.props, "instanceOf");
          const source = getProp(n.props, "mirrors");
          const from = source ? getProp(doc.get(source)?.props ?? {}, "instanceOf") : null;
          return !!to && !!source && to !== from && gone.has(to);
        });
      editor.select([id]);
      editor.deleteSelection();
      if (swapped) return "lost";
      break;
    }
    case "group":
      editor.select(doc.childIds(node.parent).slice(0, 2));
      editor.group();
      break;
    case "ungroup":
      editor.select([id]);
      editor.ungroup();
      break;
    case "bind":
      editor.bindVariable([id], binding, variable);
      break;
    case "unbind": {
      const bound = Object.keys(getProp(node.props, "bindings")) as BindingKey[];
      editor.unbindVariable([id], bound[e.binding % bound.length] as BindingKey);
      break;
    }
    case "mode":
      editor.setVariableModes([id], "c", [null, "light", "dark"][e.mode] ?? null);
      break;
    case "swap": {
      // Only to a component the swap menu offers: none that would hold an instance of itself.
      const mains = ["main0", "main1", "main2", "main3"];
      const now = mains.indexOf(getProp(node.props, "instanceOf") ?? "");
      const to = mains[(now + 1 + (e.at % 3)) % mains.length] as string;
      if (!wouldCycle(doc, to, node.parent)) editor.swapInstance(id, to);
      break;
    }
    case "detach":
      editor.select([id]);
      editor.detachInstances();
      break;
    case "reset":
      editor.resetOverrides([{ id, props: getProp(node.props, "overrides") }]);
      break;
    case "reset-all":
      // Everything in the instance a layer is in, its size included.
      editor.select([id]);
      editor.resetInstances();
      break;
  }
}

function makeEditor(nodes: readonly NodeRecord[] | null, copies: "compact" | "materialized") {
  const editor = new Editor({ measurer, clientId: "oracle" });
  editor.state.set({ role: "editor", viewport: { width: 1200, height: 800 } });
  const start: NodeRecord[] = nodes
    ? [...nodes]
    : [{ id: "p", type: "page", parent: ROOT_ID, key: "a0", props: { name: "Page" } }];
  // In the format asked for, whatever documents default to (`pnpm test` runs the suite again
  // with compact copies on for every document).
  editor.doc.resetStored(start, copies);
  editor.setPage("p");
  return editor;
}

function check(
  editor: Editor,
  mirror: Doc,
  copies: "compact" | "materialized",
  step: string,
  before?: ReadonlyMap<string, FrameState>,
  replay = true,
  layout = true,
) {
  if (layout)
    expect(unsettled(editor.doc, before), `a full layout changes nothing ${step}`).toEqual([]);
  const now = snapshot(editor.doc);
  const reloaded = new Doc();
  reloaded.resetStored(editor.doc.stored(), copies);
  expect(snapshot(reloaded), `read back from its stored form ${step}`).toEqual(now);
  if (!replay) return;
  const sent = editor.sync.takeUnsent();
  if (sent.length > 0) mirror.applyStored(sent, { held: true });
  expect(snapshot(mirror), `replayed ${step}`).toEqual(now);
}

/** A stale entry's layer and what about it is stale, to tell two checks' entries apart. */
function entryKey(o: unknown): string {
  const e = o as Record<string, unknown>;
  return `${String(e.id ?? e.constrained ?? e.text)}:${String(e.prop ?? (e.width ? "width" : "height"))}`;
}

/**
 * Connects the editor to a room that holds `nodes`, with a collaborator
 * editing the same file there: `remote` has them change a shared layer
 * (a copy's or an instance's fill or opacity, a reset, an instance moved
 * into Dark), arriving while the editor's own edits are still unsent (so
 * they're rebased on it). `settle` sends the editor's edits at last, as the
 * room takes them (acked, or refused when they no longer apply), and checks
 * the room ends as the editor did, with no desync.
 */
function connect(editor: Editor, nodes: readonly NodeRecord[], copies: "compact" | "materialized") {
  const sent: { t: string; seq?: number; ops?: Op[] }[] = [];
  let desync: string | null = null;
  let revn = 1;
  editor.sync.on("desync", (reason: string) => {
    desync = reason;
  });
  editor.sync.connected((m) => sent.push(m as never));
  const receive = (m: unknown) => editor.sync.receive(m as never);
  receive({
    t: "welcome",
    mode: "snapshot",
    revn,
    sessionId: "room",
    role: "editor",
    peers: [],
    lastSeq: 0,
    copies,
  });
  receive({ t: "snapshot", nodes, done: true });
  editor.setPage("p");
  const other = makeEditor(nodes, copies);
  const remote: Op[][] = [];
  /** Layers the editor's edits changed, all unsent until `settle`. */
  const ours = new Set<string>();
  /** Of those, the ones a collaborator's edit arrived after (so they were rebased on it). */
  const rebased = new Set<string>();
  /** Layers the collaborator's edits changed, with where they moved them from and to. */
  const theirs = new Set<string>();
  return {
    rebased,
    theirs,
    /** Records layers an edit of the editor's changed. */
    note(ids: Iterable<string>) {
      for (const id of ids) ours.add(id);
    },
    /**
     * The collaborator's edit for this step, arriving as a rebase. True when the same edit, made
     * after the editor's own instead of concurrently (on a copy of the editor's document), leaves
     * nothing newly stale: then whatever the rebase leaves stale is issue 294's.
     */
    remote(step: number): boolean {
      const all = layers(other.doc);
      const pick = (fits: (n: NodeRecord) => boolean) => {
        const list = all.filter(fits);
        return list[(step * 7) % Math.max(1, list.length)];
      };
      const copy = pick((n) => !!getProp(n.props, "mirrors"));
      const instance = pick(isInstance);
      const own = pick((n) => getProp(n.props, "overrides").length > 0);
      const act = (ed: Editor): boolean => {
        const has = (n: NodeRecord | undefined): n is NodeRecord => !!n && ed.doc.has(n.id);
        switch (step % 4) {
          case 0:
            if (!has(copy)) return false;
            ed.setProp([copy.id], "opacity", 0.5);
            return true;
          case 1:
            if (!has(copy)) return false;
            ed.setProp([copy.id], "fills", [{ type: "solid", color: "#336699" }]);
            return true;
          case 2:
            if (!has(own)) return false;
            ed.resetOverrides([{ id: own.id, props: getProp(own.props, "overrides") }]);
            return true;
          default:
            if (!has(instance) || !canMoveInto(ed.doc, [instance.id], "dark")) return false;
            ed.commit([{ op: "move", id: instance.id, parent: "dark", key: ed.topKey("dark") }]);
            return true;
        }
      };
      act(other);
      const ops = other.sync.takeUnsent();
      if (ops.length === 0) return false;
      // The same edit, made serially on the editor's document as it is now.
      const staleBefore = new Set(unsettled(editor.doc).map(entryKey));
      const serial = makeEditor(editor.doc.stored(), copies);
      // The collaborator's target, where the editor deleted it unsent: no serial order exists
      // (a deleted layer can't be edited), and the two edits collide on that layer.
      const target = [copy, copy, own, instance][step % 4];
      const serialSettled = act(serial)
        ? unsettled(serial.doc)
            .map(entryKey)
            .every((key) => staleBefore.has(key))
        : !!target && ours.has(target.id) && !editor.doc.has(target.id);
      for (const op of ops) {
        theirs.add(op.id);
        if (op.op === "create" || op.op === "move") theirs.add(op.parent);
        const was = editor.doc.get(op.id)?.parent;
        if (op.op === "move" && was) theirs.add(was);
      }
      for (const id of ours) rebased.add(id);
      remote.push(ops);
      revn += 1;
      receive({ t: "txn", revn, ops });
      return serialSettled;
    },
    settle(mirror: Doc, step: string) {
      for (const ops of remote) mirror.applyStored(ops, { held: true });
      editor.sync.flush();
      for (const m of sent.splice(0)) {
        if (m.t !== "txn" || !m.ops) continue;
        try {
          mirror.applyStored(m.ops, { held: true });
          revn += 1;
          receive({ t: "ack", seq: m.seq, revn });
        } catch (error) {
          if (!(error instanceof Error) || error.name !== "ModelError") throw error;
          receive({
            t: "reject",
            seq: m.seq,
            code: (error as { code?: string }).code,
            message: error.message,
            fix: {},
          });
        }
      }
      expect(desync, `no desync ${step}`).toBeNull();
      // A refusal is a real conflict (the edit applies neither as stored nor as presented, as on
      // main): the editor drops it too, and the room and the editor still agree.
      expect(snapshot(mirror), `the room, rebased ${step}`).toEqual(snapshot(editor.doc));
    },
  };
}

describe("an edit leaves the document as a full layout would", () => {
  for (const copies of ["materialized", "compact"] as const)
    it(`with copies ${copies}`, () => {
      const runs = Number(process.env.FUZZ_RUNS) || 40;
      /** How many edits of each kind changed the document. */
      const ran = new Map<Edit["kind"], number>(KINDS.map((k) => [k, 0]));
      fc.assert(
        fc.property(
          tree,
          fc.array(edit, { minLength: 1, maxLength: 16 }),
          fc.boolean(),
          (spec, edits, batched) => {
            const editor = makeEditor(null, copies);
            build(editor, spec);
            const start = editor.doc.stored();
            const mirror = new Doc();
            mirror.resetStored(editor.doc.stored(), copies);
            editor.sync.takeUnsent();
            // Half the runs keep their edits unsent through the whole sequence, as a client does
            // between flushes, while a collaborator's edits arrive and rebase them.
            const room = batched ? connect(editor, start, copies) : null;
            // Issue 294: a collaborator's edits are worked out against their own document, and a
            // rebase lays out nothing, so where they meet edits of the editor's that were unsent
            // when they arrived, layout can be stale. Right after a collaborator's edit lands with
            // unsent edits rebased on it, its staleness is noted as issue 294's only when the same
            // edit, made serially on the editor's document instead, leaves nothing newly stale. A
            // later check sets aside only stale layout all of which was noted then. Anything an
            // edit of the editor's makes stale is checked, and so are runs with no collaborator.
            const fromRebase = new Set<string>();
            const entryId = (o: unknown) => {
              const e = o as Record<string, unknown>;
              return String(e.id ?? e.constrained ?? e.text);
            };
            const ofRebase = (stale: readonly unknown[]) =>
              !!room && stale.length > 0 && stale.every((o) => fromRebase.has(entryId(o)));
            check(editor, mirror, copies, "after making it", undefined, !room);
            const history: string[] = [];
            for (const [step, e] of edits.entries()) {
              // What an undo restores is the document as it was, empty frames' boxes included.
              const undoing = e.kind === "undo" || e.kind === "undo-redo";
              const before = undoing ? undefined : frameStates(editor.doc);
              // A redo lays out what it touches, so a document a collision left stale (issue 294,
              // as above) needn't come back as it was; the round trip is compared everywhere else.
              const roundTrip = e.kind !== "undo-redo" || !ofRebase(unsettled(editor.doc));
              const was = room ? snapshot(editor.doc) : undefined;
              const version = editor.doc.version;
              const concurrent = new Set(
                room ? [...room.rebased].filter((id) => room.theirs.has(id)) : [],
              );
              if (perform(editor, e, roundTrip, concurrent) === "lost") return;
              if (editor.doc.version !== version) ran.set(e.kind, (ran.get(e.kind) ?? 0) + 1);
              history.push(JSON.stringify(e));
              if (room && was) {
                // What it changed, with the frames those were and are in (a layer it deleted, or
                // moved, changed them too).
                const now = snapshot(editor.doc);
                const changed = [...new Set([...Object.keys(was), ...Object.keys(now)])].filter(
                  (id) => stable(was[id]) !== stable(now[id]),
                );
                room.note([
                  ...changed,
                  ...changed
                    .flatMap((id) => [was[id]?.parent, now[id]?.parent])
                    .filter((id): id is string => !!id),
                ]);
              }
              const layout = !ofRebase(unsettled(editor.doc, before));
              check(editor, mirror, copies, `after ${history.join(", ")}`, before, !room, layout);
              if (room && step % 2 === 1) {
                const serialSettled = room.remote(step);
                const stale = unsettled(editor.doc);
                if (stale.length > 0 && room.rebased.size > 0 && serialSettled)
                  for (const o of stale) fromRebase.add(entryId(o));
              }
            }
            if (room) room.settle(mirror, `after ${history.join(", ")}`);
            // Merged back into where it started, as a branch is.
            const mainReader = nodeReader(start);
            const branchReader = nodeReader(editor.doc.stored());
            // Issue 279: a merge can't yet stop an instance with override records being one (it
            // was detached, or its main deleted while it kept its layers): it unsets the instance
            // before its records go, and can't turn a record into a layer of the same id.
            const unlinked = (n: NodeRecord) => {
              if (n.type !== "override") return false;
              const now = branchReader.get(n.id);
              const instance = branchReader.get(n.parent);
              return (
                (now !== undefined && now.type !== "override") ||
                (instance !== undefined && !getProp(instance.props, "instanceOf"))
              );
            };
            if (start.some(unlinked)) return;
            const mainDoc = new Doc();
            mainDoc.resetStored(start, copies);
            const ops: Op[] = mergeOps(
              mainReader,
              branchReader,
              branchChanges(mainReader, branchReader, mainReader),
            );
            if (ops.length > 0) mainDoc.applyStored(ops, { held: true });
            expect(snapshot(mainDoc), `merged as a branch after ${history.join(", ")}`).toEqual(
              snapshot(editor.doc),
            );
          },
        ),
        { numRuns: runs },
      );
      // Each kind of edit did something somewhere: none is refused every time (a value the
      // model doesn't take, a layer it doesn't apply to).
      if (runs >= 40)
        expect(
          KINDS.filter((k) => !ran.get(k)),
          `kinds of edit that never changed the document: ${JSON.stringify(Object.fromEntries(ran))}`,
        ).toEqual([]);
    }, 600_000);
});
