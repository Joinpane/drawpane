import { ROOT_ID } from "@drawpane/model";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Doc } from "../src/doc";
import {
  ImageCache,
  imagePlacement,
  type LoadedImage,
  layoutImageRow,
  mediaUrl,
} from "../src/images";
import { CanvasRenderer } from "../src/render";
import { Scene } from "../src/scene";

describe("imagePlacement", () => {
  const box = { width: 200, height: 100 };

  it("fill covers the box, centred, cropping the overflow", () => {
    // A square image in a 2:1 box scales to the width and overflows top and bottom.
    expect(imagePlacement("fill", box, { width: 50, height: 50 })).toEqual({
      x: 0,
      y: -50,
      width: 200,
      height: 200,
      tile: false,
    });
    // A tall image in a wide box: same rule, the other way round.
    expect(imagePlacement("fill", { width: 100, height: 100 }, { width: 50, height: 200 })).toEqual(
      { x: 0, y: -150, width: 100, height: 400, tile: false },
    );
  });

  it("fit sits inside the box, centred, letterboxed", () => {
    expect(imagePlacement("fit", box, { width: 50, height: 50 })).toEqual({
      x: 50,
      y: 0,
      width: 100,
      height: 100,
      tile: false,
    });
    expect(imagePlacement("fit", box, { width: 400, height: 100 })).toEqual({
      x: 0,
      y: 25,
      width: 200,
      height: 50,
      tile: false,
    });
  });

  it("stretch matches the box, tile repeats at natural size", () => {
    expect(imagePlacement("stretch", box, { width: 7, height: 3 })).toEqual({
      x: 0,
      y: 0,
      width: 200,
      height: 100,
      tile: false,
    });
    expect(imagePlacement("tile", box, { width: 32, height: 24 })).toEqual({
      x: 0,
      y: 0,
      width: 32,
      height: 24,
      tile: true,
    });
  });

  it("keeps the aspect ratio for fill and fit whatever the sizes", () => {
    for (const [w, h, iw, ih] of [
      [10, 300, 640, 480],
      [1, 1, 3, 2],
      [999, 7, 12, 1000],
    ] as const) {
      for (const mode of ["fill", "fit"] as const) {
        const p = imagePlacement(mode, { width: w, height: h }, { width: iw, height: ih });
        expect(p.width / p.height).toBeCloseTo(iw / ih, 6);
        // Centred in both directions.
        expect(p.x + p.width / 2).toBeCloseTo(w / 2, 6);
        expect(p.y + p.height / 2).toBeCloseTo(h / 2, 6);
        if (mode === "fill") expect(p.width >= w - 1e-9 && p.height >= h - 1e-9).toBe(true);
        else expect(p.width <= w + 1e-9 && p.height <= h + 1e-9).toBe(true);
      }
    }
  });
});

describe("layoutImageRow", () => {
  it("keeps natural sizes and centres the row on the point", () => {
    const rects = layoutImageRow(
      [
        { width: 100, height: 50 },
        { width: 60, height: 80 },
      ],
      { x: 500, y: 300 },
      { width: 1000, height: 1000 },
      20,
    );
    expect(rects).toEqual([
      { x: 410, y: 260, width: 100, height: 50 },
      { x: 530, y: 260, width: 60, height: 80 },
    ]);
  });

  it("scales each image down, never up, to fit the viewport", () => {
    const [big, small] = layoutImageRow(
      [
        { width: 4000, height: 2000 },
        { width: 10, height: 10 },
      ],
      { x: 0, y: 0 },
      { width: 800, height: 600 },
    );
    expect(big).toMatchObject({ width: 800, height: 400 });
    expect(small).toMatchObject({ width: 10, height: 10 });
  });
});

type FakeBitmap = ImageBitmap & { closed: boolean };

function bitmap(width: number, height: number): FakeBitmap {
  const b = {
    width,
    height,
    closed: false,
    close() {
      b.closed = true;
    },
  };
  return b as unknown as FakeBitmap;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function deferredLoader() {
  const calls: Array<{
    sha: string;
    resolve: (image: LoadedImage) => void;
    reject: (error: Error) => void;
  }> = [];
  const load = (sha: string) =>
    new Promise<LoadedImage>((resolve, reject) => calls.push({ sha, resolve, reject }));
  return { calls, load };
}

describe("ImageCache", () => {
  it("loads once, tells subscribers, then draws", async () => {
    const { calls, load } = deferredLoader();
    const cache = new ImageCache({ load });
    const listener = vi.fn();
    cache.subscribe(listener);
    expect(cache.get("a")).toBeNull();
    expect(cache.get("a")).toBeNull();
    expect(calls).toHaveLength(1);
    expect(cache.status("a")).toBe("loading");
    const b = bitmap(100, 50);
    calls[0]?.resolve({ bitmap: b, naturalWidth: 100, naturalHeight: 50 });
    await flush();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(cache.natural("a")).toEqual({ width: 100, height: 50 });
    expect(cache.get("a")?.bitmap).toBe(b);
    expect(cache.bytes).toBe(100 * 50 * 4);
  });

  it("retries a failed load after a back-off", async () => {
    let now = 0;
    const { calls, load } = deferredLoader();
    const cache = new ImageCache({ load, retryMs: 1000, now: () => now });
    cache.get("a");
    calls[0]?.reject(new Error("404"));
    await flush();
    expect(cache.status("a")).toBe("error");
    cache.get("a");
    expect(calls).toHaveLength(1);
    now = 1000;
    cache.get("a");
    expect(calls).toHaveLength(2);
    calls[1]?.reject(new Error("404"));
    await flush();
    // The second wait is twice as long.
    now = 2500;
    cache.get("a");
    expect(calls).toHaveLength(2);
    now = 3000;
    cache.get("a");
    expect(calls).toHaveLength(3);
    // After eight failures it stops asking.
    for (let i = 2; i < 8; i++) {
      calls[i]?.reject(new Error("404"));
      await flush();
      now += 120_000;
      cache.get("a");
    }
    expect(calls).toHaveLength(8);
    calls[7]?.reject(new Error("404"));
    await flush();
    now += 3_600_000;
    cache.get("a");
    expect(calls).toHaveLength(8);
    expect(cache.status("a")).toBe("error");
  });

  it("evicts the least recently drawn images past its budget, never the current frame's", async () => {
    const cache = new ImageCache({
      load: async () => ({ bitmap: bitmap(10, 10), naturalWidth: 10, naturalHeight: 10 }),
      maxBytes: 1000, // two 10 × 10 bitmaps (400 bytes each)
    });
    cache.frame();
    cache.get("a");
    cache.get("b");
    await flush();
    expect(cache.size).toBe(2);
    // Two frames later, a and b are old; c pushes the cache over budget and a goes first.
    cache.frame();
    cache.frame();
    cache.get("b");
    cache.get("c");
    await flush();
    expect(cache.status("a")).toBeNull();
    expect(cache.status("b")).toBe("ready");
    expect(cache.status("c")).toBe("ready");
    expect(cache.bytes).toBeLessThanOrEqual(1000);
  });

  it("keeps a frame's images even over budget, and closes what it evicts", async () => {
    const made: FakeBitmap[] = [];
    const cache = new ImageCache({
      load: async () => {
        const b = bitmap(20, 20);
        made.push(b);
        return { bitmap: b, naturalWidth: 20, naturalHeight: 20 };
      },
      maxBytes: 100,
    });
    cache.frame();
    cache.get("a");
    cache.get("b");
    await flush();
    expect(cache.size).toBe(2);
    expect(made.some((b) => b.closed)).toBe(false);
    cache.frame();
    cache.frame();
    expect(cache.size).toBe(0);
    expect(made.every((b) => b.closed)).toBe(true);
  });

  it("draws a downscaled copy at low zoom once it's made", async () => {
    const resize = vi.fn(async (_b: ImageBitmap, w: number, h: number) => bitmap(w, h));
    const full = bitmap(1024, 512);
    const cache = new ImageCache({
      load: async () => ({ bitmap: full, naturalWidth: 2048, naturalHeight: 1024 }),
      resize,
    });
    cache.get("a");
    await flush();
    // Shown 1000 px wide: the full bitmap is the right size.
    expect(cache.get("a", 1000)?.bitmap).toBe(full);
    expect(resize).not.toHaveBeenCalled();
    // Shown 200 px wide: 256 is the smallest halving that stays sharp; full until it's ready.
    expect(cache.get("a", 200)?.bitmap).toBe(full);
    expect(resize).toHaveBeenCalledWith(full, 256, 128);
    await flush();
    const view = cache.get("a", 200);
    expect(view?.bitmap.width).toBe(256);
    // The natural size is the image's, not the bitmap's.
    expect(view?.naturalWidth).toBe(2048);
    expect(resize).toHaveBeenCalledTimes(1);
  });

  it("takes images decoded elsewhere and waits for pending ones", async () => {
    const { calls, load } = deferredLoader();
    const cache = new ImageCache({ load });
    cache.put("local", { bitmap: bitmap(3, 2), naturalWidth: 3, naturalHeight: 2 });
    expect(cache.get("local")?.naturalWidth).toBe(3);
    let done = false;
    const ready = cache.ready(["local", "remote"]).then(() => {
      done = true;
    });
    await flush();
    expect(done).toBe(false);
    calls[0]?.resolve({ bitmap: bitmap(1, 1), naturalWidth: 1, naturalHeight: 1 });
    await ready;
    expect(done).toBe(true);
  });

  it("passes ?w= only when preview is requested and always uses originals for default loads and exports", async () => {
    const requested: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        requested.push(url);
        const w = new URL(url, "https://drawpane.test").searchParams.get("w");
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: {
            "content-type": w ? "image/webp" : "image/png",
            "x-image-width": "3000",
            "x-image-height": "2000",
            ...(w ? { "x-image-preview": w } : {}),
          },
        });
      }),
    );
    vi.stubGlobal("createImageBitmap", async () => bitmap(3000, 2000));
    try {
      expect(mediaUrl("abc")).toBe("/api/media/abc");
      expect(mediaUrl("abc", 256)).toBe("/api/media/abc?w=256");
      expect(mediaUrl("abc", 1024)).toBe("/api/media/abc?w=1024");

      const cache = new ImageCache();
      const signal = new AbortController().signal;
      const small = await cache.encoded("abc", signal, { preview: 256 });
      expect(small.preview).toBe(256);
      expect(small.size).toEqual({ width: 3000, height: 2000 });

      // Export path calls encoded(sha, signal) with no preview option -> full original.
      const original = await cache.encoded("abc", signal);
      expect(original.preview).toBeUndefined();
      expect(original.size).toEqual({ width: 3000, height: 2000 });

      // Default canvas/export loader (get / ready) also fetches the bare original URL.
      await cache.ready(["abc"]);
      expect(requested).toEqual(["/api/media/abc?w=256", "/api/media/abc", "/api/media/abc"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("falls back to the bare original URL whenever a ?w= preview request fails or 404s", async () => {
    const requested: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        requested.push(url);
        const w = new URL(url, "https://drawpane.test").searchParams.get("w");
        if (w === "256") return new Response("not found", { status: 404 });
        if (w === "1024") throw new TypeError("network failed");
        return new Response(new Uint8Array([9, 8, 7]), {
          status: 200,
          headers: { "content-type": "image/png", "x-image-width": "800", "x-image-height": "600" },
        });
      }),
    );
    try {
      const cache = new ImageCache();
      const from404 = await cache.encoded("sha1", new AbortController().signal, { preview: 256 });
      expect(from404.preview).toBeUndefined();
      expect(from404.size).toEqual({ width: 800, height: 600 });
      expect(new Uint8Array(await from404.blob.arrayBuffer())).toEqual(new Uint8Array([9, 8, 7]));

      const fromNetErr = await cache.encoded("sha2", new AbortController().signal, {
        preview: 1024,
      });
      expect(fromNetErr.preview).toBeUndefined();
      expect(fromNetErr.size).toEqual({ width: 800, height: 600 });
      expect(requested).toEqual([
        "/api/media/sha1?w=256",
        "/api/media/sha1",
        "/api/media/sha2?w=1024",
        "/api/media/sha2",
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("can retry a transient request once without retrying a missing image", async () => {
    const fetchImage = vi.fn(async () => new Response(null, { status: 404 }));
    fetchImage.mockResolvedValueOnce(new Response(null, { status: 503 }));
    fetchImage.mockResolvedValueOnce(new Response(new Uint8Array([1])));
    vi.stubGlobal("fetch", fetchImage);
    const cache = new ImageCache();
    const signal = new AbortController().signal;
    const options = { retryTransient: true };
    expect((await cache.encoded("available", signal, options)).blob.size).toBe(1);
    await expect(cache.encoded("missing", signal, options)).rejects.toThrow("404");
    expect(fetchImage).toHaveBeenCalledTimes(3);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("bounded display images", () => {
  const maxBytes = 2 * 256 * 256 * 4;
  const resize = async (_b: ImageBitmap, width: number, height: number) => bitmap(width, height);

  function draw(cache: ImageCache, refs: string[], width = 256): void {
    cache.frame();
    for (const ref of refs) cache.get(ref, width);
  }

  it("keeps every visible image when the working set grows, then sharpens in place", async () => {
    const header = new Uint8Array(32);
    header.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
    const size = new DataView(header.buffer);
    size.setUint32(16, 512);
    size.setUint32(20, 512);
    const fetchImage = vi.fn(async () => new Response(header));
    vi.stubGlobal("fetch", fetchImage);
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async (_source, options?: ImageBitmapOptions) =>
        bitmap(options?.resizeWidth ?? 512, options?.resizeHeight ?? 512),
      ),
    );
    const cache = new ImageCache({ maxBytes, maxSide: 256, enforceMaxBytes: true, resize });
    try {
      draw(cache, ["a", "b"]);
      await vi.waitFor(() => expect(cache.bytes).toBe(maxBytes));
      draw(cache, ["a", "b", "c", "d"]);
      await vi.waitFor(() => {
        expect(["a", "b", "c", "d"].map((ref) => cache.status(ref))).toEqual(
          Array(4).fill("ready"),
        );
      });
      expect(cache.bytes).toBeLessThanOrEqual(maxBytes);
      expect(cache.get("d", 256)?.bitmap.width).toBeLessThan(256);

      for (let i = 0; i < 10; i++) {
        draw(cache, ["a", "b", "c"]);
        await flush();
        draw(cache, ["a", "b", "c", "d"]);
        await flush();
      }
      expect(fetchImage).toHaveBeenCalledTimes(4);

      draw(cache, ["d"]);
      await vi.waitFor(() => expect(cache.get("d", 256)?.bitmap.width).toBe(256));
      expect(fetchImage).toHaveBeenCalledTimes(4);
      expect(cache.bytes).toBeLessThanOrEqual(maxBytes);
    } finally {
      cache.clear();
      vi.unstubAllGlobals();
    }
  });

  it("drops decode work that was queued for an image that left the view", async () => {
    const { calls, load } = deferredLoader();
    const cache = new ImageCache({ maxBytes, maxSide: 256, enforceMaxBytes: true, resize, load });
    draw(cache, ["a", "b", "c"]);
    await flush();
    expect(calls.map(({ sha }) => sha)).toEqual(["a", "b"]);
    draw(cache, ["a", "b", "d"]);
    const resolve = (i: number) =>
      calls[i]?.resolve({ bitmap: bitmap(256, 256), naturalWidth: 256, naturalHeight: 256 });
    resolve(0);
    resolve(1);
    await flush();
    expect(calls.map(({ sha }) => sha)).toEqual(["a", "b", "d"]);
    resolve(2);
    await flush();
    cache.clear();
  });

  it("keeps settled sizes when a small preview briefly joins a full view", async () => {
    const cache = new ImageCache({
      maxBytes: 12 * 256 * 256 * 4,
      maxSide: 256,
      enforceMaxBytes: true,
      resize,
      load: async () => ({ bitmap: bitmap(256, 256), naturalWidth: 256, naturalHeight: 256 }),
    });
    const editor = {};
    const preview = {};
    const demands = new Map(Array.from({ length: 12 }, (_, i) => [`photo-${i}`, 256]));
    try {
      cache.setDisplayView(editor, demands);
      await vi.waitFor(() => expect([...demands].every(([ref]) => cache.peek(ref))).toBe(true));
      const initial = [...demands].map(([ref]) => cache.peek(ref)?.bitmap);
      cache.setDisplayView(preview, new Map([["preview", 64]]));
      await vi.waitFor(() => expect(cache.peek("preview")).not.toBeNull());
      cache.releaseDisplayView(preview);
      await new Promise((resolve) => setTimeout(resolve, 200));
      for (const [index, ref] of [...demands.keys()].entries()) {
        expect(cache.peek(ref)?.bitmap).toBe(initial[index]);
      }
    } finally {
      cache.clear();
    }
  });

  it("retries a transient failure while its view is idle", async () => {
    const load = vi.fn(async () => ({
      bitmap: bitmap(64, 64),
      naturalWidth: 64,
      naturalHeight: 64,
    }));
    load.mockRejectedValueOnce(new Error("Temporary network error"));
    const cache = new ImageCache({ enforceMaxBytes: true, load, retryMs: 30 });
    const owner = {};
    try {
      cache.setDisplayView(owner, new Map([["photo", 64]]));
      await vi.waitFor(() => expect(cache.status("photo")).toBe("ready"));
      expect(load).toHaveBeenCalledTimes(2);
    } finally {
      cache.clear();
    }
  });

  it("overlaps small source decodes and runs an oversized source alone", async () => {
    const header = (width: number, height: number) => {
      const bytes = new Uint8Array(32);
      bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
      const view = new DataView(bytes.buffer);
      view.setUint32(16, width);
      view.setUint32(20, height);
      return bytes;
    };
    vi.stubGlobal(
      "fetch",
      async (url: string) =>
        new Response(url.endsWith("/large") ? header(8000, 6000) : header(512, 512)),
    );
    const pending: (() => void)[] = [];
    vi.stubGlobal(
      "createImageBitmap",
      (_: Blob, options: ImageBitmapOptions) =>
        new Promise((resolve) => {
          pending.push(() =>
            resolve(bitmap(options.resizeWidth ?? 512, options.resizeHeight ?? 512)),
          );
        }),
    );
    const cache = new ImageCache({ enforceMaxBytes: true, decodeBytes: 16 * 1024 * 1024 });
    const owner = {};
    const six = Array.from({ length: 6 }, (_, i) => [`small-${i}`, 64] as const);
    try {
      cache.setDisplayView(owner, new Map(six));
      await vi.waitFor(() => expect(pending).toHaveLength(6));
      cache.setDisplayView(owner, new Map([...six, ["large", 64]]));
      for (const resolve of pending.splice(0)) resolve();
      await vi.waitFor(() => expect(pending).toHaveLength(1));
      cache.setDisplayView(owner, new Map([...six, ["large", 64], ["extra", 64]]));
      await vi.waitFor(() => expect(cache.natural("extra")).not.toBeNull());
      expect(pending).toHaveLength(1);
      pending.shift()?.();
      await vi.waitFor(() => expect(pending).toHaveLength(1));
      pending.shift()?.();
      await vi.waitFor(() => expect(cache.status("extra")).toBe("ready"));
    } finally {
      for (const resolve of pending.splice(0)) resolve();
      cache.clear();
    }
  });
});

describe("shared mobile image cache", () => {
  it("keeps the main canvas's image when an independent preview draws repeatedly", async () => {
    vi.stubGlobal(
      "Path2D",
      class {
        rect() {}
      },
    );
    const bytes = 256 * 256 * 4;
    const cache = new ImageCache({
      maxBytes: bytes,
      maxSide: 256,
      enforceMaxBytes: true,
      load: async () => ({
        bitmap: bitmap(256, 256),
        naturalWidth: 256,
        naturalHeight: 256,
      }),
      resize: async (_b, width, height) => bitmap(width, height),
    });
    const doc = new Doc();
    const mainRef = "a".repeat(64);
    const previewRefs = ["b", "c", "d", "e"].map((prefix) => prefix.repeat(64));
    doc.apply([{ op: "create", id: "page", parent: ROOT_ID, type: "page", key: "a0", props: {} }]);
    for (const [index, ref] of [mainRef, ...previewRefs].entries()) {
      doc.apply([
        {
          op: "create",
          id: ref,
          parent: "page",
          type: "rect",
          key: `a${index}`,
          props: { width: 256, height: 256, fills: [{ type: "image", ref, scaleMode: "fill" }] },
        },
      ]);
    }
    const scene = new Scene(doc);
    const measurer = { width: () => 0 };
    const main = new CanvasRenderer(scene, measurer, { images: cache });
    const preview = new CanvasRenderer(scene, measurer, { images: cache });
    const rect = { x: 0, y: 0, width: 256, height: 256 };
    const context = () => ({
      canvas: { width: 256, height: 256 },
      clearRect: vi.fn(),
      clip: vi.fn(),
      drawImage: vi.fn(),
      fillRect: vi.fn(),
      getTransform: () => ({ a: 1, b: 0 }),
      restore: vi.fn(),
      save: vi.fn(),
      setTransform: vi.fn(),
    });
    const mainContext = context();
    const previewContext = context();
    const draw = (renderer: CanvasRenderer, ctx: ReturnType<typeof context>, ref: string) =>
      renderer.renderNodes(ctx as unknown as CanvasRenderingContext2D, [ref], rect, 1);
    try {
      draw(main, mainContext, mainRef);
      await vi.waitFor(() => expect(cache.peek(mainRef)?.bitmap.width).toBe(256));
      for (const ref of previewRefs) {
        draw(preview, previewContext, ref);
        await vi.waitFor(() => expect(cache.peek(ref)).not.toBeNull());
        mainContext.drawImage.mockClear();
        draw(main, mainContext, mainRef);
        expect(mainContext.drawImage).toHaveBeenCalledOnce();
        expect(cache.bytes).toBeLessThanOrEqual(bytes);
      }
      cache.releaseDisplayView(previewContext.canvas);
      await vi.waitFor(() => expect(cache.peek(mainRef)?.bitmap.width).toBe(256));
    } finally {
      cache.clear();
    }
  });

  it("does not decode for metadata callers with no Canvas frame and closes oversized seeds", async () => {
    const load = vi.fn(async () => ({
      bitmap: bitmap(256, 256),
      naturalWidth: 256,
      naturalHeight: 256,
    }));
    const cache = new ImageCache({ maxBytes: 1024, enforceMaxBytes: true, load });
    expect(cache.natural("inspection")).toBeNull();
    await flush();
    expect(load).not.toHaveBeenCalled();
    const supplied = bitmap(256, 256);
    cache.put("oversized", { bitmap: supplied, naturalWidth: 256, naturalHeight: 256 });
    expect(supplied.closed).toBe(true);
    expect(cache.natural("oversized")).toEqual({ width: 256, height: 256 });
    expect(cache.bytes).toBe(0);
  });
});
