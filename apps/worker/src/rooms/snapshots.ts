/**
 * Snapshots in R2 (decision 0026): one gzip object per saved revision at
 * `files/<file-id>/snapshots/<revn padded to 12>.json.gz`, and a branch's
 * base (the main file's nodes it was made from) at
 * `files/<branch-id>/branch-base.json.gz`.
 *
 * Written as version 2 (a header line, then a line of JSON per node; see
 * `@drawpane/model`'s snapshot.ts) a page of rows at a time, gzipped as a
 * stream and uploaded in parts, so a file of any size is saved without
 * being held. Read the same way, a batch of nodes at a time, and version 1
 * (one JSON object, every node in `nodes`) is read as a stream too.
 */
import {
  type NodeRecord,
  SNAPSHOT_FORMAT,
  type SnapshotHeader,
  snapshotHeaderLine,
} from "@drawpane/model";
import { type NodeRow, rowLine } from "./node-tables";

/** Unnamed versions older than this are deleted. Named ones stay until the file does. */
export const AUTOSAVE_RETENTION_MS = 30 * 24 * 60 * 60_000;

/**
 * R2 parts are this size (all but the last must be the same, and at least
 * 5 MiB). A snapshot smaller than one part is put in one go.
 */
export const SNAPSHOT_PART_BYTES = 8 * 1024 * 1024;

/** Nodes, or at most this much of their JSON, per batch read. */
const BATCH_NODES = 1_000;
const BATCH_CHARS = 1 << 20;

export function snapshotKey(fileId: string, revn: number): string {
  return `files/${fileId}/snapshots/${String(revn).padStart(12, "0")}.json.gz`;
}

/**
 * A branch's first base: its main file's nodes at the revision it was made
 * from. Each update from main writes the next base under a key of its own
 * (`nextBranchBaseKey`), and the branch's room keeps which is current.
 */
export function branchBaseKey(branchId: string): string {
  return `files/${branchId}/branch-base.json.gz`;
}

/** A new key for a branch's base as of main's revision `revn`, never one used before. */
export function nextBranchBaseKey(branchId: string, revn: number): string {
  return `files/${branchId}/branch-bases/${String(revn).padStart(12, "0")}-${crypto.randomUUID()}.json.gz`;
}

const METADATA = (revn: number) => ({
  httpMetadata: { contentType: "application/json", contentEncoding: "gzip" },
  customMetadata: { revn: String(revn) },
});

/**
 * A version 2 snapshot of `pages` (rows read only as the stream is read), as
 * gzip bytes. `finished` runs once, when it has been read to the end or let
 * go: where the caller drops the table it reads from.
 */
export function snapshotStream(
  header: { readonly fileId: string; readonly revn: number; readonly at: number },
  pages: Iterator<NodeRow[]>,
  finished: () => void = () => {},
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let started = false;
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    finished();
  };
  const text = new ReadableStream<Uint8Array>({
    pull(controller) {
      try {
        if (!started) {
          started = true;
          controller.enqueue(
            encoder.encode(snapshotHeaderLine(header.fileId, header.revn, header.at)),
          );
          return;
        }
        const next = pages.next();
        if (next.done) {
          finish();
          controller.close();
          return;
        }
        let chunk = "";
        for (const row of next.value) chunk += `${rowLine(row)}\n`;
        controller.enqueue(encoder.encode(chunk));
      } catch (error) {
        finish();
        controller.error(error);
      }
    },
    cancel() {
      finish();
    },
  });
  return text.pipeThrough(new CompressionStream("gzip"));
}

/**
 * Puts a stream in R2 at `key`: in one go when it's under a part, else as a
 * multipart upload of SNAPSHOT_PART_BYTES parts. Holds one part at a time.
 * Returns the bytes stored.
 */
export async function putStream(
  bucket: R2Bucket,
  key: string,
  body: ReadableStream<Uint8Array>,
  revn: number,
): Promise<number> {
  const reader = body.getReader();
  let part = new Uint8Array(SNAPSHOT_PART_BYTES);
  let filled = 0;
  let total = 0;
  let upload: R2MultipartUpload | null = null;
  const parts: R2UploadedPart[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      let offset = 0;
      while (offset < value.byteLength) {
        const take = Math.min(value.byteLength - offset, part.byteLength - filled);
        part.set(value.subarray(offset, offset + take), filled);
        filled += take;
        offset += take;
        if (filled === part.byteLength) {
          upload ??= await bucket.createMultipartUpload(key, METADATA(revn));
          parts.push(await upload.uploadPart(parts.length + 1, part));
          part = new Uint8Array(SNAPSHOT_PART_BYTES);
          filled = 0;
        }
      }
    }
    if (!upload) {
      await bucket.put(key, part.slice(0, filled), METADATA(revn));
      return total;
    }
    if (filled > 0) parts.push(await upload.uploadPart(parts.length + 1, part.slice(0, filled)));
    await upload.complete(parts);
    return total;
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (upload) await upload.abort().catch(() => {});
    throw error;
  }
}

/** Writes a version 2 snapshot of `pages` to `key`; returns its compressed size in bytes. */
export function writeSnapshot(
  bucket: R2Bucket,
  key: string,
  header: { readonly fileId: string; readonly revn: number; readonly at: number },
  pages: Iterator<NodeRow[]>,
): Promise<number> {
  return putStream(bucket, key, snapshotStream(header, pages), header.revn);
}

// ---------------------------------------------------------------------------
// Reading

/**
 * A snapshot being read: its header (for a version 1 snapshot, what came
 * before its nodes) and its nodes' JSON, a batch at a time.
 */
export interface SnapshotSource {
  readonly header: Partial<SnapshotHeader> & { readonly version: 1 | 2 };
  /** Each node's JSON text, as stored, in batches. */
  readonly lines: AsyncGenerator<string[]>;
}

/** A snapshot in R2, opened to read; null when it doesn't exist or isn't one. */
export async function openSnapshot(bucket: R2Bucket, key: string): Promise<SnapshotSource | null> {
  const object = await bucket.get(key);
  if (!object) return null;
  return openSnapshotStream(object.body);
}

/** Its nodes, parsed, in batches. */
export async function* snapshotNodes(source: SnapshotSource): AsyncGenerator<NodeRecord[]> {
  for await (const lines of source.lines) yield lines.map((line) => JSON.parse(line) as NodeRecord);
}

async function* textOf(gz: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = gz
    .pipeThrough(new DecompressionStream("gzip"))
    .pipeThrough(new TextDecoderStream())
    .getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/** Opens a gzip snapshot stream of either version; null when it isn't a snapshot. */
export async function openSnapshotStream(
  gz: ReadableStream<Uint8Array>,
): Promise<SnapshotSource | null> {
  const text = textOf(gz);
  let buffer = "";
  try {
    // A version 2 header is the first line; version 1 has no newlines at all.
    while (!buffer.includes("\n") && buffer.length < 1 << 16) {
      const next = await text.next();
      if (next.done) break;
      buffer += next.value;
    }
  } catch {
    await text.return(undefined);
    return null;
  }
  const newline = buffer.indexOf("\n");
  if (newline >= 0) {
    let header: unknown = null;
    try {
      header = JSON.parse(buffer.slice(0, newline));
    } catch {
      // Not a version 2 header: read as version 1 below.
    }
    if (isHeader(header) && header.version === 2)
      return { header, lines: lineBatches(buffer.slice(newline + 1), text) };
  }
  const splitter = new V1Splitter();
  const ready: string[] = [];
  let ended = false;
  try {
    // Pushed one at a time: a chunk may hold any number of nodes, too many to spread.
    for (const line of splitter.push(buffer)) ready.push(line);
    while (!splitter.inNodes && !splitter.finished) {
      const next = await text.next();
      if (next.done) {
        ended = true;
        break;
      }
      for (const line of splitter.push(next.value)) ready.push(line);
    }
  } catch {
    await text.return(undefined);
    return null;
  }
  const header = splitter.header();
  if (!isHeader(header)) {
    await text.return(undefined);
    return null;
  }
  return {
    header: { ...header, version: 1 },
    lines: v1Batches(ready, splitter, ended ? null : text),
  };
}

function isHeader(value: unknown): value is SnapshotHeader {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { format?: unknown }).format === SNAPSHOT_FORMAT
  );
}

/** Version 2: lines, after the header. */
async function* lineBatches(start: string, text: AsyncGenerator<string>): AsyncGenerator<string[]> {
  let rest = start;
  let batch: string[] = [];
  let chars = 0;
  const take = function* (final: boolean): Generator<string[]> {
    let from = 0;
    for (;;) {
      const end = rest.indexOf("\n", from);
      if (end < 0) break;
      if (end > from) {
        batch.push(rest.slice(from, end));
        chars += end - from;
        if (batch.length >= BATCH_NODES || chars >= BATCH_CHARS) {
          yield batch;
          batch = [];
          chars = 0;
        }
      }
      from = end + 1;
    }
    rest = rest.slice(from);
    if (final && rest.trim() !== "") {
      batch.push(rest);
      rest = "";
    }
  };
  yield* take(false);
  for await (const chunk of text) {
    rest += chunk;
    yield* take(false);
  }
  yield* take(true);
  if (batch.length > 0) yield batch;
}

/** Version 1: nodes as the splitter finds them. */
async function* v1Batches(
  ready: readonly string[],
  splitter: V1Splitter,
  text: AsyncGenerator<string> | null,
): AsyncGenerator<string[]> {
  let batch: string[] = [];
  let chars = 0;
  const add = function* (elements: readonly string[]): Generator<string[]> {
    for (const element of elements) {
      batch.push(element);
      chars += element.length;
      if (batch.length >= BATCH_NODES || chars >= BATCH_CHARS) {
        yield batch;
        batch = [];
        chars = 0;
      }
    }
  };
  yield* add(ready);
  if (text) for await (const chunk of text) yield* add(splitter.push(chunk));
  if (batch.length > 0) yield batch;
}

/**
 * Finds the elements of the top-level `nodes` array in a version 1
 * snapshot's JSON as it arrives, without parsing the whole: it tracks
 * strings, escapes and nesting, and hands back each node's text whole.
 * What lies outside the array (the header fields) is kept to parse.
 */
export class V1Splitter {
  #depth = 0;
  #inString = false;
  #escape = false;
  /** The text of the last string completed at the top level, and where it started. */
  #lastKey = "";
  #stringStart = -1;
  #stringCarry = "";
  #inNodes = false;
  #nodesDone = false;
  /** The node being read, from earlier chunks. */
  #element = "";
  #elementStart = -1;
  #outside = "";

  get inNodes(): boolean {
    return this.#inNodes;
  }

  get finished(): boolean {
    return this.#nodesDone && this.#depth === 0;
  }

  /** The header fields seen so far (those before `nodes`, in practice all of them). */
  header(): unknown {
    try {
      return JSON.parse(this.#inNodes ? `${this.#outside}]}` : this.#outside);
    } catch {
      return null;
    }
  }

  /** Feeds text; returns the nodes it completed. */
  push(chunk: string): string[] {
    const out: string[] = [];
    let outsideFrom = this.#inNodes ? -1 : 0;
    if (this.#elementStart >= 0) this.#elementStart = 0;
    if (this.#stringStart >= 0) this.#stringStart = 0;
    for (let i = 0; i < chunk.length; i++) {
      const c = chunk.charCodeAt(i);
      if (this.#inString) {
        if (this.#escape) this.#escape = false;
        else if (c === 92 /* \ */) this.#escape = true;
        else if (c === 34 /* " */) {
          this.#inString = false;
          if (this.#depth === 1 && this.#stringStart >= 0) {
            this.#lastKey = this.#stringCarry + chunk.slice(this.#stringStart, i);
            this.#stringStart = -1;
            this.#stringCarry = "";
          }
        }
        continue;
      }
      if (c === 34) {
        this.#inString = true;
        if (this.#depth === 1) {
          this.#stringStart = i + 1;
          this.#stringCarry = "";
        }
        continue;
      }
      if (c === 123 /* { */ || c === 91 /* [ */) {
        if (this.#inNodes && this.#depth === 2 && c === 123) {
          this.#elementStart = i;
          this.#element = "";
        }
        this.#depth++;
        if (this.#depth === 2 && c === 91 && this.#lastKey === "nodes" && !this.#nodesDone) {
          this.#inNodes = true;
          this.#outside += chunk.slice(outsideFrom, i + 1);
          outsideFrom = -1;
        }
        continue;
      }
      if (c === 125 /* } */ || c === 93 /* ] */) {
        this.#depth--;
        if (this.#inNodes && this.#depth === 2 && c === 125 && this.#elementStart >= 0) {
          out.push(this.#element + chunk.slice(this.#elementStart, i + 1));
          this.#element = "";
          this.#elementStart = -1;
        } else if (this.#inNodes && this.#depth === 1 && c === 93) {
          this.#inNodes = false;
          this.#nodesDone = true;
          outsideFrom = i;
        }
      }
    }
    if (this.#elementStart >= 0) this.#element += chunk.slice(this.#elementStart);
    if (this.#inString && this.#stringStart >= 0)
      this.#stringCarry += chunk.slice(this.#stringStart);
    if (outsideFrom >= 0) this.#outside += chunk.slice(outsideFrom);
    return out;
  }
}

/**
 * What review reads (the branch's base, the branch now, main now) as lines
 * of JSON, each file's nodes after a line naming it, streamed as they're
 * read: `{"review":"base"}`, then a node per line, and so on. The browser
 * holds the three; nothing here does.
 */
export function reviewStream(
  base: SnapshotSource,
  branch: SnapshotSource,
  main: SnapshotSource,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const sections: Array<[string, SnapshotSource]> = [
    ["base", base],
    ["branch", branch],
    ["main", main],
  ];
  let current = -1;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        const section = sections[current];
        if (section) {
          const next = await section[1].lines.next();
          if (!next.done) {
            controller.enqueue(encoder.encode(`${next.value.join("\n")}\n`));
            return;
          }
        }
        current++;
        const upcoming = sections[current];
        if (!upcoming) {
          controller.close();
          return;
        }
        const [name, source] = upcoming;
        const revn = source.header.revn;
        controller.enqueue(
          encoder.encode(
            `${JSON.stringify({ review: name, ...(revn === undefined ? {} : { revn }) })}\n`,
          ),
        );
        return;
      }
    },
    async cancel() {
      for (const [, source] of sections) await source.lines.return(undefined);
    },
  });
}
