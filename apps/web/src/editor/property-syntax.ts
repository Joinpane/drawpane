/**
 * The command bar's property syntax: `w 320`, `gap 16`, `fill #ff5a1f`,
 * `radius 8`, `opacity 50%`, `x 24*2`, `p 8 16`. Every number accepts math
 * (+ - * / and parentheses) and the units px, rem (16px) and %.
 */
import type { PropName } from "@drawpane/model";

export interface PropertyCommand {
  /** What the command bar shows: "Width", "Gap"… */
  readonly label: string;
  /** The operations to apply, as property/value pairs, per selected layer. */
  readonly sets: ReadonlyArray<{ readonly prop: PropName; readonly value: unknown }>;
  /** Human readable new value for the diff ("320", "#ff5a1f"). */
  readonly display: string;
}

const ALIASES: Record<string, { props: PropName[]; label: string; kind: "number" | "percent" | "color" | "text" | "enum"; values?: readonly string[] }> = {
  x: { props: ["x"], label: "X", kind: "number" },
  y: { props: ["y"], label: "Y", kind: "number" },
  w: { props: ["width"], label: "Width", kind: "number" },
  width: { props: ["width"], label: "Width", kind: "number" },
  h: { props: ["height"], label: "Height", kind: "number" },
  height: { props: ["height"], label: "Height", kind: "number" },
  r: { props: ["rotation"], label: "Rotation", kind: "number" },
  rotate: { props: ["rotation"], label: "Rotation", kind: "number" },
  rotation: { props: ["rotation"], label: "Rotation", kind: "number" },
  radius: { props: ["cornerRadius"], label: "Corner radius", kind: "number" },
  gap: { props: ["gap"], label: "Gap", kind: "number" },
  p: { props: ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"], label: "Padding", kind: "number" },
  padding: { props: ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"], label: "Padding", kind: "number" },
  px: { props: ["paddingLeft", "paddingRight"], label: "Horizontal padding", kind: "number" },
  py: { props: ["paddingTop", "paddingBottom"], label: "Vertical padding", kind: "number" },
  opacity: { props: ["opacity"], label: "Opacity", kind: "percent" },
  o: { props: ["opacity"], label: "Opacity", kind: "percent" },
  fill: { props: ["fills"], label: "Fill", kind: "color" },
  bg: { props: ["fills"], label: "Fill", kind: "color" },
  stroke: { props: ["strokes"], label: "Stroke", kind: "color" },
  border: { props: ["strokeWeight"], label: "Stroke weight", kind: "number" },
  size: { props: ["fontSize"], label: "Font size", kind: "number" },
  font: { props: ["fontFamily"], label: "Font", kind: "text" },
  weight: { props: ["fontWeight"], label: "Font weight", kind: "number" },
  name: { props: ["name"], label: "Name", kind: "text" },
  layout: { props: ["layoutMode"], label: "Auto layout", kind: "enum", values: ["none", "row", "column"] },
  align: { props: ["alignItems"], label: "Align items", kind: "enum", values: ["start", "center", "end", "stretch", "baseline"] },
  justify: { props: ["justifyContent"], label: "Justify content", kind: "enum", values: ["start", "center", "end", "space-between"] },
};

/** All keywords the syntax understands, for completion hints. */
export const PROPERTY_KEYWORDS = Object.keys(ALIASES);

/**
 * Evaluates arithmetic with units. Returns null for anything that isn't a
 * well-formed expression: no `eval`, just a small recursive-descent parser.
 */
export function evaluate(input: string, percentOf = 100): number | null {
  const src = input.replace(/\s+/g, "");
  let i = 0;
  const peek = () => src[i];
  function number(): number | null {
    const m = /^(\d+\.?\d*|\.\d+)(px|rem|%)?/.exec(src.slice(i));
    if (!m) return null;
    i += m[0].length;
    const n = Number(m[1]);
    if (m[2] === "rem") return n * 16;
    if (m[2] === "%") return (n / 100) * percentOf;
    return n;
  }
  function factor(): number | null {
    if (peek() === "-") {
      i++;
      const f = factor();
      return f === null ? null : -f;
    }
    if (peek() === "(") {
      i++;
      const v = expr();
      if (peek() !== ")") return null;
      i++;
      return v;
    }
    return number();
  }
  function term(): number | null {
    let v = factor();
    while (v !== null && (peek() === "*" || peek() === "/")) {
      const op = src[i++];
      const r = factor();
      if (r === null) return null;
      v = op === "*" ? v * r : r === 0 ? null : v / r;
    }
    return v;
  }
  function expr(): number | null {
    let v = term();
    while (v !== null && (peek() === "+" || peek() === "-")) {
      const op = src[i++];
      const r = term();
      if (r === null) return null;
      v = op === "+" ? v + r : v - r;
    }
    return v;
  }
  if (src === "") return null;
  const value = expr();
  return value !== null && i === src.length && Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
}

function normalizeColor(input: string): string | null {
  let c = input.trim().toLowerCase();
  if (!c.startsWith("#")) c = `#${c}`;
  if (/^#[0-9a-f]{3}$/.test(c)) c = `#${c[1]}${c[1]}${c[2]}${c[2]}${c[3]}${c[3]}`;
  if (/^#[0-9a-f]{6}([0-9a-f]{2})?$/.test(c)) return c;
  return null;
}

/** Parses a property command, or returns null when the text isn't one. */
export function parsePropertyCommand(text: string): PropertyCommand | null {
  const match = /^\s*([a-z]+)\s+(.+?)\s*$/i.exec(text);
  if (!match) return null;
  const keyword = (match[1] as string).toLowerCase();
  const rest = match[2] as string;
  const alias = ALIASES[keyword];
  if (!alias) return null;

  switch (alias.kind) {
    case "number": {
      // Padding accepts CSS shorthand: 1, 2 or 4 values.
      if (alias.props.length === 4) {
        const parts = rest.split(/\s+/).map((p) => evaluate(p));
        if (parts.some((p) => p === null || p < 0)) return null;
        const v = parts as number[];
        const [t, r, b, l] =
          v.length === 1 ? [v[0], v[0], v[0], v[0]] : v.length === 2 ? [v[0], v[1], v[0], v[1]] : v.length === 4 ? v : [];
        if (t === undefined || r === undefined || b === undefined || l === undefined) return null;
        return {
          label: alias.label,
          display: v.join(" "),
          sets: [
            { prop: "paddingTop", value: t },
            { prop: "paddingRight", value: r },
            { prop: "paddingBottom", value: b },
            { prop: "paddingLeft", value: l },
          ],
        };
      }
      const value = evaluate(rest);
      if (value === null) return null;
      return { label: alias.label, display: String(value), sets: alias.props.map((prop) => ({ prop, value })) };
    }
    case "percent": {
      const value = evaluate(rest.endsWith("%") ? rest : `${rest}%`, 1);
      if (value === null || value < 0 || value > 1) return null;
      return { label: alias.label, display: `${Math.round(value * 100)}%`, sets: alias.props.map((prop) => ({ prop, value })) };
    }
    case "color": {
      const color = normalizeColor(rest);
      if (!color) return null;
      return { label: alias.label, display: color, sets: alias.props.map((prop) => ({ prop, value: [{ type: "solid", color }] })) };
    }
    case "enum": {
      const value = rest.toLowerCase();
      if (!alias.values?.includes(value)) return null;
      return { label: alias.label, display: value, sets: alias.props.map((prop) => ({ prop, value })) };
    }
    case "text":
      return { label: alias.label, display: rest, sets: alias.props.map((prop) => ({ prop, value: rest })) };
  }
}
