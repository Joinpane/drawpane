/**
 * UI requests that cross panes without going through the document: "rename
 * this layer" (from ⌘R or a menu, answered by the layers panel) and "open a
 * context menu here" (from the canvas, layers or pages, answered by the
 * editor page). One small store per editor, like the image cache.
 */
import { type Editor, Store } from "@drawpane/editor";
import { useSyncExternalStore } from "react";

export interface MenuRequest {
  /** What was right-clicked: the canvas (with or without a selection), or a page in the list. */
  readonly kind: "canvas" | "layers" | "page" | "guide";
  /** Viewport coordinates of the pointer. */
  readonly x: number;
  readonly y: number;
  /** Page coordinates under the pointer, for canvas menus ("Paste here", "Select layer"). */
  readonly point?: { readonly x: number; readonly y: number };
  /** The page a page menu is for. */
  readonly pageId?: string;
  /** The guide a guide menu is for. */
  readonly guide?: { readonly owner: string; readonly index: number };
}

export interface EditorUi {
  /** The layer being renamed in place, if any. */
  readonly renaming: string | null;
  /** The open context menu, if any. */
  readonly menu: MenuRequest | null;
  /** Bumped to open the layers search and focus it (⌘F). */
  readonly findLayers: number;
  /** Bumped to fold every layer on the page (⌥L). */
  readonly collapseLayers: number;
  /** Bumped to open the text styles picker for the selected text (⌥⌘T). */
  readonly textStyles: number;
  /** The Selection Lens shows beside the selection (a view preference). */
  readonly lens: boolean;
  /** Layout X-ray stays on without holding Alt (the inspector's X-ray button). */
  readonly xrayPinned: boolean;
}

const stores = new WeakMap<Editor, Store<EditorUi>>();

export function uiFor(editor: Editor): Store<EditorUi> {
  let store = stores.get(editor);
  if (!store) {
    store = new Store<EditorUi>({
      renaming: null,
      menu: null,
      findLayers: 0,
      collapseLayers: 0,
      textStyles: 0,
      lens: true,
      xrayPinned: false,
    });
    stores.set(editor, store);
  }
  return store;
}

/** Keeps Layout X-ray on without holding Alt, or turns it back off. */
export function toggleXray(editor: Editor): void {
  const ui = uiFor(editor);
  const pinned = !ui.get().xrayPinned;
  ui.set({ xrayPinned: pinned });
  editor.state.set({ xray: pinned });
}

export function useUi<T>(editor: Editor, select: (ui: EditorUi) => T): T {
  const store = uiFor(editor);
  return useSyncExternalStore(store.subscribe, () => select(store.get()));
}

/** Opens a context menu; the editor page renders it. */
export function openMenu(editor: Editor, request: MenuRequest): void {
  uiFor(editor).set({ menu: request });
}
