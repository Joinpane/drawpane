# Spike notes for decision 0033: capped WebAssembly in resvg and HarfBuzz

Run on 2026-11-17 in Node 26.13.0 on the project VM (arm64), against the exact modules the Worker bundles: `@resvg/resvg-wasm` 2.6.2 and `harfbuzzjs` 1.6.4 with this repo's patch. The scripts are standalone and read the modules from an installed checkout (`D` and `H` below). Nothing here runs on Cloudflare. Node's WebAssembly behaves as V8's does in workerd, but what Cloudflare does at the isolate's 128 MB is decision 0033's migration step 0.

```sh
N=node   # Node 26
D=node_modules/.pnpm/@resvg+resvg-wasm@2.6.2/node_modules/@resvg/resvg-wasm
H=$(echo node_modules/.pnpm/harfbuzzjs@1.6.4_patch*/node_modules/harfbuzzjs/dist)
F=apps/web/e2e/fixtures/Inter-Variable.ttf     # 190,304 bytes
```

## Results

| Run | Command | Output |
| --- | --- | --- |
| Memory limits as shipped | `$N limits.mjs $D/index_bg.wasm $H/harfbuzz.wasm` | resvg `{ flag: 0, min: 23 }` (no maximum); HarfBuzz `{ flag: 1, min: 4, max: 32768 }` |
| resvg uncapped, 1536 px | `$N resvg-cap.mjs $D 0 0.75` | renders; memory 1.4 → 200.9 MiB in 6,154 ms; stays 200.9 after `free()` |
| resvg 64 MiB cap | `$N resvg-cap.mjs $D 64 0.75` | throws in 117 ms, memory 55.9 MiB; the error shown is wasm-bindgen's "recursive use of an object" from `free()` in `finally`, hiding `RuntimeError: unreachable` |
| resvg 32 MiB cap | `$N resvg-cap.mjs $D 32 0.75` | throws in 164 ms, memory 28.7 MiB |
| resvg 64 MiB cap, 205 px | `$N resvg-cap.mjs $D 64 0.1` | renders; memory 5.3 MiB |
| resvg after 0 / 1 / 2 failures at 48 MiB | `$N resvg-repeat.mjs $D 48 0` (then `1`, `2`) | a 1024 px render with one group: ok at 9.8 MiB with no failure before it; after one failure `RuntimeError: unreachable` at 46.8 MiB, and after two the same |
| resvg set up twice | `$N resvg-reinit.mjs $D` | "Already initialized. The `initWasm()` function can be used only once." |
| HarfBuzz uncapped, 800 faces | `$N harfbuzz-cap.mjs $H $F 0` | 172.3 MiB; reference width 16,652 before and after |
| HarfBuzz 48 MiB cap | `$N harfbuzz-cap.mjs $H $F 48` | weight 361 throws `RuntimeError: memory access out of bounds` at 48.0 MiB; **the reference font then measures 0** |
| Fresh instance from a compiled module | `$N instantiate-cost.mjs $D/index_bg.wasm $H/harfbuzz.wasm` | resvg median 0.41 ms (worst 9.14); HarfBuzz median 0.25 ms (worst 10.77), 50 each |

What they show:

- A cap turns a runaway allocation into a trap, which can be caught.
- The instance isn't usable after that trap. resvg leaks what the failed render held and can't be set up again. HarfBuzz's glue copies font data to `malloc`'s 0 when an allocation fails, which corrupts the instance without an error.
- A fresh instance per call is cheap.

## Scripts

### `wasm-limits.mjs`

```js
// Reads and rewrites a WebAssembly module's own memory limits (section 5).
function uleb(buf, pos) { let r = 0, s = 0, b; do { b = buf[pos++]; r += (b & 0x7f) * 2 ** s; s += 7; } while (b & 0x80); return [r, pos]; }
function enc(n) { const out = []; do { let b = n & 0x7f; n = Math.floor(n / 128); if (n) b |= 0x80; out.push(b); } while (n); return out; }
export function memoryLimits(bytes) {
  let pos = 8;
  while (pos < bytes.length) {
    const id = bytes[pos++]; let size; [size, pos] = uleb(bytes, pos);
    if (id === 5) { let n, p = pos; [n, p] = uleb(bytes, p); const flag = bytes[p++]; let min, max; [min, p] = uleb(bytes, p); if (flag & 1) [max, p] = uleb(bytes, p); return { flag, min, max }; }
    pos += size;
  }
  return null;
}
/** The module with its memory's maximum set to `maxPages` (64 KiB each). */
export function withMaximum(bytes, maxPages) {
  let pos = 8; const parts = [bytes.subarray(0, 8)];
  while (pos < bytes.length) {
    const start = pos; const id = bytes[pos++]; let size; [size, pos] = uleb(bytes, pos); const body = pos; pos += size;
    if (id !== 5) { parts.push(bytes.subarray(start, pos)); continue; }
    let n, p = body; [n, p] = uleb(bytes, p); if (n !== 1) throw new Error("one memory expected");
    const flag = bytes[p++]; let min; [min, p] = uleb(bytes, p); if (flag & 1) [, p] = uleb(bytes, p);
    const content = [...enc(1), 0x01, ...enc(min), ...enc(maxPages)];
    parts.push(Uint8Array.from([5, ...enc(content.length), ...content]));
  }
  const out = new Uint8Array(parts.reduce((a, b) => a + b.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out;
}
```

### `limits.mjs`

```js
import { readFileSync } from "node:fs";
import { memoryLimits } from "./wasm-limits.mjs";
for (const p of process.argv.slice(2)) console.log(p.split("/").slice(-2).join("/"), memoryLimits(readFileSync(p)));
```

### `resvg-cap.mjs`

```js
// Spike for decision 0033: resvg with a capped linear memory, on PR #173 review 2's
// nested-groups case (20 nested 2048x2048 frames at opacity 0.9, inside a clipping frame).
import { readFileSync } from "node:fs";
import { withMaximum } from "./wasm-limits.mjs";
const dir = process.argv[2]; const capMiB = Number(process.argv[3] ?? 0); const zoom = Number(process.argv[4] ?? 0.75);
const { initWasm, Resvg } = await import(`${dir}/index.mjs`);
let bytes = readFileSync(`${dir}/index_bg.wasm`);
if (capMiB) bytes = withMaximum(bytes, capMiB * 16);
let memory;
const realInstantiate = WebAssembly.instantiate;
WebAssembly.instantiate = async (...a) => { const r = await realInstantiate(...a); memory = (r.instance ?? r).exports.memory; return r; };
await initWasm(bytes);
const mib = () => (memory.buffer.byteLength / 2 ** 20).toFixed(1);
let inner = "";
for (let i = 0; i < 20; i++) inner = `<g opacity="0.9"><rect width="2048" height="2048" fill="#f00"/>${inner}</g>`;
const heavy = `<svg xmlns="http://www.w3.org/2000/svg" width="2048" height="2048"><clipPath id="c"><rect width="2048" height="2048"/></clipPath><g clip-path="url(#c)">${inner}</g></svg>`;
const light = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#00f"/></svg>`;
const draw = (svg, z) => { const r = new Resvg(svg, { fitTo: { mode: "zoom", value: z } }); try { const img = r.render(); try { return img.asPng().length; } finally { img.free(); } } finally { r.free(); } };
console.log(`cap ${capMiB || "none"} MiB, zoom ${zoom}, memory before ${mib()} MiB`);
const t = performance.now();
try { console.log("heavy ok, png bytes", draw(heavy, zoom)); }
catch (e) { console.log("heavy threw:", e.constructor.name, String(e.message).slice(0, 80)); }
console.log(`after heavy: memory ${mib()} MiB, ${(performance.now() - t).toFixed(0)} ms`);
for (let i = 0; i < 3; i++) {
  try { console.log(`light #${i} ok, png bytes`, draw(light, 1)); }
  catch (e) { console.log(`light #${i} threw:`, e.constructor.name, String(e.message).slice(0, 80)); }
}
console.log(`end: memory ${mib()} MiB`);
```

### `resvg-repeat.mjs`

```js
// After a capped resvg traps, does what the failed render held leak? Ten failures, then a light render.
import { readFileSync } from "node:fs";
import { withMaximum } from "./wasm-limits.mjs";
const dir = process.argv[2]; const capMiB = Number(process.argv[3]);
const { initWasm, Resvg } = await import(`${dir}/index.mjs`);
let memory; const real = WebAssembly.instantiate;
WebAssembly.instantiate = async (...a) => { const r = await real(...a); memory = (r.instance ?? r).exports.memory; return r; };
await initWasm(withMaximum(readFileSync(`${dir}/index_bg.wasm`), capMiB * 16));
const mib = () => (memory.buffer.byteLength / 2 ** 20).toFixed(1);
let inner = ""; for (let i = 0; i < 20; i++) inner = `<g opacity="0.9"><rect width="2048" height="2048" fill="#f00"/>${inner}</g>`;
const heavy = `<svg xmlns="http://www.w3.org/2000/svg" width="2048" height="2048">${inner}</svg>`;
const mid = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><g opacity="0.5"><rect width="1024" height="1024" fill="#0f0"/></g></svg>`;
function draw(svg, z) {
  const r = new Resvg(svg, { fitTo: { mode: "zoom", value: z } });
  let img;
  try { img = r.render(); return img.asPng().length; }
  catch (e) { return `threw ${e.constructor.name}: ${String(e.message).slice(0, 40)}`; }
  finally { try { img?.free(); r.free(); } catch { /* the trap left it borrowed: leaked */ } }
}
for (let i = 0; i < Number(process.argv[4] ?? 10); i++) console.log(`heavy #${i}:`, draw(heavy, 0.75), `memory ${mib()} MiB`);
console.log("mid (1024 px, one group):", draw(mid, 1), `memory ${mib()} MiB`);
```

### `resvg-reinit.mjs`

```js
import { readFileSync } from "node:fs";
const dir = process.argv[2];
const { initWasm } = await import(`${dir}/index.mjs`);
const bytes = readFileSync(`${dir}/index_bg.wasm`);
await initWasm(bytes);
try { await initWasm(bytes); console.log("second initWasm ok"); } catch (e) { console.log("second initWasm threw:", e.message); }
```

### `harfbuzz-cap.mjs`

```js
// Spike for decision 0033: HarfBuzz with a capped linear memory. One Blob/Face/Font per weight
// of the Inter variable font, as review 2's font-faces case does, until memory runs out.
import { readFileSync } from "node:fs";
import { withMaximum } from "./wasm-limits.mjs";
const [dir, font, capArg] = process.argv.slice(2); const capMiB = Number(capArg);
let memory;
globalThis.__drawpaneHarfBuzz = {
  instantiateWasm(imports, done) {
    let bytes = readFileSync(`${dir}/harfbuzz.wasm`);
    if (capMiB) bytes = withMaximum(bytes, capMiB * 16);
    WebAssembly.instantiate(bytes, imports).then(({ instance, module }) => { memory = instance.exports.memory; done(instance, module); });
    return {};
  },
};
const hb = await import(`${dir}/index.mjs`);
const bytes = readFileSync(font);
const mib = () => (memory.buffer.byteLength / 2 ** 20).toFixed(1);
const ref = new hb.Font(new hb.Face(new hb.Blob(bytes), 0));
const width = (f) => { const b = new hb.Buffer(); b.addText("Hamburgefonstiv"); b.guessSegmentProperties(); hb.shape(f, b); return b.getGlyphPositions().reduce((a, g) => a + g.xAdvance, 0); };
const before = width(ref);
const held = []; let outcome = "all 800 made";
for (let w = 100; w < 900; w++) {
  try {
    const face = new hb.Face(new hb.Blob(bytes), 0); const f = new hb.Font(face); held.push(f);
    if (w % 100 === 0) console.log(`weight ${w}: memory ${mib()} MiB`);
  } catch (e) { outcome = `weight ${w} threw ${e.constructor.name}: ${String(e.message).slice(0, 60)}`; break; }
}
console.log(outcome, `memory ${mib()} MiB`);
try { console.log(`reference font width before ${before}, after ${width(ref)}`); } catch (e) { console.log("reference font after threw", e.constructor.name, e.message.slice(0, 60)); }
```

### `instantiate-cost.mjs`

```js
// How long a fresh instance of an already-compiled module takes (imports stubbed; nothing is run).
import { readFileSync } from "node:fs";
for (const p of process.argv.slice(2)) {
  const module = new WebAssembly.Module(readFileSync(p));
  const imports = {};
  for (const i of WebAssembly.Module.imports(module)) {
    imports[i.module] ??= {};
    imports[i.module][i.name] = i.kind === "function" ? () => 0 : i.kind === "memory" ? new WebAssembly.Memory({ initial: 256 }) : i.kind === "table" ? new WebAssembly.Table({ initial: 4096, element: "anyfunc" }) : new WebAssembly.Global({ value: "i32", mutable: true }, 0);
  }
  const times = [];
  for (let n = 0; n < 50; n++) { const t = performance.now(); new WebAssembly.Instance(module, imports); times.push(performance.now() - t); }
  times.sort((a, b) => a - b);
  console.log(p.split("/").pop(), `median ${times[25].toFixed(2)} ms, worst ${times[49].toFixed(2)} ms over 50`);
}
```

