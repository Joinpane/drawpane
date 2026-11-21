import { ROOT_ID } from "@drawpane/model";
import { Camera } from "../../../../packages/editor/src/camera";
import { Editor } from "../../../../packages/editor/src/editor";
import { CanvasRenderer } from "../../../../packages/editor/src/render";

export function glassAtHighZoom() {
  const editor = new Editor({ measurer: { width: () => 0 }, clientId: "glass-zoom" });
  editor.state.set({ role: "editor" });
  const pageId = "page";
  editor.doc.apply([
    { op: "create", id: pageId, type: "page", parent: ROOT_ID, key: "a0", props: {} },
  ]);
  editor.setPage(pageId);
  editor.createLayer("rect", { x: -200, y: -200, width: 500, height: 500 }, pageId, {
    fills: [{ type: "solid", color: "#248c50" }],
  });
  editor.createLayer("rect", { x: 0, y: 0, width: 130, height: 36 }, pageId, {
    cornerRadius: 18,
    fills: [],
    effects: [
      {
        type: "glass",
        angle: 0,
        intensity: 80,
        refraction: 100,
        depth: 18,
        dispersion: 100,
        frost: 100,
        splay: 100,
      },
    ],
  });

  const viewport = { width: 360, height: 180 };
  const dpr = 2;
  const canvas = new OffscreenCanvas(viewport.width * dpr, viewport.height * dpr);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("no Canvas2D context");
  const renderer = new CanvasRenderer(editor.scene, editor.measurer);
  return [26, 100, 256].map((zoom) => {
    const camera = new Camera(viewport.width / 2 - 65 * zoom, 24, zoom);
    renderer.render(ctx, pageId, camera, viewport, dpr, { exact: true });
    const pixel = (y: number) => Array.from(ctx.getImageData(canvas.width / 2, y, 1, 1).data);
    return { zoom, outside: pixel(12), rim: pixel(96) };
  });
}
