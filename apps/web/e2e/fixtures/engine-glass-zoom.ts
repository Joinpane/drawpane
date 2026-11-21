import { Editor, ImageCache } from "@drawpane/editor";
import { ROOT_ID } from "@drawpane/model";
import { EngineView, type FallbackEvent } from "../../src/editor/engine-view";
import type { RendererChoice } from "../../src/editor/renderer-switch";

const pageId = "page";
const width = 320;
const height = 192;
const dpr = 2;
const green = "#248c50";

export async function drawExtremeZoom(choice: RendererChoice) {
  const editor = new Editor({ measurer: { width: () => 0 }, clientId: "engine-glass-zoom" });
  editor.state.set({ role: "editor" });
  editor.doc.apply([
    {
      op: "create",
      id: pageId,
      type: "page",
      parent: ROOT_ID,
      key: "a0",
      props: { backgroundColor: green },
    },
  ]);
  editor.setPage(pageId);
  const pill = { x: 0, y: 0, width: 130, height: 36 };
  const glass = {
    type: "glass" as const,
    angle: 0,
    intensity: 80,
    refraction: 95,
    depth: 18,
    dispersion: 65,
    frost: 18,
    splay: 50,
  };
  editor.createLayer("rect", { x: -200, y: -200, width: 500, height: 500 }, pageId, {
    fills: [{ type: "solid", color: green }],
  });
  editor.createLayer("rect", pill, pageId, {
    fills: [],
    cornerRadius: 18,
    effects: [glass],
  });

  const slot = document.createElement("div");
  document.body.append(slot);
  localStorage.setItem("drawpane:engine-software", "allow");
  const fallbacks: FallbackEvent[] = [];
  const fallback = (event: Event) => fallbacks.push((event as CustomEvent<FallbackEvent>).detail);
  window.addEventListener("drawpane:renderer-fallback", fallback);
  const engine = await EngineView.create(slot, editor, editor.measurer, new ImageCache(), choice);
  if (!engine) throw new Error(`render engine failed to start: ${JSON.stringify(fallbacks)}`);
  const view = engine;
  const backend = view.backend;
  const wait = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  async function frame(zoom: number, x: number, y: number, w = width, h = height) {
    const previous = view.last.n;
    const camera = { x: w / 2 - x * zoom, y: h / 2 - y * zoom, zoom };
    let displayed = false;
    for (let i = 0; i < 20; i++) {
      const draw = view.draw(
        pageId,
        camera,
        w * dpr,
        h * dpr,
        dpr,
        green,
        { hidden: new Set(), whole: null },
        true,
        0,
      );
      if (!draw.drawn) {
        throw new Error(
          `engine handed off at ${zoom * 100}%: ${JSON.stringify({
            backend: view.backend,
            recovering: view.recovering,
            limit: view.limitReason,
            fallbacks,
          })}`,
        );
      }
      if (draw.settled && draw.ready) {
        displayed = true;
        break;
      }
      const deadline = performance.now() + 15_000;
      while (performance.now() < deadline && view.shown.n < view.last.n && !view.recovering)
        await wait();
      if (draw.settled && !draw.awaitingPreview && view.shown.n >= view.last.n) {
        displayed = true;
        break;
      }
    }
    if (!displayed || view.last.n <= previous)
      throw new Error(`no new settled engine picture at ${zoom * 100}%`);
    if (view.backend !== backend)
      throw new Error(`backend changed at ${zoom * 100}%: ${JSON.stringify(fallbacks)}`);
    const rasterWidth = view.canvas.width;
    const rasterHeight = view.canvas.height;
    const ctx = view.canvas.getContext("2d");
    if (!ctx) throw new Error("no readback canvas");
    const cx = Math.floor(rasterWidth / 2);
    const cy = Math.floor(rasterHeight / 2);
    const center = ctx.getImageData(cx, cy, 1, 1);
    return {
      zoom,
      exact: view.last.exact,
      limit: view.limitReason,
      size: [rasterWidth, rasterHeight],
      pixel: Array.from(center.data),
      detail: Array.from(ctx.getImageData(cx - 8, cy, 16, 1).data),
    };
  }

  try {
    await frame(1, 65, 18);
    const rim = [];
    for (const zoom of [26, 100, 256]) rim.push(await frame(zoom, 65, 0.65));
    const interior = await frame(256, 65, 18);
    // Nested isolation around background blur, additional glass, and a layer blur
    // exercise overlapping reader halos at reproducible, varied zooms.
    const scope = editor.createLayer("frame", { x: 20, y: 4, width: 85, height: 27 }, pageId, {
      fills: [],
      opacity: 0.8,
      effects: [{ type: "layer-blur", radius: 1 }],
    });
    if (!scope) throw new Error("no reader scope");
    for (let i = 0; i < 3; i++) {
      editor.createLayer("rect", { x: i * 4, y: 0, width: 80, height: 24 }, scope, {
        fills: [{ type: "solid", color: green }],
        effects: [{ type: "background-blur", radius: 2 + i }],
      });
      editor.createLayer("rect", { x: i * 3, y: 1, width: 76, height: 22 }, scope, {
        fills: [],
        cornerRadius: 11,
        effects: [{ ...glass, intensity: 0, depth: 4, frost: 2 }],
      });
    }
    let seed = 0x63a65f11;
    const fuzz = [];
    for (let i = 0; i < 4; i++) {
      seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
      // Keep the overlapping readers affordable on a software GPU. The
      // named zoom cases still render the full test viewport.
      fuzz.push(await frame(26 + (seed % 231), 56 + (seed % 16), 18, 160, 96));
    }
    // The top rim bends toward the blue band, which lies outside the viewport.
    // Alternating stripes make a missing or mispositioned refraction visible.
    const striped = { ...pill, x: 300 };
    for (let i = 0; i < 12; i++) {
      editor.createLayer(
        "rect",
        { x: striped.x, y: 10 + i, width: striped.width, height: 1 },
        pageId,
        { fills: [{ type: "solid", color: i % 2 ? "#365aec" : "#2044e0" }] },
      );
    }
    const plain = await frame(26, 365, 0.65);
    editor.createLayer("rect", striped, pageId, {
      fills: [],
      cornerRadius: 18,
      effects: [{ ...glass, intensity: 0, dispersion: 0, frost: 0, splay: 0 }],
    });
    // A later fill occupies the same offscreen pixels. It must be absent
    // from the lens's snapshot even when the same strip is replayed.
    editor.createLayer("rect", { x: striped.x, y: 10, width: striped.width, height: 12 }, pageId, {
      fills: [{ type: "solid", color: "#d01912" }],
    });
    const refracted = await frame(26, 365, 0.65);
    // At the centre of clear glass each ray arrives in the device-resolution
    // viewport. A one-device-pixel stripe would disappear at even half scale.
    const detailZoom = 256;
    const devicePixel = 1 / (detailZoom * dpr);
    const detailX = 650;
    for (let i = -8; i < 8; i += 2) {
      editor.createLayer(
        "rect",
        { x: detailX + i * devicePixel, y: 17, width: devicePixel, height: 2 },
        pageId,
        {
          // The editor rounds interactive geometry to hundredths. The fixture
          // gives the stored layer exact coordinates for this device pixel.
          x: detailX + i * devicePixel,
          width: devicePixel,
          fills: [{ type: "solid", color: "#ffffff" }],
        },
      );
    }
    const detailReference = await frame(detailZoom, detailX, 18);
    editor.createLayer("rect", { ...pill, x: detailX - 65 }, pageId, {
      fills: [],
      cornerRadius: 18,
      effects: [{ ...glass, intensity: 0, dispersion: 0, frost: 0, splay: 0 }],
    });
    const detailGlass = await frame(detailZoom, detailX, 18);
    // A large Gaussian reads far past this viewport. A black-white
    // half-plane has a midpoint near half intensity after symmetric blur.
    const wideBlur = [];
    for (const [i, radius] of [20, 40].entries()) {
      const x = 1200 + i * 500;
      editor.createLayer("rect", { x: x - 180, y: -180, width: 360, height: 360 }, pageId, {
        fills: [{ type: "solid", color: "#ffffff" }],
      });
      editor.createLayer("rect", { x: x - 180, y: -180, width: 180, height: 360 }, pageId, {
        fills: [{ type: "solid", color: "#000000" }],
      });
      editor.createLayer("rect", { x: x - 60, y: -60, width: 120, height: 120 }, pageId, {
        fills: [{ type: "solid", color: "#00000001" }],
        effects: [{ type: "background-blur", radius }],
      });
      wideBlur.push(await frame(radius === 20 ? 100 : 50, x, 0));
    }
    return {
      backend,
      fallbacks,
      rim,
      interior,
      fuzz,
      plain,
      refracted,
      detailReference,
      detailGlass,
      wideBlur,
    };
  } finally {
    window.removeEventListener("drawpane:renderer-fallback", fallback);
    view.dispose();
    slot.remove();
  }
}
