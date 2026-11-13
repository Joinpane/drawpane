// Color math for pickers: hex in and out (the document stores lowercase
// `#rrggbb` or `#rrggbbaa`), HSV for the picker's area and hue strip, HSL and
// RGB for typing, and WCAG contrast. Pure functions, no DOM.

/** Channels 0–255 (fractional while editing), alpha 0–1. */
export interface Rgba {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

/** Hue 0–360, saturation and value 0–1, alpha 0–1. */
export interface Hsva {
  readonly h: number;
  readonly s: number;
  readonly v: number;
  readonly a: number;
}

/** Hue 0–360, saturation and lightness 0–1. */
export interface Hsl {
  readonly h: number;
  readonly s: number;
  readonly l: number;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const byte = (n: number) => clamp(Math.round(n), 0, 255);
const hex2 = (n: number) => byte(n).toString(16).padStart(2, "0");

/** Parses `#rgb`, `#rgba`, `#rrggbb` or `#rrggbbaa`, with or without `#`. */
export function parseHex(text: string): Rgba | null {
  let h = text.trim().replace(/^#/, "").toLowerCase();
  if (!/^[0-9a-f]+$/.test(h)) return null;
  if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join("");
  if (h.length !== 6 && h.length !== 8) return null;
  const n = (i: number) => Number.parseInt(h.slice(i, i + 2), 16);
  return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 };
}

/** Lowercase `#rrggbb`, plus `aa` when the color isn't opaque (the document's format). */
export function toHex(c: Rgba): string {
  const alpha = byte(c.a * 255);
  return `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}${alpha === 255 ? "" : hex2(alpha)}`;
}

/** `RRGGBB` for display, without `#` or alpha. */
export function hexDigits(c: Rgba): string {
  return `${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`.toUpperCase();
}

export function rgbToHsv({ r, g, b, a }: Rgba): Hsva {
  const R = r / 255;
  const G = g / 255;
  const B = b / 255;
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === R) h = ((G - B) / d) % 6;
    else if (max === G) h = (B - R) / d + 2;
    else h = (R - G) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max, a };
}

export function hsvToRgb({ h, s, v, a }: Hsva): Rgba {
  const hh = (((h % 360) + 360) % 360) / 60;
  const c = v * s;
  const x = c * (1 - Math.abs((hh % 2) - 1));
  const m = v - c;
  const [r, g, b] =
    hh < 1
      ? [c, x, 0]
      : hh < 2
        ? [x, c, 0]
        : hh < 3
          ? [0, c, x]
          : hh < 4
            ? [0, x, c]
            : hh < 5
              ? [x, 0, c]
              : [c, 0, x];
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255, a };
}

export function rgbToHsl({ r, g, b }: Rgba): Hsl {
  const { h, s: sv, v } = rgbToHsv({ r, g, b, a: 1 });
  const l = v * (1 - sv / 2);
  const s = l === 0 || l === 1 ? 0 : (v - l) / Math.min(l, 1 - l);
  return { h, s, l };
}

export function hslToRgb({ h, s, l }: Hsl, a = 1): Rgba {
  const v = l + s * Math.min(l, 1 - l);
  return hsvToRgb({ h, s: v === 0 ? 0 : 2 * (1 - l / v), v, a });
}

/**
 * Reads what people type or paste as a color: hex in any common length,
 * `rgb()`/`rgba()`, `hsl()`/`hsla()`, or a bare `r, g, b`. Returns null
 * for anything else.
 */
export function parseColor(text: string): Rgba | null {
  const t = text.trim().toLowerCase();
  const hex = parseHex(t);
  if (hex) return hex;
  const fn = t.match(/^(rgba?|hsla?)?\s*\(?\s*([^)]*?)\s*\)?$/);
  if (!fn) return null;
  const parts = (fn[2] ?? "").split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 3 || parts.length > 4) return null;
  const num = (p: string, scale: number) => {
    const n = Number.parseFloat(p);
    if (!Number.isFinite(n)) return Number.NaN;
    return p.endsWith("%") ? (n / 100) * scale : n;
  };
  const alpha = parts[3] === undefined ? 1 : clamp(num(parts[3], 1), 0, 1);
  if (fn[1]?.startsWith("hsl")) {
    const h = Number.parseFloat(parts[0] as string);
    const s = num(parts[1] as string, 1);
    const l = num(parts[2] as string, 1);
    if (![h, s, l, alpha].every(Number.isFinite)) return null;
    // Bare percentages read as 0–1; numbers above 1 read as percent.
    const unit = (n: number) => clamp(n > 1 ? n / 100 : n, 0, 1);
    return hslToRgb({ h, s: unit(s), l: unit(l) }, alpha);
  }
  const [r, g, b] = parts.slice(0, 3).map((p) => num(p, 255)) as [number, number, number];
  if (![r, g, b, alpha].every(Number.isFinite)) return null;
  return { r: clamp(r, 0, 255), g: clamp(g, 0, 255), b: clamp(b, 0, 255), a: alpha };
}

/** `rgba(…)` for CSS, keeping fractional channels. */
export function cssColor(c: Rgba): string {
  return `rgba(${byte(c.r)}, ${byte(c.g)}, ${byte(c.b)}, ${Math.round(c.a * 1000) / 1000})`;
}

/** Paints `top` over an opaque `bottom` (source-over). */
export function composite(top: Rgba, bottom: Rgba): Rgba {
  const a = clamp(top.a, 0, 1);
  return {
    r: top.r * a + bottom.r * (1 - a),
    g: top.g * a + bottom.g * (1 - a),
    b: top.b * a + bottom.b * (1 - a),
    a: 1,
  };
}

/** WCAG 2 relative luminance of an opaque color. */
export function luminance({ r, g, b }: Rgba): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG 2 contrast ratio, 1–21, of `fg` (composited over `bg`) against `bg`. */
export function contrastRatio(fg: Rgba, bg: Rgba): number {
  const solidBg = bg.a < 1 ? composite(bg, { r: 255, g: 255, b: 255, a: 1 }) : bg;
  const solidFg = composite(fg, solidBg);
  const a = luminance(solidFg);
  const b = luminance(solidBg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

export type ContrastLevel = "AAA" | "AA" | "AA large" | "Fail";

/**
 * The WCAG level a ratio meets. Large text (18pt, or 14pt bold) and non-text
 * graphics need 3:1 for AA; body text needs 4.5:1 for AA and 7:1 for AAA.
 */
export function contrastLevel(ratio: number, large = false): ContrastLevel {
  if (large) return ratio >= 4.5 ? "AAA" : ratio >= 3 ? "AA" : "Fail";
  return ratio >= 7 ? "AAA" : ratio >= 4.5 ? "AA" : ratio >= 3 ? "AA large" : "Fail";
}
