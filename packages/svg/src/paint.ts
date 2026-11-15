/**
 * SVG paints as Drawpane's: colours (with `currentColor`), and linear and
 * radial gradients with their units, transforms and `href` templates.
 *
 * Drawpane lays a gradient out in its layer's unit square (decision 0013):
 * a linear one runs across its handles there, a radial one is a circle
 * there. An SVG gradient is placed in its own coordinate system, which ends
 * up somewhere in the frame through the element's transforms; `Q` below
 * takes that system into the layer's unit square. A linear gradient's value
 * is an affine function of position however it's placed, so it always
 * comes across exactly. A radial one does when `Q` keeps circles round,
 * which it does in the common cases (bounding-box units on an unrotated
 * shape, or user-space units on a square one); otherwise its circle is
 * averaged, and so is an off-centre focal point.
 */
import { apply, invert, type Matrix, multiply } from "@drawpane/import-kit";
import type { Paint } from "@drawpane/model";
import { parseColor, withAlpha } from "./color";
import type { Notes } from "./notes";
import { EMPTY_STYLE, type Style, type Styles } from "./style";
import { parseTransform } from "./transform";
import { parseLength, type Viewport } from "./units";

interface Stop {
  readonly position: number;
  readonly color: string;
}

/** Where a paint lands: what it needs to be laid out on its layer. */
export interface PaintPlacement {
  /** The element's user space onto the frame. */
  readonly ctm: Matrix;
  /** The element's geometry bounds in its user space (for bounding-box units). */
  readonly bbox: { x: number; y: number; width: number; height: number } | null;
  /** The layer's unit square onto the frame: its box's matrix times its size. */
  readonly unit: Matrix | null;
  /** The viewport percentages in user-space gradients refer to. */
  readonly viewport: Viewport;
}

const round4 = (n: number) => {
  const r = Math.round(n * 10_000) / 10_000;
  return Object.is(r, -0) ? 0 : r;
};
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/** An opacity property (`fill-opacity: 50%` or `0.5`), 1 when missing. */
export function opacityOf(value: string | undefined): number {
  if (value === undefined) return 1;
  const n = Number.parseFloat(value);
  if (!Number.isFinite(n)) return 1;
  return clamp01(value.trim().endsWith("%") ? n / 100 : n);
}

/** `currentColor` is the `color` property, black when that isn't set either. */
export function resolveColor(value: string, style: Style): { hex: string; alpha: number } | null {
  if (value.trim().toLowerCase() === "currentcolor") {
    const color = style.get("color");
    const parsed = color && color.toLowerCase() !== "currentcolor" ? parseColor(color) : null;
    return parsed ?? { hex: "#000000", alpha: 1 };
  }
  return parseColor(value);
}

export class PaintReader {
  readonly #ids: ReadonlyMap<string, Element>;
  readonly #styles: Styles;
  readonly #notes: Notes;

  constructor(ids: ReadonlyMap<string, Element>, styles: Styles, notes: Notes) {
    this.#ids = ids;
    this.#styles = styles;
    this.#notes = notes;
  }

  /**
   * A `fill` or `stroke` value as a paint, or null for none. `value` is the
   * computed property (black for a fill that isn't set), `opacity` its
   * `fill-opacity` or `stroke-opacity`.
   */
  read(value: string | undefined, opacity: number, style: Style, at: PaintPlacement): Paint | null {
    if (value === undefined) return null;
    const text = value.trim();
    if (text === "none" || text === "") return null;
    const url = /^url\(\s*['"]?#([^'")\s]+)['"]?\s*\)\s*(.*)$/i.exec(text);
    if (url) {
      const target = this.#ids.get(url[1] as string);
      const fallback = (url[2] as string).trim();
      const kind = target?.localName;
      if (kind === "linearGradient" || kind === "radialGradient") {
        const g = this.#gradient(target as Element, opacity, at);
        if (g !== undefined) return g;
      } else if (kind === "pattern") this.#notes.add("pattern");
      return fallback && fallback !== "none" ? this.read(fallback, opacity, style, at) : null;
    }
    const color = resolveColor(text, style);
    if (!color) return null;
    const alpha = color.alpha * opacity;
    if (alpha <= 0) return null;
    return {
      type: "solid",
      color: color.hex,
      ...(alpha < 0.999 ? { opacity: round4(alpha) } : {}),
    };
  }

  /** The gradient's templates, itself first, through `href`s to other gradients. */
  #chain(el: Element): Element[] {
    const chain: Element[] = [];
    let at: Element | undefined = el;
    while (at && !chain.includes(at) && chain.length < 16) {
      chain.push(at);
      const href: string | null =
        at.getAttribute("href") ?? at.getAttribute("xlink:href") ?? hrefNs(at);
      const id: string | null = href?.startsWith("#") ? href.slice(1) : null;
      const next: Element | undefined = id ? this.#ids.get(id) : undefined;
      at = next && /Gradient$/.test(next.localName) ? next : undefined;
    }
    return chain;
  }

  /**
   * A gradient paint, null to paint nothing (no stops, or a bounding box
   * with no size), or undefined when the element isn't usable so the fallback applies.
   */
  #gradient(el: Element, opacity: number, at: PaintPlacement): Paint | null | undefined {
    const chain = this.#chain(el);
    const attr = (name: string) => {
      for (const g of chain) {
        const v = g.getAttribute(name);
        if (v !== null) return v;
      }
      return null;
    };
    const stopsOwner = chain.find((g) => [...g.children].some((c) => c.localName === "stop"));
    const stops = stopsOwner ? this.#stops(stopsOwner) : [];
    if (stops.length === 0) return null;
    const last = stops.at(-1) as Stop;
    const solid = (): Paint => ({
      type: "solid",
      color: last.color.slice(0, 7),
      ...(opacity < 0.999 || last.color.length > 7
        ? {
            opacity: round4(
              opacity *
                (last.color.length > 7 ? Number.parseInt(last.color.slice(7), 16) / 255 : 1),
            ),
          }
        : {}),
    });
    if (stops.length === 1) return solid();
    if ((attr("spreadMethod") ?? "pad") !== "pad") this.#notes.add("gradient");

    const userSpace = attr("gradientUnits") === "userSpaceOnUse";
    let units: Matrix = [1, 0, 0, 1, 0, 0];
    if (!userSpace) {
      const b = at.bbox;
      if (!b || b.width <= 0 || b.height <= 0) return null;
      units = [b.width, 0, 0, b.height, b.x, b.y];
    }
    const vp = userSpace ? at.viewport : { width: 1, height: 1 };
    const len = (name: string, fallback: string, axis: "x" | "y" | "other") =>
      parseLength(attr(name) ?? fallback, axis, vp) ?? parseLength(fallback, axis, vp) ?? 0;
    const g = multiply(multiply(at.ctm, units), parseTransform(attr("gradientTransform")));
    if (!at.unit) return solid();
    const q = multiply(invert(at.unit), g);
    if (Math.abs(q[0] * q[3] - q[1] * q[2]) < 1e-12) return solid();
    const extra = opacity < 0.999 ? { opacity: round4(opacity) } : {};

    if (el.localName === "linearGradient") {
      const p1 = { x: len("x1", "0%", "x"), y: len("y1", "0%", "y") };
      const p2 = { x: len("x2", "100%", "x"), y: len("y2", "0%", "y") };
      const dx = p2.x - p1.x;
      const dy = p2.y - p1.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < 1e-12) return solid();
      // Where along the gradient a point of the unit square falls, as t = a·u + c.
      const qi = invert(q);
      const t = (u: { x: number; y: number }) => {
        const p = apply(qi, u);
        return ((p.x - p1.x) * dx + (p.y - p1.y) * dy) / d2;
      };
      const c = t({ x: 0, y: 0 });
      const ax = t({ x: 1, y: 0 }) - c;
      const ay = t({ x: 0, y: 1 }) - c;
      const a2 = ax * ax + ay * ay;
      if (a2 < 1e-12) return solid();
      const from = { x: (-c * ax) / a2, y: (-c * ay) / a2 };
      return {
        type: "linear",
        from: { x: round4(from.x), y: round4(from.y) },
        to: { x: round4(from.x + ax / a2), y: round4(from.y + ay / a2) },
        stops,
        ...extra,
      };
    }

    const cx = len("cx", "50%", "x");
    const cy = len("cy", "50%", "y");
    const r = len("r", "50%", "other");
    if (r <= 0) return solid();
    const fx = attr("fx") !== null ? len("fx", "50%", "x") : cx;
    const fy = attr("fy") !== null ? len("fy", "50%", "y") : cy;
    if (Math.hypot(fx - cx, fy - cy) > r * 0.02) this.#notes.add("gradient");
    const centre = apply(q, { x: cx, y: cy });
    const c1 = { x: q[0], y: q[1] };
    const c2 = { x: q[2], y: q[3] };
    const l1 = Math.hypot(c1.x, c1.y);
    const l2 = Math.hypot(c2.x, c2.y);
    const round =
      Math.abs(l1 - l2) <= 0.03 * Math.max(l1, l2) &&
      Math.abs(c1.x * c2.x + c1.y * c2.y) <= 0.03 * l1 * l2;
    let to: { x: number; y: number };
    if (round) to = { x: centre.x + c1.x * r, y: centre.y + c1.y * r };
    else {
      this.#notes.add("gradient");
      const k = Math.sqrt(Math.abs(q[0] * q[3] - q[1] * q[2])) * r;
      to = { x: centre.x + k, y: centre.y };
    }
    return {
      type: "radial",
      from: { x: round4(centre.x), y: round4(centre.y) },
      to: { x: round4(to.x), y: round4(to.y) },
      stops,
      ...extra,
    };
  }

  /** A gradient's stops, in order, at most 32, with their colour's and `stop-opacity`'s alpha. */
  #stops(gradient: Element): Stop[] {
    const out: Stop[] = [];
    let previous = 0;
    for (const stop of gradient.children) {
      if (stop.localName !== "stop") continue;
      const s = this.#styles.compute(stop, EMPTY_STYLE);
      const offsetText = stop.getAttribute("offset") ?? "0";
      let offset = Number.parseFloat(offsetText);
      if (!Number.isFinite(offset)) offset = 0;
      if (offsetText.trim().endsWith("%")) offset /= 100;
      // Offsets never go back: one smaller than the last is the last.
      offset = Math.max(previous, clamp01(offset));
      previous = offset;
      const color = resolveColor(s.get("stop-color") ?? "black", s) ?? { hex: "#000000", alpha: 1 };
      const alpha = color.alpha * opacityOf(s.get("stop-opacity"));
      out.push({ position: round4(offset), color: withAlpha(color.hex, alpha) });
    }
    if (out.length <= 32) return out;
    // Keep the ends; thin the middle.
    const step = (out.length - 1) / 31;
    return Array.from({ length: 32 }, (_, i) => out[Math.round(i * step)] as Stop);
  }
}

/** `href` in the XLink namespace, however it's prefixed. */
export function hrefNs(el: Element): string | null {
  return el.getAttributeNS("http://www.w3.org/1999/xlink", "href");
}
