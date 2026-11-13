/**
 * Version snapshots in R2: one gzip JSON object per saved revision at
 * `files/<file-id>/snapshots/<revn padded to 12>.json.gz`.
 *
 * ```json
 * {"format":"drawpane.snapshot","version":1,"fileId":"…","revn":42,"at":1731500000000,"nodes":[…]}
 * ```
 */
import type { NodeRecord } from "@drawpane/model";

/** Unnamed versions older than this are deleted. Named ones stay until the file does. */
export const AUTOSAVE_RETENTION_MS = 30 * 24 * 60 * 60_000;

export function snapshotKey(fileId: string, revn: number): string {
  return `files/${fileId}/snapshots/${String(revn).padStart(12, "0")}.json.gz`;
}

export interface SnapshotFile {
  readonly format: "drawpane.snapshot";
  readonly version: 1;
  readonly fileId: string;
  readonly revn: number;
  readonly at: number;
  readonly nodes: readonly NodeRecord[];
}

/** Writes a snapshot and returns its compressed size in bytes. */
export async function writeSnapshot(
  bucket: R2Bucket,
  fileId: string,
  revn: number,
  at: number,
  nodes: readonly NodeRecord[],
): Promise<number> {
  // Built by hand so a large file is never one giant JSON.stringify call.
  const parts: string[] = [];
  for (const node of nodes) parts.push(JSON.stringify(node));
  const body = `{"format":"drawpane.snapshot","version":1,"fileId":${JSON.stringify(fileId)},"revn":${revn},"at":${at},"nodes":[${parts.join(",")}]}`;
  const gz = await new Response(
    new Blob([body]).stream().pipeThrough(new CompressionStream("gzip")),
  ).arrayBuffer();
  await bucket.put(snapshotKey(fileId, revn), gz, {
    httpMetadata: { contentType: "application/json", contentEncoding: "gzip" },
    customMetadata: { revn: String(revn) },
  });
  return gz.byteLength;
}

/** A snapshot's nodes, or null when it doesn't exist. */
export async function readSnapshot(bucket: R2Bucket, key: string): Promise<NodeRecord[] | null> {
  const object = await bucket.get(key);
  if (!object) return null;
  const text = await new Response(object.body.pipeThrough(new DecompressionStream("gzip"))).text();
  const file = JSON.parse(text) as SnapshotFile;
  if (file.format !== "drawpane.snapshot" || !Array.isArray(file.nodes)) return null;
  return file.nodes as NodeRecord[];
}
