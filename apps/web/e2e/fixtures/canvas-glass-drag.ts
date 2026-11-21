import { ROOT_ID } from "@drawpane/model";
import { Camera } from "../../../../packages/editor/src/camera";
import { Editor } from "../../../../packages/editor/src/editor";
import type { Point } from "../../../../packages/editor/src/geometry";
import { ImageCache } from "../../../../packages/editor/src/images";
import { CanvasRenderer } from "../../../../packages/editor/src/render";
import { Scene } from "../../../../packages/editor/src/scene";

export async function compareGlassDrag() {
  const editor = new Editor({ measurer: { width: () => 0 }, clientId: "glass-drag-test" });
  editor.state.set({ role: "editor" });
  const pageId = "page";
  editor.doc.apply([
    {
      op: "create",
      id: pageId,
      type: "page",
      parent: ROOT_ID,
      key: "a0",
      props: { backgroundColor: "#ffffff" },
    },
  ]);
  editor.setPage(pageId);

  const viewport = { width: 960, height: 580 };
  const camera = new Camera(0, 0, 2);
  const picture = new OffscreenCanvas(480, 98);
  const paint = picture.getContext("2d");
  if (!paint) throw new Error("no picture canvas");
  const sky = paint.createLinearGradient(0, 0, picture.width, picture.height);
  sky.addColorStop(0, "#00688b");
  sky.addColorStop(0.5, "#158e96");
  sky.addColorStop(1, "#fd8532");
  paint.fillStyle = sky;
  paint.fillRect(0, 0, picture.width, picture.height);
  paint.fillStyle = "#16303a";
  for (let x = 0; x < picture.width; x += 39) paint.fillRect(x, x % 40, 8, 51 + (x % 21));

  const images = new ImageCache();
  const ref = "7".repeat(64);
  images.put(ref, {
    bitmap: await createImageBitmap(picture),
    naturalWidth: picture.width,
    naturalHeight: picture.height,
  });
  editor.createLayer("rect", { x: 0, y: 0, width: picture.width, height: picture.height }, pageId, {
    fills: [{ type: "image", scaleMode: "stretch", ref }],
  });
  const ink = { fills: [{ type: "solid" as const, color: "#000000" }] };
  editor.createLayer("rect", { x: 286, y: 124, width: 42, height: 152 }, pageId, ink);
  editor.createLayer("rect", { x: 231, y: 178, width: 152, height: 42 }, pageId, ink);

  const width = 247;
  const height = 90;
  const start = { x: 116, y: 91 };
  const pill = editor.createLayer("rect", { ...start, width, height }, pageId, {
    cornerRadius: 45,
    fills: [],
    effects: [
      {
        type: "glass",
        angle: -45,
        intensity: 65,
        refraction: 80,
        depth: 20,
        dispersion: 35,
        frost: 18,
        splay: 0,
      },
    ],
  });
  if (!pill) throw new Error("could not create the glass pill");

  const context = () => {
    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("no comparison canvas");
    return ctx;
  };
  const actual = context();
  const expected = context();
  const kept = new CanvasRenderer(editor.scene, editor.measurer, { images });
  const fresh = new CanvasRenderer(new Scene(editor.doc), editor.measurer, { images });
  // Let the image cache's availability notification run before drawing the kept frame.
  await new Promise<void>((done) => setTimeout(done, 0));
  const pixels = (ctx: CanvasRenderingContext2D) =>
    ctx.getImageData(0, 0, viewport.width, viewport.height).data;
  fresh.hidden = new Set([pill]);
  fresh.render(expected, pageId, camera, viewport, 1, { exact: true });
  const backdrop = pixels(expected);
  fresh.hidden = new Set();

  const compare = (p: Point) => {
    fresh.invalidate();
    fresh.render(expected, pageId, camera, viewport, 1, { exact: true });
    const seen = pixels(actual);
    const oracle = pixels(expected);
    const x0 = p.x * camera.zoom;
    const y0 = p.y * camera.zoom;
    const x1 = x0 + width * camera.zoom;
    const y1 = y0 + height * camera.zoom;
    let oldPixels = 0;
    let lensPixels = 0;
    let differentPixels = 0;
    for (let y = 0; y < viewport.height; y++) {
      for (let x = 0; x < viewport.width; x++) {
        const i = (y * viewport.width + x) * 4;
        const different =
          Math.abs((seen[i] as number) - (oracle[i] as number)) > 2 ||
          Math.abs((seen[i + 1] as number) - (oracle[i + 1] as number)) > 2 ||
          Math.abs((seen[i + 2] as number) - (oracle[i + 2] as number)) > 2 ||
          Math.abs((seen[i + 3] as number) - (oracle[i + 3] as number)) > 2;
        differentPixels += Number(different);
        if (x < x0 - 2 || x >= x1 + 2 || y < y0 - 2 || y >= y1 + 2) {
          oldPixels += Number(different);
        } else if (
          seen[i] !== backdrop[i] ||
          seen[i + 1] !== backdrop[i + 1] ||
          seen[i + 2] !== backdrop[i + 2]
        ) {
          lensPixels++;
        }
      }
    }
    return { oldPixels, lensPixels, differentPixels, visible: x0 < viewport.width };
  };
  kept.render(actual, pageId, camera, viewport, 1, { exact: true });
  const end = { x: 75, y: 96 };
  const moves: Point[] = [{ x: 19, y: 29 }, { x: 169, y: 155 }, { x: 750, y: 210 }, end];
  const frames = [];
  editor.beginGesture("Drag glass pill");
  for (const move of moves) {
    editor.commit([
      { op: "set", id: pill, prop: "x", value: move.x },
      { op: "set", id: pill, prop: "y", value: move.y },
    ]);
    // No time for optional tiles. Inspect this frame before the renderer can settle.
    kept.render(actual, pageId, camera, viewport, 1, { budget: 0 });
    frames.push(compare(move));
  }
  editor.endGesture();
  for (let i = 0; kept.pending && i < 20; i++)
    kept.render(actual, pageId, camera, viewport, 1, { exact: true, budget: 8 });
  return { frames, pending: kept.pending, settled: compare(end) };
}
