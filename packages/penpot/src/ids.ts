/**
 * Unique layer ids across a file's pages. Penpot keeps a shape's id when a
 * page is duplicated, so the same id can name a layer on several pages; in
 * Drawpane an id names one layer in the file. One page keeps each id (the
 * one with the component's main, else the first), and on the others the
 * layer gets a new id, the same every time the file is converted, with
 * everything on that page that points at it (parents, children, grid
 * cells, interactions, flows, guides) following.
 *
 * References to a component's layers (`shapeRef`) aren't rewritten: they
 * point at the main, whose page keeps its ids.
 */
import type { PenpotFile, PenpotPage, PenpotRecord } from "./read";

const ROOT_FRAME = "00000000-0000-0000-0000-000000000000";

type Raw = Record<string, unknown>;

/** A new id for `id` on `pageId`: uuid-shaped, and the same for the same pair. */
function remapped(pageId: string, id: string): string {
  // FNV-1a over both ids, twice with different seeds, for 16 hex digits.
  const hash = (seed: number) => {
    let h = seed >>> 0;
    for (const ch of `${pageId}/${id}`) {
      h ^= ch.charCodeAt(0);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, "0");
  };
  const tail = `${hash(0x811c9dc5)}${hash(0x9747b28c)}`;
  return `${id.slice(0, 19)}${tail.slice(0, 4)}-${tail.slice(4, 16)}`;
}

export interface UniqueIds {
  /** The file with every layer id unique across its pages (the file itself when they already are). */
  readonly file: PenpotFile;
  /** The node id a Penpot shape on a page becomes. */
  idOf(pageId: string, shapeId: string): string;
}

export function withUniqueIds(file: PenpotFile): UniqueIds {
  // Pages with a component's main claim their ids first.
  const mainPages = new Set<string>();
  for (const component of file.components.values())
    if (typeof component.mainInstancePage === "string") mainPages.add(component.mainInstancePage);
  const order = [
    ...file.pages.filter((p) => mainPages.has(p.record.id)),
    ...file.pages.filter((p) => !mainPages.has(p.record.id)),
  ];
  const owner = new Map<string, string>();
  let clashes = false;
  for (const page of order)
    for (const id of page.shapes.keys()) {
      if (id === ROOT_FRAME) continue;
      if (owner.has(id)) clashes = true;
      else owner.set(id, page.record.id);
    }
  const idOf = (pageId: string, shapeId: string) =>
    clashes && owner.has(shapeId) && owner.get(shapeId) !== pageId
      ? remapped(pageId, shapeId)
      : shapeId;
  if (!clashes) return { file, idOf };
  return { file: { ...file, pages: file.pages.map((page) => pageWithIds(page, owner)) }, idOf };
}

function pageWithIds(page: PenpotPage, owner: ReadonlyMap<string, string>): PenpotPage {
  const pageId = page.record.id;
  const map = new Map<string, string>();
  for (const id of page.shapes.keys())
    if (id !== ROOT_FRAME && owner.get(id) !== pageId) map.set(id, remapped(pageId, id));
  if (map.size === 0) return page;
  const to = (id: unknown) => (typeof id === "string" ? (map.get(id) ?? id) : id);
  const list = (ids: unknown) => (Array.isArray(ids) ? ids.map(to) : ids);

  const shapes = new Map<string, PenpotRecord>();
  for (const [id, shape] of page.shapes) {
    const next: Raw = { ...shape, id: to(id) };
    for (const key of ["parentId", "frameId"]) if (key in shape) next[key] = to(shape[key]);
    if ("shapes" in shape) next.shapes = list(shape.shapes);
    const cells = shape.layoutGridCells as Record<string, Raw> | undefined;
    if (cells && typeof cells === "object")
      next.layoutGridCells = Object.fromEntries(
        Object.entries(cells).map(([k, cell]) => [k, { ...cell, shapes: list(cell.shapes) }]),
      );
    if (Array.isArray(shape.interactions))
      next.interactions = (shape.interactions as Raw[]).map((i) => ({
        ...i,
        ...("destination" in i ? { destination: to(i.destination) } : {}),
        ...("positionRelativeTo" in i ? { positionRelativeTo: to(i.positionRelativeTo) } : {}),
      }));
    shapes.set(next.id as string, next as PenpotRecord);
  }

  const record: Raw = { ...page.record };
  const flows = page.record.flows as Record<string, Raw> | undefined;
  if (flows && typeof flows === "object")
    record.flows = Object.fromEntries(
      Object.entries(flows).map(([k, f]) => [k, { ...f, startingFrame: to(f.startingFrame) }]),
    );
  const guides = page.record.guides as Record<string, Raw> | undefined;
  if (guides && typeof guides === "object")
    record.guides = Object.fromEntries(
      Object.entries(guides).map(([k, g]) => [k, { ...g, frameId: to(g.frameId) }]),
    );
  return { ...page, record: record as PenpotRecord, shapes };
}
