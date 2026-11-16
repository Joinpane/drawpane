/**
 * Real .fig files, read and converted as the import does: off unless
 * $FIG_FILES names a folder of them (searched one level down too, so a
 * folder of `<name>/file.fig` works). For each file: whether it imports,
 * why not, pages and layers, how many copies stay linked to their mains,
 * images, the notes the person importing would see, how long each step
 * took, and the process's peak memory so far (run one file at a time, with
 * $FIG_ONLY, to measure each on its own). Every converted file must also pass the
 * checks the server runs on an import. A report goes to $FIG_REPORT, or
 * report.json in the folder.
 *
 *   FIG_FILES=/path/to/figs pnpm --filter @drawpane/fig exec vitest run test/fig-compat.test.ts
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { pinInstances } from "@drawpane/editor";
import { convertFile } from "@drawpane/figma";
import { applyTransaction, MemoryStore, type NodeRecord, type Op, ROOT_ID } from "@drawpane/model";
import { describe, expect, it } from "vitest";
import { readFig } from "../src";

const DIR = process.env.FIG_FILES;
const ONLY = process.env.FIG_ONLY;

function figFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (name.endsWith(".fig")) out.push(path);
    else if (statSync(path).isDirectory())
      for (const inner of readdirSync(path).sort())
        if (inner.endsWith(".fig")) out.push(join(path, inner));
  }
  return out;
}

/** Why the server would refuse these nodes, as an import's ops (parents first), or null. */
function refusal(nodes: readonly NodeRecord[]): string | null {
  const byParent = new Map<string, NodeRecord[]>();
  for (const n of nodes) byParent.set(n.parent, [...(byParent.get(n.parent) ?? []), n]);
  const ops: Op[] = [];
  const queue = [...(byParent.get(ROOT_ID) ?? [])];
  for (let n = queue.shift(); n; n = queue.shift()) {
    ops.push({
      op: "create",
      id: n.id,
      type: n.type,
      parent: n.parent,
      key: n.key,
      props: n.props,
    });
    queue.push(...(byParent.get(n.id) ?? []));
  }
  if (ops.length !== nodes.length) return `${nodes.length - ops.length} layers have no parent`;
  try {
    applyTransaction(new MemoryStore([]), ops, { rollback: false });
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}

const seconds = (ms: number) => Math.round(ms / 100) / 10;
const megabytes = (bytes: number) => Math.round(bytes / (1024 * 1024));

interface Row {
  file: string;
  size: number;
  version?: number;
  error?: string;
  invalid?: string;
  pages?: number;
  layers?: number;
  instances?: number;
  linked?: number;
  detached?: number;
  images?: number;
  json?: number;
  notes?: string[];
  seconds?: { read: number; convert: number; pin: number };
  /** The process's peak resident memory once this file is done. */
  peakMB?: number;
}

describe.skipIf(!DIR)(".fig files: import as the dialog does", () => {
  it("reads and converts every file", async () => {
    const dir = DIR as string;
    const rows: Row[] = [];
    for (const path of figFiles(dir).filter((p) => !ONLY || p.includes(ONLY))) {
      const bytes = new Uint8Array(readFileSync(path));
      const row: Row = { file: relative(dir, path), size: megabytes(bytes.length) };
      rows.push(row);
      try {
        const t0 = performance.now();
        const fig = await readFig(bytes, { fileName: path.split("/").pop() ?? "" });
        const t1 = performance.now();
        const converted = convertFile(fig.file, {
          images: (ref) => (fig.images.has(ref) ? "0".repeat(64) : null),
        });
        const t2 = performance.now();
        const pinned = pinInstances(converted.nodes);
        const t3 = performance.now();
        Object.assign(row, {
          version: fig.version,
          pages: fig.pages,
          layers: converted.nodes.filter((n) => n.type !== "page").length,
          instances: converted.nodes.filter((n) => typeof n.props.instanceOf === "string").length,
          linked: converted.nodes.filter((n) => typeof n.props.mirrors === "string").length,
          detached: pinned.detached,
          images: fig.images.size,
          json: megabytes(JSON.stringify(pinned.nodes).length),
          notes: [...fig.notes.lines(), ...converted.notes.lines()],
          seconds: { read: seconds(t1 - t0), convert: seconds(t2 - t1), pin: seconds(t3 - t2) },
        });
        const refused = refusal(pinned.nodes);
        if (refused) row.invalid = refused;
      } catch (error) {
        row.error = (error as Error).message;
      } finally {
        row.peakMB = Math.round(process.resourceUsage().maxRSS / 1024);
      }
    }
    const report = process.env.FIG_REPORT ?? join(dir, "report.json");
    writeFileSync(report, `${JSON.stringify(rows, null, 2)}\n`);
    for (const row of rows)
      process.stdout.write(
        `${row.file}: ${row.error ?? row.invalid ?? `${row.pages} pages, ${row.layers} layers, ${row.instances} instances, ${row.linked} linked layers, ${row.detached} detached, ${row.images} images, ${row.json} MB, read ${row.seconds?.read} s, convert ${row.seconds?.convert} s, peak ${row.peakMB} MB`}\n`,
      );
    expect(existsSync(report)).toBe(true);
    expect(rows.filter((r) => r.invalid)).toEqual([]);
  }, 1_800_000);
});
