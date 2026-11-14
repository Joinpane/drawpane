import { describe, expect, it } from "vitest";
import { type Box, type LensPlacementInput, placeLens } from "./lens-placement";

const area: Box = { x: 300, y: 64, width: 800, height: 776 };
const size = { width: 240, height: 36 };
const place = (over: Partial<LensPlacementInput> & { target: Box }) =>
  placeLens({ area, size, obstacles: [], ...over });

describe("placeLens", () => {
  it("takes another order of preference, like Explain's beside-first", () => {
    const target = { x: 400, y: 300, width: 200, height: 40 };
    const order = ["right", "left", "below", "above", "inside"] as const;
    expect(place({ target, order })).toEqual({ side: "right", x: 612, y: 302 });
    // No room on the right: the next one along.
    const wide = { x: 400, y: 300, width: 600, height: 40 };
    expect(place({ target: wide, order })?.side).toBe("below");
  });

  it("never covers floating UI like the minimap while another side fits", () => {
    // A small layer near the canvas's bottom left, the minimap right under it.
    const target = { x: 400, y: 680, width: 22, height: 22 };
    const minimap = { x: 300, y: 720, width: 168, height: 108 };
    expect(place({ target })?.side).toBe("below");
    const placed = place({ target, chrome: [minimap] });
    expect(placed?.side).not.toBe("below");
    if (!placed) throw new Error("not placed");
    const lens = { x: placed.x, y: placed.y, ...size };
    const covers =
      lens.x < minimap.x + minimap.width &&
      lens.x + lens.width > minimap.x &&
      lens.y < minimap.y + minimap.height &&
      lens.y + lens.height > minimap.y;
    expect(covers).toBe(false);
  });

  it("goes under the selection, centred, clear of the size pill", () => {
    const target = { x: 600, y: 300, width: 200, height: 40 };
    expect(place({ target })).toEqual({ side: "below", x: 580, y: 376 });
  });

  it("moves above when below would cover the next layer", () => {
    // A heading with a paragraph right under it.
    const target = { x: 600, y: 300, width: 200, height: 40 };
    const paragraph = { x: 600, y: 360, width: 300, height: 80 };
    expect(place({ target, obstacles: [paragraph] })?.side).toBe("above");
  });

  it("moves above when below would sit right against the next layer", () => {
    const target = { x: 600, y: 300, width: 200, height: 40 };
    // Ends 4px above where the Lens would start.
    const paragraph = { x: 600, y: 356, width: 300, height: 16 };
    expect(place({ target, obstacles: [paragraph] })?.side).toBe("above");
  });

  it("stays below when it would only graze a layer", () => {
    const target = { x: 600, y: 300, width: 200, height: 40 };
    const corner = { x: 815, y: 410, width: 20, height: 20 };
    expect(place({ target, obstacles: [corner] })?.side).toBe("below");
  });

  it("goes beside the selection when above and below are both busy", () => {
    const target = { x: 400, y: 300, width: 160, height: 40 };
    const before = { x: 380, y: 200, width: 360, height: 90 };
    const after = { x: 380, y: 350, width: 360, height: 90 };
    expect(place({ target, obstacles: [before, after] })?.side).toBe("right");
  });

  it("flips above when there's no room below, leaving room for a frame's name", () => {
    const target = { x: 600, y: 700, width: 200, height: 120 };
    expect(place({ target })).toEqual({ side: "above", x: 580, y: 652 });
    expect(place({ target, labelAbove: true })?.y).toBe(636);
  });

  it("keeps clear of the panes, sliding along the selection", () => {
    const target = { x: 280, y: 300, width: 60, height: 40 };
    expect(place({ target })).toMatchObject({ side: "below", x: 300 });
  });

  it("floats at the bottom of a selection bigger than the screen", () => {
    const target = { x: 200, y: 0, width: 1200, height: 1200 };
    expect(place({ target })).toEqual({ side: "inside", x: 580, y: 792 });
  });

  it("hides when it fits nowhere", () => {
    // A selection filling a sliver of canvas: no room around it or inside it.
    const target = { x: 300, y: 64, width: 800, height: 50 };
    expect(place({ target, area: { ...area, height: 50 } })).toBeNull();
  });

  it("doesn't hop for a small gain once placed", () => {
    const target = { x: 600, y: 300, width: 200, height: 40 };
    // Covers a little more below than above (by less than its stickiness).
    const below = { x: 580, y: 376, width: 30, height: 36 };
    const above = { x: 580, y: 252, width: 10, height: 36 };
    expect(place({ target, obstacles: [below, above], previous: "above" })?.side).toBe("above");
  });
});

describe("placeLens with a popover open", () => {
  it("keeps to its side even when another would now cover less", () => {
    const target = { x: 600, y: 300, width: 200, height: 40 };
    const paragraph = { x: 600, y: 360, width: 300, height: 80 };
    expect(place({ target, obstacles: [paragraph], sides: ["below"] })?.side).toBe("below");
  });

  it("moves anyway when its side no longer fits", () => {
    const target = { x: 600, y: 700, width: 200, height: 120 };
    expect(place({ target, sides: ["below"] })?.side).toBe("above");
  });
});
