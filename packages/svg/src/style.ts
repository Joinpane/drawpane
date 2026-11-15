/**
 * Each element's computed style, as a browser would cascade it for the
 * properties a conversion reads: presentation attributes (`fill="red"`),
 * then `<style>` rules by specificity and order (Illustrator and Figma
 * exports use classes), then the `style` attribute, with `!important`
 * above all; inherited properties come down from the parent, and `inherit`
 * asks for it outright. Selectors are matched with `element.matches`, so
 * anything the DOM understands works; at-rules (`@media`, `@font-face`,
 * `@import`) are skipped, so nothing is fetched.
 */

/** Properties that pass from parent to child when a child doesn't set them. */
const INHERITED = new Set([
  "fill",
  "fill-opacity",
  "fill-rule",
  "stroke",
  "stroke-width",
  "stroke-opacity",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "stroke-dasharray",
  "stroke-dashoffset",
  "color",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "letter-spacing",
  "text-anchor",
  "text-decoration",
  "visibility",
  "clip-rule",
  "paint-order",
  "marker-start",
  "marker-mid",
  "marker-end",
]);

/** Everything the conversion reads; other properties are ignored. */
const KNOWN = new Set([
  ...INHERITED,
  "opacity",
  "display",
  "clip-path",
  "mask",
  "mask-type",
  "filter",
  "mix-blend-mode",
  "stop-color",
  "stop-opacity",
  "transform",
  "vector-effect",
  "marker",
]);

export type Style = ReadonlyMap<string, string>;

export const EMPTY_STYLE: Style = new Map();

interface Rule {
  readonly selector: string;
  readonly specificity: number;
  readonly order: number;
  readonly declarations: ReadonlyMap<string, { value: string; important: boolean }>;
}

/** `fill: red; stroke-width: 2px !important` as declarations, names lowercase. */
export function parseDeclarations(
  text: string,
): Map<string, { value: string; important: boolean }> {
  const out = new Map<string, { value: string; important: boolean }>();
  for (const part of text.split(";")) {
    const colon = part.indexOf(":");
    if (colon < 0) continue;
    const name = part.slice(0, colon).trim().toLowerCase();
    let value = part.slice(colon + 1).trim();
    const important = /!\s*important\s*$/i.test(value);
    if (important) value = value.replace(/!\s*important\s*$/i, "").trim();
    if (!name || !value) continue;
    if (name === "marker") {
      // The shorthand sets all three.
      for (const m of ["marker-start", "marker-mid", "marker-end"])
        out.set(m, { value, important });
      continue;
    }
    if (KNOWN.has(name)) out.set(name, { value, important });
  }
  return out;
}

/** CSS specificity as one number: ids, then classes, attributes and pseudo-classes, then types. */
export function specificity(selector: string): number {
  const s = selector.replace(/"[^"]*"|'[^']*'/g, "");
  const ids = (s.match(/#[\w-]+/g) ?? []).length;
  const classes = (s.match(/\.[\w-]+|\[[^\]]*\]|:(?!:)[\w-]+/g) ?? []).length;
  const types = (
    s
      .replace(/#[\w-]+|\.[\w-]+|\[[^\]]*\]|::?[\w-]+(\([^)]*\))?/g, " ")
      .match(/(^|[\s>+~])[a-zA-Z][\w-]*/g) ?? []
  ).length;
  return ids * 10_000 + classes * 100 + types;
}

/** The rules in a style sheet's text; at-rules and their blocks are skipped. */
export function parseStyleSheet(css: string, startOrder = 0): Rule[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/<!--|-->/g, "");
  const rules: Rule[] = [];
  let i = 0;
  let order = startOrder;
  while (i < text.length) {
    const open = text.indexOf("{", i);
    if (open < 0) break;
    const prelude = text.slice(i, open).trim();
    // The block's end, minding nested blocks (an @media's rules).
    let depth = 1;
    let j = open + 1;
    while (j < text.length && depth > 0) {
      if (text[j] === "{") depth++;
      else if (text[j] === "}") depth--;
      j++;
    }
    const body = text.slice(open + 1, j - 1);
    i = j;
    // Statements like `@import url(x);` end with a semicolon, before any block.
    const statementEnd = prelude.lastIndexOf(";");
    const selectorText = statementEnd >= 0 ? prelude.slice(statementEnd + 1).trim() : prelude;
    if (!selectorText || selectorText.startsWith("@")) continue;
    const declarations = parseDeclarations(body);
    if (declarations.size === 0) continue;
    for (const selector of selectorText.split(",").map((s) => s.trim())) {
      if (!selector) continue;
      rules.push({ selector, specificity: specificity(selector), order: order++, declarations });
    }
  }
  return rules;
}

/** Computes styles for one document's elements, caching nothing between documents. */
export class Styles {
  readonly #rules: Rule[];

  constructor(root: Element) {
    const rules: Rule[] = [];
    for (const el of root.getElementsByTagName("*")) {
      if (el.localName !== "style") continue;
      const type = el.getAttribute("type");
      if (type && type !== "text/css") continue;
      rules.push(...parseStyleSheet(el.textContent ?? "", rules.length));
    }
    rules.sort((a, b) => a.specificity - b.specificity || a.order - b.order);
    this.#rules = rules;
  }

  /** What the element itself declares, cascaded, before inheritance. */
  specified(el: Element): Map<string, string> {
    const normal = new Map<string, string>();
    const important = new Map<string, string>();
    for (const attr of el.attributes) {
      const name = attr.localName.toLowerCase();
      if (name === "transform" || name === "style") continue;
      if (KNOWN.has(name)) normal.set(name, attr.value.trim());
      else if (name === "marker")
        for (const m of ["marker-start", "marker-mid", "marker-end"])
          normal.set(m, attr.value.trim());
    }
    for (const rule of this.#rules) {
      let matches = false;
      try {
        matches = el.matches(rule.selector);
      } catch {
        // A selector the DOM can't parse (a pseudo-element, a typo): it matches nothing.
      }
      if (!matches) continue;
      for (const [name, d] of rule.declarations)
        (d.important ? important : normal).set(name, d.value);
    }
    const inline = el.getAttribute("style");
    if (inline)
      for (const [name, d] of parseDeclarations(inline)) {
        if (d.important) important.set(name, d.value);
        else if (!important.has(name)) normal.set(name, d.value);
      }
    for (const [name, value] of important) normal.set(name, value);
    return normal;
  }

  /** The element's computed style: its own declarations over what it inherits from `parent`. */
  compute(el: Element, parent: Style): Style {
    const own = this.specified(el);
    const out = new Map<string, string>();
    for (const [name, value] of parent) if (INHERITED.has(name)) out.set(name, value);
    for (const [name, value] of own) {
      if (value === "inherit") {
        const inherited = parent.get(name);
        if (inherited !== undefined) out.set(name, inherited);
        else out.delete(name);
      } else if (value === "initial" || value === "unset") out.delete(name);
      else out.set(name, value);
    }
    return out;
  }
}
