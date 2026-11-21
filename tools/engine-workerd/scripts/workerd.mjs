// The engine's Worker build in workerd beside the agent runner's set (index.ts), under
// decision 0033's caps: the engine's module as shipped (its memory section holds its 25 MiB
// maximum, resvg's place: checked here, never rewritten), HarfBuzz's capped at 32 MiB, written
// into wasm/ (not committed). Starts `wrangler dev` on
// ENGINE_WORKERD_PORT (8979) and runs the cases, measuring the workerd process's resident memory
// from outside (a Worker can't see its own):
//
// - the largest export allowed, 8192 × 8192, of a dense dashboard of text, gradients and strokes;
// - one past it, refused with the limit named, then a small export (the isolate still works);
// - another file in the same isolate (memory stays where it was).
//
// Fails when a render fails, a cap is passed, or the isolate (its JavaScript heap, read through the
// inspector, and its WebAssembly memories) reaches its 128 MB.
// Writes out/report.json. Run `pnpm --filter @drawpane/engine build` first.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inflateSync } from "node:zlib";

const here = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(here, "package.json"));
const { withMemoryMaximum, memoryLimits, HARFBUZZ_MAX_BYTES } = await import(
  pathToFileURL(join(here, "../../packages/raster/src/wasm-limits.ts")).href
);
const { harfBuzzDrawWasm } = await import(
  pathToFileURL(join(here, "../../apps/agent-runner/scripts/harfbuzz-draw.ts")).href
);
const ENGINE_MAX_BYTES = 25 * 1024 * 1024;
const ISOLATE_BYTES = 128 * 1000 * 1000;
const wasmDir = join(here, "wasm");
mkdirSync(wasmDir, { recursive: true });
writeFileSync(join(wasmDir, "harfbuzz-draw.wasm"), harfBuzzDrawWasm());
// The shipped Worker module must carry its own maximum: the harness tests those bytes.
{
  const shipped = new Uint8Array(
    readFileSync(join(here, "../../packages/engine/dist/worker/engine_bg.wasm")),
  );
  if (memoryLimits(shipped)?.max !== ENGINE_MAX_BYTES / 65536)
    throw new Error("the engine's Worker module doesn't carry its 25 MiB memory maximum");
  writeFileSync(join(wasmDir, "engine.wasm"), shipped);
}
for (const [name, from, max] of [
  [
    "harfbuzz.wasm",
    require.resolve("harfbuzzjs/dist/harfbuzz.wasm", {
      paths: [join(here, "../../packages/editor")],
    }),
    HARFBUZZ_MAX_BYTES,
  ],
]) {
  const capped = withMemoryMaximum(new Uint8Array(readFileSync(from)), max);
  if (memoryLimits(capped)?.max !== Math.floor(max / 65536))
    throw new Error(`${name} wasn't capped`);
  writeFileSync(join(wasmDir, name), capped);
}

const port = Number(process.env.ENGINE_WORKERD_PORT ?? 8979);
const inspectorPort = port + 540;
const wrangler = spawn(
  "pnpm",
  [
    "exec",
    "wrangler",
    "dev",
    "--config",
    "wrangler.jsonc",
    "--port",
    String(port),
    "--ip",
    "127.0.0.1",
    "--show-interactive-dev-session=false",
    "--inspector-port",
    String(inspectorPort),
  ],
  {
    cwd: here,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  },
);
let log = "";
wrangler.stdout.on("data", (d) => (log += d));
wrangler.stderr.on("data", (d) => (log += d));
const stop = () => {
  try {
    process.kill(-wrangler.pid, "SIGTERM");
  } catch {}
};
process.on("exit", stop);

function memoryOf(pid) {
  const status = readFileSync(`/proc/${pid}/status`, "utf8");
  const kb = (key) => Number(status.match(new RegExp(`${key}:\\s+(\\d+)`))?.[1] ?? 0) * 1024;
  return { rss: kb("VmRSS"), hwm: kb("VmHWM") };
}
function workerds(pid) {
  const table = execFileSync("ps", ["-eo", "pid=,ppid=,comm="], { encoding: "utf8" })
    .trim()
    .split("\n")
    .map((l) => l.trim().split(/\s+/));
  const below = new Set([String(pid)]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [p, parent] of table)
      if (p && parent && below.has(parent) && !below.has(p)) {
        below.add(p);
        grew = true;
      }
  }
  return table.filter(([p, , c]) => p && below.has(p) && c === "workerd").map(([p]) => Number(p));
}

/** Decodes a PNG's size and checks its IDAT stream inflates to every row. */
function checkPng(buf) {
  if (buf.subarray(1, 4).toString() !== "PNG") throw new Error("not a PNG");
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  const idat = [];
  for (let at = 8; at < buf.length; ) {
    const len = buf.readUInt32BE(at);
    if (buf.subarray(at + 4, at + 8).toString() === "IDAT")
      idat.push(buf.subarray(at + 8, at + 8 + len));
    at += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  if (raw.length !== h * (w * 4 + 1))
    throw new Error(`PNG rows: ${raw.length} bytes, expected ${h * (w * 4 + 1)}`);
  return { width: w, height: h };
}

const base = `http://127.0.0.1:${port}`;
const request = (path, timeout = 180_000) =>
  fetch(`${base}${path}`, { signal: AbortSignal.timeout(timeout) });

/**
 * The isolate's JavaScript heap through the inspector (what Cloudflare counts toward the 128 MB
 * besides WebAssembly memory), sampled while a response streams.
 */
const WebSocketWithHeaders = createRequire(require.resolve("wrangler/package.json"))("ws");
let inspector = null;
let nextId = 1;
const pending = new Map();
async function connectInspector() {
  for (let i = 0; i < 60 && !inspector; i++) {
    try {
      const targets = await (
        await fetch(`http://127.0.0.1:${inspectorPort}/json`, { signal: AbortSignal.timeout(2500) })
      ).json();
      const url = targets.find((t) => t.webSocketDebuggerUrl)?.webSocketDebuggerUrl;
      if (url) {
        // Wrangler's inspector proxy wants an Origin, which Node's own WebSocket can't send: the
        // `ws` package wrangler itself uses.
        const ws = new WebSocketWithHeaders(url, {
          headers: { Origin: `http://127.0.0.1:${inspectorPort}` },
        });
        await new Promise((resolve, reject) => {
          ws.once("open", resolve);
          ws.once("error", reject);
        });
        ws.on("message", (data) => {
          const msg = JSON.parse(String(data));
          if (msg.id === undefined) return;
          pending.get(msg.id)?.(msg.result ?? msg.error);
          pending.delete(msg.id);
        });
        inspector = ws;
      }
    } catch {}
    if (!inspector) await new Promise((r) => setTimeout(r, 500));
  }
}
function send(method, params = {}) {
  if (!inspector) return Promise.resolve(null);
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    inspector.send(JSON.stringify({ id, method, params }));
    setTimeout(() => resolve(null), 5000);
  });
}
const heapUsed = async () => (await send("Runtime.getHeapUsage"))?.usedSize ?? null;

const failures = [];
try {
  for (let i = 0; ; i++) {
    try {
      if ((await request("/health", 2000)).ok) break;
    } catch {}
    if (i > 360) throw new Error(`wrangler dev didn't start:\n${log}`);
    await new Promise((r) => setTimeout(r, 500));
  }
  await connectInspector();
  const pids = workerds(wrangler.pid);
  const idles = pids.map(memoryOf);
  const noopResponse = await request("/noop", 45_000);
  if (!noopResponse.ok) throw new Error(`Worker startup: ${await noopResponse.text()}`);
  const noop = await noopResponse.json();
  const warms = pids.map(memoryOf);
  const which = warms.reduce(
    (best, m, i) => (m.rss - idles[i].rss > warms[best].rss - idles[best].rss ? i : best),
    0,
  );
  const pid = pids[which];
  const idle = idles[which];
  const warm = warms[which];
  const run = async (query) => {
    try {
      return await runOnce(query);
    } catch (error) {
      return {
        status: 0,
        ms: 0,
        report: { error: String(error?.cause ?? error) },
        body: Buffer.alloc(0),
        memory: memoryOf(pid),
        heapPeak: null,
      };
    }
  };
  const runOnce = async (query) => {
    await send("HeapProfiler.collectGarbage");
    let heapPeak = (await heapUsed()) ?? 0;
    const t = performance.now();
    const res = await request(`/export?${query}`);
    // The PNG streams in: read it a chunk at a time, sampling the isolate's heap as it goes.
    const parts = [];
    const reader = res.body.getReader();
    let sampled = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      if (performance.now() - sampled > 100) {
        sampled = performance.now();
        heapPeak = Math.max(heapPeak, (await heapUsed()) ?? 0);
      }
    }
    const body = Buffer.concat(parts);
    const ms = performance.now() - t;
    heapPeak = Math.max(heapPeak, (await heapUsed()) ?? 0);
    const wasm = await (await request("/memory", 45_000)).json();
    const header = res.headers.get("x-engine-report");
    return {
      status: res.status,
      ms: Math.round(ms),
      report: { ...(header ? JSON.parse(header) : JSON.parse(body.toString())), ...wasm },
      body,
      memory: memoryOf(pid),
      heapPeak: heapPeak || null,
    };
  };
  const big = await run("width=8192&height=8192&cards=900");
  if (big.status !== 200)
    failures.push(`the 8192 × 8192 export failed: ${JSON.stringify(big.report)}`);
  else {
    if (!(big.report.glyphs?.count > 0) || big.report.unsupported !== 0)
      failures.push("workerd did not draw live HarfBuzz text");
    const size = checkPng(big.body);
    if (size.width !== 8192 || size.height !== 8192)
      failures.push(`the PNG is ${size.width} × ${size.height}`);
  }
  const over = await run("width=8193&height=100&cards=4");
  if (over.status !== 400 || !String(over.report.error).includes("8192"))
    failures.push(
      `an export past the limit wasn't refused with it named: ${JSON.stringify(over.report)}`,
    );
  const small = await run("width=1024&height=768&cards=16");
  if (small.status !== 200)
    failures.push(`a small export after a refused one failed: ${JSON.stringify(small.report)}`);
  const other = await run("width=4096&height=4096&cards=400&seed=7");
  if (other.status !== 200)
    failures.push(`another file in the same isolate failed: ${JSON.stringify(other.report)}`);
  const end = memoryOf(pid);
  const mib = (b) => Math.round((b / 1048576) * 10) / 10;
  const report = {
    caps: { engineMiB: mib(ENGINE_MAX_BYTES), harfBuzzMiB: mib(HARFBUZZ_MAX_BYTES) },
    loaded: {
      engineMiB: mib(noop.engineMemory),
      harfBuzzMiB: mib(noop.harfBuzzMemory ?? 0),
      workerdGrowthMiB: mib(warm.rss - idle.rss),
    },
    exports: Object.fromEntries(
      [
        ["8192 × 8192", big],
        ["past the limit", over],
        ["1024 × 768 after it", small],
        ["another file, 4096 × 4096", other],
      ].map(([name, r]) => [
        name,
        {
          status: r.status,
          ms: r.ms,
          ...r.report,
          engineMiB: mib(r.report.engineMemory ?? 0),
          harfBuzzMiB: mib(r.report.harfBuzzMemory ?? 0),
          jsHeapPeakMiB: r.heapPeak ? mib(r.heapPeak) : null,
          // What Cloudflare counts: the JavaScript heap and every WebAssembly memory.
          isolatePeakMiB: r.heapPeak
            ? mib(r.heapPeak + (r.report.engineMemory ?? 0) + (r.report.harfBuzzMemory ?? 0))
            : null,
          workerdRssMiB: mib(r.memory.rss),
        },
      ]),
    ),
    workerd: {
      idleMiB: mib(idle.rss),
      warmMiB: mib(warm.rss),
      endMiB: mib(end.rss),
      peakMiB: mib(end.hwm),
      growthMiB: mib(end.hwm - idle.rss),
    },
    note: "Local workerd: wall time is a latency estimate, not Cloudflare's CPU accounting. The isolate's peak is its JavaScript heap (sampled through the inspector while the PNG streams) plus its WebAssembly memories, what Cloudflare counts; the process's resident memory also holds workerd itself, compiled code and the HTTP layer's buffers.",
  };
  if ((big.report.engineMemory ?? 0) > ENGINE_MAX_BYTES) failures.push("the engine passed its cap");
  // The isolate's own peak (its JS heap and its WebAssembly memories) stays under its 128 MB.
  for (const r of [big, small, other]) {
    if (!r.heapPeak) {
      failures.push("couldn't read the isolate's heap through the inspector");
      break;
    }
    const isolate = r.heapPeak + (r.report.engineMemory ?? 0) + (r.report.harfBuzzMemory ?? 0);
    if (isolate > ISOLATE_BYTES)
      failures.push(`the isolate reached ${mib(isolate)} MiB, past its 128 MB`);
  }
  mkdirSync(join(here, "out"), { recursive: true });
  writeFileSync(join(here, "out/report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  failures.push(`${error?.stack ?? error}\n--- wrangler ---\n${log.slice(-3000)}`);
} finally {
  inspector?.close();
  stop();
}
if (failures.length > 0) {
  console.error(`workerd: ${failures.join("\n")}\n--- wrangler ---\n${log.slice(-4000)}`);
  process.exit(1);
}
