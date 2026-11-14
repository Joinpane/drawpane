/**
 * Canvas renderer for page content.
 *
 * It draws only what intersects the viewport, in document order, with each
 * node's world matrix. It knows nothing about selection or tools; the overlay
 * draws those on a separate canvas so hover and drag feedback never repaint
 * the design.
 */

import { type Effect, getProp, type NodeRecord, type Paint } from "@drawpane/model";
import { Camera } from "./camera";
import { exportBounds } from "./export";
import type { Rect } from "./geometry";
import { GlassPainter } from "./glass";
import { ImageCache, imagePlacement } from "./images";
import { markerLength, markersOf, trimmedStroke } from "./markers";
import { hasMask, maskScopes } from "./masks";
import type { Scene } from "./scene";
import {
  layoutText,
  lineHeightPx,
  lineOffset,
  type ShapedText,
  type TextFragment,
  type TextMeasurer,
  textBlockOffset,
} from "./text";
import { isClosedPath } from "./vector/cache";
import { nodePath } from "./vector/shapes";
import { serializePath } from "./vector/svg";

/** On screen it's a canvas element; exports and thumbnails draw into an OffscreenCanvas. */
type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
type ImagePaint = Extract<Paint, { type: "image" }>;

export interface CanvasRendererOptions {
  /** Shared decoded images. Pass the same cache to every renderer of one file. */
  readonly images?: ImageCache;
}

/** Two neutral greys in device pixels, the same in both themes: an image that is still loading. */
const PLACEHOLDER = { light: "#ececea", dark: "#dfdfdc", cell: 8 };

/** The most pixels a blurred layer's own canvas may have; larger layers are drawn into it smaller. */
const BLUR_MAX_PIXELS = 6_000_000;

/** A layer's layer-blur radius, or 0. */
function layerBlurRadius(node: NodeRecord): number {
  let radius = 0;
  for (const e of getProp(node.props, "effects"))
    if (e.type === "layer-blur" && e.visible !== false) radius = Math.max(radius, e.radius);
  return radius;
}

const isBackgroundBlur = (e: Effect) => e.type === "background-blur" && e.visible !== false;

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
  /** Shaped text as one outline at its origin, by letter spacing (see #shapedOutline). */
  readonly #shapedRuns = new WeakMap<ShapedText, Map<number, Path2D>>();
  /** Each outline where it was last placed: text that holds still costs nothing per frame. */
  readonly #placedRuns = new WeakMap<Path2D, { x: number; y: number; path: Path2D }>();
  /** What the last screen frame showed, to move it on a pan instead of redrawing. */
  #last: LastFrame | null = null;
  /** The last frame drew every layer (not a scaled stand-in). */
  #lastExact = false;
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
  /** Layers being drawn into their own canvas for a layer blur (see #drawBlurred). */
  readonly #isolated = new Set<string>();
  /** Those canvases, one per nesting depth of blurred layers. */
  readonly #blurCanvases: Array<OffscreenCanvas | HTMLCanvasElement> = [];
  /** Draws glass effects, with its own canvases and (made on first use) WebGL context. */
  readonly #glass = new GlassPainter();
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
    if (!exact && this.#preview(ctx, frame)) {
      this.stats.ms = performance.now() - start;
      return false;
    }
    const reused = this.#reuse(ctx, frame, snapped, dpr);
    this.#last = frame;
    this.#lastExact = true;
    if (!reused) {
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
      this.#drawChildren(ctx, pageId, snapped, dpr, snapped.visibleRect(viewport));
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
    for (const [x, y, w, h] of strips) {
      resetState(ctx);
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, w, h);
      ctx.clip();
      ctx.fillStyle = frame.background;
      ctx.fillRect(x, y, w, h);
      // The strip in page coordinates: only layers touching it are drawn.
      const visible = {
        x: (x / dpr - camera.x) / camera.zoom,
        y: (y / dpr - camera.y) / camera.zoom,
        width: w / dpr / camera.zoom,
        height: h / dpr / camera.zoom,
      };
      this.#drawChildren(ctx, frame.pageId, camera, dpr, visible);
      ctx.restore();
    }
    return true;
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
      bounds.y + bounds.height + pad < visible.y
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
    // Drawn into its own canvas for a layer blur: its opacity and blending apply when that's composited.
    const isolated = this.#isolated.has(id);
    const opacity = alpha * (isolated ? 1 : getProp(node.props, "opacity"));
    if (opacity <= 0) return;
    const own = isolated
      ? "source-over"
      : (BLEND[getProp(node.props, "blendMode")] ?? "source-over");
    // A group's blending carries to its layers unless they blend their own way.
    const blend = own === "source-over" ? inheritedBlend : own;

    const blurRadius = isolated ? 0 : layerBlurRadius(node);
    if (blurRadius > 0) {
      this.#drawBlurred(ctx, node, camera, dpr, visible, opacity, blend, blurRadius);
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
    // Isolated for a layer blur, there's nothing behind it here: its background blur was drawn already.
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
   * A layer blur blurs the whole layer, as in Figma: its fills, strokes and
   * shadows, and a frame's children, as one picture. So the layer is drawn
   * plainly into a canvas of its own, covering what it paints (where that's
   * on screen) plus the blur's reach, and that is composited blurred, with
   * the layer's opacity and blending. A large layer is drawn there at a lower
   * resolution, which the blur hides, so memory stays bounded.
   */
  #drawBlurred(
    ctx: Ctx,
    node: NodeRecord,
    camera: Camera,
    dpr: number,
    visible: Rect,
    opacity: number,
    blend: GlobalCompositeOperation,
    radius: number,
  ): void {
    const id = node.id;
    const blurPx = radius * camera.zoom * dpr;
    // Background blur reads what's already drawn behind the layer: here, before the layer goes on.
    if (node.type !== "group" && getProp(node.props, "effects").some(isBackgroundBlur)) {
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
        node,
        getProp(node.props, "width"),
        getProp(node.props, "height"),
      );
      this.#backgroundBlur(ctx, node, shape, z);
    }
    const region = exportBounds(this.#scene, [id]);
    if (!region) return;
    // In device pixels: what it paints, kept to the canvas plus the blur's reach past it.
    const margin = blurPx * 3;
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
    const scale = Math.min(1, Math.sqrt(BLUR_MAX_PIXELS / ((x1 - x0) * (y1 - y0))));
    const w = Math.max(1, Math.ceil((x1 - x0) * scale));
    const h = Math.max(1, Math.ceil((y1 - y0) * scale));
    const layer = this.#blurCanvas(this.#isolated.size, w, h);
    const lctx = layer?.getContext("2d") as Ctx | null | undefined;
    if (!layer || !lctx) return;
    resetState(lctx);
    lctx.clearRect(0, 0, layer.width, layer.height);
    // The same camera, moved so the region's corner is the canvas's, at the reduced resolution.
    const shifted = new Camera(camera.x - x0 / dpr, camera.y - y0 / dpr, camera.zoom);
    this.#isolated.add(id);
    try {
      this.#draw(lctx, id, shifted, dpr * scale, visible, 1, "source-over");
    } finally {
      this.#isolated.delete(id);
    }
    resetState(ctx);
    ctx.globalAlpha = opacity;
    ctx.globalCompositeOperation = blend;
    ctx.filter = `blur(${blurPx}px)`;
    ctx.drawImage(layer, 0, 0, w, h, x0, y0, w / scale, h / scale);
    resetState(ctx);
  }

  /** A canvas for drawing a blurred layer by itself: one per nesting depth, kept and grown. */
  #blurCanvas(depth: number, w: number, h: number): OffscreenCanvas | HTMLCanvasElement | null {
    let canvas = this.#blurCanvases[depth];
    if (!canvas) {
      if (typeof OffscreenCanvas !== "undefined") canvas = new OffscreenCanvas(w, h);
      else if (typeof document !== "undefined") canvas = document.createElement("canvas");
      else return null;
      this.#blurCanvases[depth] = canvas;
    }
    if (canvas.width < w) canvas.width = w;
    if (canvas.height < h) canvas.height = h;
    return canvas;
  }

  /**
   * Draws a parent's children bottom first. A mask isn't drawn: its outline
   * clips the children above it, up to the next mask.
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
    for (const { id, isMask } of maskScopes(doc, parentId)) {
      if (!isMask) {
        this.#draw(ctx, id, camera, dpr, visible, alpha, blend);
        continue;
      }
      const mask = doc.get(id) as NodeRecord;
      if (clipping) ctx.restore();
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
    if (clipping) ctx.restore();
  }

  #effectReach(node: NodeRecord): number {
    let reach = 0;
    for (const e of getProp(node.props, "effects")) {
      if (e.visible === false) continue;
      if (e.type === "drop-shadow")
        reach = Math.max(reach, Math.abs(e.x) + Math.abs(e.y) + e.blur * 2 + Math.max(0, e.spread));
      if (e.type === "layer-blur") reach = Math.max(reach, e.radius * 2);
    }
    if (
      (node.type === "line" || node.type === "path") &&
      (getProp(node.props, "markerStart") !== "none" || getProp(node.props, "markerEnd") !== "none")
    )
      reach = Math.max(reach, markerLength(getProp(node.props, "strokeWeight")));
    return reach;
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

  #paintStyle(ctx: Ctx, paint: Paint, w: number, h: number): string | CanvasGradient | null {
    if (paint.type === "solid") return hexToRgba(paint.color, paint.opacity ?? 1);
    if (paint.type === "linear" || paint.type === "radial" || paint.type === "angular") {
      const fx = paint.from.x * w;
      const fy = paint.from.y * h;
      const tx = paint.to.x * w;
      const ty = paint.to.y * h;
      const gradient =
        paint.type === "linear"
          ? ctx.createLinearGradient(fx, fy, tx, ty)
          : paint.type === "radial"
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
    const style = this.#paintStyle(ctx, paint, w, h);
    if (!style) return;
    const rule = node.type === "path" ? getProp(node.props, "windingRule") : "nonzero";
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
    const weight = getProp(node.props, "strokeWeight");
    if (strokes.length === 0 || weight <= 0) return;
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
    for (const paint of strokes) {
      const style = this.#paintStyle(ctx, paint, w, h);
      if (!style) continue;
      ctx.strokeStyle = style;
      ctx.stroke(line);
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
    ctx.save();
    ctx.clip(shape);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.filter = `blur(${blur.radius * scale}px)`;
    ctx.drawImage(ctx.canvas, 0, 0);
    ctx.restore();
  }

  /** Glass (decision 0007): the backdrop through a curved rim, under the layer's fills. */
  #glassEffect(ctx: Ctx, node: NodeRecord, shape: Path2D, w: number, h: number, scale: number) {
    const glass = getProp(node.props, "effects").find(
      (e) => e.type === "glass" && e.visible !== false,
    );
    if (glass?.type !== "glass") return;
    this.#glass.paint(ctx, shape, w, h, glass, scale);
  }

  /** Text too small to read: a bar per line, the last one shorter, in the text's colour. */
  #greek(ctx: Ctx, node: NodeRecord, width: number, override?: string): void {
    const props = node.props;
    const size = getProp(props, "fontSize");
    const lh = lineHeightPx(props);
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
