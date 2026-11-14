/**
 * Penpot text to a Drawpane text layer. Penpot keeps a tree, root >
 * paragraph-set > paragraphs > leaves, each leaf a stretch of text with its
 * own font, size, fill and so on. Drawpane keeps the characters (paragraphs
 * joined by line breaks), the layer's own typography, and runs for the
 * characters styled otherwise. The most-used style becomes the layer's; the
 * rest become runs. Line height and alignment are per layer in Drawpane, so
 * the first paragraph's win.
 */
import type { Paint, TextRun } from "@drawpane/model";
import type { Notes } from "./notes";
import { fills, type MediaLookup, num } from "./styles";

type Raw = Record<string, unknown>;

/** The run-able part of a text style, as Drawpane props. */
interface Style {
  fontFamily: string;
  fontWeight: number;
  fontStyle: "normal" | "italic";
  fontSize: number;
  letterSpacing: { unit: "px"; value: number };
  textCase: "none" | "upper" | "lower" | "title";
  textDecoration: "none" | "underline" | "strikethrough";
  fills: Paint[];
}
const STYLE_KEYS = [
  "fontFamily",
  "fontWeight",
  "fontStyle",
  "fontSize",
  "letterSpacing",
  "textCase",
  "textDecoration",
  "fills",
] as const;

const DEFAULT_FAMILY = "Source Sans 3";

/** A Penpot family name to the one Drawpane's font registry knows. */
export function familyName(raw: unknown, fontId: unknown, notes?: Notes): string {
  const name = typeof raw === "string" ? raw.replace(/^["']|["']$/g, "").trim() : "";
  if (typeof fontId === "string" && fontId.startsWith("custom-")) notes?.add("custom-font");
  // Penpot's built-in font; Google now calls it Source Sans 3.
  if (!name || name.toLowerCase() === "sourcesanspro" || name === "Source Sans Pro")
    return DEFAULT_FAMILY;
  return name.slice(0, 128);
}

const CASE: Record<string, Style["textCase"]> = {
  uppercase: "upper",
  lowercase: "lower",
  capitalize: "title",
};

function styleOf(node: Raw, inherited: Raw, media: MediaLookup, notes: Notes): Style {
  const get = (key: string) => {
    const own = node[key];
    return own === undefined || own === null || own === "" ? inherited[key] : own;
  };
  const leafFills = get("fills");
  return {
    fontFamily: familyName(get("fontFamily"), get("fontId"), notes),
    fontWeight: Math.min(1000, Math.max(1, Math.round(num(get("fontWeight"), 400)))),
    fontStyle: get("fontStyle") === "italic" ? "italic" : "normal",
    fontSize: Math.min(4096, Math.max(0.5, num(get("fontSize"), 14))),
    letterSpacing: { unit: "px", value: num(get("letterSpacing"), 0) },
    textCase: CASE[String(get("textTransform"))] ?? "none",
    textDecoration:
      get("textDecoration") === "underline"
        ? "underline"
        : get("textDecoration") === "line-through"
          ? "strikethrough"
          : "none",
    fills: Array.isArray(leafFills)
      ? fills(leafFills, media, notes)
      : // Older files kept the colour on the node itself.
        fills(
          [{ fillColor: get("fillColor") ?? "#000000", fillOpacity: get("fillOpacity") ?? 1 }],
          media,
          notes,
        ),
  };
}

const keyOf = (s: Style) => JSON.stringify(STYLE_KEYS.map((k) => s[k]));

export interface TextProps {
  readonly props: Record<string, unknown>;
  /** The typography ids the text's leaves follow (a library text style), if they all agree. */
  readonly typography: string | null;
}

/** A Penpot text shape's content and grow type, as Drawpane text props (geometry aside). */
export function convertText(shape: Raw, media: MediaLookup, notes: Notes): TextProps {
  const root = (shape.content ?? {}) as Raw;
  const sets = Array.isArray(root.children) ? (root.children as Raw[]) : [];
  const paragraphs = sets.flatMap((set) =>
    Array.isArray(set.children) ? (set.children as Raw[]) : [],
  );
  let characters = "";
  const spans: Array<{ start: number; end: number; style: Style }> = [];
  const typographies = new Set<string | null>();
  const aligns = new Set<string>();
  const lineHeights = new Set<number>();
  const defaults: Raw = { fontSize: "14", fontWeight: "400", lineHeight: "1.2" };

  paragraphs.forEach((paragraph, i) => {
    if (i > 0) characters += "\n";
    const inherited: Raw = { ...defaults, ...stripEmpty(root), ...stripEmpty(paragraph) };
    aligns.add(String(paragraph.textAlign ?? root.textAlign ?? "left"));
    lineHeights.add(num(paragraph.lineHeight ?? root.lineHeight, 1.2));
    const leaves = Array.isArray(paragraph.children) ? (paragraph.children as Raw[]) : [];
    for (const leaf of leaves) {
      const text = typeof leaf.text === "string" ? leaf.text : "";
      const style = styleOf(leaf, inherited, media, notes);
      typographies.add(typeof leaf.typographyRefId === "string" ? leaf.typographyRefId : null);
      if (text)
        spans.push({ start: characters.length, end: characters.length + text.length, style });
      characters += text;
    }
    // An empty paragraph still has a style: count it, so an all-empty text keeps it.
    if (leaves.length > 0 && spans.length === 0 && i === paragraphs.length - 1)
      spans.push({ start: 0, end: 0, style: styleOf(leaves[0] as Raw, inherited, media, notes) });
  });

  // The style most of the characters have is the layer's own.
  const weight = new Map<string, { style: Style; count: number }>();
  for (const span of spans) {
    const key = keyOf(span.style);
    const entry = weight.get(key) ?? { style: span.style, count: 0 };
    entry.count += Math.max(1, span.end - span.start);
    weight.set(key, entry);
  }
  const base =
    [...weight.values()].sort((a, b) => b.count - a.count)[0]?.style ??
    styleOf({}, { ...defaults, fills: [{ fillColor: "#000000" }] }, media, notes);

  const runs: TextRun[] = [];
  for (const span of spans) {
    if (span.end <= span.start) continue;
    const own: Record<string, unknown> = {};
    for (const k of STYLE_KEYS)
      if (JSON.stringify(span.style[k]) !== JSON.stringify(base[k])) own[k] = span.style[k];
    if (Object.keys(own).length === 0) continue;
    const last = runs.at(-1);
    if (last && last.end === span.start && sameOverrides(last, own)) {
      (last as { end: number }).end = span.end;
      continue;
    }
    runs.push({ start: span.start, end: span.end, ...own } as TextRun);
  }

  if (aligns.size > 1 || lineHeights.size > 1) notes.add("text-mixed-paragraphs");
  const align = [...aligns][0] ?? "left";
  const lineHeight = [...lineHeights][0] ?? 1.2;
  const grow = shape.growType;
  const vertical = root.verticalAlign;
  const props: Record<string, unknown> = {
    characters: characters.slice(0, 200_000),
    fontFamily: base.fontFamily,
    fontWeight: base.fontWeight,
    fontStyle: base.fontStyle,
    fontSize: base.fontSize,
    letterSpacing: base.letterSpacing,
    textCase: base.textCase,
    textDecoration: base.textDecoration,
    fills: base.fills,
    lineHeight: { unit: "percent", value: Math.round(lineHeight * 10000) / 100 },
    textAlign: ["left", "center", "right", "justify"].includes(align) ? align : "left",
    textAlignVertical: vertical === "center" ? "middle" : vertical === "bottom" ? "bottom" : "top",
    textAutoResize: grow === "auto-width" ? "width" : grow === "auto-height" ? "height" : "none",
  };
  if (runs.length > 0) props.textRuns = runs.slice(0, 10_000);
  const typography = typographies.size === 1 ? ([...typographies][0] ?? null) : null;
  return { props, typography };
}

function stripEmpty(node: Raw): Raw {
  const out: Raw = {};
  for (const [k, v] of Object.entries(node))
    if (v !== null && v !== "" && k !== "children" && k !== "type" && k !== "key" && k !== "text")
      out[k] = v;
  return out;
}

function sameOverrides(run: TextRun, own: Record<string, unknown>): boolean {
  const keys = new Set([...Object.keys(run), ...Object.keys(own)]);
  keys.delete("start");
  keys.delete("end");
  for (const k of keys)
    if (JSON.stringify((run as Record<string, unknown>)[k]) !== JSON.stringify(own[k]))
      return false;
  return true;
}

/** A Penpot library typography as a Drawpane text style's props. */
export function typographyProps(t: Raw): Record<string, unknown> {
  const name = [t.path, t.name]
    .filter((s) => typeof s === "string" && s.trim() !== "")
    .map((s) => (s as string).trim())
    .join("/")
    .replace(/\s*\/\s*/g, "/");
  const props: Record<string, unknown> = {
    name: (name || "Text style").slice(0, 256),
    fontFamily: familyName(t.fontFamily, t.fontId),
    fontWeight: Math.min(1000, Math.max(1, Math.round(num(t.fontWeight, 400)))),
    fontSize: Math.min(4096, Math.max(0.5, num(t.fontSize, 14))),
    lineHeight: { unit: "percent", value: Math.round(num(t.lineHeight, 1.2) * 10000) / 100 },
    letterSpacing: { unit: "px", value: num(t.letterSpacing, 0) },
  };
  if (t.fontStyle === "italic") props.fontStyle = "italic";
  const textCase = CASE[String(t.textTransform)];
  if (textCase) props.textCase = textCase;
  return props;
}
