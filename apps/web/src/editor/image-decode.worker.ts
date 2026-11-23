/**
 * Decodes image levels off the main thread (see `imageDecoder` in engine-image.ts). Chrome
 * finishes `createImageBitmap(blob, { resizeWidth, … })`, the resize and the premultiply, on the
 * calling thread when the decode returns: tens of ms for a large photo, which on the main thread
 * is a dropped frame in the middle of a zoom. Here it costs this worker's thread, and the bitmap
 * moves to the main thread without a copy.
 */

export interface DecodeRequest {
  readonly id: number;
  readonly blob: Blob;
  readonly options: ImageBitmapOptions;
}

export type DecodeReply =
  | { readonly id: number; readonly bitmap: ImageBitmap }
  | { readonly id: number; readonly error: string };

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<DecodeRequest>) => void) | null;
  postMessage(message: DecodeReply, transfer?: Transferable[]): void;
};

scope.onmessage = ({ data: { id, blob, options } }) => {
  createImageBitmap(blob, options).then(
    (bitmap) => scope.postMessage({ id, bitmap }, [bitmap]),
    (error: unknown) => scope.postMessage({ id, error: String(error) }),
  );
};
