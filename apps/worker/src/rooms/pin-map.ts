/**
 * Where comment pins on copy layers go when a file changes how it stores
 * copies (decision 0029): converting renames every copy layer (old id →
 * derived id), and restoring a version from before it, with conversion off,
 * puts the old ids back.
 *
 * The applied conversion's map stays in the room (`pin_map`) for a while
 * (`PIN_MAP_KEEP_MS`): comment writes made with an id of the other form (a
 * tab that hasn't reloaded) are translated through it as they're made, and
 * the alarm moves every pin when it's applied, when a restore puts the old
 * form back, and once more before the map goes. A copy of it is kept in R2
 * beside the file, so restoring the version saved before converting puts
 * pins back whenever that happens.
 *
 * Nothing here imports `cloudflare:workers`.
 */
import { putStream } from "./snapshots";

export const PIN_MAP = "pin_map";

/** How long the room keeps the map after a change of form: comment writes are translated meanwhile. */
export const PIN_MAP_KEEP_MS = 7 * 24 * 60 * 60_000;

/** Where a conversion's map is kept in R2, beside the file. */
export function pinMapKey(fileId: string, revn: number): string {
  return `files/${fileId}/copies-map/${revn}.tsv.gz`;
}

/**
 * Keeps an applied conversion's map (`map`: old, new, root) as the pin
 * map, replacing an older one. Call in the storage transaction that applies
 * the conversion.
 */
export function keepPinMap(sql: SqlStorage, map: string): void {
  sql.exec(`DROP TABLE IF EXISTS ${PIN_MAP}`);
  sql.exec(`DROP INDEX IF EXISTS ${map}_root`);
  sql.exec(`DELETE FROM ${map} WHERE old = new`);
  sql.exec(`ALTER TABLE ${map} RENAME TO ${PIN_MAP}`);
  sql.exec(`CREATE INDEX IF NOT EXISTS ${PIN_MAP}_new ON ${PIN_MAP} (new)`);
}

export function hasPinMap(sql: SqlStorage): boolean {
  return (
    sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", PIN_MAP).toArray()
      .length > 0
  );
}

export function dropPinMap(sql: SqlStorage): void {
  sql.exec(`DROP TABLE IF EXISTS ${PIN_MAP}`);
}

/**
 * The ids among `ids` the file names otherwise now, and what it names them:
 * old copy ids → derived ones when it stores copies compact
 * (`toCompact`), and back when it stores them materialized.
 */
export function pinsRenamed(
  sql: SqlStorage,
  ids: readonly string[],
  toCompact: boolean,
): Map<string, string> {
  const out = new Map<string, string>();
  if (!hasPinMap(sql)) return out;
  const [from, to] = toCompact ? ["old", "new"] : ["new", "old"];
  for (let i = 0; i < ids.length; i += 90) {
    const batch = ids.slice(i, i + 90);
    for (const row of sql
      .exec<{ a: string; b: string }>(
        `SELECT ${from} AS a, ${to} AS b FROM ${PIN_MAP} WHERE ${from} IN (${batch.map(() => "?").join(", ")})`,
        ...batch,
      )
      .toArray())
      out.set(row.a, row.b);
  }
  return out;
}

/** Writes the pin map to R2 at `key`, gzipped lines of `old<TAB>new`. */
export async function savePinMap(bucket: R2Bucket, key: string, sql: SqlStorage): Promise<void> {
  let after = "";
  let finished = false;
  const encoder = new TextEncoder();
  const text = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (finished) return;
      const rows = sql
        .exec<{ old: string; new: string }>(
          `SELECT old, new FROM ${PIN_MAP} WHERE old > ? ORDER BY old LIMIT 2000`,
          after,
        )
        .toArray();
      if (rows.length === 0) {
        finished = true;
        controller.close();
        return;
      }
      after = (rows[rows.length - 1] as { old: string }).old;
      controller.enqueue(encoder.encode(rows.map((r) => `${r.old}\t${r.new}\n`).join("")));
    },
  });
  await putStream(bucket, key, text.pipeThrough(new CompressionStream("gzip")), 0);
}

/**
 * What a map `savePinMap` wrote says `id` is named in the other form (old
 * copy id → derived one when `toCompact`, and back), read from R2 a line at
 * a time without keeping it; null when it doesn't name it, or it's gone.
 */
export async function pinRenamedInR2(
  bucket: R2Bucket,
  key: string,
  id: string,
  toCompact: boolean,
): Promise<string | null> {
  const object = await bucket.get(key);
  if (!object) return null;
  const reader = object.body
    .pipeThrough(new DecompressionStream("gzip"))
    .pipeThrough(new TextDecoderStream())
    .getReader();
  const find = (line: string): string | null => {
    const [old, derived] = line.split("\t");
    if (old === undefined || derived === undefined) return null;
    if (toCompact) return old === id ? derived : null;
    return derived === id ? old : null;
  };
  let rest = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const lines = (rest + value).split("\n");
      rest = lines.pop() ?? "";
      for (const line of lines) {
        const found = find(line);
        if (found !== null) return found;
      }
    }
    return rest ? find(rest) : null;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/** Reads a map `savePinMap` wrote into the pin map (replacing what's there). False when it's gone. */
export async function loadPinMap(bucket: R2Bucket, key: string, sql: SqlStorage): Promise<boolean> {
  const object = await bucket.get(key);
  if (!object) return false;
  const staging = `${PIN_MAP}_load`;
  sql.exec(`DROP TABLE IF EXISTS ${staging}`);
  sql.exec(`CREATE TABLE ${staging} (old TEXT PRIMARY KEY, new TEXT NOT NULL) STRICT`);
  const reader = object.body
    .pipeThrough(new DecompressionStream("gzip"))
    .pipeThrough(new TextDecoderStream())
    .getReader();
  let rest = "";
  const put = (lines: string[]) => {
    const pairs = lines
      .map((line) => line.split("\t"))
      .filter((pair): pair is [string, string] => pair.length === 2);
    for (let i = 0; i < pairs.length; i += 40) {
      const batch = pairs.slice(i, i + 40);
      sql.exec(
        `INSERT OR REPLACE INTO ${staging} (old, new) VALUES ${batch.map(() => "(?, ?)").join(", ")}`,
        ...batch.flat(),
      );
    }
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const lines = (rest + value).split("\n");
      rest = lines.pop() ?? "";
      put(lines);
    }
    if (rest) put([rest]);
  } catch (error) {
    sql.exec(`DROP TABLE IF EXISTS ${staging}`);
    throw error;
  }
  sql.exec(`DROP TABLE IF EXISTS ${PIN_MAP}`);
  sql.exec(`ALTER TABLE ${staging} RENAME TO ${PIN_MAP}`);
  sql.exec(`CREATE INDEX IF NOT EXISTS ${PIN_MAP}_new ON ${PIN_MAP} (new)`);
  return true;
}
