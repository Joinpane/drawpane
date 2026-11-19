/**
 * The document's nodes with variables and shared styles resolved where each
 * layer is (decision 0034), cached, and what a change affects found through
 * indexes rather than by looking at every node.
 *
 * - variable → the nodes and styles that bind it (in `bindings`, or in their
 *   paints, gradient stops and effects);
 * - variable → the variables that alias it;
 * - collection → its variables;
 * - style → the layers that link it.
 *
 * The indexes hold stored nodes. A copy layer built from a bound main layer
 * (compact copies, decision 0029) is reached through the copy view's own
 * index of what it built, so only copies that were built are dropped.
 *
 * Invalidation (decision 0034, section 4):
 * - a variable, a collection or a style changed: every presented layer that
 *   binds or links it, through aliases and styles, and every built copy of
 *   those;
 * - where modes apply changed (a frame, page or main set a mode, an override
 *   record that sets one was made, changed or removed, a layer moved): read
 *   from the stored operations and their inverses, so a change replayed from
 *   a room or rolled back reaches the same layers as the one made here. Each
 *   changed node stands for every built copy of it; under each, the layers
 *   bound to a variable of a changed collection, up to a frame that sets its
 *   own mode for it, are dropped. Whichever is smaller is walked: the built
 *   layers under it, or the bound layers of those collections (looking up
 *   their ancestors), so a mode set on a frame of unbound layers walks none.
 * - layout is queued only for layers whose layout reads what changed (a
 *   bound padding through the changed variable or collection), never for a
 *   colour or a style.
 *
 * What it keeps (its indexes, and resolved nodes it caches) is counted in the
 * document's meter when it has one (the room's headless editor): indexes as
 * they're built, refused past the limit like the rest of a build; a resolved
 * node is cached only while the meter has room for it.
 */
import {
  type BuildBudget,
  BuildTooLarge,
  heapBytes,
  layoutVariables,
  type NodeRecord,
  type Op,
  ROOT_ID,
  TokenResolver,
  tokenRefs,
  usesTokens,
} from "@drawpane/model";

type Kind = "variable" | "collection" | "style";

interface Entry {
  readonly variables: readonly string[];
  readonly styles: readonly string[];
  /** A variable's aliases (the variables its values name). */
  readonly aliases: readonly string[];
  readonly kind: Kind | null;
  /** A variable's collection. */
  readonly collection: string | null;
  /** What it was counted in the meter. */
  readonly cost: number;
}

export interface TokenSource {
  /** A node as presented (copies built), nothing resolved. */
  get(id: string): NodeRecord | undefined;
  /** A node's presented children that are built already (nothing is built to answer). */
  builtChildIds(id: string): readonly string[];
  /** A node as stored. */
  stored(id: string): NodeRecord | undefined;
  /** Every stored node. */
  storedNodes(): Iterable<NodeRecord>;
  /** Presented ids built from these (compact copies), the ids included. */
  builtFrom(ids: Iterable<string>): Set<string>;
  /** What the document counts what it keeps in, if anything. */
  meter(): BuildBudget | null;
}

/** Every collection: a move changes where each applies. */
const ALL = null;
type Collections = ReadonlySet<string> | typeof ALL;

/** A changed scope of modes: a presented node, and the collections whose mode may differ under it. */
interface ModeRoot {
  readonly id: string;
  readonly collections: Collections;
}

const EMPTY: readonly string[] = Object.freeze([]);

/** An index entry's own bytes (its object and its slot in the entries map). */
const ENTRY_BYTES = 160;
/** A reference indexed: its id in the entry's list, and in an index's set (a new set at worst). */
const REF_BYTES = 40;
/** A cached resolved node's fixed part: its cache entry, the node and its values' objects. */
const CACHED_BYTES = 160;

function add(map: Map<string, Set<string>>, key: string, value: string): void {
  const set = map.get(key);
  if (set) set.add(value);
  else map.set(key, new Set([value]));
}

function remove(map: Map<string, Set<string>>, key: string, value: string): void {
  const set = map.get(key);
  if (!set) return;
  set.delete(value);
  if (set.size === 0) map.delete(key);
}

function kindOf(node: NodeRecord): Kind | null {
  if (node.type === "variable") return "variable";
  if (node.type === "collection") return "collection";
  if (node.type === "paintStyle" || node.type === "effectStyle") return "style";
  return null;
}

/** The collections a `variableModes` value (or a node's props holding one) names. */
function modeKeys(value: unknown): string[] {
  return value && typeof value === "object" ? Object.keys(value) : [];
}

function unsetsModes(props: unknown): boolean {
  const unset = (props as { unset?: unknown } | undefined)?.unset;
  return Array.isArray(unset) && unset.includes("variableModes");
}

export class TokenView {
  readonly #source: TokenSource;
  readonly resolver: TokenResolver;
  readonly #cache = new Map<string, { raw: NodeRecord; resolved: NodeRecord; cost: number }>();
  readonly #entries = new Map<string, Entry>();
  readonly #byVariable = new Map<string, Set<string>>();
  readonly #byStyle = new Map<string, Set<string>>();
  readonly #aliasedBy = new Map<string, Set<string>>();
  readonly #variablesOf = new Map<string, Set<string>>();
  /** Stored nodes (not variables, collections or styles) that bind or link anything. */
  #bound = 0;
  /** Layers whose resolved values a layout reads, changed since `takeLayout`. */
  #layout = new Set<string>();
  /** The meter what's held is counted in (the document's when it was last rebuilt). */
  #meter: BuildBudget | null = null;
  #held = 0;

  constructor(source: TokenSource) {
    this.#source = source;
    this.resolver = new TokenResolver({ get: (id) => source.get(id) });
  }

  /** What it counts holding in the document's meter (0 without one). */
  get held(): number {
    return this.#held;
  }

  /** `raw` (the node as presented) with its variables and styles resolved. */
  present(id: string, raw: NodeRecord): NodeRecord {
    if (!usesTokens(raw.props)) return raw;
    const cached = this.#cache.get(id);
    if (cached && cached.raw === raw) return cached.resolved;
    if (cached) this.#forget(id);
    const resolved = this.resolver.resolve(raw);
    let cost = 0;
    if (this.#meter) {
      cost = CACHED_BYTES;
      if (resolved !== raw)
        for (const [prop, value] of Object.entries(resolved.props))
          if ((raw.props as Record<string, unknown>)[prop] !== value) cost += heapBytes(value);
      try {
        this.#meter.charge(cost);
      } catch (error) {
        // No room: it's resolved again when next read, and nothing more is held.
        if (error instanceof BuildTooLarge) return resolved;
        throw error;
      }
      this.#held += cost;
    }
    this.#cache.set(id, { raw, resolved, cost });
    return resolved;
  }

  #forget(id: string): void {
    const cached = this.#cache.get(id);
    if (!cached) return;
    this.#cache.delete(id);
    this.#giveBack(cached.cost);
  }

  #giveBack(bytes: number): void {
    if (bytes === 0) return;
    this.#meter?.release(bytes);
    this.#held -= bytes;
  }

  /** Forgets everything and indexes the stored nodes afresh (a document reset). */
  rebuild(): void {
    this.#meter?.release(this.#held);
    this.#held = 0;
    this.#meter = this.#source.meter();
    this.#cache.clear();
    this.#entries.clear();
    this.#byVariable.clear();
    this.#byStyle.clear();
    this.#aliasedBy.clear();
    this.#variablesOf.clear();
    this.#layout.clear();
    this.#bound = 0;
    // Counted as it's built: past the meter's limit the build is refused, as a store's is.
    for (const node of this.#source.storedNodes()) this.#add(node.id, node, true);
  }

  /** Layers whose resolved layout values may have changed since asked last; forgets them. */
  takeLayout(): Set<string> {
    const out = this.#layout;
    this.#layout = new Set();
    return out;
  }

  #add(id: string, node: NodeRecord, refuse = false): void {
    const kind = kindOf(node);
    // Most layers bind nothing: one look, nothing allocated.
    if (!kind && !usesTokens(node.props)) return;
    const refs = kind === "variable" || kind === "collection" ? null : tokenRefs(node.props);
    const aliases: string[] = [];
    if (kind === "variable") {
      const values = (node.props as { values?: Record<string, unknown> }).values ?? {};
      for (const value of Object.values(values))
        if (value && typeof value === "object") {
          const alias = (value as { alias?: unknown }).alias;
          if (typeof alias === "string") aliases.push(alias);
        }
    }
    const variables = refs && refs.variables.length > 0 ? refs.variables : EMPTY;
    const styles = refs && refs.styles.length > 0 ? refs.styles : EMPTY;
    if (!kind && variables.length === 0 && styles.length === 0) return;
    const refCount =
      variables.length + styles.length + aliases.length + (kind === "variable" ? 1 : 0);
    const cost = this.#meter ? ENTRY_BYTES + REF_BYTES * refCount : 0;
    if (this.#meter) {
      if (refuse) this.#meter.charge(cost);
      else this.#meter.hold(cost);
      this.#held += cost;
    }
    const entry: Entry = {
      variables,
      styles,
      aliases: aliases.length > 0 ? aliases : EMPTY,
      kind,
      collection: kind === "variable" ? node.parent : null,
      cost,
    };
    this.#entries.set(id, entry);
    if (!kind) this.#bound++;
    for (const v of entry.variables) add(this.#byVariable, v, id);
    for (const s of entry.styles) add(this.#byStyle, s, id);
    for (const a of entry.aliases) add(this.#aliasedBy, a, id);
    if (entry.collection) add(this.#variablesOf, entry.collection, id);
  }

  #drop(id: string): Entry | undefined {
    const entry = this.#entries.get(id);
    if (!entry) return undefined;
    this.#entries.delete(id);
    if (!entry.kind) this.#bound--;
    for (const v of entry.variables) remove(this.#byVariable, v, id);
    for (const s of entry.styles) remove(this.#byStyle, s, id);
    for (const a of entry.aliases) remove(this.#aliasedBy, a, id);
    if (entry.collection) remove(this.#variablesOf, entry.collection, id);
    this.#giveBack(entry.cost);
    return entry;
  }

  /**
   * After a change to the nodes `ids` (presented ids; stored ones among
   * them are indexed again), made by the stored operations `stored`, which
   * `inverse` undoes: the presented ids whose resolved values may have
   * changed beyond those, for the document's change notification.
   */
  changed(ids: ReadonlySet<string>, stored: readonly Op[], inverse: readonly Op[]): Set<string> {
    const variables = new Set<string>();
    const styles = new Set<string>();
    for (const id of ids) {
      this.#forget(id);
      const before = this.#drop(id);
      const node = this.#source.stored(id);
      if (node) this.#add(id, node);
      const after = this.#entries.get(id);
      for (const entry of [before, after]) {
        if (!entry?.kind) continue;
        if (entry.kind === "variable") variables.add(id);
        else if (entry.kind === "style") styles.add(id);
        else for (const v of this.#variablesOf.get(id) ?? []) variables.add(v);
      }
    }

    // Everything resolving through a changed variable, however it's aliased.
    this.#aliasClosure(variables);

    const bound = new Set<string>();
    for (const v of variables)
      for (const id of this.#byVariable.get(v) ?? []) {
        if (this.#entries.get(id)?.kind === "style") styles.add(id);
        else bound.add(id);
      }
    for (const s of styles) for (const id of this.#byStyle.get(s) ?? []) bound.add(id);

    const affected = bound.size > 0 ? this.#source.builtFrom(bound) : new Set<string>();
    for (const id of affected) {
      this.#forget(id);
      const raw = this.#source.get(id);
      if (raw && layoutVariables(raw.props).some((v) => variables.has(v))) this.#layout.add(id);
    }

    // Where modes apply changed.
    const roots = this.#modeRoots(stored, inverse);
    if (roots.length > 0) {
      const members = new MemberCache(this);
      for (const root of roots)
        for (const id of this.#underMode(root, members)) {
          affected.add(id);
          this.#forget(id);
          const raw = this.#source.get(id);
          if (raw && this.#layoutReads(raw, root.collections, members)) this.#layout.add(id);
        }
    }
    return affected;
  }

  /** Adds to `variables` every variable that aliases one of them, however far. */
  #aliasClosure(variables: Set<string>): void {
    const queue = [...variables];
    for (let v = queue.pop(); v !== undefined; v = queue.pop())
      for (const by of this.#aliasedBy.get(v) ?? [])
        if (!variables.has(by)) {
          variables.add(by);
          queue.push(by);
        }
  }

  /**
   * The presented nodes whose modes may apply differently after `stored`
   * (undone by `inverse`), with the collections that may differ: a set of
   * `variableModes`, an override record's create or delete that sets or
   * unsets one, a move. Each stands for its built copies too.
   */
  #modeRoots(stored: readonly Op[], inverse: readonly Op[]): ModeRoot[] {
    if (this.#bound === 0) return [];
    // What the changed nodes held before: from the inverse (a set's old value, a delete's create).
    const before = new Map<string, { modes: string[]; unset: boolean }>();
    for (const op of inverse) {
      if (op.op === "set" && op.prop === "variableModes")
        before.set(op.id, { modes: modeKeys(op.value), unset: false });
      else if (op.op === "set" && op.prop === "unset")
        before.set(op.id, {
          modes: before.get(op.id)?.modes ?? [],
          unset: Array.isArray(op.value) && op.value.includes("variableModes"),
        });
      else if (op.op === "create")
        before.set(op.id, {
          modes: modeKeys((op.props as { variableModes?: unknown }).variableModes),
          unset: unsetsModes(op.props),
        });
    }
    const changed = new Map<string, Set<string> | typeof ALL>();
    const mark = (id: string, collections: Iterable<string> | typeof ALL) => {
      const prior = changed.get(id);
      if (prior === ALL && changed.has(id)) return;
      if (collections === ALL) {
        changed.set(id, ALL);
        return;
      }
      const set = prior ?? new Set<string>();
      for (const c of collections) set.add(c);
      changed.set(id, set);
    };
    for (const op of stored) {
      const old = before.get(op.id);
      if (op.op === "move") mark(op.id, ALL);
      else if (op.op === "set" && op.prop === "variableModes")
        mark(op.id, [...modeKeys(op.value), ...(old?.modes ?? [])]);
      else if (op.op === "set" && op.prop === "unset") {
        const now = Array.isArray(op.value) && op.value.includes("variableModes");
        if (now || old?.unset) mark(op.id, ALL);
      } else if (op.op === "create") {
        // A record made for a copy layer that's already presented: its modes change there.
        if (unsetsModes(op.props)) mark(op.id, ALL);
        else {
          const modes = modeKeys((op.props as { variableModes?: unknown }).variableModes);
          if (modes.length > 0) mark(op.id, modes);
        }
      } else if (op.op === "delete" && old) {
        // A record let go of: the copy layer shows its main's modes again.
        if (old.unset) mark(op.id, ALL);
        else if (old.modes.length > 0) mark(op.id, old.modes);
      }
    }
    const roots: ModeRoot[] = [];
    for (const [id, collections] of changed) {
      if (collections && collections.size === 0) continue;
      for (const copy of this.#source.builtFrom([id]))
        if (this.#source.get(copy)) roots.push({ id: copy, collections });
    }
    return roots;
  }

  /** Whether a node's layout reads a variable whose value depends on `collections`. */
  #layoutReads(raw: NodeRecord, collections: Collections, members: MemberCache): boolean {
    const vars = layoutVariables(raw.props);
    if (vars.length === 0) return false;
    if (collections === ALL) return true;
    const relevant = members.variables(collections);
    return vars.some((v) => relevant.has(v));
  }

  /**
   * The bound presented nodes under `root` (itself included) whose values
   * depend on its changed collections, up to frames that set their own
   * modes for all of them.
   */
  #underMode(root: ModeRoot, members: MemberCache): Set<string> {
    const out = new Set<string>();
    const estimate = members.estimate(root.collections);
    if (estimate === 0) return out;
    // The built layers under it, while they're fewer than the bound ones; else the bound ones.
    if (this.#walkSubtree(root, members, estimate, out)) return out;
    out.clear();
    for (const id of members.presented(root.collections))
      if (this.#isUnder(id, root, members)) out.add(id);
    return out;
  }

  /** Walks the built layers under `root`, at most `budget` of them; false when it ran out. */
  #walkSubtree(root: ModeRoot, members: MemberCache, budget: number, out: Set<string>): boolean {
    let visited = 0;
    const stack = [root.id];
    for (let id = stack.pop(); id !== undefined; id = stack.pop()) {
      if (++visited > budget) return false;
      const node = this.#source.get(id);
      if (!node) continue;
      if (id !== root.id && members.shields(node, root.collections)) continue;
      if (members.depends(node, root.collections)) out.add(id);
      for (const child of this.#source.builtChildIds(id)) stack.push(child);
    }
    return true;
  }

  /** Whether `id` is `root` or under it, with no frame between setting its own modes for them all. */
  #isUnder(id: string, root: ModeRoot, members: MemberCache): boolean {
    let node = this.#source.get(id);
    for (let depth = 0; node && depth < 4096; depth++) {
      if (node.id === root.id) return true;
      if (members.shields(node, root.collections)) return false;
      if (node.parent === ROOT_ID) return false;
      node = this.#source.get(node.parent);
    }
    return false;
  }

  // What `MemberCache` reads.

  /** @internal */ entry(id: string): Entry | undefined {
    return this.#entries.get(id);
  }
  /** @internal */ boundCount(): number {
    return this.#bound;
  }
  /** @internal */ variablesOf(collection: string): ReadonlySet<string> | undefined {
    return this.#variablesOf.get(collection);
  }
  /** @internal */ closeAliases(variables: Set<string>): void {
    this.#aliasClosure(variables);
  }
  /** @internal */ boundTo(variable: string): ReadonlySet<string> | undefined {
    return this.#byVariable.get(variable);
  }
  /** @internal */ linking(style: string): ReadonlySet<string> | undefined {
    return this.#byStyle.get(style);
  }
  /** @internal */ boundIds(): Iterable<string> {
    const entries = this.#entries;
    return (function* () {
      for (const [id, entry] of entries) if (!entry.kind) yield id;
    })();
  }
  /** @internal */ source(): TokenSource {
    return this.#source;
  }
}

/** What one change's mode invalidation looks up, worked out once per set of collections. */
class MemberCache {
  readonly #view: TokenView;
  readonly #variables = new Map<string, Set<string>>();
  readonly #stored = new Map<string, Set<string>>();
  readonly #presented = new Map<string, Set<string>>();
  readonly #modes = new Map<string, readonly string[]>();

  constructor(view: TokenView) {
    this.#view = view;
  }

  static key(collections: Collections): string {
    return collections === ALL ? "\u0000all" : [...collections].sort().join("\u0000");
  }

  /** Variables whose values depend on these collections' modes (theirs, and what aliases them). */
  variables(collections: Collections): ReadonlySet<string> {
    const key = MemberCache.key(collections);
    let out = this.#variables.get(key);
    if (!out) {
      out = new Set<string>();
      if (collections !== ALL)
        for (const c of collections) for (const v of this.#view.variablesOf(c) ?? []) out.add(v);
      this.#view.closeAliases(out);
      this.#variables.set(key, out);
    }
    return out;
  }

  /** Stored nodes bound to those variables, or linking styles that are. */
  stored(collections: Collections): ReadonlySet<string> {
    const key = MemberCache.key(collections);
    let out = this.#stored.get(key);
    if (!out) {
      out = new Set<string>();
      if (collections === ALL) for (const id of this.#view.boundIds()) out.add(id);
      else
        for (const v of this.variables(collections))
          for (const id of this.#view.boundTo(v) ?? []) {
            if (this.#view.entry(id)?.kind === "style")
              for (const layer of this.#view.linking(id) ?? []) out.add(layer);
            else out.add(id);
          }
      this.#stored.set(key, out);
    }
    return out;
  }

  /** How many stored nodes depend on them: what walking the bound ones costs at the least. */
  estimate(collections: Collections): number {
    return collections === ALL ? this.#view.boundCount() : this.stored(collections).size;
  }

  /** The presented nodes depending on them: built copies of the stored ones too. */
  presented(collections: Collections): ReadonlySet<string> {
    const key = MemberCache.key(collections);
    let out = this.#presented.get(key);
    if (!out) {
      out = this.#view.source().builtFrom(this.stored(collections));
      this.#presented.set(key, out);
    }
    return out;
  }

  /** Whether a presented node's own values depend on them. */
  depends(node: NodeRecord, collections: Collections): boolean {
    if (!usesTokens(node.props)) return false;
    if (collections === ALL) return true;
    const relevant = this.variables(collections);
    const refs = tokenRefs(node.props);
    if (refs.variables.some((v) => relevant.has(v))) return true;
    for (const s of refs.styles)
      if ((this.#view.entry(s)?.variables ?? EMPTY).some((v) => relevant.has(v))) return true;
    return false;
  }

  /** Whether a node sets its own mode for every one of them (what's under it keeps its modes). */
  shields(node: NodeRecord, collections: Collections): boolean {
    if (collections === ALL) return false;
    const set = (node.props as { variableModes?: Record<string, string> }).variableModes;
    if (!set) return false;
    for (const c of collections) {
      const mode = set[c];
      if (!mode || !this.#modesOf(c).includes(mode)) return false;
    }
    return true;
  }

  #modesOf(collection: string): readonly string[] {
    let modes = this.#modes.get(collection);
    if (!modes) {
      const node = this.#view.source().get(collection);
      const list = (node?.props as { modes?: Array<{ id: string }> } | undefined)?.modes;
      modes = list ? list.map((m) => m.id) : EMPTY;
      this.#modes.set(collection, modes);
    }
    return modes;
  }
}
