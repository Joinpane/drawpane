/**
 * Text styles: named typography (family, weight, size, line height…) that
 * text layers follow. Edit a style once and every layer using it updates,
 * like Figma's text styles and Penpot's typographies.
 *
 * A style is a `textStyle` node at the root of the file, beside pages and
 * variable collections; its name can hold "/" groups ("heading/xl"). A text
 * layer points at one with `textStyle`, and holds the style's values itself,
 * so rendering, export and collaborators never look anything up. Writes that
 * keep layers in step with their style are derived in the same transaction
 * as the edit (see `textStyleFixupOps`), like auto layout and variables.
 *
 * Changing a styled property on a layer by hand detaches the layer from its
 * style (`textStyleDetachOps`): it keeps the look, and stops following.
 */
import { getProp, type NodeRecord, type Op, type PropName, ROOT_ID } from "@drawpane/model";
import type { Doc } from "./doc";

/** The properties a text style sets on the layers that follow it. */
export const TEXT_STYLE_PROPS = [
  "fontFamily",
  "fontWeight",
  "fontStyle",
  "fontSize",
  "lineHeight",
  "letterSpacing",
  "textCase",
  "textDecoration",
  "paragraphSpacing",
] as const satisfies readonly PropName[];
export type TextStyleProp = (typeof TEXT_STYLE_PROPS)[number];

const STYLE_PROPS: ReadonlySet<string> = new Set(TEXT_STYLE_PROPS);

/** The file's text styles, by name. */
export function textStyles(doc: Doc): NodeRecord[] {
  return doc
    .childIds(ROOT_ID)
    .map((id) => doc.get(id))
    .filter((n): n is NodeRecord => n?.type === "textStyle")
    .sort((a, b) =>
      getProp(a.props, "name").localeCompare(getProp(b.props, "name"), undefined, {
        numeric: true,
      }),
    );
}

/** Text layers following a style. */
export function textStyleUsers(doc: Doc, styleId: string): NodeRecord[] {
  const out: NodeRecord[] = [];
  for (const node of doc.nodes())
    if (node.type === "text" && getProp(node.props, "textStyle") === styleId) out.push(node);
  return out;
}

const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

/** The writes that make a layer look like its style (nothing when it already does). */
function followOps(node: NodeRecord, style: NodeRecord): Op[] {
  const ops: Op[] = [];
  for (const prop of TEXT_STYLE_PROPS) {
    const want = getProp(style.props, prop);
    if (!same(getProp(node.props, prop), want))
      // Defaults are stored as absent, so a layer and a style compare alike.
      ops.push({
        op: "set",
        id: node.id,
        prop,
        value: style.props[prop] === undefined ? null : want,
      });
  }
  return ops;
}

/**
 * Derived writes after `ops`: layers whose style changed (or that just got a
 * style) take its values, and layers pointing at a deleted style let go of it.
 */
export function textStyleFixupOps(doc: Doc, ops: readonly Op[]): Op[] {
  const layers = new Set<string>();
  const styles = new Set<string>();
  for (const op of ops) {
    const node = doc.get(op.id);
    if (op.op === "delete") continue;
    if (node?.type === "textStyle") styles.add(node.id);
    else if (node?.type === "text" && op.op === "set" && op.prop === "textStyle")
      layers.add(node.id);
    else if (node?.type === "text" && op.op === "create" && getProp(node.props, "textStyle"))
      layers.add(node.id);
  }
  // A style deleted in this batch: its layers keep their look and let go.
  const deleted = new Set(ops.filter((o) => o.op === "delete").map((o) => o.id));
  if (styles.size === 0 && layers.size === 0 && deleted.size === 0) return [];

  const out: Op[] = [];
  const seen = new Set<string>();
  const follow = (node: NodeRecord) => {
    if (seen.has(node.id)) return;
    seen.add(node.id);
    const styleId = getProp(node.props, "textStyle");
    if (!styleId) return;
    const style = doc.get(styleId);
    if (style?.type !== "textStyle") {
      out.push({ op: "set", id: node.id, prop: "textStyle", value: null });
      return;
    }
    out.push(...followOps(node, style));
  };
  for (const id of layers) {
    const node = doc.get(id);
    if (node) follow(node);
  }
  if (styles.size > 0 || deleted.size > 0) {
    for (const node of doc.nodes()) {
      if (node.type !== "text") continue;
      const styleId = getProp(node.props, "textStyle");
      if (styleId && (styles.has(styleId) || deleted.has(styleId))) follow(node);
    }
  }
  return out;
}

/**
 * Detaching on a person's edit: setting a styled property on a layer that
 * follows a style (without setting its style in the same edit) lets go of
 * the style, so the edit sticks.
 */
export function textStyleDetachOps(doc: Doc, ops: readonly Op[]): Op[] {
  const restyled = new Set(
    ops.filter((o) => o.op === "set" && o.prop === "textStyle").map((o) => o.id),
  );
  const out: Op[] = [];
  const done = new Set<string>();
  for (const op of ops) {
    if (op.op !== "set" || !STYLE_PROPS.has(op.prop) || restyled.has(op.id) || done.has(op.id))
      continue;
    const node = doc.get(op.id);
    if (node?.type !== "text" || !getProp(node.props, "textStyle")) continue;
    const style = doc.get(getProp(node.props, "textStyle") as string);
    // Setting a property to the value the style already has isn't a change
    // (a null value means the default, as it's stored).
    const prop = op.prop as TextStyleProp;
    const incoming = op.value === null ? getProp({}, prop) : op.value;
    if (style && same(getProp(style.props, prop), incoming)) continue;
    done.add(op.id);
    out.push({ op: "set", id: op.id, prop: "textStyle", value: null });
  }
  return out;
}

/**
 * A text style as a DTCG typography token. DTCG wants line height as a
 * multiplier and letter spacing as a dimension; italic, case and decoration
 * aren't part of the type, so they ride along in `$extensions`.
 */
export function typographyToken(style: NodeRecord): Record<string, unknown> {
  const p = style.props;
  const size = getProp(p, "fontSize");
  const lh = getProp(p, "lineHeight");
  const ls = getProp(p, "letterSpacing");
  const lineHeight =
    lh.unit === "px" ? lh.value / size : lh.unit === "percent" ? lh.value / 100 : 1.25;
  const letterSpacing = ls.unit === "px" ? ls.value : (size * ls.value) / 100;
  const token: Record<string, unknown> = {
    $type: "typography",
    $value: {
      fontFamily: getProp(p, "fontFamily"),
      fontWeight: getProp(p, "fontWeight"),
      fontSize: `${round(size)}px`,
      lineHeight: round(lineHeight),
      letterSpacing: `${round(letterSpacing)}px`,
    },
  };
  const extras: Record<string, string> = {};
  if (getProp(p, "fontStyle") !== "normal") extras.fontStyle = getProp(p, "fontStyle");
  if (getProp(p, "textCase") !== "none") extras.textCase = getProp(p, "textCase");
  if (getProp(p, "textDecoration") !== "none") extras.textDecoration = getProp(p, "textDecoration");
  if (Object.keys(extras).length > 0) token.$extensions = { "drawpane.text": extras };
  const description = getProp(p, "description");
  if (description) token.$description = description;
  return token;
}

/** "22 / 28 · Semibold": a style's size, line height and weight, for lists. */
export function describeTextStyle(style: NodeRecord): string {
  const size = getProp(style.props, "fontSize");
  const lh = getProp(style.props, "lineHeight");
  const lineHeight =
    lh.unit === "auto" ? "Auto" : lh.unit === "px" ? `${round(lh.value)}` : `${round(lh.value)}%`;
  const weight =
    WEIGHTS[getProp(style.props, "fontWeight")] ?? String(getProp(style.props, "fontWeight"));
  const extras = [
    getProp(style.props, "fontStyle") === "italic" ? "Italic" : null,
    getProp(style.props, "textCase") === "upper" ? "caps" : null,
  ].filter(Boolean);
  return [`${round(size)} / ${lineHeight}`, weight, ...extras].join(" · ");
}

const round = (n: number) => Math.round(n * 100) / 100;

const WEIGHTS: Readonly<Record<number, string>> = {
  100: "Thin",
  200: "Extra light",
  300: "Light",
  400: "Regular",
  500: "Medium",
  600: "Semibold",
  700: "Bold",
  800: "Extra bold",
  900: "Black",
};
