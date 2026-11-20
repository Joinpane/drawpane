/**
 * Variant properties bound to variables: the variant a copy shows in the
 * modes where it is placed.
 *
 * A component set can switch a property (Light and Dark, say) by a string
 * or boolean variable: an instance binds `VARIANT_PROPERTIES` to Figma's
 * `RESOLVE_VARIANT` expression, a map from each bound property (its
 * definition's id, and its name) to a variable. Where the instance is, the
 * variable takes its value in the mode of its collection there (the
 * nearest layer around it that sets one, else the collection's first
 * mode), following aliases, each in its own collection's mode there. The
 * instance shows the variant of its set whose properties are its own with
 * the bound ones set to those values; when the set has none, or doesn't
 * define a bound property, it keeps its own. A boolean names the value `true` or `false`, in whatever case the set
 * spells it.
 *
 * Figma saves the variant it shows on each record, so a layer saved in the
 * file comes in right as it is. What it doesn't save is the variant a copy's
 * nested instances show: a dark board's popover copies a main whose
 * material instance is saved Light. So only instances inside a copy (or in
 * slot content, shown in a copy) are resolved, while Open Pencil builds the
 * copy where it is placed (`resolveVariant`, patched into its interpreter:
 * see `patches/@open-pencil__fig@0.16.0.patch`).
 *
 * A large file is built a few pages at a time, each pass holding only the
 * components its pages name. The variant a binding chooses isn't named
 * anywhere, so each binding first lists the variants it could choose (every
 * variant of the sets that define a property it binds, in
 * `variantPropertiesOptions`), which the patched dependency walk adds to
 * the pass.
 */
import type { RawGuid, RawRecord } from "./raw";
import { guidString } from "./raw";
import { VARIANT_BINDING } from "./variables";

/** Where a binding's possible variants are listed, for the dependency walk. */
export const VARIANT_OPTIONS = "variantPropertiesOptions";

/** A variable binding's saved value, as the records hold it. */
interface Data {
  readonly dataType?: string;
  readonly value?: {
    readonly alias?: Reference;
    readonly textValue?: string;
    readonly boolValue?: boolean;
    readonly floatValue?: number;
    readonly expressionValue?: {
      readonly expressionFunction?: string;
      readonly expressionArguments?: readonly {
        readonly value?: {
          readonly mapValue?: {
            readonly values?: readonly {
              readonly key?: string;
              readonly guidKey?: RawGuid;
              readonly value?: Data;
            }[];
          };
        };
      }[];
    };
  };
}

/** A variable, collection or style by guid, or by its library key. */
interface Reference {
  readonly guid?: RawGuid;
  readonly assetRef?: { readonly key?: string };
}

/** A layer's explicit modes: each collection it sets, and the mode it sets it to. */
export interface ModeMap {
  readonly entries?: readonly {
    readonly variableSetID?: Reference;
    readonly variableModeID?: RawGuid;
  }[];
}

/** What the patched Open Pencil hands over for an instance with a bound variant. */
export interface VariantContext {
  /** The component the instance shows so far (after swaps and properties). */
  readonly symbolId: RawGuid;
  /** Its variant bindings, the record's own first, then its owners' overrides (outer last). */
  readonly bindings: readonly unknown[];
  /**
   * The records being expanded, outermost first, ending with the instance:
   * each with the mode maps set on it, the one that wins first.
   */
  readonly chain: readonly { readonly id: string; readonly modes: readonly unknown[] }[];
}

export type VariantResolver = (context: VariantContext) => RawGuid | undefined;

interface Variable {
  readonly type?: string;
  readonly variableSetID?: Reference;
  readonly variableDataValues?: {
    readonly entries?: readonly { readonly modeID?: RawGuid; readonly variableData?: Data }[];
  };
}

interface Collection {
  readonly guid?: RawGuid;
  readonly variableSetModes?: readonly { readonly id?: RawGuid }[];
}

interface Variant {
  readonly componentPropDefs?: readonly {
    readonly id?: RawGuid;
    readonly name?: string;
    readonly type?: string;
  }[];
  readonly variantPropSpecs?: readonly { readonly propDefId?: RawGuid; readonly value?: string }[];
}

/** How deep aliases are followed. */
const MAX_ALIASES = 16;

/**
 * The resolver for one file's records (the same index the reader built,
 * after `prepareVariables` kept the bindings aside).
 */
export function variantResolver(records: ReadonlyMap<string, RawRecord>): VariantResolver {
  const byKey = new Map<string, RawRecord>();
  const children = new Map<string, RawRecord[]>();
  for (const r of records.values()) {
    const key = (r as { key?: unknown }).key;
    if (typeof key === "string" && (r.type === "VARIABLE" || r.type === "VARIABLE_SET"))
      byKey.set(`${r.type}:${key}`, r);
    const parent = r.parentIndex?.guid;
    if (parent && r.type === "SYMBOL") {
      const id = guidString(parent);
      const list = children.get(id);
      if (list) list.push(r);
      else children.set(id, [r]);
    }
  }
  const find = (type: "VARIABLE" | "VARIABLE_SET", ref: Reference | undefined) => {
    const found = ref?.guid
      ? records.get(guidString(ref.guid))
      : ref?.assetRef?.key
        ? byKey.get(`${type}:${ref.assetRef.key}`)
        : undefined;
    return found?.type === type ? found : undefined;
  };

  /**
   * Mode set for a collection in a map: the mode id, `null` when an entry
   * explicitly clears the collection (omits `variableModeID`), or `undefined`
   * when the map does not mention the collection.
   */
  const modeIn = (map: unknown, collection: RawRecord): string | null | undefined => {
    let result: string | null | undefined;
    for (const e of (map as ModeMap | undefined)?.entries ?? []) {
      if (find("VARIABLE_SET", e.variableSetID) !== collection) continue;
      result = e.variableModeID ? guidString(e.variableModeID) : null;
    }
    return result;
  };

  /**
   * The collection's mode where the chain ends: the nearest record that
   * sets one (an instance before the component it expands, as its own
   * setting wins over its main's, honoring per-collection clears just like
   * `mergeVariableModeBySetMaps`), then the layers around the outermost
   * record in the file, then the collection's first mode.
   */
  const modeAt = (chain: VariantContext["chain"], collection: RawRecord): string | undefined => {
    const set = (entry: VariantContext["chain"][number]): string | null | undefined => {
      for (const map of entry.modes) {
        const mode = modeIn(map, collection);
        if (mode !== undefined) return mode;
      }
      return undefined;
    };
    for (let i = chain.length - 1; i >= 0; i--) {
      const entry = chain[i] as VariantContext["chain"][number];
      const outer = chain[i - 1];
      if (outer && isBase(entry.id, outer.id)) {
        const outerMode = set(outer);
        if (outerMode !== undefined) {
          if (outerMode !== null) return outerMode;
          i--;
          continue;
        }
        const baseMode = set(entry);
        if (typeof baseMode === "string") return baseMode;
        i--;
        continue;
      }
      const mode = set(entry);
      if (typeof mode === "string") return mode;
    }
    const first = chain[0];
    let parent = first ? records.get(first.id)?.parentIndex?.guid : undefined;
    for (let depth = 0; parent && depth < 1000; depth++) {
      const record = records.get(guidString(parent));
      if (!record) break;
      const mode = modeIn(
        (record as { variableModeBySetMap?: unknown }).variableModeBySetMap,
        collection,
      );
      if (typeof mode === "string") return mode;
      parent = record.parentIndex?.guid;
    }
    const modes = (collection as Collection).variableSetModes;
    return modes?.[0]?.id ? guidString(modes[0].id) : undefined;
  };

  /** Whether `inner` is the component `outer` (an instance) expands. */
  const isBase = (inner: string, outer: string) =>
    records.get(inner)?.type === "SYMBOL" && records.get(outer)?.type === "INSTANCE";

  /** A bound value where the chain ends, aliases followed. */
  const boundValue = (
    data: Data | undefined,
    chain: VariantContext["chain"],
    depth = 0,
  ): string | boolean | undefined => {
    const value = data?.value;
    if (!value || depth > MAX_ALIASES) return undefined;
    if (value.alias) {
      const variable = find("VARIABLE", value.alias) as (RawRecord & Variable) | undefined;
      const collection = find("VARIABLE_SET", variable?.variableSetID);
      if (!variable || !collection) return undefined;
      const mode = modeAt(chain, collection);
      const entry = variable.variableDataValues?.entries?.find(
        (e) => e.modeID && guidString(e.modeID) === mode,
      );
      return boundValue(entry?.variableData, chain, depth + 1);
    }
    if (typeof value.textValue === "string") return value.textValue;
    if (typeof value.boolValue === "boolean") return value.boolValue;
    if (typeof value.floatValue === "number") return String(value.floatValue);
    return undefined;
  };

  return ({ symbolId, bindings, chain }) => {
    // A record outside any copy shows what Figma saved for it.
    if (!chain.slice(0, -1).some((e) => records.get(e.id)?.type === "INSTANCE")) return undefined;
    const symbol = records.get(guidString(symbolId)) as (RawRecord & Variant) | undefined;
    const setGuid = symbol?.parentIndex?.guid;
    const set = setGuid ? (records.get(guidString(setGuid)) as RawRecord & Variant) : undefined;
    const defs = set?.componentPropDefs?.filter((d) => d.type === "VARIANT" && d.id);
    if (symbol?.type !== "SYMBOL" || !set || !defs?.length) return undefined;

    const wanted = new Map<string, string>();
    for (const spec of symbol.variantPropSpecs ?? [])
      if (spec.propDefId && typeof spec.value === "string")
        wanted.set(guidString(spec.propDefId), spec.value);
    const variants = (children.get(guidString(setGuid as RawGuid)) ?? []) as (RawRecord &
      Variant)[];
    let bound = false;
    for (const binding of bindings) {
      const expression = (binding as Data | undefined)?.value?.expressionValue;
      if (expression?.expressionFunction !== "RESOLVE_VARIANT") continue;
      for (const argument of expression.expressionArguments ?? [])
        for (const item of argument.value?.mapValue?.values ?? []) {
          const def = defs.find(
            (d) => item.guidKey && guidString(d.id as RawGuid) === guidString(item.guidKey),
          );
          if (!def) continue;
          const value = boundValue(item.value, chain);
          if (value === undefined) continue;
          const id = guidString(def.id as RawGuid);
          wanted.set(id, typeof value === "boolean" ? spelled(variants, id, value) : value);
          bound = true;
        }
    }
    if (!bound) return undefined;
    const match = variants.find((v) => {
      const specs = v.variantPropSpecs ?? [];
      return (
        specs.length === wanted.size &&
        specs.every((s) => s.propDefId && wanted.get(guidString(s.propDefId)) === s.value)
      );
    });
    return match?.guid;
  };
}

/** A boolean as the set spells that property's value ("true", "True", ...). */
function spelled(variants: readonly Variant[], id: string, value: boolean): string {
  const text = String(value);
  for (const v of variants)
    for (const s of v.variantPropSpecs ?? [])
      if (s.propDefId && guidString(s.propDefId) === id && s.value?.toLowerCase() === text)
        return s.value;
  return text;
}

/** The variant property definitions a binding sets, by id. */
function boundProperties(binding: unknown): string[] {
  const out: string[] = [];
  const expression = (binding as Data | undefined)?.value?.expressionValue;
  if (expression?.expressionFunction !== "RESOLVE_VARIANT") return out;
  for (const argument of expression.expressionArguments ?? [])
    for (const item of argument.value?.mapValue?.values ?? [])
      if (item.guidKey) out.push(guidString(item.guidKey));
  return out;
}

/**
 * Lists on each kept variant binding (records' and overrides') the variants
 * it could choose: every variant of each set that defines a property it
 * binds. Run after `prepareVariables`.
 */
export function prepareVariantOptions(records: readonly unknown[]): void {
  type Fields = Record<string, unknown>;
  const all = records as Fields[];
  /** The variants of each set, by the set's guid. */
  const variantsOf = new Map<string, RawGuid[]>();
  for (const r of all) {
    const parent = (r as RawRecord).parentIndex?.guid;
    const g = (r as RawRecord).guid;
    if (r.type !== "SYMBOL" || !parent || !g) continue;
    const key = guidString(parent);
    const list = variantsOf.get(key);
    if (list) list.push(g);
    else variantsOf.set(key, [g]);
  }
  /** Each variant property definition's id: the variants of the sets defining it. */
  const byProperty = new Map<string, RawGuid[]>();
  for (const r of all) {
    const g = (r as RawRecord).guid;
    const variants = g ? variantsOf.get(guidString(g)) : undefined;
    if (!variants) continue;
    for (const def of (r as Variant).componentPropDefs ?? [])
      if (def.type === "VARIANT" && def.id) {
        const key = guidString(def.id);
        byProperty.set(key, [...(byProperty.get(key) ?? []), ...variants]);
      }
  }
  const list = (fields: Fields) => {
    if (!fields[VARIANT_BINDING]) return;
    const options = boundProperties(fields[VARIANT_BINDING]).flatMap(
      (p) => byProperty.get(p) ?? [],
    );
    if (options.length > 0) fields[VARIANT_OPTIONS] = options;
  };
  for (const r of all) {
    if (r.type !== "INSTANCE") continue;
    list(r);
    const overrides = (r.symbolData as Fields | undefined)?.symbolOverrides;
    if (Array.isArray(overrides)) for (const o of overrides) list(o as Fields);
  }
}
