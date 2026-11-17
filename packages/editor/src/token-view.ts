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
 */
import {
  bindsLayout,
  type NodeRecord,
  type Op,
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
}

export interface TokenSource {
  /** A node as presented (copies built), nothing resolved. */
  get(id: string): NodeRecord | undefined;
  childIds(id: string): readonly string[];
  /** A node as stored. */
  stored(id: string): NodeRecord | undefined;
  /** Every stored node. */
  storedNodes(): Iterable<NodeRecord>;
  /** Presented ids built from these (compact copies), the ids included. */
  builtFrom(ids: Iterable<string>): Set<string>;
}

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

export class TokenView {
  readonly #source: TokenSource;
  readonly resolver: TokenResolver;
  readonly #cache = new Map<string, { raw: NodeRecord; resolved: NodeRecord }>();
  readonly #entries = new Map<string, Entry>();
  readonly #byVariable = new Map<string, Set<string>>();
  readonly #byStyle = new Map<string, Set<string>>();
  readonly #aliasedBy = new Map<string, Set<string>>();
  readonly #variablesOf = new Map<string, Set<string>>();
  /** Layers whose resolved values a layout reads, changed since `takeLayout`. */
  #layout = new Set<string>();

  constructor(source: TokenSource) {
    this.#source = source;
    this.resolver = new TokenResolver({ get: (id) => source.get(id) });
  }

  /** `raw` (the node as presented) with its variables and styles resolved. */
  present(id: string, raw: NodeRecord): NodeRecord {
    if (!usesTokens(raw.props)) return raw;
    const cached = this.#cache.get(id);
    if (cached && cached.raw === raw) return cached.resolved;
    const resolved = this.resolver.resolve(raw);
    this.#cache.set(id, { raw, resolved });
    return resolved;
  }

  /** Forgets everything and indexes the stored nodes afresh (a document reset). */
  rebuild(): void {
    this.#cache.clear();
    this.#entries.clear();
    this.#byVariable.clear();
    this.#byStyle.clear();
    this.#aliasedBy.clear();
    this.#variablesOf.clear();
    this.#layout.clear();
    for (const node of this.#source.storedNodes()) this.#add(node.id, node);
  }

  /** Layers whose resolved layout values may have changed since asked last; forgets them. */
  takeLayout(): Set<string> {
    const out = this.#layout;
    this.#layout = new Set();
    return out;
  }

  #add(id: string, node: NodeRecord): void {
    const kind = kindOf(node);
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
    const entry: Entry = {
      variables: refs?.variables ?? [],
      styles: refs?.styles ?? [],
      aliases,
      kind,
      collection: kind === "variable" ? node.parent : null,
    };
    if (!kind && entry.variables.length === 0 && entry.styles.length === 0) return;
    this.#entries.set(id, entry);
    for (const v of entry.variables) add(this.#byVariable, v, id);
    for (const s of entry.styles) add(this.#byStyle, s, id);
    for (const a of entry.aliases) add(this.#aliasedBy, a, id);
    if (entry.collection) add(this.#variablesOf, entry.collection, id);
  }

  #drop(id: string): Entry | undefined {
    const entry = this.#entries.get(id);
    if (!entry) return undefined;
    this.#entries.delete(id);
    for (const v of entry.variables) remove(this.#byVariable, v, id);
    for (const s of entry.styles) remove(this.#byStyle, s, id);
    for (const a of entry.aliases) remove(this.#aliasedBy, a, id);
    if (entry.collection) remove(this.#variablesOf, entry.collection, id);
    return entry;
  }

  /**
   * After `ops` changed the nodes `ids` (presented ids; stored ones among
   * them are indexed again): the presented ids whose resolved values may
   * have changed beyond those, for the document's change notification.
   */
  changed(ids: ReadonlySet<string>, ops: readonly Op[]): Set<string> {
    const variables = new Set<string>();
    const styles = new Set<string>();
    for (const id of ids) {
      this.#cache.delete(id);
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
    const queue = [...variables];
    for (let v = queue.pop(); v !== undefined; v = queue.pop())
      for (const by of this.#aliasedBy.get(v) ?? [])
        if (!variables.has(by)) {
          variables.add(by);
          queue.push(by);
        }

    const bound = new Set<string>();
    for (const v of variables)
      for (const id of this.#byVariable.get(v) ?? []) {
        if (this.#entries.get(id)?.kind === "style") styles.add(id);
        else bound.add(id);
      }
    for (const s of styles) for (const id of this.#byStyle.get(s) ?? []) bound.add(id);

    const affected = bound.size > 0 ? this.#source.builtFrom(bound) : new Set<string>();

    // Where modes apply changed: a frame set a mode, or a layer moved under other frames.
    for (const op of ops) {
      if (!((op.op === "set" && op.prop === "variableModes") || op.op === "move")) continue;
      const stack = [op.id];
      for (let id = stack.pop(); id !== undefined; id = stack.pop()) {
        const node = this.#source.get(id);
        if (!node) continue;
        if (usesTokens(node.props)) affected.add(id);
        for (const child of this.#source.childIds(id)) stack.push(child);
      }
    }

    for (const id of affected) {
      this.#cache.delete(id);
      const node = this.#source.get(id);
      if (node && bindsLayout(node.props)) this.#layout.add(id);
    }
    return affected;
  }
}
