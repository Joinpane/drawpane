/**
 * The JSX dialect agents design in (decision 0021): `render` builds layers
 * from it and `get_jsx` writes layers back in it, so an agent can read a
 * layer, change it and render it back over itself.
 *
 * It's parsed, never run. An element is a layer type, its attributes are
 * model properties (or a few short forms agents reach for), and text inside
 * an element is its text:
 *
 *   <Frame name="Card" flex="col" gap={12} p={16} fill="#ffffff" radius={12} w={320} h="hug">
 *     <Text size={20} weight={600}>Plan your week</Text>
 *     <Rect w="fill" h={1} fill="#e6e4df" />
 *   </Frame>
 *
 * Values are strings, or JSON in braces (numbers, booleans, null, arrays and
 * objects, such as a list of paints). Every property is checked against the
 * model's own schema, so a bad value fails the call with a message that says
 * which attribute and why, before anything is changed.
 */
import {
  getProp,
  LAYER_TYPES,
  type LayerType,
  type NodeRecord,
  PROP_NAMES,
  PROPS,
  type PropName,
  type Props,
  propAllowed,
} from "@drawpane/model";
import type { Doc } from "../doc";
import type { LayerTree } from "../editor";

/** A problem with what an agent wrote, said so it can fix it. */
export class JsxError extends Error {
  override readonly name = "JsxError";
}

// ---------------------------------------------------------------------------
// Parsing

/** An element as written: its tag, attributes (raw values) and children. */
export interface JsxElement {
  readonly tag: string;
  readonly attrs: ReadonlyArray<{ readonly name: string; readonly value: unknown }>;
  readonly children: ReadonlyArray<JsxElement | string>;
}

/** The elements at the top of `source` (one or more, side by side). */
export function parseJsx(source: string): JsxElement[] {
  const p = new Parser(source);
  const out: JsxElement[] = [];
  p.space();
  while (!p.done()) {
    out.push(p.element());
    p.space();
  }
  if (out.length === 0) throw new JsxError("There's no element to render: start with <Frame>.");
  return out;
}

class Parser {
  #i = 0;
  constructor(readonly s: string) {}

  done(): boolean {
    return this.#i >= this.s.length;
  }

  space(): void {
    for (;;) {
      while (this.#i < this.s.length && /\s/.test(this.s[this.#i] as string)) this.#i++;
      // {/* comments */} between elements.
      if (this.s.startsWith("{/*", this.#i)) {
        const end = this.s.indexOf("*/}", this.#i);
        if (end === -1) this.fail("A {/* comment */} isn't closed");
        this.#i = end + 3;
        continue;
      }
      return;
    }
  }

  fail(message: string): never {
    const before = this.s.slice(0, this.#i);
    const line = before.split("\n").length;
    const column = this.#i - before.lastIndexOf("\n");
    throw new JsxError(`${message} (line ${line}, column ${column}).`);
  }

  expect(text: string): void {
    if (!this.s.startsWith(text, this.#i)) this.fail(`Expected "${text}"`);
    this.#i += text.length;
  }

  name(): string {
    const m = /^[A-Za-z_][\w.:-]*/.exec(this.s.slice(this.#i));
    if (!m) this.fail("Expected a name");
    this.#i += m[0].length;
    return m[0];
  }

  element(): JsxElement {
    this.expect("<");
    const tag = this.name();
    const attrs: Array<{ name: string; value: unknown }> = [];
    for (;;) {
      this.space();
      if (this.s.startsWith("/>", this.#i)) {
        this.#i += 2;
        return { tag, attrs, children: [] };
      }
      if (this.s[this.#i] === ">") {
        this.#i++;
        break;
      }
      const name = this.name();
      this.space();
      if (this.s[this.#i] !== "=") {
        // A bare attribute is true: <Frame clip>.
        attrs.push({ name, value: true });
        continue;
      }
      this.#i++;
      this.space();
      attrs.push({ name, value: this.value() });
    }
    const children: Array<JsxElement | string> = [];
    for (;;) {
      if (this.done()) this.fail(`<${tag}> isn't closed`);
      if (this.s.startsWith("</", this.#i)) {
        this.#i += 2;
        const closing = this.name();
        if (closing !== tag) this.fail(`</${closing}> closes <${tag}>`);
        this.space();
        this.expect(">");
        return { tag, attrs, children: trimText(children) };
      }
      if (this.s[this.#i] === "<") {
        children.push(this.element());
        continue;
      }
      if (this.s.startsWith("{/*", this.#i)) {
        this.space();
        continue;
      }
      if (this.s[this.#i] === "{") {
        // {"text"}: text written as a string, for characters JSX would read otherwise.
        const value = this.braced();
        if (typeof value !== "string") this.fail("Only text goes in braces between elements");
        children.push(value);
        continue;
      }
      let end = this.#i;
      while (end < this.s.length && this.s[end] !== "<" && this.s[end] !== "{") end++;
      children.push(decodeEntities(this.s.slice(this.#i, end)));
      this.#i = end;
    }
  }

  value(): unknown {
    const c = this.s[this.#i];
    if (c === '"' || c === "'") {
      const end = this.s.indexOf(c, this.#i + 1);
      if (end === -1) this.fail("A string isn't closed");
      const text = decodeEntities(this.s.slice(this.#i + 1, end));
      this.#i = end + 1;
      return text;
    }
    if (c === "{") return this.braced();
    this.fail("An attribute's value goes in quotes or braces");
  }

  /** {JSON}, read to its matching brace (strings inside may hold braces). */
  braced(): unknown {
    const start = this.#i;
    let depth = 0;
    let quote: string | null = null;
    for (let i = this.#i; i < this.s.length; i++) {
      const ch = this.s[i] as string;
      if (quote) {
        if (ch === "\\") i++;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'") quote = ch;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          const inner = this.s.slice(start + 1, i).trim();
          this.#i = i + 1;
          try {
            return JSON.parse(inner.startsWith("'") ? `"${inner.slice(1, -1)}"` : inner);
          } catch {
            this.#i = start;
            this.fail(
              `{${inner}} isn't a number, true, false, null, a "string", an array or an object in JSON`,
            );
          }
        }
      }
    }
    this.fail("A { isn't closed");
  }
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};
function decodeEntities(text: string): string {
  return text.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
    if (e.startsWith("#x") || e.startsWith("#X"))
      return String.fromCodePoint(Number.parseInt(e.slice(2), 16));
    if (e.startsWith("#")) return String.fromCodePoint(Number.parseInt(e.slice(1), 10));
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/**
 * Text between elements as JSX reads it: text on one line stays as written;
 * text over several lines has each line trimmed where it meets a line break,
 * blank lines dropped, and the rest joined by spaces.
 */
function trimText(children: ReadonlyArray<JsxElement | string>): Array<JsxElement | string> {
  const out: Array<JsxElement | string> = [];
  for (const child of children) {
    if (typeof child !== "string" || !child.includes("\n")) {
      out.push(child);
      continue;
    }
    const text = child
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .join(" ");
    if (text !== "") out.push(text);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Elements to layers

const TAGS: Readonly<Record<string, LayerType>> = {
  Frame: "frame",
  Group: "group",
  Rect: "rect",
  Rectangle: "rect",
  Ellipse: "ellipse",
  Polygon: "polygon",
  Star: "star",
  Line: "line",
  Path: "path",
  Vector: "path",
  Text: "text",
};
/** The element each layer type is written as. */
export const TAG_OF: Readonly<Record<LayerType, string>> = {
  frame: "Frame",
  group: "Group",
  rect: "Rect",
  ellipse: "Ellipse",
  polygon: "Polygon",
  star: "Star",
  line: "Line",
  path: "Path",
  text: "Text",
};

/** A tree built from JSX, with the layer it replaces or the instance it inserts named, if any. */
export interface JsxTree extends LayerTree {
  readonly children?: readonly JsxTree[];
}

const PADDING = ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"] as const;
const FLEX: Readonly<Record<string, "none" | "row" | "column" | "grid">> = {
  none: "none",
  row: "row",
  col: "column",
  column: "column",
  grid: "grid",
};
const JUSTIFY: Readonly<Record<string, string>> = {
  start: "start",
  center: "center",
  end: "end",
  between: "space-between",
  "space-between": "space-between",
};

/** A colour as an agent may write it: #rgb, #rrggbb or #rrggbbaa, any case. */
function color(value: unknown, attr: string): string {
  if (typeof value !== "string") throw new JsxError(`${attr} takes a colour like "#ff5a1f"`);
  const v = value.trim().toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(v)) return `#${[...v.slice(1)].map((c) => c + c).join("")}`;
  if (/^#[0-9a-f]{6}([0-9a-f]{2})?$/.test(v)) return v;
  throw new JsxError(`${attr}="${value}" isn't a colour: write #rgb, #rrggbb or #rrggbbaa`);
}

const num = (value: unknown, attr: string): number => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value)))
    return Number(value);
  throw new JsxError(`${attr} takes a number, like ${attr}={16}`);
};

/** One attribute as model properties (several for short forms like `p`). */
export function expandOne(type: LayerType, name: string, value: unknown): Props {
  switch (name) {
    case "w":
    case "width":
      if (value === "hug" || value === "fill") return { sizingH: value };
      return { width: num(value, name) };
    case "h":
    case "height":
      if (value === "hug" || value === "fill") return { sizingV: value };
      return { height: num(value, name) };
    case "p":
      return Object.fromEntries(PADDING.map((k) => [k, num(value, name)])) as Props;
    case "px":
      return { paddingLeft: num(value, name), paddingRight: num(value, name) };
    case "py":
      return { paddingTop: num(value, name), paddingBottom: num(value, name) };
    case "pt":
      return { paddingTop: num(value, name) };
    case "pr":
      return { paddingRight: num(value, name) };
    case "pb":
      return { paddingBottom: num(value, name) };
    case "pl":
      return { paddingLeft: num(value, name) };
    case "flex": {
      const mode = FLEX[String(value)];
      if (!mode) throw new JsxError(`flex="${value}" isn't one of row, col, grid or none`);
      return { layoutMode: mode };
    }
    case "wrap":
      return { layoutWrap: value === true || value === "true" };
    case "justify": {
      const j = JUSTIFY[String(value)];
      if (!j) throw new JsxError(`justify="${value}" isn't one of start, center, end or between`);
      return { justifyContent: j } as Props;
    }
    case "align":
      // On text, align is the text's own alignment; on a frame, how its children sit across.
      return type === "text" ? ({ textAlign: value } as Props) : ({ alignItems: value } as Props);
    case "fill":
      if (Array.isArray(value)) return { fills: value } as Props;
      if (value === "none" || value === null) return { fills: [] };
      return { fills: [{ type: "solid", color: color(value, name) }] };
    case "stroke":
      if (Array.isArray(value)) return { strokes: value } as Props;
      if (value === "none" || value === null) return { strokes: [] };
      return { strokes: [{ type: "solid", color: color(value, name) }] };
    case "radius":
      if (Array.isArray(value)) return { cornerRadii: value as [number, number, number, number] };
      return { cornerRadius: num(value, name) };
    case "clip":
      return { clipContent: value === true || value === "true" };
    case "hidden":
      return { visible: !(value === true || value === "true") };
    case "size":
      return { fontSize: num(value, name) };
    case "weight":
      return { fontWeight: num(value, name) };
    case "font":
      return { fontFamily: String(value) };
    case "italic":
      return { fontStyle: value === true || value === "true" ? "italic" : "normal" };
    case "lineHeight":
      if (value === "auto") return { lineHeight: { unit: "auto" } };
      if (typeof value === "string" && value.endsWith("%"))
        return { lineHeight: { unit: "percent", value: num(value.slice(0, -1), name) } };
      if (typeof value === "object" && value !== null) return { lineHeight: value } as Props;
      return { lineHeight: { unit: "px", value: num(value, name) } };
    case "tracking":
    case "letterSpacing":
      if (typeof value === "string" && value.endsWith("%"))
        return { letterSpacing: { unit: "percent", value: num(value.slice(0, -1), name) } };
      if (typeof value === "object" && value !== null) return { letterSpacing: value } as Props;
      return { letterSpacing: { unit: "px", value: num(value, name) } };
    case "text":
      return { characters: String(value) };
    default:
      if ((PROP_NAMES as readonly string[]).includes(name)) return { [name]: value } as Props;
      throw new JsxError(
        `<${TAG_OF[type]}> has no attribute "${name}": use a property such as name, w, h, fill, flex, gap, p, radius, size, weight, or a model property by its name`,
      );
  }
}

/** The layer trees JSX describes, every property checked against the model. */
export function jsxToTrees(source: string): JsxTree[] {
  return parseJsx(source).map((el) => toTree(el));
}

function toTree(el: JsxElement): JsxTree {
  const type = TAGS[el.tag];
  if (!type)
    throw new JsxError(
      `<${el.tag}> isn't a layer: use ${Object.keys(TAG_OF)
        .map((t) => TAG_OF[t as LayerType])
        .join(", ")}`,
    );
  const props: Record<string, unknown> = {};
  for (const { name, value } of el.attrs) Object.assign(props, expandOne(type, name, value));
  const text = el.children.filter((c): c is string => typeof c === "string").join("");
  const kids = el.children.filter((c): c is JsxElement => typeof c !== "string");
  if (type === "text") {
    if (kids.length > 0) throw new JsxError("<Text> holds text, not other layers");
    if (text !== "" && props.characters === undefined) props.characters = text;
  } else if (text.trim() !== "") {
    throw new JsxError(`<${el.tag}> can't hold text directly: wrap it in <Text>`);
  }
  // Auto layout frames hug their content unless told otherwise, as a new auto layout frame does.
  if (type === "frame" && props.layoutMode && props.layoutMode !== "none") {
    if (props.width === undefined && props.sizingH === undefined) props.sizingH = "hug";
    if (props.height === undefined && props.sizingV === undefined) props.sizingV = "hug";
  }
  // A text with a width wraps inside it.
  if (type === "text" && props.width !== undefined && props.textAutoResize === undefined)
    props.textAutoResize = "height";
  if (type === "text" && props.sizingH === "fill" && props.textAutoResize === undefined)
    props.textAutoResize = "height";
  for (const [name, value] of Object.entries(props)) {
    const prop = name as PropName;
    if (!propAllowed(type, prop))
      throw new JsxError(`<${el.tag}> can't take ${name}: it's for other kinds of layer`);
    const checked = PROPS[prop].schema.safeParse(value);
    if (!checked.success) {
      const issue = checked.error.issues[0];
      throw new JsxError(
        `<${el.tag}> ${name}=${JSON.stringify(value)}: ${issue?.message ?? "not a valid value"}${issue?.path.length ? ` at ${issue.path.join(".")}` : ""}`,
      );
    }
    props[name] = checked.data;
  }
  // A size the layout will work out still needs a starting box.
  if (props.width === undefined) props.width = type === "text" ? 1 : 100;
  if (props.height === undefined) props.height = type === "text" ? 1 : 100;
  return {
    type,
    props: props as Props,
    ...(kids.length > 0 ? { children: kids.map((k) => toTree(k)) } : {}),
  };
}

// ---------------------------------------------------------------------------
// Layers to JSX

/** Properties `get_jsx` leaves out: where the layer is in the tree, and what layout or the editor work out. */
const DERIVED = new Set<PropName>(["x", "y"]);

/** A property as JSX, in its short form where there is one. */
function attr(name: PropName, value: unknown, node: NodeRecord): string | null {
  const json = (v: unknown) => `{${JSON.stringify(v)}}`;
  const str = (v: string) => `"${v.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"`;
  switch (name) {
    case "characters":
      return null; // Written as the element's text.
    // Sizes that layout or the text's own sizing work out aren't written: they'd pin the layer.
    case "width":
      if (node.type === "text" && getProp(node.props, "textAutoResize") === "width") return null;
      return getProp(node.props, "sizingH") === "fixed" ? `w=${json(value)}` : null;
    case "height":
      if (node.type === "text" && getProp(node.props, "textAutoResize") !== "none") return null;
      return getProp(node.props, "sizingV") === "fixed" ? `h=${json(value)}` : null;
    case "sizingH":
      return value === "fixed" ? null : `w=${str(String(value))}`;
    case "sizingV":
      return value === "fixed" ? null : `h=${str(String(value))}`;
    case "layoutMode":
      return `flex=${str(value === "column" ? "col" : String(value))}`;
    case "justifyContent":
      return `justify=${str(value === "space-between" ? "between" : String(value))}`;
    case "alignItems":
      return `align=${str(String(value))}`;
    case "textAlign":
      return `align=${str(String(value))}`;
    case "fills":
    case "strokes": {
      const paints = value as Array<{
        type: string;
        color?: string;
        opacity?: number;
        visible?: boolean;
      }>;
      const short = name === "fills" ? "fill" : "stroke";
      const only = paints[0];
      if (
        paints.length === 1 &&
        only?.type === "solid" &&
        only.opacity === undefined &&
        only.visible === undefined
      )
        return `${short}=${str(only.color as string)}`;
      return `${short}=${json(paints)}`;
    }
    case "cornerRadius":
      return `radius=${json(value)}`;
    case "cornerRadii":
      return value === null ? null : `radius=${json(value)}`;
    case "clipContent":
      return value === true ? "clip" : null;
    case "fontSize":
      return `size=${json(value)}`;
    case "fontWeight":
      return `weight=${json(value)}`;
    case "fontFamily":
      return `font=${str(String(value))}`;
    case "fontStyle":
      return value === "italic" ? "italic" : null;
    case "name":
      return `name=${str(String(value))}`;
    default:
      return typeof value === "string" ? `${name}=${str(value)}` : `${name}=${json(value)}`;
  }
}

/** Whether every padding is the same, so `p` says it. */
function paddingAttrs(node: NodeRecord): { attrs: string[]; covered: boolean } {
  const values = PADDING.map((k) => getProp(node.props, k));
  if (values.every((v) => v === 0)) return { attrs: [], covered: true };
  if (values.every((v) => v === values[0])) return { attrs: [`p={${values[0]}}`], covered: true };
  const [t, r, b, l] = values as [number, number, number, number];
  if (t === b && l === r) return { attrs: [`px={${l}}`, `py={${t}}`], covered: true };
  return { attrs: [], covered: false };
}

/**
 * Layers as JSX, as `render` reads it: the layer, its properties that differ
 * from their defaults (positions only for layers not in auto layout), and its
 * children. `depth` cuts deep trees short with a comment saying what's left
 * out; `ids` adds each layer's id, so an agent can target it.
 */
export function nodeToJsx(
  doc: Doc,
  id: string,
  options: { depth?: number; ids?: boolean; maxChars?: number } = {},
): string {
  const { depth = 20, ids = true, maxChars = Number.POSITIVE_INFINITY } = options;
  let chars = 0;
  const lines: string[] = [];
  // Past `maxChars` it stops writing at once, so what it holds is bounded by that, not the tree.
  const push = (...more: string[]) => {
    for (const line of more) chars += line.length + 1;
    if (chars > maxChars) throw new JsxTooLong(maxChars);
    lines.push(...more);
  };
  const write = (nodeId: string, level: number, inLayout: boolean) => {
    const node = doc.get(nodeId);
    if (!node || !(node.type in TAG_OF)) return;
    const type = node.type as LayerType;
    const tag = TAG_OF[type];
    const pad = "  ".repeat(level);
    const parts: string[] = [];
    if (ids) parts.push(`id="${node.id}"`);
    const padding = paddingAttrs(node);
    for (const name of PROP_NAMES) {
      if (!propAllowed(type, name)) continue;
      if (padding.covered && (PADDING as readonly string[]).includes(name)) continue;
      if ((DERIVED.has(name) && inLayout) || name === "textRuns") continue;
      const value = node.props[name];
      if (value === undefined) continue;
      if (JSON.stringify(value) === JSON.stringify(PROPS[name].default)) continue;
      const a = attr(name, value, node);
      if (a) parts.push(a);
    }
    parts.push(...padding.attrs);
    const children = doc.childIds(nodeId);
    const open = `${pad}<${tag}${parts.length ? ` ${parts.join(" ")}` : ""}`;
    if (type === "text") {
      const text = getProp(node.props, "characters");
      push(`${open}>${escapeText(text)}</${tag}>`);
      return;
    }
    if (children.length === 0) {
      push(`${open} />`);
      return;
    }
    if (level >= depth) {
      push(
        `${open}>`,
        `${pad}  {/* ${children.length} layers not shown: read ${node.id} for them */}`,
        `${pad}</${tag}>`,
      );
      return;
    }
    push(`${open}>`);
    const auto = type === "frame" && getProp(node.props, "layoutMode") !== "none";
    for (const child of children) {
      const c = doc.get(child);
      const absolute = c ? getProp(c.props, "positioning") === "absolute" : false;
      write(child, level + 1, auto && !absolute);
    }
    push(`${pad}</${tag}>`);
  };
  const root = doc.get(id);
  const parent = root ? doc.get(root.parent) : undefined;
  const inLayout =
    parent?.type === "frame" &&
    getProp(parent.props, "layoutMode") !== "none" &&
    root !== undefined &&
    getProp(root.props, "positioning") !== "absolute";
  write(id, 0, inLayout);
  return lines.join("\n");
}

/** JSX longer than a reader asked for (`nodeToJsx`'s `maxChars`). */
export class JsxTooLong extends Error {
  override name = "JsxTooLong";
  constructor(readonly maxChars: number) {
    super(`more than ${maxChars.toLocaleString("en")} characters of JSX`);
  }
}

function escapeText(text: string): string {
  // Characters JSX would read as markup, and line breaks, are written as a string in braces.
  if (/[<>{}\n]/.test(text)) return `{${JSON.stringify(text)}}`;
  return text;
}

/** Layer types JSX can build, for tool descriptions. */
export const JSX_TAGS = LAYER_TYPES.map((t) => TAG_OF[t]);
