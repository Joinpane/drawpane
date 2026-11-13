/**
 * Publishes the file's dashboard thumbnail: a picture of the first page,
 * rendered here with the canvas's renderer and uploaded once edits settle
 * (10 s after the last change), when the tab is hidden, and when you leave
 * the file. Only editors publish; nothing is sent when nothing changed.
 */
import { CanvasRenderer, type Editor, renderThumbnail } from "@drawpane/editor";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { imagesFor } from "./media";

const SETTLE_MS = 10_000;
const MAX_BYTES = 1024 * 1024;
/** Browsers only keep requests this small alive after the page goes away. */
const KEEPALIVE_BYTES = 64 * 1024;

async function render(editor: Editor): Promise<Blob | null> {
  const pageId = editor.doc.pageIds()[0];
  if (!pageId) return null;
  const renderer = new CanvasRenderer(editor.scene, editor.measurer, { images: imagesFor(editor) });
  let blob = await renderThumbnail(renderer, editor.scene, pageId);
  // Busy pages can encode large; halve until it fits the endpoint's limit.
  for (let size = 320; blob && blob.size > MAX_BYTES && size >= 80; size /= 2)
    blob = await renderThumbnail(renderer, editor.scene, pageId, {
      maxWidth: size,
      maxHeight: (size * 3) / 4,
    });
  return blob && blob.size <= MAX_BYTES ? blob : null;
}

export function useThumbnailPublisher(
  editor: Editor,
  fileId: string,
  thumbnailAt: number | null | undefined,
): void {
  const queryClient = useQueryClient();
  // Read when needed rather than restarting the publisher when file metadata refetches.
  const known = useRef(thumbnailAt);
  known.current = thumbnailAt;
  useEffect(() => {
    let dirty = false;
    let timer = 0;
    let running = false;
    /** Whether the server has a thumbnail: unknown (null) until metadata loads or this publishes. */
    let published: boolean | null = null;
    const hasThumbnail = () =>
      published ?? (known.current === undefined ? null : known.current !== null);

    const publish = async () => {
      clearTimeout(timer);
      if (!dirty || running || !editor.canEdit) return;
      dirty = false;
      running = true;
      try {
        const blob = await render(editor);
        const url = `/api/files/${encodeURIComponent(fileId)}/thumbnail`;
        if (!blob) {
          // An empty first page: fall back to the dashboard's placeholder.
          if (hasThumbnail() && editor.doc.childIds(editor.doc.pageIds()[0] ?? "").length === 0) {
            await fetch(url, { method: "DELETE", credentials: "same-origin", keepalive: true });
            published = false;
          }
        } else {
          const response = await fetch(url, {
            method: "PUT",
            credentials: "same-origin",
            headers: { "content-type": blob.type },
            body: blob,
            keepalive: blob.size <= KEEPALIVE_BYTES,
          });
          if (response.ok) published = true;
        }
        void queryClient.invalidateQueries({ queryKey: ["files"] });
      } catch {
        // A thumbnail is a nicety: try again after the next edit.
        dirty = true;
      } finally {
        running = false;
      }
    };

    const schedule = () => {
      dirty = true;
      clearTimeout(timer);
      timer = window.setTimeout(() => void publish(), SETTLE_MS);
    };

    const offDoc = editor.doc.subscribe((change) => {
      // The snapshot that opens the file isn't an edit.
      if (change.reset) return;
      schedule();
    });
    // Files from before thumbnails existed get one soon after they open.
    const offState = editor.state.subscribe(() => {
      if (hasThumbnail() !== false || dirty || editor.s.status !== "live" || !editor.canEdit)
        return;
      const pageId = editor.doc.pageIds()[0];
      if (pageId && editor.doc.childIds(pageId).length > 0) schedule();
    });
    const onHidden = () => {
      if (document.visibilityState === "hidden") void publish();
    };
    const onPageHide = () => void publish();
    document.addEventListener("visibilitychange", onHidden);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      offDoc();
      offState();
      document.removeEventListener("visibilitychange", onHidden);
      window.removeEventListener("pagehide", onPageHide);
      // Leaving the file: publish now. The document stays in memory until this finishes.
      void publish();
    };
  }, [editor, fileId, queryClient]);
}
