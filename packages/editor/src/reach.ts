/**
 * How far past its bounds a layer can paint, in page units: what culling
 * pads a layer by, and what a change to it may repaint.
 */
import { getProp, type NodeRecord } from "@drawpane/model";
import { paintOutset } from "./export";
import { markerLength } from "./markers";
import { postEffects, postReach } from "./post-effects";

/**
 * What the renderer pads a layer's bounds by when it culls (besides a
 * margin in screen pixels for strokes and type): its drop shadows, end
 * markers, and the blur and texture that spread all of it.
 */
export function effectReach(node: NodeRecord): number {
  let reach = 0;
  const effects = getProp(node.props, "effects");
  for (const e of effects)
    if (e.visible !== false && e.type === "drop-shadow")
      reach = Math.max(reach, Math.abs(e.x) + Math.abs(e.y) + e.blur * 2 + Math.max(0, e.spread));
  if (
    (node.type === "line" || node.type === "path") &&
    (getProp(node.props, "markerStart") !== "none" || getProp(node.props, "markerEnd") !== "none")
  )
    reach = Math.max(reach, markerLength(getProp(node.props, "strokeWeight")));
  // Blur and texture spread everything above: their reach adds.
  return reach + postReach(postEffects(effects));
}

/**
 * A margin all round that holds everything the layer paints outside its
 * bounds: the cull's reach and the export's outset (strokes outside the box
 * included), grown for rotation, since bounds are upright and the outset
 * runs along the layer's own axes.
 */
export function paintMargin(node: NodeRecord): number {
  const o = paintOutset(node);
  const outset = Math.max(o.left, o.top, o.right, o.bottom);
  return Math.max(effectReach(node), outset * Math.SQRT2);
}
