import {
  CanvasRenderer,
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
  type TextMeasurer,
} from "@drawpane/editor";
import { getProp } from "@drawpane/model";
import { colors } from "@drawpane/ui";
import { useEffect, useMemo, useRef } from "react";
import { isMac } from "../app/format";
import { loadedFamilies, watchDocumentFonts } from "../fonts/document-fonts";
import { fonts } from "../fonts/fonts";
import { COMPONENT_DRAG_MIME } from "./AssetsPanel";
import { passesToCanvas } from "./canvas-gestures";
import { EngineView, rendererChoice } from "./engine-view";
import { FrameNameEditor } from "./FrameNameEditor";
import { frameStatsFor } from "./frame-stats";
import { useEditor, useEditorState } from "./hooks";
import { LIBRARY_DRAG_MIME, type LibraryDrag, loadedSource } from "./libraries/sources";
import { imagesFor } from "./media";
import { shaper } from "./shaping";
import { TextEditor } from "./TextEditor";
import { openMenu } from "./ui-state";
import { VectorHints } from "./VectorHints";

/** How long a zoom rests before its stand-in frames give way to an exact one. */
const SETTLE_MS = 120;
/**
 * Milliseconds a frame may spend drawing the design. A frame that would take
 * longer (a large page, whole) is drawn a few tiles a frame instead, its
 * stand-in showing meanwhile (decision 0028); the overlay has the rest of
 * the frame.
 */
const CONTENT_BUDGET = 8;

function readTheme(): OverlayTheme {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(`--${name}`).trim();
  return {
    signal: v("signal"),
    onSignal: v("on-signal"),
    // Labels on a page background the file chose read in whichever theme's inks suit it.
    otherLabels: (() => {
      const other = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
      return { inkMuted: colors["ink-muted"][other], componentInk: colors["component-ink"][other] };
    })(),
    guide: v("guide"),
    onGuide: v("on-guide"),
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
  /** The render engine's WebGPU canvas, under the overlay; shown only while it draws the page. */
  const gpuCanvas = useRef<HTMLCanvasElement>(null);
  const editingText = useEditorState((s) => s.editingText);
  // The editor's measurer re-measures after web fonts load (EditorPage gives it one that does).
  const measurer = editor.measurer as TextMeasurer & { invalidate(): void };
  const renderer = useMemo(
    () => new CanvasRenderer(editor.scene, measurer, { images: imagesFor(editor) }),
    [editor, measurer],
  );

  // Render loop: repaint content when the document, page or camera changes;
  // repaint the overlay on any state change. Never more than once per frame.
  useEffect(() => {
    const contentCanvas = content.current;
    const overlayCanvas = overlay.current;
    const engineCanvas = gpuCanvas.current;
    const hostEl = host.current;
    if (!contentCanvas || !overlayCanvas || !hostEl || !engineCanvas) return;
    const cctx = contentCanvas.getContext("2d", { alpha: false });
    const octx = overlayCanvas.getContext("2d");
    if (!cctx || !octx) return;

    // Cropping starts from what a fill shows, which needs each image's own size.
    editor.imageSize = (ref) => imagesFor(editor).natural(ref);
    const canvasToken = () =>
      getComputedStyle(document.documentElement).getPropertyValue("--canvas").trim() || "#ebeae6";
    let theme = readTheme();
    renderer.canvasColor = canvasToken();
    // The render engine, behind its switch (decision 0040): it draws the page when it can, and
    // the canvas renderer draws whatever it can't, never a blank canvas.
    let engine: EngineView | null = null;
    let engineShowing = false;
    let disposed = false;
    const choice = rendererChoice();
    const showEngine = (on: boolean) => {
      if (on === engineShowing) return;
      engineShowing = on;
      engineCanvas.style.visibility = on ? "visible" : "hidden";
      contentCanvas.style.visibility = on ? "hidden" : "visible";
      // The canvas renderer drew nothing meanwhile: its last frame can't be reused.
      if (!on) renderer.invalidate();
    };
    if (choice !== "canvas")
      void EngineView.create(engineCanvas, editor, measurer, imagesFor(editor), choice).then(
        (view) => {
          if (disposed) {
            view?.dispose();
            return;
          }
          engine = view;
          if (!view) return;
          view.onChange = () => {
            contentDirty = true;
            schedule();
          };
          view.onFallback = () => {
            engine = null;
            showEngine(false);
            contentDirty = true;
            schedule();
          };
          (window as unknown as { drawpaneEngineView?: EngineView }).drawpaneEngineView = view;
          contentDirty = true;
          schedule();
        },
      );
    let dpr = window.devicePixelRatio || 1;
    let contentDirty = true;
    let overlayDirty = true;
    let frame = 0;
    let last = editor.s;

    const timing = frameStatsFor(editor);
    timing.redraw = () => {
      renderer.invalidate();
      exact = true;
      // Asked for by tests that read the canvas next: drawn whole in one frame, never a part.
      whole = true;
      contentDirty = true;
      schedule();
    };
    timing.compare = () => {
      const s = editor.s;
      if (!s.pageId) return null;
      const { width, height } = contentCanvas;
      // Drawn again on the same canvas (another canvas may rasterise differently), whole, at once.
      const shown = cctx.getImageData(0, 0, width, height).data;
      renderer.invalidate();
      renderer.render(cctx, s.pageId, s.camera, s.viewport, dpr, { exact: true });
      const whole = cctx.getImageData(0, 0, width, height).data;
      let differing = 0;
      let max = 0;
      for (let i = 0; i < shown.length; i += 4) {
        const d = Math.max(
          Math.abs((shown[i] ?? 0) - (whole[i] ?? 0)),
          Math.abs((shown[i + 1] ?? 0) - (whole[i + 1] ?? 0)),
          Math.abs((shown[i + 2] ?? 0) - (whole[i + 2] ?? 0)),
        );
        if (d > 0) differing++;
        if (d > max) max = d;
      }
      return { pixels: width * height, differing, max };
    };
    // A zoom draws quick stand-in frames; once it pauses, one exact frame follows.
    let exact = false;
    /** The next content frame is drawn whole, without a budget (see `timing.redraw`). */
    let whole = false;
    let settle = 0;
    let fadeTimer = 0;
    const draw = () => {
      frame = 0;
      const s = editor.s;
      const t0 = performance.now();
      const page = s.pageId ? editor.doc.get(s.pageId) : undefined;
      const drewEngine =
        contentDirty &&
        s.pageId !== null &&
        (engine?.draw(
          s.pageId,
          s.camera,
          contentCanvas.width,
          contentCanvas.height,
          dpr,
          (page && getProp(page.props, "backgroundColor")) ?? renderer.canvasColor,
          { hidden: renderer.hidden, whole: s.editingText },
        ) ??
          false);
      if (engine) showEngine(drewEngine);
      if (drewEngine) {
        contentDirty = false;
        timing.exact = true;
      } else if (contentDirty && s.pageId) {
        // Truncated text shows all its lines while it's being edited.
        renderer.whole = s.editingText;
        const done = renderer.render(
          cctx,
          s.pageId,
          s.camera,
          s.viewport,
          dpr,
          whole ? { exact: true } : { exact, budget: CONTENT_BUDGET },
        );
        exact = false;
        whole = false;
        clearTimeout(settle);
        contentDirty = false;
        if (renderer.pending) {
          // Drawn in part: the next frame draws more.
          contentDirty = true;
          schedule();
        } else if (!done)
          settle = window.setTimeout(() => {
            exact = true;
            contentDirty = true;
            schedule();
          }, SETTLE_MS);
        timing.drawn = renderer.stats.drawn;
        timing.culled = renderer.stats.culled;
        timing.exact = done;
      }
      const t1 = performance.now();
      if (overlayDirty) {
        drawOverlay(octx, editor, interaction, theme, dpr, imagesFor(editor));
        overlayDirty = false;
        // Idle cursors fade: draw every frame while one is fading, else wake when the next starts.
        clearTimeout(fadeTimer);
        const wait = editor.cursors.nextChange();
        if (wait === 0) {
          overlayDirty = true;
          schedule();
        } else if (wait !== null) {
          fadeTimer = window.setTimeout(() => {
            overlayDirty = true;
            schedule();
          }, wait + 16);
        }
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
      // The engine's canvas sizes its buffer when it draws (resizing a configured WebGPU canvas
      // reconfigures it); here it only takes the host's size on the page.
      engineCanvas.style.width = `${width}px`;
      engineCanvas.style.height = `${height}px`;
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
        // Text named by an alias ("SF Pro") is drawn in what just loaded ("SF Pro Text") too.
        for (const family of [...families])
          for (const from of fonts.aliasedTo(family)) families.add(from);
        if (families.size > 0) editor.refitText(families);
      }
      contentDirty = overlayDirty = true;
      schedule();
    };
    document.fonts.addEventListener("loadingdone", onFonts);
    // A face for OpenType features became ready: its text is shaped now, so measure and draw it again.
    const offShaper = shaper.subscribe((family) => {
      editor.refitText(new Set([family]));
      contentDirty = overlayDirty = true;
      schedule();
    });
    void document.fonts.load(fontString({})).then(() => onFonts());
    // The team's fonts, aliases or the catalog arrived: a run may be drawn in another family now.
    const offRegistry = fonts.subscribe(() => {
      contentDirty = overlayDirty = true;
      schedule();
    });

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
      disposed = true;
      engine?.dispose();
      observer.disconnect();
      themeObserver.disconnect();
      offDoc();
      offImages();
      offState();
      document.fonts.removeEventListener("loadingdone", onFonts);
      offRegistry();
      offShaper();
      offFonts();
      if (frame) cancelAnimationFrame(frame);
      clearTimeout(settle);
      clearTimeout(fadeTimer);
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

    /**
     * Where the pointer is on the canvas: on screen, and on the page. Scrolling or zooming
     * moves the page under a still pointer, so the page point is worked out again then.
     */
    let pointerAt: { x: number; y: number } | null = null;
    let cursor: { x: number; y: number } | null = null;
    const sendPresence = (e: PointerEvent | null) => {
      if (e) {
        const rect = el.getBoundingClientRect();
        pointerAt = { x: e.clientX - rect.left, y: e.clientY - rect.top };
        cursor = editor.s.camera.toPage(pointerAt);
      } else {
        pointerAt = null;
        cursor = null;
      }
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
      interaction.leave();
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

    // Scrolls and pinches that start on chrome floating over this canvas
    // (canvas-gestures.ts) move it too, when the pointer is over it: in
    // compare mode, each canvas takes only its own half of the screen.
    const under = (e: { clientX: number; clientY: number }) => {
      const r = el.getBoundingClientRect();
      return (
        e.clientX >= r.left && e.clientX < r.right && e.clientY >= r.top && e.clientY < r.bottom
      );
    };
    const fromChrome = (e: Event) => !(e.target instanceof Node && el.contains(e.target));
    const onChromeWheel = (e: WheelEvent) => {
      if (e.defaultPrevented && !e.ctrlKey) return; // Something on the way took it.
      if (!fromChrome(e) || !under(e)) return;
      if (!passesToCanvas(e.target, e.ctrlKey ? null : { x: e.deltaX, y: e.deltaY })) return;
      onWheel(e);
    };
    let chromeGesture = false;
    const onChromeGestureStart = (e: Event) => {
      const g = e as Event & { clientX: number; clientY: number };
      chromeGesture = fromChrome(e) && under(g) && passesToCanvas(e.target, null);
      if (chromeGesture) onGestureStart(e);
    };
    const onChromeGestureChange = (e: Event) => {
      if (chromeGesture && fromChrome(e)) onGestureChange(e);
    };
    window.addEventListener("wheel", onChromeWheel, { passive: false });
    window.addEventListener("gesturestart", onChromeGestureStart);
    window.addEventListener("gesturechange", onChromeGestureChange);
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
      if (s.pageId !== last.pageId) {
        pointerAt = null;
        cursor = null;
      } else if (s.camera !== last.camera && pointerAt) {
        cursor = s.camera.toPage(pointerAt);
      }
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
      window.removeEventListener("wheel", onChromeWheel);
      window.removeEventListener("gesturestart", onChromeGestureStart);
      window.removeEventListener("gesturechange", onChromeGestureChange);
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
        if (
          e.dataTransfer.types.includes(COMPONENT_DRAG_MIME) ||
          e.dataTransfer.types.includes(LIBRARY_DRAG_MIME)
        ) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        }
      }}
      onDrop={(e) => {
        const componentId = e.dataTransfer.getData(COMPONENT_DRAG_MIME);
        const fromLibrary = e.dataTransfer.getData(LIBRARY_DRAG_MIME);
        if (!componentId && !fromLibrary) return;
        e.preventDefault();
        const rect = e.currentTarget.getBoundingClientRect();
        const page = editor.s.camera.toPage({ x: e.clientX - rect.left, y: e.clientY - rect.top });
        if (componentId) {
          editor.insertInstance(componentId, page);
          return;
        }
        // A team library's component: its tile showed it, so its publish is loaded.
        let drag: LibraryDrag;
        try {
          drag = JSON.parse(fromLibrary) as LibraryDrag;
        } catch {
          return;
        }
        const source = loadedSource(drag.publishId, editor.doc.copies);
        if (source)
          editor.insertLibraryComponent(
            source.doc,
            { fileId: drag.fileId, name: drag.name, publishId: drag.publishId },
            drag.assetId,
            page,
          );
      }}
    >
      <canvas ref={content} className="canvas__layer" />
      {/* After the content canvas, so it's the first canvas wherever a canvas is looked for. */}
      <canvas ref={gpuCanvas} className="canvas__layer" style={{ visibility: "hidden" }} />
      <canvas ref={overlay} className="canvas__layer canvas__overlay" />
      {/* Keyed: editing another layer starts afresh, never with the last one's text. */}
      {editingNode && getProp(editingNode.props, "visible") ? (
        <TextEditor key={editingNode.id} nodeId={editingNode.id} />
      ) : null}
      <VectorHints />
      <FrameNameEditor />
    </div>
  );
}
