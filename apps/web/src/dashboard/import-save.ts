/**
 * Saving an import: the converted nodes fill the new file in one request.
 * The server takes at most MAX_IMPORT_NODES nodes in MAX_IMPORT_BYTES of
 * JSON (it goes to the file's room in one call, validated on a copy). The body is
 * serialized once and measured here, so an import too large says so in
 * words, with its size, instead of a refusal partway through a long upload.
 */
import { MAX_IMPORT_BYTES, MAX_IMPORT_NODES, type NodeRecord } from "@drawpane/model";
import { api, JsonText } from "../api/client";

/**
 * Layers one Drawpane file takes, by measure: converted layers come to 410 to 510 bytes each on
 * the shadcn/ui Pro kit (vector paths, names and paints), so the byte limit comes long before the
 * node limit. At 560 bytes a layer, with some room, that's about 45,000 in 24 MB: what importers
 * aim for before they know the bytes (the .fig reader's estimates are within about 10% of what
 * it builds).
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

/** Fills a new file with an import's nodes; throws ImportTooLarge, before sending, when it won't fit. */
export async function saveImport(fileId: string, nodes: readonly NodeRecord[]): Promise<void> {
  const text = JSON.stringify({ nodes });
  const bytes = new Blob([text]).size;
  if (bytes > MAX_IMPORT_BYTES || nodes.length > MAX_IMPORT_NODES)
    throw new ImportTooLarge(bytes, nodes.length);
  await api.post(`/files/${encodeURIComponent(fileId)}/import`, new JsonText(text));
}
