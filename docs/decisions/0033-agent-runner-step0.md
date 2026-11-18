# Decision 0033, migration step 0: an out-of-memory runner leaves the room alone

Run on 2026-11-17 on Cloudflare. The probe used two throwaway Worker scripts, `drawpane-oom-probe-room` and `drawpane-oom-probe-runner`, on the account that hosts the dogfooding instance. They had no D1, R2, KV, route or custom domain, and both were deleted afterwards. The instance's own Worker, database and bucket were not touched: its deployments list was recorded before and after, and the two are identical. The sources are in [`tools/agent-runner-probe/`](../../tools/agent-runner-probe/), and the raw output is in its `results/` folder.

## Result: pass

Step 0's criteria, each met on every attempt:

| Criterion | Result |
| --- | --- |
| The runner call fails with `.remote` | Yes, on all 80 calls that aborted inside the call. Every one had `remote: true` and `overloaded: true`. |
| The room's socket stays open | Yes. Each session kept one socket open from start to end (207 s for rounds 1 to 3, 69 s for round 4), with no close and no error event. |
| Every transaction is acked | Yes. 2,673 sent, 2,673 acked, none missing or duplicated. The SQLite counter went up by exactly 1 per ack, and the room DO never restarted: each run saw one `started` time and one isolate id. |

The exact errors the room's script saw:

| Runner shape | Error on the aborted call |
| --- | --- |
| Worker entrypoint, fetch or RPC over a service binding | `Error: Worker exceeded memory limit.` with `remote: true, overloaded: true` |
| Durable Object in the runner script, fetch or RPC | `Error: Durable Object's isolate exceeded its memory limit and was reset.` with `remote: true, overloaded: true, durableObjectReset: true` |

Neither error has `retryable`. A fetch over the service binding throws, just as RPC does: it doesn't return a 5xx response.

Three findings matter for the design. They're explained below.

1. **A WASM memory that grows to 200 MiB doesn't fail the call.** The call returns normally, and the runner's isolate is replaced afterwards. Only a larger or longer overrun aborts the call itself.
2. **A Durable Object stub is dead after its isolate resets,** even when the call that overran succeeded. A new stub works at once.
3. **If the room DO awaits a stateless runner Worker, the room stalls for as long as the runner runs.** The runner runs on the room's thread. Acks were late by up to 2.3 s, but none was lost. In the design the main Worker makes the call and the runner is a DO, so this doesn't happen.

## Method

**Probe room** (`room/room.js`). `ProbeRoom` is a SQLite Durable Object that uses the WebSocket Hibernation API (`ctx.acceptWebSocket`, `webSocketMessage`), as `FileRoom` does. For each `{ n }` a client sends, it adds 1 to a counter row in SQLite and replies `{ ack: n, count, iid, started }`. `iid` is a random id made once per isolate at module scope, and `started` is when the object was constructed. The room's Worker binds:

- the runner as a service (`RUNNER`, `service: drawpane-oom-probe-runner`);
- the runner's DO class (`RUNNER_DO`, `script_name: drawpane-oom-probe-runner`).

Its `/call` route makes one runner call in one of four shapes: service fetch, service RPC, DO fetch, or DO RPC. Then it makes a follow-up ping: on the same service for the stateless shapes, and for DOs on the same stub, on a fresh stub, and on a fresh stub 500 ms later. It reports every property of each error, including non-enumerable ones. With `via=room`, the room DO makes the call itself.

**Probe runner** (`runner/runner.js`). Its default export is a `WorkerEntrypoint` with `fetch` and an RPC method `op`. `RunnerDO` is a SQLite DO class in the same script with the same operations. The runner has no workers.dev URL and no route, so only the room's bindings reach it. Its operations:

- `wasm`: makes a fresh instance of `grow.wasm` and grows it 1 MiB at a time, writing every new page, until it reaches `mb` MiB (default 200). `grow.wasm` is a 54-byte hand-assembled module (`make-wasm.mjs`): one memory with no maximum, like resvg's, and `grow(pages)` that calls `memory.grow`.
- `heap`: pushes 512 Ki-element arrays of numbers into a module-level array until the isolate dies.
- `ballast`: holds `mb` MiB.
- `ping`.

**Driver** (`drive.mjs`, Node 26 on the project VM). It opens one WebSocket to the room and sends a transaction every 100 ms for the whole run. Meanwhile it runs, in order, with a second's pause between calls:

1. each of the 4 shapes × {`wasm` at 200 MiB, `wasm` at 1 GiB, `heap`} × 2;
2. the room DO itself calling a runner DO (`wasm`, 1 GiB) and the runner service (`heap`);
3. `/twofiles` for `wasm` and `heap`: runner DOs for files `b1` to `b4` read before and after file `a`'s runner aborts;
4. `/shared`: isolate ids from both scripts, then memory held on both sides at once.

Rounds 1 to 3 ran as one 207 s session, as step 0 asks. Round 4 repeated the sequence in a 69 s session that also logged every ack slower than 500 ms. It was added to explain one slow ack in rounds 1 to 3.

## Raw results

### The socket

| Session | Sent | Acked | Missing | Closes | Room DO restarts | Slowest ack |
| --- | --- | --- | --- | --- | --- | --- |
| Rounds 1 to 3 | 2,027 | 2,027 | 0 | 0 | 0 | 2,310 ms |
| Round 4 | 646 | 646 | 0 | 0 | 0 | 1,786 ms |

All acks slower than 500 ms in round 4, 13 of them, were for transactions sent during one call: the room DO awaiting the runner service's `heap` abort. The calls made from the room's Worker produced no slow acks at all. Rounds 1 to 3 didn't log each ack's time, but their slowest ack, 2,310 ms, fits the same call: there, the follow-up ping took 1,301 to 2,270 ms.

### Calls, rounds 1 to 3

Times are measured in the room's script around the call. They include the network hop, and in Workers the clock moves only at I/O. "Next call" is the follow-up described under Method.

| Shape and operation | Calls | Failed | Time to fail or finish, min / median / max | Next call |
| --- | --- | --- | --- | --- |
| service fetch, `wasm` 200 MiB | 6 | 0 | 131 / 154 / 279 ms | 6 of 6 ok, each in a new isolate |
| service fetch, `wasm` 1 GiB | 6 | 6 | 170 / 179 / 196 ms | 6 of 6 ok |
| service fetch, `heap` | 6 | 6 | 1,648 / 1,772 / 2,023 ms | 6 of 6 ok |
| service RPC, `wasm` 200 MiB | 6 | 0 | 137 / 152 / 254 ms | 6 of 6 ok, each in a new isolate |
| service RPC, `wasm` 1 GiB | 6 | 6 | 175 / 182 / 226 ms | 6 of 6 ok |
| service RPC, `heap` | 6 | 6 | 1,871 / 1,975 / 2,996 ms | 6 of 6 ok |
| DO fetch, `wasm` 200 MiB | 6 | 0 | 148 / 198 / 247 ms | same stub 0 of 6; fresh stub 6 of 6; fresh 500 ms later 6 of 6 |
| DO fetch, `wasm` 1 GiB | 6 | 6 | 177 / 217 / 240 ms | same stub 0 of 6; fresh 6 of 6; later 6 of 6 |
| DO fetch, `heap` | 6 | 6 | 1,975 / 2,083 / 2,445 ms | same stub 0 of 6; fresh 6 of 6; later 6 of 6 |
| DO RPC, `wasm` 200 MiB | 6 | 0 | 147 / 174 / 190 ms | same stub 0 of 6; fresh 6 of 6; later 6 of 6 |
| DO RPC, `wasm` 1 GiB | 6 | 6 | 187 / 213 / 257 ms | same stub 0 of 6; fresh 6 of 6; later 6 of 6 |
| DO RPC, `heap` | 6 | 6 | 1,644 / 1,935 / 2,201 ms | same stub 0 of 6; fresh 6 of 6; later 6 of 6 |
| room DO calls DO RPC, `wasm` 1 GiB | 3 | 3 | 231 / 257 / 323 ms | same stub 0 of 3; fresh 3 of 3; later 3 of 3 |
| room DO calls service RPC, `heap` | 3 | 3 | 28 / 64 / 102 ms (the room's clock was stopped, see finding 3) | 3 of 3 ok, in 1,301 / 2,015 / 2,270 ms |
| `/twofiles`, `a` aborts (`wasm` 1 GiB, `heap`) | 6 | 6 | 165 to 2,231 ms | see below |

Round 4 matched this on every row: 20 aborts with the same two errors and flags, and every fresh stub and every next service call succeeded.

A same-stub call after a reset fails in 0 to 2 ms with the same message, `overloaded: true, durableObjectReset: true`, and **without** `remote`. In the very first manual check before the runs, one fresh stub made right after a `heap` abort failed with `Durable Object reset because its code was updated.` (`retryable: true`, `durableObjectReset: true`). That happened even though no code had changed in the meantime. It didn't recur in the 104 fresh-stub calls of the four rounds, so a single retry with a fresh stub covers it.

### Two files' runners

In every `/twofiles` run, all 8, the five runner DOs (`a`, `b1` to `b4`) reported five different isolate ids. After `a` aborted, `b1` to `b4` answered on the same stubs with the same isolate id and the same construction time. So they were unaffected, because none of them shared `a`'s isolate. Instances of one class **can** share an isolate (decision 0033's evidence), but at this load Cloudflare didn't place them together, so this run doesn't show what an abort does to an instance that shares. The decision already assumes the worst case: a co-located runner fails its call, which works on a retry.

`a` came back in a new isolate after every reset: its replies carried 60 different isolate ids over the four rounds.

### Do the room's and the runner's isolates ever coincide?

No, by both tests, in all 4 `/shared` runs and throughout:

- **Ids.** The room DO kept one isolate id for each session (`61ca8dcc`, then `21f4d2c6`). Neither ever appeared in the runner's replies, and no runner id ever appeared in the room's.
- **Memory.** The room DO held 60 MiB while the runner service and a runner DO each held 80 MiB. Any two of those in one 128 MB isolate would have reset it. All three holds succeeded, and the room DO kept its isolate id, start time and socket.
- **Abort.** No runner abort ever reset the room DO.

That's expected: an isolate runs one script's code. Still, it's now observed rather than read from the docs.

## The three findings, and what they change

**1. A WASM overrun can succeed and still kill the isolate.** Growing a fresh WASM memory to 200 MiB, writing every page, took about 150 ms and returned normally in all 32 tries across the four shapes. The isolate was replaced afterwards: the next stateless call landed in a new isolate, and the next call on the DO's stub failed. At 1 GiB, every try (40) failed inside the call, within 323 ms. JS-heap growth always failed inside the call (32 of 32 from the room's Worker), after 1.4 to 3.0 s.

So Cloudflare enforces the limit partly after the fact. A runner call can return a result computed with more than 128 MB, and the reset arrives with the next call. For decision 0033 this is harmless, because the result is valid. But step 2.5's message to the runner ("did the commit land?") may then fail, and the main Worker must treat a failed `committed` call as "the runner dropped its editor", never as a failed call. The crash-strike row (item 4.5) also never sees these overruns, because the call returned and deleted its `inflight` row. Only the WASM caps of item 4.2 bound them.

**2. Make a new stub after any runner error.** The docs say so, and the runs confirm it: the old stub fails at once without `remote`, and a fresh one works on the first try, about 200 ms later, cold. The main Worker should get a fresh `AGENT_RUNNER` stub for each call, and for each follow-up after an error.

**3. The room must never await a stateless runner.** When the room DO awaited the runner over a service binding, the runner ran on the room DO's thread. While the runner grew its heap for about 1.8 s, the room delivered no socket messages, and the room's own clock stood still: the abort appeared to take 0 to 102 ms. Every ack still arrived, and the socket stayed open, but they were late by as much as the runner's whole run time. A runner DO called by the room didn't stall it: DOs run where they live. Decision 0033 already has the main Worker make the call (item 2) and keeps the room's part to two short steps (item 3), so the design avoids this. It's now a constraint rather than a preference: neither the room nor the main Worker may run tool work on its own thread or the room's.

## Re-running it

See [`tools/agent-runner-probe/README.md`](../../tools/agent-runner-probe/README.md). The configs carry no account id (wrangler reads `CLOUDFLARE_ACCOUNT_ID`) and no secrets. Deploy the runner first, run `drive.mjs` against the room's workers.dev URL, then delete both scripts, the room first.
