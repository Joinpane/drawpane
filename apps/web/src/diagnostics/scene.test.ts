import { RenderEngine } from "@drawpane/engine";
import { built, loadNodeEngine } from "@drawpane/engine/node";
import { describe, expect, it } from "vitest";
import { EXPECTED_PNGS } from "./expected-pixels";
import { CELL_CAMERA, CELL_HEIGHT, CELL_WIDTH, DIAGNOSTIC_CELLS } from "./scene";

describe.skipIf(!built("worker") && !process.env.CI)("Renderer diagnostics scene", () => {
  it("keeps expected PNGs in sync with the engine CPU oracle for every cell", async () => {
    const mod = await loadNodeEngine("worker");
    const ids = new Set<string>();
    for (const cell of DIAGNOSTIC_CELLS) {
      expect(ids.has(cell.id), `duplicate cell id ${cell.id}`).toBe(false);
      ids.add(cell.id);
      const expected = EXPECTED_PNGS[cell.id];
      expect(expected, `missing expected PNG for ${cell.id}`).toBeTruthy();

      const engine = new RenderEngine(mod);
      try {
        for (const img of cell.images ?? []) {
          expect(engine.putImage(img.id, img.width, img.height, img.rgba, false).ok).toBe(true);
        }
        expect(engine.apply(cell.build(1)).ok).toBe(true);
        expect(engine.unsupported()).toEqual({ ok: true, value: [] });
        const chunks: Uint8Array[] = [];
        const png = engine.renderPng(CELL_WIDTH, CELL_HEIGHT, CELL_CAMERA, cell.background, (c) =>
          chunks.push(c),
        );
        expect(png.ok).toBe(true);
        expect(Buffer.concat(chunks).toString("base64")).toBe(expected);
      } finally {
        engine.dispose();
      }
    }
  });
});
