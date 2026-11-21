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
  mergeOps,
  type NodeRecord,
  nodeReader,
  type Op,
  ROOT_ID,
} from "@drawpane/model";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { canMoveInto, wouldCycle } from "../src/components";
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
function snapshot(doc: Doc): Record<string, unknown> {
  const out: Record<string, unknown> = {};
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
  const out: unknown[] = [...layoutOps(doc, frames, { shrinkEmpty, keepEmpty })];
  for (const node of all) {
    if (node.type !== "text") continue;
    const size = autoSize(node, measurer);
    if (!size) continue;
    const r = (v: number) => Math.round(v * 100) / 100;
    // A bound size is its variable's, whatever the text measures (decision 0034).
    const bound = getProp(node.props, "bindings");
    if (!bound.width && r(size.width) !== r(getProp(node.props, "width")))
      out.push({ text: node.id, width: [getProp(node.props, "width"), r(size.width)] });
    if (!bound.height && r(size.height) !== r(getProp(node.props, "height")))
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
  main: fc.nat(1),
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
          ...(i ? { bindings: { visible: VARIABLES.show } } : {}),
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
  | { kind: "text"; at: number; words: number }
  | { kind: "nudge"; at: number; dx: number; dy: number }
  | { kind: "move"; at: number; into: number }
  | { kind: "delete"; at: number }
  | { kind: "group" | "ungroup"; at: number }
  | { kind: "bind"; at: number; binding: number }
  | { kind: "unbind"; at: number; binding: number }
  | { kind: "variable"; variable: number; mode: number; value: number }
  | { kind: "mode"; at: number; mode: number }
  | { kind: "swap" | "detach" | "reset"; at: number }
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
  fc.record({ kind: fc.constantFrom("bind" as const, "unbind" as const), at, binding: fc.nat(4) }),
  fc.record({
    kind: fc.constant("variable" as const),
    variable: fc.nat(3),
    mode: fc.nat(1),
    value: fc.nat(1),
  }),
  fc.record({ kind: fc.constant("mode" as const), at, mode: fc.nat(2) }),
  fc.record({ kind: fc.constantFrom("swap" as const, "detach" as const, "reset" as const), at }),
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
  "undo",
  "undo-redo",
];

const BINDINGS: Array<[BindingKey, string]> = [
  ["visible", VARIABLES.show],
  ["visible", VARIABLES.shown],
  ["paddingLeft", VARIABLES.pad],
  ["gap", VARIABLES.gap],
  ["width", VARIABLES.pad],
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
  // Issue 283: a turned empty frame's Fill and Hug can land on one axis, with two answers.
  rotate: (node) => node.type !== "frame",
  ungroup: (node) => node.type === "group",
  swap: isInstance,
  detach: isInstance,
  reset: (node) => getProp(node.props, "overrides").length > 0,
  unbind: (node) => Object.keys(getProp(node.props, "bindings")).length > 0,
};

/** Makes the edit through the editor's own commands, on a layer it applies to. */
function perform(editor: Editor, e: Edit): void {
  const doc = editor.doc;
  if (e.kind === "undo") {
    editor.undo();
    return;
  }
  if (e.kind === "undo-redo") {
    // Back where it was, layout and all.
    const before = snapshot(doc);
    // Issue 280: redoing a main's delete empties the instances that kept its layers. Issue
    // 281: redo re-derives materialized copies' layers where the edit didn't.
    const orphaned = layers(doc).some((n) => {
      const source = getProp(n.props, "mirrors");
      return !!source && !doc.has(source);
    });
    editor.undo();
    editor.redo();
    if (doc.compactCopies && !orphaned) expect(snapshot(doc), "undone and redone").toEqual(before);
    return;
  }
  if (e.kind === "variable") {
    const variable = [VARIABLES.show, VARIABLES.shown, VARIABLES.pad, VARIABLES.gap][
      e.variable
    ] as string;
    const mode = e.mode ? "dark" : "light";
    editor.setVariableValue(variable, mode, e.variable < 2 ? e.value === 1 : e.value ? 14 : 3);
    return;
  }
  const all = layers(doc);
  const [binding, variable] = BINDINGS[e.kind === "bind" ? e.binding : 0] as [BindingKey, string];
  const fits =
    e.kind === "bind" && (binding === "paddingLeft" || binding === "gap")
      ? isFrame
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
    case "delete":
      editor.select([id]);
      editor.deleteSelection();
      break;
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
      const to = getProp(node.props, "instanceOf") === "main0" ? "main1" : "main0";
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
  }
}

function makeEditor(nodes: readonly NodeRecord[] | null, copies: "compact" | "materialized") {
  const editor = new Editor({ measurer, clientId: "oracle" });
  editor.state.set({ role: "editor", viewport: { width: 1200, height: 800 } });
  if (nodes) editor.doc.resetStored(nodes, copies);
  else
    editor.doc.apply([
      { op: "create", id: "p", type: "page", parent: ROOT_ID, key: "a0", props: { name: "Page" } },
    ]);
  editor.setPage("p");
  return editor;
}

function check(
  editor: Editor,
  mirror: Doc,
  copies: "compact" | "materialized",
  step: string,
  before?: ReadonlyMap<string, FrameState>,
) {
  expect(unsettled(editor.doc, before), `a full layout changes nothing ${step}`).toEqual([]);
  const now = snapshot(editor.doc);
  const reloaded = new Doc();
  reloaded.resetStored(editor.doc.stored(), copies);
  expect(snapshot(reloaded), `read back from its stored form ${step}`).toEqual(now);
  const sent = editor.sync.takeUnsent();
  if (sent.length > 0) mirror.applyStored(sent, { held: true });
  expect(snapshot(mirror), `replayed ${step}`).toEqual(now);
}

describe("an edit leaves the document as a full layout would", () => {
  for (const copies of ["materialized", "compact"] as const)
    it(`with copies ${copies}`, () => {
      const runs = Number(process.env.FUZZ_RUNS) || 40;
      /** How many edits of each kind changed the document. */
      const ran = new Map<Edit["kind"], number>(KINDS.map((k) => [k, 0]));
      fc.assert(
        fc.property(tree, fc.array(edit, { minLength: 1, maxLength: 16 }), (spec, edits) => {
          const editor = makeEditor(null, copies);
          if (copies === "compact" && !editor.doc.compactCopies)
            editor.doc.resetStored(editor.doc.stored(), "compact");
          build(editor, spec);
          const start = editor.doc.stored();
          const mirror = new Doc();
          mirror.resetStored(editor.doc.stored(), copies);
          editor.sync.takeUnsent();
          check(editor, mirror, copies, "after making it");
          const history: string[] = [];
          for (const e of edits) {
            // What an undo restores is the document as it was, empty frames' boxes included.
            const undoing = e.kind === "undo" || e.kind === "undo-redo";
            const before = undoing ? undefined : frameStates(editor.doc);
            const version = editor.doc.version;
            perform(editor, e);
            if (editor.doc.version !== version) ran.set(e.kind, (ran.get(e.kind) ?? 0) + 1);
            history.push(JSON.stringify(e));
            check(editor, mirror, copies, `after ${history.join(", ")}`, before);
          }
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
        }),
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
