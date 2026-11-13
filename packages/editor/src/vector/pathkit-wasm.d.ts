// pathkit-wasm ships no types. Its default export is the Emscripten module
// factory; the adapter in pathkit.ts narrows the module it resolves to.
declare module "pathkit-wasm" {
  const init: (options?: {
    locateFile?: (file: string) => string;
    wasmBinary?: ArrayBuffer | Uint8Array;
  }) => Promise<unknown>;
  export default init;
}
