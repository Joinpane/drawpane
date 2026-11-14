import { describe, expect, it } from "vitest";
import { CURSOR_FADE_MS, CURSOR_IDLE_MS, CursorActivity } from "../src/cursors";

describe("calm cursors", () => {
  it("stays shown while it moves and for a while after, then fades out", () => {
    let now = 0;
    const cursors = new CursorActivity(() => now);
    const at = { x: 10, y: 20 };
    expect(cursors.opacity("ana", at)).toBe(1);
    now = CURSOR_IDLE_MS;
    expect(cursors.opacity("ana", at)).toBe(1);
    now = CURSOR_IDLE_MS + CURSOR_FADE_MS / 2;
    expect(cursors.opacity("ana", at)).toBeCloseTo(0.5);
    now = CURSOR_IDLE_MS + CURSOR_FADE_MS;
    expect(cursors.opacity("ana", at)).toBe(0);
    now += 60_000;
    expect(cursors.opacity("ana", at)).toBe(0);
  });

  it("comes back the moment it moves", () => {
    let now = 0;
    const cursors = new CursorActivity(() => now);
    cursors.opacity("ana", { x: 0, y: 0 });
    now = 10_000;
    expect(cursors.opacity("ana", { x: 0, y: 0 })).toBe(0);
    expect(cursors.opacity("ana", { x: 1, y: 0 })).toBe(1);
    now += CURSOR_IDLE_MS - 1;
    expect(cursors.opacity("ana", { x: 1, y: 0 })).toBe(1);
  });

  it("says when to draw again: at the next fade, every frame during one, never when all are gone", () => {
    let now = 0;
    const cursors = new CursorActivity(() => now);
    expect(cursors.nextChange()).toBeNull();
    cursors.opacity("ana", { x: 0, y: 0 });
    now = 1_000;
    cursors.opacity("bo", { x: 5, y: 5 });
    expect(cursors.nextChange()).toBe(CURSOR_IDLE_MS - 1_000);
    now = CURSOR_IDLE_MS + 100;
    expect(cursors.nextChange()).toBe(0);
    now = CURSOR_IDLE_MS + 1_000 + CURSOR_FADE_MS + 1;
    expect(cursors.nextChange()).toBeNull();
  });

  it("forgets cursors no longer shown, so they come back fresh", () => {
    let now = 0;
    const cursors = new CursorActivity(() => now);
    cursors.opacity("ana", { x: 0, y: 0 });
    now = 10_000;
    cursors.keepOnly(new Set());
    expect(cursors.nextChange()).toBeNull();
    // Back on this page: shown again, even though it hasn't moved.
    expect(cursors.opacity("ana", { x: 0, y: 0 })).toBe(1);
  });
});
