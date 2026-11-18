/**
 * Converting a stored file between the materialized form (every copy layer
 * stored, `mirrors`-linked) and the compact form (decision 0029) an
 * instance at a time, so a file of any size converts without being held:
 * what the room runs on its SQLite (phase 4b), and what the tests run on a
 * `MemoryStore`.
 *
 * `compact` in copies.ts converts a whole document held in memory. This
 * does the same, one top-level instance root at a time, reading the file
 * through a `ConvertReader` that shows it as converted so far:
 *
 * - An instance is converted after what it's built from: the instances
 *   inside its main (and inside the mains its layers are swapped to), and
 *   its main itself when that's an instance too.
 * - Each is checked before it's kept: its copies, built from the compact
 *   form, must be exactly its materialized layers, ids renamed. One that
 *   isn't is detached instead (it keeps every layer, unlinked from its
 *   main, and looks as it did), and the reason is said.
 * - Ids other layers hold (reading orders, prototype links, flows' starts)
 *   are renamed with the copies they name: inside an instance as it
 *   converts, and everywhere (override records included) once every
 *   instance is, since one instance can name another's copies, converted
 *   later.
 * - Siblings draw in order of their keys, then their ids, wherever they're
 *   stored. A built copy's layers are in its main's order; one whose
 *   materialized layers are in another (siblings sharing a key, ids sorting
 *   otherwise) isn't kept: the check compares the order too.
 */
import { ModelError } from "./apply";
import { type BuildBudget, BuildTooLarge, nodeBytes } from "./budget";
import {
  CopyView,
  type DrivenField,
  drivenShown,
  hasRecord,
  isMainNode,
  OVERRIDE_KEY,
  ownValues,
  samePropValue,
} from "./copies";
import { sameValue } from "./history";
import { ROOT_ID } from "./ids";
import type { NodeRecord } from "./ops";
import { compareSiblings } from "./order-key";
import {
  getProp,
  MAX_PROPERTY_VALUES,
  MAX_PROPERTY_VALUES_CHARS,
  type PropertyValue,
  type Props,
  propertyValuesChars,
  splitPropertyKey,
} from "./schema";
import { MemoryStore } from "./store";

/** How copies are stored in a file: every copy layer, or the compact form (decision 0029). */
export type CopiesFormat = "materialized" | "compact";

export const COPIES_FORMATS: readonly CopiesFormat[] = ["materialized", "compact"];

export function isCopiesFormat(value: unknown): value is CopiesFormat {
  return value === "materialized" || value === "compact";
}

// ---------------------------------------------------------------------------
// Ids held in properties

/** Properties whose values name other layers by id: renamed with the layers they name. */
export const ID_HOLDING_PROPS: readonly string[] = ["readingOrder", "reactions", "flows"];

/**
 * `props` with the layer ids it holds renamed by `rename` (a reading
 * order's entries, prototype destinations, flows' starting screens), or
 * null when none is renamed. Ids `rename` doesn't know stay as they are.
 */
export function renameHeldIds(
  props: Readonly<Props>,
  rename: (id: string) => string | undefined,
): Props | null {
  const p = props as Record<string, unknown>;
  let out: Record<string, unknown> | null = null;
  const order = p.readingOrder;
  if (Array.isArray(order)) {
    let changed = false;
    const next = order.map((id: unknown) => {
      const to = typeof id === "string" ? rename(id) : undefined;
      if (to === undefined || to === id) return id;
      changed = true;
      return to;
    });
    if (changed) out = { ...(out ?? {}), readingOrder: next };
  }
  for (const [prop, key] of [
    ["reactions", "to"],
    ["flows", "start"],
  ] as const) {
    const list = p[prop];
    if (!Array.isArray(list)) continue;
    let changed = false;
    const text = JSON.stringify(list);
    const next = JSON.parse(text, (k, value: unknown) => {
      if (k !== key || typeof value !== "string") return value;
      const to = rename(value);
      if (to === undefined || to === value) return value;
      changed = true;
      return to;
    }) as unknown;
    if (changed) out = { ...(out ?? {}), [prop]: next };
  }
  return out ? ({ ...props, ...out } as Props) : null;
}

/**
 * Every node id `props` holds, by what it names: `layers` are the ids
 * `renameHeldIds` renames (a reading order's entries, prototype
 * destinations, flows' starting screens), which can name a copy layer;
 * `others` name mains, styles, variables and collections (`instanceOf`,
 * `mirrors`, an override record's `path`, `textStyle`, `bindings`, the
 * collections `variableModes` sets, a variable's aliases), which never name
 * a copy layer. Ids that aren't nodes' (a reaction's or flow's own id, a
 * mode's) aren't listed. Every id-valued property in the schema is one of
 * these (checked by a test against `PROPS`).
 */
export function heldNodeIds(props: Readonly<Props>): { layers: string[]; others: string[] } {
  const p = props as Record<string, unknown>;
  const layers: string[] = [];
  const others: string[] = [];
  const str = (value: unknown, into: string[]) => {
    if (typeof value === "string") into.push(value);
  };
  if (Array.isArray(p.readingOrder)) for (const id of p.readingOrder) str(id, layers);
  if (Array.isArray(p.reactions))
    for (const r of p.reactions as Array<{ action?: { to?: unknown } }>) str(r?.action?.to, layers);
  if (Array.isArray(p.flows))
    for (const f of p.flows as Array<{ start?: unknown }>) str(f?.start, layers);
  str(p.instanceOf, others);
  str(p.mirrors, others);
  str(p.textStyle, others);
  if (Array.isArray(p.path)) for (const id of p.path) str(id, others);
  if (p.bindings && typeof p.bindings === "object")
    for (const id of Object.values(p.bindings as Record<string, unknown>)) str(id, others);
  if (p.variableModes && typeof p.variableModes === "object")
    for (const id of Object.keys(p.variableModes as Record<string, unknown>)) str(id, others);
  if (p.values && typeof p.values === "object")
    for (const value of Object.values(p.values as Record<string, unknown>))
      if (value && typeof value === "object") str((value as { alias?: unknown }).alias, others);
  // An instance swap property's default and preferred components (decision 0035).
  if (Array.isArray(p.componentProps))
    for (const def of p.componentProps as Array<{
      type?: unknown;
      default?: unknown;
      preferred?: unknown;
    }>) {
      if (def?.type !== "instance") continue;
      str(def.default, others);
      if (Array.isArray(def.preferred)) for (const id of def.preferred) str(id, others);
    }
  // The component an instance chose for a swap property, and the layers of mains a key's scope
  // names its nested instances by (decision 0035, item 3): layers a main holds itself.
  if (p.propValues && typeof p.propValues === "object")
    for (const [key, value] of Object.entries(p.propValues as Record<string, unknown>)) {
      for (const id of splitPropertyKey(key).scope) str(id, others);
      if (value && typeof value === "object")
        str((value as { instance?: unknown }).instance, others);
    }
  return { layers, others };
}

/** Properties whose values hold node ids (see `heldNodeIds`). */
export const NODE_ID_PROPS: readonly string[] = [
  "readingOrder",
  "reactions",
  "flows",
  "instanceOf",
  "mirrors",
  "textStyle",
  "path",
  "bindings",
  "variableModes",
  "values",
  "componentProps",
  "propValues",
];

/** Whether a node's properties hold ids of other layers (see `renameHeldIds`). */
export function holdsIds(props: Readonly<Props>): boolean {
  const p = props as Record<string, unknown>;
  return ID_HOLDING_PROPS.some((prop) => p[prop] !== undefined);
}

// ---------------------------------------------------------------------------
// The file as it converts

/**
 * The file as converted so far: stored nodes (an instance converted shows
 * its rewritten root and its records, and not the layers it had), plus what
 * the converter asks of the materialized form.
 */
export interface ConvertReader {
  get(id: string): NodeRecord | undefined;
  childIds(parent: string): readonly string[];
  /**
   * Every node stored under an instance root, override records aside: its
   * materialized layers. With a budget (`ConvertLimits.budget`), each is
   * charged to it as it's read (`nodeBytes`), and the converter gives them
   * back once the instance is done.
   */
  layersUnder(rootId: string): readonly NodeRecord[];
  /** A copy layer's derived id, when an earlier conversion renamed it. */
  renamed(id: string): string | undefined;
  /** The top-level instance roots inside a main's own layers (not inside its copies). */
  rootsInside(mainId: string): readonly string[];
  /** Whether a root was converted (or detached) already. */
  settled(rootId: string): boolean;
  /**
   * The size of what converting an instance holds, without reading it (the
   * size check): see `InstanceSize`.
   */
  sizeOf?(rootId: string): InstanceSize;
}

/** What converting an instance holds, counted before any of it is read (see `ConvertReader.sizeOf`). */
export interface InstanceSize {
  /** The nodes stored under its root: its materialized layers. */
  readonly layers: number;
  /**
   * The layers building it creates: what its main presents (a nested
   * instance counting its own main's layers again, however deep), plus what
   * any main its layers are swapped to presents. Building it holds them all,
   * whether or not they turn out to match.
   */
  readonly built: number;
  /** The stored nodes building it reads, each once: its layers, and every main's it's built from. */
  readonly reached: number;
  /** The bytes of the values of those nodes, as stored (UTF-8). */
  readonly bytes: number;
}

/** What bounds a run of conversions. */
export interface ConvertLimits {
  /**
   * The most layers an instance may have to be converted: it's held whole
   * while it is. A larger one throws `InstanceTooLarge`.
   */
  readonly maxInstanceLayers?: number;
  /**
   * The most layers building an instance may create (`InstanceSize.built`).
   * A larger one throws `InstanceTooLarge`, before any of it is read.
   */
  readonly maxInstanceBuilt?: number;
  /**
   * The most an instance may cost to be converted: the bytes of its values
   * and its mains' (`InstanceSize.bytes`), plus `layerBytes` for every node
   * read and every layer built. A larger one throws `InstanceTooLarge`,
   * before any of it is read.
   */
  readonly maxInstanceBytes?: number;
  /** What each node read and each layer built is charged in `maxInstanceBytes`. */
  readonly layerBytes?: number;
  /**
   * Asked before an instance of this size is read and converted: true
   * stops the run there (`stopped`), the instance left for the next.
   */
  readonly stop?: (size: InstanceSize) => boolean;
  /**
   * What building copies may hold, charged as they're built (see
   * `BuildBudget`). Past it, `settle` throws `BuildTooLarge`, having let go
   * of everything it built; the instance isn't settled.
   */
  readonly budget?: BuildBudget;
}

/** What converting an instance is charged against `ConvertLimits.maxInstanceBytes`. */
export function instanceCost(size: InstanceSize, layerBytes: number): number {
  return size.bytes + layerBytes * (size.reached + size.built);
}

/** An instance larger than a conversion holds at once: the file can't convert. */
export class InstanceTooLarge extends ModelError {
  constructor(
    readonly rootId: string,
    readonly layers: number,
    readonly limit: number,
    readonly unit: "layers" | "built" | "bytes" | "held" = "layers",
  ) {
    super(
      "invalid_value",
      unit === "layers"
        ? `The instance ${rootId} has ${layers.toLocaleString("en")} layers, more than the ${limit.toLocaleString("en")} converted at once.`
        : unit === "built"
          ? `The instance ${rootId} presents ${layers.toLocaleString("en")} layers from its components, more than the ${limit.toLocaleString("en")} built at once.`
          : unit === "bytes"
            ? `The instance ${rootId} and the components it's built from cost ${layers.toLocaleString("en")} bytes to convert, more than the ${limit.toLocaleString("en")} held at once.`
            : `Building the instance ${rootId} from its components would hold more than the ${Math.round(limit / 1024 / 1024)} MB a conversion holds at once.`,
    );
  }
}

/** What converting an instance gave. */
export interface ConvertedInstance {
  /** The instance root as stored now. */
  readonly root: NodeRecord;
  /** Its override records. */
  readonly records: readonly NodeRecord[];
  /** Its layers' old ids → derived ids. */
  readonly ids: ReadonlyMap<string, string>;
  /** The mains (and their sets) it was built from: a change to one means converting it again. */
  readonly deps: readonly string[];
}

export interface DetachedInstance {
  readonly root: NodeRecord;
  /** Its layers, unlinked. */
  readonly layers: readonly NodeRecord[];
  readonly why: string;
  readonly deps: readonly string[];
}

/** Where the converter puts what it decides; the reader shows it from then on. */
export interface ConvertSink {
  converted(result: ConvertedInstance): void;
  detached(result: DetachedInstance): void;
}

/** A node without the properties that link it to a main: what detaching leaves. */
export function unlinkedNode(node: NodeRecord): NodeRecord {
  const props: Record<string, unknown> = { ...node.props };
  delete props.instanceOf;
  delete props.mirrors;
  delete props.overrides;
  delete props.unset;
  return { ...node, props: props as Props };
}

const isSetNode = (node: NodeRecord | undefined) =>
  node?.type === "frame" && getProp(node.props, "isComponentSet");

/** Whether a record's values change which main its copy's layers come from. */
function swaps(props: Readonly<Record<string, unknown>>): boolean {
  return (
    props.instanceOf !== undefined ||
    ((props.unset as readonly string[] | undefined) ?? []).includes("instanceOf")
  );
}

/** The reader with the instance being converted written over it, and its old layers hidden. */
class Overlay {
  readonly #reader: ConvertReader;
  readonly #writes = new Map<string, NodeRecord | null>();
  #hidden: ReadonlySet<string> = new Set();

  constructor(reader: ConvertReader) {
    this.#reader = reader;
  }

  get(id: string): NodeRecord | undefined {
    const written = this.#writes.get(id);
    if (written !== undefined) return written ?? undefined;
    if (this.#hidden.has(id)) return undefined;
    return this.#reader.get(id);
  }

  childIds(parent: string): readonly string[] {
    return this.#reader.childIds(parent).filter((id) => this.get(id) !== undefined);
  }

  *nodes(): Iterable<NodeRecord> {
    // The view is lazy: it never asks for every node.
  }

  begin(hidden: ReadonlySet<string>): void {
    this.#writes.clear();
    this.#hidden = hidden;
  }

  put(node: NodeRecord): void {
    this.#writes.set(node.id, node);
  }

  remove(id: string): void {
    this.#writes.set(id, null);
  }

  /** What was written for the instance: its root and records (nulls are records it no longer has). */
  written(): Map<string, NodeRecord | null> {
    return new Map(this.#writes);
  }

  end(): void {
    this.#writes.clear();
    this.#hidden = new Set();
  }
}

/**
 * Converts top-level instance roots of a materialized file, each after
 * what it's built from. Keep one for a run of conversions (it caches what
 * mains look like); `settle` converts a root and what it needs first.
 */
export class InstanceConverter {
  readonly #reader: ConvertReader;
  readonly #overlay: Overlay;
  readonly #view: CopyView;
  readonly #sink: ConvertSink;
  /** Roots being settled, to stop at a main that contains its own instance. */
  readonly #doing = new Set<string>();
  readonly #prepared = new Set<string>();
  readonly #max: number;
  readonly #maxBuilt: number;
  readonly #maxBytes: number;
  readonly #layerBytes: number;
  readonly #stop: ((size: InstanceSize) => boolean) | undefined;
  readonly #budget: BuildBudget | null;
  #stopped = false;

  constructor(reader: ConvertReader, sink: ConvertSink, limits: ConvertLimits = {}) {
    this.#reader = reader;
    this.#sink = sink;
    this.#overlay = new Overlay(reader);
    this.#budget = limits.budget ?? null;
    this.#view = new CopyView(this.#overlay, { lazy: true, budget: this.#budget });
    this.#max = limits.maxInstanceLayers ?? Number.POSITIVE_INFINITY;
    this.#maxBuilt = limits.maxInstanceBuilt ?? Number.POSITIVE_INFINITY;
    this.#maxBytes = limits.maxInstanceBytes ?? Number.POSITIVE_INFINITY;
    this.#layerBytes = limits.layerBytes ?? 0;
    this.#stop = limits.stop;
  }

  /** Whether `limits.stop` stopped the run: nothing more is converted. */
  get stopped(): boolean {
    return this.#stopped;
  }

  /** Copy layers built and cached (to let go of them past a size). */
  get cached(): number {
    return this.#view.slotCount;
  }

  /** Lets go of everything cached. */
  clear(): void {
    this.#overlay.end();
    this.#view.clear();
    this.#prepared.clear();
  }

  /** Converts `rootId` (a top-level instance root), and first what it's built from. */
  settle(rootId: string): void {
    if (this.#stopped || this.#reader.settled(rootId) || this.#doing.has(rootId)) return;
    const root = this.#reader.get(rootId);
    const main = this.#view.mainOf(root);
    if (!root || !main) return;
    this.#doing.add(rootId);
    try {
      this.#prepare(main.id);
      if (this.#stopped) return;
      // Its size, before it's read: too large to hold, or more than this run has left.
      const size = this.#reader.sizeOf?.(rootId);
      if (size && size.layers > this.#max)
        throw new InstanceTooLarge(rootId, size.layers, this.#max);
      if (size && size.built > this.#maxBuilt)
        throw new InstanceTooLarge(rootId, size.built, this.#maxBuilt, "built");
      const cost = size ? instanceCost(size, this.#layerBytes) : 0;
      if (cost > this.#maxBytes) throw new InstanceTooLarge(rootId, cost, this.#maxBytes, "bytes");
      if (this.#stop?.(size ?? { layers: 0, built: 0, reached: 0, bytes: 0 })) {
        this.#stopped = true;
        return;
      }
      const layers = this.#reader.layersUnder(rootId);
      try {
        if (layers.length > this.#max) throw new InstanceTooLarge(rootId, layers.length, this.#max);
        for (const layer of layers) {
          const of = layer.type === "frame" ? layer.props.instanceOf : undefined;
          if (of && of !== main.id && isMainNode(this.#reader.get(of))) this.#prepare(of);
          if (this.#stopped) return;
        }
        if (this.#reader.settled(rootId)) return;
        this.#convert(root, main, layers);
      } finally {
        // The reader charged them as it read them (`ConvertReader.layersUnder`).
        if (this.#budget) {
          let bytes = 0;
          for (const layer of layers) bytes += nodeBytes(layer);
          this.#budget.release(bytes);
        }
      }
    } catch (error) {
      // Over budget part way: nothing half done is kept (the view let go of what it built).
      if (error instanceof BuildTooLarge) this.clear();
      throw error;
    } finally {
      this.#doing.delete(rootId);
    }
  }

  #prepare(mainId: string): void {
    if (this.#prepared.has(mainId)) return;
    this.#prepared.add(mainId);
    const main = this.#reader.get(mainId);
    if (main && this.#view.mainOf(main)) this.settle(mainId);
    for (const id of this.#reader.rootsInside(mainId)) {
      if (this.#stopped) break;
      this.settle(id);
    }
    // Stopped part way: what it holds isn't all converted yet.
    if (this.#stopped) this.#prepared.delete(mainId);
  }

  #deps(main: NodeRecord, layers: readonly NodeRecord[]): string[] {
    const deps = new Set<string>();
    const add = (id: string) => {
      deps.add(id);
      const node = this.#reader.get(id);
      if (node && isSetNode(this.#reader.get(node.parent))) deps.add(node.parent);
    };
    add(main.id);
    for (const layer of layers) {
      const of = layer.type === "frame" ? layer.props.instanceOf : undefined;
      if (of) add(of);
    }
    return [...deps];
  }

  #convert(root: NodeRecord, main: NodeRecord, layers: readonly NodeRecord[]): void {
    const deps = this.#deps(main, layers);
    const children = new Map<string, NodeRecord[]>();
    for (const node of layers) {
      if (node.type === "override") continue;
      const list = children.get(node.parent);
      if (list) list.push(node);
      else children.set(node.parent, [node]);
    }
    const stored = layers.filter((n) => n.type !== "override");
    // Records and no layers: stored compact already.
    if (stored.length === 0 && layers.length > 0) {
      this.#sink.converted({ root, records: [], ids: new Map(), deps });
      return;
    }
    // Its main contains an instance of itself (a file from before the model refused that): it
    // can't be built, so it keeps its layers, unlinked, and shows what it showed.
    if (this.#view.cyclic(main.id)) {
      this.#detach(root, stored, deps, "its component contains an instance of itself");
      return;
    }
    this.#overlay.begin(new Set(stored.map((n) => n.id)));
    const ids = new Map<string, string>();
    const outcome = (() => {
      try {
        return this.#match(root, children, stored, ids);
      } catch (error) {
        // Over budget: not this instance's to say, the run stops (`settle`).
        if (error instanceof BuildTooLarge) throw error;
        // A layer the view can't build (a value it refuses): left as it was, said why.
        return error instanceof Error ? error.message : String(error);
      }
    })();
    if (outcome === null) {
      const written = this.#overlay.written();
      const records: NodeRecord[] = [];
      for (const node of written.values()) if (node?.type === "override") records.push(node);
      const kept = written.get(root.id) ?? root;
      this.#overlay.end();
      this.#sink.converted({ root: kept, records, ids, deps });
      // An instance on a screen isn't read again: let go of it. One inside a main is (by its
      // main's instances), so it stays built.
      if (!this.#insideMain(root)) this.#view.release(root.id);
      return;
    }
    this.#overlay.end();
    this.#detach(root, stored, deps, outcome);
  }

  #detach(root: NodeRecord, stored: readonly NodeRecord[], deps: string[], why: string): void {
    // What was built from it as an instance (and which mains contain themselves) is worked out again.
    this.#view.clear();
    this.#prepared.clear();
    this.#sink.detached({
      root: unlinkedNode(root),
      layers: stored.map(unlinkedNode),
      why,
      deps,
    });
  }

  #insideMain(node: NodeRecord): boolean {
    const seen = new Set<string>();
    let at: NodeRecord | undefined = this.#reader.get(node.parent);
    while (at && !seen.has(at.id)) {
      seen.add(at.id);
      if (at.type === "frame" && getProp(at.props, "isComponent")) return true;
      at = this.#reader.get(at.parent);
    }
    return false;
  }

  /**
   * Writes the root and its records over the reader, then builds the
   * instance and checks it's its materialized layers exactly. Null when it
   * is; otherwise why not.
   */
  #match(
    root: NodeRecord,
    children: ReadonlyMap<string, readonly NodeRecord[]>,
    layers: readonly NodeRecord[],
    ids: Map<string, string>,
  ): string | null {
    const view = this.#view;
    const overlay = this.#overlay;
    const rename = (id: string) => ids.get(id) ?? this.#reader.renamed(id);
    const base = view.base(root.id);
    if (!base) return "its main isn't a component";
    const putRoot = (props: Readonly<Props>) => {
      const own = (ownValues(base.props, props, true) ?? {}) as Record<string, unknown>;
      // A record that exists stays, empty or not: it's what says its layers' values are its.
      if (props.propValues !== undefined) own.propValues = props.propValues;
      overlay.put({ ...root, props: own as Props });
      view.forget([root.id], [root.id]);
    };
    // The root as it's stored compact: its record takes what layers of a file from before records
    // hold for their properties (`foldValue`).
    let stored = root;
    putRoot(root.props);
    // The root as it was, whose record, when it has one, decides what its layers show
    // (`drivenShown`); and the layers that showed something else, as they show it.
    const recorded = root.props;
    const shown = new Map<string, Props>();
    // Nested instances whose stored layers are another component's than the swap their record
    // holds (materialized copies lag it too): built from the record's, and the stored layers
    // under them, which are the other component's, go (the record wins, as for a value).
    const staleSwaps = new Set<string>();
    const staleBelow = new Set<string>();
    const dropBelow = (id: string) => {
      for (const kid of children.get(id) ?? []) {
        staleBelow.add(kid.id);
        dropBelow(kid.id);
      }
    };
    const asShown = (node: NodeRecord): NodeRecord => {
      const props = shown.get(node.id);
      return props ? { ...node, props } : node;
    };

    const write = (
      slotId: string,
      path: readonly string[],
      values: Record<string, unknown> | null,
      structural: boolean,
    ) => {
      // A copy layer's record never holds property values: its instance's root holds them all
      // (decision 0035). A copy that holds some isn't its instance's, and the check says so.
      let own = values;
      if (own?.propValues !== undefined) {
        const { propValues: _, ...rest } = own;
        own = Object.keys(rest).length > 0 ? rest : null;
      }
      if (own)
        overlay.put({
          id: slotId,
          type: "override",
          parent: root.id,
          key: OVERRIDE_KEY,
          props: { path: [...path], ...own } as Props,
        });
      else overlay.remove(slotId);
      view.forget([slotId], structural ? [slotId] : []);
    };

    const slotOf = new Map<string, { id: string; path: readonly string[] }>();
    const walk = (dParent: string, presented: string): string | null => {
      const dKids = children.get(dParent) ?? [];
      const kids = view.childIds(presented);
      if (dKids.length !== kids.length)
        return `${dKids.length} layers under ${dParent}, ${kids.length} in its main`;
      const bySource = new Map<string, string>();
      for (const id of kids) {
        const slot = view.slot(id);
        if (!slot) return `${id} isn't a copy`;
        bySource.set(slot.source, id);
      }
      for (const node of dKids) {
        const mirrors = node.props.mirrors;
        // (Matched by what they copy; their order is checked below.)
        if (!mirrors) return `${node.id} copies nothing`;
        const source = rename(mirrors) ?? mirrors;
        const slotId = bySource.get(source);
        if (!slotId) return `no copy of ${mirrors} under ${presented}`;
        bySource.delete(source);
        const slot = view.slot(slotId);
        let slotBase = view.base(slotId);
        if (!slot || !slotBase || slotBase.type !== node.type || slot.key !== node.key)
          return `${node.id} isn't its main layer's type or place`;
        // Its main layer, as the main shows it: what a key the record doesn't keep shows.
        const main = view.get(slot.source)?.props;
        if (staleSwap(view.drivenFields(slotId), recorded, node, main)) {
          ids.set(node.id, slotId);
          slotOf.set(node.id, { id: slotId, path: slot.path });
          staleSwaps.add(node.id);
          dropBelow(node.id);
          continue;
        }
        // A layer written before its record's last value (materialized copies lag it) shows the
        // record's: the record wins, and its layer isn't another value of its own.
        const props = recordWins(view.drivenFields(slotId), recorded, node.props, main);
        if (props !== node.props) shown.set(node.id, props);
        // Only an instance from before records has its layers' values folded: one that keeps a
        // record (empty or not) decides them, and a key it doesn't keep is its main's.
        const folded = hasRecord(recorded)
          ? null
          : foldValue(view.drivenFields(slotId), slotBase.props, props, stored);
        if (folded) {
          stored = folded;
          putRoot(stored.props);
          slotBase = view.base(slotId) ?? slotBase;
        }
        ids.set(node.id, slotId);
        slotOf.set(node.id, { id: slotId, path: slot.path });
        const own = ownValues(slotBase.props, props);
        if (own) {
          const swapped = node.type === "frame" && swaps(own);
          write(slotId, slot.path, own, swapped);
          // Swapped: its base is the other main's now, so what it keeps is what differs from that.
          if (swapped)
            write(slotId, slot.path, ownValues((view.base(slotId) ?? slotBase).props, props), true);
        }
        const deeper = walk(node.id, slotId);
        if (deeper) return deeper;
      }
      // Drawn in the same order: stored, siblings go by key, then id; built, by their main's.
      const drawn = [...dKids].sort(compareSiblings);
      for (let i = 0; i < drawn.length; i++)
        if (ids.get((drawn[i] as NodeRecord).id) !== kids[i])
          return `the layers under ${dParent} draw in another order than its main's`;
      return null;
    };
    const unmatched = walk(root.id, root.id);
    if (unmatched) return unmatched;

    // Ids the layers hold, renamed now that every copy's id is known.
    const held = (node: NodeRecord) => renameHeldIds(node.props, rename) ?? node.props;
    if (holdsIds(stored.props)) putRoot(held(stored));
    for (const layer of layers) {
      const node = asShown(layer);
      if (staleSwaps.has(node.id) || staleBelow.has(node.id) || !holdsIds(node.props)) continue;
      const slot = slotOf.get(node.id) as { id: string; path: readonly string[] };
      const slotBase = view.base(slot.id);
      if (!slotBase) return `${node.id} has no base`;
      write(slot.id, slot.path, ownValues(slotBase.props, held(node)), false);
    }

    // The check: built again from what's written, it's the layers it was, ids renamed.
    view.forget([root.id], [root.id]);
    const presentedRoot = view.get(root.id);
    if (!presentedRoot) return "it can't be built";
    const differs = differences(held(stored), presentedRoot.props);
    if (differs) return `the instance's ${differs}`;
    let count = 0;
    const builtFresh = new Set([...staleSwaps].map((id) => ids.get(id) as string));
    const stack = [...view.childIds(root.id)];
    for (let id = stack.pop(); id !== undefined; id = stack.pop()) {
      count++;
      if (!builtFresh.has(id)) for (const child of view.childIds(id)) stack.push(child);
    }
    const kept = layers.length - staleBelow.size;
    if (count !== kept) return `${count} layers built, ${kept} stored`;
    for (const layer of layers) {
      if (staleBelow.has(layer.id)) continue;
      const node = asShown(layer);
      const id = ids.get(node.id) as string;
      const built = view.get(id);
      if (!built) return `${node.id} isn't built`;
      const parent = node.parent === root.id ? root.id : ids.get(node.parent);
      if (built.parent !== parent || built.key !== node.key || built.type !== node.type)
        return `${node.id} isn't where it was`;
      if (staleSwaps.has(node.id)) continue;
      const want: Record<string, unknown> = { ...held(node) };
      if (typeof want.mirrors === "string") want.mirrors = rename(want.mirrors) ?? want.mirrors;
      const off = differences(want as Props, built.props);
      if (off) return `layer ${node.id}'s ${off}`;
    }
    return null;
  }
}

/**
 * A file from before records (decision 0035, item 3) holds what an instance
 * set for a property on the layers it drives. A copy layer that holds, on
 * a field a property drives, another value than its instance's record and
 * main give it (`base`) has it folded into the record: the root as stored
 * with it (null when there's nothing to fold). A key the record has
 * already isn't changed (a layer disagreeing with it fails the check, and
 * its instance is left detached, as it draws), nor is a value past the
 * record's bounds.
 */
function foldValue(
  fields: readonly DrivenField[],
  base: Readonly<Record<string, unknown>>,
  layer: Readonly<Props>,
  root: NodeRecord,
): NodeRecord | null {
  if (fields.length === 0) return null;
  const record = { ...((root.props.propValues ?? {}) as Record<string, PropertyValue>) };
  let changed = false;
  for (const [field, key] of fields) {
    if (record[key] !== undefined) continue;
    const value = drivenValue(layer as Record<string, unknown>, field);
    if (value === null || sameValue(value, drivenValue(base, field))) continue;
    record[key] = value;
    changed = true;
  }
  if (!changed) return null;
  if (
    Object.keys(record).length > MAX_PROPERTY_VALUES ||
    propertyValuesChars(record) > MAX_PROPERTY_VALUES_CHARS
  )
    return null;
  return { ...root, props: { ...root.props, propValues: record } };
}

/**
 * A layer's properties with each field a property drives as it shows
 * (`drivenShown`): when its instance keeps a record, the record's value, or
 * its main layer's (`main`) for a key the record doesn't keep (a reset); a
 * layer showing another was written before the record's last change
 * (materialized copies lag it), and the record wins. Without a record (from
 * before records) the layer's own, which `foldValue` takes into one. A swap
 * isn't here (`staleSwap`), nor a field the layer itself no longer
 * references (an import unlinks one showing another value, and it's its
 * own). The same object when nothing changes.
 */
function recordWins(
  fields: readonly DrivenField[],
  root: Readonly<Props>,
  layer: Readonly<Props>,
  main: Readonly<Props> | undefined,
): Readonly<Props> {
  let out: Record<string, unknown> | null = null;
  const refs = (layer.propRefs ?? {}) as Record<string, string | undefined>;
  for (const [field, key] of fields) {
    if (field === "instanceOf" || !refs[field]) continue;
    const value = drivenShown(field, key, root, layer, main);
    if (value === null || sameValue(value, drivenValue(layer as Record<string, unknown>, field)))
      continue;
    out ??= { ...layer };
    if (field === "visible" && value === true) delete out.visible;
    else out[field] = value;
  }
  return (out ?? layer) as Readonly<Props>;
}

/**
 * Whether a nested instance's stored layers are another component's than the
 * one it shows (`drivenShown`, as detach and unlink read it): the swap its
 * instance's record keeps, or its main layer's component for a key the
 * record doesn't keep. Written before the record's last change (materialized
 * copies lag it), so the record wins and the instance is built from that one.
 */
function staleSwap(
  fields: readonly DrivenField[],
  root: Readonly<Props>,
  layer: NodeRecord,
  main: Readonly<Props> | undefined,
): boolean {
  if (layer.type !== "frame" || !layer.props.propRefs?.instanceOf) return false;
  const driven = fields.find(([field]) => field === "instanceOf");
  if (!driven) return false;
  const shown = drivenShown("instanceOf", driven[1], root, layer.props, main);
  return (
    typeof shown === "object" &&
    shown !== null &&
    typeof shown.instance === "string" &&
    shown.instance !== layer.props.instanceOf
  );
}

/** A driven field's value in properties, as a record holds it. */
function drivenValue(
  props: Readonly<Record<string, unknown>>,
  field: string,
): PropertyValue | null {
  if (field === "visible") return props.visible !== false;
  if (field === "characters") return typeof props.characters === "string" ? props.characters : "";
  if (field === "instanceOf")
    return typeof props.instanceOf === "string" ? { instance: props.instanceOf } : null;
  return null;
}

/** The first property two nodes' values differ in (a missing value equals its default), or null. */
function differences(want: Readonly<Props>, have: Readonly<Props>): string | null {
  const a = want as Record<string, unknown>;
  const b = have as Record<string, unknown>;
  for (const prop of new Set([...Object.keys(a), ...Object.keys(b)]))
    if (!samePropValue(prop, a[prop], b[prop]))
      return `${prop} is ${JSON.stringify(b[prop])} built, ${JSON.stringify(a[prop])} stored`;
  return null;
}

// ---------------------------------------------------------------------------
// A document in memory, through the same steps (tests, and small files)

/** Top-level instance roots of a stored document, and the mains they're inside, in file order. */
export function topLevelRoots(
  get: (id: string) => NodeRecord | undefined,
  childIds: (parent: string) => readonly string[],
  from: string,
): { roots: string[]; inside: Map<string, string[]> } {
  const roots: string[] = [];
  const inside = new Map<string, string[]>();
  const isLive = (node: NodeRecord) => {
    const of = node.type === "frame" ? node.props.instanceOf : undefined;
    return !!of && of !== node.id && isMainNode(get(of));
  };
  const stack: Array<{ id: string; mains: readonly string[] }> = [];
  for (const id of [...childIds(from)].reverse()) stack.push({ id, mains: [] });
  for (let at = stack.pop(); at; at = stack.pop()) {
    const node = get(at.id);
    if (!node || node.type === "override") continue;
    if (isLive(node)) {
      roots.push(node.id);
      for (const main of at.mains) {
        const list = inside.get(main);
        if (list) list.push(node.id);
        else inside.set(main, [node.id]);
      }
      continue;
    }
    const mains = isMainNode(node) ? [...at.mains, node.id] : at.mains;
    for (const id of [...childIds(node.id)].reverse()) stack.push({ id, mains });
  }
  return { roots, inside };
}

/** What `compactByInstance` gives: the stored form, renames, and the instances it detached and why. */
export interface InstanceCompactResult {
  readonly nodes: NodeRecord[];
  readonly ids: ReadonlyMap<string, string>;
  readonly detached: ReadonlyMap<string, string>;
}

/**
 * A materialized document in the compact form, converted an instance at a
 * time as the room converts a stored file (`compact` does the same in one
 * pass). Ids other layers hold are renamed too.
 */
export function compactByInstance(input: Iterable<NodeRecord>): InstanceCompactResult {
  const store = new MemoryStore(input);
  const { roots, inside } = topLevelRoots(
    (id) => store.get(id),
    (parent) => store.childIds(parent),
    ROOT_ID,
  );
  const ids = new Map<string, string>();
  const settled = new Set<string>();
  const detached = new Map<string, string>();
  const subtree = (id: string): NodeRecord[] => {
    const out: NodeRecord[] = [];
    const stack = [...store.childIds(id)];
    for (let at = stack.pop(); at !== undefined; at = stack.pop()) {
      const node = store.get(at);
      if (!node) continue;
      out.push(node);
      stack.push(...store.childIds(at));
    }
    return out;
  };
  const replace = (node: NodeRecord) => {
    if (store.get(node.id)) store.replaceProps(node.id, node.props);
    else store.insert(node);
  };
  const reader: ConvertReader = {
    get: (id) => store.get(id),
    childIds: (parent) => store.childIds(parent),
    layersUnder: subtree,
    renamed: (id) => ids.get(id),
    rootsInside: (mainId) => inside.get(mainId) ?? [],
    settled: (id) => settled.has(id),
  };
  const converter = new InstanceConverter(reader, {
    converted(result) {
      settled.add(result.root.id);
      const old = subtree(result.root.id);
      for (let i = old.length - 1; i >= 0; i--) store.remove((old[i] as NodeRecord).id);
      replace(result.root);
      for (const record of result.records) store.insert(record);
      for (const [from, to] of result.ids) ids.set(from, to);
    },
    detached(result) {
      settled.add(result.root.id);
      detached.set(result.root.id, result.why);
      replace(result.root);
      for (const layer of result.layers) replace(layer);
    },
  });
  for (const root of roots) converter.settle(root);
  // Ids held anywhere (a reading order, a prototype link), override records included, follow the
  // copies they name: an instance can name another's, converted after it.
  for (const node of [...store.nodes()]) {
    if (!holdsIds(node.props)) continue;
    const renamed = renameHeldIds(node.props, (id) => ids.get(id));
    if (renamed) store.replaceProps(node.id, renamed);
  }
  return { nodes: [...store.nodes()], ids, detached };
}
