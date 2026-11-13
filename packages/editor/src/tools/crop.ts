/**
 * The crop tool, active while an image fill is being cropped: drag inside
 * the box to slide the image under it, drag a handle to crop more or less
 * (Shift keeps the shape), ↵ or Escape to finish, a click outside to leave.
 * Each drag is one undo step, committed as it goes so others see it live,
 * and computed from where things were when the drag began.
 */
import { getProp, type NodeRecord } from "@drawpane/model";
import { clampBox, cropOfBox, type ImagePaint, imageRect, pannedCrop } from "../crop";
import { cropOps, croppingTarget } from "../crop-session";
import type { Editor } from "../editor";
import { apply, invert, type Matrix, type Point, type Rect } from "../geometry";
import type { HandleId, PointerInput } from "../interaction";
import { resizeCursor } from "../interaction";
import { DRAG_PX, type KeyInput, PICK_PX, type ToolHandler } from "./types";

const HANDLES: ReadonlyArray<{ id: HandleId; u: number; v: number }> = [
  { id: "nw", u: 0, v: 0 },
  { id: "n", u: 0.5, v: 0 },
  { id: "ne", u: 1, v: 0 },
  { id: "e", u: 1, v: 0.5 },
  { id: "se", u: 1, v: 1 },
  { id: "s", u: 0.5, v: 1 },
  { id: "sw", u: 0, v: 1 },
  { id: "w", u: 0, v: 0.5 },
];

interface Start {
  readonly node: NodeRecord;
  readonly index: number;
  readonly paint: ImagePaint;
  readonly world: Matrix;
  readonly box: { readonly width: number; readonly height: number };
  /** The whole image, in the layer's local space at the start. */
  readonly image: Rect;
  readonly screen: Point;
  readonly local: Point;
}

type Drag = { kind: "pan" | "resize"; handle: HandleId | null; start: Start; moved: boolean };

export class CropTool implements ToolHandler {
  readonly #editor: Editor;
  #drag: Drag | null = null;
  cursor = "default";

  constructor(editor: Editor) {
    this.#editor = editor;
  }

  get busy(): boolean {
    return this.#drag !== null;
  }

  /** Screen positions of the crop box's handles, for drawing and picking. */
  handles(): Array<{ id: HandleId; at: Point }> {
    const target = croppingTarget(this.#editor);
    if (!target) return [];
    const { node } = target;
    const w = getProp(node.props, "width");
    const h = getProp(node.props, "height");
    const world = this.#editor.scene.worldMatrix(node.id);
    const camera = this.#editor.s.camera;
    return HANDLES.map((handle) => ({
      id: handle.id,
      at: camera.toScreen(apply(world, { x: handle.u * w, y: handle.v * h })),
    }));
  }

  #snapshot(screen: Point): Start | null {
    const editor = this.#editor;
    const target = croppingTarget(editor);
    if (!target) return null;
    const { node, paint, index } = target;
    const box = { width: getProp(node.props, "width"), height: getProp(node.props, "height") };
    const world = editor.scene.worldMatrix(node.id);
    return {
      node,
      index,
      paint,
      world,
      box,
      image: imageRect(paint, box, { width: 1, height: 1 }),
      screen,
      local: apply(invert(world), editor.s.camera.toPage(screen)),
    };
  }

  #inside(start: Start): boolean {
    return (
      start.local.x >= 0 &&
      start.local.y >= 0 &&
      start.local.x <= start.box.width &&
      start.local.y <= start.box.height
    );
  }

  #handleAt(screen: Point): HandleId | null {
    for (const h of this.handles()) {
      if (Math.abs(h.at.x - screen.x) <= PICK_PX + 2 && Math.abs(h.at.y - screen.y) <= PICK_PX + 2)
        return h.id;
    }
    return null;
  }

  down(input: PointerInput): boolean {
    if (input.button !== 0) return false;
    const start = this.#snapshot(input.screen);
    if (!start) return false;
    const handle = this.#handleAt(input.screen);
    if (handle) {
      this.#drag = { kind: "resize", handle, start, moved: false };
      return true;
    }
    if (this.#inside(start)) {
      this.#drag = { kind: "pan", handle: null, start, moved: false };
      this.cursor = "grabbing";
      return true;
    }
    // A click outside the box finishes cropping; the click then does what it always does.
    this.#editor.exitCrop();
    return false;
  }

  move(input: PointerInput): boolean {
    const editor = this.#editor;
    const drag = this.#drag;
    if (!drag) {
      if (!croppingTarget(editor)) return false;
      const handle = this.#handleAt(input.screen);
      const start = this.#snapshot(input.screen);
      this.cursor = handle
        ? resizeCursor(handle, { matrix: editor.scene.worldMatrix(editor.s.cropping?.id ?? "") })
        : start && this.#inside(start)
          ? "grab"
          : "default";
      return true;
    }
    const { start } = drag;
    if (!drag.moved) {
      if (Math.hypot(input.screen.x - start.screen.x, input.screen.y - start.screen.y) < DRAG_PX)
        return true;
      drag.moved = true;
      editor.beginGesture(drag.kind === "pan" ? "Move image" : "Crop image");
    }
    const local = apply(invert(start.world), editor.s.camera.toPage(input.screen));
    const { node, index, paint, box, image } = start;
    if (drag.kind === "pan") {
      const crop = pannedCrop(
        paint.crop ?? { x: 0, y: 0, width: 1, height: 1 },
        box,
        local.x - start.local.x,
        local.y - start.local.y,
      );
      editor.commit(cropOps(node, index, paint, { x: 0, y: 0, ...box }, crop), "Move image");
      return true;
    }
    const handle = drag.handle as HandleId;
    let x0 = 0;
    let y0 = 0;
    let x1 = box.width;
    let y1 = box.height;
    if (handle.includes("w")) x0 = local.x;
    if (handle.includes("e")) x1 = local.x;
    if (handle.includes("n")) y0 = local.y;
    if (handle.includes("s")) y1 = local.y;
    if (input.shift && box.height > 0) {
      // Keep the shape, from the opposite edge or corner.
      const ratio = box.width / box.height;
      const w = Math.abs(x1 - x0);
      const h = Math.abs(y1 - y0);
      const horizontal = handle === "e" || handle === "w";
      const vertical = handle === "n" || handle === "s";
      const width = vertical ? h * ratio : horizontal ? w : Math.max(w, h * ratio);
      const height = width / ratio;
      if (handle.includes("w")) x0 = x1 - width;
      else if (handle.includes("e") || vertical) x1 = x0 + width;
      if (handle.includes("n")) y0 = y1 - height;
      else if (handle.includes("s") || horizontal) y1 = y0 + height;
    }
    const min = 4 / editor.s.camera.zoom;
    const next = clampBox({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, image, min);
    editor.commit(cropOps(node, index, paint, next, cropOfBox(image, next)), "Crop image");
    return true;
  }

  up(_input: PointerInput): boolean {
    const drag = this.#drag;
    if (!drag) return false;
    this.#drag = null;
    if (drag.moved) this.#editor.endGesture();
    this.cursor = drag.kind === "pan" ? "grab" : this.cursor;
    return true;
  }

  key(input: KeyInput): boolean {
    if (!this.#editor.s.cropping) return false;
    if (input.key === "Enter" || input.key === "Escape") {
      this.cancel();
      this.#editor.exitCrop();
      return true;
    }
    return false;
  }

  cancel(): void {
    if (this.#drag?.moved) this.#editor.endGesture();
    this.#drag = null;
  }
}
