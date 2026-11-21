/**
 * The pixel grid: thin lines on every whole-pixel boundary of the page,
 * shown at high zoom so you can see where layers will land on screen.
 *
 * Figma shows its pixel grid from 400% (its help page, "Adjust your zoom
 * and view options": "The pixel grid is only visible at zoom levels of
 * 400% or higher"), so the grid starts at a zoom of 4 here too. It fades
 * in from there and reaches full strength at 800%, rather than popping
 * on at the threshold.
 */

import type { Camera } from "./camera";

/** The zoom the pixel grid starts to show at: 400%, like Figma. */
export const PIXEL_GRID_MIN_ZOOM = 4;
/** The zoom the pixel grid reaches full strength at: 800%. */
export const PIXEL_GRID_FULL_ZOOM = 8;
/**
 * The lines' strength at full fade. The colour is a mid grey, halfway
 * between black and white, so a line reads on light content (where it
 * lands a light grey) and on dark content (where it lands a dark grey)
 * by about the same amount either way.
 */
export const PIXEL_GRID_ALPHA = 0.4;

/** The lines' colour at a given fade (0 to 1 of full strength). */
export function pixelGridColor(alpha: number): string {
  const a = Math.max(0, Math.min(1, alpha)) * PIXEL_GRID_ALPHA;
  return `rgba(128, 128, 128, ${Math.round(a * 1000) / 1000})`;
}

/**
 * How far the grid has faded in at `zoom`, from 0 (hidden, at and below
 * 400%) to 1 (full strength, at and above 800%). The fade runs on the
 * zoom's doubling, so it is halfway at about 566%.
 */
export function pixelGridFade(zoom: number): number {
  if (!Number.isFinite(zoom) || zoom <= PIXEL_GRID_MIN_ZOOM) return 0;
  if (zoom >= PIXEL_GRID_FULL_ZOOM) return 1;
  return (
    Math.log2(zoom / PIXEL_GRID_MIN_ZOOM) / Math.log2(PIXEL_GRID_FULL_ZOOM / PIXEL_GRID_MIN_ZOOM)
  );
}

/** True when the grid would draw anything at all at `zoom`. */
export function pixelGridVisible(zoom: number): boolean {
  return pixelGridFade(zoom) > 0;
}

/**
 * The device-pixel column (or row) a whole-pixel boundary's line sits
 * in: the one whose left (or top) edge is nearest the boundary's exact
 * device position, so a line is never more than half a device pixel
 * from where the page boundary really is. The line fills that one
 * device pixel, nothing either side, so it stays crisp.
 */
export function pixelGridDeviceLine(
  boundary: number,
  cameraOffset: number,
  zoom: number,
  dpr: number,
): number {
  return Math.round((boundary * zoom + cameraOffset) * dpr);
}

export interface PixelGridLines {
  /** Device-pixel x of each vertical line, left to right. */
  readonly vertical: readonly number[];
  /** Device-pixel y of each horizontal line, top to bottom. */
  readonly horizontal: readonly number[];
}

/**
 * Where the grid's lines fall, in device pixels, on a canvas of
 * `width` by `height` CSS pixels whose origin sits `origin` CSS pixels
 * left of (and above) the viewport's: an overscanned retained canvas
 * passes its overscan, a plain viewport canvas passes 0. Lines outside
 * the canvas are left out, and two boundaries that would land on the
 * same device pixel (only possible below the fade-in zoom) give one line.
 */
export function pixelGridLines(
  camera: Pick<Camera, "x" | "y" | "zoom">,
  width: number,
  height: number,
  dpr: number,
  origin = 0,
): PixelGridLines {
  const lines = (offset: number, extent: number): number[] => {
    const deviceExtent = Math.ceil(extent * dpr);
    // The first whole boundary at or past the canvas's left (or top) edge.
    // The small slack keeps a boundary that is exactly on the edge, which
    // rounding in the division could otherwise push just past it.
    const first = Math.ceil((-origin - offset) / camera.zoom - 1e-9);
    const out: number[] = [];
    for (let boundary = first; ; boundary++) {
      const at = Math.round((boundary * camera.zoom + offset + origin) * dpr);
      if (at >= deviceExtent) break;
      if (at >= 0 && out[out.length - 1] !== at) out.push(at);
    }
    return out;
  };
  if (!(camera.zoom > 0) || !(dpr > 0) || width <= 0 || height <= 0)
    return { vertical: [], horizontal: [] };
  return { vertical: lines(camera.x, width), horizontal: lines(camera.y, height) };
}

/**
 * Draws the grid onto `ctx`, whose canvas covers `width` by `height`
 * CSS pixels from `origin` CSS pixels before the viewport (see
 * `pixelGridLines`). One fill for every line together: each line is a
 * one-device-pixel rect in a single path, drawn in raw device pixels
 * so nothing is anti-aliased. The context's state is restored, so a
 * caller that had set its own transform keeps it. Returns true when
 * anything was drawn; clearing the canvas first is the caller's job.
 */
export function drawPixelGrid(
  ctx: CanvasRenderingContext2D,
  camera: Pick<Camera, "x" | "y" | "zoom">,
  width: number,
  height: number,
  dpr: number,
  origin = 0,
): boolean {
  const fade = pixelGridFade(camera.zoom);
  if (fade <= 0) return false;
  const { vertical, horizontal } = pixelGridLines(camera, width, height, dpr, origin);
  if (vertical.length === 0 && horizontal.length === 0) return false;
  const deviceWidth = Math.ceil(width * dpr);
  const deviceHeight = Math.ceil(height * dpr);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = pixelGridColor(fade);
  ctx.beginPath();
  for (const x of vertical) ctx.rect(x, 0, 1, deviceHeight);
  for (const y of horizontal) ctx.rect(0, y, deviceWidth, 1);
  ctx.fill();
  ctx.restore();
  return true;
}
