import {
  CanvasRenderer,
  type CanvasTextMeasurer,
  drawOverlay,
  fontString,
  type Interaction,
  type OverlayTheme,
  type PointerInput,
} from "@drawpane/editor";
import { getProp } from "@drawpane/model";
import { useEffect, useMemo, useRef } from "react";
import { isMac } from "../app/format";
import { COMPONENT_DRAG_MIME } from "./AssetsPanel";
import { useEditor, useEditorState } from "./hooks";
import { imagesFor } from "./media";
import { TextEditor } from "./TextEditor";
import { VectorHints } from "./VectorHints";

function readTheme(): OverlayTheme {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(`--${name}`).trim();
  return {
    signal: v("signal"),
    onSignal: v("on-signal"),
    guide: v("guide"),
    component: v("component"),
    componentInk: v("component-ink"),
    inkMuted: v("ink-muted"),
    surfaceRaised: v("surface-raised"),
    xrayPadding: v("xray-padding"),
    xrayGap: v("xray-gap"),
    presence: [1, 2, 3, 4, 5, 6, 7, 8].map((n) => v(`presence-${n}`)),
    onPresence: v("on-presence"),
    agent: v("agent"),
    onAgent: v("on-agent"),
    fontUi: v("font-ui") || "sans-serif",
    fontMono: v("font-mono") || "monospace",
  };
}

export function Canvas({ interaction }: { interaction: Interaction }) {
  const editor = useEditor();
  const host = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLCanvasElement>(null);
  const overlay = useRef<HTMLCanvasElement>(null);
  const editingText = useEditorState((s) => s.editingText);
  const measurer = editor.measurer as CanvasTextMeasurer;
  const renderer = useMemo(
    () => new CanvasRenderer(editor.scene, measurer, { images: imagesFor(editor) }),
    [editor, measurer],
  );

  // Render loop: repaint content when the document, page or camera changes;
  // repaint the overlay on any state change. Never more than once per frame.
  useEffect(() => {
    const contentCanvas = content.current;
    const overlayCanvas = overlay.current;
    const hostEl = host.current;
    if (!contentCanvas || !overlayCanvas || !hostEl) return;
    const cctx = contentCanvas.getContext("2d", { alpha: false });
    const octx = overlayCanvas.getContext("2d");
    if (!cctx || !octx) return;

    const canvasToken = () =>
      getComputedStyle(document.documentElement).getPropertyValue("--canvas").trim() || "#ebeae6";
    let theme = readTheme();
    renderer.canvasColor = canvasToken();
    let dpr = window.devicePixelRatio || 1;
    let contentDirty = true;
    let overlayDirty = true;
    let frame = 0;
    let last = editor.s;

    const draw = () => {
      frame = 0;
      const s = editor.s;
      if (contentDirty && s.pageId) {
        renderer.hidden = s.editingText ? new Set([s.editingText]) : new Set();
        renderer.render(cctx, s.pageId, s.camera, s.viewport, dpr);
        contentDirty = false;
      }
      if (overlayDirty) {
        drawOverlay(octx, editor, interaction, theme, dpr);
        overlayDirty = false;
      }
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(draw);
    };

    const resize = () => {
      dpr = window.devicePixelRatio || 1;
      const { width, height } = hostEl.getBoundingClientRect();
      for (const canvas of [contentCanvas, overlayCanvas]) {
        canvas.width = Math.max(1, Math.round(width * dpr));
        canvas.height = Math.max(1, Math.round(height * dpr));
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
      }
      editor.setViewport(width, height);
      contentDirty = overlayDirty = true;
      schedule();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(hostEl);
    resize();

    const offDoc = editor.doc.subscribe(() => {
      contentDirty = overlayDirty = true;
      schedule();
    });
    // An image finished decoding (or a sharper copy is ready): repaint the content.
    const offImages = renderer.images.subscribe(() => {
      contentDirty = true;
      schedule();
    });
    const offState = editor.state.subscribe(() => {
      const s = editor.s;
      if (
        s.camera !== last.camera ||
        s.pageId !== last.pageId ||
        s.editingText !== last.editingText ||
        s.viewport !== last.viewport
      ) {
        contentDirty = true;
      }
      last = s;
      overlayDirty = true;
      schedule();
    });

    // Web fonts arrive after first paint: re-measure and repaint when they do.
    const onFonts = () => {
      measurer.invalidate();
      contentDirty = overlayDirty = true;
      schedule();
    };
    document.fonts.addEventListener("loadingdone", onFonts);
    void document.fonts.load(fontString({})).then(onFonts);

    const themeObserver = new MutationObserver(() => {
      theme = readTheme();
      renderer.canvasColor = canvasToken();
      contentDirty = overlayDirty = true;
      schedule();
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });

    return () => {
      observer.disconnect();
      themeObserver.disconnect();
      offDoc();
      offImages();
      offState();
      document.fonts.removeEventListener("loadingdone", onFonts);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [editor, interaction, renderer, measurer]);

  // Pointer and wheel input.
  useEffect(() => {
    const el = overlay.current;
    if (!el) return;
    const toInput = (e: PointerEvent | MouseEvent, clicks = 1): PointerInput => {
      const rect = el.getBoundingClientRect();
      return {
        screen: { x: e.clientX - rect.left, y: e.clientY - rect.top },
        button: e.button,
        shift: e.shiftKey,
        alt: e.altKey,
        mod: isMac() ? e.metaKey : e.ctrlKey,
        clicks,
      };
    };
    let clicks = 0;
    let lastDown = 0;
    let lastPos = { x: 0, y: 0 };

    const sendPresence = (e: PointerEvent | null) => {
      const s = editor.s;
      const rect = el.getBoundingClientRect();
      const cursor = e
        ? s.camera.toPage({ x: e.clientX - rect.left, y: e.clientY - rect.top })
        : null;
      editor.sync.setPresence({
        cursor,
        pageId: s.pageId,
        selection: [...s.selection].slice(0, 500),
      });
    };

    const onDown = (e: PointerEvent) => {
      if (e.button === 2) return;
      const now = performance.now();
      clicks =
        now - lastDown < 400 && Math.hypot(e.clientX - lastPos.x, e.clientY - lastPos.y) < 6
          ? clicks + 1
          : 1;
      lastDown = now;
      lastPos = { x: e.clientX, y: e.clientY };
      el.setPointerCapture(e.pointerId);
      interaction.down(toInput(e, clicks));
      el.style.cursor = interaction.cursor;
      e.preventDefault();
    };
    const onMove = (e: PointerEvent) => {
      // Coalesced events give smooth strokes on high-rate pointers; the last one is enough for moves.
      interaction.move(toInput(e));
      el.style.cursor = interaction.cursor;
      sendPresence(e);
    };
    const onUp = (e: PointerEvent) => {
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
      interaction.up(toInput(e));
      el.style.cursor = interaction.cursor;
    };
    const onCancel = () => interaction.cancel();
    const onLeave = () => {
      if (!interaction.busy) editor.state.set({ hover: null });
      sendPresence(null);
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      // Normalize line and page deltas to pixels.
      const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? rect.height : 1;
      interaction.wheel({
        deltaX: e.deltaX * scale,
        deltaY: e.deltaY * scale,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        shiftKey: e.shiftKey,
        screen: { x: e.clientX - rect.left, y: e.clientY - rect.top },
      });
    };
    // Safari pinch gestures.
    let gestureStart = 1;
    const onGestureStart = (e: Event) => {
      e.preventDefault();
      gestureStart = editor.s.camera.zoom;
    };
    const onGestureChange = (e: Event) => {
      e.preventDefault();
      const g = e as Event & { scale: number; clientX: number; clientY: number };
      const rect = el.getBoundingClientRect();
      editor.setCamera(
        editor.s.camera.zoomAt(
          { x: g.clientX - rect.left, y: g.clientY - rect.top },
          gestureStart * g.scale,
        ),
      );
    };

    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onCancel);
    el.addEventListener("pointerleave", onLeave);
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("gesturestart", onGestureStart);
    el.addEventListener("gesturechange", onGestureChange);
    const offSelection = editor.state.subscribe(() => {
      // Tell collaborators when your selection or page changes, even without moving.
      const s = editor.s;
      if (s.selection !== lastSelection || s.pageId !== lastPage) {
        lastSelection = s.selection;
        lastPage = s.pageId;
        sendPresence(null);
      }
    });
    let lastSelection = editor.s.selection;
    let lastPage = editor.s.pageId;
    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onCancel);
      el.removeEventListener("pointerleave", onLeave);
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("gesturestart", onGestureStart);
      el.removeEventListener("gesturechange", onGestureChange);
      offSelection();
    };
  }, [editor, interaction]);

  const editingNode = editingText ? editor.doc.get(editingText) : undefined;

  return (
    <div
      ref={host}
      className="canvas"
      role="application"
      aria-label="Design canvas"
      aria-roledescription="canvas"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(COMPONENT_DRAG_MIME)) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        }
      }}
      onDrop={(e) => {
        const componentId = e.dataTransfer.getData(COMPONENT_DRAG_MIME);
        if (!componentId) return;
        e.preventDefault();
        const rect = e.currentTarget.getBoundingClientRect();
        const page = editor.s.camera.toPage({ x: e.clientX - rect.left, y: e.clientY - rect.top });
        editor.insertInstance(componentId, page);
      }}
    >
      <canvas ref={content} className="canvas__layer" />
      <canvas ref={overlay} className="canvas__layer canvas__overlay" />
      {editingNode && getProp(editingNode.props, "visible") ? (
        <TextEditor nodeId={editingNode.id} />
      ) : null}
      <VectorHints />
    </div>
  );
}
