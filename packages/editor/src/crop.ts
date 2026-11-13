/**
 * Cropping an image fill: the geometry. A cropped fill shows `crop` (a rect
 * in the image's unit square) stretched over the layer's box, so the whole
 * image lies at a fixed rect in the layer's local space. Cropping moves the
 * box over that image (resize) or the image under the box (pan); either way
 * the image itself never moves on the page.
 */
import type { Paint } from "@drawpane/model";
import type { Rect } from "./geometry";
import { type CropRect, FULL_CROP, imagePlacement, type Size } from "./images";

export type ImagePaint = Extract<Paint, { type: "image" }>;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const round = (n: number) => Math.round(n * 1e6) / 1e6;

/** Where the whole image sits in a layer's local box, for any scale mode. */
export function imageRect(paint: ImagePaint, box: Size, natural: Size): Rect {
  const p = imagePlacement(paint.scaleMode, box, natural, paint.crop ?? FULL_CROP);
  return { x: p.x, y: p.y, width: p.width, height: p.height };
}

/**
 * The crop that shows what a layer shows now: its box where it overlaps the
 * image. A fit image (smaller than its box) gives a smaller box, returned so
 * the layer can shrink to the image.
 */
export function cropFromPlacement(image: Rect, box: Size): { crop: CropRect; box: Rect } {
  const x0 = clamp(0, image.x, image.x + image.width);
  const y0 = clamp(0, image.y, image.y + image.height);
  const x1 = clamp(box.width, image.x, image.x + image.width);
  const y1 = clamp(box.height, image.y, image.y + image.height);
  return {
    crop: cropOfBox(image, { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }),
    box: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 },
  };
}

/** The crop a box shows when the image lies at `image` (both in the same local space). */
export function cropOfBox(image: Rect, box: Rect): CropRect {
  const w = Math.max(1e-9, image.width);
  const h = Math.max(1e-9, image.height);
  const width = clamp(box.width / w, 1e-6, 1);
  const height = clamp(box.height / h, 1e-6, 1);
  return {
    x: round(clamp((box.x - image.x) / w, 0, 1 - width)),
    y: round(clamp((box.y - image.y) / h, 0, 1 - height)),
    width: round(width),
    height: round(height),
  };
}

/** The crop after sliding the image by (dx, dy) local units under a box of size `box`. */
export function pannedCrop(crop: CropRect, box: Size, dx: number, dy: number): CropRect {
  const imageW = box.width / crop.width;
  const imageH = box.height / crop.height;
  return {
    ...crop,
    x: round(clamp(crop.x - dx / imageW, 0, 1 - crop.width)),
    y: round(clamp(crop.y - dy / imageH, 0, 1 - crop.height)),
  };
}

/**
 * A box dragged to `wanted` (local units), kept inside the image and at
 * least `min` across. With `ratio`, its width/height stays at that ratio,
 * growing from the edge that didn't move.
 */
export function clampBox(wanted: Rect, image: Rect, min = 1, ratio: number | null = null): Rect {
  const x0 = Math.max(image.x, Math.min(wanted.x, wanted.x + wanted.width));
  const y0 = Math.max(image.y, Math.min(wanted.y, wanted.y + wanted.height));
  let x1 = Math.min(image.x + image.width, Math.max(wanted.x, wanted.x + wanted.width));
  let y1 = Math.min(image.y + image.height, Math.max(wanted.y, wanted.y + wanted.height));
  if (x1 - x0 < min) x1 = Math.min(image.x + image.width, x0 + min);
  if (y1 - y0 < min) y1 = Math.min(image.y + image.height, y0 + min);
  if (ratio !== null && ratio > 0) {
    // Fit the ratio inside what's left, keeping the top-left corner.
    const w = x1 - x0;
    const h = y1 - y0;
    if (w / h > ratio) x1 = x0 + h * ratio;
    else y1 = y0 + w / ratio;
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/**
 * The largest box of `ratio` (width / height) inside the image, centred on
 * where the box is now and kept inside the image: an aspect preset.
 */
export function presetBox(image: Rect, box: Rect, ratio: number): Rect {
  let width = image.width;
  let height = width / ratio;
  if (height > image.height) {
    height = image.height;
    width = height * ratio;
  }
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  return {
    x: clamp(cx - width / 2, image.x, image.x + image.width - width),
    y: clamp(cy - height / 2, image.y, image.y + image.height - height),
    width,
    height,
  };
}
