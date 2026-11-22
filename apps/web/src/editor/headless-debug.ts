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
  thumbnailLayout,
} from "@drawpane/editor";
import { RenderEngine } from "@drawpane/engine";
import { loadBrowserEngine } from "@drawpane/engine/browser";
import { renderEngineRasterExportWithMeta } from "./engine-snapshot";
import { renderExportWithMeta } from "./exporting";
import { imagesFor } from "./media";
import { shaper } from "./shaping";
import { renderPageThumbnail } from "./thumbnail";

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
    /** The layer as the browser exports it on the engine snapshot service: a PNG (base64). */
    async browser(
      id: string,
      scale: number,
      background: string | null,
      options?: { readonly imageBudget?: number },
    ) {
      const { blob } = await renderEngineRasterExportWithMeta(editor, [id], {
        format: "png",
        scale,
        background,
        ...(options?.imageBudget !== undefined ? { imageBudget: options.imageBudget } : {}),
        images: imagesFor(editor),
        priority: "high",
      });
      return base64(new Uint8Array(await blob.arrayBuffer()));
    },
    /** The layer via the product export entry point (following the renderer switch + fallbacks). */
    async exportLayer(
      ids: readonly string[],
      options: {
        readonly format: "png" | "jpeg" | "webp";
        readonly scale: 1 | 2 | 3;
        readonly background?: string | null;
        readonly imageBudget?: number;
      },
    ) {
      const { blob, reducedImages, omittedImages } = await renderExportWithMeta(
        editor,
        ids,
        options,
      );
      const bytes = new Uint8Array(await blob.arrayBuffer());
      return {
        data: base64(bytes),
        bytes: bytes.byteLength,
        type: blob.type,
        reducedImages,
        omittedImages,
      };
    },
    /** The page's dashboard thumbnail (following the switch unless `forceEngine` is set). */
    async thumbnail(options?: {
      pageId?: string;
      maxWidth?: number;
      maxHeight?: number;
      format?: "webp" | "png";
      quality?: number;
      forceEngine?: boolean;
    }) {
      const pageId = options?.pageId ?? editor.doc.pageIds()[0];
      if (!pageId) return null;
      const layout = thumbnailLayout(editor.scene, pageId, options);
      const blob = await renderPageThumbnail(editor, { ...options, pageId, priority: "high" });
      if (!blob || !layout) return null;
      const bytes = new Uint8Array(await blob.arrayBuffer());
      return {
        data: base64(bytes),
        png: base64(bytes),
        bytes: bytes.byteLength,
        type: blob.type,
        layout,
      };
    },
  };
}
