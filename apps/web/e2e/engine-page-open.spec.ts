import type { NodeRecord } from "@drawpane/model";
import { expect, test } from "@playwright/test";
import { freshInstance } from "./fresh-instance";
import { importNodes } from "./import-converted";

test.use({
  launchOptions: {
    args: [
      "--enable-unsafe-webgpu",
      "--enable-unsafe-swiftshader",
      "--use-webgpu-adapter=swiftshader",
      "--disable-gpu-sandbox",
    ],
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  },
});

const HEAVY_PAGE = "large-page";
const FIRST_PAGE = "small-page";
const OPEN_MS = 1_000;

function largeFile(): NodeRecord[] {
  const nodes: NodeRecord[] = [
    { id: FIRST_PAGE, type: "page", parent: "root", key: "a0", props: { name: "Small" } },
    { id: HEAVY_PAGE, type: "page", parent: "root", key: "a1", props: { name: "Large" } },
    {
      id: "warm-up",
      type: "rect",
      parent: FIRST_PAGE,
      key: "a0",
      props: {
        x: 32,
        y: 32,
        width: 320,
        height: 240,
        fills: [{ type: "solid", color: "#333333" }],
      },
    },
    {
      id: "distant-section",
      type: "frame",
      parent: HEAVY_PAGE,
      key: "a0",
      props: { x: 2000, y: 0, width: 42_000, height: 500 },
    },
    {
      id: "visible-section",
      type: "frame",
      parent: HEAVY_PAGE,
      key: "a1",
      props: { x: 0, y: 0, width: 400, height: 360 },
    },
    {
      id: "visible-branch",
      type: "frame",
      parent: "visible-section",
      key: "a0",
      props: { x: 0, y: 0, width: 400, height: 360 },
    },
    {
      id: "visible",
      type: "rect",
      parent: "visible-branch",
      key: "a0",
      props: {
        x: 32,
        y: 32,
        width: 320,
        height: 240,
        fills: [{ type: "solid", color: "#ce236c" }],
      },
    },
    {
      id: "lens",
      type: "rect",
      parent: "visible-branch",
      key: "a1",
      props: {
        x: 150,
        y: 68,
        width: 120,
        height: 96,
        cornerRadius: 16,
        fills: [{ type: "solid", color: "#ffffff50" }],
        effects: [
          {
            type: "glass",
            angle: 45,
            intensity: 75,
            depth: 22,
            refraction: 70,
            dispersion: 10,
            frost: 12,
            splay: 0,
          },
        ],
      },
    },
  ];
  // 18,000 records, 920 glass readers and 4,600 shadows. The later boards are outside the
  // first viewport so the deadline measures page admission and its first useful picture.
  for (let n = 0; n < 100; n++) {
    const board = `board-${n}`;
    nodes.push({
      id: board,
      type: "frame",
      parent: "distant-section",
      key: `b${n.toString(36).padStart(2, "0")}`,
      props: { x: n * 400, y: 0, width: 320, height: 320 },
    });
    for (let i = 0; i < 179; i++) {
      const sample = i % 19;
      nodes.push({
        id: `${board}-${i}`,
        type: "rect",
        parent: board,
        key: `b${i.toString(36).padStart(2, "0")}`,
        props: {
          x: (i % 13) * 20,
          y: Math.floor(i / 13) * 20,
          width: 16,
          height: 16,
          cornerRadius: 4,
          fills: [{ type: "solid", color: "#dbe2f2" }],
          ...(sample === 0 && n * 10 + Math.floor(i / 19) < 920
            ? {
                effects: [
                  {
                    type: "glass",
                    angle: 45,
                    intensity: 75,
                    depth: 22,
                    refraction: 70,
                    dispersion: 10,
                    frost: 12,
                    splay: 0,
                  },
                ],
              }
            : i >= 100 && i < 146
              ? {
                  effects: [
                    {
                      type: "drop-shadow",
                      color: "#00000040",
                      x: 1,
                      y: 1,
                      blur: 2,
                      spread: 0,
                    },
                  ],
                }
              : {}),
        },
      });
    }
  }
  return nodes;
}

type OpenCamera = {
  x: number;
  y: number;
  zoomAt(point: { x: number; y: number }, zoom: number): OpenCamera;
  pan(x: number, y: number): OpenCamera;
};

type OpenDebug = {
  drawpane: {
    s: { pageId: string; camera: OpenCamera };
    doc: { resetStored(nodes: readonly NodeRecord[], format: "materialized"): void };
    setPage(id: string): void;
    setCamera(camera: OpenCamera): void;
  };
  drawpaneFrames?: { exact: boolean };
  drawpaneEngineView?: {
    backend: string;
    canvas: HTMLCanvasElement;
    last: { pageId: string; reads: number };
    opened: { pageId: string; records: number };
    builder: { opening?: boolean };
  };
};

test("a dense page presents its first content before the full display list is built", async ({
  browser,
}) => {
  test.skip(!!process.env.E2E_BASE_URL, "Needs its own local instance.");
  test.setTimeout(420_000);
  const port = Number(process.env.ENGINE_OPEN_PORT ?? 21797);
  const app = await freshInstance(browser, { port, inspectorPort: port + 540 });
  const { page } = app;
  await page.setViewportSize({ width: 800, height: 600 });
  try {
    await page.evaluate(() => {
      localStorage.setItem("drawpane:debug", "1");
      localStorage.setItem("drawpane:renderer", "engine");
      localStorage.setItem("drawpane:engine-software", "allow");
      localStorage.setItem("drawpane:engine-present", "readback");
    });
    const nodes = largeFile();
    const file = await importNodes(
      page,
      nodes.filter((node) => node.id === FIRST_PAGE || node.parent === FIRST_PAGE),
      "Page switch",
    );
    await page.goto(`/f/${file}`);
    const ready = () =>
      page.waitForFunction(
        (id) => {
          const w = window as unknown as OpenDebug;
          const surface = document.querySelector<HTMLElement>(".canvas");
          return (
            w.drawpane?.s.pageId === id &&
            w.drawpaneEngineView?.backend === "webgpu" &&
            w.drawpaneFrames?.exact &&
            surface?.dataset.renderer === "webgpu" &&
            surface.dataset.rendererConfirmedFrame === surface.dataset.rendererSubmittedFrames
          );
        },
        FIRST_PAGE,
        { timeout: 90_000 },
      );
    await ready();
    await page.route("**/__engine-open-fixture", (route) => route.fulfill({ json: nodes }));
    // Keep the existing WebGPU device warm while loading the dense page's stored records.
    await page.evaluate(async () => {
      const response = await fetch("/__engine-open-fixture");
      const records = (await response.json()) as NodeRecord[];
      (window as unknown as OpenDebug).drawpane.doc.resetStored(records, "materialized");
    });
    await ready();
    const preview = await page.evaluate(
      async ({ from, to, deadline }) => {
        const w = window as unknown as OpenDebug;
        const view = w.drawpaneEngineView;
        const host = document.querySelector<HTMLElement>(".canvas");
        if (!view || !host) throw new Error("The engine canvas is missing");
        const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const base = Number(host.dataset.rendererFrames);
        const atOne = w.drawpane.s.camera.zoomAt({ x: 0, y: 0 }, 1);
        const start = performance.now();
        w.drawpane.setPage(to);
        w.drawpane.setCamera(atOne.pan(-atOne.x, -atOne.y));
        while (performance.now() - start < deadline) {
          if (
            view.last.pageId === to &&
            host.dataset.renderer === "webgpu" &&
            Number(host.dataset.rendererFrames) > base
          ) {
            const ctx = view.canvas.getContext("2d");
            const pink = ctx?.getImageData(100, 100, 1, 1).data;
            const lens = ctx?.getImageData(200, 116, 1, 1).data;
            if (
              pink?.[0] === 206 &&
              pink[1] === 35 &&
              (lens?.[1] ?? 0) > pink[1] &&
              view.last.reads > 0
            ) {
              const ms = performance.now() - start;
              const opening = view.builder.opening;
              const admitted = view.opened.records;
              const frames = Number(host.dataset.rendererFrames);
              w.drawpane.setPage(from);
              w.drawpane.setCamera(atOne.pan(-atOne.x, -atOne.y));
              return { ms, admitted, opening, frames };
            }
          }
          await frame();
        }
        return {
          ms: performance.now() - start,
          opening: false,
          admitted: 0,
          frames: 0,
        };
      },
      { from: FIRST_PAGE, to: HEAVY_PAGE, deadline: OPEN_MS },
    );
    expect(preview.ms, JSON.stringify(preview)).toBeLessThanOrEqual(OPEN_MS);
    expect(preview.opening).toBe(true);
    expect(preview.admitted).toBeLessThan(18_000);
    await ready();
    const returned = await page.evaluate(() => {
      const view = (window as unknown as OpenDebug).drawpaneEngineView;
      const host = document.querySelector<HTMLElement>(".canvas");
      const pixel = view?.canvas.getContext("2d")?.getImageData(100, 100, 1, 1).data;
      return {
        frames: Number(host?.dataset.rendererFrames),
        page: view?.last.pageId,
        rgba: pixel && [...pixel],
      };
    });
    expect(returned.frames).toBeGreaterThan(preview.frames);
    expect(returned.page).toBe(FIRST_PAGE);
    expect(returned.rgba).toEqual([51, 51, 51, 255]);

    await page.evaluate((id) => {
      const { drawpane } = window as unknown as OpenDebug;
      const atOne = drawpane.s.camera.zoomAt({ x: 0, y: 0 }, 1);
      drawpane.setPage(id);
      drawpane.setCamera(atOne.pan(-atOne.x, -atOne.y));
    }, HEAVY_PAGE);
    await page.waitForFunction(
      (id) => {
        const w = window as unknown as OpenDebug;
        const view = w.drawpaneEngineView;
        const host = document.querySelector<HTMLElement>(".canvas");
        return (
          view?.last.pageId === id &&
          !view.builder.opening &&
          w.drawpaneFrames?.exact &&
          host?.dataset.renderer === "webgpu" &&
          host.dataset.rendererConfirmedFrame === host.dataset.rendererSubmittedFrames
        );
      },
      HEAVY_PAGE,
      { timeout: 90_000 },
    );
  } finally {
    await app.stop();
  }
});
