/**
 * What resolving variables and styles keeps (decision 0034, #186's review
 * F16), against the meter the room's headless editor is bounded by: the
 * token view's indexes and the resolved nodes it caches are counted in it,
 * so the heap a token-heavy document holds after every layer is read is at
 * most what its meter counts. Run in the memory check
 * (`pnpm --filter @drawpane/worker memory`).
 */
import { getHeapStatistics } from "node:v8";
import { Doc } from "@drawpane/editor";
import { BuildBudget, type NodeRecord, ROOT_ID } from "@drawpane/model";
import { expect, it } from "vitest";

const MB = 1024 * 1024;
const SCALE = Number(process.env.MEMORY_HEAP_MB ?? 128) < 128 ? 0.5 : 1;
/** What a heap measurement varies by between runs (see agent-meter.test.ts). */
const NOISE = 512 * 1024;
const used = () => {
  const gc = (globalThis as { gc?: () => void }).gc;
  gc?.();
  gc?.();
  return getHeapStatistics().used_heap_size;
};

function* bound(count: number): Generator<NodeRecord> {
  yield { id: "p", type: "page", parent: ROOT_ID, key: "a0", props: {} };
  yield {
    id: "c",
    type: "collection",
    parent: ROOT_ID,
    key: "a0",
    props: {
      modes: [
        { id: "light", name: "Light" },
        { id: "dark", name: "Dark" },
      ],
    },
  };
  yield {
    id: "v",
    type: "variable",
    parent: "c",
    key: "a0",
    props: { variableType: "color", values: { light: "#ffffff", dark: "#000000" } },
  };
  yield {
    id: "n",
    type: "variable",
    parent: "c",
    key: "a0",
    props: { variableType: "number", values: { light: 8, dark: 12 } },
  };
  for (let i = 0; i < count; i++)
    yield {
      id: `n${i}`,
      type: "rect",
      parent: "p",
      key: "a0",
      // Parsed apart, as rows are: nothing shared between layers.
      props: JSON.parse(
        '{"width":100,"fills":[{"type":"solid","color":"#000000","bind":{"color":"v"}}],"bindings":{"width":"n","cornerRadius":"n"}}',
      ),
    };
}

it("F16: bound layers' indexes and resolved values are counted in the editor's meter", () => {
  const layers = Math.round(30_000 * SCALE);
  const before = used();
  const meter = new BuildBudget({ bytes: 48 * MB });
  const doc = new Doc({ compactCopies: false });
  doc.resetStored(bound(layers), "materialized", { meter });
  const indexed = used() - before;
  const countedIndexed = meter.held;
  const indexHeld = doc.tokens.held;
  for (const _ of doc.nodes()) {
    // Every layer read, as a tool reads them: resolved, and cached.
  }
  const resolved = used() - before;
  console.log(
    JSON.stringify({
      layers,
      indexedMB: +(indexed / MB).toFixed(2),
      countedIndexedMB: +(countedIndexed / MB).toFixed(2),
      tokensIndexMB: +(indexHeld / MB).toFixed(2),
      tokensHeldMB: +(doc.tokens.held / MB).toFixed(2),
      resolvedMB: +(resolved / MB).toFixed(2),
      countedMB: +(meter.held / MB).toFixed(2),
    }),
  );
  expect(doc.size).toBe(layers + 4);
  expect(doc.get("n0")?.props.width).toBe(8);
  expect(indexed).toBeLessThanOrEqual(countedIndexed + NOISE);
  expect(resolved).toBeLessThanOrEqual(meter.held + NOISE);
});
