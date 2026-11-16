# 0026. Large files on the server: imports in parts, snapshots as lines, differences in SQL

- Status: accepted
- Date: 2026-11-16
- Deciders: Ziyang (lead maintainer)

## Context

Real UI kits are 100,000 to 1,000,000 layers. The shadcn/ui Pro kit is about 503,000, some 225 MB of node JSON at 410 to 510 bytes a layer. Cloudflare gives a Worker or Durable Object 128 MB of memory per isolate, 32 MiB per RPC argument or return value, a 100 MB request body, and a CPU-time budget per request.

The FileRoom already kept a file's nodes in SQLite, one row each, and sent them to the editor in chunks. But every path that needed the whole file gathered it in memory, or into one message:

- **Import** was one request and one RPC call holding every node, checked on an in-memory copy (`MemoryStore`): capped at 24 MB, about 45,000 layers (decision 0025).
- **Versions** built one JSON string of the file, and reading one parsed it whole. **Restore** diffed two whole files in memory.
- **Branches** sent the main file over RPC (`snapshot()`) to make one, and review, merge and update read base, branch and main whole.
- **Libraries** and **MCP** read every node (`allNodes()`) to publish a manifest or answer a search. **Duplicating** a file did too.

## Decision

Nothing on the server holds a whole file, or sends one in one message. Each path works a page of rows (1,000) at a time, against tables in the room's own SQLite: a copy of the file frozen at one revision, a version read back from R2, another file's nodes, an import arriving in parts (`rooms/node-tables.ts`). Each has the columns of `nodes`, so rows move between them in SQL without passing through JavaScript.

1. **Imports come in parts.** `POST /files/:id/imports` begins one (only into an empty file), `POST …/imports/:importId/parts` sends about 4 MB of nodes at a time (12 MB at most), `POST …/commit` finishes it, `DELETE …/imports/:importId` gives up.
   - Each part's nodes are checked on their own as they arrive (id, order key, every property, `checkNode` in `@drawpane/model`) and kept in a table beside the file's, all or none of the part. A node sent twice is refused.
   - The commit checks how they fit together, in SQL: a page under the root, no id the file already has, every parent there and allowed to hold its child, and every node reachable from the root within 128 levels (levels are numbered a level at a time; what's left is inside itself or too deep). Then the file is filled from the table, and its starting page removed, in one storage transaction. Until then the file is as it was, and anyone opening it sees its empty page; a failed commit leaves it so.
   - An import is one revision, not logged as operations. Clients behind it load the file rather than catch up. An import nobody commits is thrown away after an hour, or when another begins.
   - One import takes at most 1,000,000 nodes in 640 MB of JSON (`MAX_IMPORT_NODES`, `MAX_IMPORT_BYTES`). The browser's `saveImport` sends the parts, serializing each node once as its part goes; the .fig dialog aims for 1,000,000 estimated layers (`FILE_LAYERS`) and lists pages to choose only beyond that. `POST /files/:id/import` stays, for an import of one part.
2. **Snapshots are lines of JSON, written and read as streams.** Version 2 is a header line, then a node per line, gzipped. A version is written from a copy of the nodes made in SQL at one revision (so edits while it uploads don't show), read a page at a time, gzipped as a stream, and uploaded to R2 in 8 MiB parts (a multipart upload; one put when it's smaller). Reading streams too. Version 1 snapshots (one JSON object) stay readable, as a stream: a small scanner hands back each node's text from the `nodes` array without parsing the whole. The API sends a version's stored bytes as they are; the browser reads either (`parseSnapshot`).
3. **Restore works in SQL.** The version is read into a table, its levels numbered, and compared with the file a page at a time, top-down, with the same per-node comparison the editor's restore uses (`restoreNodeOps`); then the topmost of the file's nodes the version lacks are deleted. A node byte-for-byte the same is skipped without parsing. The operations are committed in chunks of about 1 MB, each a logged revision, all in one storage transaction; everyone sees them arrive, or is asked to load the file again when they're more than a broadcast carries.
4. **Branches stream room to room.** Making one: main's room writes its base to R2 from a frozen copy, and the branch's room fills itself from that. Review: the Worker streams base, branch and main as lines of JSON, each after a line naming it. Merge: main's room reads the base from R2 and the branch as a snapshot stream from the branch's room (Workers RPC carries streams), each into a table, counts the changes and the conflicts nobody decided, and applies the chosen ones with the model's per-node comparisons (`addedChange`, `changedFields`, `editedSince`), in the order `mergeOps` gives: added parents first, changed fields, deletions. It all lands in one storage transaction, or none of it does. Updating from main is the same in the branch's room, which then writes main as read as its new base.
5. **Libraries and MCP ask the room.** Publishing freezes a copy, reads what it offers from that copy through a reader that fetches rows as the hashing asks (keeping at most 10,000) and finds components by a query, and saves the version from the same copy. The MCP read tools are answered by the room from SQLite the same way. Duplicating a file streams it room to room.
6. **Deleting without reading.** A delete nobody needs back (a restore, a merge, an ordinary edit) removes the subtree in one SQL statement instead of collecting it to undo with (`removeTree`).
7. **Agents keep a size limit.** The headless editor (decision 0021) holds the whole file in memory (its document alone measured 34 MB at 50,000 layers, about 700 bytes each, and building it reads them all first), so agent tools refuse files of more than 50,000 layers (`AGENT_MAX_NODES`). The read tools work at any size.

## Consequences

- **Measured** on a file of 505,010 layers (213 MB of JSON, 78 MB gzipped as a version 2 snapshot), running the room's code in Node 26 on this VM with the V8 heap capped (`pnpm --filter @drawpane/worker memory`). Every path finishes with the heap capped at 128 MB, and again at 64 MB. Peak heap is sampled as the path runs, so it includes garbage not yet collected; "buffers" are ArrayBuffers (gzip and R2 parts), which count toward a Durable Object's memory too; RSS includes SQLite's page cache and the test runner. Times at the 128 MB cap:

  | Path | Time | Peak heap (128 MB cap) | Peak heap (64 MB cap) | Peak buffers |
  | --- | --- | --- | --- | --- |
  | Import: 4 MB parts parsed and checked, then the commit's checks and fill | 40 s | 95 MB | 70 MB | 0 MB |
  | Save a version (frozen copy, gzip stream, 8 MiB R2 parts) | 19 s | 32 MB | 16 MB | 30 MB |
  | Restore a version (read back into a table, compared in SQL) | 55 s | 91 MB | 67 MB | 12 MB |
  | Restore a version 1 snapshot (read as a stream) | 44 s | 87 MB | 58 MB | 11 MB |
  | Make a branch (main's base written to R2) | 16 s | 39 MB | 17 MB | 54 MB |
  | Merge (base from R2, branch streamed in, compared in SQL) | 68 s | 87 MB | 58 MB | 11 MB |
  | Review (three files streamed as lines) | 6 s | 65 MB | 25 MB | 34 MB |
  | Duplicate (room to room stream) | 26 s | 52 MB | 25 MB | 10 MB |
  | Library manifest (200 components found by query and hashed) | 7 s | 56 MB | 56 MB | 0 MB |
  | MCP `find_nodes` over every layer | 11 s | 100 MB | 72 MB | 0 MB |

  The heap before each path was 15 to 17 MB (the runner, zod, the model). Before this, the same file couldn't be imported at all (24 MB per import), a version of it would have been one 213 MB string, and restoring or merging it held two or three copies as objects.
- The heaviest calls take tens of seconds of CPU here, past the 30 seconds a request gets by default, so the Worker's `limits.cpu_ms` is raised to 300,000 (five minutes, the most Cloudflare allows; it's billed as used). The installer carries it, as it does the rest of `wrangler.jsonc`.

- Every path stores the file once more while it works (a frozen copy, a version read back), as SQLite rows, dropped when done or, if a reader lets go, by the alarm within the hour. A room storing 225 MB of nodes needs that again for a while.
- The memory check runs the room's own code in Node (`pnpm --filter @drawpane/worker memory`, `test-node/`), against node:sqlite and a file-backed R2, because local workerd doesn't enforce 128 MB. It isn't part of `pnpm test`; `test/large-files.test.ts` runs the same paths through the real Worker and Durable Objects at 121,204 layers (40 MB of JSON), every run.
- Not measured on Cloudflare: whether a storage transaction of 500,000 inserted rows, or a commit's CPU time, stays inside a production Durable Object's limits. The import's commit and a large merge are the heaviest single calls.
- The browser still holds whole files where it shows them: opening a file, previewing a version, reviewing a branch.
