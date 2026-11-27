/**
 * Closed subpaths that only retrace themselves, like `M8 0 L0 8 Z` (an icon's line, closed by an
 * import): they enclose nothing, and stroked closed they make two outlines over the same ground,
 * one per side, both wound the same way. The engine's coverage is analytic (each edge adds its
 * area), so where the two outlines' edges coincide the anti-aliased pixels count twice: the line
 * comes out about half a pixel wider and hard-edged (shadcn's Dialog close icon scored 6.37
 * against Figma where the canvas renderer, which samples winding per point, scored 1.32).
 *
 * Stroked open instead, such a subpath paints the same ground once: its far ends turn 180°, so a
 * round join there is a round cap, and a miter (past any limit at 180°) or bevel join is a flat
 * end, a butt cap. The stroke stays one op over the whole path, so a translucent paint still
 * covers where its outlines overlap once: it takes the layer's own cap, so the builder opens
 * retraced subpaths only when that cap is the one their join makes.
 */
import { PathData, VERB } from "@drawpane/engine/wire";

/** Points closer than this (in the layer's units) are the same point. */
const SAME = 1e-4;

const same = (pts: readonly number[], a: number, b: number) =>
  Math.abs((pts[a * 2] as number) - (pts[b * 2] as number)) <= SAME &&
  Math.abs((pts[a * 2 + 1] as number) - (pts[b * 2 + 1] as number)) <= SAME;

const size = (v: number | undefined) =>
  v === VERB.move || v === VERB.line ? 2 : v === VERB.quad ? 4 : v === VERB.cubic ? 6 : 0;

/**
 * `path` with each retraced closed subpath rewritten open, in place, or `null` when it has none.
 * A subpath is retraced when it is closed, made of lines only, and its points read the same back
 * from the start (A B C B, then closing to A): the open path A B C draws the same ground.
 */
export function openRetraced(path: PathData): PathData | null {
  const out = new PathData();
  const { verbs, coords } = path;
  let found = false;
  let at = 0;
  let i = 0;
  while (i < verbs.length) {
    // One subpath: a move, then everything up to the next move.
    const start = i;
    const startAt = at;
    let j = i;
    let linesOnly = true;
    let closed = false;
    const pts: number[] = [];
    while (j < verbs.length && (j === start || verbs[j] !== VERB.move)) {
      const v = verbs[j];
      if (v === VERB.quad || v === VERB.cubic) linesOnly = false;
      if (v === VERB.close) closed = true;
      else if (closed) linesOnly = false; // Drawing on after a close: leave it alone.
      if (size(v) === 2) pts.push(coords[at] as number, coords[at + 1] as number);
      at += size(v);
      j++;
    }
    let count = pts.length / 2;
    // A last point back on the first is the close itself.
    if (count > 2 && same(pts, count - 1, 0)) count--;
    let isRetraced = closed && linesOnly && verbs[start] === VERB.move && count >= 2;
    for (let k = 1; isRetraced && k < count; k++) if (!same(pts, k, count - k)) isRetraced = false;
    if (isRetraced) {
      found = true;
      out.moveTo(pts[0] as number, pts[1] as number);
      for (let k = 1; k <= Math.floor(count / 2); k++)
        out.lineTo(pts[k * 2] as number, pts[k * 2 + 1] as number);
    } else {
      // Copied as it was, verb for verb.
      let c = startAt;
      for (let k = start; k < j; k++) {
        const v = verbs[k];
        out.verbs.push(v as number);
        for (let n = 0; n < size(v); n++) out.coords.push(coords[c + n] as number);
        c += size(v);
      }
    }
    i = j;
  }
  return found ? out : null;
}
