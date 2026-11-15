/**
 * A layer rendered both ways an agent's `export_image` can be: by the
 * canvas, as the open editor exports it, and by the headless renderer
 * (decision 0023), as the Worker does with no editor open. For the render
 * parity suite (e2e/parity/headless.spec.ts) and for debugging; attached to
 * the debug handle only (`drawpaneHeadless`).
 *
 * The headless side runs here with this tab's text layout, font files and
 * images, and hands its SVG to `window.drawpaneRasterise`, which the test
 * provides: resvg in Node, the same build the Worker imports. Text layout is
 * compared separately (canvas against HarfBuzz), so what this measures is
 * the SVG export and the rasteriser.
 */
import {
  CanvasRenderer,
  createHeadlessRenderer,
  type Editor,
  exportRaster,
  type ImageBytesLoader,
  mediaUrl,
} from "@drawpane/editor";
import { cachedFontLoader, type Rasteriser } from "@drawpane/raster";
import { imagesFor } from "./media";
import { fontBytes } from "./shaping";

/** A font file as the test's rasteriser takes it: sent once, named by `id` after that. */
interface FontRef {
  readonly id: number;
  readonly data?: string;
}

type RemoteRasterise = (
  svg: string,
  options: {
    scale: number;
    fonts: FontRef[];
    fallbackFamily: string | null;
    background: string | null;
  },
) => Promise<{ png: string; width: number; height: number }>;

const toBase64 = (bytes: Uint8Array) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const fromBase64 = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/** Images by hash, as the Worker reads them from R2: their bytes, type and size. */
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
  // Each font file crosses to the test once; after that, by number.
  const sent = new WeakMap<ArrayBufferLike, number>();
  let count = 0;
  const remote: Rasteriser = {
    async rasterise(svg, options) {
      const rasterise = (window as unknown as { drawpaneRasterise?: RemoteRasterise })
        .drawpaneRasterise;
      if (!rasterise) throw new Error("No rasteriser: the test provides drawpaneRasterise.");
      const fonts = options.fonts.map((f): FontRef => {
        const known = sent.get(f.buffer);
        if (known !== undefined) return { id: known };
        const id = ++count;
        sent.set(f.buffer, id);
        return { id, data: toBase64(f) };
      });
      const out = await rasterise(svg, {
        scale: options.scale,
        fonts,
        fallbackFamily: options.fallbackFamily ?? null,
        background: options.background ?? null,
      });
      return { ...out, png: fromBase64(out.png) };
    },
  };
  const headless = createHeadlessRenderer({
    measurer: editor.measurer,
    fonts: cachedFontLoader(fontBytes),
    images: imageBytes,
    rasteriser: remote,
  });
  return {
    /** The layer drawn headlessly: a PNG (base64), and what it couldn't draw exactly. */
    async headless(id: string, scale: number, background: string | null) {
      const out = await headless.renderPng(editor.doc, id, { scale, background });
      return {
        png: toBase64(out.png),
        width: out.width,
        height: out.height,
        approximate: out.approximate,
        missingFonts: out.missingFonts,
        missingImages: out.missingImages,
      };
    },
    /** The layer as the open editor exports it, with the canvas renderer: a PNG (base64). */
    async canvas(id: string, scale: number, background: string | null) {
      const renderer = new CanvasRenderer(editor.scene, editor.measurer, {
        images: imagesFor(editor),
      });
      const blob = await exportRaster(renderer, editor.scene, [id], {
        format: "png",
        scale,
        background,
      });
      return toBase64(new Uint8Array(await blob.arrayBuffer()));
    },
  };
}
