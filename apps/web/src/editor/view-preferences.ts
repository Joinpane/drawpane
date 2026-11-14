/**
 * View preferences that follow a person between files, in this browser:
 * rulers, layout grids, pixel-grid snapping and the Selection Lens. Read once when an editor
 * opens, written whenever they change.
 */
import type { Editor } from "@drawpane/editor";
import { useEffect } from "react";
import { uiFor } from "./ui-state";

const KEY = "drawpane:view";

interface ViewPreferences {
  readonly rulers: boolean;
  readonly layoutGrids: boolean;
  readonly pixelSnap: boolean;
  readonly lens: boolean;
}

const NAMES = [
  "rulers",
  "layoutGrids",
  "pixelSnap",
  "lens",
] as const satisfies readonly (keyof ViewPreferences)[];

/** What's stored, keeping only well-formed values. */
export function readViewPreferences(raw: string | null): Partial<ViewPreferences> {
  try {
    const parsed = JSON.parse(raw ?? "null") as Record<string, unknown> | null;
    const out: Partial<Record<keyof ViewPreferences, boolean>> = {};
    for (const name of NAMES) if (typeof parsed?.[name] === "boolean") out[name] = parsed[name];
    return out;
  } catch {
    return {};
  }
}

function load(): Partial<ViewPreferences> {
  try {
    return readViewPreferences(localStorage.getItem(KEY));
  } catch {
    return {};
  }
}

export function useViewPreferences(editor: Editor): void {
  useEffect(() => {
    const ui = uiFor(editor);
    const { lens, ...view } = load();
    editor.state.set(view);
    if (lens !== undefined) ui.set({ lens });
    const current = (): ViewPreferences => ({
      rulers: editor.s.rulers,
      layoutGrids: editor.s.layoutGrids,
      pixelSnap: editor.s.pixelSnap,
      lens: ui.get().lens,
    });
    let last = current();
    const save = () => {
      const next = current();
      if (NAMES.every((name) => next[name] === last[name])) return;
      last = next;
      try {
        localStorage.setItem(KEY, JSON.stringify(next));
      } catch {
        // Not remembered; still works.
      }
    };
    const offEditor = editor.state.subscribe(save);
    const offUi = ui.subscribe(save);
    return () => {
      offEditor();
      offUi();
    };
  }, [editor]);
}
