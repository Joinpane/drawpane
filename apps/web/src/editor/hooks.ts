import type { Doc, Editor, EditorState } from "@drawpane/editor";
import { createContext, useCallback, useContext, useRef, useSyncExternalStore } from "react";

export const EditorContext = createContext<Editor | null>(null);

export function useEditor(): Editor {
  const editor = useContext(EditorContext);
  if (!editor) throw new Error("useEditor outside EditorContext");
  return editor;
}

/** Subscribes to a slice of editor state; re-renders only when the slice changes. */
export function useEditorState<T>(
  select: (state: EditorState) => T,
  equal: (a: T, b: T) => boolean = Object.is,
): T {
  const editor = useEditor();
  const cache = useRef<{ value: T } | null>(null);
  const getSnapshot = useCallback(() => {
    const next = select(editor.state.get());
    if (cache.current && equal(cache.current.value, next)) return cache.current.value;
    cache.current = { value: next };
    return next;
  }, [editor, select, equal]);
  return useSyncExternalStore(editor.state.subscribe, getSnapshot);
}

/**
 * Re-renders whenever the document changes. Returns the document version.
 * With `active` false it listens to nothing (a closed dialog's), so edits,
 * a drag's every frame among them, don't render it.
 */
export function useDocVersion(active = true): number {
  const editor = useEditor();
  const subscribe = useCallback(
    (cb: () => void) => (active ? editor.doc.subscribe(cb) : () => {}),
    [editor, active],
  );
  return useSyncExternalStore(subscribe, () => (active ? editor.doc.version : -1));
}

/**
 * Subscribes to what `select` reads from the document: re-renders only when
 * that changes (by `equal`), not on every edit.
 */
export function useDocSelector<T>(
  select: (doc: Doc) => T,
  equal: (a: T, b: T) => boolean = Object.is,
): T {
  const editor = useEditor();
  const cache = useRef<{ version: number; value: T } | null>(null);
  const getSnapshot = useCallback(() => {
    const doc = editor.doc;
    const known = cache.current;
    if (known && known.version === doc.version) return known.value;
    const next = select(doc);
    if (known && equal(known.value, next)) {
      cache.current = { version: doc.version, value: known.value };
      return known.value;
    }
    cache.current = { version: doc.version, value: next };
    return next;
  }, [editor, select, equal]);
  const subscribe = useCallback((cb: () => void) => editor.doc.subscribe(cb), [editor]);
  return useSyncExternalStore(subscribe, getSnapshot);
}

export const shallowArray = <T>(a: readonly T[], b: readonly T[]) =>
  a.length === b.length && a.every((v, i) => v === b[i]);

/** Like `useEditorState`, for components that own the editor (outside its context). */
export function useEditorStateOutside<T>(editor: Editor, select: (state: EditorState) => T): T {
  return useSyncExternalStore(editor.state.subscribe, () => select(editor.state.get()));
}
