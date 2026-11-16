# 0029. Copies stored as their main plus what's overridden

- Status: accepted (phase 4 of decision 0027). Phase 4a (the model, the editor's view, the equivalence suite) and 4b (the room stores the compact form, sync, converting stored files) are built.
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

## Phase 4b: what was decided where this left room

Built in the room (`apps/worker/src/rooms/convert.ts`, `presented.ts`, `file-room.ts`), the model (`convert.ts`, the snapshot header, the protocol) and the editor's sync; the developer switch is gone.

- **Format per file.** The room's meta says how the file stores copies: `copies` is `compact` or `materialized`. A new file starts compact. A room from before 4b has no `copies` and is materialized; it converts when it next loads (decision point 9). `COMPACT_COPIES=off` (an environment variable, as `UPDATE_CHECK` is) stops conversions and makes new files and imports start materialized; a room keeps serving whatever form it holds.
- **Converting a stored file.**
  - The room saves a version named "Before compact copies" first (streamed, as any version), then converts in steps run by its alarm, about 2 seconds each; between steps it serves everyone as usual, and the file stays materialized and editable until the last step.
  - An instance at a time, in dependency order: the instances inside a main, and a main that is itself an instance, before the instances of that main (`InstanceConverter` in the model, the same steps `compact` takes in one pass). Only the instance and the mains it's built from are read.
  - Each instance is checked before it's kept: built from what was written, its copies must be its materialized layers exactly, ids renamed. One that isn't is **detached**, explicitly: its root and every layer are kept as stored layers, unlinked from the main (no `instanceOf`, `mirrors` or `overrides`), so it looks exactly as it did and no longer follows its main. That's what 4a's `compact` and the importers' `pinInstances` already do. It's logged with the reason, kept in the room's `copies_log`, and listed by `copiesFormat()`. We chose detaching over keeping materialized instances supported: the editor's compact view would need a third kind of instance, and every path would have to handle it, for files that, on every corpus we have, convert without one.
  - What it decides is written beside the file, not into it, each instance in its own storage transaction: the old copy ids and their derived ids (`conv_map`), the rewritten roots, override records and detached layers (`conv_rows`), what's settled and why (`conv_done`), what each instance was built from (`conv_deps`). A conversion cut short (the room evicted, a deploy) resumes from there. Each step reads these tables afresh, as a restarted room would.
  - Edits made during the conversion go to the materialized file as ever. Each marks, in its own storage transaction, the instances it may have changed: an instance it's in, and every instance built from a main or set it's in. Their decisions are dropped and they're converted again. When nothing is left, the file's top-level instances are listed again (edits may have made or removed some), and the decisions are applied in one storage transaction: copy layers deleted, rows written, ids held elsewhere renamed. Nobody sees a half-converted file.
  - Applying is one revision, not logged as operations, like an import: clients behind it load the file rather than catch up. An agent session's undo doesn't reach back past it (its operations were in the old form).
  - A step that throws stops the conversion for good (`conv_failed`), and the file stays materialized and working; the error is logged.
- **Undoing it.** With `COMPACT_COPIES=off`, restoring "Before compact copies" (or any version saved before the conversion) puts the file back as it was stored then, materialized: the file is replaced whole, in one storage transaction, everyone loads it again, and the state before is saved as a restore point first, as any restore does. Comment pins moved to derived ids stay there (the map is gone by then), so a pin on a copy shows at its saved place on the page. With conversion on, restoring that version converts it as it's read, which undoes edits but keeps the compact form.
- **Ids other things hold.** Every id-valued property was checked: `readingOrder`, prototype `reactions` (`navigate`, `overlay`, `swap-overlay` destinations) and `flows` (`start`) can name a copy layer; `instanceOf`, `mirrors`, `textStyle`, `bindings`, `variableModes`, `values` aliases and library links name mains, styles, variables and collections, which keep their ids. The three are renamed with the conversion's map: inside an instance as it converts (so the check compares like with like), and in every other node when the conversion is applied. Comment pins (D1 `comment_threads.node_id`) follow after it's applied, by the alarm until it's done; only then does the map go, and only then is everyone told to load the file again, so their comments come back pinned. Agent sessions hold no node ids in D1; the room's call ledger stops at the conversion (above).
- **Protocol (version 2).** `hello` lists the forms the client reads (`copies`); `welcome` says the file's (`copies`); a version 1 hello is a client from before 4b, which reads materialized only. A client that can't read the file's form gets an error and the socket closes with 4426; the editor reloads the page then (once a minute at most). The room records each socket's form at welcome and refuses its changes (`format`) once the file has converted, telling it to load the file again; an old client never gets a compact file to edit, so it can't write materialized copies into one. The editor's sync sends `Doc.lastStoredOps`, and undoes its pending edits exactly with the stored inverse when rebasing; a remote change is applied as stored. Pending edits that can't apply after the file changed form (a copy's old id) are dropped with a notice.
- **What the room checks in a compact file.** Override records as edits are (under an instance root, the id their path derives), as before; and, after each edit, that it left no stored layer under an instance of a live main, and that a main it deleted or unmade leaves no instance relying on it (one someone added at the same moment: the edit is refused, to be made again). A materialized file still refuses records.
- **Snapshots** say how they store copies in their header (`"copies":"compact"`; missing means materialized). A version, a branch's base or another file's nodes read into a compact room in the materialized form are converted as they're read (`compactTable`, the same steps, all at once on a table nobody edits), so restoring, merging and updating from main work across the conversion. A materialized room can't read compact snapshots; it says so (conversion off, or the file not converted yet).
- **Branches** copy their main's form. A branch made before its main converted has a materialized base; it's converted as it's read for review, merge and update. Ids are derived from root and path, so base, branch and main agree on every copy's id. Review in the browser compares stored forms, as main's room merges (so the changes and their keys are the same), converting a side that comes materialized, and names a record by the layer it's for.
- **Libraries.** Publishing hashes components as presented (a `PresentedReader` over the frozen copy, an instance at a time), so a hash still changes exactly when what a component draws does. It does change once, at conversion, for components that contain instances: the hash includes the ids of the layers a component draws, and its copies' ids change from random to derived. The first publish after a library file converts lists those components as changed, and taking the update changes nothing anyone sees. Keeping the old hashes would mean keeping every copy's old id for good (about 50 bytes a copy layer, more than the compact file itself for a kit). A file using a library loads the publish in its own form, so copies inserted from it are named as it names them (4a's `copyNamer`, compact on both sides).
- **Imports** are converted once, before or in the room: the browser converts with `compact` before it sends parts when the file says it's compact (about a fifth to upload) and says so at the commit (`copies: "compact"`); the room converts at the commit whatever comes materialized (an older page, any other client), with the same converter. It can't tell the two apart by looking: in the compact form an instance equal to its main has no layers and no records, which in the materialized form is an empty instance (and is detached, keeping its look). The first e2e run found exactly that, with a browser-converted Penpot file. A branch or a duplicate takes its source's form from the snapshot's header the same way. Records that arrive are checked at the commit as edits are.
- **Readers.** The MCP tools and library manifests read a compact file through `PresentedReader`: the model's `CopyView` over the room's table, an instance at a time, letting go of built copies past 20,000 between instances. A copy layer asked for by id is found from its record, or by building instances in turn until it's there (slow on a large file, bounded in memory). Agent tools run the headless editor in the file's form; their limit counts layers as presented, worked out in SQL. Thumbnails and exports are drawn in the browser from the presented document, so they're as before. Search (D1) indexes file names, not layers.

### Verified (4b)

- **The room's path, on the corpora.** Converting an instance at a time (`compactByInstance`, the same steps the room takes) gives exactly the stored form 4a's `compact` gives, with the same ids and no instance detached, on the generated kits (3,000 layers with two seeds, 20,000, 60,000), the `.fig` samples (pattern, tailwind-ecklf, medianova) and the Penpot fixtures (file-with-library, svg-attrs-camel-case, showcase) (`packages/corpus/test/compact.test.ts`), so 4a's equivalence holds for it: built back, each is the file it was, ids mapped.
- **Through a room** (`apps/worker/test/compact-copies.test.ts`, the Cloudflare test pool): a 3,000-layer kit stored materialized converts when its room's alarm runs, stores exactly what converting it in one go stores, and opened by a client presents the file as it was, ids mapped; the version saved first holds it as it was. With one instance a step and someone editing a main and its copies a few steps in, it converts the edited file, and the editor gets `resync` and has its stale edit refused (`format`). An instance with a layer its main lacks is detached, logged, and looks as it did. With conversion off it stays materialized and a version 1 client opens it; turned on it converts and a version 1 client is told to reload; turned off again, restoring the backup puts it back materialized, as it was. Restoring the backup with conversion on converts it as read; versions saved after say `compact`. A comment pin, a reading order and a prototype link on copy layers follow them to their derived ids. A new file is compact, and a materialized import into one is stored as converting it gives. A published library's hashes are those of the copies as presented, and stay the same publishing again. A branch made before its main converted merges into the converted main, base converted as read, changing only what the branch changed. The MCP tools find and read copy layers. A layer created inside an instance is refused. Imports take override records into compact files, checked as edits are, and refuse them in materialized ones (`imports.test.ts`).
- **Resuming and edits during it** (`apps/worker/test-node/convert.test.ts`, node:sqlite): a kit converted in more than ten steps, each reading the tables afresh as a restarted room would, gives what converting it whole gives; with a main and its copies edited between steps (dirty marking as the room does it), it gives the edited file converted.
- **Edits across the conversion** (`packages/editor/test/compact-equivalence.test.ts`): random edit sequences on a materialized document, then the room's conversion as a reloading client gets it, then more random edits on both, stay the same document after every step (the edits of 4a's property test: fills, texts, sizes, swaps, resets, detaches, new instances, layers added to and deleted from mains, undo and redo). The fixed seed and three random ones were clean.
- **Memory** (`pnpm --filter @drawpane/worker memory`, `test-node/convert-memory.test.ts`): a kit-shaped file of 504,506 layers stored materialized (71,429 button instances, each with a nested icon instance), converted in steps of about 2 seconds and applied, in Node with the V8 heap capped:

  | Heap cap | Steps | Converting | Longest step | Applying | Peak heap (16 MB before) |
  | --- | --- | --- | --- | --- | --- |
  | 128 MB | 21 | 42.9 s | 2.2 s | 2.3 s | 93 MB |
  | 64 MB | 21 | 42.6 s | 2.1 s | 2.1 s | 70 MB |

  It stores 87,717 nodes after (11,905 of them override records: the overridden labels and backgrounds), with nothing detached. As in decision 0026, a peak past the 64 MB cap is new space the cap doesn't cover. The memory is what a step's instances and their mains hold, not the file. Saving the version before it is decision 0026's (19 s at this size).
- **Measured** (the scale benchmark, `BENCH_COMPACT=1` against off, on this VM without a GPU; the file loaded as each kind of room sends it, so "off" is today's materialized load and "on" is the stored compact form, no conversion in the browser):

  | | 100,000 layers, off | on | 500,000 layers, off | on |
  | --- | --- | --- | --- | --- |
  | Stored (and sent) | 100,182 nodes, 32 MB | 10,982 nodes, 2 MB | 500,038 nodes, 162 MB | 51,043 nodes, 8 MB |
  | Load (one document reset) | 124 ms | 20 ms | 614 ms | 93 ms |
  | First frame of the largest page | 200 ms | 210 ms | 207 ms | 226 ms |
  | Largest page drawn exactly | 1,621 ms | 1,608 ms | 1,660 ms | 1,661 ms |
  | JS heap for the file | 45 MB | 53 MB | 172 MB | 204 MB |
  | Edit the most used main: the commit | 1,243 ms | 20 ms | 6,168 ms | 23 ms |
  | Edit the most used main: drawn | 1,359 ms | 172 ms | 6,346 ms | 246 ms |

  4a's client-side conversion took 5,870 ms to load 500,000 layers; loading the stored form takes 93 ms, faster than today's materialized 614 ms. The heap is higher because the editor caches every copy it builds (phase 3's to build them a page at a time). Panning and zooming are within this VM's noise of off.
- **End to end** (Playwright against a local Worker, the whole `chromium` project, `E2E_PORT=8860`): every new file is compact now, so the whole suite runs on compact files: 294 passed, 4 skipped, and two import specs failed, which counted what the browser sent (now the compact form); they compare what it sent as built now, and with the fix above the import, kit store, library and branch specs pass again (26 of 26).
- **Not verified:** a conversion on Cloudflare itself (CPU time and storage transaction sizes of a production Durable Object, measured here only in Node and local workerd); the kit store's Penpot kits and the converted shadcn/ui pages (not in the repository); an old client's tab open across the deploy (reasoned about: it's refused and told to reload, never served a compact file); several people editing while a large file converts, beyond the tests above.

## How it's verified

- **Equivalence.** For any file in today's model, building every copy from the converted file gives back the same document, ids mapped. This is checked on the corpus at several sizes, the `.fig` and Penpot fixtures, the kit store's kits and the converted shadcn/ui pages, then property-tested with generated documents and edits. Applying an edit before or after conversion must give the same result, so the converter, the view and `apply` are held to one meaning.
- **The fuzzer** (`pnpm fuzz`) runs its edit sequences against both models and compares.
- **The scale benchmark** (decision 0027): editing a main is drawn within 100 ms however many copies it has, the stored file is about five times smaller for a kit, and loading takes no longer than before.

## Consequences

- A kit stores, syncs, snapshots and keeps in undo about a fifth of what it did, and editing a main costs the same with 10 copies or 10,000.
- Page loading (phase 3) becomes possible: a page needs its own records and the mains its instances use, and copies follow their mains on any page without being written to.
- The editor still holds every copy layer in memory once built; building them lazily, page by page, is phase 3's.
- New failure modes to guard: a record whose path no longer exists in its main (the main lost the layer; the record stays, unused, as overridden values do now, and is dropped when the instance is reset or detached); two clients creating the same record at once (the second transaction clashes and is refused, and the editor says so; an edit that reaches a client after the other's landed is stored again as a change to that record when it rebases); hash collisions (16 base-62 characters, about 95 bits; checked when a copy is built, and refused if two paths collide).
- This changes the file format, per file: the room's meta says which, the protocol says it at hello, and snapshots say it in their header. Files convert the first time their room loads after the deploy, each after a version to undo it with; `COMPACT_COPIES=off` stops that and, with it, restoring that version undoes it.
- A library's components that contain instances show as changed once, at the first publish after it converts (see Libraries above).
- Pending edits a client made in the old form when its file converted are refused, with a notice; a client from before the deploy can't open a converted file until it reloads.
