/**
 * Styles no layer of the pages read uses, from their records (decision
 * 0034). Open Pencil builds the records a page needs, so a style nothing
 * uses isn't in any pass's graph; Figma still lists it, and so does the
 * import. Its definition is read from the record as REST's nodes endpoint
 * would give it: paints, effects (with what they're bound to) or text.
 */
import type { Figma } from "@drawpane/figma";
import { parseFontStyle } from "@drawpane/model";
import { gradientHandles, type Matrix } from "./geometry";
import type { RawRecord } from "./raw";
import type { AliasOf } from "./tokens";

type Raw = Record<string, unknown>;
type Color = { r: number; g: number; b: number; a?: number };

const rgba = (c: Color | undefined): Figma.RGBA => ({
  r: c?.r ?? 0,
  g: c?.g ?? 0,
  b: c?.b ?? 0,
  a: c?.a ?? 1,
});

const STYLE_TYPES = new Set(["FILL", "EFFECT", "TEXT", "GRID"]);

function paint(p: Raw, aliasOf: AliasOf): Figma.Paint | null {
  const common = {
    ...(p.visible === false ? { visible: false } : {}),
    ...(typeof p.opacity === "number" && p.opacity !== 1 ? { opacity: p.opacity } : {}),
    ...(typeof p.blendMode === "string" && p.blendMode !== "NORMAL"
      ? { blendMode: p.blendMode }
      : {}),
  };
  const type = p.type as string;
  if (type === "SOLID") {
    const color = aliasOf(p.colorVar);
    return {
      type: "SOLID",
      color: rgba(p.color as Color),
      ...common,
      ...(color ? { boundVariables: { color } } : {}),
    };
  }
  if (type.startsWith("GRADIENT_")) {
    const handles = gradientHandles(type, p.transform as Matrix | undefined);
    const stops = (p.stops as Array<{ color: Color; position: number }> | undefined) ?? [];
    const vars = (p.stopsVar as Array<{ colorVar?: unknown }> | undefined) ?? [];
    if (!handles || stops.length < 2) return null;
    return {
      type: type as Figma.Paint["type"],
      gradientHandlePositions: handles,
      gradientStops: stops.map((s, i) => {
        const color = aliasOf(vars[i]?.colorVar);
        return {
          position: s.position,
          color: rgba(s.color),
          ...(color ? { boundVariables: { color } } : {}),
        };
      }),
      ...common,
    };
  }
  return null;
}

const SHADOW_VARS = {
  xVar: "offsetX",
  yVar: "offsetY",
  radiusVar: "radius",
  spreadVar: "spread",
  colorVar: "color",
} as const;

function effect(e: Raw, aliasOf: AliasOf): Figma.Effect | null {
  const type = e.type as string;
  const visible = e.visible === false ? { visible: false } : {};
  const bound = (fields: Readonly<Record<string, string>>) => {
    const out: Record<string, Figma.VariableAlias> = {};
    for (const [field, rest] of Object.entries(fields)) {
      const alias = aliasOf(e[field]);
      if (alias) out[rest] = alias;
    }
    return Object.keys(out).length > 0 ? { boundVariables: out } : {};
  };
  if (type === "DROP_SHADOW" || type === "INNER_SHADOW") {
    const offset = (e.offset as { x: number; y: number } | undefined) ?? { x: 0, y: 0 };
    return {
      type,
      color: rgba(e.color as Color),
      offset: { x: offset.x, y: offset.y },
      radius: (e.radius as number | undefined) ?? 0,
      spread: (e.spread as number | undefined) ?? 0,
      ...(typeof e.showShadowBehindNode === "boolean"
        ? { showShadowBehindNode: e.showShadowBehindNode }
        : {}),
      ...visible,
      ...bound(SHADOW_VARS),
    };
  }
  if (type === "FOREGROUND_BLUR" || type === "BACKGROUND_BLUR" || type === "LAYER_BLUR")
    return {
      type: type === "BACKGROUND_BLUR" ? "BACKGROUND_BLUR" : "LAYER_BLUR",
      radius: (e.radius as number | undefined) ?? 0,
      ...visible,
      ...bound({ radiusVar: "radius" }),
    };
  return null;
}

function typeStyle(r: Raw): Figma.TypeStyle {
  const font = (r.fontName as { family?: string; style?: string } | undefined) ?? {};
  const size = (r.fontSize as number | undefined) ?? 12;
  const style = parseFontStyle(font.style ?? "Regular");
  const lh = r.lineHeight as { value?: number; units?: string } | undefined;
  const ls = r.letterSpacing as { value?: number; units?: string } | undefined;
  const out: Record<string, unknown> = {
    ...(font.family ? { fontFamily: font.family } : {}),
    ...(font.style ? { fontStyle: font.style } : {}),
    fontWeight: style.weight,
    italic: style.italic,
    fontSize: size,
  };
  if (lh?.value !== undefined) {
    if (lh.units === "PIXELS")
      Object.assign(out, { lineHeightUnit: "PIXELS", lineHeightPx: lh.value });
    else if (lh.units === "PERCENT")
      Object.assign(out, { lineHeightUnit: "FONT_SIZE_%", lineHeightPercentFontSize: lh.value });
    else if (lh.units === "RAW")
      Object.assign(out, {
        lineHeightUnit: "FONT_SIZE_%",
        lineHeightPercentFontSize: lh.value * 100,
      });
  }
  if (ls?.value !== undefined)
    out.letterSpacing = ls.units === "PERCENT" ? (ls.value / 100) * size : ls.value;
  if (typeof r.textCase === "string") out.textCase = r.textCase;
  if (typeof r.textDecoration === "string") out.textDecoration = r.textDecoration;
  if (typeof r.paragraphSpacing === "number") out.paragraphSpacing = r.paragraphSpacing;
  return out as Figma.TypeStyle;
}

/** A style's definition read from its record, in REST's shape; null for a record that isn't a live style. */
export function styleFromRecord(
  id: string,
  record: RawRecord,
  aliasOf: AliasOf,
): {
  meta: { name: string; styleType: string; description?: string; hiddenFromPublishing?: boolean };
  node: Figma.Node;
} | null {
  const r = record as unknown as Raw;
  const styleType = r.styleType as string | undefined;
  if (!styleType || !STYLE_TYPES.has(styleType) || r.isSoftDeleted) return null;
  const name = (r.name as string | undefined) ?? "Style";
  const node: Record<string, unknown> = {
    id,
    name,
    type: styleType === "TEXT" ? "TEXT" : "RECTANGLE",
  };
  if (styleType === "FILL")
    node.fills = ((r.fillPaints as Raw[] | undefined) ?? [])
      .map((p) => paint(p, aliasOf))
      .filter((p) => p !== null);
  if (styleType === "EFFECT")
    node.effects = ((r.effects as Raw[] | undefined) ?? [])
      .map((e) => effect(e, aliasOf))
      .filter((e) => e !== null);
  if (styleType === "TEXT") node.style = typeStyle(r);
  return {
    meta: {
      name,
      styleType,
      ...(typeof r.description === "string" && r.description ? { description: r.description } : {}),
      ...(r.isPublishable === false ? { hiddenFromPublishing: true } : {}),
    },
    node: node as unknown as Figma.Node,
  };
}
