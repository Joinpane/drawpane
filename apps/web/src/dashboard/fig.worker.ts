/**
 * Reads a .fig file off the page's thread, so a large kit never freezes
 * the tab: decoding, filling in instances and converting all happen here
 * (`fig-import.ts` drives it). The decoded file stays here while the
 * dialog is open, so its pages can be chosen and imported, and imported
 * again (other pages), without reading the file twice. Between building
 * and converting, the REST-shaped file stays here too; only the page list,
 * progress, the images to upload and the converted nodes cross over.
 */
import { ImportError, type OpenedFig, openFig, type ReadProgress } from "@drawpane/fig";
import { convertFile, type Figma } from "@drawpane/figma";
import type { FigWorkerReply, FigWorkerRequest } from "./fig-import";

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<FigWorkerRequest>) => void) | null;
  postMessage(message: FigWorkerReply, transfer?: Transferable[]): void;
};
const post = (message: FigWorkerReply, transfer: Transferable[] = []) =>
  scope.postMessage(message, transfer);

let opened: OpenedFig | null = null;
let file: Figma.File | null = null;

scope.onmessage = async ({ data }) => {
  const onProgress = (progress: ReadProgress) => post({ type: "progress", progress });
  try {
    if (data.type === "open") {
      opened = await openFig(new Uint8Array(data.bytes), { fileName: data.name, onProgress });
      post({ type: "opened", name: opened.name, pages: opened.pages, layers: opened.layers });
    } else if (data.type === "read") {
      if (!opened) throw new Error("Nothing to read: open the file first.");
      const fig = await opened.read({
        ...(data.pageIds ? { pageIds: data.pageIds } : {}),
        onProgress,
      });
      file = fig.file;
      // Each image as its own buffer, so it can move to the page without a copy of the file.
      const images = [...fig.images].map(([ref, image]) => ({
        ref,
        mime: image.mime,
        bytes: image.bytes.slice(),
      }));
      post(
        { type: "read", pages: fig.pages, notes: fig.notes.lines(), images },
        images.map((i) => i.bytes.buffer),
      );
    } else if (data.type === "convert") {
      if (!file) throw new Error("Nothing to convert: read the file first.");
      const uploaded = new Map(data.images);
      const converted = convertFile(file, { images: (ref) => uploaded.get(ref) ?? null });
      file = null;
      post({ type: "converted", nodes: converted.nodes, notes: converted.notes.lines() });
    }
  } catch (error) {
    // Reading errors are written for the person importing; anything else is a bug or a file
    // this reader doesn't understand. What the reader threw goes to the console either way.
    if (!(error instanceof ImportError)) console.error(error);
    else if (error.cause !== undefined) console.error(error.cause);
    post({
      type: "error",
      message:
        error instanceof ImportError
          ? error.message
          : "This .fig file couldn't be read. Save a local copy from Figma again, or import it from its link.",
      code: error instanceof ImportError ? error.code : null,
    });
  }
};
