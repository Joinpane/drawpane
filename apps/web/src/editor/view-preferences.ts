/**
 * View preferences that follow a person between files, in this browser:
 * rulers and layout grids. Read once when an editor opens, written whenever
 * they change.
 */
import type { Editor } from "@drawpane/editor";
import { useEffect } from "react";

const KEY = "drawpane:view";

interface ViewPreferences {
  readonly rulers: boolean;
  readonly layoutGrids: boolean;
}

function read(): Partial<ViewPreferences> {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<ViewPreferences> | null;
    return {
      ...(typeof raw?.rulers === "boolean" ? { rulers: raw.rulers } : {}),
      ...(typeof raw?.layoutGrids === "boolean" ? { layoutGrids: raw.layoutGrids } : {}),
    };
  } catch {
    return {};
  }
}

export function useViewPreferences(editor: Editor): void {
  useEffect(() => {
    editor.state.set(read());
    let last = { rulers: editor.s.rulers, layoutGrids: editor.s.layoutGrids };
    return editor.state.subscribe(() => {
      const { rulers, layoutGrids } = editor.s;
      if (rulers === last.rulers && layoutGrids === last.layoutGrids) return;
      last = { rulers, layoutGrids };
      try {
        localStorage.setItem(KEY, JSON.stringify(last));
      } catch {
        // Not remembered; still works.
      }
    });
  }, [editor]);
}
