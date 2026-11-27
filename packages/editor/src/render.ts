/**
 * Canvas renderer for page content.
 *
 * It draws only what intersects the viewport, in document order, with each
 * node's world matrix, finding what's near through the scene's index. It
 * knows nothing about selection or tools; the overlay draws those on a
 * separate canvas so hover and drag feedback never repaint the design.
 *
 * On screen it redraws as little as it can (decision 0028): a pan moves the
 * last frame and draws the strips it uncovered, an edit draws where the
 * changed layers were and are, and a frame that would take longer than the
 * caller's budget shows a stand-in and is drawn a tile at a time over the
 * next frames, until it's exact.
 */

import { type BlendMode, getProp, type NodeRecord, type Paint } from "@drawpane/model";
import { Camera } from "./camera";
import { layerCorners, spreadRadii } from "./corners";
import { boxPath2D } from "./corners-canvas";
import { boxOutline, ellipseOutline, fitDashes, type OutlineSegment } from "./dashes";
import { collectExportImageUses, exportBounds } from "./export";
import { apply, invert, type Matrix, type Rect, rectsIntersect } from "./geometry";
import { GlassPainter, glassParams } from "./glass";
import {
  boxInGradientSpace,
  type GradientPaint,
  gradientMatrix,
  linearInPixels,
} from "./gradients";
import { ImageCache, imageDrawnSize, imagePlacement } from "./images";
import { Inradii } from "./inradius";
import { BlendApart, type DeviceBox, deviceBox } from "./linear-blend";
import { LuminanceMask, opaqueAlpha } from "./luminance";
import { markersOf, trimmedStroke } from "./markers";
import { clipsByShape, maskScopes } from "./masks";
import { NoiseTiles, paintNoise } from "./noise";
import { blurSigma, type PostEffect, postEffects, postMargin } from "./post-effects";
import { effectReach } from "./reach";
import {
  glyphTable,
  type SavedGlyphGroup,
  type SavedText,
  savedGlyphGroups,
  savedText,
} from "./saved-glyphs";
import type { Scene } from "./scene";
import { dropShadowCast } from "./shadows";
import { isUniform, strokeRegion, strokeRegionPath, strokeWidths } from "./stroke-sides";
import {
  decorationBar,
  drawnBaseline,
  layoutText,
  lineHeightPx,
  lineOffset,
  type ShapedText,
  type TextFragment,
  type TextMeasurer,
  textBlockOffset,
} from "./text";
import { TexturePainter } from "./texture";
import { coverRects, TileWork } from "./tiles";
import { isClosedPath } from "./vector/cache";
import { nodePath } from "./vector/shapes";
import { serializePath } from "./vector/svg";
import { type AnyCanvas, type Bounds, copyExtended, scratch } from "./webgl";

/** The most pixels a side of a stroke's or text's radial or angular gradient is drawn at. */
const PATTERN_MAX_SIDE = 2048;

/**
 * Sets a context to draw a design's text as it was laid out: kerned, as Figma sets type, and at
 * the font's own advances. Where the platform rounds each glyph's advance to whole pixels at the
 * size drawn (Linux, without subpixel positioning), default rendering drew a run wider or narrower
 * than layout measured it (at 1000 px, scaled, as Figma does), so styled runs collided ("Three
 * thingson") or gapped; geometric precision keeps the advances exact. Browsers without the setting
 * position glyphs to fractions of a pixel anyway.
 */
function typeset(c: Ctx, font: string): void {
  c.font = font;
  c.fontKerning = "normal";
  if ("textRendering" in c)
    (c as Ctx & { textRendering: string }).textRendering = "geometricPrecision";
}

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
    const { radii, smoothing } = layerCorners(node);
    outline = boxOutline(w, h, radii, smoothing);
  } else return null;
  const pattern = getProp(node.props, "strokeDashes");
  return outline.map((piece) => {
    const path = new Path2D();
    if (piece.kind === "line") {
      path.moveTo(piece.x0, piece.y0);
      path.lineTo(piece.x1, piece.y1);
    } else if (piece.kind === "cubic") {
      const c = piece.pts;
      path.moveTo(c[0] as number, c[1] as number);
      for (let i = 2; i < c.length; i += 6)
        path.bezierCurveTo(
          c[i] as number,
          c[i + 1] as number,
          c[i + 2] as number,
          c[i + 3] as number,
          c[i + 4] as number,
          c[i + 5] as number,
        );
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
export function fadesAsOne(node: NodeRecord, children: number): boolean {
  if (getProp(node.props, "opacity") >= 1) return false;
  if (children > 0) return true;
  const shadows = getProp(node.props, "effects").some(
    (e) => e.visible !== false && (e.type === "drop-shadow" || e.type === "inner-shadow"),
  );
  const fills = getProp(node.props, "fills").filter((p) => p.visible !== false).length;
  const strokes = getProp(node.props, "strokes").filter((p) => p.visible !== false).length;
  return shadows || fills + strokes > 1;
}

/**
 * Whether a layer blending by linear dodge or burn must be drawn as one
 * picture and blended as a whole, as Figma blends it: always for burn (the
 * canvas has no burn to give each part), and for dodge when its parts
 * overlap (they'd be added to each other too) or the canvas may be
 * see-through (where the canvas's dodge adds alphas: linear-blend.ts).
 */

/** What a layer that reads the backdrop reads, kept from elsewhere: a canvas whose top left is (x, y) on the device. */
interface Backdrop {
  readonly canvas: AnyCanvas;
  readonly x: number;
  readonly y: number;
}

/** `b` in a canvas whose top left is (x, y) on the device. */
const shiftBounds = (b: Bounds, x: number, y: number): Bounds => ({
  ...b,
  x0: b.x0 - x,
  y0: b.y0 - y,
  x1: b.x1 - x,
  y1: b.y1 - y,
});

/**
 * A paint that comes out the same whatever is under it: opaque, and drawn normally, or white
 * lightening (Apple's vibrant white text adds itself by linear dodge) or black darkening.
 */
function hidesWhatsUnder(paint: Paint): boolean {
  if (paint.visible === false || paint.type !== "solid" || (paint.opacity ?? 1) < 1) return false;
  if (!opaqueColor(paint.color)) return false;
  const mode = paint.blendMode ?? "normal";
  if (mode === "normal") return true;
  const hex = paint.color.slice(1, 7).toLowerCase();
  if (hex === "ffffff") return ["linear-dodge", "screen", "lighten"].includes(mode);
  if (hex === "000000") return ["linear-burn", "multiply", "darken"].includes(mode);
  return false;
}

/** A CSS colour that's certainly opaque: `#rrggbb`, or `#rrggbbff`. */
const opaqueColor = (css: string) => /^#[0-9a-f]{6}(ff)?$/i.test(css.trim());
function blendsAsOne(
  node: NodeRecord,
  mode: BlendMode,
  children: number,
  /** Drawn onto a canvas known to be opaque, where the canvas's dodge is exact. */
  opaque: boolean,
): boolean {
  if (mode === "linear-burn") return true;
  if (mode === "normal") return false;
  if (children > 0) return true;
  if (mode === "linear-dodge" && !opaque) return true;
  const effects = getProp(node.props, "effects").filter((e) => e.visible !== false).length;
  const fills = getProp(node.props, "fills").filter((p) => p.visible !== false).length;
  const strokes = getProp(node.props, "strokes").filter((p) => p.visible !== false).length;
  return effects + fills + strokes > 1;
}

const NO_READERS: ReadonlySet<string> = new Set();

export interface CanvasRendererOptions {
  /** Shared decoded images. Pass the same cache to every renderer of one file. */
  readonly images?: ImageCache;
}

/** No layer reading the backdrop is drawn afresh (see `#redraw`). */

/**
 * Where a layer that reads around it paints (its box and its effects'
 * reach) and what it reads (that and the farthest its backdrop is read),
 * in zoomed page pixels (device pixels less the camera's translation), not
 * yet kept to the canvas.
 */
interface ReaderArea {
  readonly paints: Rect;
  readonly reads: Rect;
}

/** A rect in zoomed page pixels on the device, kept to the canvas; null when it's off it. */
function onCanvas(r: Rect, frame: { tx: number; ty: number; width: number; height: number }) {
  const x0 = Math.max(0, r.x + frame.tx);
  const y0 = Math.max(0, r.y + frame.ty);
  const x1 = Math.min(frame.width, r.x + r.width + frame.tx);
  const y1 = Math.min(frame.height, r.y + r.height + frame.ty);
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : null;
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

/**
 * A canvas kept for scratch work, at least w × h: kept as it is while it's
 * no more than four times that, else made to fit (to a multiple of 64, so
 * sizes close together share one). Chromium snapshots a canvas that's drawn
 * from, and copies all of it when it's next drawn into: a canvas grown once
 * for a whole screen would cost that copy for every strip drawn through it.
 */
function fitted(existing: AnyCanvas | null, w: number, h: number): AnyCanvas | null {
  if (
    existing &&
    existing.width >= w &&
    existing.height >= h &&
    existing.width * existing.height <= Math.max(4 * w * h, 65_536)
  )
    return existing;
  return scratch(existing, Math.ceil(w / 64) * 64, Math.ceil(h / 64) * 64);
}

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
  // Exact where the backdrop is opaque or empty (decision 0038). Linear burn has no
  // canvas mode: it's drawn by `LinearBurn`, and missing here.
  "linear-dodge": "lighter",
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
  return a.version === b.version && sameCanvas(a, b) && sameLook(a, b);
}

/** Two frames are drawn on the same canvas, of the same page, at the same size. */
function sameCanvas(a: LastFrame, b: LastFrame): boolean {
  return (
    a.ctx === b.ctx &&
    a.pageId === b.pageId &&
    a.dpr === b.dpr &&
    a.width === b.width &&
    a.height === b.height
  );
}

/** Nothing outside the document changed how two frames look (images, fonts, the theme, text being edited). */
function sameLook(a: LastFrame, b: LastFrame): boolean {
  return (
    a.epoch === b.epoch &&
    a.fonts === b.fonts &&
    a.background === b.background &&
    a.hidden === b.hidden &&
    a.whole === b.whole
  );
}

/**
 * A frame kept as a stand-in (decision 0028): a canvas holding what a
 * frame showed, at `scale` of its device pixels, and the document version
 * it showed (its places that changed since are cleared before it's shown).
 */
interface Raster {
  canvas: OffscreenCanvas | HTMLCanvasElement;
  frame: LastFrame;
  scale: number;
}

/** How many frames are kept as stand-ins, for all pages together. */
const RASTERS = 4;

/** Above this many layers, a page's first frame is drawn a little at a time until it's known to be cheap. */
const LARGE_FILE = 30_000;

/** Tiles' sides, in device pixels: chosen per pass so a tile costs about half the budget. */
const TILE_MIN = 64;
const TILE_MAX = 512;

/**
 * How far past its extent (in page units) a layer may still paint, which
 * culling allows for: type overhanging its box and the like, which scale
 * with the page, so 64 units, but never more than 64 screen pixels (as
 * before decision 0028), and two device pixels for antialiasing.
 */
function cullPad(zoom: number, dpr: number): number {
  return Math.min(64, 64 / zoom) + 2 / (zoom * dpr);
}

/** Options for `CanvasRenderer.render`. */
export interface RenderOptions {
  /** Draw exactly now: no scaled stand-in for a zoom. */
  readonly exact?: boolean;
  /**
   * Milliseconds this call may spend drawing. Without one the frame is drawn
   * whole. With one, a frame that would take longer is drawn a few tiles at
   * a time over the next calls (see `pending`), a stand-in showing until
   * each tile is drawn.
   */
  readonly budget?: number;
}

/**
 * The most a frame that only carries on drawing (nothing moved or changed)
 * may take, when the browser's own share of a frame is longer than the
 * budget anyway (see `#settling`).
 */
const SETTLING_MAX = 64;

/** How far a zoom may stray from the snapshot it scales before it's drawn exactly. */
const PREVIEW_MAX_SCALE = 4;
const PREVIEW_MIN_SCALE = 0.6;

/** A text layer's biggest font size, its runs' included. */
export function largestFontSize(node: NodeRecord): number {
  let size = getProp(node.props, "fontSize");
  for (const run of getProp(node.props, "textRuns"))
    if (run.fontSize && run.fontSize > size) size = run.fontSize;
  return size;
}

/** Text smaller than this many device pixels is drawn as bars, not glyphs. */
export const GREEK_BELOW = 4;

/**
 * How many bars stand in for text too small to read, and their line height: as many lines as
 * its box holds, but never more than it has characters (each line holds one at least), so a
 * tall box with little text makes a few bars, not one per line of its height.
 */
export function greekLines(
  node: NodeRecord,
  measurer: TextMeasurer,
): { readonly lines: number; readonly lh: number } {
  const props = node.props;
  const lh = Math.max(1, lineHeightPx(props, measurer));
  const height = getProp(props, "height");
  const fit = Number.isFinite(height / lh) ? Math.round(height / lh) : 1;
  const chars = Math.max(1, getProp(props, "characters").length);
  return { lines: Math.max(1, Math.min(fit, chars)), lh: Number.isFinite(lh) ? lh : 1 };
}

export class CanvasRenderer {
  readonly #scene: Scene;
  readonly #measurer: TextMeasurer;
  readonly #paths = new Map<string, { d: string; path: Path2D }>();
  readonly #shapes = new WeakMap<object, { w: number; h: number; path: Path2D }>();
  /** Per-side strokes' regions, by the layer's props (a new object with every edit). */
  readonly #sidePaths = new WeakMap<object, Path2D>();
  /** Shaped text as one outline at its origin, by letter spacing (see #shapedOutline). */
  readonly #shapedRuns = new WeakMap<ShapedText, Map<number, Path2D>>();
  /** Saved glyphs' paths (decision 0037), per group. */
  readonly #savedPaths = new WeakMap<SavedGlyphGroup, Path2D>();
  /** Each outline where it was last placed: text that holds still costs nothing per frame. */
  readonly #placedRuns = new WeakMap<Path2D, { x: number; y: number; path: Path2D }>();
  /** What the last screen frame showed, to move it on a pan instead of redrawing. */
  #last: LastFrame | null = null;
  /** The last frame drew every layer (not a scaled stand-in). */
  #lastExact = false;
  /** Parts of the canvas still to draw exactly, in zoomed page pixels at the last frame's zoom (tiles.ts). */
  #work = new TileWork();
  /** Whether the work is a whole frame (not just changed places): its cost is the frame's. */
  #workWhole = false;
  #workMs = 0;
  /** Device pixels drawn in the work so far. */
  #workArea = 0;
  /**
   * Layers reading the backdrop (glass, background blur) whose effect isn't
   * on the canvas: a pan's strip, a tile or a change, too costly to draw
   * with them at once, drew them without it. Each is drawn again with what it reads
   * once the tiles are done and there's time (see `#drawReaders`).
   */
  readonly #pendingReaders = new Set<string>();
  /** How long each reader's last pass took (it and what it reads), to tell whether one fits in what's left of a frame. */
  readonly #readerMs = new Map<string, number>();
  /** Their sum: one not drawn yet is expected to cost what readers have on average. */
  #readerMsSum = 0;
  /** Where the page's readers paint and read, in zoomed page pixels, at one zoom and document version. */
  #readerAreas: {
    pageId: string;
    version: number;
    zoom: number;
    dpr: number;
    areas: Map<string, ReaderArea>;
  } | null = null;
  /**
   * How long each page last took to draw, in milliseconds per device pixel,
   * at each zoom (by powers of two: zoomed out, a pixel holds far more):
   * whether a frame or a change is drawn at once or a tile at a time, and
   * how big the tiles are.
   */
  readonly #density = new Map<string, Map<number, number>>();
  /** When the last call started, and how long it took: what the browser took between (see `#settling`). */
  #lastCall: { start: number; ms: number } | null = null;
  /** Frames kept as stand-ins (see `#standIn`), most recent last. */
  #rasters: Raster[] = [];
  /**
   * The last call left work: call again next frame (with the same camera,
   * or a pan) to draw more of it. False after a scaled zoom stand-in, which
   * waits for the camera to settle instead.
   */
  pending = false;
  /**
   * Advances whenever a frame's content differs from the last one's (see
   * `sameContent`), so glass drawn against one backdrop isn't reused over another.
   */
  #generation = 0;
  /** The screen's canvas while a frame is drawn on it: glass drawn there is kept for pans. */
  #screen: Ctx | null = null;
  /**
   * While drawing readers coarse (decision 0042): a pass too costly to draw them exactly in
   * the frame, while something moves. Their glass and background blur are drawn at a
   * fraction of the resolution; each is drawn exactly once there's time.
   */
  #coarse = false;
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
  #imageView: {
    key: string;
    hidden: ReadonlySet<string>;
    uses: ReturnType<typeof collectExportImageUses>;
  } | null = null;
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
  /** A background blur under text, cut to its glyphs (see #backgroundBlur). */
  #blurGlyphs: AnyCanvas | null = null;
  /**
   * An export that sees what's under it (`renderNodes`'s `context`): while the page is drawn
   * up to the exported layers ("record"), what each of their glass and background blur
   * layers reads is kept; drawing the export itself ("replay"), they read that instead.
   */
  #context: {
    phase: "record" | "replay";
    readonly readers: ReadonlySet<string>;
    readonly seen: Map<string, Backdrop>;
  } | null = null;
  /** While the page is drawn up to some layers: those still to draw; once none are left, nothing more is. */
  #until: Set<string> | null = null;
  /** Scratch canvases for drawings blended apart: linear burn, and dodge over see-through (linear-blend.ts). */
  readonly #burn = new BlendApart();
  /** Canvases filled with an opaque background before anything is drawn: linear dodge's quick path. */
  readonly #opaque = new WeakSet<object>();
  /** Noise tiles, made once per look. */
  readonly #noiseTiles = new NoiseTiles();
  /** Draws texture effects, with its own WebGL context (made on first use). */
  readonly #texture = new TexturePainter();
  /** Where a text stroke inside or outside its glyphs is drawn, then cut to one side (#textStrokes). */
  #strokeCanvas: OffscreenCanvas | HTMLCanvasElement | null = null;
  /** Radial and angular gradients drawn for strokes and text (#gradientPattern), per paint. */
  readonly #gradientRasters = new WeakMap<
    Paint,
    {
      canvas: OffscreenCanvas | HTMLCanvasElement;
      w: number;
      h: number;
      reach: number;
      k: number;
    }
  >();

  constructor(scene: Scene, measurer: TextMeasurer, options: CanvasRendererOptions = {}) {
    this.#scene = scene;
    this.#measurer = measurer;
    this.images = options.images ?? new ImageCache();
    // A decoded (or sharper) image changes pixels the last frame has: draw afresh.
    this.images.subscribe(() => this.#epoch++);
  }

  /**
   * Draws the page. Returns false when the frame isn't exact yet: a zoom
   * drawn by scaling the last frame (draw again with `exact` once the camera
   * settles), or, with a `budget`, a frame drawn partly, a stand-in showing
   * where it isn't (`pending`: draw again next frame).
   */
  render(
    ctx: Ctx,
    pageId: string,
    camera: Camera,
    viewport: { width: number; height: number },
    dpr: number,
    { exact = false, budget = Number.POSITIVE_INFINITY }: RenderOptions = {},
  ): boolean {
    const start = performance.now();
    const settling = this.#settling(start, budget);
    this.stats = { drawn: 0, culled: 0, ms: 0 };
    this.images.frame();
    const page = this.#scene.doc.get(pageId);
    resetState(ctx);
    if (!page) {
      this.#last = null;
      this.#work.clear();
      this.#pendingReaders.clear();
      this.pending = false;
      ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
      return true;
    }
    // Whole device pixels, so a pan can move the last frame exactly (see `#moved`).
    const tx = Math.round(camera.x * dpr);
    const ty = Math.round(camera.y * dpr);
    const snapped = new Camera(tx / dpr, ty / dpr, camera.zoom);
    const background = getProp(page.props, "backgroundColor") ?? this.canvasColor;
    // The screen is filled with the page's background first: opaque when it is.
    if (opaqueColor(background)) this.#opaque.add(ctx.canvas);
    else this.#opaque.delete(ctx.canvas);
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
    if (this.images.boundedDisplay) {
      this.#trackViewImages(pageId, snapped.visibleRect(viewport), camera.zoom * dpr);
    }
    if (!this.#last || !sameContent(this.#last, frame)) this.#generation++;
    if (!exact && this.#preview(ctx, frame)) {
      this.#work.clear();
      this.#pendingReaders.clear();
      this.pending = false;
      this.stats.ms = performance.now() - start;
      return false;
    }
    this.#screen = ctx;
    let done: boolean;
    try {
      done = this.#paint(ctx, frame, snapped, viewport, dpr, start, budget, settling);
    } finally {
      this.#screen = null;
    }
    this.pending = !done;
    this.stats.ms = performance.now() - start;
    this.#lastCall = { start, ms: this.stats.ms };
    return done;
  }

  /** Retained pans and sliced paints still need a demand for the whole visible view. */
  #trackViewImages(pageId: string, rect: Rect, scale: number): void {
    const scene = this.#scene;
    const key = [pageId, scene.doc.version, rect.x, rect.y, rect.width, rect.height, scale].join(
      "/",
    );
    if (this.#imageView?.key !== key || this.#imageView.hidden !== this.hidden) {
      const hidden = this.hidden;
      function* visible(parent: string): IterableIterator<NodeRecord> {
        for (const id of scene.childrenIn(parent, rect)) {
          const node = scene.doc.get(id);
          if (!node || node.props.visible === false || hidden.has(id)) continue;
          const extent = scene.extent(id);
          if (extent && !rectsIntersect(extent, rect)) continue;
          yield node;
          yield* visible(id);
        }
      }
      this.#imageView = {
        key,
        hidden,
        uses: collectExportImageUses(scene, visible(pageId), scale),
      };
    }
    for (const [ref, uses] of this.#imageView.uses) {
      const natural = this.images.natural(ref);
      let width = 1;
      for (const { paint, box, scale } of uses) {
        const drawn = natural
          ? imageDrawnSize(paint.scaleMode, box, natural, scale, paint.crop).width
          : (box.width * scale.width) / (paint.crop?.width || 1);
        width = Math.max(width, drawn);
      }
      this.images.demand(ref, width);
    }
  }

  /**
   * The budget for a frame that only carries on drawing what's left (the
   * last call left work, and nothing has moved or changed since): when the
   * browser's own share of the last frame (the time between calls, less
   * what the last call took) was longer than the budget, as on a machine
   * that draws without a GPU, up to that much, at most `SETTLING_MAX`. The
   * frame rate drops by at most half while nothing moves, and the exact
   * picture arrives in far fewer frames. Elsewhere, the budget as it is.
   */
  #settling(start: number, budget: number): number {
    const last = this.#lastCall;
    if (!this.pending || !last || !Number.isFinite(budget)) return budget;
    const browser = start - last.start - last.ms;
    return Math.max(budget, Math.min(SETTLING_MAX, browser));
  }

  /**
   * Brings the canvas to `frame`: by moving the last frame and drawing what
   * a pan uncovered and what changed, when it can, else afresh; at once, or
   * (with a budget, for a frame that costs more) a tile at a time. True when
   * the canvas is exact.
   */
  #paint(
    ctx: Ctx,
    frame: LastFrame,
    camera: Camera,
    viewport: { width: number; height: number },
    dpr: number,
    start: number,
    budget: number,
    settling: number,
  ): boolean {
    const last = this.#last;
    const lastExact = this.#lastExact;
    const kept =
      last !== null &&
      lastExact &&
      last.zoom === frame.zoom &&
      sameCanvas(last, frame) &&
      sameLook(last, frame);
    // Drawn a tile at a time when it costs more than the budget. Layers that read the backdrop
    // (glass, background blur) read what's drawn around them, so a tile they paint in is drawn
    // with all they read, in one pass, as a pan's strips are, or without them, to draw later.
    const tiles = Number.isFinite(budget);
    // What to draw now (device pixels); null for all of it.
    let fresh: Rect[] | null = kept ? this.#moved(ctx, last, frame) : null;
    if (fresh && last && last.version !== frame.version) {
      const dirty = this.#dirtyRects(last.version, frame, camera, dpr);
      if (!dirty) fresh = null;
      else if (
        tiles &&
        this.#costly(
          frame.pageId,
          frame.zoom,
          dirty.reduce((sum, r) => sum + r.width * r.height, 0),
          budget,
        ) &&
        !this.#damagesReader(dirty, frame, camera, dpr)
      ) {
        // A change that takes longer to draw than a frame has: the old picture stays until each
        // place is drawn again.
        if (this.#work.empty)
          this.#work = new TileWork(this.#tileSide(frame.pageId, frame.zoom, budget));
        for (const r of dirty)
          this.#work.add({
            x: r.x - frame.tx,
            y: r.y - frame.ty,
            width: r.width,
            height: r.height,
          });
      } else fresh.push(...dirty);
    }
    const showing = last;
    this.#last = frame;
    this.#lastExact = true;
    const view = { x: -frame.tx, y: -frame.ty, width: frame.width, height: frame.height };
    // Stand-ins still showing, and tiles no longer allowed: all of it, now.
    if (fresh && !this.#work.empty && !tiles) fresh = null;
    if (!fresh) {
      this.#work.clear();
      this.#pendingReaders.clear();
      const area = frame.width * frame.height;
      if (!tiles || !this.#costly(frame.pageId, frame.zoom, area, budget)) {
        this.#workWhole = false;
        // Keep the reader positions even after a full draw. The next edit may move one
        // offscreen, so only its old footprint will intersect the damage.
        this.#areas(frame, camera, dpr);
        const t = performance.now();
        ctx.fillStyle = frame.background;
        ctx.fillRect(0, 0, frame.width, frame.height);
        this.#drawChildren(ctx, frame.pageId, camera, dpr, camera.visibleRect(viewport));
        this.#measured(frame.pageId, frame.zoom, (performance.now() - t) / Math.max(1, area));
        return true;
      }
      this.#standIn(ctx, frame, showing, lastExact);
      this.#work = new TileWork(this.#tileSide(frame.pageId, frame.zoom, budget));
      this.#work.add(view);
      this.#workWhole = true;
      this.#workMs = 0;
      this.#workArea = 0;
    } else if (fresh.length > 0)
      this.#drawFresh(ctx, frame, camera, dpr, fresh, budget - (performance.now() - start));
    if (this.#work.empty && this.#pendingReaders.size === 0) return true;
    // A tile at a time, centre first, while the budget lasts: at least one when nothing else was
    // drawn, so it always gets on, but none past the budget while a pan's strips fill it.
    const centre = { x: view.x + view.width / 2, y: view.y + view.height / 2 };
    let first = !fresh || fresh.length === 0;
    // Nothing moved or changed: only carrying on with what's left.
    if (fresh && fresh.length === 0) budget = settling;
    for (; first || performance.now() - start < budget; first = false) {
      const area = this.#work.take(view, centre);
      if (!area) break;
      const t = performance.now();
      const rect = {
        x: area.x + frame.tx,
        y: area.y + frame.ty,
        width: area.width,
        height: area.height,
      };
      // With the readers painting in it, and all they read, when that fits what's left of the
      // budget (what it drew past the tile is exact then: tiles it covers are done); else
      // without them, to draw once the tiles are (`#drawReaders`).
      // Coarse readers only where something moved or changed: tiles of a whole frame (a page
      // shown, a zoom settling) leave them to their exact pass, as before, rather than
      // redrawing each reader whole for every tile it touches.
      const grown = this.#drawFresh(
        ctx,
        frame,
        camera,
        dpr,
        [rect],
        budget - (t - start),
        !this.#workWhole,
      );
      this.#workArea += area.width * area.height;
      if (grown)
        for (const r of grown)
          this.#workArea += this.#work.drop({
            x: r.x - frame.tx,
            y: r.y - frame.ty,
            width: r.width,
            height: r.height,
          });
      this.#workMs += performance.now() - t;
    }
    if (!this.#work.empty) return false;
    if (this.#workWhole && this.#workArea > 0) {
      // The tiles are done: what the page costs to draw here is known, readers left aside.
      this.#measured(frame.pageId, frame.zoom, this.#workMs / this.#workArea);
      this.#workArea = 0;
    }
    // Then the readers left waiting, each with all it reads, nearest the centre first, while the
    // budget lasts.
    this.#drawReaders(ctx, frame, camera, dpr, start, budget, first);
    if (this.#pendingReaders.size > 0) return false;
    if (this.#workWhole) this.#keep(ctx, frame);
    this.#workWhole = false;
    return true;
  }

  #measured(pageId: string, zoom: number, density: number): void {
    let byZoom = this.#density.get(pageId);
    if (!byZoom) {
      byZoom = new Map();
      this.#density.set(pageId, byZoom);
    }
    byZoom.set(Math.round(Math.log2(zoom)), density);
  }

  /**
   * How long a device pixel of the page takes to draw at `zoom`: as measured
   * there, else from the nearest zoom measured, halved for each doubling of
   * the zoom (a pixel holds less). Undefined when nothing's measured yet.
   */
  #densityAt(pageId: string, zoom: number): number | undefined {
    const byZoom = this.#density.get(pageId);
    if (!byZoom) return undefined;
    const at = Math.round(Math.log2(zoom));
    const exact = byZoom.get(at);
    if (exact !== undefined) return exact;
    let estimate: number | undefined;
    let nearest = Number.POSITIVE_INFINITY;
    for (const [level, density] of byZoom)
      if (Math.abs(level - at) < nearest) {
        nearest = Math.abs(level - at);
        estimate = density * 2 ** (level - at);
      }
    return estimate;
  }

  /** Whether drawing `area` device pixels of the page is likely to take longer than `budget`. */
  #costly(pageId: string, zoom: number, area: number, budget: number): boolean {
    const density = this.#densityAt(pageId, zoom);
    if (density === undefined) return this.#scene.doc.size > LARGE_FILE;
    return density * area > budget;
  }

  /** A tile's side for the page: a power of two that takes about half the budget to draw. */
  #tileSide(pageId: string, zoom: number, budget: number): number {
    const density = this.#densityAt(pageId, zoom);
    if (density === undefined || density <= 0) return 128;
    const side = Math.sqrt((budget * 0.5) / density);
    let tile = TILE_MIN;
    while (tile * 2 <= Math.min(side, TILE_MAX)) tile *= 2;
    return tile;
  }

  /**
   * Where the document changed since `version`, on the canvas (device
   * pixels, merged into a few rects); null when that can't be told, so
   * everything is drawn again.
   */
  #dirtyRects(version: number, frame: LastFrame, camera: Camera, dpr: number): Rect[] | null {
    const dirty = this.#scene.dirtySince(version);
    if (!dirty || dirty.full) return null;
    // The cull's margin for strokes and type past a layer's bounds, and a pixel for antialiasing.
    const pad = cullPad(camera.zoom, dpr);
    const z = camera.zoom * dpr;
    const rects: Rect[] = [];
    for (const { rect, page } of dirty.rects) {
      if (page !== null && page !== frame.pageId) continue;
      const x0 = Math.floor((rect.x - pad) * z + frame.tx);
      const y0 = Math.floor((rect.y - pad) * z + frame.ty);
      const x1 = Math.ceil((rect.x + rect.width + pad) * z + frame.tx);
      const y1 = Math.ceil((rect.y + rect.height + pad) * z + frame.ty);
      if (x1 <= 0 || y1 <= 0 || x0 >= frame.width || y0 >= frame.height) continue;
      rects.push({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
    }
    return coverRects(rects, { x: 0, y: 0, width: frame.width, height: frame.height });
  }

  /**
   * Repaint this batch together if it touches a reader's old or new footprint.
   * Tiling it could draw the reader at its new position before erasing its old one.
   * The repaint can still draw readers coarse and settle their optics later.
   */
  #damagesReader(dirty: readonly Rect[], frame: LastFrame, camera: Camera, dpr: number): boolean {
    const previous = this.#readerAreas;
    const current = this.#areas(frame, camera, dpr);
    const touches = (areas: ReadonlyMap<string, ReaderArea>) => {
      for (const area of areas.values()) {
        const paints = onCanvas(area.paints, frame);
        if (paints && dirty.some((rect) => rectsIntersect(rect, paints))) return true;
      }
      return false;
    };
    return (
      touches(current) ||
      (previous !== null &&
        previous.areas !== current &&
        previous.pageId === frame.pageId &&
        previous.zoom === frame.zoom &&
        previous.dpr === frame.dpr &&
        touches(previous.areas))
    );
  }

  /**
   * What shows until the exact frame is drawn: the frames kept for this
   * page (coarsest first), then the last frame, each scaled to this one's
   * camera. Or, when only the look changed (an image decoded, a font
   * loaded), the canvas as it is.
   */
  #standIn(ctx: Ctx, frame: LastFrame, showing: LastFrame | null, exact: boolean): void {
    const same = showing !== null && sameCanvas(showing, frame);
    if (
      same &&
      showing.zoom === frame.zoom &&
      showing.tx === frame.tx &&
      showing.ty === frame.ty &&
      showing.background === frame.background
    )
      return;
    // The canvas as it is, unless it's already a scaled snapshot: that snapshot is kept.
    if (same && exact) {
      const snapshot = this.#snapshotFor(frame.width, frame.height);
      const sctx = snapshot?.getContext("2d") as Ctx | null | undefined;
      if (snapshot && sctx) {
        sctx.globalCompositeOperation = "copy";
        sctx.drawImage(ctx.canvas, 0, 0);
        sctx.globalCompositeOperation = "source-over";
        this.#snapshotFrame = showing;
      }
    }
    resetState(ctx);
    ctx.fillStyle = frame.background;
    ctx.fillRect(0, 0, frame.width, frame.height);
    const sources: Raster[] = this.#rasters
      .filter((r) => r.frame.pageId === frame.pageId && r.frame.dpr === frame.dpr)
      .sort((a, b) => a.frame.zoom - b.frame.zoom);
    const shot = this.#snapshotFrame;
    if (this.#snapshot && shot && sameCanvas(shot, frame))
      sources.push({ canvas: this.#snapshot, frame: shot, scale: 1 });
    ctx.imageSmoothingQuality = "low";
    for (const source of sources) {
      if (source.frame.background !== frame.background || !this.#refresh(source, frame)) continue;
      const ratio = frame.zoom / source.frame.zoom;
      const k = ratio / source.scale;
      ctx.setTransform(
        k,
        0,
        0,
        k,
        frame.tx - ratio * source.frame.tx,
        frame.ty - ratio * source.frame.ty,
      );
      ctx.drawImage(source.canvas, 0, 0);
    }
    resetState(ctx);
  }

  /**
   * Brings a kept frame up to the document: the places changed since it was
   * drawn are cleared to the background (the exact frame draws them soon).
   * False when that can't be told: the frame is dropped.
   */
  #refresh(source: Raster, frame: LastFrame): boolean {
    if (source.frame.version === frame.version) return true;
    const dirty = this.#scene.dirtySince(source.frame.version);
    if (!dirty || dirty.full) {
      this.#rasters = this.#rasters.filter((r) => r !== source);
      if (source.canvas === this.#snapshot) this.#snapshotFrame = null;
      return false;
    }
    const c = source.canvas.getContext("2d") as Ctx | null;
    if (!c) return false;
    const old = source.frame;
    const z = old.zoom * old.dpr * source.scale;
    resetState(c);
    c.fillStyle = old.background;
    const pad = cullPad(old.zoom, old.dpr);
    for (const { rect, page } of dirty.rects) {
      if (page !== null && page !== old.pageId) continue;
      c.fillRect(
        Math.floor((rect.x - pad) * z + old.tx * source.scale),
        Math.floor((rect.y - pad) * z + old.ty * source.scale),
        Math.ceil((rect.width + pad * 2) * z) + 2,
        Math.ceil((rect.height + pad * 2) * z) + 2,
      );
    }
    source.frame = { ...old, version: frame.version };
    return true;
  }

  /** Keeps a copy of an exact frame drawn a little at a time, at half size, as a stand-in for later. */
  #keep(ctx: Ctx, frame: LastFrame): void {
    const scale = Math.min(1, 1024 / Math.max(frame.width, frame.height, 1));
    const w = Math.max(1, Math.round(frame.width * scale));
    const h = Math.max(1, Math.round(frame.height * scale));
    const same = this.#rasters.findIndex(
      (r) => r.frame.pageId === frame.pageId && r.frame.zoom === frame.zoom,
    );
    const reuse = same !== -1 ? this.#rasters.splice(same, 1)[0] : undefined;
    let canvas = reuse?.canvas ?? null;
    if (!canvas) {
      if (this.#rasters.length >= RASTERS) canvas = (this.#rasters.shift() as Raster).canvas;
      else canvas = scratch(null, w, h);
    }
    if (!canvas) return;
    canvas.width = w;
    canvas.height = h;
    const c = canvas.getContext("2d") as Ctx | null;
    if (!c) return;
    resetState(c);
    c.imageSmoothingQuality = "medium";
    c.drawImage(ctx.canvas, 0, 0, w, h);
    this.#rasters.push({ canvas, frame, scale: w / frame.width });
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

  get snapshotBytes(): number {
    return this.#snapshot ? this.#snapshot.width * this.#snapshot.height * 4 : 0;
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
   * A pan: moves the last frame by the camera's whole-pixel step and returns
   * the strips it uncovered (device pixels), to draw. Panning then costs what
   * the new edge holds, not what the whole view holds. Null when it moved
   * more than a screen.
   */
  #moved(ctx: Ctx, last: LastFrame, frame: LastFrame): Rect[] | null {
    const dx = frame.tx - last.tx;
    const dy = frame.ty - last.ty;
    const { width, height } = frame;
    if (dx === 0 && dy === 0) return [];
    if (Math.abs(dx) >= width || Math.abs(dy) >= height) return null;
    resetState(ctx);
    ctx.globalCompositeOperation = "copy";
    ctx.drawImage(ctx.canvas, dx, dy);
    ctx.globalCompositeOperation = "source-over";
    // The uncovered strips, in device pixels: one along x, one along y.
    const strips: Array<[number, number, number, number]> = [];
    if (dx > 0) strips.push([0, 0, dx, height]);
    if (dx < 0) strips.push([width + dx, 0, -dx, height]);
    if (dy > 0) strips.push([0, 0, width, dy]);
    if (dy < 0) strips.push([0, height + dy, width, -dy]);
    return strips.map(([x, y, w, h]) => ({ x, y, width: w, height: h }));
  }

  /**
   * Draws these parts of the canvas (device pixels) exactly: what a pan
   * uncovered, what changed. Layers reading the backdrop that paint there
   * are drawn with all they read, at once when that fits in what's `left`
   * of the budget, else later (see `#drawReaders`). Returns what it drew
   * past `rects` for them, if anything.
   */
  #drawFresh(
    ctx: Ctx,
    frame: LastFrame,
    camera: Camera,
    dpr: number,
    rects: Rect[],
    left: number,
    /** Draw readers coarse when they don't fit (decision 0042), rather than later. */
    coarse = true,
  ): Rect[] | null {
    const grown = this.#withReaders(rects, frame, camera, dpr);
    if (grown.readers.size === 0) {
      for (const rect of rects) this.#redraw(ctx, frame, camera, dpr, [rect], grown.readers);
      return null;
    }
    if (!this.#readersCostly(grown, frame, left)) {
      // Layers that read the backdrop around them (glass, background blur) and touch a part
      // are redrawn whole, with all they read, in one pass: drawn in a part alone, they'd
      // read the last frame's finished pixels past its edge, and leave a seam there.
      const t = performance.now();
      this.#redraw(ctx, frame, camera, dpr, grown.rects, grown.readers);
      this.#drewReaders(grown.readers, performance.now() - t);
      return grown.rects;
    }
    // Too costly to draw exactly in this frame: the parts again with the readers painting
    // there drawn coarse (decision 0042), each over all it paints (and so the readers painting
    // there too), so none goes missing and none is left half redrawn. What they read past
    // that is the canvas as it was: close enough for a coarse picture, and far less to draw
    // than all they read. Each is drawn exactly once there's time (`#drawReaders`).
    if (!coarse) {
      // The parts now, the readers in them once there's time.
      for (const rect of rects) this.#redraw(ctx, frame, camera, dpr, [rect], NO_READERS);
      this.#defer(frame, camera, dpr, rects);
      return null;
    }
    const painted = this.#withReaders(rects, frame, camera, dpr, true);
    this.#coarse = true;
    try {
      this.#redraw(ctx, frame, camera, dpr, painted.rects, painted.readers);
    } finally {
      this.#coarse = false;
    }
    for (const id of painted.readers) this.#pendingReaders.add(id);
    return null;
  }

  /**
   * Whether drawing these readers with all they read would take longer than
   * `budget`: by how long each took last time; for one not drawn yet, by
   * what readers have taken on average (many are a few pixels across, or
   * cut away, and cost next to nothing) and, as all it reads is drawn with
   * it, by the page's drawing cost for that much of it (unknown before
   * anything on the page is measured: costly then).
   */
  #readersCostly(
    grown: { rects: readonly Rect[]; readers: ReadonlySet<string> },
    frame: LastFrame,
    budget: number,
  ): boolean {
    if (!Number.isFinite(budget)) return false;
    if (budget <= 0) return true;
    const average = this.#readerMs.size > 0 ? this.#readerMsSum / this.#readerMs.size : 0;
    let ms = 0;
    let unknown = false;
    for (const id of grown.readers) {
      const known = this.#readerMs.get(id);
      if (known === undefined) unknown = true;
      ms += known ?? average;
    }
    if (ms > budget) return true;
    if (!unknown) return false;
    // Nothing measured on this page yet: no telling, so not now.
    const density = this.#densityAt(frame.pageId, frame.zoom);
    if (density === undefined) return true;
    const area = grown.rects.reduce((sum, r) => sum + r.width * r.height, 0);
    return density * area > budget;
  }

  /** These readers were drawn with all they read, in `ms`: each costs its share. */
  #drewReaders(readers: ReadonlySet<string>, ms: number): void {
    for (const id of readers) {
      this.#pendingReaders.delete(id);
      const share = ms / readers.size;
      this.#readerMsSum += share - (this.#readerMs.get(id) ?? 0);
      this.#readerMs.set(id, share);
    }
  }

  /** The readers that paint in `rects` (device pixels), drawn there without their effect: to draw again. */
  #defer(frame: LastFrame, camera: Camera, dpr: number, rects: readonly Rect[]): void {
    const areas = this.#areas(frame, camera, dpr);
    if (areas.size === 0) return;
    for (const [id, area] of areas) {
      if (this.#pendingReaders.has(id)) continue;
      const paints = onCanvas(area.paints, frame);
      if (paints && rects.some((r) => rectsIntersect(r, paints))) this.#pendingReaders.add(id);
    }
  }

  /**
   * Draws the readers waiting (see `#pendingReaders`), nearest the centre
   * first, each with all it reads and the readers painting there, in one
   * pass, while the budget lasts: one likely to cost more than what's left
   * waits, unless nothing was drawn yet (`first`), so work always gets on. Readers
   * off the canvas are dropped: a pan back draws them as they come in.
   */
  #drawReaders(
    ctx: Ctx,
    frame: LastFrame,
    camera: Camera,
    dpr: number,
    start: number,
    budget: number,
    first: boolean,
  ): void {
    if (this.#pendingReaders.size === 0) return;
    const areas = this.#areas(frame, camera, dpr);
    const cx = frame.width / 2;
    const cy = frame.height / 2;
    const waiting: Array<{ id: string; paints: Rect; distance: number }> = [];
    for (const id of this.#pendingReaders) {
      const area = areas.get(id);
      const paints = area && onCanvas(area.paints, frame);
      if (!paints) {
        this.#pendingReaders.delete(id);
        continue;
      }
      const dx = paints.x + paints.width / 2 - cx;
      const dy = paints.y + paints.height / 2 - cy;
      waiting.push({ id, paints, distance: dx * dx + dy * dy });
    }
    waiting.sort((a, b) => a.distance - b.distance);
    for (const { id, paints } of waiting) {
      if (!this.#pendingReaders.has(id)) continue;
      const now = performance.now();
      const left = budget - (now - start);
      if (!first && left <= 0) break;
      // Its own cost alone too much: skip it without working out what it reads.
      if (!first && this.#readersCostly({ rects: [paints], readers: new Set([id]) }, frame, left))
        continue;
      const grown = this.#withReaders([paints], frame, camera, dpr);
      if (!first && this.#readersCostly(grown, frame, left)) continue;
      first = false;
      this.#redraw(ctx, frame, camera, dpr, grown.rects, grown.readers);
      this.#drewReaders(grown.readers, performance.now() - now);
      this.#pendingReaders.delete(id);
    }
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
   * within the canvas, and those layers. No layers when none paints in them,
   * so they're drawn as they are.
   */
  #withReaders(
    strips: readonly Rect[],
    frame: LastFrame,
    camera: Camera,
    dpr: number,
    /** Grown by where readers paint only, not by what they read (for a coarse pass). */
    paintsOnly = false,
  ): { rects: Rect[]; readers: Set<string> } {
    // Glass and background blur. (Layer blur and texture spread only the layer, which is drawn
    // whole into a canvas of its own.)
    const taken = new Set<string>();
    const all = this.#areas(frame, camera, dpr);
    if (all.size === 0) return { rects: [...strips], readers: taken };
    const areas: Array<{ id: string; paints: Rect; reads: Rect }> = [];
    for (const [id, area] of all) {
      const paints = onCanvas(area.paints, frame);
      const reads = onCanvas(area.reads, frame);
      if (paints && reads) areas.push({ id, paints, reads });
    }
    const dirty = [...strips];
    for (let grew = true; grew; ) {
      grew = false;
      for (const area of areas) {
        if (taken.has(area.id) || !dirty.some((d) => rectsIntersect(d, area.paints))) continue;
        taken.add(area.id);
        dirty.push(paintsOnly ? area.paints : area.reads);
        grew = true;
      }
    }
    return { rects: dirty, readers: taken };
  }

  /**
   * Where each of the page's layers that read around them paints and reads
   * (see `ReaderArea`), kept while the zoom and the document stay as they
   * are: a pan only moves them.
   */
  #areas(frame: LastFrame, camera: Camera, dpr: number): ReadonlyMap<string, ReaderArea> {
    const cached = this.#readerAreas;
    if (
      cached &&
      cached.pageId === frame.pageId &&
      cached.version === frame.version &&
      cached.zoom === camera.zoom &&
      cached.dpr === dpr
    )
      return cached.areas;
    const areas = new Map<string, ReaderArea>();
    for (const id of this.#scene.backdropReaders(frame.pageId)) {
      const area = this.#readerArea(id, camera.zoom, dpr);
      if (area) areas.set(id, area);
    }
    this.#readerAreas = {
      pageId: frame.pageId,
      version: frame.version,
      zoom: camera.zoom,
      dpr,
      areas,
    };
    return areas;
  }

  /** Where a layer that reads around it paints and reads, in zoomed page pixels. */
  #readerArea(id: string, zoom: number, dpr: number): ReaderArea | null {
    const node = this.#scene.doc.get(id);
    const b = this.#scene.bounds(id);
    if (!node || !b) return null;
    const z = zoom * dpr;
    const paints = effectReach(node) * z;
    let reads = paints;
    for (const e of getProp(node.props, "effects")) {
      if (e.visible === false) continue;
      if (e.type === "glass") reads = Math.max(reads, glassParams(e, z).margin);
      if (e.type === "background-blur") reads = Math.max(reads, blurSigma(e.radius) * z * 3);
    }
    const rect = (reach: number): Rect => {
      const r = Math.ceil(reach) + 2;
      const x0 = Math.floor(b.x * z) - r;
      const y0 = Math.floor(b.y * z) - r;
      const x1 = Math.ceil((b.x + b.width) * z) + r;
      const y1 = Math.ceil((b.y + b.height) * z) + r;
      return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
    };
    return { paints: rect(paints), reads: rect(reads) };
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
    /**
     * As Figma exports a layer: its glass and background blur see what's under it on the
     * page (the frames and sections it's in, what's beneath it; not the page's background),
     * while everything else draws over nothing. Off, the layers are alone on the canvas.
     */
    context = false,
  ): void {
    this.images.frame();
    this.stats = { drawn: 0, culled: 0, ms: 0 };
    resetState(ctx);
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    if (background) {
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    }
    if (background && opaqueColor(background)) this.#opaque.add(ctx.canvas);
    else this.#opaque.delete(ctx.canvas);
    const camera = new Camera(-rect.x * scale, -rect.y * scale, scale);
    const hidden = this.hidden;
    this.hidden = new Set();
    this.#detail = detail;
    try {
      if (context) this.#recordContext(ctx, ids, camera, rect);
      for (const id of ids) this.#draw(ctx, id, camera, 1, rect);
    } finally {
      this.hidden = hidden;
      this.#detail = true;
      this.#context = null;
      this.#until = null;
    }
  }

  /**
   * For an export that sees what's under it: the page drawn, without its background, up to and
   * including the layers `ids` into a canvas of the export's size, keeping what each glass
   * and background blur among them reads there (`#backdropFor`). Skipped when there are none.
   */
  #recordContext(ctx: Ctx, ids: readonly string[], camera: Camera, rect: Rect): void {
    const doc = this.#scene.doc;
    const readers = new Set<string>();
    const visit = (id: string) => {
      const node = doc.get(id);
      if (!node || node.props.visible === false) return;
      if (
        node.type !== "group" &&
        getProp(node.props, "effects").some(
          (e) => e.visible !== false && (e.type === "glass" || e.type === "background-blur"),
        )
      )
        readers.add(id);
      for (const child of doc.childIds(id)) visit(child);
    };
    for (const id of ids) visit(id);
    if (readers.size === 0) return;
    const first = ids[0];
    if (first === undefined) return;
    let page = doc.get(first);
    while (page && page.type !== "page") page = doc.get(page.parent);
    if (!page) return;
    const canvas = scratch(null, ctx.canvas.width, ctx.canvas.height);
    const under = canvas?.getContext("2d") as Ctx | null | undefined;
    if (!canvas || !under) return;
    // Not on the page's background: Figma's exports don't see it (measured: a glass on a frame
    // straight on a grey page sees nothing there, one in a section sees the section's fill).
    resetState(under);
    under.clearRect(0, 0, canvas.width, canvas.height);
    this.#context = { phase: "record", readers, seen: new Map() };
    this.#until = new Set(ids);
    // Only what the readers read is drawn: the page around each, as far as it reads (as
    // `#backdropFor` keeps it). A layer touching none of that can't change what they see.
    const parts: Rect[] = [];
    for (const id of readers) {
      const node = doc.get(id);
      const b = this.#scene.bounds(id);
      if (!node || !b) continue;
      let pad = 0;
      for (const e of getProp(node.props, "effects")) {
        if (e.visible === false) continue;
        if (e.type === "glass") {
          const p = glassParams(e, camera.zoom);
          pad = Math.max(pad, p.margin + Math.ceil(3 * p.sigma) + 2);
        } else if (e.type === "background-blur")
          pad = Math.max(pad, Math.ceil(blurSigma(e.radius) * camera.zoom * 3) + 2);
      }
      // In page units, with a device pixel to spare for antialiasing.
      const grow = (pad + 2) / camera.zoom;
      parts.push({
        x: b.x - grow,
        y: b.y - grow,
        width: b.width + grow * 2,
        height: b.height + grow * 2,
      });
    }
    const outer = this.#parts;
    this.#parts = parts;
    try {
      for (const id of doc.childIds(page.id)) this.#draw(under, id, camera, 1, rect);
    } finally {
      this.#parts = outer;
      this.#until = null;
      this.#context.phase = "replay";
    }
  }

  /**
   * Where a glass or background blur reads its backdrop: null for the canvas it's drawn on.
   * In an export that sees what's under it, what the page had there (`#recordContext`):
   * kept while recording, `pad` device pixels around the layer's box (all it reads), and
   * returned when the export itself is drawn. "done" once the last of them is kept: the page
   * needn't be drawn further.
   */
  #backdropFor(ctx: Ctx, node: NodeRecord, pad: number): Backdrop | "done" | null {
    const context = this.#context;
    if (!context?.readers.has(node.id)) return null;
    if (context.phase === "replay") return context.seen.get(node.id) ?? null;
    const t = ctx.getTransform();
    const w = getProp(node.props, "width");
    const h = getProp(node.props, "height");
    const xs = [t.e, t.a * w + t.e, t.c * h + t.e, t.a * w + t.c * h + t.e];
    const ys = [t.f, t.b * w + t.f, t.d * h + t.f, t.b * w + t.d * h + t.f];
    const x0 = Math.max(0, Math.floor(Math.min(...xs)) - pad);
    const y0 = Math.max(0, Math.floor(Math.min(...ys)) - pad);
    const x1 = Math.min(ctx.canvas.width, Math.ceil(Math.max(...xs)) + pad);
    const y1 = Math.min(ctx.canvas.height, Math.ceil(Math.max(...ys)) + pad);
    if (x1 <= x0 || y1 <= y0) return null;
    const canvas = scratch(null, x1 - x0, y1 - y0);
    const copy = canvas?.getContext("2d") as Ctx | null | undefined;
    if (!canvas || !copy) return null;
    copy.drawImage(ctx.canvas, x0, y0, x1 - x0, y1 - y0, 0, 0, x1 - x0, y1 - y0);
    context.seen.set(node.id, { canvas, x: x0, y: y0 });
    // Every reader's backdrop kept: nothing more of the page is needed, this one's own effect
    // included.
    if (context.seen.size < context.readers.size) return null;
    this.#until?.clear();
    return "done";
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
    const until = this.#until;
    if (!until) {
      this.#drawLayer(ctx, id, camera, dpr, visible, alpha, inheritedBlend);
      return;
    }
    // Drawing the page up to some layers (`#recordContext`): nothing past the last of them.
    if (until.size === 0) return;
    this.#drawLayer(ctx, id, camera, dpr, visible, alpha, inheritedBlend);
    until.delete(id);
  }

  #drawLayer(
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
    // Culled by its extent: its box and what it paints outside it (strokes, shadows, blur), and
    // its children where they overflow a frame that doesn't clip them, so a part of the canvas
    // redrawn on its own gets every layer a whole frame would draw there. A margin holds what
    // type may paint past even that (see `cullPad`).
    const extent = this.#scene.extent(id);
    const pad = cullPad(camera.zoom, dpr);
    if (
      !bounds ||
      !extent ||
      extent.x - pad > visible.x + visible.width ||
      extent.y - pad > visible.y + visible.height ||
      extent.x + extent.width + pad < visible.x ||
      extent.y + extent.height + pad < visible.y ||
      (this.#parts &&
        !this.#parts.some(
          (r) =>
            extent.x - pad <= r.x + r.width &&
            extent.y - pad <= r.y + r.height &&
            extent.x + extent.width + pad >= r.x &&
            extent.y + extent.height + pad >= r.y,
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
    const mode = getProp(node.props, "blendMode");
    const own = isolated ? "source-over" : (BLEND[mode] ?? "source-over");
    // A group's blending carries to its layers unless they blend their own way.
    const blend = own === "source-over" ? inheritedBlend : own;

    const post = isolated ? null : postEffects(getProp(node.props, "effects"));
    if (post) {
      const children = this.#scene.doc.childIds(id).length;
      const linear = blendsAsOne(node, mode, children, this.#opaque.has(ctx.canvas));
      const fades = fadesAsOne(node, children);
      if (post.length > 0 || fades || linear) {
        // Faded, it's drawn over a copy of what's under it, so what blends inside it blends
        // with that, as in Figma, where a frame's opacity doesn't cut its layers off.
        const through =
          fades &&
          !linear &&
          post.length === 0 &&
          own === "source-over" &&
          blend === "source-over" &&
          this.#blendsWithin(id);
        this.#drawProcessed(ctx, node, camera, dpr, opacity, blend, post, {
          ...(linear && (mode === "linear-burn" || mode === "linear-dodge")
            ? { linear: mode }
            : {}),
          through,
        });
        return;
      }
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
    how: {
      /** Composited by linear dodge or burn, apart (linear-blend.ts). */
      readonly linear?: "linear-dodge" | "linear-burn";
      /** Drawn over a copy of what's under it rather than alone: see `#draw`. */
      readonly through?: boolean;
    } = {},
  ): void {
    const { linear, through = false } = how;
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
    if (through) lctx.drawImage(ctx.canvas, x0, y0, x1 - x0, y1 - y0, 0, 0, w, h);
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
    const picture = layer;
    if (linear) {
      const spread = finalBlur * 3;
      this.#burn.blend(
        ctx,
        {
          x0: x0 - spread,
          y0: y0 - spread,
          x1: x0 + w / scale + spread,
          y1: y0 + h / scale + spread,
        },
        linear,
        (c) => c.drawImage(picture, 0, 0, w, h, x0, y0, w / scale, h / scale),
        this.#opaque.has(ctx.canvas),
      );
    } else ctx.drawImage(layer, 0, 0, w, h, x0, y0, w / scale, h / scale);
    resetState(ctx);
  }

  /** Whether this layer's paints or shadows, or any layer inside it, blend their own way. */
  #blendsWithin(id: string): boolean {
    const node = this.#scene.doc.get(id);
    if (!node) return false;
    const blended = (p: { blendMode?: string | undefined }) =>
      p.blendMode !== undefined && p.blendMode !== "normal";
    if (
      getProp(node.props, "fills").some(blended) ||
      getProp(node.props, "strokes").some(blended) ||
      getProp(node.props, "effects").some((e) => "blendMode" in e && blended(e))
    )
      return true;
    for (const child of this.#scene.doc.childIds(id)) {
      const inner = this.#scene.doc.get(child);
      if (!inner || inner.props.visible === false) continue;
      if (getProp(inner.props, "blendMode") !== "normal" || this.#blendsWithin(child)) return true;
    }
    return false;
  }

  /** A canvas for post effects, by slot (two per nesting depth): kept while it fits (see `fitted`). */
  #postCanvas(slot: number, w: number, h: number): OffscreenCanvas | HTMLCanvasElement | null {
    const canvas = fitted(this.#postCanvases[slot] ?? null, w, h);
    if (canvas) this.#postCanvases[slot] = canvas;
    return canvas;
  }

  /**
   * Draws a parent's children bottom first. A mask isn't drawn itself: it
   * masks the children above it, up to the next mask or a frame that clips
   * its content (masks.ts), by its outline (a clip) or by its picture: its
   * alpha or luminance, or for a group, text or line masking by its outline,
   * what it draws made opaque (see #drawMasked).
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
    if (!this.#scene.hasMask(parentId)) {
      // Only children that can reach the view: the scene's index finds them, so this costs what's
      // near the view, not what the parent holds. The margin is the cull's (see `#draw`).
      const margin = cullPad(camera.zoom, dpr);
      const near = this.#scene.childrenIn(parentId, {
        x: visible.x - margin,
        y: visible.y - margin,
        width: visible.width + margin * 2,
        height: visible.height + margin * 2,
      });
      for (const child of near) this.#draw(ctx, child, camera, dpr, visible, alpha, blend);
      return;
    }
    let clipping = false;
    // Layers above a mask that masks by its picture, gathered to draw together.
    let scope: { mask: NodeRecord; ids: string[] } | null = null;
    const flush = () => {
      if (scope) this.#drawMasked(ctx, scope.mask, scope.ids, camera, dpr, visible, alpha, blend);
      scope = null;
    };
    for (const { id, isMask, mask: masking } of maskScopes(doc, parentId)) {
      if (!isMask && masking) {
        if (scope) (scope as { ids: string[] }).ids.push(id);
        else this.#draw(ctx, id, camera, dpr, visible, alpha, blend);
        continue;
      }
      // A mask, or a layer past the last one's scope: what was masked ends here.
      flush();
      if (clipping) ctx.restore();
      clipping = false;
      if (!isMask) {
        this.#draw(ctx, id, camera, dpr, visible, alpha, blend);
        continue;
      }
      const mask = doc.get(id) as NodeRecord;
      if (!clipsByShape(mask)) {
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
    visible: Rect,
    alpha: number,
    blend: GlobalCompositeOperation,
  ): void {
    if (ids.length === 0) return;
    const region = exportBounds(this.#scene, [mask.id]);
    if (!region) return;
    const whole = {
      x0: Math.max(0, Math.floor((region.x * camera.zoom + camera.x) * dpr)),
      y0: Math.max(0, Math.floor((region.y * camera.zoom + camera.y) * dpr)),
      x1: Math.min(
        ctx.canvas.width,
        Math.ceil(((region.x + region.width) * camera.zoom + camera.x) * dpr),
      ),
      y1: Math.min(
        ctx.canvas.height,
        Math.ceil(((region.y + region.height) * camera.zoom + camera.y) * dpr),
      ),
    };
    if (whole.x1 <= whole.x0 || whole.y1 <= whole.y0) return;
    const part = this.#maskedPart(whole, camera, dpr, visible);
    if (!part) return;
    const { x0, y0, x1, y1 } = part;
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
    // Drawn whole within that part into canvases of their own, not cut to the parts of a partial
    // redraw. Its layers reading the backdrop see all of it when that's the mask's whole reach;
    // in a part, only those drawn with all they read (`#fresh`) are drawn, as outside masks.
    const parts = this.#parts;
    const fresh = this.#fresh;
    const partial = x0 !== whole.x0 || y0 !== whole.y0 || x1 !== whole.x1 || y1 !== whole.y1;
    this.#parts = null;
    this.#fresh = partial ? fresh : null;
    this.#maskDepth++;
    try {
      for (const id of ids) this.#draw(cctx, id, shifted, dpr, holds, alpha, blend);
      this.#draw(mctx, mask.id, shifted, dpr, holds, 1, "source-over");
    } finally {
      this.#maskDepth--;
      this.#parts = parts;
      this.#fresh = fresh;
    }
    const kind = getProp(mask.props, "maskType");
    if (kind === "luminance") this.#luminance.apply(picture, w, h);
    else if (kind === "outline") opaqueAlpha(picture, w, h);
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

  /**
   * What of a mask's reach on the canvas (`whole`, device pixels) its
   * layers are drawn over: where the canvas is being drawn (a pan's strip,
   * a tile, a change; all of it for a whole frame). A pan along a screen of
   * masked pictures then draws them over the strip it uncovered, not over
   * the whole screen each frame. A layer's pixels there don't depend on how
   * far past them the canvas reaches, but for glass and background blur,
   * which read around them: a pass that draws one with its effect draws
   * all it reads too (`#withReaders`). Null when none of it is being drawn.
   */
  #maskedPart(
    whole: { x0: number; y0: number; x1: number; y1: number },
    camera: Camera,
    dpr: number,
    visible: Rect,
  ): { x0: number; y0: number; x1: number; y1: number } | null {
    let part: { x0: number; y0: number; x1: number; y1: number } | null = null;
    for (const r of this.#parts ?? [visible]) {
      // A pixel or two more, for antialiasing.
      const x0 = Math.max(whole.x0, Math.floor((r.x * camera.zoom + camera.x) * dpr) - 2);
      const y0 = Math.max(whole.y0, Math.floor((r.y * camera.zoom + camera.y) * dpr) - 2);
      const x1 = Math.min(
        whole.x1,
        Math.ceil(((r.x + r.width) * camera.zoom + camera.x) * dpr) + 2,
      );
      const y1 = Math.min(
        whole.y1,
        Math.ceil(((r.y + r.height) * camera.zoom + camera.y) * dpr) + 2,
      );
      if (x1 <= x0 || y1 <= y0) continue;
      part = part
        ? {
            x0: Math.min(part.x0, x0),
            y0: Math.min(part.y0, y0),
            x1: Math.max(part.x1, x1),
            y1: Math.max(part.y1, y1),
          }
        : { x0, y0, x1, y1 };
    }
    return part;
  }

  /** Canvases for masked layers and their masks: two per nesting depth, kept while they fit (see `fitted`). */
  #maskCanvas(slot: number, w: number, h: number): AnyCanvas | null {
    const canvas = fitted(this.#maskCanvases[slot] ?? null, w, h);
    if (canvas) this.#maskCanvases[slot] = canvas;
    return canvas;
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
        // Shared by every box of this size and these corners (corners.ts).
        const { radii, smoothing } = layerCorners(node);
        return boxPath2D(w, h, radii, smoothing);
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
   * are an ellipse and an even sweep there, which no pixel-space gradient
   * draws on a layer that isn't square: filled shapes get them exactly
   * (#gradientFill), and strokes and text get a pattern of the same gradient
   * (#gradientPattern). `reach` is how far past the box the style paints (a
   * stroke's outer edge, text's overhang): the pattern covers that much.
   */
  #paintStyle(
    ctx: Ctx,
    paint: Paint,
    w: number,
    h: number,
    reach = Math.max(w, h) / 4,
  ): string | CanvasGradient | CanvasPattern | null {
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
    if (paint.type === "radial" || paint.type === "angular" || paint.type === "diamond")
      return this.#gradientPattern(ctx, paint, w, h, reach);
    return null; // Images arrive with the asset pipeline.
  }

  /**
   * A radial or angular gradient as a pattern in the layer's units: the exact
   * gradient (as #gradientFill draws it) drawn once into a canvas covering
   * the box and `reach` around it, at the zoom rounded up to a power of two
   * (so it's redrawn only as the zoom crosses one) and at most PATTERN_MAX_SIDE
   * pixels a side. Kept per paint, so a frame only makes a pattern from it.
   * Null when the handles meet, as the canvas then draws nothing.
   */
  #gradientPattern(
    ctx: Ctx,
    paint: GradientPaint,
    w: number,
    h: number,
    reach: number,
  ): CanvasPattern | null {
    const m = gradientMatrix(paint, w, h);
    if (!m) return null;
    const t = ctx.getTransform();
    const zoom = Math.sqrt(Math.abs(t.a * t.d - t.b * t.c)) || 1;
    const fullW = w + 2 * reach;
    const fullH = h + 2 * reach;
    const k = Math.min(2 ** Math.ceil(Math.log2(zoom)), PATTERN_MAX_SIDE / Math.max(fullW, fullH));
    let raster = this.#gradientRasters.get(paint);
    if (!raster || raster.w !== w || raster.h !== h || raster.reach !== reach || raster.k !== k) {
      const width = Math.max(1, Math.ceil(fullW * k));
      const height = Math.max(1, Math.ceil(fullH * k));
      const canvas =
        typeof OffscreenCanvas !== "undefined"
          ? new OffscreenCanvas(width, height)
          : Object.assign(document.createElement("canvas"), { width, height });
      const c = canvas.getContext("2d") as Ctx | null;
      if (!c) return null;
      if (paint.type === "diamond") {
        // Exact diamond gradient: t = clamp(|u| + |v|, 0, 1) in unit gradient space, unpremultiplied stops.
        const img = c.createImageData(width, height);
        const data = img.data;
        const opacity = paint.opacity ?? 1;
        const stops = [...paint.stops]
          .map((s, idx) => {
            const h = s.color.trim();
            const hex = (i: number) => Number.parseInt(h.slice(i, i + 2), 16) / 255;
            const valid = /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(h);
            const r = valid ? hex(1) : 0;
            const g = valid ? hex(3) : 0;
            const b = valid ? hex(5) : 0;
            const a = (valid && h.length >= 9 ? hex(7) : 1) * opacity;
            return { pos: Math.min(1, Math.max(0, s.position)), r, g, b, a, idx };
          })
          .sort((a, b) => a.pos - b.pos || a.idx - b.idx);
        const [m0, m1, m2, m3, m4, m5] = m;
        // Map pixel (px, py) -> layer (px / k - reach, py / k - reach) -> unit gradient (u, v).
        const det = m0 * m3 - m1 * m2;
        const ia = m3 / det;
        const ib = -m1 / det;
        const ic = -m2 / det;
        const id = m0 / det;
        const ie = (m2 * m5 - m3 * m4) / det;
        const jf = (m1 * m4 - m0 * m5) / det;
        const first = stops[0];
        if (first) {
          for (let py = 0; py < height; py++) {
            const ly = (py + 0.5) / k - reach;
            const baseU = ic * ly + ie;
            const baseV = id * ly + jf;
            for (let px = 0; px < width; px++) {
              const lx = (px + 0.5) / k - reach;
              const u = ia * lx + baseU;
              const v = ib * lx + baseV;
              const t = Math.min(1, Math.abs(u) + Math.abs(v));
              let r = first.r;
              let g = first.g;
              let b = first.b;
              let a = first.a;
              if (t > first.pos) {
                for (let i = 1; i < stops.length; i++) {
                  const s1 = stops[i] as (typeof stops)[number];
                  if (t <= s1.pos) {
                    const s0 = stops[i - 1] as (typeof stops)[number];
                    const span = s1.pos - s0.pos;
                    if (span > 0) {
                      const f = Math.min(1, Math.max(0, (t - s0.pos) / span));
                      r = s0.r + (s1.r - s0.r) * f;
                      g = s0.g + (s1.g - s0.g) * f;
                      b = s0.b + (s1.b - s0.b) * f;
                      a = s0.a + (s1.a - s0.a) * f;
                    } else {
                      r = s1.r;
                      g = s1.g;
                      b = s1.b;
                      a = s1.a;
                    }
                    break;
                  }
                  r = s1.r;
                  g = s1.g;
                  b = s1.b;
                  a = s1.a;
                }
              }
              const idx = (py * width + px) * 4;
              data[idx] = Math.round(r * 255);
              data[idx + 1] = Math.round(g * 255);
              data[idx + 2] = Math.round(b * 255);
              data[idx + 3] = Math.round(a * 255);
            }
          }
        }
        c.putImageData(img, 0, 0);
      } else {
        // Layer units to the canvas's pixels, then the unit gradient onto the layer.
        c.setTransform(k, 0, 0, k, reach * k, reach * k);
        c.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
        const gradient =
          paint.type === "radial"
            ? c.createRadialGradient(0, 0, 0, 0, 0, 1)
            : // Conic gradients start at 3 o'clock and turn clockwise: here, toward `to`.
              c.createConicGradient(0, 0, 0);
        for (const stop of paint.stops)
          gradient.addColorStop(stop.position, hexToRgba(stop.color, paint.opacity ?? 1));
        c.fillStyle = gradient;
        const box = boxInGradientSpace(m, w, h, reach);
        c.fillRect(box.x, box.y, box.width, box.height);
      }
      raster = { canvas, w, h, reach, k };
      this.#gradientRasters.set(paint, raster);
    }
    const pattern = ctx.createPattern(raster.canvas, "no-repeat");
    // The canvas's pixels back to layer units.
    pattern?.setTransform({ a: 1 / k, b: 0, c: 0, d: 1 / k, e: -reach, f: -reach });
    return pattern;
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
    this.#blended(ctx, paint.blendMode, deviceBox(ctx, 0, 0, w, h, 1), (c) => c.fill(shape, rule));
  }

  /**
   * Draws `draw` blended by `mode` (a paint's or a shadow's) into `ctx`, in
   * place of the layer's own blending; `box` (device pixels) bounds what it
   * paints, for linear burn, which is drawn apart (see linear-blend.ts).
   */
  #blended(
    ctx: Ctx,
    mode: BlendMode | undefined,
    box: DeviceBox,
    draw: (c: Ctx) => void,
    /** Drawn apart and then blended in, whatever the mode: shadows (see BlendApart). */
    apart = false,
  ): void {
    if (!mode || mode === "normal") {
      draw(ctx);
      return;
    }
    // A coarse pass (decision 0042) leaves out shadows that blend their own way: drawn apart,
    // each costs a canvas of its own, and a glass board has three on every control. They're
    // drawn with the readers' exact pass.
    if (this.#coarse && apart) return;
    const opaque = this.#opaque.has(ctx.canvas);
    if (mode === "linear-burn" || (mode === "linear-dodge" && (apart || !opaque))) {
      this.#burn.blend(ctx, box, mode, draw, opaque);
      return;
    }
    if (apart) {
      this.#burn.blend(ctx, box, BLEND[mode] ?? "source-over", draw, opaque);
      return;
    }
    const before = ctx.globalCompositeOperation;
    ctx.globalCompositeOperation = BLEND[mode] ?? "source-over";
    draw(ctx);
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
    if (paint.blendMode && paint.blendMode !== "normal") {
      const { blendMode, ...plain } = paint;
      this.#blended(ctx, blendMode, deviceBox(ctx, 0, 0, w, h, 1), (c) =>
        this.#gradientFill(c, shape, plain, w, h, rule),
      );
      return;
    }
    ctx.save();
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
    if (paint.blendMode && paint.blendMode !== "normal") {
      const { blendMode, ...plain } = paint;
      this.#blended(ctx, blendMode, deviceBox(ctx, 0, 0, w, h, 1), (c) =>
        this.#imageFill(c, shape, plain, w, h, node),
      );
      return;
    }
    ctx.save();
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
    // A miter can reach five weights past the edge (the canvas's limit of 10, halved).
    const reach = weight * 5 + 1;
    for (const paint of strokes) {
      const style = this.#paintStyle(ctx, paint, w, h, reach);
      if (!style) continue;
      ctx.strokeStyle = style;
      this.#blended(ctx, paint.blendMode, deviceBox(ctx, 0, 0, w, h, reach), (c) => {
        if (pieces) {
          for (const piece of pieces) {
            c.setLineDash(piece.dashes);
            c.lineDashOffset = piece.offset;
            c.stroke(piece.path);
          }
        } else c.stroke(line);
        if (!markers) return;
        c.save();
        c.setLineDash([]);
        c.lineJoin = "round";
        c.lineCap = "round";
        c.fillStyle = style;
        for (const marker of [markers.start, markers.end]) {
          if (marker.fill) c.fill(new Path2D(serializePath(marker.fill)));
          if (marker.stroke) c.stroke(new Path2D(serializePath(marker.stroke)));
        }
        c.restore();
      });
    }
    ctx.restore();
  }
  /** A stroke with a width per side (see stroke-sides.ts): its region, filled with each paint. */
  #sideStrokes(ctx: Ctx, node: NodeRecord, strokes: readonly Paint[], w: number, h: number) {
    let path = this.#sidePaths.get(node.props);
    if (!path) {
      const { radii, smoothing } = layerCorners(node);
      const region = strokeRegion(
        w,
        h,
        radii,
        strokeWidths(node),
        getProp(node.props, "strokeAlign"),
        smoothing,
      );
      path = new Path2D(strokeRegionPath(region));
      this.#sidePaths.set(node.props, path);
    }
    ctx.save();
    ctx.filter = "none";
    const reach = Math.max(...strokeWidths(node)) + 1;
    const region = path;
    for (const paint of strokes) {
      const style = this.#paintStyle(ctx, paint, w, h, reach);
      if (!style) continue;
      ctx.fillStyle = style;
      this.#blended(ctx, paint.blendMode, deviceBox(ctx, 0, 0, w, h, reach), (c) =>
        c.fill(region, "evenodd"),
      );
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
      // What it can paint: an inner shadow stays in the box, a drop shadow reaches past it.
      const pad =
        kind === "inner-shadow"
          ? 1
          : Math.abs(s.x) + Math.abs(s.y) + s.blur * 1.5 + Math.abs(s.spread) + 1;
      // Its own blending (Apple adds its glass's shadows by linear dodge and burn), else the layer's.
      this.#blended(
        ctx,
        s.blendMode,
        deviceBox(ctx, 0, 0, width, height, pad),
        (ctx) => {
          ctx.save();
          ctx.filter = "none";
          ctx.shadowColor = hexToRgba(s.color);
          ctx.shadowBlur = s.blur * scale;
          ctx.shadowOffsetX = s.x * scale;
          ctx.shadowOffsetY = s.y * scale;
          const evenOdd = node.type === "path" && getProp(node.props, "windingRule") === "evenodd";
          const fillRule: CanvasFillRule = evenOdd ? "evenodd" : "nonzero";
          if (kind === "drop-shadow") {
            const openStrokeOnly =
              (node.type === "line" ||
                (node.type === "path" && !isClosedPath(getProp(node.props, "pathData")))) &&
              !getProp(node.props, "fills").some(
                (p) => p.visible !== false && (p.opacity ?? 1) > 0,
              );
            // Cast as Figma casts it (decision 0031): cut out under the shape where it mustn't show there.
            const cast = dropShadowCast(node, s);
            if (cast.cutOut && !openStrokeOnly) {
              const outside = new Path2D();
              outside.rect(-1e5, -1e5, 2e5, 2e5);
              outside.addPath(shape);
              ctx.clip(outside, "evenodd");
            }
            // Paint only the shadow: draw the shape far off-canvas and offset its
            // shadow back into place, so translucent fills don't show a dark copy.
            const t = ctx.getTransform();
            const far = 1e5 / Math.max(1e-9, Math.hypot(t.a, t.b));
            ctx.shadowOffsetX = s.x * scale - t.a * far;
            ctx.shadowOffsetY = s.y * scale - t.b * far;
            ctx.translate(far, 0);
            if (node.type === "text") this.#text(ctx, node, width, "#000", scale);
            else if (openStrokeOnly) {
              const weight = getProp(node.props, "strokeWeight");
              const hasStroke =
                weight > 0 &&
                getProp(node.props, "strokes").some(
                  (p) => p.visible !== false && (p.opacity ?? 1) > 0,
                );
              if (hasStroke) {
                const cap = getProp(node.props, "strokeCap");
                const dashes = getProp(node.props, "strokeDashes");
                ctx.strokeStyle = "#000";
                ctx.lineWidth = weight;
                ctx.lineJoin = getProp(node.props, "strokeJoin");
                ctx.lineCap = cap === "none" ? "butt" : cap;
                ctx.miterLimit = 10;
                ctx.setLineDash(
                  dashes.every((d) => Number.isFinite(d) && d >= 0) ? [...dashes] : [],
                );
                ctx.stroke(shape);
              }
            } else {
              ctx.fillStyle = "#000";
              ctx.fill(this.#spreadShape(node, shape, width, height, cast.spread), fillRule);
            }
          } else {
            ctx.clip(shape, fillRule);
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
        },
        true,
      );
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
      const { radii, smoothing } = layerCorners(node);
      return boxPath2D(
        gw,
        gh,
        spreadRadii(w, h, radii, smoothing, spread),
        smoothing,
        -spread,
        -spread,
      );
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
    if (this.#coarse && ctx === this.#screen && node.type !== "text") {
      this.#coarseFrost(ctx, node, shape, sigma);
      return;
    }
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
    const from = this.#backdropFor(ctx, node, reach + 1);
    if (from === "done") return;
    const within = this.#clipWithin(ctx, node);
    if (from)
      copyExtended(
        from.canvas,
        behind,
        x0 - from.x,
        y0 - from.y,
        x1 - x0,
        y1 - y0,
        within && shiftBounds(within, from.x, from.y),
      );
    else copyExtended(ctx.canvas, behind, x0, y0, x1 - x0, y1 - y0, within);
    if (node.type === "text") {
      // As in Figma, the layer is its fills over the blur, cut to its glyphs once: under
      // opaque fills none of the blur shows, not even at the glyphs' anti-aliased edges.
      if (getProp(node.props, "fills").some(hidesWhatsUnder)) return;
      // Otherwise it shows where the layer paints: under its glyphs, not its box.
      this.#blurGlyphs = scratch(this.#blurGlyphs, x1 - x0, y1 - y0);
      const glyphs = this.#blurGlyphs?.getContext("2d") as Ctx | null | undefined;
      if (!this.#blurGlyphs || !glyphs) return;
      resetState(glyphs);
      glyphs.clearRect(0, 0, x1 - x0, y1 - y0);
      glyphs.filter = `blur(${sigma}px)`;
      glyphs.drawImage(this.#blurBackdrop, 0, 0);
      glyphs.filter = "none";
      glyphs.globalCompositeOperation = "destination-in";
      glyphs.setTransform(t.a, t.b, t.c, t.d, t.e - x0, t.f - y0);
      this.#text(glyphs, node, w, "#ffffff", scale);
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
      ctx.drawImage(this.#blurGlyphs, x0, y0);
      ctx.restore();
      return;
    }
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
   * A reader drawn coarse, for frames while something moves (decision 0042):
   * what's under its shape on the canvas, blurred `sigma` device pixels, in
   * place: one copy of the canvas into itself through a blur, no shader
   * passes of its own. Glass loses its rim's bend and light until it's drawn exactly;
   * background blur is what it is, a little coarser at the edge of what's
   * redrawn.
   */
  #coarseFrost(ctx: Ctx, node: NodeRecord, shape: Path2D, sigma: number): void {
    const t = ctx.getTransform();
    const w = getProp(node.props, "width");
    const h = getProp(node.props, "height");
    const xs = [t.e, t.a * w + t.e, t.c * h + t.e, t.a * w + t.c * h + t.e];
    const ys = [t.f, t.b * w + t.f, t.d * h + t.f, t.b * w + t.d * h + t.f];
    const reach = Math.ceil(sigma * 3) + 1;
    const { width, height } = ctx.canvas;
    const x0 = Math.max(0, Math.floor(Math.min(...xs)) - reach);
    const y0 = Math.max(0, Math.floor(Math.min(...ys)) - reach);
    const x1 = Math.min(width, Math.ceil(Math.max(...xs)) + reach);
    const y1 = Math.min(height, Math.ceil(Math.max(...ys)) + reach);
    ctx.save();
    ctx.clip(shape);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.filter = sigma > 0.5 ? `blur(${sigma}px)` : "none";
    ctx.drawImage(ctx.canvas, x0, y0, x1 - x0, y1 - y0, x0, y0, x1 - x0, y1 - y0);
    ctx.restore();
  }

  /**
   * The device box of the frames that clip `node` (their boxes intersected),
   * in `ctx`'s current transform, which is set for `node`: what its glass or
   * background blur may see, as in Figma, which doesn't show them what's
   * outside. Undefined when nothing clips it.
   */
  #clipWithin(ctx: Ctx, node: NodeRecord): Bounds | undefined {
    const doc = this.#scene.doc;
    const t = ctx.getTransform();
    const toLocal = invert(this.#scene.worldMatrix(node.id));
    let out: Bounds | undefined;
    for (let a = doc.get(node.parent); a && a.type !== "page"; a = doc.get(a.parent)) {
      if (a.type !== "frame" || !getProp(a.props, "clipContent")) continue;
      const m = this.#scene.worldMatrix(a.id);
      const w = getProp(a.props, "width");
      const h = getProp(a.props, "height");
      const xs: number[] = [];
      const ys: number[] = [];
      for (const [px, py] of [
        [0, 0],
        [w, 0],
        [0, h],
        [w, h],
      ] as const) {
        const local = apply(toLocal, apply(m, { x: px, y: py }));
        xs.push(t.a * local.x + t.c * local.y + t.e);
        ys.push(t.b * local.x + t.d * local.y + t.f);
      }
      // Past the nearest clipping frame lies its own fill (a solid one; else its edge repeats),
      // as Figma's glass sees it.
      const fill = [...getProp(a.props, "fills")]
        .reverse()
        .find((f) => f.visible !== false && f.type === "solid" && (f.opacity ?? 1) >= 1);
      const box = {
        x0: Math.min(...xs),
        y0: Math.min(...ys),
        x1: Math.max(...xs),
        y1: Math.max(...ys),
        ...(fill?.type === "solid" ? { fill: fill.color } : {}),
      };
      out = out
        ? {
            ...out,
            x0: Math.max(out.x0, box.x0),
            y0: Math.max(out.y0, box.y0),
            x1: Math.min(out.x1, box.x1),
            y1: Math.min(out.y1, box.y1),
          }
        : box;
    }
    return out;
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
    if (this.#coarse && ctx === this.#screen && node.type !== "text") {
      // Coarse while moving (decision 0042): the backdrop frosted, without the rim's bend.
      this.#coarseFrost(ctx, node, shape, Math.max(glassParams(glass, scale).frost, 3 * scale));
      return;
    }
    const key = ctx === this.#screen ? { id: node.id, generation: this.#generation } : null;
    const outline =
      node.type === "text" ? (mask: Ctx) => this.#text(mask, node, w, "#ffffff", scale) : shape;
    // As in Figma, the rim is no deeper than the shape is thick.
    const inradius =
      node.type === "rect" || node.type === "frame" || node.type === "ellipse"
        ? Math.min(w, h) / 2
        : this.#inradii.get(
            node.props,
            w,
            h,
            (c) => {
              if (node.type === "text") this.#text(c, node, w, "#ffffff");
              else c.fill(shape);
            },
            this.#measurer.generation ?? 0,
          );
    // A box's rim is measured from its exact edge: square corners stay square.
    const box = node.type === "rect" || node.type === "frame";
    const corners = box ? layerCorners(node) : null;
    const within = this.#clipWithin(ctx, node);
    const reach = glassParams(glass, scale);
    const from = this.#backdropFor(ctx, node, reach.margin + Math.ceil(3 * reach.sigma) + 2);
    if (from === "done") return;
    this.#glass.paint(ctx, outline, w, h, glass, scale, {
      ...(from ? { source: from } : {}),
      key,
      inradius,
      corners: corners?.radii ?? null,
      smoothing: corners?.smoothing ?? 0,
      kind: node.type === "ellipse" ? "ellipse" : "other",
      opaque: this.#opaque.has(ctx.canvas),
      ...(within ? { within } : {}),
    });
  }

  /** Text too small to read: a bar per line, the last one shorter, in the text's colour. */
  #greek(ctx: Ctx, node: NodeRecord, width: number, override?: string): void {
    const props = node.props;
    const size = getProp(props, "fontSize");
    const { lines, lh } = greekLines(node, this.#measurer);
    const height = getProp(props, "height");
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

    const saved = this.#saved(node);
    const outline = (frag: TextFragment, x: number, y: number) => {
      const shaped = frag.run ? (this.#measurer.shape?.(frag.text, frag.run) ?? null) : null;
      return shaped
        ? this.#placed(this.#shapedOutline(shaped, frag.text, frag.letterSpacing), x, y)
        : null;
    };
    /**
     * Each glyph run, where #text draws it: `paint` strokes or fills its outline, or its
     * text where it has none. Saved glyphs (decision 0037) are outlines, a path per group.
     */
    const eachRun = (
      c: Ctx,
      paint: (path: Path2D | null, frag: TextFragment | null, x: number, y: number) => void,
    ) => {
      if (saved) {
        for (const group of savedGlyphGroups(saved, node))
          paint(this.#savedPath(group), null, 0, 0);
        return;
      }
      for (const line of layout.lines) {
        const x0 = lineOffset(line, width, node.props);
        const y = drawnBaseline(line, dy);
        // Stroke list markers along with their line's runs, matching Figma and the render engine.
        const marker = line.marker;
        if (marker) {
          typeset(c, marker.font);
          c.direction = "ltr";
          c.textAlign = "left";
          if (spaced) (c as Ctx & { letterSpacing: string }).letterSpacing = "0px";
          paint(null, { text: marker.text } as TextFragment, x0 + marker.x, y);
        }
        for (const frag of line.fragments) {
          if (!frag.text) continue;
          typeset(c, frag.font);
          c.direction = frag.direction ?? "ltr";
          c.textAlign = "left";
          if (spaced)
            (c as Ctx & { letterSpacing: string }).letterSpacing = `${frag.letterSpacing}px`;
          const x = x0 + frag.x;
          paint(outline(frag, x, y), frag, x, y);
        }
      }
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
        eachRun(c, (path, frag, x, y) => {
          if (path) c.stroke(path);
          else if (frag) c.strokeText(frag.text, x, y);
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
    eachRun(s, (path, frag, x, y) => {
      if (path) s.fill(path);
      else if (frag) s.fillText(frag.text, x, y);
    });
    s.globalCompositeOperation = "source-over";
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.filter = "none";
    ctx.drawImage(scratch, 0, 0, w, h, x0, y0, w, h);
    ctx.restore();
  }

  /** The saved glyphs a text layer is drawn from (decision 0037), or null. */
  #saved(node: NodeRecord): SavedText | null {
    // The text being edited shows every line as it's laid out now.
    if (node.id === this.whole) return null;
    return savedText(node, this.#measurer, glyphTable(this.#scene.doc));
  }

  /** A group of saved glyphs as a path, made once. */
  #savedPath(group: SavedGlyphGroup): Path2D {
    let path = this.#savedPaths.get(group);
    if (!path) {
      path = new Path2D(group.d);
      this.#savedPaths.set(group, path);
    }
    return path;
  }

  /** Saved glyphs filled as #text fills laid-out text: each group in its paints, with its bars. */
  #savedFill(
    ctx: Ctx,
    node: NodeRecord,
    saved: SavedText,
    width: number,
    override: string | undefined,
  ): void {
    const height = getProp(node.props, "height");
    const layerFills = getProp(node.props, "fills");
    const black: Paint[] = [{ type: "solid", color: "#000000" }];
    const styles = new Map<Paint, string | CanvasGradient | CanvasPattern | null>();
    for (const group of savedGlyphGroups(saved, node)) {
      const paints = override
        ? black
        : (group.fills ?? (layerFills.length > 0 ? layerFills : black));
      const path = this.#savedPath(group);
      for (const paint of paints) {
        if (paint.visible === false) continue;
        if (!styles.has(paint)) styles.set(paint, this.#paintStyle(ctx, paint, width, height));
        const style = override ?? styles.get(paint) ?? null;
        if (!style) continue;
        ctx.fillStyle = style;
        ctx.fill(path);
        for (const bar of group.bars) ctx.fillRect(bar.x, bar.y, bar.w, bar.h);
      }
    }
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
    // Its font isn't here and it's as its file laid it out: the glyphs the file saved.
    const saved = this.#saved(node);
    if (saved) {
      this.#savedFill(ctx, node, saved, width, override);
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
    const paintsOf = (fills: readonly Paint[] | null | undefined) =>
      override ? black : (fills ?? (layerFills.length > 0 ? layerFills : black));
    // Draws the text, or with `only`, just each run's paint at that place in its list
    // (one paint at a time, so a linear burn is drawn apart in one pass: linear-blend.ts).
    // Linear blends drawn apart: burn, and dodge where the canvas may be see-through.
    const opaque = this.#opaque.has(ctx.canvas);
    const apartMode = (mode: BlendMode | undefined) =>
      mode === "linear-burn" || (mode === "linear-dodge" && !opaque) ? mode : null;
    const pass = (c: Ctx, only?: { index: number; apart: BlendMode | null }) => {
      const each = (paints: readonly Paint[], fill: () => void) => {
        paints.forEach((paint, i) => {
          if (paint.visible === false || (only && i !== only.index)) return;
          const mode = override ? undefined : paint.blendMode;
          if (only && apartMode(mode) !== only.apart) return;
          const style = override ?? styleOf(paint);
          if (!style) return;
          c.fillStyle = style;
          if (!mode || mode === "normal" || apartMode(mode)) fill();
          else {
            const before = c.globalCompositeOperation;
            c.globalCompositeOperation = BLEND[mode] ?? "source-over";
            fill();
            c.globalCompositeOperation = before;
          }
        });
      };
      for (const line of layout.lines) {
        const x0 = lineOffset(line, width, node.props);
        const baseline = drawnBaseline(line, dy);
        // A list item's bullet or number, in its first character's style.
        const marker = line.marker;
        if (marker && !(this.#detail && marker.fontSize * scale < GREEK_BELOW)) {
          typeset(c, marker.font);
          c.direction = "ltr";
          c.textAlign = "left";
          if (spaced) (c as Ctx & { letterSpacing: string }).letterSpacing = "0px";
          each(paintsOf(marker.fills), () => c.fillText(marker.text, x0 + marker.x, baseline));
        }
        for (const frag of line.fragments) {
          typeset(c, frag.font);
          c.direction = frag.direction ?? "ltr";
          c.textAlign = "left";
          if (spaced)
            (c as Ctx & { letterSpacing: string }).letterSpacing = `${frag.letterSpacing}px`;
          const x = x0 + frag.x;
          each(paintsOf(frag.fills), () => {
            if (this.#detail && frag.fontSize * scale < GREEK_BELOW) {
              // A small run in readable text.
              // Unreadable at this zoom: a bar where the glyphs are, far cheaper to draw.
              const alpha = c.globalAlpha;
              c.globalAlpha = alpha * 0.55;
              c.fillRect(x, baseline - frag.fontSize * 0.62, frag.width, frag.fontSize * 0.5);
              c.globalAlpha = alpha;
              return;
            }
            // OpenType features: the shaped glyphs, when the shaper has them (else as the canvas sets it).
            const shaped = frag.run ? (this.#measurer.shape?.(frag.text, frag.run) ?? null) : null;
            if (shaped)
              c.fill(
                this.#placed(
                  this.#shapedOutline(shaped, frag.text, frag.letterSpacing),
                  x,
                  baseline,
                ),
              );
            else c.fillText(frag.text, x, baseline);
            if (frag.decoration !== "none") {
              const bar = decorationBar(frag.decoration, baseline, frag.fontSize);
              c.fillRect(x, bar.y, frag.width, bar.height);
            }
          });
        }
      }
    };
    // Paints blended apart (Apple's vibrant labels): each paint in turn, those apart in a pass each.
    let depth = 0;
    const modes = new Set<BlendMode>();
    if (!override)
      for (const line of layout.lines)
        for (const fills of [line.marker?.fills, ...line.fragments.map((f) => f.fills)]) {
          const paints = paintsOf(fills);
          depth = Math.max(depth, paints.length);
          for (const p of paints) {
            const mode = p.visible === false ? null : apartMode(p.blendMode);
            if (mode) modes.add(mode);
          }
        }
    if (modes.size === 0) {
      pass(ctx);
      return;
    }
    // Glyphs reach past the box: as far as the largest font around it.
    const box = deviceBox(ctx, 0, 0, width, height, largestFontSize(node));
    for (let index = 0; index < depth; index++) {
      pass(ctx, { index, apart: null });
      for (const mode of modes)
        this.#burn.blend(
          ctx,
          box,
          mode as "linear-dodge" | "linear-burn",
          (c) => pass(c, { index, apart: mode }),
          opaque,
        );
    }
  }
}

const isLowSurrogate = (c: number) => c >= 0xdc00 && c <= 0xdfff;
