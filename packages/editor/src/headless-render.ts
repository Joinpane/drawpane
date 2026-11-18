/**
 * PNGs of layers without a canvas, for the headless agent engine (decisions
 * 0021 and 0023). The browser draws exports with the canvas renderer; a
 * Worker has no canvas, so here a layer is written out by the SVG export,
 * the same markup people download, and rasterised in WebAssembly.
 *
 * What the SVG can't hold travels with it: the font files its text is set
 * in (the caller's loader: the font proxy's upstream, R2 for team fonts) and
 * its images, as files the rasteriser takes beside the SVG (named by a URL
 * that's never fetched). A tiled fill's image is the exception: resvg reads
 * files it's handed only for images outside patterns, so a tile's pattern
 * carries its image as a data: URL. Runs with OpenType features or
 * variable axes are written as glyph outlines from the measurer's shaper,
 * so they don't depend on the rasteriser's support for either.
 *
 * Images are bounded (decision 0021): only those the render draws are
 * loaded, one at a time, each charged before its file is read
 * (`imageCost`: the file, and its pixels decoded at their natural size, as
 * resvg decodes them). An image that would take the render past
 * HEADLESS_IMAGE_BYTES isn't drawn: its fills are a marked placeholder
 * (grey, crossed) and it's listed in `skippedImages`, so the rest can still
 * be checked.
 *
 * A picture is drawn in the rasteriser's memory, which is capped (decision
 * 0033): when the rasteriser says how much it has (`Rasteriser.memory`),
 * what the render will hold is estimated first (`render-memory.ts`: its
 * font files, its images, and its pixels times how deeply its groups and
 * effects nest), and a picture that wouldn't fit is drawn at the largest
 * scale that does, down to MIN_HEADLESS_SIDE on its longest side, and says
 * so (`reduced`). One that runs out all the same is drawn once more at half
 * that scale, in a fresh instance, before the render fails.
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
import { ExportError, exportBounds, fitScale, imageRefs, snapToPixels } from "./export";
import type { Rect } from "./geometry";
import { bytesPerPixel, RASTER_BASE_BYTES } from "./render-memory";
import { textSpans } from "./rich-text";
import { Scene } from "./scene";
import { exportSvg, IMAGE_PLACEHOLDER, type SvgImageSource } from "./svg";
import type { TextMeasurer } from "./text";

/** An image's file, with its natural size in pixels. */
export interface ImageFile {
  readonly bytes: Uint8Array;
  /** Its media type: `image/png`, `image/jpeg`, `image/webp`, `image/gif`. */
  readonly type: string;
  readonly width: number;
  readonly height: number;
}

/**
 * An image by content hash (`media/<sha>` in R2), or null when it can't be
 * had. `room` is the most `imageCost` it may have: a loader that knows an
 * image's size before reading it (the Worker's, from the media table)
 * answers "too-large" without reading it. The renderer checks what it's
 * given against `room` too.
 */
export type ImageBytesLoader = (
  ref: string,
  room: number,
) => Promise<ImageFile | "too-large" | null>;

/**
 * The most a render may hold for its images at once (`imageCost`): beside
 * what the headless editor holds (decision 0026), its output's pixels, and
 * the room's own baseline, inside a Durable Object's 128 MB. Images are
 * drawn in the rasteriser's memory, so where it says how much it has
 * (`Rasteriser.memory`) they get less: what's left of it after the font
 * files and the smallest picture. In resvg's 25 MiB with no fonts, a
 * 2,000 × 2,000 image fits; a 12-megapixel photo (48 MB decoded) doesn't.
 */
export const HEADLESS_IMAGE_BYTES = 32 << 20;

/**
 * What drawing an image holds: its file twice (read, and copied into the
 * rasteriser) and its pixels, which resvg decodes at their natural size
 * (nothing here can decode an image smaller).
 */
export function imageCost(bytes: number, width: number, height: number): number {
  return 2 * bytes + 4 * width * height;
}

/**
 * What a tiled image holds besides `imageCost`: its data: URL (a third
 * more than the file), in the SVG string too, copied into resvg, and decoded
 * back to the file there.
 */
const tiledExtra = (bytes: number) => 5 * bytes;

/** Where the SVG says an image is: a URL never fetched, which the rasteriser is handed the file for. */
const imageHref = (ref: string) => `https://media.invalid/${ref}`;

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
  /** Output pixels per unit; 1 by default, or what `fit` asks for. */
  readonly scale?: number;
  /**
   * Without a `scale`: the longest side in pixels to aim for, drawing at up
   * to 2× (what a model looks at best: big enough to read, small enough to
   * send).
   */
  readonly fit?: number;
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
  /**
   * Images drawn as a marked placeholder (grey, crossed) because drawing
   * them would hold more than a render may (HEADLESS_IMAGE_BYTES), by hash.
   */
  readonly skippedImages: readonly string[];
  /**
   * The size asked for, when the picture was drawn smaller than that to fit
   * in the rasteriser's memory: `width`, `height` and `scale` are what it
   * was drawn at.
   */
  readonly reduced?: { readonly width: number; readonly height: number; readonly scale: number };
}

/** A Worker has 128 MB: a picture's pixels, and the layers its filters draw into, must fit well inside. */
export const MAX_HEADLESS_SIDE = 4096;
export const MAX_HEADLESS_PIXELS = 2048 * 2048;

/** A picture the rasteriser ran out of memory drawing, even at the smallest it draws one to fit. */
export const PICTURE_OUT_OF_MEMORY =
  "That picture needs more memory than rendering here has. Export a smaller layer or a lower scale.";

/** A picture whose font files alone leave the rasteriser too little memory to draw it at all. */
export const FONTS_OUT_OF_MEMORY =
  "That picture's fonts need more memory than rendering here has. Export a part of it set in fewer fonts or font weights.";

/**
 * The shortest a picture drawn smaller to fit may be on its longest side:
 * still enough to see a layout by. One asked for smaller than this isn't
 * made any smaller.
 */
export const MIN_HEADLESS_SIDE = 256;

/** A scale rounded down to three significant figures, so it reads back cleanly. */
function roundScale(scale: number): number {
  const p = 10 ** (2 - Math.floor(Math.log10(scale)));
  return Math.floor(scale * p) / p;
}

const isRasterOutOfMemory = (error: unknown) =>
  error instanceof Error && error.name === "RasterOutOfMemory";

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
    // Each file once (faces can share one), since the rasteriser copies in every file it's handed.
    const unique = new Map<ArrayBufferLike, Uint8Array>();
    for (const f of [...files, ...stand]) if (f && !unique.has(f.buffer)) unique.set(f.buffer, f);
    return { fonts: [...unique.values()], missing: missing.map(faceName) };
  };

  /**
   * The images the render draws (`drawn`: the refs of the image fills the
   * SVG draws; `tiled`: those a tiled fill repeats), loaded one at a time,
   * each charged before it's read (`imageCost`, and a tiled one's data:
   * URL). One past what's left of `budget` (HEADLESS_IMAGE_BYTES at most)
   * is skipped, drawn as a placeholder, and the rest are still loaded.
   */
  const imagesFor = async (
    drawn: readonly string[],
    tiled: ReadonlySet<string>,
    budget: number,
  ) => {
    const sources = new Map<string, SvgImageSource>();
    const files = new Map<string, Uint8Array>();
    const missing: string[] = [];
    const skipped: string[] = [];
    let held = 0;
    for (const ref of drawn) {
      const room = Math.max(0, budget - held);
      const file = await deps.images(ref, room).catch(() => null);
      if (!file) {
        missing.push(ref);
        continue;
      }
      if (file === "too-large") {
        skipped.push(ref);
        continue;
      }
      const cost =
        imageCost(file.bytes.length, file.width, file.height) +
        (tiled.has(ref) ? tiledExtra(file.bytes.length) : 0);
      if (cost > room) {
        skipped.push(ref);
        continue;
      }
      held += cost;
      const href = imageHref(ref);
      sources.set(ref, {
        href,
        width: file.width,
        height: file.height,
        ...(tiled.has(ref)
          ? { patternHref: `data:${file.type};base64,${base64(file.bytes)}` }
          : {}),
      });
      files.set(href, file.bytes);
    }
    return { sources, files, held, missing: missing.sort(), skipped: skipped.sort() };
  };

  return {
    async renderPng(doc: Doc, nodeId: string, options: PngOptions = {}): Promise<HeadlessPng> {
      const node = doc.get(nodeId);
      if (!node) throw new ExportError("There's no layer with that id.");
      const ids = node.type === "page" ? doc.childIds(nodeId) : [nodeId];
      const scene = new Scene(doc);
      const found = exportBounds(scene, ids);
      if (!found) throw new ExportError("Nothing visible to render. Show the layer and try again.");
      const scale =
        options.scale ??
        (options.fit === undefined
          ? 1
          : // Two decimals, so the scale reads back cleanly.
            Math.max(
              0.01,
              Math.floor(fitScale(found, { width: options.fit, height: options.fit }) * 100) / 100,
            ));
      if (!(scale > 0) || !Number.isFinite(scale))
        throw new ExportError("Scale must be a positive number.");
      /** The page rect drawn at a scale, snapped to its pixels, and its size in them. */
      const at = (s: number) => {
        const rect = snapToPixels(found, s);
        return { rect, width: Math.round(rect.width * s), height: Math.round(rect.height * s) };
      };
      const asked = at(scale);
      const { width, height } = asked;
      if (
        width > MAX_HEADLESS_SIDE ||
        height > MAX_HEADLESS_SIDE ||
        width * height > MAX_HEADLESS_PIXELS
      )
        throw new ExportError(
          `That render is too large (${width} × ${height}). Try a smaller scale or a smaller layer.`,
        );
      const svgOptions = (s: number) => ({ outlineFeatures: true, raster: s });
      // The images the SVG draws (visible fills of visible layers, inside what's drawn), found by
      // writing it once without them: only when the layers have an image fill at all.
      const drawn = new Set<string>();
      const tiled = new Set<string>();
      if (imageRefs(doc, ids).length > 0)
        exportSvg(scene, deps.measurer, ids, asked.rect, {
          ...svgOptions(scale),
          images: (ref, tile) => {
            drawn.add(ref);
            if (tile) tiled.add(ref);
            return null;
          },
        });

      // What the render will hold in the rasteriser (render-memory.ts), when it says how much it
      // has: its font files and images, whatever the scale, and its pixels times `perPixel`.
      const memory = deps.rasteriser.memory;
      const perPixel = bytesPerPixel(scene, ids, asked.rect);
      const pixels = (s: number) => {
        const size = at(s);
        return size.width * size.height;
      };
      const longest = Math.max(width, height);
      const smallest =
        longest > MIN_HEADLESS_SIDE ? roundScale((scale * MIN_HEADLESS_SIDE) / longest) : scale;
      const fonts = await fontsFor(facesUsed(doc, ids));
      let fixed = RASTER_BASE_BYTES + fonts.fonts.reduce((n, f) => n + f.length, 0);
      const least = perPixel * pixels(smallest);
      if (memory !== undefined && fixed + least > memory)
        throw new ExportError(
          RASTER_BASE_BYTES + least <= memory ? FONTS_OUT_OF_MEMORY : PICTURE_OUT_OF_MEMORY,
        );
      // Images take what's left once the smallest picture is drawn: a photo seen smaller beats a
      // placeholder.
      const images = await imagesFor(
        [...drawn].sort(),
        tiled,
        memory === undefined
          ? HEADLESS_IMAGE_BYTES
          : Math.min(HEADLESS_IMAGE_BYTES, memory - fixed - least),
      );
      fixed += images.held;

      /** The largest scale, up to the one asked for, whose render fits in `memory`. */
      const fitting = (room: number): number => {
        const fits = (s: number) => fixed + perPixel * pixels(s) <= room;
        if (fits(scale)) return scale;
        let s = roundScale(scale * Math.sqrt((room - fixed) / (perPixel * width * height)));
        while (s > smallest && !fits(s)) s = roundScale(s * 0.98);
        return Math.max(s, smallest);
      };

      const skipped = new Set(images.skipped);
      const draw = (s: number) =>
        deps.rasteriser.rasterise(
          exportSvg(scene, deps.measurer, ids, at(s).rect, {
            ...svgOptions(s),
            images: (ref) =>
              images.sources.get(ref) ?? (skipped.has(ref) ? IMAGE_PLACEHOLDER : null),
          }),
          {
            scale: s,
            fonts: fonts.fonts,
            fallbackFamily: fallback,
            background: options.background ?? null,
            images: images.files,
          },
        );
      let drawnAt = memory === undefined ? scale : fitting(memory);
      let raster: Awaited<ReturnType<Rasteriser["rasterise"]>>;
      try {
        raster = await draw(drawnAt);
      } catch (error) {
        if (!isRasterOutOfMemory(error)) throw error;
        // Past the estimate all the same: once more at half the scale, in a fresh instance.
        drawnAt = roundScale(drawnAt / 2);
        try {
          raster = await draw(drawnAt);
        } catch (again) {
          // resvg ran out of its capped memory (decision 0033) at half the scale too.
          if (isRasterOutOfMemory(again)) throw new ExportError(PICTURE_OUT_OF_MEMORY);
          throw again;
        }
      }
      return {
        ...raster,
        bounds: at(drawnAt).rect,
        scale: drawnAt,
        ...(drawnAt !== scale ? { reduced: { width, height, scale } } : {}),
        approximate: approximations(doc, ids),
        missingFonts: fonts.missing,
        missingImages: images.missing,
        skippedImages: images.skipped,
      };
    },
  };
}

export type HeadlessRenderer = ReturnType<typeof createHeadlessRenderer>;
