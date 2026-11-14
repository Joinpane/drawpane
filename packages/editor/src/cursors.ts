/**
 * Calm cursors (PRD "Calm multiplayer"): a collaborator's cursor fades once
 * it has been still for a few seconds and comes back the moment it moves, so
 * people who are reading or thinking don't crowd your view. Presence still
 * shows in the layers panel and the minimap.
 *
 * Movement is noticed when cursors are drawn (every presence update redraws),
 * so this needs no wiring into sync. The clock is injectable for tests.
 */
import type { Point } from "./geometry";

/** How long a cursor stays fully shown after it last moved. */
export const CURSOR_IDLE_MS = 3_000;
/** How long it takes to fade out after that. */
export const CURSOR_FADE_MS = 400;

interface Seen {
  readonly x: number;
  readonly y: number;
  /** When it last moved. */
  readonly at: number;
}

export class CursorActivity {
  readonly #seen = new Map<string, Seen>();

  constructor(readonly now: () => number = () => performance.now()) {}

  /**
   * How opaque a collaborator's cursor is now, from 1 to 0, noting it as
   * moved when it isn't where it was last time it was asked about.
   */
  opacity(sessionId: string, cursor: Point, now = this.now()): number {
    const last = this.#seen.get(sessionId);
    if (!last || last.x !== cursor.x || last.y !== cursor.y) {
      this.#seen.set(sessionId, { x: cursor.x, y: cursor.y, at: now });
      return 1;
    }
    const still = now - last.at;
    if (still <= CURSOR_IDLE_MS) return 1;
    return Math.max(0, 1 - (still - CURSOR_IDLE_MS) / CURSOR_FADE_MS);
  }

  /**
   * In how many milliseconds a cursor's opacity next changes: 0 while one is
   * fading (draw again next frame), null when none will (no timer needed).
   */
  nextChange(now = this.now()): number | null {
    let soonest: number | null = null;
    for (const { at } of this.#seen.values()) {
      const still = now - at;
      let wait: number | null = null;
      if (still < CURSOR_IDLE_MS) wait = CURSOR_IDLE_MS - still;
      else if (still < CURSOR_IDLE_MS + CURSOR_FADE_MS) wait = 0;
      if (wait !== null && (soonest === null || wait < soonest)) soonest = wait;
    }
    return soonest;
  }

  /** Forgets cursors that aren't shown any more (people who left, or went to another page). */
  keepOnly(sessionIds: ReadonlySet<string>): void {
    for (const id of this.#seen.keys()) if (!sessionIds.has(id)) this.#seen.delete(id);
  }
}
