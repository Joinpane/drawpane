/**
 * The spike's input: a board of a file converted by kit-parity's `drawpane` step (a folder
 * with `nodes.ndjson`, as `BENCH_FILE` names one), never a path in the repo. Kit content is
 * private and licensed; nothing here is committed.
 *
 * - SPIKE_FILE: the converted folder (falls back to BENCH_FILE).
 * - SPIKE_BOARD: the board's Figma id (`7:53847`) or Drawpane id (`f7-53847`).
 * - SPIKE_REFERENCE: Figma's render of the board at 2× (optional; kit-parity keeps one per
 *   sampled frame in `figma/<id>.png`, which is looked for beside the cache when unset).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { NodeRecord } from "@drawpane/model";

export interface KitInput {
  readonly folder: string;
  readonly boardId: string;
  readonly figmaId: string;
  readonly reference: string | null;
}

export function kitInput(env: NodeJS.ProcessEnv = process.env): KitInput | null {
  const folder = env.SPIKE_FILE ?? env.BENCH_FILE;
  if (!folder) return null;
  const board = env.SPIKE_BOARD ?? "7:53847";
  const figmaId = board.startsWith("f") ? board.slice(1).replace(/-/g, ":") : board;
  const boardId = board.startsWith("f") ? board : `f${board.replace(/:/g, "-")}`;
  const guess = join(folder, "../../figma", `${figmaId.replace(/:/g, "-").replace(/;/g, "_")}.png`);
  const reference = env.SPIKE_REFERENCE ?? (existsSync(guess) ? guess : null);
  return { folder, boardId, figmaId, reference };
}

/** The file's nodes, as lines of JSON. */
export function readNodes(folder: string): NodeRecord[] {
  return readFileSync(join(folder, "nodes.ndjson"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as NodeRecord);
}
