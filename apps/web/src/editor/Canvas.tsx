import {
  CanvasRenderer,
  type CanvasTextMeasurer,
  drawOverlay,
  fontString,
  frameLabelAt,
  guideAt,
  type Interaction,
  isArtboard,
  type OverlayTheme,
  type PointerInput,
  placedGuides,
  selectionTarget,
} from "@drawpane/editor";
import { getProp } from "@drawpane/model";
import { useEffect, useMemo, useRef } from "react";
import { isMac } from "../app/format";
import { loadedFamilies, watchDocumentFonts } from "../fonts/document-fonts";
import { COMPONENT_DRAG_MIME } from "./AssetsPanel";
import { FrameNameEditor } from "./FrameNameEditor";
import { frameStatsFor } from "./frame-stats";
import { useEditor, useEditorState } from "./hooks";
import { imagesFor } from "./media";
import { TextEditor } from "./TextEditor";
import { openMenu } from "./ui-state";
import { VectorHints } from "./VectorHints";

/** How long a zoom rests before its stand-in frames give way to an exact one. */
const SETTLE_MS = 120;

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

    // Cropping starts from what a fill shows, which needs each image's own size.
    editor.imageSize = (ref) => imagesFor(editor).natural(ref);
    const canvasToken = () =>
      getComputedStyle(document.documentElement).getPropertyValue("--canvas").trim() || "#ebeae6";
    let theme = readTheme();
    renderer.canvasColor = canvasToken();
    let dpr = window.devicePixelRatio || 1;
    let contentDirty = true;
    let overlayDirty = true;
    let frame = 0;
    let last = editor.s;

    const timing = frameStatsFor(editor);
    timing.redraw = () => {
      renderer.invalidate();
      exact = true;
      contentDirty = true;
      schedule();
    };
    // A zoom draws quick stand-in frames; once it pauses, one exact frame follows.
    let exact = false;
    let settle = 0;
    const draw = () => {
      frame = 0;
      const s = editor.s;
      const t0 = performance.now();
      if (contentDirty && s.pageId) {
        // Truncated text shows all its lines while it's being edited.
        renderer.whole = s.editingText;
        const done = renderer.render(cctx, s.pageId, s.camera, s.viewport, dpr, { exact });
        exact = false;
        clearTimeout(settle);
        if (!done)
          settle = window.setTimeout(() => {
            exact = true;
            contentDirty = true;
            schedule();
          }, SETTLE_MS);
        contentDirty = false;
        timing.drawn = renderer.stats.drawn;
        timing.culled = renderer.stats.culled;
      }
      const t1 = performance.now();
      if (overlayDirty) {
        drawOverlay(octx, editor, interaction, theme, dpr, imagesFor(editor));
        overlayDirty = false;
      }
      timing.record(t1 - t0, performance.now() - t1);
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
      // Sizing a canvas clears it, even to the same size: the last frame is
      // gone, so the renderer mustn't reuse it (a pan would move black).
      renderer.invalidate();
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
        s.viewport !== last.viewport ||
        s.editingText !== last.editingText
      ) {
        contentDirty = true;
      }
      last = s;
      overlayDirty = true;
      schedule();
    });

    // Web fonts arrive after first paint: re-measure and repaint when they do,
    // and fix the stored size of text that was measured with a fallback.
    const offFonts = watchDocumentFonts(editor.doc);
    const onFonts = (event?: FontFaceSetLoadEvent) => {
      measurer.invalidate();
      if (event) {
        const families = loadedFamilies(event.fontfaces);
        if (families.size > 0) editor.refitText(families);
      }
      contentDirty = overlayDirty = true;
      schedule();
    };
    document.fonts.addEventListener("loadingdone", onFonts);
    void document.fonts.load(fontString({})).then(() => onFonts());

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
      offFonts();
      if (frame) cancelAnimationFrame(frame);
      clearTimeout(settle);
    };
  }, [editor, interaction, renderer, measurer]);

  // Pointer and wheel input.
  useEffect(() => {
    const el = overlay.current;
    if (!el) return;
    /** Where the pointer last was, so a modifier pressed mid-drag can take effect without a move. */
    let pointer: { clientX: number; clientY: number; button: number } | null = null;
    const toInput = (
      e: { clientX: number; clientY: number; button: number },
      keys: { shiftKey: boolean; altKey: boolean; metaKey: boolean; ctrlKey: boolean },
      clicks = 1,
    ): PointerInput => {
      const rect = el.getBoundingClientRect();
      return {
        screen: { x: e.clientX - rect.left, y: e.clientY - rect.top },
        button: e.button,
        shift: keys.shiftKey,
        alt: keys.altKey,
        mod: isMac() ? keys.metaKey : keys.ctrlKey,
        // Holding Control ignores smart guides (on a Mac too, where ⌘ means other things).
        noSnap: keys.ctrlKey,
        clicks,
      };
    };
    let clicks = 0;
    let lastDown = 0;
    let lastPos = { x: 0, y: 0 };

    /** Last pointer on the canvas (page coordinates), resent with view changes. */
    let cursor: { x: number; y: number } | null = null;
    const sendPresence = (e: PointerEvent | null) => {
      if (e) {
        const rect = el.getBoundingClientRect();
        cursor = editor.s.camera.toPage({ x: e.clientX - rect.left, y: e.clientY - rect.top });
      } else cursor = null;
      editor.sync.setPresence(editor.presence(cursor));
    };

    const onDown = (e: PointerEvent) => {
      if (e.button === 2) return;
      // The canvas takes focus back from controls outside it (a comment pin, an
      // inspector field), so arrow keys move layers again and typed values commit.
      // preventDefault below would otherwise leave focus where it was.
      const active = document.activeElement;
      const canvasHost = el.parentElement;
      if (
        active instanceof HTMLElement &&
        active !== document.body &&
        !canvasHost?.contains(active)
      )
        active.blur();
      const now = performance.now();
      clicks =
        now - lastDown < 400 && Math.hypot(e.clientX - lastPos.x, e.clientY - lastPos.y) < 6
          ? clicks + 1
          : 1;
      lastDown = now;
      lastPos = { x: e.clientX, y: e.clientY };
      el.setPointerCapture(e.pointerId);
      pointer = e;
      interaction.down(toInput(e, e, clicks));
      el.style.cursor = interaction.cursor;
      e.preventDefault();
    };
    const onMove = (e: PointerEvent) => {
      // Coalesced events give smooth strokes on high-rate pointers; the last one is enough for moves.
      pointer = e;
      interaction.move(toInput(e, e));
      el.style.cursor = interaction.cursor;
      sendPresence(e);
    };
    const onUp = (e: PointerEvent) => {
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
      pointer = null;
      interaction.up(toInput(e, e));
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

    // Right-click: select what's under the pointer the way a click would
    // (unless it's already in the selection), then open the menu there.
    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      if (interaction.busy) return;
      const pageId = editor.s.pageId;
      if (!pageId) return;
      const rect = el.getBoundingClientRect();
      const screen = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      const point = editor.s.camera.toPage(screen);
      // A guide under the pointer gets its own menu.
      const guide = guideAt(placedGuides(editor.scene, pageId), point, 4 / editor.s.camera.zoom);
      if (guide && editor.canEdit) {
        openMenu(editor, {
          kind: "guide",
          x: e.clientX,
          y: e.clientY,
          guide: { owner: guide.owner, index: guide.index },
        });
        return;
      }
      // Like a click: a frame's label picks the frame; an artboard's empty area picks nothing.
      const label = frameLabelAt(editor, screen);
      const hit = label?.id ?? editor.layersAt(point)[0];
      const leaf = hit && !label && isArtboard(editor, hit) ? undefined : hit;
      const { selection } = editor.s;
      // Over something already selected (a selected frame's empty area too): its menu, selection kept.
      const hitSelected = editor.layersAt(point).some((id) => selection.includes(id));
      const keep = hitSelected && !label;
      if (!keep && !leaf) editor.select([]);
      else if (!keep && label) {
        if (!selection.includes(label.id)) editor.select([label.id]);
      } else if (!keep && leaf) {
        const deep = isMac() ? e.metaKey : e.ctrlKey;
        editor.select([selectionTarget(editor.scene, pageId, leaf, selection, deep)]);
      }
      openMenu(editor, { kind: "canvas", x: e.clientX, y: e.clientY, point });
    };

    // Shift, Alt or Control pressed or let go mid-drag applies straight away, as if the pointer moved.
    const onModifier = (e: KeyboardEvent) => {
      if (!pointer || !interaction.busy) return;
      if (e.key !== "Shift" && e.key !== "Alt" && e.key !== "Control" && e.key !== "Meta") return;
      interaction.move(toInput(pointer, e));
      el.style.cursor = interaction.cursor;
    };
    window.addEventListener("keydown", onModifier);
    window.addEventListener("keyup", onModifier);
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("contextmenu", onContextMenu);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onCancel);
    el.addEventListener("pointerleave", onLeave);
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("gesturestart", onGestureStart);
    el.addEventListener("gesturechange", onGestureChange);
    // Tell collaborators when your selection, page or view changes, even without
    // moving the pointer: followers see what you see. (Sync throttles sending.)
    let last = editor.s;
    const offSelection = editor.state.subscribe(() => {
      const s = editor.s;
      const moved =
        s.selection !== last.selection ||
        s.pageId !== last.pageId ||
        s.camera !== last.camera ||
        s.viewport !== last.viewport ||
        s.insets !== last.insets ||
        s.following !== last.following ||
        s.spotlight !== last.spotlight;
      if (s.pageId !== last.pageId) cursor = null;
      last = s;
      if (moved) editor.sync.setPresence(editor.presence(cursor));
    });
    return () => {
      window.removeEventListener("keydown", onModifier);
      window.removeEventListener("keyup", onModifier);
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("contextmenu", onContextMenu);
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
      <FrameNameEditor />
    </div>
  );
}
