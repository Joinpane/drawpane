/**
 * Every edit leaves the document as a full layout of the whole document
 * would: whatever an edit lays out, laying out everything afresh afterwards
 * changes nothing. The oracles here share nothing with the commit pipeline
 * (which layers an edit counts as changed, which it lays out, which empty
 * frames shrink): only the layout engine run whole, the text measurer, and
 * the stored form.
 *
 * After every edit:
 * - a full layout of every layout frame in the document makes no changes;
 * - auto-sized text is the size it measures at;
 * - the document read back from its stored form is the same (a reload);
 * - another document that applied the stored operations is the same (a
 *   collaborator, or patch replay).
 * At the end, merging the run into the document it started from, as a
 * branch merges, gives the same document.
 *
 * The documents are made in the editor (laid out as made): auto layout
 * frames, text that wraps and hugs, groups with absolute members,
 * constraints, two components and their instances, and variables with two
 * modes bound to visibility, padding and gaps. The edits are the editor's
 * own commands, on any layer, copies inside instances included.
 */
import {
  type BindingKey,
  branchChanges,
  getProp,
  mergeOps,
  type NodeRecord,
  nodeReader,
  type Op,
  ROOT_ID,
} from "@drawpane/model";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
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

/** What laying out the whole document afresh would still change, and text that measures otherwise. */
function unsettled(doc: Doc): unknown[] {
  const all = layers(doc);
  const frames = all.filter((n) => n.type === "frame").map((n) => n.id);
  const out: unknown[] = [...layoutOps(doc, frames)];
  for (const node of all) {
    if (node.type !== "text") continue;
    const size = autoSize(node, measurer);
    if (!size) continue;
    const r = (v: number) => Math.round(v * 100) / 100;
    if (r(size.width) !== r(getProp(node.props, "width")))
      out.push({ text: node.id, width: [getProp(node.props, "width"), r(size.width)] });
    if (r(size.height) !== r(getProp(node.props, "height")))
      out.push({ text: node.id, height: [getProp(node.props, "height"), r(size.height)] });
  }
  return out;
}

type Kind = "rect" | "text" | "frame" | "group" | "instance";
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
  const key = () => `a${String(n).padStart(4, "0")}`;
  editor.commit([
    {
      op: "create",
      id: "c",
      type: "collection",
      parent: ROOT_ID,
      key: "b0",
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
  // Two components: a hugging row with a text and a padded inner row, and a column.
  const mains: string[] = [];
  for (const [i, mode] of (["row", "column"] as const).entries()) {
    const main = `main${i}`;
    mains.push(main);
    editor.commit([
      {
        op: "create",
        id: main,
        type: "frame",
        parent: "p",
        key: `m${i}`,
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
  const make = (s: Spec, parent: string) => {
    if (s.kind === "instance") {
      editor.select([]);
      const made = editor.insertInstance(mains[s.main] as string, { x: 2000, y: 2000 });
      if (made) editor.commit([{ op: "move", id: made, parent, key: key() }]);
      return;
    }
    if (s.kind === "group") {
      const group = id();
      editor.commit([
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
      // Not on auto-sized text: a constraint that stretches it leaves it a width its words don't
      // fit while it still sizes itself, on main too (found by this test, left for constraints).
      ...(s.absolute
        ? { positioning: "absolute", constraintH: s.kind === "text" ? "min" : "stretch" }
        : {}),
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
    editor.commit([{ op: "create", id: own, type: s.kind, parent, key: key(), props }]);
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
  | { kind: "constraint"; at: number; value: "min" | "max" | "stretch" | "center" | "scale" }
  | { kind: "text"; at: number; words: number }
  | { kind: "nudge"; at: number; dx: number; dy: number }
  | { kind: "move"; at: number; into: number }
  | { kind: "delete"; at: number }
  | { kind: "group"; at: number }
  | { kind: "bind"; at: number; binding: number }
  | { kind: "unbind"; at: number; binding: number }
  | { kind: "variable"; variable: number; mode: number; value: number }
  | { kind: "mode"; at: number; mode: number }
  | { kind: "swap"; at: number }
  | { kind: "undo" }
  | { kind: "redo" };

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
    value: fc.constantFrom(
      "min" as const,
      "max" as const,
      "stretch" as const,
      "center" as const,
      "scale" as const,
    ),
  }),
  fc.record({ kind: fc.constant("text" as const), at, words: fc.integer({ min: 0, max: 8 }) }),
  fc.record({
    kind: fc.constant("nudge" as const),
    at,
    dx: fc.integer({ min: -12, max: 12 }),
    dy: fc.integer({ min: -6, max: 6 }),
  }),
  fc.record({ kind: fc.constant("move" as const), at, into: at }),
  fc.record({ kind: fc.constant("delete" as const), at }),
  fc.record({ kind: fc.constant("group" as const), at }),
  fc.record({ kind: fc.constantFrom("bind" as const, "unbind" as const), at, binding: fc.nat(4) }),
  fc.record({
    kind: fc.constant("variable" as const),
    variable: fc.nat(3),
    mode: fc.nat(1),
    value: fc.nat(1),
  }),
  fc.record({ kind: fc.constant("mode" as const), at, mode: fc.nat(2) }),
  fc.record({ kind: fc.constant("swap" as const), at }),
  fc.constantFrom({ kind: "undo" as const }, { kind: "redo" as const }),
);

const BINDINGS: Array<[BindingKey, string]> = [
  ["visible", VARIABLES.show],
  ["visible", VARIABLES.shown],
  ["paddingLeft", VARIABLES.pad],
  ["gap", VARIABLES.gap],
  ["width", VARIABLES.pad],
];

/** Makes the edit through the editor's own commands. */
function perform(editor: Editor, e: Edit): void {
  const doc = editor.doc;
  if (e.kind === "undo") {
    editor.undo();
    return;
  }
  if (e.kind === "redo") {
    editor.redo();
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
  const node = all[e.at % Math.max(1, all.length)];
  if (!node) return;
  const id = node.id;
  const frame = node.type === "frame";
  switch (e.kind) {
    case "size":
      editor.resize([id], e.prop, e.value);
      break;
    case "sizing":
      editor.setProp([id], e.prop, e.value);
      break;
    case "padding":
      if (frame) editor.setProp([id], "paddingLeft", e.value);
      break;
    case "gap":
      if (frame) editor.setProp([id], "gap", e.value);
      break;
    case "layoutMode":
      if (frame) editor.setLayoutMode([id], e.value);
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
      // See `build`: auto-sized text keeps the default constraint.
      if (node.type !== "text" || getProp(node.props, "textAutoResize") === "none")
        editor.setProp([id], "constraintH", e.value);
      break;
    case "text":
      if (node.type === "text")
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
      const frames = all.filter((f) => f.type === "frame" && f.id !== id);
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
    case "bind": {
      const [binding, variable] = BINDINGS[e.binding] as [BindingKey, string];
      editor.bindVariable([id], binding, variable);
      break;
    }
    case "unbind": {
      const [binding] = BINDINGS[e.binding] as [BindingKey, string];
      editor.unbindVariable([id], binding);
      break;
    }
    case "mode":
      if (frame) editor.setVariableModes([id], "c", [null, "light", "dark"][e.mode] ?? null);
      break;
    case "swap": {
      const from = e.at % Math.max(1, all.length);
      const instance = all.find((n, i) => i >= from && getProp(n.props, "instanceOf"));
      const of = instance && getProp(instance.props, "instanceOf");
      if (instance && of) editor.swapInstance(instance.id, of === "main0" ? "main1" : "main0");
      break;
    }
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

function check(editor: Editor, mirror: Doc, copies: "compact" | "materialized", step: string) {
  expect(unsettled(editor.doc), `a full layout changes nothing ${step}`).toEqual([]);
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
            perform(editor, e);
            history.push(JSON.stringify(e));
            check(editor, mirror, copies, `after ${history.join(", ")}`);
          }
          // Merged back into where it started, as a branch is.
          const mainDoc = new Doc();
          mainDoc.resetStored(start, copies);
          const mainReader = nodeReader(start);
          const branchReader = nodeReader(editor.doc.stored());
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
        { numRuns: Number(process.env.FUZZ_RUNS) || 40 },
      );
    }, 600_000);
});
