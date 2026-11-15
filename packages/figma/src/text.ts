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
  if (s.letterSpacing !== undefined)
    out.letterSpacing = { unit: "px", value: round2(s.letterSpacing) } satisfies LetterSpacing;
  if (s.textCase && CASES[s.textCase]) out.textCase = CASES[s.textCase];
  if (s.textDecoration && DECORATIONS[s.textDecoration])
    out.textDecoration = DECORATIONS[s.textDecoration];
  const f = features(s);
  if (f) out.fontFeatures = f;
  return out;
}

const ALIGN = { LEFT: "left", CENTER: "center", RIGHT: "right", JUSTIFIED: "justify" } as const;
const VALIGN = { TOP: "top", CENTER: "middle", BOTTOM: "bottom" } as const;

/** A text layer's own props: the base style, its box behaviour, its fills and runs. */
export function textProps(node: Figma.Node, images: ImageLookup, notes: Notes): Props {
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
  props.fills = convertPaints(node.fills, images, notes);
  const runs = textRuns(node, images, notes);
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
      if (style.lineHeightUnit || style.textAlignHorizontal || style.paragraphSpacing !== undefined)
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
