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

/**
 * The most removed mains with instances left that a storage transaction
 * that has to run again (`RemovalNeedsLooks`) carries over, in memory, to
 * look at first: past it, the removal is refused as too large to check.
 * Mains whose instances all went with them don't count.
 */
export const REMOVAL_CHECK_MAINS = 10_000;

/** The most delete targets carried over to the run again, so instances there aren't built. */
export const REMOVAL_DELETED_KEPT = 50_000;

/**
 * What the check keeps, in tables of its own, for the storage transaction
 * it's run in: everything that grows with the file (the mains noted, the
 * instances affected, what each showed), so nothing it holds in memory
 * grows with how many instances a main has (decision 0029).
 */
export const REMOVAL_SCHEMA = `
  CREATE TABLE IF NOT EXISTS removal_noted (
    id TEXT PRIMARY KEY, removed INTEGER NOT NULL DEFAULT 0, used INTEGER NOT NULL DEFAULT 0
  ) STRICT, WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS removal_looked (id TEXT PRIMARY KEY, name TEXT) STRICT, WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS removal_reach (
    main TEXT NOT NULL, origin TEXT NOT NULL, round INTEGER NOT NULL, PRIMARY KEY (main, origin)
  ) STRICT, WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS removal_reach_round ON removal_reach (round);
  CREATE TABLE IF NOT EXISTS removal_affected (
    root TEXT NOT NULL, origin TEXT NOT NULL, PRIMARY KEY (root, origin)
  ) STRICT, WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS removal_look (
    root TEXT PRIMARY KEY, look TEXT, name TEXT, skipped INTEGER NOT NULL DEFAULT 0
  ) STRICT, WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS removal_deleted (id TEXT PRIMARY KEY) STRICT, WITHOUT ROWID;
`;

const REMOVAL_TABLES = [
  "removal_noted",
  "removal_looked",
  "removal_reach",
  "removal_affected",
  "removal_look",
  "removal_deleted",
] as const;

/** Rows a page of the check reads at a time. */
const PAGE = 200;

/** `prefix` and a layer's name in quotes, or `fallback` when it has none. */
const named = (name: unknown, prefix: string, fallback: string) =>
  typeof name === "string" && name.trim() ? `${prefix} “${name.trim()}”` : fallback;

/** The stored instance roots of the mains a query selects (`?` its parameters), or with a copy swapped to one. */
const instancesOfSql = (mains: string) => `
  SELECT n.id AS id, json_extract(n.props, '$.instanceOf') AS of FROM nodes n
   WHERE n.type = 'frame' AND json_extract(n.props, '$.instanceOf') IN (${mains})
     AND n.id != json_extract(n.props, '$.instanceOf')
  UNION
  SELECT n.parent AS id, json_extract(n.props, '$.instanceOf') AS of FROM nodes n
   WHERE n.type = 'override' AND json_extract(n.props, '$.instanceOf') IN (${mains})`;

const IS_MAIN_SQL = (n: string) =>
  `${n}.type = 'frame' AND json_extract(${n}.props, '$.isComponent') = 1`;

/** One storage transaction's check (see the module comment). */
export class MainRemoval {
  readonly #sql: SqlStorage;
  readonly #store: RemovalStore;
  /** The targets of the deletes noted (null once there are too many to keep). */
  #deleted: Set<string> | null = new Set();
  #built = 0;
  readonly #budget: BuildBudget;
  readonly #precount: boolean;

  /** Call inside the storage transaction, before anything applies: what an earlier one kept goes. */
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
    sql.exec(REMOVAL_SCHEMA);
    for (const table of REMOVAL_TABLES) sql.exec(`DELETE FROM ${table}`);
  }

  /** What the check has held at most, as its budget estimates it (for the memory check). */
  get peakHeld(): number {
    return this.#budget.peak;
  }

  /**
   * Before any operation applies: looks at what the instances of `mains`
   * show, and of the mains `ops` certainly remove (deleted, inside
   * something deleted, or un-made), but those at or under `deleted` or what
   * `ops` delete (they won't be there to compare; `check` makes sure). The
   * mains `ops` remove are found in SQL, however many a deleted page holds.
   */
  lookFirst(
    mains: Iterable<string>,
    deleted: ReadonlySet<string> = new Set(),
    ops: readonly Op[] = [],
  ): void {
    const sql = this.#sql;
    const round =
      sql.exec<{ n: number | null }>("SELECT MAX(round) AS n FROM removal_reach").one().n ?? -1;
    const base = round + 1;
    const start = (id: string) => {
      sql.exec(
        `INSERT OR IGNORE INTO removal_looked (id, name)
         SELECT id, json_extract(props, '$.name') FROM nodes WHERE id = ?`,
        id,
      );
      sql.exec(
        "INSERT OR IGNORE INTO removal_reach (main, origin, round) VALUES (?, ?, ?)",
        id,
        id,
        base,
      );
    };
    for (const id of mains) if (!this.#wasLooked(id)) start(id);
    for (const id of deleted) sql.exec("INSERT OR IGNORE INTO removal_deleted (id) VALUES (?)", id);
    for (const op of ops) {
      if (op.op === "delete") {
        sql.exec("INSERT OR IGNORE INTO removal_deleted (id) VALUES (?)", op.id);
        sql.exec(
          `WITH RECURSIVE sub(id) AS (SELECT ? UNION ALL SELECT n.id FROM nodes n JOIN sub ON n.parent = sub.id),
           found AS (SELECT n.id, json_extract(n.props, '$.name') AS name FROM sub CROSS JOIN nodes n ON n.id = sub.id
                      WHERE ${IS_MAIN_SQL("n")} AND n.id NOT IN (SELECT id FROM removal_looked))
           INSERT OR IGNORE INTO removal_reach (main, origin, round) SELECT id, id, ? FROM found`,
          op.id,
          base,
        );
      } else if (
        op.op === "set" &&
        op.prop === "isComponent" &&
        !op.value &&
        !this.#wasLooked(op.id)
      ) {
        if (
          sql.exec(`SELECT 1 FROM nodes n WHERE n.id = ? AND ${IS_MAIN_SQL("n")}`, op.id).toArray()
            .length > 0
        )
          start(op.id);
      }
    }
    // Mains found in SQL are named, as looked at.
    sql.exec(
      `INSERT OR IGNORE INTO removal_looked (id, name)
       SELECT r.main, json_extract(n.props, '$.name') FROM removal_reach r JOIN nodes n ON n.id = r.main
        WHERE r.round = ? AND r.main = r.origin`,
      base,
    );
    // The instances affected, round by round, in SQL: those of the mains looked at, then, through
    // every main holding one of them (or being one), that main's instances keeping records.
    for (let r = base; ; r++) {
      const ofRound = "SELECT main FROM removal_reach WHERE round = ?1";
      sql.exec(
        `INSERT OR IGNORE INTO removal_affected (root, origin)
         SELECT i.id, f.origin FROM (${instancesOfSql(ofRound)}) i
           JOIN removal_reach f ON f.main = i.of AND f.round = ?1
          WHERE ?1 = ?2 OR EXISTS (SELECT 1 FROM nodes o WHERE o.parent = i.id AND o.type = 'override')`,
        r,
        base,
      );
      const held = sql.exec(
        `WITH RECURSIVE inst(id, origin) AS (
           SELECT i.id, f.origin FROM (${instancesOfSql(ofRound)}) i
             JOIN removal_reach f ON f.main = i.of AND f.round = ?1),
         up(id, origin) AS (
           SELECT id, origin FROM inst
           UNION SELECT n.parent, up.origin FROM up JOIN nodes n ON n.id = up.id WHERE n.parent != ?2)
         INSERT OR IGNORE INTO removal_reach (main, origin, round)
         SELECT up.id, up.origin, ?1 + 1 FROM up JOIN nodes m ON m.id = up.id WHERE ${IS_MAIN_SQL("m")}`,
        r,
        ROOT_ID,
      );
      if (held.rowsWritten === 0) break;
    }
    // Instances at or under what's deleted aren't built: marked skipped.
    if (sql.exec("SELECT 1 FROM removal_deleted LIMIT 1").toArray().length > 0)
      sql.exec(
        `WITH RECURSIVE up(root, id) AS (
           SELECT DISTINCT root, root FROM removal_affected
            WHERE root NOT IN (SELECT root FROM removal_look)
           UNION SELECT up.root, n.parent FROM up JOIN nodes n ON n.id = up.id WHERE n.parent != ?)
         INSERT OR IGNORE INTO removal_look (root, skipped)
         SELECT DISTINCT root, 1 FROM up WHERE id IN (SELECT id FROM removal_deleted)`,
        ROOT_ID,
      );
    // Counted before anything is built: every instance is a layer at least.
    const toLook = sql
      .exec<{ n: number }>(
        `SELECT COUNT(DISTINCT root) AS n FROM removal_affected
          WHERE root NOT IN (SELECT root FROM removal_look)`,
      )
      .one().n;
    if (this.#built + toLook > REMOVAL_CHECK_LAYERS) {
      const first = sql
        .exec<{ name: string | null }>(
          "SELECT l.name FROM removal_reach r JOIN removal_looked l ON l.id = r.main WHERE r.round = ? LIMIT 1",
          base,
        )
        .toArray()[0];
      throw tooMany(named(first?.name, "the component", "a component"));
    }
    const counter = new PresentedCounter(sql, "nodes");
    const view = this.#view();
    this.#store.meter?.(this.#budget);
    try {
      let after = "";
      for (;;) {
        const page = sql
          .exec<{ root: string; origin: string }>(
            `SELECT a.root AS root, MIN(a.origin) AS origin FROM removal_affected a
              WHERE a.root > ? AND NOT EXISTS (SELECT 1 FROM removal_look l WHERE l.root = a.root)
              GROUP BY a.root ORDER BY a.root LIMIT ${PAGE}`,
            after,
          )
          .toArray();
        for (const { root, origin } of page) {
          // As people see it: an instance takes its name from its main unless it has its own.
          const name = named(view.get(root)?.props.name, "its instance", "one of its instances");
          const look = this.#lookOf(view, counter, root, this.#mainName(origin), name);
          sql.exec(
            "INSERT OR REPLACE INTO removal_look (root, look, name, skipped) VALUES (?, ?, ?, 0)",
            root,
            look,
            name,
          );
        }
        if (page.length < PAGE) break;
        after = (page[page.length - 1] as { root: string }).root;
      }
    } finally {
      view.clear();
      this.#store.meter?.(null);
      this.#store.clearCache();
    }
  }

  /** Before each run of operations applies: the mains they may remove, kept in SQL. */
  note(ops: readonly Op[]): void {
    const sql = this.#sql;
    for (const op of ops) {
      if (op.op === "delete") {
        this.#deleted?.add(op.id);
        if ((this.#deleted?.size ?? 0) > REMOVAL_DELETED_KEPT) this.#deleted = null;
      }
      if (op.op === "delete" || op.op === "move") {
        sql.exec(
          `WITH RECURSIVE sub(id) AS (SELECT ? UNION ALL SELECT n.id FROM nodes n JOIN sub ON n.parent = sub.id)
           INSERT OR IGNORE INTO removal_noted (id)
           SELECT n.id FROM sub CROSS JOIN nodes n ON n.id = sub.id WHERE ${IS_MAIN_SQL("n")}`,
          op.id,
        );
      } else if (op.op === "set")
        sql.exec(
          `INSERT OR IGNORE INTO removal_noted (id) SELECT n.id FROM nodes n WHERE n.id = ? AND ${IS_MAIN_SQL("n")}`,
          op.id,
        );
    }
  }

  /**
   * After every operation applied, before the storage transaction ends:
   * throws `RemovalNeedsLooks` when it removed a main not looked at first,
   * and a `ModelError` when an instance of a removed main shows something
   * else now (or is too large to check).
   */
  check(): void {
    const sql = this.#sql;
    this.#store.clearCache();
    try {
      // Removed: noted, and not a main now. A page at a time.
      let removed = 0;
      for (let after = ""; ; ) {
        const page = sql
          .exec<{ id: string }>(
            `SELECT id FROM removal_noted WHERE id > ? ORDER BY id LIMIT ${PAGE}`,
            after,
          )
          .toArray();
        for (const { id } of page)
          if (!this.#isMain(id)) {
            sql.exec("UPDATE removal_noted SET removed = 1 WHERE id = ?", id);
            removed++;
          }
        this.#store.clearCache();
        if (page.length < PAGE) break;
        after = (page[page.length - 1] as { id: string }).id;
      }
      if (removed === 0) return;
      // Those with an instance (or a copy swapped to them) left: one pass over the file.
      sql.exec(
        `UPDATE removal_noted SET used = 1 WHERE removed = 1 AND id IN (
           SELECT of FROM (${instancesOfSql("SELECT id FROM removal_noted WHERE removed = 1")}))`,
      );
      const unlooked = sql
        .exec(
          `SELECT 1 FROM removal_noted n WHERE n.used = 1
              AND NOT EXISTS (SELECT 1 FROM removal_looked l WHERE l.id = n.id) LIMIT 1`,
        )
        .toArray().length;
      // Not looked at first, or skipped as deleted and there after all: looked at, again.
      if (unlooked > 0) throw new RemovalNeedsLooks(this.#carried(), this.#deleted);
      if (
        sql
          .exec(
            "SELECT 1 FROM removal_look l JOIN nodes n ON n.id = l.root WHERE l.skipped = 1 LIMIT 1",
          )
          .toArray().length > 0
      )
        throw new RemovalNeedsLooks(this.#carried(), null);
      const counter = new PresentedCounter(sql, "nodes");
      const view = this.#view();
      this.#store.meter?.(this.#budget);
      try {
        for (let after = ""; ; ) {
          const page = sql
            .exec<{ root: string; look: string; name: string | null; main: string | null }>(
              `SELECT l.root AS root, l.look AS look, l.name AS name,
                      (SELECT a.origin FROM removal_affected a JOIN removal_noted n ON n.id = a.origin
                        WHERE a.root = l.root AND n.removed = 1 ORDER BY a.origin LIMIT 1) AS main
                 FROM removal_look l
                WHERE l.skipped = 0 AND l.root > ? ORDER BY l.root LIMIT ${PAGE}`,
              after,
            )
            .toArray();
          for (const { root, look, name, main } of page) {
            if (main === null || !this.#store.get(root)) continue;
            const instance = name ?? "one of its instances";
            if (this.#lookOf(view, counter, root, this.#mainName(main), instance) !== look)
              throw new ModelError(
                "conflict",
                `Removing ${this.#mainName(main)} would change how ${instance} looks, so nothing was changed. If someone just changed that instance or the component, try again; otherwise detach the instance first.`,
              );
          }
          if (page.length < PAGE) break;
          after = (page[page.length - 1] as { root: string }).root;
        }
      } finally {
        view.clear();
        this.#store.meter?.(null);
      }
    } finally {
      this.#store.clearCache();
    }
  }

  /**
   * The removed mains with instances left, to look at first when the
   * transaction runs again; refused when they're too many to carry.
   */
  #carried(): Set<string> {
    const sql = this.#sql;
    const count = sql
      .exec<{ n: number }>("SELECT COUNT(*) AS n FROM removal_noted WHERE used = 1")
      .one().n;
    if (count > REMOVAL_CHECK_MAINS)
      throw new ModelError(
        "conflict",
        `That removes ${count.toLocaleString("en")} components whose instances are still in the file, more than Drawpane can check at once (${REMOVAL_CHECK_MAINS.toLocaleString("en")}), so nothing was changed. Remove fewer at a time, or detach their instances first.`,
      );
    return new Set(
      sql
        .exec<{ id: string }>("SELECT id FROM removal_noted WHERE used = 1")
        .toArray()
        .map((row) => row.id),
    );
  }

  #wasLooked(id: string): boolean {
    return this.#sql.exec("SELECT 1 FROM removal_looked WHERE id = ?", id).toArray().length > 0;
  }

  /** What a main looked at was called, from before. */
  #mainName(id: string): string {
    const row = this.#sql
      .exec<{ name: string | null }>("SELECT name FROM removal_looked WHERE id = ?", id)
      .toArray()[0];
    return named(row?.name, "the component", "a component");
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

  /** What `root` shows, hashed; measured first, and refused when too large to build. */
  #lookOf(
    view: CopyView,
    counter: PresentedCounter,
    root: string,
    main: string,
    instance: string,
  ): string {
    const size = this.#precount
      ? counter.sizeOf(root)
      : { layers: 0, built: 0, reached: 0, bytes: 0 };
    const limits = INSTANCE_LIMITS;
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
    this.#built += size.built + 1;
    if (this.#built > REMOVAL_CHECK_LAYERS) throw tooMany(main);
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
        if (error.unit === "layers") throw tooMany(main);
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

/** Refusing a removal whose instances show too many layers in all to check. */
const tooMany = (main: string) =>
  new ModelError(
    "conflict",
    `Removing ${main} needs Drawpane to check that its instances keep their look, and they show more than ${REMOVAL_CHECK_LAYERS.toLocaleString("en")} layers, too many to check at once, so nothing was changed. Detach some of its instances first.`,
  );

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
