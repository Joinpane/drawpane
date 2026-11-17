// drawpane-oom-probe-room: the room side of decision 0033's migration step 0.
// ProbeRoom is a SQLite Durable Object with hibernatable WebSockets, like FileRoom: each numbered
// "transaction" a client sends is counted in SQLite and acked. The Worker calls the runner script
// (drawpane-oom-probe-runner) four ways and reports exactly what it sees.
import { DurableObject } from "cloudflare:workers";

const MiB = 2 ** 20;
let isolateId;
const iid = () => {
  isolateId ??= crypto.randomUUID().slice(0, 8);
  return isolateId;
};
const held = [];

export class ProbeRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.started = Date.now();
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS counter (k TEXT PRIMARY KEY, v INTEGER)");
  }

  fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected a WebSocket", { status: 426 });
    }
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, message) {
    const { n } = JSON.parse(String(message));
    const count = this.ctx.storage.sql
      .exec(
        "INSERT INTO counter VALUES ('acks', 1) ON CONFLICT (k) DO UPDATE SET v = v + 1 RETURNING v",
      )
      .one().v;
    ws.send(JSON.stringify({ ack: n, count, iid: iid(), started: this.started }));
  }

  webSocketClose(ws, code, reason) {
    ws.close(code, reason);
  }

  info() {
    return { iid: iid(), started: this.started, sockets: this.ctx.getWebSockets().length };
  }

  ballast(mb) {
    held.length = 0;
    if (mb > 0) held.push(new Uint8Array(mb * MiB).fill(1));
    return { iid: iid(), holding: mb };
  }

  /** The room itself awaits the runner, to show its sockets keep flowing meanwhile. */
  callRunner(target, op, params) {
    return callRunner(this.env, target, op, params, "a");
  }
}

/** Every property of an error that the caller can see, including non-enumerable ones. */
function describe(e) {
  if (!(e instanceof Error)) return { thrown: String(e) };
  const out = { name: e.name, message: e.message };
  for (const k of ["remote", "retryable", "overloaded", "durableObjectReset"]) {
    if (k in e) out[k] = e[k];
  }
  for (const k of Object.getOwnPropertyNames(e)) {
    if (!["stack", "message", "name"].includes(k) && !(k in out)) out[k] = e[k];
  }
  return out;
}

async function attempt(fn) {
  const t = Date.now();
  try {
    const value = await fn();
    return { ok: true, ms: Date.now() - t, value };
  } catch (e) {
    return { ok: false, ms: Date.now() - t, error: describe(e) };
  }
}

async function viaFetch(fetcher, path) {
  const res = await fetcher.fetch(`https://runner${path}`);
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text.slice(0, 500);
  }
  return { status: res.status, body };
}

const qs = (params) => (params.mb === undefined ? "" : `?mb=${params.mb}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const runnerDo = (env, file) => env.RUNNER_DO.get(env.RUNNER_DO.idFromName(file));

/**
 * One call to the runner, then a ping on the same stub and on a fresh one.
 * target: svc-fetch | svc-rpc | do-fetch | do-rpc.
 */
async function callRunner(env, target, op, params, file) {
  const path = `/${op}${qs(params)}`;
  if (target === "svc-fetch") {
    const call = await attempt(() => viaFetch(env.RUNNER, path));
    const next = await attempt(() => viaFetch(env.RUNNER, "/ping"));
    return { target, op, call, next };
  }
  if (target === "svc-rpc") {
    const call = await attempt(() => env.RUNNER.op(op, params));
    const next = await attempt(() => env.RUNNER.op("ping"));
    return { target, op, call, next };
  }
  const stub = runnerDo(env, file);
  if (target === "do-fetch") {
    const call = await attempt(() => viaFetch(stub, path));
    const sameStub = await attempt(() => viaFetch(stub, "/ping"));
    const freshStub = await attempt(() => viaFetch(runnerDo(env, file), "/ping"));
    await sleep(500);
    const freshStubLater = await attempt(() => viaFetch(runnerDo(env, file), "/ping"));
    return { target, op, call, sameStub, freshStub, freshStubLater };
  }
  if (target === "do-rpc") {
    const call = await attempt(() => stub.op(op, params));
    const sameStub = await attempt(() => stub.op("ping"));
    const freshStub = await attempt(() => runnerDo(env, file).op("ping"));
    await sleep(500);
    const freshStubLater = await attempt(() => runnerDo(env, file).op("ping"));
    return { target, op, call, sameStub, freshStub, freshStubLater };
  }
  throw new Error(`unknown target ${target}`);
}

/** Runner DOs for files "b1".."b4" before and after file "a"'s runner aborts. */
async function twoFiles(env, op, params) {
  const others = ["b1", "b2", "b3", "b4"];
  const before = {};
  const stubs = {};
  for (const f of ["a", ...others]) {
    stubs[f] = runnerDo(env, f);
    before[f] = await attempt(() => stubs[f].info());
  }
  const abort = await attempt(() => stubs.a.op(op, params));
  const after = {};
  for (const f of others) after[f] = await attempt(() => stubs[f].info());
  const afterFresh = {};
  for (const f of others) afterFresh[f] = await attempt(() => runnerDo(env, f).info());
  return { op, before, abort, after, afterFresh };
}

/** Whether the room's isolates and the runner's isolates ever coincide, by id and by memory. */
async function shared(env, mb) {
  const room = env.ROOM.get(env.ROOM.idFromName("main"));
  const ids = {
    roomWorker: iid(),
    roomDo: await attempt(() => room.info()),
    runnerSvc: await attempt(() => env.RUNNER.op("ping")),
    runnerDo: await attempt(() => runnerDo(env, "a").op("ping")),
  };
  // Pressure: hold `roomMb` in the room DO, then ask both runner shapes to hold `mb`. The two
  // together pass 128 MB, so if the room DO shared an isolate with either runner it would reset
  // (and its sockets would drop).
  const roomMb = Math.min(mb, 60);
  const roomDoHold = await attempt(() => room.ballast(roomMb));
  const runnerSvcHold = await attempt(() => env.RUNNER.op("ballast", { mb }));
  const runnerDoHold = await attempt(() => runnerDo(env, "a").op("ballast", { mb }));
  const after = {
    roomWorker: iid(),
    roomDo: await attempt(() => room.info()),
  };
  const release = {
    roomDo: await attempt(() => room.ballast(0)),
    runnerSvc: await attempt(() => env.RUNNER.op("ballast", { mb: 0 })),
    runnerDo: await attempt(() => runnerDo(env, "a").op("ballast", { mb: 0 })),
  };
  return { mb, roomMb, ids, roomDoHold, runnerSvcHold, runnerDoHold, after, release };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.searchParams;
    const params = p.has("mb") ? { mb: Number(p.get("mb")) } : {};
    if (url.pathname === "/ws") {
      return env.ROOM.get(env.ROOM.idFromName(p.get("room") ?? "main")).fetch(request);
    }
    if (url.pathname === "/call") {
      const target = p.get("target") ?? "svc-rpc";
      const op = p.get("op") ?? "ping";
      if (p.get("via") === "room") {
        const room = env.ROOM.get(env.ROOM.idFromName("main"));
        const result = await attempt(() => room.callRunner(target, op, params));
        return Response.json({ via: "room", roomWorker: iid(), result });
      }
      const result = await callRunner(env, target, op, params, p.get("file") ?? "a");
      return Response.json({ via: "worker", roomWorker: iid(), ...result });
    }
    if (url.pathname === "/twofiles") {
      return Response.json(await twoFiles(env, p.get("op") ?? "wasm", params));
    }
    if (url.pathname === "/shared") {
      return Response.json(await shared(env, params.mb ?? 80));
    }
    if (url.pathname === "/info") {
      const room = env.ROOM.get(env.ROOM.idFromName("main"));
      return Response.json({ roomWorker: iid(), roomDo: await room.info() });
    }
    return new Response("not found", { status: 404 });
  },
};
