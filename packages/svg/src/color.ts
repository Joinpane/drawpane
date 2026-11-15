/**
 * CSS colours as SVG files write them: `#rgb`, `#rgba`, `#rrggbb`,
 * `#rrggbbaa`, `rgb()`/`rgba()` and `hsl()`/`hsla()` in either the comma or
 * the space syntax, the 148 named colours and `transparent`. Read into a
 * lowercase `#rrggbb` and an alpha from 0 to 1, the parts Drawpane's paints
 * keep apart (the colour, and the paint's opacity).
 */

export interface Rgba {
  /** `#rrggbb`, lowercase. */
  readonly hex: string;
  /** 0 to 1. */
  readonly alpha: number;
}

/** The CSS named colours, packed as name:rrggbb pairs. */
const NAMED_PACKED =
  "aliceblue:f0f8ff antiquewhite:faebd7 aqua:00ffff aquamarine:7fffd4 azure:f0ffff beige:f5f5dc bisque:ffe4c4 black:000000 blanchedalmond:ffebcd blue:0000ff blueviolet:8a2be2 brown:a52a2a burlywood:deb887 cadetblue:5f9ea0 chartreuse:7fff00 chocolate:d2691e coral:ff7f50 cornflowerblue:6495ed cornsilk:fff8dc crimson:dc143c cyan:00ffff darkblue:00008b darkcyan:008b8b darkgoldenrod:b8860b darkgray:a9a9a9 darkgreen:006400 darkgrey:a9a9a9 darkkhaki:bdb76b darkmagenta:8b008b darkolivegreen:556b2f darkorange:ff8c00 darkorchid:9932cc darkred:8b0000 darksalmon:e9967a darkseagreen:8fbc8f darkslateblue:483d8b darkslategray:2f4f4f darkslategrey:2f4f4f darkturquoise:00ced1 darkviolet:9400d3 deeppink:ff1493 deepskyblue:00bfff dimgray:696969 dimgrey:696969 dodgerblue:1e90ff firebrick:b22222 floralwhite:fffaf0 forestgreen:228b22 fuchsia:ff00ff gainsboro:dcdcdc ghostwhite:f8f8ff gold:ffd700 goldenrod:daa520 gray:808080 green:008000 greenyellow:adff2f grey:808080 honeydew:f0fff0 hotpink:ff69b4 indianred:cd5c5c indigo:4b0082 ivory:fffff0 khaki:f0e68c lavender:e6e6fa lavenderblush:fff0f5 lawngreen:7cfc00 lemonchiffon:fffacd lightblue:add8e6 lightcoral:f08080 lightcyan:e0ffff lightgoldenrodyellow:fafad2 lightgray:d3d3d3 lightgreen:90ee90 lightgrey:d3d3d3 lightpink:ffb6c1 lightsalmon:ffa07a lightseagreen:20b2aa lightskyblue:87cefa lightslategray:778899 lightslategrey:778899 lightsteelblue:b0c4de lightyellow:ffffe0 lime:00ff00 limegreen:32cd32 linen:faf0e6 magenta:ff00ff maroon:800000 mediumaquamarine:66cdaa mediumblue:0000cd mediumorchid:ba55d3 mediumpurple:9370db mediumseagreen:3cb371 mediumslateblue:7b68ee mediumspringgreen:00fa9a mediumturquoise:48d1cc mediumvioletred:c71585 midnightblue:191970 mintcream:f5fffa mistyrose:ffe4e1 moccasin:ffe4b5 navajowhite:ffdead navy:000080 oldlace:fdf5e6 olive:808000 olivedrab:6b8e23 orange:ffa500 orangered:ff4500 orchid:da70d6 palegoldenrod:eee8aa palegreen:98fb98 paleturquoise:afeeee palevioletred:db7093 papayawhip:ffefd5 peachpuff:ffdab9 peru:cd853f pink:ffc0cb plum:dda0dd powderblue:b0e0e6 purple:800080 rebeccapurple:663399 red:ff0000 rosybrown:bc8f8f royalblue:4169e1 saddlebrown:8b4513 salmon:fa8072 sandybrown:f4a460 seagreen:2e8b57 seashell:fff5ee sienna:a0522d silver:c0c0c0 skyblue:87ceeb slateblue:6a5acd slategray:708090 slategrey:708090 snow:fffafa springgreen:00ff7f steelblue:4682b4 tan:d2b48c teal:008080 thistle:d8bfd8 tomato:ff6347 turquoise:40e0d0 violet:ee82ee wheat:f5deb3 white:ffffff whitesmoke:f5f5f5 yellow:ffff00 yellowgreen:9acd32";

const NAMED: ReadonlyMap<string, string> = new Map(
  NAMED_PACKED.split(" ").map((pair) => {
    const [name, hex] = pair.split(":") as [string, string];
    return [name, `#${hex}`];
  }),
);

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const hex2 = (n: number) =>
  Math.round(Math.min(255, Math.max(0, n)))
    .toString(16)
    .padStart(2, "0");

/** A channel: a number (0–255) or a percentage. */
function channel(text: string): number | null {
  const t = text.trim();
  if (t.endsWith("%")) {
    const n = Number.parseFloat(t);
    return Number.isFinite(n) ? (n / 100) * 255 : null;
  }
  const n = Number.parseFloat(t);
  return Number.isFinite(n) ? n : null;
}

/** An alpha: a number (0–1) or a percentage. */
function alphaOf(text: string | undefined): number | null {
  if (text === undefined) return 1;
  const t = text.trim();
  const n = Number.parseFloat(t);
  if (!Number.isFinite(n)) return null;
  return clamp01(t.endsWith("%") ? n / 100 : n);
}

/** An angle in degrees: plain, deg, rad, grad or turn. */
function hue(text: string): number | null {
  const t = text.trim().toLowerCase();
  const n = Number.parseFloat(t);
  if (!Number.isFinite(n)) return null;
  if (t.endsWith("rad")) return (n * 180) / Math.PI;
  if (t.endsWith("grad")) return n * 0.9;
  if (t.endsWith("turn")) return n * 360;
  return n;
}

/** The arguments of a colour function, comma or space separated, with an optional "/ alpha". */
function args(inner: string): string[] {
  if (inner.includes(",")) return inner.split(",").map((s) => s.trim());
  const [main = "", alpha] = inner.split("/");
  const parts = main.trim().split(/\s+/);
  return alpha === undefined ? parts : [...parts, alpha.trim()];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const hh = (((h % 360) + 360) % 360) / 360;
  const f = (n: number) => {
    const k = (n + hh * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

/** A CSS colour, or null when it isn't one (including `currentColor`, which callers resolve). */
export function parseColor(input: string): Rgba | null {
  const text = input.trim().toLowerCase();
  if (text === "transparent") return { hex: "#000000", alpha: 0 };
  const named = NAMED.get(text);
  if (named) return { hex: named, alpha: 1 };
  if (text.startsWith("#")) {
    const h = text.slice(1);
    if (!/^[0-9a-f]+$/.test(h)) return null;
    if (h.length === 3 || h.length === 4) {
      const [r, g, b, a] = [...h].map((c) => c + c);
      return {
        hex: `#${r}${g}${b}`,
        alpha: a ? Number.parseInt(a, 16) / 255 : 1,
      };
    }
    if (h.length === 6 || h.length === 8)
      return {
        hex: `#${h.slice(0, 6)}`,
        alpha: h.length === 8 ? Number.parseInt(h.slice(6), 16) / 255 : 1,
      };
    return null;
  }
  const fn = /^(rgba?|hsla?)\((.*)\)$/.exec(text);
  if (!fn) return null;
  const parts = args(fn[2] as string);
  if (parts.length < 3) return null;
  const alpha = alphaOf(parts[3]);
  if (alpha === null) return null;
  if ((fn[1] as string).startsWith("rgb")) {
    const [r, g, b] = parts.slice(0, 3).map(channel);
    if (r == null || g == null || b == null) return null;
    return { hex: `#${hex2(r)}${hex2(g)}${hex2(b)}`, alpha };
  }
  const h = hue(parts[0] as string);
  const s = Number.parseFloat(parts[1] as string);
  const l = Number.parseFloat(parts[2] as string);
  if (h === null || !Number.isFinite(s) || !Number.isFinite(l)) return null;
  const [r, g, b] = hslToRgb(h, clamp01(s / 100), clamp01(l / 100));
  return { hex: `#${hex2(r)}${hex2(g)}${hex2(b)}`, alpha };
}

/** `#rrggbb`, or `#rrggbbaa` when not opaque: Drawpane's colour form. */
export function withAlpha(hex: string, alpha: number): string {
  const a = clamp01(alpha);
  return a >= 0.999 ? hex : `${hex}${hex2(a * 255)}`;
}
