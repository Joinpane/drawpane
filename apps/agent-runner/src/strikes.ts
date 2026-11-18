/**
 * Crash strikes (decision 0033, item 4.5), so a call that kills the runner
 * can't become a loop. Before a run, the runner writes an `inflight` row
 * with the call's fingerprint, and deletes it when the call returns. A
 * runner that starts and finds the row knows the last call never returned
 * (it ran out of memory or CPU, or was reset after taking too long) and
 * records a strike against that fingerprint.
 *
 * A call is refused for an hour after its second strike, not its first:
 * runners of other files can share an isolate, so one whose isolate was
 * reset by another file's call gets a strike it didn't earn, and its retry
 * must still run. Three strikes on the file within ten minutes, from any
 * calls, pause agent tools on it for ten minutes.
 */

export interface Strike {
  readonly fingerprint: string;
  readonly at: number;
}

/** Strikes on one call before it's refused, and for how long. */
export const CALL_STRIKES = 2;
export const CALL_REFUSED_MS = 60 * 60_000;
/** Strikes on a file, within FILE_WINDOW_MS, that pause it for FILE_PAUSE_MS. */
export const FILE_STRIKES = 3;
export const FILE_WINDOW_MS = 10 * 60_000;
export const FILE_PAUSE_MS = 10 * 60_000;
/** Strikes older than this matter to nothing and are let go. */
export const STRIKES_KEPT_MS = CALL_REFUSED_MS;

export const CALL_REFUSED =
  "That call ran out of memory twice, so it isn't run again for an hour. Nothing was changed. Try a smaller part.";

export function filePaused(minutes: number): string {
  return `Agent tools are paused on this file for ${minutes === 1 ? "another minute" : `${minutes} more minutes`}: calls on it ran out of memory ${FILE_STRIKES} times in ${FILE_WINDOW_MS / 60_000} minutes. Nothing was changed.`;
}

/** Why a call with `fingerprint` isn't run now, given the file's strikes; null when it may run. */
export function strikeRefusal(
  strikes: readonly Strike[],
  fingerprint: string,
  now: number,
): string | null {
  const times = strikes.map((s) => s.at).sort((a, b) => a - b);
  // Any FILE_STRIKES in a row within the window pause the file from the last of them.
  for (let i = FILE_STRIKES - 1; i < times.length; i++) {
    const last = times[i] as number;
    const first = times[i - FILE_STRIKES + 1] as number;
    if (last - first <= FILE_WINDOW_MS && now < last + FILE_PAUSE_MS)
      return filePaused(Math.ceil((last + FILE_PAUSE_MS - now) / 60_000));
  }
  const mine = strikes.filter((s) => s.fingerprint === fingerprint && now - s.at < CALL_REFUSED_MS);
  return mine.length >= CALL_STRIKES ? CALL_REFUSED : null;
}

/** A call's fingerprint: its tool and input, hashed. */
export async function fingerprint(tool: string, input: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(`${tool}\n${JSON.stringify(input ?? null)}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}
