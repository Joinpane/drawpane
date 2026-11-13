# 0001. Build Drawpane from scratch in TypeScript instead of forking Penpot

- Status: accepted
- Date: 2026-11-12
- Deciders: Ziyang (lead maintainer)
- Supersedes: the "hard fork of Penpot" plan in PRD v0.1

## Context

PRD v0.1 planned Drawpane as a hard fork of Penpot. It would keep Penpot's ClojureScript `common` (file model, changes, validation, migrations) and its WASM renderer, run `common` inside the FileRoom Durable Object, and put a new React interface on top. The roadmap made this the M0 go/no-go gate: "`common` validates inside workerd".

We ran that spike against Penpot `2.19.1`. We compiled `common` to ESM with shadow-cljs (advanced optimizations) and loaded it in a SQLite-backed Durable Object under `wrangler dev`.

### What the spike showed

It works, with one fix. `common` seeds its UUID generator with `crypto.getRandomValues` at module load, and workerd forbids that in global scope. Importing the module lazily inside the request handler solves it. After that, the Durable Object could create a file, apply change batches, validate them and reject a malformed change.

The cost is the problem. We measured in Node 26 (same V8 as workerd) on the same build:

| Measurement | Result |
| --- | --- |
| Bundle size | 1.0 MB minified |
| Heap after loading the module | 60 MB (Malli schemas compiled eagerly at load) |
| Heap once shape and change validators are compiled | 74–76 MB, before any file is open |
| Extra heap for one page with 10,000 rectangles | +37 MB |
| Whole-page referential-integrity check, 10k-shape page | 120 ms per save |
| Applying 1 change / 10 changes to a 10k-shape page | 5 ms / 45 ms |
| Decode and encode a 10k-shape file (7.8 MB transit) | 860 ms / 780 ms |

A Durable Object isolate has 128 MB, and several objects of the same class can share one isolate. Our own budget is 96 MB. With 75 MB taken before any file is open, one large file fills the isolate. Making schema compilation lazy only delays the cost: the validators compile on the first save. Getting under budget would mean carrying patches to `common`, which the fork plan ruled out in order to keep upstream merges cheap.

Other costs of the fork:

- Two languages and two data models: Clojure and ClojureScript with a JVM build toolchain, next to the TypeScript and React UI chosen for `@drawpane/ui`.
- Penpot's editor data layer is written for its own UI (rumext, potok streams). Putting a React shell over it needs a large adapter that has to follow upstream churn.
- Penpot's full file model holds every shape decoded in memory as persistent maps (about 3.7 KB per rectangle). That fits a JVM server, not a 128 MB isolate.

## Decision

Build Drawpane from scratch in TypeScript, using Penpot as a reference rather than a dependency.

- **One language.** TypeScript (strict) in the browser, the Worker and the Durable Objects. Rust compiled to WASM is allowed later for measured hot paths only.
- **Our own document model**, designed for Durable Objects. It is a flat map of nodes keyed by id. Child order uses fractional index keys, and edits are property-level operations ordered by the FileRoom. The FileRoom stores one SQLite row per node and writes only the rows a batch touches. It never needs to hold a whole file in memory.
- **Penpot stays useful.** We study its layout engine, its geometry and its file format. We keep `.penpot` import as a converter into our model, so "you own your work" and the migration path still hold.
- **License: MPL-2.0**, as planned. No Penpot code is copied, so there is no upstream copyright to carry. If we ever port a Penpot file, it keeps its MPL header and the copyright notice, and we add a `NOTICE` entry.

## Consequences

Good:

- Memory per room depends on the size of each edit, not the size of the file. The isolate keeps headroom for many rooms.
- One toolchain (pnpm, TypeScript, Vite, Vitest, Wrangler) shortens clone-to-deploy and contributor onboarding.
- The model is shaped for our features (branches, history scrubber, agents with typed operations) from day one.

Costs and risks:

- We rebuild editor capability Penpot already has: paths and booleans, text layout, flex and grid layout, components and overrides. Mitigation: a tight v0.1 scope, Penpot's tests and algorithms as a reference, and property-based tests for the model.
- `.penpot` import is now a converter we must maintain against Penpot's format. Mitigation: a corpus-based visual-diff test, as the PRD already plans.
- Penpot plugin compatibility becomes a shim over our API (best effort), not full compatibility for free.
- The "upstream sync" work in the PRD goes away, along with the security and performance fixes we would have inherited from Penpot.
