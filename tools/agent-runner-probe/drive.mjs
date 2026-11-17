// Drives decision 0033's step 0 against a deployed probe room:
//   node drive.mjs https://drawpane-oom-probe-room.<subdomain>.workers.dev [rounds] [out.json]
// One WebSocket stays on the room for the whole run, sending a numbered transaction every 100 ms.
// Meanwhile every runner shape is made to abort, several times, and what the room's Worker saw is
// recorded. At the end it reports closes, missing acks and room resets.
import { writeFileSync } from "node:fs";

const base = process.argv[2];
const rounds = Number(process.argv[3] ?? 3);
const out = process.argv[4] ?? "step0-results.json";
if (!base) throw new Error("usage: node drive.mjs <room base URL> [rounds] [out.json]");

const t0 = Date.now();
const at = () => Date.now() - t0;
const log = (...a) => console.log(`[${(at() / 1000).toFixed(1)}s]`, ...a);

// --- the socket ------------------------------------------------------------------------------
const sock = {
  sent: 0,
  acked: new Set(),
  dupes: 0,
  closes: [],
  errors: [],
  roomStarts: new Set(),
  roomIids: new Set(),
  lastCount: null,
  countGaps: [],
  maxAckMs: 0,
  slowAcks: [],
};
let current = null; // the call in flight, to attribute slow acks
const sentAt = new Map();
const sentDuring = new Map();
const ws = new WebSocket(`${base.replace(/^http/, "ws")}/ws?room=main`);
ws.addEventListener("close", (e) => {
  sock.closes.push({ at: at(), code: e.code, reason: e.reason });
  log("SOCKET CLOSED", e.code, e.reason);
});
ws.addEventListener("error", (e) => sock.errors.push({ at: at(), message: String(e.message) }));
ws.addEventListener("message", (e) => {
  const m = JSON.parse(String(e.data));
  if (sock.acked.has(m.ack)) sock.dupes++;
  sock.acked.add(m.ack);
  const ackMs = Date.now() - (sentAt.get(m.ack) ?? Date.now());
  sock.maxAckMs = Math.max(sock.maxAckMs, ackMs);
  if (ackMs > 500)
    sock.slowAcks.push({ ack: m.ack, ms: ackMs, at: at(), sentDuring: sentDuring.get(m.ack) });
  sock.roomStarts.add(m.started);
  sock.roomIids.add(m.iid);
  if (sock.lastCount !== null && m.count !== sock.lastCount + 1) {
    sock.countGaps.push({ ack: m.ack, count: m.count, last: sock.lastCount });
  }
  sock.lastCount = m.count;
});
await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve, { once: true });
  ws.addEventListener("error", reject, { once: true });
});
log("socket open");
const ticker = setInterval(() => {
  if (ws.readyState !== WebSocket.OPEN) return;
  const n = ++sock.sent;
  sentAt.set(n, Date.now());
  sentDuring.set(n, current);
  ws.send(JSON.stringify({ n }));
}, 100);

// --- the calls -------------------------------------------------------------------------------
const calls = [];
async function get(path) {
  const t = Date.now();
  const sentBefore = sock.sent;
  const ackedBefore = sock.acked.size;
  let body;
  current = path;
  try {
    const res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(180_000) });
    const text = await res.text();
    try {
      body = { status: res.status, json: JSON.parse(text) };
    } catch {
      body = { status: res.status, text: text.slice(0, 500) };
    }
  } catch (e) {
    body = { clientError: String(e) };
  }
  current = null;
  const entry = {
    path,
    at: t - t0,
    wallMs: Date.now() - t,
    txnsSentDuring: sock.sent - sentBefore,
    acksDuring: sock.acked.size - ackedBefore,
    socketOpen: ws.readyState === WebSocket.OPEN,
    ...body,
  };
  calls.push(entry);
  const j = body.json;
  const c = j?.call ?? j?.result?.value?.call ?? j?.abort;
  log(
    path,
    c
      ? c.ok
        ? `ok ${c.ms} ms ${JSON.stringify(c.value).slice(0, 120)}`
        : `FAILED ${c.ms} ms ${JSON.stringify(c.error)}`
      : JSON.stringify(body).slice(0, 200),
    `| acks during ${entry.acksDuring}/${entry.txnsSentDuring}`,
  );
  await new Promise((r) => setTimeout(r, 1000));
  return entry;
}

const shapes = ["svc-fetch", "svc-rpc", "do-fetch", "do-rpc"];
for (let round = 1; round <= rounds; round++) {
  log(`--- round ${round}`);
  await get("/info");
  for (const target of shapes) {
    // 200 MiB of WASM (as step 0 asks), 1 GiB of WASM, and the JS heap until it aborts.
    for (const op of ["wasm", "wasm&mb=1024", "heap"]) {
      for (let i = 0; i < 2; i++) await get(`/call?target=${target}&op=${op}&file=a`);
    }
  }
  // The room DO itself awaiting the runner while it serves the socket.
  await get("/call?target=do-rpc&op=wasm&mb=1024&via=room");
  await get("/call?target=svc-rpc&op=heap&via=room");
  await get("/twofiles?op=wasm&mb=1024");
  await get("/twofiles?op=heap");
  await get("/shared?mb=80");
  await get("/info");
}

clearInterval(ticker);
await new Promise((r) => setTimeout(r, 3000));
const missing = [];
for (let n = 1; n <= sock.sent; n++) if (!sock.acked.has(n)) missing.push(n);
const summary = {
  durationS: at() / 1000,
  sent: sock.sent,
  acked: sock.acked.size,
  missing,
  dupes: sock.dupes,
  closes: sock.closes,
  errors: sock.errors,
  socketOpenAtEnd: ws.readyState === WebSocket.OPEN,
  roomDoStarts: [...sock.roomStarts],
  roomDoIsolates: [...sock.roomIids],
  countGaps: sock.countGaps,
  maxAckMs: sock.maxAckMs,
  slowAcks: sock.slowAcks,
};
ws.close(1000, "done");
writeFileSync(out, JSON.stringify({ summary, calls }, null, 2));
log("summary", JSON.stringify(summary));
