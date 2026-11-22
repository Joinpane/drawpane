// @vitest-environment jsdom
import { Editor } from "@drawpane/editor";
import { ROOT_ID } from "@drawpane/model";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as snapshot from "./engine-snapshot";
import { useThumbnailPublisher } from "./thumbnail";

function makeEditor() {
  const editor = new Editor({ measurer: { width: () => 0 }, clientId: "test" });
  editor.doc.apply([
    { op: "create", id: "p", type: "page", parent: ROOT_ID, key: "a0", props: { name: "Page 1" } },
    {
      op: "create",
      id: "r",
      type: "rect",
      parent: "p",
      key: "a0",
      props: { x: 0, y: 0, width: 100, height: 100, fills: [{ type: "solid", color: "#2b4fd6" }] },
    },
  ]);
  editor.setPage("p");
  editor.state.set({ status: "live", role: "editor" });
  return editor;
}

function Harness({ editor }: { editor: Editor }) {
  useThumbnailPublisher(editor, "file-1", Date.now(), 0);
  return null;
}

describe("useThumbnailPublisher", () => {
  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("publishes an edit made during a long running thumbnail as soon as it finishes", async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.useFakeTimers();
    localStorage.setItem("drawpane:renderer", "engine");

    const pendingRenders: Array<(blob: Blob) => void> = [];
    vi.spyOn(snapshot, "renderEngineSnapshot").mockImplementation(
      () =>
        new Promise<Blob>((resolve) => {
          pendingRenders.push(resolve);
        }),
    );
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));

    const editor = makeEditor();
    const queryClient = new QueryClient();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    try {
      act(() => {
        root.render(
          createElement(
            QueryClientProvider,
            { client: queryClient },
            createElement(Harness, { editor }),
          ),
        );
      });

      // Edit 1 -> wait 10 s settle -> first thumbnail starts and stays in flight.
      editor.doc.apply([{ op: "set", id: "r", prop: "x", value: 10 }]);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(pendingRenders).toHaveLength(1);

      // Edit 2 arrives while publish 1 is running; its 10 s settle timer also expires while running.
      editor.doc.apply([{ op: "set", id: "r", prop: "x", value: 20 }]);
      await vi.advanceTimersByTimeAsync(11_000);
      expect(pendingRenders).toHaveLength(1);
      expect(fetchSpy).not.toHaveBeenCalled();

      // Publish 1 finishes -> publish 2 must start immediately without another edit or tab hide.
      pendingRenders[0]?.(new Blob([new Uint8Array([1, 2])], { type: "image/webp" }));
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(pendingRenders).toHaveLength(2);

      // Publish 2 finishes and uploads.
      pendingRenders[1]?.(new Blob([new Uint8Array([3, 4])], { type: "image/webp" }));
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(pendingRenders).toHaveLength(2);
    } finally {
      act(() => root.unmount());
      queryClient.clear();
    }
  });

  it("flushes an edit made during a running thumbnail when the tab hides before it finishes", async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.useFakeTimers();
    localStorage.setItem("drawpane:renderer", "engine");

    const pendingRenders: Array<(blob: Blob) => void> = [];
    vi.spyOn(snapshot, "renderEngineSnapshot").mockImplementation(
      () =>
        new Promise<Blob>((resolve) => {
          pendingRenders.push(resolve);
        }),
    );
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));

    const editor = makeEditor();
    const queryClient = new QueryClient();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    const origVis = Object.getOwnPropertyDescriptor(document, "visibilityState");
    try {
      act(() => {
        root.render(
          createElement(
            QueryClientProvider,
            { client: queryClient },
            createElement(Harness, { editor }),
          ),
        );
      });

      editor.doc.apply([{ op: "set", id: "r", prop: "x", value: 5 }]);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(pendingRenders).toHaveLength(1);

      // New edit while running, then tab hides 1 s later (before the 10 s settle timer expires).
      editor.doc.apply([{ op: "set", id: "r", prop: "x", value: 15 }]);
      await vi.advanceTimersByTimeAsync(1_000);
      Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
      expect(pendingRenders).toHaveLength(1);

      // As soon as publish 1 completes, the queued hidden-tab flush runs immediately.
      pendingRenders[0]?.(new Blob([new Uint8Array([1])], { type: "image/webp" }));
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(pendingRenders).toHaveLength(2);

      pendingRenders[1]?.(new Blob([new Uint8Array([2])], { type: "image/webp" }));
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    } finally {
      if (origVis) Object.defineProperty(document, "visibilityState", origVis);
      else delete (document as unknown as Record<string, unknown>).visibilityState;
      act(() => root.unmount());
      queryClient.clear();
    }
  });
});
