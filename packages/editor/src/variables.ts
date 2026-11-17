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

/** A list of paints or effects with the bindings of fields whose values were changed by hand taken off. */
function unbindChanged<T extends Paint | Effect>(
  next: readonly T[],
  before: readonly T[],
): T[] | null {
  let changed = false;
  const out = next.map((item, i) => {
    const prior = before[i] as (T & { bind?: Record<string, string> }) | undefined;
    const bind = (item as { bind?: Record<string, string> }).bind;
    let result = item;
    if (bind && prior && prior.type === item.type) {
      const kept: Record<string, string> = {};
      for (const [field, id] of Object.entries(bind)) {
        const a = (item as Record<string, unknown>)[field];
        const b = (prior as Record<string, unknown>)[field];
        if (JSON.stringify(a) === JSON.stringify(b)) kept[field] = id;
      }
      if (Object.keys(kept).length !== Object.keys(bind).length) {
        changed = true;
        const { bind: _gone, ...rest } = item as T & { bind?: unknown };
        result = (Object.keys(kept).length > 0 ? { ...rest, bind: kept } : rest) as T;
      }
    }
    const stops = (result as { stops?: Array<{ color: string; bind?: { color?: string } }> }).stops;
    const priorStops = (prior as { stops?: Array<{ color: string }> } | undefined)?.stops;
    if (
      stops &&
      priorStops &&
      stops.some((stop, j) => stop.bind?.color && stop.color !== priorStops[j]?.color)
    ) {
      changed = true;
      result = {
        ...result,
        stops: stops.map((stop, j) => {
          if (!stop.bind?.color || stop.color === priorStops[j]?.color) return stop;
          const { bind: _gone, ...rest } = stop;
          return rest;
        }),
      } as T;
    }
    return result;
  });
  return changed ? out : null;
}

/**
 * Detaches bindings when a person sets a bound property by hand, unless the
 * same edit also sets the node's bindings (binding a variable sets both).
 * For paints and effects, only the fields whose values changed lose their
 * binding (compared with what they showed, resolved).
 */
export function unbindOps(doc: Doc, ops: readonly Op[]): Op[] {
  const settingBindings = new Set(
    ops.filter((o) => o.op === "set" && o.prop === "bindings").map((o) => o.id),
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
