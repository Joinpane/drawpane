import {
  CanvasRenderer,
  fontString,
  frameLabelAt,
  guideAt,
  type Interaction,
  isArtboard,
  OverlayRenderer,
  type OverlayTheme,
  overlayStateChanged,
  type PointerInput,
  placedGuides,
  type ShapingMeasurer,
  selectionTarget,
} from "@drawpane/editor";
import { getProp } from "@drawpane/model";
import { colors } from "@drawpane/ui";
import { useRouterState } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { isMac } from "../app/format";
import { loadedFamilies, watchDocumentFonts } from "../fonts/document-fonts";
import { fonts } from "../fonts/fonts";
import { COMPONENT_DRAG_MIME } from "./AssetsPanel";
import { passesToCanvas } from "./canvas-gestures";
import {
  EngineView,
  engineFallback,
  type FallbackEvent,
  IDLE_SLICE_MS,
  MOVING_BUDGET_MS,
  presentation,
  REST_BUDGET_MS,
  rendererChoice,
} from "./engine-view";
import { FrameNameEditor } from "./FrameNameEditor";
import { frameStatsFor } from "./frame-stats";
import { useEditor, useEditorState } from "./hooks";
import { LIBRARY_DRAG_MIME, type LibraryDrag, loadedSource } from "./libraries/sources";
import { imagesFor } from "./media";
import { engineBackendLabel, fallbackToReason, setRendererStatus } from "./renderer-status";
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
/** Overscan margin (CSS px) on each side of the retained artboard labels canvas for zero-copy CSS pan translation. */
const LABEL_OVERSCAN_CSS = 144;
/** Maximum device-pixel dimension per axis for the overscanned labels canvas. */
const MAX_LABEL_CANVAS_PX = 4096;

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
  /** Retained pixel grid layer above the design, under labels and the transient overlay. */
  const pixelGrid = useRef<HTMLCanvasElement>(null);
  /** Retained artboard labels layer under the transient overlay, translated on same-zoom pan. */
  const labels = useRef<HTMLCanvasElement>(null);
  const overlay = useRef<HTMLCanvasElement>(null);
  /** Durable React-owned container slot for the render engine's active canvas, under the overlay. */
  const engineSlot = useRef<HTMLDivElement>(null);
  const [cpuMode, setCpuMode] = useState(false);
  const editingText = useEditorState((s) => s.editingText);
  // Read the switch reactively so changing `?renderer=...` or `?present=...` in place takes effect without a reload.
  const searchStr = useRouterState({ select: (s) => s.location.searchStr });
  const choice = useMemo(() => rendererChoice(searchStr), [searchStr]);
  const present = useMemo(() => presentation(searchStr), [searchStr]);
  // The editor's measurer re-measures after web fonts load (EditorPage gives it one that does).
  const measurer = editor.measurer as ShapingMeasurer;
  const renderer = useMemo(
    () => new CanvasRenderer(editor.scene, measurer, { images: imagesFor(editor) }),
    [editor, measurer],
  );

  // Render loop: repaint content when the document, page or camera changes;
  // repaint the overlay on any state change. Never more than once per frame.
  useEffect(() => {
    const contentCanvas = content.current;
    const pixelGridCanvas = pixelGrid.current;
    const labelsCanvas = labels.current;
    const overlayCanvas = overlay.current;
    const engineSlotEl = engineSlot.current;
    const hostEl = host.current;
    if (
      !contentCanvas ||
      !pixelGridCanvas ||
      !labelsCanvas ||
      !overlayCanvas ||
      !hostEl ||
      !engineSlotEl
    )
      return;
    const cctx = contentCanvas.getContext("2d", { alpha: false });
    const pctx = pixelGridCanvas.getContext("2d");
    const lctx = labelsCanvas.getContext("2d");
    const octx = overlayCanvas.getContext("2d");
    if (!cctx || !pctx || !lctx || !octx) return;
    measurer.setEngineText(choice !== "canvas");
    const overlayRenderer = new OverlayRenderer();
    let labelsEnabled = true;
    // The retained pixel grid shares the labels surface's size and overscan;
    // too large for both, the overlay draws the grid itself instead.
    let pixelGridEnabled = true;

    // Cropping starts from what a fill shows, which needs each image's own size.
    editor.imageSize = (ref) => imagesFor(editor).natural(ref);
    const canvasToken = () =>
      getComputedStyle(document.documentElement).getPropertyValue("--canvas").trim() || "#ebeae6";
    let theme = readTheme();
    renderer.canvasColor = canvasToken();
    // The render engine, behind its switch (decision 0040): it draws the page when it can, and
    // the canvas renderer draws whatever it can't, never a blank canvas.
    let activeEngineCanvas: HTMLCanvasElement | null = null;
    let engine: EngineView | null = null;
    let createdView: EngineView | null = null;
    let engineShowing = false;
    let engineStarted = false;
    let terminalFallback: FallbackEvent | null = null;
    let disposed = false;
    const engineInit = new AbortController();
    engineSlotEl.replaceChildren();
    engineSlotEl.style.visibility = "hidden";
    contentCanvas.style.visibility = "visible";
    let engineSubmittedFrames = 0;
    let enginePresentedFrames = 0;
    /** Highest submitted frame sequence number confirmed presented on the visible engine canvas. */
    let engineConfirmedFrame = 0;
    /** Maps EngineView frame numbers (`view.last.n`) to monotonic submission sequence numbers. */
    const submittedFrameSeq = new Map<number, number>();
    let fallbackFrames = 0;
    const syncRendererAttr = () => {
      const active = engineShowing ? engine : null;
      hostEl.dataset.renderer = active ? active.backend : "canvas";
      hostEl.dataset.rendererAdapter = active ? active.adapter : "canvas";
      hostEl.dataset.rendererAdapterClass = active ? active.adapterClass : "canvas";
      hostEl.dataset.rendererSoftware = active
        ? String(active.backend === "cpu-worker" || active.software)
        : "false";
      hostEl.dataset.rendererPresented = active ? String(active.lastPresented) : "true";
      hostEl.dataset.rendererPresentation = active
        ? active.readsBack
          ? "readback"
          : "direct"
        : "2d";
      hostEl.dataset.rendererSubmittedFrames = String(engineSubmittedFrames);
      hostEl.dataset.rendererFrames = String(enginePresentedFrames);
      hostEl.dataset.rendererConfirmedFrame = String(engineConfirmedFrame);
      hostEl.dataset.rendererFallbackFrames = String(fallbackFrames);
    };
    const syncRendererStatus = () => {
      if (choice === "canvas") {
        setCpuMode(false);
        setRendererStatus(editor, { switchOn: false });
        return;
      }
      setCpuMode(
        engine !== null &&
          engine.backend === "cpu-worker" &&
          (engineShowing || (!engine.recovering && engine.last.supported)),
      );
      if (engineShowing && engine) {
        setRendererStatus(editor, {
          switchOn: true,
          choice,
          active: "engine",
          backend: engineBackendLabel(engine.backend),
          adapter: engine.adapter,
          compatibility: engine.compatibility,
          software: engine.software,
          limit: engine.limitReason,
          reducedImages: engine.reducedImages,
        });
        return;
      }
      if (engine?.recovering) {
        setRendererStatus(editor, {
          switchOn: true,
          choice,
          active: "canvas",
          reason: { kind: "recovering" },
        });
        return;
      }
      if (engine && !engine.last.supported) {
        setRendererStatus(editor, {
          switchOn: true,
          choice,
          active: "canvas",
          reason: engine.limitReason
            ? { kind: "limit", message: engine.limitReason }
            : { kind: "unsupported", features: Object.keys(engine.unsupported(false)) },
        });
        return;
      }
      if (!engine) {
        const fb = terminalFallback ?? engineFallback();
        setRendererStatus(editor, {
          switchOn: true,
          choice,
          active: "canvas",
          reason: !engineStarted
            ? { kind: "starting" }
            : fb
              ? fallbackToReason(fb)
              : { kind: "error", message: "could not start the render engine" },
        });
        return;
      }
      setRendererStatus(editor, {
        switchOn: true,
        choice,
        active: "canvas",
        reason: { kind: "starting" },
      });
    };
    const paintCoverSync = () => {
      const s = editor.s;
      if (!s.pageId) return;
      renderer.invalidate();
      renderer.whole = s.editingText;
      renderer.render(cctx, s.pageId, s.camera, s.viewport, dpr, {
        exact: false,
        budget: timing.budget ?? CONTENT_BUDGET,
      });
    };
    const showEngine = (on: boolean) => {
      if (on === engineShowing) {
        syncRendererAttr();
        syncRendererStatus();
        return;
      }
      if (!on) {
        submittedFrameSeq.clear();
        paintCoverSync();
      }
      engineShowing = on;
      engineSlotEl.style.visibility = on ? "visible" : "hidden";
      if (activeEngineCanvas) {
        activeEngineCanvas.style.visibility = on ? "visible" : "hidden";
      }
      contentCanvas.style.visibility = on ? "hidden" : "visible";
      syncRendererAttr();
      syncRendererStatus();
      // The canvas renderer drew nothing meanwhile: its last frame can't be reused.
      if (!on) renderer.invalidate();
    };

    syncRendererAttr();
    syncRendererStatus();
    if (choice !== "canvas") {
      shaper.preloadFallback();
      void EngineView.create(
        engineSlotEl,
        editor,
        measurer,
        imagesFor(editor),
        choice,
        engineInit.signal,
      ).then((view) => {
        if (disposed || engineInit.signal.aborted) {
          view?.dispose();
          return;
        }
        engineStarted = true;
        engine = view;
        createdView = view;
        if (!view) {
          syncRendererAttr();
          syncRendererStatus();
          return;
        }
        activeEngineCanvas = view.canvas;
        const { width: hostW, height: hostH } = hostEl.getBoundingClientRect();
        engineSlotEl.style.width = `${hostW}px`;
        engineSlotEl.style.height = `${hostH}px`;
        activeEngineCanvas.style.width = `${hostW}px`;
        activeEngineCanvas.style.height = `${hostH}px`;
        activeEngineCanvas.style.visibility = engineShowing ? "visible" : "hidden";
        syncRendererStatus();
        view.onCanvas = (next) => {
          submittedFrameSeq.clear();
          activeEngineCanvas = next;
          const rect = hostEl.getBoundingClientRect();
          engineSlotEl.style.width = `${rect.width}px`;
          engineSlotEl.style.height = `${rect.height}px`;
          activeEngineCanvas.style.width = `${rect.width}px`;
          activeEngineCanvas.style.height = `${rect.height}px`;
          activeEngineCanvas.style.visibility = engineShowing ? "visible" : "hidden";
        };
        view.onBackendChange = () => {
          syncRendererAttr();
          syncRendererStatus();
        };
        view.onRecovering = (recovering) => {
          if (recovering) {
            showEngine(false);
            contentDirty = true;
            schedule();
          } else {
            syncRendererStatus();
          }
        };
        view.onChange = () => {
          contentDirty = changed = true;
          schedule();
        };
        view.onFallback = (event) => {
          const w = window as unknown as { drawpaneEngineView?: EngineView };
          if (w.drawpaneEngineView === view) delete w.drawpaneEngineView;
          terminalFallback = event;
          engine = null;
          activeEngineCanvas = null;
          engineSlotEl.replaceChildren();
          showEngine(false);
          contentDirty = true;
          schedule();
        };
        // An async frame (GPU read-back or CPU worker tiles) shows once it lands.
        view.onPresented = (frameExact, frameN) => {
          if (
            engine !== view ||
            view.recovering ||
            !activeEngineCanvas ||
            activeEngineCanvas !== view.canvas
          ) {
            return;
          }
          const seq = frameN !== undefined ? submittedFrameSeq.get(frameN) : engineSubmittedFrames;
          if (frameN !== undefined && seq === undefined) return;
          enginePresentedFrames++;
          if (seq !== undefined && seq > engineConfirmedFrame) engineConfirmedFrame = seq;
          showEngine(true);
          syncRendererAttr();
          timing.exact = frameExact;
          if (frameExact) {
            clearTimeout(settle);
            settle = 0;
          }
        };
        // Direct GPU presentation confirms completion after gpuFinished() + rAF, only while the
        // engine canvas that produced this frame is still the visible canvas.
        view.onGpuPresented = (frameN) => {
          if (
            engine !== view ||
            !engineShowing ||
            view.recovering ||
            !activeEngineCanvas ||
            activeEngineCanvas !== view.canvas ||
            engineSlotEl.style.visibility !== "visible" ||
            activeEngineCanvas.style.visibility !== "visible"
          ) {
            return;
          }
          const seq = submittedFrameSeq.get(frameN);
          if (seq === undefined) return;
          enginePresentedFrames++;
          if (seq > engineConfirmedFrame) engineConfirmedFrame = seq;
          syncRendererAttr();
        };
        (window as unknown as { drawpaneEngineView?: EngineView }).drawpaneEngineView = view;
        contentDirty = true;
        schedule();
      });
    }
    let dpr = window.devicePixelRatio || 1;
    let contentDirty = true;
    /**
     * What the page shows changed since the engine last drew (the document, images, fonts),
     * not only the camera: the engine's next frame must send it, so the last moving frame
     * can't simply stay on screen while the time between frames settles it.
     */
    let changed = false;
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
    /** The camera the engine last drew: another one this frame means the camera is moving. */
    let engineCamera: unknown = null;
    // Between frames at rest the engine draws the tiles the next frame wants, a slice at a time
    // (decision 0040, phase 2), until the frame it last drew is all drawn and the tiles round
    // it too. Any frame stops it; a frame at rest that leaves work starts it again.
    let idleOn = false;
    let idlePosted = false;
    /** The engine's last frame was drawn moving (stand-ins), at the camera it still has. */
    let engineMoved = false;
    let idleBackground = "";
    const idle = new MessageChannel();
    const postIdle = () => {
      if (idlePosted) return;
      idlePosted = true;
      idle.port2.postMessage(0);
    };
    idle.port1.onmessage = () => {
      idlePosted = false;
      const pageId = editor.s.pageId;
      if (!idleOn || !engine || disposed || !pageId) return;
      const a = engine.ahead(pageId, idleBackground, IDLE_SLICE_MS);
      if (!a?.progressed) {
        // Nothing more can be done between frames. What's left, if anything, is the frame's to
        // draw: a tile no slot can hold is drawn straight into it, a change that came after the
        // last frame is sent with the next, and a frame at rest that's as drawn as the list
        // allows ends the loop.
        idleOn = false;
        if (contentDirty) schedule();
        return;
      }
      if (a.tiles === 0 && a.textVisible === 0 && contentDirty) {
        // The frame it drew for is all drawn: shown now rather than a frame later, and nothing
        // holds it back (that frame starts the rest again: text out of view, tiles round it).
        idleOn = false;
        if (frame) cancelAnimationFrame(frame);
        draw();
      } else if (a.tiles > 0 || a.queued > 0 || a.text > 0) postIdle();
      else idleOn = false;
    };
    const draw = () => {
      frame = 0;
      idleOn = false;
      const liveDpr = window.devicePixelRatio || 1;
      if (liveDpr !== dpr) applySize();
      const s = editor.s;
      const t0 = performance.now();
      const page = s.pageId ? editor.doc.get(s.pageId) : undefined;
      // The engine draws the page when it can (decision 0040). Which canvas shows changes only
      // when a content frame is drawn, and only to one whose frame is on screen: an overlay-only
      // redraw never hides the engine's frame, and a read-back frame shows once it lands.
      let drewEngine = false;
      const gestureMoving = s.gesture && s.editingText === null;
      if (contentDirty && s.pageId !== null && engine && engineMoved && !whole) {
        if (!gestureMoving && engineCamera === s.camera && engineShowing && !changed) {
          // The camera came to rest where the last frame was drawn: that frame stays on screen
          // while the time between frames draws the rest, and the exact frame follows (a frame
          // now would only show the same stand-ins again).
          drewEngine = true;
          idleOn = true;
          idleBackground = (page && getProp(page.props, "backgroundColor")) ?? renderer.canvasColor;
          postIdle();
        }
        engineMoved = false;
      }
      if (!drewEngine && contentDirty && s.pageId !== null && engine) {
        // Camera motion and pointer gestures have the same moving-frame budget. Once they stop,
        // idle slices fill the remaining exact tiles (decision 0040).
        const moving = !whole && !exact && (gestureMoving || engineCamera !== s.camera);
        const background = (page && getProp(page.props, "backgroundColor")) ?? renderer.canvasColor;
        changed = false;
        const r = engine.draw(
          s.pageId,
          s.camera,
          contentCanvas.width,
          contentCanvas.height,
          dpr,
          background,
          { hidden: renderer.hidden, whole: s.editingText },
          !moving,
          whole ? 0 : moving ? MOVING_BUDGET_MS : REST_BUDGET_MS,
        );
        engineCamera = s.camera;
        engineMoved = r.drawn && moving && !r.exact && engine.backend !== "cpu-worker";
        if (r.awaitingPreview) {
          drewEngine = true;
          contentDirty = false;
        } else if (r.drawn) {
          drewEngine = true;
          contentDirty = false;
          exact = false;
          whole = false;
          clearTimeout(settle);
          const seq = ++engineSubmittedFrames;
          if (engine.last.n > 0) {
            submittedFrameSeq.set(engine.last.n, seq);
            if (submittedFrameSeq.size > 128) {
              const oldest = submittedFrameSeq.keys().next().value;
              if (oldest !== undefined) submittedFrameSeq.delete(oldest);
            }
          }
          if (r.ready) {
            showEngine(true);
            syncRendererAttr();
            timing.exact = r.exact;
          } else {
            syncRendererAttr();
            syncRendererStatus();
            timing.exact = false;
          }
          // Stand-ins on screen while moving: the next frame draws more. At rest, the time
          // between frames draws the rest, without compositing a frame meanwhile, and asks for
          // the frame once what it shows is drawn; then the tiles round the view, ahead of a pan.
          // A frame at rest that isn't exact but is settled (text provisional while its faces
          // load, or an async CPU worker frame in flight) waits: their arrival redraws it.
          if (!r.exact && !(r.settled && !moving)) contentDirty = true;
          if (moving && (!r.exact || r.ahead)) {
            contentDirty = true;
            schedule();
          } else if ((!r.exact && !r.settled) || r.ahead) {
            idleOn = true;
            idleBackground = background;
            postIdle();
          }
        }
      }
      if (!drewEngine && contentDirty && s.pageId) {
        if (choice !== "canvas") fallbackFrames++;
        if (engine) showEngine(false);
        else {
          syncRendererAttr();
          syncRendererStatus();
        }
        // Truncated text shows all its lines while it's being edited.
        renderer.whole = s.editingText;
        const done = renderer.render(
          cctx,
          s.pageId,
          s.camera,
          s.viewport,
          dpr,
          whole ? { exact: true } : { exact, budget: timing.budget ?? CONTENT_BUDGET },
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
        overlayRenderer.draw(
          labelsEnabled ? lctx : null,
          octx,
          editor,
          interaction,
          theme,
          dpr,
          imagesFor(editor),
          pixelGridEnabled ? pctx : null,
        );
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

    let dprQuery: MediaQueryList | null = null;
    const onDprChange = () => resize();
    const watchDpr = () => {
      if (dprQuery) {
        dprQuery.removeEventListener("change", onDprChange);
        dprQuery = null;
      }
      if (typeof window.matchMedia === "function") {
        dprQuery = window.matchMedia(`(resolution: ${dpr}dppx)`);
        dprQuery.addEventListener("change", onDprChange);
      }
    };
    // Chromium CDP `Emulation.setDeviceMetricsOverride` (and some browser DPR-only updates)
    // mutate `devicePixelRatio` and `MediaQueryList.matches` without firing `change` or `resize`
    // events. Check cheaply while mounted and visible so idle editors still refresh backing stores.
    const syncDpr = () => {
      if (disposed || document.hidden) return;
      const live = window.devicePixelRatio || 1;
      if (live !== dpr || (dprQuery && !dprQuery.matches)) {
        resize();
      }
    };
    const dprPoll = window.setInterval(syncDpr, 150);
    window.addEventListener("focus", syncDpr);
    document.addEventListener("visibilitychange", syncDpr);

    const applySize = () => {
      dpr = window.devicePixelRatio || 1;
      watchDpr();
      const { width, height } = hostEl.getBoundingClientRect();
      const devW = Math.max(1, Math.round(width * dpr));
      const devH = Math.max(1, Math.round(height * dpr));
      for (const canvas of [contentCanvas, overlayCanvas]) {
        canvas.width = devW;
        canvas.height = devH;
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
      }
      const retainedAllowed = devW <= MAX_LABEL_CANVAS_PX && devH <= MAX_LABEL_CANVAS_PX;
      labelsEnabled = retainedAllowed;
      pixelGridEnabled = retainedAllowed;
      if (retainedAllowed) {
        const maxCss = Math.floor(MAX_LABEL_CANVAS_PX / dpr);
        const pad = Math.max(
          0,
          Math.min(
            LABEL_OVERSCAN_CSS,
            Math.floor((maxCss - width) / 2),
            Math.floor((maxCss - height) / 2),
          ),
        );
        const retainedW = width + pad * 2;
        const retainedH = height + pad * 2;
        // The pixel grid and labels are the same kind of retained surface:
        // overscanned, CSS-translated on a same-zoom pan, capped per axis.
        for (const canvas of [pixelGridCanvas, labelsCanvas]) {
          canvas.width = Math.min(MAX_LABEL_CANVAS_PX, Math.max(1, Math.round(retainedW * dpr)));
          canvas.height = Math.min(MAX_LABEL_CANVAS_PX, Math.max(1, Math.round(retainedH * dpr)));
          canvas.style.display = "";
          canvas.style.width = `${retainedW}px`;
          canvas.style.height = `${retainedH}px`;
          canvas.style.left = `${-pad}px`;
          canvas.style.top = `${-pad}px`;
          canvas.style.transform = "";
          canvas.dataset.overscan = String(pad);
        }
        labelsCanvas.dataset.retainedLabels = "enabled";
        pixelGridCanvas.dataset.retainedPixelGrid = "enabled";
        overlayRenderer.setOverscan(pad);
      } else {
        // Strictly cap the extra retained labels surface at MAX_LABEL_CANVAS_PX per axis; fall back
        // to single-canvas overlay rendering on `octx` rather than allocating an oversized surface.
        for (const canvas of [pixelGridCanvas, labelsCanvas]) {
          canvas.width = 1;
          canvas.height = 1;
          canvas.style.display = "none";
          canvas.style.width = "0px";
          canvas.style.height = "0px";
          canvas.style.left = "0px";
          canvas.style.top = "0px";
          canvas.style.transform = "";
          canvas.dataset.overscan = "0";
        }
        labelsCanvas.dataset.retainedLabels = "disabled";
        pixelGridCanvas.dataset.retainedPixelGrid = "disabled";
        overlayRenderer.setOverscan(0);
      }
      // The engine's canvas sizes its buffer when it draws (resizing a configured WebGPU canvas
      // reconfigures it); here the slot and active canvas only take the host's size on the page.
      engineSlotEl.style.width = `${width}px`;
      engineSlotEl.style.height = `${height}px`;
      if (activeEngineCanvas) {
        activeEngineCanvas.style.width = `${width}px`;
        activeEngineCanvas.style.height = `${height}px`;
      }
      // Sizing a canvas clears it, even to the same size: the last frame is
      // gone, so the renderer mustn't reuse it (a pan would move black).
      renderer.invalidate();
      overlayRenderer.invalidate();
      editor.setViewport(width, height);
      contentDirty = overlayDirty = changed = true;
    };
    const resize = () => {
      applySize();
      schedule();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(hostEl);
    resize();

    const offDoc = editor.doc.subscribe(() => {
      contentDirty = overlayDirty = changed = true;
      schedule();
    });
    // An image finished decoding (or a sharper copy is ready): repaint the content.
    const offImages = renderer.images.subscribe(() => {
      contentDirty = changed = true;
      schedule();
    });
    const offState = editor.state.subscribe(() => {
      const s = editor.s;
      let dirty = false;
      if (
        s.camera !== last.camera ||
        s.pageId !== last.pageId ||
        s.viewport !== last.viewport ||
        s.editingText !== last.editingText ||
        (last.gesture && !s.gesture && engineMoved)
      ) {
        contentDirty = true;
        // What's drawn ahead is for the frame before: the next one decides again.
        idleOn = false;
        dirty = true;
      }
      if (overlayStateChanged(last, s)) {
        overlayDirty = true;
        dirty = true;
      }
      last = s;
      if (dirty) schedule();
    });

    // Web fonts arrive after first paint: re-measure and repaint when they do,
    // and fix the stored size of text that was measured with a fallback.
    const offFonts = watchDocumentFonts(editor.doc);
    const fontsChanged = () => {
      overlayRenderer.invalidate(true);
      contentDirty = overlayDirty = changed = true;
      schedule();
    };
    const onFonts = (event?: FontFaceSetLoadEvent) => {
      const families = event && loadedFamilies(event.fontfaces);
      if (families) {
        // Text named by an alias is drawn in the face that just loaded.
        for (const family of [...families])
          for (const from of fonts.aliasedTo(family)) families.add(from);
        if (families.size === 0) return;
        measurer.invalidate(families);
        editor.refitText(families);
      } else {
        measurer.invalidate();
      }
      fontsChanged();
    };
    document.fonts.addEventListener("loadingdone", onFonts);
    // A face for OpenType features became ready: its text is shaped now, so measure and draw it again.
    const offShaper = shaper.subscribe((family) => {
      editor.refitText(new Set([family]));
      overlayRenderer.invalidate(true);
      contentDirty = overlayDirty = changed = true;
      schedule();
    });
    void document.fonts.load(fontString({})).then(() => onFonts());
    // The team's fonts, aliases or the catalog arrived: a run may be drawn in another family now.
    const offRegistry = fonts.subscribe(() => {
      overlayRenderer.invalidate(true);
      contentDirty = overlayDirty = changed = true;
      schedule();
    });

    const themeObserver = new MutationObserver(() => {
      theme = readTheme();
      renderer.canvasColor = canvasToken();
      overlayRenderer.invalidate(true);
      contentDirty = overlayDirty = changed = true;
      schedule();
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });

    return () => {
      disposed = true;
      engineInit.abort();
      const w = window as unknown as { drawpaneEngineView?: EngineView };
      if (createdView && w.drawpaneEngineView === createdView) delete w.drawpaneEngineView;
      engine?.dispose();
      activeEngineCanvas = null;
      engineSlotEl.replaceChildren();
      engineSlotEl.style.visibility = "hidden";
      contentCanvas.style.visibility = "visible";
      hostEl.dataset.renderer = "canvas";
      hostEl.dataset.rendererAdapter = "canvas";
      hostEl.dataset.rendererAdapterClass = "canvas";
      hostEl.dataset.rendererSoftware = "false";
      hostEl.dataset.rendererPresented = "true";
      hostEl.dataset.rendererPresentation = "2d";
      hostEl.dataset.rendererSubmittedFrames = "0";
      hostEl.dataset.rendererFrames = "0";
      hostEl.dataset.rendererConfirmedFrame = "0";
      hostEl.dataset.rendererFallbackFrames = "0";
      setCpuMode(false);
      window.clearInterval(dprPoll);
      window.removeEventListener("focus", syncDpr);
      document.removeEventListener("visibilitychange", syncDpr);
      if (dprQuery) {
        dprQuery.removeEventListener("change", onDprChange);
        dprQuery = null;
      }
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
      idle.port1.close();
      clearTimeout(settle);
      clearTimeout(fadeTimer);
    };
  }, [editor, interaction, renderer, measurer, choice, present]);

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
      <canvas ref={content} className="canvas__layer" data-canvas-role="content" />
      {/* After the content canvas, so it's the first canvas wherever a canvas is looked for. */}
      <div
        ref={engineSlot}
        className="canvas__layer canvas__engine-slot"
        data-canvas-role="engine-slot"
        style={{ visibility: "hidden" }}
      />
      <canvas ref={pixelGrid} className="canvas__pixel-grid" data-canvas-role="pixel-grid" />
      <canvas ref={labels} className="canvas__labels" data-canvas-role="labels" />
      <canvas ref={overlay} className="canvas__layer canvas__overlay" data-canvas-role="overlay" />
      {cpuMode ? (
        <div className="canvas__mode-badge" role="status" data-renderer-mode="cpu-worker">
          CPU view mode
        </div>
      ) : null}
      {/* Keyed: editing another layer starts afresh, never with the last one's text. */}
      {editingNode && getProp(editingNode.props, "visible") ? (
        <TextEditor key={editingNode.id} nodeId={editingNode.id} />
      ) : null}
      <VectorHints />
      <FrameNameEditor />
    </div>
  );
}
