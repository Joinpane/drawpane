/**
 * Figma's path blobs and gradient transforms in the REST API's terms.
 *
 * A path blob (a layer's `fillGeometry` / `strokeGeometry`) is a byte
 * stream of commands, each an opcode and float32 little-endian arguments in
 * the layer's own pixels, y down: 0 close, 1 move, 2 line, 3 quadratic,
 * 4 cubic. REST returns the same outlines as SVG path data.
 *
 * A gradient's transform maps the layer's unit square into gradient space,
 * where a linear gradient runs from (0, 0.5) to (1, 0.5) and the others sit
 * on (0.5, 0.5) with radius 0.5. REST gives the handles instead: those
 * points taken back into the unit square.
 */
import type { Figma } from "@drawpane/figma";

const ARGS = [0, 2, 2, 4, 6] as const;
const LETTER = ["Z", "M", "L", "Q", "C"] as const;
const num = (v: number) => String(Math.round(v * 1000) / 1000);

/** A path blob as SVG path data; an unknown opcode ends it (what follows can't be read). */
export function commandsToPath(blob: Uint8Array): string {
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const parts: string[] = [];
  let at = 0;
  while (at < blob.length) {
    const op = blob[at] as number;
    const count = ARGS[op as 0];
    if (count === undefined || at + 1 + count * 4 > blob.length) break;
    at++;
    const args: string[] = [];
    for (let i = 0; i < count; i++, at += 4) args.push(num(view.getFloat32(at, true)));
    parts.push(`${LETTER[op as 0]}${args.join(" ")}`);
  }
  return parts.join("");
}

/** Figma's 2×3 matrix: x' = m00·x + m01·y + m02, y' = m10·x + m11·y + m12. */
export interface Matrix {
  readonly m00: number;
  readonly m01: number;
  readonly m02: number;
  readonly m10: number;
  readonly m11: number;
  readonly m12: number;
}

/** The inverse of `t` applied to a point, or null when `t` is degenerate. */
function inverseApply(t: Matrix, x: number, y: number): Figma.Vector | null {
  const det = t.m00 * t.m11 - t.m01 * t.m10;
  if (Math.abs(det) < 1e-12) return null;
  const dx = x - t.m02;
  const dy = y - t.m12;
  return { x: (t.m11 * dx - t.m01 * dy) / det, y: (-t.m10 * dx + t.m00 * dy) / det };
}

/** REST's `gradientHandlePositions` (start, end, width) for a gradient's transform. */
export function gradientHandles(type: string, t: Matrix | undefined): Figma.Vector[] | null {
  const m = t ?? { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 };
  const points: [number, number][] =
    type === "GRADIENT_LINEAR"
      ? [
          [0, 0.5],
          [1, 0.5],
          [0, 1],
        ]
      : [
          [0.5, 0.5],
          [1, 0.5],
          [0.5, 1],
        ];
  const out: Figma.Vector[] = [];
  for (const [x, y] of points) {
    const p = inverseApply(m, x, y);
    if (!p) return null;
    out.push(p);
  }
  return out;
}

/** A matrix as REST's [[a, c, e], [b, d, f]] rows. */
export const rows = (t: Matrix): Figma.Transform => [
  [t.m00, t.m01, t.m02],
  [t.m10, t.m11, t.m12],
];
