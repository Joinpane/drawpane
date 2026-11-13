import type { Editor, EditorState } from "@drawpane/editor";
import { createContext, useCallback, useContext, useRef, useSyncExternalStore } from "react";

export const EditorContext = createContext<Editor | null>(null);

export function useEditor(): Editor {
  const editor = useContext(EditorContext);
  if (!editor) throw new Error("useEditor outside EditorContext");
  return editor;
}

/** Subscribes to a slice of editor state; re-renders only when the slice changes. */
export function useEditorState<T>(select: (state: EditorState) => T, equal: (a: T, b: T) => boolean = Object.is): T {
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

/** Re-renders whenever the document changes. Returns the document version. */
export function useDocVersion(): number {
  const editor = useEditor();
  return useSyncExternalStore(
    (cb) => editor.doc.subscribe(cb),
    () => editor.doc.version,
  );
}

export const shallowArray = <T>(a: readonly T[], b: readonly T[]) => a.length === b.length && a.every((v, i) => v === b[i]);
