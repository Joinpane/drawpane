/**
 * Keeps the shortcuts a person changed (stored on their account) in the
 * editor's keymap: fetched once they're signed in, cleared when they sign
 * out. Saving goes through the same query, so every view agrees.
 */
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { api } from "../api/client";
import { type ShortcutOverrides, setOverrides } from "../editor/shortcuts-store";

export const SHORTCUTS_QUERY = ["account", "shortcuts"] as const;

export function fetchShortcuts() {
  return api.get<{ shortcuts: ShortcutOverrides }>("/account/shortcuts");
}

export function ShortcutsSync() {
  const session = useQuery({ queryKey: ["session"], queryFn: api.session });
  const signedIn = !!session.data?.user;
  const shortcuts = useQuery({
    queryKey: SHORTCUTS_QUERY,
    queryFn: fetchShortcuts,
    enabled: signedIn,
    staleTime: Number.POSITIVE_INFINITY,
  });
  // Read both on every render: React Query re-renders for the fields a render reads, so
  // reading the shortcuts only once signed in could miss their later changes.
  const stored = shortcuts.data?.shortcuts;
  const overrides = signedIn ? stored : undefined;
  useEffect(() => {
    setOverrides(overrides ?? {});
  }, [overrides]);
  return null;
}
