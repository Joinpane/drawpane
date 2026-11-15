/**
 * Canvas renderer for page content.
 *
 * It draws only what intersects the viewport, in document order, with each
 * node's world matrix. It knows nothing about selection or tools; the overlay
 * draws those on a separate canvas so hover and drag feedback never repaint
 * the design.
 */

import { getProp, type NodeRecord, type Paint } from "@drawpane/model";
import { Camera } from "./camera";
import { boxOutline, ellipseOutline, fitDashes, type OutlineSegment } from "./dashes";
import { exportBounds } from "./export";
import { type Matrix, type Rect, rectsIntersect } from "./geometry";
import { GlassPainter, glassParams } from "./glass";
import {
  boxInGradientSpace,
  type GradientPaint,
  gradientMatrix,
  linearInPixels,
} from "./gradients";
import { ImageCache, imagePlacement } from "./images";
import { Inradii } from "./inradius";
import { LuminanceMask } from "./luminance";
import { markerLength, markersOf, trimmedStroke } from "./markers";
import { hasMask, maskScopes } from "./masks";
import { NoiseTiles, paintNoise } from "./noise";
import { blurSigma, type PostEffect, postEffects, postMargin, postReach } from "./post-effects";
import type { Scene } from "./scene";
import { isUniform, strokeRegion, strokeRegionPath, strokeWidths } from "./stroke-sides";
import {
  layoutText,
  lineHeightPx,
  lineOffset,
  type ShapedText,
  type TextFragment,
  type TextMeasurer,
  textBlockOffset,
} from "./text";
import { TexturePainter } from "./texture";
import { isClosedPath } from "./vector/cache";
import { nodePath } from "./vector/shapes";
import { serializePath } from "./vector/svg";
import { type AnyCanvas, copyExtended, scratch } from "./webgl";

/** On screen it's a canvas element; exports and thumbnails draw into an OffscreenCanvas. */
type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
type ImagePaint = Extract<Paint, { type: "image" }>;

/** Whether a layer paints anything of its own: a visible fill or stroke that isn't fully clear. */
function paintsSomething(node: NodeRecord): boolean {
  const visible = (p: Paint) =>
    p.visible !== false &&
    (p.opacity ?? 1) > 0 &&
    // A solid colour with zero alpha (#rrggbb00) paints nothing.
    !(p.type === "solid" && p.color.length === 9 && p.color.endsWith("00"));
  return getProp(node.props, "fills").some(visible) || getProp(node.props, "strokes").some(visible);
}

/**
 * A dashed box's or ellipse's outline, piece by piece with the dash pattern
 * fitted to each (dashes.ts); null for other shapes, which dash continuously.
 */
function dashedOutline(
  node: NodeRecord,
  w: number,
  h: number,
): Array<{ path: Path2D; dashes: number[]; offset: number }> | null {
  let outline: OutlineSegment[];
  if (node.type === "ellipse") outline = ellipseOutline(w, h);
  else if (node.type === "rect" || node.type === "frame") {
    const r = getProp(node.props, "cornerRadius");
    outline = boxOutline(w, h, getProp(node.props, "cornerRadii") ?? [r, r, r, r]);
  } else return null;
  const pattern = getProp(node.props, "strokeDashes");
  return outline.map((piece) => {
    const path = new Path2D();
    if (piece.kind === "line") {
      path.moveTo(piece.x0, piece.y0);
      path.lineTo(piece.x1, piece.y1);
    } else path.ellipse(piece.cx, piece.cy, piece.rx, piece.ry, 0, piece.start, piece.end);
    return { path, ...fitDashes(piece.length, pattern) };
  });
}

/**
 * Whether a see-through layer must be drawn as one picture and faded as a
 * whole, as Figma does: when its parts overlap (shadows under a fill, a
 * stroke over it, a frame's children), fading each would show them through
 * one another.
 */
function fadesAsOne(node: NodeRecord, children: number): boolean {
  if (getProp(node.props, "opacity") >= 1) return false;
  if (children > 0) return true;
  const shadows = getProp(node.props, "effects").some(
    (e) => e.visible !== false && (e.type === "drop-shadow" || e.type === "inner-shadow"),
  );
  const fills = getProp(node.props, "fills").filter((p) => p.visible !== false).length;
  const strokes = getProp(node.props, "strokes").filter((p) => p.visible !== false).length;
  return shadows || fills + strokes > 1;
}

export interface CanvasRendererOptions {
  /** Shared decoded images. Pass the same cache to every renderer of one file. */
  readonly images?: ImageCache;
}

/** Two neutral greys in device pixels, the same in both themes: an image that is still loading. */
const PLACEHOLDER = { light: "#ececea", dark: "#dfdfdc", cell: 8 };

/**
 * The most pixels a layer's own canvas for its post effects may have;
 * larger layers are drawn into it smaller. A blur hides that, so a blurred
 * layer's canvas is kept smaller; grain needs every pixel.
 */
const BLUR_MAX_PIXELS = 6_000_000;
const POST_MAX_PIXELS = 16_000_000;

export interface RenderStats {
  drawn: number;
  culled: number;
  ms: number;
}

/**
 * The canvas state layers set for themselves, back to its defaults: layers
 * don't restore what they set (see `#draw`), so a frame starts from here.
 */
function resetState(ctx: Ctx): void {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  ctx.filter = "none";
}

const rgbaCache = new Map<string, string>();
/** `#rrggbb[aa]` with an extra opacity as a CSS colour, memoized: the same few colours repeat every frame. */
function hexToRgba(hex: string, opacity = 1): string {
  const key = opacity === 1 ? hex : `${hex}/${opacity}`;
  let css = rgbaCache.get(key);
  if (css === undefined) {
    css = toRgba(hex, opacity);
    if (rgbaCache.size > 4096) rgbaCache.clear();
    rgbaCache.set(key, css);
  }
  return css;
}

function toRgba(hex: string, opacity: number): string {
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  const a = hex.length === 9 ? Number.parseInt(hex.slice(7, 9), 16) / 255 : 1;
  return `rgba(${r},${g},${b},${+(a * opacity).toFixed(4)})`;
}

const BLEND: Record<string, GlobalCompositeOperation> = {
  normal: "source-over",
  multiply: "multiply",
  screen: "screen",
  overlay: "overlay",
  darken: "darken",
  lighten: "lighten",
  "color-dodge": "color-dodge",
  "color-burn": "color-burn",
  "hard-light": "hard-light",
  "soft-light": "soft-light",
  difference: "difference",
  exclusion: "exclusion",
  hue: "hue",
  saturation: "saturation",
  color: "color",
  luminosity: "luminosity",
};

/** What a drawn frame depended on: a later frame can reuse it when only the camera moved. */
interface LastFrame {
  readonly ctx: Ctx;
  readonly pageId: string;
  readonly zoom: number;
  readonly dpr: number;
  readonly width: number;
  readonly height: number;
  readonly version: number;
  readonly epoch: number;
  /** The text measurer's generation: a font that loaded changes how text draws. */
  readonly fonts: number;
  readonly background: string;
  readonly hidden: ReadonlySet<string>;
  readonly whole: string | null;
  /** The camera's translation in whole device pixels. */
  readonly tx: number;
  readonly ty: number;
}

/** Two frames show the same document the same way (the camera aside). */
function sameContent(a: LastFrame, b: LastFrame): boolean {
  return (
    a.ctx === b.ctx &&
    a.pageId === b.pageId &&
    a.dpr === b.dpr &&
    a.width === b.width &&
    a.height === b.height &&
    a.version === b.version &&
    a.epoch === b.epoch &&
    a.fonts === b.fonts &&
    a.background === b.background &&
    a.hidden === b.hidden &&
    a.whole === b.whole
  );
}

/** How far a zoom may stray from the snapshot it scales before it's drawn exactly. */
const PREVIEW_MAX_SCALE = 4;
const PREVIEW_MIN_SCALE = 0.6;

/** A text layer's biggest font size, its runs' included. */
function largestFontSize(node: NodeRecord): number {
  let size = getProp(node.props, "fontSize");
  for (const run of getProp(node.props, "textRuns"))
    if (run.fontSize && run.fontSize > size) size = run.fontSize;
  return size;
}

/** Text smaller than this many device pixels is drawn as bars, not glyphs. */
const GREEK_BELOW = 4;

export class CanvasRenderer {
  readonly #scene: Scene;
  readonly #measurer: TextMeasurer;
  readonly #paths = new Map<string, { d: string; path: Path2D }>();
  readonly #shapes = new WeakMap<object, { w: number; h: number; path: Path2D }>();
  /** Per-side strokes' regions, by the layer's props (a new object with every edit). */
  readonly #sidePaths = new WeakMap<object, Path2D>();
  /** Shaped text as one outline at its origin, by letter spacing (see #shapedOutline). */
  readonly #shapedRuns = new WeakMap<ShapedText, Map<number, Path2D>>();
  /** Each outline where it was last placed: text that holds still costs nothing per frame. */
  readonly #placedRuns = new WeakMap<Path2D, { x: number; y: number; path: Path2D }>();
  /** What the last screen frame showed, to move it on a pan instead of redrawing. */
  #last: LastFrame | null = null;
  /** The last frame drew every layer (not a scaled stand-in). */
  #lastExact = false;
  /** The page's layers that read the pixels around them, by document version (see #readers). */
  #readerCache: { pageId: string; version: number; ids: string[] } | null = null;
  /**
   * Advances whenever a frame's content differs from the last one's (see
   * `sameContent`), so glass drawn against one backdrop isn't reused over another.
   */
  #generation = 0;
  /** The screen's canvas while a frame is drawn on it: glass drawn there is kept for pans. */
  #screen: Ctx | null = null;
  /** While redrawing parts of a frame: those parts, in page coordinates; layers touching none are skipped. */
  #parts: Rect[] | null = null;
  /**
   * While redrawing parts of a frame: the layers reading the backdrop that
   * paint in them, whose backdrop is all redrawn first. The others' glass
   * and background blur would read the moved frame and paint nowhere new:
   * they're skipped.
   */
  #fresh: ReadonlySet<string> | null = null;
  /** The last exact frame's pixels, scaled while zooming (see `#preview`). */
  #snapshot: OffscreenCanvas | HTMLCanvasElement | null = null;
  #snapshotFrame: LastFrame | null = null;
  #epoch = 0;
  /** Nodes not to draw (e.g. text being edited in a DOM overlay). */
  hidden = new Set<string>();
  /** A text layer drawn with all its lines, past any truncation: the one being edited. */
  whole: string | null = null;
  /** Page background when the page doesn't set one: the theme's `canvas` token. */
  canvasColor = "#ebeae6";
  stats: RenderStats = { drawn: 0, culled: 0, ms: 0 };
  /**
   * Decoded images. Subscribe to repaint when one arrives:
   * `renderer.images.subscribe(() => requestRepaint())`.
   */
  readonly images: ImageCache;
  readonly #placeholders = new WeakMap<Ctx, CanvasPattern>();
  /**
   * Level of detail on screen: unreadable text as bars, specks skipped.
   * Off for exports and thumbnails, which draw everything exactly.
   */
  #detail = true;
  /** Layers being drawn into their own canvas for their post effects (see #drawProcessed). */
  readonly #isolated = new Set<string>();
  /** Those canvases: two per nesting depth, the second for a blur partway through. */
  readonly #postCanvases: Array<OffscreenCanvas | HTMLCanvasElement> = [];
  /** Draws glass effects, with its own canvases and (made on first use) WebGL context. */
  readonly #glass = new GlassPainter();
  /** Canvases for layers masked by a mask's picture (see #drawMasked), and how deep that nests. */
  readonly #maskCanvases: AnyCanvas[] = [];
  #maskDepth = 0;
  /** Turns a luminance mask's picture into alpha. */
  readonly #luminance = new LuminanceMask();
  /** How thick glass layers' shapes are, measured once per version (see inradius.ts). */
  readonly #inradii = new Inradii();
  /** What's behind a background blur, read for it (see #backgroundBlur). */
  #blurBackdrop: AnyCanvas | null = null;
  /** Noise tiles, made once per look. */
  readonly #noiseTiles = new NoiseTiles();
  /** Draws texture effects, with its own WebGL context (made on first use). */
  readonly #texture = new TexturePainter();
  /** Where a text stroke inside or outside its glyphs is drawn, then cut to one side (#textStrokes). */
  #strokeCanvas: OffscreenCanvas | HTMLCanvasElement | null = null;

  constructor(scene: Scene, measurer: TextMeasurer, options: CanvasRendererOptions = {}) {
    this.#scene = scene;
    this.#measurer = measurer;
    this.images = options.images ?? new ImageCache();
    // A decoded (or sharper) image changes pixels the last frame has: draw afresh.
    this.images.subscribe(() => this.#epoch++);
  }

  /**
   * Draws the page. Returns false when the frame is a quick stand-in (a
   * zoom drawn by scaling the last exact frame): draw again with `exact`
   * once the camera settles.
   */
  render(
    ctx: Ctx,
    pageId: string,
    camera: Camera,
    viewport: { width: number; height: number },
    dpr: number,
    { exact = false }: { exact?: boolean } = {},
  ): boolean {
    const start = performance.now();
    this.stats = { drawn: 0, culled: 0, ms: 0 };
    this.images.frame();
    const page = this.#scene.doc.get(pageId);
    resetState(ctx);
    if (!page) {
      this.#last = null;
      ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
      return true;
    }
    // Whole device pixels, so a pan can move the last frame exactly (see `#reuse`).
    const tx = Math.round(camera.x * dpr);
    const ty = Math.round(camera.y * dpr);
    const snapped = new Camera(tx / dpr, ty / dpr, camera.zoom);
    const background = getProp(page.props, "backgroundColor") ?? this.canvasColor;
    const frame: LastFrame = {
      ctx,
      pageId,
      zoom: camera.zoom,
      dpr,
      width: ctx.canvas.width,
      height: ctx.canvas.height,
      version: this.#scene.doc.version,
      epoch: this.#epoch,
      fonts: this.#measurer.generation ?? 0,
      background,
      hidden: this.hidden,
      whole: this.whole,
      tx,
      ty,
    };
    if (!this.#last || !sameContent(this.#last, frame)) this.#generation++;
    if (!exact && this.#preview(ctx, frame)) {
      this.stats.ms = performance.now() - start;
      return false;
    }
    this.#screen = ctx;
    try {
      const reused = this.#reuse(ctx, frame, snapped, dpr);
      this.#last = frame;
      this.#lastExact = true;
      if (!reused) {
        ctx.fillStyle = background;
        ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
        this.#drawChildren(ctx, pageId, snapped, dpr, snapped.visibleRect(viewport));
      }
    } finally {
      this.#screen = null;
    }
    this.stats.ms = performance.now() - start;
    return true;
  }

  /**
   * A zoom with nothing else changed: scale a snapshot of the last exact
   * frame instead of redrawing every layer, which is what a pinch or a
   * wheel zoom asks for sixty times a second. Soft while zooming in; the
   * caller draws an exact frame when the zoom settles. Too far from the
   * snapshot (blurry, or showing too much empty edge) and it declines.
   */
  #preview(ctx: Ctx, frame: LastFrame): boolean {
    const last = this.#last;
    if (!last || last.zoom === frame.zoom || !sameContent(last, frame)) return false;
    // The snapshot is the canvas as the last exact frame left it.
    if (this.#lastExact) {
      const snapshot = this.#snapshotFor(frame.width, frame.height);
      if (!snapshot) return false;
      const sctx = snapshot.getContext("2d") as Ctx | null;
      if (!sctx) return false;
      sctx.globalCompositeOperation = "copy";
      sctx.drawImage(ctx.canvas, 0, 0);
      this.#snapshotFrame = last;
      this.#lastExact = false;
    }
    const shot = this.#snapshotFrame;
    const snapshot = this.#snapshot;
    if (!shot || !snapshot || !sameContent(shot, frame)) return false;
    const ratio = frame.zoom / shot.zoom;
    if (ratio > PREVIEW_MAX_SCALE || ratio < PREVIEW_MIN_SCALE) return false;
    resetState(ctx);
    ctx.fillStyle = frame.background;
    ctx.fillRect(0, 0, frame.width, frame.height);
    // Device pixels: new = ratio × (old − old translation) + new translation.
    ctx.setTransform(ratio, 0, 0, ratio, frame.tx - ratio * shot.tx, frame.ty - ratio * shot.ty);
    ctx.imageSmoothingQuality = "low";
    ctx.drawImage(snapshot, 0, 0);
    resetState(ctx);
    this.#last = frame;
    return true;
  }

  #snapshotFor(width: number, height: number): OffscreenCanvas | HTMLCanvasElement | null {
    if (this.#snapshot && this.#snapshot.width === width && this.#snapshot.height === height)
      return this.#snapshot;
    if (typeof OffscreenCanvas !== "undefined") this.#snapshot = new OffscreenCanvas(width, height);
    else if (typeof document !== "undefined") {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      this.#snapshot = canvas;
    } else return null;
    return this.#snapshot;
  }

  /**
   * Forget the last frame, so the next one is drawn in full: something the
   * renderer can't see changed (an image decoded, a font loaded, the theme).
   */
  invalidate(): void {
    this.#epoch++;
  }

  /**
   * A pan with nothing else changed: move the last frame by the camera's
   * whole-pixel step and draw only the strips it uncovered. Panning then
   * costs what the new edge holds, not what the whole view holds.
   */
  #reuse(ctx: Ctx, frame: LastFrame, camera: Camera, dpr: number): boolean {
    const last = this.#last;
    // Only from an exact frame: a zoom stand-in isn't worth moving.
    if (!last || !this.#lastExact || last.zoom !== frame.zoom || !sameContent(last, frame))
      return false;
    const dx = frame.tx - last.tx;
    const dy = frame.ty - last.ty;
    const { width, height } = frame;
    if (dx === 0 && dy === 0) return true;
    // Moved more than a screen: nothing to keep.
    if (Math.abs(dx) >= width || Math.abs(dy) >= height) return false;
    ctx.globalCompositeOperation = "copy";
    ctx.drawImage(ctx.canvas, dx, dy);
    ctx.globalCompositeOperation = "source-over";
    // The uncovered strips, in device pixels: one along x, one along y.
    const strips: Array<[number, number, number, number]> = [];
    if (dx > 0) strips.push([0, 0, dx, height]);
    if (dx < 0) strips.push([width + dx, 0, -dx, height]);
    if (dy > 0) strips.push([0, 0, width, dy]);
    if (dy < 0) strips.push([0, height + dy, width, -dy]);
    const rects = strips.map(([x, y, w, h]) => ({ x, y, width: w, height: h }));
    const grown = this.#withReaders(rects, frame.pageId, camera, dpr, width, height);
    if (grown.readers.size > 0) {
      // Layers that read the backdrop around them (glass, background blur) and touch a strip
      // are redrawn whole, with all they read, in one pass: drawn in a strip alone, they'd
      // read the last frame's finished pixels past its edge, and leave a seam there.
      this.#redraw(ctx, frame, camera, dpr, grown.rects, grown.readers);
      return true;
    }
    for (const rect of rects) this.#redraw(ctx, frame, camera, dpr, [rect], grown.readers);
    return true;
  }

  /**
   * Clears `rects` (device pixels) to the background and draws every layer
   * touching them, clipped; of the layers reading the backdrop, only `fresh` ones.
   */
  #redraw(
    ctx: Ctx,
    frame: LastFrame,
    camera: Camera,
    dpr: number,
    rects: readonly Rect[],
    fresh: ReadonlySet<string>,
  ): void {
    resetState(ctx);
    ctx.save();
    ctx.beginPath();
    for (const r of rects) ctx.rect(r.x, r.y, r.width, r.height);
    ctx.clip();
    ctx.fillStyle = frame.background;
    let x0 = Number.POSITIVE_INFINITY;
    let y0 = Number.POSITIVE_INFINITY;
    let x1 = Number.NEGATIVE_INFINITY;
    let y1 = Number.NEGATIVE_INFINITY;
    for (const r of rects) {
      ctx.fillRect(r.x, r.y, r.width, r.height);
      x0 = Math.min(x0, r.x);
      y0 = Math.min(y0, r.y);
      x1 = Math.max(x1, r.x + r.width);
      y1 = Math.max(y1, r.y + r.height);
    }
    // What's redrawn, in page coordinates: only layers touching it are drawn.
    const toPage = (x: number, y: number, w: number, h: number): Rect => ({
      x: (x / dpr - camera.x) / camera.zoom,
      y: (y / dpr - camera.y) / camera.zoom,
      width: w / dpr / camera.zoom,
      height: h / dpr / camera.zoom,
    });
    this.#parts = rects.length > 1 ? rects.map((r) => toPage(r.x, r.y, r.width, r.height)) : null;
    this.#fresh = fresh;
    try {
      this.#drawChildren(ctx, frame.pageId, camera, dpr, toPage(x0, y0, x1 - x0, y1 - y0));
    } finally {
      this.#parts = null;
      this.#fresh = null;
    }
    ctx.restore();
  }

  /**
   * The strips grown by what's read by the layers that read around them and
   * paint in them, and so on (what one reads may be where another paints),
   * within the canvas; null when no such layer paints in them, so they're
   * drawn as they are.
   */
  #withReaders(
    strips: readonly Rect[],
    pageId: string,
    camera: Camera,
    dpr: number,
    width: number,
    height: number,
  ): { rects: Rect[]; readers: Set<string> } {
    const readers = this.#readers(pageId);
    const taken = new Set<string>();
    if (readers.length === 0) return { rects: [...strips], readers: taken };
    const areas: Array<{ id: string; paints: Rect; reads: Rect }> = [];
    for (const id of readers) {
      const area = this.#readerArea(id, camera, dpr, width, height);
      if (area) areas.push({ id, ...area });
    }
    const dirty = [...strips];
    for (let grew = true; grew; ) {
      grew = false;
      for (const area of areas) {
        if (taken.has(area.id) || !dirty.some((d) => rectsIntersect(d, area.paints))) continue;
        taken.add(area.id);
        dirty.push(area.reads);
        grew = true;
      }
    }
    return { rects: dirty, readers: taken };
  }

  /**
   * The page's layers that read the backdrop around them: glass and
   * background blur. (Layer blur and texture spread only the layer, which
   * is drawn whole into a canvas of its own.) Kept until the document changes.
   */
  #readers(pageId: string): string[] {
    const doc = this.#scene.doc;
    const cached = this.#readerCache;
    if (cached?.pageId === pageId && cached.version === doc.version) return cached.ids;
    const ids: string[] = [];
    const stack = [pageId];
    while (stack.length > 0) {
      const id = stack.pop() as string;
      for (const child of doc.childIds(id)) {
        const node = doc.get(child);
        if (!node || node.props.visible === false) continue;
        stack.push(child);
        if (
          getProp(node.props, "effects").some(
            (e) => e.visible !== false && (e.type === "glass" || e.type === "background-blur"),
          )
        )
          ids.push(child);
      }
    }
    this.#readerCache = { pageId, version: doc.version, ids };
    return ids;
  }

  /**
   * Where a layer that reads around it paints (its box and its effects'
   * reach), and what it reads (that and the farthest its backdrop is read),
   * in device pixels, within the canvas.
   */
  #readerArea(
    id: string,
    camera: Camera,
    dpr: number,
    width: number,
    height: number,
  ): { paints: Rect; reads: Rect } | null {
    const node = this.#scene.doc.get(id);
    const b = this.#scene.bounds(id);
    if (!node || !b) return null;
    const z = camera.zoom * dpr;
    const paints = this.#effectReach(node) * z;
    let reads = paints;
    for (const e of getProp(node.props, "effects")) {
      if (e.visible === false) continue;
      if (e.type === "glass") reads = Math.max(reads, glassParams(e, z).margin);
      if (e.type === "background-blur") reads = Math.max(reads, blurSigma(e.radius) * z * 3);
    }
    const rect = (reach: number): Rect | null => {
      const r = Math.ceil(reach) + 2;
      const x0 = Math.max(0, Math.floor((b.x * camera.zoom + camera.x) * dpr) - r);
      const y0 = Math.max(0, Math.floor((b.y * camera.zoom + camera.y) * dpr) - r);
      const x1 = Math.min(width, Math.ceil(((b.x + b.width) * camera.zoom + camera.x) * dpr) + r);
      const y1 = Math.min(height, Math.ceil(((b.y + b.height) * camera.zoom + camera.y) * dpr) + r);
      return x1 > x0 && y1 > y0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : null;
    };
    const p = rect(paints);
    const r = rect(reads);
    return p && r ? { paints: p, reads: r } : null;
  }

  /**
   * Draws layers (with their children) into the canvas so that the page rect
   * `rect` fills it at `scale` canvas pixels per unit. Exports and thumbnails
   * use this, so they match the canvas exactly. The canvas should be
   * `ceil(rect.width × scale)` by `ceil(rect.height × scale)`. Without a
   * `background` the result is transparent.
   */
  renderNodes(
    ctx: Ctx,
    ids: readonly string[],
    rect: Rect,
    scale: number,
    background: string | null = null,
    /** Level of detail (unreadable text as bars), for thumbnails; exports leave it off. */
    detail = false,
  ): void {
    this.images.frame();
    this.stats = { drawn: 0, culled: 0, ms: 0 };
    resetState(ctx);
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    if (background) {
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    }
    const camera = new Camera(-rect.x * scale, -rect.y * scale, scale);
    const hidden = this.hidden;
    this.hidden = new Set();
    this.#detail = detail;
    try {
      for (const id of ids) this.#draw(ctx, id, camera, 1, rect);
    } finally {
      this.hidden = hidden;
      this.#detail = true;
    }
  }

  /**
   * Draws a layer and what's inside it. Each layer sets the canvas state it
   * needs outright (transform, opacity, blending) instead of saving and
   * restoring around itself, which costs more than drawing most layers;
   * save/restore is kept for clips, filters and shadows. Opacity and
   * blending come down from groups as arguments.
   */
  #draw(
    ctx: Ctx,
    id: string,
    camera: Camera,
    dpr: number,
    visible: Rect,
    alpha = 1,
    inheritedBlend: GlobalCompositeOperation = "source-over",
  ): void {
    const node = this.#scene.doc.get(id);
    if (!node || node.props.visible === false || this.hidden.has(id)) return;
    const bounds = this.#scene.bounds(id);
    // Effects (shadows, blur) can paint outside the box: pad the cull test.
    const pad = 64 / camera.zoom + this.#effectReach(node);
    if (
      !bounds ||
      bounds.x - pad > visible.x + visible.width ||
      bounds.y - pad > visible.y + visible.height ||
      bounds.x + bounds.width + pad < visible.x ||
      bounds.y + bounds.height + pad < visible.y ||
      (this.#parts &&
        !this.#parts.some(
          (r) =>
            bounds.x - pad <= r.x + r.width &&
            bounds.y - pad <= r.y + r.height &&
            bounds.x + bounds.width + pad >= r.x &&
            bounds.y + bounds.height + pad >= r.y,
        ))
    ) {
      this.stats.culled++;
      return;
    }
    // Smaller than half a device pixel both ways: nothing would show.
    const pixels = camera.zoom * dpr;
    if (
      this.#detail &&
      node.type !== "group" &&
      bounds.width * pixels < 0.5 &&
      bounds.height * pixels < 0.5
    ) {
      this.stats.culled++;
      return;
    }
    this.stats.drawn++;
    // Drawn into its own canvas for its post effects: its opacity and blending apply when that's composited.
    const isolated = this.#isolated.has(id);
    const opacity = alpha * (isolated ? 1 : getProp(node.props, "opacity"));
    if (opacity <= 0) return;
    const own = isolated
      ? "source-over"
      : (BLEND[getProp(node.props, "blendMode")] ?? "source-over");
    // A group's blending carries to its layers unless they blend their own way.
    const blend = own === "source-over" ? inheritedBlend : own;

    const post = isolated ? null : postEffects(getProp(node.props, "effects"));
    if (post && (post.length > 0 || fadesAsOne(node, this.#scene.doc.childIds(id).length))) {
      this.#drawProcessed(ctx, node, camera, dpr, opacity, blend, post);
      return;
    }

    if (node.type === "group") {
      this.#drawChildren(ctx, id, camera, dpr, visible, opacity, blend);
      return;
    }

    const m = this.#scene.worldMatrix(id);
    const z = camera.zoom * dpr;
    const place = () => {
      ctx.setTransform(
        m[0] * z,
        m[1] * z,
        m[2] * z,
        m[3] * z,
        (m[4] * camera.zoom + camera.x) * dpr,
        (m[5] * camera.zoom + camera.y) * dpr,
      );
      ctx.globalAlpha = opacity;
      ctx.globalCompositeOperation = blend;
    };
    place();

    const width = getProp(node.props, "width");
    const height = getProp(node.props, "height");
    const shape = this.#shapePath(node, width, height);

    this.#shadows(ctx, node, shape, "drop-shadow", camera.zoom * dpr);
    // Isolated for post effects, there's nothing behind it here: its background blur was drawn already.
    if (!isolated) {
      this.#backgroundBlur(ctx, node, shape, camera.zoom * dpr);
      this.#glassEffect(ctx, node, shape, width, height, camera.zoom * dpr);
    }
    if (node.type === "text") this.#text(ctx, node, width, undefined, camera.zoom * dpr);
    else
      for (const paint of getProp(node.props, "fills"))
        this.#fill(ctx, shape, paint, width, height, node);
    this.#shadows(ctx, node, shape, "inner-shadow", camera.zoom * dpr);

    if (node.type === "frame") {
      const children = this.#scene.doc.childIds(id);
      if (children.length > 0) {
        const clip = getProp(node.props, "clipContent");
        if (clip) {
          ctx.save();
          ctx.clip(shape);
        }
        // Its children are as see-through as it is, and blend as it does.
        this.#drawChildren(ctx, id, camera, dpr, visible, opacity, blend);
        if (clip) ctx.restore();
        // The children set their own state; take this frame's back for its strokes.
        place();
      }
    }
    if (node.type === "text") this.#textStrokes(ctx, node, width, camera.zoom * dpr);
    else this.#strokes(ctx, node, shape, width, height);
  }

  /**
   * Post effects (decision 0008) work on the whole layer, as in Figma: its
   * fills, strokes and shadows, and a frame's children, as one picture. So
   * the layer is drawn plainly into a canvas of its own, covering what it
   * paints (where that's on screen) plus its effects' reach. Its effects
   * apply there in order (noise and texture in place, a blur partway
   * through into the second canvas), and the result is composited with the
   * layer's opacity and blending, through a last blur if the list ends in
   * one. A large layer is drawn there at a lower resolution, so memory
   * stays bounded.
   */
  #drawProcessed(
    ctx: Ctx,
    node: NodeRecord,
    camera: Camera,
    dpr: number,
    opacity: number,
    blend: GlobalCompositeOperation,
    post: readonly PostEffect[],
  ): void {
    const id = node.id;
    const z = camera.zoom * dpr;
    const m = this.#scene.worldMatrix(id);
    // Background blur and glass read what's already drawn behind the layer: here, before the
    // layer goes on (drawn alone, it has nothing behind it), as the layer's opacity and blending.
    const effects = getProp(node.props, "effects");
    if (
      node.type !== "group" &&
      effects.some(
        (e) => e.visible !== false && (e.type === "background-blur" || e.type === "glass"),
      )
    ) {
      resetState(ctx);
      ctx.globalAlpha = opacity;
      ctx.globalCompositeOperation = blend;
      ctx.setTransform(
        m[0] * z,
        m[1] * z,
        m[2] * z,
        m[3] * z,
        (m[4] * camera.zoom + camera.x) * dpr,
        (m[5] * camera.zoom + camera.y) * dpr,
      );
      const width = getProp(node.props, "width");
      const height = getProp(node.props, "height");
      const shape = this.#shapePath(node, width, height);
      this.#backgroundBlur(ctx, node, shape, z);
      this.#glassEffect(ctx, node, shape, width, height, z);
    }
    const region = exportBounds(this.#scene, [id]);
    if (!region) return;
    // In device pixels: what it paints, kept to the canvas plus the effects' reach past it.
    const margin = Math.ceil(postMargin(post) * z);
    const x0 = Math.floor(Math.max((region.x * camera.zoom + camera.x) * dpr - margin, -margin));
    const y0 = Math.floor(Math.max((region.y * camera.zoom + camera.y) * dpr - margin, -margin));
    const x1 = Math.ceil(
      Math.min(
        ((region.x + region.width) * camera.zoom + camera.x) * dpr + margin,
        ctx.canvas.width + margin,
      ),
    );
    const y1 = Math.ceil(
      Math.min(
        ((region.y + region.height) * camera.zoom + camera.y) * dpr + margin,
        ctx.canvas.height + margin,
      ),
    );
    if (x1 <= x0 || y1 <= y0) return;
    const cap = post.some((e) => e.type === "layer-blur") ? BLUR_MAX_PIXELS : POST_MAX_PIXELS;
    const scale = Math.min(1, Math.sqrt(cap / ((x1 - x0) * (y1 - y0))));
    const w = Math.max(1, Math.ceil((x1 - x0) * scale));
    const h = Math.max(1, Math.ceil((y1 - y0) * scale));
    const depth = this.#isolated.size;
    let layer = this.#postCanvas(depth * 2, w, h);
    const lctx = layer?.getContext("2d") as Ctx | null | undefined;
    if (!layer || !lctx) return;
    resetState(lctx);
    // All of it, not just w×h: a child's background blur or glass reads past its corner.
    lctx.clearRect(0, 0, layer.width, layer.height);
    // The same camera, moved so the region's corner is the canvas's, at the reduced resolution.
    const shifted = new Camera(camera.x - x0 / dpr, camera.y - y0 / dpr, camera.zoom);
    // All of the layer that its canvas holds, even when only part of the screen is being
    // redrawn: its blur or texture spreads what's there into the rest.
    const holds = {
      x: -shifted.x / camera.zoom,
      y: -shifted.y / camera.zoom,
      width: w / (dpr * scale) / camera.zoom,
      height: h / (dpr * scale) / camera.zoom,
    };
    const parts = this.#parts;
    const fresh = this.#fresh;
    this.#parts = null;
    this.#fresh = null;
    this.#isolated.add(id);
    try {
      this.#draw(lctx, id, shifted, dpr * scale, holds, 1, "source-over");
    } finally {
      this.#isolated.delete(id);
      this.#parts = parts;
      this.#fresh = fresh;
    }

    // The layer's units to that canvas's pixels.
    const zs = z * scale;
    const toCanvas: Matrix = [
      m[0] * zs,
      m[1] * zs,
      m[2] * zs,
      m[3] * zs,
      ((m[4] * camera.zoom + camera.x) * dpr - x0) * scale,
      ((m[5] * camera.zoom + camera.y) * dpr - y0) * scale,
    ];
    let finalBlur = 0;
    for (let i = 0; i < post.length; i++) {
      const e = post[i] as PostEffect;
      if (e.type === "noise") {
        const c = layer.getContext("2d") as Ctx | null;
        if (c) paintNoise(c, this.#noiseTiles, e, toCanvas, w, h);
      } else if (e.type === "texture") {
        this.#texture.paint(layer, w, h, e, toCanvas, zs);
      } else if (i === post.length - 1) {
        // A blur last is applied as the picture goes on.
        finalBlur = blurSigma(e.radius) * z;
      } else {
        // Partway through, the blurred picture is what the next effect works on.
        const into = this.#postCanvas(depth * 2 + 1, w, h);
        const c = into?.getContext("2d") as Ctx | null | undefined;
        if (!into || !c) continue;
        resetState(c);
        c.clearRect(0, 0, into.width, into.height);
        c.filter = `blur(${blurSigma(e.radius) * zs}px)`;
        c.drawImage(layer, 0, 0, w, h, 0, 0, w, h);
        c.filter = "none";
        // The two swap: the blurred one is now the picture.
        this.#postCanvases[depth * 2 + 1] = layer;
        this.#postCanvases[depth * 2] = into;
        layer = into;
      }
    }

    resetState(ctx);
    ctx.globalAlpha = opacity;
    ctx.globalCompositeOperation = blend;
    if (finalBlur > 0) ctx.filter = `blur(${finalBlur}px)`;
    ctx.drawImage(layer, 0, 0, w, h, x0, y0, w / scale, h / scale);
    resetState(ctx);
  }

  /** A canvas for post effects, by slot (two per nesting depth): kept and grown. */
  #postCanvas(slot: number, w: number, h: number): OffscreenCanvas | HTMLCanvasElement | null {
    let canvas = this.#postCanvases[slot];
    if (!canvas) {
      if (typeof OffscreenCanvas !== "undefined") canvas = new OffscreenCanvas(w, h);
      else if (typeof document !== "undefined") canvas = document.createElement("canvas");
      else return null;
      this.#postCanvases[slot] = canvas;
    }
    if (canvas.width < w) canvas.width = w;
    if (canvas.height < h) canvas.height = h;
    return canvas;
  }

  /**
   * Draws a parent's children bottom first. A mask isn't drawn itself: it
   * masks the children above it, up to the next mask, by its outline (a
   * clip) or by its alpha or luminance (see #drawMasked).
   */
  #drawChildren(
    ctx: Ctx,
    parentId: string,
    camera: Camera,
    dpr: number,
    visible: Rect,
    alpha = 1,
    blend: GlobalCompositeOperation = "source-over",
  ): void {
    const doc = this.#scene.doc;
    if (!hasMask(doc, parentId)) {
      for (const child of doc.childIds(parentId))
        this.#draw(ctx, child, camera, dpr, visible, alpha, blend);
      return;
    }
    let clipping = false;
    // Layers above a mask that masks by its picture, gathered to draw together.
    let scope: { mask: NodeRecord; ids: string[] } | null = null;
    const flush = () => {
      if (scope) this.#drawMasked(ctx, scope.mask, scope.ids, camera, dpr, alpha, blend);
      scope = null;
    };
    for (const { id, isMask } of maskScopes(doc, parentId)) {
      if (!isMask) {
        if (scope) (scope as { ids: string[] }).ids.push(id);
        else this.#draw(ctx, id, camera, dpr, visible, alpha, blend);
        continue;
      }
      flush();
      if (clipping) ctx.restore();
      clipping = false;
      const mask = doc.get(id) as NodeRecord;
      if (getProp(mask.props, "maskType") !== "outline") {
        scope = { mask, ids: [] };
        continue;
      }
      ctx.save();
      clipping = true;
      const m = this.#scene.worldMatrix(id);
      const z = camera.zoom * dpr;
      ctx.setTransform(
        m[0] * z,
        m[1] * z,
        m[2] * z,
        m[3] * z,
        (m[4] * camera.zoom + camera.x) * dpr,
        (m[5] * camera.zoom + camera.y) * dpr,
      );
      const shape = this.#shapePath(
        mask,
        getProp(mask.props, "width"),
        getProp(mask.props, "height"),
      );
      ctx.clip(shape, mask.type === "path" ? getProp(mask.props, "windingRule") : "nonzero");
    }
    flush();
    if (clipping) ctx.restore();
  }

  /**
   * Layers masked by a mask's picture, as in Figma (decision 0016): they're
   * drawn into a canvas of their own over the mask's reach (outside it,
   * nothing of them shows), the mask layer into another (its fills,
   * gradients, opacity and effects), and kept where the mask's alpha is (or
   * its luminance, turned into alpha). Then that goes on the canvas.
   */
  #drawMasked(
    ctx: Ctx,
    mask: NodeRecord,
    ids: readonly string[],
    camera: Camera,
    dpr: number,
    alpha: number,
    blend: GlobalCompositeOperation,
  ): void {
    if (ids.length === 0) return;
    const region = exportBounds(this.#scene, [mask.id]);
    if (!region) return;
    const x0 = Math.max(0, Math.floor((region.x * camera.zoom + camera.x) * dpr));
    const y0 = Math.max(0, Math.floor((region.y * camera.zoom + camera.y) * dpr));
    const x1 = Math.min(
      ctx.canvas.width,
      Math.ceil(((region.x + region.width) * camera.zoom + camera.x) * dpr),
    );
    const y1 = Math.min(
      ctx.canvas.height,
      Math.ceil(((region.y + region.height) * camera.zoom + camera.y) * dpr),
    );
    if (x1 <= x0 || y1 <= y0) return;
    const w = x1 - x0;
    const h = y1 - y0;
    const depth = this.#maskDepth;
    const content = this.#maskCanvas(depth * 2, w, h);
    const picture = this.#maskCanvas(depth * 2 + 1, w, h);
    const cctx = content?.getContext("2d") as Ctx | null | undefined;
    const mctx = picture?.getContext("2d") as Ctx | null | undefined;
    if (!content || !picture || !cctx || !mctx) return;
    for (const c of [cctx, mctx]) {
      resetState(c);
      c.clearRect(0, 0, w, h);
    }
    // The same camera, moved so the region's corner is the canvases' own.
    const shifted = new Camera(camera.x - x0 / dpr, camera.y - y0 / dpr, camera.zoom);
    const holds = {
      x: -shifted.x / camera.zoom,
      y: -shifted.y / camera.zoom,
      width: w / dpr / camera.zoom,
      height: h / dpr / camera.zoom,
    };
    // Drawn whole into canvases of their own: not the parts of a partial redraw.
    const parts = this.#parts;
    const fresh = this.#fresh;
    this.#parts = null;
    this.#fresh = null;
    this.#maskDepth++;
    try {
      for (const id of ids) this.#draw(cctx, id, shifted, dpr, holds, alpha, blend);
      this.#draw(mctx, mask.id, shifted, dpr, holds, 1, "source-over");
    } finally {
      this.#maskDepth--;
      this.#parts = parts;
      this.#fresh = fresh;
    }
    if (getProp(mask.props, "maskType") === "luminance") this.#luminance.apply(picture, w, h);
    resetState(cctx);
    cctx.globalCompositeOperation = "destination-in";
    cctx.drawImage(picture, 0, 0, w, h, 0, 0, w, h);
    cctx.globalCompositeOperation = "source-over";
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.filter = "none";
    ctx.drawImage(content, 0, 0, w, h, x0, y0, w, h);
    ctx.restore();
  }

  /** Canvases for masked layers and their masks: two per nesting depth, grown as needed. */
  #maskCanvas(slot: number, w: number, h: number): AnyCanvas | null {
    const canvas = scratch(
      this.#maskCanvases[slot] ?? null,
      Math.max(w, this.#maskCanvases[slot]?.width ?? 0),
      Math.max(h, this.#maskCanvases[slot]?.height ?? 0),
    );
    if (canvas) this.#maskCanvases[slot] = canvas;
    return canvas;
  }

  #effectReach(node: NodeRecord): number {
    let reach = 0;
    const effects = getProp(node.props, "effects");
    for (const e of effects)
      if (e.visible !== false && e.type === "drop-shadow")
        reach = Math.max(reach, Math.abs(e.x) + Math.abs(e.y) + e.blur * 2 + Math.max(0, e.spread));
    if (
      (node.type === "line" || node.type === "path") &&
      (getProp(node.props, "markerStart") !== "none" || getProp(node.props, "markerEnd") !== "none")
    )
      reach = Math.max(reach, markerLength(getProp(node.props, "strokeWeight")));
    // Blur and texture spread everything above: their reach adds.
    return reach + postReach(postEffects(effects));
  }

  #shapePath(node: NodeRecord, w: number, h: number): Path2D {
    // Built once per version of the layer: its props object changes with every edit.
    const cached = this.#shapes.get(node.props);
    if (cached && cached.w === w && cached.h === h) return cached.path;
    const path = this.#buildShape(node, w, h);
    this.#shapes.set(node.props, { w, h, path });
    return path;
  }

  #buildShape(node: NodeRecord, w: number, h: number): Path2D {
    const path = new Path2D();
    switch (node.type) {
      case "ellipse":
        path.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
        return path;
      case "line":
        path.moveTo(0, h / 2);
        path.lineTo(w, h / 2);
        return path;
      case "path": {
        const d = getProp(node.props, "pathData");
        const cached = this.#paths.get(node.id);
        if (cached?.d === d) return cached.path;
        let p: Path2D;
        try {
          p = new Path2D(d);
        } catch {
          p = new Path2D();
        }
        this.#paths.set(node.id, { d, path: p });
        return p;
      }
      case "polygon":
      case "star": {
        // Built from the same outline flatten and booleans use, cached per shape.
        const key = `${node.type}:${w}:${h}:${getProp(node.props, "pointCount")}:${node.type === "star" ? getProp(node.props, "innerRadius") : ""}:${getProp(node.props, "cornerRadius")}`;
        const cached = this.#paths.get(node.id);
        if (cached?.d === key) return cached.path;
        const outline = nodePath(node);
        const p = new Path2D(outline ? serializePath(outline) : "");
        this.#paths.set(node.id, { d: key, path: p });
        return p;
      }
      case "frame":
      case "rect": {
        const radii = getProp(node.props, "cornerRadii");
        const r = getProp(node.props, "cornerRadius");
        const max = Math.min(w, h) / 2;
        if (radii)
          path.roundRect(
            0,
            0,
            w,
            h,
            radii.map((v) => Math.min(v, max)),
          );
        else if (r > 0) path.roundRect(0, 0, w, h, Math.min(r, max));
        else path.rect(0, 0, w, h);
        return path;
      }
      default:
        path.rect(0, 0, w, h);
        return path;
    }
  }

  /**
   * A paint as a canvas style, in the layer's units. Gradients are laid out
   * in the layer's unit square, as in Figma: a linear gradient's bands run
   * across its handles there (so, on a wide layer, at a slant on screen),
   * which a pixel-space gradient reproduces exactly. Radial and angular ones
   * are ellipses there; filled shapes get them exactly (#gradientFill), and
   * strokes and text approximate them with circles.
   */
  #paintStyle(ctx: Ctx, paint: Paint, w: number, h: number): string | CanvasGradient | null {
    if (paint.type === "solid") return hexToRgba(paint.color, paint.opacity ?? 1);
    if (paint.type === "linear") {
      const line = linearInPixels(paint, w, h);
      const gradient = line
        ? ctx.createLinearGradient(line.x0, line.y0, line.x1, line.y1)
        : ctx.createLinearGradient(0, 0, 0, 0);
      for (const stop of paint.stops)
        gradient.addColorStop(stop.position, hexToRgba(stop.color, paint.opacity ?? 1));
      return gradient;
    }
    if (paint.type === "radial" || paint.type === "angular") {
      const fx = paint.from.x * w;
      const fy = paint.from.y * h;
      const tx = paint.to.x * w;
      const ty = paint.to.y * h;
      const gradient =
        paint.type === "radial"
          ? ctx.createRadialGradient(fx, fy, 0, fx, fy, Math.hypot(tx - fx, ty - fy))
          : // Conic gradients start at 3 o'clock and turn clockwise: start toward `to`.
            ctx.createConicGradient(Math.atan2(ty - fy, tx - fx), fx, fy);
      for (const stop of paint.stops)
        gradient.addColorStop(stop.position, hexToRgba(stop.color, paint.opacity ?? 1));
      return gradient;
    }
    return null; // Images arrive with the asset pipeline.
  }

  #fill(ctx: Ctx, shape: Path2D, paint: Paint, w: number, h: number, node: NodeRecord): void {
    if (paint.visible === false || node.type === "line") return;
    if (paint.type === "image") {
      this.#imageFill(ctx, shape, paint, w, h, node);
      return;
    }
    const rule = node.type === "path" ? getProp(node.props, "windingRule") : "nonzero";
    if (paint.type === "linear" || paint.type === "radial" || paint.type === "angular") {
      this.#gradientFill(ctx, shape, paint, w, h, rule);
      return;
    }
    const style = this.#paintStyle(ctx, paint, w, h);
    if (!style) return;
    ctx.fillStyle = style;
    if (!paint.blendMode) {
      ctx.fill(shape, rule);
      return;
    }
    const before = ctx.globalCompositeOperation;
    ctx.globalCompositeOperation = BLEND[paint.blendMode] ?? "source-over";
    ctx.fill(shape, rule);
    ctx.globalCompositeOperation = before;
  }

  /**
   * A gradient fill, exact: drawn in the gradient's own space, where it's
   * the unit gradient (linear along x, radial and angular around the
   * origin), mapped onto the layer by its handles in the unit square.
   */
  #gradientFill(
    ctx: Ctx,
    shape: Path2D,
    paint: GradientPaint,
    w: number,
    h: number,
    rule: CanvasFillRule,
  ): void {
    const m = gradientMatrix(paint, w, h);
    if (!m) return;
    ctx.save();
    if (paint.blendMode) ctx.globalCompositeOperation = BLEND[paint.blendMode] ?? "source-over";
    ctx.clip(shape, rule);
    ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
    const gradient =
      paint.type === "linear"
        ? ctx.createLinearGradient(0, 0, 1, 0)
        : paint.type === "radial"
          ? ctx.createRadialGradient(0, 0, 0, 0, 0, 1)
          : // Conic gradients start at 3 o'clock and turn clockwise: here, toward `to`.
            ctx.createConicGradient(0, 0, 0);
    for (const stop of paint.stops)
      gradient.addColorStop(stop.position, hexToRgba(stop.color, paint.opacity ?? 1));
    ctx.fillStyle = gradient;
    // The layer's box, in the gradient's space.
    const box = boxInGradientSpace(m, w, h);
    ctx.fillRect(box.x, box.y, box.width, box.height);
    ctx.restore();
  }

  /** An image paint, placed by its scale mode and clipped to the shape. */
  #imageFill(
    ctx: Ctx,
    shape: Path2D,
    paint: ImagePaint,
    w: number,
    h: number,
    node: NodeRecord,
  ): void {
    if (w <= 0 || h <= 0) return;
    ctx.save();
    if (paint.blendMode) ctx.globalCompositeOperation = BLEND[paint.blendMode] ?? "source-over";
    ctx.globalAlpha *= paint.opacity ?? 1;
    ctx.clip(shape, node.type === "path" ? getProp(node.props, "windingRule") : "nonzero");
    const natural = this.images.natural(paint.ref);
    const t = ctx.getTransform();
    // Device pixels per layer unit, to pick a bitmap no bigger than needed.
    const deviceScale = Math.hypot(t.a, t.b);
    const place = natural
      ? imagePlacement(paint.scaleMode, { width: w, height: h }, natural, paint.crop)
      : null;
    const view = place ? this.images.get(paint.ref, place.width * deviceScale) : null;
    if (!place || !view) {
      ctx.fillStyle = this.#placeholder(ctx);
      ctx.fillRect(0, 0, w, h);
    } else if (place.tile) {
      const pattern = ctx.createPattern(view.bitmap, "repeat");
      if (pattern) {
        pattern.setTransform(
          new DOMMatrix().scale(
            view.naturalWidth / view.bitmap.width,
            view.naturalHeight / view.bitmap.height,
          ),
        );
        ctx.fillStyle = pattern;
        ctx.fillRect(0, 0, w, h);
      }
    } else {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(view.bitmap, place.x, place.y, place.width, place.height);
    }
    ctx.restore();
  }

  /** A checkerboard fixed to device pixels, so it reads as "loading" at any zoom. */
  #placeholder(ctx: Ctx): CanvasPattern | string {
    let pattern = this.#placeholders.get(ctx);
    if (!pattern && typeof OffscreenCanvas !== "undefined") {
      const tile = new OffscreenCanvas(PLACEHOLDER.cell * 2, PLACEHOLDER.cell * 2);
      const tctx = tile.getContext("2d");
      if (tctx) {
        tctx.fillStyle = PLACEHOLDER.light;
        tctx.fillRect(0, 0, tile.width, tile.height);
        tctx.fillStyle = PLACEHOLDER.dark;
        tctx.fillRect(0, 0, PLACEHOLDER.cell, PLACEHOLDER.cell);
        tctx.fillRect(PLACEHOLDER.cell, PLACEHOLDER.cell, PLACEHOLDER.cell, PLACEHOLDER.cell);
        pattern = ctx.createPattern(tile, "repeat") ?? undefined;
        if (pattern) this.#placeholders.set(ctx, pattern);
      }
    }
    if (!pattern) return PLACEHOLDER.light;
    pattern.setTransform(ctx.getTransform().inverse());
    return pattern;
  }

  #strokes(ctx: Ctx, node: NodeRecord, shape: Path2D, w: number, h: number): void {
    const strokes = getProp(node.props, "strokes").filter((s) => s.visible !== false);
    if (strokes.length === 0) return;
    const sides = strokeWidths(node);
    if (!isUniform(sides)) {
      this.#sideStrokes(ctx, node, strokes, w, h);
      return;
    }
    const weight = sides[0];
    if (weight <= 0) return;
    // Open paths and lines stroke along their centre; closed paths honour alignment like any shape.
    const align =
      node.type === "line" ||
      (node.type === "path" && !isClosedPath(getProp(node.props, "pathData")))
        ? "center"
        : getProp(node.props, "strokeAlign");
    const rule = node.type === "path" ? getProp(node.props, "windingRule") : "nonzero";
    ctx.save();
    ctx.filter = "none";
    ctx.lineJoin = getProp(node.props, "strokeJoin");
    if (node.type === "line" || node.type === "path") {
      const cap = getProp(node.props, "strokeCap");
      ctx.lineCap = cap === "none" ? "butt" : cap;
    }
    const dashes = getProp(node.props, "strokeDashes");
    if (dashes.length > 0) ctx.setLineDash(dashes);
    // Inside and outside strokes: draw at double width and clip to one side of the edge.
    ctx.lineWidth = align === "center" ? weight : weight * 2;
    if (align === "inside") ctx.clip(shape, rule);
    if (align === "outside") {
      const outside = new Path2D();
      outside.rect(-weight * 4 - 1e5, -weight * 4 - 1e5, w + 2e5, h + 2e5);
      outside.addPath(shape);
      ctx.clip(outside, "evenodd");
    }
    // End markers: the stroke stops short under filled ones, then each marker
    // is drawn in every stroke paint, solid (never dashed).
    const markers = markersOf(node);
    const trimmed = markers ? trimmedStroke(node, markers.start.inset, markers.end.inset) : null;
    const line = trimmed ? new Path2D(serializePath(trimmed)) : shape;
    // Dashed boxes and ellipses: the pattern fitted to each side and corner, as Figma does.
    const pieces = dashes.length > 0 && !markers ? dashedOutline(node, w, h) : null;
    for (const paint of strokes) {
      const style = this.#paintStyle(ctx, paint, w, h);
      if (!style) continue;
      ctx.strokeStyle = style;
      if (pieces) {
        for (const piece of pieces) {
          ctx.setLineDash(piece.dashes);
          ctx.lineDashOffset = piece.offset;
          ctx.stroke(piece.path);
        }
      } else ctx.stroke(line);
      if (!markers) continue;
      ctx.save();
      ctx.setLineDash([]);
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.fillStyle = style;
      for (const marker of [markers.start, markers.end]) {
        if (marker.fill) ctx.fill(new Path2D(serializePath(marker.fill)));
        if (marker.stroke) ctx.stroke(new Path2D(serializePath(marker.stroke)));
      }
      ctx.restore();
    }
    ctx.restore();
  }
  /** A stroke with a width per side (see stroke-sides.ts): its region, filled with each paint. */
  #sideStrokes(ctx: Ctx, node: NodeRecord, strokes: readonly Paint[], w: number, h: number) {
    let path = this.#sidePaths.get(node.props);
    if (!path) {
      const r = getProp(node.props, "cornerRadius");
      const region = strokeRegion(
        w,
        h,
        getProp(node.props, "cornerRadii") ?? [r, r, r, r],
        strokeWidths(node),
        getProp(node.props, "strokeAlign"),
      );
      path = new Path2D(strokeRegionPath(region));
      this.#sidePaths.set(node.props, path);
    }
    ctx.save();
    ctx.filter = "none";
    for (const paint of strokes) {
      const style = this.#paintStyle(ctx, paint, w, h);
      if (!style) continue;
      ctx.fillStyle = style;
      ctx.fill(path, "evenodd");
    }
    ctx.restore();
  }

  #shadows(
    ctx: Ctx,
    node: NodeRecord,
    shape: Path2D,
    kind: "drop-shadow" | "inner-shadow",
    scale: number,
  ): void {
    const shadows = getProp(node.props, "effects").filter(
      (e) => e.type === kind && e.visible !== false,
    );
    if (shadows.length === 0) return;
    // Text casts drop shadows from its glyphs; inner shadows need a filled shape.
    if (node.type === "text" && kind === "inner-shadow") return;
    const width = getProp(node.props, "width");
    const height = getProp(node.props, "height");
    for (const s of shadows) {
      if (s.type !== "drop-shadow" && s.type !== "inner-shadow") continue;
      ctx.save();
      ctx.filter = "none";
      ctx.shadowColor = hexToRgba(s.color);
      ctx.shadowBlur = s.blur * scale;
      ctx.shadowOffsetX = s.x * scale;
      ctx.shadowOffsetY = s.y * scale;
      if (kind === "drop-shadow") {
        // Paint only the shadow: draw the shape far off-canvas and offset its
        // shadow back into place, so translucent fills don't show a dark copy.
        const t = ctx.getTransform();
        const far = 1e5 / Math.max(1e-9, Math.hypot(t.a, t.b));
        ctx.shadowOffsetX = s.x * scale - t.a * far;
        ctx.shadowOffsetY = s.y * scale - t.b * far;
        ctx.translate(far, 0);
        if (node.type === "text") this.#text(ctx, node, width, "#000", scale);
        else {
          ctx.fillStyle = "#000";
          ctx.fill(this.#spreadShape(node, shape, width, height, s.spread));
        }
      } else {
        ctx.clip(shape);
        // As above: paint only the ring's shadow. The ring itself overlaps the
        // inside of the shape when there's spread, and would show as a solid band.
        const t = ctx.getTransform();
        const far = 1e5 / Math.max(1e-9, Math.hypot(t.a, t.b));
        ctx.shadowOffsetX = s.x * scale - t.a * far;
        ctx.shadowOffsetY = s.y * scale - t.b * far;
        ctx.translate(far, 0);
        const ring = new Path2D();
        ring.rect(-1e4, -1e4, 2e4, 2e4);
        ring.addPath(this.#spreadShape(node, shape, width, height, -s.spread));
        ctx.fillStyle = "#000";
        ctx.fill(ring, "evenodd");
      }
      ctx.restore();
    }
  }

  /**
   * The shape grown (or shrunk, for negative spread) by `spread` on every
   * side. Exact for rectangles, frames and ellipses; other shapes keep their
   * outline, as Figma does for spread on vectors.
   */
  #spreadShape(node: NodeRecord, shape: Path2D, w: number, h: number, spread: number): Path2D {
    if (spread === 0) return shape;
    const path = new Path2D();
    const gw = Math.max(0, w + spread * 2);
    const gh = Math.max(0, h + spread * 2);
    if (node.type === "ellipse") {
      path.ellipse(w / 2, h / 2, gw / 2, gh / 2, 0, 0, Math.PI * 2);
      return path;
    }
    if (node.type === "rect" || node.type === "frame") {
      const radii = getProp(node.props, "cornerRadii");
      const r = getProp(node.props, "cornerRadius");
      const max = Math.min(w, h) / 2;
      const grow = (v: number) => (v > 0 ? Math.max(0, Math.min(v, max) + spread) : 0);
      const corners = radii ? radii.map(grow) : grow(r);
      path.roundRect(-spread, -spread, gw, gh, corners);
      return path;
    }
    return shape;
  }

  /** Background blur: what is already drawn behind the layer, blurred inside its shape. */
  #backgroundBlur(ctx: Ctx, node: NodeRecord, shape: Path2D, scale: number): void {
    const blur = getProp(node.props, "effects").find(
      (e) => e.type === "background-blur" && e.visible !== false,
    );
    if (blur?.type !== "background-blur" || blur.radius <= 0) return;
    if (this.#fresh && !this.#fresh.has(node.id)) return;
    // As in Figma, it shows where the layer paints: a layer with nothing visible blurs nothing.
    if (!paintsSomething(node)) return;
    const sigma = blurSigma(blur.radius) * scale;
    // The layer's box on the device, and as far around it as the blur reads.
    const t = ctx.getTransform();
    const w = getProp(node.props, "width");
    const h = getProp(node.props, "height");
    const xs = [t.e, t.a * w + t.e, t.c * h + t.e, t.a * w + t.c * h + t.e];
    const ys = [t.f, t.b * w + t.f, t.d * h + t.f, t.b * w + t.d * h + t.f];
    const reach = Math.ceil(sigma * 3) + 1;
    const { width, height } = ctx.canvas;
    const x0 = Math.max(-reach, Math.floor(Math.min(...xs)) - reach);
    const y0 = Math.max(-reach, Math.floor(Math.min(...ys)) - reach);
    const x1 = Math.min(width + reach, Math.ceil(Math.max(...xs)) + reach);
    const y1 = Math.min(height + reach, Math.ceil(Math.max(...ys)) + reach);
    if (x1 <= Math.max(0, x0) || y1 <= Math.max(0, y0) || x0 >= width || y0 >= height) return;
    // What's behind, its edge pixels repeated past the canvas's so the blur doesn't fade there.
    this.#blurBackdrop = scratch(this.#blurBackdrop, x1 - x0, y1 - y0);
    const behind = this.#blurBackdrop?.getContext("2d") as Ctx | null | undefined;
    if (!this.#blurBackdrop || !behind) return;
    copyExtended(ctx.canvas, behind, x0, y0, x1 - x0, y1 - y0);
    ctx.save();
    ctx.clip(shape);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.filter = `blur(${sigma}px)`;
    ctx.drawImage(this.#blurBackdrop, x0, y0);
    ctx.restore();
  }

  /**
   * Glass (decision 0007): the backdrop through a curved rim, under the
   * layer's fills. On text, as in Figma, each glyph is a lens of its own.
   */
  #glassEffect(ctx: Ctx, node: NodeRecord, shape: Path2D, w: number, h: number, scale: number) {
    const glass = getProp(node.props, "effects").find(
      (e) => e.type === "glass" && e.visible !== false,
    );
    if (glass?.type !== "glass") return;
    if (this.#fresh && !this.#fresh.has(node.id)) return;
    const key = ctx === this.#screen ? { id: node.id, generation: this.#generation } : null;
    const outline =
      node.type === "text" ? (mask: Ctx) => this.#text(mask, node, w, "#ffffff", scale) : shape;
    // As in Figma, the rim is no deeper than the shape is thick.
    const inradius =
      node.type === "rect" || node.type === "frame" || node.type === "ellipse"
        ? Math.min(w, h) / 2
        : this.#inradii.get(node.props, w, h, (c) => {
            if (node.type === "text") this.#text(c, node, w, "#ffffff");
            else c.fill(shape);
          });
    // A box's rim is measured from its exact edge: square corners stay square.
    const box = node.type === "rect" || node.type === "frame";
    const r = box ? getProp(node.props, "cornerRadius") : 0;
    const corners = box ? (getProp(node.props, "cornerRadii") ?? [r, r, r, r]) : null;
    this.#glass.paint(ctx, outline, w, h, glass, scale, { key, inradius, corners });
  }

  /** Text too small to read: a bar per line, the last one shorter, in the text's colour. */
  #greek(ctx: Ctx, node: NodeRecord, width: number, override?: string): void {
    const props = node.props;
    const size = getProp(props, "fontSize");
    const lh = lineHeightPx(props, this.#measurer);
    const height = getProp(props, "height");
    const lines = Math.max(1, Math.round(height / Math.max(1, lh)));
    const fills = getProp(props, "fills");
    const paint = override ? null : ([...fills].reverse().find((f) => f.visible !== false) ?? null);
    const style = override ?? (paint ? this.#paintStyle(ctx, paint, width, height) : "#000000");
    if (!style) return;
    const alpha = ctx.globalAlpha;
    ctx.globalAlpha = alpha * 0.55;
    ctx.fillStyle = style;
    const align = getProp(props, "textAlign");
    for (let i = 0; i < lines; i++) {
      const w = lines > 1 && i === lines - 1 ? width * 0.6 : width;
      const x = align === "center" ? (width - w) / 2 : align === "right" ? width - w : 0;
      ctx.fillRect(x, i * lh + (lh - size) / 2 + size * 0.18, w, size * 0.5);
    }
    ctx.globalAlpha = alpha;
  }

  /**
   * A text layer's strokes, around its glyphs (like Figma), not its box.
   * Centred strokes are drawn on the glyphs directly. Inside and outside
   * strokes are drawn twice as wide on a scratch canvas, which then keeps
   * only the half inside (or outside) the glyphs, and is laid on the canvas
   * with the layer's opacity and blending: a canvas can't clip to text.
   */
  #textStrokes(ctx: Ctx, node: NodeRecord, width: number, scale: number): void {
    const strokes = getProp(node.props, "strokes").filter((s) => s.visible !== false);
    const weight = getProp(node.props, "strokeWeight");
    if (strokes.length === 0 || weight <= 0) return;
    // Too small to read is drawn as bars, which have no glyphs to outline.
    if (this.#detail && largestFontSize(node) * scale < GREEK_BELOW) return;
    const mode = getProp(node.props, "textAutoResize");
    const layout = layoutText(node, this.#measurer, mode === "width" ? null : width, {
      whole: node.id === this.whole,
    });
    const height = getProp(node.props, "height");
    const dy = textBlockOffset(node, layout);
    const align = getProp(node.props, "strokeAlign");
    const dashes = getProp(node.props, "strokeDashes");
    const join = getProp(node.props, "strokeJoin");
    const spaced = "letterSpacing" in ctx;

    /** Each glyph run, where #text draws it: `paint` strokes or fills it. */
    const eachRun = (c: Ctx, paint: (frag: TextFragment, x: number, y: number) => void) => {
      for (const line of layout.lines) {
        const x0 = lineOffset(line, width, node.props);
        for (const frag of line.fragments) {
          if (!frag.text) continue;
          c.font = frag.font;
          c.fontKerning = "normal";
          if (spaced)
            (c as Ctx & { letterSpacing: string }).letterSpacing = `${frag.letterSpacing}px`;
          paint(frag, x0 + frag.x, line.baseline + dy);
        }
      }
    };
    const outline = (frag: TextFragment, x: number, y: number) => {
      const shaped = frag.run ? (this.#measurer.shape?.(frag.text, frag.run) ?? null) : null;
      return shaped
        ? this.#placed(this.#shapedOutline(shaped, frag.text, frag.letterSpacing), x, y)
        : null;
    };
    const strokeGlyphs = (c: Ctx, lineWidth: number) => {
      c.save();
      c.filter = "none";
      c.textBaseline = "alphabetic";
      c.lineWidth = lineWidth;
      c.lineJoin = join;
      if (dashes.length > 0) c.setLineDash(dashes);
      for (const paint of strokes) {
        const style = this.#paintStyle(c, paint, width, height);
        if (!style) continue;
        c.strokeStyle = style;
        eachRun(c, (frag, x, y) => {
          const path = outline(frag, x, y);
          if (path) c.stroke(path);
          else c.strokeText(frag.text, x, y);
        });
      }
      c.restore();
    };

    if (align === "center") {
      strokeGlyphs(ctx, weight);
      return;
    }
    // The text's reach on the device, its strokes and overhanging glyphs included,
    // within what the canvas shows.
    const t = ctx.getTransform();
    const grow = weight * 2 + largestFontSize(node) * 0.5;
    const box = {
      x: -grow,
      y: Math.min(0, dy) - grow,
      w: width + grow * 2,
      h: Math.max(height, layout.height + dy) + grow * 2,
    };
    const xs: number[] = [];
    const ys: number[] = [];
    for (const [px, py] of [
      [box.x, box.y],
      [box.x + box.w, box.y],
      [box.x, box.y + box.h],
      [box.x + box.w, box.y + box.h],
    ] as const) {
      xs.push(t.a * px + t.c * py + t.e);
      ys.push(t.b * px + t.d * py + t.f);
    }
    const x0 = Math.max(0, Math.floor(Math.min(...xs)));
    const y0 = Math.max(0, Math.floor(Math.min(...ys)));
    const x1 = Math.min(ctx.canvas.width, Math.ceil(Math.max(...xs)));
    const y1 = Math.min(ctx.canvas.height, Math.ceil(Math.max(...ys)));
    const w = x1 - x0;
    const h = y1 - y0;
    if (w <= 0 || h <= 0) return;
    if (!this.#strokeCanvas) {
      if (typeof OffscreenCanvas !== "undefined") this.#strokeCanvas = new OffscreenCanvas(w, h);
      else if (typeof document !== "undefined")
        this.#strokeCanvas = document.createElement("canvas");
      else return;
    }
    const scratch = this.#strokeCanvas;
    if (scratch.width < w) scratch.width = w;
    if (scratch.height < h) scratch.height = h;
    const s = scratch.getContext("2d") as Ctx | null;
    if (!s) return;
    s.setTransform(1, 0, 0, 1, 0, 0);
    s.globalAlpha = 1;
    s.globalCompositeOperation = "source-over";
    s.clearRect(0, 0, w, h);
    s.setTransform(t.a, t.b, t.c, t.d, t.e - x0, t.f - y0);
    strokeGlyphs(s, weight * 2);
    // Keep the half inside the glyphs, or the half outside them.
    s.globalCompositeOperation = align === "inside" ? "destination-in" : "destination-out";
    s.fillStyle = "#000";
    eachRun(s, (frag, x, y) => {
      const path = outline(frag, x, y);
      if (path) s.fill(path);
      else s.fillText(frag.text, x, y);
    });
    s.globalCompositeOperation = "source-over";
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.filter = "none";
    ctx.drawImage(scratch, 0, 0, w, h, x0, y0, w, h);
    ctx.restore();
  }

  /**
   * An outline moved to (x, y) in the text box's space. Filled there rather
   * than under a translated transform, so gradient and image fills stay
   * where the text box puts them.
   */
  #placed(outline: Path2D, x: number, y: number): Path2D {
    const hit = this.#placedRuns.get(outline);
    if (hit && hit.x === x && hit.y === y) return hit.path;
    const path = new Path2D();
    path.addPath(outline, new DOMMatrix([1, 0, 0, 1, x, y]));
    this.#placedRuns.set(outline, { x, y, path });
    return path;
  }

  /**
   * A shaped run's glyphs as one outline, from its start on the baseline, in
   * px (y down), with `spacing` after each character like the canvas's
   * letterSpacing. Kept per run, so a frame only places it.
   */
  #shapedOutline(shaped: ShapedText, text: string, spacing: number): Path2D {
    let bySpacing = this.#shapedRuns.get(shaped);
    if (!bySpacing) {
      bySpacing = new Map();
      this.#shapedRuns.set(shaped, bySpacing);
    }
    const cached = bySpacing.get(spacing);
    if (cached) return cached;
    // Characters (code points) before each UTF-16 index: letter spacing follows each one.
    const before = new Uint32Array(text.length + 1);
    for (let i = 0, n = 0; i < text.length; i++) {
      before[i] = n;
      if (!isLowSurrogate(text.charCodeAt(i))) n++;
      before[i + 1] = n;
    }
    const s = shaped.scale;
    const outline = new Path2D();
    for (const g of shaped.glyphs) {
      if (!g.path) continue;
      const shift = spacing * (before[g.cluster] ?? 0);
      outline.addPath(g.path, new DOMMatrix([s, 0, 0, -s, g.x + shift, -g.y]));
    }
    bySpacing.set(spacing, outline);
    return outline;
  }

  /**
   * Draws a text layer's glyphs, fragment by fragment (rich text mixes fonts,
   * sizes and fills in a line), in each one's fills or the layer's, or all in
   * `override` (shadows).
   */
  #text(
    ctx: Ctx,
    node: NodeRecord,
    width: number,
    override?: string,
    /** Device pixels per unit: text too small to read is drawn as lines ("greeking"). */
    scale = Number.POSITIVE_INFINITY,
  ): void {
    // Unreadable at this zoom: bars where the lines are, from the box alone, without
    // laying the text out (which is most of what drawing a small text costs).
    if (this.#detail && largestFontSize(node) * scale < GREEK_BELOW) {
      this.#greek(ctx, node, width, override);
      return;
    }
    const mode = getProp(node.props, "textAutoResize");
    const layout = layoutText(node, this.#measurer, mode === "width" ? null : width, {
      whole: node.id === this.whole,
    });
    const height = getProp(node.props, "height");
    const dy = textBlockOffset(node, layout);
    ctx.textBaseline = "alphabetic";
    const spaced = "letterSpacing" in ctx;
    const layerFills = getProp(node.props, "fills");
    const black: Paint[] = [{ type: "solid", color: "#000000" }];
    // Gradients and images span the whole text box, so work them out once each.
    const styles = new Map<Paint, string | CanvasGradient | CanvasPattern | null>();
    const styleOf = (paint: Paint) => {
      if (!styles.has(paint)) styles.set(paint, this.#paintStyle(ctx, paint, width, height));
      return styles.get(paint) ?? null;
    };
    for (const line of layout.lines) {
      const x0 = lineOffset(line, width, node.props);
      const baseline = line.baseline + dy;
      for (const frag of line.fragments) {
        ctx.font = frag.font;
        ctx.fontKerning = "normal";
        if (spaced)
          (ctx as Ctx & { letterSpacing: string }).letterSpacing = `${frag.letterSpacing}px`;
        const paints = override
          ? black
          : (frag.fills ?? (layerFills.length > 0 ? layerFills : black));
        for (const paint of paints) {
          if (paint.visible === false) continue;
          const style = override ?? styleOf(paint);
          if (!style) continue;
          ctx.fillStyle = style;
          const x = x0 + frag.x;
          if (this.#detail && frag.fontSize * scale < GREEK_BELOW) {
            // A small run in readable text.
            // Unreadable at this zoom: a bar where the glyphs are, far cheaper to draw.
            const alpha = ctx.globalAlpha;
            ctx.globalAlpha = alpha * 0.55;
            ctx.fillRect(x, baseline - frag.fontSize * 0.62, frag.width, frag.fontSize * 0.5);
            ctx.globalAlpha = alpha;
            continue;
          }
          // OpenType features: the shaped glyphs, when the shaper has them (else as the canvas sets it).
          const shaped = frag.run ? (this.#measurer.shape?.(frag.text, frag.run) ?? null) : null;
          if (shaped)
            ctx.fill(
              this.#placed(this.#shapedOutline(shaped, frag.text, frag.letterSpacing), x, baseline),
            );
          else ctx.fillText(frag.text, x, baseline);
          if (frag.decoration !== "none") {
            const size = frag.fontSize;
            const y =
              frag.decoration === "underline" ? baseline + size * 0.1 : baseline - size * 0.3;
            ctx.fillRect(x, y, frag.width, Math.max(1, size / 16));
          }
        }
      }
    }
  }
}

const isLowSurrogate = (c: number) => c >= 0xdc00 && c <= 0xdfff;
