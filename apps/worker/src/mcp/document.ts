/**
 * A file's document as the MCP tools read it (docs/decisions/0011-mcp-server.md):
 * the nodes from its FileRoom, indexed, and the views agents ask for: an
 * outline, one node, a search, its components, its tokens. Bounded, so a
 * big file can't flood a model's context.
 */
import { type DocReader, getProp, type NodeRecord, ROOT_ID } from "@drawpane/model";

/** What the views below read a document through. */
export interface DocView {
  get(id: string): NodeRecord | undefined;
  children(id: string): readonly NodeRecord[];
  pages(): NodeRecord[];
  /** The page a node is on, when it's on one (library copies and tokens aren't). */
  pageOf(id: string): NodeRecord | undefined;
  /** Every node on a page, parents first. */
  onPages(): Generator<NodeRecord>;
}

/** A document held in memory: for tests, and files small enough to read whole. */
export class FileDoc implements DocView {
  readonly #nodes = new Map<string, NodeRecord>();
  readonly #children = new Map<string, NodeRecord[]>();

  constructor(nodes: readonly NodeRecord[]) {
    for (const node of nodes) {
      this.#nodes.set(node.id, node);
      const siblings = this.#children.get(node.parent);
      if (siblings) siblings.push(node);
      else this.#children.set(node.parent, [node]);
    }
    for (const list of this.#children.values())
      list.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.id < b.id ? -1 : 1));
  }

  get(id: string): NodeRecord | undefined {
    return this.#nodes.get(id);
  }

  children(id: string): readonly NodeRecord[] {
    return this.#children.get(id) ?? [];
  }

  pages(): NodeRecord[] {
    return this.children(ROOT_ID).filter((n) => n.type === "page");
  }

  /** The page a node is on, when it's on one (library copies and tokens aren't). */
  pageOf(id: string): NodeRecord | undefined {
    for (let node = this.get(id); node; node = this.get(node.parent))
      if (node.type === "page") return node;
    return undefined;
  }

  /** Every node on a page, parents first. */
  *onPages(): Generator<NodeRecord> {
    const stack = [...this.pages()].reverse();
    while (stack.length > 0) {
      const node = stack.pop() as NodeRecord;
      yield node;
      stack.push(...[...this.children(node.id)].reverse());
    }
  }
}

/**
 * A document read from SQLite as the views ask (the FileRoom's, through a
 * `TableReader`), so a large file is never read whole: an outline reads the
 * layers it lists, a search walks the pages a node's children at a time.
 */
export class SqlFileDoc implements DocView {
  readonly #reader: DocReader;

  constructor(reader: DocReader) {
    this.#reader = reader;
  }

  get(id: string): NodeRecord | undefined {
    return this.#reader.get(id);
  }

  children(id: string): readonly NodeRecord[] {
    const out: NodeRecord[] = [];
    for (const child of this.#reader.childIds(id)) {
      const node = this.#reader.get(child);
      if (node) out.push(node);
    }
    return out;
  }

  pages(): NodeRecord[] {
    return this.children(ROOT_ID).filter((n) => n.type === "page");
  }

  pageOf(id: string): NodeRecord | undefined {
    for (let node = this.get(id); node; node = this.get(node.parent))
      if (node.type === "page") return node;
    return undefined;
  }

  *onPages(): Generator<NodeRecord> {
    const stack = [...this.pages()].reverse();
    while (stack.length > 0) {
      const node = stack.pop() as NodeRecord;
      yield node;
      stack.push(...[...this.children(node.id)].reverse());
    }
  }
}

/** A read the MCP tools ask a file's room for. */
export type DocumentRequest =
  | {
      readonly kind: "outline";
      readonly pageId?: string;
      readonly rootId?: string;
      readonly depth: number;
      readonly limit: number;
    }
  | { readonly kind: "node"; readonly nodeId: string }
  | {
      readonly kind: "find";
      readonly query: string;
      readonly nodeKind?: string;
      readonly limit: number;
    }
  | { readonly kind: "components" }
  | { readonly kind: "tokens" };

/** The answer to a read, or `{ error }` worded for the model. */
export function answerDocument(doc: DocView, request: DocumentRequest): unknown {
  switch (request.kind) {
    case "outline": {
      const pages = doc.pages();
      const page = request.pageId ? doc.get(request.pageId) : pages[0];
      if (request.pageId && page?.type !== "page")
        return { error: `No page ${request.pageId} in this file.` };
      if (request.rootId && !doc.get(request.rootId))
        return { error: `No layer ${request.rootId} in this file.` };
      const start = request.rootId ?? page?.id;
      return {
        pages: pages.map((p) => ({ id: p.id, name: p.props.name ?? "Page" })),
        outline: start ? outline(doc, start, request.depth, request.limit) : null,
      };
    }
    case "node":
      return (
        nodeDetail(doc, request.nodeId) ?? { error: `No layer ${request.nodeId} in this file.` }
      );
    case "find":
      return findNodes(doc, request.query, request.nodeKind, request.limit);
    case "components":
      return { components: components(doc) };
    case "tokens":
      return tokens(doc);
  }
}

/** A node's name as people see it: its own, or its kind. */
export function displayName(node: NodeRecord): string {
  const name = getProp(node.props, "name");
  if (name) return name;
  if (node.type === "text") return getProp(node.props, "characters").slice(0, 40) || "Text";
  return node.type[0]?.toUpperCase() + node.type.slice(1);
}

/** What kind of layer it is, components and instances told apart. */
export function kindOf(node: NodeRecord): string {
  if (node.type === "frame") {
    if (getProp(node.props, "isComponentSet")) return "component set";
    if (getProp(node.props, "isComponent")) return "component";
    if (getProp(node.props, "instanceOf")) return "instance";
  }
  return node.type;
}

export interface OutlineEntry {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly width?: number;
  readonly height?: number;
  readonly text?: string;
  readonly children?: readonly OutlineEntry[];
  /** Children left out past the depth or the node limit. */
  readonly more?: number;
}

/**
 * A page's (or a layer's) layers as a tree, `depth` levels down and at most
 * `limit` nodes in all; what's left out is counted.
 */
export function outline(doc: DocView, rootId: string, depth: number, limit: number) {
  let budget = limit;
  let truncated = false;
  const visit = (node: NodeRecord, level: number): OutlineEntry => {
    budget--;
    const entry: {
      -readonly [K in keyof OutlineEntry]: OutlineEntry[K];
    } = { id: node.id, kind: kindOf(node), name: displayName(node) };
    if (node.type !== "page") {
      entry.width = round(getProp(node.props, "width"));
      entry.height = round(getProp(node.props, "height"));
    }
    if (node.type === "text") entry.text = getProp(node.props, "characters").slice(0, 200);
    const kids = doc.children(node.id);
    if (kids.length > 0) {
      if (level >= depth) {
        entry.more = kids.length;
        truncated = true;
      } else {
        const shown: OutlineEntry[] = [];
        for (const child of kids) {
          if (budget <= 0) break;
          shown.push(visit(child, level + 1));
        }
        entry.children = shown;
        if (shown.length < kids.length) {
          entry.more = kids.length - shown.length;
          truncated = true;
        }
      }
    }
    return entry;
  };
  const root = doc.get(rootId);
  return root ? { tree: visit(root, 0), truncated } : null;
}

const round = (n: number) => Math.round(n * 100) / 100;

/** A node in full: its props (defaults left out, as stored), parent and children. */
export function nodeDetail(doc: DocView, id: string) {
  const node = doc.get(id);
  if (!node) return null;
  return {
    id: node.id,
    kind: kindOf(node),
    name: displayName(node),
    parent: node.parent,
    page: doc.pageOf(id)?.id ?? null,
    props: node.props,
    children: doc.children(id).map((c) => ({ id: c.id, kind: kindOf(c), name: displayName(c) })),
  };
}

/** Layers on pages whose name or text holds `query` (any case), and of `kind` when given. */
export function findNodes(doc: DocView, query: string, kind: string | undefined, limit: number) {
  const q = query.trim().toLowerCase();
  const found: Array<{ id: string; kind: string; name: string; page: string }> = [];
  let total = 0;
  for (const node of doc.onPages()) {
    if (node.type === "page") continue;
    const k = kindOf(node);
    if (kind && k !== kind && node.type !== kind) continue;
    const text = node.type === "text" ? getProp(node.props, "characters") : "";
    if (q && !displayName(node).toLowerCase().includes(q) && !text.toLowerCase().includes(q))
      continue;
    total++;
    if (found.length < limit)
      found.push({
        id: node.id,
        kind: k,
        name: displayName(node),
        page: doc.pageOf(node.id)?.id ?? "",
      });
  }
  return { nodes: found, total };
}

/** The file's own components (and sets of variants), with how often each is used. */
export function components(doc: DocView) {
  const uses = new Map<string, number>();
  for (const node of doc.onPages()) {
    const of = node.type === "frame" ? getProp(node.props, "instanceOf") : null;
    if (of) uses.set(of, (uses.get(of) ?? 0) + 1);
  }
  const out: Array<{
    id: string;
    name: string;
    description: string;
    page: string;
    instances: number;
    variants?: Array<{ id: string; name: string; instances: number }>;
  }> = [];
  for (const node of doc.onPages()) {
    const kind = kindOf(node);
    const parent = doc.get(node.parent);
    if (kind === "component" && parent && kindOf(parent) === "component set") continue;
    if (kind !== "component" && kind !== "component set") continue;
    const entry: (typeof out)[number] = {
      id: node.id,
      name: displayName(node),
      description: getProp(node.props, "componentDescription"),
      page: doc.pageOf(node.id)?.id ?? "",
      instances: uses.get(node.id) ?? 0,
    };
    if (kind === "component set") {
      entry.variants = doc
        .children(node.id)
        .filter((c) => kindOf(c) === "component")
        .map((c) => ({ id: c.id, name: displayName(c), instances: uses.get(c.id) ?? 0 }));
      entry.instances = entry.variants.reduce((n, v) => n + v.instances, 0);
    }
    out.push(entry);
  }
  return out;
}

/** The file's tokens: variable collections (values by mode name) and text styles. */
export function tokens(doc: DocView) {
  const collections = doc
    .children(ROOT_ID)
    .filter((n) => n.type === "collection")
    .map((collection) => {
      const modes = getProp(collection.props, "modes");
      const modeName = new Map(modes.map((m) => [m.id, m.name]));
      return {
        id: collection.id,
        name: displayName(collection),
        modes: modes.map((m) => m.name),
        variables: doc
          .children(collection.id)
          .filter((v) => v.type === "variable")
          .map((v) => ({
            id: v.id,
            name: getProp(v.props, "name"),
            type: getProp(v.props, "variableType"),
            description: getProp(v.props, "description") || undefined,
            values: Object.fromEntries(
              Object.entries(getProp(v.props, "values")).map(([mode, value]) => [
                modeName.get(mode) ?? mode,
                value && typeof value === "object" && "alias" in value
                  ? {
                      alias: doc.get(value.alias)
                        ? getProp((doc.get(value.alias) as NodeRecord).props, "name")
                        : value.alias,
                    }
                  : value,
              ]),
            ),
          })),
      };
    });
  const textStyles = doc
    .children(ROOT_ID)
    .filter((n) => n.type === "textStyle")
    .map((style) => ({
      id: style.id,
      name: getProp(style.props, "name"),
      fontFamily: getProp(style.props, "fontFamily"),
      fontSize: getProp(style.props, "fontSize"),
      fontWeight: getProp(style.props, "fontWeight"),
      lineHeight: getProp(style.props, "lineHeight"),
      letterSpacing: getProp(style.props, "letterSpacing"),
    }));
  return { collections, textStyles };
}
