/**
 * Generates fixed-size previews off the main thread using browser-native OffscreenCanvas encoding:
 *   - opaque images -> JPEG q80
 *   - alpha images  -> WebP q80 where the browser supports WebP encoding (feature-detected once),
 *                      falling back to PNG otherwise (e.g. Safari without WebP encode support)
 *
 * Applies a client-side pixel-count gate (`MEDIA_PREVIEW_MAX_PIXELS`) before decoding so huge
 * decompression bombs (such as 16,384 x 16,384 PNGs) are skipped without allocating full bitmaps.
 */
import {
  MEDIA_MAX_SIDE,
  MEDIA_PREVIEW_MAX_PIXELS,
  MEDIA_PREVIEW_MIN_ORIGINAL_BYTES,
  MEDIA_PREVIEW_SIZES,
  type MediaPreviewSize,
  mediaPreviewDimensions,
  mediaPreviewMaxBytes,
  mediaPreviewTiersFor,
  orientedSize,
  sniffImage,
} from "@drawpane/model";

export interface PreviewWorkerRequest {
  readonly id: number;
  readonly blob: Blob;
  readonly sizes?: readonly MediaPreviewSize[];
  readonly quality?: number;
}

export interface GeneratedClientPreview {
  readonly size: MediaPreviewSize;
  readonly width: number;
  readonly height: number;
  readonly blob: Blob;
}

export type PreviewWorkerReply =
  | {
      readonly id: number;
      readonly naturalWidth: number;
      readonly naturalHeight: number;
      readonly previews: readonly GeneratedClientPreview[];
      readonly encodeMs: number;
      readonly skipped?: "unsupported" | "pixel-limit" | "small";
    }
  | { readonly id: number; readonly error: string };

const DEFAULT_QUALITY = 0.8;
const HEADER_SNIFF_BYTES = 65_536;

let webpEncodeSupport: Promise<boolean> | null = null;

/** Test helper: resets cached WebP encoder capability probe. */
export function resetWebpEncodeCacheForTest(): void {
  webpEncodeSupport = null;
}

function supportsWebpEncode(): Promise<boolean> {
  if (webpEncodeSupport) return webpEncodeSupport;
  webpEncodeSupport = (async () => {
    if (typeof OffscreenCanvas === "undefined") return false;
    try {
      const probe = new OffscreenCanvas(2, 2);
      const ctx = probe.getContext("2d");
      if (!ctx) return false;
      ctx.fillStyle = "rgba(10, 20, 30, 0.5)";
      ctx.fillRect(0, 0, 2, 2);
      const blob = await probe.convertToBlob({ type: "image/webp", quality: DEFAULT_QUALITY });
      probe.width = 0;
      probe.height = 0;
      return blob.type === "image/webp" && blob.size > 0;
    } catch {
      return false;
    }
  })();
  return webpEncodeSupport;
}

function hasTransparentPixel(
  ctx: OffscreenCanvasRenderingContext2D,
  w: number,
  h: number,
): boolean {
  const data = ctx.getImageData(0, 0, w, h).data;
  for (let i = 3; i < data.length; i += 4) {
    if ((data[i] ?? 255) < 255) return true;
  }
  return false;
}

async function encodeCanvas(
  canvas: OffscreenCanvas,
  hasAlpha: boolean,
  quality: number,
): Promise<Blob> {
  if (!hasAlpha) {
    return canvas.convertToBlob({ type: "image/jpeg", quality });
  }
  if (await supportsWebpEncode()) {
    const webp = await canvas.convertToBlob({ type: "image/webp", quality });
    if (webp.type === "image/webp" && webp.size > 0) return webp;
  }
  return canvas.convertToBlob({ type: "image/png" });
}

export async function generatePreviews(request: PreviewWorkerRequest): Promise<PreviewWorkerReply> {
  const t0 = performance.now();
  const { id, blob, quality = DEFAULT_QUALITY } = request;
  const head = new Uint8Array(await blob.slice(0, HEADER_SNIFF_BYTES).arrayBuffer());
  const sniffed = sniffImage(head);
  if (!sniffed) {
    return {
      id,
      naturalWidth: 0,
      naturalHeight: 0,
      previews: [],
      encodeMs: performance.now() - t0,
      skipped: "unsupported",
    };
  }
  if (
    sniffed.width * sniffed.height > MEDIA_PREVIEW_MAX_PIXELS ||
    sniffed.width > MEDIA_MAX_SIDE ||
    sniffed.height > MEDIA_MAX_SIDE
  ) {
    return {
      id,
      naturalWidth: sniffed.width,
      naturalHeight: sniffed.height,
      previews: [],
      encodeMs: performance.now() - t0,
      skipped: "pixel-limit",
    };
  }
  let natural = orientedSize(sniffed, head);
  const longest = Math.max(natural.width, natural.height);
  if (longest <= MEDIA_PREVIEW_SIZES[0] && blob.size <= MEDIA_PREVIEW_MIN_ORIGINAL_BYTES) {
    return {
      id,
      naturalWidth: natural.width,
      naturalHeight: natural.height,
      previews: [],
      encodeMs: performance.now() - t0,
      skipped: "small",
    };
  }

  const tiers = [...(request.sizes ?? mediaPreviewTiersFor(natural.width, natural.height))].sort(
    (a, b) => b - a,
  );
  const topTier = tiers[0];
  if (!topTier) {
    return {
      id,
      naturalWidth: natural.width,
      naturalHeight: natural.height,
      previews: [],
      encodeMs: performance.now() - t0,
      skipped: "small",
    };
  }

  const topTarget = mediaPreviewDimensions(natural, topTier);
  const resizeOpts: ImageBitmapOptions | undefined =
    longest > topTier
      ? natural.width >= natural.height
        ? { resizeWidth: topTarget.width, resizeQuality: "high" }
        : { resizeHeight: topTarget.height, resizeQuality: "high" }
      : undefined;

  let bitmap: ImageBitmap | null = null;
  let canvas: OffscreenCanvas | null = null;
  try {
    bitmap = resizeOpts ? await createImageBitmap(blob, resizeOpts) : await createImageBitmap(blob);
    // Align natural orientation with the browser's EXIF-decoded bitmap in case EXIF sat past 64 KB.
    if (
      (bitmap.width > bitmap.height && natural.width < natural.height) ||
      (bitmap.width < bitmap.height && natural.width > natural.height)
    ) {
      natural = { width: natural.height, height: natural.width };
    }
    const topDims = mediaPreviewDimensions(natural, topTier);
    const topW = topDims.width;
    const topH = topDims.height;
    canvas = new OffscreenCanvas(topW, topH);
    const ctx = canvas.getContext("2d", { willReadFrequently: sniffed.mime !== "image/jpeg" });
    if (!ctx) throw new Error("OffscreenCanvas 2D context unavailable");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, topW, topH);

    const hasAlpha = sniffed.mime === "image/jpeg" ? false : hasTransparentPixel(ctx, topW, topH);
    const previews: GeneratedClientPreview[] = [];

    for (const tier of tiers) {
      const dims =
        tier === topTier ? { width: topW, height: topH } : mediaPreviewDimensions(natural, tier);
      let outBlob: Blob;
      if (dims.width === topW && dims.height === topH) {
        outBlob = await encodeCanvas(canvas, hasAlpha, quality);
      } else {
        const sub = new OffscreenCanvas(dims.width, dims.height);
        try {
          const sctx = sub.getContext("2d");
          if (!sctx) throw new Error("OffscreenCanvas 2D context unavailable");
          sctx.imageSmoothingEnabled = true;
          sctx.imageSmoothingQuality = "high";
          sctx.drawImage(canvas, 0, 0, dims.width, dims.height);
          outBlob = await encodeCanvas(sub, hasAlpha, quality);
        } finally {
          sub.width = 0;
          sub.height = 0;
        }
      }
      if (
        outBlob.size > 0 &&
        outBlob.size < blob.size &&
        outBlob.size <= mediaPreviewMaxBytes(tier)
      ) {
        previews.push({ size: tier, width: dims.width, height: dims.height, blob: outBlob });
      }
    }

    return {
      id,
      naturalWidth: natural.width,
      naturalHeight: natural.height,
      previews,
      encodeMs: performance.now() - t0,
    };
  } finally {
    bitmap?.close();
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
  }
}

if (typeof self !== "undefined") {
  const scope = self as unknown as {
    onmessage: ((event: MessageEvent<PreviewWorkerRequest>) => void) | null;
    postMessage(message: PreviewWorkerReply): void;
  };

  scope.onmessage = ({ data }) => {
    void generatePreviews(data).then(
      (reply) => scope.postMessage(reply),
      (error: unknown) => scope.postMessage({ id: data.id, error: String(error) }),
    );
  };
}
