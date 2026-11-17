// drawpane-oom-probe-runner: the runner side of decision 0033's migration step 0.
// The same operations are offered three ways: fetch on the default entrypoint, RPC on the default
// entrypoint (a WorkerEntrypoint), and a Durable Object class (RunnerDO) with fetch and RPC.
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import growWasm from "./grow.wasm";

const MiB = 2 ** 20;

// Random values aren't allowed at module scope, so the isolate id is made on first use.
let isolateId;
const iid = () => {
  isolateId ??= crypto.randomUUID().slice(0, 8);
  return isolateId;
};
let isolateCalls = 0;

// Everything an operation allocates stays reachable from here, so the garbage collector can't
// give it back before the isolate reaches its limit.
const held = [];

/** Grows a fresh instance's linear memory 1 MiB at a time, writing to every new page. */
function growWasmMemory(targetMiB) {
  const instance = new WebAssembly.Instance(growWasm, {});
  held.push(instance);
  const { grow, memory } = instance.exports;
  while (memory.buffer.byteLength < targetMiB * MiB) {
    const before = memory.buffer.byteLength;
    if (grow(16) === -1) return { grewTo: before / MiB, refused: true };
    new Uint8Array(memory.buffer, before).fill(1);
  }
  return { grewTo: memory.buffer.byteLength / MiB, refused: false };
}

/** Pushes 8 MiB arrays of distinct doubles until the isolate dies, or `capMiB` is reached. */
function growJsHeap(capMiB) {
  let total = 0;
  while (total < capMiB) {
    const chunk = new Float64Array(MiB);
    chunk.fill(Math.random());
    // A plain array of boxed numbers keeps the growth on the V8 heap, not in an ArrayBuffer.
    held.push(Array.from(chunk.subarray(0, 512 * 1024), (x, i) => x + i));
    total += 8;
  }
  return { grewTo: total };
}

/** Holds `mb` MiB in this isolate (0 releases everything held). */
function ballast(mb) {
  held.length = 0;
  if (mb > 0) held.push(new Uint8Array(mb * MiB).fill(1));
  return { holding: mb };
}

function run(op, params) {
  isolateCalls++;
  const t = Date.now();
  let result;
  if (op === "wasm") result = growWasmMemory(params.mb ?? 200);
  else if (op === "heap") result = growJsHeap(params.mb ?? 4096);
  else if (op === "ballast") result = ballast(params.mb ?? 0);
  else if (op === "ping") result = {};
  else throw new Error(`unknown op ${op}`);
  return { ...result, op, iid: iid(), isolateCalls, ms: Date.now() - t };
}

const paramsOf = (url) => {
  const mb = url.searchParams.get("mb");
  return mb === null ? {} : { mb: Number(mb) };
};

export class RunnerDO extends DurableObject {
  calls = 0;
  started = Date.now();

  info() {
    return { iid: iid(), objectCalls: this.calls, objectStarted: this.started };
  }
  op(op, params = {}) {
    this.calls++;
    return { ...run(op, params), objectCalls: this.calls, objectStarted: this.started };
  }
  fetch(request) {
    const url = new URL(request.url);
    const op = url.pathname.slice(1);
    if (op === "info") return Response.json(this.info());
    return Response.json(this.op(op, paramsOf(url)));
  }
}

export default class Runner extends WorkerEntrypoint {
  op(op, params = {}) {
    return run(op, params);
  }
  fetch(request) {
    const url = new URL(request.url);
    return Response.json(run(url.pathname.slice(1), paramsOf(url)));
  }
}
