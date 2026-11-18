/**
 * A luminance mask's picture as an alpha mask (decision 0016): each pixel's
 * alpha becomes its luminance times its alpha, so light shows what's
 * masked and dark hides it. A tiny WebGL2 pass where there is one; a loop
 * over the pixels where there isn't.
 */
import {
  type AnyCanvas,
  begin,
  type Ctx,
  draw,
  fits,
  type QuadProgram,
  quadProgram,
  scratch,
  upload,
} from "./webgl";

// Premultiplied in, so the colour's luminance already carries its alpha.
const FRAGMENT = `#version 300 es
precision highp float;
in vec2 uv;
out vec4 color;
uniform sampler2D source;
void main() {
  vec4 c = texture(source, vec2(uv.x, 1.0 - uv.y));
  color = vec4(0.0, 0.0, 0.0, dot(c.rgb, vec3(0.2126, 0.7152, 0.0722)));
}`;

/** Rec. 709 luminance of a straight (not premultiplied) colour, times its alpha: 0–255. */
export function luminanceAlpha(r: number, g: number, b: number, a: number): number {
  return ((0.2126 * r + 0.7152 * g + 0.0722 * b) * a) / 255;
}

type Program = QuadProgram<"source", never>;

export class LuminanceMask {
  #program: Program | null | undefined;
  #source: AnyCanvas | null = null;

  #webgl(): Program | null {
    if (this.#program === undefined)
      this.#program = quadProgram({
        label: "luminance mask",
        fragment: FRAGMENT,
        textures: ["source"],
        uniforms: [],
        filter: "nearest",
        premultiply: true,
      });
    return this.#program;
  }

  /** Turns the w × h pixels at `canvas`'s top left into an alpha mask of their luminance, in place. */
  apply(canvas: AnyCanvas, w: number, h: number): void {
    const ctx = canvas.getContext("2d") as Ctx | null;
    if (!ctx || w <= 0 || h <= 0) return;
    const program = this.#webgl();
    if (program && fits(program, w, h)) {
      this.#source = scratch(this.#source, w, h);
      const source = this.#source?.getContext("2d") as Ctx | null | undefined;
      if (this.#source && source && begin(program, w, h)) {
        source.setTransform(1, 0, 0, 1, 0, 0);
        source.globalCompositeOperation = "copy";
        source.drawImage(canvas, 0, 0, w, h, 0, 0, w, h);
        upload(program, "source", this.#source);
        draw(program);
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalCompositeOperation = "copy";
        ctx.drawImage(program.canvas, 0, 0, w, h, 0, 0, w, h);
        ctx.restore();
        return;
      }
    }
    // No WebGL2: the same, a pixel at a time.
    const image = ctx.getImageData(0, 0, w, h);
    const d = image.data;
    for (let i = 0; i < d.length; i += 4) {
      const a = luminanceAlpha(
        d[i] as number,
        d[i + 1] as number,
        d[i + 2] as number,
        d[i + 3] as number,
      );
      d[i] = 0;
      d[i + 1] = 0;
      d[i + 2] = 0;
      d[i + 3] = a;
    }
    ctx.putImageData(image, 0, 0);
  }
}

/**
 * An outline mask's picture, for a mask that isn't one shape (a group, a
 * text, a line): wherever it draws anything, it masks fully, as Figma's
 * vector masks ignore translucency. Alpha times 255, kept to 255, as the
 * SVG export's `feFuncA slope="255"` does. Rare, so a loop over the pixels.
 */
export function opaqueAlpha(canvas: AnyCanvas, w: number, h: number): void {
  const ctx = canvas.getContext("2d") as Ctx | null;
  if (!ctx || w <= 0 || h <= 0) return;
  const image = ctx.getImageData(0, 0, w, h);
  const d = image.data;
  for (let i = 3; i < d.length; i += 4) if ((d[i] as number) > 0) d[i] = 255;
  ctx.putImageData(image, 0, 0);
}
