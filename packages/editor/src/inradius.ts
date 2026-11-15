/**
 * How thick a shape is: the radius of the largest circle that fits inside
 * it. Glass can't have a rim deeper than that (decision 0007): measured
 * against Figma, a thin bar or a glyph's stroke takes a rim only as deep as
 * it is thick, not the depth asked for.
 *
 * Boxes and ellipses know theirs. Anything else (a path, a star, text) is
 * drawn small, once per version of the layer, and measured with an exact
 * Euclidean distance transform.
 */
import { scratch } from "./webgl";

/** Pixels a shape is drawn into to be measured, at most: plenty for a clamp. */
const MEASURE_PIXELS = 262_144;
/** Pixels per unit, at most: small shapes needn't be drawn larger than this. */
const MEASURE_SCALE = 4;

/**
 * The radius of the largest circle inside a raster shape, in pixels: the
 * greatest distance from a pixel inside to the nearest pixel outside (past
 * the raster's edge is outside). Felzenszwalb and Huttenlocher's distance
 * transform, two passes of lower envelopes of parabolas: O(width × height).
 */
export function largestInscribedRadius(
  inside: ArrayLike<number>,
  width: number,
  height: number,
): number {
  if (width <= 0 || height <= 0) return 0;
  const INF = 1e20;
  // Squared distance to the nearest outside pixel, along each column first.
  const d = new Float64Array(width * height);
  const f = new Float64Array(Math.max(width, height) + 2);
  const out = new Float64Array(Math.max(width, height) + 2);
  const v = new Int32Array(Math.max(width, height) + 2);
  const z = new Float64Array(Math.max(width, height) + 3);
  // One line: f[0..n) in, out[0..n) out, with a pixel outside just past each end.
  const line = (n: number) => {
    // Positions -1 and n are outside (f = 0); the line's own are 1..n here.
    const m = n + 2;
    const at = (q: number) => (q === 0 || q === m - 1 ? 0 : (f[q - 1] as number));
    let k = 0;
    v[0] = 0;
    z[0] = -INF;
    z[1] = INF;
    for (let q = 1; q < m; q++) {
      let s: number;
      for (;;) {
        const p = v[k] as number;
        s = (at(q) + q * q - (at(p) + p * p)) / (2 * q - 2 * p);
        if (s <= (z[k] as number) && k > 0) k--;
        else break;
      }
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = INF;
    }
    k = 0;
    for (let q = 1; q < m - 1; q++) {
      while ((z[k + 1] as number) < q) k++;
      const p = v[k] as number;
      out[q - 1] = (q - p) * (q - p) + at(p);
    }
  };
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) f[y] = inside[y * width + x] ? INF : 0;
    line(height);
    for (let y = 0; y < height; y++) d[y * width + x] = out[y] as number;
  }
  let best = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) f[x] = d[y * width + x] as number;
    line(width);
    for (let x = 0; x < width; x++) best = Math.max(best, out[x] as number);
  }
  return Math.sqrt(best);
}

/** Measured thicknesses, by the layer's props (a new object with every edit). */
export class Inradii {
  readonly #measured = new WeakMap<object, { generation: number; radius: number }>();

  /**
   * The largest inscribed radius, in the layer's units, of what `draw` draws
   * (filled, in white, in units) over a w × h box. Infinite where nothing
   * can measure it. `generation` is the fonts' (see `TextMeasurer`): text
   * drawn before its font arrived is measured again once it has, as its
   * layout is.
   */
  get(
    props: object,
    w: number,
    h: number,
    draw: (ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D) => void,
    generation = 0,
  ): number {
    const known = this.#measured.get(props);
    if (known && known.generation === generation) return known.radius;
    const radius = measure(w, h, draw);
    this.#measured.set(props, { generation, radius });
    return radius;
  }
}

function measure(
  w: number,
  h: number,
  draw: (ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D) => void,
): number {
  if (!(w > 0 && h > 0)) return Number.POSITIVE_INFINITY;
  const scale = Math.min(MEASURE_SCALE, Math.sqrt(MEASURE_PIXELS / (w * h)));
  const pw = Math.max(1, Math.ceil(w * scale));
  const ph = Math.max(1, Math.ceil(h * scale));
  const canvas = scratch(null, pw, ph);
  const ctx = canvas?.getContext("2d", { willReadFrequently: true }) as
    | OffscreenCanvasRenderingContext2D
    | CanvasRenderingContext2D
    | null
    | undefined;
  if (!ctx) return Number.POSITIVE_INFINITY;
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.fillStyle = "#fff";
  draw(ctx);
  const { data } = ctx.getImageData(0, 0, pw, ph);
  const inside = new Uint8Array(pw * ph);
  for (let i = 0; i < inside.length; i++) inside[i] = (data[i * 4 + 3] as number) >= 128 ? 1 : 0;
  // Measured between pixel centres, it's up to half a pixel long: split the difference.
  return Math.max(0, largestInscribedRadius(inside, pw, ph) - 0.25) / scale;
}
