/**
 * Shared styles, resolved before Open Pencil reads the records.
 *
 * Figma links a layer to a style and also saves a copy of the style's
 * values on the layer, which older files often left stale (black text whose
 * style is grey). Open Pencil 0.16 applies a style over the copy when the
 * link is the newer `styleIdFor…` kind, but not the older `inherit…StyleID`
 * links, and not for styled stretches of text (`textData.styleOverrideTable`,
 * whose entries in older files hold nothing but links). So older links get
 * the newer field Open Pencil reads, and each run's links are applied here.
 * The style wins over the saved copy, as in Figma.
 *
 * A text style can also bind its size, line height and letter spacing to
 * variables, which Open Pencil doesn't carry from the style to the layer;
 * those bindings are put on the layer, so they resolve in its mode.
 */
import type { NodeChange } from "@open-pencil/kiwi/fig/codec";

type Record_ = Record<string, unknown>;
interface Guid {
  sessionID: number;
  localID: number;
}

const LEGACY_LINKS = [
  ["inheritFillStyleID", "styleIdForFill"],
  ["inheritFillStyleIDForStroke", "styleIdForStrokeFill"],
  ["inheritTextStyleID", "styleIdForText"],
  ["inheritEffectStyleID", "styleIdForEffect"],
  ["inheritGridStyleID", "styleIdForGrid"],
] as const;

/** What a text style sets on the characters it styles. */
const TEXT_STYLE_FIELDS = [
  "fontSize",
  "fontName",
  "lineHeight",
  "letterSpacing",
  "textDecoration",
  "textCase",
] as const;

const UNSET = 0xffffffff;
const isGuid = (v: unknown): v is Guid =>
  !!v && typeof v === "object" && typeof (v as Guid).sessionID === "number";
const guidKey = (g: Guid) => `${g.sessionID}:${g.localID}`;
/** The all-ones guid means "no style" (a style that was detached). */
const isUnset = (g: Guid) => g.sessionID === UNSET && g.localID === UNSET;

/** Older links as the newer field, where the record doesn't have that already. */
function upgradeLinks(fields: Record_): void {
  for (const [legacy, current] of LEGACY_LINKS) {
    const guid = fields[legacy];
    if (!isGuid(guid) || isUnset(guid) || fields[current] !== undefined) continue;
    fields[current] = { guid };
  }
}

type StyleLookup = (reference: unknown) => Record_ | undefined;

/** A styled stretch of text with its fill and text styles applied. */
function resolveRun(entry: Record_, style: StyleLookup): void {
  upgradeLinks(entry);
  const fill = style(entry.styleIdForFill);
  if (fill?.styleType === "FILL" && Array.isArray(fill.fillPaints))
    entry.fillPaints = fill.fillPaints;
  const text = style(entry.styleIdForText);
  if (text?.styleType === "TEXT")
    for (const field of TEXT_STYLE_FIELDS)
      if (text[field] !== undefined) entry[field] = text[field];
}

function resolveText(fields: Record_, style: StyleLookup): void {
  const table = (fields.textData as Record_ | undefined)?.styleOverrideTable;
  if (Array.isArray(table)) for (const entry of table) resolveRun(entry as Record_, style);
}

interface Entry {
  variableField?: string;
  variableData?: { value?: { alias?: unknown } };
}

const entriesOf = (map: unknown): Entry[] => {
  const entries = (map as { entries?: unknown } | undefined)?.entries;
  return Array.isArray(entries) ? (entries as Entry[]) : [];
};

/** The text style's fields that bind a variable, Kiwi's names to the layer fields they set. */
const BOUND_TEXT_FIELDS = {
  FONT_SIZE: "fontSize",
  LINE_HEIGHT: "lineHeight",
  LETTER_SPACING: "letterSpacing",
} as const;
type BoundTextField = keyof typeof BOUND_TEXT_FIELDS;
const isBoundTextField = (field: unknown): field is BoundTextField =>
  typeof field === "string" && field in BOUND_TEXT_FIELDS;

/** A text style's own bindings of the fields above, by field. */
function styleBindings(text: Record_ | undefined): Map<BoundTextField, Entry> {
  const out = new Map<BoundTextField, Entry>();
  if (text?.styleType !== "TEXT") return out;
  for (const map of [text.variableConsumptionMap, text.parameterConsumptionMap])
    for (const entry of entriesOf(map))
      if (isBoundTextField(entry.variableField) && entry.variableData?.value?.alias)
        out.set(entry.variableField, entry);
  return out;
}

/** The layer's own binding fields, from either map. */
function ownFields(fields: Record_): Set<string> {
  const out = new Set<string>();
  for (const map of [fields.variableConsumptionMap, fields.parameterConsumptionMap])
    for (const entry of entriesOf(map)) if (entry.variableField) out.add(entry.variableField);
  return out;
}

function addEntries(fields: Record_, entries: readonly Entry[]): void {
  if (entries.length === 0) return;
  const map = (fields.variableConsumptionMap as Record_ | undefined) ?? {};
  fields.variableConsumptionMap = {
    ...map,
    entries: [...entriesOf(map), ...entries.map((e) => structuredClone(e))],
  };
}

/**
 * A text style's variable bindings, on the layers that use the style.
 *
 * A style can bind its size, line height and letter spacing to variables
 * whose values change by mode (a compact style's 12 px where the default is
 * 14). Figma resolves those for each layer in the mode it's in. Open Pencil
 * copies the style's saved values onto the layer, which are the default
 * mode's, and not its bindings, so a copy in a frame set to another mode
 * kept the default's size. With the bindings on the layer, Open Pencil
 * resolves them per layer, as it does the layer's own. A layer's own
 * binding of a field wins.
 */
function bindTextStyle(fields: Record_, style: StyleLookup): void {
  const bindings = styleBindings(style(fields.styleIdForText));
  if (bindings.size === 0) return;
  const own = ownFields(fields);
  addEntries(
    fields,
    [...bindings].filter(([field]) => !own.has(field)).map(([, entry]) => entry),
  );
}

/**
 * A copy that sets a text style, or none, on one of its layers. The new
 * style's bindings go on the copy's override; and where the main's style
 * bound a field the new one doesn't, the main's binding would follow into
 * the copy and replace what it saved, so the override binds that field to
 * the value it saved instead (a constant binds nothing).
 */
function bindOverrideStyle(
  override: Record_,
  main: Map<BoundTextField, Entry>,
  style: StyleLookup,
) {
  if (override.styleIdForText === undefined) return;
  const own = ownFields(override);
  const replacing = styleBindings(style(override.styleIdForText));
  const entries: Entry[] = [];
  for (const field of new Set([...main.keys(), ...replacing.keys()])) {
    if (own.has(field)) continue;
    const bound = replacing.get(field);
    if (bound) {
      entries.push(bound);
      continue;
    }
    const value = savedValue(override, field);
    if (value !== undefined)
      entries.push({
        variableField: field,
        variableData: {
          value: { floatValue: value },
          dataType: "FLOAT",
          resolvedDataType: "FLOAT",
        },
      } as Entry);
  }
  addEntries(override, entries);
}

/** The value a record saved for a bound text field, in the pixels a binding gives. */
function savedValue(fields: Record_, field: BoundTextField): number | undefined {
  const value = fields[BOUND_TEXT_FIELDS[field]];
  if (typeof value === "number") return value;
  const { value: n, units } = (value ?? {}) as { value?: unknown; units?: unknown };
  return typeof n === "number" && units === "PIXELS" ? n : undefined;
}

/** Prepares every record's style links (and its instance overrides') for Open Pencil. */
export function prepareStyles(records: readonly NodeChange[]): void {
  const byGuid = new Map<string, Record_>();
  const byKey = new Map<string, Record_>();
  for (const r of records as unknown as Record_[]) {
    if (isGuid(r.guid)) byGuid.set(guidKey(r.guid), r);
    if (typeof r.key === "string") {
      byKey.set(r.key, r);
      if (typeof r.version === "string") byKey.set(`${r.key}@${r.version}`, r);
    }
  }
  const style: StyleLookup = (reference) => {
    if (!reference || typeof reference !== "object") return undefined;
    const { guid, assetRef } = reference as {
      guid?: unknown;
      assetRef?: { key?: string; version?: string };
    };
    if (isGuid(guid)) return isUnset(guid) ? undefined : byGuid.get(guidKey(guid));
    if (assetRef?.key)
      return (
        (assetRef.version ? byKey.get(`${assetRef.key}@${assetRef.version}`) : undefined) ??
        byKey.get(assetRef.key)
      );
    return undefined;
  };
  // The bindings each layer's own style gives it, read before any record changes.
  const mainBindings = (o: Record_) => {
    const path = (o.guidPath as { guids?: unknown[] } | undefined)?.guids;
    const target = path?.[path.length - 1];
    const layer = isGuid(target) ? byGuid.get(guidKey(target)) : undefined;
    return styleBindings(style(layer?.styleIdForText ?? legacyLink(layer)));
  };
  const overrideBindings = new Map<Record_, Map<BoundTextField, Entry>>();
  for (const r of records as unknown as Record_[]) {
    const overrides = (r.symbolData as Record_ | undefined)?.symbolOverrides;
    if (Array.isArray(overrides))
      for (const o of overrides as Record_[])
        if (o.styleIdForText !== undefined || legacyLink(o))
          overrideBindings.set(o, mainBindings(o));
  }
  for (const r of records as unknown as Record_[]) {
    upgradeLinks(r);
    resolveText(r, style);
    bindTextStyle(r, style);
    const overrides = (r.symbolData as Record_ | undefined)?.symbolOverrides;
    if (Array.isArray(overrides))
      for (const o of overrides as Record_[]) {
        upgradeLinks(o);
        resolveText(o, style);
        const main = overrideBindings.get(o);
        if (main) bindOverrideStyle(o, main, style);
      }
  }
}

/** A record's older text style link, as the newer field would hold it. */
function legacyLink(fields: Record_ | undefined): { guid: Guid } | undefined {
  const guid = fields?.inheritTextStyleID;
  return isGuid(guid) && !isUnset(guid) ? { guid } : undefined;
}
