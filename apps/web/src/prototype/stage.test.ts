// @vitest-environment jsdom
import { CanvasRenderer, Editor, ExportError, ImageCache, PrototypePlayer } from "@drawpane/editor";
import { ROOT_ID } from "@drawpane/model";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as snapshot from "../editor/engine-snapshot";
import { EngineView } from "../editor/engine-view";
import { deviceRoom, PlayerStage } from "./stage";

describe("the room a device has on the stage", () => {
  it("keeps the device clear of the hint pill along the bottom", () => {
    // A laptop window's stage: 48px above, and 60px below for the hint (16 up, 28 tall, 16 of air).
    const room = deviceRoom(1196, 846);
    expect(room.width).toBe(1196 - 96);
    expect(room.height).toBe(846 - 48 - 60);
    // The device centres in what's left: its bottom margin makes up the difference.
    expect(room.lift).toBe(12);
  });

  it("keeps the hint's room on a narrow window too", () => {
    const room = deviceRoom(560, 700);
    expect(room.width).toBe(560 - 32);
    expect(room.height).toBe(700 - 16 - 60);
    expect(room.lift).toBe(44);
  });

  it("never leaves less than a usable box", () => {
    expect(deviceRoom(120, 90)).toMatchObject({ width: 100, height: 100 });
  });
});

class StubResizeObserver {
  observe() {}
  disconnect() {}
}

function makePrototypeEditor() {
  const editor = new Editor({ measurer: { width: () => 0 }, clientId: "test" });
  editor.doc.apply([
    { op: "create", id: "p", type: "page", parent: ROOT_ID, key: "a0", props: { name: "Page 1" } },
    {
      op: "create",
      id: "s1",
      type: "frame",
      parent: "p",
      key: "a0",
      props: { x: 0, y: 0, width: 300, height: 400, fills: [{ type: "solid", color: "#e03131" }] },
    },
    {
      op: "create",
      id: "s2",
      type: "frame",
      parent: "p",
      key: "a1",
      props: {
        x: 400,
        y: 0,
        width: 300,
        height: 400,
        fills: [{ type: "solid", color: "#1971c2" }],
      },
    },
    {
      op: "create",
      id: "btn",
      type: "rect",
      parent: "s1",
      key: "a0",
      props: {
        x: 0,
        y: 0,
        width: 300,
        height: 400,
        fills: [{ type: "solid", color: "#ffffff" }],
        reactions: [
          {
            id: "r1",
            trigger: { type: "tap" },
            action: { type: "navigate", to: "s2" },
            transition: {
              type: "instant",
              direction: "left",
              duration: 0,
              easing: { type: "linear" },
            },
          },
        ],
      },
    },
  ]);
  editor.setPage("p");
  return editor;
}

describe("PlayerStage gating and unavailable fallback", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("stays on canvas mode without starting EngineView when the switch is canvas", () => {
    globalThis.ResizeObserver = StubResizeObserver as unknown as typeof ResizeObserver;
    const createSpy = vi.spyOn(EngineView, "create").mockResolvedValue(null);
    const editor = makePrototypeEditor();
    const images = new ImageCache();
    const player = new PrototypePlayer(editor.doc, "s1");
    const host = document.createElement("div");
    document.body.append(host);

    const stage = new PlayerStage({
      editor,
      images,
      player,
      host,
      device: "none",
      choice: "canvas",
    });

    const device = host.querySelector(".stage__device") as HTMLElement;
    expect(device.dataset.renderer).toBe("canvas");
    expect(createSpy).not.toHaveBeenCalled();

    stage.destroy();
    images.clear();
  });

  it("shows an explicit unavailable message and disables hotspots when neither engine nor canvas can draw", async () => {
    globalThis.ResizeObserver = StubResizeObserver as unknown as typeof ResizeObserver;
    vi.spyOn(EngineView, "create").mockResolvedValue(null);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);

    const editor = makePrototypeEditor();
    const images = new ImageCache();
    const player = new PrototypePlayer(editor.doc, "s1");
    const host = document.createElement("div");
    document.body.append(host);

    const stage = new PlayerStage({
      editor,
      images,
      player,
      host,
      device: "none",
      choice: "engine",
    });

    await new Promise((r) => setTimeout(r, 0));

    const device = host.querySelector(".stage__device") as HTMLElement;
    const unavailable = host.querySelector(".stage__unavailable") as HTMLElement;
    expect(device.dataset.renderer).toBe("unavailable");
    expect(unavailable.style.display).not.toBe("none");
    expect(unavailable.textContent).toContain("couldn't be rendered");

    // Clicking the viewport must NOT trigger hotspots on an undrawn screen.
    const viewport = host.querySelector(".stage__viewport") as HTMLElement;
    viewport.dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 50, clientY: 50 }),
    );
    viewport.dispatchEvent(
      new MouseEvent("pointerup", { bubbles: true, button: 0, clientX: 50, clientY: 50 }),
    );
    expect(player.state.screen).toBe("s1");

    stage.destroy();
    images.clear();
  });

  it("preserves canvas-mode screen height past 16,384 px when total pixels fit MAX_PIXELS", () => {
    globalThis.ResizeObserver = StubResizeObserver as unknown as typeof ResizeObserver;
    const origDpr = window.devicePixelRatio;
    Object.defineProperty(window, "devicePixelRatio", { value: 2, configurable: true });
    try {
      const editor = new Editor({ measurer: { width: () => 0 }, clientId: "test" });
      editor.doc.apply([
        { op: "create", id: "p", type: "page", parent: ROOT_ID, key: "a0", props: { name: "P" } },
        {
          op: "create",
          id: "tall",
          type: "frame",
          parent: "p",
          key: "a0",
          props: {
            x: 0,
            y: 0,
            width: 393,
            height: 10_000,
            fills: [{ type: "solid", color: "#ffffff" }],
          },
        },
      ]);
      editor.setPage("p");
      const images = new ImageCache();
      const player = new PrototypePlayer(editor.doc, "tall");
      const host = document.createElement("div");
      host.getBoundingClientRect = () => new DOMRect(0, 0, 1200, 900);
      document.body.append(host);

      const stage = new PlayerStage({
        editor,
        images,
        player,
        host,
        device: "iphone-16",
        choice: "canvas",
      });

      const canvas = host.querySelector(".stage__screen canvas") as HTMLCanvasElement;
      expect(canvas).not.toBeNull();
      // 393 × 10,000 at contentScale 1 and dpr 2 = 786 × 20,000 = 15.72M px <= 24M MAX_PIXELS.
      expect(canvas.height).toBeGreaterThan(16_384);

      stage.destroy();
      images.clear();
    } finally {
      Object.defineProperty(window, "devicePixelRatio", { value: origDpr, configurable: true });
    }
  });

  it("holds an engine overlay hidden and inert when both snapshot worker and canvas fail, and falls back when canvas works", async () => {
    globalThis.ResizeObserver = StubResizeObserver as unknown as typeof ResizeObserver;
    vi.spyOn(EngineView, "create").mockResolvedValue(null);
    vi.spyOn(snapshot, "renderEngineSnapshot").mockRejectedValue(
      new ExportError("Snapshot renderer failed to load."),
    );

    const makeOverlayEditor = () => {
      const editor = new Editor({ measurer: { width: () => 0 }, clientId: "test" });
      editor.doc.apply([
        { op: "create", id: "p", type: "page", parent: ROOT_ID, key: "a0", props: { name: "P" } },
        {
          op: "create",
          id: "s1",
          type: "frame",
          parent: "p",
          key: "a0",
          props: {
            x: 0,
            y: 0,
            width: 300,
            height: 400,
            fills: [{ type: "solid", color: "#ffffff" }],
          },
        },
        {
          op: "create",
          id: "s2",
          type: "frame",
          parent: "p",
          key: "a1",
          props: {
            x: 400,
            y: 0,
            width: 300,
            height: 400,
            fills: [{ type: "solid", color: "#0000ff" }],
          },
        },
        {
          op: "create",
          id: "ov",
          type: "frame",
          parent: "p",
          key: "a2",
          props: {
            x: 800,
            y: 0,
            width: 200,
            height: 150,
            fills: [{ type: "solid", color: "#ffaa00" }],
          },
        },
        {
          op: "create",
          id: "ovBtn",
          type: "rect",
          parent: "ov",
          key: "a0",
          props: {
            x: 0,
            y: 0,
            width: 200,
            height: 150,
            fills: [{ type: "solid", color: "#ffaa00" }],
            reactions: [
              {
                id: "r-nav",
                trigger: { type: "tap" },
                action: { type: "navigate", to: "s2" },
                transition: {
                  type: "instant",
                  direction: "left",
                  duration: 0,
                  easing: { type: "linear" },
                },
              },
            ],
          },
        },
      ]);
      editor.setPage("p");
      return editor;
    };

    const overlayStep = {
      type: "open-overlay" as const,
      overlay: {
        key: 1,
        screen: "ov",
        position: "center" as const,
        closeOnOutside: true,
        dim: 0.4,
        transition: {
          type: "instant" as const,
          direction: "up" as const,
          duration: 0,
          easing: { type: "linear" as const },
        },
      },
    };

    // Case 1: Worker fails AND 2D canvas context is unavailable -> overlay stays hidden and inert.
    const ctxSpy = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const editor1 = makeOverlayEditor();
    const images1 = new ImageCache();
    const player1 = new PrototypePlayer(editor1.doc, "s1");
    const host1 = document.createElement("div");
    host1.getBoundingClientRect = () => new DOMRect(0, 0, 800, 800);
    document.body.append(host1);
    const stage1 = new PlayerStage({
      editor: editor1,
      images: images1,
      player: player1,
      host: host1,
      device: "none",
      choice: "engine",
    });
    stage1.play(overlayStep);
    await new Promise((r) => setTimeout(r, 0));

    const overlayEl1 = host1.querySelector(".stage__overlay") as HTMLElement;
    const overlayCanvas1 = overlayEl1.querySelector("canvas") as HTMLCanvasElement;
    overlayCanvas1.getBoundingClientRect = () => new DOMRect(50, 50, 200, 150);
    expect(overlayEl1.dataset.painted).toBe("false");
    expect(overlayEl1.style.visibility).toBe("hidden");

    const viewport1 = host1.querySelector(".stage__viewport") as HTMLElement;
    viewport1.dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 100, clientY: 100 }),
    );
    viewport1.dispatchEvent(
      new MouseEvent("pointerup", { bubbles: true, button: 0, clientX: 100, clientY: 100 }),
    );
    expect(player1.state.screen).toBe("s1");
    stage1.flashHotspots();
    expect(overlayEl1.querySelectorAll(".stage__hotspot")).toHaveLength(0);
    stage1.destroy();
    images1.clear();

    // Case 2: Worker fails with non-abort error, canvas IS available -> falls back and paints.
    ctxSpy.mockReturnValue({
      clearRect: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(CanvasRenderer.prototype, "renderNodes").mockImplementation(() => {});
    const editor2 = makeOverlayEditor();
    const images2 = new ImageCache();
    const player2 = new PrototypePlayer(editor2.doc, "s1");
    const host2 = document.createElement("div");
    host2.getBoundingClientRect = () => new DOMRect(0, 0, 800, 800);
    document.body.append(host2);
    const stage2 = new PlayerStage({
      editor: editor2,
      images: images2,
      player: player2,
      host: host2,
      device: "none",
      choice: "engine",
    });
    stage2.play(overlayStep);
    await new Promise((r) => setTimeout(r, 0));

    const overlayEl2 = host2.querySelector(".stage__overlay") as HTMLElement;
    expect(overlayEl2.dataset.painted).toBe("true");
    expect(overlayEl2.style.visibility).toBe("");
    stage2.destroy();
    images2.clear();
  });

  it("coalesces continuous remote edits without cancelling an engine overlay paint in flight", async () => {
    globalThis.ResizeObserver = StubResizeObserver as unknown as typeof ResizeObserver;
    vi.spyOn(EngineView, "create").mockResolvedValue(null);
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      clearRect: vi.fn(),
      drawImage,
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(CanvasRenderer.prototype, "renderNodes").mockImplementation(() => {});
    const origCreateImageBitmap = globalThis.createImageBitmap;
    globalThis.createImageBitmap = vi.fn(async () => ({
      width: 200,
      height: 150,
      close: vi.fn(),
    })) as unknown as typeof createImageBitmap;

    const pending: Array<{
      readonly signal: AbortSignal | undefined;
      resolve(blob: Blob): void;
    }> = [];
    const snapSpy = vi.spyOn(snapshot, "renderEngineSnapshot").mockImplementation(
      (_editor, options) =>
        new Promise<Blob>((resolve) => {
          pending.push({ signal: options.signal, resolve });
        }),
    );

    const editor = new Editor({ measurer: { width: () => 0 }, clientId: "test" });
    editor.doc.apply([
      { op: "create", id: "p", type: "page", parent: ROOT_ID, key: "a0", props: { name: "P" } },
      {
        op: "create",
        id: "s1",
        type: "frame",
        parent: "p",
        key: "a0",
        props: {
          x: 0,
          y: 0,
          width: 300,
          height: 400,
          fills: [{ type: "solid", color: "#ffffff" }],
        },
      },
      {
        op: "create",
        id: "ov",
        type: "frame",
        parent: "p",
        key: "a1",
        props: {
          x: 500,
          y: 0,
          width: 200,
          height: 150,
          fills: [{ type: "solid", color: "#ffaa00" }],
        },
      },
      {
        op: "create",
        id: "remote",
        type: "rect",
        parent: "p",
        key: "a2",
        props: {
          x: 2000,
          y: 0,
          width: 50,
          height: 50,
          fills: [{ type: "solid", color: "#00aa88" }],
        },
      },
    ]);
    editor.setPage("p");

    const images = new ImageCache();
    const player = new PrototypePlayer(editor.doc, "s1");
    const host = document.createElement("div");
    host.getBoundingClientRect = () => new DOMRect(0, 0, 800, 800);
    document.body.append(host);

    const rafCallbacks: FrameRequestCallback[] = [];
    const origRaf = globalThis.requestAnimationFrame;
    const origCancelRaf = globalThis.cancelAnimationFrame;
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    }) as typeof requestAnimationFrame;
    globalThis.cancelAnimationFrame = vi.fn();

    try {
      const stage = new PlayerStage({
        editor,
        images,
        player,
        host,
        device: "none",
        choice: "engine",
        overlayFirstPaintDeadlineMs: 10_000,
      });
      stage.play({
        type: "open-overlay",
        overlay: {
          key: 1,
          screen: "ov",
          position: "center",
          closeOnOutside: true,
          dim: 0.4,
          transition: {
            type: "instant",
            direction: "up",
            duration: 0,
            easing: { type: "linear" },
          },
        },
      });

      expect(snapSpy).toHaveBeenCalledTimes(1);
      const firstCall = pending[0];
      expect(firstCall).toBeDefined();

      // Simulate continuous remote edits on an unrelated layer while the first paint is in flight.
      for (let i = 1; i <= 8; i++) {
        editor.doc.apply([{ op: "set", id: "remote", prop: "x", value: 2000 + i }]);
        const cb = rafCallbacks.pop();
        cb?.(i * 33);
      }

      // First snapshot must NOT be aborted or restarted while still in flight.
      expect(firstCall?.signal?.aborted).toBe(false);
      expect(snapSpy).toHaveBeenCalledTimes(1);

      // Resolving the first paint reveals the overlay and kicks off exactly one coalesced repaint.
      firstCall?.resolve(new Blob([new Uint8Array([1])], { type: "image/png" }));
      await new Promise((r) => setTimeout(r, 0));

      const overlayEl = host.querySelector(".stage__overlay") as HTMLElement;
      const dimEl = host.querySelector(".stage__dim") as HTMLElement;
      expect(overlayEl.dataset.painted).toBe("true");
      expect(overlayEl.style.visibility).toBe("");
      expect(dimEl.style.visibility).toBe("");
      expect(snapSpy).toHaveBeenCalledTimes(2);
      expect(drawImage).toHaveBeenCalledTimes(1);

      // Resolving the coalesced repaint settles cleanly with no further paints.
      pending[1]?.resolve(new Blob([new Uint8Array([2])], { type: "image/png" }));
      await new Promise((r) => setTimeout(r, 0));
      expect(snapSpy).toHaveBeenCalledTimes(2);
      expect(drawImage).toHaveBeenCalledTimes(2);

      stage.destroy();
      images.clear();
    } finally {
      globalThis.createImageBitmap = origCreateImageBitmap;
      globalThis.requestAnimationFrame = origRaf;
      globalThis.cancelAnimationFrame = origCancelRaf;
    }
  });

  it("shows canvas fallback when an engine overlay first paint passes the deadline, then swaps to engine", async () => {
    globalThis.ResizeObserver = StubResizeObserver as unknown as typeof ResizeObserver;
    vi.spyOn(EngineView, "create").mockResolvedValue(null);
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      clearRect: vi.fn(),
      drawImage,
    } as unknown as CanvasRenderingContext2D);
    const canvasRenderSpy = vi
      .spyOn(CanvasRenderer.prototype, "renderNodes")
      .mockImplementation(() => {});
    const origCreateImageBitmap = globalThis.createImageBitmap;
    globalThis.createImageBitmap = vi.fn(async () => ({
      width: 200,
      height: 150,
      close: vi.fn(),
    })) as unknown as typeof createImageBitmap;

    const resolvers: Array<(blob: Blob) => void> = [];
    vi.spyOn(snapshot, "renderEngineSnapshot").mockImplementation(
      () =>
        new Promise<Blob>((resolve) => {
          resolvers.push(resolve);
        }),
    );

    const editor = makePrototypeEditor();
    const images = new ImageCache();
    const player = new PrototypePlayer(editor.doc, "s1");
    const host = document.createElement("div");
    host.getBoundingClientRect = () => new DOMRect(0, 0, 800, 800);
    document.body.append(host);

    try {
      const stage = new PlayerStage({
        editor,
        images,
        player,
        host,
        device: "none",
        choice: "engine",
        overlayFirstPaintDeadlineMs: 25,
      });
      stage.play({
        type: "open-overlay",
        overlay: {
          key: 1,
          screen: "s2",
          position: "center",
          closeOnOutside: true,
          dim: 0.4,
          transition: {
            type: "instant",
            direction: "up",
            duration: 0,
            easing: { type: "linear" },
          },
        },
      });

      const overlayEl = host.querySelector(".stage__overlay") as HTMLElement;
      const dimEl = host.querySelector(".stage__dim") as HTMLElement;
      expect(overlayEl.dataset.painted).toBe("false");
      expect(overlayEl.style.visibility).toBe("hidden");
      expect(dimEl.style.visibility).toBe("hidden");

      // After the deadline, canvas fallback paints and reveals the overlay while engine is still pending.
      await new Promise((r) => setTimeout(r, 60));
      expect(canvasRenderSpy).toHaveBeenCalled();
      expect(overlayEl.dataset.painted).toBe("true");
      expect(overlayEl.style.visibility).toBe("");
      expect(dimEl.style.visibility).toBe("");
      expect(drawImage).not.toHaveBeenCalled();

      // When the engine render arrives later, it swaps onto the overlay canvas cleanly.
      resolvers[0]?.(new Blob([new Uint8Array([9])], { type: "image/png" }));
      await new Promise((r) => setTimeout(r, 0));
      expect(drawImage).toHaveBeenCalledTimes(1);

      stage.destroy();
      images.clear();
    } finally {
      globalThis.createImageBitmap = origCreateImageBitmap;
    }
  });

  it("keeps canvas-mode overlay dim visible even when 2D canvas context is unavailable", () => {
    globalThis.ResizeObserver = StubResizeObserver as unknown as typeof ResizeObserver;
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const editor = makePrototypeEditor();
    const images = new ImageCache();
    const player = new PrototypePlayer(editor.doc, "s1");
    const host = document.createElement("div");
    host.getBoundingClientRect = () => new DOMRect(0, 0, 800, 800);
    document.body.append(host);

    const stage = new PlayerStage({
      editor,
      images,
      player,
      host,
      device: "none",
      choice: "canvas",
    });
    stage.play({
      type: "open-overlay",
      overlay: {
        key: 1,
        screen: "s2",
        position: "center",
        closeOnOutside: true,
        dim: 0.4,
        transition: {
          type: "instant",
          direction: "up",
          duration: 0,
          easing: { type: "linear" },
        },
      },
    });

    const overlayEl = host.querySelector(".stage__overlay") as HTMLElement;
    const dimEl = host.querySelector(".stage__dim") as HTMLElement;
    expect(dimEl.style.visibility).toBe("");
    expect(overlayEl.style.visibility).toBe("");

    stage.destroy();
    images.clear();
  });
});
