/**
 * Masks, like Figma's: a layer marked as a mask clips the layers above it in
 * the same parent, up to the next mask, and isn't drawn itself. One rule,
 * read by the renderer, SVG export, hit testing and group bounds.
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
 * A parent's children in order (bottom first), each with the mask that clips
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
    return { id, isMask: false, mask };
  });
}

/** True when the parent has a mask among its children. Cheap check before scoping. */
export function hasMask(doc: Doc, parentId: string): boolean {
  return doc.childIds(parentId).some((id) => isActiveMask(doc.get(id)));
}
