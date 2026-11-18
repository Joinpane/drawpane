/**
 * Masks, like Figma's: a layer marked as a mask masks the layers above it in
 * the same parent, and isn't drawn itself. Its scope ends at the next mask,
 * at the end of the parent, or at a frame that clips its content, which
 * shows unmasked, with everything above it up to the next mask. Figma's
 * help says so ("The mask applies to all siblings above it until it
 * reaches: another mask …, the mask's parent frame or group, a frame or
 * component with clip content on"), and its renders agree: a popover's
 * arrow masks the material over it, not the card's background above that.
 * One rule, read by the renderer, SVG export (and so headless renders), hit
 * testing, group bounds and the layers panel.
 */
import { getProp, type NodeRecord, propAllowed } from "@drawpane/model";
import type { Doc } from "./doc";

/** A layer that masks the layers above it now: marked, maskable, and visible. */
export function isActiveMask(node: NodeRecord | undefined): node is NodeRecord {
  return (
    node !== undefined &&
    propAllowed(node.type, "isMask") &&
    getProp(node.props, "isMask") &&
    node.props.visible !== false
  );
}

/**
 * A layer that ends the scope of a mask below it: a visible frame that clips
 * its content (a component's copy is a frame too). A hidden one draws
 * nothing and, like a hidden mask, changes nothing.
 */
export function endsMask(node: NodeRecord | undefined): boolean {
  return (
    node !== undefined &&
    node.type === "frame" &&
    getProp(node.props, "clipContent") &&
    node.props.visible !== false
  );
}

/** Layers whose outline is one filled shape: as outline masks, they clip by that shape. */
const SHAPED = new Set(["frame", "rect", "ellipse", "polygon", "star", "path"]);

/**
 * Whether a mask masks by a clip to its shape: an outline mask that's one
 * filled shape. Any other mask (by alpha or luminance, or an outline mask
 * made of a group, a text or a line) masks by its picture: what it draws,
 * its opacity made full for an outline mask ("vector masks ignore the
 * translucency", Figma's help says).
 */
export function clipsByShape(mask: NodeRecord): boolean {
  return getProp(mask.props, "maskType") === "outline" && SHAPED.has(mask.type);
}

/**
 * A parent's children in order (bottom first), each with the mask that masks
 * it, if any. Masks themselves come with `mask: null` and `isMask: true`.
 */
export function maskScopes(
  doc: Doc,
  parentId: string,
): Array<{ id: string; isMask: boolean; mask: NodeRecord | null }> {
  let mask: NodeRecord | null = null;
  return doc.childIds(parentId).map((id) => {
    const node = doc.get(id);
    if (isActiveMask(node)) {
      mask = node;
      return { id, isMask: true, mask: null };
    }
    if (mask && endsMask(node)) mask = null;
    return { id, isMask: false, mask };
  });
}

/** True when the parent has a mask among its children. Cheap check before scoping. */
export function hasMask(doc: Doc, parentId: string): boolean {
  return doc.childIds(parentId).some((id) => isActiveMask(doc.get(id)));
}
