/**
 * Tracks the browser's visual viewport (which shrinks and shifts when an
 * on-screen keyboard opens on iOS or Android) so comment sheets, popovers and
 * mobile text editing bars stay visible above the keyboard.
 */
import { type RefObject, useEffect, useState } from "react";

export interface VisualViewportRect {
  readonly width: number;
  readonly height: number;
  readonly offsetTop: number;
  readonly offsetLeft: number;
  readonly scale: number;
  /** Layout-viewport pixels obscured at the bottom (e.g. virtual keyboard height). */
  readonly bottomInset: number;
}

export interface VisualViewportSource {
  readonly innerWidth: number;
  readonly innerHeight: number;
  readonly visualViewport?: {
    readonly width: number;
    readonly height: number;
    readonly offsetTop: number;
    readonly offsetLeft: number;
    readonly scale: number;
  } | null;
}

export function readVisualViewport(source?: VisualViewportSource): VisualViewportRect {
  const win = source ?? (typeof window !== "undefined" ? window : null);
  if (!win) {
    return { width: 1440, height: 900, offsetTop: 0, offsetLeft: 0, scale: 1, bottomInset: 0 };
  }
  const vv = win.visualViewport;
  if (!vv) {
    return {
      width: win.innerWidth,
      height: win.innerHeight,
      offsetTop: 0,
      offsetLeft: 0,
      scale: 1,
      bottomInset: 0,
    };
  }
  const width = Math.max(1, vv.width);
  const height = Math.max(1, vv.height);
  const offsetTop = Math.max(0, vv.offsetTop);
  const offsetLeft = Math.max(0, vv.offsetLeft);
  const bottomInset = Math.max(0, Math.round(win.innerHeight - (offsetTop + height)));
  return {
    width,
    height,
    offsetTop,
    offsetLeft,
    scale: vv.scale || 1,
    bottomInset,
  };
}

function sameRect(a: VisualViewportRect, b: VisualViewportRect): boolean {
  return (
    a.width === b.width &&
    a.height === b.height &&
    a.offsetTop === b.offsetTop &&
    a.offsetLeft === b.offsetLeft &&
    a.scale === b.scale &&
    a.bottomInset === b.bottomInset
  );
}

/**
 * Writes `--vv-*` CSS variables and keyboard/short-viewport data attributes directly onto
 * `targetRef.current` so keyboard animations never trigger React re-renders of the editor.
 */
export function useSyncVisualViewportVars(
  targetRef: RefObject<HTMLElement | null>,
  active: boolean,
): void {
  useEffect(() => {
    const el = targetRef.current;
    if (!el || typeof window === "undefined") return;
    const clear = () => {
      el.style.removeProperty("--vv-width");
      el.style.removeProperty("--vv-height");
      el.style.removeProperty("--vv-top");
      el.style.removeProperty("--vv-left");
      el.style.removeProperty("--vv-bottom");
      delete el.dataset.keyboard;
      delete el.dataset.shortVv;
    };
    if (!active) {
      clear();
      return;
    }
    let last: VisualViewportRect | null = null;
    const apply = () => {
      const next = readVisualViewport();
      if (last && sameRect(last, next)) return;
      last = next;
      el.style.setProperty("--vv-width", `${next.width}px`);
      el.style.setProperty("--vv-height", `${next.height}px`);
      el.style.setProperty("--vv-top", `${next.offsetTop}px`);
      el.style.setProperty("--vv-left", `${next.offsetLeft}px`);
      el.style.setProperty("--vv-bottom", `${next.bottomInset}px`);
      if (next.bottomInset > 40) el.dataset.keyboard = "true";
      else delete el.dataset.keyboard;
      if (next.height <= 420) el.dataset.shortVv = "true";
      else delete el.dataset.shortVv;
    };
    const vv = window.visualViewport;
    vv?.addEventListener("resize", apply);
    vv?.addEventListener("scroll", apply);
    window.addEventListener("resize", apply);
    window.addEventListener("orientationchange", apply);
    apply();
    return () => {
      vv?.removeEventListener("resize", apply);
      vv?.removeEventListener("scroll", apply);
      window.removeEventListener("resize", apply);
      window.removeEventListener("orientationchange", apply);
      clear();
    };
  }, [targetRef, active]);
}

/** Subscribes to `window.visualViewport` resize/scroll events when `active` is true. */
export function useVisualViewport(active = true): VisualViewportRect {
  const [rect, setRect] = useState<VisualViewportRect>(() => readVisualViewport());
  useEffect(() => {
    if (!active || typeof window === "undefined") return;
    const update = () => {
      const next = readVisualViewport();
      setRect((prev) => (sameRect(prev, next) ? prev : next));
    };
    const vv = window.visualViewport;
    vv?.addEventListener("resize", update);
    vv?.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
    update();
    return () => {
      vv?.removeEventListener("resize", update);
      vv?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
    };
  }, [active]);
  return rect;
}
