/**
 * Feature coverage: every Figma feature a .fig uses, counted, and what the
 * import makes of each, judged on the converted output (not on the
 * converter's code).
 *
 * 1. **Census.** The file's raw records (Open Pencil's parsed `NodeChange`s,
 *    before anything is resolved) are walked once. Each feature found is a
 *    hit: the layer to look at in the output (a saved layer's Figma id, or
 *    the id an instance gives a layer it overrides), the record whose
 *    copies it reaches, and what to compare. Features are node fields
 *    (effects, paints, blend modes, strokes, constraints, auto layout,
 *    grids, text, vectors, masks, booleans), component property
 *    definitions and the layers referencing them, variable collections and
 *    variables, bound variables by field (on layers, in instance overrides,
 *    in text runs, paints and effects), styles and their use, prototype
 *    interactions, export settings and the rest.
 * 2. **Check.** The converted file (`convert.ts`, as the dashboard imports
 *    it) is read once. Each hit's layer is looked up by its Drawpane id and
 *    compared: **faithful** when the output carries the feature (the same
 *    kind of effect with the same values, a binding, a collection with the
 *    same modes), **approximate** when it carries what the feature looked
 *    like but not the feature (a bound value baked to its number, a boolean
 *    made a path, a property applied to each copy but gone as a property),
 *    **lost** when neither (no shadow where Figma has one, no collection,
 *    the layer missing). The output's own figures are read too: what kinds
 *    of nodes it has, and the overrides each copy lists against the ones
 *    Figma saved for it.
 * 3. **Rank.** Impact = layers affected × importance × the share not
 *    faithful (lost counts whole, approximate half). Layers affected
 *    counts every layer of the output the feature reaches: a component's
 *    layer once for itself and once for each copy of it.
 *
 * Generic: no file's names or ids are written here.
 */
import { createReadStream } from "node:fs";
import { drawpaneId } from "@drawpane/figma";
import { parseFigBuffer } from "@open-pencil/fig";

// ---------------------------------------------------------------------------
// Loose reading of raw records (only what's read is assumed)

export type Obj = { readonly [key: string]: unknown };
const obj = (v: unknown): Obj | undefined =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : undefined;
const arr = (v: unknown): readonly unknown[] => (Array.isArray(v) ? v : []);
const objs = (v: unknown): Obj[] => arr(v).flatMap((x) => (obj(x) ? [x as Obj] : []));
const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const guidOf = (v: unknown): string | null => {
  const g = obj(v);
  const s = num(g?.sessionID);
  const l = num(g?.localID);
  return s === undefined || l === undefined ? null : `${s}:${l}`;
};

// ---------------------------------------------------------------------------
// The converted output

/** A node of the converted file, as `nodes.ndjson` holds it. */
export interface OutNode {
  readonly id: string;
  readonly type: string;
  readonly parent: string;
  readonly props: Obj;
}

export type Outcome = "faithful" | "approximate" | "lost";
export type Importance = "visual" | "editing" | "metadata";
export const WEIGHT: Record<Importance, number> = { visual: 3, editing: 2, metadata: 1 };

/** What a check sees: the hit's layer in the output, its record, the output's figures. */
interface CheckInput {
  readonly node: OutNode | undefined;
  readonly record: Obj | undefined;
  readonly data: unknown;
  readonly out: OutputFacts;
}
/** Null: this hit can't be judged (its layer isn't one the output places). */
type Check = (input: CheckInput) => Outcome | null;

interface FeatureDef {
  readonly key: string;
  readonly area: string;
  readonly label: string;
  readonly importance: Importance;
  /** Where a fix most likely goes. */
  readonly code: string;
  readonly check: Check;
  /** How the check decides, for the report. */
  readonly how: string;
}

interface Hit {
  /** The Figma id of the layer to look at in the output. */
  readonly target: string;
  /** The record whose copies the feature reaches (layers affected). */
  readonly owner: string;
  readonly data?: unknown;
  /** Its layer is named by a path the output may spell otherwise: not judged when missing. */
  readonly soft?: true;
}

interface Accumulated {
  readonly def: FeatureDef;
  readonly hits: Hit[];
  readonly records: Set<string>;
  uses: number;
}

export interface FeatureResult {
  readonly key: string;
  readonly area: string;
  readonly label: string;
  readonly importance: Importance;
  readonly code: string;
  readonly how: string;
  /** Records using it. */
  readonly records: number;
  /** Uses (a layer with two shadows uses shadows twice). */
  readonly uses: number;
  /** Layers of the output it reaches, copies included. */
  readonly layers: number;
  readonly checked: number;
  readonly faithful: number;
  readonly approximate: number;
  readonly lost: number;
  /** Of the lost: layers not in the output at all. */
  readonly absent: number;
  /** Not judged: layers an override names that the output spells differently (or not at all). */
  readonly unresolved: number;
  readonly status: "faithful" | "approximate" | "lost" | "unchecked";
  /** Share not carried: lost + half the approximate, over those checked. */
  readonly gap: number;
  readonly impact: number;
  readonly examples: readonly string[];
  /** Hits whose outcome was not faithful, for following up. */
  readonly failing: readonly string[];
}

/** Figures read off the whole output. */
export interface OutputFacts {
  readonly nodes: number;
  readonly types: Record<string, number>;
  readonly collections: Map<string, OutNode>;
  readonly variables: Map<string, OutNode>;
  readonly textStyles: Map<string, OutNode>;
  readonly withBindings: number;
  readonly bindingKeys: Record<string, number>;
  readonly withVariableModes: number;
  readonly withReactions: number;
  readonly componentSets: number;
  readonly components: number;
  readonly instances: number;
  readonly copies: number;
}

// ---------------------------------------------------------------------------
// Mappings between Figma's words and the output's

const EFFECT_TYPES: Record<string, string> = {
  DROP_SHADOW: "drop-shadow",
  INNER_SHADOW: "inner-shadow",
  FOREGROUND_BLUR: "layer-blur",
  LAYER_BLUR: "layer-blur",
  BACKGROUND_BLUR: "background-blur",
  NOISE: "noise",
  TEXTURE: "texture",
  GLASS: "glass",
};
const PAINT_TYPES: Record<string, string> = {
  SOLID: "solid",
  GRADIENT_LINEAR: "linear",
  GRADIENT_RADIAL: "radial",
  GRADIENT_ANGULAR: "angular",
  GRADIENT_DIAMOND: "radial",
  IMAGE: "image",
};
/** Variable fields → the binding key the model has for them (none: only the value can come). */
const BINDING_FOR: Record<string, string> = {
  STACK_SPACING: "gap",
  STACK_COUNTER_SPACING: "rowGap",
  GRID_COLUMN_GAP: "gap",
  GRID_ROW_GAP: "rowGap",
  STACK_PADDING_TOP: "paddingTop",
  STACK_PADDING_BOTTOM: "paddingBottom",
  STACK_PADDING_LEFT: "paddingLeft",
  STACK_PADDING_RIGHT: "paddingRight",
  CORNER_RADIUS: "cornerRadius",
  RECTANGLE_TOP_LEFT_CORNER_RADIUS: "cornerRadius",
  RECTANGLE_TOP_RIGHT_CORNER_RADIUS: "cornerRadius",
  RECTANGLE_BOTTOM_LEFT_CORNER_RADIUS: "cornerRadius",
  RECTANGLE_BOTTOM_RIGHT_CORNER_RADIUS: "cornerRadius",
  WIDTH: "width",
  HEIGHT: "height",
  STROKE_WEIGHT: "strokeWeight",
  BORDER_TOP_WEIGHT: "strokeWeight",
  BORDER_RIGHT_WEIGHT: "strokeWeight",
  BORDER_BOTTOM_WEIGHT: "strokeWeight",
  BORDER_LEFT_WEIGHT: "strokeWeight",
  OPACITY: "opacity",
  FONT_SIZE: "fontSize",
  FONT_FAMILY: "fontFamily",
  TEXT_DATA: "characters",
  fill: "fill",
  stroke: "stroke",
};
/** Variable fields → the property the bound value lands in, when the model has one. */
const VALUE_FOR: Record<string, string> = {
  VISIBLE: "visible",
  MIN_WIDTH: "minWidth",
  MAX_WIDTH: "maxWidth",
  MIN_HEIGHT: "minHeight",
  MAX_HEIGHT: "maxHeight",
  LINE_HEIGHT: "lineHeight",
  LETTER_SPACING: "letterSpacing",
  FONT_STYLE: "fontWeight",
  PARAGRAPH_SPACING: "paragraphSpacing",
};
/** Figma's override fields that explain a copy listing each Drawpane property as overridden. */
const OVERRIDE_FIELDS: Record<string, readonly string[]> = {
  characters: ["textData", "componentPropAssignments"],
  textRuns: ["textData", "styleIdForText"],
  visible: ["visible", "componentPropAssignments"],
  fills: ["fillPaints", "styleIdForFill", "variableConsumptionMap"],
  strokes: ["strokePaints", "styleIdForStrokeFill", "variableConsumptionMap"],
  effects: ["effects", "styleIdForEffect"],
  opacity: ["opacity"],
  instanceOf: ["overriddenSymbolID", "componentPropAssignments"],
  name: ["name"],
  fontSize: ["fontSize", "styleIdForText"],
  fontFamily: ["fontName", "styleIdForText"],
  fontWeight: ["fontName", "styleIdForText"],
  lineHeight: ["lineHeight", "styleIdForText"],
  letterSpacing: ["letterSpacing", "styleIdForText"],
  textCase: ["textCase", "styleIdForText"],
  textDecoration: ["textDecoration", "styleIdForText"],
  cornerRadius: ["cornerRadius", "rectangleTopLeftCornerRadius"],
  cornerRadii: ["rectangleTopLeftCornerRadius", "rectangleCornerRadiiIndependent"],
  strokeWeight: ["strokeWeight", "borderTopWeight"],
  strokeWeights: ["borderTopWeight", "borderStrokeWeightsIndependent"],
  width: ["size"],
  height: ["size"],
  paddingTop: ["stackVerticalPadding", "stackPaddingTop"],
  paddingBottom: ["stackVerticalPadding", "stackPaddingBottom"],
  paddingLeft: ["stackHorizontalPadding", "stackPaddingLeft"],
  paddingRight: ["stackHorizontalPadding", "stackPaddingRight"],
  gap: ["stackSpacing"],
  layoutMode: ["stackMode"],
  sizingH: ["stackPrimarySizing", "stackCounterSizing", "stackChildAlignSelf"],
  sizingV: ["stackPrimarySizing", "stackCounterSizing", "stackChildAlignSelf"],
};

/** "Semi Bold Italic" → 600, italic. */
export function styleWeight(style: string): { weight: number; italic: boolean } {
  const s = style.toLowerCase().replace(/[\s_-]/g, "");
  const italic = /italic|oblique/.test(s);
  const table: [RegExp, number][] = [
    [/thin|hairline/, 100],
    [/extralight|ultralight/, 200],
    [/light/, 300],
    [/medium/, 500],
    [/semibold|demibold/, 600],
    [/extrabold|ultrabold/, 800],
    [/bold/, 700],
    [/black|heavy/, 900],
  ];
  for (const [re, weight] of table) if (re.test(s)) return { weight, italic };
  return { weight: 400, italic };
}

const near = (a: unknown, b: unknown, tolerance = 0.02) => {
  const x = num(a) ?? 0;
  const y = num(b) ?? 0;
  return Math.abs(x - y) <= tolerance * Math.max(1, Math.abs(x), Math.abs(y));
};
const props = (input: CheckInput) => input.node?.props ?? {};
/** The output carries `needle` somewhere other than the layer's name and text. */
function carries(node: OutNode | undefined, needle: string): boolean {
  if (!node) return false;
  const { name: _name, characters: _characters, ...rest } = node.props;
  return JSON.stringify(rest).includes(needle);
}

// ---------------------------------------------------------------------------
// Checks, by what they compare

/** Present in the output with this property set (and, when given, to this value). */
const hasProp =
  (prop: string, value?: (p: unknown, data: unknown) => boolean): Check =>
  (input) => {
    if (!input.node) return "lost";
    const v = props(input)[prop];
    if (v === undefined) return "lost";
    return !value || value(v, input.data) ? "faithful" : "approximate";
  };
/** The model has nowhere to keep it: lost unless the output carries a property of this name. */
const noField =
  (prop: string): Check =>
  (input) =>
    !input.node ? "lost" : props(input)[prop] !== undefined ? "faithful" : "lost";
/** The layer comes through; whether the feature itself does is judged by `prop` being set. */
const kept =
  (prop: string): Check =>
  (input) =>
    !input.node ? "lost" : props(input)[prop] !== undefined ? "faithful" : "approximate";
const exists: Check = (input) => (input.node ? "faithful" : "lost");

/** A bound value: faithful with the binding, approximate when only its value came (baked). */
const bound =
  (field: string): Check =>
  (input) => {
    if (!input.node) return "lost";
    const key = BINDING_FOR[field];
    const bindings = obj(props(input).bindings);
    if (key && bindings?.[key]) return input.out.variables.size > 0 ? "faithful" : "approximate";
    return "approximate";
  };

/** Effects of one kind: the same number of them, with the same values. */
const effectCheck =
  (figmaType: string): Check =>
  (input) => {
    if (!input.node) return "lost";
    const want = objs(input.data);
    const type = EFFECT_TYPES[figmaType];
    const got = objs(props(input).effects).filter((e) => e.type === type);
    if (got.length === 0) return "lost";
    if (got.length < want.length) return "approximate";
    const same = want.every((w, i) => {
      const g = got[i] as Obj;
      if (figmaType === "DROP_SHADOW" || figmaType === "INNER_SHADOW") {
        const offset = obj(w.offset);
        return (
          near(g.blur, w.radius) &&
          near(g.spread, w.spread ?? 0) &&
          near(g.x, offset?.x) &&
          near(g.y, offset?.y)
        );
      }
      if (figmaType.endsWith("BLUR")) return near(g.radius, w.radius);
      return true;
    });
    return same ? "faithful" : "approximate";
  };

const paintCheck =
  (list: "fills" | "strokes", figmaType: string): Check =>
  (input) => {
    if (!input.node) return "lost";
    const got = objs(props(input)[list]).filter((p) => p.type === PAINT_TYPES[figmaType]);
    if (got.length === 0) return "lost";
    return figmaType === "GRADIENT_DIAMOND" ? "approximate" : "faithful";
  };

const KIND_FOR: Record<string, readonly string[]> = {
  FRAME: ["frame"],
  SYMBOL: ["frame"],
  INSTANCE: ["frame"],
  SECTION: ["frame"],
  TEXT: ["text"],
  ELLIPSE: ["ellipse"],
  LINE: ["line"],
  RECTANGLE: ["rect"],
  ROUNDED_RECTANGLE: ["rect"],
  REGULAR_POLYGON: ["polygon"],
  STAR: ["star"],
  VECTOR: ["path"],
  GROUP: ["group"],
};
const typeCheck =
  (figmaType: string): Check =>
  (input) => {
    if (!input.node) return "lost";
    const kinds = KIND_FOR[figmaType];
    return kinds?.includes(input.node.type) ? "faithful" : "approximate";
  };

// ---------------------------------------------------------------------------
// The census

const FONT_STYLE_FIELD = /^font(Variant|Variation)/;

export interface CensusOptions {
  /** How many hits per feature are checked against the output (the rest are counted). */
  readonly maxChecks?: number;
}

class Census {
  readonly features = new Map<string, Accumulated>();
  /** Variables, collections and styles → the records that use them (directly or by alias). */
  readonly consumers = new Map<string, Set<string>>();
  /** Component sets → their variants, for how many instances a property definition reaches. */
  readonly variants = new Map<string, string[]>();

  consume(used: string, by: string) {
    const set = this.consumers.get(used) ?? new Set<string>();
    set.add(by);
    this.consumers.set(used, set);
  }

  hit(
    def: Omit<FeatureDef, "key"> & { key: string },
    owner: string,
    target = owner,
    data?: unknown,
    soft = false,
  ) {
    let acc = this.features.get(def.key);
    if (!acc) {
      acc = { def, hits: [], records: new Set(), uses: 0 };
      this.features.set(def.key, acc);
    }
    acc.uses++;
    acc.records.add(owner);
    acc.hits.push({
      target,
      owner,
      ...(data === undefined ? {} : { data }),
      ...(soft ? { soft: true } : {}),
    });
  }
}

const CODE = {
  effects:
    "packages/fig/src/paint.ts (effects from records and styles), packages/figma/src/effects.ts",
  paints: "packages/fig/src/paint.ts, packages/figma/src/paint.ts",
  layout: "packages/fig/src/adapt.ts (stack fields), packages/figma/src/layout.ts",
  text: "packages/fig/src/text.ts, packages/figma/src/text.ts",
  geometry: "packages/fig/src/geometry.ts, packages/figma/src/convert.ts",
  components: "packages/figma/src/convert.ts (instances, variants), packages/editor pinInstances",
  componentProps:
    "packages/figma/src/convert.ts (componentPropertyDefinitions); the model has variantProps only",
  variables:
    "packages/fig/src/read.ts (materializeDocument resolves bindings to values); the model's collection, variable, bindings and variableModes are never written",
  styles:
    "packages/fig/src/styles.ts (styles resolved into layers); the model's textStyle is never written",
  prototype: "packages/fig/src/adapt.ts; the model's reactions and flows",
  meta: "packages/fig/src/adapt.ts",
} as const;

/** Every feature the records use, as hits to check. */
function census(records: readonly Obj[], census: Census): { pageOf: Map<string, string | null> } {
  const byGuid = new Map<string, Obj>();
  for (const r of records) {
    const g = guidOf(r.guid);
    if (g) byGuid.set(g, r);
  }
  // Each record's page, and whether that page is the internal one (nothing on it is placed).
  const pageOf = new Map<string, string | null>();
  const internal = new Set<string>();
  for (const r of records)
    if (r.type === "CANVAS" && r.internalOnly === true) internal.add(guidOf(r.guid) as string);
  const page = (g: string): string | null => {
    const known = pageOf.get(g);
    if (known !== undefined) return known;
    const r = byGuid.get(g);
    let out: string | null = null;
    if (r?.type === "CANVAS") out = g;
    else {
      const parent = guidOf(obj(r?.parentIndex)?.guid);
      out = parent ? page(parent) : null;
    }
    pageOf.set(g, out);
    return out;
  };

  // Styles, variables and component property definitions, by id.
  const styles = new Map<string, Obj>();
  const variables = new Map<string, Obj>();
  const sets = new Map<string, Obj>();
  const defs = new Map<string, Obj & { owner?: string }>();
  for (const r of records) {
    const g = guidOf(r.guid) as string;
    if (str(r.styleType)) styles.set(g, r);
    if (r.type === "VARIABLE") variables.set(g, r);
    if (r.type === "VARIABLE_SET") sets.set(g, r);
  }
  for (const r of records)
    for (const d of objs(r.componentPropDefs)) {
      const id = guidOf(d.id);
      if (id && str(d.type)) defs.set(id, { ...d, owner: guidOf(r.guid) as string });
    }
  // Per-variant copies of a set's definitions point at the set's (parentPropDefId).
  const defOf = (id: string | null): Obj | undefined => (id ? defs.get(id) : undefined);
  const subDefs = new Map<string, string>();
  for (const r of records)
    for (const d of objs(r.componentPropDefs)) {
      const id = guidOf(d.id);
      const parent = guidOf(d.parentPropDefId);
      if (id && parent) subDefs.set(id, parent);
    }
  const resolveDef = (id: string | null) =>
    defOf(id ?? null) ?? defOf(id ? (subDefs.get(id) ?? null) : null);

  /** Each component set's first variant (by saved position). */
  const firstComponent = new Map<string, string>();
  for (const r of [...records].sort((a, b) => {
    const pa = str(obj(a.parentIndex)?.position) ?? "";
    const pb = str(obj(b.parentIndex)?.position) ?? "";
    return pa < pb ? -1 : pa > pb ? 1 : 0;
  })) {
    const parent = guidOf(obj(r.parentIndex)?.guid);
    if (r.type === "SYMBOL" && parent && !firstComponent.has(parent))
      firstComponent.set(parent, guidOf(r.guid) as string);
  }

  // A boolean's operands become one path with it: nothing of theirs is placed on its own.
  const operand = new Map<string, boolean>();
  const inBoolean = (g: string): boolean => {
    const known = operand.get(g);
    if (known !== undefined) return known;
    const parent = guidOf(obj(byGuid.get(g)?.parentIndex)?.guid);
    const p = parent ? byGuid.get(parent) : undefined;
    const out = !!parent && (p?.type === "BOOLEAN_OPERATION" || inBoolean(parent));
    operand.set(g, out);
    return out;
  };
  const placed = (g: string) => {
    const p = page(g);
    return p !== null && !internal.has(p) && !inBoolean(g);
  };

  // Variable collections and variables.
  for (const [g, s] of sets) {
    const modes = objs(s.variableSetModes);
    census.hit(
      {
        key: "variables/collection",
        area: "variables",
        label: "Variable collections",
        importance: "editing",
        code: CODE.variables,
        how: "a collection node of the same name in the output, with as many modes",
        check: ({ record, out, data }) => {
          const c = out.collections.get(str(record?.name) ?? "");
          if (!c) return "lost";
          return arr(c.props.modes).length === data ? "faithful" : "approximate";
        },
      },
      g,
      g,
      modes.length,
    );
    if (modes.length > 1)
      census.hit(
        {
          key: "variables/collection-modes",
          area: "variables",
          label: "Collections with more than one mode",
          importance: "editing",
          code: CODE.variables,
          how: "a collection node of the same name with the same modes",
          check: ({ record, out, data }) => {
            const c = out.collections.get(str(record?.name) ?? "");
            return c && arr(c.props.modes).length === data ? "faithful" : "lost";
          },
        },
        g,
        g,
        modes.length,
      );
    if (s.isCollectionExtendable === true)
      census.hit(
        {
          key: "variables/extendable",
          area: "variables",
          label: "Extendable collections",
          importance: "editing",
          code: CODE.variables,
          how: "a collection node of the same name",
          check: ({ record, out }) =>
            out.collections.has(str(record?.name) ?? "") ? "faithful" : "lost",
        },
        g,
      );
  }
  const variableCheck: Check = ({ record, out }) =>
    out.variables.has(str(record?.name) ?? "") ? "faithful" : "lost";
  for (const [g, v] of variables) {
    if (v.isSoftDeleted === true) continue;
    const type = str(v.variableResolvedType) ?? "UNKNOWN";
    census.hit(
      {
        key: `variables/type/${type}`,
        area: "variables",
        label: `${type} variables`,
        importance: "editing",
        code: CODE.variables,
        how: "a variable node of the same name in the output",
        check: variableCheck,
      },
      g,
    );
    const values = objs(obj(v.variableDataValues)?.entries);
    if (values.some((e) => str(obj(e.variableData)?.dataType) === "ALIAS"))
      census.hit(
        {
          key: "variables/alias",
          area: "variables",
          label: "Variables aliasing other variables",
          importance: "editing",
          code: CODE.variables,
          how: "a variable node of the same name with an alias value",
          check: ({ record, out }) => {
            const n = out.variables.get(str(record?.name) ?? "");
            return n && JSON.stringify(n.props.values ?? {}).includes('"alias"')
              ? "faithful"
              : "lost";
          },
        },
        g,
      );
    if (values.some((e) => /EXPRESSION|COMPOSE/.test(str(obj(e.variableData)?.dataType) ?? "")))
      census.hit(
        {
          key: "variables/expression",
          area: "variables",
          label: "Variables computed from expressions or composed colours",
          importance: "editing",
          code: CODE.variables,
          how: "a variable node of the same name",
          check: variableCheck,
        },
        g,
      );
    const scopes = arr(v.variableScopes);
    if (scopes.length > 0 && !(scopes.length === 1 && scopes[0] === "ALL_SCOPES"))
      census.hit(
        {
          key: "variables/scopes",
          area: "variables",
          label: "Variable scopes (where a variable may be used)",
          importance: "editing",
          code: CODE.variables,
          how: "a variable node of the same name with scopes",
          check: ({ record, out }) => {
            const n = out.variables.get(str(record?.name) ?? "");
            return !n ? "lost" : n.props.scopes ? "faithful" : "approximate";
          },
        },
        g,
      );
    if (objs(obj(v.codeSyntax)?.entries).length > 0)
      census.hit(
        {
          key: "variables/code-syntax",
          area: "variables",
          label: "Variable code syntax",
          importance: "metadata",
          code: CODE.variables,
          how: "a variable node of the same name with code syntax",
          check: ({ record, out }) => {
            const n = out.variables.get(str(record?.name) ?? "");
            return !n ? "lost" : n.props.codeSyntax ? "faithful" : "approximate";
          },
        },
        g,
      );
    if (v.isPublishable === false || v.hiddenFromPublishing === true)
      census.hit(
        {
          key: "variables/hidden",
          area: "variables",
          label: "Variables hidden from publishing",
          importance: "metadata",
          code: CODE.variables,
          how: "a variable node of the same name, marked hidden",
          check: ({ record, out }) => {
            const n = out.variables.get(str(record?.name) ?? "");
            return !n ? "lost" : n.props.hidden ? "faithful" : "approximate";
          },
        },
        g,
      );
  }

  // Styles: the definitions, and whether they're bound to variables.
  const styleBound = (s: Obj) =>
    objs(obj(s.variableConsumptionMap)?.entries).length > 0 ||
    objs(s.effects).some((e) => Object.keys(e).some((k) => k.endsWith("Var"))) ||
    objs(s.fillPaints).some((p) => p.colorVar !== undefined);
  for (const [g, s] of styles) {
    if (s.isSoftDeleted === true) continue;
    const type = str(s.styleType) as string;
    census.hit(
      {
        key: `styles/definition/${type}`,
        area: "styles",
        label: `${type.toLowerCase()} styles`,
        importance: "editing",
        code: CODE.styles,
        how:
          type === "TEXT"
            ? "a textStyle node of the same name in the output"
            : "a node for the style in the output (the model has text styles only)",
        check: ({ record, out }) =>
          type === "TEXT" && out.textStyles.has(str(record?.name) ?? "") ? "faithful" : "lost",
      },
      g,
    );
    if (styleBound(s))
      census.hit(
        {
          key: `styles/bound/${type}`,
          area: "styles",
          label: `${type.toLowerCase()} styles whose values are bound to variables`,
          importance: "editing",
          code: CODE.styles,
          how: "the style in the output, with bindings",
          check: ({ record, out }) => {
            const n = out.textStyles.get(str(record?.name) ?? "");
            return !n ? "lost" : n.props.bindings ? "faithful" : "approximate";
          },
        },
        g,
      );
  }

  // Overrides an instance saved, by the Figma id of the layer they're for.
  const keyed = new Map<string, string>();
  for (const r of records) {
    const k = guidOf(r.overrideKey);
    if (k) keyed.set(k, guidOf(r.guid) as string);
  }
  const overrideTarget = (instance: string, o: Obj): string | null => {
    const path = objs(obj(o.guidPath)?.guids).map((x) => {
      const k = guidOf(x);
      return k ? (keyed.get(k) ?? k) : null;
    });
    if (path.length === 0 || path.some((p) => !p)) return null;
    return `I${[instance, ...path].join(";")}`;
  };

  for (const r of records) {
    const g = guidOf(r.guid);
    const type = str(r.type);
    if (!g || !type || type === "VARIABLE" || type === "VARIABLE_SET" || str(r.styleType)) continue;
    if (type === "DOCUMENT" || type === "CANVAS") {
      if (type === "CANVAS" && r.isPageDivider === true)
        census.hit(
          {
            key: "meta/page-divider",
            area: "meta",
            label: "Page dividers",
            importance: "metadata",
            code: CODE.meta,
            how: "a page node in the output",
            check: exists,
          },
          g,
        );
      continue;
    }
    if (!placed(g)) continue;
    // A layer an override is for may be named in a way the output doesn't spell (soft: not judged).
    const add = (def: Omit<FeatureDef, "key"> & { key: string }, data?: unknown, target = g) =>
      census.hit(def, g, target, data, target !== g);

    // Kinds of layers.
    const shown =
      type === "FRAME" && objs(r.componentPropDefs).some((d) => d.type === "VARIANT")
        ? "COMPONENT_SET"
        : type === "FRAME" && r.resizeToFit === true && (!r.stackMode || r.stackMode === "NONE")
          ? "GROUP"
          : type;
    add({
      key: `layer/${shown}`,
      area: "layers",
      label: `${shown.toLowerCase().replace(/_/g, " ")} layers`,
      importance: "visual",
      code: CODE.geometry,
      how: "the layer in the output, as the same kind (a vector as a path)",
      check:
        shown === "COMPONENT_SET"
          ? hasProp("isComponentSet")
          : shown === "SYMBOL"
            ? hasProp("isComponent")
            : shown === "INSTANCE"
              ? kept("instanceOf")
              : shown === "BOOLEAN_OPERATION" || shown === "BRUSH" || shown === "SECTION"
                ? (i) => (i.node ? "approximate" : "lost")
                : typeCheck(shown),
    });
    if (type === "INSTANCE") {
      const symbol = guidOf(obj(r.symbolData)?.symbolID);
      if (symbol && !byGuid.has(symbol))
        add({
          key: "components/library-instance",
          area: "components",
          label: "Instances of components not in the file",
          importance: "editing",
          code: CODE.components,
          how: "the instance in the output, linked to a main",
          check: kept("instanceOf"),
        });
    }

    // Opacity, blend modes, visibility, masks, booleans.
    const opacity = num(r.opacity);
    if (opacity !== undefined && opacity < 1)
      add(
        {
          key: "layer/opacity",
          area: "layers",
          label: "Layer opacity below 100%",
          importance: "visual",
          code: CODE.geometry,
          how: "the same opacity on the layer",
          check: hasProp("opacity", (v, want) => near(v, want)),
        },
        opacity,
      );
    const blend = str(r.blendMode);
    if (blend && blend !== "NORMAL" && blend !== "PASS_THROUGH")
      add({
        key: `blend/${blend}`,
        area: "blend modes",
        label: `${blend.toLowerCase()} blend mode`,
        importance: "visual",
        code: CODE.paints,
        how: "the layer's blendMode",
        check: hasProp("blendMode", (v) => str(v)?.replace(/-/g, "_").toUpperCase() === blend),
      });
    if (r.mask === true) {
      const maskType = str(r.maskType) ?? "ALPHA";
      add({
        key: `mask/${maskType}`,
        area: "masks",
        label: `${maskType.toLowerCase()} masks`,
        importance: "visual",
        code: CODE.geometry,
        how: "isMask on the layer, with the same mask type",
        check: hasProp("isMask"),
      });
    }
    const op = str(r.booleanOperation);
    if (type === "BOOLEAN_OPERATION")
      add({
        key: `boolean/${op ?? "UNION"}`,
        area: "booleans",
        label: `${(op ?? "UNION").toLowerCase()} boolean operations`,
        importance: "editing",
        code: CODE.geometry,
        how: "a path in the output (approximate: its operands aren't kept)",
        check: (i) => (!i.node ? "lost" : i.node.type === "path" ? "approximate" : "faithful"),
      });
    if (r.locked === true)
      add({
        key: "layer/locked",
        area: "layers",
        label: "Locked layers",
        importance: "metadata",
        code: CODE.meta,
        how: "locked on the layer",
        check: hasProp("locked"),
      });

    // Effects, from the layer or the effect style it uses.
    const effectStyle = guidOf(obj(r.styleIdForEffect)?.guid);
    const style = effectStyle ? styles.get(effectStyle) : undefined;
    const effects = objs(style ? style.effects : r.effects);
    const byType = new Map<string, Obj[]>();
    for (const e of effects) {
      const t = str(e.type) ?? "UNKNOWN";
      byType.set(t, [...(byType.get(t) ?? []), e]);
    }
    for (const [t, list] of byType)
      add(
        {
          key: `effect/${t}`,
          area: "effects",
          label: `${t.toLowerCase().replace(/_/g, " ")} effects`,
          importance: "visual",
          code: CODE.effects,
          how: "the same number of effects of that kind on the layer, with the same radius, spread and offset",
          check: effectCheck(t),
        },
        list,
      );
    if (style)
      add({
        key: "styles/use/EFFECT",
        area: "styles",
        label: "Layers using an effect style",
        importance: "editing",
        code: CODE.styles,
        how: "the layer keeps a link to the style (the model has none; its effects present: approximate)",
        check: (i) =>
          !i.node
            ? "lost"
            : i.node.props.effectStyle
              ? "faithful"
              : arr(i.node.props.effects).length > 0
                ? "approximate"
                : "lost",
      });
    for (const e of effects) {
      const vars = Object.keys(e).filter((k) => k.endsWith("Var"));
      for (const v of vars)
        add(
          {
            key: `bound/effect.${v.replace(/Var$/, "")}`,
            area: "bound variables",
            label: `Effect ${v.replace(/Var$/, "")} bound to a variable${style ? " (often through a style)" : ""}`,
            importance: "visual",
            code: `${CODE.variables}; ${CODE.effects}`,
            how: "an effect of that kind on the layer (no binding key for effects: baked at best)",
            check: (i) => {
              if (!i.node) return "lost";
              const t = EFFECT_TYPES[str(obj(i.data)?.type) ?? ""];
              return objs(i.node.props.effects).some((x) => x.type === t) ? "approximate" : "lost";
            },
          },
          e,
        );
      if (e.type === "DROP_SHADOW" && e.showShadowBehindNode === false)
        add({
          key: "effect/shadow-not-behind",
          area: "effects",
          label: "Drop shadows hidden behind transparent areas",
          importance: "visual",
          code: CODE.effects,
          how: "showBehind: false on the drop shadow",
          check: (i) =>
            !i.node
              ? "lost"
              : objs(i.node.props.effects).some((x) => x.showBehind === false)
                ? "faithful"
                : "lost",
        });
      if (e.visible === false)
        add({
          key: "effect/hidden",
          area: "effects",
          label: "Hidden effects",
          importance: "editing",
          code: CODE.effects,
          how: "a hidden effect on the layer",
          check: (i) =>
            !i.node
              ? "lost"
              : objs(i.node.props.effects).some((x) => x.visible === false)
                ? "faithful"
                : "lost",
        });
      if (str(e.blendMode) && e.blendMode !== "NORMAL")
        add({
          key: "effect/blend",
          area: "effects",
          label: "Effects with a blend mode",
          importance: "visual",
          code: CODE.effects,
          how: "a blend mode on the effect",
          check: (i) =>
            !i.node
              ? "lost"
              : objs(i.node.props.effects).some((x) => x.blendMode)
                ? "faithful"
                : "lost",
        });
    }

    // Paints.
    for (const [field, list] of [
      ["fillPaints", "fills"],
      ["strokePaints", "strokes"],
    ] as const) {
      const paints = objs(r[field]);
      for (const p of paints) {
        const t = str(p.type) ?? "UNKNOWN";
        add({
          key: `paint/${list}/${t}`,
          area: "paints",
          label: `${t.toLowerCase().replace(/_/g, " ")} ${list}`,
          importance: "visual",
          code: CODE.paints,
          how: `a ${list.slice(0, -1)} of that kind on the layer`,
          check: PAINT_TYPES[t] ? paintCheck(list, t) : () => "lost",
        });
        if (p.visible === false)
          add({
            key: `paint/${list}/hidden`,
            area: "paints",
            label: `Hidden ${list}`,
            importance: "editing",
            code: CODE.paints,
            how: `a hidden ${list.slice(0, -1)} on the layer`,
            check: (i) =>
              !i.node
                ? "lost"
                : objs(i.node.props[list]).some((x) => x.visible === false)
                  ? "faithful"
                  : "lost",
          });
        if (str(p.blendMode) && p.blendMode !== "NORMAL")
          add({
            key: `paint/${list}/blend`,
            area: "paints",
            label: `${list} with a blend mode`,
            importance: "visual",
            code: CODE.paints,
            how: "a blend mode on the paint",
            check: (i) =>
              !i.node
                ? "lost"
                : objs(i.node.props[list]).some((x) => x.blendMode)
                  ? "faithful"
                  : "lost",
          });
        if (t === "IMAGE") {
          const mode = str(p.imageScaleMode) ?? "FILL";
          add({
            key: `paint/image/${mode}`,
            area: "paints",
            label: `Images, ${mode.toLowerCase()} scale mode`,
            importance: "visual",
            code: CODE.paints,
            how: "an image paint on the layer",
            check: paintCheck(list, "IMAGE"),
          });
          if (p.paintFilter || p.filterColorAdjust)
            add({
              key: "paint/image/adjustments",
              area: "paints",
              label: "Image adjustments (exposure, contrast...)",
              importance: "visual",
              code: CODE.paints,
              how: "adjustments on the image paint",
              check: (i) =>
                !i.node
                  ? "lost"
                  : objs(i.node.props[list]).some(
                        (x) => x.type === "image" && (x.filters || x.adjust),
                      )
                    ? "faithful"
                    : "lost",
            });
        }
        if (p.colorVar !== undefined)
          add({
            key: `bound/paint.${list === "fills" ? "fill" : "stroke"}`,
            area: "bound variables",
            label: `${list === "fills" ? "Fill" : "Stroke"} colour bound to a variable`,
            importance: "editing",
            code: CODE.variables,
            how: `bindings.${list === "fills" ? "fill" : "stroke"} on the layer, else the colour baked`,
            check: bound(list === "fills" ? "fill" : "stroke"),
          });
      }
    }

    // Strokes.
    if (objs(r.strokePaints).some((p) => p.visible !== false)) {
      const align = str(r.strokeAlign);
      if (align && align !== "INSIDE")
        add({
          key: `stroke/align/${align}`,
          area: "strokes",
          label: `${align.toLowerCase()} strokes`,
          importance: "visual",
          code: CODE.paints,
          how: "strokeAlign on the layer",
          check: hasProp("strokeAlign", (v) => str(v)?.toUpperCase() === align),
        });
      if (arr(r.dashPattern).length > 0)
        add({
          key: "stroke/dashes",
          area: "strokes",
          label: "Dashed strokes",
          importance: "visual",
          code: CODE.paints,
          how: "strokeDashes on the layer",
          check: hasProp("strokeDashes"),
        });
      if (r.borderStrokeWeightsIndependent === true)
        add(
          {
            key: "stroke/per-side",
            area: "strokes",
            label: "Per-side stroke widths",
            importance: "visual",
            code: CODE.paints,
            how: "strokeWeights on the layer, or one strokeWeight when every side is the same",
            check: (i) => {
              if (!i.node) return "lost";
              if (i.node.props.strokeWeights) return "faithful";
              const sides = i.data as (number | undefined)[];
              const same = sides.every((x) => near(x ?? 0, sides[0] ?? 0, 0.001));
              return same && near(i.node.props.strokeWeight ?? 1, sides[0] ?? 0)
                ? "faithful"
                : "approximate";
            },
          },
          ["borderTopWeight", "borderRightWeight", "borderBottomWeight", "borderLeftWeight"].map(
            (k) => num(r[k]) ?? num(r.strokeWeight),
          ),
        );
      const cap = str(r.strokeCap);
      if (cap && cap !== "NONE")
        add({
          key: `stroke/cap/${cap}`,
          area: "strokes",
          label: `${cap.toLowerCase().replace(/_/g, " ")} stroke caps`,
          importance: "visual",
          code: CODE.paints,
          how: "strokeCap or a marker on the layer (vectors carry caps in their path's network)",
          check: (i) =>
            !i.node
              ? "lost"
              : i.node.props.strokeCap || i.node.props.markerStart || i.node.props.markerEnd
                ? "faithful"
                : i.node.type === "path"
                  ? "approximate"
                  : "lost",
        });
      const join = str(r.strokeJoin);
      if (join && join !== "MITER")
        add({
          key: `stroke/join/${join}`,
          area: "strokes",
          label: `${join.toLowerCase()} stroke joins`,
          importance: "visual",
          code: CODE.paints,
          how: "strokeJoin on the layer",
          check: hasProp("strokeJoin"),
        });
      if (r.bordersTakeSpace === true)
        add({
          key: "layout/strokes-in-layout",
          area: "auto layout",
          label: "Strokes included in auto layout",
          importance: "visual",
          code: CODE.layout,
          how: "a property for it on the frame (the model has none)",
          check: noField("strokesIncludedInLayout"),
        });
    }

    // Corners.
    if (r.rectangleCornerRadiiIndependent === true)
      add(
        {
          key: "corners/independent",
          area: "corners",
          label: "Independent corner radii",
          importance: "visual",
          code: CODE.geometry,
          how: "cornerRadii on the layer, or one cornerRadius when every corner is the same",
          check: (i) => {
            if (!i.node) return "lost";
            if (i.node.props.cornerRadii) return "faithful";
            const corners = i.data as (number | undefined)[];
            const same = corners.every((x) => near(x ?? 0, corners[0] ?? 0, 0.001));
            return same && near(i.node.props.cornerRadius ?? 0, corners[0] ?? 0)
              ? "faithful"
              : "approximate";
          },
        },
        [
          "rectangleTopLeftCornerRadius",
          "rectangleTopRightCornerRadius",
          "rectangleBottomRightCornerRadius",
          "rectangleBottomLeftCornerRadius",
        ].map((k) => num(r[k]) ?? num(r.cornerRadius)),
      );
    const smoothing = num(r.cornerSmoothing);
    if (smoothing !== undefined && smoothing > 0)
      add({
        key: "corners/smoothing",
        area: "corners",
        label: "Corner smoothing (squircles)",
        importance: "visual",
        code: CODE.geometry,
        how: "a smoothing property on the layer (the model has none)",
        check: noField("cornerSmoothing"),
      });

    // Constraints (children of frames without auto layout).
    for (const [field, axis] of [
      ["horizontalConstraint", "constraintH"],
      ["verticalConstraint", "constraintV"],
    ] as const) {
      const c = str(r[field]);
      if (c && c !== "MIN")
        add({
          key: `constraint/${axis === "constraintH" ? "h" : "v"}/${c}`,
          area: "constraints",
          label: `${axis === "constraintH" ? "Horizontal" : "Vertical"} constraint ${c.toLowerCase()}`,
          importance: "visual",
          code: CODE.layout,
          how: `${axis} on the layer`,
          check: hasProp(axis),
        });
    }
    if (r.proportionsConstrained === true)
      add({
        key: "constraint/proportions",
        area: "constraints",
        label: "Proportions locked",
        importance: "editing",
        code: CODE.layout,
        how: "lockAspect on the layer",
        check: kept("lockAspect"),
      });

    // Auto layout and grids.
    const stack = str(r.stackMode);
    if (stack && stack !== "NONE") {
      add({
        key: `layout/${stack}`,
        area: "auto layout",
        label: `${stack.toLowerCase()} auto layout`,
        importance: "visual",
        code: CODE.layout,
        how: "layoutMode on the frame",
        check: hasProp("layoutMode"),
      });
      if (r.stackWrap === "WRAP")
        add({
          key: "layout/wrap",
          area: "auto layout",
          label: "Wrapping auto layout",
          importance: "visual",
          code: CODE.layout,
          how: "layoutWrap on the frame",
          check: hasProp("layoutWrap"),
        });
      const counter = str(r.stackCounterAlignItems);
      if (counter === "BASELINE")
        add({
          key: "layout/baseline",
          area: "auto layout",
          label: "Baseline alignment",
          importance: "visual",
          code: CODE.layout,
          how: "alignItems baseline on the frame",
          check: hasProp("alignItems", (v) => v === "baseline"),
        });
      const primary = str(r.stackPrimaryAlignItems);
      if (primary === "SPACE_BETWEEN" || primary === "SPACE_EVENLY")
        add({
          key: `layout/spacing/${primary}`,
          area: "auto layout",
          label: `Spacing mode ${primary.toLowerCase().replace(/_/g, " ")}`,
          importance: "visual",
          code: CODE.layout,
          how: "justifyContent on the frame",
          check: hasProp("justifyContent", (v) => v === "space-between"),
        });
      if (num(r.stackCounterSpacing) !== undefined && r.stackWrap === "WRAP")
        add({
          key: "layout/row-gap",
          area: "auto layout",
          label: "Gap between wrapped rows",
          importance: "visual",
          code: CODE.layout,
          how: "rowGap on the frame",
          check: hasProp("rowGap"),
        });
      if (r.stackReverseZIndex === true)
        add({
          key: "layout/reverse-z",
          area: "auto layout",
          label: "Canvas stacking: first on top",
          importance: "visual",
          code: CODE.layout,
          how: "a property for it on the frame (the model has none)",
          check: noField("reverseZIndex"),
        });
      if (stack === "GRID") {
        add({
          key: "grid/tracks",
          area: "grid layout",
          label: "Grid tracks",
          importance: "visual",
          code: CODE.layout,
          how: "gridColumns or gridRows on the frame",
          check: (i) =>
            !i.node
              ? "lost"
              : i.node.props.gridColumns || i.node.props.gridRows
                ? "faithful"
                : "lost",
        });
      }
    }
    if (r.stackPositioning === "ABSOLUTE")
      add({
        key: "layout/absolute",
        area: "auto layout",
        label: "Absolutely positioned children",
        importance: "visual",
        code: CODE.layout,
        how: "positioning absolute on the layer",
        check: hasProp("positioning", (v) => v === "absolute"),
      });
    for (const [field, w, h] of [
      ["minSize", "minWidth", "minHeight"],
      ["maxSize", "maxWidth", "maxHeight"],
    ] as const) {
      const size = obj(r[field]);
      if (!size) continue;
      for (const [axis, prop] of [
        ["x", w],
        ["y", h],
      ] as const) {
        const v = num(size[axis]);
        if (v === undefined || v <= 0 || v >= 1e9) continue;
        add(
          {
            key: `layout/${prop}`,
            area: "auto layout",
            label: `${prop.replace(/([A-Z])/g, " $1").toLowerCase()}`,
            importance: "visual",
            code: CODE.layout,
            how: `${prop} on the layer`,
            check: hasProp(prop, (x, want) => near(x, want)),
          },
          v,
        );
      }
    }
    if (r.gridRowAnchor || r.gridColumnAnchor || num(r.gridColumnSpan) || num(r.gridRowSpan))
      add({
        key: "grid/placement",
        area: "grid layout",
        label: "Grid children placed in cells (anchors, spans)",
        importance: "visual",
        code: CODE.layout,
        how: "gridArea on the layer",
        check: kept("gridArea"),
      });
    if (arr(r.layoutGrids).length > 0)
      add({
        key: "grid/layout-grids",
        area: "grid layout",
        label: "Layout grids (columns, rows, pixel grid)",
        importance: "editing",
        code: CODE.layout,
        how: "layoutGrids on the frame",
        check: hasProp("layoutGrids"),
      });
    if (arr(r.guides).length > 0)
      add({
        key: "meta/guides",
        area: "meta",
        label: "Ruler guides",
        importance: "metadata",
        code: CODE.meta,
        how: "rulerGuides on the frame",
        check: noField("rulerGuides"),
      });
    if (
      r.frameMaskDisabled === false &&
      (type === "FRAME" || type === "SYMBOL" || type === "INSTANCE")
    )
      add({
        key: "layer/clips",
        area: "layers",
        label: "Frames clipping their content",
        importance: "visual",
        code: CODE.geometry,
        how: "clipContent on the frame",
        check: (i) => (!i.node ? "lost" : i.node.props.clipContent === false ? "lost" : "faithful"),
      });

    // Text.
    if (type === "TEXT") {
      const fontName = obj(r.fontName);
      const family = str(fontName?.family) ?? "?";
      const fstyle = str(fontName?.style) ?? "Regular";
      const textStyle = styles.get(guidOf(obj(r.styleIdForText)?.guid) ?? "");
      const famBound = [r, ...(textStyle ? [textStyle] : [])].some((x) =>
        objs(obj(x.variableConsumptionMap)?.entries).some(
          (e) => e.variableField === "FONT_FAMILY" || e.variableField === "FONT_STYLE",
        ),
      );
      add(
        {
          key: `font/${family}/${fstyle}`,
          area: "fonts",
          label: `${family} ${fstyle}`,
          importance: "visual",
          code: CODE.text,
          how: "the same family, weight and italic on the text layer (layers whose font is bound to a variable, themselves or through their text style, aren't judged: a mode may change it)",
          check: (i) => {
            if (!i.node) return "lost";
            if (i.data === "bound") return null;
            const want = styleWeight(fstyle);
            const p = i.node.props;
            const same =
              (str(p.fontFamily) ?? "Instrument Sans") === family &&
              (num(p.fontWeight) ?? 400) === want.weight &&
              (p.fontStyle === "italic") === want.italic;
            return same ? "faithful" : "approximate";
          },
        },
        famBound ? "bound" : undefined,
      );
      const textCase = str(r.textCase);
      if (textCase && textCase !== "ORIGINAL")
        add({
          key: `text/case/${textCase}`,
          area: "text",
          label: `Text case ${textCase.toLowerCase().replace(/_/g, " ")}`,
          importance: "visual",
          code: CODE.text,
          how: "textCase on the layer (small caps have no value in the model)",
          check: hasProp("textCase"),
        });
      const decoration = str(r.textDecoration);
      if (decoration && decoration !== "NONE")
        add({
          key: `text/decoration/${decoration}`,
          area: "text",
          label: `Text ${decoration.toLowerCase()}`,
          importance: "visual",
          code: CODE.text,
          how: "textDecoration on the layer",
          check: hasProp("textDecoration"),
        });
      if (num(r.textUnderlineOffset) !== undefined || num(r.textDecorationThickness) !== undefined)
        add({
          key: "text/decoration-geometry",
          area: "text",
          label: "Underline offset or thickness",
          importance: "visual",
          code: CODE.text,
          how: "a property for it on the layer (the model has none)",
          check: noField("textUnderlineOffset"),
        });
      if (r.textDecorationSkipInk === false)
        add({
          key: "text/no-skip-ink",
          area: "text",
          label: "Underlines that don't skip descenders",
          importance: "visual",
          code: CODE.text,
          how: "a property for it on the layer (the model has none)",
          check: noField("textDecorationSkipInk"),
        });
      const features = Object.keys(r).filter(
        (k) => FONT_STYLE_FIELD.test(k) && k !== "fontVariations" && r[k] !== undefined,
      );
      const defaults: Obj = {
        fontVariantCommonLigatures: true,
        fontVariantContextualLigatures: true,
      };
      for (const f of features)
        if (r[f] !== defaults[f] && !(Array.isArray(r[f]) && arr(r[f]).length === 0))
          add({
            key: `text/opentype/${f}`,
            area: "text",
            label: `OpenType: ${f.replace(/^fontVariant/, "")}`,
            importance: "visual",
            code: CODE.text,
            how: "fontFeatures on the layer",
            check: kept("fontFeatures"),
          });
      for (const f of arr(r.toggledOnOTFeatures).concat(arr(r.toggledOffOTFeatures)))
        add({
          key: `text/opentype/${String(f)}`,
          area: "text",
          label: `OpenType feature ${String(f)}`,
          importance: "visual",
          code: CODE.text,
          how: "fontFeatures on the layer",
          check: kept("fontFeatures"),
        });
      if (arr(r.fontVariations).length > 0)
        add({
          key: "text/variable-axes",
          area: "text",
          label: "Variable font axes",
          importance: "visual",
          code: CODE.text,
          how: "fontVariations on the layer",
          check: kept("fontVariations"),
        });
      if (r.textTruncation === "ENDING")
        add({
          key: "text/truncation",
          area: "text",
          label: "Truncated text (ellipsis)",
          importance: "visual",
          code: CODE.text,
          how: "maxLines on the layer",
          check: kept("maxLines"),
        });
      const autoResize = str(r.textAutoResize) ?? "NONE";
      add({
        key: `text/resize/${autoResize}`,
        area: "text",
        label: `Text sizing ${autoResize.toLowerCase().replace(/_/g, " ")}`,
        importance: "visual",
        code: CODE.text,
        how: "textAutoResize on the layer matching",
        check: (i) => {
          if (!i.node) return "lost";
          const v = str(i.node.props.textAutoResize) ?? "width";
          const want =
            autoResize === "WIDTH_AND_HEIGHT"
              ? "width"
              : autoResize === "HEIGHT"
                ? "height"
                : "none";
          return v === want || autoResize === "TRUNCATE" ? "faithful" : "approximate";
        },
      });
      const lineHeight = obj(r.lineHeight);
      if (lineHeight?.units === "PERCENT")
        add({
          key: "text/line-height-percent",
          area: "text",
          label: "Line height in percent",
          importance: "visual",
          code: CODE.text,
          how: "lineHeight on the layer",
          check: hasProp("lineHeight"),
        });
      const textData = obj(r.textData);
      const lines = objs(textData?.lines);
      for (const kind of ["ORDERED_LIST", "UNORDERED_LIST"])
        if (lines.some((l) => l.lineType === kind))
          add({
            key: `text/list/${kind}`,
            area: "text",
            label: `${kind === "ORDERED_LIST" ? "Numbered" : "Bulleted"} lists`,
            importance: "visual",
            code: CODE.text,
            how: "listType on the layer or its runs",
            check: (i) =>
              !i.node
                ? "lost"
                : i.node.props.listType ||
                    JSON.stringify(i.node.props.textRuns ?? []).includes("listType")
                  ? "faithful"
                  : "lost",
          });
      if (objs(textData?.styleOverrideTable).length > 0)
        add({
          key: "text/styled-runs",
          area: "text",
          label: "Styled stretches of text",
          importance: "visual",
          code: CODE.text,
          how: "textRuns on the layer",
          check: kept("textRuns"),
        });
      if (r.hyperlink || objs(textData?.styleOverrideTable).some((s) => s.hyperlink))
        add({
          key: "text/hyperlink",
          area: "text",
          label: "Hyperlinks in text",
          importance: "editing",
          code: CODE.text,
          how: "a link on the layer or its runs",
          check: (i) =>
            !i.node
              ? "lost"
              : JSON.stringify(i.node.props).includes('"link"')
                ? "faithful"
                : "lost",
        });
      if (r.leadingTrim === "CAP_HEIGHT")
        add({
          key: "text/vertical-trim",
          area: "text",
          label: "Vertical trim (cap height to baseline)",
          importance: "visual",
          code: CODE.text,
          how: "leadingTrim on the layer",
          check: hasProp("leadingTrim"),
        });
      if (num(r.paragraphSpacing))
        add({
          key: "text/paragraph-spacing",
          area: "text",
          label: "Paragraph spacing",
          importance: "visual",
          code: CODE.text,
          how: "paragraphSpacing on the layer",
          check: hasProp("paragraphSpacing"),
        });
      if (num(r.paragraphIndent))
        add({
          key: "text/paragraph-indent",
          area: "text",
          label: "Paragraph indent",
          importance: "visual",
          code: CODE.text,
          how: "a property for it on the layer (the model has none)",
          check: noField("paragraphIndent"),
        });
      if (str(r.styleIdForText) || guidOf(obj(r.styleIdForText)?.guid))
        add({
          key: "styles/use/TEXT",
          area: "styles",
          label: "Text layers using a text style",
          importance: "editing",
          code: CODE.styles,
          how: "textStyle on the layer, else the style's values baked",
          check: kept("textStyle"),
        });
    }
    if (guidOf(obj(r.styleIdForFill)?.guid) || guidOf(obj(r.styleIdForStrokeFill)?.guid))
      add({
        key: "styles/use/FILL",
        area: "styles",
        label: "Layers using a colour style",
        importance: "editing",
        code: CODE.styles,
        how: "a link to the style on the layer (the model has none), else the colour baked",
        check: (i) => (!i.node ? "lost" : "approximate"),
      });
    if (guidOf(obj(r.styleIdForGrid)?.guid))
      add({
        key: "styles/use/GRID",
        area: "styles",
        label: "Frames using a grid style",
        importance: "editing",
        code: CODE.styles,
        how: "layoutGrids on the frame, else lost",
        check: kept("layoutGrids"),
      });

    // Vectors.
    if (type === "VECTOR") {
      const network = obj(r.vectorData);
      if (network && obj(network.styleOverrideTable))
        add({
          key: "vector/region-styles",
          area: "vectors",
          label: "Vector networks with per-region fills",
          importance: "visual",
          code: CODE.geometry,
          how: "the path in the output (regions merged: approximate)",
          check: (i) => (i.node ? "approximate" : "lost"),
        });
    }
    if (obj(r.arcData) && type === "ELLIPSE") {
      const a = obj(r.arcData) as Obj;
      const full =
        near(a.startingAngle, 0, 0.001) &&
        near(a.endingAngle, Math.PI * 2, 0.001) &&
        near(a.innerRadius, 0, 0.001);
      if (!full)
        add({
          key: "vector/arc",
          area: "vectors",
          label: "Arcs, rings and pie slices",
          importance: "visual",
          code: CODE.geometry,
          how: "a path in the output (approximate: not an editable arc)",
          check: (i) => (!i.node ? "lost" : i.node.type === "ellipse" ? "lost" : "approximate"),
        });
    }

    // Variables bound to the layer's own fields, and the modes it sets.
    for (const e of objs(obj(r.variableConsumptionMap)?.entries)) {
      const field = str(e.variableField) ?? "UNKNOWN";
      add({
        key: `bound/${field}`,
        area: "bound variables",
        label: `${field.toLowerCase().replace(/_/g, " ")} bound to a variable`,
        importance: "editing",
        code: CODE.variables,
        how: BINDING_FOR[field]
          ? `bindings.${BINDING_FOR[field]} on the layer, else the value baked`
          : `no binding key for it: the value baked into ${VALUE_FOR[field] ?? "the layer"} at best`,
        check: bound(field),
      });
    }
    const textRuns = objs(obj(r.textData)?.styleOverrideTable);
    for (const run of textRuns)
      for (const e of objs(obj(run.variableConsumptionMap)?.entries)) {
        const field = str(e.variableField) ?? "UNKNOWN";
        add({
          key: `bound/text-run.${field}`,
          area: "bound variables",
          label: `${field.toLowerCase().replace(/_/g, " ")} bound in a stretch of text`,
          importance: "editing",
          code: CODE.variables,
          how: "a binding in the layer's runs, else the value baked",
          check: (i) =>
            !i.node
              ? "lost"
              : JSON.stringify(i.node.props.textRuns ?? []).includes("bindings")
                ? "faithful"
                : "approximate",
        });
      }
    const modes = objs(obj(r.variableModeBySetMap)?.entries);
    if (modes.length > 0)
      add(
        {
          key: "variables/explicit-mode",
          area: "variables",
          label: "Frames setting a collection's mode",
          importance: "visual",
          code: CODE.variables,
          how: "variableModes on the frame, else the mode applied into baked values (approximate)",
          check: (i) =>
            !i.node ? "lost" : i.node.props.variableModes ? "faithful" : "approximate",
        },
        modes.map((m) => sets.get(guidOf(obj(m.variableSetID)?.guid) ?? "")?.name),
      );

    // Component properties: definitions, references, assignments.
    for (const d of objs(r.componentPropDefs)) {
      const dt = str(d.type);
      if (!dt) continue;
      const name = str(d.name) ?? "";
      const isSet = shown === "COMPONENT_SET";
      void isSet;
      add(
        {
          key: `props/definition/${dt}`,
          area: "component properties",
          label: `${dt.toLowerCase().replace(/_/g, " ")} component properties`,
          importance: "editing",
          code: CODE.componentProps,
          how:
            dt === "VARIANT"
              ? "every variant of the set carries the property in variantProps"
              : "the component (or set) in the output carries the property's name outside its name and text",
          check: (i) => {
            if (!i.node) return "lost";
            if (dt === "VARIANT")
              return obj(i.node.props.variantProps)?.[String(i.data)] !== undefined
                ? "faithful"
                : "lost";
            return carries(i.node, String(i.data)) ? "faithful" : "lost";
          },
        },
        name,
        // A variant property is carried by each variant: look at the set's first component.
        dt === "VARIANT" && isSet ? (firstComponent.get(g) ?? g) : g,
      );
    }
    for (const ref of objs(r.componentPropRefs)) {
      if (ref.isDeleted === true) continue;
      const field = str(ref.componentPropNodeField) ?? "UNKNOWN";
      const def = resolveDef(guidOf(ref.defID));
      add(
        {
          key: `props/reference/${field}`,
          area: "component properties",
          label: `Layers driven by a property (${field.toLowerCase().replace(/_/g, " ")})`,
          importance: "editing",
          code: CODE.componentProps,
          how: "the layer carries a link to the property (its name) in the output",
          check: (i) =>
            !i.node ? "lost" : carries(i.node, String(i.data ?? "\u0000")) ? "faithful" : "lost",
        },
        str(def?.name),
      );
    }
    for (const a of objs(r.componentPropAssignments)) {
      const def = resolveDef(guidOf(a.defID));
      const dt = str(def?.type) ?? "UNKNOWN";
      add({
        key: `props/assignment/${dt}`,
        area: "component properties",
        label: `Instances setting a ${dt.toLowerCase().replace(/_/g, " ")} property`,
        importance: "editing",
        code: CODE.componentProps,
        how: "the instance in the output, its value applied to its copy (approximate: no property to change)",
        check: (i) => (!i.node ? "lost" : i.node.props.componentProps ? "faithful" : "approximate"),
      });
    }

    // Overrides an instance saves for layers inside it.
    if (type === "INSTANCE") {
      for (const o of objs(obj(r.symbolData)?.symbolOverrides)) {
        const target = overrideTarget(g, o);
        if (!target) continue;
        for (const e of objs(obj(o.variableConsumptionMap)?.entries)) {
          const field = str(e.variableField) ?? "UNKNOWN";
          add(
            {
              key: `bound/override.${field}`,
              area: "bound variables",
              label: `${field.toLowerCase().replace(/_/g, " ")} bound in an instance's override`,
              importance: "editing",
              code: CODE.variables,
              how: BINDING_FOR[field]
                ? `bindings.${BINDING_FOR[field]} on the overridden layer, else the value baked`
                : "no binding key for it: the value baked at best",
              check: bound(field),
            },
            undefined,
            target,
          );
        }
        for (const p of [...objs(o.fillPaints), ...objs(o.strokePaints)])
          if (p.colorVar !== undefined)
            add(
              {
                key: "bound/override.paint",
                area: "bound variables",
                label: "Paint colour bound in an instance's override",
                importance: "editing",
                code: CODE.variables,
                how: "bindings.fill or stroke on the overridden layer, else the colour baked",
                check: (i) =>
                  !i.node
                    ? "lost"
                    : obj(i.node.props.bindings)?.fill || obj(i.node.props.bindings)?.stroke
                      ? "faithful"
                      : "approximate",
              },
              undefined,
              target,
            );
      }
    }

    // Prototype, export, dev mode, plugins.
    for (const pi of objs(r.prototypeInteractions)) {
      if (pi.isDeleted === true) continue;
      const trigger = str(obj(pi.event)?.interactionType) ?? "UNKNOWN";
      for (const action of objs(pi.actions)) {
        const nav = str(action.navigationType) ?? str(action.connectionType) ?? "UNKNOWN";
        add({
          key: `prototype/${trigger}/${nav}`,
          area: "prototype",
          label: `Prototype: ${trigger.toLowerCase().replace(/_/g, " ")} → ${nav.toLowerCase().replace(/_/g, " ")}`,
          importance: "editing",
          code: CODE.prototype,
          how: "reactions on the layer",
          check: hasProp("reactions"),
        });
      }
    }
    if (str(r.scrollDirection) && r.scrollDirection !== "NONE")
      add({
        key: "prototype/scroll",
        area: "prototype",
        label: "Scrolling frames (prototype overflow)",
        importance: "metadata",
        code: CODE.prototype,
        how: "a scroll property on the frame (the model has none)",
        check: noField("overflow"),
      });
    for (const e of objs(r.exportSettings))
      add({
        key: `export/${str(e.imageType) ?? "UNKNOWN"}`,
        area: "export",
        label: `Export settings: ${str(e.imageType) ?? "?"}`,
        importance: "metadata",
        code: CODE.meta,
        how: "export settings on the layer (the model has none)",
        check: noField("exportSettings"),
      });
    if (r.pluginData || r.pluginRelaunchData)
      add({
        key: "meta/plugin-data",
        area: "meta",
        label: "Plugin data",
        importance: "metadata",
        code: CODE.meta,
        how: "plugin data on the layer (the model has none)",
        check: noField("pluginData"),
      });
    if (r.sectionStatusInfo || r.handoffStatusMap)
      add({
        key: "meta/dev-status",
        area: "meta",
        label: "Dev mode status (ready for dev)",
        importance: "metadata",
        code: CODE.meta,
        how: "a status on the layer (the model has none)",
        check: noField("devStatus"),
      });
    if (arr(r.annotations).length > 0)
      add({
        key: "meta/annotations",
        area: "meta",
        label: "Dev mode annotations",
        importance: "metadata",
        code: CODE.meta,
        how: "annotations on the layer (the model has none)",
        check: noField("annotations"),
      });
    if (str(r.symbolDescription) || str(r.description)) {
      if (type === "SYMBOL" || shown === "COMPONENT_SET")
        add({
          key: "components/description",
          area: "components",
          label: "Component descriptions",
          importance: "editing",
          code: CODE.components,
          how: "componentDescription on the component",
          check: hasProp("componentDescription"),
        });
    }
    if (objs(r.symbolLinks).length > 0)
      add({
        key: "components/links",
        area: "components",
        label: "Component documentation links",
        importance: "metadata",
        code: CODE.components,
        how: "a link on the component (the model has none)",
        check: noField("documentationLinks"),
      });
  }
  // Who uses each variable, collection and style: every alias a record (or its overrides,
  // runs, paints and effects) holds, every style it links, then along aliases between variables.
  const aliases = (value: unknown, out: Set<string>, depth = 0): Set<string> => {
    if (depth > 12 || !value || typeof value !== "object") return out;
    if (Array.isArray(value)) {
      for (const v of value) aliases(v, out, depth + 1);
      return out;
    }
    const o = value as Obj;
    const alias = guidOf(obj(o.alias)?.guid);
    if (alias) out.add(alias);
    for (const [k, v] of Object.entries(o))
      if (k !== "derivedTextData" && k !== "vectorData" && k !== "derivedSymbolData")
        aliases(v, out, depth + 1);
    return out;
  };
  for (const r of records) {
    const g = guidOf(r.guid);
    if (!g || r.type === "VARIABLE" || r.type === "VARIABLE_SET" || str(r.styleType)) continue;
    if (!placed(g)) continue;
    const used = aliases(
      [r.variableConsumptionMap, r.fillPaints, r.strokePaints, r.effects, r.textData, r.symbolData],
      new Set(),
    );
    for (const v of used) census.consume(v, g);
    for (const k of [
      "styleIdForText",
      "styleIdForEffect",
      "styleIdForFill",
      "styleIdForStrokeFill",
      "styleIdForGrid",
    ]) {
      const sg = guidOf(obj(r[k])?.guid);
      if (sg) {
        census.consume(sg, g);
        // A style's own bindings reach the layers using it.
        const st = styles.get(sg);
        if (st)
          for (const v of aliases(
            [st.variableConsumptionMap, st.fillPaints, st.effects],
            new Set(),
          ))
            census.consume(v, g);
      }
    }
  }
  // Along aliases: a variable another one aliases reaches that one's layers.
  const aliasOf = new Map<string, Set<string>>();
  for (const [g, v] of variables) aliasOf.set(g, aliases(v.variableDataValues, new Set()));
  const reached = new Set<string>();
  const spread = (from: string, layers: Set<string>, depth: number) => {
    if (depth > 8) return;
    for (const to of aliasOf.get(from) ?? []) {
      const key = `${from}>${to}`;
      if (reached.has(key) && depth > 0) continue;
      reached.add(key);
      for (const l of layers) census.consume(to, l);
      spread(to, layers, depth + 1);
    }
  };
  for (const g of variables.keys()) {
    const layers = census.consumers.get(g);
    if (layers) spread(g, new Set(layers), 0);
  }
  // A collection reaches what its variables do.
  for (const [g, v] of variables) {
    const set = guidOf(obj(v.variableSetID)?.guid);
    if (set) for (const l of census.consumers.get(g) ?? []) census.consume(set, l);
  }
  for (const r of records)
    if (r.type === "SYMBOL") {
      const parent = guidOf(obj(r.parentIndex)?.guid);
      if (parent)
        census.variants.set(parent, [
          ...(census.variants.get(parent) ?? []),
          guidOf(r.guid) as string,
        ]);
    }
  return { pageOf };
}

// ---------------------------------------------------------------------------
// Overrides a copy lists, against the overrides Figma saved for it

export interface OverrideNoise {
  /** Copies (layers inside instances) listing any override. */
  readonly copiesWithOverrides: number;
  /** Override names listed, by name: how many, and how many Figma saved an override for. */
  readonly byName: readonly { name: string; listed: number; explained: number }[];
  readonly listed: number;
  readonly unexplained: number;
  readonly examples: readonly { id: string; unexplained: readonly string[] }[];
}

/** Every instance's saved overrides, by the Figma id of the layer they're for: their fields. */
function savedOverrides(records: readonly Obj[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const r of records) {
    if (r.type !== "INSTANCE") continue;
    const g = guidOf(r.guid) as string;
    for (const o of objs(obj(r.symbolData)?.symbolOverrides)) {
      const path = objs(obj(o.guidPath)?.guids).map((x) => guidOf(x));
      if (path.length === 0 || path.some((p) => !p)) continue;
      const id = `I${[g, ...path].join(";")}`;
      const fields = out.get(id) ?? new Set<string>();
      for (const k of Object.keys(o)) if (k !== "guidPath") fields.add(k);
      out.set(id, fields);
    }
    // Property values the instance sets reach its own layers.
    if (objs(r.componentPropAssignments).length > 0) {
      const fields = out.get(g) ?? new Set<string>();
      fields.add("componentPropAssignments");
      out.set(g, fields);
    }
  }
  return out;
}

/** "fI1-2_3-4" → "I1:2;3:4" (null for a shortened id). */
export function figmaIdOf(drawpane: string): string | null {
  if (!drawpane.startsWith("f")) return null;
  const body = drawpane.slice(1);
  if (!/^I?[0-9]+-[0-9]+(_[0-9]+-[0-9]+)*$/.test(body)) return null;
  return body.replace(/-/g, ":").replace(/_/g, ";");
}

// ---------------------------------------------------------------------------
// Putting it together

export interface Coverage {
  readonly createdAt: string;
  readonly records: number;
  readonly output: Omit<OutputFacts, "collections" | "variables" | "textStyles"> & {
    readonly collections: number;
    readonly variables: number;
    readonly textStyles: number;
  };
  readonly overrides: OverrideNoise;
  readonly features: readonly FeatureResult[];
}

/**
 * Lines of JSON, one node each, as `convert.ts` writes them. Split on "\n"
 * only: text can hold U+2028 and U+2029, which JSON leaves as they are and
 * Node's readline would break lines on.
 */
export async function* readNodes(file: string): AsyncGenerator<OutNode> {
  let rest = "";
  for await (const chunk of createReadStream(file, { encoding: "utf8" })) {
    const text = rest + (chunk as string);
    let at = 0;
    for (let end = text.indexOf("\n"); end >= 0; end = text.indexOf("\n", at)) {
      const line = text.slice(at, end);
      at = end + 1;
      if (line.trim()) yield JSON.parse(line) as OutNode;
    }
    rest = text.slice(at);
  }
  if (rest.trim()) yield JSON.parse(rest) as OutNode;
}

/**
 * The coverage of a .fig's features by its converted output (`nodesFile`:
 * lines of JSON, as `convert.ts` writes them).
 */
export async function coverage(
  fig: Uint8Array,
  nodesFile: string,
  options: CensusOptions = {},
  log: (line: string) => void = console.log,
): Promise<Coverage> {
  const parsed = parseFigBuffer(fig.slice().buffer as ArrayBuffer);
  const records = parsed.nodeChanges.filter((r) => r.phase !== "REMOVED") as unknown as Obj[];
  return measureCoverage(records, readNodes(nodesFile), options, log);
}

/** The coverage of these records (a .fig's, parsed) by these converted nodes. */
export async function measureCoverage(
  records: readonly Obj[],
  output: AsyncIterable<OutNode> | Iterable<OutNode>,
  options: CensusOptions = {},
  log: (line: string) => void = () => {},
): Promise<Coverage> {
  const maxChecks = options.maxChecks ?? 20_000;
  log(`  ${records.length} records`);
  const found = new Census();
  census(records, found);
  const overridesSaved = savedOverrides(records);
  const byGuid = new Map<string, Obj>();
  for (const r of records) {
    const g = guidOf(r.guid);
    if (g) byGuid.set(g, r);
  }
  log(`  ${found.features.size} features found`);

  // What to look up: every hit checked, by Drawpane id.
  const wanted = new Set<string>();
  for (const acc of found.features.values())
    for (const hit of acc.hits.slice(0, maxChecks)) wanted.add(drawpaneId(hit.target));

  // One pass over the output.
  const nodes = new Map<string, OutNode>();
  const copies = new Map<string, number>();
  /** Instances of each main, by its Drawpane id. */
  const instancesOf = new Map<string, number>();
  const types: Record<string, number> = {};
  const bindingKeys: Record<string, number> = {};
  const collections = new Map<string, OutNode>();
  const variables = new Map<string, OutNode>();
  const textStyles = new Map<string, OutNode>();
  let count = 0;
  let withBindings = 0;
  let withVariableModes = 0;
  let withReactions = 0;
  let componentSets = 0;
  let components = 0;
  let instances = 0;
  let copyCount = 0;
  const noise = new Map<string, { listed: number; explained: number }>();
  let copiesWithOverrides = 0;
  let unexplained = 0;
  let listed = 0;
  const noiseExamples: { id: string; unexplained: string[] }[] = [];
  for await (const n of output) {
    count++;
    types[n.type] = (types[n.type] ?? 0) + 1;
    if (wanted.has(n.id)) nodes.set(n.id, n);
    const p = n.props;
    const bindings = obj(p.bindings);
    if (bindings) {
      withBindings++;
      for (const k of Object.keys(bindings)) bindingKeys[k] = (bindingKeys[k] ?? 0) + 1;
    }
    if (p.variableModes) withVariableModes++;
    if (arr(p.reactions).length > 0) withReactions++;
    if (p.isComponentSet) componentSets++;
    if (p.isComponent) components++;
    if (p.instanceOf) {
      instances++;
      const main = String(p.instanceOf);
      instancesOf.set(main, (instancesOf.get(main) ?? 0) + 1);
    }
    if (n.type === "collection") collections.set(str(p.name) ?? "", n);
    if (n.type === "variable") variables.set(str(p.name) ?? "", n);
    if (n.type === "textStyle") textStyles.set(str(p.name) ?? "", n);
    const figmaId = figmaIdOf(n.id);
    if (figmaId) {
      const last = figmaId.slice(figmaId.lastIndexOf(";") + 1).replace(/^I/, "");
      copies.set(last, (copies.get(last) ?? 0) + 1);
    }
    if (figmaId?.startsWith("I")) {
      copyCount++;
      const over = arr(p.overrides).map(String);
      if (over.length > 0) {
        copiesWithOverrides++;
        // Figma's saved overrides for this layer: under its own instance path, or any shorter one.
        const parts = figmaId.slice(1).split(";");
        const fields = new Set<string>();
        for (let k = 0; k < parts.length; k++) {
          const id = `I${parts.slice(k).join(";")}`;
          for (const f of overridesSaved.get(id) ?? []) fields.add(f);
        }
        if (p.instanceOf)
          for (const f of overridesSaved.get(parts.at(-1) ?? "") ?? []) fields.add(f);
        const missing: string[] = [];
        for (const name of over) {
          const entry = noise.get(name) ?? { listed: 0, explained: 0 };
          entry.listed++;
          listed++;
          const ok = (OVERRIDE_FIELDS[name] ?? [name]).some((f) => fields.has(f));
          if (ok) entry.explained++;
          else missing.push(name);
          noise.set(name, entry);
        }
        unexplained += missing.length;
        if (missing.length > 0 && noiseExamples.length < 20)
          noiseExamples.push({ id: figmaId, unexplained: missing });
      }
    }
  }
  log(`  output: ${count} nodes, ${nodes.size} looked up`);
  const out: OutputFacts = {
    nodes: count,
    types,
    collections,
    variables,
    textStyles,
    withBindings,
    bindingKeys,
    withVariableModes,
    withReactions,
    componentSets,
    components,
    instances,
    copies: copyCount,
  };

  /**
   * The layers of the output a feature on `owner` reaches: a layer once for itself and once per
   * copy; a variable, collection or style every layer using it (and their copies); a component
   * property definition the instances of its component (or of the set's variants).
   */
  const own = (g: string) => Math.max(1, copies.get(g) ?? 0);
  /** Features whose owners are variables, collections or styles: they reach the layers using them. */
  const byUse = (key: string) =>
    (key.startsWith("variables/") && key !== "variables/explicit-mode") ||
    key.startsWith("styles/definition") ||
    key.startsWith("styles/bound");
  const reach = (owner: string, key: string): number => {
    if (!key.startsWith("props/definition")) return own(owner);
    const mains = [owner, ...(found.variants.get(owner) ?? [])];
    return Math.max(
      1,
      mains.reduce((sum, m) => sum + (instancesOf.get(drawpaneId(m)) ?? 0), 0),
    );
  };

  const results: FeatureResult[] = [];
  for (const acc of found.features.values()) {
    const tally = { faithful: 0, approximate: 0, lost: 0, absent: 0, checked: 0, unresolved: 0 };
    const failing: string[] = [];
    for (const hit of acc.hits.slice(0, maxChecks)) {
      const node = nodes.get(drawpaneId(hit.target));
      if (!node && hit.soft) {
        tally.unresolved++;
        continue;
      }
      const outcome = acc.def.check({
        node,
        record: byGuid.get(hit.owner),
        data: hit.data,
        out,
      });
      if (outcome === null) continue;
      tally.checked++;
      tally[outcome]++;
      if (!node && outcome === "lost") tally.absent++;
      if (outcome !== "faithful" && failing.length < 10) failing.push(hit.target);
    }
    let layers = 0;
    if (byUse(acc.def.key)) {
      // Each layer once, however many of the feature's variables or styles it uses.
      const users = new Set<string>();
      for (const owner of acc.records)
        for (const u of found.consumers.get(owner) ?? []) users.add(u);
      for (const u of users) layers += own(u);
      layers = Math.max(layers, acc.records.size);
    } else for (const owner of acc.records) layers += reach(owner, acc.def.key);
    const { checked } = tally;
    const gap = checked === 0 ? 0 : (tally.lost + tally.approximate / 2) / checked;
    const status: FeatureResult["status"] =
      checked === 0
        ? "unchecked"
        : tally.faithful / checked >= 0.95
          ? "faithful"
          : tally.lost / checked >= 0.5
            ? "lost"
            : "approximate";
    results.push({
      key: acc.def.key,
      area: acc.def.area,
      label: acc.def.label,
      importance: acc.def.importance,
      code: acc.def.code,
      how: acc.def.how,
      records: acc.records.size,
      uses: acc.uses,
      layers,
      checked,
      faithful: tally.faithful,
      approximate: tally.approximate,
      lost: tally.lost,
      absent: tally.absent,
      unresolved: tally.unresolved,
      status,
      gap: Math.round(gap * 1000) / 1000,
      impact: Math.round(layers * WEIGHT[acc.def.importance] * gap),
      examples: [...new Set(acc.hits.slice(0, 50).map((h) => h.target))].slice(0, 3),
      failing,
    });
  }
  results.sort((a, b) => b.impact - a.impact || b.layers - a.layers || (a.key < b.key ? -1 : 1));

  return {
    createdAt: new Date().toISOString(),
    records: records.length,
    output: {
      ...out,
      collections: collections.size,
      variables: variables.size,
      textStyles: textStyles.size,
    },
    overrides: {
      copiesWithOverrides,
      listed,
      unexplained,
      byName: [...noise].map(([name, v]) => ({ name, ...v })).sort((a, b) => b.listed - a.listed),
      examples: noiseExamples,
    },
    features: results,
  };
}

// ---------------------------------------------------------------------------
// The report

const pct = (n: number, of: number) => (of === 0 ? "" : `${Math.round((100 * n) / of)}%`);
const cell = (s: string) => s.replace(/\|/g, "\\|");

/** The coverage as Markdown: gaps ranked by impact, then everything carried faithfully. */
export function coverageMarkdown(c: Coverage, title = "Figma import coverage"): string {
  const gaps = c.features.filter((f) => f.status !== "faithful" && f.status !== "unchecked");
  const fine = c.features.filter((f) => f.status === "faithful");
  const unchecked = c.features.filter((f) => f.status === "unchecked");
  const o = c.output;
  const lines = [
    `# ${title}`,
    "",
    `${c.records.toLocaleString("en")} records; output ${o.nodes.toLocaleString("en")} nodes (${Object.entries(
      o.types,
    )
      .sort((a, b) => b[1] - a[1])
      .map(([t, n]) => `${n.toLocaleString("en")} ${t}`)
      .join(
        ", ",
      )}). Collections ${o.collections}, variables ${o.variables}, text styles ${o.textStyles}, layers with bindings ${o.withBindings}, frames setting modes ${o.withVariableModes}, layers with reactions ${o.withReactions}. Components ${o.components}, sets ${o.componentSets}, instances ${o.instances}, layers inside copies ${o.copies.toLocaleString("en")}.`,
    "",
    "Outcome per feature, judged on the converted output: **faithful** (the output carries it), **approximate** (it carries the look, not the feature: a bound value baked, a boolean made a path, a property applied but gone), **lost** (neither, or the layer missing). Impact = layers affected (copies included) × importance (visual 3, editing 2, metadata 1) × the share not faithful (lost whole, approximate half).",
    "",
    `## Gaps (${gaps.length}), by impact`,
    "",
    "| # | Feature | Area | Records | Layers | Faithful / approx / lost | Status | Impact | Example | Likely code |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...gaps.map(
      (f, i) =>
        `| ${i + 1} | ${cell(f.label)} (\`${cell(f.key)}\`) | ${f.area} | ${f.records.toLocaleString("en")} | ${f.layers.toLocaleString("en")} | ${pct(f.faithful, f.checked)} / ${pct(f.approximate, f.checked)} / ${pct(f.lost, f.checked)}${f.absent ? ` (${f.absent} absent)` : ""}${f.unresolved ? ` (${f.unresolved} unresolved)` : ""} | ${f.status} | ${f.impact.toLocaleString("en")} | \`${f.failing[0] ?? f.examples[0] ?? ""}\` | ${cell(f.code)} |`,
    ),
    "",
    "## Overrides copies list",
    "",
    `${c.overrides.copiesWithOverrides.toLocaleString("en")} layers inside copies list overrides: ${c.overrides.listed.toLocaleString("en")} names, ${c.overrides.unexplained.toLocaleString("en")} (${pct(c.overrides.unexplained, c.overrides.listed)}) with no override Figma saved for that layer (sizes, places and layout Figma worked out, or values a component property set, listed as if someone changed them).`,
    "",
    "| Property | Listed | With a Figma override |",
    "| --- | --- | --- |",
    ...c.overrides.byName
      .slice(0, 25)
      .map(
        (n) => `| ${n.name} | ${n.listed.toLocaleString("en")} | ${pct(n.explained, n.listed)} |`,
      ),
    "",
    `## Carried faithfully (${fine.length})`,
    "",
    "| Feature | Area | Records | Layers | How it was checked |",
    "| --- | --- | --- | --- | --- |",
    ...fine.map(
      (f) =>
        `| ${cell(f.label)} (\`${cell(f.key)}\`) | ${f.area} | ${f.records.toLocaleString("en")} | ${f.layers.toLocaleString("en")} | ${cell(f.how)} |`,
    ),
    "",
    ...(unchecked.length > 0
      ? [
          `## Found but not judged (${unchecked.length})`,
          "",
          ...unchecked.map((f) => `- ${f.label} (\`${f.key}\`): ${f.records} records`),
          "",
        ]
      : []),
    "## How each gap was checked",
    "",
    ...gaps.map((f) => `- \`${f.key}\`: ${f.how}.`),
    "",
  ];
  return lines.join("\n");
}
