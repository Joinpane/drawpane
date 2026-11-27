import type { Doc, Editor, EditorState } from "@drawpane/editor";
import {
  createContext,
  startTransition,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

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
 * The document version, for panels beside the canvas (layers, inspector,
 * assets). Outside a gesture it's `useDocVersion`: the panel renders with
 * the edit. During one (a drag, a scrub, typing), whose every frame is an
 * edit, it follows as a React transition instead, so rendering the panel
 * never holds up the canvas's next frame: the panel catches up as soon as
 * the main thread is free, and at once when the gesture ends.
 */
export function useDeferredDocVersion(): number {
  const editor = useEditor();
  const gesture = useEditorState((s) => s.gesture);
  const subscribe = useCallback(
    (cb: () => void) => (gesture ? () => {} : editor.doc.subscribe(cb)),
    [editor, gesture],
  );
  // Constant during a gesture, so a transition's render never reads it torn.
  const live = useSyncExternalStore(subscribe, () => (gesture ? -1 : editor.doc.version));
  const [followed, setFollowed] = useState(() => editor.doc.version);
  useEffect(() => {
    if (!gesture) return;
    const follow = () => startTransition(() => setFollowed(editor.doc.version));
    follow();
    return editor.doc.subscribe(follow);
  }, [editor, gesture]);
  return gesture ? followed : live;
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
  // Kept for one document and one selector: two documents (a version's preview and the live
  // file) can be at the same version number.
  const cache = useRef<{ doc: Doc; select: unknown; version: number; value: T } | null>(null);
  const getSnapshot = useCallback(() => {
    const doc = editor.doc;
    const known =
      cache.current?.doc === doc && cache.current.select === select ? cache.current : null;
    if (known && known.version === doc.version) return known.value;
    const next = select(doc);
    const value = known && equal(known.value, next) ? known.value : next;
    cache.current = { doc, select, version: doc.version, value };
    return value;
  }, [editor, select, equal]);
  const subscribe = useCallback((cb: () => void) => editor.doc.subscribe(cb), [editor]);
  return useSyncExternalStore(subscribe, getSnapshot);
}

export const shallowArray = <T>(a: readonly T[], b: readonly T[]) =>
  a.length === b.length && a.every((v, i) => v === b[i]);

/** Whether document edits are permitted in the current role and workspace mode. */
export function canEditState(state: EditorState): boolean {
  return state.role !== "viewer" && !state.readOnly;
}

/** Subscribes to whether the current workspace allows document edits. */
export function useCanEdit(): boolean {
  return useEditorState(canEditState);
}

/** Like `useEditorState`, for components that own the editor (outside its context). */
export function useEditorStateOutside<T>(editor: Editor, select: (state: EditorState) => T): T {
  return useSyncExternalStore(editor.state.subscribe, () => select(editor.state.get()));
}
