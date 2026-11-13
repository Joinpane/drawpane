import {
  CanvasRenderer,
  CanvasTextMeasurer,
  defaultStart,
  Editor,
  flowScreens,
  hotspotIds,
  liveFlows,
  PrototypePlayer,
  screensInReadingOrder,
} from "@drawpane/editor";
import { DEVICE_IDS, DEVICES, type DeviceId, getProp } from "@drawpane/model";
import { Button, Icon, IconButton } from "@drawpane/ui";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { api } from "../api/client";
import { isMac } from "../app/format";
import { connectFile } from "../editor/connection";
import { useEditorStateOutside } from "../editor/hooks";
import { imagesFor } from "../editor/media";
import { PlayerStage } from "./stage";
import "./present.css";

export interface PresentSearch {
  page?: string;
  flow?: string;
  screen?: string;
}

export function PresentPage() {
  const { fileId } = useParams({ from: "/f/$fileId/present" });
  return <Present key={fileId} fileId={fileId} />;
}

/** Subscribes to document changes; returns the version so callers re-render. */
function useDoc(editor: Editor): number {
  return useSyncExternalStore(
    (cb) => editor.doc.subscribe(cb),
    () => editor.doc.version,
  );
}

function Present({ fileId }: { fileId: string }) {
  const search = useSearch({ from: "/f/$fileId/present" });
  const navigate = useNavigate({ from: "/f/$fileId/present" });
  const meta = useQuery({
    queryKey: ["file", fileId],
    queryFn: () => api.file(fileId),
    retry: false,
  });
  const [editor] = useState(() => new Editor({ measurer: new CanvasTextMeasurer() }));
  const [fatal, setFatal] = useState<string | null>(null);
  useEffect(() => connectFile(editor, fileId, setFatal), [editor, fileId]);
  const status = useEditorStateOutside(editor, (s) => s.status);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (status === "live") setLoaded(true);
  }, [status]);
  useDoc(editor);

  useEffect(() => {
    if (meta.data) document.title = `${meta.data.file.name} · Prototype – Drawpane`;
    return () => {
      document.title = "Drawpane";
    };
  }, [meta.data]);

  if (fatal || meta.isError) {
    return (
      <main className="app-empty-page">
        <h1 className="app-display">Can't play this prototype.</h1>
        <p className="app-muted">{fatal ?? meta.error?.message}</p>
        <Button variant="primary" size="lg" onClick={() => navigate({ to: "/" })}>
          Go to your files
        </Button>
      </main>
    );
  }
  if (!loaded) return <div className="app-loading" aria-busy="true" />;

  const pages = editor.doc.pageIds();
  const pageId = search.page && pages.includes(search.page) ? search.page : (pages[0] ?? null);
  const flows = pageId ? liveFlows(editor.doc, pageId) : [];
  const flow = flows.find((f) => f.id === search.flow) ?? flows[0] ?? null;
  const start = flow?.start ?? (pageId ? defaultStart(editor.doc, pageId) : null);
  if (!pageId || !start) {
    return (
      <main className="app-empty-page">
        <h1 className="app-display">Nothing to play yet.</h1>
        <p className="app-muted">Add a frame to this page, then press play again.</p>
        <Link to="/f/$fileId" params={{ fileId }} className="present__back-link">
          Back to editor
        </Link>
      </main>
    );
  }
  return (
    <Player
      key={`${pageId}:${flow?.id ?? ""}`}
      editor={editor}
      fileId={fileId}
      fileName={meta.data?.file.name ?? ""}
      pageId={pageId}
      flowId={flow?.id ?? null}
      start={start}
      initialScreen={search.screen ?? null}
      onFlow={(id) => navigate({ search: { page: pageId, flow: id }, replace: true })}
    />
  );
}

function Player({
  editor,
  fileId,
  fileName,
  pageId,
  flowId,
  start,
  initialScreen,
  onFlow,
}: {
  editor: Editor;
  fileId: string;
  fileName: string;
  pageId: string;
  flowId: string | null;
  start: string;
  initialScreen: string | null;
  onFlow: (flowId: string) => void;
}) {
  useDoc(editor);
  const renderer = useMemo(
    () => new CanvasRenderer(editor.scene, editor.measurer, { images: imagesFor(editor) }),
    [editor],
  );
  const [player] = useState(() => new PrototypePlayer(editor.doc, start));
  const state = useSyncExternalStore(
    (cb) => player.subscribe(cb),
    () => player.state,
  );
  const host = useRef<HTMLDivElement>(null);
  const stage = useRef<PlayerStage | null>(null);
  const page = editor.doc.get(pageId);
  const pageDevice = page ? getProp(page.props, "prototypeDevice") : "none";
  const [device, setDevice] = useState<DeviceId>(pageDevice);
  useEffect(() => setDevice(pageDevice), [pageDevice]);
  const [panelOpen, setPanelOpen] = useState(() => window.innerWidth >= 960);
  const [hint, setHint] = useState<{ id: number; text: string } | null>({
    id: 0,
    text: "Click to interact · R restarts · ← → move between screens",
  });

  const flows = liveFlows(editor.doc, pageId);
  const screens = flowId
    ? flowScreens(editor.doc, start)
    : screensInReadingOrder(editor.doc, pageId);
  const index = screens.indexOf(state.screen);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const s = new PlayerStage({
      editor,
      renderer,
      player,
      host: el,
      device,
      onHint: (kind) =>
        setHint({
          id: Date.now(),
          text:
            kind === "hotspots"
              ? "Highlighted areas are clickable"
              : "That leads to a screen that's no longer here",
        }),
    });
    stage.current = s;
    if (initialScreen && initialScreen !== start) s.play(player.goTo(initialScreen));
    return () => {
      s.destroy();
      stage.current = null;
    };
    // The stage lives as long as the player; device changes go through setDevice below.
  }, [editor, renderer, player]);
  useEffect(() => stage.current?.setDevice(device), [device]);

  // A screen deleted while playing: start over.
  useEffect(() => {
    if (!editor.doc.has(state.screen)) {
      player.restart(editor.doc.has(start) ? start : (defaultStart(editor.doc, pageId) ?? start));
      stage.current?.reset();
    }
  });

  useEffect(() => {
    if (!hint) return;
    const t = setTimeout(() => setHint(null), hint.id === 0 ? 4500 : 2600);
    return () => clearTimeout(t);
  }, [hint]);

  const restart = () => {
    player.restart();
    stage.current?.reset();
  };
  const go = (delta: 1 | -1) => {
    const next = screens[(index === -1 ? 0 : index + delta + screens.length) % screens.length];
    if (next) stage.current?.play(player.goTo(next));
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" || target.tagName === "SELECT" || target.isContentEditable)
      )
        return;
      const press = {
        key: e.key,
        shift: e.shiftKey,
        alt: e.altKey,
        mod: isMac() ? e.metaKey : e.ctrlKey,
      };
      // The prototype's own keys win over the player's.
      if (stage.current?.key(press)) {
        e.preventDefault();
        return;
      }
      if (press.mod || press.alt) return;
      if (e.key === "r" || e.key === "R") restart();
      else if (e.key === "ArrowRight") go(1);
      else if (e.key === "ArrowLeft") go(-1);
      else if (e.key === "Escape" || e.key === "Backspace") stage.current?.play(player.back());
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const [copied, setCopied] = useState(false);
  const screenName = (id: string) => getProp(editor.doc.get(id)?.props ?? {}, "name") || "Untitled";

  return (
    <div className="present" data-panel={panelOpen || undefined}>
      <header className="present__bar">
        <div className="present__left">
          <Link to="/f/$fileId" params={{ fileId }} className="present__back">
            <Icon name="arrow-left" size={12} />
            Back to editor
          </Link>
          <span className="present__divider" aria-hidden="true" />
          {flows.length > 0 ? (
            <span className="present__flow">
              <Icon name="flow" size={12} />
              <select
                aria-label="Flow"
                value={flowId ?? ""}
                onChange={(e) => onFlow(e.target.value)}
              >
                {flows.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
              <Icon name="chevron-down" size={12} />
            </span>
          ) : (
            <span className="present__file">{fileName}</span>
          )}
          <span className="present__count" aria-live="polite">
            {index === -1 ? screenName(state.screen) : `Screen ${index + 1} of ${screens.length}`}
          </span>
        </div>
        <div className="present__right">
          <span className="present__flow present__device">
            <Icon name="device" size={12} />
            <select
              aria-label="Device"
              value={device}
              onChange={(e) => setDevice(e.target.value as DeviceId)}
            >
              {DEVICE_IDS.map((id) => (
                <option key={id} value={id}>
                  {DEVICES[id].kind === "none" ? "No device" : DEVICES[id].name}
                </option>
              ))}
            </select>
            <Icon name="chevron-down" size={12} />
          </span>
          <IconButton icon="restart" label="Restart" shortcut="R" size="md" onClick={restart} />
          <IconButton
            icon="layers"
            label={panelOpen ? "Hide screens" : "Show screens"}
            size="md"
            pressed={panelOpen}
            onClick={() => setPanelOpen((v) => !v)}
          />
          <Button
            variant="primary"
            size="md"
            onClick={async () => {
              const url = new URL(location.href);
              url.searchParams.delete("screen");
              await navigator.clipboard.writeText(url.toString());
              setCopied(true);
              setTimeout(() => setCopied(false), 1600);
            }}
          >
            {copied ? "Link copied" : "Share prototype"}
          </Button>
        </div>
      </header>
      <div className="present__body">
        <main className="present__stage" ref={host} aria-label="Prototype">
          {hint ? (
            <p key={hint.id} className="present__hint" role="status">
              {hint.text}
            </p>
          ) : null}
        </main>
        {panelOpen ? (
          <aside className="present__panel" aria-label="Screens">
            <h2 className="present__panel-title">Screens</h2>
            <ol className="present__screens">
              {screens.map((id) => (
                <li key={id}>
                  <button
                    type="button"
                    className="present__screen"
                    aria-current={id === state.screen || undefined}
                    onClick={() => stage.current?.play(player.goTo(id))}
                  >
                    <ScreenThumb editor={editor} renderer={renderer} id={id} />
                    <span className="present__screen-text">
                      <span className="present__screen-name">{screenName(id)}</span>
                      <span className="present__screen-meta">{screenMeta(editor, id, start)}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          </aside>
        ) : null}
      </div>
    </div>
  );
}

function screenMeta(editor: Editor, id: string, start: string): string {
  const hotspots = hotspotIds(editor.doc, id).filter((h) => h !== id).length;
  const parts = [];
  if (id === start) parts.push("Start");
  parts.push(
    hotspots === 0 ? "No hotspots" : `${hotspots} ${hotspots === 1 ? "hotspot" : "hotspots"}`,
  );
  return parts.join(" · ");
}

const THUMB_W = 44;
const THUMB_H = 72;

/** A small picture of a screen, redrawn when the document settles. */
function ScreenThumb({
  editor,
  renderer,
  id,
}: {
  editor: Editor;
  renderer: CanvasRenderer;
  id: string;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const version = useDoc(editor);
  useEffect(() => {
    const draw = () => {
      const el = canvas.current;
      const bounds = editor.scene.bounds(id);
      if (!el || !bounds) return;
      const dpr = window.devicePixelRatio || 1;
      const scale = Math.min(THUMB_W / bounds.width, THUMB_H / bounds.height);
      const w = Math.max(1, Math.round(bounds.width * scale));
      const h = Math.max(1, Math.round(bounds.height * scale));
      el.width = w * dpr;
      el.height = h * dpr;
      el.style.width = `${w}px`;
      el.style.height = `${h}px`;
      const ctx = el.getContext("2d");
      if (ctx) renderer.renderNodes(ctx, [id], bounds, scale * dpr);
    };
    const t = setTimeout(draw, version === 0 ? 0 : 250);
    const off = renderer.images.subscribe(draw);
    return () => {
      clearTimeout(t);
      off();
    };
  }, [editor, renderer, id, version]);
  return (
    <span className="present__thumb" aria-hidden="true">
      <canvas ref={canvas} />
    </span>
  );
}
