export function initSync(module: { module: WebAssembly.Module }): unknown;
export function makePreview(
  width: number,
  height: number,
  maxSide: number,
  quality: number,
  bytes: Uint8Array,
  budget: number,
): Uint8Array<ArrayBuffer> | undefined;
export function memoryBytes(): number;
export function __drawpaneCreateGlue(): typeof import("./preview-glue");
export function __drawpaneQuiesce(): void;
