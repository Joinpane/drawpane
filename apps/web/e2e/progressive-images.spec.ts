import { readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { ROOT_ID } from "@drawpane/model";
import { expect, type Page, test } from "@playwright/test";
import { canvasColor, freshInstance, type Instance } from "./fresh-instance";
import { importNodes } from "./import-converted";

const PORT = 9045;

if (!process.env.ENGINE_BROWSER || process.env.ENGINE_BROWSER === "chromium") {
  test.use({
    launchOptions: {
      args: [
        "--enable-unsafe-webgpu",
        "--enable-unsafe-swiftshader",
        "--use-webgpu-adapter=swiftshader",
        "--disable-gpu-sandbox",
        ...(process.env.ENGINE_CHROME_ARGS ?? "").split(/\s+/).filter(Boolean),
      ],
      ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
    },
  });
}

/** Minimal CRC32 for synthetic PNG chunks. */
function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/**
 * Generates a high-resolution textured PNG (left half blue, right half orange) large enough
 * that lossy previews are much smaller than the original while preserving crisp color halves.
 */
function makeTexturedSplitPng(width: number, height: number, seedInit = 0x12345678): Uint8Array {
  const stride = 1 + width * 4;
  const raw = new Uint8Array(stride * height);
  let seed = seedInit >>> 0;
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const jitter = ((seed >>> 24) & 15) - 8;
      const idx = row + 1 + x * 4;
      if (x < width / 2) {
        // Blue left half (~#2b4fd6).
        raw[idx] = 43 + jitter;
        raw[idx + 1] = 79 + jitter;
        raw[idx + 2] = 214 + jitter;
      } else {
        // Orange right half (~#ff5a1f).
        raw[idx] = 247 + (jitter >> 1);
        raw[idx + 1] = 90 + jitter;
        raw[idx + 2] = 31 + jitter;
      }
      raw[idx + 3] = 255;
    }
  }
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8; // 8-bit
  ihdr[9] = 6; // RGBA
  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const chunks = [
    sig,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 1 })),
    pngChunk("IEND", new Uint8Array(0)),
  ];
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const png = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    png.set(c, off);
    off += c.length;
  }
  return png;
}

function pngSize(bytes: Buffer): { width: number; height: number } {
  expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function parseHex(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

interface DebugWindow {
  drawpane?: {
    s: {
      status: string;
      viewport: { width: number; height: number };
      insets: unknown;
    };
    scene: { bounds(id: string): { x: number; y: number; width: number; height: number } | null };
    zoomTo(zoom: number): void;
    centerOn(point: { x: number; y: number }): void;
  };
  drawpaneFrames?: { exact: boolean };
  drawpaneEngineView?: { last: { exact: boolean; supported: boolean }; reducedImages: number };
}

async function openEngineTab(instance: Instance): Promise<Page> {
  const tab = await instance.context.newPage();
  await tab.addInitScript(() => {
    try {
      localStorage.setItem("drawpane:debug", "1");
      localStorage.setItem("drawpane:renderer", "engine");
      localStorage.setItem("drawpane:engine-software", "allow");
      localStorage.setItem("drawpane:engine-present", "readback");
    } catch {
      // Ignore opaque origins before navigation.
    }
  });
  if (tab.context().browser()?.browserType().name() === "chromium") {
    const cdp = await tab.context().newCDPSession(tab);
    await cdp.send("Network.enable");
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  }
  return tab;
}

async function waitForLive(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const w = window as unknown as DebugWindow;
      return w.drawpane?.s.status === "live" && Boolean(w.drawpaneEngineView);
    },
    undefined,
    { timeout: 60_000 },
  );
}

test.describe
  .serial("Progressive image loading", () => {
    test.skip(!!process.env.E2E_BASE_URL, "Needs its own local instance.");

    let instance: Instance;
    let fileId = "";
    let sha = "";

    test.beforeAll(async ({ browser }) => {
      test.setTimeout(180_000);
      instance = await freshInstance(browser, { port: PORT, inspectorPort: PORT + 540 });
      const png = makeTexturedSplitPng(2000, 1500);
      // Upload the original without previews first to exercise pre-existing image backfill.
      const seedFileId = await importNodes(
        instance.page,
        [
          { id: "p1", parent: ROOT_ID, key: "a0", type: "page", props: { name: "Page 1" } },
          {
            id: "backdrop",
            parent: "p1",
            key: "a0",
            type: "frame",
            props: {
              name: "Overview",
              x: 0,
              y: 0,
              width: 24000,
              height: 15000,
              fills: [{ type: "solid", color: "#f5f5f5" }],
            },
          },
        ],
        "Progressive seed",
      );
      const up = await instance.page.request.post(`/api/files/${seedFileId}/media`, {
        data: Buffer.from(png),
        headers: { "content-type": "image/png" },
      });
      expect(up.status()).toBe(201);
      const info = (await up.json()) as { sha: string; width: number; height: number };
      expect(info).toMatchObject({ width: 2000, height: 1500 });
      sha = info.sha;

      // Wide overview board ensures Fit view draws the 1600x1200 hero small (inside w=256 tier).
      fileId = await importNodes(
        instance.page,
        [
          { id: "p1", parent: ROOT_ID, key: "a0", type: "page", props: { name: "Page 1" } },
          {
            id: "backdrop",
            parent: "p1",
            key: "a0",
            type: "frame",
            props: {
              name: "Overview",
              x: 0,
              y: 0,
              width: 24000,
              height: 15000,
              fills: [{ type: "solid", color: "#f5f5f5" }],
            },
          },
          {
            id: "hero",
            parent: "p1",
            key: "a1",
            type: "rect",
            props: {
              name: "Hero Photo",
              x: 400,
              y: 400,
              width: 1600,
              height: 1200,
              fills: [{ type: "image", ref: sha, scaleMode: "fill" }],
            },
          },
        ],
        "Progressive test",
      );
    });

    test.afterAll(async () => {
      await instance?.stop();
    });

    test("backfills missing previews on first editor open so subsequent loads serve cached previews", async () => {
      test.setTimeout(120_000);
      const tab1 = await openEngineTab(instance);
      const firstGets: Array<{ url: string; missing: string | null; preview: string | null }> = [];
      const putStatuses: Array<{ url: string; status: number }> = [];
      tab1.on("response", (res) => {
        const u = new URL(res.url());
        if (res.request().method() === "GET" && u.pathname === `/api/media/${sha}`) {
          firstGets.push({
            url: `${u.pathname}${u.search}`,
            missing: res.headers()["x-image-preview-missing"] ?? null,
            preview: res.headers()["x-image-preview"] ?? null,
          });
        }
        if (
          res.request().method() === "PUT" &&
          u.pathname.startsWith(`/api/media/${sha}/previews/`)
        ) {
          putStatuses.push({ url: u.pathname, status: res.status() });
        }
      });
      try {
        await tab1.goto(`/f/${fileId}`);
        await waitForLive(tab1);
        await expect
          .poll(
            () =>
              tab1.evaluate(() => {
                const w = window as unknown as DebugWindow;
                return {
                  exact: Boolean(w.drawpaneFrames?.exact && w.drawpaneEngineView?.last.exact),
                  reduced: w.drawpaneEngineView?.reducedImages ?? -1,
                };
              }),
            { timeout: 30_000 },
          )
          .toEqual({ exact: true, reduced: 0 });
        expect(firstGets.some((g) => g.missing === "1" && g.preview === null)).toBe(true);

        // Background backfill uploads both 256 and 1024 previews for the pre-existing image.
        await expect
          .poll(
            () =>
              putStatuses
                .filter((p) => p.status === 201 || p.status === 200)
                .map((p) => p.url)
                .sort(),
            { timeout: 30_000 },
          )
          .toEqual([`/api/media/${sha}/previews/1024`, `/api/media/${sha}/previews/256`]);
      } finally {
        await tab1.close();
      }

      // Second tab receives the stored preview on ?w=256 and still upgrades to original for exact=true.
      const tab2 = await openEngineTab(instance);
      const secondGets: Array<{ url: string; preview: string | null; type: string | null }> = [];
      tab2.on("response", (res) => {
        const u = new URL(res.url());
        if (res.request().method() === "GET" && u.pathname === `/api/media/${sha}`) {
          secondGets.push({
            url: `${u.pathname}${u.search}`,
            preview: res.headers()["x-image-preview"] ?? null,
            type: res.headers()["content-type"] ?? null,
          });
        }
      });
      try {
        await tab2.goto(`/f/${fileId}`);
        await waitForLive(tab2);
        await expect
          .poll(
            () =>
              tab2.evaluate(() => {
                const w = window as unknown as DebugWindow;
                return {
                  exact: Boolean(w.drawpaneFrames?.exact && w.drawpaneEngineView?.last.exact),
                  reduced: w.drawpaneEngineView?.reducedImages ?? -1,
                };
              }),
            { timeout: 30_000 },
          )
          .toEqual({ exact: true, reduced: 0 });
        const previewHit = secondGets.find((g) => g.url === `/api/media/${sha}?w=256`);
        expect(previewHit?.preview).toBe("256");
        expect(previewHit?.type).toBe("image/jpeg");
        // Strict exactness rule: bare original was also fetched so the settled exact frame uses original pixels.
        expect(
          secondGets.some((g) => g.url === `/api/media/${sha}` && g.type === "image/png"),
        ).toBe(true);
      } finally {
        await tab2.close();
      }
    });

    test("previews are never exact: shows w=256 immediately with exact=false while full original is held, then settles exact=true", async () => {
      test.setTimeout(120_000);
      const tab = await openEngineTab(instance);
      const fullGate: { released: boolean; requested: boolean; waiters: Array<() => void> } = {
        released: false,
        requested: false,
        waiters: [],
      };
      const releaseFull = () => {
        fullGate.released = true;
        for (const done of fullGate.waiters.splice(0)) done();
      };
      const seenUrls: string[] = [];

      await tab.route(`**/api/media/${sha}**`, async (route) => {
        const url = new URL(route.request().url());
        seenUrls.push(`${url.pathname}${url.search}`);
        if (!url.searchParams.has("w") && !fullGate.released) {
          fullGate.requested = true;
          await new Promise<void>((resolve) => {
            fullGate.waiters.push(resolve);
          });
        }
        await route.continue();
      });

      try {
        await tab.goto(`/f/${fileId}`);
        await waitForLive(tab);

        // Even at Fit zoom, the preview displays immediately while full original is requested and held.
        await expect.poll(() => fullGate.requested, { timeout: 30_000 }).toBe(true);
        expect(seenUrls).toContain(`/api/media/${sha}?w=256`);

        // Zoom onto the hero while full is still held: preview renders visibly AND exact MUST be false.
        await tab.evaluate(() => {
          const w = window as unknown as DebugWindow;
          const e = w.drawpane;
          const bounds = e?.scene.bounds("hero");
          if (e && bounds) {
            e.zoomTo(1);
            e.centerOn({ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 });
          }
        });

        await expect
          .poll(
            async () => {
              const box = await tab.evaluate(() => {
                const c = document.querySelector<HTMLCanvasElement>('[data-canvas-role="engine"]');
                const r = c?.getBoundingClientRect();
                return r ? { cx: r.left + r.width / 2, cy: r.top + r.height / 2 } : null;
              });
              if (!box) return { blueOk: false, orangeOk: false, exact: true };
              const [lr, , lb] = parseHex(await canvasColor(tab, { x: box.cx - 120, y: box.cy }));
              const [rr, , rb] = parseHex(await canvasColor(tab, { x: box.cx + 120, y: box.cy }));
              const exact = await tab.evaluate(() => {
                const w = window as unknown as DebugWindow;
                return Boolean(w.drawpaneFrames?.exact || w.drawpaneEngineView?.last.exact);
              });
              return {
                blueOk: lb > 160 && lr < 100,
                orangeOk: rr > 190 && rb < 90,
                exact,
              };
            },
            { timeout: 30_000 },
          )
          .toEqual({ blueOk: true, orangeOk: true, exact: false });

        // Release full original: frame upgrades and settles exact=true with reducedImages=0.
        releaseFull();
        await expect
          .poll(
            () =>
              tab.evaluate(() => {
                const w = window as unknown as DebugWindow;
                return {
                  exact: Boolean(w.drawpaneFrames?.exact && w.drawpaneEngineView?.last.exact),
                  reduced: w.drawpaneEngineView?.reducedImages ?? -1,
                };
              }),
            { timeout: 30_000 },
          )
          .toEqual({ exact: true, reduced: 0 });
      } finally {
        releaseFull();
        await tab.close();
      }
    });

    test("falls back cleanly to the bare original URL when ?w= returns 500", async () => {
      const tab = await openEngineTab(instance);
      const seen: Array<{ url: string; status: number }> = [];
      await tab.route(`**/api/media/${sha}?w=*`, async (route) => {
        await route.fulfill({ status: 500, body: "preview failure" });
      });
      tab.on("response", (res) => {
        const u = new URL(res.url());
        if (u.pathname === `/api/media/${sha}`) {
          seen.push({ url: `${u.pathname}${u.search}`, status: res.status() });
        }
      });
      try {
        await tab.goto(`/f/${fileId}`);
        await waitForLive(tab);
        await expect
          .poll(
            () =>
              tab.evaluate(() => {
                const w = window as unknown as DebugWindow;
                return {
                  exact: Boolean(w.drawpaneFrames?.exact && w.drawpaneEngineView?.last.exact),
                  reduced: w.drawpaneEngineView?.reducedImages ?? -1,
                };
              }),
            { timeout: 30_000 },
          )
          .toEqual({ exact: true, reduced: 0 });
        expect(seen.some((s) => s.url === `/api/media/${sha}?w=256` && s.status === 500)).toBe(
          true,
        );
        expect(seen.some((s) => s.url === `/api/media/${sha}` && s.status === 200)).toBe(true);
      } finally {
        await tab.close();
      }
    });

    test("original upload succeeds when preview PUT fails with 500", async () => {
      const tab = await openEngineTab(instance);
      const previewPutStatuses: number[] = [];
      await tab.route("**/api/media/*/previews/*", async (route) => {
        previewPutStatuses.push(500);
        await route.fulfill({ status: 500, body: "preview store unavailable" });
      });
      try {
        await tab.goto(`/f/${fileId}`);
        await waitForLive(tab);
        const png = makeTexturedSplitPng(600, 400, 0x99887766);
        const uploaded = tab.waitForResponse(
          (r) => r.url().endsWith("/media") && r.request().method() === "POST",
        );
        await tab.evaluate(
          ({ bytes }) => {
            const file = new File([new Uint8Array(bytes)], "preview-fail-test.png", {
              type: "image/png",
            });
            const data = new DataTransfer();
            data.items.add(file);
            const target = document.querySelector(".canvas__overlay");
            target?.dispatchEvent(
              new DragEvent("drop", {
                dataTransfer: data,
                clientX: 400,
                clientY: 300,
                bubbles: true,
                cancelable: true,
              }),
            );
          },
          { bytes: [...png] },
        );
        const res = await uploaded;
        expect(res.status()).toBe(201);
        await expect(tab.getByRole("region", { name: "Image uploads" })).toContainText("Done", {
          timeout: 15_000,
        });
        await expect.poll(() => previewPutStatuses.length, { timeout: 15_000 }).toBeGreaterThan(0);
      } finally {
        await tab.close();
      }
    });

    test("exports always fetch the full-resolution original without ?w=", async () => {
      const tab = await openEngineTab(instance);
      const exportRequests: Array<{ url: string; type: string | null }> = [];
      tab.on("response", (res) => {
        if (new URL(res.url()).pathname === `/api/media/${sha}`) {
          exportRequests.push({
            url: res.url(),
            type: res.headers()["content-type"] ?? null,
          });
        }
      });
      try {
        await tab.goto(`/f/${fileId}`);
        await waitForLive(tab);
        await expect
          .poll(
            () =>
              tab.evaluate(() => Boolean((window as unknown as DebugWindow).drawpaneFrames?.exact)),
            { timeout: 30_000 },
          )
          .toBe(true);

        exportRequests.length = 0;
        await tab.getByRole("treeitem", { name: /Hero Photo/ }).click();
        const downloadPromise = tab.waitForEvent("download");
        await tab.keyboard.press("ControlOrMeta+Shift+E");
        const download = await downloadPromise;
        expect(download.suggestedFilename()).toBe("Hero Photo.png");
        const bytes = readFileSync(await download.path());
        expect(pngSize(bytes)).toEqual({ width: 1600, height: 1200 });

        // Export must fetch only the bare original PNG URL (never ?w=).
        const bareOriginal = exportRequests.find((r) => r.url.endsWith(`/api/media/${sha}`));
        expect(bareOriginal).toBeDefined();
        expect(bareOriginal?.type).toBe("image/png");
        expect(exportRequests.every((r) => !new URL(r.url).searchParams.has("w"))).toBe(true);
      } finally {
        await tab.close();
      }
    });
  });
