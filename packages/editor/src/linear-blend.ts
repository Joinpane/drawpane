/**
 * Linear dodge and linear burn (decision 0038): Figma's "Plus lighter" and
 * "Plus darker", Apple's plus-lighter and plus-darker. On premultiplied
 * colour `c` with alpha `a`, the source `s` over the backdrop `b`, Figma
 * keeps normal blending's alpha and
 *
 *   linear dodge: c = min(a, cs + cb)
 *   linear burn:  c = max(0, cs + cb - as * ab)
 *
 * with a = as + ab - as * ab. Over an opaque backdrop that's cb + cs,
 * clamped, and cb + cs - as, clamped: the dark grey that Apple adds makes a
 * faint highlight, where normal blending would darken.
 *
 * A canvas's "lighter" is linear dodge exactly where the backdrop is opaque
 * or empty; where both are partly see-through it adds the alphas too (a
 * component's translucent fills over nothing come out opaque and dark). It
 * has no linear burn, but burn is dodge between the two pictures' inverses,
 * inverted back (an inverse that keeps alpha: `filter: invert(1)`).
 * `BlendApart` draws both: in a step or three on a canvas known to be
 * opaque, exactly on any other through a few scratch canvases.
 */
import type { AnyCanvas, Ctx } from "./webgl";

export type LinearMode = "linear-dodge" | "linear-burn";

/** One channel of linear dodge or burn, 0 to 1, premultiplied; and the alpha. For tests and checks. */
export function linearBlend(
  mode: LinearMode,
  cs: number,
  as: number,
  cb: number,
  ab: number,
): { c: number; a: number } {
  const a = as + ab - as * ab;
  const c = mode === "linear-dodge" ? Math.min(a, cs + cb) : Math.max(0, cs + cb - as * ab);
  return { c, a };
}

/** A box in device pixels: [x0, x1) × [y0, y1). */
export interface DeviceBox {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

/** The device box of a box in the current units of `ctx`, grown by `pad` units. */
export function deviceBox(
  ctx: Ctx,
  x: number,
  y: number,
  w: number,
  h: number,
  pad = 0,
): DeviceBox {
  const t = ctx.getTransform();
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [px, py] of [
    [x - pad, y - pad],
    [x + w + pad, y - pad],
    [x - pad, y + h + pad],
    [x + w + pad, y + h + pad],
  ] as const) {
    xs.push(t.a * px + t.c * py + t.e);
    ys.push(t.b * px + t.d * py + t.f);
  }
  return {
    x0: Math.min(...xs) - 1,
    y0: Math.min(...ys) - 1,
    x1: Math.max(...xs) + 1,
    y1: Math.max(...ys) + 1,
  };
}

/** What a drawing reads from its context besides its own calls: carried to the scratch canvas. */
function copyState(from: Ctx, to: Ctx): void {
  to.globalAlpha = from.globalAlpha;
  to.globalCompositeOperation = "source-over";
  to.filter = from.filter;
  to.fillStyle = from.fillStyle;
  to.strokeStyle = from.strokeStyle;
  to.lineWidth = from.lineWidth;
  to.lineJoin = from.lineJoin;
  to.lineCap = from.lineCap;
  to.miterLimit = from.miterLimit;
  to.setLineDash(from.getLineDash());
  to.lineDashOffset = from.lineDashOffset;
  to.font = from.font;
  to.textAlign = from.textAlign;
  to.textBaseline = from.textBaseline;
  to.direction = from.direction;
  if ("letterSpacing" in from && "letterSpacing" in to)
    (to as Ctx & { letterSpacing: string }).letterSpacing = (
      from as Ctx & { letterSpacing: string }
    ).letterSpacing;
  to.imageSmoothingEnabled = from.imageSmoothingEnabled;
  to.imageSmoothingQuality = from.imageSmoothingQuality;
  to.shadowColor = from.shadowColor;
  to.shadowBlur = from.shadowBlur;
  to.shadowOffsetX = from.shadowOffsetX;
  to.shadowOffsetY = from.shadowOffsetY;
}

function canvas(existing: AnyCanvas | null, w: number, h: number): AnyCanvas | null {
  let c = existing;
  if (!c) {
    if (typeof OffscreenCanvas !== "undefined") c = new OffscreenCanvas(w, h);
    else if (typeof document !== "undefined") c = document.createElement("canvas");
    else return null;
  }
  // Grown, never shrunk: burns of every size share it without reallocating.
  if (c.width < w) c.width = w;
  if (c.height < h) c.height = h;
  return c;
}

type Apart = GlobalCompositeOperation | LinearMode;

/**
 * Drawing apart, then blending in, bounded by a box and the canvas; the
 * scratch canvases are kept and only grow.
 *
 * - Any canvas mode: the drawing, made on a scratch canvas as `ctx` would
 *   make it, is laid on `ctx` in that mode (for drawings a canvas blends
 *   wrongly in place: a shadow cast from a shape drawn off the canvas comes
 *   out empty in Chrome when blended).
 * - Linear dodge or burn over an opaque canvas: what's under the box is
 *   copied (inverted, for burn) to a scratch canvas, the drawing (inverted,
 *   for burn) is added ("lighter"), and the sum goes back (inverted back),
 *   through `ctx`'s clip.
 * - Linear dodge or burn over a canvas that may be see-through, exactly:
 *   the sum laid on black (an opaque picture of the premultiplied colour),
 *   clamped by normal blending's alpha as a grey (darken), divided by it
 *   (colour-dodge by its inverse) and multiplied back (destination-in with
 *   the drawing over what's there), then put back.
 */
export class BlendApart {
  readonly #canvases: (AnyCanvas | null)[] = [null, null, null, null];

  #scratch(i: number, w: number, h: number): Ctx | null {
    const c = canvas(this.#canvases[i] ?? null, w, h);
    this.#canvases[i] = c;
    const ctx = c?.getContext("2d") as Ctx | null | undefined;
    if (!ctx) return null;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.filter = "none";
    ctx.shadowColor = "transparent";
    ctx.clearRect(0, 0, w, h);
    return ctx;
  }

  /**
   * Draws `draw` (given a context with `ctx`'s state, transform included) into
   * `ctx` within `box`, blended by `mode`. `opaque`: everything under the box
   * is opaque (a canvas filled with an opaque background first).
   */
  blend(ctx: Ctx, box: DeviceBox, mode: Apart, draw: (c: Ctx) => void, opaque: boolean): void {
    const x0 = Math.max(0, Math.floor(box.x0));
    const y0 = Math.max(0, Math.floor(box.y0));
    const x1 = Math.min(ctx.canvas.width, Math.ceil(box.x1));
    const y1 = Math.min(ctx.canvas.height, Math.ceil(box.y1));
    if (x1 <= x0 || y1 <= y0) return;
    const w = x1 - x0;
    const h = y1 - y0;
    const src = this.#scratch(0, w, h);
    if (!src) {
      draw(ctx);
      return;
    }
    // The drawing alone, as `ctx` would draw it, moved to the scratch canvas's corner.
    src.save();
    copyState(ctx, src);
    const t = ctx.getTransform();
    src.setTransform(t.a, t.b, t.c, t.d, t.e - x0, t.f - y0);
    draw(src);
    src.restore();
    const drawing = src.canvas;
    const linear = mode === "linear-dodge" || mode === "linear-burn";
    if (!linear || (opaque && mode === "linear-dodge")) {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.shadowColor = "transparent";
      ctx.filter = "none";
      ctx.globalCompositeOperation = linear ? "lighter" : mode;
      ctx.drawImage(drawing, 0, 0, w, h, x0, y0, w, h);
      ctx.restore();
      return;
    }
    const invert = mode === "linear-burn" ? "invert(1)" : "none";
    const sum = this.#scratch(1, w, h);
    if (!sum) return;
    // What's there plus the drawing (their inverses, for burn).
    sum.filter = invert;
    sum.drawImage(ctx.canvas, x0, y0, w, h, 0, 0, w, h);
    sum.globalCompositeOperation = "lighter";
    sum.drawImage(drawing, 0, 0, w, h, 0, 0, w, h);
    sum.filter = "none";
    if (!opaque) {
      const over = this.#scratch(2, w, h);
      const alpha = this.#scratch(3, w, h);
      if (!over || !alpha) return;
      // The alpha normal blending gives: the drawing over what's there.
      over.drawImage(ctx.canvas, x0, y0, w, h, 0, 0, w, h);
      over.drawImage(drawing, 0, 0, w, h, 0, 0, w, h);
      // That alpha as an opaque grey.
      alpha.drawImage(over.canvas, 0, 0, w, h, 0, 0, w, h);
      alpha.globalCompositeOperation = "source-in";
      alpha.fillStyle = "#fff";
      alpha.fillRect(0, 0, w, h);
      alpha.globalCompositeOperation = "destination-over";
      alpha.fillStyle = "#000";
      alpha.fillRect(0, 0, w, h);
      // The sum on black, clamped at the alpha, divided by it and multiplied back.
      sum.globalCompositeOperation = "destination-over";
      sum.fillStyle = "#000";
      sum.fillRect(0, 0, w, h);
      sum.globalCompositeOperation = "darken";
      sum.drawImage(alpha.canvas, 0, 0, w, h, 0, 0, w, h);
      alpha.globalCompositeOperation = "difference";
      alpha.fillStyle = "#fff";
      alpha.fillRect(0, 0, w, h);
      sum.globalCompositeOperation = "color-dodge";
      sum.drawImage(alpha.canvas, 0, 0, w, h, 0, 0, w, h);
      sum.globalCompositeOperation = "destination-in";
      sum.drawImage(over.canvas, 0, 0, w, h, 0, 0, w, h);
    }
    // In its place (inverted back, for burn), within whatever clips `ctx`.
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.shadowColor = "transparent";
    ctx.filter = "none";
    ctx.globalCompositeOperation = "destination-out";
    ctx.fillStyle = "#000";
    ctx.fillRect(x0, y0, w, h);
    ctx.globalCompositeOperation = "source-over";
    ctx.filter = invert;
    ctx.drawImage(sum.canvas, 0, 0, w, h, x0, y0, w, h);
    ctx.restore();
  }
}
