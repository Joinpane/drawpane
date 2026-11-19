// The CPU backend in workerd (decision 0040): builds the board's display list from the kit
// (SPIKE_FILE, SPIKE_BOARD), starts the spike's Worker with `wrangler dev` on
// SPIKE_WORKER_PORT (8869), and measures a render there: the time a request takes against an
// empty one, the WebAssembly memories, and the workerd process's resident memory. Writes
// worker.json and cpu.png into SPIKE_OUT (default out/, not committed).
//
// Run `pnpm build:wasm` and `node scripts/cap-wasm.mjs` first.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { encode } from "fast-png";
import { importTs } from "./ts.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const { kitInput, readNodes } = await importTs("src/kit.ts");
const { buildBoard } = await importTs("src/board.ts");
const input = kitInput();
if (!input) throw new Error("Set SPIKE_FILE to a folder kit-parity's convert step made.");
const out = process.env.SPIKE_OUT ?? join(root, "out");
mkdirSync(out, { recursive: true });
const port = Number(process.env.SPIKE_WORKER_PORT ?? 8869);
const runs = Number(process.env.SPIKE_RUNS ?? 9);

const list = buildBoard(readNodes(input.folder), input.boardId);
writeFileSync(join(out, "board.dl"), list.bytes);

/** Resident and peak resident memory of a process, in bytes (Linux). */
function memoryOf(pid) {
  const status = readFileSync(`/proc/${pid}/status`, "utf8");
  const kb = (key) => Number(status.match(new RegExp(`${key}:\\s+(\\d+)`))?.[1] ?? 0) * 1024;
  return { rss: kb("VmRSS"), hwm: kb("VmHWM") };
}

/** The workerd processes under `pid` (wrangler starts two: the Worker's, and its proxy's). */
function findWorkerd(pid) {
  const table = execFileSync("ps", ["-eo", "pid=,ppid=,comm="], { encoding: "utf8" })
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/));
  const below = new Set([String(pid)]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [p, parent] of table)
      if (p && parent && below.has(parent) && !below.has(p)) {
        below.add(p);
        grew = true;
      }
  }
  return table
    .filter(([p, , comm]) => p && below.has(p) && comm === "workerd")
    .map(([p]) => Number(p));
}

const wrangler = spawn(
  "pnpm",
  [
    "exec",
    "wrangler",
    "dev",
    "--config",
    "worker/wrangler.jsonc",
    "--port",
    String(port),
    "--ip",
    "127.0.0.1",
    "--show-interactive-dev-session=false",
  ],
  { cwd: root, stdio: ["ignore", "pipe", "pipe"], detached: true },
);
let log = "";
wrangler.stdout.on("data", (d) => {
  log += d;
});
wrangler.stderr.on("data", (d) => {
  log += d;
});
const base = `http://127.0.0.1:${port}`;
const stop = () => {
  try {
    process.kill(-wrangler.pid, "SIGTERM");
  } catch {}
};
process.on("exit", stop);

try {
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`${base}/health`)).ok) break;
    } catch {}
    if (i > 240) throw new Error(`wrangler dev didn't start:\n${log}`);
    await new Promise((r) => setTimeout(r, 500));
  }
  const pids = findWorkerd(wrangler.pid);
  if (pids.length === 0) throw new Error("No workerd process found");
  const idles = pids.map(memoryOf);
  const time = async (path, body) => {
    const t = performance.now();
    const res = await fetch(`${base}${path}`, body ? { method: "POST", body } : {});
    const buf = new Uint8Array(await res.arrayBuffer());
    return { ms: performance.now() - t, res, buf };
  };
  // HarfBuzz instantiated, a font loaded and a line shaped, the engine instantiated.
  await time("/noop");
  // The Worker's own process is the one that grew when it loaded HarfBuzz and the engine.
  const warms = pids.map(memoryOf);
  const which = warms.reduce(
    (best, m, i) =>
      m.rss - (idles[i]?.rss ?? 0) > warms[best].rss - (idles[best]?.rss ?? 0) ? i : best,
    0,
  );
  const pid = pids[which];
  const idle = idles[which];
  const warm = warms[which];
  // The first render without its pixels coming back, so the growth is the engine's own (its
  // memory, its compiled code), not the response's copies.
  const bare = await time("/render", list.bytes);
  if (!bare.res.ok) throw new Error(new TextDecoder().decode(bare.buf));
  const afterFirst = memoryOf(pid);
  const first = await time("/render?pixels=1", list.bytes);
  if (!first.res.ok) throw new Error(new TextDecoder().decode(first.buf));
  const afterPixels = memoryOf(pid);
  const n = new DataView(first.buf.buffer).getUint32(0, true);
  const header = JSON.parse(new TextDecoder().decode(first.buf.subarray(4, 4 + n)));
  const rgba = first.buf.subarray(4 + n);
  writeFileSync(
    join(out, "cpu.png"),
    encode({ width: header.width, height: header.height, data: rgba, channels: 4 }),
  );
  writeFileSync(join(out, "cpu.rgba"), rgba);
  const renders = [];
  const empties = [];
  let last = header;
  for (let i = 0; i < runs; i++) {
    empties.push((await time("/noop")).ms);
    const r = await time("/render", list.bytes);
    last = JSON.parse(new TextDecoder().decode(r.buf));
    renders.push(r.ms);
  }
  const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const end = memoryOf(pid);
  const report = {
    board: input.figmaId,
    cache: input.folder.split("/").pop(),
    size: [list.width, list.height],
    displayList: {
      bytes: list.bytes.length,
      layers: list.layers,
      ops: list.ops,
      unsupported: list.unsupported,
    },
    render: header,
    afterRuns: { engineMemory: last.engineMemory, harfBuzzMemory: last.harfBuzzMemory },
    timing: {
      firstMs: Math.round(bare.ms),
      renderMedianMs: Math.round(median(renders)),
      emptyMedianMs: Math.round(median(empties)),
      renderMinusEmptyMs: Math.round(median(renders) - median(empties)),
      renders: renders.map(Math.round),
    },
    workerd: {
      idleRss: idle.rss,
      warmRss: warm.rss,
      afterFirstRenderRss: afterFirst.rss,
      afterPixelsRss: afterPixels.rss,
      endRss: end.rss,
      peakRss: end.hwm,
      firstRenderGrowth: afterFirst.rss - warm.rss,
    },
    loadAverage: readFileSync("/proc/loadavg", "utf8").split(" ").slice(0, 3).map(Number),
  };
  writeFileSync(join(out, "worker.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} finally {
  stop();
}
