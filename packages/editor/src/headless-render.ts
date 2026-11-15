/**
 * PNGs of layers without a canvas, for the headless agent engine (decisions
 * 0021 and 0023). The browser draws exports with the canvas renderer; a
 * Worker has no canvas, so here a layer is written out by the SVG export,
 * the same markup people download, and rasterised in WebAssembly.
 *
 * What the SVG can't hold travels with it: the font files its text is set
 * in (the caller's loader: the font proxy's upstream, R2 for team fonts) and
 * its images, embedded as data: URLs. Runs with OpenType features or
 * variable axes are written as glyph outlines from the measurer's shaper,
 * so they don't depend on the rasteriser's support for either.
 *
 * Effects SVG can only approximate (glass, noise, texture) or can't draw at
 * all (background blur) are listed with the picture, so a tool can say the
 * image is approximate. Everything else is meant to match the canvas: the
 * render parity suite (apps/web/e2e/parity/headless.spec.ts) measures how
 * closely.
 */
import { getProp, type NodeRecord } from "@drawpane/model";
import type { Face, FontBytesLoader, Rasteriser } from "@drawpane/raster";
import type { Doc } from "./doc";
import { ExportError, exportBounds, imageRefs, snapToPixels } from "./export";
import type { Rect } from "./geometry";
import { textSpans } from "./rich-text";
import { Scene } from "./scene";
import { exportSvg, type SvgImageSource } from "./svg";
import type { TextMeasurer } from "./text";

/** An image's file, with its natural size in pixels. */
export interface ImageFile {
  readonly bytes: Uint8Array;
  /** Its media type: `image/png`, `image/jpeg`, `image/webp`, `image/gif`. */
  readonly type: string;
  readonly width: number;
  readonly height: number;
}

/** An image by content hash (`media/<sha>` in R2), or null when it can't be had. */
export type ImageBytesLoader = (ref: string) => Promise<ImageFile | null>;

export interface HeadlessRenderDeps {
  /** Lays text out, as the editor does; its shaper (if any) outlines runs with features or axes. */
  readonly measurer: TextMeasurer;
  readonly fonts: FontBytesLoader;
  readonly images: ImageBytesLoader;
  readonly rasteriser: Rasteriser;
  /** Drawn in place of a family whose files can't be had; by default Instrument Sans, the default font. */
  readonly fallbackFamily?: string;
}

export interface PngOptions {
  /** Output pixels per unit; 1 by default. */
  readonly scale?: number;
  /** Painted behind the layer, as a CSS colour; transparent by default. */
  readonly background?: string | null;
}

/** Effects a headless picture shows only roughly, or not at all. */
export type RenderApproximation = "glass" | "noise" | "texture" | "background-blur";

export interface HeadlessPng {
  readonly png: Uint8Array;
  readonly width: number;
  readonly height: number;
  /** The page rect drawn: the layer and whatever its strokes, shadows and blur paint outside it. */
  readonly bounds: Rect;
  readonly scale: number;
  /** What differs from the canvas, if anything: see `RenderApproximation`. */
  readonly approximate: readonly RenderApproximation[];
  /** Faces drawn in the fallback family instead ("Fraunces 700 italic"). */
  readonly missingFonts: readonly string[];
  /** Images left out because their files couldn't be had, by hash. */
  readonly missingImages: readonly string[];
}

/** A Worker has 128 MB: a picture's pixels, and the layers its filters draw into, must fit well inside. */
export const MAX_HEADLESS_SIDE = 4096;
export const MAX_HEADLESS_PIXELS = 2048 * 2048;

const DEFAULT_FALLBACK = "Instrument Sans";

/** Every face the text in these layers (and their children) is set in, runs included. */
export function facesUsed(doc: Doc, ids: readonly string[]): Face[] {
  const faces = new Map<string, Face>();
  const add = (props: NodeRecord["props"]) => {
    const face = {
      family: getProp(props, "fontFamily"),
      weight: getProp(props, "fontWeight"),
      italic: getProp(props, "fontStyle") === "italic",
    };
    faces.set(`${face.family}\u0000${face.weight}\u0000${face.italic}`, face);
  };
  const visit = (id: string) => {
    const node = doc.get(id);
    if (!node || node.props.visible === false) return;
    if (node.type === "text") {
      add(node.props);
      for (const span of textSpans(node)) add(span.props);
    }
    for (const child of doc.childIds(id)) visit(child);
  };
  for (const id of ids) visit(id);
  return [...faces.values()];
}

/** The effects in these layers that SVG approximates. */
export function approximations(doc: Doc, ids: readonly string[]): RenderApproximation[] {
  const found = new Set<RenderApproximation>();
  const visit = (id: string) => {
    const node = doc.get(id);
    if (!node || node.props.visible === false) return;
    if (node.type !== "page")
      for (const e of getProp(node.props, "effects")) {
        if (e.visible === false) continue;
        if (e.type === "glass" || e.type === "noise" || e.type === "texture") found.add(e.type);
        else if (e.type === "background-blur") found.add("background-blur");
      }
    for (const child of doc.childIds(id)) visit(child);
  };
  for (const id of ids) visit(id);
  return [...found].sort();
}

/** Bytes as base64, without Node's Buffer (Workers have btoa). */
export function base64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

const faceName = (f: Face) => `${f.family} ${f.weight}${f.italic ? " italic" : ""}`;

/**
 * A renderer for the headless engine: `renderPng(doc, nodeId, options)`
 * draws a layer (or every layer on a page) as a PNG.
 */
export function createHeadlessRenderer(deps: HeadlessRenderDeps) {
  const fallback = deps.fallbackFamily ?? DEFAULT_FALLBACK;

  /** Font files for the faces, in the fallback family where a family has none. */
  const fontsFor = async (faces: readonly Face[]) => {
    const missing: Face[] = [];
    const files = await Promise.all(
      faces.map(async (face): Promise<Uint8Array | null> => {
        const bytes = await deps.fonts(face).catch(() => null);
        if (bytes) return new Uint8Array(bytes);
        missing.push(face);
        return null;
      }),
    );
    // Text in a family without files is drawn in the fallback, at its weight and style.
    const stand = await Promise.all(
      missing.map(async (f): Promise<Uint8Array | null> => {
        const bytes = await deps
          .fonts({ family: fallback, weight: f.weight, italic: f.italic })
          .catch(() => null);
        return bytes ? new Uint8Array(bytes) : null;
      }),
    );
    return {
      fonts: [...files, ...stand].filter((f): f is Uint8Array => f !== null),
      missing: missing.map(faceName),
    };
  };

  const imagesFor = async (doc: Doc, ids: readonly string[]) => {
    const loaded = new Map<string, SvgImageSource>();
    const missing: string[] = [];
    await Promise.all(
      imageRefs(doc, ids).map(async (ref) => {
        const file = await deps.images(ref).catch(() => null);
        if (!file) {
          missing.push(ref);
          return;
        }
        loaded.set(ref, {
          href: `data:${file.type};base64,${base64(file.bytes)}`,
          width: file.width,
          height: file.height,
        });
      }),
    );
    return { images: (ref: string) => loaded.get(ref) ?? null, missing: missing.sort() };
  };

  return {
    async renderPng(doc: Doc, nodeId: string, options: PngOptions = {}): Promise<HeadlessPng> {
      const node = doc.get(nodeId);
      if (!node) throw new ExportError("There's no layer with that id.");
      const ids = node.type === "page" ? doc.childIds(nodeId) : [nodeId];
      const scale = options.scale ?? 1;
      if (!(scale > 0) || !Number.isFinite(scale))
        throw new ExportError("Scale must be a positive number.");
      const scene = new Scene(doc);
      const found = exportBounds(scene, ids);
      if (!found) throw new ExportError("Nothing visible to render. Show the layer and try again.");
      const bounds = snapToPixels(found, scale);
      const width = Math.round(bounds.width * scale);
      const height = Math.round(bounds.height * scale);
      if (
        width > MAX_HEADLESS_SIDE ||
        height > MAX_HEADLESS_SIDE ||
        width * height > MAX_HEADLESS_PIXELS
      )
        throw new ExportError(
          `That render is too large (${width} × ${height}). Try a smaller scale or a smaller layer.`,
        );
      const [fonts, images] = await Promise.all([
        fontsFor(facesUsed(doc, ids)),
        imagesFor(doc, ids),
      ]);
      const svg = exportSvg(scene, deps.measurer, ids, bounds, {
        images: images.images,
        outlineFeatures: true,
        raster: scale,
      });
      const raster = await deps.rasteriser.rasterise(svg, {
        scale,
        fonts: fonts.fonts,
        fallbackFamily: fallback,
        background: options.background ?? null,
      });
      return {
        ...raster,
        bounds,
        scale,
        approximate: approximations(doc, ids),
        missingFonts: fonts.missing,
        missingImages: images.missing,
      };
    },
  };
}

export type HeadlessRenderer = ReturnType<typeof createHeadlessRenderer>;
