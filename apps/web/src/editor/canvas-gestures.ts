/**
 * Chrome that floats over the canvas (the Lens, the toolbar, zoom, the
 * minimap, rulers…) lets the canvas's own gestures through: a two-finger
 * scroll or a pinch that starts on it pans or zooms the canvas, as if the
 * bar weren't there, the way Figma's floating bars behave. Clicks, typing
 * and hovering still land on the chrome.
 *
 * Mark an element with `{...PASS_GESTURES}`. The canvas under the pointer
 * takes wheel and Safari gesture events that start inside it (`Canvas.tsx`),
 * except a scroll something inside the chrome can take itself: a list in an
 * open popover still scrolls, until it reaches its end.
 */

export const PASS_GESTURES = { "data-canvas-gestures": "pass" } as const;

const MARK = "[data-canvas-gestures=pass]";

/** Whether `el` can scroll further by `delta` along one axis. */
function canScroll(el: Element, delta: number, axis: "x" | "y"): boolean {
  if (delta === 0) return false;
  const style = getComputedStyle(el);
  const overflow = axis === "y" ? style.overflowY : style.overflowX;
  if (overflow !== "auto" && overflow !== "scroll") return false;
  const [position, size, client] =
    axis === "y"
      ? [el.scrollTop, el.scrollHeight, el.clientHeight]
      : [el.scrollLeft, el.scrollWidth, el.clientWidth];
  if (size <= client) return false;
  return delta < 0 ? position > 0 : position + client < size - 1;
}

/**
 * Whether a gesture that started on `target` belongs to the canvas: it's in
 * marked chrome, and (for a scroll, `delta`; null for a pinch) nothing
 * between it and the chrome would scroll instead.
 */
export function passesToCanvas(
  target: EventTarget | null,
  delta: { readonly x: number; readonly y: number } | null,
): boolean {
  if (!(target instanceof Element)) return false;
  const chrome = target.closest(MARK);
  if (!chrome) return false;
  if (!delta) return true;
  for (let el: Element | null = target; el; el = el.parentElement) {
    if (canScroll(el, delta.y, "y") || canScroll(el, delta.x, "x")) return false;
    if (el === chrome) break;
  }
  return true;
}
