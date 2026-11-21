/**
 * View preferences that follow a person between files, in this browser:
 * rulers, layout grids, the pixel grid, pixel-grid snapping, the
 * Selection Lens and the minimap. Read once when an editor
 * opens, written whenever they change.
 */
import type { Editor } from "@drawpane/editor";
import { useEffect } from "react";
import { type MinimapMode, uiFor } from "./ui-state";

const KEY = "drawpane:view";

interface ViewPreferences {
  readonly rulers: boolean;
  readonly layoutGrids: boolean;
  readonly pixelGrid: boolean;
  readonly pixelSnap: boolean;
  readonly lens: boolean;
  readonly minimap: MinimapMode;
}

const MINIMAP_MODES: readonly MinimapMode[] = ["auto", "always", "off"];

const SWITCHES = [
  "rulers",
  "layoutGrids",
  "pixelGrid",
  "pixelSnap",
  "lens",
] as const satisfies readonly (keyof ViewPreferences)[];
const NAMES = [...SWITCHES, "minimap"] as const satisfies readonly (keyof ViewPreferences)[];

/** What's stored, keeping only well-formed values. */
export function readViewPreferences(raw: string | null): Partial<ViewPreferences> {
  try {
    const parsed = JSON.parse(raw ?? "null") as Record<string, unknown> | null;
    const out: { -readonly [K in keyof ViewPreferences]?: ViewPreferences[K] } = {};
    for (const name of SWITCHES) if (typeof parsed?.[name] === "boolean") out[name] = parsed[name];
    const minimap = parsed?.minimap;
    // Before modes, the minimap was on or off: on is now "while moving around".
    if (typeof minimap === "boolean") out.minimap = minimap ? "auto" : "off";
    else if (MINIMAP_MODES.includes(minimap as MinimapMode)) out.minimap = minimap as MinimapMode;
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
    const { lens, minimap, ...view } = load();
    editor.state.set(view);
    if (lens !== undefined) ui.set({ lens });
    if (minimap !== undefined) ui.set({ minimap });
    const current = (): ViewPreferences => ({
      rulers: editor.s.rulers,
      layoutGrids: editor.s.layoutGrids,
      pixelGrid: editor.s.pixelGrid,
      pixelSnap: editor.s.pixelSnap,
      lens: ui.get().lens,
      minimap: ui.get().minimap,
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
