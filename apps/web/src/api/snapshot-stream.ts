/**
 * Reading a snapshot (decision 0026) as it downloads: a large file is never
 * held as one string.
 */
import {
  isSnapshotHeader,
  type NodeRecord,
  parseSnapshot,
  type SnapshotHeader,
} from "@drawpane/model";

/**
 * A whole snapshot read from a stream of its text (gzip already undone),
 * either version; null when it isn't one. A version 2 snapshot is parsed a
 * line at a time as it arrives, so its text is never held whole (a browser
 * holds a string of at most about 512 MB); version 1 is one JSON value, read
 * whole.
 */
export async function readSnapshotStream(
  stream: ReadableStream<Uint8Array>,
): Promise<{ header: SnapshotHeader; nodes: NodeRecord[] } | null> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let header: SnapshotHeader | null = null;
  const nodes: NodeRecord[] = [];
  /** Text not yet parsed: the start of a line, or (not version 2) everything. */
  let rest = "";
  let whole = false;
  const lines = (text: string, final: boolean): void => {
    let start = 0;
    for (;;) {
      let end = text.indexOf("\n", start);
      if (end < 0) {
        if (!final) break;
        end = text.length;
      }
      if (header === null) {
        let first: unknown;
        try {
          first = JSON.parse(text.slice(start, end));
        } catch {
          first = null;
        }
        if (!isSnapshotHeader(first) || first.version !== 2) {
          // Version 1, or not a snapshot: read whole below.
          whole = true;
          rest = text;
          return;
        }
        header = first;
      } else if (end > start) nodes.push(JSON.parse(text.slice(start, end)) as NodeRecord);
      start = end + 1;
      if (start >= text.length) break;
    }
    rest = start >= text.length ? "" : text.slice(start);
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      const text = done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (whole) rest += text;
      else lines(rest + text, done);
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }
  if (whole) return parseSnapshot(rest);
  return header ? { header, nodes } : null;
}
