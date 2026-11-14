/**
 * Changing shortcuts: what a key press records, which action already has it,
 * and which combinations the browser keeps for itself. Pure, so the settings
 * page and its tests share it.
 */
import { isMac } from "../app/format";
import { ACTIONS, type Action, alsoOf, type Shortcut, shortcutOf } from "./actions";
import type { ShortcutOverrides } from "./shortcuts-store";

const MODIFIERS = new Set(["shift", "alt", "control", "meta", "os", "capslock", "fn"]);

/** The keys a key press is for, as a shortcut; null for a modifier alone, or keys that can't be one. */
export function shortcutFromEvent(
  e: Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">,
  mac = isMac(),
): Shortcut | null {
  let key = e.key.toLowerCase();
  if (MODIFIERS.has(key) || key === "dead" || key === "unidentified") return null;
  // Tab moves focus, holding Space pans, and Control on a Mac is a right-click with the
  // pointer: none of them can be shortcuts here.
  if (key === "tab" || key === " " || (mac && e.ctrlKey)) return null;
  // The same readings as matching a press (actions.ts `matches`), so what's recorded matches itself.
  if (key === "delete") key = "backspace";
  if (key === "+") key = "=";
  if (e.shiftKey && /^Digit\d$/.test(e.code)) key = e.code.slice(5);
  if (e.shiftKey && e.code === "Quote") key = "'";
  if (e.altKey && /^Key[A-Z]$/.test(e.code)) key = e.code.slice(3).toLowerCase();
  const mod = mac ? e.metaKey : e.ctrlKey;
  return {
    key,
    ...(mod ? { mod: true } : {}),
    ...(e.shiftKey ? { shift: true } : {}),
    ...(e.altKey ? { alt: true } : {}),
  };
}

export function sameShortcut(a: Shortcut, b: Shortcut): boolean {
  return a.key === b.key && !!a.mod === !!b.mod && !!a.shift === !!b.shift && !!a.alt === !!b.alt;
}

/** Combinations the browser keeps: pages never see them, so they can't be shortcuts. */
const BROWSER: Record<string, string> = {
  w: "closes the tab",
  t: "opens a tab",
  n: "opens a window",
  q: "quits the browser",
};

/** Why the browser won't let a page have this shortcut, or null when it will. */
export function reservedReason(s: Shortcut): string | null {
  if (!s.mod || s.alt) return null;
  const what = BROWSER[s.key];
  return what ? `the browser keeps it (it ${what})` : null;
}

/** The action that already answers to `s` (its shortcut or another of its keys), apart from `except`. */
export function actionUsing(s: Shortcut, except?: string): Action | null {
  for (const action of ACTIONS) {
    if (action.id === except) continue;
    const keys = [shortcutOf(action), ...alsoOf(action)];
    if (keys.some((k) => k !== undefined && sameShortcut(k, s))) return action;
  }
  return null;
}

/**
 * The overrides after giving `action` the shortcut `s` (null removes it):
 * the action that had it loses it, and a shortcut put back to its default
 * stops being an override.
 */
export function assign(
  overrides: ShortcutOverrides,
  action: Action,
  s: Shortcut | null,
): ShortcutOverrides {
  const next: Record<string, Shortcut | null> = { ...overrides };
  if (s) {
    const holder = actionUsing(s, action.id);
    if (holder) next[holder.id] = null;
  }
  const isDefault =
    s === null
      ? action.defaultShortcut === undefined
      : action.defaultShortcut !== undefined && sameShortcut(s, action.defaultShortcut);
  if (isDefault) delete next[action.id];
  else next[action.id] = s;
  return next;
}
