/**
 * A saved snapshot's text (decision 0026), as R2 keeps it gzipped and the
 * API sends it to the browser.
 *
 * Version 2, written since files grew past what one JSON value holds well,
 * is a line of JSON per record: a header, then one node per line, so it is
 * written and read a page at a time.
 *
 * ```
 * {"format":"drawpane.snapshot","version":2,"fileId":"…","revn":42,"at":1731500000000,"copies":"compact"}
 * {"id":"…","parent":"…","key":"a0","type":"page","props":{…}}
 * …
 * ```
 *
 * Version 1 is one JSON object with every node in `nodes`; snapshots saved
 * before version 2 stay readable.
 *
 * `copies` says how its copies are stored (decision 0029): `compact` for a
 * file that stores override records; missing (every snapshot saved before
 * phase 4b) means materialized.
 */
import type { CopiesFormat } from "./convert";
import type { NodeRecord } from "./ops";

export const SNAPSHOT_FORMAT = "drawpane.snapshot";

export interface SnapshotHeader {
  readonly format: typeof SNAPSHOT_FORMAT;
  readonly version: 1 | 2;
  readonly fileId: string;
  readonly revn: number;
  readonly at: number;
  /** How its copies are stored; missing means materialized. */
  readonly copies?: CopiesFormat;
}

/** How a snapshot's copies are stored, from its header. */
export function snapshotCopies(header: { readonly copies?: unknown }): CopiesFormat {
  return header.copies === "compact" ? "compact" : "materialized";
}

/** A version 2 snapshot's first line, newline included. */
export function snapshotHeaderLine(
  fileId: string,
  revn: number,
  at: number,
  copies: CopiesFormat = "materialized",
): string {
  return `${JSON.stringify({
    format: SNAPSHOT_FORMAT,
    version: 2,
    fileId,
    revn,
    at,
    ...(copies === "compact" ? { copies } : {}),
  })}\n`;
}

function isHeader(value: unknown): value is SnapshotHeader {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { format?: unknown }).format === SNAPSHOT_FORMAT
  );
}

/**
 * A whole snapshot read from its text, either version; null when it isn't
 * one. For the browser, which holds the file it opens anyway; the server
 * reads snapshots a page at a time.
 */
export function parseSnapshot(
  text: string,
): { header: SnapshotHeader; nodes: NodeRecord[] } | null {
  const newline = text.indexOf("\n");
  if (newline >= 0) {
    let header: unknown;
    try {
      header = JSON.parse(text.slice(0, newline));
    } catch {
      header = null;
    }
    if (isHeader(header) && header.version === 2) {
      const nodes: NodeRecord[] = [];
      let start = newline + 1;
      while (start < text.length) {
        let end = text.indexOf("\n", start);
        if (end < 0) end = text.length;
        if (end > start) nodes.push(JSON.parse(text.slice(start, end)) as NodeRecord);
        start = end + 1;
      }
      return { header, nodes };
    }
  }
  let file: unknown;
  try {
    file = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isHeader(file) || !Array.isArray((file as { nodes?: unknown }).nodes)) return null;
  const { nodes, ...header } = file as SnapshotHeader & { nodes: NodeRecord[] };
  return { header: { ...header, version: 1 }, nodes };
}

/** What branch review compares (decision 0012), as the API streams it. */
export interface BranchReviewNodes {
  readonly base: NodeRecord[];
  readonly branch: NodeRecord[];
  readonly main: NodeRecord[];
  /** Main's revision when read. */
  readonly mainRevn: number;
  /** How each side's copies are stored (decision 0029). */
  readonly copies: {
    readonly base: CopiesFormat;
    readonly branch: CopiesFormat;
    readonly main: CopiesFormat;
  };
}

/**
 * Reads `GET /files/:id/branch/review`: lines of JSON, each file's nodes
 * after a line naming it (`{"review":"base"}`, `{"review":"branch","revn":3}`,
 * `{"review":"main","revn":9,"copies":"compact"}`).
 */
export function parseBranchReview(text: string): BranchReviewNodes {
  const out: Record<"base" | "branch" | "main", NodeRecord[]> = { base: [], branch: [], main: [] };
  const copies: Record<"base" | "branch" | "main", CopiesFormat> = {
    base: "materialized",
    branch: "materialized",
    main: "materialized",
  };
  let section: NodeRecord[] | null = null;
  let mainRevn = 0;
  let start = 0;
  while (start < text.length) {
    let end = text.indexOf("\n", start);
    if (end < 0) end = text.length;
    if (end > start) {
      const value = JSON.parse(text.slice(start, end)) as
        | NodeRecord
        | { review: string; revn?: number; copies?: string };
      if ("review" in value) {
        const name = value.review as keyof typeof out;
        section = out[name] ?? null;
        if (name in copies) copies[name] = snapshotCopies(value);
        if (name === "main") mainRevn = value.revn ?? 0;
      } else section?.push(value);
    }
    start = end + 1;
  }
  return { ...out, mainRevn, copies };
}
