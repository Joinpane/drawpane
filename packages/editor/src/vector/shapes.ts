/**
 * Built-in shapes as vector paths in their own local box, drawn exactly as
 * the renderer draws them (rounded corners use the standard circle constant).
 */
import { getProp, type NodeRecord } from "@drawpane/model";
import type { Point } from "../geometry";
import { parsePathCached } from "./cache";
import type { Anchor, VectorPath } from "./path";

/** Handle length for a quarter circle of radius 1. */
export const KAPPA = 0.5522847498307936;

export function rectPath(
  w: number,
  h: number,
  radii: readonly [number, number, number, number] = [0, 0, 0, 0],
): VectorPath {
  const max = Math.min(w, h) / 2;
  const [tl, tr, br, bl] = radii.map((r) => Math.max(0, Math.min(r, max))) as [
    number,
    number,
    number,
    number,
  ];
  const anchors: Anchor[] = [];
  const corner = (r: number, at: Point, from: Point, to: Point) => {
    // `from` and `to` are unit directions into and out of the corner.
    if (r <= 0) {
      anchors.push({ x: at.x, y: at.y, in: null, out: null });
      return;
    }
    const a = { x: at.x - from.x * r, y: at.y - from.y * r };
    const b = { x: at.x + to.x * r, y: at.y + to.y * r };
    const k = KAPPA * r;
    anchors.push({ x: a.x, y: a.y, in: null, out: { x: a.x + from.x * k, y: a.y + from.y * k } });
    anchors.push({ x: b.x, y: b.y, in: { x: b.x - to.x * k, y: b.y - to.y * k }, out: null });
  };
  corner(tl, { x: 0, y: 0 }, { x: 0, y: -1 }, { x: 1, y: 0 });
  corner(tr, { x: w, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 });
  corner(br, { x: w, y: h }, { x: 0, y: 1 }, { x: -1, y: 0 });
  corner(bl, { x: 0, y: h }, { x: -1, y: 0 }, { x: 0, y: -1 });
  // The first corner starts with its arc: rotate so the path starts at the top edge.
  if (tl > 0) anchors.push(anchors.shift() as Anchor);
  return [{ anchors: mergeCoincident(anchors, true), closed: true }];
}

export function ellipsePath(w: number, h: number): VectorPath {
  const rx = w / 2;
  const ry = h / 2;
  const kx = KAPPA * rx;
  const ky = KAPPA * ry;
  return [
    {
      closed: true,
      anchors: [
        { x: w, y: ry, in: { x: w, y: ry - ky }, out: { x: w, y: ry + ky } },
        { x: rx, y: h, in: { x: rx + kx, y: h }, out: { x: rx - kx, y: h } },
        { x: 0, y: ry, in: { x: 0, y: ry + ky }, out: { x: 0, y: ry - ky } },
        { x: rx, y: 0, in: { x: rx - kx, y: 0 }, out: { x: rx + kx, y: 0 } },
      ],
    },
  ];
}

export function linePath(w: number, h: number): VectorPath {
  return [
    {
      closed: false,
      anchors: [
        { x: 0, y: h / 2, in: null, out: null },
        { x: w, y: h / 2, in: null, out: null },
      ],
    },
  ];
}

/** Joins consecutive anchors at the same spot (a pill's straight edge of length 0). */
function mergeCoincident(anchors: Anchor[], closed: boolean): Anchor[] {
  const out: Anchor[] = [];
  for (const a of anchors) {
    const prev = out[out.length - 1];
    if (prev && Math.abs(prev.x - a.x) < 1e-9 && Math.abs(prev.y - a.y) < 1e-9) {
      out[out.length - 1] = { x: prev.x, y: prev.y, in: prev.in, out: a.out };
    } else out.push(a);
  }
  if (closed && out.length > 1) {
    const first = out[0] as Anchor;
    const last = out[out.length - 1] as Anchor;
    if (Math.abs(first.x - last.x) < 1e-9 && Math.abs(first.y - last.y) < 1e-9) {
      out[0] = { x: first.x, y: first.y, in: last.in, out: first.out };
      out.pop();
    }
  }
  return out;
}

/** Node types that convert to an equivalent path. */
export function isConvertible(node: NodeRecord, hasChildren: boolean): boolean {
  if (node.type === "rect" || node.type === "ellipse" || node.type === "line") return true;
  if (node.type === "path") return true;
  return node.type === "frame" && !hasChildren;
}

/** A node's outline as a path in its own local box, or null for types without one. */
export function nodePath(node: NodeRecord): VectorPath | null {
  const w = getProp(node.props, "width");
  const h = getProp(node.props, "height");
  switch (node.type) {
    case "rect":
    case "frame": {
      const radii = getProp(node.props, "cornerRadii");
      const r = getProp(node.props, "cornerRadius");
      return rectPath(w, h, radii ?? [r, r, r, r]);
    }
    case "ellipse":
      return ellipsePath(w, h);
    case "line":
      return linePath(w, h);
    case "path":
      return parsePathCached(getProp(node.props, "pathData"));
    default:
      return null;
  }
}
