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
  CAP,
  FLAG,
  type GradientStop,
  JOIN,
  type Matrix,
  PathData,
  type PathEntry,
  type Rgba,
  type StrokeStyle,
  UNSUPPORTED,
  type WireOp,
  type WirePaint,
  type WireRecord,
} from "@drawpane/engine/wire";
import { GLYPH_UNITS, getProp, type NodeRecord, type Paint } from "@drawpane/model";
import { fitCorners } from "../corner-geometry";
import { layerCorners } from "../corners";
import { boxOutline, ellipseOutline, fitDashes } from "../dashes";
import { boxOf, localMatrix } from "../geometry";
import { gradientMatrix } from "../gradients";
import { imagePlacement } from "../images";
import { markersOf, trimmedStroke } from "../markers";
import { isActiveMask } from "../masks";
import { postEffects } from "../post-effects";
import { paintMargin } from "../reach";
import { fadesAsOne, GREEK_BELOW, greekLines, largestFontSize } from "../render";
import { textSpans } from "../rich-text";
import { glyphTable, type SavedText, savedText } from "../saved-glyphs";
import type { Scene } from "../scene";
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
  /** Text it couldn't outline yet (a face still loading): encoded again when shaping can. */
  readonly textPending: boolean;
  /** Sent provisional (`LayerContext.deferText`): to be encoded whole. */
  readonly deferred: boolean;
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
  if (paint.type === "solid") return { kind: "solid", color: rgba(paint.color, opacity) };
  if (paint.type === "image") return null; // Placed by the caller, which needs the shape.
  const m = gradientMatrix(paint, w, h);
  if (!m) return null;
  const stops: GradientStop[] = paint.stops.map((s) => ({
    position: s.position,
    color: rgba(s.color, opacity),
  }));
  return { kind: paint.type, matrix: m, stops };
}

function blendOf(paint: Paint): boolean {
  return paint.blendMode !== undefined && paint.blendMode !== "normal";
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
  /** Sent ahead of its real drawing (`LayerContext.deferText`). */
  provisional = false;
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
      // Radii as corners.ts fits them (Figma's rule: each corner's share of the side it's on),
      // so the engine's own clamp (half the shorter side) never changes them.
      const { radii } = layerCorners(node);
      const fitted = fitCorners(w, h, radii, 0);
      return {
        kind: "rect",
        w,
        h,
        radii: [fitted[0].radius, fitted[1].radius, fitted[2].radius, fitted[3].radius],
        smoothing: 0,
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
  const image = ctx.image(paint.ref);
  if (!image) {
    // Loading: the checkerboard over the box, inside the shape (as the canvas renderer draws it).
    b.ops.push({
      op: "fill",
      path: shape,
      evenOdd,
      paint: { kind: "placeholder", opacity: paint.opacity ?? 1 },
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
  if (strokes.some(blendOf)) b.unsupported |= UNSUPPORTED.blend;
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
  for (const line of layout.lines) {
    const x0 = lineOffset(line, width, node.props);
    const baseline = drawnBaseline(line, dy);
    const marker = line.marker;
    if (marker) {
      const span = spanAt(line.start);
      const shaped = span ? shape(marker.text, runFor(span.props, ctx.measurer)) : null;
      if (!shaped || shaped.outlines === false) missing = true;
      else {
        const glyphs = shapedGlyphs(shaped, marker.text, 0, x0 + marker.x, baseline, ctx);
        if (glyphs.length > 0)
          runs.push({
            entry: b.path({ kind: "glyphs", scale: shaped.scale, glyphs }),
            paints: paintsOf(marker.fills),
          });
      }
    }
    for (const frag of line.fragments) {
      if (!frag.text) continue;
      const span = spanAt(frag.start);
      const run = frag.run ?? (span ? runFor(span.props, ctx.measurer) : null);
      const shaped = run ? shape(frag.text, run) : null;
      const x = x0 + frag.x;
      if (!shaped || shaped.outlines === false) {
        missing = true;
        continue;
      }
      const glyphs = shapedGlyphs(shaped, frag.text, frag.letterSpacing, x, baseline, ctx);
      const paints = paintsOf(frag.fills);
      if (glyphs.length > 0)
        runs.push({ entry: b.path({ kind: "glyphs", scale: shaped.scale, glyphs }), paints });
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
  if (missing) {
    b.unsupported |= UNSUPPORTED.textWithoutOutlines;
    b.textPending = true;
  }
  return { runs, bars };
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
  if (ctx.deferText) b.provisional = true;
  if (!runs) {
    b.unsupported |= UNSUPPORTED.textWithoutOutlines;
    return;
  }
  const fill = (entry: number, paints: readonly Paint[]) => {
    for (const paint of paints) {
      if (!shows(paint)) continue;
      if (blendOf(paint)) b.unsupported |= UNSUPPORTED.blend;
      const p = wirePaint(paint, width, height);
      if (p) b.ops.push({ op: "fill", path: entry, evenOdd: false, paint: p });
    }
  };
  // The canvas fills each run in its paints, then its decorations in the same.
  for (const r of runs.runs) fill(r.entry, r.paints);
  for (const bar of runs.bars) fill(bar.entry, bar.paints);
  const strokes = getProp(node.props, "strokes").filter(shows);
  const weight = getProp(node.props, "strokeWeight");
  if (strokes.length > 0 && weight > 0 && runs.runs.length > 0) {
    if (strokes.some(blendOf)) b.unsupported |= UNSUPPORTED.blend;
    const align = getProp(node.props, "strokeAlign");
    if (align === "outside") b.unsupported |= UNSUPPORTED.textStrokeOutside;
    const style = strokeStyle(
      align === "center" ? weight : weight * 2,
      getProp(node.props, "strokeJoin"),
      "butt",
      getProp(node.props, "strokeDashes"),
    );
    for (const r of runs.runs) {
      if (align === "inside") b.ops.push({ op: "clip", path: r.entry, evenOdd: false });
      for (const paint of strokes) {
        const p = wirePaint(paint, width, height);
        if (p) b.ops.push({ op: "stroke", path: r.entry, style, paint: p });
      }
      if (align === "inside") b.ops.push({ op: "unclip" });
    }
  }
  // Too small to read on screen: bars where the lines are (`#greek`), in the last visible fill.
  const size = largestFontSize(node);
  if (size > 0) {
    const { lines, lh } = greekLines(node, ctx.measurer);
    const fills = getProp(node.props, "fills");
    const paint = [...fills].reverse().find(shows);
    const greek = paint
      ? wirePaint(paint, width, height, 0.55)
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

/** Effects, masks and blends phase 1's engine doesn't draw: their bits. */
function unsupportedOf(node: NodeRecord, scene: Scene): number {
  let bits = 0;
  for (const e of getProp(node.props, "effects")) {
    if (e.visible === false) continue;
    if (e.type === "drop-shadow" || e.type === "inner-shadow") bits |= UNSUPPORTED.shadow;
    else if (e.type === "layer-blur") bits |= UNSUPPORTED.layerBlur;
    else if (e.type === "background-blur") bits |= UNSUPPORTED.backgroundBlur;
    else if (e.type === "glass") bits |= UNSUPPORTED.glass;
    else if (e.type === "noise") bits |= UNSUPPORTED.noise;
    else if (e.type === "texture") bits |= UNSUPPORTED.texture;
  }
  const post = postEffects(getProp(node.props, "effects"));
  if (post && post.length > 0) bits |= UNSUPPORTED.layerBlur;
  const mode = getProp(node.props, "blendMode");
  if (mode !== "normal") bits |= UNSUPPORTED.blend;
  // Squircles wait for the engine's port of corners.ts; drawing plain corners instead is wrong.
  if (node.type === "rect" || node.type === "frame") {
    const { radii, smoothing } = layerCorners(node);
    if (smoothing > 0 && radii.some((r) => r > 0)) bits |= UNSUPPORTED.cornerSmoothing;
  }
  const id = node.id;
  const masks = isActiveMask(node);
  if (masks || scene.hasMask(id)) bits |= UNSUPPORTED.mask;
  if (getProp(node.props, "fills").some((p) => shows(p) && blendOf(p))) bits |= UNSUPPORTED.blend;
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
  b.unsupported |= unsupportedOf(node, scene);
  const w = node.type === "group" ? 0 : getProp(node.props, "width");
  const h = node.type === "group" ? 0 : getProp(node.props, "height");
  const flags =
    (hidden ? FLAG.hidden : 0) |
    (isolate ? FLAG.isolate : 0) |
    (node.type === "group" ? FLAG.group : 0);
  if (node.type === "group") {
    b.ops.push({ op: "children" });
  } else if (node.type === "text") {
    // Hidden text draws nothing: it isn't shaped until it shows (showing it encodes it again).
    if (!hidden) text(b, node, w, h, ctx);
  } else {
    const shape = b.path(shapeEntry(node, w, h));
    const evenOdd = node.type === "path" && getProp(node.props, "windingRule") === "evenodd";
    if (node.type !== "line")
      for (const paint of getProp(node.props, "fills")) {
        if (!shows(paint)) continue;
        if (paint.type === "image") imageFill(b, shape, evenOdd, paint, w, h, ctx);
        else {
          const p = wirePaint(paint, w, h);
          if (p) b.ops.push({ op: "fill", path: shape, evenOdd, paint: p });
        }
      }
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
    },
    images: b.images,
    textPending: b.textPending,
    deferred: b.provisional,
  };
}
