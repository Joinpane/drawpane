# Agent runner probe (decision 0033, migration step 0)

Two throwaway Worker scripts that check the claim decision 0033 rests on: an out-of-memory abort in a separate runner script leaves the file room's WebSockets open, and the room keeps acknowledging transactions. Results: [docs/decisions/0033-agent-runner-step0.md](../../docs/decisions/0033-agent-runner-step0.md).

- `runner/` is `drawpane-oom-probe-runner`. Its default export is a `WorkerEntrypoint` (fetch and RPC), and `RunnerDO` is a SQLite Durable Object with the same operations. Operations: `ping`, `wasm` (grows a fresh instance of `grow.wasm` 1 MiB at a time, writing every page, to `mb`, default 200), `heap` (pushes arrays of numbers until the isolate dies), `ballast` (holds `mb`). No workers.dev URL and no route: only the room reaches it.
- `room/` is `drawpane-oom-probe-room`. `ProbeRoom` is a SQLite Durable Object with hibernatable WebSockets that acks each `{ n }` with a counter kept in SQLite. Its Worker binds the runner as a service (`RUNNER`) and its DO class by `script_name` (`RUNNER_DO`), and reports every property of the error it sees.
- `make-wasm.mjs` writes `runner/grow.wasm` (54 bytes, hand-assembled: one memory with no maximum, and `grow(pages)` = `memory.grow`).
- `drive.mjs` keeps a socket on the room sending a transaction every 100 ms while it makes every runner shape abort, and writes a JSON log.

Room routes:

| Route | What it does |
| --- | --- |
| `/ws?room=main` | The WebSocket |
| `/call?target=svc-fetch\|svc-rpc\|do-fetch\|do-rpc&op=…&mb=…&file=a` | One runner call, then a ping (for DOs: on the same stub, a fresh stub, and a fresh stub 500 ms later) |
| `/call?…&via=room` | The same, made from inside the room DO |
| `/twofiles?op=…` | Runner DOs for files b1 to b4, before and after file a's runner aborts |
| `/shared?mb=80` | Isolate ids on both sides, and memory held on both sides at once |
| `/info` | Isolate ids of the room's Worker and DO |

## Running it

There's no account id in the configs: wrangler reads `CLOUDFLARE_ACCOUNT_ID`. Deploy the runner first, since the room binds it.

```sh
W="pnpm exec wrangler"   # or the wrangler from the catalog
node make-wasm.mjs
$W deploy -c runner/wrangler.jsonc
$W deploy -c room/wrangler.jsonc
node drive.mjs https://drawpane-oom-probe-room.<subdomain>.workers.dev 3 results.json
$W delete --name drawpane-oom-probe-room
$W delete --name drawpane-oom-probe-runner
```

The room's URL is public while it's deployed and anyone can make the runner abort, so delete both scripts when you're done.
