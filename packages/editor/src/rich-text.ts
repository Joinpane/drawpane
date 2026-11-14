/**
 * Rich text: styling part of a text layer (a bold word, a coloured phrase, a
 * bigger first line) with runs, like Figma's character overrides.
 *
 * A layer's own typography and fill are its base style. `textRuns` lists
 * [start, end) ranges of `characters` (UTF-16 code units, as the browser's
 * text selection counts them) that override some of it. This module keeps
 * runs tidy, styles a range, remaps runs when the characters change (typed
 * text takes the style of the character before it), and reads back what a
 * range looks like, for the inspector.
 *
 * Writes are derived in the same transaction as a person's edit
 * (`textRunOps`), so every way of changing text keeps its runs in step.
 */
import {
  getProp,
  type NodeRecord,
  type Op,
  type PropName,
  type Props,
  type TextRun,
} from "@drawpane/model";
import type { Doc } from "./doc";

/** What a run can override: the typography that varies within a line, and the fill. */
export const RUN_PROPS = [
  "fontFamily",
  "fontWeight",
  "fontStyle",
  "fontSize",
  "letterSpacing",
  "textCase",
  "textDecoration",
  "fills",
] as const satisfies readonly (keyof TextRun & PropName)[];
export type RunProp = (typeof RUN_PROPS)[number];

/** A run's overrides, without its range. */
export type RunStyle = { -readonly [K in RunProp]?: TextRun[K] };
/** Overrides to apply to a range; null takes a property back to the layer's value. */
export type RunPatch = { [K in RunProp]?: TextRun[K] | null };

const RUN_PROP_SET: ReadonlySet<string> = new Set(RUN_PROPS);
export const isRunProp = (prop: string): prop is RunProp => RUN_PROP_SET.has(prop);

const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

function styleOf(run: RunStyle): RunStyle {
  const out: Record<string, unknown> = {};
  for (const p of RUN_PROPS) if (run[p] !== undefined) out[p] = run[p];
  return out as RunStyle;
}
const sameStyle = (a: RunStyle, b: RunStyle) => RUN_PROPS.every((p) => same(a[p], b[p]));
const isEmpty = (s: RunStyle) => RUN_PROPS.every((p) => s[p] === undefined);

/** A styled stretch of the text; gaps between runs have an empty style. */
interface Segment {
  start: number;
  end: number;
  style: RunStyle;
}

/**
 * Runs as a tidy list: in order, inside the text, not overlapping (a later
 * run wins), neighbours with the same style merged. With `base`, overrides
 * equal to the layer's own value are dropped, and so are runs left empty.
 */
export function normalizeRuns(runs: readonly TextRun[], length: number, base?: Props): TextRun[] {
  if (runs.length === 0 || length <= 0) return [];
  const clamp = (n: number) => Math.min(Math.max(0, Math.round(n)), length);
  const ordered = [...runs].sort((a, b) => a.start - b.start);
  const cuts = new Set<number>();
  for (const r of ordered) {
    cuts.add(clamp(r.start));
    cuts.add(clamp(r.end));
  }
  const points = [...cuts].sort((a, b) => a - b);
  const out: Segment[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i] as number;
    const b = points[i + 1] as number;
    let style: RunStyle = {};
    for (const r of ordered) {
      if (r.start > a) break;
      if (r.end >= b) style = { ...style, ...styleOf(r) };
    }
    if (base)
      for (const p of RUN_PROPS)
        if (style[p] !== undefined && same(style[p], getProp(base, p))) delete style[p];
    if (isEmpty(style)) continue;
    const last = out.at(-1);
    if (last && last.end === a && sameStyle(last.style, style)) last.end = b;
    else out.push({ start: a, end: b, style });
  }
  return out.map(toRun);
}

const toRun = (s: Segment): TextRun => ({ start: s.start, end: s.end, ...s.style });

/** Every stretch of [0, length), styled or not, in order. `runs` must be tidy. */
function coverage(runs: readonly TextRun[], length: number): Segment[] {
  const out: Segment[] = [];
  let at = 0;
  for (const r of runs) {
    if (r.start > at) out.push({ start: at, end: r.start, style: {} });
    out.push({ start: r.start, end: r.end, style: styleOf(r) });
    at = r.end;
  }
  if (at < length || out.length === 0) out.push({ start: at, end: length, style: {} });
  return out;
}

const tidyCache = new WeakMap<readonly TextRun[], { length: number; runs: TextRun[] }>();
/** A layer's runs, tidy for its current characters (cached: layout reads this every frame). */
export function layerRuns(node: NodeRecord): TextRun[] {
  const runs = getProp(node.props, "textRuns");
  if (runs.length === 0) return [];
  const length = getProp(node.props, "characters").length;
  const hit = tidyCache.get(runs);
  if (hit && hit.length === length) return hit.runs;
  const tidy = normalizeRuns(runs, length);
  tidyCache.set(runs, { length, runs: tidy });
  return tidy;
}

/** The layer's props with a run's overrides on top: what a stretch of text is drawn with. */
export function withRunStyle(props: Props, style: RunStyle): Props {
  return isEmpty(style) ? props : ({ ...props, ...style } as Props);
}

export interface TextSpan {
  readonly start: number;
  readonly end: number;
  /** The resolved props for this stretch. */
  readonly props: Props;
  /** Its overrides: what differs from the layer. */
  readonly own: RunStyle;
}

/** The whole text as spans of one style each, in order (one span for plain text). */
export function textSpans(node: NodeRecord): TextSpan[] {
  const length = getProp(node.props, "characters").length;
  const runs = layerRuns(node);
  if (runs.length === 0) return [{ start: 0, end: length, props: node.props, own: {} }];
  return coverage(runs, length).map((s) => ({
    start: s.start,
    end: s.end,
    props: withRunStyle(node.props, s.style),
    own: s.style,
  }));
}

/** The style typing at `index` continues: the character before it, or the first one. */
export function runStyleAt(node: NodeRecord, index: number): RunStyle {
  const runs = layerRuns(node);
  const at = index > 0 ? index - 1 : 0;
  const run = runs.find((r) => r.start <= at && at < r.end);
  return run ? styleOf(run) : {};
}

/** The runs after styling [start, end) with `patch`. */
export function styleRange(
  node: NodeRecord,
  start: number,
  end: number,
  patch: RunPatch,
): TextRun[] {
  const length = getProp(node.props, "characters").length;
  const a = Math.max(0, Math.min(start, end));
  const b = Math.min(length, Math.max(start, end));
  const runs = layerRuns(node);
  if (b <= a) return runs;
  const out: Segment[] = [];
  for (const seg of coverage(runs, length)) {
    if (seg.end <= a || seg.start >= b) {
      out.push(seg);
      continue;
    }
    if (seg.start < a) out.push({ ...seg, end: a });
    const style: RunStyle = { ...seg.style };
    for (const p of RUN_PROPS) {
      const value = patch[p];
      if (value === undefined) continue;
      if (value === null) delete style[p];
      else (style as Record<string, unknown>)[p] = value;
    }
    out.push({ start: Math.max(seg.start, a), end: Math.min(seg.end, b), style });
    if (seg.end > b) out.push({ ...seg, start: b });
  }
  return normalizeRuns(out.filter((s) => !isEmpty(s.style)).map(toRun), length, node.props);
}

const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;

/** Where an edit happened, when the editor knows: the selection it replaced, and the caret after. */
export interface TextEdit {
  readonly start: number;
  readonly end: number;
  readonly caret: number;
}

/**
 * The runs after the characters change from the layer's to `after`: text
 * before and after the edit keeps its style. Inserted text takes `inserted`;
 * or the style of the first character it replaces; or, typed at a caret, the
 * style of the character before it (the first after it, at the very start),
 * the way typing continues a style everywhere.
 *
 * Comparing strings alone can't always tell where an edit was ("Plan week"
 * to "Plan b week" could be "b " after "Plan " or " b" after "Plan"), so the
 * editor passes `edit` when it knows; otherwise the longest common prefix and
 * suffix decide.
 */
export function remapRuns(
  node: NodeRecord,
  after: string,
  options: { inserted?: RunStyle; edit?: TextEdit } = {},
): TextRun[] {
  const before = getProp(node.props, "characters");
  const runs = layerRuns(node);
  if (before === after) return runs;
  const { inserted } = options;
  if (runs.length === 0 && (!inserted || isEmpty(inserted))) return [];
  const { p, oldEnd } = editSpan(before, after, options.edit);
  const added = after.length - before.length + (oldEnd - p);
  const delta = after.length - before.length;
  const cov = coverage(runs, before.length);
  // Replacing characters continues the first one replaced; typing, the one before.
  const inherit = inserted ?? styleAtSegment(cov, oldEnd > p ? p : p > 0 ? p - 1 : oldEnd);
  const out: Segment[] = [];
  for (const seg of cov) {
    if (seg.start < p) out.push({ start: seg.start, end: Math.min(seg.end, p), style: seg.style });
    if (seg.end > oldEnd)
      out.push({
        start: Math.max(seg.start, oldEnd) + delta,
        end: seg.end + delta,
        style: seg.style,
      });
  }
  if (added > 0) out.push({ start: p, end: p + added, style: inherit });
  out.sort((x, y) => x.start - y.start);
  return normalizeRuns(
    out.filter((x) => !isEmpty(x.style) && x.end > x.start).map(toRun),
    after.length,
    node.props,
  );
}

/** What changed: [p, oldEnd) of `before` became [p, p + added) of `after`. */
function editSpan(before: string, after: string, edit?: TextEdit): { p: number; oldEnd: number } {
  if (edit) {
    const p = Math.min(edit.start, edit.end);
    const oldEnd = Math.max(edit.start, edit.end);
    const tail = before.length - oldEnd;
    // Trust the editor's account only when it explains the change exactly.
    if (
      oldEnd <= before.length &&
      edit.caret >= p &&
      after.length - edit.caret === tail &&
      before.slice(0, p) === after.slice(0, p) &&
      before.slice(oldEnd) === after.slice(edit.caret)
    )
      return { p, oldEnd };
  }
  const max = Math.min(before.length, after.length);
  let p = 0;
  while (p < max && before.charCodeAt(p) === after.charCodeAt(p)) p++;
  // Never split a surrogate pair.
  if (p > 0 && isHigh(before.charCodeAt(p - 1))) p--;
  let s = 0;
  while (
    s < max - p &&
    before.charCodeAt(before.length - 1 - s) === after.charCodeAt(after.length - 1 - s)
  )
    s++;
  return { p, oldEnd: before.length - s };
}

function styleAtSegment(cov: readonly Segment[], index: number): RunStyle {
  return cov.find((s) => s.start <= index && index < s.end)?.style ?? {};
}

/**
 * The distinct looks of [start, end), as the layer's props with each one's
 * overrides (one entry when the range is all alike). An empty range reads
 * the style typing there would get.
 */
export function rangeProps(node: NodeRecord, start: number, end: number): Props[] {
  const a = Math.min(start, end);
  const b = Math.max(start, end);
  if (a === b) return [withRunStyle(node.props, runStyleAt(node, a))];
  const out: Props[] = [];
  const seen: RunStyle[] = [];
  for (const span of textSpans(node)) {
    if (span.end <= a || span.start >= b) continue;
    if (seen.some((s) => sameStyle(s, span.own))) continue;
    seen.push(span.own);
    out.push(span.props);
  }
  return out.length > 0 ? out : [node.props];
}

/** Whether any of the layer's characters are styled differently from the layer. */
export const hasRuns = (node: NodeRecord) => layerRuns(node).length > 0;

/** Typography a text style sets; applying a style clears these from the runs (fills stay). */
const STYLE_TYPOGRAPHY: readonly RunProp[] = RUN_PROPS.filter((p) => p !== "fills");

/**
 * Keeping runs in step with a person's edit, derived in the same batch:
 * changed characters remap the runs; a run property set on the whole layer
 * leaves every run (the layer is now all that value); applying a text style
 * clears the runs' typography. Batches that write `textRuns` themselves are
 * left alone.
 */
export function textRunOps(doc: Doc, ops: readonly Op[]): Op[] {
  const explicit = new Set(
    ops.filter((o) => o.op === "set" && o.prop === "textRuns").map((o) => o.id),
  );
  const state = new Map<string, NodeRecord>();
  for (const op of ops) {
    if (op.op !== "set" || explicit.has(op.id)) continue;
    const current = state.get(op.id) ?? doc.get(op.id);
    if (current?.type !== "text") continue;
    const runs = getProp(current.props, "textRuns");
    if (op.prop === "characters") {
      const next = remapRuns(current, typeof op.value === "string" ? op.value : "");
      state.set(op.id, withProps(current, { characters: op.value, textRuns: next }));
      continue;
    }
    if (runs.length === 0) continue;
    let strip: readonly RunProp[] = [];
    if (isRunProp(op.prop)) strip = [op.prop];
    else if (op.prop === "textStyle" && op.value !== null) strip = STYLE_TYPOGRAPHY;
    if (strip.length === 0) continue;
    const next = runs.map((r) => {
      const copy: Record<string, unknown> = { ...r };
      for (const p of strip) delete copy[p];
      return copy as TextRun;
    });
    const length = getProp(current.props, "characters").length;
    state.set(op.id, withProps(current, { textRuns: normalizeRuns(next, length) }));
  }
  const out: Op[] = [];
  for (const [id, node] of state) {
    const before = doc.get(id);
    const next = getProp(node.props, "textRuns");
    if (before && !same(getProp(before.props, "textRuns"), next))
      out.push({ op: "set", id, prop: "textRuns", value: next.length > 0 ? next : null });
  }
  return out;
}

function withProps(node: NodeRecord, patch: Record<string, unknown>): NodeRecord {
  return { ...node, props: { ...node.props, ...patch } as Props };
}

export interface TextFace {
  readonly family: string;
  readonly weight: number;
  readonly italic: boolean;
}

/** Every face a text layer is set in (its own, and its runs'), each once. */
export function textFaces(node: NodeRecord): TextFace[] {
  const out = new Map<string, TextFace>();
  for (const span of textSpans(node)) {
    const face = {
      family: getProp(span.props, "fontFamily"),
      weight: getProp(span.props, "fontWeight"),
      italic: getProp(span.props, "fontStyle") === "italic",
    };
    out.set(`${face.family}\u0000${face.weight}\u0000${face.italic}`, face);
  }
  return [...out.values()];
}
