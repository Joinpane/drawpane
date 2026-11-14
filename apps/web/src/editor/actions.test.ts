import { describe, expect, it } from "vitest";
import { ACTIONS } from "./actions";

describe("actions", () => {
  it("have unique ids", () => {
    const ids = ACTIONS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("never share a shortcut", () => {
    const seen = new Map<string, string>();
    for (const action of ACTIONS) {
      for (const shortcut of [action.shortcut, ...(action.also ?? [])]) {
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
});
