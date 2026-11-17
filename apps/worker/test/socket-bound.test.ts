/**
 * The size check for a client that can't download (decision 0029,
 * `rooms/socket-snapshot.ts`) reads only until the file is past the bound,
 * counted in rows SQLite reads (`rowsRead`, billed per row on Durable
 * Objects). It summed every row's length on every such hello: 500,000 rows
 * on a kit, from old tabs.
 */
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createNodeTable, dropTable } from "../src/rooms/node-tables";
import { SOCKET_MAX_CHARS, socketFits } from "../src/rooms/socket-snapshot";

/** `sql`, counting the rows its statements read. */
function counting(sql: SqlStorage) {
  const cursors: Array<{ rowsRead: number }> = [];
  const proxy = {
    exec: (query: string, ...bindings: unknown[]) => {
      const cursor = sql.exec(query, ...(bindings as SqlStorageValue[]));
      cursors.push(cursor);
      return cursor;
    },
  } as unknown as SqlStorage;
  return { sql: proxy, rowsRead: () => cursors.reduce((n, c) => n + c.rowsRead, 0) };
}

describe("the size check for a client that can't download", () => {
  it("stops reading once the file is past the bound", async () => {
    const room = env.FILE_ROOM.get(env.FILE_ROOM.idFromName("socket-bound"));
    await runInDurableObject(room, (_room, state) => {
      const sql = state.storage.sql;
      const table = "tmp_socket_bound";
      createNodeTable(sql, table);
      // 20,000 rows of about 2,000 characters: 40 MB, five times the bound.
      sql.exec(
        `WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x + 1 FROM n WHERE x < 20000)
         INSERT INTO ${table} (id, parent, key, type, props)
           SELECT printf('n%05d', x), 'P', 'a0', 'rect', '{"name":"' || hex(randomblob(1000)) || '"}' FROM n`,
      );
      const past = counting(sql);
      expect(socketFits(past.sql, { table })).toBe(false);
      // About SOCKET_MAX_CHARS / 2,000 rows (4,200), read in pages of 2,000: never the 20,000.
      expect(past.rowsRead()).toBeLessThan(8_000);
      expect(past.rowsRead()).toBeGreaterThan(SOCKET_MAX_CHARS / 2_012);

      // Under the bound, the answer is the same as summing the whole table.
      sql.exec(`DELETE FROM ${table} WHERE id > 'n01000'`);
      expect(socketFits(sql, { table })).toBe(true);
      dropTable(sql, table);
    });
  });
});
