/**
 * Variables (design tokens): collections of named values with one value per
 * mode, bound to layer properties.
 *
 * Bindings are materialized like components: a bound property always holds
 * the resolved value, written by the client that changed the variable, the
 * mode or the binding, in the same transaction. The renderer, layout and
 * exports only ever see plain values; `bindings` remembers where they came
 * from.
 */
import {
  type BindingKey,
  getProp,
  type NodeRecord,
  type Op,
  type Paint,
  type PropName,
  ROOT_ID,
  type VariableValue,
} from "@drawpane/model";
import type { Doc } from "./doc";
import { textStyles, typographyToken } from "./text-styles";

export type VariableType = "color" | "number" | "string";

/** Which property a binding key drives, and the variable type it takes. */
export const BINDING_TARGETS: Readonly<Record<BindingKey, { prop: PropName; type: VariableType }>> =
  {
    fill: { prop: "fills", type: "color" },
    stroke: { prop: "strokes", type: "color" },
    width: { prop: "width", type: "number" },
    height: { prop: "height", type: "number" },
    gap: { prop: "gap", type: "number" },
    rowGap: { prop: "rowGap", type: "number" },
    paddingTop: { prop: "paddingTop", type: "number" },
    paddingRight: { prop: "paddingRight", type: "number" },
    paddingBottom: { prop: "paddingBottom", type: "number" },
    paddingLeft: { prop: "paddingLeft", type: "number" },
    cornerRadius: { prop: "cornerRadius", type: "number" },
    strokeWeight: { prop: "strokeWeight", type: "number" },
    opacity: { prop: "opacity", type: "number" },
    fontSize: { prop: "fontSize", type: "number" },
    fontFamily: { prop: "fontFamily", type: "string" },
    characters: { prop: "characters", type: "string" },
  };

/** Binding keys that drive a given property (for detaching when it's edited by hand). */
const KEYS_BY_PROP = new Map<string, BindingKey[]>();
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
 * The mode of `collectionId` that applies at `nodeId`: the nearest frame or
 * page that sets one, else the collection's first mode.
 */
export function activeMode(doc: Doc, nodeId: string, collectionId: string): string | null {
  const collection = doc.get(collectionId);
  if (collection?.type !== "collection") return null;
  const modes = getProp(collection.props, "modes");
  for (
    let node = doc.get(nodeId);
    node;
    node = node.parent === ROOT_ID ? undefined : doc.get(node.parent)
  ) {
    if (node.type === "frame" || node.type === "page") {
      const mode = getProp(node.props, "variableModes")[collectionId];
      if (mode && modes.some((m) => m.id === mode)) return mode;
    }
  }
  return modes[0]?.id ?? null;
}

const MAX_ALIAS_DEPTH = 16;

/**
 * A variable's value at `nodeId` (or in its collection's first mode when no
 * node is given), following aliases. Undefined when unset, missing or cyclic.
 */
export function resolveVariable(
  doc: Doc,
  variableId: string,
  nodeId?: string,
): string | number | undefined {
  let current = doc.get(variableId);
  for (let depth = 0; current && depth < MAX_ALIAS_DEPTH; depth++) {
    if (current.type !== "variable") return undefined;
    const collection = current.parent;
    const mode = nodeId
      ? activeMode(doc, nodeId, collection)
      : (getProp(doc.get(collection)?.props ?? {}, "modes")[0]?.id ?? null);
    const values = getProp(current.props, "values");
    const value: VariableValue | undefined =
      (mode ? values[mode] : undefined) ?? Object.values(values)[0];
    if (value === undefined) return undefined;
    if (typeof value === "object") {
      current = doc.get(value.alias);
      continue;
    }
    return value;
  }
  return undefined;
}

/** Writes a resolved colour into the first visible solid paint, adding one if needed. */
function withColor(paints: readonly Paint[], color: string): Paint[] {
  const index = paints.findIndex((p) => p.type === "solid");
  if (index === -1) return [{ type: "solid", color }, ...paints];
  return paints.map((p, i) => (i === index && p.type === "solid" ? { ...p, color } : p));
}

/** Operations that make a node's bound properties hold their resolved values. */
export function resolveBindingOps(doc: Doc, node: NodeRecord): Op[] {
  const ops: Op[] = [];
  const bindings = getProp(node.props, "bindings");
  for (const [key, variableId] of Object.entries(bindings) as Array<[BindingKey, string]>) {
    const target = BINDING_TARGETS[key];
    if (!target) continue;
    const value = resolveVariable(doc, variableId, node.id);
    if (value === undefined) continue;
    if (target.type === "color") {
      if (typeof value !== "string" || !/^#[0-9a-f]{6}([0-9a-f]{2})?$/.test(value)) continue;
      const current = getProp(node.props, target.prop as "fills" | "strokes");
      const next = withColor(current, value);
      if (JSON.stringify(next) !== JSON.stringify(current))
        ops.push({ op: "set", id: node.id, prop: target.prop, value: next });
      continue;
    }
    if (target.type === "number" && typeof value !== "number") continue;
    if (target.type === "string" && typeof value !== "string") continue;
    let resolved: string | number = value;
    if (key === "opacity" && typeof resolved === "number")
      resolved = Math.min(1, Math.max(0, resolved > 1 ? resolved / 100 : resolved));
    if (node.props[target.prop] !== resolved)
      ops.push({ op: "set", id: node.id, prop: target.prop, value: resolved });
  }
  return ops;
}

const boundCache = new WeakMap<Doc, { version: number; byVariable: Map<string, string[]> }>();

/** Ids of nodes bound to each variable, cached per document version. */
function nodesBoundTo(doc: Doc, variableId: string): readonly string[] {
  let cached = boundCache.get(doc);
  if (!cached || cached.version !== doc.version) {
    const byVariable = new Map<string, string[]>();
    for (const node of doc.nodes()) {
      const bindings = node.props.bindings;
      if (!bindings) continue;
      for (const id of Object.values(bindings)) {
        if (!id) continue;
        const list = byVariable.get(id) ?? [];
        list.push(node.id);
        byVariable.set(id, list);
      }
    }
    cached = { version: doc.version, byVariable };
    boundCache.set(doc, cached);
  }
  return cached.byVariable.get(variableId) ?? [];
}

/** Variables whose value depends (through aliases) on `variableId`, including itself. */
function dependents(doc: Doc, variableId: string): Set<string> {
  const out = new Set([variableId]);
  let grew = true;
  const variables = allVariables(doc);
  while (grew) {
    grew = false;
    for (const v of variables) {
      if (out.has(v.id)) continue;
      const values = Object.values(getProp(v.props, "values"));
      if (values.some((value) => typeof value === "object" && out.has(value.alias))) {
        out.add(v.id);
        grew = true;
      }
    }
  }
  return out;
}

/**
 * Re-resolution operations after `ops` applied: for nodes whose bindings,
 * mode context or bound variables changed, and for bound nodes whose bound
 * property was overwritten by a derived write (an instance sync).
 */
export function variableFixupOps(doc: Doc, ops: readonly Op[]): Op[] {
  const candidates = new Set<string>();
  const addSubtree = (id: string) => {
    const stack = [id];
    while (stack.length > 0) {
      const current = stack.pop() as string;
      const node = doc.get(current);
      if (!node) continue;
      if (node.props.bindings && Object.keys(node.props.bindings).length > 0)
        candidates.add(current);
      stack.push(...doc.childIds(current));
    }
  };
  const addVariable = (variableId: string) => {
    for (const id of dependents(doc, variableId))
      for (const nodeId of nodesBoundTo(doc, id)) candidates.add(nodeId);
  };

  for (const op of ops) {
    const node = doc.get(op.id);
    if (op.op === "delete") {
      // A deleted variable leaves its bound nodes with their last value.
      continue;
    }
    if (!node) continue;
    if (node.type === "variable") {
      addVariable(node.id);
      continue;
    }
    if (node.type === "collection") {
      for (const v of variablesIn(doc, node.id)) addVariable(v.id);
      continue;
    }
    if (op.op === "move" || (op.op === "set" && op.prop === "variableModes")) {
      addSubtree(node.id);
      continue;
    }
    if (op.op === "create") {
      addSubtree(node.id);
      continue;
    }
    if (op.op === "set" && node.props.bindings && Object.keys(node.props.bindings).length > 0)
      candidates.add(node.id);
  }

  const out: Op[] = [];
  for (const id of candidates) {
    const node = doc.get(id);
    if (node) out.push(...resolveBindingOps(doc, node));
  }
  return out;
}

/**
 * Detaches bindings when a person sets a bound property by hand, unless the
 * same edit also sets the node's bindings (binding a variable sets both).
 */
export function unbindOps(doc: Doc, ops: readonly Op[]): Op[] {
  const settingBindings = new Set(
    ops.filter((o) => o.op === "set" && o.prop === "bindings").map((o) => o.id),
  );
  const removals = new Map<string, Set<BindingKey>>();
  for (const op of ops) {
    if (op.op !== "set" || op.prop === "bindings" || settingBindings.has(op.id)) continue;
    const keys = KEYS_BY_PROP.get(op.prop);
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
  const out: Op[] = [];
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

function cssValue(value: string | number, type: VariableType): string {
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
        $type: type === "color" ? "color" : type === "number" ? "dimension" : "string",
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
