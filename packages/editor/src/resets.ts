/**
 * What resetting an override restores besides the value (decision 0035,
 * item 3): a value is stored with what it depends on, and a reset puts all
 * of it back as its main has it.
 *
 * - A variable bound to the property (`bindings`): setting a value by hand
 *   detached it, so resetting the value binds it again, as the main layer
 *   is bound. The layer's other bindings stay as they are.
 * - A text style (`textStyle`): editing typography by hand detached it, so
 *   resetting that typography restores the main layer's style, once no other
 *   typography on the layer stays changed.
 */
import {
  type BindingKey,
  type BindingRef,
  boundaryDrivenProps,
  getProp,
  isMainNode,
  type NodeRecord,
  type Op,
  ROOT_LOCAL_PROPS,
  sameValue,
} from "@drawpane/model";
import type { Doc } from "./doc";
import { STYLE_PROPS } from "./text-styles";
import { KEYS_BY_PROP } from "./variables";

/**
 * The operations that restore what `props` of a copy layer depend on, and
 * the layer's overrides after the reset (`props` and what's restored with
 * them taken out). The values themselves are restored by sync.
 */
export function resetDependentOps(
  doc: Doc,
  node: NodeRecord,
  props: readonly string[],
): { ops: Op[]; overrides: string[] } {
  const ops: Op[] = [];
  let overrides = getProp(node.props, "overrides").filter((p) => !props.includes(p));
  const sourceId = getProp(node.props, "mirrors");
  const source = sourceId ? doc.get(sourceId) : undefined;
  if (!source) return { ops, overrides };
  const baseline = baselineOf(doc, node, source);

  // Bindings: the reset keys back as the layer it follows has them, the others as they are.
  const keys = props.flatMap((p) => KEYS_BY_PROP.get(p) ?? []) as BindingKey[];
  if (keys.length > 0) {
    const current = getProp(node.props, "bindings");
    // What the layer follows for each binding's field, and what it follows for all of them.
    const wantedFor = (key: BindingKey) =>
      getProp(baseline(BINDING_PROP.get(key) ?? "").props, "bindings")[key];
    const wanted: Partial<Record<BindingKey, BindingRef>> = {};
    for (const key of new Set([
      ...Object.keys(getProp(source.props, "bindings")),
      ...Object.keys(getProp(baseline("").props, "bindings")),
    ]) as Set<BindingKey>) {
      const variable = wantedFor(key);
      if (variable) wanted[key] = variable;
    }
    const next: Partial<Record<BindingKey, BindingRef>> = { ...current };
    for (const key of keys) {
      const variable = wantedFor(key);
      if (variable) next[key] = variable;
      else delete next[key];
    }
    if (!sameValue(next, current))
      ops.push({
        op: "set",
        id: node.id,
        prop: "bindings",
        value: Object.keys(next).length > 0 ? next : null,
      });
    // Once its bindings are the main layer's again, they follow it; until then they're its own.
    const same = sameValue(next, wanted);
    if (same) overrides = overrides.filter((p) => p !== "bindings");
    else if (!sameValue(current, next) && !overrides.includes("bindings"))
      overrides = [...overrides, "bindings"].sort();
  }

  // A text style detached by editing typography by hand comes back with the last of it.
  if (node.type === "text" && props.some((p) => STYLE_PROPS.has(p))) {
    const style = getProp(baseline("textStyle").props, "textStyle");
    if (
      style &&
      getProp(node.props, "textStyle") !== style &&
      !overrides.some((p) => STYLE_PROPS.has(p))
    ) {
      ops.push({ op: "set", id: node.id, prop: "textStyle", value: style });
      overrides = overrides.filter((p) => p !== "textStyle");
    }
  }
  return { ops, overrides };
}

/** Each binding key's field (the inverse of `KEYS_BY_PROP`). */
const BINDING_PROP = new Map<BindingKey, string>();
for (const [prop, keys] of KEYS_BY_PROP) for (const key of keys) BINDING_PROP.set(key, prop);

/**
 * What a copy layer follows for a field, as sync does (decision 0035,
 * item 3): its main layer; but a nested instance swapped for another
 * component follows that component for everything except where it sits
 * (its root-local fields) and the fields the outer component's
 * properties drive, which stay its main layer's.
 */
function baselineOf(doc: Doc, node: NodeRecord, source: NodeRecord): (prop: string) => NodeRecord {
  const own = getProp(node.props, "instanceOf");
  const swapped =
    own &&
    own !== getProp(source.props, "instanceOf") &&
    getProp(node.props, "overrides").includes("instanceOf")
      ? doc.get(own)
      : undefined;
  if (!swapped || !isMainNode(swapped)) return () => source;
  const boundary = new Set([...ROOT_LOCAL_PROPS, ...boundaryDrivenProps(source)]);
  return (prop) => (boundary.has(prop) ? source : swapped);
}
