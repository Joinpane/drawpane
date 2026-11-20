/**
 * An export is exact or isn't made: a list holding a provisional record (display list 1.1,
 * flag 8: text still loading, drawn as placeholder bars) is refused by both PNG entry points
 * before their first byte (the phase 2 review's B2 on decision 0040).
 */
import { describe, expect, it } from "vitest";
import { ErrorCode, FLAG, ListWriter, RenderEngine, ROOT } from "../src/index";
import { built, loadNodeEngine } from "../src/node";

describe.skipIf(!built("worker") && !process.env.CI)("exports of provisional text", () => {
  it("are refused before any PNG bytes", async () => {
    const engine = new RenderEngine(await loadNodeEngine("worker"));
    try {
      const list = new ListWriter(0xffffffff, 1);
      list.reset();
      list.set(1, ROOT, {
        flags: FLAG.provisional,
        transform: [1, 0, 0, 1, 0, 0],
        opacity: 1,
        width: 16,
        height: 16,
        coarseBelow: 0,
        reach: 0,
        unsupported: 0,
        paths: [{ kind: "rect", w: 16, h: 16, radii: [0, 0, 0, 0], smoothing: 0 }],
        ops: [],
        coarse: [
          { op: "fill", path: 0, evenOdd: false, paint: { kind: "solid", color: [1, 0, 0, 1] } },
        ],
      });
      expect(engine.apply(list.finish()).ok).toBe(true);
      const camera = { zoom: 1, x: 0, y: 0, dpr: 1 };
      const background = [0, 0, 0, 0] as const;
      const chunks: Uint8Array[] = [];
      const sync = engine.renderPng(16, 16, camera, background, (chunk) => chunks.push(chunk));
      const stream = engine.renderPngStream(16, 16, camera, background);
      let first: Uint8Array | undefined;
      if (stream.ok) {
        const reader = stream.value.getReader();
        first = (await reader.read()).value;
        await reader.cancel();
      }
      expect({
        sync: sync.ok,
        stream: stream.ok,
        syncBytes: chunks.reduce((n, chunk) => n + chunk.length, 0),
        streamBytes: first?.length ?? 0,
      }).toEqual({ sync: false, stream: false, syncBytes: 0, streamBytes: 0 });
      if (!sync.ok) expect(sync.code).toBe(ErrorCode.State);
    } finally {
      engine.dispose();
    }
  });
});
