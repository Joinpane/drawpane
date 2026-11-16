# 0029. Copies stored as their main plus what's overridden

- Status: proposed (phase 4 of decision 0027). Phase 4a (the model, the editor's view behind a flag, the equivalence suite) is built; 4b (the room, sync, converting stored files) is next.
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
7. **Detaching** builds the instance's layers as real nodes, in one transaction, and deletes its override records, as an edit would. (Phase 4a keeps their ids: see below.)
8. **Imports** (Figma, `.fig`, Penpot, the kit store) write the stored form directly. `pinInstances` turns what a copy keeps as made into override records instead of `overrides` on full nodes.
9. **Existing files** are converted when their room next loads (a format version in the room's meta). A version named "Before compact copies" is saved first. Copy layers that equal what they'd be built as are dropped; the rest become override records with derived ids. References to old copy ids are rewritten from the conversion's map: comment pins (D1 `comments.node_id`), prototype links, reading orders and agent sessions. Older version snapshots and branch bases are converted when read, so restoring and merging keep working. Clients learn the format at hello, and an old client reloads.

## Phase 4a: what was decided where this left room

Built in `@drawpane/model` (`copies.ts`) and the editor (`compact-copies.ts`, `Doc`), proven against today's model, and not yet stored or synced.

- **Hash.** `copyId(root, path)` is chained SHA-256 (FIPS 180-4, carried in the model as `sha256` because Web Crypto's digest is asynchronous): from the instance root's id, each step is `base62(sha256(parentId + "/" + element))`, 16 characters taken from the digest's bytes under 248 (`byte % 62`, without bias), about 95 bits. Each step is a single SHA-256 block, about 1.5 µs. `copyChildId(parent, element)` is one step. A collision with a built copy or a stored layer is refused when the copy is built.
- **Paths.** An element is the id of the main's layer as the main presents it: the copy's `mirrors`. So a copy layer's id is `copyChildId(its parent's id, its mirrors)`, and through a nested instance the path goes on with that instance's copy ids in the main (or a swapped-in main's layer ids). Stored ids would have been shorter to explain, but a copy's id would change whenever what it copies becomes stored: detaching a nested instance inside a main, or deleting a main whose instances keep their layers. With presented ids those keep the same ids, and so do every override record and selection that names them.
- **Stored form.**
  - A record sits under its instance's stored root with one order key (`OVERRIDE_KEY`), since records aren't layers.
  - `applyOp` refuses three things: a record whose id isn't the one its path derives, a record that is moved, and clearing `instanceOf` on a root that still has records.
  - A record holds every value that differs exactly from its main's (an explicit default included, because the editor compares values). It also holds every overridden value, so the copy stays put when the main changes, and `unset`, the properties it lacks where its main's layer has them (a stored value can't be null).
  - An instance root stores its root-local properties (`x`, `y`, `rotation`, flips, `lockAspect`, `positioning`, constraints, `instanceOf`) and whatever else differs, by the same rule.
- **Laid out vs overridden.** No marker is needed: a value in a record whose property isn't in its `overrides` is laid out. Layout and other derived writes go through the same translation, so a laid-out value equal to the main's is dropped, and the copy follows its main again.
- **Swapped nested instances.** A record's `instanceOf` swaps its copy. The copy is then that main's instance, placed where its source is: root-local values from the source, the rest from the swapped-in main, as an instance root has them. Its layers are the swapped-in main's.
- **The flag.** `new Doc({ compactCopies: true })`, or `setCompactCopiesDefault(true)` for every new document. The web app turns it on from `localStorage` `drawpane:compact-copies`, as a developer switch until the room stores the form. With the flag on:
  - `Doc.reset` converts the materialized snapshot it gets (`resetIds` says how copies were renamed), and `resetStored` takes the stored form as it is.
  - `apply` takes operations on presented layers and returns their inverse in the same terms, so the history and undo need nothing new. The stored operations it made are `lastStoredOps`, which is what phase 4b sends to the room.
  - `applyStored` applies stored operations as they are.
- **Operations on copies.**
  - A `set` rewrites the record so it holds exactly what then differs.
  - Creating a layer inside an instance is accepted only when it matches a copy the instance presents (same `mirrors` and type). It's absorbed into that copy's record, which is how materialized copies come in: `instantiateOps` from an older client, a paste, a library insert.
  - Deleting or moving a copy layer is refused.
  - Unlinking a root (detach, a deleted main, a main that stops being one) makes its copies stored layers with the same ids. Relinking it absorbs them back into records, which is how undo restores both.
- **Editing a main.** `propagationOps` writes nothing with the flag on. Relayout covers only two kinds of instance:
  - an instance whose layout differs from its main's (an index kept by `Doc`: it stores a value a layout reads), when its main's layout inside may have changed;
  - an instance whose main changed size, so its parent lays it out again.
  A main holding instances of a resized main counts as changed inside, however deep. Changes no layout reads (fills, names, a child of a frame without auto layout) lay out nothing.
- **Fixed in today's model too.** The equivalence tests found these:
  - Swapping a nested instance now marks `instanceOf` overridden, and its outer instance's sync keeps the swap and follows the swapped-in main. Before, the next sync reverted it, or kept the old main's name and size.
  - Reset and swap sync a nested instance through its outermost instance. Syncing it against its own main had rebuilt its layers off the chain of copies.
  - An edit to a main reaches the copies swapped to it.

### Verified

- **Equivalence on corpora** (`packages/corpus/test/compact.test.ts`): converting, then building every copy, gives the file back with ids mapped, exactly. The stored form passes the room's checks, and it is canonical (building and converting again gives it back). This holds for:
  - generated kits of 3,000 (two seeds), 20,000 and 60,000 layers;
  - the `.fig` samples (pattern, tailwind-ecklf, medianova), converted and pinned as imports are;
  - the Penpot fixtures (file-with-library, svg-attrs-camel-case, showcase).

  A 60,000-layer kit stores 6,548 nodes instead of 60,275 (19.4 MB of JSON to 1.2 MB).
- **The same kit both ways:** a kit generated through the compact view is the same tree as the one generated today, at 3,000 and 20,000 layers.
- **Edits** (`packages/editor/test/compact-equivalence.test.ts`): random sequences, applied to a document as today and to the same document converted, give the same document after every step, compared layer by layer. The edits are fills, opacity, hiding, texts, font sizes, gaps, widths, swaps (top-level and nested), resets, detaches, new instances, adding and deleting layers in mains, undo and redo. Five runs of 400 sequences each, with random seeds, were clean. They differ, on purpose, in two places:
  - after a swap between mains laid out differently, today's model first lays the new layers out by the old main's settings;
  - a hidden layer in an auto layout keeps where it last was in today's model, and takes its main's place in a compact copy (neither is drawn).
- **The editor suite** runs a second time with the flag on (`pnpm test`), the monkey fuzzer included, as does `pnpm fuzz`. The editor's view has its own tests: edit a copy's text, edit a main and read a copy, swap a nested instance, reset, detach, delete a main, undo and redo.
- **Measured** (the scale benchmark of decision 0027, `BENCH_COMPACT=1` against off, on this VM, Chromium without a GPU, as the generated kit opens):

  | | 100,000 layers, off | on | 500,000 layers, off | on |
  | --- | --- | --- | --- | --- |
  | Stored | 100,182 nodes, 32 MB | 10,982 nodes, 2 MB | 500,038 nodes, 162 MB | 51,043 nodes, 8 MB |
  | Load (one document reset) | 148 ms | 1,584 ms | 833 ms | 5,870 ms |
  | First frame of the largest page | 1,000 ms | 1,166 ms | 1,041 ms | 1,227 ms |
  | JS heap for the file | 42 MB | 54 MB | 169 MB | 220 MB |
  | Edit the most used main: the commit | 1,292 ms | 9 ms | 6,820 ms | 30 ms |
  | Edit the most used main: drawn | 2,142 ms | 767 ms | 7,653 ms | 840 ms |

  The edit is a fill on a main with 2,607 copies (100,000) and 13,174 (500,000), as in decision 0027. Its commit no longer grows with the copies. What's left until it's drawn is the renderer repainting the whole page fitted to the window, the same in both models: phase 2's to bring under 100 ms. Panning and zooming are within this VM's noise of off.

  Loading is slower and holds more because, in 4a, the client converts the materialized snapshot it gets (about 1.5 s per 100,000 layers headless) and caches every copy it builds. Converting moves to the room in 4b, which sends the stored form; building copies a page at a time is phase 3's.

  Edits a layout reads cost what the layouts they change cost. Headless, at 500,000 layers, a main's text took 15,111 ms before and 6,312 ms now; its gap 14,741 and 6,211; a layer's width 22,775 and 14,114. A main that changes size moves its instances and what's beside them on every screen it's on, and those positions are stored outside the copies, so every such screen is laid out again (the time is the layout engine's). Changes no layout reads (a fill, a layer's opacity) take 16 ms and 13 ms.
- **Not verified yet:** the kit store's Penpot kits (`$PENPOT_KITS`, not in the repository) and the converted shadcn/ui pages; collaboration, which needs 4b.

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
