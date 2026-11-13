import { describe, expect, it, vi } from "vitest";
import { ImageCache, imagePlacement, type LoadedImage, layoutImageRow } from "../src/images";

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
});
