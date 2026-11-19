/**
 * Variables and shared styles, resolved where a layer is (decision 0034).
 *
 * A layer stores what it's bound to: `bindings` for its own properties,
 * `bind` on its paints, gradient stops and effects, and links to paint and
 * effect styles. What those resolve to depends on where the layer is: the
 * modes its frames, instances and page set. So they're resolved where the
 * layer is read, not written into it: a copy of a component placed in a
 * frame set to another mode shows that mode's values with nothing stored
 * for it, and a variable edit stores one value, whatever it drives.
 *
 * The values a layer stores for bound fields are what shows when a binding
 * can't be followed (a variable deleted, an alias cycle, a value of the
 * wrong type), and what a reader without this module sees.
 */
import { ROOT_ID } from "./ids";
import type { NodeRecord } from "./ops";
import {
  BINDING_UNITS,
  type BindingKey,
  type BindingRef,
  type BindingUnit,
  type Effect,
  getProp,
  type Paint,
  type PropName,
  type Props,
  type VariableType,
} from "./schema";

/** Reads nodes as presented (copies built), before anything is resolved. */
export interface TokenReader {
  get(id: string): NodeRecord | undefined;
}

/** What a variable resolves to: a colour as `#rrggbbaa` or `#rrggbb`, a number, a string or a boolean. */
export type ResolvedValue = string | number | boolean;

/** How deep aliases are followed before giving up (a cycle, or a chain too long to mean anything). */
export const MAX_ALIAS_DEPTH = 16;

const HEX = /^#[0-9a-f]{6}([0-9a-f]{2})?$/;

/** The layer properties each binding key drives, and the variable type it takes. */
export const BINDING_FIELDS: Readonly<
  Record<BindingKey, { readonly props: readonly PropName[]; readonly type: VariableType }>
> = {
  fill: { props: ["fills"], type: "color" },
  stroke: { props: ["strokes"], type: "color" },
  width: { props: ["width"], type: "number" },
  height: { props: ["height"], type: "number" },
  minWidth: { props: ["minWidth"], type: "number" },
  maxWidth: { props: ["maxWidth"], type: "number" },
  minHeight: { props: ["minHeight"], type: "number" },
  maxHeight: { props: ["maxHeight"], type: "number" },
  gap: { props: ["gap"], type: "number" },
  rowGap: { props: ["rowGap"], type: "number" },
  paddingTop: { props: ["paddingTop"], type: "number" },
  paddingRight: { props: ["paddingRight"], type: "number" },
  paddingBottom: { props: ["paddingBottom"], type: "number" },
  paddingLeft: { props: ["paddingLeft"], type: "number" },
  cornerRadius: { props: ["cornerRadius"], type: "number" },
  topLeftRadius: { props: ["cornerRadii"], type: "number" },
  topRightRadius: { props: ["cornerRadii"], type: "number" },
  bottomRightRadius: { props: ["cornerRadii"], type: "number" },
  bottomLeftRadius: { props: ["cornerRadii"], type: "number" },
  strokeWeight: { props: ["strokeWeight"], type: "number" },
  strokeTopWeight: { props: ["strokeWeights"], type: "number" },
  strokeRightWeight: { props: ["strokeWeights"], type: "number" },
  strokeBottomWeight: { props: ["strokeWeights"], type: "number" },
  strokeLeftWeight: { props: ["strokeWeights"], type: "number" },
  opacity: { props: ["opacity"], type: "number" },
  visible: { props: ["visible"], type: "boolean" },
  characters: { props: ["characters"], type: "string" },
  fontFamily: { props: ["fontFamily"], type: "string" },
  fontStyle: { props: ["fontWeight", "fontStyle"], type: "string" },
  fontWeight: { props: ["fontWeight"], type: "number" },
  fontSize: { props: ["fontSize"], type: "number" },
  lineHeight: { props: ["lineHeight"], type: "number" },
  letterSpacing: { props: ["letterSpacing"], type: "number" },
  paragraphSpacing: { props: ["paragraphSpacing"], type: "number" },
};

/** Binding keys that drive each property: what to unbind when it's set by hand. */
export const BINDING_FIELDS_BY_PROP: ReadonlyMap<string, readonly BindingKey[]> = (() => {
  const out = new Map<string, BindingKey[]>();
  for (const [key, target] of Object.entries(BINDING_FIELDS) as Array<
    [BindingKey, { props: readonly PropName[] }]
  >)
    for (const prop of target.props) {
      const list = out.get(prop) ?? [];
      list.push(key);
      out.set(prop, list);
    }
  return out;
})();

/** The variable a binding names (decision 0034): its id, or the id beside its unit. */
export function bindingVariable(ref: unknown): string | undefined {
  if (typeof ref === "string") return ref;
  const variable = (ref as { variable?: unknown } | null)?.variable;
  return typeof variable === "string" ? variable : undefined;
}

/** The unit a binding reads its value in, or undefined: as before decision 0034. */
export function bindingUnit(ref: unknown): BindingUnit | undefined {
  const unit = (ref as { unit?: unknown } | null)?.unit;
  return unit === "percent" || unit === "text" ? unit : undefined;
}

/** A binding of `key` to `variableId` as new code writes it: with its unit where 0034 has one. */
export function bindingRef(key: BindingKey, variableId: string): BindingRef {
  const unit = BINDING_UNITS[key];
  return unit ? { variable: variableId, unit } : variableId;
}

/** The variables a `bindings` value names, in order. */
function boundVariables(bindings: unknown): string[] {
  const out: string[] = [];
  if (bindings && typeof bindings === "object")
    for (const ref of Object.values(bindings as Record<string, unknown>)) {
      const id = bindingVariable(ref);
      if (id) out.push(id);
    }
  return out;
}

/** Binding keys whose values a layout reads: a change to what they resolve to lays the layer out again. */
export const LAYOUT_BINDINGS: ReadonlySet<BindingKey> = new Set<BindingKey>([
  "width",
  "height",
  "minWidth",
  "maxWidth",
  "minHeight",
  "maxHeight",
  "gap",
  "rowGap",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "strokeWeight",
  "strokeTopWeight",
  "strokeRightWeight",
  "strokeBottomWeight",
  "strokeLeftWeight",
  "visible",
  "characters",
  "fontFamily",
  "fontStyle",
  "fontWeight",
  "fontSize",
  "lineHeight",
  "letterSpacing",
  "paragraphSpacing",
]);

const CORNER_INDEX: Partial<Record<BindingKey, number>> = {
  topLeftRadius: 0,
  topRightRadius: 1,
  bottomRightRadius: 2,
  bottomLeftRadius: 3,
};
const SIDE_INDEX: Partial<Record<BindingKey, number>> = {
  strokeTopWeight: 0,
  strokeRightWeight: 1,
  strokeBottomWeight: 2,
  strokeLeftWeight: 3,
};
/** Properties that can't go below zero. */
const NON_NEGATIVE = new Set<string>([
  "width",
  "height",
  "minWidth",
  "maxWidth",
  "minHeight",
  "maxHeight",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "cornerRadius",
  "strokeWeight",
  "paragraphSpacing",
]);

// ---------------------------------------------------------------------------
// What a node refers to

type Bound = { readonly bind?: Readonly<Record<string, unknown>> };

function bindsOf(list: unknown, out: string[]): void {
  if (!Array.isArray(list)) return;
  for (const item of list as Array<Bound & { stops?: unknown }>) {
    if (item?.bind)
      for (const id of Object.values(item.bind)) if (typeof id === "string") out.push(id);
    if (Array.isArray(item?.stops))
      for (const stop of item.stops as Bound[])
        if (stop?.bind)
          for (const id of Object.values(stop.bind)) if (typeof id === "string") out.push(id);
  }
}

/** The variables and styles a node's own values name (decision 0034). */
export function tokenRefs(props: Readonly<Props>): { variables: string[]; styles: string[] } {
  const p = props as Record<string, unknown>;
  const variables: string[] = [];
  const styles: string[] = [];
  variables.push(...boundVariables(p.bindings));
  bindsOf(p.fills, variables);
  bindsOf(p.strokes, variables);
  bindsOf(p.effects, variables);
  for (const link of [p.fillStyle, p.strokeStyle, p.effectStyle])
    if (typeof link === "string") styles.push(link);
  return { variables, styles };
}

function renameBinds(list: unknown, to: (id: string) => string): unknown {
  if (!Array.isArray(list)) return list;
  const bind = (item: Bound) =>
    item?.bind
      ? {
          ...item,
          bind: Object.fromEntries(
            Object.entries(item.bind).map(([k, v]) => [k, typeof v === "string" ? to(v) : v]),
          ),
        }
      : item;
  return (list as Array<Bound & { stops?: unknown }>).map((item) => {
    const out = bind(item) as Bound & { stops?: unknown };
    return Array.isArray(out?.stops)
      ? { ...out, stops: (out.stops as Bound[]).map((stop) => bind(stop)) }
      : out;
  });
}

/**
 * `props` with every variable, style and collection id it holds renamed by
 * `to` (decision 0034), payloads kept whole: `bindings`, what paints, their
 * stops, effects and text runs bind, the style links, a variable's aliases
 * (their `opacity` too), and the collections `variableModes` sets. For
 * copying tokens and what uses them to new ids (a library's copies).
 */
export function renameTokenIds(props: Readonly<Props>, to: (id: string) => string): Props {
  const p = props as Record<string, unknown>;
  const out: Record<string, unknown> = { ...p };
  if (p.bindings && typeof p.bindings === "object")
    out.bindings = Object.fromEntries(
      Object.entries(p.bindings as Record<string, unknown>).map(([k, v]) => [
        k,
        typeof v === "string"
          ? to(v)
          : { ...(v as object), variable: to(bindingVariable(v) ?? "") },
      ]),
    );
  for (const prop of ["fills", "strokes", "effects"])
    if (Array.isArray(p[prop])) out[prop] = renameBinds(p[prop], to);
  if (Array.isArray(p.textRuns))
    out.textRuns = (p.textRuns as Array<Record<string, unknown>>).map((run) =>
      Array.isArray(run?.fills) ? { ...run, fills: renameBinds(run.fills, to) } : run,
    );
  for (const link of ["fillStyle", "strokeStyle", "effectStyle", "textStyle"])
    if (typeof p[link] === "string") out[link] = to(p[link] as string);
  if (p.variableModes && typeof p.variableModes === "object")
    out.variableModes = Object.fromEntries(
      Object.entries(p.variableModes as Record<string, string>).map(([k, v]) => [to(k), v]),
    );
  if (p.values && typeof p.values === "object")
    out.values = Object.fromEntries(
      Object.entries(p.values as Record<string, unknown>).map(([mode, v]) => [
        mode,
        v && typeof v === "object" && typeof (v as { alias?: unknown }).alias === "string"
          ? { ...(v as object), alias: to((v as { alias: string }).alias) }
          : v,
      ]),
    );
  return out as Props;
}

function listBinds(list: unknown): boolean {
  if (!Array.isArray(list)) return false;
  for (const item of list as Array<Bound & { stops?: unknown }>) {
    if (item?.bind) return true;
    if (Array.isArray(item?.stops) && (item.stops as Bound[]).some((s) => s?.bind)) return true;
  }
  return false;
}

/** Whether anything about a node is resolved from variables or styles: one quick look. */
export function usesTokens(props: Readonly<Props>): boolean {
  const p = props as Record<string, unknown>;
  return (
    (p.bindings !== undefined && Object.keys(p.bindings as object).length > 0) ||
    typeof p.fillStyle === "string" ||
    typeof p.strokeStyle === "string" ||
    typeof p.effectStyle === "string" ||
    listBinds(p.fills) ||
    listBinds(p.strokes) ||
    listBinds(p.effects)
  );
}

/** Whether a node binds something a layout reads (layout is stored, so it's laid out again). */
export function bindsLayout(props: Readonly<Props>): boolean {
  const bindings = (props as { bindings?: Record<string, unknown> }).bindings;
  if (!bindings) return false;
  for (const key of Object.keys(bindings)) if (LAYOUT_BINDINGS.has(key as BindingKey)) return true;
  return false;
}

/**
 * The variables a node's layout reads through its bindings (a bound
 * padding, a font size): a change to what one of these resolves to lays it
 * out again; a change to anything else it binds (a colour) doesn't.
 */
export function layoutVariables(props: Readonly<Props>): string[] {
  const bindings = (props as { bindings?: Record<string, unknown> }).bindings;
  const out: string[] = [];
  if (!bindings) return out;
  for (const [key, ref] of Object.entries(bindings)) {
    const id = bindingVariable(ref);
    if (LAYOUT_BINDINGS.has(key as BindingKey) && id) out.push(id);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Values that differ only where they're bound

type BindingMap = Readonly<Record<string, unknown>> | undefined;
const CORNER_KEYS = ["topLeftRadius", "topRightRadius", "bottomRightRadius", "bottomLeftRadius"];
const SIDE_KEYS = [
  "strokeTopWeight",
  "strokeRightWeight",
  "strokeBottomWeight",
  "strokeLeftWeight",
];

/** Paints or effects with the fields they bind blanked: what's their own, whatever variables give. */
function unboundList(list: unknown): unknown {
  if (!Array.isArray(list)) return list;
  return list.map((item: Record<string, unknown>) => {
    const out: Record<string, unknown> = { ...item };
    const bind = item?.bind as Record<string, string> | undefined;
    if (bind) for (const field of Object.keys(bind)) out[field] = null;
    if (Array.isArray(item?.stops))
      out.stops = (item.stops as Array<Record<string, unknown>>).map((stop) =>
        stop?.bind ? { ...stop, color: null } : stop,
      );
    return out;
  });
}

/**
 * Whether two values of a property differ only where both bind the same
 * variables (decision 0034): a copy's saved value and its main's, each
 * resolved in its own modes. A copy that differs from its main only so
 * isn't overriding it: it shows what its variables give where it is.
 * `a` and `b` are the bindings of the nodes holding each.
 */
export function boundAlike(
  prop: string,
  a: unknown,
  b: unknown,
  aBindings: BindingMap,
  bBindings: BindingMap,
): boolean {
  if (a === undefined || b === undefined) return false;
  if (prop === "fills" || prop === "strokes" || prop === "effects")
    return JSON.stringify(unboundList(a)) === JSON.stringify(unboundList(b));
  const same = (key: string) =>
    !!aBindings?.[key] && JSON.stringify(aBindings[key]) === JSON.stringify(bBindings?.[key]);
  if (prop === "cornerRadii" || prop === "strokeWeights") {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    const keys = prop === "cornerRadii" ? CORNER_KEYS : SIDE_KEYS;
    return a.every((v, i) => v === b[i] || same(keys[i] as string));
  }
  return (BINDING_FIELDS_BY_PROP.get(prop) ?? []).some(same);
}

/** `boundAlike` for two nodes' values: a comparison a copy's own values are worked out with. */
export function alikeWhereBound(
  own: Readonly<Record<string, unknown>>,
  base: Readonly<Record<string, unknown>>,
): (prop: string, a: unknown, b: unknown) => boolean {
  const ownBindings = own.bindings as BindingMap;
  const baseBindings = base.bindings as BindingMap;
  if (!usesTokens(own as Props) && !usesTokens(base as Props)) return () => false;
  return (prop, a, b) => boundAlike(prop, a, b, ownBindings, baseBindings);
}

// ---------------------------------------------------------------------------
// Colours

function parseHex(hex: string): [number, number, number, number] {
  const n = (i: number) => Number.parseInt(hex.slice(i, i + 2), 16);
  return [n(1), n(3), n(5), hex.length === 9 ? n(7) : 255];
}

const byte = (v: number) =>
  Math.max(0, Math.min(255, Math.round(v)))
    .toString(16)
    .padStart(2, "0");

/** A colour with its alpha multiplied by `opacity`. */
export function composeAlpha(hex: string, opacity: number): string {
  if (opacity >= 1) return hex;
  const [r, g, b, a] = parseHex(hex);
  const alpha = a * Math.max(0, opacity);
  return `#${byte(r)}${byte(g)}${byte(b)}${Math.round(alpha) >= 255 ? "" : byte(alpha)}`;
}

// ---------------------------------------------------------------------------
// Text from values, and font styles

/**
 * A number as Figma writes one shown as text: a whole number (within a
 * millionth) as an integer, anything else with two decimals.
 */
export function numberText(value: number): string {
  const whole = Math.round(value);
  if (Math.abs(value - whole) < 1e-6) return String(whole || 0);
  return value.toFixed(2);
}

const WEIGHTS: ReadonlyArray<[RegExp, number]> = [
  [/\b(hairline|thin)\b/, 100],
  [/\b(extra|ultra)\s*light\b/, 200],
  [/\blight\b/, 300],
  [/\b(semi|demi)\s*bold\b/, 600],
  [/\b(extra|ultra)\s*bold\b/, 800],
  [/\bbold\b/, 700],
  [/\bmedium\b/, 500],
  [/\b(black|heavy)\b/, 900],
];

/** A font style's name ("Semi Bold Italic") as a weight and whether it's italic. */
export function parseFontStyle(name: string): { weight: number; italic: boolean } {
  const s = name.toLowerCase();
  const numeric = /\b([1-9]00)\b/.exec(s);
  let weight = numeric ? Number(numeric[1]) : 400;
  if (!numeric)
    for (const [pattern, w] of WEIGHTS)
      if (pattern.test(s)) {
        weight = w;
        break;
      }
  return { weight, italic: /\b(italic|oblique)\b/.test(s) };
}

const clampUnit = (n: number) => Math.max(0, Math.min(1, n));

// ---------------------------------------------------------------------------
// Resolving

/**
 * Resolves variables and styles for nodes read through `reader`. It keeps
 * nothing between calls, so a caller caches what it resolves and drops it
 * when what that depends on changes (the editor's `Doc` does, with indexes).
 */
export class TokenResolver {
  readonly #reader: TokenReader;

  constructor(reader: TokenReader) {
    this.#reader = reader;
  }

  /**
   * The mode of a collection that applies at a node: the nearest of the
   * node, its frames and its page that sets one the collection still has,
   * else the collection's first (default) mode. Null for no collection.
   */
  modeAt(node: NodeRecord | string | undefined, collectionId: string): string | null {
    const collection = this.#reader.get(collectionId);
    if (collection?.type !== "collection") return null;
    const modes = getProp(collection.props, "modes");
    let at = typeof node === "string" ? this.#reader.get(node) : node;
    for (let depth = 0; at && depth < 4096; depth++) {
      const mode = (at.props as Props).variableModes?.[collectionId];
      if (mode && modes.some((m) => m.id === mode)) return mode;
      at = at.parent === ROOT_ID ? undefined : this.#reader.get(at.parent);
    }
    return modes[0]?.id ?? null;
  }

  /**
   * A variable's value at a node (in its collections' default modes when no
   * node is given), aliases followed, each in the mode of its own
   * collection there. Undefined when it can't be followed.
   */
  value(
    variableId: string,
    at?: NodeRecord | string,
  ): { type: VariableType; value: ResolvedValue } | undefined {
    let id = variableId;
    let opacity = 1;
    let type: VariableType | undefined;
    const seen = new Set<string>();
    for (let depth = 0; depth < MAX_ALIAS_DEPTH; depth++) {
      if (seen.has(id)) return undefined;
      seen.add(id);
      const variable = this.#reader.get(id);
      if (variable?.type !== "variable") return undefined;
      type ??= getProp(variable.props, "variableType");
      const collection = this.#reader.get(variable.parent);
      const modes = collection?.type === "collection" ? getProp(collection.props, "modes") : [];
      const mode = at ? this.modeAt(at, variable.parent) : (modes[0]?.id ?? null);
      const values = getProp(variable.props, "values");
      // A mode without a value falls back to the first value stored, as before decision 0034.
      const value = (mode ? values[mode] : undefined) ?? Object.values(values)[0];
      if (value === undefined) return undefined;
      if (typeof value === "object") {
        if (value.opacity !== undefined) opacity *= value.opacity;
        id = value.alias;
        continue;
      }
      if (type === "color") {
        if (typeof value !== "string" || !HEX.test(value)) return undefined;
        return { type, value: composeAlpha(value, opacity) };
      }
      if (type === "number" && (typeof value !== "number" || !Number.isFinite(value)))
        return undefined;
      if (type === "boolean" && typeof value !== "boolean") return undefined;
      if (type === "string" && typeof value !== "string") return undefined;
      return { type, value };
    }
    return undefined;
  }

  #color(id: string | undefined, at: NodeRecord): string | undefined {
    if (!id) return undefined;
    const v = this.value(id, at);
    return v?.type === "color" && typeof v.value === "string" ? v.value : undefined;
  }

  #number(id: string | undefined, at: NodeRecord): number | undefined {
    if (!id) return undefined;
    const v = this.value(id, at);
    return typeof v?.value === "number" ? v.value : undefined;
  }

  #boolean(id: string | undefined, at: NodeRecord): boolean | undefined {
    if (!id) return undefined;
    const v = this.value(id, at);
    return typeof v?.value === "boolean" ? v.value : undefined;
  }

  /** Paints with their bound fields resolved at `at`; the same array when nothing changed. */
  paints(paints: readonly Paint[], at: NodeRecord): readonly Paint[] {
    let out: Paint[] | null = null;
    paints.forEach((paint, i) => {
      let next: Paint = paint;
      const bind = paint.bind;
      if (bind) {
        if (next.type === "solid") {
          const color = this.#color(bind.color, at);
          // A bound colour gives the paint its colour and alpha; the paint's own opacity applies
          // on top, as a person set it. Figma saves the variable's alpha as the paint's opacity
          // too: the importers fold that into the colour once (alpha normalised at import).
          if (color !== undefined && color !== next.color) next = { ...next, color };
        }
        const opacity = this.#number(bind.opacity, at);
        if (opacity !== undefined) next = { ...next, opacity: clampUnit(opacity / 100) };
      }
      if (next.type === "linear" || next.type === "radial" || next.type === "angular") {
        let changed = false;
        const stops = next.stops.map((stop) => {
          const color = this.#color(stop.bind?.color, at);
          if (color === undefined || color === stop.color) return stop;
          changed = true;
          return { ...stop, color };
        });
        if (changed) next = { ...next, stops };
      }
      if (next !== paint) {
        out ??= [...paints];
        out[i] = next;
      }
    });
    return out ?? paints;
  }

  /** Effects with their bound fields resolved at `at`; the same array when nothing changed. */
  effects(effects: readonly Effect[], at: NodeRecord): readonly Effect[] {
    let out: Effect[] | null = null;
    effects.forEach((effect, i) => {
      let next: Effect = effect;
      if ((effect.type === "drop-shadow" || effect.type === "inner-shadow") && effect.bind) {
        const bind = effect.bind;
        const patch: Record<string, unknown> = {};
        const x = this.#number(bind.x, at);
        const y = this.#number(bind.y, at);
        const blur = this.#number(bind.blur, at);
        const spread = this.#number(bind.spread, at);
        const color = this.#color(bind.color, at);
        const visible = this.#boolean(bind.visible, at);
        if (x !== undefined) patch.x = x;
        if (y !== undefined) patch.y = y;
        if (blur !== undefined) patch.blur = Math.max(0, blur);
        if (spread !== undefined) patch.spread = spread;
        if (color !== undefined) patch.color = color;
        if (visible !== undefined) patch.visible = visible;
        if (Object.keys(patch).length > 0) next = { ...effect, ...patch } as Effect;
      } else if (
        (effect.type === "layer-blur" || effect.type === "background-blur") &&
        effect.bind
      ) {
        const radius = this.#number(effect.bind.radius, at);
        const visible = this.#boolean(effect.bind.visible, at);
        if (radius !== undefined || visible !== undefined)
          next = {
            ...effect,
            ...(radius !== undefined ? { radius: Math.max(0, radius) } : {}),
            ...(visible !== undefined ? { visible } : {}),
          };
      }
      if (next !== effect) {
        out ??= [...effects];
        out[i] = next;
      }
    });
    return out ?? effects;
  }

  /** A shared style of a kind, if the link names one. */
  #style(id: unknown, type: "paintStyle" | "effectStyle"): NodeRecord | undefined {
    if (typeof id !== "string") return undefined;
    const style = this.#reader.get(id);
    return style?.type === type ? style : undefined;
  }

  /**
   * The node with its linked styles applied and its bound values resolved
   * where it is; the same object when nothing about it changes.
   */
  resolve(node: NodeRecord): NodeRecord {
    const p = node.props as Props;
    // A text style's bindings are kept (decision 0034) but not yet presented: text layers take
    // a style's values as written (text-styles.ts), so its own values stay what they're read as.
    if (node.type === "textStyle" || !usesTokens(p)) return node;
    const out: Record<string, unknown> = {};
    const fillStyle = this.#style(p.fillStyle, "paintStyle");
    const strokeStyle = this.#style(p.strokeStyle, "paintStyle");
    const effectStyle = this.#style(p.effectStyle, "effectStyle");
    const fills = fillStyle ? getProp(fillStyle.props, "fills") : p.fills;
    const strokes = strokeStyle ? getProp(strokeStyle.props, "fills") : p.strokes;
    const effects = effectStyle ? getProp(effectStyle.props, "effects") : p.effects;
    if (fills) {
      const resolved = this.paints(fills, node);
      if (resolved !== p.fills) out.fills = resolved;
    }
    if (strokes) {
      const resolved = this.paints(strokes, node);
      if (resolved !== p.strokes) out.strokes = resolved;
    }
    if (effects) {
      const resolved = this.effects(effects, node);
      if (resolved !== p.effects) out.effects = resolved;
    }
    const bindings = p.bindings;
    if (bindings)
      for (const [key, ref] of Object.entries(bindings) as Array<[BindingKey, unknown]>) {
        const variableId = bindingVariable(ref);
        if (!BINDING_FIELDS[key] || !variableId) continue;
        const resolved = this.value(variableId, node);
        if (resolved) this.#apply(key, resolved.value, p, out, bindingUnit(ref));
      }
    // A bound size is kept within the layer's min and max (bound or not), as Figma keeps it.
    // An unbound size is the layout's: it's laid out again when what it reads changes.
    for (const [size, min, max] of [
      ["width", "minWidth", "maxWidth"],
      ["height", "minHeight", "maxHeight"],
    ] as const) {
      const value = out[size] as number | undefined;
      if (value === undefined) continue;
      const lo = (out[min] as number | null | undefined) ?? getProp(p, min);
      const hi = (out[max] as number | null | undefined) ?? getProp(p, max);
      let clamped = value;
      if (typeof hi === "number") clamped = Math.min(clamped, hi);
      if (typeof lo === "number") clamped = Math.max(clamped, lo);
      out[size] = clamped;
    }
    if (Object.keys(out).length === 0) return node;
    return { ...node, props: { ...p, ...out } as Props };
  }

  /**
   * Writes one binding's value into `out`, over the node's own `p`, when it
   * fits the property, read in the binding's `unit` (decision 0034); without
   * one, as before 0034.
   */
  #apply(
    key: BindingKey,
    value: ResolvedValue,
    p: Props,
    out: Record<string, unknown>,
    unit: BindingUnit | undefined,
  ): void {
    const current = <K extends PropName>(name: K) =>
      (out[name] as Props[K] | undefined) ?? getProp(p, name);
    if (key === "fill" || key === "stroke") {
      if (typeof value !== "string" || !HEX.test(value)) return;
      const prop = key === "fill" ? "fills" : "strokes";
      const paints = current(prop);
      const index = paints.findIndex((paint) => paint.type === "solid");
      out[prop] =
        index === -1
          ? [{ type: "solid", color: value }, ...paints]
          : paints.map((paint, i) => (i === index ? { ...paint, color: value } : paint));
      return;
    }
    const corner = CORNER_INDEX[key];
    if (corner !== undefined) {
      if (typeof value !== "number") return;
      const r = getProp(p, "cornerRadius");
      const radii = [...(current("cornerRadii") ?? [r, r, r, r])] as [
        number,
        number,
        number,
        number,
      ];
      radii[corner] = Math.max(0, value);
      out.cornerRadii = radii;
      return;
    }
    const side = SIDE_INDEX[key];
    if (side !== undefined) {
      if (typeof value !== "number") return;
      const w = getProp(p, "strokeWeight");
      const sides = [...(current("strokeWeights") ?? [w, w, w, w])] as [
        number,
        number,
        number,
        number,
      ];
      sides[side] = Math.max(0, value);
      out.strokeWeights = sides;
      return;
    }
    switch (key) {
      case "opacity":
        // A percentage, as Figma's; a binding from before 0034 took 1 or less as a fraction.
        if (typeof value === "number")
          out.opacity = clampUnit(unit === "percent" || value > 1 ? value / 100 : value);
        return;
      case "visible":
        if (typeof value === "boolean") out.visible = value;
        return;
      case "characters":
        if (typeof value === "string") out.characters = value.slice(0, 200_000);
        // A number or boolean as Figma writes it; before 0034 only text applied.
        else if (unit !== "text") return;
        else if (typeof value === "number") out.characters = numberText(value);
        else out.characters = String(value);
        return;
      case "fontFamily":
        if (typeof value === "string" && value.trim()) out.fontFamily = value.slice(0, 128);
        return;
      case "fontStyle":
        if (typeof value === "string") {
          const style = parseFontStyle(value);
          out.fontWeight = style.weight;
          out.fontStyle = style.italic ? "italic" : "normal";
        }
        return;
      case "fontWeight":
        if (typeof value === "number")
          out.fontWeight = Math.max(1, Math.min(1000, Math.round(value)));
        return;
      case "fontSize":
        if (typeof value === "number" && value > 0) out.fontSize = Math.min(4096, value);
        return;
      case "lineHeight":
        if (typeof value === "number") out.lineHeight = { unit: "px", value: Math.max(0, value) };
        return;
      case "letterSpacing":
        if (typeof value === "number") out.letterSpacing = { unit: "px", value };
        return;
      case "paragraphSpacing":
        if (typeof value === "number") out.paragraphSpacing = Math.max(0, Math.min(1000, value));
        return;
      default: {
        if (typeof value !== "number") return;
        const prop = BINDING_FIELDS[key].props[0] as string;
        out[prop] = NON_NEGATIVE.has(prop) ? Math.max(0, value) : value;
      }
    }
  }
}
