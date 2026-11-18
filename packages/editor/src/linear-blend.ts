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
 * or empty (where both are partly see-through it adds the alphas too). It
 * has no linear burn, but burn is dodge between the two pictures' inverses,
 * inverted back: `BlendApart` does that through two scratch canvases.
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

/**
 * Drawing apart, then blending in. Linear burn: what's under the box is
 * copied, inverted, into a scratch canvas; the drawing, made on a second one
 * as `ctx` would make it, is added to that inverted ("lighter"); the sum
 * goes back inverted, through `ctx`'s clip. Any other mode: the drawing made
 * apart is laid on `ctx` in that mode, for drawings a canvas blends wrongly
 * in place (a shadow cast from a shape drawn off the canvas comes out empty
 * in Chrome when blended). Bounded by the box and the canvas; the scratch
 * canvases are kept and only grow.
 */
export class BlendApart {
  #source: AnyCanvas | null = null;
  #backdrop: AnyCanvas | null = null;

  /** Draws `draw` (given a context with `ctx`'s state, transform included) burnt into `ctx` within `box`. */
  burn(ctx: Ctx, box: DeviceBox, draw: (c: Ctx) => void): void {
    this.#apart(ctx, box, draw, "linear-burn");
  }

  /** Draws `draw` apart, as `burn` does, then lays it on `ctx` in `mode`. */
  blend(ctx: Ctx, box: DeviceBox, mode: GlobalCompositeOperation, draw: (c: Ctx) => void): void {
    this.#apart(ctx, box, draw, mode);
  }

  #apart(
    ctx: Ctx,
    box: DeviceBox,
    draw: (c: Ctx) => void,
    mode: GlobalCompositeOperation | "linear-burn",
  ): void {
    const x0 = Math.max(0, Math.floor(box.x0));
    const y0 = Math.max(0, Math.floor(box.y0));
    const x1 = Math.min(ctx.canvas.width, Math.ceil(box.x1));
    const y1 = Math.min(ctx.canvas.height, Math.ceil(box.y1));
    if (x1 <= x0 || y1 <= y0) return;
    const w = x1 - x0;
    const h = y1 - y0;
    this.#source = canvas(this.#source, w, h);
    const src = this.#source?.getContext("2d") as Ctx | null | undefined;
    if (!this.#source || !src) {
      draw(ctx);
      return;
    }
    // The drawing alone, as `ctx` would draw it, moved to the scratch canvas's corner.
    src.save();
    src.setTransform(1, 0, 0, 1, 0, 0);
    src.globalCompositeOperation = "source-over";
    src.globalAlpha = 1;
    src.filter = "none";
    src.clearRect(0, 0, w, h);
    copyState(ctx, src);
    const t = ctx.getTransform();
    src.setTransform(t.a, t.b, t.c, t.d, t.e - x0, t.f - y0);
    draw(src);
    src.restore();
    if (mode !== "linear-burn") {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.shadowColor = "transparent";
      ctx.filter = "none";
      ctx.globalCompositeOperation = mode;
      ctx.drawImage(this.#source, 0, 0, w, h, x0, y0, w, h);
      ctx.restore();
      return;
    }
    this.#backdrop = canvas(this.#backdrop, w, h);
    const back = this.#backdrop?.getContext("2d") as Ctx | null | undefined;
    if (!this.#backdrop || !back) return;
    // What's there, inverted, plus the drawing, inverted.
    back.save();
    back.setTransform(1, 0, 0, 1, 0, 0);
    back.globalAlpha = 1;
    back.globalCompositeOperation = "source-over";
    back.clearRect(0, 0, w, h);
    back.filter = "invert(1)";
    back.drawImage(ctx.canvas, x0, y0, w, h, 0, 0, w, h);
    back.globalCompositeOperation = "lighter";
    back.drawImage(this.#source, 0, 0, w, h, 0, 0, w, h);
    back.restore();
    // In its place, inverted back, within whatever clips `ctx`.
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.shadowColor = "transparent";
    ctx.filter = "none";
    ctx.globalCompositeOperation = "destination-out";
    ctx.fillStyle = "#000";
    ctx.fillRect(x0, y0, w, h);
    ctx.globalCompositeOperation = "source-over";
    ctx.filter = "invert(1)";
    ctx.drawImage(this.#backdrop, 0, 0, w, h, x0, y0, w, h);
    ctx.restore();
  }
}
