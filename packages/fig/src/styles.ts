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
  for (const r of records as unknown as Record_[]) {
    upgradeLinks(r);
    resolveText(r, style);
    const overrides = (r.symbolData as Record_ | undefined)?.symbolOverrides;
    if (Array.isArray(overrides))
      for (const o of overrides as Record_[]) {
        upgradeLinks(o);
        resolveText(o, style);
      }
  }
}
