import { useSyncExternalStore } from "react";

export type ThemePreference = "light" | "dark" | "system";
const KEY = "drawpane:theme";
const listeners = new Set<() => void>();

function read(): ThemePreference {
  try {
    const value = localStorage.getItem(KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

function systemDark(): boolean {
  return matchMedia("(prefers-color-scheme: dark)").matches;
}

function applyTheme(): void {
  const pref = read();
  const dark = pref === "dark" || (pref === "system" && systemDark());
  if (dark) document.documentElement.dataset.theme = "dark";
  else delete document.documentElement.dataset.theme;
  for (const listener of listeners) listener();
}

matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme);
// The theme showing is the root's data-theme, whoever set it (this module, an extension,
// devtools, a test): code drawing in resolved colours hears every change to it.
new MutationObserver(() => {
  for (const listener of listeners) listener();
}).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

export function setTheme(pref: ThemePreference): void {
  try {
    if (pref === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, pref);
  } catch {
    // Storage blocked: the change still applies for this session.
  }
  applyTheme();
}

/** The theme actually showing, for code (like the canvas) that needs resolved colors. */
export function useResolvedTheme(): "light" | "dark" {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => (document.documentElement.dataset.theme === "dark" ? "dark" : "light"),
  );
}

export function useThemePreference(): ThemePreference {
  return useSyncExternalStore((cb) => {
    listeners.add(cb);
    return () => listeners.delete(cb);
  }, read);
}
