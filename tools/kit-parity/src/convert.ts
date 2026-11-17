/**
 * The Drawpane side's input: a .fig converted exactly as the dashboard's
 * import does it (`apps/web/src/dashboard/fig-import.ts` and `fig.worker.ts`):
 * `openFig`, `read` (the whole file), images as the server would store them,
 * `convertFile`, then `pinInstances`. The result is cached, because a
 * 500,000-layer kit takes many minutes to read: nodes as lines of JSON, the
 * images by hash, and what the import noted.
 *
 * The cache is keyed by the .fig's bytes and by the source of every package
 * the conversion runs through, so a change to the reader or the converter
 * (the changes this harness judges) converts again, and nothing else does.
 * A change to this file's own steps should be run with a fresh cache folder.
 */
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { pinInstances } from "@drawpane/editor";
import { openFig } from "@drawpane/fig";
import { convertFile } from "@drawpane/figma";
import { mediaProblem, sniffImage } from "@drawpane/model";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
/** What a conversion runs through: a change to any of these converts again. */
const SOURCES = [
  "packages/fig",
  "packages/figma",
  "packages/model",
  "packages/editor",
  "packages/import-kit",
];

function walk(path: string, out: string[]): void {
  const stat = statSync(path);
  if (stat.isFile()) {
    out.push(path);
    return;
  }
  for (const name of readdirSync(path).sort()) {
    if (name === "node_modules" || name === "test" || name.startsWith(".")) continue;
    walk(join(path, name), out);
  }
}

/** The cache key: the .fig's bytes and the converter's source. */
export function cacheKey(fig: Uint8Array): string {
  const hash = createHash("sha256").update(fig);
  const files: string[] = [];
  for (const source of SOURCES) walk(join(ROOT, source), files);
  for (const file of files) {
    hash.update(relative(ROOT, file));
    hash.update("\0");
    hash.update(readFileSync(file));
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 16);
}

export interface Converted {
  /** The folder holding nodes.ndjson, images/ and meta.json. */
  readonly dir: string;
  readonly cached: boolean;
}

const seconds = (since: number) => `${((Date.now() - since) / 1000).toFixed(1)} s`;

/**
 * Converts `figPath` into `cacheDir/<key>/`, unless that's there already.
 * `log` hears progress.
 */
export async function convertFig(
  figPath: string,
  cacheDir: string,
  log: (line: string) => void = console.log,
): Promise<Converted> {
  const bytes = new Uint8Array(readFileSync(figPath));
  const key = cacheKey(bytes);
  const dir = join(cacheDir, key);
  if (existsSync(join(dir, "meta.json"))) return { dir, cached: true };
  const started = Date.now();
  log(`Converting ${figPath} (cache ${key})`);

  let stage = "";
  const opened = await openFig(bytes, {
    fileName: figPath.split("/").pop() ?? "file.fig",
    onProgress: (p) => {
      const now = p.stage === "pages" ? `pages ${p.done}/${p.total}` : p.stage;
      if (now !== stage) log(`  ${now} (${seconds(started)})`);
      stage = now;
    },
  });
  log(
    `  opened: ${opened.pages.length} pages, about ${opened.layers} layers (${seconds(started)})`,
  );
  const fig = await opened.read({
    onProgress: (p) => {
      const now = p.stage === "pages" ? `pages ${p.done}/${p.total}` : p.stage;
      if (now !== stage) log(`  ${now} (${seconds(started)})`);
      stage = now;
    },
  });
  log(`  read: ${fig.layers} layers, ${fig.images.size} images (${seconds(started)})`);

  // Images as the server takes them (`POST /files/:id/media`): content-addressed by SHA-256,
  // refused (null, so the converter leaves them out) when the server would refuse them.
  const tmp = `${dir}.tmp-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(join(tmp, "images"), { recursive: true });
  const hashes = new Map<string, string>();
  const images: { sha: string; mime: string }[] = [];
  for (const [ref, image] of fig.images) {
    const sniffed = sniffImage(image.bytes);
    if (!sniffed || mediaProblem(image.bytes.byteLength, sniffed)) continue;
    const sha = createHash("sha256").update(image.bytes).digest("hex");
    hashes.set(ref, sha);
    if (!images.some((i) => i.sha === sha)) {
      writeFileSync(join(tmp, "images", sha), image.bytes);
      images.push({ sha, mime: image.mime });
    }
  }

  const converted = convertFile(fig.file, { images: (ref) => hashes.get(ref) ?? null });
  log(`  converted: ${converted.nodes.length} nodes (${seconds(started)})`);
  const pinned = pinInstances(converted.nodes);
  log(
    `  pinned: ${pinned.pinned} properties kept, ${pinned.detached} copies detached (${seconds(started)})`,
  );

  const fd = openSync(join(tmp, "nodes.ndjson"), "w");
  let chunk: string[] = [];
  for (const node of pinned.nodes) {
    chunk.push(JSON.stringify(node));
    if (chunk.length >= 5000) {
      writeSync(fd, `${chunk.join("\n")}\n`);
      chunk = [];
    }
  }
  if (chunk.length > 0) writeSync(fd, `${chunk.join("\n")}\n`);
  closeSync(fd);
  writeFileSync(
    join(tmp, "meta.json"),
    `${JSON.stringify(
      {
        key,
        fig: figPath.split("/").pop(),
        nodes: pinned.nodes.length,
        layers: pinned.nodes.filter((n) => n.type !== "page").length,
        images,
        pinned: pinned.pinned,
        detached: pinned.detached,
        notes: [...fig.notes.lines(), ...converted.notes.lines()],
        seconds: Math.round((Date.now() - started) / 1000),
      },
      null,
      2,
    )}\n`,
  );
  rmSync(dir, { recursive: true, force: true });
  renameSync(tmp, dir);
  log(`  saved to ${dir} (${seconds(started)})`);
  return { dir, cached: false };
}
