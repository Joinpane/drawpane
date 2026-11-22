// @vitest-environment jsdom
import * as editorPkg from "@drawpane/editor";
import { Editor, ImageCache } from "@drawpane/editor";
import { type Op, ROOT_ID } from "@drawpane/model";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as snapshot from "./engine-snapshot";
import { renderExportWithMeta } from "./exporting";

function makePhotoEditor(
  photos: ReadonlyArray<{
    readonly ref: string;
    readonly w: number;
    readonly h: number;
    readonly drawW: number;
    readonly drawH: number;
  }>,
) {
  const editor = new Editor({ measurer: { width: () => 0 }, clientId: "test" });
  const ops: Op[] = [
    { op: "create", id: "p", type: "page", parent: ROOT_ID, key: "a0", props: { name: "P" } },
    {
      op: "create",
      id: "wall",
      type: "frame",
      parent: "p",
      key: "a0",
      props: {
        x: 0,
        y: 0,
        width: 4000,
        height: 3000,
        fills: [{ type: "solid", color: "#ffffff" }],
      },
    },
  ];
  photos.forEach((p, i) => {
    ops.push({
      op: "create",
      id: `r${i}`,
      type: "rect",
      parent: "wall",
      key: `a${i}`,
      props: {
        x: (i % 2) * 2000,
        y: Math.floor(i / 2) * 1500,
        width: p.drawW,
        height: p.drawH,
        fills: [{ type: "image", ref: p.ref, scaleMode: "fill" }],
      },
    });
  });
  editor.doc.apply(ops);
  editor.setPage("p");
  return editor;
}

describe("renderExportWithMeta photo-reduction canvas fallback", () => {
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("routes multi-photo exports that the engine would reduce through the sharp canvas exporter", async () => {
    localStorage.setItem("drawpane:renderer", "engine");
    const refs = ["1".repeat(64), "2".repeat(64), "3".repeat(64), "4".repeat(64)];
    const editor = makePhotoEditor(
      refs.map((ref) => ({ ref, w: 4000, h: 3000, drawW: 2000, drawH: 1500 })),
    );
    vi.spyOn(ImageCache.prototype, "natural").mockReturnValue({ width: 4000, height: 3000 });
    const canvasBlob = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
    const canvasSpy = vi.spyOn(editorPkg, "exportRaster").mockResolvedValue(canvasBlob);
    const engineSpy = vi.spyOn(snapshot, "renderEngineRasterExportWithMeta");

    const res = await renderExportWithMeta(editor, ["wall"], { format: "png", scale: 2 });
    expect(res.blob).toBe(canvasBlob);
    expect(res.reducedImages).toBe(0);
    expect(res.omittedImages).toBe(0);
    expect(canvasSpy).toHaveBeenCalledTimes(1);
    expect(engineSpy).not.toHaveBeenCalled();
  });

  it("keeps the reduction count when canvas itself caps a photo over 4,096 px below its drawn size", async () => {
    localStorage.setItem("drawpane:renderer", "engine");
    const ref = "a".repeat(64);
    const editor = makePhotoEditor([{ ref, w: 6000, h: 4500, drawW: 2800, drawH: 2100 }]);
    vi.spyOn(ImageCache.prototype, "natural").mockReturnValue({ width: 6000, height: 4500 });
    const canvasBlob = new Blob([new Uint8Array([4, 5])], { type: "image/png" });
    vi.spyOn(editorPkg, "exportRaster").mockResolvedValue(canvasBlob);
    const engineSpy = vi.spyOn(snapshot, "renderEngineRasterExportWithMeta");

    const res = await renderExportWithMeta(editor, ["wall"], {
      format: "png",
      scale: 2,
      imageBudget: 2 << 20,
    });
    expect(res.blob).toBe(canvasBlob);
    // Drawn at 5,600 x 4,200 exceeds ImageCache's 4,096 px cap -> canvas still reduces this photo.
    expect(res.reducedImages).toBe(1);
    expect(res.omittedImages).toBe(0);
    expect(engineSpy).not.toHaveBeenCalled();
  });

  it("keeps the engine export when canvas's 4,096 px cap would soften a photo more than the engine", async () => {
    localStorage.setItem("drawpane:renderer", "engine");
    // A 12,000 px panorama drawn at its full size: canvas caps it at 4,096 px (a third), while a
    // generous engine budget only steps it down to the engine's 8,192 px side limit.
    const ref = "c".repeat(64);
    const editor = makePhotoEditor([{ ref, w: 12000, h: 1000, drawW: 6000, drawH: 500 }]);
    vi.spyOn(ImageCache.prototype, "natural").mockReturnValue({ width: 12000, height: 1000 });
    const canvasSpy = vi.spyOn(editorPkg, "exportRaster");
    const engineBlob = new Blob([new Uint8Array([7])], { type: "image/png" });
    const engineSpy = vi.spyOn(snapshot, "renderEngineRasterExportWithMeta").mockResolvedValue({
      blob: engineBlob,
      reducedImages: 0,
      omittedImages: 0,
    });

    const res = await renderExportWithMeta(editor, ["wall"], {
      format: "png",
      scale: 2,
      imageBudget: 512 << 20,
    });
    expect(res.blob).toBe(engineBlob);
    expect(engineSpy).toHaveBeenCalledTimes(1);
    expect(canvasSpy).not.toHaveBeenCalled();
  });

  it("falls back to the engine export and preserves its reduction count when canvas fails", async () => {
    localStorage.setItem("drawpane:renderer", "engine");
    const refs = ["5".repeat(64), "6".repeat(64), "7".repeat(64), "8".repeat(64)];
    const editor = makePhotoEditor(
      refs.map((ref) => ({ ref, w: 4000, h: 3000, drawW: 2000, drawH: 1500 })),
    );
    vi.spyOn(ImageCache.prototype, "natural").mockReturnValue({ width: 4000, height: 3000 });
    vi.spyOn(editorPkg, "exportRaster").mockRejectedValue(new Error("canvas OOM"));
    const engineBlob = new Blob([new Uint8Array([9])], { type: "image/png" });
    const engineSpy = vi.spyOn(snapshot, "renderEngineRasterExportWithMeta").mockResolvedValue({
      blob: engineBlob,
      reducedImages: 4,
      omittedImages: 0,
    });

    const res = await renderExportWithMeta(editor, ["wall"], { format: "png", scale: 2 });
    expect(res.blob).toBe(engineBlob);
    expect(res.reducedImages).toBe(4);
    expect(engineSpy).toHaveBeenCalledTimes(1);
  });

  it("surfaces engine work-limit refusals directly without falling back to CanvasRenderer", async () => {
    localStorage.setItem("drawpane:renderer", "engine");
    const editor = makePhotoEditor([]);
    const limitErr = new editorPkg.ExportError(
      "This export needs too much rendering work at this scale. Try a smaller scale.",
      "limit",
    );
    vi.spyOn(snapshot, "renderEngineRasterExportWithMeta").mockRejectedValue(limitErr);
    const canvasSpy = vi.spyOn(editorPkg, "exportRaster");

    await expect(renderExportWithMeta(editor, ["wall"], { format: "png", scale: 1 })).rejects.toBe(
      limitErr,
    );
    expect(canvasSpy).not.toHaveBeenCalled();
  });

  it("still falls back to CanvasRenderer for 8,193..16,384 px size errors and unsupported effects", async () => {
    localStorage.setItem("drawpane:renderer", "engine");
    const editor = makePhotoEditor([]);
    const canvasBlob = new Blob([new Uint8Array([1, 2])], { type: "image/png" });
    const canvasSpy = vi.spyOn(editorPkg, "exportRaster").mockResolvedValue(canvasBlob);

    vi.spyOn(snapshot, "renderEngineRasterExportWithMeta").mockRejectedValueOnce(
      editorPkg.exportSizeError(10_000, 64, 8192),
    );
    const sizeRes = await renderExportWithMeta(editor, ["wall"], { format: "png", scale: 1 });
    expect(sizeRes.blob).toBe(canvasBlob);

    vi.spyOn(snapshot, "renderEngineRasterExportWithMeta").mockRejectedValueOnce(
      new editorPkg.ExportError("Unsupported progressive blur.", "unsupported"),
    );
    const unsupRes = await renderExportWithMeta(editor, ["wall"], { format: "webp", scale: 1 });
    expect(unsupRes.blob).toBe(canvasBlob);
    expect(canvasSpy).toHaveBeenCalledTimes(2);
  });
});
