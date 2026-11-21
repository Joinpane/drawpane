/**
 * Linear dodge and burn in SVG (decision 0038). The SVG export builds the
 * sum from widely supported blends on opaque pictures, where each step
 * is plain arithmetic:
 *
 * - the backdrop's copy (for burn, inverted: a white difference);
 * - the source laid on black (for burn, its inverse: what's dark adds up)
 *   at half opacity over it: their average, (a + b) / 2;
 * - mid grey by colour-dodge: a / (1 - 1/2), so twice that, clamped at 1;
 * - for burn, inverted back.
 *
 * That's exact where the backdrop is opaque. Where it's empty, linear
 * dodge and burn both give the source as it is. So the sum is drawn masked
 * by the backdrop's alpha, and the source as it is masked by the rest:
 * exact where the backdrop is opaque or empty, as on the canvas
 * (linear-blend.ts), and mixed at its anti-aliased edges.
 */
import type { Rect } from "./geometry";
import type { LinearMode } from "./linear-blend";

const n = (v: number) => String(Math.round(v * 1000) / 1000);

/** The region rounded out to whole units. */
export function linearRegion(r: Rect): Rect {
  const x = Math.floor(r.x);
  const y = Math.floor(r.y);
  return { x, y, width: Math.ceil(r.x + r.width) - x, height: Math.ceil(r.y + r.height) - y };
}

const INVERT = 'type="matrix" values="-1 0 0 0 1 0 -1 0 0 1 0 0 -1 0 1 0 0 0 1 0"';
/** Black, keeping the alpha. */
const SILHOUETTE = 'type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0"';

/**
 * Markup (and its defs) for `source` blended by linear dodge or burn into
 * what `backdrop` draws (references to markup drawn already), within `r`:
 * drawn after the backdrop, over it. `id` makes the defs' ids.
 */
export function linearBlendMarkup(
  mode: LinearMode,
  r: Rect,
  backdrop: string,
  source: string,
  id: (prefix: string) => string,
): { defs: string[]; markup: string } {
  const box = `x="${n(r.x)}" y="${n(r.y)}" width="${n(r.width)}" height="${n(r.height)}"`;
  const region = `filterUnits="userSpaceOnUse" ${box} color-interpolation-filters="sRGB"`;
  const rect = (fill: string, blend?: string) =>
    `<rect ${box} fill="${fill}"${blend ? ` style="mix-blend-mode:${blend}"` : ""}/>`;
  const inverse = id("invert");
  const black = id("black");
  const covered = id("under");
  const bare = id("bare");
  const defs = [
    `<filter id="${inverse}" ${region}><feColorMatrix ${INVERT}/></filter>`,
    `<filter id="${black}" ${region}><feColorMatrix ${SILHOUETTE}/></filter>`,
    // Where something's under it, by how much; and where nothing is.
    `<mask id="${covered}" maskUnits="userSpaceOnUse" ${box} mask-type="alpha">${backdrop}</mask>`,
    `<mask id="${bare}" maskUnits="userSpaceOnUse" ${box}>${rect("#fff")}<g filter="url(#${black})">${backdrop}</g></mask>`,
  ];
  const burn = mode === "linear-burn";
  const addend = burn ? `<g filter="url(#${inverse})">${source}</g>` : source;
  const sum = [
    backdrop,
    burn ? rect("#fff", "difference") : "",
    `<g opacity="0.5">${rect("#000")}${addend}</g>`,
    rect("#808080", "color-dodge"),
    burn ? rect("#fff", "difference") : "",
  ].join("");
  return {
    defs,
    markup: `<g mask="url(#${covered})">${sum}</g><g mask="url(#${bare})">${source}</g>`,
  };
}
