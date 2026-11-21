// @vitest-environment jsdom
import { Editor, ImageCache, PrototypePlayer } from "@drawpane/editor";
import { ROOT_ID } from "@drawpane/model";
import { afterEach, describe, expect, it, vi } from "vitest";
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
});
