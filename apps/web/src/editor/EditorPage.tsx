import { CanvasTextMeasurer, Editor, Interaction, liveFlows, screenOf } from "@drawpane/editor";
import type { VersionInfo } from "@drawpane/model";
import { Button, Icon, IconButton, Logo, SegmentedControl } from "@drawpane/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api/client";
import { isMac, modKey } from "../app/format";
import { ShareDialog } from "../prototype/ShareDialog";
import { AssetsPanel } from "./AssetsPanel";
import { ACTIONS, type ActionContext, matches } from "./actions";
import { loadBooleanEngine } from "./boolean-engine";
import { Canvas } from "./Canvas";
import { CommandPalette } from "./CommandPalette";
import { ContextMenus } from "./ContextMenus";
import { CropBar } from "./CropBar";
import { CommentsLayer, CommentsPanel, useCommentStore, useComments } from "./comments";
import { connectFile } from "./connection";
import { ExportPanel } from "./ExportSection";
import { FollowOverlay, People } from "./follow";
import {
  HistoryPanel,
  NameVersionDialog,
  RestoreDialog,
  Scrubber,
  useVersionHistory,
  VersionBanner,
  VersionDetails,
} from "./history";
import { EditorContext, useEditor, useEditorState, useEditorStateOutside } from "./hooks";
import { ImageDrop, UploadTray } from "./ImageDrop";
import { InspectPanel } from "./InspectPanel";
import { Inspector } from "./inspector/Inspector";
import { LayersPanel, PagesList } from "./LayersPanel";
import { Lens } from "./Lens";
import { chooseImageFiles, filesFrom, importImageFiles, pasteFromClipboard } from "./media";
import { PrototypePanel } from "./prototype/PrototypePanel";
import { RULER, RULER_GAP, Rulers } from "./Rulers";
import { ShortcutsDialog } from "./ShortcutsDialog";
import { Toolbar } from "./Toolbar";
import { useThumbnailPublisher } from "./thumbnail";
import { TokensWorkspace } from "./tokens/TokensWorkspace";
import { uiFor } from "./ui-state";
import { useViewPreferences } from "./view-preferences";
import "./editor.css";

const CLIPBOARD_MIME = "application/x-drawpane+json";

export function EditorPage() {
  const { fileId } = useParams({ from: "/f/$fileId" });
  // A new file id remounts everything: one Editor per file.
  return <FileEditor key={fileId} fileId={fileId} />;
}

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return (
    !!el &&
    (el.isContentEditable ||
      el.tagName === "INPUT" ||
      el.tagName === "TEXTAREA" ||
      el.tagName === "SELECT")
  );
}

function FileEditor({ fileId }: { fileId: string }) {
  const navigate = useNavigate();
  const meta = useQuery({
    queryKey: ["file", fileId],
    queryFn: () => api.file(fileId),
    retry: false,
  });
  const [editor] = useState(
    () => new Editor({ measurer: new CanvasTextMeasurer(), booleanEngine: loadBooleanEngine }),
  );
  const interaction = useMemo(() => new Interaction(editor), [editor]);
  const [commandOpen, setCommandOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [leftOpen, setLeftOpen] = useState(true);
  const [leftTab, setLeftTab] = useState<LeftTab>("layers");
  const [view, setView] = useState<"design" | "tokens">("design");
  const [rightTab, setRightTab] = useState<RightTab>("design");
  // Viewers can't edit, so open them straight into Inspect (free for everyone).
  // The role is only known once the room welcomes us ("viewer" until then).
  const isViewer = useEditorStateOutside(editor, (s) => s.status === "live" && s.role === "viewer");
  useEffect(() => {
    if (isViewer) setRightTab("inspect");
  }, [isViewer]);
  const [rightOpen, setRightOpen] = useState(true);
  const [fatal, setFatal] = useState<string | null>(null);
  const comments = useCommentStore(editor, fileId);
  const commentsOpen = useComments(comments.store, (s) => s.panelOpen);
  // Version history: the History tab lists versions; picking one puts it on the canvas, read-only.
  const history = useVersionHistory(
    editor,
    fileId,
    view === "design" && leftOpen && leftTab === "history",
  );
  const viewing = history.viewing;
  const historyOpen = view === "design" && history.open;
  const active = history.active;
  const activeInteraction = viewing ? history.view.interaction : interaction;
  const [versionTab, setVersionTab] = useState<"version" | "inspect">("version");
  const [naming, setNaming] = useState<{ version: VersionInfo | null } | null>(null);
  const [confirmRestore, setConfirmRestore] = useState<VersionInfo | null>(null);
  const showVersion = (version: VersionInfo | null) => {
    if (version) {
      // The details pane sits where the inspector does.
      comments.store.setPanel(false);
      setRightOpen(true);
    }
    history.show(version);
  };
  // Tokens take over the screen; a version on the canvas would be hidden behind them.
  useEffect(() => {
    if (view === "tokens") history.leave();
  }, [view, history.leave]);
  // The canvas shows connections while the Prototype tab is on screen.
  const prototyping =
    view === "design" && rightOpen && !commentsOpen && rightTab === "prototype" && !viewing;
  useEffect(() => {
    editor.state.set({ prototyping });
  }, [editor, prototyping]);
  // View preferences, remembered per browser: rulers (⇧R) and layout grids (⇧G).
  useViewPreferences(editor);
  const rulersOn = useEditorStateOutside(editor, (s) => s.rulers) && view === "design" && !viewing;
  // Room for the floating panes (12px margin + pane width), so comment popovers open over the canvas.
  const insets = useMemo(
    () => ({
      left: leftOpen && view === "design" ? 276 : 0,
      right: (commentsOpen || rightOpen) && view === "design" ? 276 : 0,
    }),
    [leftOpen, rightOpen, commentsOpen, view],
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
    const next = {
      top: (viewing ? 104 : 60) + ruler,
      bottom: historyOpen ? 128 : 56,
      left: rulersOn ? rulerLeft + ruler : insets.left,
      right: insets.right,
    };
    editor.state.set({ insets: next });
    history.view.preview.state.set({ insets: next });
  }, [editor, history.view, insets, historyOpen, viewing, rulersOn, rulerLeft]);

  useEffect(
    () => connectFile(editor, fileId, setFatal, (message) => comments.store.receive(message)),
    [editor, fileId, comments.store, navigate],
  );
  useThumbnailPublisher(editor, fileId, meta.data?.file.thumbnailAt);

  // A handle for debugging and end-to-end tests: `localStorage.setItem("drawpane:debug", "1")`.
  useEffect(() => {
    let debug = import.meta.env.DEV;
    try {
      debug ||= localStorage.getItem("drawpane:debug") === "1";
    } catch {
      // Storage blocked.
    }
    if (!debug) return;
    const w = window as unknown as { drawpane?: Editor };
    w.drawpane = editor;
    return () => {
      delete w.drawpane;
    };
  }, [editor]);

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
    if (meta.data) document.title = `${meta.data.file.name} – Drawpane`;
    return () => {
      document.title = "Drawpane";
    };
  }, [meta.data]);

  const ctx = useMemo<ActionContext>(
    () => ({
      editor,
      openCommandBar: () => setCommandOpen(true),
      toggleTokens: () => setView((v) => (v === "tokens" ? "design" : "tokens")),
      toggleLeftPane: () => setLeftOpen((v) => !v),
      // The comments panel sits where the inspector does; asking for the inspector swaps back.
      toggleRightPane: () => {
        if (comments.store.s.panelOpen) {
          comments.store.setPanel(false);
          setRightOpen(true);
        } else setRightOpen((v) => !v);
      },
      toggleComments: () => comments.store.setPanel(!comments.store.s.panelOpen),
      present: () => navigate(presentTarget(editor, fileId)),
      showHistory: () => {
        setView("design");
        setLeftOpen(true);
        setLeftTab("history");
      },
      saveVersion: () => {
        if (editor.canEdit) setNaming({ version: null });
      },
      rename: () => {
        const id = editor.s.selection[0];
        if (!id || !editor.canEdit) return;
        // Renaming happens in the layers panel: make sure it's showing.
        setView("design");
        setLeftOpen(true);
        setLeftTab("layers");
        uiFor(editor).set({ renaming: id });
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
        setRightOpen(true);
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
          if (!pasted) editor.notify("The clipboard doesn't hold Drawpane layers or images.");
        });
      },
    }),
    [editor, fileId, comments.store],
  );

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
      if (e.key === "Alt") {
        editor.state.set({ xray: true });
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
      if (e.key.startsWith("Arrow") && editor.s.selection.length > 0) {
        const step = e.shiftKey ? 10 : 1;
        const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
        const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
        editor.nudge(dx, dy);
        e.preventDefault();
        return;
      }
      if (e.key === "Enter" && editor.s.selection.length === 1) {
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
      // Native clipboard events handle these.
      if (
        (e.metaKey || e.ctrlKey) &&
        ["c", "x", "v"].includes(e.key.toLowerCase()) &&
        !e.shiftKey &&
        !e.altKey
      )
        return;
      for (const action of ACTIONS) {
        if (action.shortcut && matches(action.shortcut, e)) {
          e.preventDefault();
          if (!action.enabled || action.enabled(editor)) action.run(ctx);
          return;
        }
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      for (const [ed, ia] of both) {
        if (e.key === " ") ia.setSpace(false);
        if (e.key === "Alt") ed.state.set({ xray: false });
      }
    };
    const onBlur = () => {
      for (const [ed, ia] of both) {
        ia.setSpace(false);
        ed.state.set({ xray: false });
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
      // Drawpane layers first, then image files, then layers sent as plain text.
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
      if (editor.paste(e.clipboardData?.getData("text/plain") ?? "")) e.preventDefault();
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
        style={
          {
            "--scrubber-left": leftOpen ? "288px" : "12px",
            "--scrubber-right": rightOpen || commentsOpen ? "288px" : "12px",
          } as CSSProperties
        }
      >
        {/* Canvas, toolbar and layers show whichever document is on screen: now, or a version. */}
        <EditorContext.Provider value={active}>
          <Canvas key={viewing ? "version" : "live"} interaction={activeInteraction} />
        </EditorContext.Provider>
        {rulersOn ? <Rulers interaction={interaction} left={rulerLeft} right={rulerRight} /> : null}
        {view === "design" && !viewing ? (
          <CommentsLayer
            store={comments.store}
            interaction={interaction}
            people={comments.people}
            insets={insets}
          />
        ) : null}
        <FileTitle
          view={view}
          onToggleTokens={() => setView((v) => (v === "tokens" ? "design" : "tokens"))}
          fileId={fileId}
          teamId={meta.data?.file.teamId ?? null}
          name={fileName}
          project={meta.data?.project?.name ?? ""}
        />
        <EditorContext.Provider value={active}>
          <Toolbar onSearch={() => setCommandOpen(true)} ctx={ctx} />
        </EditorContext.Provider>
        <TopRight fileId={fileId} fileName={fileName} onPresent={ctx.present} />
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
        {leftOpen && view === "design" ? (
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
                  <div className="pane__head pane__head--layers">
                    <span className="pane__label">Layers</span>
                  </div>
                  <LayersPanel />
                </>
              ) : leftTab === "assets" ? (
                <AssetsPanel />
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
        ) : rightOpen && view === "design" && viewing ? (
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
        ) : rightOpen && view === "design" ? (
          <aside className="pane pane--right" aria-label="Inspector">
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
          </aside>
        ) : null}
        {view === "design" && !viewing ? <CropBar /> : null}
        {view === "design" && !viewing ? <FollowOverlay /> : null}
        {view === "design" && !viewing ? (
          <Lens
            onOpenInspector={() => {
              comments.store.setPanel(false);
              setRightOpen(true);
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
                      setLeftOpen(true);
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
  fileId,
  teamId,
  name,
  project,
}: {
  view: "design" | "tokens";
  onToggleTokens: () => void;
  fileId: string;
  teamId: string | null;
  name: string;
  project: string;
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
      {editing ? (
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
      {!canEdit ? <span className="file-title__badge">View only</span> : null}
      <IconButton
        icon="token"
        label={view === "tokens" ? "Back to design" : "Tokens"}
        shortcut="⌥T"
        pressed={view === "tokens"}
        className="file-title__tokens"
        onClick={onToggleTokens}
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
  onPresent,
}: {
  fileId: string;
  fileName: string;
  onPresent: () => void;
}) {
  const hasPeers = useEditorState((s) => s.peers.size > 0);
  const canEdit = useEditorState((s) => s.role !== "viewer");
  const [sharing, setSharing] = useState(false);
  return (
    <div className="top-right pane">
      <People />
      {hasPeers ? <span className="top-right__divider" aria-hidden="true" /> : null}
      <IconButton
        icon="play"
        label="Play prototype"
        shortcut={isMac() ? "⌥⌘↵" : "Ctrl+Alt+↵"}
        size="md"
        onClick={onPresent}
      />
      <Button variant="primary" size="md" onClick={() => setSharing(true)}>
        Share
      </Button>
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
    <fieldset className="zoom pane" aria-label="Zoom">
      <IconButton
        icon="minus"
        label="Zoom out"
        shortcut={modKey("−")}
        onClick={() => editor.zoomBy(1 / 1.5)}
      />
      <button
        type="button"
        className="zoom__value"
        onClick={() => editor.zoomTo(1)}
        title="Zoom to 100% (⇧0)"
      >
        {Math.round(zoom * 100)}%
      </button>
      <IconButton
        icon="plus"
        label="Zoom in"
        shortcut={modKey("+")}
        onClick={() => editor.zoomBy(1.5)}
      />
      <IconButton icon="fit" label="Zoom to fit" shortcut="⇧1" onClick={() => editor.zoomToFit()} />
    </fieldset>
  );
}

function SyncStatus() {
  const status = useEditorState((s) => s.status);
  const editor = useEditor();
  const [pending, setPending] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setPending(editor.sync.pendingCount), 300);
    return () => clearInterval(id);
  }, [editor]);
  const text =
    status === "offline"
      ? "Offline. Your edits are kept and sync when you reconnect."
      : status === "live"
        ? pending > 0
          ? "Saving…"
          : `Saved · revision ${editor.sync.revn ?? 0}`
        : "Connecting…";
  return (
    <div className={`sync pane sync--${status}`} role="status" aria-live="polite">
      <Icon name={status === "offline" ? "warning" : "check"} size={12} />
      <span>{text}</span>
    </div>
  );
}

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
