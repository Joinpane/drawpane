/**
 * The pen tool (P). Click adds a corner anchor; click and drag adds a smooth
 * anchor with mirrored handles; Shift snaps to 45°. Clicking the first anchor
 * closes the path; Enter or Escape finishes an open one; Backspace removes the
 * last anchor. The whole drawing is one undo step, and the path is committed
 * as it grows so collaborators watch it appear.
 */
import { newId, type Op } from "@drawpane/model";
import type { Editor } from "../editor";
import { apply, type Point } from "../geometry";
import type { PointerInput } from "../interaction";
import { fitPath } from "../vector/bounds";
import { snap45 } from "../vector/edit";
import { fittedOps, round3 } from "../vector/node";
import type { Anchor, VectorPath } from "../vector/path";
import { serializePath } from "../vector/svg";
import { DRAG_PX, type KeyInput, PICK_PX, type ToolHandler } from "./types";

interface Drawing {
  /** The path node, once there are two anchors to show. */
  id: string | null;
  readonly parent: string;
  readonly pageId: string;
  /** Anchors in the parent's coordinate space. */
  anchors: Anchor[];
  closed: boolean;
}

interface Drag {
  readonly index: number;
  readonly start: Point;
  readonly closing: boolean;
  moved: boolean;
}

export const PEN_STROKE = "#1c1b1a";

export class PenTool implements ToolHandler {
  readonly #editor: Editor;
  #drawing: Drawing | null = null;
  #drag: Drag | null = null;
  #finishing = false;
  cursor = "crosshair";

  constructor(editor: Editor) {
    this.#editor = editor;
    // Switching tools or pages finishes the path in progress.
    editor.state.subscribe(() => {
      const d = this.#drawing;
      if (!d || this.#finishing) return;
      const s = editor.s;
      if (s.tool !== "pen" || s.pageId !== d.pageId) this.finish(false);
    });
  }

  get busy(): boolean {
    return this.#drawing !== null;
  }

  /** The path being drawn, in page coordinates, for the overlay. */
  preview(): {
    anchors: readonly Anchor[];
    closed: boolean;
    pointer: Point | null;
    nearFirst: boolean;
    dragging: boolean;
  } | null {
    const d = this.#drawing;
    if (!d) return null;
    const m = this.#spaceMatrix(d.parent);
    const map = (p: Point | null) => (p ? apply(m, p) : null);
    const anchors = d.anchors.map((a): Anchor => {
      const p = apply(m, a);
      return { x: p.x, y: p.y, in: map(a.in), out: map(a.out) };
    });
    const pointer = this.#editor.s.vectorPointer;
    return {
      anchors,
      closed: d.closed,
      pointer,
      nearFirst: pointer !== null && this.#nearFirst(pointer),
      dragging: this.#drag?.moved === true,
    };
  }

  #spaceMatrix(parent: string) {
    const scene = this.#editor.scene;
    return scene.spaceMatrix(scene.spaceOwner(parent));
  }

  #nearFirst(page: Point): boolean {
    const d = this.#drawing;
    const first = d?.anchors[0];
    if (!d || !first || d.anchors.length < 2) return false;
    const camera = this.#editor.s.camera;
    const a = camera.toScreen(apply(this.#spaceMatrix(d.parent), first));
    const p = camera.toScreen(page);
    return Math.hypot(a.x - p.x, a.y - p.y) <= PICK_PX + 2;
  }

  down(input: PointerInput): boolean {
    const editor = this.#editor;
    const { pageId, camera } = editor.s;
    if (!pageId || !editor.canEdit) return true;
    const page = camera.toPage(input.screen);
    if (!this.#drawing) {
      const parent = editor.dropTarget(page) ?? pageId;
      editor.beginGesture("Draw path");
      this.#drawing = { id: null, parent, pageId, anchors: [], closed: false };
    }
    const d = this.#drawing;
    if (this.#nearFirst(page)) {
      this.#drag = { index: 0, start: input.screen, closing: true, moved: false };
      return true;
    }
    let p = editor.scene.toSpace(d.parent, page);
    const last = d.anchors[d.anchors.length - 1];
    if (input.shift && last) p = snap45(last, p);
    d.anchors.push({ x: p.x, y: p.y, in: null, out: null });
    this.#drag = { index: d.anchors.length - 1, start: input.screen, closing: false, moved: false };
    this.#commit();
    return true;
  }

  move(input: PointerInput): boolean {
    const editor = this.#editor;
    const page = editor.s.camera.toPage(input.screen);
    editor.state.set({ vectorPointer: page });
    const d = this.#drawing;
    const drag = this.#drag;
    if (!d || !drag) return true;
    if (!drag.moved) {
      if (Math.hypot(input.screen.x - drag.start.x, input.screen.y - drag.start.y) < DRAG_PX)
        return true;
      drag.moved = true;
    }
    const a = d.anchors[drag.index];
    if (!a) return true;
    let h = editor.scene.toSpace(d.parent, page);
    if (input.shift) h = snap45(a, h);
    // Dragging pulls out the outgoing handle; the incoming one mirrors it.
    d.anchors[drag.index] = {
      x: a.x,
      y: a.y,
      out: h,
      in: { x: 2 * a.x - h.x, y: 2 * a.y - h.y },
    };
    this.#commit();
    return true;
  }

  up(_input: PointerInput): boolean {
    const d = this.#drawing;
    const drag = this.#drag;
    this.#drag = null;
    if (!d || !drag) return true;
    if (drag.closing) {
      d.closed = true;
      this.#commit();
      this.finish(true);
    }
    return true;
  }

  key(input: KeyInput): boolean {
    const d = this.#drawing;
    if (!d) return false;
    if (input.key === "Enter" || input.key === "Escape") {
      this.finish(true);
      return true;
    }
    if (input.key === "Backspace" || input.key === "Delete") {
      if (this.#drag) return true;
      d.anchors.pop();
      if (d.anchors.length === 0) {
        this.finish(true);
        return true;
      }
      this.#commit();
      return true;
    }
    return false;
  }

  cancel(): void {
    if (this.#drawing) this.finish(false);
  }

  /** Ends the drawing: one undo step, the new path selected. */
  finish(switchTool: boolean): void {
    const editor = this.#editor;
    const d = this.#drawing;
    if (!d) return;
    this.#finishing = true;
    this.#drawing = null;
    this.#drag = null;
    editor.endGesture();
    editor.state.set({ vectorPointer: null });
    if (d.id && editor.doc.has(d.id)) editor.select([d.id]);
    if (switchTool) editor.setTool("select");
    this.#finishing = false;
  }

  #commit(): void {
    const editor = this.#editor;
    const d = this.#drawing;
    if (!d) return;
    if (d.id && !editor.doc.has(d.id)) d.id = null; // A teammate deleted it: start again.
    if (d.anchors.length < 2) {
      if (d.id) {
        editor.commit([{ op: "delete", id: d.id }], "Draw path");
        d.id = null;
      }
      return;
    }
    const path: VectorPath = [{ anchors: d.anchors, closed: d.closed }];
    const { path: fitted, bounds } = fitPath(path);
    const geometry = {
      pathData: serializePath(fitted),
      x: round3(bounds.x),
      y: round3(bounds.y),
      width: round3(bounds.width),
      height: round3(bounds.height),
    };
    if (!d.id) {
      const id = newId();
      const op: Op = {
        op: "create",
        id,
        type: "path",
        parent: d.parent,
        key: editor.topKey(d.parent),
        props: {
          name: editor.defaultName("path"),
          strokes: [{ type: "solid", color: PEN_STROKE }],
          strokeWeight: 1,
          strokeAlign: "center",
          ...geometry,
        },
      };
      if (editor.commit([op], "Draw path")) d.id = id;
      return;
    }
    const node = editor.doc.get(d.id);
    if (!node) return;
    const ops = fittedOps(node, geometry);
    if (ops.length > 0) editor.commit(ops, "Draw path");
  }
}
