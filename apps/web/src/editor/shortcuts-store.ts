/**
 * The shortcuts a person has changed from the defaults: action id → shortcut,
 * or null for none. They live on the account (GET/PUT /api/account/shortcuts),
 * so they follow the person to every browser; this is the copy in memory that
 * every key press and every hint reads, through `shortcutOf` in actions.ts.
 */
import { useSyncExternalStore } from "react";

export interface StoredShortcut {
  readonly key: string;
  readonly mod?: boolean;
  readonly shift?: boolean;
  readonly alt?: boolean;
}

export type ShortcutOverrides = Readonly<Record<string, StoredShortcut | null>>;

let overrides: ShortcutOverrides = {};
let version = 0;
const listeners = new Set<() => void>();

export function getOverrides(): ShortcutOverrides {
  return overrides;
}

export function setOverrides(next: ShortcutOverrides): void {
  overrides = next;
  version++;
  for (const listener of listeners) listener();
}

export function subscribeOverrides(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Re-renders when the overrides change (hints and tooltips show the new keys). */
export function useOverridesVersion(): number {
  return useSyncExternalStore(subscribeOverrides, () => version);
}
