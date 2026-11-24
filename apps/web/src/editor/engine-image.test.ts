import type { ImageCache, ImageDemand } from "@drawpane/editor";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deviceImageBudget,
  type ImageTier,
  imageDecoder,
  tierCovers,
  tierForTarget,
  ViewImages,
} from "./engine-image";

afterEach(() => {
  vi.unstubAllGlobals();
});

const demand = (
  refs: readonly string[],
  width = 100,
  height = width,
  visible = true,
): ImageDemand[] => refs.map((ref) => ({ ref, visible, span: { width, height } }));

const limit = (mib: number) => ({ side: 4096, bytes: mib << 20 });

function photoRig(
  opts: {
    bad?: Set<string>;
    missing?: Set<string>;
    slow?: boolean;
    size?: { width: number; height: number };
  } = {},
) {
  const decodes = new Map<string, number>();
  const requests: number[] = [];
  const versions = new Map<string, number>();
  const held = new Map<number, Map<number, number>>();
  const gates: Array<() => void> = [];
  let blocked = opts.slow ?? false;
  let total = 0;
  let peak = 0;
  vi.stubGlobal(
    "createImageBitmap",
    async (blob: Blob & { ref: string }, o: ImageBitmapOptions) => {
      if (blob instanceof Blob) {
        decodes.set(blob.ref, (decodes.get(blob.ref) ?? 0) + 1);
        requests.push(o.resizeWidth ?? 0);
        if (blocked) await new Promise<void>((resolve) => gates.push(resolve));
        if (opts.bad?.has(blob.ref)) throw new Error("corrupt");
      }
      return { width: o.resizeWidth, height: o.resizeHeight, close() {} };
    },
  );
  const cache = {
    encoded: async (ref: string) => {
      if (opts.missing?.has(ref)) throw new Error("404");
      return {
        blob: Object.assign(new Blob(), { ref }),
        size: opts.size ?? { width: 1792, height: 2400 },
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
    requests,
    versions,
    pause: () => {
      blocked = true;
    },
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
  it("settles a 40-photo page through slow and corrupt decodes, then rebuilds under budget", async () => {
    const refs = Array.from({ length: 39 }, (_, i) => String(i));
    const photos = demand([...refs, "bad"]);
    const r = photoRig({ bad: new Set(["bad"]), slow: true });
    try {
      expect(r.images.update(photos, 1, limit(8))).toBe(false);
      await eventually(() => {
        expect(r.images.update(photos, 1, limit(8))).toBe(false);
        expect(r.decodes.size).toBeGreaterThan(0);
      });
      expect(r.images.update(photos, 1, limit(8))).toBe(false);
      r.resume();
      await eventually(() => {
        expect(r.images.update(photos, 1, limit(8))).toBe(true);
        for (const ref of refs) expect(r.held(ref)?.has(112)).toBe(true);
      });
      expect(r.images.reduced).toBe(1);
      const panned = demand(refs.slice(10));
      await eventually(() => {
        expect(r.images.update(panned, 1.4, limit(8))).toBe(true);
        for (const { ref } of panned) expect(r.held(ref)?.has(224)).toBe(true);
      });
      r.images.evict();
      expect(r.images.residentBytes).toBe(0);
      await eventually(() => expect(r.images.update(photos, 1, limit(8))).toBe(true));
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
        expect(r.images.update(unzoomed, 1, cap)).toBe(true);
        for (const ref of refs) expect(r.held(ref)?.has(224)).toBe(true);
      });
      const visible = refs.slice(0, 5);
      const zoomed = demand(visible, 200);
      for (let i = 0; i < 35; i++) {
        r.images.update(zoomed, 2, cap);
        for (const ref of visible) expect(r.held(ref)?.size).toBeGreaterThan(0);
        r.release();
        await tick();
      }
      await eventually(() => {
        r.release();
        expect(r.images.update(zoomed, 2, cap)).toBe(true);
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
      await eventually(() => expect(r.images.update(visible, 1, limit(16))).toBe(true));
      const before = r.decodes.get("bad");
      expect(before).toBeGreaterThan(0);
      expect(r.images.reduced).toBe(1);
      for (let i = 0; i < 10; i++) {
        const d = [...visible, ...demand([`near-${i}`], 100, 100, false)];
        expect(r.images.update(d, 1, limit(16))).toBe(true);
        await tick();
      }
      expect(r.decodes.get("bad")).toBe(before);
      bad.clear();
      r.versions.set("bad", 1);
      await eventually(() => {
        expect(r.images.update(visible, 1, limit(16))).toBe(true);
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
        expect(r.images.update(images, 1, limit(2))).toBe(true);
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
        expect(r.images.update(demand(["tall"], 40, 290), 1, limit(32))).toBe(true);
        expect([...(r.held("tall")?.keys() ?? [])].sort((a, b) => a - b)).toEqual([
          28, 224, 448, 896,
        ]);
      });
      expect(r.images.reduced).toBe(0);
    } finally {
      r.images.setBackend(null);
    }
  });

  it("keeps the closest fallback while a constrained zoom replacement decodes", async () => {
    const r = photoRig();
    const photos = demand(["a"]);
    const cap = limit(5);
    try {
      await eventually(() => {
        expect(r.images.update(photos, 1, cap, 0)).toBe(true);
        expect(r.held("a")?.has(448)).toBe(true);
      });
      r.pause();
      expect(r.images.update(photos, 5, cap, 200)).toBe(false);
      expect(r.requests).toContain(896);
      expect(r.held("a")?.has(448)).toBe(true);
      r.resume();
      await eventually(() => {
        expect(r.images.update(photos, 5, cap, 200)).toBe(true);
        expect(r.held("a")?.has(896)).toBe(true);
      });
      expect(r.held("a")?.has(28)).toBe(true);
      expect(r.peak).toBeLessThanOrEqual(cap.bytes);
    } finally {
      r.resume();
      r.images.setBackend(null);
    }
  });

  it("swaps in a level that fits only after its sharp predecessor is dropped", async () => {
    const r = photoRig();
    const photos = demand(["a"]);
    const cap = { side: 4096, bytes: 4_350_000 };
    try {
      await eventually(() => {
        expect(r.images.update(photos, 1, cap, 0)).toBe(true);
        expect(r.held("a")?.has(448)).toBe(true);
      });
      r.pause();
      expect(r.images.update(photos, 5, cap, 200)).toBe(false);
      expect(r.held("a")?.has(448)).toBe(true);
      r.resume();
      await eventually(() => {
        expect(r.images.update(photos, 5, cap, 200)).toBe(true);
        expect([...(r.held("a")?.keys() ?? [])].sort((a, b) => a - b)).toEqual([28, 896]);
      });
      expect(r.images.reduced).toBe(0);
      expect(r.peak).toBeLessThanOrEqual(cap.bytes);
    } finally {
      r.resume();
      r.images.setBackend(null);
    }
  });

  it("retains the currently drawn level of each visible photo after hidden eviction", async () => {
    const r = photoRig();
    const photos = [...demand(["a", "b"], 400), ...demand(["off"], 400, 400, false)];
    try {
      await eventually(() => {
        expect(r.images.update(photos, 1, limit(16))).toBe(true);
        expect(r.held("off")?.has(448)).toBe(true);
        expect(r.held("a")?.has(896)).toBe(true);
      });
      r.images.evict(true);
      expect(r.held("off")?.size).toBe(0);
      for (const ref of ["a", "b"]) expect([...(r.held(ref)?.keys() ?? [])]).toEqual([28, 448]);
      r.pause();
      expect(r.images.update(photos, 1, limit(16))).toBe(true);
      for (const ref of ["a", "b"]) expect(r.held(ref)?.has(448)).toBe(true);
    } finally {
      r.resume();
      r.images.setBackend(null);
    }
  });

  it("drops the sharp level to its thumbnail on an allocation refusal while hidden", async () => {
    const r = photoRig();
    const photos = demand(["a"], 400);
    try {
      await eventually(() => expect(r.images.update(photos, 1, limit(16))).toBe(true));
      r.images.evict(true);
      expect(r.held("a")?.has(448)).toBe(true);
      expect(r.images.releasePressure()).toBe(true);
      expect([...(r.held("a")?.keys() ?? [])]).toEqual([28]);
      r.pause();
      expect(r.images.update(photos, 1, limit(16))).toBe(false);
      expect(r.held("a")?.has(28)).toBe(true);
      r.resume();
      await eventually(() => expect(r.images.update(photos, 1, limit(16))).toBe(true));
      expect(r.held("a")?.has(448)).toBe(true);
    } finally {
      r.resume();
      r.images.setBackend(null);
    }
  });

  it("starts the end-of-gesture level more than two rungs ahead on a fast zoom", async () => {
    const r = photoRig();
    const photos = demand(["a"]);
    const cap = { side: 4096, bytes: 4_350_000 };
    try {
      await eventually(() => {
        expect(r.images.update(photos, 1, cap, 0)).toBe(true);
        expect(r.held("a")?.has(448)).toBe(true);
      });
      expect(r.requests).not.toContain(896);
      r.pause();
      expect(r.images.update(photos, 1.15, cap, 16)).toBe(true);
      expect(r.requests).toContain(896);
      expect(r.images.update(photos, 2, cap, 48)).toBe(true);
      expect(r.requests.filter((size) => size === 896)).toHaveLength(1);
      r.resume();
      await eventually(() => expect(r.held("a")?.has(896)).toBe(true));
      expect(r.images.update(photos, 5, cap, 132)).toBe(true);
      expect(r.images.reduced).toBe(0);
    } finally {
      r.resume();
      r.images.setBackend(null);
    }
  });

  it("covers a large photo through a 2x step and a slow 3x zoom without new decodes", async () => {
    const r = photoRig({ size: { width: 6000, height: 4000 } });
    const photo = demand(["large"], 1300, 866);
    const cap = limit(128);
    try {
      await eventually(() => {
        expect(r.images.update(photo, 1, cap, 0)).toBe(true);
        expect(r.held("large")?.size).toBeGreaterThanOrEqual(3);
      });
      expect(r.held("large")?.has(1536)).toBe(true);
      const requests = r.requests.length;
      r.pause();
      expect(r.images.update(photo, 2, cap, 200)).toBe(true);
      for (let frame = 0; frame <= 120; frame++) {
        const scale = 1 + (2 * frame) / 120;
        expect(r.images.update(photo, scale, cap, 216 + frame * 16)).toBe(true);
      }
      expect(r.requests).toHaveLength(requests);
    } finally {
      r.resume();
      r.images.setBackend(null);
    }
  });

  it.each([
    { deviceMemory: 2, adapter: 256, expected: 96, prefetch: false },
    { deviceMemory: 4, adapter: 256, expected: 192, prefetch: true },
    { deviceMemory: 4, adapter: 128, expected: 128, prefetch: true },
  ])(
    "keeps a 5K photo grid sharp with $expected MiB from $deviceMemory GiB and a $adapter MiB adapter cap",
    async ({ deviceMemory, adapter, expected, prefetch }) => {
      vi.stubGlobal("navigator", { deviceMemory });
      const r = photoRig({ size: { width: 6000, height: 4000 } });
      const photos = demand(["a", "b", "c", "d"], 1280, 853);
      try {
        await eventually(() => {
          expect(r.images.update(photos, 2, limit(adapter))).toBe(true);
          for (const { ref } of photos) expect(r.held(ref)?.has(2560)).toBe(true);
          expect(photos.some(({ ref }) => r.held(ref)?.has(4096))).toBe(prefetch);
        });
        expect(r.images.budget).toBe(limit(expected).bytes);
        expect(r.images.reduced).toBe(0);
        expect(r.peak).toBeLessThanOrEqual(limit(expected).bytes);
      } finally {
        r.images.setBackend(null);
      }
    },
  );

  it.each([
    { userAgent: "Macintosh", maxTouchPoints: 0, expected: 192 },
    { userAgent: "Macintosh", maxTouchPoints: 5, expected: 128 },
    {
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
      maxTouchPoints: 0,
      expected: 128,
    },
  ])(
    "uses $expected MiB when memory is unreported ($userAgent, $maxTouchPoints touch points)",
    (device) => {
      vi.stubGlobal("navigator", device);
      expect(deviceImageBudget(limit(256).bytes)).toBe(limit(device.expected).bytes);
      expect(deviceImageBudget(limit(64).bytes)).toBe(limit(64).bytes);
    },
  );
});

describe("image decoder", () => {
  class FakeWorker {
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    readonly sent: Array<{ id: number; options: ImageBitmapOptions }> = [];
    terminated = false;
    postMessage(message: { id: number; options: ImageBitmapOptions }) {
      this.sent.push(message);
    }
    terminate() {
      this.terminated = true;
    }
    reply(data: unknown) {
      this.onmessage?.({ data } as MessageEvent);
    }
  }
  const bitmap = (width: number) => ({
    width,
    height: width,
    closed: false,
    close() {
      this.closed = true;
    },
  });

  it("decodes in the worker and settles each request from its own reply", async () => {
    const worker = new FakeWorker();
    const spawn = vi.fn(() => worker as unknown as Worker);
    const here = vi.fn();
    vi.stubGlobal("createImageBitmap", here);
    const decode = imageDecoder(spawn);
    const a = decode(new Blob(["a"]), { resizeWidth: 10 });
    const b = decode(new Blob(["b"]), { resizeWidth: 20 });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(worker.sent.map((message) => message.options.resizeWidth)).toEqual([10, 20]);
    const [first, second] = worker.sent;
    worker.reply({ id: second?.id, bitmap: bitmap(20) });
    worker.reply({ id: first?.id, error: "corrupt" });
    await expect(b).resolves.toMatchObject({ width: 20 });
    await expect(a).rejects.toThrow("corrupt");
    // A reply no request waits for is let go.
    const stray = bitmap(5);
    worker.reply({ id: 999, bitmap: stray });
    expect(stray.closed).toBe(true);
    expect(here).not.toHaveBeenCalled();
  });

  it("decodes here when no worker starts, and once its worker fails", async () => {
    const here = vi.fn(async (_blob: Blob, options: ImageBitmapOptions) =>
      bitmap(options.resizeWidth ?? 0),
    );
    vi.stubGlobal("createImageBitmap", here);
    const blocked = imageDecoder(() => {
      throw new Error("blocked by the content security policy");
    });
    await expect(blocked(new Blob(), { resizeWidth: 7 })).resolves.toMatchObject({ width: 7 });
    const worker = new FakeWorker();
    const decode = imageDecoder(() => worker as unknown as Worker);
    const stranded = decode(new Blob(), { resizeWidth: 8 });
    worker.onerror?.(new Event("error"));
    expect(worker.terminated).toBe(true);
    await expect(stranded).resolves.toMatchObject({ width: 8 });
    await expect(decode(new Blob(), { resizeWidth: 9 })).resolves.toMatchObject({ width: 9 });
    expect(worker.sent).toHaveLength(1);
    expect(here).toHaveBeenCalledTimes(3);
  });
});

describe("progressive image tiers", () => {
  function progressiveRig(
    opts: {
      size?: { width: number; height: number };
      holdTiers?: Set<ImageTier>;
      failTiers?: Set<ImageTier>;
      fallbackToFull?: boolean;
    } = {},
  ) {
    const size = opts.size ?? { width: 3093, height: 2247 };
    const fetched: Array<{ ref: string; tier: ImageTier }> = [];
    const uploads: Array<{ handle: number; width: number; height: number }> = [];
    const held = new Map<number, Map<number, number>>();
    const tierGates = new Map<ImageTier, Array<() => void>>();
    let total = 0;
    let peak = 0;

    vi.stubGlobal("createImageBitmap", async (_blob: Blob, o: ImageBitmapOptions) => ({
      width: o.resizeWidth ?? size.width,
      height: o.resizeHeight ?? size.height,
      close() {},
    }));

    const cache = {
      encoded: async (ref: string, _signal: AbortSignal, options?: { preview?: 256 | 1024 }) => {
        const tier: ImageTier = options?.preview ?? "full";
        fetched.push({ ref, tier });
        if (opts.holdTiers?.has(tier)) {
          await new Promise<void>((resolve) => {
            const list = tierGates.get(tier) ?? [];
            list.push(resolve);
            tierGates.set(tier, list);
          });
        }
        if (opts.failTiers?.has(tier)) throw new Error(`failed ${tier}`);
        if (opts.fallbackToFull) {
          return { blob: new Blob(["full"]), size };
        }
        return {
          blob: new Blob([String(tier)]),
          size,
          ...(options?.preview ? { preview: options.preview } : {}),
        };
      },
      encodedVersion: () => 0,
    } satisfies Pick<ImageCache, "encoded" | "encodedVersion">;

    const images = new ViewImages(
      cache,
      () => {},
      () => {},
    );
    images.setBackend({
      upload(handle, bitmap) {
        uploads.push({ handle, width: bitmap.width, height: bitmap.height });
        const levels = held.get(handle) ?? new Map<number, number>();
        const prev = levels.get(bitmap.width) ?? 0;
        const next = bitmap.width * bitmap.height * 4;
        levels.set(bitmap.width, next);
        held.set(handle, levels);
        total += next - prev;
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
      fetched,
      uploads,
      held: (ref: string) => held.get(images.info(ref)?.handle ?? -1),
      releaseTier: (tier: ImageTier) => {
        opts.holdTiers?.delete(tier);
        for (const done of tierGates.get(tier)?.splice(0) ?? []) done();
      },
      get peak() {
        return peak;
      },
    };
  }

  it("selects the smallest preview tier covering target pixels and uses full at 1:1 natural size", () => {
    expect(tierCovers(256, 256)).toBe(true);
    expect(tierCovers(1024, 256)).toBe(true);
    expect(tierCovers("full", 1024)).toBe(true);
    expect(tierCovers(256, 1024)).toBe(false);
    expect(tierCovers(1024, "full")).toBe(false);

    const photo = { width: 3093, height: 2247 };
    expect(tierForTarget(photo, { width: 193, height: 140 })).toBe(256);
    expect(tierForTarget(photo, { width: 256, height: 186 })).toBe(256);
    expect(tierForTarget(photo, { width: 773, height: 561 })).toBe(1024);
    expect(tierForTarget(photo, { width: 1024, height: 744 })).toBe(1024);
    expect(tierForTarget(photo, { width: 1546, height: 1123 })).toBe("full");

    // Small 256x256 icon stays on 256 WebP while viewed downscaled (even when mip target rounds
    // up to 256x256, e.g. 136 px on Retina), and upgrades to full original at 1:1+ zoom.
    const icon = { width: 256, height: 256 };
    expect(tierForTarget(icon, { width: 128, height: 128 }, 100)).toBe(256);
    expect(tierForTarget(icon, { width: 256, height: 256 }, 136)).toBe(256);
    expect(tierForTarget(icon, { width: 256, height: 256 }, 256)).toBe("full");
    expect(tierForTarget(icon, { width: 256, height: 256 })).toBe("full");
  });

  it("keeps Fit views and off-screen rings on w=256 without speculative higher-tier downloads", async () => {
    const r = progressiveRig({ size: { width: 3093, height: 2247 } });
    try {
      const demands = [
        ...demand(["vis1", "vis2"], 100, 75, true),
        ...demand(["off1"], 1500, 1100, false),
      ];
      await eventually(() => {
        expect(r.images.update(demands, 1, limit(64))).toBe(true);
        expect(r.held("vis1")?.has(193)).toBe(true);
        expect(r.held("vis2")?.has(193)).toBe(true);
        expect(r.held("off1")?.has(193)).toBe(true);
      });
      // Give speculative prefetch a chance to run: it must NOT fetch 1024 or full.
      await tick();
      expect(r.images.reduced).toBe(0);
      expect(r.fetched.every((f) => f.tier === 256)).toBe(true);
    } finally {
      r.images.setBackend(null);
    }
  });

  it("shows a 256 stand-in immediately while full resolution downloads, then upgrades cleanly", async () => {
    const r = progressiveRig({
      size: { width: 3093, height: 2247 },
      holdTiers: new Set<ImageTier>(["full"]),
    });
    const demands = demand(["hero"], 1500, 1100);
    try {
      // Stand-in arrives immediately from the 256 preview while full is still in flight.
      await eventually(() => {
        expect(r.images.update(demands, 1, limit(64))).toBe(false);
        expect(r.held("hero")?.has(256)).toBe(true);
      });
      expect(r.fetched).toEqual([
        { ref: "hero", tier: 256 },
        { ref: "hero", tier: "full" },
      ]);
      // Still provisional until full resolution lands.
      expect(r.images.update(demands, 1, limit(64))).toBe(false);

      // Once full resolution arrives, upgrades to the 1536 px rest step and settles exact.
      r.releaseTier("full");
      await eventually(() => {
        expect(r.images.update(demands, 1, limit(64))).toBe(true);
        expect(r.held("hero")?.has(1536)).toBe(true);
      });
      expect(r.images.reduced).toBe(0);
    } finally {
      r.releaseTier("full");
      r.images.setBackend(null);
    }
  });

  it("replaces a same-width 256 preview in place when 1:1 full resolution arrives without double-counting GPU bytes", async () => {
    const r = progressiveRig({
      size: { width: 256, height: 256 },
      holdTiers: new Set<ImageTier>(["full"]),
    });
    const demands = demand(["icon"], 256, 256);
    try {
      await eventually(() => {
        expect(r.images.update(demands, 1, limit(16))).toBe(false);
        expect(r.held("icon")?.has(256)).toBe(true);
      });
      const bytesBefore = r.images.residentBytes;
      expect(bytesBefore).toBe(256 * 256 * 4);

      r.releaseTier("full");
      await eventually(() => {
        expect(r.images.update(demands, 1, limit(16))).toBe(true);
      });
      expect(r.images.reduced).toBe(0);
      // Same-width replacement must not double-count the 256x256 level (only adds the 32x32 fallback).
      expect(r.images.residentBytes).toBe(256 * 256 * 4 + 32 * 32 * 4);
      expect(r.uploads.filter((u) => u.width === 256)).toHaveLength(2);
    } finally {
      r.releaseTier("full");
      r.images.setBackend(null);
    }
  });

  it("keeps the preview visible and reports reduced > 0 when a higher-tier fetch fails", async () => {
    const r = progressiveRig({
      size: { width: 3093, height: 2247 },
      failTiers: new Set<ImageTier>(["full"]),
    });
    const demands = demand(["hero"], 1500, 1100);
    try {
      await eventually(() => {
        expect(r.images.update(demands, 1, limit(64))).toBe(true);
        expect(r.held("hero")?.has(256)).toBe(true);
      });
      // Honesty rule: showing only a 256 preview where 1546 px are needed is reduced, not exact.
      expect(r.images.reduced).toBe(1);
    } finally {
      r.images.setBackend(null);
    }
  });

  it("caches a server fallback-to-original response as full and never refetches on zoom", async () => {
    const r = progressiveRig({
      size: { width: 1600, height: 1200 },
      fallbackToFull: true,
    });
    try {
      await eventually(() => {
        expect(r.images.update(demand(["a"], 100, 75), 1, limit(32))).toBe(true);
      });
      await eventually(() => {
        expect(r.images.update(demand(["a"], 1600, 1200), 1, limit(32))).toBe(true);
        expect(r.held("a")?.has(1600)).toBe(true);
      });
      expect(r.fetched).toEqual([{ ref: "a", tier: 256 }]);
      expect(r.images.reduced).toBe(0);
    } finally {
      r.images.setBackend(null);
    }
  });

  it("respects a tight GPU budget by evicting the stand-in when the sharp upgrade uploads", async () => {
    const r = progressiveRig({
      size: { width: 1792, height: 2400 },
      holdTiers: new Set<ImageTier>(["full"]),
    });
    // Budget fits 896x1200 (4,300,800 B) + 28x37 fallback (4,144 B), NOT 896 + 191x256 stand-in (195,584 B).
    const cap = { side: 4096, bytes: 4_350_000 };
    const demands = demand(["a"], 800, 1100);
    try {
      await eventually(() => {
        expect(r.images.update(demands, 1, cap)).toBe(false);
        expect(r.held("a")?.has(191)).toBe(true);
      });
      r.releaseTier("full");
      await eventually(() => {
        expect(r.images.update(demands, 1, cap)).toBe(true);
        expect(r.held("a")?.has(896)).toBe(true);
      });
      expect(r.images.reduced).toBe(0);
      expect(r.peak).toBeLessThanOrEqual(cap.bytes);
    } finally {
      r.releaseTier("full");
      r.images.setBackend(null);
    }
  });
});
