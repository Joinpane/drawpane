import {
  EngineFailure,
  ErrorCode,
  type Failure,
  imageLevelsBytes,
  type RenderEngine,
  refusingBits,
  smallerImageLevel,
  UNSUPPORTED,
  unsupportedNames,
  WORKER_LIMITS,
} from "@drawpane/engine";
import { getProp, type NodeRecord, type Paint, scriptSubsets } from "@drawpane/model";
import type { Doc } from "./doc";
import { DisplayListBuilder, type EngineImage } from "./engine/display-list";
import { rgba } from "./engine/layer";
import { ExportError, exportBounds, fitScale, snapToPixels } from "./export";
import type { Rect } from "./geometry";
import { isHarfBuzzOutOfMemory } from "./harfbuzz-faces";
import { imageDrawnSize, type Size } from "./images";
import { textSpans } from "./rich-text";
import { Scene } from "./scene";
import { drawnFamily, type TextMeasurer } from "./text";

/** An image file and its natural pixel dimensions recorded at upload. */
export interface ImageFile {
  readonly bytes: Uint8Array;
  readonly type: string;
  readonly width: number;
  readonly height: number;
}

/** Loads an image within the byte allowance, or reports why it could not be included. */
export type ImageBytesLoader = (
  ref: string,
  room: number,
) => Promise<ImageFile | "too-large" | null>;

export interface PngOptions {
  /** Output pixels per scene unit. Defaults to 1. */
  readonly scale?: number;
  /** With no scale specified, the target longest side at up to 2×. */
  readonly fit?: number;
  /** A colour painted behind the selection. Defaults to transparent. */
  readonly background?: string | null;
}

export type RenderApproximation = "glass" | "noise" | "texture" | "background-blur";

export interface HeadlessPng {
  readonly png: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly bounds: Rect;
  readonly scale: number;
  readonly approximate: readonly RenderApproximation[];
  readonly missingFonts: readonly string[];
  readonly fallbackText?: boolean;
  readonly missingImages: readonly string[];
  readonly skippedImages: readonly string[];
  readonly reducedImages?: readonly string[];
  /** Requested dimensions and scale when the export was reduced to fit. */
  readonly reduced?: { readonly width: number; readonly height: number; readonly scale: number };
}

/** Encode a buffered image for the MCP response without a Node-only Buffer. */
export function base64(bytes: Uint8Array): string {
  let data = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    data += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(data);
}

export const MIN_HEADLESS_SIDE = 256;

const MAX_SIDE = 8192;
const MAX_BUFFERED_PNG = 6 << 20;

export interface HeadlessPngStream extends Omit<HeadlessPng, "png"> {
  readonly png: ReadableStream<Uint8Array>;
}

export interface HeadlessEngineDeps {
  readonly measurer: TextMeasurer;
  readonly images: ImageBytesLoader;
  readonly decodeImage: (
    file: ImageFile,
    target: Size,
    room: number,
  ) => Promise<Uint8Array | "too-large" | null> | Uint8Array | "too-large" | null;
  readonly decodeMemoryBytes?: () => number;
  readonly timeoutMs?: number;
  readonly acquireEngine: () => Promise<{ engine: RenderEngine; release: () => void }>;
  readonly prepareFonts?: (nodes: Iterable<NodeRecord>) => Promise<void>;
  readonly waitForFaces?: (keys: readonly string[]) => Promise<unknown>;
}

/** A drawing or memory refusal callers can present as an export error. */
export class HeadlessRenderError extends ExportError {
  readonly code: ErrorCode;
  constructor(failure: Failure, message = failure.message) {
    super(message);
    this.code = failure.code;
  }
}

function backgroundColor(value: string | null | undefined) {
  if (!value || value === "transparent") return [0, 0, 0, 0] as const;
  if (value === "white") return [1, 1, 1, 1] as const;
  if (value === "black") return [0, 0, 0, 1] as const;
  const hex = /^#[\da-f]{3,4}$/i.test(value)
    ? `#${[...value.slice(1)].map((c) => c + c).join("")}`
    : value;
  if (!/^#(?:[\da-f]{6}|[\da-f]{8})$/i.test(hex))
    throw new ExportError("Use a hex colour for the export background.");
  return rgba(hex);
}

interface ImageUse {
  readonly paint: Extract<Paint, { type: "image" }>;
  readonly box: Size;
  readonly scale: Size;
}

function imageLevel(file: Size, uses: readonly ImageUse[]): Size {
  let width = 1;
  let height = 1;
  for (const { paint, box, scale } of uses) {
    const drawn = imageDrawnSize(paint.scaleMode, box, file, scale, paint.crop);
    width = Math.max(width, drawn.width);
    height = Math.max(height, drawn.height);
  }
  let level = { width: file.width, height: file.height };
  for (;;) {
    const next = smallerImageLevel(level.width, level.height);
    if (!next || next.width < width || next.height < height) return level;
    level = next;
  }
}

export function createHeadlessRenderer(deps: HeadlessEngineDeps) {
  async function renderPngStream(
    doc: Doc,
    nodeId: string,
    options: PngOptions = {},
  ): Promise<HeadlessPngStream> {
    const deadline = deps.timeoutMs === undefined ? undefined : Date.now() + deps.timeoutMs;
    const timeout = (): Failure => ({
      ok: false,
      code: ErrorCode.Timeout,
      message: "The export took too long. Export a smaller layer or use a lower scale.",
    });
    const checkDeadline = () => {
      if (deadline !== undefined && Date.now() >= deadline)
        throw new HeadlessRenderError(timeout());
    };
    const node = doc.get(nodeId);
    if (!node) throw new ExportError("There's no layer with that id.");
    const ids = node.type === "page" ? doc.childIds(nodeId) : [nodeId];
    const scene = new Scene(doc);
    const found = exportBounds(scene, ids);
    if (!found) throw new ExportError("Nothing visible to render. Show the layer and try again.");
    const background = backgroundColor(options.background);
    const scale =
      options.scale ??
      (options.fit === undefined
        ? 1
        : Math.max(
            0.01,
            Math.floor(fitScale(found, { width: options.fit, height: options.fit }) * 100) / 100,
          ));
    if (!(scale > 0) || !Number.isFinite(scale))
      throw new ExportError("Scale must be a positive number.");
    const at = (zoom: number) => {
      const bounds = snapToPixels(found, zoom);
      return {
        scale: zoom,
        bounds,
        width: Math.round(bounds.width * zoom),
        height: Math.round(bounds.height * zoom),
        camera: { zoom, x: -bounds.x * zoom, y: -bounds.y * zoom, dpr: 1 },
      };
    };
    const asked = at(scale);
    const longest = Math.max(asked.width, asked.height);
    if (!Number.isFinite(longest) || longest > MAX_SIDE)
      throw new ExportError(
        `That render is too large (${asked.width} × ${asked.height} px). The maximum is ${MAX_SIDE.toLocaleString("en")} px on either side. Try a smaller scale.`,
      );

    const version = doc.version;
    const images = new Map<string, EngineImage | null>();
    const builder = new DisplayListBuilder(scene, deps.measurer, {
      image: (ref) => images.get(ref),
    });
    const plan = builder.planLayers(ids, { context: true });
    const refs = new Map<string, ImageUse[]>();
    const text: NodeRecord[] = [];
    for (const layer of plan.visibleNodes()) {
      if (layer.type === "text") text.push(layer);
      else if (layer.type !== "group" && layer.type !== "page") {
        const box = {
          width: getProp(layer.props, "width"),
          height: getProp(layer.props, "height"),
        };
        if (box.width <= 0 || box.height <= 0) continue;
        const [a, b, c, d] = scene.worldMatrix(layer.id);
        for (const paint of [
          ...getProp(layer.props, "fills"),
          ...getProp(layer.props, "strokes"),
        ]) {
          if (paint.type !== "image" || paint.visible === false) continue;
          const use = {
            paint,
            box,
            scale: { width: Math.hypot(a, b) * scale, height: Math.hypot(c, d) * scale },
          };
          const existing = refs.get(paint.ref);
          if (existing) existing.push(use);
          else refs.set(paint.ref, [use]);
        }
      }
    }
    try {
      checkDeadline();
      await deps.prepareFonts?.(text);
      checkDeadline();
      if (deps.measurer.prepareScriptFallbacks) {
        const characters = text.map((layer) => getProp(layer.props, "characters"));
        await deps.measurer.prepareScriptFallbacks(
          scriptSubsets(characters, deps.measurer.scriptLocale),
        );
        checkDeadline();
      }
    } catch (error) {
      if (isHarfBuzzOutOfMemory(error))
        throw new ExportError(
          "That picture's fonts need more memory than rendering here has. Export a part set in fewer fonts or weights.",
        );
      throw error;
    }
    const missingFonts = new Set<string>();
    for (const layer of text) {
      for (const { props } of textSpans(layer)) {
        const family = drawnFamily(props, deps.measurer);
        const size = getProp(props, "fontSize");
        const weight = getProp(props, "fontWeight");
        const italic = getProp(props, "fontStyle") === "italic";
        if (deps.measurer.missing?.(family, size, weight, italic))
          missingFonts.add(`${family} ${weight}${italic ? " italic" : ""}`);
      }
    }
    const { engine, release } = await deps.acquireEngine();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const end = () => {
      clearTimeout(timer);
      engine.dispose();
      release();
    };
    try {
      checkDeadline();
      let handle = 0;
      let room = WORKER_LIMITS.imageBytes;
      const reduced = new Set<string>();
      const renderBudget = () => WORKER_LIMITS.memoryBytes - (deps.decodeMemoryBytes?.() ?? 0);
      for (const [ref, uses] of refs) {
        const decodeRoom = Math.max(
          0,
          Math.min(16 << 20, WORKER_LIMITS.memoryBytes - engine.memoryBytes),
        );
        const file = await deps.images(ref, decodeRoom).catch(() => null);
        checkDeadline();
        if (!file) continue;
        if (file === "too-large") {
          images.set(ref, null);
          continue;
        }
        const wanted = imageLevel(file, uses);
        let level: Size | null = wanted;
        while (level) {
          const { width, height } = level;
          const bytes = imageLevelsBytes(width, height);
          const uploadFits = () =>
            !deps.decodeMemoryBytes ||
            engine.memoryBytes + width * height * 4 + 2 * bytes <= renderBudget();
          if (bytes <= room && uploadFits()) {
            const decoded = await deps.decodeImage(file, level, decodeRoom);
            // Yield after synchronous Wasm decoding so workerd updates its clock.
            if (deadline !== undefined) await new Promise((resolve) => setTimeout(resolve, 0));
            checkDeadline();
            if (!decoded) break;
            if (decoded !== "too-large" && uploadFits()) {
              const id = ++handle;
              const result = engine.putImage(id, width, height, decoded);
              if (result.ok) {
                room -= bytes;
                images.set(ref, { handle: id, width: file.width, height: file.height });
                if (level !== wanted) reduced.add(ref);
                break;
              }
              if (result.code === ErrorCode.Image) break;
              if (result.code !== ErrorCode.Limit) throw new HeadlessRenderError(result);
            }
          }
          level = smallerImageLevel(width, height);
        }
        if (!level) images.set(ref, null);
      }
      if (version !== doc.version)
        throw new ExportError("The document changed while preparing the export. Try again.");
      if (deps.decodeMemoryBytes) {
        const budget = engine.setMemoryBudget(renderBudget());
        if (!budget.ok) throw new HeadlessRenderError(budget);
      }
      let list = plan.build();
      if (deps.waitForFaces && builder.waiting > 0) {
        const waited = new Set<string>();
        while (builder.waiting > 0) {
          const faces = [...builder.waitingFaces()].filter((key) => !waited.has(key));
          if (faces.length === 0) break;
          for (const key of faces) waited.add(key);
          await deps.waitForFaces(faces);
          checkDeadline();
          if (version !== doc.version)
            throw new ExportError("The document changed while preparing the export. Try again.");
          list = plan.build();
        }
      }
      const applied = engine.apply(list);
      if (!applied.ok) {
        const message = applied.message.includes("glyph outlines")
          ? "This export has too many different glyph outlines. Export a smaller part of the text."
          : applied.message;
        throw new HeadlessRenderError(applied, message);
      }
      const missingImages: string[] = [];
      const skippedImages: string[] = [];
      for (const ref of builder.imagesInUse()) {
        if (images.get(ref) === null) skippedImages.push(ref);
        else if (!images.has(ref)) missingImages.push(ref);
      }

      const check = (size: ReturnType<typeof at>) =>
        engine.checkPng(size.width, size.height, size.camera);
      const refused = check(asked);
      let size = asked;
      if (!refused.ok) {
        if (refused.code === ErrorCode.Unsupported) {
          const unsupported = engine.unsupported();
          const names = unsupported.ok
            ? [
                ...new Set(
                  unsupported.value.flatMap(([, bits]) => unsupportedNames(refusingBits(bits))),
                ),
              ]
            : [];
          const features = names.map((name) => name.replace(/([A-Z])/g, " $1").toLowerCase());
          throw new HeadlessRenderError(
            refused,
            `This export needs ${features.join(", ") || "an unsupported feature"}.`,
          );
        }
        if (refused.code !== ErrorCode.Limit || longest <= MIN_HEADLESS_SIDE)
          throw new HeadlessRenderError(refused);
        size = at((scale * MIN_HEADLESS_SIDE) / longest);
        const floor = check(size);
        if (!floor.ok)
          throw new HeadlessRenderError(
            floor,
            `${floor.message}. Export a smaller layer or use a lower scale.`,
          );
        let high = scale;
        // A subpixel change on the longest side is below the precision of the output dimensions.
        for (let step = 0; step < 14 && ((high - size.scale) * longest) / scale > 0.5; step++) {
          const middle = at((size.scale + high) / 2);
          const result = check(middle);
          if (result.ok) size = middle;
          else if (result.code === ErrorCode.Limit) high = middle.scale;
          else throw new HeadlessRenderError(result);
        }
      }
      checkDeadline();
      const abort = deadline === undefined ? undefined : new AbortController();
      if (deadline !== undefined && abort)
        timer = setTimeout(() => abort.abort(new EngineFailure(timeout())), deadline - Date.now());
      const stream = engine.renderPngStream(
        size.width,
        size.height,
        size.camera,
        background,
        undefined,
        end,
        deadline === undefined
          ? undefined
          : async () => {
              // Workers update their clock across I/O. Yield once per band so a long export
              // can release its lease and answer with a typed failure before the platform cuts it off.
              await new Promise((resolve) => setTimeout(resolve, 0));
              if (Date.now() >= deadline) throw new EngineFailure(timeout());
            },
        abort?.signal,
      );
      if (!stream.ok) throw new HeadlessRenderError(stream);
      return {
        png: stream.value,
        bounds: size.bounds,
        scale: size.scale,
        width: size.width,
        height: size.height,
        ...(size === asked ? {} : { reduced: { width: asked.width, height: asked.height, scale } }),
        approximate: [],
        missingFonts: [...missingFonts].sort(),
        ...([...builder.unsupported.values()].some((bits) => bits & UNSUPPORTED.textWithoutOutlines)
          ? { fallbackText: true }
          : {}),
        missingImages: missingImages.sort(),
        skippedImages: skippedImages.sort(),
        ...(reduced.size > 0 ? { reducedImages: [...reduced].sort() } : {}),
      };
    } catch (error) {
      end();
      throw error;
    }
  }

  return {
    renderPngStream,
    // Agent tool messages require one PNG. HTTP callers can return the stream directly.
    async renderPng(doc: Doc, nodeId: string, options?: PngOptions): Promise<HeadlessPng> {
      const { png, ...metadata } = await renderPngStream(doc, nodeId, options);
      const reader = png.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          bytes += next.value.length;
          if (bytes > MAX_BUFFERED_PNG)
            throw new HeadlessRenderError({
              ok: false,
              code: ErrorCode.Limit,
              message: "The PNG is too large to return as one image. Use a smaller scale.",
            });
          chunks.push(next.value);
        }
      } catch (error) {
        await reader.cancel().catch(() => {});
        if (error instanceof EngineFailure)
          throw new HeadlessRenderError({ ok: false, code: error.code, message: error.message });
        throw error;
      } finally {
        reader.releaseLock();
      }
      const combined = new Uint8Array(bytes);
      let offset = 0;
      for (const chunk of chunks) {
        combined.set(chunk, offset);
        offset += chunk.length;
      }
      return { ...metadata, png: combined };
    },
  };
}

export type HeadlessRenderer = ReturnType<typeof createHeadlessRenderer>;
