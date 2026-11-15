/**
 * Geometry for the converter. Penpot stores every shape in absolute page
 * coordinates, with no inherited transforms: a shape's box is its unrotated
 * `selrect` turned by `transform` about the box's centre. Drawpane stores a
 * box (x, y, width, height, rotation, flip) in its parent frame's space. So
 * each shape's page affine is worked out, then expressed in its frame's
 * (with @drawpane/import-kit, shared with the other importers).
 *
 * Paths carry absolute SVG path data instead of a box: they're parsed,
 * mapped into the frame's space and fitted with an exact bounding box.
 */
import { type Matrix, multiply, parseSvgPath, type Segment } from "@drawpane/import-kit";

export * from "@drawpane/import-kit";

const translate = (x: number, y: number): Matrix => [1, 0, 0, 1, x, y];

const num = (v: unknown, fallback = 0): number => {
  const n = typeof v === "string" ? Number.parseFloat(v) : typeof v === "number" ? v : Number.NaN;
  return Number.isFinite(n) ? n : fallback;
};

/**
 * A Penpot shape's page affine: from its own box (0..width, 0..height) to
 * page coordinates. `transform` turns the unrotated `selrect` about its centre.
 */
export function shapeMatrix(shape: Record<string, unknown>): Matrix {
  const sel = (shape.selrect ?? {}) as Record<string, unknown>;
  const x = num(sel.x, num(shape.x));
  const y = num(sel.y, num(shape.y));
  const width = num(sel.width, num(shape.width, 0.01));
  const height = num(sel.height, num(shape.height, 0.01));
  const t = (shape.transform ?? {}) as Record<string, unknown>;
  const m: Matrix = [num(t.a, 1), num(t.b, 0), num(t.c, 0), num(t.d, 1), num(t.e, 0), num(t.f, 0)];
  const cx = x + width / 2;
  const cy = y + height / 2;
  return multiply(translate(cx, cy), multiply(m, translate(-width / 2, -height / 2)));
}

export function shapeSize(shape: Record<string, unknown>): { width: number; height: number } {
  const sel = (shape.selrect ?? {}) as Record<string, unknown>;
  return {
    width: Math.max(0, num(sel.width, num(shape.width))),
    height: Math.max(0, num(sel.height, num(shape.height))),
  };
}

/**
 * Penpot path content: an SVG path string (normally only absolute M, L, C
 * and Z, but any SVG path is accepted, relative commands, arcs and all), or
 * the older array of segments.
 */
export function parsePenpotPath(content: unknown): Segment[] {
  if (typeof content === "string") return parseSvgPath(content);
  if (!Array.isArray(content)) return [];
  const out: Segment[] = [];
  for (const raw of content as Array<Record<string, unknown>>) {
    const params = (raw.params ?? {}) as Record<string, unknown>;
    const p = { x: num(params.x, Number.NaN), y: num(params.y, Number.NaN) };
    switch (raw.command) {
      case "move-to":
      case "line-to":
        if (Number.isFinite(p.x) && Number.isFinite(p.y))
          out.push({ c: raw.command === "move-to" ? "M" : "L", p });
        break;
      case "curve-to":
        if (Number.isFinite(p.x) && Number.isFinite(p.y))
          out.push({
            c: "C",
            c1: { x: num(params.c1x, p.x), y: num(params.c1y, p.y) },
            c2: { x: num(params.c2x, p.x), y: num(params.c2y, p.y) },
            p,
          });
        break;
      case "close-path":
        out.push({ c: "Z" });
        break;
    }
  }
  return out;
}
