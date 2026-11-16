/**
 * A file stored with compact copies (decision 0029), read as the editor
 * presents it: every copy layer built from its main and its override
 * record, an instance at a time, by the model's own `CopyView`. What the
 * room's readers use (the MCP tools, a library's manifest), so they see the
 * layers people see, never records.
 *
 * Built copies are cached, and let go once more than `limit` are held,
 * between instances (a walk is never inside one when the cache empties), so
 * a walk over a file of any size holds a few instances at most. What it
 * builds is charged to a `BuildBudget` too (`BUILD_HELD_BYTES`): past half
 * of it, the cache empties between instances, and an instance that can't
 * be built within it throws `BuildTooLarge` rather than run the room out
 * of memory.
 */
import {
  BuildBudget,
  CopyView,
  type DocReader,
  isMainNode,
  type NodeRecord,
  type StoredReader,
} from "@drawpane/model";
import type { DocView } from "../mcp/document";
import { BUILD_HELD_BYTES } from "./convert";
import { NODE_COLUMNS, type NodeRow, type TableReader, toRecord } from "./node-tables";

export class PresentedReader implements DocReader {
  readonly #reader: TableReader;
  readonly #sql: SqlStorage;
  readonly #table: string;
  readonly #view: CopyView;
  readonly #limit: number;

  constructor(reader: TableReader, sql: SqlStorage, table: string, limit = 20_000) {
    this.#reader = reader;
    this.#sql = sql;
    this.#table = table;
    this.#limit = limit;
    const stored: StoredReader = {
      get: (id) => reader.get(id),
      childIds: (parent) => reader.childIds(parent),
      nodes: () => [],
    };
    this.#view = new CopyView(stored, {
      lazy: true,
      budget: new BuildBudget({ bytes: BUILD_HELD_BYTES }),
    });
  }

  /** Between instances: past the cache's size or half the budget, let go of what's built. */
  #between(): void {
    if (this.#view.slotCount > this.#limit || this.#view.held > BUILD_HELD_BYTES / 2)
      this.#view.clear();
  }

  /** Whether `id` is stored and not a record: a node outside every copy. */
  #storedLayer(id: string): NodeRecord | undefined {
    const node = this.#reader.get(id);
    return node && node.type !== "override" ? node : undefined;
  }

  get(id: string): NodeRecord | undefined {
    if (this.#storedLayer(id)) {
      // Between instances: a good moment to let go of what's built.
      this.#between();
      return this.#view.get(id);
    }
    const known = this.#view.get(id);
    if (known) return known;
    // A copy layer not built yet: its record says which instance it's in, or each is built
    // in turn (bounded, as a walk is) until it's found.
    const record = this.#reader.get(id);
    if (record?.type === "override") {
      this.#view.childIds(record.parent);
      return this.#view.get(id);
    }
    return this.#search(id);
  }

  #search(id: string): NodeRecord | undefined {
    let after = "";
    for (;;) {
      const roots = this.#sql
        .exec<NodeRow>(
          `SELECT ${NODE_COLUMNS} FROM ${this.#table}
            WHERE id > ? AND type = 'frame' AND json_extract(props, '$.instanceOf') IS NOT NULL
            ORDER BY id LIMIT 200`,
          after,
        )
        .toArray()
        .map(toRecord);
      for (const root of roots) {
        if (!this.#view.mainOf(root)) continue;
        this.#between();
        const stack = [...this.#view.childIds(root.id)];
        for (let at = stack.pop(); at !== undefined; at = stack.pop()) {
          if (at === id) return this.#view.get(id);
          stack.push(...this.#view.childIds(at));
        }
      }
      if (roots.length < 200) return undefined;
      after = (roots[roots.length - 1] as NodeRecord).id;
    }
  }

  /** Whether a node's children are presented (an instance root, or a copy layer). */
  #presents(id: string): boolean {
    const stored = this.#storedLayer(id);
    if (stored)
      return !!this.#view.mainOf(stored) || (stored.type === "frame" && !!stored.props.instanceOf);
    return true;
  }

  childIds(parent: string): readonly string[] {
    if (this.#presents(parent)) {
      this.get(parent);
      return this.#view.childIds(parent);
    }
    return this.#reader.childIds(parent);
  }

  children(parent: string): Iterable<string> {
    if (this.#presents(parent)) return this.childIds(parent);
    return this.#reader.children(parent);
  }

  *childNodes(parent: string): Generator<NodeRecord> {
    for (const id of this.children(parent)) {
      const node = this.get(id);
      if (node) yield node;
    }
  }

  childCount(parent: string): number {
    if (this.#presents(parent)) return this.childIds(parent).length;
    return this.#reader.childCount(parent);
  }

  pageIds(): readonly string[] {
    return this.#reader.pageIds();
  }

  pages(): NodeRecord[] {
    const out: NodeRecord[] = [];
    for (const id of this.#reader.pageIds()) {
      const page = this.#reader.get(id);
      if (page) out.push(page);
    }
    return out;
  }

  pageOf(id: string): NodeRecord | undefined {
    for (let node = this.get(id); node; node = this.get(node.parent))
      if (node.type === "page") return node;
    return undefined;
  }

  *onPages(): Generator<NodeRecord> {
    const stack: Iterator<string>[] = [this.pageIds()[Symbol.iterator]()];
    while (stack.length > 0) {
      const next = (stack[stack.length - 1] as Iterator<string>).next();
      if (next.done) {
        stack.pop();
        continue;
      }
      const node = this.get(next.value);
      if (!node) continue;
      yield node;
      stack.push(this.children(next.value)[Symbol.iterator]());
    }
  }

  /** The MCP tools' view of it (mcp/document.ts). */
  asDocView(): DocView {
    return {
      get: (id) => this.get(id),
      children: (id) => this.childNodes(id),
      childIds: (id) => this.children(id),
      childCount: (id) => this.childCount(id),
      pages: () => this.pages(),
      pageOf: (id) => this.pageOf(id),
      onPages: () => this.onPages(),
    };
  }

  /** Main components on the pages, in file order (stored: copies aren't mains). */
  componentMains(): NodeRecord[] {
    return this.#reader.componentMains().filter((n) => isMainNode(n));
  }
}
