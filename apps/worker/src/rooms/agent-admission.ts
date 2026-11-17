/**
 * Whether agent tools may work on a file (decisions 0021, 0026). The
 * headless editor (`agent-engine.ts`) holds the whole file in memory, and a
 * Durable Object that runs out of memory can't catch it. So what it holds
 * is bounded as it's built, never predicted:
 *
 * - A meter (`agentMeter`, a `BuildBudget` of AGENT_MAX_HELD) counts what
 *   the editor keeps as it keeps it: each node as it's parsed (`storedBytes`:
 *   its record, values and the store's entries), each copy layer as it's
 *   built, the change log. The file is read a page at a time, each page
 *   bounded by characters (`SqlNodeStore.records`), so its serialized and
 *   parsed forms are never both held whole. Past the meter's limit the
 *   build stops, before keeping what would pass it, with `AgentTooLarge`.
 * - The warm editor stays metered: every transaction it follows is counted
 *   as applied, and copy layers it builds are refused past the limit, so
 *   one that grows past it is let go of, and the next call builds it again
 *   (and is refused).
 * - `agentPrecheck` is a fast first filter in SQL, before a row is read:
 *   the layer limit, and a lower bound of what the meter will count. It
 *   refuses only files the meter would refuse anyway.
 *
 * AGENT_MAX_HELD (48 MB) leaves a room of 128 MB its baseline (17 MB on
 * Workers), a page being parsed (at most PAGE_CHARS characters, read and
 * parsed: under 20 MB), and a tool's own work beside what's held. Measured
 * in Node 26 (`test-node/agent-meter.test.ts`): the meter counts at least
 * what each shape holds once built (long ASCII, CJK and emoji text, nested
 * fills, rectangles, short texts, shallow and deep compact copies).
 */

import { ToolFailure } from "@drawpane/editor";
import {
  BuildBudget,
  BuildTooLarge,
  type CopiesFormat,
  LEAST_OBJECT_BYTES,
  STORED_NODE_BYTES,
} from "@drawpane/model";
import { sumPast } from "./node-tables";

/** The most layers (as presented) a file may have for agents to work on it. */
export const AGENT_MAX_NODES = 50_000;
/** The most the headless editor may hold, as its meter counts it. */
export const AGENT_MAX_HELD = 48 << 20;

/**
 * The least the meter counts for a row, in SQL: a stored node's own bytes
 * and ids, an object for its values, and a header and a byte a character
 * for every string among them (`heapBytes` counts at least that; keys and
 * numbers aren't counted here). So a file of long texts is refused here,
 * before a row is read; one whose values are many small objects (which the
 * meter counts closer) passes, and the meter refuses it as it's built.
 */
const LEAST_ROW_BYTES = `(${STORED_NODE_BYTES + LEAST_OBJECT_BYTES} + LENGTH(id) + LENGTH(parent) + LENGTH(key)
  + COALESCE((SELECT SUM(16 + LENGTH(atom)) FROM json_tree(props) WHERE type = 'text'), 0))`;

const READ_TOOLS = "The read tools (get_outline, find_nodes, get_node) still work.";

export type AgentAdmission =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

/** A file the headless editor can't hold: a refusal, answered as the tool's failure. */
export class AgentTooLarge extends ToolFailure {
  constructor(message: string) {
    super(message);
  }
}

/** Why a file of `layers` layers (as presented) is refused. */
export function tooManyLayers(layers: number): string {
  return `This file is too large for agent tools (${layers.toLocaleString("en")} layers; they work on files of up to ${AGENT_MAX_NODES.toLocaleString("en")}). ${READ_TOOLS}`;
}

/** Why a file the meter stopped at is refused. */
export function tooMuchMemory(limit = AGENT_MAX_HELD): string {
  return `This file is too large for agent tools (editing it would take more than the ${mb(limit)} MB of memory they work in; long texts take the most). ${READ_TOOLS}`;
}

/** The meter the headless editor counts what it keeps in. */
export function agentMeter(limit = AGENT_MAX_HELD): BuildBudget {
  return new BuildBudget({ bytes: limit });
}

/** `error` as the refusal it means, when it's the meter stopping a build; otherwise null. */
export function asTooLarge(error: unknown, limit = AGENT_MAX_HELD): AgentTooLarge | null {
  if (error instanceof AgentTooLarge) return error;
  if (error instanceof BuildTooLarge) return new AgentTooLarge(tooMuchMemory(limit));
  return null;
}

/**
 * The fast first filter, in SQL before a row is read: refused when the file
 * has more layers (as presented: `presented`, called only for a compact
 * file of at most AGENT_MAX_NODES stored) than agents work on, or when even
 * the least the meter could count for it is past its limit. Admitted here
 * doesn't mean it fits: the meter says, as the editor is built.
 */
export function agentPrecheck(
  sql: SqlStorage,
  copies: CopiesFormat,
  presented: () => number,
  limit = AGENT_MAX_HELD,
): AgentAdmission {
  const stored = sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM nodes").one().n;
  const layers = copies === "compact" && stored <= AGENT_MAX_NODES ? presented() : stored;
  if (layers > AGENT_MAX_NODES) return { ok: false, message: tooManyLayers(layers) };
  if (sumPast(sql, "nodes", LEAST_ROW_BYTES, limit) > limit)
    return { ok: false, message: tooMuchMemory(limit) };
  return { ok: true };
}

const mb = (bytes: number) => Math.floor(bytes / (1 << 20)).toLocaleString("en");
