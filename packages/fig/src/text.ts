/**
 * A text layer's characters, base style, styled runs and lists in REST's
 * terms: a style per text, per-character style ids into a table of
 * overrides, and a list type and indentation per line (paragraph).
 *
 * Open Pencil keeps line heights in pixels; Figma's own record says when one
 * is a percentage of the font size, which the converter keeps as one so the
 * text scales with its size. The record's value is used only when it gives
 * the same pixels. Some percentages Figma lays out in whole pixels (162.5%
 * of 14 px as 23, not 22.75): its saved layout says which, and those come in
 * as the pixels Figma used.
 */
import type { Figma } from "@drawpane/figma";
import type { CharacterStyleOverride, FontFeature, SceneNode } from "@open-pencil/scene-graph";
import type { FigNotes } from "./notes";
import { convertFills } from "./paint";
import type { RawRecord } from "./raw";

type Writable<T> = { -readonly [K in keyof T]: T[K] };

function opentypeFlags(
  features: readonly FontFeature[] | undefined,
): Record<string, number> | undefined {
  if (!features || features.length === 0) return undefined;
  const out: Record<string, number> = {};
  for (const f of features) out[f.tag.toUpperCase()] = f.enabled ? 1 : 0;
  return out;
}

function lineHeight(
  px: number | null | undefined,
  fontSize: number,
  raw: RawRecord | undefined,
): Partial<Figma.TypeStyle> {
  if (px === undefined) return {};
  if (px === null) return { lineHeightUnit: "INTRINSIC_%" };
  const r = raw?.lineHeight;
  if (r?.value !== undefined && (r.units === "RAW" || r.units === "PERCENT")) {
    const percent = r.units === "RAW" ? r.value * 100 : r.value;
    if (Math.abs((percent / 100) * fontSize - px) < 0.01 && laidOutWhole(raw, px))
      return { lineHeightUnit: "PIXELS", lineHeightPx: Math.round(px) };
    if (Math.abs((percent / 100) * fontSize - px) < 0.01)
      return {
        lineHeightUnit: "FONT_SIZE_%",
        lineHeightPercentFontSize: percent,
        lineHeightPx: px,
      };
  }
  return { lineHeightUnit: "PIXELS", lineHeightPx: px };
}

/**
 * Whether Figma laid a fractional line height out as whole pixels, as its
 * saved layout (`derivedTextData`) shows: its lines are the rounded height
 * apart. In a 500k-layer commercial UI kit, 72 of the 105 text layers with a
 * fractional percentage were laid out whole, nearly all with their font size
 * bound to a variable; the same percentage on the others stayed exact.
 */
function laidOutWhole(raw: RawRecord | undefined, px: number): boolean {
  const saved = raw?.derivedTextData?.baselines?.[0]?.lineHeight;
  if (saved === undefined || Math.abs(px - Math.round(px)) < 0.01) return false;
  return Math.abs(saved - Math.round(px)) < 0.001;
}

/** The style of a stretch of characters that differs from the text's own. */
function runStyle(s: CharacterStyleOverride, fontSize: number, notes: FigNotes): Figma.TypeStyle {
  const out: Writable<Figma.TypeStyle> = {};
  if (s.fontFamily !== undefined) out.fontFamily = s.fontFamily;
  if (s.fontWeight !== undefined) out.fontWeight = s.fontWeight;
  if (s.italic !== undefined) out.italic = s.italic;
  if (s.fontSize !== undefined) out.fontSize = s.fontSize;
  if (s.letterSpacing !== undefined) out.letterSpacing = s.letterSpacing;
  if (s.textDecoration !== undefined) out.textDecoration = s.textDecoration;
  if (s.textCase !== undefined) out.textCase = s.textCase;
  if (s.lineHeight !== undefined)
    Object.assign(out, lineHeight(s.lineHeight, s.fontSize ?? fontSize, undefined));
  const flags = opentypeFlags(s.fontFeatures);
  if (flags) out.opentypeFlags = flags;
  if (s.fills) out.fills = convertFills(s.fills, undefined, notes);
  return out;
}

/** REST's text fields for a TEXT layer. */
export function textFields(
  n: SceneNode,
  raw: RawRecord | undefined,
  notes: FigNotes,
): Partial<Figma.Node> {
  const sameFont = raw?.fontName?.family === n.fontFamily;
  // Small caps aren't among Open Pencil's text cases; the record has them.
  const textCase =
    n.textCase === "ORIGINAL" &&
    (raw?.textCase === "SMALL_CAPS" || raw?.textCase === "SMALL_CAPS_FORCED")
      ? raw.textCase
      : n.textCase;
  const flags = opentypeFlags(n.fontFeatures);
  const style: Figma.TypeStyle = {
    fontFamily: n.fontFamily,
    ...(sameFont && raw?.fontName?.style ? { fontStyle: raw.fontName.style } : {}),
    ...(sameFont && raw?.fontName?.postscript
      ? { fontPostScriptName: raw.fontName.postscript }
      : {}),
    fontWeight: n.fontWeight,
    italic: n.italic,
    fontSize: n.fontSize,
    letterSpacing: n.letterSpacing,
    ...lineHeight(n.lineHeight, n.fontSize, raw?.fontSize === n.fontSize ? raw : undefined),
    textAlignHorizontal: n.textAlignHorizontal,
    textAlignVertical: n.textAlignVertical,
    textAutoResize: n.textAutoResize,
    textCase,
    textDecoration: n.textDecoration,
    ...(n.paragraphSpacing ? { paragraphSpacing: n.paragraphSpacing } : {}),
    ...(n.textTruncation === "ENDING" ? { textTruncation: "ENDING" } : {}),
    ...(n.maxLines !== null ? { maxLines: n.maxLines } : {}),
    ...(n.leadingTrim === "CAP_HEIGHT" ? { leadingTrim: "CAP_HEIGHT" as const } : {}),
    ...(flags ? { opentypeFlags: flags } : {}),
  };

  // Runs as REST has them: one style id per character, each distinct style numbered from 1.
  const characters = n.text;
  const overrides: number[] = [];
  const table: Record<string, Figma.TypeStyle> = {};
  const idOf = new Map<string, number>();
  for (const run of n.styleRuns) {
    const s = runStyle(run.style, n.fontSize, notes);
    if (Object.keys(s).length === 0) continue;
    const key = JSON.stringify(s);
    let id = idOf.get(key);
    if (id === undefined) {
      id = idOf.size + 1;
      idOf.set(key, id);
      table[String(id)] = s;
    }
    const end = Math.min(characters.length, run.start + run.length);
    while (overrides.length < run.start) overrides.push(0);
    for (let i = run.start; i < end; i++) overrides[i] = id;
  }

  // Lists, a type and indentation per paragraph; a text without any keeps none.
  const lineTypes: Array<"NONE" | "ORDERED" | "UNORDERED"> = [];
  const lineIndentations: number[] = [];
  if (n.textParagraphs.some((p) => p.listType !== "NONE")) {
    const count = characters.split("\n").length;
    for (let i = 0; i < count; i++) {
      const p = n.textParagraphs[i];
      lineTypes.push(p?.listType ?? "NONE");
      lineIndentations.push(p?.indentation ?? 0);
    }
  }

  return {
    characters,
    style,
    ...(overrides.length > 0
      ? { characterStyleOverrides: overrides, styleOverrideTable: table }
      : {}),
    ...(lineTypes.length > 0 ? { lineTypes, lineIndentations } : {}),
  };
}
