/**
 * Cold-load progressive image benchmark on a converted real kit (opt-in via BENCH_FILE, never CI).
 *
 * Measures Fit view and 100% view on the kit's `Examples` page under a throttled network profile
 * (default 50 Mbps, 20 ms RTT, browser HTTP cache disabled via CDP):
 *   - bytes downloaded before the first useful image
 *   - time to the first useful image
 *   - time to sharp (`exact` frame shown)
 *   - total image bytes downloaded (broken down by ?w=256, ?w=1024, and full original)
 *   - per-request start/end timeline (for diagnosing fetch scheduling / starvation)
 *   - client-side browser preview encode time across the kit's images (when supported)
 *
 * Designed to run identically against `main` and a feature branch for apples-to-apples comparison.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { freshInstance, type Instance } from "../fresh-instance";
import { importConverted } from "../import-converted";
import { pagesOf } from "./kit-pages";

const FILE = process.env.BENCH_FILE;
const TARGET_PAGE = process.env.BENCH_PAGE ?? "Examples";
const TARGET_FRAME = process.env.BENCH_FRAME ?? "f12740-37611";
const MBPS = Number(process.env.BENCH_MBPS ?? 50);
const LATENCY_MS = Number(process.env.BENCH_LATENCY_MS ?? 20);
const RENDERER = process.env.BENCH_RENDERER === "canvas" ? "canvas" : "engine";
const PRESENT = process.env.BENCH_ENGINE_PRESENT ?? "readback";
const ALLOW_SOFTWARE = process.env.BENCH_ALLOW_SOFTWARE === "1";

interface MediaEvent {
  readonly atMs: number;
  readonly bytes: number;
  readonly tier: "256" | "1024" | "full";
}

interface RequestTimelineItem {
  readonly sha: string;
  readonly tier: "256" | "1024" | "full";
  readonly startMs: number;
  readonly endMs: number | null;
  readonly bytes: number;
}

interface ClientEncodeStats {
  readonly imagesTotal: number;
  readonly imagesWithPreviews: number;
  readonly skippedSmall: number;
  readonly skippedPixelLimit: number;
  readonly previewsGenerated: number;
  readonly previewsUploaded: number;
  readonly totalOriginalBytes: number;
  readonly totalPreviewBytes: number;
  readonly w256Bytes: number;
  readonly w1024Bytes: number;
  readonly mimeCounts: Record<string, number>;
  readonly wallMs: number;
  readonly encodeMsTotal: number;
  readonly encodeMsMean: number;
  readonly encodeMsP50: number;
  readonly encodeMsP95: number;
  readonly encodeMsMax: number;
}

interface ViewResult {
  readonly view: "fit" | "100%";
  readonly mbps: number;
  readonly latencyMs: number;
  readonly renderer: string;
  readonly adapter: string | null;
  readonly firstUsefulMs: number | null;
  readonly bytesBeforeUseful: number | null;
  readonly imagesUsefulMs: number | null;
  readonly bytesBeforeImagesUseful: number | null;
  readonly imageBlocks: number;
  readonly sharpMs: number | null;
  readonly sharpExactDrawnMs: number | null;
  readonly totalImageBytes: number;
  readonly requests: {
    readonly total: number;
    readonly w256: { count: number; bytes: number };
    readonly w1024: { count: number; bytes: number };
    readonly full: { count: number; bytes: number };
  };
  readonly timeline: readonly RequestTimelineItem[];
  readonly reducedImages: number;
  readonly timedOut: boolean;
}

interface DocNode {
  readonly props?: {
    readonly visible?: boolean;
    readonly fills?: ReadonlyArray<{ readonly type?: string; readonly visible?: boolean }>;
  };
}

interface DebugWindow {
  drawpane?: {
    s: {
      status: string;
      pageId: string;
      viewport: { width: number; height: number };
      insets: { left: number; top: number; right: number; bottom: number };
      camera: {
        x: number;
        y: number;
        zoom: number;
        toScreen(p: { x: number; y: number }): { x: number; y: number };
      };
    };
    doc: {
      get(id: string): DocNode | undefined;
      childIds(id: string): readonly string[];
    };
    scene: { bounds(id: string): { x: number; y: number; width: number; height: number } | null };
    setPage(id: string): void;
    zoomToFit(): void;
    zoomTo(zoom: number): void;
    centerOn(point: { x: number; y: number }): void;
  };
  drawpaneFrames?: { exact: boolean };
  drawpanePreviews?: () => Promise<{
    uploadMediaPreviews(
      sha: string,
      blob: Blob,
      options?: { readonly force?: boolean },
    ): Promise<{
      readonly generated: number;
      readonly uploaded: number;
      readonly encodeMs: number;
      readonly skipped?: "unsupported" | "pixel-limit" | "small";
      readonly previews: readonly {
        readonly size: 256 | 1024;
        readonly width: number;
        readonly height: number;
        readonly bytes: number;
        readonly mime: string;
      }[];
    }>;
  }>;
  drawpaneEngineView?: {
    canvas: HTMLCanvasElement;
    adapter: string;
    backend: string;
    reducedImages?: number;
    stamps: {
      drawn?: { n: number; at: number };
      gpu?: { n: number; at: number };
      shown?: { n: number; at: number };
    } | null;
    shown: { n: number; at: number };
    last: { n: number; exact: boolean; pageId: string; supported: boolean };
  };
}

/**
 * On branches that expose client-side preview generation (`drawpanePreviews`), generates and
 * uploads previews for all imported kit images using the real browser preview worker, measuring
 * exact client-side encode CPU/wall time. No-ops cleanly on `main`.
 */
async function populateClientPreviews(
  instance: Instance,
  fileId: string,
  folder: string,
): Promise<ClientEncodeStats | null> {
  const meta = JSON.parse(readFileSync(join(folder, "meta.json"), "utf8")) as {
    images: { sha: string; mime: string }[];
  };
  if (meta.images.length === 0) return null;

  const tab = await instance.context.newPage();
  await tab.addInitScript(() => {
    try {
      localStorage.setItem("drawpane:debug", "1");
      localStorage.setItem("drawpane:renderer", "canvas");
    } catch {
      // Ignore opaque origins before navigation.
    }
  });
  try {
    await tab.goto(`/f/${fileId}`);
    await tab.waitForFunction(
      () => (window as unknown as DebugWindow).drawpane?.s.status === "live",
      undefined,
      { timeout: 60_000, polling: 200 },
    );
    const hasHelper = await tab.evaluate(
      () => typeof (window as unknown as DebugWindow).drawpanePreviews === "function",
    );
    if (!hasHelper) return null;

    const shas = meta.images.map((i) => i.sha);
    const stats = await tab.evaluate(async (imageShas) => {
      const w = window as unknown as DebugWindow;
      const mod = await w.drawpanePreviews?.();
      if (!mod) return null;
      const encodeTimes: number[] = [];
      let imagesWithPreviews = 0;
      let skippedSmall = 0;
      let skippedPixelLimit = 0;
      let previewsGenerated = 0;
      let previewsUploaded = 0;
      let totalOriginalBytes = 0;
      let totalPreviewBytes = 0;
      let w256Bytes = 0;
      let w1024Bytes = 0;
      const mimeCounts: Record<string, number> = {};

      const wallStart = performance.now();
      for (const sha of imageShas) {
        const res = await fetch(`/api/media/${sha}`, { credentials: "same-origin" });
        if (!res.ok) continue;
        const blob = await res.blob();
        totalOriginalBytes += blob.size;
        const out = await mod.uploadMediaPreviews(sha, blob, { force: true });
        encodeTimes.push(out.encodeMs);
        if (out.skipped === "small") skippedSmall++;
        if (out.skipped === "pixel-limit") skippedPixelLimit++;
        if (out.generated > 0) imagesWithPreviews++;
        previewsGenerated += out.generated;
        previewsUploaded += out.uploaded;
        for (const p of out.previews) {
          totalPreviewBytes += p.bytes;
          if (p.size === 256) w256Bytes += p.bytes;
          else w1024Bytes += p.bytes;
          mimeCounts[p.mime] = (mimeCounts[p.mime] ?? 0) + 1;
        }
      }
      const wallMs = Math.round(performance.now() - wallStart);
      encodeTimes.sort((a, b) => a - b);
      const pct = (q: number) =>
        encodeTimes.length === 0
          ? 0
          : Math.round(
              (encodeTimes[Math.min(encodeTimes.length - 1, Math.floor(encodeTimes.length * q))] ??
                0) * 10,
            ) / 10;
      const encodeMsTotal = Math.round(encodeTimes.reduce((s, v) => s + v, 0));
      return {
        imagesTotal: imageShas.length,
        imagesWithPreviews,
        skippedSmall,
        skippedPixelLimit,
        previewsGenerated,
        previewsUploaded,
        totalOriginalBytes,
        totalPreviewBytes,
        w256Bytes,
        w1024Bytes,
        mimeCounts,
        wallMs,
        encodeMsTotal,
        encodeMsMean:
          encodeTimes.length > 0 ? Math.round((encodeMsTotal / encodeTimes.length) * 10) / 10 : 0,
        encodeMsP50: pct(0.5),
        encodeMsP95: pct(0.95),
        encodeMsMax: pct(1),
      };
    }, shas);
    return stats;
  } finally {
    await tab.close();
  }
}

async function measureColdView(
  instance: Instance,
  fileId: string,
  pageId: string,
  view: "fit" | "100%",
  frameId: string,
): Promise<ViewResult> {
  const tab = await instance.context.newPage();
  await tab.addInitScript(
    ({ renderer, present, allowSoftware }) => {
      try {
        localStorage.setItem("drawpane:debug", "1");
        localStorage.setItem("drawpane:renderer", renderer);
        localStorage.setItem("drawpane:engine-present", present);
        if (allowSoftware) localStorage.setItem("drawpane:engine-software", "allow");
      } catch {
        // Ignore opaque origins before navigation.
      }
    },
    { renderer: RENDERER, present: PRESENT, allowSoftware: ALLOW_SOFTWARE },
  );

  const cdp = await tab.context().newCDPSession(tab);
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });

  const mediaRequests = new Map<
    string,
    {
      sha: string;
      tier: "256" | "1024" | "full";
      startMs: number;
      endMs: number | null;
      streamed: number;
      finished: boolean;
    }
  >();
  const events: MediaEvent[] = [];
  let recording = false;
  let startedWallMs = 0;

  cdp.on("Network.requestWillBeSent", (params) => {
    if (!recording) return;
    if (params.request.method !== "GET") return;
    const url = new URL(params.request.url);
    if (!url.pathname.startsWith("/api/media/")) return;
    const sha = url.pathname.slice("/api/media/".length).split("/")[0] ?? "";
    const w = url.searchParams.get("w");
    const tier: "256" | "1024" | "full" = w === "256" ? "256" : w === "1024" ? "1024" : "full";
    mediaRequests.set(params.requestId, {
      sha: sha.slice(0, 8),
      tier,
      startMs: Math.round(performance.now() - startedWallMs),
      endMs: null,
      streamed: 0,
      finished: false,
    });
  });
  cdp.on("Network.dataReceived", (params) => {
    if (!recording) return;
    const req = mediaRequests.get(params.requestId);
    if (!req) return;
    const delta = params.encodedDataLength > 0 ? params.encodedDataLength : params.dataLength;
    if (delta > 0) {
      req.streamed += delta;
      events.push({ atMs: performance.now() - startedWallMs, bytes: delta, tier: req.tier });
    }
  });
  cdp.on("Network.loadingFinished", (params) => {
    if (!recording) return;
    const req = mediaRequests.get(params.requestId);
    if (!req) return;
    req.finished = true;
    req.endMs = Math.round(performance.now() - startedWallMs);
    const extra = Math.max(0, params.encodedDataLength - req.streamed);
    if (extra > 0) {
      req.streamed += extra;
      events.push({ atMs: performance.now() - startedWallMs, bytes: extra, tier: req.tier });
    }
  });

  try {
    // Load the file document snapshot unthrottled on its default page (Cover), then enable
    // 50 Mbps throttling right before switching to Examples so we isolate cold image loading.
    await tab.goto(`/f/${fileId}`);
    await tab.waitForFunction(
      (wantEngine) => {
        const w = window as unknown as DebugWindow;
        return (
          w.drawpane?.s.status === "live" &&
          (!wantEngine || Boolean(w.drawpaneEngineView)) &&
          Boolean(w.drawpaneFrames?.exact)
        );
      },
      RENDERER === "engine",
      { timeout: 120_000, polling: 200 },
    );
    await tab.waitForTimeout(500);

    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: LATENCY_MS,
      downloadThroughput: (MBPS * 1_000_000) / 8,
      uploadThroughput: (MBPS * 1_000_000) / 8,
    });

    recording = true;
    startedWallMs = performance.now();

    const timing = await tab.evaluate(
      async ({ pageId, view, frameId }) => {
        const w = window as unknown as DebugWindow;
        const e = w.drawpane;
        const v = w.drawpaneEngineView;
        if (!e) throw new Error("drawpane debug handle missing");
        const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
        const BLOCK = 16;
        const small = document.createElement("canvas");
        const sctx = small.getContext("2d", { willReadFrequently: true });
        const sample = (): Uint8ClampedArray | null => {
          if (!v || !sctx || v.canvas.width === 0 || v.canvas.height === 0) return null;
          small.width = Math.ceil(v.canvas.width / BLOCK);
          small.height = Math.ceil(v.canvas.height / BLOCK);
          sctx.imageSmoothingEnabled = true;
          sctx.imageSmoothingQuality = "high";
          sctx.clearRect(0, 0, small.width, small.height);
          sctx.drawImage(v.canvas, 0, 0, small.width, small.height);
          return sctx.getImageData(0, 0, small.width, small.height).data;
        };

        const samples: Array<{ n: number; at: number; px: Uint8ClampedArray }> = [];
        const shownBefore = v?.shown.n ?? 0;
        const t0 = performance.now();

        // Switch page and immediately position camera before the first rAF so 100% mode never
        // triggers a Fit-view draw or Fit-view image requests.
        e.setPage(pageId);
        if (view === "fit") {
          e.zoomToFit();
        } else {
          const b = e.scene.bounds(frameId);
          if (!b) throw new Error(`Frame ${frameId} not found on page ${pageId}`);
          e.zoomTo(1);
          e.centerOn({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
        }
        if (v) v.stamps = {};

        let lastSampled = shownBefore;
        const take = () => {
          if (
            !v ||
            v.last.pageId !== pageId ||
            v.shown.n === lastSampled ||
            v.shown.n <= shownBefore
          )
            return;
          lastSampled = v.shown.n;
          const px = sample();
          if (px) samples.push({ n: v.shown.n, at: v.shown.at, px });
        };

        let exactAny: number | null = null;
        for (;;) {
          await frame();
          take();
          const st = v?.stamps;
          // Ignore a stale readback from the previous page landing before this page drew.
          if (st?.shown && (!st.drawn || st.shown.n < st.drawn.n)) {
            delete st.shown;
          }
          if (exactAny === null && w.drawpaneFrames?.exact && (!v || v.last.exact)) {
            exactAny = performance.now() - t0;
          }
          const engineDone = Boolean(st?.drawn && st.shown && st.shown.n >= st.drawn.n);
          if (
            (v?.last.supported ? engineDone : exactAny !== null) ||
            performance.now() - t0 > 90_000
          )
            break;
        }
        take();
        const timedOut = performance.now() - t0 > 90_000;
        const st = v?.stamps;
        const exactPx = v?.last.supported ? sample() : null;
        let firstUsefulMs: number | null = null;
        let imagesUsefulMs: number | null = null;
        let imageBlocks = 0;
        if (exactPx && v) {
          const sw = Math.ceil(v.canvas.width / BLOCK);
          const sh = Math.ceil(v.canvas.height / BLOCK);
          const dpr = v.canvas.width / Math.max(1, e.s.viewport.width);
          const imageMask = new Uint8Array(sw * sh);
          const stack: string[] = [...e.doc.childIds(pageId)];
          while (stack.length > 0) {
            const id = stack.pop() as string;
            const node = e.doc.get(id);
            if (!node || node.props?.visible === false) continue;
            const hasImage = node.props?.fills?.some(
              (f) => f.type === "image" && f.visible !== false,
            );
            if (hasImage) {
              const b = e.scene.bounds(id);
              if (b && b.width > 0 && b.height > 0) {
                const tl = e.s.camera.toScreen({ x: b.x, y: b.y });
                const br = e.s.camera.toScreen({ x: b.x + b.width, y: b.y + b.height });
                const x0 = Math.max(0, Math.floor((Math.min(tl.x, br.x) * dpr) / BLOCK));
                const y0 = Math.max(0, Math.floor((Math.min(tl.y, br.y) * dpr) / BLOCK));
                const x1 = Math.min(sw - 1, Math.floor((Math.max(tl.x, br.x) * dpr) / BLOCK));
                const y1 = Math.min(sh - 1, Math.floor((Math.max(tl.y, br.y) * dpr) / BLOCK));
                for (let y = y0; y <= y1; y++) {
                  for (let x = x0; x <= x1; x++) imageMask[y * sw + x] = 1;
                }
              }
            }
            for (const cid of e.doc.childIds(id)) stack.push(cid);
          }
          for (let k = 0; k < imageMask.length; k++) if (imageMask[k]) imageBlocks++;

          const counts = new Map<number, number>();
          for (let i = 0; i < exactPx.length; i += 4) {
            const key =
              ((exactPx[i] as number) << 16) |
              ((exactPx[i + 1] as number) << 8) |
              (exactPx[i + 2] as number);
            counts.set(key, (counts.get(key) ?? 0) + 1);
          }
          let bg = 0;
          let most = 0;
          for (const [key, c] of counts)
            if (c > most) {
              most = c;
              bg = key;
            }
          const bgc = [(bg >> 16) & 255, (bg >> 8) & 255, bg & 255];
          const near = (
            a: Uint8ClampedArray,
            i: number,
            b: ArrayLike<number>,
            j: number,
            tol: number,
          ) =>
            Math.abs((a[i] as number) - (b[j] as number)) <= tol &&
            Math.abs((a[i + 1] as number) - (b[j + 1] as number)) <= tol &&
            Math.abs((a[i + 2] as number) - (b[j + 2] as number)) <= tol;
          for (const s of samples) {
            if (s.px.length !== exactPx.length || (st?.shown && s.n > st.shown.n)) continue;
            let fg = 0;
            let fgOk = 0;
            let ok = 0;
            let imgOk = 0;
            for (let idx = 0; idx < imageMask.length; idx++) {
              const i = idx * 4;
              const match = near(s.px, i, exactPx, i, 40);
              if (match) ok++;
              if (imageMask[idx] && match) imgOk++;
              if (!near(exactPx, i, bgc, 0, 24)) {
                fg++;
                if (match) fgOk++;
              }
            }
            const foreground = fg ? fgOk / fg : 1;
            const all = ok / (exactPx.length / 4);
            if (firstUsefulMs === null && foreground >= 0.9 && all >= 0.9) {
              firstUsefulMs = Math.round(s.at - t0);
            }
            if (imagesUsefulMs === null && imageBlocks > 0 && imgOk / imageBlocks >= 0.9) {
              imagesUsefulMs = Math.round(s.at - t0);
            }
            if (firstUsefulMs !== null && (imagesUsefulMs !== null || imageBlocks === 0)) break;
          }
        }
        if (v) v.stamps = null;
        return {
          firstUsefulMs,
          imagesUsefulMs,
          imageBlocks,
          sharpMs: st?.shown
            ? Math.round(st.shown.at - t0)
            : exactAny
              ? Math.round(exactAny)
              : null,
          sharpExactDrawnMs: st?.drawn ? Math.round(st.drawn.at - t0) : null,
          renderer: v?.last.supported ? `engine (${v.backend})` : "canvas",
          adapter: v?.adapter ?? null,
          reducedImages: v?.reducedImages ?? 0,
          timedOut,
        };
      },
      { pageId, view, frameId },
    );

    // Let any trailing speculative/ring requests finish so total downloaded bytes are honest.
    await tab.waitForTimeout(1000);
    recording = false;

    const usefulAt = timing.firstUsefulMs;
    const bytesBeforeUseful =
      usefulAt === null
        ? null
        : events.filter((ev) => ev.atMs <= usefulAt).reduce((sum, ev) => sum + ev.bytes, 0);
    const imagesUsefulAt = timing.imagesUsefulMs;
    const bytesBeforeImagesUseful =
      imagesUsefulAt === null
        ? null
        : events.filter((ev) => ev.atMs <= imagesUsefulAt).reduce((sum, ev) => sum + ev.bytes, 0);

    const w256 = { count: 0, bytes: 0 };
    const w1024 = { count: 0, bytes: 0 };
    const full = { count: 0, bytes: 0 };
    const timeline: RequestTimelineItem[] = [];
    for (const req of mediaRequests.values()) {
      const bucket = req.tier === "256" ? w256 : req.tier === "1024" ? w1024 : full;
      bucket.count++;
      bucket.bytes += req.streamed;
      timeline.push({
        sha: req.sha,
        tier: req.tier,
        startMs: req.startMs,
        endMs: req.endMs,
        bytes: req.streamed,
      });
    }
    timeline.sort((a, b) => a.startMs - b.startMs);
    const totalImageBytes = w256.bytes + w1024.bytes + full.bytes;

    return {
      view,
      mbps: MBPS,
      latencyMs: LATENCY_MS,
      renderer: timing.renderer,
      adapter: timing.adapter,
      firstUsefulMs: timing.firstUsefulMs,
      bytesBeforeUseful,
      imagesUsefulMs: timing.imagesUsefulMs,
      bytesBeforeImagesUseful,
      imageBlocks: timing.imageBlocks,
      sharpMs: timing.sharpMs,
      sharpExactDrawnMs: timing.sharpExactDrawnMs,
      totalImageBytes,
      requests: { total: mediaRequests.size, w256, w1024, full },
      timeline,
      reducedImages: timing.reducedImages,
      timedOut: timing.timedOut,
    };
  } finally {
    await tab.close();
  }
}

test.describe("Cold-load progressive image benchmark", () => {
  test.skip(!FILE, "Opt-in: set BENCH_FILE to a converted kit folder.");
  test.skip(!!process.env.E2E_BASE_URL, "Needs its own local instance.");

  let instance: Instance;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000);
    const port = Number(process.env.BENCH_PORT ?? 8831);
    instance = await freshInstance(browser, { port, inspectorPort: port + 540 });
  });

  test.afterAll(async () => {
    await instance?.stop();
  });

  test("measures cold Fit and 100% loads on Examples under throttled network", async () => {
    test.setTimeout(10 * 60_000);
    const folder = FILE as string;
    const pages = pagesOf(folder);
    const target = pages.find((p) => p.name === TARGET_PAGE || p.id === TARGET_PAGE);
    expect(target, `Page "${TARGET_PAGE}" not found in ${folder}`).toBeDefined();
    const pageId = (target as NonNullable<typeof target>).id;

    const importStart = Date.now();
    const fileId = await importConverted(instance.page, folder, "Image Load Bench");
    const importSeconds = Math.round((Date.now() - importStart) / 1000);
    console.log(`Imported kit in ${importSeconds} s (page ${TARGET_PAGE} = ${pageId}).`);

    // Seed the file's dashboard thumbnail once so useThumbnailPublisher's 10 s timer does not
    // fire mid-benchmark on `main` (which skips populateClientPreviews) to re-fetch Cover media.
    const onePxPng = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
      "base64",
    );
    const thumbRes = await instance.page.request.put(`/api/files/${fileId}/thumbnail`, {
      headers: { "Content-Type": "image/png" },
      data: onePxPng,
    });
    expect(thumbRes.ok(), `seed thumbnail PUT failed (${thumbRes.status()})`).toBe(true);

    const clientEncode = await populateClientPreviews(instance, fileId, folder);
    if (clientEncode) {
      console.log(
        `[client-encode] ${clientEncode.imagesTotal} images -> ${clientEncode.previewsUploaded}/${clientEncode.previewsGenerated} previews uploaded ` +
          `(${(clientEncode.totalPreviewBytes / 1e6).toFixed(2)} MB vs ${(clientEncode.totalOriginalBytes / 1e6).toFixed(2)} MB orig) | ` +
          `wall=${clientEncode.wallMs} ms, encodeTotal=${clientEncode.encodeMsTotal} ms ` +
          `(mean=${clientEncode.encodeMsMean} ms, p50=${clientEncode.encodeMsP50} ms, p95=${clientEncode.encodeMsP95} ms, max=${clientEncode.encodeMsMax} ms) | ` +
          `mimes=${JSON.stringify(clientEncode.mimeCounts)}`,
      );
    }

    const fit = await measureColdView(instance, fileId, pageId, "fit", TARGET_FRAME);
    const full100 = await measureColdView(instance, fileId, pageId, "100%", TARGET_FRAME);

    const fmtMB = (b: number | null) => (b === null ? "-" : `${(b / 1e6).toFixed(2)} MB`);
    for (const r of [fit, full100]) {
      console.log(
        `[${r.view.padEnd(4)}] ${r.mbps} Mbps (${r.latencyMs} ms RTT) | ${r.renderer} (${r.adapter ?? "n/a"})\n` +
          `  page useful:   ${r.firstUsefulMs ?? "-"} ms (${fmtMB(r.bytesBeforeUseful)} before useful)\n` +
          `  images useful: ${r.imagesUsefulMs ?? "-"} ms (${fmtMB(r.bytesBeforeImagesUseful)} before images useful; ${r.imageBlocks} blocks)\n` +
          `  sharp (exact): ${r.sharpMs ?? "-"} ms (drawn ${r.sharpExactDrawnMs ?? "-"} ms)\n` +
          `  total image bytes: ${fmtMB(r.totalImageBytes)} across ${r.requests.total} reqs ` +
          `(w=256: ${r.requests.w256.count} / ${fmtMB(r.requests.w256.bytes)}, ` +
          `w=1024: ${r.requests.w1024.count} / ${fmtMB(r.requests.w1024.bytes)}, ` +
          `full: ${r.requests.full.count} / ${fmtMB(r.requests.full.bytes)}) | reduced=${r.reducedImages}`,
      );
    }

    const report = {
      page: { id: pageId, name: TARGET_PAGE },
      frameId: TARGET_FRAME,
      importSeconds,
      clientEncode,
      mbps: MBPS,
      latencyMs: LATENCY_MS,
      fit,
      full100,
    };
    if (process.env.BENCH_OUT) {
      writeFileSync(process.env.BENCH_OUT, `${JSON.stringify(report, null, 2)}\n`);
    }
    test.info().annotations.push({ type: "bench", description: JSON.stringify(report) });
    expect(fit.timedOut).toBe(false);
    expect(full100.timedOut).toBe(false);
  });
});
