import type { ImageCache, ImageDemand } from "@drawpane/editor";
import { afterEach, describe, expect, it, vi } from "vitest";
import { colorBitmap } from "./color-glyphs";
import { ViewImages } from "./engine-image";

vi.mock("./color-glyphs", () => ({ colorBitmap: vi.fn() }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(colorBitmap).mockReset();
});

const demand = (
  refs: readonly string[],
  width = 100,
  height = width,
  visible = true,
): ImageDemand[] => refs.map((ref) => ({ ref, visible, span: { width, height } }));

const limit = (mib: number) => ({ side: 4096, bytes: mib << 20 });

function photoRig(opts: { bad?: Set<string>; missing?: Set<string>; slow?: boolean } = {}) {
  const decodes = new Map<string, number>();
  const versions = new Map<string, number>();
  const held = new Map<number, Map<number, number>>();
  const gates: Array<() => void> = [];
  let blocked = opts.slow ?? false;
  let total = 0;
  let peak = 0;
  vi.stubGlobal(
    "createImageBitmap",
    async (blob: Blob & { ref: string }, o: ImageBitmapOptions) => {
      decodes.set(blob.ref, (decodes.get(blob.ref) ?? 0) + 1);
      if (blocked) await new Promise<void>((resolve) => gates.push(resolve));
      if (opts.bad?.has(blob.ref)) throw new Error("corrupt");
      return { width: o.resizeWidth, height: o.resizeHeight, close() {} };
    },
  );
  const cache = {
    encoded: async (ref: string) => {
      if (opts.missing?.has(ref)) throw new Error("404");
      return {
        blob: Object.assign(new Blob(), { ref }),
        size: { width: 1792, height: 2400 },
      };
    },
    encodedVersion: (ref: string) => versions.get(ref) ?? 0,
  } satisfies Pick<ImageCache, "encoded" | "encodedVersion">;
  const images = new ViewImages(
    cache,
    () => {},
    () => {},
  );
  images.setBackend({
    upload(handle, bitmap) {
      const levels = held.get(handle) ?? new Map();
      const size = bitmap.width * bitmap.height * 4;
      levels.set(bitmap.width, size);
      held.set(handle, levels);
      total += size;
      peak = Math.max(peak, total);
      return true;
    },
    drop(handle, width) {
      const levels = held.get(handle);
      total -= levels?.get(width) ?? 0;
      levels?.delete(width);
    },
  });
  return {
    images,
    held: (ref: string) => held.get(images.info(ref)?.handle ?? -1),
    decodes,
    versions,
    release: () => gates.shift()?.(),
    resume: () => {
      blocked = false;
      for (const done of gates.splice(0)) done();
    },
    get peak() {
      return peak;
    },
  };
}

const tick = () => new Promise((done) => setTimeout(done, 0));
const eventually = (check: () => void) => vi.waitFor(check, { timeout: 3500, interval: 5 });

describe("image residency", () => {
  it("uploads and evicts a generated colour glyph without requesting a media file", async () => {
    const ref = "emoji";
    const pixels = {
      ref,
      width: 64,
      height: 64,
      colorSpace: "srgb" as const,
      data: new Uint8ClampedArray(64 * 64 * 4),
    };
    vi.mocked(colorBitmap).mockReturnValue({ ref, pixels, width: 32, height: 32, x: 0, y: -32 });
    const r = photoRig({ missing: new Set([ref]) });
    try {
      const glyph = r.images.colorGlyph("😀", "32px sans-serif", 2);
      expect(glyph).toMatchObject({ ref, height: 32 });
      expect(r.images.colorGlyph("😀", "32px sans-serif", 2)?.handle).toBe(glyph?.handle);
      const uses = demand([ref], 32);
      expect(r.images.update(uses, 2, false, limit(8))).toBe(false);
      await eventually(() => expect(r.images.update(uses, 2, false, limit(8))).toBe(true));
      expect(r.held(ref)?.has(64)).toBe(true);
      r.images.retain(new Set());
      expect(r.images.info(ref)).toBeNull();
      expect(r.images.residentBytes).toBe(0);
    } finally {
      r.images.setBackend(null);
    }
  });

  it("settles a 40-photo page through slow and corrupt decodes, then rebuilds under budget", async () => {
    const refs = Array.from({ length: 39 }, (_, i) => String(i));
    const photos = demand([...refs, "bad"]);
    const r = photoRig({ bad: new Set(["bad"]), slow: true });
    try {
      expect(r.images.update(photos, 1, false, limit(8))).toBe(false);
      await eventually(() => {
        expect(r.images.update(photos, 1, false, limit(8))).toBe(false);
        expect(r.decodes.size).toBeGreaterThan(0);
      });
      expect(r.images.update(photos, 1, false, limit(8))).toBe(false);
      r.resume();
      await eventually(() => {
        expect(r.images.update(photos, 1, false, limit(8))).toBe(true);
        for (const ref of refs) expect(r.held(ref)?.has(112)).toBe(true);
      });
      expect(r.images.reduced).toBe(1);
      const panned = demand(refs.slice(10));
      await eventually(() => {
        expect(r.images.update(panned, 1.4, true, limit(8))).toBe(true);
        for (const { ref } of panned) expect(r.held(ref)?.has(224)).toBe(true);
      });
      r.images.evict();
      expect(r.images.residentBytes).toBe(0);
      await eventually(() => expect(r.images.update(photos, 1, false, limit(8))).toBe(true));
      expect(r.peak).toBeLessThanOrEqual(limit(8).bytes);
    } finally {
      r.resume();
      r.images.setBackend(null);
    }
  });

  it("keeps a visible photo's last level until its finer replacement arrives", async () => {
    const refs = Array.from({ length: 20 }, (_, i) => `p${i}`);
    const r = photoRig({ slow: true });
    const cap = limit(6);
    try {
      const unzoomed = demand(refs, 200);
      await eventually(() => {
        r.release();
        expect(r.images.update(unzoomed, 1, false, cap)).toBe(true);
        for (const ref of refs) expect(r.held(ref)?.has(224)).toBe(true);
      });
      const visible = refs.slice(0, 5);
      const zoomed = demand(visible, 200);
      for (let i = 0; i < 35; i++) {
        r.images.update(zoomed, 2, true, cap);
        for (const ref of visible) expect(r.held(ref)?.size).toBeGreaterThan(0);
        r.release();
        await tick();
      }
      await eventually(() => {
        r.release();
        expect(r.images.update(zoomed, 2, true, cap)).toBe(true);
        for (const ref of visible) expect(r.held(ref)?.has(448)).toBe(true);
      });
      expect(r.peak).toBeLessThanOrEqual(cap.bytes);
    } finally {
      r.resume();
      r.images.setBackend(null);
    }
  });

  it("keeps failed decodes out of pan retries and reopens them when new bytes arrive", async () => {
    const bad = new Set(["bad"]);
    const r = photoRig({ bad });
    const visible = demand(["bad", "ok"]);
    try {
      await eventually(() => expect(r.images.update(visible, 1, false, limit(16))).toBe(true));
      const before = r.decodes.get("bad");
      expect(before).toBeGreaterThan(0);
      expect(r.images.reduced).toBe(1);
      for (let i = 0; i < 10; i++) {
        const d = [...visible, ...demand([`near-${i}`], 100, 100, false)];
        expect(r.images.update(d, 1, false, limit(16))).toBe(true);
        await tick();
      }
      expect(r.decodes.get("bad")).toBe(before);
      bad.clear();
      r.versions.set("bad", 1);
      await eventually(() => {
        expect(r.images.update(visible, 1, false, limit(16))).toBe(true);
        expect(r.held("bad")?.has(112)).toBe(true);
      });
      expect(r.images.reduced).toBe(0);
    } finally {
      r.images.setBackend(null);
    }
  });

  it("settles a missing source and a budget-limited image", async () => {
    const r = photoRig({ missing: new Set(["gone"]) });
    try {
      const images = demand(["gone", "tall"], 100, 2000);
      await eventually(() => {
        expect(r.images.update(images, 1, false, limit(2))).toBe(true);
        expect(r.held("tall")?.has(448)).toBe(true);
      });
      expect(r.images.reduced).toBe(2);
      expect(r.peak).toBeLessThanOrEqual(limit(2).bytes);
    } finally {
      r.images.setBackend(null);
    }
  });

  it("chooses from both projected axes and warms two finer levels", async () => {
    const r = photoRig();
    try {
      await eventually(() => {
        expect(r.images.update(demand(["tall"], 40, 290), 1, false, limit(32))).toBe(true);
        expect([...(r.held("tall")?.keys() ?? [])].sort((a, b) => a - b)).toEqual([224, 448, 896]);
      });
      expect(r.images.reduced).toBe(0);
    } finally {
      r.images.setBackend(null);
    }
  });
});
