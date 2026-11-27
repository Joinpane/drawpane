import { type Editor, ImageCache } from "@drawpane/editor";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withCanvasOutputRenderer } from "./canvas-output";
import { imagesFor } from "./media";

const output = vi.hoisted(() => ({
  box: { width: 8_000, height: 6_000 },
  refs: ["photo"],
}));

vi.mock("@drawpane/editor", async (original) => ({
  ...(await original<typeof import("@drawpane/editor")>()),
  CanvasRenderer: class {
    constructor(
      _scene: unknown,
      _measurer: unknown,
      readonly options: { images: ImageCache },
    ) {}
    get images() {
      return this.options.images;
    }
  },
  DisplayListBuilder: class {
    planLayers() {
      return { visibleNodes: () => [] };
    }
  },
  collectExportImageUses: () =>
    new Map(
      output.refs.map((ref) => [
        ref,
        [
          {
            paint: { type: "image", scaleMode: "fill" },
            box: output.box,
            scale: { width: 1, height: 1 },
          },
        ],
      ]),
    ),
}));

vi.mock("./media", () => ({ imagesFor: vi.fn() }));

function bitmap(width: number, height: number) {
  return { width, height, close: vi.fn() } as unknown as ImageBitmap;
}

function pngHeader(width: number, height: number) {
  const header = new Uint8Array(32);
  header.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  const view = new DataView(header.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return new Blob([header], { type: "image/png" });
}

const editor = {} as Editor;

describe("mobile Canvas output images", () => {
  afterEach(() => {
    output.refs = ["photo"];
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("decodes a 48 MP original directly into the budget and releases it after paint", async () => {
    output.box = { width: 8_000, height: 6_000 };
    const display = new ImageCache({ enforceMaxBytes: true, maxBytes: 48 * 1024 * 1024 });
    vi.mocked(imagesFor).mockReturnValue(display);
    const original = pngHeader(8_000, 6_000);
    vi.spyOn(display, "encoded").mockResolvedValue({ blob: original });
    let temporary: ImageBitmap | undefined;
    const decode = vi.fn(async (_source: unknown, options?: ImageBitmapOptions) => {
      if (!options?.resizeWidth || !options.resizeHeight) throw new Error("Unbounded decode");
      temporary = bitmap(options.resizeWidth, options.resizeHeight);
      return temporary;
    });
    vi.stubGlobal("createImageBitmap", decode);
    const reduced = vi.fn();

    await withCanvasOutputRenderer(
      editor,
      { ids: ["layer"], scale: 1, onImageCounts: reduced },
      async (renderer, release) => {
        const picture = renderer.images.peek("photo")?.bitmap;
        expect(picture).toBe(temporary);
        expect(picture?.width).toBeLessThanOrEqual(4096);
        expect(renderer.images.bytes).toBeLessThanOrEqual(display.decodedBudget);
        release?.();
        expect(picture?.close).toHaveBeenCalledTimes(1);
        expect(renderer.images.bytes).toBe(0);
      },
    );
    expect(decode).toHaveBeenCalledTimes(1);
    expect(decode.mock.calls[0]?.[0]).toBe(original);
    expect(reduced).toHaveBeenCalledWith(1, 0);
  });

  it("uses already decoded display pixels for a small output without fetching the original", async () => {
    output.box = { width: 240, height: 180 };
    const display = new ImageCache({ enforceMaxBytes: true });
    const cached = bitmap(960, 720);
    display.put("photo", { bitmap: cached, naturalWidth: 8_000, naturalHeight: 6_000 });
    vi.mocked(imagesFor).mockReturnValue(display);
    const fetch = vi.spyOn(display, "encoded");
    const copy = bitmap(240, 180);
    const decode = vi.fn(async () => copy);
    vi.stubGlobal("createImageBitmap", decode);

    await withCanvasOutputRenderer(editor, { ids: ["layer"], scale: 1 }, async (renderer) => {
      expect(renderer.images.peek("photo")?.bitmap).toBe(copy);
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(decode).toHaveBeenCalledWith(cached, {
      resizeWidth: 240,
      resizeHeight: 180,
      resizeQuality: "high",
    });
    expect(copy.close).toHaveBeenCalledTimes(1);
    expect(cached.close).not.toHaveBeenCalled();
    display.clear();
  });

  it("reuses an offscreen server preview on a second thumbnail for the same page", async () => {
    output.box = { width: 90, height: 90 };
    const display = new ImageCache({ enforceMaxBytes: true });
    vi.mocked(imagesFor).mockReturnValue(display);
    const source = pngHeader(256, 256);
    const fetch = vi.spyOn(display, "encoded").mockResolvedValue({
      blob: source,
      preview: 256,
      size: { width: 2048, height: 2048 },
    });
    const decoded = bitmap(90, 90);
    const decode = vi.fn(async () => decoded);
    vi.stubGlobal("createImageBitmap", decode);
    for (let publish = 0; publish < 2; publish++) {
      await withCanvasOutputRenderer(
        editor,
        { ids: ["layer"], scale: 1, thumbnail: true },
        async (renderer, release) => {
          expect(renderer.images.peek("photo")?.bitmap).toBe(decoded);
          release?.();
        },
      );
    }
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      "photo",
      expect.any(AbortSignal),
      expect.objectContaining({ preview: 256 }),
    );
    expect(decode).toHaveBeenCalledTimes(1);
    expect(decoded.close).not.toHaveBeenCalled();
  });

  it("overlaps export requests but only stages one large body at a time", async () => {
    output.box = { width: 90, height: 90 };
    output.refs = ["first", "cached", "last", "missing"];
    const display = new ImageCache({ enforceMaxBytes: true });
    display.put("cached", { bitmap: bitmap(90, 90), naturalWidth: 90, naturalHeight: 90 });
    vi.mocked(imagesFor).mockReturnValue(display);
    const order: string[] = [];
    const source = pngHeader(90, 90);
    const fetch = vi.spyOn(display, "encoded").mockImplementation(async (ref, _, options) => {
      order.push(`request ${ref}`);
      if (ref === "missing") throw new Error("Media unavailable");
      if (ref === "first") await new Promise((resolve) => setTimeout(resolve, 30));
      await options?.beforeRead?.(20 * 1024 * 1024);
      order.push(`read ${ref}`);
      return { blob: source };
    });
    const counts = vi.fn();
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async (src) => {
        if (src === source) order.push("decode original");
        return bitmap(90, 90);
      }),
    );
    await withCanvasOutputRenderer(
      editor,
      { ids: ["layer"], scale: 1, onImageCounts: counts },
      async (renderer) => expect(renderer.images.peek("last")).not.toBeNull(),
    );
    expect(order).toEqual([
      "request first",
      "request last",
      "request missing",
      "read first",
      "decode original",
      "read last",
      "decode original",
    ]);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(counts).toHaveBeenCalledWith(0, 1);
    display.clear();
  });
});
