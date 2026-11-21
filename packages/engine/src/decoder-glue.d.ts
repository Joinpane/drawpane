export function initSync(module: { module: WebAssembly.Module }): unknown;
export function decodeImage(
  width: number,
  height: number,
  outputWidth: number,
  outputHeight: number,
  bytes: Uint8Array,
  budget: number,
): Uint8Array<ArrayBuffer> | undefined;
export function memoryBytes(): number;
export function __drawpaneCreateGlue(): typeof import("./decoder-glue");
export function __drawpaneQuiesce(): void;
