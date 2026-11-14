import { describe, expect, it } from "vitest";
import { ACTIONS, matches } from "./actions";

describe("actions", () => {
  it("have unique ids", () => {
    const ids = ACTIONS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("never share a shortcut", () => {
    const seen = new Map<string, string>();
    for (const action of ACTIONS) {
      for (const shortcut of [action.defaultShortcut, ...(action.also ?? [])]) {
        if (!shortcut) continue;
        const { key, mod, shift, alt } = shortcut;
        const combo = `${mod ? "mod+" : ""}${alt ? "alt+" : ""}${shift ? "shift+" : ""}${key}`;
        expect(
          seen.get(combo),
          `${action.id} and ${seen.get(combo)} both use ${combo}`,
        ).toBeUndefined();
        seen.set(combo, action.id);
      }
    }
  });

  it("match a shifted punctuation key by its physical key", () => {
    // Shift+' types a double quote; ⇧⌘' should still toggle pixel-grid snapping.
    const event = (init: Partial<KeyboardEvent>) =>
      ({
        altKey: false,
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        ...init,
      }) as KeyboardEvent;
    const pixel = ACTIONS.find((a) => a.id === "view.pixelSnap")?.defaultShortcut;
    if (!pixel) throw new Error("no shortcut");
    const both = { metaKey: true, ctrlKey: true, shiftKey: true };
    expect(matches(pixel, event({ key: '"', code: "Quote", ...both }))).toBe(true);
    expect(matches(pixel, event({ key: "'", code: "Quote", metaKey: true, ctrlKey: true }))).toBe(
      false,
    );
  });
});
