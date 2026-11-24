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
  frozenFrame,
  getProp,
  hugsOn,
  isPropName,
  keyBetween,
  measuresOn,
  mergeOps,
  type NodeRecord,
  nodeReader,
  type Op,
  PLACED_INPUTS,
  type Props,
  placedGeometry,
  ROOT_ID,
} from "@drawpane/model";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { canMoveInto, propagationOps, wouldCycle } from "../src/components";
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
/**
 * Issue 306's place: a layer kept by an instance (above it) whose main is gone, shown in a mode set
 * on it or above it. Kept layers there aren't laid out or measured again in that mode.
 */
function orphanInMode(doc: Doc, id: string): boolean {
  const above = doc.ancestors(id);
  if (
    !above.some(
      (a) => !!getProp(a.props, "instanceOf") && !doc.has(getProp(a.props, "instanceOf") as string),
    )
  )
    return false;
  const node = doc.get(id);
  const moded = (n: NodeRecord) => Object.keys(getProp(n.props, "variableModes")).length > 0;
  return (!!node && moded(node)) || above.some(moded);
}

/**
 * What issue 306 predicts: the document as it would be with no mode set anywhere (every variable at
 * its first mode's value), where kept layers were laid out and measured. A value #306 left stale is
 * that document's own; any other wrong value is reported.
 */
function modeless(doc: Doc): Doc {
  const out = new Doc();
  out.resetStored(
    doc.stored().map((n) => {
      const { variableModes: _modes, ...props } = n.props as Record<string, unknown>;
      return { ...n, props: props as Props };
    }),
    doc.compactCopies ? "compact" : "materialized",
  );
  return out;
}

/**
 * Issue 294's copies: those linked to layers a collaborator's edit, landing as a rebase over the
 * editor's pending edits, moved out of every component, with the place and size each had then. A
 * rebase syncs nothing, so they stay as they were; only a copy still at exactly that is set aside.
 */
const stranded = new WeakMap<Doc, Map<string, Record<"x" | "y" | "width" | "height", number>>>();

/**
 * Issue 323: once an instance holding a nested instance is detached, materialized copies of the
 * nested one stay linked to the old main's copies, outside every instance of that main, so what
 * they'd take through that link is set aside (compact copies relink).
 */
function detachedLink(doc: Doc, node: NodeRecord): boolean {
  if (doc.compactCopies) return false;
  const source = doc.get(getProp(node.props, "mirrors") ?? "");
  if (!source) return false;
  const main = [source, ...doc.ancestors(source.id)].find((a) => getProp(a.props, "isComponent"));
  return (
    !!main &&
    !doc
      .ancestors(node.id)
      .some((a) => a.id === main.id || getProp(a.props, "instanceOf") === main.id)
  );
}

/**
 * The flow each frame had just before an edit took it away (its own direction and alignment, which
 * an instance can set otherwise than its main): what its layers were sized by, for the rule that
 * checks sizes on its own.
 */
const flowsLeft = new WeakMap<Doc, Map<string, Partial<Props>>>();

/** Notes the flow a frame has now, before an edit takes it away. */
function noteFlow(doc: Doc, id: string): void {
  const frame = doc.get(id);
  if (!frame || getProp(frame.props, "layoutMode") === "none") return;
  const seen = flowsLeft.get(doc) ?? new Map<string, Partial<Props>>();
  seen.set(id, {
    layoutMode: getProp(frame.props, "layoutMode"),
    alignItems: getProp(frame.props, "alignItems"),
    justifyItems: getProp(frame.props, "justifyItems"),
  });
  flowsLeft.set(doc, seen);
}

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
  // Issue 306's prediction (`modeless`), made only when a kept layer is wrong.
  let light: Doc | undefined;
  const lit = () => {
    light ??= modeless(doc);
    return light;
  };
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
    // Applied as the editor commits them: they name copy layers too, which compact copies store
    // as override records made for them.
    const scratch = makeEditor(doc.stored(), doc.compactCopies ? "compact" : "materialized");
    scratch.sync.commit(ops);
    const again = scratch.doc;
    if (layoutOps(again, frames, { shrinkEmpty, keepEmpty }).some(swings))
      ops = ops.filter((op) => !swings(op));
  }
  // Issue 306: layers kept by an instance whose main is gone aren't laid out in another mode. What
  // a full layout changes in one is set aside only where the value is exactly what laying it out
  // with no mode set gives (what #306 leaves); any other is reported.
  if (ops.some((op) => orphanInMode(doc, op.id))) {
    const settledLight = layoutOps(lit(), frames, { shrinkEmpty, keepEmpty });
    ops = ops.filter((op) => {
      if (op.op !== "set" || !orphanInMode(doc, op.id)) return true;
      const now = getProp(doc.get(op.id)?.props ?? {}, op.prop);
      const relaid = settledLight.find(
        (o) => o.op === "set" && o.id === op.id && o.prop === op.prop,
      );
      const predicted =
        relaid?.op === "set" ? relaid.value : getProp(lit().get(op.id)?.props ?? {}, op.prop);
      return !sameNumber(now, predicted);
    });
  }
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
    // Issue 306: in a kept layer shown in another mode, set aside only a place or size that is what
    // the derivation gives with no mode set.
    const lightPlaced = (prop: Box): number | undefined => {
      if (!orphanInMode(doc, node.id)) return undefined;
      const n = lit().get(node.id);
      const src = lit().get(source.id);
      if (!n || !src) return undefined;
      return placedGeometry(n, src, lit().get(n.parent), lit().get(src.parent))?.derived[prop];
    };
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
      if (Math.round(Math.abs(want - have) * 100) <= 1) continue;
      if (sameNumber(have, lightPlaced(prop))) continue;
      if (detachedLink(doc, node)) continue;
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
    // Issue 294: a rebase syncs nothing either, so over a collaborator's move of a layer out of a
    // main, the editor's copies stay linked to a layer no main holds any more, as they were then.
    const stale = stranded.get(doc)?.get(node.id);
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
      // A layer the flow of a frozen frame placed: its box is its own (a file from before).
      if (flows(node) && frozenFrame(parent, parentSource)) continue;
      const c = getProp(node.props, constraint);
      if (free && (c === "stretch" || c === "scale")) continue;
      const have = getProp(node.props, size);
      const want = getProp(source.props, size);
      if (Math.round(Math.abs(want - have) * 100) <= 1) continue;
      // A size a flow gave is the flow's, not the layer's own: its own flow, the one it left (a
      // frame that took its auto layout away had its main frame's kind), or its main layer's.
      // The flow it left is the frame's own as it was before (`flowsLeft`), not its main's now.
      const flowMode = getProp(parent.props, "layoutMode");
      const left = flowMode === "none" ? flowsLeft.get(doc)?.get(parent.id) : undefined;
      if (
        flowDecides(
          doc,
          left ? { ...parent, props: { ...parent.props, ...left } as Props } : parent,
          node,
          size,
          flowMode !== "none"
            ? flowMode
            : (left?.layoutMode ?? getProp(parentSource.props, "layoutMode")),
        )
      )
        continue;
      if (
        getProp(source.props, "positioning") !== "absolute" &&
        flowDecides(doc, parentSource, source, size)
      )
        continue;
      if (stale && sameNumber(have, stale[size])) continue;
      if (detachedLink(doc, node)) continue;
      // Issue 306: a kept layer shown in another mode, at its main layer's size with no mode set.
      if (
        orphanInMode(doc, node.id) &&
        sameNumber(have, getProp(lit().get(source.id)?.props ?? {}, size))
      )
        continue;
      out.push({ inherits: node.id, prop: size, have, want });
    }
  }
  for (const node of all) {
    if (node.type !== "text") continue;
    const size = autoSize(node, measurer);
    if (!size) continue;
    const r = (v: number) => Math.round(v * 100) / 100;
    // Issue 306: text kept by an instance whose main is gone isn't measured again in another mode;
    // set aside only a size that is what it measures with no mode set.
    const lightNode = orphanInMode(doc, node.id) ? lit().get(node.id) : undefined;
    const lightSize = lightNode ? autoSize(lightNode, measurer) : undefined;
    const stale = (prop: "width" | "height") =>
      !!lightSize && r(lightSize[prop]) === r(getProp(node.props, prop));
    // A bound size is its variable's, whatever the text measures (decision 0034).
    const bound = getProp(node.props, "bindings");
    if (!bound.width && r(size.width) !== r(getProp(node.props, "width")) && !stale("width"))
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
    if (
      !bound.height &&
      !wrapped &&
      r(size.height) !== r(getProp(node.props, "height")) &&
      !stale("height")
    )
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
    // The same values, one of them written out at its default (a compact swap's redo writes a
    // copy's x as 0 where it read 0 before): nothing anyone sees, or the room stores, differs.
    if (was && now && sameReading(was, now)) continue;
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

/** Whether two states of a layer read the same, property by property, defaults included. */
function sameReading(a: Snapshot[string], b: Snapshot[string]): boolean {
  if (a.parent !== b.parent || a.key !== b.key || a.type !== b.type) return false;
  for (const prop of new Set([...Object.keys(a.props), ...Object.keys(b.props)])) {
    if (!isPropName(prop)) return false;
    if (stable(getProp(a.props, prop)) !== stable(getProp(b.props, prop))) return false;
  }
  return true;
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
        : e.kind === "reset-all"
          ? // Only an instance with something to reset (an override of its own or in a layer),
            // so a run's resets reset something.
            (n: NodeRecord) =>
              isInstance(n) &&
              [n, ...collectDescendants(doc, n.id)].some(
                (k) => getProp(k.props, "overrides").length > 0,
              )
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
    case "layoutMode": {
      // Taking a frame's auto layout away leaves its layers where and as big as the layout made
      // them (Figma), checked on its own terms: their boxes from before.
      const boxes =
        e.value === "none" && getProp(node.props, "layoutMode") !== "none"
          ? doc.childIds(id).map((c) => [c, boxOf(doc, c)] as const)
          : [];
      const frameWas = boxOf(doc, id);
      if (e.value === "none") noteFlow(doc, id);
      editor.setLayoutMode([id], e.value);
      // Where the frame keeps its own box: a flow around it can resize it too (a Fill frame whose
      // content no longer sizes it), and then its constraints move what's in it (#321).
      if (
        getProp(doc.get(id)?.props ?? {}, "layoutMode") === "none" &&
        JSON.stringify(boxOf(doc, id)) === JSON.stringify(frameWas)
      )
        for (const [c, was] of boxes) expectKept(doc, id, c, was);
      break;
    }
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

/**
 * Taking a frame's auto layout away left a layer where and as big as the layout made it (Figma),
 * but for a size it gives itself (text that measures itself, a frame that hugs), which is its own
 * again once no flow sizes it.
 */
function expectKept(doc: Doc, frame: string, id: string, was: readonly number[]): void {
  const node = doc.get(id);
  if (!node) return;
  const own = [
    false,
    false,
    measuresOn(node, "h") || hugsOn(node, "h"),
    measuresOn(node, "v") || hugsOn(node, "v"),
  ];
  const keep = (box: readonly number[]) => box.map((v, i) => (own[i] ? null : v));
  expect(keep(boxOf(doc, id)), `taking ${frame}'s auto layout away keeps ${id}`).toEqual(keep(was));
}

/** Whether two values are the same number to two places. */
function sameNumber(a: unknown, b: unknown): boolean {
  return typeof a === "number" && typeof b === "number" && Math.round(Math.abs(a - b) * 100) <= 1;
}

/** A layer's place and size, to two places. */
function boxOf(doc: Doc, id: string): number[] {
  const props = doc.get(id)?.props ?? {};
  return (["x", "y", "width", "height"] as const).map(
    (prop) => Math.round(getProp(props, prop) * 100) / 100,
  );
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

// ---------------------------------------------------------------------------
// Ownership (PR 286's design memo, section 4). Each invariant holds by construction, so a failure
// is a bug, never a waiver: no edit marks what it doesn't name (1), a frozen frame's layers stay
// as they were (2, on files from before), an edit moves only copies it reaches (3), copies
// elsewhere are derived (4, `unsettled`), no edit makes a frame frozen (5), receiving writes
// nothing (6), and every replica ends where the room does (7, "three clients converge").

/** What an editor's edits commit: the operations given to `commit`, and everything stored. */
interface Recorder {
  readonly user: Op[];
  readonly stored: Op[];
  receiving: boolean;
  receiptWrites: number;
}
const recorders = new WeakMap<Editor, Recorder>();

function recorder(editor: Editor): Recorder {
  const seen = recorders.get(editor);
  if (seen) return seen;
  const rec: Recorder = { user: [], stored: [], receiving: false, receiptWrites: 0 };
  const commit = editor.commit.bind(editor);
  editor.commit = (ops, label, options) => {
    rec.user.push(...ops);
    return commit(ops, label, options);
  };
  const sync = editor.sync;
  const syncCommit = sync.commit.bind(sync);
  sync.commit = (ops) => {
    if (rec.receiving) rec.receiptWrites++;
    const inverse = syncCommit(ops);
    rec.stored.push(...editor.doc.lastStoredOps);
    return inverse;
  };
  const receive = sync.receive.bind(sync);
  sync.receive = (message) => {
    rec.receiving = true;
    try {
      receive(message);
    } finally {
      rec.receiving = false;
    }
  };
  recorders.set(editor, rec);
  return rec;
}

/** The frames that are frozen (`frozenFrame`): only a file from before holds one. */
function frozenFrames(doc: Doc): Set<string> {
  const out = new Set<string>();
  for (const node of layers(doc)) {
    if (node.type !== "frame") continue;
    const shown = getProp(node.props, "instanceOf") ?? getProp(node.props, "mirrors");
    if (shown && frozenFrame(node, doc.get(shown))) out.add(node.id);
  }
  return out;
}

const copyOf = (node: NodeRecord): NodeRecord => ({ ...node, props: { ...node.props } });
const BOXES = ["x", "y", "width", "height"] as const;

/**
 * Watches one edit for invariants 1, 3 and 5, and for option 1 (PR 286): no operation the edit
 * derives deletes an override record. Undo and redo replay what was recorded, so only 3's
 * converse (5) is asked of them... none of the others.
 */
function watchEdit(editor: Editor): (undoing: boolean) => unknown[] {
  const doc = editor.doc;
  const rec = recorder(editor);
  rec.user.length = 0;
  rec.stored.length = 0;
  const before = new Map(layers(doc).map((node) => [node.id, copyOf(node)] as const));
  const frozen = frozenFrames(doc);
  /**
   * Override records, by id, to what they hang on: the instance they're stored under, the main
   * layers their path names, and the main they swap their layer to.
   */
  const records = new Map(
    doc.compactCopies
      ? doc
          .stored()
          .filter((r) => r.type === "override")
          .map(
            (r) =>
              [
                r.id,
                [r.parent, ...getProp(r.props, "path"), getProp(r.props, "instanceOf")].filter(
                  (id): id is string => !!id,
                ),
              ] as const,
          )
      : [],
  );
  return (undoing) => {
    if (undoing) return [];
    const out: unknown[] = [];
    const after = new Map(layers(doc).map((node) => [node.id, node] as const));
    // What the edit's own operations name: each layer, and each property set on it.
    const named = new Map<string, Set<string>>();
    const name = (id: string, prop = "") => {
      const set = named.get(id) ?? new Set<string>();
      if (prop) set.add(prop);
      named.set(id, set);
    };
    for (const op of rec.user) {
      name(op.id, op.op === "set" ? op.prop : "");
      if (op.op === "create" || op.op === "move") name(op.parent);
    }
    const ancestors = (id: string, map: ReadonlyMap<string, NodeRecord>) => {
      const list: string[] = [];
      for (let node = map.get(id); node; node = map.get(node.parent)) list.push(node.id);
      return list;
    };
    // 5. No entry.
    for (const id of frozenFrames(doc)) if (!frozen.has(id)) out.push({ madeFrozen: id });
    // 1. No marks: overrides gain a key only where the edit set it, or on what a main's delete
    // left (its instances keep its layers, as their own).
    for (const [id, node] of after) {
      const was = before.get(id);
      if (!was) continue;
      const had = getProp(was.props, "overrides");
      for (const prop of getProp(node.props, "overrides")) {
        if (had.includes(prop) || named.get(id)?.has(prop)) continue;
        if (named.has(id) && CONSEQUENT_MARKS.has(prop)) continue;
        if (rec.user.some((op) => op.op === "delete") && orphaned(doc, node)) continue;
        // A detach, swap or relink of what holds it: the nested instances it keeps hold what
        // they showed as their own (as a main's delete keeps them).
        const holders = new Set([...ancestors(id, before), ...ancestors(id, after)]);
        if (
          rec.user.some(
            (op) =>
              op.op === "set" &&
              (op.prop === "instanceOf" || op.prop === "mirrors") &&
              holders.has(op.id),
          )
        )
          continue;
        out.push({ marked: id, prop });
      }
    }
    // Option 1: an override record goes only by an edit that names its layer's removal (a
    // delete of it or what holds it, a swap or detach of an instance holding it).
    for (const op of rec.stored) {
      if (op.op !== "delete" || !records.has(op.id)) continue;
      // What holds it: what it's in, and what that copies (a main layer deleted takes its copies,
      // a main deleted or swapped away its instances' records), however nested.
      const holders = new Set<string>();
      // A record whose layer isn't presented now (one its main no longer has) still hangs on its
      // instance, the main layers its path names, and the main it swaps to.
      const queue = [op.id, ...(records.get(op.id) ?? [])];
      for (let id = queue.pop(); id !== undefined; id = queue.pop())
        for (const at of ancestors(id, before)) {
          if (holders.has(at)) continue;
          holders.add(at);
          const props = before.get(at)?.props ?? {};
          for (const linked of [getProp(props, "mirrors"), getProp(props, "instanceOf")])
            if (linked && !holders.has(linked)) queue.push(linked);
        }
      const removes = rec.user.some(
        (u) =>
          holders.has(u.id) &&
          (u.op === "delete" ||
            (u.op === "set" &&
              (u.prop === "instanceOf" || u.prop === "mirrors" || u.prop === "isComponent"))),
      );
      if (!removes) out.push({ deletedRecord: op.id });
    }
    // 3. Locality: a copy's box changes only if the edit names it, a flow (or its own layout)
    // lays it out, or something the derivation reads changed on it, its main layer, its frame or
    // that frame's main layer.
    for (const [id, node] of after) {
      const was = before.get(id);
      if (!was || !getProp(node.props, "mirrors")) continue;
      if (BOXES.every((k) => sameNumber(getProp(was.props, k), getProp(node.props, k)))) continue;
      if (named.has(id)) continue;
      if (laidOut(doc, before, was) || laidOut(doc, after, node)) continue;
      if (inputsChanged(before, after, was, node)) continue;
      out.push({
        moved: id,
        was: BOXES.map((k) => getProp(was.props, k)),
        now: BOXES.map((k) => getProp(node.props, k)),
      });
    }
    return out;
  };
}

/** Marks the editor makes with a person's set on the same layer (a binding or style it detaches). */
const CONSEQUENT_MARKS: ReadonlySet<string> = new Set(["bindings", "textStyle", "runs"]);

/** A layer whose main layer, or an instance above it whose main, is gone. */
function orphaned(doc: Doc, node: NodeRecord): boolean {
  const source = getProp(node.props, "mirrors");
  if (!source || !doc.has(source)) return true;
  for (const a of doc.ancestors(node.id)) {
    const main = getProp(a.props, "instanceOf");
    if (main && !doc.has(main)) return true;
  }
  return false;
}

/** Whether layout, not its main layer, decides a layer's box: a flow, its own layout, a binding. */
function laidOut(doc: Doc, map: ReadonlyMap<string, NodeRecord>, node: NodeRecord): boolean {
  const parent = map.get(node.parent) ?? doc.get(node.parent);
  if (!parent || parent.type === "group") return true;
  if (getProp(parent.props, "layoutMode") !== "none" && flows(node)) return true;
  if (hugsOn(node, "h") || hugsOn(node, "v") || measuresOn(node, "h") || measuresOn(node, "v"))
    return true;
  const bound = getProp(node.props, "bindings") as Record<string, unknown>;
  if (BOXES.some((k) => !!bound[k])) return true;
  // A nested instance's own size is its component's.
  return !!getProp(node.props, "instanceOf");
}

/** Whether something `placedGeometry` reads changed around a copy (`PLACED_INPUTS`). */
function inputsChanged(
  before: ReadonlyMap<string, NodeRecord>,
  after: ReadonlyMap<string, NodeRecord>,
  was: NodeRecord,
  now: NodeRecord,
): boolean {
  const around = (node: NodeRecord, map: ReadonlyMap<string, NodeRecord>) => {
    const ids = [node.id, node.parent];
    const source = getProp(node.props, "mirrors");
    if (source) ids.push(source, map.get(source)?.parent ?? "");
    const parent = map.get(node.parent);
    const parentSource = parent ? getProp(parent.props, "mirrors") : null;
    if (parentSource) ids.push(parentSource);
    const shown = getProp(node.props, "instanceOf");
    if (shown) ids.push(shown);
    return ids;
  };
  if (was.parent !== now.parent) return true;
  for (const id of new Set([...around(was, before), ...around(now, after)])) {
    const a = before.get(id);
    const b = after.get(id);
    if (!a || !b) return true;
    for (const prop of PLACED_INPUTS)
      if (
        // Its own box is what's asked about, not a reason.
        !(id === now.id && (BOXES as readonly string[]).includes(prop)) &&
        stable((a.props as Record<string, unknown>)[prop]) !==
          stable((b.props as Record<string, unknown>)[prop])
      )
        return true;
  }
  return false;
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
 * What issue 294's fix will do, done here: syncs the copies an unsent move made of what the
 * collaborator's edit changed (the rebase replays the move as it was made: a fill the collaborator
 * gave a layer in an instance the editor moved into a main, seed 601453470), then lays the
 * editor's document out where the rebase left it stale (what a full layout changes, text
 * measured, copies placed by `placedGeometry`), as the editor's own unsent fix-up, outside its
 * undo history. Only copies of a layer the editor's unsent edits moved (or of one in it) are
 * synced: a copy that misses a change any other way is reported (PR 286's eighth re-check).
 */
function layOutRebase(
  editor: Editor,
  touched: readonly string[] = [],
  moved: ReadonlySet<string> = new Set(),
): void {
  const doc = editor.doc;
  // A copy, what it copies, and so on: one of them, or a frame above one, moved unsent.
  const fromMoved = (id: string | undefined) => {
    for (let n = doc.get(id ?? ""), depth = 0; n && depth < 32; depth++) {
      if (moved.has(n.id) || doc.ancestors(n.id).some((a) => moved.has(a.id))) return true;
      n = doc.get(getProp(n.props, "mirrors") ?? "");
    }
    return false;
  };
  const synced =
    moved.size === 0
      ? []
      : propagationOps(
          doc,
          touched.filter((id) => doc.has(id)),
        ).filter((op) =>
          fromMoved(
            op.op === "create" ? (getProp(op.props as Props, "mirrors") ?? undefined) : op.id,
          ),
        );
  if (synced.length > 0) editor.sync.commit(synced);
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
  /** What the collaborator's latest edit changed. */
  let last: string[] = [];
  /** Layers the editor's edits moved, unsent until `settle`. */
  const moved = new Set<string>();
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
    /** The layers the collaborator's latest edit changed. */
    touched(): string[] {
      return last;
    },
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
    /**
     * Records layers an edit of the editor's changed, the frames they were and are in, and the
     * layers it moved.
     */
    note(changed: Iterable<string>, frames: Iterable<string>, moves: Iterable<string> = []) {
      for (const id of changed) {
        ours.add(id);
        oursOwn.add(id);
      }
      for (const id of frames) ours.add(id);
      for (const id of moves) moved.add(id);
    },
    /** The layers the editor's unsent edits moved. */
    moved(): ReadonlySet<string> {
      return moved;
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
      const rebasing = editor.sync.pendingCount > 0;
      const moving = ops
        .filter((op) => op.op === "move" && editor.doc.has(op.id) && inComponent(op.id))
        .map((op) => op.id);
      remote.push(ops);
      last = ops.map((op) => op.id);
      revn += 1;
      const written = recorder(editor).receiptWrites;
      receive({ t: "txn", revn, ops });
      // Invariant 6: receiving writes nothing of the editor's own (no fix-up of a rebase).
      expect(recorder(editor).receiptWrites, `no writes on receipt, ${step}`).toBe(written);
      // What a rebase moved out of every component (issue 294's, above): the editor's copies of
      // it, as they are now.
      if (rebasing)
        for (const id of moving) {
          if (!editor.doc.has(id) || inComponent(id)) continue;
          const sources = new Set(
            [editor.doc.get(id), ...collectDescendants(editor.doc, id)].map((n) => n?.id),
          );
          const kept = stranded.get(editor.doc) ?? new Map();
          for (const n of layers(editor.doc))
            if (sources.has(getProp(n.props, "mirrors") ?? undefined))
              kept.set(n.id, {
                x: getProp(n.props, "x"),
                y: getProp(n.props, "y"),
                width: getProp(n.props, "width"),
                height: getProp(n.props, "height"),
              });
          stranded.set(editor.doc, kept);
        }
      return serialSettled;
    },
    settle(mirror: Doc, step: string) {
      for (const ops of remote) mirror.applyStored(ops, { held: true });
      editor.sync.flush();
      moved.clear();
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
              const watched = watchEdit(editor);
              if (perform(editor, e, true, concurrent) === "lost") return;
              if (editor.doc.version !== version) ran.set(e.kind, (ran.get(e.kind) ?? 0) + 1);
              history.push(JSON.stringify(e));
              expect(watched(undoing), `ownership after ${history.join(", ")}`).toEqual([]);
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
                  changed.filter(
                    (id) => !!was[id] && !!now[id] && was[id]?.parent !== now[id]?.parent,
                  ),
                );
              }
              check(editor, mirror, copies, `after ${history.join(", ")}`, before, !room);
              if (room && step % 2 === 1) {
                // A rebase replays the editor's pending operations (even ones that net to no change,
                // as an undo and redo do) over the collaborator's edit.
                const rebasing = editor.sync.pendingCount > 0;
                const serialSettled = room.remote(step);
                if (rebasing && serialSettled) layOutRebase(editor, room.touched(), room.moved());
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
    it(`waives #306 only for the value its mode leaves stale, with copies ${copies}`, () => {
      const nodes = (label: Record<string, unknown>): NodeRecord[] => [
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
          props: { variableType: "number", values: { light: 1, dark: 1 } },
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
            layoutMode: "row",
            width: 400,
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
            ...label,
          },
        },
        // Placed by the row: a full layout puts it after the label, whatever mode it's in.
        {
          id: "box",
          type: "rect",
          parent: "orphan",
          key: "a1",
          props: { x: 399, width: 20, height: 20 },
        },
      ];
      // A binding that can't make it stale (its opacity, worth the same in both modes): reported.
      const unrelated = makeEditor(nodes({ bindings: { opacity: "num" } }), copies);
      const reported = unsettled(unrelated.doc);
      expect(reported).toContainEqual({ text: "label", width: [10, 176] });
      expect(reported.some((e) => (e as { id?: string }).id === "box")).toBe(true);
      // Its words bound by mode, and stored at what they measure with no mode set: #306's value.
      const bound = makeEditor(nodes({ bindings: { characters: "words" } }), copies);
      const light = autoSize(modeless(bound.doc).get("label") as NodeRecord, measurer);
      bound.sync.commit([{ op: "set", id: "label", prop: "width", value: light?.width ?? 0 }]);
      expect(unsettled(bound.doc).some((e) => (e as { text?: string }).text === "label")).toBe(
        false,
      );
      // Bound by mode, but stored at another width than that: reported.
      bound.sync.commit([{ op: "set", id: "label", prop: "width", value: 10 }]);
      expect(unsettled(bound.doc)).toContainEqual({ text: "label", width: [10, 176] });
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

  for (const pending of [false, true])
    it(`reports a stale copy after a collaborator's move with${pending ? "" : "out"} pending edits (#294)`, () => {
      const editor = makeEditor(
        [
          { id: "p", type: "page", parent: ROOT_ID, key: "a0", props: {} },
          {
            id: "part",
            type: "frame",
            parent: "p",
            key: "a0",
            props: { width: 60, height: 20, isComponent: true },
          },
          {
            id: "main",
            type: "frame",
            parent: "p",
            key: "a1",
            props: { width: 160, height: 80, isComponent: true, layoutMode: "row" },
          },
          {
            id: "nested",
            type: "frame",
            parent: "main",
            key: "a0",
            props: { width: 60, height: 20, instanceOf: "part" },
          },
          {
            id: "dark",
            type: "frame",
            parent: "p",
            key: "a2",
            props: { width: 160, height: 80 },
          },
        ],
        "materialized",
      );
      const instance = editor.insertInstance("main", { x: 250, y: 30 }) as string;
      const child = editor.doc.childIds(instance)[0] as string;
      editor.sync.takeUnsent();
      const record = editor.doc.get(child) as NodeRecord;
      const room = connect(editor, editor.doc.stored(), "materialized");
      if (pending) editor.setProp(["dark"], "opacity", 0.5);
      room.remote(3);
      expect(editor.doc.get("nested")?.parent).toBe("dark");
      // A stale copy put there afterwards, not by the rebase: not #294's, so reported.
      if (editor.doc.has(child))
        editor.doc.applyStored([{ op: "set", id: child, prop: "width", value: 15 }], {
          held: true,
        });
      else
        editor.doc.applyStored(
          [
            {
              op: "create",
              id: child,
              parent: record.parent,
              key: record.key,
              type: record.type,
              props: { ...record.props, width: 15 },
            },
          ],
          { held: true },
        );
      expect(unsettled(editor.doc)).toContainEqual({
        inherits: child,
        prop: "width",
        have: 15,
        want: 60,
      });
    });

  it("syncs the copies an unsent edit made of what a collaborator changed, after a rebase (#294)", () => {
    const editor = makeEditor(
      [
        { id: "p", type: "page", parent: ROOT_ID, key: "a0", props: {} },
        {
          id: "part",
          type: "frame",
          parent: "p",
          key: "a0",
          props: { width: 60, height: 20, isComponent: true },
        },
        { id: "r", type: "rect", parent: "part", key: "a0", props: { width: 40, height: 10 } },
        {
          id: "holder",
          type: "frame",
          parent: "p",
          key: "a1",
          props: { width: 160, height: 80, isComponent: true },
        },
        { id: "dark", type: "frame", parent: "p", key: "a2", props: { width: 160, height: 80 } },
      ],
      "materialized",
    );
    const inst = editor.insertInstance("part", { x: 400, y: 0 }) as string;
    const instR = editor.doc.childIds(inst)[0] as string;
    const held = editor.insertInstance("holder", { x: 400, y: 200 }) as string;
    editor.sync.takeUnsent();
    const room = connect(editor, editor.doc.stored(), "materialized");
    // Unsent: the instance goes into a main, so the main's instance gets a copy of its layer.
    expect(
      editor.commit([{ op: "move", id: inst, parent: "holder", key: editor.topKey("holder") }]),
    ).toBe(true);
    room.note([inst], ["p", "holder"], [inst]);
    const copyOf = (parent: string, source: string) =>
      editor.doc
        .childIds(parent)
        .find((id) => getProp(editor.doc.get(id)?.props ?? {}, "mirrors") === source);
    // Meanwhile the collaborator fills that layer (the only copy they have), arriving as a rebase.
    room.remote(1);
    const fills = getProp(editor.doc.get(instR)?.props ?? {}, "fills");
    expect(fills).toEqual([{ type: "solid", color: "#336699" }]);
    const copy = copyOf(copyOf(held, inst) as string, instR) as string;
    // The rebase replays the move as it was made, so the copy shows the fill from before (#294).
    expect(getProp(editor.doc.get(copy)?.props ?? {}, "fills")).not.toEqual(fills);
    layOutRebase(editor, room.touched(), room.moved());
    expect(getProp(editor.doc.get(copy)?.props ?? {}, "fills")).toEqual(fills);
  });

  it("doesn't sync a copy that missed a collaborator's change without an unsent move (#294)", () => {
    // PR 286's eighth re-check: the copy and its main layer were in both clients' documents
    // before; the editor has only an unrelated edit unsent, and one write the collaborator's
    // edit carries for the copy is dropped where the editor applies it. That's no rebase's
    // doing, so the fix-up leaves it, and the room's check reports it.
    const copies = "materialized";
    const editor = makeEditor(
      [
        { id: "p", type: "page", parent: ROOT_ID, key: "a0", props: {} },
        {
          id: "part",
          type: "frame",
          parent: "p",
          key: "a0",
          props: { width: 60, height: 20, isComponent: true },
        },
        { id: "r", type: "rect", parent: "part", key: "a0", props: { width: 40, height: 10 } },
        {
          id: "holder",
          type: "frame",
          parent: "p",
          key: "a1",
          props: { width: 160, height: 80, isComponent: true },
        },
        { id: "dark", type: "frame", parent: "p", key: "a2", props: { width: 160, height: 80 } },
      ],
      copies,
    );
    const inst = editor.insertInstance("part", { x: 400, y: 0 }) as string;
    const instR = editor.doc.childIds(inst)[0] as string;
    expect(
      editor.commit([{ op: "move", id: inst, parent: "holder", key: editor.topKey("holder") }]),
    ).toBe(true);
    const held = editor.insertInstance("holder", { x: 400, y: 200 }) as string;
    const copy = editor.doc.childIds(editor.doc.childIds(held)[0] as string)[0] as string;
    expect(getProp(editor.doc.get(copy)?.props ?? {}, "mirrors")).toBe(instR);
    // The step at which the collaborator fills `instR` (its copies are picked by step).
    const copyList = layers(editor.doc).filter((n) => !!getProp(n.props, "mirrors"));
    const step = [1, 5, 9, 13, 17].find((s) => copyList[(s * 7) % copyList.length]?.id === instR);
    expect(step).toBeDefined();
    editor.sync.takeUnsent();
    const start = editor.doc.stored();
    const room = connect(editor, start, copies);
    editor.setProp(["dark"], "opacity", 0.5);
    room.note(["dark"], ["p"]);
    expect(editor.sync.pendingCount).toBeGreaterThan(0);
    const receive = editor.sync.receive.bind(editor.sync);
    editor.sync.receive = (message) => {
      if (message.t === "txn") {
        const drop = (op: Op) => op.op === "set" && op.id === copy && op.prop === "fills";
        expect(message.ops.some(drop)).toBe(true);
        receive({ ...message, ops: message.ops.filter((op) => !drop(op)) });
        return;
      }
      receive(message);
    };
    expect(room.remote(step as number)).toBe(true);
    const fills = (id: string) => getProp(editor.doc.get(id)?.props ?? {}, "fills");
    expect(fills(copy)).not.toEqual(fills(instR));
    layOutRebase(editor, room.touched(), room.moved());
    expect(fills(copy)).not.toEqual(fills(instR));
    const mirror = new Doc();
    mirror.resetStored(start, copies);
    expect(() => room.settle(mirror, "after the dropped write")).toThrow();
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

// An instance whose flow differs from its main's (its direction, alignment, its layers' sizing, a
// nested instance swapped to another component), then auto layout added or taken away on either
// side, by the editor (which follows Figma) or through its generic setters (PR 286's seventh and
// eighth re-checks): every check above, a removal keeps its layers' boxes, and a later change to
// the main's flow moves and resizes nothing a removal left.
type FlowEdit =
  | { kind: "direction"; at: number; value: "row" | "column" }
  | { kind: "align"; at: number; value: "start" | "center" | "end" | "stretch" }
  | { kind: "sizing"; at: number; prop: "sizingH" | "sizingV"; value: "fixed" | "fill" | "hug" }
  | { kind: "resize"; at: number; prop: "width" | "height"; value: number }
  | { kind: "main-layout"; at: number; value: "none" | "row" | "column" }
  | { kind: "main-align"; at: number; value: "start" | "center" | "stretch" }
  | { kind: "older-remove"; at: number }
  | { kind: "older-add"; at: number; value: "row" | "column" }
  | { kind: "toggle"; at: number; how: "remove" | "add" | "wrap" }
  | { kind: "swap"; at: number; to: number }
  | { kind: "undo" }
  | { kind: "undo-redo" };

const flowAt = fc.nat(400);
const flowEdit: fc.Arbitrary<FlowEdit> = fc.oneof(
  fc.record({
    kind: fc.constant("direction" as const),
    at: flowAt,
    value: fc.constantFrom("row" as const, "column" as const),
  }),
  fc.record({
    kind: fc.constant("align" as const),
    at: flowAt,
    value: fc.constantFrom("start" as const, "center" as const, "end" as const, "stretch" as const),
  }),
  fc.record({
    kind: fc.constant("sizing" as const),
    at: flowAt,
    prop: fc.constantFrom("sizingH" as const, "sizingV" as const),
    value: fc.constantFrom("fixed" as const, "fill" as const, "hug" as const),
  }),
  fc.record({
    kind: fc.constant("resize" as const),
    at: flowAt,
    prop: fc.constantFrom("width" as const, "height" as const),
    value: fc.integer({ min: 20, max: 260 }),
  }),
  fc.record({
    kind: fc.constant("main-layout" as const),
    at: flowAt,
    value: fc.constantFrom("none" as const, "row" as const, "column" as const),
  }),
  fc.record({
    kind: fc.constant("main-align" as const),
    at: flowAt,
    value: fc.constantFrom("start" as const, "center" as const, "stretch" as const),
  }),
  fc.record({ kind: fc.constant("older-remove" as const), at: flowAt }),
  fc.record({
    kind: fc.constant("older-add" as const),
    at: flowAt,
    value: fc.constantFrom("row" as const, "column" as const),
  }),
  fc.record({
    kind: fc.constant("toggle" as const),
    at: flowAt,
    how: fc.constantFrom("remove" as const, "add" as const, "wrap" as const),
  }),
  fc.record({ kind: fc.constant("swap" as const), at: flowAt, to: fc.nat(2) }),
  fc.constant({ kind: "undo" as const }),
  fc.constant({ kind: "undo-redo" as const }),
);
const FLOW_KINDS: readonly FlowEdit["kind"][] = [
  "direction",
  "align",
  "sizing",
  "resize",
  "main-layout",
  "main-align",
  "older-remove",
  "older-add",
  "toggle",
  "swap",
  "undo",
  "undo-redo",
];
const FLOW_MAINS = ["rowMain", "colMain", "plainMain"];

/** Components with a row, a column and no flow, one holding instances of the others, and instances. */
function flowDocument(copies: "compact" | "materialized"): Editor {
  const n = (id: string, type: NodeRecord["type"], parent: string, props: Props, key: string) =>
    ({ id, type, parent, key, props }) as NodeRecord;
  const editor = makeEditor(
    [
      n("p", "page", ROOT_ID, {}, "a0"),
      n(
        "rowMain",
        "frame",
        "p",
        {
          isComponent: true,
          width: 160,
          height: 80,
          layoutMode: "row",
          paddingLeft: 4,
          paddingTop: 4,
          gap: 4,
        },
        "a0",
      ),
      n("rowA", "rect", "rowMain", { width: 60, height: 20 }, "a0"),
      n("rowB", "rect", "rowMain", { width: 40, height: 30, sizingH: "fill" }, "a1"),
      n(
        "rowT",
        "text",
        "rowMain",
        { characters: "Label", fontSize: 10, textAutoResize: "width", width: 25, height: 12.5 },
        "a2",
      ),
      n(
        "colMain",
        "frame",
        "p",
        {
          isComponent: true,
          y: 200,
          width: 120,
          height: 100,
          layoutMode: "column",
          alignItems: "center",
          gap: 6,
        },
        "a1",
      ),
      n("colA", "rect", "colMain", { width: 50, height: 20 }, "a0"),
      n("colB", "rect", "colMain", { width: 80, height: 20, sizingH: "fill" }, "a1"),
      n("plainMain", "frame", "p", { isComponent: true, y: 400, width: 160, height: 80 }, "a2"),
      n(
        "plainA",
        "rect",
        "plainMain",
        { x: 10, y: 10, width: 140, height: 20, constraintH: "stretch" },
        "a0",
      ),
      n(
        "plainB",
        "rect",
        "plainMain",
        { x: 100, y: 40, width: 40, height: 20, constraintH: "end", constraintV: "scale" },
        "a1",
      ),
      n("outer", "frame", "p", { isComponent: true, y: 600, width: 400, height: 260 }, "a3"),
    ],
    copies,
  );
  for (const main of [...FLOW_MAINS])
    expect(
      editor.commit([
        {
          op: "move",
          id: editor.insertInstance(main, { x: 5000, y: 5000 }) as string,
          parent: "outer",
          key: editor.topKey("outer"),
        },
      ]),
    ).toBe(true);
  for (const [i, main] of [...FLOW_MAINS, "outer", "rowMain"].entries())
    expect(editor.insertInstance(main, { x: 1000 + i * 450, y: 0 })).toBeTruthy();
  editor.commit(
    layoutOps(
      editor.doc,
      layers(editor.doc)
        .filter(isFrame)
        .map((f) => f.id),
    ),
  );
  return editor;
}

/** Edits of the family that a refusal answered, as it should (they change nothing). */
const refusedFlow = new WeakMap<Editor, number>();

function performFlow(editor: Editor, e: FlowEdit): void {
  const doc = editor.doc;
  if (e.kind === "undo") {
    editor.undo();
    return;
  }
  if (e.kind === "undo-redo") {
    const before = snapshot(doc);
    editor.undo();
    editor.redo();
    expect(unexplained(before, snapshot(doc), doc), "undone and redone").toEqual([]);
    return;
  }
  const all = layers(doc);
  const instances = all.filter(isInstance);
  const pick = <T>(list: readonly T[]) => list[e.at % Math.max(1, list.length)];
  // Taking a frame's auto layout away: refused for an instance or a layer in one whose shown
  // frame has a flow (PR 286, as Figma refuses it), so no frame is frozen; a frame of its own (a
  // main) keeps its layers' boxes, as Figma does.
  const removing = (id: string, act: () => void) => {
    const node = doc.get(id);
    const was = getProp(node?.props ?? {}, "layoutMode");
    const shownId =
      getProp(node?.props ?? {}, "instanceOf") ?? getProp(node?.props ?? {}, "mirrors");
    const shown = shownId ? doc.get(shownId) : undefined;
    const boxes = doc.childIds(id).map((c) => [c, boxOf(doc, c)] as const);
    const frameWas = boxOf(doc, id);
    noteFlow(doc, id);
    act();
    if (was !== "none" && shown && getProp(shown.props, "layoutMode") !== "none") {
      expect(getProp(doc.get(id)?.props ?? {}, "layoutMode"), `${id}'s removal refused`).toBe(was);
      refusedFlow.set(editor, (refusedFlow.get(editor) ?? 0) + 1);
      return;
    }
    if (
      !shownId &&
      was !== "none" &&
      getProp(doc.get(id)?.props ?? {}, "layoutMode") === "none" &&
      JSON.stringify(boxOf(doc, id)) === JSON.stringify(frameWas)
    )
      for (const [c, box] of boxes) expectKept(doc, id, c, box);
  };
  switch (e.kind) {
    case "direction": {
      const node = pick(instances.filter((n) => getProp(n.props, "layoutMode") !== "none"));
      if (node) editor.setLayoutMode([node.id], e.value);
      return;
    }
    case "align": {
      const node = pick(instances);
      if (node) editor.setProp([node.id], "alignItems", e.value);
      return;
    }
    case "sizing": {
      const node = pick(all.filter((n) => !!getProp(n.props, "mirrors") && !isInstance(n)));
      if (node) editor.setProp([node.id], e.prop, e.value);
      return;
    }
    case "resize": {
      const node = pick(instances);
      if (node) editor.resize([node.id], e.prop, e.value);
      return;
    }
    case "main-layout": {
      const main = FLOW_MAINS[e.at % FLOW_MAINS.length] as string;
      if (e.value === "none") removing(main, () => editor.setLayoutMode([main], "none"));
      else editor.setLayoutMode([main], e.value);
      return;
    }
    case "main-align": {
      const main = FLOW_MAINS[e.at % FLOW_MAINS.length] as string;
      editor.setProp([main], "alignItems", e.value);
      return;
    }
    case "older-remove": {
      // Through the editor's generic setters, as an agent's tool or a file from before would: the
      // editor refuses it where the instance's component has a flow, as its layout commands do.
      const node = pick(instances.filter((n) => getProp(n.props, "layoutMode") !== "none"));
      if (node)
        removing(node.id, () =>
          editor.commit([{ op: "set", id: node.id, prop: "layoutMode", value: null }]),
        );
      return;
    }
    case "older-add": {
      // Refused where the frame the instance shows has no flow (PR 286, as Figma does; Shift+A
      // wraps it instead), through the generic setter and the agent's tools too.
      const node = pick(instances.filter((n) => getProp(n.props, "layoutMode") === "none"));
      if (!node) return;
      const shownId = getProp(node.props, "instanceOf") ?? getProp(node.props, "mirrors");
      const plain = getProp(doc.get(shownId ?? "")?.props ?? {}, "layoutMode") === "none";
      editor.commit([{ op: "set", id: node.id, prop: "layoutMode", value: e.value }]);
      if (plain) {
        expect(getProp(doc.get(node.id)?.props ?? {}, "layoutMode"), "refused").toBe("none");
        refusedFlow.set(editor, (refusedFlow.get(editor) ?? 0) + 1);
      }
      return;
    }
    case "toggle": {
      const node = pick(instances);
      if (!node) return;
      if (e.how === "remove") removing(node.id, () => editor.setLayoutMode([node.id], "none"));
      else if (e.how === "add") editor.setLayoutMode([node.id], "row");
      else {
        editor.select([node.id]);
        editor.frameSelection(true);
      }
      return;
    }
    case "swap": {
      const node = pick(instances.filter((n) => !!getProp(n.props, "mirrors")));
      const to = FLOW_MAINS[e.to] as string;
      if (node && !wouldCycle(doc, to, node.parent)) editor.swapInstance(node.id, to);
      return;
    }
  }
}

describe("an instance's own flow against its main's", () => {
  for (const copies of ["materialized", "compact"] as const)
    it(`with copies ${copies}`, () => {
      const runs = Number(process.env.FUZZ_RUNS) || 40;
      const ran = new Map<FlowEdit["kind"], number>(FLOW_KINDS.map((k) => [k, 0]));
      fc.assert(
        fc.property(fc.array(flowEdit, { minLength: 1, maxLength: 12 }), (edits) => {
          const editor = flowDocument(copies);
          const mirror = new Doc();
          mirror.resetStored(editor.doc.stored(), copies);
          editor.sync.takeUnsent();
          check(editor, mirror, copies, "after making it");
          const history: string[] = [];
          for (const e of edits) {
            const undoing = e.kind === "undo" || e.kind === "undo-redo";
            const before = undoing ? undefined : frameStates(editor.doc);
            const version = editor.doc.version;
            const refused = refusedFlow.get(editor) ?? 0;
            const watched = watchEdit(editor);
            performFlow(editor, e);
            if (editor.doc.version !== version || (refusedFlow.get(editor) ?? 0) > refused)
              ran.set(e.kind, (ran.get(e.kind) ?? 0) + 1);
            history.push(JSON.stringify(e));
            expect(watched(undoing), `ownership after ${history.join(", ")}`).toEqual([]);
            check(editor, mirror, copies, `after ${history.join(", ")}`, before);
          }
        }),
        { numRuns: runs },
      );
      if (runs >= 40)
        expect(
          FLOW_KINDS.filter((k) => !ran.get(k)),
          `kinds of edit that never changed the document: ${JSON.stringify(Object.fromEntries(ran))}`,
        ).toEqual([]);
    }, 600_000);
});

// The ownership invariants (PR 286's design memo, section 4), and the tenth re-check's swapped-in
// layer: these prove the oracle reports each fault injected.
describe("the oracle's ownership checks", () => {
  for (const copies of ["materialized", "compact"] as const) {
    it(`reports a wrong place on a layer swapped in after a removal, with copies ${copies}`, () => {
      const editor = makeEditor(null, copies);
      const doc = editor.doc;
      expect(
        editor.commit([
          {
            op: "create",
            id: "rowMain",
            parent: "p",
            type: "frame",
            key: "a0",
            props: {
              isComponent: true,
              width: 160,
              height: 80,
              layoutMode: "row",
              paddingLeft: 13,
              paddingTop: 7,
            },
          },
          {
            op: "create",
            id: "old",
            parent: "rowMain",
            type: "rect",
            key: "a0",
            props: { name: "Old", width: 60, height: 20 },
          },
          {
            op: "create",
            id: "plainMain",
            parent: "p",
            type: "frame",
            key: "a1",
            props: { isComponent: true, width: 160, height: 80 },
          },
          {
            op: "create",
            id: "new",
            parent: "plainMain",
            type: "rect",
            key: "a0",
            props: { name: "New", x: 17, y: 11, width: 40, height: 20 },
          },
        ]),
      ).toBe(true);
      const id = editor.insertInstance("rowMain", { x: 220, y: 0 }) as string;
      // Its removal is refused now; the swap shows the plain component's layer either way.
      performFlow(editor, { kind: "older-remove", at: 0 });
      editor.swapInstance(id, "plainMain");
      const next = doc.childIds(id)[0] as string;
      expect(boxOf(doc, next)).toEqual([17, 11, 40, 20]);
      expect(unsettled(doc)).toEqual([]);
      // The reviewer's injection: a place nothing derives, and nothing marks as its own.
      editor.sync.commit([{ op: "set", id: next, prop: "x", value: 65 }]);
      expect(getProp(doc.get(next)?.props ?? {}, "overrides")).not.toContain("x");
      expect(
        unsettled(doc).some((entry) => JSON.stringify(entry).includes(next)),
        "the wrong x is reported",
      ).toBe(true);
    });

    it(`reports a mark, a move and a frozen frame no edit makes, with copies ${copies}`, () => {
      const editor = flowDocument(copies);
      const doc = editor.doc;
      editor.sync.takeUnsent();
      const instance = layers(doc).find(
        (n) => getProp(n.props, "instanceOf") === "rowMain" && !getProp(n.props, "mirrors"),
      ) as NodeRecord;
      const second = doc.childIds(instance.id)[1] as string;
      // An edit that names neither: a recolour of the main's first layer.
      let watched = watchEdit(editor);
      editor.setProp(["rowA"], "fills", [{ type: "solid", color: "#336699" }]);
      expect(watched(false)).toEqual([]);
      // 1: an opacity mark on a layer the edit doesn't name (the eleventh re-check's injection).
      watched = watchEdit(editor);
      editor.setProp(["rowA"], "opacity", 0.5);
      editor.sync.commit([{ op: "set", id: second, prop: "overrides", value: ["opacity"] }]);
      expect(watched(false)).toContainEqual({ marked: second, prop: "opacity" });
      // 3: a copy moved that nothing reaches (placed freely, in an instance of the plain main).
      const plain = layers(doc).find(
        (n) => getProp(n.props, "instanceOf") === "plainMain" && !getProp(n.props, "mirrors"),
      ) as NodeRecord;
      const free = doc.childIds(plain.id)[0] as string;
      watched = watchEdit(editor);
      editor.setProp(["rowA"], "opacity", 0.8);
      const place = getProp(doc.get(free)?.props ?? {}, "y");
      editor.sync.commit([{ op: "set", id: free, prop: "y", value: place + 9 }]);
      expect(watched(false).some((x) => (x as { moved?: string }).moved === free)).toBe(true);
      // 5: the instance's flow taken away past the editor's refusal.
      watched = watchEdit(editor);
      expect(
        editor.commit([{ op: "set", id: instance.id, prop: "layoutMode", value: null }]),
        "refused",
      ).toBe(false);
      editor.sync.commit([
        { op: "set", id: instance.id, prop: "layoutMode", value: null },
        {
          op: "set",
          id: instance.id,
          prop: "overrides",
          value: [...getProp(instance.props, "overrides"), "layoutMode"],
        },
      ]);
      expect(watched(false)).toContainEqual({ madeFrozen: instance.id });
      // 6: a write while a collaborator's edit is received.
      const rec = recorder(editor);
      const writes = rec.receiptWrites;
      rec.receiving = true;
      editor.sync.commit([{ op: "set", id: "rowA", prop: "opacity", value: 0.4 }]);
      rec.receiving = false;
      expect(rec.receiptWrites).toBe(writes + 1);
    });

    it.skipIf(copies === "materialized")(
      "reports an override record a derived operation deletes (option 1)",
      () => {
        const editor = flowDocument(copies);
        const doc = editor.doc;
        editor.sync.takeUnsent();
        const instance = layers(doc).find(
          (n) => getProp(n.props, "instanceOf") === "rowMain" && !getProp(n.props, "mirrors"),
        ) as NodeRecord;
        const copy = doc.childIds(instance.id)[0] as string;
        editor.setProp([copy], "fills", [{ type: "solid", color: "#ff0000" }]);
        expect(doc.stored().some((r) => r.id === copy && r.type === "override")).toBe(true);
        // Taking the fill back clears the record's fields, never the record: empty, it means
        // nothing, and the copy shows its main layer's fill.
        let watched = watchEdit(editor);
        editor.resetOverrides([{ id: copy, props: ["fills"] }]);
        expect(watched(false)).toEqual([]);
        const record = doc.stored().find((r) => r.id === copy && r.type === "override");
        expect(record && Object.keys(record.props)).toEqual(["path"]);
        expect(getProp(doc.get(copy)?.props ?? {}, "fills")).toEqual(
          getProp(doc.get("rowA")?.props ?? {}, "fills"),
        );
        // A derived delete, injected: reported.
        watched = watchEdit(editor);
        editor.setProp(["rowA"], "opacity", 0.5);
        doc.applyStored([{ op: "delete", id: copy }]);
        recorder(editor).stored.push({ op: "delete", id: copy });
        expect(watched(false)).toContainEqual({ deletedRecord: copy });
      },
    );
  }
});

// Files from before PR 286 can hold a frozen frame (`frozenFrame`): an instance that took its
// component's auto layout away, its layers as that flow left them, unmarked. These are the
// eleventh re-check's snapshots, saved on main (the stretched instance, 93 tall, flow removed).
const LEGACY: Record<"materialized" | "compact", { id: string; nodes: NodeRecord[] }> = {
  materialized: {
    id: "0MA4fCnURtqrnSIX",
    nodes: [
      { id: "p", type: "page", parent: "root", key: "a0", props: {} },
      {
        id: "main",
        type: "frame",
        parent: "p",
        key: "a0",
        props: {
          isComponent: true,
          width: 160,
          height: 80,
          layoutMode: "row",
          paddingTop: 7,
          paddingLeft: 13,
          gap: 5,
        },
      },
      {
        id: "r",
        type: "rect",
        parent: "main",
        key: "a0",
        props: { width: 60, height: 20, constraintH: "stretch", x: 13, y: 7 },
      },
      {
        id: "s",
        type: "rect",
        parent: "main",
        key: "a1",
        props: { width: 12, height: 10, x: 78, y: 7 },
      },
      {
        id: "0MA4fCnURtqrnSIX",
        type: "frame",
        parent: "p",
        key: "a1",
        props: {
          width: 120,
          height: 100,
          paddingTop: 7,
          paddingLeft: 13,
          gap: 5,
          instanceOf: "main",
          x: 420,
          y: 460,
          overrides: ["alignItems", "height", "layoutMode", "width"],
          alignItems: "stretch",
        },
      },
      {
        id: "tWbKTiOPw7YWCxfQ",
        type: "rect",
        parent: "0MA4fCnURtqrnSIX",
        key: "a0",
        props: { width: 60, height: 93, constraintH: "stretch", x: 13, y: 7, mirrors: "r" },
      },
      {
        id: "7XSwk57ybqvK0bLx",
        type: "rect",
        parent: "0MA4fCnURtqrnSIX",
        key: "a1",
        props: { width: 12, height: 93, x: 78, y: 7, mirrors: "s" },
      },
    ] as NodeRecord[],
  },
  compact: {
    id: "t15VRJci1KjnHMxO",
    nodes: [
      { id: "p", type: "page", parent: "root", key: "a0", props: {} },
      {
        id: "main",
        type: "frame",
        parent: "p",
        key: "a0",
        props: {
          isComponent: true,
          width: 160,
          height: 80,
          layoutMode: "row",
          paddingTop: 7,
          paddingLeft: 13,
          gap: 5,
        },
      },
      {
        id: "r",
        type: "rect",
        parent: "main",
        key: "a0",
        props: { width: 60, height: 20, constraintH: "stretch", x: 13, y: 7 },
      },
      {
        id: "s",
        type: "rect",
        parent: "main",
        key: "a1",
        props: { width: 12, height: 10, x: 78, y: 7 },
      },
      {
        id: "t15VRJci1KjnHMxO",
        type: "frame",
        parent: "p",
        key: "a1",
        props: {
          instanceOf: "main",
          x: 420,
          y: 460,
          width: 120,
          overrides: ["alignItems", "height", "layoutMode", "width"],
          height: 100,
          alignItems: "stretch",
          unset: ["layoutMode"],
        },
      },
      {
        id: "IonPPDu8WQLnrfHb",
        type: "override",
        parent: "t15VRJci1KjnHMxO",
        key: "a0",
        props: { path: ["r"], height: 93 },
      },
      {
        id: "Vi2MRtpWA1pYBwis",
        type: "override",
        parent: "t15VRJci1KjnHMxO",
        key: "a0",
        props: { path: ["s"], height: 93 },
      },
    ] as NodeRecord[],
  },
};

describe("a frozen frame from a file from before", () => {
  const unrelated: NodeRecord = {
    id: "unrelated",
    type: "frame",
    parent: "p",
    key: "Zy",
    props: { x: 10, y: 500, width: 40, height: 32 },
  };
  /** What the file stores of a layer's box and text mode (a record's fields, with compact copies). */
  const stored = (doc: Doc, id: string) => {
    const record = doc.stored().find((r) => r.id === id);
    const props = (record?.props ?? {}) as Record<string, unknown>;
    return ["x", "y", "width", "height", "textAutoResize"].map((k) => props[k] ?? null);
  };
  const edits: [string, (e: Editor, id: string) => void][] = [
    ["rename instance", (e, id) => e.setProp([id], "name", "Updated card")],
    ["rename main", (e) => e.setProp(["main"], "name", "Updated card component")],
    ["rename source child", (e) => e.setProp(["r"], "name", "Primary field")],
    [
      "recolour source child",
      (e) => e.setProp(["r"], "fills", [{ type: "solid", color: "#ff3355" }]),
    ],
    [
      "recolour copy child",
      (e, id) =>
        e.setProp([e.doc.childIds(id)[0] as string], "fills", [
          { type: "solid", color: "#ff3355" },
        ]),
    ],
    [
      "move sibling in layer order",
      (e) => e.commit([{ op: "move", id: "s", parent: "main", key: "Zz" }]),
    ],
    ["move another frame", (e) => e.setProp(["unrelated"], "x", 80)],
    ["resize source child", (e) => e.resize(["r"], "height", 21)],
    ["turn the main to a column", (e) => e.setLayoutMode(["main"], "column")],
    ["pad the main", (e) => e.setProp(["main"], "paddingLeft", 31)],
  ];
  for (const copies of ["materialized", "compact"] as const)
    for (const [label, edit] of edits)
      it(`keeps its layers through "${label}", with copies ${copies}`, () => {
        const { id, nodes } = LEGACY[copies];
        const editor = makeEditor([...nodes, unrelated], copies);
        const doc = editor.doc;
        expect(frozenFrames(doc)).toEqual(new Set([id]));
        const children = [...doc.childIds(id)];
        const before = children.map((c) => stored(doc, c));
        const shown = children.map((c) => boxOf(doc, c));
        expect(shown).toEqual([
          [13, 7, 60, 93],
          [78, 7, 12, 93],
        ]);
        const watched = watchEdit(editor);
        edit(editor, id);
        // 3 and 5: nothing reached them, and the frame stays frozen (no other is).
        expect(watched(false)).toEqual([]);
        expect(frozenFrames(doc)).toEqual(new Set([id]));
        // 2: what's stored of their boxes and text modes is as it was.
        expect(children.map((c) => stored(doc, c))).toEqual(before);
        // Undone and redone, and read back, the same again.
        const after = snapshot(doc);
        editor.undo();
        expect(children.map((c) => stored(doc, c))).toEqual(before);
        editor.redo();
        expect(snapshot(doc)).toEqual(after);
        const reloaded = new Doc();
        reloaded.resetStored(doc.stored(), copies);
        expect(snapshot(reloaded)).toEqual(after);
        expect(unsettled(doc)).toEqual([]);
      });
  for (const copies of ["materialized", "compact"] as const)
    it(`moves its layers by their constraints when it resizes, with copies ${copies}`, () => {
      const { id, nodes } = LEGACY[copies];
      const editor = makeEditor(nodes, copies);
      const doc = editor.doc;
      const [r, s] = doc.childIds(id) as [string, string];
      const watched = watchEdit(editor);
      editor.resize([id], "width", 130);
      expect(watched(false)).toEqual([]);
      // Left and right on the first: 10 wider, from where it was (60, not its main layer's).
      expect(boxOf(doc, r)).toEqual([13, 7, 70, 93]);
      expect(boxOf(doc, s)).toEqual([78, 7, 12, 93]);
      expect(frozenFrames(doc)).toEqual(new Set([id]));
      expect(unsettled(doc)).toEqual([]);
    });
  for (const copies of ["materialized", "compact"] as const)
    it(`thaws only by a swap, with copies ${copies}`, () => {
      const { id, nodes } = LEGACY[copies];
      const plain: NodeRecord[] = [
        {
          id: "other",
          type: "frame",
          parent: "p",
          key: "b0",
          props: { isComponent: true, width: 160, height: 80, layoutMode: "row" },
        },
        { id: "o1", type: "rect", parent: "other", key: "a0", props: { width: 30, height: 20 } },
      ];
      const editor = makeEditor([...nodes, ...plain], copies);
      const doc = editor.doc;
      // A swap into a component with a flow takes that flow: the frame isn't frozen after it.
      const watched = watchEdit(editor);
      editor.swapInstance(id, "other");
      expect(watched(false)).toEqual([]);
      expect(frozenFrames(doc)).toEqual(new Set());
      expect(getProp(doc.get(id)?.props ?? {}, "layoutMode")).toBe("row");
      expect(unsettled(doc)).toEqual([]);
      // Undo goes back to it, frozen, as the file had it.
      editor.undo();
      expect(frozenFrames(doc)).toEqual(new Set([id]));
    });
});

// 7. Convergence: three clients and a room, with edits arriving in flight, unsent, after a
// reconnect (a snapshot, or a catch-up on what the room logged) and refused, and none of them
// writing on receipt (6). Every replica ends where the room does.
type Wire = { t: string; [key: string]: unknown };
type Act =
  | { kind: "edit"; who: number; what: number; at: number }
  | { kind: "flush"; who: number }
  | { kind: "room" }
  | { kind: "deliver"; who: number }
  | { kind: "drop"; who: number }
  | { kind: "join"; who: number; snapshot: boolean }
  | { kind: "refuse" }
  | { kind: "undo"; who: number }
  | { kind: "redo"; who: number };

const who = fc.nat(2);
const act: fc.Arbitrary<Act> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.record({
      kind: fc.constant("edit" as const),
      who,
      what: fc.nat(10),
      at: fc.nat(400),
    }),
  },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant("flush" as const), who }) },
  { weight: 4, arbitrary: fc.constant({ kind: "room" as const }) },
  { weight: 4, arbitrary: fc.record({ kind: fc.constant("deliver" as const), who }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("drop" as const), who }) },
  {
    weight: 1,
    arbitrary: fc.record({ kind: fc.constant("join" as const), who, snapshot: fc.boolean() }),
  },
  { weight: 1, arbitrary: fc.constant({ kind: "refuse" as const }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("undo" as const), who }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("redo" as const), who }) },
);

/** The eleventh re-check's file: a row main with a stretched instance, and a column main's. */
function convergenceFile(copies: "compact" | "materialized") {
  const setup = makeEditor(null, copies);
  const n = (id: string, type: NodeRecord["type"], parent: string, props: Props, key = "a0") =>
    ({ op: "create", id, type, parent, key, props }) as Op;
  expect(
    setup.commit([
      n("rowMain", "frame", "p", {
        isComponent: true,
        width: 160,
        height: 80,
        layoutMode: "row",
        paddingTop: 7,
        paddingLeft: 13,
        gap: 5,
      }),
      n("r", "rect", "rowMain", { width: 60, height: 20, constraintH: "stretch" }),
      n("s", "rect", "rowMain", { width: 12, height: 10 }, "a1"),
      n(
        "colMain",
        "frame",
        "p",
        { isComponent: true, y: 200, width: 120, height: 100, layoutMode: "column", gap: 6 },
        "a1",
      ),
      n("c1", "rect", "colMain", { width: 50, height: 20 }),
      n("c2", "rect", "colMain", { width: 80, height: 20, sizingH: "fill" }, "a1"),
    ]),
  ).toBe(true);
  setup.commit(layoutOps(setup.doc, ["rowMain", "colMain"]));
  const stretched = setup.insertInstance("rowMain", { x: 500, y: 0 }) as string;
  setup.resize([stretched], "width", 120);
  setup.resize([stretched], "height", 100);
  setup.setProp([stretched], "alignItems", "stretch");
  const column = setup.insertInstance("colMain", { x: 500, y: 300 }) as string;
  setup.sync.takeUnsent();
  return { nodes: setup.doc.stored(), stretched, column };
}

/** What the convergence runs exercised, for their coverage gate. */
const convergeSeen = { applied: 0, refused: 0, rebased: 0, snapshots: 0, catchups: 0 };

function converge(copies: "compact" | "materialized", acts: readonly Act[]): void {
  const { nodes, stretched, column } = convergenceFile(copies);
  const room = {
    doc: new Doc(),
    revn: 1,
    log: [] as { revn: number; ops: Op[] }[],
    seq: new Map<string, number>(),
    inbox: [] as { from: number; generation: number; message: Wire }[],
    refuse: false,
  };
  room.doc.resetStored(nodes, copies);
  const clients = [0, 1, 2].map((i) => {
    const editor = new Editor({ measurer, clientId: `client-${i}` });
    editor.state.set({ role: "editor", viewport: { width: 1200, height: 800 } });
    editor.doc.resetStored(nodes, copies);
    editor.setPage("p");
    recorder(editor);
    return {
      editor,
      inbox: [] as Wire[],
      online: false,
      generation: 0,
      welcomed: false,
      snapshot: true,
    };
  });
  const join = (i: number) => {
    const c = clients[i] as (typeof clients)[number];
    if (c.online) return;
    c.generation++;
    c.online = true;
    c.welcomed = false;
    c.inbox = [];
    const generation = c.generation;
    c.editor.sync.connected((message) => {
      room.inbox.push({ from: i, generation, message: message as Wire });
    });
  };
  const drop = (i: number) => {
    const c = clients[i] as (typeof clients)[number];
    if (!c.online) return;
    c.online = false;
    c.welcomed = false;
    c.inbox = [];
    c.editor.sync.disconnected();
  };
  const reply = (i: number, generation: number, message: Wire) => {
    const c = clients[i] as (typeof clients)[number];
    if (c.online && c.generation === generation) c.inbox.push(message);
  };
  const serve = () => {
    const next = room.inbox.shift();
    if (!next) return;
    const { from, generation, message } = next;
    const c = clients[from] as (typeof clients)[number];
    const id = `client-${from}`;
    if (message.t === "hello") {
      if (!c.online || c.generation !== generation) return;
      const revn = message.revn as number | null;
      const snapshot = revn === null || c.snapshot;
      reply(from, generation, {
        t: "welcome",
        mode: snapshot ? "snapshot" : "catchup",
        revn: room.revn,
        sessionId: id,
        role: "editor",
        peers: [],
        lastSeq: room.seq.get(id) ?? 0,
        copies,
      });
      // A reconnect (not the first load): by snapshot, or catching up on what the room logged.
      if (c.generation > 1) convergeSeen[snapshot ? "snapshots" : "catchups"]++;
      if (snapshot)
        reply(from, generation, { t: "snapshot", nodes: room.doc.stored(), done: true });
      else
        for (const entry of room.log)
          if (entry.revn > (revn as number)) reply(from, generation, { t: "txn", ...entry });
      c.welcomed = true;
      return;
    }
    if (message.t !== "txn") return;
    const seq = message.seq as number;
    if (seq <= (room.seq.get(id) ?? 0)) return;
    room.seq.set(id, seq);
    const ops = message.ops as Op[];
    let refused: { code: string; message: string } | null = null;
    if (room.refuse) {
      room.refuse = false;
      refused = { code: "forbidden", message: "refused for the test" };
    } else
      try {
        room.doc.applyStored(ops);
      } catch (error) {
        if (!(error instanceof Error) || error.name !== "ModelError") throw error;
        refused = { code: String((error as { code?: string }).code), message: error.message };
      }
    if (refused) {
      convergeSeen.refused++;
      reply(from, generation, { t: "reject", seq, ...refused });
      return;
    }
    convergeSeen.applied++;
    room.revn += 1;
    room.log.push({ revn: room.revn, ops });
    reply(from, generation, { t: "ack", seq, revn: room.revn });
    clients.forEach((other, j) => {
      if (j !== from && other.online && other.welcomed)
        other.inbox.push({ t: "txn", revn: room.revn, ops });
    });
  };
  const deliver = (i: number) => {
    const c = clients[i] as (typeof clients)[number];
    const message = c.inbox.shift();
    if (!message) return;
    const rec = recorder(c.editor);
    const writes = rec.receiptWrites;
    if (message.t === "txn" && c.editor.sync.pendingCount > 0) convergeSeen.rebased++;
    c.editor.sync.receive(message as never);
    if (message.t === "snapshot") c.editor.setPage("p");
    // 6: receiving writes nothing.
    expect(rec.receiptWrites, `client ${i} wrote on receipt`).toBe(writes);
  };
  const edit = (e: Editor, what: number, at: number) => {
    const first = e.doc.childIds(stretched)[0];
    switch (what) {
      case 0:
        e.setLayoutMode(["rowMain"], at % 2 ? "column" : "row");
        return;
      case 1:
        e.setProp(["rowMain"], "paddingTop", at % 20);
        return;
      case 2:
        e.resize(["r"], "height", 10 + (at % 40));
        return;
      case 3:
        if (first)
          e.setProp([first], "fills", [
            { type: "solid", color: `#${(at % 256).toString(16).padStart(2, "0")}3355` },
          ]);
        return;
      case 4:
        if (first) e.resize([first], "width", 20 + (at % 60));
        return;
      case 5:
        e.setProp([stretched], "alignItems", (["stretch", "start", "center"] as const)[at % 3]);
        return;
      case 6:
        e.resize([stretched], "width", 80 + (at % 80));
        return;
      case 7:
        e.select([stretched]);
        e.resetInstances();
        return;
      case 8:
        // Refused (PR 286): no edit makes a frame frozen.
        e.commit([{ op: "set", id: stretched, prop: "layoutMode", value: null }]);
        return;
      case 9:
        if (e.doc.has(column))
          e.swapInstance(
            column,
            getProp(e.doc.get(column)?.props ?? {}, "instanceOf") === "colMain"
              ? "rowMain"
              : "colMain",
          );
        return;
      default:
        e.setProp(["r"], "fills", [
          { type: "solid", color: `#33${(at % 256).toString(16).padStart(2, "0")}55` },
        ]);
    }
  };
  // Everyone in, the file loaded.
  for (const i of [0, 1, 2]) join(i);
  while (room.inbox.length > 0) serve();
  for (const i of [0, 1, 2]) while ((clients[i]?.inbox.length ?? 0) > 0) deliver(i);
  for (const a of acts) {
    switch (a.kind) {
      case "edit":
        edit((clients[a.who] as (typeof clients)[number]).editor, a.what, a.at);
        break;
      case "flush":
        clients[a.who]?.editor.sync.flush();
        break;
      case "room":
        serve();
        break;
      case "deliver":
        deliver(a.who);
        break;
      case "drop":
        drop(a.who);
        break;
      case "join":
        // A reconnect (an offline client comes back; an online one's socket closes and opens
        // again), by snapshot or by catching up on what the room logged.
        (clients[a.who] as (typeof clients)[number]).snapshot = a.snapshot;
        drop(a.who);
        join(a.who);
        break;
      case "refuse":
        room.refuse = true;
        break;
      case "undo":
        clients[a.who]?.editor.undo();
        break;
      case "redo":
        clients[a.who]?.editor.redo();
        break;
    }
  }
  // Everyone back, everything sent and answered (a refusal asked for takes the next edit sent).
  for (let round = 0; round < 50; round++) {
    for (const i of [0, 1, 2]) join(i);
    for (const c of clients) c.editor.sync.flush();
    let moved = room.inbox.length > 0;
    while (room.inbox.length > 0) serve();
    for (const i of [0, 1, 2])
      while ((clients[i]?.inbox.length ?? 0) > 0) {
        moved = true;
        deliver(i);
      }
    if (!moved && clients.every((c) => c.editor.sync.pendingCount === 0)) break;
  }
  const sorted = (records: readonly NodeRecord[]) => [...records].map((r) => stable(r)).sort();
  const want = sorted(room.doc.stored());
  clients.forEach((c, i) => {
    expect(c.editor.sync.pendingCount, `client ${i} has nothing left to send`).toBe(0);
    expect(sorted(c.editor.doc.stored()), `client ${i} ends where the room does`).toEqual(want);
  });
}

describe("three clients converge with the room", () => {
  for (const copies of ["materialized", "compact"] as const)
    it(`with copies ${copies}`, () => {
      const runs = Number(process.env.FUZZ_RUNS) || 40;
      fc.assert(
        fc.property(fc.array(act, { minLength: 1, maxLength: 40 }), (acts) =>
          converge(copies, acts),
        ),
        { numRuns: runs },
      );
      // Each way an edit reaches the room happened somewhere.
      if (runs >= 40)
        for (const [what, count] of Object.entries(convergeSeen))
          expect(count, `${what}: ${JSON.stringify(convergeSeen)}`).toBeGreaterThan(0);
    }, 600_000);
});
