import {
  budgetExportImages,
  CanvasRenderer,
  chooseDrawnImageSize,
  collectExportImageUses,
  DisplayListBuilder,
  decodeImageAtSize,
  type Editor,
  ExportError,
  type ExportImageCandidate,
  ImageCache,
  imageBlobSize,
} from "@drawpane/editor";
import { imagesFor } from "./media";

const OUTPUT_IMAGE_SIDE = 4096;
const SOURCE_BYTES = 24 * 1024 * 1024;

interface CanvasOutputOptions {
  readonly ids: readonly string[];
  readonly scale: number;
  readonly context?: boolean;
  readonly signal?: AbortSignal;
  readonly onImageReductions?: (count: number) => void;
}

/** Offscreen outputs on mobile have one temporary, size-planned image set per paint. */
export async function withCanvasOutputRenderer<T>(
  editor: Editor,
  options: CanvasOutputOptions,
  draw: (renderer: CanvasRenderer, releaseImages?: () => void) => Promise<T>,
): Promise<T> {
  const display = imagesFor(editor);
  if (!display.boundedDisplay) {
    return draw(new CanvasRenderer(editor.scene, editor.measurer, { images: display }));
  }

  const { ids, scale, context, signal } = options;
  const abort = signal ?? new AbortController().signal;
  abort.throwIfAborted();
  const plan = new DisplayListBuilder(editor.scene, editor.measurer).planLayers(ids, {
    ...(context === undefined ? {} : { context }),
  });
  const uses = collectExportImageUses(editor.scene, plan.visibleNodes(), scale);
  const candidates: ExportImageCandidate[] = [];
  const sources = new Map<string, Blob>();
  let sourceBytes = 0;
  for (const [ref, draws] of uses) {
    let natural = display.natural(ref);
    if (!natural) {
      try {
        const { blob } = await display.encoded(ref, abort);
        natural = await imageBlobSize(blob);
        if (natural && sourceBytes + blob.size <= SOURCE_BYTES) {
          sources.set(ref, blob);
          sourceBytes += blob.size;
        }
      } catch {
        abort.throwIfAborted();
      }
    }
    if (natural) candidates.push({ ref, natural, uses: draws });
  }

  const targets = budgetExportImages(candidates, display.decodedBudget, {
    exactDrawn: true,
    maxSide: OUTPUT_IMAGE_SIDE,
  });
  const images = new ImageCache({
    maxBytes: display.decodedBudget,
    mipmaps: false,
    // Only images that the paint plan uses are admitted to the temporary cache.
    load: async () => {
      throw new Error("Image unavailable in the output");
    },
  });
  const release = () => images.clear();
  let reduced = 0;
  try {
    // The synchronous Canvas paint needs its whole working set, especially for masks and
    // backdrop effects. Admit one bitmap at a time, then release the set before encoding.
    for (const { ref, natural, uses } of candidates) {
      abort.throwIfAborted();
      const fit = targets.get(ref);
      if (!fit)
        throw new ExportError("This output has too many images for the mobile renderer.", "limit");
      const { target } = fit;
      const desired = chooseDrawnImageSize(natural, uses, Infinity);
      if (target.width < desired.width || target.height < desired.height) reduced++;
      const cached = display.peek(ref);
      let bitmap: ImageBitmap;
      try {
        if (
          cached &&
          cached.bitmap.width >= target.width &&
          cached.bitmap.height >= target.height
        ) {
          bitmap = await createImageBitmap(cached.bitmap, {
            resizeWidth: target.width,
            resizeHeight: target.height,
            resizeQuality: "high",
          });
        } else {
          const blob = sources.get(ref) ?? (await display.encoded(ref, abort)).blob;
          bitmap = (await decodeImageAtSize(blob, natural, target)).bitmap;
        }
      } catch {
        abort.throwIfAborted();
        continue;
      } finally {
        sources.delete(ref);
      }
      if (
        Math.max(bitmap.width, bitmap.height) > OUTPUT_IMAGE_SIDE ||
        images.bytes + bitmap.width * bitmap.height * 4 > display.decodedBudget
      ) {
        bitmap.close();
        throw new ExportError("This output exceeds the mobile image budget.", "limit");
      }
      images.put(ref, { bitmap, naturalWidth: natural.width, naturalHeight: natural.height });
    }
    abort.throwIfAborted();
    options.onImageReductions?.(reduced);
    return await draw(new CanvasRenderer(editor.scene, editor.measurer, { images }), release);
  } finally {
    release();
  }
}
