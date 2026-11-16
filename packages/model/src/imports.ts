/**
 * What one import can bring into a file: the server's limit on filling a
 * new file (`POST /files/:id/import`), which importers check before they
 * read and convert more than it would take.
 */

/** Nodes one import saves at most (a file's room holds its document in memory). */
export const MAX_IMPORT_NODES = 200_000;

/**
 * The most JSON one import sends (`{"nodes": [...]}`), in bytes. The Worker hands the nodes to the
 * file's room over RPC, which Cloudflare limits to 32 MiB, and the room holds them in memory
 * twice while it validates (about 80 MB for a 22.5 MB import, of the 128 MB a Durable Object
 * has), so this leaves room under both.
 */
export const MAX_IMPORT_BYTES = 24 * 1024 * 1024;
