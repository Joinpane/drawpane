import {
  Editor,
  glassTuning,
  Interaction,
  liveFlows,
  screenOf,
  setCompactCopiesDefault,
  setGlassTuning,
} from "@drawpane/editor";
import type { BranchInfo, VersionInfo } from "@drawpane/model";
import { Button, Icon, IconButton, Logo, PopoverRoomContext, SegmentedControl } from "@drawpane/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import {
  type CSSProperties,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { api } from "../api/client";
import { isMac } from "../app/format";
import { holdReloadWhile } from "../app/updates";
import { fonts } from "../fonts/fonts";
import { refreshInbox } from "../inbox/inbox";
import { ShareDialog } from "../prototype/ShareDialog";
import { AssetsPanel } from "./AssetsPanel";
import { roleChangeNotice } from "./access-notices";
import { ACTIONS, type ActionContext, shortcutFor, triggers } from "./actions";
import { loadBooleanEngine } from "./boolean-engine";
import {
  BranchMenu,
  CompareBar,
  CompareCanvases,
  CompareView,
  changedBounds,
  MergePane,
  ReviewPane,
  type ReviewRow,
  updatedNotice,
  useBranchReview,
} from "./branches";
import { Canvas } from "./Canvas";
import { CommandPalette } from "./CommandPalette";
import { ContextMenus } from "./ContextMenus";
import { CropBar } from "./CropBar";
import {
  CommentsLayer,
  CommentsPanel,
  openThread,
  useCommentStore,
  useComments,
  useThreadLink,
} from "./comments";
import { connectFile } from "./connection";
import { ExplainCard } from "./ExplainCard";
import { ExportPanel } from "./ExportSection";
import { FollowOverlay, People } from "./follow";
import { type FrameStats, frameStatsFor } from "./frame-stats";
import { headlessDebug } from "./headless-debug";
import {
  HistoryPanel,
  NameVersionDialog,
  RestoreDialog,
  Scrubber,
  useVersionHistory,
  VersionBanner,
  VersionDetails,
} from "./history";
import { count } from "./history/labels";
import { EditorContext, useEditor, useEditorState, useEditorStateOutside } from "./hooks";
import { ImageDrop, UploadTray } from "./ImageDrop";
import { InboxMenu } from "./InboxMenu";
import { InspectPanel } from "./InspectPanel";
import { Inspector } from "./inspector/Inspector";
import { isTyping } from "./keymap";
import { LayersPanel } from "./LayersPanel";
import { Lens } from "./Lens";
import { BrowseLibrariesDialog } from "./libraries/LibrarySections";
import { PublishDialog } from "./libraries/PublishDialog";
import { Minimap } from "./Minimap";
import {
  chooseImageFiles,
  filesFrom,
  importImageFiles,
  pasteFromClipboard,
  pasteSvgText,
} from "./media";
import { PagesList } from "./PagesList";
import { PaneResizer } from "./PaneResizer";
import { usePageZoomLock } from "./page-zoom";
import { clampPane, PANE, panelLayout, setPanelLayout, usePanelLayout } from "./panel-layout";
import { useInspectorRoom } from "./popover-room";
import { PrototypePanel } from "./prototype/PrototypePanel";
import { RULER, RULER_GAP, Rulers } from "./Rulers";
import { ShortcutsDialog } from "./ShortcutsDialog";
import { textMeasurer } from "./shaping";
import { Toolbar } from "./Toolbar";
import { useThumbnailPublisher } from "./thumbnail";
import { TokensWorkspace } from "./tokens/TokensWorkspace";
import { uiFor } from "./ui-state";
import { useViewPreferences } from "./view-preferences";
import { XrayLegend } from "./XrayLegend";
import "./editor.css";
import { PASS_GESTURES } from "./canvas-gestures";
import { useOverridesVersion } from "./shortcuts-store";

const CLIPBOARD_MIME = "application/x-drawpane+json";

export function EditorPage() {
  const { fileId } = useParams({ from: "/f/$fileId" });
  // A new file id remounts everything: one Editor per file.
  return <FileEditor key={fileId} fileId={fileId} />;
}

/** Shortcuts that still apply while the tokens workspace hides the canvas. */
const TOKENS_VIEW_ACTIONS = new Set(["edit.undo", "edit.redo", "view.command", "view.tokens"]);
const inTokensView = (action: { id: string; group: string }) =>
  TOKENS_VIEW_ACTIONS.has(action.id) || action.group === "File" || action.group === "Help";

/** A control that Enter or Space activates by itself. */
function isControl(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el?.closest?.(
    'button, a[href], [role="button"], [role="menuitem"], [role="option"], [role="tab"], [role="radio"], summary',
  );
}

function FileEditor({ fileId }: { fileId: string }) {
  const navigate = useNavigate();
  const meta = useQuery({
    queryKey: ["file", fileId],
    queryFn: () => api.file(fileId),
    retry: false,
  });
  const [editor] = useState(() => {
    // Compact copies (decision 0029) stay a developer switch until the room stores them:
    // `localStorage.setItem("drawpane:compact-copies", "1")`.
    try {
      setCompactCopiesDefault(localStorage.getItem("drawpane:compact-copies") === "1");
    } catch {
      // Storage blocked: off.
    }
    return new Editor({ measurer: textMeasurer(), booleanEngine: loadBooleanEngine });
  });
  const interaction = useMemo(() => new Interaction(editor), [editor]);
  // The inspector's popovers open over the canvas, clear of it and of the selection.
  const inspectorPane = useRef<HTMLElement>(null);
  const inspectorRoom = useInspectorRoom(editor, inspectorPane);
  usePageZoomLock();
  const [commandOpen, setCommandOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [leftOpen, setLeftOpen] = useState(true);
  const [leftTab, setLeftTab] = useState<LeftTab>("layers");
  const [view, setView] = useState<"design" | "tokens">("design");
  const viewRef = useRef(view);
  viewRef.current = view;
  const [rightTab, setRightTab] = useState<RightTab>("design");
  // Viewers can't edit, so open them straight into Inspect (free for everyone).
  // The role is only known once the room welcomes us ("viewer" until then).
  const isViewer = useEditorStateOutside(editor, (s) => s.status === "live" && s.role === "viewer");
  useEffect(() => {
    if (isViewer) setRightTab("inspect");
  }, [isViewer]);
  const [rightOpen, setRightOpen] = useState(true);
  // Panel widths and Minimize UI (⇧⌘\\), remembered in this browser.
  const layout = usePanelLayout();
  // Minimized: the layers panel tucks away until it's asked for.
  const leftShown = leftOpen && !layout.minimized;
  const hasSelection = useEditorStateOutside(editor, (s) => s.selection.length > 0);
  const viewportWidth = useEditorStateOutside(editor, (s) => s.viewport.width) || window.innerWidth;
  const [fatal, setFatal] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const comments = useCommentStore(editor, fileId);
  const commentsOpen = useComments(comments.store, (s) => s.panelOpen);
  // An open thread or new comment sits by its pin, often where the Lens would.
  const threadOpen = useComments(comments.store, (s) => s.openId !== null || s.draft !== null);
  // Version history: the History tab lists versions; picking one puts it on the canvas, read-only.
  const history = useVersionHistory(
    editor,
    fileId,
    view === "design" && leftShown && leftTab === "history",
  );
  const viewing = history.viewing;
  const historyOpen = view === "design" && history.open;
  // Branches (decision 0012): on a branch, its record and main file; `?review` opens its review.
  const branch = meta.data?.branch ?? null;
  const mainFile =
    meta.data?.main ?? (meta.data ? { id: fileId, name: meta.data.file.name } : null);
  const { review: reviewAsked } = useSearch({ from: "/f/$fileId" });
  const reviewing =
    reviewAsked === true && view === "design" && !viewing && branch !== null && !branch.merged;
  const setReviewing = useCallback(
    (on: boolean) =>
      void navigate({
        to: "/f/$fileId",
        params: { fileId },
        search: ({ review: _, ...rest }) => (on ? { ...rest, review: true as const } : rest),
        replace: true,
      }),
    [navigate, fileId],
  );
  const openMain = useCallback(() => {
    const id = meta.data?.main?.id;
    if (id) void navigate({ to: "/f/$fileId", params: { fileId: id } });
  }, [meta.data, navigate]);
  const review = useBranchReview(
    editor,
    branch,
    reviewing,
    () => {
      setReviewing(false);
      if (branch && mainFile)
        editor.notify(`Merged “${branch.name}” into ${mainFile.name}.`, {
          label: `Open ${mainFile.name}`,
          run: openMain,
        });
    },
    ({ changes, kept }) => editor.notify(updatedNotice(mainFile?.name ?? "main", changes, kept)),
  );
  const canMerge = meta.data?.role !== undefined && meta.data.role !== "viewer";
  // Main beside the branch while reviewing it, once review has read main.
  const compare = useMemo(
    () => new CompareView(editor, new Editor({ measurer: editor.measurer })),
    [editor],
  );
  const comparing = reviewing && review.main !== null;
  const compareMode = useSyncExternalStore(compare.state.subscribe, () => compare.s.mode);
  const [activeChange, setActiveChange] = useState<string | null>(null);
  useEffect(() => {
    if (!comparing || !review.main) return;
    compare.load(review.main);
    return compare.link();
  }, [comparing, review.main, compare]);
  // On opening review, and on changing how the two are shown (the canvases move), show
  // everything that changed on this page, once the canvases have their new size.
  const fittedReview = useRef<string | null>(null);
  const reviewRows = review.rows;
  useEffect(() => {
    if (!comparing) {
      fittedReview.current = null;
      return;
    }
    if (fittedReview.current === compareMode || !reviewRows) return;
    fittedReview.current = compareMode;
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        const bounds = changedBounds(
          editor,
          reviewRows.map((r) => r.id),
        );
        if (!bounds) editor.zoomToFit();
        else
          editor.setCamera(editor.s.camera.fit(bounds, editor.s.viewport, 96, 2, editor.s.insets));
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [comparing, compareMode, reviewRows, editor]);
  // What the room says about merges, read from the latest of these.
  const branchRef = useRef({ branch, mainFile, openMain });
  branchRef.current = { branch, mainFile, openMain };
  const active = history.active;
  const activeInteraction = viewing ? history.view.interaction : interaction;
  // Minimized: the inspector comes while something is selected (or a version is on screen).
  const rightShown = rightOpen && (!layout.minimized || hasSelection || viewing !== null);
  const rightRoom = view === "design" && (commentsOpen || rightShown);
  const leftRoom = view === "design" && leftShown;
  const rightWidth = clampPane(layout.right, viewportWidth, leftRoom ? PANE.min : 0);
  const leftWidth = clampPane(layout.left, viewportWidth, rightRoom ? rightWidth : 0);
  /** Shows the layers panel (leaving Minimize UI: it was asked for). */
  const showLeft = useCallback(() => {
    setLeftOpen(true);
    if (panelLayout().minimized) setPanelLayout({ minimized: false });
  }, []);
  /** Shows the inspector (leaving Minimize UI: it was asked for). */
  const showRight = useCallback(() => {
    setRightOpen(true);
    if (panelLayout().minimized) setPanelLayout({ minimized: false });
  }, []);
  const [versionTab, setVersionTab] = useState<"version" | "inspect">("version");
  const [naming, setNaming] = useState<{ version: VersionInfo | null } | null>(null);
  // Team libraries (decision 0010): the team's libraries, and publishing this file as one.
  const [librariesOpen, setLibrariesOpen] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [confirmRestore, setConfirmRestore] = useState<VersionInfo | null>(null);
  const showVersion = (version: VersionInfo | null) => {
    if (version) {
      // The details pane sits where the inspector does.
      comments.store.setPanel(false);
      showRight();
    }
    history.show(version);
  };
  // Tokens take over the screen; a version on the canvas would be hidden behind them.
  useEffect(() => {
    if (view === "tokens") history.leave();
  }, [view, history.leave]);
  // The canvas shows connections while the Prototype tab is on screen.
  const prototyping =
    view === "design" && rightShown && !commentsOpen && rightTab === "prototype" && !viewing;
  useEffect(() => {
    editor.state.set({ prototyping });
  }, [editor, prototyping]);
  // View preferences, remembered per browser: rulers (⇧R) and layout grids (⇧G).
  useViewPreferences(editor);
  // Hints and tooltips across the editor show the person's own shortcuts: redraw when they change.
  useOverridesVersion();
  const rulersOn =
    useEditorStateOutside(editor, (s) => s.rulers) && view === "design" && !viewing && !comparing;
  // Room for the floating panes (12px margin + pane width), so comment popovers open over the canvas.
  const insets = useMemo(
    () => ({
      left: leftRoom ? PANE.gutter + leftWidth : 0,
      right: rightRoom ? PANE.gutter + rightWidth : 0,
    }),
    [leftRoom, rightRoom, leftWidth, rightWidth],
  );
  // Rulers sit beside the panes, 12px in from the window when a pane is closed.
  const rulerLeft = insets.left > 0 ? insets.left + 12 : 12;
  const rulerRight = insets.right > 0 ? insets.right + 12 : 12;

  // Fitting and revealing aim for the part of the canvas the panes don't cover:
  // 12px margins, 264px panes, the top bar and the zoom controls.
  // The timeline replaces the zoom controls while history is open.
  useEffect(() => {
    // Rulers take 20px plus a 4px gap, along the top and the left.
    const ruler = rulersOn ? RULER + RULER_GAP : 0;
    // Side by side, each half sits between the panes already; the compare bar and labels are on top.
    const between = comparing && compareMode === "side";
    const next = {
      top: comparing ? 148 : (viewing ? 104 : 60) + ruler,
      bottom: historyOpen ? 128 : 56,
      left: between ? 0 : rulersOn ? rulerLeft + ruler : insets.left,
      right: between ? 0 : insets.right,
    };
    editor.state.set({ insets: next });
    history.view.preview.state.set({ insets: next });
    compare.main.state.set({ insets: next });
  }, [
    editor,
    history.view,
    compare,
    insets,
    historyOpen,
    viewing,
    rulersOn,
    rulerLeft,
    comparing,
    compareMode,
  ]);

  // A reload for a newer Drawpane waits until this file's edits are saved.
  useEffect(() => holdReloadWhile(() => editor.sync.pendingCount > 0), [editor]);

  useEffect(
    () =>
      connectFile(editor, fileId, setFatal, (message) => {
        comments.store.receive(message);
        // Someone commented: it may be for you.
        if (message.t === "comments") refreshInbox(queryClient);
        const me = queryClient.getQueryData<{ user: { id: string } | null }>(["session"])?.user;
        if (message.t === "role") editor.notify(roleChangeNotice(message, me?.id ?? null));
        if (message.t === "merged") {
          // This branch: read-only from now on. The person who merged it has their own notice.
          void queryClient.invalidateQueries({ queryKey: ["file", fileId] });
          const { mainFile, openMain } = branchRef.current;
          if (message.by.id !== me?.id && mainFile)
            editor.notify(
              `${message.by.name} merged this branch into ${mainFile.name}. It's read-only now.`,
              { label: `Open ${mainFile.name}`, run: openMain },
            );
        }
        if (message.t === "updated-from-main" && message.by.id !== me?.id) {
          void queryClient.invalidateQueries({ queryKey: ["file", fileId] });
          void queryClient.invalidateQueries({ queryKey: ["branch-review", fileId] });
          editor.notify(
            `${message.by.name} brought ${count(message.changes, "change")} in from ${branchRef.current.mainFile?.name ?? "main"}.`,
          );
        }
        if (message.t === "merged-in") {
          void queryClient.invalidateQueries({ queryKey: ["branches", fileId] });
          const who = message.by.id === me?.id ? "You" : message.by.name;
          editor.notify(
            `${who} merged “${message.branch.name}” into this file: ${count(message.changes, "change")}.`,
            { label: "History", run: () => ctxRef.current?.showHistory() },
          );
        }
      }),
    [editor, fileId, comments.store, queryClient],
  );
  useThreadLink(editor, comments.store, fileId, insets);
  useThumbnailPublisher(editor, fileId, meta.data?.file.thumbnailAt, meta.data?.file.updatedAt);

  // The file's team fonts: the picker lists them, and text set in them loads them.
  const teamId = meta.data?.file.teamId;
  useEffect(() => {
    if (teamId) void fonts.loadTeam(teamId);
  }, [teamId]);

  // A handle for debugging and end-to-end tests: `localStorage.setItem("drawpane:debug", "1")`.
  useEffect(() => {
    let debug = import.meta.env.DEV;
    try {
      debug ||= localStorage.getItem("drawpane:debug") === "1";
    } catch {
      // Storage blocked.
    }
    if (!debug) return;
    const w = window as unknown as {
      drawpane?: Editor;
      drawpaneFrames?: FrameStats;
      /** The read-only editor showing a version, while one is open. */
      drawpaneVersion?: Editor;
      /** Glass's constants, for calibration (tools/glass-calibration). */
      drawpaneGlass?: { set: typeof setGlassTuning; get: typeof glassTuning };
      /** The canvas export and the headless renderer side by side (e2e/parity/headless.spec.ts). */
      drawpaneHeadless?: ReturnType<typeof headlessDebug>;
      /** The canvas and HarfBuzz text measurers, for the text parity test. */
      drawpaneMeasurers?: () => Promise<typeof import("./measure-parity")>;
    };
    w.drawpane = editor;
    w.drawpaneHeadless = headlessDebug(editor);
    w.drawpaneMeasurers = () => import("./measure-parity");
    w.drawpaneGlass = { set: setGlassTuning, get: glassTuning };
    w.drawpaneFrames = frameStatsFor(editor);
    w.drawpaneVersion = history.view.preview;
    return () => {
      delete w.drawpane;
      delete w.drawpaneFrames;
      delete w.drawpaneHeadless;
      delete w.drawpaneVersion;
    };
  }, [editor, history.view]);

  // The first time a page shows with content, fit it to the screen.
  useEffect(() => {
    const fitted = new Set<string>();
    const check = () => {
      const { pageId, status, viewport } = editor.s;
      if (!pageId || status !== "live" || viewport.width === 0 || fitted.has(pageId)) return;
      fitted.add(pageId);
      if (editor.doc.childIds(pageId).length > 0) editor.zoomToFit();
      else
        editor.setCamera(
          editor.s.camera
            .zoomAt({ x: 0, y: 0 }, 1)
            .pan(viewport.width / 2 - 200, viewport.height / 2 - 150),
        );
    };
    check();
    return editor.state.subscribe(check);
  }, [editor]);

  useEffect(() => {
    if (meta.data)
      document.title = meta.data.branch
        ? `${meta.data.branch.name} – ${meta.data.main?.name ?? meta.data.file.name} – Drawpane`
        : `${meta.data.file.name} – Drawpane`;
    return () => {
      document.title = "Drawpane";
    };
  }, [meta.data]);

  const ctx = useMemo<ActionContext>(
    () => ({
      editor,
      openCommandBar: () => setCommandOpen(true),
      toggleTokens: () => setView((v) => (v === "tokens" ? "design" : "tokens")),
      toggleLeftPane: () => {
        if (panelLayout().minimized) {
          setPanelLayout({ minimized: false });
          setLeftOpen(true);
        } else setLeftOpen((v) => !v);
      },
      // The comments panel sits where the inspector does; asking for the inspector swaps back.
      toggleRightPane: () => {
        if (comments.store.s.panelOpen || panelLayout().minimized) {
          comments.store.setPanel(false);
          setPanelLayout({ minimized: false });
          setRightOpen(true);
        } else setRightOpen((v) => !v);
      },
      toggleMinimized: () => setPanelLayout({ minimized: !panelLayout().minimized }),
      toggleComments: () => comments.store.setPanel(!comments.store.s.panelOpen),
      present: () => navigate(presentTarget(editor, fileId)),
      showHistory: () => {
        setView("design");
        showLeft();
        setLeftTab("history");
      },
      saveVersion: () => {
        if (editor.canEdit) setNaming({ version: null });
      },
      browseLibraries: () => setLibrariesOpen(true),
      publishLibrary: () => {
        if (editor.canEdit) setPublishOpen(true);
      },
      rename: () => {
        const id = editor.s.selection[0];
        if (!id || !editor.canEdit) return;
        // Renaming happens in the layers panel: make sure it's showing.
        setView("design");
        showLeft();
        setLeftTab("layers");
        uiFor(editor).set({ renaming: id });
      },
      findLayers: () => {
        // The search lives in the layers panel: make sure it's showing.
        setView("design");
        showLeft();
        setLeftTab("layers");
        const ui = uiFor(editor);
        ui.set({ findLayers: ui.get().findLayers + 1 });
      },
      showShortcuts: () => setShortcutsOpen(true),
      placeImage: () => {
        void chooseImageFiles().then((files) => {
          if (files.length === 0) return;
          const { camera, viewport, insets } = editor.s;
          // Into the middle of the part of the canvas the panes don't cover.
          const centre = camera.toPage({
            x: insets.left + (viewport.width - insets.left - insets.right) / 2,
            y: insets.top + (viewport.height - insets.top - insets.bottom) / 2,
          });
          void importImageFiles(editor, fileId, files, centre);
        });
      },
      showTab: (tab) => {
        setView("design");
        comments.store.setPanel(false);
        showRight();
        setRightTab(tab);
      },
      // Menu and command-bar clipboard actions go through the async API; ⌘C/⌘X/⌘V use native events below.
      copy: () => {
        const data = editor.copy();
        if (data) void navigator.clipboard.writeText(data);
      },
      cut: () => {
        const data = editor.cut();
        if (data) void navigator.clipboard.writeText(data);
      },
      paste: () => {
        void pasteFromClipboard(editor, fileId).then((pasted) => {
          if (!pasted) editor.notify("The clipboard doesn't hold Drawpane layers, images or SVG.");
        });
      },
    }),
    [editor, fileId, comments.store, showLeft, showRight],
  );
  const ctxRef = useRef<ActionContext | null>(null);
  ctxRef.current = ctx;
  /**
   * Shows a reviewed change's layer: on the branch, or for a deletion, on
   * main's side while comparing (the other side follows).
   */
  const showChange = (row: ReviewRow) => {
    setActiveChange(row.key);
    const where = editor.doc.has(row.id)
      ? editor
      : comparing && compare.main.doc.has(row.id)
        ? compare.main
        : null;
    const node = where?.doc.get(row.id);
    if (!where || !node) {
      editor.notify(`“${row.layer}” is deleted on this branch.`);
      return;
    }
    if (node.type === "page") {
      where.setPage(node.id);
      return;
    }
    const page = where.doc.pageOf(row.id);
    if (page && page.id !== where.s.pageId) where.setPage(page.id);
    where.select([row.id]);
    requestAnimationFrame(() => where.revealSelection());
  };

  // Keyboard: shortcuts from the action registry, plus held keys (space to pan, Alt for X-ray) and arrows.
  useEffect(() => {
    const versionView = history.view;
    const liveInteraction = interaction;
    const liveCtx = ctx;
    const both = [
      [editor, interaction],
      [versionView.preview, versionView.interaction],
    ] as const;
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTyping(e.target) || e.isComposing) return;
      // Something closer already handled it (the layers panel's arrow keys, a menu): not a shortcut too.
      if (e.defaultPrevented) return;
      // A modal dialog has the keyboard (Escape closes it natively; preventing it wouldn't).
      if (document.querySelector("dialog[open]:modal")) return;
      // Enter and Space press the focused button, menu item or link: never also a shortcut.
      if ((e.key === "Enter" || e.key === " ") && isControl(e.target)) return;
      // While a version is on screen, keys act on it (read-only) instead of the live file.
      const viewingNow = versionView.s.viewing !== null;
      const editor = versionView.active;
      const interaction = viewingNow ? versionView.interaction : liveInteraction;
      const ctx = viewingNow ? { ...liveCtx, editor } : liveCtx;
      // Escape stops following or spotlighting before anything else.
      if (e.key === "Escape" && (editor.s.following || editor.s.spotlight)) {
        if (editor.s.following) editor.stopFollowing();
        else editor.setSpotlight(false);
        e.preventDefault();
        return;
      }
      if (
        viewingNow &&
        e.key === "Escape" &&
        editor.s.selection.length === 0 &&
        !interaction.busy
      ) {
        versionView.leave();
        e.preventDefault();
        return;
      }
      if (e.key === " " && !e.repeat) {
        interaction.setSpace(true);
        e.preventDefault();
        return;
      }
      // ⌘ (Ctrl) with Alt measures to the exact layer under the pointer.
      if ((e.key === "Meta" || e.key === "Control") && e.altKey)
        interaction.modifiers({ alt: true, mod: true });
      if (e.key === "Alt") {
        editor.state.set({ xray: true });
        // With the pointer still over the canvas, measuring starts without a move.
        interaction.modifiers({ alt: true, mod: isMac() ? e.metaKey : e.ctrlKey });
        return;
      }
      // The pen and vector edit take their keys first (Enter, Escape, Backspace, arrows).
      if (
        interaction.key({
          key: e.key,
          shift: e.shiftKey,
          alt: e.altKey,
          mod: isMac() ? e.metaKey : e.ctrlKey,
        })
      ) {
        e.preventDefault();
        return;
      }
      // Arrows nudge, plain or with Shift; Enter goes in, plain. Those exact keys only:
      // other combinations (⌥⌘→, Ctrl+Alt+↵ for Play) are for shortcuts.
      const plain = !e.metaKey && !e.ctrlKey && !e.altKey;
      if (plain && e.key.startsWith("Arrow") && editor.s.selection.length > 0) {
        const step = e.shiftKey ? 10 : 1;
        const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
        const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
        editor.nudge(dx, dy);
        e.preventDefault();
        return;
      }
      if (plain && !e.shiftKey && e.key === "Enter" && editor.s.selection.length === 1) {
        const node = editor.doc.get(editor.s.selection[0] as string);
        if (node?.type === "text") editor.startTextEdit(node.id);
        else if (node) {
          const first = editor.doc.childIds(node.id).at(-1);
          if (first) editor.select([first]);
        }
        e.preventDefault();
        return;
      }
      if (e.key === "Escape" && interaction.busy) {
        interaction.cancel();
        return;
      }
      if (e.key === "Escape" && editor.s.selection.length === 1) {
        // Escape walks up to the parent before clearing, like Figma.
        const node = editor.doc.get(editor.s.selection[0] as string);
        const parent = node && editor.doc.get(node.parent);
        if (parent && parent.type !== "page") {
          editor.select([parent.id]);
          return;
        }
      }
      // Native clipboard events handle these (keymap.ts keeps them for copy, cut and paste).
      if (
        (e.metaKey || e.ctrlKey) &&
        ["c", "x", "v"].includes(e.key.toLowerCase()) &&
        !e.shiftKey &&
        !e.altKey
      )
        return;
      for (const action of ACTIONS) {
        if (triggers(action, e)) {
          // The tokens workspace hides the canvas: only what makes sense there runs.
          if (viewRef.current === "tokens" && !inTokensView(action)) return;
          e.preventDefault();
          if (!action.enabled || action.enabled(editor)) action.run(ctx);
          return;
        }
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      for (const [ed, ia] of both) {
        if (e.key === " ") ia.setSpace(false);
        if (e.key === "Alt") ed.state.set({ xray: uiFor(ed).get().xrayPinned });
        if (e.key === "Alt" || e.key === "Meta" || e.key === "Control")
          ia.modifiers({ alt: e.altKey, mod: isMac() ? e.metaKey : e.ctrlKey });
      }
    };
    const onBlur = () => {
      for (const [ed, ia] of both) {
        ia.setSpace(false);
        ed.state.set({ xray: uiFor(ed).get().xrayPinned });
        ia.modifiers({ alt: false, mod: false });
      }
    };
    const onCopy = (e: ClipboardEvent) => {
      if (isTyping(e.target)) return;
      const data = versionView.active.copy();
      if (!data || !e.clipboardData) return;
      e.clipboardData.setData(CLIPBOARD_MIME, data);
      e.clipboardData.setData("text/plain", data);
      e.preventDefault();
    };
    const onCut = (e: ClipboardEvent) => {
      if (isTyping(e.target) || !editor.canEdit || versionView.s.viewing) return;
      onCopy(e);
      editor.deleteSelection();
    };
    const onPaste = (e: ClipboardEvent) => {
      if (isTyping(e.target) || !editor.canEdit || versionView.s.viewing) return;
      // Drawpane layers first, then image and SVG files, then layers or SVG markup sent as text.
      const layers = e.clipboardData?.getData(CLIPBOARD_MIME) ?? "";
      if (layers && editor.paste(layers)) {
        e.preventDefault();
        return;
      }
      const files = filesFrom(e.clipboardData);
      if (files.length > 0) {
        e.preventDefault();
        void importImageFiles(editor, fileId, files);
        return;
      }
      const text = e.clipboardData?.getData("text/plain") ?? "";
      const svg = e.clipboardData?.getData("image/svg+xml") || text;
      if (editor.paste(text) || pasteSvgText(editor, svg)) e.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    document.addEventListener("copy", onCopy);
    document.addEventListener("cut", onCut);
    document.addEventListener("paste", onPaste);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("copy", onCopy);
      document.removeEventListener("cut", onCut);
      document.removeEventListener("paste", onPaste);
    };
  }, [editor, interaction, ctx, fileId, history.view]);

  if (meta.isError) {
    return (
      <main className="app-empty-page">
        <h1 className="app-display">Can't open this file.</h1>
        <p className="app-muted">{meta.error.message}</p>
        <Button variant="primary" size="lg" onClick={() => navigate({ to: "/" })}>
          Go to your files
        </Button>
      </main>
    );
  }

  const fileName = meta.data?.file.name ?? "";
  const canEdit = editor.canEdit;
  return (
    <EditorContext.Provider value={editor}>
      <div
        className="editor"
        data-history={historyOpen || undefined}
        data-left-closed={!leftShown || undefined}
        style={
          {
            "--pane-left": `${leftWidth}px`,
            "--pane-right": `${rightWidth}px`,
            // Where the canvas's open area starts and ends, beside the panels (or the window's edges).
            "--canvas-left": `${leftRoom ? leftWidth + PANE.gutter * 2 : PANE.gutter}px`,
            "--canvas-right": `${rightRoom ? rightWidth + PANE.gutter * 2 : PANE.gutter}px`,
          } as CSSProperties
        }
      >
        {/* Canvas, toolbar and layers show whichever document is on screen: now, or a version. */}
        {comparing && review.rows && branch && mainFile ? (
          <CompareCanvases
            compare={compare}
            live={editor}
            liveInteraction={interaction}
            rows={review.rows}
            active={activeChange}
            labels={{
              main: `${mainFile.name} · now`,
              branch: `${branch.name} · ${count(review.rows.length, "change")}`,
            }}
            onPick={showChange}
          />
        ) : (
          <EditorContext.Provider value={active}>
            <Canvas key={viewing ? "version" : "live"} interaction={activeInteraction} />
          </EditorContext.Provider>
        )}
        {comparing ? <CompareBar compare={compare} /> : null}
        {rulersOn ? <Rulers interaction={interaction} left={rulerLeft} right={rulerRight} /> : null}
        {view === "design" && !viewing && !comparing ? (
          <CommentsLayer
            store={comments.store}
            interaction={interaction}
            people={comments.people}
            insets={insets}
          />
        ) : null}
        <div className="topbar">
          <FileTitle
            view={view}
            minimized={layout.minimized}
            onToggleMinimized={ctx.toggleMinimized}
            onToggleTokens={() => setView((v) => (v === "tokens" ? "design" : "tokens"))}
            fileId={fileId}
            teamId={meta.data?.file.teamId ?? null}
            name={fileName}
            project={meta.data?.project?.name ?? ""}
            main={mainFile}
            branch={branch}
          />
          <EditorContext.Provider value={active}>
            <Toolbar onSearch={() => setCommandOpen(true)} ctx={ctx} />
          </EditorContext.Provider>
          <TopRight
            fileId={fileId}
            fileName={fileName}
            teamId={meta.data?.file.teamId ?? null}
            branchOpen={branch !== null && !branch.merged}
            onMerge={
              branch && !branch.merged && !reviewing && canMerge ? () => setReviewing(true) : null
            }
            onPresent={ctx.present}
            onOpenThread={(threadId) => openThread(editor, comments.store, threadId, insets.left)}
          />
        </div>
        {view === "tokens" ? (
          <TokensWorkspace
            onShowLayer={(id) => {
              setView("design");
              const page = editor.doc.pageOf(id);
              if (page && page.id !== editor.s.pageId) editor.setPage(page.id);
              editor.select([id]);
              requestAnimationFrame(() => editor.revealSelection());
            }}
          />
        ) : null}
        {leftRoom ? (
          <PaneResizer
            side="left"
            label="layers panel"
            width={leftWidth}
            viewportWidth={viewportWidth}
            other={rightRoom ? rightWidth : 0}
          />
        ) : null}
        {rightRoom ? (
          <PaneResizer
            side="right"
            label={commentsOpen ? "comments panel" : "inspector"}
            width={rightWidth}
            viewportWidth={viewportWidth}
            other={leftRoom ? leftWidth : 0}
          />
        ) : null}
        {reviewing && leftShown && branch && mainFile ? (
          <ReviewPane
            branch={branch}
            main={mainFile}
            review={review}
            canMerge={canMerge}
            active={activeChange}
            onSelect={showChange}
            onClose={() => setReviewing(false)}
          />
        ) : leftShown && view === "design" ? (
          <EditorContext.Provider value={active}>
            <aside className="pane pane--left" aria-label="Pages, layers, assets and history">
              <div className="pane__tabs">
                <SegmentedControl
                  label="Left pane"
                  options={[
                    { value: "layers", label: "Layers" },
                    { value: "assets", label: "Assets" },
                    { value: "history", label: "History" },
                  ]}
                  value={leftTab}
                  onChange={(tab) => setLeftTab(tab as LeftTab)}
                />
              </div>
              {leftTab === "layers" ? (
                <>
                  <PagesList />
                  <LayersPanel />
                </>
              ) : leftTab === "assets" ? (
                <AssetsPanel onLibraries={() => setLibrariesOpen(true)} />
              ) : (
                <HistoryPanel
                  versions={history.versions}
                  error={history.error}
                  viewing={viewing}
                  loading={history.state.loading}
                  revn={editor.sync.revn}
                  canEdit={canEdit}
                  onView={showVersion}
                  onSave={() => setNaming({ version: null })}
                />
              )}
            </aside>
          </EditorContext.Provider>
        ) : null}
        {commentsOpen && view === "design" ? (
          <CommentsPanel
            store={comments.store}
            insets={insets}
            onClose={() => comments.store.setPanel(false)}
          />
        ) : reviewing && rightShown && mainFile ? (
          <MergePane main={mainFile} review={review} canMerge={canMerge} />
        ) : rightShown && view === "design" && viewing ? (
          <EditorContext.Provider value={active}>
            <aside className="pane pane--right" aria-label="Version">
              <div className="pane__tabs version-tabs">
                <SegmentedControl
                  label="Right pane"
                  options={[
                    { value: "version", label: "Version" },
                    { value: "inspect", label: "Inspect" },
                  ]}
                  value={versionTab}
                  onChange={(tab) => setVersionTab(tab as "version" | "inspect")}
                />
              </div>
              {versionTab === "version" ? (
                <VersionDetails
                  version={viewing}
                  byId={history.byId}
                  preview={history.view.preview}
                  canEdit={canEdit}
                  restoring={history.restoreFile.isPending}
                  onRestoreFile={() => setConfirmRestore(viewing)}
                  onRestoreLayers={history.restoreLayers}
                  onCopyLayers={history.copyLayers}
                  onName={() => setNaming({ version: viewing })}
                  onUnname={() => history.unname.mutate(viewing)}
                />
              ) : (
                <InspectPanel />
              )}
            </aside>
          </EditorContext.Provider>
        ) : rightShown && view === "design" ? (
          <aside ref={inspectorPane} className="pane pane--right" aria-label="Inspector">
            <PopoverRoomContext.Provider value={inspectorRoom}>
              <div className="pane__tabs">
                <SegmentedControl
                  label="Right pane"
                  options={[
                    { value: "design", label: "Design" },
                    { value: "prototype", label: "Prototype" },
                    { value: "inspect", label: "Inspect" },
                  ]}
                  value={rightTab}
                  onChange={(tab) => setRightTab(tab as RightTab)}
                />
              </div>
              {rightTab === "design" ? (
                <>
                  <Inspector />
                  <ExportPanel />
                </>
              ) : rightTab === "prototype" ? (
                <PrototypePanel fileId={fileId} />
              ) : (
                <InspectPanel />
              )}
            </PopoverRoomContext.Provider>
          </aside>
        ) : null}
        {/* Anchored to the one full canvas: not while main and the branch share the screen. */}
        {view === "design" && !viewing && !comparing ? <CropBar /> : null}
        {view === "design" && !viewing && !comparing ? <FollowOverlay /> : null}
        {view === "design" && !viewing && !comparing ? <ExplainCard /> : null}
        {view === "design" && !viewing && !comparing ? <XrayLegend /> : null}
        {view === "design" && !viewing && !threadOpen && !comparing ? (
          <Lens
            onOpenInspector={() => {
              comments.store.setPanel(false);
              showRight();
            }}
          />
        ) : null}
        {view === "design" ? (
          <VersionBanner
            viewing={viewing}
            loading={history.state.loading}
            error={history.state.error}
            byId={history.byId}
            onBack={history.leave}
          />
        ) : null}
        {historyOpen ? (
          <Scrubber
            versions={history.versions ?? []}
            byId={history.byId}
            selected={history.state.loading ?? viewing}
            onPick={showVersion}
          />
        ) : view === "design" ? (
          <>
            <EditorContext.Provider value={active}>
              {comparing ? null : <Minimap />}
              <ZoomControls />
            </EditorContext.Provider>
            <SyncStatus />
          </>
        ) : (
          <SyncStatus />
        )}
        <Notice />
        {viewing ? null : <ImageDrop fileId={fileId} />}
        <UploadTray />
        {commandOpen ? <CommandPalette ctx={ctx} onClose={() => setCommandOpen(false)} /> : null}
        {view === "design" ? (
          <ContextMenus editor={active} ctx={ctx} fileId={fileId} commentsShown={commentsOpen} />
        ) : null}
        <ShortcutsDialog open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
        <BrowseLibrariesDialog
          open={librariesOpen}
          fileId={fileId}
          onClose={() => setLibrariesOpen(false)}
          onPublish={() => {
            setLibrariesOpen(false);
            setPublishOpen(true);
          }}
        />
        <PublishDialog open={publishOpen} fileId={fileId} onClose={() => setPublishOpen(false)} />
        <NameVersionDialog
          open={naming !== null}
          fileId={fileId}
          version={naming?.version ?? null}
          onClose={() => setNaming(null)}
          onSaved={(saved) => {
            void history.refresh();
            editor.notify(
              naming?.version ? `Named the version “${saved.name}”.` : `Saved “${saved.name}”.`,
              naming?.version
                ? undefined
                : {
                    label: "Show",
                    run: () => {
                      showLeft();
                      setLeftTab("history");
                    },
                  },
            );
          }}
        />
        <RestoreDialog
          version={confirmRestore}
          busy={history.restoreFile.isPending}
          onCancel={() => setConfirmRestore(null)}
          onConfirm={() => {
            if (!confirmRestore) return;
            history.restoreFile.mutate(confirmRestore, {
              onSettled: () => setConfirmRestore(null),
            });
          }}
        />
        {fatal ? (
          <div className="editor__fatal" role="alert">
            <p>{fatal}</p>
            <Button variant="primary" onClick={() => navigate({ to: "/" })}>
              Go to your files
            </Button>
          </div>
        ) : null}
      </div>
    </EditorContext.Provider>
  );
}

function FileTitle({
  view,
  onToggleTokens,
  minimized,
  onToggleMinimized,
  fileId,
  teamId,
  name,
  project,
  main,
  branch,
}: {
  view: "design" | "tokens";
  onToggleTokens: () => void;
  /** Minimize UI is on: the button brings the panels back. */
  minimized: boolean;
  onToggleMinimized: () => void;
  fileId: string;
  teamId: string | null;
  name: string;
  project: string;
  /** The main file: this one, or the one this branch branches. Null until known. */
  main: { readonly id: string; readonly name: string } | null;
  branch: BranchInfo | null;
}) {
  const queryClient = useQueryClient();
  const canEdit = useEditorState((s) => s.role !== "viewer");
  const [editing, setEditing] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const save = async (value: string) => {
    setEditing(false);
    const next = value.trim();
    if (!next || next === name) return;
    await api.patch(`/files/${fileId}`, { name: next });
    await queryClient.invalidateQueries({ queryKey: ["file", fileId] });
  };
  return (
    <div className="file-title pane">
      {teamId ? (
        <Link
          to="/t/$teamId"
          params={{ teamId }}
          search={{}}
          className="file-title__home"
          aria-label="Back to files"
        >
          <Logo size={20} label="" />
        </Link>
      ) : (
        <span className="file-title__home" />
      )}
      {branch && main ? (
        // On a branch the title is its main file's, which leads back there; the chip names the branch.
        <Link
          to="/f/$fileId"
          params={{ fileId: main.id }}
          className="file-title__name file-title__main"
          title={`Open ${main.name}`}
        >
          {main.name}
        </Link>
      ) : editing ? (
        <input
          ref={input}
          className="file-title__input"
          defaultValue={name}
          aria-label="File name"
          // biome-ignore lint/a11y/noAutofocus: renaming starts from an explicit click
          autoFocus
          onFocus={(e) => e.currentTarget.select()}
          onBlur={(e) => void save(e.currentTarget.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") setEditing(false);
          }}
        />
      ) : (
        <button
          type="button"
          className="file-title__name"
          onClick={() => canEdit && setEditing(true)}
          title={project ? `${project} / ${name}` : name}
        >
          {name || "…"}
        </button>
      )}
      {main ? <BranchMenu fileId={fileId} main={main} branch={branch} /> : null}
      {/* A merged branch says so in its chip. */}
      {!canEdit && !branch?.merged ? <span className="file-title__badge">View only</span> : null}
      <IconButton
        icon="token"
        label={view === "tokens" ? "Back to design" : "Tokens"}
        shortcut={shortcutFor("view.tokens")}
        pressed={view === "tokens"}
        className="file-title__tokens"
        onClick={onToggleTokens}
      />
      <IconButton
        icon="sidebar"
        label={minimized ? "Show panels" : "Minimize UI"}
        shortcut={shortcutFor("view.minimizeUi")}
        pressed={minimized}
        className="file-title__panels"
        onClick={onToggleMinimized}
      />
    </div>
  );
}

type RightTab = "design" | "prototype" | "inspect";
type LeftTab = "layers" | "assets" | "history";

/** Where Play goes: the selected screen's flow if it starts one, else from that screen. */
function presentTarget(editor: Editor, fileId: string) {
  const { pageId, selection } = editor.s;
  const screen = selection.length === 1 ? screenOf(editor.doc, selection[0] as string) : null;
  const flow = pageId
    ? (liveFlows(editor.doc, pageId).find((f) => f.start === screen) ??
      (screen ? null : liveFlows(editor.doc, pageId)[0]))
    : null;
  const search = {
    ...(pageId ? { page: pageId } : {}),
    ...(flow ? { flow: flow.id } : screen ? { screen } : {}),
  };
  return { to: "/f/$fileId/present" as const, params: { fileId }, search };
}

function TopRight({
  fileId,
  fileName,
  teamId,
  branchOpen,
  onMerge,
  onPresent,
  onOpenThread,
}: {
  fileId: string;
  fileName: string;
  teamId: string | null;
  /** An open branch: merging, not sharing, is its next step. */
  branchOpen: boolean;
  /** On an open branch: starts its review. */
  onMerge: (() => void) | null;
  onPresent: () => void;
  onOpenThread: (threadId: string) => void;
}) {
  const hasPeers = useEditorState((s) => s.peers.size > 0);
  const canEdit = useEditorState((s) => s.role !== "viewer");
  const [sharing, setSharing] = useState(false);
  return (
    <div className="top-right pane">
      <People />
      {hasPeers ? <span className="top-right__divider" aria-hidden="true" /> : null}
      <InboxMenu fileId={fileId} teamId={teamId} onOpenThread={onOpenThread} />
      <IconButton
        icon="play"
        label="Play prototype"
        shortcut={shortcutFor("view.present")}
        size="md"
        onClick={onPresent}
      />
      {/* On a branch, merging is the next step; sharing steps back. */}
      <Button
        variant={branchOpen ? "secondary" : "primary"}
        size="md"
        onClick={() => setSharing(true)}
      >
        Share
      </Button>
      {onMerge ? (
        <Button variant="primary" size="md" icon="branch" onClick={onMerge}>
          Merge
        </Button>
      ) : null}
      <ShareDialog
        fileId={fileId}
        fileName={fileName}
        canEdit={canEdit}
        open={sharing}
        onClose={() => setSharing(false)}
      />
    </div>
  );
}

function ZoomControls() {
  const editor = useEditor();
  const zoom = useEditorState((s) => s.camera.zoom);
  return (
    <fieldset className="zoom pane" aria-label="Zoom" {...PASS_GESTURES}>
      <IconButton
        icon="minus"
        label="Zoom out"
        shortcut={shortcutFor("view.zoomOut")}
        onClick={() => editor.zoomBy(1 / 1.5)}
      />
      <button
        type="button"
        className="zoom__value"
        onClick={() => editor.zoomTo(1)}
        title={`Zoom to 100% (${shortcutFor("view.zoom100")})`}
      >
        {Math.round(zoom * 100)}%
      </button>
      <IconButton
        icon="plus"
        label="Zoom in"
        shortcut={shortcutFor("view.zoomIn")}
        onClick={() => editor.zoomBy(1.5)}
      />
      <IconButton
        icon="fit"
        label="Zoom to fit"
        shortcut={shortcutFor("view.zoomFit")}
        onClick={() => editor.zoomToFit()}
      />
    </fieldset>
  );
}

function SyncStatus() {
  const status = useEditorState((s) => s.status);
  const editor = useEditor();
  // Follows the room as it confirms edits, not on a timer.
  const progress = useSyncExternalStore(
    (notify) => editor.sync.on("progress", notify),
    () => `${editor.sync.pendingCount}:${editor.sync.revn ?? 0}`,
  );
  const [pending, revn] = progress.split(":").map(Number) as [number, number];
  const text =
    status === "offline"
      ? "Offline. Your edits are kept and sync when you reconnect."
      : status === "live"
        ? pending > 0
          ? "Saving…"
          : `Saved · revision ${revn}`
        : // Connected and reading the file: a large one takes a while to download.
          status === "syncing"
          ? "Loading the file…"
          : "Connecting…";
  return (
    <div
      className={`sync pane sync--${status}`}
      role="status"
      aria-live="polite"
      {...PASS_GESTURES}
    >
      <Icon name={status === "offline" ? "warning" : "check"} size={12} />
      <span>{text}</span>
    </div>
  );
}

/** Said when an owner changes your role while you have the file open. */
/**
 * The editor's toast: one message at a time, with at most one action. It
 * stays while the pointer or focus is on it, and longer when it has an action.
 */
function Notice() {
  const notice = useEditorState((s) => s.notice);
  const [visible, setVisible] = useState<number | null>(null);
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (!notice) return;
    setVisible(notice.id);
  }, [notice]);
  useEffect(() => {
    if (!notice || visible !== notice.id || held) return;
    const t = setTimeout(() => setVisible(null), notice.action ? 8000 : 4000);
    return () => clearTimeout(t);
  }, [notice, visible, held]);
  if (!notice || visible !== notice.id) return null;
  return (
    <div
      className="notice"
      role="alert"
      onPointerEnter={() => setHeld(true)}
      onPointerLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={() => setHeld(false)}
    >
      <span>{notice.text}</span>
      {notice.action ? (
        <button
          type="button"
          className="notice__action"
          onClick={() => {
            setVisible(null);
            setHeld(false);
            notice.action?.run();
          }}
        >
          {notice.action.label}
        </button>
      ) : null}
    </div>
  );
}
