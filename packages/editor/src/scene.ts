/**
 * Derived scene data: world matrices and bounds for every node, and where
 * each node's layers can paint, kept up to date as the document changes.
 * Everything is computed lazily, only for nodes that are asked about, and
 * kept until a change touches it: the scene catches up with the document's
 * change log (`Doc.changesSince`) when it's next asked something, dropping
 * only what the changes affect (decision 0028).
 *
 * For containers with many children it keeps a spatial index of their
 * children's extents (`childrenIn`), so drawing and hit testing visit what's
 * near the view or the pointer rather than every child. And it notes where
 * each change may have changed pixels (`dirtySince`), so a canvas can redraw
 * those places instead of everything.
 */
import { getProp, type NodeRecord, ROOT_ID } from "@drawpane/model";
import type { Doc, DocChange } from "./doc";
import {
  apply,
  boundsOfPoints,
  boxOf,
  IDENTITY,
  intersectRects,
  invert,
  localMatrix,
  type Matrix,
  multiply,
  type Point,
  type Rect,
  rectCorners,
  unionRects,
} from "./geometry";
import { endsMask, isActiveMask, maskScopes } from "./masks";
import { postEffects, postReach } from "./post-effects";
import { paintMargin } from "./reach";
import { cellSizeFor, GridIndex } from "./spatial";

/** Containers with fewer children than this are walked, not indexed. */
export const INDEX_MIN = 48;
/** How many changes `dirtySince` can answer for. */
const DIRTY_LOG = 128;

/** What's cached for a node, derived from `node`, the record it was computed from. */
interface Entry {
  node: NodeRecord;
  matrix?: Matrix;
  /** Undefined until computed; null when the node has none (an empty group). */
  bounds?: Rect | null | undefined;
  /** Bounds plus what it paints outside them, with its overflowing descendants' (see `extent`). */
  extent?: Rect | null | undefined;
}

/** A container's children by extent, and their order. */
interface ChildIndex {
  readonly grid: GridIndex;
  /** Each child's place among its siblings; null after the child list changed. */
  order: Map<string, number> | null;
  /** Children whose extent changed since they were indexed. */
  readonly stale: Set<string>;
}

/** A place where pixels may have changed, in page coordinates, and the page it's on (null: unknown). */
export interface DirtyRect {
  readonly rect: Rect;
  readonly page: string | null;
}

/**
 * Where pixels may have changed since a version: where the layers that
 * changed were then, and where they are now. `full` when it can't be told.
 */
export interface Dirty {
  readonly full: boolean;
  readonly rects: readonly DirtyRect[];
}

/** Whether a change to a node moves it or reshapes it: its matrix and bounds, and those below it, change. */
function geometryChanged(a: NodeRecord, b: NodeRecord): boolean {
  if (a.parent !== b.parent || a.type !== b.type) return true;
  if (a.type === "group") return false;
  const p = a.props;
  const q = b.props;
  return (
    getProp(p, "x") !== getProp(q, "x") ||
    getProp(p, "y") !== getProp(q, "y") ||
    getProp(p, "width") !== getProp(q, "width") ||
    getProp(p, "height") !== getProp(q, "height") ||
    getProp(p, "rotation") !== getProp(q, "rotation") ||
    getProp(p, "flipX") !== getProp(q, "flipX") ||
    getProp(p, "flipY") !== getProp(q, "flipY")
  );
}

function grow(r: Rect, by: number): Rect {
  return { x: r.x - by, y: r.y - by, width: r.width + by * 2, height: r.height + by * 2 };
}

function clips(node: NodeRecord): boolean {
  return node.type === "frame" && getProp(node.props, "clipContent") === true;
}

export class Scene {
  readonly #doc: Doc;
  #version = -1;
  readonly #entries = new Map<string, Entry>();
  readonly #indexes = new Map<string, ChildIndex>();
  readonly #masks = new Map<string, boolean>();
  /** Layers with glass or background blur, anywhere; built on first use. */
  #readers: Set<string> | null = null;
  #readersFor: { pageId: string; version: number; ids: string[] } | null = null;
  readonly #dirty: Array<{
    version: number;
    full: boolean;
    rects: DirtyRect[];
    ids: ReadonlySet<string>;
  }> = [];

  constructor(doc: Doc) {
    this.#doc = doc;
  }

  get doc(): Doc {
    return this.#doc;
  }

  #sync(): void {
    const version = this.#doc.version;
    if (this.#version === version) return;
    const changes = this.#version < 0 ? null : this.#doc.changesSince(this.#version);
    if (!changes || changes.some((c) => c.reset)) {
      this.#clear();
      this.#logDirty(version, true, [], new Set());
    } else {
      let at = this.#version;
      for (const change of changes) this.#invalidate(change, ++at);
    }
    this.#version = version;
  }

  #clear(): void {
    this.#entries.clear();
    this.#indexes.clear();
    this.#masks.clear();
    this.#readers = null;
    this.#readersFor = null;
  }

  #logDirty(version: number, full: boolean, rects: DirtyRect[], ids: ReadonlySet<string>): void {
    this.#dirty.push({ version, full, rects, ids });
    if (this.#dirty.length > DIRTY_LOG) this.#dirty.shift();
  }

  #entry(id: string): Entry | undefined {
    let e = this.#entries.get(id);
    if (!e) {
      const node = this.#doc.get(id);
      if (!node) return undefined;
      e = { node };
      this.#entries.set(id, e);
    }
    return e;
  }

  /** Drops what one change makes out of date, and notes where it may have changed pixels. */
  #invalidate(change: DocChange, version: number): void {
    const doc = this.#doc;
    const rects: DirtyRect[] = [];
    let full = false;
    const walked = new Set<string>();
    for (const id of change.ids) {
      const e = this.#entries.get(id);
      const node = doc.get(id);
      if (this.#readers && node && this.#reads(node)) this.#readers.add(id);
      else this.#readers?.delete(id);
      // A layer becoming a mask (or no longer one) shows or hides the layers above it, anywhere.
      if (isActiveMask(e?.node) !== isActiveMask(node)) full = true;
      // So does a frame starting or stopping to clip above a mask: it ends the mask's scope there.
      else if (endsMask(e?.node) !== endsMask(node)) {
        const parent = node?.parent ?? e?.node.parent;
        if (parent !== undefined && doc.childIds(parent).some((c) => isActiveMask(doc.get(c))))
          full = true;
      }
      if (e) {
        const old = e.node;
        const covered = this.#noteOld(e, rects);
        if (!node || geometryChanged(old, node)) this.#dropSubtree(id, rects, !covered);
        else {
          e.node = node;
          e.extent = undefined;
        }
        this.#masks.delete(old.parent);
        this.#up(old.parent, walked);
        this.#stale(old.parent, id);
      }
      if (node) {
        this.#masks.delete(node.parent);
        this.#up(node.parent, walked);
        this.#stale(node.parent, id);
      }
    }
    for (const parent of change.parents) {
      this.#masks.delete(parent);
      this.#up(parent, walked);
      const index = this.#indexes.get(parent);
      if (index) index.order = null;
    }
    this.#readersFor = null;
    this.#logDirty(version, full, rects, change.ids);
  }

  /**
   * Notes where a cached node painted, from what's cached for it. True when
   * that covers its descendants too (its extent, or a frame that clips them).
   */
  #noteOld(e: Entry, rects: DirtyRect[]): boolean {
    const at = this.#placeOf(e.node.parent);
    if (e.extent) {
      rects.push({ rect: grow(e.extent, at.reach), page: at.page });
      return true;
    }
    if (e.bounds) {
      rects.push({ rect: grow(e.bounds, paintMargin(e.node) + at.reach), page: at.page });
      return clips(e.node);
    }
    return false;
  }

  /** The page a parent is on, and how far its ancestors' blur and texture spread what's inside them. */
  #placeOf(parent: string): { page: string | null; reach: number } {
    let reach = 0;
    for (let node = this.#doc.get(parent); node; node = this.#doc.get(node.parent)) {
      if (node.type === "page") return { page: node.id, reach };
      reach += postReach(postEffects(getProp(node.props, "effects")));
    }
    return { page: null, reach };
  }

  /** Forgets a node and everything below it (they moved with it), noting where they painted if asked. */
  #dropSubtree(id: string, rects: DirtyRect[], note: boolean): void {
    const stack = [id];
    while (stack.length > 0) {
      const at = stack.pop() as string;
      const e = this.#entries.get(at);
      if (e) {
        this.#entries.delete(at);
        if (note && at !== id && this.#noteOld(e, rects)) {
          // Covered below this one: its descendants needn't be noted one by one.
          this.#forget(at);
          continue;
        }
      }
      this.#indexes.delete(at);
      for (const child of this.#doc.childIds(at)) stack.push(child);
    }
  }

  /** Forgets a subtree without noting anything. */
  #forget(id: string): void {
    const stack = [...this.#doc.childIds(id)];
    this.#indexes.delete(id);
    while (stack.length > 0) {
      const at = stack.pop() as string;
      this.#entries.delete(at);
      this.#indexes.delete(at);
      for (const child of this.#doc.childIds(at)) stack.push(child);
    }
  }

  /** Something inside `id` changed: its extent, a group's bounds, and theirs above, are out of date. */
  #up(id: string, walked: Set<string>): void {
    for (let at: string | undefined = id; at && at !== ROOT_ID; ) {
      if (walked.has(at)) return;
      walked.add(at);
      const e = this.#entries.get(at);
      const parent: string | undefined = e?.node.parent ?? this.#doc.get(at)?.parent;
      if (e) {
        e.extent = undefined;
        if (e.node.type === "group") e.bounds = undefined;
      }
      if (parent) this.#stale(parent, at);
      at = parent;
    }
  }

  #stale(parent: string, child: string): void {
    this.#indexes.get(parent)?.stale.add(child);
  }

  /** Matrix from a node's local box to page coordinates. Groups and pages return their space's matrix. */
  worldMatrix(id: string): Matrix {
    this.#sync();
    const e = this.#entry(id);
    if (!e) return IDENTITY;
    if (e.matrix) return e.matrix;
    const node = e.node;
    let m: Matrix = IDENTITY;
    if (node.type !== "page") {
      const parentSpace = this.spaceMatrix(node.parent);
      m = node.type === "group" ? parentSpace : multiply(parentSpace, localMatrix(boxOf(node)));
    }
    e.matrix = m;
    return m;
  }

  /** Matrix of the coordinate space that children of `id` live in. */
  spaceMatrix(id: string): Matrix {
    if (id === ROOT_ID) return IDENTITY;
    return this.worldMatrix(id);
  }

  /** The id whose coordinate space `id`'s children use: the nearest frame or page at or above it. */
  spaceOwner(id: string): string {
    let node = this.#doc.get(id);
    while (node && node.type === "group") node = this.#doc.get(node.parent);
    return node?.id ?? ROOT_ID;
  }

  /** The four corners of a node's box in page coordinates (rotation included). */
  corners(id: string): Point[] | null {
    const node = this.#doc.get(id);
    if (!node || node.type === "page") return null;
    if (node.type === "group") {
      const b = this.bounds(id);
      return b ? rectCorners(b) : null;
    }
    const box = boxOf(node);
    const m = this.worldMatrix(id);
    return rectCorners({ x: 0, y: 0, width: box.width, height: box.height }).map((p) =>
      apply(m, p),
    );
  }

  /** Axis-aligned bounds in page coordinates. A group's bounds wrap its visible children. */
  bounds(id: string): Rect | null {
    this.#sync();
    const e = this.#entry(id);
    if (!e) return null;
    if (e.bounds !== undefined) return e.bounds;
    const node = e.node;
    let result: Rect | null = null;
    if (node.type === "group") {
      // Layers above a mask only show inside it: they count up to the mask's edges.
      const rects: Rect[] = [];
      for (const { id: child, mask } of maskScopes(this.#doc, id)) {
        const b = this.bounds(child);
        if (!b) continue;
        if (!mask) {
          rects.push(b);
          continue;
        }
        const m = this.bounds(mask.id);
        const clipped = m ? intersectRects(b, m) : b;
        if (clipped) rects.push(clipped);
      }
      result = unionRects(rects);
    } else if (node.type !== "page") {
      const corners = this.corners(id);
      result = corners ? boundsOfPoints(corners) : null;
    }
    e.bounds = result;
    return result;
  }

  /**
   * Everything a node and its layers can paint or be hit on, in page
   * coordinates: its bounds grown by what it paints outside them (strokes,
   * shadows, blur), with its children's extents unless it's a frame that
   * clips them. Null when it has nothing to show.
   */
  extent(id: string): Rect | null {
    this.#sync();
    const e = this.#entry(id);
    if (!e) return null;
    if (e.extent !== undefined) return e.extent;
    const node = e.node;
    let result: Rect | null = null;
    if (node.type !== "page") {
      const b = this.bounds(id);
      if (b) result = grow(b, paintMargin(node));
      if (!clips(node))
        for (const child of this.#doc.childIds(id)) {
          const c = this.extent(child);
          if (c) result = result ? (unionRects([result, c]) as Rect) : c;
        }
    }
    e.extent = result;
    return result;
  }

  /**
   * A parent's children whose extent touches `rect`, in order (bottom
   * first). A parent with few children returns them all: callers test each
   * child themselves anyway, so this only ever leaves out children that
   * can't touch `rect`.
   */
  childrenIn(parentId: string, rect: Rect): readonly string[] {
    this.#sync();
    const ids = this.#doc.childIds(parentId);
    if (ids.length < INDEX_MIN) return ids;
    const index = this.#index(parentId, ids);
    const found = new Set<string>();
    index.grid.query(rect, found);
    if (found.size === 0) return [];
    if (found.size * 2 > ids.length) return ids.filter((id) => found.has(id));
    const order = index.order as Map<string, number>;
    return [...found].sort((a, b) => (order.get(a) as number) - (order.get(b) as number));
  }

  /** The index of a parent's children, brought up to date. */
  #index(parentId: string, ids: readonly string[]): ChildIndex {
    let index = this.#indexes.get(parentId);
    if (!index) {
      const rects = new Map<string, Rect>();
      for (const id of ids) {
        const r = this.extent(id);
        if (r) rects.set(id, r);
      }
      const grid = new GridIndex(cellSizeFor(rects.values()));
      for (const [id, r] of rects) grid.set(id, r);
      index = { grid, order: new Map(ids.map((id, i) => [id, i])), stale: new Set() };
      this.#indexes.set(parentId, index);
      return index;
    }
    if (!index.order) {
      const order = new Map(ids.map((id, i) => [id, i]));
      index.order = order;
      for (const id of [...index.grid.ids()]) if (!order.has(id)) index.grid.delete(id);
      for (const id of ids) if (!index.grid.has(id)) index.stale.add(id);
    }
    if (index.stale.size > 0) {
      for (const id of index.stale) {
        const r = index.order.has(id) ? this.extent(id) : null;
        if (r) index.grid.set(id, r);
        else index.grid.delete(id);
      }
      index.stale.clear();
    }
    return index;
  }

  /** Whether a parent has a mask among its children (see masks.ts), kept until its children change. */
  hasMask(parentId: string): boolean {
    this.#sync();
    let has = this.#masks.get(parentId);
    if (has === undefined) {
      has = this.#doc.childIds(parentId).some((id) => isActiveMask(this.#doc.get(id)));
      this.#masks.set(parentId, has);
    }
    return has;
  }

  /**
   * The page's visible layers that read the backdrop around them: glass and
   * background blur. Kept as the document changes, not found afresh.
   */
  backdropReaders(pageId: string): readonly string[] {
    this.#sync();
    const cached = this.#readersFor;
    if (cached?.pageId === pageId && cached.version === this.#version) return cached.ids;
    if (!this.#readers) {
      this.#readers = new Set();
      for (const node of this.#doc.nodes()) if (this.#reads(node)) this.#readers.add(node.id);
    }
    const ids: string[] = [];
    for (const id of this.#readers)
      if (this.#doc.pageOf(id)?.id === pageId && this.isVisible(id)) ids.push(id);
    this.#readersFor = { pageId, version: this.#version, ids };
    return ids;
  }

  #reads(node: NodeRecord): boolean {
    return getProp(node.props, "effects").some(
      (e) => e.visible !== false && (e.type === "glass" || e.type === "background-blur"),
    );
  }

  /**
   * Where pixels may have changed since the document was at `version`.
   * Null when that's not known any more (too long ago): redraw everything.
   */
  dirtySince(version: number): Dirty | null {
    this.#sync();
    if (version === this.#version) return { full: false, rects: [] };
    const first = this.#dirty[0];
    if (version > this.#version || !first || first.version > version + 1) return null;
    const rects: DirtyRect[] = [];
    const ids = new Set<string>();
    for (const entry of this.#dirty) {
      if (entry.version <= version) continue;
      if (entry.full) return { full: true, rects: [] };
      for (const r of entry.rects) rects.push(r);
      for (const id of entry.ids) ids.add(id);
    }
    // Where they are now (they may have moved more than once: only now and then matter).
    for (const id of ids) {
      const node = this.#doc.get(id);
      if (!node || node.type === "page") continue;
      const extent = this.extent(id);
      if (!extent) continue;
      const at = this.#placeOf(node.parent);
      // Not on a page (a variable, a style): it draws nothing.
      if (at.page === null) continue;
      rects.push({ rect: grow(extent, at.reach), page: at.page });
    }
    return { full: false, rects };
  }

  /** Bounds of several nodes together. */
  unionBounds(ids: Iterable<string>): Rect | null {
    const rects: Rect[] = [];
    for (const id of ids) {
      const b = this.bounds(id);
      if (b) rects.push(b);
    }
    return unionRects(rects);
  }

  /** Converts a page point into a node's local box coordinates. */
  toLocal(id: string, p: Point): Point {
    return apply(invert(this.worldMatrix(id)), p);
  }

  /** Converts a page point into the coordinate space children of `parent` use. */
  toSpace(parent: string, p: Point): Point {
    return apply(invert(this.spaceMatrix(this.spaceOwner(parent))), p);
  }

  /** True when the node and all its ancestors are visible. */
  isVisible(id: string): boolean {
    for (
      let node: NodeRecord | undefined = this.#doc.get(id);
      node;
      node = this.#doc.get(node.parent)
    ) {
      if (node.props.visible === false) return false;
      if (node.type === "page") return true;
    }
    return true;
  }

  /** True when the node or any ancestor is locked. */
  isLocked(id: string): boolean {
    for (
      let node: NodeRecord | undefined = this.#doc.get(id);
      node;
      node = this.#doc.get(node.parent)
    ) {
      if (node.props.locked === true) return true;
      if (node.type === "page") return false;
    }
    return false;
  }
}
