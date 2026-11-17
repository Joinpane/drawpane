/**
 * The file sent through the socket, to a client that doesn't download it:
 * one that can't (a tab from before compact copies, protocol 1, or a hello
 * without `download`), or one whose file is small enough not to. A socket
 * has no backpressure, so what's sent is held until it leaves, and a room
 * has 128 MB: whatever the file's form, it's sent only when it's at most
 * SOCKET_MAX_CHARS of JSON, in chunks of at most SOCKET_CHUNK_NODES nodes
 * and SOCKET_CHUNK_CHARS. Past that, a client that can't download is sent
 * `reloadPlaceholder`, never stored (decision 0029).
 *
 * The file is sent as stored, or as presented (every copy built, an
 * instance at a time) to a tab from before compact copies in a file stored
 * compact. Its size is measured before anything is sent: what's stored, in
 * SQL, then the file as it will be sent, a node at a time, stopping as soon
 * as it's past.
 */
import { BuildTooLarge, type NodeRecord, ROOT_ID } from "@drawpane/model";
import { sumPast, TableReader, tablePages, toRecord } from "./node-tables";
import { PresentedReader } from "./presented";

/** The most JSON a file sent through the socket is, in characters (a text may hold 200,000). */
export const SOCKET_MAX_CHARS = 8 << 20;
/** The most JSON in one chunk of it. */
export const SOCKET_CHUNK_CHARS = 1 << 20;
/** Nodes in a chunk at most (the protocol's SNAPSHOT_CHUNK_SIZE). */
const SOCKET_CHUNK_NODES = 2_000;

export interface SocketSnapshot {
  /** The table the file is in. */
  readonly table?: string;
  /** Every copy built, for a client that reads materialized files only, from a file stored compact. */
  readonly presented?: boolean;
  readonly maxChars?: number;
  readonly chunkChars?: number;
}

/**
 * What a client that can't download is shown of a file too large to send
 * it: one page saying to reload, never stored (it's welcomed as a viewer,
 * and its edits are refused telling it the same).
 */
export function reloadPlaceholder(): NodeRecord[] {
  return [
    {
      id: "drawpane-reload-page",
      type: "page",
      parent: ROOT_ID,
      key: "a0",
      props: { name: "Reload" },
    },
    {
      id: "drawpane-reload-text",
      type: "text",
      parent: "drawpane-reload-page",
      key: "a0",
      props: {
        name: "Reload",
        x: 0,
        y: 0,
        fontSize: 24,
        characters: "Drawpane was updated. Reload the page to see this file.",
      },
    },
  ] as NodeRecord[];
}

/** The file's nodes, as they're sent: stored rows a page at a time, or as presented. */
function* nodesOf(sql: SqlStorage, table: string, presented: boolean): Generator<NodeRecord> {
  if (presented) {
    yield* new PresentedReader(new TableReader(sql, table), sql, table).all();
    return;
  }
  for (const rows of tablePages(sql, table, SOCKET_CHUNK_NODES, SOCKET_CHUNK_CHARS))
    for (const row of rows) yield toRecord(row);
}

/**
 * Whether the file is at most `maxChars` of JSON as it's sent: what's
 * stored is measured first, in SQL; then the file is walked a node at a
 * time, stopping as soon as it's past. An instance too large to build
 * doesn't fit either.
 */
export function socketFits(
  sql: SqlStorage,
  { table = "nodes", presented = false, maxChars = SOCKET_MAX_CHARS }: SocketSnapshot = {},
): boolean {
  // What's stored, read only until it's past (a hello reads about as many rows as fit, not 500,000).
  if (sumPast(sql, table, "LENGTH(props)", maxChars) > maxChars) return false;
  let chars = 0;
  try {
    for (const node of nodesOf(sql, table, presented)) {
      chars += JSON.stringify(node).length;
      if (chars > maxChars) return false;
    }
  } catch (error) {
    if (error instanceof BuildTooLarge) return false;
    throw error;
  }
  return true;
}

/**
 * Sends the file through the socket, `socketFits` having said it fits, in
 * chunks of at most SOCKET_CHUNK_NODES nodes and `chunkChars`. The last
 * chunk is `done`.
 */
export function sendSocketSnapshot(
  sql: SqlStorage,
  send: (nodes: NodeRecord[], done: boolean) => void,
  { table = "nodes", presented = false, chunkChars = SOCKET_CHUNK_CHARS }: SocketSnapshot = {},
): void {
  let chunk: NodeRecord[] = [];
  let chars = 0;
  for (const node of nodesOf(sql, table, presented)) {
    const size = JSON.stringify(node).length;
    if (chunk.length > 0 && (chunk.length >= SOCKET_CHUNK_NODES || chars + size > chunkChars)) {
      send(chunk, false);
      chunk = [];
      chars = 0;
    }
    chunk.push(node);
    chars += size;
  }
  send(chunk, true);
}

/**
 * Sends a client that can't download the file, or the placeholder when
 * it's too large: the two calls above, for tests and callers that decide
 * nothing between them.
 */
export function sendBounded(
  sql: SqlStorage,
  send: (nodes: NodeRecord[], done: boolean) => void,
  options: SocketSnapshot = {},
): "sent" | "placeholder" {
  if (!socketFits(sql, options)) {
    send(reloadPlaceholder(), true);
    return "placeholder";
  }
  sendSocketSnapshot(sql, send, options);
  return "sent";
}
