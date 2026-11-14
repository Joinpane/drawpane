import { describe, expect, it } from "vitest";
import { clampPane, PANE, readPanelLayout } from "./panel-layout";

describe("clampPane", () => {
  it("keeps a panel within its range", () => {
    expect(clampPane(100, 1600, 264)).toBe(PANE.min);
    expect(clampPane(900, 2400, 264)).toBe(PANE.max);
    expect(clampPane(300.6, 1600, 264)).toBe(301);
  });

  it("leaves the canvas room beside the other panel, until the range won't allow it", () => {
    // 1100 wide, the other panel 300: 1100 - 300 - 360 - 48 = 392 at most.
    expect(clampPane(480, 1100, 300)).toBe(392);
    // With the other panel closed there's more room.
    expect(clampPane(480, 1100, 0)).toBe(480);
    // A small window: the narrowest a panel goes, even if the canvas gets less.
    expect(clampPane(300, 700, 300)).toBe(PANE.min);
  });
});

describe("readPanelLayout", () => {
  it("reads widths and Minimize UI, keeping widths in range", () => {
    expect(readPanelLayout('{"left":320,"right":9999,"minimized":true}')).toEqual({
      left: 320,
      right: PANE.max,
      minimized: true,
    });
  });

  it("falls back to the defaults for anything missing or damaged", () => {
    const defaults = { left: PANE.default, right: PANE.default, minimized: false };
    expect(readPanelLayout(null)).toEqual(defaults);
    expect(readPanelLayout("not json")).toEqual(defaults);
    expect(readPanelLayout('{"left":"wide","minimized":"yes"}')).toEqual(defaults);
  });
});
