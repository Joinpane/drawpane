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
import type { Rect } from "./geometry";
import { ImageCache, imagePlacement } from "./images";
import { markerLength, markersOf, trimmedStroke } from "./markers";
import type { Scene } from "./scene";
import { layoutText, type TextMeasurer } from "./text";
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

export interface RenderStats {
  drawn: number;
  culled: number;
  ms: number;
}

function hexToRgba(hex: string, opacity = 1): string {
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

export class CanvasRenderer {
  readonly #scene: Scene;
  readonly #measurer: TextMeasurer;
  readonly #paths = new Map<string, { d: string; path: Path2D }>();
  /** Nodes not to draw (e.g. text being edited in a DOM overlay). */
  hidden = new Set<string>();
  /** Page background when the page doesn't set one: the theme's `canvas` token. */
  canvasColor = "#ebeae6";
  stats: RenderStats = { drawn: 0, culled: 0, ms: 0 };
  /**
   * Decoded images. Subscribe to repaint when one arrives:
   * `renderer.images.subscribe(() => requestRepaint())`.
   */
  readonly images: ImageCache;
  readonly #placeholders = new WeakMap<Ctx, CanvasPattern>();

  constructor(scene: Scene, measurer: TextMeasurer, options: CanvasRendererOptions = {}) {
    this.#scene = scene;
    this.#measurer = measurer;
    this.images = options.images ?? new ImageCache();
  }

  render(
    ctx: Ctx,
    pageId: string,
    camera: Camera,
    viewport: { width: number; height: number },
    dpr: number,
  ): void {
    const start = performance.now();
    this.stats = { drawn: 0, culled: 0, ms: 0 };
    this.images.frame();
    const page = this.#scene.doc.get(pageId);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    if (!page) return;
    ctx.fillStyle = getProp(page.props, "backgroundColor") ?? this.canvasColor;
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    const visible = camera.visibleRect(viewport);
    for (const id of this.#scene.doc.childIds(pageId)) this.#draw(ctx, id, camera, dpr, visible);
    this.stats.ms = performance.now() - start;
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
  ): void {
    this.images.frame();
    this.stats = { drawn: 0, culled: 0, ms: 0 };
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    if (background) {
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    }
    const camera = new Camera(-rect.x * scale, -rect.y * scale, scale);
    const hidden = this.hidden;
    this.hidden = new Set();
    try {
      for (const id of ids) this.#draw(ctx, id, camera, 1, rect);
    } finally {
      this.hidden = hidden;
    }
  }

  #draw(ctx: Ctx, id: string, camera: Camera, dpr: number, visible: Rect): void {
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
    this.stats.drawn++;
    const opacity = getProp(node.props, "opacity");
    const blend = BLEND[getProp(node.props, "blendMode")] ?? "source-over";

    if (node.type === "group") {
      ctx.save();
      ctx.globalAlpha *= opacity;
      ctx.globalCompositeOperation = blend;
      for (const child of this.#scene.doc.childIds(id))
        this.#draw(ctx, child, camera, dpr, visible);
      ctx.restore();
      return;
    }

    const m = this.#scene.worldMatrix(id);
    const z = camera.zoom * dpr;
    ctx.save();
    ctx.setTransform(
      m[0] * z,
      m[1] * z,
      m[2] * z,
      m[3] * z,
      (m[4] * camera.zoom + camera.x) * dpr,
      (m[5] * camera.zoom + camera.y) * dpr,
    );
    ctx.globalAlpha *= opacity;
    ctx.globalCompositeOperation = blend;
    const blur = getProp(node.props, "effects").find(
      (e) => e.type === "layer-blur" && e.visible !== false,
    );
    if (blur && blur.type === "layer-blur" && blur.radius > 0)
      ctx.filter = `blur(${blur.radius * camera.zoom * dpr}px)`;

    const width = getProp(node.props, "width");
    const height = getProp(node.props, "height");
    const shape = this.#shapePath(node, width, height);

    this.#shadows(ctx, node, shape, "drop-shadow", camera.zoom * dpr);
    this.#backgroundBlur(ctx, node, shape, camera.zoom * dpr);
    if (node.type === "text") this.#text(ctx, node, width);
    else
      for (const paint of getProp(node.props, "fills"))
        this.#fill(ctx, shape, paint, width, height, node);
    this.#shadows(ctx, node, shape, "inner-shadow", camera.zoom * dpr);

    if (node.type === "frame") {
      const children = this.#scene.doc.childIds(id);
      if (children.length > 0) {
        ctx.save();
        if (getProp(node.props, "clipContent")) ctx.clip(shape);
        ctx.filter = "none";
        for (const child of children) this.#draw(ctx, child, camera, dpr, visible);
        ctx.restore();
      }
    }
    this.#strokes(ctx, node, shape, width, height);
    ctx.restore();
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
    ctx.save();
    if (paint.blendMode) ctx.globalCompositeOperation = BLEND[paint.blendMode] ?? "source-over";
    ctx.fillStyle = style;
    ctx.fill(shape, node.type === "path" ? getProp(node.props, "windingRule") : "nonzero");
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
      ? imagePlacement(paint.scaleMode, { width: w, height: h }, natural)
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
        if (node.type === "text") this.#text(ctx, node, width, "#000");
        else {
          ctx.fillStyle = "#000";
          ctx.fill(this.#spreadShape(node, shape, width, height, s.spread));
        }
      } else {
        ctx.clip(shape);
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

  /** Draws a text layer's glyphs in its own fills, or all in `override` (shadows). */
  #text(ctx: Ctx, node: NodeRecord, width: number, override?: string): void {
    const mode = getProp(node.props, "textAutoResize");
    const layout = layoutText(node, this.#measurer, mode === "width" ? null : width);
    const align = getProp(node.props, "textAlign");
    const height = getProp(node.props, "height");
    const vAlign = getProp(node.props, "textAlignVertical");
    const dy =
      vAlign === "middle"
        ? (height - layout.height) / 2
        : vAlign === "bottom"
          ? height - layout.height
          : 0;
    ctx.font = layout.font;
    ctx.textBaseline = "alphabetic";
    if ("letterSpacing" in ctx)
      (ctx as Ctx & { letterSpacing: string }).letterSpacing = `${layout.letterSpacing}px`;
    const decoration = getProp(node.props, "textDecoration");
    const fills = getProp(node.props, "fills");
    const paints = override
      ? [{ type: "solid", color: "#000000" } as Paint]
      : fills.length > 0
        ? fills
        : [{ type: "solid", color: "#000000" } as Paint];
    for (const paint of paints) {
      const style = override ?? this.#paintStyle(ctx, paint, width, height);
      if (!style || paint.visible === false) continue;
      ctx.fillStyle = style;
      for (const line of layout.lines) {
        const x =
          align === "center"
            ? (width - line.width) / 2
            : align === "right"
              ? width - line.width
              : 0;
        ctx.fillText(line.text, x, line.baseline + dy);
        if (decoration !== "none") {
          const size = getProp(node.props, "fontSize");
          const y =
            decoration === "underline"
              ? line.baseline + dy + size * 0.1
              : line.baseline + dy - size * 0.3;
          ctx.fillRect(x, y, line.width, Math.max(1, size / 16));
        }
      }
    }
  }
}
