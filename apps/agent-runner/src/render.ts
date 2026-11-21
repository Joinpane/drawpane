/**
 * The headless engine's renderer (decisions 0021 and 0023): `export_image`
 * with no editor open. A layer is written out by the SVG export and drawn by
 * resvg, with the file's own font files and images:
 *
 * - fonts as the shaper reads them (the static file for a weight, or the
 *   family's variable file), which is what the render parity suite measured
 *   the renderer with;
 * - images from R2 by content hash, with the type and size recorded when
 *   they were uploaded.
 *
 * resvg is WebAssembly, bundled as a module (a Worker can't compile it at
 * run time) with its memory capped (`scripts/cap-wasm.ts`), and each
 * picture is drawn in an instance of its own (`@drawpane/raster`).
 */
import {
  createHeadlessRenderer,
  type FaceFileLoader,
  type HeadlessRenderer,
  type ImageBytesLoader,
  imageCost,
  type TextMeasurer,
} from "@drawpane/editor";
import { cachedFontLoader, type FontBytesLoader, resvgRasteriser } from "@drawpane/raster";
import { mediaKey } from "@drawpane/worker/src/api/media";
// resvg's module with its memory capped, written by scripts/cap-wasm.ts.
import resvgWasm from "../wasm/resvg.wasm";
import type { Env } from "./env";

/** Font files for the renderer, from the measurer's loader: the shaper's faces, not the canvas's. */
export function renderFonts(loadFile: FaceFileLoader): FontBytesLoader {
  return cachedFontLoader(async (face) => {
    const file = await loadFile({
      family: face.family,
      weight: face.weight,
      italic: face.italic,
      ...(face.variable ? { variable: true } : {}),
      ...(face.subset !== undefined ? { subset: face.subset } : {}),
    });
    if (!file) return null;
    return file instanceof ArrayBuffer ? file : file.bytes;
  });
}

/**
 * A file's images by hash: the bytes from R2, the type and size from when
 * its team uploaded them. Another team's images aren't drawn, as they can't
 * be fetched from the file's editor either. One whose `imageCost` is past
 * `room` is "too-large", known from its record (and its object's size)
 * before its bytes are read.
 */
export function renderImages(env: Env, fileId: string): ImageBytesLoader {
  return async (ref, room) => {
    const row = await env.DB.prepare(
      `SELECT m.mime, m.width, m.height, m.bytes FROM media m JOIN files f ON f.team_id = m.team_id
       WHERE f.id = ? AND m.sha = ?`,
    )
      .bind(fileId, ref)
      .first<{ mime: string; width: number; height: number; bytes: number }>();
    if (!row) return null;
    if (imageCost(row.bytes, row.width, row.height) > room) return "too-large";
    const object = await env.FILES.get(mediaKey(ref));
    if (!object) return null;
    if (imageCost(object.size, row.width, row.height) > room) {
      await object.body.cancel();
      return "too-large";
    }
    return {
      bytes: new Uint8Array(await object.arrayBuffer()),
      type: row.mime,
      width: row.width,
      height: row.height,
    };
  };
}

/** A file's renderer: text laid out by `measurer`, drawn with its font files and images. */
export async function headlessRenderer(
  env: Env,
  fileId: string,
  measurer: TextMeasurer,
  loadFile: FaceFileLoader,
): Promise<HeadlessRenderer> {
  return createHeadlessRenderer({
    measurer,
    fonts: renderFonts(loadFile),
    images: renderImages(env, fileId),
    rasteriser: await resvgRasteriser(resvgWasm),
  });
}
