/**
 * Whether agent tools may work on a file (decisions 0021, 0026). The
 * headless editor (`agent-engine.ts`) holds the whole file in memory, so a
 * file is admitted only when what it would hold is known to fit, worked out
 * in SQL before anything is read: its layers (as presented, with compact
 * copies) and the bytes of its values.
 *
 * Measured in Node 26 (`test-node/room-bounds.test.ts`, the standin text
 * measurer), what the editor holds once built:
 *
 * - long strings about a heap byte per UTF-8 byte stored: 1.00 for ASCII
 *   and emoji, 0.67 for CJK (two bytes a character in V8, three in UTF-8);
 * - small layers 524 bytes each with their values (rectangles, 210 bytes of
 *   JSON), 624 for texts of 300 characters: under 320 a layer beyond their
 *   UTF-8 bytes;
 * - copies built from their mains (compact copies) 707 bytes each.
 *
 * Building it peaked at 1.4 to 1.5 times what it then held, sampled
 * uncapped (garbage included). So the estimate is AGENT_LAYER_BYTES a
 * stored node, AGENT_COPY_BYTES a copy built, and the UTF-8 bytes of the
 * stored values; at most AGENT_MAX_HELD (48 MB), which leaves a room of
 * 128 MB about 25 MB beside a build's peak and the 17 MB it starts with. A
 * 50,000-layer kit (about 450 bytes of JSON a layer) is about 38 MB.
 */
import type { CopiesFormat } from "@drawpane/model";
import { sumPast } from "./node-tables";

/** The most layers (as presented) a file may have for agents to work on it. */
export const AGENT_MAX_NODES = 50_000;
/** What the headless editor holds for a stored node beyond its values' bytes, about. */
export const AGENT_LAYER_BYTES = 320;
/** What it holds for a copy layer it builds (compact copies), about. */
export const AGENT_COPY_BYTES = 760;
/** The most the headless editor may be estimated to hold. */
export const AGENT_MAX_HELD = 48 << 20;

export type AgentAdmission =
  | { readonly ok: true; readonly held: number }
  | { readonly ok: false; readonly message: string };

const READ_TOOLS = "The read tools (get_outline, find_nodes, get_node) still work.";

/**
 * Whether the file in `nodes` fits the headless editor, and what it would
 * hold. `presented` counts its layers as presented (called only for a
 * compact file of at most AGENT_MAX_NODES stored). The values' bytes are
 * read only until they're past the bound.
 */
export function agentAdmission(
  sql: SqlStorage,
  copies: CopiesFormat,
  presented: () => number,
): AgentAdmission {
  const stored = sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM nodes").one().n;
  // With compact copies the editor holds every copy layer as built: counted as presented.
  const layers = copies === "compact" && stored <= AGENT_MAX_NODES ? presented() : stored;
  if (layers > AGENT_MAX_NODES)
    return {
      ok: false,
      message: `This file is too large for agent tools (${layers.toLocaleString("en")} layers; they work on files of up to ${AGENT_MAX_NODES.toLocaleString("en")}). ${READ_TOOLS}`,
    };
  const own =
    copies === "compact"
      ? sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM nodes WHERE type != 'override'").one().n
      : stored;
  const fixed = AGENT_LAYER_BYTES * stored + AGENT_COPY_BYTES * Math.max(0, layers - own);
  const held = fixed + sumPast(sql, "nodes", "LENGTH(CAST(props AS BLOB))", AGENT_MAX_HELD - fixed);
  if (held <= AGENT_MAX_HELD) return { ok: true, held };
  return {
    ok: false,
    message: `This file is too large for agent tools (editing it would take over ${mb(held)} MB of memory, and they work on files of up to ${mb(AGENT_MAX_HELD)} MB; long texts take the most). ${READ_TOOLS}`,
  };
}

/** What following `ops` may add to what the editor holds: their JSON, and a layer for each create. */
export function agentGrowth(ops: readonly { readonly op: string }[]): number {
  let creates = 0;
  for (const op of ops) if (op.op === "create") creates++;
  // Two bytes a character: V8 holds text past Latin-1 so.
  return 2 * JSON.stringify(ops).length + AGENT_LAYER_BYTES * creates;
}

const mb = (bytes: number) => Math.floor(bytes / (1 << 20)).toLocaleString("en");
