/**
 * Server-side image preview generation (bounded 32 MiB Rust/WASM module):
 * decodes PNG, JPEG, GIF and WebP, applies EXIF orientation, downsamples to
 * fixed long-side tiers (`MEDIA_PREVIEW_SIZES`), and encodes lossy WebP.
 *
 * Uses a self-contained WASM module rather than Cloudflare Images bindings or
 * `cf.image` so local `wrangler dev`, `vitest-pool-workers` and zero-config
 * self-hosted Cloudflare deployments all run the exact same code path with no
 * external service activation or transformation quotas. Any failure or budget
 * refusal falls back cleanly to serving the original bytes.
 */
import { imagePreviewer } from "@drawpane/engine/preview";
import previewWasm from "@drawpane/engine/preview.wasm";
import * as previewGlue from "@drawpane/engine/preview-glue";
import {
  MEDIA_PREVIEW_SIZES,
  type MediaPreviewSize,
  orientedSize,
  sniffImage,
} from "@drawpane/model";

const previewer = imagePreviewer(previewGlue, previewWasm);

/** Small images at or below the requested preview side are already compact as originals. */
export const PREVIEW_MIN_ORIGINAL_BYTES = 4096;
const PREVIEW_QUALITY = 80;

export const mediaPreviewKey = (sha: string, size: MediaPreviewSize) =>
  `media/previews/${sha}/${size}.webp`;

export interface GeneratedPreview {
  readonly bytes: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly naturalWidth: number;
  readonly naturalHeight: number;
}

export type PreviewGenerator = (
  file: { readonly width: number; readonly height: number; readonly bytes: Uint8Array },
  size: MediaPreviewSize,
) => GeneratedPreview | null;

let overrideGenerator: PreviewGenerator | null = null;

/** Test hook: replaces the WASM preview generator (for deterministic fallback tests). */
export function setPreviewGeneratorForTest(fn: PreviewGenerator | null): void {
  overrideGenerator = fn;
}

/** Generates a WebP preview capped at `size` px, or null when fallback to original is better. */
export function generateMediaPreview(
  file: { readonly width: number; readonly height: number; readonly bytes: Uint8Array },
  size: MediaPreviewSize,
): GeneratedPreview | null {
  if (overrideGenerator) return overrideGenerator(file, size);
  const natural = orientedSize(file, file.bytes);
  const longest = Math.max(natural.width, natural.height);
  if (longest <= size && file.bytes.byteLength <= PREVIEW_MIN_ORIGINAL_BYTES) return null;
  const webp = previewer.generate(file, size, { quality: PREVIEW_QUALITY });
  if (!webp || webp.byteLength >= file.bytes.byteLength) return null;
  const info = sniffImage(webp);
  if (info?.mime !== "image/webp") return null;
  return {
    bytes: webp,
    width: info.width,
    height: info.height,
    naturalWidth: natural.width,
    naturalHeight: natural.height,
  };
}

/** Preview tiers worth storing for an image of `width` x `height` (no duplicate upscaled tiers). */
export function previewTiersFor(width: number, height: number): MediaPreviewSize[] {
  const longest = Math.max(width, height);
  const smallest = MEDIA_PREVIEW_SIZES[0];
  return MEDIA_PREVIEW_SIZES.filter((size) => size === smallest || longest > smallest);
}

/** Effective stored preview bucket for a request of `requested` on an image of `width` x `height`. */
export function previewBucketFor(
  width: number,
  height: number,
  requested: MediaPreviewSize,
): MediaPreviewSize {
  const longest = Math.max(width, height);
  for (const size of MEDIA_PREVIEW_SIZES) {
    if (size >= requested || longest <= size) return size;
  }
  return requested;
}
