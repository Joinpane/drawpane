/** Draws a vector export for pixel assertions. */
import type { ResvgRasteriser } from "@drawpane/raster/node";
import type { Doc } from "../../src/doc";
import { exportBounds, snapToPixels } from "../../src/export";
import { Scene } from "../../src/scene";
import { exportSvg } from "../../src/svg";
import type { TextMeasurer } from "../../src/text";

export function rasterSvg(
  doc: Doc,
  id: string,
  measurer: TextMeasurer,
  rasteriser: ResvgRasteriser,
  options: { background?: string; fonts?: readonly Uint8Array[] } = {},
) {
  const scene = new Scene(doc);
  const ids = doc.get(id)?.type === "page" ? doc.childIds(id) : [id];
  const bounds = exportBounds(scene, ids);
  if (!bounds) throw new Error("SVG fixture has no visible bounds");
  const svg = exportSvg(scene, measurer, ids, snapToPixels(bounds, 1), { outlineFeatures: true });
  return rasteriser.pixels(svg, {
    scale: 1,
    fonts: options.fonts ?? [],
    fallbackFamily: "Instrument Sans",
    background: options.background ?? null,
  });
}
