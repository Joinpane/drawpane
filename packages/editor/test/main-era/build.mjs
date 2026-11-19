// Builds editor-<rev>.mjs: the editor (its sync engine and model included) as
// it was at <rev>, for tests of what an open tab on older code does with
// what today's room sends (review 8 of #209). Run from the repository root:
//
//   node packages/editor/test/main-era/build.mjs af07ef0
//
// The source comes from git (`git archive`), so CI never needs the old
// history: the built file is what's checked in. esbuild is the one wrangler
// brings (apps/worker); bare imports stay imports, so `zod` resolves from
// this package and harfbuzz and pathkit, loaded lazily, are never loaded.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rev = process.argv[2];
if (!rev) throw new Error("Which revision? node packages/editor/test/main-era/build.mjs <rev>");
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../../..");
const require = createRequire(join(repo, "apps/worker/package.json"));
const wrangler = dirname(require.resolve("wrangler/package.json"));
const { build } = createRequire(join(wrangler, "package.json"))("esbuild");

const short = execFileSync("git", ["rev-parse", "--short=7", rev], { cwd: repo }).toString().trim();
const src = mkdtempSync(join(tmpdir(), "drawpane-main-era-"));
try {
  const archive = join(src, "source.tar");
  execFileSync(
    "git",
    ["archive", "-o", archive, rev, "packages/editor", "packages/model", "packages/raster"],
    { cwd: repo },
  );
  execFileSync("tar", ["-x", "-f", archive, "-C", src]);
  const packages = join(src, "packages");
  await build({
    entryPoints: [join(packages, "editor/src/index.ts")],
    outfile: join(here, `editor-${short}.mjs`),
    bundle: true,
    format: "esm",
    platform: "neutral",
    packages: "external",
    alias: {
      "@drawpane/model": join(packages, "model/src/index.ts"),
      "@drawpane/raster": join(packages, "raster/src/index.ts"),
    },
    tsconfigRaw: "{}",
    minifyWhitespace: true,
    minifySyntax: true,
    legalComments: "none",
    banner: {
      js: `// The editor as it was at ${short}, built by build.mjs beside this file: an open tab on older code, for tests. Don't edit.`,
    },
  });
} finally {
  rmSync(src, { recursive: true, force: true });
}
