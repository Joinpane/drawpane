/**
 * Frame name labels: the names above top-level frames (artboards). Like
 * Figma and Penpot, an artboard holding layers is picked by its label, not
 * by clicking its empty area (which starts a marquee inside it instead), and
 * double-clicking the label renames it in place. The overlay draws these
 * labels and the pointer hit-tests them from the same geometry, so what you
 * see is exactly what you can click.
 *
 * Label layout (text truncation via `fit()` and measured width) depends only on
 * top-level frames, zoom, font generation, and prototyping flow starts -- not
 * on pan position (`camera.x`, `camera.y`). Caching page-space label layout
 * removes all `fit()` and `measurer.width()` calls during same-zoom panning and
 * during edits that do not touch top-level frames.
 */
import { getProp, type NodeRecord } from "@drawpane/model";
import type { Camera } from "./camera";
import type { Doc } from "./doc";
import type { Editor } from "./editor";
import type { Point, Rect } from "./geometry";
import { flowStartScreens } from "./prototype/overlay";
import type { TextMeasurer } from "./text";

/** The labels' font, for drawing and measuring alike. */
export const LABEL_FONT =
  '500 11px "Instrument Sans Variable", "Instrument Sans", system-ui, sans-serif';
/** Label height and its gap above the frame, in screen pixels. */
export const LABEL_HEIGHT = 16;
export const LABEL_GAP = 2;
/** Room for the component diamond before a component's or instance's name. */
export const LABEL_ICON = 12;

export interface FrameLabel {
  readonly id: string;
  /** The name as drawn: truncated with an ellipsis to the frame's width. */
  readonly text: string;
  /** The full name. */
  readonly name: string;
  /** Components and instances show a diamond before the name. */
  readonly kind: "frame" | "component" | "instance";
  /** Where the text starts and its baseline, in screen pixels. */
  readonly textX: number;
  readonly baseline: number;
  /** What a click on the label hits, in screen pixels. */
  readonly box: Rect;
}

interface CachedLabelEntry {
  readonly id: string;
  readonly text: string;
  readonly name: string;
  readonly kind: "frame" | "component" | "instance";
  readonly icon: number;
  /** Top-left frame corner in page coordinates. */
  readonly pageTlX: number;
  readonly pageTlY: number;
  /** Hit-test / draw box width in CSS pixels. */
  readonly boxWidth: number;
}

interface FitEntry {
  readonly text: string;
  readonly width: number;
}

interface LabelLayoutCache {
  docVersion: number;
  readonly pageId: string;
  readonly zoom: number;
  readonly measurer: TextMeasurer;
  readonly measurerGen: number;
  readonly prototyping: boolean;
  readonly flowStartsKey: string;
  readonly layoutVersion: number;
  /** All top-level child IDs of `pageId` when built, for incremental doc-change bypass. */
  readonly topIds: ReadonlySet<string>;
  readonly entries: readonly CachedLabelEntry[];
  /** Per-(name, room) fit cache kept across edits at the same measurer generation. */
  readonly fitCache: Map<string, FitEntry>;
  /** Full un-truncated width cache per label name at the same measurer generation. */
  readonly fullWidths: Map<string, number>;
  /** Measured width of a single ellipsis character at the same measurer generation. */
  readonly ellipsisWidth: number;
}

const layoutCaches = new WeakMap<Doc, LabelLayoutCache>();
let nextLayoutVersion = 1;
const MAX_FIT_CACHE = 2048;

/** A top-level frame, as opposed to one nested in another layer. */
function isTopLevelFrame(node: NodeRecord | undefined, pageId: string): node is NodeRecord {
  return node?.type === "frame" && node.parent === pageId;
}

/**
 * Whether a click on `id` itself (its empty area, not a layer in it) should
 * leave it alone: a top-level plain frame that holds layers. Components,
 * instances and empty frames still select by clicking anywhere on them.
 */
export function isArtboard(editor: Editor, id: string): boolean {
  const { pageId } = editor.s;
  const node = editor.doc.get(id);
  if (!pageId || !isTopLevelFrame(node, pageId)) return false;
  if (getProp(node.props, "isComponent") || getProp(node.props, "isComponentSet")) return false;
  if (getProp(node.props, "instanceOf") !== null) return false;
  return editor.doc.childIds(id).length > 0;
}

function projectLabel(entry: CachedLabelEntry, camera: Camera): FrameLabel {
  const tlX = entry.pageTlX * camera.zoom + camera.x;
  const tlY = entry.pageTlY * camera.zoom + camera.y;
  return {
    id: entry.id,
    text: entry.text,
    name: entry.name,
    kind: entry.kind,
    textX: tlX + entry.icon,
    baseline: tlY - LABEL_GAP - 4,
    // At least as wide as the frame's corner, so tiny or nameless frames stay pickable.
    box: {
      x: tlX,
      y: tlY - LABEL_GAP - LABEL_HEIGHT,
      width: entry.boxWidth,
      height: LABEL_HEIGHT,
    },
  };
}

function getLabelCache(editor: Editor): LabelLayoutCache | null {
  const { pageId, camera, prototyping } = editor.s;
  if (!pageId) return null;
  const doc = editor.doc;
  const measurer = editor.measurer;
  const measurerGen = measurer.generation ?? 0;
  const flowStarts = prototyping ? flowStartScreens(editor) : null;
  const flowStartsKey = flowStarts && flowStarts.size > 0 ? [...flowStarts].sort().join("\0") : "";
  const last = layoutCaches.get(doc);

  if (
    last &&
    last.pageId === pageId &&
    last.zoom === camera.zoom &&
    last.measurer === measurer &&
    last.measurerGen === measurerGen &&
    last.prototyping === prototyping &&
    last.flowStartsKey === flowStartsKey
  ) {
    if (last.docVersion === doc.version) return last;
    if (!prototyping) {
      const changes = doc.changesSince(last.docVersion);
      const topUnchanged =
        changes?.every(
          (change) =>
            !change.reset &&
            !change.parents.has(pageId) &&
            [...change.ids].every((id) => !last.topIds.has(id)),
        ) ?? false;
      if (topUnchanged) {
        last.docVersion = doc.version;
        return last;
      }
    }
  }

  // Reuse the text-fitting caches when the measurer and its font generation haven't changed.
  const sameMeasurer = last && last.measurer === measurer && last.measurerGen === measurerGen;
  const fitCache = sameMeasurer ? last.fitCache : new Map<string, FitEntry>();
  const fullWidths = sameMeasurer ? last.fullWidths : new Map<string, number>();
  const measure = (text: string) => measurer.width(LABEL_FONT, text);
  const ellipsisWidth = sameMeasurer ? last.ellipsisWidth : measure("…");
  if (fitCache.size > MAX_FIT_CACHE) fitCache.clear();
  if (fullWidths.size > MAX_FIT_CACHE) fullWidths.clear();

  const topIds = new Set<string>();
  const entries: CachedLabelEntry[] = [];

  for (const id of doc.childIds(pageId)) {
    topIds.add(id);
    const node = doc.get(id);
    // Flow starts wear the prototype's own label while prototyping.
    if (node?.type !== "frame" || node.props.visible === false || flowStarts?.has(id)) continue;
    const corners = editor.scene.corners(id);
    if (!corners) continue;
    const tl = corners[0] as Point;
    const tr = corners[1] as Point;
    const kind =
      getProp(node.props, "isComponent") || getProp(node.props, "isComponentSet")
        ? "component"
        : getProp(node.props, "instanceOf") !== null
          ? "instance"
          : "frame";
    const name = getProp(node.props, "name") || "Frame";
    const icon = kind === "frame" ? 0 : LABEL_ICON;
    // The label never runs past the frame: long names end in an ellipsis.
    // Room depends only on page-space edge length * zoom (independent of pan).
    const room = Math.max(0, Math.hypot(tr.x - tl.x, tr.y - tl.y) * camera.zoom - icon);
    let fullW = fullWidths.get(name);
    if (fullW === undefined) {
      fullW = measure(name);
      fullWidths.set(name, fullW);
    }
    let fitted: FitEntry | undefined;
    if (fullW <= room) {
      fitted = { text: name, width: fullW };
    } else if (room < ellipsisWidth) {
      fitted = { text: "", width: 0 };
    } else {
      const fitKey = `${name}\0${Math.floor(room * 2)}`;
      fitted = fitCache.get(fitKey);
      if (!fitted) {
        const text = fit(name, room, measure);
        const width = text ? measure(text) : 0;
        fitted = { text, width };
        fitCache.set(fitKey, fitted);
      }
    }
    entries.push({
      id,
      text: fitted.text,
      name,
      kind,
      icon,
      pageTlX: tl.x,
      pageTlY: tl.y,
      boxWidth: Math.max(24, icon + fitted.width),
    });
  }

  const next: LabelLayoutCache = {
    docVersion: doc.version,
    pageId,
    zoom: camera.zoom,
    measurer,
    measurerGen,
    prototyping,
    flowStartsKey,
    layoutVersion: nextLayoutVersion++,
    topIds,
    entries,
    fitCache,
    fullWidths,
    ellipsisWidth,
  };
  layoutCaches.set(doc, next);
  return next;
}

/** Monotonic layout version bumped only when top-level frame label geometry or text changes. */
export function frameLabelLayoutVersion(editor: Editor): number {
  return getLabelCache(editor)?.layoutVersion ?? 0;
}

/** The labels on the current page, bottom to top. */
export function frameLabels(editor: Editor): FrameLabel[] {
  const cache = getLabelCache(editor);
  if (!cache) return [];
  const { camera } = editor.s;
  return cache.entries.map((entry) => projectLabel(entry, camera));
}

/** Only the labels whose screen box (with optional margin) intersects `clip`, bottom to top. */
export function frameLabelsInRect(editor: Editor, clip: Rect, margin = 0): FrameLabel[] {
  const cache = getLabelCache(editor);
  if (!cache || cache.entries.length === 0) return [];
  const { camera } = editor.s;
  const zoom = camera.zoom;
  const camX = camera.x;
  const camY = camera.y;
  const minX = clip.x - margin;
  const minY = clip.y - margin;
  const maxX = clip.x + clip.width + margin;
  const maxY = clip.y + clip.height + margin;
  const out: FrameLabel[] = [];
  for (const entry of cache.entries) {
    const tlX = entry.pageTlX * zoom + camX;
    const tlY = entry.pageTlY * zoom + camY;
    const boxY = tlY - LABEL_GAP - LABEL_HEIGHT;
    if (tlX + entry.boxWidth < minX || tlX > maxX || boxY + LABEL_HEIGHT < minY || boxY > maxY) {
      continue;
    }
    out.push({
      id: entry.id,
      text: entry.text,
      name: entry.name,
      kind: entry.kind,
      textX: tlX + entry.icon,
      baseline: tlY - LABEL_GAP - 4,
      box: { x: tlX, y: boxY, width: entry.boxWidth, height: LABEL_HEIGHT },
    });
  }
  return out;
}

/** The topmost label under a screen point. */
export function frameLabelAt(editor: Editor, screen: Point): FrameLabel | null {
  const cache = getLabelCache(editor);
  if (!cache) return null;
  const { camera } = editor.s;
  const zoom = camera.zoom;
  const camX = camera.x;
  const camY = camera.y;
  for (let i = cache.entries.length - 1; i >= 0; i--) {
    const entry = cache.entries[i] as CachedLabelEntry;
    const tlX = entry.pageTlX * zoom + camX;
    const tlY = entry.pageTlY * zoom + camY;
    const boxY = tlY - LABEL_GAP - LABEL_HEIGHT;
    if (
      screen.x >= tlX &&
      screen.x <= tlX + entry.boxWidth &&
      screen.y >= boxY &&
      screen.y <= boxY + LABEL_HEIGHT
    ) {
      return projectLabel(entry, camera);
    }
  }
  return null;
}

/** `text` cut to fit `room` pixels, with an ellipsis; empty when not even that fits. */
export function fit(text: string, room: number, measure: (text: string) => number): string {
  if (measure(text) <= room) return text;
  const chars = [...text];
  let lo = 0;
  let hi = chars.length;
  // The longest prefix that fits with the ellipsis.
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measure(`${chars.slice(0, mid).join("").trimEnd()}…`) <= room) lo = mid;
    else hi = mid - 1;
  }
  return lo === 0 ? "" : `${chars.slice(0, lo).join("").trimEnd()}…`;
}
