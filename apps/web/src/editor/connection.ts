import type { Editor } from "@drawpane/editor";
import type { ServerMessage } from "@drawpane/model";

const MIN_BACKOFF = 500;
const MAX_BACKOFF = 10_000;
const PING_MS = 25_000;

/**
 * Keeps a websocket to the file's room open: reconnects with jittered
 * backoff, reconnects at once when the tab comes back online or visible, and
 * gives up only when the room says the file is gone or access was revoked.
 */
export function connectFile(editor: Editor, fileId: string, onFatal: (message: string) => void): () => void {
  let ws: WebSocket | null = null;
  let disposed = false;
  let attempt = 0;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let ping: ReturnType<typeof setInterval> | null = null;

  const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/files/${encodeURIComponent(fileId)}`;

  function open() {
    if (disposed) return;
    if (retry) {
      clearTimeout(retry);
      retry = null;
    }
    const socket = new WebSocket(url);
    ws = socket;
    socket.addEventListener("open", () => {
      attempt = 0;
      editor.sync.connected((message) => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
      });
      ping = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ t: "ping" }));
      }, PING_MS);
    });
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      let message: ServerMessage;
      try {
        message = JSON.parse(event.data) as ServerMessage;
      } catch {
        return;
      }
      editor.sync.receive(message);
    });
    socket.addEventListener("close", (event) => {
      if (ping) clearInterval(ping);
      ping = null;
      if (ws !== socket) return;
      ws = null;
      editor.sync.disconnected();
      if (event.code === 4404) {
        onFatal("This file was deleted.");
        return;
      }
      schedule();
    });
  }

  function schedule() {
    if (disposed || retry) return;
    const delay = Math.min(MAX_BACKOFF, MIN_BACKOFF * 2 ** attempt) * (0.75 + Math.random() * 0.5);
    attempt++;
    retry = setTimeout(open, delay);
  }

  const reconnectNow = () => {
    if (!ws && !disposed) {
      attempt = 0;
      open();
    }
  };
  const onVisible = () => {
    if (document.visibilityState === "visible") reconnectNow();
  };
  window.addEventListener("online", reconnectNow);
  document.addEventListener("visibilitychange", onVisible);

  open();

  return () => {
    disposed = true;
    window.removeEventListener("online", reconnectNow);
    document.removeEventListener("visibilitychange", onVisible);
    if (retry) clearTimeout(retry);
    if (ping) clearInterval(ping);
    const socket = ws;
    ws = null;
    if (socket) {
      editor.sync.flush();
      socket.close(1000, "leaving");
    }
  };
}
