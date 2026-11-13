/**
 * Paths on nodes. A path node stores its `pathData` in its own local box;
 * after an edit, the box (x, y, width, height) is re-fitted to the path's
 * exact bounds and the path is translated so its bounds start at 0,0. The
 * layer stays where it was on screen, rotation and flips included, and resize
 * handles and auto layout see the real size.
 */
import { getProp, type NodeRecord, type Op, type PropName } from "@drawpane/model";
import type { Doc } from "../doc";
import { apply, boxOf, localMatrix } from "../geometry";
import { fitPath, transformPath } from "./bounds";
import { parsePathCached } from "./cache";
import type { VectorPath } from "./path";
import { serializePath } from "./svg";

/** Path geometry keeps 3 decimals, the same precision as its path data. */
export function round3(n: number): number {
  const r = Math.round(n * 1000) / 1000;
  return r === 0 ? 0 : r;
}

export interface FittedPath {
  readonly pathData: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Fits a path given in `node`'s current local box: the new box, in the
 * node's parent space, and the path data relative to it.
 */
export function fitToNode(node: NodeRecord, local: VectorPath): FittedPath {
  const { path, bounds } = fitPath(local);
  const w = bounds.width;
  const h = bounds.height;
  // The new box's centre, through the old local matrix, gives its position;
  // rotation and flips are unchanged, so every point stays put.
  const centre = apply(localMatrix(boxOf(node)), {
    x: bounds.x + w / 2,
    y: bounds.y + h / 2,
  });
  return {
    pathData: serializePath(path),
    x: round3(centre.x - w / 2),
    y: round3(centre.y - h / 2),
    width: round3(w),
    height: round3(h),
  };
}

/** Set operations that put a fitted path on a node, skipping unchanged properties. */
export function fittedOps(node: NodeRecord, fitted: FittedPath): Op[] {
  const ops: Op[] = [];
  const props: Array<[PropName, string | number]> = [
    ["pathData", fitted.pathData],
    ["x", fitted.x],
    ["y", fitted.y],
    ["width", fitted.width],
    ["height", fitted.height],
  ];
  for (const [prop, value] of props) {
    if (getProp(node.props, prop) !== value) ops.push({ op: "set", id: node.id, prop, value });
  }
  return ops;
}

/** The operations that replace a path node's geometry with `local` (in its current box). */
export function setPathOps(node: NodeRecord, local: VectorPath): Op[] {
  return fittedOps(node, fitToNode(node, local));
}

/** Path data scaled from the node's current box to a new size (resize handles, layout). */
export function scaledPathData(node: NodeRecord, width: number, height: number): string | null {
  const w = getProp(node.props, "width");
  const h = getProp(node.props, "height");
  const sx = w > 0 ? width / w : 1;
  const sy = h > 0 ? height / h : 1;
  if (sx === 1 && sy === 1) return null;
  const path = parsePathCached(getProp(node.props, "pathData"));
  return serializePath(transformPath(path, [sx, 0, 0, sy, 0, 0]));
}

/**
 * Derived fix-up for a commit: when a path's width or height changes without
 * new path data (a resize, the inspector, auto layout), scale the path to
 * the new box so it keeps filling it. Reads the document before the commit.
 */
export function pathResizeOps(doc: Doc, ops: readonly Op[]): Op[] {
  const sizes = new Map<string, { width?: number; height?: number }>();
  const withData = new Set<string>();
  for (const op of ops) {
    if (op.op === "create") withData.add(op.id);
    if (op.op !== "set") continue;
    if (op.prop === "pathData") withData.add(op.id);
    if ((op.prop === "width" || op.prop === "height") && typeof op.value === "number") {
      const entry = sizes.get(op.id) ?? {};
      entry[op.prop] = op.value;
      sizes.set(op.id, entry);
    }
  }
  const out: Op[] = [];
  for (const [id, size] of sizes) {
    if (withData.has(id)) continue;
    const node = doc.get(id);
    if (node?.type !== "path") continue;
    const d = scaledPathData(
      node,
      size.width ?? getProp(node.props, "width"),
      size.height ?? getProp(node.props, "height"),
    );
    if (d !== null && d !== getProp(node.props, "pathData"))
      out.push({ op: "set", id, prop: "pathData", value: d });
  }
  return out;
}
