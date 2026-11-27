import { type Editor, ImageCache } from "@drawpane/editor";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withCanvasOutputRenderer } from "./canvas-output";
import { imagesFor } from "./media";

const output = vi.hoisted(() => ({
  box: { width: 8_000, height: 6_000 },
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
    new Map([
      [
        "photo",
        [
          {
            paint: { type: "image", scaleMode: "fill" },
            box: output.box,
            scale: { width: 1, height: 1 },
          },
        ],
      ],
    ]),
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
      { ids: ["layer"], scale: 1, onImageReductions: reduced },
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
    expect(reduced).toHaveBeenCalledWith(1);
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
});
