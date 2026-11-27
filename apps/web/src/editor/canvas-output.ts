import {
  budgetExportImages,
  CanvasRenderer,
  chooseDrawnImageSize,
  collectExportImageUses,
  DisplayListBuilder,
  decodeImageAtSize,
  type Editor,
  type EncodedImage,
  type EncodedImageOptions,
  ExportError,
  type ExportImageCandidate,
  ImageCache,
  type ImageView,
  imageBlobSize,
} from "@drawpane/editor";
import { type MediaPreviewSize, mediaPreviewDimensions } from "@drawpane/model";
import { imagesFor } from "./media";

const OUTPUT_IMAGE_SIDE = 4096;
const SOURCE_BYTES = 24 * 1024 * 1024;
const SOURCE_REQUESTS = 8;
const THUMBNAIL_BYTES = 8 * 1024 * 1024;

interface CanvasOutputOptions {
  readonly ids: readonly string[];
  readonly scale: number;
  readonly context?: boolean;
  readonly signal?: AbortSignal;
  readonly thumbnail?: boolean;
  readonly onImageCounts?: (reduced: number, omitted: number) => void;
}

type Size = ExportImageCandidate["natural"];
type Uses = ExportImageCandidate["uses"];

const bytesOf = (size: Size) => size.width * size.height * 4;
const covers = (available: Size, needed: Size) =>
  available.width >= needed.width && available.height >= needed.height;

function naturalOf(image: ImageView): Size {
  return { width: image.naturalWidth, height: image.naturalHeight };
}

interface ThumbnailImages {
  readonly images: Map<string, ImageView>;
  bytes: number;
}

const retained = new WeakMap<ImageCache, ThumbnailImages>();

function keepThumbnail(pool: ThumbnailImages, ref: string, image: ImageView): void {
  const previous = pool.images.get(ref);
  if (previous && covers(previous.bitmap, image.bitmap)) {
    image.bitmap.close();
    return;
  }
  if (previous) {
    pool.bytes -= bytesOf(previous.bitmap);
    previous.bitmap.close();
    pool.images.delete(ref);
  }
  pool.images.set(ref, image);
  pool.bytes += bytesOf(image.bitmap);
  for (const [old, { bitmap }] of pool.images) {
    if (pool.bytes <= THUMBNAIL_BYTES) break;
    pool.bytes -= bytesOf(bitmap);
    pool.images.delete(old);
    bitmap.close();
  }
}

function previewTier(uses: Uses): MediaPreviewSize {
  return uses.some(
    ({ paint, box, scale }) =>
      Math.max(
        (box.width * scale.width) / (paint.crop?.width || 1),
        (box.height * scale.height) / (paint.crop?.height || 1),
      ) > 256,
  )
    ? 1024
    : 256;
}

/** Overlap requests, but admit bodies in draw order so a large one cannot block its predecessor. */
async function* stageSources<T, R>(
  items: readonly T[],
  signal: AbortSignal,
  load: (item: T, options: EncodedImageOptions, signal: AbortSignal) => Promise<R>,
) {
  let staged = 0;
  let wake: (() => void) | undefined;
  const controller = new AbortController();
  const abort = AbortSignal.any([signal, controller.signal]);
  const notify = () => wake?.();
  abort.addEventListener("abort", notify);
  const pending = items[Symbol.iterator]();
  const jobs: { item: T; result: Promise<R | null>; release: () => void }[] = [];
  let admitted = Promise.resolve();
  const fill = () => {
    while (jobs.length < SOURCE_REQUESTS) {
      const next = pending.next();
      if (next.done) break;
      const item = next.value;
      const previous = admitted;
      let advance: () => void = () => {};
      admitted = new Promise<void>((resolve) => {
        advance = resolve;
      });
      let reserved = 0;
      const result = load(
        item,
        {
          retryTransient: true,
          async beforeRead(length) {
            const bytes = length ?? SOURCE_BYTES;
            await previous;
            while (!abort.aborted && staged > 0 && staged + bytes > SOURCE_BYTES) {
              await new Promise<void>((resolve) => {
                wake = resolve;
              });
            }
            abort.throwIfAborted();
            staged += bytes;
            reserved = bytes;
            advance();
          },
        },
        abort,
      )
        .catch(() => null)
        .finally(async () => {
          await previous;
          advance();
        });
      jobs.push({
        item,
        result,
        release() {
          staged -= reserved;
          notify();
        },
      });
    }
  };
  try {
    fill();
    for (let job = jobs.shift(); job; job = jobs.shift()) {
      abort.throwIfAborted();
      yield { item: job.item, source: await job.result };
      job.release();
      fill();
    }
  } finally {
    controller.abort();
    abort.removeEventListener("abort", notify);
  }
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

  const { ids, scale, context, signal, thumbnail } = options;
  const abort = signal ?? new AbortController().signal;
  abort.throwIfAborted();
  const plan = new DisplayListBuilder(editor.scene, editor.measurer).planLayers(ids, {
    ...(context === undefined ? {} : { context }),
  });
  const uses = collectExportImageUses(editor.scene, plan.visibleNodes(), scale);
  const budget = display.decodedBudget;
  const images = new ImageCache({
    maxBytes: budget,
    mipmaps: false,
    load: async () => {
      throw new Error("Image unavailable in the output");
    },
  });
  const prepared = new Map<string, ExportImageCandidate>();
  const reduced = new Set<string>();
  let omitted = 0;
  let pool = thumbnail ? retained.get(display) : undefined;
  if (thumbnail && !pool) {
    pool = { images: new Map(), bytes: 0 };
    retained.set(display, pool);
  }
  // A snapshot needs its full set while painting masks and backdrop effects.
  const release = () => {
    if (pool) {
      for (const ref of prepared.keys()) {
        const image = images.take(ref);
        if (image) keepThumbnail(pool, ref, image);
      }
    }
    images.clear();
  };

  const load = async (
    [ref, draws]: [string, Uses],
    fetchOptions: EncodedImageOptions,
    signal: AbortSignal,
  ): Promise<{ natural: Size; encoded?: EncodedImage; sourceSize?: Size } | null> => {
    const tier = thumbnail ? previewTier(draws) : OUTPUT_IMAGE_SIDE;
    const saved = pool?.images.get(ref);
    const natural = saved ? naturalOf(saved) : display.natural(ref);
    if (natural) {
      const needed = chooseDrawnImageSize(natural, draws, tier);
      const cached = saved ?? display.peek(ref);
      if (cached && covers(cached.bitmap, needed)) return { natural };
    }
    const encoded = await display.encoded(ref, signal, {
      ...fetchOptions,
      ...(thumbnail ? { preview: previewTier(draws) } : {}),
    });
    const sourceSize = await imageBlobSize(encoded.blob);
    if (!sourceSize) return null;
    const original = encoded.preview ? (encoded.size ?? natural ?? sourceSize) : sourceSize;
    return { natural: original, encoded, sourceSize };
  };

  try {
    for await (const {
      item: [ref, draws],
      source,
    } of stageSources([...uses], abort, load)) {
      abort.throwIfAborted();
      if (!source) {
        omitted++;
        continue;
      }
      const { natural } = source;
      const candidate = { ref, natural, uses: draws };
      const desired = chooseDrawnImageSize(natural, draws, Infinity);
      const maxSide = thumbnail ? previewTier(draws) : OUTPUT_IMAGE_SIDE;
      let target = mediaPreviewDimensions(desired, maxSide);
      if (source.sourceSize && source.encoded?.preview && !covers(source.sourceSize, target)) {
        target = mediaPreviewDimensions(
          natural,
          Math.max(source.sourceSize.width, source.sourceSize.height),
        );
        target = {
          width: Math.min(target.width, source.sourceSize.width),
          height: Math.min(target.height, source.sourceSize.height),
        };
      }

      if (images.bytes + bytesOf(target) > budget * 0.75) {
        const fits = budgetExportImages([...prepared.values(), candidate], budget, {
          exactDrawn: true,
          maxSide: thumbnail ? 1024 : OUTPUT_IMAGE_SIDE,
        });
        const fit = fits.get(ref);
        if (!fit) {
          omitted++;
          continue;
        }
        if (!covers(fit.target, target))
          target = mediaPreviewDimensions(target, Math.max(fit.target.width, fit.target.height));
        for (const [prior, priorCandidate] of prepared) {
          const previous = images.peek(prior);
          const fit = fits.get(prior);
          if (!previous || !fit || covers(fit.target, previous.bitmap)) continue;
          const bitmap = await copyAt(previous.bitmap, fit.target, "low");
          images.put(prior, {
            bitmap,
            naturalWidth: priorCandidate.natural.width,
            naturalHeight: priorCandidate.natural.height,
          });
          reduced.add(prior);
        }
      }
      let bitmap: ImageBitmap;
      try {
        const saved = pool?.images.get(ref);
        const cached = display.peek(ref);
        if (
          pool &&
          saved &&
          covers(saved.bitmap, target) &&
          bytesOf(saved.bitmap) + images.bytes <= budget
        ) {
          pool.images.delete(ref);
          pool.bytes -= bytesOf(saved.bitmap);
          bitmap = saved.bitmap;
        } else if (cached && covers(cached.bitmap, target)) {
          bitmap = await copyAt(cached.bitmap, target, thumbnail ? "low" : "high");
        } else {
          const encoded =
            source.encoded ??
            (await display.encoded(ref, abort, {
              retryTransient: true,
              ...(thumbnail ? { preview: previewTier(draws) } : {}),
            }));
          const encodedSize = source.sourceSize ?? (await imageBlobSize(encoded.blob));
          if (!encodedSize) {
            omitted++;
            continue;
          }
          if (encoded.preview && !covers(encodedSize, target))
            target = mediaPreviewDimensions(
              target,
              Math.max(encodedSize.width, encodedSize.height),
            );
          if (abort.aborted) abort.throwIfAborted();
          bitmap = (
            await decodeImageAtSize(encoded.blob, encodedSize, target, thumbnail ? "low" : "medium")
          ).bitmap;
        }
      } catch {
        abort.throwIfAborted();
        omitted++;
        continue;
      }
      if (
        Math.max(bitmap.width, bitmap.height) > OUTPUT_IMAGE_SIDE ||
        images.bytes + bytesOf(bitmap) > budget
      ) {
        bitmap.close();
        throw new ExportError("This output exceeds the mobile image budget.", "limit");
      }
      if (!covers(bitmap, desired)) reduced.add(ref);
      images.put(ref, { bitmap, naturalWidth: natural.width, naturalHeight: natural.height });
      prepared.set(ref, candidate);
    }
    abort.throwIfAborted();
    options.onImageCounts?.(reduced.size, omitted);
    return await draw(new CanvasRenderer(editor.scene, editor.measurer, { images }), release);
  } finally {
    release();
  }
}

function copyAt(bitmap: ImageBitmap, size: Size, resizeQuality: ResizeQuality) {
  return createImageBitmap(bitmap, {
    resizeWidth: size.width,
    resizeHeight: size.height,
    resizeQuality,
  });
}
