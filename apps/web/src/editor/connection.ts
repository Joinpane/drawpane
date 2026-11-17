import type { Editor } from "@drawpane/editor";
import type { ServerMessage } from "@drawpane/model";
import { ApiError, api } from "../api/client";

const MIN_BACKOFF = 500;
const MAX_BACKOFF = 10_000;
const PING_MS = 25_000;

/**
 * Keeps a websocket to the file's room open: reconnects with jittered
 * backoff, reconnects at once when the tab comes back online or visible, and
 * gives up only when the file is gone or access was revoked: the room says
 * so when the socket is open, and the API when a reconnect can't get in.
 */
export function connectFile(
  editor: Editor,
  fileId: string,
  onFatal: (message: string) => void,
  /** Sees every server message after the editor does (comments listen here). */
  onMessage?: (message: ServerMessage) => void,
  /** Where to connect instead of the file's own room, e.g. a shared prototype link. */
  path = `/ws/files/${encodeURIComponent(fileId)}`,
): () => void {
  let ws: WebSocket | null = null;
  let disposed = false;
  let attempt = 0;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let ping: ReturnType<typeof setInterval> | null = null;

  const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${path}`;
  // Only a file's own room can be checked through the API; a shared prototype's guests can't.
  const ownRoom = path === `/ws/files/${encodeURIComponent(fileId)}`;

  function open() {
    if (disposed) return;
    if (retry) {
      clearTimeout(retry);
      retry = null;
    }
    const socket = new WebSocket(url);
    ws = socket;
    let opened = false;
    socket.addEventListener("open", () => {
      opened = true;
      attempt = 0;
      editor.sync.connected(
        (message) => {
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
        },
        // A large file comes over HTTP, streamed, not through the socket.
        { download: (ticket, signal) => api.downloadDocument(fileId, ticket, signal) },
      );
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
      onMessage?.(message);
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
      if (event.code === 4403) {
        onFatal("This prototype link was turned off.");
        return;
      }
      if (event.code === 4401) {
        onFatal(
          event.reason === "Left the team"
            ? "You left this file's team, so it's closed here."
            : "You no longer have access to this file: you were removed from its team.",
        );
        return;
      }
      // Couldn't even get in: offline, or no longer allowed. The API can tell which.
      if (!opened && ownRoom) void checkAccess();
      else schedule();
    });
  }

  /** After a failed reconnect: gone or forbidden ends it; anything else retries. */
  async function checkAccess() {
    try {
      await api.get(`/files/${encodeURIComponent(fileId)}`);
    } catch (error) {
      if (disposed) return;
      if (error instanceof ApiError && (error.status === 404 || error.status === 403)) {
        onFatal(
          "This file isn't available to you any more. It was deleted, or you were removed from its team.",
        );
        return;
      }
    }
    schedule();
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
