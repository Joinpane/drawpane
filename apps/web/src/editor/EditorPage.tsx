import { CanvasTextMeasurer, Editor, Interaction } from "@drawpane/editor";
import {
  Button,
  Icon,
  IconButton,
  Logo,
  type PresenceSlot,
  PresenceStack,
  SegmentedControl,
} from "@drawpane/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api/client";
import { modKey } from "../app/format";
import { AssetsPanel } from "./AssetsPanel";
import { ACTIONS, type ActionContext, matches } from "./actions";
import { Canvas } from "./Canvas";
import { CommandPalette } from "./CommandPalette";
import { connectFile } from "./connection";
import { EditorContext, useEditor, useEditorState } from "./hooks";
import { Inspector } from "./Inspector";
import { LayersPanel, PagesList } from "./LayersPanel";
import { Lens } from "./Lens";
import { Toolbar } from "./Toolbar";
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
  const [editor] = useState(() => new Editor({ measurer: new CanvasTextMeasurer() }));
  const interaction = useMemo(() => new Interaction(editor), [editor]);
  const [commandOpen, setCommandOpen] = useState(false);
  const [leftOpen, setLeftOpen] = useState(true);
  const [leftTab, setLeftTab] = useState<"layers" | "assets">("layers");
  const [rightOpen, setRightOpen] = useState(true);
  const [fatal, setFatal] = useState<string | null>(null);

  useEffect(() => connectFile(editor, fileId, setFatal), [editor, fileId]);

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
      toggleLeftPane: () => setLeftOpen((v) => !v),
      toggleRightPane: () => setRightOpen((v) => !v),
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
        void navigator.clipboard.readText().then((text) => {
          if (!editor.paste(text)) editor.notify("The clipboard doesn't hold Drawpane layers.");
        });
      },
    }),
    [editor],
  );

  // Keyboard: shortcuts from the action registry, plus held keys (space to pan, Alt for X-ray) and arrows.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTyping(e.target) || e.isComposing) return;
      if (e.key === " " && !e.repeat) {
        interaction.setSpace(true);
        e.preventDefault();
        return;
      }
      if (e.key === "Alt") {
        editor.state.set({ xray: true });
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
      if (e.key === " ") interaction.setSpace(false);
      if (e.key === "Alt") editor.state.set({ xray: false });
    };
    const onBlur = () => {
      interaction.setSpace(false);
      editor.state.set({ xray: false });
    };
    const onCopy = (e: ClipboardEvent) => {
      if (isTyping(e.target)) return;
      const data = editor.copy();
      if (!data || !e.clipboardData) return;
      e.clipboardData.setData(CLIPBOARD_MIME, data);
      e.clipboardData.setData("text/plain", data);
      e.preventDefault();
    };
    const onCut = (e: ClipboardEvent) => {
      if (isTyping(e.target) || !editor.canEdit) return;
      onCopy(e);
      editor.deleteSelection();
    };
    const onPaste = (e: ClipboardEvent) => {
      if (isTyping(e.target) || !editor.canEdit) return;
      const data =
        e.clipboardData?.getData(CLIPBOARD_MIME) || e.clipboardData?.getData("text/plain") || "";
      if (editor.paste(data)) e.preventDefault();
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
  }, [editor, interaction, ctx]);

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

  return (
    <EditorContext.Provider value={editor}>
      <div className="editor">
        <Canvas interaction={interaction} />
        <FileTitle
          fileId={fileId}
          teamId={meta.data?.file.teamId ?? null}
          name={meta.data?.file.name ?? ""}
          project={meta.data?.project?.name ?? ""}
        />
        <Toolbar onSearch={() => setCommandOpen(true)} />
        <TopRight fileId={fileId} />
        {leftOpen ? (
          <aside className="pane pane--left" aria-label="Pages, layers and assets">
            <div className="pane__tabs">
              <SegmentedControl
                label="Left pane"
                options={[
                  { value: "layers", label: "Layers" },
                  { value: "assets", label: "Assets" },
                ]}
                value={leftTab}
                onChange={(tab) => setLeftTab(tab as "layers" | "assets")}
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
            ) : (
              <AssetsPanel />
            )}
          </aside>
        ) : null}
        {rightOpen ? (
          <aside className="pane pane--right" aria-label="Inspector">
            <Inspector />
          </aside>
        ) : null}
        <Lens onOpenInspector={() => setRightOpen(true)} />
        <ZoomControls />
        <SyncStatus />
        <Notice />
        {commandOpen ? <CommandPalette ctx={ctx} onClose={() => setCommandOpen(false)} /> : null}
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
  fileId,
  teamId,
  name,
  project,
}: {
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
    </div>
  );
}

function TopRight({ fileId }: { fileId: string }) {
  const peers = useEditorState((s) => s.peers);
  const [copied, setCopied] = useState(false);
  const people = [...peers.values()].map((p) => ({
    name: p.name,
    color: (((((p.color - 1) % 8) + 8) % 8) + 1) as PresenceSlot,
  }));
  return (
    <div className="top-right pane">
      {people.length > 0 ? <PresenceStack people={people} max={4} /> : null}
      <Button
        variant="primary"
        size="md"
        onClick={async () => {
          await navigator.clipboard.writeText(`${location.origin}/f/${fileId}`);
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        }}
      >
        {copied ? "Link copied" : "Share"}
      </Button>
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

function Notice() {
  const notice = useEditorState((s) => s.notice);
  const [visible, setVisible] = useState<number | null>(null);
  useEffect(() => {
    if (!notice) return;
    setVisible(notice.id);
    const t = setTimeout(() => setVisible(null), 4000);
    return () => clearTimeout(t);
  }, [notice]);
  if (!notice || visible !== notice.id) return null;
  return (
    <div className="notice" role="alert">
      {notice.text}
    </div>
  );
}
