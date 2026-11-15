// WebAssembly imports: Wrangler hands each `.wasm` file over as a compiled module.
declare module "*.wasm" {
  const module: WebAssembly.Module;
  export default module;
}
