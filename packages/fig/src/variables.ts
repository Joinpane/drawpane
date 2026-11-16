/**
 * Variable bindings Open Pencil can't evaluate, taken out before it reads.
 *
 * A layer can bind a property to a variable, or to an expression of
 * variables (Figma's conditionals and arithmetic). Open Pencil 0.16 follows
 * a binding that is a constant, a variable, a variable shown as text, or a
 * variable times constants, and throws on any other expression (`IS_TRUTHY`,
 * `ADDITION`, ...) with no way to skip it. Variables don't come across into
 * Drawpane, and Figma saves each layer's value with the layer, so such a
 * binding is dropped and the layer keeps its saved value.
 */
import type { NodeChange } from "@open-pencil/kiwi/fig/codec";

type Record_ = Record<string, unknown>;

/** How deep Open Pencil follows an expression before giving up. */
const MAX_DEPTH = 32;

interface Data {
  dataType?: string;
  value?: {
    alias?: unknown;
    floatValue?: unknown;
    expressionValue?: { expressionFunction?: string; expressionArguments?: Data[] };
  };
}

/** Whether the bound value refers to a variable; throws where Open Pencil would. */
function linear(data: Data | undefined, depth: number): { reference: boolean } | undefined {
  if (depth > MAX_DEPTH) throw new Error("too deep");
  const value = data?.value;
  if (data?.dataType === "EXPRESSION" && !value?.expressionValue) throw new Error("no value");
  if (!value) return undefined;
  if (value.alias) return { reference: true };
  if (typeof value.floatValue === "number" && Number.isFinite(value.floatValue))
    return { reference: false };
  const expression = value.expressionValue;
  if (!expression) return undefined;
  const args = expression.expressionArguments ?? [];
  if (expression.expressionFunction === "STRINGIFY") {
    if (args.length !== 1 || !args[0]?.value?.alias) throw new Error("bad STRINGIFY");
    return { reference: true };
  }
  if (expression.expressionFunction !== "MULTIPLY" || args.length === 0)
    throw new Error("unsupported");
  let reference = false;
  for (const arg of args) {
    const term = linear(arg, depth + 1);
    if (!term || (reference && term.reference)) throw new Error("not linear");
    reference ||= term.reference;
  }
  return { reference };
}

const evaluable = (data: unknown): boolean => {
  try {
    linear(data as Data | undefined, 0);
    return true;
  } catch {
    return false;
  }
};

/** Drops the entries of one binding map Open Pencil can't evaluate; how many it dropped. */
function pruneMap(map: unknown): number {
  const entries = (map as { entries?: unknown } | undefined)?.entries;
  if (!Array.isArray(entries)) return 0;
  const kept = entries.filter((e) => evaluable((e as Record_ | null)?.variableData));
  const dropped = entries.length - kept.length;
  if (dropped > 0) (map as { entries: unknown[] }).entries = kept;
  return dropped;
}

/** A record, an override or a text run, and everything nested in it. */
function prune(fields: Record_): number {
  let dropped = pruneMap(fields.variableConsumptionMap) + pruneMap(fields.parameterConsumptionMap);
  const table = (fields.textData as Record_ | undefined)?.styleOverrideTable;
  if (Array.isArray(table)) for (const run of table) dropped += prune(run as Record_);
  for (const list of [
    (fields.symbolData as Record_ | undefined)?.symbolOverrides,
    fields.derivedSymbolData,
  ])
    if (Array.isArray(list)) for (const o of list) dropped += prune(o as Record_);
  return dropped;
}

/** Takes out every binding Open Pencil can't evaluate; how many it took out. */
export function prepareVariables(records: readonly NodeChange[]): number {
  let dropped = 0;
  for (const r of records as unknown as Record_[]) dropped += prune(r);
  return dropped;
}
