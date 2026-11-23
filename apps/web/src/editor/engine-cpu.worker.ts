/**
 * CPU view mode worker (decision 0040, "Fallbacks", path 3): runs `vello_cpu` off the main
 * thread when neither WebGPU nor WebGL2 is usable (missing API, software adapter refused, or
 * repeated GPU device/context losses).
 *
 * Keeps one RenderEngine instance loaded from the browser build (so it is not held to the
 * Cloudflare Worker 25 MiB cap), applies display-list patches in order, renders frames through
 * Phase 2's tiled CPU path (`renderCpuTiled`, sharing the tile cache, dirty-rect invalidation,
 * drag compositing, and provisional text exactness), transfers each progressive frame as an
 * ImageBitmap with bounded worker-wide credit backpressure, and yields between slices so a
 * newer camera or edit cancels stale work at once.
 */
import { type Camera, ErrorCode, type FrameStats, RenderEngine } from "@drawpane/engine";
import { loadBrowserEngine } from "@drawpane/engine/browser";
import { CPU_IMAGE_BUDGET, uploadCpuLevel } from "./engine-image";
import { fitEngineRaster } from "./engine-raster";

/** Maximum unacknowledged frame transfers in flight between the worker and the main thread. */
const MAX_INFLIGHT_TRANSFERS = 2;
/**
 * Maximum unacknowledged transfer bytes in flight between the worker and the main thread (16 MiB).
 * A single frame larger than this cap (up to 4096x4096 = 64 MiB) is still sent once zero transfers
 * are in flight, but no second snapshot is queued until the consumer ACKs the previous one.
 */
const MAX_INFLIGHT_BYTES = 16 * 1024 * 1024;
/** Maximum cached CPU tiles retained in the worker's Phase 2 tile cache. */
const CPU_TILE_SLOTS = 128;
// A smaller CPU picture loses readable text. Let the viewport use Canvas
// when the Worker cannot admit even this raster, and retry on the next view.
const CPU_RASTER_FLOOR = 0.5;
/** Tiles drawn per progressive slice at rest vs while moving. */
const REST_SLICE_TILES = 4;
const MOVING_SLICE_TILES = 0;

export type CpuWorkerRequest =
  | { readonly type: "init" }
  | { readonly type: "apply"; readonly bytes: ArrayBuffer; readonly attempt?: number }
  | {
      readonly type: "put-image";
      readonly handle: number;
      readonly ticket: number;
      readonly bitmap: ImageBitmap;
    }
  | { readonly type: "drop-image-level"; readonly handle: number; readonly width: number }
  | { readonly type: "clear-view-caches" }
  | {
      readonly type: "render";
      readonly jobId: number;
      readonly revision: number;
      readonly width: number;
      readonly height: number;
      readonly camera: Camera;
      readonly background: readonly [number, number, number, number];
      readonly moving: boolean;
      readonly tileSize: number;
    }
  | { readonly type: "tile-ack"; readonly jobId: number }
  | { readonly type: "dispose" };

export type CpuWorkerReply =
  | { readonly type: "ready" }
  | {
      readonly type: "image-result";
      readonly ticket: number;
      readonly uploaded: boolean;
    }
  | {
      readonly type: "apply-result";
      readonly attempt?: number;
      readonly ok: boolean;
      readonly revision: number;
      readonly code?: ErrorCode;
      readonly message?: string;
    }
  | {
      readonly type: "tile";
      readonly jobId: number;
      readonly revision: number;
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
      readonly reduced?: boolean;
      readonly bitmap?: ImageBitmap;
      readonly pixels?: ArrayBuffer;
    }
  | {
      readonly type: "done";
      readonly jobId: number;
      readonly revision: number;
      readonly width: number;
      readonly height: number;
      readonly camera: Camera;
      readonly exact: boolean;
      readonly limit?: string;
      readonly plan: FrameStats["plan"];
      readonly tiles: FrameStats["tiles"];
      readonly ms: number;
      readonly records: number;
      readonly culled: number;
      readonly glyphsMasked: number;
      readonly glyphsOutlined: number;
    }
  | {
      readonly type: "unsupported";
      readonly jobId: number;
      readonly revision: number;
      readonly message: string;
    }
  | {
      readonly type: "error";
      readonly jobId?: number;
      readonly revision?: number;
      readonly code: ErrorCode | null;
      readonly message: string;
    };

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<CpuWorkerRequest>) => void) | null;
  postMessage(message: CpuWorkerReply, transfer?: Transferable[]): void;
};
const post = (message: CpuWorkerReply, transfer: Transferable[] = []) =>
  scope.postMessage(message, transfer);

let engine: RenderEngine | null = null;
let disposed = false;
let latestJobId = 0;
let applyEpoch = 0;
let committedRevision = 0;
let applyRejected = false;
let pendingRender: {
  readonly req: Extract<CpuWorkerRequest, { type: "render" }>;
  readonly epoch: number;
} | null = null;
let pumping = false;
const inflight: Array<{ readonly jobId: number; readonly bytes: number }> = [];
let inflightBytes = 0;
let creditWaiter: (() => void) | null = null;

function canSendFrame(frameBytes: number): boolean {
  if (inflight.length === 0) return true;
  return (
    inflight.length < MAX_INFLIGHT_TRANSFERS && inflightBytes + frameBytes <= MAX_INFLIGHT_BYTES
  );
}

function wakeCredit(): void {
  const w = creditWaiter;
  creditWaiter = null;
  w?.();
}

function waitForCredit(jobId: number, epoch: number, frameBytes: number): Promise<void> {
  if (disposed || jobId !== latestJobId || epoch !== applyEpoch || canSendFrame(frameBytes)) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const prev = creditWaiter;
    creditWaiter = () => {
      prev?.();
      resolve();
    };
  });
}

const yieldTick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function pump(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    while (!disposed && pendingRender) {
      const { req: job, epoch } = pendingRender;
      pendingRender = null;
      const isStale = () =>
        disposed ||
        !engine ||
        applyRejected ||
        job.jobId !== latestJobId ||
        epoch !== applyEpoch ||
        job.revision !== committedRevision;
      if (isStale()) continue;

      const started = performance.now();
      const tileSize = Math.max(64, Math.min(job.tileSize, 1024));
      let { width, height, camera } = job;
      let frameBytes = width * height * 4;
      let limit: string | undefined;
      let direct = false;
      let records = 0;
      let culled = 0;
      let glyphsMasked = 0;
      let glyphsOutlined = 0;
      let totalDrawn = 0;
      let totalEvicted = 0;
      let lastStats: FrameStats | null = null;
      let aborted = false;

      try {
        // Render through Phase 2's tiled CPU cache (`renderCpuTiled`) in bounded slices so
        // unchanged tiles stay cached, edits invalidate only dirty tiles, drags composite
        // smoothly, and newer camera/edit messages cancel stale slices immediately.
        for (let slice = 0; slice < 64; slice++) {
          while (!canSendFrame(frameBytes) && !isStale()) {
            await waitForCredit(job.jobId, epoch, frameBytes);
          }
          if (isStale() || !engine) {
            aborted = true;
            break;
          }
          let r = engine.renderCpuTiled(width, height, camera, job.background, {
            moving: job.moving,
            maxJobs: job.moving ? MOVING_SLICE_TILES : REST_SLICE_TILES,
            tile: tileSize,
            slots: CPU_TILE_SLOTS,
          });
          if (!r.ok && r.code === ErrorCode.Limit) {
            limit = r.message;
            direct = true;
            const renderer = engine;
            const retry = fitEngineRaster(
              width,
              height,
              camera,
              (raster) =>
                renderer.renderCpu(
                  raster.width,
                  raster.height,
                  raster.camera,
                  job.background,
                  false,
                ),
              1,
              CPU_RASTER_FLOOR,
            );
            r = retry.result;
            if (r.ok && retry.raster.scale === 1) limit = undefined;
            ({ width, height, camera } = retry.raster);
            frameBytes = width * height * 4;
          }
          if (!r.ok) {
            aborted = true;
            if (isStale()) break;
            if (r.code === ErrorCode.Unsupported) {
              post({
                type: "unsupported",
                jobId: job.jobId,
                revision: job.revision,
                message: r.message,
              });
            } else {
              post({
                type: "error",
                jobId: job.jobId,
                revision: job.revision,
                code: r.code,
                message: r.message,
              });
            }
            break;
          }
          const { pixels, stats } = r.value;
          lastStats = stats;
          records += stats.records;
          culled += stats.culled;
          glyphsMasked += stats.glyphsMasked;
          glyphsOutlined += stats.glyphsOutlined;
          totalDrawn += stats.tiles.drawn;
          totalEvicted += stats.tiles.evicted;

          if (typeof createImageBitmap === "function") {
            const copy = new Uint8ClampedArray(pixels.length);
            copy.set(pixels);
            let bitmap: ImageBitmap;
            try {
              bitmap = await createImageBitmap(new ImageData(copy, width, height));
            } catch (err) {
              aborted = true;
              if (!isStale()) {
                post({
                  type: "error",
                  jobId: job.jobId,
                  revision: job.revision,
                  code: ErrorCode.Gpu ?? null,
                  message: String(err),
                });
              }
              break;
            }
            if (isStale()) {
              bitmap.close();
              aborted = true;
              break;
            }
            inflight.push({ jobId: job.jobId, bytes: frameBytes });
            inflightBytes += frameBytes;
            post(
              {
                type: "tile",
                jobId: job.jobId,
                revision: job.revision,
                x: 0,
                y: 0,
                width,
                height,
                ...(limit === undefined ? {} : { reduced: true }),
                bitmap,
              },
              [bitmap],
            );
          } else {
            const copy = new Uint8Array(pixels.length);
            copy.set(pixels);
            if (isStale()) {
              aborted = true;
              break;
            }
            inflight.push({ jobId: job.jobId, bytes: copy.byteLength });
            inflightBytes += copy.byteLength;
            post(
              {
                type: "tile",
                jobId: job.jobId,
                revision: job.revision,
                x: 0,
                y: 0,
                width,
                height,
                ...(limit === undefined ? {} : { reduced: true }),
                pixels: copy.buffer,
              },
              [copy.buffer],
            );
          }

          // Moving frames finish after one slice; resting frames keep slicing through coarse opening
          // frames, pending tiles, and post-drag settling until exact (stopping immediately if a
          // slice makes no progress, e.g. while provisional text is still waiting for fonts).
          if (
            direct ||
            job.moving ||
            stats.exact ||
            (stats.tiles.pending === 0 && stats.tiles.drawn === 0 && stats.tiles.dragged === 0)
          ) {
            break;
          }
          await yieldTick();
        }
      } catch (err) {
        aborted = true;
        if (!isStale()) {
          post({
            type: "error",
            jobId: job.jobId,
            revision: job.revision,
            code: null,
            message: String(err),
          });
        }
      }

      if (!aborted && lastStats && !isStale()) {
        post({
          type: "done",
          jobId: job.jobId,
          revision: job.revision,
          width,
          height,
          camera,
          exact: lastStats.exact && lastStats.tiles.pending === 0 && limit === undefined,
          ...(limit === undefined ? {} : { limit }),
          plan: lastStats.plan,
          tiles: {
            drawn: totalDrawn,
            pending: lastStats.tiles.pending,
            queued: lastStats.tiles.queued,
            held: lastStats.tiles.held,
            evicted: totalEvicted,
            dragged: lastStats.tiles.dragged,
          },
          ms: performance.now() - started,
          records,
          culled,
          glyphsMasked,
          glyphsOutlined,
        });
      }
    }
  } catch (err) {
    post({ type: "error", code: null, message: String(err) });
  } finally {
    pumping = false;
    if (!disposed && pendingRender) void pump();
  }
}

scope.onmessage = async ({ data }) => {
  try {
    if (data.type === "init") {
      const mod = await loadBrowserEngine();
      if (disposed) return;
      engine = new RenderEngine(mod, {
        glyphMaskBytes: 16 << 20,
        imageBytes: CPU_IMAGE_BUDGET,
      });
      if (engine.failure) {
        post({ type: "error", code: engine.failure.code, message: engine.failure.message });
        return;
      }
      engine.enableViewImages();
      committedRevision = engine.revision;
      applyRejected = false;
      post({ type: "ready" });
      return;
    }
    if (data.type === "dispose") {
      disposed = true;
      pendingRender = null;
      latestJobId++;
      inflight.length = 0;
      inflightBytes = 0;
      wakeCredit();
      engine?.dispose();
      engine = null;
      return;
    }
    if (!engine) return;
    if (data.type === "apply") {
      // Cancel any stale in-flight frame when the display list changes, while preserving
      // worker-wide unacknowledged transfer credit until the main thread ACKs every frame.
      applyEpoch++;
      pendingRender = null;
      wakeCredit();
      const r = engine.apply(new Uint8Array(data.bytes));
      if (r.ok) {
        committedRevision = engine.revision;
        applyRejected = false;
        post({ type: "apply-result", ok: true, revision: committedRevision });
      } else {
        applyRejected = true;
        post({
          type: "apply-result",
          ...(data.attempt === undefined ? {} : { attempt: data.attempt }),
          ok: false,
          revision: engine.revision,
          code: r.code,
          message: r.message,
        });
      }
      return;
    }
    if (data.type === "put-image") {
      try {
        const r = uploadCpuLevel(engine, data.handle, data.bitmap);
        post({ type: "image-result", ticket: data.ticket, uploaded: r.ok });
        if (!r.ok && r.code === ErrorCode.Trap) {
          post({ type: "error", code: r.code, message: r.message });
        }
      } catch {
        // A browser bitmap read can run out of memory independently of wasm.
        post({ type: "image-result", ticket: data.ticket, uploaded: false });
      } finally {
        data.bitmap.close();
      }
      return;
    }
    if (data.type === "drop-image-level") {
      engine.dropImageLevel(data.handle, data.width);
      return;
    }
    if (data.type === "clear-view-caches") {
      latestJobId++;
      pendingRender = null;
      wakeCredit();
      engine.clearViewCaches();
      return;
    }
    if (data.type === "tile-ack") {
      // Release transfer credit and bytes on every ACK, including frames from superseded jobs.
      const idx = inflight.findIndex((entry) => entry.jobId === data.jobId);
      const removed = idx >= 0 ? inflight.splice(idx, 1)[0] : inflight.shift();
      if (removed) inflightBytes = Math.max(0, inflightBytes - removed.bytes);
      wakeCredit();
      return;
    }
    if (data.type === "render") {
      if (applyRejected || data.revision !== committedRevision) {
        return;
      }
      latestJobId = data.jobId;
      // Wake any superseded job waiting for credit so it exits; keep worker-wide inflightTiles intact.
      wakeCredit();
      pendingRender = { req: data, epoch: applyEpoch };
      void pump();
    }
  } catch (err) {
    post({ type: "error", code: null, message: String(err) });
  }
};
