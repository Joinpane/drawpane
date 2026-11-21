// WebAssembly imports: Wrangler hands each `.wasm` file over as a compiled module.
declare module "*.wasm" {
  const module: WebAssembly.Module;
  export default module;
}

// Bundled font files import as byte buffers in the agent runner.
declare module "*.ttf" {
  const bytes: ArrayBuffer;
  export default bytes;
}
