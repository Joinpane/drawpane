/**
 * How a layer casts its drop shadow, as Figma draws it (decision 0031).
 *
 * A layer that fills something visible casts the shadow from its shape,
 * grown by the spread, under the layer. Where its fill is see-through the
 * shadow shows through it, unless the shadow says not to (`showBehind:
 * false`, Figma's "Show behind transparent areas" off): then it's cut out
 * under the shape.
 *
 * A layer that fills nothing visible (no fills, hidden ones, or only fully
 * transparent ones) gets no shadow from its shape in Figma: the shadow is
 * cast from what it draws instead (its strokes and children), and spread
 * doesn't grow it. Here that's drawn from the outline without spread, and
 * only outside it, which is what such a shadow looks like around a panel
 * that fills the layer. A focus ring (spread, no offset, no blur) round a
 * see-through field draws nothing, as in Figma.
 *
 * Under an opaque fill nothing would show, so the shadow isn't cut out
 * there, whatever it says: edges stay as they were drawn. (A faded layer
 * with a shadow fades as one picture, decision 0013, so its fill still
 * hides the shadow.)
 */
import { type Effect, getProp, type NodeRecord, type Paint } from "@drawpane/model";

/** How a drop shadow is drawn: the spread its shape grows by, and whether it's cut out under the shape. */
export interface DropShadowCast {
  readonly spread: number;
  readonly cutOut: boolean;
}

/** A colour's alpha, 0 to 1, from "#rrggbb" or "#rrggbbaa". */
const alphaOf = (hex: string) => (hex.length === 9 ? Number.parseInt(hex.slice(7), 16) / 255 : 1);

/** Whether a paint shows anything at all. */
function shows(paint: Paint): boolean {
  if (paint.visible === false || (paint.opacity ?? 1) <= 0) return false;
  if (paint.type === "solid") return alphaOf(paint.color) > 0;
  if (paint.type === "image") return true;
  return paint.stops.some((s) => alphaOf(s.color) > 0);
}

/** Whether a paint covers the whole shape with no see-through part. */
function opaque(paint: Paint): boolean {
  if (paint.visible === false || (paint.opacity ?? 1) < 1) return false;
  if (paint.blendMode !== undefined && paint.blendMode !== "normal") return false;
  if (paint.type === "solid") return alphaOf(paint.color) >= 1;
  if (paint.type === "image") return false;
  return paint.stops.every((s) => alphaOf(s.color) >= 1);
}

/** How `node` casts the drop shadow `shadow`. Text casts from its glyphs, as it always has. */
export function dropShadowCast(node: NodeRecord, shadow: Effect): DropShadowCast {
  if (shadow.type !== "drop-shadow") return { spread: 0, cutOut: false };
  if (node.type === "text") return { spread: shadow.spread, cutOut: false };
  const fills = getProp(node.props, "fills");
  if (!fills.some(shows)) return { spread: 0, cutOut: true };
  if (fills.some(opaque)) return { spread: shadow.spread, cutOut: false };
  return { spread: shadow.spread, cutOut: shadow.showBehind === false };
}
