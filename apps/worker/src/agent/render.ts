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
 * run time) and set up once per isolate.
 */
import {
  createHeadlessRenderer,
  type FaceFileLoader,
  type HeadlessRenderer,
  type ImageBytesLoader,
  type TextMeasurer,
} from "@drawpane/editor";
import { cachedFontLoader, type FontBytesLoader, resvgRasteriser } from "@drawpane/raster";
import resvgWasm from "@resvg/resvg-wasm/index_bg.wasm";
import { mediaKey } from "../api/media";
import type { Env } from "../env";

/** Font files for the renderer, from the measurer's loader: the shaper's faces, not the canvas's. */
export function renderFonts(loadFile: FaceFileLoader): FontBytesLoader {
  return cachedFontLoader(async (face) => {
    const file = await loadFile({
      family: face.family,
      weight: face.weight,
      italic: face.italic,
      ...(face.variable ? { variable: true } : {}),
    });
    if (!file) return null;
    return file instanceof ArrayBuffer ? file : file.bytes;
  });
}

/**
 * A file's images by hash: the bytes from R2, the type and size from when
 * its team uploaded them. Another team's images aren't drawn, as they can't
 * be fetched from the file's editor either.
 */
export function renderImages(env: Env, fileId: string): ImageBytesLoader {
  return async (ref) => {
    const row = await env.DB.prepare(
      `SELECT m.mime, m.width, m.height FROM media m JOIN files f ON f.team_id = m.team_id
       WHERE f.id = ? AND m.sha = ?`,
    )
      .bind(fileId, ref)
      .first<{ mime: string; width: number; height: number }>();
    if (!row) return null;
    const object = await env.FILES.get(mediaKey(ref));
    if (!object) return null;
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
