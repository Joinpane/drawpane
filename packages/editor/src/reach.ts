/**
 * How far past its bounds a layer can paint, in page units: what culling
 * pads a layer by, and what a change to it may repaint.
 */
import { getProp, type NodeRecord, type PropValues } from "@drawpane/model";
import { paintOutset } from "./export";
import { markerLength } from "./markers";
import { postEffects, postReach } from "./post-effects";

/**
 * What the renderer pads a layer's bounds by when it culls (besides a
 * margin in screen pixels for strokes and type): its drop shadows, end
 * markers, and the blur and texture that spread all of it.
 */
export function effectReach(node: NodeRecord): number {
  let reach = 0;
  const effects = getProp(node.props, "effects");
  for (const e of effects)
    if (e.visible !== false && e.type === "drop-shadow")
      reach = Math.max(reach, Math.abs(e.x) + Math.abs(e.y) + e.blur * 2 + Math.max(0, e.spread));
  if (
    (node.type === "line" || node.type === "path") &&
    (getProp(node.props, "markerStart") !== "none" || getProp(node.props, "markerEnd") !== "none")
  )
    reach = Math.max(reach, markerLength(getProp(node.props, "strokeWeight")));
  // Blur and texture spread everything above: their reach adds.
  return reach + postReach(postEffects(effects));
}

/**
 * A margin all round that holds everything the layer paints outside its
 * bounds: the cull's reach and the export's outset (strokes outside the box
 * included), grown for rotation, since bounds are upright and the outset
 * runs along the layer's own axes.
 */
export function paintMargin(node: NodeRecord): number {
  const o = paintOutset(node);
  const outset = Math.max(o.left, o.top, o.right, o.bottom);
  return Math.max(effectReach(node), outset * Math.SQRT2) + textOverflow(node);
}

/** No glyph is wider than this many ems, emoji and wide CJK forms included, with room to spare. */
const WIDEST_GLYPH_EM = 1.5;

/**
 * How far a fixed-size text layer's type may run past its box, at most,
 * without laying it out (which, for every text on a large page, would cost
 * seconds): culling only needs a box sure to hold it. Text that sizes itself
 * (`textAutoResize` width or height) fits its box and returns 0.
 *
 * Lines: a paragraph wraps where the next word doesn't fit, so each wrapped
 * line and the next line's first word are together wider than the box;
 * summed, a paragraph of advance A in a box of width W makes at most
 * 2A / W + 1 lines (a word wider than the box broken by character still
 * leaves a character a line). Advances are bounded by the widest glyph at
 * the largest size any run uses, plus letter spacing; line height by the
 * largest any run uses. A word wider than the box may also run past it
 * sideways by its own width. Held against the real layout in
 * `test/reach.test.ts`.
 */
export function textOverflow(node: NodeRecord): number {
  if (node.type !== "text") return 0;
  const props = node.props;
  if (getProp(props, "textAutoResize") !== "none") return 0;
  const text = getProp(props, "characters");
  if (text.length === 0) return 0;
  const runs = getProp(props, "textRuns");
  let size = getProp(props, "fontSize");
  const lineOf = (lh: PropValues["lineHeight"], fontSize: number) =>
    lh.unit === "px" ? lh.value : lh.unit === "percent" ? (fontSize * lh.value) / 100 : 0;
  const spacingOf = (ls: PropValues["letterSpacing"], fontSize: number) =>
    Math.max(0, ls.unit === "px" ? ls.value : (fontSize * ls.value) / 100);
  for (const run of runs) if (run.fontSize !== undefined) size = Math.max(size, run.fontSize);
  let spacing = spacingOf(getProp(props, "letterSpacing"), size);
  let line = lineOf(getProp(props, "lineHeight"), size);
  for (const run of runs) {
    if (run.letterSpacing) spacing = Math.max(spacing, spacingOf(run.letterSpacing, size));
    if (run.lineHeight) line = Math.max(line, lineOf(run.lineHeight, size));
  }
  // A font's own line height is its ascent and descent: under twice its size for any text face.
  line = Math.max(line, size * 2);
  const advance = WIDEST_GLYPH_EM * size + spacing;
  const width = Math.max(getProp(props, "width"), advance);
  let lines = 0;
  let longest = 0;
  for (const paragraph of text.split("\n")) {
    lines += Math.ceil((2 * paragraph.length * advance) / width) + 1;
    for (const word of paragraph.split(/\s+/)) longest = Math.max(longest, word.length);
  }
  const height = lines * line + (text.split("\n").length - 1) * getProp(props, "paragraphSpacing");
  return Math.max(
    0,
    height - getProp(props, "height"),
    longest * advance - getProp(props, "width"),
  );
}
