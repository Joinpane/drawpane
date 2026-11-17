/**
 * Figma's variables, modes and styles as Drawpane's (decision 0034): the
 * collections and variables GET /v1/files/:key/variables/local returns (or
 * a `.fig` holds), the file's paint, effect and text styles, and the
 * bindings, style links and explicit modes on its layers.
 *
 * Ids are Figma's, spelled as Drawpane ids (`drawpaneId`), so a file read by
 * link or from its `.fig` imports to the same ids, and importing it again
 * matches them up. A binding is kept only to a variable the file brings;
 * one to anything else (a library the file doesn't carry) is left out, and
 * the layer shows the value Figma saved.
 */
import {
  type BindingKey,
  keysBetween,
  MAX_MODES,
  type Mode,
  type NodeRecord,
  type NodeType,
  propAllowed,
  ROOT_ID,
  VARIABLE_SCOPES,
  type VariableScope,
  type VariableValue,
} from "@drawpane/model";
import { convertEffects } from "./effects";
import { drawpaneId } from "./ids";
import type { Notes } from "./notes";
import { convertPaints, hexColor, type ImageLookup } from "./paint";
import type * as Figma from "./rest";
import { textProps } from "./text";

type Props = Record<string, unknown>;

/** A variable a REST alias names, as a Drawpane id, when the file brings it. */
export type VariableLookup = (alias: unknown) => string | undefined;

/** A lookup that knows no variables: what converting a file without them uses. */
export const NO_VARIABLES: VariableLookup = () => undefined;

export function variableLookup(file: Figma.File): VariableLookup {
  const variables = file.variables?.variables;
  if (!variables) return NO_VARIABLES;
  return (alias) => {
    const id = (alias as { id?: unknown } | null | undefined)?.id;
    if (typeof id !== "string" || !variables[id]) return undefined;
    return drawpaneId(id);
  };
}

const TYPES = { COLOR: "color", FLOAT: "number", STRING: "string", BOOLEAN: "boolean" } as const;
/** Figma's scope names, the `.fig` spelling of stroke colours included. */
const SCOPE_ALIASES: Readonly<Record<string, VariableScope>> = { STROKE: "STROKE_COLOR" };
const PLATFORMS = { WEB: "web", iOS: "ios", ANDROID: "android" } as const;

function isRgba(v: unknown): v is Figma.RGBA {
  return !!v && typeof v === "object" && typeof (v as Figma.RGBA).r === "number";
}

/**
 * The file's collections and variables, as nodes under the root (keys after
 * `afterKey`), and what each mode's Figma id became. Soft-deleted ones never
 * reach here: neither REST nor the `.fig` reader lists them.
 */
export function convertVariables(
  file: Figma.File,
  notes: Notes,
  afterKey: string | null,
): { nodes: NodeRecord[]; modes: ReadonlyMap<string, ReadonlySet<string>> } {
  const meta = file.variables;
  const nodes: NodeRecord[] = [];
  const modes = new Map<string, Set<string>>();
  if (!meta) return { nodes, modes };
  const byCollection = new Map<string, Figma.Variable[]>();
  for (const v of Object.values(meta.variables)) {
    const list = byCollection.get(v.variableCollectionId);
    if (list) list.push(v);
    else byCollection.set(v.variableCollectionId, [v]);
  }
  // A library's collection the file copies without any of its variables has nothing to show.
  const collections = Object.values(meta.variableCollections).filter(
    (c) => !c.remote || (byCollection.get(c.id)?.length ?? 0) > 0,
  );
  const keys = keysBetween(afterKey, null, collections.length);
  const lookup = variableLookup(file);
  collections.forEach((c, i) => {
    const id = drawpaneId(c.id);
    // The default mode first, as Figma lists it and Drawpane reads it.
    const ordered = [
      ...c.modes.filter((m) => m.modeId === c.defaultModeId),
      ...c.modes.filter((m) => m.modeId !== c.defaultModeId),
    ];
    if (ordered.length > MAX_MODES) notes.add("modes-dropped");
    const kept: Mode[] = ordered
      .slice(0, MAX_MODES)
      .map((m) => ({ id: drawpaneId(m.modeId), name: (m.name || "Mode").slice(0, 64) }));
    if (kept.length === 0) kept.push({ id: "m1", name: "Default" });
    modes.set(id, new Set(kept.map((m) => m.id)));
    const props: Props = { name: (c.name || "Collection").slice(0, 256), modes: kept };
    if (c.hiddenFromPublishing) props.hiddenFromPublishing = true;
    nodes.push({
      id,
      type: "collection",
      parent: ROOT_ID,
      key: keys[i] as string,
      props,
    } as NodeRecord);

    const variables = byCollection.get(c.id) ?? [];
    const order = new Map((c.variableIds ?? []).map((v, j) => [v, j]));
    variables.sort((a, b) => (order.get(a.id) ?? 1e9) - (order.get(b.id) ?? 1e9));
    const variableKeys = keysBetween(null, null, variables.length);
    variables.forEach((v, j) => {
      const type = TYPES[v.resolvedType];
      if (!type) return;
      const values: Record<string, VariableValue> = {};
      for (const [modeId, value] of Object.entries(v.valuesByMode)) {
        const mode = drawpaneId(modeId);
        if (!modes.get(id)?.has(mode)) continue;
        const converted = variableValue(value, type, lookup);
        if (converted !== undefined) values[mode] = converted;
      }
      const vp: Props = { name: (v.name || "Variable").slice(0, 256), variableType: type, values };
      if (v.description) vp.description = v.description.slice(0, 2000);
      if (v.hiddenFromPublishing) vp.hiddenFromPublishing = true;
      const scopes = [
        ...new Set(
          (v.scopes ?? [])
            .map((s) => SCOPE_ALIASES[s] ?? s)
            .filter((s): s is VariableScope => (VARIABLE_SCOPES as readonly string[]).includes(s)),
        ),
      ].filter((s) => s !== "ALL_SCOPES");
      if (scopes.length > 0) vp.scopes = scopes;
      const code: Record<string, string> = {};
      for (const [platform, text] of Object.entries(v.codeSyntax ?? {})) {
        const key = PLATFORMS[platform as keyof typeof PLATFORMS];
        if (key && text) code[key] = text.slice(0, 256);
      }
      if (Object.keys(code).length > 0) vp.codeSyntax = code;
      nodes.push({
        id: drawpaneId(v.id),
        type: "variable",
        parent: id,
        key: variableKeys[j] as string,
        props: vp,
      } as NodeRecord);
    });
  });
  return { nodes, modes };
}

function variableValue(
  value: Figma.VariableModeValue,
  type: "color" | "number" | "string" | "boolean",
  lookup: VariableLookup,
): VariableValue | undefined {
  if (value && typeof value === "object" && "type" in value && value.type === "VARIABLE_ALIAS") {
    const alias = lookup(value);
    if (!alias) return undefined;
    const opacity = (value as { opacity?: unknown }).opacity;
    return typeof opacity === "number" && opacity < 1
      ? { alias, opacity: Math.max(0, Math.round(opacity * 10_000) / 10_000) }
      : { alias };
  }
  switch (type) {
    case "color":
      return isRgba(value) ? hexColor(value) : undefined;
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? value : undefined;
    case "string":
      return typeof value === "string" ? value.slice(0, 10_000) : undefined;
    case "boolean":
      return typeof value === "boolean" ? value : undefined;
  }
}

// ---------------------------------------------------------------------------
// Bindings on layers

/** REST's (and the plugin API's) names for a layer's own bound fields. */
const FIELDS: Readonly<Record<string, BindingKey>> = {
  width: "width",
  height: "height",
  minWidth: "minWidth",
  maxWidth: "maxWidth",
  minHeight: "minHeight",
  maxHeight: "maxHeight",
  itemSpacing: "gap",
  gridColumnGap: "gap",
  counterAxisSpacing: "rowGap",
  gridRowGap: "rowGap",
  paddingTop: "paddingTop",
  paddingRight: "paddingRight",
  paddingBottom: "paddingBottom",
  paddingLeft: "paddingLeft",
  cornerRadius: "cornerRadius",
  topLeftRadius: "topLeftRadius",
  topRightRadius: "topRightRadius",
  bottomRightRadius: "bottomRightRadius",
  bottomLeftRadius: "bottomLeftRadius",
  strokeWeight: "strokeWeight",
  strokeTopWeight: "strokeTopWeight",
  strokeRightWeight: "strokeRightWeight",
  strokeBottomWeight: "strokeBottomWeight",
  strokeLeftWeight: "strokeLeftWeight",
  opacity: "opacity",
  visible: "visible",
  characters: "characters",
  fontFamily: "fontFamily",
  fontStyle: "fontStyle",
  fontWeight: "fontWeight",
  fontSize: "fontSize",
  lineHeight: "lineHeight",
  letterSpacing: "letterSpacing",
  paragraphSpacing: "paragraphSpacing",
};
/** Fields REST nests in an object of their own. */
const NESTED: Readonly<Record<string, Readonly<Record<string, BindingKey>>>> = {
  size: { x: "width", y: "height" },
  individualStrokeWeights: {
    top: "strokeTopWeight",
    right: "strokeRightWeight",
    bottom: "strokeBottomWeight",
    left: "strokeLeftWeight",
  },
  rectangleCornerRadii: {
    RECTANGLE_TOP_LEFT_CORNER_RADIUS: "topLeftRadius",
    RECTANGLE_TOP_RIGHT_CORNER_RADIUS: "topRightRadius",
    RECTANGLE_BOTTOM_RIGHT_CORNER_RADIUS: "bottomRightRadius",
    RECTANGLE_BOTTOM_LEFT_CORNER_RADIUS: "bottomLeftRadius",
  },
};
/** The property each key drives, to check the layer has it. */
const DRIVES: Partial<Record<BindingKey, string>> = {
  topLeftRadius: "cornerRadii",
  topRightRadius: "cornerRadii",
  bottomRightRadius: "cornerRadii",
  bottomLeftRadius: "cornerRadii",
  strokeTopWeight: "strokeWeights",
  strokeRightWeight: "strokeWeights",
  strokeBottomWeight: "strokeWeights",
  strokeLeftWeight: "strokeWeights",
  fontStyle: "fontWeight",
};

/** A text's typography bindings come as a list per range: the first, when they're all one. */
function single(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  const first = value[0] as { id?: unknown } | undefined;
  return value.every((v) => (v as { id?: unknown })?.id === first?.id) ? first : undefined;
}

/** A layer's own bound fields, as Drawpane `bindings`, for the fields its kind has. */
export function layerBindings(
  node: Figma.Node,
  type: NodeType,
  lookup: VariableLookup,
): Partial<Record<BindingKey, string>> {
  const out: Partial<Record<BindingKey, string>> = {};
  const bound = node.boundVariables as Readonly<Record<string, unknown>> | undefined;
  if (!bound) return out;
  const put = (key: BindingKey, alias: unknown) => {
    const id = lookup(single(alias));
    if (!id) return;
    const prop = DRIVES[key] ?? key;
    if (propAllowed(type, prop as never)) out[key] = id;
  };
  for (const [field, alias] of Object.entries(bound)) {
    const key = FIELDS[field];
    if (key) put(key, alias);
    const nested = NESTED[field];
    if (nested && alias && typeof alias === "object" && !Array.isArray(alias))
      for (const [part, inner] of Object.entries(alias as Record<string, unknown>)) {
        const k = nested[part];
        if (k) put(k, inner);
      }
  }
  return out;
}

/** The modes a layer sets, by Drawpane collection and mode ids, for the collections the file brings. */
export function layerModes(
  node: Figma.Node,
  modes: ReadonlyMap<string, ReadonlySet<string>>,
): Record<string, string> | null {
  const set = node.explicitVariableModes;
  if (!set) return null;
  const out: Record<string, string> = {};
  for (const [collection, mode] of Object.entries(set)) {
    const c = drawpaneId(collection);
    const m = drawpaneId(mode);
    if (modes.get(c)?.has(m)) out[c] = m;
  }
  return Object.keys(out).length > 0 ? out : null;
}

// ---------------------------------------------------------------------------
// Styles

/** What a text style sets: typography only. */
const TEXT_STYLE_PROPS = [
  "fontFamily",
  "fontWeight",
  "fontStyle",
  "fontSize",
  "lineHeight",
  "letterSpacing",
  "textCase",
  "textDecoration",
  "fontFeatures",
  "paragraphSpacing",
  "listSpacing",
  "leadingTrim",
] as const;

/**
 * The file's paint, effect and text styles whose definitions it has, as
 * nodes under the root (keys after `afterKey`). Grid styles aren't brought
 * yet (decision 0034, phase 3): layers keep their grids.
 */
export function convertStyles(
  file: Figma.File,
  images: ImageLookup,
  notes: Notes,
  lookup: VariableLookup,
  afterKey: string | null,
): NodeRecord[] {
  const out: NodeRecord[] = [];
  const defs = file.styleNodes ?? {};
  const entries = Object.entries(file.styles ?? {}).filter(([id]) => defs[id]);
  const keys = keysBetween(afterKey, null, entries.length);
  entries.forEach(([styleId, meta], i) => {
    const node = defs[styleId] as Figma.Node;
    const props: Props = { name: (meta.name || node.name || "Style").slice(0, 256) };
    if (meta.description) props.description = meta.description.slice(0, 2000);
    if (meta.hiddenFromPublishing) props.hiddenFromPublishing = true;
    let type: NodeType;
    switch (meta.styleType) {
      case "FILL":
        type = "paintStyle";
        props.fills = convertPaints(node.fills, images, notes, lookup);
        break;
      case "EFFECT":
        type = "effectStyle";
        props.effects = convertEffects(node.effects, notes, lookup);
        break;
      case "TEXT": {
        type = "textStyle";
        const text = textProps(node, images, notes, lookup);
        for (const prop of TEXT_STYLE_PROPS) if (text[prop] !== undefined) props[prop] = text[prop];
        break;
      }
      default:
        notes.add("style-unsupported");
        return;
    }
    out.push({
      id: drawpaneId(styleId),
      type,
      parent: ROOT_ID,
      key: keys[i] as string,
      props,
    } as NodeRecord);
  });
  return out;
}

/** The styles a layer links, as Drawpane links, to the styles brought (`styles`, by id and kind). */
export function layerStyles(
  node: Figma.Node,
  type: NodeType,
  styles: ReadonlyMap<string, NodeType>,
): Props {
  const out: Props = {};
  const links = node.styles;
  if (!links) return out;
  const link = (figmaId: string | undefined, kind: NodeType, prop: string) => {
    if (!figmaId) return;
    const id = drawpaneId(figmaId);
    if (styles.get(id) === kind && propAllowed(type, prop as never)) out[prop] = id;
  };
  link(links.fill ?? links.fills, "paintStyle", "fillStyle");
  link(links.stroke ?? links.strokes, "paintStyle", "strokeStyle");
  link(links.effect ?? links.effects, "effectStyle", "effectStyle");
  link(links.text, "textStyle", "textStyle");
  return out;
}
