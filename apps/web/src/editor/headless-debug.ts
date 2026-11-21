/** Scene-to-PNG parity through the CPU engine and the canvas export. */
import {
  base64,
  CanvasRenderer,
  createHeadlessRenderer,
  type Editor,
  exportRaster,
  type ImageBytesLoader,
  measuredFaces,
  mediaUrl,
} from "@drawpane/editor";
import { RenderEngine } from "@drawpane/engine";
import { loadBrowserEngine } from "@drawpane/engine/browser";
import { imagesFor } from "./media";
import { shaper } from "./shaping";

/** Images by hash, as the Worker reads them from R2. */
const imageBytes: ImageBytesLoader = async (ref) => {
  const response = await fetch(mediaUrl(ref), { credentials: "same-origin" });
  if (!response.ok) return null;
  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob);
  const size = { width: bitmap.width, height: bitmap.height };
  bitmap.close();
  return { bytes: new Uint8Array(await blob.arrayBuffer()), type: blob.type, ...size };
};

export function headlessDebug(editor: Editor) {
  const headless = createHeadlessRenderer({
    measurer: editor.measurer,
    images: imageBytes,
    async prepareFonts(nodes) {
      await Promise.all(measuredFaces(nodes, editor.measurer).map((face) => shaper.load(face)));
    },
    waitForFaces: (keys) => Promise.all(keys.map((key) => shaper.waitForFace(key))),
    async decodeImage(file, target) {
      const bitmap = await createImageBitmap(
        new Blob([new Uint8Array(file.bytes)], { type: file.type }),
      );
      try {
        const surface = new OffscreenCanvas(target.width, target.height);
        const ctx = surface.getContext("2d", { willReadFrequently: true });
        if (!ctx) return null;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(bitmap, 0, 0, target.width, target.height);
        return new Uint8Array(ctx.getImageData(0, 0, target.width, target.height).data.buffer);
      } finally {
        bitmap.close();
      }
    },
    async acquireEngine() {
      return { engine: new RenderEngine(await loadBrowserEngine()), release() {} };
    },
  });
  return {
    /** The layer drawn headlessly: a PNG (base64), and its asset notes. */
    async headless(id: string, scale: number, background: string | null) {
      const { png, ...metadata } = await headless.renderPng(editor.doc, id, { scale, background });
      return { ...metadata, png: base64(png) };
    },
    /** The layer as the open editor exports it with the canvas renderer. */
    async canvas(id: string, scale: number, background: string | null) {
      const renderer = new CanvasRenderer(editor.scene, editor.measurer, {
        images: imagesFor(editor),
      });
      const blob = await exportRaster(renderer, editor.scene, [id], {
        format: "png",
        scale,
        background,
      });
      return base64(new Uint8Array(await blob.arrayBuffer()));
    },
  };
}
