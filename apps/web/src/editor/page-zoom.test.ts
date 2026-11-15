import { describe, expect, it } from "vitest";
import { isPageZoomKey } from "./page-zoom";

const key = (
  k: string,
  mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean }>,
) => ({
  key: k,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  ...mods,
});

describe("isPageZoomKey", () => {
  it("is ⌘ + or − on a Mac, Ctrl + or − elsewhere", () => {
    for (const k of ["=", "+", "-", "_"]) {
      expect(isPageZoomKey(key(k, { metaKey: true }), true)).toBe(true);
      expect(isPageZoomKey(key(k, { ctrlKey: true }), false)).toBe(true);
      expect(isPageZoomKey(key(k, { ctrlKey: true }), true)).toBe(false);
    }
  });

  it("leaves the reset (0), plain keys and Alt combinations alone", () => {
    expect(isPageZoomKey(key("0", { metaKey: true }), true)).toBe(false);
    expect(isPageZoomKey(key("=", {}), true)).toBe(false);
    expect(isPageZoomKey(key("=", { metaKey: true, altKey: true }), true)).toBe(false);
  });
});
