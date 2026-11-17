/**
 * Slot content, from the saved records: what an instance put in a slot of
 * its main component, so its layers get the ids Figma gives them.
 *
 * A slot is a frame in a component whose content is a component property
 * (`SLOT_CONTENT_ID`). An instance assigns it a content frame, saved on the
 * internal page (`isSlotContent`), whose layers become the slot's children
 * in that instance. They're the instance's own layers, not copies of the
 * main's. Figma names them under the slot, as it names a nested instance's
 * layers under that instance (`I<instance>;<slot>;<content layer>`), when
 * the instance that assigned them is a saved layer: on a page, in a main,
 * or itself slot content. When it's a copy, a main's nested instance as
 * that main's instance builds it, the content is that main's own and is
 * named as the main's layers are, under the copy and without the slot
 * (`I<instance>;<nested instance>;<content layer>`).
 *
 * Open Pencil fills slots in but doesn't keep which content frame a slot's
 * children came from, so it's worked out again here: the assignment that
 * reaches the slot's instance, its own or one an instance around it saved
 * as an override, the outermost winning as Figma applies them.
 */
import { guidString, type RawGuid, type RawRecord } from "./raw";

const SLOT_CONTENT_ID = "SLOT_CONTENT_ID";

const isGuid = (v: unknown): v is RawGuid =>
  !!v &&
  typeof v === "object" &&
  typeof (v as RawGuid).sessionID === "number" &&
  typeof (v as RawGuid).localID === "number";

/** Records' children by their saved position, by parent guid. */
export type ChildIndex = ReadonlyMap<string, ReadonlyMap<string, string>>;

export function indexChildren(records: Iterable<RawRecord>): ChildIndex {
  const out = new Map<string, Map<string, string>>();
  for (const r of records) {
    const parent = r.parentIndex?.guid;
    const position = r.parentIndex?.position;
    if (!r.guid || !isGuid(parent) || typeof position !== "string") continue;
    const key = guidString(parent);
    const children = out.get(key) ?? new Map<string, string>();
    children.set(position, guidString(r.guid));
    out.set(key, children);
  }
  return out;
}

/** The property a slot's content comes from, if the record is a slot. */
export function slotProperty(record: RawRecord | undefined): string | null {
  for (const ref of record?.componentPropRefs ?? [])
    if (ref.componentPropNodeField === SLOT_CONTENT_ID && !ref.isDeleted && isGuid(ref.defID))
      return guidString(ref.defID);
  return null;
}

/** The content frame an assignment list gives `property`, if any (the last one wins). */
export function assignedContent(
  assignments: RawRecord["componentPropAssignments"],
  property: string,
): string | null {
  let found: string | null = null;
  for (const a of assignments ?? []) {
    if (!isGuid(a.defID) || guidString(a.defID) !== property) continue;
    const content = a.varValue?.value?.slotContentIdValue?.guid;
    if (isGuid(content)) found = guidString(content);
  }
  return found;
}

/** Whether a saved override path names the given instances, by guid or override key. */
export function pathNames(
  path: readonly unknown[] | undefined,
  instances: readonly RawRecord[],
): boolean {
  if (!path || path.length !== instances.length) return false;
  return path.every((segment, i) => {
    const record = instances[i] as RawRecord;
    if (!isGuid(segment)) return false;
    const id = guidString(segment);
    return (
      (record.guid && guidString(record.guid) === id) ||
      (isGuid(record.overrideKey) && guidString(record.overrideKey) === id)
    );
  });
}

/** A slot's content frame and which of the instances around it put it there. */
export interface SlotAssignment {
  readonly content: string;
  /** Its index in the instances given, outermost first. */
  readonly by: number;
}

/**
 * The content frame assigned to a slot (by its property) in an instance,
 * given the records of the instances from the outermost around it down to
 * the slot's own: the outermost saved assignment wins, as overrides do.
 */
export function slotContent(
  property: string,
  instances: readonly RawRecord[],
): SlotAssignment | null {
  for (let i = 0; i < instances.length; i++) {
    const owner = instances[i] as RawRecord;
    const below = instances.slice(i + 1);
    let found: string | null = null;
    if (below.length === 0) found = assignedContent(owner.componentPropAssignments, property);
    else
      for (const o of owner.symbolData?.symbolOverrides ?? []) {
        if (!pathNames(o.guidPath?.guids, below)) continue;
        found = assignedContent(o.componentPropAssignments, property) ?? found;
      }
    if (found) return { content: found, by: i };
  }
  return null;
}
