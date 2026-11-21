import {
  createHeadlessRenderer,
  HeadlessRenderError,
  type HeadlessRenderer,
  type ImageBytesLoader,
} from "@drawpane/editor";
import { ErrorCode, loadEngineSync, RenderEngine } from "@drawpane/engine";
import { imageDecoder } from "@drawpane/engine/decode";
import decoderWasm from "@drawpane/engine/decoder.wasm";
import * as decoder from "@drawpane/engine/decoder-glue";
import wasm from "@drawpane/engine/worker.wasm";
import * as glue from "@drawpane/engine/worker-glue";
import { mediaKey } from "@drawpane/worker/src/api/media";
import type { Env } from "./env";
import type { HeadlessMeasurer } from "./measurer";

const images = imageDecoder(decoder, decoderWasm);

let renderFinished: Promise<void> = Promise.resolve();

/** One fresh 25 MiB instance at a time, including across rooms sharing a runner isolate. */
async function acquireEngine(trap = false) {
  const previous = renderFinished;
  const slot = Promise.withResolvers<void>();
  renderFinished = slot.promise;
  await previous;
  const instance = glue.__drawpaneCreateGlue();
  const release = () => {
    images.dispose();
    instance.__drawpaneQuiesce();
    slot.resolve();
  };
  try {
    const engine = new RenderEngine(loadEngineSync(instance, wasm, "worker"), {
      // High-diversity text can exceed the interactive outline ceiling without needing an atlas.
      glyphOutlineBytes: 8 << 20,
      ...(trap ? { messageBytes: 32 << 20 } : {}),
    });
    if (trap) {
      // The armed chaos hook bypasses message admission to exercise a real Wasm memory trap.
      const result = engine.apply(new Uint8Array(32 << 20));
      if (!result.ok) throw new HeadlessRenderError(result);
      engine.dispose();
      throw new Error("The render-trap test hook did not trap.");
    }
    if (engine.dead)
      throw new HeadlessRenderError({
        ok: false,
        code: ErrorCode.Trap,
        message: "Could not start the render engine.",
      });
    return {
      engine,
      release,
    };
  } catch (error) {
    release();
    throw error;
  }
}

/**
 * A file's images by hash: the bytes from R2, the type and size from when
 * its team uploaded them. Another team's images aren't drawn, as they can't
 * be fetched from the file's editor either. Bound the encoded bytes before
 * reading R2. Decoded pixels are charged separately at the chosen level.
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
    const encodedRoom = room - (2 << 20);
    if (row.bytes > encodedRoom) return "too-large";
    const object = await env.FILES.get(mediaKey(ref));
    if (!object) return null;
    if (object.size > encodedRoom) {
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
export function headlessRenderer(
  env: Env,
  fileId: string,
  measurer: HeadlessMeasurer,
  renderTrap?: () => Promise<boolean>,
): HeadlessRenderer {
  return createHeadlessRenderer({
    measurer,
    images: renderImages(env, fileId),
    decodeImage: images.decode,
    decodeMemoryBytes: images.memoryBytes,
    timeoutMs: 45_000,
    acquireEngine: async () => acquireEngine(await renderTrap?.()),
    async prepareFonts(nodes) {
      await measurer.prepareRenderFonts?.(nodes);
    },
  });
}
