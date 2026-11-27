/**
 * Exports, previews and thumbnails: bounds, sizing, image budgeting, background parsing,
 * vector approximation notes, and the legacy `CanvasRenderer` helpers kept until W8 retires it.
 */
import {
  imageLevelsBytes,
  MAX_SIDE,
  type Rgba,
  smallerImageLevel,
  WORKER_LIMITS,
} from "@drawpane/engine";
import { getProp, type NodeRecord, type Paint } from "@drawpane/model";
import type { Doc } from "./doc";
import { rgba } from "./engine/layer";
import { type Rect, unionRects } from "./geometry";
import { imageDrawnSize, type Size } from "./images";
import { markerLength } from "./markers";
import { postEffects, postReach } from "./post-effects";
import type { CanvasRenderer } from "./render";
import type { Scene } from "./scene";
import { strokeReach, strokeWidths } from "./stroke-sides";

export type ExportFormat = "png" | "jpeg" | "webp" | "svg" | "pdf";
/** Formats drawn into pixels; SVG and PDF stay vector, at 1×. */
export type RasterFormat = Exclude<ExportFormat, "svg" | "pdf">;

/** Whether a format is vector (scale doesn't apply). */
export const isVectorFormat = (format: ExportFormat): format is "svg" | "pdf" =>
  format === "svg" || format === "pdf";

export const EXPORT_MIME: Record<ExportFormat, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
};

export const EXPORT_EXTENSION: Record<ExportFormat, string> = {
  png: "png",
  jpeg: "jpg",
  webp: "webp",
  svg: "svg",
  pdf: "pdf",
};

/** Maximum side and total pixels a product raster export allows (up to 16,384 px per side). */
export const MAX_EXPORT_SIDE = 16_384;
export const MAX_EXPORT_PIXELS = 8192 * 8192;

/**
 * How far a node's paint reaches past its box: strokes outside it and
 * shadows, then its post effects (blur, texture) spreading all of that.
 */
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
    const sides = strokeWidths(node);
    const weight = Math.max(...sides);
    if (strokes.length > 0 && weight > 0) {
      const centred = node.type === "line" || node.type === "path";
      const align = centred ? "center" : getProp(node.props, "strokeAlign");
      const [t, r, b, l] = strokeReach(sides, align);
      grow(l, t, r, b);
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
  const effects = getProp(node.props, "effects");
  for (const e of effects) {
    if (e.visible === false || e.type !== "drop-shadow") continue;
    const r = Math.max(0, e.blur + e.spread);
    grow(r - e.x, r - e.y, r + e.x, r + e.y);
  }
  // Blur and texture work on the whole picture, shadows and strokes included: their reach adds.
  const post = postReach(postEffects(effects));
  return { left: left + post, top: top + post, right: right + post, bottom: bottom + post };
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

export type ExportErrorReason = "size" | "unsupported" | "limit" | "other";

export class ExportError extends Error {
  override name = "ExportError";
  readonly reason: ExportErrorReason;
  constructor(message: string, reason: ExportErrorReason = "other") {
    super(message);
    this.reason = reason;
  }
}

/** Clear error message when a requested raster output exceeds the maximum side or pixel limit. */
export function exportSizeError(
  width: number,
  height: number,
  maxSide = MAX_EXPORT_SIDE,
): ExportError {
  if (width > maxSide || height > maxSide) {
    return new ExportError(
      `That export is too large (${width} × ${height} px). The maximum is ${maxSide.toLocaleString("en")} px on either side. Try a smaller scale.`,
      "size",
    );
  }
  return new ExportError(
    `That export is too large (${width} × ${height} px). The maximum is ${Math.round(MAX_EXPORT_PIXELS / 1_000_000)} megapixels. Try a smaller scale.`,
    "size",
  );
}

/**
 * Parses an export or preview background colour into straight RGBA floats. Accepts null or
 * `"transparent"` for transparent, `"white"` / `"black"`, `#rgb` / `#rgba` / `#rrggbb` /
 * `#rrggbbaa`, and CSS `rgb(...)` / `rgba(...)` strings.
 */
export function exportBackgroundRgba(value: string | null | undefined): Rgba {
  if (!value || value === "transparent") return [0, 0, 0, 0];
  const trimmed = value.trim();
  if (!trimmed || trimmed === "transparent") return [0, 0, 0, 0];
  if (trimmed === "white") return [1, 1, 1, 1];
  if (trimmed === "black") return [0, 0, 0, 1];
  if (/^#[\da-f]{3,4}$/i.test(trimmed)) {
    const expanded = `#${[...trimmed.slice(1)].map((c) => c + c).join("")}`;
    return rgba(expanded);
  }
  if (/^#(?:[\da-f]{6}|[\da-f]{8})$/i.test(trimmed)) return rgba(trimmed);
  const rgbMatch =
    /^rgba?\(\s*([\d.]+)\s*[,\s]\s*([\d.]+)\s*[,\s]\s*([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i.exec(
      trimmed,
    );
  if (rgbMatch) {
    const r = Math.max(0, Math.min(255, Number(rgbMatch[1]))) / 255;
    const g = Math.max(0, Math.min(255, Number(rgbMatch[2]))) / 255;
    const b = Math.max(0, Math.min(255, Number(rgbMatch[3]))) / 255;
    const rawAlpha = rgbMatch[4];
    const a =
      rawAlpha === undefined
        ? 1
        : rawAlpha.endsWith("%")
          ? Math.max(0, Math.min(100, Number(rawAlpha.slice(0, -1)))) / 100
          : Math.max(0, Math.min(1, Number(rawAlpha)));
    return [r, g, b, a];
  }
  throw new ExportError("Use a hex colour for the export background.");
}

export interface ExportImageUse {
  readonly paint: Extract<Paint, { type: "image" }>;
  readonly box: Size;
  readonly scale: Size;
}

/** Collects every visible image paint in `nodes` with its layer box and output pixel scale. */
export function collectExportImageUses(
  scene: Scene,
  nodes: Iterable<NodeRecord>,
  scale: number,
): Map<string, ExportImageUse[]> {
  const refs = new Map<string, ExportImageUse[]>();
  for (const layer of nodes) {
    if (layer.type === "group" || layer.type === "page" || layer.type === "text") continue;
    const box = {
      width: getProp(layer.props, "width"),
      height: getProp(layer.props, "height"),
    };
    if (box.width <= 0 || box.height <= 0) continue;
    const [a, b, c, d] = scene.worldMatrix(layer.id);
    for (const paint of [...getProp(layer.props, "fills"), ...getProp(layer.props, "strokes")]) {
      if (paint.type !== "image" || paint.visible === false || paint.opacity === 0) continue;
      const use: ExportImageUse = {
        paint,
        box,
        scale: { width: Math.hypot(a, b) * scale, height: Math.hypot(c, d) * scale },
      };
      const list = refs.get(paint.ref);
      if (list) list.push(use);
      else refs.set(paint.ref, [use]);
    }
  }
  return refs;
}

/** Smallest mip level of `natural` that still covers the largest drawn use. */
export function chooseImageLevel(natural: Size, uses: readonly ExportImageUse[]): Size {
  let width = 1;
  let height = 1;
  for (const { paint, box, scale } of uses) {
    const drawn = imageDrawnSize(paint.scaleMode, box, natural, scale, paint.crop);
    width = Math.max(width, drawn.width);
    height = Math.max(height, drawn.height);
  }
  let level: Size = { width: Math.max(1, natural.width), height: Math.max(1, natural.height) };
  for (;;) {
    const next = smallerImageLevel(level.width, level.height);
    if (!next || next.width < width || next.height < height) return level;
    level = next;
  }
}

/**
 * Exact target pixel size covering the largest drawn use of `natural`, clamped to `natural`
 * (never upscaling) and `maxSide` while preserving aspect ratio. Avoids the power-of-2
 * over-allocation of `chooseImageLevel` for browser exports.
 */
export function chooseDrawnImageSize(
  natural: Size,
  uses: readonly ExportImageUse[],
  maxSide = MAX_SIDE,
): Size {
  const natW = Math.max(1, natural.width);
  const natH = Math.max(1, natural.height);
  let width = 1;
  let height = 1;
  for (const { paint, box, scale } of uses) {
    const drawn = imageDrawnSize(
      paint.scaleMode,
      box,
      { width: natW, height: natH },
      scale,
      paint.crop,
    );
    width = Math.max(width, drawn.width);
    height = Math.max(height, drawn.height);
  }
  const ratio = Math.min(1, Math.max(width / natW, height / natH));
  let targetW = Math.max(1, Math.min(natW, Math.ceil(natW * ratio)));
  let targetH = Math.max(1, Math.min(natH, Math.ceil(natH * ratio)));
  const longest = Math.max(targetW, targetH);
  if (longest > maxSide) {
    const fit = maxSide / longest;
    targetW = Math.max(1, Math.floor(targetW * fit));
    targetH = Math.max(1, Math.floor(targetH * fit));
  }
  return { width: targetW, height: targetH };
}

export interface ExportImageCandidate {
  readonly ref: string;
  readonly natural: Size;
  readonly uses: readonly ExportImageUse[];
}

export interface ExportImagePlan {
  readonly target: Size;
  readonly reduced: boolean;
}

export interface BudgetExportImagesOptions {
  /** Size each image to its exact drawn dimensions instead of power-of-2 mip steps. */
  readonly exactDrawn?: boolean;
  /** Maximum side for any uploaded image level (defaults to `MAX_SIDE`, 8,192 px). */
  readonly maxSide?: number;
  /**
   * Working-memory multiplier on the largest decoded image's RGBA bytes (e.g. `2` for browser
   * OffscreenCanvas + ImageData / Wasm upload copies alongside already resident mipmaps).
   * Defaults to `0` (resident mipmap bytes only).
   */
  readonly decodeWorkingMultiplier?: number;
}

/**
 * Budgets every image in an export within `budgetBytes` (default `WORKER_LIMITS.imageBytes`,
 * 6 MiB). Each image starts at the level covering its largest drawn size; when resident mipmaps
 * plus any decode working memory exceed the budget, the largest reducible image steps down one
 * mip level at a time so no single photo starves the rest. Any image that still cannot fit at
 * its smallest level maps to null.
 */
export function budgetExportImages(
  candidates: readonly ExportImageCandidate[],
  budgetBytes = WORKER_LIMITS.imageBytes,
  options: BudgetExportImagesOptions = {},
): Map<string, ExportImagePlan | null> {
  const maxSide = options.maxSide ?? MAX_SIDE;
  const decodeMult = Math.max(0, options.decodeWorkingMultiplier ?? 0);
  const decodeBytesOf = (width: number, height: number) =>
    decodeMult > 0 ? Math.floor(width) * Math.floor(height) * 4 * decodeMult : 0;

  const items = candidates.map((c) => {
    let level = options.exactDrawn
      ? chooseDrawnImageSize(c.natural, c.uses, maxSide)
      : chooseImageLevel(c.natural, c.uses);
    while (Math.max(level.width, level.height) > maxSide) {
      const next = smallerImageLevel(level.width, level.height);
      if (!next) break;
      level = next;
    }
    return {
      ref: c.ref,
      wanted: level,
      target: level,
      bytes: imageLevelsBytes(level.width, level.height),
      decodeBytes: decodeBytesOf(level.width, level.height),
    };
  });

  const peakTotal = () => {
    let resident = 0;
    let maxDecode = 0;
    for (const item of items) {
      resident += item.bytes;
      if (item.decodeBytes > maxDecode) maxDecode = item.decodeBytes;
    }
    return resident + maxDecode;
  };

  while (peakTotal() > budgetBytes) {
    let pick = -1;
    let pickBytes = 0;
    let pickNext: Size | null = null;
    for (let i = 0; i < items.length; i++) {
      const item = items[i] as (typeof items)[number];
      if (item.bytes <= pickBytes) continue;
      const next = smallerImageLevel(item.target.width, item.target.height);
      if (!next) continue;
      pick = i;
      pickBytes = item.bytes;
      pickNext = next;
    }
    if (pick < 0 || !pickNext) break;
    const chosen = items[pick] as (typeof items)[number];
    chosen.target = pickNext;
    chosen.bytes = imageLevelsBytes(pickNext.width, pickNext.height);
    chosen.decodeBytes = decodeBytesOf(pickNext.width, pickNext.height);
  }

  const plan = new Map<string, ExportImagePlan | null>();
  let used = 0;
  let maxDecode = 0;
  for (const item of items) {
    const nextMaxDecode = Math.max(maxDecode, item.decodeBytes);
    if (used + item.bytes + nextMaxDecode <= budgetBytes) {
      used += item.bytes;
      maxDecode = nextMaxDecode;
      plan.set(item.ref, {
        target: item.target,
        reduced: item.target.width < item.wanted.width || item.target.height < item.wanted.height,
      });
    } else {
      plan.set(item.ref, null);
    }
  }
  return plan;
}

export interface VectorApproximations {
  readonly glass: boolean;
  readonly backgroundBlur: boolean;
}

/** Reports whether visible layers in `ids` hold effects that SVG and PDF approximate. */
export function vectorApproximations(doc: Doc, ids: readonly string[]): VectorApproximations {
  let glass = false;
  let backgroundBlur = false;
  const visit = (id: string) => {
    if (glass && backgroundBlur) return;
    const node = doc.get(id);
    if (!node || getProp(node.props, "visible") === false) return;
    for (const effect of getProp(node.props, "effects")) {
      if (effect.visible === false) continue;
      if (effect.type === "glass") glass = true;
      else if (effect.type === "background-blur") backgroundBlur = true;
    }
    for (const child of doc.childIds(id)) visit(child);
  };
  for (const id of ids) visit(id);
  return { glass, backgroundBlur };
}

/** Human-readable notes describing how SVG and PDF approximate glass and background blur. */
export function vectorApproximationNotes(
  format: "svg" | "pdf",
  effects: VectorApproximations,
): string[] {
  const label = format.toUpperCase();
  const notes: string[] = [];
  if (effects.backgroundBlur) {
    notes.push(`Background blur isn't part of ${label}, so it's left out.`);
  }
  if (effects.glass) {
    notes.push(
      `Glass exports in ${label} as a lit rim without refraction, frost or what's behind the layer.`,
    );
  }
  return notes;
}

export interface RasterOptions {
  readonly format: RasterFormat;
  /** Output pixels per unit: 1, 2, 3. */
  readonly scale: number;
  /** Fill behind the layers; JPEG defaults to white because it has no transparency. */
  readonly background?: string | null;
  /** Encoder quality for JPEG and WebP, 0 to 1. */
  readonly quality?: number;
  readonly onDrawn?: () => void;
}

/**
 * Legacy CanvasRenderer raster export helper (kept until W8 retires CanvasRenderer).
 * Product exports run through the browser engine snapshot service instead.
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
  if (!size) {
    throw exportSizeError(
      Math.max(1, Math.round(rect.width * options.scale)),
      Math.max(1, Math.round(rect.height * options.scale)),
    );
  }
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
  // As Figma exports: glass and background blur see what's under the layers on the page.
  renderer.renderNodes(ctx, ids, rect, options.scale, background, false, true);
  options.onDrawn?.();
  const type = `image/${options.format}`;
  return canvas.convertToBlob({ type, quality: options.quality ?? 0.92 });
}

export interface ThumbnailOptions {
  readonly maxWidth?: number;
  readonly maxHeight?: number;
  /** Preferred type; browsers that can't encode WebP return PNG. */
  readonly type?: "image/webp" | "image/png";
  readonly quality?: number;
  readonly onDrawn?: () => void;
}

export interface ThumbnailLayout {
  readonly pageId: string;
  readonly ids: readonly string[];
  readonly rect: Rect;
  readonly scale: number;
  readonly width: number;
  readonly height: number;
  readonly background: string | null;
}

/** The scale that fits `size` inside `max`, never enlarging past 2×. */
export function fitScale(
  size: { width: number; height: number },
  max: { width: number; height: number },
): number {
  return Math.min(2, max.width / Math.max(1, size.width), max.height / Math.max(1, size.height));
}

/**
 * Computes a page thumbnail's framing: every top-level layer on the page, padded by 4%, fitted
 * inside `maxWidth × maxHeight` (default 640 × 480) on the page's own background. Null when empty.
 */
export function thumbnailLayout(
  scene: Scene,
  pageId: string,
  options: Pick<ThumbnailOptions, "maxWidth" | "maxHeight"> = {},
): ThumbnailLayout | null {
  const page = scene.doc.get(pageId);
  if (!page) return null;
  const ids = scene.doc.childIds(pageId);
  const bounds = exportBounds(scene, ids);
  if (!bounds || bounds.width <= 0 || bounds.height <= 0) return null;
  const margin = Math.max(bounds.width, bounds.height) * 0.04;
  const rect = {
    x: bounds.x - margin,
    y: bounds.y - margin,
    width: bounds.width + margin * 2,
    height: bounds.height + margin * 2,
  };
  const max = { width: options.maxWidth ?? 640, height: options.maxHeight ?? 480 };
  const scale = fitScale(rect, max);
  const width = Math.max(1, Math.min(max.width, Math.round(rect.width * scale)));
  const height = Math.max(1, Math.min(max.height, Math.round(rect.height * scale)));
  return {
    pageId,
    ids,
    rect,
    scale,
    width,
    height,
    background: getProp(page.props, "backgroundColor"),
  };
}

/**
 * Legacy CanvasRenderer thumbnail helper (kept until W8 retires CanvasRenderer).
 * Product thumbnails run through the browser engine snapshot service instead.
 */
export async function renderThumbnail(
  renderer: CanvasRenderer,
  scene: Scene,
  pageId: string,
  options: ThumbnailOptions = {},
): Promise<Blob | null> {
  const layout = thumbnailLayout(scene, pageId, options);
  if (!layout) return null;
  await renderer.images.ready(imageRefs(scene.doc, layout.ids), 5000);
  const canvas = new OffscreenCanvas(layout.width, layout.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  // A thumbnail is small: unreadable text draws as bars, as on the canvas.
  renderer.renderNodes(ctx, layout.ids, layout.rect, layout.scale, layout.background, true);
  options.onDrawn?.();
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
  const suffix = !isVectorFormat(format) && scale !== 1 ? `@${scale}x` : "";
  return `${base}${suffix}.${EXPORT_EXTENSION[format]}`;
}
