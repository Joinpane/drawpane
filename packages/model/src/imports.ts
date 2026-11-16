/**
 * What one import can bring into a file, and how it travels
 * (docs/decisions/0026-large-files-on-the-server.md): the browser sends the nodes in
 * parts of a few MB (`POST /files/:id/imports`, then `/parts`, then
 * `/commit`). The file's room checks each part as it comes, keeps it aside
 * in SQLite, and checks the whole and fills the file in one storage
 * transaction at the commit, so no part of the server ever holds the whole
 * import, and nobody sees half of one.
 */

/**
 * Nodes one import saves at most. The room never holds them all at once, so
 * this is about what a browser can convert and send, and what the room's
 * commit gets through in one request's time.
 */
export const MAX_IMPORT_NODES = 1_000_000;

/**
 * The most JSON one import sends in all, in bytes: a million layers at the
 * 410 to 510 bytes converted layers measure on the shadcn/ui Pro kit, with
 * room to spare.
 */
export const MAX_IMPORT_BYTES = 640 * 1024 * 1024;

/**
 * About how much JSON the browser sends in one part. Each goes to the room
 * in one RPC call (Cloudflare caps one at 32 MiB), and the Worker and room
 * hold a part a few times over while they parse and check it.
 */
export const IMPORT_PART_BYTES = 4 * 1024 * 1024;

/** The most one part may be, in bytes: a part of one huge node gets through up to here. */
export const MAX_IMPORT_PART_BYTES = 12 * 1024 * 1024;

/** How long an import begun and not committed is kept before it's thrown away. */
export const IMPORT_TTL_MS = 60 * 60_000;
