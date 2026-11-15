/**
 * Keeps the browser from zooming the editor itself. In a design tool the only
 * zoom is the canvas's: a pinch over the layers panel, the inspector or the
 * toolbar shouldn't blow the whole interface up, as it doesn't in Figma.
 *
 * Browsers zoom the page three ways, and each is stopped where it starts:
 * - a trackpad pinch arrives as a wheel event with Ctrl held (Chrome, Edge,
 *   Firefox, and Safari for wheel), as does Ctrl + mouse wheel;
 * - Safari also sends its own gesture events for a pinch;
 * - ⌘/Ctrl with + or −. Elsewhere those zoom the canvas (the shortcut
 *   handler takes them); in a field or a dialog, where shortcuts don't run,
 *   they do nothing.
 * Touch screens are handled in CSS (`touch-action` on `.editor`).
 *
 * The canvas still sees all of these: it listens on its own element and
 * zooms itself, and preventing the default doesn't stop an event's way there.
 * ⌘/Ctrl + 0 stays the browser's, so a page zoomed before can be put back.
 */
import { useEffect } from "react";
import { isMac } from "../app/format";
import { isTyping } from "./keymap";

/** Whether a key press is the browser's zoom in or out shortcut. */
export function isPageZoomKey(
  e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey">,
  mac: boolean,
): boolean {
  const mod = mac ? e.metaKey : e.ctrlKey;
  if (!mod || e.altKey) return false;
  return e.key === "=" || e.key === "+" || e.key === "-" || e.key === "_";
}

export function usePageZoomLock(): void {
  useEffect(() => {
    const mac = isMac();
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey) e.preventDefault();
    };
    const onGesture = (e: Event) => e.preventDefault();
    const onKey = (e: KeyboardEvent) => {
      // Shortcuts get the rest: preventing those here would stop the canvas zooming.
      if (!isPageZoomKey(e, mac)) return;
      if (isTyping(e.target) || document.querySelector("dialog[open]:modal")) e.preventDefault();
    };
    // Not passive: a passive listener can't cancel the zoom.
    const active = { passive: false, capture: true } as const;
    window.addEventListener("wheel", onWheel, active);
    window.addEventListener("gesturestart", onGesture, active);
    window.addEventListener("gesturechange", onGesture, active);
    window.addEventListener("gestureend", onGesture, active);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("wheel", onWheel, active);
      window.removeEventListener("gesturestart", onGesture, active);
      window.removeEventListener("gesturechange", onGesture, active);
      window.removeEventListener("gestureend", onGesture, active);
      window.removeEventListener("keydown", onKey, true);
    };
  }, []);
}
