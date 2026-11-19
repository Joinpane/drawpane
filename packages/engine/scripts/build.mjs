// Builds the engine's two WebAssembly modules into dist/ (never committed), then holds them to
// their size budgets (gzipped):
//   dist/worker/   the CPU backend alone, for Workers         at most 400 KB
//   dist/browser/  the GPU backend and the CPU backend          at most 1 MB
// The toolchain is this package's mise.toml (Rust with the wasm32 target, wasm-bindgen).
// ENGINE_SKIP_BUILD=1 keeps whatever dist/ holds (CI restores it from its cache).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const here = join(dirname(fileURLToPath(import.meta.url)), "..");
const rust = join(here, "rust");
const BUDGETS = { worker: 400 * 1000, browser: 1000 * 1000 };

const all = [
  { name: "worker", features: [] },
  { name: "browser", features: ["--features", "gpu"] },
];
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
  const env = { ...process.env, RUSTFLAGS: "-C target-feature=+simd128" };
  for (const b of builds) {
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
      "--remove-name-section",
      "--remove-producers-section",
      "--out-dir",
      join(here, "dist", b.name),
      "--out-name",
      "engine",
      join(rust, "target", b.name, "wasm32-unknown-unknown", "release", "drawpane_engine.wasm"),
    ]);
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
