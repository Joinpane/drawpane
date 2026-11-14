/**
 * Publishes the file's dashboard thumbnail: a picture of the first page,
 * rendered here with the canvas's renderer and uploaded once edits settle
 * (10 s after the last change), and when the tab is hidden or you leave the
 * file with edits not yet in it. A file whose thumbnail is missing or older
 * than its last edit (a tab closed too soon) gets one 10 s after it opens.
 * Only editors publish.
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
  /** When the file was last edited: a thumbnail older than that is stale. */
  updatedAt?: number,
): void {
  const queryClient = useQueryClient();
  // Read when needed rather than restarting the publisher when file metadata refetches.
  const known = useRef(thumbnailAt);
  known.current = thumbnailAt;
  const editedAt = useRef(updatedAt);
  editedAt.current = updatedAt;
  useEffect(() => {
    let dirty = false;
    /** Edits since the last publish: worth publishing even as the page goes away. */
    let edited = false;
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
      edited = false;
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
      edited = true;
      schedule();
    });
    // On open, refresh a thumbnail that's missing or older than the file's last
    // edit (an edit whose tab closed before it published). A current one is
    // left alone: drawing a big file for nothing would also hold up leaving it.
    let opened = false;
    const offState = editor.state.subscribe(() => {
      if (opened || editor.s.status !== "live" || !editor.canEdit) return;
      opened = true;
      const pageId = editor.doc.pageIds()[0];
      const empty = !pageId || editor.doc.childIds(pageId).length === 0;
      const at = known.current;
      const stale =
        at === null ||
        (at !== undefined && editedAt.current !== undefined && at < editedAt.current);
      if (empty ? hasThumbnail() !== false : stale || at === undefined) schedule();
    });
    // Going away: publish edits now. A refresh nobody edited can wait for the
    // next open, rather than drawing the file while the next page waits.
    const onHidden = () => {
      if (document.visibilityState === "hidden" && edited) void publish();
    };
    const onPageHide = () => {
      if (edited) void publish();
    };
    document.addEventListener("visibilitychange", onHidden);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      offDoc();
      offState();
      document.removeEventListener("visibilitychange", onHidden);
      window.removeEventListener("pagehide", onPageHide);
      // Leaving the file with edits not in the thumbnail: publish now. The
      // document stays in memory until this finishes.
      if (edited) void publish();
    };
  }, [editor, fileId, queryClient]);
}
