# 0029. Copies stored as their main plus what's overridden

- Status: proposed (phase 4 of decision 0027)
- Date: 2026-11-16
- Deciders: Ziyang (lead maintainer)

## Context

An instance is a frame (`instanceOf`) whose every layer is a stored node, `mirrors`-linked to its main's layer, and an edit to a main is written into every copy in the same transaction (decision 0010, `components.ts`: `propagationOps`, `syncInstanceOps`). That kept the renderer, layout and hit testing free of special cases, and made every client agree, because copies are just nodes. At the size of real kits it's what costs most (decision 0027):

- **Size.** The shadcn/ui Pro kit saves 101,000 layers in Figma and 503,000 in Drawpane: a copy is stored, synced, kept in undo and snapshotted layer by layer.
- **Editing a main** writes into all its copies: 7 s for a main with 13,174 copies at 500,000 layers, and a transaction the size of the copies.
- **Loading part of a file** (phase 3) is impossible: a client with one page loaded can't write a main edit into copies on pages it hasn't loaded.

What sync already does narrows the change. A copy's properties equal its main's except two kinds (`syncInstanceOps`): those marked overridden (`overrides`), and those layout decides for the copy (position in auto layout, hug and fill sizes, auto-sized text). Its structure always equals its main's: sync deletes layers the main doesn't have and recreates missing ones, and imports detach copies whose structure differs (`pinInstances`). So a copy holds nothing of its own except where it differs.

## Decision

**Store what differs; present everything.** The document stores instance roots and, for a copy layer that differs from its main's, an override record. The editor's `Doc` presents every copy layer as an ordinary node, built from its main and its override record, so the renderer, layout, hit testing, the layers panel, the inspector, export and the agent tools read copies exactly as now.

1. **Stored form.**
   - An instance root stays a stored frame with `instanceOf`, its root-local properties (position, constraints) and its own overrides, as now.
   - The layers inside a copy aren't stored. One that differs from its main's is stored as an **override record**: a node of a new type, `override`, under the instance's stored root, holding the `path` of main layer ids from the root's main down to the layer (through nested instances, whose own mains continue the path), the properties that differ and the `overrides` list.
   - Nested instances inside a main are part of the main and stored as now; nested instances inside a copy are copies like any other layer. Swapping one is an `instanceOf` override on its record, and its layers follow the swapped-in main from there.
2. **Ids.** A copy layer's id is derived: a stable hash of its instance root's id and its path, 16 base-62 characters (like library copies in decision 0010, so it fits the 64-character id rule however deep the nesting). Its override record has that same id. Every client, the server and any tool derive the same ids, so selections, comments, prototype links and operations can name a copy layer that isn't stored.
3. **The editor's view (`Doc`).**
   - `get`, `childIds`, `nodes`, `ancestors` and `pageOf` return copy layers built on demand and cached: the main layer's properties (itself possibly built, for mains containing copies), minus the link properties, plus `mirrors` (the main layer's id, as now), plus the record's properties. Parent and key come from the main's structure. Code that reads `mirrors`, `instanceOf` and `overrides` keeps working.
   - `apply` takes operations as now. A `set` on a copy layer becomes a `set` on its override record, created when it's the first. Creating, deleting or moving layers inside a copy is refused, as sync would have undone it. `apply` returns the operations as stored; those are what undo and sync record.
   - When a main or anything it uses changes, the copies built from it are dropped from the cache and rebuilt when next read. Change notifications name the copy layers affected, so the scene's cached matrices and bounds and the renderer's index (decision 0028) follow.
4. **Layout.** A copy's layout-decided properties equal its main's while nothing about its layout differs. When something does (the instance resized, a text overridden, a layer hidden), the editor lays the instance out as now and stores the values that differ in the override records, marked as laid out rather than overridden. When a main changes, the editing client lays out again only the instances of it whose layout differs (an index kept by `Doc`), and stores what changed. Every other copy follows its main with no operation at all. Layout stays computed once, by the client that made the change, and stored, so clients never disagree over text measurement.
5. **Editing a main** is the main's own operations, plus the relayout of the instances whose layout differs. `propagationOps` goes.
6. **The server** stores and validates what it's sent. An override record must sit under an instance root, its path must be well formed and its properties must pass their schemas; whether a property applies to the layer's type is checked where copies are built. Paths that read layers (MCP, thumbnails, export, search, library manifests) build copies with the same function the editor uses, moved to `@drawpane/model` so it runs anywhere, an instance at a time.
7. **Detaching** builds the instance's layers as real nodes with new ids, in one transaction, and deletes its override records, as an edit would.
8. **Imports** (Figma, `.fig`, Penpot, the kit store) write the stored form directly. `pinInstances` turns what a copy keeps as made into override records instead of `overrides` on full nodes.
9. **Existing files** are converted when their room next loads (a format version in the room's meta). A version named "Before compact copies" is saved first. Copy layers that equal what they'd be built as are dropped; the rest become override records with derived ids. References to old copy ids are rewritten from the conversion's map: comment pins (D1 `comments.node_id`), prototype links, reading orders and agent sessions. Older version snapshots and branch bases are converted when read, so restoring and merging keep working. Clients learn the format at hello, and an old client reloads.

## How it's verified

- **Equivalence.** For any file in today's model, building every copy from the converted file gives back the same document, ids mapped. This is checked on the corpus at several sizes, the `.fig` and Penpot fixtures, the kit store's kits and the converted shadcn/ui pages, then property-tested with generated documents and edits. Applying an edit before or after conversion must give the same result, so the converter, the view and `apply` are held to one meaning.
- **The fuzzer** (`pnpm fuzz`) runs its edit sequences against both models and compares.
- **The scale benchmark** (decision 0027): editing a main is drawn within 100 ms however many copies it has, the stored file is about five times smaller for a kit, and loading takes no longer than before.

## Consequences

- A kit stores, syncs, snapshots and keeps in undo about a fifth of what it did, and editing a main costs the same with 10 copies or 10,000.
- Page loading (phase 3) becomes possible: a page needs its own records and the mains its instances use, and copies follow their mains on any page without being written to.
- The editor still holds every copy layer in memory once built; building them lazily, page by page, is phase 3's.
- New failure modes to guard: a record whose path no longer exists in its main (the main lost the layer; the record stays, unused, as overridden values do now, and is dropped when the instance is reset or detached); two clients creating the same record at once (one transaction clashes and the editor retries, as with library copies); hash collisions (16 base-62 characters, about 95 bits; checked when a copy is built, and refused if two paths collide).
- This changes the file format. It needs the conversion, a protocol version and a release note, and it should ship behind a per-file flag until the equivalence suite and the fuzzer have run clean on every corpus.
