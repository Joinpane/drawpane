/**
 * About how many layers each page comes to once its instances are filled
 * in, from the saved records alone, in well under a second for the largest
 * files. Building the pages is what takes minutes and gigabytes, so this is
 * what decides, before building, whether a file fits in one Drawpane file,
 * which pages to offer when it doesn't, and how many pages to build at once.
 *
 * An instance counts as its main component's layers, with what its
 * component properties change: a slot (`SLOT_CONTENT_ID`) counts the
 * content the instance put in it (saved as records on the internal page)
 * instead of the main's default content, and an instance swap
 * (`OVERRIDDEN_SYMBOL_ID`) counts the component swapped in. Overrides that
 * swap a nested instance directly, or hide a layer, aren't followed, so the
 * count is rough; the import still counts the real layers as it builds.
 */
import type { NodeChange } from "@open-pencil/kiwi/fig/codec";
import { guidString } from "./raw";

interface Guid {
  sessionID: number;
  localID: number;
}
const isGuid = (v: unknown): v is Guid =>
  !!v && typeof v === "object" && typeof (v as Guid).sessionID === "number";

interface PropRef {
  defID?: unknown;
  componentPropNodeField?: string;
}
interface Assignment {
  defID?: unknown;
  value?: { guidValue?: unknown };
  varValue?: {
    value?: { slotContentIdValue?: { guid?: unknown }; symbolIdValue?: { guid?: unknown } };
  };
}
type Record_ = NodeChange & {
  componentPropRefs?: PropRef[];
  componentPropAssignments?: Assignment[];
};

/** What an instance's properties put where: a slot's content, or the component swapped in, by property. */
type Assigned = ReadonlyMap<string, { readonly slot?: string; readonly swap?: string }>;

function assignedBy(instance: Record_): Assigned | null {
  const out = new Map<string, { slot?: string; swap?: string }>();
  for (const a of instance.componentPropAssignments ?? []) {
    if (!isGuid(a.defID)) continue;
    const value = a.varValue?.value;
    const slot = value?.slotContentIdValue?.guid;
    const swap = value?.symbolIdValue?.guid ?? a.value?.guidValue;
    if (isGuid(slot)) out.set(guidString(a.defID), { slot: guidString(slot) });
    else if (isGuid(swap)) out.set(guidString(a.defID), { swap: guidString(swap) });
  }
  return out.size > 0 ? out : null;
}

/** The property of `field` a layer's value comes from, as the instance assigned it. */
function assignedTo(record: Record_, field: string, assigned: Assigned | null) {
  if (!assigned) return undefined;
  for (const ref of record.componentPropRefs ?? [])
    if (ref.componentPropNodeField === field && isGuid(ref.defID))
      return assigned.get(guidString(ref.defID));
  return undefined;
}

/** Layers under each of the given pages, by page guid ("1:2"), not counting the page itself. */
export function estimateLayers(
  records: readonly NodeChange[],
  pages: readonly NodeChange[],
): Map<string, number> {
  const byId = new Map<string, Record_>();
  const children = new Map<string, Record_[]>();
  for (const r of records) if (isGuid(r.guid)) byId.set(guidString(r.guid), r);
  for (const r of records) {
    const parent = r.parentIndex?.guid;
    if (!isGuid(parent) || !isGuid(r.guid)) continue;
    const key = guidString(parent);
    const list = children.get(key);
    if (list) list.push(r);
    else children.set(key, [r]);
  }

  /** Sizes by record and the instance whose properties applied ("" for none). */
  const sizes = new Map<string, number>();
  /** On the way down: a component that (wrongly) contains itself counts once. */
  const open = new Set<string>();
  const size = (record: Record_, assigned: Assigned | null, scope: string): number => {
    const id = guidString(record.guid as Guid);
    const key = `${id}|${scope}`;
    const known = sizes.get(key);
    if (known !== undefined) return known;
    if (open.has(key)) return 1;
    open.add(key);
    let n = 1;
    if (record.type === "INSTANCE") {
      const swap = assignedTo(record, "OVERRIDDEN_SYMBOL_ID", assigned)?.swap;
      const symbol = record.symbolData?.symbolID;
      const main = swap
        ? byId.get(swap)
        : isGuid(symbol)
          ? byId.get(guidString(symbol))
          : undefined;
      // The main's layers, with this instance's own properties applied to them.
      const own = assignedBy(record);
      for (const c of main ? (children.get(guidString(main.guid as Guid)) ?? []) : [])
        n += size(c, own, own ? id : "");
    } else {
      const slot = assignedTo(record, "SLOT_CONTENT_ID", assigned)?.slot;
      // A slot holds what the instance put in it, which is its own: no properties apply.
      if (slot) for (const c of children.get(slot) ?? []) n += size(c, null, "");
      else for (const c of children.get(id) ?? []) n += size(c, assigned, scope);
    }
    open.delete(key);
    sizes.set(key, n);
    return n;
  };
  const out = new Map<string, number>();
  for (const page of pages)
    if (isGuid(page.guid))
      out.set(guidString(page.guid), Math.max(0, size(page as Record_, null, "") - 1));
  return out;
}
