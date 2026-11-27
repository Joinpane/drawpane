import {
  CanvasRenderer,
  chooseDrawnImageSize,
  collectExportImageUses,
  DisplayListBuilder,
  decodeBoundedImage,
  type Editor,
  ImageCache,
} from "@drawpane/editor";
import { imagesFor } from "./media";

interface CanvasOutputOptions {
  readonly ids: readonly string[];
  readonly scale: number;
  readonly context?: boolean;
  readonly signal?: AbortSignal;
}

/** Offscreen outputs on mobile use original bytes at the resolution the output needs. */
export async function withCanvasOutputRenderer<T>(
  editor: Editor,
  options: CanvasOutputOptions,
  draw: (renderer: CanvasRenderer) => Promise<T>,
): Promise<T> {
  const display = imagesFor(editor);
  if (!display.boundedDisplay) {
    return draw(new CanvasRenderer(editor.scene, editor.measurer, { images: display }));
  }

  const { ids, scale, context, signal } = options;
  signal?.throwIfAborted();
  const plan = new DisplayListBuilder(editor.scene, editor.measurer).planLayers(ids, {
    ...(context === undefined ? {} : { context }),
  });
  const uses = collectExportImageUses(editor.scene, plan.visibleNodes(), scale);
  const images = new ImageCache({
    maxBytes: Infinity,
    maxConcurrentLoads: 2,
    async load(ref, loadSignal) {
      const combined = signal ? AbortSignal.any([signal, loadSignal]) : loadSignal;
      const { blob } = await display.encoded(ref, combined);
      combined.throwIfAborted();
      return decodeBoundedImage(blob, (natural) => {
        const draws = uses.get(ref);
        if (!draws) return Infinity;
        const { width, height } = chooseDrawnImageSize(natural, draws, Infinity);
        return Math.max(width, height);
      });
    },
  });
  try {
    await images.ready(uses.keys());
    signal?.throwIfAborted();
    return await draw(new CanvasRenderer(editor.scene, editor.measurer, { images }));
  } finally {
    images.clear();
  }
}
