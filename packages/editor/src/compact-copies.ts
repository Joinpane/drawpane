/**
 * The editor's document with compact copies (decision 0029, behind a flag):
 * the stored form in a `MemoryStore`, presented through the model's
 * `CopyView`, and operations on presented layers translated into operations
 * on the stored form.
 *
 * - A `set` on a copy layer (or an instance root) rewrites its override
 *   record (or the root) to hold exactly what then differs from its main:
 *   `ownValues(base, presented)`. So a value equal to the main's, and not
 *   overridden, is dropped and follows the main again.
 * - Setting `instanceOf` on an instance root swaps it (its records go, as
 *   its layers did) or unlinks it: its copies become stored layers with the
 *   same ids ("materialized"). Setting it back, on a frame whose layers
 *   match the main's, absorbs them into records again. A main that's deleted
 *   or stops being one materializes its instances elsewhere first, and
 *   absorbs them again when it comes back.
 * - Creating a layer inside an instance is accepted when it matches a copy
 *   layer the instance already presents (same `mirrors`, same type): it's
 *   absorbed, its values written as that copy's record, and later operations
 *   in the transaction that name it are pointed at the copy. That's how
 *   materialized copies (a paste, a library insert, an older client's
 *   instance) come in. Deleting or moving a copy layer is refused.
 * - The inverse returned is in the same (presented) terms, so undo, redo
 *   and the history need nothing new; `stored` holds the operations as
 *   stored, which is what a room would receive (phase 4b).
 */
import {
  type ApplyOptions,
  applyOp,
  type BuildBudget,
  bindsLayout,
  CopyView,
  collectSubtree,
  getProp,
  isMainNode,
  isPropName,
  MemoryStore,
  ModelError,
  type NodeRecord,
  type Op,
  OVERRIDE_KEY,
  ownValues,
  type Props,
  presentedBytes,
  propAllowed,
  ROOT_LOCAL_PROPS,
  sameValue,
} from "@drawpane/model";

/**
 * Properties no layout reads: a change to only these, in a main, can't move
 * or resize anything in its copies, so no instance is laid out again.
 */
export const LAYOUT_NEUTRAL: ReadonlySet<string> = new Set([
  "name",
  "locked",
  "opacity",
  "blendMode",
  "fills",
  "strokeCap",
  "strokeJoin",
  "strokeDashes",
  "markerStart",
  "markerEnd",
  "effects",
  "isMask",
  "maskType",
  "cornerRadius",
  "cornerRadii",
  "cornerSmoothing",
  "reactions",
  "bindings",
  "componentDescription",
  "layoutGrids",
  "rulerGuides",
  "readingOrder",
  "variantProps",
]);

/** A record's own bookkeeping, never a value a layout reads. */
const RECORD_BOOKKEEPING: ReadonlySet<string> = new Set(["path", "overrides", "mirrors", "unset"]);

interface Tx {
  /** Stored operations applied, in order. */
  readonly stored: Op[];
  /** The store's own inverse of each, for rolling back. */
  readonly undoStored: Op[][];
  /** Presented inverses, one list per presented operation. */
  readonly inverse: Op[][];
  readonly ids: Set<string>;
  readonly parents: Set<string>;
  /** Created ids absorbed into copy layers (null: dropped). */
  readonly alias: Map<string, string | null>;
  /** Instance roots to absorb at the end (their main came back). */
  readonly absorbLater: Set<string>;
  /** Invalidation held back while a group of stored operations runs. */
  deferred: { changed: string[]; structural: string[] } | null;
  /** Puts back what was held (see `ApplyOptions.held`): nothing refused for depth. */
  readonly held: boolean;
}

export interface CompactApplied {
  /** Undoes the transaction, in the same terms as the operations given. */
  readonly inverse: Op[];
  /** The operations as stored. */
  readonly stored: Op[];
  /** Undoes the stored operations exactly, as stored operations (`applyStored`). */
  readonly storedInverse: Op[];
  readonly ids: ReadonlySet<string>;
  readonly parents: ReadonlySet<string>;
}

type Kind = "stored" | "root" | "copy" | "record" | "missing";

function isFrameWithInstanceOf(node: NodeRecord | undefined): boolean {
  return node?.type === "frame" && !!node.props.instanceOf;
}

/** A stretch of deletes and sets in one apply (`#deleteStretch`). */
interface DeleteStretch {
  readonly deletes: ReadonlyMap<string, number>;
  readonly sets: ReadonlyMap<string, number>;
  readonly end: number;
}

export class CompactCopies {
  readonly store: MemoryStore;
  readonly view: CopyView;
  #records = 0;
  /** Main id → stored frames with `instanceOf` it (live or not). */
  readonly #rootsOf = new Map<string, Set<string>>();
  /** Instance roots that store a value a layout reads (their layout may differ from their main's). */
  readonly #layoutOwn = new Set<string>();
  /** Main id → override records that swap their copy to it. */
  readonly #swapsOf = new Map<string, Set<string>>();
  /** Each swapping record → the main it's indexed under in `#swapsOf`. */
  readonly #swapMain = new Map<string, string>();

  /**
   * `nodes` in the stored form. With a `meter`, what the store keeps and
   * every copy layer the view builds are counted in it (`MemoryStore`,
   * `CopyView`): building past it throws `BuildTooLarge`. With `store`
   * (built already, in the same meter, as `MemoryStore.paged` builds one),
   * that store is kept and `nodes` is ignored.
   */
  constructor(
    nodes: Iterable<NodeRecord> = [],
    { meter = null, store = null }: { meter?: BuildBudget | null; store?: MemoryStore | null } = {},
  ) {
    this.store = store ?? new MemoryStore(nodes, { meter });
    // The store counts the values; a presented copy only adds its record and an object pointing at them.
    this.view = new CopyView(this.store, { budget: meter, cost: presentedBytes });
    for (const node of this.store.nodes()) {
      if (node.type === "override") {
        this.#records++;
        this.#noteSwap(node);
      } else if (isFrameWithInstanceOf(node)) this.#indexRoot(node.id, null, node.props.instanceOf);
    }
    for (const roots of this.#rootsOf.values()) for (const id of roots) this.#refreshLayout(id);
  }

  get size(): number {
    this.view.buildAll();
    return this.store.size - this.#records + this.view.slotCount;
  }

  /**
   * Stored instance roots that follow a main: its instances, and those with a
   * copy swapped to it (not the copies inside other instances, which follow
   * theirs).
   */
  instanceRoots(mainId: string): readonly string[] {
    const direct = this.#rootsOf.get(mainId);
    const swaps = this.#swapsOf.get(mainId);
    if (!swaps) return direct ? [...direct] : [];
    const roots = new Set(direct);
    for (const id of swaps) {
      const record = this.store.get(id);
      if (record) roots.add(record.parent);
    }
    return [...roots];
  }

  /** Whether an instance stores a value a layout reads, so a change to its main lays it out again. */
  layoutDiffers(rootId: string): boolean {
    return this.#layoutOwn.has(rootId);
  }

  // -------------------------------------------------------------------------
  // Applying

  apply(ops: readonly Op[], { held = false }: ApplyOptions = {}): CompactApplied {
    const tx = this.#tx(held);
    let index = 0;
    // The stretch of deletes and sets `index` is in (issue 280, below).
    let stretch: DeleteStretch = { deletes: new Map(), sets: new Map(), end: 0 };
    try {
      for (; index < ops.length; index++) {
        const op = ops[index] as Op;
        if (op.op === "delete") {
          if (index >= stretch.end) stretch = this.#deleteStretch(tx, ops, index);
          if (this.#deletedLater(tx, op.id, index, stretch)) continue;
        }
        this.#op(tx, op);
      }
      for (const root of tx.absorbLater) if (this.#hasLayers(root)) this.#absorb(tx, root);
    } catch (error) {
      this.#rollback(tx);
      if (error instanceof ModelError)
        throw new ModelError(error.code, error.message, Math.min(index, ops.length - 1));
      throw error;
    }
    return {
      inverse: tx.inverse.reverse().flat(),
      stored: tx.stored,
      storedInverse: [...tx.undoStored].reverse().flat(),
      ids: tx.ids,
      parents: tx.parents,
    };
  }

  /**
   * Applies operations on the stored form as they are (a room's, or a
   * test's). A run of operations other than deletes (which read the view
   * for what they remove) invalidates the view once, at its end: 80 layers
   * created in a main of 1,000 instances build its copies again once, not
   * 80 times.
   */
  applyStored(ops: readonly Op[], { held = false }: ApplyOptions = {}): CompactApplied {
    const tx = this.#tx(held);
    try {
      for (let i = 0; i < ops.length; ) {
        if ((ops[i] as Op).op === "delete") {
          tx.inverse.push(this.#put(tx, ops[i] as Op));
          i++;
          continue;
        }
        let end = i;
        while (end < ops.length && (ops[end] as Op).op !== "delete") end++;
        this.#group(tx, () => {
          for (; i < end; i++) tx.inverse.push(this.#put(tx, ops[i] as Op));
        });
      }
    } catch (error) {
      this.#rollback(tx);
      throw error;
    }
    const inverse = tx.inverse.reverse().flat();
    return { inverse, stored: tx.stored, storedInverse: inverse, ids: tx.ids, parents: tx.parents };
  }

  #tx(held = false): Tx {
    return {
      held,
      stored: [],
      undoStored: [],
      inverse: [],
      ids: new Set(),
      parents: new Set(),
      alias: new Map(),
      absorbLater: new Set(),
      deferred: null,
    };
  }

  #rollback(tx: Tx): void {
    // Refused before anything was stored: nothing to undo, and nothing built is stale.
    if (tx.undoStored.length === 0) return;
    for (let i = tx.undoStored.length - 1; i >= 0; i--)
      for (const op of tx.undoStored[i] as Op[]) {
        try {
          applyOp(this.store, op, { held: true, cycles: false });
        } catch {
          // Only the last page's delete can refuse; nothing else a rollback does can.
        }
      }
    this.view.clear();
    this.#reindex();
  }

  #reindex(): void {
    this.#records = 0;
    this.#rootsOf.clear();
    this.#layoutOwn.clear();
    this.#swapsOf.clear();
    this.#swapMain.clear();
    for (const node of this.store.nodes()) {
      if (node.type === "override") {
        this.#records++;
        this.#noteSwap(node);
      } else if (isFrameWithInstanceOf(node)) this.#indexRoot(node.id, null, node.props.instanceOf);
    }
    for (const roots of this.#rootsOf.values()) for (const id of roots) this.#refreshLayout(id);
  }

  #kind(id: string): Kind {
    const stored = this.store.get(id);
    if (stored && stored.type !== "override") return this.view.mainOf(stored) ? "root" : "stored";
    if (this.view.slot(id)) return "copy";
    return stored ? "record" : "missing";
  }

  #resolve(tx: Tx, id: string): string | null {
    return tx.alias.has(id) ? (tx.alias.get(id) as string | null) : id;
  }

  /**
   * The stretch of deletes and sets from `start`, up to the first create or
   * move: each delete's target by its last place in it, and each layer by the
   * last place a set reaches it or anything in it. Nothing in such a stretch
   * makes an alias or moves a layer, so it resolves once for all of it.
   */
  #deleteStretch(tx: Tx, ops: readonly Op[], start: number): DeleteStretch {
    const deletes = new Map<string, number>();
    const sets = new Map<string, number>();
    let end = start;
    for (; end < ops.length; end++) {
      const op = ops[end] as Op;
      if (op.op !== "delete" && op.op !== "set") break;
      const target = this.#resolve(tx, op.id);
      if (target === null) continue;
      if (op.op === "delete") deletes.set(target, end);
      else
        for (let id: string | undefined = target; id; id = this.view.get(id)?.parent)
          sets.set(id, end);
    }
    return { deletes, sets, end };
  }

  /**
   * Whether the delete at `index` is of a stored layer that a later delete in
   * the same stretch removes with its ancestor anyway, with nothing set in it
   * between. An undone create deletes each layer it made, children first (as
   * redoing a main's delete does), and a selection's delete can delete a layer
   * and its frame. Left to the ancestor's delete, the main's instances
   * elsewhere keep all it held, as they did when it was deleted at once
   * (issue 280), and an undo that brings it all back finds them matching. It
   * walks up from the layer once, so a stretch costs its length times the
   * layers' depth.
   */
  #deletedLater(tx: Tx, opId: string, index: number, stretch: DeleteStretch): boolean {
    const id = this.#resolve(tx, opId);
    if (id === null) return false;
    if ((stretch.sets.get(id) ?? -1) > index) return false;
    for (let n = this.store.get(id); n && n.type !== "override"; n = this.store.get(n.parent)) {
      const at = stretch.deletes.get(n.parent);
      if (at !== undefined && at > index) return true;
    }
    return false;
  }

  #op(tx: Tx, op: Op): void {
    const id = this.#resolve(tx, op.id);
    if (id === null) return; // Inside a layer that was dropped: nothing to do.
    if (op.op === "set") this.#set(tx, id, op.prop, op.value);
    else if (op.op === "delete") this.#delete(tx, id);
    else {
      const parent = this.#resolve(tx, op.parent);
      if (op.op === "create") {
        // A layer kept from a main (it names its main layer in `mirrors`) whose main layer a
        // collaborator deleted meanwhile isn't made again, nor what's in it: a redo of the main's
        // delete keeps what the main holds now, as materialized copies do.
        const mirrors = (op.props as Record<string, unknown>).mirrors;
        const lost = typeof mirrors === "string" && !this.view.get(mirrors);
        if (parent === null || lost) tx.alias.set(op.id, null);
        else this.#create(tx, { ...op, parent });
      } else {
        if (parent === null)
          throw new ModelError("not_found", `Parent ${op.parent} doesn't exist.`);
        this.#move(tx, id, parent, op.key);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Stored operations, with the indexes and the view kept up to date

  /** Applies one stored operation. Returns the store's inverse of it. */
  #put(tx: Tx, op: Op): Op[] {
    const before = this.store.get(op.id);
    const removed = op.op === "delete" ? collectSubtree(this.store, op.id) : [];
    const presentedRemoved = op.op === "delete" ? this.#presentedSubtree(op.id) : [];
    const undo = applyOp(this.store, op, { held: tx.held });
    tx.undoStored.push(undo);
    tx.stored.push(op);

    const changed: string[] = [];
    const structural: string[] = [];
    switch (op.op) {
      case "create": {
        const node = this.store.get(op.id) as NodeRecord;
        changed.push(node.id);
        if (node.type === "override") {
          this.#records++;
          if (swaps(node.props)) structural.push(node.id);
          this.#noteSwap(node);
          this.#refreshLayout(node.parent);
          break;
        }
        structural.push(node.parent);
        tx.parents.add(node.parent);
        if (isFrameWithInstanceOf(node)) {
          this.#indexRoot(node.id, null, node.props.instanceOf);
          structural.push(node.id);
          this.#refreshLayout(node.id);
        }
        if (isMainNode(node)) structural.push(...this.instanceRoots(node.id));
        break;
      }
      case "delete": {
        const node = before as NodeRecord;
        for (const gone of removed) {
          if (gone.type === "override") {
            this.#records--;
            this.#unnoteSwap(gone.id);
            continue;
          }
          if (isFrameWithInstanceOf(gone)) {
            this.#indexRoot(gone.id, gone.props.instanceOf, null);
            this.#layoutOwn.delete(gone.id);
            structural.push(gone.id);
          }
          if (isMainNode(gone)) structural.push(...this.instanceRoots(gone.id));
        }
        for (const id of presentedRemoved) tx.ids.add(id);
        if (node.type === "override") {
          changed.push(node.id);
          if (swaps(node.props)) structural.push(node.id);
          this.#refreshLayout(node.parent);
        } else {
          structural.push(node.parent);
          tx.parents.add(node.parent);
        }
        break;
      }
      case "set": {
        const node = this.store.get(op.id) as NodeRecord;
        changed.push(op.id);
        if (node.type === "override") {
          if (op.prop === "instanceOf" || op.prop === "unset") structural.push(op.id);
          this.#noteSwap(node);
          this.#refreshLayout(node.parent);
          break;
        }
        if (op.prop === "instanceOf" && node.type === "frame") {
          this.#indexRoot(op.id, before?.props.instanceOf ?? null, node.props.instanceOf ?? null);
          structural.push(op.id);
        }
        if (op.prop === "isComponent") structural.push(...this.instanceRoots(op.id));
        // A set's name is its variants' instances' name.
        if ((op.prop === "name" || op.prop === "isComponentSet") && node.type === "frame")
          for (const child of this.store.childIds(op.id))
            if (isMainNode(this.store.get(child))) changed.push(child);
        if (isFrameWithInstanceOf(node) || isFrameWithInstanceOf(before))
          this.#refreshLayout(op.id);
        break;
      }
      case "move": {
        const node = before as NodeRecord;
        changed.push(op.id);
        structural.push(node.parent, op.parent);
        tx.parents.add(node.parent);
        tx.parents.add(op.parent);
        // In or out of a set: its instances' name.
        break;
      }
    }
    if (tx.deferred) {
      tx.deferred.changed.push(...changed);
      tx.deferred.structural.push(...structural);
    } else this.#forget(tx, changed, structural);
    return undo;
  }

  #forget(tx: Tx, changed: readonly string[], structural: readonly string[]): void {
    const result = this.view.forget(changed, structural);
    for (const id of result.ids) tx.ids.add(id);
    for (const id of result.parents) tx.parents.add(id);
  }

  /** Runs `fn` with the view's invalidation held until it's done. */
  #group<T>(tx: Tx, fn: () => T): T {
    if (tx.deferred) return fn();
    tx.deferred = { changed: [], structural: [] };
    try {
      return fn();
    } finally {
      const { changed, structural } = tx.deferred;
      tx.deferred = null;
      this.#forget(tx, changed, structural);
    }
  }

  #noteSwap(record: NodeRecord): void {
    const to = record.props.instanceOf;
    const main = typeof to === "string" && to ? to : null;
    if (this.#swapMain.get(record.id) === main) return;
    this.#unnoteSwap(record.id);
    if (!main) return;
    this.#swapMain.set(record.id, main);
    const set = this.#swapsOf.get(main);
    if (set) set.add(record.id);
    else this.#swapsOf.set(main, new Set([record.id]));
  }

  #unnoteSwap(recordId: string): void {
    const main = this.#swapMain.get(recordId);
    if (main === undefined) return;
    this.#swapMain.delete(recordId);
    const set = this.#swapsOf.get(main);
    set?.delete(recordId);
    if (set?.size === 0) this.#swapsOf.delete(main);
  }

  #indexRoot(id: string, from: string | null | undefined, to: string | null | undefined): void {
    if (from) {
      const set = this.#rootsOf.get(from);
      set?.delete(id);
      if (set?.size === 0) this.#rootsOf.delete(from);
    }
    if (to) {
      const set = this.#rootsOf.get(to);
      if (set) set.add(id);
      else this.#rootsOf.set(to, new Set([id]));
    }
  }

  #refreshLayout(rootId: string): void {
    const root = this.store.get(rootId);
    if (!isFrameWithInstanceOf(root) || !root) {
      this.#layoutOwn.delete(rootId);
      return;
    }
    const reads = (prop: string) => !LAYOUT_NEUTRAL.has(prop) && !RECORD_BOOKKEEPING.has(prop);
    // A binding is neutral only by its own value: binding a layout value, or unbinding the
    // main's, can resolve to another size than the main's though nothing else differs.
    const listsRead = (props: Props) =>
      (props.unset ?? []).some((p) => reads(p) || p === "bindings") || bindsLayout(props);
    let differs =
      Object.keys(root.props).some((p) => !ROOT_LOCAL_PROPS.has(p) && reads(p)) ||
      listsRead(root.props);
    if (!differs)
      for (const id of this.store.childIds(rootId)) {
        const record = this.store.get(id);
        if (record?.type !== "override") continue;
        if (Object.keys(record.props).some(reads) || listsRead(record.props)) {
          differs = true;
          break;
        }
      }
    if (differs) this.#layoutOwn.add(rootId);
    else this.#layoutOwn.delete(rootId);
  }

  #presentedSubtree(id: string): string[] {
    const out: string[] = [];
    if (!this.view.get(id)) return out;
    const queue = [id];
    for (let i = 0; i < queue.length; i++) {
      const at = queue[i] as string;
      out.push(at);
      for (const child of this.view.childIds(at)) queue.push(child);
    }
    return out;
  }

  /** The presented subtree as `create` operations, parents first: what undoes deleting it. */
  #createsOf(id: string): Op[] {
    return this.#presentedSubtree(id).map((at): Op => {
      const node = this.view.get(at) as NodeRecord;
      return {
        op: "create",
        id: node.id,
        type: node.type,
        parent: node.parent,
        key: node.key,
        props: node.props,
      };
    });
  }

  #hasLayers(rootId: string): boolean {
    return this.store.childIds(rootId).some((id) => this.store.get(id)?.type !== "override");
  }

  // -------------------------------------------------------------------------
  // Presented operations

  #set(tx: Tx, id: string, prop: string, value: unknown): void {
    const kind = this.#kind(id);
    if (kind === "missing") throw new ModelError("not_found", `Node ${id} doesn't exist.`);
    if (kind === "stored" || kind === "record") {
      const node = this.store.get(id) as NodeRecord;
      // A main that stops being one: its instances keep their layers, as stored layers.
      if (prop === "isComponent" && isMainNode(node) && !value)
        for (const root of this.instanceRoots(id))
          if (this.view.mainOf(this.store.get(root))) this.#materialize(tx, root, undefined);
      const undo = this.#put(tx, { op: "set", id, prop: prop as never, value });
      tx.inverse.push(undo);
      const after = this.store.get(id) as NodeRecord;
      if (prop === "isComponent" && isMainNode(after))
        for (const root of this.instanceRoots(id)) tx.absorbLater.add(root);
      // A frame made an instance of a main: its layers become the copy's.
      if (prop === "instanceOf" && this.view.mainOf(after) && this.#hasLayers(id))
        this.#absorb(tx, id);
      return;
    }
    const presented = this.view.get(id) as NodeRecord;
    if (!isPropName(prop)) throw new ModelError("invalid_prop", `Unknown property "${prop}".`);
    if (prop === "path" || prop === "unset" || (kind === "copy" && prop === "mirrors")) return;
    if (!propAllowed(presented.type, prop))
      throw new ModelError("invalid_prop", `A ${presented.type} has no "${prop}" property.`);
    if (prop === "instanceOf") {
      if (kind === "root") this.#relink(tx, id, value as string | null);
      else this.#swapCopy(tx, id, value as string | null);
      return;
    }
    const old = (presented.props as Record<string, unknown>)[prop];
    const next: Record<string, unknown> = { ...presented.props };
    if (value === null || value === undefined) delete next[prop];
    else next[prop] = value;
    this.#writeOwn(tx, id, next);
    tx.inverse.push([{ op: "set", id, prop, value: old === undefined ? null : old }]);
  }

  /**
   * Makes a copy layer's record (or an instance root) hold exactly what
   * `presented` differs in from its main: the stored operations that takes.
   */
  #writeOwn(tx: Tx, id: string, presented: Readonly<Record<string, unknown>>): void {
    const base = this.view.base(id);
    if (!base) throw new ModelError("not_found", `Node ${id} doesn't exist.`);
    const slot = this.view.slot(id);
    const own = ownValues(base.props, presented, !slot);
    if (!slot) {
      const root = this.store.get(id) as NodeRecord;
      const want = own ?? {};
      for (const prop of Object.keys(root.props))
        if (!(prop in want)) this.#put(tx, { op: "set", id, prop: prop as never, value: null });
      for (const [prop, value] of Object.entries(want))
        if (!sameValue((root.props as Record<string, unknown>)[prop], value))
          this.#put(tx, { op: "set", id, prop: prop as never, value });
      return;
    }
    const record = this.view.record(slot);
    if (!own) {
      // A record is never deleted for holding nothing of its own here (PR 286): only the fields
      // it held go, so a field someone else set meanwhile, applied before this (a recolour, under
      // a relayout worked out without it), stays. An empty record means nothing, as an absent
      // one does, and a later write fills it again. Explicit removals (a layer's delete, a
      // detach, a swap) still delete records.
      if (record)
        for (const prop of Object.keys(record.props))
          if (prop !== "path") this.#put(tx, { op: "set", id, prop: prop as never, value: null });
      return;
    }
    if (!record) {
      this.#put(tx, {
        op: "create",
        id,
        type: "override",
        parent: slot.root,
        key: OVERRIDE_KEY,
        props: { path: [...slot.path], ...own } as Props,
      });
      return;
    }
    for (const prop of Object.keys(record.props))
      if (prop !== "path" && !(prop in own))
        this.#put(tx, { op: "set", id, prop: prop as never, value: null });
    for (const [prop, value] of Object.entries(own))
      if (!sameValue((record.props as Record<string, unknown>)[prop], value))
        this.#put(tx, { op: "set", id, prop: prop as never, value });
  }

  /** Sets that bring copy layers back to how they were presented (overrides last). */
  #restoreOps(captured: readonly NodeRecord[]): Op[] {
    const ops: Op[] = [];
    const marks: Op[] = [];
    for (const node of captured) {
      const record = this.store.get(node.id);
      const props = node.props as Record<string, unknown>;
      const names = new Set([
        ...Object.keys(record?.type === "override" ? record.props : {}),
        ...((record?.props.unset as string[] | undefined) ?? []),
      ]);
      for (const prop of names) {
        if (RECORD_BOOKKEEPING.has(prop) || !isPropName(prop) || !propAllowed(node.type, prop))
          continue;
        ops.push({ op: "set", id: node.id, prop, value: props[prop] ?? null });
      }
      if (props.overrides)
        marks.push({ op: "set", id: node.id, prop: "overrides", value: props.overrides });
    }
    return [...ops, ...marks];
  }

  /** Copy layers with records under `id` (a root, or a copy layer), as presented now. */
  #recordedUnder(id: string): NodeRecord[] {
    const out: NodeRecord[] = [];
    for (const at of this.#presentedSubtree(id)) {
      if (at === id) continue;
      const slot = this.view.slot(at);
      if (slot && this.view.record(slot)) out.push(this.view.get(at) as NodeRecord);
    }
    return out;
  }

  /** `instanceOf` on an instance root: a swap to another main, or unlinked. */
  #relink(tx: Tx, id: string, value: string | null): void {
    const root = this.store.get(id) as NodeRecord;
    const old = root.props.instanceOf ?? null;
    if (value === old) return;
    if (value && value !== id && isMainNode(this.store.get(value))) {
      // A swap: its layers are the other main's, so what they kept goes with them.
      const captured = this.#recordedUnder(id);
      const restore = this.#restoreOps(captured);
      this.#group(tx, () => {
        for (const record of [...this.store.childIds(id)])
          if (this.store.get(record)?.type === "override")
            this.#put(tx, { op: "delete", id: record });
        this.#put(tx, { op: "set", id, prop: "instanceOf", value });
      });
      tx.inverse.push([{ op: "set", id, prop: "instanceOf", value: old }, ...restore]);
      return;
    }
    this.#materialize(tx, id, value);
    tx.inverse.push([{ op: "set", id, prop: "instanceOf", value: old }]);
  }

  /** `instanceOf` on a copy layer inside an instance: a nested instance swapped. */
  #swapCopy(tx: Tx, id: string, value: string | null): void {
    const presented = this.view.get(id) as NodeRecord;
    const old = presented.props.instanceOf ?? null;
    if (value === old) return;
    const captured = this.#recordedUnder(id);
    const restore = this.#restoreOps(captured);
    this.#group(tx, () => {
      for (const node of captured) this.#put(tx, { op: "delete", id: node.id });
    });
    const next: Record<string, unknown> = { ...presented.props };
    if (value === null) delete next.instanceOf;
    else next.instanceOf = value;
    // Swapped or not, its base is another: written again over the new one, so what it keeps
    // is what differs from that.
    this.#writeOwn(tx, id, next);
    this.#writeOwn(tx, id, next);
    tx.inverse.push([{ op: "set", id, prop: "instanceOf", value: old }, ...restore]);
  }

  /**
   * Turns an instance's copies into stored layers with the same ids and
   * values (nested instances stay instances, with records of their own),
   * then sets its `instanceOf` to `to` when given.
   */
  #materialize(tx: Tx, rootId: string, to: string | null | undefined): void {
    const root = this.view.get(rootId) as NodeRecord;
    const byId = new Map<string, NodeRecord>();
    const kids = new Map<string, readonly string[]>();
    for (const id of this.#presentedSubtree(rootId)) {
      byId.set(id, this.view.get(id) as NodeRecord);
      kids.set(id, [...this.view.childIds(id)]);
    }
    const nestedOf = new Map<string, string>();
    const nested: string[] = [];
    this.#group(tx, () => {
      for (const record of [...this.store.childIds(rootId)])
        if (this.store.get(record)?.type === "override")
          this.#put(tx, { op: "delete", id: record });
      const stored = this.store.get(rootId) as NodeRecord;
      const want = root.props as Record<string, unknown>;
      for (const prop of Object.keys(stored.props))
        if (!(prop in want))
          this.#put(tx, { op: "set", id: rootId, prop: prop as never, value: null });
      for (const [prop, value] of Object.entries(want))
        if (!sameValue((stored.props as Record<string, unknown>)[prop], value))
          this.#put(tx, { op: "set", id: rootId, prop: prop as never, value });
      for (const [id, layer] of byId) {
        if (id === rootId) continue;
        const top = nestedOf.get(layer.parent);
        if (top !== undefined) {
          nestedOf.set(id, top);
          continue;
        }
        this.#put(tx, {
          op: "create",
          id,
          type: layer.type,
          parent: layer.parent,
          key: layer.key,
          props: layer.props,
        });
        const of = layer.type === "frame" ? layer.props.instanceOf : null;
        if (of && isMainNode(this.store.get(of))) {
          nestedOf.set(id, id);
          nested.push(id);
        }
      }
      if (to !== undefined) this.#put(tx, { op: "set", id: rootId, prop: "instanceOf", value: to });
    });
    // Nested instances stay instances, stored, keeping their look as records of their own:
    // their layers, built from their own main now, match the old ones place for place.
    for (const top of nested) {
      this.#writeOwn(tx, top, (this.store.get(top) as NodeRecord).props);
      const pair = (was: string, now: string) => {
        const before = kids.get(was) ?? [];
        const after = this.view.childIds(now);
        before.forEach((old, i) => {
          const id = after[i];
          const layer = byId.get(old) as NodeRecord;
          if (!id || this.view.get(id)?.type !== layer.type) return;
          this.#writeOwn(tx, id, this.#keptPlace(id, layer.props));
          pair(old, id);
        });
      };
      pair(top, top);
    }
  }

  /**
   * A kept copy layer's look, with the place and size it differs in from its
   * new main layer marked as its own: they came from the main that's gone,
   * and nothing derives them now (`placedGeometry` keeps what's marked).
   */
  #keptPlace(id: string, props: Props): Props {
    const base = this.view.base(id);
    if (!base) return props;
    const marks = new Set<string>(getProp(props, "overrides"));
    const count = marks.size;
    for (const prop of ["x", "y", "width", "height"] as const)
      if (!sameValue(getProp(base.props as Props, prop), getProp(props, prop))) marks.add(prop);
    return marks.size === count ? props : ({ ...props, overrides: [...marks] } as Props);
  }

  /**
   * An instance root that stores layers (materialized) and follows a main
   * again: its layers become records of the copies they match, place for
   * place. Refused when they don't match the main's.
   */
  #absorb(tx: Tx, rootId: string): void {
    // What it looks like now, before its layers go.
    const captured = new Map<string, { node: NodeRecord; kids: string[] }>();
    const capture = (id: string, stored: boolean) => {
      const node = (stored ? this.store.get(id) : this.view.get(id)) as NodeRecord;
      // A nested instance stored with records: its layers as it presents them.
      const presents = !stored || this.view.mainOf(node) !== undefined;
      const kids = presents
        ? [...this.view.childIds(id)]
        : this.store.childIds(id).filter((c) => this.store.get(c)?.type !== "override");
      captured.set(id, { node: presents ? (this.view.get(id) as NodeRecord) : node, kids });
      for (const kid of kids) capture(kid, stored && !presents);
    };
    const rootKids = this.store
      .childIds(rootId)
      .filter((c) => this.store.get(c)?.type !== "override");
    for (const kid of rootKids) capture(kid, true);
    const rootProps = (this.store.get(rootId) as NodeRecord).props;

    this.#group(tx, () => {
      for (const kid of rootKids) this.#put(tx, { op: "delete", id: kid });
    });
    this.#writeOwn(tx, rootId, rootProps);
    const refuse = () =>
      new ModelError("invalid_value", "Its layers aren't its main's: detach it instead.");
    const match = (capturedKids: readonly string[], presentedParent: string) => {
      const kids = this.view.childIds(presentedParent);
      if (kids.length !== capturedKids.length) throw refuse();
      capturedKids.forEach((id, i) => {
        const entry = captured.get(id);
        const target = kids[i] as string;
        if (!entry || this.view.get(target)?.type !== entry.node.type) throw refuse();
        if (target !== id) tx.alias.set(id, target);
        this.#writeOwn(tx, target, entry.node.props);
        match(entry.kids, target);
      });
    };
    match(rootKids, rootId);
  }

  #create(tx: Tx, op: Extract<Op, { op: "create" }>): void {
    const parentKind = this.#kind(op.parent);
    if (parentKind === "copy" || parentKind === "root") {
      this.#absorbCreate(tx, op);
      return;
    }
    if (op.type === "override")
      throw new ModelError("invalid_parent", "Override records are the editor's to write.");
    if (this.view.knownSlot(op.id))
      throw new ModelError("already_exists", `Node ${op.id} already exists.`);
    let props = op.props;
    const main = op.type === "frame" ? op.props.instanceOf : null;
    const base = main ? this.view.rootBase(main) : undefined;
    if (base && main !== op.id) props = (ownValues(base, op.props, true) ?? {}) as Props;
    tx.inverse.push(this.#put(tx, { ...op, props }));
    const node = this.store.get(op.id) as NodeRecord;
    if (isMainNode(node)) for (const root of this.instanceRoots(op.id)) tx.absorbLater.add(root);
  }

  /** A layer created inside an instance: absorbed into the copy layer it matches. */
  #absorbCreate(tx: Tx, op: Extract<Op, { op: "create" }>): void {
    const mirrors = op.props.mirrors;
    if (!mirrors)
      throw new ModelError(
        "invalid_parent",
        "Layers inside an instance come from its main component.",
      );
    const target = this.view
      .childIds(op.parent)
      .find(
        (id) => this.view.knownSlot(id)?.source === mirrors && this.view.get(id)?.type === op.type,
      );
    if (!target) {
      // Its main no longer has that layer: syncing would have removed it.
      tx.alias.set(op.id, null);
      return;
    }
    if (target !== op.id) tx.alias.set(op.id, target);
    const before = this.view.get(target) as NodeRecord;
    this.#writeOwn(tx, target, op.props);
    const after = this.view.get(target) as NodeRecord;
    const ops: Op[] = [];
    let marks: Op | null = null;
    const old = before.props as Record<string, unknown>;
    const now = after.props as Record<string, unknown>;
    for (const prop of new Set([...Object.keys(old), ...Object.keys(now)])) {
      if (prop === "mirrors" || sameValue(old[prop], now[prop]) || !isPropName(prop)) continue;
      const set: Op = { op: "set", id: target, prop, value: old[prop] ?? null };
      if (prop === "overrides") marks = set;
      else ops.push(set);
    }
    if (marks) ops.push(marks);
    if (ops.length > 0) tx.inverse.push(ops);
  }

  #delete(tx: Tx, id: string): void {
    const kind = this.#kind(id);
    if (kind === "missing") throw new ModelError("not_found", `Node ${id} doesn't exist.`);
    if (kind === "copy")
      throw new ModelError(
        "invalid_parent",
        "A layer inside an instance comes from its main component: hide it, or detach the instance.",
      );
    if (kind === "record") {
      tx.inverse.push(this.#put(tx, { op: "delete", id }));
      return;
    }
    const creates = this.#createsOf(id);
    // Instances elsewhere of a main going away keep their layers, stored.
    const inside = new Set(collectSubtree(this.store, id).map((n) => n.id));
    for (const node of collectSubtree(this.store, id))
      if (isMainNode(node))
        for (const root of this.instanceRoots(node.id))
          if (!inside.has(root) && this.view.mainOf(this.store.get(root)))
            this.#materialize(tx, root, undefined);
    this.#put(tx, { op: "delete", id });
    tx.inverse.push(creates);
  }

  #move(tx: Tx, id: string, parent: string, key: string): void {
    const kind = this.#kind(id);
    if (kind === "missing") throw new ModelError("not_found", `Node ${id} doesn't exist.`);
    if (kind === "copy" || kind === "record")
      throw new ModelError(
        "invalid_parent",
        "A layer inside an instance stays where its main has it.",
      );
    const parentKind = this.#kind(parent);
    if (parentKind === "copy" || parentKind === "root")
      throw new ModelError("invalid_parent", "Layers can't be moved into an instance.");
    tx.inverse.push(this.#put(tx, { op: "move", id, parent, key }));
  }
}

/** Whether a record's values change which main its copy's layers come from. */
function swaps(props: Props): boolean {
  return props.instanceOf !== undefined || (props.unset ?? []).includes("instanceOf");
}
