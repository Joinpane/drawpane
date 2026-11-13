/**
 * Exports and thumbnails, rendered in the browser with the same
 * `CanvasRenderer` the canvas uses: what you export is what you see, and the
 * server never runs a headless browser.
 */
import { getProp, type NodeRecord } from "@drawpane/model";
import type { Doc } from "./doc";
import { type Rect, unionRects } from "./geometry";
import { markerLength } from "./markers";
import type { CanvasRenderer } from "./render";
import type { Scene } from "./scene";

export type ExportFormat = "png" | "jpeg" | "webp" | "svg";
export type RasterFormat = Exclude<ExportFormat, "svg">;

export const EXPORT_MIME: Record<ExportFormat, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
  svg: "image/svg+xml",
};

export const EXPORT_EXTENSION: Record<ExportFormat, string> = {
  png: "png",
  jpeg: "jpg",
  webp: "webp",
  svg: "svg",
};

/** Browsers refuse canvases past about 16k on a side or 268M pixels; stay well inside. */
export const MAX_EXPORT_SIDE = 16_384;
export const MAX_EXPORT_PIXELS = 8192 * 8192;

/** How far a node's paint reaches past its box: strokes outside it, shadows, blur. */
export function paintOutset(node: NodeRecord): {
  left: number;
  top: number;
  right: number;
  bottom: number;
} {
  let left = 0;
  let top = 0;
  let right = 0;
  let bottom = 0;
  const grow = (l: number, t: number, r: number, b: number) => {
    left = Math.max(left, l);
    top = Math.max(top, t);
    right = Math.max(right, r);
    bottom = Math.max(bottom, b);
  };
  if (node.type !== "group" && node.type !== "page") {
    const strokes = getProp(node.props, "strokes").filter((s) => s.visible !== false);
    const weight = getProp(node.props, "strokeWeight");
    if (strokes.length > 0 && weight > 0) {
      const centred = node.type === "line" || node.type === "path";
      const align = centred ? "center" : getProp(node.props, "strokeAlign");
      const reach = align === "outside" ? weight : align === "center" ? weight / 2 : 0;
      grow(reach, reach, reach, reach);
      // End markers stick out past the ends of a line or path.
      if (
        centred &&
        (getProp(node.props, "markerStart") !== "none" ||
          getProp(node.props, "markerEnd") !== "none")
      ) {
        const m = markerLength(weight) + weight;
        grow(m, m, m, m);
      }
    }
  }
  for (const e of getProp(node.props, "effects")) {
    if (e.visible === false) continue;
    if (e.type === "drop-shadow") {
      const r = Math.max(0, e.blur + e.spread);
      grow(r - e.x, r - e.y, r + e.x, r + e.y);
    } else if (e.type === "layer-blur") {
      // The renderer's blur is a Gaussian with this standard deviation; 2σ holds nearly all of it.
      const r = e.radius * 2;
      grow(r, r, r, r);
    }
  }
  return { left, top, right, bottom };
}

/**
 * The page rect an export of these layers covers: their bounds plus whatever
 * their strokes, shadows and blur paint outside them. Children that overflow
 * an unclipped frame are included.
 */
export function exportBounds(scene: Scene, ids: readonly string[]): Rect | null {
  const rects: Rect[] = [];
  const visit = (id: string) => {
    const node = scene.doc.get(id);
    if (!node || node.props.visible === false) return;
    const b = scene.bounds(id);
    if (b) {
      const o = paintOutset(node);
      rects.push({
        x: b.x - o.left,
        y: b.y - o.top,
        width: b.width + o.left + o.right,
        height: b.height + o.top + o.bottom,
      });
    }
    const clips = node.type === "frame" && getProp(node.props, "clipContent");
    if (!clips) for (const child of scene.doc.childIds(id)) visit(child);
  };
  for (const id of ids) visit(id);
  return unionRects(rects);
}

/** Grows a rect to whole output pixels at `scale`, so edges stay crisp. */
export function snapToPixels(rect: Rect, scale: number): Rect {
  const eps = 1e-6;
  const x0 = Math.floor(rect.x * scale + eps) / scale;
  const y0 = Math.floor(rect.y * scale + eps) / scale;
  const x1 = Math.ceil((rect.x + rect.width) * scale - eps) / scale;
  const y1 = Math.ceil((rect.y + rect.height) * scale - eps) / scale;
  return {
    x: x0,
    y: y0,
    width: Math.max(1 / scale, x1 - x0),
    height: Math.max(1 / scale, y1 - y0),
  };
}

/** Output size in pixels, or null when it is too large to render. */
export function outputSize(rect: Rect, scale: number): { width: number; height: number } | null {
  const width = Math.max(1, Math.round(rect.width * scale));
  const height = Math.max(1, Math.round(rect.height * scale));
  if (width > MAX_EXPORT_SIDE || height > MAX_EXPORT_SIDE || width * height > MAX_EXPORT_PIXELS)
    return null;
  return { width, height };
}

/** Every image paint used by these layers and their children. */
export function imageRefs(doc: Doc, ids: readonly string[]): string[] {
  const refs = new Set<string>();
  const visit = (id: string) => {
    const node = doc.get(id);
    if (!node) return;
    if (node.type !== "group" && node.type !== "page")
      for (const paint of [...getProp(node.props, "fills"), ...getProp(node.props, "strokes")])
        if (paint.type === "image") refs.add(paint.ref);
    for (const child of doc.childIds(id)) visit(child);
  };
  for (const id of ids) visit(id);
  return [...refs];
}

export class ExportError extends Error {
  override name = "ExportError";
}

export interface RasterOptions {
  readonly format: RasterFormat;
  /** Output pixels per unit: 1, 2, 3. */
  readonly scale: number;
  /** Fill behind the layers; JPEG defaults to white because it has no transparency. */
  readonly background?: string | null;
  /** Encoder quality for JPEG and WebP, 0 to 1. */
  readonly quality?: number;
}

/**
 * Renders layers to an image file in an OffscreenCanvas. Waits for their
 * images to decode first, so nothing exports as a placeholder.
 */
export async function exportRaster(
  renderer: CanvasRenderer,
  scene: Scene,
  ids: readonly string[],
  options: RasterOptions,
): Promise<Blob> {
  const bounds = exportBounds(scene, ids);
  if (!bounds) throw new ExportError("Nothing visible to export. Show the layer and try again.");
  const rect = snapToPixels(bounds, options.scale);
  const size = outputSize(rect, options.scale);
  if (!size) throw new ExportError("That export is too large. Try a smaller scale.");
  await renderer.images.ready(imageRefs(scene.doc, ids));
  const canvas = new OffscreenCanvas(size.width, size.height);
  const ctx = canvas.getContext("2d");
  if (!ctx)
    throw new ExportError(
      "This browser can't render exports. Try a recent Chrome, Edge, Firefox or Safari.",
    );
  const background =
    options.background === undefined
      ? options.format === "jpeg"
        ? "#ffffff"
        : null
      : options.background;
  renderer.renderNodes(ctx, ids, rect, options.scale, background);
  const type = `image/${options.format}`;
  return canvas.convertToBlob({ type, quality: options.quality ?? 0.92 });
}

export interface ThumbnailOptions {
  readonly maxWidth?: number;
  readonly maxHeight?: number;
  /** Preferred type; browsers that can't encode WebP return PNG. */
  readonly type?: "image/webp" | "image/png";
  readonly quality?: number;
}

/** The scale that fits `size` inside `max`, never enlarging past 2×. */
export function fitScale(
  size: { width: number; height: number },
  max: { width: number; height: number },
): number {
  return Math.min(2, max.width / Math.max(1, size.width), max.height / Math.max(1, size.height));
}

/**
 * A picture of a page for the dashboard: everything on it, fitted inside
 * 640 × 480 with a little margin, on the page's own background so it looks
 * the same in both themes. Null when the page is empty.
 */
export async function renderThumbnail(
  renderer: CanvasRenderer,
  scene: Scene,
  pageId: string,
  options: ThumbnailOptions = {},
): Promise<Blob | null> {
  const page = scene.doc.get(pageId);
  if (!page) return null;
  const ids = scene.doc.childIds(pageId);
  const bounds = exportBounds(scene, ids);
  if (!bounds || bounds.width <= 0 || bounds.height <= 0) return null;
  const margin = Math.max(bounds.width, bounds.height) * 0.04;
  const padded = {
    x: bounds.x - margin,
    y: bounds.y - margin,
    width: bounds.width + margin * 2,
    height: bounds.height + margin * 2,
  };
  const max = { width: options.maxWidth ?? 640, height: options.maxHeight ?? 480 };
  const scale = fitScale(padded, max);
  const width = Math.max(1, Math.min(max.width, Math.round(padded.width * scale)));
  const height = Math.max(1, Math.min(max.height, Math.round(padded.height * scale)));
  await renderer.images.ready(imageRefs(scene.doc, ids), 5000);
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  renderer.renderNodes(ctx, ids, padded, scale, getProp(page.props, "backgroundColor"));
  return canvas.convertToBlob({
    type: options.type ?? "image/webp",
    quality: options.quality ?? 0.85,
  });
}

/** A file name for an export: the layer name, without characters file systems refuse. */
export function exportFileName(name: string, format: ExportFormat, scale = 1): string {
  const base =
    name
      // File systems refuse these, and control characters (below space) everywhere.
      .replace(/[\\/:*?"<>|]+/g, "-")
      .replace(/[^\x20-\uffff]+/gu, "-")
      .replace(/^[\s.]+|[\s.]+$/g, "")
      .slice(0, 120) || "Export";
  const suffix = format !== "svg" && scale !== 1 ? `@${scale}x` : "";
  return `${base}${suffix}.${EXPORT_EXTENSION[format]}`;
}
