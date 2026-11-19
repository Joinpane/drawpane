/**
 * Kit parity's score (apps/web/e2e/kit-parity.spec.ts, `score`), in Node: both pictures laid
 * over white, the mean difference over RGB (0 to 255, to a hundredth), the 99th percentile of
 * each pixel's largest channel difference, and the share of pixels more than 32 apart. Inputs
 * are straight (unpremultiplied) RGBA, as PNGs hold them.
 */
export interface Score {
  readonly mean: number;
  readonly p99: number;
  readonly changed: number;
  /** Largest channel difference anywhere. */
  readonly max: number;
}

export function overWhite(rgba: Uint8Array | Uint8ClampedArray): Uint8Array {
  const out = new Uint8Array(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    const a = (rgba[i + 3] as number) / 255;
    for (let c = 0; c < 3; c++)
      out[i + c] = Math.round((rgba[i + c] as number) * a + 255 * (1 - a));
    out[i + 3] = 255;
  }
  return out;
}

export function score(
  ours: Uint8Array | Uint8ClampedArray,
  theirs: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
): Score & { heat: Uint8Array } {
  const n = width * height;
  if (ours.length !== n * 4 || theirs.length !== n * 4) throw new Error("Sizes differ");
  const a = overWhite(ours);
  const b = overWhite(theirs);
  const histogram = new Uint32Array(256);
  const heat = new Uint8Array(n * 4);
  let sum = 0;
  let changed = 0;
  let max = 0;
  for (let i = 0; i < n; i++) {
    const dr = Math.abs((a[i * 4] as number) - (b[i * 4] as number));
    const dg = Math.abs((a[i * 4 + 1] as number) - (b[i * 4 + 1] as number));
    const db = Math.abs((a[i * 4 + 2] as number) - (b[i * 4 + 2] as number));
    sum += (dr + dg + db) / 3;
    const d = Math.max(dr, dg, db);
    histogram[d] = (histogram[d] ?? 0) + 1;
    if (d > 32) changed++;
    if (d > max) max = d;
    const v = Math.min(255, d * 4);
    heat[i * 4] = v;
    heat[i * 4 + 1] = v;
    heat[i * 4 + 2] = v;
    heat[i * 4 + 3] = 255;
  }
  const at = Math.floor(n * 0.99);
  let p99 = 0;
  for (let v = 0, seen = 0; v < 256; v++) {
    seen += histogram[v] ?? 0;
    if (seen > at) {
      p99 = v;
      break;
    }
  }
  return {
    mean: Math.round((sum / n) * 100) / 100,
    p99,
    changed: Math.round((changed / n) * 10000) / 10000,
    max,
    heat,
  };
}
