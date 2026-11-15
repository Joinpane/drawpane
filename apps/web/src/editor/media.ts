/**
 * Getting images into a file: drop, paste or choose them, see them at once,
 * and upload them in the background.
 *
 * Each image is hashed and decoded in the browser first (both off the main
 * thread), so its layer appears immediately with the real picture; the
 * upload to R2 follows, with progress in the upload tray. Collaborators see a
 * placeholder until the upload lands, then the image.
 *
 * SVGs never upload as they are (decision 0020). Placed on the canvas, one
 * becomes a frame of layers you can edit (@drawpane/svg), parsed in a
 * detached document; chosen as an image fill, it's drawn to a PNG here and
 * that uploads like any image.
 */
import { type Editor, ImageCache, type PlacedTree, type Point } from "@drawpane/editor";
import { MEDIA_MAX_BYTES, mediaProblem, sniffImage } from "@drawpane/model";
import {
  type ConvertedSvg,
  looksLikeSvg,
  Notes,
  parseSvg,
  SVG_MAX_BYTES,
  SvgProblem,
  svgSize,
  svgToLayers,
} from "@drawpane/svg";

const caches = new WeakMap<Editor, ImageCache>();
const queues = new WeakMap<Editor, UploadQueue>();

/** The one decoded-image cache for a file, shared by the canvas, exports and thumbnails. */
export function imagesFor(editor: Editor): ImageCache {
  let cache = caches.get(editor);
  if (!cache) {
    cache = new ImageCache();
    caches.set(editor, cache);
  }
  return cache;
}

/** Lets `to` draw from `from`'s image cache, so a second view of the same file loads nothing twice. */
export function shareImages(from: Editor, to: Editor): void {
  caches.set(to, imagesFor(from));
}

export function uploadsFor(editor: Editor): UploadQueue {
  let queue = queues.get(editor);
  if (!queue) {
    queue = new UploadQueue();
    queues.set(editor, queue);
  }
  return queue;
}

export interface MediaInfo {
  readonly sha: string;
  readonly mime: string;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
}

export type UploadStatus = "waiting" | "uploading" | "done" | "error";

export interface UploadItem {
  readonly id: number;
  readonly name: string;
  readonly bytes: number;
  readonly loaded: number;
  readonly status: UploadStatus;
  readonly sha: string;
}

/** Uploads two at a time, with progress, for the upload tray. */
export class UploadQueue {
  #items: UploadItem[] = [];
  readonly #listeners = new Set<() => void>();
  readonly #waiting: Array<() => void> = [];
  #active = 0;
  #nextId = 0;

  get items(): readonly UploadItem[] {
    return this.#items;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /** True while an image with this hash is still on its way to storage. */
  pending(sha: string): boolean {
    return this.#items.some(
      (i) => i.sha === sha && (i.status === "waiting" || i.status === "uploading"),
    );
  }

  /** Forgets finished uploads (the tray calls this once it has shown them). */
  clearFinished(): void {
    const next = this.#items.filter((i) => i.status === "waiting" || i.status === "uploading");
    if (next.length !== this.#items.length) this.#set(next);
  }

  async add(fileId: string, name: string, blob: Blob, sha: string): Promise<MediaInfo> {
    const id = ++this.#nextId;
    this.#set([...this.#items, { id, name, bytes: blob.size, loaded: 0, status: "waiting", sha }]);
    if (this.#active >= 2) await new Promise<void>((resolve) => this.#waiting.push(resolve));
    this.#active++;
    this.#update(id, { status: "uploading" });
    try {
      const info = await this.#send(fileId, blob, (loaded) => this.#update(id, { loaded }));
      this.#update(id, { status: "done", loaded: blob.size });
      return info;
    } catch (error) {
      this.#update(id, { status: "error" });
      throw error;
    } finally {
      this.#active--;
      this.#waiting.shift()?.();
    }
  }

  /** XMLHttpRequest, because fetch can't report upload progress. */
  #send(fileId: string, blob: Blob, progress: (loaded: number) => void): Promise<MediaInfo> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `/api/files/${encodeURIComponent(fileId)}/media`);
      xhr.withCredentials = true;
      xhr.setRequestHeader("content-type", blob.type || "application/octet-stream");
      xhr.upload.onprogress = (e) => progress(e.loaded);
      xhr.onerror = () =>
        reject(
          new Error("Couldn't reach Drawpane. Check your connection, then add the image again."),
        );
      xhr.onload = () => {
        let body: unknown = null;
        try {
          body = JSON.parse(xhr.responseText);
        } catch {
          // Not JSON: fall through to a generic message.
        }
        if (xhr.status >= 200 && xhr.status < 300 && body && typeof body === "object")
          resolve(body as MediaInfo);
        else {
          const message =
            body && typeof body === "object" && "error" in body
              ? (body as { error: { message?: string } }).error.message
              : undefined;
          reject(new Error(message ?? "Couldn't upload the image. Try again."));
        }
      };
      xhr.send(blob);
    });
  }

  #update(id: number, patch: Partial<UploadItem>): void {
    this.#set(this.#items.map((i) => (i.id === id ? { ...i, ...patch } : i)));
  }

  #set(items: UploadItem[]): void {
    this.#items = items;
    for (const listener of [...this.#listeners]) listener();
  }
}

/** Every file in a drop or paste, images or not (so the rest can be explained). */
export function filesFrom(data: DataTransfer | null): File[] {
  if (!data) return [];
  if (data.files.length > 0) return [...data.files];
  const files: File[] = [];
  for (const item of data.items) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  return files;
}

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function layerName(fileName: string): string {
  // Clipboard images arrive as "image.png".
  if (/^image\.(png|jpe?g|gif|webp)$/i.test(fileName)) return "Pasted image";
  if (/^image\.svg$/i.test(fileName)) return "SVG";
  return fileName.replace(/\.[a-z0-9]{2,5}$/i, "").trim() || "Image";
}

/** What the browser says when a file is neither an image nor an SVG. */
const NOT_AN_IMAGE =
  "Drawpane takes SVG, PNG, JPEG, WebP and GIF images. Convert the file and try again.";

/** An SVG by its type or name (sniffed from its text later, for files without either). */
export function isSvgFile(file: File): boolean {
  return file.type === "image/svg+xml" || /\.svg$/i.test(file.name);
}

interface PreparedSvg {
  readonly file: File;
  readonly svg: ConvertedSvg;
}

/** An SVG file as layers, or why it can't be. */
async function prepareSvg(file: File, name = layerName(file.name)): Promise<PreparedSvg | string> {
  if (file.size > SVG_MAX_BYTES)
    return "SVGs can be up to 10 MB. Simplify it or export a smaller version.";
  return convertSvgText(await file.text(), name, file);
}

function convertSvgText(text: string, name: string, file: File): PreparedSvg | string {
  try {
    return { file, svg: svgToLayers(text, { name }) };
  } catch (error) {
    if (error instanceof SvgProblem) return error.message;
    return "The SVG couldn't be read. Export it again and try once more.";
  }
}

/** One sentence on what an SVG import approximated, or "" when it came across exactly. */
function notesSentence(notes: Notes): string {
  const lines = notes.lines();
  if (lines.length === 0) return "";
  return `Some parts are approximated: ${lines.join(", ")}.`;
}

const MAX_BITMAP_SIDE = 4096;

interface Prepared {
  readonly file: File;
  readonly sha: string;
  readonly width: number;
  readonly height: number;
}

/** Hashes and decodes one file, or returns why it can't be placed. */
async function prepare(file: File, cache: ImageCache): Promise<Prepared | string> {
  if (file.size > MEDIA_MAX_BYTES) return mediaProblem(file.size, null) ?? "";
  const bytes = new Uint8Array(await file.arrayBuffer());
  const sniffed = sniffImage(bytes);
  const problem = sniffed ? mediaProblem(bytes.byteLength, sniffed) : NOT_AN_IMAGE;
  if (problem) return problem;
  const sha = await sha256(bytes);
  let bitmap: ImageBitmap;
  try {
    // Decodes off the main thread and applies EXIF orientation, so the size is what people see.
    bitmap = await createImageBitmap(file);
  } catch {
    return "The image looks damaged. Export it again and try once more.";
  }
  const width = bitmap.width;
  const height = bitmap.height;
  const longest = Math.max(width, height);
  if (longest > MAX_BITMAP_SIDE) {
    const k = MAX_BITMAP_SIDE / longest;
    const smaller = await createImageBitmap(bitmap, {
      resizeWidth: Math.max(1, Math.round(width * k)),
      resizeHeight: Math.max(1, Math.round(height * k)),
      resizeQuality: "high",
    });
    bitmap.close();
    bitmap = smaller;
  }
  cache.put(sha, { bitmap, naturalWidth: width, naturalHeight: height });
  return { file, sha, width, height };
}

/** Prepares one dropped, pasted or chosen file: an SVG as layers, anything else as an image. */
async function prepareAny(file: File, cache: ImageCache): Promise<Prepared | PreparedSvg | string> {
  if (isSvgFile(file)) return prepareSvg(file);
  // No type or name to go by (some clipboards): an SVG's text gives it away.
  if (!file.type && file.size <= SVG_MAX_BYTES) {
    const head = await file.slice(0, 4096).text();
    if (looksLikeSvg(head)) return prepareSvg(file);
  }
  return prepare(file, cache);
}

/**
 * Places image and SVG files as layers at `at` (page coordinates; the
 * viewport centre by default), side by side in one undo step, and uploads
 * the images. An SVG becomes a frame of editable layers. Files that can't
 * be placed, and what an SVG approximated, get one notice.
 */
export async function importImageFiles(
  editor: Editor,
  fileId: string,
  files: readonly File[],
  at?: Point,
): Promise<string[]> {
  if (files.length === 0) return [];
  if (!editor.canEdit) {
    editor.notify("You can view this file but not change it. Ask an owner for edit access.");
    return [];
  }
  const cache = imagesFor(editor);
  const results = await Promise.all(files.map((file) => prepareAny(file, cache)));
  const problems = results.flatMap((r, i) =>
    typeof r === "string" ? [{ file: files[i], problem: r }] : [],
  );
  const placed = results.filter((r): r is Prepared | PreparedSvg => typeof r !== "string");
  const messages: string[] = [];
  const first = problems[0];
  if (first) {
    const what =
      problems.length === 1 ? `"${first.file?.name ?? "That file"}"` : `${problems.length} files`;
    messages.push(`Couldn't place ${what}. ${first.problem}`);
  }
  const notes = new Notes();
  for (const r of placed) if ("svg" in r) notes.merge(r.svg.notes);
  const approximated = notesSentence(notes);
  if (approximated) messages.push(approximated);
  if (messages.length > 0) editor.notify(messages.join(" "));
  if (placed.length === 0) return [];

  const items: PlacedTree[] = placed.map((r) =>
    "svg" in r
      ? { tree: r.svg.root }
      : {
          fit: true,
          tree: {
            type: "rect",
            props: {
              name: layerName(r.file.name).slice(0, 256),
              width: r.width,
              height: r.height,
              fills: [{ type: "image", ref: r.sha, scaleMode: "fill" }],
            },
          },
        },
  );
  const svgs = placed.filter((r) => "svg" in r).length;
  const label =
    svgs === placed.length
      ? svgs === 1
        ? "Place SVG"
        : "Place SVGs"
      : placed.length === 1
        ? "Place image"
        : "Place images";
  const ids = editor.insertLayers(items, at, label);
  const queue = uploadsFor(editor);
  placed.forEach((r, i) => {
    if ("svg" in r) return;
    queue.add(fileId, r.file.name, r.file, r.sha).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "Try again.";
      editor.notify(`Couldn't upload "${r.file.name}". ${message}`);
      // Nobody else could ever load it: take the layer back out.
      const id = ids[i];
      const node = id ? editor.doc.get(id) : undefined;
      const stillThere =
        node &&
        Array.isArray(node.props.fills) &&
        node.props.fills.some((p) => p.type === "image" && p.ref === r.sha);
      if (id && stillThere)
        editor.commit([{ op: "delete", id }], "Remove image that failed to upload");
    });
  });
  return ids;
}

/**
 * Pastes SVG markup (an icon set's "Copy SVG", Figma's "Copy as SVG") as a
 * frame of layers, at `at` or the viewport centre. False when the text isn't SVG.
 */
export function pasteSvgText(editor: Editor, text: string, at?: Point): boolean {
  if (!looksLikeSvg(text)) return false;
  if (!editor.canEdit) {
    editor.notify("You can view this file but not change it. Ask an owner for edit access.");
    return true;
  }
  const result = convertSvgText(text, "SVG", new File([], "SVG"));
  if (typeof result === "string") {
    editor.notify(`Couldn't paste the SVG. ${result}`);
    return true;
  }
  editor.insertLayers([{ tree: result.svg.root }], at, "Paste SVG");
  const approximated = notesSentence(result.svg.notes);
  if (approximated) editor.notify(approximated);
  return true;
}

/** Twice an SVG's own size for a fill, its longest side at most this. */
const RASTER_MAX_SIDE = 4096;

/**
 * Draws an SVG file to a PNG, for an image fill: at twice its own size
 * (its width and height, else its viewBox's), the longest side at most
 * 4096 px. Drawn through an `<img>`, where an SVG can't run scripts or load
 * anything. Returns the PNG, or why it couldn't.
 */
export async function rasterizeSvg(file: File): Promise<File | string> {
  if (file.size > SVG_MAX_BYTES)
    return "SVGs can be up to 10 MB. Simplify it or export a smaller version.";
  let root: Element;
  try {
    root = parseSvg(await file.text());
  } catch (error) {
    return error instanceof SvgProblem
      ? error.message
      : "The SVG couldn't be read. Export it again and try once more.";
  }
  const size = svgSize(root);
  const k = Math.min(2, RASTER_MAX_SIDE / Math.max(size.width, size.height));
  const width = Math.max(1, Math.round(size.width * k));
  const height = Math.max(1, Math.round(size.height * k));
  // Its size, stated: an SVG with only a viewBox has none of its own in an <img>.
  root.setAttribute("width", String(width));
  root.setAttribute("height", String(height));
  if (!root.getAttribute("viewBox"))
    root.setAttribute("viewBox", `0 0 ${size.width} ${size.height}`);
  const markup = new XMLSerializer().serializeToString(root);
  const url = URL.createObjectURL(new Blob([markup], { type: "image/svg+xml" }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return "Couldn't draw the SVG. Try again.";
    ctx.drawImage(img, 0, 0, width, height);
    const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!png) return "Couldn't draw the SVG. Try again.";
    return new File([png], `${file.name.replace(/\.svg$/i, "") || "image"}.png`, {
      type: "image/png",
    });
  } catch {
    return "The SVG couldn't be drawn. Export it again and try once more.";
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Uploads one image for a fill and resolves with its hash once stored, or
 * null (after a notice) when it can't be used.
 */
export async function uploadImageForFill(
  editor: Editor,
  fileId: string,
  chosen: File,
): Promise<string | null> {
  let file = chosen;
  if (isSvgFile(chosen)) {
    // A fill is a picture: the SVG is drawn to a PNG, which uploads like any image.
    const png = await rasterizeSvg(chosen);
    if (typeof png === "string") {
      editor.notify(`Couldn't use "${chosen.name}". ${png}`);
      return null;
    }
    file = png;
  }
  const prepared = await prepare(file, imagesFor(editor));
  if (typeof prepared === "string") {
    editor.notify(`Couldn't use "${file.name}". ${prepared}`);
    return null;
  }
  // The fill can switch right away: the bitmap is already in the cache.
  uploadsFor(editor)
    .add(fileId, file.name, file, prepared.sha)
    .catch((error: unknown) => {
      editor.notify(
        `Couldn't upload "${file.name}". ${error instanceof Error ? error.message : "Try again."}`,
      );
    });
  return prepared.sha;
}

/** What the file choosers offer: the images Drawpane takes, and SVG. */
const IMAGE_ACCEPT = "image/png,image/jpeg,image/webp,image/gif,image/svg+xml,.svg";

/** Asks for one or more image files; resolves with none if the person cancels. */
export function chooseImageFiles(): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.accept = IMAGE_ACCEPT;
    input.addEventListener("change", () => resolve([...(input.files ?? [])]), { once: true });
    input.addEventListener("cancel", () => resolve([]), { once: true });
    input.click();
  });
}

/** Opens the system file chooser for one image. */
export function chooseImageFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = IMAGE_ACCEPT;
    input.addEventListener("change", () => resolve(input.files?.[0] ?? null), { once: true });
    input.addEventListener("cancel", () => resolve(null), { once: true });
    input.click();
  });
}

/**
 * Pastes what the system clipboard holds (layers, then SVG markup, then
 * images), in place or centred on `at` ("Paste here"). Returns false when
 * there was nothing to paste.
 */
export async function pasteFromClipboard(
  editor: Editor,
  fileId: string,
  at?: { x: number; y: number },
): Promise<boolean> {
  const options = at ? { at } : {};
  try {
    const items = await navigator.clipboard.read();
    const images: File[] = [];
    let text: string | null = null;
    for (const item of items) {
      if (item.types.includes("image/svg+xml")) {
        text = await (await item.getType("image/svg+xml")).text();
        continue;
      }
      const type = item.types.find((t) => t.startsWith("image/"));
      if (type) {
        const blob = await item.getType(type);
        images.push(new File([blob], `image.${type.slice(6)}`, { type }));
      } else if (item.types.includes("text/plain")) {
        text = await (await item.getType("text/plain")).text();
      }
    }
    if (text && editor.paste(text, options)) return true;
    if (text && pasteSvgText(editor, text, at)) return true;
    if (images.length > 0) {
      await importImageFiles(editor, fileId, images, at);
      return true;
    }
    return false;
  } catch {
    // No permission, or a browser without clipboard.read: text only.
    const text = await navigator.clipboard.readText().catch(() => "");
    return editor.paste(text, options) || pasteSvgText(editor, text, at);
  }
}
