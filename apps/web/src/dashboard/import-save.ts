/**
 * Saving an import (decision 0026): the converted nodes go to the server in
 * parts of about IMPORT_PART_BYTES of JSON (`POST /files/:id/imports`, a
 * request per part, then a commit), each node serialized once, as its part
 * is sent. The file shows nothing until the commit, and an import that fails
 * partway is given up, so the file stays empty. A file can take
 * MAX_IMPORT_NODES nodes in MAX_IMPORT_BYTES of JSON; more is refused in
 * words, with its size.
 */
import {
  IMPORT_PART_BYTES,
  MAX_IMPORT_BYTES,
  MAX_IMPORT_NODES,
  MAX_IMPORT_PART_BYTES,
  type NodeRecord,
  utf8Length,
} from "@drawpane/model";
import { api, JsonText } from "../api/client";

/**
 * Layers one Drawpane file takes, by measure: converted layers come to 410 to 510 bytes each on
 * the shadcn/ui Pro kit (vector paths, names and paints). At 560 bytes a layer, with some room,
 * the byte limit allows more than the node limit, so this is MAX_IMPORT_NODES: what importers aim
 * for before they know the bytes (the .fig reader's estimates are within about 10% of what it
 * builds).
 */
export const FILE_LAYERS = Math.min(MAX_IMPORT_NODES, Math.floor(MAX_IMPORT_BYTES / 560));

const mb = (bytes: number) => `${Math.ceil(bytes / (1024 * 1024))} MB`;

/** An import larger than one file takes; `bytes` and `nodes` say by how much. */
export class ImportTooLarge extends Error {
  constructor(
    readonly bytes: number,
    readonly nodes: number,
  ) {
    super(
      nodes > MAX_IMPORT_NODES
        ? `This comes to ${nodes.toLocaleString("en")} layers, more than one Drawpane file holds (${MAX_IMPORT_NODES.toLocaleString("en")}).`
        : `This comes to ${mb(bytes)}, more than one Drawpane file takes (${mb(MAX_IMPORT_BYTES)}).`,
    );
  }

  /** How much of it would fit, 0 to 1. */
  get fits(): number {
    return Math.min(MAX_IMPORT_BYTES / this.bytes, MAX_IMPORT_NODES / this.nodes, 1);
  }
}

/**
 * The nodes as request bodies of about IMPORT_PART_BYTES each, serialized as they're asked
 * for. `bytes` is their lines' UTF-8 bytes, as the server counts them (a character of CJK
 * text is three, an emoji four).
 */
function* partsOf(
  nodes: readonly NodeRecord[],
): Generator<{ body: string; count: number; bytes: number }> {
  let lines: string[] = [];
  let bytes = 0;
  for (const node of nodes) {
    const line = JSON.stringify(node);
    const size = utf8Length(line);
    if (lines.length > 0 && bytes + size > IMPORT_PART_BYTES) {
      yield { body: `{"nodes":[${lines.join(",")}]}`, count: lines.length, bytes };
      lines = [];
      bytes = 0;
    }
    lines.push(line);
    bytes += size;
  }
  if (lines.length > 0)
    yield { body: `{"nodes":[${lines.join(",")}]}`, count: lines.length, bytes };
}

/**
 * Fills a new file with an import's nodes, a part at a time. Throws
 * ImportTooLarge, before sending, when there are more nodes than a file
 * takes, or as soon as the JSON passes what it takes (the import is given
 * up). `onProgress` hears how many nodes have gone.
 */
export async function saveImport(
  fileId: string,
  nodes: readonly NodeRecord[],
  onProgress?: (sent: number, total: number) => void,
): Promise<void> {
  const file = `/files/${encodeURIComponent(fileId)}`;
  const parts = partsOf(nodes);
  // The first part is measured before anything is sent: most imports are one.
  let next = parts.next();
  const tooLarge = (bytes: number, sent: number) =>
    // Past the limit partway: the whole is estimated from what was measured.
    new ImportTooLarge(Math.round((bytes / Math.max(sent, 1)) * nodes.length), nodes.length);
  if (nodes.length > MAX_IMPORT_NODES) {
    const sample = next.done ? 0 : next.value.bytes / next.value.count;
    throw new ImportTooLarge(Math.round(sample * nodes.length), nodes.length);
  }
  if (!next.done && next.value.bytes > MAX_IMPORT_BYTES)
    throw tooLarge(next.value.bytes, next.value.count);

  const { importId } = await api.post<{ importId: string }>(`${file}/imports`, {});
  const imports = `${file}/imports/${encodeURIComponent(importId)}`;
  let sent = 0;
  let bytes = 0;
  try {
    for (; !next.done; next = parts.next()) {
      const part = next.value;
      bytes += part.bytes;
      if (bytes > MAX_IMPORT_BYTES) throw tooLarge(bytes, sent + part.count);
      if (new Blob([part.body]).size > MAX_IMPORT_PART_BYTES)
        throw new Error(
          `A layer is too large to import (${mb(part.bytes)} of data in one layer, ${mb(MAX_IMPORT_PART_BYTES)} at most).`,
        );
      await api.post(`${imports}/parts`, new JsonText(part.body));
      sent += part.count;
      onProgress?.(sent, nodes.length);
    }
    await api.post(`${imports}/commit`, {});
  } catch (error) {
    // Nothing of it shows: what was sent is thrown away.
    await api.delete(imports).catch(() => undefined);
    throw error;
  }
}
