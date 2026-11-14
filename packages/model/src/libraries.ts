/**
 * Team libraries (docs/decisions/0010-team-libraries.md): what a publish
 * holds, shared by the API and the editor.
 */
import { z } from "zod";
import type { VersionPerson } from "./history";
import { ID_PATTERN } from "./ids";

/** A content hash of everything a published component draws: what tells a change. */
export const ASSET_HASH = /^[0-9a-f]{16}$/;

/** A component (or set of variants) a publish offers. */
export const LibraryAsset = z.object({
  /** Its main component's (or set's) id in the library file. */
  id: z.string().regex(ID_PATTERN),
  name: z.string().max(256),
  description: z.string().max(2000),
  /** A set of variants, inserted as its first variant. */
  set: z.boolean(),
  hash: z.string().regex(ASSET_HASH),
});
export type LibraryAsset = z.infer<typeof LibraryAsset>;

/** At most this many components per publish. */
export const MAX_LIBRARY_ASSETS = 2000;

export const LibraryAssets = z.array(LibraryAsset).max(MAX_LIBRARY_ASSETS);

/** One publish of a library: its version of the file, and what it offers. */
export interface LibraryPublish {
  readonly id: string;
  /** The library's file, and its name now. */
  readonly fileId: string;
  readonly fileName: string;
  /** The version holding the published snapshot, and its revision. */
  readonly versionId: string;
  readonly revn: number;
  readonly publishedAt: number;
  readonly publishedBy: VersionPerson | null;
  /** What changed, as its publisher put it. */
  readonly description: string | null;
  readonly assets: readonly LibraryAsset[];
}
