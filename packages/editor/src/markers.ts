/**
 * End markers on open strokes: arrows, triangles, dots, diamonds and bars at
 * the start and end of a line or an open path, like Figma's stroke ends.
 * Pure geometry in the layer's local box, shared by the canvas renderer and
 * SVG export so both draw the same thing.
 */
import { getProp, type NodeRecord, type StrokeMarker } from "@drawpane/model";
import type { Point } from "./geometry";
import { parsePathCached } from "./vector/cache";
import {
  type Anchor,
  cubicAt,
  type Subpath,
  segmentOf,
  splitCubic,
  type VectorPath,
} from "./vector/path";
import { KAPPA } from "./vector/shapes";

/** An open end of a stroke: where it is, and the unit direction pointing out of the stroke. */
export interface OpenEnd {
  readonly point: Point;
  readonly dir: Point;
}

const unit = (v: Point): Point | null => {
  const l = Math.hypot(v.x, v.y);
  return l > 1e-9 ? { x: v.x / l, y: v.y / l } : null;
};

/** The first open subpath of a path, or the line, as the stroke the markers sit on. */
function openSubpath(node: NodeRecord): { path: VectorPath; index: number } | null {
  if (node.type === "line") {
    const w = getProp(node.props, "width");
    const h = getProp(node.props, "height");
    return {
      path: [
        {
          closed: false,
          anchors: [
            { x: 0, y: h / 2, in: null, out: null },
            { x: w, y: h / 2, in: null, out: null },
          ],
        },
      ],
      index: 0,
    };
  }
  if (node.type !== "path") return null;
  const path = parsePathCached(getProp(node.props, "pathData"));
  const index = path.findIndex((sub) => !sub.closed && sub.anchors.length >= 2);
  return index === -1 ? null : { path, index };
}

/** The first point after `from` along the stroke that isn't on top of it (a handle or the next anchor). */
function awayFrom(anchor: Anchor, handle: Point | null, next: Anchor): Point {
  for (const p of [handle, next.in, next]) {
    if (p && Math.hypot(p.x - anchor.x, p.y - anchor.y) > 1e-9) return p;
  }
  return next;
}

/** Where a line's or open path's two ends are, and which way they point. Null for closed shapes. */
export function openEnds(node: NodeRecord): { start: OpenEnd; end: OpenEnd } | null {
  const open = openSubpath(node);
  if (!open) return null;
  const anchors = (open.path[open.index] as Subpath).anchors;
  const first = anchors[0] as Anchor;
  const second = anchors[1] as Anchor;
  const last = anchors[anchors.length - 1] as Anchor;
  const beforeLast = anchors[anchors.length - 2] as Anchor;
  const toward = awayFrom(first, first.out, second);
  const from = awayFrom(last, last.in, { ...beforeLast, in: beforeLast.out });
  const startDir = unit({ x: first.x - toward.x, y: first.y - toward.y });
  const endDir = unit({ x: last.x - from.x, y: last.y - from.y });
  if (!startDir || !endDir) return null;
  return {
    start: { point: { x: first.x, y: first.y }, dir: startDir },
    end: { point: { x: last.x, y: last.y }, dir: endDir },
  };
}

/** How long a marker is for a stroke weight: readable on hairlines, in proportion on thick strokes. */
export function markerLength(weight: number): number {
  return 4 + Math.max(0, weight) * 4;
}

export interface MarkerShape {
  /** Filled outline (triangle, circle, diamond), or null. */
  readonly fill: VectorPath | null;
  /** Stroked lines (arrow, bar), or null. */
  readonly stroke: VectorPath | null;
  /** How far to pull the stroke's end back so it doesn't poke through a filled marker. */
  readonly inset: number;
}

const rotate = (v: Point, angle: number): Point => ({
  x: v.x * Math.cos(angle) - v.y * Math.sin(angle),
  y: v.x * Math.sin(angle) + v.y * Math.cos(angle),
});

const corner = (p: Point): Anchor => ({ x: p.x, y: p.y, in: null, out: null });

/** A marker's geometry at an open end, for a stroke of `weight`. */
export function markerShape(kind: StrokeMarker, end: OpenEnd, weight: number): MarkerShape {
  const none: MarkerShape = { fill: null, stroke: null, inset: 0 };
  if (kind === "none") return none;
  const L = markerLength(weight);
  const { point: tip, dir } = end;
  const back = { x: -dir.x, y: -dir.y };
  const along = (d: Point, k: number) => ({ x: tip.x + d.x * k, y: tip.y + d.y * k });
  const normal = { x: -dir.y, y: dir.x };
  switch (kind) {
    case "arrow": {
      // Two strokes back from the tip at ±35°, like an arrowhead drawn with the pen.
      const a = along(rotate(back, Math.PI * (35 / 180)), L);
      const b = along(rotate(back, -Math.PI * (35 / 180)), L);
      return {
        fill: null,
        stroke: [{ closed: false, anchors: [a, tip, b].map(corner) }],
        inset: 0,
      };
    }
    case "triangle": {
      const base = along(back, L);
      const half = L * 0.6;
      const outward = along(dir, weight / 2);
      return {
        fill: [
          {
            closed: true,
            anchors: [
              outward,
              { x: base.x + normal.x * half, y: base.y + normal.y * half },
              { x: base.x - normal.x * half, y: base.y - normal.y * half },
            ].map(corner),
          },
        ],
        stroke: null,
        // Pull the line back inside the triangle, so a butt end can't show past its point.
        inset: L * 0.6,
      };
    }
    case "diamond": {
      const d = L * 0.5;
      return {
        fill: [
          {
            closed: true,
            anchors: [
              along(dir, d),
              { x: tip.x + normal.x * d, y: tip.y + normal.y * d },
              along(back, d),
              { x: tip.x - normal.x * d, y: tip.y - normal.y * d },
            ].map(corner),
          },
        ],
        stroke: null,
        inset: 0,
      };
    }
    case "circle": {
      const r = L * 0.4;
      const k = KAPPA * r;
      const c = tip;
      return {
        fill: [
          {
            closed: true,
            anchors: [
              {
                x: c.x + r,
                y: c.y,
                in: { x: c.x + r, y: c.y - k },
                out: { x: c.x + r, y: c.y + k },
              },
              {
                x: c.x,
                y: c.y + r,
                in: { x: c.x + k, y: c.y + r },
                out: { x: c.x - k, y: c.y + r },
              },
              {
                x: c.x - r,
                y: c.y,
                in: { x: c.x - r, y: c.y + k },
                out: { x: c.x - r, y: c.y - k },
              },
              {
                x: c.x,
                y: c.y - r,
                in: { x: c.x - k, y: c.y - r },
                out: { x: c.x + k, y: c.y - r },
              },
            ],
          },
        ],
        stroke: null,
        inset: 0,
      };
    }
    case "bar": {
      const half = L * 0.55;
      return {
        fill: null,
        stroke: [
          {
            closed: false,
            anchors: [
              { x: tip.x + normal.x * half, y: tip.y + normal.y * half },
              { x: tip.x - normal.x * half, y: tip.y - normal.y * half },
            ].map(corner),
          },
        ],
        inset: 0,
      };
    }
  }
}

/** The markers a layer draws, or null when it has none. */
export function markersOf(
  node: NodeRecord,
): { start: MarkerShape; end: MarkerShape; ends: { start: OpenEnd; end: OpenEnd } } | null {
  if (node.type !== "line" && node.type !== "path") return null;
  const startKind = getProp(node.props, "markerStart");
  const endKind = getProp(node.props, "markerEnd");
  if (startKind === "none" && endKind === "none") return null;
  const ends = openEnds(node);
  if (!ends) return null;
  const weight = getProp(node.props, "strokeWeight");
  return {
    start: markerShape(startKind, ends.start, weight),
    end: markerShape(endKind, ends.end, weight),
    ends,
  };
}

/** Cuts `length` off one end of a subpath (the start when `atStart`), along its first or last segment. */
function trimSubpath(sub: Subpath, length: number, atStart: boolean): Subpath {
  if (length <= 0 || sub.anchors.length < 2) return sub;
  const anchors = [...sub.anchors];
  const i = atStart ? 0 : anchors.length - 2;
  const a = anchors[i] as Anchor;
  const b = anchors[i + 1] as Anchor;
  const c = segmentOf(a, b);
  const chord = Math.hypot(c.p3.x - c.p0.x, c.p3.y - c.p0.y);
  if (chord < 1e-9) return sub;
  // Where on the segment the stroke is `length` away from its end (by distance,
  // not by t: a cubic doesn't move at constant speed). Never past 90% of it.
  const end = atStart ? c.p0 : c.p3;
  const distance = (u: number) => {
    const p = cubicAt(c, atStart ? u : 1 - u);
    return Math.hypot(p.x - end.x, p.y - end.y);
  };
  const target = Math.min(length, chord * 0.9);
  let lo = 0;
  let hi = 1;
  for (let k = 0; k < 40; k++) {
    const mid = (lo + hi) / 2;
    if (distance(mid) < target) lo = mid;
    else hi = mid;
  }
  const t = (lo + hi) / 2;
  if (atStart) {
    const [, rest] = splitCubic(c, t);
    anchors[0] = { x: rest.p0.x, y: rest.p0.y, in: null, out: rest.p1 };
    anchors[1] = { ...b, in: rest.p2 };
  } else {
    const [head] = splitCubic(c, 1 - t);
    anchors[i] = { ...a, out: head.p1 };
    anchors[i + 1] = { x: head.p3.x, y: head.p3.y, in: head.p2, out: null };
  }
  return { ...sub, anchors };
}

/** The stroke path with its ends pulled back under filled markers. */
export function trimmedStroke(
  node: NodeRecord,
  startInset: number,
  endInset: number,
): VectorPath | null {
  const open = openSubpath(node);
  if (!open || (startInset <= 0 && endInset <= 0)) return null;
  return open.path.map((sub, i) =>
    i === open.index ? trimSubpath(trimSubpath(sub, startInset, true), endInset, false) : sub,
  );
}
