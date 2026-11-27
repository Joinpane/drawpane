/**
 * Publishes the file's dashboard thumbnail: a picture of the first page, uploaded once edits
 * settle (10 s after the last change), and when the tab is hidden or you leave the file with
 * edits not yet in it. A file whose thumbnail is missing or older than its last edit (a tab
 * closed too soon) gets one 10 s after it opens. Only editors publish.
 *
 * Follows the renderer switch: uses the engine snapshot service (WebP 0.85, stepped to stay
 * inside the 64 KiB keepalive budget where possible) when the engine is on, and CanvasRenderer
 * when canvas mode is active.
 */
import { type Editor, renderThumbnail, thumbnailLayout } from "@drawpane/editor";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { withCanvasOutputRenderer } from "./canvas-output";
import { isAbortError, renderEngineSnapshot, type SnapshotPriority } from "./engine-snapshot";
import { imagesFor } from "./media";
import { useEngineRenderer } from "./renderer-switch";

const SETTLE_MS = 10_000;
const MAX_BYTES = 1024 * 1024;
/** Browsers only keep requests this small alive after the page goes away. */
export const THUMBNAIL_KEEPALIVE_BYTES = 64 * 1024;

export interface PageThumbnailOptions {
  readonly pageId?: string;
  readonly maxWidth?: number;
  readonly maxHeight?: number;
  readonly format?: "webp" | "png";
  readonly quality?: number;
  readonly priority?: SnapshotPriority;
  readonly signal?: AbortSignal;
  /** Force engine rendering regardless of the renderer switch (for debug and parity tools). */
  readonly forceEngine?: boolean;
}

async function renderCanvasPageThumbnail(
  editor: Editor,
  pageId: string,
  maxWidth: number,
  maxHeight: number,
  format: "webp" | "png",
  quality: number,
  signal?: AbortSignal,
): Promise<Blob | null> {
  const type = format === "png" ? "image/png" : "image/webp";
  const drawAt = (width: number, height: number) => {
    const layout = thumbnailLayout(editor.scene, pageId, { maxWidth: width, maxHeight: height });
    if (!layout) return Promise.resolve(null);
    return withCanvasOutputRenderer(
      editor,
      { ids: layout.ids, scale: layout.scale, thumbnail: true, ...(signal ? { signal } : {}) },
      (renderer, onDrawn) =>
        renderThumbnail(renderer, editor.scene, pageId, {
          maxWidth: width,
          maxHeight: height,
          type,
          quality,
          ...(onDrawn ? { onDrawn } : {}),
        }),
    );
  };
  let blob = await drawAt(maxWidth, maxHeight);
  for (
    let size = Math.floor(maxWidth / 2);
    blob && blob.size > MAX_BYTES && size >= 80;
    size = Math.floor(size / 2)
  ) {
    blob = await drawAt(size, Math.max(1, Math.round((size * maxHeight) / maxWidth)));
  }
  return blob && blob.size <= MAX_BYTES ? blob : null;
}

/**
 * Renders a page's thumbnail (without editor overlays). Uses the engine snapshot service when
 * the engine switch is on (WebP at 0.85 by default, stepping quality then dimensions to fit
 * the 64 KiB keepalive budget so tab-close uploads survive), and CanvasRenderer in canvas mode.
 */
export async function renderPageThumbnail(
  editor: Editor,
  options: PageThumbnailOptions = {},
): Promise<Blob | null> {
  const pageId = options.pageId ?? editor.doc.pageIds()[0];
  if (!pageId) return null;
  const maxWidth = options.maxWidth ?? 640;
  const maxHeight = options.maxHeight ?? 480;
  const format = options.format ?? "webp";
  const baseQuality = options.quality ?? 0.85;

  if (!options.forceEngine && !useEngineRenderer()) {
    return renderCanvasPageThumbnail(
      editor,
      pageId,
      maxWidth,
      maxHeight,
      format,
      baseQuality,
      options.signal,
    );
  }

  const drawAt = async (
    w: number,
    h: number,
    quality: number,
    maxBytes?: number,
  ): Promise<Blob | null> => {
    const layout = thumbnailLayout(editor.scene, pageId, { maxWidth: w, maxHeight: h });
    if (!layout) return null;
    return renderEngineSnapshot(editor, {
      ids: layout.ids,
      rect: layout.rect,
      width: layout.width,
      height: layout.height,
      scale: layout.scale,
      format,
      quality,
      ...(maxBytes !== undefined ? { maxBytes } : {}),
      background: layout.background,
      context: false,
      detail: true,
      images: imagesFor(editor),
      priority: options.priority ?? "low",
      ...(options.signal ? { signal: options.signal } : {}),
    });
  };

  try {
    let blob = await drawAt(
      maxWidth,
      maxHeight,
      baseQuality,
      format === "webp" ? THUMBNAIL_KEEPALIVE_BYTES : undefined,
    );
    if (!blob) return null;

    // Final safety cap against the 1 MiB endpoint limit.
    for (
      let size = Math.floor(maxWidth / 2);
      blob && blob.size > MAX_BYTES && size >= 80;
      size = Math.floor(size / 2)
    ) {
      blob = await drawAt(
        size,
        Math.max(1, Math.round((size * maxHeight) / maxWidth)),
        format === "webp" ? 0.65 : baseQuality,
        format === "webp" ? THUMBNAIL_KEEPALIVE_BYTES : undefined,
      );
    }
    return blob && blob.size <= MAX_BYTES ? blob : null;
  } catch (error) {
    if (!options.forceEngine && !options.signal?.aborted && !isAbortError(error)) {
      try {
        const fallback = await renderCanvasPageThumbnail(
          editor,
          pageId,
          maxWidth,
          maxHeight,
          format,
          baseQuality,
          options.signal,
        );
        if (fallback) return fallback;
      } catch {
        // Keep the original engine error only when the canvas also fails.
      }
    }
    throw error;
  }
}

async function render(editor: Editor): Promise<Blob | null> {
  return renderPageThumbnail(editor);
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
    /** Set when a publish trigger (settle timer, tab hide, or unmount) arrived while running. */
    let pending = false;
    let timer = 0;
    let running = false;
    /** Whether the server has a thumbnail: unknown (null) until metadata loads or this publishes. */
    let published: boolean | null = null;
    const hasThumbnail = () =>
      published ?? (known.current === undefined ? null : known.current !== null);

    const publish = async () => {
      clearTimeout(timer);
      timer = 0;
      if (!dirty || !editor.canEdit) return;
      if (running) {
        pending = true;
        return;
      }
      dirty = false;
      edited = false;
      pending = false;
      running = true;
      let failed = false;
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
            keepalive: blob.size <= THUMBNAIL_KEEPALIVE_BYTES,
          });
          if (response.ok) published = true;
        }
        void queryClient.invalidateQueries({ queryKey: ["files"] });
      } catch {
        // A thumbnail is a nicety: try again after the next edit.
        dirty = true;
        failed = true;
      } finally {
        running = false;
        if (!failed && dirty && editor.canEdit && (pending || timer === 0)) {
          void publish();
        }
      }
    };

    const schedule = () => {
      dirty = true;
      clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = 0;
        void publish();
      }, SETTLE_MS);
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
      clearTimeout(timer);
      timer = 0;
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
