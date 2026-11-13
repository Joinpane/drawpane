/**
 * Getting images into a file: drop, paste or choose them, see them at once,
 * and upload them in the background.
 *
 * Each image is hashed and decoded in the browser first (both off the main
 * thread), so its layer appears immediately with the real picture; the
 * upload to R2 follows, with progress in the upload tray. Collaborators see a
 * placeholder until the upload lands, then the image.
 */
import { type Editor, ImageCache, type Point } from "@drawpane/editor";
import { MEDIA_MAX_BYTES, mediaProblem, sniffImage } from "@drawpane/model";

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
  return fileName.replace(/\.[a-z0-9]{2,5}$/i, "").trim() || "Image";
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
  const problem = mediaProblem(bytes.byteLength, sniffImage(bytes));
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

/**
 * Places image files as layers at `at` (page coordinates; the viewport
 * centre by default) and uploads them. Files that aren't usable images get
 * one notice that says why.
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
  const results = await Promise.all(files.map((file) => prepare(file, cache)));
  const ready = results.filter((r): r is Prepared => typeof r !== "string");
  const problems = results.flatMap((r, i) =>
    typeof r === "string" ? [{ file: files[i], problem: r }] : [],
  );
  const first = problems[0];
  if (first) {
    const what =
      problems.length === 1 ? `"${first.file?.name ?? "That file"}"` : `${problems.length} files`;
    editor.notify(`Couldn't place ${what}. ${first.problem}`);
  }
  if (ready.length === 0) return [];
  const ids = editor.insertImages(
    ready.map((r) => ({
      ref: r.sha,
      width: r.width,
      height: r.height,
      name: layerName(r.file.name),
    })),
    at,
  );
  const queue = uploadsFor(editor);
  ready.forEach((r, i) => {
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
 * Uploads one image for a fill and resolves with its hash once stored, or
 * null (after a notice) when it can't be used.
 */
export async function uploadImageForFill(
  editor: Editor,
  fileId: string,
  file: File,
): Promise<string | null> {
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

/** Opens the system file chooser for one image. */
export function chooseImageFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/png,image/jpeg,image/webp,image/gif";
    input.addEventListener("change", () => resolve(input.files?.[0] ?? null), { once: true });
    input.addEventListener("cancel", () => resolve(null), { once: true });
    input.click();
  });
}

/**
 * Pastes from the async clipboard (menu and command bar): images when it
 * holds some, else Drawpane layers. Returns false when there was nothing to paste.
 */
/**
 * Pastes what the system clipboard holds (layers, then images), in place or
 * centred on `at` ("Paste here").
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
      const type = item.types.find((t) => t.startsWith("image/"));
      if (type) {
        const blob = await item.getType(type);
        images.push(new File([blob], `image.${type.slice(6)}`, { type }));
      } else if (item.types.includes("text/plain")) {
        text = await (await item.getType("text/plain")).text();
      }
    }
    if (text && editor.paste(text, options)) return true;
    if (images.length > 0) {
      await importImageFiles(editor, fileId, images, at);
      return true;
    }
    return false;
  } catch {
    // No permission, or a browser without clipboard.read: text only.
    return editor.paste(await navigator.clipboard.readText().catch(() => ""), options);
  }
}
