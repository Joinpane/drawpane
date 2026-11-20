/**
 * One layer as a display-list record (docs/decisions/0040-display-list.md): what the canvas
 * renderer draws for it (`render.ts`, `#drawLayer`), resolved here, in TypeScript, where the
 * document and every rule about *what* is drawn live. The engine only draws.
 *
 * What phase 1's engine doesn't draw (effects, masks, blend modes other than normal, text
 * whose outlines aren't to hand) is flagged in the record's `unsupported` bits, never drawn
 * around: a page with any falls back to the canvas renderer whole.
 */
import {
  BLEND,
  CAP,
  COMPOSE,
  FLAG,
  GLASS_KIND,
  type GradientStop,
  JOIN,
  MASK,
  type Matrix,
  NOISE_TYPE,
  PathData,
  type PathEntry,
  type Rgba,
  type StrokeStyle,
  UNSUPPORTED,
  type WireOp,
  type WirePaint,
  type WirePostEffect,
  type WireRecord,
} from "@drawpane/engine/wire";
import {
  type BlendMode,
  GLYPH_UNITS,
  type Glass,
  getProp,
  type NodeRecord,
  type Paint,
} from "@drawpane/model";
import { fitCorners } from "../corner-geometry";
import { layerCorners, spreadRadii } from "../corners";
import { boxOutline, ellipseOutline, fitDashes } from "../dashes";
import { boxOf, localMatrix } from "../geometry";
import { gradientMatrix } from "../gradients";
import { imagePlacement } from "../images";
import { markersOf, trimmedStroke } from "../markers";
import { clipsByShape, endsMask, isActiveMask } from "../masks";
import { postEffects } from "../post-effects";
import { paintMargin } from "../reach";
import { fadesAsOne, GREEK_BELOW, greekLines, largestFontSize } from "../render";
import { textSpans } from "../rich-text";
import { glyphTable, type SavedText, savedText } from "../saved-glyphs";
import type { Scene } from "../scene";
import { dropShadowCast } from "../shadows";
import { isUniform, strokeRegion, strokeRegionPath, strokeWidths } from "../stroke-sides";
import {
  decorationBar,
  drawnBaseline,
  drawnFamily,
  layoutText,
  lineOffset,
  type ShapedText,
  type ShapingRun,
  type TextMeasurer,
  textBlockOffset,
} from "../text";
import { isClosedPath } from "../vector/cache";
import { nodePath } from "../vector/shapes";
import { serializePath } from "../vector/svg";
import { svgPathData } from "./svg-path";

export interface LayerContext {
  readonly scene: Scene;
  readonly measurer: TextMeasurer;
  /** An image's engine handle and natural size once the engine holds its pixels, else null. */
  image(
    ref: string,
  ): { readonly handle: number; readonly width: number; readonly height: number } | null;
  /** A glyph outline (SVG path data in font units, y up) as an engine glyph handle. */
  glyph(d: string): number;
  /** The same for a shaped glyph, remembered by the glyph itself (the shaper keeps its runs). */
  shapedGlyph?(g: { readonly d: string }): number;
  /** The text being edited: drawn from its live layout, every line. */
  readonly whole: string | null;
  /** Layers hidden while dragged into place. */
  readonly hidden: ReadonlySet<string>;
  /**
   * Text isn't shaped: it's sent as its coarse bars, flagged provisional, and encoded whole
   * later (a page opening shows its first frame sooner; decision 0040, phase 2).
   */
  readonly deferText?: boolean;
}

export interface EncodedLayer {
  readonly record: WireRecord;
  /** Image refs it paints (so it's encoded again when one arrives). */
  readonly images: readonly string[];
  /** Text it couldn't outline (no face will come): encoded again when shaping can. */
  readonly textPending: boolean;
  /** Sent provisional (`LayerContext.deferText`): to be encoded whole. */
  readonly deferred: boolean;
  /**
   * Faces its text waits for while their files load (`TextMeasurer.loading`): it's sent
   * provisional, its coarse bars, and encoded again when they arrive.
   */
  readonly waiting: readonly string[];
}

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
const shows = (p: Paint) => p.visible !== false;

/** "#rrggbb" or "#rrggbbaa" times `opacity`, as straight RGBA floats. */
export function rgba(hex: string, opacity = 1): Rgba {
  const h = hex.trim();
  const v = (i: number) => Number.parseInt(h.slice(i, i + 2), 16) / 255;
  if (!/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(h)) return [0, 0, 0, opacity];
  const a = h.length >= 9 ? v(7) : 1;
  return [v(1), v(3), v(5), a * opacity];
}

/** A paint as the engine paints it in a box `w` × `h`, or null when it paints nothing here. */
function wirePaint(paint: Paint, w: number, h: number, alpha = 1): WirePaint | null {
  const opacity = (paint.opacity ?? 1) * alpha;
  const blend = blendCode(paint.blendMode);
  const withBlend = blend !== 0 ? { blend } : {};
  if (paint.type === "solid")
    return { kind: "solid", color: rgba(paint.color, opacity), ...withBlend };
  if (paint.type === "image") return null; // Placed by the caller, which needs the shape.
  const m = gradientMatrix(paint, w, h);
  if (!m) return null;
  const stops: GradientStop[] = paint.stops.map((s) => ({
    position: s.position,
    color: rgba(s.color, opacity),
  }));
  return { kind: paint.type, matrix: m, stops, ...withBlend };
}

function blendCode(mode: BlendMode | undefined): number {
  if (!mode || mode === "normal") return BLEND.normal;
  return BLEND[mode] ?? BLEND.normal;
}

/**
 * The layer's shape grown (or shrunk, for negative spread) by `spread` on every side, matching
 * `render.ts`'s `#spreadShape`. Returns `null` when a box or ellipse shrinks to empty.
 */
function spreadEntry(
  b: Builder,
  node: NodeRecord,
  shape: number,
  w: number,
  h: number,
  spread: number,
): number | null {
  if (spread === 0) return shape;
  const gw = Math.max(0, w + spread * 2);
  const gh = Math.max(0, h + spread * 2);
  if (node.type === "ellipse") {
    if (gw <= 0 || gh <= 0) return null;
    return b.path({ kind: "oval", x: -spread, y: -spread, w: gw, h: gh });
  }
  if (node.type === "rect" || node.type === "frame") {
    if (gw <= 0 || gh <= 0) return null;
    const { radii, smoothing } = layerCorners(node);
    const sr = spreadRadii(w, h, radii, smoothing, spread);
    const fitted = fitCorners(gw, gh, sr, 0);
    return b.path({
      kind: "box",
      x: -spread,
      y: -spread,
      w: gw,
      h: gh,
      radii: [fitted[0].radius, fitted[1].radius, fitted[2].radius, fitted[3].radius],
      smoothing: 0,
    });
  }
  return shape;
}

function emitDropShadows(
  b: Builder,
  node: NodeRecord,
  shape: number,
  evenOdd: boolean,
  w: number,
  h: number,
): void {
  const open =
    node.type === "line" ||
    (node.type === "path" && !isClosedPath(getProp(node.props, "pathData")));
  const openStrokeOnly = open && !getProp(node.props, "fills").some(shows);
  const castStroke = (() => {
    if (!openStrokeOnly) return null;
    const strokes = getProp(node.props, "strokes").filter(shows);
    const weight = getProp(node.props, "strokeWeight");
    if (strokes.length === 0 || weight <= 0) return null;
    const cap = getProp(node.props, "strokeCap");
    return strokeStyle(
      weight,
      getProp(node.props, "strokeJoin"),
      cap === "none" ? "butt" : cap,
      getProp(node.props, "strokeDashes"),
    );
  })();
  let outside: number | null = null;
  for (const e of getProp(node.props, "effects")) {
    if (e.visible === false || e.type !== "drop-shadow") continue;
    const col = rgba(e.color);
    if (col[3] <= 0) continue;
    if (openStrokeOnly) {
      if (!castStroke) continue;
      b.ops.push({
        op: "dropShadow",
        paths: [shape],
        evenOdd: false,
        dx: e.x,
        dy: e.y,
        blur: Math.max(0, e.blur),
        color: col,
        blend: blendCode(e.blendMode),
        stroke: castStroke,
      });
      continue;
    }
    const cast = dropShadowCast(node, e);
    // Focus ring (spread, no offset, no blur) round a see-through field draws nothing (0031).
    if (cast.cutOut && cast.spread === 0 && e.x === 0 && e.y === 0 && e.blur === 0) continue;
    const castPath = spreadEntry(b, node, shape, w, h, cast.spread);
    if (castPath === null) continue;
    if (cast.cutOut) {
      if (outside === null) outside = b.path({ kind: "outside", of: shape });
      b.ops.push({ op: "clip", path: outside, evenOdd: true });
    }
    b.ops.push({
      op: "dropShadow",
      paths: [castPath],
      evenOdd,
      dx: e.x,
      dy: e.y,
      blur: Math.max(0, e.blur),
      color: col,
      blend: blendCode(e.blendMode),
    });
    if (cast.cutOut) b.ops.push({ op: "unclip" });
  }
}

function emitInnerShadows(
  b: Builder,
  node: NodeRecord,
  shape: number,
  evenOdd: boolean,
  w: number,
  h: number,
): void {
  for (const e of getProp(node.props, "effects")) {
    if (e.visible === false || e.type !== "inner-shadow") continue;
    const col = rgba(e.color);
    if (col[3] <= 0) continue;
    const hole = spreadEntry(b, node, shape, w, h, -e.spread);
    b.ops.push({
      op: "innerShadow",
      shape,
      hole,
      evenOdd,
      dx: e.x,
      dy: e.y,
      blur: Math.max(0, e.blur),
      color: col,
      blend: blendCode(e.blendMode),
    });
  }
}

/**
 * The local transform: the layer's units to its parent record's. A layer's box is placed in its
 * parent's space, and a group's record is the identity (its children's boxes are in the space
 * the group sits in), so this is the box's own matrix: no world matrix, no inverse.
 */
export function localTransform(node: NodeRecord): Matrix {
  if (node.type === "group") return IDENTITY;
  return localMatrix(boxOf(node));
}

class Builder {
  readonly paths: PathEntry[] = [];
  readonly ops: WireOp[] = [];
  readonly coarse: WireOp[] = [];
  readonly images: string[] = [];
  unsupported = 0;
  textPending = false;
  /** Sent ahead of its real drawing: deferred, or waiting for faces. */
  provisional = false;
  /** Sent ahead of its real drawing because text was deferred (`LayerContext.deferText`). */
  deferred = false;
  /** Faces its text waits for (`TextMeasurer.loading`). */
  readonly waiting = new Set<string>();
  path(entry: PathEntry): number {
    this.paths.push(entry);
    return this.paths.length - 1;
  }
}

/** The layer's own shape, as a path entry. */
function shapeEntry(node: NodeRecord, w: number, h: number): PathEntry {
  switch (node.type) {
    case "ellipse":
      return { kind: "ellipse", w, h };
    case "line":
      return { kind: "path", path: new PathData().moveTo(0, h / 2).lineTo(w, h / 2) };
    case "path":
      return { kind: "path", path: svgPathData(getProp(node.props, "pathData")) };
    case "polygon":
    case "star": {
      const outline = nodePath(node);
      return { kind: "path", path: svgPathData(outline ? serializePath(outline) : "") };
    }
    case "frame":
    case "rect": {
      // Raw radii and smoothing: Rust's geometry.rs fits both with Figma's rule (corner-geometry.ts).
      const { radii, smoothing } = layerCorners(node);
      return {
        kind: "rect",
        w,
        h,
        radii: [radii[0], radii[1], radii[2], radii[3]],
        smoothing,
      };
    }
    default:
      return { kind: "rect", w, h, radii: [0, 0, 0, 0], smoothing: 0 };
  }
}

/** An image fill: the shape clipped, the image placed in it by its scale mode. */
function imageFill(
  b: Builder,
  shape: number,
  evenOdd: boolean,
  paint: Extract<Paint, { type: "image" }>,
  w: number,
  h: number,
  ctx: LayerContext,
): void {
  if (w <= 0 || h <= 0) return;
  b.images.push(paint.ref);
  const blend = blendCode(paint.blendMode);
  const withBlend = blend !== 0 ? { blend } : {};
  const image = ctx.image(paint.ref);
  if (!image) {
    // Loading: the checkerboard over the box, inside the shape (as the canvas renderer draws it).
    b.ops.push({
      op: "fill",
      path: shape,
      evenOdd,
      paint: { kind: "placeholder", opacity: paint.opacity ?? 1, ...withBlend },
    });
    return;
  }
  const place = imagePlacement(paint.scaleMode, { width: w, height: h }, image, paint.crop);
  const opacity = paint.opacity ?? 1;
  if (place.tile) {
    b.ops.push({
      op: "fill",
      path: shape,
      evenOdd,
      paint: {
        kind: "image",
        image: image.handle,
        matrix: [place.width, 0, 0, place.height, 0, 0],
        tile: true,
        opacity,
        ...withBlend,
      },
    });
    return;
  }
  const rect = b.path({
    kind: "path",
    path: new PathData()
      .moveTo(place.x, place.y)
      .lineTo(place.x + place.width, place.y)
      .lineTo(place.x + place.width, place.y + place.height)
      .lineTo(place.x, place.y + place.height)
      .close(),
  });
  b.ops.push({ op: "clip", path: shape, evenOdd });
  b.ops.push({
    op: "fill",
    path: rect,
    evenOdd: false,
    paint: {
      kind: "image",
      image: image.handle,
      matrix: [place.width, 0, 0, place.height, place.x, place.y],
      tile: false,
      opacity,
      ...withBlend,
    },
  });
  b.ops.push({ op: "unclip" });
}

function strokeStyle(
  width: number,
  join: string,
  cap: string,
  dashes: readonly number[],
  offset = 0,
): StrokeStyle {
  // A canvas ignores a dash list with a negative or non-finite entry; an odd one repeats twice.
  const valid = dashes.every((d) => Number.isFinite(d) && d >= 0);
  const list = !valid ? [] : dashes.length % 2 ? [...dashes, ...dashes] : [...dashes];
  return {
    width,
    join: join === "round" ? JOIN.round : join === "bevel" ? JOIN.bevel : JOIN.miter,
    cap: cap === "round" ? CAP.round : cap === "square" ? CAP.square : CAP.butt,
    miter: 10,
    dashes: list,
    dashOffset: offset,
  };
}

/** A box's or ellipse's outline as pieces, each with the dash pattern fitted to it (dashes.ts). */
function dashedPieces(
  node: NodeRecord,
  w: number,
  h: number,
): Array<{ path: PathData; dashes: number[]; offset: number }> | null {
  let outline: ReturnType<typeof boxOutline>;
  if (node.type === "ellipse") outline = ellipseOutline(w, h);
  else if (node.type === "rect" || node.type === "frame") {
    const { radii, smoothing } = layerCorners(node);
    outline = boxOutline(w, h, radii, smoothing);
  } else return null;
  const pattern = getProp(node.props, "strokeDashes");
  return outline.map((piece) => {
    const path = new PathData();
    if (piece.kind === "line") path.moveTo(piece.x0, piece.y0).lineTo(piece.x1, piece.y1);
    else if (piece.kind === "cubic") {
      // A box's corner as corners.ts draws it: its start, then six numbers a cubic.
      const c = piece.pts;
      path.moveTo(c[0] as number, c[1] as number);
      for (let i = 2; i + 5 < c.length; i += 6)
        path.cubicTo(
          c[i] as number,
          c[i + 1] as number,
          c[i + 2] as number,
          c[i + 3] as number,
          c[i + 4] as number,
          c[i + 5] as number,
        );
    } else {
      // An elliptical arc, clockwise (y down), as cubics of at most a quarter turn.
      const steps = Math.max(
        1,
        Math.ceil(Math.abs(piece.end - piece.start) / (Math.PI / 2) - 1e-9),
      );
      const step = (piece.end - piece.start) / steps;
      const k = (4 / 3) * Math.tan(step / 4);
      const at = (t: number) =>
        [piece.cx + piece.rx * Math.cos(t), piece.cy + piece.ry * Math.sin(t)] as const;
      const [x0, y0] = at(piece.start);
      path.moveTo(x0, y0);
      for (let i = 0; i < steps; i++) {
        const a0 = piece.start + step * i;
        const a1 = a0 + step;
        const [c0, s0, c1, s1] = [Math.cos(a0), Math.sin(a0), Math.cos(a1), Math.sin(a1)];
        path.cubicTo(
          piece.cx + piece.rx * (c0 - k * s0),
          piece.cy + piece.ry * (s0 + k * c0),
          piece.cx + piece.rx * (c1 + k * s1),
          piece.cy + piece.ry * (s1 - k * c1),
          piece.cx + piece.rx * c1,
          piece.cy + piece.ry * s1,
        );
      }
    }
    return { path, ...fitDashes(piece.length, pattern) };
  });
}

/** Strokes on a shape (`render.ts`, `#strokes` and `#sideStrokes`). */
function shapeStrokes(b: Builder, node: NodeRecord, shape: number, w: number, h: number): void {
  const strokes = getProp(node.props, "strokes").filter(shows);
  if (strokes.length === 0) return;
  const sides = strokeWidths(node);
  // Image strokes paint nothing, as on the canvas.
  const paints = () =>
    strokes.map((p) => wirePaint(p, w, h)).filter((p): p is WirePaint => p !== null);
  if (!isUniform(sides)) {
    const { radii, smoothing } = layerCorners(node);
    const region = strokeRegion(w, h, radii, sides, getProp(node.props, "strokeAlign"), smoothing);
    const path = b.path({ kind: "path", path: svgPathData(strokeRegionPath(region)) });
    for (const paint of paints()) b.ops.push({ op: "fill", path, evenOdd: true, paint });
    return;
  }
  const weight = sides[0];
  if (weight <= 0) return;
  const open =
    node.type === "line" ||
    (node.type === "path" && !isClosedPath(getProp(node.props, "pathData")));
  const align = open ? "center" : getProp(node.props, "strokeAlign");
  const evenOdd = node.type === "path" && getProp(node.props, "windingRule") === "evenodd";
  const join = getProp(node.props, "strokeJoin");
  const cap =
    node.type === "line" || node.type === "path" ? getProp(node.props, "strokeCap") : "butt";
  const dashes = getProp(node.props, "strokeDashes");
  const width = align === "center" ? weight : weight * 2;
  let clipped = false;
  if (align === "inside") {
    b.ops.push({ op: "clip", path: shape, evenOdd });
    clipped = true;
  } else if (align === "outside") {
    const outside = b.path({ kind: "outside", of: shape });
    b.ops.push({ op: "clip", path: outside, evenOdd: true });
    clipped = true;
  }
  const markers = markersOf(node);
  const trimmed = markers ? trimmedStroke(node, markers.start.inset, markers.end.inset) : null;
  const line = trimmed
    ? b.path({ kind: "path", path: svgPathData(serializePath(trimmed)) })
    : shape;
  const pieces = dashes.length > 0 && !markers ? dashedPieces(node, w, h) : null;
  const pieceEntries = pieces?.map((p) => ({
    path: b.path({ kind: "path", path: p.path }),
    dashes: p.dashes,
    offset: p.offset,
  }));
  const markerEntries = markers
    ? [markers.start, markers.end].map((m) => ({
        fill: m.fill ? b.path({ kind: "path", path: svgPathData(serializePath(m.fill)) }) : null,
        stroke: m.stroke
          ? b.path({ kind: "path", path: svgPathData(serializePath(m.stroke)) })
          : null,
      }))
    : [];
  for (const paint of paints()) {
    if (pieceEntries)
      for (const p of pieceEntries)
        b.ops.push({
          op: "stroke",
          path: p.path,
          style: strokeStyle(width, join, cap === "none" ? "butt" : cap, p.dashes, p.offset),
          paint,
        });
    else
      b.ops.push({
        op: "stroke",
        path: line,
        style: strokeStyle(width, join, cap === "none" ? "butt" : cap, dashes),
        paint,
      });
    for (const m of markerEntries) {
      if (m.fill !== null) b.ops.push({ op: "fill", path: m.fill, evenOdd: false, paint });
      if (m.stroke !== null)
        b.ops.push({
          op: "stroke",
          path: m.stroke,
          style: strokeStyle(width, "round", "round", []),
          paint,
        });
    }
  }
  if (clipped) b.ops.push({ op: "unclip" });
}

/** A shaping run for any span: the face it's drawn in, and its features and axes (none for most). */
function runFor(props: NodeRecord["props"], measurer: TextMeasurer): ShapingRun {
  const family = drawnFamily(props, measurer);
  const weight = getProp(props, "fontWeight");
  const italic = getProp(props, "fontStyle") === "italic";
  const size = getProp(props, "fontSize");
  const features = getProp(props, "fontFeatures");
  const variations = getProp(props, "fontVariations");
  const tags = (o: Readonly<Record<string, number | boolean>>) =>
    Object.keys(o)
      .sort()
      .map((t) => `${t}=${Number(o[t])}`)
      .join(",");
  return {
    family,
    weight,
    italic,
    size,
    features,
    variations,
    key: `${family}|${weight}|${italic ? "i" : "n"}|${size}|${tags(features)}|${tags(variations)}`,
  };
}

const isLowSurrogate = (c: number) => c >= 0xdc00 && c <= 0xdfff;

/** Glyphs of a shaped run as engine glyph instances (handle, x, y), from (x, y) on the baseline. */
function shapedGlyphs(
  shaped: ShapedText,
  text: string,
  spacing: number,
  x: number,
  y: number,
  ctx: LayerContext,
): number[] {
  // Letter spacing moves each glyph by the characters before its cluster (code points, not
  // UTF-16 units); without it nothing moves, and the table isn't made.
  let before: Uint32Array | null = null;
  if (spacing !== 0) {
    before = new Uint32Array(text.length + 1);
    for (let i = 0, n = 0; i < text.length; i++) {
      before[i] = n;
      if (!isLowSurrogate(text.charCodeAt(i))) n++;
      before[i + 1] = n;
    }
  }
  const out: number[] = [];
  for (const g of shaped.glyphs) {
    if (!g.d) continue;
    out.push(
      ctx.shapedGlyph ? ctx.shapedGlyph(g) : ctx.glyph(g.d),
      x + g.x + (before ? spacing * (before[g.cluster] ?? 0) : 0),
      y - g.y,
    );
  }
  return out;
}

interface TextRun {
  /** A glyph-run entry's index. */
  readonly entry: number;
  readonly paints: readonly Paint[];
}

/**
 * A text layer's glyphs as runs of interned outlines (each glyph keeps its identity, for the
 * engine's glyph cache), with the paints each is filled in, and its decoration bars. From its
 * saved outlines (decision 0037) when it's drawn from them, else from HarfBuzz's shaping.
 */
function textRuns(
  b: Builder,
  node: NodeRecord,
  width: number,
  ctx: LayerContext,
): { runs: TextRun[]; bars: Array<{ entry: number; paints: readonly Paint[] }> } | null {
  const layerFills = getProp(node.props, "fills");
  const black: Paint[] = [{ type: "solid", color: "#000000" }];
  const paintsOf = (fills: readonly Paint[] | null | undefined) =>
    fills ?? (layerFills.length > 0 ? layerFills : black);
  const runs: TextRun[] = [];
  const bars: Array<{ entry: number; paints: readonly Paint[] }> = [];
  const saved: SavedText | null =
    node.id === ctx.whole ? null : savedText(node, ctx.measurer, glyphTable(ctx.scene.doc));
  if (saved) {
    const { layout, outlines, dx, dy } = saved;
    const spans = textSpans(node);
    const spanAt = (i: number) => {
      let lo = 0;
      let hi = spans.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if ((spans[mid] as (typeof spans)[number]).start <= i) lo = mid;
        else hi = mid - 1;
      }
      return spans[lo] as (typeof spans)[number];
    };
    // One run per paints and size (a run's scale is one number).
    const groups = new Map<
      string,
      { fills: readonly Paint[] | null; size: number; glyphs: number[]; bars: PathData }
    >();
    const fillKeys = new Map<readonly Paint[] | null, number>();
    const count = layout.g.length / 3;
    for (let i = 0; i < count; i++) {
      const d = outlines[layout.g[i * 3] as number] as string;
      const x = (layout.g[i * 3 + 1] as number) + dx;
      const y = Math.round((layout.g[i * 3 + 2] as number) + dy);
      const size = layout.s?.[i] ?? layout.size;
      const span = spanAt(layout.c?.[i] ?? i);
      const fills = span.own.fills ?? null;
      if (!fillKeys.has(fills)) fillKeys.set(fills, fillKeys.size);
      const key = `${fillKeys.get(fills)}|${size}`;
      let g = groups.get(key);
      if (!g) {
        g = { fills, size, glyphs: [], bars: new PathData() };
        groups.set(key, g);
      }
      if (d) g.glyphs.push(ctx.glyph(d), x, y);
      const decoration = getProp(span.props, "textDecoration");
      const advance = layout.a?.[i];
      if (decoration !== "none" && advance !== undefined && advance > 0) {
        const bar = decorationBar(decoration, y, size);
        g.bars
          .moveTo(x, bar.y)
          .lineTo(x + advance, bar.y)
          .lineTo(x + advance, bar.y + bar.height)
          .lineTo(x, bar.y + bar.height)
          .close();
      }
    }
    for (const g of groups.values()) {
      const paints = paintsOf(g.fills);
      if (g.glyphs.length > 0)
        runs.push({
          entry: b.path({ kind: "glyphs", scale: g.size / GLYPH_UNITS, glyphs: g.glyphs }),
          paints,
        });
      if (!g.bars.empty) bars.push({ entry: b.path({ kind: "path", path: g.bars }), paints });
    }
    return { runs, bars };
  }
  const shape = ctx.measurer.shape?.bind(ctx.measurer);
  if (!shape) return null;
  const mode = getProp(node.props, "textAutoResize");
  const layout = layoutText(node, ctx.measurer, mode === "width" ? null : width, {
    whole: node.id === ctx.whole,
  });
  const dy = textBlockOffset(node, layout);
  const spans = textSpans(node);
  const spanAt = (i: number) =>
    spans.find((s) => s.start <= i && i < s.end) ?? spans[spans.length - 1];
  let missing = false;
  // A text layer composites as one shape, as Figma draws it (`text-overlap` in the parity
  // suites): where its glyphs overlap, across lines too, they're covered once. Glyphs in a row
  // with the same paints and scale go in one run, which the engine covers once (one fill of its
  // outlines, or one image of its masks); a change of paints or size starts the next, so paint
  // order between them stays as the text reads.
  let open: { key: string; scale: number; glyphs: number[]; paints: readonly Paint[] } | null =
    null;
  const flush = () => {
    if (open && open.glyphs.length > 0)
      runs.push({
        entry: b.path({ kind: "glyphs", scale: open.scale, glyphs: open.glyphs }),
        paints: open.paints,
      });
    open = null;
  };
  const add = (scale: number, glyphs: number[], paints: readonly Paint[]) => {
    if (glyphs.length === 0) return;
    const key = `${scale}|${JSON.stringify(paints)}`;
    if (open?.key !== key) {
      flush();
      open = { key, scale, glyphs: [], paints };
    }
    for (const v of glyphs) open.glyphs.push(v);
  };
  for (const line of layout.lines) {
    const x0 = lineOffset(line, width, node.props);
    const baseline = drawnBaseline(line, dy);
    const marker = line.marker;
    if (marker) {
      const span = spanAt(line.start);
      const run = span ? runFor(span.props, ctx.measurer) : null;
      const shaped = run ? shape(marker.text, run) : null;
      if (!shaped || shaped.outlines === false) {
        const face = run && !shaped ? (ctx.measurer.loading?.(run) ?? null) : null;
        if (face) b.waiting.add(face);
        else missing = true;
      } else {
        add(
          shaped.scale,
          shapedGlyphs(shaped, marker.text, 0, x0 + marker.x, baseline, ctx),
          paintsOf(marker.fills),
        );
      }
    }
    for (const frag of line.fragments) {
      if (!frag.text) continue;
      const span = spanAt(frag.start);
      const run = frag.run ?? (span ? runFor(span.props, ctx.measurer) : null);
      const shaped = run ? shape(frag.text, run) : null;
      const x = x0 + frag.x;
      if (!shaped || shaped.outlines === false) {
        // A face still loading: provisional until it arrives. One that won't: not drawn here.
        const face = run && !shaped ? (ctx.measurer.loading?.(run) ?? null) : null;
        if (face) b.waiting.add(face);
        else missing = true;
        continue;
      }
      const glyphs = shapedGlyphs(shaped, frag.text, frag.letterSpacing, x, baseline, ctx);
      const paints = paintsOf(frag.fills);
      add(shaped.scale, glyphs, paints);
      if (frag.decoration !== "none") {
        const bar = decorationBar(frag.decoration, baseline, frag.fontSize);
        bars.push({
          entry: b.path({
            kind: "path",
            path: new PathData()
              .moveTo(x, bar.y)
              .lineTo(x + frag.width, bar.y)
              .lineTo(x + frag.width, bar.y + bar.height)
              .lineTo(x, bar.y + bar.height)
              .close(),
          }),
          paints,
        });
      }
    }
  }
  flush();
  if (missing) {
    b.unsupported |= UNSUPPORTED.textWithoutOutlines;
    b.textPending = true;
  } else if (b.waiting.size > 0) b.provisional = true;
  return { runs, bars };
}

/** Resolves a layer's visible glass effect into a wire op, or null when it has none. */
function glassOp(
  node: NodeRecord,
  paths: readonly number[],
  evenOdd: boolean,
  w: number,
  h: number,
): WireOp | null {
  if (paths.length === 0) return null;
  const glass = getProp(node.props, "effects").find(
    (e): e is Glass => e.type === "glass" && e.visible !== false,
  );
  if (!glass) return null;
  const isBox = node.type === "rect" || node.type === "frame";
  const kind = isBox
    ? GLASS_KIND.box
    : node.type === "ellipse"
      ? GLASS_KIND.ellipse
      : GLASS_KIND.other;
  const inradius = isBox || node.type === "ellipse" ? Math.min(w, h) / 2 : 0;
  let boxRadii: readonly [number, number, number, number] = [0, 0, 0, 0];
  let boxSmoothing: readonly [number, number, number, number] = [0, 0, 0, 0];
  if (isBox) {
    const { radii, smoothing } = layerCorners(node);
    const fitted = fitCorners(w, h, radii, smoothing);
    boxRadii = [fitted[0].radius, fitted[1].radius, fitted[2].radius, fitted[3].radius];
    boxSmoothing = [
      fitted[0].smoothing,
      fitted[1].smoothing,
      fitted[2].smoothing,
      fitted[3].smoothing,
    ];
  }
  return {
    op: "glass",
    paths,
    evenOdd,
    kind,
    inradius,
    angle: glass.angle,
    intensity: glass.intensity,
    refraction: glass.refraction,
    depth: glass.depth,
    dispersion: glass.dispersion,
    frost: glass.frost,
    splay: glass.splay,
    boxRadii,
    boxSmoothing,
  };
}

/** Text: its glyphs filled in each run's paints, in order, then its strokes around the glyphs. */
function text(
  b: Builder,
  node: NodeRecord,
  width: number,
  height: number,
  ctx: LayerContext,
): void {
  // Deferred: its coarse bars only, for now (below), never its glyphs.
  const runs = ctx.deferText ? { runs: [], bars: [] } : textRuns(b, node, width, ctx);
  if (ctx.deferText) {
    b.provisional = true;
    b.deferred = true;
  }
  if (!runs) {
    b.unsupported |= UNSUPPORTED.textWithoutOutlines;
    return;
  }
  const fill = (entry: number, paints: readonly Paint[]) => {
    for (const paint of paints) {
      if (!shows(paint)) continue;
      const p = wirePaint(paint, width, height);
      if (p) b.ops.push({ op: "fill", path: entry, evenOdd: false, paint: p });
    }
  };
  // Drop shadows cast from all glyph runs and decoration bars combined (as render.ts does).
  const shadowPaths = [...runs.runs.map((r) => r.entry), ...runs.bars.map((bar) => bar.entry)];
  if (shadowPaths.length > 0) {
    for (const e of getProp(node.props, "effects")) {
      if (e.visible === false || e.type !== "drop-shadow") continue;
      const col = rgba(e.color);
      if (col[3] <= 0) continue;
      b.ops.push({
        op: "dropShadow",
        paths: shadowPaths,
        evenOdd: false,
        dx: e.x,
        dy: e.y,
        blur: Math.max(0, e.blur),
        color: col,
        blend: blendCode(e.blendMode),
      });
    }
  }
  const g = glassOp(node, shadowPaths, false, width, height);
  if (g) b.ops.push(g);
  // The canvas fills each run in its paints, then its decorations in the same.
  for (const r of runs.runs) fill(r.entry, r.paints);
  for (const bar of runs.bars) fill(bar.entry, bar.paints);
  const strokes = getProp(node.props, "strokes").filter(shows);
  const weight = getProp(node.props, "strokeWeight");
  if (strokes.length > 0 && weight > 0 && runs.runs.length > 0) {
    const align = getProp(node.props, "strokeAlign");
    const style = strokeStyle(
      align === "center" ? weight : weight * 2,
      getProp(node.props, "strokeJoin"),
      "butt",
      getProp(node.props, "strokeDashes"),
    );
    if (align === "outside") {
      // Paint-major order across runs (matching render.ts and Figma): each stroke paint strokes all
      // runs in an isolated layer, then cuts out all run interiors via nonzero destination-out.
      b.ops.push({ op: "layer", compose: COMPOSE.srcOver });
      for (const paint of strokes) {
        const p = wirePaint(paint, width, height);
        if (!p) continue;
        for (const r of runs.runs) {
          b.ops.push({ op: "stroke", path: r.entry, style, paint: p });
        }
      }
      b.ops.push({ op: "layer", compose: COMPOSE.destOut });
      for (const r of runs.runs) {
        b.ops.push({
          op: "fill",
          path: r.entry,
          evenOdd: false,
          paint: { kind: "solid", color: [0, 0, 0, 1] },
        });
      }
      b.ops.push({ op: "unlayer" });
      b.ops.push({ op: "unlayer" });
    } else {
      for (const paint of strokes) {
        const p = wirePaint(paint, width, height);
        if (!p) continue;
        for (const r of runs.runs) {
          if (align === "inside") b.ops.push({ op: "clip", path: r.entry, evenOdd: false });
          b.ops.push({ op: "stroke", path: r.entry, style, paint: p });
          if (align === "inside") b.ops.push({ op: "unclip" });
        }
      }
    }
  }
  // Too small to read on screen: bars where the lines are (`#greek`), in the last visible fill.
  const size = largestFontSize(node);
  if (size > 0) {
    const { lines, lh } = greekLines(node, ctx.measurer);
    const fills = getProp(node.props, "fills");
    const paint = [...fills].reverse().find(shows);
    const greek = paint
      ? wirePaint({ ...paint, blendMode: "normal" }, width, height, 0.55)
      : { kind: "solid" as const, color: [0, 0, 0, 0.55] as const };
    if (greek) {
      const align = getProp(node.props, "textAlign");
      const fontSize = getProp(node.props, "fontSize");
      const path = new PathData();
      for (let i = 0; i < lines; i++) {
        const w = lines > 1 && i === lines - 1 ? width * 0.6 : width;
        const x = align === "center" ? (width - w) / 2 : align === "right" ? width - w : 0;
        const y = i * lh + (lh - fontSize) / 2 + fontSize * 0.18;
        path
          .moveTo(x, y)
          .lineTo(x + w, y)
          .lineTo(x + w, y + fontSize * 0.5)
          .lineTo(x, y + fontSize * 0.5)
          .close();
      }
      b.coarse.push({
        op: "fill",
        path: b.path({ kind: "path", path }),
        evenOdd: false,
        paint: greek,
      });
    }
  }
}

/** Effects the engine doesn't draw yet: their bits. */
function unsupportedOf(node: NodeRecord): number {
  let bits = 0;
  for (const e of getProp(node.props, "effects")) {
    if (e.visible === false) continue;
    if (e.type === "background-blur") bits |= UNSUPPORTED.backgroundBlur;
  }
  return bits;
}

/** The layer as a record: what the canvas renderer draws for it, resolved. */
export function encodeLayer(node: NodeRecord, ctx: LayerContext): EncodedLayer {
  const b = new Builder();
  const scene = ctx.scene;
  const children = scene.doc.childIds(node.id).length;
  const hidden = node.props.visible === false || ctx.hidden.has(node.id);
  const opacity = getProp(node.props, "opacity");
  const isolate = opacity < 1 && fadesAsOne(node, children);
  const blend = blendCode(getProp(node.props, "blendMode"));
  const activeMask = !hidden && isActiveMask(node);
  const stopMask = !hidden && !activeMask && endsMask(node);
  let mask = 0;
  if (activeMask) {
    if (clipsByShape(node)) {
      const evenOdd = node.type === "path" && getProp(node.props, "windingRule") === "evenodd";
      mask = evenOdd ? MASK.outlineShapeEvenOdd : MASK.outlineShapeNonZero;
    } else {
      const maskType = getProp(node.props, "maskType");
      mask =
        maskType === "luminance"
          ? MASK.luminance
          : maskType === "alpha"
            ? MASK.alpha
            : MASK.outlinePicture;
    }
  }
  b.unsupported |= unsupportedOf(node);
  const w = node.type === "group" ? 0 : getProp(node.props, "width");
  const h = node.type === "group" ? 0 : getProp(node.props, "height");
  const wirePost: WirePostEffect[] = [];
  for (const pe of postEffects(getProp(node.props, "effects"))) {
    if (pe.type === "layer-blur" && pe.radius > 0) {
      wirePost.push({ kind: "layerBlur", radius: pe.radius });
    } else if (pe.type === "noise" && pe.size > 0 && pe.density > 0) {
      wirePost.push({
        kind: "noise",
        noiseType: NOISE_TYPE[pe.noiseType],
        size: pe.size,
        density: pe.density,
        color: rgba(pe.color),
        secondaryColor: rgba(pe.secondaryColor),
        opacity: Math.min(1, Math.max(0, pe.opacity / 100)),
      });
    } else if (pe.type === "texture" && pe.size > 0 && pe.radius > 0) {
      wirePost.push({
        kind: "texture",
        size: pe.size,
        radius: pe.radius,
        clipToShape: pe.clipToShape,
      });
    }
  }
  const flags =
    (hidden ? FLAG.hidden : 0) |
    (isolate ? FLAG.isolate : 0) |
    (node.type === "group" ? FLAG.group : 0) |
    (wirePost.length > 0 ? FLAG.post : 0) |
    (blend !== 0 ? FLAG.blend : 0) |
    (mask !== 0 ? FLAG.mask : 0) |
    (stopMask ? FLAG.endsMask : 0);
  if (node.type === "group") {
    b.ops.push({ op: "children" });
  } else if (node.type === "text") {
    // Hidden text draws nothing: it isn't shaped until it shows (showing it encodes it again).
    if (!hidden) text(b, node, w, h, ctx);
  } else {
    const shape = b.path(shapeEntry(node, w, h));
    const evenOdd = node.type === "path" && getProp(node.props, "windingRule") === "evenodd";
    emitDropShadows(b, node, shape, evenOdd, w, h);
    if (node.type !== "line") {
      const g = glassOp(node, [shape], evenOdd, w, h);
      if (g) b.ops.push(g);
      for (const paint of getProp(node.props, "fills")) {
        if (!shows(paint)) continue;
        if (paint.type === "image") imageFill(b, shape, evenOdd, paint, w, h, ctx);
        else {
          const p = wirePaint(paint, w, h);
          if (p) b.ops.push({ op: "fill", path: shape, evenOdd, paint: p });
        }
      }
    }
    emitInnerShadows(b, node, shape, evenOdd, w, h);
    if (node.type === "frame") {
      const clip = getProp(node.props, "clipContent");
      if (clip) b.ops.push({ op: "clip", path: shape, evenOdd: false });
      b.ops.push({ op: "children" });
      if (clip) b.ops.push({ op: "unclip" });
    }
    shapeStrokes(b, node, shape, w, h);
  }
  const size = node.type === "text" ? largestFontSize(node) : 0;
  return {
    record: {
      flags: flags | (b.provisional ? FLAG.provisional : 0),
      opacity,
      transform: localTransform(node),
      width: w,
      height: h,
      coarseBelow: size > 0 && b.coarse.length > 0 ? GREEK_BELOW / size : 0,
      reach: node.type === "group" ? 0 : paintMargin(node),
      unsupported: b.unsupported,
      paths: b.paths,
      ops: b.ops,
      coarse: b.coarse,
      ...(wirePost.length > 0 ? { postEffects: wirePost } : {}),
      ...(blend !== 0 ? { blend } : {}),
      ...(mask !== 0 ? { mask } : {}),
    },
    images: b.images,
    textPending: b.textPending,
    deferred: b.deferred,
    waiting: [...b.waiting],
  };
}
