import { describe, expect, it } from "vitest";
import { classifyWorkspaceMode, fitPaddingForMode, isCompactTablet } from "./workspace-mode";

describe("classifyWorkspaceMode", () => {
  it("classifies touch-only phones in portrait and rotated landscape as phone", () => {
    for (const [width, height] of [
      [360, 800],
      [393, 852],
      [412, 839],
      [430, 932],
      [800, 360],
      [852, 393],
      [839, 412],
      [932, 430],
    ] as const) {
      expect(classifyWorkspaceMode({ width, height, coarse: true, anyFine: false })).toBe("phone");
    }
  });

  it("classifies touch tablets from 768 to 1366 px in portrait and landscape as tablet", () => {
    for (const [width, height] of [
      [768, 1024],
      [1024, 768],
      [834, 1194],
      [1194, 834],
      [1024, 1366],
      [1366, 1024],
    ] as const) {
      expect(classifyWorkspaceMode({ width, height, coarse: true, anyFine: false })).toBe("tablet");
    }
  });

  it("keeps phone-sized touch devices in phone mode even with anyFine, and keeps iPads in tablet mode", () => {
    // Android phone reporting a fine stylus or paired mouse still gets phone mode.
    expect(classifyWorkspaceMode({ width: 412, height: 915, coarse: true, anyFine: true })).toBe(
      "phone",
    );
    expect(classifyWorkspaceMode({ width: 915, height: 412, coarse: true, anyFine: true })).toBe(
      "phone",
    );
    // Tablets (including iPad mini at 744 px) with Apple Pencil or trackpad stay tablet.
    expect(classifyWorkspaceMode({ width: 744, height: 1133, coarse: true, anyFine: true })).toBe(
      "tablet",
    );
    expect(classifyWorkspaceMode({ width: 768, height: 1024, coarse: true, anyFine: true })).toBe(
      "tablet",
    );
    // Desktop mouse in a narrow window remains desktop.
    expect(classifyWorkspaceMode({ width: 412, height: 839, coarse: false, anyFine: true })).toBe(
      "desktop",
    );
  });

  it("keeps desktop browsers in desktop mode", () => {
    for (const [width, height] of [
      [1024, 768],
      [1280, 800],
      [1440, 900],
      [1920, 1080],
    ] as const) {
      expect(classifyWorkspaceMode({ width, height, coarse: false, anyFine: true })).toBe(
        "desktop",
      );
    }
    // Screens wider than 1366 px also stay in desktop layout even with a coarse pointer.
    expect(classifyWorkspaceMode({ width: 1440, height: 900, coarse: true, anyFine: false })).toBe(
      "desktop",
    );
  });
});

describe("isCompactTablet and fitPaddingForMode", () => {
  it("flags cramped portrait tablets as compact and landscape tablets as full", () => {
    expect(isCompactTablet("tablet", 768)).toBe(true);
    expect(isCompactTablet("tablet", 834)).toBe(true);
    expect(isCompactTablet("tablet", 1024)).toBe(false);
    expect(isCompactTablet("tablet", 1194)).toBe(false);
    expect(isCompactTablet("phone", 393)).toBe(false);
    expect(isCompactTablet("desktop", 768)).toBe(false);
  });

  it("keeps desktop fit padding at 64 px and tightens mobile padding", () => {
    expect(fitPaddingForMode("desktop")).toBe(64);
    expect(fitPaddingForMode("tablet")).toBe(32);
    expect(fitPaddingForMode("phone")).toBe(20);
  });
});
