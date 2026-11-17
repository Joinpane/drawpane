import type { Editor } from "@drawpane/editor";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectFile } from "./connection";

/** A socket the server never lets in: it closes without opening, as a refused upgrade does. */
class RefusedSocket extends EventTarget {
  static readonly OPEN = 1;
  readonly readyState = 3;
  constructor(readonly url: string) {
    super();
    sockets.push(this);
    queueMicrotask(() =>
      this.dispatchEvent(Object.assign(new Event("close"), { code: 1006, reason: "" })),
    );
  }
  send() {}
  close() {}
}
let sockets: RefusedSocket[] = [];

const editor = {
  sync: { connected: vi.fn(), receive: vi.fn(), disconnected: vi.fn(), flush: vi.fn() },
} as unknown as Editor;

function api(status: number | "offline") {
  const fetch = vi.fn(async () => {
    if (status === "offline") throw new TypeError("Failed to fetch");
    return new Response(JSON.stringify({ error: { code: "x", message: "Not found" } }), {
      status,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

beforeEach(() => {
  sockets = [];
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", RefusedSocket);
  vi.stubGlobal("location", { protocol: "https:", host: "design.example.com" });
  vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal("document", {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    visibilityState: "visible",
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("connectFile when a reconnect can't get in", () => {
  it("stops and says why when the file is gone or no longer yours", async () => {
    const fetch = api(404);
    const onFatal = vi.fn();
    const stop = connectFile(editor, "file1", onFatal);
    await vi.waitFor(() => expect(onFatal).toHaveBeenCalledTimes(1));
    expect(onFatal.mock.calls[0]?.[0]).toMatch(/isn't available to you any more/);
    expect(fetch).toHaveBeenCalledWith("/api/files/file1", expect.anything());
    // No more attempts after that.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sockets).toHaveLength(1);
    stop();
  });

  it("keeps trying while offline", async () => {
    api("offline");
    const onFatal = vi.fn();
    const stop = connectFile(editor, "file1", onFatal);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sockets.length).toBeGreaterThan(1);
    expect(onFatal).not.toHaveBeenCalled();
    stop();
  });

  it("doesn't ask the API for a shared prototype's room", async () => {
    const fetch = api(404);
    const onFatal = vi.fn();
    const stop = connectFile(editor, "file1", onFatal, undefined, "/ws/share/abc");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetch).not.toHaveBeenCalled();
    expect(onFatal).not.toHaveBeenCalled();
    stop();
  });
});

describe("connectFile when leaving", () => {
  it("stops the download of a file still loading", async () => {
    class OpenSocket extends EventTarget {
      static readonly OPEN = 1;
      readyState = 1;
      constructor(readonly url: string) {
        super();
        open.push(this);
      }
      send() {}
      close() {
        this.readyState = 3;
        this.dispatchEvent(Object.assign(new Event("close"), { code: 1000, reason: "leaving" }));
      }
    }
    const open: OpenSocket[] = [];
    vi.stubGlobal("WebSocket", OpenSocket);
    let signal: AbortSignal | undefined;
    vi.stubGlobal("fetch", (_url: string, init: RequestInit) => {
      signal = init.signal ?? undefined;
      return new Promise(() => {});
    });
    const { Doc, SyncEngine } = await import("@drawpane/editor");
    const sync = new SyncEngine(new Doc(), { clientId: "c1", setTimer: () => 0 });
    const stop = connectFile({ sync } as unknown as Editor, "file1", () => {});
    const socket = open[0] as OpenSocket;
    socket.dispatchEvent(new Event("open"));
    socket.dispatchEvent(
      Object.assign(new Event("message"), {
        data: JSON.stringify({
          t: "welcome",
          sessionId: "s",
          revn: 7,
          role: "editor",
          peers: [],
          mode: "download",
          lastSeq: 0,
          ticket: "ticket",
        }),
      }),
    );
    expect(signal?.aborted).toBe(false);
    stop();
    expect(signal?.aborted).toBe(true);
  });
});
