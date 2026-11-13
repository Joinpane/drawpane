/**
 * Pointer and wheel interaction on the canvas: selecting, moving with smart
 * guides, resizing, rotating, marquee, drawing new layers, panning and
 * zooming. One gesture at a time; each gesture is one undo step.
 */
import { getProp, keyBetween, type LayerType, type NodeRecord, type Op } from "@drawpane/model";
import { isInsideInstance } from "./components";
import type { Editor } from "./editor";
import {
  apply,
  boxOf,
  localMatrix,
  type Matrix,
  normalizeRect,
  type Point,
  type Rect,
  rectContainsPoint,
  round2,
} from "./geometry";
import { hitTest, marqueeHits, selectionTarget } from "./hit";
import { snapRect } from "./snap";
import { ConnectTool } from "./tools/connect";
import { PenTool } from "./tools/pen";
import type { KeyInput, ToolHandler } from "./tools/types";
import { VectorEditTool } from "./tools/vector-edit";
import { scaledPathData } from "./vector/node";

export interface PointerInput {
  readonly screen: Point;
  readonly button: number;
  readonly shift: boolean;
  readonly alt: boolean;
  /** ⌘ on macOS, Ctrl elsewhere. */
  readonly mod: boolean;
  readonly clicks: number;
}

export type HandleId = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
const HANDLES: readonly HandleId[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
/** Where each handle sits on the unit box, and which edges it moves. */
const HANDLE_POS: Record<HandleId, [number, number]> = {
  nw: [0, 0],
  n: [0.5, 0],
  ne: [1, 0],
  e: [1, 0.5],
  se: [1, 1],
  s: [0.5, 1],
  sw: [0, 1],
  w: [0, 0.5],
};

const HANDLE_HIT_PX = 6;
const ROTATE_HIT_PX = 18;
const DRAG_THRESHOLD_PX = 3;
const SNAP_PX = 6;

/** The box the selection handles belong to: a node's rotated box, or the selection's bounds. */
interface Frame {
  readonly matrix: Matrix;
  readonly width: number;
  readonly height: number;
}

type Mode =
  | { kind: "idle" }
  | { kind: "pending"; start: Point; startPage: Point; target: string | null; additive: boolean }
  | { kind: "pan"; last: Point }
  | { kind: "marquee"; start: Point; container: string; base: readonly string[] }
  | {
      kind: "move";
      startPage: Point;
      nodes: Map<string, NodeRecord>;
      bounds: Rect;
      duplicated: boolean;
    }
  | {
      kind: "resize";
      handle: HandleId;
      frame: Frame;
      nodes: Map<string, NodeRecord>;
      startPage: Point;
    }
  | { kind: "rotate"; centre: Point; startAngle: number; nodes: Map<string, NodeRecord> }
  | { kind: "draw"; type: LayerType; startPage: Point; parent: string; id: string | null };

export class Interaction {
  readonly #editor: Editor;
  #mode: Mode = { kind: "idle" };
  #spaceHeld = false;
  cursor = "default";
  /** Tools in their own files; they see pointer and key events first while active. */
  readonly pen: PenTool;
  readonly vectorEdit: VectorEditTool;
  readonly connect: ConnectTool;

  constructor(editor: Editor) {
    this.#editor = editor;
    this.pen = new PenTool(editor);
    this.vectorEdit = new VectorEditTool(editor);
    this.connect = new ConnectTool(editor);
  }

  get busy(): boolean {
    return this.#mode.kind !== "idle" || this.pen.busy || this.vectorEdit.busy || this.connect.busy;
  }

  /** The tool handler that takes events now, if any. Built-in gestures run otherwise. */
  #delegate(): ToolHandler | null {
    if (this.#mode.kind !== "idle" || this.#spaceHeld) return null;
    const { tool, vectorEdit, prototyping } = this.#editor.s;
    if (tool === "pen") return this.pen;
    if (tool === "select" && vectorEdit) return this.vectorEdit;
    if (tool === "select" && prototyping) return this.connect;
    return null;
  }

  /**
   * Keyboard input for tools: the pen (Enter, Escape, Backspace), vector edit
   * (Escape, Enter, Backspace, arrows) and Enter on a selected path to edit it.
   * Returns true when the key was used; the app's shortcuts run otherwise.
   */
  key(input: KeyInput): boolean {
    const delegate = this.#delegate();
    if (delegate?.key(input)) return true;
    const editor = this.#editor;
    const { selection, tool, vectorEdit } = editor.s;
    if (input.key === "Enter" && tool === "select" && !vectorEdit && selection.length === 1) {
      const node = editor.doc.get(selection[0] as string);
      if (node?.type === "path") return editor.enterVectorEdit(node.id);
    }
    return false;
  }

  #page(screen: Point): Point {
    return this.#editor.s.camera.toPage(screen);
  }

  /** The handle box for the current selection, or null when nothing is selected. */
  selectionFrame(): Frame | null {
    const { selection } = this.#editor.s;
    const scene = this.#editor.scene;
    if (selection.length === 1) {
      const node = this.#editor.doc.get(selection[0] as string);
      if (node && node.type !== "group" && node.type !== "page") {
        return {
          matrix: scene.worldMatrix(node.id),
          width: getProp(node.props, "width"),
          height: getProp(node.props, "height"),
        };
      }
    }
    const b = scene.unionBounds(selection);
    if (!b) return null;
    return { matrix: [1, 0, 0, 1, b.x, b.y], width: b.width, height: b.height };
  }

  /** Which handle (or rotation zone) is under a screen point. */
  handleAt(screen: Point): { handle: HandleId; rotate: boolean } | null {
    const frame = this.selectionFrame();
    // The Prototype tab trades resize handles for the connection handle.
    if (!frame || this.#editor.s.editingText || this.#editor.s.prototyping) return null;
    const camera = this.#editor.s.camera;
    // Tiny selections only get corner handles, so they stay draggable.
    const screenW = frame.width * camera.zoom;
    const screenH = frame.height * camera.zoom;
    const handles = screenW < 24 || screenH < 24 ? HANDLES.filter((h) => h.length === 2) : HANDLES;
    for (const handle of handles) {
      const [u, v] = HANDLE_POS[handle];
      const p = camera.toScreen(apply(frame.matrix, { x: u * frame.width, y: v * frame.height }));
      if (Math.abs(p.x - screen.x) <= HANDLE_HIT_PX && Math.abs(p.y - screen.y) <= HANDLE_HIT_PX)
        return { handle, rotate: false };
    }
    for (const handle of HANDLES.filter((h) => h.length === 2)) {
      const [u, v] = HANDLE_POS[handle];
      const p = camera.toScreen(apply(frame.matrix, { x: u * frame.width, y: v * frame.height }));
      const d = Math.hypot(p.x - screen.x, p.y - screen.y);
      if (d > HANDLE_HIT_PX && d <= ROTATE_HIT_PX && !this.#insideFrame(frame, screen))
        return { handle, rotate: true };
    }
    return null;
  }

  #insideFrame(frame: Frame, screen: Point): boolean {
    const page = this.#page(screen);
    const m = frame.matrix;
    const det = m[0] * m[3] - m[1] * m[2] || 1;
    const x = page.x - m[4];
    const y = page.y - m[5];
    const local = { x: (m[3] * x - m[2] * y) / det, y: (-m[1] * x + m[0] * y) / det };
    return rectContainsPoint({ x: 0, y: 0, width: frame.width, height: frame.height }, local);
  }

  setSpace(held: boolean): void {
    this.#spaceHeld = held;
    this.cursor = held ? "grab" : "default";
  }

  // -------------------------------------------------------------------------

  down(input: PointerInput): void {
    const editor = this.#editor;
    const { tool, pageId, editingText } = editor.s;
    if (!pageId) return;
    if (editingText) editor.endTextEdit();
    const page = this.#page(input.screen);

    if (input.button === 1 || this.#spaceHeld || tool === "hand") {
      this.#mode = { kind: "pan", last: input.screen };
      this.cursor = "grabbing";
      return;
    }
    if (input.button !== 0) return;
    // Comment pins are placed by the host app, over the canvas.
    if (tool === "comment") return;

    const delegate = this.#delegate();
    if (delegate?.down(input)) {
      this.cursor = delegate.cursor;
      return;
    }

    if (tool !== "select") {
      if (!editor.canEdit || tool === "pen") return;
      const parent = editor.dropTarget(page) ?? pageId;
      if (tool === "text") {
        const id = editor.createLayer(
          "text",
          { x: page.x, y: page.y, width: 0, height: 0 },
          parent,
        );
        if (id) editor.startTextEdit(id);
        return;
      }
      editor.beginGesture(`Draw ${tool}`);
      this.#mode = { kind: "draw", type: tool, startPage: page, parent, id: null };
      return;
    }

    const handle = editor.canEdit ? this.handleAt(input.screen) : null;
    if (handle) {
      const nodes = this.#snapshot(editor.s.selection);
      editor.beginGesture(handle.rotate ? "Rotate" : "Resize");
      if (handle.rotate) {
        const frame = this.selectionFrame() as Frame;
        const centre = apply(frame.matrix, { x: frame.width / 2, y: frame.height / 2 });
        this.#mode = {
          kind: "rotate",
          centre,
          startAngle: Math.atan2(page.y - centre.y, page.x - centre.x),
          nodes,
        };
      } else {
        this.#mode = {
          kind: "resize",
          handle: handle.handle,
          frame: this.selectionFrame() as Frame,
          nodes,
          startPage: page,
        };
      }
      return;
    }

    const leaf = hitTest(editor.scene, pageId, page, 4 / editor.s.camera.zoom);
    let target = leaf
      ? selectionTarget(editor.scene, pageId, leaf, editor.s.selection, input.mod)
      : null;
    // Clicking inside the current selection's box drags it, even on empty space between layers.
    const frame = this.selectionFrame();
    if (!target && frame && this.#insideFrame(frame, input.screen) && editor.s.selection.length > 0)
      target = editor.s.selection[0] ?? null;

    if (input.clicks >= 2 && target) {
      const node = editor.doc.get(target);
      if (node?.type === "text") {
        editor.startTextEdit(target);
        return;
      }
      if (node?.type === "path" && editor.enterVectorEdit(target)) return;
      if (leaf && leaf !== target) {
        // Enter the group or frame: select the next level down.
        editor.select([selectionTarget(editor.scene, pageId, leaf, [target], false)]);
        return;
      }
    }

    if (target) {
      const selected = editor.s.selection.includes(target);
      if (input.shift) {
        editor.select(
          selected
            ? editor.s.selection.filter((id) => id !== target)
            : [...editor.s.selection, target],
        );
      } else if (!selected) {
        editor.select([target]);
      }
      this.#mode = {
        kind: "pending",
        start: input.screen,
        startPage: page,
        target,
        additive: input.shift,
      };
      return;
    }

    if (!input.shift) editor.select([]);
    this.#mode = {
      kind: "pending",
      start: input.screen,
      startPage: page,
      target: null,
      additive: input.shift,
    };
  }

  move(input: PointerInput): void {
    const editor = this.#editor;
    const page = this.#page(input.screen);
    const mode = this.#mode;
    const delegate = this.#delegate();
    if (delegate?.move(input)) {
      this.cursor = delegate.cursor;
      return;
    }

    switch (mode.kind) {
      case "idle":
        this.#hover(input);
        return;
      case "pan": {
        editor.setCamera(
          editor.s.camera.pan(input.screen.x - mode.last.x, input.screen.y - mode.last.y),
        );
        this.#mode = { kind: "pan", last: input.screen };
        return;
      }
      case "pending": {
        if (
          Math.hypot(input.screen.x - mode.start.x, input.screen.y - mode.start.y) <
          DRAG_THRESHOLD_PX
        )
          return;
        if (mode.target && editor.canEdit && !editor.scene.isLocked(mode.target)) {
          editor.beginGesture("Move");
          let ids = editor.s.selection;
          let duplicated = false;
          if (input.alt) {
            editor.duplicate();
            ids = editor.s.selection;
            duplicated = true;
          }
          const bounds = editor.scene.unionBounds(ids);
          if (!bounds) return;
          this.#mode = {
            kind: "move",
            startPage: mode.startPage,
            nodes: this.#snapshot(ids),
            bounds,
            duplicated,
          };
          this.cursor = "default";
          this.move(input);
          return;
        }
        const container = this.#marqueeContainer(mode.startPage);
        this.#mode = {
          kind: "marquee",
          start: mode.startPage,
          container,
          base: mode.additive ? editor.s.selection : [],
        };
        this.move(input);
        return;
      }
      case "marquee": {
        const rect = normalizeRect(mode.start, page);
        const hits = marqueeHits(editor.scene, mode.container, rect);
        editor.state.set({ marquee: rect });
        editor.select([...mode.base, ...hits.filter((id) => !mode.base.includes(id))]);
        return;
      }
      case "move":
        this.#moveSelection(mode, page, input);
        return;
      case "resize":
        this.#resize(mode, page, input);
        return;
      case "rotate":
        this.#rotate(mode, page, input);
        return;
      case "draw":
        this.#draw(mode, page, input);
        return;
    }
  }

  up(input: PointerInput): void {
    const editor = this.#editor;
    const delegate = this.#delegate();
    if (delegate?.up(input)) {
      this.cursor = delegate.cursor;
      return;
    }
    const mode = this.#mode;
    this.#mode = { kind: "idle" };
    switch (mode.kind) {
      case "pan":
        this.cursor = this.#spaceHeld ? "grab" : "default";
        return;
      case "pending":
        // A plain click on an already-selected layer narrows the selection to it.
        if (mode.target && !mode.additive && editor.s.selection.length > 1)
          editor.select([mode.target]);
        return;
      case "marquee":
        editor.state.set({ marquee: null });
        return;
      case "move":
        this.#dropMoved(mode, this.#page(input.screen));
        editor.endGesture();
        return;
      case "resize":
      case "rotate":
        editor.endGesture();
        return;
      case "draw": {
        if (!mode.id) {
          // A click without a drag creates a default-sized layer centred on the pointer.
          const size = mode.type === "line" ? { w: 100, h: 0 } : { w: 100, h: 100 };
          const id = editor.createLayer(
            mode.type,
            {
              x: mode.startPage.x - size.w / 2,
              y: mode.startPage.y - size.h / 2,
              width: size.w,
              height: size.h,
            },
            mode.parent,
          );
          if (id) editor.select([id]);
        }
        editor.endGesture();
        editor.setTool("select");
        return;
      }
      case "idle":
        return;
    }
  }

  cancel(): void {
    const editor = this.#editor;
    this.pen.cancel();
    this.vectorEdit.cancel();
    this.connect.cancel();
    const mode = this.#mode;
    this.#mode = { kind: "idle" };
    if (
      mode.kind === "move" ||
      mode.kind === "resize" ||
      mode.kind === "rotate" ||
      mode.kind === "draw"
    ) {
      editor.endGesture();
      editor.undo();
    }
    editor.state.set({ marquee: null, guides: [] });
  }

  wheel(e: {
    deltaX: number;
    deltaY: number;
    ctrlKey: boolean;
    metaKey: boolean;
    shiftKey: boolean;
    screen: Point;
  }): void {
    const editor = this.#editor;
    if (e.ctrlKey || e.metaKey) {
      // Pinch-zoom arrives as ctrl+wheel. Scale smoothly with the delta.
      editor.zoomBy(Math.exp(-e.deltaY * 0.01), e.screen);
      return;
    }
    const dx = e.shiftKey && e.deltaX === 0 ? e.deltaY : e.deltaX;
    const dy = e.shiftKey && e.deltaX === 0 ? 0 : e.deltaY;
    editor.setCamera(editor.s.camera.pan(-dx, -dy));
  }

  // -------------------------------------------------------------------------

  #hover(input: PointerInput): void {
    const editor = this.#editor;
    const { pageId, tool } = editor.s;
    if (!pageId) return;
    if (this.#spaceHeld || tool === "hand") {
      this.cursor = "grab";
      return;
    }
    if (tool !== "select") {
      this.cursor = tool === "text" ? "text" : "crosshair";
      editor.state.set({ hover: null });
      return;
    }
    const handle = editor.canEdit ? this.handleAt(input.screen) : null;
    if (handle) {
      this.cursor = handle.rotate ? "alias" : resizeCursor(handle.handle, this.selectionFrame());
      editor.state.set({ hover: null });
      return;
    }
    this.cursor = "default";
    const page = this.#page(input.screen);
    const leaf = hitTest(editor.scene, pageId, page, 4 / editor.s.camera.zoom);
    const target = leaf
      ? selectionTarget(editor.scene, pageId, leaf, editor.s.selection, input.mod)
      : null;
    editor.state.set({ hover: target });
  }

  #marqueeContainer(start: Point): string {
    const editor = this.#editor;
    const pageId = editor.s.pageId as string;
    // Starting inside an artboard selects within it.
    for (const id of [...editor.doc.childIds(pageId)].reverse()) {
      const node = editor.doc.get(id);
      if (node?.type !== "frame" || editor.doc.childIds(id).length === 0) continue;
      const b = editor.scene.bounds(id);
      if (b && rectContainsPoint(b, start)) return id;
    }
    return pageId;
  }

  #snapshot(ids: readonly string[]): Map<string, NodeRecord> {
    const out = new Map<string, NodeRecord>();
    const add = (id: string) => {
      const node = this.#editor.doc.get(id);
      if (!node) return;
      out.set(id, node);
      if (node.type === "group") for (const child of this.#editor.doc.childIds(id)) add(child);
    };
    for (const id of ids) add(id);
    return out;
  }

  /** Nodes with their own geometry among a snapshot (groups expand to their contents). */
  #geometryNodes(nodes: Map<string, NodeRecord>): NodeRecord[] {
    return [...nodes.values()].filter((n) => n.type !== "group");
  }

  #moveSelection(mode: Extract<Mode, { kind: "move" }>, page: Point, input: PointerInput): void {
    const editor = this.#editor;
    let dx = page.x - mode.startPage.x;
    let dy = page.y - mode.startPage.y;
    if (input.shift) {
      if (Math.abs(dx) > Math.abs(dy)) dy = 0;
      else dx = 0;
    }
    // Smart guides against siblings and the parent frame.
    const moving = { ...mode.bounds, x: mode.bounds.x + dx, y: mode.bounds.y + dy };
    const roots = editor.s.selection;
    const first = editor.doc.get(roots[0] ?? "");
    const targets: Rect[] = [];
    if (first && !input.mod) {
      const view = editor.s.camera.visibleRect(editor.s.viewport);
      for (const sibling of editor.doc.childIds(first.parent)) {
        if (mode.nodes.has(sibling)) continue;
        const b = editor.scene.bounds(sibling);
        if (
          b &&
          b.x < view.x + view.width &&
          b.x + b.width > view.x &&
          b.y < view.y + view.height &&
          b.y + b.height > view.y
        )
          targets.push(b);
      }
      const parentBounds = editor.scene.bounds(first.parent);
      if (parentBounds) targets.push(parentBounds);
    }
    const snap = snapRect(moving, targets, SNAP_PX / editor.s.camera.zoom);
    dx += snap.dx;
    dy += snap.dy;
    editor.state.set({ guides: snap.guides });

    const ops: Op[] = [];
    for (const node of this.#geometryNodes(mode.nodes)) {
      const parent = editor.doc.get(node.parent);
      const inLayout =
        parent?.type === "frame" &&
        getProp(parent.props, "layoutMode") !== "none" &&
        getProp(node.props, "positioning") === "auto";
      if (inLayout) continue;
      const space = editor.scene.spaceMatrix(editor.scene.spaceOwner(node.parent));
      const det = space[0] * space[3] - space[1] * space[2] || 1;
      const lx = (space[3] * dx - space[2] * dy) / det;
      const ly = (-space[1] * dx + space[0] * dy) / det;
      ops.push(
        { op: "set", id: node.id, prop: "x", value: round2(getProp(node.props, "x") + lx) },
        { op: "set", id: node.id, prop: "y", value: round2(getProp(node.props, "y") + ly) },
      );
    }
    // Inside auto layout, dragging reorders instead of moving.
    ops.push(...this.#layoutReorder(page));
    if (ops.length > 0) editor.commit(ops, "Move");
  }

  /** For a single layer in an auto-layout frame: move it to the slot under the pointer. */
  #layoutReorder(page: Point): Op[] {
    const editor = this.#editor;
    const { selection } = editor.s;
    if (selection.length !== 1) return [];
    const node = editor.doc.get(selection[0] as string);
    const parent = node && editor.doc.get(node.parent);
    if (
      !node ||
      !parent ||
      parent.type !== "frame" ||
      getProp(parent.props, "layoutMode") === "none" ||
      // An instance's order comes from its main component.
      isInsideInstance(editor.doc, node.id)
    )
      return [];
    if (getProp(node.props, "positioning") === "absolute") return [];
    const row = getProp(parent.props, "layoutMode") === "row";
    const siblings = editor.doc.childIds(parent.id).filter((id) => id !== node.id);
    let index = siblings.length;
    for (let i = 0; i < siblings.length; i++) {
      const b = editor.scene.bounds(siblings[i] as string);
      if (!b) continue;
      const mid = row ? b.x + b.width / 2 : b.y + b.height / 2;
      if ((row ? page.x : page.y) < mid) {
        index = i;
        break;
      }
    }
    const current = editor.doc.childIds(parent.id).indexOf(node.id);
    if (current === index) return [];
    const before = siblings[index - 1];
    const after = siblings[index];
    const key = keyBetween(
      before ? (editor.doc.get(before)?.key ?? null) : null,
      after ? (editor.doc.get(after)?.key ?? null) : null,
    );
    return [{ op: "move", id: node.id, parent: parent.id, key }];
  }

  /** On drop, move layers into the frame under the pointer, keeping them in place on screen. */
  #dropMoved(mode: Extract<Mode, { kind: "move" }>, page: Point): void {
    const editor = this.#editor;
    const roots = editor.s.selection.filter((id) => editor.doc.has(id));
    const exclude = new Set(mode.nodes.keys());
    const target = editor.dropTarget(page, exclude);
    if (!target) return;
    const ops: Op[] = [];
    for (const id of roots) {
      const node = editor.doc.get(id);
      if (!node || node.parent === target || isInsideInstance(editor.doc, id)) continue;
      // Leaving an auto-layout frame only when the pointer is outside it.
      const parent = editor.doc.get(node.parent);
      if (parent?.type === "frame" && getProp(parent.props, "layoutMode") !== "none") {
        const b = editor.scene.bounds(parent.id);
        if (b && rectContainsPoint(b, page)) continue;
      }
      if (editor.doc.ancestors(target).some((a) => a.id === id) || target === id) continue;
      ops.push(...editor.reparentOps(id, target, editor.topKey(target)));
    }
    if (ops.length > 0) editor.commit(ops, "Move into frame");
  }

  #resize(mode: Extract<Mode, { kind: "resize" }>, page: Point, input: PointerInput): void {
    const editor = this.#editor;
    const { frame, handle } = mode;
    const [hu, hv] = HANDLE_POS[handle];
    // Work in the handle frame's local space.
    const m = frame.matrix;
    const det = m[0] * m[3] - m[1] * m[2] || 1;
    const px = page.x - m[4];
    const py = page.y - m[5];
    const local = { x: (m[3] * px - m[2] * py) / det, y: (-m[1] * px + m[0] * py) / det };

    let x0 = 0;
    let y0 = 0;
    let x1 = frame.width;
    let y1 = frame.height;
    const movesX = hu !== 0.5;
    const movesY = hv !== 0.5;
    if (movesX) {
      if (hu === 0) x0 = local.x;
      else x1 = local.x;
    }
    if (movesY) {
      if (hv === 0) y0 = local.y;
      else y1 = local.y;
    }
    if (input.alt) {
      // Resize from the centre: mirror the moved edge.
      if (movesX) {
        if (hu === 0) x1 = frame.width - x0;
        else x0 = frame.width - x1;
      }
      if (movesY) {
        if (hv === 0) y1 = frame.height - y0;
        else y0 = frame.height - y1;
      }
    }
    // Shift, or a single layer with its aspect ratio locked, keeps proportions.
    const roots = editor.s.selection;
    const lockedAspect =
      roots.length === 1 && getProp(mode.nodes.get(roots[0] as string)?.props ?? {}, "lockAspect");
    if ((input.shift || lockedAspect) && frame.width > 0 && frame.height > 0) {
      const ratio = frame.width / frame.height;
      let w = x1 - x0;
      let h = y1 - y0;
      if (movesX && movesY) {
        if (Math.abs(w) / ratio > Math.abs(h)) h = (Math.abs(w) / ratio) * Math.sign(h || 1);
        else w = Math.abs(h) * ratio * Math.sign(w || 1);
      } else if (movesX) h = (Math.abs(w) / ratio) * Math.sign(h || 1);
      else w = Math.abs(h) * ratio * Math.sign(w || 1);
      if (hu === 0) x0 = x1 - w;
      else if (hu === 1) x1 = x0 + w;
      else {
        const cx = frame.width / 2;
        x0 = cx - w / 2;
        x1 = cx + w / 2;
      }
      if (hv === 0) y0 = y1 - h;
      else if (hv === 1) y1 = y0 + h;
      else {
        const cy = frame.height / 2;
        y0 = cy - h / 2;
        y1 = cy + h / 2;
      }
    }

    const flipX = x1 < x0;
    const flipY = y1 < y0;
    const nx = Math.min(x0, x1);
    const ny = Math.min(y0, y1);
    const nw = Math.abs(x1 - x0);
    const nh = Math.abs(y1 - y0);
    const sx = frame.width > 0 ? nw / frame.width : 1;
    const sy = frame.height > 0 ? nh / frame.height : 1;

    const ops: Op[] = [];
    const single = roots.length === 1 && mode.nodes.get(roots[0] as string)?.type !== "group";
    for (const node of this.#geometryNodes(mode.nodes)) {
      const box = boxOf(node);
      let newBox: { x: number; y: number; width: number; height: number };
      if (single) {
        // The node's own box: new local rect, mapped back through its original local matrix.
        const L = localMatrix(box);
        const centre = apply(L, { x: nx + nw / 2, y: ny + nh / 2 });
        newBox = { x: centre.x - nw / 2, y: centre.y - nh / 2, width: nw, height: nh };
        if (flipX !== false || flipY !== false) {
          if (flipX) ops.push({ op: "set", id: node.id, prop: "flipX", value: !box.flipX });
          if (flipY) ops.push({ op: "set", id: node.id, prop: "flipY", value: !box.flipY });
        }
      } else {
        // Scale positions and sizes inside the selection bounds (page space, unrotated).
        // Use the starting geometry, not the live document, so the drag never drifts.
        const space = editor.scene.spaceMatrix(editor.scene.spaceOwner(node.parent));
        const centre = apply(space, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
        const rel = {
          x: (centre.x - m[4]) / (frame.width || 1),
          y: (centre.y - m[5]) / (frame.height || 1),
        };
        const newCentre = { x: m[4] + nx + rel.x * nw, y: m[5] + ny + rel.y * nh };
        const sdet = space[0] * space[3] - space[1] * space[2] || 1;
        const qx = newCentre.x - space[4];
        const qy = newCentre.y - space[5];
        const lc = {
          x: (space[3] * qx - space[2] * qy) / sdet,
          y: (-space[1] * qx + space[0] * qy) / sdet,
        };
        const w = box.width * sx;
        const h = box.height * sy;
        newBox = { x: lc.x - w / 2, y: lc.y - h / 2, width: w, height: h };
      }
      if (node.type === "path") {
        // Never collapse a path to zero: its shape couldn't be scaled back.
        if (box.width > 0 && newBox.width < 0.01) newBox = { ...newBox, width: 0.01 };
        if (box.height > 0 && newBox.height < 0.01) newBox = { ...newBox, height: 0.01 };
      }
      const set = (prop: "x" | "y" | "width" | "height", value: number) => {
        const v = round2(value);
        if (v !== round2(getProp(node.props, prop)))
          ops.push({ op: "set", id: node.id, prop, value: v });
      };
      set("x", newBox.x);
      set("y", newBox.y);
      set("width", newBox.width);
      set("height", newBox.height);
      if (node.type === "path") {
        // Scale from the shape at drag start, so passing through zero size never loses it.
        const d = scaledPathData(node, round2(newBox.width), round2(newBox.height));
        if (d !== null) ops.push({ op: "set", id: node.id, prop: "pathData", value: d });
      }
      // Resizing by hand makes that axis fixed (from Hug or Fill), like CSS with an explicit size.
      if (movesX && getProp(node.props, "sizingH") !== "fixed")
        ops.push({ op: "set", id: node.id, prop: "sizingH", value: "fixed" });
      if (movesY && getProp(node.props, "sizingV") !== "fixed")
        ops.push({ op: "set", id: node.id, prop: "sizingV", value: "fixed" });
      if (node.type === "text") {
        const mode2 = getProp(node.props, "textAutoResize");
        const next = movesY ? "none" : movesX && mode2 === "width" ? "height" : mode2;
        if (next !== mode2)
          ops.push({ op: "set", id: node.id, prop: "textAutoResize", value: next });
      }
    }
    // ⌘ resizes a frame without moving its children by their constraints.
    if (ops.length > 0) editor.commit(ops, "Resize", { constraints: !input.mod });
  }

  #rotate(mode: Extract<Mode, { kind: "rotate" }>, page: Point, input: PointerInput): void {
    const editor = this.#editor;
    const angle = Math.atan2(page.y - mode.centre.y, page.x - mode.centre.x);
    let delta = ((angle - mode.startAngle) * 180) / Math.PI;
    if (input.shift) delta = Math.round(delta / 15) * 15;
    const rad = (delta * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const ops: Op[] = [];
    for (const node of this.#geometryNodes(mode.nodes)) {
      const box = boxOf(node);
      // Rotate each node's starting centre about the selection centre (page
      // space), then map it back into the node's parent space.
      const space = editor.scene.spaceMatrix(editor.scene.spaceOwner(node.parent));
      const startCentre = apply(space, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
      const rx =
        mode.centre.x +
        (startCentre.x - mode.centre.x) * cos -
        (startCentre.y - mode.centre.y) * sin;
      const ry =
        mode.centre.y +
        (startCentre.x - mode.centre.x) * sin +
        (startCentre.y - mode.centre.y) * cos;
      const sdet = space[0] * space[3] - space[1] * space[2] || 1;
      const qx = rx - space[4];
      const qy = ry - space[5];
      const lc = {
        x: (space[3] * qx - space[2] * qy) / sdet,
        y: (-space[1] * qx + space[0] * qy) / sdet,
      };
      let rotation = box.rotation + delta;
      rotation = ((((rotation + 180) % 360) + 360) % 360) - 180;
      ops.push(
        { op: "set", id: node.id, prop: "rotation", value: round2(rotation) },
        { op: "set", id: node.id, prop: "x", value: round2(lc.x - box.width / 2) },
        { op: "set", id: node.id, prop: "y", value: round2(lc.y - box.height / 2) },
      );
    }
    if (ops.length > 0) editor.commit(ops, "Rotate");
  }

  #draw(mode: Extract<Mode, { kind: "draw" }>, page: Point, input: PointerInput): void {
    const editor = this.#editor;
    let { x: x1, y: y1 } = page;
    const { x: x0, y: y0 } = mode.startPage;
    if (input.shift) {
      if (mode.type === "line") {
        // Lines snap to 45°.
        const angle = Math.round(Math.atan2(y1 - y0, x1 - x0) / (Math.PI / 4)) * (Math.PI / 4);
        const length = Math.hypot(x1 - x0, y1 - y0);
        x1 = x0 + Math.cos(angle) * length;
        y1 = y0 + Math.sin(angle) * length;
      } else {
        const size = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
        x1 = x0 + size * Math.sign(x1 - x0 || 1);
        y1 = y0 + size * Math.sign(y1 - y0 || 1);
      }
    }
    let rect: Rect;
    let rotation = 0;
    if (mode.type === "line") {
      const length = Math.hypot(x1 - x0, y1 - y0);
      rotation = (Math.atan2(y1 - y0, x1 - x0) * 180) / Math.PI;
      const cx = (x0 + x1) / 2;
      const cy = (y0 + y1) / 2;
      rect = { x: cx - length / 2, y: cy, width: length, height: 0 };
    } else if (input.alt) {
      const w = Math.abs(x1 - x0);
      const h = Math.abs(y1 - y0);
      rect = { x: x0 - w, y: y0 - h, width: w * 2, height: h * 2 };
    } else {
      rect = normalizeRect({ x: x0, y: y0 }, { x: x1, y: y1 });
    }
    if (!mode.id) {
      const id = editor.createLayer(
        mode.type,
        rect,
        mode.parent,
        rotation ? { rotation: round2(rotation) } : {},
      );
      if (!id) return;
      mode.id = id;
      editor.select([id]);
      return;
    }
    const origin = editor.scene.toSpace(mode.parent, { x: rect.x, y: rect.y });
    const ops: Op[] = [
      { op: "set", id: mode.id, prop: "x", value: round2(origin.x) },
      { op: "set", id: mode.id, prop: "y", value: round2(origin.y) },
      { op: "set", id: mode.id, prop: "width", value: round2(rect.width) },
      { op: "set", id: mode.id, prop: "height", value: round2(rect.height) },
    ];
    if (mode.type === "line")
      ops.push({ op: "set", id: mode.id, prop: "rotation", value: round2(rotation) });
    editor.commit(ops, `Draw ${mode.type}`);
  }
}

/** A resize cursor that matches the handle's on-screen direction, rotation included. */
function resizeCursor(handle: HandleId, frame: Frame | null): string {
  const base: Record<HandleId, number> = {
    n: 90,
    ne: 45,
    e: 0,
    se: 135,
    s: 90,
    sw: 45,
    w: 0,
    nw: 135,
  };
  const rotation = frame ? (Math.atan2(frame.matrix[1], frame.matrix[0]) * 180) / Math.PI : 0;
  const angle = (((base[handle] - rotation) % 180) + 180) % 180;
  const steps = ["ew-resize", "nesw-resize", "ns-resize", "nwse-resize"];
  return steps[Math.round(angle / 45) % 4] as string;
}
