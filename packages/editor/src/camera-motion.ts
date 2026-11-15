/**
 * Camera motion: the path the view takes from one camera to another, as pure
 * functions, so "zoom to this layer" can glide there instead of jumping.
 *
 * The path is van Wijk and Nuij's smooth zoom and pan ("Smooth and efficient
 * zooming and panning", 2003): a short hop is nearly a straight pan with the
 * zoom eased in log space, and a long jump pulls back a little first so you
 * see where you're going, the way Figma and maps do. The editor plays it in
 * time (editor.animateCamera); this module knows nothing about frames.
 */

import { Camera } from "./camera";
import type { Point } from "./geometry";

/**
 * How much a long jump pulls back. van Wijk and Nuij found √2 felt best for
 * maps; a canvas jump is usually shorter, so a little less keeps it calm.
 */
export const MOTION_RHO = 1.2;

/** The shortest and longest a camera move takes, in ms. */
export const MOTION_MIN_MS = 300;
export const MOTION_MAX_MS = 500;

/** A camera path: where the view is at `t` from 0 to 1, and how far it travels. */
export interface CameraPath {
  /** The path's length in van Wijk and Nuij's units (screen widths, roughly). 0 when there's nothing to do. */
  readonly length: number;
  /** The camera at `t` in [0, 1]: exactly `from` at 0 and exactly `to` at 1. */
  at(t: number): Camera;
}

/**
 * The smooth path from `from` to `to`. The view is measured at `anchor` (the
 * middle of the visible area, in screen pixels) across `span` screen pixels,
 * so the motion centres where you're looking, not on the panes. Returns a
 * straight jump (length 0) when either camera isn't a real number.
 */
export function cameraPath(
  from: Camera,
  to: Camera,
  anchor: Point,
  span: number,
  rho = MOTION_RHO,
): CameraPath {
  const finite = (c: Camera) =>
    Number.isFinite(c.x) && Number.isFinite(c.y) && Number.isFinite(c.zoom) && c.zoom > 0;
  const jump: CameraPath = { length: 0, at: (t) => (t <= 0 ? from : to) };
  if (from.equals(to) || !finite(from) || !finite(to) || !(span > 0)) return jump;

  // The page point at the anchor and how much page fits across `span`, at each end.
  const c0 = from.toPage(anchor);
  const c1 = to.toPage(anchor);
  const w0 = span / from.zoom;
  const w1 = span / to.zoom;
  const dx = c1.x - c0.x;
  const dy = c1.y - c0.y;
  const d = Math.hypot(dx, dy);
  const rho2 = rho * rho;

  /** The page point at the anchor and the page width across, `s` along the path. */
  let view: (s: number) => { u: number; w: number };
  let length: number;
  if (d < 1e-6 * Math.min(w0, w1)) {
    // Only the zoom changes: a geometric zoom about the anchor.
    length = Math.abs(Math.log(w1 / w0)) / rho;
    const sign = Math.sign(Math.log(w1 / w0));
    view = (s) => ({ u: length === 0 ? 1 : s / length, w: w0 * Math.exp(sign * rho * s) });
  } else {
    // asinh rather than log(√(b²+1) − b): the same, without cancelling to log(0) on long jumps.
    const b0 = (w1 * w1 - w0 * w0 + rho2 * rho2 * d * d) / (2 * w0 * rho2 * d);
    const b1 = (w1 * w1 - w0 * w0 - rho2 * rho2 * d * d) / (2 * w1 * rho2 * d);
    const r0 = -Math.asinh(b0);
    const r1 = -Math.asinh(b1);
    length = (r1 - r0) / rho;
    const coshR0 = Math.cosh(r0);
    const sinhR0 = Math.sinh(r0);
    view = (s) => ({
      u: (w0 / (rho2 * d)) * (coshR0 * Math.tanh(rho * s + r0) - sinhR0),
      w: (w0 * coshR0) / Math.cosh(rho * s + r0),
    });
  }
  if (!(length > 0) || !Number.isFinite(length)) return jump;

  return {
    length,
    at(t) {
      if (t <= 0) return from;
      if (t >= 1) return to;
      const { u, w } = view(t * length);
      const zoom = span / w;
      const x = c0.x + u * dx;
      const y = c0.y + u * dy;
      const camera = new Camera(anchor.x - x * zoom, anchor.y - y * zoom, zoom);
      return finite(camera) ? camera : to;
    },
  };
}

/** Fast at first, settling gently: a cubic ease-out. Exactly 0 at 0 and 1 at 1. */
export function easeOut(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const r = 1 - t;
  return 1 - r * r * r;
}

/** How long a camera move of `length` takes: longer for longer paths, between the bounds. */
export function motionDuration(length: number): number {
  if (!(length > 0)) return 0;
  return Math.min(MOTION_MAX_MS, MOTION_MIN_MS + 80 * length);
}
