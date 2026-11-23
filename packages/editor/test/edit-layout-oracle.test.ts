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
  getProp,
  keyBetween,
  measuresOn,
  mergeOps,
  type NodeRecord,
  nodeReader,
  type Op,
  type Props,
  placedGeometry,
  ROOT_ID,
} from "@drawpane/model";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { canMoveInto, wouldCycle } from "../src/components";
import { Doc } from "../src/doc";
import { Editor } from "../src/editor";
import { layoutOps } from "../src/layout";
import { autoSize, type TextMeasurer } from "../src/text";

/** A layer's place and size. */
type Box = "x" | "y" | "width" | "height";

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
/** Whether a layer binds a variable whose values differ between modes. */
function bindsByMode(doc: Doc, node: NodeRecord): boolean {
  return Object.values(getProp(node.props, "bindings") as Record<string, unknown>).some((id) => {
    const variable = typeof id === "string" ? doc.get(id) : undefined;
    if (!variable) return typeof id !== "string";
    const values = Object.values(
      (getProp(variable.props, "values") as Record<string, unknown> | undefined) ?? {},
    ).map((v) => JSON.stringify(v));
    return new Set(values).size > 1;
  });
}

/**
 * Issue 306's signature: a layer kept by an instance (above it) whose main is gone, shown in a
 * mode set on it or above it, that binds a variable this mode resolves otherwise: the layer itself,
 * or for what a full layout changes, the frame laying it out or anything in that frame.
 */
function keptInMode(doc: Doc, id: string, inside = false): boolean {
  const above = doc.ancestors(id);
  const orphan = above.find((a) => {
    const main = getProp(a.props, "instanceOf");
    return !!main && !doc.has(main);
  });
  if (!orphan) return false;
  const node = doc.get(id);
  if (!node) return false;
  const moded = (n: NodeRecord) => Object.keys(getProp(n.props, "variableModes")).length > 0;
  if (!moded(node) && !above.some(moded)) return false;
  // A flow places a layer by everything in it, so its frame and all it holds (a sibling hidden by
  // its mode, say) can be the cause.
  const laidOut = inside ? [doc.get(node.parent), ...collectDescendants(doc, node.parent)] : [];
  return [node, ...laidOut].some((n) => !!n && bindsByMode(doc, n));
}

/**
 * Issue 294's layers: those a collaborator's edit, landing as a rebase, moved out of every
 * component (with what's in them). A rebase syncs nothing, so the editor's copies can stay linked to
 * them; only copies of these are set aside.
 */
const stranded = new WeakMap<Doc, Set<string>>();

/**
 * Whether a flow decides a layer's size on one of its own axes, asked of layout itself (not worked
 * out here): a copy of the frame and what's in it (with `mode` as its kind of flow), the layer a
 * little off its size and in the flow, is laid out, and layout writes that size back.
 */
function flowDecides(
  doc: Doc,
  frame: NodeRecord,
  child: NodeRecord,
  prop: "width" | "height",
  mode?: string,
): boolean {
  const layoutMode = mode ?? getProp(frame.props, "layoutMode");
  if (layoutMode === "none") return false;
  const plain = (props: Props) => {
    const {
      instanceOf: _i,
      mirrors: _m,
      overrides: _o,
      bindings: _b,
      ...rest
    } = props as Record<string, unknown>;
    return rest as Props;
  };
  const inside = collectDescendants(doc, frame.id).map((n) => {
    if (n.id !== child.id) return { ...n, props: plain(n.props) };
    const props = { ...plain(n.props), positioning: "auto", [prop]: getProp(n.props, prop) + 7 };
    return { ...n, props: props as Props };
  });
  const scratch = new Doc();
  scratch.resetStored(
    [
      { id: "p", type: "page", parent: ROOT_ID, key: "a0", props: {} },
      {
        ...frame,
        parent: "p",
        key: "a0",
        props: { ...plain(frame.props), layoutMode } as Props,
      },
      ...inside,
    ],
    "materialized",
  );
  return layoutOps(scratch, [frame.id]).some(
    (op) => op.op === "set" && op.id === child.id && op.prop === prop,
  );
}

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
  // what a full layout changes inside one shown in a mode, with bound values, is set aside.
  ops = ops.filter((op) => !keptInMode(doc, op.id, true));
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
  // A copy layer its frame places freely sits where the one derivation both formats use puts it
  // (`placedGeometry`): its constraints' place and size where its frame differs in size from its
  // main's, its main layer's otherwise, but what it keeps (its own layout's, or its own).
  for (const node of all) {
    const sourceId = getProp(node.props, "mirrors");
    const source = sourceId ? doc.get(sourceId) : undefined;
    if (!source) continue;
    const placed = placedGeometry(node, source, doc.get(node.parent), doc.get(source.parent));
    if (!placed) continue;
    const instances = doc.ancestors(node.id).filter((a) => getProp(a.props, "instanceOf"));
    // Issue 306: layers kept by an instance whose main is gone, shown in another mode.
    if (keptInMode(doc, node.id)) continue;
    // Issue 305: an instance sized by a binding, or a swapped nested instance nothing lays out
    // left at a size its main layer no longer has, doesn't place its layers again; their places
    // and sizes are set aside, nothing else.
    if (
      instances.some((a) => {
        const bound = getProp(a.props, "bindings") as Record<string, unknown>;
        if (bound.width || bound.height) return true;
        const layer = doc.get(getProp(a.props, "mirrors") ?? "");
        if (!layer || getProp(a.props, "instanceOf") === getProp(layer.props, "instanceOf"))
          return false;
        const own = getProp(a.props, "overrides");
        if (own.includes("width") || own.includes("height")) return false;
        const frame = doc.get(a.parent);
        const unplaced =
          !getProp(a.props, "visible") ||
          getProp(a.props, "positioning") === "absolute" ||
          !frame ||
          !isLayoutFrame(frame);
        return (
          unplaced &&
          (getProp(a.props, "width") !== getProp(layer.props, "width") ||
            getProp(a.props, "height") !== getProp(layer.props, "height"))
        );
      })
    )
      continue;
    for (const [prop, want] of Object.entries(placed.derived) as [Box, number][]) {
      const have = getProp(node.props, prop);
      // Both are kept to two places: compare them there.
      if (Math.round(Math.abs(want - have) * 100) > 1)
        out.push({ constrained: node.id, prop, have, want });
    }
  }
  // Independently of that derivation, a product rule: a copy layer of its own fixed size that
  // nothing resizes (no override of its size or sizing, no binding, not swapped, not measuring
  // itself, not sized by a flow, its own, its main layer's or one it left, and placed freely, no
  // Stretch or Scale on that axis) has its main layer's size.
  for (const node of all) {
    const source = doc.get(getProp(node.props, "mirrors") ?? "");
    if (!source || source.type !== node.type || node.type === "group") continue;
    const parent = doc.get(node.parent);
    const parentSource = doc.get(source.parent);
    if (!parent || !parentSource || parent.type !== "frame") continue;
    const free =
      getProp(parent.props, "layoutMode") === "none" ||
      getProp(node.props, "positioning") === "absolute";
    const shown = getProp(node.props, "instanceOf");
    if (shown && shown !== getProp(source.props, "instanceOf")) continue;
    if (keptInMode(doc, node.id)) continue;
    // Issue 294: a rebase syncs nothing either, so over a collaborator's move of a layer out of a
    // main, the editor's copies stay linked to a layer no main holds any more.
    if (
      stranded.get(doc)?.has(source.id) &&
      !doc.ancestors(source.id).some((a) => getProp(a.props, "isComponent"))
    )
      continue;
    const own = getProp(node.props, "overrides");
    const bound = getProp(node.props, "bindings") as Record<string, unknown>;
    for (const axis of ["h", "v"] as const) {
      const [size, sizing, constraint] =
        axis === "h"
          ? (["width", "sizingH", "constraintH"] as const)
          : (["height", "sizingV", "constraintV"] as const);
      if (getProp(node.props, sizing) !== "fixed" || getProp(source.props, sizing) !== "fixed")
        continue;
      if (own.includes(size) || own.includes(sizing) || bound[size]) continue;
      // Bound in its main layer: it resolves by mode, or it's the copy's own once taken off.
      if ((getProp(source.props, "bindings") as Record<string, unknown>)[size]) continue;
      if (measuresOn(node, axis)) continue;
      const c = getProp(node.props, constraint);
      if (free && (c === "stretch" || c === "scale")) continue;
      const have = getProp(node.props, size);
      const want = getProp(source.props, size);
      if (Math.round(Math.abs(want - have) * 100) <= 1) continue;
      // A size a flow gave is the flow's, not the layer's own: its own flow, the one it left (a
      // frame that took its auto layout away had its main frame's kind), or its main layer's.
      const flowMode = getProp(parent.props, "layoutMode");
      if (
        flowDecides(
          doc,
          parent,
          node,
          size,
          flowMode !== "none" ? flowMode : getProp(parentSource.props, "layoutMode"),
        )
      )
        continue;
      if (
        getProp(source.props, "positioning") !== "absolute" &&
        flowDecides(doc, parentSource, source, size)
      )
        continue;
      out.push({ inherits: node.id, prop: size, have, want });
    }
  }
  for (const node of all) {
    if (node.type !== "text") continue;
    // Issue 306: text kept by an instance whose main is gone isn't measured again in another mode.
    if (keptInMode(doc, node.id)) continue;
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
 * How `after` differs from `before`, less what known issues explain, each
 * by its own signature: #281, a materialized layer (a copy layer or an
 * instance) only moved or resized by the redo; #290, a layer only moved or
 * resized in a flow holding a group with an absolute member; #310, a Fill
 * layer in a grid only moved or resized.
 */
function unexplained(before: Snapshot, after: Snapshot, doc: Doc): string[] {
  const out: string[] = [];
  for (const id of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const was = before[id];
    const now = after[id];
    if (stable(was) === stable(now)) continue;
    const source = was && getProp(was.props, "mirrors");
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

/** Every layer as presented, and every record as stored (variables and styles included). */
function everything(doc: Doc): Snapshot {
  const out: Snapshot = { ...snapshot(doc) };
  for (const node of doc.stored())
    out[`stored:${node.id}`] = {
      parent: node.parent,
      key: node.key,
      type: node.type,
      props: node.props,
    };
  return out;
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

/**
 * What issue 294's fix will do, done here: lays the editor's document out where a rebase left it
 * stale (what a full layout changes, text measured, copies placed by `placedGeometry`), as the
 * editor's own unsent fix-up, outside its undo history.
 */
function layOutRebase(editor: Editor): void {
  for (let round = 0; round < 4; round++) {
    const ops: Op[] = [];
    for (const entry of unsettled(editor.doc)) {
      const e = entry as Record<string, unknown>;
      if (e.op === "set") ops.push(entry as Op);
      else if (e.constrained || e.inherits)
        ops.push({
          op: "set",
          id: String(e.constrained ?? e.inherits),
          prop: e.prop as "x",
          value: e.want as number,
        });
      else if (e.text) {
        const prop = e.width ? "width" : "height";
        const value = (e[prop] as number[])[1] as number;
        ops.push({ op: "set", id: String(e.text), prop, value });
      }
    }
    if (ops.length === 0) return;
    editor.sync.commit(ops);
  }
}

/** A stale entry's layer and what about it is stale, to tell two checks' entries apart. */
function entryKey(o: unknown): string {
  const e = o as Record<string, unknown>;
  return `${String(e.id ?? e.constrained ?? e.inherits ?? e.text)}:${String(e.prop ?? (e.width ? "width" : "height"))}`;
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
  /** Layers the editor's edits changed, and the frames around them, all unsent until `settle`. */
  const ours = new Set<string>();
  /** Of those, the layers the editor's edits changed themselves (not the frames around them). */
  const oursOwn = new Set<string>();
  /**
   * Layers a collaborator's edit changed while an edit of the editor's to the same layer was
   * still pending: the two met in a rebase. An edit either side makes after the other's arrived
   * is serial, and isn't here.
   */
  const overlapped = new Set<string>();
  return {
    /**
     * Copy and instance layers both sides changed concurrently, meeting in a rebase (issue 307's:
     * their override marks can collide).
     */
    concurrent(): Set<string> {
      return new Set(
        [...overlapped].filter((id) => {
          const node = editor.doc.get(id);
          return (
            !!node && (!!getProp(node.props, "mirrors") || !!getProp(node.props, "instanceOf"))
          );
        }),
      );
    },
    /** Records layers an edit of the editor's changed, and the frames they were and are in. */
    note(changed: Iterable<string>, frames: Iterable<string>) {
      for (const id of changed) {
        ours.add(id);
        oursOwn.add(id);
      }
      for (const id of frames) ours.add(id);
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
      // Only edits of the editor's still pending meet this one in the rebase.
      if (editor.sync.pendingCount > 0)
        for (const op of ops) if (oursOwn.has(op.id)) overlapped.add(op.id);
      const inComponent = (id: string) =>
        [editor.doc.get(id), ...editor.doc.ancestors(id)].some(
          (a) => !!a && !!getProp(a.props, "isComponent"),
        );
      const moving = ops
        .filter((op) => op.op === "move" && editor.doc.has(op.id) && inComponent(op.id))
        .map((op) => op.id);
      remote.push(ops);
      revn += 1;
      receive({ t: "txn", revn, ops });
      // What the rebase moved out of every component (issue 294's layers, above).
      for (const id of moving) {
        if (!editor.doc.has(id) || inComponent(id)) continue;
        const set = stranded.get(editor.doc) ?? new Set<string>();
        for (const n of [editor.doc.get(id), ...collectDescendants(editor.doc, id)])
          if (n) set.add(n.id);
        stranded.set(editor.doc, set);
      }
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
            // rebase lays out nothing, so where they meet operations of the editor's still pending
            // when they arrived, layout can be stale. Right after a collaborator's edit lands with
            // pending operations rebased on it, its staleness is issue 294's when the same edit, made
            // serially on the editor's document instead, leaves nothing newly stale. Then the
            // editor lays it out there (as the fix will), and every check after stays strict: what
            // the collaborator's edit itself, or an edit of the editor's, leaves stale fails.
            check(editor, mirror, copies, "after making it", undefined, !room);
            const history: string[] = [];
            for (const [step, e] of edits.entries()) {
              // What an undo restores is the document as it was, empty frames' boxes included.
              const undoing = e.kind === "undo" || e.kind === "undo-redo";
              const before = undoing ? undefined : frameStates(editor.doc);
              const was = room ? everything(editor.doc) : undefined;
              const version = editor.doc.version;
              const concurrent = room ? room.concurrent() : new Set<string>();
              if (perform(editor, e, true, concurrent) === "lost") return;
              if (editor.doc.version !== version) ran.set(e.kind, (ran.get(e.kind) ?? 0) + 1);
              history.push(JSON.stringify(e));
              if (room && was) {
                // What it changed (layers, and records that aren't layers: a variable, a style),
                // with the frames those were and are in (a layer it deleted, or moved, changed them
                // too).
                const now = everything(editor.doc);
                const changed = [...new Set([...Object.keys(was), ...Object.keys(now)])].filter(
                  (id) => stable(was[id]) !== stable(now[id]),
                );
                room.note(
                  changed,
                  changed
                    .flatMap((id) => [was[id]?.parent, now[id]?.parent])
                    .filter((id): id is string => !!id),
                );
              }
              check(editor, mirror, copies, `after ${history.join(", ")}`, before, !room);
              if (room && step % 2 === 1) {
                // A rebase replays the editor's pending operations (even ones that net to no change,
                // as an undo and redo do) over the collaborator's edit.
                const rebasing = editor.sync.pendingCount > 0;
                const serialSettled = room.remote(step);
                if (rebasing && serialSettled) layOutRebase(editor);
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

// The oracle's own checks: each known issue's waiver covers its signature only, and the product
// rules hold on their own (PR 286's fifth re-check).
describe("the oracle's checks and waivers", () => {
  it("reports an instance whose main is gone that only moved (no #280 waiver)", () => {
    const editor = makeEditor(null, "compact");
    const before: Snapshot = {
      orphan: {
        parent: "p",
        type: "frame",
        key: "a0",
        props: { instanceOf: "missing", x: 1, width: 100, height: 40 } as Props,
      },
    };
    const after: Snapshot = {
      orphan: {
        ...(before.orphan as Snapshot[string]),
        props: { ...before.orphan?.props, x: 500 },
      },
    };
    expect(unexplained(before, after, editor.doc)).toEqual(["orphan"]);
  });

  for (const copies of ["materialized", "compact"] as const)
    it(`checks a fixed copy taken out of its flow against its main layer's size, with copies ${copies}`, () => {
      const editor = makeEditor(null, copies);
      editor.commit([
        {
          op: "create",
          id: "main",
          type: "frame",
          parent: "p",
          key: "a0",
          props: { isComponent: true, width: 160, height: 80, layoutMode: "row" },
        },
        {
          op: "create",
          id: "rect",
          type: "rect",
          parent: "main",
          key: "a0",
          props: { width: 60, height: 20 },
        },
      ]);
      const instance = editor.insertInstance("main", { x: 5000, y: 5000 }) as string;
      const rect = editor.doc.childIds(instance)[0] as string;
      editor.setProp([rect], "positioning", "absolute");
      editor.resize(["rect"], "width", 90);
      expect(getProp(editor.doc.get(rect)?.props ?? {}, "width")).toBe(90);
      expect(unsettled(editor.doc)).toEqual([]);
      // The rule stands on its own: a copy left at its old size is reported.
      editor.sync.commit([{ op: "set", id: rect, prop: "width", value: 60 }]);
      expect(unsettled(editor.doc)).toContainEqual({
        inherits: rect,
        prop: "width",
        have: 60,
        want: 90,
      });
    });

  it("reports auto-size drift for visible, unbound text kept by an instance whose main is gone", () => {
    const editor = makeEditor(
      [
        { id: "p", type: "page", parent: ROOT_ID, key: "a0", props: {} },
        {
          id: "orphan",
          type: "frame",
          parent: "p",
          key: "a0",
          props: { instanceOf: "missing", width: 160, height: 80 },
        },
        {
          id: "label",
          type: "text",
          parent: "orphan",
          key: "a0",
          props: {
            characters: "A longer visible label",
            textAutoResize: "width",
            width: 10,
            height: 20,
          },
        },
      ],
      "materialized",
    );
    expect(unsettled(editor.doc)).toContainEqual({ text: "label", width: [10, 176] });
  });

  for (const copies of ["compact", "materialized"] as const)
    it(`checks the constrained layer of a resized nested instance, with copies ${copies}`, () => {
      const editor = makeEditor(null, copies);
      editor.commit([
        {
          op: "create",
          id: "leaf",
          type: "frame",
          parent: "p",
          key: "a0",
          props: { isComponent: true, width: 100, height: 60 },
        },
        {
          op: "create",
          id: "dot",
          type: "rect",
          parent: "leaf",
          key: "a0",
          props: { x: 10, y: 10, width: 20, height: 20, constraintH: "end" },
        },
        {
          op: "create",
          id: "outside",
          type: "frame",
          parent: "p",
          key: "a1",
          props: { isComponent: true, width: 200, height: 100 },
        },
      ]);
      const nested = editor.insertInstance("leaf", { x: 5000, y: 5000 }) as string;
      expect(editor.commit([{ op: "move", id: nested, parent: "outside", key: "a0" }])).toBe(true);
      const root = editor.insertInstance("outside", { x: 8000, y: 8000 }) as string;
      const copy = editor.doc.childIds(root)[0] as string;
      editor.resize([copy], "width", 140);
      const layer = editor.doc.childIds(copy)[0] as string;
      expect(getProp(editor.doc.get(layer)?.props ?? {}, "x")).toBe(50);
      editor.sync.commit([{ op: "set", id: layer, prop: "x", value: 10 }]);
      expect(unsettled(editor.doc)).toContainEqual({
        constrained: layer,
        prop: "x",
        have: 10,
        want: 50,
      });
    });

  for (const copies of ["materialized", "compact"] as const)
    it(`waives #306 only for a layer that binds a variable its mode resolves otherwise, with copies ${copies}`, () => {
      const nodes = (labelBinds: boolean): NodeRecord[] => [
        { id: "p", type: "page", parent: ROOT_ID, key: "a0", props: {} },
        {
          id: "modes",
          type: "collection",
          parent: ROOT_ID,
          key: "a0",
          props: {
            modes: [
              { id: "light", name: "Light" },
              { id: "dark", name: "Dark" },
            ],
          },
        },
        {
          id: "num",
          type: "variable",
          parent: "modes",
          key: "a0",
          props: { variableType: "number", values: { light: 20, dark: 20 } },
        },
        {
          id: "words",
          type: "variable",
          parent: "modes",
          key: "a1",
          props: {
            variableType: "string",
            values: { light: "Short", dark: "A longer visible label" },
          },
        },
        {
          id: "orphan",
          type: "frame",
          parent: "p",
          key: "a0",
          props: {
            instanceOf: "missing",
            variableModes: { modes: "dark" },
            width: 160,
            height: 80,
          },
        },
        {
          id: "label",
          type: "text",
          parent: "orphan",
          key: "a0",
          props: {
            characters: "A longer visible label",
            textAutoResize: "width",
            width: 10,
            height: 20,
            ...(labelBinds ? { bindings: { characters: "words" } } : {}),
          },
        },
        // A sibling bound to a variable worth the same in both modes explains nothing.
        {
          id: "unrelated",
          type: "rect",
          parent: "orphan",
          key: "a1",
          props: { width: 20, height: 20, bindings: { width: "num" } },
        },
      ];
      const unbound = makeEditor(nodes(false), copies);
      expect(keptInMode(unbound.doc, "label")).toBe(false);
      expect(unsettled(unbound.doc)).toContainEqual({ text: "label", width: [10, 176] });
      const bound = makeEditor(nodes(true), copies);
      expect(keptInMode(bound.doc, "label")).toBe(true);
    });

  it("waives #294 only for a copy whose main layer a rebase moved out of its component", () => {
    const editor = makeEditor(null, "materialized");
    expect(
      editor.commit([
        {
          op: "create",
          id: "main",
          type: "frame",
          parent: "p",
          key: "a0",
          props: { isComponent: true, layoutMode: "row", width: 160, height: 80 },
        },
        {
          op: "create",
          id: "rect",
          type: "rect",
          parent: "main",
          key: "a0",
          props: { width: 60, height: 20 },
        },
      ]),
    ).toBe(true);
    const instance = editor.insertInstance("main", { x: 5000, y: 5000 }) as string;
    const rect = editor.doc.childIds(instance)[0] as string;
    editor.sync.takeUnsent();
    editor.sync.commit([{ op: "set", id: rect, prop: "width", value: 20 }]);
    const stale = { inherits: rect, prop: "width", have: 20, want: 60 };
    expect(unsettled(editor.doc)).toContainEqual(stale);
    // The main layer moved out of its component by a plain local edit: no rebase, no waiver.
    editor.sync.commit([{ op: "move", id: "rect", parent: "p", key: editor.topKey("p") }]);
    expect(editor.doc.get(rect)).toBeDefined();
    expect(unsettled(editor.doc)).toContainEqual(stale);
  });

  it("counts as concurrent (#307) only edits that met in a rebase", () => {
    const copies = "materialized";
    const editor = makeEditor(null, copies);
    editor.commit([
      {
        op: "create",
        id: "main",
        type: "frame",
        parent: "p",
        key: "a0",
        props: { isComponent: true, width: 160, height: 80 },
      },
      {
        op: "create",
        id: "rect",
        type: "rect",
        parent: "main",
        key: "a0",
        props: { width: 60, height: 20 },
      },
      {
        op: "create",
        id: "dark",
        type: "frame",
        parent: "p",
        key: "a1",
        props: { width: 320, height: 120 },
      },
    ]);
    const instance = editor.insertInstance("main", { x: 5000, y: 5000 }) as string;
    const rect = editor.doc.childIds(instance)[0] as string;
    const initial = editor.doc.stored();
    editor.sync.takeUnsent();
    const room = connect(editor, initial, copies);
    // The collaborator fills the copy while the editor has nothing pending.
    room.remote(1);
    expect(editor.sync.pendingCount).toBe(0);
    // Then the editor changes it, after seeing that fill, and the collaborator moves the root.
    editor.setProp([rect], "opacity", 0.3);
    room.note([rect], [instance]);
    room.remote(3);
    expect(editor.doc.get(instance)?.parent).toBe("dark");
    expect(room.concurrent().has(rect)).toBe(false);
    // An edit of the collaborator's to the same copy (its opacity) while the editor's is pending
    // does meet it.
    room.remote(4);
    expect(room.concurrent().has(rect)).toBe(true);
  });
});
