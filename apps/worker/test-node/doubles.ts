/**
 * Stand-ins for what a FileRoom runs on, so its code paths run in Node,
 * where memory can be measured (local workerd doesn't enforce the 128 MB a
 * Durable Object has): `SqlStorage` over node:sqlite, and the parts of
 * `R2Bucket` snapshots use, kept in files.
 */
import {
  createReadStream,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { Readable } from "node:stream";
import type { RoomSql } from "../src/rooms/node-tables";

/** Called often from inside every path (each statement, each part), to sample memory. */
export type Probe = () => void;

class Cursor<T> implements Iterable<T> {
  readonly #rows: Iterator<T> | null;
  readonly rowsWritten: number;
  constructor(rows: Iterator<T> | null, written: number) {
    this.#rows = rows;
    this.rowsWritten = written;
  }
  [Symbol.iterator](): Iterator<T> {
    return this.#rows ?? [][Symbol.iterator]();
  }
  next(): IteratorResult<T> {
    return this.#rows ? this.#rows.next() : { done: true, value: undefined };
  }
  toArray(): T[] {
    return [...this];
  }
  one(): T {
    // Read to the end, so the statement is finished (SQLite won't drop a table one is reading).
    const [first] = this.toArray();
    if (first === undefined) throw new Error("no rows");
    return first;
  }
}

/** `SqlStorage` (the parts the room uses) over an on-disk node:sqlite database. */
export function sqlDouble(path: string, probe: Probe): RoomSql & { close(): void } {
  rmSync(path, { force: true });
  const db = new DatabaseSync(path);
  // Like a Durable Object: data on disk, a modest page cache.
  db.exec("PRAGMA journal_mode = WAL; PRAGMA cache_size = -16000; PRAGMA temp_store = FILE;");
  const statements = new Map<string, StatementSync>();
  let depth = 0;
  const sql = {
    exec<T>(query: string, ...bindings: unknown[]) {
      probe();
      const trimmed = query.trim().replace(/;$/, "");
      if (trimmed.includes(";")) {
        db.exec(query);
        return new Cursor<T>(null, 0);
      }
      let statement = statements.get(query);
      if (!statement) {
        statement = db.prepare(query);
        if (statements.size > 500) statements.clear();
        statements.set(query, statement);
      }
      const params = bindings as Array<string | number | null>;
      if (statement.columns().length > 0)
        return new Cursor<T>(statement.iterate(...params) as Iterator<T>, 0);
      const { changes } = statement.run(...params);
      return new Cursor<T>(null, Number(changes));
    },
    get databaseSize() {
      return statSync(path).size;
    },
  } as unknown as SqlStorage;
  return {
    sql,
    transact<T>(fn: () => T): T {
      const name = `sp${depth++}`;
      db.exec(`SAVEPOINT ${name}`);
      try {
        const result = fn();
        db.exec(`RELEASE ${name}`);
        return result;
      } catch (error) {
        db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`);
        throw error;
      } finally {
        depth--;
      }
    },
    close() {
      db.close();
    },
  };
}

/** The parts of `R2Bucket` snapshots use, kept as files in `dir`. */
export function r2Double(dir: string, probe: Probe): R2Bucket {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const file = (key: string) => join(dir, encodeURIComponent(key));
  const object = (key: string) => {
    const size = statSync(file(key), { throwIfNoEntry: false })?.size;
    return size === undefined ? null : { key, size, uploaded: new Date() };
  };
  const bytes = async (value: unknown): Promise<Uint8Array> => {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (typeof value === "string") return new TextEncoder().encode(value);
    return new Uint8Array(await new Response(value as ReadableStream).arrayBuffer());
  };
  const bucket = {
    async put(key: string, value: unknown) {
      probe();
      writeFileSync(file(key), await bytes(value));
      return object(key);
    },
    async head(key: string) {
      return object(key);
    },
    async get(key: string) {
      probe();
      const found = object(key);
      if (!found) return null;
      const body = Readable.toWeb(
        createReadStream(file(key), { highWaterMark: 1 << 16 }),
      ) as unknown as ReadableStream<Uint8Array>;
      return { ...found, body };
    },
    async delete(keys: string | string[]) {
      for (const key of Array.isArray(keys) ? keys : [keys]) rmSync(file(key), { force: true });
    },
    async createMultipartUpload(key: string) {
      const parts: string[] = [];
      return {
        key,
        uploadId: "u",
        async uploadPart(partNumber: number, value: unknown) {
          probe();
          const path = `${file(key)}.part${partNumber}`;
          writeFileSync(path, await bytes(value));
          parts[partNumber - 1] = path;
          return { partNumber, etag: String(partNumber) };
        },
        async complete() {
          rmSync(file(key), { force: true });
          for (const part of parts) {
            probe();
            await appendFile(file(key), readFileSync(part));
            rmSync(part);
          }
          return object(key);
        },
        async abort() {
          for (const part of parts) rmSync(part, { force: true });
        },
      };
    },
  };
  return bucket as unknown as R2Bucket;
}
