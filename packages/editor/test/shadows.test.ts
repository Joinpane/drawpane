import { type Effect, type NodeRecord, type Op, ROOT_ID } from "@drawpane/model";
import type { ResvgRasteriser } from "@drawpane/raster";
import { nodeRasteriser } from "@drawpane/raster/node";
import { beforeAll, describe, expect, it } from "vitest";
import { Doc } from "../src/doc";
import { base64, createHeadlessRenderer } from "../src/headless-render";
import { dropShadowCast } from "../src/shadows";
import type { TextMeasurer } from "../src/text";

const ring = (props: { showBehind?: boolean } = {}): Effect => ({
  type: "drop-shadow",
  color: "#ff0000",
  x: 0,
  y: 0,
  blur: 0,
  spread: 4,
  ...props,
});

const layer = (type: string, props: Record<string, unknown>): NodeRecord =>
  ({ id: "n", type, parent: "p", key: "a0", props }) as NodeRecord;

describe("dropShadowCast", () => {
  it("casts from the shape grown by the spread under a visible fill", () => {
    const solid = layer("rect", { fills: [{ type: "solid", color: "#ffffff" }] });
    expect(dropShadowCast(solid, ring())).toEqual({ spread: 4, cutOut: false });
    const glass = layer("frame", { fills: [{ type: "solid", color: "#ffffff1a" }] });
    expect(dropShadowCast(glass, ring())).toEqual({ spread: 4, cutOut: false });
  });

  it("cuts it out under a see-through fill when it isn't shown behind", () => {
    const glass = layer("frame", { fills: [{ type: "solid", color: "#ffffff", opacity: 0.1 }] });
    expect(dropShadowCast(glass, ring({ showBehind: false }))).toEqual({ spread: 4, cutOut: true });
  });

  it("casts nothing from the shape of a layer that fills nothing visible", () => {
    // Figma casts those from what the layer draws, without spread: here the outline, outside it.
    for (const fills of [
      [],
      [{ type: "solid", color: "#ffffff", opacity: 0 }],
      [{ type: "solid", color: "#ffffff00" }],
      [{ type: "solid", color: "#ffffff", visible: false }],
    ]) {
      expect(dropShadowCast(layer("frame", { fills }), ring())).toEqual({
        spread: 0,
        cutOut: true,
      });
    }
  });

  it("leaves it whole under an opaque fill, where nothing would show", () => {
    const card = layer("rect", { fills: [{ type: "solid", color: "#ffffff" }] });
    expect(dropShadowCast(card, ring({ showBehind: false }))).toEqual({ spread: 4, cutOut: false });
  });

  it("leaves text as it was", () => {
    expect(dropShadowCast(layer("text", {}), ring({ showBehind: false }))).toEqual({
      spread: 4,
      cutOut: false,
    });
  });
});

describe("drop shadows, drawn", () => {
  let rasteriser: ResvgRasteriser;
  beforeAll(async () => {
    rasteriser = await nodeRasteriser();
  });
  const measurer: TextMeasurer = { width: (_font, text) => text.length * 8 };

  /** The page drawn over white at 1×: the pixel at (x, y) of the page's bounds. */
  async function pixels(props: Record<string, unknown>) {
    const d = new Doc();
    d.apply([
      { op: "create", id: "p", type: "page", parent: ROOT_ID, key: "a0", props: { name: "P" } },
      // A white backdrop, so the page's bounds don't move with the shadow.
      {
        op: "create",
        id: "bg",
        type: "rect",
        parent: "p",
        key: "a0",
        props: { x: 0, y: 0, width: 60, height: 60, fills: [{ type: "solid", color: "#ffffff" }] },
      },
      {
        op: "create",
        id: "field",
        type: "frame",
        parent: "p",
        key: "a1",
        props: { x: 20, y: 20, width: 20, height: 20, ...props },
      },
    ] as Op[]);
    const r = createHeadlessRenderer({
      measurer,
      rasteriser,
      fonts: async () => null,
      images: async () => null,
    });
    const out = await r.renderPng(d, "p", { scale: 1, background: "#ffffff" });
    const px = rasteriser.pixels(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${out.width}" height="${out.height}"><image width="${out.width}" height="${out.height}" href="data:image/png;base64,${base64(out.png)}"/></svg>`,
      { scale: 1, fonts: [] },
    );
    return (x: number, y: number) => [
      ...px.data.subarray((y * out.width + x) * 4, (y * out.width + x) * 4 + 3),
    ];
  }

  it("draws no ring round a field that fills nothing visible, as Figma does", async () => {
    const at = await pixels({
      fills: [{ type: "solid", color: "#ffffff", opacity: 0 }],
      effects: [ring()],
    });
    expect(at(30, 30)).toEqual([255, 255, 255]); // inside
    expect(at(18, 30)).toEqual([255, 255, 255]); // where the spread would reach
  });

  it("draws the ring outside a see-through field, and not inside it when asked", async () => {
    const at = await pixels({
      fills: [{ type: "solid", color: "#ffffff", opacity: 0.1 }],
      effects: [ring({ showBehind: false })],
    });
    expect(at(30, 30)).toEqual([255, 255, 255]);
    expect(at(18, 30)).toEqual([255, 0, 0]);
  });

  it("shows the shadow through a see-through fill by default", async () => {
    const at = await pixels({
      fills: [{ type: "solid", color: "#ffffff", opacity: 0.1 }],
      effects: [ring()],
    });
    const [r, g, b] = at(30, 30);
    expect(r).toBe(255);
    expect(g).toBeLessThan(40);
    expect(b).toBeLessThan(40);
    expect(at(18, 30)).toEqual([255, 0, 0]);
  });
});
