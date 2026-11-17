/**
 * Where a drop shadow shows, as Figma draws it. A shadow is cast from the
 * layer's shape grown by its spread, and drawn under the layer. Under the
 * layer's own shape it's cut out when the shadow says so (`behind: false`,
 * Figma's "Show behind transparent areas" off), and whenever nothing the
 * layer fills is visible (no fills, or only fully transparent ones): a focus
 * ring around a see-through field is a ring, never a tinted field. Only a
 * partly see-through fill shows a shadow through it, when asked to.
 */
import { type Effect, getProp, type NodeRecord, type Paint } from "@drawpane/model";

/** A colour's alpha, 0 to 1, from "#rrggbb" or "#rrggbbaa". */
const alphaOf = (hex: string) => (hex.length === 9 ? Number.parseInt(hex.slice(7), 16) / 255 : 1);

/** Whether a paint shows anything at all. */
function shows(paint: Paint): boolean {
  if (paint.visible === false || (paint.opacity ?? 1) <= 0) return false;
  if (paint.type === "solid") return alphaOf(paint.color) > 0;
  if (paint.type === "image") return true;
  return paint.stops.some((s) => alphaOf(s.color) > 0);
}

/** Whether a drop shadow is cut out under its layer's shape. */
export function shadowCutOut(node: NodeRecord, shadow: Effect): boolean {
  if (shadow.type !== "drop-shadow" || node.type === "text") return false;
  if (shadow.behind === false) return true;
  if (node.type === "group" || node.type === "page") return false;
  return !getProp(node.props, "fills").some(shows);
}
