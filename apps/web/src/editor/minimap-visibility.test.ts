import type { MinimapModel } from "@drawpane/editor";
import { describe, expect, it } from "vitest";
import { hasOffscreen } from "./Minimap";

const model = (layers: Array<[number, number, number, number]>): MinimapModel => ({
  bounds: { x: 0, y: 0, width: 0, height: 0 },
  view: { x: 0, y: 0, width: 1000, height: 600 },
  layers: layers.map(([x, y, width, height], i) => ({
    id: `l${i}`,
    rect: { x, y, width, height },
    board: true,
    hidden: false,
    fill: null,
  })),
  peers: [],
  boards: layers.length,
});

describe("hasOffscreen", () => {
  it("is true only when some of the page is out of view", () => {
    expect(hasOffscreen(model([]))).toBe(false);
    expect(hasOffscreen(model([[100, 100, 300, 300]]))).toBe(false);
    expect(
      hasOffscreen(
        model([
          [100, 100, 300, 300],
          [1200, 0, 300, 300],
        ]),
      ),
    ).toBe(true);
    expect(hasOffscreen(model([[-50, 100, 300, 300]]))).toBe(true);
  });
});
