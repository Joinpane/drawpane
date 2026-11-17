# 0033. The agent runner: agent tools run outside the file room

- Status: proposed
- Date: 2026-11-17
- Deciders: Ziyang (lead maintainer)

## Context

Decision 0021 put the headless engine inside the FileRoom: `AgentEngine`, the room's warm `Editor` (`#warmEditor`), the HarfBuzz measurer, text layout, the SVG export and resvg (decision 0023). It was the simplest place to put it. The engine works on the file exactly as it stands when it commits, with no await between running the tool and committing (`runAgentTool`).

The cost is that the room's 128 MB is shared by everyone editing the file and by whatever an agent's call happens to allocate. When an isolate runs out of memory, the room resets and every socket on the file drops. SQLite keeps the data safe, but the people editing are thrown out mid-edit, and an agent can do this repeatedly with ordinary calls. WebAssembly linear memory counts toward the same 128 MB, but no JavaScript heap meter can see it, and it never shrinks.

Each review of #173 found more heavy paths, each reachable from a small, legal file (reproductions in `.refs/pr173-review2/`, not in the repo):

| Path | File | Grew to | What the room's meter counted |
| --- | --- | --- | --- |
| resvg compositing surfaces | 22 layers: 20 nested 2048 px frames at 90% opacity | 375.4 MiB of WASM (666.6 MiB at scale 1) | 10,105 bytes |
| HarfBuzz faces | 800 texts in Inter at weights 100 to 899 | 172.3 MiB of WASM before a tool runs | 265,327 bytes |
| Text layout | 4 texts of 200,000 characters, `set_props` fontSize 17 | JS heap abort at 128 MiB | 801,907 bytes |
| SVG export | 10,000 rectangles with angular gradients (180 wedges each) | JS heap abort at 128 MiB | 8,199,417 bytes |

#173 meters the document as it's built (`agent-admission.ts`, 48 MB `AGENT_MAX_HELD`). None of these four paths goes through the document meter. Metering every component that might allocate, inside the one isolate whose failure costs the most, is a race we keep losing. This record moves the work out instead.

## Evidence

### 1. Isolation on Cloudflare

| Question | Answer | Source |
| --- | --- | --- |
| Memory per isolate | 128 MB, "per-isolate, not per-invocation", JS heap and WebAssembly together. An isolate serves many concurrent requests that share it. Past the limit, in-flight requests finish and later ones get a new isolate. | [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) |
| Do Durable Objects share an isolate? | Instances of **one class** may: "A single isolate can host multiple Durable Objects of the same class", "they all share that isolate's memory". Each is still billed as if it had all 128 MB. | [DO metrics](https://developers.cloudflare.com/durable-objects/observability/metrics-and-analytics/), [DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) |
| Classes in the same script? | **Not documented either way.** The docs say only that one class's instances share. A second class in our script may well share the room's isolate, so it doesn't count as isolation. | as above |
| A separate script behind a service binding or RPC? | Its own isolates: "Each isolate's memory is completely isolated", and an isolate runs one script's code. Both "run on the same thread of the same Cloudflare server" by default, with "zero overhead". Each script has its own `limits` in its own config. | [How Workers works](https://developers.cloudflare.com/workers/reference/how-workers-works/), [Service bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/) |
| CPU | Free plan: 10 ms per request. Paid: 30 s by default, up to 5 minutes with `limits.cpu_ms: 300000`, which this Worker already sets (decision 0026). SQLite Durable Objects: the same 30 s default, configurable to 5 minutes, per invocation (request, WebSocket message, alarm). | [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/) |
| Other limits | 32 MiB per RPC argument or result (decision 0026). Script size 64 MiB uncompressed. 100 Workers per account on Free, 500 on Paid. 32 Worker invocations per request. | [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [Service bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/) |
| What a caller sees | A DO that exceeds memory or CPU throws in the caller with `.remote` set. A broken stub fails every later call, so the caller makes a new one. `.overloaded` errors shouldn't be retried. | [DO error handling](https://developers.cloudflare.com/durable-objects/best-practices/error-handling/) |
| Does the room stall while it awaits another service? | No. Input gates close only while storage operations are in flight. While the room awaits an RPC, it keeps delivering socket messages. | [Durable Objects: easy, fast, correct](https://blog.cloudflare.com/durable-objects-easy-fast-correct-choose-three/) |

**Options with more memory, or a fresh isolate:**

| Option | Memory | Plan and cost | For a self-hosted install |
| --- | --- | --- | --- |
| [Containers](https://developers.cloudflare.com/containers/) | 256 MiB (`lite`) to 12 GiB (`standard-4`) | Paid only. 25 GiB-h of memory and 375 vCPU-min included a month, then $0.0000025 per GiB-s and $0.000020 per vCPU-s ([pricing](https://developers.cloudflare.com/containers/pricing/)). 50 GB of image storage per account ([limits](https://developers.cloudflare.com/containers/platform-details/limits/)). | Needs an image for each release, built with Docker at deploy or pulled from a registry. The [FAQ](https://developers.cloudflare.com/containers/faq/) puts cold starts at 1 to 3 s and first provisioning at "several minutes". A second artefact to publish and a heavy installer step. |
| [Browser Rendering](https://developers.cloudflare.com/browser-rendering/platform/pricing/) | Not documented | Free: 10 minutes a day, 3 browsers, a new browser every 20 s. Paid: 10 h a month, then $0.09 an hour; 10 browsers included, 200 at most ([limits](https://developers.cloudflare.com/browser-rendering/platform/limits/)). 60 s browser timeout. | It could draw with the real canvas renderer, which would be exact. But it means loading the web app per session, seconds to start, and the free plan's quota is too small for agents. A later option for `export_image` fidelity, not a runner. |
| [Dynamic Workers](https://developers.cloudflare.com/dynamic-workers/) (Worker Loader) | Not documented beyond the Workers isolate | Open beta since March 2026, Paid only. 1,000 unique Workers a month included, then $0.002 per Worker per day. Start-up CPU is billed. 4 in flight per request, 10 per Durable Object ([limits](https://developers.cloudflare.com/dynamic-workers/platform/limits/), [pricing](https://developers.cloudflare.com/dynamic-workers/pricing/)). | A fresh isolate per call, but still 128 MB, cold every call (2.5 MB of resvg plus the editor to parse, the file to build), and beta. |

**Verified on Cloudflare (migration step 0, 2026-11-17): pass.** Two throwaway scripts on the instance's account, deleted afterwards, without touching the instance's Worker, database or bucket. The method and raw results are in [0033-agent-runner-step0.md](0033-agent-runner-step0.md), and the probe is in `tools/agent-runner-probe/`. Over 80 runner aborts (WASM growth and JS-heap growth, in a `WorkerEntrypoint` and in a DO, by fetch and by RPC), the room's socket never closed and all 2,673 transactions were acked. The caller saw `Worker exceeded memory limit.` or `Durable Object's isolate exceeded its memory limit and was reset.`, always with `remote` and `overloaded`, never `retryable`. Three things the docs didn't say:
- A WASM memory grown to 200 MiB returns normally, and the isolate is reset afterwards. Only a larger overrun fails the call itself.
- After a reset, the DO stub is dead (the next call fails without `remote`), while a new stub works at once. So the main Worker uses a new stub for each call, and treats a failed `committed` call as "the runner dropped its editor".
- If the room DO awaits a stateless runner Worker, the runner runs on the room's thread, and the room's acks wait for it (up to 2.3 s, none lost). Item 2 below already keeps the room from calling the runner, and this makes that a hard rule.

### 2. What capped WebAssembly does (spikes, Node 26)

The scripts and their full output are in [0033-agent-runner-spikes.md](0033-agent-runner-spikes.md). Both modules define their own memory (it isn't imported), so a cap means rewriting the `maximum` in the binary's memory section, a small build step.

- **resvg 2.6.2 has no maximum**: 23 pages minimum (1.4 MiB), and wasm32 lets it grow to 4 GiB. **HarfBuzz 1.6.4** allows 32,768 pages (2 GiB).
- **resvg, uncapped**, 20 nested 2048 px groups at 90% opacity drawn at 1536 px: memory grows from 1.4 to 200.9 MiB in 6.2 s and stays there after `free()`.
- **resvg capped at 64 MiB**: the same render throws `RuntimeError: unreachable` after 117 ms, with memory at 55.9 MiB. The call fails cleanly. (wasm-bindgen's `free()` in a `finally` then throws "recursive use of an object", which hides the first error, so the wrapper has to keep the first one.)
- **One trap poisons the instance.** After a single capped failure at 48 MiB, a 1024 px render with one group fails too. That render takes 9.8 MiB on a fresh instance. What the failed render held is never freed, and `initWasm` refuses to run twice: "can be used only once".
- **HarfBuzz capped at 48 MiB** (a Blob, Face and Font per weight, as the review's case does): it throws `RuntimeError: memory access out of bounds` at weight 361. **A font made before that point then measures "Hamburgefonstiv" as 0 instead of 16,652**, with no error. The cause: `new Blob()` copies the font to whatever `malloc` returns, and when the allocation fails that is 0. So a cap without a null check corrupts silently.
- **A fresh instance from an already compiled module** takes 0.41 ms median for resvg and 0.25 ms for HarfBuzz, about 10 ms at worst, over 50 runs.

So a WASM cap makes one call fail cleanly. Only throwing the instance away makes the next call safe.

## Options for the runner's shape

The runner hosts what's in the room today: the editor, measurer, renderer and tool layer. What stays in the room: admission, the ledger, commits, the SQL read tools (`get_outline`, `find_nodes`, `get_node`) and agent undo.

| | A. Stateless Worker | B. Per-file runner DO, own script | C. Per-call fresh isolate |
| --- | --- | --- | --- |
| Host | A `WorkerEntrypoint` in `drawpane-agent-runner` | `AgentRunner` DO (SQLite) in `drawpane-agent-runner`, `idFromName(fileId)` | A Dynamic Worker per call, or a Container |
| Room isolated | Yes | Yes | Yes |
| Who shares the runner's memory | Concurrent calls on **any** files that land in one isolate | Runners of other files that land in one isolate (documented) | Nobody |
| Calls on one file | Concurrent, so they race each other's commits | One at a time, as in the room today | Concurrent |
| Warmth | None you can count on, so each call fetches and builds the file | The editor stays warm between a session's calls and catches up from the log | Always cold |
| Cost | CPU only | CPU plus duration while active (128 MB GB-s) | Beta billing (Dynamic Workers), or a container's memory-seconds and an image |
| Installer | A second script | A second script plus a DO migration | Beta feature, or Docker and an image |

**Getting the file.** It's the same in every shape, so it's settled once:

- **Cold** (no warm editor, or too far behind): the runner reads version 2 snapshot lines (decision 0026, item 9) as the download path does. That's the latest saved version straight from R2 (the runner binds the bucket) when the log covers everything since it, otherwise the room's `exportDocument()` stream. That stream is shared by everyone loading that revision and paged at 4 million characters, so a cold runner costs the room no more than a person opening the file. No ticket is needed: the main Worker, which has already checked the session, asks the room for the source and passes the stream over RPC (RPC carries streams; decision 0026).
- **Warm**: the runner says which revision it holds, and the room answers with the logged transactions since then in pages bounded by characters (#173's `boundedPages`). When the log no longer reaches back far enough, the runner goes cold. This is a client's catch-up hello made as a pull at the start of each call. There's no socket to keep open, and nothing to push to a runner that has gone.

**Writing changes back.** The runner sends its operations with the revision it ran on. The room commits them through `#commit` with the same validation as any client's transaction (the model's checks, the depth rule, the copies format, the 1 MiB change cap), and writes the ledger row in the same storage transaction, as `#commitAgentCall` does now. The room doesn't run tools any more, so it can't promise "the file as it is when it commits". It promises the next best thing: the commit is refused as `stale` if anyone else's logged operations since the base revision changed any layer the call changed, or put a layer inside one. This is the overlap test agent undo already uses (`overlap`, `firstOverlap` in `call-ledger.ts`). On `stale`, the main Worker runs the call again from the new revision, up to `AGENT_ATTEMPTS` (3) times, as `runAgentTool` retries today. Edits elsewhere in the file don't block the commit, just as one person's edits don't block another's. Plain socket `txn` messages were considered and rejected: they can't carry the ledger row in the commit's storage transaction, and that row is what makes calls exactly-once.

**Undo of agent work.** It doesn't move. `stepAgentCall` applies a recorded inverse with SQL and `#commit`, with no editor involved. The ledger stays in the room's SQLite, written with the commit. The 1 MiB inverse limit that #173's review flagged (deleting 2,000 styled buttons) is a separate problem and isn't changed here.

## Decision

1. **Agent tools run in a per-file runner Durable Object in a script of its own (option B).** The script is `drawpane-agent-runner` with an `AgentRunner` class (SQLite-backed), one instance per file. The room keeps admission, the ledger, commits, undo and the SQL read tools. The room no longer imports HarfBuzz, resvg or the editor's headless engine. B wins over A because calls on one file stay serialized and warm. It wins over C because it adds no beta feature and no container image to every install. If real files outgrow 128 MB, the runner's RPC interface lets a Container take its place.

2. **The main Worker orchestrates. The runner never calls the room.** For an MCP call, the main Worker:
   1. checks the session;
   2. asks the room for admission, any replay of this call id, and the file's source (a snapshot stream, or log pages from a revision);
   3. calls `AgentRunner.run(...)`;
   4. hands the result to the room's new `commitAgentRun({ by, session, callId, baseRevn, ops, result, tool, label })`;
   5. tells the runner whether the commit landed at `baseRevn + 1`. If it did, the warm editor carries on; if not, the runner drops its editor.

   The runner binds R2 (fonts, images, snapshots) and D1 (media and team font rows), and nothing of the main script's. So there's no cycle between the scripts: deploy the runner first, then the main Worker with an `AGENT_RUNNER` DO binding (`script_name`).

3. **The room never waits on the runner.** The room's work in a call is two short steps: admission with the source, then the commit. While the runner works, the room keeps serving sockets. Today a long tool run blocks the room's event loop for its whole CPU time, so people editing get faster acks as well.

4. **Bounds inside the runner.** The aim is that every call either finishes or fails with a sentence the agent can act on, and that one bad call never becomes a loop.
   1. **Admission first, in two places.** The room's SQL precheck (`AGENT_MAX_NODES`, and #173's lower bound on what the editor holds) refuses before a row moves. Inside the runner, #173's build meter (`AGENT_MAX_HELD`, 48 MB) stops the build before it keeps more than that.
   2. **WASM in fresh, capped instances.** Both modules get a `maximum` written into the binary at build time: resvg 48 MiB, HarfBuzz 24 MiB. Each render gets a new resvg instance from the compiled module and drops it afterwards (0.4 ms). This is the only way to give back resvg's high-water mark. HarfBuzz stays warm with the editor, and is replaced along with the measurer after any trap or once it passes its budget. Font blobs and faces are shared by file and weight, not made per weight. `patches/harfbuzzjs` checks every `malloc` for 0 and throws before writing. The wasm-bindgen glue for resvg becomes a factory, since its `initWasm` runs once per isolate.
   3. **Any trap or unexpected error drops everything.** That means the editor, the measurer and both instances. The next call starts cold.
   4. **Whatever is left reaches the isolate limit.** That covers JS-heap growth in layout or the SVG export that no meter caught. The runner DO resets and the main Worker's call throws (`.remote`). Nothing was committed, because commits happen only in step 2.4 above. The room never notices.
   5. **Crash strikes, so a call can't loop.** Before it runs a call, the runner writes an `inflight` row to its own SQLite: the tool, a hash of the input, and the revision. It deletes the row when the call returns. A runner that starts and finds a leftover row knows the last call killed it, and records a strike against that fingerprint. That call is then refused for an hour ("That call ran out of memory last time, so it isn't run again. Try a smaller part."). After 3 strikes on a file within 10 minutes, every call on that file is refused for 10 minutes. The main Worker doesn't retry after an abort. An agent that retries with the same call id is caught by the fingerprint.
   6. **CPU.** The runner's own `limits.cpu_ms` is 60,000. A build of 50,000 layers takes seconds, and a render tens to hundreds of milliseconds (decision 0023). A runaway therefore fails within a minute rather than five. The main Worker stops waiting after 90 s and answers that the call took too long. A runner that finishes later can't commit, because it never commits itself.

   A fresh isolate per call was considered as the policy and rejected for now. On Workers that means Dynamic Workers: beta, paid, cold for every call, and still 128 MB. Fresh WASM instances buy the part of a fresh isolate that matters (memory that never shrinks), and the strikes stop the loop.

5. **What the agent sees when a call fails.** Every failure is a tool error worded for the model, and every one says that nothing was changed:
   - **refused at admission:** "This file is too large for agent tools (…)";
   - **a capped WASM trap:** "That picture needs more memory than the agent runner has. Export a smaller layer or a lower scale.", or the equivalent for text;
   - **the runner aborted:** "The agent runner ran out of memory on that call. Nothing was changed. Try a smaller part.";
   - **a strike:** the refusal in item 4.5;
   - **CPU or the 90 s limit:** "That call took too long."

   Everyone in the file stays connected. A runner that aborts takes down any other files' runners in the same isolate, since instances of one class may share. Those calls fail the same way and work on a retry, because they never committed.

6. **Latency, warmth and cost.**
   - **Warm call**: one RPC hop (main Worker to runner), a catch-up page from the room, the tool, and the commit RPC. The runner DO lives where it was first called. That's usually the same region as the room, since both are reached from the main Worker, but not the same machine, so expect a few to tens of milliseconds more than today.
   - **Cold call**: that plus streaming and building the file. Today's room already pays for that build when its warm editor is cold, but over SQLite rather than a stream. A runner stays warm while a session is active and is evicted after a short idle time (DOs without connections go within minutes). That suits agents, whose calls come seconds apart.
   - **Cost**: duration at 128 MB while active. A thousand calls at about 15 s active each (the call plus idle time before eviction) is about 1,900 GB-s. Paid includes 400,000 GB-s a month; Free gives 13,000 a day. Requests and rows written are negligible. Agent tools need the paid plan's CPU anyway (decision 0023's 10 ms note), and that doesn't change.

## Migration

0. **Check the isolation claim on Cloudflare, in scripts of its own (never the instance's).** Done on 2026-11-17 with two throwaway scripts: pass ([0033-agent-runner-step0.md](0033-agent-runner-step0.md)). Deploy both scripts with a test-only runner route that grows a WASM memory to 200 MB, plus one that loops the JS heap. Keep a WebSocket client on the room sending transactions throughout. Pass: the runner call fails with `.remote`, the socket stays open, and every transaction is acked. Record the exact error text the main Worker sees.
1. **Split the host interface in place.** Move `AgentEngine`, the measurer and the renderer behind an `AgentRunnerApi` (`run`, `committed`, `drop`) implemented in-process first. The room keeps working as today, but through that interface and through `commitAgentRun` with `baseRevn` and the `stale` check. Tests: the existing `agent.test.ts`, `mcp.test.ts` and `agent-export-image.test.ts` unchanged, plus a stale-commit test (a person edits the same layer between run and commit, and the call reruns).
   **Done on 2026-11-17.** What landed:
   - `agent/runner-api.ts` is the interface, in plain data with a `v` field: `AgentRunnerApi` (`run`, `committed`, `drop`) and the room's half, `AgentRoomApi` (`admitAgentCall`, `commitAgentRun`).
   - `agent/runner.ts` is `InProcessAgentRunner`, the engine, measurer and renderer behind that interface. The room hosts it for now, exposed as `runAgent`, `agentCommitted` and `dropAgent`, and reads the room's rows through `AgentSource`. It answers one call at a time per file.
   - `agent/call.ts` is the main Worker's side, and the MCP server calls it. It admits the call, runs it, commits it, and says how the commit went. The room never calls the runner. `runAgentTool` and `readAgentTool` are gone.
   - It follows step 0's findings. Every request gets a new runner from a factory (`AgentDeps.runner`). A failed `committed` is logged and ignored. An `overloaded` or `durableObjectReset` error from `run` is answered with item 5's message and isn't retried. A `retryable` reset is retried once.
   - `stale` is `firstOverlap` over the run's layers with nobody left out, so another call of the same session counts too. A commit that no longer applies to a file that moved on (a parent deleted meanwhile) is stale too, so the rerun reports the tool's own error.
   - Two behaviours changed. The room runs the SQL pre-check once per revision even when the runner is warm, because it can no longer tell. The meter's refusal is now remembered by the runner. A person's edit that lands between a run and its commit makes the runner drop its editor, and the next call rebuilds it.
   - Tests: `test/agent-runner.test.ts` covers an overlapping edit (reruns), an edit elsewhere (commits at once), a parent deleted meanwhile, three overlapping edits in a row (gives up), a deaf runner, and an aborted runner.
2. **WASM bounds** (useful even before the split): the memory-section rewrite in the build, the resvg glue as a factory with an instance per render, the `malloc` null check in the harfbuzzjs patch, shared font faces. Tests: the review's `resvg-nested` and `font-faces` cases become permanent `test-node` cases. Each asserts a clean `ToolFailure`, and that a small render or measure right after gives the right answer: the 0-width measurement in the spike must fail this test.
3. **The runner script.** `apps/agent-runner/` with its own `wrangler.jsonc` (R2 and D1 bindings, the `AgentRunner` SQLite migration, `limits.cpu_ms: 60000`, `AGENT_MEASURER` passed through). The main Worker binds it with `script_name` and stops importing the engine. Tests run both scripts in vitest-pool-workers (auxiliary workers in the Miniflare config):
   - **cold, warm and catch-up:** a call, a person's edit, a call;
   - **too far behind:** the log no longer reaches the runner's revision, so it goes cold;
   - **stale:** an overlapping edit between run and commit;
   - **replay:** a repeated call id is answered as recorded.
4. **Chaos tests.**
   - **Abort before the commit:** the runner calls `ctx.abort()` (a test hook) mid-call. The room's revision and ledger are unchanged, a room socket opened before the call is still open and acks an edit, and the retry runs once.
   - **Abort after the commit, before the answer:** the retry replays and nothing runs twice.
   - **Strikes:** a runner that keeps dying on one fingerprint stops being called.
   - **The 90 s limit:** a runner that never answers.
   - **Memory, in Node** (`pnpm --filter @drawpane/worker memory`): the four review cases run through the runner's entry, each ending in a clean failure or a bounded success, never an abort of the room's process.
5. **Remove the in-room engine** and `#warmEditor` from `file-room.ts`, and update decisions 0021 (the engine's host), 0023 (item 4: rendering moves to its own Worker, as it anticipated) and 0026 (item 8).

**The installer** (`packages/create-drawpane`):

- The release carries two Workers. `scripts/bundle-server.mjs` builds `server/agent-runner/` beside `server/worker/`, and `wrangler.template.json` becomes one template per script.
- `drawpane.json` records the runner's name, `<name>-agent-runner`.
- `deployAndWait` deploys the runner first, then the main Worker. That order holds on install and on every upgrade, so the runner must accept the RPC of the main Worker one release back. Version the RPC with a `v` field.
- Migrations: the runner's DO class (`new_sqlite_classes: ["AgentRunner"]`). It has no secrets.
- The account needs room for one more Worker (100 on Free).
- `docs/self-hosting.md` lists the second script.
- The installer's tests cover both deploy orders and an interrupted install that stopped between the two scripts. Such an install has a runner and no new main Worker yet, which is harmless.

## Consequences

- An agent can't disconnect the people working on a file, whatever it does. The worst it can do is fail its own call, and the strikes stop it repeating that.
- Agent calls are no longer atomic with the file as a whole, only with the layers they touch. A person editing elsewhere while a call runs no longer forces it to run again. A person editing the same layers makes it run again, as before.
- The main Worker's bundle loses resvg (943 KB gzipped) and HarfBuzz (175 KB), which decision 0023 counted against the free plan's 3 MB.
- #173's room-side bounds (moves, publishes, restores, merges, socket checks, undo pages) are still needed: they're the room's own paths. Its in-room agent meter becomes the runner's admission. The four review findings about component memory become runner failures rather than room resets, and item 4.2 fixes the two WASM ones.
- Two scripts to deploy, version and keep in step. The deploy order and a versioned RPC cover that.

## Open questions for the lead

1. **Can #173 land as it is,** with the agent meter's remaining findings deferred to this runner? Or should it drop the agent changes and land only the room-side bounds?
2. **Caps**: resvg 48 MiB, HarfBuzz 24 MiB, the editor meter 48 MB. Together with a 17 MB baseline these overcommit 128 MB on purpose, since the runner is disposable. Keep them, or make them sum to under 128?
3. **Is the `stale` rule right,** or should a call commit only at exactly its base revision, as today? That would mean more reruns in a busy file, but layout fix-ups computed on a file that has changed nearby could never land.
4. **Free-plan installs**: run agent tools there at all, given 10 ms of CPU on Free? Or say plainly that they need Paid?
5. **A Container runner for large files**, which would lift the 50,000-layer agent limit: worth planning now as phase 2 of this, or only once someone asks?
6. **Who runs migration step 0**, and on which scratch account?

## Answers (2026-11-17)

1. **#173 lands narrowed.** It keeps what bounds the room: the document built in bounded pages and metered, the store's read cache, publish counting, the socket size check, and restore, merge and undo paging. It drops limits that refuse ordinary work: no refusal of an agent delete by undo size, and a photo too large to decode is drawn as a marked placeholder listed in the tool's result. The review's remaining findings (rasterising, fonts, layout, SVG expansion, held replay) are this runner's to solve.
2. **Caps fit under 128 MB together**, with the baseline. Instances of one class can share an isolate, so a runner that overcommits on one file's call can take down another file's call in the same isolate. Disposable isn't the same as alone.
3. **`stale` as proposed**: a call is refused only when someone changed the layers it touched, by the overlap check agent undo already uses. An exact-revision rule would make agents unusable in a busy file.
4. **Free plans: agent tools are off,** and say plainly that they need the Paid plan. 10 ms of CPU can't build an editor for any real file.
5. **No Container runner yet.** Revisit when someone needs agents on files past 50,000 layers.
6. **Step 0** waits for the user's choice of account: a scratch account, or throwaway scripts with their own names on the existing account, deleted afterwards and never touching the instance's own Worker, database or bucket. Run that way on 2026-11-17, and it passed ([0033-agent-runner-step0.md](0033-agent-runner-step0.md)).
