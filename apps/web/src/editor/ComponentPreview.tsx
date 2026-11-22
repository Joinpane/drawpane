/** A component's thumbnail, for the Assets panel: this file's own, or a team library's. */
import { Camera, CanvasRenderer, type Editor } from "@drawpane/editor";
import type { NodeRecord } from "@drawpane/model";
import { useEffect, useMemo, useRef, useState } from "react";
import { useResolvedTheme } from "../app/theme";
import { isAbortError, renderEngineSnapshot } from "./engine-snapshot";
import { useDeferredDocVersion, useEditor } from "./hooks";
import { imagesFor } from "./media";
import { useEngineRenderer } from "./renderer-switch";

const PREVIEW = { width: 112, height: 72 };

function topLevelOf(editor: Editor, id: string): string {
  let current = editor.doc.get(id);
  while (current) {
    const parent = editor.doc.get(current.parent);
    if (!parent || parent.type === "page") return current.id;
    current = parent;
  }
  return id;
}

/** Lazy CanvasRenderer per editor for fallback when engine mode encounters an unsupported component. */
const fallbackRenderers = new WeakMap<Editor, CanvasRenderer>();

function getFallbackRenderer(editor: Editor): CanvasRenderer | null {
  let renderer = fallbackRenderers.get(editor);
  if (!renderer) {
    try {
      renderer = new CanvasRenderer(editor.scene, editor.measurer, { images: imagesFor(editor) });
      fallbackRenderers.set(editor, renderer);
    } catch {
      return null;
    }
  }
  return renderer;
}

async function renderCanvasComponentPreview(editor: Editor, nodeId: string): Promise<Blob | null> {
  if (typeof OffscreenCanvas === "undefined") return null;
  const renderer = getFallbackRenderer(editor);
  const bounds = editor.scene.bounds(nodeId);
  if (!renderer || !bounds) return null;
  const dpr = window.devicePixelRatio || 1;
  const camera = new Camera().fit(bounds, PREVIEW, 8, 2);
  const rect = {
    x: -camera.x / camera.zoom,
    y: -camera.y / camera.zoom,
    width: PREVIEW.width / camera.zoom,
    height: PREVIEW.height / camera.zoom,
  };
  const canvas = new OffscreenCanvas(
    Math.max(1, Math.round(PREVIEW.width * dpr)),
    Math.max(1, Math.round(PREVIEW.height * dpr)),
  );
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  renderer.renderNodes(ctx, [nodeId], rect, camera.zoom * dpr, null, false, false);
  return canvas.convertToBlob({ type: "image/png" });
}

function CanvasComponentPreview({ node, source }: { node: NodeRecord; source?: Editor }) {
  const live = useEditor();
  const editor = source ?? live;
  const version = useDeferredDocVersion();
  const ref = useRef<HTMLCanvasElement>(null);
  const renderer = useMemo(
    () => new CanvasRenderer(editor.scene, editor.measurer, { images: imagesFor(editor) }),
    [editor],
  );
  const theme = useResolvedTheme();
  useEffect(() => {
    void version;
    void theme;
    const canvas = ref.current;
    const page = editor.doc.pageOf(node.id);
    const bounds = editor.scene.bounds(node.id);
    if (!canvas || !page || !bounds) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = PREVIEW.width * dpr;
    canvas.height = PREVIEW.height * dpr;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const camera = new Camera().fit(bounds, PREVIEW, 8, 2);
    renderer.canvasColor = getComputedStyle(document.documentElement)
      .getPropertyValue("--surface-sunken")
      .trim();
    // Render only this component: hide its siblings on the page for the preview.
    renderer.hidden = new Set(
      editor.doc.childIds(page.id).filter((id) => id !== topLevelOf(editor, node.id)),
    );
    renderer.render(ctx, page.id, camera, PREVIEW, dpr);
  }, [editor, renderer, node.id, version, theme]);
  return <canvas ref={ref} className="assets__preview" style={PREVIEW} />;
}

function EngineComponentPreview({ node, source }: { node: NodeRecord; source?: Editor }) {
  const live = useEditor();
  const editor = source ?? live;
  const version = useDeferredDocVersion();
  const host = useRef<HTMLSpanElement>(null);
  const [shown, setShown] = useState(typeof IntersectionObserver === "undefined");
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    const el = host.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      setShown(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setShown(true);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!shown) return;
    let cancelled = false;
    let made: string | null = null;
    const abort = new AbortController();
    const timer = setTimeout(
      async () => {
        const bounds = editor.scene.bounds(node.id);
        if (!bounds) {
          setUrl(null);
          return;
        }
        const dpr = window.devicePixelRatio || 1;
        const camera = new Camera().fit(bounds, PREVIEW, 8, 2);
        const rect = {
          x: -camera.x / camera.zoom,
          y: -camera.y / camera.zoom,
          width: PREVIEW.width / camera.zoom,
          height: PREVIEW.height / camera.zoom,
        };
        try {
          let blob: Blob | null = null;
          try {
            blob = await renderEngineSnapshot(editor, {
              ids: [node.id],
              rect,
              width: Math.max(1, Math.round(PREVIEW.width * dpr)),
              height: Math.max(1, Math.round(PREVIEW.height * dpr)),
              scale: camera.zoom * dpr,
              format: "png",
              background: null,
              context: false,
              images: imagesFor(editor),
              priority: "low",
              signal: abort.signal,
            });
          } catch (error) {
            if (!abort.signal.aborted && !isAbortError(error)) {
              blob = await renderCanvasComponentPreview(editor, node.id);
            } else {
              throw error;
            }
          }
          if (cancelled || !blob) return;
          made = URL.createObjectURL(blob);
          setUrl(made);
        } catch {
          // Cancelled or failed preview: keep placeholder or prior picture.
        }
      },
      version === 0 ? 0 : 120,
    );
    return () => {
      cancelled = true;
      abort.abort();
      clearTimeout(timer);
      if (made) URL.revokeObjectURL(made);
    };
  }, [editor, node.id, version, shown]);

  return (
    <span ref={host} className="assets__preview" style={PREVIEW} aria-hidden="true">
      {url ? <img src={url} alt="" /> : null}
    </span>
  );
}

/**
 * A small render of a component, redrawn when the file changes. Follows the renderer switch:
 * uses the engine snapshot service when the engine is on, and CanvasRenderer in canvas mode.
 * From `source` when it is another document's (a library's published snapshot).
 */
export function ComponentPreview({ node, source }: { node: NodeRecord; source?: Editor }) {
  const props = source ? { node, source } : { node };
  return useEngineRenderer() ? (
    <EngineComponentPreview {...props} />
  ) : (
    <CanvasComponentPreview {...props} />
  );
}
