/**
 * Branch review (decision 0012), as the review pane shows it: each change a
 * branch made, named by its layer and said in words ("Fill #16181d →
 * #2b4fd6"), conflicts first, and what merging takes given the choices made.
 */
import { layerName } from "@drawpane/editor";
import {
  type BranchChange,
  changeKey,
  type DocReader,
  type NodeRecord,
  POSITION,
  type Resolution,
} from "@drawpane/model";
import { count } from "../history/labels";

export type ChangeKind = BranchChange["kind"];

export interface ReviewRow {
  /** The change's key (see changeKey): what choices and skips name. */
  readonly key: string;
  readonly kind: ChangeKind;
  /** The layer it's about. */
  readonly id: string;
  readonly layer: string;
  /** What changed, in words: "Width 120 → 240", "New text layer". */
  readonly detail: string;
  /** Conflicts only: main's side and the branch's, in words. */
  readonly sides: { readonly main: string; readonly branch: string } | null;
  readonly conflict: boolean;
}

/** Property names as people say them; anything else is split from camelCase. */
const PROP_LABEL: Readonly<Record<string, string>> = {
  characters: "Text",
  fills: "Fill",
  strokes: "Stroke",
  strokeWeight: "Stroke weight",
  effects: "Effects",
  cornerRadius: "Corner radius",
  cornerRadii: "Corners",
  opacity: "Opacity",
  fontSize: "Font size",
  fontFamily: "Font",
  fontWeight: "Font weight",
  lineHeight: "Line height",
  letterSpacing: "Letter spacing",
  x: "X",
  y: "Y",
  width: "Width",
  height: "Height",
  rotation: "Rotation",
  visible: "Visibility",
  locked: "Lock",
  name: "Name",
  layoutMode: "Auto layout",
  itemSpacing: "Gap",
};

export function propLabel(prop: string): string {
  const known = PROP_LABEL[prop];
  if (known) return known;
  const words = prop.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const numberText = (n: number) => String(Math.round(n * 100) / 100);

/** A value, short enough for a row: numbers, quoted text, a paint's colour. */
export function valueText(prop: string, value: unknown): string {
  if (value === undefined || value === null) return "none";
  if (typeof value === "number")
    return prop === "opacity" ? `${Math.round(value * 100)}%` : numberText(value);
  if (typeof value === "boolean")
    return prop === "visible" ? (value ? "shown" : "hidden") : value ? "on" : "off";
  if (typeof value === "string") {
    const line = value.replace(/\s+/g, " ").trim();
    return `“${line.length > 24 ? `${line.slice(0, 23)}…` : line}”`;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return "none";
    const first = value[0] as { type?: unknown; color?: unknown } | null;
    if (first && first.type === "solid" && typeof first.color === "string")
      return value.length === 1 ? first.color : `${first.color} + ${value.length - 1}`;
    if (first && typeof first.type === "string")
      return value.length === 1 ? first.type : `${value.length} ${first.type}s`;
    if (value.every((v) => typeof v === "number")) return value.map(numberText).join(", ");
    return `${value.length}`;
  }
  return "changed";
}

interface Position {
  readonly parent: string;
  readonly key: string;
}

/** A move in words: into another layer, or along its siblings. */
function moveText(from: Position | undefined, to: Position, docs: Readers): string {
  if (from && from.parent === to.parent) return "Reordered";
  const parent = docs.branch.get(to.parent) ?? docs.main.get(to.parent);
  return parent ? `Moved into ${layerName(parent)}` : "Moved";
}

function changedText(change: Extract<BranchChange, { kind: "changed" }>, docs: Readers): string {
  if (change.field === POSITION)
    return moveText(change.base as Position | undefined, change.branch as Position, docs);
  const label = propLabel(change.field);
  const before = valueText(change.field, change.base);
  const after = valueText(change.field, change.branch);
  // Effects and the like say little as values: the label is enough.
  return before === "changed" || after === "changed" || before === after
    ? `${label} changed`
    : `${label} ${before} → ${after}`;
}

function sideText(
  change: Extract<BranchChange, { kind: "changed" }>,
  side: unknown,
  docs: Readers,
) {
  if (side === undefined) return "Deleted";
  if (change.field === POSITION)
    return moveText(change.base as Position | undefined, side as Position, docs);
  return `${propLabel(change.field)} ${valueText(change.field, side)}`;
}

const KIND_ADDED_LABEL: Readonly<Record<string, string>> = {
  text: "New text layer",
  frame: "New frame",
  group: "New group",
  page: "New page",
  image: "New image",
};

export interface Readers {
  readonly base: DocReader;
  readonly branch: DocReader;
  readonly main: DocReader;
}

/** Where a node comes in its document: pages first, then depth-first, parents before children. */
function documentOrder(docs: Readers): Map<string, number> {
  const order = new Map<string, number>();
  const visit = (doc: DocReader, id: string) => {
    if (!order.has(id)) order.set(id, order.size);
    for (const child of doc.childIds(id)) visit(doc, child);
  };
  for (const doc of [docs.branch, docs.base]) for (const page of doc.pageIds()) visit(doc, page);
  return order;
}

/** The review's rows: conflicts first, then in the order the layers come in the file. */
export function reviewRows(changes: readonly BranchChange[], docs: Readers): ReviewRow[] {
  const order = documentOrder(docs);
  const rows = changes.map((change): ReviewRow => {
    const node: NodeRecord | undefined =
      docs.branch.get(change.id) ?? docs.base.get(change.id) ?? docs.main.get(change.id);
    const layer = node ? layerName(node) : "Layer";
    const key = changeKey(change);
    if (change.kind === "added")
      return {
        key,
        kind: "added",
        id: change.id,
        layer,
        detail:
          change.conflict === "parent-gone"
            ? "New layer, in a layer main deleted"
            : (KIND_ADDED_LABEL[node?.type ?? ""] ?? "New layer"),
        sides: change.conflict ? { main: "Its layer is deleted", branch: "Added" } : null,
        conflict: change.conflict !== null,
      };
    if (change.kind === "removed")
      return {
        key,
        kind: "removed",
        id: change.id,
        layer,
        detail: change.conflict ? "Deleted here, edited on main" : "Deleted",
        sides: change.conflict ? { main: "Edited", branch: "Deleted" } : null,
        conflict: change.conflict !== null,
      };
    return {
      key,
      kind: "changed",
      id: change.id,
      layer,
      detail: changedText(change, docs),
      sides: change.conflict
        ? {
            main: sideText(change, change.main, docs),
            branch: sideText(change, change.branch, docs),
          }
        : null,
      conflict: change.conflict,
    };
  });
  const at = (row: ReviewRow) => order.get(row.id) ?? Number.MAX_SAFE_INTEGER;
  return rows.sort((a, b) => Number(b.conflict) - Number(a.conflict) || at(a) - at(b));
}

export interface ReviewChoices {
  /** Each decided conflict's side. */
  readonly resolutions: ReadonlyMap<string, Resolution>;
  /** Changes left out. */
  readonly skipped: ReadonlySet<string>;
}

export interface MergePlan {
  /** Changes merging takes. */
  readonly included: number;
  readonly total: number;
  /** Conflicts still to decide (among those not left out). */
  readonly undecided: number;
  readonly conflicts: number;
  /** Ready to merge: something to take, nothing undecided. */
  readonly ready: boolean;
}

export function mergePlan(rows: readonly ReviewRow[], choices: ReviewChoices): MergePlan {
  const kept = rows.filter((r) => !choices.skipped.has(r.key));
  const undecided = kept.filter((r) => r.conflict && !choices.resolutions.has(r.key)).length;
  // A conflict resolved for main takes nothing from the branch.
  const included = kept.filter(
    (r) => !r.conflict || choices.resolutions.get(r.key) === "branch",
  ).length;
  return {
    included,
    total: rows.length,
    undecided,
    conflicts: rows.filter((r) => r.conflict).length,
    ready: undecided === 0 && included > 0,
  };
}

/** The counts the review's header shows. */
export function kindCounts(rows: readonly ReviewRow[]): Record<ChangeKind, number> {
  const counts: Record<ChangeKind, number> = { added: 0, changed: 0, removed: 0 };
  for (const row of rows) counts[row.kind]++;
  return counts;
}

/** Said after bringing main's latest changes into a branch. */
export function updatedNotice(main: string, changes: number, kept: number): string {
  if (changes === 0 && kept === 0) return `Already up to date with ${main}.`;
  const took =
    changes > 0
      ? `Brought in ${count(changes, "change")} from ${main}.`
      : `Nothing new to bring in from ${main}.`;
  return kept > 0
    ? `${took} Where you'd both changed the same thing, this branch's version stays: review shows it against ${main}.`
    : took;
}
