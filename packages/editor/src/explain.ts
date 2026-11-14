/**
 * Explain: why a layer is the size it is, in words and arithmetic. "Why is
 * Upcoming 196 px tall? Height hugs its children in a vertical stack: 12 +
 * 3 × 52 + 2 × 8 + 12." Follows the same rules as the layout engine (hug
 * adds up children, padding and gaps; fill shares what its parent has left;
 * stretch takes the cross axis; min and max clamp), from the document as it
 * is, so the numbers add up to what's on the canvas.
 */
import { getProp, type NodeRecord } from "@drawpane/model";
import type { Doc } from "./doc";

export type ExplainAxis = "width" | "height";

export interface ExplainTerm {
  readonly label: string;
  /** Its share of the size (negative when it's taken away). */
  readonly value: number;
  readonly kind: "padding" | "child" | "gap" | "parent" | "hidden" | "text" | "limit";
  /** How many equal parts make it (3 rows, 2 gaps), for "3 × 52" in the sum. */
  readonly times?: number;
  /** Layers this term counts, to select them. */
  readonly ids?: readonly string[];
}

export type ExplainAction =
  | { readonly kind: "fix"; readonly label: string }
  | { readonly kind: "hug"; readonly label: string }
  | { readonly kind: "select"; readonly label: string; readonly ids: readonly string[] };

export interface Explanation {
  readonly axis: ExplainAxis;
  readonly size: number;
  /** "Why is Upcoming 196 px tall?" */
  readonly question: string;
  /** One sentence: what decides it. */
  readonly answer: string;
  readonly terms: readonly ExplainTerm[];
  /** "12 + 3 × 52 + 2 × 8 + 12", when the size is a sum of the terms. */
  readonly formula: string | null;
  readonly actions: readonly ExplainAction[];
}

const n = (v: number) => String(Math.round(v * 100) / 100);
const name = (node: NodeRecord) => getProp(node.props, "name") || node.type;
const sizeOf = (node: NodeRecord, axis: ExplainAxis) => getProp(node.props, axis);
const sizingOf = (node: NodeRecord, axis: ExplainAxis) =>
  getProp(node.props, axis === "width" ? "sizingH" : "sizingV");
const isLayout = (node: NodeRecord | undefined): node is NodeRecord =>
  node?.type === "frame" && getProp(node.props, "layoutMode") !== "none";

/** The frame's flow direction for an axis: along it (main) or across it. */
function along(frame: NodeRecord, axis: ExplainAxis): "main" | "cross" | "grid" {
  const mode = getProp(frame.props, "layoutMode");
  if (mode === "grid") return "grid";
  return (mode === "row") === (axis === "width") ? "main" : "cross";
}

function paddings(frame: NodeRecord, axis: ExplainAxis): [number, number, string, string] {
  const p = frame.props;
  return axis === "width"
    ? [getProp(p, "paddingLeft"), getProp(p, "paddingRight"), "left", "right"]
    : [getProp(p, "paddingTop"), getProp(p, "paddingBottom"), "top", "bottom"];
}

/** A frame's children in its flow: visible, laid out (not absolute). */
function flowChildren(doc: Doc, frame: NodeRecord) {
  const visible: NodeRecord[] = [];
  let hidden = 0;
  let absolute = 0;
  for (const id of doc.childIds(frame.id)) {
    const c = doc.get(id);
    if (!c) continue;
    if (!getProp(c.props, "visible")) hidden++;
    else if (getProp(c.props, "positioning") === "absolute") absolute++;
    else visible.push(c);
  }
  return { visible, hidden, absolute };
}

/** Children grouped by name, sizing and size: "3 × Event row · fixed 52". */
function grouped(children: readonly NodeRecord[], axis: ExplainAxis): ExplainTerm[] {
  const groups = new Map<string, { nodes: NodeRecord[]; size: number; sizing: string }>();
  for (const c of children) {
    const size = sizeOf(c, axis);
    const sizing = c.type === "text" ? "text" : sizingOf(c, axis);
    const key = `${name(c)}\u0000${sizing}\u0000${n(size)}`;
    const g = groups.get(key) ?? { nodes: [], size, sizing };
    g.nodes.push(c);
    groups.set(key, g);
  }
  return [...groups.values()].map((g) => ({
    label: `${g.nodes.length > 1 ? `${g.nodes.length} × ` : ""}${name(g.nodes[0] as NodeRecord)} · ${g.sizing} ${n(g.size)}`,
    value: g.size * g.nodes.length,
    kind: "child" as const,
    times: g.nodes.length,
    ids: g.nodes.map((c) => c.id),
  }));
}

function formulaOf(terms: readonly ExplainTerm[]): string {
  return terms
    .filter((t) => t.value !== 0)
    .map((t, i) => {
      const abs = Math.abs(t.value);
      const part = t.times && t.times > 1 ? `${t.times} × ${n(abs / t.times)}` : n(abs);
      return i === 0 ? (t.value < 0 ? `−${part}` : part) : `${t.value < 0 ? "−" : "+"} ${part}`;
    })
    .join(" ");
}

/** Notes a min or max that held the size back. */
function clampNote(node: NodeRecord, axis: ExplainAxis, raw: number): ExplainTerm | null {
  const [min, max] =
    axis === "width"
      ? [getProp(node.props, "minWidth"), getProp(node.props, "maxWidth")]
      : [getProp(node.props, "minHeight"), getProp(node.props, "maxHeight")];
  if (max !== null && raw > max)
    return { label: `Held at its max ${axis}`, value: max - raw, kind: "limit" };
  if (min !== null && raw < min)
    return { label: `Held at its min ${axis}`, value: min - raw, kind: "limit" };
  return null;
}

/** Whether a layer's size on an axis is set by hand, fills its parent, or hugs what's inside. */
export function sizeMode(doc: Doc, id: string, axis: ExplainAxis): "fixed" | "fill" | "hug" {
  const node = doc.get(id);
  if (!node) return "fixed";
  if (node.type === "text") {
    const mode = getProp(node.props, "textAutoResize");
    if (axis === "width" ? mode === "width" : mode !== "none") return "hug";
  }
  const sizing = sizingOf(node, axis);
  const parent = doc.get(node.parent);
  if (isLayout(parent) && getProp(node.props, "positioning") === "auto") {
    if (sizing === "fill") return "fill";
    if (sizing === "fixed" && along(parent, axis) === "cross" && stretches(node, parent))
      return "fill";
  }
  return sizing === "hug" && isLayout(node) ? "hug" : "fixed";
}

/** Whether a layer takes its auto layout parent's cross axis (align stretch). */
function stretches(node: NodeRecord, parent: NodeRecord): boolean {
  const self = getProp(node.props, "alignSelf");
  return self === "auto" ? getProp(parent.props, "alignItems") === "stretch" : self === "stretch";
}

export function explainSize(doc: Doc, id: string, axis: ExplainAxis): Explanation | null {
  const node = doc.get(id);
  if (!node || node.type === "page") return null;
  const size = sizeOf(node, axis);
  const tall = axis === "width" ? "wide" : "tall";
  const question = `Why is ${name(node)} ${n(size)} px ${tall}?`;
  const Axis = axis === "width" ? "Width" : "Height";
  const parent = doc.get(node.parent);
  const base = { axis, size, question };
  const fix: ExplainAction = { kind: "fix", label: `Set fixed ${axis}` };

  if (node.type === "group")
    return {
      ...base,
      answer: "A group's box is the bounds of the layers in it.",
      terms: [],
      formula: null,
      actions: [],
    };

  // Text sizes itself to its words unless its box is fixed.
  if (node.type === "text") {
    const mode = getProp(node.props, "textAutoResize");
    if (axis === "width" && mode === "width")
      return {
        ...base,
        answer: "Width hugs the text: as wide as its longest line.",
        terms: [],
        formula: null,
        actions: [],
      };
    if (axis === "height" && mode !== "none")
      return {
        ...base,
        answer: "Height grows with the text: one line box per line.",
        terms: [],
        formula: null,
        actions: [],
      };
  }

  const sizing = sizingOf(node, axis);
  const inLayout = isLayout(parent) && getProp(node.props, "positioning") === "auto";

  // Fill: what the parent has left.
  if (inLayout && parent) {
    const direction = along(parent, axis);
    const [startPad, endPad, startName, endName] = paddings(parent, axis);
    const stretched =
      direction === "cross" && sizing !== "hug" && (sizing === "fill" || stretches(node, parent));
    if (stretched) {
      const terms: ExplainTerm[] = [
        {
          label: `${name(parent)} is ${n(sizeOf(parent, axis))}`,
          value: sizeOf(parent, axis),
          kind: "parent",
          ids: [parent.id],
        },
        { label: `Padding ${startName}`, value: -startPad, kind: "padding" },
        { label: `Padding ${endName}`, value: -endPad, kind: "padding" },
      ];
      const clamp = clampNote(node, axis, sizeOf(parent, axis) - startPad - endPad);
      if (clamp) terms.push(clamp);
      return {
        ...base,
        answer: `${Axis} is ${sizing === "fill" ? "Fill" : "stretched"}: ${name(parent)} is ${n(sizeOf(parent, axis))}, minus ${n(startPad)} ${startName} and ${n(endPad)} ${endName} padding.`,
        terms,
        formula: formulaOf(terms),
        actions: [fix, { kind: "select", label: `Select ${name(parent)}`, ids: [parent.id] }],
      };
    }
    if (sizing === "fill" && direction === "main") {
      const { visible } = flowChildren(doc, parent);
      const fills = visible.filter((c) => sizingOf(c, axis) === "fill");
      const others = visible.filter((c) => sizingOf(c, axis) !== "fill");
      const gap = getProp(parent.props, "gap");
      const gaps = Math.max(0, visible.length - 1);
      const terms: ExplainTerm[] = [
        {
          label: `${name(parent)} is ${n(sizeOf(parent, axis))}`,
          value: sizeOf(parent, axis),
          kind: "parent",
          ids: [parent.id],
        },
        { label: `Padding ${startName}`, value: -startPad, kind: "padding" },
        { label: `Padding ${endName}`, value: -endPad, kind: "padding" },
        ...grouped(others, axis).map((t) => ({ ...t, value: -t.value })),
        ...(gaps > 0
          ? [
              {
                label: `${gaps} ${gaps === 1 ? "gap" : "gaps"} of ${n(gap)}`,
                value: -gap * gaps,
                kind: "gap" as const,
                times: gaps,
              },
            ]
          : []),
      ];
      const left = terms.reduce((s, t) => s + t.value, 0);
      const share = fills.length > 1 ? ` ÷ ${fills.length}` : "";
      const clamp = clampNote(node, axis, left / Math.max(1, fills.length));
      if (clamp) terms.push(clamp);
      return {
        ...base,
        answer:
          fills.length > 1
            ? `${Axis} is Fill: it shares what ${name(parent)} has left with ${fills.length - 1} other Fill ${fills.length === 2 ? "layer" : "layers"}.`
            : `${Axis} is Fill: it takes what ${name(parent)} has left after its padding, gaps and other layers.`,
        terms,
        formula: `(${formulaOf(terms.filter((t) => t.kind !== "limit"))})${share}`,
        actions: [fix, { kind: "select", label: `Select ${name(parent)}`, ids: [parent.id] }],
      };
    }
  }

  // Hug: what's inside, plus padding and gaps.
  if (sizing === "hug" && isLayout(node)) {
    const direction = along(node, axis);
    const [startPad, endPad, startName, endName] = paddings(node, axis);
    const { visible, hidden, absolute } = flowChildren(doc, node);
    const terms: ExplainTerm[] = [
      { label: `Padding ${startName}`, value: startPad, kind: "padding" },
    ];
    let answer: string;
    if (direction === "main" && !getProp(node.props, "layoutWrap")) {
      const gap = getProp(node.props, "gap");
      const gaps = Math.max(0, visible.length - 1);
      terms.push(...grouped(visible, axis));
      if (gaps > 0)
        terms.push({
          label: `${gaps} ${gaps === 1 ? "gap" : "gaps"} of ${n(gap)}`,
          value: gap * gaps,
          kind: "gap",
          times: gaps,
        });
      answer = `${Axis} hugs its children in a ${getProp(node.props, "layoutMode") === "row" ? "horizontal row" : "vertical stack"}.`;
    } else if (direction === "cross" && !getProp(node.props, "layoutWrap")) {
      const tallest = visible.reduce<NodeRecord | null>(
        (m, c) => (!m || sizeOf(c, axis) > sizeOf(m, axis) ? c : m),
        null,
      );
      if (tallest)
        terms.push({
          label: `${name(tallest)}, the ${axis === "width" ? "widest" : "tallest"}`,
          value: sizeOf(tallest, axis),
          kind: "child",
          ids: [tallest.id],
        });
      answer = `${Axis} hugs its ${axis === "width" ? "widest" : "tallest"} child.`;
    } else {
      // Wrapped lines and grid tracks: the content box as laid out.
      const content = sizeOf(node, axis) - startPad - endPad;
      terms.push({
        label: direction === "grid" ? "Its tracks and gaps" : "Its wrapped lines and line gaps",
        value: content,
        kind: "child",
        ids: visible.map((c) => c.id),
      });
      answer = `${Axis} hugs its ${direction === "grid" ? "grid" : "wrapped lines"}.`;
    }
    terms.push({ label: `Padding ${endName}`, value: endPad, kind: "padding" });
    const sum = terms.reduce((s, t) => s + t.value, 0);
    const clamp = clampNote(node, axis, sum);
    if (clamp) terms.push(clamp);
    if (hidden > 0)
      terms.push({
        label: `${hidden} hidden ${hidden === 1 ? "layer" : "layers"}, not counted`,
        value: 0,
        kind: "hidden",
      });
    if (absolute > 0)
      terms.push({
        label: `${absolute} absolute ${absolute === 1 ? "layer" : "layers"}, not counted`,
        value: 0,
        kind: "hidden",
      });
    const biggest = terms
      .filter((t) => t.kind === "child" && t.ids?.length)
      .sort((a, b) => b.value - a.value)[0];
    return {
      ...base,
      answer,
      terms,
      formula: formulaOf(terms.filter((t) => t.kind !== "hidden" && t.kind !== "limit")),
      actions: [
        fix,
        ...(biggest?.ids && biggest.ids.length > 0
          ? [
              {
                kind: "select" as const,
                label: `Select ${name(doc.get(biggest.ids[0] as string) as NodeRecord)}`,
                ids: biggest.ids,
              },
            ]
          : []),
      ],
    };
  }

  // Fixed: set by hand (and maybe moving with a resizing parent).
  const actions: ExplainAction[] = isLayout(node) ? [{ kind: "hug", label: "Hug contents" }] : [];
  if (parent && parent.type === "frame" && !inLayout) {
    const constraint = getProp(node.props, axis === "width" ? "constraintH" : "constraintV");
    if (constraint === "stretch" || constraint === "scale")
      return {
        ...base,
        answer: `${Axis} is fixed at ${n(size)}, and ${constraint === "stretch" ? "stretches" : "scales"} with ${name(parent)} when it's resized.`,
        terms: [],
        formula: null,
        actions,
      };
  }
  return {
    ...base,
    answer: `${Axis} is fixed at ${n(size)}: set by hand.`,
    terms: [],
    formula: null,
    actions,
  };
}
