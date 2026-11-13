import type { Rect } from "./geometry";

export interface Guide {
  readonly axis: "x" | "y";
  /** Position of the line on its axis, in page coordinates. */
  readonly at: number;
  /** Extent of the line along the other axis. */
  readonly from: number;
  readonly to: number;
}

export interface SnapResult {
  readonly dx: number;
  readonly dy: number;
  readonly guides: Guide[];
}

function stops(r: Rect, axis: "x" | "y"): number[] {
  return axis === "x"
    ? [r.x, r.x + r.width / 2, r.x + r.width]
    : [r.y, r.y + r.height / 2, r.y + r.height];
}

/** A line to snap to on one axis: a ruler guide or a layout grid edge, in page coordinates. */
export interface SnapLine {
  readonly axis: "x" | "y";
  readonly at: number;
}

/**
 * Snaps a moving rectangle's edges and centre to the edges and centres of
 * `targets`, and its edges to `lines` (guides, grid columns), independently
 * per axis, within `threshold` page units. Returns the correction to add and
 * the guides to draw.
 */
export function snapRect(
  moving: Rect,
  targets: readonly Rect[],
  threshold: number,
  lines: readonly SnapLine[] = [],
): SnapResult {
  const best = { x: { d: threshold + 1, at: 0 }, y: { d: threshold + 1, at: 0 } };
  for (const axis of ["x", "y"] as const) {
    const mine = stops(moving, axis);
    for (const t of targets) {
      for (const target of stops(t, axis)) {
        for (const m of mine) {
          const d = target - m;
          if (Math.abs(d) < Math.abs(best[axis].d)) best[axis] = { d, at: target };
        }
      }
    }
    // Guides and grid edges take the moving edges (not the centre), like Figma.
    const edges = [mine[0] as number, mine[2] as number];
    for (const line of lines) {
      if (line.axis !== axis) continue;
      for (const m of edges) {
        const d = line.at - m;
        if (Math.abs(d) < Math.abs(best[axis].d)) best[axis] = { d, at: line.at };
      }
    }
  }
  const dx = Math.abs(best.x.d) <= threshold ? best.x.d : 0;
  const dy = Math.abs(best.y.d) <= threshold ? best.y.d : 0;
  const snapped = {
    x: moving.x + dx,
    y: moving.y + dy,
    width: moving.width,
    height: moving.height,
  };
  const guides: Guide[] = [];
  for (const axis of ["x", "y"] as const) {
    if ((axis === "x" ? dx : dy) === 0 && Math.abs(best[axis].d) > threshold) continue;
    const guide = snapGuide(snapped, targets, axis, best[axis].at);
    if (guide) guides.push(guide);
  }
  return { dx, dy, guides };
}

/**
 * The guide to draw where `rect` meets the line `at` on `axis`, spanning every
 * target that shares the line. Null when the rect doesn't touch it.
 */
export function snapGuide(
  rect: Rect,
  targets: readonly Rect[],
  axis: "x" | "y",
  at: number,
): Guide | null {
  if (!stops(rect, axis).some((m) => Math.abs(m - at) < 0.01)) return null;
  let from = axis === "x" ? rect.y : rect.x;
  let to = axis === "x" ? rect.y + rect.height : rect.x + rect.width;
  for (const t of targets) {
    if (!stops(t, axis).some((s) => Math.abs(s - at) < 0.01)) continue;
    from = Math.min(from, axis === "x" ? t.y : t.x);
    to = Math.max(to, axis === "x" ? t.y + t.height : t.x + t.width);
  }
  return { axis, at, from, to };
}

/**
 * Snaps edges being dragged (a resize handle's edges, on one axis) to the
 * edges and centres of `targets` and to `lines`. Returns the correction to
 * add and the line it snapped to, or null when nothing is within `threshold`.
 */
export function snapEdges(
  edges: readonly number[],
  axis: "x" | "y",
  targets: readonly Rect[],
  threshold: number,
  lines: readonly SnapLine[] = [],
): { d: number; at: number } | null {
  let best: { d: number; at: number } | null = null;
  const consider = (at: number) => {
    for (const edge of edges) {
      const d = at - edge;
      if (Math.abs(d) <= threshold && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, at };
    }
  };
  for (const t of targets) for (const at of stops(t, axis)) consider(at);
  for (const line of lines) if (line.axis === axis) consider(line.at);
  return best;
}
