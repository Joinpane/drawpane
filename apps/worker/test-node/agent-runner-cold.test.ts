/**
 * The agent runner's cold load (`agent-runner/src/runner.ts`) with the V8
 * heap capped as a Durable Object's is (the memory check: `pnpm --filter
 * @drawpane/worker memory`, MEMORY_HEAP_MB=64 for the lower cap).
 *
 * #197's review: a snapshot of 2,000 rectangles, each with 32 gradients of
 * 32 stops, passes the SQL pre-check, and the paged engine refuses it at
 * about 41 MB of heap. The runner read the whole snapshot, parsed, before
 * building the editor, so it ran out of heap at 128 MB instead of being
 * refused. It now builds the editor a page at a time as the stream is read,
 * so the meter stops it partway, as it stops the paged engine.
 *
 * The runner's font and render adapters (HarfBuzz and resvg, as
 * WebAssembly) aren't used by a refused load, and are replaced here.
 */
import { getHeapStatistics } from "node:v8";
import { checkNode, ROOT_ID } from "@drawpane/model";
import { describe, expect, it, vi } from "vitest";
import { STANDIN } from "../../agent-runner/src/measurer";
import { FileRunner } from "../../agent-runner/src/runner";
import { AGENT_MAX_HELD } from "../src/rooms/agent-admission";
import type { NodeRow } from "../src/rooms/node-tables";
import { snapshotStream } from "../src/rooms/snapshots";

vi.mock("../../agent-runner/src/harfbuzz", () => ({
  agentMeasurer: () => {
    throw new Error("unused");
  },
  fileFontLoader: () => {
    throw new Error("unused");
  },
}));
vi.mock("../../agent-runner/src/render", () => ({
  headlessRenderer: () => {
    throw new Error("unused");
  },
}));

const MB = 1024 * 1024;
const HEAP_MB = Number(process.env.MEMORY_HEAP_MB ?? 128);
/** What the editor may hold here: as a runner's, or under a fifth of the lower cap. */
const LIMIT = HEAP_MB < 128 ? 12 * MB : AGENT_MAX_HELD;
const gc = () => (globalThis as { gc?: () => void }).gc?.();

const RECTS = 2_000;
const gradient = {
  type: "linear",
  from: { x: 0, y: 0 },
  to: { x: 1, y: 1 },
  stops: Array.from({ length: 32 }, () => ({ position: 0.5, color: "#000000" })),
};
const props = JSON.stringify(
  checkNode({
    id: "R",
    parent: "P",
    key: "a0",
    type: "rect",
    props: { fills: Array.from({ length: 32 }, () => gradient) },
  }).props,
);
const page: NodeRow = { id: "P", parent: ROOT_ID, key: "a0", type: "page", props: "{}" };

function* pages(): Generator<NodeRow[]> {
  yield [page];
  for (let i = 0; i < RECTS; i++)
    yield [{ id: `N${i}`, parent: "P", key: "a0", type: "rect", props }];
}

describe("a cold load of a file too large for the runner", { timeout: 600_000 }, () => {
  it("is refused partway, a page at a time, never read whole first", async () => {
    gc();
    const before = getHeapStatistics().used_heap_size;
    let peak = 0;
    let read = 0;
    const counted = (function* () {
      for (const rows of pages()) {
        read++;
        const heap = getHeapStatistics().used_heap_size;
        if (heap > peak) peak = heap;
        yield rows;
      }
    })();
    const body = snapshotStream({ fileId: "file", revn: 0, at: Date.now() }, counted);
    const runner = new FileRunner({} as never, "file", { measurer: () => STANDIN, limit: LIMIT });
    const answer = await runner.run({
      v: 1,
      fileId: "file",
      tool: "get_jsx",
      input: { id: "N0" },
      source: {
        kind: "snapshot",
        at: 0,
        revn: 0,
        count: RECTS + 1,
        copies: "materialized",
        body,
        txns: [],
      },
    });
    const after = getHeapStatistics().used_heap_size;
    expect(answer).toMatchObject({ ok: false, message: expect.stringMatching(/too large/) });
    // Stopped partway: the rest of the snapshot was never read.
    expect(read).toBeLessThan(RECTS);
    console.log(
      `cold refusal: ${read} of ${RECTS + 1} pages read; heap ${(before / MB).toFixed(1)} MB before, ${(after / MB).toFixed(1)} MB as refused, peak ${(peak / MB).toFixed(1)} MB`,
    );
    // What the meter let it keep, and the page being read: never the whole file.
    expect(after - before).toBeLessThan(LIMIT + 8 * MB);

    // Asked again at the revision it measured: refused at once, nothing read.
    const again = await runner.run({
      v: 1,
      fileId: "file",
      tool: "get_jsx",
      input: { id: "N0" },
      source: { kind: "log", from: 0, revn: 0, count: RECTS + 1, copies: "materialized", txns: [] },
    });
    expect(again).toEqual(answer);
    expect(runner.builds).toBe(1);
  });
});
