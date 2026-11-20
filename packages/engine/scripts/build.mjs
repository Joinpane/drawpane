// Builds the engine's three WebAssembly modules into dist/ (never committed), then holds them to
// their size budgets (gzipped):
//   dist/worker/   the CPU backend alone, for Workers                 at most 400 KB
//   dist/browser/  the WebGPU backend and the CPU backend             at most 1 MB
//   dist/webgl/    the WebGL2 backend (naga + GL) and CPU (lazy)      at most 1.4 MB
// The toolchain is this package's mise.toml (Rust with the wasm32 target, wasm-bindgen).
// ENGINE_SKIP_BUILD=1 keeps whatever dist/ holds (CI restores it from its cache).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const here = join(dirname(fileURLToPath(import.meta.url)), "..");
const rust = join(here, "rust");
const BUDGETS = { worker: 400 * 1000, browser: 1000 * 1000, webgl: 1400 * 1000 };

/**
 * The Worker build's linear memory may grow to 25 MiB and no further (decision 0040, "Worker
 * memory"): its memory section says so, so a host can't let it grow past its share of an
 * isolate's 128 MB. The browser builds have no maximum.
 */
const WORKER_MEMORY_BYTES = 25 << 20;
const all = [
  {
    name: "worker",
    features: [],
    rustflags: `-C link-arg=--max-memory=${WORKER_MEMORY_BYTES}`,
  },
  { name: "browser", features: ["--features", "gpu"], rustflags: "" },
  { name: "webgl", features: ["--features", "webgl"], rustflags: "" },
];

/**
 * After a trap a module's Wasm instance is unusable, and wasm-bindgen's generated glue normally
 * keeps one mutable module-level `wasm` table shared by all callbacks and timers. Wrapping the
 * generated body in `__drawpaneCreateGlue()` gives every renewed generation its own isolated
 * `wasm` exports, heap, closure table, and timer set, while `__drawpaneQuiesce()` immediately
 * silences timers, closures, and finalizers from the trapped generation so stale async callbacks
 * can never re-enter trapped memory or touch a renewed instance.
 */
function addRenew(file) {
  let js = readFileSync(file, "utf8");
  if (js.includes("__drawpaneCreateGlue")) return;
  for (const name of [
    "let wasmModule, wasmInstance, wasm;",
    "let __wbg_init_promise;",
    "function initSync(",
    "export { initSync, __wbg_init as default };",
  ]) {
    if (!js.includes(name)) {
      throw new Error(`wasm-bindgen's glue changed (no "${name}"): update addRenew in build.mjs`);
    }
  }
  const exportedNames = [];
  js = js.replace(/^export (class|function) (\w+)/gm, (_m, kind, name) => {
    exportedNames.push(name);
    return `${kind} ${name}`;
  });
  if (!exportedNames.includes("Engine")) {
    throw new Error(
      "wasm-bindgen's glue changed (missing Engine export): update addRenew in build.mjs",
    );
  }
  const cachedMemoryViews = [...js.matchAll(/^let (cached\w+Memory\d+)\s*=/gm)].map((m) => m[1]);
  if (cachedMemoryViews.length === 0) {
    throw new Error(
      "wasm-bindgen's glue changed (no cached memory views): update addRenew in build.mjs",
    );
  }
  js = js.replace("export { initSync, __wbg_init as default };", "");

  // Reject re-initialization or late finalize on a quiesced generation so the dead Wasm heap
  // can never be resurrected or returned after __drawpaneQuiesce().
  const beforeInitGuards = js;
  js = js.replace(
    "function __wbg_finalize_init(instance, module) {",
    "function __wbg_finalize_init(instance, module) {\n    if (__drawpaneDead) { wasmModule = module; return undefined; }",
  );
  js = js.replace(
    "function initSync(module) {",
    'function initSync(module) {\n    if (__drawpaneDead) throw new Error("the engine generation was quiesced");',
  );
  js = js.replace(
    "async function __wbg_init(module_or_path) {",
    'async function __wbg_init(module_or_path) {\n    if (__drawpaneDead) throw new Error("the engine generation was quiesced");',
  );
  if (
    js === beforeInitGuards ||
    !js.includes("if (__drawpaneDead) { wasmModule = module; return undefined; }") ||
    js.split('if (__drawpaneDead) throw new Error("the engine generation was quiesced");')
      .length !== 3
  ) {
    throw new Error("wasm-bindgen's init functions changed: update addRenew in build.mjs");
  }

  // Guard FinalizationRegistry destructors so GC of dead-generation objects never touches Wasm.
  js = js.replace(
    /new FinalizationRegistry\((\w+)\s*=>\s*wasm\.([^)]+\([^)]*\))\)/g,
    "new FinalizationRegistry($1 => { if (!__drawpaneDead && wasm) wasm.$2; })",
  );

  // Guard makeMutClosure (and makeClosure if present) so pending callbacks from a trapped
  // generation become no-ops and never invoke or free closures in dead Wasm memory.
  if (js.includes("function makeMutClosure(arg0, arg1, f) {")) {
    const beforeMut = js;
    js = js.replace(
      "const real = (...args) => {",
      "const real = (...args) => {\n        if (__drawpaneDead) return;",
    );
    js = js.replace(
      "wasm.__wbindgen_destroy_closure(state.a, state.b);",
      "if (!__drawpaneDead && wasm) wasm.__wbindgen_destroy_closure(state.a, state.b);",
    );
    if (js === beforeMut) {
      throw new Error("wasm-bindgen's makeMutClosure changed: update addRenew in build.mjs");
    }
  }

  // Track setTimeout / clearTimeout calls made by this generation so __drawpaneQuiesce() cancels
  // all pending WebGL poll ticks and wait timeouts immediately on trap.
  if (js.includes("const ret = setTimeout(arg0, arg1);")) {
    js = js.replace(
      "const ret = setTimeout(arg0, arg1);",
      "const ret = __drawpaneSetTimeout(arg0, arg1);",
    );
    js = js.replace("clearTimeout(arg0);", "__drawpaneClearTimeout(arg0);");
  }

  const allExports = [
    ...exportedNames,
    "initSync",
    "__drawpaneQuiesce",
    "__drawpaneModule",
    "__drawpaneRenew",
  ];
  const wrapped = `export function __drawpaneCreateGlue() {
let __drawpaneDead = false;
const __drawpaneTimers = new Set();
function __drawpaneSetTimeout(cb, ms) {
    if (__drawpaneDead) return 0;
    const id = setTimeout(() => {
        __drawpaneTimers.delete(id);
        if (__drawpaneDead) return;
        cb();
    }, ms);
    __drawpaneTimers.add(id);
    return id;
}
function __drawpaneClearTimeout(id) {
    __drawpaneTimers.delete(id);
    clearTimeout(id);
}
function __drawpaneQuiesce() {
    __drawpaneDead = true;
    for (const id of __drawpaneTimers) clearTimeout(id);
    __drawpaneTimers.clear();
    wasm = undefined;
    wasmInstance = undefined;
    __wbg_init_promise = undefined;
    ${cachedMemoryViews.map((name) => `${name} = null;`).join("\n    ")}
}
function __drawpaneModule() {
    return wasmModule;
}
function __drawpaneRenew() {
    const module = wasmModule;
    if (module === undefined) throw new Error("the engine was never instantiated");
    __drawpaneQuiesce();
    const next = __drawpaneCreateGlue();
    next.initSync({ module });
    return next;
}
${js}
return { ${exportedNames.join(", ")}, initSync, default: __wbg_init, __drawpaneQuiesce, __drawpaneModule, __drawpaneCreateGlue, __drawpaneRenew };
}
const __defaultGlue = __drawpaneCreateGlue();
export const { ${allExports.join(", ")} } = __defaultGlue;
export default __defaultGlue.default;
`;
  writeFileSync(file, wrapped);
}
// ENGINE_ONLY=worker builds one module (while iterating); the size check reads both.
const builds = process.env.ENGINE_ONLY
  ? all.filter((b) => b.name === process.env.ENGINE_ONLY)
  : all;

function run(cmd, args, options = {}) {
  execFileSync(cmd, args, { stdio: "inherit", cwd: rust, ...options });
}

const skip =
  process.env.ENGINE_SKIP_BUILD === "1" &&
  builds.every((b) => existsSync(join(here, "dist", b.name, "engine_bg.wasm")));
if (!skip) {
  try {
    execFileSync("mise", ["--version"], { stdio: "ignore" });
  } catch {
    console.error(
      "The engine needs mise for its Rust toolchain: https://mise.jdx.dev (then `mise install` in packages/engine).",
    );
    process.exit(1);
  }
  try {
    // CI and new checkouts: the folder's toolchain file must be trusted before mise uses it.
    execFileSync("mise", ["trust", "--quiet", join(here, "mise.toml")], { stdio: "ignore" });
  } catch {}
  for (const b of builds) {
    const env = { ...process.env, RUSTFLAGS: `-C target-feature=+simd128 ${b.rustflags}`.trim() };
    run(
      "mise",
      [
        "exec",
        "--",
        "cargo",
        "build",
        "--release",
        "--locked",
        "--target",
        "wasm32-unknown-unknown",
        "--target-dir",
        join(rust, "target", b.name),
        ...b.features,
      ],
      { env },
    );
    run("mise", [
      "exec",
      "--",
      "wasm-bindgen",
      "--target",
      "web",
      // ENGINE_KEEP_NAMES=1 keeps function names, for profiles (larger modules; never shipped).
      ...(process.env.ENGINE_KEEP_NAMES === "1" ? [] : ["--remove-name-section"]),
      "--remove-producers-section",
      "--out-dir",
      join(here, "dist", b.name),
      "--out-name",
      "engine",
      join(rust, "target", b.name, "wasm32-unknown-unknown", "release", "drawpane_engine.wasm"),
    ]);
    addRenew(join(here, "dist", b.name, "engine.js"));
  }
}

const sizes = {};
let over = false;
for (const b of all) {
  const wasm = readFileSync(join(here, "dist", b.name, "engine_bg.wasm"));
  const js = readFileSync(join(here, "dist", b.name, "engine.js"));
  const gz = gzipSync(wasm, { level: 9 }).length;
  sizes[b.name] = {
    wasm: wasm.length,
    wasmGzip: gz,
    glue: js.length,
    glueGzip: gzipSync(js, { level: 9 }).length,
    budgetGzip: BUDGETS[b.name],
  };
  const kb = (n) => `${(n / 1000).toFixed(0)} KB`;
  console.log(
    `engine ${b.name}: ${kb(wasm.length)} WebAssembly, ${kb(gz)} gzipped (budget ${kb(BUDGETS[b.name])}); glue ${kb(js.length)}`,
  );
  if (gz > BUDGETS[b.name]) over = true;
}
mkdirSync(join(here, "dist"), { recursive: true });
writeFileSync(join(here, "dist", "sizes.json"), `${JSON.stringify(sizes, null, 2)}\n`);
if (over) {
  console.error("An engine module is over its size budget (decision 0040).");
  process.exit(1);
}
