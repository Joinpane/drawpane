/**
 * Vector edit mode: anchors and handles of one path. Drag anchors (snapping
 * to other anchors), drag handles (Alt breaks the mirror, Shift snaps to
 * 45°), click a segment to add an anchor, double-click an anchor to toggle
 * corner and smooth, marquee to select anchors. Every drag is one undo step
 * and commits as it goes, so collaborators see the path change live.
 *
 * Drags compute from the path and box as they were when the drag started,
 * so the result never drifts however many times the box is re-fitted.
 */
import { getProp, type NodeRecord } from "@drawpane/model";
import type { Editor } from "../editor";
import {
  apply,
  invert,
  type Matrix,
  normalizeRect,
  type Point,
  rectContainsPoint,
} from "../geometry";
import type { PointerInput } from "../interaction";
import { insertAnchor, moveAnchors, setHandle, snap45 } from "../vector/edit";
import { hitPathData, nearestOnPath } from "../vector/hit";
import { fitToNode, fittedOps } from "../vector/node";
import { type AnchorRef, anchorKey, type VectorPath } from "../vector/path";
import { DRAG_PX, type KeyInput, PICK_PX, SEGMENT_PX, type ToolHandler } from "./types";

type Drag =
  | {
      kind: "anchors";
      startScreen: Point;
      startLocal: Point;
      /** World matrix and node at drag start. */
      world: Matrix;
      node: NodeRecord;
      path: VectorPath;
      keys: ReadonlySet<string>;
      primary: AnchorRef;
      moved: boolean;
    }
  | {
      kind: "handle";
      startScreen: Point;
      world: Matrix;
      node: NodeRecord;
      path: VectorPath;
      ref: AnchorRef;
      side: "in" | "out";
      moved: boolean;
    }
  | {
      kind: "empty";
      startScreen: Point;
      startPage: Point;
      base: readonly string[];
      additive: boolean;
      marquee: boolean;
    };

export interface VisibleHandle {
  readonly ref: AnchorRef;
  readonly side: "in" | "out";
  readonly at: Point;
}

/** Handles shown for a selection: those of selected anchors and of their neighbours. */
export function visibleHandles(path: VectorPath, selected: readonly string[]): VisibleHandle[] {
  const keys = new Set(selected);
  const out: VisibleHandle[] = [];
  const seen = new Set<string>();
  path.forEach((sub, s) => {
    const n = sub.anchors.length;
    sub.anchors.forEach((_, i) => {
      if (!keys.has(anchorKey({ s, i }))) return;
      const near = [i];
      if (i > 0 || sub.closed) near.push((i - 1 + n) % n);
      if (i < n - 1 || sub.closed) near.push((i + 1) % n);
      for (const j of near) {
        const key = anchorKey({ s, i: j });
        if (seen.has(key)) continue;
        seen.add(key);
        const a = sub.anchors[j];
        if (!a) continue;
        if (a.in) out.push({ ref: { s, i: j }, side: "in", at: a.in });
        if (a.out) out.push({ ref: { s, i: j }, side: "out", at: a.out });
      }
    });
  });
  return out;
}

export class VectorEditTool implements ToolHandler {
  readonly #editor: Editor;
  #drag: Drag | null = null;
  #gesture = false;
  cursor = "default";

  constructor(editor: Editor) {
    this.#editor = editor;
  }

  get busy(): boolean {
    return this.#drag !== null;
  }

  #target(): { node: NodeRecord; path: VectorPath; world: Matrix } | null {
    const v = this.#editor.s.vectorEdit;
    const node = v ? this.#editor.doc.get(v.id) : undefined;
    const path = v ? this.#editor.pathOf(v.id) : null;
    if (!node || !path) return null;
    return { node, path, world: this.#editor.scene.worldMatrix(node.id) };
  }

  #screen(world: Matrix, local: Point): Point {
    return this.#editor.s.camera.toScreen(apply(world, local));
  }

  #anchorAt(path: VectorPath, world: Matrix, screen: Point): AnchorRef | null {
    let best: AnchorRef | null = null;
    let bestD = PICK_PX;
    path.forEach((sub, s) => {
      sub.anchors.forEach((a, i) => {
        const p = this.#screen(world, a);
        const d = Math.hypot(p.x - screen.x, p.y - screen.y);
        if (d <= bestD) {
          bestD = d;
          best = { s, i };
        }
      });
    });
    return best;
  }

  #handleAt(path: VectorPath, world: Matrix, screen: Point): VisibleHandle | null {
    const selected = this.#editor.s.vectorEdit?.anchors ?? [];
    for (const h of visibleHandles(path, selected)) {
      const p = this.#screen(world, h.at);
      if (Math.hypot(p.x - screen.x, p.y - screen.y) <= PICK_PX) return h;
    }
    return null;
  }

  /** Local units per screen pixel at the current zoom. */
  #localPerPx(world: Matrix): number {
    const scale = Math.sqrt(Math.abs(world[0] * world[3] - world[1] * world[2])) || 1;
    return 1 / (scale * this.#editor.s.camera.zoom);
  }

  #begin(label: string): void {
    if (this.#gesture) return;
    this.#editor.beginGesture(label);
    this.#gesture = true;
  }

  #end(): void {
    if (!this.#gesture) return;
    this.#gesture = false;
    this.#editor.endGesture();
  }

  down(input: PointerInput): boolean {
    const editor = this.#editor;
    const target = this.#target();
    const v = editor.s.vectorEdit;
    if (!target || !v) return false;
    const { node, path, world } = target;
    const page = editor.s.camera.toPage(input.screen);
    const local = apply(invert(world), page);

    const handle = this.#handleAt(path, world, input.screen);
    if (handle) {
      this.#drag = {
        kind: "handle",
        startScreen: input.screen,
        world,
        node,
        path,
        ref: handle.ref,
        side: handle.side,
        moved: false,
      };
      return true;
    }

    const hit = this.#anchorAt(path, world, input.screen);
    if (hit) {
      const key = anchorKey(hit);
      if (input.clicks >= 2) {
        editor.selectAnchors([key]);
        editor.toggleAnchorSmooth(key);
        return true;
      }
      let selected = v.anchors;
      if (input.shift) {
        selected = selected.includes(key) ? selected.filter((k) => k !== key) : [...selected, key];
      } else if (!selected.includes(key)) {
        selected = [key];
      }
      editor.selectAnchors(selected);
      if (!selected.includes(key)) return true;
      this.#drag = {
        kind: "anchors",
        startScreen: input.screen,
        startLocal: local,
        world,
        node,
        path,
        keys: new Set(selected),
        primary: hit,
        moved: false,
      };
      return true;
    }

    const near = nearestOnPath(path, local);
    if (near && near.distance <= SEGMENT_PX * this.#localPerPx(world)) {
      // Click on a segment: add an anchor there, and keep dragging it.
      this.#begin("Add point");
      const { path: next, ref } = insertAnchor(path, near.s, near.i, near.t);
      const key = anchorKey(ref);
      editor.setPath(node.id, next, "Add point");
      editor.selectAnchors([key]);
      const live = editor.doc.get(node.id);
      if (!live) return true;
      const liveWorld = editor.scene.worldMatrix(live.id);
      this.#drag = {
        kind: "anchors",
        startScreen: input.screen,
        startLocal: apply(invert(liveWorld), page),
        world: liveWorld,
        node: live,
        path: editor.pathOf(live.id) ?? next,
        keys: new Set([key]),
        primary: ref,
        moved: false,
      };
      return true;
    }

    if (input.clicks >= 2) {
      editor.exitVectorEdit();
      return true;
    }
    this.#drag = {
      kind: "empty",
      startScreen: input.screen,
      startPage: page,
      base: input.shift ? v.anchors : [],
      additive: input.shift,
      marquee: false,
    };
    return true;
  }

  move(input: PointerInput): boolean {
    const editor = this.#editor;
    const drag = this.#drag;
    if (!editor.s.vectorEdit) return false;
    if (!drag) {
      this.#hover(input);
      return true;
    }
    const page = editor.s.camera.toPage(input.screen);
    const far =
      Math.hypot(input.screen.x - drag.startScreen.x, input.screen.y - drag.startScreen.y) >=
      DRAG_PX;
    switch (drag.kind) {
      case "empty": {
        if (!drag.marquee && !far) return true;
        drag.marquee = true;
        const rect = normalizeRect(drag.startPage, page);
        editor.state.set({ marquee: rect });
        const target = this.#target();
        if (!target) return true;
        const hits: string[] = [];
        target.path.forEach((sub, s) => {
          sub.anchors.forEach((a, i) => {
            if (rectContainsPoint(rect, apply(target.world, a))) hits.push(anchorKey({ s, i }));
          });
        });
        editor.selectAnchors([...drag.base, ...hits.filter((k) => !drag.base.includes(k))]);
        return true;
      }
      case "anchors": {
        if (!drag.moved && !far) return true;
        drag.moved = true;
        this.#begin("Move points");
        const local = apply(invert(drag.world), page);
        let dx = local.x - drag.startLocal.x;
        let dy = local.y - drag.startLocal.y;
        if (input.shift) {
          if (Math.abs(dx) > Math.abs(dy)) dy = 0;
          else dx = 0;
        }
        const primary = drag.path[drag.primary.s]?.anchors[drag.primary.i];
        if (primary && !input.mod) {
          const snapped = this.#snapToAnchor(drag, { x: primary.x + dx, y: primary.y + dy });
          if (snapped) {
            dx = snapped.x - primary.x;
            dy = snapped.y - primary.y;
          }
        }
        this.#apply(drag.node, moveAnchors(drag.path, drag.keys, dx, dy), "Move points");
        return true;
      }
      case "handle": {
        if (!drag.moved && !far) return true;
        drag.moved = true;
        this.#begin("Move handle");
        const anchor = drag.path[drag.ref.s]?.anchors[drag.ref.i];
        if (!anchor) return true;
        let local = apply(invert(drag.world), page);
        if (input.shift) local = snap45(anchor, local);
        const next = setHandle(
          drag.path,
          drag.ref,
          drag.side,
          local,
          input.alt ? "free" : "mirror",
        );
        this.#apply(drag.node, next, "Move handle");
        return true;
      }
    }
  }

  /** The nearest other anchor within pick range of `p` (local), in start-of-drag coordinates. */
  #snapToAnchor(drag: Extract<Drag, { kind: "anchors" }>, p: Point): Point | null {
    const screen = this.#screen(drag.world, p);
    let best: Point | null = null;
    let bestD = PICK_PX;
    drag.path.forEach((sub, s) => {
      sub.anchors.forEach((a, i) => {
        if (drag.keys.has(anchorKey({ s, i }))) return;
        const q = this.#screen(drag.world, a);
        const d = Math.hypot(q.x - screen.x, q.y - screen.y);
        if (d <= bestD) {
          bestD = d;
          best = { x: a.x, y: a.y };
        }
      });
    });
    return best;
  }

  /** Commits a path computed in the start-of-drag box, against the live node. */
  #apply(start: NodeRecord, path: VectorPath, label: string): void {
    const editor = this.#editor;
    const live = editor.doc.get(start.id);
    if (!live) return;
    const ops = fittedOps(live, fitToNode(start, path));
    if (ops.length > 0) editor.commit(ops, label);
  }

  up(_input: PointerInput): boolean {
    const editor = this.#editor;
    const drag = this.#drag;
    this.#drag = null;
    if (!drag) return editor.s.vectorEdit !== null;
    if (drag.kind === "empty") {
      if (drag.marquee) editor.state.set({ marquee: null });
      else if (!drag.additive) {
        const target = this.#target();
        const local = target && apply(invert(target.world), drag.startPage);
        const onShape =
          target &&
          local &&
          hitPathData(getProp(target.node.props, "pathData"), local, {
            fill: true,
            fillRule: getProp(target.node.props, "windingRule"),
            strokeReach: SEGMENT_PX * this.#localPerPx(target.world),
          });
        // A click away from the shape leaves vector edit; inside it clears the anchor selection.
        if (onShape) editor.selectAnchors([]);
        else editor.exitVectorEdit();
      }
    }
    this.#end();
    return true;
  }

  key(input: KeyInput): boolean {
    const editor = this.#editor;
    const v = editor.s.vectorEdit;
    if (!v) return false;
    switch (input.key) {
      case "Escape":
      case "Enter":
        if (this.#drag) this.cancel();
        editor.exitVectorEdit();
        return true;
      case "Backspace":
      case "Delete":
        editor.deleteSelectedAnchors();
        return true;
      case "ArrowLeft":
      case "ArrowRight":
      case "ArrowUp":
      case "ArrowDown": {
        const step = input.shift ? 10 : 1;
        const dx = input.key === "ArrowLeft" ? -step : input.key === "ArrowRight" ? step : 0;
        const dy = input.key === "ArrowUp" ? -step : input.key === "ArrowDown" ? step : 0;
        editor.nudgeAnchors(dx, dy);
        return true;
      }
      case "a":
      case "A": {
        if (!input.mod) return false;
        const path = editor.pathOf(v.id) ?? [];
        editor.selectAnchors(
          path.flatMap((sub, s) => sub.anchors.map((_, i) => anchorKey({ s, i }))),
        );
        return true;
      }
      default:
        return false;
    }
  }

  cancel(): void {
    const drag = this.#drag;
    this.#drag = null;
    if (drag?.kind === "empty" && drag.marquee) this.#editor.state.set({ marquee: null });
    this.#end();
  }

  #hover(input: PointerInput): void {
    const target = this.#target();
    if (!target) return;
    const { path, world } = target;
    if (this.#handleAt(path, world, input.screen) || this.#anchorAt(path, world, input.screen)) {
      this.cursor = "move";
      return;
    }
    const local = apply(invert(world), this.#editor.s.camera.toPage(input.screen));
    const near = nearestOnPath(path, local);
    this.cursor =
      near && near.distance <= SEGMENT_PX * this.#localPerPx(world) ? "copy" : "default";
  }
}
