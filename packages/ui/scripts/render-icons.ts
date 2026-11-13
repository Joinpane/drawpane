import { type Data, emit, GENERATED_NOTE } from "./codegen.ts";

/** The SVG files are drawn in Paper ink for docs; in code every ink becomes currentColor. */
const FILE_INK = "#1c1b19";

/** Attributes every icon file must set on its root, which the `dp-icon` class supplies in CSS. */
const ROOT_ATTRIBUTES: Record<string, string> = {
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: FILE_INK,
  "stroke-width": "1.5",
  "stroke-linecap": "round",
  "stroke-linejoin": "round",
};

const ELEMENTS = new Set(["path", "rect", "circle", "ellipse", "line", "polyline", "polygon"]);

const REACT_ATTRIBUTE: Record<string, string> = {
  "stroke-dasharray": "strokeDasharray",
  "stroke-width": "strokeWidth",
  "stroke-linecap": "strokeLinecap",
  "stroke-linejoin": "strokeLinejoin",
  "fill-rule": "fillRule",
  "clip-rule": "clipRule",
};

export interface IconFile {
  /** File name without `.svg`. */
  name: string;
  source: string;
}

function attributes(raw: string): Record<string, string> {
  return Object.fromEntries(Array.from(raw.matchAll(/([\w:-]+)="([^"]*)"/g), (m) => [m[1], m[2]]));
}

export function parseIcon(file: IconFile): Data {
  const root = /<svg\b([^>]*)>([\s\S]*)<\/svg>/.exec(file.source);
  if (!root) throw new Error(`${file.name}.svg: no <svg> root`);
  const rootAttrs = attributes(root[1] ?? "");
  for (const [key, expected] of Object.entries(ROOT_ATTRIBUTES)) {
    if (rootAttrs[key] !== expected) {
      throw new Error(`${file.name}.svg: expected ${key}="${expected}" on <svg>`);
    }
  }
  const nodes = Array.from((root[2] ?? "").matchAll(/<(\w+)\b([^>]*?)\/?>/g), (m) => {
    const tag = m[1] ?? "";
    if (!ELEMENTS.has(tag)) throw new Error(`${file.name}.svg: unsupported <${tag}>`);
    const attrs = Object.fromEntries(
      Object.entries(attributes(m[2] ?? "")).map(([key, value]) => [
        REACT_ATTRIBUTE[key] ?? key,
        value === FILE_INK ? "currentColor" : value,
      ]),
    );
    return [tag, attrs];
  });
  if (nodes.length === 0) throw new Error(`${file.name}.svg: no shapes`);
  return nodes;
}

/**
 * `order` is the set's canonical order (design-system.json lists it, grouped by use: tools,
 * layers, layout, collaboration, agents). Icons missing from it follow alphabetically.
 */
export function renderIconsTs(files: IconFile[], order: readonly string[] = []): string {
  const rank = (name: string) => {
    const i = order.indexOf(name);
    return i === -1 ? order.length : i;
  };
  const sorted = [...files].sort(
    (a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name),
  );
  const data = Object.fromEntries(sorted.map((f) => [f.name, parseIcon(f)]));
  return `// ${GENERATED_NOTE} Source: design-system/assets/Icons/*.svg.

/** One shape of an icon: an SVG element name and its React attributes. */
export type IconNode = readonly [tag: string, attributes: Readonly<Record<string, string>>];

/** Drawpane's ${sorted.length} icons on a 16px grid; strokes and fills inherit currentColor. */
export const iconData = ${emit(data)} as const satisfies Record<string, readonly IconNode[]>;

export type IconName = keyof typeof iconData;

/** Every icon name, in the design system's order. */
export const iconNames = Object.keys(iconData) as IconName[];
`;
}
