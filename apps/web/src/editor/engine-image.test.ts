import type { ImageCache, ImageDemand } from "@drawpane/editor";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ViewImages } from "./engine-image";

afterEach(() => vi.unstubAllGlobals());

describe("image residency", () => {
  it("holds sharp levels for 40 large photos and rebuilds them after pressure", async () => {
    vi.stubGlobal("createImageBitmap", async (_blob: Blob, options: ImageBitmapOptions) => ({
      width: options.resizeWidth,
      height: options.resizeHeight,
      close() {},
    }));
    const source = {
      blob: new Blob(),
      size: { width: 1792, height: 2400 },
    };
    const cache = { encoded: async () => source } as unknown as ImageCache;
    const images = new ViewImages(
      cache,
      () => {},
      () => {},
    );
    const held = new Map<string, number>();
    const limit = { side: 4096, bytes: 8 << 20 };
    let peak = 0;
    let total = 0;
    images.setBackend({
      upload(handle, bitmap) {
        const size = bitmap.width * bitmap.height * 4;
        held.set(`${handle}/${bitmap.width}`, size);
        total += size;
        peak = Math.max(peak, total);
        return true;
      },
      drop(handle, width) {
        const key = `${handle}/${width}`;
        total -= held.get(key) ?? 0;
        held.delete(key);
      },
    });
    const photos = Array.from({ length: 40 }, (_, i) => ({
      ref: String(i),
      span: 100,
      visible: true,
    })) satisfies ImageDemand[];
    try {
      await vi.waitFor(() => expect(images.update(photos, 1, false, limit)).toBe(true), {
        timeout: 3000,
        interval: 2,
      });
      for (const { ref } of photos) expect(held.has(`${images.info(ref)?.handle}/112`)).toBe(true);
      const panned = photos.slice(10);
      await vi.waitFor(() => expect(images.update(panned, 1.4, true, limit)).toBe(true), {
        timeout: 3000,
        interval: 2,
      });
      for (const { ref } of panned) expect(held.has(`${images.info(ref)?.handle}/224`)).toBe(true);
      images.evict();
      expect(images.residentBytes).toBe(0);
      expect(total).toBe(0);
      await vi.waitFor(() => expect(images.update(photos, 1, false, limit)).toBe(true), {
        timeout: 3000,
        interval: 2,
      });
      expect(peak).toBeLessThanOrEqual(limit.bytes);
    } finally {
      images.setBackend(null);
    }
  });
});
