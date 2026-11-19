/**
 * A board of a converted file as a display list: the TypeScript half of decision 0040's
 * boundary. The document, layout and every Figma rule about *what* is drawn stay here (the
 * editor's own helpers: world matrices, saved glyph outlines, glass parameters, shadow casts,
 * fitted dashes, per-side strokes); the engine only draws.
 *
 * It follows the canvas renderer's order per layer (packages/editor/src/render.ts,
 * `#drawLayer`): drop shadows, glass, fills, inner shadows, children (clipped), strokes; a
 * layer is drawn as one picture when it fades or blends as one, or has a layer blur.
 *
 * The spike draws what the chosen board uses and counts the rest in `unsupported` rather than
 * guessing: gradients, images, masks, background blur, glass on anything but a box, text
 * without saved outlines, vectors, non-separable blends. A list with anything unsupported is
 * refused by the measurements (and would fall back to the canvas renderer in the product): it
 * is never drawn wrong.
 */
import {
  Doc,
  glassParams,
  glassTuning,
  glyphTable,
  postEffects,
  Scene,
  savedGlyphGroups,
  savedText,
  type TextMeasurer,
} from "@drawpane/editor";
import { type Effect, getProp, type NodeRecord, type Paint } from "@drawpane/model";
// Not exported from the editor's index; the spike reads them where they live.
import { boxCommands, fitCorners, type Radii } from "../../../packages/editor/src/corner-geometry";
import { boxOutline, ellipseOutline, fitDashes } from "../../../packages/editor/src/dashes";
import { dropShadowCast } from "../../../packages/editor/src/shadows";
import {
  isUniform,
  strokeRegion,
  strokeRegionPath,
  strokeWidths,
} from "../../../packages/editor/src/stroke-sides";
import { BLENDS, type Bounds, Encoder, type Matrix, Path, parseSvgPath, type Rgba } from "./encode";

export interface BoardList {
  readonly bytes: Uint8Array;
  readonly width: number;
  readonly height: number;
  /** Layers drawn, and what the spike skipped, by kind. */
  readonly layers: number;
  readonly unsupported: Record<string, number>;
  readonly ops: Record<string, number>;
}

const KAPPA = 0.5522847498;
/** The blends the engine's kernel draws (exec.rs, `blend_pixel`). */
const KERNEL_BLENDS = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 100, 101]);
const FAR = 1e4;

const mul = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];
const translate = (x: number, y: number): Matrix => [1, 0, 0, 1, x, y];

/** "#rrggbb[aa]" times `alpha`, as straight RGBA floats. */
function rgba(hex: string, alpha: number): Rgba {
  const v = (i: number) => Number.parseInt(hex.slice(i, i + 2), 16) / 255;
  const a = hex.length >= 9 ? v(7) : 1;
  return [v(1), v(3), v(5), a * alpha];
}

const shows = (p: Paint) => p.visible !== false && (p.opacity ?? 1) > 0;

/** A box's outline, grown by `inset` on every side, from the corner geometry every renderer shares. */
function roundRect(w: number, h: number, radii: readonly number[], inset = 0, smoothing = 0): Path {
  const p = new Path();
  const W = w + inset * 2;
  const H = h + inset * 2;
  if (W <= 0 || H <= 0) return p;
  for (const c of boxCommands(W, H, radii as Radii, smoothing)) {
    if (c[0] === "M") p.moveTo(c[1] - inset, c[2] - inset);
    else if (c[0] === "L") p.lineTo(c[1] - inset, c[2] - inset);
    else if (c[0] === "C")
      p.cubicTo(c[1] - inset, c[2] - inset, c[3] - inset, c[4] - inset, c[5] - inset, c[6] - inset);
    else p.close();
  }
  return p;
}

function ellipse(cx: number, cy: number, rx: number, ry: number): Path {
  const p = new Path();
  if (rx <= 0 || ry <= 0) return p;
  const kx = rx * KAPPA;
  const ky = ry * KAPPA;
  p.moveTo(cx + rx, cy)
    .cubicTo(cx + rx, cy + ky, cx + kx, cy + ry, cx, cy + ry)
    .cubicTo(cx - kx, cy + ry, cx - rx, cy + ky, cx - rx, cy)
    .cubicTo(cx - rx, cy - ky, cx - kx, cy - ry, cx, cy - ry)
    .cubicTo(cx + kx, cy - ry, cx + rx, cy - ky, cx + rx, cy);
  return p.close();
}

/** An elliptical arc (y down, clockwise) as cubics, continuing from where the path is. */
function arc(
  p: Path,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  start: number,
  end: number,
): void {
  const steps = Math.max(1, Math.ceil(Math.abs(end - start) / (Math.PI / 2)));
  const step = (end - start) / steps;
  const k = (4 / 3) * Math.tan(step / 4);
  for (let i = 0; i < steps; i++) {
    const a0 = start + step * i;
    const a1 = a0 + step;
    const [c0, s0, c1, s1] = [Math.cos(a0), Math.sin(a0), Math.cos(a1), Math.sin(a1)];
    p.cubicTo(
      cx + rx * (c0 - k * s0),
      cy + ry * (s0 + k * c0),
      cx + rx * (c1 + k * s1),
      cy + ry * (s1 - k * c1),
      cx + rx * c1,
      cy + ry * s1,
    );
  }
}

const bigRect = () =>
  new Path().moveTo(-FAR, -FAR).lineTo(FAR, -FAR).lineTo(FAR, FAR).lineTo(-FAR, FAR).close();

/** What the spike treats as SF Pro and friends: missing, so text draws from saved outlines. */
const MISSING_EVERYTHING = {
  generation: 0,
  missing: () => true,
} as unknown as TextMeasurer;

export interface BuildOptions {
  /** Device pixels per unit (Figma's exports at 2×). */
  readonly scale?: number;
  /** For finding what costs what: leave out glass, inner or drop shadows, or kernel blends. */
  readonly omit?: ReadonlyArray<"glass" | "inner-shadow" | "drop-shadow" | "linear" | "apart">;
}

export function buildBoard(
  nodes: readonly NodeRecord[],
  boardId: string,
  options: BuildOptions = {},
): BoardList {
  const scale = options.scale ?? 2;
  const omit = new Set(options.omit ?? []);
  const doc = new Doc({ compactCopies: false });
  doc.reset(nodes as NodeRecord[]);
  const scene = new Scene(doc);
  const board = doc.get(boardId);
  if (!board) throw new Error(`No layer ${boardId} in the file`);
  const bw = getProp(board.props, "width");
  const bh = getProp(board.props, "height");
  const origin = scene.worldMatrix(boardId);
  const width = Math.round(bw * scale);
  const height = Math.round(bh * scale);
  // Device pixels from page units: the board's own box, at `scale`, as Figma exports it.
  const device: Matrix = [scale, 0, 0, scale, -scale * origin[4], -scale * origin[5]];
  const out = new Encoder(width, height);
  const table = glyphTable(doc);
  const unsupported: Record<string, number> = {};
  const skip = (what: string) => {
    unsupported[what] = (unsupported[what] ?? 0) + 1;
  };
  let layers = 0;

  const clampBounds = (b: Bounds): Bounds => [
    Math.max(0, Math.floor(b[0])),
    Math.max(0, Math.floor(b[1])),
    Math.min(width, Math.ceil(b[2])),
    Math.min(height, Math.ceil(b[3])),
  ];
  /** The device box of a local box grown by `pad` units, through `m`. */
  const deviceBox = (m: Matrix, w: number, h: number, pad: number): Bounds => {
    const xs: number[] = [];
    const ys: number[] = [];
    for (const [x, y] of [
      [-pad, -pad],
      [w + pad, -pad],
      [w + pad, h + pad],
      [-pad, h + pad],
    ] as const) {
      xs.push(m[0] * x + m[2] * y + m[4]);
      ys.push(m[1] * x + m[3] * y + m[5]);
    }
    return clampBounds([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
  };

  /**
   * Draws `body` blended by `mode`: in place when normal, else apart and composited by the
   * engine's blend kernel (a scene Vello renders after a kernel has run starts from an isolated
   * root, so a Vello blend layer there would blend with nothing).
   */
  const blended = (mode: string, bounds: Bounds, body: () => void) => {
    if (mode === "normal") return body();
    const code = BLENDS[mode];
    // Hue, saturation, colour and luminosity have no kernel yet: reported, so the list is
    // refused rather than drawn wrong.
    if (code === undefined || !KERNEL_BLENDS.has(code)) {
      skip(`blend ${mode}`);
      return body();
    }
    if ((code >= 100 && omit.has("linear")) || omit.has("apart")) return body();
    out.pushIsolate(code, 1, bounds);
    body();
    out.pop();
  };

  const radiiOf = (node: NodeRecord): [number, number, number, number] => {
    const r = getProp(node.props, "cornerRadius");
    return (
      (getProp(node.props, "cornerRadii") as [number, number, number, number] | undefined) ?? [
        r,
        r,
        r,
        r,
      ]
    );
  };

  /** The layer's outline in its units, grown by `spread` (exact for boxes and ellipses). */
  const shapeOf = (node: NodeRecord, spread = 0): Path | null => {
    const w = getProp(node.props, "width");
    const h = getProp(node.props, "height");
    if (node.type === "rect" || node.type === "frame") {
      // Each rounded corner's radius as drawn, plus the spread, as the editor's shadows grow it.
      const smoothing = getProp(node.props, "cornerSmoothing");
      const grown = fitCorners(w, h, radiiOf(node), smoothing).map((c) =>
        c.radius > 0 ? Math.max(0, c.radius + spread) : 0,
      );
      return roundRect(w, h, grown, spread, smoothing);
    }
    if (node.type === "ellipse") return ellipse(w / 2, h / 2, w / 2 + spread, h / 2 + spread);
    if (node.type === "text") {
      const saved = savedText(node, MISSING_EVERYTHING, table);
      if (!saved) return null;
      const p = new Path();
      for (const g of savedGlyphGroups(saved, node)) {
        parseSvgPath(g.d, p);
        for (const b of g.bars) p.append(roundRect(b.w, b.h, [0, 0, 0, 0], 0));
      }
      return p;
    }
    return null;
  };

  const shadows = (
    node: NodeRecord,
    m: Matrix,
    kind: "drop-shadow" | "inner-shadow",
    alpha: number,
    blend: string,
    unitPx: number,
  ) => {
    const effects = getProp(node.props, "effects").filter(
      (e): e is Extract<Effect, { type: "drop-shadow" | "inner-shadow" }> =>
        e.type === kind && e.visible !== false,
    );
    if (effects.length === 0 || (node.type === "text" && kind === "inner-shadow")) return;
    if (omit.has(kind)) return;
    const w = getProp(node.props, "width");
    const h = getProp(node.props, "height");
    const shape = shapeOf(node);
    if (!shape) return;
    for (const s of effects) {
      const mode = s.blendMode && s.blendMode !== "normal" ? s.blendMode : blend;
      const color = rgba(s.color, alpha);
      // A canvas shadow's blur is twice its Gaussian's deviation, as Figma's is (decision 0013).
      const sigma = (s.blur * unitPx) / 2;
      const offset = mul(m, translate(s.x, s.y));
      if (kind === "drop-shadow") {
        const cast = dropShadowCast(node, s);
        const pad = Math.abs(s.x) + Math.abs(s.y) + s.blur * 1.5 + Math.abs(s.spread) + 1;
        blended(mode, deviceBox(m, w, h, pad), () => {
          if (cast.cutOut) out.pushClip(m, bigRect().append(shape), true);
          out.pushBlur(sigma);
          out.fill(
            offset,
            (node.type === "text" ? shape : shapeOf(node, cast.spread)) ?? shape,
            false,
            color,
          );
          out.pop();
          if (cast.cutOut) out.pop();
        });
      } else {
        blended(mode, deviceBox(m, w, h, 1), () => {
          out.pushClip(m, shape);
          out.pushBlur(sigma);
          out.fill(offset, bigRect().append(shapeOf(node, -s.spread) ?? shape), true, color);
          out.pop();
          out.pop();
        });
      }
    }
  };

  const glass = (node: NodeRecord, m: Matrix, unitPx: number) => {
    const effect = getProp(node.props, "effects").find(
      (e): e is Extract<Effect, { type: "glass" }> => e.type === "glass" && e.visible !== false,
    );
    if (!effect || omit.has("glass")) return;
    if (node.type !== "rect" && node.type !== "frame") return skip(`glass on ${node.type}`);
    const w = getProp(node.props, "width");
    const h = getProp(node.props, "height");
    const tune = glassTuning();
    const p = glassParams(effect, unitPx, tune, Math.min(w, h) / 2, "box");
    out.glass({
      transform: m,
      w,
      h,
      radii: radiiOf(node),
      refraction: p.refraction,
      depth: p.depth,
      dispersion: p.dispersion,
      frost: p.frost,
      splay: p.splay,
      light: [p.light.x, p.light.y],
      intensity: p.intensity,
      unitPx: p.unitPx,
      falloff: p.falloff,
      hairline: tune.hairline,
      front: tune.front,
      frontStart: tune.frontStart,
      back: tune.back,
      backStart: tune.backStart,
      shade: tune.shade,
      shadeReach: tune.shadeReach,
      region: deviceBox(m, w, h, 1),
      margin: p.margin,
    });
  };

  const fills = (node: NodeRecord, m: Matrix, alpha: number, blend: string) => {
    const w = getProp(node.props, "width");
    const h = getProp(node.props, "height");
    const paint = (p: Paint, path: Path, evenOdd: boolean) => {
      if (!shows(p)) return;
      if (p.type !== "solid") return skip(`${p.type} fill`);
      const mode = p.blendMode && p.blendMode !== "normal" ? p.blendMode : blend;
      blended(mode, deviceBox(m, w, h, 1), () =>
        out.fill(m, path, evenOdd, rgba(p.color, alpha * (p.opacity ?? 1))),
      );
    };
    if (node.type === "text") {
      const saved = savedText(node, MISSING_EVERYTHING, table);
      if (!saved) return skip("text without saved outlines");
      const own = getProp(node.props, "fills");
      for (const g of savedGlyphGroups(saved, node)) {
        const path = parseSvgPath(g.d);
        for (const b of g.bars) path.append(roundRect(b.w, b.h, [0, 0, 0, 0], 0));
        // Text with no fills at all draws black (render.ts).
        const paints =
          g.fills ?? (own.length ? own : [{ type: "solid", color: "#000000" } as Paint]);
        for (const p of paints) paint(p, path, false);
      }
      return;
    }
    const shape = shapeOf(node);
    if (!shape) return skip(`${node.type} shape`);
    for (const p of getProp(node.props, "fills")) paint(p, shape, false);
  };

  const strokes = (node: NodeRecord, m: Matrix, alpha: number, blend: string) => {
    const paints = getProp(node.props, "strokes").filter(shows);
    if (paints.length === 0) return;
    if (node.type === "text") return skip("text stroke");
    const shape = shapeOf(node);
    if (!shape) return skip(`${node.type} stroke`);
    const w = getProp(node.props, "width");
    const h = getProp(node.props, "height");
    const sides = strokeWidths(node);
    const align = getProp(node.props, "strokeAlign");
    const join = getProp(node.props, "strokeJoin");
    const dashes = getProp(node.props, "strokeDashes");
    const reach = Math.max(...sides) * 5 + 1;
    for (const p of paints) {
      if (p.type !== "solid") {
        skip(`${p.type} stroke`);
        continue;
      }
      const color = rgba(p.color, alpha * (p.opacity ?? 1));
      const mode = p.blendMode && p.blendMode !== "normal" ? p.blendMode : blend;
      blended(mode, deviceBox(m, w, h, reach), () => {
        if (!isUniform(sides) && (node.type === "rect" || node.type === "frame")) {
          const region = strokeRegion(
            w,
            h,
            radiiOf(node),
            sides,
            align,
            getProp(node.props, "cornerSmoothing"),
          );
          out.fill(m, parseSvgPath(strokeRegionPath(region)), true, color);
          return;
        }
        const weight = sides[0];
        const width = align === "center" ? weight : weight * 2;
        if (align === "inside") out.pushClip(m, shape);
        if (align === "outside") out.pushClip(m, bigRect().append(shape), true);
        const style = { width, join, cap: "butt", miter: 10 } as const;
        if (
          dashes.length > 0 &&
          (node.type === "rect" || node.type === "frame" || node.type === "ellipse")
        ) {
          // Dashes fitted to each side and corner, as Figma draws them (decision 0013).
          const outline =
            node.type === "ellipse"
              ? ellipseOutline(w, h)
              : boxOutline(w, h, radiiOf(node), getProp(node.props, "cornerSmoothing"));
          for (const piece of outline) {
            const path = new Path();
            if (piece.kind === "line") path.moveTo(piece.x0, piece.y0).lineTo(piece.x1, piece.y1);
            else if (piece.kind === "cubic") {
              const c = piece.pts as number[];
              path.moveTo(c[0] as number, c[1] as number);
              for (let i = 2; i < c.length; i += 6)
                path.cubicTo(
                  c[i] as number,
                  c[i + 1] as number,
                  c[i + 2] as number,
                  c[i + 3] as number,
                  c[i + 4] as number,
                  c[i + 5] as number,
                );
            } else {
              path.moveTo(
                piece.cx + piece.rx * Math.cos(piece.start),
                piece.cy + piece.ry * Math.sin(piece.start),
              );
              arc(path, piece.cx, piece.cy, piece.rx, piece.ry, piece.start, piece.end);
            }
            const fit = fitDashes(piece.length, dashes);
            out.stroke(m, path, { ...style, dashes: fit.dashes, dashOffset: fit.offset }, color);
          }
        } else out.stroke(m, shape, { ...style, dashes, dashOffset: 0 }, color);
        if (align !== "center") out.pop();
      });
    }
  };

  /** Whether a see-through layer fades as one picture (render.ts, `fadesAsOne`). */
  const fadesAsOne = (node: NodeRecord, children: number) => {
    if (getProp(node.props, "opacity") >= 1) return false;
    if (children > 0) return true;
    const shadow = getProp(node.props, "effects").some(
      (e) => e.visible !== false && (e.type === "drop-shadow" || e.type === "inner-shadow"),
    );
    const parts =
      getProp(node.props, "fills").filter((p) => p.visible !== false).length +
      getProp(node.props, "strokes").filter((p) => p.visible !== false).length;
    return shadow || parts > 1;
  };

  const draw = (id: string, alpha: number, inherited: string) => {
    const node = doc.get(id);
    if (!node || getProp(node.props, "visible") === false) return;
    layers++;
    if (getProp(node.props, "isMask")) return skip("mask");
    if (!["frame", "rect", "ellipse", "text", "group"].includes(node.type)) skip(node.type);
    if (
      getProp(node.props, "effects").some(
        (e) => e.type === "background-blur" && e.visible !== false,
      )
    )
      skip("background blur");
    const kids = doc.childIds(id);
    const opacity = getProp(node.props, "opacity");
    const own = getProp(node.props, "blendMode");
    const blend = own === "normal" ? inherited : own;
    const post = postEffects(getProp(node.props, "effects"));
    const linear = blend === "linear-dodge" || blend === "linear-burn";
    const whole = post.length > 0 || fadesAsOne(node, kids.length) || linear;
    const m = mul(device, scene.worldMatrix(id));
    const unitPx = Math.hypot(m[0], m[1]);
    // Glass reads the canvas before the layer is drawn apart (render.ts, `#drawProcessed`).
    if (node.type !== "group") glass(node, m, unitPx);
    if (whole) {
      const extent = scene.extent(id);
      const bounds = extent
        ? clampBounds([
            extent.x * scale + device[4],
            extent.y * scale + device[5],
            (extent.x + extent.width) * scale + device[4],
            (extent.y + extent.height) * scale + device[5],
          ])
        : clampBounds([0, 0, width, height]);
      const code = BLENDS[blend] ?? 0;
      if (blend !== "normal" && !KERNEL_BLENDS.has(code)) skip(`blend ${blend}`);
      if (code !== 0 && !omit.has("apart")) out.pushIsolate(code, alpha * opacity, bounds);
      else out.pushGroup(alpha * opacity, 0);
      for (const effect of post) {
        if (effect.type === "layer-blur") out.pushBlur((effect.radius * unitPx) / 2);
        else skip(effect.type);
      }
      content(node, kids, m, 1, "normal", unitPx);
      for (const effect of post) if (effect.type === "layer-blur") out.pop();
      out.pop();
    } else content(node, kids, m, alpha * opacity, blend, unitPx);
  };

  const content = (
    node: NodeRecord,
    kids: readonly string[],
    m: Matrix,
    alpha: number,
    blend: string,
    unitPx: number,
  ) => {
    if (node.type === "group") {
      for (const k of kids) draw(k, alpha, blend);
      return;
    }
    shadows(node, m, "drop-shadow", alpha, blend, unitPx);
    fills(node, m, alpha, blend);
    shadows(node, m, "inner-shadow", alpha, blend, unitPx);
    if (kids.length) {
      const clip = node.type === "frame" && getProp(node.props, "clipContent");
      const shape = clip ? shapeOf(node) : null;
      if (shape) out.pushClip(m, shape);
      for (const k of kids) draw(k, alpha, blend);
      if (shape) out.pop();
    }
    strokes(node, m, alpha, blend);
  };

  draw(boardId, 1, "normal");
  const names = Object.fromEntries(
    [...out.counts].map(([code, n]) => [
      ["", "fill", "stroke", "pushClip", "pushGroup", "pushBlur", "pop", "pushIsolate", "glass"][
        code
      ] ?? String(code),
      n,
    ]),
  );
  return { bytes: out.bytes(), width, height, layers, unsupported, ops: names };
}
