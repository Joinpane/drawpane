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

/**
 * The corners of a regular polygon (`count` points) or a star (`count` outer
 * points, with inner points at `inner` × the outer radius), inscribed in the
 * ellipse that fills a `w` × `h` box, starting at the top and going clockwise.
 */
export function shapeVertices(
  w: number,
  h: number,
  count: number,
  inner: number | null = null,
): Point[] {
  const n = Math.max(3, Math.round(count));
  const total = inner === null ? n : n * 2;
  const out: Point[] = [];
  for (let i = 0; i < total; i++) {
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / total;
    const r = inner !== null && i % 2 === 1 ? inner : 1;
    out.push({
      x: w / 2 + (Math.cos(angle) * r * w) / 2,
      y: h / 2 + (Math.sin(angle) * r * h) / 2,
    });
  }
  return out;
}

/**
 * A closed path through `vertices` with each corner rounded by `radius`: a
 * circular arc tangent to both edges (as a cubic), shrunk where the edges
 * are too short for it, like Figma's rounded polygons.
 */
export function roundedPolygonPath(vertices: readonly Point[], radius: number): VectorPath {
  const n = vertices.length;
  if (radius <= 0 || n < 3) {
    return [
      { closed: true, anchors: vertices.map((v) => ({ x: v.x, y: v.y, in: null, out: null })) },
    ];
  }
  const at = (i: number) => vertices[((i % n) + n) % n] as Point;
  const anchors: Anchor[] = [];
  for (let i = 0; i < n; i++) {
    const v = at(i);
    const prev = at(i - 1);
    const next = at(i + 1);
    const toPrev = { x: prev.x - v.x, y: prev.y - v.y };
    const toNext = { x: next.x - v.x, y: next.y - v.y };
    const lp = Math.hypot(toPrev.x, toPrev.y);
    const ln = Math.hypot(toNext.x, toNext.y);
    if (lp < 1e-9 || ln < 1e-9) {
      anchors.push({ x: v.x, y: v.y, in: null, out: null });
      continue;
    }
    const up = { x: toPrev.x / lp, y: toPrev.y / lp };
    const un = { x: toNext.x / ln, y: toNext.y / ln };
    // The corner's interior angle, and how far along each edge the arc starts.
    const cos = Math.max(-1, Math.min(1, up.x * un.x + up.y * un.y));
    const angle = Math.acos(cos);
    if (angle < 1e-6 || Math.PI - angle < 1e-6) {
      anchors.push({ x: v.x, y: v.y, in: null, out: null });
      continue;
    }
    const tan = Math.tan(angle / 2);
    // Each edge gives at most half its length to each of its two corners.
    const reach = Math.min(radius / tan, lp / 2, ln / 2);
    const r = reach * tan;
    const a = { x: v.x + up.x * reach, y: v.y + up.y * reach };
    const b = { x: v.x + un.x * reach, y: v.y + un.y * reach };
    // A circular arc turning through (π - angle): handles of 4/3·tan(turn/4)·r.
    const handle = (4 / 3) * Math.tan((Math.PI - angle) / 4) * r;
    anchors.push({
      x: a.x,
      y: a.y,
      in: null,
      out: { x: a.x - up.x * handle, y: a.y - up.y * handle },
    });
    anchors.push({
      x: b.x,
      y: b.y,
      in: { x: b.x - un.x * handle, y: b.y - un.y * handle },
      out: null,
    });
  }
  return [{ closed: true, anchors: mergeCoincident(anchors, true) }];
}

export function polygonPath(w: number, h: number, count: number, radius = 0): VectorPath {
  return roundedPolygonPath(shapeVertices(w, h, count), radius);
}

export function starPath(
  w: number,
  h: number,
  count: number,
  inner: number,
  radius = 0,
): VectorPath {
  return roundedPolygonPath(shapeVertices(w, h, count, inner), radius);
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
  if (["rect", "ellipse", "polygon", "star", "line"].includes(node.type)) return true;
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
    case "polygon":
      return polygonPath(
        w,
        h,
        getProp(node.props, "pointCount"),
        getProp(node.props, "cornerRadius"),
      );
    case "star":
      return starPath(
        w,
        h,
        getProp(node.props, "pointCount"),
        getProp(node.props, "innerRadius"),
        getProp(node.props, "cornerRadius"),
      );
    case "line":
      return linePath(w, h);
    case "path":
      return parsePathCached(getProp(node.props, "pathData"));
    default:
      return null;
  }
}
