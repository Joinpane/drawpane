/**
 * How the editor's side panels are laid out, in this browser: each one's
 * width (dragged at its inner edge) and whether the UI is minimized (the
 * layers panel tucked away, the inspector only while something is selected,
 * like Figma's ⇧⌘\). One store for every editor, remembered between files.
 */
import { Store } from "@drawpane/editor";
import { useSyncExternalStore } from "react";

export type PaneSide = "left" | "right";

export interface PanelLayout {
  readonly left: number;
  readonly right: number;
  readonly minimized: boolean;
}

export const PANE = {
  /** The design's width (--size-pane). */
  default: 264,
  min: 240,
  max: 480,
  /** Between a pane and the window's edge, and around the canvas. */
  gutter: 12,
} as const;

/** The canvas keeps at least this much width between two open panes. */
const MIN_CANVAS = 360;

const KEY = "drawpane:panels";
const DEFAULTS: PanelLayout = { left: PANE.default, right: PANE.default, minimized: false };

/**
 * A pane's width as it can be shown: within its range, and narrow enough to
 * leave the canvas room beside the other pane (`other`: its width, 0 when
 * it's closed). The range wins when the window is too small for both.
 */
export function clampPane(width: number, viewportWidth: number, other: number): number {
  const room = viewportWidth - other - MIN_CANVAS - PANE.gutter * (other > 0 ? 4 : 3);
  const max = Math.max(PANE.min, Math.min(PANE.max, room));
  return Math.round(Math.min(max, Math.max(PANE.min, width)));
}

/** What's stored, keeping only well-formed values. */
export function readPanelLayout(raw: string | null): PanelLayout {
  try {
    const parsed = JSON.parse(raw ?? "null") as Record<string, unknown> | null;
    const width = (v: unknown) =>
      typeof v === "number" && Number.isFinite(v)
        ? Math.round(Math.min(PANE.max, Math.max(PANE.min, v)))
        : PANE.default;
    return {
      left: width(parsed?.left),
      right: width(parsed?.right),
      minimized: parsed?.minimized === true,
    };
  } catch {
    return DEFAULTS;
  }
}

let store: Store<PanelLayout> | null = null;

function layoutStore(): Store<PanelLayout> {
  if (!store) {
    let initial = DEFAULTS;
    try {
      initial = readPanelLayout(localStorage.getItem(KEY));
    } catch {
      // No storage: the defaults.
    }
    store = new Store<PanelLayout>(initial);
  }
  return store;
}

export function panelLayout(): PanelLayout {
  return layoutStore().get();
}

/** Changes the layout; `remember: false` while a drag is still going (saved when it ends). */
export function setPanelLayout(patch: Partial<PanelLayout>, { remember = true } = {}): void {
  const s = layoutStore();
  s.set(patch);
  if (!remember) return;
  try {
    localStorage.setItem(KEY, JSON.stringify(s.get()));
  } catch {
    // Not remembered; still works.
  }
}

export function usePanelLayout(): PanelLayout {
  const s = layoutStore();
  return useSyncExternalStore(s.subscribe, s.get);
}

/** For tests: forget what was loaded. */
export function resetPanelLayout(): void {
  store = null;
}
