/**
 * SVG filters that are Drawpane effects: drop and inner shadows and layer
 * blurs. Read from `feDropShadow`, a lone `feGaussianBlur`, and the chains
 * Figma's "Copy as SVG" writes for its shadows (an offset, a blur, an
 * optional morphology for spread, an arithmetic composite for an inner
 * shadow, then a colour matrix holding the colour). Anything else in a
 * filter (lighting, turbulence, displacement) has no Drawpane equivalent,
 * so the filter is left out and the import says so.
 *
 * Blur radius is twice the Gaussian's deviation, as Drawpane and Figma
 * measure it (decision 0013).
 */
import type { Effect } from "@drawpane/model";
import { parseColor, withAlpha } from "./color";
import { opacityOf } from "./paint";
import { parseNumbers } from "./units";

/** Primitives the chains above are made of; any other means the filter can't be read. */
const KNOWN = new Set([
  "feFlood",
  "feColorMatrix",
  "feOffset",
  "feGaussianBlur",
  "feBlend",
  "feComposite",
  "feMorphology",
  "feDropShadow",
  "feMerge",
  "feMergeNode",
]);

const round2 = (n: number) => Math.round(n * 100) / 100;

interface Pending {
  x: number;
  y: number;
  blur: number;
  spread: number;
  inner: boolean;
}

/**
 * The effects a filter amounts to, scaled by `scale` (the element's
 * transform), or null when it holds something Drawpane can't draw.
 */
export function filterEffects(filter: Element, scale: number): Effect[] | null {
  const primitives = [...filter.children];
  if (primitives.length === 0) return null;
  if (primitives.some((p) => !KNOWN.has(p.localName))) return null;
  const effects: Effect[] = [];
  // In an object, so the checks below see what the cases set.
  const st: { pending: Pending | null; spread: number } = { pending: null, spread: 0 };
  const start = (): Pending => {
    st.pending ??= { x: 0, y: 0, blur: 0, spread: st.spread, inner: false };
    return st.pending;
  };
  const std = (p: Element) => {
    const n = parseNumbers(p.getAttribute("stdDeviation"));
    return n.length === 0 ? 0 : Math.max(...n);
  };
  for (const p of primitives) {
    const input = p.getAttribute("in");
    switch (p.localName) {
      case "feDropShadow": {
        const color = parseColor(p.getAttribute("flood-color") ?? "black") ?? {
          hex: "#000000",
          alpha: 1,
        };
        effects.push({
          type: "drop-shadow",
          color: withAlpha(
            color.hex,
            color.alpha * opacityOf(p.getAttribute("flood-opacity") ?? undefined),
          ),
          x: round2(Number.parseFloat(p.getAttribute("dx") ?? "2") * scale || 0),
          y: round2(Number.parseFloat(p.getAttribute("dy") ?? "2") * scale || 0),
          blur: round2(std(p) * 2 * scale),
          spread: 0,
        });
        break;
      }
      case "feMorphology": {
        const r = (parseNumbers(p.getAttribute("radius"))[0] ?? 0) * scale;
        st.spread = p.getAttribute("operator") === "dilate" ? r : -r;
        if (st.pending) st.pending.spread = st.spread;
        break;
      }
      case "feOffset": {
        const s = start();
        s.x = (Number.parseFloat(p.getAttribute("dx") ?? "0") || 0) * scale;
        s.y = (Number.parseFloat(p.getAttribute("dy") ?? "0") || 0) * scale;
        break;
      }
      case "feGaussianBlur": {
        const radius = std(p) * 2 * scale;
        if (st.pending) st.pending.blur = radius;
        else if (
          !input ||
          input === "SourceGraphic" ||
          input === "shape" ||
          primitives.length === 1
        ) {
          if (radius > 0) effects.push({ type: "layer-blur", radius: round2(radius) });
        }
        break;
      }
      case "feComposite": {
        if (
          st.pending &&
          p.getAttribute("operator") === "arithmetic" &&
          Number(p.getAttribute("k2")) === -1 &&
          Number(p.getAttribute("k3")) === 1
        )
          st.pending.inner = true;
        break;
      }
      case "feColorMatrix": {
        const s = st.pending;
        if (!s) break;
        const v = parseNumbers(p.getAttribute("values"));
        if (p.getAttribute("type") !== "matrix" && p.getAttribute("type") !== null) break;
        if (v.length !== 20) break;
        const hex = (n: number) =>
          Math.round(Math.min(1, Math.max(0, n)) * 255)
            .toString(16)
            .padStart(2, "0");
        effects.push({
          type: s.inner ? "inner-shadow" : "drop-shadow",
          color: withAlpha(`#${hex(v[4] ?? 0)}${hex(v[9] ?? 0)}${hex(v[14] ?? 0)}`, v[18] ?? 1),
          x: round2(s.x),
          y: round2(s.y),
          blur: round2(s.blur),
          spread: round2(s.spread),
        });
        st.pending = null;
        st.spread = 0;
        break;
      }
      default:
        break;
    }
  }
  return effects.length > 0 ? effects : null;
}
