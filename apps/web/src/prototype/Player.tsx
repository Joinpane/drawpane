import {
  CanvasRenderer,
  defaultStart,
  type Editor,
  flowScreens,
  hotspotIds,
  type ImageCache,
  liveFlows,
  PrototypePlayer,
  screensInReadingOrder,
} from "@drawpane/editor";
import { DEVICE_IDS, DEVICES, type DeviceId, type Flow, getProp } from "@drawpane/model";
import { Icon, IconButton } from "@drawpane/ui";
import { type ReactNode, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { isMac } from "../app/format";
import { PlayerStage } from "./stage";
import "./present.css";

/** Subscribes to document changes; returns the version so callers re-render. */
export function useDoc(editor: Editor): number {
  return useSyncExternalStore(
    (cb) => editor.doc.subscribe(cb),
    () => editor.doc.version,
  );
}

export interface PlayTarget {
  readonly pageId: string;
  readonly flow: Flow | null;
  readonly start: string;
}

/**
 * What to play: the flow asked for (on any page), else the asked-for page's
 * first flow, else the first page that has a flow, else the first screen.
 */
export function resolveTarget(
  editor: Editor,
  search: { page?: string | undefined; flow?: string | undefined },
): PlayTarget | null {
  const pages = editor.doc.pageIds();
  for (const pageId of pages) {
    const flow = liveFlows(editor.doc, pageId).find((f) => f.id === search.flow);
    if (flow) return { pageId, flow, start: flow.start };
  }
  const pageId =
    (search.page && pages.includes(search.page) ? search.page : null) ??
    pages.find((id) => liveFlows(editor.doc, id).length > 0) ??
    pages[0];
  if (!pageId) return null;
  const flow = liveFlows(editor.doc, pageId)[0] ?? null;
  const start = flow?.start ?? defaultStart(editor.doc, pageId);
  return start ? { pageId, flow, start } : null;
}

export interface PlayerProps {
  readonly editor: Editor;
  readonly images: ImageCache;
  readonly target: PlayTarget;
  readonly initialScreen: string | null;
  /** Picks another flow (possibly on another page). */
  readonly onFlow: (pageId: string, flowId: string) => void;
  /** Left of the flow picker: a way back, or the file's name. */
  readonly leading: ReactNode;
  /** Right of the player's own controls: sharing. */
  readonly actions?: ReactNode;
}

/**
 * A prototype playing in a device: the bar (flow, screen count, device,
 * restart, screens), the stage, and the screens panel. Present mode and
 * shared links wrap it with their own leading and trailing controls.
 */
export function Player({
  editor,
  images,
  target,
  initialScreen,
  onFlow,
  leading,
  actions,
}: PlayerProps) {
  useDoc(editor);
  const { pageId, start } = target;
  const flowId = target.flow?.id ?? null;
  const renderer = useMemo(
    () => new CanvasRenderer(editor.scene, editor.measurer, { images }),
    [editor, images],
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

  // Flows on every page, for the picker.
  const flows = editor.doc
    .pageIds()
    .flatMap((id) => liveFlows(editor.doc, id).map((flow) => ({ pageId: id, flow })));
  const pagesWithFlows = new Set(flows.map((f) => f.pageId));
  const screens = flowId
    ? flowScreens(editor.doc, start)
    : screensInReadingOrder(editor.doc, pageId);
  const index = screens.indexOf(state.screen);
  const nameOf = (id: string) => getProp(editor.doc.get(id)?.props ?? {}, "name") || "Untitled";

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
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "SELECT" || el.isContentEditable)) return;
      if (el?.closest("dialog")) return;
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

  return (
    <div className="present">
      <header className="present__bar">
        <div className="present__left">
          {leading}
          {flows.length > 0 ? (
            <span className="present__flow">
              <Icon name="flow" size={12} />
              <select
                aria-label="Flow"
                value={flowId ?? ""}
                onChange={(e) => {
                  const picked = flows.find((f) => f.flow.id === e.target.value);
                  if (picked) onFlow(picked.pageId, picked.flow.id);
                }}
              >
                {flowId === null ? <option value="">All screens</option> : null}
                {pagesWithFlows.size > 1
                  ? [...pagesWithFlows].map((id) => (
                      <optgroup
                        key={id}
                        label={getProp(editor.doc.get(id)?.props ?? {}, "name") || "Page"}
                      >
                        {flows
                          .filter((f) => f.pageId === id)
                          .map(({ flow }) => (
                            <option key={flow.id} value={flow.id}>
                              {flow.name}
                            </option>
                          ))}
                      </optgroup>
                    ))
                  : flows.map(({ flow }) => (
                      <option key={flow.id} value={flow.id}>
                        {flow.name}
                      </option>
                    ))}
              </select>
              <Icon name="chevron-down" size={12} />
            </span>
          ) : null}
          <span className="present__count" aria-live="polite">
            {index === -1 ? nameOf(state.screen) : `Screen ${index + 1} of ${screens.length}`}
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
          {actions}
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
                      <span className="present__screen-name">{nameOf(id)}</span>
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
