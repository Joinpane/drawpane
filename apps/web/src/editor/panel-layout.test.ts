import { describe, expect, it } from "vitest";
import { clampPages, clampPane, PAGES, PANE, pagesRange, readPanelLayout } from "./panel-layout";

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

describe("pagesRange and clampPages", () => {
  // 20 pages of 28px, in a panel where the list and the layers share 700px.
  const content = 20 * 28;

  it("goes from about one and a half rows to all the pages", () => {
    expect(pagesRange(content, 900)).toEqual({ min: PAGES.min, max: content });
    expect(clampPages(10, content, 900)).toBe(PAGES.min);
    expect(clampPages(300.4, content, 900)).toBe(300);
    // Dragged past all the pages: it stops there.
    expect(clampPages(1200, content, 900)).toBe(content);
  });

  it("leaves the layers their room, keeping the preference for a taller window", () => {
    // 400px shared: the layers keep 120 of it.
    expect(pagesRange(content, 400).max).toBe(400 - PAGES.layersMin);
    expect(clampPages(500, content, 400)).toBe(280);
    expect(clampPages(500, content, 900)).toBe(500);
  });

  it("never shows space below a short list", () => {
    // Three pages: the list is three rows, whatever's chosen.
    expect(clampPages(PAGES.default, 84, 700)).toBe(84);
    expect(pagesRange(84, 700)).toEqual({ min: PAGES.min, max: 84 });
    // One page is shorter than the usual minimum: it's both.
    expect(pagesRange(28, 700)).toEqual({ min: 28, max: 28 });
    expect(clampPages(PAGES.default, 28, 700)).toBe(28);
    // No pages yet (still loading).
    expect(clampPages(PAGES.default, 0, 700)).toBe(0);
  });

  it("keeps the minimum when the window is too short for the layers' room", () => {
    expect(pagesRange(content, 100)).toEqual({ min: PAGES.min, max: PAGES.min });
    expect(clampPages(300, content, 100)).toBe(PAGES.min);
  });
});

describe("readPanelLayout", () => {
  it("reads widths, the pages height and Minimize UI, keeping them in range", () => {
    expect(readPanelLayout('{"left":320,"right":9999,"pages":240,"minimized":true}')).toEqual({
      left: 320,
      right: PANE.max,
      pages: 240,
      minimized: true,
    });
    expect(readPanelLayout('{"pages":3}').pages).toBe(PAGES.min);
    expect(readPanelLayout('{"pages":1e9}').pages).toBe(PAGES.max);
  });

  it("falls back to the defaults for anything missing or damaged", () => {
    const defaults = {
      left: PANE.default,
      right: PANE.default,
      pages: PAGES.default,
      minimized: false,
    };
    expect(readPanelLayout(null)).toEqual(defaults);
    expect(readPanelLayout("not json")).toEqual(defaults);
    expect(readPanelLayout('{"left":"wide","pages":"tall","minimized":"yes"}')).toEqual(defaults);
    expect(readPanelLayout('{"pages":null}').pages).toBe(PAGES.default);
  });

  it("reads what was saved before the pages could be resized", () => {
    expect(readPanelLayout('{"left":300,"right":264,"minimized":false}').pages).toBe(PAGES.default);
  });
});
