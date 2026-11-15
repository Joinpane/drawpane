/**
 * Where popovers go when they open from the inspector or the Selection Lens
 * (`PopoverRoom`): over the canvas, never over the inspector itself, and off
 * the selection whenever there's a way to fit, so what you're changing stays
 * in view while you change it. The inspector's also tell the Lens to step
 * aside while they're open, as Figma's on-canvas toolbars do.
 */
import type { Editor } from "@drawpane/editor";
import type { PopoverRect, PopoverRoom } from "@drawpane/ui";
import { type RefObject, useMemo } from "react";
import { uiFor } from "./ui-state";

/** The selection's box on screen, in viewport pixels, or null when nothing's selected. */
export function selectionRect(editor: Editor): PopoverRect | null {
  const { selection, camera } = editor.s;
  const bounds = selection.length > 0 ? editor.scene.unionBounds(selection) : null;
  const canvas = document.querySelector(".canvas")?.getBoundingClientRect();
  if (!bounds || !canvas) return null;
  const a = camera.toScreen({ x: bounds.x, y: bounds.y });
  const b = camera.toScreen({ x: bounds.x + bounds.width, y: bounds.y + bounds.height });
  return {
    left: canvas.left + a.x,
    top: canvas.top + a.y,
    right: canvas.left + b.x,
    bottom: canvas.top + b.y,
  };
}

/** The inspector's popovers: left of its pane, off the selection, and the Lens hides meanwhile. */
export function useInspectorRoom(editor: Editor, pane: RefObject<HTMLElement | null>): PopoverRoom {
  return useMemo(
    () => ({
      bounds: () => {
        const rect = pane.current?.getBoundingClientRect();
        return rect ? { left: 0, top: 0, right: rect.left, bottom: window.innerHeight } : null;
      },
      avoid: () => selectionRect(editor),
      subscribe: (onChange) => {
        let selection = editor.s.selection;
        return editor.state.subscribe(() => {
          if (editor.s.selection === selection) return;
          selection = editor.s.selection;
          onChange();
        });
      },
      onOpen: () => {
        const ui = uiFor(editor);
        ui.set({ inspectorPopovers: ui.get().inspectorPopovers + 1 });
        return () => ui.set({ inspectorPopovers: Math.max(0, ui.get().inspectorPopovers - 1) });
      },
    }),
    [editor, pane],
  );
}
