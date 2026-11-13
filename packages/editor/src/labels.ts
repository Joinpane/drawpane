/**
 * Frame name labels: the names above top-level frames (artboards). Like
 * Figma and Penpot, an artboard holding layers is picked by its label, not
 * by clicking its empty area (which starts a marquee inside it instead), and
 * double-clicking the label renames it in place. The overlay draws these
 * labels and the pointer hit-tests them from the same geometry, so what you
 * see is exactly what you can click.
 */
import { getProp, type NodeRecord } from "@drawpane/model";
import type { Editor } from "./editor";
import type { Point, Rect } from "./geometry";
import { flowStartScreens } from "./prototype/overlay";

/** The labels' font, for drawing and measuring alike. */
export const LABEL_FONT =
  '500 11px "Instrument Sans Variable", "Instrument Sans", system-ui, sans-serif';
/** Label height and its gap above the frame, in screen pixels. */
const HEIGHT = 16;
const GAP = 2;
/** Room for the component diamond before a component's or instance's name. */
const ICON = 12;

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

/** The labels on the current page, bottom to top. */
export function frameLabels(editor: Editor): FrameLabel[] {
  const { pageId, camera } = editor.s;
  if (!pageId) return [];
  const flowStarts = flowStartScreens(editor);
  const measure = (text: string) => editor.measurer.width(LABEL_FONT, text);
  const out: FrameLabel[] = [];
  for (const id of editor.doc.childIds(pageId)) {
    const node = editor.doc.get(id);
    // Flow starts wear the prototype's own label while prototyping.
    if (node?.type !== "frame" || node.props.visible === false || flowStarts.has(id)) continue;
    const corners = editor.scene.corners(id);
    if (!corners) continue;
    const [tl, tr] = corners.map((c) => camera.toScreen(c)) as [Point, Point];
    const kind =
      getProp(node.props, "isComponent") || getProp(node.props, "isComponentSet")
        ? "component"
        : getProp(node.props, "instanceOf") !== null
          ? "instance"
          : "frame";
    const name = getProp(node.props, "name") || "Frame";
    const icon = kind === "frame" ? 0 : ICON;
    // The label never runs past the frame: long names end in an ellipsis.
    const room = Math.max(0, Math.hypot(tr.x - tl.x, tr.y - tl.y) - icon);
    const text = fit(name, room, measure);
    const width = text ? measure(text) : 0;
    out.push({
      id,
      text,
      name,
      kind,
      textX: tl.x + icon,
      baseline: tl.y - GAP - 4,
      // At least as wide as the frame's corner, so tiny or nameless frames stay pickable.
      box: { x: tl.x, y: tl.y - GAP - HEIGHT, width: Math.max(24, icon + width), height: HEIGHT },
    });
  }
  return out;
}

/** The topmost label under a screen point. */
export function frameLabelAt(editor: Editor, screen: Point): FrameLabel | null {
  const labels = frameLabels(editor);
  for (let i = labels.length - 1; i >= 0; i--) {
    const label = labels[i] as FrameLabel;
    const b = label.box;
    if (
      screen.x >= b.x &&
      screen.x <= b.x + b.width &&
      screen.y >= b.y &&
      screen.y <= b.y + b.height
    )
      return label;
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
