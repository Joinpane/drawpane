/**
 * The corner geometry (corner-geometry.ts) drawn on a 2D canvas: the only
 * canvas-specific part, kept thin.
 */
import { fitCorners, type Radii } from "./corner-geometry";
import { boxPath, isSquare, KEPT, keep, keyOf, recall, tracePath } from "./corners";

const kept = new Map<string, Path2D>();

/**
 * The outline as a Path2D, at (x, y), cached by its inputs: a screen of
 * identical buttons builds one. Shared: never add to it.
 */
export function boxPath2D(w: number, h: number, radii: Radii, smoothing = 0, x = 0, y = 0): Path2D {
  const key = `${keyOf(w, h, radii, smoothing)},${x},${y}`;
  const hit = recall(kept, key);
  if (hit) return hit;
  const path = new Path2D();
  const corners = fitCorners(w, h, radii, smoothing);
  if (isSquare(radii)) path.rect(x, y, w, h);
  else if (corners.every((c) => c.smoothing === 0))
    // Plain circles: the canvas's own rounded rectangle, the geometry's outline to 0.03% of the
    // radius, which Chrome anti-aliases exactly, as Figma's renderer draws plain corners.
    path.roundRect(
      x,
      y,
      w,
      h,
      corners.map((c) => c.radius),
    );
  else tracePath(path, boxPath(w, h, radii, smoothing), x, y);
  return keep(kept, key, path, KEPT);
}
