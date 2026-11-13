/**
 * The crop session: which image fill is being cropped, and the commands that
 * start, change and end it. The editor's `cropping` state names the layer
 * and paint; the crop tool (tools/crop.ts) does the dragging.
 */
import { getProp, type NodeRecord, type Op, type Paint } from "@drawpane/model";
import {
  clampBox,
  cropFromPlacement,
  cropOfBox,
  type ImagePaint,
  imageRect,
  presetBox,
} from "./crop";
import type { Editor } from "./editor";
import { apply, boxOf, localMatrix, type Rect, round2 } from "./geometry";
import type { Size } from "./images";

/** The topmost visible image fill of a layer, with its index, or null. */
export function croppableImage(
  node: NodeRecord | undefined,
): { paint: ImagePaint; index: number } | null {
  if (!node || node.type === "group" || node.type === "page" || node.type === "text") return null;
  const fills = getProp(node.props, "fills");
  for (let i = fills.length - 1; i >= 0; i--) {
    const paint = fills[i] as Paint;
    if (paint.type === "image" && paint.visible !== false) return { paint, index: i };
  }
  return null;
}

/** The layer and paint being cropped, if the session is still valid. */
export function croppingTarget(
  editor: Editor,
): { node: NodeRecord; paint: ImagePaint; index: number } | null {
  const c = editor.s.cropping;
  if (!c) return null;
  const node = editor.doc.get(c.id);
  const paint = node ? getProp(node.props, "fills")[c.index] : undefined;
  if (!node || paint?.type !== "image") return null;
  return { node, paint, index: c.index };
}

/**
 * Operations that move and resize a layer to a new box given in its current
 * local coordinates (rotation kept), with its image fill showing `crop`.
 */
export function cropOps(
  node: NodeRecord,
  index: number,
  paint: ImagePaint,
  box: Rect,
  crop: ImagePaint["crop"],
): Op[] {
  const b = boxOf(node);
  const centre = apply(localMatrix(b), { x: box.x + box.width / 2, y: box.y + box.height / 2 });
  const fills = getProp(node.props, "fills").map((p, i) =>
    i === index ? { ...paint, scaleMode: "crop" as const, ...(crop ? { crop } : {}) } : p,
  );
  const ops: Op[] = [{ op: "set", id: node.id, prop: "fills", value: fills }];
  const set = (prop: "x" | "y" | "width" | "height", value: number) => {
    const v = round2(value);
    if (v !== round2(getProp(node.props, prop)))
      ops.push({ op: "set", id: node.id, prop, value: v });
  };
  set("x", centre.x - box.width / 2);
  set("y", centre.y - box.height / 2);
  set("width", box.width);
  set("height", box.height);
  return ops;
}

/**
 * Starts cropping a layer's image fill (double-click, ↵, the menu). A fill
 * that isn't cropped yet becomes one showing exactly what it shows now; a
 * fit image's box shrinks to the image. `natural` is the image's own size,
 * needed only for that first conversion.
 */
export function enterCrop(editor: Editor, id: string, natural: Size | null): boolean {
  if (!editor.canEdit) return false;
  const node = editor.doc.get(id);
  const image = croppableImage(node);
  if (!node || !image) return false;
  const { paint, index } = image;
  if (paint.scaleMode !== "crop") {
    if (!natural) {
      editor.notify("The image is still loading. Try again in a moment.");
      return false;
    }
    const box = { width: getProp(node.props, "width"), height: getProp(node.props, "height") };
    const { crop, box: shown } = cropFromPlacement(imageRect(paint, box, natural), box);
    editor.commit(cropOps(node, index, paint, shown, crop), "Crop image");
  }
  editor.select([id]);
  editor.state.set({ cropping: { id, index }, editingText: null, vectorEdit: null });
  return true;
}

export function exitCrop(editor: Editor): void {
  if (editor.s.cropping) editor.state.set({ cropping: null });
}

/** An aspect preset (width / height), or null for free: the largest box of that shape. */
export function setCropAspect(editor: Editor, ratio: number | null): void {
  const target = croppingTarget(editor);
  if (!target || ratio === null) return;
  const { node, paint, index } = target;
  const box = { width: getProp(node.props, "width"), height: getProp(node.props, "height") };
  const image = imageRect(paint, box, { width: 1, height: 1 });
  const next = clampBox(presetBox(image, { x: 0, y: 0, ...box }, ratio), image);
  editor.commit(cropOps(node, index, paint, next, cropOfBox(image, next)), "Crop aspect");
}

/** Ends the session when its layer goes, loses its image, or the selection moves on. */
export function reconcileCrop(editor: Editor): void {
  const c = editor.s.cropping;
  if (!c) return;
  const { selection, tool } = editor.s;
  if (
    !croppingTarget(editor) ||
    tool !== "select" ||
    selection.length !== 1 ||
    selection[0] !== c.id
  )
    editor.state.set({ cropping: null });
}
