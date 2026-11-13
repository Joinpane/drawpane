/**
 * Auto layout, mapped 1:1 to CSS flexbox (`display: flex`, `flex-direction`,
 * `gap`, `padding`, `justify-content`, `align-items`, `flex-wrap`, and per
 * child `flex: 1` for Fill, `fit-content` for Hug, `position: absolute`).
 *
 * The editor that makes an edit runs layout and writes the results into the
 * same transaction. Every peer then sees identical positions without running
 * layout itself, and files stay plain data.
 */
import { getProp, type NodeRecord, type Op } from "@drawpane/model";
import type { Doc } from "./doc";
import { round2 } from "./geometry";

export interface LayoutBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

type Axis = "h" | "v";

function isLayoutFrame(node: NodeRecord | undefined): node is NodeRecord {
  return node?.type === "frame" && getProp(node.props, "layoutMode") !== "none";
}

function participates(node: NodeRecord): boolean {
  return getProp(node.props, "visible") && getProp(node.props, "positioning") === "auto";
}

function clamp(value: number, min: number | null, max: number | null): number {
  let v = value;
  if (max !== null && v > max) v = max;
  if (min !== null && v < min) v = min;
  return Math.max(0, v);
}

function sizing(node: NodeRecord, axis: Axis) {
  return getProp(node.props, axis === "h" ? "sizingH" : "sizingV");
}

function limits(node: NodeRecord, axis: Axis): [number | null, number | null] {
  return axis === "h"
    ? [getProp(node.props, "minWidth"), getProp(node.props, "maxWidth")]
    : [getProp(node.props, "minHeight"), getProp(node.props, "maxHeight")];
}

/**
 * Computes boxes for a layout frame and everything below it that layout
 * controls. `boxes` holds the result; the frame's own size may change when it
 * hugs its content.
 */
export class LayoutEngine {
  readonly #doc: Doc;
  readonly boxes = new Map<string, LayoutBox>();

  constructor(doc: Doc) {
    this.#doc = doc;
  }

  box(id: string): LayoutBox {
    let box = this.boxes.get(id);
    if (!box) {
      const node = this.#doc.get(id);
      const p = node?.props ?? {};
      box = {
        x: getProp(p, "x"),
        y: getProp(p, "y"),
        width: getProp(p, "width"),
        height: getProp(p, "height"),
      };
      this.boxes.set(id, box);
    }
    return box;
  }

  #children(frame: NodeRecord): NodeRecord[] {
    const out: NodeRecord[] = [];
    for (const id of this.#doc.childIds(frame.id)) {
      const child = this.#doc.get(id);
      if (child && child.type !== "group" && participates(child)) out.push(child);
    }
    return out;
  }

  /** Bottom-up: settle the size of a hugging layout frame from its content. */
  measure(frame: NodeRecord): void {
    const children = this.#children(frame);
    for (const child of children) if (isLayoutFrame(child)) this.measure(child);
    const p = frame.props;
    const row = getProp(p, "layoutMode") === "row";
    const main: Axis = row ? "h" : "v";
    const cross: Axis = row ? "v" : "h";
    const gap = getProp(p, "gap");
    const padMain = row
      ? getProp(p, "paddingLeft") + getProp(p, "paddingRight")
      : getProp(p, "paddingTop") + getProp(p, "paddingBottom");
    const padCross = row
      ? getProp(p, "paddingTop") + getProp(p, "paddingBottom")
      : getProp(p, "paddingLeft") + getProp(p, "paddingRight");
    const size = (n: NodeRecord, axis: Axis) =>
      axis === "h" ? this.box(n.id).width : this.box(n.id).height;
    const box = this.box(frame.id);

    if (sizing(frame, main) === "hug") {
      const total =
        children.reduce((sum, c) => sum + size(c, main), 0) +
        gap * Math.max(0, children.length - 1);
      const [min, max] = limits(frame, main);
      const value = clamp(total + padMain, min, max);
      if (main === "h") box.width = value;
      else box.height = value;
    }
    if (sizing(frame, cross) === "hug") {
      const largest = children.reduce((m, c) => Math.max(m, size(c, cross)), 0);
      const [min, max] = limits(frame, cross);
      const value = clamp(largest + padCross, min, max);
      if (cross === "h") box.width = value;
      else box.height = value;
    }
  }

  /** Top-down: place children of a layout frame whose own size is settled. */
  arrange(frame: NodeRecord): void {
    const p = frame.props;
    const row = getProp(p, "layoutMode") === "row";
    const main: Axis = row ? "h" : "v";
    const cross: Axis = row ? "v" : "h";
    const frameBox = this.box(frame.id);
    const padTop = getProp(p, "paddingTop");
    const padRight = getProp(p, "paddingRight");
    const padBottom = getProp(p, "paddingBottom");
    const padLeft = getProp(p, "paddingLeft");
    const innerMain = Math.max(
      0,
      row ? frameBox.width - padLeft - padRight : frameBox.height - padTop - padBottom,
    );
    const innerCross = Math.max(
      0,
      row ? frameBox.height - padTop - padBottom : frameBox.width - padLeft - padRight,
    );
    const startMain = row ? padLeft : padTop;
    const startCross = row ? padTop : padLeft;
    const gap = getProp(p, "gap");
    const justify = getProp(p, "justifyContent");
    const align = getProp(p, "alignItems");
    const frameHugsMain = sizing(frame, main) === "hug";

    const children = this.#children(frame);
    const get = (id: string, axis: Axis) =>
      axis === "h" ? this.box(id).width : this.box(id).height;
    const set = (id: string, axis: Axis, value: number) => {
      const b = this.box(id);
      if (axis === "h") b.width = value;
      else b.height = value;
    };

    // Main axis sizes: Fill children share what is left (a hugging parent can't be filled).
    const fills = children.filter((c) => sizing(c, main) === "fill" && !frameHugsMain);
    const fixedTotal = children
      .filter((c) => !fills.includes(c))
      .reduce((s, c) => s + get(c.id, main), 0);
    let remaining = innerMain - fixedTotal - gap * Math.max(0, children.length - 1);
    // Distribute, respecting min/max: clamped children drop out and the rest re-share.
    let open = [...fills];
    for (let pass = 0; pass < 4 && open.length > 0; pass++) {
      const share = Math.max(0, remaining) / open.length;
      const next: NodeRecord[] = [];
      let used = 0;
      for (const child of open) {
        const [min, max] = limits(child, main);
        const value = clamp(share, min, max);
        set(child.id, main, value);
        if (value !== share) used += value;
        else next.push(child);
      }
      if (next.length === open.length) break;
      remaining -= used;
      open = next;
    }

    // Cross axis sizes.
    for (const child of children) {
      if (
        sizing(child, cross) === "fill" ||
        (align === "stretch" && sizing(child, cross) !== "hug")
      ) {
        const [min, max] = limits(child, cross);
        set(child.id, cross, clamp(innerCross, min, max));
      }
    }

    // Children that are layout frames settle their own content first, so a
    // hugging child has its final size before we position it.
    for (const child of children) if (isLayoutFrame(child)) this.measure(child);

    const used = children.reduce((s, c) => s + get(c.id, main), 0);
    const free = innerMain - used - gap * Math.max(0, children.length - 1);
    let offset = startMain;
    let spacing = gap;
    if (justify === "center") offset += free / 2;
    else if (justify === "end") offset += free;
    else if (justify === "space-between" && children.length > 1) {
      spacing = gap + Math.max(0, free) / (children.length - 1);
    }

    for (const child of children) {
      const b = this.box(child.id);
      const size = get(child.id, cross);
      let crossPos = startCross;
      if (align === "center") crossPos += (innerCross - size) / 2;
      else if (align === "end") crossPos += innerCross - size;
      if (row) {
        b.x = offset;
        b.y = crossPos;
      } else {
        b.x = crossPos;
        b.y = offset;
      }
      offset += get(child.id, main) + spacing;
    }

    for (const child of children) if (isLayoutFrame(child)) this.arrange(child);
  }

  /** Runs layout for a frame subtree: measure, then arrange. */
  run(frameId: string): void {
    const frame = this.#doc.get(frameId);
    if (!isLayoutFrame(frame)) return;
    this.measure(frame);
    this.arrange(frame);
  }

  /** `set` operations for every box that differs from the document. */
  diff(): Op[] {
    const ops: Op[] = [];
    for (const [id, box] of this.boxes) {
      const node = this.#doc.get(id);
      if (!node) continue;
      for (const prop of ["x", "y", "width", "height"] as const) {
        const value = round2(box[prop]);
        if (value !== round2(getProp(node.props, prop))) ops.push({ op: "set", id, prop, value });
      }
    }
    return ops;
  }
}

/**
 * The outermost layout frames whose result may change after `ids` changed:
 * walks up from each node while the parent is a layout frame, so a size change
 * deep inside hugging frames reaches the top.
 */
export function layoutRoots(doc: Doc, ids: Iterable<string>): string[] {
  const roots = new Set<string>();
  for (const id of ids) {
    let top: string | null = null;
    let node = doc.get(id);
    if (isLayoutFrame(node)) top = node.id;
    while (node) {
      const parent = doc.get(node.parent);
      if (!isLayoutFrame(parent)) break;
      top = parent.id;
      node = parent;
    }
    if (top) roots.add(top);
  }
  // Drop roots nested in other roots.
  return [...roots].filter((id) => !doc.ancestors(id).some((a) => roots.has(a.id)));
}

/** Layout fix-up operations to commit alongside an edit that touched `ids`. */
export function layoutOps(doc: Doc, ids: Iterable<string>): Op[] {
  const roots = layoutRoots(doc, ids);
  if (roots.length === 0) return [];
  const engine = new LayoutEngine(doc);
  for (const root of roots) engine.run(root);
  return engine.diff();
}
