/**
 * Telling an open tab that Drawpane was updated. Each build has an id,
 * compiled in and written beside the app as `version.json`; a tab asks for
 * that file now and then (coming back into view, back online, its file's
 * socket reconnecting as a deploy restarts rooms, and every few minutes) and,
 * when it names another build, offers to reload. A tab running the old app
 * against a new server is how a fix stays unseen after it's deployed.
 */
import { useSyncExternalStore } from "react";

declare const __BUILD_ID__: string;

/** This build's id; "dev" when served by Vite or under test, which never asks. */
export const BUILD_ID: string = typeof __BUILD_ID__ === "string" ? __BUILD_ID__ : "dev";

const EVERY_MS = 5 * 60_000;
/** Asked at most this often, however many reasons come at once. */
const AT_MOST_MS = 15_000;

let available = false;
let askedAt = 0;
const listeners = new Set<() => void>();

/** Asks whether a newer build is deployed; quietly does nothing when it can't tell. */
export async function checkForUpdate(now = Date.now(), current = BUILD_ID): Promise<void> {
  if (current === "dev" || available || now - askedAt < AT_MOST_MS) return;
  askedAt = now;
  try {
    const response = await fetch("/version.json", { cache: "no-store" });
    if (!response.ok) return;
    const { build } = (await response.json()) as { build?: unknown };
    if (typeof build === "string" && build !== "" && build !== current) {
      available = true;
      for (const listener of listeners) listener();
    }
  } catch {
    // Offline, or the file is missing: ask again later.
  }
}

/** Whether a newer build is deployed than the one this tab runs. */
export function useUpdateAvailable(): boolean {
  return useSyncExternalStore(
    (notify) => {
      listeners.add(notify);
      return () => listeners.delete(notify);
    },
    () => available,
  );
}

/** Asks on the usual occasions; returns how to stop. */
export function watchForUpdates(): () => void {
  const ask = () => void checkForUpdate();
  const onVisible = () => {
    if (document.visibilityState === "visible") ask();
  };
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("online", ask);
  const timer = setInterval(ask, EVERY_MS);
  return () => {
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("online", ask);
    clearInterval(timer);
  };
}

/** Says whether anything in this tab is still waiting to be saved (an open file's edits). */
const unsaved = new Set<() => boolean>();

/** Registers a check for unsaved work, which a reload waits for; returns how to remove it. */
export function holdReloadWhile(pending: () => boolean): () => void {
  unsaved.add(pending);
  return () => unsaved.delete(pending);
}

/** Whether anything registered still has unsaved work. */
export function somethingUnsaved(): boolean {
  for (const pending of unsaved) if (pending()) return true;
  return false;
}
