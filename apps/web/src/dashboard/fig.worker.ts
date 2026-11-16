/**
 * Reads a .fig file off the page's thread, so a large kit never freezes
 * the tab: decoding, filling in instances and converting all happen here
 * (`fig-import.ts` drives it). The REST-shaped file stays here between
 * reading and converting; only progress, the images to upload and the
 * converted nodes cross over.
 */
import { ImportError, readFig } from "@drawpane/fig";
import { convertFile, type Figma } from "@drawpane/figma";
import type { FigWorkerReply, FigWorkerRequest } from "./fig-import";

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<FigWorkerRequest>) => void) | null;
  postMessage(message: FigWorkerReply, transfer?: Transferable[]): void;
};
const post = (message: FigWorkerReply, transfer: Transferable[] = []) =>
  scope.postMessage(message, transfer);

let file: Figma.File | null = null;

scope.onmessage = async ({ data }) => {
  try {
    if (data.type === "read") {
      const fig = await readFig(new Uint8Array(data.bytes), {
        fileName: data.name,
        onProgress: (progress) => post({ type: "progress", progress }),
      });
      file = fig.file;
      // Each image as its own buffer, so it can move to the page without a copy of the file.
      const images = [...fig.images].map(([ref, image]) => ({
        ref,
        mime: image.mime,
        bytes: image.bytes.slice(),
      }));
      post(
        {
          type: "read",
          name: fig.file.name,
          pages: fig.pages,
          notes: fig.notes.lines(),
          images,
        },
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
    // this reader doesn't understand.
    if (!(error instanceof ImportError)) console.error(error);
    post({
      type: "error",
      message:
        error instanceof ImportError
          ? error.message
          : "This .fig file couldn't be read. Save a local copy from Figma again, or import it from its link.",
    });
  }
};
