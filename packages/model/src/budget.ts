/**
 * A hard bound on what building copies holds (decision 0029), counted as
 * it's built rather than worked out beforehand.
 *
 * Counting a copy's size before building it has missed a shape three times
 * (intermediate copies of nested mains, their paths, mains that contain
 * their own instances), and a Durable Object that runs out of memory fails
 * whatever it was doing. So whatever builds copies on the server
 * (`CopyView`, and the readers it reads through) charges a `BuildBudget`
 * for what it creates and keeps, and gives it back when it lets go:
 * every copy layer built (its slot, its path, its place in the view's
 * maps), every presented node cached (with its values), every row parsed
 * and kept. One budget covers a whole operation (a step of a conversion, a
 * removal check). Past its limit it throws `BuildTooLarge`, which the
 * operation catches: a conversion stops and leaves the file materialized,
 * a removal is refused, saying why.
 *
 * Costs are estimates of V8's heap, in bytes. The memory check
 * (apps/worker/test-node/copy-budget.test.ts) runs generated shapes under a
 * 64 MB heap to hold them to it.
 */

/** Thrown when building copies would hold more than its budget allows. */
export class BuildTooLarge extends Error {
  override name = "BuildTooLarge";
  constructor(
    /** What it would have held (bytes), or built in all (layers). */
    readonly amount: number,
    readonly limit: number,
    readonly unit: "bytes" | "layers",
  ) {
    super(
      unit === "bytes"
        ? `building these copies would hold about ${Math.ceil(amount / 1024 / 1024)} MB, more than the ${Math.round(limit / 1024 / 1024)} MB allowed at once`
        : `building these copies would build more than ${limit.toLocaleString("en")} layers`,
    );
  }
}

export interface BuildBudgetLimits {
  /** The most bytes held at once (estimated). */
  readonly bytes: number;
  /** The most copy layers built in all, released or not (a bound on time). */
  readonly layers?: number;
}

/** What an operation's builders hold, charged as they build and given back as they let go. */
export class BuildBudget {
  readonly limit: number;
  readonly maxLayers: number;
  #held = 0;
  #peak = 0;
  #layers = 0;

  constructor({ bytes, layers = Number.POSITIVE_INFINITY }: BuildBudgetLimits) {
    this.limit = bytes;
    this.maxLayers = layers;
  }

  /** Bytes held now (estimated). */
  get held(): number {
    return this.#held;
  }

  /** The most held at once so far. */
  get peak(): number {
    return this.#peak;
  }

  /** Copy layers built so far. */
  get layers(): number {
    return this.#layers;
  }

  /** Charges `bytes` about to be kept; throws `BuildTooLarge` (charging nothing) past the limit. */
  charge(bytes: number): void {
    const next = this.#held + bytes;
    if (next > this.limit) throw new BuildTooLarge(next, this.limit, "bytes");
    this.#held = next;
    if (next > this.#peak) this.#peak = next;
  }

  /**
   * Counts `bytes` already kept, without refusing them: for a change that
   * has to apply whole (a transaction a room committed), whose holder checks
   * `over` once it's applied and lets go of everything when it is.
   */
  hold(bytes: number): void {
    this.#held += bytes;
    if (this.#held > this.#peak) this.#peak = this.#held;
  }

  /** Whether more is held than the limit (only `hold` can take it there). */
  get over(): boolean {
    return this.#held > this.limit;
  }

  /** Gives back what was charged and let go of. */
  release(bytes: number): void {
    this.#held = Math.max(0, this.#held - bytes);
  }

  /** Counts a copy layer built; throws `BuildTooLarge` past `layers`. */
  built(): void {
    if (this.#layers >= this.maxLayers)
      throw new BuildTooLarge(this.#layers + 1, this.maxLayers, "layers");
    this.#layers++;
  }
}

// ---------------------------------------------------------------------------
// Estimates (bytes of V8 heap)

/**
 * A copy layer's slot: the slot, its id, its path's array, its entries in
 * the view's maps (the set of copies of its source among them). Measured in
 * Node (arm64, each shape in a fresh process): about 800 bytes a slot all
 * told for short paths, and up to 19 more a path element for long ones.
 */
export function slotBytes(pathLength: number): number {
  return 600 + 16 * pathLength;
}

/** A list of `n` ids kept (child lists): the array and the id strings. */
export function idsBytes(n: number): number {
  return 32 + 48 * n;
}

/** A small cache entry (an id to an id, or to a flag). */
export const ENTRY_BYTES = 96;

/** A character past Latin-1: V8 keeps such a string two bytes a character. */
const WIDE = /[\u0100-\uffff]/;

/** A value as V8 holds it, about: strings a byte a character (two past Latin-1), objects and arrays with their slots. */
export function valueBytes(value: unknown): number {
  if (typeof value === "string") return 16 + (WIDE.test(value) ? 2 : 1) * value.length;
  if (typeof value !== "object" || value === null) return 8;
  if (Array.isArray(value)) {
    let n = 16 + 8 * value.length;
    for (const item of value) n += valueBytes(item);
    return n;
  }
  let n = 24;
  for (const [key, item] of Object.entries(value)) n += 16 + key.length + valueBytes(item);
  return n;
}

/** A node record held (parsed from a row, or presented): the record, its ids, its values. */
export function nodeBytes(node: {
  readonly id: string;
  readonly parent: string;
  readonly key: string;
  readonly props: unknown;
}): number {
  return 120 + node.id.length + node.parent.length + node.key.length + valueBytes(node.props);
}

// ---------------------------------------------------------------------------
// What a document held in memory keeps (the headless editor's meter)

/**
 * A value as V8 holds it once parsed, counted closer than `valueBytes`
 * (which the copy builders' budgets were set with) but never under it, as
 * measured in Node 26 (apps/worker/test-node/agent-meter.test.ts):
 *
 * - a string: its header and characters, a byte each (two past Latin-1),
 *   to a whole word; short ones JSON.parse shares are counted anyway;
 * - a number: nothing past its slot when it's a small integer, a boxed
 *   double otherwise; true, false and null nothing (V8 shares them);
 * - an array: its object and backing store, a slot an item;
 * - an object: its header and a slot a property (keys are shared), or,
 *   past 64 properties (which V8 may keep as a hash table), three slots a
 *   property at twice its count and its key.
 */
export function heapBytes(value: unknown): number {
  if (typeof value === "string") return stringBytes(value);
  if (typeof value === "number")
    return Number.isInteger(value) && value >= -(2 ** 30) && value < 2 ** 30 ? 0 : 16;
  if (typeof value !== "object" || value === null) return 0;
  if (Array.isArray(value)) {
    let n = 48 + 8 * value.length;
    for (const item of value) n += heapBytes(item);
    return n;
  }
  const entries = Object.entries(value);
  if (entries.length > 64) {
    let n = 64;
    for (const [key, item] of entries) n += 48 + stringBytes(key) + heapBytes(item);
    return n;
  }
  let n = OBJECT_BYTES;
  for (const [, item] of entries) n += SLOT_BYTES + heapBytes(item);
  return n;
}

/** An object's header and properties backing store, and what a property's slot takes in it. */
const OBJECT_BYTES = 40;
/** The least `heapBytes` counts for an object. */
export const LEAST_OBJECT_BYTES = OBJECT_BYTES;
const SLOT_BYTES = 12;

function stringBytes(s: string): number {
  return 8 * Math.ceil((16 + (WIDE.test(s) ? 2 : 1) * s.length) / 8);
}

/**
 * What a `MemoryStore` keeps for a node beside its ids and values: the
 * record, its type, the strings' headers, its entry in the id map, its id
 * in its parent's child list, and its own list when it has children.
 */
export const STORED_NODE_BYTES = 200;

/** A node kept in a `MemoryStore`: its record, its ids and values (`heapBytes`), the store's entries. */
export function storedBytes(node: {
  readonly id: string;
  readonly parent: string;
  readonly key: string;
  readonly props: unknown;
}): number {
  return (
    STORED_NODE_BYTES +
    node.id.length +
    node.parent.length +
    node.key.length +
    heapBytes(node.props)
  );
}

/** What setting a node's `prop` from `before` to `after` (undefined: not set) changes its `storedBytes` by. */
export function propBytes(before: unknown, after: unknown): number {
  const of = (value: unknown) => (value === undefined ? 0 : SLOT_BYTES + heapBytes(value));
  return of(after) - of(before);
}

/**
 * A presented copy layer the editor's view keeps (`CopyView`'s `cost`): its
 * record and the object of its values, which point at values its main and
 * its record already hold.
 */
export function presentedBytes(node: {
  readonly id: string;
  readonly parent: string;
  readonly key: string;
  readonly props: object;
}): number {
  return (
    STORED_NODE_BYTES +
    node.id.length +
    node.parent.length +
    node.key.length +
    OBJECT_BYTES +
    SLOT_BYTES * Object.keys(node.props).length
  );
}
