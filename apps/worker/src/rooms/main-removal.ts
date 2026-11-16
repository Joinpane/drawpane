/**
 * Removing a component's main from a file stored with compact copies
 * (decision 0029) without changing what any instance of it shows.
 *
 * An instance stores only what differs from its main, so a main that stops
 * being one (deleted, inside something deleted, un-made a component, moved
 * into an instance) takes its look with it unless the instance stores that
 * look first. The editor does that in the same transaction: it stores each
 * instance's layers as they show. A client whose view of the file is behind
 * (someone added a layer to the main, or changed a fill, since it last
 * heard) stores what it saw, which isn't what the instance showed: the room
 * must refuse that, or an acknowledged edit is lost.
 *
 * The rule: a transaction that removes a main leaves every instance of it
 * that survives showing exactly what it showed before. The room works out,
 * before the transaction applies and inside its storage transaction, what
 * each instance it may affect shows (built with the model's `CopyView`, as
 * the editor builds it), and again after; any difference refuses it.
 *
 * - What's compared is the look: each layer's type, its place among its
 *   siblings and its values, a missing value equal to its default. Not ids
 *   (storing a nested instance's layers gives them other derived ids), not
 *   the properties that link a copy to its main (`mirrors`, `overrides`,
 *   `unset`), and not an instance root's own placement (`x`, `y` and the
 *   other root-local values: never its main's to take).
 * - Which instances: those of the main (stored roots, and instances with a
 *   copy swapped to it), and, because storing a nested instance's layers
 *   gives them other ids, any instance with override records of a main that
 *   holds one of those (a record names its layer by id). An instance without
 *   records shows its main exactly, which is checked through the instances
 *   inside it.
 * - Which mains a transaction removes isn't always known before it applies
 *   (a restore or a merge produces its operations as it goes). Each
 *   operation names the mains it may remove; after the last, those that
 *   aren't mains any more are what it removed. If the room didn't look at
 *   their instances before, it throws `RemovalNeedsLooks`: the caller rolls
 *   the storage transaction back and runs it again, looking first.
 * - Bounded as it's built: one `BuildBudget` covers the check, before and
 *   after, charged for every copy built (intermediate copies of nested
 *   mains and their paths too), every node presented and every row parsed
 *   and kept (`BUILD_HELD_BYTES`), and for every layer built in all
 *   (`REMOVAL_CHECK_LAYERS`). Each instance lets go of what it read and
 *   built before the next is looked at. An instance that can't be built
 *   within it, or instances too many to build, refuse the removal, saying
 *   so. Each instance is also measured in SQL first, under the
 *   conversion's limits (`INSTANCE_LIMITS`): a cheap first filter.
 *
 * Nothing here imports `cloudflare:workers`.
 */
import {
  BuildBudget,
  BuildTooLarge,
  COPY_LINK_PROPS,
  CopyView,
  instanceCost,
  isMainNode,
  ModelError,
  type NodeRecord,
  type Op,
  ROOT_ID,
  ROOT_LOCAL_PROPS,
  samePropValue,
} from "@drawpane/model";
import { BUILD_HELD_BYTES, INSTANCE_LIMITS, PresentedCounter } from "./convert";

/**
 * The most layers the room builds, before and after together, to check a
 * removal: about a second of building in Node. A main whose instances show
 * more than that in all can't be removed in one transaction; its instances
 * can be detached first.
 */
export const REMOVAL_CHECK_LAYERS = 400_000;

/** What reads the file for the check: its stored form, and how to forget what's cached. */
export interface RemovalStore {
  get(id: string): NodeRecord | undefined;
  childIds(parent: string): readonly string[];
  clearCache(): void;
  /** Charges what it parses and keeps to `budget` until its cache empties (see `SqlNodeStore`). */
  meter?(budget: BuildBudget | null): void;
}

/**
 * Thrown by `MainRemoval.check` when the transaction removed a main whose
 * instances weren't looked at before it applied: roll it back and run it
 * again with `mains` looked at first.
 */
export class RemovalNeedsLooks extends Error {
  constructor(
    readonly mains: ReadonlySet<string>,
    /** What the transaction deleted (the targets of its deletes): instances there aren't looked at. */
    readonly deleted: ReadonlySet<string> | null,
  ) {
    super("a removed main's instances weren't looked at before the transaction");
  }
}

interface Look {
  /** The hash of what it showed. */
  readonly look: string;
  /** The removed mains it depends on. */
  readonly mains: ReadonlySet<string>;
}

/** `prefix` and a layer's name in quotes, or `fallback` when it has none. */
const named = (node: NodeRecord | undefined, prefix: string, fallback: string) => {
  const name = (node?.props as { name?: unknown } | undefined)?.name;
  return typeof name === "string" && name.trim() ? `${prefix} “${name.trim()}”` : fallback;
};

/** One storage transaction's check (see the module comment). */
export class MainRemoval {
  readonly #sql: SqlStorage;
  readonly #store: RemovalStore;
  /** Mains the operations may have removed, noted before each applies. */
  readonly #noted = new Set<string>();
  /** Mains whose instances were looked at before anything applied. */
  readonly #looked = new Set<string>();
  /** Instances not looked at because the transaction was to delete them. */
  readonly #skipped = new Set<string>();
  /** The targets of the deletes noted (null once there are too many to keep). */
  #deleted: Set<string> | null = new Set();
  readonly #looks = new Map<string, Look>();
  /** What each looked-at main and instance is called, from before. */
  readonly #names = new Map<string, string>();
  #built = 0;
  readonly #budget: BuildBudget;
  readonly #precount: boolean;

  constructor(
    sql: SqlStorage,
    store: RemovalStore,
    {
      heldBytes = BUILD_HELD_BYTES,
      precount = true,
    }: {
      readonly heldBytes?: number;
      /** Measure each instance in SQL first (the cheap filter). Off: the budget alone (the memory check). */
      readonly precount?: boolean;
    } = {},
  ) {
    this.#sql = sql;
    this.#store = store;
    this.#budget = new BuildBudget({ bytes: heldBytes, layers: REMOVAL_CHECK_LAYERS });
    this.#precount = precount;
  }

  /** What the check has held at most, as its budget estimates it (for the memory check). */
  get peakHeld(): number {
    return this.#budget.peak;
  }

  /**
   * The mains `ops` certainly remove (deleted, inside something deleted, or
   * un-made): what to look at before they apply, in the common case.
   */
  static predicted(sql: SqlStorage, store: RemovalStore, ops: readonly Op[]): Set<string> {
    const out = new Set<string>();
    for (const op of ops) {
      if (op.op === "delete") for (const id of mainsUnder(sql, op.id)) out.add(id);
      else if (
        op.op === "set" &&
        op.prop === "isComponent" &&
        !op.value &&
        isMainNode(store.get(op.id))
      )
        out.add(op.id);
    }
    store.clearCache();
    return out;
  }

  /**
   * Before any operation applies: looks at what the instances of `mains`
   * show, but those at or under `deleted` (what the transaction deletes:
   * they won't be there to compare; `check` makes sure).
   */
  lookFirst(mains: Iterable<string>, deleted: ReadonlySet<string> = new Set()): void {
    const fresh = [...mains].filter((id) => !this.#looked.has(id));
    if (fresh.length === 0) return;
    for (const id of fresh) {
      this.#looked.add(id);
      this.#names.set(id, named(this.#store.get(id), "the component", "a component"));
    }
    const counter = new PresentedCounter(this.#sql, "nodes");
    const view = this.#view();
    this.#store.meter?.(this.#budget);
    try {
      for (const [root, mains] of this.#affected(fresh)) {
        if (deleted.size > 0 && this.#under(root, deleted)) {
          this.#skipped.add(root);
          continue;
        }
        const known = this.#looks.get(root);
        if (known) {
          this.#looks.set(root, { look: known.look, mains: new Set([...known.mains, ...mains]) });
          continue;
        }
        // As people see it: an instance takes its name from its main unless it has its own.
        this.#names.set(root, named(view.get(root), "its instance", "one of its instances"));
        this.#looks.set(root, { look: this.#lookOf(view, counter, root, mains), mains });
      }
    } finally {
      view.clear();
      this.#store.meter?.(null);
      this.#store.clearCache();
    }
  }

  /** Before each run of operations applies: the mains they may remove. */
  note(ops: readonly Op[]): void {
    for (const op of ops) {
      if (op.op === "delete") {
        this.#deleted?.add(op.id);
        if ((this.#deleted?.size ?? 0) > 200_000) this.#deleted = null;
      }
      if (op.op === "delete" || op.op === "move") {
        for (const id of mainsUnder(this.#sql, op.id)) this.#noted.add(id);
      } else if (op.op === "set" && isMainNode(this.#store.get(op.id))) this.#noted.add(op.id);
    }
    this.#store.clearCache();
  }

  /**
   * After every operation applied, before the storage transaction ends:
   * throws `RemovalNeedsLooks` when it removed a main not looked at first,
   * and a `ModelError` when an instance of a removed main shows something
   * else now (or is too large to check).
   */
  check(): void {
    this.#store.clearCache();
    try {
      const removed = [...this.#noted].filter((id) => !this.#isMain(id));
      if (removed.length === 0) return;
      // Not looked at first, or skipped as deleted and there after all: looked at, again.
      if (removed.some((id) => !this.#looked.has(id)))
        throw new RemovalNeedsLooks(new Set([...this.#looked, ...removed]), this.#deleted);
      for (const root of this.#skipped)
        if (this.#store.get(root)) throw new RemovalNeedsLooks(new Set(this.#looked), null);
      const gone = new Set(removed);
      const counter = new PresentedCounter(this.#sql, "nodes");
      const view = this.#view();
      this.#store.meter?.(this.#budget);
      try {
        for (const [root, before] of this.#looks) {
          const main = [...before.mains].find((id) => gone.has(id));
          if (main === undefined || !this.#store.get(root)) continue;
          if (this.#lookOf(view, counter, root, before.mains) !== before.look)
            throw new ModelError(
              "conflict",
              `Removing ${this.#names.get(main)} would change how ${this.#names.get(root)} looks, so nothing was changed. If someone just changed that instance or the component, try again; otherwise detach the instance first.`,
            );
        }
      } finally {
        view.clear();
        this.#store.meter?.(null);
      }
    } finally {
      this.#store.clearCache();
    }
  }

  #view(): CopyView {
    return new CopyView(
      {
        get: (id) => this.#store.get(id),
        childIds: (id) => this.#store.childIds(id),
        nodes: () => [],
      },
      { lazy: true, budget: this.#budget },
    );
  }

  /** Whether `id` is a main now: a component, and not inside an instance (where it's a copy). */
  #isMain(id: string): boolean {
    if (!isMainNode(this.#store.get(id))) return false;
    const seen = new Set<string>();
    for (let at = this.#store.get(id)?.parent; at && at !== ROOT_ID; ) {
      if (seen.has(at)) return false;
      seen.add(at);
      const node = this.#store.get(at);
      if (!node) return false;
      const of = node.type === "frame" ? node.props.instanceOf : undefined;
      if (of && of !== node.id && isMainNode(this.#store.get(of))) return false;
      at = node.parent;
    }
    return true;
  }

  /**
   * The instances whose look the removal of `mains` may change, each with
   * the removed mains it depends on: their instances (and instances with a
   * copy swapped to one), and, through every main holding one of those (or
   * being one), that main's instances that keep override records, and so
   * on (see the module comment).
   */
  #affected(mains: readonly string[]): Map<string, Set<string>> {
    const out = new Map<string, Set<string>>();
    const from = new Map<string, Set<string>>(mains.map((id) => [id, new Set([id])]));
    const seen = new Set(mains);
    let frontier = [...mains];
    let direct = true;
    while (frontier.length > 0) {
      const next: string[] = [];
      for (const main of frontier) {
        const origin = from.get(main) as Set<string>;
        for (const { id, records } of this.#instancesOf(main)) {
          // A main holding this instance, or this instance being one: its own instances follow.
          for (const holder of this.#mainsHolding(id)) {
            const was = from.get(holder);
            if (was) for (const o of origin) was.add(o);
            else from.set(holder, new Set(origin));
            if (!seen.has(holder)) {
              seen.add(holder);
              next.push(holder);
            }
          }
          if (!direct && !records) continue;
          const mainsOf = out.get(id);
          if (mainsOf) for (const o of origin) mainsOf.add(o);
          else out.set(id, new Set(origin));
        }
      }
      frontier = next;
      direct = false;
    }
    return out;
  }

  /** The stored instance roots of `main`, or with a copy swapped to it, and whether each keeps records. */
  #instancesOf(main: string): Array<{ id: string; records: boolean }> {
    return this.#sql
      .exec<{ id: string; records: number }>(
        `SELECT r.id, EXISTS (SELECT 1 FROM nodes o WHERE o.parent = r.id AND o.type = 'override') AS records
           FROM nodes r
          WHERE r.id IN (
            SELECT id FROM nodes WHERE type = 'frame' AND json_extract(props, '$.instanceOf') = ?1 AND id != ?1
            UNION SELECT parent FROM nodes WHERE type = 'override' AND json_extract(props, '$.instanceOf') = ?1)`,
        main,
      )
      .toArray()
      .map((row) => ({ id: row.id, records: row.records === 1 }));
  }

  /** Whether `id` is, or is inside, one of `ids`. */
  #under(id: string, ids: ReadonlySet<string>): boolean {
    const seen = new Set<string>();
    for (let at: string | undefined = id; at && at !== ROOT_ID && !seen.has(at); ) {
      if (ids.has(at)) return true;
      seen.add(at);
      at = this.#store.get(at)?.parent;
    }
    return false;
  }

  /** The mains `id` is, or is inside. */
  #mainsHolding(id: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (let at: string | undefined = id; at && at !== ROOT_ID && !seen.has(at); ) {
      seen.add(at);
      const node = this.#store.get(at);
      if (!node) break;
      if (isMainNode(node)) out.push(at);
      at = node.parent;
    }
    return out;
  }

  /** What `root` shows, hashed; measured first, and refused when too large to build. */
  #lookOf(
    view: CopyView,
    counter: PresentedCounter,
    root: string,
    mains: ReadonlySet<string>,
  ): string {
    const size = this.#precount
      ? counter.sizeOf(root)
      : { layers: 0, built: 0, reached: 0, bytes: 0 };
    const limits = INSTANCE_LIMITS;
    const main = this.#names.get([...mains][0] as string) ?? "a component";
    const instance =
      this.#names.get(root) ?? named(this.#store.get(root), "its instance", "one of its instances");
    const tooLarge = (what: string) =>
      new ModelError(
        "conflict",
        `Removing ${main} needs Drawpane to check that ${instance} keeps its look, and that instance is too large to check (${what}), so nothing was changed. Detach the instance first, or keep the component.`,
      );
    if (size.layers > limits.maxInstanceLayers)
      throw tooLarge(
        `${size.layers.toLocaleString("en")} layers stored, more than ${limits.maxInstanceLayers.toLocaleString("en")}`,
      );
    if (size.built > limits.maxInstanceBuilt)
      throw tooLarge(
        `${size.built.toLocaleString("en")} layers shown, more than ${limits.maxInstanceBuilt.toLocaleString("en")}`,
      );
    const cost = instanceCost(size, limits.layerBytes);
    if (cost > limits.maxInstanceBytes)
      throw tooLarge(
        `${Math.ceil(cost / 1024 / 1024)} MB to build, more than ${limits.maxInstanceBytes / 1024 / 1024} MB`,
      );
    const tooMany = () =>
      new ModelError(
        "conflict",
        `Removing ${main} needs Drawpane to check that its instances keep their look, and they show more than ${REMOVAL_CHECK_LAYERS.toLocaleString("en")} layers, too many to check at once, so nothing was changed. Detach some of its instances first.`,
      );
    this.#built += size.built + 1;
    if (this.#built > REMOVAL_CHECK_LAYERS) throw tooMany();
    // What was cached for the instances before (mains built, rows read) counts against this one:
    // past the budget with any of it held, it's let go of and this one is built afresh.
    for (let attempt = 0; ; attempt++) {
      const before = this.#budget.held;
      try {
        return lookHash(view, root);
      } catch (error) {
        if (!(error instanceof BuildTooLarge)) throw error;
        view.clear();
        this.#store.clearCache();
        if (error.unit === "layers") throw tooMany();
        if (attempt > 0 || before === 0)
          throw tooLarge(`more than ${Math.round(error.limit / 1024 / 1024)} MB to build`);
      } finally {
        // What this instance read and built goes before the next is looked at: its records
        // and their values most of all.
        view.release(root);
        this.#store.clearCache();
        if (this.#budget.held > this.#budget.limit / 2) view.clear();
      }
    }
  }
}

/** The mains at or under `id`, in SQL. */
function mainsUnder(sql: SqlStorage, id: string): string[] {
  return sql
    .exec<{ id: string }>(
      `WITH RECURSIVE sub(id) AS (SELECT ? UNION ALL SELECT n.id FROM nodes n JOIN sub ON n.parent = sub.id)
       SELECT n.id FROM sub CROSS JOIN nodes n ON n.id = sub.id
        WHERE n.type = 'frame' AND json_extract(n.props, '$.isComponent') = 1`,
      id,
    )
    .toArray()
    .map((row) => row.id);
}

/**
 * What `rootId` shows, as the view builds it, hashed: each layer's depth,
 * type and values in drawing order (see the module comment for what's left
 * out). Two lanes of 53 bits, fed a character at a time, so nothing the
 * size of the instance is held.
 */
export function lookHash(view: CopyView, rootId: string): string {
  const hash = new LookHash();
  const stack: Array<{ id: string; depth: number }> = [{ id: rootId, depth: 0 }];
  let layers = 0;
  for (let at = stack.pop(); at !== undefined; at = stack.pop()) {
    const node = view.get(at.id);
    if (!node) continue;
    layers++;
    hash.add(`\u0001${at.depth}\u0002${node.type}`);
    const props = node.props as Record<string, unknown>;
    for (const prop of Object.keys(props).sort()) {
      if (COPY_LINK_PROPS.has(prop) || (at.depth === 0 && ROOT_LOCAL_PROPS.has(prop))) continue;
      const value = props[prop];
      if (value === undefined || samePropValue(prop, undefined, value)) continue;
      hash.add(`\u0003${prop}\u0004`);
      hash.add(canonical(value));
    }
    const kids = view.childIds(at.id);
    for (let i = kids.length - 1; i >= 0; i--)
      stack.push({ id: kids[i] as string, depth: at.depth + 1 });
  }
  return `${layers}:${hash.digest()}`;
}

/** A value as JSON with its objects' keys sorted, so equal values read the same. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

/** Two independent 53-bit lanes (cyrb53's mixing), fed strings a character at a time. */
class LookHash {
  #a1 = 0xdeadbeef;
  #a2 = 0x41c6ce57;
  #b1 = 0x9e3779b9;
  #b2 = 0x85ebca6b;
  #length = 0;

  add(text: string): void {
    let a1 = this.#a1;
    let a2 = this.#a2;
    let b1 = this.#b1;
    let b2 = this.#b2;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      a1 = Math.imul(a1 ^ c, 2654435761);
      a2 = Math.imul(a2 ^ c, 1597334677);
      b1 = Math.imul(b1 ^ c, 2246822507);
      b2 = Math.imul(b2 ^ c, 3266489909);
    }
    this.#a1 = a1;
    this.#a2 = a2;
    this.#b1 = b1;
    this.#b2 = b2;
    this.#length += text.length;
  }

  digest(): string {
    const lane = (h1: number, h2: number) => {
      let x = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
      x ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
      let y = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
      y ^= Math.imul(x ^ (x >>> 13), 3266489909);
      return (4294967296 * (2097151 & y) + (x >>> 0)).toString(36);
    };
    return `${this.#length}.${lane(this.#a1, this.#a2)}.${lane(this.#b1, this.#b2)}`;
  }
}
