/**
 * Variables (design tokens): collections of named values with one value per
 * mode, bound to layer properties, and to the fields of paints and effects.
 *
 * Bindings are resolved where they're read (decision 0034): the document
 * presents every bound field as what its variable resolves to in the modes
 * around the layer (`Doc.get`, token-view.ts), and nothing writes resolved
 * values back when a variable or a mode changes. The value a layer stores
 * for a bound field is what shows when the binding can't be followed.
 */
import {
  BINDING_FIELDS,
  BINDING_FIELDS_BY_PROP,
  type BindingKey,
  bindingRef,
  type Effect,
  getProp,
  type VariableType as ModelVariableType,
  type NodeRecord,
  type Op,
  type Paint,
  type PropName,
  type VariableValue,
} from "@drawpane/model";
import type { Doc } from "./doc";
import { textStyles, typographyToken } from "./text-styles";

export type VariableType = ModelVariableType;

/** Which property a binding key drives, and the variable type it takes. */
export const BINDING_TARGETS: Readonly<Record<BindingKey, { prop: PropName; type: VariableType }>> =
  Object.fromEntries(
    (
      Object.entries(BINDING_FIELDS) as Array<[BindingKey, (typeof BINDING_FIELDS)[BindingKey]]>
    ).map(([key, target]) => [key, { prop: target.props[0] as PropName, type: target.type }]),
  ) as Record<BindingKey, { prop: PropName; type: VariableType }>;

/** Binding keys that drive a given property (for detaching when it's edited by hand). */
export const KEYS_BY_PROP = new Map<string, BindingKey[]>();
for (const [key, target] of Object.entries(BINDING_TARGETS) as Array<
  [BindingKey, { prop: PropName }]
>) {
  const list = KEYS_BY_PROP.get(target.prop) ?? [];
  list.push(key);
  KEYS_BY_PROP.set(target.prop, list);
}

export function listCollections(doc: Doc): NodeRecord[] {
  return doc
    .collectionIds()
    .map((id) => doc.get(id))
    .filter((n): n is NodeRecord => !!n);
}

export function variablesIn(doc: Doc, collectionId: string): NodeRecord[] {
  return doc
    .childIds(collectionId)
    .map((id) => doc.get(id))
    .filter((n): n is NodeRecord => !!n);
}

export function allVariables(doc: Doc): NodeRecord[] {
  return listCollections(doc).flatMap((c) => variablesIn(doc, c.id));
}

/** A variable by its name ("brand/500"), optionally limited to one type. */
export function findVariable(doc: Doc, name: string, type?: VariableType): NodeRecord | undefined {
  const wanted = name.trim().toLowerCase();
  return allVariables(doc).find(
    (v) =>
      getProp(v.props, "name").toLowerCase() === wanted &&
      (!type || getProp(v.props, "variableType") === type),
  );
}

/**
 * What a frame or page sets itself, for a tag beside its name in the layers
 * panel: the mode ("Dark"), or the first and how many more ("Dark +1"), and
 * every one in words ("Theme: Dark · Density: Compact"). Null when it sets
 * none (it inherits), or only modes that no longer exist.
 */
export function modeTag(doc: Doc, node: NodeRecord): { text: string; label: string } | null {
  if (node.type !== "frame" && node.type !== "page") return null;
  const set: Array<{ collection: string; mode: string }> = [];
  for (const [collectionId, modeId] of Object.entries(getProp(node.props, "variableModes"))) {
    const collection = doc.get(collectionId);
    if (collection?.type !== "collection") continue;
    const mode = getProp(collection.props, "modes").find((m) => m.id === modeId);
    if (mode)
      set.push({ collection: getProp(collection.props, "name") || "Collection", mode: mode.name });
  }
  const first = set[0];
  if (!first) return null;
  return {
    text: set.length === 1 ? first.mode : `${first.mode} +${set.length - 1}`,
    label: set.map((s) => `${s.collection}: ${s.mode}`).join(" · "),
  };
}

/**
 * The mode of `collectionId` that applies at `nodeId`: the nearest frame or
 * page that sets one, else the collection's first mode.
 */
export function activeMode(doc: Doc, nodeId: string, collectionId: string): string | null {
  return doc.tokens.resolver.modeAt(nodeId, collectionId);
}

/**
 * A variable's value at `nodeId` (or in its collections' default modes when
 * no node is given), following aliases. Undefined when unset, missing or cyclic.
 */
export function resolveVariable(
  doc: Doc,
  variableId: string,
  nodeId?: string,
): string | number | boolean | undefined {
  return doc.tokens.resolver.value(variableId, nodeId)?.value;
}

type Item = Record<string, unknown> & { bind?: Record<string, string>; stops?: unknown };
type Stop = { color: string; bind?: { color?: string } } & Record<string, unknown>;

const json = (value: unknown) => JSON.stringify(value);
const sameBind = (a: unknown, b: unknown) => json(a ?? null) === json(b ?? null);

/**
 * The item of `before` each item of `next` is, when it's one of them: the
 * same item exactly (reordered or kept), else an unused one binding the same
 * variables (edited, perhaps moved too), else the one at its index. So a
 * reorder keeps every binding, and an edit is compared with the item it
 * edits, wherever it moved.
 */
function matchItems<T>(next: readonly T[], before: readonly T[]): Array<T | undefined> {
  const used = new Set<number>();
  const out: Array<T | undefined> = next.map(() => undefined);
  const take = (i: number, j: number) => {
    used.add(j);
    out[i] = before[j];
  };
  const keys = before.map(json);
  next.forEach((item, i) => {
    const key = json(item);
    const j = keys.findIndex((k, at) => !used.has(at) && k === key);
    if (j !== -1) take(i, j);
  });
  next.forEach((item, i) => {
    if (out[i] !== undefined) return;
    const bind = (item as { bind?: unknown }).bind;
    if (!bind) return;
    const j = before.findIndex(
      (b, at) =>
        !used.has(at) &&
        (b as { type?: unknown }).type === (item as { type?: unknown }).type &&
        sameBind((b as { bind?: unknown }).bind, bind),
    );
    if (j !== -1) take(i, j);
  });
  next.forEach((_, i) => {
    if (out[i] === undefined && i < before.length && !used.has(i)) take(i, i);
  });
  return out;
}

/** A gradient's stops with the bindings of stops whose colour was changed by hand taken off. */
function unbindStops(stops: readonly Stop[], before: readonly Stop[] | undefined): Stop[] | null {
  if (!stops.some((stop) => stop.bind?.color)) return null;
  const prior = matchItems(stops, before ?? []);
  let changed = false;
  const out = stops.map((stop, j) => {
    if (!stop.bind?.color) return stop;
    if (prior[j] && prior[j].color === stop.color) return stop;
    changed = true;
    const { bind: _gone, ...rest } = stop;
    return rest as Stop;
  });
  return changed ? out : null;
}

/**
 * A list of paints or effects with the bindings of fields whose values were
 * changed by hand taken off (decision 0034): each item compared with the one
 * it was (`matchItems`), so reordering keeps bindings and an edit detaches
 * only the fields it changed. A paint's own opacity is its own, on top of a
 * bound colour's alpha: setting it leaves the colour bound.
 */
function unbindChanged<T extends Paint | Effect>(
  next: readonly T[],
  before: readonly T[],
): T[] | null {
  let changed = false;
  const prior = matchItems(next as readonly Item[], before as readonly Item[]);
  const out = next.map((item, i) => {
    const was = prior[i];
    let result = item as unknown as Item;
    const bind = result.bind;
    if (bind) {
      const kept: Record<string, string> = {};
      // Nothing it was: a new item's bindings are as given.
      if (!was || was.type !== result.type) Object.assign(kept, bind);
      else
        for (const [field, id] of Object.entries(bind))
          if (json(result[field]) === json(was[field])) kept[field] = id;
      if (Object.keys(kept).length !== Object.keys(bind).length) {
        changed = true;
        const { bind: _gone, ...rest } = result;
        result = Object.keys(kept).length > 0 ? { ...rest, bind: kept } : rest;
      }
    }
    if (Array.isArray(result.stops)) {
      const stops = unbindStops(
        result.stops as Stop[],
        Array.isArray(was?.stops) ? (was.stops as Stop[]) : undefined,
      );
      if (stops) {
        changed = true;
        result = { ...result, stops };
      }
    }
    return result as unknown as T;
  });
  return changed ? out : null;
}

/** The style link that drives each paint or effect list, and the style's own list. */
const STYLE_LINKS = {
  fills: "fillStyle",
  strokes: "strokeStyle",
  effects: "effectStyle",
} as const satisfies Record<string, PropName>;

/**
 * Detaches what a person's edit replaces (decision 0034), in the same
 * change, unless the same edit sets the node's bindings or links (binding a
 * variable, linking a style):
 * - a paint or effect list set to anything other than what it shows lets go
 *   of the style it links (the list written is the style's, as shown, with
 *   the edit), so the edit sticks;
 * - in paints, gradient stops and effects, the fields whose values changed
 *   lose their bindings, each item compared with the one it was (a
 *   reorder detaches nothing);
 * - a property bound in `bindings` set by hand loses that binding.
 */
export function unbindOps(doc: Doc, ops: readonly Op[]): Op[] {
  const settingBindings = new Set(
    ops.filter((o) => o.op === "set" && o.prop === "bindings").map((o) => o.id),
  );
  const settingLinks = new Set(
    ops
      .filter(
        (o) =>
          o.op === "set" &&
          (o.prop === "fillStyle" || o.prop === "strokeStyle" || o.prop === "effectStyle"),
      )
      .map((o) => `${o.id}/${(o as { prop: string }).prop}`),
  );
  const removals = new Map<string, Set<BindingKey>>();
  const out: Op[] = [];
  for (const op of ops) {
    if (op.op !== "set" || op.prop === "bindings" || settingBindings.has(op.id)) continue;
    if (
      (op.prop === "fills" || op.prop === "strokes" || op.prop === "effects") &&
      Array.isArray(op.value)
    ) {
      const node = doc.get(op.id);
      if (node) {
        const before = getProp(node.props, op.prop) as readonly (Paint | Effect)[];
        const next = unbindChanged(op.value as readonly (Paint | Effect)[], before);
        if (next) out.push({ op: "set", id: op.id, prop: op.prop, value: next });
        const link = STYLE_LINKS[op.prop];
        const linked = doc.getUnresolved(op.id)?.props[link];
        if (
          typeof linked === "string" &&
          !settingLinks.has(`${op.id}/${link}`) &&
          json(op.value) !== json(before)
        )
          out.push({ op: "set", id: op.id, prop: link, value: null });
      }
    }
    const keys = BINDING_FIELDS_BY_PROP.get(op.prop);
    if (!keys) continue;
    const node = doc.get(op.id);
    const bindings = node ? getProp(node.props, "bindings") : {};
    for (const key of keys) {
      if (!bindings[key]) continue;
      const set = removals.get(op.id) ?? new Set<BindingKey>();
      set.add(key);
      removals.set(op.id, set);
    }
  }
  for (const [id, keys] of removals) {
    const node = doc.get(id);
    if (!node) continue;
    const next = { ...getProp(node.props, "bindings") };
    for (const key of keys) delete next[key];
    out.push({
      op: "set",
      id,
      prop: "bindings",
      value: Object.keys(next).length > 0 ? next : null,
    });
  }
  return out;
}

/** Paints or effects with every variable binding taken off, values as given. */
function withoutBinds<T>(list: readonly T[]): T[] {
  return list.map((item) => {
    const { bind: _gone, ...rest } = item as Item;
    if (Array.isArray(rest.stops))
      rest.stops = (rest.stops as Stop[]).map(({ bind: _stop, ...stop }) => stop);
    return rest as unknown as T;
  });
}

/**
 * Binding `key` of a node to `variableId` (decision 0034): the binding, and
 * the fields it drives set to what it shows once bound, so what's stored
 * (what shows when the binding can't be followed) is what was shown, not
 * an older value. Empty when the node can't take it.
 */
export function variableBindOps(doc: Doc, id: string, key: BindingKey, variableId: string): Op[] {
  const node = doc.get(id);
  const raw = doc.getUnresolved(id);
  if (!node || !raw) return [];
  // With its unit where decision 0034 has one, so it reads the same wherever it goes.
  const bindings = { ...getProp(raw.props, "bindings"), [key]: bindingRef(key, variableId) };
  const ops: Op[] = [{ op: "set", id, prop: "bindings", value: bindings }];
  const bound = doc.tokens.resolver.resolve({
    ...node,
    props: { ...node.props, bindings },
  });
  for (const prop of BINDING_FIELDS[key].props) {
    const value = bound.props[prop];
    if (value !== undefined && json(value) !== json(raw.props[prop]))
      ops.push({ op: "set", id, prop, value: value as never });
  }
  return ops;
}

/**
 * Detaching `key` from a node by choice (decision 0034): the binding goes,
 * and the fields it drove keep what they show now, whatever mode or value
 * gave it. For `fill` and `stroke`, the variables the paints themselves bind
 * (their colours, opacities and gradient stops) go too, and a linked style
 * with them: the paints are kept as shown. Empty when nothing's bound.
 */
export function variableDetachOps(doc: Doc, id: string, key: BindingKey): Op[] {
  const node = doc.get(id);
  const raw = doc.getUnresolved(id);
  if (!node || !raw) return [];
  const bindings = getProp(raw.props, "bindings");
  const ops: Op[] = [];
  const prop = key === "fill" ? "fills" : key === "stroke" ? "strokes" : null;
  const link = key === "fill" ? "fillStyle" : key === "stroke" ? "strokeStyle" : null;
  const shown = prop ? (getProp(node.props, prop) as readonly Paint[]) : [];
  const paintsBound =
    prop !== null &&
    (shown.some((p) => (p as Item).bind || Array.isArray((p as Item).stops)) ||
      (link !== null && typeof raw.props[link] === "string"));
  if (!bindings[key] && !paintsBound) return [];
  if (bindings[key]) {
    const next = { ...bindings };
    delete next[key];
    ops.push({
      op: "set",
      id,
      prop: "bindings",
      value: Object.keys(next).length > 0 ? next : null,
    });
  }
  if (prop) {
    const value = withoutBinds(shown);
    if (json(value) !== json(raw.props[prop])) ops.push({ op: "set", id, prop, value });
    if (link && typeof raw.props[link] === "string")
      ops.push({ op: "set", id, prop: link, value: null });
    return ops;
  }
  for (const field of BINDING_FIELDS[key].props) {
    const value = node.props[field];
    if (value !== undefined && json(value) !== json(raw.props[field]))
      ops.push({ op: "set", id, prop: field, value: value as never });
  }
  return ops;
}

/** CSS custom property name for a variable: "brand/500" → "--brand-500". */
export function cssVariableName(name: string): string {
  return `--${name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")}`;
}

function cssValue(value: string | number | boolean, type: VariableType): string {
  if (typeof value === "boolean") return value ? "1" : "0";
  if (type === "number") return typeof value === "number" ? `${value}px` : String(value);
  if (type === "string") return JSON.stringify(String(value));
  return String(value);
}

/**
 * CSS for every variable: the first mode of each collection on `:root`, and
 * each further mode under `[data-<collection>="<mode>"]`. Aliases become
 * `var()` references, so the output mirrors the token structure.
 */
export function exportCss(doc: Doc): string {
  const lines: string[] = [];
  for (const collection of listCollections(doc)) {
    const modes = getProp(collection.props, "modes");
    const attr = cssVariableName(getProp(collection.props, "name") || "tokens").slice(2);
    modes.forEach((mode, i) => {
      const selector =
        i === 0
          ? ":root"
          : `[data-${attr}="${mode.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}"]`;
      const body: string[] = [];
      for (const variable of variablesIn(doc, collection.id)) {
        const type = getProp(variable.props, "variableType");
        const value = getProp(variable.props, "values")[mode.id];
        if (value === undefined) continue;
        const name = cssVariableName(getProp(variable.props, "name"));
        if (typeof value === "object") {
          const target = doc.get(value.alias);
          if (target)
            body.push(`  ${name}: var(${cssVariableName(getProp(target.props, "name"))});`);
        } else {
          body.push(`  ${name}: ${cssValue(value, type)};`);
        }
      }
      if (body.length > 0) lines.push(`${selector} {`, ...body, "}");
    });
  }
  return lines.join("\n");
}

/**
 * W3C Design Tokens (DTCG) JSON: groups from "/" in names, `$type` and
 * `$value`, aliases as `{group.token}`, and extra modes under
 * `$extensions["drawpane.modes"]`.
 */
export function exportDtcg(doc: Doc): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  const dotted = (name: string) =>
    name
      .split("/")
      .map((p) => p.trim())
      .filter(Boolean)
      .join(".");
  for (const collection of listCollections(doc)) {
    const modes = getProp(collection.props, "modes");
    for (const variable of variablesIn(doc, collection.id)) {
      const type = getProp(variable.props, "variableType");
      const values = getProp(variable.props, "values");
      const toDtcg = (value: VariableValue | undefined) => {
        if (value === undefined) return undefined;
        if (typeof value === "object") {
          const target = doc.get(value.alias);
          return target ? `{${dotted(getProp(target.props, "name"))}}` : undefined;
        }
        return type === "number" && typeof value === "number" ? `${value}px` : value;
      };
      const path = getProp(variable.props, "name")
        .split("/")
        .map((p) => p.trim())
        .filter(Boolean);
      let group = root;
      for (const part of path.slice(0, -1)) {
        group[part] ??= {};
        group = group[part] as Record<string, unknown>;
      }
      const token: Record<string, unknown> = {
        $type:
          type === "color"
            ? "color"
            : type === "number"
              ? "dimension"
              : type === "boolean"
                ? "boolean"
                : "string",
        $value: toDtcg(values[modes[0]?.id ?? ""]),
      };
      const description = getProp(variable.props, "description");
      if (description) token.$description = description;
      if (modes.length > 1) {
        token.$extensions = {
          "drawpane.modes": Object.fromEntries(modes.map((m) => [m.name, toDtcg(values[m.id])])),
        };
      }
      group[path.at(-1) ?? variable.id] = token;
    }
  }
  // Text styles, as typography tokens, grouped by their names the same way.
  for (const style of textStyles(doc)) {
    const path = getProp(style.props, "name")
      .split("/")
      .map((p) => p.trim())
      .filter(Boolean);
    let group = root;
    for (const part of path.slice(0, -1)) {
      group[part] ??= {};
      group = group[part] as Record<string, unknown>;
    }
    group[path.at(-1) ?? style.id] = typographyToken(style);
  }
  return root;
}
