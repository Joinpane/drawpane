/**
 * Figma's text as Drawpane's: the base style as the layer's typography, and
 * Figma's per-character style overrides as runs. Figma keeps line height and
 * alignment per paragraph; Drawpane per layer, so a text that varies them
 * takes its base style's, with a note.
 */
import type { FontFeatures, LetterSpacing, LineHeight, Paint, TextRun } from "@drawpane/model";
import type { Notes } from "./notes";
import { convertPaints, type ImageLookup } from "./paint";
import type * as Figma from "./rest";

type Props = Record<string, unknown>;
const round2 = (n: number) => Math.round(n * 100) / 100;

function lineHeight(s: Figma.TypeStyle): LineHeight | undefined {
  switch (s.lineHeightUnit) {
    case "PIXELS":
      return s.lineHeightPx === undefined
        ? undefined
        : { unit: "px", value: round2(s.lineHeightPx) };
    case "FONT_SIZE_%":
      return s.lineHeightPercentFontSize === undefined
        ? undefined
        : { unit: "percent", value: round2(s.lineHeightPercentFontSize) };
    case "INTRINSIC_%":
      return { unit: "auto" };
    default:
      return undefined;
  }
}

function features(s: Figma.TypeStyle): FontFeatures | undefined {
  const out: Record<string, boolean> = {};
  for (const [tag, on] of Object.entries(s.opentypeFlags ?? {}))
    if (/^[A-Za-z0-9]{4}$/.test(tag)) out[tag.toLowerCase()] = on !== 0;
  if (s.textCase === "SMALL_CAPS") out.smcp = true;
  if (s.textCase === "SMALL_CAPS_FORCED") Object.assign(out, { smcp: true, c2sc: true });
  return Object.keys(out).length > 0 ? out : undefined;
}

const CASES: Readonly<Record<string, "none" | "upper" | "lower" | "title">> = {
  ORIGINAL: "none",
  UPPER: "upper",
  LOWER: "lower",
  TITLE: "title",
};
const DECORATIONS: Readonly<Record<string, "none" | "underline" | "strikethrough">> = {
  NONE: "none",
  UNDERLINE: "underline",
  STRIKETHROUGH: "strikethrough",
};

/** The character-level typography of a style: what a run can set. */
function typography(s: Figma.TypeStyle): Props {
  const out: Props = {};
  if (s.fontFamily) out.fontFamily = s.fontFamily;
  if (s.fontWeight) out.fontWeight = Math.round(s.fontWeight);
  if (s.italic !== undefined || s.fontStyle)
    out.fontStyle = s.italic || /italic|oblique/i.test(s.fontStyle ?? "") ? "italic" : "normal";
  if (s.fontSize) out.fontSize = round2(s.fontSize);
  if (s.letterSpacingPercentFontSize !== undefined)
    out.letterSpacing = {
      unit: "percent",
      value: round2(s.letterSpacingPercentFontSize),
    } satisfies LetterSpacing;
  else if (s.letterSpacing !== undefined)
    out.letterSpacing = { unit: "px", value: round2(s.letterSpacing) } satisfies LetterSpacing;
  if (s.textCase && CASES[s.textCase]) out.textCase = CASES[s.textCase];
  if (s.textDecoration && DECORATIONS[s.textDecoration])
    out.textDecoration = DECORATIONS[s.textDecoration];
  // Line height is a character style too (decision 0018): a line takes its tallest.
  const lh = lineHeight(s);
  if (lh) out.lineHeight = lh;
  const f = features(s);
  if (f) out.fontFeatures = f;
  return out;
}

const ALIGN = { LEFT: "left", CENTER: "center", RIGHT: "right", JUSTIFIED: "justify" } as const;
const VALIGN = { TOP: "top", CENTER: "middle", BOTTOM: "bottom" } as const;

/** A text layer's own props: the base style, its box behaviour, its fills and runs. */
export function textProps(
  node: Figma.Node,
  images: ImageLookup,
  notes: Notes,
  variables?: (alias: unknown) => string | undefined,
): Props {
  const s = node.style ?? {};
  const props: Props = { characters: node.characters ?? "", ...typography(s) };
  const lh = lineHeight(s);
  if (lh) props.lineHeight = lh;
  if (s.textAlignHorizontal && s.textAlignHorizontal in ALIGN)
    props.textAlign = ALIGN[s.textAlignHorizontal as keyof typeof ALIGN];
  if (s.textAlignVertical && s.textAlignVertical in VALIGN)
    props.textAlignVertical = VALIGN[s.textAlignVertical as keyof typeof VALIGN];
  switch (s.textAutoResize) {
    case "WIDTH_AND_HEIGHT":
      props.textAutoResize = "width";
      break;
    case "HEIGHT":
      props.textAutoResize = "height";
      break;
    default:
      props.textAutoResize = "none";
  }
  if (s.textTruncation === "ENDING" || s.textAutoResize === "TRUNCATE")
    props.maxLines = Math.max(1, Math.min(1000, s.maxLines ?? 1));
  if (s.paragraphSpacing) props.paragraphSpacing = Math.min(1000, round2(s.paragraphSpacing));
  if (s.listSpacing) props.listSpacing = Math.min(1000, round2(s.listSpacing));
  if (s.leadingTrim === "CAP_HEIGHT") props.leadingTrim = "cap-height";
  props.fills = convertPaints(node.fills, images, notes, variables);
  const runs = withLists(textRuns(node, images, notes), node);
  if (runs.length > 0) props.textRuns = runs;
  return props;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Figma's overrides (one style id per character, 0 for the base style) as
 * runs over the characters that differ, each with only what differs.
 */
export function textRuns(node: Figma.Node, images: ImageLookup, notes: Notes): TextRun[] {
  const ids = node.characterStyleOverrides ?? [];
  const table = node.styleOverrideTable ?? {};
  const base = typography(node.style ?? {});
  const baseFills = convertPaints(node.fills, images, notes);
  const runs: TextRun[] = [];
  let paragraphStyles = false;
  for (let start = 0; start < ids.length; ) {
    const id = ids[start] ?? 0;
    let end = start + 1;
    while (end < ids.length && ids[end] === id) end++;
    const style = id === 0 ? undefined : table[String(id)];
    if (style) {
      // What Drawpane keeps for the whole text only: alignment and paragraph spacing.
      if (
        (style.textAlignHorizontal !== undefined &&
          style.textAlignHorizontal !== node.style?.textAlignHorizontal) ||
        (style.paragraphSpacing !== undefined &&
          style.paragraphSpacing !== (node.style?.paragraphSpacing ?? 0))
      )
        paragraphStyles = true;
      const t = typography(style);
      const run: Record<string, unknown> = { start, end };
      for (const [k, v] of Object.entries(t)) if (!same(v, base[k])) run[k] = v;
      if (style.fills) {
        const fills: Paint[] = convertPaints(style.fills, images, notes);
        if (!same(fills, baseFills)) run.fills = fills.slice(0, 8);
      }
      if (Object.keys(run).length > 2) runs.push(run as unknown as TextRun);
    }
    start = end;
  }
  if (paragraphStyles) notes.add("text-paragraphs");
  return runs.slice(0, 10_000);
}

/**
 * Figma's lists, a list type and indentation per line (paragraph), as list
 * props on each paragraph's characters (decision 0017), merged into the
 * character runs: where a run and a paragraph overlap, the overlap has both.
 */
export function withLists(runs: readonly TextRun[], node: Figma.Node): TextRun[] {
  const types = node.lineTypes ?? [];
  if (!types.some((t) => t !== "NONE")) return [...runs];
  const text = node.characters ?? "";
  const paragraphs: Array<{ start: number; end: number; props: Partial<TextRun> }> = [];
  let start = 0;
  text.split("\n").forEach((line, i) => {
    const end = Math.min(text.length, start + line.length + 1);
    const type = types[i] ?? "NONE";
    if (type !== "NONE" && end > start) {
      const level = Math.max(0, Math.min(8, (node.lineIndentations?.[i] ?? 1) - 1));
      paragraphs.push({
        start,
        end,
        props: {
          listType: type === "ORDERED" ? "number" : "bullet",
          ...(level > 0 ? { listLevel: level } : {}),
        },
      });
    }
    start = end;
  });
  // Every boundary of either, then each stretch between two with what covers it.
  const cuts = [...new Set([...runs, ...paragraphs].flatMap((r) => [r.start, r.end]))].sort(
    (a, b) => a - b,
  );
  const out: TextRun[] = [];
  for (let k = 0; k + 1 < cuts.length; k++) {
    const a = cuts[k] as number;
    const b = cuts[k + 1] as number;
    const run = runs.find((r) => r.start <= a && b <= r.end);
    const para = paragraphs.find((p) => p.start <= a && b <= p.end);
    if (!run && !para) continue;
    const { start: _s, end: _e, ...style } = run ?? { start: a, end: b };
    const merged = { start: a, end: b, ...style, ...para?.props } as TextRun;
    const last = out[out.length - 1];
    const { start: _ls, end: le, ...lastStyle } = last ?? { start: 0, end: -1 };
    const { start: _ms, end: _me, ...mergedStyle } = merged;
    if (last && le === a && same(lastStyle, mergedStyle)) out[out.length - 1] = { ...last, end: b };
    else out.push(merged);
  }
  return out;
}
